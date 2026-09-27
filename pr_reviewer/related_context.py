"""Deterministic bounded related-code context from change anchors (#572).

The builder consumes the version-1 change-anchor artifact and a checked-out Git
worktree. It searches only high-confidence symbol anchors, discovers likely test
paths and nearest project manifests, and emits bounded relationship data without
executing repository code or making network/model calls.

References come from unchanged files. Changed files whose anchor entry carries
``changed_lines`` (#764) are searched too, skipping the symbol's own
declaration line and every added line: those hits are listed, under a separate
small cap (non-test files first) and marked ``changed_file``, for enclosing
symbols only; for any other symbol with no unchanged-file reference they set
``only_in_changed_files``.

Anchor ``keys`` (#791) are searched as their mechanical variants for
``consumers``, unchanged files first and then changed files outside the added
lines; anchor ``counterparts`` become bounded declaration bodies. Anchors
without those fields produce the same artifact as before.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import selectors
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Iterable

ARTIFACT_VERSION = 1
MAX_SYMBOLS = 40
MAX_REFERENCES_PER_SYMBOL = 20
MAX_REFERENCES = 200
MAX_CHANGED_REFERENCES_PER_SYMBOL = 5
MAX_CHANGED_REFERENCES = 40
MAX_CHANGED_RANGES_PER_FILE = 200
MAX_TESTS_PER_FILE = 20
MAX_MANIFESTS_PER_FILE = 20
MAX_SNIPPET_CHARS = 300
DEFAULT_GIT_TIMEOUT_SEC = 10
MAX_JSON_BYTES = 100_000
MAX_MARKDOWN_BYTES = 100_000
MAX_ERROR_CHARS = 300
MAX_CONSUMER_KEYS = 40
MAX_CONSUMERS_PER_KEY = 3
MAX_CONSUMERS = 40
MAX_CHANGED_CONSUMERS_PER_KEY = 2
MAX_CHANGED_CONSUMERS = 10
MAX_CONSUMER_SCAN = 100
MAX_CONSUMER_WINDOWS = 12
CONSUMER_CONTEXT_LINES = 2
MAX_COUNTERPARTS = 8
MAX_COUNTERPART_LINES = 20

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
from redact import redact_text  # noqa: E402

from pr_reviewer.change_anchors import (  # noqa: E402
    data_format,
    is_test_path as _is_test_path,
    key_words,
    read_head_lines,
)

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_BACKTICK_RUN_RE = re.compile(r"`+")
_KEY_NAME_RE = re.compile(r"-{0,2}[A-Za-z0-9_][A-Za-z0-9_.\-]{0,99}")
_DECL_NAME_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]{0,99}")
_COMMENT_PREFIXES = ("#", "//", "/*", "*")
_PATH_WORD_RE = re.compile(r"[^a-z0-9]+")
_DOC_EXTS = frozenset({"md", "rst", "txt", "adoc"})
_BRANCH_SITE_RE = re.compile(
    r"""(?:===|!==|==|!=|["'\]]\s+=\s+|\s-(?:eq|ne)\s+)\s*["']|\s(?:not\s+)?in\s*[(\[{]\s*["']"""
)
_CASE_SITE_RE = re.compile(r"^\s*(?:case\s|switch\s*\(|match\s)")
_MANIFEST_BASE_RE = re.compile(
    r"^(?:pyproject\.toml|setup\.(?:py|cfg)|requirements[^/]*\.txt|"
    r"package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|go\.(?:mod|sum)|"
    r"Cargo\.(?:toml|lock)|Gemfile(?:\.lock)?|pom\.xml|build\.gradle(?:\.kts)?|"
    r"composer\.json|Pipfile(?:\.lock)?|poetry\.lock|uv\.lock|mix\.(?:exs|lock)|"
    r"Dockerfile[^/]*|action\.ya?ml)$",
    re.IGNORECASE,
)


def _bounded_text(value: Any, limit: int = MAX_ERROR_CHARS) -> str:
    text = redact_text(str(value or "")).replace("\x00", "\\u0000")
    text = _escape_controls(text)
    if len(text) > limit:
        return text[: max(0, limit - 3)] + "..."
    return text


def _escape_controls(value: str) -> str:
    def replace(match: re.Match[str]) -> str:
        char = match.group(0)
        if char == "\n":
            return "\\n"
        if char == "\r":
            return "\\r"
        if char == "\t":
            return "\\t"
        return f"\\u{ord(char):04x}"

    return _CONTROL_RE.sub(replace, value)


def _display(value: str, limit: int = 200) -> str:
    text = _escape_controls(value)
    if len(text) > limit:
        return text[: max(0, limit - 1)] + "..."
    return text


def _code_span(value: str) -> str:
    if "`" not in value:
        return f"`{value}`"
    max_run = max(len(run) for run in _BACKTICK_RUN_RE.findall(value))
    delimiter = "`" * (max_run + 1)
    return f"{delimiter} {value} {delimiter}"


def _path(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value.replace("\\", "/")


def _normalise_file_list(file_list: Iterable[Any] | None) -> list[dict[str, Any]]:
    if not file_list:
        return []
    return [entry for entry in file_list if isinstance(entry, dict)]


def _changed_paths(
    anchor_files: list[dict[str, Any]], file_list: list[dict[str, Any]],
) -> tuple[set[str], set[str]]:
    changed: set[str] = set()
    deleted: set[str] = set()
    for entry in anchor_files:
        path = _path(entry.get("path"))
        if path:
            changed.add(path)
        if entry.get("deleted") and path:
            deleted.add(path)
    for entry in file_list:
        filename = _path(entry.get("filename"))
        previous = _path(entry.get("previous_filename"))
        for path in (filename, previous):
            if path:
                changed.add(path)
        if entry.get("status") == "removed":
            deleted.update(path for path in (filename, previous) if path)
    return changed, deleted


def _error(kind: str, detail: Any = "") -> str:
    suffix = f": {_bounded_text(detail)}" if detail else ""
    return f"{kind}{suffix}"


def _run_git(
    argv: list[str], workspace: str, timeout: float,
) -> tuple[int | None, str, str]:
    try:
        proc = subprocess.run(
            argv,
            cwd=workspace,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None, "", _error("command timed out", f"after {timeout:g}s")
    except FileNotFoundError:
        return None, "", "git executable not found"
    except OSError as exc:
        return None, "", _error("command failed to start", exc)
    return proc.returncode, proc.stdout, proc.stderr


def _tracked_files(workspace: str, timeout: float) -> tuple[list[str], str | None]:
    returncode, stdout, stderr = _run_git(["git", "ls-files", "-z"], workspace, timeout)
    if returncode is None:
        return [], _error("git ls-files", stderr)
    if returncode != 0:
        return [], _error(f"git ls-files exited {returncode}", stderr.strip())
    paths = [chunk for chunk in stdout.split("\0") if chunk]
    return paths, None


def _parse_grep_output(stdout: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for raw_line in stdout.splitlines():
        match = re.match(r"^(.*?):([0-9]+):(.*)$", raw_line)
        if not match:
            continue
        path, line_text, snippet = match.groups()
        rows.append(
            {
                "path": path,
                "line": int(line_text),
                "snippet": _snippet(snippet),
            }
        )
    rows.sort(key=lambda row: (row["path"], row["line"], row["snippet"]))
    return rows


def _snippet(value: str) -> str:
    text = redact_text(value)
    text = _escape_controls(text)
    if len(text) > MAX_SNIPPET_CHARS:
        return text[: MAX_SNIPPET_CHARS - 3] + "..."
    return text


def git_grep_references(
    symbol: str | list[str],
    workspace: str | os.PathLike[str],
    *,
    excluded_paths: set[str],
    timeout: float = DEFAULT_GIT_TIMEOUT_SEC,
    max_hits: int = MAX_REFERENCES_PER_SYMBOL,
    pathspecs: list[str] | None = None,
    keep: Callable[[dict[str, Any]], bool] | None = None,
) -> tuple[list[dict[str, Any]], bool, str | None]:
    """Stream eligible symbol matches without buffering an unbounded result.

    ``symbol`` may be a list of fixed strings, any of which matches.
    ``pathspecs`` limits the search to those literal paths (default: the whole
    worktree); ``keep`` drops rows it rejects before they count.
    """
    limit = max(0, int(max_hits))
    if limit == 0:
        return [], False, None
    excluded = excluded_paths or set()
    scope = [f":(literal){path}" for path in pathspecs] if pathspecs else ["."]
    if isinstance(symbol, str):
        patterns = ["--", symbol]
    else:
        patterns = [arg for pattern in symbol for arg in ("-e", pattern)]
    try:
        proc = subprocess.Popen(
            ["git", "grep", "-n", "-F", *patterns, "--", *scope],
            cwd=os.fspath(workspace),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        return [], False, "git executable not found"
    except OSError:
        return [], False, "git grep failed to start"

    assert proc.stdout is not None
    rows: list[dict[str, Any]] = []
    extra_hit = False
    deadline = time.monotonic() + timeout
    returncode = None
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ)
            while not extra_hit and len(rows) <= limit:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    proc.kill()
                    proc.wait()
                    return [], False, _error("git grep", f"command timed out after {timeout:g}s")
                if not selector.select(remaining):
                    proc.kill()
                    proc.wait()
                    return [], False, _error("git grep", f"command timed out after {timeout:g}s")
                raw_line = proc.stdout.readline()
                if not raw_line:
                    break
                parsed = _parse_grep_output(raw_line.decode("utf-8", "replace"))
                for row in parsed:
                    if row["path"] in excluded:
                        continue
                    if keep is not None and not keep(row):
                        continue
                    if len(rows) < limit:
                        rows.append(row)
                    else:
                        extra_hit = True
                        break
                if extra_hit:
                    break
        if extra_hit and proc.poll() is None:
            proc.kill()
        returncode = proc.wait()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()

    if returncode == 0 or rows or extra_hit:
        return rows, extra_hit, None
    if returncode == 1:
        return [], False, None
    if returncode is not None and returncode < 0:
        return rows, extra_hit, None
    return [], False, _error(f"git grep exited {returncode}")


def _stem(path: str) -> str:
    base = path.rsplit("/", 1)[-1]
    if "." in base:
        base = base.rsplit(".", 1)[0]
    return base.lower()


def _test_score(changed_path: str, candidate: str) -> tuple[int, str]:
    stem = _stem(changed_path)
    base = candidate.rsplit("/", 1)[-1].lower()
    parent = changed_path.rsplit("/", 1)[0] if "/" in changed_path else ""
    candidate_parent = candidate.rsplit("/", 1)[0] if "/" in candidate else ""
    if base in {f"test_{stem}.py", f"test-{stem}.py", f"{stem}_test.py"}:
        return 0, candidate
    if re.search(rf"(?:^|[._-]){re.escape(stem)}(?:[._-])(test|spec)(?:[._-]|$)", base):
        return 0, candidate
    if stem and stem in base:
        return 1, candidate
    if candidate_parent == parent:
        return 2, candidate
    if parent and candidate_parent.startswith(parent + "/"):
        return 3, candidate
    return 4, candidate


def _discover_tests(
    changed_path: str,
    tracked: list[str],
    references: Iterable[dict[str, Any]],
    changed_paths: set[str],
) -> list[str]:
    candidates: list[tuple[int, str]] = []
    seen: set[str] = set()
    for candidate in tracked:
        if candidate in changed_paths or not _is_test_path(candidate):
            continue
        score, value = _test_score(changed_path, candidate)
        if score < 4 or candidate.rsplit("/", 1)[0] == changed_path.rsplit("/", 1)[0]:
            candidates.append((score, value))
            seen.add(candidate)
    for reference in references:
        candidate = reference["path"]
        if candidate in changed_paths or candidate in seen or not _is_test_path(candidate):
            continue
        candidates.append((5, candidate))
        seen.add(candidate)
    candidates.sort(key=lambda item: (item[0], item[1]))
    return [candidate for _, candidate in candidates]


def _is_manifest(path: str) -> bool:
    base = path.rsplit("/", 1)[-1]
    return bool(_MANIFEST_BASE_RE.match(base))


def _discover_manifests(changed_path: str, tracked: set[str]) -> tuple[list[str], int]:
    parent = changed_path.rsplit("/", 1)[0] if "/" in changed_path else ""
    directories: list[str] = []
    while True:
        directories.append(parent)
        if not parent:
            break
        parent = parent.rsplit("/", 1)[0] if "/" in parent else ""
    manifests: list[str] = []
    for directory in directories:
        local: list[str] = []
        prefix = f"{directory}/" if directory else ""
        for path in tracked:
            if not _is_manifest(path) or not path.startswith(prefix):
                continue
            remainder = path[len(prefix):]
            if "/" not in remainder:
                local.append(path)
        manifests.extend(sorted(local))
    omitted = max(0, len(manifests) - MAX_MANIFESTS_PER_FILE)
    return manifests[:MAX_MANIFESTS_PER_FILE], omitted


def _anchor_symbols(
    anchor_data: dict[str, Any],
) -> list[tuple[str, str, dict[str, Any]]]:
    symbols: list[tuple[str, str, dict[str, Any]]] = []
    files = anchor_data.get("files")
    if isinstance(files, list):
        for file_entry in files:
            if not isinstance(file_entry, dict):
                continue
            source = _path(file_entry.get("path"))
            if not source or file_entry.get("deleted"):
                continue
            values = file_entry.get("symbols")
            if not isinstance(values, list):
                continue
            for symbol in values:
                if not isinstance(symbol, dict) or symbol.get("confidence") != "high":
                    continue
                name = symbol.get("name")
                if isinstance(name, str) and name:
                    symbols.append((source, name, symbol))
    if symbols:
        return symbols
    anchors = anchor_data.get("anchors")
    if isinstance(anchors, list):
        for anchor in anchors:
            if not isinstance(anchor, dict) or anchor.get("kind") != "symbol":
                continue
            if anchor.get("confidence") != "high":
                continue
            source = _path(anchor.get("source"))
            name = anchor.get("value")
            if source and isinstance(name, str) and name:
                symbols.append((source, name, anchor))
    return symbols


def _line_number(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not value.is_integer():
        return None
    number = int(value)
    return number if number >= 1 else None


def _changed_line_index(
    anchor_files: list[dict[str, Any]], deleted_paths: set[str],
) -> dict[str, list[tuple[int, int]]]:
    """Map changed files with valid ``changed_lines`` to their added-line ranges."""
    index: dict[str, list[tuple[int, int]]] = {}
    seen: set[str] = set()
    for entry in anchor_files:
        path = _path(entry.get("path"))
        if not path or path in seen:
            continue
        seen.add(path)
        if entry.get("deleted") or path in deleted_paths:
            continue
        raw = entry.get("changed_lines")
        if not isinstance(raw, list) or len(raw) > MAX_CHANGED_RANGES_PER_FILE:
            continue
        ranges: list[tuple[int, int]] | None = []
        for item in raw:
            start = _line_number(item[0]) if isinstance(item, list) and len(item) == 2 else None
            end = _line_number(item[1]) if start is not None else None
            if start is None or end is None or end < start:
                ranges = None
                break
            ranges.append((start, end))
        if ranges is not None:
            index[path] = ranges
    return index


def _changed_file_references(
    symbol: str,
    workspace: str | os.PathLike[str],
    paths: list[str],
    keep: Callable[[dict[str, Any]], bool],
    cap: int,
    timeout: float,
) -> tuple[list[dict[str, Any]], bool, str | None]:
    """Search changed files, non-test paths first, so tests cannot crowd out callers."""
    groups = [
        [path for path in paths if not _is_test_path(path)],
        [path for path in paths if _is_test_path(path)],
    ]
    rows: list[dict[str, Any]] = []
    for group in groups:
        if not group:
            continue
        left = cap - len(rows)
        hits, extra, error = git_grep_references(
            symbol, workspace, excluded_paths=set(), timeout=timeout,
            max_hits=max(left, 1), pathspecs=group, keep=keep,
        )
        if error:
            return rows, False, error
        if left <= 0:
            return rows, bool(hits) or extra, None
        rows.extend(hits)
        if extra:
            return rows, True, None
    return rows, False, None


def key_variants(name: str, kind: str = "entity") -> list[str]:
    """Search forms of a changed key: as written, kebab, snake, UPPER_SNAKE, and
    INPUT_; a ``branch`` variable (which may be one word) as written, snake, and
    UPPER_SNAKE."""
    words = key_words(name)
    if not words or (len(words) < 2 and kind != "branch"):
        return []
    snake = "_".join(words)
    forms = [name.lstrip("-"), snake, snake.upper()]
    if kind != "branch":
        forms = [name.lstrip("-"), "-".join(words), snake, snake.upper(), "INPUT_" + snake.upper()]
    variants: list[str] = []
    for variant in forms:
        if variant not in variants:
            variants.append(variant)
    return variants


def _branch_site(snippet: str, variants: list[str]) -> bool:
    """Whether a line branches on a variant that is not an attribute of
    something else: a ``case``/``switch``/``match`` on it, or a comparison with
    a string literal after it."""
    positions: list[int] = []
    for variant in variants:
        index = snippet.find(variant)
        while index > 0 and snippet[index - 1] == ".":
            index = snippet.find(variant, index + 1)
        if index >= 0:
            positions.append(index)
    if not positions:
        return False
    if _CASE_SITE_RE.match(snippet):
        return True
    return _BRANCH_SITE_RE.search(snippet[min(positions):]) is not None


def _consumer_tier(row: dict[str, Any]) -> int:
    path = row["path"]
    if _is_test_path(path):
        return 3
    base = path.rsplit("/", 1)[-1].lower()
    if "." in base and base.rsplit(".", 1)[-1] in _DOC_EXTS:
        return 2
    return 1 if row["snippet"].lstrip().startswith(_COMMENT_PREFIXES) else 0


def _anchor_keys(
    anchor_files: list[dict[str, Any]], deleted_paths: set[str],
) -> list[tuple[str, str, str, int | None]]:
    keys: list[tuple[str, str, str, int | None]] = []
    seen: set[str] = set()
    for entry in anchor_files:
        source = _path(entry.get("path"))
        values = entry.get("keys")
        if not source or entry.get("deleted") or source in deleted_paths or not isinstance(values, list):
            continue
        for item in values:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            kind = item.get("kind")
            if not isinstance(name, str) or not _KEY_NAME_RE.fullmatch(name) or name in seen:
                continue
            if kind not in ("entity", "env", "flag", "branch"):
                continue
            seen.add(name)
            keys.append((source, name, kind, _line_number(item.get("line"))))
    return keys


def _anchor_counterparts(
    anchor_files: list[dict[str, Any]], deleted_paths: set[str],
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for entry in anchor_files:
        source = _path(entry.get("path"))
        values = entry.get("counterparts")
        if not source or entry.get("deleted") or source in deleted_paths or not isinstance(values, list):
            continue
        for item in values:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            ref_name = item.get("ref_name")
            ref_path = _path(item.get("ref_path"))
            line = _line_number(item.get("line"))
            ref_line = _line_number(item.get("ref_line"))
            ref_end = _line_number(item.get("ref_end"))
            if not isinstance(name, str) or not _DECL_NAME_RE.fullmatch(name):
                continue
            if not isinstance(ref_name, str) or not _DECL_NAME_RE.fullmatch(ref_name):
                continue
            if not ref_path or ref_path == source or ref_path in deleted_paths:
                continue
            if line is None or ref_line is None or ref_end is None or ref_end < ref_line:
                continue
            items.append({
                "path": source, "name": name, "line": line, "ref_path": ref_path,
                "ref_name": ref_name, "ref_line": ref_line, "ref_end": ref_end,
                "ref_changed": item.get("ref_changed") is True,
            })
    return items


def _file_window(
    lines: list[str] | None, start: int, end: int,
) -> list[str]:
    if lines is None:
        return []
    total = len(lines) - 1 if lines and lines[-1] == "" else len(lines)
    return [_snippet(text.replace("\t", "    ")) for text in lines[max(1, start) - 1 : min(end, total)]]


def _note_cap(result: dict[str, Any], reason: str) -> None:
    result["truncated"] = True
    result["truncation"]["truncated"] = True
    if reason not in result["truncation"]["reasons"]:
        result["truncation"]["reasons"].append(reason)


def _note_error(result: dict[str, Any], errors_seen: set[str], error: str) -> None:
    if error not in errors_seen:
        result["errors"].append(error)
        errors_seen.add(error)


def _bridge_score(snippet: str, variants: list[str]) -> int:
    """How many distinct forms of a key a line carries: a line mapping one
    naming onto another (``ENV_NAME: ${{ inputs.env_name }}``) is where the key
    crosses a boundary."""
    matched = [variant for variant in variants if variant in snippet]
    return sum(1 for variant in matched if not any(variant != other and variant in other for other in matched))


def _best_per_file(
    rows: list[dict[str, Any]], variants: list[str],
) -> dict[str, tuple[int, dict[str, Any]]]:
    """Each file's best row: lowest tier, then (in a data file) most key forms,
    then first line."""
    best: dict[str, tuple[int, int, dict[str, Any]]] = {}
    for row in rows:
        tier = _consumer_tier(row)
        bridge = _bridge_score(row["snippet"], variants) if data_format(row["path"]) else 0
        current = best.get(row["path"])
        if current is None or (tier, -bridge) < (current[0], -current[1]):
            best[row["path"]] = (tier, bridge, row)
    return {path: (tier, row) for path, (tier, _, row) in best.items()}


def _breadth_first(
    lists: list[list[dict[str, Any]]], depth_cap: int, total_cap: int, result: dict[str, Any],
) -> list[list[dict[str, Any]]]:
    """Take one item from each list per round, up to ``total_cap`` items."""
    chosen: list[list[dict[str, Any]]] = [[] for _ in lists]
    total = 0
    for depth in range(depth_cap):
        for index, rows in enumerate(lists):
            if depth < len(rows):
                if total >= total_cap:
                    _note_cap(result, "consumer_cap")
                    break
                chosen[index].append(rows[depth])
                total += 1
    return chosen


def _build_consumers(
    result: dict[str, Any],
    keys: list[tuple[str, str, str, int | None]],
    workspace: str | os.PathLike[str],
    excluded: set[str],
    changed_index: dict[str, list[tuple[int, int]]],
    timeout: float,
    errors_seen: set[str],
    max_consumers_per_key: int,
    max_consumers: int,
    max_changed_consumers_per_key: int,
    max_changed_consumers: int,
) -> list[dict[str, Any]]:
    """Search each key's variants in unchanged files, then in changed files
    outside their added lines.

    A file counts once per key. Unchanged hits rank code lines before
    comments, docs, and tests, then files whose path shares more of the key's
    words, and every key gets its best hit before any key gets a second.
    Changed-file hits follow under their own caps, also breadth first: code
    lines only, non-test files first, and never the entity's own file. Within
    a data file, the line carrying the most forms of the key wins. A
    ``branch`` key only matches lines that compare it to a literal or switch on
    it. A key whose variants match more than ``MAX_CONSUMER_SCAN`` unchanged
    lines is too common to keep. The first ``MAX_CONSUMER_WINDOWS`` hits,
    breadth first, carry a few lines of context; the rest only the matched
    line.
    """
    if len(keys) > MAX_CONSUMER_KEYS:
        _note_cap(result, "consumer_cap")
    ranked: list[tuple[str, str, str, int | None, list[str], list[dict[str, Any]], list[dict[str, Any]]]] = []
    for source, name, kind, line in keys[:MAX_CONSUMER_KEYS]:
        variants = key_variants(name, kind)
        if not variants:
            continue

        def keep(row: dict[str, Any], variants: list[str] = variants, kind: str = kind) -> bool:
            if len(row["snippet"]) >= MAX_SNIPPET_CHARS:
                return False
            return kind != "branch" or _branch_site(row["snippet"], variants)

        rows, extra, error = git_grep_references(
            variants, workspace, excluded_paths=excluded, timeout=timeout,
            max_hits=MAX_CONSUMER_SCAN, keep=keep,
        )
        if error:
            _note_error(result, errors_seen, error)
            continue
        if extra:
            continue
        best = _best_per_file(rows, variants)
        words = set(key_words(name))

        def rank(item: tuple[int, dict[str, Any]], words: set[str] = words) -> tuple[int, int, str]:
            path = item[1]["path"]
            affinity = len(words.intersection(_PATH_WORD_RE.split(path.lower())))
            return item[0], -affinity, path

        hits = [row for _, row in sorted(best.values(), key=rank)]
        if len(hits) > max_consumers_per_key:
            _note_cap(result, "consumer_cap")
            hits = hits[:max_consumers_per_key]

        changed_hits: list[dict[str, Any]] = []
        searched = [path for path in changed_index if kind != "entity" or path != source]
        if searched and max_changed_consumers_per_key > 0:

            def keep_changed(row: dict[str, Any], keep: Callable[[dict[str, Any]], bool] = keep) -> bool:
                if _consumer_tier(row) in (1, 2) or not keep(row):
                    return False
                return not any(start <= row["line"] <= end for start, end in changed_index[row["path"]])

            rows, extra, error = git_grep_references(
                variants, workspace, excluded_paths=set(), timeout=timeout,
                max_hits=MAX_CONSUMER_SCAN, pathspecs=searched, keep=keep_changed,
            )
            if error:
                _note_error(result, errors_seen, error)
            best = _best_per_file(rows, variants)
            changed_hits = [
                row for _, row in sorted(best.values(), key=lambda item: (_is_test_path(item[1]["path"]), item[1]["path"]))
            ]
            if extra or len(changed_hits) > max_changed_consumers_per_key:
                _note_cap(result, "consumer_cap")
                changed_hits = changed_hits[:max_changed_consumers_per_key]
            for row in changed_hits:
                row["changed_file"] = True
        if hits or changed_hits:
            ranked.append((source, name, kind, line, variants, hits, changed_hits))

    chosen = _breadth_first([item[5] for item in ranked], max_consumers_per_key, max_consumers, result)
    chosen_changed = _breadth_first(
        [item[6] for item in ranked], max_changed_consumers_per_key, max_changed_consumers, result,
    )
    groups = [rows + changed for rows, changed in zip(chosen, chosen_changed)]

    windowed: set[tuple[int, int]] = set()
    depth = 0
    while len(windowed) < MAX_CONSUMER_WINDOWS and any(depth < len(rows) for rows in groups):
        for index, rows in enumerate(groups):
            if depth < len(rows) and len(windowed) < MAX_CONSUMER_WINDOWS:
                windowed.add((index, depth))
        depth += 1

    consumers: list[dict[str, Any]] = []
    cache: dict[str, list[str] | None] = {}
    for index, ((source, name, kind, line, variants, _, _), rows) in enumerate(zip(ranked, groups)):
        if not rows:
            continue
        references: list[dict[str, Any]] = []
        for position, row in enumerate(rows):
            path = row["path"]
            reference: dict[str, Any] = {"path": path, "line": row["line"]}
            if row.get("changed_file") is True:
                reference["changed_file"] = True
            match = ""
            for variant in variants:
                if variant in row["snippet"] and len(variant) > len(match):
                    match = variant
            if match:
                reference["match"] = match
            if (index, position) in windowed:
                if path not in cache:
                    cache[path] = read_head_lines(workspace, path)
                start = max(1, row["line"] - CONSUMER_CONTEXT_LINES)
                window = _file_window(cache[path], start, row["line"] + CONSUMER_CONTEXT_LINES)
                if len(window) <= row["line"] - start:
                    start, window = row["line"], [row["snippet"]]
                reference["start"] = start
                reference["lines"] = window
            else:
                reference["snippet"] = row["snippet"]
            references.append(reference)
        consumers.append({"key": name, "kind": kind, "source": source, "line": line, "references": references})
    return consumers


def _build_counterparts(
    result: dict[str, Any],
    items: list[dict[str, Any]],
    workspace: str | os.PathLike[str],
    tracked: set[str],
    max_counterparts: int,
) -> list[dict[str, Any]]:
    counterparts: list[dict[str, Any]] = []
    cache: dict[str, list[str] | None] = {}
    for item in items:
        ref_path = item["ref_path"]
        if ref_path not in tracked:
            continue
        if len(counterparts) >= max_counterparts:
            _note_cap(result, "counterpart_cap")
            break
        if ref_path not in cache:
            cache[ref_path] = read_head_lines(workspace, ref_path)
        lines = cache[ref_path]
        ref_line = item["ref_line"]
        if lines is None or ref_line > len(lines) or item["ref_name"] not in lines[ref_line - 1]:
            continue
        end = min(item["ref_end"], ref_line + MAX_COUNTERPART_LINES - 1)
        body = _file_window(lines, ref_line, end)
        entry: dict[str, Any] = {
            "path": item["path"],
            "name": item["name"],
            "line": item["line"],
            "ref_path": ref_path,
            "ref_name": item["ref_name"],
            "ref_line": ref_line,
        }
        if item["ref_changed"]:
            entry["ref_changed"] = True
        entry["lines"] = body
        if len(body) < item["ref_end"] - ref_line + 1:
            entry["lines_truncated"] = True
        counterparts.append(entry)
    return counterparts


def _note_reference_cap(result: dict[str, Any], omitted: int) -> None:
    result["truncated"] = True
    result["truncation"]["truncated"] = True
    if "reference_cap" not in result["truncation"]["reasons"]:
        result["truncation"]["reasons"].append("reference_cap")
    result["truncation"]["omitted_references"] += omitted


def _empty_result() -> dict[str, Any]:
    return {
        "version": ARTIFACT_VERSION,
        "files": [],
        "truncated": False,
        "errors": [],
        "truncation": {
            "truncated": False,
            "reasons": [],
            "omitted_symbols": 0,
            "omitted_references": 0,
            "omitted_tests": 0,
            "omitted_manifests": 0,
            "omitted_output_bytes": 0,
        },
    }


def build_related_context(
    anchor_data: dict[str, Any] | None,
    workspace: str | os.PathLike[str],
    file_list: Iterable[Any] | None = None,
    *,
    git_timeout_sec: float = DEFAULT_GIT_TIMEOUT_SEC,
    max_symbols: int = MAX_SYMBOLS,
    max_references_per_symbol: int = MAX_REFERENCES_PER_SYMBOL,
    max_references: int = MAX_REFERENCES,
    max_tests_per_file: int = MAX_TESTS_PER_FILE,
    max_changed_references_per_symbol: int = MAX_CHANGED_REFERENCES_PER_SYMBOL,
    max_changed_references: int = MAX_CHANGED_REFERENCES,
    max_consumers_per_key: int = MAX_CONSUMERS_PER_KEY,
    max_consumers: int = MAX_CONSUMERS,
    max_changed_consumers_per_key: int = MAX_CHANGED_CONSUMERS_PER_KEY,
    max_changed_consumers: int = MAX_CHANGED_CONSUMERS,
    max_counterparts: int = MAX_COUNTERPARTS,
) -> dict[str, Any]:
    """Build a version-1 related-code artifact without raising on Git errors."""
    result = _empty_result()
    if not isinstance(anchor_data, dict):
        result["errors"].append("change-anchor artifact is not a JSON object")
        result["truncated"] = True
        result["truncation"]["truncated"] = True
        result["truncation"]["reasons"].append("invalid_input")
        return result
    try:
        timeout = max(0.1, float(git_timeout_sec))
    except (TypeError, ValueError):
        timeout = DEFAULT_GIT_TIMEOUT_SEC
    max_symbols = max(0, int(max_symbols))
    max_references_per_symbol = max(0, int(max_references_per_symbol))
    max_references = max(0, int(max_references))
    max_tests_per_file = max(0, int(max_tests_per_file))
    max_changed_references_per_symbol = max(0, int(max_changed_references_per_symbol))
    max_changed_references = max(0, int(max_changed_references))
    max_consumers_per_key = max(0, int(max_consumers_per_key))
    max_consumers = max(0, int(max_consumers))
    max_changed_consumers_per_key = max(0, int(max_changed_consumers_per_key))
    max_changed_consumers = max(0, int(max_changed_consumers))
    max_counterparts = max(0, int(max_counterparts))

    raw_anchor_files = anchor_data.get("files", [])
    anchor_files = (
        [entry for entry in raw_anchor_files if isinstance(entry, dict)]
        if isinstance(raw_anchor_files, list)
        else []
    )
    file_list_normalized = _normalise_file_list(file_list)
    changed_paths, deleted_paths = _changed_paths(anchor_files, file_list_normalized)
    for source, _, _ in _anchor_symbols(anchor_data):
        changed_paths.add(source)

    tracked, tracked_error = _tracked_files(os.fspath(workspace), timeout)
    if tracked_error:
        result["errors"].append(tracked_error)
    tracked_set = set(tracked)

    selected_symbols = _anchor_symbols(anchor_data)[:max_symbols]
    omitted_symbols = max(0, len(_anchor_symbols(anchor_data)) - len(selected_symbols))
    if omitted_symbols:
        result["truncated"] = True
        result["truncation"]["truncated"] = True
        result["truncation"]["reasons"].append("symbol_cap")
        result["truncation"]["omitted_symbols"] = omitted_symbols

    by_file: dict[str, dict[str, Any]] = {}
    file_order: list[str] = []
    for entry in anchor_files:
        path = _path(entry.get("path"))
        if not path or path in deleted_paths or entry.get("deleted"):
            continue
        if path not in by_file:
            by_file[path] = {"path": path, "symbols": [], "tests": [], "manifests": []}
            file_order.append(path)
    for source, _, _ in selected_symbols:
        if source not in deleted_paths and source not in by_file:
            by_file[source] = {"path": source, "symbols": [], "tests": [], "manifests": []}
            file_order.append(source)
    changed_index = _changed_line_index(anchor_files, deleted_paths)
    references_total = 0
    changed_total = 0
    errors_seen = set(result["errors"])
    refs_by_file: dict[str, list[dict[str, Any]]] = {path: [] for path in file_order}
    for source, name, symbol in selected_symbols:
        if source in deleted_paths:
            continue
        symbol_output = {"name": name, "references": []}
        remaining = max_references - references_total
        if remaining <= 0:
            # Later anchors are not searched once the global budget is spent;
            # make that omission visible instead of reporting a false negative.
            result["truncated"] = True
            result["truncation"]["truncated"] = True
            if "reference_cap" not in result["truncation"]["reasons"]:
                result["truncation"]["reasons"].append("reference_cap")
            result["truncation"]["omitted_references"] += 1
        hits: list[dict[str, Any]] = []
        additional_hit = False
        grep_error: str | None = None
        if remaining > 0 and max_references_per_symbol > 0 and not tracked_error:
            hits, additional_hit, grep_error = git_grep_references(
                name,
                workspace,
                excluded_paths=changed_paths,
                timeout=timeout,
                max_hits=min(max_references_per_symbol, max(remaining, 1)),
            )
        if grep_error and grep_error not in errors_seen:
            result["errors"].append(grep_error)
            errors_seen.add(grep_error)
        filtered = hits[: min(max_references_per_symbol, max(remaining, 0))]
        omitted = int(additional_hit)
        if len(hits) > len(filtered):
            omitted += len(hits) - len(filtered)
        if omitted:
            result["truncated"] = True
            result["truncation"]["truncated"] = True
            if "reference_cap" not in result["truncation"]["reasons"]:
                result["truncation"]["reasons"].append("reference_cap")
            result["truncation"]["omitted_references"] += omitted

        symbol_output["references"] = filtered
        references_total += len(filtered)

        enclosing = symbol.get("kind") == "enclosing"
        unreferenced = remaining > 0 and not filtered and not omitted and grep_error is None
        if changed_index and not tracked_error and (enclosing or unreferenced):
            decl_line = _line_number(symbol.get("line"))

            def keep(row: dict[str, Any], source: str = source, decl_line: int | None = decl_line) -> bool:
                ranges = changed_index.get(row["path"])
                if ranges is None:
                    return False
                if row["path"] == source and row["line"] == decl_line:
                    return False
                return not any(start <= row["line"] <= end for start, end in ranges)

            cap = 1
            if enclosing:
                cap = min(max_changed_references_per_symbol, max_changed_references - changed_total)
                if cap <= 0:
                    _note_reference_cap(result, 1)
            changed_hits: list[dict[str, Any]] = []
            changed_extra = False
            changed_error: str | None = None
            if cap > 0:
                changed_hits, changed_extra, changed_error = _changed_file_references(
                    name, workspace, list(changed_index), keep, cap, timeout,
                )
            if changed_error and changed_error not in errors_seen:
                result["errors"].append(changed_error)
                errors_seen.add(changed_error)
            if enclosing:
                for row in changed_hits:
                    row["changed_file"] = True
                symbol_output["references"] = filtered + changed_hits
                changed_total += len(changed_hits)
                if changed_extra:
                    _note_reference_cap(result, 1)
            elif changed_hits or changed_extra:
                symbol_output["only_in_changed_files"] = True

        by_file[source]["symbols"].append(symbol_output)
        refs_by_file[source].extend(filtered)

    for path in file_order:
        tests = _discover_tests(path, tracked, refs_by_file[path], changed_paths)
        if len(tests) > max_tests_per_file:
            result["truncated"] = True
            result["truncation"]["truncated"] = True
            if "test_cap" not in result["truncation"]["reasons"]:
                result["truncation"]["reasons"].append("test_cap")
            result["truncation"]["omitted_tests"] += len(tests) - max_tests_per_file
            tests = tests[:max_tests_per_file]
        by_file[path]["tests"] = tests
        manifests, omitted_manifests = _discover_manifests(path, tracked_set)
        by_file[path]["manifests"] = manifests
        if omitted_manifests:
            result["truncated"] = True
            result["truncation"]["truncated"] = True
            if "manifest_cap" not in result["truncation"]["reasons"]:
                result["truncation"]["reasons"].append("manifest_cap")
            result["truncation"]["omitted_manifests"] += omitted_manifests

    result["files"] = [by_file[path] for path in file_order]
    keys = _anchor_keys(anchor_files, deleted_paths)
    if keys and not tracked_error:
        consumers = _build_consumers(
            result, keys, workspace, changed_paths, changed_index, timeout, errors_seen,
            max_consumers_per_key, max_consumers, max_changed_consumers_per_key, max_changed_consumers,
        )
        if consumers:
            result["consumers"] = consumers
    counterpart_items = _anchor_counterparts(anchor_files, deleted_paths)
    if counterpart_items and not tracked_error:
        counterparts = _build_counterparts(result, counterpart_items, workspace, tracked_set, max_counterparts)
        if counterparts:
            result["counterparts"] = counterparts
    if result["errors"]:
        result["truncated"] = True
        result["truncation"]["truncated"] = True
        if "git_error" not in result["truncation"]["reasons"]:
            result["truncation"]["reasons"].append("git_error")
    result["truncation"]["truncated"] = result["truncated"]
    return result


def _json_dump(value: dict[str, Any], indent: int) -> str:
    return json.dumps(value, ensure_ascii=False, indent=min(max(0, int(indent)), 8), sort_keys=False) + "\n"


def _mark_json_cap(related: dict[str, Any]) -> None:
    related["truncated"] = True
    truncation = related.get("truncation")
    if not isinstance(truncation, dict):
        truncation = {}
        related["truncation"] = truncation
    truncation["truncated"] = True
    reasons = truncation.get("reasons")
    if not isinstance(reasons, list):
        reasons = []
        truncation["reasons"] = reasons
    if "json_cap" not in reasons:
        reasons.append("json_cap")
    truncation.setdefault("omitted_output_bytes", 0)


def _shrink_json_value(value: Any, limit: int) -> Any:
    if isinstance(value, str):
        return value if len(value) <= limit else value[: max(0, limit - 3)] + "..."
    if isinstance(value, list):
        return [_shrink_json_value(item, limit) for item in value]
    if isinstance(value, dict):
        return {key: _shrink_json_value(item, limit) for key, item in value.items()}
    return value


def _drop_list_tails(value: Any) -> bool:
    changed = False
    if isinstance(value, list):
        if len(value) > 1:
            del value[(len(value) + 1) // 2 :]
            changed = True
        for item in value:
            changed = _drop_list_tails(item) or changed
    elif isinstance(value, dict):
        for item in value.values():
            changed = _drop_list_tails(item) or changed
    return changed


def _minimal_json_artifact(related: dict[str, Any]) -> dict[str, Any]:
    original_truncation = related.get("truncation")
    truncation = {
        "truncated": True,
        "reasons": ["json_cap"],
        "omitted_output_bytes": 0,
    }
    if isinstance(original_truncation, dict):
        reasons = original_truncation.get("reasons")
        if isinstance(reasons, list):
            truncation["reasons"] = [str(reason)[:100] for reason in reasons[:20]]
            if "json_cap" not in truncation["reasons"]:
                truncation["reasons"].append("json_cap")
        for key in ("omitted_symbols", "omitted_references", "omitted_tests", "omitted_manifests"):
            value = original_truncation.get(key)
            if isinstance(value, int) and value >= 0:
                truncation[key] = value
    version = related.get("version", ARTIFACT_VERSION)
    if (
        isinstance(version, bool)
        or not isinstance(version, (int, float, str))
        or isinstance(version, str) and len(version) > 100
    ):
        version = ARTIFACT_VERSION
    minimal = {
        "version": version,
        "files": [],
        "truncated": True,
        "errors": [],
        "truncation": truncation,
    }
    _mark_json_cap(minimal)
    return minimal


def render_related_context_json(related: dict[str, Any], indent: int = 2) -> str:
    """Render valid JSON within the hard artifact byte limit by dropping data structurally."""
    cap = MAX_JSON_BYTES
    rendered = _json_dump(related, indent)
    if len(rendered.encode("utf-8")) <= cap:
        return rendered

    bounded = copy.deepcopy(related)
    _mark_json_cap(bounded)
    stages = [_drop_list_tails]
    for stage in stages:
        while True:
            rendered = _json_dump(bounded, indent)
            if len(rendered.encode("utf-8")) <= cap:
                bounded["truncation"]["omitted_output_bytes"] = max(
                    0, len(_json_dump(related, indent).encode("utf-8")) - len(rendered.encode("utf-8"))
                )
                return _json_dump(bounded, indent)
            if not stage(bounded):
                break

    for string_limit in (1000, 300, 100, 30):
        bounded = _shrink_json_value(bounded, string_limit)
        _mark_json_cap(bounded)
        rendered = _json_dump(bounded, indent)
        if len(rendered.encode("utf-8")) <= cap:
            bounded["truncation"]["omitted_output_bytes"] = max(
                0, len(_json_dump(related, indent).encode("utf-8")) - len(rendered.encode("utf-8"))
            )
            return _json_dump(bounded, indent)

    bounded = _minimal_json_artifact(related)
    rendered = _json_dump(bounded, 0)
    bounded["truncation"]["omitted_output_bytes"] = max(
        0, len(_json_dump(related, indent).encode("utf-8")) - len(rendered.encode("utf-8"))
    )
    return _json_dump(bounded, 0)


def _positive(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def _location(path: Any, line: Any) -> str:
    rendered = _code_span(_display(_path(path)))
    number = _positive(line)
    return f"{rendered}:{number}" if number else rendered


def _fenced(start: Any, lines: Any, indent: str) -> list[str]:
    first = _positive(start) or 1
    body = [
        f"{first + offset}: {_display(redact_text(str(text)), MAX_SNIPPET_CHARS)}"
        for offset, text in enumerate(lines if isinstance(lines, list) else [])
    ]
    longest = max((len(run) for text in body for run in _BACKTICK_RUN_RE.findall(text)), default=0)
    fence = "`" * max(3, longest + 1)
    return [f"{indent}{fence}", *(f"{indent}{text}" for text in body), f"{indent}{fence}"]


def _render_consumer_lines(related: dict[str, Any]) -> list[str]:
    consumers = related.get("consumers")
    if not isinstance(consumers, list) or not consumers:
        return []
    lines = [
        "## Consumers of Changed Keys",
        "",
        "_Lines that mention a config key, env var, flag, or compared variable from the changed lines, as written or in its kebab/snake/UPPER_SNAKE/INPUT_ form; a compared variable (`branch`) counts only where a line compares or switches on it. Unchanged files come first, then changed files outside the lines the diff shows. Textual matches, not proven consumers._",
        "",
    ]
    for consumer in consumers:
        if not isinstance(consumer, dict):
            continue
        key = _code_span(_display(str(consumer.get("key", ""))))
        kind = _display(str(consumer.get("kind", "")), 20)
        lines.append(f"- {key} ({kind}, {_location(consumer.get('source'), consumer.get('line'))}):")
        references = consumer.get("references")
        for reference in references if isinstance(references, list) else []:
            if not isinstance(reference, dict):
                continue
            match = reference.get("match")
            marker = " (changed file)" if reference.get("changed_file") is True else ""
            suffix = f" as {_code_span(_display(match))}" if isinstance(match, str) and match else ""
            location = f"  - {_location(reference.get('path'), reference.get('line'))}{marker}{suffix}"
            if isinstance(reference.get("lines"), list):
                lines.append(location)
                lines.extend(_fenced(reference.get("start"), reference.get("lines"), "    "))
            else:
                snippet = _code_span(_display(redact_text(str(reference.get("snippet", "")))))
                lines.append(f"{location} — {snippet}")
    lines.append("")
    return lines


def _render_counterpart_lines(related: dict[str, Any]) -> list[str]:
    counterparts = related.get("counterparts")
    if not isinstance(counterparts, list) or not counterparts:
        return []
    lines = [
        "## Referenced Counterparts",
        "",
        "_Declarations in repository files that added lines name, matched to the changed file's declarations by normalized name (e.g. `buildPrMetadata` and `_build_pr_metadata`). Bodies are bounded._",
        "",
    ]
    for item in counterparts:
        if not isinstance(item, dict):
            continue
        ref = f"{_location(item.get('ref_path'), item.get('ref_line'))} {_code_span(_display(str(item.get('ref_name', ''))))}"
        own = f"{_code_span(_display(str(item.get('name', ''))))} in {_location(item.get('path'), item.get('line'))}"
        notes = " (also changed in this PR)" if item.get("ref_changed") is True else ""
        lines.append(f"- {ref} for {own}{notes}:")
        lines.extend(_fenced(item.get("ref_line"), item.get("lines"), "  "))
        if item.get("lines_truncated") is True:
            lines.append(f"  _(body cut at {MAX_COUNTERPART_LINES} lines)_")
    lines.append("")
    return lines


def _render_lines(related: dict[str, Any]) -> list[str]:
    lines = [
        f"# Related Code (v{related.get('version', ARTIFACT_VERSION)})",
        "",
        "_Deterministic bounded textual references, test candidates, and nearest manifests. References are textual matches, not proven runtime callers._",
        "",
    ]
    lines.extend(_render_consumer_lines(related))
    lines.extend(_render_counterpart_lines(related))
    lines.extend(["## Changed Files", ""])
    files = related.get("files") or []
    if not files:
        lines.append("_(none)_")
    for file_entry in files:
        path = _display(_path(file_entry.get("path")))
        lines.extend([f"### {_code_span(path)}", ""])
        symbols = file_entry.get("symbols") or []
        if symbols:
            for symbol in symbols:
                name = _display(str(symbol.get("name", "")))
                refs = symbol.get("references") or []
                if not refs and symbol.get("only_in_changed_files") is True:
                    lines.append(f"- {_code_span(name)}: references only in changed files")
                elif not refs:
                    lines.append(f"- {_code_span(name)}: no references")
                else:
                    lines.append(f"- {_code_span(name)} references:")
                    for reference in refs:
                        ref_path = _code_span(_display(_path(reference.get("path", ""))))
                        line = reference.get("line", 0)
                        if not isinstance(line, int) or line < 0:
                            line = 0
                        snippet = _code_span(
                            _display(redact_text(str(reference.get("snippet", ""))))
                        )
                        marker = " (changed file)" if reference.get("changed_file") is True else ""
                        lines.append(f"  - {ref_path}:{line}{marker} — {snippet}")
        else:
            lines.append("- Symbols: none")
        tests = file_entry.get("tests") or []
        if tests:
            lines.append("- Tests: " + ", ".join(_code_span(_display(path)) for path in tests))
        else:
            lines.append("- Tests: none")
        manifests = file_entry.get("manifests") or []
        if manifests:
            lines.append(
                "- Manifests (nearest first): "
                + ", ".join(_code_span(_display(path)) for path in manifests)
            )
        else:
            lines.append("- Manifests: none")
        lines.append("")
    if related.get("errors"):
        lines.extend(["## Scanner Errors", ""])
        for error in related["errors"]:
            lines.append(f"- {_code_span(_display(str(error)))}")
        lines.append("")
    truncation = related.get("truncation") or {}
    if related.get("truncated") or truncation.get("truncated"):
        reasons = ", ".join(str(reason) for reason in truncation.get("reasons") or [])
        lines.extend(["## Bounds", "", f"_Output is bounded and incomplete ({_display(reasons or 'cap reached')})._"])
    return lines


def render_related_context_markdown(
    related: dict[str, Any], *, max_markdown_bytes: int | None = MAX_MARKDOWN_BYTES,
) -> str:
    """Render a compact line-bounded Markdown artifact with safe code spans."""
    lines = _render_lines(related)
    full = "\n".join(lines) + "\n"
    if max_markdown_bytes is None:
        return full
    cap = max(1, int(max_markdown_bytes))
    if len(full.encode("utf-8")) <= cap:
        return full
    note = f"_Markdown output cut at the {cap}-byte cap._"
    chosen: list[str] = []
    used = 0
    note_bytes = len((note + "\n").encode("utf-8"))
    for line in lines:
        line_bytes = len((line + "\n").encode("utf-8"))
        if used + line_bytes + note_bytes > cap:
            break
        chosen.append(line)
        used += line_bytes
    if not chosen:
        return "\n"
    return "\n".join(chosen + [note]) + "\n"


def _resolve_output(path: str, root: str) -> Path | None:
    if not path or "\x00" in path:
        return None
    try:
        root_path = Path(root).resolve()
        target = Path(path).resolve()
    except (OSError, ValueError):
        return None
    if not target.is_relative_to(root_path):
        return None
    return target


def _load_json(path: str) -> tuple[Any, str | None]:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8", errors="replace")), None
    except OSError:
        return None, "could not read JSON"
    except ValueError:
        return None, "invalid JSON"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build bounded related-code context from change anchors.")
    parser.add_argument("--anchors", default="change-anchors.json")
    parser.add_argument("--files", default="")
    parser.add_argument("--workspace", "--workspace-root", dest="workspace", default="")
    parser.add_argument("--json", "--output", dest="json_output", default="related-code.json")
    parser.add_argument("--markdown", default="related-code.md")
    parser.add_argument("--git-timeout", type=float, default=DEFAULT_GIT_TIMEOUT_SEC)
    args = parser.parse_args(argv)
    workspace = args.workspace or os.environ.get("GITHUB_WORKSPACE") or os.getcwd()

    anchor_data, anchor_error = _load_json(args.anchors)
    file_data: Any = []
    file_error: str | None = None
    if args.files:
        file_data, file_error = _load_json(args.files)
    if not isinstance(file_data, list):
        file_data = file_data.get("files", []) if isinstance(file_data, dict) else []
    result = build_related_context(anchor_data, workspace, file_data, git_timeout_sec=args.git_timeout)
    if anchor_error:
        result["errors"].insert(0, anchor_error)
        result["truncated"] = True
        result["truncation"]["truncated"] = True
    if file_error:
        result["errors"].append(file_error)
        result["truncated"] = True
        result["truncation"]["truncated"] = True
    result["truncation"]["truncated"] = result["truncated"]

    json_path = _resolve_output(args.json_output, workspace)
    markdown_path = _resolve_output(args.markdown, workspace)
    if json_path is None or markdown_path is None:
        print("Refusing to write an artifact outside the workspace root.", file=sys.stderr)
        return 1
    try:
        json_path.parent.mkdir(parents=True, exist_ok=True)
        markdown_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(render_related_context_json(result), encoding="utf-8")
        markdown_path.write_text(render_related_context_markdown(result), encoding="utf-8")
    except OSError as exc:
        print(f"related_context: could not write artifact: {exc}", file=sys.stderr)
        return 1
    print(
        f"related_context: {len(result['files'])} files, "
        f"{sum(len(item['symbols']) for item in result['files'])} symbols"
        + (" (truncated)" if result["truncated"] else "")
    )
    return 0


scan_related_context = build_related_context

if __name__ == "__main__":
    raise SystemExit(main())
