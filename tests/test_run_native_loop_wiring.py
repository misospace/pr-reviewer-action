"""Integration test for run_tool_harness.run_native_loop (#203).

Exercises the corpus → Conversation → driver → output-file path with a
scripted transport (run_chat_request monkeypatched), and the degradation
path that writes nothing so the caller falls back to the planner.
"""

import json
import os
import sys
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import run_tool_harness as rth  # noqa: E402


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


def _run(monkeypatch, tmp_path, responses):
    """Run run_native_loop in tmp_path with a scripted transport; return result dict."""
    queue = list(responses)

    def fake_request(base_url, api_format, payload, api_key, timeout_sec):
        assert queue, "model called more times than scripted"
        return queue.pop(0)

    monkeypatch.setattr(rth, "run_chat_request", fake_request)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("EFFECTIVE_SCOPE", "full")

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
        4,  # max_requests
        45,  # planning_timeout
        400,  # planning_max_tokens
        result,
    )
    return handled, result


def test_native_loop_two_hops_writes_outputs(monkeypatch, tmp_path):
    # Two offline hops: read the machineconfig (carries the platform version),
    # then read the manifest it points at. No network — the executor runs for
    # real, so the output must reflect the actual file contents.
    (tmp_path / "machineconfig.yaml.j2").write_text(
        "install: factory.talos.dev/installer:v1.13.4\n", encoding="utf-8"
    )
    (tmp_path / "kubernetesupgrade.yaml").write_text(
        "kubeletVersion: v1.36.2\n", encoding="utf-8"
    )
    handled, result = _run(
        monkeypatch,
        tmp_path,
        [
            _openai_call("c1", "read_file", '{"path": "machineconfig.yaml.j2"}'),
            _openai_call("c2", "read_file", '{"path": "kubernetesupgrade.yaml"}'),
            _openai_text("Talos v1.13.4 with k8s v1.36.2."),
        ],
    )
    assert handled is True
    assert result["mode"] == "native_loop"
    assert result["stop_reason"] == "model-stopped"
    assert result["planned_request_count"] == 2

    harness = json.loads((tmp_path / "tool-harness.json").read_text())
    assert harness["mode"] == "native_loop"
    assert harness["rounds"] == 3
    assert harness["executed_request_count"] == 2

    md = (tmp_path / "tool-harness.md").read_text()
    assert "read_file" in md
    assert "Evidence summary" in md
    # Both reads must reflect the real files the executor read.
    assert "v1.13.4" in md
    assert "v1.36.2" in md


def _make_sse_line(data):
    return f"data: {json.dumps(data)}"


def test_run_chat_request_streams_and_reassembles(monkeypatch):
    """A streamed payload sends --no-buffer and the SSE body is reassembled
    into the non-streaming response shape the loop driver parses (#204)."""
    import types

    sse = "\n".join(
        [
            _make_sse_line(
                {
                    "id": "c1",
                    "model": "m",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "role": "assistant",
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call_abc",
                                        "type": "function",
                                        "function": {
                                            "name": "read_file",
                                            "arguments": '{"path":',
                                        },
                                    }
                                ],
                            },
                        }
                    ],
                }
            ),
            _make_sse_line(
                {
                    "id": "c1",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "function": {"arguments": ' "a.txt"}'},
                                    }
                                ]
                            },
                        }
                    ],
                }
            ),
            _make_sse_line(
                {
                    "id": "c1",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                }
            ),
            "data: [DONE]",
        ]
    )

    captured = {}

    def fake_safe_run(args, timeout_sec):
        captured["args"] = args
        return types.SimpleNamespace(returncode=0, stdout=sse, stderr="")

    monkeypatch.setattr(rth, "safe_run", fake_safe_run)

    payload = {"model": "m", "stream": True, "stream_options": {"include_usage": True}}
    parsed = rth.run_chat_request("http://model.local/v1", "openai", payload, "", 30)

    assert "--no-buffer" in captured["args"]
    msg = parsed["choices"][0]["message"]
    assert parsed["choices"][0]["finish_reason"] == "tool_calls"
    assert msg["tool_calls"][0]["function"]["name"] == "read_file"
    # arguments reassembled across deltas, kept as a JSON string (#233 contract)
    assert msg["tool_calls"][0]["function"]["arguments"] == '{"path": "a.txt"}'


def test_native_loop_falls_back_to_non_streamed_turn(monkeypatch, tmp_path):
    """A streamed turn that can't be reassembled is retried non-streamed,
    covering both triggers: a 200 error body and a transport raise (#204)."""
    monkeypatch.setenv("AI_STREAM", "true")
    monkeypatch.setenv("EFFECTIVE_SCOPE", "full")
    monkeypatch.chdir(tmp_path)
    (tmp_path / "machineconfig.yaml.j2").write_text(
        "install: factory.talos.dev/installer:v1.13.4\n", encoding="utf-8"
    )

    seen = []
    fallback_payloads = []

    def fake_request(base_url, api_format, payload, api_key, timeout_sec):
        streamed = bool(payload.get("stream"))
        seen.append(streamed)
        if streamed:
            # Turn 1 streamed → garbled 200 error body; turn 2 streamed → raise.
            if sum(1 for s in seen if s) == 1:
                return {"error": {"message": "garbled stream"}}
            raise RuntimeError("connection reset mid-stream")
        fallback_payloads.append(payload)
        # Non-streamed fallback: turn 1 reads the machineconfig, turn 2 stops.
        if len(fallback_payloads) == 1:
            return _openai_call("c1", "read_file", '{"path": "machineconfig.yaml.j2"}')
        return _openai_text("Reviewed via non-streamed fallback.")

    monkeypatch.setattr(rth, "run_chat_request", fake_request)

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
    # Both fallback triggers fired (error body then raise), each retried
    # non-streamed, and the tool call executed for real on the fallback turn.
    assert handled is True
    assert result["mode"] == "native_loop"
    assert result["planned_request_count"] == 1
    assert seen == [True, False, True, False]
    # The non-streamed fallback request drops the streaming-only stream_options.
    assert all("stream_options" not in p and p["stream"] is False for p in fallback_payloads)


def test_native_loop_degrades_writes_nothing(monkeypatch, tmp_path):
    handled, result = _run(
        monkeypatch,
        tmp_path,
        [_openai_text("Looks like a routine patch bump, approve.")],
    )
    assert handled is False
    assert result["native_loop_degraded"] == "no-tool-calls"
    # No output files: the caller (main) falls through to the planner path.
    assert not (tmp_path / "tool-harness.json").exists()
    assert not (tmp_path / "tool-harness.md").exists()
