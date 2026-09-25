"""Deterministic review-completeness validation against must_check items.

The classifier (pr_reviewer/classifier.py) emits a must_check list for risky
PRs and the prompt instructs the model to disposition each item. Since #750
a must_check item is a mandatory review QUESTION, not automatically an
implementation requirement: the model records one structured disposition per
item in the verdict's ``required_check_dispositions`` array (status
``satisfied`` / ``not_applicable`` / ``unresolved``), and
:func:`evaluate_structured_coverage` folds those dispositions against the
deterministic check list.

Coexistence bridge (until #680 cuts enforcement over): when the parsed
output carries NO structured dispositions at all, validation falls back to
the legacy shallow keyword match (:func:`validate_review`) against
review_markdown — deliberately lenient, documented, and removed by #680.
When the field IS present, the structured evaluation is authoritative and
no keyword mention can substitute for a missing or malformed disposition.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

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


# ---------------------------------------------------------------------------
# Structured required-check coverage (#750)
# ---------------------------------------------------------------------------

# Identity/rationale text is bounded with the same control-char collapse used
# by response_parser.py (mirrored byte-for-byte by src/enforcement/
# required-checks.ts).
_CHECK_CONTROL_RE = re.compile(r"[\x00-\x20\x7f]+")
_MAX_DROPPED_UNKNOWN = 50

_REASON_OK = "ok"
_REASON_NO_DISPOSITION = "no-disposition"
_REASON_NO_STRUCTURED = "no-structured-dispositions"
_REASON_DUPLICATE = "duplicate-dispositions"
_REASON_MALFORMED = "malformed-disposition"


def _check_identity(check: str) -> str:
    """Identity key for matching a disposition to its deterministic check.

    Case- and whitespace-normalized so a faithful echo (modulo casing or
    extra spaces) still matches, while any rewording of the deterministic
    text — the model inventing, altering, or forging a check — cannot.
    """
    return _CHECK_CONTROL_RE.sub(" ", check).strip().lower()


def _validate_disposition(item: object) -> dict | None:
    """Re-validate one disposition defensively against the rawer seam input.

    Returns ``{"identity": ..., "status": ..., "rationale": ...}`` for a
    usable entry, ``{"identity": ..., "invalid": True}`` for an attributable
    but malformed one, and ``None`` when the entry cannot be attributed to
    any check identity at all.
    """
    if not isinstance(item, dict):
        return None
    check = item.get("check")
    if not isinstance(check, str):
        return None
    identity = _check_identity(check)
    if not identity:
        return None
    raw_status = item.get("status")
    status = raw_status.strip().lower() if isinstance(raw_status, str) else ""
    if status not in ("satisfied", "not_applicable", "unresolved"):
        return {"identity": identity, "invalid": True}
    rationale = item.get("rationale")
    if not isinstance(rationale, str):
        rationale = None
    if status == "not_applicable" and (
        rationale is None or _CHECK_CONTROL_RE.sub(" ", rationale).strip() == ""
    ):
        return {"identity": identity, "invalid": True}
    # Rationale is passed through unchanged: the parser already sanitized
    # and bounded it, and the evaluator must not re-shape model text (byte
    # parity with src/enforcement/required-checks.ts).
    return {"identity": identity, "status": status, "rationale": rationale}


def evaluate_structured_coverage(
    must_check: list[str], dispositions: list[dict[str, Any]] | None
) -> dict:
    """Fold structured dispositions against the deterministic check list.

    Returns the version-1 coverage artifact (byte-identical to
    ``requiredCheckCoverageToArtifact`` in src/enforcement/required-checks.ts;
    pinned by the ``required-check-coverage`` parity boundary):

    - ``status``: ``"none"`` (no must_check at all), ``"complete"`` (every
      check ``satisfied`` or grounded ``not_applicable``), else
      ``"incomplete"``;
    - ``structured``: False only when *dispositions* is None — the model
      produced no structured coverage at all, and every check is recorded
      unresolved (the conservative v3 semantics; the v2 bridge may fall back
      to legacy keyword matching in exactly that case);
    - ``checks``: one row per supplied check, in supplied order, with the
      resolved status and a machine-readable reason;
    - ``dropped_unknown``: model check identities that match no supplied
      check — never credited, recorded for diagnostics only.

    Never raises; never produces or flips a verdict. Duplicate dispositions
    deterministically invalidate their check; a model disposition can never
    invent additional mandatory checks.
    """
    if not must_check:
        return {
            "version": 1,
            "status": "none",
            "structured": dispositions is not None,
            "checks": [],
            "dropped_unknown": [],
        }

    rows: dict[str, dict] = {}
    order: list[str] = []
    for check in must_check:
        identity = _check_identity(check)
        if not identity or identity in rows:
            continue
        rows[identity] = {
            "check": check,
            "status": "unresolved",
            "rationale": None,
            "reason": _REASON_NO_STRUCTURED if dispositions is None else _REASON_NO_DISPOSITION,
        }
        order.append(identity)

    dropped_unknown: list[str] = []
    if dispositions is not None:
        for item in dispositions:
            validated = _validate_disposition(item)
            if validated is None:
                continue
            row = rows.get(validated["identity"])
            if row is None:
                if len(dropped_unknown) < _MAX_DROPPED_UNKNOWN:
                    dropped_unknown.append(str(item.get("check", "")))
                continue
            if validated.get("invalid"):
                row["status"] = "unresolved"
                row["rationale"] = None
                row["reason"] = _REASON_MALFORMED
                continue
            if row["reason"] not in (_REASON_NO_DISPOSITION, _REASON_NO_STRUCTURED):
                # Second answer for the same check: deterministically
                # invalidate it — double-answering cannot launder coverage.
                row["status"] = "unresolved"
                row["rationale"] = None
                row["reason"] = _REASON_DUPLICATE
                continue
            row["status"] = validated["status"]
            row["rationale"] = validated["rationale"]
            row["reason"] = _REASON_OK

    checks = [rows[identity] for identity in order]
    complete = bool(checks) and all(
        row["reason"] == _REASON_OK and row["status"] in ("satisfied", "not_applicable")
        for row in checks
    )
    return {
        "version": 1,
        "status": "complete" if complete else "incomplete",
        "structured": dispositions is not None,
        "checks": checks,
        "dropped_unknown": dropped_unknown,
    }


def structured_coverage_from_output(must_check: list[str], output: object) -> dict | None:
    """Return the structured coverage artifact for a parsed review output.

    None when the output carries no structured dispositions at all (the
    legacy keyword path applies). Shared by the completeness bridge and the
    escalation telemetry so both read the same contract.
    """
    if not isinstance(output, dict):
        return None
    dispositions = output.get("required_check_dispositions")
    if not isinstance(dispositions, list):
        return None
    return evaluate_structured_coverage(must_check, dispositions)


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
        structured = structured_coverage_from_output(must_check, data)
        if structured is not None:
            # #750: the model engaged with the structured disposition
            # contract — the structured evaluation is authoritative and no
            # keyword mention can substitute for a missing or malformed
            # disposition. A resolved check (satisfied, or grounded
            # not_applicable) is complete; anything else is unresolved and
            # reported as such.
            status = structured["status"]
            unresolved = [row["check"] for row in structured["checks"] if row["status"] == "unresolved"]
            resolved = [row["check"] for row in structured["checks"] if row["status"] != "unresolved"]
            result = {
                "status": status,
                "mode": mode,
                "structured": True,
                "missing": unresolved,
                "addressed": resolved,
                "checks": structured["checks"],
                "dropped_unknown": structured["dropped_unknown"],
            }
        else:
            # Coexistence fallback: no structured dispositions at all, so
            # the legacy shallow keyword match still decides (documented;
            # #680 removes it).
            outcome = validate_review(must_check, str(data.get("review_markdown") or ""))
            status = "complete" if outcome["validated"] else "incomplete"
            result = {
                "status": status,
                "mode": mode,
                "structured": False,
                "missing": outcome["missing"],
                "addressed": outcome["addressed"],
            }

        if status == "incomplete" and mode in ("warn", "fail"):
            bullets = "\n".join(f"- {item}" for item in result["missing"])
            data["review_markdown"] = (
                str(data.get("review_markdown") or "")
                + "\n\n### Unaddressed required checks\n"
                + "The classifier marked these checks as required for this PR's "
                + "risk profile, but the review does not resolve or disposition "
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
