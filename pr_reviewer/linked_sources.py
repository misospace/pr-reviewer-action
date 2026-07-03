#!/usr/bin/env python3
"""Linked-source markdown rendering for PR enrichment.

Renders ``linked-sources.md`` from extracted URLs: fetches allowlisted
sources in parallel, then augments GitHub/Forgejo release & compare URLs and
ghcr.io image paths with structured API metadata. Extracted from
``scripts/run_enrichment.py`` (#359) so the rendering + budget logic is unit
testable.

Network access goes through the module-level ``fetch_url`` / ``gh_api_call``
names (so tests can monkeypatch them here) and is bounded by a
``BudgetTracker``.
"""

from __future__ import annotations

import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse

from pr_reviewer.budget import BudgetTracker
from pr_reviewer.enrichment import (
    classify_url,
    host_allowed,
    normalize_url,
)
from pr_reviewer.forgejo_backend import (
    fetch_forge_compare,
    fetch_forge_release,
)
from pr_reviewer.http_client import fetch_url, gh_api_call

# reduce_source lives in scripts/strip_source_text.py; put scripts/ on the
# path so this module reuses the single HTML-strip implementation rather than
# duplicating it.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
from strip_source_text import reduce_source  # noqa: E402

SKIP_FETCH_HOSTS = {"gitlab.com", "bitbucket.org"}


def strip_source_to_text(raw_bytes: bytes, max_bytes: int = 4000) -> str:
    """Strip HTML to visible text, or pass through plain text."""
    return reduce_source(raw_bytes, max_bytes)


def _pick(d: dict, keys: tuple[str, ...]) -> dict:
    """Project a dict onto the given keys, dropping absent ones."""
    return {k: d.get(k) for k in keys if k in d}


def _commit_summaries(commits: list, with_author: bool = False) -> list[dict]:
    """Reduce compare-API commit objects to sha + message (+ author/date)."""
    out = []
    for c in commits:
        commit = c.get("commit") or {}
        entry: dict = {"sha": c.get("sha"), "commit": {"message": commit.get("message")}}
        if with_author:
            entry["commit"]["author"] = commit.get("author")
            entry["commit"]["date"] = (commit.get("author") or {}).get("date")
        out.append(entry)
    return out


def render_linked_sources(
    urls: list[str],
    allowed_hosts: set[str],
    gh_token: str | None,
    target_version: str,
    ghcr_images: list[str],
    compare_shas: tuple[str, str] | None,
    budget: BudgetTracker,
) -> str:
    """Render linked-sources.md content."""
    lines: list[str] = []

    if not urls:
        return ""

    # Phase 1: parallel fetch of allowlisted URLs
    fetch_urls: list[tuple[int, str]] = []
    for i, url in enumerate(urls[:25]):
        normalized = normalize_url(url)
        host = _extract_host(normalized)
        if host in SKIP_FETCH_HOSTS or host == "github.com":
            continue
        if host_allowed(normalized, allowed_hosts):
            fetch_urls.append((i + 1, normalized))

    fetched: dict[int, bytes | None] = {}
    if fetch_urls and budget.ok():
        with ThreadPoolExecutor(max_workers=min(8, len(fetch_urls))) as pool:
            futures = {}
            for idx, url in fetch_urls:
                if not budget.ok():
                    break
                futures[pool.submit(fetch_url, url, timeout=25)] = idx
            for fut in as_completed(futures):
                fetched[futures[fut]] = fut.result()

    # Phase 2: render each URL section
    repo_candidates: list[str] = []
    seen_repos: set[str] = set()

    # One releases fetch per unique repo, shared between the per-URL "Recent
    # Releases" rendering (Phase 2) and the releases enrichment (Phase 3).
    releases_cache: dict[str, list | None] = {}

    def get_releases(owner: str, repo: str) -> list | None:
        key = f"{owner}/{repo}"
        if key not in releases_cache:
            data = gh_api_call(f"repos/{owner}/{repo}/releases?per_page=30", gh_token)
            releases_cache[key] = data if isinstance(data, list) else None
        return releases_cache[key]

    for i, url in enumerate(urls[:25], 1):
        if not budget.ok():
            break

        normalized = normalize_url(url)
        host = _extract_host(normalized)

        lines.append(f"## Source {i}")
        lines.append(f"URL: {url}")
        if normalized != url:
            lines.append(f"Normalized URL: {normalized}")
        lines.append("")
        lines.append("### Fetched Content (truncated)")

        if host_allowed(normalized, allowed_hosts):
            if host == "github.com":
                lines.append(
                    "(Raw HTML fetch skipped for github.com — structured release/compare metadata is captured below when available)"
                )
            elif host in SKIP_FETCH_HOSTS:
                lines.append(f"(Raw HTML fetch skipped for known non-Forgejo host: {host})")
            elif i in fetched and fetched[i]:
                text = strip_source_to_text(fetched[i])
                if text:
                    lines.append("```text")
                    lines.append(text)
                    lines.append("")
                    lines.append("```")
                else:
                    lines.append("(No content captured from URL)")
            else:
                lines.append(f"(Failed to fetch allowlisted URL content from {host})")
        else:
            lines.append(f"(Skipped non-allowlisted URL: {host})")

        # GitHub release metadata
        cls = classify_url(normalized)
        if cls and cls["type"] == "github_release":
            lines.append("")
            lines.append(f"### GitHub Release Metadata: {cls['owner']}/{cls['repo']}@{cls['tag']}")
            if budget.ok():
                data = gh_api_call(
                    f"repos/{cls['owner']}/{cls['repo']}/releases/tags/{cls['tag']}",
                    gh_token,
                )
                if isinstance(data, dict):
                    filtered = _pick(data, ("tag_name", "name", "published_at", "html_url", "body"))
                    lines.append("```json")
                    lines.append(json.dumps(filtered, indent=2)[:5000])
                    lines.append("")
                    lines.append("```")
                else:
                    lines.append(f"(Could not fetch release metadata for tag {cls['tag']})")

            # Recent releases
            if budget.ok():
                data = get_releases(cls["owner"], cls["repo"])
                if isinstance(data, list):
                    filtered = [_pick(r, ("tag_name", "name", "published_at", "html_url")) for r in data[:8]]
                    lines.append("### Recent Releases")
                    lines.append("```json")
                    lines.append(json.dumps(filtered, indent=2)[:3000])
                    lines.append("")
                    lines.append("```")

        # GitHub compare metadata
        if cls and cls["type"] == "github_compare":
            lines.append("")
            lines.append(f"### GitHub Compare Metadata: {cls['owner']}/{cls['repo']}@{cls['compare_spec']}")
            if budget.ok():
                data = gh_api_call(
                    f"repos/{cls['owner']}/{cls['repo']}/compare/{cls['compare_spec']}",
                    gh_token,
                )
                if isinstance(data, dict):
                    filtered = {
                        "html_url": data.get("html_url"),
                        "status": data.get("status"),
                        "ahead_by": data.get("ahead_by"),
                        "behind_by": data.get("behind_by"),
                        "total_commits": data.get("total_commits"),
                        "commits": _commit_summaries(data.get("commits", [])[:20], with_author=True),
                    }
                    lines.append("```json")
                    lines.append(json.dumps(filtered, indent=2)[:7000])
                    lines.append("")
                    lines.append("```")

                    files = data.get("files", [])[:30]
                    file_list = [
                        _pick(f, ("filename", "status", "additions", "deletions", "changes", "patch"))
                        for f in files
                    ]
                    lines.append("### GitHub Compare Files")
                    lines.append("```json")
                    lines.append(json.dumps(file_list, indent=2)[:7000])
                    lines.append("")
                    lines.append("```")
                else:
                    lines.append(f"(Could not fetch compare metadata for {cls['owner']}/{cls['repo']}@{cls['compare_spec']})")

        # Forgejo release/compare (non-github.com hosts) — reuse forgejo_backend
        if cls and host != "github.com" and host_allowed(normalized, allowed_hosts):
            if cls["type"] == "forgejo_release":
                lines.append("")
                lines.append(f"### Forge Release Metadata: {cls['host']} {cls['owner']}/{cls['repo']}@{cls['tag']}")
                if budget.ok():
                    data = fetch_forge_release(cls["host"], f"{cls['owner']}/{cls['repo']}", cls["tag"])
                    if isinstance(data, dict):
                        lines.append("```json")
                        lines.append(json.dumps(data, indent=2)[:6000])
                        lines.append("")
                        lines.append("```")
                    else:
                        lines.append(f"(Could not fetch release metadata from {cls['host']} for tag {cls['tag']})")

            if cls["type"] == "forgejo_compare":
                lines.append("")
                lines.append(f"### Forge Compare Metadata: {cls['host']} {cls['owner']}/{cls['repo']}@{cls['compare_spec']}")
                if budget.ok():
                    data = fetch_forge_compare(cls["host"], f"{cls['owner']}/{cls['repo']}", cls["compare_spec"])
                    if isinstance(data, dict):
                        filtered = {
                            "total_commits": data.get("total_commits"),
                            "commits": _commit_summaries((data.get("commits") or [])[:20]),
                            "files": [{k: f.get(k) for k in ("filename", "status", "additions", "deletions")} for f in (data.get("files") or [])[:30]],
                        }
                        lines.append("```json")
                        lines.append(json.dumps(filtered, indent=2)[:7000])
                        lines.append("")
                        lines.append("```")
                    else:
                        lines.append(f"(Could not fetch compare metadata from {cls['host']} for {cls['compare_spec']})")

        # Collect GitHub repo candidates
        gh_match = re.match(r"https?://github\.com/([^/]+)/([^/?#]+)", normalized)
        if gh_match:
            repo_key = f"{gh_match.group(1)}/{gh_match.group(2)}"
            if repo_key not in seen_repos:
                seen_repos.add(repo_key)
                repo_candidates.append(repo_key)

        lines.append("")

    # Phase 3: GitHub releases enrichment for candidate repos
    for repo_key in repo_candidates:
        if not budget.ok():
            break
        owner, repo = repo_key.split("/", 1)

        lines.append("")
        lines.append(f"### GitHub Releases Enrichment: {repo_key}")

        if budget.ok():
            data = get_releases(owner, repo)
            if isinstance(data, list):
                filtered = [_pick(r, ("tag_name", "name", "published_at", "html_url")) for r in data]
                lines.append("#### Recent Releases (tags)")
                lines.append("```json")
                lines.append(json.dumps(filtered, indent=2)[:5000])
                lines.append("")
                lines.append("```")

                if target_version:
                    v_lower = target_version.lower()
                    matched = [
                        r for r in data
                        if (r.get("tag_name") or "").lower() == v_lower
                        or (r.get("tag_name") or "").lower() == f"v{v_lower}"
                        or v_lower in (r.get("tag_name") or "").lower()
                        or v_lower in (r.get("name") or "").lower()
                    ][:5]
                    if matched:
                        lines.append(f"#### Releases matching target version {target_version}")
                        lines.append("```json")
                        matched_filtered = [_pick(r, ("tag_name", "name", "published_at", "html_url", "body")) for r in matched]
                        lines.append(json.dumps(matched_filtered, indent=2)[:8000])
                        lines.append("")
                        lines.append("```")
                    else:
                        lines.append(f"(No release tags matched target version {target_version} in {repo_key})")
                        if budget.ok():
                            tags = gh_api_call(f"repos/{owner}/{repo}/tags?per_page=50", gh_token)
                            if isinstance(tags, list):
                                tag_list = [_pick(t, ("name", "commit")) for t in tags]
                                lines.append("#### Recent Tags")
                                lines.append("```json")
                                lines.append(json.dumps(tag_list, indent=2)[:4000])
                                lines.append("")
                                lines.append("```")
                            else:
                                lines.append(f"(Could not fetch tags list for {repo_key})")
            else:
                lines.append(f"(Could not fetch releases list for {repo_key})")

    # Phase 4: GHCR image path lookup
    if ghcr_images and budget.ok():
        for img_repo in ghcr_images:
            if not budget.ok():
                break
            if img_repo in seen_repos:
                continue

            owner = img_repo.split("/")[0]
            repo = img_repo.rsplit("/", 1)[-1]
            if not owner or not repo or owner == img_repo:
                continue

            lines.append("")
            lines.append(f"### GitHub Release Lookup via ghcr.io Path: {owner}/{repo}")

            found_release = False
            if target_version:
                for tag_prefix in (f"v{target_version}", target_version):
                    if not budget.ok():
                        break
                    data = gh_api_call(f"repos/{owner}/{repo}/releases/tags/{tag_prefix}", gh_token)
                    if isinstance(data, dict):
                        lines.append(f"#### Matched via ghcr.io path: {owner}/{repo}@{tag_prefix}")
                        filtered = _pick(data, ("tag_name", "name", "published_at", "html_url", "body"))
                        lines.append("```json")
                        lines.append(json.dumps(filtered, indent=2)[:8000])
                        lines.append("")
                        lines.append("```")
                        found_release = True
                        break

            if not found_release:
                if target_version:
                    lines.append(f"(No release found for {owner}/{repo} at version {target_version} via ghcr.io path inference)")
                else:
                    lines.append(f"(TARGET_VERSION not set; skipping release lookup for {owner}/{repo})")

            # Compare SHA fallback
            if not found_release and compare_shas and budget.ok():
                cmp_old, cmp_new = compare_shas
                data = gh_api_call(f"repos/{owner}/{repo}/compare/{cmp_old}...{cmp_new}", gh_token)
                if isinstance(data, dict) and data.get("status"):
                    lines.append(f"#### Commit compare {cmp_old}...{cmp_new} (no release published for this version)")
                    filtered = {
                        "html_url": data.get("html_url"),
                        "status": data.get("status"),
                        "ahead_by": data.get("ahead_by"),
                        "total_commits": data.get("total_commits"),
                        "commits": _commit_summaries(data.get("commits", [])[:20]),
                    }
                    lines.append("```json")
                    lines.append(json.dumps(filtered, indent=2)[:6000])
                    lines.append("")
                    lines.append("```")

                    files = data.get("files", [])[:30]
                    file_list = [{k: f.get(k) for k in ("filename", "status", "additions", "deletions", "changes")} for f in files]
                    lines.append("#### Changed Files")
                    lines.append("```json")
                    lines.append(json.dumps(file_list, indent=2)[:5000])
                    lines.append("")
                    lines.append("```")

    return "\n".join(lines) + ("\n" if lines else "")


def _extract_host(url: str) -> str:
    return (urlparse(url).hostname or "").lower()
