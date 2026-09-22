from __future__ import annotations

from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from eval_harness import (
    BenchmarkCorpus,
    BenchmarkResult,
    ReviewRun,
    _load_review_artifact_findings,
    generate_report,
)
from pr_reviewer.semantic_eval import (
    SIGNAL_KIND_FINDING,
    _collect_signals_from_run,
    evaluate_semantic_capability,
)

CORPUS = ROOT / "evals" / "corpus-historical-dogfood.json"


def _scenario(number: int):
    corpus = BenchmarkCorpus.from_file(CORPUS).semantic_corpus
    assert corpus is not None
    return next(item for item in corpus.scenarios if item.number == number)


def _finding(message: str, stage: str | None = None) -> dict[str, str]:
    finding = {"message": message}
    if stage is not None:
        finding["stage"] = stage
    return finding


def test_unknown_finding_stage_is_not_attributed() -> None:
    scenario = _scenario(638)
    run = ReviewRun(
        mode="native_loop",
        pr_number=638,
        repo_full_name="misospace/pr-reviewer-action",
        route="primary",
        findings=[_finding("needs_full_review causes a redundant full review.")],
    )
    result = evaluate_semantic_capability(
        scenario,
        _collect_signals_from_run(run),
        {"mode": run.mode, "route": run.route},
    )
    assert result.stages_hit == []
    assert result.passed is False


def test_production_finding_without_stage_uses_derived_primary_stage() -> None:
    scenario = _scenario(638)
    run = ReviewRun(
        mode="native_loop",
        pr_number=638,
        repo_full_name="misospace/pr-reviewer-action",
        stage="primary",
        route="primary",
        findings=[{
            "severity": "major",
            "category": "correctness",
            "file": "scripts/review.sh",
            "line": 42,
            "message": "needs_full_review causes a redundant full review.",
        }],
    )
    result = evaluate_semantic_capability(
        scenario,
        _collect_signals_from_run(run),
        {"mode": run.mode, "route": run.route, "stage": run.stage},
    )
    assert result.stages_hit == ["primary"]
    assert result.passed is True


def test_primary_historical_and_escalation_findings_keep_stage_attribution(tmp_path: Path) -> None:
    scenario = _scenario(638)
    (tmp_path / "ai-output.primary.json").write_text(
        '{"findings": [{"severity": "major", "category": "correctness", '
        '"file": "scripts/review.sh", "line": 42, '
        '"message": "needs_full_review causes a redundant full review."}]}',
        encoding="utf-8",
    )
    primary_findings = _load_review_artifact_findings(tmp_path / "ai-output.primary.json")
    assert primary_findings[0]["stage"] == "primary"
    assert primary_findings[0]["message"].startswith("needs_full_review")
    run = ReviewRun(
        mode="native_loop",
        pr_number=638,
        repo_full_name="misospace/pr-reviewer-action",
        stage="escalation",
        route="escalated",
        primary_findings=primary_findings,
        findings=[_finding("full review runs twice")],
    )
    result = evaluate_semantic_capability(
        scenario,
        _collect_signals_from_run(run),
        {"mode": run.mode, "route": run.route, "stage": run.stage},
    )
    assert result.capability_hits["full_review_loop"] == ["primary", "escalation"]
    assert result.stages_hit == ["primary", "escalation"]


def test_specialist_leads_are_specialist_findings() -> None:
    run = ReviewRun(
        mode="native_loop+deep",
        pr_number=623,
        repo_full_name="misospace/pr-reviewer-action",
        specialist_leads=[{"message": "The final review starts before specialists are reaped."}],
    )
    signals = _collect_signals_from_run(run)
    assert [(signal.kind, signal.stage) for signal in signals] == [(SIGNAL_KIND_FINDING, "specialist")]
    assert signals[0].capability == "control_flow_sequencing"


def test_specialist_leads_prefer_flat_source_without_duplication() -> None:
    lead = {"message": "The final review starts before specialists are reaped."}
    run = ReviewRun(
        mode="native_loop+deep",
        pr_number=623,
        repo_full_name="misospace/pr-reviewer-action",
        specialist_leads=[lead],
        specialists={"leads_by_role": {"correctness": [lead]}},
    )
    signals = _collect_signals_from_run(run)
    assert [(signal.kind, signal.stage) for signal in signals] == [(SIGNAL_KIND_FINDING, "specialist")]


def test_specialist_leads_fall_back_to_role_map() -> None:
    run = ReviewRun(
        mode="native_loop+deep",
        pr_number=623,
        repo_full_name="misospace/pr-reviewer-action",
        specialists={"leads_by_role": {"correctness": [{"message": "The final review starts before specialists are reaped."}]}},
    )
    signals = _collect_signals_from_run(run)
    assert len(signals) == 1
    assert signals[0].stage == "specialist"


def test_live_semantic_report_aggregates_routes_and_negative_controls() -> None:
    corpus = BenchmarkCorpus.from_file(CORPUS)
    runs = [
        ReviewRun(
            mode="tools_off",
            pr_number=638,
            repo_full_name="misospace/pr-reviewer-action",
            route="primary",
            stage="primary",
            findings=[_finding("needs_full_review causes a redundant full review.", "primary")],
            wall_clock_sec=1.0,
        ),
        ReviewRun(
            mode="tools_off",
            pr_number=638,
            repo_full_name="misospace/pr-reviewer-action",
            route="primary+escalation",
            stage="primary",
            findings=[_finding("legacy full review flag is left uncleared and repeats past once.", "primary")],
            wall_clock_sec=2.0,
        ),
    ]
    report = generate_report(
        [
            BenchmarkResult(638, "misospace/pr-reviewer-action", runs[:2]),
        ],
        corpus,
    )
    semantic = report["semantic_eval"]
    full_review = semantic["per_scenario_summary"]["638"]
    assert full_review["pass_rate"] == 1.0
    assert full_review["routes"] == ["primary", "primary+escalation"]
    assert full_review["average_latency_sec"] == 1.5
    assert semantic["summary"]["false_positive_rate"] == 0.0
    assert semantic["summary"]["average_tool_calls"] == 0.0
    assert semantic["summary"]["average_duplicate_count"] == 0.0
    assert semantic["summary"]["escalation_frequency"] == 0.0
    assert semantic["passed"] is True


def test_live_negative_control_fails_parent_report() -> None:
    corpus = BenchmarkCorpus.from_file(CORPUS)
    run = ReviewRun(
        mode="tools_off",
        pr_number=6451,
        repo_full_name="misospace/pr-reviewer-action",
        route="primary",
        stage="primary",
        findings=[_finding("The deleted declaration still exists in the runtime.", "primary")],
    )
    report = generate_report(
        [BenchmarkResult(6451, "misospace/pr-reviewer-action", [run])],
        corpus,
    )
    semantic = report["semantic_eval"]
    assert semantic["per_scenario_summary"]["6451"]["false_positive_rate"] == 1.0
    assert semantic["passed"] is False
