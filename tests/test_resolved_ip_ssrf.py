"""SSRF: resolved-IP gate for allowlisted hosts (issue #510).

Covers the remaining gap in the SSRF hardening arc: the hostname allowlist
is no longer trusted on its own; the hostname must resolve only to
publicly routable IPs. Link-local (cloud IMDS), loopback, and RFC-1918
private ranges are refused.

We stub ``socket.getaddrinfo`` (and the urllib opener) so no real
network traffic is issued.
"""

from __future__ import annotations

import socket
import urllib.error
import urllib.request
from unittest.mock import MagicMock, patch

import pytest

from pr_reviewer.enrichment import host_allowed
from pr_reviewer.http_client import (
    _host_resolves_safely,
    fetch_url,
)


def _fake_getaddrinfo(ips):
    """Build a fake socket.getaddrinfo returning *ips* (strings)."""
    def fake(host, port, *args, **kwargs):
        # socket.getaddrinfo returns 5-tuples: (family, type, proto,
        # canonname, (host, port)). Keep canonname empty.
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port or 0)) for ip in ips]
    return fake


# --- enrichment.host_allowed --------------------------------------------------

class TestHostAllowedResolvedIPGate:
    """``host_allowed`` must require every resolved IP to be public."""

    def test_allowlisted_host_resolves_only_to_public_ips(self):
        with patch(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            _fake_getaddrinfo(["93.184.216.34"]),
        ):
            assert host_allowed(
                "https://example.com/x", {"example.com"}
            ) is True

    def test_allowlisted_host_resolves_to_imds_link_local(self):
        """169.254.169.254 is the canonical AWS/GCP/Azure IMDS endpoint."""
        with patch(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            _fake_getaddrinfo(["169.254.169.254"]),
        ):
            assert host_allowed(
                "https://example.com/x", {"example.com"}
            ) is False

    def test_allowlisted_host_resolves_to_loopback(self):
        with patch(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            _fake_getaddrinfo(["127.0.0.1"]),
        ):
            assert host_allowed(
                "https://example.com/x", {"example.com"}
            ) is False

    def test_allowlisted_host_resolves_to_ipv6_loopback(self):
        with patch(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            _fake_getaddrinfo(["::1"]),
        ):
            assert host_allowed(
                "https://example.com/x", {"example.com"}
            ) is False

    def test_allowlisted_host_resolves_to_private_rfc1918(self):
        with patch(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            _fake_getaddrinfo(["10.0.0.5"]),
        ):
            assert host_allowed(
                "https://example.com/x", {"example.com"}
            ) is False

    def test_allowlisted_host_resolves_to_private_192(self):
        with patch(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            _fake_getaddrinfo(["192.168.1.10"]),
        ):
            assert host_allowed(
                "https://example.com/x", {"example.com"}
            ) is False

    def test_allowlisted_host_resolves_to_mixed_public_and_link_local(self):
        """Any non-public resolution poisons the result (rebind defense)."""
        with patch(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            _fake_getaddrinfo(["93.184.216.34", "169.254.169.254"]),
        ):
            assert host_allowed(
                "https://example.com/x", {"example.com"}
            ) is False

    def test_hostname_not_in_allowlist_still_rejected(self):
        with patch(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            _fake_getaddrinfo(["93.184.216.34"]),
        ):
            assert host_allowed(
                "https://other.example/x", {"example.com"}
            ) is False

    def test_ip_literal_in_allowlist_resolves_to_public(self):
        with patch(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            _fake_getaddrinfo(["93.184.216.34"]),
        ):
            assert host_allowed(
                "https://93.184.216.34/x", {"93.184.216.34"}
            ) is True

    def test_ip_literal_in_allowlist_resolves_to_link_local(self):
        """An IP-literal allowlisted entry that is itself link-local is refused."""
        with patch(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            _fake_getaddrinfo(["169.254.169.254"]),
        ):
            assert host_allowed(
                "https://169.254.169.254/latest/meta-data/",
                {"169.254.169.254"},
            ) is False

    def test_resolution_failure_rejects_host(self):
        """DNS failure is treated as unsafe, not as a pass-through."""
        def fail(*_args, **_kwargs):
            raise socket.gaierror("no such host")
        with patch(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            fail,
        ):
            assert host_allowed(
                "https://example.com/x", {"example.com"}
            ) is False


# --- http_client.fetch_url ---------------------------------------------------

class TestFetchUrlResolvedIPGate:
    """``fetch_url`` must short-circuit before opening the socket."""

    def test_returns_none_when_resolution_is_link_local(self):
        """The acceptance test: link-local resolution ⇒ no request issued."""
        captured: dict[str, object] = {"called": False}

        def fail_open(*args, **kwargs):
            captured["called"] = True
            raise AssertionError("urllib opener must not be invoked")

        with patch(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            _fake_getaddrinfo(["169.254.169.254"]),
        ), patch(
            "urllib.request.build_opener", side_effect=fail_open
        ):
            assert fetch_url("https://example.com/x") is None
        assert captured["called"] is False

    def test_returns_none_when_resolution_is_loopback(self):
        with patch(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            _fake_getaddrinfo(["127.0.0.1"]),
        ):
            assert fetch_url(
                "https://example.com/x",
                allowed_hosts={"example.com"},
            ) is None

    def test_ip_literal_link_local_in_allowlist_rejected(self):
        """Even when the link-local IP is itself in the allowlist."""
        with patch(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            _fake_getaddrinfo(["169.254.169.254"]),
        ):
            assert fetch_url(
                "https://169.254.169.254/latest/meta-data/iam/info",
                allowed_hosts={"169.254.169.254"},
            ) is None

    def test_fetch_proceeds_when_resolution_is_public(self, monkeypatch):
        """Sanity check: a publicly-routable resolution still allows the fetch."""
        opened = MagicMock()
        opened.__enter__.return_value.read.return_value = b"ok"
        opener = MagicMock()
        opener.open.return_value = opened

        monkeypatch.setattr(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            _fake_getaddrinfo(["93.184.216.34"]),
        )
        monkeypatch.setattr(
            "urllib.request.build_opener", lambda *a, **kw: opener
        )
        assert fetch_url(
            "https://example.com/x",
            allowed_hosts={"example.com"},
        ) == b"ok"


# --- http_client redirect handler -------------------------------------------

class TestRedirectResolvedIPGate:
    """The same resolved-IP gate must apply on every redirect hop."""

    def test_redirect_to_link_local_rejected(self):
        from pr_reviewer.http_client import _AllowListRedirectHandler

        handler = _AllowListRedirectHandler({"example.com"})
        req = urllib.request.Request("https://example.com/x")
        with patch(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            _fake_getaddrinfo(["169.254.169.254"]),
        ):
            with pytest.raises(urllib.error.URLError):
                handler.redirect_request(
                    req, None, 302, "Found", {}, "https://example.com/y"
                )

    def test_redirect_to_loopback_rejected(self):
        from pr_reviewer.http_client import _AllowListRedirectHandler

        handler = _AllowListRedirectHandler({"example.com"})
        req = urllib.request.Request("https://example.com/x")
        with patch(
            "pr_reviewer.enrichment.socket.getaddrinfo",
            _fake_getaddrinfo(["127.0.0.1"]),
        ):
            with pytest.raises(urllib.error.URLError):
                handler.redirect_request(
                    req, None, 302, "Found", {}, "https://example.com/y"
                )
