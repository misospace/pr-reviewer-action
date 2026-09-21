"""Direct unit tests for pr_reviewer.precheck pure functions.

Issue #512 acceptance: cover compute_diff_fingerprint, compute_config_hash,
and _detect_incremental_scope. (The review-scope resolver was removed in #615:
v3 runs a full review of the current PR on every non-skipped run.)
"""

from pr_reviewer.precheck import (
    EMPTY_DIFF_FINGERPRINT,
    MAX_INCREMENTAL_FILES,
    MAX_INCREMENTAL_LINES,
    MIN_INCREMENTAL_RATIO,
    ReviewDecision,
    _detect_incremental_scope,
    build_broad_fingerprint,
    build_marker_fingerprint,
    _collect_config_lines,
    compute_config_hash,
    compute_diff_fingerprint,
    evaluate_precheck,
    fingerprints_match,
    should_review,
)


class TestComputeDiffFingerprint:
    """Tests for compute_diff_fingerprint."""

    def test_empty_string(self):
        assert compute_diff_fingerprint("") == ""

    def test_whitespace_only(self):
        assert compute_diff_fingerprint("   \n\t\n  ") == ""

    def test_none_input(self):
        assert compute_diff_fingerprint(None) == ""  # type: ignore[arg-type]

    def test_sha256_hex_format(self):
        fp = compute_diff_fingerprint("diff content")
        assert len(fp) == 64
        assert all(c in "0123456789abcdef" for c in fp)

    def test_same_input_same_fingerprint(self):
        diff = "diff --git a/file b/file\n+line\n"
        assert compute_diff_fingerprint(diff) == compute_diff_fingerprint(diff)

    def test_different_input_different_fingerprint(self):
        fp_a = compute_diff_fingerprint("a")
        fp_b = compute_diff_fingerprint("b")
        assert fp_a != fp_b

    def test_unicode_content(self):
        fp = compute_diff_fingerprint("-你好\n+世界\n")
        assert len(fp) == 64

    def test_null_bytes_are_significant(self):
        diff_with = "a\x00b\n"
        diff_without = "ab\n"
        assert compute_diff_fingerprint(diff_with) != compute_diff_fingerprint(diff_without)


class TestComputeConfigHash:
    """Tests for compute_config_hash."""

    def test_empty_list(self):
        assert compute_config_hash([]) == ""

    def test_single_line(self):
        h = compute_config_hash(["MODEL=gpt-4"])
        assert len(h) == 64

    def test_order_independent(self):
        assert compute_config_hash(["B=2", "A=1"]) == compute_config_hash(["A=1", "B=2"])

    def test_comments_filtered(self):
        assert compute_config_hash(["# comment", "A=1"]) == compute_config_hash(["A=1"])

    def test_blank_lines_filtered(self):
        assert compute_config_hash(["A=1", "", "  "]) == compute_config_hash(["A=1"])

    def test_whitespace_stripped(self):
        assert compute_config_hash(["  A=1  "]) == compute_config_hash(["A=1"])

    def test_different_configs_different_hashes(self):
        assert compute_config_hash(["MODEL=gpt-4"]) != compute_config_hash(["MODEL=claude-3"])

    def test_related_code_settings_change_collected_config(self, monkeypatch):
        # _collect_config_lines takes no args and reads os.environ, so the
        # related-code settings are driven through the monkeypatched env, like
        # the other precheck tests. Each related-code setting must move the
        # collected config (and therefore the config hash it feeds).
        def _collect(context, max_bytes):
            monkeypatch.delenv("RELATED_CODE_CONTEXT", raising=False)
            monkeypatch.delenv("RELATED_CODE_MAX_BYTES", raising=False)
            monkeypatch.setenv("RELATED_CODE_CONTEXT", context)
            monkeypatch.setenv("RELATED_CODE_MAX_BYTES", max_bytes)
            return _collect_config_lines()

        enabled = _collect("true", "16000")
        disabled = _collect("false", "16000")
        resized = _collect("true", "32000")
        # The context toggle, at a fixed byte budget, moves the hash ...
        assert compute_config_hash(enabled) != compute_config_hash(disabled)
        # ... as does the byte budget, at a fixed context state.
        assert compute_config_hash(enabled) != compute_config_hash(resized)

    def test_null_bytes_are_significant(self):
        assert compute_config_hash(["A=x\x00y"]) != compute_config_hash(["A=xy"])


class TestDetectIncrementalScope:
    """Tests for _detect_incremental_scope."""

    def _make_diff(self, files: int = 1, added_lines_per_file: int = 1) -> str:
        parts = []
        for i in range(files):
            parts.append(f"diff --git a/f{i}.txt b/f{i}.txt\n")
            parts.append("--- a/f{i}.txt\n")
            parts.append("+++ b/f{i}.txt\n")
            parts.append("@@ -1 +1 @@\n")
            for _ in range(added_lines_per_file):
                parts.append("+line\n")
        return "".join(parts)

    def test_empty_returns_none(self):
        assert _detect_incremental_scope("") is None

    def test_whitespace_returns_none(self):
        assert _detect_incremental_scope("   \n\t\n  ") is None

    def test_small_diff_is_incremental(self):
        result = _detect_incremental_scope(self._make_diff(files=1, added_lines_per_file=1))
        assert result is not None
        assert result["files"] == ["f0.txt"]
        assert result["total_files"] == 1
        assert result["line_count"] >= 1

    def test_too_many_files_not_incremental(self):
        diff = self._make_diff(files=MAX_INCREMENTAL_FILES + 1, added_lines_per_file=1)
        assert _detect_incremental_scope(diff) is None

    def test_too_many_lines_not_incremental(self):
        diff = self._make_diff(files=1, added_lines_per_file=MAX_INCREMENTAL_LINES + 1)
        assert _detect_incremental_scope(diff) is None

    def test_multiple_small_files_incremental(self):
        diff = self._make_diff(files=MAX_INCREMENTAL_FILES, added_lines_per_file=2)
        result = _detect_incremental_scope(diff)
        assert result is not None
        assert result["total_files"] == MAX_INCREMENTAL_FILES

    def test_large_context_ratio_too_small(self):
        # A tiny change embedded in a huge diff context: ratio below threshold.
        lines = ["diff --git a/big.txt b/big.txt\n"]
        lines.extend(["@@ -1 +1 @@\n"] + ["+x\n"] * 5)
        lines.extend(["@@ -1000 +1000 @@\n"] + [" unchanged context line\n"] * 1000)
        diff = "".join(lines)
        # The ratio gate returns None when MIN_INCREMENTAL_RATIO is not met.
        result = _detect_incremental_scope(diff)
        assert result is None or result["line_count"] <= MAX_INCREMENTAL_LINES


class TestBroadAndMarkerFingerprint:
    """Tests for helper fingerprint builders."""

    def test_build_broad_fingerprint_with_config(self):
        assert build_broad_fingerprint("abc", "def") == "abc|def"

    def test_build_broad_fingerprint_without_config(self):
        assert build_broad_fingerprint("abc", "") == "abc"

    def test_build_marker_fingerprint(self):
        fp = build_marker_fingerprint("abc", "def")
        assert fp == "abc|cfg:def"

class TestFingerprintsMatch:
    def test_match(self):
        assert fingerprints_match("abc", ["def", "abc"])

    def test_no_match(self):
        assert not fingerprints_match("abc", ["def", "ghi"])


class TestEvaluatePrecheck:
    def test_empty_diff_with_no_previous_needs_review(self):
        result = evaluate_precheck("", [], config_hash="hash")
        assert result.decision == ReviewDecision.REVIEW_NEEDED
        assert result.diff_fingerprint == EMPTY_DIFF_FINGERPRINT

    def test_matching_marker_skips(self):
        result = evaluate_precheck("", [], config_hash="hash")
        broad = result.broad_fingerprint
        result2 = evaluate_precheck("", [broad], config_hash="hash")
        assert result2.decision == ReviewDecision.SKIP_ALREADY_REVIEWED

    def test_force_review_bypasses_skip(self):
        result = evaluate_precheck("", [], config_hash="hash")
        broad = result.broad_fingerprint
        result2 = evaluate_precheck("", [broad], config_hash="hash", force_review=True)
        assert result2.decision == ReviewDecision.REVIEW_NEEDED


class TestShouldReviewIntegration:
    def test_no_changes_skip(self):
        result = should_review("", [], [])
        assert result.decision == ReviewDecision.SKIP_NO_CHANGES

    def test_already_reviewed_skip(self):
        diff = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-old\n+new\n"
        fp = compute_diff_fingerprint(diff)
        result = should_review(diff, [], [fp])
        assert result.decision == ReviewDecision.SKIP_ALREADY_REVIEWED

    def test_new_changes_need_review(self):
        diff = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-old\n+new\n"
        result = should_review(diff, [], [], enable_incremental_detection=False)
        assert result.decision == ReviewDecision.REVIEW_NEEDED


def test_evaluate_precheck_skips_when_diff_unchanged():
    """The diff-unchanged guard: an unchanged fingerprint skips, no other
    signals are consulted."""
    from pr_reviewer.precheck import evaluate_precheck, ReviewDecision

    first = evaluate_precheck("diff --git a/x b/x\n+one\n", [], config_hash="c")
    again = evaluate_precheck(
        "diff --git a/x b/x\n+one\n", [first.broad_fingerprint], config_hash="c"
    )
    assert again.decision == ReviewDecision.SKIP_ALREADY_REVIEWED


# ── #617: the carried-findings inputs are gone from the contract ───────────

def test_evaluate_precheck_signature_drops_legacy_inputs():
    """The should-review contract no longer accepts carried-findings state:
    no previous_needs_full_review, no ci_state_findings_open."""
    import inspect

    from pr_reviewer.precheck import evaluate_precheck

    params = inspect.signature(evaluate_precheck).parameters
    assert "previous_needs_full_review" not in params
    assert "ci_state_findings_open" not in params
    assert set(params) == {
        "diff_content",
        "previous_fingerprints",
        "config_hash",
        "force_review",
        "skip_if_diff_unchanged",
    }


def test_legacy_marker_state_does_not_affect_the_decision():
    """A marker published by old runs carries legacy keys (open_findings /
    evidence_digest / needs_full_review). They must stay parseable (old
    comments must remain readable) but have NO effect: an unchanged
    fingerprint skips — there is no force path anymore."""
    from pr_reviewer.metadata import parse_metadata
    from pr_reviewer.precheck import ReviewDecision, evaluate_precheck

    diff = "diff --git a/x b/x\n+one\n"
    first = evaluate_precheck(diff, [], config_hash="c")

    # A legacy comment body the way the shell caller consumed it: the
    # fingerprint marker (source of PREV_FINGERPRINTS) plus the metadata
    # marker with carried-findings state.
    legacy_body = (
        f"<!-- ai-pr-review-fingerprint:{first.broad_fingerprint} -->\n"
        "<!-- ai-pr-reviewer:{"
        '"version":1,"head_sha":"abc","base_sha":"def",'
        '"review_result":"issues",'
        '"open_findings":[{"id":"P1","message":"carried"}],'
        '"evidence_digest":"sha256:deadbeef",'
        '"needs_full_review":true'
        '} -->'
    )

    # The legacy state is still readable out of the marker...
    legacy_meta = parse_metadata(legacy_body)
    assert legacy_meta["needs_full_review"] is True
    assert legacy_meta["open_findings"] == [{"id": "P1", "message": "carried"}]

    # ...and the caller's fingerprint extraction is the only input that
    # reaches the decision. Unchanged fingerprint -> SKIP, no force.
    prev_fps = [
        line.removeprefix("<!-- ai-pr-review-fingerprint:")
        .removesuffix(" -->")
        for line in legacy_body.splitlines()
        if line.startswith("<!-- ai-pr-review-fingerprint:")
    ]
    assert prev_fps == [first.broad_fingerprint]

    again = evaluate_precheck(diff, prev_fps, config_hash="c")
    assert again.decision == ReviewDecision.SKIP_ALREADY_REVIEWED
    assert again.broad_fingerprint == first.broad_fingerprint


