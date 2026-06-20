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
from pr_reviewer import transport  # noqa: E402


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

    # Cross-run evidence memory: the loop's closing summary becomes the digest
    # carried into tool-harness.json (which run_review.sh folds into the marker).
    assert result["evidence_digest"] == "Talos v1.13.4 with k8s v1.36.2."
    assert harness["evidence_digest"] == "Talos v1.13.4 with k8s v1.36.2."


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

    # safe_run + run_chat_request live in pr_reviewer.transport (#304 split);
    # run_chat_request calls the module-local safe_run, so patch it there.
    monkeypatch.setattr(transport, "safe_run", fake_safe_run)

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


def _capture_summarize_fn(monkeypatch, tmp_path, *, enabled):
    """Run run_native_loop with drive_tool_loop stubbed to capture the
    summarize_fn kwarg, so we can assert the result-summarization wiring
    without forcing a real 24k-token conversation overflow."""
    import pr_reviewer.tool_loop as tl

    captured = {}

    def fake_drive(conversation, post_fn, execute_fn, **kwargs):
        captured["summarize_fn"] = kwargs.get("summarize_fn")
        out = tl.LoopOutcome()
        out.degraded = True
        out.stop_reason = "no-tool-calls"
        return out

    monkeypatch.setattr(tl, "drive_tool_loop", fake_drive)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("EFFECTIVE_SCOPE", "full")
    if enabled:
        monkeypatch.setenv("TOOL_LOOP_SUMMARIZE", "true")
    else:
        monkeypatch.delenv("TOOL_LOOP_SUMMARIZE", raising=False)
    result = {
        "mode": "plan_execute_once",
        "planned_request_count": 0,
        "executed_request_count": 0,
        "tool_results": [],
    }
    handled = rth.run_native_loop(
        "owner/repo", "http://model.local/v1", "openai", "mock-model", "key",
        "# PR Corpus\nbumps kubelet image",
        {"owner/repo"}, ["talos.dev"], str(tmp_path),
        12000, 15, 4, 45, 400, result,
    )
    assert handled is False  # the stub degraded
    return captured["summarize_fn"]


def test_summarize_fn_wired_when_enabled(monkeypatch, tmp_path):
    summarize_fn = _capture_summarize_fn(monkeypatch, tmp_path, enabled=True)
    assert callable(summarize_fn)


def test_summarize_fn_absent_by_default(monkeypatch, tmp_path):
    summarize_fn = _capture_summarize_fn(monkeypatch, tmp_path, enabled=False)
    assert summarize_fn is None


def _openai_text_with_usage(text, *, prompt, completion, cached=0):
    resp = _openai_text(text)
    resp["usage"] = {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "prompt_tokens_details": {"cached_tokens": cached},
    }
    return resp


def test_native_loop_degrade_records_native_usage(monkeypatch, tmp_path):
    """A turn that burns tokens then declines tools still records its spend.

    Before the fix the no-tool-calls degrade returned without stamping usage,
    so the (real) cost of the reasoning turn that declined tools vanished and
    the fallback's plan_execute mode carried no record of it.
    """
    handled, result = _run(
        monkeypatch,
        tmp_path,
        [_openai_text_with_usage(
            "Approve.", prompt=1000, completion=400, cached=600
        )],
    )
    assert handled is False
    assert result["native_loop_degraded"] == "no-tool-calls"
    usage = result["native_loop_usage"]
    assert usage["prompt_tokens"] == 1000
    assert usage["completion_tokens"] == 400
    assert usage["cached_prompt_tokens"] == 600
    assert usage["cache_hit_ratio"] == 0.6


def test_native_loop_request_error_records_usage_and_error(monkeypatch, tmp_path):
    """A first-turn transport error degrades to the planner, but the native
    attempt's stop reason + (zeroed) usage are still recorded — no silent
    'mode present, usage absent' tool-harness.json."""
    def boom(base_url, api_format, payload, api_key, timeout_sec):
        raise RuntimeError("upstream 524")

    monkeypatch.setattr(rth, "run_chat_request", boom)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("EFFECTIVE_SCOPE", "full")
    monkeypatch.setenv("AI_STREAM", "false")
    result = {
        "mode": "plan_execute_once",
        "planned_request_count": 0,
        "executed_request_count": 0,
        "tool_results": [],
    }
    handled = rth.run_native_loop(
        "owner/repo", "http://model.local/v1", "openai", "mock-model", "key",
        "# PR Corpus\nbumps kubelet image",
        {"owner/repo"}, ["talos.dev"], str(tmp_path),
        12000, 15, 4, 45, 400, result,
    )
    assert handled is False
    assert result["native_loop_degraded"] == "request-error"
    assert "upstream 524" in result["native_loop_error"]
    # Usage block is present (zeroed — the request never returned a body).
    assert result["native_loop_usage"]["prompt_tokens"] == 0
    assert result["native_loop_usage"]["cache_hit_ratio"] == 0.0


def _run_capturing(monkeypatch, tmp_path, api_format, responses):
    """Like _run but records every payload sent, for the verdict-turn tests."""
    queue = list(responses)
    payloads = []

    def fake_request(base_url, fmt, payload, api_key, timeout_sec):
        payloads.append(payload)
        assert queue, "model called more times than scripted"
        return queue.pop(0)

    monkeypatch.setattr(rth, "run_chat_request", fake_request)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("EFFECTIVE_SCOPE", "full")
    monkeypatch.setenv("AI_STREAM", "false")
    result = {
        "mode": "plan_execute_once",
        "planned_request_count": 0,
        "executed_request_count": 0,
        "tool_results": [],
    }
    handled = rth.run_native_loop(
        "owner/repo", "http://model.local/v1", api_format, "mock-model", "key",
        "# PR Corpus\nbumps kubelet image in machineconfig.yaml.j2",
        {"owner/repo"}, ["talos.dev"], str(tmp_path),
        12000, 15, 4, 45, 400, result,
    )
    return handled, result, payloads


def test_native_loop_emits_in_conversation_verdict(monkeypatch, tmp_path):
    """#205: after gathering evidence the loop produces the verdict itself —
    drops tools, forces strict JSON, re-injects the full corpus, and writes the
    response where the standard review call would (run_review.sh consumes it)."""
    monkeypatch.setenv("AI_RESPONSE_FORMAT", "json_object")
    (tmp_path / "review-corpus.truncated.md").write_text(
        "# Full corpus\nthe complete unified diff lives here\n", encoding="utf-8"
    )
    (tmp_path / "machineconfig.yaml.j2").write_text(
        "install: factory.talos.dev/installer:v1.13.4\n", encoding="utf-8"
    )
    verdict_json = '{"verdict": "approve", "review_markdown": "LGTM", "findings": []}'
    handled, result, payloads = _run_capturing(
        monkeypatch, tmp_path, "openai",
        [
            _openai_call("c1", "read_file", '{"path": "machineconfig.yaml.j2"}'),
            _openai_text("Evidence gathered: Talos v1.13.4."),  # ends the loop
            {"choices": [{"finish_reason": "stop", "message": {"content": verdict_json}}]},
        ],
    )
    assert handled is True
    assert result.get("native_loop_verdict_produced") is True

    # Written where the standard primary review call writes its response.
    resp = json.loads((tmp_path / "ai-response.primary.json").read_text())
    assert "approve" in resp["choices"][0]["message"]["content"]

    # The verdict turn (final call) dropped tools, forced strict JSON, and
    # re-injected the full corpus the loop never saw on a closing user turn.
    verdict_payload = payloads[-1]
    assert "tools" not in verdict_payload
    assert verdict_payload.get("response_format", {}).get("type") == "json_object"
    user_text = "\n".join(
        m.get("content") or "" for m in verdict_payload["messages"] if m["role"] == "user"
    )
    assert "the complete unified diff lives here" in user_text


def test_native_loop_skips_verdict_for_anthropic(monkeypatch, tmp_path):
    """Anthropic native_loop keeps the standard corpus review: a verdict turn
    after trailing tool_result (user-role) blocks would make adjacent user
    turns (a 400). No verdict is produced and no primary response is written."""
    (tmp_path / "review-corpus.truncated.md").write_text("# Full corpus\n", encoding="utf-8")
    (tmp_path / "machineconfig.yaml.j2").write_text("install: v1.13.4\n", encoding="utf-8")
    handled, result, payloads = _run_capturing(
        monkeypatch, tmp_path, "anthropic",
        [
            {"content": [{"type": "tool_use", "id": "c1", "name": "read_file",
                          "input": {"path": "machineconfig.yaml.j2"}}],
             "stop_reason": "tool_use"},
            {"content": [{"type": "text", "text": "done"}], "stop_reason": "end_turn"},
        ],
    )
    assert handled is True
    assert result.get("native_loop_verdict_produced") is not True
    assert not (tmp_path / "ai-response.primary.json").exists()


def _openai_system(payload):
    return next((m["content"] for m in payload["messages"] if m["role"] == "system"), None)


def test_native_loop_system_is_stable_across_verdict_turn(monkeypatch, tmp_path):
    """Prompt-cache preservation (#263): one unified reviewer+tools system for the
    whole review — the verdict turn must NOT swap it, or llama.cpp/OpenAI lose the
    cached prefix at token 0. Every turn (loop + verdict) carries the same system,
    and it includes the tool-use preamble."""
    (tmp_path / "review-corpus.truncated.md").write_text("# corpus\nfull diff\n", encoding="utf-8")
    (tmp_path / "machineconfig.yaml.j2").write_text("install: v1.13.4\n", encoding="utf-8")
    verdict_json = '{"verdict": "approve", "review_markdown": "ok", "findings": []}'
    handled, result, payloads = _run_capturing(
        monkeypatch, tmp_path, "openai",
        [
            _openai_call("c1", "read_file", '{"path": "machineconfig.yaml.j2"}'),
            _openai_text("done"),  # ends the loop
            {"choices": [{"finish_reason": "stop", "message": {"content": verdict_json}}]},
        ],
    )
    assert handled is True
    assert result.get("native_loop_verdict_produced") is True
    systems = [_openai_system(p) for p in payloads]
    # Loop turns and the verdict turn all share one stable system (no swap).
    assert systems[0] is not None
    assert len(set(systems)) == 1
    assert "Gathering evidence with tools" in systems[0]


def test_native_loop_honors_max_completion_tokens(monkeypatch, tmp_path):
    """AI_TOKENS_PARAM=max_completion_tokens must reach every native_loop request
    — the loop turns and the verdict turn — for parity with the bash review path
    (newer OpenAI models reject max_tokens)."""
    monkeypatch.setenv("AI_TOKENS_PARAM", "max_completion_tokens")
    (tmp_path / "review-corpus.truncated.md").write_text("# corpus\n", encoding="utf-8")
    (tmp_path / "machineconfig.yaml.j2").write_text("install: v1.13.4\n", encoding="utf-8")
    verdict_json = '{"verdict": "approve", "review_markdown": "ok", "findings": []}'
    handled, _result, payloads = _run_capturing(
        monkeypatch, tmp_path, "openai",
        [
            _openai_call("c1", "read_file", '{"path": "machineconfig.yaml.j2"}'),
            _openai_text("done"),  # ends the loop
            {"choices": [{"finish_reason": "stop", "message": {"content": verdict_json}}]},
        ],
    )
    assert handled is True
    assert len(payloads) >= 2  # loop turn(s) + the verdict turn
    for payload in payloads:
        assert "max_completion_tokens" in payload
        assert "max_tokens" not in payload


def test_native_loop_accumulates_token_usage(monkeypatch, tmp_path):
    """Token/cost telemetry: per-turn usage (loop + verdict) is summed into
    result['usage'], including cached prompt tokens → cache_hit_ratio."""
    (tmp_path / "review-corpus.truncated.md").write_text("# corpus\n", encoding="utf-8")
    (tmp_path / "machineconfig.yaml.j2").write_text("install: v1.13.4\n", encoding="utf-8")

    def with_usage(resp, p, c, cached):
        resp["usage"] = {"prompt_tokens": p, "completion_tokens": c,
                         "prompt_tokens_details": {"cached_tokens": cached}}
        return resp

    verdict = {"choices": [{"finish_reason": "stop",
               "message": {"content": '{"verdict":"approve","review_markdown":"ok","findings":[]}'}}]}
    handled, result, _ = _run_capturing(
        monkeypatch, tmp_path, "openai",
        [
            with_usage(_openai_call("c1", "read_file", '{"path": "machineconfig.yaml.j2"}'), 100, 20, 40),
            with_usage(_openai_text("done"), 150, 10, 120),
            with_usage(verdict, 200, 30, 180),
        ],
    )
    assert handled is True
    u = result["usage"]
    assert u["requests"] == 3
    assert u["prompt_tokens"] == 450
    assert u["completion_tokens"] == 60
    assert u["cached_prompt_tokens"] == 340
    assert u["cache_hit_ratio"] == round(340 / 450, 3)


def test_native_loop_advertises_and_routes_mcp_tool(monkeypatch, tmp_path):
    """#245: an allowlisted read-only MCP tool is advertised in the loop request
    and routed to the MCP client; its result folds into the harness output."""
    import pr_reviewer.mcp_client as mcp

    monkeypatch.setenv("TOOL_MCP_SERVERS", "konflate=http://x/mcp")
    tools = [{"name": "get_pr_diff", "description": "rendered diff",
              "inputSchema": {"type": "object", "properties": {"number": {"type": "integer"}}}}]

    def mcp_post(url, payload, session_id, token, timeout):
        method = payload.get("method")
        if method == "initialize":
            return {"result": {"capabilities": {}}}, "s1", None
        if method == "tools/list":
            return {"result": {"tools": tools}}, session_id, None
        if method == "tools/call":
            return ({"result": {"content": [{"type": "text", "text": "version: v1.36.1 -> v1.36.2"}]}},
                    session_id, None)
        return None, session_id, None

    monkeypatch.setattr(mcp, "_default_post", mcp_post)
    handled, result, payloads = _run_capturing(
        monkeypatch, tmp_path, "openai",
        [
            _openai_call("c1", "mcp__konflate__get_pr_diff", '{"number": 7462}'),
            _openai_text("done"),
        ],
    )
    assert handled is True
    # advertised in the (first) loop request
    advertised = [t["function"]["name"] for t in payloads[0]["tools"]]
    assert "mcp__konflate__get_pr_diff" in advertised
    # executed + folded into the harness trace
    harness = json.loads((tmp_path / "tool-harness.json").read_text())
    mcp_calls = [tc for tc in harness.get("tool_calls", []) if tc["tool"] == "mcp__konflate__get_pr_diff"]
    assert mcp_calls and mcp_calls[0]["status"] == "ok"
