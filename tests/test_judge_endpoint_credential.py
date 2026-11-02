"""#1414: the judge endpoint credential never rides in a request URL.

A judge endpoint URL can carry a credential in its userinfo. That credential
must travel in an ``Authorization`` header, never in the request URL: Python's
urllib keeps a URL userinfo inside the request's ``Host`` value, so a
URL-borne credential reaches the outbound request header and every proxy log
on the way out — and it contradicts the repository rule that credentials
travel only in HTTP auth headers.

Adversarial-boundary convention (#252): the boundary token itself — a URL
carrying a credential — is fed through the REAL transport of both judge
runners against a local HTTP server that records the raw request line, the
``Host`` header, the request target and the body. A mock would encode away
the very leak it is meant to close.
"""

from __future__ import annotations

import base64
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer.http_safe import resolve_endpoint  # noqa: E402
from pr_reviewer.judge_http import JudgeHTTPError  # noqa: E402
from scripts import live_judge_score as ljs  # noqa: E402
from scripts import run_judge_calibration as runner  # noqa: E402

CREDENTIAL = "judge-operator:hunter2"
_MESSAGES = [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}]


def _serve():
    """A local judge endpoint that records the raw request it received."""
    seen: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            seen["requests"] = seen.get("requests", 0) + 1
            seen["requestline"] = self.requestline
            seen["host"] = self.headers.get("Host")
            seen["path"] = self.path
            seen["auth"] = self.headers.get("Authorization")
            seen["body"] = self.rfile.read(
                int(self.headers.get("Content-Length", "0") or 0)
            ).decode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode()
            )

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, seen


def _credential_url(server: HTTPServer) -> str:
    return f"http://{CREDENTIAL}@127.0.0.1:{server.server_port}/v1"


def _assert_credential_is_header_only(seen: dict) -> None:
    assert seen["path"] == "/v1/chat/completions"
    for value in (seen["requestline"], seen["host"], seen["path"], seen["body"]):
        assert "hunter2" not in value
        assert "judge-operator" not in value
    assert seen["auth"] == "Basic " + base64.b64encode(CREDENTIAL.encode()).decode("ascii")


def test_calibration_runner_transport_never_sends_the_credential_in_the_url() -> None:
    server, seen = _serve()
    try:
        endpoint = resolve_endpoint(_credential_url(server))
        call = runner._openai_judge_call("m", endpoint, "", 5)
        text = call(_MESSAGES, 0)
    finally:
        server.shutdown()
    assert text == "ok"
    _assert_credential_is_header_only(seen)


def test_live_score_runner_transport_never_sends_the_credential_in_the_url() -> None:
    server, seen = _serve()
    try:
        endpoint = resolve_endpoint(_credential_url(server))
        call = ljs._openai_judge_call("m", endpoint, "", 5)
        text = call(_MESSAGES, 0)
    finally:
        server.shutdown()
    assert text == "ok"
    _assert_credential_is_header_only(seen)


def test_runner_transport_keeps_the_api_key_in_the_header() -> None:
    # The bearer channel is unchanged by the credential handling.
    server, seen = _serve()
    try:
        endpoint = resolve_endpoint(f"http://127.0.0.1:{server.server_port}/v1")
        call = runner._openai_judge_call("m", endpoint, "judge-test-credential", 5)
        call(_MESSAGES, 0)
    finally:
        server.shutdown()
    assert seen["auth"] == "Bearer judge-test-credential"


@pytest.mark.parametrize("runner_module", [runner, ljs])
def test_runner_transport_refuses_two_credential_channels(runner_module) -> None:
    server, seen = _serve()
    try:
        endpoint = resolve_endpoint(_credential_url(server))
        call = runner_module._openai_judge_call("m", endpoint, "judge-test-credential", 5)
        with pytest.raises(JudgeHTTPError) as caught:
            call(_MESSAGES, 0)
    finally:
        server.shutdown()
    assert seen.get("requests", 0) == 0
    assert "one credential channel" in str(caught.value)
    assert "hunter2" not in str(caught.value)
    assert "judge-operator" not in str(caught.value)
