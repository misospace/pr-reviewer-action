#!/usr/bin/env python3
"""Run the deterministic semantic regression corpus without network or models."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pr_reviewer.semantic_eval import SemanticCorpus, evaluate_semantic_corpus, validate_semantic_corpus


DETERMINISTIC_SCENARIOS = frozenset(
    {
        623, 6231, 638, 644, 645, 6451, 8004,
        # PR #654 execution-boundary / lifecycle failure classes (#659).
        6541, 6542, 6543, 6544, 6545, 6546, 6547, 6548, 6549, 6550,
        # PR #655 producer/artifact/consumer and PR #689 evidence transport (#662).
        6551, 6552, 6553, 6891, 6892,
        # PR #748 / #750 required-check grounding (ungrounded N/A converse + clean-shape control).
        7480, 7481,
        # PR #756 counterexample-falsification failure classes (#757): four
        # path-domain classes plus three cross-domain classes, each with a
        # fixed negative control.
        7571, 7572, 7573, 7574, 7575, 7576, 7577, 7578,
        7579, 7580, 7581, 7582, 7583, 7584,
        # #876: sanitizer-inserted redaction markers must never be
        # misattributed as committed source (PR #862 regression).
        8760,
    }
)


DATAFLOW_GATE_TEST_FILE = ".test-build/tests-v3/qualification-dataflow.test.js"


def _resolve_node() -> str | None:
    return os.environ.get("PR_REVIEWER_NODE") or shutil.which("node")


def _ensure_dataflow_gate_built(node: str) -> str | None:
    """Build .test-build (tsc -p tsconfig.test.json), like `npm test` does
    before `node --test`, so the gate can run against the compiled v3
    runtime without depending on a prior `npm test` invocation. Always
    recompiles: `.test-build` is gitignored and can persist locally between
    runs, so trusting a pre-existing copy risks a stale-JS false green. The
    expected output is removed first, because tsc does not clean its outDir:
    a renamed or removed test source would otherwise leave the old JS behind.
    Returns an error string on failure, None on success."""
    tsc = ROOT / "node_modules/typescript/bin/tsc"
    if not tsc.is_file():
        return f"{tsc} not found; run `npm ci` first"
    (ROOT / DATAFLOW_GATE_TEST_FILE).unlink(missing_ok=True)
    completed = subprocess.run(
        [node, str(tsc), "-p", "tsconfig.test.json"], cwd=ROOT, capture_output=True, text=True, timeout=180, check=False,
    )
    if completed.returncode != 0 or not (ROOT / DATAFLOW_GATE_TEST_FILE).is_file():
        return (completed.stdout + completed.stderr)[-2000:] or "tsc did not produce " + DATAFLOW_GATE_TEST_FILE
    return None


def run_dataflow_checks() -> list[dict[str, object]]:
    """Include real production-boundary checks in the historical report.

    Each check runs its named test group against the built v3 runtime
    (#681): the semantic gate no longer executes any v2 script or Python
    module for these four production-boundary properties."""
    checks = (
        "github-label-routing",
        "linear-composite-precheck",
        "corpus-evidence-and-broken-arrow",
        # #749: the PR #748 path-classification false positive cannot return.
        "path-classification-untrusted-surface",
    )
    node = _resolve_node()
    build_error = None if node is None else _ensure_dataflow_gate_built(node)
    error = "node executable not found (set PR_REVIEWER_NODE or install Node >= 24)" if node is None else build_error
    results = []
    for name in checks:
        if error is not None:
            results.append({"name": name, "passed": False, "detail": error})
            continue
        argv = [node, "--test", "--test-name-pattern", name, DATAFLOW_GATE_TEST_FILE]
        try:
            completed = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True, timeout=120, check=False)
            # `--test-name-pattern` exits 0 even when it matches zero tests
            # (the file-level suite formality still "passes"); require at
            # least one of this check's own named tests to have actually run.
            ran_named_test = f"✔ {name}:" in completed.stdout
            passed = completed.returncode == 0 and ran_named_test
            results.append({"name": name, "passed": passed,
                            "detail": (completed.stdout + completed.stderr)[-2000:] if not passed else ""})
        except (OSError, subprocess.TimeoutExpired) as exc:
            results.append({"name": name, "passed": False, "detail": str(exc)})
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--output", "--report", dest="report", type=Path)
    args = parser.parse_args()

    report: dict[str, object] | None = None
    corpus: SemanticCorpus | None = None
    try:
        corpus = SemanticCorpus.from_file(args.corpus)
        validate_semantic_corpus(corpus)
        report = evaluate_semantic_corpus(corpus)
        report["production_dataflow_checks"] = run_dataflow_checks()
        report["passed"] = report["passed"] and all(
            item["passed"] for item in report["production_dataflow_checks"]
        )
        scenario_numbers = {scenario.number for scenario in corpus.scenarios}
        missing_scenarios = sorted(DETERMINISTIC_SCENARIOS - scenario_numbers)
        no_run_scenarios = sorted(item["scenario_number"] for item in report["scenarios"] if not item["runs"])
        unexpected = sorted(scenario_numbers - DETERMINISTIC_SCENARIOS)
        errors = []
        if missing_scenarios:
            errors.append("missing required scenario(s): " + ", ".join(map(str, missing_scenarios)))
        if no_run_scenarios:
            errors.append("scenario(s) have no offline runs: " + ", ".join(map(str, no_run_scenarios)))
        if unexpected:
            errors.append("unexpected scenario(s): " + ", ".join(map(str, unexpected)))
        if errors:
            raise ValueError("; ".join(errors))
    except (OSError, TypeError, ValueError, KeyError, json.JSONDecodeError) as error:
        message = str(error)
        print(message, file=sys.stderr)
        if args.report is not None:
            payload = {
                "evaluator_version": 1,
                "passed": False,
                "corpus_path": str(args.corpus),
                "error": message,
                "scenarios_evaluated": len(corpus.scenarios) if corpus else 0,
                "scenarios": report.get("scenarios", []) if report else [],
            }
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return 2

    summaries = {str(item["scenario_number"]): item for item in report["scenarios"]}
    passed = bool(report["scenarios"]) and report["passed"]
    if args.report is None:
        print(json.dumps(report["summary"], sort_keys=True))
        for item in report["production_dataflow_checks"]:
            print(f"{item['name']}: {'PASS' if item['passed'] else 'FAIL'} {item['detail']}")
        return 0 if passed else 1
    payload = {
        **report,
        "passed": passed,
        "corpus_path": str(args.corpus),
        "capability_classes": sorted({scenario.klass for scenario in corpus.scenarios}),
        "scenarios_evaluated": len(report["scenarios"]),
        "per_scenario_summary": summaries,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report["summary"], sort_keys=True))
    for item in report["production_dataflow_checks"]:
        print(f"{item['name']}: {'PASS' if item['passed'] else 'FAIL'} {item['detail']}")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
