"""Tests for the thread_dispositions verdict field (#766)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer.response_parser import parse_response  # noqa: E402


def _response(payload: dict) -> dict:
    return {"choices": [{"message": {"content": json.dumps(payload)}, "finish_reason": "stop"}], "usage": {"completion_tokens": 10}}


def test_absent_key_stays_absent():
    parsed = parse_response(_response({"verdict": "approve", "review_markdown": "ok"}))
    assert "thread_dispositions" not in parsed


def test_dispositions_normalize_aliases_and_bounds():
    parsed = parse_response(_response({
        "verdict": "approve",
        "review_markdown": "ok",
        "thread_dispositions": [
            {"thread_id": " PRRT_1\n", "disposition": "Resolved", "evidence": "a.py:10\tnow guards None"},
            {"thread_id": "PRRT_2", "disposition": "OPEN"},
            {"thread_id": "PRRT_3", "disposition": "maybe", "evidence": ""},
            {"thread_id": "", "disposition": "fixed"},
            {"disposition": "fixed"},
            "junk",
            {"thread_id": "PRRT_4", "disposition": "disagree", "evidence": "x" * 2000},
        ],
    }))
    assert parsed["thread_dispositions"] == [
        {"thread_id": "PRRT_1", "disposition": "fixed", "evidence": "a.py:10 now guards None"},
        {"thread_id": "PRRT_2", "disposition": "open", "evidence": None},
        {"thread_id": "PRRT_3", "disposition": "invalid", "evidence": None},
        {"thread_id": "PRRT_4", "disposition": "disputed", "evidence": "x" * 1000},
    ]


def test_non_list_value_is_null():
    parsed = parse_response(_response({"verdict": "approve", "review_markdown": "ok", "thread_dispositions": "none"}))
    assert parsed["thread_dispositions"] is None
