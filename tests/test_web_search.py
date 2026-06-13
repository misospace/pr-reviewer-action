"""Tests for the web_search tool (SearXNG-backed) in run_tool_harness.py.

web_search lets the native loop discover a page's URL (e.g. a moved docs
site) and then web_fetch it. It hits a single operator-configured endpoint;
the model supplies only the query string, never the host.
"""

import io
import json
import sys
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import run_tool_harness as rth  # noqa: E402


@contextmanager
def _fake_urlopen(payload):
    """Patch urlopen to return a JSON body, capturing the requested URL."""
    captured = {}

    def _open(req, timeout=None):
        captured["url"] = req.full_url if hasattr(req, "full_url") else req
        return io.BytesIO(json.dumps(payload).encode("utf-8"))

    with mock.patch.object(rth.urllib.request, "urlopen", _open):
        yield captured


SEARCH = "https://search.example.com/search"


def test_returns_capped_normalized_results():
    payload = {"results": [
        {"title": "A", "url": "https://a.example/x", "content": "snip a"},
        {"title": "B", "url": "https://b.example/y", "content": "snip b"},
        {"title": "C", "url": "https://c.example/z", "content": "snip c"},
    ]}
    with _fake_urlopen(payload) as cap:
        res = rth.web_search("talos support matrix", SEARCH, max_results=2)
    assert "error" not in res
    assert len(res["results"]) == 2  # capped
    assert res["results"][0] == {"title": "A", "url": "https://a.example/x", "snippet": "snip a"}
    # query + json format are sent to the configured endpoint
    assert "format=json" in cap["url"] and "q=talos" in cap["url"]


def test_appends_query_when_endpoint_already_has_one():
    with _fake_urlopen({"results": []}) as cap:
        rth.web_search("q", "https://s.example/search?foo=1")
    assert "foo=1" in cap["url"] and "&q=q" in cap["url"]


def test_empty_search_url_is_error():
    res = rth.web_search("anything", "")
    assert "error" in res and "not configured" in res["error"].lower()


def test_transport_failure_is_error():
    def _boom(req, timeout=None):
        raise OSError("connection refused")
    with mock.patch.object(rth.urllib.request, "urlopen", _boom):
        res = rth.web_search("q", SEARCH)
    assert "error" in res


def test_execute_tool_request_dispatches_web_search():
    payload = {"results": [{"title": "T", "url": "https://u.example", "content": "c"}]}
    with _fake_urlopen(payload):
        tr = rth.execute_tool_request(
            "web_search", {"query": "k8s support matrix"},
            ".", set(), "o/r", [], 12000, 20, SEARCH, 5,
        )
    assert tr["status"] == "ok"
    assert "u.example" in tr["result"]["results"]


def test_execute_tool_request_web_search_missing_query():
    tr = rth.execute_tool_request(
        "web_search", {}, ".", set(), "o/r", [], 12000, 20, SEARCH, 5,
    )
    assert tr["status"] == "error"


def test_execute_tool_request_web_search_unconfigured_errors():
    # No search_url passed → executor surfaces the not-configured error.
    tr = rth.execute_tool_request(
        "web_search", {"query": "q"}, ".", set(), "o/r", [], 12000, 20,
    )
    assert tr["status"] == "error"
