#!/usr/bin/env python3
"""Tests for scripts/build_review_comments.py — diff anchoring, filtering,
caps, body sanitization — plus action.yml wiring for inline_findings."""

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = _REPO_ROOT / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import pytest

from build_review_comments import (
    build_comments,
    commentable_lines,
    diff_positions,
    finding_to_body,
    main,
)


DIFF = """\
diff --git a/app/serve.py b/app/serve.py
index 1111111..2222222 100644
--- a/app/serve.py
+++ b/app/serve.py
@@ -10,5 +10,5 @@ def serve():
 context10
 context11
+added12
+added13
 context14
@@ -30,4 +32,4 @@ def other():
 context32
-removed line
+added33
 context34
diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
--- a/old.txt
+++ b/new.txt
@@ -1,2 +1,2 @@
 keep1
+added2
diff --git a/gone.py b/gone.py
deleted file mode 100644
--- a/gone.py
+++ /dev/null
@@ -1,2 +0,0 @@
-bye1
-bye2
"""


def _finding(file="app/serve.py", line=12, severity="blocker", message="bad", category="security"):
    return {"severity": severity, "category": category, "file": file, "line": line, "message": message}


class TestCommentableLines:
    def test_added_and_context_lines_anchorable(self):
        lines = commentable_lines(DIFF)
        assert lines["app/serve.py"] == {10, 11, 12, 13, 14, 32, 33, 34}

    def test_renamed_file_uses_new_path(self):
        lines = commentable_lines(DIFF)
        assert "new.txt" in lines
        assert "old.txt" not in lines
        assert lines["new.txt"] == {1, 2}

    def test_deleted_file_not_anchorable(self):
        assert "gone.py" not in commentable_lines(DIFF)

    def test_empty_diff(self):
        assert commentable_lines("") == {}


class TestDiffPositions:
    def test_tracks_diff_relative_positions_for_forgejo(self):
        positions = diff_positions(DIFF)
        assert positions["app/serve.py"] == {10: 1, 11: 2, 12: 3, 13: 4, 14: 5, 32: 6, 33: 8, 34: 9}
        assert positions["new.txt"] == {1: 1, 2: 2}


class TestBuildComments:
    def test_anchorable_finding_becomes_comment(self):
        comments, skipped = build_comments([_finding(line=12)], DIFF)
        assert skipped == 0
        assert comments == [{
            "path": "app/serve.py",
            "line": 12,
            "side": "RIGHT",
            "body": comments[0]["body"],
        }]
        assert "bad" in comments[0]["body"]
        assert "Blocker" in comments[0]["body"]
        assert "(security)" in comments[0]["body"]

    def test_line_outside_hunks_skipped(self):
        comments, skipped = build_comments([_finding(line=20)], DIFF)
        assert comments == [] and skipped == 1

    def test_file_not_in_diff_skipped(self):
        comments, skipped = build_comments([_finding(file="not/in/diff.py")], DIFF)
        assert comments == [] and skipped == 1

    def test_missing_file_or_line_skipped(self):
        findings = [
            _finding(file=None),
            _finding(line=None),
            {"severity": "info", "message": "no anchor at all"},
        ]
        comments, skipped = build_comments(findings, DIFF)
        assert comments == [] and skipped == 3

    def test_traversal_and_absolute_paths_rejected(self):
        findings = [
            _finding(file="../app/serve.py"),
            _finding(file="/etc/passwd", line=1),
        ]
        comments, skipped = build_comments(findings, DIFF)
        assert comments == [] and skipped == 2

    def test_cap_respected(self):
        findings = [_finding(line=line) for line in (10, 11, 12, 13, 14)]
        comments, _ = build_comments(findings, DIFF, max_comments=3)
        assert len(comments) == 3

    def test_non_list_findings(self):
        assert build_comments("nope", DIFF) == ([], 0)

    def test_non_dict_entries_skipped(self):
        comments, skipped = build_comments(["x", 5, _finding()], DIFF)
        assert len(comments) == 1 and skipped == 2

    def test_forgejo_position_backend_emits_new_position(self, monkeypatch):
        monkeypatch.setenv("REVIEW_COMMENT_POSITION_BACKEND", "forgejo")
        comments, skipped = build_comments([_finding(line=33)], DIFF)
        assert skipped == 0
        assert comments[0]["path"] == "app/serve.py"
        assert comments[0]["new_position"] == 8
        assert "line" not in comments[0]
        assert "side" not in comments[0]


class TestFindingBody:
    def test_mentions_neutralized(self):
        body = finding_to_body(_finding(message="ping @someuser please"))
        assert "@someuser" not in body  # zero-width space inserted after @

    def test_secrets_masked(self):
        body = finding_to_body(
            _finding(message="leaked token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij")
        )
        assert "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij" not in body

    def test_other_category_omitted(self):
        body = finding_to_body(_finding(category="other"))
        assert "(other)" not in body


class TestNoSuppression:
    """#617: fingerprint/suppression machinery is gone. A finding that the
    old suppressed-fingerprint set would have skipped must still yield a
    comment, and inline bodies carry no finding marker."""

    def test_resolved_findings_still_yield_comments(self):
        # A resolution=='resolved' finding used to be skipped; now nothing
        # reads the resolution field, so every anchorable finding comments.
        resolved = _finding(line=12)
        resolved["resolution"] = "resolved"
        comments, skipped = build_comments(
            [resolved, _finding(line=13, message="open")], DIFF
        )
        assert len(comments) == 2
        assert skipped == 0
        assert "bad" in comments[0]["body"]
        assert "open" in comments[1]["body"]

    def test_previously_suppressed_fingerprint_still_yields_comment(self):
        # The finding would have matched the old suppressed-fingerprint set;
        # with the mechanism removed it is emitted like any other.
        threaded = _finding(line=12, message="already has a thread")
        fresh = _finding(line=13, message="brand new")
        comments, skipped = build_comments([threaded, fresh], DIFF)
        assert len(comments) == 2
        assert skipped == 0
        assert "already has a thread" in comments[0]["body"]
        assert "brand new" in comments[1]["body"]

    def test_comment_body_carries_no_finding_marker(self):
        comments, _ = build_comments([_finding(line=12)], DIFF)
        assert len(comments) == 1
        assert "ai-pr-review-finding" not in comments[0]["body"]
        assert "<!--" not in comments[0]["body"]


class TestMainCli:
    def test_end_to_end(self, tmp_path):
        findings_file = tmp_path / "findings.json"
        diff_file = tmp_path / "pr.diff"
        out_file = tmp_path / "comments.json"
        findings_file.write_text(json.dumps([_finding(line=12), _finding(line=999)]))
        diff_file.write_text(DIFF)
        assert main(["prog", str(findings_file), str(diff_file), str(out_file)]) == 0
        comments = json.loads(out_file.read_text())
        assert len(comments) == 1
        assert comments[0]["line"] == 12

    def test_garbage_inputs_produce_empty_array(self, tmp_path):
        findings_file = tmp_path / "findings.json"
        out_file = tmp_path / "comments.json"
        findings_file.write_text("not json")
        assert main(["prog", str(findings_file), str(tmp_path / "missing.diff"), str(out_file)]) == 0
        assert json.loads(out_file.read_text()) == []


class TestActionWiring:
    ACTION = (_REPO_ROOT / "action.yml").read_text()
    # The publish dispatcher shell was extracted from action.yml into
    # scripts/publish.sh (#541); the per-mode assertions target that script.
    PUBLISH = (_REPO_ROOT / "scripts" / "publish.sh").read_text()

    def test_inline_findings_input_declared(self):
        assert "inline_findings:" in self.ACTION
        assert "inline_findings_max:" in self.ACTION

    def test_all_publish_steps_receive_findings(self):
        # The single publish dispatcher (#303) carries one superset env block
        # serving all three modes (comment, review_comment, review_verdict), so
        # FINDINGS/INLINE_FINDINGS each appear once.
        assert self.ACTION.count("FINDINGS: ${{ steps.review.outputs.findings }}") == 1
        assert self.ACTION.count("INLINE_FINDINGS: ${{ inputs.inline_findings }}") == 1

    def test_review_verdict_falls_back_on_failure(self):
        assert "falling back to plain review" in self.PUBLISH
        assert "submit_native_review APPROVE" in self.PUBLISH
        assert "submit_native_review REQUEST_CHANGES" in self.PUBLISH

    def test_inline_review_carries_managed_marker(self):
        # The extra COMMENT review in review_comment mode must carry the
        # marker so cleanup supersedes it on the next run.
        assert "inline-findings-body.md" in self.PUBLISH


if __name__ == "__main__":
    pytest.main([__file__, "-v"])


def test_thread_findings_are_not_posted_inline():
    findings = [
        {"severity": "major", "file": "app/serve.py", "line": 12, "message": "re-emitted", "thread_id": "PRRT_1"},
        {"severity": "major", "file": "app/serve.py", "line": 13, "message": "fresh"},
    ]
    comments, skipped = build_comments(findings, DIFF)
    assert [c["line"] for c in comments] == [13]
    assert skipped == 1
