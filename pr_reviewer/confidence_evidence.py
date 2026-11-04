"""Shared parsing of the merge-safety verifier's PUBLISHED record (#1479).

The merge-safety verifier publishes exactly three things a human can read
after an ordinary dogfood run: the metadata marker, the sibling fingerprint
marker, and the ``## Independent Confidence`` section inside the review body
it posted. Reading that publication is PURE parsing -- no network, no
verdict, no state -- so it lives here, in the shared library, instead of
inside one collector script.

The published surface is a CONTRACT: the renderer's quoting and escaping, the
verifier's closed vocabularies, the marker's telemetry keys and the
fingerprint's stored shape can all change under the collectors. Two parsers
of one contract drift apart, and the drift is silent -- a collector that
misreads the publication reports evidence that was never published. So the
parsing lives in ONE place and every collector reads it from here.

Everything this module returns is BOUNDED and REDACTED BY CONSTRUCTION: each
string is capped, passes through the repository's own URL redactor
(:func:`pr_reviewer.http_safe.redact_urls_in_text`), and is refused outright
when it carries the configured bearer token, so a credential-shaped value in
a published comment can never be copied verbatim into a collected artifact.

The module reads only what is already published: it never re-runs the
verifier, never recomputes a score and never changes a verdict.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Iterable

from pr_reviewer.forge import ForgeClient
from pr_reviewer.http_safe import redact_urls_in_text
from pr_reviewer.metadata import parse_metadata

# The published section's shape (``src/publish/publish.ts``'s
# ``renderIndependentConfidenceBlock``). The renderer writes the head line
# first, then a BARE ``>`` separator line before every quoted line that
# follows it (the reason and each concern bullet), and closes the section
# with a bare separator plus an UNQUOTED advisory note -- the note is not
# part of the quoted block and must never be recorded.
_HEAD_RE = re.compile(
    r"^\*\*Independent confidence:\s*(?P<rest>.*?)\*\*\s*"
    r"(?:\(model:\s*(?P<model>.*)\))?\s*$"
)
_SCORE_RE = re.compile(r"^(?P<score>[0-5])/5,\s*risk:\s*(?P<risk>.*)$")
# The action-owned status labels (``CONFIDENCE_STATUS_LABELS``). The
# unscored label is the WHOLE sentence the renderer prints, em dash
# included; a head carrying it publishes neither a score nor a risk band.
# The scored label is published only when the score is not a single digit,
# which the publisher's own output never produces (the score output is
# "0".."5" or "").
_SCORED_LABEL = "scored"
_UNSCORED_LABEL = "unscored — the verifier did not produce a usable result"
_CONCERN_PREFIX = "- Advisory concern"
_ADVISORY_NOTE_PREFIX = "_Advisory only:"
_EVIDENCE_SEPARATOR = " — "  # em dash, as the renderer writes it
_LOCATION_RE = re.compile(r"^(?P<file>.*?)(?::(?P<line>[0-9]+))?$")

# The published table-cell escape (``src/gates/ci-wait.ts``'s
# ``escapeTableCell``): backslash first, then pipe, then backtick, then the
# HTML entities. The entities are decoded in ONE pass, so a decoded ``&``
# is never re-scanned -- otherwise a value that literally reads ``&lt;``
# (published as ``&amp;lt;``) would lose its own escaping and read as
# ``<``.
_ENTITY_RE = re.compile(r"&(?:amp|lt|gt);")
_ENTITIES = {"&amp;": "&", "&lt;": "<", "&gt;": ">"}

# The published fingerprint marker (``src/metadata/markers.ts``'s
# ``emitReviewMarkers``) and the value it stores: ``{diff_fp}|cfg:
# {config_hash}`` (``src/precheck/fingerprint.ts``'s
# ``buildMarkerFingerprint``). The action's own parser
# (``parseMarkerFingerprints``) reads only the FIRST marker line and only
# an exact line match; this mirrors that grammar exactly, because
# ``pr_reviewer.metadata`` has no fingerprint parser of its own.
_FINGERPRINT_MARKER_RE = re.compile(r"^<!-- ai-pr-review-fingerprint:([^>]*) -->$")
_FINGERPRINT_CONFIG_MARKER = "|cfg:"

# The verifier's closed vocabularies (``src/confidence/result.ts``). Nothing
# outside them is ever recorded: a malformed token degrades to "unknown" or
# to an absent field, never to a new value.
RISK_VALUES = ("low", "medium", "high", "critical", "unknown")
CONCERN_TYPES = ("missed_issue", "unsupported_finding")
CONCERN_SEVERITIES = ("blocker", "major")

# The machine-token grammar the marker's own unscored-cause key obeys
# (``src/confidence/telemetry.ts``'s CONFIDENCE_CAUSE_TOKEN_PATTERN): a
# published cause is a short lowercase token like ``timeout`` or
# ``http_429``, never provider text. The grammar is enforced again at the
# published surface (``src/metadata/markers.ts``), and the collector
# re-checks it so nothing outside the vocabulary is ever recorded.
CAUSE_TOKEN_RE = re.compile(r"^[a-z0-9_]{1,64}$")

# The published section shows at most 8 advisory concerns; the collector
# keeps that bound.
MAX_CONCERNS = 8

# Field bounds. Every string that reaches the evidence file is capped here.
MAX_HEAD_SHA = 200
MAX_REVIEW_RESULT = 200
MAX_REQUIRED_CHECKS = 200
MAX_REASON = 300
MAX_MODEL = 120
MAX_FILE = 200
MAX_EVIDENCE = 300
MAX_FINGERPRINT = 200
MAX_TIMESTAMP = 64

# The marker for a value refused by the credential gate. A fixed string, so
# the evidence file never carries the value it refused.
REDACTED = "[REDACTED]"

# What the PUBLISHED record does not carry, and where each value actually
# lives. Every sentence below is TRUE whenever it appears: a reason is
# removed exactly when a valid published value is recorded in its place, so
# a published value is never called unavailable, and an artifact that does
# not exist is never named. Since #1455 the marker publishes the unscored
# cause, the verifier latency and the token usage when the run measured
# them; a body published by an older action (or a run that measured none of
# it) keeps the old explanation.
UNAVAILABLE_REASONS: dict[str, str] = {
    "unscored_cause": (
        "The unscored cause is written into the run-directory artifact "
        "confidence-score.json and the runner log; the marker publishes it "
        "(confidence_cause) only for an unscored run, and this record "
        "carries no published cause."
    ),
    "latency_ms": (
        "No verifier latency is measured for this run: the marker publishes "
        "confidence_latency_ms only when the run's provider attempt was "
        "timed (#1455), and this record carries no published latency; the "
        "run-directory artifact confidence-score.json records no timing "
        "either."
    ),
    "token_usage": (
        "The provider's usage is normalized by the transport and reaches "
        "the published marker only through the scorer's telemetry "
        "(confidence_prompt_tokens, confidence_completion_tokens, "
        "confidence_total_tokens, #1455); this record carries no published "
        "usage, so the raw run-directory artifact confidence-response.json "
        "remains the only home for it."
    ),
    "rubric_version": (
        "The rubric version constant is written only into the run-directory "
        "artifact confidence-score.json; it reaches the published record "
        "only indirectly, through the config hash in the fingerprint marker."
    ),
    "deterministic_caps": (
        "The deterministic ceilings are recorded as structured tokens only "
        "in the run-directory artifact confidence-score.json; the published "
        "reason carries at most the appended note that names them."
    ),
    "parser_notes": (
        "The action-owned parser notes (a dropped concern, a malformed risk) "
        "are recorded in the run-directory artifact confidence-score.json and "
        "never reach the published body."
    ),
    "later_review_linkage": (
        "A later review's finding outcome is recorded only in the "
        "run-directory artifact finding-outcomes.json, which carries no "
        "reference to the verifier's answer, so nothing published links a "
        "later finding to the verifier."
    ),
}

NO_PUBLISHED_RECORD_REASON = (
    "No reviewer comment or review carrying the ai-pr-reviewer marker is "
    "published for this pull request, so there is no published record to read."
)
NO_PUBLISHED_SECTION_REASON = (
    "The published reviewer body carries no '## Independent Confidence' "
    "section, so the verifier published nothing for this run."
)
NO_PUBLISHED_FINGERPRINT_REASON = (
    "The published reviewer body carries no ai-pr-review-fingerprint marker, "
    "so it publishes neither the diff fingerprint nor the config hash."
)


# ---------------------------------------------------------------------------
# Pure helpers (unit-testable without any network access)
# ---------------------------------------------------------------------------


def safe_text(value: object, cap: int, token: str) -> str:
    """A bounded, redacted copy of one extracted string.

    Three rails, in this order:

    - the repository's own URL redactor (:func:`redact_urls_in_text`) masks
      the userinfo of every absolute URL, so an endpoint that carries a
      credential cannot be copied verbatim;
    - the credential gate refuses the WHOLE value when it carries the
      configured bearer token. Shape validation is not proof here: a hostile
      forge can reflect the credential it was given into any published
      string, and a token is an arbitrary string, so the only safe test is
      containment;
    - the cap bounds what the evidence file can carry.
    """
    if not isinstance(value, str):
        return ""
    text = redact_urls_in_text(value)
    if token and token in text:
        return REDACTED
    if len(text) > cap:
        text = text[:cap]
    return text


def unescape_table_cell(text: str) -> str:
    """Undo the published table-cell escaping of one value.

    The renderer escapes a published value for its surface
    (``escapeTableCell``: backslash, then pipe, then backtick, then the
    HTML entities). The escape is reversible, so the recovered value is the
    value the verifier actually reported.

    The backslash escapes are undone first, in the reverse of the order the
    renderer applied them, so an escaped pipe can never be mistaken for an
    escaped backslash. The entities are decoded LAST and in ONE pass: the
    renderer encodes ``&`` first of the entity group, so a value that
    literally reads ``&lt;`` is published as ``&amp;lt;``. A sequential
    decode of ``&amp;`` before ``&lt;`` would re-decode the ``&`` it had
    just produced and turn the literal ``&lt;`` into ``<``; a single pass
    cannot, because a replacement is never re-scanned.
    """
    decoded = (
        text.replace("\\`", "`")
        .replace("\\|", "|")
        .replace("\\\\", "\\")
    )
    return _ENTITY_RE.sub(lambda match: _ENTITIES[match.group(0)], decoded)


def extract_confidence_section(body: str) -> list[str] | None:
    """The quoted content lines of the published ``## Independent Confidence``
    section.

    Returns ``None`` when the body publishes no such section -- a missing
    section is not an error, it means the verifier published nothing. The
    section runs from its heading to the next heading, and only the quoted
    lines inside it are returned.

    A bare ``>`` line is a SEPARATOR, not content: the renderer writes one
    before the reason and before every concern bullet. Skipping it is what
    makes the reason readable at all -- a separator read as an empty line
    would stop the reason at the first separator and record nothing.

    The section ends at the renderer's closing advisory note (the last line
    the section writes) or at the next heading, whichever comes first. The
    note bound matters: the model's own markdown is published AFTER the
    section, and a quoted line in that markdown must never be read as the
    verifier's reason.
    """
    lines = body.split("\n")
    start = None
    for index, line in enumerate(lines):
        if line.strip() == "## Independent Confidence":
            start = index + 1
            break
    if start is None:
        return None
    quoted: list[str] = []
    for line in lines[start:]:
        stripped = line.strip()
        if stripped.startswith("#"):
            # The next heading ends the section.
            break
        if stripped.startswith(_ADVISORY_NOTE_PREFIX):
            # The closing advisory note ends the section. It is published
            # UNQUOTED, so it is never recorded.
            break
        if not stripped.startswith(">"):
            # Anything else outside the quoted block (the model's own
            # markdown, published after the section) is not the section's.
            continue
        content = stripped[1:].lstrip()
        if content == "":
            # A bare separator line.
            continue
        quoted.append(content)
    return quoted


def split_concern_kind(kind: str) -> tuple[str | None, str | None]:
    """The closed-vocabulary type and severity of one published concern.

    The renderer writes the two tokens comma-separated and only when each
    matches its enum exactly, so the two vocabularies are disjoint and a
    token identifies its own field. An unrecognized token is absent, never
    a new value.
    """
    concern_type: str | None = None
    severity: str | None = None
    for token in (part.strip() for part in kind.split(",")):
        if token == "":
            continue
        if token in CONCERN_TYPES and concern_type is None:
            concern_type = token
        elif token in CONCERN_SEVERITIES and severity is None:
            severity = token
    return concern_type, severity


def split_concern_location(location: str) -> tuple[str, int | None]:
    """The file path and the line number of one published concern location.

    The renderer writes ``<file>`` followed by ``:<line>`` only when the
    verifier pinned a line. The split takes the trailing ``:<digits>`` as
    the line, so a path that itself contains a colon is not misread.
    """
    if location == "":
        return "", None
    match = _LOCATION_RE.match(location)
    if match is None:
        return location, None
    line_text = match.group("line")
    line = int(line_text) if line_text is not None else None
    return match.group("file"), line


def parse_concern(line: str, token: str) -> dict[str, Any]:
    """One bounded advisory concern, parsed from its published bullet.

    The published bullet is ``- Advisory concern`` plus the optional
    ``({type}, {severity})`` kind, the optional `` at {file}{:line}``
    location, and the optional `` — {evidence}`` text.
    """
    rest = line[len(_CONCERN_PREFIX):]
    kind = ""
    if rest.startswith(" ("):
        end = rest.find(")")
        if end != -1:
            kind = rest[2:end]
            rest = rest[end + 1:]
    location = ""
    if rest.startswith(" at "):
        separator = rest.find(_EVIDENCE_SEPARATOR)
        if separator == -1:
            location = rest[4:]
            rest = ""
        else:
            location = rest[4:separator]
            rest = rest[separator:]
    evidence = ""
    if rest.startswith(_EVIDENCE_SEPARATOR):
        evidence = rest[len(_EVIDENCE_SEPARATOR):]
    elif rest.strip() != "":
        evidence = rest.strip()
    concern_type, severity = split_concern_kind(kind)
    file_path, line_number = split_concern_location(location)
    return {
        "type": concern_type,
        "severity": severity,
        "file": safe_text(unescape_table_cell(file_path), MAX_FILE, token),
        "line": line_number,
        "evidence": safe_text(unescape_table_cell(evidence), MAX_EVIDENCE, token),
    }


def published_text(value: object, cap: int, token: str) -> str | None:
    """One published marker field, or ``None`` when it is not published.

    The marker omits a field it has nothing to say about, and an omitted
    field is absent evidence -- never an empty string that reads like a
    published value.
    """
    if not isinstance(value, str) or value == "":
        return None
    return safe_text(value, cap, token)


def empty_verifier(status: str = "unknown") -> dict[str, Any]:
    """The verifier block of a record that publishes no verifier answer."""
    return {
        "status": status,
        "score": None,
        "risk": "unknown",
        "reason": "",
        "model": "",
        "concerns": [],
        "materially_challenges_primary": None,
        "cause": None,
        "latency_ms": None,
        "token_usage": None,
    }


def parse_confidence_section(quoted: list[str], token: str) -> dict[str, Any]:
    """The verifier block parsed from the published section's quoted lines.

    The head line carries the status, the score, the risk band and the
    model; the next quoted line is the reason; each advisory bullet is a
    concern. A section that cannot be read leaves the status "unknown"
    rather than guessing.
    """
    verifier = empty_verifier()
    if not quoted:
        return verifier
    head = _HEAD_RE.match(quoted[0])
    if head is None:
        return verifier
    rest = head.group("rest").strip()
    verifier["model"] = safe_text(head.group("model") or "", MAX_MODEL, token)
    score = _SCORE_RE.match(rest)
    if score is not None:
        verifier["status"] = "scored"
        verifier["score"] = int(score.group("score"))
        risk = score.group("risk").strip()
        verifier["risk"] = risk if risk in RISK_VALUES else "unknown"
    elif rest == _UNSCORED_LABEL or rest.startswith("unscored "):
        # The unscored label is a fixed sentence, never a score: the
        # published run carries no score and no risk band of its own.
        verifier["status"] = "unscored"
    elif rest == _SCORED_LABEL:
        # The scored label is published only when the score was not a
        # single digit; the status is scored, the score is not readable.
        verifier["status"] = "scored"
    else:
        verifier["status"] = "unknown"
    # The reason is the first quoted line after the head that is not a
    # concern bullet. The closing advisory note is published unquoted, so
    # it never reaches this list; the prefix check is a belt-and-braces
    # skip, not the reason the note is absent.
    for line in quoted[1:]:
        if line.startswith(_CONCERN_PREFIX):
            continue
        if line.startswith(_ADVISORY_NOTE_PREFIX):
            continue
        verifier["reason"] = safe_text(unescape_table_cell(line), MAX_REASON, token)
        break
    for line in quoted:
        if not line.startswith(_CONCERN_PREFIX):
            continue
        verifier["concerns"].append(parse_concern(line, token))
        if len(verifier["concerns"]) >= MAX_CONCERNS:
            break
    if verifier["status"] == "scored":
        # The verifier materially challenges the primary review when it
        # published at least one concern of its own blocking severities.
        # Only a SCORED section can carry a challenge: an unscored answer
        # published no concern at all, so there is nothing to judge.
        verifier["materially_challenges_primary"] = any(
            concern["severity"] in CONCERN_SEVERITIES
            for concern in verifier["concerns"]
        )
    return verifier


def verifier_from_marker(marker: dict[str, Any]) -> dict[str, Any]:
    """The verifier block for a published body with no confidence section.

    The marker is the only published statement about the verifier's run
    when the section is missing: it carries ``confidence_status`` (and the
    score) only when the verifier ran. A marker without that key means the
    verifier never ran for this body.
    """
    verifier = empty_verifier()
    status = marker.get("confidence_status")
    if status in ("scored", "unscored"):
        verifier["status"] = str(status)
        if status == "scored":
            score = marker.get("confidence_score")
            if (
                isinstance(score, int)
                and not isinstance(score, bool)
                and 0 <= score <= 5
            ):
                verifier["score"] = score
        return verifier
    verifier["status"] = "disabled"
    return verifier


def consume_marker_telemetry(
    marker: dict[str, Any],
    verifier: dict[str, Any],
    unavailable: dict[str, str],
) -> dict[str, Any]:
    """The verifier telemetry the metadata marker publishes (#1455).

    The marker carries ``confidence_cause``, ``confidence_latency_ms`` and
    the three ``confidence_*_tokens`` keys when the run measured them; each
    corresponding unavailable reason is removed only when a valid published
    value is recorded in its place, so a body published by an older action
    keeps the old unavailable behavior.

    The published grammar is enforced again here -- nothing outside it is
    ever recorded: a cause must match the machine-token vocabulary
    (:data:`CAUSE_TOKEN_RE`), and the latency and the token counts must be
    non-negative integers. A cause additionally rides the score's coupling
    the publisher enforces (``src/confidence/telemetry.ts``:
    ``confidenceTelemetryOf``) -- a cause explains a MISSING score -- so it
    is consumed only when the marker's own ``confidence_status`` claims
    ``unscored`` and the collected answer does not claim ``scored``; a
    scored run is never read as carrying a cause.
    """
    cause = marker.get("confidence_cause")
    if (
        isinstance(cause, str)
        and CAUSE_TOKEN_RE.match(cause) is not None
        and marker.get("confidence_status") == "unscored"
        and verifier.get("status") != "scored"
    ):
        verifier["cause"] = cause
        unavailable.pop("unscored_cause", None)

    latency = marker.get("confidence_latency_ms")
    if isinstance(latency, int) and not isinstance(latency, bool) and latency >= 0:
        verifier["latency_ms"] = latency
        unavailable.pop("latency_ms", None)

    usage: dict[str, int] = {}
    for key, field in (
        ("confidence_prompt_tokens", "prompt_tokens"),
        ("confidence_completion_tokens", "completion_tokens"),
        ("confidence_total_tokens", "total_tokens"),
    ):
        value = marker.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            usage[field] = value
    if usage:
        verifier["token_usage"] = usage
        unavailable.pop("token_usage", None)

    return verifier


def parse_published_fingerprint(body: str) -> str | None:
    """The published fingerprint marker's value, or ``None``.

    The marker sits alongside the metadata marker in the published body
    (``src/metadata/markers.ts``). Only the FIRST marker line counts and
    only an exact line match does -- the same grammar the action's own
    ``parseMarkerFingerprints`` reads with.
    """
    for line in body.split("\n"):
        match = _FINGERPRINT_MARKER_RE.match(line)
        if match is not None:
            return match.group(1)
    return None


def split_published_fingerprint(value: str) -> tuple[str, str | None]:
    """The diff fingerprint and the config hash of one stored fingerprint.

    The stored value is ``{diff_fp}|cfg:{config_hash}``; the diff half is a
    digest (or the ``empty-diff`` placeholder) and never carries the
    delimiter, so the first ``|cfg:`` is the separator. A value without it
    carries no config hash.
    """
    diff_fp, separator, config_hash = value.partition(_FINGERPRINT_CONFIG_MARKER)
    if separator == "":
        return value, None
    return diff_fp, config_hash


def published_instant(item: dict[str, Any], kind: str) -> datetime:
    """When one published body was submitted.

    A native review carries only ``submitted_at`` -- the GitHub review
    object has no ``updated_at`` and no ``created_at`` -- so a review is
    timed by the timestamp its submission wrote and by nothing else. A
    managed comment is rewritten in place, so ``updated_at`` wins over
    ``created_at``: its update time is the run that wrote it. An unparsable
    or absent timestamp sorts oldest, so a body with no provable time never
    outranks one with a provable newer time.
    """
    if kind == "review":
        raw = item.get("submitted_at")
    else:
        raw = item.get("updated_at") or item.get("created_at")
    if not isinstance(raw, str) or raw.strip() == "":
        return datetime.min.replace(tzinfo=timezone.utc)
    text = raw.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def published_id(item: dict[str, Any]) -> int | None:
    """The forge's own id of one published body, when it reports one."""
    value = item.get("id")
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def published_body_descriptor(
    kind: str, item: dict[str, Any], token: str
) -> dict[str, Any]:
    """Which published body the evidence came from.

    A reader has to be able to tell which run a record describes: the
    managed comment is rewritten in place, while a native review is one
    more review in an accumulating sequence -- and is timed by its
    ``submitted_at``, the only timestamp a GitHub review object carries.
    Every value is bounded and redacted like every other collected string;
    a timestamp the body's kind does not carry stays ``None``.
    """
    return {
        "kind": kind,
        "id": published_id(item),
        "created_at": published_text(item.get("created_at"), MAX_TIMESTAMP, token),
        "updated_at": published_text(item.get("updated_at"), MAX_TIMESTAMP, token),
        "submitted_at": published_text(item.get("submitted_at"), MAX_TIMESTAMP, token),
    }


def extract_published_evidence(body: str, token: str) -> dict[str, Any]:
    """Everything one published body carries, already bounded and redacted.

    This is the ONE reading of a published reviewer body: the marker, the
    published section and the sibling fingerprint marker, parsed with the
    published grammar and returned in the shape a record needs. Two
    collectors that each parsed the body themselves would drift apart from
    the publication, and the drift would be silent -- so both read it from
    here.

    The returned mapping carries exactly the published pins
    (``head_sha``, ``base_sha``, ``review_result``, ``required_checks``),
    the two fingerprint halves, the ``verifier`` block and the
    ``unavailable`` reasons. Every string in it is capped and redacted, and
    an absent value is ``None`` rather than an empty string that would read
    like a published one.

    The unavailable reasons are TRUE whenever they appear: a reason is
    removed exactly when a valid published value is recorded in its place,
    so a published value is never called unavailable.
    """
    marker = parse_metadata(body) or {}
    unavailable = dict(UNAVAILABLE_REASONS)
    quoted = extract_confidence_section(body)
    if not quoted:
        unavailable["published_verifier_section"] = NO_PUBLISHED_SECTION_REASON
        verifier = verifier_from_marker(marker)
    else:
        verifier = parse_confidence_section(quoted, token)
    verifier = consume_marker_telemetry(marker, verifier, unavailable)
    diff_fingerprint: str | None = None
    config_fingerprint: str | None = None
    fingerprint = parse_published_fingerprint(body)
    if fingerprint is None:
        unavailable["published_fingerprint"] = NO_PUBLISHED_FINGERPRINT_REASON
    else:
        diff_fp, config_hash = split_published_fingerprint(fingerprint)
        diff_fingerprint = published_text(diff_fp, MAX_FINGERPRINT, token)
        config_fingerprint = published_text(config_hash, MAX_FINGERPRINT, token)
    return {
        "head_sha": published_text(marker.get("head_sha"), MAX_HEAD_SHA, token),
        "base_sha": published_text(marker.get("base_sha"), MAX_HEAD_SHA, token),
        "review_result": published_text(
            marker.get("review_result"), MAX_REVIEW_RESULT, token
        ),
        "required_checks": published_text(
            marker.get("required_checks"), MAX_REQUIRED_CHECKS, token
        ),
        "diff_fingerprint": diff_fingerprint,
        "config_fingerprint": config_fingerprint,
        "verifier": verifier,
        "unavailable": unavailable,
    }


# ---------------------------------------------------------------------------
# Forge read access
# ---------------------------------------------------------------------------


def list_items(
    forge: ForgeClient, path: str, max_pages: int | None = None
) -> list[dict[str, Any]]:
    """Every item across the pages of one forge list endpoint.

    A bounded walk is available for a caller that must not page forever:
    ``max_pages`` caps how many pages are read (``None`` reads them all).
    The cap lives here rather than in each collector so the bounded read is
    the same bounded read everywhere.
    """
    if max_pages is None:
        pages: Iterable[Any] = forge.get_pages(path)
    else:
        pages = forge.get_pages(path, max_pages=max_pages)
    return [item for item in pages if isinstance(item, dict)]
