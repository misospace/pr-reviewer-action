"""pr_reviewer.judge_http: one OpenAI-compatible chat call; the key rides
only the Authorization header and never reaches an error message."""

from __future__ import annotations

import base64
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pr_reviewer.judge_http import JudgeHTTPError, chat_completion  # noqa: E402

SECRET = "judge-test-credential"


def _serve(status: int, body: bytes, location: str | None = None):
    seen: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def _handle(self):
            seen["requests"] = seen.get("requests", 0) + 1
            seen["path"] = self.path
            seen["auth"] = self.headers.get("Authorization")
            seen["host"] = self.headers.get("Host")
            seen["requestline"] = self.requestline
            seen["body"] = self.rfile.read(int(self.headers.get("Content-Length", "0") or 0)).decode()
            self.send_response(status)
            if location:
                self.send_header("Location", location)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):  # noqa: N802
            self._handle()

        def do_GET(self):  # noqa: N802
            self._handle()

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, seen


def test_posts_to_chat_completions_with_the_key_only_in_the_header():
    server, seen = _serve(200, json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode())
    try:
        result = chat_completion(f"http://127.0.0.1:{server.server_port}/v1/", {"model": "m"}, SECRET, 5)
    finally:
        server.shutdown()
    assert result["choices"][0]["message"]["content"] == "ok"
    assert seen["path"] == "/v1/chat/completions"
    assert seen["auth"] == f"Bearer {SECRET}"
    assert SECRET not in seen["path"] and SECRET not in seen["body"]


def test_http_errors_never_echo_the_key():
    server, _seen = _serve(401, json.dumps({"error": f"bad key {SECRET}"}).encode())
    try:
        with pytest.raises(JudgeHTTPError) as caught:
            chat_completion(f"http://127.0.0.1:{server.server_port}/v1", {"model": "m"}, SECRET, 5)
    finally:
        server.shutdown()
    assert "401" in str(caught.value)
    assert SECRET not in str(caught.value)


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_redirects_are_refused_and_never_forward_the_key(status: int):
    target, target_seen = _serve(200, json.dumps({"choices": [{"message": {"content": "leak"}}]}).encode())
    origin, origin_seen = _serve(status, b"{}", location=f"http://127.0.0.1:{target.server_port}/v1/chat/completions")
    try:
        with pytest.raises(JudgeHTTPError) as caught:
            chat_completion(f"http://127.0.0.1:{origin.server_port}/v1", {"model": "m"}, SECRET, 5)
    finally:
        origin.shutdown()
        target.shutdown()
    assert origin_seen["requests"] == 1
    assert "requests" not in target_seen, "the redirect target must never be contacted"
    assert "redirect" in str(caught.value)
    assert SECRET not in str(caught.value)


# ── endpoint credential (#1414): the credential rides the header, never the URL

CREDENTIAL = "judge-operator:hunter2"


def _assert_credential_is_header_only(seen: dict) -> None:
    """The credential must not appear in ANY part of the outbound request
    except the Authorization header: Python's urllib keeps a URL userinfo
    inside the request's ``Host`` value, so a URL-borne credential would
    reach the request line's host header and every proxy log."""
    assert seen["path"] == "/v1/chat/completions"
    for value in (seen["requestline"], seen["host"], seen["path"], seen["body"]):
        assert "hunter2" not in value
        assert "judge-operator" not in value
    assert seen["auth"] == "Basic " + base64.b64encode(CREDENTIAL.encode()).decode("ascii")


def test_url_credential_travels_in_the_header_never_in_the_request_line():
    server, seen = _serve(200, json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode())
    try:
        result = chat_completion(
            f"http://{CREDENTIAL}@127.0.0.1:{server.server_port}/v1",
            {"model": "m"}, "", 5,
        )
    finally:
        server.shutdown()
    assert result["choices"][0]["message"]["content"] == "ok"
    _assert_credential_is_header_only(seen)


def test_pre_split_credential_travels_in_the_header_never_in_the_request_line():
    # The runner path: the caller already resolved the endpoint, so the
    # credential arrives as an explicit argument, not inside the URL.
    server, seen = _serve(200, json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode())
    try:
        result = chat_completion(
            f"http://127.0.0.1:{server.server_port}/v1",
            {"model": "m"}, "", 5, basic_credential=CREDENTIAL,
        )
    finally:
        server.shutdown()
    assert result["choices"][0]["message"]["content"] == "ok"
    _assert_credential_is_header_only(seen)


def test_url_credential_and_api_key_fail_closed_without_a_request():
    server, seen = _serve(200, b"{}")
    try:
        with pytest.raises(JudgeHTTPError) as caught:
            chat_completion(
                f"http://{CREDENTIAL}@127.0.0.1:{server.server_port}/v1",
                {"model": "m"}, SECRET, 5,
            )
    finally:
        server.shutdown()
    assert seen.get("requests", 0) == 0
    assert "one credential channel" in str(caught.value)
    assert "hunter2" not in str(caught.value)
    assert "judge-operator" not in str(caught.value)


def test_two_url_credentials_fail_closed_without_a_request():
    # A URL credential AND a pre-split credential: one request carries one
    # Authorization header, so one of them would be dropped silently.
    server, seen = _serve(200, b"{}")
    try:
        with pytest.raises(JudgeHTTPError) as caught:
            chat_completion(
                f"http://{CREDENTIAL}@127.0.0.1:{server.server_port}/v1",
                {"model": "m"}, "", 5, basic_credential="other-operator:t0psecret",
            )
    finally:
        server.shutdown()
    assert seen.get("requests", 0) == 0
    assert "one credential channel" in str(caught.value)
    assert "hunter2" not in str(caught.value)
    assert "t0psecret" not in str(caught.value)


@pytest.mark.parametrize(
    "base_url",
    [
        "not-a-url",
        "ftp://127.0.0.1/v1",
        f"http://{CREDENTIAL}@[::1/v1",
        f"http://{CREDENTIAL}@127.0.0.1:notaport/v1",
        f"http://{CREDENTIAL}@/v1",
        f"http://{CREDENTIAL}@127.0.0.1/v1\x00",
        # An ENCODED '@' hides the credential from the authority split while
        # urllib unquotes the authority into the request's Host value.
        f"http://judge-operator%3Ahunter2%40127.0.0.1/v1",
        # A query rides the request line and can carry a credential.
        "http://127.0.0.1/v1?api_key=secret",
    ],
)
def test_unusable_endpoint_urls_fail_closed_without_echoing_the_credential(base_url: str):
    with pytest.raises(JudgeHTTPError) as caught:
        chat_completion(base_url, {"model": "m"}, "", 5)
    assert "hunter2" not in str(caught.value)
    assert "judge-operator" not in str(caught.value)


def test_encoded_url_credential_is_refused_before_any_request():
    # urllib unquotes the authority into the request's Host value, so an
    # encoded '@' would put the credential back into the request. The
    # endpoint is refused instead, with a credential-free diagnostic.
    with pytest.raises(JudgeHTTPError) as caught:
        chat_completion("http://judge-operator%3Ahunter2%40127.0.0.1/v1", {"model": "m"}, "", 5)
    assert "encoded credential" in str(caught.value)
    assert "hunter2" not in str(caught.value)
    assert "judge-operator" not in str(caught.value)
