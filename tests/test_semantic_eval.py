from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import pytest

from pr_reviewer.semantic_eval import (
    CAPABILITY_DIFF_POLARITY,
    CAPABILITY_FULL_REVIEW_LOOP,
    CAPABILITY_OUTPUT_COMPLETENESS,
    CAPABILITY_RUNTIME_PROTOCOL,
    CAPABILITY_SEQUENCING,
    CAPABILITY_STALE_REVIEW_STATE,
    CAPABILITY_AMBIENT_CAPABILITY_LOSS,
    CAPABILITY_BACKGROUND_LIFECYCLE,
    CAPABILITY_EXECUTION_BOUNDARY_AUTHORITY,
    CAPABILITY_REMEDIATION_TOPOLOGY,
    CAPABILITY_UNDECLARED_CAPABILITY_DEPENDENCY,
    DISPOSITION_CORRECT,
    DISPOSITION_INVALID_REMEDIATION,
    DISPOSITION_NOT_FOUND,
    DISPOSITION_SPECULATIVE_FALSE_POSITIVE,
    DISPOSITION_SUPPRESSED_PRE_EXISTING,
    MERGE_SAFETY_DISPOSITIONS_ORDER,
    SIGNAL_KIND_FINDING,
    SIGNAL_KIND_MENTION,
    SIGNAL_KIND_TOOL,
    ReviewSignal,
    SemanticCorpus,
    SemanticScenario,
    _collect_signals_from_run,
    _run_finding_stage,
    SemanticCorpusError,
    aggregate_semantic_runs,
    classify_signal,
    evaluate_semantic_capability,
    validate_semantic_corpus,
    validate_semantic_fixture_integrity,
    evaluate_semantic_corpus,
)

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))
from eval_harness import ReviewRun

CORPUS = ROOT / "evals" / "corpus-historical-dogfood.json"
RUNNER = ROOT / "scripts" / "run_semantic_eval_ci.py"


def scenario(number: int):
    corpus = SemanticCorpus.from_file(CORPUS)
    return next(item for item in corpus.scenarios if item.number == number)


def mention(stage: str, text: str) -> ReviewSignal:
    return ReviewSignal(SIGNAL_KIND_MENTION, stage, text)


def tool(stage: str, text: str) -> ReviewSignal:
    return ReviewSignal(SIGNAL_KIND_TOOL, stage, text, meta={"tool": "read_file"})


def test_review_run_stage_is_additive_when_present() -> None:
    run = ReviewRun(mode="native_loop", pr_number=1, repo_full_name="o/r", stage="escalation")
    assert run.to_dict()["stage"] == "escalation"


def test_corpus_is_valid_and_provenance_is_present() -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    validate_semantic_corpus(corpus)
    assert {item.number for item in corpus.scenarios} >= {623, 6231, 638, 644, 645, 6451, 8004}
    assert all(item.provenance["pr_url"] for item in corpus.scenarios)


def test_schema_rejects_duplicate_scenario_number() -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    duplicate = corpus.scenarios[0].to_dict()
    with pytest.raises(SemanticCorpusError, match="duplicate scenario number"):
        validate_semantic_corpus(SemanticCorpus([corpus.scenarios[0], corpus.scenarios[0].from_dict(duplicate)]))


def test_schema_rejects_unknown_capability() -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    bad = corpus.scenarios[0].to_dict()
    bad["class"] = "unknown"
    with pytest.raises(SemanticCorpusError, match="unknown class"):
        validate_semantic_corpus(SemanticCorpus([corpus.scenarios[0].from_dict(bad)]))


def test_schema_rejects_unknown_stage_attribution() -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    bad = corpus.scenarios[0].to_dict()
    bad["stage_attribution"] = "unknown"
    with pytest.raises(SemanticCorpusError, match="stage_attribution"):
        validate_semantic_corpus(SemanticCorpus([corpus.scenarios[0].from_dict(bad)]))


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [("expected_metrics", {"unknown": 1}, "expected_metrics key"), ("expected_metrics", {"max_tool_calls": "2"}, "non-negative integer")],
)
def test_schema_rejects_malformed_metrics(field: str, value: object, message: str) -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    bad = corpus.scenarios[0].to_dict()
    bad[field] = value
    with pytest.raises(SemanticCorpusError, match=message):
        validate_semantic_corpus(SemanticCorpus([corpus.scenarios[0].from_dict(bad)]))


def test_schema_rejects_duplicate_anchor_id() -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    bad = corpus.scenarios[0].to_dict()
    bad["expected_evidence_anchors"] = [
        {"id": "required-finding", "kind": "finding", "any_of": ["violation"]},
        {"id": "same", "kind": "finding", "any_of": ["one"]},
        {"id": "same", "kind": "finding", "any_of": ["two"]},
    ]
    with pytest.raises(SemanticCorpusError, match="duplicate evidence anchor id"):
        validate_semantic_corpus(SemanticCorpus([corpus.scenarios[0].from_dict(bad)]))


def test_schema_rejects_bad_provenance_and_anchor_shape() -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    bad = corpus.scenarios[0].to_dict()
    bad["provenance"] = []
    with pytest.raises(SemanticCorpusError, match="provenance"):
        validate_semantic_corpus(SemanticCorpus([corpus.scenarios[0].from_dict(bad)]))
    bad["provenance"] = corpus.scenarios[0].provenance
    bad["expected_evidence_anchors"] = [{"kind": "finding", "any_of": "not-a-list"}]
    with pytest.raises(SemanticCorpusError, match="non-empty"):
        validate_semantic_corpus(SemanticCorpus([corpus.scenarios[0].from_dict(bad)]))


def test_strict_mode_matching_rejects_missing_mode() -> None:
    item = scenario(638)
    result = evaluate_semantic_capability(item, [mention("primary", "needs_full_review reruns the full review loop.")])
    assert not result.passed
    assert any("review_mode=None" in violation for violation in result.applicability_violations)


def test_equivalent_sequencing_finding_requires_artifact_anchor() -> None:
    result = evaluate_semantic_capability(
        scenario(623),
        [
            ReviewSignal(SIGNAL_KIND_FINDING, "primary", "The final review starts before specialists are reaped, creating a sequencing race."),
            tool("primary", "specialists.phase.log"),
        ],
        {"mode": "deep", "route": "primary"},
    )
    assert result.passed
    assert CAPABILITY_SEQUENCING in result.capability_hits
    assert result.stages_hit == ["primary"]


def test_launch_only_sequencing_claim_fails() -> None:
    result = evaluate_semantic_capability(
        scenario(623),
        [mention("primary", "Specialists launched before final review; looks good.")],
        {"mode": "deep", "route": "primary"},
    )
    assert not result.passed
    assert any(not item["satisfied"] for item in result.anchor_results)


def test_failure_contract_rejects_happy_path_only() -> None:
    result = evaluate_semantic_capability(
        scenario(6231),
        [mention("primary", "specialists.json looks correct on the happy path."), tool("primary", "specialists.json")],
        {"mode": "deep", "route": "primary"},
    )
    assert not result.passed
    assert CAPABILITY_OUTPUT_COMPLETENESS not in result.capability_hits


def test_failure_contract_accepts_exceptional_parity() -> None:
    result = evaluate_semantic_capability(
        scenario(6231),
        [ReviewSignal(SIGNAL_KIND_FINDING, "specialist", "On catastrophic failure, the failure path never writes normalized output."), tool("specialist", "specialists.json")],
        {"mode": "deep", "route": "primary"},
    )
    assert result.passed
    assert result.stages_hit == ["specialist"]


@pytest.mark.parametrize(
    ("number", "capability", "text"),
    [
        (638, CAPABILITY_FULL_REVIEW_LOOP, "needs_full_review causes a redundant full review."),
        (644, CAPABILITY_RUNTIME_PROTOCOL, "The stale default prompt remains and references the deleted runtime protocol."),
        (645, CAPABILITY_STALE_REVIEW_STATE, "Carried findings remain in the stale previous review state."),
    ],
)
def test_historical_capabilities(number: int, capability: str, text: str) -> None:
    result = evaluate_semantic_capability(scenario(number), [ReviewSignal(SIGNAL_KIND_FINDING, "primary", text)], {"mode": "standard", "route": "primary"})
    assert result.passed
    assert capability in result.capability_hits


def test_positive_schema_rejects_mention_anchor() -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    bad = corpus.scenarios[0].to_dict()
    bad["expected_evidence_anchors"] = [{"kind": "mention", "any_of": ["violation"]}]
    with pytest.raises(SemanticCorpusError, match="only finding or tool"):
        validate_semantic_corpus(SemanticCorpus([corpus.scenarios[0].from_dict(bad)]))


def test_mentions_do_not_classify_capabilities() -> None:
    result = evaluate_semantic_capability(
        scenario(638),
        [mention("primary", "needs_full_review causes a redundant full review.")],
        {"mode": "standard", "route": "primary"},
    )
    assert not result.passed
    assert CAPABILITY_FULL_REVIEW_LOOP not in result.capability_hits


def test_localized_negation_does_not_classify_despite_clause() -> None:
    assert classify_signal(
        "The review is not, despite the old flag, a redundant full review."
    ) is None


@pytest.mark.parametrize(
    "text",
    [
        "The stale default prompt was removed.",
        "No stale review state remains.",
        "The fixed full review clears the legacy flag.",
        "The review explains that needs_full_review reruns the full review.",
    ],
)
def test_resolved_or_concept_only_findings_do_not_match(text: str) -> None:
    assert classify_signal(text) is None


def test_generic_finding_does_not_match() -> None:
    assert classify_signal("LGTM, approve.") is None
    result = evaluate_semantic_capability(scenario(644), [ReviewSignal(SIGNAL_KIND_FINDING, "primary", "Routine refactor, no issues.")], {"mode": "standard", "route": "primary"})
    assert not result.passed


def test_diff_polarity_positive_capability_is_not_forced_false_positive() -> None:
    item = scenario(6451)
    item.negative_control = False
    item.klass = CAPABILITY_DIFF_POLARITY
    item.expected_capabilities = [CAPABILITY_DIFF_POLARITY]
    item.forbidden_capabilities = []
    item.diff_polarity = None
    result = evaluate_semantic_capability(item, [ReviewSignal(SIGNAL_KIND_FINDING, "primary", "The deleted declaration still exists in the runtime.")], {"mode": "standard", "route": "primary"})
    assert result.passed
    assert result.forbidden_violations == []


def test_diff_polarity_negative_control_stays_clean() -> None:
    result = evaluate_semantic_capability(
        scenario(6451),
        [ReviewSignal(SIGNAL_KIND_FINDING, "primary", "The deleted declaration is absent; no remaining declaration is present.")],
        {"mode": "standard", "route": "primary"},
    )
    assert result.passed
    assert result.forbidden_violations == []


def test_diff_polarity_negative_control_rejects_saffron_claim() -> None:
    result = evaluate_semantic_capability(
        scenario(6451),
        [ReviewSignal(SIGNAL_KIND_FINDING, "primary", "The deleted declaration still exists in the runtime.")],
        {"mode": "standard", "route": "primary"},
    )
    assert not result.passed
    assert CAPABILITY_DIFF_POLARITY in result.forbidden_violations


def test_unknown_stage_capability_is_counted_but_not_attributed() -> None:
    result = evaluate_semantic_capability(
        scenario(6451),
        [ReviewSignal(SIGNAL_KIND_FINDING, "unknown", "The deleted declaration still exists in the runtime.")],
        {"mode": "standard", "route": "primary"},
    )
    assert result.capability_hits[CAPABILITY_DIFF_POLARITY] == ["unknown"]
    assert result.forbidden_violations == [CAPABILITY_DIFF_POLARITY]
    assert result.stages_hit == []
    assert not result.passed


def test_explicit_finding_stage_wins_over_run_stage() -> None:
    run = ReviewRun(
        mode="native_loop",
        pr_number=1,
        repo_full_name="o/r",
        stage="primary",
        findings=[{"stage": "escalation", "message": "needs_full_review causes a redundant full review."}],
    )
    assert _run_finding_stage(run, run.findings[0]) == "escalation"
    assert _collect_signals_from_run(run)[0].stage == "escalation"


def test_finding_stage_falls_back_to_valid_run_stage_without_route() -> None:
    run = ReviewRun(
        mode="native_loop",
        pr_number=1,
        repo_full_name="o/r",
        stage="primary",
        findings=[{"message": "needs_full_review causes a redundant full review."}],
    )
    assert _run_finding_stage(run) == "primary"
    signals = _collect_signals_from_run(run)
    assert signals[0].stage == "primary"


def test_unknown_run_stage_does_not_fallback_to_unknown_finding_stage() -> None:
    run = ReviewRun(
        mode="native_loop",
        pr_number=1,
        repo_full_name="o/r",
        stage="unknown",
        findings=[{"message": "needs_full_review causes a redundant full review."}],
    )
    assert _run_finding_stage(run) == "unknown"
    assert _collect_signals_from_run(run)[0].stage == "unknown"


def test_stage_attribution_rejects_wrong_stage() -> None:
    item = scenario(644)
    item.stage_attribution = "primary"
    result = evaluate_semantic_capability(item, [ReviewSignal(SIGNAL_KIND_FINDING, "escalation", "The deleted runtime protocol leaves a stale default prompt.")], {"mode": "standard", "route": "primary"})
    assert not result.passed
    assert result.stages_hit == ["escalation"]


def test_aggregation_reports_quality_cost_and_escalation() -> None:
    item = scenario(638)
    good = evaluate_semantic_capability(item, [ReviewSignal(SIGNAL_KIND_FINDING, "primary", "needs_full_review causes a redundant full review.")], {"tool_calls": 1, "latency_sec": 1.0, "route": "primary", "mode": "standard"})
    escalated = evaluate_semantic_capability(item, [ReviewSignal(SIGNAL_KIND_FINDING, "primary", "needs_full_review causes a redundant full review.")], {"latency_sec": 2.0, "route": "primary+escalation", "mode": "standard", "escalated": True})
    summary = aggregate_semantic_runs(item, [good, escalated])
    assert summary["pass_rate"] == 1.0
    assert summary["average_latency_sec"] == 1.5
    assert summary["escalation_frequency"] == 0.5
    assert summary["routes"] == ["primary", "primary+escalation"]


def test_offline_runner_writes_report_without_credentials(tmp_path: Path) -> None:
    report = tmp_path / "semantic-report.json"
    result = subprocess.run(
        [sys.executable, str(RUNNER), "--corpus", str(CORPUS), "--report", str(report)],
        cwd=ROOT,
        env={"PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(report.read_text(encoding="utf-8"))
    assert payload["passed"] is True
    assert payload["scenarios_evaluated"] == 17
    assert payload["per_scenario_summary"]["6451"]["false_positive_rate"] == 0.0
    assert payload["per_scenario_summary"]["638"]["routes"] == ["primary", "primary+escalation"]
    assert payload["per_scenario_summary"]["645"]["routes"] == ["primary", "primary+escalation"]


def test_evaluator_reports_only_negative_control_false_positive_rate() -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    negative = next(item for item in corpus.scenarios if item.number == 6451)
    negative.offline_runs[0]["findings"] = [{"stage": "primary", "message": "The deleted declaration still exists in the runtime."}]
    report = evaluate_semantic_corpus(corpus)
    expected = round(1 / len([item for item in corpus.scenarios if item.negative_control]), 4)
    assert report["summary"]["false_positive_rate"] == expected
    assert report["summary"]["false_positive_rate"] == report["negative_control_summary"]["false_positive_rate"]


def test_evaluator_fails_when_expected_capability_is_missing() -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    corpus.scenarios[0].offline_runs[0]["review_markdown"] = "Specialists launched before final review."
    corpus.scenarios[0].offline_runs[0]["findings"] = []
    report = evaluate_semantic_corpus(corpus)
    scenario_report = next(item for item in report["scenarios"] if item["scenario_number"] == 623)
    assert report["passed"] is False
    assert scenario_report["pass_rate"] == 0.0


def test_offline_runner_writes_failure_report_for_uncovered_fixture(tmp_path: Path) -> None:
    source = json.loads(CORPUS.read_text(encoding="utf-8"))
    source["semantic_corpus"].append(dict(source["semantic_corpus"][0], number=999))
    corpus = tmp_path / "bad.json"
    corpus.write_text(json.dumps(source), encoding="utf-8")
    report = tmp_path / "failure.json"
    result = subprocess.run([sys.executable, str(RUNNER), "--corpus", str(corpus), "--output", str(report)], capture_output=True, text=True, check=False)
    assert result.returncode != 0
    assert "unexpected scenario" in result.stderr
    payload = json.loads(report.read_text(encoding="utf-8"))
    assert payload["passed"] is False
    assert "error" in payload


def test_offline_runner_rejects_no_runs_with_failure_report(tmp_path: Path) -> None:
    source = json.loads(CORPUS.read_text(encoding="utf-8"))
    source["semantic_corpus"][0]["offline_runs"] = []
    corpus = tmp_path / "no-runs.json"
    corpus.write_text(json.dumps(source), encoding="utf-8")
    report = tmp_path / "no-runs-report.json"
    result = subprocess.run([sys.executable, str(RUNNER), "--corpus", str(corpus), "--output", str(report)], capture_output=True, text=True, check=False)
    assert result.returncode != 0
    assert "no offline runs" in result.stderr
    assert json.loads(report.read_text(encoding="utf-8"))["passed"] is False


def test_fixture_references_are_immutable_and_hash_verified() -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    assert corpus.fixture_root == CORPUS.parent
    assert all(item.fixture and len(item.fixture["sha256"]) == 64 for item in corpus.scenarios)
    assert all(Path(item.fixture["path"]).is_relative_to(Path("historical-dogfood")) for item in corpus.scenarios)


@pytest.mark.parametrize("path", ["/tmp/fixture.json", "../fixture.json", "historical-dogfood/../../fixture.json", r"C:\\fixture.json"])
def test_schema_rejects_unsafe_fixture_path(path: str) -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    bad = corpus.scenarios[0].to_dict()
    bad["fixture"] = dict(bad["fixture"], path=path)
    with pytest.raises(SemanticCorpusError, match="safe relative path"):
        validate_semantic_corpus(SemanticCorpus([corpus.scenarios[0].from_dict(bad)]))


@pytest.mark.parametrize("sha256", ["A" * 64, "0" * 63, "g" * 64])
def test_schema_rejects_malformed_fixture_hash(sha256: str) -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    bad = corpus.scenarios[0].to_dict()
    bad["fixture"] = dict(bad["fixture"], sha256=sha256)
    with pytest.raises(SemanticCorpusError, match="64 lowercase hexadecimal"):
        validate_semantic_corpus(SemanticCorpus([corpus.scenarios[0].from_dict(bad)]))


def test_schema_requires_route_for_stage_less_offline_findings() -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    bad = corpus.scenarios[0].to_dict()
    bad["offline_runs"] = [{"findings": [{"message": "finding without a stage"}]}]
    with pytest.raises(SemanticCorpusError, match="stage-less findings must declare route"):
        validate_semantic_corpus(SemanticCorpus([corpus.scenarios[0].from_dict(bad)]))


def test_all_historical_fixtures_have_coherent_diff_and_head() -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    for scenario_item in corpus.scenarios:
        fixture_path = corpus.fixture_root / scenario_item.fixture["path"]
        validate_semantic_fixture_integrity(json.loads(fixture_path.read_text(encoding="utf-8")))


def test_fixture_integrity_rejects_tampered_head() -> None:
    fixture = json.loads((ROOT / "evals" / "historical-dogfood" / "644.json").read_text(encoding="utf-8"))
    fixture["files"][0]["content"] = "stale prompt\n"
    with pytest.raises(SemanticCorpusError, match="new side does not match|reverse patch"):
        validate_semantic_fixture_integrity(fixture)


def test_fixture_hash_mismatch_is_rejected() -> None:
    from eval_harness import _load_semantic_fixture

    corpus = SemanticCorpus.from_file(CORPUS)
    fixture = dict(corpus.scenarios[0].fixture)
    fixture["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="hash mismatch"):
        _load_semantic_fixture(corpus, fixture)


def test_live_mode_filtering_uses_standard_and_deep_labels() -> None:
    from eval_harness import BenchmarkCorpus, BenchmarkResult, evaluate_live_semantics

    corpus = BenchmarkCorpus.from_file(CORPUS)
    semantic = corpus.semantic_corpus
    assert semantic is not None
    runs = [
        ReviewRun("native_loop", 638, "misospace/pr-reviewer-action"),
        ReviewRun("native_loop+deep", 638, "misospace/pr-reviewer-action"),
    ]
    report = evaluate_live_semantics(semantic, [BenchmarkResult(638, "misospace/pr-reviewer-action", runs)])
    assert report["per_scenario_summary"]["638"]["runs"] == 1
    assert report["per_scenario_summary"]["638"]["review_mode"] == "standard"


def test_live_semantics_keeps_scenarios_with_shared_pr_provenance_separate() -> None:
    from eval_harness import BenchmarkCorpus, BenchmarkResult, evaluate_live_semantics

    corpus = BenchmarkCorpus.from_file(CORPUS)
    semantic = corpus.semantic_corpus
    assert semantic is not None
    runs = [
        ReviewRun("native_loop+deep", 623, "misospace/pr-reviewer-action"),
        ReviewRun("native_loop+deep", 6231, "misospace/pr-reviewer-action"),
        ReviewRun("native_loop", 645, "misospace/pr-reviewer-action"),
        ReviewRun("native_loop", 6451, "misospace/pr-reviewer-action"),
    ]
    report = evaluate_live_semantics(
        semantic,
        [
            BenchmarkResult(623, "misospace/pr-reviewer-action", [runs[0]]),
            BenchmarkResult(6231, "misospace/pr-reviewer-action", [runs[1]]),
            BenchmarkResult(645, "misospace/pr-reviewer-action", [runs[2]]),
            BenchmarkResult(6451, "misospace/pr-reviewer-action", [runs[3]]),
        ],
    )
    summaries = report["per_scenario_summary"]
    assert summaries["623"]["runs"] == 1
    assert summaries["6231"]["runs"] == 1
    assert summaries["645"]["runs"] == 1
    assert summaries["6451"]["runs"] == 1


def test_normal_benchmark_entries_do_not_require_semantic_fixture(tmp_path: Path) -> None:
    from eval_harness import BenchmarkCorpus

    path = tmp_path / "normal.json"
    path.write_text(json.dumps({"benchmark_corpus": [{"number": 1, "repo_full_name": "o/r"}]}), encoding="utf-8")
    corpus = BenchmarkCorpus.from_file(path)
    assert corpus.prs == [{"number": 1, "repo_full_name": "o/r"}]


def test_fixture_precheck_bypasses_fingerprint(tmp_path: Path) -> None:
    output = tmp_path / "output.txt"
    result = subprocess.run(
        ["bash", str(ROOT / "scripts" / "check_review_needed.sh")],
        cwd=tmp_path,
        env={
            "PATH": "/usr/bin:/bin",
            "REPO": "fixture/repo",
            "PR_NUMBER": "1",
            "GITHUB_OUTPUT": str(output),
            "SEMANTIC_FIXTURE_MODE": "true",
        },
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "should_review=true" in output.read_text(encoding="utf-8")
    assert "skip_reason=semantic-fixture" in output.read_text(encoding="utf-8")
    assert not (tmp_path / "pr.diff").exists()


def test_fixture_run_materializes_pre_fix_files_without_pr_head_checkout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import eval_harness
    from eval_harness import BenchmarkCorpus, run_review_for_pr

    entry = BenchmarkCorpus.from_file(CORPUS).prs[0]
    commands: list[list[str]] = []
    real_run = eval_harness.subprocess.run

    def recording_run(command, *args, **kwargs):
        if isinstance(command, (list, tuple)):
            commands.append([str(item) for item in command])
        return real_run(command, *args, **kwargs)

    monkeypatch.setattr(eval_harness.subprocess, "run", recording_run)
    script = tmp_path / "fixture-run.sh"
    script.write_text(
        "#!/usr/bin/env bash\n"
        "set -eu\n"
        "test \"${FORCE_REVIEW:-}\" = true\n"
        "test \"${SKIP_IF_DIFF_UNCHANGED:-}\" = false\n"
        "test -f scripts/sections/corpus.sh\n"
        "grep -F 'run_tool_harness' scripts/sections/corpus.sh\n"
        "printf '%s\\n' '{\"verdict\":\"request_changes\",\"review_markdown\":\"fixture\",\"findings\":[]}' > ai-output.json\n",
        encoding="utf-8",
    )
    script.chmod(0o755)
    run = run_review_for_pr(
        entry,
        "native_loop",
        tmp_path,
        {"model": "fixture", "base_url": "", "api_key": "", "github_token": ""},
        review_script=script,
    )
    assert run.error is None
    assert run.verdict == "request_changes"
    assert run.commit_sha
    assert not (tmp_path / "misospace-pr-reviewer-action").exists()
    assert not any(command and command[0] == "git" and "clone" in command for command in commands)
    assert not any(command and command[0] == "git" and "fetch" in command for command in commands)
    assert all("refs/pull/" not in " ".join(command) for command in commands)


@pytest.mark.parametrize(
    ("number", "text"),
    [
        (638, "needs_full_review causes a redundant full review."),
        (644, "The stale default prompt remains and references the deleted runtime protocol."),
        (645, "Carried findings remain in the stale previous review state."),
    ],
)
def test_escalation_findings_are_attributed_for_historical_scenarios(number: int, text: str) -> None:
    route = "primary" if number == 644 else "escalated"
    result = evaluate_semantic_capability(
        scenario(number),
        [ReviewSignal(SIGNAL_KIND_FINDING, "escalation", text)],
        {"mode": "standard", "route": route, "stage": "escalation", "escalated": route == "escalated"},
    )
    assert result.passed
    assert result.stages_hit == ["escalation"]


# ── #659 PR #654 execution-boundary / lifecycle fixtures ───────────────────

POSITIVE_654 = {
    6541: CAPABILITY_EXECUTION_BOUNDARY_AUTHORITY,
    6543: CAPABILITY_AMBIENT_CAPABILITY_LOSS,
    6545: CAPABILITY_BACKGROUND_LIFECYCLE,
    6547: CAPABILITY_REMEDIATION_TOPOLOGY,
    6549: CAPABILITY_UNDECLARED_CAPABILITY_DEPENDENCY,
}

# Each vulnerable fixture has a fixed negative control forbidding the same class.
NEGATIVE_654 = {
    6542: CAPABILITY_EXECUTION_BOUNDARY_AUTHORITY,
    6544: CAPABILITY_AMBIENT_CAPABILITY_LOSS,
    6546: CAPABILITY_BACKGROUND_LIFECYCLE,
    6548: CAPABILITY_REMEDIATION_TOPOLOGY,
    6550: CAPABILITY_UNDECLARED_CAPABILITY_DEPENDENCY,
}

GENERIC_WARNINGS = (
    "Consider cleanup of background processes before merge.",
    "Check security boundaries for this execution change.",
    "Please review the security and lifecycle implications.",
    "Looks good; approval.",
)


def _run_finding_text(scenario_item, run_index: int = 0) -> str:
    return scenario_item.offline_runs[run_index]["findings"][0]["message"]


def _fixture_file(number: int, path: str) -> str:
    item = scenario(number)
    fixture_path = CORPUS.parent / item.fixture["path"]
    data = json.loads(fixture_path.read_text(encoding="utf-8"))
    return next(entry["content"] for entry in data["files"] if entry["path"] == path)


def _function_body(source: str, name: str) -> str:
    match = re.search(rf"(?ms)^{re.escape(name)}\(\) \{{\n(.*?)^\}}", source)
    assert match is not None, f"missing function: {name}"
    return match.group(1)


def _assert_collect_before_kill(source: str) -> None:
    """Prove the fixture uses collect-before-kill tree cleanup, not streaming.

    Streaming (killing each PID inside the loop that reads gate_descendants)
    can reparent a just-killed child's grandchildren before the generator walks
    them, so a payload descendant can survive. The merged safe contract instead
    collects the complete descendant set into an array before signaling
    anything, then terminates deepest-first, escalates to KILL, and reaps.
    """
    body = _function_body(source, "gate_terminate_and_reap")
    assert "local -a targets=()" in body, "descendants must be collected into an array"
    assert "targets+=(" in body, "descendants must be collected before signaling"
    assert "done < <(gate_descendants" in body, "the descendant walk must feed the collection loop"
    assert "for (( d=${#targets[@]}-1; d>=0; d-- ))" in body, "descendants must be signaled deepest-first"
    assert 'kill -TERM "${targets[$d]}"' in body, "TERM must target the collected array, not a stream"
    assert "kill -KILL" in body, "cleanup must escalate to KILL"
    assert 'wait "$pid"' in body, "the leader must be reaped"
    assert body.index("targets+=(") < body.index("kill -TERM"), "collect must happen before any signal"
    stream = re.search(r"(?ms)while IFS= read -r d; do\n(.*?)\n\s*done < <\(gate_descendants", body)
    assert stream is not None, "the collection loop must consume gate_descendants"
    assert "kill" not in stream.group(1), "the descendant-read loop must not signal (streaming enumeration while killing)"


# A description of the failure each negative control forbids, plus the head
# content that must have changed so the description is no longer true. The
# scorer must still recognize the description (it is not being taught to
# ignore it); the fixture side is what makes it inapplicable.
NEGATIVE_SAFETY = {
    6542: {
        "failure": (
            "Moving the CI poller into the review process makes the child inherit reviewer "
            "secrets and model credentials."
        ),
        "forbidden": CAPABILITY_EXECUTION_BOUNDARY_AUTHORITY,
        "checks": [
            (
                "scripts/gating.sh",
                ["env -i", "_CI_GATE_ENV_KEYS"],
                ["AI_API_KEY", "AI_PRIMARY_API_KEY", "TOOL_MCP_TOKEN", "LINEAR_API_KEY"],
            )
        ],
    },
    6544: {
        "failure": (
            "The env -i allowlist removes required transport variables and drops the proxy "
            "configuration for self-hosted deployments."
        ),
        "forbidden": CAPABILITY_AMBIENT_CAPABILITY_LOSS,
        "checks": [
            (
                "scripts/gating.sh",
                ["HTTP_PROXY", "HTTPS_PROXY", "SSL_CERT_FILE", "GH_CONFIG_DIR"],
                ["AI_API_KEY"],
            )
        ],
    },
    6546: {
        "failure": (
            "There is no abnormal-exit owner; cleanup kills only the tracked wrapper pid so the "
            "credential-bearing CI child and its descendants survive an abnormal exit."
        ),
        "forbidden": CAPABILITY_BACKGROUND_LIFECYCLE,
        "collect_before_kill": True,
        "checks": [
            (
                "scripts/gating.sh",
                ["install_gate_lifecycle_trap", "gate_descendants", "pgrep -P", "RUNNER_TRACKING_ID"],
                ["command -v pgrep >/dev/null 2>&1 || return 0"],
            )
        ],
    },
    6548: {
        "failure": (
            "Cleanup kills only the tracked wrapper pid, so the production payload and "
            "descendants survive an abnormal exit."
        ),
        "forbidden": CAPABILITY_REMEDIATION_TOPOLOGY,
        "collect_before_kill": True,
        "checks": [
            (
                "scripts/gating.sh",
                ["require_gate_tree_cleanup", "gate_descendants", "cleanup_gate_children"],
                ["command -v pgrep >/dev/null 2>&1 || return 0"],
            ),
            (
                "tests/test_concurrent_gating.sh",
                ["ci-wrapper.pid", "ci-payload.pid", "( sleep 30 ) &"],
                ["exec sleep 30"],
            ),
        ],
    },
    6550: {
        "failure": (
            "Tree-aware cleanup depends on pgrep but pgrep is not part of the validated runtime "
            "contract, so it falls back to wrapper-only and leaves the payload tree alive."
        ),
        "forbidden": CAPABILITY_UNDECLARED_CAPABILITY_DEPENDENCY,
        "collect_before_kill": True,
        "checks": [
            (
                "scripts/gating.sh",
                ["require_gate_tree_cleanup", "pgrep -P"],
                ["command -v pgrep >/dev/null 2>&1 || return 0"],
            )
        ],
    },
}


def test_654_capability_classes_are_registered() -> None:
    from pr_reviewer.semantic_eval import KNOWN_CAPABILITY_CLASSES

    assert set(POSITIVE_654.values()) <= KNOWN_CAPABILITY_CLASSES
    corpus = SemanticCorpus.from_file(CORPUS)
    numbers = {item.number for item in corpus.scenarios}
    assert set(POSITIVE_654) <= numbers
    assert set(NEGATIVE_654) <= numbers
    for item in corpus.scenarios:
        if item.number in NEGATIVE_654:
            assert item.negative_control is True
            assert item.forbidden_capabilities == [NEGATIVE_654[item.number]]
            assert item.expected_capabilities == []


@pytest.mark.parametrize("number", sorted(POSITIVE_654))
def test_654_vulnerable_fixtures_classify_their_class(number: int) -> None:
    item = scenario(number)
    for run in item.offline_runs:
        result = evaluate_semantic_capability(item, [
            ReviewSignal(SIGNAL_KIND_FINDING, run["findings"][0]["stage"], run["findings"][0]["message"]),
            *(tool(run["findings"][0]["stage"], call["args"]["path"]) for call in run.get("tool_calls", [])),
        ], {"mode": run.get("mode", "standard"), "route": run.get("route", "primary"), "stage": run["stage"], "expected_disposition": run.get("expected_disposition")})
        if run.get("expected_disposition"):
            # Answer-key fixture: gated on scorer calibration, never on
            # reviewer success (it is deliberately bad where the key says so).
            assert result.calibration_run is True, (number, run["stage"])
            assert result.disposition_calibration_pass is True, (number, run["stage"])
            assert POSITIVE_654[number] in result.capability_hits or run["expected_disposition"] != DISPOSITION_CORRECT, (number, run["stage"])
        else:
            assert result.passed, (number, run["stage"])
            assert POSITIVE_654[number] in result.capability_hits


@pytest.mark.parametrize("number", sorted(NEGATIVE_654))
def test_654_fixed_negative_controls_stay_clean(number: int) -> None:
    item = scenario(number)
    for run in item.offline_runs:
        result = evaluate_semantic_capability(
            item,
            [ReviewSignal(SIGNAL_KIND_FINDING, run["findings"][0]["stage"], run["findings"][0]["message"])],
            {"mode": run.get("mode", "standard"), "route": run.get("route", "primary"), "stage": run["stage"]},
        )
        assert result.passed, (number, result.forbidden_violations)
        assert result.forbidden_violations == []


@pytest.mark.parametrize("number", sorted(POSITIVE_654))
def test_654_generic_warnings_do_not_satisfy_positive_fixtures(number: int) -> None:
    item = scenario(number)
    for warning in GENERIC_WARNINGS:
        result = evaluate_semantic_capability(
            item,
            [ReviewSignal(SIGNAL_KIND_FINDING, "primary", warning)],
            {"mode": "standard", "route": "primary", "stage": "primary"},
        )
        assert not result.passed, (number, warning)
        assert POSITIVE_654[number] not in result.capability_hits


@pytest.mark.parametrize("warning", GENERIC_WARNINGS)
def test_654_generic_warnings_match_no_capability(warning: str) -> None:
    assert classify_signal(warning) is None


@pytest.mark.parametrize("number", sorted(NEGATIVE_654))
def test_654_negative_controls_reject_their_vulnerability(number: int) -> None:
    item = scenario(number)
    vulnerable = _run_finding_text(scenario(number - 1))
    result = evaluate_semantic_capability(
        item,
        [ReviewSignal(SIGNAL_KIND_FINDING, "primary", vulnerable)],
        {"mode": "standard", "route": "primary", "stage": "primary"},
    )
    assert not result.passed
    assert NEGATIVE_654[number] in result.forbidden_violations


@pytest.mark.parametrize("number", sorted(NEGATIVE_SAFETY))
def test_654_negative_controls_are_genuinely_safe(number: int) -> None:
    """A correct description of the forbidden failure must not apply to the fixture.

    The scorer still recognizes the failure description (it is not taught to
    ignore it), and the fixture head has actually changed so the description is
    no longer true of the reviewed code.
    """
    spec = NEGATIVE_SAFETY[number]
    assert classify_signal(spec["failure"]) == spec["forbidden"], (number, spec["failure"])
    item = scenario(number)
    detected = evaluate_semantic_capability(
        item,
        [ReviewSignal(SIGNAL_KIND_FINDING, "primary", spec["failure"])],
        {"mode": "standard", "route": "primary", "stage": "primary"},
    )
    assert spec["forbidden"] in detected.forbidden_violations, number
    if spec.get("collect_before_kill"):
        _assert_collect_before_kill(_fixture_file(number, "scripts/gating.sh"))
    for path, required, absent in spec["checks"]:
        head = _fixture_file(number, path)
        for needle in required:
            assert needle in head, (number, path, needle)
        for needle in absent:
            assert needle not in head, (number, path, needle)


STREAMING_ENUMERATION_WHILE_KILLING = """\
gate_descendants() {
  :
}

gate_terminate_and_reap() {
  local pid="$1"
  local d
  while IFS= read -r d; do
    [ -n "$d" ] && kill -TERM "$d" 2>/dev/null || true
  done < <(gate_descendants "$pid")
  kill -TERM "$pid" 2>/dev/null || true
}
"""


def test_654_safety_check_rejects_streaming_enumeration_while_killing() -> None:
    """The structural check must reject the unsafe streaming cleanup.

    This is the exact shape the fixtures previously used (and that the merged
    gating.sh replaced): signal each descendant inside the loop that reads
    gate_descendants, so a killed child can reparent its grandchildren before
    the walk sees them.
    """
    with pytest.raises(AssertionError):
        _assert_collect_before_kill(STREAMING_ENUMERATION_WHILE_KILLING)


_CLEANUP_BEHAVIOR_HARNESS = r"""
set -uo pipefail
SCRIPT_DIR="$1"
STATE_DIR="$2"
CI_GATE_LOG="$STATE_DIR/ci.log"
log() { :; }
error() { :; }
source "$SCRIPT_DIR/gating.sh"
wait_for_ci_command() {
  echo "$BASHPID" > "$STATE_DIR/wrapper.pid"
  bash -c "echo \$\$ > '$STATE_DIR/payload.pid'; sleep 300 & echo \$! > '$STATE_DIR/grandchild.pid'; wait" &
  local payload=$!
  wait "$payload"
}
install_gate_lifecycle_trap
export CI_STATUS_CHECK=true
fork_ci_gate
for _ in $(seq 1 300); do
  [ -s "$STATE_DIR/payload.pid" ] && [ -s "$STATE_DIR/grandchild.pid" ] && break
  sleep 0.02
done
exit 7
"""


def _process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@pytest.mark.parametrize("number", [6546, 6548, 6550])
def test_654_negative_control_cleanup_reaps_the_payload_tree(number: int, tmp_path: Path) -> None:
    """Behavioral proof: the fixture's abnormal-exit cleanup kills the tree.

    Runs the fixture's own gating.sh with a distinct wrapper/payload/grandchild
    topology and asserts nothing survives the abnormal exit, so a correct
    reviewer cannot report the forbidden lifecycle/topology failure.
    """
    if subprocess.run(["bash", "-c", "command -v pgrep"], capture_output=True).returncode != 0:
        pytest.skip("pgrep unavailable")
    source_dir = tmp_path / "src"
    source_dir.mkdir()
    (source_dir / "gating.sh").write_text(_fixture_file(number, "scripts/gating.sh"), encoding="utf-8")
    state = tmp_path / "state"
    state.mkdir()
    harness = tmp_path / "harness.sh"
    harness.write_text(_CLEANUP_BEHAVIOR_HARNESS, encoding="utf-8")
    result = subprocess.run(
        ["bash", str(harness), str(source_dir), str(state)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 7, (number, result.returncode, result.stderr)
    pids = {}
    for name in ("wrapper", "payload", "grandchild"):
        pid_file = state / f"{name}.pid"
        assert pid_file.exists(), (number, name, result.stderr)
        pids[name] = int(pid_file.read_text().strip())
    assert pids["wrapper"] != pids["payload"] != pids["grandchild"], (number, pids)
    for _ in range(100):
        if not any(_process_alive(pid) for pid in pids.values()):
            break
        time.sleep(0.02)
    for name, pid in pids.items():
        assert not _process_alive(pid), (number, name, pid)


def test_654_dependency_requires_both_cause_and_effect() -> None:
    item = scenario(6549)
    cause_only = "pgrep is not part of the validated runtime contract and tree-aware cleanup depends on it."
    effect_only = "Cleanup falls back to wrapper-only, leaving the payload tree alive."

    cause_result = evaluate_semantic_capability(
        item,
        [ReviewSignal(SIGNAL_KIND_FINDING, "primary", cause_only), tool("primary", "scripts/gating.sh")],
        {"mode": "standard", "route": "primary", "stage": "primary"},
    )
    assert CAPABILITY_UNDECLARED_CAPABILITY_DEPENDENCY in cause_result.capability_hits
    assert not cause_result.passed
    assert any(a["id"] == "wrapper-only-effect" and not a["satisfied"] for a in cause_result.anchor_results)

    effect_result = evaluate_semantic_capability(
        item,
        [ReviewSignal(SIGNAL_KIND_FINDING, "primary", effect_only), tool("primary", "scripts/gating.sh")],
        {"mode": "standard", "route": "primary", "stage": "primary"},
    )
    assert CAPABILITY_UNDECLARED_CAPABILITY_DEPENDENCY in effect_result.capability_hits
    assert not effect_result.passed
    assert any(a["id"] == "pgrep-required-cause" and not a["satisfied"] for a in effect_result.anchor_results)


@pytest.mark.parametrize(
    ("number", "effect_only"),
    [
        (6541, "The CI child inherits reviewer secrets and model credentials."),
        (6543, "The allowlist drops the proxy configuration for self-hosted deployments."),
        (6547, "Cleanup kills only the tracked wrapper pid, leaving the workload running."),
    ],
)
def test_654_effect_without_cause_fails_the_causal_chain(number: int, effect_only: str) -> None:
    item = scenario(number)
    result = evaluate_semantic_capability(
        item,
        [
            ReviewSignal(SIGNAL_KIND_FINDING, "primary", effect_only),
            tool("primary", item.offline_runs[0]["tool_calls"][0]["args"]["path"]),
        ],
        {"mode": "standard", "route": "primary", "stage": "primary"},
    )
    assert POSITIVE_654[number] in result.capability_hits
    assert not result.passed


def test_654_lifecycle_fixture_requires_the_runner_tracking_causal_link() -> None:
    item = scenario(6545)
    partial = (
        "fork_ci_gate launches a credential-bearing CI child but there is no abnormal-exit cleanup, "
        "so a parent exit between fork and join leaves an orphaned CI child."
    )
    result = evaluate_semantic_capability(
        item,
        [ReviewSignal(SIGNAL_KIND_FINDING, "primary", partial), tool("primary", "scripts/gating.sh")],
        {"mode": "standard", "route": "primary", "stage": "primary"},
    )
    assert CAPABILITY_BACKGROUND_LIFECYCLE in result.capability_hits
    assert not result.passed
    assert any(item_["id"] == "runner-tracking" and not item_["satisfied"] for item_ in result.anchor_results)


def test_654_safe_narrowing_prose_is_not_a_boundary_vulnerability() -> None:
    for safe in (
        "The env -i allowlist prevents the CI child from inheriting reviewer secrets and model credentials.",
        "The CI child does not inherit reviewer secrets under the explicit least-privilege boundary.",
        "The allowlist excludes reviewer secrets and preserves the authority boundary.",
    ):
        assert classify_signal(safe) is None, safe


def test_654_pr654_historical_miss_phrasing_does_not_satisfy() -> None:
    """Baseline: the observed PR #654 review outputs (#659 ledger) must not score.

    PR #654's MiniMax-M3 smart escalation called the change solid and claimed the
    security boundary was preserved via the allowlist; the OpenCode control run
    and the local models flagged only generic timing/cleanup items. None of that
    names a causal execution-boundary or lifecycle failure, so none of it may
    satisfy the new fixtures.
    """
    misses = {
        6541: "The PR is solid and the security boundary is preserved via the explicit allowlist; no correctness bugs found.",
        6543: "Looks good; transport and CA handling is unchanged.",
        6545: "Consider cleanup of the background CI child on abnormal exit; otherwise looks fine.",
        6547: "Add a trap that kills the background CI gate child on exit to fix the lifecycle issue.",
        6549: "The cleanup uses pgrep; looks correct to me.",
    }
    for number, text in misses.items():
        item = scenario(number)
        result = evaluate_semantic_capability(
            item,
            [ReviewSignal(SIGNAL_KIND_FINDING, "primary", text)],
            {"mode": "standard", "route": "primary", "stage": "primary"},
        )
        assert not result.passed, (number, text)
        assert POSITIVE_654[number] not in result.capability_hits, (number, text)


@pytest.mark.parametrize("number", sorted(POSITIVE_654))
def test_654_attribution_supports_specialist_primary_and_escalation(number: int) -> None:
    item = scenario(number)
    for stage, route, mode, escalated in (
        ("specialist", "primary", "deep", False),
        ("primary", "primary", "standard", False),
        ("escalation", "primary+escalation", "standard", True),
    ):
        finding_text = item.offline_runs[0]["findings"][0]["message"]
        result = evaluate_semantic_capability(
            item,
            [
                ReviewSignal(SIGNAL_KIND_FINDING, stage, finding_text),
                tool(stage, item.offline_runs[0]["tool_calls"][0]["args"]["path"]),
            ],
            {"mode": mode, "route": route, "stage": stage, "escalated": escalated},
        )
        assert result.passed, (number, stage)
        assert stage in result.stages_hit


def _run_by_disposition(number: int, disposition: str) -> dict:
    item = scenario(number)
    return next(
        run for run in item.offline_runs
        if run.get("expected_disposition") == disposition
    )


def _evaluate_corpus_run(item, run: dict) -> object:
    """Evaluate one corpus offline run exactly the way the offline gate does."""
    stage = run["stage"]
    signals = [ReviewSignal(SIGNAL_KIND_FINDING, stage, finding["message"]) for finding in run.get("findings", []) if finding.get("message")]
    if run.get("review_markdown"):
        signals.append(mention(stage, run["review_markdown"]))
    signals.extend(tool(stage, call["args"]["path"]) for call in run.get("tool_calls", []))
    metadata = {
        "mode": run.get("mode", "standard"),
        "route": run.get("route", "primary"),
        "stage": stage,
        "expected_disposition": run.get("expected_disposition"),
    }
    return evaluate_semantic_capability(item, signals, metadata)


@pytest.mark.parametrize("number", [6541, 6543, 6545, 6547, 6549])
def test_661_adversarial_runs_land_in_their_disposition_category(number: int) -> None:
    """Every corpus run that declares a disposition must be scored into it.

    This is the offline gate exercising the full #661 scoring taxonomy on the
    #659 corpus: not-found, suppressed-as-pre-existing, invalid remediation,
    speculative false positive, and correct detection with correct remediation
    reasoning. Calibration is recognized, but a deliberately bad answer-key
    output is NEVER a successful reviewer run.
    """
    item = scenario(number)
    declared = [run for run in item.offline_runs if run.get("expected_disposition")]
    assert declared, number
    for run in declared:
        result = _evaluate_corpus_run(item, run)
        assert result.disposition == run["expected_disposition"], (number, run["expected_disposition"], result.disposition)
        assert result.calibration_run is True, (number, run["expected_disposition"])
        assert result.disposition_calibration_pass is True, (number, run["expected_disposition"], result.disposition_violations)
        if run["expected_disposition"] == DISPOSITION_CORRECT:
            assert result.passed, (number, result.disposition_violations)
            assert all(anchor["satisfied"] for anchor in result.anchor_results), number
        else:
            assert result.passed is False, (number, run["expected_disposition"])


def test_661_all_five_disposition_categories_are_exercised() -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    seen = {
        run["expected_disposition"]
        for scenario_item in corpus.scenarios
        for run in scenario_item.offline_runs
        if run.get("expected_disposition")
    }
    assert seen == set(MERGE_SAFETY_DISPOSITIONS_ORDER)


@pytest.mark.parametrize(
    ("number", "disposition"),
    [
        (6541, DISPOSITION_SPECULATIVE_FALSE_POSITIVE),
        (6543, DISPOSITION_NOT_FOUND),
        (6545, DISPOSITION_SUPPRESSED_PRE_EXISTING),
        (6545, DISPOSITION_INVALID_REMEDIATION),
        (6547, DISPOSITION_INVALID_REMEDIATION),
        (6549, DISPOSITION_INVALID_REMEDIATION),
    ],
)
def test_661_bad_answer_key_is_recognized_but_never_a_reviewer_success(number: int, disposition: str) -> None:
    """A deliberately bad reference output must not count as a passing review."""
    item = scenario(number)
    run = _run_by_disposition(number, disposition)
    result = _evaluate_corpus_run(item, run)
    assert result.disposition == disposition, (number, result.disposition)
    assert result.disposition_calibration_pass is True, (number, result.disposition_violations)
    assert result.passed is False, (number, disposition)


def test_661_suppressed_pre_existing_is_a_merge_safety_miss() -> None:
    """A reviewer output that suppresses as pre-existing fails review quality.

    The same output, used as the answer-key calibration fixture, is recognized
    by the scorer — recognition and reviewer success are independent metrics.
    """
    item = scenario(6545)
    run = _run_by_disposition(6545, DISPOSITION_SUPPRESSED_PRE_EXISTING)
    reviewer_run = {key: value for key, value in run.items() if key != "expected_disposition"}
    result = _evaluate_corpus_run(item, reviewer_run)
    assert result.calibration_run is False
    assert result.disposition == DISPOSITION_SUPPRESSED_PRE_EXISTING
    assert result.suppressed_pre_existing is True
    assert result.passed is False
    calibrated = _evaluate_corpus_run(item, run)
    assert calibrated.disposition_calibration_pass is True
    assert calibrated.passed is False


def test_661_attribution_metadata_without_suppression_stays_correct() -> None:
    """Naming the pre-existing origin while still blocking merge is not suppression."""
    item = scenario(6545)
    text = (
        "fork_ci_gate launches a credential-bearing CI child but there is no abnormal-exit cleanup, "
        "so a parent exit between fork and join leaves an orphaned CI child; the env -i allowlist also "
        "drops RUNNER_TRACKING_ID. This defect is pre-existing on this branch but still blocks the "
        "resulting tree and is not a follow-up issue; it must be fixed before merge. Install an "
        "abnormal-exit trap that reaps the full descendant tree on EXIT/INT/TERM and forwards "
        "RUNNER_TRACKING_ID."
    )
    result = evaluate_semantic_capability(
        item,
        [
            ReviewSignal(SIGNAL_KIND_FINDING, "primary", text),
            tool("primary", "scripts/gating.sh"),
        ],
        {"mode": "standard", "route": "primary", "stage": "primary", "expected_disposition": DISPOSITION_CORRECT},
    )
    assert result.suppressed_pre_existing is False
    assert result.disposition == DISPOSITION_CORRECT
    assert result.passed


def test_661_wrapper_only_lifecycle_remediation_is_rejected() -> None:
    """Correct detection + wrapper-only repair is an invalid-remediation miss.

    The wrapper-only repair (a trap that signals only the tracked wrapper
    child) and the assumed-outer-runner cleanup are the two lifecycle
    remediation shapes the methodology must reject: as reviewer outputs they
    fail review quality, and as answer-key fixtures the scorer recognizes them.
    """
    for number in (6545, 6547):
        item = scenario(number)
        run = _run_by_disposition(number, DISPOSITION_INVALID_REMEDIATION)
        reviewer_run = {key: value for key, value in run.items() if key != "expected_disposition"}
        result = _evaluate_corpus_run(item, reviewer_run)
        assert result.disposition == DISPOSITION_INVALID_REMEDIATION, number
        assert result.remediation_ok is False
        assert result.passed is False, number
        calibrated = _evaluate_corpus_run(item, run)
        assert calibrated.disposition_calibration_pass is True


def test_661_undeclared_dependency_fallback_repair_is_rejected() -> None:
    """Correct detection + keep-the-fallback repair is an invalid-remediation miss."""
    item = scenario(6549)
    run = _run_by_disposition(6549, DISPOSITION_INVALID_REMEDIATION)
    reviewer_run = {key: value for key, value in run.items() if key != "expected_disposition"}
    result = _evaluate_corpus_run(item, reviewer_run)
    assert result.disposition == DISPOSITION_INVALID_REMEDIATION
    assert result.remediation_ok is False
    assert result.passed is False
    calibrated = _evaluate_corpus_run(item, run)
    assert calibrated.disposition_calibration_pass is True


def test_661_correct_remediation_reasoning_passes() -> None:
    """The same detections with sound tree-aware repairs stay correct."""
    for number in (6545, 6547, 6549):
        item = scenario(number)
        run = _run_by_disposition(number, DISPOSITION_CORRECT)
        reviewer_run = {key: value for key, value in run.items() if key != "expected_disposition"}
        result = _evaluate_corpus_run(item, reviewer_run)
        assert result.disposition == DISPOSITION_CORRECT, (number, result.disposition)
        assert result.remediation_ok is True
        assert result.passed, (number, result.disposition_violations)
        assert all(anchor["satisfied"] for anchor in result.anchor_results), number
        calibrated = _evaluate_corpus_run(item, run)
        assert calibrated.disposition_calibration_pass is True
        assert calibrated.passed is True


def test_661_correct_calibration_still_respects_evidence_anchors() -> None:
    """A `correct` answer key cannot pass without the scenario's anchors.

    Calibration (did the scorer say `correct`?) and review quality (did the
    output satisfy capability AND evidence-anchor contract?) are independent:
    this fixture satisfies the causal capability and the remediation contract
    but drops the runner-tracking anchor, so the scorer recognizes it as
    `correct` while review quality still fails it.
    """
    item = scenario(6545)
    partial = (
        "fork_ci_gate launches a credential-bearing CI child but there is no abnormal-exit cleanup, "
        "so a parent exit between fork and join leaves an orphaned CI child. Install an abnormal-exit "
        "trap that reaps the full descendant tree on EXIT/INT/TERM."
    )
    result = evaluate_semantic_capability(
        item,
        [ReviewSignal(SIGNAL_KIND_FINDING, "primary", partial), tool("primary", "scripts/gating.sh")],
        {"mode": "standard", "route": "primary", "stage": "primary", "expected_disposition": DISPOSITION_CORRECT},
    )
    assert result.disposition == DISPOSITION_CORRECT
    assert result.disposition_calibration_pass is True
    assert result.passed is False
    assert any(anchor["id"] == "runner-tracking" and not anchor["satisfied"] for anchor in result.anchor_results)


def test_661_reference_detections_without_remediation_stay_correct() -> None:
    """The #659 reference runs (detection-only) are not penalized as bad remediation."""
    for number in (6545, 6547, 6549):
        item = scenario(number)
        for run in item.offline_runs:
            if run.get("expected_disposition"):
                continue
            result = _evaluate_corpus_run(item, run)
            assert result.disposition == DISPOSITION_CORRECT, (number, result.disposition)
            assert result.passed, number


def test_661_speculative_and_not_found_are_distinguished() -> None:
    speculative = _evaluate_corpus_run(scenario(6541), _run_by_disposition(6541, DISPOSITION_SPECULATIVE_FALSE_POSITIVE))
    assert speculative.disposition == DISPOSITION_SPECULATIVE_FALSE_POSITIVE
    assert speculative.disposition != DISPOSITION_NOT_FOUND
    missed = _evaluate_corpus_run(scenario(6543), _run_by_disposition(6543, DISPOSITION_NOT_FOUND))
    assert missed.disposition == DISPOSITION_NOT_FOUND
    assert missed.disposition != DISPOSITION_SPECULATIVE_FALSE_POSITIVE


def test_661_disposition_contract_is_stage_neutral() -> None:
    """The disposition scoring must not depend on which tier produced the run."""
    item = scenario(6545)
    run = _run_by_disposition(6545, DISPOSITION_SUPPRESSED_PRE_EXISTING)
    for stage in ("specialist", "primary", "escalation"):
        stage_run = json.loads(json.dumps(run))
        stage_run["stage"] = stage
        for finding in stage_run["findings"]:
            finding["stage"] = stage
        result = _evaluate_corpus_run(item, stage_run)
        assert result.disposition == DISPOSITION_SUPPRESSED_PRE_EXISTING, stage
        assert result.disposition_calibration_pass is True, (stage, result.disposition_violations)
        assert result.passed is False, stage


def test_661_report_telemetry_carries_disposition_counts() -> None:
    report = evaluate_semantic_corpus(SemanticCorpus.from_file(CORPUS))
    counts = report["summary"]["merge_safety_disposition_counts"]
    calibration_counts = report["summary"]["merge_safety_calibration_disposition_counts"]
    assert set(counts) == set(MERGE_SAFETY_DISPOSITIONS_ORDER)
    assert set(calibration_counts) == set(MERGE_SAFETY_DISPOSITIONS_ORDER)
    # The headline describes observed reviewer outputs only: the deliberately
    # bad answer-key fixtures must not appear in it.
    assert counts[DISPOSITION_SUPPRESSED_PRE_EXISTING] == 0
    assert counts[DISPOSITION_INVALID_REMEDIATION] == 0
    assert counts[DISPOSITION_SPECULATIVE_FALSE_POSITIVE] == 0
    assert counts[DISPOSITION_CORRECT] > 0
    # The answer key itself is reported separately, fully recognized.
    assert calibration_counts[DISPOSITION_SUPPRESSED_PRE_EXISTING] == 1
    assert calibration_counts[DISPOSITION_INVALID_REMEDIATION] == 3
    assert calibration_counts[DISPOSITION_SPECULATIVE_FALSE_POSITIVE] == 1
    assert calibration_counts[DISPOSITION_NOT_FOUND] == 1
    assert calibration_counts[DISPOSITION_CORRECT] == 3
    assert report["summary"]["calibration_fixture_runs"] == sum(calibration_counts.values())
    assert report["summary"]["disposition_calibration_rate"] == 1.0
    assert report["summary"]["merge_safety_suppressed_pre_existing_runs"] == 0
    lifecycle = next(item for item in report["scenarios"] if item["scenario_number"] == 6545)
    assert lifecycle["reviewer_runs"] == 3
    assert lifecycle["calibration_runs"] == 3
    assert lifecycle["pass_rate"] == 1.0
    assert lifecycle["disposition_calibration_rate"] == 1.0
    assert lifecycle["merge_safety_disposition_counts"][DISPOSITION_SUPPRESSED_PRE_EXISTING] == 0
    assert lifecycle["merge_safety_calibration_disposition_counts"][DISPOSITION_SUPPRESSED_PRE_EXISTING] == 1


def test_661_calibration_fixtures_do_not_inflate_pass_rate() -> None:
    """pass_rate is computed over reviewer outputs only.

    Every calibration fixture classifies correctly (calibration rate 1.0) yet
    the scenario's pass_rate stays an honest reviewer-quality number.
    """
    report = evaluate_semantic_corpus(SemanticCorpus.from_file(CORPUS))
    for item in report["scenarios"]:
        total = item["reviewer_runs"] + item["calibration_runs"]
        assert total == item["runs"], item["scenario_number"]
        if item["calibration_runs"]:
            expected_pass_rate = round(item["passes"] / item["reviewer_runs"], 4)
            assert item["pass_rate"] == expected_pass_rate, item["scenario_number"]
    assert report["summary"]["disposition_calibration_rate"] == 1.0
    assert report["summary"]["pass_rate"] == 1.0
    assert report["passed"] is True


def test_661_genuine_miss_fails_the_gate_despite_clean_calibration() -> None:
    """A real reviewer run that misses the defect fails the gate.

    Even with every calibration fixture recognized, the semantic regression
    gate must fail when an actual (non-answer-key) run misses the scenario —
    the headline pass_rate can never reach 1.0 on the strength of bad
    answer-key fixtures matching their labels.
    """
    corpus = SemanticCorpus.from_file(CORPUS)
    assert evaluate_semantic_corpus(corpus)["passed"] is True
    item = next(s for s in corpus.scenarios if s.number == 6545)
    item.offline_runs.append({
        "mode": "standard",
        "stage": "primary",
        "route": "primary",
        "findings": [{"stage": "primary", "message": GENERIC_WARNINGS[0]}],
        "review_markdown": GENERIC_WARNINGS[0],
    })
    report = evaluate_semantic_corpus(corpus)
    assert report["passed"] is False
    assert report["summary"]["disposition_calibration_rate"] == 1.0
    lifecycle = next(item for item in report["scenarios"] if item["scenario_number"] == 6545)
    assert lifecycle["reviewer_runs"] == 4
    assert lifecycle["pass_rate"] < 1.0
    assert lifecycle["disposition_calibration_rate"] == 1.0


def test_661_negative_controls_stay_clean_under_disposition_scoring() -> None:
    corpus = SemanticCorpus.from_file(CORPUS)
    for item in corpus.scenarios:
        if not item.negative_control:
            continue
        for run in item.offline_runs:
            result = _evaluate_corpus_run(item, run)
            assert result.disposition in (DISPOSITION_CORRECT, DISPOSITION_NOT_FOUND), (item.number, result.disposition)
            assert result.disposition != DISPOSITION_SPECULATIVE_FALSE_POSITIVE, item.number
            assert result.disposition != DISPOSITION_INVALID_REMEDIATION, item.number


def test_661_schema_rejects_unknown_disposition_and_remediation_keys() -> None:
    bad_disposition = scenario(6545).to_dict()
    bad_disposition["offline_runs"][0]["expected_disposition"] = "mostly-fine"
    with pytest.raises(SemanticCorpusError, match="expected_disposition"):
        validate_semantic_corpus(SemanticCorpus([SemanticScenario.from_dict(bad_disposition)]))
    bad_keys = scenario(6545).to_dict()
    bad_keys["remediation_expectations"] = {"optional": ["sure"]}
    with pytest.raises(SemanticCorpusError, match="remediation_expectations key"):
        validate_semantic_corpus(SemanticCorpus([SemanticScenario.from_dict(bad_keys)]))


def test_661_matching_is_punctuation_robust_but_not_paraphrase_permissive() -> None:
    """The classify_signal normalization is an instrument-correctness fix.

    It lets a finding that markdown-emphasizes a phrase already in the
    vocabulary match through backticks / a unicode apostrophe, but it must NOT
    accept paraphrase or generic reassurance: the exact curated phrase is still
    required, so the benchmark is not made easier.
    """
    base = "pgrep is missing"
    assert classify_signal(base) == CAPABILITY_UNDECLARED_CAPABILITY_DEPENDENCY
    # Markdown emphasis or a unicode right single quote must not defeat the hit.
    assert classify_signal("`pgrep` is missing") == CAPABILITY_UNDECLARED_CAPABILITY_DEPENDENCY
    assert classify_signal("don\u2019t worry, pgrep is missing") == CAPABILITY_UNDECLARED_CAPABILITY_DEPENDENCY
    # Paraphrase / vague prose must NOT be promoted to a capability hit.
    for paraphrase in (
        "the process tree may need attention eventually",
        "consider tidying up background jobs",
        "looks fine, cleanup is probably handled elsewhere",
    ):
        assert classify_signal(paraphrase) is None, paraphrase
