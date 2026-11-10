"""Organic review-completion metrics from published markers (#1602).

Pure core for the review-completion harvester: marker/body parsing, row
normalization, disposition classification, and rollup computation. The
module is stdlib-only and does no I/O — the CLI
(``scripts/harvest_review_completion.py``) supplies the records, either
read fresh from the configured forge capability or replayed from an
offline fixture.

The collector is read-only and offline-analyzable: it harvests what the
action already published (the ``ai-pr-reviewer`` metadata marker, the
``_Analysis engine: ... · pr-reviewer-action vX.Y.Z_`` body line, native
review events) into one normalized row per eligible (head, review
attempt). It never re-runs a model, never schedules anything, and never
derives correctness from merge state, CI green, comment resolution, or
model prose — model verdict text is recorded as an untrusted claim
(``verdict_prose``) and never gates a disposition.

The metric invariant (#1602): ``trusted_complete_approval`` requires ALL
of a marker with a usable ``head_sha``, ``review_result == "clean"``, no
partial/unknown ``coverage``, ``required_checks`` not ``incomplete``, AND
proven native evidence — a native APPROVED event by a configured bot
login whose ``commit_id`` equals the row's head, or a head-bound
attestation with ``conclusion == "approved"``. A model approve-prose
claim plus ``review_result: partial`` is never trusted; a native APPROVED
over partial/unknown coverage is ``partial_or_abstained``; with neither
native approval nor attestation the row is ``unknown_missing_native``.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

from pr_reviewer.metadata import parse_metadata

# The published body line format (``src/publish/publish.ts``, body build):
# ``_Analysis engine: <engine> · pr-reviewer-action <version>_``. The
# version token is captured up to the closing underscore/whitespace.
_ACTION_VERSION_RE = re.compile(
    r"_Analysis engine:[^_\n]*·\s*pr-reviewer-action\s+([^\s_]+)_"
)

# The action-owned skip note (``src/run/action.ts`` step-summary and
# carry-label shape). A carried skip is only ever concluded when the
# body's own header/note says so — never inferred from absence of signal.
_SKIP_NOTE_RE = re.compile(r"\*\*AI PR Review skipped:\*\*")

# Marker ``head_sha`` values that do not bind the marker to a head.
_UNBOUND_HEAD = ("", "unknown")

# Native review events this collector records. Anything else is recorded
# as null rather than echoed verbatim (bounded vocabulary, like the
# marker's own enums).
NATIVE_EVENTS = ("APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED")

# Disposition taxonomy (per-row, mutually exclusive).
DISPOSITION_SKIPPED = "skipped"
DISPOSITION_TRUSTED_COMPLETE_APPROVAL = "trusted_complete_approval"
DISPOSITION_COMPLETE_FINDINGS = "complete_findings"
DISPOSITION_PARTIAL_OR_ABSTAINED = "partial_or_abstained"
DISPOSITION_FAILED_OR_UNAVAILABLE = "failed_or_unavailable"
DISPOSITION_UNKNOWN_NO_MARKER = "unknown_no_marker"
DISPOSITION_UNKNOWN_MISSING_NATIVE = "unknown_missing_native"

# Dispositions whose telemetry is unknown or missing outright.
_UNKNOWN_OR_MISSING = (
    DISPOSITION_UNKNOWN_NO_MARKER,
    DISPOSITION_UNKNOWN_MISSING_NATIVE,
    DISPOSITION_FAILED_OR_UNAVAILABLE,
)

# Coverage values that make a run's completion unsafe to trust.
_UNTRUSTED_COVERAGE = ("partial", "unknown")

# Marker keys consulted for the model verdict prose claim, in order. The
# value is recorded as an untrusted claim only; no disposition treats it
# as evidence.
_VERDICT_KEYS = ("verdict", "native_verdict", "carried_verdict")

# Every string field in a row and in the report is bounded, so a hostile
# body cannot blow up the report through a parsed field.
_FIELD_LIMIT = 200
_HEAD_LIMIT = 64
_LINK_LIMIT = 300
_VERSION_LIMIT = 32


def bound(value: Any, limit: int = _FIELD_LIMIT) -> str | None:
    """``value`` as a bounded string, or ``None`` when not a usable string.

    Every forge-supplied or body-derived string passes through here before
    it enters a row or the report: control bytes are not specially
    handled, but length is capped, and non-string values (numbers a
    hostile forge put in a string field, ``None``) become ``None`` rather
    than being str-verbatim into the report.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    return text[:limit]


def parse_action_version(body: str) -> str:
    """The ``pr-reviewer-action vX.Y.Z`` version from the body's engine line.

    The line is action-owned (built in ``src/publish/publish.ts``), so the
    parsed token is trusted as a version label. ``"unknown"`` when the
    line is absent or carries no version — never a guess from prose.
    """
    match = _ACTION_VERSION_RE.search(body or "")
    if not match:
        return "unknown"
    return match.group(1)[:_VERSION_LIMIT] or "unknown"


def body_indicates_skip(body: str) -> bool:
    """True when the body's own header/note says the run was a skip.

    The action writes ``**AI PR Review skipped:** <reason>`` for skipped
    runs; a carried skip is concluded only from that note, never from a
    missing signal (a missing signal is ``unknown_no_marker``).
    """
    return bool(_SKIP_NOTE_RE.search(body or ""))


def _usable_head(sha: Any) -> bool:
    """True when a marker/commit SHA actually binds to a head.

    The invariant's letter: not empty and not the literal ``unknown``
    sentinel the publisher writes when the head could not be resolved.
    ``_UNBOUND_HEAD`` is that sentinel set, so the check and the
    vocabulary it consults stay in one place.
    """
    text = sha.strip().lower() if isinstance(sha, str) else ""
    return text not in _UNBOUND_HEAD


def _head_has_native_approval(head_sha: str, bot_reviews: list[dict[str, Any]]) -> bool:
    """True when a bot native review APPROVED exactly this head.

    ``bot_reviews`` holds the PR's native review records authored by the
    configured bot logins. Proven native evidence requires a non-null
    ``commit_id`` string-equal to the row's head — a bot APPROVED bound to
    a different head is not evidence for this row.
    """
    if not _usable_head(head_sha):
        return False
    for review in bot_reviews:
        if review.get("state") != "APPROVED":
            continue
        commit_id = review.get("commit_id")
        if isinstance(commit_id, str) and commit_id and commit_id == head_sha:
            return True
    return False


def _marker_str(marker: dict[str, Any], key: str) -> str:
    """Marker field as a bounded lowercase string, or ``""``.

    A hostile or self-hosted forge can put any JSON value in a marker
    field (a dict, a list, a number); the disposition logic must survive
    that, not crash on it. Anything that is not a usable string is ``""``
    — which classifies fail-closed (an unknown ``review_result`` never
    reads as clean).
    """
    value = marker.get(key)
    if not isinstance(value, str):
        return ""
    return value.strip().lower()[:_FIELD_LIMIT]


def _login_of(record: dict[str, Any]) -> str:
    """The record's ``user.login`` as a bounded lowercase string, or ``""``.

    Same hostile-shape rule as :func:`_marker_str`: a string ``user`` or a
    numeric ``login`` is data, not a crash.
    """
    user = record.get("user")
    if not isinstance(user, dict):
        return ""
    login = user.get("login")
    if not isinstance(login, str):
        return ""
    return login.strip().lower()[:_FIELD_LIMIT]


def _marker_verdict_prose(marker: dict[str, Any]) -> str | None:
    """The model verdict text claim from the marker, or ``None``.

    Consulted keys are bounded and the value is never trusted: it is
    recorded so a report reader can see what the model claimed, while the
    disposition logic ignores it entirely.
    """
    for key in _VERDICT_KEYS:
        value = marker.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:_FIELD_LIMIT]
    return None


def classify_disposition(
    marker: dict[str, Any] | None,
    body: str,
    native_approved: bool,
    attestation_conclusion: str | None,
) -> str:
    """The row's disposition, per the #1602 taxonomy and metric invariant.

    Order matters and is total: no-marker first (the default heuristic —
    nothing about a missing marker is ever upgraded), then the explicit
    skip note, then the incomplete/unsafe-telemetry gate (``partial`` or
    unknown coverage, incomplete required checks, an unbound marker
    head), then the clean path that REQUIRES proven native or attestation
    evidence, then completed findings, then a marker with no usable
    ``review_result`` at all.
    """
    if marker is None:
        return DISPOSITION_UNKNOWN_NO_MARKER
    if body_indicates_skip(body):
        return DISPOSITION_SKIPPED
    review_result = _marker_str(marker, "review_result")
    head = marker.get("head_sha") if isinstance(marker.get("head_sha"), str) else ""
    coverage = _marker_str(marker, "coverage")
    required_checks = _marker_str(marker, "required_checks")
    if (
        review_result == "partial"
        or coverage in _UNTRUSTED_COVERAGE
        or required_checks == "incomplete"
        or not _usable_head(head)
    ):
        # Incomplete/unsafe telemetry: even a native APPROVED or a model
        # approve-prose claim over this state is never a trusted approval.
        return DISPOSITION_PARTIAL_OR_ABSTAINED
    if review_result == "clean":
        attested_approved = isinstance(attestation_conclusion, str) and (
            attestation_conclusion.strip().lower() == "approved"
        )
        if native_approved or attested_approved:
            return DISPOSITION_TRUSTED_COMPLETE_APPROVAL
        # No comment-prose short circuit: a clean marker without proven
        # native or attested approval stays unknown.
        return DISPOSITION_UNKNOWN_MISSING_NATIVE
    if review_result in ("findings", "issues"):
        return DISPOSITION_COMPLETE_FINDINGS
    return DISPOSITION_FAILED_OR_UNAVAILABLE


def _normalize_attempt(
    repo: str,
    pr_number: int,
    pr_head_sha: str,
    attempt: dict[str, Any],
    bot_reviews: list[dict[str, Any]],
) -> dict[str, Any]:
    """One normalized row from one bot-authored review/comment record.

    ``attempt`` carries the bounded record facts the caller extracted:
    ``source`` (``native_review`` | ``comment``), ``review_id`` (native
    review id, or ``None`` for a sticky comment), ``record_id`` (the
    native review id or comment id, used for dedupe and rerun linking),
    ``login``, ``body``, ``created_at``, ``html_url``, and for native
    reviews ``state`` and ``commit_id``. Raw bodies never reach the row —
    only parsed, bounded fields and the HTML link do.
    """
    body = attempt.get("body") if isinstance(attempt.get("body"), str) else ""
    marker = parse_metadata(body)
    source = attempt.get("source")
    commit_id = attempt.get("commit_id")
    state = attempt.get("state")
    marker_head = marker.get("head_sha") if isinstance(marker, dict) else None

    if source == "native_review" and isinstance(commit_id, str) and commit_id.strip():
        head_sha = commit_id.strip()[:_HEAD_LIMIT]
    elif isinstance(marker_head, str) and _usable_head(marker_head):
        head_sha = marker_head.strip()[:_HEAD_LIMIT]
    else:
        head_sha = ""

    native_approved = _head_has_native_approval(head_sha, bot_reviews)

    # Native event attribution. A native review row reports its own event;
    # a comment row reports the head's proven bot APPROVED when one
    # exists (the same evidence the disposition consumes) and nothing
    # otherwise — comment prose is never an event.
    if source == "native_review":
        state_text = state if isinstance(state, str) else ""
        event = state_text.upper() if state_text.upper() in NATIVE_EVENTS else None
        event_bound = bool(
            event is not None
            and isinstance(commit_id, str)
            and bool(commit_id.strip())
            and commit_id == head_sha
        )
    else:
        event = "APPROVED" if native_approved else None
        event_bound = event == "APPROVED"

    attestation_conclusion = attempt.get("attestation_conclusion")
    attestation_reason = attempt.get("attestation_reason_code")

    disposition = classify_disposition(
        marker, body, native_approved, attestation_conclusion
    )

    row: dict[str, Any] = {
        "repo": repo,
        "pr": pr_number,
        "head_sha": head_sha,
        "review_id": attempt.get("review_id") if isinstance(attempt.get("review_id"), int) else None,
        "source": source if source in ("native_review", "comment") else None,
        "created_at": bound(attempt.get("created_at"), _HEAD_LIMIT),
        "action_version": parse_action_version(body),
        "review_result": _marker_str(marker, "review_result") if marker else None,
        "coverage": _marker_str(marker, "coverage") if marker else None,
        "required_checks": _marker_str(marker, "required_checks") if marker else None,
        "incomplete_reason": _marker_str(marker, "incomplete_reason") if marker else None,
        "tool_stop_reason": _marker_str(marker, "tool_stop_reason") if marker else None,
        "review_route": _marker_str(marker, "review_route") if marker else None,
        "verdict_prose": _marker_verdict_prose(marker) if marker else None,
        "native_event": event,
        "native_event_bound": event_bound,
        "attestation_conclusion": (
            bound(attestation_conclusion, _HEAD_LIMIT) if attestation_conclusion else None
        ),
        "attestation_reason_code": (
            bound(attestation_reason, _FIELD_LIMIT) if attestation_reason else None
        ),
        "disposition": disposition,
        "superseded_head": bool(
            _usable_head(pr_head_sha)
            and _usable_head(head_sha)
            and head_sha != pr_head_sha
        ),
        "rerun_of": None,
        "raw_link": bound(attempt.get("html_url"), _LINK_LIMIT),
    }
    return row


def _attempt_sort_key(attempt: dict[str, Any]) -> tuple:
    """Deterministic attempt order: time, then source, then record id."""
    return (
        attempt.get("created_at") or "",
        attempt.get("source") or "",
        attempt.get("record_id") or 0,
    )


def _dedupe_key(row: dict[str, Any], record_id: int | None) -> tuple:
    """Idempotency key for one row.

    The #1602 letter is ``(repo, pr, review_id, head_sha)``; a sticky
    comment has no native review id, so its own comment id stands in for
    ``review_id`` in that slot — distinct comment attempts at one head
    stay distinct rows while a re-run over the same records reproduces
    exactly the same keys.
    """
    review_id = row["review_id"] if row["review_id"] is not None else record_id
    return (row["repo"], row["pr"], review_id, row["head_sha"])


def _link_reruns(rows: list[dict[str, Any]], record_ids: dict[tuple, int | None]) -> None:
    """Set ``rerun_of`` to the prior attempt's id at the same head.

    Prior means earlier in the deterministic attempt order and only within
    the same source kind: a sticky comment rerunning under a native review
    is a publication-mode change, not a rerun of the same surface.
    """
    seen: dict[tuple[str, str, str], list[tuple[str, Any]]] = {}
    for row in rows:
        key = (row["repo"], str(row["pr"]), row["source"] or "")
        prior = seen.get(key, [])
        row["rerun_of"] = None
        if row["head_sha"]:
            # Only a prior attempt at the SAME head links: a newer head is
            # supersession (``superseded_head``), not a rerun.
            for head, prior_id in reversed(prior):
                if head == row["head_sha"]:
                    row["rerun_of"] = prior_id
                    break
            prior.append((row["head_sha"], record_ids.get(_row_record_key(row))))
            seen[key] = prior


def _row_record_key(row: dict[str, Any]) -> tuple:
    """Positional identity of a row within its collection pass."""
    return (row["repo"], row["pr"], row["source"], row["created_at"], row["review_id"],
            row["raw_link"])


def collect_rows(
    repo: str,
    pulls: Iterable[dict[str, Any]],
    bot_logins: Iterable[str],
    attestations: Iterable[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Normalized rows for every eligible (head, review attempt) in ``pulls``.

    ``pulls`` yields one record per PR: ``number``, ``head_sha`` (the PR
    head at collection time), ``reviews`` (native review records) and
    ``comments`` (issue-comment records). Only records authored by a
    configured bot login become rows; everyone else's reviews and comments
    are other people's signals, not this collector's attempts.

    Attestation records (``{"conclusion", "reason_code", "head_sha"}``)
    are attached per head as additional trusted evidence only; they never
    override a row's own marker fields.
    """
    bots_lower = {login.strip().lower() for login in bot_logins if isinstance(login, str) and login.strip()}

    attested: dict[str, dict[str, Any]] = {}
    for record in attestations or []:
        if not isinstance(record, dict):
            continue
        head = record.get("head_sha")
        if isinstance(head, str) and _usable_head(head):
            attested[head.strip()] = record

    rows: list[dict[str, Any]] = []
    record_ids: dict[tuple, int | None] = {}
    for pull in pulls:
        if not isinstance(pull, dict):
            continue
        number = pull.get("number")
        if not isinstance(number, int) or isinstance(number, bool):
            continue
        pr_head = pull.get("head_sha")
        pr_head = pr_head.strip()[:_HEAD_LIMIT] if isinstance(pr_head, str) else ""

        reviews = [r for r in (pull.get("reviews") or []) if isinstance(r, dict)]
        bot_reviews = [r for r in reviews if _login_of(r) in bots_lower]
        comments = [c for c in (pull.get("comments") or []) if isinstance(c, dict)]

        attempts: list[dict[str, Any]] = []
        for review in bot_reviews:
            login = _login_of(review)
            if login not in bots_lower:
                continue
            review_id = review.get("id")
            attempts.append(
                {
                    "source": "native_review",
                    "review_id": review_id if isinstance(review_id, int) and not isinstance(review_id, bool) else None,
                    "record_id": review_id if isinstance(review_id, int) and not isinstance(review_id, bool) else None,
                    "login": login,
                    "body": review.get("body") if isinstance(review.get("body"), str) else "",
                    "created_at": review.get("submitted_at") if isinstance(review.get("submitted_at"), str) else "",
                    "html_url": review.get("html_url"),
                    "state": review.get("state"),
                    "commit_id": review.get("commit_id") if isinstance(review.get("commit_id"), str) else None,
                }
            )
        for comment in comments:
            login = _login_of(comment)
            if login not in bots_lower:
                continue
            comment_id = comment.get("id")
            record_id = comment_id if isinstance(comment_id, int) and not isinstance(comment_id, bool) else None
            attempts.append(
                {
                    "source": "comment",
                    "review_id": None,
                    "record_id": record_id,
                    "login": login,
                    "body": comment.get("body") if isinstance(comment.get("body"), str) else "",
                    "created_at": comment.get("created_at") if isinstance(comment.get("created_at"), str) else "",
                    "html_url": comment.get("html_url"),
                    "state": None,
                    "commit_id": None,
                }
            )

        attempts.sort(key=_attempt_sort_key)
        for attempt in attempts:
            head = attempt.get("commit_id")
            if attempt["source"] == "comment":
                marker_probe = parse_metadata(attempt.get("body") or "")
                probe_head = marker_probe.get("head_sha") if isinstance(marker_probe, dict) else None
                head = probe_head if isinstance(probe_head, str) and _usable_head(probe_head) else ""
            attestation = attested.get(head) if isinstance(head, str) else None
            if attestation is not None:
                attempt["attestation_conclusion"] = attestation.get("conclusion")
                attempt["attestation_reason_code"] = attestation.get("reason_code")
            row = _normalize_attempt(repo, number, pr_head, attempt, bot_reviews)
            record_ids[_row_record_key(row)] = attempt.get("record_id")
            rows.append(row)

    # Idempotent dedupe: a re-run over the same records yields the same
    # keys, so replaying a collection pass never doubles rows.
    deduped: list[dict[str, Any]] = []
    seen_keys: set[tuple] = set()
    for row in rows:
        key = _dedupe_key(row, record_ids.get(_row_record_key(row)))
        if key in seen_keys:
            continue
        seen_keys.add(key)
        deduped.append(row)

    _link_reruns(deduped, record_ids)
    return deduped


def _counts(values: Iterable[str | None], absent_label: str = "absent") -> dict[str, int]:
    """Count occurrences of bounded values; ``None`` buckets under a label."""
    result: dict[str, int] = {}
    for value in values:
        key = value if value else absent_label
        result[key] = result.get(key, 0) + 1
    return dict(sorted(result.items()))


def operational_rollup(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """The ``operational_completion`` rollup over normalized rows.

    Counts review attempts by disposition with breakdowns by the marker's
    own telemetry fields. The summary states denominators in prose: a
    small sample is a count, never proof of a completion rate.
    """
    total = len(rows)
    eligible = [row for row in rows if not row["superseded_head"]]
    with_marker = [row for row in rows if row["review_result"] is not None]
    with_native = [row for row in rows if row["native_event"] is not None]
    unknown_or_missing = [row for row in rows if row["disposition"] in _UNKNOWN_OR_MISSING]

    return {
        "summary": (
            f"{len(eligible)} eligible review attempts of {total} collected "
            f"({len(with_marker)} with a marker, {len(with_native)} with a native "
            f"event, {len(unknown_or_missing)} with unknown/missing telemetry). "
            "These are denominators and counts, not proof of a completion rate."
        ),
        "by_disposition": _counts(row["disposition"] for row in rows),
        # The same breakdown over eligible (non-superseded) rows only, so
        # a rate computed against ``denominators.eligible_attempts`` uses
        # a matching numerator: ``by_disposition`` counts every row
        # including superseded heads, this one does not.
        "eligible_by_disposition": _counts(row["disposition"] for row in eligible),
        "by_incomplete_reason": _counts(row["incomplete_reason"] for row in rows),
        "by_required_checks": _counts(row["required_checks"] for row in rows),
        "by_tool_stop_reason": _counts(row["tool_stop_reason"] for row in rows),
        # The review route's fallback is ``legacy`` — an absent marker
        # route value means the legacy route, so the breakdown buckets it
        # under its real name rather than an "absent" bucket.
        "by_review_route": _counts(
            (row["review_route"] or "legacy") for row in rows
        ),
        "by_action_version": _counts(row["action_version"] for row in rows),
        "denominators": {
            "total_attempts": total,
            "eligible_attempts": len(eligible),
            "attempts_with_marker": len(with_marker),
            "attempts_with_native_event": len(with_native),
            "attempts_with_unknown_or_missing_telemetry": len(unknown_or_missing),
        },
        "missing_data": {
            "no_marker": sum(
                1 for row in rows if row["disposition"] == DISPOSITION_UNKNOWN_NO_MARKER
            ),
            "native_missing": sum(
                1 for row in rows if row["disposition"] == DISPOSITION_UNKNOWN_MISSING_NATIVE
            ),
            "unknown_head_sha": sum(
                1 for row in rows if not _usable_head(row["head_sha"])
            ),
        },
    }


# Adjudication labels this rollup understands. Anything else is a human
# label the collector does not interpret; it is excluded from the
# precision/recall denominators and counted, never silently dropped.
_LABEL_MISSED_BLOCKER = "missed_blocker"
_LABEL_FALSE_BLOCKER = "false_blocker"
_KNOWN_LABELS = (_LABEL_MISSED_BLOCKER, _LABEL_FALSE_BLOCKER)


def correctness_rollup(
    rows: list[dict[str, Any]], adjudications: Iterable[dict[str, Any]] | None
) -> dict[str, Any]:
    """The ``correctness`` rollup — human adjudication labels only.

    Correctness comes exclusively from ``--adjudications`` records
    (``{"pr", "head_sha", "label"}``) matched to collected rows by
    ``(pr, head_sha)``. It is never inferred from comments resolved,
    merge state, CI green, or model agreement. Labels outside the known
    pair are excluded from the precision/recall denominators and counted
    as ``unknown_excluded``.
    """
    row_keys = {(row["pr"], row["head_sha"]) for row in rows if row["head_sha"]}
    missed = 0
    false_blockers = 0
    unknown_excluded = 0
    adjudicated_total = 0
    for record in adjudications or []:
        if not isinstance(record, dict):
            continue
        label = record.get("label")
        key = (record.get("pr"), record.get("head_sha"))
        if key not in row_keys:
            # An adjudication naming an attempt this pass did not collect
            # is not evidence about a collected row; it is excluded.
            unknown_excluded += 1
            continue
        if label not in _KNOWN_LABELS:
            # A human label this rollup does not interpret: excluded from
            # the precision/recall denominators and counted, never dropped.
            unknown_excluded += 1
            continue
        if label == _LABEL_MISSED_BLOCKER:
            missed += 1
        else:
            false_blockers += 1
        adjudicated_total += 1

    precision: float | None = None
    recall: float | None = None
    if adjudicated_total > 0:
        precision = round(1 - false_blockers / adjudicated_total, 4)
        recall = round(1 - missed / adjudicated_total, 4)

    return {
        "summary": (
            f"Correctness from {adjudicated_total} adjudicated attempts "
            f"({unknown_excluded} records excluded as unknown/unmatched); "
            "never inferred from merge state, CI, or model agreement."
        ),
        "missed_blockers": missed,
        "false_blockers": false_blockers,
        "adjudicated_total": adjudicated_total,
        "unknown_excluded": unknown_excluded,
        "precision": precision,
        "recall": recall,
    }


def build_report(
    rows: list[dict[str, Any]],
    *,
    mode: str,
    repos: list[str],
    truncated: bool,
    attestations: list[dict[str, Any]] | None = None,
    adjudications: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """The full harvest report: collection facts, rows, both rollups."""
    return {
        "collection": {
            "mode": mode,
            "repos": list(repos),
            "truncated": bool(truncated),
        },
        "rows": rows,
        "operational_completion": operational_rollup(rows),
        "correctness": correctness_rollup(rows, adjudications),
    }