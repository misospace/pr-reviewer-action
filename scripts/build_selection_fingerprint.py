#!/usr/bin/env python3
"""Build the #633 auto-selection signature for stale-review detection.

``deep_review=auto`` picks specialist roles partly from inputs the diff
fingerprint cannot see:

- GitHub linked-issue labels (``linked_security_issue`` /
  ``linked_audit_issue`` / ``linked_priority_p0`` / ``linked_priority_p1``),
- Linear state: ``pr_reviewer.classifier`` converts a Linear issue's NATIVE
  priority (1=Urgent → ``priority/p0`` → ``linked_priority_p0``; 2=High →
  ``priority/p1`` → ``linked_priority_p1``) and consumes its labels — so a
  Linear priority or label change on a configured ``TEAM-123`` identifier
  changes the selected roles on an unchanged diff.

This helper therefore hashes every non-diff selection input, reusing the
pipeline's own abstractions (no second interpretation):

- the PR title and body (a body edit changes which issues are linked; a
  title edit changes which identifiers are recognized),
- every linked-issue ref extracted from the body
  (:func:`pr_reviewer.github_context.extract_linked_issue_refs`, capped at
  ``MAX_LINKED_ISSUES``) with the labels the platform seam currently
  reports (``pr_reviewer.platform.gh_api`` — the same seam and repo policy
  as the pipeline's linked-issue fetch),
- every configured Linear identifier recognized in the title
  (:func:`pr_reviewer.linear_context.extract_issue_identifiers` with
  ``LINEAR_ISSUE_PREFIXES``) with its fetched native ``priority`` and label
  names (:func:`pr_reviewer.linear_context.collect_from_pr` — the exact
  call the review pipeline's Linear phase makes).

Output: a single ``sha256:<hex>`` line. ``scripts/check_review_needed.sh``
exports it as ``PRECHECK_SELECTION_SIGNATURE`` so :mod:`pr_reviewer.precheck`
folds it into the config-hash half of the broad fingerprint — ref/label/
priority/title/body changes then invalidate a stale managed comment. Only
``deep_review=auto`` sets the variable, so other modes' fingerprints are
unchanged.

Determinism: the signature is a pure function of the fetched data, so
identical platform state yields identical output. The signature is not
secret material (PR title/body/labels are PR-visible).

CONSERVATIVE FAILURE (#633 review fix, round 2): this builder exits
nonzero unless EVERY input it needs was determined. A failed PR fetch, ANY
failed linked-issue label fetch, or a failed Linear fetch (when Linear is
configured and the title carries a recognized identifier) means the
selection inputs are UNKNOWN — unknown inputs must never be omitted into a
diff-unchanged skip, because a changed label/priority could be hiding
behind the failure. The caller then exports a per-run unique
``unavailable-…`` sentinel instead, which can never match a stored
fingerprint marker, so the review is forced. A PR whose linked metadata is
persistently unfetchable re-reviews on every run — that is the requested
direction: uncertainty forces a fresh review, never a stale reuse.
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

from pr_reviewer import linear_context  # noqa: E402
from pr_reviewer.github_context import extract_linked_issue_refs  # noqa: E402
from pr_reviewer import platform as platform_mod  # noqa: E402

#: Per-call timeout for the platform issue fetches; the Linear timeout comes
#: from LINEAR_ISSUE_TIMEOUT_SEC (the pipeline's own knob, default 20).
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


def _linear_state(
    title: str, *, linear_collect=None
) -> tuple[list[dict[str, object]], str]:
    """Fetch the Linear state that can affect classification. Returns
    ``(issues, error)``; a non-empty error means an input could not be
    determined and the caller must fail conservatively.

    Mirrors the pipeline gate exactly: Linear only affects classification
    when BOTH ``LINEAR_ISSUE_PREFIXES`` and ``LINEAR_API_KEY`` are set and
    the title carries a recognized identifier — otherwise it contributes
    nothing and cannot change a selection."""
    prefixes_raw = os.environ.get("LINEAR_ISSUE_PREFIXES", "").strip()
    api_key = os.environ.get("LINEAR_API_KEY", "").strip()
    if not prefixes_raw or not api_key:
        return [], ""
    try:
        prefixes = linear_context.parse_prefixes(prefixes_raw)
    except ValueError as exc:
        return [], f"linear prefixes invalid: {exc}"
    if not linear_context.extract_issue_identifiers(title, prefixes):
        return [], ""
    collect = linear_collect or linear_context.collect_from_pr
    try:
        timeout = int(os.environ.get("LINEAR_ISSUE_TIMEOUT_SEC", "20") or "20")
    except ValueError:
        timeout = 20
    issues, errors = collect_from_pr_safe(
        collect, title, prefixes, api_key, timeout
    )
    if errors:
        identifier, message = errors[0]
        return [], f"linear fetch failed for {identifier}: {message}"
    return [
        {
            "identifier": str(issue.get("identifier") or ""),
            # classifier.py maps native 1→priority/p0 (→ linked_priority_p0)
            # and 2→priority/p1 (→ linked_priority_p1); the raw value is what
            # the selection reads, so hash it verbatim.
            "priority": issue.get("priority"),
            "labels": sorted(
                str(label.get("name"))
                for label in (issue.get("labels") or [])
                if isinstance(label, dict) and label.get("name")
            ),
        }
        for issue in issues
    ], ""


def collect_from_pr_safe(collect, title, prefixes, api_key, timeout):
    """Call the injected/real ``collect_from_pr``; LinearContextError escaping
    (an unexpected failure mode of an injected stub) degrades to the errors
    list so the caller still fails conservatively."""
    try:
        return collect(
            {"title": title}, prefixes, api_key, timeout=timeout
        )
    except linear_context.LinearContextError as exc:
        return [], [("linear", str(exc))]


def build_signature(
    repo: str, pr_number: str, *, api_fn=None, linear_collect=None
) -> tuple[str | None, str]:
    """Compute the selection signature. Returns ``(signature, error)`` —
    ``signature`` is None when ANY required selection input could not be
    determined (the caller must force a fresh review)."""
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
            # Unknown labels cannot be omitted into a skip: fail the build
            # so the caller forces a fresh review (#633 review fix).
            error = (
                fetched.get("error")
                if isinstance(fetched, dict) and fetched.get("error")
                else "unusable response"
            )
            return None, f"linked issue {item.ref} fetch failed: {error}"

    linear_issues, linear_error = _linear_state(
        title, linear_collect=linear_collect
    )
    if linear_error:
        return None, linear_error

    payload = json.dumps(
        {
            "title": title,
            "body": body,
            "linked_issues": issues,
            "linear_issues": linear_issues,
        },
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
