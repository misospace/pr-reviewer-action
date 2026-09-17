"""Deterministic review-completeness validation against must_check items.

The classifier (pr_reviewer/classifier.py) emits a must_check list for risky
PRs and the prompt instructs the model to address each item. This module
checks whether review_markdown actually *discussed* each required check, by
shallow keyword matching. It deliberately does not judge correctness — it
only catches reviews that never mentioned a required check at all, which is
the common weak-model failure (#158).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# Concept keywords per exact must_check string emitted by the classifier.
# An item counts as addressed when ANY keyword appears in the review text.
# Keep entries short and high-recall: a false "addressed" is cheaper than
# spamming complete reviews with warnings.
CHECK_CONCEPTS: dict[str, list[str]] = {
    "verify no functional changes beyond lockfile hashes": [
        "lockfile", "hash", "digest", "functional change",
    ],
    "check for breaking API changes in updated dependencies": [
        "breaking", "backward", "compatib", "api change",
    ],
    "run full test suite after upgrade": [
        "test",
    ],
    "validate manifest against target cluster version": [
        "cluster", "api version", "apiversion", "manifest",
    ],
    "check for resource quota / limit changes": [
        "quota", "limit", "resource",
    ],
    "review auth flow for regression": [
        "auth",
    ],
    "verify session token handling is correct": [
        "session", "token",
    ],
    "verify route access controls are in place": [
        "access control", "authoriz", "route",
    ],
    "check for unintended public endpoints": [
        "public", "unauthenticated", "endpoint",
    ],
    "verify file path sanitization": [
        "sanitiz", "normaliz", "realpath", "resolved path", "path containment",
    ],
    "check for directory traversal vulnerabilities": [
        "traversal", "../", "symlink", "escape",
    ],
    "review for path traversal vulnerabilities": [
        "traversal", "../", "symlink", "escape",
    ],
    "test with edge-case paths (null bytes, symlinks)": [
        "null byte", "symlink", "edge case", "edge-case",
    ],
    "verify secrets are not logged or exposed in diffs": [
        "secret", "leak", "exposed", "logged",
    ],
    "check secret rotation impact": [
        "rotat",
    ],
    "review migration for data loss risk": [
        "data loss", "destructive", "migration",
    ],
    "test migration on a copy of production schema": [
        "schema", "migration",
    ],
    "explicitly address the linked security issue": [
        "security",
    ],
    "verify audit findings are addressed": [
        "audit",
    ],
    "treat as critical — verify all changes thoroughly": [
        "critical", "p0", "thorough",
    ],
    "treat as high priority — verify correctness carefully": [
        "high priority", "p1", "correct",
    ],
}

_FALLBACK_STOPWORDS = {
    "verify", "check", "review", "test", "with", "that", "this", "the",
    "for", "and", "are", "not", "all", "any", "from", "into", "after",
    "before", "changes", "change", "ensure", "explicitly",
}


def _fallback_keywords(item: str) -> list[str]:
    """Derive match keywords from the item text for unknown checks
    (e.g. when the classifier gains new items before this table does)."""
    words = re.findall(r"[a-z][a-z-]{3,}", item.lower())
    return [w for w in words if w not in _FALLBACK_STOPWORDS] or [item.lower()]


def is_addressed(item: str, review_lower: str) -> bool:
    keywords = CHECK_CONCEPTS.get(item) or _fallback_keywords(item)
    return any(keyword in review_lower for keyword in keywords)


def validate_review(must_check: list[str], review_markdown: str) -> dict:
    """Return {"validated": bool, "missing": [...], "addressed": [...]}."""
    review_lower = (review_markdown or "").lower()
    missing = [item for item in must_check if not is_addressed(item, review_lower)]
    addressed = [item for item in must_check if item not in missing]
    return {"validated": not missing, "missing": missing, "addressed": addressed}


def apply_required_check_validation(
    enabled: str = "auto",
    mode: str = "warn",
    classification_path: str = "classification.json",
    output_path: str = "ai-output.json",
    result_path: str = "completeness.json",
) -> str:
    """Validate the final review against must_check and act per *mode*.

    enabled: auto (validate when must_check is non-empty) | true | false.
    mode:    warn (append an Unaddressed-required-checks section; never flips
             the verdict) | fail (also force request_changes) | metadata_only
             (record the result without touching the published review).

    Returns and records the status: "complete" | "incomplete" | "none"
    (none = validation did not run). The status is written to result_path and
    into the output JSON as "required_checks".
    """
    must_check: list[str] = []
    try:
        classification = json.loads(
            Path(classification_path).read_text(encoding="utf-8", errors="replace")
        )
        raw = classification.get("must_check")
        if isinstance(raw, list):
            must_check = [str(item) for item in raw if item]
    except (OSError, json.JSONDecodeError, ValueError):
        must_check = []

    enabled = (enabled or "auto").strip().lower()
    mode = (mode or "warn").strip().lower()
    if mode not in ("warn", "fail", "metadata_only"):
        mode = "warn"

    data = json.loads(Path(output_path).read_text(encoding="utf-8", errors="replace"))

    if enabled == "false" or (enabled in ("auto", "true") and not must_check):
        status = "none"
        result = {"status": status, "mode": mode, "missing": [], "addressed": []}
    else:
        outcome = validate_review(must_check, str(data.get("review_markdown") or ""))
        status = "complete" if outcome["validated"] else "incomplete"
        result = {
            "status": status,
            "mode": mode,
            "missing": outcome["missing"],
            "addressed": outcome["addressed"],
        }

        if status == "incomplete" and mode in ("warn", "fail"):
            bullets = "\n".join(f"- {item}" for item in outcome["missing"])
            data["review_markdown"] = (
                str(data.get("review_markdown") or "")
                + "\n\n### Unaddressed required checks\n"
                + "The classifier marked these checks as required for this PR's "
                + "risk profile, but the review above does not appear to discuss "
                + "them:\n\n"
                + bullets
            )
        if status == "incomplete" and mode == "fail":
            data["verdict"] = "request_changes"
            data["review_markdown"] += (
                "\n\n_required_check_validation_mode=fail: treating the missing "
                "required checks as blocking._"
            )

    data["required_checks"] = status
    Path(output_path).write_text(
        json.dumps(data, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    Path(result_path).write_text(
        json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return status
