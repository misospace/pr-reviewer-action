#!/usr/bin/env python3
"""Tests for pr_reviewer.escalation — fast→smart escalation triggers (#160)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

import pytest

from pr_reviewer.escalation import (
    count_changed_lines,
    is_low_confidence,
    should_escalate,
)


GOOD_REVIEW = (
    "## Recommendation\nApprove.\n\n"
    "The auth flow is unchanged for existing sessions and token rotation is "
    "preserved. Path sanitization uses realpath with containment checks, so "
    "directory traversal via ../ or symlinks is rejected. Tests cover the new "
    "edge cases and the migration carries no destructive statements.\n\n"
    "## Standards Compliance\nFollows repository conventions throughout."
)


def _write_fast_output(tmp_path, verdict="approve", review=GOOD_REVIEW):
    (tmp_path / "ai-output.json").write_text(
        json.dumps({"verdict": verdict, "review_markdown": review})
    )


def _write_classification(tmp_path, must_check=None):
    (tmp_path / "classification.json").write_text(
        json.dumps({"pr_kind": "app_code", "must_check": must_check or []})
    )


class TestIsLowConfidence:
    def test_substantial_review_is_confident(self):
        assert is_low_confidence(GOOD_REVIEW) is False

    def test_tiny_review_is_low_confidence(self):
        assert is_low_confidence("LGTM, approve.") is True

    def test_populated_unknowns_section_is_low_confidence(self):
        review = GOOD_REVIEW + (
            "\n\n## Unknowns or Needs Verification\n"
            "Could not verify the upstream release notes; the changelog fetch "
            "failed and the compare endpoint returned an error."
        )
        assert is_low_confidence(review) is True

    def test_empty_unknowns_section_is_confident(self):
        review = GOOD_REVIEW + "\n\n## Unknowns or Needs Verification\nNone."
        assert is_low_confidence(review) is False

    def test_unknowns_followed_by_next_header_only(self):
        review = GOOD_REVIEW + "\n\n## Unknowns\nN/A\n\n## Sources\n- corpus"
        assert is_low_confidence(review) is False


class TestShouldEscalate:
    def test_clean_confident_review_does_not_escalate(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_fast_output(tmp_path)
        _write_classification(tmp_path)
        escalate, reasons = should_escalate()
        assert escalate is False and reasons == []

    def test_request_changes_triggers(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_fast_output(tmp_path, verdict="request_changes")
        _write_classification(tmp_path)
        escalate, reasons = should_escalate()
        assert escalate is True
        assert "fast_request_changes" in reasons

    def test_request_changes_trigger_can_be_disabled(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_fast_output(tmp_path, verdict="request_changes")
        _write_classification(tmp_path)
        escalate, reasons = should_escalate(on_request_changes=False)
        assert escalate is False

    def test_incomplete_required_checks_trigger(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_fast_output(
            tmp_path,
            review="A long enough review that talks about code style and naming "
            "conventions in detail but never the required security topics. "
            "It rambles for a while to clear the low-confidence length bar "
            "and looks plausible without addressing what matters here.",
        )
        _write_classification(
            tmp_path, must_check=["verify file path sanitization"]
        )
        escalate, reasons = should_escalate()
        assert "incomplete_required_checks" in reasons

    def test_low_confidence_trigger(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_fast_output(tmp_path, review="Approve. Short.")
        _write_classification(tmp_path)
        escalate, reasons = should_escalate()
        assert "fast_low_confidence" in reasons

    def test_evidence_blocker_trigger(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_fast_output(tmp_path)
        _write_classification(tmp_path)
        (tmp_path / "evidence-providers.json").write_text(
            json.dumps({"has_blocker": True, "providers": []})
        )
        escalate, reasons = should_escalate()
        assert reasons == ["tool_or_evidence_blockers"]

    def test_planning_failure_does_not_escalate_by_default(self, tmp_path, monkeypatch):
        """A failed planning call means the review ran with less evidence —
        the same situation as tool_mode 'off' — not elevated risk (#215)."""
        monkeypatch.chdir(tmp_path)
        _write_fast_output(tmp_path)
        _write_classification(tmp_path)
        (tmp_path / "tool-harness.json").write_text(
            json.dumps({"planning_error": "planner timed out", "tool_results": []})
        )
        escalate, reasons = should_escalate()
        assert escalate is False and reasons == []

    def test_planning_failure_escalates_when_opted_in(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_fast_output(tmp_path)
        _write_classification(tmp_path)
        (tmp_path / "tool-harness.json").write_text(
            json.dumps({"planning_error": "planner timed out", "tool_results": []})
        )
        escalate, reasons = should_escalate(on_planning_failure=True)
        assert reasons == ["tool_planning_failed"]

    def test_harness_hard_error_does_not_escalate_by_default(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_fast_output(tmp_path)
        _write_classification(tmp_path)
        (tmp_path / "tool-harness.json").write_text(
            json.dumps({"error": "harness crashed", "tool_results": []})
        )
        escalate, reasons = should_escalate()
        assert escalate is False
        escalate, reasons = should_escalate(on_planning_failure=True)
        assert reasons == ["tool_planning_failed"]

    def test_all_tool_requests_failed_trigger(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_fast_output(tmp_path)
        _write_classification(tmp_path)
        (tmp_path / "tool-harness.json").write_text(
            json.dumps({
                "executed_request_count": 2,
                "tool_results": [{"status": "error"}, {"status": "error"}],
            })
        )
        escalate, reasons = should_escalate()
        assert reasons == ["tool_or_evidence_blockers"]

    def test_multiple_reasons_accumulate(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_fast_output(tmp_path, verdict="request_changes", review="Too short.")
        _write_classification(tmp_path)
        escalate, reasons = should_escalate()
        assert escalate is True
        assert set(reasons) >= {"fast_request_changes", "fast_low_confidence"}

    def test_all_triggers_disabled(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_fast_output(tmp_path, verdict="request_changes", review="Short.")
        _write_classification(tmp_path, must_check=["verify file path sanitization"])
        escalate, reasons = should_escalate(
            on_incomplete=False,
            on_request_changes=False,
            on_low_confidence=False,
            on_blockers=False,
        )
        assert escalate is False and reasons == []

    def test_missing_files_do_not_escalate(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_fast_output(tmp_path)
        escalate, reasons = should_escalate()
        assert escalate is False


TRIVIAL_DIFF = """\
diff --git a/kubernetes/apps/base/flux-system/konflate/helmrelease.yaml b/kubernetes/apps/base/flux-system/konflate/helmrelease.yaml
--- a/kubernetes/apps/base/flux-system/konflate/helmrelease.yaml
+++ b/kubernetes/apps/base/flux-system/konflate/helmrelease.yaml
@@ -10,7 +10,7 @@ spec:
     operation: copy
   ref:
-    tag: 0.2.7
+    tag: 0.2.8
   url: oci://ghcr.io/home-operations/charts/konflate
"""

# Short but real: a correct review of a one-line bump (#215).
SHORT_BUMP_REVIEW = (
    "Approve. Renovate patch bump of the konflate chart, 0.2.7 to 0.2.8; "
    "no functional manifest changes."
)


class TestCountChangedLines:
    def test_counts_only_change_lines(self, tmp_path):
        path = tmp_path / "pr.diff"
        path.write_text(TRIVIAL_DIFF)
        assert count_changed_lines(str(path)) == 2

    def test_missing_diff_is_none(self, tmp_path):
        assert count_changed_lines(str(tmp_path / "absent.diff")) is None

    def test_empty_diff_is_zero(self, tmp_path):
        path = tmp_path / "pr.diff"
        path.write_text("")
        assert count_changed_lines(str(path)) == 0


class TestTrivialDiffLowConfidence:
    def test_short_review_of_trivial_diff_does_not_escalate(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_fast_output(tmp_path, review=SHORT_BUMP_REVIEW)
        _write_classification(tmp_path)
        (tmp_path / "pr.diff").write_text(TRIVIAL_DIFF)
        escalate, reasons = should_escalate()
        assert escalate is False and reasons == []

    def test_bare_lgtm_still_escalates_on_trivial_diff(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_fast_output(tmp_path, review="LGTM.")
        _write_classification(tmp_path)
        (tmp_path / "pr.diff").write_text(TRIVIAL_DIFF)
        escalate, reasons = should_escalate()
        assert "fast_low_confidence" in reasons

    def test_short_review_of_large_diff_still_escalates(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_fast_output(tmp_path, review=SHORT_BUMP_REVIEW)
        _write_classification(tmp_path)
        big = TRIVIAL_DIFF + "".join(f"+added line {i}\n" for i in range(40))
        (tmp_path / "pr.diff").write_text(big)
        escalate, reasons = should_escalate()
        assert "fast_low_confidence" in reasons

    def test_missing_diff_fails_closed_to_standard_threshold(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_fast_output(tmp_path, review=SHORT_BUMP_REVIEW)
        _write_classification(tmp_path)
        escalate, reasons = should_escalate()
        assert "fast_low_confidence" in reasons

    def test_unknowns_section_escalates_even_on_trivial_diff(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        review = SHORT_BUMP_REVIEW + (
            "\n\n## Unknowns or Needs Verification\n"
            "Could not verify the upstream changelog; the release fetch failed "
            "and the compare endpoint returned an error."
        )
        _write_fast_output(tmp_path, review=review)
        _write_classification(tmp_path)
        (tmp_path / "pr.diff").write_text(TRIVIAL_DIFF)
        escalate, reasons = should_escalate()
        assert "fast_low_confidence" in reasons


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
