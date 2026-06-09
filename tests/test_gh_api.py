#!/usr/bin/env python3
"""Tests for the gh_api tool in run_tool_harness.py."""

import os
import sys
from pathlib import Path

# Ensure the scripts directory is on sys.path.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from run_tool_harness import gh_api  # noqa: E402


class TestGhApiRepoParsing:
    """Test that gh_api correctly parses repo keys from various endpoint formats."""

    def _setup_env(self):
        os.environ["GH_TOKEN"] = "test-token"

    def test_repos_prefix_current_repo(self):
        """Endpoint with 'repos/' prefix matching current repo should be allowed."""
        self._setup_env()
        result = gh_api(
            "repos/misospace/pr-reviewer-action/pulls/1",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert result.get("error") is None or "Repo not allowed" not in (result.get("error") or ""), (
            f"Current repo with repos/ prefix should be allowed: {result}"
        )

    def test_direct_path_current_repo(self):
        """Direct owner/repo path matching current repo should be allowed."""
        self._setup_env()
        result = gh_api(
            "misospace/pr-reviewer-action/pulls/1",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert result.get("error") is None or "Repo not allowed" not in (result.get("error") or ""), (
            f"Current repo with direct path should be allowed: {result}"
        )

    def test_repos_prefix_explicit_allowed_repo(self):
        """Endpoint with 'repos/' prefix for an explicitly allowed repo should pass allowlist."""
        self._setup_env()
        result = gh_api(
            "repos/other-org/other-repo/issues",
            allowed_repos={"other-org/other-repo"},
            current_repo="misospace/pr-reviewer-action",
        )
        assert result.get("error") is None or "Repo not allowed" not in (result.get("error") or ""), (
            f"Explicitly allowed repo with repos/ prefix should be allowed: {result}"
        )

    def test_direct_path_explicit_allowed_repo(self):
        """Direct path for an explicitly allowed repo should pass allowlist."""
        self._setup_env()
        result = gh_api(
            "other-org/other-repo/issues",
            allowed_repos={"other-org/other-repo"},
            current_repo="misospace/pr-reviewer-action",
        )
        assert result.get("error") is None or "Repo not allowed" not in (result.get("error") or ""), (
            f"Explicitly allowed repo with direct path should be allowed: {result}"
        )

    def test_wildcard_allows_any_repo(self):
        """Wildcard '*' in allowed_repos should permit any repo."""
        self._setup_env()
        result = gh_api(
            "repos/any-org/any-repo/pulls",
            allowed_repos={"*"},
            current_repo="misospace/pr-reviewer-action",
        )
        assert result.get("error") is None or "Repo not allowed" not in (result.get("error") or ""), (
            f"Wildcard should allow any repo: {result}"
        )

    def test_denied_repo_rejected(self):
        """Repos not in current_repo, not in allowed_repos, and no wildcard should be rejected."""
        self._setup_env()
        result = gh_api(
            "repos/unknown-org/unknown-repo/issues",
            allowed_repos={"other-org/other-repo"},
            current_repo="misospace/pr-reviewer-action",
        )
        assert "Repo not allowed" in (result.get("error") or ""), (
            f"Disallowed repo should be rejected: {result}"
        )

    def test_denied_secrets_path_blocked(self):
        """Paths containing '/actions/secrets' should be denied regardless of repo."""
        self._setup_env()
        result = gh_api(
            "repos/misospace/pr-reviewer-action/actions/secrets",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "Path segment denied" in (result.get("error") or ""), (
            f"Secrets path should be denied: {result}"
        )

    def test_denied_environments_path_blocked(self):
        """Paths containing '/environments/' should be denied regardless of repo."""
        self._setup_env()
        result = gh_api(
            "repos/misospace/pr-reviewer-action/environments/prod",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "Path segment denied" in (result.get("error") or ""), (
            f"Environments path should be denied: {result}"
        )

    def test_denied_dispatches_path_blocked(self):
        """Paths containing '/dispatches' should be denied regardless of repo."""
        self._setup_env()
        result = gh_api(
            "repos/misospace/pr-reviewer-action/actions/dispatches",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "Path segment denied" in (result.get("error") or ""), (
            f"Dispatches path should be denied: {result}"
        )

    def test_no_token_returns_error(self):
        """Missing GH_TOKEN and GITHUB_TOKEN should return an error."""
        saved = {}
        for var in ("GH_TOKEN", "GITHUB_TOKEN"):
            if var in os.environ:
                saved[var] = os.environ[var]
                del os.environ[var]
        try:
            result = gh_api(
                "misospace/pr-reviewer-action/pulls/1",
                allowed_repos=set(),
                current_repo="misospace/pr-reviewer-action",
            )
            assert "Missing GH_TOKEN" in (result.get("error") or ""), (
                f"Missing token should return error: {result}"
            )
        finally:
            for var, val in saved.items():
                os.environ[var] = val

    def test_short_endpoint_returns_error(self):
        """Endpoints with fewer than 2 path segments should return an error."""
        self._setup_env()
        result = gh_api(
            "only-one-segment",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "Invalid endpoint format" in (result.get("error") or ""), (
            f"Short endpoint should return error: {result}"
        )


class TestGhApiPathValidation:
    """Test that gh_api enforces character, dot-segment, and prefix restrictions."""

    def _setup_env(self):
        os.environ["GH_TOKEN"] = "test-token"

    def test_disallowed_characters_rejected(self):
        """Endpoints with spaces or special chars should be rejected."""
        self._setup_env()
        result = gh_api(
            "repos/misospace/pr-reviewer-action/pulls/1 comment",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "disallowed characters" in (result.get("error") or "").lower(), (
            f"Endpoint with spaces should be rejected: {result}"
        )

    def test_null_byte_rejected(self):
        """Endpoints with null bytes should be rejected."""
        self._setup_env()
        result = gh_api(
            "repos/misospace/pr-reviewer-action/pulls/1\x00",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert result.get("error") is not None, (
            f"Endpoint with null byte should be rejected: {result}"
        )

    def test_parent_directory_traversal_rejected(self):
        """Endpoints containing '..' segment should be rejected."""
        self._setup_env()
        result = gh_api(
            "repos/misospace/../pr-reviewer-action/pulls/1",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "dot" in (result.get("error") or "").lower(), (
            f"Dot-segment '..' should be rejected: {result}"
        )

    def test_current_directory_segment_rejected(self):
        """Endpoints containing '.' segment should be rejected."""
        self._setup_env()
        result = gh_api(
            "repos/./misospace/pr-reviewer-action/pulls/1",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "dot-segment" in (result.get("error") or "").lower(), (
            f"Dot-segment '.' should be rejected: {result}"
        )

    def test_dot_in_path_component_allowed(self):
        """Dots inside non-traversal components (release tags, repos) are allowed.

        Only ".", ".." and empty segments are rejected. A request like
        releases/tags/v1.2.3 may still fail on the network call (test token),
        but it must not be rejected for containing dots.
        """
        self._setup_env()
        result = gh_api(
            "repos/misospace/pr-reviewer-action/releases/tags/v1.2.3",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "dot" not in (result.get("error") or "").lower(), (
            f"Dots in non-traversal components should be allowed: {result}"
        )

    def test_empty_segment_rejected(self):
        """Endpoints producing an empty path segment ('//') should be rejected."""
        self._setup_env()
        result = gh_api(
            "repos/misospace//pulls/1",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "dot-segment" in (result.get("error") or "").lower(), (
            f"Empty segment should be rejected: {result}"
        )

    def test_unallowed_prefix_rejected(self):
        """Endpoints not starting with an allowed prefix should be rejected."""
        self._setup_env()
        result = gh_api(
            "user/misospace/emails",
            allowed_repos={"misospace/pr-reviewer-action"},
            current_repo="misospace/pr-reviewer-action",
        )
        assert "not allowed" in (result.get("error") or "").lower(), (
            f"Unallowed prefix should be rejected: {result}"
        )

    def test_allowed_repos_prefix_passes(self):
        """Endpoints starting with /repos/ should pass prefix check."""
        self._setup_env()
        result = gh_api(
            "repos/misospace/pr-reviewer-action/pulls/1",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "prefix not allowed" not in (result.get("error") or "").lower(), (
            f"/repos/ prefix should be allowed: {result}"
        )

    def test_allowed_issues_prefix_passes(self):
        """Endpoints starting with /issues/ should pass prefix check."""
        self._setup_env()
        result = gh_api(
            "issues/misospace/pr-reviewer-action/comments",
            allowed_repos={"misospace/pr-reviewer-action"},
            current_repo="other/repo",
        )
        assert "prefix not allowed" not in (result.get("error") or "").lower(), (
            f"/issues/ prefix should be allowed: {result}"
        )

    def test_allowed_search_prefix_passes(self):
        """Endpoints starting with /search/ should pass prefix check."""
        self._setup_env()
        result = gh_api(
            "search/code?q=foo",
            allowed_repos={"misospace/pr-reviewer-action"},
            current_repo="misospace/pr-reviewer-action",
        )
        # Note: search endpoints don't have a repo key, so this will fail on
        # repo allowlist check, but should pass the prefix check
        err = result.get("error") or ""
        assert "prefix not allowed" not in err.lower(), (
            f"/search/ prefix should be allowed: {result}"
        )

    def test_allowed_releases_prefix_passes(self):
        """Endpoints starting with /releases/ should pass prefix check."""
        self._setup_env()
        result = gh_api(
            "releases/misospace/pr-reviewer-action/tags",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "prefix not allowed" not in (result.get("error") or "").lower(), (
            f"/releases/ prefix should be allowed: {result}"
        )


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
