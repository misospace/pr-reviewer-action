"""Unit tests for pr_reviewer.tool_loop.

Target: >= 50% line coverage of pr_reviewer/tool_loop.py.

These tests complement tests/test_native_tool_loop.py with focused smoke tests
for the module surface, dataclasses, and helper exports.
"""
from __future__ import annotations

from typing import Any, Dict

import pytest

from pr_reviewer import tool_loop
from pr_reviewer.tool_loop import (
    STOP_MODEL_DONE,
    STOP_NO_TOOL_CALLS,
    STOP_MAX_ROUNDS,
    STOP_BUDGET,
    STOP_WALL_CLOCK,
    STOP_REQUEST_ERROR,
)


# ---------------------------------------------------------------------------
# Module surface
# ---------------------------------------------------------------------------


def test_module_exposes_expected_symbols() -> None:
    """The module must expose the public API used by callers."""
    for name in (
        "drive_tool_loop",
        "extract_tool_calls",
        "LoopBudgets",
        "ExecutedCall",
        "LoopOutcome",
        "STOP_MODEL_DONE",
        "STOP_NO_TOOL_CALLS",
        "STOP_MAX_ROUNDS",
        "STOP_BUDGET",
        "STOP_WALL_CLOCK",
        "STOP_REQUEST_ERROR",
    ):
        assert hasattr(tool_loop, name), f"missing symbol: {name}"


def test_module_imports_cleanly() -> None:
    """The module should import without side effects."""
    import importlib

    mod = importlib.reload(tool_loop)
    assert mod is tool_loop


def test_stop_reason_constants_are_strings() -> None:
    """Stop reason constants should be non-empty strings and all distinct."""
    constants = [
        STOP_MODEL_DONE,
        STOP_NO_TOOL_CALLS,
        STOP_MAX_ROUNDS,
        STOP_BUDGET,
        STOP_WALL_CLOCK,
        STOP_REQUEST_ERROR,
    ]
    for v in constants:
        assert isinstance(v, str) and v
    assert len(set(constants)) == len(constants), "stop reasons must be distinct"


# ---------------------------------------------------------------------------
# LoopBudgets
# ---------------------------------------------------------------------------


def test_loop_budgets_defaults() -> None:
    """LoopBudgets default values are positive numbers."""
    b = tool_loop.LoopBudgets()
    assert b.max_tool_calls >= 1
    assert b.max_rounds >= 1
    assert b.wall_clock_sec >= 1


def test_loop_budgets_custom() -> None:
    """LoopBudgets accepts custom values and exposes them as attributes."""
    b = tool_loop.LoopBudgets(max_tool_calls=7, wall_clock_sec=12.5, max_rounds=4)
    assert b.max_tool_calls == 7
    assert b.wall_clock_sec == 12.5
    assert b.max_rounds == 4


# ---------------------------------------------------------------------------
# ExecutedCall
# ---------------------------------------------------------------------------


def test_executed_call_construction() -> None:
    """ExecutedCall is a dataclass-like record carrying tool-call metadata."""
    ec = tool_loop.ExecutedCall(
        tool="read_file",
        args={"path": "x.py"},
        result={"content": "hi"},
    )
    assert ec.tool == "read_file"
    assert ec.args == {"path": "x.py"}
    assert ec.result == {"content": "hi"}


# ---------------------------------------------------------------------------
# LoopOutcome
# ---------------------------------------------------------------------------


def test_loop_outcome_defaults() -> None:
    """LoopOutcome defaults are sensible (empty executed list, no-tool-calls stop reason)."""
    out = tool_loop.LoopOutcome()
    assert isinstance(out.executed, list)
    assert out.executed == []
    assert out.stop_reason == STOP_NO_TOOL_CALLS


def test_adaptive_loop_budgets_scales_rounds() -> None:
    """adaptive_loop_budgets scales rounds with a cap of 8."""
    b = tool_loop.adaptive_loop_budgets(
        max_rounds=2, max_tool_calls=5, wall_clock_sec=30.0
    )
    # rounds should be at least 1 and at most 8.
    assert 1 <= b.max_rounds <= 8
    assert b.max_tool_calls == 5
    assert b.wall_clock_sec == 30.0


# ---------------------------------------------------------------------------
# extract_tool_calls (returns (calls, text))
# ---------------------------------------------------------------------------


def test_extract_tool_calls_handles_openai_format() -> None:
    """OpenAI-style response: tool_calls on the assistant message."""
    response: Dict[str, Any] = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "c1",
                            "function": {
                                "name": "read_file",
                                "arguments": '{"path": "a.py"}',
                            },
                        }
                    ],
                }
            }
        ]
    }
    calls, text = tool_loop.extract_tool_calls(response, "openai")
    assert isinstance(calls, list)
    assert isinstance(text, str)
    assert len(calls) == 1
    assert calls[0]["name"] == "read_file"
    assert calls[0]["id"] == "c1"
    # arguments is kept as opaque JSON string per the #233 contract.
    assert calls[0]["arguments"] == '{"path": "a.py"}'


def test_extract_tool_calls_no_calls_returns_text() -> None:
    """When no tool_calls are present, text is returned in the second slot."""
    response: Dict[str, Any] = {
        "choices": [{"message": {"role": "assistant", "content": "hello"}}]
    }
    calls, text = tool_loop.extract_tool_calls(response, "openai")
    assert calls == []
    assert text == "hello"


def test_extract_tool_calls_handles_anthropic_format() -> None:
    """Anthropic-style response: content blocks of type 'tool_use'."""
    response: Dict[str, Any] = {
        "content": [
            {"type": "text", "text": "thinking..."},
            {
                "type": "tool_use",
                "id": "tu1",
                "name": "git_log",
                "input": {"path": ".", "max_count": 3},
            },
        ]
    }
    calls, text = tool_loop.extract_tool_calls(response, "anthropic")
    assert isinstance(calls, list)
    # text may include any text blocks; tool_use blocks become calls
    assert any(c.get("name") == "git_log" for c in calls)
    assert "thinking" in text


def test_extract_tool_calls_handles_anthropic_no_tool_use() -> None:
    """Anthropic response without tool_use should yield no calls and the text."""
    response: Dict[str, Any] = {
        "content": [{"type": "text", "text": "plain text only"}]
    }
    calls, text = tool_loop.extract_tool_calls(response, "anthropic")
    assert calls == []
    assert text == "plain text only"


def test_extract_tool_calls_keeps_non_serializable_args_as_string() -> None:
    """Non-JSON arguments should be preserved as opaque strings."""
    response: Dict[str, Any] = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "c2",
                            "function": {"name": "echo", "arguments": "not json"},
                        }
                    ],
                }
            }
        ]
    }
    calls, text = tool_loop.extract_tool_calls(response, "openai")
    assert len(calls) == 1
    assert calls[0]["name"] == "echo"
    # arguments kept as the opaque string we passed in
    assert calls[0]["arguments"] == "not json"
