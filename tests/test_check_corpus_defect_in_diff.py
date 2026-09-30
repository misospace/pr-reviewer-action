"""Unit tests for scripts/check_corpus_defect_in_diff.py's pure logic (#842).

No network: `check_entries` takes an injected `fetch_compare` callable, so
every case here is fixture JSON shaped like a GitHub compare response.
"""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from check_corpus_defect_in_diff import (
    GitHubAPIError,
    check_entries,
    defect_file_in_changed_files,
    files_from_compare,
)


def _compare(*filenames_and_previous):
    """Build a fixture compare response from (filename, previous_filename) pairs."""
    files = []
    for item in filenames_and_previous:
        filename, previous = item if isinstance(item, tuple) else (item, None)
        f = {"filename": filename}
        if previous:
            f["previous_filename"] = previous
        files.append(f)
    return {"files": files}


class TestFilesFromCompare:
    def test_collects_filenames(self):
        assert files_from_compare(_compare("a.py", "b/c.py")) == {"a.py", "b/c.py"}

    def test_includes_previous_filename_for_renames(self):
        assert files_from_compare(_compare(("new.py", "old.py"))) == {"new.py", "old.py"}

    def test_empty_files_list(self):
        assert files_from_compare({"files": []}) == set()

    def test_missing_files_key(self):
        assert files_from_compare({}) == set()

    def test_normalizes_case_and_leading_dot_slash(self):
        assert files_from_compare(_compare("./A/B.py")) == {"a/b.py"}


class TestDefectFileInChangedFiles:
    def test_none_when_no_defect_file(self):
        assert defect_file_in_changed_files(None, {"a.py"}) is None
        assert defect_file_in_changed_files("", {"a.py"}) is None

    def test_exact_match(self):
        assert defect_file_in_changed_files("a.py", {"a.py"}) is True

    def test_no_match(self):
        assert defect_file_in_changed_files("a.py", {"b.py"}) is False

    def test_suffix_match_on_path_boundary(self):
        assert defect_file_in_changed_files(
            "llm/litellm/llama-nvidia.yaml",
            {"kubernetes/apps/base/llm/litellm/llama-nvidia.yaml"},
        ) is True

    def test_suffix_match_does_not_false_positive_on_partial_segment(self):
        assert defect_file_in_changed_files(
            "nvidia.yaml", {"kubernetes/apps/base/llm/litellm/llama-nvidia.yaml"},
        ) is False


class TestCheckEntries:
    def _entry(self, **overrides):
        e = {
            "id": "acme/repo#1@abc123",
            "repo_full_name": "acme/repo",
            "head_sha": "h" * 40,
            "base_sha": "b" * 40,
            "defect": {"file": "a.py"},
        }
        e.update(overrides)
        return e

    def test_ok_when_defect_file_is_in_the_diff(self):
        entry = self._entry()
        result = check_entries([entry], lambda repo, base, head: _compare("a.py"))
        assert result == [{
            "id": "acme/repo#1@abc123", "ok": True,
            "reason": "defect file changed between base and head",
        }]

    def test_flags_the_842_case_fix_already_present_at_head(self):
        """The exact #842 shape: the pinned head's diff (against its base)
        doesn't touch the defect file at all, because the file's fix landed
        in an earlier commit already folded into that head."""
        entry = self._entry(defect={"file": "llm/llama-nvidia.yaml"})
        result = check_entries([entry], lambda repo, base, head: _compare("other/file.yaml"))
        assert result[0]["ok"] is False
        assert "NOT in the base..head diff" in result[0]["reason"]

    def test_skips_entries_missing_base_sha(self):
        entry = self._entry(base_sha=None)
        assert check_entries([entry], lambda *a: _compare("a.py")) == []

    def test_skips_entries_missing_defect_file(self):
        entry = self._entry(defect={})
        assert check_entries([entry], lambda *a: _compare("a.py")) == []

    def test_skips_clean_entries_without_a_defect_block(self):
        entry = self._entry(defect=None)
        assert check_entries([entry], lambda *a: _compare("a.py")) == []

    def test_compare_failure_is_reported_not_raised(self):
        entry = self._entry()

        def _boom(repo, base, head):
            raise GitHubAPIError("404")

        result = check_entries([entry], _boom)
        assert result[0]["ok"] is None
        assert "compare failed" in result[0]["reason"]

    def test_fetch_compare_receives_repo_base_head(self):
        entry = self._entry()
        seen = []

        def _capture(repo, base, head):
            seen.append((repo, base, head))
            return _compare("a.py")

        check_entries([entry], _capture)
        assert seen == [("acme/repo", "b" * 40, "h" * 40)]
