#!/usr/bin/env python3
"""v2 side of the enforcement-pipeline parity boundary (#680).

Runs the REAL production enforcement pipeline for one fixture, exactly as
`apply_all_enforcement_wrapper` composes it: `apply_verdict_policy` →
`apply_required_check_validation` → `apply_all_enforcement`, over the
fixture's artifacts written to a temp cwd (the production paths are
cwd-relative). The legacy keyword bridge is exercised only where the v2
code still applies it; #680's structured-authoritative v3 diverges there
and any such divergence must be pinned in approved-divergences.json.

Usage: v2_enforcement.py <fixture.json>
Emits exactly one JSON object on stdout:
  {"ok": true, "values": {"artifact": ..., "completeness_result": ...,
                           "required_checks": ..., "applied": ...,
                           ["requirement_coverage": ...]}}
  {"ok": false, "stderr": "..."}
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer import requirement_ledger  # noqa: E402
from pr_reviewer.completeness import apply_required_check_validation  # noqa: E402
from pr_reviewer.enforcement import apply_all_enforcement, apply_verdict_policy  # noqa: E402
from pr_reviewer.requirement_coverage import normalize_requirement_coverage  # noqa: E402


def canonical(value: object) -> str:
    """Canonical artifact VALUE form (sort_keys, ensure_ascii=False)."""
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    if fixture.get("contract") != "enforcement-pipeline/v1":
        raise RuntimeError("fixture is not enforcement-pipeline/v1")

    config = fixture.get("config") or {}
    with tempfile.TemporaryDirectory(prefix="parity-enforcement-") as td:
        workdir = Path(td)
        # Production enforcement reads/writes cwd-relative artifact paths
        # (ai-output.json, review-threads.json, …), so run in the temp cwd.
        previous_cwd = os.getcwd()
        os.chdir(workdir)
        try:
            values = _run_pipeline(fixture, config, workdir)
        finally:
            os.chdir(previous_cwd)

    print(json.dumps({"ok": True, "values": values}, ensure_ascii=False))
    return 0


def _run_pipeline(fixture: dict[str, Any], config: dict[str, Any], workdir: Path) -> dict[str, str]:
    def write(name: str, payload: object) -> None:
        (workdir / name).write_text(
            json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8"
        )

    artifact = fixture["artifact"]
    write("ai-output.json", artifact)
    if fixture.get("evidence") is not None:
        write("evidence-providers.json", fixture["evidence"])
    if fixture.get("tool_harness") is not None:
        write("tool-harness.json", fixture["tool_harness"])
    if fixture.get("threads") is not None:
        write("review-threads.json", fixture["threads"])
    if fixture.get("human_reviews") is not None:
        write("human-reviews.json", fixture["human_reviews"])
    classification = fixture.get("classification") or {}
    if fixture.get("must_check") is not None:
        classification = {**classification, "must_check": fixture["must_check"]}
    write("classification.json", classification)

    os.environ["VERDICT_POLICY"] = config.get("verdict_policy") or "model"
    os.environ["NON_BLOCKING_FINDING_CATEGORIES"] = config.get(
        "non_blocking_finding_categories", ""
    )

    apply_verdict_policy(config.get("verdict_policy") or "model", "ai-output.json")
    apply_required_check_validation(
        config.get("validate_required_checks") or "auto",
        config.get("required_check_validation_mode") or "warn",
        classification_path="classification.json",
        output_path="ai-output.json",
        result_path="completeness.json",
    )
    applied = apply_all_enforcement(
        evidence_blocker_enabled=config.get("evidence_blocker_enforcement") is True,
        tool_failure_enabled=config.get("tool_failure_enforcement") is True,
        tool_min_successful=config.get("tool_min_successful_requests") or 0,
        evidence_path="evidence-providers.json",
        tool_harness_path="tool-harness.json",
        output_path="ai-output.json",
    )

    result_artifact = json.loads((workdir / "ai-output.json").read_text(encoding="utf-8"))
    completeness = json.loads((workdir / "completeness.json").read_text(encoding="utf-8"))

    values: dict[str, str] = {
        "artifact": canonical(result_artifact),
        "completeness_result": canonical(completeness),
        "required_checks": str(result_artifact.get("required_checks") or "none"),
        "applied": str(applied),
    }

    if fixture.get("ledger") is not None:
        write("requirement-ledger.json", fixture["ledger"])
        ledger = requirement_ledger.load_ledger(str(workdir / "requirement-ledger.json"))
        payload = result_artifact.get("requirement_coverage")
        coverage_artifact = normalize_requirement_coverage(payload, ledger)
        values["requirement_coverage"] = canonical(coverage_artifact)

    return values


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 — runner infrastructure failure
        print(f"v2 enforcement runner error: {error}", file=sys.stderr)
        raise SystemExit(1)
