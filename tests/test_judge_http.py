"""pr_reviewer.judge_http: one OpenAI-compatible chat call; the key rides
only the Authorization header and never reaches an error message."""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pr_reviewer.judge_http import JudgeHTTPError, chat_completion  # noqa: E402

SECRET = "judge-test-credential"


def _serve(status: int, body: bytes):
    seen: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            seen["path"] = self.path
            seen["auth"] = self.headers.get("Authorization")
            seen["body"] = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

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
