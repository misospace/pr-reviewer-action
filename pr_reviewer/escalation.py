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

# Reviews shorter than this are treated as low-confidence regardless of
# content — a fast model that produced two sentences did not review anything.
LOW_CONFIDENCE_MIN_CHARS = 200

# For trivial diffs the expected review is legitimately short: a correct
# review of a one-line renovate bump should not escalate as "low confidence"
# (#215). At or below this many changed lines, the minimum drops to a floor
# that still catches bare "LGTM"-style non-reviews.
TRIVIAL_DIFF_MAX_CHANGED_LINES = 10
TRIVIAL_DIFF_MIN_CHARS = 80

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


def count_changed_lines(diff_path: str = "pr.diff") -> int | None:
    """Count added/removed lines in a unified diff, or None when unreadable.

    None (rather than 0) on a missing/unreadable diff so callers fail closed
    to the standard low-confidence threshold instead of the trivial one.
    """
    try:
        text = Path(diff_path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    count = 0
    for line in text.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            count += 1
        elif line.startswith("-") and not line.startswith("---"):
            count += 1
    return count


def is_low_confidence(review_markdown: str, min_chars: int = LOW_CONFIDENCE_MIN_CHARS) -> bool:
    text = (review_markdown or "").strip()
    if len(text) < min_chars:
        return True
    match = _UNKNOWNS_HEADER_RE.search(text)
    if match:
        rest = text[match.end():].strip()
        section = re.split(r"(?m)^#{1,6}\s", rest, maxsplit=1)[0].strip()
        if section and not _EMPTY_SECTION_RE.match(section) and len(section) > 40:
            return True
    return False


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
    diff_path: str = "pr.diff",
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

    if on_low_confidence:
        # The minimum review length scales with the diff: a 2-line image bump
        # warrants a short review, and escalating it wastes a smart-model run
        # on exactly the PRs least worth one (#215). Unknowns-section
        # detection inside is_low_confidence applies at any length.
        min_chars = LOW_CONFIDENCE_MIN_CHARS
        changed = count_changed_lines(diff_path)
        if changed is not None and changed <= TRIVIAL_DIFF_MAX_CHANGED_LINES:
            min_chars = TRIVIAL_DIFF_MIN_CHARS
        if is_low_confidence(review, min_chars):
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
