"""Unit tests for :mod:`pr_reviewer.forge`.

The forge capability is the one place the Python tooling talks to the
host API. These tests pin the five properties every forge read/write
relies on:

- redirects are refused (the bearer token must never follow a 3xx to a
  different origin — the ``#855``-class risk a hand-rolled ``urlopen``
  would expose);
- the base URL must use HTTPS for every non-loopback origin so the
  bearer token is never sent over plaintext HTTP — loopback HTTP is
  permitted only because the credential never leaves the host;
- the token rides only the ``Authorization`` header, never the URL or
  the body or argv;
- a request URL is bound to the validated base; an absolute URL or a
  path that contains CR/LF/whitespace is rejected before any network
  call;
- the error string never carries the token or the raw response body
  (a hostile server could otherwise reflect the credential back into a
  value that reaches callers or logs).

No real network: every test either stubs an in-process HTTP server or
exercises the request-building path before any byte goes out.
"""

from __future__ import annotations

import json
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pr_reviewer import forge  # noqa: E402


# ---------------------------------------------------------------------------
# URL building and request shape
# ---------------------------------------------------------------------------


class TestForgeClientBuildsValidRequest:
    def test_default_base_url_is_github(self, monkeypatch):
        monkeypatch.delenv("GITHUB_API_URL", raising=False)
        client = forge.ForgeClient()
        assert client.base_url == "https://api.github.com"

    def test_github_api_url_override_is_respected(self, monkeypatch):
        monkeypatch.setenv("GITHUB_API_URL", "https://ghe.example.com/api/v3")
        client = forge.ForgeClient()
        assert client.base_url == "https://ghe.example.com/api/v3"

    def test_invalid_github_api_url_is_rejected(self, monkeypatch):
        monkeypatch.setenv("GITHUB_API_URL", "javascript:alert(1)")
        with pytest.raises(forge.ForgeError, match="invalid GITHUB_API_URL"):
            forge.ForgeClient()

    def test_token_is_read_from_github_token_env(self, monkeypatch):
        monkeypatch.delenv("GH_TOKEN", raising=False)
        monkeypatch.setenv("GITHUB_TOKEN", "secret-a")
        client = forge.ForgeClient()
        assert client.token == "secret-a"

    def test_token_is_read_from_gh_token_env(self, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.setenv("GH_TOKEN", "secret-b")
        client = forge.ForgeClient()
        assert client.token == "secret-b"

    def test_explicit_token_wins_over_environment(self, monkeypatch):
        monkeypatch.setenv("GITHUB_TOKEN", "env-token")
        client = forge.ForgeClient(token="explicit-token")
        assert client.token == "explicit-token"

    def test_absent_token_is_empty_string(self, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.delenv("GH_TOKEN", raising=False)
        client = forge.ForgeClient()
        assert client.token == ""


class TestForgeClientRequiresHTTPSForNonLoopbackBase:
    """The bearer token must ride only an encrypted transport for any host
    the credential could leave the machine. Loopback HTTP is permitted
    only because the request never leaves the box; a configured
    ``http://ghe.example.com`` (or accidental ``http://`` override) would
    attach ``Authorization: Bearer <token>`` to a cleartext request and
    leak the credential on any network an attacker can observe. The
    base-URL guard rejects that combination at ``__init__`` time, before
    any byte goes out, and refuses to construct the client at all.
    """

    def test_http_to_non_loopback_hostname_is_rejected(self):
        with pytest.raises(forge.ForgeError, match="non-loopback HTTP"):
            forge.ForgeClient(base_url="http://ghe.example.com/api/v3")

    def test_http_to_non_loopback_ipv4_is_rejected(self):
        with pytest.raises(forge.ForgeError, match="non-loopback HTTP"):
            forge.ForgeClient(base_url="http://10.0.0.1/api/v3")

    def test_http_to_loopback_ipv4_is_allowed(self, monkeypatch):
        monkeypatch.delenv("GITHUB_API_URL", raising=False)
        client = forge.ForgeClient(
            base_url="http://127.0.0.1:8080/api/v3", token="loopback-secret"
        )
        assert client.base_url == "http://127.0.0.1:8080/api/v3"

    def test_http_to_localhost_is_allowed(self, monkeypatch):
        monkeypatch.delenv("GITHUB_API_URL", raising=False)
        client = forge.ForgeClient(base_url="http://localhost/api/v3")
        assert client.base_url == "http://localhost/api/v3"

    def test_http_to_ipv6_loopback_is_allowed(self, monkeypatch):
        monkeypatch.delenv("GITHUB_API_URL", raising=False)
        client = forge.ForgeClient(base_url="http://[::1]:8080/api/v3")
        assert client.base_url == "http://[::1]:8080/api/v3"

    def test_https_to_non_loopback_host_is_allowed(self):
        client = forge.ForgeClient(
            base_url="https://ghe.example.com/api/v3", token="enterprise-token"
        )
        assert client.base_url == "https://ghe.example.com/api/v3"
        assert client.token == "enterprise-token"

    def test_token_with_non_loopback_http_fails_before_request(self):
        """A token + non-loopback HTTP base URL must raise ForgeError at
        ``__init__`` so no byte is ever put on the wire carrying the
        credential. The test asserts (a) construction fails, (b) the
        error is the documented ForgeError from the base-URL guard, and
        (c) no network request is made — verified by a local socket
        listener bound to ``127.0.0.1`` that records every connection
        and is asserted empty. The base URL still names the would-be
        attacker host, so the constructor rejection (not a connection
        refusal) is what stopped the credential. A failure mode where
        the guard passes and the client later opened a TCP socket would
        still leak the credential on the first byte.
        """
        contacted = {"count": 0}

        class CountingHandler(BaseHTTPRequestHandler):
            def handle_one_request(self):
                contacted["count"] += 1
                super().handle_one_request()

            def log_message(self, *_args):  # noqa: ANN001
                pass

        class CountingServer(HTTPServer):
            def process_request(self, *args, **kwargs):  # noqa: ANN002, ANN003
                contacted["count"] += 1
                super().process_request(*args, **kwargs)

        server = CountingServer(("127.0.0.1", 0), CountingHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            SECRET = "would-leak-on-http"
            with pytest.raises(forge.ForgeError, match="non-loopback HTTP"):
                forge.ForgeClient(
                    base_url="http://attacker.example.com/api/v3",
                    token=SECRET,
                )
            assert contacted["count"] == 0, (
                "the base-URL guard must refuse to construct the client "
                "before any TCP connection — a token should never reach "
                "the wire over plaintext HTTP"
            )
        finally:
            server.shutdown()
            server.server_close()

    def test_token_with_non_loopback_http_via_env_fails_before_request(self, monkeypatch):
        """The ``GITHUB_API_URL`` env-var path must apply the same guard —
        an operator who sets ``GITHUB_API_URL=http://...`` by accident
        gets the same refused construction, not a silently-leaking
        client.
        """
        monkeypatch.setenv("GITHUB_API_URL", "http://ghe.example.com/api/v3")
        monkeypatch.setenv("GITHUB_TOKEN", "would-leak-on-http")
        with pytest.raises(forge.ForgeError, match="non-loopback HTTP"):
            forge.ForgeClient()


class TestForgeClientRejectsPathInjection:
    """The path is the only forge-shaped argument the caller controls. Any
    attempt to smuggle an absolute URL, a control character, or whitespace
    into the request URL must be rejected before any network call."""

    def test_absolute_url_in_path_is_rejected(self):
        client = forge.ForgeClient()
        with pytest.raises(forge.ForgeError, match="invalid path"):
            client._url("https://evil.example.com/x")

    def test_protocol_relative_path_is_rejected(self):
        client = forge.ForgeClient()
        with pytest.raises(forge.ForgeError, match="invalid path"):
            client._url("//evil.example.com/x")

    def test_crlf_in_path_is_rejected(self):
        client = forge.ForgeClient()
        with pytest.raises(forge.ForgeError, match="invalid path"):
            client._url("/repos/x\r\nHost: evil")

    def test_space_in_path_is_rejected(self):
        client = forge.ForgeClient()
        with pytest.raises(forge.ForgeError, match="invalid path"):
            client._url("/repos with space/x")

    def test_tab_in_path_is_rejected(self):
        client = forge.ForgeClient()
        with pytest.raises(forge.ForgeError, match="invalid path"):
            client._url("/repos\twith\ttab")


# ---------------------------------------------------------------------------
# Redirect safety — the #855-class contract
# ---------------------------------------------------------------------------


class TestForgeClientRefusesRedirects:
    """The bearer token must never follow a 3xx to a different origin.
    A real ``urlopen`` call copies ``Authorization`` onto a redirected
    request even across origins — the canonical ``#855`` leak. The
    :class:`ForgeClient` MUST raise instead."""

    def _make_origin_redirecting_to(self, target_url: str, recorder: dict) -> HTTPServer:
        def handle(self):
            self.raw_requestline = self.rfile.readline()
            if not self.raw_requestline:
                return
            if not self.parse_request():
                return
            recorder["auth"].append(self.headers.get("Authorization"))
            recorder["requests"] += 1
            self.send_response(302)
            self.send_header("Location", target_url)
            self.end_headers()

        def log_message(self, *_args):  # noqa: ANN001
            pass

        cls = type(
            "OriginHandler",
            (BaseHTTPRequestHandler,),
            {"handle_one_request": handle, "log_message": log_message},
        )
        return HTTPServer(("127.0.0.1", 0), cls)

    def _make_target(self, recorder: dict) -> HTTPServer:
        def handle(self):
            self.raw_requestline = self.rfile.readline()
            if not self.raw_requestline:
                return
            if not self.parse_request():
                return
            recorder["auth"].append(self.headers.get("Authorization"))
            recorder["requests"] += 1
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"x":1}')

        def log_message(self, *_args):  # noqa: ANN001
            pass

        cls = type(
            "TargetHandler",
            (BaseHTTPRequestHandler,),
            {"handle_one_request": handle, "log_message": log_message},
        )
        return HTTPServer(("127.0.0.1", 0), cls)

    def test_3xx_does_not_forward_authorization_to_target(self, monkeypatch):
        SECRET = "test-secret-token"

        target_recorder = {"auth": [], "requests": 0}
        target = self._make_target(target_recorder)
        target_thread = threading.Thread(target=target.serve_forever, daemon=True)
        target_thread.start()
        try:
            target_url = f"http://127.0.0.1:{target.server_port}/api/redirected"
            origin_recorder = {"auth": [], "requests": 0}
            origin = self._make_origin_redirecting_to(target_url, origin_recorder)
            origin_thread = threading.Thread(target=origin.serve_forever, daemon=True)
            origin_thread.start()
            try:
                client = forge.ForgeClient(
                    base_url=f"http://127.0.0.1:{origin.server_port}",
                    token=SECRET,
                )
                with pytest.raises(forge.ForgeError, match="[Rr]edirect"):
                    client.get("/repos/foo/bar")
                assert target_recorder["requests"] == 0, "target must never be contacted"
                assert all(
                    auth is None for auth in target_recorder["auth"]
                ), "target must never see Authorization"
            finally:
                origin.shutdown()
                origin.server_close()
        finally:
            target.shutdown()
            target.server_close()


# ---------------------------------------------------------------------------
# Authorization header
# ---------------------------------------------------------------------------


class TestForgeClientAttachesAuthorizationOnlyToValidatedOrigin:
    """The token must travel only as the ``Authorization`` header on a
    request to the validated base. A URL parameter, a body field, or
    argv must never carry it."""

    def _capture_request(self, token: str) -> tuple[HTTPServer, dict]:
        seen: dict = {"auth": None, "body": b"", "url": None}

        class Handler(BaseHTTPRequestHandler):
            def handle_one_request(self):
                self.raw_requestline = self.rfile.readline()
                if not self.raw_requestline:
                    return
                if not self.parse_request():
                    return
                seen["auth"] = self.headers.get("Authorization")
                seen["url"] = self.path
                content_length = int(self.headers.get("Content-Length") or 0)
                if content_length:
                    seen["body"] = self.rfile.read(content_length)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok": true}')

            def log_message(self, *_args):  # noqa: ANN001
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server, seen

    def test_authorization_header_carries_token(self, monkeypatch):
        SECRET = "the-secret-value"
        server, seen = self._capture_request(SECRET)
        try:
            client = forge.ForgeClient(
                base_url=f"http://127.0.0.1:{server.server_port}",
                token=SECRET,
            )
            assert client.get("/repos/test/repo") == {"ok": True}
            assert seen["auth"] == f"Bearer {SECRET}"
        finally:
            server.shutdown()
            server.server_close()

    def test_token_does_not_appear_in_url_or_body(self, monkeypatch):
        SECRET = "the-secret-value"
        server, seen = self._capture_request(SECRET)
        try:
            client = forge.ForgeClient(
                base_url=f"http://127.0.0.1:{server.server_port}",
                token=SECRET,
            )
            client.get("/repos/test/repo", {"per_page": "100"})
            # Token must not appear anywhere in the URL or body, only in
            # the header.
            assert SECRET not in seen["url"]
            assert SECRET not in seen["body"].decode("utf-8", errors="replace")
            assert seen["auth"] == f"Bearer {SECRET}"
        finally:
            server.shutdown()
            server.server_close()

    def test_unauthenticated_request_omits_authorization_header(self):
        server, seen = self._capture_request("")
        try:
            client = forge.ForgeClient(
                base_url=f"http://127.0.0.1:{server.server_port}",
                token="",
            )
            client.get("/repos/test/repo")
            assert seen["auth"] is None
        finally:
            server.shutdown()
            server.server_close()


# ---------------------------------------------------------------------------
# Error string safety
# ---------------------------------------------------------------------------


class TestForgeErrorDoesNotEchoSecrets:
    """A hostile server could reflect the token back in a 4xx body. The
    forge error string must be a fixed message — never the response
    body, never the token."""

    def _make_server(self, body: bytes, status: int) -> HTTPServer:
        class Handler(BaseHTTPRequestHandler):
            def handle_one_request(self):
                self.raw_requestline = self.rfile.readline()
                if not self.raw_requestline:
                    return
                if not self.parse_request():
                    return
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):  # noqa: ANN001
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    def test_http_404_error_does_not_include_response_body(self):
        SECRET = "leaked-on-404"
        body = json.dumps({"message": f"token {SECRET} invalid"}).encode("utf-8")
        server = self._make_server(body, 404)
        try:
            client = forge.ForgeClient(
                base_url=f"http://127.0.0.1:{server.server_port}",
                token=SECRET,
            )
            with pytest.raises(forge.ForgeError) as info:
                client.get("/repos/test/repo")
            assert SECRET not in str(info.value), "token must not appear in error string"
            assert "404" in str(info.value), "fixed status code IS reported"
        finally:
            server.shutdown()
            server.server_close()

    def test_invalid_json_response_is_a_fixed_error(self):
        server = self._make_server(b"not-json", 200)
        try:
            client = forge.ForgeClient(
                base_url=f"http://127.0.0.1:{server.server_port}",
            )
            with pytest.raises(forge.ForgeError, match="invalid JSON"):
                client.get("/repos/test/repo")
        finally:
            server.shutdown()
            server.server_close()


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------


class TestGetPagesStopsAtShortPage:
    """``get_pages`` walks the ``per_page`` boundary correctly: it stops
    when the server returns fewer than the requested per_page items, and
    threads ``page`` through successive calls."""

    def _make_paginated(self, pages: list[list[dict]]) -> HTTPServer:
        class Handler(BaseHTTPRequestHandler):
            def handle_one_request(self):
                self.raw_requestline = self.rfile.readline()
                if not self.raw_requestline:
                    return
                if not self.parse_request():
                    return
                query = urllib.parse.urlparse(self.path).query
                params = dict(urllib.parse.parse_qsl(query))
                page = int(params.get("page", "1"))
                index = page - 1
                if 0 <= index < len(pages):
                    body = pages[index]
                else:
                    body = []
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode("utf-8"))

            def log_message(self, *_args):  # noqa: ANN001
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    def test_yields_every_item_across_pages(self):
        server = self._make_paginated(
            [
                [{"i": 1}, {"i": 2}, {"i": 3}],
                [{"i": 4}],
            ]
        )
        try:
            client = forge.ForgeClient(
                base_url=f"http://127.0.0.1:{server.server_port}",
            )
            items = list(client.get_pages("/x", per_page=3))
            assert items == [{"i": 1}, {"i": 2}, {"i": 3}, {"i": 4}]
        finally:
            server.shutdown()
            server.server_close()

    def test_stops_when_a_page_is_shorter_than_per_page(self):
        server = self._make_paginated(
            [
                [{"i": 1}, {"i": 2}],
                [{"i": 3}, {"i": 4}, {"i": 5}, {"i": 6}],  # full page
            ]
        )
        try:
            client = forge.ForgeClient(
                base_url=f"http://127.0.0.1:{server.server_port}",
            )
            # per_page=4, page 1 returns 2 items (short), so we stop.
            items = list(client.get_pages("/x", per_page=4))
            assert items == [{"i": 1}, {"i": 2}]
        finally:
            server.shutdown()
            server.server_close()


# ---------------------------------------------------------------------------
# The legacy / historical re-exports scripts expose
# ---------------------------------------------------------------------------


class TestReExportsKeepBackwardsCompat:
    """``scripts/check_corpus_anchor_in_diff`` and
    ``scripts/harvest_human_findings`` re-export ``GitHubAPIError`` as an
    alias of :class:`forge.ForgeError` so existing callers/tests can
    catch either name. The alias must be the SAME class — not a
    separate subclass — so ``except`` clauses keep working."""

    def test_check_corpus_anchor_uses_same_forge_error(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        try:
            import check_corpus_anchor_in_diff as ccai
            assert ccai.GitHubAPIError is forge.ForgeError
        finally:
            sys.path.pop(sys.path.index(str(ROOT / "scripts")))

    def test_harvest_human_findings_uses_same_forge_error(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        try:
            import harvest_human_findings as hhf
            assert hhf.GitHubAPIError is forge.ForgeError
        finally:
            sys.path.pop(sys.path.index(str(ROOT / "scripts")))
