"""Deterministic classifier-driven specialist role selection (#633).

In ``deep_review=auto`` mode this module decides **which** of the three fixed
specialist roles (``correctness`` / ``security`` / ``tests`` — the closed set
in :mod:`pr_reviewer.specialists`) are worth running for a PR, and which are
skipped. It is a pure function of the deterministic classification data the
review pipeline already produces **before** the specialist phase runs
(``classification.json`` from :mod:`pr_reviewer.classifier`): ``pr_kind``,
``risk_flags``, and the changed-file list. No model call, no network, no
command execution, no new inputs — selection is a lookup against the explicit
lane tables below, so identical classification input produces byte-identical
selection output.

Why no ``must_check`` input: the checklist is itself derived from
``pr_kind`` + ``risk_flags`` by the classifier, so it carries no signal the
other two do not already provide.

The explicit lane mapping (the issue's "example intent", made concrete —
evaluated independently per role in
:data:`pr_reviewer.specialists.SPECIALIST_ROLES_ORDER` order; a PR may select
zero, one, or several roles):

- **correctness** — substantive application / state / compatibility changes:
  ``pr_kind`` of ``app_code`` (the substantive catch-all; subject to the
  docs/meta-only trivial gate below) or ``k8s_manifest`` (cluster-state
  compatibility), or a ``linked_priority_p0`` / ``linked_priority_p1`` risk
  flag (the treat-as-critical checklist is a correctness-scrutiny lane).
- **security** — the security lane: ``pr_kind`` or risk flag of
  ``auth_changes`` / ``public_route_changes`` / ``file_serving_changes`` /
  ``path_handling_changes`` / ``secret_handling_changes``, or a
  ``linked_security_issue`` / ``linked_audit_issue`` risk flag. (The four
  file-based risk flags share their names with the kinds, so one flat signal
  set matches both.)
- **tests** — the test-suite lane: ``pr_kind`` of ``dependency_upgrade`` or
  ``db_or_migration_changes`` (the classifier's own must-check items for
  those kinds are "run full test suite" / "test migration").

Trivial zero-selection gates (checked before the lanes; each role is skipped
with the gate reason; every gate requires NO risk flags, so any linked/file
signal wins over them):

- **digest-only**: ``pr_kind == renovate_digest_only`` — a lockfile hash
  bump has no lane for any role.
- **docs/meta-only**: ``pr_kind == app_code`` (i.e. no specific kind pattern
  matched) where **every** changed file is in the documented trivial-path
  class (:data:`TRIVIAL_PATH_PATTERNS` — ``docs/``, prose extensions,
  license/contributor/bot-config files, and inert ``.github/`` meta).
  Executable/behavioral ``.github`` content is NOT trivial
  (:data:`NON_TRIVIAL_PATH_PATTERNS`: workflows and composite actions are
  code), so a workflows-only PR keeps the correctness lane. A PR that
  matched a specific kind pattern is by definition not in the trivial class.
  The gate only applies when the changed-file summary holds fewer than the
  classifier's 50-entry summary cap — at the cap the summary may be
  truncated, so triviality cannot be established and the gate conservatively
  does not fire.

Conservative fallback (#633 review fix): when the classification gives no
deterministic basis to skip a role — a missing/malformed artifact, the
classifier's ``unknown``-kind failure placeholder, or a usable kind that
matches NO lane (a future classifier value this module has not learned) —
selection fails toward MORE scrutiny: all three roles run with an explicit
per-role fallback reason. Zero selection is only ever allowed by an
explicit, documented trivial gate. Advisory over-scrutiny is cheap; a
silent zero selection is not.

Skipped roles are **telemetry, not failures**: they never touch the verdict,
enforcement, or the published review (the final reviewer remains the sole
verdict authority), and a skipped role is recorded in the selection artifact
with its deterministic reason — never as an error.

Output artifact (version 1)::

    {
      "version": 1,
      "mode": "auto",
      "classification_available": true,
      "pr_kind": "auth_changes",
      "risk_flags": ["auth_changes"],
      "selected_roles": ["security"],
      "skipped_roles": ["correctness", "tests"],
      "decisions": [
        {"role": "correctness", "selected": false, "signals": [],
         "reason": "skipped: no correctness-lane signal in classification
                    (pr_kind=auth_changes; risk_flags=auth_changes)"},
        {"role": "security", "selected": true,
         "signals": ["pr_kind=auth_changes"],
         "reason": "selected: security-lane signals matched:
                    pr_kind=auth_changes"},
        {"role": "tests", "selected": false, "signals": [], "reason": "..."}
      ],
      "zero_selection_reason": ""
    }

``zero_selection_reason`` is non-empty exactly when ``selected_roles`` is
empty, and names the trivial gate that fired or the no-lane-match outcome.

CLI::

    python3 -m pr_reviewer.role_selection \
        --classification classification.json --output role-selection.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from pr_reviewer.specialists import SPECIALIST_ROLES_ORDER

#: Version of the selection artifact. Bump on any shape change.
SELECTION_ARTIFACT_VERSION = 1

#: Classification.json's changed_files_summary is capped by the classifier's
#: max_summary_files default (50). At the cap the list may be truncated, so
#: the docs/meta-only trivial gate cannot establish that *every* changed file
#: is trivial and conservatively does not fire.
SUMMARY_FILE_CAP = 50

#: Security lane: pr_kind values AND risk-flag names that select the
#: ``security`` specialist. The four file-based risk flags share their names
#: with the kinds; ``public_route_changes`` exists only as a kind, and the
#: linked-issue flags are the explicit human signals.
SECURITY_SIGNALS: frozenset[str] = frozenset({
    "auth_changes",
    "public_route_changes",
    "file_serving_changes",
    "path_handling_changes",
    "secret_handling_changes",
    "linked_security_issue",
    "linked_audit_issue",
})

#: Tests lane: pr_kind values that select the ``tests`` specialist. No risk
#: flag name collides with these, so this is a kind-only lane.
TESTS_SIGNALS: frozenset[str] = frozenset({
    "dependency_upgrade",
    "db_or_migration_changes",
})

#: Correctness lane: pr_kind values AND risk-flag names that select the
#: ``correctness`` specialist. ``app_code`` is the substantive catch-all
#: (subject to the docs/meta-only trivial gate); a P0/P1 linked issue demands
#: treat-as-critical scrutiny, which is the correctness lane.
CORRECTNESS_SIGNALS: frozenset[str] = frozenset({
    "app_code",
    "k8s_manifest",
    "linked_priority_p0",
    "linked_priority_p1",
})

#: Inert ``.github`` metadata that is safe to treat as trivial. This is an
#: explicit enumeration on purpose: unknown ``.github/**`` content is
#: treated as NON-trivial, because ``.github`` also holds executable and
#: behavioral files (``workflows/``, ``actions/``, helper scripts) — a bare
#: ``^\.github/`` trivial rule would let PRs that change those skip the
#: specialists (#633 review fix, round 2).
INERT_GITHUB_PATH_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^\.github/CODEOWNERS$", re.IGNORECASE),
    re.compile(r"^\.github/ISSUE_TEMPLATE/", re.IGNORECASE),
    re.compile(r"^\.github/PULL_REQUEST_TEMPLATE(/|$)", re.IGNORECASE),
    re.compile(r"^\.github/pull_request_template\.", re.IGNORECASE),
    re.compile(r"^\.github/FUNDING\.ya?ml$", re.IGNORECASE),
    re.compile(r"^\.github/dependabot\.ya?ml$", re.IGNORECASE),
)

#: The documented trivial-path class for the docs/meta-only zero-selection
#: gate. Conservative by design: documentation trees, prose files,
#: contributor/meta files, and the inert ``.github`` metadata above.
#: Deliberately NOT matched: source code, manifests, lockfiles, IaC, anything
#: under ``.github`` outside :data:`INERT_GITHUB_PATH_PATTERNS` (workflows,
#: actions, scripts — the executable/behavioral content), or any path the
#: classifier's kind/risk pattern sets target.
TRIVIAL_PATH_PATTERNS: tuple[re.Pattern[str], ...] = (
    *INERT_GITHUB_PATH_PATTERNS,
    re.compile(r"^(docs|doc|documentation)/", re.IGNORECASE),
    re.compile(r"\.(md|markdown|rst|adoc|txt)$", re.IGNORECASE),
    re.compile(
        r"^(license|licence|notice|codeowners|code_of_conduct|contributing)"
        r"(\..*)?$",
        re.IGNORECASE,
    ),
    re.compile(
        r"^\.(editorconfig|gitignore|gitattributes|prettierrc|eslintrc|nvmrc)"
        r"(\..*)?$",
        re.IGNORECASE,
    ),
    re.compile(
        r"^(renovate\.json5?|\.renovaterc(\.json)?|dependabot\.ya?ml)$",
        re.IGNORECASE,
    ),
)

#: Executable/behavioral ``.github`` content is never trivial: workflows and
#: composite actions ARE code — they run CI, hold permissions, and can leak
#: secrets — so a PR that changes them must not skip the specialists via the
#: docs/meta gate. The inert-metadata enumeration in
#: :data:`INERT_GITHUB_PATH_PATTERNS` never lists these subtrees; this check
#: runs first anyway so a future edit to that list cannot silently re-classify
#: executable content as trivial. Unknown ``.github/**`` paths match neither
#: list and are non-trivial by construction (#633 review fix).
NON_TRIVIAL_PATH_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^\.github/(workflows|actions)/", re.IGNORECASE),
)

#: Roles in evaluation order with their signal sets: the explicit, documented
#: selection mapping.
ROLE_LANES: tuple[tuple[str, frozenset[str]], ...] = (
    ("correctness", CORRECTNESS_SIGNALS),
    ("security", SECURITY_SIGNALS),
    ("tests", TESTS_SIGNALS),
)


def _clean_str(value: Any) -> str:
    """Bounded, control-character-free string for reason text; empty when
    unusable."""
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if not text or any("\0" <= ch < " " or ch == "\x7f" for ch in text):
        return ""
    return text


def _clean_str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        text = _clean_str(item)
        if text:
            out.append(text)
    return out


def _is_trivial_path(path: Any) -> bool:
    """True only for a usable string in the documented trivial-path class.
    Unusable entries (non-string, empty, control characters) are never
    trivial, so they keep the docs/meta-only gate from firing; executable
    ``.github`` content (workflows/actions) is explicitly non-trivial."""
    if not isinstance(path, str) or not path or path != path.strip():
        return False
    if any("\0" <= ch < " " or ch == "\x7f" for ch in path):
        return False
    if any(pat.search(path) for pat in NON_TRIVIAL_PATH_PATTERNS):
        return False
    return any(pat.search(path) for pat in TRIVIAL_PATH_PATTERNS)


def _attributed_signals(
    kind: str, flags: list[str], signals: frozenset[str]
) -> list[str]:
    """Attributed signal tokens for a lane, in a deterministic order:
    ``pr_kind=<kind>`` first (when it matches), then risk flags in their
    classification order."""
    attributed: list[str] = []
    if kind and kind in signals:
        attributed.append(f"pr_kind={kind}")
    for flag in flags:
        if flag in signals:
            attributed.append(f"risk_flag={flag}")
    return attributed


def _classification_summary(kind: str, flags: list[str]) -> str:
    return (
        f"pr_kind={kind or 'none'}; "
        f"risk_flags={','.join(flags) if flags else 'none'}"
    )


def _trivial_zero_reason(
    kind: str, flags: list[str], files: list[Any]
) -> str | None:
    """Return the zero-selection reason for a documented trivial class, or
    None when the lanes should be evaluated. Checked before the lanes; the
    gates require NO risk flags so any linked/file signal wins over them."""
    if flags:
        return None
    if kind == "renovate_digest_only":
        return (
            "trivial class: digest-only lockfile change with no risk "
            "signals — no role has a meaningful lane (documented "
            "zero-selection gate)"
        )
    if (
        kind == "app_code"
        and files
        and len(files) < SUMMARY_FILE_CAP
        and all(_is_trivial_path(f) for f in files)
    ):
        return (
            "trivial class: only docs/meta files changed with no risk "
            "signals — no role has a meaningful lane (documented "
            "zero-selection gate)"
        )
    return None


#: The classifier's own failure fallback (scripts/sections/classification.sh
#: writes ``pr_kind: "unknown"`` when classification fails). An unknown kind
#: carries no lane signal, so like unusable input it gets the conservative
#: fallback rather than a zero selection.
UNKNOWN_PR_KIND = "unknown"


def _metadata_uncertainty(classification: dict) -> list[str]:
    """Linked-issue/Linear selection-input uncertainty carried by the
    classification contract (#633 review fix, round 3): a metadata source
    that was EXPECTED but could not be determined (a failed GitHub
    linked-issue label fetch, a failed configured Linear lookup) means
    missing signals are not absent signals."""
    if classification.get("linked_metadata_uncertain") is not True:
        return []
    raw = classification.get("linked_metadata_uncertainty")
    if not isinstance(raw, list):
        return ["linked metadata could not be fully determined"]
    reasons = [
        r for r in (_clean_str(item) for item in raw) if r
    ]
    return reasons or ["linked metadata could not be fully determined"]


def _is_conservative_fallback(usable: bool, kind: str) -> bool:
    """True when the classification gives no deterministic basis to skip a
    role: the input is missing/malformed, or the kind is the classifier's
    ``unknown`` failure placeholder. In that state selection fails
    CONSERVATIVELY — all three roles run, because advisory over-scrutiny is
    cheap and a silent zero selection is not."""
    return not usable or kind == UNKNOWN_PR_KIND


def select_specialist_roles(classification: Any) -> dict[str, Any]:
    """Select specialist roles from classification data. Pure and
    deterministic — see the module docstring for the mapping and artifact
    shape. Never raises.

    Unusable input (missing/malformed classification, or the classifier's
    ``unknown``-kind failure placeholder) fails CONSERVATIVELY: all three
    roles run with ``classification_available: false`` and an explicit
    per-role fallback reason. A usable classification whose kind matches no
    lane (a future classifier value) also fails conservatively to all
    roles — with ``classification_available: true``, since the input itself
    was parseable — never a silent zero selection: zero selection is only
    ever allowed by an explicit, documented trivial gate (an extra advisory
    pass merely costs tokens; a skipped specialist cannot be added back by
    the reviewer)."""
    usable = (
        isinstance(classification, dict)
        and isinstance(classification.get("pr_kind"), str)
        and bool(classification.get("pr_kind").strip())
    )
    kind = _clean_str(classification.get("pr_kind")) if usable else ""
    flags = _clean_str_list(classification.get("risk_flags")) if usable else []
    # Files stay RAW for the trivial gate (an unusable entry must never be
    # scored as trivial); only their count feeds the cap check.
    raw_files = (
        classification.get("changed_files_summary") if usable else None
    )
    files = raw_files if isinstance(raw_files, list) else []

    decisions: list[dict[str, Any]] = []
    selected_roles: list[str] = []
    skipped_roles: list[str] = []
    zero_reason = ""
    # #633 round 3: metadata uncertainty (usable classifications only — the
    # unavailable fallback already covers unusable input).
    uncertainty_reasons: list[str] = (
        _metadata_uncertainty(classification) if usable else []
    )

    if _is_conservative_fallback(usable, kind):
        # Both fallback shapes (unusable input, unknown kind) report the
        # classification as unavailable: it gave no lane basis. The recorded
        # pr_kind tells the two apart ("unknown" vs empty).
        available = False
        fallback_reason = (
            "classification unavailable — defaulting to all roles "
            "(conservative fallback: no deterministic basis to skip a role)"
        )
        for role in SPECIALIST_ROLES_ORDER:
            decisions.append({
                "role": role,
                "selected": True,
                "signals": [],
                "reason": f"selected: {fallback_reason}",
            })
            selected_roles.append(role)
    else:
        available = True
        if uncertainty_reasons:
            # Conservative uncertainty fallback (#633 round 3): a failed
            # GitHub/Linear metadata lookup may be hiding security/audit/
            # priority signals — run all three roles rather than treat the
            # missing metadata as absent. This defeats the trivial gates
            # too: a docs-only PR with an unfetchable linked issue is NOT
            # proven trivial.
            reason = (
                "selected: linked-issue/Linear selection metadata could not "
                f"be fully determined ({'; '.join(uncertainty_reasons)}) — defaulting "
                "to all roles (conservative fallback: missing signals are "
                "not absent signals)"
            )
            for role in SPECIALIST_ROLES_ORDER:
                decisions.append({
                    "role": role,
                    "selected": True,
                    "signals": [],
                    "reason": reason,
                })
                selected_roles.append(role)
        else:
            gate_reason = _trivial_zero_reason(kind, flags, files)
            if gate_reason is not None:
                zero_reason = gate_reason
                for role in SPECIALIST_ROLES_ORDER:
                    decisions.append({
                        "role": role,
                        "selected": False,
                        "signals": [],
                        "reason": f"skipped: {gate_reason}",
                    })
                    skipped_roles.append(role)
            else:
                for role, signals in ROLE_LANES:
                    matched = _attributed_signals(kind, flags, signals)
                    if matched:
                        decisions.append({
                            "role": role,
                            "selected": True,
                            "signals": matched,
                            "reason": (
                                f"selected: {role}-lane signals matched: "
                                f"{', '.join(matched)}"
                            ),
                        })
                        selected_roles.append(role)
                    else:
                        decisions.append({
                            "role": role,
                            "selected": False,
                            "signals": [],
                            "reason": (
                                f"skipped: no {role}-lane signal in classification "
                                f"({_classification_summary(kind, flags)})"
                            ),
                        })
                        skipped_roles.append(role)
                if not selected_roles:
                    # Conservative no-match fallback: a usable classification
                    # whose kind matches no lane (a future classifier value this
                    # module has not learned) must fail toward MORE scrutiny —
                    # zero selection is only ever allowed by an explicit,
                    # documented trivial gate. Without this, an unknown future
                    # kind would silently select zero specialists.
                    no_match_reason = (
                        f"selected: no role lane matched the classification "
                        f"signals ({_classification_summary(kind, flags)}) — "
                        f"defaulting to all roles (conservative fallback: zero "
                        f"selection requires a documented trivial gate)"
                    )
                    decisions = [
                        {
                            "role": role,
                            "selected": True,
                            "signals": [],
                            "reason": no_match_reason,
                        }
                        for role in SPECIALIST_ROLES_ORDER
                    ]
                    selected_roles = list(SPECIALIST_ROLES_ORDER)
                    skipped_roles = []

    artifact = {
        "version": SELECTION_ARTIFACT_VERSION,
        "mode": "auto",
        "classification_available": available,
        "pr_kind": kind,
        "risk_flags": flags,
        # #633 round 3: linked-issue/Linear metadata uncertainty — true when
        # a selection-relevant metadata source was expected but could not be
        # determined (the driver of the conservative all-roles fallback).
        "metadata_uncertain": bool(uncertainty_reasons),
        "metadata_uncertainty_reasons": uncertainty_reasons,
        "selected_roles": selected_roles,
        "skipped_roles": skipped_roles,
        "decisions": decisions,
        "zero_selection_reason": zero_reason,
    }
    return artifact


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """CLI: python3 -m pr_reviewer.role_selection --classification F [--output F]"""
    parser = argparse.ArgumentParser(
        description=(
            "Deterministic classifier-driven specialist role selection "
            "(#633) — pure classification lookup, no model call."
        )
    )
    parser.add_argument(
        "--classification",
        default="classification.json",
        help="Path to classification.json from pr_reviewer.classifier",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Optional path for the version-1 selection artifact (stdout when omitted)",
    )
    args = parser.parse_args(argv)

    classification: Any = None
    try:
        classification = json.loads(
            Path(args.classification).read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        classification = None

    artifact = select_specialist_roles(classification)
    text = json.dumps(artifact, indent=2, ensure_ascii=False) + "\n"

    if args.output:
        try:
            Path(args.output).write_text(text, encoding="utf-8")
        except OSError as exc:
            print(f"unable to write selection artifact: {exc}", file=sys.stderr)
            return 1
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
