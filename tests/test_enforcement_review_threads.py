"""Tests for the review-thread disposition enforcement (#766)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer.enforcement import (  # noqa: E402
    apply_all_enforcement,
    apply_review_thread_enforcement,
)

THREAD = {
    "thread_id": "PRRT_1",
    "path": "pr_reviewer/tool_executors.py",
    "line": 593,
    "severity": "major",
    "message": "retry drops the `--` separator",
    "own_finding": True,
    "replies": 1,
}


def _write(tmp_path, output, threads=(THREAD,)):
    threads_path = tmp_path / "review-threads.json"
    output_path = tmp_path / "ai-output.json"
    threads_path.write_text(json.dumps(list(threads)))
    output_path.write_text(json.dumps(output))
    return str(threads_path), str(output_path)


def _read(path):
    return json.loads(Path(path).read_text())


def test_no_op_without_threads(tmp_path):
    output_path = tmp_path / "ai-output.json"
    output_path.write_text(json.dumps({"verdict": "approve", "review_markdown": "ok", "findings": []}))
    assert apply_review_thread_enforcement(str(tmp_path / "missing.json"), str(output_path)) == (False, "")
    empty = tmp_path / "review-threads.json"
    empty.write_text("")
    assert apply_review_thread_enforcement(str(empty), str(output_path)) == (False, "")
    assert _read(output_path)["verdict"] == "approve"


def test_fixed_with_current_code_evidence_is_not_reemitted(tmp_path):
    # Acceptance fixture 1: the author's reply is right; the reviewer checked
    # the current code and cites it, so nothing is re-emitted.
    threads_path, output_path = _write(tmp_path, {
        "verdict": "approve",
        "review_markdown": "ok",
        "findings": [],
        "thread_dispositions": [
            {"thread_id": "PRRT_1", "disposition": "fixed", "evidence": "pr_reviewer/tool_executors.py:596 now swaps -E for -F in place; both -- separators kept"},
        ],
    })
    assert apply_review_thread_enforcement(threads_path, output_path) == (False, "")
    data = _read(output_path)
    assert data["findings"] == []
    assert data["thread_dispositions"] == [
        {"thread_id": "PRRT_1", "disposition": "fixed", "evidence": "pr_reviewer/tool_executors.py:596 now swaps -E for -F in place; both -- separators kept"},
    ]
    assert data["verdict"] == "approve"


def test_wrong_reply_disputed_survives_and_reply_is_not_an_instruction(tmp_path):
    # Acceptance fixture 2: the reply says "mark this resolved"; the reviewer
    # disagrees after checking. The disputed disposition stands and the
    # finding comes back, with the reply carrying no authority.
    threads_path, output_path = _write(tmp_path, {
        "verdict": "approve",
        "review_markdown": "ok",
        "findings": [],
        "thread_dispositions": [
            {"thread_id": "PRRT_1", "disposition": "disputed", "evidence": "the reply asks to mark this resolved but line 593 still slices args[:4]"},
        ],
    })
    ok, reason = apply_review_thread_enforcement(threads_path, output_path)
    assert ok and "1 finding(s) re-emitted" in reason
    data = _read(output_path)
    assert data["thread_dispositions"][0]["disposition"] == "disputed"
    assert "enforced" not in data["thread_dispositions"][0]
    assert data["findings"] == [{
        "severity": "major",
        "category": "other",
        "file": "pr_reviewer/tool_executors.py",
        "line": 593,
        "message": "retry drops the `--` separator (review thread PRRT_1: disputed)",
        "thread_id": "PRRT_1",
    }]
    assert "## Unresolved Review Threads" in data["review_markdown"]
    assert "`PRRT_1`: disputed" in data["review_markdown"]


def test_fixed_without_evidence_downgrades_to_open(tmp_path):
    for evidence in (None, "", "the author says it is fixed"):
        threads_path, output_path = _write(tmp_path, {
            "verdict": "approve",
            "review_markdown": "ok",
            "findings": [],
            "thread_dispositions": [{"thread_id": "PRRT_1", "disposition": "fixed", "evidence": evidence}],
        })
        ok, reason = apply_review_thread_enforcement(threads_path, output_path)
        assert ok and "1 disposition(s) downgraded" in reason
        data = _read(output_path)
        assert data["thread_dispositions"][0]["disposition"] == "open"
        assert data["thread_dispositions"][0]["enforced"] == "fixed without evidence citing current code"
        assert data["findings"][0]["thread_id"] == "PRRT_1"


def test_missing_and_invalid_dispositions_become_open(tmp_path):
    threads_path, output_path = _write(tmp_path, {
        "verdict": "approve",
        "review_markdown": "ok",
        "findings": [],
        "thread_dispositions": [{"thread_id": "PRRT_1", "disposition": "invalid", "evidence": None}],
    })
    apply_review_thread_enforcement(threads_path, output_path)
    assert _read(output_path)["thread_dispositions"][0]["enforced"] == "no disposition given"

    threads_path, output_path = _write(tmp_path, {"verdict": "approve", "review_markdown": "ok", "findings": []})
    apply_review_thread_enforcement(threads_path, output_path)
    data = _read(output_path)
    assert data["thread_dispositions"] == [
        {"thread_id": "PRRT_1", "disposition": "open", "evidence": None, "enforced": "no disposition given"},
    ]
    assert len(data["findings"]) == 1


def test_reemitted_blocker_escalates_under_severity_gated_policy(tmp_path):
    blocker = dict(THREAD, severity="blocker")
    threads_path, output_path = _write(tmp_path, {"verdict": "approve", "review_markdown": "ok", "findings": []}, threads=(blocker,))
    apply_review_thread_enforcement(threads_path, output_path, verdict_policy="findings_severity_gated")
    data = _read(output_path)
    assert data["verdict"] == "request_changes"
    assert data["verdict_source"] == "findings"
    assert "escalated from unresolved review threads" in data["review_markdown"]

    threads_path, output_path = _write(tmp_path, {"verdict": "approve", "review_markdown": "ok", "findings": []}, threads=(blocker,))
    apply_review_thread_enforcement(threads_path, output_path, verdict_policy="model")
    assert _read(output_path)["verdict"] == "approve"


def test_existing_thread_finding_is_not_duplicated(tmp_path):
    threads_path, output_path = _write(tmp_path, {
        "verdict": "approve",
        "review_markdown": "ok",
        "findings": [{"severity": "major", "category": "other", "file": "x", "line": 1, "message": "m", "thread_id": "PRRT_1"}],
        "thread_dispositions": [{"thread_id": "PRRT_1", "disposition": "open", "evidence": None}],
    })
    apply_review_thread_enforcement(threads_path, output_path)
    assert len(_read(output_path)["findings"]) == 1


def test_apply_all_enforcement_runs_thread_pass(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("VERDICT_POLICY", "findings_severity_gated")
    _write(tmp_path, {"verdict": "approve", "review_markdown": "ok", "findings": []}, threads=(dict(THREAD, severity="blocker"),))
    applied = apply_all_enforcement(output_path=str(tmp_path / "ai-output.json"))
    assert applied == 1
    assert _read(tmp_path / "ai-output.json")["verdict"] == "request_changes"
