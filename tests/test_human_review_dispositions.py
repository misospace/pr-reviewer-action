"""Tests for the human_review_dispositions verdict field."""

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
    assert "human_review_dispositions" not in parsed


def test_dispositions_bound_and_reject_unknown_words():
    parsed = parse_response(_response({
        "verdict": "approve",
        "review_markdown": "ok",
        "human_review_dispositions": [
            {"review_id": " 42\n", "disposition": "Addressed", "evidence": "a.py:10\tnow guards None"},
            {"review_id": "43", "disposition": "NOT_ADDRESSED"},
            {"review_id": "44", "disposition": "fixed", "evidence": ""},
            {"review_id": "", "disposition": "addressed"},
            {"disposition": "addressed"},
            "junk",
            {"review_id": "45", "disposition": "addressed", "evidence": "x" * 2000},
        ],
    }))
    assert parsed["human_review_dispositions"] == [
        {"review_id": "42", "disposition": "addressed", "evidence": "a.py:10 now guards None"},
        {"review_id": "43", "disposition": "not_addressed", "evidence": None},
        {"review_id": "44", "disposition": "invalid", "evidence": None},
        {"review_id": "45", "disposition": "addressed", "evidence": "x" * 1000},
    ]


def test_disposition_must_match_exactly_no_aliases():
    # Unlike thread_dispositions, there is no alias table: only the two
    # literal words survive; anything else (including "Resolved"/"open",
    # which are meaningful aliases for review threads) is "invalid".
    parsed = parse_response(_response({
        "verdict": "approve",
        "review_markdown": "ok",
        "human_review_dispositions": [
            {"review_id": "1", "disposition": "resolved"},
            {"review_id": "2", "disposition": "open"},
        ],
    }))
    assert parsed["human_review_dispositions"] == [
        {"review_id": "1", "disposition": "invalid", "evidence": None},
        {"review_id": "2", "disposition": "invalid", "evidence": None},
    ]


def test_non_list_value_is_null():
    parsed = parse_response(_response({"verdict": "approve", "review_markdown": "ok", "human_review_dispositions": "none"}))
    assert parsed["human_review_dispositions"] is None
