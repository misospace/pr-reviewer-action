"""Tests for scripts/harvest_human_findings.py (#798).

Fully offline: no network access. GitHub reads are stubbed behind a fake
client exposing the same six read methods ``GitHubClient`` does
(list_pulls/list_reviews/list_issue_comments/list_review_comments/
list_commits/list_files).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harvest_human_findings as hhf  # noqa: E402
from eval_harness import RealPRCorpus  # noqa: E402

REPO = "misospace/pr-reviewer-action"
HEAD = "a" * 40
BASE = "b" * 40
BOT = "its-saffron[bot]"
MAINTAINER = "joryirving"


def _marker(head_sha=HEAD, base_sha=BASE, review_result="clean"):
    payload = {
        "version": 1,
        "head_sha": head_sha,
        "base_sha": base_sha,
        "review_result": review_result,
    }
    return f"<!-- ai-pr-reviewer:{json.dumps(payload, separators=(',', ':'))} -->\nreview body"


# ---------------------------------------------------------------------------
# Blocking-comment keyword detection
# ---------------------------------------------------------------------------


def test_is_blocking_comment_detects_known_phrases():
    assert hhf.is_blocking_comment("This is a merge blocker, please fix.")
    assert hhf.is_blocking_comment("BLOCKER: null deref on line 4")
    assert hhf.is_blocking_comment("Needs to be fixed before merge.")
    assert hhf.is_blocking_comment("I'd like to request changes here.")


def test_is_blocking_comment_ignores_non_blocking_text():
    assert not hhf.is_blocking_comment("Nice work, this looks great!")
    assert not hhf.is_blocking_comment("")
    assert not hhf.is_blocking_comment(None)


# ---------------------------------------------------------------------------
# Severity parsing
# ---------------------------------------------------------------------------


def test_parse_severity_blocker_and_critical():
    assert hhf.parse_severity("this is a blocker") == "blocker"
    assert hhf.parse_severity("a critical security issue") == "blocker"


def test_parse_severity_major():
    assert hhf.parse_severity("a major correctness bug") == "major"


def test_parse_severity_default_major():
    assert hhf.parse_severity("small nit, non-blocking") == "major"


# ---------------------------------------------------------------------------
# Bot-approval determination
# ---------------------------------------------------------------------------


def test_determine_bot_approval_marker_clean():
    reviews = [
        {
            "user": {"login": BOT},
            "state": "APPROVED",
            "commit_id": HEAD,
            "submitted_at": "2026-01-01T00:00:00Z",
            "body": _marker(review_result="clean"),
        }
    ]
    approved, base_sha = hhf.determine_bot_approval(reviews, {BOT}, HEAD, "2026-01-01T00:00:00Z")
    assert approved is True
    assert base_sha == BASE


def test_determine_bot_approval_dismissed_then_clean():
    """A review dismissed later still counts as approved via its marker."""
    reviews = [
        {
            "user": {"login": BOT},
            "state": "DISMISSED",
            "commit_id": HEAD,
            "submitted_at": "2026-01-01T00:00:00Z",
            "body": _marker(review_result="clean"),
        }
    ]
    approved, base_sha = hhf.determine_bot_approval(reviews, {BOT}, HEAD, "2026-01-01T00:00:00Z")
    assert approved is True
    assert base_sha == BASE


def test_determine_bot_approval_marker_issues_not_approved():
    reviews = [
        {
            "user": {"login": BOT},
            "state": "APPROVED",
            "commit_id": HEAD,
            "submitted_at": "2026-01-01T00:00:00Z",
            "body": _marker(review_result="issues"),
        }
    ]
    approved, _ = hhf.determine_bot_approval(reviews, {BOT}, HEAD, "2026-01-01T00:00:00Z")
    assert approved is False


def test_determine_bot_approval_no_marker_falls_back_to_state():
    reviews = [
        {
            "user": {"login": BOT},
            "state": "APPROVED",
            "commit_id": HEAD,
            "submitted_at": "2026-01-01T00:00:00Z",
            "body": "Looks good, no marker here.",
        }
    ]
    approved, base_sha = hhf.determine_bot_approval(reviews, {BOT}, HEAD, "2026-01-01T00:00:00Z")
    assert approved is True
    assert base_sha is None

    reviews[0]["state"] = "CHANGES_REQUESTED"
    approved, _ = hhf.determine_bot_approval(reviews, {BOT}, HEAD, "2026-01-01T00:00:00Z")
    assert approved is False


def test_determine_bot_approval_no_bot_review_at_head():
    reviews = [
        {
            "user": {"login": MAINTAINER},
            "state": "CHANGES_REQUESTED",
            "commit_id": HEAD,
            "submitted_at": "2026-01-01T00:00:00Z",
            "body": "human review",
        }
    ]
    approved, base_sha = hhf.determine_bot_approval(reviews, {BOT}, HEAD, "2026-01-01T00:00:00Z")
    assert approved is False
    assert base_sha is None


def test_determine_bot_approval_picks_latest_when_multiple_at_same_head():
    reviews = [
        {
            "user": {"login": BOT},
            "state": "APPROVED",
            "commit_id": HEAD,
            "submitted_at": "2026-01-01T00:00:00Z",
            "body": _marker(review_result="issues"),
        },
        {
            "user": {"login": BOT},
            "state": "APPROVED",
            "commit_id": HEAD,
            "submitted_at": "2026-01-01T01:00:00Z",
            "body": _marker(review_result="clean"),
        },
    ]
    approved, _ = hhf.determine_bot_approval(reviews, {BOT}, HEAD, "2026-01-01T02:00:00Z")
    assert approved is True


def test_determine_bot_approval_ignores_approval_after_finding():
    """Counterexample (a): human finding at 10:00, bot's first approval of
    that head lands at 10:05 — the approval can't retroactively justify a
    finding it postdates, so this must NOT be treated as approved."""
    reviews = [
        {
            "user": {"login": BOT},
            "state": "APPROVED",
            "commit_id": HEAD,
            "submitted_at": "2026-01-01T10:05:00Z",
            "body": _marker(review_result="clean"),
        }
    ]
    approved, base_sha = hhf.determine_bot_approval(reviews, {BOT}, HEAD, "2026-01-01T10:00:00Z")
    assert approved is False
    assert base_sha is None


def test_determine_bot_approval_uses_review_at_finding_time_not_later_one():
    """Counterexample (b): bot approves at 09:00, human finding at 10:00,
    bot later posts `issues` at 11:00 on the same head — the 09:00 approval
    is what was true when the finding was made, so this IS approved."""
    reviews = [
        {
            "user": {"login": BOT},
            "state": "APPROVED",
            "commit_id": HEAD,
            "submitted_at": "2026-01-01T09:00:00Z",
            "body": _marker(review_result="clean"),
        },
        {
            "user": {"login": BOT},
            "state": "CHANGES_REQUESTED",
            "commit_id": HEAD,
            "submitted_at": "2026-01-01T11:00:00Z",
            "body": _marker(review_result="issues"),
        },
    ]
    approved, base_sha = hhf.determine_bot_approval(reviews, {BOT}, HEAD, "2026-01-01T10:00:00Z")
    assert approved is True
    assert base_sha == BASE


# ---------------------------------------------------------------------------
# Anchor resolution: inline vs named-path
# ---------------------------------------------------------------------------


def test_inline_comment_anchor_uses_line_and_start_line():
    anchor = hhf.inline_comment_anchor(
        {"path": "a/b.py", "line": 50, "start_line": 45}
    )
    assert anchor == ("a/b.py", (45, 50), "high")


def test_inline_comment_anchor_falls_back_to_original_line_fields():
    """A comment left on a diff range that's since gone stale carries
    original_line/original_start_line instead of line/start_line."""
    anchor = hhf.inline_comment_anchor(
        {
            "path": "a/b.py",
            "line": None,
            "start_line": None,
            "original_line": 12,
            "original_start_line": 8,
        }
    )
    assert anchor == ("a/b.py", (8, 12), "high")


def test_inline_comment_anchor_normalizes_reversed_range():
    anchor = hhf.inline_comment_anchor(
        {"path": "a/b.py", "line": 10, "start_line": 20}
    )
    assert anchor == ("a/b.py", (10, 20), "high")


def test_inline_comment_anchor_no_line_returns_none():
    assert hhf.inline_comment_anchor({"path": "a/b.py"}) is None


def test_inline_comment_anchor_no_path_returns_none():
    assert hhf.inline_comment_anchor({"line": 5}) is None


def test_resolve_anchor_inline_review_comment_wins():
    review_comments = [
        {
            "id": 1,
            "pull_request_review_id": 555,
            "path": "pr_reviewer/foo.py",
            "line": 42,
            "start_line": None,
        }
    ]
    anchor = hhf.resolve_anchor(
        "some text mentioning scripts/bar.py too", 555, review_comments, ["scripts/bar.py"]
    )
    assert anchor == ("pr_reviewer/foo.py", (42, 42), "high")


def test_resolve_anchor_inline_with_start_line_range():
    review_comments = [
        {
            "id": 1,
            "pull_request_review_id": 555,
            "path": "pr_reviewer/foo.py",
            "line": 50,
            "start_line": 45,
        }
    ]
    anchor = hhf.resolve_anchor("text", 555, review_comments, [])
    assert anchor == ("pr_reviewer/foo.py", (45, 50), "high")


def test_resolve_anchor_named_path_fallback():
    text = "The bug is in scripts/bar.py near the top, unrelated to pr_reviewer/foo.py."
    anchor = hhf.resolve_anchor(text, None, [], ["pr_reviewer/foo.py", "scripts/bar.py"])
    assert anchor == ("scripts/bar.py", None, "medium")


def test_resolve_anchor_named_path_leftmost_wins():
    text = "See pr_reviewer/foo.py first, then scripts/bar.py later."
    anchor = hhf.resolve_anchor(text, None, [], ["scripts/bar.py", "pr_reviewer/foo.py"])
    assert anchor == ("pr_reviewer/foo.py", None, "medium")


def test_resolve_anchor_no_match_returns_none():
    anchor = hhf.resolve_anchor("generic description with no file paths", None, [], ["a/b.py"])
    assert anchor is None


# ---------------------------------------------------------------------------
# Head resolution for blocking comments
# ---------------------------------------------------------------------------


def test_resolve_head_for_comment_picks_latest_before_time():
    commits = [
        {"sha": "c1", "commit": {"committer": {"date": "2026-01-01T00:00:00Z"}}},
        {"sha": "c2", "commit": {"committer": {"date": "2026-01-02T00:00:00Z"}}},
        {"sha": "c3", "commit": {"committer": {"date": "2026-01-03T00:00:00Z"}}},
    ]
    head = hhf.resolve_head_for_comment(commits, "2026-01-02T12:00:00Z")
    assert head == "c2"


def test_resolve_head_for_comment_before_all_commits_falls_back_to_earliest():
    commits = [
        {"sha": "c1", "commit": {"committer": {"date": "2026-01-05T00:00:00Z"}}},
        {"sha": "c2", "commit": {"committer": {"date": "2026-01-06T00:00:00Z"}}},
    ]
    head = hhf.resolve_head_for_comment(commits, "2020-01-01T00:00:00Z")
    assert head == "c1"


def test_resolve_head_for_comment_no_commits():
    assert hhf.resolve_head_for_comment([], "2026-01-01T00:00:00Z") is None


# ---------------------------------------------------------------------------
# Entry id / duplicate handling
# ---------------------------------------------------------------------------


def test_make_entry_id_suffix():
    assert hhf.make_entry_id(REPO, 793, HEAD, 1) == f"{REPO}#793@{HEAD[:8]}"
    assert hhf.make_entry_id(REPO, 793, HEAD, 2) == f"{REPO}#793@{HEAD[:8]}-2"


def _finding(number=100, head_sha=HEAD, file="pr_reviewer/foo.py", text="a defect", confidence="medium"):
    return {
        "repo": REPO,
        "number": number,
        "head_sha": head_sha,
        "base_sha": None,
        "text": text,
        "url": f"https://github.com/{REPO}/pull/{number}",
        "file": file,
        "line_range": None,
        "confidence": confidence,
    }


def test_build_entries_skips_unresolvable_file():
    findings = [_finding(file=None)]
    entries, skipped_no_file, skipped_existing = hhf.build_entries(findings, set())
    assert entries == []
    assert skipped_no_file == 1
    assert skipped_existing == 0


def test_build_entries_skips_ids_already_in_corpus():
    findings = [_finding()]
    existing = {hhf.make_entry_id(REPO, 100, HEAD, 1)}
    entries, skipped_no_file, skipped_existing = hhf.build_entries(findings, existing)
    assert entries == []
    assert skipped_no_file == 0
    assert skipped_existing == 1


def test_build_entries_suffixes_second_finding_at_same_head():
    findings = [_finding(text="first defect"), _finding(text="second defect")]
    entries, _, _ = hhf.build_entries(findings, set())
    assert len(entries) == 2
    assert entries[0]["id"] == hhf.make_entry_id(REPO, 100, HEAD, 1)
    assert entries[1]["id"] == hhf.make_entry_id(REPO, 100, HEAD, 2)


def test_build_entries_shape_matches_corpus():
    findings = [_finding(text="a bug in foo.py", confidence="high")]
    findings[0]["line_range"] = (10, 12)
    findings[0]["base_sha"] = BASE
    entries, _, _ = hhf.build_entries(findings, set())
    entry = entries[0]
    assert entry["repo_full_name"] == REPO
    assert entry["number"] == 100
    assert entry["head_sha"] == HEAD
    assert entry["base_sha"] == BASE
    assert entry["defect"]["description"] == "a bug in foo.py"
    assert entry["defect"]["file"] == "pr_reviewer/foo.py"
    assert entry["defect"]["severity"] == "major"
    assert entry["defect"]["line_range"] == [10, 12]
    assert entry["source"]["production_bot_at_head"] == "APPROVED"
    assert entry["source"]["production_bot_flagged_same"] is False
    assert entry["source"]["anchor_confidence"] == "high"


# ---------------------------------------------------------------------------
# End-to-end harvest_repo with a fake client
# ---------------------------------------------------------------------------


class FakeClient:
    def __init__(self, prs, reviews, issue_comments, review_comments, commits, files):
        self._prs = prs
        self._reviews = reviews
        self._issue_comments = issue_comments
        self._review_comments = review_comments
        self._commits = commits
        self._files = files

    def list_pulls(self, repo, since=None):
        return list(self._prs)

    def list_reviews(self, repo, number):
        return list(self._reviews.get(number, []))

    def list_issue_comments(self, repo, number):
        return list(self._issue_comments.get(number, []))

    def list_review_comments(self, repo, number):
        return list(self._review_comments.get(number, []))

    def list_commits(self, repo, number):
        return list(self._commits.get(number, []))

    def list_files(self, repo, number):
        return list(self._files.get(number, []))


def test_harvest_repo_changes_requested_at_approved_head():
    number = 100
    prs = [{"number": number, "updated_at": "2026-01-05T00:00:00Z"}]
    reviews = {
        number: [
            {
                "id": 1,
                "user": {"login": MAINTAINER},
                "state": "CHANGES_REQUESTED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T01:00:00Z",
                "body": "Bug in pr_reviewer/foo.py: off-by-one.",
            },
            {
                "id": 2,
                "user": {"login": BOT},
                "state": "APPROVED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T00:30:00Z",
                "body": _marker(),
            },
        ]
    }
    files = {number: [{"filename": "pr_reviewer/foo.py"}]}

    client = FakeClient(prs, reviews, {}, {}, {}, files)
    findings = hhf.harvest_repo(client, REPO, {MAINTAINER}, {BOT})
    assert len(findings) == 1
    assert findings[0]["file"] == "pr_reviewer/foo.py"
    assert findings[0]["head_sha"] == HEAD
    assert findings[0]["base_sha"] == BASE


def test_harvest_repo_skips_when_bot_not_approved_at_head():
    number = 101
    prs = [{"number": number, "updated_at": "2026-01-05T00:00:00Z"}]
    reviews = {
        number: [
            {
                "id": 1,
                "user": {"login": MAINTAINER},
                "state": "CHANGES_REQUESTED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T01:00:00Z",
                "body": "Bug in pr_reviewer/foo.py.",
            },
            {
                "id": 2,
                "user": {"login": BOT},
                "state": "CHANGES_REQUESTED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T00:30:00Z",
                "body": _marker(review_result="issues"),
            },
        ]
    }
    client = FakeClient(prs, reviews, {}, {}, {}, {})
    findings = hhf.harvest_repo(client, REPO, {MAINTAINER}, {BOT})
    assert findings == []


def test_harvest_repo_ignores_non_maintainer_changes_requested():
    number = 102
    prs = [{"number": number, "updated_at": "2026-01-05T00:00:00Z"}]
    reviews = {
        number: [
            {
                "id": 1,
                "user": {"login": "random-contributor"},
                "state": "CHANGES_REQUESTED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T01:00:00Z",
                "body": "not a maintainer finding",
            },
            {
                "id": 2,
                "user": {"login": BOT},
                "state": "APPROVED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T00:30:00Z",
                "body": _marker(),
            },
        ]
    }
    client = FakeClient(prs, reviews, {}, {}, {}, {})
    findings = hhf.harvest_repo(client, REPO, {MAINTAINER}, {BOT})
    assert findings == []


def test_harvest_repo_commented_review_with_blocking_text_is_kept():
    """A COMMENTED (not CHANGES_REQUESTED) review whose body reads as
    blocking is still harvested — matches real usage where a maintainer
    posts "Merge blocker: ..." without formally requesting changes."""
    number = 105
    prs = [{"number": number, "updated_at": "2026-01-05T00:00:00Z"}]
    reviews = {
        number: [
            {
                "id": 1,
                "user": {"login": MAINTAINER},
                "state": "COMMENTED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T01:00:00Z",
                "body": "Merge blocker: pr_reviewer/foo.py leaks a secret.",
            },
            {
                "id": 2,
                "user": {"login": BOT},
                "state": "APPROVED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T00:30:00Z",
                "body": _marker(),
            },
        ]
    }
    files = {number: [{"filename": "pr_reviewer/foo.py"}]}
    client = FakeClient(prs, reviews, {}, {}, {}, files)
    findings = hhf.harvest_repo(client, REPO, {MAINTAINER}, {BOT})
    assert len(findings) == 1
    assert findings[0]["file"] == "pr_reviewer/foo.py"


def test_harvest_repo_commented_review_without_blocking_text_is_ignored():
    number = 106
    prs = [{"number": number, "updated_at": "2026-01-05T00:00:00Z"}]
    reviews = {
        number: [
            {
                "id": 1,
                "user": {"login": MAINTAINER},
                "state": "COMMENTED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T01:00:00Z",
                "body": "Nice, this looks clean.",
            },
            {
                "id": 2,
                "user": {"login": BOT},
                "state": "APPROVED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T00:30:00Z",
                "body": _marker(),
            },
        ]
    }
    client = FakeClient(prs, reviews, {}, {}, {}, {})
    findings = hhf.harvest_repo(client, REPO, {MAINTAINER}, {BOT})
    assert findings == []


def test_harvest_repo_blocking_comment_resolves_head_from_commits():
    number = 103
    prs = [{"number": number, "updated_at": "2026-01-05T00:00:00Z"}]
    commits = {
        number: [
            {"sha": "c1", "commit": {"committer": {"date": "2026-01-01T00:00:00Z"}}},
            {"sha": HEAD, "commit": {"committer": {"date": "2026-01-02T00:00:00Z"}}},
        ]
    }
    issue_comments = {
        number: [
            {
                "id": 9,
                "user": {"login": MAINTAINER},
                "created_at": "2026-01-02T12:00:00Z",
                "body": "This is a merge blocker: pr_reviewer/foo.py leaks a secret.",
            }
        ]
    }
    reviews = {
        number: [
            {
                "id": 2,
                "user": {"login": BOT},
                "state": "APPROVED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-02T00:30:00Z",
                "body": _marker(),
            },
        ]
    }
    files = {number: [{"filename": "pr_reviewer/foo.py"}]}
    client = FakeClient(prs, reviews, issue_comments, {}, commits, files)
    findings = hhf.harvest_repo(client, REPO, {MAINTAINER}, {BOT})
    assert len(findings) == 1
    assert findings[0]["head_sha"] == HEAD
    assert findings[0]["file"] == "pr_reviewer/foo.py"


def test_harvest_repo_not_harvested_when_bot_approves_after_finding():
    """End-to-end counterexample (a): the bot's only approval of this head
    lands 5 minutes after the maintainer's finding, so it must not count."""
    number = 110
    prs = [{"number": number, "updated_at": "2026-01-05T00:00:00Z"}]
    reviews = {
        number: [
            {
                "id": 1,
                "user": {"login": MAINTAINER},
                "state": "CHANGES_REQUESTED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-01T10:00:00Z",
                "body": "Bug in pr_reviewer/foo.py.",
            },
            {
                "id": 2,
                "user": {"login": BOT},
                "state": "APPROVED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-01T10:05:00Z",
                "body": _marker(),
            },
        ]
    }
    files = {number: [{"filename": "pr_reviewer/foo.py"}]}
    client = FakeClient(prs, reviews, {}, {}, {}, files)
    findings = hhf.harvest_repo(client, REPO, {MAINTAINER}, {BOT})
    assert findings == []


def test_harvest_repo_harvested_when_bot_approved_before_finding_despite_later_issues_review():
    """End-to-end counterexample (b): the bot approved this head before the
    finding, then later (after the finding) flagged issues on the same
    head — the earlier approval is still what counts."""
    number = 111
    prs = [{"number": number, "updated_at": "2026-01-05T00:00:00Z"}]
    reviews = {
        number: [
            {
                "id": 1,
                "user": {"login": BOT},
                "state": "APPROVED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-01T09:00:00Z",
                "body": _marker(),
            },
            {
                "id": 2,
                "user": {"login": MAINTAINER},
                "state": "CHANGES_REQUESTED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-01T10:00:00Z",
                "body": "Bug in pr_reviewer/foo.py.",
            },
            {
                "id": 3,
                "user": {"login": BOT},
                "state": "CHANGES_REQUESTED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-01T11:00:00Z",
                "body": _marker(review_result="issues"),
            },
        ]
    }
    files = {number: [{"filename": "pr_reviewer/foo.py"}]}
    client = FakeClient(prs, reviews, {}, {}, {}, files)
    findings = hhf.harvest_repo(client, REPO, {MAINTAINER}, {BOT})
    assert len(findings) == 1
    assert findings[0]["file"] == "pr_reviewer/foo.py"


# ---------------------------------------------------------------------------
# One entry per inline finding
# ---------------------------------------------------------------------------


def test_harvest_repo_review_with_two_inline_comments_gives_two_findings():
    number = 120
    prs = [{"number": number, "updated_at": "2026-01-05T00:00:00Z"}]
    reviews = {
        number: [
            {
                "id": 1,
                "user": {"login": MAINTAINER},
                "state": "CHANGES_REQUESTED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T01:00:00Z",
                "body": "",
            },
            {
                "id": 2,
                "user": {"login": BOT},
                "state": "APPROVED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T00:30:00Z",
                "body": _marker(),
            },
        ]
    }
    review_comments = {
        number: [
            {
                "id": 501,
                "pull_request_review_id": 1,
                "path": "pr_reviewer/foo.py",
                "line": 10,
                "start_line": None,
                "body": "off-by-one here",
            },
            {
                "id": 502,
                "pull_request_review_id": 1,
                "path": "scripts/bar.py",
                "line": 20,
                "start_line": None,
                "body": "unchecked return value",
            },
        ]
    }
    files = {number: [{"filename": "pr_reviewer/foo.py"}, {"filename": "scripts/bar.py"}]}
    client = FakeClient(prs, reviews, {}, review_comments, {}, files)
    findings = hhf.harvest_repo(client, REPO, {MAINTAINER}, {BOT})

    assert len(findings) == 2
    by_file = {f["file"]: f for f in findings}
    assert by_file["pr_reviewer/foo.py"]["line_range"] == (10, 10)
    assert by_file["pr_reviewer/foo.py"]["text"] == "off-by-one here"
    assert by_file["scripts/bar.py"]["line_range"] == (20, 20)
    assert by_file["scripts/bar.py"]["text"] == "unchecked return value"
    for f in findings:
        assert f["confidence"] == "high"

    entries, _, _ = hhf.build_entries(findings, set())
    assert len(entries) == 2
    assert {e["defect"]["file"] for e in entries} == {"pr_reviewer/foo.py", "scripts/bar.py"}


def test_harvest_repo_review_body_and_inline_comments_are_separate_findings():
    """A non-empty CHANGES_REQUESTED body is its own finding *in addition
    to* each inline comment, anchored via named-path (not to a comment)."""
    number = 122
    prs = [{"number": number, "updated_at": "2026-01-05T00:00:00Z"}]
    reviews = {
        number: [
            {
                "id": 1,
                "user": {"login": MAINTAINER},
                "state": "CHANGES_REQUESTED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T01:00:00Z",
                "body": "Overall this needs more coverage in scripts/bar.py.",
            },
            {
                "id": 2,
                "user": {"login": BOT},
                "state": "APPROVED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T00:30:00Z",
                "body": _marker(),
            },
        ]
    }
    review_comments = {
        number: [
            {
                "id": 501,
                "pull_request_review_id": 1,
                "path": "pr_reviewer/foo.py",
                "line": 10,
                "start_line": None,
                "body": "off-by-one here",
            },
        ]
    }
    files = {number: [{"filename": "pr_reviewer/foo.py"}, {"filename": "scripts/bar.py"}]}
    client = FakeClient(prs, reviews, {}, review_comments, {}, files)
    findings = hhf.harvest_repo(client, REPO, {MAINTAINER}, {BOT})

    assert len(findings) == 2
    by_file = {f["file"]: f for f in findings}
    assert by_file["pr_reviewer/foo.py"]["confidence"] == "high"
    assert by_file["pr_reviewer/foo.py"]["line_range"] == (10, 10)
    assert by_file["scripts/bar.py"]["confidence"] == "medium"
    assert by_file["scripts/bar.py"]["line_range"] is None
    assert "Overall this needs more coverage" in by_file["scripts/bar.py"]["text"]


def test_harvest_repo_commented_review_harmless_body_blocking_inline_harvests_only_inline():
    """Counterexample: a harmless body must not mask a blocking inline
    comment on a non-CHANGES_REQUESTED review -- the inline comment
    qualifies (and is harvested) on its own text, independent of the body."""
    number = 124
    prs = [{"number": number, "updated_at": "2026-01-05T00:00:00Z"}]
    reviews = {
        number: [
            {
                "id": 1,
                "user": {"login": MAINTAINER},
                "state": "COMMENTED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T01:00:00Z",
                "body": "Nice work overall!",
            },
            {
                "id": 2,
                "user": {"login": BOT},
                "state": "APPROVED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T00:30:00Z",
                "body": _marker(),
            },
        ]
    }
    review_comments = {
        number: [
            {
                "id": 501,
                "pull_request_review_id": 1,
                "path": "pr_reviewer/foo.py",
                "line": 10,
                "start_line": None,
                "body": "This is a merge blocker: null deref here.",
            },
        ]
    }
    files = {number: [{"filename": "pr_reviewer/foo.py"}]}
    client = FakeClient(prs, reviews, {}, review_comments, {}, files)
    findings = hhf.harvest_repo(client, REPO, {MAINTAINER}, {BOT})
    assert len(findings) == 1
    assert findings[0]["text"] == "This is a merge blocker: null deref here."
    assert findings[0]["file"] == "pr_reviewer/foo.py"


def test_harvest_repo_commented_review_one_blocking_inline_one_nit_harvests_only_blocker():
    """Counterexample: on a non-CHANGES_REQUESTED review, one blocking
    inline comment must not sweep in an unrelated nit inline comment --
    each inline comment is gated on its own text."""
    number = 125
    prs = [{"number": number, "updated_at": "2026-01-05T00:00:00Z"}]
    reviews = {
        number: [
            {
                "id": 1,
                "user": {"login": MAINTAINER},
                "state": "COMMENTED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T01:00:00Z",
                "body": "",
            },
            {
                "id": 2,
                "user": {"login": BOT},
                "state": "APPROVED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T00:30:00Z",
                "body": _marker(),
            },
        ]
    }
    review_comments = {
        number: [
            {
                "id": 501,
                "pull_request_review_id": 1,
                "path": "pr_reviewer/foo.py",
                "line": 10,
                "start_line": None,
                "body": "Merge blocker: this leaks a secret.",
            },
            {
                "id": 502,
                "pull_request_review_id": 1,
                "path": "scripts/bar.py",
                "line": 20,
                "start_line": None,
                "body": "nit: rename this variable",
            },
        ]
    }
    files = {number: [{"filename": "pr_reviewer/foo.py"}, {"filename": "scripts/bar.py"}]}
    client = FakeClient(prs, reviews, {}, review_comments, {}, files)
    findings = hhf.harvest_repo(client, REPO, {MAINTAINER}, {BOT})
    assert len(findings) == 1
    assert findings[0]["file"] == "pr_reviewer/foo.py"
    assert findings[0]["text"] == "Merge blocker: this leaks a secret."


def test_harvest_repo_commented_review_inline_comments_need_blocking_language():
    """A COMMENTED review with no blocking language anywhere (body or
    inline comments) is skipped entirely -- inline splitting doesn't bypass
    the blocking-language gate for non-CHANGES_REQUESTED reviews."""
    number = 123
    prs = [{"number": number, "updated_at": "2026-01-05T00:00:00Z"}]
    reviews = {
        number: [
            {
                "id": 1,
                "user": {"login": MAINTAINER},
                "state": "COMMENTED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T01:00:00Z",
                "body": "",
            },
            {
                "id": 2,
                "user": {"login": BOT},
                "state": "APPROVED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T00:30:00Z",
                "body": _marker(),
            },
        ]
    }
    review_comments = {
        number: [
            {
                "id": 501,
                "pull_request_review_id": 1,
                "path": "pr_reviewer/foo.py",
                "line": 10,
                "start_line": None,
                "body": "nit: rename this variable",
            },
        ]
    }
    client = FakeClient(prs, reviews, {}, review_comments, {}, {})
    findings = hhf.harvest_repo(client, REPO, {MAINTAINER}, {BOT})
    assert findings == []


def test_harvest_repo_non_blocking_comment_ignored():
    number = 104
    prs = [{"number": number, "updated_at": "2026-01-05T00:00:00Z"}]
    commits = {number: [{"sha": HEAD, "commit": {"committer": {"date": "2026-01-02T00:00:00Z"}}}]}
    issue_comments = {
        number: [
            {
                "id": 9,
                "user": {"login": MAINTAINER},
                "created_at": "2026-01-02T12:00:00Z",
                "body": "Nice work on this one!",
            }
        ]
    }
    client = FakeClient(prs, {}, issue_comments, {}, commits, {})
    findings = hhf.harvest_repo(client, REPO, {MAINTAINER}, {BOT})
    assert findings == []


# ---------------------------------------------------------------------------
# CLI / full-file output validates against RealPRCorpus
# ---------------------------------------------------------------------------


def test_main_writes_output_that_validates(tmp_path, monkeypatch):
    number = 200
    prs = [{"number": number, "updated_at": "2026-01-05T00:00:00Z"}]
    reviews = {
        number: [
            {
                "id": 1,
                "user": {"login": MAINTAINER},
                "state": "CHANGES_REQUESTED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T01:00:00Z",
                "body": "Bug in pr_reviewer/foo.py: off-by-one.",
            },
            {
                "id": 2,
                "user": {"login": BOT},
                "state": "APPROVED",
                "commit_id": HEAD,
                "submitted_at": "2026-01-05T00:30:00Z",
                "body": _marker(),
            },
        ]
    }
    files = {number: [{"filename": "pr_reviewer/foo.py"}]}
    client = FakeClient(prs, reviews, {}, {}, {}, files)

    monkeypatch.setattr(hhf, "GitHubClient", lambda token=None: client)

    corpus_path = tmp_path / "corpus.json"
    corpus_path.write_text(
        json.dumps({"metadata": {}, "real_pr_corpus": {"vulnerable": [], "clean": []}}),
        encoding="utf-8",
    )
    output_path = tmp_path / "out.json"

    rc = hhf.main(
        [
            "--repos",
            REPO,
            "--maintainers",
            MAINTAINER,
            "--bots",
            BOT,
            "--corpus",
            str(corpus_path),
            "--output",
            str(output_path),
        ]
    )
    assert rc == 0

    corpus = RealPRCorpus.from_file(output_path)
    assert len(corpus.vulnerable) == 1
    assert corpus.vulnerable[0].id == f"{REPO}#{number}@{HEAD[:8]}"

    # The original corpus file (--corpus, not --output) was left untouched.
    original = json.loads(corpus_path.read_text(encoding="utf-8"))
    assert original["real_pr_corpus"]["vulnerable"] == []


def test_main_requires_repos_maintainers_bots():
    for missing_args in (
        ["--maintainers", MAINTAINER, "--bots", BOT],
        ["--repos", REPO, "--bots", BOT],
        ["--repos", REPO, "--maintainers", MAINTAINER],
    ):
        try:
            hhf.main(missing_args)
        except SystemExit as exc:
            assert exc.code != 0
        else:
            raise AssertionError("expected argparse to reject missing required input")
