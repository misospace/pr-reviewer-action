"""Deterministic bounded related-code context from change anchors (#572).

The builder consumes the version-1 change-anchor artifact and a checked-out Git
worktree. It searches only high-confidence symbol anchors, discovers likely test
paths and nearest project manifests, and emits bounded relationship data without
executing repository code or making network/model calls.
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
from typing import Any, Iterable

ARTIFACT_VERSION = 1
MAX_SYMBOLS = 40
MAX_REFERENCES_PER_SYMBOL = 20
MAX_REFERENCES = 200
MAX_TESTS_PER_FILE = 20
MAX_MANIFESTS_PER_FILE = 20
MAX_SNIPPET_CHARS = 300
DEFAULT_GIT_TIMEOUT_SEC = 10
MAX_JSON_BYTES = 100_000
MAX_MARKDOWN_BYTES = 100_000
MAX_ERROR_CHARS = 300

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
from redact import mask_secrets  # noqa: E402

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_BACKTICK_RUN_RE = re.compile(r"`+")
_TEST_BASE_RE = re.compile(
    r"^(?:test[-_].+|.+[_-]tests?\..+|.+\.(?:test|spec)(?:\.[^.]+)?|.+_test\.go)$",
    re.IGNORECASE,
)
_MANIFEST_BASE_RE = re.compile(
    r"^(?:pyproject\.toml|setup\.(?:py|cfg)|requirements[^/]*\.txt|"
    r"package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|go\.(?:mod|sum)|"
    r"Cargo\.(?:toml|lock)|Gemfile(?:\.lock)?|pom\.xml|build\.gradle(?:\.kts)?|"
    r"composer\.json|Pipfile(?:\.lock)?|poetry\.lock|uv\.lock|mix\.(?:exs|lock)|"
    r"Dockerfile[^/]*|action\.ya?ml)$",
    re.IGNORECASE,
)


def _bounded_text(value: Any, limit: int = MAX_ERROR_CHARS) -> str:
    text = mask_secrets(str(value or "")).replace("\x00", "\\u0000")
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
    text = mask_secrets(value)
    text = _escape_controls(text)
    if len(text) > MAX_SNIPPET_CHARS:
        return text[: MAX_SNIPPET_CHARS - 3] + "..."
    return text


def git_grep_references(
    symbol: str,
    workspace: str | os.PathLike[str],
    *,
    excluded_paths: set[str],
    timeout: float = DEFAULT_GIT_TIMEOUT_SEC,
    max_hits: int = MAX_REFERENCES_PER_SYMBOL,
) -> tuple[list[dict[str, Any]], bool, str | None]:
    """Stream eligible symbol matches without buffering an unbounded result."""
    limit = max(0, int(max_hits))
    if limit == 0:
        return [], False, None
    excluded = excluded_paths or set()
    try:
        proc = subprocess.Popen(
            ["git", "grep", "-n", "-F", "--", symbol, "--", "."],
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


def _is_test_path(path: str) -> bool:
    parts = [part.lower() for part in path.split("/")]
    base = parts[-1] if parts else ""
    if any(part in {"test", "tests", "spec", "specs", "testing", "__tests__"} for part in parts[:-1]):
        return True
    return bool(_TEST_BASE_RE.match(base)) or base.endswith("_test.go")


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
    references_total = 0
    errors_seen = set(result["errors"])
    refs_by_file: dict[str, list[dict[str, Any]]] = {path: [] for path in file_order}
    for source, name, _ in selected_symbols:
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


def _render_lines(related: dict[str, Any]) -> list[str]:
    lines = [
        f"# Related Code (v{related.get('version', ARTIFACT_VERSION)})",
        "",
        "_Deterministic bounded textual references, test candidates, and nearest manifests. References are textual matches, not proven runtime callers._",
        "",
        "## Changed Files",
        "",
    ]
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
                if not refs:
                    lines.append(f"- {_code_span(name)}: no references")
                else:
                    lines.append(f"- {_code_span(name)} references:")
                    for reference in refs:
                        ref_path = _code_span(_display(_path(reference.get("path", ""))))
                        line = reference.get("line", 0)
                        if not isinstance(line, int) or line < 0:
                            line = 0
                        snippet = _code_span(
                            _display(mask_secrets(str(reference.get("snippet", ""))))
                        )
                        lines.append(f"  - {ref_path}:{line} — {snippet}")
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
