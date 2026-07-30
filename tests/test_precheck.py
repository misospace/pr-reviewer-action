"""Tests for pr_reviewer.precheck — extracted from check_review_needed.sh."""

import json
import os
from pathlib import Path
from unittest.mock import patch

from pr_reviewer.precheck import (
    ReviewMetadata,
    clear_cache,
    compute_config_hash,
    compute_diff_fingerprint,
    compute_diff_stats,
    get_incremental_scope,
    main,
    read_review_metadata,
    run_precheck,
    save_cache,
    should_skip_review,
    write_review_metadata,
)

# ---------------------------------------------------------------------------
# Config hash tests
# ---------------------------------------------------------------------------

class TestComputeConfigHash:
    def test_empty_list(self):
        assert compute_config_hash([]) == ""

    def test_nonexistent_files(self):
        assert compute_config_hash(["/no/such/file"]) == ""

    def test_single_file(self, tmp_path):
        cfg = tmp_path / "config.yml"
        cfg.write_text("key: value")
        result = compute_config_hash([str(cfg)])
        assert len(result) == 64  # SHA-256 hex digest

    def test_multiple_files_sorted(self, tmp_path):
        a = tmp_path / "a.yml"
        b = tmp_path / "b.yml"
        a.write_text("first")
        b.write_text("second")
        # Order should not matter — files are sorted
        hash1 = compute_config_hash([str(b), str(a)])
        hash2 = compute_config_hash([str(a), str(b)])
        assert hash1 == hash2

    def test_content_change_changes_hash(self, tmp_path):
        cfg = tmp_path / "config.yml"
        cfg.write_text("v1")
        h1 = compute_config_hash([str(cfg)])
        cfg.write_text("v2")
        h2 = compute_config_hash([str(cfg)])
        assert h1 != h2


# ---------------------------------------------------------------------------
# Diff fingerprint tests
# ---------------------------------------------------------------------------

class TestComputeDiffFingerprint:
    def test_empty(self):
        assert compute_diff_fingerprint("") == ""

    def test_whitespace_only(self):
        assert compute_diff_fingerprint("   \n  ") == ""

    def test_valid_diff(self):
        diff = "diff --git a/file.py b/file.py\n--- a/file.py\n+++ b/file.py"
        result = compute_diff_fingerprint(diff)
        assert len(result) == 64

    def test_different_content_different_hash(self):
        h1 = compute_diff_fingerprint("diff content A")
        h2 = compute_diff_fingerprint("diff content B")
        assert h1 != h2


# ---------------------------------------------------------------------------
# Incremental scope tests
# ---------------------------------------------------------------------------

class TestGetIncrementalScope:
    def test_empty_fingerprint(self):
        result = get_incremental_scope("", "/tmp/cache")
        assert result.scope == "none"

    def test_no_cache_full_scope(self, tmp_path):
        result = get_incremental_scope("abc123", str(tmp_path))
        assert result.scope == "full"
        assert result.current_fingerprint == "abc123"

    def test_matching_fingerprint_incremental(self, tmp_path):
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        (cache_dir / "fingerprint").write_text("abc123\n")
        (cache_dir / "files.json").write_text(
            json.dumps({"changed_files": ["a.py", "b.py"], "total_files": 10})
        )
        result = get_incremental_scope("abc123", str(cache_dir))
        assert result.scope == "incremental"
        assert result.changed_files == ["a.py", "b.py"]
        assert result.total_files == 10

    def test_different_fingerprint_full(self, tmp_path):
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        (cache_dir / "fingerprint").write_text("old_hash\n")
        result = get_incremental_scope("new_hash", str(cache_dir))
        assert result.scope == "full"
        assert result.cached_fingerprint == "old_hash"

    def test_cache_read_error(self, tmp_path):
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        # Write binary garbage to fingerprint file
        (cache_dir / "fingerprint").write_bytes(b"\x00\x01\x02")
        result = get_incremental_scope("abc123", str(cache_dir))
        assert result.scope == "full"


# ---------------------------------------------------------------------------
# Skip evaluation tests
# ---------------------------------------------------------------------------

class TestShouldSkipReview:
    def test_empty_diff(self):
        skip, reason = should_skip_review("", [], [], [])
        assert skip is True
        assert reason == "empty_diff"

    def test_whitespace_diff(self):
        skip, reason = should_skip_review("   \n  ", [], [], [])
        assert skip is True
        assert reason == "empty_diff"

    def test_skip_label_match(self):
        skip, reason = should_skip_review(
            "some diff", ["skip-review"], ["Skip-Review"], []
        )
        assert skip is True
        assert reason == "skip_label:skip-review"

    def test_auto_merge_label(self):
        skip, reason = should_skip_review(
            "some diff", [], ["auto-merge"], []
        )
        assert skip is True
        assert reason == "auto_merge"

    def test_no_skip(self):
        skip, reason = should_skip_review(
            "diff --git a/src/main.py b/src/main.py\n--- a/src/main.py\n+++ b/src/main.py",
            ["skip-review"],
            ["enhancement"],
            [],
        )
        assert skip is False
        assert reason == ""

    def test_skip_paths_all_match(self):
        diff = (
            "diff --git a/docs/readme.md b/docs/readme.md\n"
            "--- a/docs/readme.md\n"
            "+++ b/docs/readme.md\n"
        )
        skip, reason = should_skip_review(
            diff, [], [], ["docs/"]
        )
        assert skip is True
        assert reason == "skip_paths"

    def test_skip_paths_partial_match(self):
        diff = (
            "diff --git a/docs/readme.md b/docs/readme.md\n"
            "--- a/docs/readme.md\n"
            "+++ b/docs/readme.md\n"
            "diff --git a/src/main.py b/src/main.py\n"
            "--- a/src/main.py\n"
            "+++ b/src/main.py\n"
        )
        skip, _reason = should_skip_review(
            diff, [], [], ["docs/"]
        )
        assert skip is False

    def test_skip_paths_exact_match(self):
        diff = (
            "diff --git a/package.json b/package.json\n"
            "--- a/package.json\n"
            "+++ b/package.json\n"
        )
        skip, _reason = should_skip_review(
            diff, [], [], ["package.json"]
        )
        assert skip is True


# ---------------------------------------------------------------------------
# Diff stats tests
# ---------------------------------------------------------------------------

class TestComputeDiffStats:
    def test_empty(self):
        stats = compute_diff_stats("")
        assert stats == {"files_changed": 0, "insertions": 0, "deletions": 0}

    def test_single_file(self):
        diff = (
            "diff --git a/file.py b/file.py\n"
            "--- a/file.py\n"
            "+++ b/file.py\n"
            "@@ -1,3 +1,5 @@\n"
            " line1\n"
            "+line2\n"
            "+line3\n"
        )
        stats = compute_diff_stats(diff)
        assert stats["files_changed"] == 1
        assert stats["insertions"] == 5
        assert stats["deletions"] == 3

    def test_multiple_files(self):
        diff = (
            "diff --git a/a.py b/a.py\n"
            "--- a/a.py\n"
            "+++ b/a.py\n"
            "@@ -1,2 +1,3 @@\n"
            "diff --git a/b.py b/b.py\n"
            "--- a/b.py\n"
            "+++ b/b.py\n"
            "@@ -10,5 +10,8 @@\n"
        )
        stats = compute_diff_stats(diff)
        assert stats["files_changed"] == 2


# ---------------------------------------------------------------------------
# Metadata I/O tests
# ---------------------------------------------------------------------------

class TestMetadataIO:
    def test_write_and_read(self, tmp_path):
        meta = ReviewMetadata(
            review_needed=True,
            diff_fingerprint="fp123",
            config_hash="ch456",
            pr_number=42,
        )
        out = str(tmp_path / "meta.json")
        write_review_metadata(meta, out)

        loaded = read_review_metadata(out)
        assert loaded is not None
        assert loaded.review_needed is True
        assert loaded.diff_fingerprint == "fp123"
        assert loaded.pr_number == 42

    def test_read_nonexistent(self):
        assert read_review_metadata("/no/such/file.json") is None

    def test_read_invalid_json(self, tmp_path):
        bad = tmp_path / "bad.json"
        bad.write_text("not json at all")
        assert read_review_metadata(str(bad)) is None


# ---------------------------------------------------------------------------
# Cache tests
# ---------------------------------------------------------------------------

class TestCache:
    def test_save_and_verify(self, tmp_path):
        cache_dir = str(tmp_path / "cache")
        save_cache("fp123", ["a.py", "b.py"], 5, cache_dir)

        fp_file = Path(cache_dir) / "fingerprint"
        assert fp_file.read_text().strip() == "fp123"

        files_file = Path(cache_dir) / "files.json"
        data = json.loads(files_file.read_text())
        assert data["changed_files"] == ["a.py", "b.py"]
        assert data["total_files"] == 5

    def test_clear_cache(self, tmp_path):
        cache_dir = str(tmp_path / "cache")
        save_cache("fp123", ["a.py"], 1, cache_dir)
        clear_cache(cache_dir)

        assert not (Path(cache_dir) / "fingerprint").exists()
        assert not (Path(cache_dir) / "files.json").exists()


# ---------------------------------------------------------------------------
# Full pipeline tests
# ---------------------------------------------------------------------------

class TestRunPrecheck:
    def test_skip_empty_diff(self, tmp_path):
        meta = run_precheck(
            diff_content="",
            config_files=[],
            cache_dir=str(tmp_path / "cache"),
            skip_labels=["skip-review"],
            pr_labels=[],
            skip_paths=[],
            output_path=str(tmp_path / "meta.json"),
        )
        assert meta.review_needed is False
        assert meta.skip_reason == "empty_diff"

    def test_skip_label(self, tmp_path):
        meta = run_precheck(
            diff_content="diff --git a/x b/x",
            config_files=[],
            cache_dir=str(tmp_path / "cache"),
            skip_labels=["skip-review"],
            pr_labels=["skip-review"],
            skip_paths=[],
            output_path=str(tmp_path / "meta.json"),
        )
        assert meta.review_needed is False
        assert meta.skip_reason == "skip_label:skip-review"

    def test_review_needed(self, tmp_path):
        diff = (
            "diff --git a/src/main.py b/src/main.py\n"
            "--- a/src/main.py\n"
            "+++ b/src/main.py\n"
            "@@ -1,2 +1,3 @@\n"
        )
        meta = run_precheck(
            diff_content=diff,
            config_files=[],
            cache_dir=str(tmp_path / "cache"),
            skip_labels=["skip-review"],
            pr_labels=["enhancement"],
            skip_paths=[],
            output_path=str(tmp_path / "meta.json"),
            base_sha="abc123",
            head_sha="def456",
            pr_number=99,
        )
        assert meta.review_needed is True
        assert meta.diff_fingerprint != ""
        assert meta.incremental_scope == "full"
        assert meta.changed_files_count == 1
        assert meta.base_sha == "abc123"
        assert meta.pr_number == 99

    def test_config_hash_included(self, tmp_path):
        cfg = tmp_path / "config.yml"
        cfg.write_text("key: value")
        meta = run_precheck(
            diff_content="diff --git a/x b/x",
            config_files=[str(cfg)],
            cache_dir=str(tmp_path / "cache"),
            skip_labels=[],
            pr_labels=[],
            skip_paths=[],
            output_path=str(tmp_path / "meta.json"),
        )
        assert meta.config_hash != ""
        assert len(meta.config_hash) == 64

    def test_metadata_written_to_file(self, tmp_path):
        run_precheck(
            diff_content="diff --git a/x b/x",
            config_files=[],
            cache_dir=str(tmp_path / "cache"),
            skip_labels=[],
            pr_labels=[],
            skip_paths=[],
            output_path=str(tmp_path / "output.json"),
        )
        assert (tmp_path / "output.json").is_file()
        data = json.loads((tmp_path / "output.json").read_text())
        assert data["review_needed"] is True


# ---------------------------------------------------------------------------
# CLI main tests
# ---------------------------------------------------------------------------

class TestMain:
    def test_main_review_needed(self, tmp_path):
        with patch.dict(os.environ, {
            "DIFF_CONTENT": "diff --git a/x b/x\n--- a/x\n+++ b/x",
            "CONFIG_FILES": "",
            "CACHE_DIR": str(tmp_path / "cache"),
            "SKIP_LABELS": "skip-review",
            "PR_LABELS": "",
            "SKIP_PATHS": "",
            "METADATA_OUTPUT": str(tmp_path / "meta.json"),
            "BASE_SHA": "abc",
            "HEAD_SHA": "def",
            "PR_NUMBER": "1",
        }):
            ret = main()
            assert ret == 0
            assert os.environ["REVIEW_NEEDED"] == "true"

    def test_main_skip(self, tmp_path):
        with patch.dict(os.environ, {
            "DIFF_CONTENT": "",
            "CONFIG_FILES": "",
            "CACHE_DIR": str(tmp_path / "cache"),
            "SKIP_LABELS": "skip-review",
            "PR_LABELS": "",
            "SKIP_PATHS": "",
            "METADATA_OUTPUT": str(tmp_path / "meta.json"),
            "BASE_SHA": "",
            "HEAD_SHA": "",
            "PR_NUMBER": "0",
        }):
            ret = main()
            assert ret == 1
            assert os.environ["SKIP_REASON"] == "empty_diff"
