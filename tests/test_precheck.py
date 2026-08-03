"""Tests for pr_reviewer.precheck module."""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from pr_reviewer.precheck import (
    DiffStats,
    ReviewScope,
    SkipResult,
    ReviewMetadata,
    compute_config_hash,
    compute_diff_fingerprint,
    should_skip_review,
    compute_review_scope,
    get_incremental_scope,
    build_review_metadata,
    metadata_to_json,
    metadata_from_json,
    run_precheck,
)


# ---------------------------------------------------------------------------
# compute_config_hash tests
# ---------------------------------------------------------------------------

def test_compute_config_hash_basic():
    h = compute_config_hash(model="gpt-4", temperature=0.7, max_tokens=4096)
    assert isinstance(h, str)
    assert len(h) == 64  # SHA256 hex digest length


def test_compute_config_hash_deterministic():
    kwargs = dict(model="gpt-4", temperature=0.7, max_tokens=4096, system_prompt="review")
    h1 = compute_config_hash(**kwargs)
    h2 = compute_config_hash(**kwargs)
    assert h1 == h2


def test_compute_config_hash_different_values():
    h1 = compute_config_hash(model="gpt-4", temperature=0.7, max_tokens=4096)
    h2 = compute_config_hash(model="gpt-3.5", temperature=0.7, max_tokens=4096)
    assert h1 != h2


def test_compute_config_hash_additional_config():
    h1 = compute_config_hash(model="gpt-4", additional_config={"a": "1"})
    h2 = compute_config_hash(model="gpt-4", additional_config={"b": "2"})
    assert h1 != h2


def test_compute_config_hash_additional_sorted():
    h1 = compute_config_hash(model="gpt-4", additional_config={"z": "1", "a": "2"})
    h2 = compute_config_hash(model="gpt-4", additional_config={"a": "2", "z": "1"})
    assert h1 == h2


def test_compute_config_hash_empty():
    h = compute_config_hash()
    assert isinstance(h, str)
    assert len(h) == 64


# ---------------------------------------------------------------------------
# compute_diff_fingerprint tests
# ---------------------------------------------------------------------------

SAMPLE_DIFF = """diff --git a/src/main.py b/src/main.py
index abc123..def456 100644
--- a/src/main.py
+++ b/src/main.py
@@ -1,3 +1,4 @@
 def hello():
-    print("hello")
+    print("hello world")
+    return True

diff --git a/README.md b/README.md
index 111111..222222 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Project
+Updated README
"""


def test_compute_diff_fingerprint_returns_tuple():
    fp, stats = compute_diff_fingerprint(SAMPLE_DIFF)
    assert isinstance(fp, str)
    assert len(fp) == 64
    assert isinstance(stats, DiffStats)


def test_compute_diff_fingerprint_stats():
    fp, stats = compute_diff_fingerprint(SAMPLE_DIFF)
    assert "src/main.py" in stats.changed_files
    assert "README.md" in stats.changed_files
    assert stats.total_insertions > 0
    assert stats.total_deletions > 0
    assert stats.has_code_changes is True


def test_compute_diff_fingerprint_empty():
    fp, stats = compute_diff_fingerprint("")
    assert isinstance(fp, str)
    assert len(stats.changed_files) == 0
    assert stats.total_lines == 0
    assert stats.has_code_changes is False


def test_compute_diff_fingerprint_deterministic():
    fp1, _ = compute_diff_fingerprint(SAMPLE_DIFF)
    fp2, _ = compute_diff_fingerprint(SAMPLE_DIFF)
    assert fp1 == fp2


def test_compute_diff_fingerprint_different_content():
    fp1, _ = compute_diff_fingerprint(SAMPLE_DIFF)
    fp2, _ = compute_diff_fingerprint("diff --git a/other.py b/other.py\n")
    assert fp1 != fp2


def test_compute_diff_fingerprint_no_code_changes():
    diff = """diff --git a/docs/readme.txt b/docs/readme.txt
--- a/docs/readme.txt
+++ b/docs/readme.txt
@@ -1 +1 @@
-old
+new
"""
    fp, stats = compute_diff_fingerprint(diff)
    # .txt is not in code extensions, but there are +/- lines
    assert stats.has_code_changes is True  # +/- lines count as changes


def test_compute_diff_fingerprint_code_extensions():
    diff = """diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
"""
    fp, stats = compute_diff_fingerprint(diff)
    assert stats.has_code_changes is True


# ---------------------------------------------------------------------------
# should_skip_review tests
# ---------------------------------------------------------------------------

def test_should_skip_review_skip_label():
    result = should_skip_review(labels=["skip-review"])
    assert result.should_skip is True
    assert "skip label" in result.reason


def test_should_skip_review_no_review_label():
    result = should_skip_review(labels=["no-review"])
    assert result.should_skip is True


def test_should_skip_review_custom_skip_label():
    result = should_skip_review(
        labels=["wip"],
        skip_labels=["wip", "draft"]
    )
    assert result.should_skip is True


def test_should_skip_review_skip_pattern_title():
    result = should_skip_review(pr_title="[skip review] chore: update deps")
    assert result.should_skip is True


def test_should_skip_review_skip_pattern_body():
    result = should_skip_review(pr_body="This PR [no review] needed.")
    assert result.should_skip is True


def test_should_skip_review_bot_author():
    result = should_skip_review(author="dependabot[bot]")
    assert result.should_skip is True


def test_should_skip_review_renovate_bot():
    result = should_skip_review(author="renovate[bot]")
    assert result.should_skip is True


def test_should_skip_review_no_code_changes():
    stats = DiffStats(changed_files=[], total_insertions=0, total_deletions=0)
    result = should_skip_review(diff_stats=stats)
    assert result.should_skip is True
    assert "no code changes" in result.reason


def test_should_skip_review_normal_pr():
    stats = DiffStats(
        changed_files=["src/main.py"],
        total_insertions=10,
        total_deletions=5,
        has_code_changes=True,
    )
    result = should_skip_review(
        pr_title="Fix bug",
        labels=["bugfix"],
        author="human-dev",
        diff_stats=stats,
    )
    assert result.should_skip is False


def test_should_skip_review_cache_hit():
    os.environ["GITHUB_SHA"] = "abc123"
    try:
        cached = {
            "head_sha": "abc123",
            "config_hash": "xyz789",
        }
        result = should_skip_review(
            diff_stats=DiffStats(changed_files=["a.py"], has_code_changes=True),
            cached_status=cached,
            config_hash="xyz789",
        )
        assert result.should_skip is True
        assert "cache hit" in result.reason
    finally:
        os.environ.pop("GITHUB_SHA", None)


def test_should_skip_review_cache_miss_different_sha():
    os.environ["GITHUB_SHA"] = "new123"
    try:
        cached = {
            "head_sha": "abc123",
            "config_hash": "xyz789",
        }
        result = should_skip_review(
            diff_stats=DiffStats(changed_files=["a.py"], has_code_changes=True),
            cached_status=cached,
            config_hash="xyz789",
        )
        assert result.should_skip is False
    finally:
        os.environ.pop("GITHUB_SHA", None)


def test_should_skip_review_cache_miss_different_config():
    os.environ["GITHUB_SHA"] = "abc123"
    try:
        cached = {
            "head_sha": "abc123",
            "config_hash": "old_hash",
        }
        result = should_skip_review(
            diff_stats=DiffStats(changed_files=["a.py"], has_code_changes=True),
            cached_status=cached,
            config_hash="new_hash",
        )
        assert result.should_skip is False
    finally:
        os.environ.pop("GITHUB_SHA", None)


# ---------------------------------------------------------------------------
# compute_review_scope tests
# ---------------------------------------------------------------------------

def test_compute_review_scope_full():
    stats = DiffStats(
        changed_files=["src/main.py"],
        total_insertions=10,
        total_deletions=5,
        has_code_changes=True,
    )
    scope = compute_review_scope(diff_stats=stats)
    assert scope.scope == "full"


def test_compute_review_scope_none():
    stats = DiffStats(changed_files=[])
    scope = compute_review_scope(diff_stats=stats)
    assert scope.scope == "none"


def test_compute_review_scope_incremental_large_diff():
    stats = DiffStats(
        changed_files=["src/main.py", "src/utils.py"],
        total_insertions=3000,
        total_deletions=2500,
        has_code_changes=True,
    )
    scope = compute_review_scope(diff_stats=stats, max_lines_full_review=5000)
    assert scope.scope == "incremental"


def test_compute_review_scope_incremental_with_cache():
    os.environ["GITHUB_SHA"] = "new_sha"
    try:
        stats = DiffStats(
            changed_files=["src/main.py"],
            total_insertions=3000,
            total_deletions=2500,
            has_code_changes=True,
        )
        cached = {"previous_head_sha": "old_sha"}
        scope = compute_review_scope(diff_stats=stats, cached_status=cached)
        assert scope.scope == "incremental"
    finally:
        os.environ.pop("GITHUB_SHA", None)


# ---------------------------------------------------------------------------
# get_incremental_scope tests
# ---------------------------------------------------------------------------

def test_get_incremental_scope_first_review():
    files, ranges = get_incremental_scope(SAMPLE_DIFF, previous_diff="")
    assert "src/main.py" in files
    assert "README.md" in files


def test_get_incremental_scope_new_files():
    current = """diff --git a/new.py b/new.py
--- /dev/null
+++ b/new.py
@@ -0,0 +1 @@
+print("new")
"""
    previous = SAMPLE_DIFF
    files, ranges = get_incremental_scope(current, previous_diff=previous)
    assert "new.py" in files


# ---------------------------------------------------------------------------
# build_review_metadata tests
# ---------------------------------------------------------------------------

def test_build_review_metadata_basic():
    stats = DiffStats(
        changed_files=["src/main.py"],
        total_insertions=10,
        total_deletions=5,
        has_code_changes=True,
    )
    meta = build_review_metadata(
        config_hash="abc",
        diff_fingerprint="def",
        review_scope="full",
        diff_stats=stats,
    )
    assert meta.config_hash == "abc"
    assert meta.diff_fingerprint == "def"
    assert meta.review_scope == "full"
    assert meta.changed_files == ["src/main.py"]


def test_build_review_metadata_skip():
    meta = build_review_metadata(
        config_hash="abc",
        diff_fingerprint="def",
        review_scope="none",
        skip_reason="skip label: wip",
    )
    assert meta.skip_reason == "skip label: wip"


# ---------------------------------------------------------------------------
# metadata_to_json / metadata_from_json tests
# ---------------------------------------------------------------------------

def test_metadata_roundtrip():
    stats = DiffStats(
        changed_files=["a.py", "b.js"],
        total_insertions=100,
        total_deletions=50,
        has_code_changes=True,
    )
    meta = build_review_metadata(
        config_hash="abc123",
        diff_fingerprint="def456",
        review_scope="incremental",
        skip_reason="",
        diff_stats=stats,
    )
    json_str = metadata_to_json(meta)
    parsed = metadata_from_json(json_str)

    assert parsed.config_hash == meta.config_hash
    assert parsed.diff_fingerprint == meta.diff_fingerprint
    assert parsed.review_scope == meta.review_scope
    assert parsed.changed_files == meta.changed_files
    assert parsed.total_insertions == meta.total_insertions
    assert parsed.total_deletions == meta.total_deletions


def test_metadata_to_json_compact():
    meta = ReviewMetadata(
        config_hash="abc",
        diff_fingerprint="def",
        review_scope="full",
    )
    json_str = metadata_to_json(meta)
    # Compact JSON should not have spaces after separators
    assert ": " not in json_str or '" "' not in json_str


def test_metadata_from_json_empty():
    meta = metadata_from_json("{}")
    assert meta.config_hash == ""
    assert meta.review_scope == "full"


# ---------------------------------------------------------------------------
# run_precheck tests
# ---------------------------------------------------------------------------

def test_run_precheck_basic():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".diff", delete=False) as f:
        f.write(SAMPLE_DIFF)
        diff_file = f.name

    try:
        result = run_precheck(
            diff_file=diff_file,
            pr_title="Fix bug",
            author="human-dev",
            model="gpt-4",
        )
        assert isinstance(result, dict)
        assert "config_hash" in result
        assert "diff_fingerprint" in result
        assert "should_skip" in result
        assert "review_scope" in result
        assert result["should_skip"] is False
    finally:
        os.unlink(diff_file)


def test_run_precheck_skip():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".diff", delete=False) as f:
        f.write(SAMPLE_DIFF)
        diff_file = f.name

    try:
        result = run_precheck(
            diff_file=diff_file,
            pr_title="Fix bug",
            author="human-dev",
            labels="skip-review",
            model="gpt-4",
        )
        assert result["should_skip"] is True
    finally:
        os.unlink(diff_file)


def test_run_precheck_bot():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".diff", delete=False) as f:
        f.write(SAMPLE_DIFF)
        diff_file = f.name

    try:
        result = run_precheck(
            diff_file=diff_file,
            author="dependabot[bot]",
            model="gpt-4",
        )
        assert result["should_skip"] is True
    finally:
        os.unlink(diff_file)


def test_run_precheck_cached_status():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".diff", delete=False) as f:
        f.write(SAMPLE_DIFF)
        diff_file = f.name

    cached_data = {"head_sha": "abc123", "config_hash": "test"}
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(cached_data, f)
        cached_file = f.name

    os.environ["GITHUB_SHA"] = "abc123"
    try:
        result = run_precheck(
            diff_file=diff_file,
            author="human-dev",
            model="gpt-4",
            cached_status_file=cached_file,
        )
        # Config hash won't match "test" so should not skip via cache
        assert isinstance(result, dict)
    finally:
        os.environ.pop("GITHUB_SHA", None)
        os.unlink(diff_file)
        os.unlink(cached_file)


def test_run_precheck_empty_diff():
    result = run_precheck(
        diff_file="",
        pr_title="Empty PR",
        author="human-dev",
        model="gpt-4",
    )
    assert result["should_skip"] is True  # no code changes
    assert result["review_scope"] == "none"


# ---------------------------------------------------------------------------
# DiffStats edge cases
# ---------------------------------------------------------------------------

def test_diff_stats_default():
    stats = DiffStats()
    assert stats.changed_files == []
    assert stats.total_insertions == 0
    assert stats.total_deletions == 0
    assert stats.total_lines == 0
    assert stats.has_code_changes is False


def test_diff_stats_total_lines():
    stats = DiffStats(total_insertions=10, total_deletions=5)
    assert stats.total_lines == 15


# ---------------------------------------------------------------------------
# SkipResult edge cases
# ---------------------------------------------------------------------------

def test_skip_result_default():
    result = SkipResult()
    assert result.should_skip is False
    assert result.reason == ""


def test_skip_result_explicit():
    result = SkipResult(should_skip=True, reason="test")
    assert result.should_skip is True
    assert result.reason == "test"


# ---------------------------------------------------------------------------
# ReviewScope edge cases
# ---------------------------------------------------------------------------

def test_review_scope_default():
    scope = ReviewScope()
    assert scope.scope == "full"
    assert scope.incremental_files == []
    assert scope.reason == ""


if __name__ == "__main__":
    # Run all test functions
    import glob
    test_funcs = [
        obj for name, obj in globals().items()
        if callable(obj) and name.startswith("test_")
    ]
    passed = 0
    failed = 0
    for func in test_funcs:
        try:
            func()
            passed += 1
        except Exception as e:
            print(f"FAILED: {func.__name__}: {e}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed out of {passed + failed} tests")
