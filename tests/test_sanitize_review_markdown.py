"""Tests for scripts/sanitize_review_markdown.py."""

import pytest
from scripts.sanitize_review_markdown import sanitize_markdown


class TestSanitizePrUrl:
    """Test GitHub PR URL sanitization."""

    def test_single_pr_url(self):
        text = "See https://github.com/itzg/mc-router/pull/552 for details."
        result = sanitize_markdown(text)
        assert "upstream itzg/mc-router PR 552" in result
        assert "https://github.com/itzg/mc-router/pull/552" not in result

    def test_multiple_pr_urls(self):
        text = "PRs https://github.com/a/b/pull/1 and https://github.com/c/d/pull/42."
        result = sanitize_markdown(text)
        assert "upstream a/b PR 1" in result
        # Note: second URL uses different owner/repo so might get different treatment
        assert "upstream c/d PR 42" in result

    def test_pr_url_preserved_in_code_block(self):
        """PR URLs should still be sanitized inside code blocks."""
        text = "```\nhttps://github.com/owner/repo/pull/99\n```"
        result = sanitize_markdown(text)
        assert "upstream owner/repo PR 99" in result


class TestSanitizeIssueUrl:
    """Test GitHub issue URL sanitization."""

    def test_single_issue_url(self):
        text = "Check https://github.com/itzg/mc-router/issues/552."
        result = sanitize_markdown(text)
        assert "upstream itzg/mc-router issue 552" in result
        assert "https://github.com/itzg/mc-router/issues/552" not in result


class TestSanitizeCommitUrl:
    """Test GitHub commit URL sanitization."""

    def test_single_commit_url(self):
        text = "Commit https://github.com/owner/repo/commit/abc1234 is relevant."
        result = sanitize_markdown(text)
        assert "upstream owner/repo commit abc1234" in result
        assert "https://github.com/owner/repo/commit/abc1234" not in result

    def test_long_sha_commit_url(self):
        text = "See https://github.com/owner/repo/commit/abcdef1234567890abcdef1234567890abcdef12."
        result = sanitize_markdown(text)
        assert "upstream owner/repo commit abcdef1234567890abcdef1234567890abcdef12" in result


class TestSanitizeCompareUrl:
    """Test GitHub compare URL sanitization."""

    def test_single_compare_url(self):
        text = "Diff https://github.com/owner/repo/compare/v1.42.1...v1.43.0."
        result = sanitize_markdown(text)
        assert "upstream owner/repo compare v1.42.1...v1.43.0" in result
        assert "https://github.com/owner/repo/compare/v1.42.1...v1.43.0" not in result

    def test_compare_url_with_branch(self):
        text = "See https://github.com/owner/repo/compare/main...feature."
        result = sanitize_markdown(text)
        assert "upstream owner/repo compare main...feature" in result


class TestSanitizeCrossRepoRef:
    """Test cross-repo reference sanitization (owner/repo#123)."""

    def test_single_cross_repo_ref(self):
        text = "itzg/mc-router#552 was fixed upstream."
        result = sanitize_markdown(text)
        assert "itzg/mc-router PR 552" in result
        assert "#552" not in result

    def test_multiple_cross_repo_refs(self):
        text = "See itzg/mc-router#552 and itzg/mc-bridge#527."
        result = sanitize_markdown(text)
        assert "itzg/mc-router PR 552" in result
        assert "itzg/mc-bridge PR 527" in result

    def test_cross_repo_ref_in_list(self):
        text = "- itzg/mc-router#552\n- itzg/mc-router#527\n- itzg/mc-router#542"
        result = sanitize_markdown(text)
        assert "itzg/mc-router PR 552" in result
        assert "itzg/mc-router PR 527" in result
        assert "itzg/mc-router PR 542" in result


class TestSanitizeCurrentRepoRef:
    """Test cross-repo reference sanitization for the current repository."""

    def test_current_repo_cross_repo_ref(self):
        """References to misospace/pr-reviewer-action#123 should be sanitized like any other cross-repo ref."""
        text = "This is tracked in misospace/pr-reviewer-action#42."
        result = sanitize_markdown(text)
        assert "misospace/pr-reviewer-action PR 42" in result
        assert "misospace/pr-reviewer-action#42" not in result

    def test_current_repo_current_proj_backlog(self):
        """References to the current repo should be sanitized uniformly, not special-cased."""
        text = "See misospace/pr-reviewer-action#132 for the original feature request."
        result = sanitize_markdown(text)
        assert "misospace/pr-reviewer-action PR 132" in result
        assert "misospace/pr-reviewer-action#132" not in result

    def test_current_repo_mixed_with_upstream(self):
        """Current-repo refs should be sanitized the same way as upstream refs."""
        text = (
            "Upstream bug itzg/mc-router#552 was resolved. "
            "Tracked in misospace/pr-reviewer-action#42."
        )
        result = sanitize_markdown(text)
        assert "itzg/mc-router PR 552" in result
        assert "misospace/pr-reviewer-action PR 42" in result
        assert "misospace/pr-reviewer-action#42" not in result


class TestSanitizeBareRef:
    """Test bare reference sanitization (#123)."""

    def test_single_bare_ref(self):
        text = "Related to #552 and #527."
        result = sanitize_markdown(text)
        assert "PR 552" in result
        assert "PR 527" in result
        assert "#552" not in result
        assert "#527" not in result

    def test_bare_ref_in_code_block(self):
        """Bare refs inside code blocks should also be sanitized."""
        text = "```\n#552\n#527\n```"
        result = sanitize_markdown(text)
        assert "PR 552" in result
        assert "PR 527" in result

    def test_bare_ref_with_context(self):
        text = "Upstream PRs #552, #527, #542, #546, #547 were included in the release."
        result = sanitize_markdown(text)
        assert "PR 552" in result
        assert "PR 527" in result
        assert "PR 542" in result
        assert "PR 546" in result
        assert "PR 547" in result


class TestReleaseUrlPreservation:
    """Test that release URLs are preserved (safe single links)."""

    def test_release_url_preserved(self):
        text = "See https://github.com/itzg/mc-router/releases/tag/v1.43.0 for the full release."
        result = sanitize_markdown(text)
        assert "https://github.com/itzg/mc-router/releases/tag/v1.43.0" in result

    def test_release_url_with_embedded_pr(self):
        """A release URL whose tag name contains a PR number should stay intact."""
        text = "See https://github.com/itzg/mc-router/releases/tag/v1.43.0-prerelease for notes."
        result = sanitize_markdown(text)
        assert "https://github.com/itzg/mc-router/releases/tag/v1.43.0-prerelease" in result

    def test_release_url_without_tag(self):
        """A releases listing page URL should be preserved."""
        text = "See https://github.com/itzg/mc-router/releases for the full list."
        result = sanitize_markdown(text)
        assert "https://github.com/itzg/mc-router/releases" in result


class TestMarkdownPreservation:
    """Test that legitimate markdown formatting is preserved."""

    def test_headers_preserved(self):
        text = "# Review\n## Findings\n- Item 1\n- Item 2"
        result = sanitize_markdown(text)
        assert "# Review" in result
        assert "## Findings" in result

    def test_code_blocks_preserved(self):
        text = "```\nsome code\n```"
        result = sanitize_markdown(text)
        assert "```" in result
        assert "some code" in result

    def test_file_paths_preserved(self):
        """File paths like src/file.py should not be affected."""
        text = "Changed files: src/main.py, tests/test_main.py"
        result = sanitize_markdown(text)
        assert "src/main.py" in result
        assert "tests/test_main.py" in result

    def test_image_urls_preserved(self):
        """Image URLs should not be affected."""
        text = "![screenshot](https://example.com/image.png)"
        result = sanitize_markdown(text)
        assert "https://example.com/image.png" in result


class TestMixedContent:
    """Test sanitization with mixed content (real-world scenario)."""

    def test_release_notes_summary(self):
        text = (
            "Upstream release assessment:\n"
            "- itzg/mc-router#552 - feature update\n"
            "- itzg/mc-router#527 - bug fix\n"
            "- itzg/mc-router#542 - performance improvement\n"
            "\n"
            "See https://github.com/itzg/mc-router/releases/tag/v1.43.0 for the full release.\n"
            "Compare: https://github.com/itzg/mc-router/compare/v1.42.1...v1.43.0\n"
        )
        result = sanitize_markdown(text)
        assert "itzg/mc-router PR 552" in result
        assert "itzg/mc-router PR 527" in result
        assert "itzg/mc-router PR 542" in result
        assert "https://github.com/itzg/mc-router/releases/tag/v1.43.0" in result
        assert "upstream itzg/mc-router compare v1.42.1...v1.43.0" in result


class TestEdgeCases:
    """Test edge cases and boundary conditions."""

    def test_empty_string(self):
        result = sanitize_markdown("")
        assert result == ""

    def test_no_references(self):
        text = "This is a normal review with no upstream references."
        result = sanitize_markdown(text)
        assert result == text

    def test_only_hash(self):
        """A lone # should not cause issues."""
        text = "# Just a header"
        result = sanitize_markdown(text)
        assert "# Just a header" in result

    def test_ref_at_end_of_line(self):
        text = "See issue #123."
        result = sanitize_markdown(text)
        assert "PR 123" in result

    def test_ref_in_parentheses(self):
        text = "(see #552 for details)"
        result = sanitize_markdown(text)
        assert "PR 552" in result
