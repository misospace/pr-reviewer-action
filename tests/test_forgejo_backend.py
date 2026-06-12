#!/usr/bin/env python3
"""Tests for the Forgejo REST backend.

Uses unittest.mock.patch to intercept _curl calls, avoiding the need for a
live HTTP server or subprocess mocking.  Mirrors the structure and coverage
of the existing fake-gh test suites.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

# Ensure the project root is on sys.path so we can import pr_reviewer modules.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

import pr_reviewer.forgejo_backend as fb  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

COMMENT_MARKER = "<!-- ai-pr-reviewer -->"

PR_META = {
    "index": 42,
    "title": "Add new feature",
    "body": "This PR adds the new feature.\n\nFixes #100",
    "status": "open",
    "user": {"login": "contributor"},
    "head": {
        "sha": "abc123def456",
        "ref": "feature-branch",
        "name": "pr-reviewer-action",
        "owner": {"login": "contributor"},
    },
    "base": {
        "sha": "789xyz000",
        "ref": "main",
        "name": "pr-reviewer-action",
        "owner": {"login": "misospace"},
    },
    "merged_at": None,
    "created_at": "2026-06-11T10:00:00Z",
    "updated_at": "2026-06-11T12:00:00Z",
    "html_url": "https://forgejo.example.com/misospace/pr-reviewer-action/pulls/42",
    "is_draft": False,
    "labels": [{"name": "enhancement"}],
}

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
    "index": 100,
    "title": "Bug report",
    "body": "Found a bug in the system.",
    "status": "open",
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


class TestGitHubModeFallsBack(unittest.TestCase):
    """Test that when FORGEJO_API_URL is not set, GitHub mode is used."""

    def test_get_pr_metadata_uses_gh_when_no_forgejo_url(self):
        with patch.object(fb, "FORGEJO_API_URL", ""):
            result = fb.get_pr_metadata("misospace/pr-reviewer-action", 42)

        self.assertIsNone(result)

    def test_get_pr_diff_returns_empty_when_no_gh(self):
        with patch.object(fb, "FORGEJO_API_URL", ""):
            result = fb.get_pr_diff("misospace/pr-reviewer-action", 42)

        self.assertEqual(result, "")


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


if __name__ == "__main__":
    unittest.main()
