"""Tests for pr_reviewer.sse_reassembler."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest import main as unittest_main

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer.sse_reassembler import (
    reassemble_sse,
    reassemble_sse_file,
    reassemble_sse_to_file,
)


def _make_sse_line(data: dict) -> str:
    return f"data: {json.dumps(data)}"


class TestReassembleAnthropic:
    def test_message_start_only(self):
        lines = [
            _make_sse_line({
                "type": "message_start",
                "message": {
                    "id": "msg_123",
                    "model": "claude-3-5-sonnet",
                    "usage": {"input_tokens": 10, "output_tokens": 0},
                },
            }),
        ]
        result = reassemble_sse("\n".join(lines), "anthropic")
        assert result["id"] == "msg_123"
        assert result["model"] == "claude-3-5-sonnet"
        assert result["choices"][0]["message"]["content"] == ""
        assert result["usage"]["prompt_tokens"] == 10

    def test_content_block_delta_text(self):
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "msg_1", "model": "m", "usage": {"input_tokens": 1, "output_tokens": 0}}}),
            _make_sse_line({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello"}}),
            _make_sse_line({"type": "content_block_delta", "delta": {"type": "text_delta", "text": " world"}}),
            _make_sse_line({"type": "message_delta", "delta": {"stop_reason": "end_turn", "usage": {"output_tokens": 5}}}),
        ]
        result = reassemble_sse("\n".join(lines), "anthropic")
        assert result["choices"][0]["message"]["content"] == "Hello world"
        assert result["choices"][0]["finish_reason"] == "end_turn"
        assert result["usage"]["completion_tokens"] == 5

    def test_text_delta_type_text_accepted(self):
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "msg_1", "model": "m", "usage": {"input_tokens": 1, "output_tokens": 0}}}),
            _make_sse_line({"type": "content_block_delta", "delta": {"type": "text", "text": "Hi"}}),
            _make_sse_line({"type": "message_delta", "delta": {"stop_reason": "stop"}}),
        ]
        result = reassemble_sse("\n".join(lines), "anthropic")
        assert result["choices"][0]["message"]["content"] == "Hi"

    def test_thinking_delta_ignored(self):
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "msg_1", "model": "m", "usage": {"input_tokens": 1, "output_tokens": 0}}}),
            _make_sse_line({"type": "content_block_delta", "delta": {"type": "thinking_delta", "text": "..."}}),
            _make_sse_line({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Result"}}),
        ]
        result = reassemble_sse("\n".join(lines), "anthropic")
        assert result["choices"][0]["message"]["content"] == "Result"

    def test_dones_ignored(self):
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "msg_1", "model": "m", "usage": {"input_tokens": 1}}}),
            "data: [DONE]",
        ]
        result = reassemble_sse("\n".join(lines), "anthropic")
        assert result["choices"][0]["message"]["content"] == ""

    def test_invalid_json_skipped(self):
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "msg_1", "model": "m", "usage": {"input_tokens": 1}}}),
            "data: not valid json",
            _make_sse_line({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "OK"}}),
            _make_sse_line({"type": "message_delta", "delta": {"stop_reason": "stop"}}),
        ]
        result = reassemble_sse("\n".join(lines), "anthropic")
        assert result["choices"][0]["message"]["content"] == "OK"

    def test_output_tokens_accumulated_from_message_delta(self):
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "m", "model": "c", "usage": {"input_tokens": 5, "output_tokens": 3}}}),
            _make_sse_line({"type": "message_delta", "delta": {"stop_reason": "end", "usage": {"output_tokens": 7}}}),
        ]
        result = reassemble_sse("\n".join(lines), "anthropic")
        assert result["usage"]["completion_tokens"] == 10


class TestReassembleOpenAI:
    def test_basic_completion(self):
        lines = [
            _make_sse_line({"id": "chat_1", "model": "gpt-4o", "choices": [{"index": 0, "delta": {"content": "Hello"}, "finish_reason": None}]}),
            _make_sse_line({"id": "chat_1", "model": "gpt-4o", "choices": [{"index": 0, "delta": {"content": " world"}, "finish_reason": None}]}),
            _make_sse_line({"id": "chat_1", "model": "gpt-4o", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 2}}),
        ]
        result = reassemble_sse("\n".join(lines), "openai")
        assert result["id"] == "chat_1"
        assert result["model"] == "gpt-4o"
        assert result["choices"][0]["message"]["content"] == "Hello world"
        assert result["choices"][0]["finish_reason"] == "stop"
        assert result["usage"]["prompt_tokens"] == 5
        assert result["usage"]["completion_tokens"] == 2

    def test_usage_accumulates_across_chunks(self):
        lines = [
            _make_sse_line({"id": "c", "choices": [{"delta": {"content": "a"}}], "usage": {"prompt_tokens": 1, "completion_tokens": 1}}),
            _make_sse_line({"id": "c", "choices": [{"delta": {"content": "b"}}], "usage": {"prompt_tokens": 0, "completion_tokens": 1}}),
            _make_sse_line({"id": "c", "choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 0, "completion_tokens": 1}}),
        ]
        result = reassemble_sse("\n".join(lines), "openai")
        assert result["usage"]["prompt_tokens"] == 1
        assert result["usage"]["completion_tokens"] == 3

    def test_dones_ignored(self):
        lines = [
            _make_sse_line({"id": "c", "choices": [{"delta": {"content": "Hi"}}]}),
            "data: [DONE]",
        ]
        result = reassemble_sse("\n".join(lines), "openai")
        assert result["choices"][0]["message"]["content"] == "Hi"

    def test_invalid_json_skipped(self):
        lines = [
            _make_sse_line({"id": "c", "choices": [{"delta": {"content": "A"}}]}),
            "data: not json",
            _make_sse_line({"id": "c", "choices": [{"delta": {"content": "B"}}]}),
        ]
        result = reassemble_sse("\n".join(lines), "openai")
        assert result["choices"][0]["message"]["content"] == "AB"


class TestReassembleSSEFile:
    def test_round_trip(self, tmp_path):
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "msg_99", "model": "claude-3", "usage": {"input_tokens": 7, "output_tokens": 0}}}),
            _make_sse_line({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Done"}}),
            _make_sse_line({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}}),
        ]
        path = tmp_path / "sse_response.txt"
        path.write_text("\n".join(lines))
        result = reassemble_sse_file(str(path), "anthropic")
        assert result["id"] == "msg_99"
        assert result["choices"][0]["message"]["content"] == "Done"


class TestReassembleSSEToFile:
    def test_overwrites_with_normalised_json(self, tmp_path):
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "msg_1", "model": "c", "usage": {"input_tokens": 2, "output_tokens": 0}}}),
            _make_sse_line({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Written"}}),
            _make_sse_line({"type": "message_delta", "delta": {"stop_reason": "stop"}}),
        ]
        path = tmp_path / "out.txt"
        path.write_text("\n".join(lines))
        reassemble_sse_to_file(str(path), "anthropic")
        result = json.loads(path.read_text())
        assert result["id"] == "msg_1"
        assert result["choices"][0]["message"]["content"] == "Written"


class TestStreamErrorDetection:
    def test_openai_error_event(self):
        result = reassemble_sse(_make_sse_line({"error": {"message": "boom"}}), "openai")
        assert result.get("error") == {"message": "boom"}
        assert result["choices"][0]["message"]["content"] == ""

    def test_anthropic_error_event(self):
        result = reassemble_sse(
            _make_sse_line({"type": "error", "error": {"message": "overloaded"}}),
            "anthropic",
        )
        assert result.get("error") == {"message": "overloaded"}

    def test_non_sse_json_error_body(self):
        # No 'data:' lines at all — a plain JSON error body (sometimes HTTP 200).
        body = json.dumps({"error": {"message": "model not found"}})
        result = reassemble_sse(body, "openai")
        assert result.get("error") == {"message": "model not found"}

    def test_no_false_error_on_valid_stream(self):
        lines = [
            _make_sse_line({"id": "c", "choices": [{"delta": {"content": "hi"}, "finish_reason": "stop"}]}),
        ]
        result = reassemble_sse("\n".join(lines), "openai")
        assert "error" not in result
        assert result["choices"][0]["message"]["content"] == "hi"


def _parsed_args(tc):
    """Assert the OpenAI string contract for ``function.arguments``, then parse.

    ``arguments`` must always be a JSON-encoded string (never a dict) so the
    assistant message round-trips to strict servers; tests compare content
    through this helper so they don't depend on fragment formatting.
    """
    args = tc["function"]["arguments"]
    assert isinstance(args, str), f"arguments must be a JSON string, got {type(args).__name__}"
    return json.loads(args)


class TestReassembleOpenAIToolCalls:
    """OpenAI streaming tool-call reassembly (issue #201)."""

    def test_single_tool_call_arg_fragments(self):
        # Real llama.cpp/LiteLLM shape: id and name arrive in the first
        # delta, then ``function.arguments`` arrives as a sequence of
        # partial-JSON fragments (often broken mid-key, mid-string, etc.).
        lines = [
            _make_sse_line({"id": "chatcmpl-1", "model": "qwen3", "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_abc", "type": "function", "function": {"name": "read_file", "arguments": '{"path":'}}]}}]}),
            _make_sse_line({"id": "chatcmpl-1", "model": "qwen3", "choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "function": {"arguments": ' "/etc/hosts"}'}}]}}]}),
            _make_sse_line({"id": "chatcmpl-1", "model": "qwen3", "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 11, "completion_tokens": 5}}),
        ]
        result = reassemble_sse("\n".join(lines), "openai")
        msg = result["choices"][0]["message"]
        assert msg["content"] == ""
        assert result["choices"][0]["finish_reason"] == "tool_calls"
        assert len(msg["tool_calls"]) == 1
        tc = msg["tool_calls"][0]
        assert tc["id"] == "call_abc"
        assert tc["type"] == "function"
        assert tc["function"]["name"] == "read_file"
        assert _parsed_args(tc) == {"path": "/etc/hosts"}
        assert result["usage"]["prompt_tokens"] == 11
        assert result["usage"]["completion_tokens"] == 5

    def test_text_then_tool_call(self):
        # Mixed text + tool call — the model emits prose, then a tool call.
        lines = [
            _make_sse_line({"id": "c", "choices": [{"delta": {"role": "assistant", "content": "Let me "}}]}),
            _make_sse_line({"id": "c", "choices": [{"delta": {"content": "check that file."}}]}),
            _make_sse_line({"id": "c", "choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": "read_file", "arguments": '{"path":"a.py"}'}}]}}]}),
            _make_sse_line({"id": "c", "choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
        ]
        result = reassemble_sse("\n".join(lines), "openai")
        msg = result["choices"][0]["message"]
        assert msg["content"] == "Let me check that file."
        assert len(msg["tool_calls"]) == 1
        assert _parsed_args(msg["tool_calls"][0]) == {"path": "a.py"}

    def test_parallel_tool_calls_distinct_indices(self):
        # Two parallel tool calls in one round, identified by ``index``.
        lines = [
            _make_sse_line({"id": "c", "choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": "call_0", "type": "function", "function": {"name": "read_file", "arguments": '{"path":'}},
                {"index": 1, "id": "call_1", "type": "function", "function": {"name": "read_file", "arguments": '{"path":'}},
            ]}}]}),
            _make_sse_line({"id": "c", "choices": [{"delta": {"tool_calls": [
                {"index": 0, "function": {"arguments": '"a.py"}'}},
                {"index": 1, "function": {"arguments": '"b.py"}'}},
            ]}}]}),
            _make_sse_line({"id": "c", "choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
        ]
        result = reassemble_sse("\n".join(lines), "openai")
        tcs = result["choices"][0]["message"]["tool_calls"]
        assert len(tcs) == 2
        by_id = {tc["id"]: tc for tc in tcs}
        assert _parsed_args(by_id["call_0"]) == {"path": "a.py"}
        assert _parsed_args(by_id["call_1"]) == {"path": "b.py"}
        # Index order, not arrival order.
        assert [tc["id"] for tc in tcs] == ["call_0", "call_1"]

    def test_truncated_stream_flushes_partial_tool_calls(self):
        # No finish_reason, no [DONE] — the model died mid-stream. We still
        # emit any tool call whose id and name arrived, so the caller can
        # decide what to do.
        lines = [
            _make_sse_line({"id": "c", "choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_partial", "type": "function", "function": {"name": "read_file", "arguments": '{"path":'}}]}}]}),
            # Stream cut off here.
        ]
        result = reassemble_sse("\n".join(lines), "openai")
        tcs = result["choices"][0]["message"]["tool_calls"]
        assert len(tcs) == 1
        # Fragment isn't valid JSON — preserve the raw string.
        assert tcs[0]["function"]["arguments"] == '{"path":'

    def test_incomplete_tool_call_dropped(self):
        # id never arrives (only the name+arguments delta). The reassembler
        # should drop it rather than emit a half-formed tool_calls entry.
        lines = [
            _make_sse_line({"id": "c", "choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"name": "read_file", "arguments": "{}"}}]}}]}),
            _make_sse_line({"id": "c", "choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
        ]
        result = reassemble_sse("\n".join(lines), "openai")
        assert "tool_calls" not in result["choices"][0]["message"]

    def test_single_dict_tool_call_delta(self):
        # Some LiteLLM proxy builds emit ``delta.tool_calls`` as a single
        # dict rather than a list. The reassembler must accept that shape.
        lines = [
            _make_sse_line({"id": "c", "choices": [{"delta": {"tool_calls": {"index": 0, "id": "call_single", "type": "function", "function": {"name": "ping", "arguments": "{}"}}}}]}),
            _make_sse_line({"id": "c", "choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
        ]
        result = reassemble_sse("\n".join(lines), "openai")
        tcs = result["choices"][0]["message"]["tool_calls"]
        assert len(tcs) == 1
        assert tcs[0]["id"] == "call_single"
        assert tcs[0]["function"]["name"] == "ping"

    def test_multibyte_chars_in_arguments(self):
        # Non-ASCII characters in tool-call arguments must round-trip
        # through reassembly intact.
        lines = [
            _make_sse_line({"id": "c", "choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_u", "type": "function", "function": {"name": "read_file", "arguments": '{"path":"café.txt"}'}}]}}]}),
            _make_sse_line({"id": "c", "choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
        ]
        result = reassemble_sse("\n".join(lines), "openai")
        tc = result["choices"][0]["message"]["tool_calls"][0]
        assert _parsed_args(tc) == {"path": "café.txt"}

    def test_text_only_no_tool_calls_key(self):
        # Backward compatibility: a text-only stream must not gain a
        # ``tool_calls`` key on the message.
        lines = [
            _make_sse_line({"id": "c", "choices": [{"delta": {"content": "ok"}}]}),
            _make_sse_line({"id": "c", "choices": [{"delta": {}, "finish_reason": "stop"}]}),
        ]
        result = reassemble_sse("\n".join(lines), "openai")
        assert "tool_calls" not in result["choices"][0]["message"]


class TestReassembleAnthropicToolCalls:
    """Anthropic streaming tool_use reassembly (issue #201)."""

    def test_single_tool_use_with_input_json_delta(self):
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "msg_t", "model": "claude-3-5-sonnet", "usage": {"input_tokens": 10, "output_tokens": 0}}}),
            _make_sse_line({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "read_file"}}),
            _make_sse_line({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": '{"path":'}}),
            _make_sse_line({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": ' "x.py"}'}}),
            _make_sse_line({"type": "content_block_stop", "index": 0}),
            _make_sse_line({"type": "message_delta", "delta": {"stop_reason": "tool_use", "usage": {"output_tokens": 6}}}),
            _make_sse_line({"type": "message_stop"}),
        ]
        result = reassemble_sse("\n".join(lines), "anthropic")
        msg = result["choices"][0]["message"]
        assert msg["content"] == ""
        # finish_reason normalised to OpenAI's "tool_calls" string.
        assert result["choices"][0]["finish_reason"] == "tool_calls"
        assert len(msg["tool_calls"]) == 1
        tc = msg["tool_calls"][0]
        assert tc["id"] == "toolu_1"
        assert tc["type"] == "function"
        assert tc["function"]["name"] == "read_file"
        assert _parsed_args(tc) == {"path": "x.py"}
        assert result["usage"]["completion_tokens"] == 6

    def test_text_then_tool_use_then_text_interleaved(self):
        # Interleaved text + tool_use + text — the reassembler must
        # concatenate the text and assemble the tool call.
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "msg_i", "model": "claude", "usage": {"input_tokens": 3, "output_tokens": 0}}}),
            _make_sse_line({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            _make_sse_line({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Checking... "}}),
            _make_sse_line({"type": "content_block_stop", "index": 0}),
            _make_sse_line({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_2", "name": "git_diff_stat"}}),
            _make_sse_line({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{}"}}),
            _make_sse_line({"type": "content_block_stop", "index": 1}),
            _make_sse_line({"type": "content_block_start", "index": 2, "content_block": {"type": "text", "text": ""}}),
            _make_sse_line({"type": "content_block_delta", "index": 2, "delta": {"type": "text_delta", "text": "Done."}}),
            _make_sse_line({"type": "content_block_stop", "index": 2}),
            _make_sse_line({"type": "message_delta", "delta": {"stop_reason": "end_turn"}}),
            _make_sse_line({"type": "message_stop"}),
        ]
        result = reassemble_sse("\n".join(lines), "anthropic")
        msg = result["choices"][0]["message"]
        assert msg["content"] == "Checking... Done."
        # end_turn wins over tool_use because text came last.
        assert result["choices"][0]["finish_reason"] == "end_turn"
        assert len(msg["tool_calls"]) == 1
        assert msg["tool_calls"][0]["function"]["name"] == "git_diff_stat"

    def test_tool_use_only_no_text_content(self):
        # Defensive: no text deltas at all, just a tool_use block.
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "m", "model": "c", "usage": {"input_tokens": 1, "output_tokens": 0}}}),
            _make_sse_line({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "t", "name": "ping"}}),
            _make_sse_line({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{}"}}),
            _make_sse_line({"type": "content_block_stop", "index": 0}),
            _make_sse_line({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
            _make_sse_line({"type": "message_stop"}),
        ]
        result = reassemble_sse("\n".join(lines), "anthropic")
        msg = result["choices"][0]["message"]
        assert msg["content"] == ""
        assert result["choices"][0]["finish_reason"] == "tool_calls"
        assert msg["tool_calls"][0]["function"]["name"] == "ping"

    def test_truncated_stream_defensive_flush(self):
        # No content_block_stop before message_stop — the reassembler must
        # still flush the open tool block when message_stop arrives.
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "m", "model": "c", "usage": {"input_tokens": 1, "output_tokens": 0}}}),
            _make_sse_line({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "t_x", "name": "f"}}),
            _make_sse_line({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": '{"k":1}'}}),
            # No content_block_stop — the stream collapsed straight to message_stop.
            _make_sse_line({"type": "message_stop"}),
        ]
        result = reassemble_sse("\n".join(lines), "anthropic")
        assert len(result["choices"][0]["message"]["tool_calls"]) == 1
        assert result["choices"][0]["message"]["tool_calls"][0]["id"] == "t_x"

    def test_multiple_tool_use_blocks(self):
        # Two tool_use blocks in the same response, closed in order.
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "m2", "model": "c", "usage": {"input_tokens": 1, "output_tokens": 0}}}),
            _make_sse_line({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "a", "name": "f1"}}),
            _make_sse_line({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": '{"x":1}'}}),
            _make_sse_line({"type": "content_block_stop", "index": 0}),
            _make_sse_line({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "b", "name": "f2"}}),
            _make_sse_line({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"y":2}'}}),
            _make_sse_line({"type": "content_block_stop", "index": 1}),
            _make_sse_line({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
        ]
        result = reassemble_sse("\n".join(lines), "anthropic")
        tcs = result["choices"][0]["message"]["tool_calls"]
        assert [tc["id"] for tc in tcs] == ["a", "b"]
        assert _parsed_args(tcs[0]) == {"x": 1}
        assert _parsed_args(tcs[1]) == {"y": 2}

    def test_malformed_partial_json_preserves_raw_string(self):
        # Truncated mid-value: the partial JSON doesn't form a complete
        # object. We preserve the raw string for the caller.
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "m", "model": "c", "usage": {"input_tokens": 1, "output_tokens": 0}}}),
            _make_sse_line({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "t", "name": "f"}}),
            _make_sse_line({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": '{"k":'}}),
            _make_sse_line({"type": "content_block_stop", "index": 0}),
            _make_sse_line({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
        ]
        result = reassemble_sse("\n".join(lines), "anthropic")
        tc = result["choices"][0]["message"]["tool_calls"][0]
        assert tc["function"]["arguments"] == '{"k":'

    def test_input_json_delta_with_dict_alias(self):
        # Some Anthropic-compatible proxies use ``delta.input`` (a dict) in
        # place of ``partial_json`` (a string). The reassembler accepts
        # both shapes.
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "m", "model": "c", "usage": {"input_tokens": 1, "output_tokens": 0}}}),
            _make_sse_line({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "t", "name": "f"}}),
            _make_sse_line({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json", "input": {"a": 1, "b": "x"}}}),
            _make_sse_line({"type": "content_block_stop", "index": 0}),
            _make_sse_line({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
        ]
        result = reassemble_sse("\n".join(lines), "anthropic")
        tc = result["choices"][0]["message"]["tool_calls"][0]
        assert _parsed_args(tc) == {"a": 1, "b": "x"}

    def test_thinking_blocks_ignored(self):
        # Thinking blocks must not pollute content or tool_calls.
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "m", "model": "c", "usage": {"input_tokens": 1, "output_tokens": 0}}}),
            _make_sse_line({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}),
            _make_sse_line({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "private"}}),
            _make_sse_line({"type": "content_block_stop", "index": 0}),
            _make_sse_line({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "t", "name": "f"}}),
            _make_sse_line({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{}"}}),
            _make_sse_line({"type": "content_block_stop", "index": 1}),
            _make_sse_line({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
        ]
        result = reassemble_sse("\n".join(lines), "anthropic")
        msg = result["choices"][0]["message"]
        assert "private" not in msg["content"]
        assert len(msg["tool_calls"]) == 1
        assert msg["tool_calls"][0]["function"]["name"] == "f"

    def test_tool_use_block_without_index_not_dropped(self):
        # A malformed proxy can omit ``index`` on the content_block events.
        # The block must still flush (keyed on the open tool id, not the
        # index) and finish_reason must still normalise to "tool_calls".
        lines = [
            _make_sse_line({"type": "message_start", "message": {"id": "m", "model": "c", "usage": {"input_tokens": 1, "output_tokens": 0}}}),
            _make_sse_line({"type": "content_block_start", "content_block": {"type": "tool_use", "id": "t_noidx", "name": "f"}}),
            _make_sse_line({"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": '{"a":1}'}}),
            _make_sse_line({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
            _make_sse_line({"type": "message_stop"}),
        ]
        result = reassemble_sse("\n".join(lines), "anthropic")
        msg = result["choices"][0]["message"]
        assert len(msg["tool_calls"]) == 1
        assert msg["tool_calls"][0]["id"] == "t_noidx"
        assert _parsed_args(msg["tool_calls"][0]) == {"a": 1}
        assert result["choices"][0]["finish_reason"] == "tool_calls"


class TestToolCallOrdering:
    """Parallel tool calls must come out in index order (issue #201)."""

    def test_out_of_order_indices_sorted_on_flush(self):
        # A stream that delivers index 1 before index 0 must still emit
        # tool_calls in index order — downstream pairs results to calls
        # positionally in some clients.
        lines = [
            _make_sse_line({"id": "c", "choices": [{"delta": {"tool_calls": [{"index": 1, "id": "call_B", "type": "function", "function": {"name": "b", "arguments": "{}"}}]}}]}),
            _make_sse_line({"id": "c", "choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_A", "type": "function", "function": {"name": "a", "arguments": "{}"}}]}, "finish_reason": "tool_calls"}]}),
        ]
        result = reassemble_sse("\n".join(lines), "openai")
        tcs = result["choices"][0]["message"]["tool_calls"]
        assert [tc["id"] for tc in tcs] == ["call_A", "call_B"]


if __name__ == "__main__":
    unittest_main()
