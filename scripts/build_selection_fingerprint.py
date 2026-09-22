#!/usr/bin/env python3
"""Build the #633 auto-selection signature for stale-review detection.

``deep_review=auto`` picks specialist roles partly from LINKED-ISSUE-derived
risk flags (``linked_security_issue`` / ``linked_audit_issue`` /
``linked_priority_p0`` / ``linked_priority_p1`` — see
:mod:`pr_reviewer.role_selection`), which the diff fingerprint cannot see:
adding a security-labeled linked issue to the PR body — or labeling one —
changes the selected roles without touching the diff. This helper hashes the
selection inputs the diff does not carry:

- the PR title and body (a body edit changes which issues are linked; a
  title edit changes which configured Linear identifiers are recognized),
- every linked-issue ref extracted from the body
  (:func:`pr_reviewer.github_context.extract_linked_issue_refs`, capped at
  ``MAX_LINKED_ISSUES``) together with the labels the platform seam
  currently reports for it.

Output: a single ``sha256:<hex>`` line. ``scripts/check_review_needed.sh``
exports it as ``PRECHECK_SELECTION_SIGNATURE`` so :mod:`pr_reviewer.precheck`
folds it into the config-hash half of the broad fingerprint — ref/label/
title/body changes then invalidate a stale managed comment. Only
``deep_review=auto`` sets the variable, so other modes' fingerprints are
unchanged.

Determinism: the signature is a pure function of the fetched data; a failed
issue-label fetch records a fixed ``fetch_error`` token (never timing or
exception text), so identical platform state yields identical output. The
signature is not secret material (PR title/body/labels are PR-visible).

Cross-repo linked refs are fetched with allowlist ``*``: the read-only issue
GET matches the review pipeline's own linked-issue fetch behavior
(``platform_issue_get`` performs no repo allowlist check on that path).

Known limitation: Linear-side label/priority changes on a configured Linear
identifier are NOT covered — the precheck makes no Linear GraphQL call.
Title/body edits that change the identifier itself are covered by hashing.

Fail-soft contract: exit 0 with a non-empty signature when the PR object
was fetched (even if some or all issue-label fetches failed — those record
``fetch_error``); exit 1 when the PR object itself cannot be fetched, so the
caller proceeds WITHOUT the signature (the pre-#633 behavior) and logs a
warning.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
_PROJECT_ROOT = _SCRIPTS_DIR.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from pr_reviewer.github_context import extract_linked_issue_refs  # noqa: E402
from pr_reviewer import platform as platform_mod  # noqa: E402

#: Fixed token recorded for any issue-label fetch failure: coarse (transient
#: and permanent failures are indistinguishable) but STABLE, so identical
#: platform state keeps a identical signature.
FETCH_ERROR = "fetch_error"

#: Per-call timeout for the PR/issue fetches: the precheck gates every run,
#: so stay well under its budget. Bounded by MAX_LINKED_ISSUES in aggregate.
REQUEST_TIMEOUT_SEC = 10


def _labels_of(issue: object) -> list[str]:
    """Label names from an issue object (GitHub REST shape); empty when
    unusable."""
    if not isinstance(issue, dict):
        return []
    labels = issue.get("labels")
    if not isinstance(labels, list):
        return []
    names: list[str] = []
    for label in labels:
        if isinstance(label, dict):
            name = label.get("name")
        else:
            name = label
        if isinstance(name, str) and name.strip():
            names.append(name.strip())
    return names


def build_signature(
    repo: str, pr_number: str, *, api_fn=None
) -> tuple[str | None, str]:
    """Compute the selection signature. Returns ``(signature, error)`` —
    ``signature`` is None when the PR object itself could not be fetched."""
    if api_fn is None:
        api_fn = platform_mod.gh_api

    pr = api_fn(
        f"repos/{repo}/pulls/{pr_number}",
        allowed_repos="*",
        current_repo=repo,
        request_timeout=REQUEST_TIMEOUT_SEC,
    )
    if not isinstance(pr, dict) or pr.get("error"):
        return None, f"pr fetch failed: {pr.get('error') if isinstance(pr, dict) else 'unusable response'}"

    title = pr.get("title") if isinstance(pr.get("title"), str) else ""
    body = pr.get("body") if isinstance(pr.get("body"), str) else ""

    issues: list[dict[str, object]] = []
    for item in extract_linked_issue_refs(body, default_repo=repo):
        fetched = api_fn(
            f"repos/{item.repo}/issues/{item.number}",
            allowed_repos="*",
            current_repo=repo,
            request_timeout=REQUEST_TIMEOUT_SEC,
        )
        if isinstance(fetched, dict) and not fetched.get("error"):
            issues.append({
                "ref": item.ref,
                "repo": item.repo,
                "number": item.number,
                "labels": sorted(_labels_of(fetched)),
            })
        else:
            issues.append({
                "ref": item.ref,
                "repo": item.repo,
                "number": item.number,
                "labels": FETCH_ERROR,
            })

    payload = json.dumps(
        {"title": title, "body": body, "linked_issues": issues},
        sort_keys=True,
        ensure_ascii=False,
    )
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return f"sha256:{digest}", ""


def main() -> int:
    repo = os.environ.get("REPO", "").strip()
    pr_number = os.environ.get("PR_NUMBER", "").strip()
    if not repo or not pr_number:
        print("build_selection_fingerprint: REPO and PR_NUMBER are required",
              file=sys.stderr)
        return 1

    signature, error = build_signature(repo, pr_number)
    if signature is None:
        print(f"build_selection_fingerprint: {error}", file=sys.stderr)
        return 1
    print(signature)
    return 0


if __name__ == "__main__":
    sys.exit(main())
