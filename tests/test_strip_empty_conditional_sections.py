#!/usr/bin/env python3
"""Tests for scripts/strip_empty_conditional_sections.py.

Regression tests for issue #415: when the corpus contains no linked-issue
context / no evidence-provider output, the model still confabulates
"## Linked Issue Fit" / "## Evidence Provider Findings" sections padded with
"nothing was found" filler. A deterministic post-processing step (mirroring
strip_metadata_markers.py) removes those sections using the same presence
signals corpus.sh uses to gate the section headers ([ -s linked-issues.md ],
[ -s evidence-providers.md ]).
"""

import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from strip_empty_conditional_sections import (  # noqa: E402
    strip_empty_conditional_sections,
)

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

PRESENT_ALL = {"linked_issue": True, "evidence_provider": True}
ABSENT_ALL = {"linked_issue": False, "evidence_provider": False}


# ---------------------------------------------------------------------------
# No-op when sections are present (or nothing to strip)
# ---------------------------------------------------------------------------


class TestNoOp:
    def test_empty_input(self):
        assert strip_empty_conditional_sections("", ABSENT_ALL) == ""

    def test_present_sections_are_kept(self):
        """When the corpus signal is present, the section must be preserved."""
        text = (
            "## Summary\n\nLooks good.\n\n"
            "## Linked Issue Fit\n\nImplements the acceptance criteria.\n\n"
            "## Evidence Provider Findings\n\nlint: no issues.\n"
        )
        result = strip_empty_conditional_sections(text, PRESENT_ALL)
        assert result == text

    def test_no_target_sections_unchanged(self):
        """Sections that are not conditional are never touched."""
        text = "## Summary\n\nLGTM.\n\n## Standards Compliance\n\nFollows conventions.\n"
        assert strip_empty_conditional_sections(text, ABSENT_ALL) == text


# ---------------------------------------------------------------------------
# The issue #415 bug: filler sections stripped when signal absent
# ---------------------------------------------------------------------------


class TestStripsAbsentSections:
    def test_strips_linked_issue_fit_when_absent(self):
        """Observed bug: 'No linked issue was present.' filler is removed."""
        text = (
            "## Summary\n\nStandard dependency bump.\n\n"
            "## Linked Issue Fit\n\nNo linked issue was present.\n\n"
            "## Standards Compliance\n\nConventions followed.\n"
        )
        result = strip_empty_conditional_sections(text, ABSENT_ALL)
        assert "Linked Issue Fit" not in result
        assert "No linked issue was present" not in result
        # Surrounding sections survive.
        assert "## Summary" in result
        assert "## Standards Compliance" in result

    def test_strips_evidence_provider_findings_when_absent(self):
        """Observed bug: 'No evidence provider findings were present.' removed."""
        text = (
            "## Summary\n\nStandard dependency bump.\n\n"
            "## Evidence Provider Findings\n\nNo evidence provider findings were present.\n\n"
            "## Standards Compliance\n\nConventions followed.\n"
        )
        result = strip_empty_conditional_sections(text, ABSENT_ALL)
        assert "Evidence Provider Findings" not in result
        assert "No evidence provider findings were present" not in result
        assert "## Summary" in result
        assert "## Standards Compliance" in result

    def test_strips_both_filler_sections_exact_bug(self):
        """The exact two-section confabulation from the #415 report."""
        text = (
            "## Summary\n\nThe PR is a standard Renovate-driven dependency update.\n\n"
            "## Linked Issue Fit\n\nNo linked issue was present. The PR is a standard "
            "Renovate-driven dependency update.\n\n"
            "## Evidence Provider Findings\n\nNo evidence provider findings were present.\n"
        )
        result = strip_empty_conditional_sections(text, ABSENT_ALL)
        assert "Linked Issue Fit" not in result
        assert "Evidence Provider Findings" not in result
        assert "No linked issue was present" not in result
        assert "No evidence provider findings were present" not in result
        # The real summary survives.
        assert "## Summary" in result
        assert "Renovate-driven dependency update" in result

    def test_strips_section_at_end_of_document(self):
        """A target section with no trailing heading is removed to EOF."""
        text = "## Summary\n\nLGTM.\n\n## Linked Issue Fit\n\nNone.\n"
        result = strip_empty_conditional_sections(text, ABSENT_ALL)
        assert "Linked Issue Fit" not in result
        assert "LGTM" in result

    def test_strips_section_with_subheadings(self):
        """Sub-headings (deeper level) under a stripped section are removed too."""
        text = (
            "## Summary\n\nok.\n\n"
            "## Evidence Provider Findings\n\n"
            "### lint\n\nNo findings.\n\n"
            "### audit\n\nClean.\n\n"
            "## Standards Compliance\n\nGood.\n"
        )
        result = strip_empty_conditional_sections(text, ABSENT_ALL)
        assert "Evidence Provider Findings" not in result
        assert "### lint" not in result
        assert "### audit" not in result
        assert "## Standards Compliance" in result


# ---------------------------------------------------------------------------
# Selectivity: one present, one absent
# ---------------------------------------------------------------------------


class TestSelectiveStripping:
    def test_present_linked_absent_evidence(self):
        text = (
            "## Linked Issue Fit\n\nCovers the acceptance criteria.\n\n"
            "## Evidence Provider Findings\n\nNone.\n"
        )
        result = strip_empty_conditional_sections(
            text, {"linked_issue": True, "evidence_provider": False}
        )
        assert "## Linked Issue Fit" in result
        assert "Covers the acceptance criteria." in result
        assert "Evidence Provider Findings" not in result

    def test_absent_linked_present_evidence(self):
        text = (
            "## Linked Issue Fit\n\nNo linked issue.\n\n"
            "## Evidence Provider Findings\n\nlint: clean.\n"
        )
        result = strip_empty_conditional_sections(
            text, {"linked_issue": False, "evidence_provider": True}
        )
        assert "Linked Issue Fit" not in result
        assert "## Evidence Provider Findings" in result
        assert "lint: clean." in result


# ---------------------------------------------------------------------------
# Markdown robustness
# ---------------------------------------------------------------------------


class TestMarkdownRobustness:
    def test_does_not_match_hash_inside_code_fence(self):
        """A '# Linked Issue' line inside a code block is not a real heading."""
        text = (
            "## Summary\n\n```\n## Linked Issue Fit\nnot a heading\n```\n\n"
            "## Standards Compliance\n\nok.\n"
        )
        result = strip_empty_conditional_sections(text, ABSENT_ALL)
        # The line inside the fence is preserved.
        assert "## Linked Issue Fit" in result
        assert "not a heading" in result

    def test_preserves_surrounding_blank_line_layout(self):
        """Stripping doesn't leave huge blank gaps or eat unrelated content."""
        text = (
            "## Summary\n\nA.\n\n"
            "## Linked Issue Fit\n\nNope.\n\n"
            "## Standards Compliance\n\nB.\n"
        )
        result = strip_empty_conditional_sections(text, ABSENT_ALL)
        # No runs of 3+ newlines remain.
        assert "\n\n\n" not in result
        assert "## Summary" in result
        assert "## Standards Compliance" in result

    def test_different_heading_levels(self):
        """Matches ### level headings, not just ##."""
        text = "## Summary\n\nok.\n\n### Linked Issue Fit\n\nnone\n"
        result = strip_empty_conditional_sections(text, ABSENT_ALL)
        assert "Linked Issue Fit" not in result
        assert "## Summary" in result


# ---------------------------------------------------------------------------
# Edge-case inputs (path_handling_changes must_check: null bytes, etc.)
#
# These verify and pin behavior the must_check checklist demands — not because
# the script is a path-handling security boundary (it isn't: it reads one
# trusted path handed to it by publish_helpers.sh, and assert_safe_artifact_paths
# already symlink-guards those artifact paths), but because the classifier flags
# any file-path-accepting script and the behavior should be locked down.
# ---------------------------------------------------------------------------


class TestEdgeCaseInputs:
    def test_null_byte_in_heading_is_still_stripped(self):
        """A null byte embedded in a confabulated heading does not bypass the strip."""
        text = "## Linked Issue Fit\x00extra\n\nfiller.\n\n## Summary\n\nreal.\n"
        result = strip_empty_conditional_sections(text, ABSENT_ALL)
        assert "Linked Issue Fit" not in result
        assert "filler." not in result
        assert "## Summary" in result

    def test_seven_hashes_is_body_not_heading(self):
        """Per CommonMark >6 '#' is not a heading; it must not be treated as a
        section boundary, and must not be stripped as a conditional section."""
        text = "## Summary\n\nok.\n\n####### not a heading, body text\n\n## Standards Compliance\n\nfine.\n"
        result = strip_empty_conditional_sections(text, ABSENT_ALL)
        assert "####### not a heading" in result  # preserved as body
        assert "## Summary" in result
        assert "## Standards Compliance" in result

    def test_empty_file_path_via_cli(self, tmp_path):
        """An empty input file is handled without error (in-place CLI path)."""
        import subprocess
        f = tmp_path / "empty.md"
        f.write_text("")
        r = subprocess.run(
            ["python3", str(_SCRIPTS_DIR / "strip_empty_conditional_sections.py"), str(f)],
            capture_output=True, text=True,
            env={"PATH": "/usr/local/bin:/usr/bin:/bin"},
        )
        assert r.returncode == 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
