"""Reassemble Server-Sent Events (SSE) streaming responses into consolidated JSON.

Ported from the ``reassemble_sse_response`` function in ``scripts/run_review.sh``.
Handles OpenAI chat completions streaming and Anthropic messages streaming formats,
normalising both to a unified OpenAI-style response structure.

Streaming tool calls are reassembled alongside text deltas into the OpenAI
non-streaming-equivalent shape used by ``response_parser``/downstream callers:

* OpenAI streams tool calls as ``choices[].delta.tool_calls[]`` deltas indexed
  by ``index``; ``id`` and ``function.name`` arrive once, and
  ``function.arguments`` accumulates as string fragments across deltas. The
  reassembled message carries ``tool_calls=[{id, type, function: {name,
  arguments}}]`` with ``arguments`` as the accumulated JSON-encoded *string*
  (OpenAI's non-streaming schema — strict servers require the string form when
  the assistant message is echoed back on the next turn). Consumers parse it;
  a malformed fragment from a truncated stream passes through verbatim.
* Anthropic streams tool calls as ``content_block_start`` (carrying
  ``id``/``name``/``type=="tool_use"``) plus ``input_json_delta`` partial-JSON
  fragments plus ``content_block_stop``; ``stop_reason: "tool_use"``.

The output dict therefore always uses OpenAI's ``tool_calls`` schema, regardless
of the source format. Text-only responses are unchanged: the existing
``choices[0].message.content`` string is preserved, so consumers that look
only at the content field are unaffected (zero behavior change for existing
modes).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def reassemble_sse(response_text: str, api_format: str) -> dict:
    """Reassemble SSE lines from a streaming response into a structured dict.

    Parameters
    ----------
    response_text : str
        Raw response text containing SSE data lines (one ``data: ...`` per line).
    api_format : str
        Either ``"openai"`` or ``"anthropic"``.

    Returns
    -------
    dict
        A normalised OpenAI-style response dict with an ``id``, ``model``,
        ``choices``, and ``usage`` field. When the stream contained tool
        calls, ``choices[0].message`` also carries a ``tool_calls`` list and
        ``finish_reason`` is set to ``"tool_calls"`` (or the Anthropic
        ``"tool_use"`` value, normalised to ``"tool_calls"`` on read).
    """
    lines = response_text.splitlines()
    content_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []

    if api_format == "anthropic":
        result = _reassemble_anthropic(lines, content_parts, tool_calls)
    else:
        result = _reassemble_openai(lines, content_parts, tool_calls)

    message = result["choices"][0]["message"]
    if tool_calls:
        # OpenAI's non-streaming shape: {id, type, function: {name, arguments}}
        message["tool_calls"] = tool_calls
        # Normalise Anthropic's "tool_use" to OpenAI's "tool_calls" so the
        # downstream finish_reason classification in response_parser treats
        # both formats identically.
        fr = result["choices"][0].get("finish_reason")
        if fr == "tool_use":
            result["choices"][0]["finish_reason"] = "tool_calls"

    # Some local servers (llama.cpp/vLLM/ollama under load, or a proxy) return a
    # plain JSON error body — sometimes with HTTP 200 — instead of an SSE stream.
    # Without this, the reassembler yields empty content that looks like a
    # successful-but-blank completion, masking the real failure and burning the
    # whole retry budget. If we recovered no content, no tool calls, and no
    # error, try parsing the whole body as a JSON error.
    has_text = bool(message.get("content"))
    if not has_text and not tool_calls and "error" not in result:
        stripped = response_text.strip()
        if stripped:
            try:
                whole = json.loads(stripped)
            except (json.JSONDecodeError, ValueError):
                whole = None
            if isinstance(whole, dict) and whole.get("error"):
                result["error"] = whole["error"]

    return result


# ---------------------------------------------------------------------------
# Anthropic streaming reassembly
# ---------------------------------------------------------------------------


def _reassemble_anthropic(
    lines: list[str],
    content_parts: list[str],
    tool_calls: list[dict[str, Any]],
) -> dict:
    stop_reason: str | None = None
    stop_sequence: str | None = None
    message_id: str | None = None
    model: str | None = None
    input_tokens = 0
    output_tokens = 0
    error_payload = None

    # Anthropic streams content blocks indexed by ``index``. Tool-use blocks
    # accumulate partial-JSON fragments across input_json_delta events until
    # the content_block_stop closes the block.
    tool_block_index: int | None = None
    current_tool_id: str | None = None
    current_tool_name: str | None = None
    current_tool_args_parts: list[str] = []

    def _flush_tool_call() -> None:
        nonlocal current_tool_id, current_tool_name, current_tool_args_parts
        if current_tool_id is None or current_tool_name is None:
            current_tool_id = None
            current_tool_name = None
            current_tool_args_parts = []
            return
        # ``arguments`` stays a JSON-encoded string — OpenAI's non-streaming
        # schema, and what strict servers expect when the assistant message is
        # echoed back on the next turn. Consumers parse it themselves; a
        # malformed fragment (truncated stream) is passed through verbatim so
        # the caller can decide whether to retry.
        raw_args = "".join(current_tool_args_parts) or "{}"
        tool_calls.append(
            {
                "id": current_tool_id,
                "type": "function",
                "function": {"name": current_tool_name, "arguments": raw_args},
            }
        )
        current_tool_id = None
        current_tool_name = None
        current_tool_args_parts = []

    for line in lines:
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
        if etype == "error":
            error_payload = event.get("error") or event
            continue
        if etype == "message_start":
            message_id = event.get("message", {}).get("id")
            model = event.get("message", {}).get("model")
            input_tokens = (
                event.get("message", {}).get("usage", {}).get("input_tokens", 0)
            )
            output_tokens = (
                event.get("message", {}).get("usage", {}).get("output_tokens", 0)
            )
        elif etype == "content_block_start":
            cb = event.get("content_block", {}) or {}
            cb_type = cb.get("type")
            cb_index = event.get("index")
            # If we were mid-way through a previous tool block and never saw
            # a content_block_stop (malformed stream), flush it before opening
            # the new one. Keyed on current_tool_id, not tool_block_index — a
            # proxy that omits ``index`` must not strand the open block.
            if current_tool_id is not None:
                _flush_tool_call()
                tool_block_index = None
            if cb_type == "tool_use":
                tool_block_index = cb_index
                current_tool_id = cb.get("id")
                current_tool_name = cb.get("name")
                current_tool_args_parts = []
        elif etype == "content_block_delta":
            delta = event.get("delta", {}) or {}
            delta_type = delta.get("type")
            if delta_type in ("text_delta", "text"):
                text_chunk = delta.get("text", "")
                if isinstance(text_chunk, str):
                    content_parts.append(text_chunk)
            elif delta_type in ("input_json_delta", "input_json"):
                # Partial-JSON fragment for the current tool_use block.
                partial = delta.get("partial_json") or delta.get("input") or ""
                if isinstance(partial, str):
                    current_tool_args_parts.append(partial)
                elif isinstance(partial, dict):
                    # Some Anthropic-compatible proxies (LiteLLM) serialise the
                    # partial input as a JSON-encoded string of a dict;
                    # json.dumps is the safe round-trip back to a fragment.
                    current_tool_args_parts.append(
                        json.dumps(partial, ensure_ascii=False)
                    )
        elif etype == "content_block_stop":
            cb_index = event.get("index")
            # Flush when the stop matches the open tool block. When the proxy
            # never sent an index for the block, any stop closes it (the spec
            # interleaves blocks sequentially, so the first stop after the
            # deltas is the block's own).
            if current_tool_id is not None and (
                tool_block_index is None or cb_index == tool_block_index
            ):
                _flush_tool_call()
                tool_block_index = None
        elif etype == "message_delta":
            delta = event.get("delta", {}) or {}
            stop_reason = delta.get("stop_reason")
            stop_sequence = delta.get("stop_sequence")
            usage = delta.get("usage", {})
            if usage:
                output_tokens += usage.get("output_tokens", 0)
        elif etype == "message_stop":
            # End of stream: flush any still-open tool block (defensive — the
            # spec requires a content_block_stop before message_stop, but
            # proxies may collapse the two).
            if current_tool_id is not None:
                _flush_tool_call()
                tool_block_index = None

    content_text = "".join(content_parts)
    result = {
        "id": message_id or "",
        "object": "chat.completion",
        "model": model or "",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content_text},
                "finish_reason": stop_reason or "stop",
            }
        ],
        "usage": {
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
        },
    }
    if error_payload is not None:
        result["error"] = error_payload
    return result


# ---------------------------------------------------------------------------
# OpenAI streaming reassembly
# ---------------------------------------------------------------------------


def _reassemble_openai(
    lines: list[str],
    content_parts: list[str],
    tool_calls: list[dict[str, Any]],
) -> dict:
    finish_reason: str | None = None
    model: str | None = None
    usage_prompt_tokens = 0
    usage_completion_tokens = 0
    id_val = ""
    error_payload = None

    # OpenAI streams tool calls as choices[].delta.tool_calls[] with an
    # ``index`` per parallel tool call. We accumulate per-index state.
    tool_state: dict[int, dict[str, Any]] = {}

    def _flush_tool_call(idx: int) -> None:
        state = tool_state.pop(idx, None)
        if not state:
            return
        if state.get("id") is None or state.get("name") is None:
            # Incomplete (id/name never arrived) — drop rather than emit a
            # half-formed tool call; this matches Anthropic's flush behaviour.
            return
        # JSON-encoded string per OpenAI's non-streaming schema (see the
        # Anthropic flush for the rationale); consumers parse it themselves.
        raw_args = "".join(state.get("args_parts", [])) or "{}"
        tool_calls.append(
            {
                "id": state["id"],
                "type": "function",
                "function": {"name": state["name"], "arguments": raw_args},
            }
        )

    for line in lines:
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

        if isinstance(chunk, dict) and chunk.get("error"):
            error_payload = chunk["error"]
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
                # Tool calls: list shape (newer OpenAI, llama.cpp/LiteLLM)
                # OR single object (some LiteLLM proxy builds emit a single
                # delta.tool_calls dict rather than a list). Handle both.
                raw_tc = delta.get("tool_calls")
                if raw_tc is not None:
                    items = raw_tc if isinstance(raw_tc, list) else [raw_tc]
                    for tc in items:
                        if not isinstance(tc, dict):
                            continue
                        idx = tc.get("index", 0)
                        if idx is None:
                            idx = 0
                        state = tool_state.setdefault(
                            idx,
                            {
                                "id": None,
                                "name": None,
                                "args_parts": [],
                            },
                        )
                        if tc.get("id"):
                            state["id"] = tc["id"]
                        fn = tc.get("function") or {}
                        if isinstance(fn, dict):
                            if fn.get("name"):
                                state["name"] = fn["name"]
                            args = fn.get("arguments")
                            if isinstance(args, str):
                                state["args_parts"].append(args)
            fr = choice.get("finish_reason")
            if fr is not None:
                # Any tool_calls present at finish time should already be in
                # the tool_calls list; flush any that have a terminal
                # finish_reason of "tool_calls" (defensive — they should
                # already be complete by then).
                if fr == "tool_calls":
                    for idx in sorted(tool_state):
                        _flush_tool_call(idx)
                finish_reason = fr
        usage = chunk.get("usage")
        if isinstance(usage, dict):
            usage_prompt_tokens += usage.get("prompt_tokens", 0)
            usage_completion_tokens += usage.get("completion_tokens", 0)

    # End of stream: flush any tool calls that never received a
    # finish_reason (truncated streams). Sorted so parallel calls come out in
    # index order even when the stream delivered their deltas out of order.
    for idx in sorted(tool_state):
        _flush_tool_call(idx)

    content_text = "".join(content_parts)
    result = {
        "id": id_val,
        "object": "chat.completion",
        "model": model or "",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content_text},
                "finish_reason": finish_reason or "stop",
            }
        ],
        "usage": {
            "prompt_tokens": usage_prompt_tokens,
            "completion_tokens": usage_completion_tokens,
            "total_tokens": usage_prompt_tokens + usage_completion_tokens,
        },
    }
    if error_payload is not None:
        result["error"] = error_payload
    return result


# ---------------------------------------------------------------------------
# File helpers
# ---------------------------------------------------------------------------


def reassemble_sse_file(response_path: str, api_format: str) -> dict:
    """Convenience wrapper that reads a response file and reassembles SSE.

    Parameters
    ----------
    response_path : str
        Path to the SSE response file.
    api_format : str
        Either ``"openai"`` or ``"anthropic"``.

    Returns
    -------
    dict
        The normalised response dict.
    """
    text = Path(response_path).read_text(encoding="utf-8", errors="replace")
    return reassemble_sse(text, api_format)


def reassemble_sse_to_file(response_path: str, api_format: str) -> None:
    """Read a SSE response file, reassemble it, and overwrite ``response_path``.

    Parameters
    ----------
    response_path : str
        Path to the SSE response file (will be overwritten with normalised JSON).
    api_format : str
        Either ``"openai"`` or ``"anthropic"``.
    """
    result = reassemble_sse_file(response_path, api_format)
    Path(response_path).write_text(
        json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8"
    )
