"""Deterministic, bounded requirement-coverage normalizer (#624).

The "requirement coverage" check pairs the version-1 **requirement ledger**
(the explicit, stable list of requirements a review must check) with the
final reviewer's **claims** — the ``requirement_coverage`` key of the parsed
model JSON, i.e. a per-requirement ``status`` plus the ``evidence`` the
reviewer cites for it. For every ledger requirement it decides whether the
claim is **credited** and emits an internal completeness artifact.

This is a **signal, not a verdict**: it tells the pipeline which
requirements the review has covered and how well it is evidenced. It never
produces an approve / request-changes outcome, never enforces a policy, and
never flips the final verdict — enforcement stays the main reviewer's job.

Design invariants (per #624):

- **Never a verdict.** The artifact is a coverage report. No status here
  maps to an approve / request-changes verdict; the pipeline consumes it as
  advisory context.
- **Evidence-gated credit.** A ``satisfied`` / ``violated`` claim with no
  CONCRETE evidence is downgraded to ``unknown`` (a claim with no
  observable support is not a determination). A claim is CONCRETE when its
  evidence item has a recognised ``kind`` *and* a non-empty ``ref`` /
  ``detail``.
- **Invariants need observable verification.** When a ledger entry carries
  ``"verification_required": true`` (a sequencing invariant), a ``satisfied``
  claim additionally requires at least one CONCRETE evidence item whose
  ``kind`` is one of ``test`` / ``tool`` / ``ci``. A ``satisfied`` claim
  evidenced only by ``file`` / ``diff`` items is downgraded to ``unknown``.
  *Rationale — the #623 dogfood miss:* "the specialist was launched before
  the final review" does **not** prove "all specialists were reaped before
  the final review entered". An invariant's satisfaction needs an
  *observable verification* (a test run, a tool, a CI signal), not a
  source-file glance.
- **``unknown`` is never upgraded.** Evidence can never lift an ``unknown``
  claim to ``satisfied``; ``credited`` is true only for rows whose *final*
  status is ``satisfied``.
- **Deterministic and bounded.** Claims keep ledger-entry order; unmatched /
  duplicate / out-of-vocabulary inputs degrade to visible ``errors`` /
  ``notes``; list and character caps (:data:`MAX_COVERAGE_ITEMS`,
  :data:`MAX_EVIDENCE_ITEMS`, :data:`MAX_EVIDENCE_CHARS`) bound the
  artifact so one payload cannot flood the final corpus. Truncation is
  always *visible*.
- **Fail-soft.** Malformed payloads (non-list claims, non-string ids,
  garbage evidence, a missing / bad ledger) degrade to fewer / zero rows
  with populated ``errors`` — never an exception.
- **No model / network / execution.** This module only parses in-memory
  values and local UTF-8 text. It makes no model calls, performs no network
  access, invokes no external commands, and never executes claim / evidence
  content. All input is treated as untrusted.

The artifact has this shape::

    {
        "version": 1,
        "ledger_sha": "<the ledger's sha>",
        "coverage": [
            {"requirement_id": "req-…", "status": "satisfied",
             "credited": true,
             "evidence": [{"kind": "test", "ref": "…", "detail": "…"}],
             "notes": []}
        ],
        "summary": {"total": 3, "satisfied": 1, "violated": 0,
                    "unknown": 2, "credited": 1},
        "errors": []
    }

Every ledger requirement with no surviving claim gets a row with
``status`` ``"unknown"``, ``credited`` ``false``, ``evidence`` ``[]`` and
``notes`` ``["not-covered-by-reviewer"]``. Rows appear in ledger-entry
order; more than :data:`MAX_COVERAGE_ITEMS` rows keeps the first 64 with a
visible ``coverage-truncated-<n>`` error.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from pr_reviewer import requirement_ledger

ARTIFACT_VERSION = 1

#: Hard caps (defaults per #624).
MAX_COVERAGE_ITEMS = 64
MAX_EVIDENCE_ITEMS = 8
MAX_EVIDENCE_CHARS = 500

TRUNCATION_MARKER = "…"

#: Claim status vocabulary (compared case-insensitively).
STATUS_VALUES: tuple[str, ...] = ("satisfied", "violated", "unknown")

#: Evidence ``kind`` vocabulary (compared case-insensitively).
EVIDENCE_KINDS: tuple[str, ...] = ("file", "test", "tool", "ci", "diff")

#: Evidence ``kind`` values that count as *observable verification* for a
#: ``verification_required`` invariant (a test run / a tool / a CI signal —
#: not a source-file or diff glance).
VERIFICATION_KINDS: frozenset[str] = frozenset({"test", "tool", "ci"})

DEFAULT_COVERAGE_KEY = "requirement_coverage"


# ---------------------------------------------------------------------------
# Tolerant field access helpers
# ---------------------------------------------------------------------------


def _cap_text(value: Any) -> str:
    """Cap an untrusted string to :data:`MAX_EVIDENCE_CHARS`.

    A visible :data:`TRUNCATION_MARKER` stands in for the truncated tail;
    non-strings become the empty string.
    """
    if not isinstance(value, str):
        return ""
    if len(value) > MAX_EVIDENCE_CHARS:
        return value[: MAX_EVIDENCE_CHARS - 1] + TRUNCATION_MARKER
    return value


def _is_concrete_field(value: Any) -> bool:
    """True when an untrusted ``ref`` / ``detail`` is non-empty after trim."""
    return isinstance(value, str) and value.strip() != ""


def _ledger_requirements(ledger: Any) -> list[Any]:
    """The ledger's requirement entries, or ``[]`` for a non-dict ledger."""
    if not isinstance(ledger, dict):
        return []
    raw = ledger.get("requirements")
    if not isinstance(raw, list):
        return []
    return raw


def _ledger_sha(ledger: Any) -> str:
    """The ledger's ``sha``, or ``""`` when absent / non-string."""
    if isinstance(ledger, dict):
        sha = ledger.get("sha")
        if isinstance(sha, str):
            return sha
    return ""


def _id_for_error(rid: Any) -> str:
    """A non-raising string form of an untrusted ``requirement_id``."""
    return str(rid)


# ---------------------------------------------------------------------------
# Evidence normalization (rule 3)
# ---------------------------------------------------------------------------


def _normalize_evidence(
    raw_evidence: Any,
) -> tuple[list[dict[str, Any]], list[str], list[bool]]:
    """Normalise an untrusted evidence list.

    Returns ``(evidence, notes, concrete_flags)`` where *evidence* is the
    list of output items (``{"kind", "ref", "detail"}`` with a
    recognised, casefolded kind), *notes* is the list of note strings, and
    *concrete_flags* is a parallel list of booleans (is this item
    CONCRETE — a recognised kind with a non-empty ``ref`` / ``detail``).
    Items whose kind is missing or outside the vocabulary are dropped with a
    ``dropped-evidence-invalid-kind`` note; more than
    :data:`MAX_EVIDENCE_ITEMS` surviving items keeps the first 8 with a
    ``evidence-truncated`` note.
    """
    if not isinstance(raw_evidence, list):
        raw_evidence = []
    evidence: list[dict[str, Any]] = []
    notes: list[str] = []
    concrete_flags: list[bool] = []
    for item in raw_evidence:
        kind = item.get("kind") if isinstance(item, dict) else None
        kind_norm = kind.casefold() if isinstance(kind, str) else None
        if kind_norm not in EVIDENCE_KINDS:
            notes.append("dropped-evidence-invalid-kind")
            continue
        concrete = (
            _is_concrete_field(item.get("ref"))
            or _is_concrete_field(item.get("detail"))
        )
        evidence.append(
            {
                "kind": kind_norm,
                "ref": _cap_text(item.get("ref")),
                "detail": _cap_text(item.get("detail")),
            }
        )
        concrete_flags.append(concrete)
    if len(evidence) > MAX_EVIDENCE_ITEMS:
        evidence = evidence[:MAX_EVIDENCE_ITEMS]
        concrete_flags = concrete_flags[:MAX_EVIDENCE_ITEMS]
        notes.append("evidence-truncated")
    return evidence, notes, concrete_flags


# ---------------------------------------------------------------------------
# Claim normalization (rules 2–4)
# ---------------------------------------------------------------------------


def _normalize_claim(claim: dict[str, Any], ledger_entry: dict[str, Any]) -> dict[str, Any]:
    """Normalise one surviving claim against its ledger entry into a row."""
    notes: list[str] = []

    # Rule 2: status, casefolded onto the vocabulary; anything else is
    # "unknown" with a "status-invalid" note.
    raw_status = claim.get("status")
    status_norm = raw_status.casefold() if isinstance(raw_status, str) else None
    if status_norm in STATUS_VALUES:
        status = status_norm
    else:
        status = "unknown"
        notes.append("status-invalid")

    # Rule 3: evidence.
    evidence, ev_notes, concrete_flags = _normalize_evidence(claim.get("evidence"))
    notes.extend(ev_notes)

    # Rule 4: crediting.
    num_concrete = sum(1 for c in concrete_flags if c)
    verification_required = bool(ledger_entry.get("verification_required"))
    if status in ("satisfied", "violated") and num_concrete == 0:
        # A determination with no concrete support is not a determination.
        status = "unknown"
        notes.append("downgraded-no-concrete-evidence")
    elif status == "satisfied" and verification_required:
        # An invariant needs observable verification (test / tool / ci),
        # not a source-file / diff glance.
        has_verification = any(
            c and ev["kind"] in VERIFICATION_KINDS
            for c, ev in zip(concrete_flags, evidence)
        )
        if not has_verification:
            status = "unknown"
            notes.append("downgraded-invariant-unverified")

    return {
        "requirement_id": claim["requirement_id"],
        "status": status,
        "credited": status == "satisfied",
        "evidence": evidence,
        "notes": notes,
    }


# ---------------------------------------------------------------------------
# Top-level normalization
# ---------------------------------------------------------------------------


def normalize_requirement_coverage(coverage_payload: Any, ledger: Any) -> dict[str, Any]:
    """Normalise the reviewer's untrusted coverage claims against the ledger.

    Never raises on malformed input: a non-list payload, a non-dict claim, a
    non-string / unknown ``requirement_id``, or a missing / bad ledger all
    degrade to fewer / zero rows with populated ``errors``.

    For every ledger requirement (in ledger-entry order) a row is emitted:
    a surviving claim is normalized per rules 1–4; a requirement with no
    surviving claim gets a ``not-covered-by-reviewer`` row. Duplicate claims
    keep the first; out-of-ledger claims are dropped with visible errors;
    more than :data:`MAX_COVERAGE_ITEMS` rows keeps the first 64.
    """
    requirements = _ledger_requirements(ledger)
    ledger_sha = _ledger_sha(ledger)
    errors: list[str] = []

    if not requirements:
        # A missing / bad ledger (load_ledger maps these to an empty
        # artifact) leaves nothing to cover.
        errors.append("ledger-unavailable")

    # Map ledger id -> entry (first occurrence wins), in ledger order.
    entry_by_id: dict[str, dict[str, Any]] = {}
    for req in requirements:
        if not isinstance(req, dict):
            continue
        rid = req.get("id")
        if isinstance(rid, str) and rid not in entry_by_id:
            entry_by_id[rid] = req

    # Collect the surviving claims (rules 1), keyed by ledger id.
    claims_by_id: dict[str, dict[str, Any]] = {}
    seen_ids: set[str] = set()
    if isinstance(coverage_payload, list):
        for claim in coverage_payload:
            if not isinstance(claim, dict):
                continue  # garbage claim: ignored, nothing to key on
            rid = claim.get("requirement_id")
            if not isinstance(rid, str) or rid not in entry_by_id:
                # Rule 1: not a ledger requirement -> drop.
                errors.append("dropped-coverage-{}".format(_id_for_error(rid)))
                continue
            if rid in seen_ids:
                # Rule 1: duplicate -> the first claim wins.
                errors.append("duplicate-coverage-{}".format(rid))
                continue
            seen_ids.add(rid)
            claims_by_id[rid] = _normalize_claim(claim, entry_by_id[rid])

    # Emit rows in ledger-entry order.
    rows: list[dict[str, Any]] = []
    for req in requirements:
        rid = req.get("id") if isinstance(req, dict) else None
        if isinstance(rid, str) and rid in claims_by_id:
            rows.append(claims_by_id[rid])
        else:
            rows.append(
                {
                    "requirement_id": rid if isinstance(rid, str) else "",
                    "status": "unknown",
                    "credited": False,
                    "evidence": [],
                    "notes": ["not-covered-by-reviewer"],
                }
            )

    if len(rows) > MAX_COVERAGE_ITEMS:
        omitted = len(rows) - MAX_COVERAGE_ITEMS
        rows = rows[:MAX_COVERAGE_ITEMS]
        errors.append("coverage-truncated-{}".format(omitted))

    summary = {
        "total": len(rows),
        "satisfied": sum(1 for r in rows if r["status"] == "satisfied"),
        "violated": sum(1 for r in rows if r["status"] == "violated"),
        "unknown": sum(1 for r in rows if r["status"] == "unknown"),
        "credited": sum(1 for r in rows if r["credited"]),
    }

    return {
        "version": ARTIFACT_VERSION,
        "ledger_sha": ledger_sha,
        "coverage": rows,
        "summary": summary,
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# Tolerant coverage loading
# ---------------------------------------------------------------------------


def load_coverage(path: str) -> Any:
    """Tolerantly load a coverage file; missing / unreadable / bad JSON → None.

    The parsed value may be an object (from which the caller extracts the
    coverage key) or a bare array; this helper only decodes.
    """
    if not isinstance(path, str) or not path:
        return None
    try:
        raw = Path(path).read_text(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _write_atomic(path: str, text: str) -> None:
    """Best-effort atomic write; a failure is swallowed (advisory output)."""
    target = Path(path)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, target)
    except (OSError, ValueError):
        # Fail-soft: coverage is advisory review context, never the verdict,
        # so a write failure must not abort the run.
        pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build a requirement-coverage artifact from the reviewer's claims."
    )
    parser.add_argument(
        "--coverage", default=None, help="Coverage JSON file (object or bare array)"
    )
    parser.add_argument(
        "--ledger", default=None, help="Requirement-ledger artifact file"
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output JSON artifact path (default: print to stdout)",
    )
    parser.add_argument(
        "--coverage-key",
        default=DEFAULT_COVERAGE_KEY,
        help="Key to extract the claims array from an object coverage file",
    )
    args = parser.parse_args(argv)

    # Load the ledger tolerantly; a missing / bad ledger degrades to an
    # empty artifact and a "ledger-unavailable" error (never an exception).
    ledger = (
        requirement_ledger.load_ledger(args.ledger) if args.ledger else None
    )

    # Load the coverage payload tolerantly; an object yields its coverage
    # key, a bare array is used as-is, and anything else is ignored.
    payload = load_coverage(args.coverage) if args.coverage else None
    coverage_payload = payload
    if isinstance(payload, dict):
        coverage_payload = payload.get(args.coverage_key)

    artifact = normalize_requirement_coverage(coverage_payload, ledger)

    text = json.dumps(artifact, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        _write_atomic(args.output, text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
