"""Tests for the outstanding-human-change-request disposition enforcement."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer.enforcement import (  # noqa: E402
    apply_all_enforcement,
    apply_human_review_enforcement,
)

REVIEW = {
    "review_id": "501",
    "login": "alice",
    "commit_id": "5690b16fabcdef0123456789abcdef0123456789",
    "head_moved": True,
    "submitted_at": "2026-09-20T00:00:00Z",
}


def _write(tmp_path, output, reviews=(REVIEW,)):
    reviews_path = tmp_path / "human-reviews.json"
    output_path = tmp_path / "ai-output.json"
    reviews_path.write_text(json.dumps(list(reviews)))
    output_path.write_text(json.dumps(output))
    return str(reviews_path), str(output_path)


def _read(path):
    return json.loads(Path(path).read_text())


def test_no_op_without_outstanding_requests(tmp_path):
    output_path = tmp_path / "ai-output.json"
    output_path.write_text(json.dumps({"verdict": "approve", "review_markdown": "ok"}))
    assert apply_human_review_enforcement(str(tmp_path / "missing.json"), str(output_path)) == (False, "")
    empty = tmp_path / "human-reviews.json"
    empty.write_text("")
    assert apply_human_review_enforcement(str(empty), str(output_path)) == (False, "")
    assert _read(output_path)["verdict"] == "approve"


def test_outstanding_request_and_approve_without_disposition_forces_request_changes(tmp_path):
    reviews_path, output_path = _write(tmp_path, {"verdict": "approve", "review_markdown": "ok"})
    ok, reason = apply_human_review_enforcement(reviews_path, output_path)
    assert ok and "1 outstanding change request(s) not shown addressed" in reason
    data = _read(output_path)
    assert data["verdict"] == "request_changes"
    assert data["verdict_source"] == "human_review"
    assert data["human_review_dispositions"] == [
        {"review_id": "501", "disposition": "not_addressed", "evidence": None},
    ]
    assert "@alice's change request on 5690b16 is outstanding and not shown addressed at this head" in data["review_markdown"]


def test_addressed_with_code_citing_evidence_stays_approve_with_explicit_line(tmp_path):
    reviews_path, output_path = _write(tmp_path, {
        "verdict": "approve",
        "review_markdown": "ok",
        "human_review_dispositions": [
            {"review_id": "501", "disposition": "addressed", "evidence": "pr_reviewer/tool_executors.py:596 now guards the missing branch"},
        ],
    })
    ok, reason = apply_human_review_enforcement(reviews_path, output_path)
    assert ok and "all outstanding change requests judged addressed" in reason
    data = _read(output_path)
    assert data["verdict"] == "approve"
    assert data["human_review_dispositions"] == [
        {"review_id": "501", "disposition": "addressed", "evidence": "pr_reviewer/tool_executors.py:596 now guards the missing branch"},
    ]
    assert "Human change request by @alice (5690b16) judged addressed: pr_reviewer/tool_executors.py:596 now guards the missing branch" in data["review_markdown"]


def test_addressed_without_code_citation_forces_request_changes(tmp_path):
    reviews_path, output_path = _write(tmp_path, {
        "verdict": "approve",
        "review_markdown": "ok",
        "human_review_dispositions": [
            {"review_id": "501", "disposition": "addressed", "evidence": "the author says it is fine now"},
        ],
    })
    ok, reason = apply_human_review_enforcement(reviews_path, output_path)
    assert ok
    data = _read(output_path)
    assert data["verdict"] == "request_changes"
    assert data["human_review_dispositions"][0]["disposition"] == "not_addressed"


def test_request_changes_verdict_is_untouched(tmp_path):
    reviews_path, output_path = _write(tmp_path, {"verdict": "request_changes", "review_markdown": "ok"})
    ok, reason = apply_human_review_enforcement(reviews_path, output_path)
    assert ok is False and reason == ""
    data = _read(output_path)
    assert data["verdict"] == "request_changes"
    assert data["review_markdown"] == "ok"
    # Dispositions are still recorded even though nothing else changes.
    assert data["human_review_dispositions"] == [
        {"review_id": "501", "disposition": "not_addressed", "evidence": None},
    ]


def test_no_outstanding_requests_is_a_no_op(tmp_path):
    reviews_path, output_path = _write(tmp_path, {"verdict": "approve", "review_markdown": "ok"}, reviews=())
    assert apply_human_review_enforcement(reviews_path, output_path) == (False, "")
    assert _read(output_path) == {"verdict": "approve", "review_markdown": "ok"}


def test_missing_commit_id_degrades_to_unknown_commit_display(tmp_path):
    review = dict(REVIEW, commit_id=None, head_moved="unknown")
    reviews_path, output_path = _write(tmp_path, {"verdict": "approve", "review_markdown": "ok"}, reviews=(review,))
    apply_human_review_enforcement(reviews_path, output_path)
    data = _read(output_path)
    assert "unknown commit" in data["review_markdown"]


def test_apply_all_enforcement_runs_human_review_pass(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _write(tmp_path, {"verdict": "approve", "review_markdown": "ok"})
    applied = apply_all_enforcement(output_path=str(tmp_path / "ai-output.json"))
    assert applied == 1
    assert _read(tmp_path / "ai-output.json")["verdict"] == "request_changes"
