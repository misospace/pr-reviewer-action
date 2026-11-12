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
partial/unknown ``coverage``, ``required_checks`` not ``incomplete``, a
marker head that agrees with the row's head — every independently
supplied head identity (the native review's ``commit_id``, the marker
head) must match, a disagreement is unsafe telemetry
(``partial_or_abstained``, recorded as ``head_conflict``) — AND
attempt-correlated evidence: the row's OWN native review event APPROVED,
by a configured bot login, whose ``commit_id`` equals the row's head and
whose own marker binds no different head — an APPROVED from a different
review attempt at the same head proves only that attempt, never this
row — or an attestation with ``conclusion == "approved"`` correlated to
the attempt: review-id-bound and head-consistent, or head-bound only
when that head has exactly one collected attempt, so the head binding
is unambiguous. A model approve-prose claim plus
``review_result: partial`` is never trusted; a native APPROVED over
partial/unknown coverage is ``partial_or_abstained``; with neither native
approval nor attestation the row is ``unknown_missing_native``.

The collection scope is explicit: an action-version scope keeps only the
rows whose published version is in the requested set, and a row whose
version is ``unknown`` is excluded from a scoped run because it cannot be
proven to be in scope. The comparison normalizes both sides (surrounding
whitespace, one leading ``v`` or ``V``, and case); the row keeps the
publisher's own spelling of the version.

Correctness is counted in heads, not attempts: an adjudication record
names a head, so one record applies to every attempt at that head.

The publish-nothing policy is exact. A canceled job and a job that never
ran publish nothing at all, so they leave no row and are never folded
into a disposition. A skipped run publishes no review artifact either:
its skip note goes to the step summary only, so no published body
carries it and the ``skipped`` disposition does not fire on organic
data. Two paths post a bot-authored reply comment instead of a review
(the fork-PR skip reply and a follow-up answer). Neither reply body
carries the metadata marker, so the collector records those replies as
rows with the ``unknown_no_marker`` disposition and the action version
``unknown``. Such a row counts as unknown telemetry, never as a
completed review. The report names the attempt kinds whose review
outcome is unobservable in ``collection.policy.unobservable_attempts``
instead of claiming to have counted them.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

from pr_reviewer.metadata import parse_metadata

# The published body line format (``src/publish/publish.ts``, body build):
# ``_Analysis engine: <engine> · pr-reviewer-action <version>_``. The
# engine name is a model identifier and may itself contain underscores
# (``meta/llama3.1_70b_instruct``), so it is consumed up to the ``·``
# delimiter within the line; only the version token stops at whitespace
# or the closing underscore.
_ACTION_VERSION_RE = re.compile(
    r"_Analysis engine:[^\n]*?·\s*pr-reviewer-action\s+([^\s_]+)_"
)

# The action-owned skip note (``src/run/action.ts`` step-summary and
# carry-label shape). A carried skip is only ever concluded when the
# body's own header/note says so — never inferred from absence of signal.
_SKIP_NOTE_RE = re.compile(r"\*\*AI PR Review skipped:\*\*")

# Marker ``head_sha`` values that do not bind the marker to a head.
_UNBOUND_HEAD = ("", "unknown")

# The version token a published body carries when it names no version.
# A row with this version cannot be proven to be inside a requested
# action-version scope, so a scoped run excludes it.
_UNKNOWN_VERSION = "unknown"

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

# The attempt kinds whose review outcome is unobservable: a canceled
# job and a job that never ran publish nothing at all, and a skipped
# run publishes no review artifact. They leave no review row, so they
# are never folded into a disposition.
_UNOBSERVABLE_ATTEMPTS = ("canceled_job", "never_run", "skipped_run")

# Marker keys consulted for the model verdict prose claim, in order. The
# value is recorded as an untrusted claim only; no disposition treats it
# as evidence.
_VERDICT_KEYS = ("verdict", "native_verdict", "carried_verdict")

# Every string field in a row and in the report is bounded, so a hostile
# body cannot blow up the report through a parsed field.
_FIELD_LIMIT = 200
_HEAD_LIMIT = 64
_LINK_LIMIT = 300

# The published version token's length bound. A parsed version is
# truncated here, so a requested scope token longer than this could
# never match a published version; the CLI reuses this bound to reject
# such a token before the run starts.
ACTION_VERSION_LIMIT = 32


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
        return _UNKNOWN_VERSION
    return match.group(1)[:ACTION_VERSION_LIMIT] or _UNKNOWN_VERSION


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


def _heads_differ(sha_a: str, sha_b: str) -> bool:
    """True when two supplied head identities are not the same head.

    Exact comparison after stripping and the row's bound truncation: a
    case or over-length difference is not agreement and fails closed.
    """
    return sha_a.strip()[:_HEAD_LIMIT] != sha_b.strip()[:_HEAD_LIMIT]


def _self_native_approval(attempt: dict[str, Any], head_sha: str) -> bool:
    """True when the attempt's OWN review event APPROVED the row's head.

    Evidence is per attempt, not per head: a row's trusted approval may
    rest only on what this attempt itself published — an APPROVED state
    with a non-null ``commit_id`` string-equal to the row's head, and no
    self-marker conflict. A bot APPROVED from a *different* review
    attempt at the same head proves only that attempt; borrowing it
    would upgrade a COMMENTED row (or any other attempt) to a trusted
    approval it never earned. The gate's conditions are unchanged — only
    its scope is the attempt's own record. A comment publishes no native
    event, so it is never its own native evidence.
    """
    if attempt.get("source") != "native_review":
        return False
    if not _usable_head(head_sha):
        return False
    if attempt.get("state") != "APPROVED":
        return False
    commit_id = attempt.get("commit_id")
    if not isinstance(commit_id, str) or not commit_id or commit_id != head_sha:
        return False
    return not _review_marker_conflict({"body": attempt.get("body")}, commit_id)


def _matching_attestation(
    attempt: dict[str, Any],
    head_text: str,
    attested_heads: dict[str, dict[str, Any]],
    attested_reviews: dict[int, dict[str, Any]],
    head_attempts: dict[str, int],
) -> dict[str, Any] | None:
    """The attestation record correlated to this attempt, or ``None``.

    Correlation rules (#1602 human review): a record bound with
    ``review_id`` is evidence only for the native review row with that
    id, and only when its head agrees with the row's head; a head-only
    record is evidence only when the head has exactly one collected
    attempt, so the head binding identifies that attempt unambiguously.
    An attestation is never borrowed across attempts that share a head.
    """
    review_id = attempt.get("review_id")
    if isinstance(review_id, int) and not isinstance(review_id, bool):
        record = attested_reviews.get(review_id)
        if record is not None and head_text:
            record_head = record.get("head_sha")
            if isinstance(record_head, str) and not _heads_differ(record_head, head_text):
                return record
        # A review-bound record naming another head certifies nothing to
        # this row; only an independently unambiguous head-only record
        # can still apply.
    if head_text and head_attempts.get(head_text, 0) == 1:
        return attested_heads.get(head_text)
    return None


def _review_marker_conflict(review: dict[str, Any], commit_id: str) -> bool:
    """True when a review record's own marker head contradicts its commit_id.

    Both identities independently supplied, both bound, and unequal: the
    record's claims belong to a head its forge binding does not, so the
    record cannot prove anything about either head.
    """
    body = review.get("body")
    marker = parse_metadata(body) if isinstance(body, str) else None
    marker_head = marker.get("head_sha") if isinstance(marker, dict) else None
    return bool(
        isinstance(marker_head, str)
        and _usable_head(marker_head)
        and _heads_differ(marker_head, commit_id)
    )


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
    row_head: str,
) -> str:
    """The row's disposition, per the #1602 taxonomy and metric invariant.

    ``row_head`` is the head identity the normalized row binds to (the
    native review's ``commit_id`` when it carries one) and is required:
    the head-agreement gate is meaningless without it. Order matters and
    is total: no-marker first (the default heuristic — nothing about a
    missing marker is ever upgraded), then the explicit skip note, then
    the incomplete/unsafe-telemetry gate (``partial`` or unknown
    coverage, incomplete required checks, an unbound marker head, a
    marker head that contradicts the row's head), then the clean path
    that REQUIRES proven native or attestation evidence, then completed
    findings, then a marker with no usable ``review_result`` at all.
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
        or _heads_differ(head, row_head)
    ):
        # Incomplete/unsafe telemetry: even a native APPROVED or a model
        # approve-prose claim over this state is never a trusted approval.
        # A marker head that disagrees with the row's head is unsafe the
        # same way an unbound one is: the marker's claims were made about
        # a head this row cannot prove, so no native event or attestation
        # can make this row a trusted approval of either head.
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

    commit_bound = (
        source == "native_review" and isinstance(commit_id, str) and _usable_head(commit_id)
    )
    marker_bound = isinstance(marker_head, str) and _usable_head(marker_head)

    if commit_bound:
        head_sha = commit_id.strip()[:_HEAD_LIMIT]
    elif marker_bound:
        head_sha = marker_head.strip()[:_HEAD_LIMIT]
    else:
        head_sha = ""

    # A native review carries two independent head identities: the forge-
    # bound ``commit_id`` and the head its body's marker claims. Both
    # bound and disagreeing is a contradiction (a marker for one head
    # riding a review bound to another); the row records it, and the
    # disposition gate refuses to trust the marker's claims for either
    # head.
    head_conflict = bool(
        commit_bound
        and marker_bound
        and _heads_differ(commit_id, marker_head)
    )

    native_approved = _self_native_approval(attempt, head_sha)

    # Native event attribution. Only a native review row publishes an
    # event, and it reports its own: another attempt's APPROVED at the
    # same head is that attempt's event, never this row's, and comment
    # prose is never an event at all (#1602 human review).
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
        event = None
        event_bound = False

    attestation_conclusion = attempt.get("attestation_conclusion")
    attestation_reason = attempt.get("attestation_reason_code")

    disposition = classify_disposition(
        marker, body, native_approved, attestation_conclusion, head_sha
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
        "head_conflict": head_conflict,
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


def _resolve_pull_attempts(
    pull: dict[str, Any],
    bots_lower: set[str],
    head_attempt_counts: dict[str, int],
    seen_attempt_records: set[tuple],
) -> tuple[int, str, list[tuple[dict[str, Any], str]]] | None:
    """Resolve one pull's bot attempts to their heads and count them.

    Returns ``(number, pr_head, resolved)`` or ``None`` for a malformed
    pull. Per-head counting mutates the collection-scoped
    ``head_attempt_counts``/``seen_attempt_records`` bookkeeping so a
    head-only attestation can never certify unrelated attempts that
    merely sit in different pulls or repositories.
    """
    if not isinstance(pull, dict):
        return None
    number = pull.get("number")
    if not isinstance(number, int) or isinstance(number, bool):
        return None
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
    # Resolve each attempt's head first and count attempts per head
    # across the whole collection, so a head-only attestation is only
    # attached when exactly one attempt shares that head and the
    # binding is unambiguous.
    resolved: list[tuple[dict[str, Any], str]] = []
    for attempt in attempts:
        head = attempt.get("commit_id")
        if attempt["source"] == "comment":
            marker_probe = parse_metadata(attempt.get("body") or "")
            probe_head = marker_probe.get("head_sha") if isinstance(marker_probe, dict) else None
            head = probe_head if isinstance(probe_head, str) and _usable_head(probe_head) else ""
        head_text = head.strip()[:_HEAD_LIMIT] if isinstance(head, str) else ""
        resolved.append((attempt, head_text))
        if head_text:
            # A replayed duplicate of the same record is one attempt,
            # matching the row dedupe below: it must not inflate the
            # count and void an otherwise valid head-only attestation.
            record_id = attempt.get("record_id")
            if record_id is not None:
                replay_key = (attempt["source"], record_id, head_text)
                if replay_key in seen_attempt_records:
                    continue
                seen_attempt_records.add(replay_key)
            head_attempt_counts[head_text] = head_attempt_counts.get(head_text, 0) + 1
    return number, pr_head, resolved


def collect_rows(
    repo: str,
    pulls: Iterable[dict[str, Any]],
    bot_logins: Iterable[str],
    attestations: Iterable[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Normalized rows for one repository; see :func:`collect_rows_multi`."""
    return collect_rows_multi([(repo, pulls)], bot_logins, attestations)


def collect_rows_multi(
    pulls_by_repo: Iterable[tuple[str, Iterable[dict[str, Any]]]],
    bot_logins: Iterable[str],
    attestations: Iterable[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Normalized rows for every eligible (head, review attempt) in ``pulls_by_repo``.

    ``pulls_by_repo`` yields one ``(repo, pulls)`` pair per repository:
    ``pulls`` yields one record per PR: ``number``, ``head_sha`` (the PR
    head at collection time), ``reviews`` (native review records) and
    ``comments`` (issue-comment records). Only records authored by a
    configured bot login become rows; everyone else's reviews and comments
    are other people's signals, not this collector's attempts.

    Attestation records are correlated to a specific attempt, never
    borrowed across attempts that share a head (#1602 human review):
    ``{"conclusion", "reason_code", "head_sha", "review_id"?}`` — a
    record carrying ``review_id`` is evidence only for the native review
    row with that id at a consistent head; a record whose ``review_id``
    is present but malformed certifies nothing; a head-only record is
    evidence only when that head has exactly one collected attempt in
    the whole collection, across every pull in every repository
    (replayed duplicates of one record count once), so the head binding
    identifies it unambiguously and one record can never certify
    unrelated attempts in two pulls or two repositories. Attestations
    are additional trusted evidence only; they never override a row's
    own marker fields.
    """
    bots_lower = {login.strip().lower() for login in bot_logins if isinstance(login, str) and login.strip()}

    attested_heads: dict[str, dict[str, Any]] = {}
    attested_reviews: dict[int, dict[str, Any]] = {}
    # Attempt/head bookkeeping spans the whole collection, not one pull
    # or one repository: a head-only attestation must certify at most
    # one collected attempt across every pull in every repository, so
    # per-head counts and replay dedupe are collection-scoped too.
    head_attempt_counts: dict[str, int] = {}
    seen_attempt_records: set[tuple] = set()
    resolved_pulls: list[tuple[str, int, str, list[tuple[dict[str, Any], str]]]] = []
    for record in attestations or []:
        if not isinstance(record, dict):
            continue
        head = record.get("head_sha")
        if not (isinstance(head, str) and _usable_head(head)):
            continue
        attestation_review_id = record.get("review_id")
        if attestation_review_id is not None and not (
            isinstance(attestation_review_id, int) and not isinstance(attestation_review_id, bool)
        ):
            # A present-but-malformed review binding is a poisoned record:
            # it was meant to be review-scoped, so it certifies nothing
            # rather than being demoted to head-scoped evidence.
            continue
        if isinstance(attestation_review_id, int) and not isinstance(attestation_review_id, bool):
            attested_reviews[attestation_review_id] = record
        else:
            # Same normalization as the row head and _heads_differ:
            # bounded to _HEAD_LIMIT after stripping.
            attested_heads[head.strip()[:_HEAD_LIMIT]] = record

    rows: list[dict[str, Any]] = []
    record_ids: dict[tuple, int | None] = {}
    for repo, pulls in pulls_by_repo:
        for pull in pulls:
            resolved_pull = _resolve_pull_attempts(
                pull, bots_lower, head_attempt_counts, seen_attempt_records
            )
            if resolved_pull is None:
                continue
            number, pr_head, resolved = resolved_pull
            # Defer matching until every pull's attempts are counted: matching
            # must see the collection-wide per-head counts, not the prefix
            # collected so far.
            resolved_pulls.append((repo, number, pr_head, resolved))

    for repo, number, pr_head, resolved in resolved_pulls:
        for attempt, head_text in resolved:
            attestation = _matching_attestation(
                attempt, head_text, attested_heads, attested_reviews, head_attempt_counts
            )
            if attestation is not None:
                attempt["attestation_conclusion"] = attestation.get("conclusion")
                attempt["attestation_reason_code"] = attestation.get("reason_code")
            row = _normalize_attempt(repo, number, pr_head, attempt)
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


def _normalize_version_token(token: str) -> str:
    """A version token normalized for comparison.

    Surrounding whitespace goes, one leading ``v`` or ``V`` goes, and
    what is left is lowercased. Both sides of a scope comparison go
    through this, so a requested ``3.5.0`` matches a published
    ``v3.5.0`` and the other way round, and the comparison does not
    depend on the case of either side.

    The row keeps the publisher's own spelling (for example
    ``v3.5.0``): only the comparison is normalized.
    """
    if not isinstance(token, str):
        return ""
    text = token.strip()
    if text[:1] in ("v", "V"):
        text = text[1:]
    return text.lower()


def _scope_tokens(versions: Iterable[str] | str | None) -> list[str]:
    """The requested action-version scope as a list of raw tokens.

    A bare string is one version, not a sequence of characters. A token
    that names no version at all stays in the list: it was requested,
    and the run has to answer for it.
    """
    if versions is None:
        return []
    if isinstance(versions, str):
        versions = [versions]
    return [version for version in versions if isinstance(version, str)]


def _normalized_scope(versions: Iterable[str] | str | None) -> list[str]:
    """The requested scope as normalized tokens, in request order.

    A token that normalizes to an empty string stays in the list: it
    named no version, and the report has to say that a scope was
    requested and matched nothing. The report and the filter both
    normalize through :func:`_normalize_version_token`, so the scope the
    report names and the scope that was applied are the same tokens.
    """
    return [_normalize_version_token(token) for token in _scope_tokens(versions)]


def filter_by_action_version(
    rows: list[dict[str, Any]],
    versions: Iterable[str] | str | None = None,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """The rows inside the requested action-version scope, and the exclusions.

    A scope with no token at all is no scope: every row is kept and
    nothing is excluded. A row whose parsed version is ``unknown`` cannot
    be proven to be in the requested scope, so a scoped run excludes it
    and counts it under ``action_version_unknown``. A row with a known
    version outside the scope is excluded and counted under
    ``action_version_other``. Only the reasons that occurred appear in
    the counts.

    A scope token that normalizes to an empty string names no version,
    so it keeps no row: the run fails closed rather than reading an
    empty scope as "everything".
    """
    requested = _scope_tokens(versions)
    if not requested:
        return list(rows), {}

    scope = {token for token in _normalized_scope(requested) if token}

    kept: list[dict[str, Any]] = []
    excluded: dict[str, int] = {}
    for row in rows:
        version = row.get("action_version")
        token = _normalize_version_token(version) if isinstance(version, str) else ""
        if not token or token == _UNKNOWN_VERSION:
            excluded["action_version_unknown"] = excluded.get("action_version_unknown", 0) + 1
            continue
        if token not in scope:
            excluded["action_version_other"] = excluded.get("action_version_other", 0) + 1
            continue
        kept.append(row)
    return kept, excluded


def operational_rollup(
    rows: list[dict[str, Any]],
    *,
    collected_total: int | None = None,
    action_versions: list[str] | None = None,
    scope_excluded: dict[str, int] | None = None,
) -> dict[str, Any]:
    """The ``operational_completion`` rollup over normalized rows.

    Counts review attempts by disposition with breakdowns by the marker's
    own telemetry fields. The summary states denominators in prose: a
    small sample is a count, never proof of a completion rate. It also
    states the attempts that are not counted at all because they
    published nothing, and how many attempts the requested
    action-version scope excluded.

    ``rows`` is the in-scope population, so
    ``denominators.total_attempts`` counts the attempts that stayed
    inside the scope. ``collected_total`` is how many attempts were
    collected before the scope filter, so the prose names the collected
    population instead of claiming the scoped count was everything.
    ``action_versions`` is the normalized scope, and its presence is what
    says a scope was applied at all.
    """
    total = len(rows)
    collected = (
        collected_total
        if isinstance(collected_total, int) and not isinstance(collected_total, bool)
        else total
    )
    eligible = [row for row in rows if not row["superseded_head"]]
    with_marker = [row for row in rows if row["review_result"] is not None]
    with_native = [row for row in rows if row["native_event"] is not None]
    unknown_or_missing = [row for row in rows if row["disposition"] in _UNKNOWN_OR_MISSING]
    scoped_out = sum((scope_excluded or {}).values()) if action_versions else 0

    summary = (
        f"{len(eligible)} eligible review attempts of {collected} collected "
        f"({len(with_marker)} with a marker, {len(with_native)} with a native "
        f"event, {len(unknown_or_missing)} with unknown/missing telemetry). "
        "These are denominators and counts, not proof of a completion rate. "
        "Attempts that published nothing (canceled or never-run jobs) are not "
        "counted: this collector reads published artifacts only."
    )
    if action_versions:
        summary += (
            " Excluded by the requested action-version scope: "
            f"{scoped_out} attempts."
        )

    return {
        "summary": summary,
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
            "scoped_out_attempts": scoped_out,
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
# The three known labels are the confusion matrix over one head: a
# confirmed blocker is a true positive, a missed blocker is a false
# negative, a false blocker is a false positive.
_LABEL_CONFIRMED_BLOCKER = "confirmed_blocker"
_LABEL_MISSED_BLOCKER = "missed_blocker"
_LABEL_FALSE_BLOCKER = "false_blocker"
_KNOWN_LABELS = (
    _LABEL_CONFIRMED_BLOCKER,
    _LABEL_MISSED_BLOCKER,
    _LABEL_FALSE_BLOCKER,
)


def correctness_rollup(
    rows: list[dict[str, Any]], adjudications: Iterable[dict[str, Any]] | None
) -> dict[str, Any]:
    """The ``correctness`` rollup — human adjudication labels only.

    Correctness comes exclusively from ``--adjudications`` records
    (``{"pr", "head_sha", "label"}``) matched to collected rows by
    ``(pr, head_sha)``. It is never inferred from comments resolved,
    merge state, CI green, or model agreement.

    The unit is the HEAD, not the attempt. An adjudication record names
    a head, so one record applies to every attempt at that head, and two
    attempts at one head (a rerun) share the adjudication key.
    ``adjudicated_heads`` counts the heads with one effective known
    label. Several records for the same head with the same known label
    count once, while records for the same head with different known
    labels are contradictory, so that head leaves every count and
    denominator and is counted once in ``contradictory_excluded``. The
    records themselves are excluded and counted one by one in
    ``unknown_excluded``: a record with a label outside the known
    vocabulary, a record matching no collected head, and a record that
    is not a record at all.
    """
    row_keys = {(row["pr"], row["head_sha"]) for row in rows if row["head_sha"]}
    labels_by_head: dict[tuple, set[str]] = {}
    unknown_excluded = 0
    for record in adjudications or []:
        if not isinstance(record, dict):
            # A record that is not a record cannot name a head: it is
            # excluded and counted, never dropped.
            unknown_excluded += 1
            continue
        pr = record.get("pr")
        head_sha = record.get("head_sha")
        if (
            not isinstance(pr, int)
            or isinstance(pr, bool)
            or not isinstance(head_sha, str)
        ):
            # A record that cannot name a collected row is not evidence
            # about one: it is excluded and counted, never dropped.
            unknown_excluded += 1
            continue
        key = (pr, head_sha)
        if key not in row_keys:
            # An adjudication naming an attempt this pass did not collect
            # is not evidence about a collected row; it is excluded.
            unknown_excluded += 1
            continue
        label = record.get("label")
        if label not in _KNOWN_LABELS:
            # A human label this rollup does not interpret: excluded from
            # the precision/recall denominators and counted, never dropped.
            unknown_excluded += 1
            continue
        labels_by_head.setdefault(key, set()).add(label)

    confirmed = 0
    missed = 0
    false_blockers = 0
    contradictory_excluded = 0
    for labels in labels_by_head.values():
        if len(labels) > 1:
            # Contradictory labels for one head: the head leaves every
            # count and denominator and is counted once as excluded.
            contradictory_excluded += 1
            continue
        label = next(iter(labels))
        if label == _LABEL_CONFIRMED_BLOCKER:
            confirmed += 1
        elif label == _LABEL_MISSED_BLOCKER:
            missed += 1
        else:
            false_blockers += 1
    adjudicated_heads = confirmed + missed + false_blockers

    precision: float | None = None
    recall: float | None = None
    precision_denominator = confirmed + false_blockers
    if precision_denominator > 0:
        precision = round(confirmed / precision_denominator, 4)
    recall_denominator = confirmed + missed
    if recall_denominator > 0:
        recall = round(confirmed / recall_denominator, 4)

    return {
        "summary": (
            f"Correctness from {adjudicated_heads} adjudicated heads "
            f"({confirmed} confirmed, {missed} missed, {false_blockers} false; "
            f"records excluded: {unknown_excluded}, heads excluded: "
            f"{contradictory_excluded}): precision and recall count only "
            "human-confirmed "
            "outcomes, a head nobody adjudicated is absent rather than "
            "correct, and a small sample is not proof."
        ),
        "confirmed_blockers": confirmed,
        "missed_blockers": missed,
        "false_blockers": false_blockers,
        "adjudicated_heads": adjudicated_heads,
        "unknown_excluded": unknown_excluded,
        "contradictory_excluded": contradictory_excluded,
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
    action_versions: Iterable[str] | str | None = None,
    scope_excluded: dict[str, int] | None = None,
    collected_total: int | None = None,
) -> dict[str, Any]:
    """The full harvest report: collection facts, rows, both rollups.

    The scope is normalized once here, so the scope the report names and
    the scope the rollup was given are the same tokens: a scope with no
    token at all is reported as empty and applies to nothing, and a token
    that normalizes to an empty string is reported as an empty token,
    because it was requested and named no version.
    """
    scope = _normalized_scope(action_versions)
    excluded = dict(scope_excluded or {})
    return {
        "collection": {
            "mode": mode,
            "repos": list(repos),
            "truncated": bool(truncated),
            "scope": {
                "action_versions": scope,
                "excluded": excluded,
            },
            "policy": {
                "unobservable_attempts": list(_UNOBSERVABLE_ATTEMPTS),
            },
        },
        "rows": rows,
        "operational_completion": operational_rollup(
            rows,
            collected_total=collected_total,
            action_versions=scope,
            scope_excluded=excluded,
        ),
        "correctness": correctness_rollup(rows, adjudications),
    }
