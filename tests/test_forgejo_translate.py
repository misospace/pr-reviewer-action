"""Unit tests for ``_forgejo_translate`` — the URL-rewriting table.

These tests cover every endpoint pattern the translation function handles,
ensuring mismatches between GitHub-shaped paths and their Forgejo equivalents
are caught by CI rather than surfacing as silent 404s at runtime.

Fixes #438
"""

import pytest

from pr_reviewer.platform import _forgejo_translate


REPO_KEY = "owner/repo"


# ---------------------------------------------------------------------------
# Pulls (the bulk of gh_api use)
# ---------------------------------------------------------------------------

class TestForgejoTranslatePulls:
    """``/repos/{owner}/{repo}/pulls`` patterns."""

    def test_pulls_list(self):
        result = _forgejo_translate("/repos/owner/repo/pulls", REPO_KEY)
        assert result == "/api/v1/repos/owner/repo/pulls"

    def test_pulls_by_number(self):
        result = _forgejo_translate("/repos/owner/repo/pulls/42", REPO_KEY)
        assert result == "/api/v1/repos/owner/repo/pulls/42"

    def test_pulls_files(self):
        result = _forgejo_translate(
            "/repos/owner/repo/pulls/42/files", REPO_KEY
        )
        assert result == "/api/v1/repos/owner/repo/pulls/42/files"

    def test_pulls_comments(self):
        result = _forgejo_translate(
            "/repos/owner/repo/pulls/42/comments", REPO_KEY
        )
        assert result == "/api/v1/repos/owner/repo/pulls/42/comments"

    def test_pulls_reviews(self):
        result = _forgejo_translate(
            "/repos/owner/repo/pulls/42/reviews", REPO_KEY
        )
        assert result == "/api/v1/repos/owner/repo/pulls/42/reviews"

    def test_pulls_diff(self):
        """``/pulls/N/diff`` maps to ``.diff`` extension on Forgejo."""
        result = _forgejo_translate(
            "/repos/owner/repo/pulls/42/diff", REPO_KEY
        )
        assert result == "/api/v1/repos/owner/repo/pulls/42.diff"


# ---------------------------------------------------------------------------
# Issues and issue comments
# ---------------------------------------------------------------------------

class TestForgejoTranslateIssues:
    """``/repos/{owner}/{repo}/issues`` patterns."""

    def test_issues_list(self):
        result = _forgejo_translate("/repos/owner/repo/issues", REPO_KEY)
        assert result == "/api/v1/repos/owner/repo/issues"

    def test_issues_by_number(self):
        result = _forgejo_translate("/repos/owner/repo/issues/7", REPO_KEY)
        assert result == "/api/v1/repos/owner/repo/issues/7"

    def test_issues_comments(self):
        result = _forgejo_translate(
            "/repos/owner/repo/issues/7/comments", REPO_KEY
        )
        assert result == "/api/v1/repos/owner/repo/issues/7/comments"


# ---------------------------------------------------------------------------
# Compare (incremental scope check)
# ---------------------------------------------------------------------------

class TestForgejoTranslateCompare:
    """``/repos/{owner}/{repo}/compare`` patterns."""

    def test_compare_exact(self):
        result = _forgejo_translate(
            "/repos/owner/repo/compare/main...feature", REPO_KEY
        )
        assert result == "/api/v1/repos/owner/repo/compare/main...feature"

    def test_compare_sha_range(self):
        result = _forgejo_translate(
            "/repos/owner/repo/compare/abc123..def456", REPO_KEY
        )
        assert result == "/api/v1/repos/owner/repo/compare/abc123..def456"


# ---------------------------------------------------------------------------
# Releases (tagged releases)
# ---------------------------------------------------------------------------

class TestForgejoTranslateReleases:
    """``/repos/{owner}/{repo}/releases`` patterns."""

    def test_releases_tags_list(self):
        result = _forgejo_translate(
            "/repos/owner/repo/releases/tags", REPO_KEY
        )
        assert result == "/api/v1/repos/owner/repo/releases/tags"

    def test_releases_tags_by_version(self):
        result = _forgejo_translate(
            "/repos/owner/repo/releases/tags/v1.2.3", REPO_KEY
        )
        assert result == "/api/v1/repos/owner/repo/releases/tags/v1.2.3"


# ---------------------------------------------------------------------------
# Commits and commit status
# ---------------------------------------------------------------------------

class TestForgejoTranslateCommits:
    """``/repos/{owner}/{repo}/commits`` patterns."""

    def test_commits_list(self):
        result = _forgejo_translate("/repos/owner/repo/commits", REPO_KEY)
        assert result == "/api/v1/repos/owner/repo/commits"

    def test_commit_by_sha(self):
        result = _forgejo_translate(
            "/repos/owner/repo/commits/abc123", REPO_KEY
        )
        assert result == "/api/v1/repos/owner/repo/commits/abc123"

    def test_commit_status(self):
        result = _forgejo_translate(
            "/repos/owner/repo/commits/abc123/status", REPO_KEY
        )
        assert result == "/api/v1/repos/owner/repo/commits/abc123/status"


# ---------------------------------------------------------------------------
# Search (root-level, no repo segment)
# ---------------------------------------------------------------------------

class TestForgejoTranslateSearch:
    """``/search/`` patterns — root-level endpoints without repo prefix."""

    def test_search_issues(self):
        result = _forgejo_translate("/search/issues?q=test", "ignored")
        assert result == "/api/v1/search/issues?q=test"

    def test_search_code(self):
        result = _forgejo_translate("/search/code?q=hello", "ignored")
        assert result == "/api/v1/search/code?q=hello"


# ---------------------------------------------------------------------------
# Releases without repo prefix (``/releases/owner/repo/tags``)
# ---------------------------------------------------------------------------

class TestForgejoTranslateReleasesNoRepo:
    """``/releases/{owner}/{repo}/tags`` — no ``/repos/`` prefix.

    The translation splits the tail on the first ``/``, so for
    ``/releases/owner/repo/tags`` the owner is ``owner`` and repo is
    ``repo/tags``, yielding ``/api/v1/repos/owner/repo/tags/releases/tags``.
    """

    def test_releases_tags_no_repo(self):
        result = _forgejo_translate(
            "/releases/owner/repo/tags", "different/key"
        )
        assert result == "/api/v1/repos/owner/repo/tags/releases/tags"


# ---------------------------------------------------------------------------
# Unsupported endpoints (must return None)
# ---------------------------------------------------------------------------

class TestForgejoTranslateUnsupported:
    """Endpoints outside the translation table must return ``None``."""

    def test_gist(self):
        result = _forgejo_translate("/gists", REPO_KEY)
        assert result is None

    def test_unknown_repo_endpoint(self):
        result = _forgejo_translate(
            "/repos/owner/repo/actions/runs", REPO_KEY
        )
        assert result is None

    def test_random_path(self):
        result = _forgejo_translate("/some/random/path", REPO_KEY)
        assert result is None

    def test_releases_no_slash_in_tail(self):
        """``/releases/foo`` without a slash after owner → None."""
        result = _forgejo_translate("/releases/foo", REPO_KEY)
        assert result is None


# ---------------------------------------------------------------------------
# Repo key propagation
# ---------------------------------------------------------------------------

class TestForgejoTranslateRepoKey:
    """Verify the repo_key parameter flows through correctly."""

    def test_custom_repo_key(self):
        result = _forgejo_translate(
            "/repos/myorg/myrepo/pulls/1", "myorg/myrepo"
        )
        assert result == "/api/v1/repos/myorg/myrepo/pulls/1"
