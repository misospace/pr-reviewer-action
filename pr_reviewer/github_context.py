"""GitHub context collection helpers.

Extracts linked issue references from a PR body, normalises them to
owner/repo#number form, and provides PR metadata structures.
Ported from inline Python in ``scripts/run_review.sh``.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass


GITHUB_ISSUE_REF_PATTERN = re.compile(
    r"(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?[ \t]+"
    r"((?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#\d+)"
)

MAX_LINKED_ISSUES = 8


@dataclass
class LinkedIssueRef:
    ref: str
    repo: str
    number: int


def extract_linked_issue_refs(
    body: str,
    default_repo: str | None = None,
) -> list[LinkedIssueRef]:
    """Extract ``Closes/Fixes/Resolves #N`` style references from a PR body.

    Parameters
    ----------
    body : str
        Raw PR body text.
    default_repo : str, optional
        Repository to use when the reference is just ``#N`` (e.g. ``"owner/repo"``).

    Returns
    -------
    list[LinkedIssueRef]
        Deduplicated list of issue references (max 8), in order of appearance.
    """
    if default_repo is None:
        default_repo = os.environ.get("REPO", "")

    seen: set[str] = set()
    items: list[LinkedIssueRef] = []

    for match in GITHUB_ISSUE_REF_PATTERN.finditer(body):
        ref = match.group(1)
        if ref in seen:
            continue
        seen.add(ref)

        if "/" in ref:
            repo_name, issue_number = ref.split("#", 1)
        else:
            repo_name, issue_number = default_repo, ref[1:]

        try:
            number = int(issue_number)
        except ValueError:
            continue

        items.append(LinkedIssueRef(ref=ref, repo=repo_name, number=number))

        if len(items) >= MAX_LINKED_ISSUES:
            break

    return items


def linked_issues_to_json(items: list[LinkedIssueRef]) -> list[dict]:
    """Serialize a list of LinkedIssueRef to the JSON format used in run_review.sh."""
    return [{"ref": item.ref, "repo": item.repo, "number": item.number} for item in items]