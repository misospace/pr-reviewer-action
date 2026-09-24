#!/usr/bin/env python3
"""v2 side of the tool-request-budget parity boundary (#701, #673).

Runs the REAL production resolver boundary for one fixture: for every case,
launches `scripts/run_tool_harness.py` as a subprocess with an `env -i`-style
environment (PATH/HOME + the case's env) and a temp cwd, and reads the
budget telemetry it writes on the missing-corpus path (`tool_budget_tier` /
`tool_request_budget` / `tool_budget_source`). That path is deterministic
and offline — no corpus, no model, no network — so the fixture pins what
production actually resolves, not a reimplementation.

The fixture's `expected` (route, budget, source) is enforced HERE as well
as by the v3 side: both runners fail closed on any expectation mismatch, so
the absolute tier defaults (primary 8, smart 16, escalated 20), the hard
ceiling, and the #702 budget provenance are pinned, not just v2↔v3
agreement.

Usage: v2_tool_budget.py <fixture.json>
Emits exactly one JSON object on stdout:
  {"ok": true, "values": {"<case>": "<route>/<budget>/<source>", ...}}
  {"ok": false, "stderr": "..."}
Only infrastructure problems (unreadable fixture, harness crash) exit
nonzero; an expectation mismatch is a *result* (ok:false).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"
BUDGET_KEYS = ("TOOL_MAX_REQUESTS", "SMART_TOOL_MAX_REQUESTS", "TOOL_ESCALATION", "REVIEW_CONTEXT_PROFILE")


def run_case(case: dict, workdir: Path) -> dict:
    """Run the production harness once for a case; return its telemetry."""
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),
    }
    env.update({k: str(v) for k, v in case.get("env", {}).items()})
    if case.get("tier") == "smart":
        env["TOOL_HARNESS_TIER"] = "smart"

    proc = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "run_tool_harness.py")],
        cwd=str(workdir),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"harness exited {proc.returncode}: {proc.stderr.strip()[-400:]}"
        )
    stem = "tool-harness.smart" if case.get("tier") == "smart" else "tool-harness"
    artifact = workdir / f"{stem}.json"
    if not artifact.is_file():
        raise RuntimeError(f"harness wrote no {artifact.name}")
    telemetry = json.loads(artifact.read_text(encoding="utf-8"))
    for key in ("tool_budget_tier", "tool_request_budget", "tool_budget_source"):
        if key not in telemetry:
            raise RuntimeError(f"missing telemetry key {key}")
    return telemetry


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    if fixture.get("contract") != "tool-request-budget/v1":
        raise RuntimeError("fixture is not tool-request-budget/v1")
    cases = fixture.get("cases")
    if not isinstance(cases, list) or not cases:
        raise RuntimeError("fixture has no cases")

    values: dict[str, str] = {}
    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="parity-tool-budget-") as td:
        for case in cases:
            name = case["name"]
            case_dir = Path(td) / name
            case_dir.mkdir()
            telemetry = run_case(case, case_dir)
            route = telemetry["tool_budget_tier"]
            budget = telemetry["tool_request_budget"]
            source = telemetry["tool_budget_source"]
            values[name] = f"{route}/{budget}/{source}"
            expected = case.get("expected") or {}
            if (
                route != expected.get("route")
                or budget != expected.get("budget")
                or source != expected.get("source")
            ):
                failures.append(
                    f"{name}: expected "
                    f"{expected.get('route')}/{expected.get('budget')}/"
                    f"{expected.get('source')}, got {route}/{budget}/{source}"
                )

    if failures:
        print(json.dumps({"ok": False, "stderr": "; ".join(failures)}))
        return 0
    print(json.dumps({"ok": True, "values": values}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 — runner infrastructure failure
        print(f"v2 tool budget runner error: {error}", file=sys.stderr)
        raise SystemExit(1)
