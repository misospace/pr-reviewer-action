#!/usr/bin/env python3
"""v2 side of the requirement-coverage parity boundary (#680, #624).

Runs the REAL production fold for one fixture: `load_ledger` (tolerant
validation, recomputed sha) then `normalize_requirement_coverage` over the
fixture's claims payload. Usage mirrors v2_enforcement.py.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer import requirement_ledger  # noqa: E402
from pr_reviewer.requirement_coverage import (  # noqa: E402
    DEFAULT_COVERAGE_KEY,
    normalize_requirement_coverage,
)


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    if fixture.get("contract") != "requirement-coverage/v1":
        raise RuntimeError("fixture is not requirement-coverage/v1")

    values: dict[str, str] = {}
    with tempfile.TemporaryDirectory(prefix="parity-req-coverage-") as td:
        ledger_path = Path(td) / "requirement-ledger.json"
        for case in fixture.get("cases") or []:
            ledger_path.write_text(
                json.dumps(case.get("ledger"), ensure_ascii=False) + "\n", encoding="utf-8"
            )
            ledger = requirement_ledger.load_ledger(str(ledger_path))
            payload = case.get("coverage")
            if isinstance(payload, dict):
                payload = payload.get(case.get("coverage_key") or DEFAULT_COVERAGE_KEY)
            artifact = normalize_requirement_coverage(payload, ledger)
            values[case["name"]] = canonical(artifact)

    print(json.dumps({"ok": True, "values": values}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 — runner infrastructure failure
        print(f"v2 requirement-coverage runner error: {error}", file=sys.stderr)
        raise SystemExit(1)
