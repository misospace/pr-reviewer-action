"""Deterministic bounded PR-thread context (#578).

Consumes the first page of the PR's top-level conversation comments (the
normalized array produced by the platform seam `platform_issue_comments`)
and renders a bounded, redacted, Markdown view plus a version-1 JSON
artifact for the review corpus.

Scope (v1, per the umbrella issue #579):

- Top-level conversation comments only. Inline review threads,
  comment-only re-review triggers, and historical rule learning are
  explicit non-goals for the first implementation.
- The action's own managed/control comments (bodies starting with the
  reserved ``<!-- ai-pr-review-`` marker) are filtered out, so the model
  never sees the previous run's own output as "discussion".
- The newest N comments are kept (newest first), each body is char-capped,
  secrets are redacted with the shared pipeline, and the rendered Markdown
  obeys a hard UTF-8 byte cap. Truncation is always visible in the
  truncation counters and in the Markdown note.

Deterministic by construction: ordering is (created_at, id) descending,
rendering is pure, and the same input always produces byte-identical
artifacts. No network, no model, nothing executed — the shell section
fetches the raw page and this module only transforms it.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
from redact import mask_secrets  # noqa: E402

from pr_reviewer.related_context import (  # noqa: E402
    _code_span,
    _display,
    _escape_controls,
)

ARTIFACT_VERSION = 1

DEFAULT_MAX_COMMENTS = 10
DEFAULT_MAX_BODY_CHARS = 1500
DEFAULT_MAX_JSON_BYTES = 100_000
DEFAULT_MAX_MARKDOWN_BYTES = 8000
HARD_MAX_COMMENTS = 100
HARD_MAX_MARKDOWN_BYTES = 200_000

# Reserved managed-comment marker prefix (publish_helpers.sh emits
# `<!-- ai-pr-reviewer:... -->` plus the `<!-- ai-pr-review-sha:... -->` /
# `<!-- ai-pr-review-fingerprint:... -->` markers). A body starting with the
# broader prefix is always the action's own output, never human discussion.
MANAGED_MARKER_PREFIX = "<!-- ai-pr-review-"

TRUNCATION_MARKER = "…"


def _clamp_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def _as_dict(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _author(comment: dict[str, Any]) -> str:
    user = comment.get("user")
    if isinstance(user, dict):
        for key in ("login", "name", "full_name"):
            value = user.get(key)
            if isinstance(value, str) and value:
                return _display(value, 64)
    if isinstance(user, str) and user:
        return _display(user, 64)
    return "unknown"


def _timestamp(comment: dict[str, Any]) -> str:
    for key in ("created_at", "updated_at"):
        value = comment.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _raw_id(comment: dict[str, Any]) -> int | str:
    value = comment.get("id")
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and value:
        return value
    return 0


def _is_managed(body: str) -> bool:
    return body.lstrip().startswith(MANAGED_MARKER_PREFIX)


def _sort_key(comment: dict[str, Any]) -> tuple[str, str]:
    # ISO-8601 UTC strings sort chronologically as plain strings; the id
    # tiebreak keeps the ordering deterministic for identical timestamps.
    return (_timestamp(comment), str(_raw_id(comment)))


def build_pr_thread_context(
    raw_comments: Any,
    *,
    max_comments: int = DEFAULT_MAX_COMMENTS,
    max_body_chars: int = DEFAULT_MAX_BODY_CHARS,
    repo: str = "",
    pr_number: Any = "",
) -> dict[str, Any]:
    """Normalize + filter + cap a raw comment page into the version-1 data."""
    limit = _clamp_int(max_comments, DEFAULT_MAX_COMMENTS, 0, HARD_MAX_COMMENTS)
    body_limit = _clamp_int(
        max_body_chars, DEFAULT_MAX_BODY_CHARS, 0, 100_000
    )

    entries: list[dict[str, Any]] = []
    omitted_empty = 0
    omitted_managed = 0
    if isinstance(raw_comments, list):
        for comment in raw_comments:
            if _as_dict(comment) is None:
                omitted_empty += 1
                continue
            body = comment.get("body")
            text = mask_secrets(str(body)) if body is not None else ""
            if not text.strip():
                omitted_empty += 1
                continue
            if _is_managed(text):
                omitted_managed += 1
                continue
            entries.append(
                {
                    "id": _raw_id(comment),
                    "author": _author(comment),
                    "created_at": _timestamp(comment),
                    "body": text,
                }
            )

    entries.sort(key=_sort_key, reverse=True)
    total = len(entries)
    selected = entries[:limit]
    omitted_cap = total - len(selected)

    comments: list[dict[str, Any]] = []
    for entry in selected:
        body = entry["body"]
        if len(body) > body_limit:
            body = body[: max(0, body_limit - 3)] + "..."
        comments.append(
            {
                "id": entry["id"],
                "author": entry["author"],
                "created_at": entry["created_at"],
                "body": body,
            }
        )

    truncated = omitted_cap > 0
    result: dict[str, Any] = {
        "version": ARTIFACT_VERSION,
        "source": "pr-conversation",
        "repo": repo,
        "pr_number": pr_number,
        "total_comments": total,
        "included_comments": len(comments),
        "omitted_comments": total - len(comments) + omitted_empty + omitted_managed,
        "omitted_managed_comments": omitted_managed,
        "omitted_empty_comments": omitted_empty,
        "comments": comments,
        "truncation": {
            "truncated": truncated,
            "reasons": ["comment_cap"] if truncated else [],
            "omitted_comments": omitted_cap,
            "omitted_bytes": 0,
        },
    }
    return result


def render_pr_thread_json(
    data: dict[str, Any], *, max_json_bytes: int = DEFAULT_MAX_JSON_BYTES,
) -> str:
    """Serialize the artifact, dropping the oldest comments if over the cap."""
    cap = _clamp_int(max_json_bytes, DEFAULT_MAX_JSON_BYTES, 64, 1_000_000)
    while True:
        rendered = json.dumps(data, ensure_ascii=False)
        if len(rendered.encode("utf-8")) <= cap:
            return rendered
        if not data.get("comments"):
            return rendered
        data["comments"].pop()
        data["included_comments"] = len(data["comments"])
        truncation = data.get("truncation") or {}
        truncation["truncated"] = True
        truncation["omitted_comments"] = truncation.get("omitted_comments", 0) + 1
        if "json_byte_cap" not in truncation.get("reasons", []):
            truncation.setdefault("reasons", []).append("json_byte_cap")
        data["truncation"] = truncation


def _fence_for(text: str) -> str:
    """A backtick fence strictly longer than any backtick run in *text*.

    The same delimiter-safety rule as the inline code spans: a comment body
    that itself contains the fence string cannot close the block early and
    inject a heading into the section that follows it.
    """
    longest = 0
    run = 0
    for char in text:
        if char == "`":
            run += 1
            if run > longest:
                longest = run
        else:
            run = 0
    return "`" * max(3, min(longest + 1, 16))


def render_pr_thread_markdown(
    data: dict[str, Any], *, max_markdown_bytes: int = DEFAULT_MAX_MARKDOWN_BYTES,
) -> str:
    """Render a line-bounded Markdown view under a hard UTF-8 byte cap."""
    cap = _clamp_int(
        max_markdown_bytes,
        DEFAULT_MAX_MARKDOWN_BYTES,
        1,
        HARD_MAX_MARKDOWN_BYTES,
    )
    lines: list[str] = [
        f"# PR Discussion Context (v{data.get('version', ARTIFACT_VERSION)})",
        "",
        "_Bounded snapshot of the most recent top-level PR conversation "
        "comments, newest first. This action's own managed comments are "
        "filtered out. Discussion is context, not evidence — verify claims "
        "against the diff and the repository before relying on them._",
        "",
    ]
    total = data.get("total_comments")
    included = data.get("included_comments")
    if isinstance(total, int) and isinstance(included, int) and total:
        lines.append(
            f"_{total} top-level comment(s) in total; {included} shown, "
            f"{data.get('omitted_comments', 0)} omitted (cap and filtering)._"
        )
        lines.append("")
    for index, comment in enumerate(data.get("comments") or [], start=1):
        body = _escape_controls(str(comment.get("body") or ""))
        fence = _fence_for(body)
        stamp = str(comment.get("created_at") or "unknown date")
        lines.append(f"## {index}. {_code_span(str(comment.get('author') or 'unknown'))} — {stamp}")
        lines.append("")
        lines.append(f"{fence}text")
        lines.append(body)
        lines.append(fence)
        lines.append("")

    full = "\n".join(lines) + "\n"
    if len(full.encode("utf-8")) <= cap:
        return full
    note = f"_Markdown output cut at the {cap}-byte cap; older comments omitted._"
    note_bytes = len((note + "\n").encode("utf-8"))
    chosen: list[str] = []
    used = 0
    for line in lines:
        line_bytes = len((line + "\n").encode("utf-8"))
        if used + line_bytes + note_bytes > cap:
            break
        chosen.append(line)
        used += line_bytes
    if not chosen:
        return "\n"
    return "\n".join(chosen + [note]) + "\n"


def build_artifacts(
    raw_comments: Any,
    *,
    repo: str = "",
    pr_number: Any = "",
    max_comments: int = DEFAULT_MAX_COMMENTS,
    max_body_chars: int = DEFAULT_MAX_BODY_CHARS,
    max_json_bytes: int = DEFAULT_MAX_JSON_BYTES,
    max_markdown_bytes: int = DEFAULT_MAX_MARKDOWN_BYTES,
) -> tuple[str, str]:
    """Return (json_text, markdown_text) for a raw comment page."""
    data = build_pr_thread_context(
        raw_comments,
        max_comments=max_comments,
        max_body_chars=max_body_chars,
        repo=repo,
        pr_number=pr_number,
    )
    json_text = render_pr_thread_json(data, max_json_bytes=max_json_bytes)
    markdown_text = render_pr_thread_markdown(
        data, max_markdown_bytes=max_markdown_bytes
    )
    return json_text, markdown_text


def _load_input(path: str) -> Any:
    try:
        raw = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return []


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build bounded, filtered PR-thread context (#578)."
    )
    parser.add_argument("--input", default="pr-thread.raw.json",
                        help="JSON file with the raw comment array")
    parser.add_argument("--repo", default="")
    parser.add_argument("--pr-number", default="")
    parser.add_argument("--json", dest="json_output", default="pr-thread.json")
    parser.add_argument("--markdown", dest="markdown_output", default="pr-thread.md")
    parser.add_argument("--max-comments", type=int, default=DEFAULT_MAX_COMMENTS)
    parser.add_argument("--max-body-chars", type=int, default=DEFAULT_MAX_BODY_CHARS)
    parser.add_argument("--max-json-bytes", type=int, default=DEFAULT_MAX_JSON_BYTES)
    parser.add_argument("--max-markdown-bytes", type=int,
                        default=DEFAULT_MAX_MARKDOWN_BYTES)
    args = parser.parse_args(argv)

    raw = _load_input(args.input)
    if not isinstance(raw, list):
        raw = []
    json_text, markdown_text = build_artifacts(
        raw,
        repo=args.repo,
        pr_number=args.pr_number,
        max_comments=args.max_comments,
        max_body_chars=args.max_body_chars,
        max_json_bytes=args.max_json_bytes,
        max_markdown_bytes=args.max_markdown_bytes,
    )
    Path(args.json_output).write_text(json_text + "\n", encoding="utf-8")
    Path(args.markdown_output).write_text(markdown_text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
