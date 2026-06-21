#!/usr/bin/env python3
"""Read-only tool executors for the tool harness (#304 split).

The model-plannable tools (read_file, git_*, gh_api, web_fetch, web_search,
run_command) plus the path/host guards and result-shaping helpers they need.
Split out of scripts/run_tool_harness.py with no behaviour change.
"""

import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# mask_secrets lives in scripts/redact.py; ensure scripts/ is importable.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from redact import mask_and_truncate, mask_secrets  # noqa: E402

# The gh_api allowlist + denied path segments live on the platform seam (single
# source of truth); _resolve_workspace_path reuses GH_DENY_SUBSTRINGS to block
# the same sensitive segments in filesystem paths.
from pr_reviewer.platform import GH_DENY_SUBSTRINGS  # noqa: E402


SENSITIVE_PATH_RE = re.compile(
    r"(^|/)(\.env(\.|$)|id_rsa(\.|$)|id_dsa(\.|$)|credentials(\.|$)|secret(s)?(\.|$)|.*\.pem$|.*\.key$)",
    re.IGNORECASE,
)

# The tool harness executes same-repo code, so command execution must not be
# model-controlled shell text. Keep commands as named, argv-only definitions.
# Additions here should be read-only and safe to run against untrusted PR input.
ALLOWED_COMMANDS = {
    "git_status_short": ["git", "status", "--short"],
    "git_diff_stat": ["git", "diff", "--stat", "HEAD"],
    "git_diff_name_only": ["git", "diff", "--name-only", "HEAD"],
}

def command_catalog_markdown():
    return ", ".join(sorted(ALLOWED_COMMANDS))

def _opt_int(value):
    """Coerce an optional tool arg to int, tolerating model string/None forms."""
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None

def normalize_host(host):
    return (host or "").strip().lower()

def allowlisted_host(host, allowlist):
    candidate = normalize_host(host)
    for item in allowlist:
        if candidate == item:
            return True
    return False

def fetch_url(url, allowed_hosts, request_timeout=25):
    """Fetch a URL and return its text content (or None on failure)."""
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""

    if not allowlisted_host(host, allowed_hosts):
        return None

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "ai-pr-reviewer/1.0"},
        )
        with urllib.request.urlopen(req, timeout=request_timeout) as resp:
            raw = resp.read()
            text = raw.decode("utf-8", errors="replace")
            return text[:5000]
    except Exception:
        return None

def _resolve_workspace_path(path, workspace_root):
    """Resolve a workspace-relative path with traversal/symlink/sensitive guards.

    Returns ``(resolved_Path, None)`` on success or ``(None, error_str)``.
    Shared by read_file, git_log, and git_blame so they enforce the identical
    containment + sensitive-file policy — git_blame in particular renders file
    *content*, so it must honour the same .env/.pem/credentials blocks.
    """
    # Reject embedded null bytes before touching the filesystem: pathlib raises
    # ValueError (not OSError) on them, and a NUL can truncate the path at the C
    # layer of an underlying syscall, so an early explicit reject is safest.
    if "\x00" in path:
        return None, "Null byte in path"

    root = Path(workspace_root).resolve()
    try:
        # resolve() also collapses symlinks, so a symlink that lives inside the
        # workspace but points outside it is normalised to its real target and
        # caught by the containment check below.
        resolved = (root / path).resolve()
    except (OSError, ValueError):
        return None, f"Cannot resolve path: {path}"

    # Containment via is_relative_to, NOT str.startswith: startswith wrongly
    # accepts a sibling directory whose name shares the workspace as a prefix
    # (e.g. resolving to /work/repo2 passes a /work/repo prefix test).
    if not resolved.is_relative_to(root):
        return None, "Path escapes workspace root"

    if SENSITIVE_PATH_RE.search(resolved.name):
        return None, f"Sensitive file blocked: {resolved.name}"

    for deny in GH_DENY_SUBSTRINGS:
        if deny in str(resolved):
            return None, f"Path denied: {deny}"

    return resolved, None

def read_file(path, workspace_root, offset=None, limit=None):
    """Read a file, optionally a 1-based line window, with path protection.

    ``offset``/``limit`` let the model read a slice of a large file without
    blowing the response cap — and cover diff-context expansion ("show me N
    lines around this hunk") without a separate tool.
    """
    resolved, err = _resolve_workspace_path(path, workspace_root)
    if err:
        return {"error": err}

    try:
        content = resolved.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        return {"error": str(exc)}

    if offset is None and limit is None:
        return {"content": content[:12000]}

    lines = content.splitlines(keepends=True)
    start = max((offset or 1) - 1, 0)
    end = start + limit if limit is not None else len(lines)
    window = "".join(lines[start:end])
    return {
        "content": window[:12000],
        "range": {"offset": start + 1, "lines": len(lines[start:end]), "total_lines": len(lines)},
    }

def git_grep(pattern, workspace_root, request_timeout=15):
    """Run git grep and return matched lines."""
    try:
        result = subprocess.run(
            ["git", "grep", "-n", "--", pattern, "."],
            cwd=workspace_root,
            capture_output=True,
            text=True,
            timeout=request_timeout,
        )
        if result.returncode not in (0, 1):
            return {"error": f"git grep failed: {result.stderr.strip()}"}
        lines = result.stdout.strip().splitlines()[:60]
        return {"matches": lines}
    except subprocess.TimeoutExpired:
        return {"error": f"git grep timed out after {request_timeout}s"}
    except Exception as exc:
        return {"error": str(exc)}

def git_log(path, workspace_root, max_count=20, request_timeout=15):
    """Read-only recent commit history (oneline), optionally scoped to a path.

    No patch (`-p`) — subjects/metadata only, not file content. A path is run
    as a ``-- <path>`` pathspec so it can't be read as a flag, and git keeps it
    inside the repo regardless; the sensitive/containment guard is applied for
    consistency with the content-bearing tools.
    """
    args = [
        "git", "log", f"-n{max_count}", "--no-color",
        "--date=short", "--pretty=format:%h %ad %an %s",
    ]
    if path:
        resolved, err = _resolve_workspace_path(path, workspace_root)
        if err:
            return {"error": err}
        args += ["--", str(resolved)]
    try:
        result = subprocess.run(
            args, cwd=workspace_root, capture_output=True, text=True, timeout=request_timeout
        )
        if result.returncode != 0:
            return {"error": f"git log failed: {result.stderr.strip()}"}
        return {"log": result.stdout.strip().splitlines()[:max_count]}
    except subprocess.TimeoutExpired:
        return {"error": f"git log timed out after {request_timeout}s"}
    except Exception as exc:
        return {"error": str(exc)}

def git_blame(path, workspace_root, start=None, end=None, request_timeout=15):
    """Read-only line-level authorship for a tracked file (optional L range).

    git blame renders file *content*, so the sensitive/containment guard is
    mandatory — a committed .env/.pem must not be readable through blame.
    """
    resolved, err = _resolve_workspace_path(path, workspace_root)
    if err:
        return {"error": err}
    args = ["git", "blame", "-w"]
    if start is not None and end is not None:
        args += ["-L", f"{int(start)},{int(end)}"]
    args += ["--", str(resolved)]
    try:
        result = subprocess.run(
            args, cwd=workspace_root, capture_output=True, text=True, timeout=request_timeout
        )
        if result.returncode != 0:
            return {"error": f"git blame failed: {result.stderr.strip()}"}
        return {"blame": result.stdout}
    except subprocess.TimeoutExpired:
        return {"error": f"git blame timed out after {request_timeout}s"}
    except (ValueError, Exception) as exc:  # int() on a bad range → clean error
        return {"error": str(exc)}

def gh_api(endpoint, allowed_repos, current_repo, request_timeout=25):
    """Make a host-platform API call with path/endpoint restrictions.

    Thin shim over :func:`pr_reviewer.platform.gh_api` so the gh_api tool
    routes through the platform seam (#226). The seam owns the allowlist
    (path traversal, repo key, denied substrings) and the per-backend
    transport; this shim exists only for backward compatibility with
    call sites that import the function from this module.
    """
    # Imported lazily so this module can still be loaded when the
    # platform seam is unavailable (e.g. in a script-only test that
    # doesn't add the package to sys.path).
    from pr_reviewer.platform import gh_api as _platform_gh_api
    return _platform_gh_api(endpoint, allowed_repos, current_repo, request_timeout)

def web_fetch(url, allowed_hosts, request_timeout=25):
    """Fetch a URL using the same host-allowlist logic."""
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""

    if not allowlisted_host(host, allowed_hosts):
        return {"error": f"Host not allowlisted: {host}"}

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "ai-pr-reviewer/1.0"},
        )
        with urllib.request.urlopen(req, timeout=request_timeout) as resp:
            raw = resp.read()
            text = raw.decode("utf-8", errors="replace")
            return {"content": text[:10000]}
    except Exception as exc:
        return {"error": str(exc)}

def web_search(query, search_url, request_timeout=20, max_results=5):
    """Query a configured search engine (SearXNG JSON API) for a free-text query.

    ``search_url`` is the engine's search endpoint (e.g.
    ``https://search.example.com/search``); the query and ``format=json`` are
    appended. Returns ``{"results": [{title, url, snippet}], ...}`` capped at
    ``max_results``, or ``{"error": ...}``. The endpoint is a single trusted,
    operator-configured URL — unlike web_fetch it is not host-allowlisted,
    because the model supplies only the query string, never the host.
    """
    if not search_url:
        return {"error": "Search is not configured (no search_url)."}
    sep = "&" if urllib.parse.urlparse(search_url).query else "?"
    full = f"{search_url}{sep}" + urllib.parse.urlencode({"q": query, "format": "json"})
    try:
        req = urllib.request.Request(
            full,
            headers={"User-Agent": "ai-pr-reviewer/1.0", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=request_timeout) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception as exc:
        return {"error": str(exc)}

    results = []
    for item in (data.get("results") or [])[:max_results]:
        if not isinstance(item, dict):
            continue
        results.append({
            "title": str(item.get("title", ""))[:300],
            "url": str(item.get("url", "")),
            "snippet": str(item.get("content", ""))[:500],
        })
    return {"results": results}

def run_command(command, workspace_root, request_timeout=30):
    """Execute a named read-only command definition.

    The planner may choose only command names from ALLOWED_COMMANDS. Raw shell
    text is intentionally rejected so untrusted PR/corpus content cannot shape
    a bash command line.
    """
    command_name = (command or "").strip()
    args = ALLOWED_COMMANDS.get(command_name)
    if args is None:
        return {
            "error": (
                "Command not allowlisted. Use one of: "
                + command_catalog_markdown()
            )
        }

    try:
        result = subprocess.run(
            args,
            cwd=workspace_root,
            capture_output=True,
            text=True,
            timeout=request_timeout,
        )
        return {
            "stdout": mask_secrets((result.stdout or "").strip()),
            "stderr": mask_secrets((result.stderr or "").strip()),
            "exit_code": result.returncode,
            "command": command_name,
        }
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")
        return {
            "error": f"Command timed out after {request_timeout}s",
            "stdout": mask_secrets(stdout),
            "stderr": mask_secrets(stderr),
            "command": command_name,
        }

def execute_tool_request(
    tool_name,
    args,
    workspace_root,
    allowed_gh_repos,
    current_repo,
    allowed_hosts,
    max_response_bytes,
    request_timeout,
    search_url="",
    max_search_results=5,
):
    """Execute a single tool request and return the result dict.

    Shared by both file-based and direct planning paths to avoid duplication
    of validation, execution, truncation, and error-handling logic.
    """
    tool_result = {"tool": tool_name, "status": "error", "result": {}}

    try:
        if tool_name == "read_file":
            path = args.get("path", "")
            if not path:
                raise ValueError("Missing 'path' argument")
            res = read_file(
                path, workspace_root, _opt_int(args.get("offset")), _opt_int(args.get("limit"))
            )
            if res.get("error"):
                raise ValueError(res["error"])
            text = mask_secrets(res.get("content", ""))
            text, _ = mask_and_truncate(text, max_response_bytes)
            result_payload = {"content": text}
            if res.get("range"):
                result_payload["range"] = res["range"]
            tool_result["result"] = result_payload

        elif tool_name == "git_log":
            max_count = max(1, min(_opt_int(args.get("max_count")) or 20, 100))
            res = git_log(
                args.get("path", "") or "", workspace_root, max_count, request_timeout
            )
            if res.get("error"):
                raise ValueError(res["error"])
            text, _ = mask_and_truncate("\n".join(res.get("log", [])), max_response_bytes)
            tool_result["result"] = {"log": text}

        elif tool_name == "git_blame":
            path = args.get("path", "")
            if not path:
                raise ValueError("Missing 'path' argument")
            res = git_blame(
                path, workspace_root,
                _opt_int(args.get("start")), _opt_int(args.get("end")), request_timeout,
            )
            if res.get("error"):
                raise ValueError(res["error"])
            text, _ = mask_and_truncate(res.get("blame", ""), max_response_bytes)
            tool_result["result"] = {"blame": text}

        elif tool_name == "git_grep":
            pattern = args.get("pattern", "")
            if not pattern:
                raise ValueError("Missing 'pattern' argument")
            res = git_grep(pattern, workspace_root, request_timeout)
            if res.get("error"):
                raise ValueError(res["error"])
            matches = res.get("matches", [])
            text = "\n".join(matches)
            text, _ = mask_and_truncate(text, max_response_bytes)
            tool_result["result"] = {"matches": matches[:60]}

        elif tool_name == "gh_api":
            endpoint = args.get("endpoint", "")
            if not endpoint:
                raise ValueError("Missing 'endpoint' argument")
            res = gh_api(endpoint, allowed_gh_repos, current_repo, request_timeout)
            if res.get("error"):
                raise ValueError(res["error"])
            data = res.get("data")
            text = ""
            if isinstance(data, (dict, list)):
                # Compact JSON: the model re-prefills tool results on every loop
                # round, so indent whitespace is pure repeated prefill cost — and
                # compacting fits ~25% more real data under max_response_bytes.
                text = json.dumps(data, separators=(",", ":"))[:max_response_bytes]
            tool_result["result"] = {"response": text}

        elif tool_name == "web_fetch":
            url = args.get("url", "")
            if not url:
                raise ValueError("Missing 'url' argument")
            res = web_fetch(url, allowed_hosts, request_timeout)
            if res.get("error"):
                raise ValueError(res["error"])
            content_text = res.get("content", "")
            text, _ = mask_and_truncate(content_text, max_response_bytes)
            tool_result["result"] = {"content": text}

        elif tool_name == "web_search":
            query = args.get("query", "")
            if not query:
                raise ValueError("Missing 'query' argument")
            res = web_search(query, search_url, request_timeout, max_search_results)
            if res.get("error"):
                raise ValueError(res["error"])
            text = json.dumps(res.get("results", []), separators=(",", ":"))
            text, _ = mask_and_truncate(text, max_response_bytes)
            tool_result["result"] = {"results": text}

        elif tool_name == "run_command":
            command = args.get("command", "")
            if not command:
                raise ValueError("Missing 'command' argument")
            res = run_command(command, workspace_root, request_timeout)
            if res.get("error"):
                raise ValueError(res["error"])
            stdout_text = res.get("stdout", "")
            stderr_text = res.get("stderr", "")
            stdout_text, _ = mask_and_truncate(stdout_text, max_response_bytes)
            stderr_text, _ = mask_and_truncate(stderr_text, max_response_bytes)
            tool_result["result"] = {
                "stdout": stdout_text,
                "stderr": stderr_text,
                "exit_code": res.get("exit_code"),
                "command": res.get("command"),
            }

        else:
            raise ValueError(f"Unknown tool: {tool_name}")

        tool_result["status"] = "ok"
    except Exception as exc:
        # Error messages from raised ValueError (from res["error"] checks
        # above) are masked by mask_secrets() in write_outputs(), which
        # processes the markdown output. This is consistent with how
        # run_command error messages are redacted.
        tool_result["result"] = {"error": str(exc)}

    return tool_result

def execute_tool_requests(
    normalized_requests,
    workspace_root,
    allowed_gh_repos,
    current_repo,
    allowed_hosts,
    max_response_bytes,
    request_timeout,
):
    """Execute normalized (tool_name, args) requests concurrently.

    Tools are read-only, so they are safe to run in parallel; results are
    returned in request order so the markdown/JSON output stays deterministic.
    """
    if not normalized_requests:
        return []

    def _run(pair):
        tool_name, args = pair
        return execute_tool_request(
            tool_name,
            args,
            workspace_root,
            allowed_gh_repos,
            current_repo,
            allowed_hosts,
            max_response_bytes,
            request_timeout,
        )

    if len(normalized_requests) == 1:
        return [_run(normalized_requests[0])]

    with ThreadPoolExecutor(
        max_workers=min(4, len(normalized_requests))
    ) as executor:
        return list(executor.map(_run, normalized_requests))
