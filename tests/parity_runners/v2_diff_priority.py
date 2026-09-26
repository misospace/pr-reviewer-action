#!/usr/bin/env python3
"""Parity runner (v2 side, diff-priority boundary): runs the real
pr_reviewer.diff_priority.prioritize_diff against a fixture diff and prints
the output as base64 (invalid UTF-8 must survive the JSON round trip) for
comparison with the v3 port (src/corpus/diff-priority.ts)."""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer.diff_priority import DEFAULT_MARKER, prioritize_diff  # noqa: E402


def decode_content(content) -> bytes:
    if isinstance(content, str):
        return content.encode("utf-8")
    if isinstance(content, dict) and isinstance(content.get("b64"), str):
        return base64.b64decode(content["b64"])
    return ((content or {}).get("text") or "").encode("utf-8")


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    diff = decode_content(fixture.get("diff"))
    budget = fixture.get("budget")
    marker = fixture["marker"].encode("utf-8") if isinstance(fixture.get("marker"), str) else DEFAULT_MARKER
    output = prioritize_diff(
        diff,
        budget if isinstance(budget, int) else 0,
        generated=frozenset(fixture.get("generated") or []),
        marker=marker,
    )
    values = {
        "output_b64": base64.b64encode(output).decode("ascii"),
        "output_bytes": str(len(output)),
    }
    print(json.dumps({"ok": True, "values": values}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
