#!/usr/bin/env python3
"""Strip internal AI PR reviewer metadata markers from review markdown.

This prevents model-generated content from containing fake metadata markers
(<!-- ai-pr-review-fingerprint:... -->, <!-- ai-pr-review-sha:... -->) that
could interfere with the precheck parser when scanning comment bodies.

Reserved marker patterns:
  <!-- ai-pr-review-fingerprint:<value> -->
  <!-- ai-pr-review-sha:<sha> -->

Usage:
  cat review-body.md | python3 strip_metadata_markers.py          # stdin → stdout
  python3 strip_metadata_markers.py review-body.md                 # file in-place
  python3 strip_metadata_markers.py --dry-run review-body.md      # preview only
"""

import argparse
import re
import sys
from pathlib import Path

# Reserved internal metadata patterns — must stay in sync with action.yml.
RESERVED_PATTERNS = [
    re.compile(r'<!--\s*ai-pr-review-fingerprint\s*:\s*[^>]*-->', re.IGNORECASE),
    re.compile(r'<!--\s*ai-pr-review-sha\s*:\s*[^>]*-->', re.IGNORECASE),
]


def strip_reserved_markers(text: str) -> str:
    """Remove all reserved metadata marker comments from *text*.

    Returns a new string with matching markers replaced by an empty string.
    """
    for pattern in RESERVED_PATTERNS:
        text = pattern.sub("", text)
    return text


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Strip internal AI PR reviewer metadata markers from review markdown."
    )
    parser.add_argument("file", nargs="?", help="File to process (default: stdin)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the number of replacements without modifying the file.",
    )
    args = parser.parse_args()

    if args.file:
        content = Path(args.file).read_text(encoding="utf-8")
    else:
        content = sys.stdin.read()

    stripped = strip_reserved_markers(content)

    # Count replacements for reporting
    total = sum(
        len(p.findall(content))
        for p in RESERVED_PATTERNS
    )

    if args.dry_run:
        print(f"{total} marker(s) stripped (dry run).")
        print(stripped)
        return

    if args.file:
        Path(args.file).write_text(stripped, encoding="utf-8")
        print(f"Stripped {total} marker(s) from {args.file}.")
    else:
        sys.stdout.write(stripped)


if __name__ == "__main__":
    main()
