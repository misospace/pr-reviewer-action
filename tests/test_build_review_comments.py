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
    FINDING_MARKER_PREFIX,
    build_comments,
    commentable_lines,
    diff_positions,
    finding_fingerprint,
    finding_marker,
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


class TestFindingFingerprint:
    def test_comment_body_carries_marker(self):
        finding = _finding(line=12)
        comments, _ = build_comments([finding], DIFF)
        assert len(comments) == 1
        assert comments[0]["body"].endswith(finding_marker(finding))
        assert FINDING_MARKER_PREFIX in comments[0]["body"]

    def test_deterministic_and_content_sensitive(self):
        assert finding_fingerprint(_finding()) == finding_fingerprint(_finding())
        assert finding_fingerprint(_finding()) != finding_fingerprint(_finding(line=13))
        assert finding_fingerprint(_finding()) != finding_fingerprint(_finding(message="other"))

    def test_none_file_and_line_fingerprint(self):
        # Carried findings can have file/line of None; must not raise.
        fp = finding_fingerprint(_finding(file=None, line=None))
        assert len(fp) == 16

    def test_marker_roundtrip_preserves_fingerprint(self, tmp_path):
        """A finding fingerprinted at comment time must fingerprint
        identically after the metadata-marker persist/load round-trip
        (jq message[0:200] persist, load_carried_findings re-sanitize)."""
        if str(_REPO_ROOT) not in sys.path:
            sys.path.insert(0, str(_REPO_ROOT))
        from pr_reviewer.carry_forward import load_carried_findings

        # Message long enough that the cut lands on whitespace — the
        # strip-after-truncate edge case.
        long_message = ("a" * 199) + " trailing tail that gets cut off " + ("b" * 50)
        for original in (
            _finding(),
            _finding(message=long_message),
            _finding(file=None, line=None, severity="major", category="bug"),
        ):
            # Simulate build_metadata_marker's open_findings projection.
            persisted = {
                "severity": original["severity"],
                "category": original["category"],
                "file": original["file"],
                "line": original["line"],
                "message": str(original["message"])[:200],
            }
            path = tmp_path / "previous-findings.json"
            path.write_text(json.dumps([persisted]), encoding="utf-8")
            carried = load_carried_findings(str(path))
            assert len(carried) == 1
            assert finding_fingerprint(carried[0]) == finding_fingerprint(original)


class TestSuppression:
    def test_resolved_findings_skipped(self):
        resolved = _finding(line=12)
        resolved["resolution"] = "resolved"
        comments, skipped = build_comments([resolved, _finding(line=13, message="open")], DIFF)
        assert len(comments) == 1
        assert "open" in comments[0]["body"]
        assert skipped == 1

    def test_still_open_carried_findings_not_skipped_without_suppression(self):
        carried = _finding(line=12)
        carried["resolution"] = "still_open"
        carried["carried_over"] = True
        comments, _ = build_comments([carried], DIFF)
        assert len(comments) == 1

    def test_suppressed_fingerprints_skipped(self):
        threaded = _finding(line=12, message="already has a thread")
        fresh = _finding(line=13, message="brand new")
        from build_review_comments import finding_fingerprint

        comments, skipped = build_comments(
            [threaded, fresh], DIFF, suppressed={finding_fingerprint(threaded)}
        )
        assert len(comments) == 1
        assert "brand new" in comments[0]["body"]
        assert skipped == 1

    def test_main_reads_suppression_file_from_env(self, tmp_path, monkeypatch):
        threaded = _finding(line=12, message="already threaded")
        from build_review_comments import finding_fingerprint

        findings_file = tmp_path / "findings.json"
        findings_file.write_text(json.dumps([threaded]))
        diff_file = tmp_path / "pr.diff"
        diff_file.write_text(DIFF)
        suppress_file = tmp_path / "finding-threads.json"
        suppress_file.write_text(json.dumps([finding_fingerprint(threaded)]))
        out_file = tmp_path / "comments.json"
        monkeypatch.setenv("SUPPRESS_FINDINGS_FILE", str(suppress_file))
        assert main(["prog", str(findings_file), str(diff_file), str(out_file)]) == 0
        assert json.loads(out_file.read_text()) == []

    def test_missing_or_garbage_suppression_file_ignored(self, tmp_path, monkeypatch):
        from build_review_comments import load_suppressed_fingerprints

        assert load_suppressed_fingerprints(None) == set()
        assert load_suppressed_fingerprints(str(tmp_path / "absent.json")) == set()
        garbage = tmp_path / "garbage.json"
        garbage.write_text("not json")
        assert load_suppressed_fingerprints(str(garbage)) == set()
        not_list = tmp_path / "obj.json"
        not_list.write_text('{"a": 1}')
        assert load_suppressed_fingerprints(str(not_list)) == set()


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

    def test_inline_findings_input_declared(self):
        assert "inline_findings:" in self.ACTION
        assert "inline_findings_max:" in self.ACTION

    def test_all_publish_steps_receive_findings(self):
        # The single publish dispatcher (#303) carries one superset env block
        # serving all three modes (comment, review_comment, review_verdict), so
        # FINDINGS/INLINE_FINDINGS each appear once. FINDINGS lets
        # build_metadata_marker persist open_findings — without it,
        # carry-forward never engages.
        assert self.ACTION.count("FINDINGS: ${{ steps.review.outputs.findings }}") == 1
        assert self.ACTION.count("INLINE_FINDINGS: ${{ inputs.inline_findings }}") == 1

    def test_review_verdict_falls_back_on_failure(self):
        assert "falling back to plain review" in self.ACTION
        assert "submit_native_review APPROVE" in self.ACTION
        assert "submit_native_review REQUEST_CHANGES" in self.ACTION

    def test_inline_review_carries_managed_marker(self):
        # The extra COMMENT review in review_comment mode must carry the
        # marker so cleanup supersedes it on the next run.
        assert "inline-findings-body.md" in self.ACTION


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
