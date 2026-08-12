#!/usr/bin/env python3
"""Tests for the gh_api tool and the underlying _validate_endpoint helper.

The validator is the security boundary for both backends (GitHub and
Forgejo); if it accepts a path the caller issues a real network request.
These tests therefore exercise ``_validate_endpoint`` directly so they
do not need to mock the HTTP layer, and so a regression in the
validator (e.g. the URL-mangling bug fixed in #469) fails the test
without depending on a live GitHub response.
"""

import os
import sys
from pathlib import Path

# Ensure the scripts directory is on sys.path.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from pr_reviewer.platform import (  # noqa: E402
    _validate_endpoint,
)


def _setup_token():
    os.environ["GH_TOKEN"] = "test-token"


class TestGhApiRepoParsing:
    """Test that _validate_endpoint correctly parses repo keys from various endpoint formats."""

    def test_repos_prefix_current_repo(self):
        """Endpoint with 'repos/' prefix matching current repo should be allowed."""
        _setup_token()
        result = _validate_endpoint(
            "repos/misospace/pr-reviewer-action/pulls/1",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "error" not in result, (
            f"Current repo with repos/ prefix should be allowed: {result}"
        )
        assert result["full_path"] == "/repos/misospace/pr-reviewer-action/pulls/1", (
            f"Unexpected full_path: {result}"
        )
        assert result["repo_key"] == "misospace/pr-reviewer-action", (
            f"Unexpected repo_key: {result}"
        )

    def test_direct_path_current_repo(self):
        """Direct owner/repo path matching current repo should be allowed."""
        _setup_token()
        result = _validate_endpoint(
            "misospace/pr-reviewer-action/pulls/1",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "error" not in result, (
            f"Current repo with direct path should be allowed: {result}"
        )
        assert result["full_path"] == "/repos/misospace/pr-reviewer-action/pulls/1", (
            f"Unexpected full_path: {result}"
        )
        assert result["repo_key"] == "misospace/pr-reviewer-action", (
            f"Unexpected repo_key: {result}"
        )

    def test_repos_prefix_explicit_allowed_repo(self):
        """Endpoint with 'repos/' prefix for an explicitly allowed repo should pass allowlist."""
        _setup_token()
        result = _validate_endpoint(
            "repos/other-org/other-repo/issues",
            allowed_repos={"other-org/other-repo"},
            current_repo="misospace/pr-reviewer-action",
        )
        assert "error" not in result, (
            f"Explicitly allowed repo with repos/ prefix should be allowed: {result}"
        )
        assert result["full_path"] == "/repos/other-org/other-repo/issues", (
            f"Unexpected full_path: {result}"
        )
        assert result["repo_key"] == "other-org/other-repo", (
            f"Unexpected repo_key: {result}"
        )

    def test_direct_path_explicit_allowed_repo(self):
        """Direct path for an explicitly allowed repo should pass allowlist."""
        _setup_token()
        result = _validate_endpoint(
            "other-org/other-repo/issues",
            allowed_repos={"other-org/other-repo"},
            current_repo="misospace/pr-reviewer-action",
        )
        assert "error" not in result, (
            f"Explicitly allowed repo with direct path should be allowed: {result}"
        )
        assert result["full_path"] == "/repos/other-org/other-repo/issues", (
            f"Unexpected full_path: {result}"
        )
        assert result["repo_key"] == "other-org/other-repo", (
            f"Unexpected repo_key: {result}"
        )

    def test_wildcard_allows_any_repo(self):
        """Wildcard '*' in allowed_repos should permit any repo."""
        _setup_token()
        result = _validate_endpoint(
            "repos/any-org/any-repo/pulls",
            allowed_repos={"*"},
            current_repo="misospace/pr-reviewer-action",
        )
        assert "error" not in result, (
            f"Wildcard should allow any repo: {result}"
        )
        assert result["full_path"] == "/repos/any-org/any-repo/pulls", (
            f"Unexpected full_path: {result}"
        )
        assert result["repo_key"] == "any-org/any-repo", (
            f"Unexpected repo_key: {result}"
        )

    def test_denied_repo_rejected(self):
        """Repos not in current_repo, not in allowed_repos, and no wildcard should be rejected."""
        _setup_token()
        result = _validate_endpoint(
            "repos/unknown-org/unknown-repo/issues",
            allowed_repos={"other-org/other-repo"},
            current_repo="misospace/pr-reviewer-action",
        )
        assert "Repo not allowed" in (result.get("error") or ""), (
            f"Disallowed repo should be rejected: {result}"
        )

    def test_denied_secrets_path_blocked(self):
        """Paths containing '/actions/secrets' should be denied regardless of repo."""
        _setup_token()
        result = _validate_endpoint(
            "repos/misospace/pr-reviewer-action/actions/secrets",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "Path segment denied" in (result.get("error") or ""), (
            f"Secrets path should be denied: {result}"
        )

    def test_denied_environments_path_blocked(self):
        """Paths containing '/environments/' should be denied regardless of repo."""
        _setup_token()
        result = _validate_endpoint(
            "repos/misospace/pr-reviewer-action/environments/prod",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "Path segment denied" in (result.get("error") or ""), (
            f"Environments path should be denied: {result}"
        )

    def test_denied_dispatches_path_blocked(self):
        """Paths containing '/dispatches' should be denied regardless of repo."""
        _setup_token()
        result = _validate_endpoint(
            "repos/misospace/pr-reviewer-action/actions/dispatches",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "Path segment denied" in (result.get("error") or ""), (
            f"Dispatches path should be denied: {result}"
        )

    def test_short_endpoint_returns_error(self):
        """Repo-scoped endpoints with fewer than 2 path segments should return an error."""
        _setup_token()
        result = _validate_endpoint(
            "only-one-segment",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "Invalid endpoint format" in (result.get("error") or ""), (
            f"Short endpoint should return error: {result}"
        )


class TestGhApiPathValidation:
    """Test that _validate_endpoint enforces character, dot-segment, and prefix restrictions."""

    def test_disallowed_characters_rejected(self):
        """Endpoints with spaces or special chars should be rejected."""
        _setup_token()
        result = _validate_endpoint(
            "repos/misospace/pr-reviewer-action/pulls/1 comment",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "disallowed characters" in (result.get("error") or "").lower(), (
            f"Endpoint with spaces should be rejected: {result}"
        )

    def test_null_byte_rejected(self):
        """Endpoints with null bytes should be rejected."""
        _setup_token()
        result = _validate_endpoint(
            "repos/misospace/pr-reviewer-action/pulls/1\x00",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert result.get("error") is not None, (
            f"Endpoint with null byte should be rejected: {result}"
        )

    def test_parent_directory_traversal_rejected(self):
        """Endpoints containing '..' segment should be rejected."""
        _setup_token()
        result = _validate_endpoint(
            "repos/misospace/../pr-reviewer-action/pulls/1",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "dot" in (result.get("error") or "").lower(), (
            f"Dot-segment '..' should be rejected: {result}"
        )

    def test_current_directory_segment_rejected(self):
        """Endpoints containing '.' segment should be rejected."""
        _setup_token()
        result = _validate_endpoint(
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
        _setup_token()
        result = _validate_endpoint(
            "repos/misospace/pr-reviewer-action/releases/tags/v1.2.3",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "dot" not in (result.get("error") or "").lower(), (
            f"Dots in non-traversal components should be allowed: {result}"
        )

    def test_empty_segment_rejected(self):
        """Endpoints producing an empty path segment ('//') should be rejected."""
        _setup_token()
        result = _validate_endpoint(
            "repos/misospace//pulls/1",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "dot-segment" in (result.get("error") or "").lower(), (
            f"Empty segment should be rejected: {result}"
        )

    def test_unallowed_prefix_rejected(self):
        """Repo-scoped endpoints not starting with an allowed prefix should be rejected."""
        _setup_token()
        result = _validate_endpoint(
            "user/misospace/emails",
            allowed_repos={"misospace/pr-reviewer-action"},
            current_repo="misospace/pr-reviewer-action",
        )
        assert "not allowed" in (result.get("error") or "").lower(), (
            f"Unallowed prefix should be rejected: {result}"
        )

    def test_repos_prefix_passes(self):
        """Endpoints starting with /repos/ should pass prefix check."""
        _setup_token()
        result = _validate_endpoint(
            "repos/misospace/pr-reviewer-action/pulls/1",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "error" not in result, (
            f"/repos/ prefix should be allowed: {result}"
        )
        assert result["full_path"] == "/repos/misospace/pr-reviewer-action/pulls/1", (
            f"Unexpected full_path: {result}"
        )


class TestGhApiRootEndpoints:
    """Root-level endpoints (no /repos/owner/repo/ segment) — issue #469.

    These are /search/, /issues/, /releases/, /git/ at the API host root.
    They are NOT repo-scoped, so the repo-key allowlist must not reject
    them and the URL must not be mangled into /repos/search/... etc.
    """

    def test_search_under_wildcard(self):
        """Wildcard '*' must NOT mangle /search/ into /repos/search/ (issue #469).

        Pre-fix behaviour: ``search/code?q=foo`` with ``{"*"}`` produced
        ``full_path='/repos/search/code?q=foo'`` (404 against the GitHub
        API). Post-fix: it routes to ``https://api.github.com/search/code?q=foo``.
        """
        _setup_token()
        result = _validate_endpoint(
            "search/code?q=foo",
            allowed_repos={"*"},
            current_repo="misospace/pr-reviewer-action",
        )
        assert "error" not in result, (
            f"/search/ should validate under wildcard: {result}"
        )
        assert result["full_path"] == "/search/code?q=foo", (
            f"Wildcard must not prepend /repos/: {result}"
        )
        assert result["repo_key"] == "", (
            f"Root endpoint repo_key must be empty: {result}"
        )

    def test_search_under_empty_allowlist(self):
        """An empty allowlist (current repo only) must still let /search/ through.

        Pre-fix behaviour: ``search/code?q=foo`` failed with
        "Repo not allowed: search/code?q=foo" because the repo-key check
        ran first. Post-fix: the root-prefix check runs first, the repo
        allowlist is bypassed, and the call is allowed.
        """
        _setup_token()
        result = _validate_endpoint(
            "search/code?q=foo",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "error" not in result, (
            f"/search/ should validate without explicit repo allowlist: {result}"
        )
        assert result["full_path"] == "/search/code?q=foo", (
            f"Empty allowlist must not affect root endpoint: {result}"
        )
        assert result["repo_key"] == "", (
            f"Root endpoint repo_key must be empty: {result}"
        )

    def test_search_with_leading_slash(self):
        """A leading slash on the endpoint is normalised and must work the same."""
        _setup_token()
        result = _validate_endpoint(
            "/search/code?q=foo",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "error" not in result, (
            f"/search/ with leading slash should validate: {result}"
        )
        assert result["full_path"] == "/search/code?q=foo", (
            f"Leading slash must not mangle /search/: {result}"
        )

    def test_search_with_subpath(self):
        """``search/code?q=foo`` and ``search/issues?q=bar`` share the root
        prefix but route to different resources — both must validate
        cleanly with the right ``full_path`` so the GitHub backend hits
        the right endpoint, not a mangled /repos/search/issues/... 404."""
        _setup_token()
        result = _validate_endpoint(
            "search/issues?q=bar",
            allowed_repos={"*"},
            current_repo="misospace/pr-reviewer-action",
        )
        assert "error" not in result, result
        assert result["full_path"] == "/search/issues?q=bar", result
        assert result["repo_key"] == "", result

    def test_git_refs_under_wildcard(self):
        """``/git/refs/...`` is a root-level endpoint and must reach the API
        unchanged under wildcard. The Forgejo translator rejects it (no
        Forgejo equivalent at the root); the GitHub backend must hit
        ``https://api.github.com/git/refs/...``.
        """
        _setup_token()
        result = _validate_endpoint(
            "git/refs/heads/main",
            allowed_repos={"*"},
            current_repo="misospace/pr-reviewer-action",
        )
        assert "error" not in result, (
            f"/git/ under wildcard should pass: {result}"
        )
        assert result["full_path"] == "/git/refs/heads/main", (
            f"Wildcard must not prepend /repos/ to /git/ (issue #469): {result}"
        )
        assert result["repo_key"] == "", (
            f"Root endpoint repo_key must be empty (issue #469): {result}"
        )

    def test_git_refs_without_wildcard_also_passes(self):
        """Root-level endpoints must be allowed even when ``allowed_repos``
        contains a specific repo (no wildcard). The repo allowlist is the
        auth gate; once the user is permitted to call ``gh_api`` at all,
        root endpoints should be reachable.
        """
        _setup_token()
        result = _validate_endpoint(
            "git/refs/heads/main",
            allowed_repos={"misospace/pr-reviewer-action"},
            current_repo="misospace/pr-reviewer-action",
        )
        assert "error" not in result, (
            f"/git/ with explicit repo in allowlist should pass: {result}"
        )
        assert result["full_path"] == "/git/refs/heads/main", (
            f"/git/ full_path must not be mangled: {result}"
        )

    def test_issues_root_endpoint_passes(self):
        """``/issues`` (root, listing all org-wide issues) must reach the API
        without the /repos/ prefix being prepended.
        """
        _setup_token()
        result = _validate_endpoint(
            "/issues",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "error" not in result, (
            f"/issues root endpoint should pass: {result}"
        )
        assert result["full_path"] == "/issues", (
            f"/issues full_path must not be mangled: {result}"
        )
        assert result["repo_key"] == "", (
            f"Root endpoint repo_key must be empty: {result}"
        )

    def test_releases_root_endpoint_passes(self):
        """``/releases`` (root, listing all org-wide releases) must reach the
        API without the /repos/ prefix being prepended.
        """
        _setup_token()
        result = _validate_endpoint(
            "/releases",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "error" not in result, (
            f"/releases root endpoint should pass: {result}"
        )
        assert result["full_path"] == "/releases", (
            f"/releases full_path must not be mangled: {result}"
        )
        assert result["repo_key"] == "", (
            f"Root endpoint repo_key must be empty: {result}"
        )

    def test_root_endpoint_with_dot_segment_still_rejected(self):
        """Root endpoints inherit the dot-segment / unsafe-character guards.
        A path like ``/search/./code`` must be rejected just like
        ``repos/./owner/repo`` is. This guards against the root-prefix
        bypass accidentally relaxing other rules.
        """
        _setup_token()
        result = _validate_endpoint(
            "/search/./code",
            allowed_repos=set(),
            current_repo="misospace/pr-reviewer-action",
        )
        assert "dot" in (result.get("error") or "").lower(), (
            f"Dot-segment in root endpoint should still be rejected: {result}"
        )


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])