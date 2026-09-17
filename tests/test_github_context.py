"""Tests for pr_reviewer.github_context."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest import main as unittest_main

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer.github_context import (
    extract_linked_issue_refs,
    linked_issues_to_json,
    MAX_LINKED_ISSUES,
    GITHUB_ISSUE_REF_PATTERN,
)


class TestExtractLinkedIssueRefs:
    def test_closes_hash(self):
        refs = extract_linked_issue_refs("Closes #123", default_repo="owner/repo")
        assert len(refs) == 1
        assert refs[0].number == 123
        assert refs[0].ref == "#123"
        assert refs[0].repo == "owner/repo"

    def test_fixes_with_repo(self):
        refs = extract_linked_issue_refs("Fixes misospace/another-repo#456", default_repo="owner/repo")
        assert len(refs) == 1
        assert refs[0].number == 456
        assert refs[0].repo == "misospace/another-repo"

    def test_multiple_refs_deduplicated(self):
        body = "Closes #1\nFixes #2\nCloses #1\nResolves #3"
        refs = extract_linked_issue_refs(body, default_repo="owner/repo")
        assert len(refs) == 3
        nums = [r.number for r in refs]
        assert nums == [1, 2, 3]

    def test_resolves_keyword(self):
        refs = extract_linked_issue_refs("RESOLVES #99", default_repo="x/y")
        assert len(refs) == 1
        assert refs[0].number == 99

    def test_close_with_colon(self):
        refs = extract_linked_issue_refs("Close: #42", default_repo="a/b")
        assert len(refs) == 1
        assert refs[0].number == 42

    def test_max_8_items(self):
        body = "\n".join(f"Closes #{i}" for i in range(1, 15))
        refs = extract_linked_issue_refs(body, default_repo="owner/repo")
        assert len(refs) == MAX_LINKED_ISSUES

    def test_no_refs(self):
        refs = extract_linked_issue_refs("Just some text", default_repo="owner/repo")
        assert len(refs) == 0

    def test_invalid_number_skipped(self):
        refs = extract_linked_issue_refs("Closes #abc", default_repo="owner/repo")
        assert len(refs) == 0

    def test_uses_env_repo_for_hash_refs(self):
        refs = extract_linked_issue_refs("Closes #42", default_repo=None)
        assert refs[0].repo == ""

    def test_case_insensitive(self):
        refs = extract_linked_issue_refs("FIXES #1\nclose #2", default_repo="owner/repo")
        assert len(refs) == 2

    def test_whitespace_variations(self):
        refs = extract_linked_issue_refs("Closes:  #42", default_repo="x/y")
        assert len(refs) == 1
        assert refs[0].number == 42


class TestLinkedIssuesToJson:
    def test_serialises_correctly(self):
        from pr_reviewer.github_context import LinkedIssueRef
        items = [
            LinkedIssueRef(ref="#1", repo="owner/repo", number=1),
            LinkedIssueRef(ref="other/repo#5", repo="other/repo", number=5),
        ]
        result = linked_issues_to_json(items)
        assert result == [
            {"ref": "#1", "repo": "owner/repo", "number": 1},
            {"ref": "other/repo#5", "repo": "other/repo", "number": 5},
        ]


class TestPattern:
    def test_pattern_matches_closes(self):
        match = GITHUB_ISSUE_REF_PATTERN.search("Closes #123")
        assert match is not None
        assert match.group(1) == "#123"

    def test_pattern_matches_fixes(self):
        match = GITHUB_ISSUE_REF_PATTERN.search("Fixes owner/repo#456")
        assert match is not None
        assert match.group(1) == "owner/repo#456"

    def test_pattern_case_insensitive(self):
        match = GITHUB_ISSUE_REF_PATTERN.search("RESOLVES #99")
        assert match is not None

    def test_pattern_rejects_plain_text(self):
        match = GITHUB_ISSUE_REF_PATTERN.search("Just some text without refs")
        assert match is None


if __name__ == "__main__":
    unittest_main()