"""Unit tests for scripts/check_corpus_stale_pin.py's pure logic (#842).

No network: `check_entries`/`check_stale_pin` take injected
`fetch_comment_time`/`fetch_commits` callables. The commit/comment fixture
data below is the REAL `joryirving/home-ops#9075` history (verified via
`gh api` while building this check — see the module docstring and the PR
that added it), not synthesized.

Important, and worth reading before trusting this checker's verdict on any
one entry: run against the *real* #9075 timestamps, this heuristic — "the
pinned head must be the latest commit at or before the review comment's
timestamp" — actually flags the CORRECT, manually-verified pin (935d0f80)
as stale, and passes the WRONG, pre-fix pin (b3d77613f68e...). That's because
the human comment (issuecomment-5295268901, 15:43:42Z) is itself a
post-hoc note the PR's own author left ~34s AFTER pushing the fix commit
(b3d77613, 15:43:08Z), narrating a fix they'd already made — not a
contemporaneous external review of a still-buggy head. The timestamp
heuristic has no way to distinguish "reviewed this head, found a bug" from
"already fixed the bug, then wrote a comment about it" when both land in
the same few seconds. `TestRealHistory9075` below documents this exact
inversion with the real timestamps rather than hiding it; the #9075 corpus
entry's pin was corrected via direct diff inspection (confirming the
defect's absence/presence in each candidate commit), not via this checker,
precisely because this class of case defeats it.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from check_corpus_stale_pin import (
    GitHubAPIError,
    check_entries,
    check_stale_pin,
    expected_head_at_time,
    parse_source_url,
)


# ---------------------------------------------------------------------------
# parse_source_url
# ---------------------------------------------------------------------------


class TestParseSourceUrl:
    def test_issuecomment(self):
        parsed = parse_source_url("https://github.com/acme/repo/pull/42#issuecomment-123")
        assert parsed == {"repo": "acme/repo", "number": 42, "kind": "issuecomment", "comment_id": "123"}

    def test_discussion_review_comment(self):
        parsed = parse_source_url("https://github.com/acme/repo/pull/42#discussion_r456")
        assert parsed == {"repo": "acme/repo", "number": 42, "kind": "discussion_r", "comment_id": "456"}

    def test_pullrequestreview(self):
        parsed = parse_source_url("https://github.com/acme/repo/pull/42#pullrequestreview-789")
        assert parsed == {"repo": "acme/repo", "number": 42, "kind": "pullrequestreview", "comment_id": "789"}

    def test_bare_pr_link_is_unparseable(self):
        assert parse_source_url("https://github.com/acme/repo/pull/42") is None

    def test_non_string_is_unparseable(self):
        assert parse_source_url(None) is None

    def test_unrelated_url_is_unparseable(self):
        assert parse_source_url("https://example.com/not-github") is None


# ---------------------------------------------------------------------------
# expected_head_at_time
# ---------------------------------------------------------------------------


class TestExpectedHeadAtTime:
    def test_picks_the_latest_commit_at_or_before(self):
        commits = [
            {"sha": "a", "date": "2026-01-01T00:00:00Z"},
            {"sha": "b", "date": "2026-01-02T00:00:00Z"},
            {"sha": "c", "date": "2026-01-03T00:00:00Z"},
        ]
        assert expected_head_at_time(commits, "2026-01-02T12:00:00Z") == "b"

    def test_exact_timestamp_match_counts_as_at_or_before(self):
        commits = [{"sha": "a", "date": "2026-01-01T00:00:00Z"}]
        assert expected_head_at_time(commits, "2026-01-01T00:00:00Z") == "a"

    def test_none_when_every_commit_postdates_the_comment(self):
        commits = [{"sha": "a", "date": "2026-01-05T00:00:00Z"}]
        assert expected_head_at_time(commits, "2026-01-01T00:00:00Z") is None

    def test_empty_commit_list(self):
        assert expected_head_at_time([], "2026-01-01T00:00:00Z") is None


# ---------------------------------------------------------------------------
# check_stale_pin / check_entries
# ---------------------------------------------------------------------------


def _entry(**overrides):
    e = {
        "id": "acme/repo#42@abc123",
        "head_sha": "b" * 40,
        "source": {"url": "https://github.com/acme/repo/pull/42#issuecomment-123"},
    }
    e.update(overrides)
    return e


COMMITS = [
    {"sha": "a" * 40, "date": "2026-01-01T00:00:00Z"},
    {"sha": "b" * 40, "date": "2026-01-02T00:00:00Z"},
]


class TestCheckStalePin:
    def test_ok_when_pinned_head_matches_expected(self):
        entry = _entry(head_sha="b" * 40)
        result = check_stale_pin(
            entry, lambda *a: "2026-01-02T12:00:00Z", lambda *a: COMMITS,
        )
        assert result["ok"] is True
        assert result["expected_sha"] == "b" * 40

    def test_stale_when_pinned_head_is_not_the_expected_commit(self):
        entry = _entry(head_sha="a" * 40)
        result = check_stale_pin(
            entry, lambda *a: "2026-01-02T12:00:00Z", lambda *a: COMMITS,
        )
        assert result["ok"] is False
        assert result["expected_sha"] == "b" * 40
        assert ("b" * 12) in result["reason"]

    def test_ambiguous_when_pinned_head_not_in_commit_list(self):
        entry = _entry(head_sha="c" * 40)
        result = check_stale_pin(
            entry, lambda *a: "2026-01-02T12:00:00Z", lambda *a: COMMITS,
        )
        assert result["ok"] is None
        assert "force-pushed" in result["reason"]

    def test_ambiguous_when_comment_predates_every_commit(self):
        entry = _entry(head_sha="a" * 40)
        result = check_stale_pin(
            entry, lambda *a: "2025-01-01T00:00:00Z", lambda *a: COMMITS,
        )
        assert result["ok"] is None
        assert "clock skew" in result["reason"]

    def test_skips_entries_with_no_head_sha(self):
        entry = _entry(head_sha=None)
        assert check_stale_pin(entry, lambda *a: "x", lambda *a: COMMITS) is None

    def test_skips_entries_with_unparseable_source_url(self):
        entry = _entry(source={"url": "https://github.com/acme/repo/pull/42"})
        assert check_stale_pin(entry, lambda *a: "x", lambda *a: COMMITS) is None

    def test_skips_entries_with_no_source(self):
        entry = _entry(source=None)
        assert check_stale_pin(entry, lambda *a: "x", lambda *a: COMMITS) is None

    def test_fetch_comment_time_receives_parsed_fields(self):
        entry = _entry(head_sha="b" * 40)
        seen = []

        def _capture(repo, kind, comment_id, number):
            seen.append((repo, kind, comment_id, number))
            return "2026-01-02T12:00:00Z"

        check_stale_pin(entry, _capture, lambda *a: COMMITS)
        assert seen == [("acme/repo", "issuecomment", "123", 42)]


class TestCheckEntries:
    def test_lookup_failure_is_reported_not_raised(self):
        entry = _entry(head_sha="b" * 40)

        def _boom(*a):
            raise GitHubAPIError("404")

        result = check_entries([entry], _boom, lambda *a: COMMITS)
        assert result[0]["ok"] is None
        assert "lookup failed" in result[0]["reason"]

    def test_entries_without_a_parseable_source_are_omitted(self):
        entry = _entry(source={"url": "not-a-github-link"})
        assert check_entries([entry], lambda *a: "x", lambda *a: COMMITS) == []


# ---------------------------------------------------------------------------
# Real #9075 history (see module docstring)
# ---------------------------------------------------------------------------

REAL_9075_COMMITS = [
    {"sha": "935d0f80ae4f151c0cfbb87c85712b064f2547ad", "date": "2026-08-14T15:40:41Z"},
    {"sha": "b3d77613f68eff88127d014a5c5aa59a4dd38a84", "date": "2026-08-14T15:43:08Z"},
]
REAL_9075_COMMENT_TIME = "2026-08-14T15:43:42Z"  # issuecomment-5295268901


class TestRealHistory9075:
    def test_expected_head_is_the_fix_commit_not_the_prefix_one(self):
        """Ground truth from `gh api`: both commits precede the comment, and
        the fix commit (b3d77613) is the later of the two."""
        assert expected_head_at_time(REAL_9075_COMMITS, REAL_9075_COMMENT_TIME) == (
            "b3d77613f68eff88127d014a5c5aa59a4dd38a84"
        )

    def test_the_old_842_pin_reads_as_ok_by_this_heuristic_alone(self):
        """The bug: b3d77613 (the pre-#842-fix pin, already containing the
        `files:` fix) matches this heuristic's "expected" commit, because
        it's simply the latest commit before the comment's timestamp."""
        entry = _entry(id="joryirving/home-ops#9075@b3d77613", head_sha="b3d77613f68eff88127d014a5c5aa59a4dd38a84")
        result = check_stale_pin(
            entry, lambda *a: REAL_9075_COMMENT_TIME, lambda *a: REAL_9075_COMMITS,
        )
        assert result["ok"] is True

    def test_the_corrected_pin_reads_as_stale_by_this_heuristic_alone(self):
        """The corrected pin (935d0f80, manually verified via diff
        inspection to be the actual pre-fix head) is flagged BY THIS
        HEURISTIC ALONE — the exact inversion documented in the module and
        class docstrings. The #9075 corpus entry's pin is correct despite
        this flag; it was verified by comparing the two commits' diffs
        directly, not by this checker."""
        entry = _entry(id="joryirving/home-ops#9075@935d0f80", head_sha="935d0f80ae4f151c0cfbb87c85712b064f2547ad")
        result = check_stale_pin(
            entry, lambda *a: REAL_9075_COMMENT_TIME, lambda *a: REAL_9075_COMMITS,
        )
        assert result["ok"] is False
        assert result["expected_sha"] == "b3d77613f68eff88127d014a5c5aa59a4dd38a84"
