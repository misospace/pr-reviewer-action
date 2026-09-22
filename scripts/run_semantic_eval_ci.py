#!/usr/bin/env python3
"""Run the deterministic semantic regression corpus without network or models."""

from __future__ import annotations

import argparse
import json
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
    }
)


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
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
