"""Native-loop verdict recovery regression suite (#637).

The in-conversation verdict (#205) writes ``ai-response.primary.json`` and sets
``native_loop_verdict_produced`` so ``review.sh`` can skip the separate full
review call. Before #637 the harness claimed success unconditionally, so a
streamed verdict that reassembled into an unusable body forced review.sh to fall
back AFTER paying for the failed native attempt — the run then paid for both an
in-conversation verdict and a full-corpus final synthesis.

These tests pin the corrected lifecycle:

* valid streamed verdict → existing fast path (one attempt, no retry);
* unusable streamed verdict + valid non-streamed retry → the retry is consumed
  as the native verdict (no redundant full synthesis);
* unusable streamed verdict + malformed retry → no success flag, standard
  fallback is left to run;
* a non-reusable artifact is never reported as produced, and a produced flag
  always implies a parseable artifact;
* telemetry distinguishes tool rounds, verdict attempts/retries, and the
  fallback path, and labels transport/reassembly failure separately from
  verdict-schema/parse/validation failure.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import run_tool_harness as rth  # noqa: E402
from pr_reviewer.response_parser import parse_response  # noqa: E402

_VALID_VERDICT = '{"verdict": "approve", "review_markdown": "LGTM", "findings": []}'
# A body that reassembles cleanly but violates the verdict contract (no
# ``review_markdown``) — a verdict-schema failure, not a transport failure.
_CONTRACT_BROKEN = '{"verdict": "approve"}'
_GARBAGE = "I reviewed the diff but forgot the JSON envelope."


def _openai_call(call_id, name, args):
    return {
        "choices": [
            {
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": args},
                        }
                    ],
                },
            }
        ]
    }


def _openai_text(text):
    return {"choices": [{"finish_reason": "stop", "message": {"content": text}}]}


def _run_verdict(monkeypatch, tmp_path, responses, *, stream=True):
    """Run run_native_loop with a scripted transport and a live verdict corpus.

    Returns ``(handled, result, payloads, stderr)``. ``stderr`` is captured so
    tests can assert the specific rejection diagnostic.
    """
    queue = list(responses)
    payloads = []

    def fake_request(base_url, api_format, payload, api_key, timeout_sec):
        payloads.append(payload)
        assert queue, "model called more times than scripted"
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr(rth, "run_chat_request", fake_request)
    tmp_path.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("AI_STREAM", "true" if stream else "false")
    monkeypatch.setenv("AI_RESPONSE_FORMAT", "json_object")

    (tmp_path / "review-corpus.truncated.md").write_text(
        "# Full corpus\nthe complete unified diff lives here\n", encoding="utf-8"
    )
    (tmp_path / "machineconfig.yaml.j2").write_text(
        "install: factory.talos.dev/installer:v1.13.4\n", encoding="utf-8"
    )

    result = {
        "mode": "plan_execute_once",
        "planned_request_count": 0,
        "executed_request_count": 0,
        "tool_results": [],
    }
    handled = rth.run_native_loop(
        "owner/repo",
        "http://model.local/v1",
        "openai",
        "mock-model",
        "key",
        "# PR Corpus\nbumps kubelet image in machineconfig.yaml.j2",
        {"owner/repo"},
        ["talos.dev"],
        str(tmp_path),
        12000,
        15,
        4,
        45,
        400,
        result,
    )
    return handled, result, payloads


def _loop_prefix():
    """Two loop turns: gather evidence, then stop — the verdict turn follows."""
    return [
        _openai_call("c1", "read_file", '{"path": "machineconfig.yaml.j2"}'),
        _openai_text("Evidence gathered: Talos v1.13.4."),
    ]


def _assert_produced_implies_reusable(result, tmp_path):
    """The invariant under test: produced ⟹ a parseable artifact exists (#637)."""
    artifact = tmp_path / "ai-response.primary.json"
    if result.get("native_loop_verdict_produced") is True:
        assert artifact.is_file(), "produced flag set without an artifact"
        parse_response(json.loads(artifact.read_text(encoding="utf-8")))


# ---------------------------------------------------------------------------
# 1. streamed unusable (contract) + valid non-streamed retry → retry consumed
# ---------------------------------------------------------------------------


def test_streamed_unusable_valid_retry_is_consumed(monkeypatch, tmp_path):
    handled, result, payloads = _run_verdict(
        monkeypatch,
        tmp_path,
        _loop_prefix()
        + [
            _openai_text(_CONTRACT_BROKEN),  # streamed verdict: unparsable
            _openai_text(_VALID_VERDICT),  # non-streamed retry: reusable
        ],
    )
    assert handled is True
    # The retry became the native verdict — no redundant full synthesis path.
    assert result.get("native_loop_verdict_produced") is True
    assert result["native_loop_verdict_status"] == "accepted"
    assert result["native_loop_verdict_transport"] == "non-streamed-retry"
    assert result["native_loop_verdict_attempts"] == 2
    assert result["native_loop_verdict_retried"] is True
    assert result["native_loop_verdict_stream_failure"] == "parse"
    _assert_produced_implies_reusable(result, tmp_path)

    # Two loop turns + two verdict attempts; the retry drops stream_options.
    assert len(payloads) == 4
    assert payloads[-2]["stream"] is True
    assert payloads[-1]["stream"] is False
    assert "stream_options" not in payloads[-1]


# ---------------------------------------------------------------------------
# 2. streamed unusable + malformed retry → standard fallback left to run
# ---------------------------------------------------------------------------


def test_streamed_unusable_malformed_retry_falls_back(monkeypatch, tmp_path):
    handled, result, payloads = _run_verdict(
        monkeypatch,
        tmp_path,
        _loop_prefix()
        + [
            _openai_text(_GARBAGE),  # streamed: no JSON
            _openai_text(_CONTRACT_BROKEN),  # retry: schema-broken
        ],
    )
    assert handled is True
    # No reusable verdict → the flag stays unset so review.sh runs the standard
    # final review. The fallback is NOT suppressed.
    assert result.get("native_loop_verdict_produced") is not True
    assert result["native_loop_verdict_status"] == "fallback"
    assert result["native_loop_verdict_reason"] == "parse"
    assert result["native_loop_verdict_attempts"] == 2
    assert result["native_loop_verdict_retried"] is True
    assert len(payloads) == 4


# ---------------------------------------------------------------------------
# 3. valid streamed verdict → current fast path unchanged (one attempt)
# ---------------------------------------------------------------------------


def test_valid_streamed_verdict_fast_path(monkeypatch, tmp_path):
    handled, result, payloads = _run_verdict(
        monkeypatch,
        tmp_path,
        _loop_prefix() + [_openai_text(_VALID_VERDICT)],
    )
    assert handled is True
    assert result.get("native_loop_verdict_produced") is True
    assert result["native_loop_verdict_status"] == "accepted"
    assert result["native_loop_verdict_transport"] == "streamed"
    assert result["native_loop_verdict_attempts"] == 1
    assert result["native_loop_verdict_retried"] is False
    assert "native_loop_verdict_stream_failure" not in result
    # Exactly one verdict request: no retry on the fast path.
    assert len(payloads) == 3
    assert payloads[-1]["stream"] is True
    _assert_produced_implies_reusable(result, tmp_path)


# ---------------------------------------------------------------------------
# 4. artifact exists but cannot be parsed → explicit diagnostic + fallback
# ---------------------------------------------------------------------------


def test_unparsable_artifact_diagnostic_and_fallback(monkeypatch, tmp_path, capsys):
    handled, result, _payloads = _run_verdict(
        monkeypatch,
        tmp_path,
        _loop_prefix() + [_openai_text(_CONTRACT_BROKEN), _openai_text(_GARBAGE)],
    )
    assert handled is True
    artifact = tmp_path / "ai-response.primary.json"
    assert artifact.is_file(), "the raw response is kept as diagnostic evidence"
    with pytest.raises(SystemExit):
        parse_response(json.loads(artifact.read_text(encoding="utf-8")))

    assert result.get("native_loop_verdict_produced") is not True
    assert result["native_loop_verdict_status"] == "fallback"
    stderr = capsys.readouterr().err
    assert "no reusable in-conversation verdict" in stderr
    assert "the standard review call will synthesize the verdict" in stderr


# ---------------------------------------------------------------------------
# 5. success flag cannot exist without a reusable verdict artifact
# ---------------------------------------------------------------------------


def test_success_flag_requires_reusable_artifact(monkeypatch, tmp_path):
    scenarios = [
        [_openai_text(_VALID_VERDICT)],  # accepted streamed
        [_openai_text(_CONTRACT_BROKEN), _openai_text(_VALID_VERDICT)],  # accepted retry
        [_openai_text(_GARBAGE), _openai_text(_GARBAGE)],  # rejected
        [_openai_text(_CONTRACT_BROKEN), _openai_text(_CONTRACT_BROKEN)],  # rejected
    ]
    for index, verdict_responses in enumerate(scenarios):
        case = tmp_path / f"case{index}"
        case.mkdir()
        _handled, result, _payloads = _run_verdict(
            monkeypatch, case, _loop_prefix() + verdict_responses
        )
        _assert_produced_implies_reusable(result, case)


# ---------------------------------------------------------------------------
# 6. telemetry distinguishes rounds / attempts / retries / fallback transport
# ---------------------------------------------------------------------------


def test_telemetry_distinguishes_rounds_attempts_and_fallback(monkeypatch, tmp_path):
    _handled, result, _payloads = _run_verdict(
        monkeypatch,
        tmp_path,
        _loop_prefix()
        + [_openai_text(_CONTRACT_BROKEN), _openai_text(_VALID_VERDICT)],
    )
    # Tool rounds are distinct from verdict attempts.
    assert result["rounds"] == 2
    assert result["native_loop_verdict_attempts"] == 2
    assert result["native_loop_verdict_retried"] is True
    assert result["native_loop_verdict_status"] == "accepted"


def test_telemetry_separates_transport_from_parse_failure(monkeypatch, tmp_path):
    # Transport/reassembly failure of the streamed attempt...
    _handled, transport_result, _ = _run_verdict(
        monkeypatch,
        tmp_path / "transport",
        _loop_prefix()
        + [RuntimeError("connection reset mid-stream"), _openai_text(_VALID_VERDICT)],
    )
    assert transport_result["native_loop_verdict_stream_failure"] == "transport"
    assert transport_result["native_loop_verdict_transport"] == "non-streamed-retry"

    # ...vs a verdict-schema/parse failure, labeled differently.
    _handled, parse_result, _ = _run_verdict(
        monkeypatch,
        tmp_path / "parse",
        _loop_prefix() + [_openai_text(_CONTRACT_BROKEN), _openai_text(_GARBAGE)],
    )
    assert parse_result["native_loop_verdict_stream_failure"] == "parse"
    assert parse_result["native_loop_verdict_reason"] == "parse"
    assert parse_result["native_loop_verdict_status"] == "fallback"
