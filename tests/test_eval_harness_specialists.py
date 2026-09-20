#!/usr/bin/env python3
"""Tests for deep-review specialist support in the A/B evaluation harness (#610).

All inputs are synthetic traces; no network, no live models. Findings are
exercised in the PRODUCTION shape (severity/category/file/line/message —
no 'description' key, as pr_reviewer.response_parser emits them).
"""

import json
import sys
from pathlib import Path

# Ensure scripts directory is on path for imports
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import pytest
from eval_harness import (
    BenchmarkCorpus,
    BenchmarkResult,
    ReviewRun,
    SPECIALIST_ROLES,
    build_parser,
    evaluate_capability,
    evaluate_specialist_expectations,
    generate_report,
    load_specialist_telemetry,
    populate_review_output,
    run_label,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _lead(category, message, file=None, severity="info", line=None):
    """A normalized specialist lead (the shape carried in leads_by_role)."""
    return {
        "severity": severity,
        "category": category,
        "file": file,
        "line": line,
        "message": message,
    }


def _specialists(leads_by_role):
    """A minimal normalized specialists payload (leads_by_role only)."""
    return {
        "leads_by_role": {role: leads_by_role.get(role, []) for role in SPECIALIST_ROLES},
    }


def _finding(category, message, severity="high", file=None, line=None):
    """A production-shape final finding (severity/category/file/line/message;
    there is NO 'description' key — pr_reviewer.response_parser)."""
    return {
        "severity": severity,
        "category": category,
        "file": file,
        "line": line,
        "message": message,
    }


def _run(specialists=None, findings=None, error=None, mode="native_loop+deep"):
    return ReviewRun(
        mode=mode,
        pr_number=610,
        repo_full_name="misospace/pr-reviewer-action",
        deep_review=mode.endswith("+deep"),
        specialists=specialists,
        findings=findings or [],
        error=error,
    )


# ---------------------------------------------------------------------------
# lead_generated
# ---------------------------------------------------------------------------

class TestLeadGenerated:
    def test_passes_with_matching_role_and_category(self):
        run = _run(specialists=_specialists({
            "security": [_lead("security", "SQL injection in login handler")],
        }))
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_generated", "role": "security",
                             "category_any": "security"}],
        })
        assert result is not None
        assert result["passed"] is True
        assert result["checks"][0]["passed"] is True
        assert result["checks"][0]["scope"] == "lead"

    def test_passes_with_message_needle(self):
        run = _run(specialists=_specialists({
            "correctness": [_lead("correctness", "Off-by-one in pagination loop")],
        }))
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_generated", "role": "correctness",
                             "message_any_contains": "off-by-one"}],
        })
        assert result["passed"] is True

    def test_fails_when_role_has_no_leads(self):
        run = _run(specialists=_specialists({
            "correctness": [_lead("correctness", "off-by-one in pagination loop")],
        }))
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_generated", "role": "security"}],
        })
        assert result["passed"] is False
        assert "0" in result["checks"][0]["detail"]

    def test_fails_when_no_lead_matches_predicate(self):
        run = _run(specialists=_specialists({
            "security": [_lead("security", "missing bounds check on user input")],
        }))
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_generated", "role": "security",
                             "message_any_contains": "injection"}],
        })
        assert result["passed"] is False

    def test_min_bound_respected(self):
        run = _run(specialists=_specialists({
            "security": [_lead("security", "issue one")],
        }))
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_generated", "role": "security",
                             "min": 2}],
        })
        assert result["passed"] is False

    def test_max_bound_respected(self):
        run = _run(specialists=_specialists({
            "security": [
                _lead("security", "issue one"),
                _lead("security", "issue two"),
            ],
        }))
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_generated", "role": "security",
                             "max": 1}],
        })
        assert result["passed"] is False

    def test_within_min_max_passes(self):
        run = _run(specialists=_specialists({
            "security": [
                _lead("security", "issue one"),
                _lead("security", "issue two"),
            ],
        }))
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_generated", "role": "security",
                             "min": 1, "max": 2}],
        })
        assert result["passed"] is True

    def test_unknown_role_fails(self):
        run = _run(specialists=_specialists({
            "security": [_lead("security", "injection")],
        }))
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_generated", "role": "performance"}],
        })
        assert result["passed"] is False

    def test_predicates_are_case_insensitive(self):
        run = _run(specialists=_specialists({
            "security": [_lead("Security", "NullPointer dereference at line 42")],
        }))
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_generated", "role": "security",
                             "category_any": "sEcUrItY",
                             "message_any_contains": "nullpointer"}],
        })
        assert result["passed"] is True


# ---------------------------------------------------------------------------
# lead_disposition
# ---------------------------------------------------------------------------

class TestLeadDisposition:
    def test_verified_when_lead_and_adopted_finding(self):
        run = _run(
            specialists=_specialists({
                "security": [_lead("security", "SQL injection in login handler",
                                    "api/login.py")],
            }),
            findings=[_finding("security", "SQL injection in login handler",
                                file="api/login.py")],
        )
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_disposition", "role": "security",
                             "message_any_contains": "injection",
                             "disposition": "verified",
                             "finding_file_any": ["login"]}],
        })
        assert result["passed"] is True
        assert "verified" in result["checks"][0]["detail"]

    def test_rejected_when_lead_not_adopted(self):
        """The 'final reviewer rejects an unsupported specialist lead' path."""
        run = _run(
            specialists=_specialists({
                "security": [_lead("security", "SQL injection in login handler")],
            }),
            findings=[_finding("style", "unused import", severity="info")],
        )
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_disposition", "role": "security",
                             "message_any_contains": "injection",
                             "disposition": "rejected"}],
        })
        assert result["passed"] is True
        assert "rejected" in result["checks"][0]["detail"]

    def test_verified_expectation_fails_on_unadopted_lead(self):
        run = _run(
            specialists=_specialists({
                "security": [_lead("security", "SQL injection in login handler")],
            }),
            findings=[],
        )
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_disposition", "role": "security",
                             "disposition": "verified",
                             "finding_file_any": ["login"]}],
        })
        assert result["passed"] is False

    def test_unused_when_no_lead_generated(self):
        run = _run(
            specialists=_specialists({}),
            findings=[_finding("security", "anything")],
        )
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_disposition", "role": "security",
                             "disposition": "unused"}],
        })
        assert result["passed"] is True

    def test_any_passes_when_leads_generated(self):
        run = _run(specialists=_specialists({
            "tests": [_lead("tests", "no test for the new branch")],
        }))
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_disposition", "role": "tests",
                             "disposition": "any"}],
        })
        assert result["passed"] is True

    def test_any_fails_when_no_leads(self):
        run = _run(specialists=_specialists({}))
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_disposition", "role": "tests",
                             "disposition": "any"}],
        })
        assert result["passed"] is False

    def test_verified_without_finding_file_any_fails_defensively(self):
        """`verified` mandates concrete file grounding: a check lacking
        finding_file_any fails with an explanatory detail, even when a
        matching finding exists."""
        run = _run(
            specialists=_specialists({
                "security": [_lead("security", "SQL injection in login handler")],
            }),
            findings=[_finding("security", "SQL injection in login handler")],
        )
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_disposition", "role": "security",
                             "disposition": "verified"}],
        })
        assert result["passed"] is False
        assert "finding_file_any" in result["checks"][0]["detail"]


# ---------------------------------------------------------------------------
# final_findings_count / dedupe_final_findings
# ---------------------------------------------------------------------------

class TestFinalFindingsCount:
    def test_dedupe_passes_with_single_matching_finding(self):
        run = _run(findings=[_finding("security", "SQL injection in login handler")])
        result = evaluate_specialist_expectations(run, {
            "effectiveness_checks": [{"type": "dedupe_final_findings",
                                      "finding_category_any": "security"}],
        })
        assert result["passed"] is True

    def test_dedupe_fails_when_two_findings_match_same_target(self):
        run = _run(findings=[
            _finding("security", "SQL injection in login handler"),
            _finding("security", "SQL injection in register handler"),
        ])
        result = evaluate_specialist_expectations(run, {
            "effectiveness_checks": [{"type": "dedupe_final_findings",
                                      "finding_description_any_contains": "sql injection"}],
        })
        assert result["passed"] is False

    def test_dedupe_explicit_max_override(self):
        run = _run(findings=[
            _finding("security", "SQL injection in login handler"),
            _finding("security", "SQL injection in register handler"),
        ])
        result = evaluate_specialist_expectations(run, {
            "effectiveness_checks": [{"type": "dedupe_final_findings", "max": 2,
                                      "finding_description_any_contains": "sql injection"}],
        })
        assert result["passed"] is True

    def test_final_findings_count_min_respected(self):
        run = _run(findings=[_finding("security", "one issue")])
        result = evaluate_specialist_expectations(run, {
            "effectiveness_checks": [{"type": "final_findings_count", "min": 2}],
        })
        assert result["passed"] is False

    def test_final_findings_count_within_max_passes(self):
        run = _run(findings=[
            _finding("security", "one"),
            _finding("correctness", "two"),
        ])
        result = evaluate_specialist_expectations(run, {
            "effectiveness_checks": [{"type": "final_findings_count", "max": 2}],
        })
        assert result["passed"] is True


# ---------------------------------------------------------------------------
# Negative controls
# ---------------------------------------------------------------------------

class TestNegativeControls:
    def test_fabricated_findings_exceeding_max_fail(self):
        run = _run(findings=[
            _finding("security", "fabricated one"),
            _finding("security", "fabricated two"),
            _finding("security", "fabricated three"),
        ])
        result = evaluate_specialist_expectations(run, {
            "effectiveness_checks": [{"type": "final_findings_count", "max": 2}],
        })
        assert result["passed"] is False

    def test_zero_findings_within_max_passes(self):
        run = _run(findings=[])
        result = evaluate_specialist_expectations(run, {
            "effectiveness_checks": [{"type": "final_findings_count", "max": 2}],
        })
        assert result["passed"] is True

    def test_errored_run_fails_every_check_without_raising(self):
        run = _run(
            specialists=_specialists({
                "security": [_lead("security", "injection")],
            }),
            findings=[_finding("security", "injection")],
            error="Review timed out",
        )
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_generated", "role": "security"}],
            "effectiveness_checks": [{"type": "final_findings_count", "max": 5}],
        })
        assert result["passed"] is False
        assert all(not c["passed"] for c in result["checks"])
        for c in result["checks"]:
            assert "errored" in c["detail"]


# ---------------------------------------------------------------------------
# Unknown check type
# ---------------------------------------------------------------------------

class TestUnknownCheckType:
    def test_unknown_type_fails_with_explanatory_detail(self):
        run = _run(specialists=_specialists({
            "security": [_lead("security", "injection")],
        }))
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"id": "weird", "type": "quantum_flux"}],
        })
        assert result is not None
        assert result["passed"] is False
        check = result["checks"][0]
        assert check["id"] == "weird"
        assert check["passed"] is False
        assert "unknown" in check["detail"]


# ---------------------------------------------------------------------------
# Scope split: lead_checks (deep-only) vs effectiveness_checks (all runs)
# ---------------------------------------------------------------------------

class TestScopeSplit:
    def test_standard_run_evaluates_only_effectiveness(self):
        run = _run(
            mode="native_loop",
            specialists=_specialists({
                "security": [_lead("security", "injection")],
            }),
            findings=[_finding("security", "injection")],
        )
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_generated", "role": "security"}],
            "effectiveness_checks": [{"type": "final_findings_count", "min": 1}],
        })
        assert result is not None
        # Lead checks are not evaluated on standard runs at all.
        assert [c["scope"] for c in result["checks"]] == ["effectiveness"]
        assert result["lead_passed"] is None
        assert result["effectiveness_passed"] is True
        assert result["passed"] is True

    def test_standard_run_with_only_lead_checks_returns_none(self):
        run = _run(
            mode="native_loop",
            specialists=_specialists({
                "security": [_lead("security", "injection")],
            }),
        )
        assert evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_generated", "role": "security"}],
        }) is None

    def test_deep_run_grades_both_scopes(self):
        run = _run(
            specialists=_specialists({
                "security": [_lead("security", "injection")],
            }),
            findings=[_finding("security", "injection", file="api/login.py")],
        )
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_generated", "role": "security"},
                             {"type": "lead_disposition", "role": "security",
                              "disposition": "verified",
                              "finding_file_any": ["login"]}],
            "effectiveness_checks": [{"type": "final_findings_count", "min": 1,
                                      "finding_file_any": ["login"]}],
        })
        assert result is not None
        assert [c["scope"] for c in result["checks"]] == [
            "lead", "lead", "effectiveness",
        ]
        assert result["lead_passed"] is True
        assert result["effectiveness_passed"] is True
        assert result["passed"] is True

    def test_deep_run_with_empty_effectiveness_still_returns(self):
        run = _run(
            specialists=_specialists({
                "security": [_lead("security", "injection")],
            }),
        )
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_generated", "role": "security"}],
            "effectiveness_checks": [],
        })
        assert result is not None
        assert [c["scope"] for c in result["checks"]] == ["lead"]
        assert result["lead_passed"] is True
        assert result["effectiveness_passed"] is None

    def test_unknown_check_type_fails_soft_in_lead_scope(self):
        run = _run(
            specialists=_specialists({
                "security": [_lead("security", "injection")],
            }),
        )
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"id": "weird", "type": "quantum_flux"}],
        })
        assert result is not None
        assert result["lead_passed"] is False
        assert "unknown" in result["checks"][0]["detail"]


# ---------------------------------------------------------------------------
# Production finding shape: message (not description) is the text field
# ---------------------------------------------------------------------------

class TestFindingPredicateShape:
    def test_message_only_finding_matches_description_needles(self):
        """The production shape has no 'description' key: description
        needles must match the finding's 'message'."""
        run = _run(findings=[
            _finding("security", "JWT cache race on token exchange"),
        ])
        result = evaluate_specialist_expectations(run, {
            "effectiveness_checks": [{"type": "final_findings_count", "min": 1,
                                      "finding_category_any": "security",
                                      "finding_description_any_contains": "jwt"}],
        })
        assert result["passed"] is True

    def test_description_key_finding_still_matches(self):
        """Synthetic findings carrying a 'description' key keep working."""
        run = _run(findings=[
            {"category": "security", "severity": "high",
             "description": "JWT cache race on token exchange"},
        ])
        result = evaluate_specialist_expectations(run, {
            "effectiveness_checks": [{"type": "final_findings_count", "min": 1,
                                      "finding_description_any_contains": "jwt"}],
        })
        assert result["passed"] is True

    def test_finding_file_any_requires_matching_file(self):
        run = _run(findings=[
            _finding("security", "injection", file="api/login.py"),
        ])
        result = evaluate_specialist_expectations(run, {
            "effectiveness_checks": [{"type": "final_findings_count", "min": 1,
                                      "finding_file_any": ["login"]}],
        })
        assert result["passed"] is True

    def test_finding_file_any_excludes_fileless_finding(self):
        run = _run(findings=[
            _finding("security", "injection"),  # file is None
        ])
        result = evaluate_specialist_expectations(run, {
            "effectiveness_checks": [{"type": "final_findings_count", "min": 1,
                                      "finding_file_any": ["login"]}],
        })
        assert result["passed"] is False
        assert "0" in result["checks"][0]["detail"]

    def test_finding_file_any_excludes_nonmatching_file(self):
        run = _run(findings=[
            _finding("security", "injection", file="api/register.py"),
        ])
        result = evaluate_specialist_expectations(run, {
            "effectiveness_checks": [{"type": "final_findings_count", "min": 1,
                                      "finding_file_any": ["login"]}],
        })
        assert result["passed"] is False

    def test_finding_line_requires_integer_line(self):
        run = _run(findings=[
            _finding("security", "injection", file="api/login.py", line=42),
            _finding("security", "injection again", file="api/login.py"),
        ])
        result = evaluate_specialist_expectations(run, {
            "effectiveness_checks": [{"type": "final_findings_count", "min": 1,
                                      "finding_file_any": ["login"],
                                      "finding_line": True}],
        })
        assert result["passed"] is True
        assert "1" in result["checks"][0]["detail"]


# ---------------------------------------------------------------------------
# Real artifact shape: ai-output.json -> populate_review_output -> scoring
# ---------------------------------------------------------------------------

class TestRealArtifactShape:
    """Regression: the run's findings arrive in the production shape
    (no 'description' keys) from ai-output.json via
    populate_review_output, and scoring consumes that shape."""

    def _payload(self, with_file: bool) -> dict:
        file = "pr_reviewer/forgejo_backend.py" if with_file else None
        return {
            "verdict": "request_changes",
            "verdict_source": "model",
            "review_markdown": "# Review\nrequest changes",
            "findings": [
                {
                    "severity": "blocker",
                    "category": "security",
                    "file": file,
                    "line": 42,
                    "message": "duplicate token exchange on concurrent "
                                "jwt cache hits",
                },
            ],
        }

    def _populated_run(self, tmp_path: Path, with_file: bool) -> ReviewRun:
        (tmp_path / "ai-output.json").write_text(
            json.dumps(self._payload(with_file)), encoding="utf-8",
        )
        (tmp_path / "analysis_engine.txt").write_text(
            "model-x@http://localhost:9/v1 (openai)\n", encoding="utf-8",
        )
        run = ReviewRun(
            mode="native_loop+deep",
            pr_number=547,
            repo_full_name="misospace/pr-reviewer-action",
            deep_review=True,
            specialists=_specialists({
                "security": [_lead(
                    "security",
                    "concurrent jwt cache hits can double the token exchange",
                    "pr_reviewer/forgejo_backend.py",
                    severity="major",
                )],
            }),
        )
        populate_review_output(run, tmp_path)
        return run

    def test_verified_passes_with_file_grounded_finding(self, tmp_path):
        run = self._populated_run(tmp_path, with_file=True)
        assert run.findings[0]["message"].startswith("duplicate token exchange")
        assert all("description" not in f for f in run.findings)
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_disposition", "role": "security",
                             "disposition": "verified",
                             "message_any_contains": "jwt",
                             "finding_file_any": ["forgejo_backend"]}],
        })
        assert result["lead_passed"] is True
        assert "verified" in result["checks"][0]["detail"]

    def test_same_finding_without_file_computes_rejected(self, tmp_path):
        run = self._populated_run(tmp_path, with_file=False)
        assert run.findings[0]["file"] is None
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_disposition", "role": "security",
                             "disposition": "verified",
                             "message_any_contains": "jwt",
                             "finding_file_any": ["forgejo_backend"]}],
        })
        assert result["lead_passed"] is False
        assert "rejected" in result["checks"][0]["detail"]


# ---------------------------------------------------------------------------
# Parroting is not verification
# ---------------------------------------------------------------------------

class TestParrotingNotVerified:
    """A final finding that merely repeats the lead's category/message
    without the lead's file computes as 'rejected', not 'verified'."""

    CHECK = {
        "type": "lead_disposition",
        "role": "security",
        "disposition": "verified",
        "message_any_contains": "injection",
        "finding_file_any": ["login"],
    }

    def test_fileless_parroted_finding_fails_verified(self):
        run = _run(
            specialists=_specialists({
                "security": [_lead("security", "SQL injection in login handler",
                                    "api/login.py")],
            }),
            findings=[_finding("security", "SQL injection in login handler")],
        )
        result = evaluate_specialist_expectations(run, {"lead_checks": [self.CHECK]})
        assert result["lead_passed"] is False
        assert "rejected" in result["checks"][0]["detail"]

    def test_same_finding_with_matching_file_passes_verified(self):
        run = _run(
            specialists=_specialists({
                "security": [_lead("security", "SQL injection in login handler",
                                    "api/login.py")],
            }),
            findings=[_finding("security", "SQL injection in login handler",
                                file="api/login.py")],
        )
        result = evaluate_specialist_expectations(run, {"lead_checks": [self.CHECK]})
        assert result["lead_passed"] is True
        assert "verified" in result["checks"][0]["detail"]


# ---------------------------------------------------------------------------
# load_specialist_telemetry
# ---------------------------------------------------------------------------

class TestLoadSpecialistTelemetry:
    def _write(self, tmp_path, name, payload):
        (tmp_path / name).write_text(json.dumps(payload), encoding="utf-8")

    def test_full_aggregate_and_role_files(self, tmp_path):
        self._write(tmp_path, "specialists.json", {
            "enabled": True,
            "aggregate_elapsed_sec": 12.5,
            "total_leads": 3,
            "any_errors": False,
            "roles": [
                {"role": "correctness", "status": "ok", "lead_count": 1,
                 "elapsed_sec": 3.0},
                {"role": "security", "status": "ok", "lead_count": 1,
                 "elapsed_sec": 4.0},
                {"role": "tests", "status": "ok", "lead_count": 1,
                 "elapsed_sec": 5.5},
            ],
        })
        self._write(tmp_path, "specialist-correctness.json", {
            "role": "correctness",
            "leads": [{"severity": "minor", "category": "correctness",
                       "file": "api/pagination.py", "line": 17,
                       "message": "off-by-one in page math"}],
            "truncated": False, "errors": [],
        })
        self._write(tmp_path, "specialist-security.json", {
            "role": "security",
            "leads": [{"severity": "major", "category": "security",
                       "file": "api/login.py", "line": 42,
                       "message": "SQL injection via username"}],
            "truncated": False, "errors": [],
        })
        self._write(tmp_path, "specialist-tests.json", {
            "role": "tests",
            "leads": [{"severity": "info", "category": "tests",
                       "file": None, "line": None,
                       "message": "no test for the new branch"}],
            "truncated": False, "errors": [],
        })

        tel = load_specialist_telemetry(tmp_path)
        assert tel is not None
        assert tel["derived"] is False
        assert tel["enabled"] is True
        assert tel["aggregate_elapsed_sec"] == 12.5
        assert tel["total_leads"] == 3
        assert tel["any_errors"] is False
        # One entry per fixed role, in role order, with aggregate counts kept.
        assert [r["role"] for r in tel["roles"]] == list(SPECIALIST_ROLES)
        assert {r["role"]: r["lead_count"] for r in tel["roles"]} == {
            "correctness": 1, "security": 1, "tests": 1,
        }
        assert tel["leads_by_role"]["security"][0]["message"] == "SQL injection via username"
        assert tel["leads_by_role"]["correctness"][0]["file"] == "api/pagination.py"

    def test_derived_when_aggregate_missing(self, tmp_path):
        self._write(tmp_path, "specialist-correctness.json", {
            "role": "correctness",
            "leads": [{"severity": "minor", "category": "correctness",
                       "file": None, "line": None, "message": "lead c1"}],
            "errors": [],
        })
        self._write(tmp_path, "specialist-security.json", {
            "role": "security",
            "leads": [
                {"severity": "major", "category": "security",
                 "file": None, "line": None, "message": "lead s1"},
                {"severity": "major", "category": "security",
                 "file": None, "line": None, "message": "lead s2"},
            ],
            "errors": [],
        })

        tel = load_specialist_telemetry(tmp_path)
        assert tel is not None
        assert tel["derived"] is True
        assert tel["aggregate_elapsed_sec"] is None
        assert tel["total_leads"] == 3
        assert tel["any_errors"] is False
        # The absent role file is accounted for with an ok, empty entry.
        assert {r["role"]: r["lead_count"] for r in tel["roles"]} == {
            "correctness": 1, "security": 2, "tests": 0,
        }

    def test_malformed_aggregate_falls_back_to_role_files(self, tmp_path):
        (tmp_path / "specialists.json").write_text(
            "{definitely not json", encoding="utf-8",
        )
        self._write(tmp_path, "specialist-security.json", {
            "role": "security",
            "leads": [{"severity": "major", "category": "security",
                       "file": None, "line": None, "message": "surviving lead"}],
            "errors": [],
        })

        tel = load_specialist_telemetry(tmp_path)
        assert tel is not None
        assert tel["derived"] is True
        assert [l["message"] for l in tel["leads_by_role"]["security"]] == ["surviving lead"]
        assert tel["leads_by_role"]["correctness"] == []
        assert tel["leads_by_role"]["tests"] == []

    def test_one_role_failed(self, tmp_path):
        self._write(tmp_path, "specialists.json", {
            "enabled": True,
            "aggregate_elapsed_sec": 61.0,
            "total_leads": 2,
            "roles": [
                {"role": "correctness", "status": "ok", "errors_count": 0,
                 "lead_count": 2, "elapsed_sec": 10.0},
                {"role": "security", "status": "timeout", "error_kind": "timeout",
                 "errors_count": 1, "lead_count": 5, "elapsed_sec": 60.0},
                {"role": "tests", "status": "ok", "errors_count": 0,
                 "lead_count": 0, "elapsed_sec": 8.0},
            ],
        })
        self._write(tmp_path, "specialist-correctness.json", {
            "role": "correctness",
            "leads": [
                {"severity": "minor", "category": "correctness",
                 "file": None, "line": None, "message": "lead c1"},
                {"severity": "minor", "category": "correctness",
                 "file": None, "line": None, "message": "lead c2"},
            ],
            "errors": [],
        })
        self._write(tmp_path, "specialist-security.json", {
            "role": "security", "leads": [], "errors": ["transport timeout"],
        })
        self._write(tmp_path, "specialist-tests.json", {
            "role": "tests", "leads": [], "errors": [],
        })

        tel = load_specialist_telemetry(tmp_path)
        assert tel is not None
        assert tel["derived"] is False
        assert tel["total_leads"] == 2
        # Derived from the timeout role's non-ok status.
        assert tel["any_errors"] is True
        by_role = {r["role"]: r for r in tel["roles"]}
        assert by_role["security"]["status"] == "timeout"
        assert by_role["security"]["error_kind"] == "timeout"
        # Aggregate lead_count is preserved even though the role file is empty.
        assert by_role["security"]["lead_count"] == 5
        # The other roles' leads survive.
        assert [l["message"] for l in tel["leads_by_role"]["correctness"]] == [
            "lead c1", "lead c2",
        ]
        assert tel["leads_by_role"]["security"] == []

    def test_no_artifacts_returns_none(self, tmp_path):
        assert load_specialist_telemetry(tmp_path) is None

    def test_junk_lead_entries_dropped_or_coerced(self, tmp_path):
        self._write(tmp_path, "specialist-security.json", {
            "role": "security",
            "leads": [
                "a bare string lead",
                42,
                None,
                {"category": "security"},  # missing message -> coerced to ""
                {"severity": "major", "category": "security",
                 "file": None, "line": None, "message": "real lead"},
            ],
            "errors": [],
        })
        tel = load_specialist_telemetry(tmp_path)
        assert tel is not None
        leads = tel["leads_by_role"]["security"]
        assert len(leads) == 2
        assert leads[0]["message"] == ""
        assert leads[1]["message"] == "real lead"


# ---------------------------------------------------------------------------
# run_label
# ---------------------------------------------------------------------------

class TestRunLabel:
    def test_standard_label_is_mode(self):
        assert run_label("native_loop", False) == "native_loop"
        assert run_label("tools_off", False) == "tools_off"

    def test_deep_label_suffixed(self):
        assert run_label("native_loop", True) == "native_loop+deep"
        assert run_label("tools_off", True) == "tools_off+deep"


# ---------------------------------------------------------------------------
# ReviewRun.to_dict
# ---------------------------------------------------------------------------

class TestReviewRunToDict:
    def test_includes_deep_review_and_specialists(self):
        specialists = _specialists({
            "security": [_lead("security", "injection")],
        })
        run = ReviewRun(
            mode="native_loop+deep", pr_number=610,
            repo_full_name="misospace/pr-reviewer-action",
            deep_review=True, specialists=specialists,
        )
        d = run.to_dict()
        assert d["deep_review"] is True
        assert d["specialists"] == specialists

    def test_defaults_for_standard_run(self):
        run = ReviewRun(
            mode="native_loop", pr_number=610,
            repo_full_name="misospace/pr-reviewer-action",
        )
        d = run.to_dict()
        assert d["deep_review"] is False
        assert d["specialists"] is None
        assert d["verdict_source"] is None

    def test_preexisting_keys_unchanged(self):
        run = ReviewRun(
            mode="tools_off", pr_number=7, repo_full_name="o/r",
            tokens_input=10, tokens_output=20, wall_clock_sec=5.6789,
            verdict="approve",
            findings=[{"severity": "high", "category": "security",
                       "file": None, "line": None, "description": "x"}],
            review_markdown="md",
            model_used="model-x",
            tool_calls=[{"tool": "read_file", "args": {"path": "a"},
                          "status": "ok"}],
            tool_stop_reason="model-stopped",
        )
        d = run.to_dict()
        assert d == {
            "mode": "tools_off",
            "pr_number": 7,
            "repo_full_name": "o/r",
            "tokens_input": 10,
            "tokens_output": 20,
            "wall_clock_sec": 5.679,
            "verdict": "approve",
            "verdict_source": None,
            "findings_count": 1,
            "findings": [{"severity": "high", "category": "security",
                           "file": None, "line": None, "description": "x"}],
            "tool_calls": [{"tool": "read_file", "args": {"path": "a"},
                            "status": "ok"}],
            "tool_stop_reason": "model-stopped",
            "error": None,
            "model_used": "model-x",
            "deep_review": False,
            "specialists": None,
        }


# ---------------------------------------------------------------------------
# generate_report integration
# ---------------------------------------------------------------------------

SPECIALIST_EXPECTATIONS = {
    "description": "deep run generated and adopted a security lead",
    "lead_checks": [
        {"id": "security_lead_generated", "type": "lead_generated",
         "role": "security"},
        {"id": "security_lead_adopted", "type": "lead_disposition",
         "role": "security", "disposition": "verified",
         "finding_file_any": ["login"]},
    ],
    "effectiveness_checks": [
        {"id": "expected_finding", "type": "final_findings_count", "min": 1,
         "finding_category_any": "security"},
    ],
}


def _deep_run():
    return ReviewRun(
        mode="native_loop+deep", pr_number=610,
        repo_full_name="misospace/pr-reviewer-action",
        deep_review=True,
        specialists=_specialists({
            "security": [_lead("security", "SQL injection in login handler")],
        }),
        findings=[_finding("security", "SQL injection in login handler",
                           file="api/login.py")],
        tokens_input=100, tokens_output=50, wall_clock_sec=3.0,
    )


def _standard_run():
    return ReviewRun(
        mode="native_loop", pr_number=610,
        repo_full_name="misospace/pr-reviewer-action",
    )


class TestGenerateReportSpecialists:
    def test_deep_and_standard_modes_tallied(self):
        corpus = BenchmarkCorpus(prs=[{
            "number": 610,
            "repo_full_name": "misospace/pr-reviewer-action",
            "url": "https://github.com/misospace/pr-reviewer-action/pull/610",
            "known_findings": [],
            "specialist_expectations": SPECIALIST_EXPECTATIONS,
        }])
        results = [BenchmarkResult(
            pr_number=610,
            repo_full_name="misospace/pr-reviewer-action",
            runs=[_standard_run(), _deep_run()],
        )]
        report = generate_report(results, corpus)

        summary = report["mode_summary"]
        assert {"native_loop", "native_loop+deep"} <= set(summary)
        deep = summary["native_loop+deep"]
        std = summary["native_loop"]
        # Effectiveness is the comparable A/B subset: graded on BOTH labels.
        assert deep["specialist_effectiveness_runs"] == 1
        assert deep["specialist_effectiveness_passes"] == 1
        assert deep["specialist_effectiveness_pass_rate"] == 1.0
        assert std["specialist_effectiveness_runs"] == 1
        assert std["specialist_effectiveness_passes"] == 0
        assert std["specialist_effectiveness_pass_rate"] == 0.0
        # Lead checks are deep-only diagnostics: deep label graded,
        # standard label untouched.
        assert deep["specialist_lead_runs"] == 1
        assert deep["specialist_lead_passes"] == 1
        assert deep["specialist_lead_pass_rate"] == 1.0
        assert std["specialist_lead_runs"] == 0
        assert std["specialist_lead_passes"] == 0
        assert std["specialist_lead_pass_rate"] is None

        per_pr = report["per_pr_results"][0]
        deep_detail = per_pr["native_loop+deep"]["specialist_capability"]
        std_detail = per_pr["native_loop"]["specialist_capability"]
        assert deep_detail["passed"] is True
        assert deep_detail["lead_passed"] is True
        assert deep_detail["effectiveness_passed"] is True
        assert std_detail["passed"] is False
        assert std_detail["lead_passed"] is None
        assert std_detail["effectiveness_passed"] is False
        assert all(c["scope"] in ("lead", "effectiveness")
                   for c in deep_detail["checks"])
        assert per_pr["specialist_effectiveness_pass_rate"] == {
            "native_loop": 0.0, "native_loop+deep": 1.0,
        }
        # The lead rate dict carries only the labels that graded lead checks.
        assert per_pr["specialist_lead_pass_rate"] == {"native_loop+deep": 1.0}

    def test_no_expectations_no_specialist_tallies(self):
        evidence = {
            "description": "cite the support matrix",
            "checks": [
                {"id": "cited", "type": "review_mentions",
                 "any_of": ["support matrix"]},
            ],
        }
        corpus = BenchmarkCorpus(prs=[{
            "number": 611,
            "repo_full_name": "misospace/pr-reviewer-action",
            "url": "https://github.com/misospace/pr-reviewer-action/pull/611",
            "known_findings": [],
            "expected_evidence": evidence,
        }])
        run = ReviewRun(
            mode="native_loop", pr_number=611,
            repo_full_name="misospace/pr-reviewer-action",
            review_markdown="Verified against the support matrix.",
        )
        results = [BenchmarkResult(
            pr_number=611, repo_full_name="misospace/pr-reviewer-action",
            runs=[run],
        )]
        report = generate_report(results, corpus)

        per_pr = report["per_pr_results"][0]
        assert "specialist_capability" not in per_pr["native_loop"]
        assert "specialist_effectiveness_pass_rate" not in per_pr
        assert "specialist_lead_pass_rate" not in per_pr
        std = report["mode_summary"]["native_loop"]
        assert std["specialist_effectiveness_runs"] == 0
        assert std["specialist_effectiveness_passes"] == 0
        assert std["specialist_effectiveness_pass_rate"] is None
        assert std["specialist_lead_runs"] == 0
        assert std["specialist_lead_passes"] == 0
        assert std["specialist_lead_pass_rate"] is None
        # Standard-mode capability scoring shape/values unchanged.
        assert std["capability_runs"] == 1
        assert std["capability_passes"] == 1
        assert std["capability_pass_rate"] == 1.0


# ---------------------------------------------------------------------------
# evaluate_capability regression
# ---------------------------------------------------------------------------

class TestEvaluateCapabilityRegression:
    """The new ReviewRun fields default off; capability grading is unaffected."""

    EVIDENCE = {
        "description": "chain to the support matrix and cite it",
        "checks": [
            {"id": "read_config", "type": "tool_call", "tool": "read_file",
             "args_contains": {"path": ["machineconfig"]}},
            {"id": "cited", "type": "review_mentions",
             "any_of": ["support matrix"]},
        ],
    }

    def test_chained_run_still_passes(self):
        run = ReviewRun(
            mode="native_loop", pr_number=1, repo_full_name="o/r",
            review_markdown="Per the support matrix, this is supported.",
            tool_calls=[{"tool": "read_file",
                         "args": {"path": "talos/machineconfig.yaml.j2"},
                         "status": "ok"}],
        )
        assert evaluate_capability(run, self.EVIDENCE)["passed"] is True

    def test_unchained_run_still_fails(self):
        run = ReviewRun(
            mode="native_loop", pr_number=1, repo_full_name="o/r",
            review_markdown="Looks fine, approve.", tool_calls=[],
        )
        assert evaluate_capability(run, self.EVIDENCE)["passed"] is False

    def test_no_evidence_still_returns_none(self):
        run = ReviewRun(mode="native_loop", pr_number=1, repo_full_name="o/r")
        assert evaluate_capability(run, None) is None
        assert evaluate_capability(run, {"checks": []}) is None


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

class TestDeepReviewCli:
    def test_default_is_false(self):
        args = build_parser().parse_args(["--corpus", "corpus.json"])
        assert args.deep_review == "false"

    def test_true_accepted(self):
        args = build_parser().parse_args(
            ["--corpus", "corpus.json", "--deep-review", "true"])
        assert args.deep_review == "true"

    def test_both_accepted(self):
        args = build_parser().parse_args(
            ["--corpus", "corpus.json", "--deep-review", "both"])
        assert args.deep_review == "both"

    def test_invalid_value_exits(self):
        parser = build_parser()
        with pytest.raises(SystemExit):
            parser.parse_args(
                ["--corpus", "corpus.json", "--deep-review", "sometimes"])


# ---------------------------------------------------------------------------
# lead_disposition: not_adopted (deep-review #610)
# ---------------------------------------------------------------------------

class TestLeadDispositionNotAdopted:
    """`not_adopted` passes iff NO final finding matches, whether or not a
    lead was generated: a hallucinated lead must not be adopted."""

    def test_not_adopted_passes_when_finding_matches_not_adopted(self):
        run = _run(
            specialists=_specialists({
                "security": [_lead("secret", "hardcoded secret in config")],
            }),
            findings=[_finding("style", "unused import", severity="info")],
        )
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_disposition", "role": "security",
                             "disposition": "not_adopted",
                             "category_any": "secret",
                             "message_any_contains": "hardcoded secret"}],
        })
        assert result["passed"] is True
        assert "not_adopted" in result["checks"][0]["detail"]

    def test_not_adopted_fails_when_finding_matches(self):
        run = _run(
            findings=[_finding("secret", "hardcoded secret in config file")],
        )
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_disposition", "role": "security",
                             "disposition": "not_adopted",
                             "category_any": "secret",
                             "message_any_contains": "hardcoded secret"}],
        })
        assert result["passed"] is False

    def test_not_adopted_passes_with_no_leads_and_no_findings(self):
        run = _run(specialists=_specialists({}), findings=[])
        result = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_disposition", "role": "security",
                             "disposition": "not_adopted",
                             "category_any": "secret",
                             "message_any_contains": "hardcoded secret"}],
        })
        assert result["passed"] is True

    def test_not_adopted_is_not_treated_as_rejected(self):
        """Without a lead, `rejected` (lead generated, not adopted) fails
        while `not_adopted` passes — the two dispositions are distinct."""
        run = _run(specialists=_specialists({}), findings=[])
        rejected = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_disposition", "role": "security",
                             "disposition": "rejected"}],
        })
        assert rejected["passed"] is False
        not_adopted = evaluate_specialist_expectations(run, {
            "lead_checks": [{"type": "lead_disposition", "role": "security",
                             "disposition": "not_adopted",
                             "category_any": "secret",
                             "message_any_contains": "hardcoded secret"}],
        })
        assert not_adopted["passed"] is True


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
