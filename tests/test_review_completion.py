"""Tests for the review-completion harvester (#1602): pr_reviewer/review_completion.py and scripts/harvest_review_completion.py.

Fully offline: no network access. The CLI is exercised through its
``--from-json`` offline mode against the organic fixture, which replays
the same records the forge reads would return.
"""

from __future__ import annotations

import json
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


def _marker(head_sha=HEAD, base_sha=BASE, review_result="clean", **extra):
    payload = {"version": 1, "head_sha": head_sha, "base_sha": base_sha, "review_result": review_result}
    payload.update(extra)
    return (
        "<!-- ai-pr-reviewer -->\n"
        f"<!-- ai-pr-reviewer:{json.dumps(payload, separators=(',', ':'))} -->\n"
        "_Analysis engine: claude-code · pr-reviewer-action 3.5.0_\n\nreview body"
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
    body = "_Analysis engine: claude-code · pr-reviewer-action 3.4.1_\n\nprose"
    assert rc.parse_action_version(body) == "3.4.1"


def test_parse_action_version_absent_is_unknown():
    assert rc.parse_action_version("just prose, no engine line") == "unknown"
    assert rc.parse_action_version("") == "unknown"
    # An engine line without a version token stays unknown, never a guess.
    assert rc.parse_action_version("_Analysis engine: claude-code_") == "unknown"


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
        "_Analysis engine: claude-code · pr-reviewer-action 3.5.0_"
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


def test_clean_marker_with_bound_native_approval_is_trusted():
    rows = rc.collect_rows(REPO, [_pull(1, HEAD, reviews=[_review(1, HEAD, "APPROVED")])], [BOT])
    assert rows[0]["disposition"] == "trusted_complete_approval"
    assert rows[0]["native_event"] == "APPROVED"
    assert rows[0]["native_event_bound"] is True


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
    assert row["action_version"] == "3.5.0"
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
    rows = _sample_rows()
    adjudications = [
        {"pr": 1, "head_sha": HEAD, "label": "missed_blocker"},
        {"pr": 1, "head_sha": HEAD, "label": "false_blocker"},
        {"pr": 99, "head_sha": OTHER_HEAD, "label": "missed_blocker"},  # unmatched
        {"pr": 2, "head_sha": OTHER_HEAD, "label": "unsure"},  # unknown label
    ]
    rollup = rc.correctness_rollup(rows, adjudications)
    assert rollup["missed_blockers"] == 1
    assert rollup["false_blockers"] == 1
    assert rollup["adjudicated_total"] == 2
    assert rollup["unknown_excluded"] == 2
    assert rollup["precision"] == 0.5
    assert rollup["recall"] == 0.5


def test_correctness_rollup_empty_is_none_not_zero():
    rollup = rc.correctness_rollup(_sample_rows(), [])
    assert rollup["adjudicated_total"] == 0
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
        assert rollup["adjudicated_total"] == 0
        assert rollup["missed_blockers"] == 0
        assert rollup["false_blockers"] == 0
        assert rollup["unknown_excluded"] == 1


def test_correctness_rollup_ignores_unlabeled_sources():
    """No adjudications means no correctness numbers at all."""
    rollup = rc.correctness_rollup(_sample_rows(), None)
    assert rollup["adjudicated_total"] == 0
    assert rollup["precision"] is None


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
    assert report["correctness"]["false_blockers"] == 1
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
    assert report["correctness"]["adjudicated_total"] == 0
    assert report["correctness"]["precision"] is None


def test_cli_rejects_bad_inputs_without_echoing_values(capsys):
    code, captured = _run_cli(["--from-json", str(FIXTURE), "--repo", "bad repo"], capsys)
    assert code == 2
    assert "bad repo" not in captured.err
    assert "--repo" in captured.err

    code, captured = _run_cli(["--from-json", str(FIXTURE), "--since", "not-a-date"], capsys)
    assert code == 2
    assert "not-a-date" not in captured.err


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