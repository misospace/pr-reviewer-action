"""Tests for the review-completion harvester (#1602): pr_reviewer/review_completion.py and scripts/harvest_review_completion.py.

Fully offline: no network access. The CLI is exercised through its
``--from-json`` offline mode against the organic fixture, which replays
the same records the forge reads would return.
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = ROOT / "scripts"
for _p in (str(ROOT), str(SCRIPTS_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import harvest_review_completion as hrc  # noqa: E402
from pr_reviewer import review_completion as rc  # noqa: E402

REPO = "misospace/pr-reviewer-action"
BOT = "myoshia[bot]"
HEAD = "a" * 40
OTHER_HEAD = "b" * 40
BASE = "c" * 40
FIXTURE = ROOT / "tests" / "fixtures" / "review-completion" / "organic-fixture.json"


def _marker(head_sha=HEAD, base_sha=BASE, review_result="clean", version="v3.5.0", **extra):
    payload = {"version": 1, "head_sha": head_sha, "base_sha": base_sha, "review_result": review_result}
    payload.update(extra)
    return (
        "<!-- ai-pr-reviewer -->\n"
        f"<!-- ai-pr-reviewer:{json.dumps(payload, separators=(',', ':'))} -->\n"
        f"_Analysis engine: claude-code · pr-reviewer-action {version}_\n\nreview body"
    )


def _pull(number, head, reviews=(), comments=(), updated_at="2026-11-01T00:00:00Z"):
    return {"number": number, "head_sha": head, "updated_at": updated_at,
            "reviews": list(reviews), "comments": list(comments)}


def _review(review_id, head, state="APPROVED", body=None, login=BOT,
            submitted_at="2026-11-01T00:00:00Z"):
    return {"id": review_id, "user": {"login": login}, "state": state,
            "commit_id": head, "submitted_at": submitted_at,
            "html_url": f"https://github.com/{REPO}/pull/1#pullrequestreview-{review_id}",
            "body": _marker(head_sha=head) if body is None else body}


def _comment(comment_id, head, body=None, login=BOT, created_at="2026-11-01T00:00:00Z"):
    return {"id": comment_id, "user": {"login": login},
            "created_at": created_at,
            "html_url": f"https://github.com/{REPO}/pull/1#issuecomment-{comment_id}",
            "body": _marker(head_sha=head) if body is None else body}


# ---------------------------------------------------------------------------
# Body parsing
# ---------------------------------------------------------------------------


def test_parse_action_version_from_engine_line():
    body = "_Analysis engine: claude-code · pr-reviewer-action v3.4.1_\n\nprose"
    assert rc.parse_action_version(body) == "v3.4.1"


def test_parse_action_version_absent_is_unknown():
    assert rc.parse_action_version("just prose, no engine line") == "unknown"
    assert rc.parse_action_version("") == "unknown"
    # An engine line without a version token stays unknown, never a guess.
    assert rc.parse_action_version("_Analysis engine: claude-code_") == "unknown"
    assert rc.parse_action_version("_Analysis engine: llama3.1_70b_instruct_") == "unknown"


def test_parse_action_version_engine_name_with_underscores():
    """Model identifiers may contain underscores; they must not void the version."""
    body = (
        "_Analysis engine: litellm/llama3.1_70b_instruct · "
        "pr-reviewer-action v3.8.0-dev+972ab8a_\n\nprose"
    )
    assert rc.parse_action_version(body) == "v3.8.0-dev+972ab8a"


def test_row_version_and_scope_survive_underscored_engine_name():
    body = _marker(version="v3.5.0").replace("claude-code", "meta/llama3.1_70b_instruct")
    rows = rc.collect_rows(
        REPO, [_pull(1, HEAD, comments=[_comment(1, HEAD, body=body)])], [BOT]
    )
    assert rows[0]["action_version"] == "v3.5.0"
    kept, excluded = rc.filter_by_action_version(rows, ["3.5.0"])
    assert len(kept) == 1
    assert excluded == {}


def test_body_indicates_skip_only_from_the_action_note():
    assert rc.body_indicates_skip("**AI PR Review skipped:** `diff-unchanged`")
    assert not rc.body_indicates_skip("the coverage loop skipped a file, whatever")
    assert not rc.body_indicates_skip("")


def test_bound_caps_and_rejects_non_strings():
    assert rc.bound("x" * 500, 10) == "x" * 10
    assert rc.bound("  spaced  ") == "spaced"
    assert rc.bound(None) is None
    assert rc.bound(42) is None
    assert rc.bound("") is None


# ---------------------------------------------------------------------------
# Disposition invariant (#1602 metric invariant)
# ---------------------------------------------------------------------------


def test_no_marker_is_unknown_no_marker():
    row = rc.collect_rows(REPO, [_pull(1, HEAD, comments=[_comment(1, HEAD, body="plain prose")])], [BOT])[0]
    assert row["disposition"] == "unknown_no_marker"
    assert row["head_sha"] == ""


def test_skip_note_with_marker_is_skipped():
    body = _marker() + "\n**AI PR Review skipped:** `diff-unchanged`"
    row = rc.collect_rows(REPO, [_pull(1, HEAD, comments=[_comment(1, HEAD, body=body)])], [BOT])[0]
    assert row["disposition"] == "skipped"


def test_skip_note_without_marker_stays_unknown_no_marker():
    body = "**AI PR Review skipped:** `diff-unchanged`"
    row = rc.collect_rows(REPO, [_pull(1, HEAD, comments=[_comment(1, HEAD, body=body)])], [BOT])[0]
    assert row["disposition"] == "unknown_no_marker"


def test_hostile_wrong_typed_shapes_survive():
    """#252: a hostile forge's wrong-typed JSON is data, never a crash.

    A string ``user``, a numeric ``login``, and non-string marker scalars
    must classify fail-closed (unknown/never clean), not raise.
    """
    hostile_marker = json.dumps(
        {
            "version": 1,
            "head_sha": HEAD,
            "base_sha": BASE,
            "review_result": {"claimed": "clean"},
            "coverage": ["partial"],
            "required_checks": True,
        },
        separators=(",", ":"),
    )
    body = (
        "<!-- ai-pr-reviewer -->\n"
        f"<!-- ai-pr-reviewer:{hostile_marker} -->\n"
        "_Analysis engine: claude-code · pr-reviewer-action v3.5.0_"
    )
    string_user_review = {"id": 1, "user": "myoshia[bot]", "state": "APPROVED",
                          "commit_id": HEAD, "body": body, "submitted_at": "2026-11-01T00:00:00Z"}
    numeric_login_comment = {"id": 2, "user": {"login": 7}, "body": body,
                             "created_at": "2026-11-01T00:00:00Z"}
    pull = _pull(1, HEAD, reviews=[string_user_review], comments=[numeric_login_comment])
    rows = rc.collect_rows(REPO, [pull], [BOT])
    assert rows == []  # string user / numeric login never fabricate a bot attempt

    real_review = _review(3, HEAD, "APPROVED", body)
    rows = rc.collect_rows(REPO, [_pull(1, HEAD, reviews=[real_review])], [BOT])
    # Non-string review_result is not a usable "clean": fail closed to
    # failed_or_unavailable, and a native APPROVED over that state is
    # never trusted_complete_approval.
    assert rows[0]["disposition"] == "failed_or_unavailable"

    attestation = {"conclusion": ["approved"], "reason_code": "x", "head_sha": HEAD}
    rows = rc.collect_rows(REPO, [_pull(1, HEAD, reviews=[real_review])], [BOT],
                           attestations=[attestation])
    assert rows[0]["disposition"] == "failed_or_unavailable"


def test_native_approval_over_partial_is_never_trusted():
    """Invariant: a native APPROVED with review_result partial is partial_or_abstained."""
    body = _marker(review_result="partial", coverage="partial", verdict="approve")
    rows = rc.collect_rows(REPO, [_pull(1, HEAD, reviews=[_review(1, HEAD, "APPROVED", body)])], [BOT])
    assert rows[0]["disposition"] == "partial_or_abstained"
    # The model's approve prose is recorded as a claim, never as evidence.
    assert rows[0]["verdict_prose"] == "approve"


def test_native_approval_over_partial_coverage_is_never_trusted():
    body = _marker(review_result="clean", coverage="partial")
    row = rc.collect_rows(REPO, [_pull(1, HEAD, reviews=[_review(1, HEAD, "APPROVED", body)])], [BOT])[0]
    assert row["disposition"] == "partial_or_abstained"


def test_native_approval_over_unknown_coverage_is_never_trusted():
    body = _marker(review_result="clean", coverage="unknown")
    row = rc.collect_rows(REPO, [_pull(1, HEAD, reviews=[_review(1, HEAD, "APPROVED", body)])], [BOT])[0]
    assert row["disposition"] == "partial_or_abstained"


def test_native_approval_over_incomplete_required_checks_is_never_trusted():
    body = _marker(review_result="clean", required_checks="incomplete")
    row = rc.collect_rows(REPO, [_pull(1, HEAD, reviews=[_review(1, HEAD, "APPROVED", body)])], [BOT])[0]
    assert row["disposition"] == "partial_or_abstained"


def test_marker_with_unknown_head_sha_is_never_trusted():
    body = _marker(head_sha="unknown")
    row = rc.collect_rows(REPO, [_pull(1, HEAD, reviews=[_review(1, HEAD, "APPROVED", body)])], [BOT])[0]
    assert row["disposition"] == "partial_or_abstained"


def test_unbound_head_sentinels_never_bind_a_marker():
    """The unresolved-head sentinel set is the boundary, fed to itself.

    Every spelling the publisher can write for "head could not be
    resolved" binds no head, so a native APPROVED over such a marker is
    never a trusted approval — case included.
    """
    for sentinel in ("", "unknown", "UNKNOWN", " Unknown "):
        body = _marker(head_sha=sentinel)
        row = rc.collect_rows(REPO, [_pull(1, HEAD, reviews=[_review(1, HEAD, "APPROVED", body)])], [BOT])[0]
        assert row["disposition"] == "partial_or_abstained"


def test_conflicting_marker_head_never_trusted():
    """Two supplied head identities that disagree are unsafe telemetry.

    A native APPROVED bound to ``OTHER_HEAD`` whose body carries a clean
    marker for ``HEAD`` proves nothing about either head: the row is
    ``partial_or_abstained`` with the conflict recorded, never a
    trusted_complete_approval.
    """
    review = _review(1, OTHER_HEAD, "APPROVED", body=_marker(head_sha=HEAD))
    rows = rc.collect_rows(REPO, [_pull(1, OTHER_HEAD, reviews=[review])], [BOT])
    assert rows[0]["head_sha"] == OTHER_HEAD
    assert rows[0]["disposition"] == "partial_or_abstained"
    assert rows[0]["head_conflict"] is True
    # The native event is still recorded for the reader; only trust falls.
    assert rows[0]["native_event"] == "APPROVED"
    assert all(row["disposition"] != "trusted_complete_approval" for row in rows)


def test_conflicting_marker_head_defeats_attestation_too():
    """The disagreement outranks every evidence path, attestation included."""
    review = _review(1, OTHER_HEAD, "APPROVED", body=_marker(head_sha=HEAD))
    rows = rc.collect_rows(
        REPO,
        [_pull(1, OTHER_HEAD, reviews=[review])],
        [BOT],
        [{"conclusion": "approved", "reason_code": "native_gate", "head_sha": OTHER_HEAD}],
    )
    assert rows[0]["attestation_conclusion"] == "approved"
    assert rows[0]["disposition"] == "partial_or_abstained"
    assert rows[0]["head_conflict"] is True


def test_clean_marker_with_bound_native_approval_is_trusted():
    rows = rc.collect_rows(REPO, [_pull(1, HEAD, reviews=[_review(1, HEAD, "APPROVED")])], [BOT])
    assert rows[0]["disposition"] == "trusted_complete_approval"
    assert rows[0]["native_event"] == "APPROVED"
    assert rows[0]["native_event_bound"] is True
    assert rows[0]["head_conflict"] is False


def test_clean_marker_without_native_or_attestation_is_unknown_missing_native():
    """Invariant: comment prose never short-circuits to a trusted approval."""
    rows = rc.collect_rows(REPO, [_pull(1, HEAD, comments=[_comment(1, HEAD)])], [BOT])
    assert rows[0]["disposition"] == "unknown_missing_native"
    assert rows[0]["native_event"] is None
    assert rows[0]["native_event_bound"] is False


def test_unbound_native_approval_is_not_evidence():
    """A bot APPROVED at a different head is not evidence for this row."""
    reviews = [_review(1, OTHER_HEAD, "APPROVED")]
    rows = rc.collect_rows(REPO, [_pull(1, HEAD, comments=[_comment(2, HEAD)])], [BOT])
    assert rows[0]["disposition"] == "unknown_missing_native"
    assert reviews[0]["commit_id"] == OTHER_HEAD


def test_head_bound_attestation_upgrades_marker_complete_row():
    attestations = [{"conclusion": "approved", "reason_code": "native_gate", "head_sha": HEAD}]
    rows = rc.collect_rows(
        REPO, [_pull(1, HEAD, comments=[_comment(1, HEAD)])], [BOT], attestations
    )
    assert rows[0]["disposition"] == "trusted_complete_approval"
    assert rows[0]["attestation_conclusion"] == "approved"
    assert rows[0]["attestation_reason_code"] == "native_gate"


def test_attestation_for_a_different_head_is_not_evidence():
    attestations = [{"conclusion": "approved", "reason_code": "native_gate", "head_sha": OTHER_HEAD}]
    rows = rc.collect_rows(
        REPO, [_pull(1, HEAD, comments=[_comment(1, HEAD)])], [BOT], attestations
    )
    assert rows[0]["disposition"] == "unknown_missing_native"


def test_non_approved_attestation_never_trusts():
    attestations = [{"conclusion": "failed", "reason_code": "crash", "head_sha": HEAD}]
    rows = rc.collect_rows(
        REPO, [_pull(1, HEAD, comments=[_comment(1, HEAD)])], [BOT], attestations
    )
    assert rows[0]["disposition"] == "unknown_missing_native"


def test_findings_and_issues_are_complete_findings():
    for result in ("findings", "issues"):
        body = _marker(review_result=result)
        row = rc.collect_rows(REPO, [_pull(1, HEAD, comments=[_comment(1, HEAD, body=body)])], [BOT])[0]
        assert row["disposition"] == "complete_findings"


def test_marker_without_usable_review_result_is_failed_or_unavailable():
    body = _marker(review_result="")
    row = rc.collect_rows(REPO, [_pull(1, HEAD, comments=[_comment(1, HEAD, body=body)])], [BOT])[0]
    assert row["disposition"] == "failed_or_unavailable"


def test_native_event_vocabulary_is_bounded():
    body = _marker(review_result="findings")
    row = rc.collect_rows(REPO, [_pull(1, HEAD, reviews=[_review(1, HEAD, "WEIRD", body)])], [BOT])[0]
    assert row["native_event"] is None


# ---------------------------------------------------------------------------
# Row collection
# ---------------------------------------------------------------------------


def test_non_bot_records_are_not_attempts():
    rows = rc.collect_rows(
        REPO,
        [_pull(1, HEAD, reviews=[_review(1, HEAD, "COMMENTED", login="joryirving")],
               comments=[_comment(2, HEAD, login="joryirving")])],
        [BOT],
    )
    assert rows == []


def test_row_fields_are_bounded_and_carry_no_raw_body():
    body = _marker() + "\n" + "secret prose " * 100
    row = rc.collect_rows(REPO, [_pull(1, HEAD, comments=[_comment(1, HEAD, body=body)])], [BOT])[0]
    assert "secret prose" not in json.dumps(row)
    assert row["raw_link"].startswith("https://github.com/")
    assert row["source"] == "comment"
    assert row["review_id"] is None


def test_native_review_row_fields():
    body = _marker(review_result="findings", incomplete_reason="execution",
                   tool_stop_reason="max-rounds", review_route="escalated")
    row = rc.collect_rows(REPO, [_pull(1, HEAD, reviews=[_review(7, HEAD, "COMMENTED", body)])], [BOT])[0]
    assert row["review_id"] == 7
    assert row["source"] == "native_review"
    # The row keeps the publisher's own spelling of the version.
    assert row["action_version"] == "v3.5.0"
    assert row["incomplete_reason"] == "execution"
    assert row["tool_stop_reason"] == "max-rounds"
    assert row["review_route"] == "escalated"
    assert row["head_sha"] == HEAD


def test_superseded_head_against_collection_time_pr_head():
    rows = rc.collect_rows(
        REPO, [_pull(1, OTHER_HEAD, reviews=[_review(1, HEAD), _review(2, OTHER_HEAD)])], [BOT]
    )
    by_id = {row["review_id"]: row for row in rows}
    assert by_id[1]["superseded_head"] is True
    assert by_id[2]["superseded_head"] is False


def test_rerun_of_links_prior_attempt_at_same_head():
    rows = rc.collect_rows(REPO, [_pull(1, HEAD, reviews=[_review(1, HEAD), _review(2, HEAD)])], [BOT])
    by_id = {row["review_id"]: row for row in rows}
    assert by_id[1]["rerun_of"] is None
    assert by_id[2]["rerun_of"] == 1


def test_rerun_of_is_none_across_different_heads():
    rows = rc.collect_rows(REPO, [_pull(1, OTHER_HEAD, reviews=[_review(1, HEAD), _review(2, OTHER_HEAD)])], [BOT])
    by_id = {row["review_id"]: row for row in rows}
    assert by_id[2]["rerun_of"] is None


def test_rows_dedupe_idempotently():
    pull = _pull(1, HEAD, reviews=[_review(1, HEAD)], comments=[_comment(2, HEAD)])
    first = rc.collect_rows(REPO, [pull], [BOT])
    second = rc.collect_rows(REPO, [pull, pull], [BOT])
    assert first == second
    keys = [(r["repo"], r["pr"], r["review_id"], r["head_sha"]) for r in second]
    assert len(keys) == len(set(keys))


def test_missing_bot_login_fails_closed():
    """No --bot-login: attempt authorship cannot be attributed, so no rows.

    Bot identity is an input, never inferred: collecting every forge
    user's comments as "attempts" (or trusting a marker a commenter could
    paste into their own comment) would fabricate telemetry, so the
    collector fails closed with zero rows instead.
    """
    rows = rc.collect_rows(REPO, [_pull(1, HEAD, reviews=[_review(1, HEAD, "APPROVED")])], [])
    assert rows == []


# ---------------------------------------------------------------------------
# Rollups
# ---------------------------------------------------------------------------


def _sample_rows():
    return rc.collect_rows(
        REPO,
        [
            _pull(1, HEAD, reviews=[
                _review(1, HEAD, "APPROVED"),
                _review(2, HEAD, "COMMENTED", body=_marker(head_sha=HEAD, review_result="findings")),
            ]),
            _pull(2, OTHER_HEAD, comments=[_comment(3, OTHER_HEAD, body="no marker")]),
        ],
        [BOT],
    )


def test_operational_rollup_denominators():
    rollup = rc.operational_rollup(_sample_rows())
    den = rollup["denominators"]
    assert den["total_attempts"] == 3
    assert den["eligible_attempts"] == 3
    assert den["attempts_with_marker"] == 2
    assert den["attempts_with_native_event"] == 2
    assert den["attempts_with_unknown_or_missing_telemetry"] == 1
    assert rollup["by_disposition"]["trusted_complete_approval"] == 1
    assert rollup["by_disposition"]["complete_findings"] == 1
    assert rollup["by_disposition"]["unknown_no_marker"] == 1
    assert rollup["missing_data"]["no_marker"] == 1
    assert "denominators" in rollup["summary"]


def test_operational_rollup_route_fallback_bucket():
    rollup = rc.operational_rollup(_sample_rows())
    # Both markers omit review_route and the marker-less comment has
    # none — all three bucket under the legacy fallback route.
    assert rollup["by_review_route"]["legacy"] == 3


def test_correctness_rollup_counts_known_labels_only():
    """One effective label per head, counted once.

    The head at PR 1 carries two contradictory known labels, so it
    leaves every count and denominator and is counted once as a
    contradictory head. The unmatched record and the unknown label are
    excluded records and are counted as such.
    """
    rows = _sample_rows()
    adjudications = [
        {"pr": 1, "head_sha": HEAD, "label": "missed_blocker"},
        {"pr": 1, "head_sha": HEAD, "label": "false_blocker"},
        {"pr": 99, "head_sha": OTHER_HEAD, "label": "missed_blocker"},  # unmatched
        {"pr": 2, "head_sha": OTHER_HEAD, "label": "unsure"},  # unknown label
    ]
    rollup = rc.correctness_rollup(rows, adjudications)
    assert rollup["confirmed_blockers"] == 0
    assert rollup["missed_blockers"] == 0
    assert rollup["false_blockers"] == 0
    assert rollup["adjudicated_heads"] == 0
    assert rollup["unknown_excluded"] == 2
    assert rollup["contradictory_excluded"] == 1
    assert rollup["precision"] is None
    assert rollup["recall"] is None


def test_correctness_rollup_counts_a_confirmed_blocker_as_a_true_positive():
    rows = _sample_rows()
    rollup = rc.correctness_rollup(
        rows, [{"pr": 1, "head_sha": HEAD, "label": "confirmed_blocker"}]
    )
    assert rollup["confirmed_blockers"] == 1
    assert rollup["adjudicated_heads"] == 1
    # A true positive alone is a perfect score on both metrics.
    assert rollup["precision"] == 1.0
    assert rollup["recall"] == 1.0


def test_correctness_rollup_counts_repeated_identical_labels_once():
    rows = _sample_rows()
    rollup = rc.correctness_rollup(
        rows,
        [
            {"pr": 1, "head_sha": HEAD, "label": "missed_blocker"},
            {"pr": 1, "head_sha": HEAD, "label": "missed_blocker"},
            {"pr": 1, "head_sha": HEAD, "label": "missed_blocker"},
        ],
    )
    assert rollup["missed_blockers"] == 1
    assert rollup["adjudicated_heads"] == 1
    assert rollup["unknown_excluded"] == 0
    assert rollup["contradictory_excluded"] == 0
    # One false negative, no true positive: recall is zero, precision has
    # no denominator at all.
    assert rollup["recall"] == 0.0
    assert rollup["precision"] is None


def test_correctness_rollup_excludes_a_contradictory_head_once():
    rows = _sample_rows()
    rollup = rc.correctness_rollup(
        rows,
        [
            {"pr": 1, "head_sha": HEAD, "label": "confirmed_blocker"},
            {"pr": 1, "head_sha": HEAD, "label": "false_blocker"},
        ],
    )
    assert rollup["confirmed_blockers"] == 0
    assert rollup["missed_blockers"] == 0
    assert rollup["false_blockers"] == 0
    assert rollup["adjudicated_heads"] == 0
    # A contradictory head is a head, not a record: it is counted apart
    # from the excluded records.
    assert rollup["contradictory_excluded"] == 1
    assert rollup["unknown_excluded"] == 0
    assert rollup["precision"] is None
    assert rollup["recall"] is None


def test_correctness_rollup_counts_heads_not_attempts():
    """The adjudication unit is the head: one record covers every attempt.

    Two attempts at one head (a rerun) share the ``(pr, head_sha)``
    key, so one adjudication record counts one head, not two attempts.
    """
    rows = rc.collect_rows(
        REPO, [_pull(1, HEAD, reviews=[_review(1, HEAD), _review(2, HEAD)])], [BOT]
    )
    assert len(rows) == 2
    rollup = rc.correctness_rollup(
        rows, [{"pr": 1, "head_sha": HEAD, "label": "confirmed_blocker"}]
    )
    assert rollup["adjudicated_heads"] == 1
    assert rollup["confirmed_blockers"] == 1
    assert rollup["unknown_excluded"] == 0
    assert rollup["contradictory_excluded"] == 0


def test_correctness_rollup_counts_a_malformed_record_as_excluded():
    """A record that is not a record is excluded and counted."""
    for record in ("not-a-record", 42, None, ["pr", 1]):
        rollup = rc.correctness_rollup(_sample_rows(), [record])
        assert rollup["adjudicated_heads"] == 0
        assert rollup["confirmed_blockers"] == 0
        assert rollup["missed_blockers"] == 0
        assert rollup["false_blockers"] == 0
        assert rollup["unknown_excluded"] == 1
        assert rollup["contradictory_excluded"] == 0


def test_correctness_rollup_precision_and_recall_are_none_without_denominator():
    """A false positive alone has no true positive to divide by."""
    rows = _sample_rows()
    rollup = rc.correctness_rollup(
        rows, [{"pr": 1, "head_sha": HEAD, "label": "false_blocker"}]
    )
    assert rollup["false_blockers"] == 1
    assert rollup["adjudicated_heads"] == 1
    assert rollup["precision"] == 0.0
    assert rollup["recall"] is None

    rollup = rc.correctness_rollup(
        rows, [{"pr": 1, "head_sha": HEAD, "label": "missed_blocker"}]
    )
    assert rollup["missed_blockers"] == 1
    assert rollup["precision"] is None
    assert rollup["recall"] == 0.0


def test_correctness_rollup_empty_is_none_not_zero():
    rollup = rc.correctness_rollup(_sample_rows(), [])
    assert rollup["adjudicated_heads"] == 0
    assert rollup["precision"] is None
    assert rollup["recall"] is None


def test_correctness_rollup_excludes_hostile_label_types():
    """A label that only resembles the known vocabulary is excluded.

    A hostile adjudication file can put any JSON value in ``label``. A
    shape that mirrors a known label (a dict, a list, a number) is not a
    known label: it is excluded from the denominators and counted, never
    counted as a blocker judgment.
    """
    for label in ({"kind": "missed_blocker"}, ["missed_blocker"], 1, None, ""):
        rollup = rc.correctness_rollup(
            _sample_rows(), [{"pr": 1, "head_sha": HEAD, "label": label}]
        )
        assert rollup["adjudicated_heads"] == 0
        assert rollup["missed_blockers"] == 0
        assert rollup["false_blockers"] == 0
        assert rollup["unknown_excluded"] == 1


def test_correctness_rollup_excludes_hostile_row_key_shapes():
    """A record that cannot name a collected row is excluded and counted.

    A hostile adjudication file can put any JSON value in ``pr`` or
    ``head_sha``. A shape that cannot name a collected row (a dict, a
    string, a bool) is excluded from the denominators and counted, never
    counted as a blocker judgment and never a crash.
    """
    for record in (
        {"pr": "1", "head_sha": HEAD, "label": "missed_blocker"},
        {"pr": 1, "head_sha": 42, "label": "missed_blocker"},
        {"pr": True, "head_sha": HEAD, "label": "missed_blocker"},
        {"pr": {"number": 1}, "head_sha": HEAD, "label": "missed_blocker"},
    ):
        rollup = rc.correctness_rollup(_sample_rows(), [record])
        assert rollup["adjudicated_heads"] == 0
        assert rollup["missed_blockers"] == 0
        assert rollup["false_blockers"] == 0
        assert rollup["unknown_excluded"] == 1


def test_correctness_rollup_ignores_unlabeled_sources():
    """No adjudications means no correctness numbers at all."""
    rollup = rc.correctness_rollup(_sample_rows(), None)
    assert rollup["adjudicated_heads"] == 0
    assert rollup["precision"] is None
# ---------------------------------------------------------------------------
# Action-version scope
# ---------------------------------------------------------------------------


def _scope_row(version):
    return {"pr": 1, "head_sha": HEAD, "action_version": version}


def _version_row(version, *, pr=1, head=HEAD):
    """A collected row published by ``version``."""
    body = _marker(head_sha=head, version=version)
    rows = rc.collect_rows(
        REPO, [_pull(pr, head, comments=[_comment(pr, head, body=body)])], [BOT]
    )
    return rows[0]


def test_filter_by_action_version_keeps_the_rows_in_scope():
    rows = [_scope_row("3.5.0"), _scope_row("3.4.1")]
    kept, excluded = rc.filter_by_action_version(rows, ["3.5.0"])
    assert [row["action_version"] for row in kept] == ["3.5.0"]
    assert excluded == {"action_version_other": 1}


def test_filter_by_action_version_treats_a_bare_string_as_one_version():
    """A bare string is one version, not a sequence of characters."""
    rows = [_scope_row("3.5.0"), _scope_row("3.4.1")]
    kept, excluded = rc.filter_by_action_version(rows, "3.5.0")
    assert [row["action_version"] for row in kept] == ["3.5.0"]
    assert excluded == {"action_version_other": 1}


def test_filter_by_action_version_excludes_an_unknown_version():
    """An unknown version cannot be proven to be in scope, so it is excluded."""
    rows = [_scope_row("3.5.0"), _scope_row("unknown")]
    kept, excluded = rc.filter_by_action_version(rows, ["3.5.0"])
    assert [row["action_version"] for row in kept] == ["3.5.0"]
    assert excluded == {"action_version_unknown": 1}


def test_filter_by_action_version_empty_scope_excludes_nothing():
    rows = [_scope_row("3.5.0"), _scope_row("unknown")]
    kept, excluded = rc.filter_by_action_version(rows, [])
    assert kept == rows
    assert excluded == {}


def test_filter_by_action_version_normalizes_the_leading_v_on_both_sides():
    kept, excluded = rc.filter_by_action_version([_scope_row("v3.5.0")], ["3.5.0"])
    assert len(kept) == 1
    assert excluded == {}
    kept, excluded = rc.filter_by_action_version([_scope_row("3.5.0")], ["v3.5.0"])
    assert len(kept) == 1
    assert excluded == {}


def test_filter_by_action_version_ignores_the_case_of_both_sides():
    """The unknown check is case-insensitive and so is the scope match."""
    kept, excluded = rc.filter_by_action_version([_scope_row("v3.5.0")], ["3.5.0"])
    assert len(kept) == 1
    assert excluded == {}
    kept, excluded = rc.filter_by_action_version([_scope_row("V3.5.0")], ["V3.5.0"])
    assert len(kept) == 1
    assert excluded == {}
    kept, excluded = rc.filter_by_action_version([_scope_row("UNKNOWN")], ["3.5.0"])
    assert kept == []
    assert excluded == {"action_version_unknown": 1}


def test_filter_by_action_version_keeps_the_publisher_spelling_in_the_row():
    """Only the comparison is normalized: the row keeps the publisher's spelling."""
    rows = [_version_row("v3.5.0")]
    assert rows[0]["action_version"] == "v3.5.0"
    kept, excluded = rc.filter_by_action_version(rows, ["3.5.0"])
    assert kept == rows
    assert kept[0]["action_version"] == "v3.5.0"
    assert excluded == {}


def test_filter_by_action_version_reports_only_the_reasons_that_occurred():
    rows = [_scope_row("3.5.0")]
    _kept, excluded = rc.filter_by_action_version(rows, ["3.5.0"])
    assert excluded == {}


def test_filter_by_action_version_scope_that_names_no_version_excludes_everything():
    """A requested scope that normalizes to nothing keeps no row."""
    rows = [_scope_row("3.5.0"), _scope_row("unknown")]
    kept, excluded = rc.filter_by_action_version(rows, ["v"])
    assert kept == []
    assert excluded == {"action_version_unknown": 1, "action_version_other": 1}


def test_filter_by_action_version_a_blank_scope_token_keeps_no_row():
    """A blank token normalizes to nothing, so it fails closed too."""
    rows = [_scope_row("3.5.0")]
    kept, excluded = rc.filter_by_action_version(rows, ["   "])
    assert kept == []
    assert excluded == {"action_version_other": 1}
    # A scope with no token at all is no scope.
    kept, excluded = rc.filter_by_action_version(rows, [])
    assert kept == rows
    assert excluded == {}


def test_operational_rollup_names_the_collected_total_not_the_scoped_count():
    """The prose names the collected population, the denominator the scoped one."""
    rows = rc.collect_rows(
        REPO, [_pull(1, HEAD, comments=[_comment(1, HEAD)])], [BOT]
    )
    rollup = rc.operational_rollup(
        rows,
        collected_total=7,
        action_versions=["3.5.0"],
        scope_excluded={"action_version_other": 2, "action_version_unknown": 1},
    )
    assert rollup["denominators"]["total_attempts"] == 1
    assert rollup["denominators"]["scoped_out_attempts"] == 3
    assert "1 eligible review attempts of 7 collected" in rollup["summary"]
    assert (
        "Excluded by the requested action-version scope: 3 attempts."
        in rollup["summary"]
    )


def test_operational_rollup_without_a_scope_names_no_scoped_out_attempts():
    rollup = rc.operational_rollup([])
    assert rollup["denominators"]["scoped_out_attempts"] == 0
    assert "Excluded by the requested action-version scope" not in rollup["summary"]


def test_build_report_reports_the_scope_it_applied():
    rows = [_version_row("v3.5.0"), _version_row("v3.4.1", pr=2, head=OTHER_HEAD)]
    kept, excluded = rc.filter_by_action_version(rows, ["3.5.0"])
    report = rc.build_report(
        kept,
        mode="offline",
        repos=[],
        truncated=False,
        action_versions=["3.5.0"],
        scope_excluded=excluded,
    )
    assert report["collection"]["scope"]["action_versions"] == ["3.5.0"]
    assert report["collection"]["scope"]["excluded"] == {"action_version_other": 1}
    assert report["operational_completion"]["denominators"]["scoped_out_attempts"] == 1
    assert (
        "Excluded by the requested action-version scope: 1 attempts."
        in report["operational_completion"]["summary"]
    )


def test_build_report_does_not_claim_a_scope_it_did_not_apply():
    """No scope token at all means no scope: none is reported or applied."""
    report = rc.build_report(
        [], mode="offline", repos=[], truncated=False, action_versions=[]
    )
    assert report["collection"]["scope"]["action_versions"] == []
    assert "Excluded by the requested action-version scope" not in (
        report["operational_completion"]["summary"]
    )


def test_build_report_names_a_scope_that_matched_nothing():
    """A scope that names no version is reported as applied and empty."""
    rows = [_version_row("v3.5.0")]
    kept, excluded = rc.filter_by_action_version(rows, ["v"])
    report = rc.build_report(
        kept,
        mode="offline",
        repos=[],
        truncated=False,
        action_versions=["v"],
        scope_excluded=excluded,
    )
    assert report["collection"]["scope"]["action_versions"] == [""]
    assert report["collection"]["scope"]["excluded"] == {"action_version_other": 1}
    assert report["rows"] == []
    assert (
        "Excluded by the requested action-version scope: 1 attempts."
        in report["operational_completion"]["summary"]
    )


# ---------------------------------------------------------------------------
# CLI offline mode
# ---------------------------------------------------------------------------


def _run_cli(argv, capsys):
    code = hrc.cli(argv)
    captured = capsys.readouterr()
    return code, captured


def test_cli_offline_success_condition_classifications(capsys):
    """The fixture's organic shapes classify exactly as the invariant demands."""
    code, captured = _run_cli(
        ["--from-json", str(FIXTURE), "--bot-login", BOT], capsys
    )
    assert code == 0
    report = json.loads(captured.out)
    by_link = {row["raw_link"].rsplit("-", 1)[-1]: row for row in report["rows"]}

    # (a) native APPROVED whose marker says partial → partial_or_abstained.
    assert by_link["201"]["disposition"] == "partial_or_abstained"
    # (c) comment-only clean sticky, no native event, no attestation →
    # unknown_missing_native (no comment-prose short circuit).
    assert by_link["301"]["disposition"] == "unknown_missing_native"
    # (d) marker missing entirely → unknown_no_marker (no
    # workflow-success short circuit from the check-run note).
    assert by_link["202"]["disposition"] == "unknown_no_marker"
    # (b) native APPROVED, complete marker, commit_id bound to head.
    assert by_link["101"]["disposition"] == "trusted_complete_approval"
    # (e) superseded head.
    assert by_link["401"]["superseded_head"] is True
    assert by_link["402"]["superseded_head"] is False
    # (f) head-bound attestation upgrades an otherwise-marker-complete row.
    assert by_link["302"]["disposition"] == "trusted_complete_approval"
    assert by_link["302"]["attestation_conclusion"] == "approved"

    assert report["collection"]["mode"] == "offline"
    assert report["correctness"]["missed_blockers"] == 1
    assert report["correctness"]["confirmed_blockers"] == 1
    assert report["correctness"]["false_blockers"] == 1
    assert report["correctness"]["adjudicated_heads"] == 3
    assert report["correctness"]["unknown_excluded"] == 0
    assert report["correctness"]["contradictory_excluded"] == 0
    # No raw body text ever reaches the report — only parsed bounded
    # fields and the HTML link.
    assert "No open findings" not in captured.out
    assert "ai-pr-review-sha:" not in captured.out
    assert "<!-- ai-pr-reviewer:" not in captured.out


def test_cli_offline_is_idempotent(capsys):
    code_a, captured_a = _run_cli(["--from-json", str(FIXTURE), "--bot-login", BOT], capsys)
    code_b, captured_b = _run_cli(["--from-json", str(FIXTURE), "--bot-login", BOT], capsys)
    assert code_a == code_b == 0
    assert captured_a.out == captured_b.out


def test_cli_offline_writes_out_file(tmp_path, capsys):
    out = tmp_path / "report.json"
    code, captured = _run_cli(
        ["--from-json", str(FIXTURE), "--bot-login", BOT, "--out", str(out)], capsys
    )
    assert code == 0
    report = json.loads(out.read_text(encoding="utf-8"))
    assert report["collection"]["mode"] == "offline"
    # The stdout line is a summary, not the report.
    assert "wrote" in captured.out


def test_cli_offline_adjudications_from_file(tmp_path, capsys):
    adjudications = tmp_path / "adj.json"
    adjudications.write_text(
        json.dumps([{"pr": 1579, "head_sha": "a" * 40, "label": "missed_blocker"}]),
        encoding="utf-8",
    )
    code, captured = _run_cli(
        ["--from-json", str(FIXTURE), "--bot-login", BOT,
         "--adjudications", str(adjudications)], capsys
    )
    assert code == 0
    report = json.loads(captured.out)
    # The explicit file replaces the fixture-embedded records; its single
    # record matches no collected head, so it is excluded.
    assert report["correctness"]["unknown_excluded"] == 1
    assert report["correctness"]["adjudicated_heads"] == 0
    assert report["correctness"]["precision"] is None


def test_cli_rejects_bad_inputs_without_echoing_values(capsys):
    code, captured = _run_cli(["--from-json", str(FIXTURE), "--repo", "bad repo"], capsys)
    assert code == 2
    assert "bad repo" not in captured.err
    assert "--repo" in captured.err

    code, captured = _run_cli(["--from-json", str(FIXTURE), "--since", "not-a-date"], capsys)
    assert code == 2
    assert "not-a-date" not in captured.err


@pytest.mark.parametrize(
    "token",
    ["", "../etc", "3.5.0; rm -rf /", "3.5.0/../x", "x" * 65],
)
def test_cli_rejects_a_bad_action_version_without_echoing_the_value(capsys, token):
    """A rejected version token is reported by field name only."""
    code, captured = _run_cli(
        ["--from-json", str(FIXTURE), "--bot-login", BOT, "--action-version", token],
        capsys,
    )
    assert code == 2
    if token:
        assert token not in captured.err
    assert "--action-version" in captured.err


def test_cli_accepts_a_version_token_with_an_optional_leading_v(capsys):
    for token in ("v3.5.0", "V3.5.0", "3.5.0"):
        code, _captured = _run_cli(
            ["--from-json", str(FIXTURE), "--bot-login", BOT, "--action-version", token],
            capsys,
        )
        assert code == 0


def test_cli_version_token_bound_is_the_published_version_bound(capsys):
    """A token longer than the published version bound is rejected.

    A published version is truncated at that bound, so a longer token
    could never match one.
    """
    assert rc.ACTION_VERSION_LIMIT == 32
    code, _captured = _run_cli(
        ["--from-json", str(FIXTURE), "--bot-login", BOT,
         "--action-version", "x" * (rc.ACTION_VERSION_LIMIT + 1)],
        capsys,
    )
    assert code == 2
    code, _captured = _run_cli(
        ["--from-json", str(FIXTURE), "--bot-login", BOT,
         "--action-version", "x" * rc.ACTION_VERSION_LIMIT],
        capsys,
    )
    assert code == 0


def test_cli_report_carries_the_scope_and_the_exclusion_counts(capsys):
    """The scope narrows the population before the rollups run."""
    code, captured = _run_cli(
        ["--from-json", str(FIXTURE), "--bot-login", BOT, "--action-version", "3.5.0"],
        capsys,
    )
    assert code == 0
    report = json.loads(captured.out)
    scope = report["collection"]["scope"]
    assert scope["action_versions"] == ["3.5.0"]
    # One row was published by v3.4.1 and one row carries no version.
    assert scope["excluded"] == {"action_version_other": 1, "action_version_unknown": 1}
    # Every denominator describes the scoped population.
    denominators = report["operational_completion"]["denominators"]
    assert denominators["total_attempts"] == 5
    assert denominators["scoped_out_attempts"] == 2
    assert len(report["rows"]) == 5
    # The kept rows are the ones the publisher wrote as v3.5.0.
    assert {row["action_version"] for row in report["rows"]} == {"v3.5.0"}
    # The prose names the collected population, not the scoped one.
    summary = report["operational_completion"]["summary"]
    assert "3 eligible review attempts of 7 collected" in summary
    assert "Excluded by the requested action-version scope: 2 attempts." in summary
    # The adjudication of the excluded PR 1579 row matches no scoped row.
    assert report["correctness"]["unknown_excluded"] == 1
    assert report["correctness"]["adjudicated_heads"] == 2
    assert report["correctness"]["confirmed_blockers"] == 1
    assert report["correctness"]["false_blockers"] == 1
    assert report["correctness"]["contradictory_excluded"] == 0
    assert report["correctness"]["precision"] == 0.5
    assert report["correctness"]["recall"] == 1.0


def test_cli_rejects_missing_repo_and_fixture(capsys):
    code, captured = _run_cli([], capsys)
    assert code == 2
    code, captured = _run_cli(["--from-json", "/nonexistent/fixture.json"], capsys)
    assert code == 2


def test_cli_offline_without_bot_login_still_reports(capsys):
    code, captured = _run_cli(["--from-json", str(FIXTURE)], capsys)
    assert code == 0
    report = json.loads(captured.out)
    # Without bot attribution, no row may claim trusted completion.
    assert report["operational_completion"]["by_disposition"].get(
        "trusted_complete_approval"
    ) is None


def test_live_collect_uses_only_configured_forge(monkeypatch):
    """Live mode reads through the forge capability and bounds its walks."""
    calls = []

    class FakeForge:
        token = ""

        def get_pages_report(self, path, params=None, per_page=100, max_pages=None):
            calls.append((path, params, per_page, max_pages))
            if path.endswith("/pulls"):
                return [
                    {"number": 1, "updated_at": "2026-11-01T00:00:00Z",
                     "head": {"sha": HEAD}},
                ], False
            return [], False

    monkeypatch.setattr(hrc, "default_forge", lambda: FakeForge())
    args = hrc.build_parser().parse_args(
        ["--repo", REPO, "--bot-login", BOT, "--max-prs", "5",
         "--max-pages", "3", "--per-page", "50"]
    )
    rows, names, truncated, attestations, adjudications = hrc.collect(args, FakeForge())
    assert names == [REPO]
    assert truncated is False
    assert rows == []
    pulls_call = calls[0]
    assert pulls_call[0] == f"/repos/{REPO}/pulls"
    assert pulls_call[1]["sort"] == "updated"
    assert pulls_call[2] == 50
    assert pulls_call[3] == 3
    assert len(calls) == 3  # pulls + reviews + comments for the one PR


def test_live_collect_stops_at_max_prs(monkeypatch):
    class FakeForge:
        token = ""

        def get_pages_report(self, path, params=None, per_page=100, max_pages=None):
            if path.endswith("/pulls"):
                pulls = [
                    {"number": n, "updated_at": f"2026-11-0{n}T00:00:00Z",
                     "head": {"sha": HEAD}}
                    for n in range(1, 6)
                ]
                return pulls, True
            return [], False

    args = hrc.build_parser().parse_args(
        ["--repo", REPO, "--bot-login", BOT, "--max-prs", "2"]
    )
    _rows, _names, truncated, _att, _adj = hrc.collect(args, FakeForge())
    assert truncated is True


def test_live_collect_since_stops_the_walk(monkeypatch):
    seen = []

    class FakeForge:
        token = ""

        def get_pages_report(self, path, params=None, per_page=100, max_pages=None):
            if path.endswith("/pulls"):
                pulls = [
                    {"number": 1, "updated_at": "2026-11-05T00:00:00Z", "head": {"sha": HEAD}},
                    {"number": 2, "updated_at": "2026-10-01T00:00:00Z", "head": {"sha": HEAD}},
                    {"number": 3, "updated_at": "2026-09-01T00:00:00Z", "head": {"sha": HEAD}},
                ]
                seen.append(len(pulls))
                return pulls, False
            return [], False

    args = hrc.build_parser().parse_args(
        ["--repo", REPO, "--bot-login", BOT, "--since", "2026-11-01"]
    )
    _rows, _names, truncated, _att, _adj = hrc.collect(args, FakeForge())
    assert truncated is False
    # The walk must have stopped at the PR older than --since: only PR 1
    # was collected and hydrated (one pulls read + its two detail reads).
    assert seen == [3]


def test_emit_report_refuses_reflected_credential(tmp_path, capsys):
    report = {"rows": [{"head_sha": "tok" + "x" * 61}], "collection": {"mode": "offline"}}
    with pytest.raises(hrc.HarvestError):
        hrc.emit_report(report, None, "tok")


def test_fetch_repo_pulls_until_filters_newer_than_ceiling():
    class FakeForge:
        token = ""

        def get_pages_report(self, path, params=None, per_page=100, max_pages=None):
            return [
                {"number": 1, "updated_at": "2026-12-01T00:00:00Z", "head": {"sha": HEAD}},
                {"number": 2, "updated_at": "2026-10-01T00:00:00Z", "head": {"sha": HEAD}},
            ], False

    pulls, truncated = hrc.fetch_repo_pulls(
        FakeForge(), REPO, since_floor="2026-09-01T00:00:00Z",
        until_ceiling="2026-11-30T23:59:59Z", max_prs=10, per_page=100, max_pages=20,
    )
    assert [p["number"] for p in pulls] == [2]
    assert truncated is False


# ---------------------------------------------------------------------------
# No-mutation regression
# ---------------------------------------------------------------------------

# The only read paths the collector may request.
_ALLOWED_READ_PATHS = (
    re.compile(r"\A/repos/[^/]+/[^/]+/pulls\Z"),
    re.compile(r"\A/repos/[^/]+/[^/]+/pulls/[0-9]+/reviews\Z"),
    re.compile(r"\A/repos/[^/]+/[^/]+/issues/[0-9]+/comments\Z"),
)

# Network-capable modules the collector may never import: the core stays
# pure, and the CLI reaches the forge only through pr_reviewer.forge.
_NETWORK_MODULES = ("urllib", "http", "socket", "ssl", "requests", "httpx")

# A mutating HTTP method call, whatever the receiver happens to be
# called: the guard must not depend on a variable name.
_MUTATING_CALL_RE = re.compile(r"\b(?:post|delete|patch|put)\s*\(", re.IGNORECASE)


def _collector_sources():
    """The two collector files the no-mutation guards cover."""
    return (
        SCRIPTS_DIR / "harvest_review_completion.py",
        ROOT / "pr_reviewer" / "review_completion.py",
    )


class _RecordingForge:
    """A fake forge that records every request and refuses a mutation.

    The read-only property of the collector comes from its own code, not
    from the forge module, so the fake is the boundary that fails the
    test: any path outside the three allowed read shapes raises, and a
    mutating verb raises even if the collector asked for one.
    """

    token = ""

    def __init__(self):
        self.paths = []
        self.verbs = []

    def _record(self, path, verb):
        self.paths.append(path)
        self.verbs.append(verb)
        if not any(pattern.match(path) for pattern in _ALLOWED_READ_PATHS):
            raise AssertionError(f"unexpected forge path: {path}")

    def get(self, path, params=None):
        self._record(path, "GET")
        return []

    def get_pages(self, path, params=None, per_page=100, max_pages=None):
        self._record(path, "GET")
        return []

    def get_pages_report(self, path, params=None, per_page=100, max_pages=None):
        self._record(path, "GET")
        if path.endswith("/pulls"):
            return [
                {"number": 1, "updated_at": "2026-11-01T00:00:00Z",
                 "head": {"sha": HEAD}},
            ], False
        return [], False

    def post(self, path, payload=None):
        raise AssertionError("the collector must never post to the forge")

    def delete(self, path):
        raise AssertionError("the collector must never delete from the forge")


def test_live_collection_requests_only_the_allowed_read_paths():
    client = _RecordingForge()
    args = hrc.build_parser().parse_args(["--repo", REPO, "--bot-login", BOT])
    hrc.collect(args, client)

    assert client.paths
    for path, verb in zip(client.paths, client.verbs):
        assert verb == "GET"
        assert any(pattern.match(path) for pattern in _ALLOWED_READ_PATHS)
    assert client.paths[0] == f"/repos/{REPO}/pulls"
    assert f"/repos/{REPO}/pulls/1/reviews" in client.paths
    assert f"/repos/{REPO}/issues/1/comments" in client.paths


def test_live_main_reads_only_the_allowed_read_paths(monkeypatch):
    """The real entry point drives the forge, and it only reads.

    The fake is installed as the CLI's own forge capability, so this
    covers the whole live path (argument handling, collection, scope
    filter, report) rather than one internal call.
    """
    client = _RecordingForge()
    monkeypatch.setattr(hrc, "default_forge", lambda: client)
    code = hrc.main(["--repo", REPO, "--bot-login", BOT])
    assert code == 0

    assert client.paths
    for path, verb in zip(client.paths, client.verbs):
        assert verb == "GET"
        assert any(pattern.match(path) for pattern in _ALLOWED_READ_PATHS)
    assert client.paths[0] == f"/repos/{REPO}/pulls"
    assert f"/repos/{REPO}/pulls/1/reviews" in client.paths
    assert f"/repos/{REPO}/issues/1/comments" in client.paths


def test_collector_sources_cannot_mutate_the_forge():
    """A source-level guard over the collector only, not the forge module."""
    for path in _collector_sources():
        source = path.read_text(encoding="utf-8")
        assert not _MUTATING_CALL_RE.search(source), (
            f"{path.name} calls a mutating HTTP method"
        )
        assert "urlopen" not in source, f"{path.name} opens a URL itself"
        assert "1563" not in source, f"{path.name} names the tracking issue"


def test_collector_sources_import_no_network_module():
    """The core stays pure and the CLI reaches the forge only through the capability."""
    for path in _collector_sources():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                continue
            for name in names:
                root = name.split(".")[0]
                assert root not in _NETWORK_MODULES, f"{path.name} imports {name}"


def test_report_states_the_unobservable_attempt_policy():
    report = rc.build_report([], mode="offline", repos=[], truncated=False)
    assert report["collection"]["policy"]["unobservable_attempts"] == [
        "canceled_job",
        "never_run",
        "skipped_run",
    ]


def test_operational_summary_states_the_unobservable_attempt_policy():
    rollup = rc.operational_rollup([])
    assert (
        "Attempts that published nothing (canceled or never-run jobs) are not "
        "counted: this collector reads published artifacts only."
    ) in rollup["summary"]
