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
        """Missing GH_TOKEN should return an error."""
        if "GH_TOKEN" in os.environ:
            del os.environ["GH_TOKEN"]
        result = gh_api(
            "misospace/pr-reviewer-action/pulls/1",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "Missing GH_TOKEN" in (result.get("error") or ""), (
            f"Missing token should return error: {result}"
        )

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


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
