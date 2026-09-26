#!/usr/bin/env python3
"""Completion-budget overrun retry for the deep-review specialists.

A reasoning-capable model can spend the whole DEEP_REVIEW_MAX_TOKENS budget on
hidden reasoning and return an empty body with ``finish_reason: "length"``.
The role then retries exactly once with a raised budget; a long-but-complete
answer and a normal ``stop`` are never retried.
"""

from __future__ import annotations

import sys
from pathlib import Path

_TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(_TESTS))
sys.path.insert(0, str(_TESTS.parent / "scripts"))

import run_specialists  # noqa: E402
from test_run_specialists import (  # noqa: E402
    ROLES,
    aggregate,
    env_setup,
    make_leads_json,
    patch_transport,
    run_main,
    write_corpus,
    ws_dir,
)


def _cut(text: str = "", *, reasoning: int | None = None) -> dict:
    """OpenAI-shape response cut at the completion budget."""
    usage = {"prompt_tokens": 100, "completion_tokens": 4096}
    if reasoning is not None:
        usage["completion_tokens_details"] = {"reasoning_tokens": reasoning}
    return {
        "choices": [{"message": {"content": text}, "finish_reason": "length"}],
        "usage": usage,
    }


def _ok(text: str) -> dict:
    return {
        "choices": [{"message": {"content": text}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 300},
    }


def test_overrun_with_empty_content_retries_once_with_raised_budget(tmp_path, monkeypatch):
    env_setup(tmp_path, monkeypatch, DEEP_REVIEW_MAX_TOKENS="4096")
    ws = ws_dir(tmp_path)
    corpus = write_corpus(tmp_path / "corpus.md", "# corpus\n")

    def behavior(role, attempt):
        return _cut(reasoning=4096) if attempt == 1 else _ok(make_leads_json(role))

    calls = patch_transport(monkeypatch, tmp_path, behavior=behavior)
    assert run_main(tmp_path, ws, corpus) == 0
    for role in ROLES:
        role_calls = [c for c in calls if c[0] == role]
        assert len(role_calls) == 2
        assert role_calls[0][2]["max_tokens"] == 4096
        assert role_calls[1][2]["max_tokens"] == 16384
    by_role = {r["role"]: r for r in aggregate(ws)["roles"]}
    for role in ROLES:
        entry = by_role[role]
        assert entry["status"] == "ok"
        assert entry["lead_count"] == 1
        assert entry["overrun_retry"] is True
        assert entry["retry_max_tokens"] == 16384


def test_retry_that_also_overruns_stays_degraded_without_third_attempt(tmp_path, monkeypatch):
    env_setup(tmp_path, monkeypatch, DEEP_REVIEW_MAX_TOKENS="4096")
    ws = ws_dir(tmp_path)
    corpus = write_corpus(tmp_path / "corpus.md", "# corpus\n")
    calls = patch_transport(monkeypatch, tmp_path, behavior=lambda role, attempt: _cut())
    assert run_main(tmp_path, ws, corpus) == 0
    for role in ROLES:
        assert len([c for c in calls if c[0] == role]) == 2
    for entry in aggregate(ws)["roles"]:
        assert entry["status"] == "degraded"
        assert entry["lead_count"] == 0
        assert entry["overrun_retry"] is True


def test_stop_finish_reason_is_never_retried(tmp_path, monkeypatch):
    env_setup(tmp_path, monkeypatch)
    ws = ws_dir(tmp_path)
    corpus = write_corpus(tmp_path / "corpus.md", "# corpus\n")
    calls = patch_transport(monkeypatch, tmp_path, behavior=lambda role, attempt: _ok(""))
    assert run_main(tmp_path, ws, corpus) == 0
    assert len(calls) == len(ROLES)
    for entry in aggregate(ws)["roles"]:
        assert entry["overrun_retry"] is False
        assert entry["retry_max_tokens"] is None


def test_length_cut_on_a_complete_answer_is_kept_not_retried(tmp_path, monkeypatch):
    env_setup(tmp_path, monkeypatch)
    ws = ws_dir(tmp_path)
    corpus = write_corpus(tmp_path / "corpus.md", "# corpus\n")
    calls = patch_transport(
        monkeypatch, tmp_path, behavior=lambda role, attempt: _cut(make_leads_json(role))
    )
    assert run_main(tmp_path, ws, corpus) == 0
    assert len(calls) == len(ROLES)
    for entry in aggregate(ws)["roles"]:
        assert entry["status"] == "ok"
        assert entry["lead_count"] == 1
        assert entry["overrun_retry"] is False


def test_reasoning_tokens_recorded_when_reported(tmp_path, monkeypatch):
    env_setup(tmp_path, monkeypatch)
    ws = ws_dir(tmp_path)
    corpus = write_corpus(tmp_path / "corpus.md", "# corpus\n")

    def behavior(role, attempt):
        resp = _ok(make_leads_json(role))
        resp["usage"]["completion_tokens_details"] = {"reasoning_tokens": 120}
        return resp

    patch_transport(monkeypatch, tmp_path, behavior=behavior)
    assert run_main(tmp_path, ws, corpus) == 0
    for entry in aggregate(ws)["roles"]:
        assert entry["usage"]["reasoning_tokens"] == 120
        assert entry["usage"]["completion_tokens"] == 300


def test_log_line_mentions_overrun_retry(tmp_path, monkeypatch, capsys):
    env_setup(tmp_path, monkeypatch, DEEP_REVIEW_MAX_TOKENS="4096")
    ws = ws_dir(tmp_path)
    corpus = write_corpus(tmp_path / "corpus.md", "# corpus\n")
    patch_transport(
        monkeypatch, tmp_path,
        behavior=lambda role, attempt: _cut() if attempt == 1 else _ok(make_leads_json(role)),
    )
    assert run_main(tmp_path, ws, corpus) == 0
    out = capsys.readouterr().out
    assert "specialist correctness: ok" in out
    assert "overrun-retry(max_tokens=16384)" in out


def test_retry_payload_respects_ceiling_and_token_field():
    payload = {"model": "m", "max_completion_tokens": 4096, "messages": []}
    retry = run_specialists._overrun_retry_payload(payload, 4096)
    assert retry["max_completion_tokens"] == 16384
    assert payload["max_completion_tokens"] == 4096
    assert run_specialists._overrun_retry_payload({"max_tokens": 32768}, 32768) is None
    assert run_specialists._overrun_retry_payload({"max_tokens": 10000}, 10000)["max_tokens"] == 32768


def test_anthropic_max_tokens_stop_reason_counts_as_overrun():
    assert run_specialists._completion_overrun({"stop_reason": "max_tokens", "content": []})
    assert not run_specialists._completion_overrun({"stop_reason": "end_turn", "content": []})
    assert not run_specialists._completion_overrun("not a dict")
