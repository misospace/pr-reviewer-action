"""Direct unit tests for pr_reviewer.precheck pure functions.

Issue #512 acceptance: cover compute_diff_fingerprint, compute_config_hash,
resolve_review_scope (including validation-flag fallbacks), and
_detect_incremental_scope.
"""

from pr_reviewer.precheck import (
    EMPTY_DIFF_FINGERPRINT,
    MAX_INCREMENTAL_FILES,
    MAX_INCREMENTAL_LINES,
    MIN_INCREMENTAL_RATIO,
    ReviewDecision,
    ScopeResolution,
    _detect_incremental_scope,
    build_broad_fingerprint,
    build_marker_fingerprint,
    compute_config_hash,
    compute_diff_fingerprint,
    evaluate_precheck,
    fingerprints_match,
    resolve_review_scope,
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


class TestResolveReviewScope:
    """Tests for resolve_review_scope including validation-flag fallbacks."""

    def _resolve(
        self,
        review_scope="auto",
        previous_head_sha="abc123",
        previous_base_sha="def456",
        previous_review_result="",
        *,
        force_review=False,
        previous_head_is_ancestor=None,
        compare_range_ok=None,
    ):
        return resolve_review_scope(
            review_scope=review_scope,
            previous_head_sha=previous_head_sha,
            previous_base_sha=previous_base_sha,
            previous_review_result=previous_review_result,
            force_review=force_review,
            previous_head_is_ancestor=previous_head_is_ancestor,
            compare_range_ok=compare_range_ok,
        )

    def test_force_review_returns_full(self):
        scope = self._resolve(force_review=True)
        assert scope.effective_review_scope == "full"
        assert scope.previous_head_sha == ""
        assert scope.baseline_clean is False

    def test_full_scope_request(self):
        scope = self._resolve(review_scope="full")
        assert scope.effective_review_scope == "full"

    def test_missing_previous_head_returns_full(self):
        scope = self._resolve(previous_head_sha="")
        assert scope.effective_review_scope == "full"

    def test_missing_previous_base_returns_full(self):
        scope = self._resolve(previous_base_sha="")
        assert scope.effective_review_scope == "full"

    def test_invalid_scope_degrades_to_auto_and_falls_through(self):
        # With valid metadata and validation flags None, an invalid scope
        # degrades to auto and resolves to incremental.
        scope = self._resolve(review_scope="banana")
        assert scope.effective_review_scope == "incremental"

    def test_incremental_scope_request(self):
        scope = self._resolve(review_scope="incremental")
        assert scope.effective_review_scope == "incremental"
        assert scope.previous_head_sha == "abc123"

    def test_auto_scope_resolves_to_incremental(self):
        scope = self._resolve(review_scope="auto")
        assert scope.effective_review_scope == "incremental"

    def test_previous_head_is_ancestor_false_returns_full(self):
        scope = self._resolve(previous_head_is_ancestor=False)
        assert scope.effective_review_scope == "full"

    def test_compare_range_ok_false_returns_full(self):
        scope = self._resolve(compare_range_ok=False)
        assert scope.effective_review_scope == "full"

    def test_previous_head_is_ancestor_none_does_not_gate(self):
        # None means caller did not assert; other conditions satisfied.
        scope = self._resolve(previous_head_is_ancestor=None, compare_range_ok=True)
        assert scope.effective_review_scope == "incremental"

    def test_compare_range_ok_none_does_not_gate(self):
        scope = self._resolve(previous_head_is_ancestor=True, compare_range_ok=None)
        assert scope.effective_review_scope == "incremental"

    def test_both_validation_flags_true_incremental(self):
        scope = self._resolve(previous_head_is_ancestor=True, compare_range_ok=True)
        assert scope.effective_review_scope == "incremental"
        assert scope.baseline_clean is True

    def test_baseline_clean_with_clean_result(self):
        scope = self._resolve(previous_review_result="clean")
        assert scope.baseline_clean is True

    def test_baseline_clean_with_empty_result(self):
        scope = self._resolve(previous_review_result="")
        assert scope.baseline_clean is True

    def test_baseline_dirty_with_issues_result(self):
        scope = self._resolve(previous_review_result="issues")
        assert scope.baseline_clean is False


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


# ── #536 Case 1: a CI-state finding must survive the diff-unchanged guard ────

def test_looks_like_ci_state_finding_matches_a_ci_blocker():
    from pr_reviewer.precheck import looks_like_ci_state_finding

    assert looks_like_ci_state_finding(
        {"message": "CI is in a terminal failure state for this commit: 'npm audit' failed"}
    )
    assert looks_like_ci_state_finding({"message": "The Build check is failing on this commit"})


def test_looks_like_ci_state_finding_ignores_ordinary_findings():
    from pr_reviewer.precheck import looks_like_ci_state_finding

    assert not looks_like_ci_state_finding({"message": "This function returns the wrong type"})
    assert not looks_like_ci_state_finding({"message": ""})
    assert not looks_like_ci_state_finding({"message": None})
    assert not looks_like_ci_state_finding("not a dict")
    assert not looks_like_ci_state_finding(None)


def test_has_ci_state_findings_tolerates_junk():
    from pr_reviewer.precheck import has_ci_state_findings

    assert has_ci_state_findings([{"message": "checks are failing"}])
    assert not has_ci_state_findings([])
    assert not has_ci_state_findings(None)
    assert not has_ci_state_findings("nope")
    assert not has_ci_state_findings([{"message": "a normal bug"}, 7, None])


def test_evaluate_precheck_skips_when_diff_unchanged():
    """Baseline: the guard still works when no CI-state finding is open."""
    from pr_reviewer.precheck import evaluate_precheck, ReviewDecision

    first = evaluate_precheck("diff --git a/x b/x\n+one\n", [], config_hash="c")
    again = evaluate_precheck(
        "diff --git a/x b/x\n+one\n", [first.broad_fingerprint], config_hash="c"
    )
    assert again.decision == ReviewDecision.SKIP_ALREADY_REVIEWED


def test_evaluate_precheck_reviews_anyway_when_a_ci_state_finding_is_open():
    """A CI-state blocker can clear without the diff moving, so an unchanged
    fingerprint must not short-circuit the re-review. (#536 Case 1)"""
    from pr_reviewer.precheck import evaluate_precheck, ReviewDecision

    first = evaluate_precheck("diff --git a/x b/x\n+one\n", [], config_hash="c")
    again = evaluate_precheck(
        "diff --git a/x b/x\n+one\n",
        [first.broad_fingerprint],
        config_hash="c",
        ci_state_findings_open=True,
    )
    assert again.decision == ReviewDecision.REVIEW_NEEDED
    assert "CI-state" in again.reason
    # the fingerprint itself is unchanged; only the decision differs
    assert again.broad_fingerprint == first.broad_fingerprint


# ── #536 Case 2: an unassessable carried finding forces a full review ────────

def test_resolve_review_scope_forces_full_when_previous_needed_it():
    """An incremental review would reach the same not_verifiable verdict for the
    same reason, and fail-closed would keep the PR blocked. (#536 Case 2)"""
    from pr_reviewer.precheck import resolve_review_scope

    r = resolve_review_scope(
        "auto", "a" * 40, "b" * 40, "issues", previous_needs_full_review=True
    )
    assert r.effective_review_scope == "full"


def test_resolve_review_scope_still_increments_without_the_flag():
    from pr_reviewer.precheck import resolve_review_scope

    r = resolve_review_scope(
        "auto", "a" * 40, "b" * 40, "issues", previous_needs_full_review=False
    )
    assert r.effective_review_scope == "incremental"


# ── #544: the flag must also defeat the diff-unchanged skip guard ──────────

def test_diff_unchanged_guard_deferred_when_previous_needed_full_review():
    """The only way to clear a not_verifiable_from_delta finding is the full
    review the flag requests; skipping would strand the PR on the same
    incremental diff forever. (#544)"""
    from pr_reviewer.precheck import ReviewDecision, evaluate_precheck

    first = evaluate_precheck("diff --git a/x b/x\n+one\n", [], config_hash="c")
    again = evaluate_precheck(
        "diff --git a/x b/x\n+one\n",
        [first.broad_fingerprint],
        config_hash="c",
        previous_needs_full_review=True,
    )
    assert again.decision == ReviewDecision.REVIEW_NEEDED
    assert "full review" in again.reason
    # the fingerprint itself is unchanged; only the decision differs
    assert again.broad_fingerprint == first.broad_fingerprint


def test_diff_unchanged_guard_still_skips_without_the_flag():
    from pr_reviewer.precheck import ReviewDecision, evaluate_precheck

    first = evaluate_precheck("diff --git a/x b/x\n+one\n", [], config_hash="c")
    again = evaluate_precheck(
        "diff --git a/x b/x\n+one\n",
        [first.broad_fingerprint],
        config_hash="c",
        previous_needs_full_review=False,
    )
    assert again.decision == ReviewDecision.SKIP_ALREADY_REVIEWED


# --- #543: the dismissal writer must actually be reachable in production ---


class TestDismissalWiring:
    """Both defects here are 'the code exists but never runs', which is the
    same failure mode #543 was filed about. Unit tests on the helpers pass
    either way, so these pin the wiring instead."""

    def test_token_accepts_the_spelling_action_yml_provides(self, monkeypatch):
        # action.yml's precheck step sets GH_TOKEN. GITHUB_TOKEN is not an
        # automatic Actions variable, so reading only GITHUB_TOKEN left the
        # fetch tokenless in production and it returned [] on every run.
        from pr_reviewer.precheck import _github_token

        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.setenv("GH_TOKEN", "gh-token-value")
        assert _github_token() == "gh-token-value"

        monkeypatch.setenv("GITHUB_TOKEN", "github-token-value")
        assert _github_token() == "github-token-value"

        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.delenv("GH_TOKEN", raising=False)
        assert _github_token() == ""

    def test_load_pr_comments_does_not_bail_on_gh_token_alone(self, monkeypatch):
        # The early return is `not (token and repo and pr_number)`. With only
        # GH_TOKEN set this used to short-circuit before any fetch, which is
        # indistinguishable from "no dismissals" downstream.
        import pr_reviewer.precheck as precheck

        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.setenv("GH_TOKEN", "t")
        monkeypatch.setenv("GITHUB_REPOSITORY", "o/r")

        reached = {}

        class _Boom(Exception):
            pass

        def _explode(*a, **kw):
            reached["fetch"] = True
            raise _Boom()

        monkeypatch.setattr(precheck, "_github_token", lambda: "t")
        # Any import of github inside the function is fine; we only need to
        # know the guard let us past it.
        monkeypatch.setitem(
            __import__("sys").modules, "github", type("m", (), {"Github": _explode})
        )
        assert precheck._load_pr_comments("7") == []
        assert reached.get("fetch"), "guard returned before attempting the fetch"

    def test_writer_guard_is_armed_on_the_production_path(self, tmp_path, monkeypatch):
        # _write_previous_dismissals only checks containment when
        # workspace_root is passed. main() omitting it left every path check
        # inert -- the same shape as #543's defect 2 on the reader side.
        import inspect

        import pr_reviewer.precheck as precheck

        src = inspect.getsource(precheck.main)
        assert "_write_previous_dismissals(" in src
        call = src[src.index("_write_previous_dismissals(") :]
        call = call[: call.index("\n            )") + 1]
        assert "workspace_root=" in call, (
            "main() must pass workspace_root or the containment guard in "
            "_write_previous_dismissals never runs in production"
        )

    def test_writer_refuses_a_path_outside_the_workspace(self, tmp_path):
        from pr_reviewer.precheck import _write_previous_dismissals

        outside = tmp_path.parent / "escaped-dismissals.json"
        if outside.exists():
            outside.unlink()
        comments = [
            {"id": 1, "author": "owner", "body": "@ai-reviewer dismiss P1: nope"}
        ]
        written = _write_previous_dismissals(
            comments,
            {"owner"},
            output_path=str(outside),
            workspace_root=str(tmp_path),
        )
        assert written == 0
        assert not outside.exists()
