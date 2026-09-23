"""Tests for scripts/live_judge_score.py (#661 blinded A/B judge scoring).

No network: an injected fake judge scores blinded run payloads shaped exactly
like the driver's ``liveblinded-<arm>.json``. Corpus answer keys come from the
real frozen calibration corpus.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import pytest  # noqa: E402

from pr_reviewer import semantic_judge  # noqa: E402
from scripts import live_judge_score as ljs  # noqa: E402

CORPUS_PATH = _REPO_ROOT / "evals" / "judge-calibration-corpus.json"
VULN = {6541, 6543, 6545, 6547, 6549}
CTRL = {6542, 6544, 6546, 6548, 6550}
_NO_SLEEP = lambda _seconds: None  # keep transport-retry backoff instant in tests


@pytest.fixture(scope="module")
def answer_keys() -> dict[int, dict]:
    corpus = semantic_judge.load_calibration_corpus(CORPUS_PATH)
    assert semantic_judge.validate_calibration_corpus(corpus) == []
    return {s["number"]: s["answer_key"] for s in corpus["scenarios"]}


def _scenario_entry(number: int, responses: list[dict]) -> dict:
    return {
        "scenario": number,
        "runs": [{"rep": i, "response": r} for i, r in enumerate(responses, 1)],
    }


def _finding_response(message: str) -> dict:
    return {"findings": [{"message": message}], "review_markdown": message}


def _arm(arm_name: str, entries: list[dict]) -> dict:
    return {"arm": arm_name, "reps": max(
        (len(e["runs"]) for e in entries), default=0), "scenarios": entries}


def _always(disposition: str):
    def _call(messages: list[dict], attempt: int = 0) -> str:
        citations = [] if disposition == "not_found" else [_cite_first(messages)]
        return json.dumps(
            {"disposition": disposition, "citations": citations, "rationale": "r"}
        )
    return _call


def _cite_first(messages: list[dict]) -> str:
    user = next(m["content"] for m in messages if m["role"] == "user")
    payload = json.loads(user.split("REVIEWER RESPONSE (untrusted data):\n", 1)[1])
    findings = payload.get("findings") or []
    span = (findings[0]["message"] if findings else payload.get("review_markdown", ""))
    return span.strip()


def _per_arm_judge(vuln_disp: str, ctrl_disp: str):
    def _call(messages: list[dict], attempt: int = 0) -> str:
        user = next(m["content"] for m in messages if m["role"] == "user")
        is_control = "No defect of this class exists" in user
        disp = ctrl_disp if is_control else vuln_disp
        citations = [] if disp == "not_found" else [_cite_first(messages)]
        return json.dumps(
            {"disposition": disp, "citations": citations, "rationale": "r"}
        )
    return _call


def test_perfect_detection_full_rate(answer_keys: dict) -> None:
    vuln_entries = [
        _scenario_entry(n, [_finding_response(
            "a concrete surviving-artifact description of the key chain")])
        for n in sorted(VULN)
    ]
    ctrl_entries = [
        _scenario_entry(n, [_finding_response("the safeguard holds; approve")])
        for n in sorted(CTRL)
    ]
    arm = ljs.score_arm(
        _arm("treatment", vuln_entries + ctrl_entries), answer_keys,
        _per_arm_judge("correct", "not_found"),
    )
    assert arm["vulnerable_runs"] == len(VULN)
    assert arm["vulnerable_correct"] == len(VULN)
    assert arm["vulnerable_detection_rate"] == 1.0
    assert arm["control_false_positive_rate"] == 0.0
    assert arm["judge_unavailable"] == 0


def test_suppression_is_not_detection(answer_keys: dict) -> None:
    entries = [_scenario_entry(6545, [_finding_response(
        "found the orphaned child but it is pre-existing so not blocking")])]
    arm = ljs.score_arm(
        _arm("treatment", entries), answer_keys,
        _always("suppressed_pre_existing"),
    )
    # suppressed is counted under its own disposition, never as correct.
    assert arm["dispositions"]["suppressed_pre_existing"] == 1
    assert arm["vulnerable_detection_rate"] == 0.0


def test_control_hallucination_counts_as_false_positive(answer_keys: dict) -> None:
    ctrl_entries = [_scenario_entry(n, [_finding_response(
        "the boundary may leak reviewer secrets; could expose tokens")])
        for n in sorted(CTRL)]
    arm = ljs.score_arm(
        _arm("baseline", ctrl_entries), answer_keys,
        _per_arm_judge("correct", "speculative_false_positive"),
    )
    assert arm["control_runs"] == len(CTRL)
    assert arm["control_false_positives"] == len(CTRL)
    assert arm["control_false_positive_rate"] == 1.0


def test_unavailable_judge_is_fail_closed_miss(answer_keys: dict) -> None:
    entry = [_scenario_entry(6545, [_finding_response("whatever")])]

    def _raise(messages: list[dict], attempt: int = 0) -> str:
        raise RuntimeError("boom")

    arm = ljs.score_arm(_arm("treatment", entry), answer_keys, _raise, sleep=_NO_SLEEP)
    assert arm["judge_unavailable"] == 1
    assert arm["dispositions"]["judge_unavailable"] == 1
    assert arm["vulnerable_detection_rate"] == 0.0
    assert arm["failures"] and arm["failures"][0]["reason"] == "judge_unavailable"


def test_bad_citation_is_treated_as_unavailable(answer_keys: dict) -> None:
    # correct disposition but a citation absent from the response -> fail-closed
    # miss (judge_unavailable), not a pass.
    def _call(messages: list[dict], attempt: int = 0) -> str:
        return json.dumps({"disposition": "correct",
                           "citations": ["span that is not present"],
                           "rationale": "r"})
    entry = [_scenario_entry(6545, [_finding_response("found it, orphaned child")])]
    arm = ljs.score_arm(_arm("treatment", entry), answer_keys, _call, sleep=_NO_SLEEP)
    assert arm["dispositions"]["judge_unavailable"] == 1
    assert arm["vulnerable_detection_rate"] == 0.0


def test_compare_delta(answer_keys: dict) -> None:
    ctrl = [_scenario_entry(n, [_finding_response("safeguard holds")])
            for n in sorted(CTRL)]
    vuln_b = [_scenario_entry(n, [_finding_response("miss")]) for n in sorted(VULN)]
    vuln_t = [_scenario_entry(n, [_finding_response("found the full chain")])
              for n in sorted(VULN)]
    base = ljs.score_arm(_arm("baseline", vuln_b + ctrl), answer_keys,
                         _per_arm_judge("not_found", "not_found"))
    treat = ljs.score_arm(_arm("treatment", vuln_t + ctrl), answer_keys,
                          _per_arm_judge("correct", "not_found"))
    rep = ljs.compare([base, treat])
    assert rep["delta_treatment_minus_baseline"]["vulnerable_detection_rate"] == 1.0
    assert rep["delta_treatment_minus_baseline"]["control_false_positive_rate"] == 0.0


def test_unjudged_control_is_not_counted_as_false_positive(answer_keys: dict) -> None:
    # An unavailable verdict on a control (e.g. transport fault) must not be
    # counted as a hallucination: the control run is excluded from the FP rate.
    ctrl = [_scenario_entry(n, [_finding_response("safeguard holds")])
            for n in sorted(CTRL)]

    def _raise(messages: list[dict], attempt: int = 0) -> str:
        raise RuntimeError("boom")

    arm = ljs.score_arm(_arm("baseline", ctrl), answer_keys, _raise, sleep=_NO_SLEEP)
    assert arm["judge_unavailable"] == len(CTRL)
    assert arm["control_runs"] == 0
    assert arm["control_false_positives"] == 0
    assert arm["control_false_positive_rate"] == 0.0


def test_main_requires_args(tmp_path: Path) -> None:
    assert ljs.main(["--baseline", str(CORPUS_PATH), "--treatment", str(CORPUS_PATH)]) == 2
