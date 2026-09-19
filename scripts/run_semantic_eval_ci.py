#!/usr/bin/env python3
"""Deterministic offline CI runner for the historical dogfood corpus (#627).

This script is the entry point CI uses to validate the
``evals/corpus-historical-dogfood.json`` fixtures and exercise the
:mod:`pr_reviewer.semantic_eval` grader against canned run signals
without making any model calls. Live-model benchmark runs continue to
use the existing ``scripts/eval_harness.py`` workflow
(``.github/workflows/eval-harness.yaml``); this runner is the
**deterministic CI path** the issue acceptance criteria require.

Usage:

    python scripts/run_semantic_eval_ci.py \\
        --corpus evals/corpus-historical-dogfood.json \\
        [--report evals/semantic-ci-report.json]

Exit code is ``0`` when every fixture validates AND every canned
grader scenario passes; non-zero otherwise. The script writes a
compact JSON report so CI can upload it as an artifact the same way
the live-model run uploads ``eval-report/eval-report.json``.

The canned scenarios live at the bottom of this file (``_BUILTIN_RUNS``)
and are deliberately reconstructed from the PR #623 / issue #608
dogfood miss shapes — no live model is consulted, so the script is
side-effect-free and network-free.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# Make ``pr_reviewer`` importable when this script is run directly from
# the repo root or the scripts directory.
_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPT_DIR.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer.semantic_eval import (
    KNOWN_CAPABILITY_CLASSES,
    SIGNAL_KIND_FINDING,
    SIGNAL_KIND_MENTION,
    SIGNAL_KIND_TOOL,
    ReviewSignal,
    SemanticCorpus,
    SemanticCorpusError,
    aggregate_semantic_runs,
    evaluate_semantic_capability,
    validate_semantic_corpus,
)

# ─── Built-in canned runs ────────────────────────────────────────────────────
# Each entry is keyed by scenario number; the value is a list of
# :class:`ReviewSignal` sets to feed the grader, one per run.
# The harness layer is the production source of these signals — this
# in-script fixture exists only so CI can exercise the scorer
# deterministically without invoking a model endpoint.


def _mentions(stage: str, text: str) -> ReviewSignal:
    return ReviewSignal(kind=SIGNAL_KIND_MENTION, stage=stage, text=text)


def _finding(stage: str, text: str) -> ReviewSignal:
    return ReviewSignal(kind=SIGNAL_KIND_FINDING, stage=stage, text=text)


def _tool(stage: str, tool: str, text: str) -> ReviewSignal:
    return ReviewSignal(
        kind=SIGNAL_KIND_TOOL,
        stage=stage,
        text=text,
        meta={"tool": tool},
    )


#: Canned signals per scenario. The shape mirrors what the harness
#: layer would emit once a model has produced the review. Each list
#: contains three runs so the aggregation reports a meaningful rate.
_BUILTIN_RUNS: dict[int, list[list[ReviewSignal]]] = {
    # PR #623 sequencing — a primary-stage reviewer that names the
    # reap-before-final invariant and inspects the specialists phase log.
    623: [
        [
            _mentions(
                "primary",
                "All three specialist roles are launched concurrently and reaped "
                "before the final review enters. specialists.phase.log confirms "
                "each role exited within the deadline.",
            ),
            _tool("primary", "read_file", "specialists.phase.log"),
        ],
        [
            _mentions(
                "primary",
                "Confirmed via specialists.json: the specialist phase waited for "
                "join before final review.",
            ),
            _tool("primary", "read_file", "specialists.json"),
        ],
        [
            _mentions(
                "primary",
                "Specialist phase must complete before the final reviewer runs. "
                "Race condition between launch-before-final and the reap would "
                "violate the sequencing invariant.",
            ),
            _tool("primary", "read_file", "specialists.phase.log"),
        ],
    ],
    # PR #623 failure contract — output_completeness on the aggregate
    # artifact. A specialist or primary signal naming the artifact
    # state on failure satisfies the bar.
    6231: [
        [
            _mentions(
                "specialist",
                "On catastrophic failure, specialists.json is missing — the "
                "fail-soft entry is never written, so the deterministic "
                "aggregate contract is violated on the error path.",
            ),
            _tool("specialist", "read_file", "specialists.json"),
        ],
        [
            _finding(
                "primary",
                "Output completeness on failure: the per-role specialist-*.json "
                "artifacts and the normalized specialists.json aggregate must "
                "exist on the catastrophic failure path.",
            ),
            _tool("primary", "read_file", "specialists.json"),
        ],
        [
            _mentions(
                "primary",
                "Confirmed: even on catastrophic specialist failure, the "
                "normalized output (specialists.json) is produced with a "
                "fail-soft degraded entry.",
            ),
            _tool("primary", "read_file", "specialists.json"),
        ],
    ],
    # Negative control — a clean approve review. No capability hits;
    # any fabricated sequencing or output-completeness signal fails it.
    8004: [
        [_mentions("primary", "Trivial dependency bump. Approve.")],
        [_mentions("primary", "Looks clean. No issues.")],
        [_mentions("primary", "Clean change. LGTM, approve.")],
    ],
}


# ─── CI gate ─────────────────────────────────────────────────────────────────


def _evaluate_corpus(corpus: SemanticCorpus) -> dict[str, Any]:
    """Run canned signals through the grader and aggregate.

    Returns a dict with the per-scenario :class:`SemanticResult`,
    per-scenario aggregated pass rate, and a top-level ``passed``
    boolean (every fixture passed at least once AND no fixture
    regressed on the negative control).
    """
    per_scenario_results: dict[int, list[Any]] = {
        s.number: [] for s in corpus.scenarios
    }
    per_scenario_summary: dict[int, dict[str, Any]] = {}

    for scenario in corpus.scenarios:
        signals_runs = _BUILTIN_RUNS.get(scenario.number, [])
        results = [
            evaluate_semantic_capability(scenario, run_signals)
            for run_signals in signals_runs
        ]
        per_scenario_results[scenario.number] = results
        per_scenario_summary[scenario.number] = aggregate_semantic_runs(
            scenario, results
        )

    # Top-level pass: every fixture must score at least one passing
    # run AND every negative-control fixture must record zero
    # forbidden-capability violations across all runs.
    all_passed = True
    for scenario in corpus.scenarios:
        summary = per_scenario_summary[scenario.number]
        if summary["passes"] < 1:
            all_passed = False
        if scenario.negative_control and summary["forbidden_violation_rate"] > 0:
            all_passed = False

    return {
        "passed": all_passed,
        "per_scenario_results": {
            number: [r.to_dict() for r in results]
            for number, results in per_scenario_results.items()
        },
        "per_scenario_summary": per_scenario_summary,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Deterministic offline CI runner for the historical dogfood "
            "semantic-eval corpus (issue #627)."
        )
    )
    parser.add_argument(
        "--corpus",
        type=Path,
        required=True,
        help="Path to evals/corpus-historical-dogfood.json (or compatible).",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="Optional path to write the JSON CI report.",
    )
    args = parser.parse_args()

    if not args.corpus.exists():
        print(f"corpus not found: {args.corpus}", file=sys.stderr)
        return 2

    corpus = SemanticCorpus.from_file(args.corpus)
    try:
        validate_semantic_corpus(corpus)
    except SemanticCorpusError as exc:
        print(f"corpus validation failed: {exc}", file=sys.stderr)
        return 1

    evaluation = _evaluate_corpus(corpus)

    report = {
        "corpus_path": str(args.corpus),
        "corpus_version": corpus.version,
        "scenarios_evaluated": len(corpus.scenarios),
        "capability_classes": sorted(KNOWN_CAPABILITY_CLASSES),
        "passed": evaluation["passed"],
        "per_scenario_summary": evaluation["per_scenario_summary"],
        "per_scenario_results": evaluation["per_scenario_results"],
    }

    if args.report is not None:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(
            json.dumps(report, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    if not evaluation["passed"]:
        print(
            "semantic-eval CI gate FAILED — see per_scenario_results in the "
            "report for details.",
            file=sys.stderr,
        )
        return 1

    summary = evaluation["per_scenario_summary"]
    print(
        f"semantic-eval CI gate OK — {len(corpus.scenarios)} fixtures, "
        f"{sum(s['passes'] for s in summary.values())} passing runs, "
        f"{sum(s['runs'] for s in summary.values())} total runs."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
