from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest

from pr_reviewer import semantic_judge
from pr_reviewer.semantic_eval import (
    DISPOSITION_CORRECT,
    DISPOSITION_INVALID_REMEDIATION,
    DISPOSITION_NOT_FOUND,
    DISPOSITION_SPECULATIVE_FALSE_POSITIVE,
    DISPOSITION_SUPPRESSED_PRE_EXISTING,
    MERGE_SAFETY_DISPOSITIONS_ORDER,
)
from pr_reviewer.semantic_judge import (
    JUDGE_PROMPT_VERSION,
    JUDGE_SYSTEM_PROMPT,
    SemanticJudgeError,
    blind_response,
    build_judge_messages,
    judge_config_identity,
    judge_system_prompt_sha256,
    load_calibration_corpus,
    parse_judge_output,
    render_rubric,
    response_text_for_citation,
    validate_calibration_corpus,
    validate_citations,
    verify_judge_config,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
CORPUS_PATH = REPO_ROOT / "evals" / "judge-calibration-corpus.json"

# Freeze pin: JUDGE_SYSTEM_PROMPT is frozen at prompt version 661-j3; a change
# to the prompt text changes this digest and must be a deliberate act.
SYSTEM_PROMPT_SHA256 = "19b82cca1865939690924f9d9827b7dcee458b9af734f60a6c6177107c2673ed"

IDENTITY_KEYS = ("mode", "rep", "route", "stage", "commit_sha", "arm")

VULNERABLE_ANSWER_KEY = {
    "kind": "vulnerable",
    "class": "execution_boundary_authority",
    "mechanism": (
        "Relocating the CI poller into the review process lets the child inherit "
        + "reviewer-only credentials the isolated step never held."
    ),
    "detection_requires": [
        "the poller is relocated into the review process",
        "the child gains reviewer-only credentials",
    ],
    "secondary_components": ["the isolated step no longer owns the poller"],
    "remediation": {
        "required": ["move the poller back into an isolated CI step"],
        "forbidden": ["keep the poller inside the review process with a filtered environment"],
    },
}

CONTROL_ANSWER_KEY = {
    "kind": "negative_control",
    "class": "execution_boundary_authority",
    "mechanism": "The poller stays in its isolated step and the child never inherits reviewer credentials.",
    "detection_requires": [],
    "remediation": None,
}


def make_response() -> dict:
    return {
        "findings": [
            {
                "severity": "blocker",
                "category": "security",
                "file": "scripts/gating.sh",
                "line": 42,
                "message": "The CI child inherits reviewer secrets once the poller moves inside the review step.",
                "description": "Execution boundary widened: reviewer-only credentials reach the poller child.",
                "arm": "arm-b",
                "mode": "deep",
                "stage": "primary",
                "route": "fast",
                "commit_sha": "abc123def",
                "rep": "rep-1",
                "provenance": "identity metadata that must never reach the judge",
            }
        ],
        "review_markdown": "The CI child inherits reviewer secrets once the poller moves inside the review step.",
        "arm": "arm-b",
        "mode": "deep",
        "route": "fast",
        "stage": "primary",
        "commit_sha": "abc123def",
        "rep": "rep-1",
    }


def _payload(**overrides) -> str:
    base = {
        "disposition": "correct",
        "citations": ["the child gains reviewer-only credentials"],
        "rationale": "Every chain component is entailed.",
    }
    base.update(overrides)
    return json.dumps(base)


@pytest.fixture()
def base_corpus() -> dict:
    return copy.deepcopy(load_calibration_corpus(CORPUS_PATH))


class TestPromptStability:
    def test_prompt_version(self):
        assert JUDGE_PROMPT_VERSION == "661-j3"

    def test_system_prompt_frozen_pin(self):
        digest = hashlib.sha256(JUDGE_SYSTEM_PROMPT.encode("utf-8")).hexdigest()
        assert digest == SYSTEM_PROMPT_SHA256

    def test_system_prompt_names_dispositions_and_trust_rule(self):
        for token in ("not_found", "speculative_false_positive", "untrusted"):
            assert token in JUDGE_SYSTEM_PROMPT


class TestJudgeConfigIdentity:
    def test_identity_carries_exact_prompt_content_hash(self):
        identity = judge_config_identity("judge-model", CORPUS_PATH)
        assert identity["judge_system_prompt_sha256"] == (
            hashlib.sha256(JUDGE_SYSTEM_PROMPT.encode("utf-8")).hexdigest()
        )

    def test_verify_clean_for_fresh_identity(self):
        identity = judge_config_identity("judge-model", CORPUS_PATH)
        assert "judge_system_prompt_sha256" in identity
        assert verify_judge_config(dict(identity), identity) == []

    def test_verify_rejects_mutated_prompt_hash(self):
        identity = judge_config_identity("judge-model", CORPUS_PATH)
        stale = dict(identity)
        stale["judge_system_prompt_sha256"] = "0" * 64
        errors = verify_judge_config(stale, identity)
        assert any(
            "judge_system_prompt_sha256" in error and "mismatch" in error
            for error in errors
        )

    def test_verify_rejects_missing_prompt_hash(self):
        identity = judge_config_identity("judge-model", CORPUS_PATH)
        stale = dict(identity)
        del stale["judge_system_prompt_sha256"]
        errors = verify_judge_config(stale, identity)
        assert any(
            "judge_system_prompt_sha256" in error and "missing" in error
            for error in errors
        )

    def test_prompt_edit_changes_hash_and_rejects_stale_identity(self, monkeypatch):
        before_identity = judge_config_identity("judge-model", CORPUS_PATH)
        before_hash = judge_system_prompt_sha256()
        monkeypatch.setattr(
            semantic_judge, "JUDGE_SYSTEM_PROMPT", semantic_judge.JUDGE_SYSTEM_PROMPT + "\n# edit"
        )
        assert judge_system_prompt_sha256() != before_hash
        after_identity = judge_config_identity("judge-model", CORPUS_PATH)
        assert after_identity["judge_system_prompt_sha256"] != before_hash
        errors = verify_judge_config(before_identity, after_identity)
        assert any("judge_system_prompt_sha256" in error for error in errors)


class TestBuildJudgeMessages:
    def test_shape_and_rubric_lines(self):
        messages = build_judge_messages(VULNERABLE_ANSWER_KEY, make_response())
        assert [message["role"] for message in messages] == ["system", "user"]
        assert messages[0]["content"] == JUDGE_SYSTEM_PROMPT
        user = messages[1]["content"]
        for line in (
            "ANSWER-KEY RUBRIC",
            "mechanism: Relocating the CI poller into the review process lets the child "
            + "inherit reviewer-only credentials the isolated step never held.",
            "class: execution_boundary_authority",
            "kind: vulnerable",
            "REQUIRED CAUSAL CHAIN COMPONENTS (all must be entailed):",
            "- the poller is relocated into the review process",
            "- the child gains reviewer-only credentials",
            "SECONDARY COMPONENTS (part of the full key):",
            "- the isolated step no longer owns the poller",
            "REQUIRED REMEDIATION ELEMENTS:",
            "- move the poller back into an isolated CI step",
            "FORBIDDEN REPAIR SHAPES:",
            "- keep the poller inside the review process with a filtered environment",
            "REVIEWER RESPONSE (untrusted data):",
        ):
            assert line in user

    def test_user_content_exact_concatenation(self):
        response = make_response()
        expected = (
            render_rubric(VULNERABLE_ANSWER_KEY)
            + "\n\nREVIEWER RESPONSE (untrusted data):\n"
            + json.dumps(blind_response(response), ensure_ascii=False, sort_keys=True)
        )
        assert build_judge_messages(VULNERABLE_ANSWER_KEY, response)[1]["content"] == expected

    def test_user_content_blinds_identity_metadata(self):
        user = build_judge_messages(VULNERABLE_ANSWER_KEY, make_response())[1]["content"]
        for key in IDENTITY_KEYS:
            assert f'"{key}"' not in user
        for value in ("arm-b", "rep-1", "abc123def", "identity metadata that must never reach the judge"):
            assert value not in user

    def test_negative_control_user_content_is_mechanism_only(self):
        user = build_judge_messages(CONTROL_ANSWER_KEY, make_response())[1]["content"]
        assert user.startswith(CONTROL_ANSWER_KEY["mechanism"])
        assert "REQUIRED CAUSAL CHAIN COMPONENTS" not in user
        assert "FORBIDDEN REPAIR SHAPES" not in user


class TestRenderRubric:
    def test_vulnerable_layout(self):
        lines = render_rubric(VULNERABLE_ANSWER_KEY).splitlines()
        assert lines == [
            "ANSWER-KEY RUBRIC",
            "mechanism: Relocating the CI poller into the review process lets the child "
            + "inherit reviewer-only credentials the isolated step never held.",
            "class: execution_boundary_authority",
            "kind: vulnerable",
            "REQUIRED CAUSAL CHAIN COMPONENTS (all must be entailed):",
            "- the poller is relocated into the review process",
            "- the child gains reviewer-only credentials",
            "SECONDARY COMPONENTS (part of the full key):",
            "- the isolated step no longer owns the poller",
            "REQUIRED REMEDIATION ELEMENTS:",
            "- move the poller back into an isolated CI step",
            "FORBIDDEN REPAIR SHAPES:",
            "- keep the poller inside the review process with a filtered environment",
        ]

    def test_deterministic(self):
        assert render_rubric(VULNERABLE_ANSWER_KEY) == render_rubric(VULNERABLE_ANSWER_KEY)

    def test_omits_absent_optional_blocks(self):
        key = dict(VULNERABLE_ANSWER_KEY)
        del key["secondary_components"]
        key["remediation"] = None
        rendered = render_rubric(key)
        assert "SECONDARY COMPONENTS" not in rendered
        assert "REQUIRED REMEDIATION ELEMENTS:" not in rendered
        assert "FORBIDDEN REPAIR SHAPES:" not in rendered
        assert "REQUIRED CAUSAL CHAIN COMPONENTS (all must be entailed):" in rendered

    def test_negative_control_renders_mechanism_only(self):
        rendered = render_rubric(CONTROL_ANSWER_KEY)
        assert rendered == CONTROL_ANSWER_KEY["mechanism"]
        for fragment in ("ANSWER-KEY RUBRIC", "class:", "kind:", "REQUIRED CAUSAL CHAIN COMPONENTS"):
            assert fragment not in rendered


class TestBlindResponse:
    def test_allowlist_exact(self):
        blinded = blind_response(make_response())
        assert set(blinded) == {"findings", "review_markdown"}
        assert set(blinded["findings"][0]) == {
            "severity",
            "category",
            "file",
            "line",
            "message",
            "description",
        }
        assert blinded["findings"][0]["line"] == 42
        assert blinded["review_markdown"].startswith("The CI child inherits reviewer secrets")

    def test_missing_fields_omitted_and_defaulted(self):
        blinded = blind_response({"findings": [{"message": "only message", "severity": None, "arm": "arm-b"}]})
        assert blinded == {"findings": [{"message": "only message"}], "review_markdown": ""}

    def test_drops_unknown_top_level_and_non_dict_findings(self):
        blinded = blind_response(
            {
                "findings": ["not-a-dict", 7, {"message": "kept", "note": "dropped"}],
                "review_markdown": "body",
                "arm": "arm-b",
                "mode": "deep",
                "route": "fast",
                "stage": "primary",
                "commit_sha": "abc123def",
                "rep": "rep-1",
            }
        )
        assert blinded == {"findings": [{"message": "kept"}], "review_markdown": "body"}

    def test_empty_response(self):
        assert blind_response({}) == {"findings": [], "review_markdown": ""}


class TestParseJudgeOutput:
    def test_bare_json(self):
        parsed, errors = parse_judge_output(_payload())
        assert errors == []
        assert parsed == {
            "disposition": DISPOSITION_CORRECT,
            "citations": ["the child gains reviewer-only credentials"],
            "rationale": "Every chain component is entailed.",
        }

    def test_fenced_json_block(self):
        text = "My classification follows.\n```json\n" + _payload() + "\n```\n"
        parsed, errors = parse_judge_output(text)
        assert errors == []
        assert parsed is not None
        assert parsed["disposition"] == DISPOSITION_CORRECT

    def test_json_embedded_in_prose(self):
        text = "Judging now: " + _payload() + " — that is my call."
        parsed, errors = parse_judge_output(text)
        assert errors == []
        assert parsed["disposition"] == DISPOSITION_CORRECT

    def test_rejects_unknown_disposition(self):
        parsed, errors = parse_judge_output(_payload(disposition="blocker"))
        assert parsed is None
        assert any("disposition" in error for error in errors)

    def test_rejects_missing_citations(self):
        parsed, errors = parse_judge_output(json.dumps({"disposition": "correct", "rationale": "r"}))
        assert parsed is None
        assert any("citations" in error for error in errors)

    def test_rejects_missing_disposition(self):
        parsed, errors = parse_judge_output(json.dumps({"citations": ["x"], "rationale": "r"}))
        assert parsed is None
        assert any("disposition" in error for error in errors)

    def test_rejects_extra_key(self):
        parsed, errors = parse_judge_output(_payload(extra="nope"))
        assert parsed is None
        assert any("extra" in error for error in errors)

    def test_rejects_missing_rationale(self):
        parsed, errors = parse_judge_output(json.dumps({"disposition": "correct", "citations": ["x"]}))
        assert parsed is None
        assert any("rationale" in error for error in errors)

    def test_rejects_non_string_citation(self):
        parsed, errors = parse_judge_output(json.dumps({"disposition": "correct", "citations": [42], "rationale": "r"}))
        assert parsed is None
        assert any("citations" in error for error in errors)

    def test_rejects_empty_citation(self):
        parsed, errors = parse_judge_output(json.dumps({"disposition": "correct", "citations": [""], "rationale": "r"}))
        assert parsed is None
        assert any("citations" in error for error in errors)

    def test_rejects_non_list_citations(self):
        parsed, errors = parse_judge_output(json.dumps({"disposition": "correct", "citations": "x", "rationale": "r"}))
        assert parsed is None
        assert any("citations" in error for error in errors)

    def test_rejects_blank_rationale(self):
        payload = json.dumps({"disposition": "correct", "citations": ["x"], "rationale": "   "})
        parsed, errors = parse_judge_output(payload)
        assert parsed is None
        assert any("rationale" in error for error in errors)

    def test_rejects_non_string_disposition(self):
        parsed, errors = parse_judge_output(json.dumps({"disposition": 3, "citations": ["x"], "rationale": "r"}))
        assert parsed is None
        assert any("disposition" in error for error in errors)

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("correct", DISPOSITION_CORRECT),
            ("Not_Found", DISPOSITION_NOT_FOUND),
            ("SUPPRESSED_PRE_EXISTING", DISPOSITION_SUPPRESSED_PRE_EXISTING),
            ("Invalid_Remediation", DISPOSITION_INVALID_REMEDIATION),
            ("Speculative_False_Positive", DISPOSITION_SPECULATIVE_FALSE_POSITIVE),
        ],
    )
    def test_disposition_case_fold_normalization(self, raw, expected):
        parsed, errors = parse_judge_output(_payload(disposition=raw))
        assert errors == []
        assert parsed["disposition"] == expected

    def test_citations_are_stripped(self):
        parsed, errors = parse_judge_output(_payload(citations=["  padded span  "]))
        assert errors == []
        assert parsed["citations"] == ["padded span"]

    @pytest.mark.parametrize(
        "garbage",
        ["", "   ", "no json here", "[1, 2, 3]", '"just a string"', "{'disposition': 'correct'}"],
    )
    def test_never_raises_on_garbage(self, garbage):
        parsed, errors = parse_judge_output(garbage)
        assert parsed is None
        assert errors


class TestValidateCitations:
    def test_exact_match(self):
        text = "The child gains reviewer-only credentials once the poller moves in."
        assert validate_citations(["gains reviewer-only credentials"], text) == []

    def test_normalizes_curly_quotes_and_backticks(self):
        text = "The child don\u2019t inherit secrets. `pgrep` missing from the contract."
        assert validate_citations(["don't", "pgrep missing"], text) == []

    def test_case_insensitive(self):
        text = "The poller is relocated into the review process."
        assert validate_citations(["the POLLER is relocated"], text) == []

    def test_flags_fabricated_span(self):
        text = "The child inherits reviewer secrets."
        errors = validate_citations(["the child inherits model secrets"], text)
        assert len(errors) == 1
        assert "the child inherits model secrets" in errors[0]

    def test_flags_partial_word_span(self):
        text = "The pgrepping helper survives the kill."
        errors = validate_citations(["pgrep"], text)
        assert len(errors) == 1
        assert validate_citations(["pgrepping"], text) == []


class TestResponseTextForCitation:
    """The citation haystack must be a superset of every string the judge is
    shown, so a citation of any visible field validates — but no wider than
    what the judge saw, so a fabricated span still fails."""

    def test_description_only_field_is_citable(self):
        response = {"findings": [{"message": "AAA only", "description": "BBB description span"}]}
        haystack = response_text_for_citation(response)
        assert validate_citations(["BBB description span"], haystack) == []

    def test_file_category_severity_are_citable(self):
        response = {"findings": [{"message": "m", "file": "danger.py",
                                  "category": "bug", "severity": "blocker"}]}
        haystack = response_text_for_citation(response)
        assert validate_citations(["danger.py", "blocker", "bug"], haystack) == []

    def test_review_markdown_is_citable(self):
        response = {"findings": [], "review_markdown": "The resulting tree is unsafe."}
        haystack = response_text_for_citation(response)
        assert validate_citations(["resulting tree is unsafe"], haystack) == []

    def test_span_absent_from_everything_still_fails(self):
        response = {"findings": [{"message": "m", "file": "danger.py"}],
                    "review_markdown": "body"}
        haystack = response_text_for_citation(response)
        assert validate_citations(["never written anywhere"], haystack)

    def test_haystack_matches_blinded_visible_text(self):
        # Anything blind_response exposes as a string must be quoted successfully.
        response = {"findings": [{"message": "m1", "description": "d1", "file": "f.py",
                                  "category": "bug", "severity": "major", "line": 7,
                                  "mode": "treated", "arm": "treatment"}],
                    "review_markdown": "md"}
        blinded = blind_response(response)
        haystack = response_text_for_citation(response)
        for finding in blinded["findings"]:
            for value in finding.values():
                if isinstance(value, str) and value:
                    assert validate_citations([value], haystack) == [], value
        # Identity metadata must NOT be citable (it is stripped before judging).
        assert validate_citations(["treated"], haystack)
        assert validate_citations(["treatment"], haystack)


class TestValidateCalibrationCorpus:
    def test_real_corpus_validates_clean(self):
        corpus = load_calibration_corpus(CORPUS_PATH)
        assert validate_calibration_corpus(corpus) == []

    def test_real_corpus_dispositions_within_five(self):
        corpus = load_calibration_corpus(CORPUS_PATH)
        for scenario in corpus["scenarios"]:
            for reference in scenario["references"]:
                assert reference["expected_disposition"] in set(MERGE_SAFETY_DISPOSITIONS_ORDER)

    def test_mutate_duplicate_ref_id(self, base_corpus):
        base_corpus["scenarios"][1]["references"][0]["ref_id"] = base_corpus["scenarios"][0]["references"][0]["ref_id"]
        errors = validate_calibration_corpus(base_corpus)
        assert any("duplicate ref_id" in error for error in errors)

    def test_mutate_duplicate_scenario_number(self, base_corpus):
        # A duplicate scenario number must be rejected, not silently overwritten
        # by any number-keyed index built downstream.
        base_corpus["scenarios"][1]["number"] = base_corpus["scenarios"][0]["number"]
        errors = validate_calibration_corpus(base_corpus)
        assert any("duplicate scenario number" in error for error in errors)

    def test_duplicate_scenario_number_would_drop_a_scenario(self):
        # Guard the reason the check exists: a number-keyed index over duplicate
        # numbers loses a scenario, so validation must refuse the corpus first.
        corpus = {
            "version": 1,
            "scenarios": [
                {"number": 1, "answer_key": {"kind": "negative_control", "class": "c",
                                             "mechanism": "m", "detection_requires": [],
                                             "remediation": None},
                 "references": [{"ref_id": "a", "origin": "answer-key",
                                 "expected_disposition": "not_found",
                                 "response": {"findings": [{"message": "x"}],
                                              "review_markdown": "x"}}]},
                {"number": 1, "answer_key": {"kind": "negative_control", "class": "c",
                                             "mechanism": "m", "detection_requires": [],
                                             "remediation": None},
                 "references": [{"ref_id": "b", "origin": "answer-key",
                                 "expected_disposition": "not_found",
                                 "response": {"findings": [{"message": "y"}],
                                              "review_markdown": "y"}}]},
            ],
        }
        errors = validate_calibration_corpus(corpus)
        assert any("duplicate scenario number" in error for error in errors)
        keys = {s["number"]: s for s in corpus["scenarios"]}
        assert len(keys) == 1  # the collision the guardian prevents

    def test_mutate_bad_expected_disposition(self, base_corpus):
        base_corpus["scenarios"][0]["references"][0]["expected_disposition"] = "blocker"
        errors = validate_calibration_corpus(base_corpus)
        assert any("expected_disposition" in error for error in errors)

    def test_mutate_empty_references(self, base_corpus):
        base_corpus["scenarios"][0]["references"] = []
        errors = validate_calibration_corpus(base_corpus)
        assert any("references" in error for error in errors)

    def test_mutate_control_with_detection_requires(self, base_corpus):
        for scenario in base_corpus["scenarios"]:
            if scenario["answer_key"]["kind"] == "negative_control":
                scenario["answer_key"]["detection_requires"] = ["the control is not safe"]
                break
        errors = validate_calibration_corpus(base_corpus)
        assert any("negative control" in error and "detection_requires" in error for error in errors)

    def test_mutate_remediation_not_object(self, base_corpus):
        for scenario in base_corpus["scenarios"]:
            if scenario["answer_key"]["remediation"] is not None:
                scenario["answer_key"]["remediation"] = "a string, not an object"
                break
        errors = validate_calibration_corpus(base_corpus)
        assert any("remediation" in error for error in errors)

    def test_mutate_remediation_empty_forbidden_entry(self, base_corpus):
        for scenario in base_corpus["scenarios"]:
            remediation = scenario["answer_key"]["remediation"]
            if remediation is not None:
                remediation["forbidden"] = [""]
                break
        errors = validate_calibration_corpus(base_corpus)
        assert any("forbidden" in error for error in errors)

    def test_mutate_remediation_key_missing(self, base_corpus):
        del base_corpus["scenarios"][0]["answer_key"]["remediation"]
        errors = validate_calibration_corpus(base_corpus)
        assert any("'remediation'" in error for error in errors)

    def test_mutate_wrong_version(self, base_corpus):
        base_corpus["version"] = 2
        errors = validate_calibration_corpus(base_corpus)
        assert any("version" in error for error in errors)

    def test_mutate_scenarios_not_a_list(self, base_corpus):
        base_corpus["scenarios"] = "nope"
        errors = validate_calibration_corpus(base_corpus)
        assert any("scenarios" in error for error in errors)

    def test_non_dict_corpus_never_raises(self):
        assert validate_calibration_corpus([]) == ["corpus must be a JSON object"]


class TestLoadCalibrationCorpus:
    def test_real_file(self):
        corpus = load_calibration_corpus(CORPUS_PATH)
        assert corpus["version"] == 1
        assert len(corpus["scenarios"]) == 10

    def test_bad_json_raises_semantic_judge_error(self, tmp_path):
        bad = tmp_path / "corpus.json"
        bad.write_text("{not json", encoding="utf-8")
        with pytest.raises(SemanticJudgeError):
            load_calibration_corpus(bad)

    def test_missing_file_raises_semantic_judge_error(self, tmp_path):
        with pytest.raises(SemanticJudgeError):
            load_calibration_corpus(tmp_path / "missing.json")

    def test_semantic_judge_error_is_value_error(self):
        assert issubclass(SemanticJudgeError, ValueError)
