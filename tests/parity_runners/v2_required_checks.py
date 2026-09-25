#!/usr/bin/env python3
"""Parity runner (v2 side, required-check-coverage boundary, #750): runs the
real pr_reviewer.completeness.evaluate_structured_coverage against a fixture
and prints the canonical version-1 coverage artifact for the harness to
compare with the v3 evaluator in src/enforcement/required-checks.ts."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer.completeness import evaluate_structured_coverage  # noqa: E402


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace"))
    try:
        coverage = evaluate_structured_coverage(
            # The boundary tests the evaluator, not the loader: both sides
            # take the fixture's string entries verbatim and pass the
            # dispositions array through untouched so hostile content
            # exercises the same defensive path on both sides.
            [c for c in (fixture.get("must_check") or []) if isinstance(c, str)],
            fixture.get("dispositions") if isinstance(fixture.get("dispositions"), list) else None,
        )
    except Exception as exc:  # never expected; fail loudly rather than drift
        print(json.dumps({"ok": False, "stderr": f"{type(exc).__name__}: {exc}"}))
        return 0
    print(json.dumps({
        "ok": True,
        "values": {"coverage": json.dumps(coverage, sort_keys=True, ensure_ascii=False)},
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
