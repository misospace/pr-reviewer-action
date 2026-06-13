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
