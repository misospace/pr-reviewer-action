#!/usr/bin/env python3
"""Manage inline finding threads across incremental reviews (#208, #209).

A previous run posted line-anchored inline comments carrying a content
fingerprint marker (see build_review_comments.finding_marker). On an
incremental review this script matches the PR's open review threads by that
marker and, for each carried finding:

- resolution "resolved" (carry-forward's fail-closed rule): the thread is
  resolved via the GraphQL resolveReviewThread mutation, so authors see live
  thread state instead of stale open conversations (#208);
- still open (still_open / not_verifiable_from_delta / unanswered): a short
  reply is posted on the existing thread instead of letting the publish step
  duplicate the finding as a fresh inline comment (#209).

It also writes the fingerprints of threads that remain open to an output
file; build_review_comments.py uses it to suppress duplicate anchored
comments for findings that already have a live thread.

Best-effort by design: any API failure warns and exits 0 — thread management
must never fail the publish step. Fork PRs with a read-only token simply
leave threads untouched.

Threads are matched by the marker their first comment carries, never by
author: /user returns 403 for installation tokens (#190).

Usage: resolve_finding_threads.py PREVIOUS_FINDINGS_JSON FINDINGS_JSON_FILE [OPEN_THREADS_OUT]

Environment:
  REPO                 owner/repo of the pull request
  PR_NUMBER            pull request number
  HEAD_SHA             current head SHA, stamped into follow-up replies for
                       idempotency (optional)
  INLINE_FINDINGS_MAX  cap on follow-up replies per run (default 20)
  GH_TOKEN             used implicitly by gh
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
from pr_reviewer.platform import PlatformUnsupported, gh_argv  # noqa: E402

_THREADS_QUERY = (
    "query($owner: String!, $name: String!, $number: Int!) {"
    " repository(owner: $owner, name: $name) {"
    " pullRequest(number: $number) {"
    " reviewThreads(first: 100) {"
    " nodes { id isResolved"
    " first: comments(first: 1) { nodes { body databaseId } }"
    " last: comments(last: 1) { nodes { body } }"
    " } } } } }"
)

_RESOLVE_MUTATION = (
    "mutation($id: ID!) {"
    " resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }"
)

_MAX_THREADS_PAGE = 100

# Hidden idempotency stamp on follow-up replies: a re-run on the same head
# must not stack identical "still open" replies on the thread.
FOLLOWUP_MARKER_PREFIX = "<!-- ai-pr-review-followup:"


def _run_gh(args: list, timeout: int = 60):
    """Run gh and return the parsed JSON dict from stdout, or None.

    On HTTP errors gh prints the JSON error body to STDOUT (#190), so a
    non-zero exit discards stdout entirely instead of trying to parse it.
    Anything that is not a JSON object is treated as a failure.

    The argv goes through the platform seam (#221). Thread management is
    GraphQL-only, so on PLATFORM=forgejo it degrades to a no-op (None) like
    every other best-effort failure here — #224 brings the Forgejo backend.
    """
    try:
        argv = gh_argv(args)
    except PlatformUnsupported:
        return None
    try:
        completed = subprocess.run(
            argv,
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


def _gh_graphql(fields: list):
    return _run_gh(["api", "graphql", *fields])


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


def match_threads(thread_nodes) -> dict:
    """Map fingerprint -> thread info for unresolved marker-bearing threads.

    Only the first comment is checked for the marker — that is the thread
    starter the previous run posted; replies never carry it. The last
    comment's body is kept for follow-up idempotency checks.
    """
    matched = {}
    for node in thread_nodes or []:
        if not isinstance(node, dict) or node.get("isResolved"):
            continue
        thread_id = node.get("id")
        if not isinstance(thread_id, str) or not thread_id:
            continue
        first_nodes = (node.get("first") or {}).get("nodes") or []
        first = first_nodes[0] if first_nodes and isinstance(first_nodes[0], dict) else {}
        fingerprint = extract_marker_fingerprint(first.get("body"))
        if not fingerprint or fingerprint in matched:
            continue
        last_nodes = (node.get("last") or {}).get("nodes") or []
        last = last_nodes[0] if last_nodes and isinstance(last_nodes[0], dict) else {}
        comment_id = first.get("databaseId")
        matched[fingerprint] = {
            "thread_id": thread_id,
            "first_comment_id": comment_id if isinstance(comment_id, int) else None,
            "last_body": last.get("body") if isinstance(last.get("body"), str) else "",
        }
    return matched


def threads_to_resolve(thread_nodes, fingerprints: set) -> list:
    """Thread node ids whose first comment matches a resolved fingerprint."""
    matched = match_threads(thread_nodes)
    return [info["thread_id"] for fp, info in matched.items() if fp in fingerprints]


def followup_body(item: dict, head_sha: str) -> str:
    """Reply text for a carried finding that survived this review."""
    if item.get("resolution") == "not_verifiable_from_delta":
        text = "Not verifiable from this push's delta; carried forward as open."
    else:
        text = "Still open after this push; carried forward."
    if head_sha:
        text = f"{text} (as of {head_sha[:12]})"
        return f"_{text}_\n\n{FOLLOWUP_MARKER_PREFIX}{head_sha} -->"
    return f"_{text}_"


def main(argv) -> int:
    previous_path = argv[1] if len(argv) > 1 else "previous-findings.json"
    findings_path = argv[2] if len(argv) > 2 else "findings.json"
    open_threads_out = argv[3] if len(argv) > 3 else None

    repo = os.getenv("REPO", "")
    pr_number = os.getenv("PR_NUMBER", "")
    head_sha = os.getenv("HEAD_SHA", "").strip()
    if "/" not in repo or not pr_number.isdigit():
        print("resolve_finding_threads: missing REPO/PR_NUMBER; skipping", file=sys.stderr)
        return 0
    try:
        max_replies = max(1, int(os.getenv("INLINE_FINDINGS_MAX", "20")))
    except ValueError:
        max_replies = 20

    carried = load_carried_findings(previous_path)
    if not carried:
        return 0

    try:
        findings = json.loads(Path(findings_path).read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        findings = []

    resolved_fps = resolved_fingerprints(carried, findings)
    resolutions = {
        f["id"]: f.get("resolution")
        for f in findings
        if isinstance(f, dict) and isinstance(f.get("id"), str)
    }
    open_by_fp = {}
    for item in carried:
        if resolutions.get(item.get("id")) != "resolved":
            entry = dict(item)
            entry["resolution"] = resolutions.get(item.get("id")) or "still_open"
            open_by_fp[finding_fingerprint(item)] = entry

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
        print("  WARN: could not list review threads; skipping thread management", file=sys.stderr)
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
            f"{_MAX_THREADS_PAGE} were checked",
            file=sys.stderr,
        )

    matched = match_threads(thread_nodes)

    # Resolve threads whose carried finding this review verified as fixed (#208).
    to_resolve = [(fp, info) for fp, info in matched.items() if fp in resolved_fps]
    resolved = 0
    for _fp, info in to_resolve:
        result = _gh_graphql(["-f", f"query={_RESOLVE_MUTATION}", "-f", f"id={info['thread_id']}"])
        if result is not None:
            resolved += 1
        else:
            print(
                f"  WARN: could not resolve review thread {info['thread_id']} "
                "(may require additional permissions)",
                file=sys.stderr,
            )

    # Reply on threads whose carried finding is still open (#209), instead of
    # letting the publish step duplicate it as a fresh anchored comment.
    replies = 0
    skipped_dup = 0
    for fp, info in matched.items():
        if fp in resolved_fps:
            continue
        item = open_by_fp.get(fp)
        if item is None:
            # Thread belongs to a finding this run did not carry (e.g. beyond
            # the carry cap) — leave it alone.
            continue
        if head_sha and f"{FOLLOWUP_MARKER_PREFIX}{head_sha} -->" in info["last_body"]:
            skipped_dup += 1
            continue
        if replies >= max_replies:
            print(
                f"  NOTE: follow-up reply cap ({max_replies}) reached; remaining "
                "open threads left without a reply",
                file=sys.stderr,
            )
            break
        if info["first_comment_id"] is None:
            continue
        result = _run_gh(
            [
                "api", f"repos/{repo}/pulls/{pr_number}/comments",
                "--method", "POST",
                "-F", f"in_reply_to={info['first_comment_id']}",
                "-f", f"body={followup_body(item, head_sha)}",
            ]
        )
        if result is not None:
            replies += 1
        else:
            print(
                f"  WARN: could not reply on review thread {info['thread_id']} "
                "(may require additional permissions)",
                file=sys.stderr,
            )

    # Fingerprints with a surviving open thread: the comment builder uses
    # these to suppress duplicate anchored comments (#209).
    if open_threads_out:
        surviving = sorted(fp for fp in matched if fp not in resolved_fps)
        try:
            Path(open_threads_out).write_text(
                json.dumps(surviving) + "\n", encoding="utf-8"
            )
        except OSError:
            print(f"  WARN: could not write {open_threads_out}", file=sys.stderr)

    print(
        f"resolve_finding_threads: resolved {resolved}/{len(to_resolve)} fixed thread(s), "
        f"replied on {replies} still-open thread(s)"
        + (f", {skipped_dup} already up to date" if skipped_dup else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
