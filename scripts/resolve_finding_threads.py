#!/usr/bin/env python3
"""Resolve inline finding threads whose findings this run verified as fixed (#208).

A previous run posted line-anchored inline comments carrying a content
fingerprint marker (see build_review_comments.finding_marker). When the
current incremental review's carry-forward concludes a carried finding is
resolved, this script locates the matching unresolved review thread by that
marker and resolves it via the GraphQL resolveReviewThread mutation, so
authors see live thread state instead of stale open conversations.

Best-effort by design: any API failure warns and exits 0 — thread resolution
must never fail the publish step. Fork PRs with a read-only token simply
leave threads unresolved.

Threads are matched by the marker their first comment carries, never by
author: /user returns 403 for installation tokens (#190).

Usage: resolve_finding_threads.py PREVIOUS_FINDINGS_JSON FINDINGS_JSON_FILE

Environment:
  REPO        owner/repo of the pull request
  PR_NUMBER   pull request number
  GH_TOKEN    used implicitly by gh
"""

import json
import os
import subprocess
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
_ACTION_ROOT = _SCRIPTS_DIR.parent
for _p in (str(_SCRIPTS_DIR), str(_ACTION_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from build_review_comments import FINDING_MARKER_PREFIX, finding_fingerprint  # noqa: E402
from pr_reviewer.carry_forward import load_carried_findings  # noqa: E402

_THREADS_QUERY = (
    "query($owner: String!, $name: String!, $number: Int!) {"
    " repository(owner: $owner, name: $name) {"
    " pullRequest(number: $number) {"
    " reviewThreads(first: 100) {"
    " nodes { id isResolved comments(first: 1) { nodes { body } } }"
    " } } } }"
)

_RESOLVE_MUTATION = (
    "mutation($id: ID!) {"
    " resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }"
)

_MAX_THREADS_PAGE = 100


def _gh_graphql(fields: list, timeout: int = 60):
    """Run ``gh api graphql`` and return the parsed JSON dict, or None.

    On HTTP errors gh prints the JSON error body to STDOUT (#190), so a
    non-zero exit discards stdout entirely instead of trying to parse it.
    Anything that is not a JSON object is treated as a failure.
    """
    cmd = ["gh", "api", "graphql", *fields]
    try:
        completed = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    try:
        parsed = json.loads(completed.stdout.decode("utf-8", errors="replace"))
    except (ValueError, UnicodeDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def resolved_fingerprints(carried: list, findings) -> set:
    """Fingerprints of carried findings the model marked resolved.

    Mirrors carry_forward.apply_carry_forward: only an explicit "resolved"
    resolution counts; everything else stays open (fail-closed), so its
    thread stays open too.
    """
    if not isinstance(findings, list):
        return set()
    resolutions = {
        f["id"]: f.get("resolution")
        for f in findings
        if isinstance(f, dict) and isinstance(f.get("id"), str)
    }
    return {
        finding_fingerprint(item)
        for item in carried
        if resolutions.get(item.get("id")) == "resolved"
    }


def extract_marker_fingerprint(body):
    """Pull the finding fingerprint out of a comment body, if present."""
    if not isinstance(body, str):
        return None
    start = body.find(FINDING_MARKER_PREFIX)
    if start == -1:
        return None
    rest = body[start + len(FINDING_MARKER_PREFIX):]
    end = rest.find("-->")
    if end == -1:
        return None
    fingerprint = rest[:end].strip()
    return fingerprint or None


def threads_to_resolve(thread_nodes, fingerprints: set) -> list:
    """Thread node ids whose first comment matches a resolved fingerprint.

    Only the first comment is checked — that is the thread starter the
    previous run posted; replies never carry the marker.
    """
    matched = []
    for node in thread_nodes or []:
        if not isinstance(node, dict) or node.get("isResolved"):
            continue
        thread_id = node.get("id")
        if not isinstance(thread_id, str) or not thread_id:
            continue
        comments = (node.get("comments") or {}).get("nodes") or []
        first = comments[0] if comments and isinstance(comments[0], dict) else {}
        fingerprint = extract_marker_fingerprint(first.get("body"))
        if fingerprint and fingerprint in fingerprints:
            matched.append(thread_id)
    return matched


def main(argv) -> int:
    previous_path = argv[1] if len(argv) > 1 else "previous-findings.json"
    findings_path = argv[2] if len(argv) > 2 else "findings.json"

    repo = os.getenv("REPO", "")
    pr_number = os.getenv("PR_NUMBER", "")
    if "/" not in repo or not pr_number.isdigit():
        print("resolve_finding_threads: missing REPO/PR_NUMBER; skipping", file=sys.stderr)
        return 0

    carried = load_carried_findings(previous_path)
    if not carried:
        return 0

    try:
        findings = json.loads(Path(findings_path).read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        findings = []

    fingerprints = resolved_fingerprints(carried, findings)
    if not fingerprints:
        print("resolve_finding_threads: no resolved carried findings; nothing to resolve")
        return 0

    owner, name = repo.split("/", 1)
    data = _gh_graphql(
        [
            "-f", f"query={_THREADS_QUERY}",
            "-f", f"owner={owner}",
            "-f", f"name={name}",
            "-F", f"number={pr_number}",
        ]
    )
    if data is None:
        print("  WARN: could not list review threads; skipping thread resolution", file=sys.stderr)
        return 0
    try:
        thread_nodes = data["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
    except (KeyError, TypeError):
        thread_nodes = []
    if not isinstance(thread_nodes, list):
        thread_nodes = []
    if len(thread_nodes) >= _MAX_THREADS_PAGE:
        print(
            f"  NOTE: PR has {_MAX_THREADS_PAGE}+ review threads; only the first "
            f"{_MAX_THREADS_PAGE} were checked for resolution",
            file=sys.stderr,
        )

    thread_ids = threads_to_resolve(thread_nodes, fingerprints)
    resolved = 0
    for thread_id in thread_ids:
        result = _gh_graphql(
            ["-f", f"query={_RESOLVE_MUTATION}", "-f", f"id={thread_id}"]
        )
        if result is not None:
            resolved += 1
        else:
            print(
                f"  WARN: could not resolve review thread {thread_id} "
                "(may require additional permissions)",
                file=sys.stderr,
            )
    print(
        f"resolve_finding_threads: resolved {resolved}/{len(thread_ids)} matching "
        f"thread(s) for {len(fingerprints)} fixed finding(s)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
