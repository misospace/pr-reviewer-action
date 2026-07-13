#!/usr/bin/env python3
"""Strip confabulated conditional output sections from review markdown.

Issue #415: even with a clean corpus (no "# Linked Issue Context" / "# Evidence
Providers" header), the model emits "## Linked Issue Fit" / "## Evidence
Provider Findings" sections padded with "nothing was found" filler. The
prompt-only fix (#416) tightens the instruction, but this exact failure mode
already recurred once, so this script is the deterministic backstop — the
publish-time equivalent of strip_metadata_markers.py.

Presence signals mirror the exact gates corpus.sh uses to decide whether to
emit the section headers in the first place ([ -s linked-issues.md ] and
[ -s evidence-providers.md ]). When a signal is absent, the matching output
section is removed (header through the next heading of the same or higher
level, or EOF). When present, the section is left untouched.

Usage:
  # stdin → stdout (presence via env, defaults to "present" = keep)
  LINKED_ISSUE_PRESENT=false EVIDENCE_PROVIDER_PRESENT=false \
    cat review.md | python3 strip_empty_conditional_sections.py
  # file in-place
  python3 strip_empty_conditional_sections.py review.md
  # dry-run (preview to stdout, no write)
  python3 strip_empty_conditional_sections.py --dry-run review.md

Env:
  LINKED_ISSUE_PRESENT        true when linked-issues.md is non-empty
  EVIDENCE_PROVIDER_PRESENT   true when evidence-providers.md is non-empty
"""

import argparse
import os
import re
import sys
from pathlib import Path

# Maps a canonical section key → the leading phrase a markdown heading must
# start with (case-insensitive) to count as that conditional section.
SECTION_HEADINGS = {
    "linked_issue": "linked issue",
    "evidence_provider": "evidence provider",
}

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
# CommonMark fenced code block opening: up to 3 leading spaces, then 3+ backticks
# or tildes. A line that opens a fence suspends heading parsing until it closes.
_FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")


def _section_absent(key: str, present: dict) -> bool:
    """True when the corpus presence signal for *key* is explicitly False.

    Missing keys default to present (fail-safe: never strip a section the
    caller forgot to report on).
    """
    return not present.get(key, True)


def _target_key(heading_text: str, present: dict):
    """Return the section key if *heading_text* names a conditional section
    whose presence signal is absent, else None."""
    low = heading_text.lower()
    for key, phrase in SECTION_HEADINGS.items():
        if low.startswith(phrase) and _section_absent(key, present):
            return key
    return None


def _line_opens_fence(line: str, fence_marker):
    """Toggle fenced-code-block state. Returns (is_fence_line, new_marker).

    A fence line is either an opener (marker None → set) or a closer matching
    the active marker. Non-fence lines are returned as-is.
    """
    m = _FENCE_RE.match(line)
    if not m:
        return False, fence_marker
    ch = m.group(1)[0]
    if fence_marker is None:
        return True, ch
    if ch == fence_marker:
        return True, None
    return False, fence_marker


def strip_empty_conditional_sections(text: str, present: dict) -> str:
    """Remove conditional output sections whose corpus signal is absent.

    Args:
        text: the model's review_markdown.
        present: maps section key ("linked_issue", "evidence_provider") to a
            truthy value when that corpus context was present. Missing keys
            default to present (kept).

    Returns:
        Cleaned markdown. When nothing matches, *text* is returned unchanged.
    """
    if not text:
        return ""
    present = present or {}
    lines = text.split("\n")
    remove = [False] * len(lines)

    in_fence = False
    fence_marker = None
    removed_any = False
    i = 0
    while i < len(lines):
        line = lines[i]

        is_fence, fence_marker = _line_opens_fence(line, fence_marker)
        if is_fence:
            in_fence = fence_marker is not None
            i += 1
            continue
        if in_fence:
            i += 1
            continue

        hm = _HEADING_RE.match(line)
        if hm:
            level = len(hm.group(1))
            if _target_key(hm.group(2), present) is not None:
                removed_any = True
                remove[i] = True
                # Consume the section body: everything until the next heading
                # of the same or higher level (outside a code fence) or EOF.
                j = i + 1
                jf_marker = None
                jf_in = False
                while j < len(lines):
                    l2 = lines[j]
                    jf_is, jf_marker = _line_opens_fence(l2, jf_marker)
                    if jf_is:
                        jf_in = jf_marker is not None
                        remove[j] = True
                        j += 1
                        continue
                    if jf_in:
                        remove[j] = True
                        j += 1
                        continue
                    hm2 = _HEADING_RE.match(l2)
                    if hm2 and len(hm2.group(1)) <= level:
                        break  # boundary heading belongs to the next section
                    remove[j] = True
                    j += 1
                i = j
                continue
        i += 1

    if not removed_any:
        return text

    kept = [l for l, rm in zip(lines, remove) if not rm]
    result = "\n".join(kept)
    # Collapse blank gaps left by the removal and tidy the document edges.
    result = re.sub(r"\n{3,}", "\n\n", result).strip("\n")
    return result


def _present_from_env(env) -> dict:
    def flag(name):
        return str(env.get(name, "")).strip().lower() == "true"

    return {
        "linked_issue": flag("LINKED_ISSUE_PRESENT"),
        "evidence_provider": flag("EVIDENCE_PROVIDER_PRESENT"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Strip confabulated conditional output sections from review markdown (#415)."
    )
    parser.add_argument("file", nargs="?", help="File to process (default: stdin)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the stripped output to stdout without modifying the file.",
    )
    args = parser.parse_args()

    if args.file:
        content = Path(args.file).read_text(encoding="utf-8")
    else:
        content = sys.stdin.read()

    present = _present_from_env(os.environ)
    stripped = strip_empty_conditional_sections(content, present)

    changed = stripped != content

    if args.dry_run:
        removed = [k for k in SECTION_HEADINGS if _section_absent(k, present)]
        sys.stdout.write(stripped)
        sys.stderr.write(
            f"\n[strip_empty_conditional_sections] present={present} "
            f"absent_keys={removed} changed={changed}\n"
        )
        return

    if args.file:
        if changed:
            Path(args.file).write_text(stripped, encoding="utf-8")
        print(f"Conditional sections stripped from {args.file} (changed={changed}).")
    else:
        sys.stdout.write(stripped)


if __name__ == "__main__":
    main()
