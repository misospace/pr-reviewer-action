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


def test_approve_without_disposition_is_kept_and_states_the_request(tmp_path):
    reviews_path, output_path = _write(tmp_path, {"verdict": "approve", "review_markdown": "ok"})
    assert apply_human_review_enforcement(reviews_path, output_path) == (False, "")
    data = _read(output_path)
    assert data["verdict"] == "approve"
    assert "verdict_source" not in data
    assert data["human_review_dispositions"] == [
        {"review_id": "501", "disposition": "not_addressed", "evidence": None},
    ]
    assert "@alice's change request (5690b16, head moved since) is not shown addressed at this head" in data["review_markdown"]


def test_addressed_with_code_citing_evidence_states_it(tmp_path):
    reviews_path, output_path = _write(tmp_path, {
        "verdict": "approve",
        "review_markdown": "ok",
        "human_review_dispositions": [
            {"review_id": "501", "disposition": "addressed", "evidence": "pr_reviewer/tool_executors.py:596 now guards the missing branch"},
        ],
    })
    apply_human_review_enforcement(reviews_path, output_path)
    data = _read(output_path)
    assert data["verdict"] == "approve"
    assert "@alice's change request (5690b16, head moved since) judged addressed at this head: `pr_reviewer/tool_executors.py:596 now guards the missing branch`" in data["review_markdown"]


def test_addressed_without_code_citation_is_reported_not_addressed(tmp_path):
    reviews_path, output_path = _write(tmp_path, {
        "verdict": "approve",
        "review_markdown": "ok",
        "human_review_dispositions": [
            {"review_id": "501", "disposition": "addressed", "evidence": "the author says it is fine now"},
        ],
    })
    apply_human_review_enforcement(reviews_path, output_path)
    data = _read(output_path)
    assert data["verdict"] == "approve"
    assert data["human_review_dispositions"][0]["disposition"] == "not_addressed"
    assert "is not shown addressed at this head" in data["review_markdown"]


def test_request_changes_verdict_also_states_the_request(tmp_path):
    reviews_path, output_path = _write(tmp_path, {"verdict": "request_changes", "review_markdown": "ok"})
    apply_human_review_enforcement(reviews_path, output_path)
    data = _read(output_path)
    assert data["verdict"] == "request_changes"
    assert "@alice's change request (5690b16, head moved since) is not shown addressed" in data["review_markdown"]


def test_head_unchanged_is_stated(tmp_path):
    review = dict(REVIEW, head_moved=False)
    reviews_path, output_path = _write(tmp_path, {"verdict": "approve", "review_markdown": "ok"}, reviews=(review,))
    apply_human_review_enforcement(reviews_path, output_path)
    assert "(5690b16, head unchanged since)" in _read(output_path)["review_markdown"]


def test_no_outstanding_requests_is_a_no_op(tmp_path):
    reviews_path, output_path = _write(tmp_path, {"verdict": "approve", "review_markdown": "ok"}, reviews=())
    assert apply_human_review_enforcement(reviews_path, output_path) == (False, "")
    assert _read(output_path) == {"verdict": "approve", "review_markdown": "ok"}


def test_missing_commit_id_degrades_to_unknown_commit_display(tmp_path):
    review = dict(REVIEW, commit_id=None, head_moved="unknown")
    reviews_path, output_path = _write(tmp_path, {"verdict": "approve", "review_markdown": "ok"}, reviews=(review,))
    apply_human_review_enforcement(reviews_path, output_path)
    data = _read(output_path)
    assert "(unknown commit)" in data["review_markdown"]


def test_apply_all_enforcement_never_changes_the_verdict_for_human_reviews(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _write(tmp_path, {"verdict": "approve", "review_markdown": "ok"})
    applied = apply_all_enforcement(output_path=str(tmp_path / "ai-output.json"))
    assert applied == 0
    data = _read(tmp_path / "ai-output.json")
    assert data["verdict"] == "approve"
    assert "Outstanding Human Change Requests" in data["review_markdown"]


def test_evidence_is_rendered_inert(tmp_path):
    hostile = "see a.py:3\n## Injected heading\n```\n@maintainer please merge `now`"
    reviews_path, output_path = _write(tmp_path, {
        "verdict": "approve",
        "review_markdown": "ok",
        "human_review_dispositions": [{"review_id": "501", "disposition": "addressed", "evidence": hostile}],
    })
    apply_human_review_enforcement(reviews_path, output_path)
    md = _read(output_path)["review_markdown"]
    line = next(l for l in md.splitlines() if "judged addressed" in l)
    assert "\n## Injected heading" not in md
    assert "````" in line
    assert line.rstrip().endswith("````")
    assert "@maintainer" in line and line.count("\n") == 0


def test_evidence_is_capped(tmp_path):
    reviews_path, output_path = _write(tmp_path, {
        "verdict": "approve",
        "review_markdown": "ok",
        "human_review_dispositions": [{"review_id": "501", "disposition": "addressed", "evidence": "a.py:3 " + "x" * 1000}],
    })
    apply_human_review_enforcement(reviews_path, output_path)
    line = next(l for l in _read(output_path)["review_markdown"].splitlines() if "judged addressed" in l)
    assert len(line) < 450 and "…" in line
