"""Validation of evals/corpus-specialists.json against the NEW two-list
specialist_expectations schema (deep-review #610), plus grading smokes that
prove the corpus and the scorer stay mutually consistent.

All runs are synthetic: findings in the PRODUCTION shape
(severity/category/file/line/message — no 'description' key) and specialists
telemetry carrying leads_by_role over the closed role set.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from eval_harness import (
    BenchmarkCorpus,
    BenchmarkResult,
    ReviewRun,
    SPECIALIST_ROLES,
    evaluate_capability,
    evaluate_specialist_expectations,
    generate_report,
)


CORPUS_PATH = Path(__file__).resolve().parent.parent / "evals" / "corpus-specialists.json"

REPO = "misospace/pr-reviewer-action"
EXPECTED_NUMBERS = [547, 551, 612, 622, 597]
NEGATIVE_CONTROL_NUMBER = 622
DEDUPE_NUMBER = 597

# Closed check-type sets per grading scope (the two-list schema).
LEAD_CHECK_TYPES = {"lead_generated", "lead_disposition"}
EFFECTIVENESS_CHECK_TYPES = {"final_findings_count", "dedupe_final_findings"}


def corpus() -> BenchmarkCorpus:
    return BenchmarkCorpus.from_file(CORPUS_PATH)


def scenario(number: int) -> dict:
    return next(pr for pr in corpus().prs if pr["number"] == number)


def expectations(number: int) -> dict:
    return scenario(number)["specialist_expectations"]


# ---------------------------------------------------------------------------
# Corpus schema: two-list structure, closed check types, evidence mandates
# ---------------------------------------------------------------------------

def test_corpus_loads_exactly_five_unique_fixtures() -> None:
    loaded = corpus()
    assert len(loaded.prs) == 5
    numbers = [pr["number"] for pr in loaded.prs]
    assert set(numbers) == {547, 551, 612, 622, 597}
    assert len(set(numbers)) == len(numbers)
    assert all(pr["repo_full_name"] == REPO for pr in loaded.prs)


def test_expectations_carry_both_check_lists_with_closed_types() -> None:
    for pr in corpus().prs:
        exp = pr["specialist_expectations"]
        lead_checks = exp["lead_checks"]
        eff_checks = exp["effectiveness_checks"]
        assert isinstance(lead_checks, list), f"PR {pr['number']}: lead_checks"
        assert isinstance(eff_checks, list), f"PR {pr['number']}: effectiveness_checks"
        # A/B comparability: every fixture declares a comparable subset.
        assert eff_checks, (
            f"PR {pr['number']}: effectiveness_checks empty "
            "(A/B comparability requires non-empty)"
        )
        for check in lead_checks:
            assert check["type"] in LEAD_CHECK_TYPES, (
                f"PR {pr['number']}: unknown lead check type {check['type']!r}"
            )
            assert check.get("id")
        for check in eff_checks:
            assert check["type"] in EFFECTIVENESS_CHECK_TYPES, (
                f"PR {pr['number']}: unknown effectiveness check type "
                f"{check['type']!r}"
            )
            assert check.get("id")
        for check in lead_checks:
            role = check.get("role")
            if role is not None:
                roles = role if isinstance(role, list) else [role]
                assert set(roles) <= set(SPECIALIST_ROLES), (
                    f"PR {pr['number']}: role {roles!r} outside the closed set"
                )


def test_verified_dispositions_carry_concrete_file_evidence() -> None:
    for pr in corpus().prs:
        for check in pr["specialist_expectations"]["lead_checks"]:
            if check["type"] == "lead_disposition" and check.get("disposition") == "verified":
                file_any = check.get("finding_file_any")
                assert file_any, (
                    f"PR {pr['number']} check {check.get('id')!r}: "
                    "disposition 'verified' mandates a non-empty finding_file_any"
                )
                assert all(str(needle).strip() for needle in file_any)


def test_exactly_one_negative_control_with_max_bounded_effectiveness() -> None:
    flagged = [
        pr["number"]
        for pr in corpus().prs
        if pr["specialist_expectations"].get("negative_control")
    ]
    assert flagged == [NEGATIVE_CONTROL_NUMBER]

    control = scenario(NEGATIVE_CONTROL_NUMBER)["specialist_expectations"]
    assert control["lead_checks"] == []
    assert control["effectiveness_checks"]
    for check in control["effectiveness_checks"]:
        assert check["type"] in EFFECTIVENESS_CHECK_TYPES
        assert check.get("max") == 0, (
            f"negative control {check.get('id')!r} must be max-bounded at 0"
        )

    tool_bounds = [
        check
        for check in scenario(NEGATIVE_CONTROL_NUMBER)["expected_evidence"]["checks"]
        if check["type"] == "max_tool_calls"
    ]
    assert tool_bounds, "negative control must bound tool calls"
    for check in tool_bounds:
        assert isinstance(check.get("max"), int) and not isinstance(check["max"], bool)


def test_dedupe_fixture_expects_leads_from_both_roles() -> None:
    lead_checks = scenario(DEDUPE_NUMBER)["specialist_expectations"]["lead_checks"]
    generated_roles = {
        role
        for check in lead_checks
        if check["type"] == "lead_generated"
        for role in (
            check["role"] if isinstance(check["role"], list) else [check["role"]]
        )
    }
    assert {"security", "correctness"} <= generated_roles


# ---------------------------------------------------------------------------
# Synthetic run builders (production finding shape, leads_by_role telemetry)
# ---------------------------------------------------------------------------

def _lead(category: str, message: str, file: str | None = None) -> dict:
    return {
        "severity": "minor",
        "category": category,
        "file": file,
        "line": None,
        "message": message,
    }


def _finding(
    category: str,
    message: str,
    file: str | None = None,
    line: int | None = None,
    severity: str = "high",
) -> dict:
    """A production-shape final finding (no 'description' key)."""
    return {
        "severity": severity,
        "category": category,
        "file": file,
        "line": line,
        "message": message,
    }


def _specialists(leads_by_role: dict) -> dict:
    return {
        "leads_by_role": {
            role: leads_by_role.get(role, []) for role in SPECIALIST_ROLES
        },
    }


def _standard_run(number: int, findings: list[dict]) -> ReviewRun:
    """A standard (non-deep) run: no specialist telemetry at all."""
    return ReviewRun(
        mode="native_loop",
        pr_number=number,
        repo_full_name=REPO,
        deep_review=False,
        findings=findings,
    )


def _deep_run(number: int, leads_by_role: dict, findings: list[dict]) -> ReviewRun:
    return ReviewRun(
        mode="native_loop+deep",
        pr_number=number,
        repo_full_name=REPO,
        deep_review=True,
        specialists=_specialists(leads_by_role),
        findings=findings,
    )


# Synthetic per-fixture material: leads satisfying each fixture's lead
# predicates (with the lead's file present) and file-grounded final findings
# satisfying the finding-side predicates. These must grade green against the
# corpus as written — the fixtures and the scorer stay mutually consistent.
FIXTURES = {
    547: {
        "leads": {
            "security": [_lead(
                "security",
                "concurrent _get_jwt() calls can pass the TTL check together "
                "and issue duplicate OIDC token-exchange POSTs",
                "pr_reviewer/forgejo_backend.py",
            )],
        },
        "findings": [
            _finding(
                "security",
                "concurrent _get_jwt() calls can pass the TTL check together "
                "and issue duplicate OIDC token-exchange POSTs",
                file="pr_reviewer/forgejo_backend.py",
                line=142,
            ),
        ],
    },
    551: {
        "leads": {
            "correctness": [_lead(
                "correctness",
                "needs_full_review not propagated, so the carried finding "
                "loops on incremental diffs",
                "pr_reviewer/carry_forward.py",
            )],
        },
        "findings": [
            _finding(
                "correctness",
                "needs_full_review not propagated, so the carried finding "
                "loops on incremental diffs",
                file="pr_reviewer/carry_forward.py",
                line=88,
            ),
        ],
    },
    612: {
        "leads": {
            "tests": [_lead(
                "tests",
                "no test coverage for severity alias and cap normalization",
                "pr_reviewer/specialists.py",
            )],
        },
        "findings": [
            _finding(
                "tests",
                "no test coverage for severity alias and cap normalization",
                file="pr_reviewer/specialists.py",
                line=12,
            ),
        ],
    },
    622: {
        "leads": {},
        "findings": [],
    },
    597: {
        "leads": {
            "security": [_lead(
                "security",
                "dismiss permission check fails open when it cannot run",
                "pr_reviewer/precheck.py",
            )],
            "correctness": [_lead(
                "correctness",
                "fail-open dismiss permission check",
                "pr_reviewer/precheck.py",
            )],
        },
        "findings": [
            _finding(
                "security",
                "precheck must fail closed when the dismiss permission check "
                "cannot run",
                file="pr_reviewer/precheck.py",
                line=23,
            ),
        ],
    },
}


# ---------------------------------------------------------------------------
# Grading smokes
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("number", EXPECTED_NUMBERS)
def test_standard_run_satisfying_only_effectiveness_checks(number: int) -> None:
    """Standard runs grade only effectiveness: file-grounded findings pass,
    lead_passed stays None (lead checks are never graded off deep runs)."""
    run = _standard_run(number, FIXTURES[number]["findings"])
    result = evaluate_specialist_expectations(run, expectations(number))
    assert result is not None
    assert result["effectiveness_passed"] is True
    assert result["lead_passed"] is None
    assert result["passed"] is True
    assert all(c["scope"] == "effectiveness" for c in result["checks"])


@pytest.mark.parametrize("number", EXPECTED_NUMBERS)
def test_deep_run_with_matching_leads_and_adopted_findings_passes(number: int) -> None:
    data = FIXTURES[number]
    run = _deep_run(number, data["leads"], data["findings"])
    result = evaluate_specialist_expectations(run, expectations(number))
    assert result is not None
    assert result["effectiveness_passed"] is True
    if expectations(number)["lead_checks"]:
        assert result["lead_passed"] is True
    else:
        # The negative control declares no lead checks: nothing to grade.
        assert result["lead_passed"] is None
    assert result["passed"] is True


@pytest.mark.parametrize("number, adopted_check_id", [
    (547, "security_lead_adopted"),
    (551, "correctness_lead_adopted"),
    (612, "tests_lead_adopted"),
    (597, "precheck_lead_adopted"),
])
def test_parroting_finding_without_file_computes_rejected(
    number: int, adopted_check_id: str
) -> None:
    """F1/F2/F3/F5: the final finding repeats the lead's category/message
    needles but carries no file (the lead does). The 'verified' check must
    compute 'rejected' — parroting is not verification."""
    data = FIXTURES[number]
    fileless = [
        {**finding, "file": None} for finding in data["findings"]
    ]
    run = _deep_run(number, data["leads"], fileless)
    result = evaluate_specialist_expectations(run, expectations(number))
    assert result is not None
    by_id = {c["id"]: c for c in result["checks"]}
    adopted = by_id[adopted_check_id]
    assert adopted["type"] == "lead_disposition"
    assert adopted["scope"] == "lead"
    assert adopted["passed"] is False
    assert "rejected" in adopted["detail"]


def test_f1_standard_run_lacking_expected_finding_fails() -> None:
    run = _standard_run(547, [])
    result = evaluate_specialist_expectations(run, expectations(547))
    assert result is not None
    assert result["effectiveness_passed"] is False
    by_id = {c["id"]: c for c in result["checks"]}
    assert by_id["expected_finding_detected"]["passed"] is False
    # The hallucination guard is independent: with no findings it still passes.
    assert by_id["no_hallucinated_secret_finding"]["passed"] is True
    assert result["lead_passed"] is None


def test_f4_clean_deep_run_passes() -> None:
    """F4 (negative control): no findings, no leads — the lean clean run."""
    run = _deep_run(622, {}, [])
    result = evaluate_specialist_expectations(run, expectations(622))
    assert result is not None
    assert result["passed"] is True
    assert result["effectiveness_passed"] is True
    assert result["lead_passed"] is None


def test_f4_deep_run_with_fabricated_finding_fails() -> None:
    run = _deep_run(
        622,
        {},
        [_finding("style", "unnecessary comment", severity="info")],
    )
    result = evaluate_specialist_expectations(run, expectations(622))
    assert result is not None
    assert result["passed"] is False
    assert result["effectiveness_passed"] is False
    assert all(not c["passed"] for c in result["checks"]
               if c["type"] in ("final_findings_count", "dedupe_final_findings"))


def test_f4_negative_control_tool_call_bound() -> None:
    evidence = scenario(622)["expected_evidence"]
    lean = _deep_run(622, {}, [])
    lean.tool_calls = [
        {"tool": "list_tree", "args": {"path": ".github/workflows"}, "status": "ok"},
        {"tool": "read_file", "args": {"path": ".github/workflows/codeql.yml"},
         "status": "ok"},
    ]
    assert evaluate_capability(lean, evidence)["passed"] is True

    bloated = _deep_run(622, {}, [])
    bloated.tool_calls = [
        {"tool": "list_tree", "args": {"path": f"dir{i}"}, "status": "ok"}
        for i in range(5)
    ]
    assert evaluate_capability(bloated, evidence)["passed"] is False


# ---------------------------------------------------------------------------
# Report integration: per-label tallies for standard vs deep runs
# ---------------------------------------------------------------------------

def test_generate_report_specialist_tallies_per_label() -> None:
    corpus_obj = corpus()
    results = [
        BenchmarkResult(
            pr_number=547,
            repo_full_name=REPO,
            runs=[
                _standard_run(547, FIXTURES[547]["findings"]),
                _deep_run(547, FIXTURES[547]["leads"], FIXTURES[547]["findings"]),
            ],
        ),
        BenchmarkResult(
            pr_number=622,
            repo_full_name=REPO,
            runs=[
                _standard_run(622, []),
                _deep_run(622, {}, []),
            ],
        ),
    ]
    report = generate_report(results, corpus_obj)

    summary = report["mode_summary"]
    std = summary["native_loop"]
    deep = summary["native_loop+deep"]

    # Effectiveness: the comparable A/B subset, graded on BOTH labels.
    assert std["specialist_effectiveness_runs"] == 2
    assert std["specialist_effectiveness_passes"] == 2
    assert std["specialist_effectiveness_pass_rate"] == 1.0
    assert deep["specialist_effectiveness_runs"] == 2
    assert deep["specialist_effectiveness_passes"] == 2
    assert deep["specialist_effectiveness_pass_rate"] == 1.0

    # Lead: deep-only diagnostics. Standard label is never lead-graded;
    # the deep label tallies only 547 (622 declares no lead checks).
    assert std["specialist_lead_runs"] == 0
    assert std["specialist_lead_passes"] == 0
    assert std["specialist_lead_pass_rate"] is None
    assert deep["specialist_lead_runs"] == 1
    assert deep["specialist_lead_passes"] == 1
    assert deep["specialist_lead_pass_rate"] == 1.0

    per_547 = next(e for e in report["per_pr_results"] if e["pr_number"] == 547)
    per_622 = next(e for e in report["per_pr_results"] if e["pr_number"] == 622)

    # Per-PR rate dicts: effectiveness on both labels; lead on deep only.
    assert per_547["specialist_effectiveness_pass_rate"] == {
        "native_loop": 1.0, "native_loop+deep": 1.0,
    }
    assert per_547["specialist_lead_pass_rate"] == {"native_loop+deep": 1.0}
    assert per_622["specialist_effectiveness_pass_rate"] == {
        "native_loop": 1.0, "native_loop+deep": 1.0,
    }
    assert "specialist_lead_pass_rate" not in per_622

    # Per-mode detail entries carry the graded specialist capability.
    assert per_547["native_loop"]["specialist_capability"]["lead_passed"] is None
    assert per_547["native_loop"]["specialist_capability"]["effectiveness_passed"] is True
    assert per_547["native_loop+deep"]["specialist_capability"]["lead_passed"] is True
    assert per_547["native_loop+deep"]["specialist_capability"]["effectiveness_passed"] is True
    assert per_622["native_loop+deep"]["specialist_capability"]["lead_passed"] is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
