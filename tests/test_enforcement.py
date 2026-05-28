"""Tests for pr_reviewer.enforcement."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest import main as unittest_main

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer.enforcement import (
    apply_evidence_blocker_enforcement,
    apply_tool_harness_failure_enforcement,
    apply_tool_min_successful_enforcement,
    normalize_enforced_review_markdown,
    apply_all_enforcement,
    _get_tool_harness_failure_reason,
    _count_successful_requests,
    _harness_requested_tools,
)


class TestApplyEvidenceBlockerEnforcement:
    def test_no_op_when_no_blocker(self, tmp_path):
        evidence = {"has_blocker": False, "providers": []}
        output = {"verdict": "approve", "review_markdown": "LGTM"}

        evidence_path = tmp_path / "evidence-providers.json"
        output_path = tmp_path / "ai-output.json"
        evidence_path.write_text(json.dumps(evidence))
        output_path.write_text(json.dumps(output))

        result = apply_evidence_blocker_enforcement(str(evidence_path), str(output_path))
        assert result == (False, "")
        assert json.loads(output_path.read_text())["verdict"] == "approve"

    def test_enforces_request_changes_with_blocker(self, tmp_path):
        evidence = {
            "has_blocker": True,
            "providers": [
                {"id": "secret-scanner", "provider_severity": "blocker"},
            ],
        }
        output = {"verdict": "approve", "review_markdown": "LGTM"}

        evidence_path = tmp_path / "evidence-providers.json"
        output_path = tmp_path / "ai-output.json"
        evidence_path.write_text(json.dumps(evidence))
        output_path.write_text(json.dumps(output))

        result = apply_evidence_blocker_enforcement(str(evidence_path), str(output_path))
        assert result[0] is True
        assert "secret-scanner" in result[1]
        updated = json.loads(output_path.read_text())
        assert updated["verdict"] == "request_changes"
        assert "blocker-level findings" in updated["review_markdown"]
        assert "secret-scanner" in updated["review_markdown"]

    def test_missing_evidence_file(self, tmp_path):
        output_path = tmp_path / "ai-output.json"
        output_path.write_text(json.dumps({"verdict": "approve", "review_markdown": "ok"}))
        result = apply_evidence_blocker_enforcement(str(tmp_path / "missing.json"), str(output_path))
        assert result == (False, "")

    def test_invalid_json_evidence(self, tmp_path):
        evidence_path = tmp_path / "evidence.json"
        output_path = tmp_path / "ai-output.json"
        evidence_path.write_text("not json")
        output_path.write_text(json.dumps({"verdict": "approve", "review_markdown": "ok"}))
        result = apply_evidence_blocker_enforcement(str(evidence_path), str(output_path))
        assert result == (False, "")


class TestToolHarnessFailure:
    def test_planning_error_detected(self, tmp_path):
        harness = {"planning_error": "timeout after 30s"}
        path = tmp_path / "tool-harness.json"
        path.write_text(json.dumps(harness))
        assert _get_tool_harness_failure_reason(str(path)) == "timeout after 30s"

    def test_error_field_detected(self, tmp_path):
        harness = {"error": "connection refused"}
        path = tmp_path / "tool-harness.json"
        path.write_text(json.dumps(harness))
        assert _get_tool_harness_failure_reason(str(path)) == "connection refused"

    def test_all_requests_failed_detected(self, tmp_path):
        harness = {
            "executed_request_count": 2,
            "tool_results": [
                {"status": "error"},
                {"status": "error"},
            ],
        }
        path = tmp_path / "tool-harness.json"
        path.write_text(json.dumps(harness))
        assert _get_tool_harness_failure_reason(str(path)) == "all tool requests failed"

    def test_partial_failure_not_flagged(self, tmp_path):
        harness = {
            "executed_request_count": 2,
            "tool_results": [
                {"status": "ok"},
                {"status": "error"},
            ],
        }
        path = tmp_path / "tool-harness.json"
        path.write_text(json.dumps(harness))
        assert _get_tool_harness_failure_reason(str(path)) is None

    def test_missing_file(self, tmp_path):
        assert _get_tool_harness_failure_reason(str(tmp_path / "missing.json")) is None

    def test_invalid_json(self, tmp_path):
        path = tmp_path / "bad.json"
        path.write_text("not json")
        assert _get_tool_harness_failure_reason(str(path)) is None


class TestCountSuccessfulRequests:
    def test_counts_ok_status(self, tmp_path):
        harness = {
            "tool_results": [
                {"status": "ok"},
                {"status": "ok"},
                {"status": "error"},
            ],
        }
        path = tmp_path / "tool-harness.json"
        path.write_text(json.dumps(harness))
        assert _count_successful_requests(str(path)) == 2

    def test_empty_results(self, tmp_path):
        harness = {"tool_results": []}
        path = tmp_path / "tool-harness.json"
        path.write_text(json.dumps(harness))
        assert _count_successful_requests(str(path)) == 0


class TestHarnessRequestedTools:
    def test_true_when_planned(self, tmp_path):
        harness = {"planned_request_count": 2, "executed_request_count": 0}
        path = tmp_path / "tool-harness.json"
        path.write_text(json.dumps(harness))
        assert _harness_requested_tools(str(path)) is True

    def test_true_when_executed(self, tmp_path):
        harness = {"planned_request_count": 0, "executed_request_count": 3}
        path = tmp_path / "tool-harness.json"
        path.write_text(json.dumps(harness))
        assert _harness_requested_tools(str(path)) is True

    def test_false_when_none(self, tmp_path):
        harness = {"planned_request_count": 0, "executed_request_count": 0}
        path = tmp_path / "tool-harness.json"
        path.write_text(json.dumps(harness))
        assert _harness_requested_tools(str(path)) is False


class TestApplyToolHarnessFailureEnforcement:
    def test_enforces_on_planning_error(self, tmp_path):
        harness = {"planning_error": "context limit exceeded"}
        output = {"verdict": "approve", "review_markdown": "Looks good"}

        harness_path = tmp_path / "tool-harness.json"
        output_path = tmp_path / "ai-output.json"
        harness_path.write_text(json.dumps(harness))
        output_path.write_text(json.dumps(output))

        result = apply_tool_harness_failure_enforcement(str(harness_path), str(output_path))
        assert result[0] is True
        assert "context limit exceeded" in result[1]
        updated = json.loads(output_path.read_text())
        assert updated["verdict"] == "request_changes"
        assert "context limit exceeded" in updated["review_markdown"]

    def test_no_op_when_no_failure(self, tmp_path):
        harness = {"planned_request_count": 1, "tool_results": [{"status": "ok"}]}
        output = {"verdict": "approve", "review_markdown": "OK"}

        harness_path = tmp_path / "tool-harness.json"
        output_path = tmp_path / "ai-output.json"
        harness_path.write_text(json.dumps(harness))
        output_path.write_text(json.dumps(output))

        result = apply_tool_harness_failure_enforcement(str(harness_path), str(output_path))
        assert result == (False, "")


class TestApplyToolMinSuccessfulEnforcement:
    def test_enforces_when_under_minimum(self, tmp_path):
        harness = {
            "planned_request_count": 3,
            "executed_request_count": 3,
            "tool_results": [{"status": "ok"}, {"status": "error"}, {"status": "error"}],
        }
        output = {"verdict": "approve", "review_markdown": "OK"}

        harness_path = tmp_path / "tool-harness.json"
        output_path = tmp_path / "ai-output.json"
        harness_path.write_text(json.dumps(harness))
        output_path.write_text(json.dumps(output))

        result = apply_tool_min_successful_enforcement(3, str(harness_path), str(output_path))
        assert result[0] is True
        assert "insufficient evidence" in result[1]
        updated = json.loads(output_path.read_text())
        assert updated["verdict"] == "request_changes"
        assert "only 1 succeeded" in updated["review_markdown"]

    def test_no_op_when_at_minimum(self, tmp_path):
        harness = {
            "planned_request_count": 2,
            "tool_results": [{"status": "ok"}, {"status": "ok"}],
        }
        output = {"verdict": "approve", "review_markdown": "OK"}

        harness_path = tmp_path / "tool-harness.json"
        output_path = tmp_path / "ai-output.json"
        harness_path.write_text(json.dumps(harness))
        output_path.write_text(json.dumps(output))

        result = apply_tool_min_successful_enforcement(2, str(harness_path), str(output_path))
        assert result == (False, "")

    def test_no_op_when_no_tools_requested(self, tmp_path):
        harness = {"planned_request_count": 0, "executed_request_count": 0}
        output = {"verdict": "approve", "review_markdown": "OK"}

        harness_path = tmp_path / "tool-harness.json"
        output_path = tmp_path / "ai-output.json"
        harness_path.write_text(json.dumps(harness))
        output_path.write_text(json.dumps(output))

        result = apply_tool_min_successful_enforcement(2, str(harness_path), str(output_path))
        assert result == (False, "")


class TestNormalizeEnforcedReviewMarkdown:
    def test_approve_banner_rewritten(self, tmp_path):
        data = {
            "verdict": "request_changes",
            "review_markdown": "Recommendation: Approve\n\nSome text",
        }
        path = tmp_path / "ai-output.json"
        path.write_text(json.dumps(data))
        normalize_enforced_review_markdown(str(path))
        updated = json.loads(path.read_text())
        assert "Model recommendation before enforcement: Approve" in updated["review_markdown"]

    def test_final_recommendation_prepended(self, tmp_path):
        data = {"verdict": "request_changes", "review_markdown": "Please fix this."}
        path = tmp_path / "ai-output.json"
        path.write_text(json.dumps(data))
        normalize_enforced_review_markdown(str(path))
        updated = json.loads(path.read_text())
        assert updated["review_markdown"].startswith("## Final Recommendation")

    def test_no_op_for_approve(self, tmp_path):
        data = {"verdict": "approve", "review_markdown": "LGTM"}
        path = tmp_path / "ai-output.json"
        path.write_text(json.dumps(data))
        original = path.read_text()
        normalize_enforced_review_markdown(str(path))
        assert path.read_text() == original

    def test_banner_includes_specific_reasons(self, tmp_path):
        data = {
            "verdict": "request_changes",
            "review_markdown": "Recommendation: Approve\n\nLGTM.",
        }
        path = tmp_path / "ai-output.json"
        path.write_text(json.dumps(data))
        reasons = [
            "Tool harness gathered insufficient evidence. Requires 3 but only 1 succeeded.",
            "Evidence provider blocker detected: secret-scanner.",
        ]
        normalize_enforced_review_markdown(str(path), reasons)
        updated = json.loads(path.read_text())
        assert "## Final Recommendation" in updated["review_markdown"]
        assert "insufficient evidence" in updated["review_markdown"]
        assert "Requires 3 but only 1 succeeded" in updated["review_markdown"]
        assert "secret-scanner" in updated["review_markdown"]
        assert "Model recommendation before enforcement: Approve" in updated["review_markdown"]

    def test_banner_uses_generic_when_no_reasons(self, tmp_path):
        data = {"verdict": "request_changes", "review_markdown": "Please fix this."}
        path = tmp_path / "ai-output.json"
        path.write_text(json.dumps(data))
        normalize_enforced_review_markdown(str(path), [])
        updated = json.loads(path.read_text())
        assert "One or more configured enforcement checks" in updated["review_markdown"]

    def test_banner_includes_reasons_when_list_provided(self, tmp_path):
        data = {"verdict": "request_changes", "review_markdown": "Please fix this."}
        path = tmp_path / "ai-output.json"
        path.write_text(json.dumps(data))
        normalize_enforced_review_markdown(str(path), ["specific reason here"])
        updated = json.loads(path.read_text())
        assert "specific reason here" in updated["review_markdown"]


class TestApplyAllEnforcement:
    def test_evidence_blocker_applied(self, tmp_path):
        evidence = {"has_blocker": True, "providers": [{"id": "x", "provider_severity": "blocker"}]}
        output = {"verdict": "approve", "review_markdown": "OK"}

        ep = tmp_path / "evidence-providers.json"
        th = tmp_path / "tool-harness.json"
        out = tmp_path / "ai-output.json"
        ep.write_text(json.dumps(evidence))
        out.write_text(json.dumps(output))

        applied = apply_all_enforcement(
            evidence_blocker_enabled=True,
            tool_failure_enabled=False,
            tool_min_successful=0,
            evidence_path=str(ep),
            tool_harness_path=str(th),
            output_path=str(out),
        )
        assert applied == 1
        updated = json.loads(out.read_text())
        assert updated["verdict"] == "request_changes"
        assert "evidence provider blocker" in updated["review_markdown"].lower()

    def test_tool_harness_failure_includes_reason_in_banner(self, tmp_path):
        harness = {"planning_error": "context limit exceeded"}
        output = {"verdict": "approve", "review_markdown": "Recommendation: Approve\n\nOK"}

        ep = tmp_path / "evidence-providers.json"
        th = tmp_path / "tool-harness.json"
        out = tmp_path / "ai-output.json"
        th.write_text(json.dumps(harness))
        out.write_text(json.dumps(output))

        applied = apply_all_enforcement(
            evidence_blocker_enabled=False,
            tool_failure_enabled=True,
            tool_min_successful=0,
            evidence_path=str(ep),
            tool_harness_path=str(th),
            output_path=str(out),
        )
        assert applied == 1
        updated = json.loads(out.read_text())
        assert updated["verdict"] == "request_changes"
        assert "context limit exceeded" in updated["review_markdown"]
        assert "Model recommendation before enforcement: Approve" in updated["review_markdown"]

    def test_tool_min_successful_includes_reason_in_banner(self, tmp_path):
        harness = {
            "planned_request_count": 3,
            "executed_request_count": 3,
            "tool_results": [{"status": "ok"}, {"status": "error"}, {"status": "error"}],
        }
        output = {"verdict": "approve", "review_markdown": "Recommendation: Approve\n\nOK"}

        ep = tmp_path / "evidence-providers.json"
        th = tmp_path / "tool-harness.json"
        out = tmp_path / "ai-output.json"
        th.write_text(json.dumps(harness))
        out.write_text(json.dumps(output))

        applied = apply_all_enforcement(
            evidence_blocker_enabled=False,
            tool_failure_enabled=True,
            tool_min_successful=3,
            evidence_path=str(ep),
            tool_harness_path=str(th),
            output_path=str(out),
        )
        assert applied == 1
        updated = json.loads(out.read_text())
        assert updated["verdict"] == "request_changes"
        assert "insufficient evidence" in updated["review_markdown"].lower()
        assert "requires at least 3" in updated["review_markdown"].lower()


if __name__ == "__main__":
    unittest_main()