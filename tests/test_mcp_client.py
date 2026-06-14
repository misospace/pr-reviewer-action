"""Unit tests for pr_reviewer.mcp_client (#245) — no network (stubbed transport)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pr_reviewer.mcp_client import (
    McpToolset,
    is_read_only_tool,
    namespaced_name,
    parse_server_specs,
    split_namespaced,
    _parse_jsonrpc,
)


def _stub(tools, *, fail_initialize=False, call_text="rendered diff"):
    """A scripted MCP transport (post_fn) — no network."""
    def post(url, payload, session_id, token, timeout):
        method = payload.get("method")
        if method == "initialize":
            if fail_initialize:
                return None, session_id, "connection refused"
            return {"jsonrpc": "2.0", "id": 1, "result": {"capabilities": {}}}, "sess-1", None
        if method == "notifications/initialized":
            return None, session_id, None
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": 2, "result": {"tools": tools}}, session_id, None
        if method == "tools/call":
            name = payload["params"]["name"]
            return (
                {"jsonrpc": "2.0", "id": 3,
                 "result": {"content": [{"type": "text", "text": f"{call_text}:{name}"}]}},
                session_id, None,
            )
        return None, session_id, "unknown method"
    return post


_KONFLATE_TOOLS = [
    {"name": "list_pull_requests", "description": "list PRs",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "get_pr_diff", "description": "rendered diff",
     "inputSchema": {"type": "object", "properties": {"number": {"type": "integer"}}}},
    {"name": "delete_pr", "description": "DANGER", "inputSchema": {"type": "object"}},
    {"name": "update_config", "description": "DANGER", "inputSchema": {"type": "object"}},
]


# ── read-only filter ──────────────────────────────────────────────────────────
def test_is_read_only_tool():
    for ok in ("list_pull_requests", "get_pr_diff", "read_file", "search-x", "diff", "status"):
        assert is_read_only_tool(ok)
    for bad in ("delete_pr", "update_config", "create_x", "set_y", "run_z", "exec_q", ""):
        assert not is_read_only_tool(bad)


def test_connect_advertises_only_read_only_namespaced():
    ts = McpToolset("konflate", "http://x/mcp", post_fn=_stub(_KONFLATE_TOOLS))
    assert ts.connect() is None
    names = {s["name"] for s in ts.schemas}
    assert names == {
        "mcp__konflate__list_pull_requests",
        "mcp__konflate__get_pr_diff",
    }
    # write-verb tools are default-denied (never advertised)
    assert not any("delete" in n or "update" in n for n in names)
    # schema carries the server's inputSchema + an [MCP:...] description tag
    diff = next(s for s in ts.schemas if s["name"].endswith("get_pr_diff"))
    assert diff["parameters"]["properties"] == {"number": {"type": "integer"}}
    assert "[MCP:konflate]" in diff["description"]


def test_call_renders_text_content():
    ts = McpToolset("konflate", "http://x/mcp", post_fn=_stub(_KONFLATE_TOOLS))
    ts.connect()
    res = ts.call("get_pr_diff", {"number": 7462})
    assert res == {"content": "rendered diff:get_pr_diff"}


def test_call_refuses_non_advertised_or_write_tool():
    ts = McpToolset("konflate", "http://x/mcp", post_fn=_stub(_KONFLATE_TOOLS))
    ts.connect()
    # never surfaced (write verb) → refused at call time without hitting the server
    assert "not allowed" in ts.call("delete_pr", {})["error"]
    # not in the catalogue at all → refused
    assert "not allowed" in ts.call("get_secrets", {})["error"]


def test_connect_failure_returns_error_and_no_schemas():
    ts = McpToolset("dead", "http://x/mcp", post_fn=_stub([], fail_initialize=True))
    err = ts.connect()
    assert err and "initialize failed" in err
    assert ts.schemas == []


# ── helpers ───────────────────────────────────────────────────────────────────
def test_namespacing_round_trip():
    assert namespaced_name("konflate", "get_pr_diff") == "mcp__konflate__get_pr_diff"
    assert split_namespaced("mcp__konflate__get_pr_diff") == ("konflate", "get_pr_diff")
    assert split_namespaced("read_file") is None
    assert split_namespaced("mcp__nosep") is None


def test_parse_server_specs():
    assert parse_server_specs("") == []
    assert parse_server_specs("konflate=https://k/mcp") == [("konflate", "https://k/mcp")]
    assert parse_server_specs("a=http://a/x,\n b=https://b/y ") == [
        ("a", "http://a/x"), ("b", "https://b/y")
    ]
    assert parse_server_specs("garbage,nourl=") == []  # no url → dropped


def test_parse_server_specs_rejects_unsafe_urls():
    # SSRF/LFI hardening: only host-bearing http(s) URLs survive.
    assert parse_server_specs("x=file:///etc/passwd") == []
    assert parse_server_specs("x=gopher://evil/") == []
    assert parse_server_specs("x=https:///nohost") == []
    assert parse_server_specs("ok=https://k/mcp, bad=file:///x") == [("ok", "https://k/mcp")]


def test_parse_server_specs_rejects_raw_control_chars():
    # Raw NUL / control chars are never valid in a URL — rejected as hygiene.
    # (Percent-encoded %00/%2f are valid encoding and ride in the HTTP path; not
    # an LFI here, so they are NOT rejected.)
    assert parse_server_specs("x=https://h/a\x00b") == []
    assert parse_server_specs("x=https://h/a\tb") == []
    assert parse_server_specs("x=https://\x00evil/p") == []
    assert parse_server_specs("ok=https://h/a%00b") == [("ok", "https://h/a%00b")]


def test_parse_jsonrpc_plain_and_sse():
    assert _parse_jsonrpc('{"jsonrpc":"2.0","id":1,"result":{}}')["id"] == 1
    sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n'
    assert _parse_jsonrpc(sse)["result"] == {"ok": True}
    assert _parse_jsonrpc("") is None
    assert _parse_jsonrpc("not json") is None
