"""Direct unit tests for pr_reviewer.precheck pure functions.

Issue #512 acceptance: cover compute_diff_fingerprint and
compute_config_hash. (The review-scope resolver was removed in #615 and the
incremental scope detector with it in v3: v3 runs a full review of the
current PR on every non-skipped run.)
"""

from pr_reviewer.precheck import (
    EMPTY_DIFF_FINGERPRINT,
    ReviewDecision,
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

    def test_deep_review_specialist_budgets_change_collected_config(self, monkeypatch):
        # #632: the specialist completion budget and compact-corpus byte cap are
        # independent settings; changing either must move the config hash so an
        # otherwise unchanged review is invalidated (the run's specialist
        # request/inputs changed).
        def _collect(max_tokens, corpus_bytes):
            monkeypatch.delenv("DEEP_REVIEW_MAX_TOKENS", raising=False)
            monkeypatch.delenv("DEEP_REVIEW_CORPUS_MAX_BYTES", raising=False)
            monkeypatch.setenv("DEEP_REVIEW_MAX_TOKENS", max_tokens)
            monkeypatch.setenv("DEEP_REVIEW_CORPUS_MAX_BYTES", corpus_bytes)
            return _collect_config_lines()

        base = _collect("4096", "48000")
        bigger_budget = _collect("8192", "48000")
        bigger_corpus = _collect("4096", "96000")
        assert compute_config_hash(base) != compute_config_hash(bigger_budget)
        assert compute_config_hash(base) != compute_config_hash(bigger_corpus)


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
        result = should_review(diff, [], [])
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
    """A marker published by old runs carries legacy keys (review_scope /
    previous_head_sha / open_findings / evidence_digest /
    needs_full_review). They must stay parseable (old comments must remain
    readable) but have NO effect: an unchanged fingerprint skips — there is
    no force path anymore — and the v2-era scope fields never force a
    partial review. A marker with them must decide identically to the same
    marker without them."""
    from pr_reviewer.metadata import parse_metadata
    from pr_reviewer.precheck import ReviewDecision, evaluate_precheck

    diff = "diff --git a/x b/x\n+one\n"
    first = evaluate_precheck(diff, [], config_hash="c")

    # A v2-era comment body the way the shell caller consumed it: the
    # fingerprint marker (source of PREV_FINGERPRINTS) plus the metadata
    # marker with carried-findings and incremental-era scope state.
    legacy_body = (
        f"<!-- ai-pr-review-fingerprint:{first.broad_fingerprint} -->\n"
        "<!-- ai-pr-reviewer:{"
        '"version":1,"head_sha":"abc","base_sha":"def",'
        '"review_scope":"incremental",'
        '"previous_head_sha":"1111111111111111111111111111111111111111",'
        '"review_result":"issues",'
        '"open_findings":[{"id":"P1","message":"carried"}],'
        '"evidence_digest":"sha256:deadbeef",'
        '"needs_full_review":true'
        '} -->'
    )
    # The same marker carrying only the fields v3 reads.
    clean_body = (
        f"<!-- ai-pr-review-fingerprint:{first.broad_fingerprint} -->\n"
        "<!-- ai-pr-reviewer:{"
        '"version":1,"head_sha":"abc","base_sha":"def",'
        '"review_result":"issues"'
        '} -->'
    )

    def prev_fps_of(body: str) -> list[str]:
        return [
            line.removeprefix("<!-- ai-pr-review-fingerprint:")
            .removesuffix(" -->")
            for line in body.splitlines()
            if line.startswith("<!-- ai-pr-review-fingerprint:")
        ]

    # The legacy state is still readable out of the marker...
    legacy_meta = parse_metadata(legacy_body)
    assert legacy_meta["review_scope"] == "incremental"
    assert legacy_meta["previous_head_sha"] == "1111111111111111111111111111111111111111"
    assert legacy_meta["needs_full_review"] is True
    assert legacy_meta["open_findings"] == [{"id": "P1", "message": "carried"}]

    # ...and the caller's fingerprint extraction is the only input that
    # reaches the decision: unchanged fingerprint -> SKIP, no force, and the
    # legacy marker decides identically to the same marker without it.
    assert prev_fps_of(legacy_body) == [first.broad_fingerprint]
    with_legacy = evaluate_precheck(diff, prev_fps_of(legacy_body), config_hash="c")
    with_clean = evaluate_precheck(diff, prev_fps_of(clean_body), config_hash="c")
    assert (
        with_legacy.decision
        == with_clean.decision
        == ReviewDecision.SKIP_ALREADY_REVIEWED
    )
    assert (
        with_legacy.broad_fingerprint
        == with_clean.broad_fingerprint
        == first.broad_fingerprint
    )


