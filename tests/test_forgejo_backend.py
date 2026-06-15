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
from unittest.mock import Mock, patch

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
    the exact invocation: the original implementation passed ``gh pr view
    --json`` field names that don't exist (user/head/base/merged_at) and a
    ``--create-if-none`` flag that is invalid without ``--edit-last`` — both
    invisible to tests that only checked the fallback result.
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

    def test_create_comment_does_not_pass_create_if_none(self):
        # --create-if-none is only valid with --edit-last; plain creation
        # must not send it.
        url = "https://github.com/misospace/pr-reviewer-action/pull/42#issuecomment-77"
        with patch.object(fb, "FORGEJO_API_URL", ""), \
             patch.object(fb, "_gh", return_value=(0, url + "\n")) as mock_gh:
            result = fb.create_comment("misospace/pr-reviewer-action", 42, "hello")

        args = mock_gh.call_args[0]
        self.assertNotIn("--create-if-none", args)
        self.assertEqual(result["id"], 77)
        self.assertEqual(result["html_url"], url)

    def test_edit_last_comment_parses_gh_url(self):
        # gh prints .../pull/N#issuecomment-ID — no slash before the fragment.
        url = "https://github.com/misospace/pr-reviewer-action/pull/42#issuecomment-88"
        with patch.object(fb, "FORGEJO_API_URL", ""), \
             patch.object(fb, "_gh", return_value=(0, url + "\n")):
            result = fb.edit_last_comment("misospace/pr-reviewer-action", 42, "updated")

        self.assertEqual(result["id"], 88)
        self.assertEqual(result["html_url"], url)



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
    def test_create_native_review_posts_approve_event(self, mock_curl):
        seen = {}

        def _run(method: str, url: str, **kwargs: Any) -> tuple[int, str]:
            seen.update(method=method, url=url, data=kwargs.get("data"))
            return 201, json.dumps(dict(REVIEW, id=57, state="APPROVE"))

        mock_curl.side_effect = _run

        with _forgejo_env_patch():
            result = fb.create_native_review("misospace/pr-reviewer-action", 42, "APPROVE", "looks good")

        self.assertIsNotNone(result)
        self.assertEqual(seen["data"], {"body": "looks good", "event": "APPROVE"})

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


if __name__ == "__main__":
    unittest.main()
