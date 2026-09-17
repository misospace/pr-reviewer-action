#!/usr/bin/env python3
"""Read-only tool executors for the tool harness (#304 split).

The model-plannable tools (read_file, git_*, gh_api, web_fetch, web_search,
run_command) plus the path/host guards and result-shaping helpers they need.
Split out of scripts/run_tool_harness.py with no behaviour change.
"""

import fnmatch
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# mask_secrets lives in scripts/redact.py; ensure scripts/ is importable.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from redact import mask_and_truncate, mask_secrets  # noqa: E402

# The gh_api allowlist + denied path segments live on the platform seam (single
# source of truth); _resolve_workspace_path reuses GH_DENY_SUBSTRINGS to block
# the same sensitive segments in filesystem paths.
from pr_reviewer.platform import (  # noqa: E402
    GH_DENY_SUBSTRINGS,
    SENSITIVE_PATH_RE,
    USER_AGENT,
    repo_contents as platform_repo_contents,
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
        norm = normalize_host(item)
        # "'*'" is an allow-all wildcard, consistent with the gh_api repo
        # allowlist in platform.py — so operators can set
        # allowed_source_hosts: "*" and actually permit any host (previously
        # the exact-match loop silently matched nothing, blocking every fetch).
        if norm == "*" or candidate == norm:
            return True
    return False

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

    if SENSITIVE_PATH_RE.search(str(resolved)):
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

# find_files result cap: the default the model gets when it omits max_results,
# and the hard ceiling a model-supplied value is clamped to (the issue asks for
# a "safe maximum such as 300").
FIND_FILES_DEFAULT_MAX = 100
FIND_FILES_MAX_CAP = 300


def find_files(pattern, workspace_root, path=".", max_results=FIND_FILES_DEFAULT_MAX):
    """Locate repository files by filename/path pattern (read-only, #567).

    ``list_tree`` answers "what is around here?"; this answers "where is the
    config loader / auth middleware / matching test / package manifest?" in a
    single call. It is a filename/path discovery primitive, not semantic code
    search (``git_grep`` covers content search).

    Matching contract (deliberately small and pinned by tests):

    * ``pattern`` is a glob-style pattern matched with ``fnmatch.fnmatchcase``
      (case-sensitive, no shell involved) against BOTH the repo-relative path
      (``/``-separated) and the basename. A pattern containing ``/`` therefore
      matches the relative path (e.g. ``*/route.ts``); a bare pattern matches
      the basename anywhere in the tree (e.g. ``*config*``, ``*.toml``).
    * ``path`` is an optional workspace-relative directory to scope the search
      to; it defaults to the repository root.
    * ``max_results`` defaults to 100 and is clamped to 1..300.
    * Results are repo-relative file paths only (directories are omitted —
      ``list_tree`` covers directory discovery), sorted, and capped.
    * The walk never descends into ``.git`` and never follows symlinked
      directories, so it cannot escape the workspace.

    Returns ``{"files": [...], "total": N, "truncated": bool}`` (empty list
    when nothing matches) or ``{"error": ...}`` for a bad ``path``.
    """
    if not pattern or not isinstance(pattern, str):
        return {"error": "Missing 'pattern' argument"}

    # Reuse the shared containment guard (null-byte, traversal, symlink,
    # sensitive-file, deny-substring) so find_files enforces the identical
    # boundaries as read_file rather than a second containment implementation.
    resolved_root, err = _resolve_workspace_path(path, workspace_root)
    if err:
        return {"error": err}
    if not resolved_root.is_dir():
        return {"error": f"Path is not a directory: {path}"}

    # Pruning child .git directories is insufficient when the requested root
    # itself is inside Git metadata; reject that scope before walking it.
    root = Path(workspace_root).resolve()
    if ".git" in resolved_root.relative_to(root).parts:
        return {"error": "Path inside .git is not searchable"}

    # Clamp the model-supplied cap into the safe range.
    try:
        cap = int(max_results)
    except (TypeError, ValueError):
        cap = FIND_FILES_DEFAULT_MAX
    cap = max(1, min(cap, FIND_FILES_MAX_CAP))

    matches: list[str] = []
    # followlinks=False: a symlinked directory (even one pointing outside the
    # workspace) is never descended into, so the walk cannot escape.
    for dirpath, dirnames, filenames in os.walk(resolved_root, followlinks=False):
        # Never descend into .git at any depth (deterministic + bounded).
        dirnames[:] = [d for d in dirnames if d != ".git"]
        for name in filenames:
            full = Path(dirpath) / name
            # Skip symlinks entirely (a symlinked file could point outside the
            # workspace); only regular files are reported.
            if full.is_symlink():
                continue
            rel = full.relative_to(root).as_posix()
            if fnmatch.fnmatchcase(rel, pattern) or fnmatch.fnmatchcase(name, pattern):
                matches.append(rel)

    # Sort BEFORE applying the cap. os.walk yields files in filesystem
    # enumeration order, which is nondeterministic across platforms and runs,
    # so breaking out of the walk at `cap` would return whichever matches
    # happened to be enumerated first rather than a stable result set.
    # Sorting the complete match list first and then taking the head makes the
    # returned window the lexicographic head of ALL matches — identical on
    # every run.
    matches.sort()
    total = len(matches)
    files = matches[:cap]
    return {
        "files": files,
        "total": len(files),
        "truncated": total > cap,
    }

def list_tree(path, workspace_root, depth=2, max_entries=200):
    """List repository entries (names only) bounded by depth and entry count.

    ``list_tree`` answers "what is around here?"; ``find_files`` answers
    "where is the config loader / auth middleware / matching test?". It is a
    structural discovery primitive, not content search (``git_grep`` covers
    that).

    ``path`` is the workspace-relative directory to start from (defaults to
    the workspace root). The walk is top-down: entries at each level are
    emitted in sorted name order, directories are recursed into in that
    same order, and both the depth cap and the entry cap are enforced as
    entries are generated (pre-order) — so an oversized tree returns a
    deterministic, sorted, *prefix* of the full listing instead of buffering
    everything first. This keeps output size bounded and byte-stable across
    runs (tests, prompt caching, and repeated reviews all see identical
    bytes).

    Matching contract (deliberately small and pinned by tests):

    * ``path`` is an optional workspace-relative directory to scope the walk
      to; it defaults to the repository root. A file passed as ``path``
      returns a one-row listing for that file (not an error).
    * ``depth`` defaults to 2 and is clamped to 1..4. ``depth=1`` shows only
      the direct children of ``path``; ``depth=2`` adds their children, and
      so on.
    * ``max_entries`` defaults to 200 and is clamped to 1..500.
    * Results are repo-relative ``{path, type}`` rows (``type`` is ``"file"``
      or ``"dir"``), sorted pre-order, capped at ``max_entries``, with a
      ``truncated`` flag when more entries existed. ``total`` is the number
      of entries actually returned (mirrors ``find_files``).
    * The walk never descends into ``.git`` and never follows symlinked
      directories, so it cannot escape the workspace. Symlinks (both files
      and directories) are skipped — consistent with ``find_files``, so a
      symlink pointing outside the workspace cannot be traversed or listed.

    Security model (this tool is part of the prompt-injection boundary —
    untrusted PR content can shape the arguments the model emits):

    * ``path`` goes through the same :func:`_resolve_workspace_path` guard
      as ``read_file``: null bytes, escapes outside the workspace root, and
      sensitive path patterns are all rejected before any filesystem access.
    * ``.git`` is never traversed (and a path inside ``.git`` is rejected
      outright, consistent with ``find_files``).
    * Symlinks (both files and directories) are skipped entirely — never
      followed and never listed, so a symlink pointing outside the
      workspace cannot be traversed or listed.
    * Only names and ``file``/``dir`` types are returned — never contents.

    Returns ``{"entries": [{path, type}], "total": N, "truncated": bool}`` where
    ``path`` is the repo-relative POSIX path, or ``{"error": ...}``.
    """
    if isinstance(path, str) and path:
        rel_path = path
    elif path is None or path == "":
        rel_path = "."
    else:
        return {"error": "Invalid path"}

    # Same containment + sensitive-file policy as read_file/git_log/git_blame.
    resolved, err = _resolve_workspace_path(rel_path, workspace_root)
    if err:
        return {"error": err}

    root = Path(workspace_root).resolve()
    if not resolved.exists():
        return {"error": f"Path not found: {rel_path}"}

    # Pruning child .git directories is insufficient when the requested root
    # itself is inside Git metadata; reject that scope before walking it.
    if ".git" in resolved.relative_to(root).parts:
        return {"error": "Path inside .git is not listable"}

    # Distinguish "unset" (None → the default) from an explicit out-of-range
    # value (0 → clamped to the low bound), mirroring find_files' clamping.
    # _opt_int is used for model string tolerance (e.g. depth="2" or "junk").
    try:
        raw_depth = _opt_int(depth)
        if raw_depth is None:
            raw_depth = 2
        depth = max(1, min(raw_depth, 4))
        raw_cap = _opt_int(max_entries)
        if raw_cap is None:
            raw_cap = 200
        cap = max(1, min(raw_cap, 500))
    except Exception:
        return {"error": "Invalid depth or max_entries"}

    if not resolved.is_dir():
        # A file is a valid single-row listing, consistent with read_file's
        # behaviour of reading the file rather than erroring on a file path.
        return {
            "entries": [
                {
                    "path": resolved.relative_to(root).as_posix(),
                    "type": "file",
                }
            ],
            "total": 1,
            "truncated": False,
        }

    entries = []
    truncated = False

    def rel(d: Path) -> str:
        if d == resolved:
            return "."
        return d.relative_to(root).as_posix()

    def walk(directory: Path, level: int) -> None:
        nonlocal truncated
        if level > depth:
            return
        try:
            children = sorted(directory.iterdir(), key=lambda p: p.name)
        except OSError:
            return
        for child in children:
            if len(entries) >= cap:
                truncated = True
                return
            name = child.name
            # .git internals are never exposed through traversal.
            if name == ".git":
                continue
            # Symlinks (both files and directories) are skipped entirely —
            # consistent with find_files, so a symlink pointing outside the
            # workspace cannot be traversed or listed.
            if child.is_symlink():
                continue
            is_dir = child.is_dir()
            child_type = "dir" if is_dir else "file"
            entries.append({"path": rel(child), "type": child_type})
            if is_dir:
                walk(child, level + 1)

    walk(resolved, 1)
    return {"entries": entries, "total": len(entries), "truncated": truncated}


# Result-cap bounds for git_grep (issue #568). The default (60) is the
# historical cap so callers that don't pass max_results are behaviour-
# compatible; the upper bound keeps any single tool response bounded before
# it reaches the model (a weak model can ask for "10000" without blowing the
# response budget).
GIT_GREP_DEFAULT_MAX_RESULTS = 60
GIT_GREP_MAX_RESULTS_LIMIT = 200


def clamp_grep_max_results(value, default=GIT_GREP_DEFAULT_MAX_RESULTS):
    """Clamp an optional max_results arg to ``[1, GIT_GREP_MAX_RESULTS_LIMIT]``.

    ``None`` (argument absent) and non-integer values both fall back to the
    default so a malformed model value degrades to the historical behaviour
    rather than failing the call.
    """
    n = _opt_int(value)
    if n is None:
        return default
    return max(1, min(n, GIT_GREP_MAX_RESULTS_LIMIT))


def _grep_pathspec(resolved, workspace_root):
    """Turn a resolved path into a git pathspec string.

    Prefer a repo-relative pathspec (shorter, and what the model would name);
    fall back to the absolute path only when the workspace root is itself a
    symlink and no longer normalises to its target.
    """
    root = Path(workspace_root).resolve()
    try:
        rel = resolved.relative_to(root).as_posix()
    except ValueError:
        rel = ""
    return rel or "."


# ``git grep -z`` text records: ``path\0lineno\0content\n``. The two NUL
# separators make the filename parseable even when it contains a colon;
# content is the third field (NUL-free, because git treats NUL-containing
# files as binary and emits no content for them) and is terminated by a
# newline. Binary matches emit ``Binary file X matches\n`` (no NUL at all).
_GREP_Z_MATCH_RE = re.compile(r"^Binary file (.*) matches$")


def _parse_grep_z_records(stdout):
    """Consume a raw ``git grep -z`` stream into match records.

    A text record is ``path\\0lineno\\0content\\n``: the first NUL ends the
    path, the second ends the line number, and the record ends at the
    newline that terminates the content. Newlines are NOT record boundaries
    — a path may itself contain a newline — so records are located by
    locating the first and second NULs first. A binary match (``Binary file
    X matches\\n``) carries no NUL and no content; it is kept whole for
    the redaction pass.

    Returns a list of tuples: ``("text", path, lineno, content)`` for text
    matches and ``("binary", line)`` for binary matches.
    """
    records = []
    i, n = 0, len(stdout)
    while i < n:
        # Binary output carries no NUL. Recognize and consume it before
        # scanning for a later text record's NUL pair.
        if stdout.startswith("Binary file ", i):
            newline = stdout.find("\n", i)
            binary_line = stdout[i:newline if newline != -1 else n]
            if _GREP_Z_MATCH_RE.match(binary_line):
                records.append(("binary", binary_line))
                i = n if newline == -1 else newline + 1
                continue
        nul1 = stdout.find("\0", i)
        nul2 = stdout.find("\0", nul1 + 1) if nul1 != -1 else -1
        if nul2 == -1:
            # Malformed trailing output cannot be safely attributed to a path.
            # Keep it as a binary-style record so the redaction pass fails
            # closed if it resembles a sensitive binary-match name.
            newline = stdout.find("\n", i)
            records.append(("binary", stdout[i:newline if newline != -1 else n]))
            i = n if newline == -1 else newline + 1
            continue
        newline = stdout.find("\n", nul2 + 1)
        if newline == -1:
            newline = n
        records.append(("text", stdout[i:nul1], stdout[nul1 + 1:nul2], stdout[nul2 + 1:newline]))
        i = newline + 1
    return records


def _redact_grep_record(rec, workspace_root):
    """Redact a record parsed from ``git grep -z`` output.

    ``_resolve_workspace_path`` only guards the scope the model *asked for*;
    a broad scope (no path, or path=".") can still match a tracked
    ``.env``/``.pem`` descendant. A parsed record's path is recovered
    unambiguously (even a colon or a newline in the path can't fool it) and
    re-checked against the same sensitive-path policy read_file enforces;
    sensitive content is replaced with a marker while the ``path:lineno``
    provenance stays visible.

    Binary-match records (``("binary", line)``) carry no content, only a
    name; a sensitive name is masked the same way so even existence is not
    echoed.
    """
    kind = rec[0]
    if kind == "binary":
        line = rec[1]
        m = _GREP_Z_MATCH_RE.match(line)
        if m:
            _resolved, err = _resolve_workspace_path(m.group(1), workspace_root)
            if err:
                return "[redacted: sensitive path]"
        return line
    _, path, lineno, content = rec
    _resolved, err = _resolve_workspace_path(path, workspace_root)
    if err is None:
        # Normalise back to the documented ``file:lineno:content`` format.
        return f"{path}:{lineno}:{content}"
    return f"{path}:{lineno}:[redacted: sensitive path]"


def git_grep(pattern, workspace_root, request_timeout=15, path=None, max_results=None):
    """Run git grep and return matched lines as ``file:lineno:content``.

    ``path`` optionally scopes the search to a repo-relative subtree. It is
    validated through the shared workspace resolver, so traversal (``../``),
    symlink escapes, and sensitive files (``.env``/``.pem``/credentials) are
    rejected exactly like ``read_file``/``git_blame``. ``max_results`` bounds
    how many matched lines are returned (clamped to 1..200; default 60 = the
    historical cap).

    The resolver guards only the *requested scope*, so a broad scope (no path,
    or ``path="."``) can still match sensitive descendants; every match is
    re-checked against the same policy and a sensitive descendant's content is
    replaced with a ``[redacted: sensitive path]`` marker (``path:lineno``
    provenance preserved). ``-z`` (NUL-separated) is what makes the match's
    path recoverable from the line — even a colon in the path can't confuse
    the ``file:lineno:content`` parsing.

    Patterns use git's default (basic regular expression) matching, so
    metacharacters like ``.`` and ``*`` are active — escape them for a literal
    search. Both the pattern and the path are placed after ``--`` in an argv
    list (never a shell string), so neither can be re-read as a git option.
    """
    max_results = clamp_grep_max_results(max_results)
    args = ["git", "grep", "-n", "-z", "--", pattern]
    if path is None:
        # No explicit path: preserve the historical whole-worktree
        # invocation byte-for-byte (single ``--`` before the pattern, ``.``
        # pathspec) so existing callers and argv assertions are unchanged.
        args.append(".")
    else:
        text = str(path).strip()
        if not text:
            # A model-emitted blank path means "whole worktree", matching the
            # no-argument behaviour.
            args.append(".")
        else:
            resolved, err = _resolve_workspace_path(text, workspace_root)
            if err:
                return {"error": err}
            args += ["--", _grep_pathspec(resolved, workspace_root)]
    try:
        result = subprocess.run(
            args,
            cwd=workspace_root,
            capture_output=True,
            text=True,
            timeout=request_timeout,
        )
        if result.returncode not in (0, 1):
            return {"error": f"git grep failed: {result.stderr.strip()}"}
        # Parse all raw -z records before applying max_results. A path may
        # contain a newline, so splitting stdout into lines first would let a
        # sensitive descendant lose its path boundary before redaction.
        records = _parse_grep_z_records(result.stdout)
        matches = [_redact_grep_record(rec, workspace_root) for rec in records]
        return {"matches": matches[:max_results]}
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

def repo_contents(repo, path, ref, allowed_repos, current_repo, max_entries=200, request_timeout=25):
    """Thin shim over the platform seam for normalized repository contents."""
    return platform_repo_contents(
        repo, path, ref, allowed_repos, current_repo, max_entries, request_timeout
    )


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
    """Fetch a URL using the same host-allowlist logic.

    Only ``http`` and ``https`` schemes are permitted; all other schemes
    (file://, ftp://, gopher://, …) are rejected to prevent LFI/SSRF attacks
    when the model supplies URLs derived from untrusted PR/corpus content.
    This mirrors the scheme check in :func:`mcp_client.is_safe_server_url`.

    Re-validates each redirect hop against the allowlist so a 30x on an
    allowlisted host cannot pivot to IMDS or internal networks.
    """
    parsed = urllib.parse.urlparse(url)

    if parsed.scheme not in ("http", "https"):
        return {"error": f"URL scheme '{parsed.scheme}' is not allowed; only http and https are permitted"}

    host = parsed.hostname or ""

    if not allowlisted_host(host, allowed_hosts):
        return {"error": f"Host not allowlisted: {host}"}

    # Build an opener that re-validates each redirect hop against the allowlist.
    class _AllowListRedirectHandler(urllib.request.HTTPRedirectHandler):
        def __init__(self, allowed_hosts, max_redirects=10):
            super().__init__()
            self._allowed_hosts = {normalize_host(h) for h in allowed_hosts}
            self._max_redirects = max_redirects
            self._redirect_count = 0

        def redirect_request(self, req, fp, code, msg, headers, newurl):
            if self._redirect_count >= self._max_redirects:
                raise urllib.error.HTTPError(
                    newurl, code, "Too many redirects", {}, None
                )
            parsed = urllib.parse.urlparse(newurl)
            hop_host = parsed.hostname or ""
            if not allowlisted_host(normalize_host(hop_host), allowed_hosts):
                raise urllib.error.URLError(
                    f"Redirect to disallowed host: {hop_host}"
                )
            self._redirect_count += 1
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    opener = urllib.request.build_opener(
        urllib.request.HTTPHandler(),
        urllib.request.HTTPSHandler(),
        _AllowListRedirectHandler(allowed_hosts),
    )

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": USER_AGENT},
        )
        with opener.open(req, timeout=request_timeout) as resp:
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

    Result URLs containing non-http(s) schemes (file://, ftp://, gopher://, …)
    are stripped to prevent LFI/SSRF attacks when search results are fed back
    into the review corpus.
    """
    if not search_url:
        return {"error": "Search is not configured (no search_url)."}
    sep = "&" if urllib.parse.urlparse(search_url).query else "?"
    full = f"{search_url}{sep}" + urllib.parse.urlencode({"q": query, "format": "json"})
    try:
        req = urllib.request.Request(
            full,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=request_timeout) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception as exc:
        return {"error": str(exc)}

    results = []
    for item in (data.get("results") or [])[:max_results]:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url", ""))
        # Strip non-http(s) result URLs to prevent LFI/SSRF via search results
        parsed_url = urllib.parse.urlparse(url)
        if parsed_url.scheme and parsed_url.scheme not in ("http", "https"):
            url = ""
        results.append({
            "title": str(item.get("title", ""))[:300],
            "url": url,
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

        elif tool_name == "find_files":
            pattern = args.get("pattern", "")
            if not pattern:
                raise ValueError("Missing 'pattern' argument")
            raw_max_results = args.get("max_results")
            max_results = (
                FIND_FILES_DEFAULT_MAX
                if raw_max_results is None
                else _opt_int(raw_max_results)
            )
            res = find_files(
                pattern,
                workspace_root,
                args.get("path", "") or ".",
                max_results,
            )
            if res.get("error"):
                raise ValueError(res["error"])
            files = res.get("files", [])
            tool_result["result"] = {
                "files": files,
                "total": res.get("total", len(files)),
                "truncated": res.get("truncated", False),
            }

        elif tool_name == "list_tree":
            path = args.get("path") or "."
            res = list_tree(
                path, workspace_root, _opt_int(args.get("depth")),
                _opt_int(args.get("max_entries")),
            )
            if res.get("error"):
                raise ValueError(res["error"])
            entries = res.get("entries", [])
            # Byte cap applied at row boundaries: each entry is one JSON
            # row, so we measure the serialized row size and never split an
            # entry at a byte cut. Unlike find_files (where the cap is a
            # count cap), list_tree's output is variable-length rows, so a
            # byte cap is the only way to keep the response bounded. The cap
            # is applied at the row level, not the entry level — a single
            # sufficiently large entry can exceed the cap, in which case the
            # result is empty and truncated is True.
            truncated = res.get("truncated", False)
            if max_response_bytes and max_response_bytes > 0:
                kept = []
                # The cap is on the serialized `entries` array: 2 brackets +
                # each row's serialized size + (n-1) inter-row commas. We
                # measure the actual payload shape, not just sum of row sizes,
                # so a cap of 68 with two 34-byte rows drops the second row
                # (the serialized array is [a,b] = 71 > 68).
                array_bytes = 2  # the `[]` brackets
                for e in entries:
                    row = json.dumps(e, separators=(",", ":"))
                    row_bytes = len(row.encode("utf-8"))
                    added = row_bytes + (1 if kept else 0)  # +1 for the comma
                    if array_bytes + added > max_response_bytes:
                        truncated = True
                        break
                    kept.append(e)
                    array_bytes += added
                entries = kept
            tool_result["result"] = {
                "entries": entries,
                "total": len(entries),
                "truncated": truncated,
            }

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
            # Clamp/normalise here (not just in git_grep) so the response the
            # model receives is bounded by exactly the same cap the executor
            # used when it produced the matches — the two can't drift apart.
            max_results = clamp_grep_max_results(
                args.get("max_results"), GIT_GREP_DEFAULT_MAX_RESULTS
            )
            res = git_grep(
                pattern,
                workspace_root,
                request_timeout,
                path=args.get("path"),
                max_results=max_results,
            )
            if res.get("error"):
                raise ValueError(res["error"])
            # The matches from git_grep are already capped (max_results) and
            # per-line sensitive-path masked. But the payload must also be
            # redacted (credential-like values) and byte-bounded — the old
            # code computed the sanitized text then discarded it, returning
            # the raw matches instead.
            matches = res.get("matches", [])
            text, truncated = mask_and_truncate("\n".join(matches), max_response_bytes)
            tool_result["result"] = {"matches": text.splitlines(), "truncated": truncated}

        elif tool_name == "repo_contents":
            repo = args.get("repo", "")
            if not repo:
                raise ValueError("Missing 'repo' argument")
            raw_max_entries = args.get("max_entries")
            max_entries = 200 if raw_max_entries is None else _opt_int(raw_max_entries)
            res = repo_contents(
                repo,
                args.get("path", "") or "",
                args.get("ref"),
                allowed_gh_repos,
                current_repo,
                max_entries,
                request_timeout,
            )
            if res.get("error"):
                raise ValueError(res["error"])
            if res.get("type") == "file" and "content" in res:
                content, clipped = mask_and_truncate(res["content"], min(max_response_bytes, 12000))
                res = {**res, "content": content, "truncated": res.get("truncated", False) or clipped}
            elif res.get("type") == "directory" and max_response_bytes:
                entries = []
                used = 2
                for entry in res.get("entries", []):
                    row_bytes = len(json.dumps(entry, separators=(",", ":")).encode("utf-8"))
                    added = row_bytes + (1 if entries else 0)
                    if used + added > max_response_bytes:
                        break
                    entries.append(entry)
                    used += added
                res = {**res, "entries": entries, "truncated": res.get("truncated", False) or len(entries) < len(res.get("entries", []))}
            tool_result["result"] = res

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
