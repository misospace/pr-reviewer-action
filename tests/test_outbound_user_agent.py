#!/usr/bin/env python3
"""Regression guard for #252 item 4: the action's urllib-based HTTP helpers
must set a non-default User-Agent.

urllib's default UA (``Python-urllib/X.Y``) trips CDN bot fences — the konflate
evidence provider hit a Cloudflare BIC 1010 / 403 with it. The fix is a UA
header in each helper; this test exercises the real call path so a future
helper that forgets the header fails here instead of in production.
"""

import json
import sys
import urllib.request
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = _REPO_ROOT / "scripts"
for _p in (_REPO_ROOT, _SCRIPTS_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import pytest

from pr_reviewer import tool_executors as te


class _FakeResp:
    def __init__(self, body=b"ok"):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def _capture_ua(monkeypatch, body=b"ok"):
    """Patch urlopen to capture the Request's User-Agent without any network."""
    seen = {}

    def fake_urlopen(req, timeout=None):
        # urllib normalizes the header key to "User-agent".
        seen["ua"] = req.get_header("User-agent")
        return _FakeResp(body)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return seen


def test_web_fetch_sets_non_default_user_agent(monkeypatch):
    seen = _capture_ua(monkeypatch)
    te.web_fetch("https://example.com/x", ["example.com"])
    assert seen["ua"] == "ai-pr-reviewer/1.0"


def test_web_search_sets_non_default_user_agent(monkeypatch):
    seen = _capture_ua(monkeypatch, body=json.dumps({"results": []}).encode())
    te.web_search("anything", "https://search.example/search")
    assert seen["ua"] == "ai-pr-reviewer/1.0"


def test_fetch_url_sets_non_default_user_agent(monkeypatch):
    seen = _capture_ua(monkeypatch)
    te.fetch_url("https://example.com/x", ["example.com"])
    assert seen["ua"] == "ai-pr-reviewer/1.0"


@pytest.mark.parametrize("call", [
    lambda: te.web_fetch("https://example.com/x", ["example.com"]),
    lambda: te.web_search("q", "https://search.example/search"),
    lambda: te.fetch_url("https://example.com/x", ["example.com"]),
])
def test_user_agent_is_never_the_urllib_default(monkeypatch, call):
    # The actual bug class: urllib's default UA is rejected by CDN bot checks.
    seen = _capture_ua(monkeypatch, body=json.dumps({"results": []}).encode())
    call()
    assert seen["ua"] and "Python-urllib" not in seen["ua"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
