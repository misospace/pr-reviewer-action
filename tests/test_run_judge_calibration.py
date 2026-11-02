"""Tests for scripts/run_judge_calibration.py (#661 judge offline gate).

No network: ``run_calibration`` is exercised with injected fake ``judge_call``
functions against the REAL calibration corpus file. The production transport
(``_openai_judge_call``) is never invoked here.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import pytest  # noqa: E402

from pr_reviewer import semantic_judge  # noqa: E402
from pr_reviewer.http_safe import base_url_identity_digest  # noqa: E402
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
        "judge_prompt_version", "judge_model", "base_url", "base_url_sha256",
        "total", "passed",
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
    report = runner.run_calibration(
        corpus, _judge_from(corpus), "m", "http://x", sleep=_NO_SLEEP
    )
    assert report["base_url"] == "http://x"


def test_report_redacts_userinfo_in_base_url(corpus: dict) -> None:
    """#1414: a judge endpoint carrying a credential in its userinfo must
    never be written verbatim into the shared report. The report keeps the
    redacted display form, and #1424 binds the credential-free endpoint
    identity: the digest is computed over the URL with the userinfo
    stripped, so the credential cannot be tested offline from the artifact."""
    secret_url = "https://judge-operator:hunter2@judge.internal.example/v1"
    report = runner.run_calibration(
        corpus, _judge_from(corpus), "fake", secret_url, sleep=_NO_SLEEP
    )
    serialized = json.dumps(report)
    for secret in ("hunter2", "judge-operator"):
        assert secret not in serialized
    assert report["base_url"] == "https://***@judge.internal.example/v1"
    assert report["base_url_sha256"] == hashlib.sha256(
        b"https://judge.internal.example/v1"
    ).hexdigest()
    assert report["base_url_sha256"] == base_url_identity_digest(
        "https://judge.internal.example/v1"
    )
    # The full credential-bearing URL is never the recorded identity.
    assert report["base_url_sha256"] != hashlib.sha256(
        secret_url.encode("utf-8")
    ).hexdigest()


def test_report_digest_does_not_change_when_credential_rotates(corpus: dict) -> None:
    """#1424: the artifact binds the endpoint, not the credential. Two
    calibration runs against the same endpoint with different userinfo
    credentials record the same endpoint identity, and that identity equals
    the credential-free digest — a credential rotation must not invalidate
    the artifact, and a reader must not be able to test passwords against
    the recorded digest."""
    first = runner.run_calibration(
        corpus, _judge_from(corpus), "fake",
        "https://judge-operator:hunter2@judge.internal.example/v1",
        sleep=_NO_SLEEP,
    )
    second = runner.run_calibration(
        corpus, _judge_from(corpus), "fake",
        "https://judge-operator:newpw@judge.internal.example/v1",
        sleep=_NO_SLEEP,
    )
    assert first["base_url_sha256"] == second["base_url_sha256"]
    assert first["base_url_sha256"] == base_url_identity_digest(
        "https://judge.internal.example/v1"
    )


def test_main_records_the_resolved_credential_free_endpoint(
    corpus: dict, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#1424: the shared artifact a CLI run writes records the resolved
    credential-free endpoint. The credential-bearing endpoint URL comes from
    the environment (#1414); the report's display field carries no userinfo,
    and its digest is the credential-free identity — byte-verifiable against
    the recorded display URL."""
    monkeypatch.delenv("JUDGE_API_KEY", raising=False)
    monkeypatch.setenv(
        "JUDGE_BASE_URL", "https://judge-operator:hunter2@judge.internal.example/v1"
    )
    monkeypatch.setattr(
        runner, "_openai_judge_call", lambda *_args, **_kwargs: _judge_from(corpus)
    )
    output = tmp_path / "report.json"
    argv = [
        "--corpus", str(CORPUS_PATH), "--judge-model", "m", "--output", str(output)
    ]
    assert runner.main(argv) == 0
    report = json.loads(output.read_text(encoding="utf-8"))
    serialized = json.dumps(report)
    for secret in ("hunter2", "judge-operator"):
        assert secret not in serialized
    assert report["base_url"] == "https://judge.internal.example/v1"
    assert report["base_url_sha256"] == base_url_identity_digest(
        "https://judge.internal.example/v1"
    )
    # Operator-verifiable: the digest covers the recorded display URL.
    assert report["base_url_sha256"] == hashlib.sha256(
        report["base_url"].encode("utf-8")
    ).hexdigest()


def test_main_rejects_missing_judge_args(tmp_path: Path) -> None:
    assert runner.main(["--corpus", str(CORPUS_PATH)]) == 2


def test_main_warns_when_the_endpoint_path_may_carry_a_credential(
    corpus: dict, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """#1429: a credential can ride in the endpoint path, and a path segment
    cannot be verified as credential-free, so the runner warns before the
    shared report is written — without echoing the URL."""
    monkeypatch.delenv("JUDGE_API_KEY", raising=False)
    monkeypatch.setenv(
        "JUDGE_BASE_URL",
        "https://judge.internal.example/7f3a9c1e55b20d84aa613c9f02bb71d6/v1",
    )
    monkeypatch.setattr(
        runner, "_openai_judge_call", lambda *_args, **_kwargs: _judge_from(corpus)
    )
    output = tmp_path / "report.json"
    assert runner.main([
        "--corpus", str(CORPUS_PATH), "--judge-model", "m", "--output", str(output)
    ]) == 0
    err = capsys.readouterr().err
    assert "Warning: the judge endpoint path carries a segment" in err
    assert "7f3a9c1e55b20d84aa613c9f02bb71d6" not in err
    assert "judge.internal.example" not in err
    # The recording itself is unchanged: the resolved endpoint (path kept) is
    # recorded verbatim and bound by the digest.
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["base_url"] == (
        "https://judge.internal.example/7f3a9c1e55b20d84aa613c9f02bb71d6/v1"
    )
    assert report["base_url_sha256"] == base_url_identity_digest(
        "https://judge.internal.example/7f3a9c1e55b20d84aa613c9f02bb71d6/v1"
    )


def test_main_does_not_warn_on_an_ordinary_endpoint_path(
    corpus: dict, monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.delenv("JUDGE_API_KEY", raising=False)
    monkeypatch.setenv("JUDGE_BASE_URL", "https://judge.internal.example/v1")
    monkeypatch.setattr(
        runner, "_openai_judge_call", lambda *_args, **_kwargs: _judge_from(corpus)
    )
    assert runner.main(["--corpus", str(CORPUS_PATH), "--judge-model", "m"]) == 0
    assert "Warning" not in capsys.readouterr().err


def test_main_rejects_invalid_corpus(tmp_path: Path) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"version": 1, "scenarios": []}), encoding="utf-8")
    assert runner.main(
        ["--corpus", str(bad), "--judge-model", "m", "--base-url", "http://x"]
    ) == 2


# ── credential-free argv (#1413) ────────────────────────────────────────────

_SECRET = "sk-secret-value"


def _no_transport(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the judge transport unreachable: a refusal must precede it."""

    def _boom(*_args, **_kwargs):
        raise AssertionError("the judge transport must not be reached")

    monkeypatch.setattr(runner, "_openai_judge_call", _boom)


def _run_argv(extra: list[str]) -> list[str]:
    """An otherwise valid run, plus the argument under test."""
    return [
        "--corpus", str(CORPUS_PATH),
        "--judge-model", "m", "--base-url", "http://x",
        *extra,
    ]


def test_api_key_argument_is_refused_without_echo(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    _no_transport(monkeypatch)
    code = runner.main(_run_argv(["--api-key", _SECRET]))
    err = capsys.readouterr().err
    assert code == 2
    assert _SECRET not in err
    assert "--api-key" in err


def test_api_key_equals_form_is_refused_without_echo(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    _no_transport(monkeypatch)
    code = runner.main(_run_argv([f"--api-key={_SECRET}"]))
    err = capsys.readouterr().err
    assert code == 2
    assert _SECRET not in err
    assert "--api-key" in err


def test_api_key_abbreviation_is_refused_without_echo(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    _no_transport(monkeypatch)
    code = runner.main(_run_argv(["--api-k", _SECRET]))
    err = capsys.readouterr().err
    assert code == 2
    assert _SECRET not in err
    assert "--api-key" in err


def test_unknown_argument_is_refused_without_echo(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    _no_transport(monkeypatch)
    code = runner.main(_run_argv(["--mystery-flag", _SECRET]))
    err = capsys.readouterr().err
    assert code == 2
    assert _SECRET not in err
    assert "unrecognized argument" in err


def test_judge_key_comes_from_the_environment(
    corpus: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("JUDGE_API_KEY", "env-key-value")
    recorded: list[str] = []

    def _fake_judge_call(
        judge_model: str, base_url: str, api_key: str, timeout_sec: int
    ):
        recorded.append(api_key)
        return _judge_from(corpus)

    monkeypatch.setattr(runner, "_openai_judge_call", _fake_judge_call)
    assert runner.main(_run_argv([])) == 0
    assert recorded == ["env-key-value"]


def test_credential_refusal_comes_before_the_parser(
    capsys: pytest.CaptureFixture[str],
) -> None:
    # The refusal runs before argparse, so no parser message can quote a value.
    code = runner.main(["--api-key", _SECRET])
    err = capsys.readouterr().err
    assert code == 2
    assert _SECRET not in err
    assert "--api-key" in err


def test_a_value_for_a_known_option_is_not_echoed(
    capsys: pytest.CaptureFixture[str],
) -> None:
    # argparse quotes the value of an option in its own error message. The
    # parser of this script must not, so a mistyped secret stays out of the log.
    with pytest.raises(SystemExit) as excinfo:
        runner.main(_run_argv(["--timeout", _SECRET]))
    assert excinfo.value.code == 2
    err = capsys.readouterr().err
    assert _SECRET not in err


def test_the_parser_knows_no_credential_option() -> None:
    # The parser must not know the option, so the refusal is the only way in.
    _args, extras = runner.build_parser().parse_known_args(["--api-key", _SECRET])
    assert "--api-key" in extras


def test_main_refuses_a_credential_bearing_endpoint_with_another_key(
    monkeypatch, capsys,
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
    code = runner.main([
        "--corpus", str(CORPUS_PATH),
        "--judge-model", "m",
    ])
    err = capsys.readouterr().err
    assert code == 2
    assert "one credential channel" in err
    assert "hunter2" not in err
    assert "judge-operator" not in err


@pytest.mark.parametrize(
    "base_url",
    [
        "not-a-url",
        # An ENCODED '@' hides the credential from the authority split while
        # urllib unquotes the authority into the request's Host value.
        "http://judge-operator%3Ahunter2%40127.0.0.1/v1",
    ],
)
def test_main_refuses_an_unusable_endpoint_url(base_url: str, capsys) -> None:
    code = runner.main([
        "--corpus", str(CORPUS_PATH),
        "--judge-model", "m",
        "--base-url", base_url,
    ])
    err = capsys.readouterr().err
    assert code == 2
    assert "hunter2" not in err
    assert "judge-operator" not in err


def test_main_refuses_a_credential_bearing_base_url_from_the_command_line(
    tmp_path: Path, capsys
) -> None:
    """#1414: a credential in an argument list is readable by every other
    process on the host, so a credential-bearing base URL is accepted from
    JUDGE_BASE_URL only. The refusal never echoes the credential.

    The corpus is an empty one on purpose: when the refusal stops firing,
    the run must fail on the corpus instead of reaching the network."""
    corpus = tmp_path / "empty.json"
    corpus.write_text(json.dumps({"version": 1, "scenarios": []}), encoding="utf-8")
    code = runner.main([
        "--corpus", str(corpus),
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
        # #1413 disables argparse abbreviations entirely. These forms are
        # rejected by the value-safe unknown-argument guard before URL parsing.
        (
            ["--base", "http://judge-operator:hunter2@127.0.0.1:1/v1"],
            "unrecognized argument",
        ),
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
    corpus = tmp_path / "empty.json"
    corpus.write_text(json.dumps({"version": 1, "scenarios": []}), encoding="utf-8")
    code = runner.main([
        "--corpus", str(corpus),
        "--judge-model", "m",
        *arguments,
    ])
    err = capsys.readouterr().err
    assert code == 2
    assert expected_refusal in err
    assert "hunter2" not in err
    assert "judge-operator" not in err

def test_main_takes_a_credential_bearing_base_url_from_the_environment(
    monkeypatch,
) -> None:
    """#1414: the environment is the channel that may carry the credential.
    The runner uses that endpoint and splits the credential out of the URL,
    so the request target carries no secret."""
    monkeypatch.delenv("JUDGE_API_KEY", raising=False)
    monkeypatch.setenv(
        "JUDGE_BASE_URL", "http://judge-operator:hunter2@127.0.0.1:1/v1"
    )
    captured: dict = {}

    class _Stop(BaseException):
        """Stop the run right after the transport is built."""

    def _fake_call(judge_model, endpoint, api_key, timeout_sec):
        captured["url"] = endpoint.url
        captured["credential"] = endpoint.credential
        raise _Stop()

    monkeypatch.setattr(runner, "_openai_judge_call", _fake_call)
    with pytest.raises(_Stop):
        runner.main(["--corpus", str(CORPUS_PATH), "--judge-model", "m"])
    assert captured["url"] == "http://127.0.0.1:1/v1"
    assert captured["credential"] == "judge-operator:hunter2"
