from __future__ import annotations

import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from eval_harness import (
    BenchmarkCorpus,
    ReviewRun,
    SPECIALIST_ROLES,
    evaluate_capability,
    evaluate_specialist_expectations,
)


CORPUS_PATH = Path(__file__).resolve().parent.parent / "evals" / "corpus-specialists.json"

# The closed set of check types implemented by evaluate_specialist_expectations.
SPECIALIST_CHECK_TYPES = {
    "lead_generated",
    "lead_disposition",
    "final_findings_count",
    "dedupe_final_findings",
}

REPO = "misospace/pr-reviewer-action"
EXPECTED_NUMBERS = [547, 551, 612, 622, 597]
NEGATIVE_CONTROL_NUMBER = 622
DEDUPE_NUMBER = 597


def corpus() -> BenchmarkCorpus:
    return BenchmarkCorpus.from_file(CORPUS_PATH)


def scenario(number: int) -> dict:
    return next(pr for pr in corpus().prs if pr["number"] == number)


def expectations(number: int) -> dict:
    return scenario(number)["specialist_expectations"]


def checks_of(number: int) -> list[dict]:
    return expectations(number)["checks"]


# ---------------------------------------------------------------------------
# Corpus schema and closed-set validation
# ---------------------------------------------------------------------------

def test_specialists_corpus_schema_and_load() -> None:
    loaded = corpus()
    assert [pr["number"] for pr in loaded.prs] == EXPECTED_NUMBERS
    assert len(loaded.prs) == 5
    numbers = [pr["number"] for pr in loaded.prs]
    assert len(set(numbers)) == len(numbers)
    assert all(pr["repo_full_name"] == REPO for pr in loaded.prs)
    assert all(
        pr["url"] == f"https://github.com/{REPO}/pull/{pr['number']}"
        for pr in loaded.prs
    )
    for pr in loaded.prs:
        assert {
            "number", "repo_full_name", "url", "title",
            "known_findings", "specialist_expectations",
        } <= pr.keys()
        expected = pr["specialist_expectations"]
        assert isinstance(expected.get("description"), str)
        assert expected["description"]
        assert expected["checks"]
        for item in expected["checks"]:
            assert item["type"] in SPECIALIST_CHECK_TYPES
            assert item.get("id")
            role = item.get("role")
            if role is not None:
                roles = role if isinstance(role, list) else [role]
                assert set(roles) <= set(SPECIALIST_ROLES)


def test_exactly_one_negative_control_with_zero_findings_and_tool_bound() -> None:
    flagged = [
        pr["number"] for pr in corpus().prs
        if pr["specialist_expectations"].get("negative_control")
    ]
    assert flagged == [NEGATIVE_CONTROL_NUMBER]
    control = scenario(NEGATIVE_CONTROL_NUMBER)
    checks = control["specialist_expectations"]["checks"]
    assert not any(item["type"] == "lead_generated" for item in checks)
    assert any(
        item["type"] == "final_findings_count" and item.get("max") == 0
        for item in checks
    )
    tool_bounds = [
        item for item in control["expected_evidence"]["checks"]
        if item["type"] == "max_tool_calls"
    ]
    assert tool_bounds


def test_dedupe_fixture_requires_leads_from_both_roles() -> None:
    checks = checks_of(DEDUPE_NUMBER)
    assert any(item["type"] == "dedupe_final_findings" for item in checks)
    generated_roles = {
        role
        for item in checks
        if item["type"] == "lead_generated"
        for role in (item["role"] if isinstance(item["role"], list) else [item["role"]])
    }
    assert {"security", "correctness"} <= generated_roles


# ---------------------------------------------------------------------------
# Corpus grading smoke: synthetic fully-successful deep run per fixture
# ---------------------------------------------------------------------------

def _lead(category: str, message: str, file: str | None = None) -> dict:
    return {
        "severity": "minor",
        "category": category,
        "file": file,
        "line": None,
        "message": message,
    }


def _finding(category: str, description: str, severity: str = "high") -> dict:
    return {"category": category, "severity": severity, "description": description}


def _deep_run(number: int, leads_by_role: dict, findings: list[dict],
              tool_calls: list[dict] | None = None) -> ReviewRun:
    entry = scenario(number)
    return ReviewRun(
        mode="native_loop+deep",
        pr_number=number,
        repo_full_name=entry["repo_full_name"],
        deep_review=True,
        specialists={
            "leads_by_role": {
                role: leads_by_role.get(role, []) for role in SPECIALIST_ROLES
            }
        },
        findings=findings,
        tool_calls=tool_calls or [],
    )


# Synthetic fully-successful deep runs: leads satisfying each fixture's
# lead predicates, adopted findings satisfying the finding-side predicates,
# tool counts within any declared bound. These must grade green against the
# corpus as written — the fixtures and the scorer stay mutually consistent.
SYNTHETIC = {
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
            ),
        ],
    },
    551: {
        "leads": {
            "correctness": [_lead(
                "correctness",
                "carried findings with an unverifiable delta never propagate "
                "needs_full_review, so the incremental loop is stuck",
                "pr_reviewer/carry_forward.py",
            )],
        },
        "findings": [
            _finding(
                "correctness",
                "case-2 carried findings loop forever on incremental diffs "
                "when needs_full_review was not propagated",
            ),
        ],
    },
    612: {
        "leads": {
            "tests": [_lead(
                "tests",
                "no test covers severity alias and cap normalization in the "
                "advisory contract",
                "pr_reviewer/specialists.py",
            )],
        },
        "findings": [
            _finding(
                "tests",
                "add a test covering severity alias normalization to the cap",
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
                "permission",
                "precheck dismiss permission check must fail closed when it "
                "cannot run",
                "pr_reviewer/precheck.py",
            )],
            "correctness": [_lead(
                "correctness",
                "fail-open when the dismiss permission check cannot run",
                "pr_reviewer/precheck.py",
            )],
        },
        "findings": [
            _finding(
                "permission",
                "precheck must fail closed when the dismiss permission check "
                "cannot run",
            ),
        ],
    },
}


@pytest.mark.parametrize("number", EXPECTED_NUMBERS)
def test_synthetic_successful_deep_run_passes_each_fixture(number: int) -> None:
    data = SYNTHETIC[number]
    run = _deep_run(number, data["leads"], data["findings"])
    result = evaluate_specialist_expectations(run, expectations(number))
    assert result is not None
    assert result["passed"] is True, [
        c for c in result["checks"] if not c["passed"]
    ]


def test_negative_control_within_tool_call_bound_passes() -> None:
    run = _deep_run(
        622,
        {},
        [],
        tool_calls=[
            {"tool": "list_tree",
             "args": {"path": ".github/workflows"}, "status": "ok"},
            {"tool": "read_file",
             "args": {"path": ".github/workflows/codeql.yml"}, "status": "ok"},
        ],
    )
    result = evaluate_capability(run, scenario(622)["expected_evidence"])
    assert result is not None
    assert result["passed"] is True


# ---------------------------------------------------------------------------
# Failing trace
# ---------------------------------------------------------------------------

def test_547_fails_when_security_leads_absent() -> None:
    run = _deep_run(
        547,
        {},
        [SYNTHETIC[547]["findings"][0]],
    )
    result = evaluate_specialist_expectations(run, expectations(547))
    assert result is not None
    assert result["passed"] is False
    failed = {c["id"] for c in result["checks"] if not c["passed"]}
    assert "security_lead_generated" in failed
    assert "security_lead_adopted" in failed
    # The hallucination guard is independent: with no matching finding it
    # still passes.
    assert "security_lead_not_adopted_hallucination" not in failed
