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

from pr_reviewer import http_client
from pr_reviewer import tool_executors as te
from scripts import run_enrichment


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


def _capture_ua_via_opener(monkeypatch, body=b"ok"):
    """Patch opener.open to capture the Request's User-Agent without any network.

    Used by web_fetch and fetch_url which now build a custom opener with
    a redirect handler instead of calling urlopen directly.
    """
    seen = {}

    def fake_open(self, req, timeout=None):
        # urllib normalizes the header key to "User-agent".
        seen["ua"] = req.get_header("User-agent")
        return _FakeResp(body)

    # Patch build_opener to return an opener whose open method captures the UA.
    def fake_build_opener(*handlers):
        opener = type("FakeOpener", (), {"open": fake_open})()
        return opener

    monkeypatch.setattr(urllib.request, "build_opener", fake_build_opener)
    return seen


def test_web_fetch_sets_non_default_user_agent(monkeypatch):
    seen = _capture_ua_via_opener(monkeypatch)
    te.web_fetch("https://example.com/x", ["example.com"])
    assert seen["ua"] == "ai-pr-reviewer/1.0"


def test_web_search_sets_non_default_user_agent(monkeypatch):
    seen = _capture_ua(monkeypatch, body=json.dumps({"results": []}).encode())
    te.web_search("anything", "https://search.example/search")
    assert seen["ua"] == "ai-pr-reviewer/1.0"


@pytest.mark.parametrize("call,capture", [
    (lambda: te.web_fetch("https://example.com/x", ["example.com"]), _capture_ua_via_opener),
    (lambda: te.web_search("q", "https://search.example/search"), _capture_ua),
])
def test_user_agent_is_never_the_urllib_default(monkeypatch, call, capture):
    # The actual bug class: urllib's default UA is rejected by CDN bot checks.
    seen = capture(monkeypatch, body=json.dumps({"results": []}).encode())
    call()
    assert seen["ua"] and "Python-urllib" not in seen["ua"]


def test_run_enrichment_fetch_url_sets_user_agent(monkeypatch):
    """run_enrichment.fetch_url must set the same non-default User-Agent.

    fetch_url now lives in pr_reviewer.http_client and is re-exported as
    run_enrichment.fetch_url; it uses a custom opener, so we patch build_opener.
    """
    seen = {}

    def fake_open(self, req, timeout=None):
        seen["ua"] = req.get_header("User-agent")
        return _FakeResp(b"ok")

    def fake_build_opener(*handlers):
        opener = type("FakeOpener", (), {"open": fake_open})()
        return opener

    monkeypatch.setattr(urllib.request, "build_opener", fake_build_opener)
    # Use a host in the default allowlist so fetch_url doesn't short-circuit.
    run_enrichment.fetch_url("https://github.com/x")
    assert seen["ua"] == "ai-pr-reviewer/1.0"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
