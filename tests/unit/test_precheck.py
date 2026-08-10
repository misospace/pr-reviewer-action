"""Unit tests for pr_reviewer.precheck — extracted from check_review_needed.sh.

Covers fingerprinting, config hashing, incremental scope detection,
previous fingerprint extraction, and the main decision logic.
"""

import json
import os
import tempfile

import pytest

from pr_reviewer.precheck import (
    _EXACT_CONFIG_KEYS,
    FP_DELIMITER,
    FP_PREFIX,
    MAX_INCREMENTAL_FILES,
    MAX_INCREMENTAL_LINES,
    MIN_INCREMENTAL_RATIO,
    PrecheckResult,
    ReviewDecision,
    _collect_config_lines,
    _detect_incremental_scope,
    _extract_previous_fingerprints,
    _format_output,
    _parse_diff_stats,
    build_broad_fingerprint,
    compute_config_hash,
    compute_diff_fingerprint,
    extract_config_lines,
    fingerprints_match,
    should_review,
)


# ---------------------------------------------------------------------------
# compute_diff_fingerprint
# ---------------------------------------------------------------------------


class TestComputeDiffFingerprint:
    def test_empty_string_returns_empty(self):
        assert compute_diff_fingerprint("") == ""

    def test_whitespace_only_returns_empty(self):
        assert compute_diff_fingerprint("   \n\n  ") == ""

    def test_none_returns_empty(self):
        assert compute_diff_fingerprint(None) == ""  # type: ignore[arg-type]

    def test_simple_diff_produces_sha256(self):
        diff = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n"
        fp = compute_diff_fingerprint(diff)
        assert len(fp) == 64  # SHA256 hex length
        assert all(c in "0123456789abcdef" for c in fp)

    def test_same_diff_same_fingerprint(self):
        diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"
        assert compute_diff_fingerprint(diff) == compute_diff_fingerprint(diff)

    def test_different_diff_different_fingerprint(self):
        fp_a = compute_diff_fingerprint("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n")
        fp_b = compute_diff_fingerprint("diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-x\n+y\n")
        assert fp_a != fp_b

    def test_unicode_content(self):
        diff = "diff --git a/unicode.txt b/unicode.txt\n--- a/unicode.txt\n+++ b/unicode.txt\n@@ -1 +1 @@\n-你好\n+世界\n"
        fp = compute_diff_fingerprint(diff)
        assert len(fp) == 64


# ---------------------------------------------------------------------------
# compute_config_hash
# ---------------------------------------------------------------------------


class TestComputeConfigHash:
    def test_empty_list_returns_empty(self):
        assert compute_config_hash([]) == ""

    def test_single_line(self):
        h = compute_config_hash(["MODEL=gpt-4"])
        assert len(h) == 64

    def test_order_independent(self):
        lines_a = ["B=2", "A=1"]
        lines_b = ["A=1", "B=2"]
        assert compute_config_hash(lines_a) == compute_config_hash(lines_b)

    def test_comments_filtered(self):
        h_with = compute_config_hash(["# comment", "A=1"])
        h_without = compute_config_hash(["A=1"])
        assert h_with == h_without

    def test_blank_lines_filtered(self):
        h_with = compute_config_hash(["A=1", "", "  "])
        h_without = compute_config_hash(["A=1"])
        assert h_with == h_without

    def test_different_configs_different_hashes(self):
        h_a = compute_config_hash(["MODEL=gpt-4"])
        h_b = compute_config_hash(["MODEL=claude-3"])
        assert h_a != h_b

    def test_strips_whitespace(self):
        h_a = compute_config_hash(["  A=1  "])
        h_b = compute_config_hash(["A=1"])
        assert h_a == h_b


# ---------------------------------------------------------------------------
# build_broad_fingerprint
# ---------------------------------------------------------------------------


class TestBuildBroadFingerprint:
    def test_with_both_parts(self):
        result = build_broad_fingerprint("abc123", "def456")
        assert result == "abc123|def456"

    def test_empty_config_hash(self):
        result = build_broad_fingerprint("abc123", "")
        assert result == "abc123"

    def test_empty_diff_fp(self):
        result = build_broad_fingerprint("", "def456")
        assert result == "|def456"

    def test_both_empty(self):
        result = build_broad_fingerprint("", "")
        assert result == ""


# ---------------------------------------------------------------------------
# _extract_previous_fingerprints
# ---------------------------------------------------------------------------


class TestExtractPreviousFingerprints:
    def test_no_fingerprints(self):
        body = "This is a review comment with no fingerprints."
        assert _extract_previous_fingerprints(body) == []

    def test_single_fingerprint(self):
        body = "Reviewed diff-fp:abc123def456"
        assert _extract_previous_fingerprints(body) == ["abc123def456"]

    def test_multiple_fingerprints(self):
        body = "First: diff-fp:aaa\nSecond: diff-fp:bbb"
        result = _extract_previous_fingerprints(body)
        assert "aaa" in result
        assert "bbb" in result

    def test_case_insensitive_hex(self):
        body = "diff-fp:ABCDEF123456"
        result = _extract_previous_fingerprints(body)
        assert "ABCDEF123456" in result

    def test_embedded_in_markdown(self):
        body = (
            "## Review Summary\n"
            "- Status: Complete\n"
            "- diff-fp:deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567\n"
            "- Files: 3\n"
        )
        result = _extract_previous_fingerprints(body)
        assert len(result) == 1
        assert result[0] == "deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567"

    def test_partial_hex_not_matched(self):
        body = "diff-fp:xyz not hex"
        assert _extract_previous_fingerprints(body) == []


# ---------------------------------------------------------------------------
# fingerprints_match
# ---------------------------------------------------------------------------


class TestFingerprintsMatch:
    def test_match_found(self):
        assert fingerprints_match("abc123", ["def456", "abc123"])

    def test_no_match(self):
        assert not fingerprints_match("abc123", ["def456", "ghi789"])

    def test_empty_previous_list(self):
        assert not fingerprints_match("abc123", [])

    def test_empty_current_fp(self):
        assert not fingerprints_match("", ["abc123"])


# ---------------------------------------------------------------------------
# _parse_diff_stats
# ---------------------------------------------------------------------------


class TestParseDiffStats:
    def test_empty_diff(self):
        stats = _parse_diff_stats("")
        assert stats["files"] == []
        assert stats["total_lines"] == 0

    def test_single_file_change(self):
        diff = (
            "diff --git a/file.txt b/file.txt\n"
            "--- a/file.txt\n"
            "+++ b/file.txt\n"
            "@@ -1,3 +1,4 @@\n"
            "-old line\n"
            "+new line\n"
            "+another new line\n"
            " unchanged\n"
        )
        stats = _parse_diff_stats(diff)
        assert "file.txt" in stats["files"]

    def test_multiple_files(self):
        diff = (
            "diff --git a/file1.txt b/file1.txt\n"
            "--- a/file1.txt\n"
            "+++ b/file1.txt\n"
            "@@ -1 +1 @@\n-old\n+new\n"
            "diff --git a/file2.py b/file2.py\n"
            "--- a/file2.py\n"
            "+++ b/file2.py\n"
            "@@ -1 +1 @@\n-x\n+y\n"
        )
        stats = _parse_diff_stats(diff)
        assert len(stats["files"]) == 2
        assert "file1.txt" in stats["files"]
        assert "file2.py" in stats["files"]


# ---------------------------------------------------------------------------
# _detect_incremental_scope
# ---------------------------------------------------------------------------


class TestDetectIncrementalScope:
    def test_empty_diff_returns_none(self):
        assert _detect_incremental_scope("") is None

    def test_whitespace_only_returns_none(self):
        assert _detect_incremental_scope("   \n  ") is None

    def test_small_diff_is_incremental(self):
        diff = (
            "diff --git a/small.txt b/small.txt\n"
            "--- a/small.txt\n"
            "+++ b/small.txt\n"
            "@@ -1 +1 @@\n-old\n+new\n"
        )
        result = _detect_incremental_scope(diff)
        assert result is not None
        assert len(result["files"]) == 1

    def test_too_many_files_not_incremental(self):
        # Create a diff with more than MAX_INCREMENTAL_FILES files
        lines = []
        for i in range(MAX_INCREMENTAL_FILES + 1):
            lines.append(f"diff --git a/file{i}.txt b/file{i}.txt\n")
            lines.append("--- a/file{i}.txt\n")
            lines.append("+++ b/file{i}.txt\n")
            lines.append("@@ -1 +1 @@\n-old\n+new\n")
        diff = "".join(lines)
        result = _detect_incremental_scope(diff)
        assert result is None

    def test_too_many_lines_not_incremental(self):
        # Create a diff with more than MAX_INCREMENTAL_LINES lines
        lines = ["diff --git a/big.txt b/big.txt\n"]
        lines.append("--- a/big.txt\n")
        lines.append("+++ b/big.txt\n")
        lines.append("@@ -1 +1 @@\n")
        for i in range(MAX_INCREMENTAL_LINES + 1):
            lines.append(f"+line {i}\n")
        diff = "".join(lines)
        result = _detect_incremental_scope(diff)
        assert result is None

    def test_incremental_returns_file_list(self):
        diff = (
            "diff --git a/a.txt b/a.txt\n"
            "--- a/a.txt\n"
            "+++ b/a.txt\n"
            "@@ -1 +1 @@\n-old\n+new\n"
            "diff --git a/b.txt b/b.txt\n"
            "--- a/b.txt\n"
            "+++ b/b.txt\n"
            "@@ -1 +1 @@\n-x\n+y\n"
        )
        result = _detect_incremental_scope(diff)
        assert result is not None
        assert "a.txt" in result["files"]
        assert "b.txt" in result["files"]


# ---------------------------------------------------------------------------
# extract_config_lines
# ---------------------------------------------------------------------------


class TestExtractConfigLines:
    def test_no_env_vars(self):
        lines = extract_config_lines({})
        assert lines == []

    def test_model_included(self):
        lines = extract_config_lines({"MODEL": "gpt-4"})
        assert "MODEL=gpt-4" in lines

    def test_secret_keys_masked(self):
        lines = extract_config_lines({"GITHUB_TOKEN": "ghp_abc123"})
        assert "GITHUB_TOKEN=***" in lines
        assert "ghp_abc123" not in lines[0]

    def test_api_key_masked(self):
        lines = extract_config_lines({"OPENAI_API_KEY": "sk-xxx"})
        assert "OPENAI_API_KEY=***" in lines
        assert "sk-xxx" not in lines[0]

    def test_non_secret_not_masked(self):
        lines = extract_config_lines({"MODEL": "gpt-4", "TEMPERATURE": "0.7"})
        assert "MODEL=gpt-4" in lines
        assert "TEMPERATURE=0.7" in lines

    def test_unknown_keys_ignored(self):
        lines = extract_config_lines({"UNKNOWN_KEY": "value"})
        assert lines == []


# ---------------------------------------------------------------------------
# should_review
# ---------------------------------------------------------------------------


class TestShouldReview:
    def _make_diff(self, content="test"):
        return f"diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-{content}\n+new\n"

    def test_no_changes_skips(self):
        result = should_review("", [], [])
        assert result.decision == ReviewDecision.SKIP_NO_CHANGES

    def test_whitespace_only_skips(self):
        result = should_review("   \n  ", [], [])
        assert result.decision == ReviewDecision.SKIP_NO_CHANGES

    def test_new_changes_needs_review(self):
        diff = self._make_diff()
        # Disable incremental detection to verify REVIEW_NEEDED path
        result = should_review(diff, [], [], enable_incremental_detection=False)
        assert result.decision == ReviewDecision.REVIEW_NEEDED

    def test_already_reviewed_skips(self):
        diff = self._make_diff()
        fp = compute_diff_fingerprint(diff)
        result = should_review(diff, [], [fp])
        assert result.decision == ReviewDecision.SKIP_ALREADY_REVIEWED

    def test_broad_fp_already_reviewed(self):
        diff = self._make_diff()
        config = ["MODEL=gpt-4"]
        broad_fp = build_broad_fingerprint(
            compute_diff_fingerprint(diff), compute_config_hash(config)
        )
        result = should_review(diff, config, [broad_fp])
        assert result.decision == ReviewDecision.SKIP_ALREADY_REVIEWED

    def test_incremental_skips_when_enabled(self):
        diff = self._make_diff()
        result = should_review(
            diff, [], [], enable_incremental_detection=True
        )
        # Small single-file change should be incremental
        assert result.decision == ReviewDecision.SKIP_INCREMENTAL

    def test_incremental_disabled_needs_review(self):
        diff = self._make_diff()
        result = should_review(
            diff, [], [], enable_incremental_detection=False
        )
        assert result.decision == ReviewDecision.REVIEW_NEEDED

    def test_result_contains_fingerprints(self):
        diff = self._make_diff()
        config = ["MODEL=gpt-4"]
        result = should_review(diff, config, [])
        assert len(result.diff_fingerprint) == 64
        assert len(result.config_hash) == 64
        assert FP_DELIMITER in result.broad_fingerprint

    def test_incremental_result_has_scope(self):
        diff = self._make_diff()
        result = should_review(diff, [], [], enable_incremental_detection=True)
        if result.decision == ReviewDecision.SKIP_INCREMENTAL:
            assert result.incremental_scope is not None
            scope = json.loads(result.incremental_scope)
            assert "files" in scope
            assert "line_count" in scope


# ---------------------------------------------------------------------------
# _format_output
# ---------------------------------------------------------------------------


class TestFormatOutput:
    def test_basic_fields(self):
        result = PrecheckResult(
            decision=ReviewDecision.REVIEW_NEEDED,
            diff_fingerprint="abc123",
            config_hash="def456",
            broad_fingerprint="abc123|def456",
            reason="New changes",
        )
        output = _format_output(result)
        assert "DECISION=review_needed" in output
        assert "DIFF_FINGERPRINT=abc123" in output
        assert "CONFIG_HASH=def456" in output
        assert "BROAD_FINGERPRINT=abc123|def456" in output
        assert "REASON=New changes" in output

    def test_incremental_fields(self):
        result = PrecheckResult(
            decision=ReviewDecision.SKIP_INCREMENTAL,
            diff_fingerprint="abc",
            config_hash="",
            broad_fingerprint="abc",
            incremental_scope='{"files":["a.txt"]}',
            incremental_files=["a.txt"],
            incremental_line_count=5,
            total_files=1,
            total_lines=5,
            reason="Incremental",
        )
        output = _format_output(result)
        assert "INCREMENTAL_SCOPE=" in output
        assert "INCREMENTAL_FILES=a.txt" in output
        assert "INCREMENTAL_LINE_COUNT=5" in output
        assert "TOTAL_FILES=1" in output


# ---------------------------------------------------------------------------
# Integration: end-to-end workflow
# ---------------------------------------------------------------------------


class TestEndToEnd:
    def test_full_workflow_new_review(self):
        """Simulate the full precheck flow for a new PR."""
        diff = (
            "diff --git a/src/main.py b/src/main.py\n"
            "--- a/src/main.py\n"
            "+++ b/src/main.py\n"
            "@@ -1,3 +1,4 @@\n"
            " def hello():\n"
            "-    pass\n"
            "+    print('hello')\n"
            "+    return True\n"
        )
        config = ["MODEL=gpt-4", "TEMPERATURE=0.7"]
        result = should_review(diff, config, [])

        assert result.decision in (
            ReviewDecision.REVIEW_NEEDED,
            ReviewDecision.SKIP_INCREMENTAL,
        )
        assert len(result.diff_fingerprint) == 64
        assert len(result.config_hash) == 64

    def test_full_workflow_already_reviewed(self):
        """Simulate re-running precheck on an already-reviewed PR."""
        diff = (
            "diff --git a/src/main.py b/src/main.py\n"
            "--- a/src/main.py\n"
            "+++ b/src/main.py\n"
            "@@ -1 +1 @@\n-old\n+new\n"
        )
        config = ["MODEL=gpt-4"]

        # First run — needs review (or incremental)
        first = should_review(diff, config, [])
        broad_fp = first.broad_fingerprint

        # Second run — already reviewed
        second = should_review(diff, config, [broad_fp])
        assert second.decision == ReviewDecision.SKIP_ALREADY_REVIEWED

    def test_config_change_triggers_new_review(self):
        """Changing config should produce a different broad fingerprint."""
        diff = (
            "diff --git a/f.txt b/f.txt\n"
            "--- a/f.txt\n"
            "+++ b/f.txt\n"
            "@@ -1 +1 @@\n-a\n+b\n"
        )
        config_a = ["MODEL=gpt-4"]
        config_b = ["MODEL=claude-3"]

        result_a = should_review(diff, config_a, [])
        result_b = should_review(diff, config_b, [])

        # Same diff fingerprint, different config hash
        assert result_a.diff_fingerprint == result_b.diff_fingerprint
        assert result_a.config_hash != result_b.config_hash
        assert result_a.broad_fingerprint != result_b.broad_fingerprint


# ---------------------------------------------------------------------------
# Edge cases and regression tests
# ---------------------------------------------------------------------------


class TestEdgeCases:
    def test_very_long_diff(self):
        """Handle diffs larger than typical PRs."""
        lines = ["diff --git a/big.txt b/big.txt\n"]
        lines.append("--- a/big.txt\n")
        lines.append("+++ b/big.txt\n")
        lines.append("@@ -1 +1 @@\n")
        for i in range(1000):
            lines.append(f"+line {i}\n")
        diff = "".join(lines)
        fp = compute_diff_fingerprint(diff)
        assert len(fp) == 64

    def test_special_characters_in_diff(self):
        """Handle diffs with special characters."""
        diff = (
            "diff --git a/special.txt b/special.txt\n"
            "--- a/special.txt\n"
            "+++ b/special.txt\n"
            "@@ -1 +1 @@\n-<script>alert('xss')</script>\n+safe content\n"
        )
        fp = compute_diff_fingerprint(diff)
        assert len(fp) == 64

    def test_binary_like_content(self):
        """Handle diffs that look like binary data."""
        diff = "diff --git a/bin b/bin\n--- a/bin\n+++ b/bin\n@@ -1 +1 @@\n-\\x00\\x01\n+\\x02\\x03\n"
        fp = compute_diff_fingerprint(diff)
        assert len(fp) == 64

    def test_config_with_equals_in_value(self):
        """Handle config values containing '=' characters."""
        lines = extract_config_lines({"CUSTOM_API_URL": "http://host:8080?key=value"})
        found = [l for l in lines if l.startswith("CUSTOM_API_URL=")]
        assert len(found) == 1
        assert "key=value" in found[0]

    def test_fingerprint_with_pipe_in_broad(self):
        """Ensure pipe delimiter is correctly handled."""
        diff_fp = "a" * 64
        config_h = "b" * 64
        broad = build_broad_fingerprint(diff_fp, config_h)
        parts = broad.split(FP_DELIMITER)
        assert len(parts) == 2
        assert parts[0] == diff_fp
        assert parts[1] == config_h

    def test_should_review_with_only_diff_fp_in_previous(self):
        """Backward compat: match against diff-only fingerprints."""
        diff = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-a\n+b\n"
        config = ["MODEL=gpt-4"]
        diff_fp = compute_diff_fingerprint(diff)
        result = should_review(diff, config, [diff_fp])
        assert result.decision == ReviewDecision.SKIP_ALREADY_REVIEWED


# ---------------------------------------------------------------------------
# _collect_config_lines tests
# ---------------------------------------------------------------------------


def _clear_config_env(monkeypatch):
    """Remove every env var _collect_config_lines can match, so tests are
    hermetic on runners that preset provider/platform variables."""
    for key in list(os.environ):
        if key.startswith("AI_") or key in _EXACT_CONFIG_KEYS or key == "REVIEW_VERBOSITY":
            monkeypatch.delenv(key, raising=False)


class TestCollectConfigLines:
    def test_no_relevant_env_vars(self, monkeypatch):
        """Returns empty list when no relevant env vars are set."""
        _clear_config_env(monkeypatch)
        lines = _collect_config_lines()
        assert lines == []

    def test_collects_ai_env_vars(self, monkeypatch):
        """Collects AI_ prefixed environment variables."""
        monkeypatch.setenv("AI_MODEL", "gpt-4")
        monkeypatch.setenv("AI_TEMPERATURE", "0.7")
        lines = _collect_config_lines()
        assert "AI_MODEL=gpt-4" in lines
        assert "AI_TEMPERATURE=0.7" in lines

    def test_collects_exact_provider_vars(self, monkeypatch):
        """Collects provider config vars by exact name."""
        monkeypatch.setenv("OPENAI_BASE_URL", "https://example.test/v1")
        monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://az.example.test")
        lines = _collect_config_lines()
        assert "OPENAI_BASE_URL=https://example.test/v1" in lines
        assert "AZURE_OPENAI_ENDPOINT=https://az.example.test" in lines

    def test_ignores_runner_platform_vars(self, monkeypatch):
        """Runner-preset vars sharing a provider prefix are not config."""
        _clear_config_env(monkeypatch)
        monkeypatch.setenv("AZURE_EXTENSION_DIR", "/opt/az/azcliextensions")
        monkeypatch.setenv("OPENAI_ORG_ID", "org-abc")
        assert _collect_config_lines() == []

    def test_excludes_secret_values(self, monkeypatch):
        """API keys never enter the hash input."""
        _clear_config_env(monkeypatch)
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test123")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
        monkeypatch.setenv("AI_API_KEY", "sk-inner")
        monkeypatch.setenv("AI_FALLBACK_API_KEY", "sk-fb")
        assert _collect_config_lines() == []

    def test_review_verbosity_hashes_assembled_dial(self, monkeypatch):
        """Only a genuine switch to concise enters the hash: normal, unset,
        and unrecognized values assemble the same prompt, so they must
        collect identically (mirrors the original shell rule)."""
        _clear_config_env(monkeypatch)
        assert _collect_config_lines() == []
        monkeypatch.setenv("REVIEW_VERBOSITY", "normal")
        assert _collect_config_lines() == []
        monkeypatch.setenv("REVIEW_VERBOSITY", "verbose")  # typo degrades to normal
        assert _collect_config_lines() == []
        monkeypatch.setenv("REVIEW_VERBOSITY", "CONCISE")
        assert _collect_config_lines() == ["REVIEW_VERBOSITY=concise"]
        monkeypatch.setenv("REVIEW_VERBOSITY", "concise")
        assert _collect_config_lines() == ["REVIEW_VERBOSITY=concise"]

    def test_sorted_by_key(self, monkeypatch):
        """Collected lines are sorted by key for determinism."""
        _clear_config_env(monkeypatch)
        monkeypatch.setenv("AI_ZEBRA", "z")
        monkeypatch.setenv("AI_ALPHA", "a")
        lines = _collect_config_lines()
        ai_lines = [l for l in lines if l.startswith("AI_")]
        assert ai_lines == ["AI_ALPHA=a", "AI_ZEBRA=z"]

    def test_collects_config_files(self, monkeypatch, tmp_path):
        """Collects content from config files specified by env vars."""
        cfg_file = tmp_path / "config.txt"
        cfg_file.write_text("some config")
        monkeypatch.setenv("AI_CONFIG_FILE", str(cfg_file))
        lines = _collect_config_lines()
        assert any(f"file:{cfg_file}=" in l for l in lines)

    def test_ignores_missing_config_files(self, monkeypatch):
        """Doesn't fail when config file path doesn't exist."""
        monkeypatch.setenv("AI_CONFIG_FILE", "/nonexistent/path")
        lines = _collect_config_lines()
        assert all("file:" not in l for l in lines)


# ---------------------------------------------------------------------------
# compute_config_hash no-argument tests
# ---------------------------------------------------------------------------


class TestComputeConfigHashNoArgs:
    def test_empty_env_returns_empty(self, monkeypatch):
        """Returns empty string when no relevant env vars are set."""
        _clear_config_env(monkeypatch)
        assert compute_config_hash() == ""

    def test_with_env_vars_produces_hash(self, monkeypatch):
        """Produces a hash when relevant env vars are set."""
        monkeypatch.setenv("AI_MODEL", "gpt-4")
        h = compute_config_hash()
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)

    def test_deterministic_with_same_env(self, monkeypatch):
        """Same env vars produce the same hash."""
        monkeypatch.setenv("AI_MODEL", "gpt-4")
        monkeypatch.setenv("AI_TEMPERATURE", "0.7")
        h1 = compute_config_hash()
        h2 = compute_config_hash()
        assert h1 == h2

    def test_different_env_produces_different_hash(self, monkeypatch):
        """Different env vars produce different hashes."""
        monkeypatch.setenv("AI_MODEL", "gpt-4")
        h1 = compute_config_hash()
        monkeypatch.setenv("AI_MODEL", "claude-3")
        h2 = compute_config_hash()
        assert h1 != h2

    def test_backward_compat_with_explicit_lines(self):
        """Still works when config_lines are passed explicitly."""
        lines = ["MODEL=gpt-4", "TEMP=0.7"]
        h = compute_config_hash(lines)
        assert len(h) == 64
