#!/usr/bin/env python3
"""Tests for the Forgejo REST backend.

Uses unittest.mock.patch to intercept _curl calls, avoiding the need for a
live HTTP server or subprocess mocking.  Mirrors the structure and coverage
of the existing fake-gh test suites.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch
from urllib.parse import quote as _url_quote

# Ensure the project root is on sys.path so we can import pr_reviewer modules.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

import pr_reviewer.forgejo_backend as fb  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

COMMENT_MARKER = "<!-- ai-pr-reviewer -->"

# Field shapes verified against a live Forgejo instance (Codeberg /api/v1):
# the PR object uses number/state/draft, and head/base are
# {label, ref, repo, repo_id, sha} with repo.full_name carrying identity.
PR_META = {
    "number": 42,
    "title": "Add new feature",
    "body": "This PR adds the new feature.\n\nFixes #100",
    "state": "open",
    "user": {"login": "contributor"},
    "head": {
        "label": "feature-branch",
        "ref": "feature-branch",
        "sha": "abc123def456",
        "repo_id": 7,
        "repo": {"full_name": "misospace/pr-reviewer-action"},
    },
    "base": {
        "label": "main",
        "ref": "main",
        "sha": "789xyz000",
        "repo_id": 7,
        "repo": {"full_name": "misospace/pr-reviewer-action"},
    },
    "merged_at": None,
    "created_at": "2026-06-11T10:00:00Z",
    "updated_at": "2026-06-11T12:00:00Z",
    "html_url": "https://forgejo.example.com/misospace/pr-reviewer-action/pulls/42",
    "draft": False,
    "labels": [{"name": "enhancement"}],
}

# A fork PR: head.repo is the fork, base.repo the upstream.
FORK_PR_META = dict(
    PR_META,
    number=43,
    head={
        "label": "outsider:feature",
        "ref": "feature",
        "sha": "f0f0f0f0f0f0",
        "repo_id": 99,
        "repo": {"full_name": "outsider/pr-reviewer-action"},
    },
)

# A fork PR whose fork repo was deleted: head.repo comes back null.
DELETED_FORK_PR_META = dict(
    FORK_PR_META,
    number=44,
    head={"label": "unknown", "ref": "feature", "sha": "dead00000000", "repo_id": 0, "repo": None},
)

PR_DIFF = (
    "diff --git a/test.txt b/test.txt\n"
    "index 1234567..abcdefg 100644\n"
    "--- a/test.txt\n"
    "+++ b/test.txt\n"
    "@@ -1 +1 @@\n"
    "-old\n"
    "+new\n"
)

COMMENTS = [
    {
        "id": 1,
        "body": f"{COMMENT_MARKER}\nPrevious review comment",
        "created_at": "2026-06-11T11:00:00Z",
        "updated_at": "2026-06-11T11:30:00Z",
        "user": {"login": "ai-reviewer"},
        "html_url": "https://forgejo.example.com/misospace/pr-reviewer-action/pulls/42#issuecomment-1",
    },
    {
        "id": 2,
        "body": "Some other comment without marker",
        "created_at": "2026-06-11T11:10:00Z",
        "updated_at": "2026-06-11T11:10:00Z",
        "user": {"login": "human-reviewer"},
        "html_url": "https://forgejo.example.com/misospace/pr-reviewer-action/pulls/42#issuecomment-2",
    },
]

NEW_COMMENT = {
    "id": 3,
    "body": "New review comment",
    "created_at": "2026-06-11T12:00:00Z",
    "updated_at": "2026-06-11T12:00:00Z",
    "user": {"login": "ai-reviewer"},
    "html_url": "https://forgejo.example.com/misospace/pr-reviewer-action/pulls/42#issuecomment-3",
}


REVIEW = {
    "id": 55,
    "body": f"{COMMENT_MARKER}\nAutomated review",
    "state": "REQUEST_CHANGES",
    "user": {"login": "ai-reviewer"},
    "submitted_at": "2026-06-11T14:00:00Z",
    "html_url": "https://forgejo.example.com/misospace/pr-reviewer-action/pulls/42#pullrequestreview-55",
}

def _make_create_response(input_body: str) -> tuple[int, str]:
    """Return a create comment response that reflects the input body."""
    resp = dict(NEW_COMMENT, body=input_body)
    return (201, json.dumps(resp))

EDITED_COMMENT = {
    "id": 1,
    "body": f"{COMMENT_MARKER}\nUpdated review comment",
    "created_at": "2026-06-11T11:00:00Z",
    "updated_at": "2026-06-11T13:00:00Z",
    "user": {"login": "ai-reviewer"},
    "html_url": "https://forgejo.example.com/misospace/pr-reviewer-action/pulls/42#issuecomment-1",
}

ISSUE = {
    "number": 100,
    "title": "Bug report",
    "body": "Found a bug in the system.",
    "state": "open",
    "created_at": "2026-06-10T08:00:00Z",
    "updated_at": "2026-06-11T09:00:00Z",
}

PR_FILES = [
    {
        "filename": "src/main.py",
        "status": "modified",
        "additions": 5,
        "deletions": 2,
        "changes": 7,
        "patch": "@@ -1 +1 @@\n-old\n+new\n",
    },
    {
        "filename": "tests/test_main.py",
        "status": "added",
        "additions": 10,
        "deletions": 0,
        "changes": 10,
        "patch": "+print('hello')\n",
    },
]

FORGEJO_BASE = "http://127.0.0.1:9999"


def _make_curl_mock(url_to_response: dict[str, tuple[int, str]]) -> Any:
    """Build a mock _curl function that returns fixture data for specific URLs.

    Matches URLs by stripping query parameters so that pagination URLs like
    ``?page=1&limit=50`` still hit the base endpoint.
    """

    def _mock_curl(method: str, url: str, **kwargs: Any) -> tuple[int, str]:
        # Strip query params for matching
        base_url = url.split("?")[0]
        status_code, body = url_to_response.get(base_url, (404, '{"message":"Not Found"}'))
        return status_code, body

    return _mock_curl


# Patch decorator: patch both _curl AND FORGEJO_API_URL on the module
_PATCH_FORGEJO = patch.object(fb, "_curl")


def _forgejo_env_patch() -> Any:
    """Return a combined patch context for Forgejo mode."""
    return patch.object(fb, "FORGEJO_API_URL", FORGEJO_BASE)


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

class TestAuthenticatedRepoPermission(unittest.TestCase):
    @_PATCH_FORGEJO
    def test_returns_effective_permission(self, mock_curl):
        mock_curl.side_effect = [
            (200, json.dumps({"login": "review-bot"})),
            (200, json.dumps({"permission": "write"})),
        ]

        with _forgejo_env_patch():
            result = fb.get_authenticated_repo_permission("misospace/pr-reviewer-action")

        self.assertEqual(result, "write")
        self.assertTrue(
            mock_curl.call_args_list[1].args[1].endswith("/collaborators/review-bot/permission")
        )

    @_PATCH_FORGEJO
    def test_normalizes_owner_permission_to_admin(self, mock_curl):
        mock_curl.side_effect = [
            (200, json.dumps({"login": "repo-owner"})),
            (200, json.dumps({"permission": "owner", "role_name": "owner"})),
        ]

        with _forgejo_env_patch():
            result = fb.get_authenticated_repo_permission("misospace/pr-reviewer-action")

        self.assertEqual(result, "admin")

    @_PATCH_FORGEJO
    def test_permission_denied_fails_closed_with_sanitized_error(self, mock_curl):
        mock_curl.side_effect = [
            (200, json.dumps({"login": "review-bot"})),
            (403, json.dumps({"message": "denied; token=must-not-print", "token": "also-secret"})),
        ]

        stderr = io.StringIO()
        with _forgejo_env_patch(), redirect_stderr(stderr):
            result = fb.get_authenticated_repo_permission("misospace/pr-reviewer-action")

        self.assertIsNone(result)
        self.assertIn("HTTP 403", stderr.getvalue())
        self.assertNotIn("must-not-print", stderr.getvalue())

    @_PATCH_FORGEJO
    def test_owner_not_collaborator_falls_back_to_repo_permissions(self, mock_curl):
        """Repo owners aren't collaborators in Forgejo — the collaborator
        endpoint 404s. Fall back to the repo endpoint's ``permissions`` object
        (key path for JWT authorized integrations where the user IS the owner).
        """
        mock_curl.side_effect = [
            (200, json.dumps({"login": "repo-owner"})),
            (404, json.dumps({"message": "user is not a collaborator"})),
            (200, json.dumps({"permissions": {"admin": True, "write": True, "read": True}})),
        ]

        with _forgejo_env_patch():
            result = fb.get_authenticated_repo_permission("misospace/pr-reviewer-action")

        self.assertEqual(result, "admin")

    @_PATCH_FORGEJO
    def test_owner_fallback_returns_write_from_repo_permissions(self, mock_curl):
        mock_curl.side_effect = [
            (200, json.dumps({"login": "dev-user"})),
            (404, json.dumps({"message": "user is not a collaborator"})),
            (200, json.dumps({"permissions": {"admin": False, "write": True, "read": True}})),
        ]

        with _forgejo_env_patch():
            result = fb.get_authenticated_repo_permission("misospace/pr-reviewer-action")

        self.assertEqual(result, "write")

    @_PATCH_FORGEJO
    def test_authorized_integration_uses_repo_permission_without_user_scope(self, mock_curl):
        """JWT integrations must not need the unrelated read:user scope."""
        mock_curl.return_value = (
            200,
            json.dumps({"permissions": {"admin": False, "push": True, "pull": True}}),
        )

        with _forgejo_env_patch(), patch.object(
            fb, "FORGEJO_AUTH_METHOD", "authorized_integration"
        ):
            result = fb.get_authenticated_repo_permission("misospace/pr-reviewer-action")

        self.assertEqual(result, "write")
        self.assertEqual(mock_curl.call_count, 1)
        self.assertTrue(mock_curl.call_args.args[1].endswith("/repos/misospace/pr-reviewer-action"))

    @_PATCH_FORGEJO
    def test_unresolvable_user_fails_closed(self, mock_curl):
        mock_curl.return_value = (401, json.dumps({"message": "unauthorized"}))

        with _forgejo_env_patch(), redirect_stderr(io.StringIO()):
            result = fb.get_authenticated_repo_permission("misospace/pr-reviewer-action")

        self.assertIsNone(result)

    @_PATCH_FORGEJO
    def test_cli_repo_permission_prints_permission_and_exit_code(self, mock_curl):
        mock_curl.side_effect = [
            (200, json.dumps({"login": "review-bot"})),
            (200, json.dumps({"permission": "admin"})),
        ]

        stdout = io.StringIO()
        with _forgejo_env_patch(), redirect_stdout(stdout), patch.object(
            sys, "argv", ["forgejo_backend", "repo-permission", "misospace/pr-reviewer-action"]
        ):
            fb.main()

        self.assertEqual(stdout.getvalue().strip(), "admin")

    @_PATCH_FORGEJO
    def test_cli_repo_permission_exits_nonzero_when_unknown(self, mock_curl):
        mock_curl.return_value = (401, json.dumps({"message": "unauthorized"}))

        stdout = io.StringIO()
        with _forgejo_env_patch(), redirect_stdout(stdout), redirect_stderr(io.StringIO()), patch.object(
            sys, "argv", ["forgejo_backend", "repo-permission", "misospace/pr-reviewer-action"]
        ):
            with self.assertRaises(SystemExit) as ctx:
                fb.main()

        self.assertEqual(ctx.exception.code, 1)
        self.assertEqual(stdout.getvalue().strip(), "none")


class TestGetPrMetadata(unittest.TestCase):
    """Test get_pr_metadata with Forgejo fixtures."""

    @_PATCH_FORGEJO
    def test_returns_metadata_dict(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/pulls/42": (200, json.dumps(PR_META)),
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/pulls/999": (404, '{"message":"Not Found"}'),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.get_pr_metadata("misospace/pr-reviewer-action", 42)

        self.assertIsNotNone(result)
        self.assertEqual(result["number"], 42)
        self.assertEqual(result["title"], "Add new feature")
        self.assertEqual(result["state"], "open")

    @_PATCH_FORGEJO
    def test_head_sha(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/pulls/42": (200, json.dumps(PR_META)),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.get_pr_metadata("misospace/pr-reviewer-action", 42)

        self.assertEqual(result["head"]["sha"], "abc123def456")

    @_PATCH_FORGEJO
    def test_base_ref(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/pulls/42": (200, json.dumps(PR_META)),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.get_pr_metadata("misospace/pr-reviewer-action", 42)

        self.assertEqual(result["base"]["ref"], "main")

    @_PATCH_FORGEJO
    def test_not_found_returns_none(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/pulls/999": (404, '{"message":"Not Found"}'),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.get_pr_metadata("misospace/pr-reviewer-action", 999)

        self.assertIsNone(result)


class TestGetPrDiff(unittest.TestCase):
    """Test get_pr_diff with Forgejo fixtures."""

    @_PATCH_FORGEJO
    def test_returns_diff_text(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/pulls/42.diff": (200, PR_DIFF),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.get_pr_diff("misospace/pr-reviewer-action", 42)

        self.assertIn("diff --git", result)
        self.assertIn("+new", result)

    @_PATCH_FORGEJO
    def test_not_found_returns_empty(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/pulls/999.diff": (404, ""),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.get_pr_diff("misospace/pr-reviewer-action", 999)

        self.assertEqual(result, "")


class TestListComments(unittest.TestCase):
    """Test list_comments with Forgejo fixtures."""

    @_PATCH_FORGEJO
    def test_returns_comment_list(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/issues/42/comments": (200, json.dumps(COMMENTS)),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.list_comments("misospace/pr-reviewer-action", 42)

        self.assertIsInstance(result, list)
        self.assertEqual(len(result), 2)

    @_PATCH_FORGEJO
    def test_comment_has_required_fields(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/issues/42/comments": (200, json.dumps(COMMENTS)),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.list_comments("misospace/pr-reviewer-action", 42)

        comment = result[0]
        self.assertIn("id", comment)
        self.assertIn("body", comment)
        self.assertIn("created_at", comment)
        self.assertIn("updated_at", comment)
        self.assertIn("user", comment)

    @_PATCH_FORGEJO
    def test_marker_present_in_first_comment(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/issues/42/comments": (200, json.dumps(COMMENTS)),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.list_comments("misospace/pr-reviewer-action", 42)

        self.assertIn(COMMENT_MARKER, result[0]["body"])

    @_PATCH_FORGEJO
    def test_comment_user_field(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/issues/42/comments": (200, json.dumps(COMMENTS)),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.list_comments("misospace/pr-reviewer-action", 42)

        self.assertEqual(result[0]["user"], "ai-reviewer")


class TestCreateComment(unittest.TestCase):
    """Test create_comment with Forgejo fixtures."""

    @_PATCH_FORGEJO
    def test_creates_comment(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/issues/42/comments": (201, json.dumps(NEW_COMMENT)),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.create_comment("misospace/pr-reviewer-action", 42, "New review comment")

        self.assertIsNotNone(result)
        self.assertEqual(result["id"], 3)
        self.assertIn("html_url", result)

    @_PATCH_FORGEJO
    def test_body_reflected(self, mock_curl):
        call_count = [0]
        def _run(method, url, **kwargs):
            call_count[0] += 1
            # Extract body from kwargs (the POST data)
            input_body = kwargs.get("data", {}).get("body", "default") if isinstance(kwargs.get("data"), dict) else "default"
            resp = dict(NEW_COMMENT, body=input_body)
            return (201, json.dumps(resp))
        mock_curl.side_effect = _run

        with _forgejo_env_patch():
            result = fb.create_comment("misospace/pr-reviewer-action", 42, "Custom body text")

        self.assertIsNotNone(result)
        self.assertEqual(result["body"], "Custom body text")


class TestEditLastComment(unittest.TestCase):
    """Test edit_last_comment with Forgejo fixtures."""

    @_PATCH_FORGEJO
    def test_edits_matching_comment(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/issues/42/comments": (200, json.dumps(COMMENTS)),
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/issues/comments/1": (200, json.dumps(EDITED_COMMENT)),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.edit_last_comment(
                "misospace/pr-reviewer-action", 42,
                f"{COMMENT_MARKER}\nUpdated review comment",
            )

        self.assertIsNotNone(result)
        self.assertEqual(result["id"], 1)
        self.assertIn("Updated review comment", result["body"])

    @_PATCH_FORGEJO
    def test_creates_when_no_matching_marker(self, mock_curl):
        call_count = [0]

        def _run(method: str, url: str, **kwargs: Any) -> tuple[int, str]:
            call_count[0] += 1
            if call_count[0] == 1:
                return 200, json.dumps([])
            else:
                return 201, json.dumps(NEW_COMMENT)

        mock_curl.side_effect = _run

        with _forgejo_env_patch():
            result = fb.edit_last_comment(
                "misospace/pr-reviewer-action", 999,
                f"{COMMENT_MARKER}\nFresh review",
            )

        self.assertIsNotNone(result)
        self.assertEqual(result["id"], 3)


class TestFetchIssue(unittest.TestCase):
    """Test fetch_issue with Forgejo fixtures."""

    @_PATCH_FORGEJO
    def test_returns_issue_body(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/issues/100": (200, json.dumps(ISSUE)),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.fetch_issue("misospace/pr-reviewer-action", 100)

        self.assertIsNotNone(result)
        self.assertEqual(result["body"], "Found a bug in the system.")
        self.assertEqual(result["title"], "Bug report")
        self.assertEqual(result["state"], "open")

    @_PATCH_FORGEJO
    def test_not_found_returns_none(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/issues/999": (404, '{"message":"Not Found"}'),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.fetch_issue("misospace/pr-reviewer-action", 999)

        self.assertIsNone(result)


class TestCompareCommits(unittest.TestCase):
    """Forgejo compare support backs fail-closed incremental scope checks."""

    _COMPARE = {
        "html_url": "https://forgejo.example.com/misospace/pr-reviewer-action/compare/abc...def",
        "total_commits": 1,
        "commits": [{"sha": "def"}],
        "files": [{"filename": "README.md"}],
    }

    @_PATCH_FORGEJO
    def test_forgejo_compare_uses_api_endpoint(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/compare/abc...def": (200, json.dumps(self._COMPARE)),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.compare_commits("misospace/pr-reviewer-action", "abc...def")

        self.assertIsNotNone(result)
        self.assertEqual(result["total_commits"], 1)
        mock_curl.assert_called_once()
        self.assertIn("/compare/abc...def", mock_curl.call_args[0][1])

    @_PATCH_FORGEJO
    def test_forgejo_compare_failure_returns_none(self, mock_curl):
        mock_curl.side_effect = _make_curl_mock({})

        with _forgejo_env_patch():
            result = fb.compare_commits("misospace/pr-reviewer-action", "missing...head")

        self.assertIsNone(result)

    def test_github_compare_uses_gh_api(self):
        with patch.object(fb, "FORGEJO_API_URL", ""), \
             patch.object(fb, "_gh", return_value=(0, json.dumps(self._COMPARE))) as mock_gh:
            result = fb.compare_commits("misospace/pr-reviewer-action", "abc...def")

        mock_gh.assert_called_once_with("api", "repos/misospace/pr-reviewer-action/compare/abc...def")
        self.assertEqual(result["commits"][0]["sha"], "def")


class TestListPrFiles(unittest.TestCase):
    """Test list_pr_files with Forgejo fixtures."""

    @_PATCH_FORGEJO
    def test_returns_file_list(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/pulls/42/files": (200, json.dumps(PR_FILES)),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.list_pr_files("misospace/pr-reviewer-action", 42)

        self.assertIsInstance(result, list)
        self.assertEqual(len(result), 2)

    @_PATCH_FORGEJO
    def test_file_has_required_fields(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/pulls/42/files": (200, json.dumps(PR_FILES)),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.list_pr_files("misospace/pr-reviewer-action", 42)

        f = result[0]
        self.assertIn("filename", f)
        self.assertIn("status", f)
        self.assertIn("additions", f)
        self.assertIn("deletions", f)

    @_PATCH_FORGEJO
    def test_first_file_is_main_py(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/pulls/42/files": (200, json.dumps(PR_FILES)),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.list_pr_files("misospace/pr-reviewer-action", 42)

        self.assertEqual(result[0]["filename"], "src/main.py")


class TestGitHubMode(unittest.TestCase):
    """GitHub mode must invoke gh with arguments the real CLI accepts.

    These mock ``_gh`` (no live network calls from unit tests) and assert
    the exact invocation: the original ``get_pr_metadata`` implementation
    passed ``gh pr view --json`` field names that don't exist
    (user/head/base/merged_at) — invisible to tests that only checked the
    fallback result. Comment creation/editing similarly used to shell out
    to ``gh pr comment`` and regex-scrape its human-oriented stdout; these
    tests assert the structured ``gh api`` JSON path instead.
    """

    GH_REST_PR = {
        "number": 42,
        "title": "Add new feature",
        "state": "open",
        "user": {"login": "contributor"},
        "head": {"sha": "abc123def456", "ref": "feature-branch", "repo": {"full_name": "outsider/pr-reviewer-action"}},
        "base": {"sha": "789xyz000", "ref": "main", "repo": {"full_name": "misospace/pr-reviewer-action"}},
        "draft": False,
    }

    def test_get_pr_metadata_uses_gh_api_rest(self):
        with patch.object(fb, "FORGEJO_API_URL", ""), \
             patch.object(fb, "_gh", return_value=(0, json.dumps(self.GH_REST_PR))) as mock_gh:
            result = fb.get_pr_metadata("misospace/pr-reviewer-action", 42)

        mock_gh.assert_called_once_with("api", "repos/misospace/pr-reviewer-action/pulls/42")
        self.assertEqual(result["number"], 42)
        self.assertEqual(result["head"]["repo"]["full_name"], "outsider/pr-reviewer-action")

    def test_get_pr_metadata_returns_none_on_gh_failure(self):
        with patch.object(fb, "FORGEJO_API_URL", ""), \
             patch.object(fb, "_gh", return_value=(1, '{"message":"Not Found"}')):
            result = fb.get_pr_metadata("misospace/pr-reviewer-action", 999)

        self.assertIsNone(result)

    def test_get_pr_diff_returns_empty_on_gh_failure(self):
        with patch.object(fb, "FORGEJO_API_URL", ""), \
             patch.object(fb, "_gh", return_value=(1, "")):
            result = fb.get_pr_diff("misospace/pr-reviewer-action", 42)

        self.assertEqual(result, "")

    def test_create_comment_posts_via_gh_api_json(self):
        # create_comment must hit the REST endpoint via ``gh api`` and parse
        # the structured JSON response — not scrape ``gh pr comment`` stdout.
        gh_comment = {
            "id": 77,
            "html_url": "https://github.com/misospace/pr-reviewer-action/pull/42#issuecomment-77",
            "body": "hello",
        }
        with patch.object(fb, "FORGEJO_API_URL", ""), \
             patch.object(fb, "_gh", return_value=(0, json.dumps(gh_comment))) as mock_gh:
            result = fb.create_comment("misospace/pr-reviewer-action", 42, "hello")

        args = mock_gh.call_args[0]
        self.assertEqual(args[0], "api")
        self.assertEqual(args[1], "repos/misospace/pr-reviewer-action/issues/42/comments")
        self.assertIn("--method", args)
        self.assertEqual(args[args.index("--method") + 1], "POST")
        self.assertIn("--input", args)
        self.assertEqual(result["id"], 77)
        self.assertEqual(result["html_url"], gh_comment["html_url"])

    def test_create_comment_malformed_json_returns_none(self):
        with patch.object(fb, "FORGEJO_API_URL", ""), \
             patch.object(fb, "_gh", return_value=(0, "not json")):
            result = fb.create_comment("misospace/pr-reviewer-action", 42, "hello")

        self.assertIsNone(result)

    def test_edit_last_comment_finds_latest_marker_and_patches(self):
        # gh mode must select the comment the same way Forgejo mode does:
        # the latest comment containing the marker, not "last comment by
        # the current gh user" (--edit-last).
        gh_comments = [
            {"id": 1, "body": f"{COMMENT_MARKER}\nold", "updated_at": "2026-06-11T11:30:00Z"},
            {"id": 2, "body": "no marker here", "updated_at": "2026-06-11T11:40:00Z"},
        ]
        patched = {"id": 1, "html_url": "https://github.com/misospace/pr-reviewer-action/pull/42#issuecomment-1", "body": "updated"}

        def _fake_gh(*args):
            if args[:2] == ("api", "repos/misospace/pr-reviewer-action/issues/42/comments"):
                # list_comments consumes gh's --jq output, which is one JSON
                # object per line (JSONL), not a JSON array.
                return 0, "\n".join(json.dumps(c) for c in gh_comments)
            self.assertEqual(args[0], "api")
            self.assertEqual(args[1], "repos/misospace/pr-reviewer-action/issues/comments/1")
            self.assertIn("--method", args)
            self.assertEqual(args[args.index("--method") + 1], "PATCH")
            self.assertIn("--input", args)
            return 0, json.dumps(patched)

        with patch.object(fb, "FORGEJO_API_URL", ""), \
             patch.object(fb, "_gh", side_effect=_fake_gh):
            result = fb.edit_last_comment("misospace/pr-reviewer-action", 42, "updated")

        self.assertEqual(result["id"], 1)
        self.assertEqual(result["html_url"], patched["html_url"])

    def test_edit_last_comment_falls_back_to_create_when_no_marker(self):
        created = {"id": 3, "html_url": "https://github.com/misospace/pr-reviewer-action/pull/42#issuecomment-3", "body": "fresh"}

        def _fake_gh(*args):
            # The list (no --method) and the create (--method POST) both
            # target .../issues/42/comments, so disambiguate on --method.
            if args[:2] == ("api", "repos/misospace/pr-reviewer-action/issues/42/comments") \
                    and "--method" not in args:
                return 0, json.dumps([])
            return 0, json.dumps(created)

        with patch.object(fb, "FORGEJO_API_URL", ""), \
             patch.object(fb, "_gh", side_effect=_fake_gh):
            result = fb.edit_last_comment("misospace/pr-reviewer-action", 42, "fresh")

        self.assertEqual(result["id"], 3)
        self.assertEqual(result["html_url"], created["html_url"])



class TestNativeReviews(unittest.TestCase):
    """Forgejo native review support uses review endpoints and new_position anchors."""

    @_PATCH_FORGEJO
    def test_list_pr_reviews_normalizes_state(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/pulls/42/reviews": (200, json.dumps([REVIEW])),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.list_pr_reviews("misospace/pr-reviewer-action", 42)

        self.assertEqual(result[0]["id"], 55)
        self.assertEqual(result[0]["state"], "CHANGES_REQUESTED")
        self.assertIn(COMMENT_MARKER, result[0]["body"])

    @_PATCH_FORGEJO
    def test_create_review_converts_line_comments_to_new_position(self, mock_curl):
        calls = []

        def _run(method: str, url: str, **kwargs: Any) -> tuple[int, str]:
            calls.append((method, url, kwargs))
            if url.endswith("/pulls/42.diff"):
                return 200, PR_DIFF
            self.assertEqual(method, "POST")
            return 201, json.dumps(dict(REVIEW, id=56, body=kwargs["data"]["body"]))

        mock_curl.side_effect = _run
        payload = {
            "body": "review body",
            "event": "REQUEST_CHANGES",
            "comments": [{"path": "test.txt", "line": 1, "side": "RIGHT", "body": "anchored"}],
        }

        with _forgejo_env_patch():
            result = fb.create_pr_review_from_payload("misospace/pr-reviewer-action", 42, payload)

        self.assertIsNotNone(result)
        review_call = calls[-1]
        data = review_call[2]["data"]
        self.assertEqual(review_call[1], f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/pulls/42/reviews")
        self.assertEqual(data["event"], "REQUEST_CHANGES")
        self.assertEqual(data["comments"], [{"path": "test.txt", "new_position": 2, "body": "anchored"}])

    @_PATCH_FORGEJO
    def test_create_native_review_uses_forgejo_approved_state(self, mock_curl):
        seen = {}

        def _run(method: str, url: str, **kwargs: Any) -> tuple[int, str]:
            seen.update(method=method, url=url, data=kwargs.get("data"))
            # Forgejo silently creates a PENDING draft for GitHub's `APPROVE`
            # token. Its ReviewStateType requires `APPROVED` to submit it.
            state = "APPROVED" if kwargs["data"]["event"] == "APPROVED" else "PENDING"
            return 201, json.dumps(dict(REVIEW, id=57, state=state))

        mock_curl.side_effect = _run

        with _forgejo_env_patch():
            result = fb.create_native_review("misospace/pr-reviewer-action", 42, "APPROVE", "looks good")

        self.assertIsNotNone(result)
        self.assertEqual(seen["data"], {"body": "looks good", "event": "APPROVED"})
        self.assertEqual(result["state"], "APPROVED")

    @_PATCH_FORGEJO
    def test_create_native_review_maps_request_changes_state(self, mock_curl):
        seen = {}

        def _run(method: str, url: str, **kwargs: Any) -> tuple[int, str]:
            seen.update(method=method, url=url, data=kwargs.get("data"))
            return 201, json.dumps(dict(REVIEW, id=58, state="REQUEST_CHANGES"))

        mock_curl.side_effect = _run

        with _forgejo_env_patch():
            result = fb.create_native_review("misospace/pr-reviewer-action", 42, "CHANGES_REQUESTED", "needs work")

        self.assertIsNotNone(result)
        self.assertEqual(seen["data"], {"body": "needs work", "event": "REQUEST_CHANGES"})

    @_PATCH_FORGEJO
    def test_create_review_binds_commit_id_when_present(self, mock_curl):
        seen = {}

        def _run(method: str, url: str, **kwargs: Any) -> tuple[int, str]:
            seen.update(method=method, url=url, data=kwargs.get("data"))
            return 201, json.dumps(dict(REVIEW, id=59))

        mock_curl.side_effect = _run
        payload = {"body": "review body", "event": "REQUEST_CHANGES", "commit_id": "abc123def456"}

        with _forgejo_env_patch():
            result = fb.create_pr_review_from_payload("misospace/pr-reviewer-action", 42, payload)

        self.assertIsNotNone(result)
        self.assertEqual(seen["data"]["commit_id"], "abc123def456")

    @_PATCH_FORGEJO
    def test_create_review_omits_empty_commit_id(self, mock_curl):
        seen = {}

        def _run(method: str, url: str, **kwargs: Any) -> tuple[int, str]:
            seen.update(method=method, url=url, data=kwargs.get("data"))
            return 201, json.dumps(dict(REVIEW, id=60))

        mock_curl.side_effect = _run

        with _forgejo_env_patch():
            result = fb.create_pr_review_from_payload(
                "misospace/pr-reviewer-action", 42, {"body": "b", "event": "COMMENT", "commit_id": ""}
            )

        self.assertIsNotNone(result)
        self.assertNotIn("commit_id", seen["data"])

    @_PATCH_FORGEJO
    def test_create_native_review_preserves_comment_event(self, mock_curl):
        seen = {}

        def _run(method: str, url: str, **kwargs: Any) -> tuple[int, str]:
            seen.update(method=method, url=url, data=kwargs.get("data"))
            return 201, json.dumps(dict(REVIEW, id=61, state="COMMENT"))

        mock_curl.side_effect = _run

        with _forgejo_env_patch():
            result = fb.create_native_review("misospace/pr-reviewer-action", 42, "COMMENT", "advisory")

        self.assertIsNotNone(result)
        self.assertEqual(seen["data"], {"body": "advisory", "event": "COMMENT"})

    @_PATCH_FORGEJO
    def test_failed_review_publication_reports_sanitized_http_error(self, mock_curl):
        mock_curl.return_value = (
            403,
            json.dumps(
                {
                    "message": "review permission denied; token=must-not-print-secret",
                    "token": "also-must-not-print",
                }
            ),
        )

        stderr = io.StringIO()
        with _forgejo_env_patch(), redirect_stderr(stderr):
            result = fb.create_pr_review_from_payload(
                "misospace/pr-reviewer-action", 42, {"event": "COMMENT", "body": "advisory"}
            )

        self.assertIsNone(result)
        self.assertIn("Forgejo review publication failed (HTTP 403)", stderr.getvalue())
        self.assertIn("review permission denied", stderr.getvalue())
        self.assertIn("[REDACTED]", stderr.getvalue())
        self.assertNotIn("must-not-print", stderr.getvalue())

    @_PATCH_FORGEJO
    def test_failed_review_publication_tolerates_non_json_error_body(self, mock_curl):
        mock_curl.return_value = (502, "<html>bad gateway</html>")

        stderr = io.StringIO()
        with _forgejo_env_patch(), redirect_stderr(stderr):
            result = fb.create_pr_review_from_payload(
                "misospace/pr-reviewer-action", 42, {"event": "COMMENT", "body": "advisory"}
            )

        self.assertIsNone(result)
        self.assertIn("Forgejo review publication failed (HTTP 502)", stderr.getvalue())
        self.assertNotIn("bad gateway", stderr.getvalue())

    @_PATCH_FORGEJO
    def test_dismiss_review_uses_forgejo_dismissal_endpoint(self, mock_curl):
        seen = {}

        def _run(method: str, url: str, **kwargs: Any) -> tuple[int, str]:
            seen.update(method=method, url=url, data=kwargs.get("data"))
            return 200, json.dumps({"id": 55})

        mock_curl.side_effect = _run

        with _forgejo_env_patch():
            result = fb.dismiss_pr_review("misospace/pr-reviewer-action", 42, 55, "Superseded")

        self.assertEqual(result, 55)
        self.assertEqual(seen["method"], "POST")
        self.assertEqual(seen["url"], f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/pulls/42/reviews/55/dismissals")
        self.assertEqual(seen["data"], {"message": "Superseded"})


class TestIsForkPr(unittest.TestCase):
    """Fork detection must key off head.repo.full_name and fail closed."""

    def _meta(self, fixture):
        return patch.object(fb, "get_pr_metadata", return_value=fb._forgejo_pr_to_github(
            fixture, "misospace", "pr-reviewer-action"))

    def test_same_repo_pr_is_not_fork(self):
        with self._meta(PR_META):
            self.assertFalse(fb.is_fork_pr("misospace/pr-reviewer-action", 42))

    def test_fork_pr_detected(self):
        with self._meta(FORK_PR_META):
            self.assertTrue(fb.is_fork_pr("misospace/pr-reviewer-action", 43))

    def test_deleted_fork_head_repo_fails_closed(self):
        # head.repo: null (deleted fork) → unknown origin must be treated as
        # a fork so fork gating stays engaged.
        with self._meta(DELETED_FORK_PR_META):
            self.assertTrue(fb.is_fork_pr("misospace/pr-reviewer-action", 44))

    def test_fetch_failure_fails_closed(self):
        # Total metadata-fetch failure → origin unknown → fork (fail closed),
        # matching the shell derivation (derive_is_fork_pr).
        with patch.object(fb, "get_pr_metadata", return_value=None):
            self.assertTrue(fb.is_fork_pr("misospace/pr-reviewer-action", 45))


class TestCurlStatusParsing(unittest.TestCase):
    """_curl appends '\\n%{http_code}' and must parse bodies of any shape."""

    def _run_curl(self, stdout: bytes, returncode: int = 0):
        proc = Mock(stdout=stdout, returncode=returncode)
        with patch.object(fb.subprocess, "run", return_value=proc):
            return fb._curl("GET", "http://example.invalid/api")

    def test_compact_json_body_without_trailing_newline(self):
        code, body = self._run_curl(b'{"a": 1}\n200')
        self.assertEqual(code, 200)
        self.assertEqual(body, '{"a": 1}')

    def test_empty_body_status_only(self):
        # An empty 204 body must not be misread as a network error.
        code, body = self._run_curl(b"\n204")
        self.assertEqual(code, 204)
        self.assertEqual(body, "")

    def test_no_status_marker_is_network_error(self):
        code, body = self._run_curl(b"curl: (7) connection refused", returncode=7)
        self.assertEqual(code, 7)
        self.assertEqual(body, "curl: (7) connection refused")


class TestErrorBodyOnStdout(unittest.TestCase):
    """Test that HTTP error responses return None (error body discipline)."""

    @_PATCH_FORGEJO
    def test_404_returns_none_for_metadata(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/pulls/999": (404, '{"message":"Not Found"}'),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.get_pr_metadata("misospace/pr-reviewer-action", 999)

        self.assertIsNone(result)


class TestCommentMarkerEnv(unittest.TestCase):
    """Test that the default COMMENT_MARKER is used in comments."""

    @_PATCH_FORGEJO
    def test_default_marker_in_comments(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/issues/42/comments": (200, json.dumps(COMMENTS)),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.list_comments("misospace/pr-reviewer-action", 42)

        self.assertIn(COMMENT_MARKER, result[0]["body"])


class TestGetCommitStatus(unittest.TestCase):
    """get_commit_status normalizes Forgejo's per-entry ``status`` to ``state``.

    Forgejo's combined-status object names the per-entry field ``status``
    (verified against Codeberg), unlike GitHub's ``state``. The fixture below
    uses the REAL Forgejo shape so the test guards the normalization rather
    than re-encoding GitHub's shape.
    """

    _COMBINED = json.dumps({
        "state": "success",
        "sha": "abc123def456",
        "total_count": 2,
        "statuses": [
            {"id": 10, "status": "pending", "context": "pr-reviewer-action",
             "description": "AI PR Review"},
            {"id": 11, "status": "success", "context": "golangci-lint",
             "description": "Lint passed"},
        ],
    })

    @_PATCH_FORGEJO
    def test_normalizes_per_status_field(self, mock_curl):
        url_map = {
            f"{FORGEJO_BASE}/api/v1/repos/misospace/pr-reviewer-action/commits/abc123def456/status": (200, self._COMBINED),
        }
        mock_curl.side_effect = _make_curl_mock(url_map)

        with _forgejo_env_patch():
            result = fb.get_commit_status("misospace/pr-reviewer-action", "abc123def456")

        self.assertIsNotNone(result)
        self.assertEqual(result["state"], "success")
        self.assertEqual(result["total_count"], 2)
        # Every entry must expose ``state`` mapped from Forgejo's ``status``.
        states = {s["context"]: s["state"] for s in result["statuses"]}
        self.assertEqual(states["pr-reviewer-action"], "pending")
        self.assertEqual(states["golangci-lint"], "success")

    @_PATCH_FORGEJO
    def test_not_found_returns_none(self, mock_curl):
        mock_curl.side_effect = _make_curl_mock({})  # 404 for any URL
        with _forgejo_env_patch():
            result = fb.get_commit_status("misospace/pr-reviewer-action", "deadbeef")
        self.assertIsNone(result)


class TestForgeEnrichment(unittest.TestCase):
    """Cross-host linked-source enrichment (release-by-tag / compare)."""

    _RELEASE = {
        "tag_name": "v0.4.21",
        "name": "v0.4.21",
        "published_at": "2026-06-28T00:00:00Z",
        "html_url": "https://codeberg.org/o/r/releases/tag/v0.4.21",
        "body": "patch bump",
    }
    _COMPARE = {"total_commits": 2, "commits": [{"sha": "a"}], "files": [{"filename": "x"}]}

    @_PATCH_FORGEJO
    def test_release_normalises_to_github_subset(self, mock_curl):
        url_map = {"https://codeberg.org/api/v1/repos/o/r/releases/tags/v0.4.21": (200, json.dumps(self._RELEASE))}
        mock_curl.side_effect = _make_curl_mock(url_map)
        result = fb.fetch_forge_release("codeberg.org", "o/r", "v0.4.21")
        self.assertEqual(result["tag_name"], "v0.4.21")
        self.assertEqual(result["body"], "patch bump")
        self.assertEqual(sorted(result), ["body", "html_url", "name", "published_at", "tag_name"])

    @_PATCH_FORGEJO
    def test_release_not_found_returns_none(self, mock_curl):
        mock_curl.side_effect = _make_curl_mock({})
        self.assertIsNone(fb.fetch_forge_release("codeberg.org", "o/r", "v9.9.9"))

    @_PATCH_FORGEJO
    def test_compare_returns_raw_object(self, mock_curl):
        url_map = {"https://codeberg.org/api/v1/repos/o/r/compare/a...b": (200, json.dumps(self._COMPARE))}
        mock_curl.side_effect = _make_curl_mock(url_map)
        result = fb.fetch_forge_compare("codeberg.org", "o/r", "a...b")
        self.assertEqual(result["total_commits"], 2)

    @_PATCH_FORGEJO
    def test_compare_failure_returns_none(self, mock_curl):
        mock_curl.side_effect = _make_curl_mock({})
        self.assertIsNone(fb.fetch_forge_compare("codeberg.org", "o/r", "missing...head"))

    def test_token_sent_only_to_configured_instance(self):
        # Token goes to the configured host only, never to other forges.
        with patch.object(fb, "FORGEJO_API_URL", "https://git.example.com"), \
             patch.object(fb, "FORGEJO_TOKEN", "SECRET"):
            self.assertEqual(fb._enrich_token_for_host("git.example.com"), "SECRET")
            self.assertEqual(fb._enrich_token_for_host("codeberg.org"), "")

    def test_release_uses_host_token_guard(self):
        # fetch_forge_release must pass the empty token for a foreign host.
        seen = {}

        def _spy(method, url, token=None, **kwargs):
            seen["token"] = token
            return 200, json.dumps(self._RELEASE)

        with patch.object(fb, "FORGEJO_API_URL", "https://git.example.com"), \
             patch.object(fb, "FORGEJO_TOKEN", "SECRET"), \
             patch.object(fb, "_curl", side_effect=_spy):
            fb.fetch_forge_release("codeberg.org", "o/r", "v1")
        self.assertEqual(seen["token"], "")

    def test_curl_omits_auth_header_when_token_empty(self):
        # An empty token must not produce an Authorization header.
        captured = {}

        class _Proc:
            stdout = b'{}\n200'
            returncode = 0

        def _fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return _Proc()

        with patch.object(fb.subprocess, "run", side_effect=_fake_run):
            fb._curl("GET", "https://codeberg.org/api/v1/x", token="")
        self.assertFalse(any(str(c).startswith("Authorization") for c in captured["cmd"]))


class TestDiffPositions(unittest.TestCase):
    """Dedicated unit tests for _diff_positions in isolation.

    _diff_positions returns dict[str, dict[int, int]] mapping file path →
    {new_lineno: diff_position}. The diff_position is a 1-based counter
    within each hunk that increments for every non-removed line (context
    and additions). Removed lines are skipped entirely.
    """

    def _diff(self, body):
        """Build a minimal unified diff with +++ b/path header."""
        return "diff --git a/test.py b/test.py\n+++ b/test.py\n" + body

    def test_empty_diff_returns_empty_dict(self):
        self.assertEqual(fb._diff_positions(""), {})

    def test_no_path_header_lines_ignored(self):
        """Lines without a +++ path header are not associated with any file."""
        diff = "@@ -1,3 +1,3 @@\n line1\n line2\n line3\n"
        result = fb._diff_positions(diff)
        self.assertEqual(result, {})

    def test_single_hunk_context_lines(self):
        """Three context lines in a single hunk."""
        diff = self._diff("@@ -1,3 +1,3 @@\n line1\n line2\n line3\n")
        result = fb._diff_positions(diff)
        # new_line starts at 1; each context line records then increments.
        # line1: {1: 1}, line2: {2: 2}, line3: {3: 3}
        self.assertEqual(result, {"test.py": {1: 1, 2: 2, 3: 3}})

    def test_added_lines_increment_new_line(self):
        """Added lines are recorded and increment new_line."""
        diff = self._diff("@@ -1,1 +1,2 @@\n context\n+added\n")
        result = fb._diff_positions(diff)
        # context: {1: 1}, added: {2: 2}
        self.assertEqual(result, {"test.py": {1: 1, 2: 2}})

    def test_removed_lines_skipped(self):
        """Removed lines do not appear in the mapping."""
        diff = self._diff("@@ -1,2 +1,1 @@\n context\n-removed\n")
        result = fb._diff_positions(diff)
        # Only context line: {1: 1}. Removed line is skipped.
        self.assertEqual(result, {"test.py": {1: 1}})

    def test_removed_lines_increment_diff_position(self):
        """Removed lines increment diff_position but don't record an entry."""
        diff = self._diff("@@ -1,3 +1,2 @@\n context\n-removed\n context2\n")
        result = fb._diff_positions(diff)
        # context: dp=1, {1: 1}, removed: dp=2 (no entry), context2: dp=3, {2: 3}
        self.assertEqual(result, {"test.py": {1: 1, 2: 3}})

    def test_mixed_context_added_removed(self):
        """Mixed line types in a single hunk."""
        diff = self._diff("@@ -1,4 +1,4 @@\n ctx1\n-removed\n+added\n ctx2\n")
        result = fb._diff_positions(diff)
        # ctx1: dp=1, {1: 1}, removed: dp=2 (no entry), added: dp=3, {2: 3}, ctx2: dp=4, {3: 4}
        self.assertEqual(result, {"test.py": {1: 1, 2: 3, 3: 4}})

    def test_multiple_hunks_diff_position_continues(self):
        """diff_position continues across hunks within the same file."""
        diff = self._diff(
            "@@ -1,2 +1,2 @@\n hunk1a\n hunk1b\n"
            "@@ -10,2 +10,2 @@\n hunk2a\n hunk2b\n"
        )
        result = fb._diff_positions(diff)
        # Hunk 1: {1: 1, 2: 2}, Hunk 2: {10: 3, 11: 4} — dp continues
        self.assertEqual(result, {"test.py": {1: 1, 2: 2, 10: 3, 11: 4}})

    def test_hunk_with_only_additions(self):
        """Hunk with only additions (new file)."""
        diff = self._diff("@@ -0,0 +1,3 @@\n+line1\n+line2\n+line3\n")
        result = fb._diff_positions(diff)
        # new_line starts at 1: {1: 1, 2: 2, 3: 3}
        self.assertEqual(result, {"test.py": {1: 1, 2: 2, 3: 3}})

    def test_hunk_with_only_deletions_no_entries(self):
        """Hunk with only deletions produces no entries (file not in result)."""
        diff = self._diff("@@ -1,3 +0,0 @@\n-line1\n-line2\n-line3\n")
        result = fb._diff_positions(diff)
        # All lines are removed → no entries recorded → file not in result
        self.assertEqual(result, {})

    def test_multiple_files(self):
        """Different files tracked separately."""
        diff = (
            "diff --git a/alpha.py b/alpha.py\n"
            "+++ b/alpha.py\n"
            "@@ -1,1 +1,1 @@\n alpha_line\n"
            "diff --git a/beta.py b/beta.py\n"
            "+++ b/beta.py\n"
            "@@ -1,1 +1,1 @@\n beta_line\n"
        )
        result = fb._diff_positions(diff)
        self.assertEqual(result, {
            "alpha.py": {1: 1},
            "beta.py": {1: 1},
        })

    def test_dev_null_path_ignored(self):
        """+++ /dev/null means no target path (file deletion)."""
        diff = (
            "diff --git a/old.py b/old.py\n"
            "+++ /dev/null\n"
            "@@ -1,1 +0,0 @@\n-removed\n"
        )
        result = fb._diff_positions(diff)
        self.assertEqual(result, {})

    def test_path_without_b_prefix(self):
        """Path without b/ prefix is used as-is."""
        diff = (
            "diff --git a/raw.py b/raw.py\n"
            "+++ raw.py\n"
            "@@ -1,1 +1,1 @@\n line\n"
        )
        result = fb._diff_positions(diff)
        self.assertEqual(result, {"raw.py": {1: 1}})

    def test_backslash_no_newline_ignored(self):
        """Lines starting with \\ (no newline at EOF marker) are skipped."""
        diff = self._diff("@@ -1,2 +1,2 @@\n line1\n\\ No newline at end of file\n")
        result = fb._diff_positions(diff)
        # Only line1 is recorded; the backslash line is skipped.
        self.assertEqual(result, {"test.py": {1: 1}})

    def test_realistic_diff_pattern(self):
        """Test a realistic diff with multiple hunks and mixed changes."""
        diff = (
            "diff --git a/main.py b/main.py\n"
            "+++ b/main.py\n"
            "@@ -10,6 +10,7 @@\n"
            " context line 1\n"
            " context line 2\n"
            "-old line\n"
            "+new line\n"
            " context line 3\n"
            " context line 4\n"
            "@@ -50,3 +51,3 @@\n"
            " tail context 1\n"
            "-tail old\n"
            "+tail new\n"
        )
        result = fb._diff_positions(diff)
        # Hunk 1 (new_line=10):
        #   ctx1: dp=1, {10: 1}, ctx2: dp=2, {11: 2}, removed: dp=3 (no entry),
        #   added: dp=4, {12: 4}, ctx3: dp=5, {13: 5}, ctx4: dp=6, {14: 6}
        # Hunk 2 (new_line=51):
        #   tail_ctx: dp=7, {51: 7}, removed: dp=8 (no entry), added: dp=9, {52: 9}
        self.assertEqual(result, {
            "main.py": {
                10: 1, 11: 2, 12: 4, 13: 5, 14: 6,
                51: 7, 52: 9,
            },
        })

    def test_return_type_structure(self):
        """Verify the return type is dict[str, dict[int, int]]."""
        diff = self._diff("@@ -1,1 +1,1 @@\n line\n")
        result = fb._diff_positions(diff)
        self.assertIsInstance(result, dict)
        for path, mapping in result.items():
            self.assertIsInstance(path, str)
            self.assertIsInstance(mapping, dict)
            for k, v in mapping.items():
                self.assertIsInstance(k, int)
                self.assertIsInstance(v, int)

    def test_diff_position_continues_across_hunks(self):
        """diff_position does NOT reset between hunks in the same file."""
        diff = self._diff(
            "@@ -1,3 +1,3 @@\n a\n b\n c\n"
            "@@ -20,2 +20,2 @@\n x\n y\n"
        )
        result = fb._diff_positions(diff)
        # Hunk 1: {1: 1, 2: 2, 3: 3}
        # Hunk 2: {20: 4, 21: 5} — dp continues from hunk 1
        self.assertEqual(result, {"test.py": {
            1: 1, 2: 2, 3: 3,
            20: 4, 21: 5,
        }})

    def test_consecutive_additions(self):
        """Multiple consecutive additions each get their own position."""
        diff = self._diff("@@ -1,0 +1,4 @@\n+a\n+b\n+c\n+d\n")
        result = fb._diff_positions(diff)
        self.assertEqual(result, {"test.py": {1: 1, 2: 2, 3: 3, 4: 4}})

    def test_consecutive_removals_no_entries(self):
        """Multiple consecutive removals produce no entries (file not in result)."""
        diff = self._diff("@@ -1,4 +1,0 @@\n-a\n-b\n-c\n-d\n")
        result = fb._diff_positions(diff)
        # All lines removed → no entries → file not in result
        self.assertEqual(result, {})

    def test_interleaved_additions_and_removals(self):
        """Alternating additions and removals."""
        diff = self._diff("@@ -1,3 +1,3 @@\n-removed1\n+added1\n-removed2\n+added2\n")
        result = fb._diff_positions(diff)
        # removed1: dp=1 (no entry), added1: dp=2, {1: 2},
        # removed2: dp=3 (no entry), added2: dp=4, {2: 4}
        self.assertEqual(result, {"test.py": {1: 2, 2: 4}})

    def test_diff_git_resets_state(self):
        """diff --git line resets in_hunk and diff_position."""
        diff = (
            "diff --git a/first.py b/first.py\n"
            "+++ b/first.py\n"
            "@@ -1,2 +1,2 @@\n first_a\n first_b\n"
            "diff --git a/second.py b/second.py\n"
            "+++ b/second.py\n"
            "@@ -1,1 +1,1 @@\n second_a\n"
        )
        result = fb._diff_positions(diff)
        self.assertEqual(result, {
            "first.py": {1: 1, 2: 2},
            "second.py": {1: 1},
        })


class TestIsForgejoMode(unittest.TestCase):
    """_is_forgejo_mode is PLATFORM-aware (issue #367).

    Previously it keyed purely off FORGEJO_API_URL being non-empty, so a
    PLATFORM=github deployment on a non-github host (where action.yml
    force-fills FORGEJO_API_URL from github.server_url) silently curled while
    the shell seam used gh. It now delegates to resolve_platform.
    """

    def test_platform_github_overrides_forgejo_url(self):
        # The regression: explicit PLATFORM=github must win over a populated URL.
        with patch.object(fb, "FORGEJO_API_URL", FORGEJO_BASE), \
             patch.dict(os.environ, {"PLATFORM": "github"}, clear=False):
            self.assertFalse(fb._is_forgejo_mode())

    def test_platform_forgejo_explicit(self):
        with patch.object(fb, "FORGEJO_API_URL", FORGEJO_BASE), \
             patch.dict(os.environ, {"PLATFORM": "forgejo"}, clear=False):
            self.assertTrue(fb._is_forgejo_mode())

    def test_url_only_still_forgejo(self):
        # No PLATFORM set → treated as auto → a populated FORGEJO_API_URL
        # (the monkeypatched module attribute) still flips to forgejo. This is
        # the behaviour the whole existing test suite relies on.
        with patch.object(fb, "FORGEJO_API_URL", FORGEJO_BASE), \
             patch.dict(os.environ, {}, clear=True):
            self.assertTrue(fb._is_forgejo_mode())

    def test_empty_url_stays_github_even_on_forgejo_runner(self):
        # Forgejo Actions runners always set GITHUB_SERVER_URL to the instance
        # URL. Without a FORGEJO_API_URL this module cannot build API URLs, so
        # it must stay in GitHub mode rather than curl an empty base (the
        # auto rule's server_url inference must not leak in here).
        with patch.object(fb, "FORGEJO_API_URL", ""), \
             patch.dict(os.environ, {"GITHUB_SERVER_URL": "https://forgejo.example.com"}, clear=True):
            self.assertFalse(fb._is_forgejo_mode())

    def test_default_github_when_no_url(self):
        with patch.object(fb, "FORGEJO_API_URL", ""), \
             patch.dict(os.environ, {}, clear=True):
            self.assertFalse(fb._is_forgejo_mode())


# ---------------------------------------------------------------------------
# Authorized Integration JWT auth tests
# ---------------------------------------------------------------------------

_JWT_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJ1OjE6YWJjMTIzIn0.signature"
_AUDIENCE = "u:1:abc123-def456-ghi789"
JW_FIXTURE_BASE = FORGEJO_BASE


def _jwt_env_patch():
    """Patch env for authorized_integration mode."""
    return patch.dict(os.environ, {
        "ACTIONS_ID_TOKEN_REQUEST_URL": "https://forgejo.example.com/api/actions/oidc/token?request=1",
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "oidc-request-token-secret",
        "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE": _AUDIENCE,
    }, clear=False)


def _mock_oidc_response(body=None, status=200):
    """Build a mock context manager for urllib.request.urlopen."""
    if body is None:
        body = json.dumps({"value": _JWT_TOKEN})
    mock_resp = Mock()
    mock_resp.status = status
    mock_resp.read = Mock(return_value=body.encode("utf-8"))
    mock_resp.__enter__ = Mock(return_value=mock_resp)
    mock_resp.__exit__ = Mock(return_value=False)
    return mock_resp


class TestAuthorizedIntegrationJwtFetch(unittest.TestCase):
    """JWT fetch from the OIDC token endpoint."""

    def setUp(self):
        fb._JWT_CACHE = None
        fb._JWT_CACHE_TIME = 0.0

    def test_fetch_jwt_success(self):
        mock_resp = _mock_oidc_response()
        mock_urlopen = Mock(return_value=mock_resp)
        with patch("pr_reviewer.forgejo_backend.urllib.request.urlopen", mock_urlopen), \
             patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE), \
             _jwt_env_patch():
            jwt = fb._fetch_authorized_integration_jwt()
        self.assertEqual(jwt, _JWT_TOKEN)
        called_request = mock_urlopen.call_args[0][0]
        self.assertIn(f"audience={_url_quote(_AUDIENCE, safe='')}", called_request.full_url)

    def test_fetch_jwt_caches_and_reuses(self):
        mock_urlopen = Mock(return_value=_mock_oidc_response())
        with patch("pr_reviewer.forgejo_backend.urllib.request.urlopen", mock_urlopen), \
             patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE), \
             _jwt_env_patch():
            jwt1 = fb._get_jwt()
            jwt2 = fb._get_jwt()
        self.assertEqual(jwt1, _JWT_TOKEN)
        self.assertEqual(jwt2, _JWT_TOKEN)
        self.assertEqual(mock_urlopen.call_count, 1)

    def test_fetch_jwt_refetch_after_ttl_expiry(self):
        mock_urlopen = Mock(return_value=_mock_oidc_response())
        with patch("pr_reviewer.forgejo_backend.urllib.request.urlopen", mock_urlopen), \
             patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE), \
             _jwt_env_patch():
            fb._get_jwt()
            fb._JWT_CACHE_TIME -= (fb._JWT_TTL_SECONDS + 1)
            fb._get_jwt()
        self.assertEqual(mock_urlopen.call_count, 2)

    def test_fetch_jwt_missing_env_raises_actionable_error(self):
        with patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE), \
             patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError) as ctx:
                fb._fetch_authorized_integration_jwt()
        self.assertIn("ACTIONS_ID_TOKEN_REQUEST_URL", str(ctx.exception))
        self.assertIn("enable-openid-connect: true", str(ctx.exception))

    def test_fetch_jwt_missing_audience_raises(self):
        with patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", ""), \
             patch.dict(os.environ, {
                 "ACTIONS_ID_TOKEN_REQUEST_URL": "https://example.com/token?x=1",
                 "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "tok",
             }, clear=True):
            with self.assertRaises(RuntimeError) as ctx:
                fb._fetch_authorized_integration_jwt()
        self.assertIn("FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", str(ctx.exception))

    def test_fetch_jwt_oidc_http_error_raises(self):
        error = urllib.error.HTTPError(
            "https://example.com/token", 500, "Internal Server Error",
            {}, io.BytesIO(b'{"message":"server error"}'),
        )
        with patch("pr_reviewer.forgejo_backend.urllib.request.urlopen", side_effect=error), \
             patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE), \
             _jwt_env_patch(), \
             patch.object(fb, "_report_http_error"):
            with self.assertRaises(RuntimeError) as ctx:
                fb._fetch_authorized_integration_jwt()
        self.assertIn("HTTP 500", str(ctx.exception))

    def test_fetch_jwt_missing_value_field_raises(self):
        mock_resp = _mock_oidc_response(body=json.dumps({"not_value": "huh"}))
        with patch("pr_reviewer.forgejo_backend.urllib.request.urlopen", return_value=mock_resp), \
             patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE), \
             _jwt_env_patch(), \
             patch.object(fb, "_report_http_error"):
            with self.assertRaises(RuntimeError) as ctx:
                fb._fetch_authorized_integration_jwt()
        self.assertIn(".value", str(ctx.exception))

    def test_fetch_jwt_network_error_raises(self):
        with patch("pr_reviewer.forgejo_backend.urllib.request.urlopen",
                   side_effect=urllib.error.URLError("connection refused")), \
             patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE), \
             _jwt_env_patch():
            with self.assertRaises(RuntimeError) as ctx:
                fb._fetch_authorized_integration_jwt()
        self.assertIn("network error", str(ctx.exception))


class TestAuthorizedIntegrationAuthHeaders(unittest.TestCase):
    """_resolve_auth_header and _curl produce the right Authorization header."""

    def setUp(self):
        fb._JWT_CACHE = None
        fb._JWT_CACHE_TIME = 0.0

    def test_jwt_mode_returns_bearer_header(self):
        with patch.object(fb, "FORGEJO_AUTH_METHOD", "authorized_integration"), \
             patch.object(fb, "FORGEJO_API_URL", FORGEJO_BASE), \
             patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE), \
             _jwt_env_patch(), \
             patch.object(fb, "_get_jwt", return_value=_JWT_TOKEN):
            header = fb._resolve_auth_header(None)
        self.assertEqual(header, f"Bearer {_JWT_TOKEN}")

    def test_jwt_mode_explicit_empty_token_unauthenticated(self):
        with patch.object(fb, "FORGEJO_AUTH_METHOD", "authorized_integration"), \
             patch.object(fb, "FORGEJO_API_URL", FORGEJO_BASE), \
             patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE), \
             _jwt_env_patch():
            header = fb._resolve_auth_header("")
        self.assertIsNone(header)

    def test_jwt_mode_explicit_pat_override(self):
        with patch.object(fb, "FORGEJO_AUTH_METHOD", "authorized_integration"), \
             patch.object(fb, "FORGEJO_API_URL", FORGEJO_BASE), \
             patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE), \
             _jwt_env_patch():
            header = fb._resolve_auth_header("some-pat-token")
        self.assertEqual(header, "token some-pat-token")

    def test_token_mode_default_returns_pat_header(self):
        with patch.object(fb, "FORGEJO_AUTH_METHOD", "token"), \
             patch.object(fb, "FORGEJO_TOKEN", "my-pat"), \
             patch.object(fb, "GH_TOKEN", ""):
            header = fb._resolve_auth_header(None)
        self.assertEqual(header, "token my-pat")

    def test_token_mode_empty_token_unauthenticated(self):
        with patch.object(fb, "FORGEJO_AUTH_METHOD", "token"), \
             patch.object(fb, "FORGEJO_TOKEN", ""), \
             patch.object(fb, "GH_TOKEN", ""):
            header = fb._resolve_auth_header("")
        self.assertIsNone(header)

    def test_curl_uses_bearer_in_jwt_mode(self):
        """JWT auth header is delivered via --config file, not argv."""
        captured_cmd = []
        def fake_run(cmd, **kwargs):
            captured_cmd.extend(cmd)
            mock_proc = Mock()
            mock_proc.stdout = b'{"ok":true}\n200'
            mock_proc.returncode = 0
            return mock_proc

        with patch.object(fb, "FORGEJO_AUTH_METHOD", "authorized_integration"), \
             patch.object(fb, "FORGEJO_API_URL", FORGEJO_BASE), \
             patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE), \
             _jwt_env_patch(), \
             patch.object(fb, "_get_jwt", return_value=_JWT_TOKEN), \
             patch("pr_reviewer.forgejo_backend.subprocess.run", side_effect=fake_run):
            fb._curl("GET", f"{FORGEJO_BASE}/api/v1/user")

        # --config file must be present
        self.assertTrue(any("--config" in arg for arg in captured_cmd))
        # The raw JWT token must NOT appear in the argv
        self.assertNotIn(_JWT_TOKEN, " ".join(captured_cmd))

    def test_curl_uses_token_in_token_mode(self):
        """PAT auth header is delivered via --config file, not argv."""
        captured_cmd = []
        def fake_run(cmd, **kwargs):
            captured_cmd.extend(cmd)
            mock_proc = Mock()
            mock_proc.stdout = b'{"ok":true}\n200'
            mock_proc.returncode = 0
            return mock_proc

        with patch.object(fb, "FORGEJO_AUTH_METHOD", "token"), \
             patch.object(fb, "FORGEJO_TOKEN", "my-pat"), \
             patch.object(fb, "GH_TOKEN", ""), \
             patch("pr_reviewer.forgejo_backend.subprocess.run", side_effect=fake_run):
            fb._curl("GET", f"{FORGEJO_BASE}/api/v1/user")

        # --config file must be present
        self.assertTrue(any("--config" in arg for arg in captured_cmd))
        # The raw PAT token must NOT appear in the argv
        self.assertNotIn("my-pat", " ".join(captured_cmd))

    def test_curl_auth_config_file_permissions(self):
        """The --config file is created with 0600 permissions."""
        import stat as stat_mod
        captured_config_path = []
        original_fchmod = os.fchmod
        def track_fchmod(fd, mode):
            captured_config_path.append(mode)
            return original_fchmod(fd, mode)

        def fake_run(cmd, **kwargs):
            mock_proc = Mock()
            mock_proc.stdout = b'{"ok":true}\n200'
            mock_proc.returncode = 0
            return mock_proc

        with patch.object(fb, "FORGEJO_AUTH_METHOD", "token"), \
             patch.object(fb, "FORGEJO_TOKEN", "my-pat"), \
             patch.object(fb, "GH_TOKEN", ""), \
             patch("os.fchmod", side_effect=track_fchmod), \
             patch("pr_reviewer.forgejo_backend.subprocess.run", side_effect=fake_run):
            fb._curl("GET", f"{FORGEJO_BASE}/api/v1/user")

        self.assertTrue(captured_config_path)
        self.assertEqual(captured_config_path[0], 0o600)


class TestEnrichTokenForHostJwtMode(unittest.TestCase):
    """_enrich_token_for_host delegates to JWT path for configured host."""

    def setUp(self):
        fb._JWT_CACHE = None
        fb._JWT_CACHE_TIME = 0.0

    def test_configured_host_returns_none_in_jwt_mode(self):
        with patch.object(fb, "FORGEJO_AUTH_METHOD", "authorized_integration"), \
             patch.object(fb, "FORGEJO_API_URL", "https://forgejo.example.com"), \
             patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE):
            token = fb._enrich_token_for_host("forgejo.example.com")
        self.assertIsNone(token)

    def test_unconfigured_host_returns_empty_in_jwt_mode(self):
        with patch.object(fb, "FORGEJO_AUTH_METHOD", "authorized_integration"), \
             patch.object(fb, "FORGEJO_API_URL", "https://forgejo.example.com"), \
             patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE):
            token = fb._enrich_token_for_host("codeberg.org")
        self.assertEqual(token, "")

    def test_configured_host_returns_pat_in_token_mode(self):
        with patch.object(fb, "FORGEJO_AUTH_METHOD", "token"), \
             patch.object(fb, "FORGEJO_API_URL", "https://forgejo.example.com"), \
             patch.object(fb, "FORGEJO_TOKEN", "my-pat"):
            token = fb._enrich_token_for_host("forgejo.example.com")
        self.assertEqual(token, "my-pat")


class TestJwtMasking(unittest.TestCase):
    """Adversarial test (per AGENTS.md #252): the JWT must be masked in errors."""

    def setUp(self):
        fb._JWT_CACHE = None
        fb._JWT_CACHE_TIME = 0.0

    def test_jwt_does_not_leak_in_runtime_error_message(self):
        error = urllib.error.HTTPError(
            "https://example.com/token", 401, "Unauthorized",
            {}, io.BytesIO(json.dumps({"value": _JWT_TOKEN}).encode()),
        )
        with patch("pr_reviewer.forgejo_backend.urllib.request.urlopen", side_effect=error), \
             patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE), \
             _jwt_env_patch(), \
             patch.object(fb, "_report_http_error"):
            with self.assertRaises(RuntimeError) as ctx:
                fb._fetch_authorized_integration_jwt()
        self.assertIn("401", str(ctx.exception))
        self.assertNotIn(_JWT_TOKEN, str(ctx.exception))


class TestJwtCacheConcurrency(unittest.TestCase):
    """Concurrent _get_jwt() calls must not race-write the JWT cache (#538)."""

    def setUp(self):
        fb._JWT_CACHE = None
        fb._JWT_CACHE_TIME = 0.0

    def _run_concurrent_get_jwt(self, n=10):
        """Run n threads through _get_jwt() and return (results, urlopen_mock)."""
        barrier = threading.Barrier(n)
        results = [None] * n
        errors = []

        def worker(i):
            try:
                barrier.wait()
                results[i] = fb._get_jwt()
            except Exception as exc:  # noqa: BLE001 - surfaced via errors list
                errors.append(exc)

        # A small delay in the token-exchange widens the race window so the
        # test deterministically fails if the lock is removed (N threads would
        # all pass the expiry check before any repopulates the cache).
        def slow_urlopen(*args, **kwargs):
            time.sleep(0.05)
            return _mock_oidc_response()

        with patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE), \
             _jwt_env_patch(), \
             patch("pr_reviewer.forgejo_backend.urllib.request.urlopen",
                   side_effect=slow_urlopen) as mock_urlopen:
            threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=30)
        self.assertEqual(errors, [])
        return results, mock_urlopen

    def test_concurrent_calls_cleared_cache_single_fetch(self):
        """(a) 10 concurrent _get_jwt() calls with a cleared cache -> exactly 1 urlopen."""
        results, mock_urlopen = self._run_concurrent_get_jwt(10)
        self.assertEqual(mock_urlopen.call_count, 1)
        self.assertEqual(results, [_JWT_TOKEN] * 10)

    def test_concurrent_calls_past_ttl_single_fetch(self):
        """(b) 10 concurrent calls landing just past the TTL -> exactly 1 fetch."""
        fb._JWT_CACHE = "stale-token"
        fb._JWT_CACHE_TIME = time.time() - fb._JWT_TTL_SECONDS - 10
        results, mock_urlopen = self._run_concurrent_get_jwt(10)
        self.assertEqual(mock_urlopen.call_count, 1)
        self.assertEqual(results, [_JWT_TOKEN] * 10)

    def test_serial_cache_hit_no_fetch(self):
        """(c) Serial cache-hit / cache-miss / TTL-expiry behaviour is preserved."""
        # Cache hit: fresh cache -> no fetch
        fb._JWT_CACHE = _JWT_TOKEN
        fb._JWT_CACHE_TIME = time.time()
        with patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE), \
             _jwt_env_patch(), \
             patch("pr_reviewer.forgejo_backend.urllib.request.urlopen",
                   return_value=_mock_oidc_response()) as mock_urlopen:
            self.assertEqual(fb._get_jwt(), _JWT_TOKEN)
        self.assertEqual(mock_urlopen.call_count, 0)

        # Cache miss: cleared cache -> exactly one fetch
        fb._JWT_CACHE = None
        fb._JWT_CACHE_TIME = 0.0
        with patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE), \
             _jwt_env_patch(), \
             patch("pr_reviewer.forgejo_backend.urllib.request.urlopen",
                   return_value=_mock_oidc_response()) as mock_urlopen:
            self.assertEqual(fb._get_jwt(), _JWT_TOKEN)
        self.assertEqual(mock_urlopen.call_count, 1)

        # TTL expiry: stale cache -> exactly one fetch
        fb._JWT_CACHE = "stale-token"
        fb._JWT_CACHE_TIME = time.time() - fb._JWT_TTL_SECONDS - 10
        with patch.object(fb, "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE", _AUDIENCE), \
             _jwt_env_patch(), \
             patch("pr_reviewer.forgejo_backend.urllib.request.urlopen",
                   return_value=_mock_oidc_response()) as mock_urlopen:
            self.assertEqual(fb._get_jwt(), _JWT_TOKEN)
        self.assertEqual(mock_urlopen.call_count, 1)


if __name__ == "__main__":
    unittest.main()
