#!/usr/bin/env python3
"""Fixture tests for model output parsing and SSE reassembly.

Covers the acceptance criteria from issue #32:
  - OpenAI non-stream response parsing
  - Anthropic non-stream response parsing
  - OpenAI SSE reassembly
  - Anthropic SSE reassembly
  - Invalid/malformed outputs
  - Non-text Anthropic blocks ignored
  - CI runs these tests

Tests are self-contained (no external services) and run via:
    python3 tests/test_model_parsing.py
"""

import json
import sys

import pytest


def parse_and_validate(response_dict):
    """Parse model response dict and return the extracted review dict."""
    content = None
    if isinstance(response_dict.get("choices"), list):
        content = (
            (response_dict.get("choices") or [{}])[0]
            .get("message") or {}
        ).get("content")
    elif isinstance(response_dict.get("content"), list):
        parts = []
        for item in response_dict.get("content") or []:
            if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
                parts.append(item["text"])
        content = "".join(parts)
    elif isinstance(response_dict.get("content"), str):
        content = response_dict.get("content")

    if isinstance(content, str):
        text = content.strip()
    elif isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                item_type = item.get("type")
                if item_type in (None, "text"):
                    text_part = item.get("text")
                    if isinstance(text_part, str):
                        parts.append(text_part)
        text = "".join(parts).strip()
    elif content is None:
        text = ""
    else:
        text = str(content).strip()

    if text.startswith("```"):
        lines = text.splitlines()
        if lines:
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()

    decoder = json.JSONDecoder()
    parsed = None
    for start in range(len(text)):
        if text[start] not in "[{":
            continue
        try:
            candidate, _end = decoder.raw_decode(text[start:])
            parsed = candidate
            break
        except json.JSONDecodeError:
            continue

    if parsed is None:
        raise SystemExit("Could not extract JSON object from model response")

    if isinstance(parsed, list) and len(parsed) == 1 and isinstance(parsed[0], dict):
        parsed = parsed[0]

    if not isinstance(parsed, dict):
        raise SystemExit(f"Expected JSON object but got {type(parsed).__name__}")

    return parsed


def reassemble_anthropic_sse(sse_text):
    """Reassemble Anthropic streaming SSE into a chat.completion-like dict."""
    content_parts = []
    stop_reason = None
    model = None
    message_id = None
    input_tokens = 0
    output_tokens = 0

    for line in sse_text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            event = json.loads(data)
        except json.JSONDecodeError:
            continue

        etype = event.get("type", "")
        if etype == "message_start":
            message_id = event.get("message", {}).get("id")
            model = event.get("message", {}).get("model")
            input_tokens = event.get("message", {}).get("usage", {}).get("input_tokens", 0)
            output_tokens = event.get("message", {}).get("output_tokens", 0)
        elif etype == "content_block_delta":
            delta = event.get("delta", {})
            if delta.get("type") in ("text_delta", "text"):
                text_chunk = delta.get("text", "")
                if isinstance(text_chunk, str):
                    content_parts.append(text_chunk)
        elif etype == "message_delta":
            delta = event.get("delta", {})
            stop_reason = delta.get("stop_reason")
            usage = delta.get("usage", {})
            if usage:
                output_tokens += usage.get("output_tokens", 0)

    content_text = "".join(content_parts)
    return {
        "id": message_id or "",
        "object": "chat.completion",
        "model": model or "",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content_text},
            "finish_reason": stop_reason or "stop"
        }],
        "usage": {
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens
        }
    }


def reassemble_openai_sse(sse_text):
    """Reassemble OpenAI streaming SSE into a chat.completion-like dict."""
    content_parts = []
    finish_reason = None
    model = None
    usage_prompt_tokens = 0
    usage_completion_tokens = 0
    id_val = ""

    for line in sse_text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            continue

        id_val = chunk.get("id", id_val)
        model = chunk.get("model", model)
        choices = chunk.get("choices", [])
        for choice in choices:
            delta = choice.get("delta", {})
            if isinstance(delta, dict):
                c = delta.get("content")
                if isinstance(c, str):
                    content_parts.append(c)
            fr = choice.get("finish_reason")
            if fr is not None:
                finish_reason = fr
        usage = chunk.get("usage")
        if isinstance(usage, dict):
            usage_prompt_tokens += usage.get("prompt_tokens", 0)
            usage_completion_tokens += usage.get("completion_tokens", 0)

    content_text = "".join(content_parts)
    return {
        "id": id_val,
        "object": "chat.completion",
        "model": model or "",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content_text},
            "finish_reason": finish_reason or "stop"
        }],
        "usage": {
            "prompt_tokens": usage_prompt_tokens,
            "completion_tokens": usage_completion_tokens,
            "total_tokens": usage_prompt_tokens + usage_completion_tokens
        }
    }


def _sse_line(obj):
    """Build a single SSE data line from a Python dict."""
    return "data: " + json.dumps(obj)


def _sse_block(lines):
    """Join SSE lines with blank-line separators."""
    return "\n\n".join(lines)


# ---------------------------------------------------------------------------
# Tests: OpenAI non-stream response parsing
# ---------------------------------------------------------------------------

def test_openai_nonstream_standard():
    resp = {
        "id": "chatcmpl-test",
        "choices": [{
            "message": {
                "content": json.dumps({"verdict":"approve","review_markdown":"Looks good.","packages":[]})
            },
            "finish_reason": "stop"
        }]
    }
    parsed = parse_and_validate(resp)
    assert parsed["verdict"] == "approve"
    assert len(parsed.get("review_markdown", "")) == 11


def test_openai_nonstream_array_wrapped():
    resp = {
        "id": "chatcmpl-test",
        "choices": [{
            "message": {
                "content": json.dumps([{"verdict":"request_changes","review_markdown":"Needs work."}])
            },
            "finish_reason": "stop"
        }]
    }
    parsed = parse_and_validate(resp)
    assert parsed["verdict"] == "request_changes"
    assert len(parsed.get("review_markdown", "")) == 11


def test_openai_nonstream_string_content():
    resp = {
        "id": "msg-test",
        "content": json.dumps({"verdict":"approve","review_markdown":"Direct string."})
    }
    parsed = parse_and_validate(resp)
    assert parsed["verdict"] == "approve"


# ---------------------------------------------------------------------------
# Tests: Anthropic non-stream response parsing
# ---------------------------------------------------------------------------

def test_anthropic_nonstream_text_blocks():
    resp = {
        "id": "msg-test",
        "type": "message",
        "role": "assistant",
        "content": [
            {"type": "thinking", "thinking": "private reasoning"},
            {"type": "tool_use", "name": "read_file", "input": {}},
            {"type": "text", "text": json.dumps({"verdict":"approve","review_markdown":"Anthropic clean."})}
        ]
    }
    parsed = parse_and_validate(resp)
    assert parsed["verdict"] == "approve"
    assert parsed.get("review_markdown") == "Anthropic clean."


def test_anthropic_nonstream_only_thinking():
    resp = {
        "id": "msg-test",
        "type": "message",
        "role": "assistant",
        "content": [{"type": "thinking", "thinking": "just thinking"}]
    }
    with pytest.raises(SystemExit, match="Could not extract JSON"):
        parse_and_validate(resp)


def test_anthropic_nonstream_mixed_text_list():
    resp = {
        "id": "msg-test",
        "type": "message",
        "role": "assistant",
        "content": [
            {"type": "thinking", "thinking": "ignored"},
            "Some prose ",
            {"type": "text", "text": json.dumps({"verdict":"approve","review_markdown":"Mixed list."})}
        ]
    }
    parsed = parse_and_validate(resp)
    assert parsed["verdict"] == "approve"


# ---------------------------------------------------------------------------
# Tests: OpenAI SSE reassembly
# ---------------------------------------------------------------------------

def test_openai_sse_single_delta():
    review_json = json.dumps({"verdict":"approve","review_markdown":"Single delta."})
    sse = _sse_block([
        _sse_line({"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"}}]}),
        _sse_line({"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{"content":review_json}}]}),
        _sse_line({"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"finish_reason":"stop"}]}),
        "data: [DONE]",
    ])
    assembled = reassemble_openai_sse(sse)
    parsed = parse_and_validate(assembled)
    assert parsed["verdict"] == "approve"
    assert parsed.get("review_markdown") == "Single delta."
    assert assembled["model"] == "gpt-4"
    assert assembled["id"] == "chatcmpl-1"


def test_openai_sse_multiple_deltas():
    review = json.dumps({"verdict":"request_changes","review_markdown":"Multi chunk."})
    mid_point = len(review) // 2
    part1 = review[:mid_point]
    part2 = review[mid_point:]

    sse = _sse_block([
        _sse_line({"id":"chatcmpl-2","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"}}]}),
        _sse_line({"id":"chatcmpl-2","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{"content":part1}}]}),
        _sse_line({"id":"chatcmpl-2","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{"content":part2}}]}),
        _sse_line({"id":"chatcmpl-2","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"finish_reason":"stop"}]}),
        "data: [DONE]",
    ])
    assembled = reassemble_openai_sse(sse)
    parsed = parse_and_validate(assembled)
    assert parsed["verdict"] == "request_changes"
    assert parsed.get("review_markdown") == "Multi chunk."


def test_openai_sse_with_usage():
    review_json = json.dumps({"verdict":"approve","review_markdown":"With usage."})
    sse = _sse_block([
        _sse_line({"id":"chatcmpl-3","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"delta":{"content":review_json}}]}),
        _sse_line({"id":"chatcmpl-3","object":"chat.completion.chunk","model":"gpt-4","choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50}}),
        "data: [DONE]",
    ])
    assembled = reassemble_openai_sse(sse)
    assert assembled["usage"]["prompt_tokens"] == 100
    assert assembled["usage"]["completion_tokens"] == 50
    assert assembled["usage"]["total_tokens"] == 150
    parsed = parse_and_validate(assembled)
    assert parsed["verdict"] == "approve"


def test_openai_sse_with_blank_lines():
    review_json = json.dumps({"verdict":"approve","review_markdown":"Blank lines."})
    sse = _sse_block([
        _sse_line({"id":"chatcmpl-4","choices":[{"delta":{"content":review_json}}]}),
        "data: [DONE]",
    ])
    assembled = reassemble_openai_sse(sse)
    parsed = parse_and_validate(assembled)
    assert parsed["verdict"] == "approve"


# ---------------------------------------------------------------------------
# Tests: Anthropic SSE reassembly
# ---------------------------------------------------------------------------

def test_anthropic_sse_text_delta():
    review_json = json.dumps({"verdict":"approve","review_markdown":"Streamed clean."})
    mid = len(review_json) // 2
    part1 = review_json[:mid]
    part2 = review_json[mid:]

    sse = _sse_block([
        _sse_line({"type":"message_start","message":{"id":"msg_smoke","model":"claude-3-5-sonnet","usage":{"input_tokens":10,"output_tokens":0}}}),
        _sse_line({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        _sse_line({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":part1}}),
        _sse_line({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":part2}}),
        _sse_line({"type":"content_block_stop","index":0}),
        _sse_line({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
        _sse_line({"type":"message_stop"}),
    ])
    assembled = reassemble_anthropic_sse(sse)
    parsed = parse_and_validate(assembled)
    assert parsed["verdict"] == "approve"
    assert parsed.get("review_markdown") == "Streamed clean."
    assert assembled["model"] == "claude-3-5-sonnet"
    assert assembled["id"] == "msg_smoke"


def test_anthropic_sse_thinking_ignored():
    review_json = json.dumps({"verdict":"request_changes","review_markdown":"After thinking."})
    sse = _sse_block([
        _sse_line({"type":"message_start","message":{"id":"msg-think","model":"claude-3-5-sonnet"}}),
        _sse_line({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}),
        _sse_line({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"private reasoning that must not leak"}}),
        _sse_line({"type":"content_block_stop","index":0}),
        _sse_line({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
        _sse_line({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":review_json}}),
        _sse_line({"type":"content_block_stop","index":1}),
        _sse_line({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
        _sse_line({"type":"message_stop"}),
    ])
    assembled = reassemble_anthropic_sse(sse)
    content = assembled["choices"][0]["message"]["content"]
    assert "private reasoning" not in content
    parsed = parse_and_validate(assembled)
    assert parsed["verdict"] == "request_changes"
    assert parsed.get("review_markdown") == "After thinking."


def test_anthropic_sse_tool_use_ignored():
    review_json = json.dumps({"verdict":"approve","review_markdown":"Tool blocks ignored."})
    sse = _sse_block([
        _sse_line({"type":"message_start","message":{"id":"msg-tool","model":"claude-3-5-sonnet"}}),
        _sse_line({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        _sse_line({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":review_json}}),
        _sse_line({"type":"content_block_stop","index":0}),
        _sse_line({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"read_file"}}),
        _sse_line({"type":"content_block_delta","index":1,"delta":{"type":"input_json","input":{"path":"/etc/passwd"}}}),
        _sse_line({"type":"content_block_stop","index":1}),
        _sse_line({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
        _sse_line({"type":"message_stop"}),
    ])
    assembled = reassemble_anthropic_sse(sse)
    content = assembled["choices"][0]["message"]["content"]
    assert "input_json" not in content
    assert "read_file" not in content
    parsed = parse_and_validate(assembled)
    assert parsed["verdict"] == "approve"
    assert parsed.get("review_markdown") == "Tool blocks ignored."


def test_anthropic_sse_empty_stream():
    sse = _sse_block([
        _sse_line({"type":"message_start","message":{"id":"msg-empty","model":"claude-3-5-sonnet"}}),
        _sse_line({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"only thinking"}}),
        _sse_line({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
        _sse_line({"type":"message_stop"}),
    ])
    assembled = reassemble_anthropic_sse(sse)
    assert assembled["choices"][0]["message"]["content"] == ""
    with pytest.raises(SystemExit, match="Could not extract JSON"):
        parse_and_validate(assembled)


def test_anthropic_sse_text_type_alias():
    review_json = json.dumps({"verdict":"approve","review_markdown":"Type alias."})
    sse = _sse_block([
        _sse_line({"type":"message_start","message":{"id":"msg-alias","model":"claude-3-5-sonnet"}}),
        _sse_line({"type":"content_block_delta","index":0,"delta":{"type":"text","text":review_json}}),
        _sse_line({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
    ])
    assembled = reassemble_anthropic_sse(sse)
    parsed = parse_and_validate(assembled)
    assert parsed["verdict"] == "approve"


# ---------------------------------------------------------------------------
# Tests: Invalid / malformed outputs
# ---------------------------------------------------------------------------

def test_malformed_bare_numeric_list():
    resp = {"id": "chatcmpl-test", "choices": [{"message": {"content": "[1,2,3]"}}]}
    with pytest.raises(SystemExit):
        parse_and_validate(resp)


def test_malformed_empty_array():
    resp = {"id": "chatcmpl-test", "choices": [{"message": {"content": "[]"}}]}
    with pytest.raises(SystemExit):
        parse_and_validate(resp)


def test_malformed_non_json_prose():
    resp = {"id": "chatcmpl-test", "choices": [{"message": {"content": "I can't help with that right now."}}]}
    with pytest.raises(SystemExit):
        parse_and_validate(resp)


def test_malformed_invalid_json():
    resp = {"id": "chatcmpl-test", "choices": [{"message": {"content": '{"verdict":"approve","review_markdown":broken}'}}]}
    with pytest.raises(SystemExit):
        parse_and_validate(resp)


def test_malformed_empty_content():
    resp = {"id": "chatcmpl-test", "choices": [{"message": {"content": ""}}]}
    with pytest.raises(SystemExit):
        parse_and_validate(resp)


def test_malformed_none_content():
    resp = {"id": "chatcmpl-test", "choices": [{"message": {"content": None}}]}
    with pytest.raises(SystemExit):
        parse_and_validate(resp)


def test_malformed_missing_choices():
    resp = {"id": "chatcmpl-test", "choices": []}
    with pytest.raises(SystemExit):
        parse_and_validate(resp)


# ---------------------------------------------------------------------------
# Tests: Edge cases and boundary conditions
# ---------------------------------------------------------------------------

def test_edge_markdown_fence_variants():
    for lang in ["json", "", "JSON"]:
        fence_start = f"```{lang}" if lang else "```"
        resp = {
            "id": "chatcmpl-test",
            "choices": [{"message": {"content": f"{fence_start}\n{{\"verdict\":\"approve\",\"review_markdown\":\"Fence: {lang}\"}}\n```"}}]
        }
        parsed = parse_and_validate(resp)
        assert parsed["verdict"] == "approve"


def test_edge_leading_trailing_prose():
    resp = {
        "id": "chatcmpl-test",
        "choices": [{"message": {"content": "Here is my review:\n\n{\"verdict\":\"approve\",\"review_markdown\":\"Clean PR.\"}\n\nLet me know if you need anything else."}}]
    }
    parsed = parse_and_validate(resp)
    assert parsed["verdict"] == "approve"
    assert parsed.get("review_markdown") == "Clean PR."


def test_edge_single_item_array():
    resp = {
        "id": "chatcmpl-test",
        "choices": [{"message": {"content": "[{\"verdict\":\"request_changes\",\"review_markdown\":\"Needs fixes.\"}]"}}]
    }
    parsed = parse_and_validate(resp)
    assert parsed["verdict"] == "request_changes"
    assert parsed.get("review_markdown") == "Needs fixes."


def test_edge_single_item_array_wrapped_in_fence():
    resp = {
        "id": "chatcmpl-test",
        "choices": [{"message": {"content": "```json\n[{\"verdict\":\"approve\",\"review_markdown\":\"Fenced array.\"}]\n```"}}]
    }
    parsed = parse_and_validate(resp)
    assert parsed["verdict"] == "approve"


def test_edge_invalid_verdict_values():
    for verdict in ["unknown", "ERROR", "", "approve_extra"]:
        resp = {
            "id": "chatcmpl-test",
            "choices": [{"message": {"content": json.dumps({"verdict": verdict, "review_markdown": "test"})}}]
        }
        parsed = parse_and_validate(resp)
        assert parsed.get("verdict") == verdict


def test_edge_sse_corrupted_chunk():
    review_json = json.dumps({"verdict":"approve","review_markdown":"Corrupted skip."})
    sse_lines = [
        _sse_line({"id":"chatcmpl-5","choices":[{"delta":{"content":review_json}}]}),
        "data: THIS IS NOT JSON AT ALL!!!",
        _sse_line({"id":"chatcmpl-5","choices":[{"delta":{"content":"more text"}}]}),
        "data: [DONE]",
    ]
    sse = "\n\n".join(sse_lines)
    assembled = reassemble_openai_sse(sse)
    parsed = parse_and_validate(assembled)
    assert parsed["verdict"] == "approve"


def test_edge_anthropic_usage_accumulation():
    review_json = json.dumps({"verdict":"approve","review_markdown":"Usage accumulation."})
    sse = _sse_block([
        _sse_line({"type":"message_start","message":{"id":"msg-usage","model":"claude-3-5-sonnet","usage":{"input_tokens":100,"output_tokens":0}}}),
        _sse_line({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":review_json}}),
        _sse_line({"type":"message_delta","delta":{"stop_reason":"end_turn","usage":{"output_tokens":50}}}),
        _sse_line({"type":"message_stop"}),
    ])
    assembled = reassemble_anthropic_sse(sse)
    assert assembled["usage"]["prompt_tokens"] == 100
    assert assembled["usage"]["completion_tokens"] == 50
    assert assembled["usage"]["total_tokens"] == 150


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("=" * 60)
    print("Model Parsing & SSE Reassembly Tests")
    print("=" * 60)

    test_functions = [
        ("OpenAI Non-Stream Response Parsing", [
            test_openai_nonstream_standard,
            test_openai_nonstream_array_wrapped,
            test_openai_nonstream_string_content,
        ]),
        ("Anthropic Non-Stream Response Parsing", [
            test_anthropic_nonstream_text_blocks,
            test_anthropic_nonstream_only_thinking,
            test_anthropic_nonstream_mixed_text_list,
        ]),
        ("OpenAI SSE Reassembly", [
            test_openai_sse_single_delta,
            test_openai_sse_multiple_deltas,
            test_openai_sse_with_usage,
            test_openai_sse_with_blank_lines,
        ]),
        ("Anthropic SSE Reassembly", [
            test_anthropic_sse_text_delta,
            test_anthropic_sse_thinking_ignored,
            test_anthropic_sse_tool_use_ignored,
            test_anthropic_sse_empty_stream,
            test_anthropic_sse_text_type_alias,
        ]),
        ("Invalid / Malformed Outputs", [
            test_malformed_bare_numeric_list,
            test_malformed_empty_array,
            test_malformed_non_json_prose,
            test_malformed_invalid_json,
            test_malformed_empty_content,
            test_malformed_none_content,
            test_malformed_missing_choices,
        ]),
        ("Edge Cases & Boundary Conditions", [
            test_edge_markdown_fence_variants,
            test_edge_leading_trailing_prose,
            test_edge_single_item_array,
            test_edge_single_item_array_wrapped_in_fence,
            test_edge_invalid_verdict_values,
            test_edge_sse_corrupted_chunk,
            test_edge_anthropic_usage_accumulation,
        ]),
    ]

    total_passed = 0
    total_failed = 0
    failures = []

    for section_name, tests in test_functions:
        print(f"\n--- {section_name} ---")
        for test_fn in tests:
            try:
                test_fn()
                print(f"  PASS: {test_fn.__name__}")
                total_passed += 1
            except Exception as e:
                total_failed += 1
                msg = f"  FAIL: {test_fn.__name__}: {e}"
                failures.append(msg)
                print(msg)

    total = total_passed + total_failed

    if failures:
        print("\n--- Failures ---")
        for f in failures:
            print(f)

    print(f"\n=== Results: {total_passed}/{total} passed, {total_failed} failed ===")

    if total_failed > 0:
        print("\nFAIL: Some tests did not pass.")
        sys.exit(1)
    else:
        print("\nPASS: All tests passed!")
        sys.exit(0)


if __name__ == "__main__":
    main()
