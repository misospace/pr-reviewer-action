#!/usr/bin/env python3
"""Truncate a PR diff into a byte budget, source files first.

Usage: prioritize_diff.py SRC DST BUDGET [MARKER]

Replaces ``truncate_clean`` for the diff only (scripts/sections/context.sh
and corpus.sh): same budget, same marker, but the surviving bytes are chosen
by pr_reviewer.diff_priority instead of file order. Inside a git worktree
the ``linguist-generated`` attribute demotes generated files; outside one
(or when git fails) no path is treated as generated.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pr_reviewer.diff_priority import DEFAULT_MARKER, chunk_paths, prioritize_diff  # noqa: E402


def generated_paths(paths: list[bytes]) -> frozenset[str]:
    if not paths:
        return frozenset()
    try:
        proc = subprocess.run(
            ["git", "check-attr", "--stdin", "-z", "linguist-generated"],
            input=b"\0".join(paths) + b"\0",
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return frozenset()
    if proc.returncode != 0:
        return frozenset()
    fields = proc.stdout.split(b"\0")
    generated: set[str] = set()
    for i in range(0, len(fields) - 2, 3):
        if fields[i + 2] in (b"set", b"true"):
            generated.add(fields[i].decode("utf-8", "replace"))
    return frozenset(generated)


def main(argv: list[str]) -> int:
    if len(argv) < 4:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    src, dst, budget = Path(argv[1]), Path(argv[2]), int(argv[3])
    marker = argv[4].encode("utf-8") if len(argv) > 4 else DEFAULT_MARKER
    data = src.read_bytes() if src.exists() else b""
    generated = generated_paths(chunk_paths(data)) if len(data) > budget else frozenset()
    dst.write_bytes(prioritize_diff(data, budget, generated=generated, marker=marker))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
