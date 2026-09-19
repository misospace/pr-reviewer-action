"""Tests for the historical-dogfood semantic scorer (#627).

These tests cover the acceptance criteria the issue calls out
explicitly:

- fixture schema validation
- semantic scorer accepts materially equivalent findings
- irrelevant / generic finding does not satisfy expected capability
- #623 sequencing fixture requires reap-before-final semantics
- #623 failure-contract fixture requires exceptional-path parity
- negative control penalizes fabricated findings
- attribution distinguishes specialist / primary / escalation discovery
- standard / deep and primary / escalation matrices serialize correctly
- deterministic CI path does not require external model access
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

# Make ``pr_reviewer`` importable; the scorer lives there as an
# importable module so the eval_harness can subclass / reuse it
# without round-tripping through the scripts/ shim.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from pr_reviewer.semantic_eval import (
    CAPABILITY_NEGATIVE_CONTROL,
    CAPABILITY_OUTPUT_COMPLETENESS,
    CAPABILITY_SEQUENCING,
    RECOGNISED_MODES,
    RECOGNISED_ROUTES,
    RECOGNISED_STAGES,
    SEMANTIC_CORPUS_VERSION,
    SIGNAL_KIND_FINDING,
    SIGNAL_KIND_MENTION,
    SIGNAL_KIND_TOOL,
    ReviewSignal,
    SemanticCorpus,
    SemanticCorpusError,
    SemanticScenario,
    aggregate_semantic_runs,
    classify_signal,
    evaluate_semantic_capability,
    validate_semantic_corpus,
    word_overlap,
)

CORPUS_PATH = REPO_ROOT / "evals" / "corpus-historical-dogfood.json"
CI_RUNNER = REPO_ROOT / "scripts" / "run_semantic_eval_ci.py"


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _scenario(number: int) -> SemanticScenario:
    corpus = SemanticCorpus.from_file(CORPUS_PATH)
    match = next((s for s in corpus.scenarios if s.number == number), None)
    assert match is not None, f"scenario #{number} missing from {CORPUS_PATH}"
    return match


def _tagged_signals(*pairs: tuple[str, str, str]) -> list[ReviewSignal]:
    """Build signals from ``(stage, kind, text)`` triples.

    For tool-kind signals the third element may be the tool name when the
    text contains a ``tool=`` prefix; otherwise the helper stamps a
    default ``tool="read_file"`` so the tool-anchor matcher sees a
    recognisable tool name. Tests that need a different tool should pass
    :class:`ReviewSignal` directly.
    """
    out: list[ReviewSignal] = []
    for stage, kind, text in pairs:
        if kind == SIGNAL_KIND_TOOL:
            # ``text`` may carry a tool name as a ``tool=name`` prefix
            # when callers want to vary the tool; otherwise default to
            # ``read_file`` so the anchor's ``tool`` matcher has
            # something to compare against.
            tool = "read_file"
            body = text
            if text.startswith("tool="):
                _, _, rest = text.partition(" ")
                tool = text.removeprefix("tool=").split(" ", 1)[0]
                body = rest
            out.append(
                ReviewSignal(stage=stage, kind=kind, text=body, meta={"tool": tool})
            )
        else:
            out.append(ReviewSignal(stage=stage, kind=kind, text=text))
    return out


# ─── Fixture schema validation ───────────────────────────────────────────────


class TestFixtureSchemaValidation:
    def test_corpus_file_exists(self) -> None:
        assert CORPUS_PATH.is_file(), (
            f"{CORPUS_PATH} must exist — the historical dogfood regression "
            f"corpus is the first-class fixture (#627)"
        )

    def test_corpus_version_is_pinned(self) -> None:
        corpus = SemanticCorpus.from_file(CORPUS_PATH)
        assert corpus.version == SEMANTIC_CORPUS_VERSION

    def test_corpus_validates_clean(self) -> None:
        corpus = SemanticCorpus.from_file(CORPUS_PATH)
        validate_semantic_corpus(corpus)  # raises SemanticCorpusError on failure

    def test_corpus_includes_required_dogfood_fixtures(self) -> None:
        corpus = SemanticCorpus.from_file(CORPUS_PATH)
        numbers = [s.number for s in corpus.scenarios]
        # #623 sequencing, #623 failure contract, and the negative control.
        assert 623 in numbers, "sequencing fixture for PR #623 / issue #608 must exist"
        assert any(
            s.klass == CAPABILITY_OUTPUT_COMPLETENESS for s in corpus.scenarios
        ), "failure-contract fixture for PR #623 / issue #608 must exist"
        assert any(s.negative_control for s in corpus.scenarios), (
            "negative control fixture must exist (recall regression guard)"
        )

    def test_each_scenario_carries_provenance(self) -> None:
        corpus = SemanticCorpus.from_file(CORPUS_PATH)
        for scenario in corpus.scenarios:
            assert scenario.provenance.get("pr_url"), (
                f"scenario #{scenario.number} must carry provenance.pr_url "
                f"for human audit"
            )
            assert scenario.provenance.get("issue"), (
                f"scenario #{scenario.number} must carry provenance.issue"
            )

    def test_review_modes_and_routes_are_closed_sets(self) -> None:
        corpus = SemanticCorpus.from_file(CORPUS_PATH)
        for scenario in corpus.scenarios:
            assert scenario.review_mode in RECOGNISED_MODES
            assert scenario.route in RECOGNISED_ROUTES
            assert scenario.stage_attribution in RECOGNISED_STAGES


class TestFixtureSchemaRejectsInvalid:
    """Schema validator must reject malformed fixtures with a clear error."""

    def _make_corpus(self, scenario: SemanticScenario) -> SemanticCorpus:
        return SemanticCorpus(
            scenarios=[scenario],
            metadata={},
            version=SEMANTIC_CORPUS_VERSION,
        )

    def _minimal(self, **overrides: object) -> SemanticScenario:
        # Build the scenario via the dict path (rather than kwargs) so
        # the override ``class`` key is honoured the same way the JSON
        # schema would set it.
        base: dict[str, object] = {
            "number": 9999,
            "repo_full_name": "misospace/pr-reviewer-action",
            "url": "https://github.com/misospace/pr-reviewer-action/pull/9999",
            "title": "test",
            "provenance": {
                "pr_url": "https://github.com/misospace/pr-reviewer-action/pull/9999"
            },
            "class": CAPABILITY_SEQUENCING,
            "review_mode": "deep",
            "route": "any",
            "stage_attribution": "any",
            "expected_capabilities": [CAPABILITY_SEQUENCING],
            "expected_evidence_anchors": [
                {"id": "m", "kind": SIGNAL_KIND_MENTION, "any_of": ["reap"]}
            ],
        }
        base.update(overrides)
        return SemanticScenario.from_dict(base)

    def test_missing_class_rejected(self) -> None:
        # An empty ``class`` field trips the truthy check in
        # ``SemanticScenario.from_dict`` and is rejected as an
        # unknown class by the schema validator. The validator is the
        # deterministic CI gate, so the error message has to be clear.
        bad = SemanticScenario(
            number=9999,
            repo_full_name="misospace/pr-reviewer-action",
            url="https://github.com/misospace/pr-reviewer-action/pull/9999",
            title="test",
            provenance={
                "pr_url": "https://github.com/misospace/pr-reviewer-action/pull/9999"
            },
            klass="",  # empty string is rejected as "unknown class ''"
            expected_capabilities=[CAPABILITY_SEQUENCING],
            expected_evidence_anchors=[
                {"id": "m", "kind": SIGNAL_KIND_MENTION, "any_of": ["reap"]}
            ],
        )
        with pytest.raises(SemanticCorpusError, match=r"unknown class"):
            validate_semantic_corpus(self._make_corpus(bad))

    def test_from_dict_rejects_missing_class_field(self) -> None:
        # Building from a dict without a ``class`` key must raise —
        # this is the upstream guarantee the schema validator relies on.
        with pytest.raises(ValueError, match="missing required 'class'"):
            SemanticScenario.from_dict(
                {
                    "number": 1,
                    "repo_full_name": "misospace/pr-reviewer-action",
                    "url": "https://github.com/misospace/pr-reviewer-action/pull/1",
                    "title": "test",
                    "provenance": {
                        "pr_url": "https://github.com/misospace/pr-reviewer-action/pull/1"
                    },
                    # no ``class`` field
                    "expected_capabilities": [CAPABILITY_SEQUENCING],
                    "expected_evidence_anchors": [
                        {"id": "m", "kind": SIGNAL_KIND_MENTION, "any_of": ["reap"]}
                    ],
                }
            )

    def test_unknown_capability_rejected(self) -> None:
        with pytest.raises(SemanticCorpusError, match="unknown class"):
            validate_semantic_corpus(
                self._make_corpus(
                    self._minimal(
                        **{"class": "mystery"},
                        expected_capabilities=["mystery"],
                    )
                )
            )

    def test_invalid_review_mode_rejected(self) -> None:
        with pytest.raises(SemanticCorpusError, match="review_mode"):
            validate_semantic_corpus(
                self._make_corpus(self._minimal(review_mode="auto"))
            )

    def test_invalid_route_rejected(self) -> None:
        with pytest.raises(SemanticCorpusError, match="route"):
            validate_semantic_corpus(
                self._make_corpus(self._minimal(route="primary_only"))
            )

    def test_invalid_stage_rejected(self) -> None:
        with pytest.raises(SemanticCorpusError, match="stage_attribution"):
            validate_semantic_corpus(
                self._make_corpus(self._minimal(stage_attribution="special"))
            )

    def test_missing_provenance_rejected(self) -> None:
        bad = SemanticScenario(
            number=9999,
            repo_full_name="misospace/pr-reviewer-action",
            url="https://github.com/misospace/pr-reviewer-action/pull/9999",
            title="test",
            provenance={},  # missing entirely
            klass=CAPABILITY_SEQUENCING,
            expected_capabilities=[CAPABILITY_SEQUENCING],
            expected_evidence_anchors=[
                {"id": "m", "kind": SIGNAL_KIND_MENTION, "any_of": ["reap"]}
            ],
        )
        with pytest.raises(SemanticCorpusError, match="provenance"):
            validate_semantic_corpus(self._make_corpus(bad))

    def test_missing_provenance_url_rejected(self) -> None:
        bad = SemanticScenario(
            number=9999,
            repo_full_name="misospace/pr-reviewer-action",
            url="https://github.com/misospace/pr-reviewer-action/pull/9999",
            title="test",
            provenance={"issue": 608},  # missing pr_url
            klass=CAPABILITY_SEQUENCING,
            expected_capabilities=[CAPABILITY_SEQUENCING],
            expected_evidence_anchors=[
                {"id": "m", "kind": SIGNAL_KIND_MENTION, "any_of": ["reap"]}
            ],
        )
        with pytest.raises(SemanticCorpusError, match="provenance.pr_url"):
            validate_semantic_corpus(self._make_corpus(bad))

    def test_mention_anchor_requires_any_of(self) -> None:
        with pytest.raises(SemanticCorpusError, match="'mention' anchors"):
            validate_semantic_corpus(
                self._make_corpus(
                    self._minimal(
                        expected_evidence_anchors=[
                            {"id": "m", "kind": SIGNAL_KIND_MENTION, "any_of": []}
                        ],
                    )
                )
            )

    def test_tool_anchor_requires_tool(self) -> None:
        with pytest.raises(SemanticCorpusError, match="'tool' anchors"):
            validate_semantic_corpus(
                self._make_corpus(
                    self._minimal(
                        expected_evidence_anchors=[
                            {"id": "t", "kind": SIGNAL_KIND_TOOL}
                        ],
                    )
                )
            )

    def test_negative_control_must_have_forbidden_capabilities(self) -> None:
        with pytest.raises(SemanticCorpusError, match="negative_control"):
            validate_semantic_corpus(
                self._make_corpus(
                    self._minimal(
                        **{"class": CAPABILITY_NEGATIVE_CONTROL},
                        expected_capabilities=[],
                        expected_evidence_anchors=[],
                        forbidden_capabilities=[],
                        negative_control=True,
                    )
                )
            )

    def test_negative_control_must_not_have_expected_capabilities(self) -> None:
        with pytest.raises(SemanticCorpusError, match="negative_control"):
            validate_semantic_corpus(
                self._make_corpus(
                    self._minimal(
                        **{"class": CAPABILITY_NEGATIVE_CONTROL},
                        expected_capabilities=[CAPABILITY_SEQUENCING],
                        expected_evidence_anchors=[],
                        forbidden_capabilities=[CAPABILITY_SEQUENCING],
                        negative_control=True,
                    )
                )
            )

    def test_duplicate_scenario_numbers_rejected(self) -> None:
        a = self._minimal(number=1)
        b = SemanticScenario(
            number=1,
            repo_full_name="misospace/pr-reviewer-action",
            url="https://example.com/1",
            title="dup",
            provenance={"pr_url": "https://example.com/1"},
            klass=CAPABILITY_SEQUENCING,
            expected_capabilities=[CAPABILITY_SEQUENCING],
            expected_evidence_anchors=[
                {"id": "m", "kind": SIGNAL_KIND_MENTION, "any_of": ["reap"]}
            ],
        )
        corpus = SemanticCorpus(
            scenarios=[a, b],
            metadata={},
            version=SEMANTIC_CORPUS_VERSION,
        )
        with pytest.raises(SemanticCorpusError, match="duplicate"):
            validate_semantic_corpus(corpus)


# ─── Semantic equivalence ────────────────────────────────────────────────────


class TestSemanticEquivalence:
    """The scorer must accept materially equivalent findings.

    "Materially equivalent" means: the finding carries the right
    capability class and a substring matching one of the evidence
    anchor's ``any_of`` needles. The text does NOT need to match the
    grader's wording exactly.
    """

    def test_word_overlap_threshold(self) -> None:
        # Sanity check the public overlap metric.
        assert word_overlap("reap before final review", "before final review") > 0.5
        assert word_overlap("apple", "orange") == 0.0

    def test_capability_classifier_assigns_known_classes(self) -> None:
        # Sequencing vocabulary.
        for text in (
            "reap before final review",
            "launch before final and wait",
            "wait for specialists before the final review",
            "race condition between launch and join",
        ):
            assert classify_signal(text) == CAPABILITY_SEQUENCING, text

        # Output-completeness vocabulary.
        for text in (
            "specialists.json is missing on failure",
            "absent on error: the per-role artifact",
            "fail-soft entry is never written",
            "completeness on failure is violated",
            "normalized artifact must exist on catastrophic failure",
        ):
            assert classify_signal(text) == CAPABILITY_OUTPUT_COMPLETENESS, text

    def test_irrelevant_text_classifies_as_none(self) -> None:
        # The "irrelevant / generic finding does not satisfy expected
        # capability" requirement: a generic approve sentence has no
        # vocabulary match and must score None (no false positive).
        assert classify_signal("LGTM, approve.") is None
        assert classify_signal("Updated the dependency version.") is None
        assert classify_signal("") is None

    def test_materially_equivalent_mention_satisfies_anchor(self) -> None:
        # "Materially equivalent" means: the wording paraphrases the
        # intent (specialists must be reaped / waited for before the
        # final review), not that it matches the grader's exact
        # vocabulary. We pick phrasing that walks the existing
        # vocabulary: "wait for specialists" + "before the final" in a
        # single sentence is sufficient.
        scenario = _scenario(623)
        signals = _tagged_signals(
            (
                "primary",
                SIGNAL_KIND_MENTION,
                (
                    "I waited for the specialists to terminate before the final "
                    "review enters; the specialist phase log confirms each role exited."
                ),
            ),
            ("primary", SIGNAL_KIND_TOOL, "specialists.phase.log"),
        )
        result = evaluate_semantic_capability(scenario, signals)
        assert result.passed is True, (
            "a mention that paraphrases 'wait for specialists before final "
            "review' must satisfy the reap-before-final anchor"
        )
        assert "control_flow_sequencing" in result.capability_hits

    def test_finding_kind_cross_matches_mention_anchor(self) -> None:
        """A finding is a structured form of a mention; either kind
        satisfies a textual evidence anchor (tool anchors still require
        the matching tool name).
        """
        scenario = _scenario(623)
        signals = _tagged_signals(
            (
                "primary",
                SIGNAL_KIND_FINDING,
                "Specialist phase ordering — must terminate before the final review.",
            ),
            ("primary", SIGNAL_KIND_TOOL, "specialists.phase.log"),
        )
        result = evaluate_semantic_capability(scenario, signals)
        assert result.passed is True

    def test_irrelevant_finding_does_not_satisfy_capability(self) -> None:
        """Generic findings must not credit an unrelated capability."""
        scenario = _scenario(623)
        signals = [
            ReviewSignal(
                stage="primary",
                kind=SIGNAL_KIND_MENTION,
                text="Patch bump, looks routine, approve.",
            )
        ]
        result = evaluate_semantic_capability(scenario, signals)
        assert result.passed is False
        assert "control_flow_sequencing" not in result.capability_hits


# ─── #623 sequencing fixture ─────────────────────────────────────────────────


class TestSequencingFixture:
    """The PR #623 / issue #608 sequencing fixture must require
    reap-before-final semantics. Launch-before-final alone (the dogfood
    miss) must NOT pass the fixture.
    """

    def test_reap_before_final_satisfies(self) -> None:
        scenario = _scenario(623)
        signals = _tagged_signals(
            (
                "primary",
                SIGNAL_KIND_MENTION,
                "Specialists must terminate and reaped before final review.",
            ),
            ("primary", SIGNAL_KIND_TOOL, "specialists.phase.log"),
        )
        result = evaluate_semantic_capability(scenario, signals)
        assert result.passed is True
        assert "control_flow_sequencing" in result.capability_hits
        assert all(a["satisfied"] for a in result.anchor_results)

    def test_launch_before_final_alone_does_not_satisfy(self) -> None:
        """The original dogfood miss: the reviewer wrote "launched
        specialists before final review" and the harness credited it
        without waiting. The fixture must require artifact evidence
        (the tool anchor), so the launch-only prose cannot pass on its
        own.
        """
        scenario = _scenario(623)
        signals = _tagged_signals(
            (
                "primary",
                SIGNAL_KIND_MENTION,
                "Specialist phase was launched before final review. Looks good.",
            ),
        )
        result = evaluate_semantic_capability(scenario, signals)
        # The mention DOES trip the vocabulary (control_flow_sequencing
        # is asserted), but the tool-anchor is not satisfied because no
        # specialists.phase.log / specialists.json tool call exists.
        # ``passed`` must therefore be False.
        assert "control_flow_sequencing" in result.capability_hits
        assert result.passed is False
        assert any(
            a["kind"] == SIGNAL_KIND_TOOL and not a["satisfied"]
            for a in result.anchor_results
        )

    def test_requires_specialist_artifact_evidence(self) -> None:
        """Without a specialists.phase.log / specialists.json tool call,
        the run is incomplete — sequencing is asserted in prose but not
        backed by artifact evidence.
        """
        scenario = _scenario(623)
        signals = _tagged_signals(
            (
                "primary",
                SIGNAL_KIND_MENTION,
                "Specialists must reap before final review.",
            ),
        )
        result = evaluate_semantic_capability(scenario, signals)
        # Capability hit, but the tool-anchor stays unsatisfied.
        assert "control_flow_sequencing" in result.capability_hits
        assert result.passed is False
        assert any(
            a["kind"] == SIGNAL_KIND_TOOL and not a["satisfied"]
            for a in result.anchor_results
        )


# ─── #623 failure-contract fixture ───────────────────────────────────────────


class TestFailureContractFixture:
    """The PR #623 / issue #608 failure-contract fixture must require
    output completeness on the failure path — not just on the happy
    path. A reviewer that only mentions the happy-path artifact state
    must not pass.
    """

    def test_failure_path_mention_satisfies(self) -> None:
        scenario = next(
            s
            for s in SemanticCorpus.from_file(CORPUS_PATH).scenarios
            if s.klass == CAPABILITY_OUTPUT_COMPLETENESS
        )
        signals = _tagged_signals(
            (
                "primary",
                SIGNAL_KIND_MENTION,
                (
                    "On catastrophic specialist failure, the normalized output "
                    "(specialists.json) must exist with a fail-soft degraded entry."
                ),
            ),
            ("primary", SIGNAL_KIND_TOOL, "specialists.json"),
        )
        result = evaluate_semantic_capability(scenario, signals)
        assert result.passed is True
        assert "output_completeness" in result.capability_hits

    def test_happy_path_only_does_not_satisfy(self) -> None:
        """The classic dogfood miss: the reviewer verified specialists.json
        on the happy path and stopped there. The failure-path anchor is
        not satisfied.
        """
        scenario = next(
            s
            for s in SemanticCorpus.from_file(CORPUS_PATH).scenarios
            if s.klass == CAPABILITY_OUTPUT_COMPLETENESS
        )
        signals = _tagged_signals(
            (
                "primary",
                SIGNAL_KIND_MENTION,
                "Specialists.json looks good on the happy path.",
            ),
            ("primary", SIGNAL_KIND_TOOL, "specialists.json"),
        )
        result = evaluate_semantic_capability(scenario, signals)
        assert result.passed is False
        assert any(
            a["kind"] == SIGNAL_KIND_MENTION and not a["satisfied"]
            for a in result.anchor_results
        )

    def test_artifact_missing_on_failure_satisfies(self) -> None:
        scenario = next(
            s
            for s in SemanticCorpus.from_file(CORPUS_PATH).scenarios
            if s.klass == CAPABILITY_OUTPUT_COMPLETENESS
        )
        signals = _tagged_signals(
            (
                "primary",
                SIGNAL_KIND_MENTION,
                (
                    "On catastrophic specialist failure, specialists.json is missing — "
                    "the normalized output was never written."
                ),
            ),
        )
        result = evaluate_semantic_capability(scenario, signals)
        assert result.passed is False  # tool anchor still unsatisfied
        assert "output_completeness" in result.capability_hits


# ─── Negative control ───────────────────────────────────────────────────────


class TestNegativeControlFixture:
    """The negative control penalises fabricated findings.

    A trivial dependency bump must NOT trigger sequencing or
    output-completeness findings. If a reviewer / harness starts
    fabricating such findings, the scenario fails.
    """

    def test_clean_approve_passes(self) -> None:
        scenario = _scenario(8004)
        signals = _tagged_signals(
            ("primary", SIGNAL_KIND_MENTION, "Trivial bump. Approve."),
        )
        result = evaluate_semantic_capability(scenario, signals)
        assert result.passed is True
        assert result.capability_hits == {}
        assert result.forbidden_violations == []

    def test_fabricated_sequencing_finding_fails(self) -> None:
        scenario = _scenario(8004)
        signals = _tagged_signals(
            (
                "primary",
                SIGNAL_KIND_FINDING,
                "Specialist phase must reap before final review.",
            ),
        )
        result = evaluate_semantic_capability(scenario, signals)
        assert result.passed is False
        assert result.forbidden_violations == [CAPABILITY_SEQUENCING]

    def test_fabricated_output_completeness_finding_fails(self) -> None:
        scenario = _scenario(8004)
        signals = _tagged_signals(
            (
                "primary",
                SIGNAL_KIND_MENTION,
                "On catastrophic failure, specialists.json must still be produced.",
            ),
        )
        result = evaluate_semantic_capability(scenario, signals)
        assert result.passed is False
        assert result.forbidden_violations == [CAPABILITY_OUTPUT_COMPLETENESS]

    def test_vocabulary_does_not_match_clean_phrasing(self) -> None:
        """A clean approve review must not incidentally trip the
        forbidden-class guard. The classifier must reject neutral prose.
        """
        for text in (
            "Approved.",
            "Clean change.",
            "No issues detected.",
            "Looks good.",
        ):
            assert classify_signal(text) is None, text


# ─── Stage attribution ───────────────────────────────────────────────────────


class TestStageAttribution:
    """Attribution must distinguish specialist / primary / escalation."""

    def test_specialist_signal_is_attributed(self) -> None:
        scenario = _scenario(6231)
        signals = _tagged_signals(
            (
                "specialist",
                SIGNAL_KIND_MENTION,
                (
                    "On catastrophic failure, specialists.json must be produced with a "
                    "fail-soft degraded entry."
                ),
            ),
            ("specialist", SIGNAL_KIND_TOOL, "specialists.json"),
        )
        result = evaluate_semantic_capability(scenario, signals)
        assert result.passed is True
        assert "specialist" in result.stages_hit
        assert "primary" not in result.stages_hit

    def test_primary_signal_is_attributed(self) -> None:
        scenario = _scenario(6231)
        signals = _tagged_signals(
            (
                "primary",
                SIGNAL_KIND_MENTION,
                "On catastrophic failure, the normalized output is missing.",
            ),
            ("primary", SIGNAL_KIND_TOOL, "specialists.json"),
        )
        result = evaluate_semantic_capability(scenario, signals)
        assert result.passed is True
        assert "primary" in result.stages_hit

    def test_escalation_signal_is_attributed(self) -> None:
        scenario = _scenario(6231)
        signals = _tagged_signals(
            (
                "escalation",
                SIGNAL_KIND_MENTION,
                "Escalation: specialists.json is absent on error.",
            ),
            ("escalation", SIGNAL_KIND_TOOL, "specialists.json"),
        )
        result = evaluate_semantic_capability(scenario, signals)
        assert result.passed is True
        assert "escalation" in result.stages_hit

    def test_stage_attribution_pinning_rejects_other_stages(self) -> None:
        """A fixture that pins ``stage_attribution: specialist`` must
        reject a primary-only signal.
        """
        corpus = SemanticCorpus.from_file(CORPUS_PATH)
        scenario = SemanticScenario(
            number=9100,
            repo_full_name="misospace/pr-reviewer-action",
            url="https://github.com/misospace/pr-reviewer-action/pull/9100",
            title="test",
            provenance={
                "pr_url": "https://github.com/misospace/pr-reviewer-action/pull/9100"
            },
            klass=CAPABILITY_SEQUENCING,
            review_mode="deep",
            route="any",
            stage_attribution="specialist",  # pin to specialist
            expected_capabilities=[CAPABILITY_SEQUENCING],
            expected_evidence_anchors=[
                {"id": "m", "kind": SIGNAL_KIND_MENTION, "any_of": ["reap"]},
                {
                    "id": "t",
                    "kind": SIGNAL_KIND_TOOL,
                    "tool": "read_file",
                    "any_of": ["specialists.phase.log"],
                },
            ],
        )

        primary_only = _tagged_signals(
            (
                "primary",
                SIGNAL_KIND_MENTION,
                "Specialist phase must reap before final review.",
            ),
            ("primary", SIGNAL_KIND_TOOL, "specialists.phase.log"),
        )
        result = evaluate_semantic_capability(scenario, primary_only)
        assert result.passed is False
        assert "primary" in result.stages_hit
        assert "specialist" not in result.stages_hit

        # A specialist signal flips the verdict.
        specialist_signals = _tagged_signals(
            (
                "specialist",
                SIGNAL_KIND_MENTION,
                "Specialist phase must reap before final review.",
            ),
            ("specialist", SIGNAL_KIND_TOOL, "specialists.phase.log"),
        )
        result2 = evaluate_semantic_capability(scenario, specialist_signals)
        assert result2.passed is True


# ─── Matrix serialization ────────────────────────────────────────────────────


class TestMatrixSerialization:
    """The fixture's review_mode / route fields must round-trip cleanly
    through JSON so the harness can evaluate the standard/deep and
    primary/escalation matrices without baking model names in.
    """

    def test_standard_vs_deep_round_trip(self) -> None:
        for mode in ("standard", "deep", "any"):
            scenario = SemanticScenario(
                number=9200 + hash(mode) % 1000,
                repo_full_name="misospace/pr-reviewer-action",
                url=f"https://github.com/misospace/pr-reviewer-action/pull/92{hash(mode) % 100}",
                title="round-trip",
                provenance={
                    "pr_url": "https://github.com/misospace/pr-reviewer-action/pull/9200"
                },
                klass=CAPABILITY_SEQUENCING,
                review_mode=mode,
                route="any",
                stage_attribution="any",
                expected_capabilities=[CAPABILITY_SEQUENCING],
                expected_evidence_anchors=[
                    {"id": "m", "kind": SIGNAL_KIND_MENTION, "any_of": ["reap"]}
                ],
            )
            payload = scenario.to_dict()
            again = SemanticScenario.from_dict(payload)
            assert again.review_mode == mode
            assert again.klass == CAPABILITY_SEQUENCING

    def test_primary_vs_escalation_round_trip(self) -> None:
        for route in ("primary", "escalation", "primary+escalation", "any"):
            scenario = SemanticScenario(
                number=9300 + hash(route) % 1000,
                repo_full_name="misospace/pr-reviewer-action",
                url=f"https://github.com/misospace/pr-reviewer-action/pull/93{hash(route) % 100}",
                title="round-trip",
                provenance={
                    "pr_url": "https://github.com/misospace/pr-reviewer-action/pull/9300"
                },
                klass=CAPABILITY_SEQUENCING,
                review_mode="deep",
                route=route,
                stage_attribution="any",
                expected_capabilities=[CAPABILITY_SEQUENCING],
                expected_evidence_anchors=[
                    {"id": "m", "kind": SIGNAL_KIND_MENTION, "any_of": ["reap"]}
                ],
            )
            payload = scenario.to_dict()
            again = SemanticScenario.from_dict(payload)
            assert again.route == route

    def test_corpus_round_trip_is_lossless(self) -> None:
        corpus = SemanticCorpus.from_file(CORPUS_PATH)
        # JSON round-trip must preserve every scenario verbatim.
        payload = json.dumps(corpus.to_dict())
        # Write to a temp file and reload via from_file, since the
        # corpus schema lives on disk.
        import tempfile

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as handle:
            handle.write(payload)
            handle.flush()
            temp_path = Path(handle.name)
        try:
            again = SemanticCorpus.from_file(temp_path)
        finally:
            temp_path.unlink()
        assert [s.number for s in again.scenarios] == [
            s.number for s in corpus.scenarios
        ]
        for original, restored in zip(corpus.scenarios, again.scenarios):
            assert original.to_dict() == restored.to_dict()

    def test_minimax_routing_pair_does_not_hardcode_model_names(self) -> None:
        """Acceptance criterion: the corpus can express the MiniMax M2.7 ->
        MiniMax M3 routing pair without baking those names into the
        schema. ``route: primary+escalation`` is the configuration slot
        — production behavior stays decoupled from model identity.
        """
        corpus = SemanticCorpus.from_file(CORPUS_PATH)
        # No fixture references a specific model name. Production code
        # is free to route any primary model + any escalation model;
        # the corpus only declares the routing shape.
        corpus_text = CORPUS_PATH.read_text(encoding="utf-8")
        # The corpus itself must not reference a specific model.
        for forbidden in ("MiniMax", "m2.7", "minimax-m2.7", "minimax-m3"):
            assert forbidden.lower() not in corpus_text.lower(), (
                f"corpus hardcodes a model name ({forbidden!r}); "
                f"the routing pair must be configurable in production"
            )
        # The metadata's free-form description, however, may reference
        # the routing pair by abstract name only — the schema enforces
        # the closed set ``{"primary", "escalation", "primary+escalation", "any"}``
        # via :data:`RECOGNISED_ROUTES`, which is the actual gate.
        for scenario in corpus.scenarios:
            assert scenario.route in RECOGNISED_ROUTES


# ─── Aggregation / variance ──────────────────────────────────────────────────


class TestAggregationAndVariance:
    """Repeated-run aggregation exposes variance and capability-level
    pass rates so the harness can compare models across runs.
    """

    def test_pass_rate_over_repeated_runs(self) -> None:
        scenario = _scenario(623)
        good = _tagged_signals(
            (
                "primary",
                SIGNAL_KIND_MENTION,
                "Specialists must reap before final review.",
            ),
            ("primary", SIGNAL_KIND_TOOL, "specialists.phase.log"),
        )
        bad = _tagged_signals(
            ("primary", SIGNAL_KIND_MENTION, "Looks good."),
        )
        results = [evaluate_semantic_capability(scenario, good) for _ in range(7)] + [
            evaluate_semantic_capability(scenario, bad) for _ in range(3)
        ]
        summary = aggregate_semantic_runs(scenario, results)
        assert summary["runs"] == 10
        assert summary["passes"] == 7
        assert summary["pass_rate"] == 0.7
        assert summary["capability_pass_rate"]["control_flow_sequencing"] == 0.7

    def test_forbidden_violation_rate(self) -> None:
        scenario = _scenario(8004)
        clean = _tagged_signals(
            ("primary", SIGNAL_KIND_MENTION, "Clean bump. Approve."),
        )
        fabricated = _tagged_signals(
            (
                "primary",
                SIGNAL_KIND_MENTION,
                "Specialist phase must reap before final review.",
            ),
        )
        results = [evaluate_semantic_capability(scenario, clean) for _ in range(8)] + [
            evaluate_semantic_capability(scenario, fabricated) for _ in range(2)
        ]
        summary = aggregate_semantic_runs(scenario, results)
        assert summary["forbidden_violation_rate"] == 0.2

    def test_stage_union_across_runs(self) -> None:
        scenario = _scenario(6231)
        specialist_run = _tagged_signals(
            (
                "specialist",
                SIGNAL_KIND_MENTION,
                "On catastrophic failure, specialists.json must be produced.",
            ),
            ("specialist", SIGNAL_KIND_TOOL, "specialists.json"),
        )
        primary_run = _tagged_signals(
            (
                "primary",
                SIGNAL_KIND_MENTION,
                "On catastrophic failure, the normalized output is missing.",
            ),
            ("primary", SIGNAL_KIND_TOOL, "specialists.json"),
        )
        results = [
            evaluate_semantic_capability(scenario, specialist_run),
            evaluate_semantic_capability(scenario, primary_run),
        ]
        summary = aggregate_semantic_runs(scenario, results)
        assert set(summary["stages_hit"]) == {"specialist", "primary"}


# ─── Deterministic CI path ───────────────────────────────────────────────────


class TestDeterministicCIPath:
    """The deterministic CI path must run without external model access."""

    def test_ci_runner_executes_offline(self, tmp_path: Path) -> None:
        report_path = tmp_path / "report.json"
        result = subprocess.run(
            [
                sys.executable,
                str(CI_RUNNER),
                "--corpus",
                str(CORPUS_PATH),
                "--report",
                str(report_path),
            ],
            capture_output=True,
            text=True,
            check=False,
            env={
                # Belt-and-braces: drop any AI_API_KEY / GITHUB_TOKEN
                # that might leak from the local environment so the
                # test cannot accidentally reach out.
                "PATH": "/usr/bin:/bin",
            },
        )
        assert result.returncode == 0, (
            f"CI runner exited {result.returncode}\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
        assert report_path.is_file()
        report = json.loads(report_path.read_text())
        assert report["passed"] is True
        assert report["corpus_version"] == SEMANTIC_CORPUS_VERSION
        assert report["scenarios_evaluated"] >= 3

    def test_ci_runner_fails_on_invalid_corpus(self, tmp_path: Path) -> None:
        bad = tmp_path / "bad.json"
        bad.write_text(json.dumps({"version": 1, "semantic_corpus": []}))
        result = subprocess.run(
            [
                sys.executable,
                str(CI_RUNNER),
                "--corpus",
                str(bad),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode != 0
        assert "corpus" in result.stderr.lower()

    def test_scoring_uses_no_network_or_subprocess(self, monkeypatch) -> None:
        """``evaluate_semantic_capability`` must be a pure function —
        the deterministic CI path depends on it having no side effects.
        """
        called = {"network": False, "shell": False}

        def _fake_urlopen(*args, **kwargs):
            called["network"] = True
            raise AssertionError("no network access")

        def _fake_run(*args, **kwargs):
            called["shell"] = True
            raise AssertionError("no subprocess")

        import subprocess as sp
        import urllib.request

        monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)
        monkeypatch.setattr(sp, "run", _fake_run)
        monkeypatch.setattr(sp, "Popen", _fake_run)

        scenario = _scenario(623)
        evaluate_semantic_capability(scenario, [])
        validate_semantic_corpus(SemanticCorpus.from_file(CORPUS_PATH))
        assert called["network"] is False
        assert called["shell"] is False


# ─── Coverage of the harness integration ─────────────────────────────────────


class TestReviewRunIntegration:
    """The harness ``ReviewRun`` (with the new ``stage`` field) feeds the
    scorer via :func:`_collect_signals_from_run`. The semantic scorer
    must read stage from ``run.stage`` and fall back to ``"primary"``
    when the run predates #627.
    """

    def test_review_run_stage_propagates_to_signals(self) -> None:
        # Build a minimal stand-in for ReviewRun without depending on
        # scripts.eval_harness (keeps the unit test self-contained).
        class FakeRun:
            stage = "specialist"
            review_markdown = "Specialist phase must reap before final review."
            tool_calls = [
                {
                    "tool": "read_file",
                    "args": {"path": "specialists.phase.log"},
                    "status": "ok",
                },
            ]
            findings = []

        from pr_reviewer.semantic_eval import _collect_signals_from_run

        signals = _collect_signals_from_run(FakeRun())
        stages = {signal.stage for signal in signals}
        assert "specialist" in stages

    def test_review_run_without_stage_defaults_to_primary(self) -> None:
        class FakeRun:
            review_markdown = "Specialists must reap before final review."
            tool_calls = []
            findings = []
            # No ``stage`` attribute — pre-#627 record.

        from pr_reviewer.semantic_eval import _collect_signals_from_run

        signals = _collect_signals_from_run(FakeRun())
        # Every signal must carry a recognised stage even when run.stage
        # is absent (the grader never infers from text).
        for signal in signals:
            assert signal.stage in RECOGNISED_STAGES


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
