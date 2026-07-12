#!/usr/bin/env python3
"""Strip review_markdown sections the model wrote without backing content.

The system prompt tells the model four sections are conditional — Linked
Issue Fit, Evidence Provider Findings, and Tool Harness Findings should only
appear when their corpus input exists — but a prose instruction is not a
guarantee: the model has been observed emitting the header anyway with a
"No X was present" filler sentence (#409, #414). This mirrors the corpus-side
fix in scripts/sections/corpus.sh (`[ -s linked-issues.md ]`-style gating) on
the *output* side, using the same presence signals, so the guarantee is
enforced mechanically rather than requested.

Runs after strip_metadata_markers.py and sanitize_review_markdown.py.

Usage:
  cat review-body.md | python3 strip_empty_report_sections.py          # stdin -> stdout
  python3 strip_empty_report_sections.py review-body.md                 # file in-place
  python3 strip_empty_report_sections.py --dry-run review-body.md      # preview only
"""

import argparse
import json
import re
import sys
from pathlib import Path

# Heading text must match scripts/default_system_prompt.txt's section names.
SECTION_HEADINGS = {
    "linked_issue_fit": "Linked Issue Fit",
    "evidence_provider_findings": "Evidence Provider Findings",
    "tool_harness_findings": "Tool Harness Findings",
}


def strip_section(text: str, heading: str) -> str:
    """Remove a level-2 `## {heading}` block, up to the next `## ` heading or EOF."""
    pattern = re.compile(
        r"^##[ \t]+" + re.escape(heading) + r"[ \t]*\n.*?(?=^##[ \t]|\Z)",
        re.IGNORECASE | re.MULTILINE | re.DOTALL,
    )
    return pattern.sub("", text)


def strip_empty_sections(text: str, present: dict) -> str:
    """Remove each conditional section whose backing content is absent.

    present: dict of SECTION_HEADINGS keys -> bool (True = keep the section).
    """
    for key, heading in SECTION_HEADINGS.items():
        if not present.get(key, True):
            text = strip_section(text, heading)
    # Removing a block can leave 3+ blank lines where it used to sit.
    return re.sub(r"\n{3,}", "\n\n", text)


def _file_nonempty(path: Path) -> bool:
    return path.is_file() and path.stat().st_size > 0


def _tool_harness_ran(path: Path) -> bool:
    if not path.is_file():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return False
    if data.get("executed_request_count", 0):
        return True
    return bool(data.get("tool_results"))


def detect_presence(cwd: Path) -> dict:
    """Read the same sibling files corpus.sh gates on to infer section presence."""
    return {
        "linked_issue_fit": _file_nonempty(cwd / "linked-issues.md"),
        "evidence_provider_findings": _file_nonempty(cwd / "evidence-providers.md"),
        "tool_harness_findings": _tool_harness_ran(cwd / "tool-harness.json"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Strip conditional review_markdown sections lacking backing content."
    )
    parser.add_argument("file", nargs="?", help="File to process (default: stdin)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the result without modifying the file.",
    )
    args = parser.parse_args()

    if args.file:
        content = Path(args.file).read_text(encoding="utf-8")
    else:
        content = sys.stdin.read()

    present = detect_presence(Path.cwd())
    stripped = strip_empty_sections(content, present)

    if args.dry_run:
        print(stripped)
        return

    if args.file:
        Path(args.file).write_text(stripped, encoding="utf-8")
    else:
        sys.stdout.write(stripped)


if __name__ == "__main__":
    main()
