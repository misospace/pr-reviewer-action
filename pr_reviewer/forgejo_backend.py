"""Forgejo REST backend for core PR I/O operations.

Provides a unified interface for PR metadata, diff retrieval, comment management,
issue fetching, and PR file listing — working with both GitHub (via ``gh`` CLI)
and Forgejo (via curl to ``/api/v1``).

Usage::

    from pr_reviewer.forgejo_backend import (
        get_pr_metadata,
        get_pr_diff,
        list_comments,
        create_comment,
        edit_last_comment,
        fetch_issue,
        list_pr_files,
    )

    # Defaults to GitHub mode. Set FORGEJO_API_URL to switch to Forgejo.
    metadata = get_pr_metadata("misospace/pr-reviewer-action", 42)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Any


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

FORGEJO_API_URL = os.environ.get("FORGEJO_API_URL", "").rstrip("/")
FORGEJO_TOKEN = os.environ.get("FORGEJO_TOKEN", os.environ.get("GITHUB_TOKEN", ""))
COMMENT_MARKER = os.environ.get(
    "COMMENT_MARKER", "<!-- ai-pr-reviewer -->"
)
GH_TOKEN = os.environ.get("GH_TOKEN", os.environ.get("GITHUB_TOKEN", ""))


def _is_forgejo_mode() -> bool:
    """Return True when FORGEJO_API_URL is set and non-empty."""
    return bool(FORGEJO_API_URL)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _curl(
    method: str,
    url: str,
    token: str | None = None,
    data: dict[str, Any] | bytes | None = None,
    accept: str = "application/json",
) -> tuple[int, str]:
    """Execute a curl request and return (http_status_code, body_text).

    Uses ``-w '\\n%{http_code}'`` to capture the actual HTTP status code.
    On HTTP errors the response body is written to stdout so callers can
    parse error payloads — this is the *error-body-on-stdout* discipline.
    """
    if token is None:
        token = FORGEJO_TOKEN or GH_TOKEN

    # The status code is appended after an explicit newline separator: bodies
    # are not guaranteed to end with whitespace (an empty 204 body, or compact
    # JSON without a trailing newline, would otherwise fuse with the code and
    # make it unparseable).
    cmd: list[str] = [
        "curl", "-sS",
        "-X", method.upper(),
        "-H", f"Authorization: token {token}",
        "-H", f"Accept: {accept}",
        "-o", "-",
        "-w", "\n%{http_code}",
        url,
    ]
    if data is not None and method.upper() in ("POST", "PATCH", "PUT"):
        if isinstance(data, bytes):
            cmd.extend(["--data-binary", "@-"])
            proc = subprocess.run(cmd, input=data, capture_output=True)
        else:
            body_json = json.dumps(data).encode("utf-8")
            cmd.extend(["-H", "Content-Type: application/json"])
            proc = subprocess.run(cmd, input=body_json, capture_output=True)
    else:
        proc = subprocess.run(cmd, capture_output=True)

    raw = proc.stdout.decode("utf-8", errors="replace")

    # Everything after the last newline is the HTTP status code we appended
    # with -w; everything before it is the body (possibly empty).
    body_text, sep, code_text = raw.rpartition("\n")
    if sep and code_text.strip().isdigit():
        http_code = int(code_text.strip())
    else:
        # No status code — curl failed entirely (network error).
        http_code = proc.returncode if proc.returncode != 0 else 500
        body_text = raw

    return http_code, body_text


def _gh(*args: str) -> tuple[int, str]:
    """Execute a ``gh`` CLI command and return (returncode, stdout)."""
    cmd = ["gh"] + list(args)
    proc = subprocess.run(cmd, capture_output=True)
    return proc.returncode, proc.stdout.decode("utf-8", errors="replace")


def _parse_repo(repo_full_name: str) -> tuple[str, str]:
    """Split ``owner/repo`` into (owner, repo)."""
    parts = repo_full_name.split("/", 1)
    if len(parts) != 2:
        raise ValueError(f"Invalid repo full name: {repo_full_name}")
    return parts[0], parts[1]


def _json_decode(text: str) -> Any:
    """Decode JSON, returning None on failure."""
    if not text.strip():
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# PR Metadata
# ---------------------------------------------------------------------------

def get_pr_metadata(repo_full_name: str, pr_number: int) -> dict[str, Any] | None:
    """Return PR metadata as a dict.

    Returns ``None`` if the PR cannot be fetched.
    """
    owner, repo = _parse_repo(repo_full_name)

    if _is_forgejo_mode():
        status_code, body = _curl(
            "GET",
            f"{FORGEJO_API_URL}/api/v1/repos/{owner}/{repo}/pulls/{pr_number}",
        )
        if status_code != 200:
            return None
        data = _json_decode(body)
        if data is None:
            return None
        return _forgejo_pr_to_github(data, owner, repo, pr_number)

    # GitHub via gh CLI. The REST pulls endpoint already returns the exact
    # shape this module normalises Forgejo into (snake_case, user/head/base
    # objects), so no field mapping is needed. ``gh pr view --json`` is NOT
    # equivalent — its fields are camelCase (author/headRefOid/mergedAt) and
    # it has no user/head/base keys at all.
    status_code, body = _gh(
        "api", f"repos/{owner}/{repo}/pulls/{pr_number}",
    )
    if status_code != 0 or not body.strip():
        return None
    return _json_decode(body)


def _forgejo_pr_to_github(data: dict, owner: str, repo: str, pr_number: int = 0) -> dict[str, Any]:
    """Normalise a Forgejo PR response to the GitHub shape used by callers.

    Field names verified against a live Forgejo instance (Codeberg
    ``/api/v1``): the PR object uses ``number``/``state``/``draft``, and
    ``head``/``base`` are ``{label, ref, repo, repo_id, sha}`` where
    ``repo.full_name`` carries the repository identity. ``head.repo`` is the
    *fork* repo on fork PRs — it must never be defaulted to the base repo,
    or fork detection (and the fork gating built on it) fails open.
    """
    head = data.get("head") or {}
    base = data.get("base") or {}

    def _branch_repo_full_name(branch: dict) -> str:
        # Missing repo (e.g. deleted fork) yields "" so is_fork_pr can treat
        # the origin as unknown rather than silently same-repo.
        return ((branch.get("repo") or {}).get("full_name")) or ""

    return {
        "number": data.get("number", pr_number),
        "title": data.get("title", ""),
        "body": data.get("body", ""),
        "state": data.get("state", "open"),
        "user": {"login": (data.get("user") or {}).get("login", "")},
        "head": {
            "sha": head.get("sha", ""),
            "ref": head.get("ref", ""),
            "repo": {"full_name": _branch_repo_full_name(head)},
        },
        "base": {
            "sha": base.get("sha", ""),
            "ref": base.get("ref", ""),
            "repo": {"full_name": _branch_repo_full_name(base) or f"{owner}/{repo}"},
        },
        "merged_at": data.get("merged_at", None),
        "created_at": data.get("created_at", ""),
        "updated_at": data.get("updated_at", ""),
        "url": data.get("html_url", f"https://{FORGEJO_API_URL.replace('http://', '').replace('https://', '')}/{owner}/{repo}/pulls/{data.get('number', pr_number)}"),
        "draft": bool(data.get("draft", False)),
        "labels": [{"name": l.get("name", "")} for l in data.get("labels", [])],
    }


# ---------------------------------------------------------------------------
# PR Diff
# ---------------------------------------------------------------------------

def get_pr_diff(repo_full_name: str, pr_number: int) -> str:
    """Return the raw unified diff for a PR.

    Returns an empty string on failure.
    """
    if _is_forgejo_mode():
        status_code, body = _curl(
            "GET",
            f"{FORGEJO_API_URL}/api/v1/repos/{_parse_repo(repo_full_name)[0]}/{_parse_repo(repo_full_name)[1]}/pulls/{pr_number}.diff",
        )
        if status_code != 200:
            return ""
        return body

    # GitHub via gh CLI
    status_code, body = _gh("pr", "diff", str(pr_number), "--repo", repo_full_name)
    if status_code != 0:
        return ""
    return body


# ---------------------------------------------------------------------------
# Issue Comments (list / create / edit)
# ---------------------------------------------------------------------------

def list_comments(repo_full_name: str, issue_number: int) -> list[dict[str, Any]]:
    """List all comments on a PR or issue.

    Returns a list of dicts with keys: ``id``, ``body``, ``created_at``, ``updated_at``, ``user``.
    """
    owner, repo = _parse_repo(repo_full_name)

    if _is_forgejo_mode():
        # Forgejo API returns comments; paginate via page param (max 50 per page).
        all_comments: list[dict] = []
        page = 1
        while True:
            status_code, body = _curl(
                "GET",
                f"{FORGEJO_API_URL}/api/v1/repos/{owner}/{repo}/issues/{issue_number}/comments?page={page}&limit=50",
            )
            if status_code != 200:
                break
            comments = _json_decode(body)
            if not isinstance(comments, list) or not comments:
                break
            all_comments.extend(comments)
            if len(comments) < 50:
                break
            page += 1

        return [_forgejo_comment_to_standard(c, owner, repo) for c in all_comments]

    # GitHub via gh CLI
    status_code, body = _gh(
        "api", f"repos/{owner}/{repo}/issues/{issue_number}/comments",
        "--paginate",
        "--jq", ".[] | {id: .id, body: .body, created_at: .created_at, updated_at: .updated_at, user: .user.login}",
    )
    if status_code != 0 or not body.strip():
        return []

    results = []
    for line in body.strip().split("\n"):
        parsed = _json_decode(line)
        if parsed:
            results.append(parsed)
    return results


def _forgejo_comment_to_standard(comment: dict, owner: str, repo: str) -> dict[str, Any]:
    """Normalise a Forgejo comment to the standard shape."""
    user = comment.get("user", {})
    return {
        "id": comment.get("id", 0),
        "body": comment.get("body", ""),
        "created_at": comment.get("created_at", comment.get("created_on", "")),
        "updated_at": comment.get("updated_at", comment.get("updated_on", "")),
        "user": user.get("login", ""),
    }


def create_comment(
    repo_full_name: str,
    issue_number: int,
    body: str,
) -> dict[str, Any] | None:
    """Create a new comment on a PR or issue.

    Returns the created comment dict (with ``id`` and ``html_url``), or ``None`` on failure.
    """
    owner, repo = _parse_repo(repo_full_name)

    if _is_forgejo_mode():
        status_code, body_text = _curl(
            "POST",
            f"{FORGEJO_API_URL}/api/v1/repos/{owner}/{repo}/issues/{issue_number}/comments",
            data={"body": body},
        )
        if status_code != 201:
            return None
        data = _json_decode(body_text)
        if data is None:
            return None
        return {
            "id": data.get("id", 0),
            "html_url": data.get("html_url", ""),
            "body": data.get("body", body),
        }

    # GitHub via gh CLI. Plain creation — ``--create-if-none`` is only valid
    # together with ``--edit-last`` and is a flag-parse error on its own.
    status_code, body_text = _gh(
        "pr", "comment", str(issue_number),
        "--repo", repo_full_name,
        "--body", body,
    )
    if status_code != 0 or not body_text.strip():
        return None

    # gh prints the comment URL as .../pull/N#issuecomment-ID (no slash
    # before the fragment).
    url_match = re.search(r"https?://\S+/pull/[0-9]+#issuecomment-[0-9]+", body_text)
    comment_id_match = re.search(r"#issuecomment-([0-9]+)", body_text or "")
    return {
        "id": int(comment_id_match.group(1)) if comment_id_match else 0,
        "html_url": url_match.group(0) if url_match else "",
        "body": body,
    }


def edit_last_comment(
    repo_full_name: str,
    issue_number: int,
    new_body: str,
    marker: str = COMMENT_MARKER,
) -> dict[str, Any] | None:
    """Edit the last comment containing *marker*, or create a new one.

    This implements the "sticky comment" pattern used by the review action:
    if a comment with the marker exists, edit it in place; otherwise create
    a new comment.

    Returns the comment dict with ``id`` and ``html_url``, or ``None`` on failure.
    """
    owner, repo = _parse_repo(repo_full_name)

    if _is_forgejo_mode():
        # List comments and find the latest one containing the marker
        comments = list_comments(repo_full_name, issue_number)
        matching = [c for c in comments if marker in (c.get("body") or "")]

        if matching:
            # Sort by updated_at descending to get the latest
            matching.sort(key=lambda c: c.get("updated_at", ""), reverse=True)
            target = matching[0]

            status_code, body_text = _curl(
                "PATCH",
                f"{FORGEJO_API_URL}/api/v1/repos/{owner}/{repo}/issues/comments/{target['id']}",
                data={"body": new_body},
            )
            if status_code != 200:
                return None
            data = _json_decode(body_text)
            if data is None:
                return None
            return {
                "id": target["id"],
                "html_url": data.get("html_url", ""),
                "body": new_body,
            }

        # No matching comment — create a new one
        return create_comment(repo_full_name, issue_number, new_body)

    # GitHub via gh CLI
    status_code, body_text = _gh(
        "pr", "comment", str(issue_number),
        "--repo", repo_full_name,
        "--edit-last",
        "--body", new_body,
    )
    if status_code != 0:
        # --edit-last fails when no comment exists; fall back to create
        return create_comment(repo_full_name, issue_number, new_body)

    url_match = re.search(r"https?://\S+/pull/[0-9]+#issuecomment-[0-9]+", body_text)
    comment_id_match = re.search(r"#issuecomment-([0-9]+)", body_text or "")
    return {
        "id": int(comment_id_match.group(1)) if comment_id_match else 0,
        "html_url": url_match.group(0) if url_match else "",
        "body": new_body,
    }


# ---------------------------------------------------------------------------
# Issue Fetch (for linked issues)
# ---------------------------------------------------------------------------

def fetch_issue(repo_full_name: str, issue_number: int) -> dict[str, Any] | None:
    """Fetch an issue's body and metadata.

    Returns ``None`` on failure.
    """
    owner, repo = _parse_repo(repo_full_name)

    if _is_forgejo_mode():
        status_code, body_text = _curl(
            "GET",
            f"{FORGEJO_API_URL}/api/v1/repos/{owner}/{repo}/issues/{issue_number}",
        )
        if status_code != 200:
            return None
        data = _json_decode(body_text)
        if data is None:
            return None
        return {
            "body": data.get("body", ""),
            "title": data.get("title", ""),
            "state": data.get("state", "open"),
            "created_at": data.get("created_at", ""),
            "updated_at": data.get("updated_at", ""),
        }

    # GitHub via gh CLI
    status_code, body_text = _gh(
        "api", f"repos/{owner}/{repo}/issues/{issue_number}",
    )
    if status_code != 0:
        return None
    data = _json_decode(body_text)
    if data is None:
        return None
    return {
        "body": data.get("body", ""),
        "title": data.get("title", ""),
        "state": data.get("state", "open"),
        "created_at": data.get("created_at", ""),
        "updated_at": data.get("updated_at", ""),
    }


# ---------------------------------------------------------------------------
# PR Files (for classifier)
# ---------------------------------------------------------------------------

def list_pr_files(repo_full_name: str, pr_number: int) -> list[dict[str, Any]]:
    """Return the list of changed files in a PR.

    Each dict has at least ``filename``, ``status``, ``additions``, ``deletions``.
    """
    owner, repo = _parse_repo(repo_full_name)

    if _is_forgejo_mode():
        status_code, body_text = _curl(
            "GET",
            f"{FORGEJO_API_URL}/api/v1/repos/{owner}/{repo}/pulls/{pr_number}/files",
        )
        if status_code != 200:
            return []
        data = _json_decode(body_text)
        if not isinstance(data, list):
            return []

        return [
            {
                "filename": f.get("filename", f.get("path", "")),
                "status": f.get("status", "changed"),
                "additions": f.get("additions", 0),
                "deletions": f.get("deletions", 0),
                "changes": f.get("changes", 0),
                "patch": f.get("patch", ""),
                "previous_filename": f.get("previous_filename", None),
            }
            for f in data
        ]

    # GitHub via gh CLI
    status_code, body_text = _gh(
        "api", f"repos/{owner}/{repo}/pulls/{pr_number}/files",
        "--paginate",
        "--jq", ".[] | {filename: .filename, status: .status, additions: .additions, deletions: .deletions, changes: .changes}",
    )
    if status_code != 0 or not body_text.strip():
        return []

    results = []
    for line in body_text.strip().split("\n"):
        parsed = _json_decode(line)
        if parsed:
            results.append(parsed)
    return results


# ---------------------------------------------------------------------------
# Convenience: check if PR is a fork PR
# ---------------------------------------------------------------------------

def is_fork_pr(repo_full_name: str, pr_number: int) -> bool:
    """Return True if the PR originates from a fork.

    Both backends yield the same normalised shape, so a single comparison
    serves both. A missing head repo (GitHub returns ``head.repo: null``
    when a fork was deleted; Forgejo normalisation yields ``""``) is treated
    as a fork — an unknown origin must fail closed because fork gating
    (tool harness / evidence providers) keys off this answer.
    """
    metadata = get_pr_metadata(repo_full_name, pr_number)
    if metadata is None:
        return False

    head_full = ((metadata.get("head") or {}).get("repo") or {}).get("full_name") or ""
    base_full = ((metadata.get("base") or {}).get("repo") or {}).get("full_name") or ""
    if not head_full:
        return True
    return head_full != base_full



# ---------------------------------------------------------------------------
# Commit Statuses (CI wait — issue #225)
# ---------------------------------------------------------------------------

def get_commit_status(repo_full_name: str, sha: str) -> dict[str, Any] | None:
    """Return the combined commit status for a SHA.

    On GitHub this is ``GET /repos/{owner}/{repo}/commits/{sha}/status``.
    On Forgejo it is ``GET /api/v1/repos/{owner}/{repo}/commits/{sha}/status``.
    Returns a dict with keys ``state``, ``total_count``, ``statuses`` (list),
    or ``None`` on failure.
    """
    owner, repo = _parse_repo(repo_full_name)

    if _is_forgejo_mode():
        status_code, body_text = _curl(
            "GET",
            f"{FORGEJO_API_URL}/api/v1/repos/{owner}/{repo}/commits/{sha}/status",
        )
        if status_code != 200:
            return None
        data = _json_decode(body_text)
        if data is None:
            return None
        # Forgejo's combined-status object names the per-entry field ``status``
        # (verified against Codeberg), whereas GitHub names it ``state``.
        # Normalize each entry to ``state`` so downstream consumers (the
        # wait_for_ci.sh jq filters) read one uniform shape across platforms.
        statuses = []
        for s in data.get("statuses", []) or []:
            entry = dict(s)
            entry["state"] = entry.get("state", entry.get("status"))
            statuses.append(entry)
        return {
            "state": data.get("state", "pending"),
            "total_count": len(statuses),
            "statuses": statuses,
        }

    # GitHub via gh CLI — already returns the right shape.
    status_code, body_text = _gh(
        "api", f"repos/{owner}/{repo}/commits/{sha}/status",
    )
    if status_code != 0 or not body_text.strip():
        return None
    return _json_decode(body_text)


# ---------------------------------------------------------------------------
# CLI entry-point for standalone testing
# ---------------------------------------------------------------------------

def main() -> None:
    """Minimal CLI for manual testing."""
    import argparse

    parser = argparse.ArgumentParser(description="Forgejo backend CLI")
    sub = parser.add_subparsers(dest="command")

    p_meta = sub.add_parser("get-pr-metadata")
    p_meta.add_argument("repo")
    p_meta.add_argument("pr_number", type=int)

    p_diff = sub.add_parser("get-pr-diff")
    p_diff.add_argument("repo")
    p_diff.add_argument("pr_number", type=int)

    p_comments = sub.add_parser("list-comments")
    p_comments.add_argument("repo")
    p_comments.add_argument("issue_number", type=int)

    p_create = sub.add_parser("create-comment")
    p_create.add_argument("repo")
    p_create.add_argument("issue_number", type=int)
    p_create.add_argument("body")

    p_edit = sub.add_parser("edit-last-comment")
    p_edit.add_argument("repo")
    p_edit.add_argument("issue_number", type=int)
    p_edit.add_argument("body")

    p_issue = sub.add_parser("fetch-issue")
    p_issue.add_argument("repo")
    p_issue.add_argument("issue_number", type=int)

    p_files = sub.add_parser("list-pr-files")
    p_files.add_argument("repo")
    p_files.add_argument("pr_number", type=int)

    p_status = sub.add_parser("commit-status")
    p_status.add_argument("repo")
    p_status.add_argument("sha")

    args = parser.parse_args()

    if args.command == "get-pr-metadata":
        result = get_pr_metadata(args.repo, args.pr_number)
        print(json.dumps(result, indent=2) if result else "null")
    elif args.command == "get-pr-diff":
        print(get_pr_diff(args.repo, args.pr_number))
    elif args.command == "list-comments":
        print(json.dumps(list_comments(args.repo, args.issue_number), indent=2))
    elif args.command == "create-comment":
        result = create_comment(args.repo, args.issue_number, args.body)
        print(json.dumps(result, indent=2) if result else "null")
    elif args.command == "edit-last-comment":
        result = edit_last_comment(args.repo, args.issue_number, args.body)
        print(json.dumps(result, indent=2) if result else "null")
    elif args.command == "fetch-issue":
        result = fetch_issue(args.repo, args.issue_number)
        print(json.dumps(result, indent=2) if result else "null")
    elif args.command == "list-pr-files":
        print(json.dumps(list_pr_files(args.repo, args.pr_number), indent=2))
    elif args.command == "commit-status":
        result = get_commit_status(args.repo, args.sha)
        print(json.dumps(result, indent=2) if result else "null")
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
