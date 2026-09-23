"""Tests for scripts/run_judge_calibration.py (#661 judge offline gate).

No network: ``run_calibration`` is exercised with injected fake ``judge_call``
functions against the REAL calibration corpus file. The production transport
(``_openai_judge_call``) is never invoked here.
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
from scripts import run_judge_calibration as runner  # noqa: E402

CORPUS_PATH = _REPO_ROOT / "evals" / "judge-calibration-corpus.json"
_NO_SLEEP = lambda _seconds: None  # keep transport-retry backoff instant in tests
_MARKER = "REVIEWER RESPONSE (untrusted data):\n"


@pytest.fixture(scope="module")
def corpus() -> dict:
    loaded = semantic_judge.load_calibration_corpus(CORPUS_PATH)
    assert semantic_judge.validate_calibration_corpus(loaded) == []
    return loaded


def _payload_of(reference: dict) -> str:
    return json.dumps(
        semantic_judge.blind_response(reference["response"]),
        ensure_ascii=False,
        sort_keys=True,
    )


def _reference_index(corpus: dict) -> dict[str, dict]:
    """Map the exact blinded-response JSON the judge sees -> reference.

    Answer-key sibling runs (standard/deep/escalation of one scenario) can carry
    an identical blinded payload, so this mapping is last-write-wins and is only
    safe when the payload is unique. Callers that must target one reference build
    a uniqueness-checked map (see ``_unique_reference_index``).
    """
    index: dict[str, dict] = {}
    for scenario in corpus["scenarios"]:
        for reference in scenario["references"]:
            index[_payload_of(reference)] = reference
    return index


def _response_payload(messages: list[dict]) -> str:
    user = next(m["content"] for m in messages if m["role"] == "user")
    return user.split(_MARKER, 1)[1]


def _response_reference(messages: list[dict], index: dict[str, dict]) -> dict:
    return index[_response_payload(messages)]


def _unique_reference_index(corpus: dict) -> dict[str, dict]:
    """Blinded payload -> reference, keeping only payloads that occur once, so a
    judge-side match unambiguously identifies one reference."""
    counts: dict[str, int] = {}
    first: dict[str, dict] = {}
    for scenario in corpus["scenarios"]:
        for reference in scenario["references"]:
            payload = _payload_of(reference)
            counts[payload] = counts.get(payload, 0) + 1
            first.setdefault(payload, reference)
    return {p: r for p, r in first.items() if counts[p] == 1}


def _citation_for(reference: dict) -> str:
    response = reference["response"]
    findings = response.get("findings") or []
    if findings and (findings[0].get("message") or findings[0].get("description")):
        return (findings[0].get("message") or findings[0].get("description")).strip()
    return (response.get("review_markdown") or "").strip()


def _judge_from(corpus: dict):
    index = _reference_index(corpus)

    def _judge(messages: list[dict], attempt: int = 0) -> str:
        reference = _response_reference(messages, index)
        expected = reference["expected_disposition"]
        citations = [] if expected == "not_found" else [_citation_for(reference)]
        return json.dumps(
            {"disposition": expected, "citations": citations, "rationale": "ok"}
        )

    return _judge


def test_perfect_judge_full_agreement(corpus: dict) -> None:
    report = runner.run_calibration(corpus, _judge_from(corpus), "fake", "http://x", sleep=_NO_SLEEP)
    assert report["total"] > 0
    assert report["passed"] == report["total"]
    assert report["agreement_rate"] == 1.0
    assert report["failures"] == []
    assert report["judge_prompt_version"] == semantic_judge.JUDGE_PROMPT_VERSION


def test_report_shape(corpus: dict) -> None:
    report = runner.run_calibration(corpus, _judge_from(corpus), "fake", "http://x", sleep=_NO_SLEEP)
    for key in (
        "judge_prompt_version", "judge_model", "base_url", "total", "passed",
        "agreement_rate", "transport_errors", "by_origin", "by_disposition",
        "failures",
    ):
        assert key in report
    # Every origin and expected disposition bucket is present and internally
    # consistent (passed <= total; sums equal the reference total).
    assert sum(b["total"] for b in report["by_origin"].values()) == report["total"]
    assert sum(b["total"] for b in report["by_disposition"].values()) == report["total"]
    for bucket in report["by_origin"].values():
        assert 0 <= bucket["passed"] <= bucket["total"]


def test_report_carries_judge_config_identity(corpus: dict) -> None:
    """With a corpus path the report records the frozen judge identity a live
    run must match (prompt version, model, settings, corpus content hash)."""
    from pr_reviewer import semantic_judge

    report = runner.run_calibration(
        corpus, _judge_from(corpus), "fake", "http://x",
        sleep=_NO_SLEEP, corpus_path=CORPUS_PATH,
    )
    config = report["judge_config"]
    assert config["judge_prompt_version"] == semantic_judge.JUDGE_PROMPT_VERSION
    assert config["judge_model"] == "fake"
    assert config["max_tokens"] == semantic_judge.JUDGE_MAX_TOKENS
    assert config["retry_temperature"] == semantic_judge.JUDGE_RETRY_TEMPERATURE
    assert config["calibration_corpus_sha256"] == semantic_judge.calibration_corpus_sha256(CORPUS_PATH)
    assert config == semantic_judge.judge_config_identity("fake", CORPUS_PATH)
    # Without a path the identity is simply absent (unit-test convenience).
    assert "judge_config" not in runner.run_calibration(
        corpus, _judge_from(corpus), "fake", "http://x", sleep=_NO_SLEEP
    )


def test_fabricated_citation_fails(corpus: dict) -> None:
    index = _reference_index(corpus)

    def _judge(messages: list[dict], attempt: int = 0) -> str:
        reference = _response_reference(messages, index)
        return json.dumps(
            {
                "disposition": reference["expected_disposition"],
                "citations": ["this span was never written by the reviewer"],
                "rationale": "made up",
            }
        )

    report = runner.run_calibration(corpus, _judge, "fake", "http://x", sleep=_NO_SLEEP)
    # Every reference is given a citation that is absent from its own response,
    # so every reference is a fail-closed miss with a citation_error — a judge
    # that quotes a span the reviewer never wrote is wrong even when its
    # disposition happens to match.
    assert report["agreement_rate"] == 0.0
    assert len(report["failures"]) == report["total"]
    for row in report["failures"]:
        assert row["citation_errors"]
        assert "does not appear" in row["citation_errors"][0]


def test_not_found_with_empty_citations_passes(corpus: dict) -> None:
    index = _reference_index(corpus)

    def _judge(messages: list[dict], attempt: int = 0) -> str:
        reference = _response_reference(messages, index)
        return json.dumps(
            {"disposition": reference["expected_disposition"],
             "citations": [], "rationale": "none cited"}
        )

    report = runner.run_calibration(corpus, _judge, "fake", "http://x", sleep=_NO_SLEEP)
    # Every non-not_found reference must fail the >=1 citation rule; every
    # not_found reference must pass it.
    for row in report["failures"]:
        assert row["expected"] != "not_found"


def test_single_wrong_disposition(corpus: dict) -> None:
    unique = _unique_reference_index(corpus)
    perfect = _judge_from(corpus)
    # Target a reference whose blinded payload is globally unique (so the judge
    # side can match it unambiguously) and whose expected disposition differs
    # from the value we flip it to.
    target = next(
        ref for ref in unique.values()
        if ref["expected_disposition"] != "speculative_false_positive"
    )
    target_payload = _payload_of(target)

    def _judge(messages: list[dict], attempt: int = 0) -> str:
        if _response_payload(messages) == target_payload:
            return json.dumps(
                {
                    "disposition": "speculative_false_positive",
                    "citations": [_citation_for(target)],
                    "rationale": "flipped",
                }
            )
        return perfect(messages)

    report = runner.run_calibration(corpus, _judge, "fake", "http://x", sleep=_NO_SLEEP)
    assert report["agreement_rate"] < 1.0
    flip = next(row for row in report["failures"] if row["ref_id"] == target["ref_id"])
    assert flip["expected"] == target["expected_disposition"]
    assert flip["got"] == "speculative_false_positive"
    assert flip["transport_error"] is False


def test_always_raising_judge_records_transport_miss(corpus: dict) -> None:
    def _judge(messages: list[dict], attempt: int = 0) -> str:
        raise RuntimeError("connection refused")

    report = runner.run_calibration(corpus, _judge, "fake", "http://x", sleep=_NO_SLEEP)
    # Every reference is a miss, none crashes, all flagged transport_error.
    assert report["passed"] == 0
    assert report["agreement_rate"] == 0.0
    assert len(report["failures"]) == report["total"]
    assert all(row["transport_error"] for row in report["failures"])
    assert report["transport_errors"] == report["total"]


def test_retry_once_then_succeeds(corpus: dict) -> None:
    good = _judge_from(corpus)
    calls = {"n": 0}

    def _judge(messages: list[dict], attempt: int = 0) -> str:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("transient blip")
        return good(messages)

    report = runner.run_calibration(corpus, _judge, "fake", "http://x", sleep=_NO_SLEEP)
    # The very first transport attempt blips; its reference retries and still
    # grades correctly, so full agreement is restored (transport retry inside
    # grade_reference recovers the first miss).
    assert report["agreement_rate"] == 1.0


def test_malformed_output_rerolled_and_recovered(corpus: dict) -> None:
    """An unparseable verdict re-attempts (attempt>0); a clean verdict does not."""
    good = _judge_from(corpus)
    attempts_seen: list[int] = []

    def _judge(messages: list[dict], attempt: int = 0) -> str:
        attempts_seen.append(attempt)
        if attempt == 0:
            return "this is not json at all"
        return good(messages)

    report = runner.run_calibration(corpus, _judge, "fake", "http://x", sleep=_NO_SLEEP)
    assert report["agreement_rate"] == 1.0
    # Every reference saw its attempt 0 malformed and attempt 1 clean.
    assert max(attempts_seen) == 1
    assert attempts_seen.count(0) == report["total"]


def test_bad_citation_rerolled_and_recovered(corpus: dict) -> None:
    index = _reference_index(corpus)
    good = _judge_from(corpus)

    def _judge(messages: list[dict], attempt: int = 0) -> str:
        if attempt == 0:
            reference = _response_reference(messages, index)
            return json.dumps(
                {"disposition": reference["expected_disposition"],
                 "citations": ["span the reviewer never wrote"], "rationale": "r"}
            )
        return good(messages)

    report = runner.run_calibration(corpus, _judge, "fake", "http://x", sleep=_NO_SLEEP)
    assert report["agreement_rate"] == 1.0


def test_valid_verdict_is_never_retried(corpus: dict) -> None:
    index = _reference_index(corpus)
    attempts_seen: list[int] = []

    def _judge(messages: list[dict], attempt: int = 0) -> str:
        attempts_seen.append(attempt)
        reference = _response_reference(messages, index)
        # Deliberately WRONG but perfectly formed (valid citations included):
        # must be accepted as the judge's judgment (and fail), not re-rolled
        # looking for a better answer.
        wrong = ("speculative_false_positive"
                 if reference["expected_disposition"] != "speculative_false_positive"
                 else "not_found")
        citations = [] if wrong == "not_found" else [_citation_for(reference)]
        return json.dumps(
            {"disposition": wrong, "citations": citations,
             "rationale": "wrong but well-formed"}
        )

    report = runner.run_calibration(corpus, _judge, "fake", "http://x", sleep=_NO_SLEEP)
    assert report["agreement_rate"] == 0.0
    assert set(attempts_seen) == {0}


def test_failure_excerpt_is_bounded(corpus: dict) -> None:
    def _judge(messages: list[dict], attempt: int = 0) -> str:
        return "x" * 5000

    report = runner.run_calibration(corpus, _judge, "fake", "http://x", sleep=_NO_SLEEP)
    assert report["failures"]
    for row in report["failures"]:
        assert len(row["judge_raw_excerpt"]) <= 300


def test_run_calibration_requires_no_network(corpus: dict) -> None:
    # Sanity: the module imports without ever importing transport eagerly.
    assert not hasattr(runner, "_REQUESTED")
    # grade_reference / run_calibration never touch the network path.
    report = runner.run_calibration(corpus, _judge_from(corpus), "m", "u", sleep=_NO_SLEEP)
    assert report["base_url"] == "u"


def test_main_rejects_missing_judge_args(tmp_path: Path) -> None:
    assert runner.main(["--corpus", str(CORPUS_PATH)]) == 2


def test_main_rejects_invalid_corpus(tmp_path: Path) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"version": 1, "scenarios": []}), encoding="utf-8")
    assert runner.main(
        ["--corpus", str(bad), "--judge-model", "m", "--base-url", "http://x"]
    ) == 2
