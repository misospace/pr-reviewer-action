"""Read-only MCP tool client for the native tool-calling loop (#245).

Lets the loop call read-only tools from an *allowlisted* set of MCP servers, so
a reviewer can pull host-specific pre-rendered evidence the built-in tools can't
produce (e.g. konflate's post-kustomize/Helm rendered Kubernetes diff).

Security posture (hard requirements from #245):

* **Allowlist only** — a server is used only if explicitly listed; no discovery.
* **Read-only** — a tool is advertised only if its name begins with a read verb
  (``READ_ONLY_VERBS``); anything else (create/update/delete/…) is default-denied,
  both at advertise time and again at call time.
* **Namespaced** — advertised as ``mcp__<server>__<tool>`` so MCP names can never
  shadow a built-in tool, and the harness can route by prefix.
* **Bounded / untrusted** — results are treated as untrusted corpus text by the
  caller (masked + capped like web_fetch); args come only from the model.

The HTTP transport is an injected callable (``post_fn``) so the whole module is
unit-testable against a scripted MCP server with no network — mirroring
``forgejo_backend``'s ``_curl``-patch pattern.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from typing import Any, Callable

MCP_PREFIX = "mcp__"
_PROTOCOL_VERSION = "2024-11-05"

# A tool is relayed only when its name starts with one of these read verbs.
# Default-deny: an unrecognised verb (create/update/delete/set/run/exec/…) is
# never advertised or called, even if the server lists it.
READ_ONLY_VERBS = frozenset(
    {"list", "get", "read", "search", "fetch", "describe", "show", "find",
     "lookup", "query", "head", "stat", "summary", "diff", "status", "view"}
)


def is_read_only_tool(name: str) -> bool:
    """True if a tool name begins with an allowlisted read verb."""
    if not isinstance(name, str) or not name:
        return False
    head = name.strip().lower().replace("-", "_").split("_", 1)[0]
    return head in READ_ONLY_VERBS


def namespaced_name(server: str, tool: str) -> str:
    return f"{MCP_PREFIX}{server}__{tool}"


def split_namespaced(name: str) -> tuple[str, str] | None:
    """``mcp__server__tool`` → ``(server, tool)``; None if not MCP-namespaced."""
    if not name.startswith(MCP_PREFIX):
        return None
    rest = name[len(MCP_PREFIX):]
    server, sep, tool = rest.partition("__")
    if not sep or not server or not tool:
        return None
    return server, tool


def _default_post(url, payload, session_id, token, timeout):
    """POST one JSON-RPC message; return (result_dict_or_None, session_id, error).

    Handles a plain ``application/json`` body or an SSE (``text/event-stream``)
    framing — MCP streamable-HTTP may use either. The session id is read from
    the ``Mcp-Session-Id`` response header (set on initialize).
    """
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": "ai-pr-reviewer/1.0",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            new_session = resp.headers.get("Mcp-Session-Id") or session_id
            body = resp.read().decode("utf-8", errors="replace")
    except Exception as exc:  # noqa: BLE001 — surfaced to the caller as an error
        return None, session_id, str(exc)
    return _parse_jsonrpc(body), new_session, None


def _parse_jsonrpc(body: str):
    """Extract the JSON-RPC object from a plain or SSE-framed body."""
    text = body.strip()
    if not text:
        return None
    # SSE framing: pull the last `data:` line (the response message).
    if "data:" in text and not text.startswith("{"):
        for line in reversed(text.splitlines()):
            line = line.strip()
            if line.startswith("data:"):
                text = line[len("data:"):].strip()
                break
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None


class McpToolset:
    """An initialized connection to one allowlisted MCP server."""

    def __init__(self, server: str, url: str, token: str = "", *, timeout: int = 20,
                 post_fn: Callable | None = None):
        self.server = server
        self.url = url
        self.token = token
        self.timeout = timeout
        # Runtime lookup of the default so tests can monkeypatch _default_post.
        self._post = post_fn or _default_post
        self._session_id: str | None = None
        self.schemas: list[dict[str, Any]] = []
        self._tool_names: set[str] = set()

    def _rpc(self, method, params=None, *, msg_id=None):
        payload = {"jsonrpc": "2.0", "method": method}
        if msg_id is not None:
            payload["id"] = msg_id
        if params is not None:
            payload["params"] = params
        result, self._session_id, error = self._post(
            self.url, payload, self._session_id, self.token, self.timeout
        )
        return result, error

    def connect(self) -> str | None:
        """initialize → tools/list → build namespaced read-only schemas.

        Returns None on success, or an error string (the server is then skipped).
        """
        init, error = self._rpc(
            "initialize",
            {"protocolVersion": _PROTOCOL_VERSION, "capabilities": {},
             "clientInfo": {"name": "ai-pr-reviewer", "version": "1.0"}},
            msg_id=1,
        )
        if error or not isinstance(init, dict) or "result" not in init:
            return f"initialize failed: {error or 'no result'}"
        # Best-effort initialized notification (no id, no response expected).
        self._rpc("notifications/initialized")

        listed, error = self._rpc("tools/list", {}, msg_id=2)
        if error or not isinstance(listed, dict):
            return f"tools/list failed: {error or 'no result'}"
        tools = (listed.get("result") or {}).get("tools")
        if not isinstance(tools, list):
            return "tools/list returned no tools array"

        for tool in tools:
            if not isinstance(tool, dict):
                continue
            name = tool.get("name")
            if not isinstance(name, str) or not is_read_only_tool(name):
                continue  # default-deny non-read-verb tools
            schema = tool.get("inputSchema")
            if not isinstance(schema, dict):
                schema = {"type": "object", "properties": {}, "additionalProperties": True}
            self._tool_names.add(name)
            self.schemas.append({
                "name": namespaced_name(self.server, name),
                "description": (
                    f"[MCP:{self.server}] {tool.get('description') or name} "
                    "(read-only external evidence)"
                ),
                "parameters": schema,
            })
        return None

    def call(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        """Call a relayed read-only tool; returns the executor result shape.

        Re-checks the read-only allowlist at call time (defence in depth) and
        refuses any tool not surfaced by connect().
        """
        if tool not in self._tool_names or not is_read_only_tool(tool):
            return {"error": f"MCP tool not allowed: {tool}"}
        result, error = self._rpc(
            "tools/call", {"name": tool, "arguments": args or {}}, msg_id=3
        )
        if error:
            return {"error": f"MCP call failed: {error}"}
        if not isinstance(result, dict) or "result" not in result:
            rpc_err = (result or {}).get("error") if isinstance(result, dict) else None
            return {"error": f"MCP error: {rpc_err or 'no result'}"}
        return {"content": _render_content(result["result"])}


def _render_content(result: Any) -> str:
    """Flatten an MCP tools/call result into plain text for the corpus."""
    if isinstance(result, dict):
        blocks = result.get("content")
        if isinstance(blocks, list):
            parts = []
            for block in blocks:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    parts.append(block["text"])
            if parts:
                return "\n".join(parts)
    return json.dumps(result, ensure_ascii=False)


def is_safe_server_url(url: str) -> bool:
    """Only http(s) URLs with a host reach urlopen.

    The URL is operator-set (not model/PR-controlled), but validating the scheme
    is cheap defence-in-depth against a misconfigured ``tool_mcp_servers`` value
    becoming an SSRF/LFI vector (file://, gopher://, …). HTTPS is recommended;
    plain http is permitted for internal/cluster MCP servers.
    """
    # Raw control characters / null bytes are never legitimate in a URL and
    # signal corruption or injection; reject them up front (a NUL also raises
    # later at the socket layer). Percent-encoded sequences (%00, %2f, …) are
    # valid URL encoding and are left intact — they ride in the HTTP path to the
    # remote server, not a local file read, so they are not an LFI vector here.
    if any(ord(ch) < 0x20 or ord(ch) == 0x7f for ch in url):
        return False
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return False
    return parsed.scheme in ("http", "https") and bool(parsed.hostname)


def parse_server_specs(raw: str) -> list[tuple[str, str]]:
    """Parse ``tool_mcp_servers`` (newline/comma list of ``name=url``).

    Entries that are malformed or whose URL is not a host-bearing http(s) URL
    are silently dropped (see :func:`is_safe_server_url`)."""
    specs: list[tuple[str, str]] = []
    if not raw:
        return specs
    for item in raw.replace("\n", ",").split(","):
        item = item.strip()
        if not item or "=" not in item:
            continue
        name, _, url = item.partition("=")
        name, url = name.strip(), url.strip()
        if name and url and is_safe_server_url(url):
            specs.append((name, url))
    return specs
