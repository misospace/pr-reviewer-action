"""Escalation decision for fast→smart review routing.

#721 makes post-primary smart escalation **reviewer-requested only**: the
sole escalation trigger after a successful primary review is the primary
model's own structured verdict field ``smart_review_requested`` (parsed and
normalized by :mod:`pr_reviewer.response_parser`, never inferred from
review prose). :func:`reviewer_requested_escalation` reads that field.

The former heuristic triggers (:func:`should_escalate` — request_changes,
low confidence / Unknowns sections, tool/evidence blockers, incomplete
required checks, tool planning failure) remain in this module **as
telemetry only**: they stay boring and testable so the review step can log
which signals would historically have fired, but they must never
independently initiate a smart call after a successful primary review.

Unchanged invariants (still owned by the review orchestration, not here):
deterministic direct smart routing *before* the primary runs; primary
failure → fallback as availability recovery; the fallback is never a
quality-escalation target; smart failure restores/publishes the primary
review; and no escalation loops (a smart review cannot request another
smart review).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from pr_reviewer.completeness import structured_coverage_from_output, validate_review

# A review shorter than this is a stub / non-review (e.g. "LGTM.") and is
# treated as low-confidence regardless of verdict or diff size. Above it, a
# concise-but-real review is trusted: escalating a confident short approval
# just to have the smart model re-approve wasted a run on exactly the PRs
# least in need of one (#215 and the over-escalation follow-up). The review's
# length is NOT otherwise scaled with diff size — the real "needs a closer
# look" signals are request_changes, a populated Unknowns section, blockers,
# and risk-flag routing, each of which has its own trigger.
STUB_REVIEW_MIN_CHARS = 80

# Header of the section the default prompt asks for "when evidence is
# incomplete" — its presence with real content is the model saying it is
# unsure.
_UNKNOWNS_HEADER_RE = re.compile(
    r"(?im)^#{1,6}\s*unknowns?\b[^\n]*$"
)

_EMPTY_SECTION_RE = re.compile(r"(?i)^\(?(none|n/?a|nothing)\)?[.!]?$")

# Missing CI or test infrastructure is an environmental limitation, not
# uncertainty about the change. A smart model cannot manufacture those results.
_ENVIRONMENTAL_UNKNOWN_TERMS = (
    "ci",
    "check result",
    "test",
    "pytest",
    "test suite",
    "tool output",
    "evidence",
    "corpus",
    "environment",
    "not configured",
    "not available",
    "unavailable",
    "not provided",
    "missing",
    "not executed",
    "not run",
)
_SUBSTANTIVE_UNKNOWN_TERMS = (
    "behavior",
    "code path",
    "correctness",
    "data loss",
    "invariant",
    "logic",
    "regression",
    "security",
    "state transition",
    "upstream changelog",
    "release notes",
)


def _load(path: str) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8", errors="replace"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError, ValueError):
        return {}


def _has_populated_unknowns(text: str) -> bool:
    """Whether the review has a non-empty Unknowns/Needs-Verification section.

    That section, when the model actually fills it in, is the model stating it
    could not verify something — the genuine "escalate me" signal.
    """
    match = _UNKNOWNS_HEADER_RE.search(text)
    if not match:
        return False
    rest = text[match.end():].strip()
    section = re.split(r"(?m)^#{1,6}\s", rest, maxsplit=1)[0].strip()
    if not section or _EMPTY_SECTION_RE.match(section) or len(section) <= 40:
        return False

    normalized = re.sub(r"[^a-z0-9]+", " ", section.lower())
    has_environmental_term = any(term in normalized for term in _ENVIRONMENTAL_UNKNOWN_TERMS)
    has_substantive_term = any(term in normalized for term in _SUBSTANTIVE_UNKNOWN_TERMS)
    # Unknowns that only report unavailable review infrastructure do not mean
    # the model failed to understand the diff; re-running cannot add that data.
    return not (has_environmental_term and not has_substantive_term)


def is_low_confidence(review_markdown: str, min_chars: int = STUB_REVIEW_MIN_CHARS) -> bool:
    """Whether the fast review warrants the smart model on confidence grounds.

    Two signals only:
      * a populated Unknowns / Needs-Verification section — the model saying it
        is unsure; and
      * a stub review shorter than *min_chars* — too short to have reviewed
        anything (e.g. "LGTM.").

    A confident, concise review above the stub floor is NOT low-confidence,
    whatever the diff size. This deliberately drops the former length scaling
    with diff size, which escalated most small/medium PRs whose correct reviews
    were simply brief.
    """
    text = (review_markdown or "").strip()
    if len(text) < min_chars:
        return True
    return _has_populated_unknowns(text)


def _has_blocker_signals(evidence: dict, harness: dict) -> bool:
    if evidence.get("has_blocker"):
        return True
    executed = harness.get("executed_request_count", 0)
    results = [t for t in harness.get("tool_results", []) if isinstance(t, dict)]
    if executed and results and not any(t.get("status") == "ok" for t in results):
        return True
    return False


def _has_planning_failure(harness: dict) -> bool:
    """The harness planning call failed before any tools ran (#215).

    Kept separate from blocker signals: a planning failure means the review
    proceeded with LESS evidence — the same situation as tool_mode 'off' —
    not that the PR carries elevated risk. Escalating on it is opt-in.
    """
    return harness.get("planning_error") is not None or harness.get("error") is not None


def should_escalate(
    on_incomplete: bool = False,
    on_request_changes: bool = True,
    on_low_confidence: bool = True,
    on_blockers: bool = True,
    on_planning_failure: bool = False,
    output_path: str = "ai-output.json",
    classification_path: str = "classification.json",
    evidence_path: str = "evidence-providers.json",
    tool_harness_path: str = "tool-harness.json",
) -> tuple[bool, list[str]]:
    """Return (escalate, reasons) the heuristics would have fired on (#721).

    **Telemetry only.** Since #721 this function's result must never gate a
    smart call after a successful primary review — the review step logs it
    so operators still see which historical signals a run carried, but the
    escalation decision itself is :func:`reviewer_requested_escalation`.

    Must run on the raw primary output — before verdict_policy /
    completeness validation / enforcement mutate it — so the telemetry sees
    what the model actually said.
    """
    data = _load(output_path)
    review = str(data.get("review_markdown") or "")
    reasons: list[str] = []

    if on_request_changes and data.get("verdict") == "request_changes":
        reasons.append("fast_request_changes")

    if on_incomplete:
        classification = _load(classification_path)
        must_check = [
            str(item) for item in (classification.get("must_check") or []) if item
        ]
        if must_check:
            # #750: telemetry follows the same structured-first contract as
            # the completeness bridge, so a grounded not_applicable (or any
            # complete structured coverage) is not misreported as an
            # incomplete-required-checks signal. Telemetry only either way:
            # this reason must never gate a smart call (#721).
            structured = structured_coverage_from_output(must_check, data)
            if structured is not None:
                if structured["status"] != "complete":
                    reasons.append("incomplete_required_checks")
            elif not validate_review(must_check, review)["validated"]:
                reasons.append("incomplete_required_checks")

    if on_low_confidence and is_low_confidence(review):
        # Only a stub review or a populated Unknowns section counts — a concise
        # confident review is trusted regardless of diff size (see
        # is_low_confidence). This is the primary fix for over-escalation:
        # previously any review under ~200 chars on an >10-line diff escalated.
        reasons.append("fast_low_confidence")

    harness = _load(tool_harness_path)
    if on_blockers and _has_blocker_signals(_load(evidence_path), harness):
        reasons.append("tool_or_evidence_blockers")

    if on_planning_failure and _has_planning_failure(harness):
        reasons.append("tool_planning_failed")

    return bool(reasons), reasons


def reviewer_requested_escalation(
    output_path: str = "ai-output.json",
) -> tuple[bool, str | None]:
    """The primary reviewer's explicit structured smart-review request (#721).

    The ONLY post-primary escalation trigger: reads the structured verdict
    fields ``smart_review_requested`` / ``smart_review_reason`` from the
    parsed primary output. Those fields are normalized by
    :mod:`pr_reviewer.response_parser` (boolean-true only, bounded
    single-line reason), so PR-controlled prose or Markdown in
    ``review_markdown`` cannot forge the request, and malformed model
    output is never treated as one. The reason is advisory context for
    logs/artifacts; it never widens the decision.

    Never raises: a missing / malformed artifact degrades to
    ``(False, None)``. The boolean alone drives the decision — the reason is
    advisory context and is dropped when absent or blank. Returns
    ``(requested, reason)``.
    """
    data = _load(output_path)
    requested = data.get("smart_review_requested") is True
    reason = data.get("smart_review_reason")
    if not (requested and isinstance(reason, str) and reason.strip()):
        reason = None
    return requested, reason
