#!/usr/bin/env python3
"""Turn structured findings into native PR review comments[] entries.

Reads a findings JSON array and the PR's unified diff, keeps only findings
that anchor to a commentable line (a new-side line present in a diff hunk —
GitHub rejects review comments outside the diff), and emits the comments[]
payload for POST /repos/{owner}/{repo}/pulls/{n}/reviews.

Usage: build_review_comments.py FINDINGS_JSON_FILE DIFF_FILE OUTPUT_FILE

Environment:
  INLINE_FINDINGS_MAX     maximum comments to emit (default 20)
"""

import json
import os
import re
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from redact import mask_secrets  # noqa: E402
from sanitize_review_markdown import sanitize_markdown  # noqa: E402


_HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")

_SEVERITY_LABELS = {
    "blocker": "🛑 Blocker",
    "major": "⚠️ Major",
    "minor": "Minor",
    "info": "Info",
}


def commentable_lines(diff_text: str) -> dict:
    """Map new-side file path -> set of commentable line numbers.

    Commentable lines are added (+) and context lines inside hunks — the
    new-side lines GitHub accepts for a review comment with side=RIGHT.
    """
    return {path: set(mapping) for path, mapping in diff_positions(diff_text).items()}


def diff_positions(diff_text: str) -> dict:
    """Map new-side file path -> {new_line: diff-relative position}.

    GitHub review comments use the final-file line plus ``side=RIGHT``.
    Forgejo/Gitea review comments use ``new_position`` instead: a position in
    the file's patch body. Track both from the same hunk walk so the two
    publish backends anchor the same validated finding lines.
    """
    positions_by_path: dict = {}
    current_path = None
    new_line = 0
    diff_position = 0
    in_hunk = False

    for raw in diff_text.splitlines():
        if raw.startswith("diff --git "):
            current_path = None
            in_hunk = False
            diff_position = 0
            continue
        if raw.startswith("+++ "):
            target = raw[4:].strip()
            if target == "/dev/null":
                current_path = None
            else:
                current_path = target[2:] if target.startswith("b/") else target
            continue
        match = _HUNK_RE.match(raw)
        if match:
            new_line = int(match.group(1))
            in_hunk = True
            continue
        if not in_hunk or current_path is None:
            continue
        if raw.startswith("\\"):
            # "\ No newline at end of file" is metadata, not a diff slot.
            continue

        diff_position += 1
        if raw.startswith("+"):
            positions_by_path.setdefault(current_path, {})[new_line] = diff_position
            new_line += 1
        elif raw.startswith("-"):
            continue
        else:
            positions_by_path.setdefault(current_path, {})[new_line] = diff_position
            new_line += 1

    return positions_by_path


def _safe_path(path) -> bool:
    if not isinstance(path, str) or not path:
        return False
    if path.startswith("/"):
        return False
    return ".." not in path.split("/")


def finding_to_body(finding: dict) -> str:
    severity = finding.get("severity") or "info"
    label = _SEVERITY_LABELS.get(severity, severity)
    category = finding.get("category")
    suffix = f" ({category})" if category and category != "other" else ""
    message = str(finding.get("message") or "").strip()
    body = f"**{label}{suffix}:** {message}\n\n_Automated finding from AI PR review._"
    # UPSTREAM_LINK_MODE (#561) keeps inline findings consistent with the
    # summary comment's upstream-link handling. Inline comment building is
    # best-effort, so an unrecognized mode falls back to inert rather than
    # failing the publish.
    link_mode = os.environ.get("UPSTREAM_LINK_MODE", "inert")
    if link_mode not in ("inert", "togithub"):
        link_mode = "inert"
    return sanitize_markdown(mask_secrets(body), link_mode=link_mode)


def build_comments(findings, diff_text: str, max_comments: int = 20):
    """Return (comments, skipped_count) for the anchorable findings.

    Skipped findings are the non-anchorable ones (no valid new-side diff
    line) and non-object entries.
    """
    if not isinstance(findings, list):
        return [], 0

    use_forgejo_positions = (
        os.getenv("REVIEW_COMMENT_POSITION_BACKEND", "").lower() in {"forgejo", "gitea"}
        or os.getenv("PLATFORM", "").lower() == "forgejo"
    )
    position_map = diff_positions(diff_text)
    anchors = {path: set(mapping) for path, mapping in position_map.items()}
    comments = []
    skipped = 0

    for finding in findings:
        if not isinstance(finding, dict):
            skipped += 1
            continue
        path = finding.get("file")
        line = finding.get("line")
        if (
            not _safe_path(path)
            or not isinstance(line, int)
            or line <= 0
            or path not in anchors
            or line not in anchors[path]
        ):
            skipped += 1
            continue
        comment = {
            "path": path,
            "body": finding_to_body(finding),
        }
        if use_forgejo_positions:
            comment["new_position"] = position_map[path][line]
        else:
            comment["line"] = line
            comment["side"] = "RIGHT"
        comments.append(comment)
        if len(comments) >= max_comments:
            break

    return comments, skipped


def main(argv) -> int:
    findings_path, diff_path, output_path = argv[1], argv[2], argv[3]

    try:
        findings = json.loads(Path(findings_path).read_text(encoding="utf-8", errors="replace"))
    except Exception:
        findings = []
    try:
        diff_text = Path(diff_path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        diff_text = ""

    try:
        max_comments = max(1, int(os.getenv("INLINE_FINDINGS_MAX", "20")))
    except ValueError:
        max_comments = 20

    comments, skipped = build_comments(findings, diff_text, max_comments)
    Path(output_path).write_text(
        json.dumps(comments, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(
        f"inline findings: {len(comments)} anchored comment(s), "
        f"{skipped} finding(s) skipped (not anchorable)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
