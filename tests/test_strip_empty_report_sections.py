#!/usr/bin/env python3
"""Tests for scripts/strip_empty_report_sections.py.

Regression tests for #409/#414: review_markdown must not carry a Linked Issue
Fit / Evidence Provider Findings / Tool Harness Findings header with "nothing
was found" filler when the corresponding corpus input was actually empty.
Mirrors test_strip_metadata_markers.py's pure-function-first style.
"""

import json
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from strip_empty_report_sections import (  # noqa: E402
    detect_presence,
    strip_empty_sections,
    strip_section,
)

SAMPLE = (
    "## Recommendation\n\nApprove.\n\n"
    "## Standards Compliance\n\n- OK\n\n"
    "## Linked Issue Fit\n\nNo linked issue was present.\n\n"
    "## Evidence Provider Findings\n\nNo evidence provider findings were present.\n\n"
    "## Tool Harness Findings\n\nNo tool harness findings were present.\n\n"
    "## Unknowns / Needs Verification\n\nNone.\n"
)


class TestStripSection:
    def test_removes_named_section_only(self):
        result = strip_section(SAMPLE, "Linked Issue Fit")
        assert "Linked Issue Fit" not in result
        assert "No linked issue was present" not in result
        assert "## Evidence Provider Findings" in result

    def test_no_match_leaves_text_unchanged(self):
        text = "## Recommendation\n\nApprove.\n"
        assert strip_section(text, "Tool Harness Findings") == text

    def test_case_insensitive_heading_match(self):
        text = "## linked issue fit\n\nNo linked issue was present.\n\n## Next\n\nOK.\n"
        result = strip_section(text, "Linked Issue Fit")
        assert "linked issue fit" not in result.lower()
        assert "## Next" in result


class TestStripEmptySections:
    def test_all_absent_strips_all_three(self):
        result = strip_empty_sections(
            SAMPLE,
            {
                "linked_issue_fit": False,
                "evidence_provider_findings": False,
                "tool_harness_findings": False,
            },
        )
        assert "Linked Issue Fit" not in result
        assert "Evidence Provider Findings" not in result
        assert "Tool Harness Findings" not in result
        # Unrelated sections, including the fourth (Unknowns), are untouched —
        # that one has no clean binary presence signal, stays prompt-only.
        assert "## Recommendation" in result
        assert "## Standards Compliance" in result
        assert "## Unknowns / Needs Verification" in result

    def test_present_sections_are_kept(self):
        result = strip_empty_sections(
            SAMPLE,
            {
                "linked_issue_fit": True,
                "evidence_provider_findings": True,
                "tool_harness_findings": True,
            },
        )
        assert result == SAMPLE

    def test_missing_key_defaults_to_kept(self):
        # A key absent from `present` must not be treated as "absent content" —
        # only an explicit False strips a section.
        assert strip_empty_sections(SAMPLE, {}) == SAMPLE

    def test_collapses_blank_lines_left_by_removal(self):
        result = strip_empty_sections(SAMPLE, {"linked_issue_fit": False})
        assert "\n\n\n" not in result


class TestDetectPresence:
    def test_empty_and_missing_files_read_as_absent(self, tmp_path: Path):
        (tmp_path / "linked-issues.md").write_text("", encoding="utf-8")
        # evidence-providers.md intentionally not created
        (tmp_path / "tool-harness.json").write_text(
            json.dumps({"executed_request_count": 0, "tool_results": []}),
            encoding="utf-8",
        )
        present = detect_presence(tmp_path)
        assert present == {
            "linked_issue_fit": False,
            "evidence_provider_findings": False,
            "tool_harness_findings": False,
        }

    def test_nonempty_files_and_executed_tools_read_as_present(self, tmp_path: Path):
        (tmp_path / "linked-issues.md").write_text("# Issue #1\n...", encoding="utf-8")
        (tmp_path / "evidence-providers.md").write_text("finding: ...", encoding="utf-8")
        (tmp_path / "tool-harness.json").write_text(
            json.dumps({"executed_request_count": 2, "tool_results": [{"tool": "gh_api"}]}),
            encoding="utf-8",
        )
        present = detect_presence(tmp_path)
        assert present == {
            "linked_issue_fit": True,
            "evidence_provider_findings": True,
            "tool_harness_findings": True,
        }

    def test_malformed_tool_harness_json_reads_as_absent(self, tmp_path: Path):
        (tmp_path / "tool-harness.json").write_text("{not json", encoding="utf-8")
        assert detect_presence(tmp_path)["tool_harness_findings"] is False


if __name__ == "__main__":
    import pytest

    pytest.main([__file__, "-v"])
