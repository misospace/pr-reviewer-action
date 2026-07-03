"""Pure extraction functions for PR enrichment context.

Moves brittle grep/sed pipelines from shell into testable Python.
Consumed by scripts/run_enrichment.py CLI and optionally sourced by shell sections.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse


# --- URL extraction ---

_URL_RE = re.compile(r"https?://[^ )\r\n]+")


def extract_urls(body: str, diff: str, limit: int | None = 25) -> list[str]:
    """Extract unique sorted URLs from PR body and diff, strip trailing punctuation.

    Pass limit=None for unbounded extraction.
    """
    combined = body + "\n" + diff
    urls: list[str] = []
    seen: set[str] = set()
    for m in _URL_RE.finditer(combined):
        url = m.group(0).rstrip('".,;')
        if url and url not in seen:
            seen.add(url)
            urls.append(url)
    urls.sort()
    return urls[:limit] if limit is not None else urls


def normalize_url(url: str) -> str:
    """Normalize redirect.github.com to github.com."""
    if url.startswith("https://redirect.github.com/"):
        return "https://github.com/" + url[len("https://redirect.github.com/"):]
    if url.startswith("http://redirect.github.com/"):
        return "http://github.com/" + url[len("http://redirect.github.com/"):]
    return url


# --- Host allowlist ---

def parse_allowed_hosts(raw: str) -> set[str]:
    """Parse comma-separated ALLOWED_SOURCE_HOSTS into a lowercase set."""
    if not raw:
        return set()
    return {h.strip().lower() for h in raw.split(",") if h.strip()}


def _url_host(url: str) -> str:
    parsed = urlparse(url)
    return (parsed.hostname or "").lower()


def host_allowed(url: str, allowed: set[str]) -> bool:
    """Check if a URL's host is in the allowlist."""
    return _url_host(url) in allowed


# --- Version hints ---

_VERSION_HINT_RE = re.compile(r"^[+-].*(?:image:|tag:|version:|chart:|appVersion:|digest:)")


def extract_version_hints(diff: str, limit: int | None = 180) -> list[str]:
    """Extract changed lines containing image/tag/version/chart/appVersion/digest.

    Pass limit=None for unbounded extraction.
    """
    hints: list[str] = []
    for line in diff.splitlines():
        if _VERSION_HINT_RE.match(line):
            hints.append(line)
            if limit is not None and len(hints) >= limit:
                break
    return hints


# --- Target version selection ---

_TITLE_VERSION_RE = re.compile(r"v?(\d+(?:\.\d+)+)")
_HINT_VERSION_RE = re.compile(r"v?(\d+\.\d+\.\d+)")


def select_target_version(title: str | None, version_hints: list[str]) -> str:
    """Select target version: title last version token > hint fallback > empty string.

    Falls back to the *last* semver found in hints (matching old shell tail -n1 semantics).
    Never raises. Returns "" when no version is found anywhere.
    """
    if title:
        matches = _TITLE_VERSION_RE.findall(title)
        if matches:
            return matches[-1]
    # Last semver in hints wins (tail -n1 semantics).
    last: str | None = None
    for hint in version_hints:
        m = _HINT_VERSION_RE.search(hint)
        if m:
            last = m.group(1)
    return last or ""


# --- GHCR image extraction ---

_GHCR_RE = re.compile(r"(?:oci://)?ghcr\.io/([^/]+(?:/[^:\"'@ )]+)+)")


def extract_ghcr_images(version_hints: list[str], diff: str) -> list[str]:
    """Extract ghcr.io image/chart repos from version hints and diff, strip tag/digest."""
    combined = "\n".join(version_hints) + "\n" + diff
    repos: set[str] = set()
    for m in _GHCR_RE.finditer(combined):
        path = m.group(1)
        # Strip tag or digest suffix
        path = re.sub(r"[:@].*", "", path)
        if path:
            repos.add(path)
    return sorted(repos)


# --- Compare SHA extraction ---

_HEX_SHA_RE = re.compile(r"\b([0-9a-fA-F]{7,40})\b")
_HEX_HAS_LETTER = re.compile(r"[a-fA-F]")


def extract_compare_shas(version_hints: list[str]) -> tuple[str, str] | None:
    """Extract old→new short-SHA pair from version hints.

    Returns (old_sha, new_sha) when exactly one hex SHA on removed lines and
    exactly one hex SHA on added lines, both containing a-f, and different.
    Returns None otherwise (no SHA, ambiguous, or identical).
    """
    old_shas: set[str] = set()
    new_shas: set[str] = set()

    for line in version_hints:
        if not line:
            continue
        shas = _HEX_SHA_RE.findall(line)
        # Filter: must contain at least one a-f character (excludes pure numeric versions)
        hex_shas = {s.lower() for s in shas if _HEX_HAS_LETTER.search(s)}
        if line.startswith("-"):
            old_shas.update(hex_shas)
        elif line.startswith("+"):
            new_shas.update(hex_shas)

    if len(old_shas) == 1 and len(new_shas) == 1:
        old = old_shas.pop()
        new = new_shas.pop()
        if old != new:
            return (old, new)
    return None


# --- URL classification ---

_GH_RELEASE_RE = re.compile(
    r"^https?://github\.com/([^/]+)/([^/]+)/releases/tag/([^/?#]+)"
)
_GH_COMPARE_RE = re.compile(
    r"^https?://github\.com/([^/]+)/([^/]+)/compare/([^?#]+)"
)
_FORGE_RELEASE_RE = re.compile(
    r"^https?://([^/]+)/([^/]+)/([^/]+)/releases/tag/([^/?#]+)"
)
_FORGE_COMPARE_RE = re.compile(
    r"^https?://([^/]+)/([^/]+)/([^/]+)/compare/([^?#]+)"
)


def classify_url(url: str) -> dict | None:
    """Classify a URL into GitHub/Forgejo release or compare metadata.

    Returns a dict with type, owner, repo, and type-specific fields, or None.
    Query strings and fragments in compare URLs do not break capture.
    """
    # GitHub release
    m = _GH_RELEASE_RE.match(url)
    if m:
        return {
            "type": "github_release",
            "owner": m.group(1),
            "repo": m.group(2),
            "tag": m.group(3),
        }

    # GitHub compare
    m = _GH_COMPARE_RE.match(url)
    if m:
        return {
            "type": "github_compare",
            "owner": m.group(1),
            "repo": m.group(2),
            "compare_spec": m.group(3),
        }

    # Forgejo release (skip github.com which is handled above)
    parsed_host = urlparse(url).hostname or ""
    if parsed_host.lower() != "github.com":
        m = _FORGE_RELEASE_RE.match(url)
        if m:
            return {
                "type": "forgejo_release",
                "host": m.group(1),
                "owner": m.group(2),
                "repo": m.group(3),
                "tag": m.group(4),
            }

        # Forgejo compare
        m = _FORGE_COMPARE_RE.match(url)
        if m:
            return {
                "type": "forgejo_compare",
                "host": m.group(1),
                "owner": m.group(2),
                "repo": m.group(3),
                "compare_spec": m.group(4),
            }

    return None


# --- Compare-payload summarization ---


def _pick(obj: dict, *keys) -> dict:
    """Project a dict onto the given keys, dropping absent ones."""
    return {k: obj[k] for k in keys if k in obj}


def _commit_summaries(commits: list) -> list[dict]:
    """Reduce compare-API commit objects to sha + message."""
    return [
        {"sha": c.get("sha", ""), "message": (c.get("commit", {}).get("message") or "")[:120]}
        for c in commits
    ]


def summarize_compare(compare_data: dict) -> dict:
    """Summarize a GitHub compare-payload response.

    Extracts the commit and file projections that are used both by
    ``run_enrichment`` and ``image_digest_analysis``.  Returns a dict with
    keys ``commits``, ``files``, and ``status``.
    """
    commits = _commit_summaries(compare_data.get("commits", []))
    files = [
        _pick(f, "filename", "status", "additions", "deletions", "changes")
        for f in compare_data.get("files", [])
    ]
    return {
        "commits": commits,
        "files": files,
        "status": compare_data.get("status"),
    }
