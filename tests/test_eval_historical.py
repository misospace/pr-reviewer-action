#!/usr/bin/env python3
"""Tests for the historical semantic regression corpus (issue #627).

Pins the harness-side contracts for #623's two dogfood classes
(cross-file/control-flow sequencing and exceptional-path output
completeness) and the clean-PR negative control, plus the
deterministic-CI guarantees:

* ``fixture schema validation`` — every scenario in
  ``evals/corpus-historical.json`` parses through
  ``load_historical_corpus``; a typo or unknown check kind fails closed.
* ``semantic scorer accepts materially equivalent findings`` —
  ``evaluate_scenario`` credits a stage timeline that records specialist
  completions before the primary start, and an artifact set that
  satisfies the per-role response contract; a launch-only timeline does
  not pass.
* ``irrelevant/generic finding does not satisfy expected capability`` —
  a sequencing scenario that records only a primary start and no
  specialist completion fails; a failure_contract scenario that omits
  the per-role response record fails.
* ``#623 sequencing fixture requires reap-before-final semantics`` —
  pinned by the corpus JSON and the dedicated tests below; the
  ``completion_required_not_launch`` ordering is the explicit regression
  pin.
* ``#623 failure-contract fixture requires exceptional-path parity`` —
  pinned by the ``failure_contract`` check; the exception path must
  still write the per-role response record and the aggregate.
* ``negative control penalizes fabricated findings`` — a negative
  control scenario fails when findings exceed ``max_findings`` or when
  the run credits a forbidden capability class.
* ``attribution distinguishes specialist/primary/escalation discovery``
  — every scenario result carries an ``attribution`` field that names
  the stage that caught the expected issue (or None for a negative
  control).
* ``standard/deep and primary/escalation matrices serialize correctly``
  — ``serialise_routing_matrix`` produces a deterministic, JSON-clean
  dict for any (primary, escalation, depths) tuple and rejects unknown
  depths.
* ``deterministic CI path does not require external model access`` —
  every scoring helper above runs against in-memory ``StageEvent`` /
  ``ReviewRun`` traces; the module imports nothing that performs
  network I/O.

These tests do not call any model and do not touch the network; the
deterministic CI path is therefore the only thing exercised here, and
the live-model benchmark path (the existing eval-harness workflow) is
exercised manually / on schedule.
"""

from __future__ import annotations

import json
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar

import pytest

# Resolve sibling modules without changing the test runner's sys.path
# beyond the project's scripts/ directory (where eval_historical.py lives).
_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = _REPO_ROOT / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from eval_historical import (
    ATTRIBUTION_STAGES,
    FAILURE_PATH_KINDS,
    HistoricalCorpusError,
    StageEvent,
    evaluate_scenario,
    load_historical_corpus,
    serialise_routing_matrix,
)

CORPUS_PATH = _REPO_ROOT / "evals" / "corpus-historical.json"


# ---------------------------------------------------------------------------
# Lightweight ReviewRun stand-in (we duck-type the fields the historical
# scorer reads; pulling the full ReviewRun from eval_harness is also fine,
# but a dataclass keeps each test's intent readable at a glance).
# ---------------------------------------------------------------------------


@dataclass
class _TraceRun:
    """A minimal stand-in for ReviewRun.

    Only carries the fields ``evaluate_scenario`` reads for the new check
    kinds (``findings``, ``review_markdown``, ``tool_calls``, ``error``,
    plus the optional ``capability_results`` used by the negative-control
    check). Mirrors :class:`eval_harness.ReviewRun` for the attributes
    that matter here.
    """

    mode: str = "native_loop"
    pr_number: int = 623
    repo_full_name: str = "misospace/pr-reviewer-action"
    findings: list[dict[str, Any]] = field(default_factory=list)
    review_markdown: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    capability_results: list[dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers for building traces that are easy to read in failure output.
# ---------------------------------------------------------------------------


def _ev(stage: str, event: str, seq: int, **payload: Any) -> StageEvent:
    """Build a StageEvent with an explicit monotonic sequence number."""
    return StageEvent(
        stage=stage, event=event, monotonic_seq=seq, payload=dict(payload)
    )


def _reaped_before_final(
    roles: list[str] | None = None,
    *,
    primary_seq: int = 100,
    per_role_step: int = 10,
) -> list[StageEvent]:
    """Build a stage timeline that satisfies the #623 sequencing class.

    The specialist launches and completions happen before the primary
    reviewer's start, with explicit sequence numbers so the scorer can
    order them deterministically without clock drift.
    """
    roles = roles or ["correctness", "security", "tests"]
    events: list[StageEvent] = []
    seq = 1
    for role in roles:
        stage = f"specialist_{role}"
        events.append(_ev(stage, "launched", seq, role=role))
        seq += per_role_step // 2
        events.append(_ev(stage, "completed", seq, role=role))
        seq += per_role_step // 2
    events.append(_ev("primary_final", "started", primary_seq))
    return events


def _launch_only(roles: list[str] | None = None) -> list[StageEvent]:
    """Build a stage timeline that records only specialist launches.

    This is the PR #623 pre-fix shape: the phase is launched and reaped
    later (e.g. at the step summary), so the primary final reviewer has
    already started before any specialist completion event exists. The
    historical scorer must reject this for ``all_specialists_before_primary``
    and for ``completion_required_not_launch``.
    """
    roles = roles or ["correctness", "security", "tests"]
    events: list[StageEvent] = []
    seq = 1
    for role in roles:
        events.append(_ev(f"specialist_{role}", "launched", seq, role=role))
        seq += 5
    events.append(_ev("primary_final", "started", seq))
    return events


# ---------------------------------------------------------------------------
# Corpus loading + schema validation
# ---------------------------------------------------------------------------


class TestLoadHistoricalCorpus:
    def test_corpus_file_loads(self) -> None:
        """The shipped corpus JSON parses and exposes the expected shape."""
        data = load_historical_corpus(CORPUS_PATH)
        assert len(data) == 1
        pr = data[0]
        assert pr["number"] == 623
        assert pr["repo_full_name"] == "misospace/pr-reviewer-action"
        assert len(pr["scenarios"]) == 3
        # Each scenario carries an id, a class, and expected_evidence.
        for s in pr["scenarios"]:
            assert s["scenario_id"]
            assert s["class"]
            assert s["expected_evidence"]["checks"]

    def test_corpus_rejects_missing_scenarios(self) -> None:
        """A corpus entry with no scenarios fails closed (schema violation)."""
        bad = {
            "benchmark_corpus": [
                {
                    "number": 1,
                    "repo_full_name": "test/repo",
                    "url": "https://github.com/test/repo/pull/1",
                    "title": "missing scenarios",
                    "known_findings": [],
                }
            ]
        }
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(bad, f)
            path = Path(f.name)
        try:
            with pytest.raises(
                HistoricalCorpusError, match="missing required 'scenarios'"
            ):
                load_historical_corpus(path)
        finally:
            path.unlink()

    def test_corpus_rejects_empty_scenarios(self) -> None:
        bad = {
            "benchmark_corpus": [
                {
                    "number": 1,
                    "repo_full_name": "test/repo",
                    "url": "https://github.com/test/repo/pull/1",
                    "title": "empty scenarios",
                    "scenarios": [],
                }
            ]
        }
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(bad, f)
            path = Path(f.name)
        try:
            with pytest.raises(HistoricalCorpusError, match="non-empty list"):
                load_historical_corpus(path)
        finally:
            path.unlink()

    def test_corpus_rejects_unknown_stage_in_sequencing(self) -> None:
        """A sequencing check that names an unknown stage fails closed.

        Without this guard, a fixture typo would silently let any string
        through and the attribution invariant would rot. Failing closed
        at load time is the only safe option for the deterministic CI
        path.
        """
        bad = {
            "benchmark_corpus": [
                {
                    "number": 1,
                    "repo_full_name": "test/repo",
                    "url": "https://github.com/test/repo/pull/1",
                    "title": "bad stage",
                    "scenarios": [
                        {
                            "scenario_id": "bad_stage",
                            "class": "cross-file/control-flow sequencing",
                            "description": "unknown stage",
                            "expected_evidence": {
                                "checks": [
                                    {
                                        "id": "bad",
                                        "type": "sequencing",
                                        "stages": ["ghost_stage", "primary_final"],
                                        "ordering": "all_specialists_before_primary",
                                    }
                                ]
                            },
                        }
                    ],
                }
            ]
        }
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(bad, f)
            path = Path(f.name)
        try:
            with pytest.raises(
                HistoricalCorpusError, match="unknown stage 'ghost_stage'"
            ):
                load_historical_corpus(path)
        finally:
            path.unlink()

    def test_corpus_rejects_unknown_failure_path(self) -> None:
        bad = {
            "benchmark_corpus": [
                {
                    "number": 1,
                    "repo_full_name": "test/repo",
                    "url": "https://github.com/test/repo/pull/1",
                    "title": "bad path",
                    "scenarios": [
                        {
                            "scenario_id": "bad_path",
                            "class": "exceptional-path output completeness",
                            "description": "unknown path",
                            "expected_evidence": {
                                "checks": [
                                    {
                                        "id": "bad",
                                        "type": "failure_contract",
                                        "path": "phlebotomy",
                                        "required_artifacts": ["response.json"],
                                    }
                                ]
                            },
                        }
                    ],
                }
            ]
        }
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(bad, f)
            path = Path(f.name)
        try:
            with pytest.raises(HistoricalCorpusError, match="'phlebotomy'"):
                load_historical_corpus(path)
        finally:
            path.unlink()


# ---------------------------------------------------------------------------
# Sequencing scenarios — PR #623 cross-file/control-flow class
# ---------------------------------------------------------------------------


class TestSequencingScenarios:
    """Pins the two orderings in the #623 sequencing fixture."""

    SEQUENCING: ClassVar[dict[str, Any]] = {
        "scenario_id": "623_sequencing_reap_before_final",
        "class": "cross-file/control-flow sequencing",
        "description": "reap-before-final",
        "negative_control": False,
        "expected_evidence": {
            "checks": [
                {
                    "id": "specialists_reaped_before_final",
                    "type": "sequencing",
                    "stages": [
                        "specialist_correctness",
                        "specialist_security",
                        "specialist_tests",
                        "primary_final",
                    ],
                    "ordering": "all_specialists_before_primary",
                },
                {
                    "id": "no_credit_for_launch_alone",
                    "type": "sequencing",
                    "stages": [
                        "specialist_correctness",
                        "specialist_security",
                        "specialist_tests",
                        "primary_final",
                    ],
                    "ordering": "completion_required_not_launch",
                },
            ],
        },
    }

    def test_reaped_timeline_passes(self) -> None:
        """All three specialists record completion before primary start.

        This is the post-fix shape: the deep-review phase is launched,
        each specialist records a completion event, and only then does
        the primary reviewer start. The historical scorer credits this
        trace on both orderings.
        """
        result = evaluate_scenario(
            self.SEQUENCING,
            _TraceRun(),
            stage_events=_reaped_before_final(),
        )
        assert result["passed"] is True
        assert all(c["passed"] for c in result["checks"])
        # Attribution: the primary stage is the one that "caught" the
        # sequencing issue (the reviewer is the dependent consumer).
        assert result["attribution"] == "primary_final"

    def test_launch_only_timeline_fails(self) -> None:
        """The PR #623 pre-fix state must fail the sequencing check.

        The pre-fix shape launched specialists in the background and
        reaped only at the step summary. Recorded as a launch-only
        timeline (no completion events), the primary reviewer started
        before any specialist completion and the check fails — which is
        exactly the regression this fixture pins.
        """
        result = evaluate_scenario(
            self.SEQUENCING,
            _TraceRun(),
            stage_events=_launch_only(),
        )
        assert result["passed"] is False
        # Both checks must fail: launch-only fails
        # ``completion_required_not_launch`` and
        # ``all_specialists_before_primary``.
        failed_ids = {c["id"] for c in result["checks"] if not c["passed"]}
        assert failed_ids == {
            "specialists_reaped_before_final",
            "no_credit_for_launch_alone",
        }
        # The detail must explain *why* — the scorer never silently fails.
        no_credit = next(
            c for c in result["checks"] if c["id"] == "no_credit_for_launch_alone"
        )
        assert "completions" in no_credit["detail"]["reason"]

    def test_partial_completion_fails_all_specialists_before_primary(self) -> None:
        """One slow specialist causes the whole ordering to fail.

        A run where two of three specialists complete before the primary
        but the third has not yet recorded a completion must fail
        ``all_specialists_before_primary``; partial credit on a control-flow
        invariant is the regression the fixture is designed to catch.
        """
        events = _reaped_before_final()
        # Remove the tests specialist completion; keep its launch.
        events = [
            ev
            for ev in events
            if not (ev.stage == "specialist_tests" and ev.event == "completed")
        ]
        result = evaluate_scenario(
            self.SEQUENCING,
            _TraceRun(),
            stage_events=events,
        )
        assert result["passed"] is False
        failed_ids = {c["id"] for c in result["checks"] if not c["passed"]}
        assert "specialists_reaped_before_final" in failed_ids

    def test_primary_started_before_any_specialist_fails(self) -> None:
        """If the primary starts first, the ordering is impossible.

        Even with all three specialists eventually completing, a primary
        that started before any specialist did violates the reap-before-
        final invariant. This is the most obvious failure mode and must
        be caught.
        """
        events = [
            _ev("primary_final", "started", 1),
            _ev("specialist_correctness", "completed", 2, role="correctness"),
            _ev("specialist_security", "completed", 3, role="security"),
            _ev("specialist_tests", "completed", 4, role="tests"),
        ]
        result = evaluate_scenario(self.SEQUENCING, _TraceRun(), stage_events=events)
        assert result["passed"] is False

    def test_primary_stage_required(self) -> None:
        """A scenario with no primary stage in scope cannot be graded.

        Schema validation accepts a sequencing scenario whose ``stages``
        list omits ``primary_final`` (the corpus contract doesn't
        require it), but the scorer needs the primary stage to compute
        ordering — without it the scoring is undefined. The scorer
        fails closed with an explicit reason rather than silently
        passing or returning a misleading result.
        """
        sequencing_no_primary = {
            "scenario_id": "no_primary",
            "class": "cross-file/control-flow sequencing",
            "description": "missing primary stage",
            "negative_control": False,
            "expected_evidence": {
                "checks": [
                    {
                        "id": "irrelevant",
                        "type": "sequencing",
                        "stages": [
                            "specialist_correctness",
                            "specialist_security",
                            "specialist_tests",
                        ],
                        "ordering": "completion_required_not_launch",
                    },
                ],
            },
        }
        result = evaluate_scenario(
            sequencing_no_primary,
            _TraceRun(),
            stage_events=_reaped_before_final(),
        )
        assert result["passed"] is False
        failed = result["checks"][0]
        assert not failed["passed"]
        assert "primary_final" in failed["detail"]["reason"]


# ---------------------------------------------------------------------------
# Failure-contract scenarios — PR #623 exceptional-path class
# ---------------------------------------------------------------------------


class TestFailureContractScenarios:
    """Pins the exceptional-path parity check on the #623 failure contract."""

    FAILURE_CONTRACT: ClassVar[dict[str, Any]] = {
        "scenario_id": "623_failure_contract_per_role_artifacts",
        "class": "exceptional-path output completeness",
        "description": "exception path must write per-role response",
        "negative_control": False,
        "expected_evidence": {
            "checks": [
                {
                    "id": "exception_path_writes_per_role_response",
                    "type": "failure_contract",
                    "path": "exception",
                    "required_artifacts": [
                        "specialist-{role}.response.json",
                        "specialists.json",
                    ],
                },
                {
                    "id": "happy_path_unchanged",
                    "type": "failure_contract",
                    "path": "success",
                    "required_artifacts": [
                        "specialist-{role}.json",
                        "specialist-{role}.response.json",
                        "specialists.json",
                    ],
                },
            ],
        },
    }

    def _completed_events(self) -> list[StageEvent]:
        """Stage events that list three roles' completion, so {role} can expand."""
        return [
            _ev("specialist_correctness", "completed", 1, role="correctness"),
            _ev("specialist_security", "completed", 2, role="security"),
            _ev("specialist_tests", "completed", 3, role="tests"),
        ]

    def test_exception_path_with_full_artifacts_passes(self) -> None:
        """Both paths write the full promised set; parity holds."""
        artifacts = {
            "exception": [
                "specialist-correctness.response.json",
                "specialist-security.response.json",
                "specialist-tests.response.json",
                "specialists.json",
            ],
            "success": [
                "specialist-correctness.json",
                "specialist-correctness.response.json",
                "specialist-security.json",
                "specialist-security.response.json",
                "specialist-tests.json",
                "specialist-tests.response.json",
                "specialists.json",
            ],
        }
        result = evaluate_scenario(
            self.FAILURE_CONTRACT,
            _TraceRun(),
            stage_events=self._completed_events(),
            artifacts_written=artifacts,
        )
        assert result["passed"] is True
        # Attribution: the failure-contract audit lives in the
        # correctness specialist (per #625), so that's the named stage.
        assert result["attribution"] == "specialist_correctness"

    def test_exception_path_missing_response_fails(self) -> None:
        """The #623 regression: exception path omits per-role response.

        The happy path writes everything correctly, but the exception
        fallback drops the per-role response record. The check fails —
        this is the regression the fixture pins.
        """
        artifacts = {
            "exception": [
                # Missing specialist-*.response.json — this is the bug.
                "specialists.json",
            ],
            "success": [
                "specialist-correctness.json",
                "specialist-correctness.response.json",
                "specialists.json",
            ],
        }
        result = evaluate_scenario(
            self.FAILURE_CONTRACT,
            _TraceRun(),
            stage_events=self._completed_events(),
            artifacts_written=artifacts,
        )
        assert result["passed"] is False
        failed_ids = {c["id"] for c in result["checks"] if not c["passed"]}
        assert "exception_path_writes_per_role_response" in failed_ids
        # Detail must name the missing artifact so a human can act on it.
        exc_check = next(
            c
            for c in result["checks"]
            if c["id"] == "exception_path_writes_per_role_response"
        )
        missing = exc_check["detail"]["missing"]
        assert any("response.json" in m for m in missing)

    def test_happy_path_regression_also_fails(self) -> None:
        """If the happy path drops its full artifact set, the check fails."""
        artifacts = {
            "exception": [
                "specialist-correctness.response.json",
                "specialists.json",
            ],
            "success": [
                # Missing specialist-*.json — happy-path regression.
                "specialist-correctness.response.json",
                "specialists.json",
            ],
        }
        result = evaluate_scenario(
            self.FAILURE_CONTRACT,
            _TraceRun(),
            stage_events=self._completed_events(),
            artifacts_written=artifacts,
        )
        assert result["passed"] is False
        failed_ids = {c["id"] for c in result["checks"] if not c["passed"]}
        assert "happy_path_unchanged" in failed_ids

    def test_no_completed_roles_fails_with_clear_reason(self) -> None:
        """With no specialist completions, {role} cannot expand.

        The {role} placeholder requires at least one role that recorded
        a completion event. The scorer must fail closed and name the
        reason, so a missing event timeline is diagnosable from the
        report alone.
        """
        artifacts = {
            "exception": ["specialists.json"],
            "success": ["specialist-correctness.json", "specialists.json"],
        }
        result = evaluate_scenario(
            self.FAILURE_CONTRACT,
            _TraceRun(),
            stage_events=[],
            artifacts_written=artifacts,
        )
        assert result["passed"] is False
        exc_check = next(
            c
            for c in result["checks"]
            if c["id"] == "exception_path_writes_per_role_response"
        )
        assert "no specialist completion events" in exc_check["detail"]["reason"]

    def test_unsafe_artifact_name_fails_closed(self) -> None:
        """A path-traversal artifact name fails the contract check.

        Defence in depth: the historical scorer runs against in-memory
        dicts, but a fixture (or test) that smuggles in ``../etc/passwd``
        or similar must not pass silently. The safe-name contract
        rejects shell metacharacters, leading ``/`` and ``..``
        components, and any character outside ``[A-Za-z0-9._/-{}]``.
        """
        artifacts = {
            "exception": [
                "../etc/passwd",  # path traversal
                "specialists.json",
            ],
            "success": ["specialist-correctness.json", "specialists.json"],
        }
        result = evaluate_scenario(
            self.FAILURE_CONTRACT,
            _TraceRun(),
            stage_events=self._completed_events(),
            artifacts_written=artifacts,
        )
        assert result["passed"] is False
        exc_check = next(
            c
            for c in result["checks"]
            if c["id"] == "exception_path_writes_per_role_response"
        )
        assert exc_check["detail"]["unsafe_artifact_names"] == ["../etc/passwd"]


# ---------------------------------------------------------------------------
# Negative-control scenarios
# ---------------------------------------------------------------------------


class TestNegativeControlScenarios:
    """The clean-PR guard against fabricated findings and tool-call spam."""

    NEGATIVE_CONTROL: ClassVar[dict[str, Any]] = {
        "scenario_id": "623_negative_control_no_fabrication",
        "class": "negative control (clean PR with intentional noise)",
        "description": "no fabricated findings allowed",
        "negative_control": True,
        "expected_evidence": {
            "checks": [
                {
                    "id": "no_fabricated_capability_credits",
                    "type": "negative_control",
                    "forbidden_categories": ["sequencing", "failure_contract"],
                    "max_findings": 0,
                },
                {
                    "id": "no_excessive_tool_use",
                    "type": "max_tool_calls",
                    "max": 5,
                },
            ],
        },
    }

    def test_clean_run_passes(self) -> None:
        """A clean run with no findings and few tool calls passes."""
        run = _TraceRun(
            findings=[], tool_calls=[{"tool": "read_file", "args": {}, "status": "ok"}]
        )
        result = evaluate_scenario(self.NEGATIVE_CONTROL, run)
        assert result["passed"] is True
        assert result["attribution"] is None

    def test_fabricated_finding_fails(self) -> None:
        """A finding on a clean PR is a fabricated credit — fails."""
        run = _TraceRun(
            findings=[
                {
                    "category": "correctness",
                    "severity": "minor",
                    "description": "fabricated issue",
                }
            ],
            tool_calls=[],
        )
        result = evaluate_scenario(self.NEGATIVE_CONTROL, run)
        assert result["passed"] is False
        nc_check = next(
            c for c in result["checks"] if c["id"] == "no_fabricated_capability_credits"
        )
        assert "max_findings=0" in nc_check["detail"]["reason"]

    def test_forbidden_capability_credit_fails(self) -> None:
        """Crediting a forbidden class on a clean PR fails."""
        run = _TraceRun(
            findings=[],
            tool_calls=[],
            capability_results=[{"scenario_class": "sequencing", "passed": True}],
        )
        result = evaluate_scenario(self.NEGATIVE_CONTROL, run)
        assert result["passed"] is False
        nc_check = next(
            c for c in result["checks"] if c["id"] == "no_fabricated_capability_credits"
        )
        assert "fabricated capability credit" in nc_check["detail"]["reason"]

    def test_excessive_tool_use_fails(self) -> None:
        """More than ``max`` tool calls fails the conservative budget."""
        run = _TraceRun(
            findings=[],
            tool_calls=[{"tool": "read_file", "args": {}, "status": "ok"}] * 6,
        )
        result = evaluate_scenario(self.NEGATIVE_CONTROL, run)
        assert result["passed"] is False
        failed_ids = {c["id"] for c in result["checks"] if not c["passed"]}
        assert "no_excessive_tool_use" in failed_ids

    def test_attribution_is_none_for_negative_control(self) -> None:
        """The negative control never attributes discovery — there's nothing to discover."""
        run = _TraceRun()
        result = evaluate_scenario(self.NEGATIVE_CONTROL, run)
        assert result["attribution"] is None


# ---------------------------------------------------------------------------
# Routing-matrix serialisation (M2.7 → M3-style pair)
# ---------------------------------------------------------------------------


class TestRoutingMatrixSerialisation:
    """The corpus never hard-codes model names; the matrix is configured at run time."""

    def test_default_pair_serialises_with_two_depths(self) -> None:
        matrix = serialise_routing_matrix(
            primary_model="primary-M2.7",
            escalation_model="escalation-M3",
        )
        # The matrix is JSON-clean (round-trips through json.dumps).
        text = json.dumps(matrix)
        reloaded = json.loads(text)
        assert reloaded == matrix

        # Two depths, two routing pairs, each with a stages_in_order list.
        assert matrix["review_depths"] == ["standard", "deep"]
        assert len(matrix["routing_pairs"]) == 2
        for pair in matrix["routing_pairs"]:
            assert pair["primary"] == "primary-M2.7"
            assert pair["escalation"] == "escalation-M3"

    def test_standard_depth_only_emits_primary_stage(self) -> None:
        matrix = serialise_routing_matrix(
            primary_model="primary",
            escalation_model=None,
            review_depths=["standard"],
        )
        assert matrix["routing_pairs"][0]["stages_in_order"] == ["primary_final"]

    def test_deep_depth_emits_specialists_then_primary_then_escalation(self) -> None:
        matrix = serialise_routing_matrix(
            primary_model="primary",
            escalation_model="escalation",
            review_depths=["deep"],
        )
        stages = matrix["routing_pairs"][0]["stages_in_order"]
        assert stages == [
            "specialist_correctness",
            "specialist_security",
            "specialist_tests",
            "primary_final",
            "escalation",
        ]

    def test_no_escalation_skips_escalation_stage(self) -> None:
        matrix = serialise_routing_matrix(
            primary_model="primary",
            escalation_model=None,
            review_depths=["deep"],
        )
        stages = matrix["routing_pairs"][0]["stages_in_order"]
        assert "escalation" not in stages
        # Specialist stages still come before primary_final.
        assert stages.index("primary_final") == stages.index("specialist_tests") + 1

    def test_unknown_depth_raises(self) -> None:
        with pytest.raises(ValueError, match="unknown review depth"):
            serialise_routing_matrix(
                primary_model="primary",
                escalation_model=None,
                review_depths=["standard", "diagonal"],
            )

    def test_pair_with_non_default_names_serialises_cleanly(self) -> None:
        """The matrix carries any operator-chosen names; the corpus never names them."""
        matrix = serialise_routing_matrix(
            primary_model="Qwen3.8-27B",
            escalation_model="Qwen3.8-72B",
        )
        text = json.dumps(matrix)
        reloaded = json.loads(text)
        assert reloaded["primary_model"] == "Qwen3.8-27B"
        assert reloaded["escalation_model"] == "Qwen3.8-72B"


# ---------------------------------------------------------------------------
# Deterministic CI path — no network, no subprocess, no model
# ---------------------------------------------------------------------------


class TestDeterministicCIPath:
    """Pins the deterministic CI guarantees for the historical scorer."""

    def test_evaluation_does_not_import_network_modules(self) -> None:
        """The historical module itself must not pull network modules.

        This is a defence-in-depth check: a transitive import of
        ``requests`` / ``urllib.request`` / etc. by ``eval_historical``
        would make the CI path non-deterministic. We inspect the module's
        own imports rather than the global ``sys.modules`` (which can
        carry unrelated transitive imports pulled in by sibling tests).
        """
        import ast
        import importlib

        import eval_historical

        source = (Path(eval_historical.__file__)).read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imported.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])

        forbidden = {"requests", "httpx", "aiohttp", "urllib3"}
        offenders = imported & forbidden
        assert not offenders, (
            f"deterministic CI path picked up a network dependency "
            f"({sorted(offenders)}); eval_historical must stay offline"
        )

        # The module itself exposes no network-call helper.
        importlib.reload(eval_historical)
        assert not hasattr(eval_historical, "call_model")

    def test_scenario_evaluation_is_pure_function_of_inputs(self) -> None:
        """Same inputs ⇒ same output, no global state mutation."""
        scenario = {
            "scenario_id": "623_sequencing_reap_before_final",
            "class": "cross-file/control-flow sequencing",
            "description": "pure-function check",
            "negative_control": False,
            "expected_evidence": {
                "checks": [
                    {
                        "id": "ok",
                        "type": "sequencing",
                        "stages": [
                            "specialist_correctness",
                            "specialist_security",
                            "specialist_tests",
                            "primary_final",
                        ],
                        "ordering": "all_specialists_before_primary",
                    }
                ]
            },
        }
        events = _reaped_before_final()
        run = _TraceRun()
        first = evaluate_scenario(scenario, run, stage_events=list(events))
        second = evaluate_scenario(scenario, run, stage_events=list(events))
        assert first == second

    def test_stage_event_construction_rejects_unknown_stage(self) -> None:
        """The StageEvent dataclass fails closed on unknown stage names."""
        with pytest.raises(ValueError, match="StageEvent.stage must be one of"):
            StageEvent(stage="ghost", event="completed", monotonic_seq=1)

    def test_attribution_set_is_closed(self) -> None:
        """The attribution set is documented as closed; we pin it here.

        Adding a new stage must be a deliberate change to the corpus
        contract — the scorer never silently accepts an unknown stage.
        """
        assert ATTRIBUTION_STAGES == frozenset(
            {
                "specialist_correctness",
                "specialist_security",
                "specialist_tests",
                "primary_final",
                "escalation",
            }
        )

    def test_failure_path_kind_set_is_closed(self) -> None:
        """The failure-path kind set is also closed and pinned here."""
        assert FAILURE_PATH_KINDS == frozenset(
            {
                "success",
                "validation",
                "timeout",
                "retry_exhaustion",
                "exception",
                "disabled",
                "write_failure",
            }
        )


# ---------------------------------------------------------------------------
# StageEvent round-tripping — used by report writers that consume the result
# ---------------------------------------------------------------------------


class TestStageEventRoundTrip:
    def test_to_dict_then_from_dict_is_identity(self) -> None:
        ev = StageEvent(
            stage="specialist_correctness",
            event="completed",
            monotonic_seq=42,
            payload={"role": "correctness"},
        )
        round_tripped = StageEvent.from_dict(ev.to_dict())
        assert round_tripped == ev

    def test_from_dict_rejects_non_dict(self) -> None:
        with pytest.raises(TypeError, match="must be a dict"):
            StageEvent.from_dict("not a dict")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Real-corpus integration: load the shipped fixture and exercise every scenario
# ---------------------------------------------------------------------------


class TestShippedCorpusFixtures:
    """End-to-end on the shipped evals/corpus-historical.json file."""

    def test_every_scenario_in_shipped_corpus_evaluates(self) -> None:
        data = load_historical_corpus(CORPUS_PATH)
        for pr in data:
            for scenario in pr["scenarios"]:
                # Each scenario evaluates against a generic clean run.
                # Positive scenarios need crafted traces (covered by the
                # dedicated tests above); this end-to-end check just
                # confirms the shipped scenarios parse and produce a
                # structured result without raising.
                result = evaluate_scenario(scenario, _TraceRun())
                assert "passed" in result
                assert "attribution" in result
                assert "checks" in result
                for c in result["checks"]:
                    assert "id" in c
                    assert "type" in c
                    assert "passed" in c
                    assert "detail" in c
