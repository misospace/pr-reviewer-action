"""Tests for scripts/live_judge_score.py (#661 blinded A/B judge scoring).

No network: an injected fake judge scores blinded run payloads shaped exactly
like the driver's ``liveblinded-<arm>.json``. Corpus answer keys come from the
real frozen calibration corpus.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import pytest  # noqa: E402

from pr_reviewer import http_safe, semantic_judge  # noqa: E402
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


def test_main_requires_calibration_artifact() -> None:
    # --calibration-artifact is mandatory: refusing to run without a proven
    # calibration is fail-closed, enforced by argparse.
    with pytest.raises(SystemExit) as excinfo:
        ljs.main(["--baseline", str(CORPUS_PATH), "--treatment", str(CORPUS_PATH)])
    assert excinfo.value.code == 2


# ── arm comparability (fail-closed) ─────────────────────────────────────────

def _arm_doc(name: str, entries: list[dict], reps: int = 1) -> dict:
    return {"arm": name, "reps": reps, "scenarios": entries}


def _run(rep: int, message: str = "m") -> dict:
    return {"rep": rep, "response": _finding_response(message)}


def _frozen_scenario_numbers() -> set[int]:
    corpus = semantic_judge.load_calibration_corpus(CORPUS_PATH)
    return {s["number"] for s in corpus["scenarios"]}


def _full_corpus_arm(name: str, reps: int = 1) -> dict:
    return {
        "arm": name,
        "reps": reps,
        "scenarios": [
            {"scenario": number, "runs": [_run(i) for i in range(1, reps + 1)]}
            for number in sorted(_frozen_scenario_numbers())
        ],
    }


def test_validate_arms_accepts_comparable_arms() -> None:
    base = _arm_doc("baseline", [{"scenario": 6545, "runs": [_run(1), _run(2)]}], reps=2)
    treat = _arm_doc("treatment", [{"scenario": 6545, "runs": [_run(1), _run(2)]}], reps=2)
    assert ljs.validate_arms(base, treat) == []


def test_validate_arms_rejects_wrong_arm_labels() -> None:
    base = _arm_doc("treatment", [{"scenario": 6545, "runs": [_run(1)]}])
    treat = _arm_doc("baseline", [{"scenario": 6545, "runs": [_run(1)]}])
    errors = ljs.validate_arms(base, treat)
    assert any("arm: baseline" in e for e in errors)
    assert any("arm: treatment" in e for e in errors)


def test_validate_arms_rejects_duplicate_scenario_ids() -> None:
    base = _arm_doc("baseline", [{"scenario": 6545, "runs": [_run(1)]},
                                {"scenario": 6545, "runs": [_run(2)]}])
    treat = _arm_doc("treatment", [{"scenario": 6545, "runs": [_run(1)]}])
    assert any("duplicate scenario 6545" in e for e in ljs.validate_arms(base, treat))


def test_validate_arms_rejects_asymmetric_scenario_sets() -> None:
    base = _arm_doc("baseline", [{"scenario": 6545, "runs": [_run(1)]}])
    treat = _arm_doc("treatment", [{"scenario": 6547, "runs": [_run(1)]}])
    errors = ljs.validate_arms(base, treat)
    assert any("different scenario sets" in e for e in errors)


def test_validate_arms_rejects_rep_mismatch() -> None:
    base = _arm_doc("baseline", [{"scenario": 6545, "runs": [_run(1), _run(2)]}])
    treat = _arm_doc("treatment", [{"scenario": 6545, "runs": [_run(1)]}])
    errors = ljs.validate_arms(base, treat)
    assert any("different rep ids/counts" in e for e in errors)


def test_validate_arms_rejects_duplicate_rep_ids() -> None:
    base = _arm_doc("baseline", [{"scenario": 6545, "runs": [_run(1), _run(1)]}])
    treat = _arm_doc("treatment", [{"scenario": 6545, "runs": [_run(1)]}])
    errors = ljs.validate_arms(base, treat)
    assert any("duplicate rep ids" in e for e in errors)


def test_validate_arms_rejects_missing_response() -> None:
    base = _arm_doc("baseline", [{"scenario": 6545, "runs": [{"rep": 1}]}])
    treat = _arm_doc("treatment", [{"scenario": 6545, "runs": [{"rep": 1}]}])
    errors = ljs.validate_arms(base, treat)
    assert any("no response object" in e for e in errors)


def test_main_refuses_incomparable_arms(tmp_path: Path) -> None:
    base = tmp_path / "b.json"
    treat = tmp_path / "t.json"
    base.write_text(json.dumps(_arm_doc("baseline", [{"scenario": 6545, "runs": [_run(1)]}])))
    treat.write_text(json.dumps(_arm_doc("treatment", [{"scenario": 6547, "runs": [_run(1)]}])))
    artifact = _write_artifact(tmp_path / "calib.json")
    assert ljs.main([
        "--baseline", str(base), "--treatment", str(treat),
        "--calibration-artifact", str(artifact),
        "--judge-model", "m", "--base-url", "http://x",
    ]) == 2


# ── calibration-artifact binding (fail-closed) ──────────────────────────────

def _write_artifact(path: Path, *, model: str = "m",
                    config: dict | None = None, agreement: float = 1.0,
                    total: int = 62, passed: int | None = None,
                    base_url: str = "http://x") -> Path:
    payload = {
        "judge_prompt_version": semantic_judge.JUDGE_PROMPT_VERSION,
        "judge_model": model,
        # Mirrors what scripts/run_judge_calibration.py records (#1414,
        # #1424): the display form is userinfo-redacted, the endpoint
        # identity lives in the credential-free digest.
        "base_url": http_safe.redact_url_userinfo(base_url),
        "base_url_sha256": http_safe.base_url_identity_digest(base_url),
        "total": total,
        "passed": total if passed is None else passed,
        "agreement_rate": agreement,
    }
    if config is None:
        payload["judge_config"] = semantic_judge.judge_config_identity(model, CORPUS_PATH)
    else:
        payload["judge_config"] = config
    path.write_text(json.dumps(payload))
    return path


def test_verified_calibration_accepts_matching_artifact(tmp_path: Path) -> None:
    art = _write_artifact(tmp_path / "c.json", model="m")
    artifact, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, "http://x")
    assert errors == []
    assert artifact["judge_config"]["judge_model"] == "m"


def test_verified_calibration_rejects_wrong_model(tmp_path: Path) -> None:
    art = _write_artifact(tmp_path / "c.json", model="other")
    _, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, "http://x")
    assert any("judge_model" in e for e in errors)


def test_verified_calibration_rejects_wrong_prompt_version(tmp_path: Path) -> None:
    cfg = semantic_judge.judge_config_identity("m", CORPUS_PATH)
    cfg["judge_prompt_version"] = "661-j0"
    art = _write_artifact(tmp_path / "c.json", model="m", config=cfg)
    _, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, "http://x")
    assert any("judge_prompt_version" in e for e in errors)


def test_verified_calibration_rejects_wrong_setting(tmp_path: Path) -> None:
    cfg = semantic_judge.judge_config_identity("m", CORPUS_PATH)
    cfg["max_tokens"] = 1024
    art = _write_artifact(tmp_path / "c.json", model="m", config=cfg)
    _, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, "http://x")
    assert any("max_tokens" in e for e in errors)


def test_verified_calibration_rejects_wrong_corpus_hash(tmp_path: Path) -> None:
    cfg = semantic_judge.judge_config_identity("m", CORPUS_PATH)
    cfg["calibration_corpus_sha256"] = "0" * 64
    art = _write_artifact(tmp_path / "c.json", model="m", config=cfg)
    _, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, "http://x")
    assert any("calibration_corpus_sha256" in e for e in errors)


def test_verified_calibration_rejects_missing_identity(tmp_path: Path) -> None:
    payload = {"total": 62, "passed": 62, "agreement_rate": 1.0}
    art = tmp_path / "c.json"
    art.write_text(json.dumps(payload))
    _, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, "http://x")
    assert any("missing its judge_config" in e for e in errors)


def test_verified_calibration_rejects_imperfect_calibration(tmp_path: Path) -> None:
    art = _write_artifact(tmp_path / "c.json", model="m", agreement=0.9, passed=56)
    _, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, "http://x")
    assert any("100% agreement" in e for e in errors)
    # benign scalar values stay rendered so the diagnostic is still useful
    detail = next(e for e in errors if "100% agreement" in e)
    assert "passed=56" in detail
    assert "total=62" in detail
    assert "agreement_rate=0.9" in detail


def test_verified_calibration_rejects_unreadable_artifact(tmp_path: Path) -> None:
    bad = tmp_path / "c.json"
    bad.write_text("{not json")
    _, errors = ljs._load_verified_calibration(bad, "m", CORPUS_PATH, "http://x")
    assert errors


def test_verified_calibration_rejects_a_binary_artifact_with_a_clean_refusal(
    tmp_path: Path,
) -> None:
    """#1429: a calibration artifact is a shared file, and a binary one must
    fail closed with the same clean refusal as any other unreadable artifact —
    not a bare UnicodeDecodeError traceback."""
    bad = tmp_path / "c.json"
    bad.write_bytes(b"\xff\xfe\x00binary artifact\x00\xff")
    _, errors = ljs._load_verified_calibration(bad, "m", CORPUS_PATH, "http://x")
    assert errors
    assert any("cannot read calibration artifact" in e for e in errors)


def test_main_refuses_mismatched_calibration(tmp_path: Path) -> None:
    base = tmp_path / "b.json"
    treat = tmp_path / "t.json"
    base.write_text(json.dumps(_full_corpus_arm("baseline")))
    treat.write_text(json.dumps(_full_corpus_arm("treatment")))
    art = _write_artifact(tmp_path / "c.json", model="some-other-model")
    assert ljs.main([
        "--baseline", str(base), "--treatment", str(treat),
        "--calibration-artifact", str(art),
        "--judge-model", "m", "--base-url", "http://x",
    ]) == 2


# ── frozen-corpus completeness + reps contract (measurement integrity) ──────

def _pair_omitting(name_pairs, expected, omit):
    """Build an arm doc whose scenarios are the expected set minus ``omit``."""
    def _arm(name):
        numbers = sorted(n for n in expected if n != omit)
        return {
            "arm": name, "reps": 1,
            "scenarios": [{"scenario": n, "runs": [_run(1)]} for n in numbers],
        }
    return _arm(name_pairs[0]), _arm(name_pairs[1])


def test_validate_arms_rejects_both_arms_omitting_same_scenario() -> None:
    expected = _frozen_scenario_numbers()
    base, treat = _pair_omitting(("baseline", "treatment"), expected, 6545)
    errors = ljs.validate_arms(base, treat, expected_scenarios=expected)
    assert any("6545" in e and "missing" in e for e in errors)


def test_validate_arms_rejects_single_scenario_pair() -> None:
    expected = _frozen_scenario_numbers()
    def _arm(name):
        return {"arm": name, "reps": 1,
                "scenarios": [{"scenario": 6545, "runs": [_run(1)]}]}
    errors = ljs.validate_arms(_arm("baseline"), _arm("treatment"),
                               expected_scenarios=expected)
    assert any("missing" in e for e in errors)


def test_validate_arms_rejects_incomplete_rep_set() -> None:
    # Both arms declare reps=3 but every scenario carries a single run.
    def _arm(name):
        return {
            "arm": name, "reps": 3,
            "scenarios": [{"scenario": n, "runs": [_run(1)]}
                           for n in sorted(_frozen_scenario_numbers())],
        }
    errors = ljs.validate_arms(_arm("baseline"), _arm("treatment"))
    assert any("declares reps=3" in e for e in errors)


def test_validate_arms_absurd_reps_rejected_without_allocation() -> None:
    # `reps` is untrusted payload data: an absurd value must not be able to
    # force a huge range allocation (uncaught MemoryError) in the
    # completeness check. The check must reject from the observed ids alone.
    reps = 2_000_000
    def _arm(name):
        return {
            "arm": name, "reps": reps,
            "scenarios": [{"scenario": 6545, "runs": [_run(1)]}],
        }
    start = time.perf_counter()
    errors = ljs.validate_arms(_arm("baseline"), _arm("treatment"))
    elapsed = time.perf_counter() - start
    assert any("6545" in e and f"declares reps={reps}" in e for e in errors)
    # The rejection must not materialise the full 1..reps range in a list.
    assert not any("[1, 2" in e for e in errors)
    assert elapsed < 5.0  # prompt rejection, no large allocation


def test_main_refuses_absurd_reps(tmp_path: Path) -> None:
    # End-to-end: the same hostile payload is cleanly refused (exit 2),
    # never a MemoryError.
    reps = 2_000_000
    def _arm(name):
        return {
            "arm": name, "reps": reps,
            "scenarios": [
                {"scenario": n, "runs": [_run(1)]}
                for n in sorted(_frozen_scenario_numbers())
            ],
        }
    base = tmp_path / "b.json"
    treat = tmp_path / "t.json"
    base.write_text(json.dumps(_arm("baseline")))
    treat.write_text(json.dumps(_arm("treatment")))
    art = _write_artifact(tmp_path / "c.json")
    assert ljs.main([
        "--baseline", str(base), "--treatment", str(treat),
        "--calibration-artifact", str(art),
        "--judge-model", "m", "--base-url", "http://x",
    ]) == 2


def test_validate_arms_accepts_full_corpus_identical_reps() -> None:
    expected = _frozen_scenario_numbers()
    assert ljs.validate_arms(
        _full_corpus_arm("baseline"), _full_corpus_arm("treatment"),
        expected_scenarios=expected,
    ) == []


def test_validate_arms_allow_subset_accepts_identical_subset() -> None:
    expected = _frozen_scenario_numbers()
    def _arm(name):
        return {"arm": name, "reps": 1,
                "scenarios": [{"scenario": 6545, "runs": [_run(1)]}]}
    assert ljs.validate_arms(
        _arm("baseline"), _arm("treatment"),
        expected_scenarios=expected, allow_subset=True,
    ) == []


def test_validate_arms_allow_subset_rejects_extra_scenario() -> None:
    expected = _frozen_scenario_numbers()
    def _arm(name):
        return {"arm": name, "reps": 1,
                "scenarios": [{"scenario": 9999, "runs": [_run(1)]}]}
    errors = ljs.validate_arms(
        _arm("baseline"), _arm("treatment"),
        expected_scenarios=expected, allow_subset=True,
    )
    assert any("9999" in e and "absent from the frozen corpus" in e
               for e in errors)


# ── endpoint binding (base_url is part of the proven identity) ──────────────

def test_calibration_rejects_mismatched_base_url(tmp_path: Path) -> None:
    art = _write_artifact(tmp_path / "c.json", model="m", base_url="http://y")
    _, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, "http://x")
    assert any("base_url" in e for e in errors)


def test_calibration_accepts_trailing_slash_base_url(tmp_path: Path) -> None:
    art = _write_artifact(tmp_path / "c.json", model="m", base_url="http://x/")
    _, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, "http://x")
    assert errors == []


def test_calibration_rejects_degenerate_base_url(tmp_path: Path) -> None:
    # A live endpoint that normalizes to empty ("/") is rejected outright,
    # before any digest comparison: the degenerate endpoint can no longer
    # slip through. (#1424: the artifact side can no longer record such a
    # value at all — the runner digests only resolved, credential-free
    # endpoints — so the malformed artifact is constructed inline.)
    art = tmp_path / "c.json"
    art.write_text(json.dumps({
        "judge_prompt_version": semantic_judge.JUDGE_PROMPT_VERSION,
        "judge_model": "m",
        "base_url": "/",
        "base_url_sha256": "0" * 64,
        "total": 62,
        "passed": 62,
        "agreement_rate": 1.0,
        "judge_config": semantic_judge.judge_config_identity("m", CORPUS_PATH),
    }))
    _, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, "/")
    assert any("empty after normalization" in e for e in errors)


def test_calibration_rejects_missing_base_url(tmp_path: Path) -> None:
    art = _write_artifact(tmp_path / "c.json", model="m")
    payload = json.loads(art.read_text(encoding="utf-8"))
    del payload["base_url"]  # simulate a recorded base_url that is missing
    art.write_text(json.dumps(payload))
    _, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, "http://x")
    assert any("base_url" in e for e in errors)


# ── userinfo redaction (#1414): never a credential in errors; endpoint
#    identity via the credential-free digest (#1424) ────────────────────────

USERINFO_URL = "https://judge-operator:hunter2@judge.internal.example/v1"


def test_calibration_accepts_userinfo_base_url(tmp_path: Path) -> None:
    art = _write_artifact(tmp_path / "c.json", model="m", base_url=USERINFO_URL)
    _, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, USERINFO_URL)
    assert errors == []
    # The artifact on disk carries no userinfo credential, only the redacted
    # display form plus the credential-free endpoint digest (#1424).
    serialized = art.read_text(encoding="utf-8")
    assert "hunter2" not in serialized and "judge-operator" not in serialized
    assert "***@judge.internal.example/v1" in serialized


def test_calibration_accepts_credential_rotation_on_same_endpoint(
    tmp_path: Path,
) -> None:
    # #1424 flips the #1414 rule: the artifact binds the credential-free
    # endpoint identity, so dropping or rotating the userinfo compares
    # equal — the credential cannot be inverted from the recorded digest,
    # and rotating it must not invalidate the artifact.
    art = _write_artifact(tmp_path / "c.json", model="m", base_url=USERINFO_URL)
    _, errors = ljs._load_verified_calibration(
        art, "m", CORPUS_PATH, "https://judge.internal.example/v1"
    )
    assert errors == []
    rotated = "https://judge-operator:newpw@judge.internal.example/v1"
    _, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, rotated)
    assert errors == []


def test_calibration_mismatch_error_redacts_userinfo(tmp_path: Path) -> None:
    art = _write_artifact(tmp_path / "c.json", model="m", base_url=USERINFO_URL)
    _, errors = ljs._load_verified_calibration(
        art, "m", CORPUS_PATH, "https://other-operator:t0psecret@other.internal/v1"
    )
    joined = "\n".join(errors)
    assert any("does not match" in e for e in errors)
    for secret in ("hunter2", "judge-operator", "t0psecret", "other-operator"):
        assert secret not in joined
    assert "***@judge.internal.example/v1" in joined
    assert "***@other.internal/v1" in joined


def test_calibration_malformed_base_url_errors_redact_credentials(
    tmp_path: Path,
) -> None:
    # A malformed artifact can carry the boundary token in a value the error
    # paths echo: a non-string JSON value ("missing or not a string") and a
    # stringified payload that passes the string check but parses as no
    # authority at all ("does not match"). Neither may leak into the error
    # message (#1414). The live endpoint deliberately mismatches the recorded
    # digest so both diagnostics fire.
    malformed_values: list[object] = [
        [USERINFO_URL],
        {"url": USERINFO_URL},
        USERINFO_URL.split("@"),
        json.dumps([USERINFO_URL]),
        json.dumps({"base_url": USERINFO_URL}),
        f"see {USERINFO_URL}",
        f"https://relay.internal/{USERINFO_URL}",
        USERINFO_URL.replace("://", ":/"),
    ]
    for malformed in malformed_values:
        art = _write_artifact(tmp_path / "c.json", model="m")
        payload = json.loads(art.read_text(encoding="utf-8"))
        payload["base_url"] = malformed
        art.write_text(json.dumps(payload))
        _, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, "http://y")
        joined = "\n".join(errors)
        if isinstance(malformed, str):
            assert any("does not match" in e for e in errors)
        else:
            assert any("not a string" in e for e in errors)
        # The userinfo is the credential; the host stays in the redacted
        # display form by design (diagnostics still identify the endpoint).
        for secret in ("hunter2", "judge-operator"):
            assert secret not in joined


def test_calibration_agreement_error_redacts_credential_bearing_fields(
    tmp_path: Path,
) -> None:
    # #1418 (adversarial-boundary, #252): the agreement diagnostic echoes the
    # artifact's passed/total/agreement_rate. A credential URL planted in any
    # echoed field — string, container, or stringified payload — must never
    # reach the error list, and the diagnostic must still fire and name the
    # fields.
    hostile_cases: list[tuple[str, object]] = [
        ("passed", USERINFO_URL),
        ("total", USERINFO_URL),
        ("agreement_rate", USERINFO_URL),
        ("passed", {"url": USERINFO_URL}),
        ("agreement_rate", [USERINFO_URL]),
        ("total", json.dumps({"t": USERINFO_URL})),
        ("agreement_rate", f"see {USERINFO_URL}"),
        ("agreement_rate", f"https://relay.internal/{USERINFO_URL}"),
    ]
    for field, hostile in hostile_cases:
        art = _write_artifact(tmp_path / "c.json", model="m")
        payload = json.loads(art.read_text(encoding="utf-8"))
        payload[field] = hostile
        art.write_text(json.dumps(payload))
        _, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, "http://x")
        joined = "\n".join(errors)
        assert any("did not record 100% agreement" in e for e in errors), field
        for secret in ("hunter2", "judge-operator"):
            assert secret not in joined, f"{secret} leaked via {field}"


def test_calibration_rejects_legacy_artifact_without_digest(tmp_path: Path) -> None:
    art = _write_artifact(tmp_path / "c.json", model="m")
    payload = json.loads(art.read_text(encoding="utf-8"))
    del payload["base_url_sha256"]  # artifact written before #1414
    art.write_text(json.dumps(payload))
    _, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, "http://x")
    assert any("base_url_sha256" in e for e in errors)


def test_calibration_reports_unresolvable_live_endpoint(tmp_path: Path) -> None:
    """#1424: a live endpoint that cannot be resolved into a credential-free
    endpoint identity fails closed as an error — never a raise, and never a
    digest over the raw value."""
    art = _write_artifact(tmp_path / "c.json", model="m")
    _, errors = ljs._load_verified_calibration(art, "m", CORPUS_PATH, "not-a-url")
    assert any("could not be resolved" in e for e in errors)


def test_main_refuses_a_credential_bearing_endpoint_with_another_key(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    """#1414: a credential must ride exactly one channel. Two channels (a URL
    userinfo and an API key) cannot share one Authorization header, so the
    run is refused before any request — and the diagnostic never echoes the
    credential. The credential-bearing URL comes from the environment: a
    credential never rides in the process argument list."""
    monkeypatch.setenv(
        "JUDGE_BASE_URL", "http://judge-operator:hunter2@127.0.0.1:1/v1"
    )
    monkeypatch.setenv("JUDGE_API_KEY", "judge-test-credential")
    base = tmp_path / "b.json"
    treat = tmp_path / "t.json"
    base.write_text(json.dumps(_arm_doc("baseline", [{"scenario": 6545, "runs": [_run(1)]}])))
    treat.write_text(json.dumps(_arm_doc("treatment", [{"scenario": 6545, "runs": [_run(1)]}])))
    art = _write_artifact(tmp_path / "calib.json", model="m")
    code = ljs.main([
        "--baseline", str(base), "--treatment", str(treat),
        "--calibration-artifact", str(art),
        "--judge-model", "m",
    ])
    err = capsys.readouterr().err
    assert code == 2
    assert "one credential channel" in err
    assert "hunter2" not in err
    assert "judge-operator" not in err


def test_main_refuses_an_encoded_credential_endpoint(tmp_path: Path, capsys) -> None:
    """#1414: an encoded '@' hides the credential from the authority split
    while urllib unquotes the authority into the request's Host value — the
    endpoint is refused, with a credential-free diagnostic."""
    base = tmp_path / "b.json"
    treat = tmp_path / "t.json"
    base.write_text(json.dumps(_arm_doc("baseline", [{"scenario": 6545, "runs": [_run(1)]}])))
    treat.write_text(json.dumps(_arm_doc("treatment", [{"scenario": 6545, "runs": [_run(1)]}])))
    art = _write_artifact(tmp_path / "calib.json", model="m")
    code = ljs.main([
        "--baseline", str(base), "--treatment", str(treat),
        "--calibration-artifact", str(art),
        "--judge-model", "m",
        "--base-url", "http://judge-operator%3Ahunter2%40127.0.0.1/v1",
    ])
    err = capsys.readouterr().err
    assert code == 2
    assert "hunter2" not in err
    assert "judge-operator" not in err


def test_main_refuses_both_arms_omitting_same_scenario(tmp_path: Path) -> None:
    expected = _frozen_scenario_numbers()
    base_path = tmp_path / "b.json"
    treat_path = tmp_path / "t.json"
    base, treat = _pair_omitting(("baseline", "treatment"), expected, 6545)
    base_path.write_text(json.dumps(base))
    treat_path.write_text(json.dumps(treat))
    art = _write_artifact(tmp_path / "c.json", model="m")
    assert ljs.main([
        "--baseline", str(base_path), "--treatment", str(treat_path),
        "--calibration-artifact", str(art),
        "--judge-model", "m", "--base-url", "http://x",
    ]) == 2


# ── credential-free argv (#1413) ────────────────────────────────────────────

_SECRET = "sk-secret-value"


def _no_transport(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the judge transport unreachable: a refusal must precede it."""

    def _boom(*_args, **_kwargs):
        raise AssertionError("the judge transport must not be reached")

    monkeypatch.setattr(ljs, "_openai_judge_call", _boom)


def _run_argv(tmp_path: Path, extra: list[str]) -> list[str]:
    """An otherwise valid run, plus the argument under test."""
    base = tmp_path / "b.json"
    treat = tmp_path / "t.json"
    base.write_text(json.dumps(_full_corpus_arm("baseline")))
    treat.write_text(json.dumps(_full_corpus_arm("treatment")))
    art = _write_artifact(tmp_path / "c.json", model="m")
    return [
        "--baseline", str(base), "--treatment", str(treat),
        "--calibration-artifact", str(art),
        "--judge-model", "m", "--base-url", "http://x",
        *extra,
    ]


def test_api_key_argument_is_refused_without_echo(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    _no_transport(monkeypatch)
    code = ljs.main(_run_argv(tmp_path, ["--api-key", _SECRET]))
    err = capsys.readouterr().err
    assert code == 2
    assert _SECRET not in err
    assert "--api-key" in err


def test_api_key_equals_form_is_refused_without_echo(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    _no_transport(monkeypatch)
    code = ljs.main(_run_argv(tmp_path, [f"--api-key={_SECRET}"]))
    err = capsys.readouterr().err
    assert code == 2
    assert _SECRET not in err
    assert "--api-key" in err


def test_api_key_abbreviation_is_refused_without_echo(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    _no_transport(monkeypatch)
    code = ljs.main(_run_argv(tmp_path, ["--api-k", _SECRET]))
    err = capsys.readouterr().err
    assert code == 2
    assert _SECRET not in err
    assert "--api-key" in err


def test_unknown_argument_is_refused_without_echo(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    _no_transport(monkeypatch)
    code = ljs.main(_run_argv(tmp_path, ["--mystery-flag", _SECRET]))
    err = capsys.readouterr().err
    assert code == 2
    assert _SECRET not in err
    assert "unrecognized argument" in err


def test_judge_key_comes_from_the_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("JUDGE_API_KEY", "env-key-value")
    recorded: list[str] = []

    def _fake_judge_call(
        judge_model: str, base_url: str, api_key: str, timeout_sec: int
    ):
        recorded.append(api_key)
        return _always("correct")

    monkeypatch.setattr(ljs, "_openai_judge_call", _fake_judge_call)
    assert ljs.main(_run_argv(tmp_path, [])) == 0
    assert recorded == ["env-key-value"]


def test_credential_refusal_comes_before_the_parser(
    capsys: pytest.CaptureFixture[str],
) -> None:
    # The refusal runs before argparse, so the missing required arguments do
    # not hide the credential guidance and no parser message can quote a value.
    code = ljs.main(["--api-key", _SECRET])
    err = capsys.readouterr().err
    assert code == 2
    assert _SECRET not in err
    assert "--api-key" in err


def test_a_value_for_a_known_option_is_not_echoed(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # argparse quotes the value of an option in its own error message. The
    # parser of this script must not, so a mistyped secret stays out of the log.
    with pytest.raises(SystemExit) as excinfo:
        ljs.main(_run_argv(tmp_path, ["--timeout", _SECRET]))
    assert excinfo.value.code == 2
    err = capsys.readouterr().err
    assert _SECRET not in err


def test_an_abbreviated_flag_cannot_relax_the_full_corpus_guard(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # "--a" and "--al" must not resolve to --allow-subset-scenarios. The
    # prefix would silently relax the fail-closed full-corpus guard.
    for prefix in ("--a", "--al"):
        code = ljs.main(_run_argv(tmp_path, [prefix]))
        err = capsys.readouterr().err
        assert code == 2
        assert _SECRET not in err


def test_the_parser_knows_no_credential_option() -> None:
    # The parser must not know the option, so the refusal is the only way in.
    _args, extras = ljs.build_parser().parse_known_args([
        "--baseline", "b.json", "--treatment", "t.json",
        "--calibration-artifact", "c.json", "--api-key", _SECRET,
    ])
    assert "--api-key" in extras


def test_the_exact_subset_flag_still_parses() -> None:
    args, extras = ljs.build_parser().parse_known_args([
        "--baseline", "b.json", "--treatment", "t.json",
        "--calibration-artifact", "c.json", "--allow-subset-scenarios",
    ])
    assert args.allow_subset_scenarios is True
    assert extras == []


def test_main_refuses_a_credential_bearing_base_url_from_the_command_line(
    tmp_path: Path, capsys
) -> None:
    """#1414: a credential in an argument list is readable by every other
    process on the host, so a credential-bearing base URL is accepted from
    JUDGE_BASE_URL only. The refusal never echoes the credential."""
    base = tmp_path / "b.json"
    treat = tmp_path / "t.json"
    base.write_text(json.dumps(_arm_doc("baseline", [{"scenario": 6545, "runs": [_run(1)]}])))
    treat.write_text(json.dumps(_arm_doc("treatment", [{"scenario": 6545, "runs": [_run(1)]}])))
    art = _write_artifact(tmp_path / "calib.json", model="m")
    code = ljs.main([
        "--baseline", str(base), "--treatment", str(treat),
        "--calibration-artifact", str(art),
        "--judge-model", "m",
        "--base-url", "http://judge-operator:hunter2@127.0.0.1:1/v1",
    ])
    err = capsys.readouterr().err
    assert code == 2
    assert "must not carry a credential" in err
    assert "hunter2" not in err
    assert "judge-operator" not in err


@pytest.mark.parametrize(
    ("arguments", "expected_refusal"),
    [
        (
            ["--base-url=http://judge-operator:hunter2@127.0.0.1:1/v1"],
            "must not carry a credential",
        ),
        # #1413 disables argparse abbreviations entirely. This form is rejected
        # even earlier by the value-safe unknown-argument guard.
        (
            ["--base-u", "http://judge-operator:hunter2@127.0.0.1:1/v1"],
            "unrecognized argument",
        ),
        (
            [
                "--base-url", "http://judge-operator:hunter2@127.0.0.1:1/v1",
                "--base-url", "http://127.0.0.1:1/v1",
            ],
            "must not carry a credential",
        ),
        (
            ["--base-url", "http://judge-operator:hunter2/pass@127.0.0.1:1/v1"],
            "must not carry a credential",
        ),
    ],
)
def test_main_refuses_every_credential_bearing_command_line_form(
    arguments: list[str], expected_refusal: str, tmp_path: Path, capsys
) -> None:
    """#1414/#1413: every credential-bearing CLI form is refused without
    echoing the value; disabled abbreviations fail at the earlier safe parser
    boundary while exact base-URL forms reach the credential-specific guard."""
    base = tmp_path / "b.json"
    treat = tmp_path / "t.json"
    base.write_text(json.dumps(_arm_doc("baseline", [{"scenario": 6545, "runs": [_run(1)]}])))
    treat.write_text(json.dumps(_arm_doc("treatment", [{"scenario": 6545, "runs": [_run(1)]}])))
    art = _write_artifact(tmp_path / "calib.json", model="m")
    code = ljs.main([
        "--baseline", str(base), "--treatment", str(treat),
        "--calibration-artifact", str(art),
        "--judge-model", "m",
        *arguments,
    ])
    err = capsys.readouterr().err
    assert code == 2
    assert expected_refusal in err
    assert "hunter2" not in err
    assert "judge-operator" not in err

def test_main_takes_a_credential_bearing_base_url_from_the_environment(
    tmp_path: Path, monkeypatch
) -> None:
    """#1414: the environment is the channel that may carry the credential.
    The runner uses that endpoint and splits the credential out of the URL,
    so the request target carries no secret."""
    monkeypatch.delenv("JUDGE_API_KEY", raising=False)
    url = "http://judge-operator:hunter2@127.0.0.1:1/v1"
    monkeypatch.setenv("JUDGE_BASE_URL", url)
    base = tmp_path / "b.json"
    treat = tmp_path / "t.json"
    base.write_text(json.dumps(_full_corpus_arm("baseline")))
    treat.write_text(json.dumps(_full_corpus_arm("treatment")))
    art = _write_artifact(tmp_path / "calib.json", model="m", base_url=url)
    captured: dict = {}

    class _Stop(BaseException):
        """Stop the run right after the transport is built."""

    def _fake_call(judge_model, endpoint, api_key, timeout_sec):
        captured["url"] = endpoint.url
        captured["credential"] = endpoint.credential
        raise _Stop()

    monkeypatch.setattr(ljs, "_openai_judge_call", _fake_call)
    with pytest.raises(_Stop):
        ljs.main([
            "--baseline", str(base), "--treatment", str(treat),
            "--calibration-artifact", str(art),
            "--judge-model", "m",
        ])
    assert captured["url"] == "http://127.0.0.1:1/v1"
    assert captured["credential"] == "judge-operator:hunter2"

