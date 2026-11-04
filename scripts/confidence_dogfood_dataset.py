#!/usr/bin/env python3
"""Collect the retained attempt dataset of published verifier runs (#1479).

The latest-per-pull-request evidence collector
(:mod:`scripts.confidence_dogfood_evidence`) reads ONE published body per
pull request -- the newest one. That is the right shape for "what does the
verifier say about this pull request right now", and the wrong shape for
"what did the verifier actually do": a native review is published once per
run and native reviews ACCUMULATE, so the newest body hides every earlier
run's evidence behind one record. This script keeps EVERY published
verifier attempt per pull request, so a reader can see the whole history of
what the verifier published for a pull request instead of its last word.

The dataset is INCREMENTAL and IDEMPOTENT. Every attempt is keyed by an
immutable published-review identity -- a digest of the repository, the pull
request, the publication kind, the publication instant and the two run
provenance pins the published body carried -- so re-running the collector
over unchanged input adds nothing, and a body that was edited in place keeps
the identity of the body it belongs to instead of becoming a new attempt. A
record is never deleted: an attempt that a later collection does not observe
(a dismissed review, a deleted comment, a publication that stopped being
listed) is kept and marked absent, because its absence is evidence too.

The reading of a published body is NOT re-implemented here. The published
grammar -- the metadata marker, the sibling fingerprint marker and the
``## Independent Confidence`` section -- belongs to the shared library
(:mod:`pr_reviewer.confidence_evidence`), and two parsers of one contract
drift apart silently. This script owns the collection, the record shape, the
merge and the CLI; it reads the publication from the shared parser.

The forge is reached ONLY through the repository's configured forge
capability (:mod:`pr_reviewer.forge`) -- never through a forge CLI, never
through a raw HTTP client and never through a subprocess -- so the bearer
token rides only the ``Authorization`` header and redirects stay refused.

The historical baseline of the #1459 sweep can be imported instead of read
(:option:`--import-legacy`). An imported record carries the provenance the
baseline retained and the live path does not publish, and the run reconciles
what was declared in the baseline against what was actually imported, so a
reader can see exactly how much of the baseline the dataset holds.

The dataset file is the unit of the incremental flow: ``--dataset`` is
loaded AND written back, so a repeated run folds what it sees into the
history instead of replacing it. ``--out`` writes the merged document
elsewhere (to stdout when neither path is given), and ``--summary`` writes
the run-window summary beside it.

Exit codes:

- ``0`` -- the collection ran and every requested pull request was read;
- ``1`` -- at least one pull request could not be read (the other records are
  still written);
- ``2`` -- the collection could not run at all (invalid input, an unusable
  forge configuration, an unreadable or foreign dataset file, an unwritable
  output, or a dataset that would exceed the record bound).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Make the repository root importable when this script is invoked by path
# (``python3 scripts/confidence_dogfood_dataset.py``) so the configured
# forge capability in ``pr_reviewer.forge`` is reachable. Same bootstrap as
# ``scripts/forge_cli.py``: the repo root is the parent of ``scripts/``.
SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pr_reviewer.confidence_evidence import (  # noqa: E402
    CAUSE_TOKEN_RE,
    MAX_MODEL,
    MAX_TIMESTAMP,
    NO_PUBLISHED_FINGERPRINT_REASON,
    NO_PUBLISHED_RECORD_REASON,
    NO_PUBLISHED_SECTION_REASON,
    RISK_VALUES,
    UNAVAILABLE_REASONS,
    extract_published_evidence,
    list_items,
    published_body_descriptor,
    published_id,
    safe_text,
)
from pr_reviewer.forge import ForgeClient, ForgeError, default_forge  # noqa: E402
from pr_reviewer.metadata import parse_metadata  # noqa: E402

SCHEMA = "verifier-dogfood-dataset/v1"
SUMMARY_SCHEMA = "verifier-dogfood-summary/v1"
LEGACY_SCHEMA = "confidence-dogfood-evidence/v1"

EXIT_OK = 0
EXIT_PARTIAL = 1
EXIT_ERROR = 2

# Input shapes, validated exactly as ``scripts/forge_cli.py`` and
# ``scripts/confidence_dogfood_evidence.py`` validate them: the checks run
# before any byte goes out, and a rejected value is reported by field name
# only -- never echoed back. Anchored with ``\Z`` rather than ``$``: ``$``
# also matches before a trailing newline, and a newline inside a request
# path must never validate.
REPO_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\Z")
NUMBER_RE = re.compile(r"^[0-9]{1,18}\Z")

DEFAULT_MAX_PRS = 50
DEFAULT_MAX_ATTEMPTS_PER_PR = 50
DEFAULT_MAX_RECORDS = 5000
DEFAULT_MAX_PAGES = 20

# Bounds on the document itself. The dataset is an artifact a human reads,
# so its own size is bounded too: the collection log keeps the newest
# entries, and the notes keep the most recent ones.
MAX_COLLECTIONS = 50
MAX_NOTES = 50
MAX_COLLECTION_NOTES = 20
MAX_NOTE_CHARS = 600
MAX_LEGACY_CHARS = 200
MAX_SCHEMA_CHARS = 120

# The published-evidence vocabulary: what the shared parser can name as
# unavailable, plus the three reasons it adds when a body publishes no
# section, no fingerprint marker, or nothing at all. The dataset's
# ``unavailable_reasons`` block is the merged vocabulary of every key a
# record's ``unavailable`` list can name, so the document explains itself.
PUBLISHED_UNAVAILABLE_REASONS: dict[str, str] = {
    **UNAVAILABLE_REASONS,
    "published_verifier_section": NO_PUBLISHED_SECTION_REASON,
    "published_fingerprint": NO_PUBLISHED_FINGERPRINT_REASON,
    "published_record": NO_PUBLISHED_RECORD_REASON,
}

# The legacy vocabulary. The keys are prefixed ``legacy_`` so they cannot
# collide with the published vocabulary, and every sentence is TRUE: it names
# what the baseline retained and where the rest of the value lives.
LEGACY_UNAVAILABLE_REASONS: dict[str, str] = {
    "legacy_published_record_id": (
        "The baseline retained no published review id for this run, so the "
        "attempt's forge id is null and the record is keyed by its immutable "
        "publication identity instead."
    ),
    "legacy_verifier_reason": (
        "The baseline retained the verifier's status, score, risk band, "
        "model and concern count, but not the verifier's reason text; the "
        "reason lives only in the published review body."
    ),
    "legacy_verifier_concern_details": (
        "The baseline retained the concern count only; the individual "
        "advisory concerns (type, severity, location and evidence) live "
        "only in the published review body."
    ),
    "legacy_model": (
        "The baseline recorded no verifier model for this run; the model "
        "lives only in the published review body's confidence section."
    ),
    "legacy_latency_ms": (
        "The baseline recorded no verifier latency for this run; the latency "
        "lives only in the published marker and in the run-directory "
        "artifact confidence-score.json."
    ),
    "legacy_token_usage": (
        "The baseline recorded no provider token usage for this run; the "
        "usage lives only in the published marker and in the run-directory "
        "artifact confidence-response.json."
    ),
    "legacy_rubric_version": (
        "The baseline recorded no rubric version for this run; the rubric "
        "version constant lives only in the run-directory artifact "
        "confidence-score.json."
    ),
    "legacy_parser_notes": (
        "The baseline recorded no parser notes for this run; the parser "
        "notes live only in the run-directory artifact confidence-score.json."
    ),
    "legacy_unscored_cause": (
        "The baseline recorded no published unscored cause for this run; the "
        "cause lives only in the published marker and in the run-directory "
        "artifact confidence-score.json."
    ),
}

# What the baseline's publication kind means for the dataset. A baseline
# that named a kind this collector does not know keeps its runs under the
# generic kind, so an unknown kind never silently becomes a review.
LEGACY_KIND_MAP: dict[str, str] = {
    "native_review": "review",
    "comment": "comment",
    "issue_comment": "comment",
}
LEGACY_FALLBACK_KIND = "legacy-import"

# The dataset's standing notes. They describe the contract a reader relies
# on, so they are part of the document rather than of a run.
DATASET_NOTES: tuple[str, ...] = (
    "the dataset retains every published verifier attempt per pull request; "
    "a record is keyed by an immutable published-review identity and is "
    "never deleted.",
    "a record that a later collection does not observe is kept and marked "
    "absent_in_latest_collection: a dismissed, deleted or hidden publication "
    "is evidence too.",
    "absence is asserted only where the collection actually read that pull "
    "request's publication surface: a bounded collection never marks the "
    "attempts it did not look for absent.",
    "the published bodies are reduced to their pins, their verifier block "
    "and a body digest; no review or comment body is copied into the "
    "dataset, and a published value that carries the bearer token is "
    "refused.",
)

SUMMARY_NOTES: tuple[str, ...] = (
    "the summary reports what the retained attempts carry and nothing else: "
    "it carries no pass/fail judgment, no score threshold and no gate "
    "advice, because the adjudication of the verifier's authority lives in "
    "issue #1450.",
)


class CliError(Exception):
    """A rejected input or a collection that could not run.

    The message names the offending field but never echoes the value, so
    nothing an operator typed (and nothing a hostile file carried) can leak
    into a log line.
    """


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


def valid_repo(value: str) -> bool:
    """True for a usable ``owner/name`` repository.

    Both segments use the allowed characters, and neither is ``.`` or
    ``..``: a traversal segment would address a path outside the
    ``/repos/OWNER/NAME/...`` endpoint shape the caller asked for.
    """
    if not REPO_RE.match(value):
        return False
    return all(segment not in (".", "..") for segment in value.split("/"))


def valid_bound(value: int) -> bool:
    """True for a usable bound.

    A bound of zero or less would read nothing at all, which is not what
    "read at most N" means; a caller that wants no run must not ask for a
    collection.
    """
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


# ---------------------------------------------------------------------------
# Instants
# ---------------------------------------------------------------------------


def normalize_instant(raw: object) -> str | None:
    """One instant, normalized to UTC ISO-8601, or ``None``.

    A published timestamp may spell the same instant in more than one way
    (an offset instead of ``Z``), and the attempt identity must not depend
    on the spelling -- otherwise an imported baseline and a later live read
    of the SAME published review would resolve to two records. Sub-second
    precision is kept: two publications inside one second are still two
    attempts.

    A timestamp that cannot be read is ``None``, never a guess: an
    unparsable instant is no instant at all.
    """
    if not isinstance(raw, str) or raw.strip() == "":
        return None
    text = raw.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    parsed = parsed.astimezone(timezone.utc)
    if parsed.microsecond:
        return parsed.strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"
    return parsed.strftime("%Y-%m-%dT%H:%M:%S") + "Z"


def instant_sort_value(text: object) -> float:
    """The sortable value of one instant string.

    A record whose publication instant is unknown sorts oldest: a body with
    no provable time never outranks one with a provable newer time.
    """
    if not isinstance(text, str) or text == "":
        return float("-inf")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return float("-inf")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def publication_instant(item: dict[str, Any], kind: str) -> str | None:
    """The IMMUTABLE publication instant of one published body.

    A native review carries only ``submitted_at``, so a review is timed by
    the timestamp its submission wrote. A managed comment is rewritten IN
    PLACE, so its ``updated_at`` moves every time the action republishes it:
    ``created_at`` is the only stable anchor, and it is the anchor the
    identity uses.
    """
    raw = item.get("submitted_at") if kind == "review" else item.get("created_at")
    return normalize_instant(raw)


def comment_edited_state(item: dict[str, Any]) -> bool | None:
    """Whether a comment was edited after it was created.

    ``True`` when ``updated_at`` is later than ``created_at``, ``False``
    when the two are equal, and ``None`` when the comment carries no
    comparable pair of timestamps -- then nobody can tell whether the body
    was rewritten in place.
    """
    created = normalize_instant(item.get("created_at"))
    updated = normalize_instant(item.get("updated_at"))
    if created is None or updated is None:
        return None
    if updated == created:
        return False
    return updated > created


# ---------------------------------------------------------------------------
# The attempt identity
# ---------------------------------------------------------------------------


def attempt_identity(
    repository: str,
    pr_number: int,
    kind: str,
    discriminator: str,
    head_sha: str | None,
    config_fingerprint: str | None,
) -> str:
    """The immutable identity of one published attempt.

    The digest covers the material that cannot change for a published body:
    the repository, the pull request, the publication kind, the publication
    instant and the two run provenance pins the body carried. The forge's
    own id is deliberately NOT part of the key -- the id is recorded on the
    attempt so a reader can check it, but the key must survive a body that
    was rewritten in place, and the pins are what make a rewritten body a
    DIFFERENT attempt.
    """
    material = "\x00".join(
        [
            repository,
            str(pr_number),
            kind,
            discriminator,
            head_sha or "",
            config_fingerprint or "",
        ]
    )
    return "sha256:" + hashlib.sha256(material.encode("utf-8")).hexdigest()


def body_digest(body: str) -> str:
    """The digest of one published body.

    The dataset carries the digest, never the body: the digest is enough to
    tell whether a body changed between two observations, and the body
    itself is not the collector's to copy.
    """
    return "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()


def discriminator_for(
    instant: str | None, identifier: int | None
) -> str:
    """The identity's discriminator for one published body.

    The publication instant is the anchor. A body that carries no usable
    timestamp falls back to the forge's own id, and only then to the empty
    string -- a body with neither is still an attempt, it just cannot be
    told apart from another body with neither.
    """
    if instant is not None:
        return instant
    if identifier is not None:
        return str(identifier)
    return ""


# ---------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------


def empty_attempt() -> dict[str, Any]:
    """An attempt block with nothing observed in it."""
    return {
        "kind": None,
        "id": None,
        "state": None,
        "submitted_at": None,
        "created_at": None,
        "updated_at": None,
        "published_at": None,
        "edited": None,
        "body_digest": None,
        "observations": 0,
        "first_seen_at": None,
        "last_seen_at": None,
        "absent_in_latest_collection": False,
    }


def build_live_record(
    repository: str,
    pr_number: int,
    kind: str,
    item: dict[str, Any],
    body: str,
    token: str,
    now: str,
    read_error: str | None,
) -> dict[str, Any]:
    """The record of one published attempt read from the forge.

    The published evidence comes from the shared parser, unchanged in shape:
    the pins, the verifier block and the unavailable reasons are the
    publication's own, and the body itself is reduced to a digest.
    """
    published = extract_published_evidence(body, token)
    descriptor = published_body_descriptor(kind, item, token)
    identifier = published_id(item)
    instant = publication_instant(item, kind)
    head_sha = published.get("head_sha")
    config_fingerprint = published.get("config_fingerprint")
    identity = attempt_identity(
        repository,
        pr_number,
        kind,
        discriminator_for(instant, identifier),
        head_sha,
        config_fingerprint,
    )
    attempt = empty_attempt()
    attempt.update(
        {
            "kind": kind,
            "id": identifier,
            "state": review_state(item, token),
            "submitted_at": descriptor.get("submitted_at"),
            "created_at": descriptor.get("created_at"),
            "updated_at": descriptor.get("updated_at"),
            "published_at": instant,
            "edited": comment_edited_state(item) if kind == "comment" else None,
            "body_digest": body_digest(body),
            "observations": 1,
            "first_seen_at": now,
            "last_seen_at": now,
            "absent_in_latest_collection": False,
        }
    )
    return {
        "identity": identity,
        "repository": repository,
        "pr_number": pr_number,
        "source": "forge-read",
        "attempt": attempt,
        "head_sha": head_sha,
        "base_sha": published.get("base_sha"),
        "review_result": published.get("review_result"),
        "required_checks": published.get("required_checks"),
        "diff_fingerprint": published.get("diff_fingerprint"),
        "config_fingerprint": config_fingerprint,
        "verifier": published.get("verifier"),
        "unavailable": sorted(published.get("unavailable") or {}),
        "legacy": None,
        "read_error": read_error,
    }


def review_state(item: dict[str, Any], token: str) -> str | None:
    """The forge's own review state, when the body is a native review.

    The state is a closed vocabulary on the forge side, but a hostile forge
    could send anything, so the value is bounded and refused outright when
    it carries the bearer token.
    """
    value = item.get("state")
    if not isinstance(value, str) or value == "":
        return None
    return safe_text(value, MAX_TIMESTAMP, token)


def legacy_string(value: object) -> str | None:
    """One bounded legacy string, or ``None``.

    The baseline is a local file, but its values are still capped: a
    baseline that carried an enormous string must not be able to blow the
    dataset up. The URL redactor runs too, so a legacy value that carries
    a credential in its userinfo is masked.
    """
    if not isinstance(value, str) or value == "":
        return None
    return safe_text(value, MAX_LEGACY_CHARS, "")


def legacy_unavailable_keys(run: dict[str, Any]) -> list[str]:
    """The legacy vocabulary keys that apply to one imported run.

    A key names something the baseline did NOT retain, so the key applies
    exactly when the value really is missing: the model, the latency and the
    published cause are read off the run itself, the rubric version, the
    parser notes and the token usage are read off the baseline's own
    ``unavailable`` map (the baseline's convention is that this map names
    what it could not retain), and the published review id and the verifier
    reason were never part of the baseline's shape at all.
    """
    published_body = run.get("published_body")
    published_body = published_body if isinstance(published_body, dict) else {}
    verifier = run.get("verifier")
    verifier = verifier if isinstance(verifier, dict) else {}
    unavailable = run.get("unavailable")
    unavailable = unavailable if isinstance(unavailable, dict) else {}
    keys: list[str] = []
    if not isinstance(published_body.get("id"), int) or isinstance(
        published_body.get("id"), bool
    ):
        keys.append("legacy_published_record_id")
    if "reason" not in verifier:
        keys.append("legacy_verifier_reason")
    count = verifier.get("concern_count")
    if isinstance(count, int) and not isinstance(count, bool) and count > 0:
        keys.append("legacy_verifier_concern_details")
    if not isinstance(verifier.get("model"), str) or verifier.get("model") == "":
        keys.append("legacy_model")
    latency = verifier.get("latency_ms")
    if not isinstance(latency, int) or isinstance(latency, bool) or latency < 0:
        keys.append("legacy_latency_ms")
    if "token_usage" in unavailable:
        keys.append("legacy_token_usage")
    if "rubric_version" in unavailable:
        keys.append("legacy_rubric_version")
    if "parser_notes" in unavailable:
        keys.append("legacy_parser_notes")
    cause = verifier.get("cause")
    if not isinstance(cause, str) or cause == "":
        keys.append("legacy_unscored_cause")
    return sorted(keys)


def legacy_verifier_block(verifier: dict[str, Any]) -> dict[str, Any]:
    """The verifier block of one imported baseline run.

    The baseline retained a status, a score, a risk band, a model, a latency
    and a cause -- and nothing else. Every value is re-checked against the
    verifier's own closed vocabularies here, so a baseline that carried a
    malformed status, score, risk band, latency or cause degrades to the
    neutral value instead of widening the vocabulary.

    The cause keeps the coupling the published marker obeys: a cause
    explains a MISSING score, so it is recorded only for an unscored run
    and only when it is a machine token.
    """
    status = verifier.get("status")
    if status not in ("scored", "unscored", "disabled"):
        status = "unknown"
    score = verifier.get("score")
    if not isinstance(score, int) or isinstance(score, bool) or not 0 <= score <= 5:
        score = None
    risk = verifier.get("risk")
    if risk not in RISK_VALUES:
        risk = "unknown"
    model = verifier.get("model")
    model = model if isinstance(model, str) else ""
    model = safe_text(model, MAX_MODEL, "")
    latency = verifier.get("latency_ms")
    if not isinstance(latency, int) or isinstance(latency, bool) or latency < 0:
        latency = None
    cause = verifier.get("cause")
    if not (
        status == "unscored"
        and isinstance(cause, str)
        and CAUSE_TOKEN_RE.match(cause) is not None
    ):
        cause = None
    return {
        "status": status,
        "score": score,
        "risk": risk,
        "reason": "",
        "model": model,
        "concerns": [],
        "materially_challenges_primary": None,
        "cause": cause,
        "latency_ms": latency,
        "token_usage": None,
    }


def build_legacy_record(
    repository: str,
    run: dict[str, Any],
    source_issue: str | None,
    now: str,
) -> dict[str, Any]:
    """The record of one imported baseline run.

    The imported record carries the pins, the primary verdict and the
    verifier's own fields the baseline retained, plus a ``legacy`` block with
    the provenance the live path does not publish. Its body digest is
    ``None``: the baseline retained no body, and a digest of a body nobody
    holds would be a fiction.
    """
    published_body = run.get("published_body")
    published_body = published_body if isinstance(published_body, dict) else {}
    pins = run.get("pins")
    pins = pins if isinstance(pins, dict) else {}
    primary = run.get("primary")
    primary = primary if isinstance(primary, dict) else {}
    verifier = run.get("verifier")
    verifier = verifier if isinstance(verifier, dict) else {}

    kind = LEGACY_KIND_MAP.get(str(published_body.get("kind")), LEGACY_FALLBACK_KIND)
    identifier = published_body.get("id")
    if not isinstance(identifier, int) or isinstance(identifier, bool):
        identifier = None
    instant = normalize_instant(published_body.get("submitted_at"))
    head_sha = legacy_string(pins.get("head_sha"))
    config_fingerprint = legacy_string(pins.get("config_fingerprint"))
    identity = attempt_identity(
        repository,
        int(run["pr"]),
        kind,
        discriminator_for(instant, identifier),
        head_sha,
        config_fingerprint,
    )
    concern_count = verifier.get("concern_count")
    if not isinstance(concern_count, int) or isinstance(concern_count, bool):
        concern_count = None
    attempt = empty_attempt()
    attempt.update(
        {
            "kind": kind,
            "id": identifier,
            "state": legacy_string(published_body.get("native_state")),
            "submitted_at": legacy_string(published_body.get("submitted_at")),
            "created_at": None,
            "updated_at": None,
            "published_at": instant,
            "edited": None,
            "body_digest": None,
            "observations": 1,
            "first_seen_at": now,
            "last_seen_at": now,
            "absent_in_latest_collection": False,
        }
    )
    return {
        "identity": identity,
        "repository": repository,
        "pr_number": int(run["pr"]),
        "source": "legacy-import",
        "attempt": attempt,
        "head_sha": head_sha,
        "base_sha": legacy_string(pins.get("base_sha")),
        "review_result": legacy_string(primary.get("review_result")),
        "required_checks": legacy_string(primary.get("required_checks")),
        "diff_fingerprint": legacy_string(pins.get("diff_fingerprint")),
        "config_fingerprint": config_fingerprint,
        "verifier": legacy_verifier_block(verifier),
        "unavailable": legacy_unavailable_keys(run),
        "legacy": {
            "action_version": legacy_string(pins.get("action_version")),
            "native_state": legacy_string(published_body.get("native_state")),
            "tool_stop_reason": legacy_string(primary.get("tool_stop_reason")),
            "review_route": legacy_string(primary.get("review_route")),
            "incomplete_reason": legacy_string(primary.get("incomplete_reason")),
            "concern_count": concern_count,
            "source_issue": legacy_string(source_issue),
        },
        "read_error": None,
    }


# ---------------------------------------------------------------------------
# The merge
# ---------------------------------------------------------------------------


def merged_edited(previous: dict[str, Any], observation: dict[str, Any]) -> bool | None:
    """Whether the attempt's published body was edited.

    An edited body is NEVER a fresh attempt: it keeps the identity of the
    body it belongs to. Three facts decide the flag:

    - the body digest changed between the two observations -- the body was
      rewritten;
    - the publication carries a later ``updated_at`` than its ``created_at``
      -- the body was rewritten in place;
    - the two observations carry the same digest -- the body is known
      unchanged.

    A first observation of a body nobody can compare (a native review, which
    carries no ``updated_at``, or a comment with a single timestamp) leaves
    the flag ``None``: nobody can tell, and a guess would read like a fact.
    """
    previous_digest = previous["attempt"].get("body_digest")
    observed_digest = observation["attempt"].get("body_digest")
    hint = observation["attempt"].get("edited")
    if (
        isinstance(previous_digest, str)
        and isinstance(observed_digest, str)
        and previous_digest != observed_digest
    ):
        return True
    if hint is True:
        return True
    if isinstance(previous_digest, str) and isinstance(observed_digest, str):
        return False
    return previous["attempt"].get("edited")


def merge_observation(
    previous: dict[str, Any], observation: dict[str, Any], now: str
) -> dict[str, Any]:
    """Fold a fresh observation of a known attempt into its record.

    The latest observation wins for the content fields -- the published pins,
    the verifier block and the unavailable reasons -- because the publication
    is the authority on what it published. The provenance of the record
    survives: the first observation time is kept, the observation counter
    grows, and the legacy block the baseline carried is not thrown away by a
    later live read.
    """
    merged = dict(previous)
    attempt = dict(previous["attempt"])
    observed_attempt = observation["attempt"]
    for field in (
        "kind",
        "id",
        "state",
        "submitted_at",
        "created_at",
        "updated_at",
        "published_at",
        "body_digest",
    ):
        attempt[field] = observed_attempt.get(field)
    attempt["edited"] = merged_edited(previous, observation)
    attempt["observations"] = int(previous["attempt"].get("observations") or 0) + 1
    attempt["first_seen_at"] = previous["attempt"].get("first_seen_at") or now
    attempt["last_seen_at"] = now
    attempt["absent_in_latest_collection"] = False
    merged["attempt"] = attempt
    for field in (
        "source",
        "head_sha",
        "base_sha",
        "review_result",
        "required_checks",
        "diff_fingerprint",
        "config_fingerprint",
        "verifier",
        "unavailable",
        "read_error",
    ):
        merged[field] = observation.get(field)
    if observation.get("legacy") is not None:
        merged["legacy"] = observation["legacy"]
    return merged


def record_sort_key(record: dict[str, Any]) -> tuple[Any, ...]:
    """The deterministic order the records are written in.

    The order is by pull request, then by publication instant, then by kind,
    then by the forge's id, then by the identity. The identity closes the
    order, so two records that agree on everything else still have a fixed
    place: the document is byte-stable for a given input.
    """
    attempt = record.get("attempt") or {}
    identifier = attempt.get("id")
    return (
        int(record.get("pr_number") or 0),
        attempt.get("published_at") or "",
        attempt.get("kind") or "",
        identifier if isinstance(identifier, int) else -1,
        str(record.get("identity") or ""),
    )


# ---------------------------------------------------------------------------
# The collection
# ---------------------------------------------------------------------------


def collect_pull_request(
    forge: ForgeClient,
    repository: str,
    number: int,
    max_pages: int,
) -> tuple[list[tuple[str, dict[str, Any], str]], list[str]]:
    """Every published attempt of one pull request, and its read errors.

    The two list endpoints are read independently: a forge that answers the
    comments but refuses the reviews still yields the attempts the comments
    carry, and the refusal is recorded on those attempts instead of
    throwing the whole pull request away.

    Only a MARKER-BEARING body is an attempt. The marker is the
    repository's own (``pr_reviewer.metadata.parse_metadata``), never a
    hand-rolled search: a body that carries no marker was published by
    somebody else and says nothing about the verifier.
    """
    comments: list[dict[str, Any]] = []
    reviews: list[dict[str, Any]] = []
    errors: list[str] = []
    try:
        comments = list_items(
            forge, f"/repos/{repository}/issues/{number}/comments", max_pages
        )
    except ForgeError as exc:
        errors.append(str(exc))
    try:
        reviews = list_items(
            forge, f"/repos/{repository}/pulls/{number}/reviews", max_pages
        )
    except ForgeError as exc:
        errors.append(str(exc))
    attempts: list[tuple[str, dict[str, Any], str]] = []
    for kind, items in (("comment", comments), ("review", reviews)):
        for item in items:
            body = item.get("body")
            if not isinstance(body, str) or body == "":
                continue
            if parse_metadata(body) is None:
                continue
            attempts.append((kind, item, body))
    attempts.sort(key=_attempt_sort_key, reverse=True)
    return attempts, errors


def _attempt_sort_key(attempt: tuple[str, dict[str, Any], str]) -> tuple[Any, ...]:
    """The newest-first order of one pull request's published attempts."""
    kind, item, _body = attempt
    identifier = published_id(item)
    return (
        instant_sort_value(publication_instant(item, kind)),
        identifier if identifier is not None else -1,
    )


def enumerate_pull_requests(
    forge: ForgeClient,
    repository: str,
    state: str,
    max_prs: int,
    max_pages: int,
) -> tuple[list[int], list[str]]:
    """The pull request numbers the repository lists, newest first.

    The list is read through the configured capability with the forge's own
    ordering (updated, descending), and at most ``max_prs`` of them are
    taken: an unbounded walk over a repository with thousands of pull
    requests is not a collection, it is a denial of service against the
    forge.
    """
    pages = forge.get_pages(
        f"/repos/{repository}/pulls",
        {"state": state, "sort": "updated", "direction": "desc"},
        max_pages=max_pages,
    )
    numbers: list[int] = []
    notes: list[str] = []
    for item in pages:
        if not isinstance(item, dict):
            continue
        number = item.get("number")
        if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
            notes.append("the pull request list carried an entry without a usable number")
            continue
        if number not in numbers:
            numbers.append(number)
        if len(numbers) >= max_prs:
            break
    return numbers, notes


def collect_from_forge(
    forge: ForgeClient,
    repository: str,
    numbers: list[int],
    max_attempts_per_pr: int,
    max_pages: int,
    now: str,
) -> tuple[list[dict[str, Any]], list[str], bool, set[int]]:
    """Read every requested pull request and build its observations.

    The observations are returned in the order the pull requests were
    requested; the merge and the document sort them afterwards, so the
    document does not depend on the order the forge answered in.

    The covered pull requests come back with them: a pull request counts as
    covered only when its publication surface was read WHOLELY -- both
    endpoints answered, and no attempt was left out by the per-pull-request
    bound -- because only a complete read can assert that a publication is
    gone. A pull request the forge refused to answer, and a pull request whose
    surface was only partly read, are not covered, so the attempts they
    published are never marked absent on the strength of a read that never
    happened.
    """
    token = getattr(forge, "token", "") or ""
    observations: list[dict[str, Any]] = []
    notes: list[str] = []
    failed = False
    covered: set[int] = set()
    for number in numbers:
        attempts, errors = collect_pull_request(forge, repository, number, max_pages)
        read_error = "; ".join(errors) if errors else None
        if errors:
            failed = True
            notes.append(
                f"pull request {number}: the forge read failed ({read_error})"
            )
        if not attempts:
            if not errors:
                # The surface was read and it carries no published attempt:
                # that is an observation, and it can assert the absence of
                # the publications the dataset retains for this pull request.
                covered.add(number)
            continue
        kept = attempts[:max_attempts_per_pr]
        skipped = len(attempts) - len(kept)
        if skipped > 0:
            notes.append(
                f"pull request {number}: {skipped} published attempts were not "
                f"retained (the per-pull-request bound is {max_attempts_per_pr})"
            )
            # The surface was read but not wholly: the attempts that were
            # left out are still published, so this pull request cannot
            # assert that any of its attempts is gone.
        else:
            covered.add(number)
        for kind, item, body in kept:
            observations.append(
                build_live_record(
                    repository,
                    number,
                    kind,
                    item,
                    body,
                    token,
                    now,
                    read_error,
                )
            )
    return observations, notes, failed, covered


# ---------------------------------------------------------------------------
# The historical baseline import
# ---------------------------------------------------------------------------


def import_legacy(
    path: Path,
    repository: str,
    now: str,
) -> tuple[list[dict[str, Any]], dict[str, Any], list[str], set[int]]:
    """Read the historical baseline file and turn its runs into observations.

    The baseline's own schema is checked before anything is read out of it:
    a file of another schema is never reinterpreted as a baseline, because a
    silent reinterpretation produces a dataset that looks complete and is
    not.

    The pull requests the baseline covers come back with the observations:
    the import read the whole file, so it can speak about the publications of
    those pull requests, and about nothing else.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise CliError("cannot read the legacy evidence file") from exc
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise CliError("the legacy evidence file is not valid JSON") from exc
    if not isinstance(document, dict):
        raise CliError("the legacy evidence file is not a legacy evidence document")
    schema = document.get("schema")
    if schema != LEGACY_SCHEMA:
        raise CliError(
            "the legacy evidence file has another schema: "
            f"{str(schema)[:MAX_SCHEMA_CHARS]!r}"
        )
    runs = document.get("runs")
    if not isinstance(runs, list):
        raise CliError("the legacy evidence file carries no run list")
    window = document.get("window")
    window = window if isinstance(window, dict) else {}
    source_issue = document.get("source_issue")

    observations: list[dict[str, Any]] = []
    skip_reasons: dict[str, int] = {}
    prs: set[int] = set()
    for run in runs:
        if not isinstance(run, dict):
            skip_reasons["malformed_run"] = skip_reasons.get("malformed_run", 0) + 1
            continue
        number = run.get("pr")
        if number is None:
            skip_reasons["missing_pull_request_number"] = (
                skip_reasons.get("missing_pull_request_number", 0) + 1
            )
            continue
        if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
            skip_reasons["invalid_pull_request_number"] = (
                skip_reasons.get("invalid_pull_request_number", 0) + 1
            )
            continue
        prs.add(number)
        observations.append(build_legacy_record(repository, run, source_issue, now))

    declared_runs = window.get("enabled_runs")
    declared_prs = window.get("distinct_prs")
    reconciliation = {
        "source_file": str(path),
        "source_schema": LEGACY_SCHEMA,
        "declared_enabled_runs": declared_runs if isinstance(declared_runs, int) else None,
        "declared_distinct_prs": declared_prs if isinstance(declared_prs, int) else None,
        "runs_read": len(runs),
        "records_imported": len(observations),
        "records_skipped": len(runs) - len(observations),
        "skip_reasons": dict(sorted(skip_reasons.items())),
        "distinct_prs_imported": len(prs),
        "notes": [],
    }
    notes: list[str] = []
    skipped = reconciliation["records_skipped"]
    if skipped:
        detail = ", ".join(
            f"{count} {reason}" for reason, count in sorted(skip_reasons.items())
        )
        notes.append(
            f"{skipped} of {len(runs)} baseline runs were skipped and counted, "
            f"never dropped: {detail}."
        )
    return observations, reconciliation, notes, prs


def reconciliation_notes(reconciliation: dict[str, Any]) -> list[str]:
    """The plain words a reader needs to trust an import.

    The notes say what the baseline declared, what was actually imported, and
    -- when the two differ -- why. They also name the fields the baseline
    never retained, because a reader who compares the dataset against the
    baseline needs to know which columns the baseline simply did not have.
    """
    notes: list[str] = []
    declared_runs = reconciliation.get("declared_enabled_runs")
    declared_prs = reconciliation.get("declared_distinct_prs")
    imported = reconciliation.get("records_imported") or 0
    imported_prs = reconciliation.get("distinct_prs_imported") or 0
    if isinstance(declared_runs, int) and isinstance(declared_prs, int):
        if declared_runs == imported and declared_prs == imported_prs:
            notes.append(
                f"the baseline declared {declared_runs} enabled runs across "
                f"{declared_prs} pull requests, and {imported} records across "
                f"{imported_prs} pull requests were imported: the import "
                "reconciles exactly with the baseline's own window."
            )
        else:
            notes.append(
                f"the baseline declared {declared_runs} enabled runs across "
                f"{declared_prs} pull requests, but {imported} records across "
                f"{imported_prs} pull requests were imported: the difference "
                "is the skipped runs, counted under skip_reasons."
            )
    else:
        notes.append(
            f"the baseline declared no window counts, and {imported} records "
            f"across {imported_prs} pull requests were imported."
        )
    skipped = reconciliation.get("records_skipped") or 0
    if skipped:
        reasons = reconciliation.get("skip_reasons") or {}
        detail = ", ".join(f"{count} {reason}" for reason, count in sorted(reasons.items()))
        notes.append(
            f"{skipped} runs were skipped and counted, never dropped: {detail}."
        )
    notes.append(
        "the baseline retained the verifier's status, score, risk band, model, "
        "latency and concern count, and the head, base, diff and config pins; "
        "it retained no published review id, no verifier reason text, no "
        "provider token usage, no rubric version and no parser notes, so the "
        "legacy vocabulary names each of those and says where the value lives."
    )
    return notes


# ---------------------------------------------------------------------------
# The document and the summary
# ---------------------------------------------------------------------------


def merged_vocabulary() -> dict[str, str]:
    """The document's vocabulary of every unavailable reason a record can name.

    The published vocabulary and the legacy vocabulary are disjoint by
    construction -- the legacy keys are prefixed -- so the merged mapping
    never loses a key to a collision.
    """
    return {**PUBLISHED_UNAVAILABLE_REASONS, **LEGACY_UNAVAILABLE_REASONS}


def build_document(
    repository: str,
    records: list[dict[str, Any]],
    now: str,
    collections: list[dict[str, Any]],
    notes: list[str],
    reconciliation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The dataset document.

    Deterministic for a given input: the records are sorted, the collection
    log keeps the newest entries, and the notes are bounded.

    The baseline reconciliation is kept IN the document, not only in the
    summary of the run that imported it: a later live collection folds into
    the same dataset, and the reader of that dataset still has to see how
    much of the historical baseline it holds.
    """
    return {
        "schema": SCHEMA,
        "repository": repository,
        "generated_at": now,
        "records": records,
        "unavailable_reasons": merged_vocabulary(),
        "legacy_reconciliation": reconciliation,
        "collections": collections[-MAX_COLLECTIONS:],
        "notes": notes[-MAX_NOTES:],
    }


def build_summary(
    repository: str,
    records: list[dict[str, Any]],
    now: str,
    reconciliation: dict[str, Any] | None,
    notes: list[str],
) -> dict[str, Any]:
    """The run-window summary of the retained dataset.

    The summary counts what the retained attempts carry. It carries NO
    judgment -- no pass/fail verdict, no score threshold and no gate advice
    -- because the adjudication of the verifier's authority lives in #1450
    and a summary that scored itself would prejudge it.
    """
    status_counts = {"scored": 0, "unscored": 0, "disabled": 0, "unknown": 0}
    cause_counts: dict[str, int] = {}
    model_counts: dict[str, int] = {}
    review_result_counts: dict[str, int] = {}
    challenges = {
        "materially_challenged": 0,
        "clean_unchallenged": 0,
        "clean_challenged": 0,
        "not_assessed": 0,
    }
    coverage = {
        "latency_published": 0,
        "latency_missing": 0,
        "token_usage_published": 0,
        "token_usage_missing": 0,
        "cause_published": 0,
        "cause_missing": 0,
    }
    sources = {"forge-read": 0, "legacy-import": 0}
    per_pr: dict[int, int] = {}
    first_publication: str | None = None
    last_publication: str | None = None
    first_value: float | None = None
    last_value: float | None = None

    for record in records:
        verifier = record.get("verifier") or {}
        status = verifier.get("status")
        if not isinstance(status, str) or status == "":
            status = "unknown"
        status_counts[status] = status_counts.get(status, 0) + 1
        cause = verifier.get("cause")
        if isinstance(cause, str) and cause != "":
            cause_counts[cause] = cause_counts.get(cause, 0) + 1
        model = verifier.get("model")
        key = model if isinstance(model, str) and model != "" else "unset"
        model_counts[key] = model_counts.get(key, 0) + 1
        review_result = record.get("review_result")
        if isinstance(review_result, str) and review_result != "":
            review_result_counts[review_result] = (
                review_result_counts.get(review_result, 0) + 1
            )
        challenged = verifier.get("materially_challenges_primary")
        if challenged is True:
            challenges["materially_challenged"] += 1
            if review_result == "clean":
                challenges["clean_challenged"] += 1
        elif challenged is False:
            if review_result == "clean":
                challenges["clean_unchallenged"] += 1
        else:
            challenges["not_assessed"] += 1
        if verifier.get("latency_ms") is None:
            coverage["latency_missing"] += 1
        else:
            coverage["latency_published"] += 1
        if verifier.get("token_usage") is None:
            coverage["token_usage_missing"] += 1
        else:
            coverage["token_usage_published"] += 1
        if verifier.get("cause") is None:
            coverage["cause_missing"] += 1
        else:
            coverage["cause_published"] += 1
        source = record.get("source")
        if isinstance(source, str) and source in sources:
            sources[source] += 1
        number = int(record.get("pr_number") or 0)
        per_pr[number] = per_pr.get(number, 0) + 1
        published_at = (record.get("attempt") or {}).get("published_at")
        if isinstance(published_at, str) and published_at != "":
            value = instant_sort_value(published_at)
            if first_value is None or value < first_value:
                first_value = value
                first_publication = published_at
            if last_value is None or value > last_value:
                last_value = value
                last_publication = published_at

    prs = len(per_pr)
    records_count = len(records)
    attempts = {
        "max_per_pr": max(per_pr.values()) if per_pr else 0,
        "prs_with_multiple_attempts": sum(1 for count in per_pr.values() if count > 1),
        "mean_per_pr": round(records_count / prs, 2) if prs else 0.0,
    }
    return {
        "schema": SUMMARY_SCHEMA,
        "generated_at": now,
        "repository": repository,
        "window": {
            "first_publication": first_publication,
            "last_publication": last_publication,
            "records": records_count,
            "prs": prs,
        },
        "verifier_status": status_counts,
        "causes": dict(sorted(cause_counts.items())),
        "models": dict(sorted(model_counts.items())),
        "primary_review_result": dict(sorted(review_result_counts.items())),
        "challenges": challenges,
        "coverage": coverage,
        "attempts": attempts,
        "sources": sources,
        "legacy_reconciliation": reconciliation,
        "unavailable_reasons": merged_vocabulary(),
        "notes": notes[-MAX_NOTES:],
    }


# ---------------------------------------------------------------------------
# Notes
# ---------------------------------------------------------------------------


def bound_note(text: str) -> str:
    """One bounded, single-line note.

    A note is read by a human in a diff, so it is collapsed to one line and
    capped: a note that grew without bound would make the document itself
    unbounded.
    """
    collapsed = " ".join(str(text).split())
    if len(collapsed) > MAX_NOTE_CHARS:
        collapsed = collapsed[: MAX_NOTE_CHARS - 1] + "…"
    return collapsed


def bounded_notes(notes: list[str], limit: int) -> list[str]:
    """The notes that fit, with a note about the ones that did not."""
    bounded = [bound_note(note) for note in notes]
    if len(bounded) <= limit:
        return bounded
    kept = bounded[: limit - 1]
    kept.append(
        f"{len(bounded) - (limit - 1)} further notes were omitted to keep the "
        "document bounded."
    )
    return kept


# ---------------------------------------------------------------------------
# The dataset file
# ---------------------------------------------------------------------------


def load_dataset(path: Path | None) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """The loaded dataset document and its records, keyed by identity.

    A missing file starts an empty dataset. A file whose schema is not this
    collector's is REFUSED: another schema is never silently migrated or
    reinterpreted, because a document that was migrated by accident looks
    complete and is not.
    """
    if path is None or not path.exists():
        return {}, {}
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise CliError("cannot read the dataset file") from exc
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise CliError("the dataset file is not valid JSON") from exc
    if not isinstance(document, dict):
        raise CliError("the dataset file is not a dataset document")
    schema = document.get("schema")
    if schema != SCHEMA:
        raise CliError(
            f"the dataset file has another schema: {str(schema)[:MAX_SCHEMA_CHARS]!r}"
        )
    records = document.get("records")
    if records is None:
        records = []
    if not isinstance(records, list):
        raise CliError("the dataset file carries no record list")
    indexed: dict[str, dict[str, Any]] = {}
    for record in records:
        if not isinstance(record, dict):
            raise CliError("the dataset file carries a record that is not an object")
        identity = record.get("identity")
        if not isinstance(identity, str) or identity == "":
            raise CliError("the dataset file carries a record without an identity")
        if identity in indexed:
            raise CliError("the dataset file carries two records with one identity")
        indexed[identity] = record
    return document, indexed


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


class _QuietParser(argparse.ArgumentParser):
    """An argument parser whose error message never repeats a rejected value.

    argparse's default error text repeats the offending token, so a caller
    that passes a credential by mistake would put it in the log. The failure
    is reported without the value.
    """

    def error(self, message: str) -> None:  # noqa: ARG002
        raise CliError("invalid arguments")


def build_parser() -> argparse.ArgumentParser:
    """The command line of the dataset collector."""
    parser = _QuietParser(
        prog="confidence_dogfood_dataset.py",
        description=(
            "Collect every published verifier attempt per pull request into "
            "an incremental, idempotent dataset. Forge reads only, through "
            "the configured forge capability."
        ),
    )
    parser.add_argument("--repo", required=True, help="OWNER/NAME of the repository")
    parser.add_argument(
        "--pr",
        action="append",
        default=[],
        metavar="N",
        help="pull request number (repeatable)",
    )
    parser.add_argument(
        "--all-prs",
        action="store_true",
        help="read the repository's pull request list instead of naming them",
    )
    parser.add_argument(
        "--import-legacy",
        type=Path,
        default=None,
        metavar="PATH",
        help="import a historical baseline file instead of reading the forge",
    )
    parser.add_argument(
        "--dataset",
        type=Path,
        default=None,
        metavar="PATH",
        help="dataset file to load and update in place",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        metavar="PATH",
        help=(
            "dataset file to write (default: the --dataset file, else stdout)"
        ),
    )
    parser.add_argument(
        "--summary",
        type=Path,
        default=None,
        metavar="PATH",
        help="run-window summary file to write",
    )
    parser.add_argument(
        "--pr-state",
        choices=("open", "closed", "all"),
        default="all",
        help="state of the pull requests to read (default: all)",
    )
    parser.add_argument(
        "--max-prs",
        type=int,
        default=DEFAULT_MAX_PRS,
        metavar="N",
        help="pull requests read per collection (default: 50)",
    )
    parser.add_argument(
        "--max-attempts-per-pr",
        type=int,
        default=DEFAULT_MAX_ATTEMPTS_PER_PR,
        metavar="N",
        help="published attempts retained per pull request (default: 50)",
    )
    parser.add_argument(
        "--max-records",
        type=int,
        default=DEFAULT_MAX_RECORDS,
        metavar="N",
        help="records the merged dataset may hold (default: 5000)",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=DEFAULT_MAX_PAGES,
        metavar="N",
        help="pages read per list endpoint (default: 20)",
    )
    parser.add_argument(
        "--now",
        default=None,
        metavar="ISO8601",
        help="timestamp used for the run (default: now, UTC)",
    )
    return parser


def validate(args: argparse.Namespace) -> dict[str, Any]:
    """Reject every malformed input before a request goes out."""
    if not valid_repo(args.repo):
        raise CliError("invalid --repo")
    if args.pr and args.all_prs:
        raise CliError("--pr and --all-prs cannot be combined")
    if args.import_legacy is not None and (args.pr or args.all_prs):
        raise CliError("--import-legacy cannot be combined with --pr or --all-prs")
    numbers: list[int] = []
    for value in args.pr:
        if not NUMBER_RE.match(value) or int(value) <= 0:
            raise CliError("invalid --pr")
        numbers.append(int(value))
    for name, bound in (
        ("--max-prs", args.max_prs),
        ("--max-attempts-per-pr", args.max_attempts_per_pr),
        ("--max-records", args.max_records),
        ("--max-pages", args.max_pages),
    ):
        if not valid_bound(bound):
            raise CliError(f"invalid {name}")
    now = normalize_instant(args.now) if args.now is not None else None
    if args.now is not None and now is None:
        raise CliError("invalid --now")
    if now is None:
        now = normalize_instant(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    assert now is not None
    return {"numbers": numbers, "now": now}


def write_json(payload: dict[str, Any], out: Path | None) -> None:
    """One JSON document, to a file or to stdout."""
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    if out is None:
        sys.stdout.write(text)
        return
    if out.parent and not out.parent.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    """Collect the dataset and write it out.

    Returns the exit code: ``0`` success, ``1`` partial (one pull request
    could not be read), ``2`` the run could not happen.
    """
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
        plan = validate(args)
    except CliError as exc:
        print(f"confidence_dogfood_dataset: {exc}", file=sys.stderr)
        return EXIT_ERROR
    repository = args.repo
    now = plan["now"]
    try:
        loaded, indexed = load_dataset(args.dataset)
    except CliError as exc:
        print(f"confidence_dogfood_dataset: {exc}", file=sys.stderr)
        return EXIT_ERROR

    # Where the merged dataset goes. An explicit ``--out`` wins; otherwise
    # the dataset file is updated IN PLACE (that is what makes the
    # collection incremental), and a run with no file at all prints the
    # document to stdout.
    out_target = args.out if args.out is not None else args.dataset

    # Dataset-only mode: nothing was collected, so the document is written
    # back exactly as it was loaded. No record is marked absent and no
    # collection entry is appended -- a run that collected nothing must not
    # pretend that the attempts it did not look for are gone.
    if not args.pr and not args.all_prs and args.import_legacy is None:
        records = sorted(indexed.values(), key=record_sort_key)
        document = dict(loaded)
        if not document:
            document = build_document(repository, records, now, [], list(DATASET_NOTES))
        # The reconciliation the dataset already holds is reported again: a
        # summary of the retained dataset must say how much of the
        # historical baseline it holds, whoever collected it.
        held = document.get("legacy_reconciliation")
        try:
            write_json(document, out_target)
            if args.summary is not None:
                summary_notes = list(SUMMARY_NOTES)
                if isinstance(held, dict):
                    summary_notes.extend(reconciliation_notes(held))
                write_json(
                    build_summary(
                        repository,
                        records,
                        now,
                        held if isinstance(held, dict) else None,
                        summary_notes,
                    ),
                    args.summary,
                )
        except OSError:
            print(
                "confidence_dogfood_dataset: cannot write the dataset file",
                file=sys.stderr,
            )
            return EXIT_ERROR
        return EXIT_OK

    observations: list[dict[str, Any]] = []
    collection_notes: list[str] = []
    reconciliation: dict[str, Any] | None = None
    failed = False
    # The pull requests whose publication surface this run actually read.
    # Only those may have their retained attempts marked absent.
    covered_prs: set[int] = set()

    if args.import_legacy is not None:
        try:
            observations, reconciliation, notes, covered_prs = import_legacy(
                args.import_legacy, repository, now
            )
        except CliError as exc:
            print(f"confidence_dogfood_dataset: {exc}", file=sys.stderr)
            return EXIT_ERROR
        collection_notes.extend(notes)
        reconciliation["notes"] = reconciliation_notes(reconciliation)
        mode = "legacy-import"
        source = "legacy"
        prs_requested = reconciliation.get("distinct_prs_imported") or 0
    else:
        try:
            forge = default_forge()
        except ForgeError as exc:
            print(f"confidence_dogfood_dataset: {exc}", file=sys.stderr)
            return EXIT_ERROR
        numbers = list(plan["numbers"])
        if args.all_prs:
            try:
                listed, notes = enumerate_pull_requests(
                    forge,
                    repository,
                    args.pr_state,
                    args.max_prs,
                    args.max_pages,
                )
            except ForgeError as exc:
                print(f"confidence_dogfood_dataset: {exc}", file=sys.stderr)
                return EXIT_ERROR
            collection_notes.extend(notes)
            numbers = listed[: args.max_prs]
            source = "all-prs"
        else:
            source = "pr"
            if len(numbers) > args.max_prs:
                collection_notes.append(
                    f"only the first {args.max_prs} of the {len(numbers)} "
                    "requested pull requests were read (the --max-prs bound)"
                )
                numbers = numbers[: args.max_prs]
        observations, notes, failed, covered_prs = collect_from_forge(
            forge,
            repository,
            numbers,
            args.max_attempts_per_pr,
            args.max_pages,
            now,
        )
        collection_notes.extend(notes)
        mode = "forge-read"
        prs_requested = len(numbers)

    # The merge: an observed attempt is inserted when it is new and updated
    # in place when it is known. Nothing is ever deleted.
    observed_identities: set[str] = set()
    added = 0
    updated = 0
    for observation in observations:
        identity = observation["identity"]
        observed_identities.add(identity)
        previous = indexed.get(identity)
        if previous is None:
            indexed[identity] = observation
            added += 1
        else:
            indexed[identity] = merge_observation(previous, observation, now)
            updated += 1

    absent = 0
    for identity, record in indexed.items():
        if identity in observed_identities:
            continue
        # Absence is asserted only where this collection actually read the
        # pull request's publication surface. A run that covered other pull
        # requests says nothing about this one's publications, so a bounded
        # collection never marks the rest of the dataset absent.
        if record.get("pr_number") not in covered_prs:
            continue
        attempt = dict(record.get("attempt") or {})
        attempt["absent_in_latest_collection"] = True
        record = dict(record)
        record["attempt"] = attempt
        indexed[identity] = record
        absent += 1

    records = sorted(indexed.values(), key=record_sort_key)
    if len(records) > args.max_records:
        print(
            "confidence_dogfood_dataset: the merged dataset would hold "
            f"{len(records)} records, more than the --max-records bound of "
            f"{args.max_records}",
            file=sys.stderr,
        )
        return EXIT_ERROR

    # The reconciliation the dataset reports is the one this run produced,
    # or -- when this run only folded new evidence into the dataset -- the
    # one an earlier import left in it. The reader of the dataset always
    # learns how much of the historical baseline it holds.
    held_reconciliation = reconciliation
    if held_reconciliation is None:
        loaded_reconciliation = (loaded or {}).get("legacy_reconciliation")
        if isinstance(loaded_reconciliation, dict):
            held_reconciliation = loaded_reconciliation

    notes = list(DATASET_NOTES)
    if held_reconciliation is not None:
        notes.extend(reconciliation_notes(held_reconciliation))
        notes.append(
            "the legacy baseline was imported as "
            f"{held_reconciliation.get('records_imported')} records across "
            f"{held_reconciliation.get('distinct_prs_imported')} pull requests; "
            "the reconciliation is reported in the run summary."
        )
    collections = loaded.get("collections") if loaded else None
    collections = list(collections) if isinstance(collections, list) else []
    collections.append(
        {
            "collected_at": now,
            "mode": mode,
            "source": source,
            "prs_requested": prs_requested,
            "records_seen": len(observations),
            "records_added": added,
            "records_updated": updated,
            "records_absent": absent,
            "notes": bounded_notes(collection_notes, MAX_COLLECTION_NOTES),
        }
    )
    document = build_document(
        repository, records, now, collections, notes, held_reconciliation
    )
    try:
        write_json(document, out_target)
        if args.summary is not None:
            summary_notes = list(SUMMARY_NOTES)
            if held_reconciliation is not None:
                summary_notes.extend(reconciliation_notes(held_reconciliation))
            write_json(
                build_summary(
                    repository, records, now, held_reconciliation, summary_notes
                ),
                args.summary,
            )
    except OSError:
        print(
            "confidence_dogfood_dataset: cannot write the dataset file",
            file=sys.stderr,
        )
        return EXIT_ERROR
    return EXIT_PARTIAL if failed else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
