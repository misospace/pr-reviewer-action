"""Escalation decision for fast→smart review routing (#160).

After the fast model produced a review, decide deterministically whether the
smart model should re-review. Every trigger is boring and testable on
purpose: verdict value, required-check keyword validation, an explicit
Unknowns/Needs-Verification section (or a suspiciously short review), and
blocker-level evidence/tool signals.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from pr_reviewer.completeness import validate_review

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
    return bool(section) and not _EMPTY_SECTION_RE.match(section) and len(section) > 40


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
    on_incomplete: bool = True,
    on_request_changes: bool = True,
    on_low_confidence: bool = True,
    on_blockers: bool = True,
    on_dirty_baseline: bool = True,
    on_planning_failure: bool = False,
    dirty_baseline: bool = False,
    output_path: str = "ai-output.json",
    classification_path: str = "classification.json",
    evidence_path: str = "evidence-providers.json",
    tool_harness_path: str = "tool-harness.json",
) -> tuple[bool, list[str]]:
    """Return (escalate, reasons) for the fast review in *output_path*.

    Must run on the raw fast output — before verdict_policy / completeness
    validation mutate it — so the triggers see what the model actually said.
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
        if must_check and not validate_review(must_check, review)["validated"]:
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

    # Incremental review against a baseline the previous review flagged: the
    # resolution judgment ("does this delta fix that blocker?") is exactly
    # what the smart model is for (#193).
    if on_dirty_baseline and dirty_baseline:
        reasons.append("dirty_baseline")

    return bool(reasons), reasons
