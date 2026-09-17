"""Tests for redirect-SSRF mitigation in web_fetch and fetch_url (Issue #494).

Verifies that both ``web_fetch`` (tool_executors) and ``fetch_url``
(http_client) re-validate the host allowlist on every redirect hop, so a
30x from an allowlisted host cannot pivot to IMDS or internal networks.
"""

import http.server
import socket
import threading
import time
from unittest.mock import patch

import pytest

from pr_reviewer.http_client import fetch_url
from pr_reviewer.tool_executors import web_fetch


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _stub_public_resolution(monkeypatch, ip="93.184.216.34"):
    """Patch the resolved-IP gate so loopback / private test addresses
    are treated as publicly routable.

    These tests exercise the redirect handler; they should not depend on
    the SSRF resolved-IP gate (covered separately in
    tests/test_resolved_ip_ssrf.py). Issue #510 closes the SSRF arc; the
    gate runs alongside the hostname allowlist.
    """
    def fake_resolve(host):
        return [ip]
    monkeypatch.setattr(
        "pr_reviewer.enrichment._resolve_host_ips", fake_resolve
    )


class _RedirectHandler(http.server.BaseHTTPRequestHandler):
    """Sends a redirect to *target*."""

    target: str = ""  # overridden by subclass or test setup

    def do_GET(self):
        self.send_response(302)
        self.send_header("Location", self.target)
        self.end_headers()

    def log_message(self, *_a):
        pass


class _SecretHandler(http.server.BaseHTTPRequestHandler):
    """Returns a known secret body."""

    def do_GET(self):
        b = b"IMDS-SIMULATED-SECRET"
        self.send_response(200)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *_a):
        pass


class _OkHandler(http.server.BaseHTTPRequestHandler):
    """Returns a known OK body."""

    def do_GET(self):
        b = b"OK-DATA"
        self.send_response(200)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *_a):
        pass


def _start_server(handler_cls, port):
    """Start a ThreadingHTTPServer on *port* and return the server object."""
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler_cls)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    time.sleep(0.15)  # let it bind
    return srv


# ---------------------------------------------------------------------------
# web_fetch tests (returns dict with "content" or "error")
# ---------------------------------------------------------------------------

class TestWebFetchRedirect:
    """web_fetch must re-validate redirect targets against the allowlist."""

    def test_allowlisted_to_allowlisted_succeeds(self, monkeypatch):
        """Allowlisted → allowlisted redirect should succeed."""
        _stub_public_resolution(monkeypatch)
        srv1 = _start_server(_RedirectHandler, 0)
        port1 = srv1.server_address[1]
        srv2 = _start_server(_OkHandler, 0)
        port2 = srv2.server_address[1]

        # Redirect to same host (different port), both in allowlist.
        _RedirectHandler.target = f"http://127.0.0.1:{port2}/ok"
        result = web_fetch(f"http://127.0.0.1:{port1}/start", allowed_hosts={"127.0.0.1"})

        assert "content" in result, f"Expected success but got: {result}"
        assert "OK-DATA" in result["content"]

    def test_allowlisted_to_imds_fails(self, monkeypatch):
        """Allowlisted → 169.254.169.254 redirect should be rejected."""
        _stub_public_resolution(monkeypatch)
        srv = _start_server(_RedirectHandler, 0)
        port = srv.server_address[1]
        _RedirectHandler.target = "http://169.254.169.254/latest/meta-data/"

        result = web_fetch(f"http://127.0.0.1:{port}/start", allowed_hosts={"127.0.0.1"})

        assert "error" in result, f"Expected error but got: {result}"
        assert "disallowed host" in result["error"].lower() or "redirect" in result["error"].lower()

    def test_allowlisted_to_localhost_fails(self, monkeypatch):
        """Allowlisted → localhost redirect should be rejected."""
        _stub_public_resolution(monkeypatch)
        srv = _start_server(_RedirectHandler, 0)
        port = srv.server_address[1]
        _RedirectHandler.target = "http://localhost:9999/secret"

        # Allow the initial host but not localhost.
        result = web_fetch(f"http://127.0.0.1:{port}/start", allowed_hosts={"127.0.0.1"})

        assert "error" in result, f"Expected error but got: {result}"
        assert "disallowed host" in result["error"].lower() or "redirect" in result["error"].lower()

    def test_too_many_redirects_fails(self, monkeypatch):
        """A chain of >10 redirects should be rejected."""
        _stub_public_resolution(monkeypatch)
        srv = _start_server(_RedirectHandler, 0)
        port = srv.server_address[1]
        # Redirect to itself (same host, so always allowlisted).
        _RedirectHandler.target = f"http://127.0.0.1:{port}/loop"

        result = web_fetch(f"http://127.0.0.1:{port}/start", allowed_hosts={"127.0.0.1"})

        assert "error" in result, f"Expected error but got: {result}"
        assert "redirect" in result["error"].lower()


# ---------------------------------------------------------------------------
# fetch_url tests (returns bytes on success or None on failure)
# ---------------------------------------------------------------------------

class TestFetchUrlRedirect:
    """fetch_url must re-validate redirect targets against the allowlist."""

    def test_allowlisted_to_allowlisted_succeeds(self, monkeypatch):
        """Allowlisted → allowlisted redirect should succeed."""
        _stub_public_resolution(monkeypatch)
        srv1 = _start_server(_RedirectHandler, 0)
        port1 = srv1.server_address[1]
        srv2 = _start_server(_OkHandler, 0)
        port2 = srv2.server_address[1]

        # Use explicit allowlist that includes both hosts.
        allowed = {"127.0.0.1"}
        _RedirectHandler.target = f"http://127.0.0.1:{port2}/ok"
        result = fetch_url(f"http://127.0.0.1:{port1}/start", allowed_hosts=allowed)

        assert result is not None, f"Expected bytes but got: {result}"
        assert b"OK-DATA" in result

    def test_allowlisted_to_imds_fails(self, monkeypatch):
        """Allowlisted → 169.254.169.254 redirect should be rejected."""
        _stub_public_resolution(monkeypatch)
        srv = _start_server(_RedirectHandler, 0)
        port = srv.server_address[1]
        _RedirectHandler.target = "http://169.254.169.254/latest/meta-data/"

        result = fetch_url(f"http://127.0.0.1:{port}/start", allowed_hosts={"github.com"})

        assert result is None, f"Expected None but got: {result}"

    def test_allowlisted_to_localhost_fails(self, monkeypatch):
        """Allowlisted → localhost redirect should be rejected."""
        _stub_public_resolution(monkeypatch)
        srv = _start_server(_RedirectHandler, 0)
        port = srv.server_address[1]
        _RedirectHandler.target = "http://localhost:9999/secret"

        result = fetch_url(f"http://127.0.0.1:{port}/start", allowed_hosts={"github.com"})

        assert result is None, f"Expected None but got: {result}"

    def test_too_many_redirects_fails(self, monkeypatch):
        """A chain of >10 redirects should be rejected."""
        _stub_public_resolution(monkeypatch)
        srv = _start_server(_RedirectHandler, 0)
        port = srv.server_address[1]
        _RedirectHandler.target = f"http://127.0.0.1:{port}/loop"

        result = fetch_url(f"http://127.0.0.1:{port}/start", allowed_hosts={"127.0.0.1"})

        assert result is None, f"Expected None but got: {result}"
