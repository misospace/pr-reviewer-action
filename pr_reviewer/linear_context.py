"""Deterministic Linear issue context for PR reviews.

The adapter discovers configured Linear issue identifiers in the PR title,
fetches them through Linear's GraphQL API, and renders the same linked-issue
shape consumed by the classifier and review corpus.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pr_reviewer.platform import USER_AGENT

LINEAR_API_URL = "https://api.linear.app/graphql"
MAX_LINEAR_ISSUES = 8
MAX_RESPONSE_BYTES = 1_000_000
MAX_DESCRIPTION_CHARS = 12_000
_PREFIX_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,15}$")

_ISSUE_QUERY = """
query PrReviewerIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    url
    state { name }
    labels { nodes { name } }
  }
}
""".strip()


class LinearContextError(RuntimeError):
    """Raised when Linear returns no usable issue context."""


def parse_prefixes(value: str) -> list[str]:
    """Parse a comma-separated allowlist of Linear team-key prefixes."""
    prefixes: list[str] = []
    for raw in value.split(","):
        prefix = raw.strip()
        if not prefix:
            continue
        if not _PREFIX_RE.fullmatch(prefix):
            raise ValueError(
                f"invalid Linear issue prefix {prefix!r}; expected letters/digits "
                "starting with a letter"
            )
        normalized = prefix.upper()
        if normalized not in prefixes:
            prefixes.append(normalized)
    return prefixes


def extract_issue_identifiers(
    title: str,
    prefixes: list[str],
    *,
    max_issues: int = MAX_LINEAR_ISSUES,
) -> list[str]:
    """Extract configured ``TEAM-123`` identifiers from a PR title."""
    if not prefixes or max_issues <= 0:
        return []
    alternatives = "|".join(re.escape(prefix) for prefix in prefixes)
    pattern = re.compile(
        rf"(?<![A-Za-z0-9])(?:{alternatives})-[0-9]+(?![A-Za-z0-9])",
        re.IGNORECASE,
    )
    identifiers: list[str] = []
    for match in pattern.finditer(title or ""):
        identifier = match.group(0).upper()
        if identifier not in identifiers:
            identifiers.append(identifier)
        if len(identifiers) >= max_issues:
            break
    return identifiers


def _graphql_error_message(payload: dict[str, Any]) -> str:
    messages = [
        str(item.get("message"))
        for item in payload.get("errors", [])
        if isinstance(item, dict) and item.get("message")
    ]
    return "; ".join(messages) or "Linear GraphQL request failed"


def fetch_issue(
    identifier: str,
    api_key: str,
    *,
    api_url: str = LINEAR_API_URL,
    timeout: int = 20,
) -> dict[str, Any]:
    """Fetch one Linear issue by human-readable identifier."""
    request_body = json.dumps(
        {"query": _ISSUE_QUERY, "variables": {"id": identifier}}
    ).encode("utf-8")
    request = Request(
        api_url,
        data=request_body,
        method="POST",
        headers={
            "Authorization": api_key,
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        raise LinearContextError(f"Linear HTTP error {exc.code}") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise LinearContextError(f"Linear request failed: {exc}") from exc

    if len(raw) > MAX_RESPONSE_BYTES:
        raise LinearContextError("Linear response exceeded the size limit")
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise LinearContextError("Linear returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise LinearContextError("Linear returned an invalid response shape")
    if payload.get("errors"):
        raise LinearContextError(_graphql_error_message(payload))
    issue = (payload.get("data") or {}).get("issue")
    if not isinstance(issue, dict):
        raise LinearContextError(f"Linear issue {identifier} was not found")

    labels = (issue.get("labels") or {}).get("nodes") or []
    normalized_labels = [
        {"name": str(label.get("name"))}
        for label in labels
        if isinstance(label, dict) and label.get("name")
    ]
    resolved_identifier = str(issue.get("identifier") or identifier).upper()
    return {
        "source": "linear",
        "ref": resolved_identifier,
        "identifier": resolved_identifier,
        "title": str(issue.get("title") or ""),
        "body": str(issue.get("description") or "")[:MAX_DESCRIPTION_CHARS],
        "url": str(issue.get("url") or ""),
        "state": str((issue.get("state") or {}).get("name") or ""),
        "labels": normalized_labels,
    }


def render_markdown(
    issues: list[dict[str, Any]], errors: list[tuple[str, str]]
) -> str:
    """Render fetched Linear issues as untrusted fenced JSON corpus data."""
    parts: list[str] = []
    for issue in issues:
        identifier = issue.get("identifier") or issue.get("ref") or "unknown"
        # Compact JSON keeps newlines and hostile Markdown fences in string
        # escapes, so issue content cannot close the corpus data fence.
        serialized = json.dumps(issue, ensure_ascii=False, separators=(",", ":"))
        parts.append(f"## Linear issue {identifier}\n```json\n{serialized}\n```\n")
    for identifier, message in errors:
        parts.append(
            f"## Linear issue {identifier}\n"
            f"(Could not fetch Linear issue {identifier}: {message})\n"
        )
    return "\n".join(parts)


def collect_from_pr(
    pr: dict[str, Any],
    prefixes: list[str],
    api_key: str,
    *,
    api_url: str = LINEAR_API_URL,
    timeout: int = 20,
) -> tuple[list[dict[str, Any]], list[tuple[str, str]]]:
    """Discover and fetch Linear issues referenced by the PR title."""
    issues: list[dict[str, Any]] = []
    errors: list[tuple[str, str]] = []
    for identifier in extract_issue_identifiers(str(pr.get("title") or ""), prefixes):
        try:
            issues.append(
                fetch_issue(identifier, api_key, api_url=api_url, timeout=timeout)
            )
        except LinearContextError as exc:
            errors.append((identifier, str(exc)))
    return issues, errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pr-json", default="pr.json")
    parser.add_argument("--prefixes", required=True)
    parser.add_argument("--output-json", default="linear-issues.json")
    parser.add_argument("--output-markdown", default="linear-issues.md")
    parser.add_argument("--timeout", type=int, default=20)
    args = parser.parse_args(argv)

    try:
        prefixes = parse_prefixes(args.prefixes)
    except ValueError as exc:
        print(f"linear_context: {exc}", file=sys.stderr)
        return 2

    api_key = os.getenv("LINEAR_API_KEY", "").strip()
    if not api_key:
        print("linear_context: LINEAR_API_KEY is required", file=sys.stderr)
        return 2

    try:
        pr = json.loads(Path(args.pr_json).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"linear_context: could not read PR JSON: {exc}", file=sys.stderr)
        return 2
    if not isinstance(pr, dict):
        print("linear_context: PR JSON must be an object", file=sys.stderr)
        return 2

    issues, errors = collect_from_pr(
        pr,
        prefixes,
        api_key,
        api_url=LINEAR_API_URL,
        timeout=max(1, args.timeout),
    )
    Path(args.output_json).write_text(
        json.dumps(issues, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    Path(args.output_markdown).write_text(
        render_markdown(issues, errors), encoding="utf-8"
    )
    if errors:
        print(
            f"linear_context: fetched {len(issues)} issue(s), "
            f"{len(errors)} fetch failure(s)",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
