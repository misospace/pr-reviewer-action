#!/usr/bin/env python3
"""Extract the production corpus-assembly slices for the #676 parity runner.

Slices verbatim (never copied) so the runner cannot drift from production:

- scripts/sections/config.sh: apply_context_limits + the per-tier profile
  resolution (through the truncate_clean comment block);
- scripts/sections/config.sh: truncate_clean (same slice as
  tests/parity_runners/truncate_clean.sh);
- scripts/sections/common.sh: log/error + gate_feature_for_forks;
- scripts/sections/corpus.sh: source-time standards/tool-harness preparation,
  build_bounded_repo_map, build_review_corpus, and the tool-harness block.

Every marker must match exactly or this exits nonzero — a silent empty slice
would fake parity (same rule as truncate_clean.sh's vulnerable mutation).
"""

from __future__ import annotations

import sys
from pathlib import Path


def slice_between(text: str, start: str, end: str, label: str) -> str:
    begin = text.index(start)
    stop = text.index(end, begin + len(start))
    body = text[begin:stop]
    if not body.strip():
        raise SystemExit(f"empty slice: {label}")
    return body


def slice_to_eof(text: str, start: str, label: str) -> str:
    begin = text.index(start)
    body = text[begin:]
    if not body.strip():
        raise SystemExit(f"empty slice: {label}")
    return body


def next_def(text: str, start: int) -> int:
    """Index of the next top-level `name() {` definition at column 0 after start."""
    offset = text.find("\n", start)
    while offset != -1:
        end = text.find("\n", offset + 1)
        line = text[offset + 1 : end if end != -1 else len(text)]
        stripped = line.rstrip()
        if stripped.endswith("() {") and stripped[: -len("() {")].isidentifier():
            return offset + 1
        offset = end
    return len(text)


def main() -> int:
    root = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    config = (root / "scripts" / "sections" / "config.sh").read_text(encoding="utf-8")
    common = (root / "scripts" / "sections" / "common.sh").read_text(encoding="utf-8")
    corpus = (root / "scripts" / "sections" / "corpus.sh").read_text(encoding="utf-8")

    slices = {
        # apply_context_limits through the tier-profile resolution, including
        # its source-time global call and tier validation loop.
        "budgets.sh": slice_between(
            config, "apply_context_limits() {", "# Truncate SRC into DST", "budgets"
        ),
        # Same slice truncate_clean.sh uses.
        "truncate.sh": slice_between(
            config, "truncate_clean() {", '\nif [[ -z "$REPO"', "truncate"
        ),
        # common.sh log/error helpers (through the end of error()).
        "log_error.sh": common[common.index("log() {") : next_def(common, common.index("log() {"))],
        "gate_forks.sh": common[
            common.index("gate_feature_for_forks() {") : next_def(
                common, common.index("gate_feature_for_forks() {")
            )
        ],
        # corpus.sh source-time standards + tool-harness preparation.
        "prepare.sh": slice_between(
            corpus, ": > standards-context.md", "build_bounded_repo_map() {", "prepare"
        ),
        "bounded_repo_map.sh": slice_between(
            corpus, "build_bounded_repo_map() {", "build_review_corpus() {", "bounded_repo_map"
        ),
        "build_review_corpus.sh": slice_between(
            corpus,
            "build_review_corpus() {",
            'section_timer_start "corpus-building"',
            "build_review_corpus",
        ),
        # The tool-harness block (fork gate, harness invocation, failure
        # artifacts, post-harness rebuild + cp).
        "tool_harness_block.sh": slice_to_eof(
            corpus,
            'case "$(printf \'%s\' "$TOOL_MODE" | tr \'[:upper:]\' \'[:lower:]\')" in native_loop) TOOL_HARNESS_ENABLED=',
            "tool_harness_block",
        ),
    }

    for name, body in slices.items():
        (out_dir / name).write_text(body, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
