#!/usr/bin/env python3
"""Linked-source markdown rendering for PR enrichment.

Renders ``linked-sources.md`` from extracted URLs: fetches allowlisted
sources in parallel, then augments GitHub/Forgejo release & compare URLs and
ghcr.io image paths with structured API metadata. Extracted from
``scripts/run_enrichment.py`` (#359) so the rendering + budget logic is unit
testable.

Network access goes through the module-level ``fetch_url`` / ``gh_api_call``
names (so tests can monkeypatch them here) and is bounded by a
``BudgetTracker``. ``render_linked_sources`` is a thin orchestrator; every
owner/repo security decision goes through the single ``_repo_allowed`` gate
(used by ``_GhApiCache`` and ``_collect_prewarm_endpoints``).
"""

from __future__ import annotations

import json
import re
import sys
import threading
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


def _repo_allowed(owner: str, repo: str, current_repo: str | None, allowed_repos: set[str] | None) -> bool:
    """Whether a (owner, repo) is in the operator-defined allowlist.

    Mirrors ``platform.gh_api``: only ``current_repo`` or ``allowed_repos``
    may be queried with the operator token, so a PR body linking to any other
    repo cannot make the token reach it.
    """
    key = f"{owner}/{repo}".lower()
    if current_repo and key == current_repo.lower():
        return True
    if allowed_repos:
        for ar in allowed_repos:
            if not ar:
                continue
            if key == ar.lower():
                return True
            if ar.lower().endswith("/*") and key == ar.lower()[:-2]:
                return True
            if ar.lower() == "*":
                return True
    return False


def _github_repo_key(url: str) -> str | None:
    """Extract ``owner/repo`` from a github.com URL, if any."""
    m = re.match(r"https?://github\.com/([^/]+)/([^/?#]+)", url)
    return f"{m.group(1)}/{m.group(2)}" if m else None


def render_linked_sources(
    urls: list[str],
    allowed_hosts: set[str],
    gh_token: str | None,
    target_version: str,
    ghcr_images: list[str],
    compare_shas: tuple[str, str] | None,
    budget: BudgetTracker,
    current_repo: str | None = None,
    allowed_repos: set[str] | None = None,
) -> str:
    """Render linked-sources.md content."""
    if not urls:
        return ""

    # Security: linked-source enrichment must not reach repos outside the
    # operator's allowlist, regardless of what URLs appear in the PR body (#509).
    blocked_repos: dict[str, list[str]] = {}
    api = _GhApiCache(gh_token, current_repo, allowed_repos, blocked_repos)

    # Phase 1: parallel fetch of allowlisted URLs; Phase 2-4 gh_api calls are
    # prewarmed concurrently into ``api`` before the render loop.
    fetched = _fetch_sections(urls, allowed_hosts, budget)
    _prewarm(
        api,
        _collect_prewarm_endpoints(
            urls, ghcr_images, target_version, current_repo, allowed_repos, blocked_repos
        ),
        budget,
    )

    # Phase 2: render each URL section in source order, collapsing sections
    # that yield only a skip notice into one trailing summary line (#372).
    lines: list[str] = []
    repo_candidates: list[str] = []
    seen_repos: set[str] = set()
    skipped_hosts: list[str] = []

    for i, url in enumerate(urls[:25], 1):
        if not budget.ok():
            break
        section, host, is_skip, enrich_start, repo_key = _render_source_section(
            i, url, allowed_hosts, fetched, api, budget
        )
        # Repo candidates are collected regardless of skip, so Phase 3
        # enrichment for github.com repos is unaffected.
        if repo_key and repo_key not in seen_repos:
            seen_repos.add(repo_key)
            repo_candidates.append(repo_key)
        if is_skip and not any(ln.strip() for ln in section[enrich_start:]):
            skipped_hosts.append(host)
        else:
            lines.extend(section)
            lines.append("")

    if skipped_hosts:
        # One trailing line for every collapsed source, hosts deduped + sorted.
        n = len(skipped_hosts)
        uniq = ", ".join(sorted(set(skipped_hosts)))
        lines.append(
            f"({n} source{'s' if n != 1 else ''} skipped — "
            f"non-allowlisted or non-fetchable hosts: {uniq})"
        )
        lines.append("")

    # Phases 3-4 + the refused-repo notice.
    _render_releases_enrichment(repo_candidates, lines, api, budget, target_version)
    _render_ghcr_lookup(ghcr_images, seen_repos, lines, api, budget, target_version, compare_shas)
    _render_blocked_repos(blocked_repos, lines)

    return "\n".join(lines) + ("\n" if lines else "")


class _GhApiCache:
    """Thread-safe ``gh api`` cache with the single #509 authorization gate.

    The prewarm fans the Phase 2-4 calls out concurrently into this cache and
    the render loop is served from it — parallelism changes only WHEN a call
    runs, never the deterministic source-ordered output. The lock also makes
    the per-repo releases cache (#366) safe against racing threads.
    """

    def __init__(self, gh_token: str | None, current_repo: str | None, allowed_repos: set[str] | None, blocked_repos: dict[str, list[str]]) -> None:
        self._lock = threading.Lock()
        self._cache: dict[str, dict | list | None] = {}
        self._token = gh_token
        self._current_repo = current_repo
        self._allowed_repos = allowed_repos
        self.blocked_repos = blocked_repos
        self.authorized_repos: set[str] = set()

    def get(self, endpoint: str) -> dict | list | None:
        """Return cached data for ``endpoint``, or fetch it fail-soft."""
        m = re.match(r"^repos/([^/]+)/([^/]+)/", endpoint)
        if m:
            key = f"{m.group(1)}/{m.group(2)}".lower()
            if not _repo_allowed(m.group(1), m.group(2), self._current_repo, self._allowed_repos):
                self.blocked_repos.setdefault(key, []).append(endpoint)
                return None
            self.authorized_repos.add(key)
        with self._lock:
            if endpoint in self._cache:
                return self._cache[endpoint]
        data = gh_api_call(endpoint, self._token)  # network outside the lock
        with self._lock:
            return self._cache.setdefault(endpoint, data)

    def releases(self, owner: str, repo: str) -> list | None:
        """One releases fetch per unique repo (#366), gated by #509; shared by
        Phase 2 "Recent Releases" and Phase 3 enrichment."""
        key = f"{owner}/{repo}".lower()
        if not _repo_allowed(owner, repo, self._current_repo, self._allowed_repos):
            self.blocked_repos.setdefault(key, []).append("releases")
            return None
        self.authorized_repos.add(key)
        data = self.get(f"repos/{owner}/{repo}/releases?per_page=30")
        return data if isinstance(data, list) else None


def _extract_host(url: str) -> str:
    return (urlparse(url).hostname or "").lower()


def _fetch_sections(urls: list[str], allowed_hosts: set[str], budget: BudgetTracker) -> dict[int, bytes | None]:
    """Fetch allowlisted URLs in parallel; returns {1-based index: bytes|None}."""
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
    return fetched


def _collect_prewarm_endpoints(urls: list[str], ghcr_images: list[str], target_version: str, current_repo: str | None, allowed_repos: set[str] | None, blocked_repos: dict[str, list[str]]) -> list[str]:
    """Enumerate independent Phase 2-4 endpoints in deterministic source order;
    each owner/repo endpoint is gated through ``_repo_allowed`` (#509).
    Branch-dependent calls are left for the render loop to fetch on demand."""
    prewarm_endpoints: list[str] = []
    seen: set[str] = set()
    gh_repo_keys: set[str] = set()

    def queue(endpoint: str) -> None:
        m = re.match(r"^repos/([^/]+)/([^/]+)/", endpoint)
        if m and not _repo_allowed(m.group(1), m.group(2), current_repo, allowed_repos):
            key = f"{m.group(1)}/{m.group(2)}".lower()
            blocked_repos.setdefault(key, []).append(endpoint)
            return
        if endpoint not in seen:
            seen.add(endpoint)
            prewarm_endpoints.append(endpoint)

    for url in urls[:25]:
        normalized = normalize_url(url)
        cls = classify_url(normalized)
        if cls and cls["type"] == "github_release":
            queue(f"repos/{cls['owner']}/{cls['repo']}/releases/tags/{cls['tag']}")
            queue(f"repos/{cls['owner']}/{cls['repo']}/releases?per_page=30")
        elif cls and cls["type"] == "github_compare":
            queue(f"repos/{cls['owner']}/{cls['repo']}/compare/{cls['compare_spec']}")
        repo_key = _github_repo_key(normalized)
        if repo_key:
            gh_repo_keys.add(repo_key)
            queue(f"repos/{repo_key}/releases?per_page=30")

    if target_version:
        for img_repo in ghcr_images:
            if img_repo in gh_repo_keys:
                continue
            owner = img_repo.split("/")[0]
            repo = img_repo.rsplit("/", 1)[-1]
            if not owner or not repo or owner == img_repo:
                continue
            for tag_prefix in (f"v{target_version}", target_version):
                queue(f"repos/{owner}/{repo}/releases/tags/{tag_prefix}")

    return prewarm_endpoints


def _prewarm(api: _GhApiCache, endpoints: list[str], budget: BudgetTracker) -> None:
    """Fetch the prewarm endpoints concurrently (fails soft, never raises)."""
    if not endpoints or not budget.ok():
        return
    with ThreadPoolExecutor(max_workers=min(8, len(endpoints))) as pool:
        futures = [pool.submit(api.get, e) for e in endpoints]
        for fut in as_completed(futures):
            fut.result()  # get fails soft; never raises


def _render_fetched_content(lines: list[str], normalized: str, host: str, i: int, fetched: dict[int, bytes | None], allowed_hosts: set[str]) -> bool:
    """Append the fetched-content block; return True for a pure skip notice."""
    if host_allowed(normalized, allowed_hosts):
        if host == "github.com":
            lines.append(
                "(Raw HTML fetch skipped for github.com — structured release/compare metadata is captured below when available)"
            )
        elif host in SKIP_FETCH_HOSTS:
            lines.append(f"(Raw HTML fetch skipped for known non-Forgejo host: {host})")
            return True
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
        return False
    lines.append(f"(Skipped non-allowlisted URL: {host})")
    return True


def _render_github_release_metadata(cls: dict | None, lines: list[str], api: _GhApiCache, budget: BudgetTracker) -> None:
    """Render GitHub release metadata + recent releases for a release URL."""
    if not (cls and cls["type"] == "github_release"):
        return
    lines.append("")
    lines.append(f"### GitHub Release Metadata: {cls['owner']}/{cls['repo']}@{cls['tag']}")
    if budget.ok():
        data = api.get(f"repos/{cls['owner']}/{cls['repo']}/releases/tags/{cls['tag']}")
        if isinstance(data, dict):
            filtered = _pick(data, ("tag_name", "name", "published_at", "html_url", "body"))
            lines.append("```json")
            lines.append(json.dumps(filtered, indent=2)[:5000])
            lines.append("")
            lines.append("```")
        else:
            lines.append(f"(Could not fetch release metadata for tag {cls['tag']})")
    if budget.ok():
        data = api.releases(cls["owner"], cls["repo"])
        if isinstance(data, list):
            filtered = [_pick(r, ("tag_name", "name", "published_at", "html_url")) for r in data[:8]]
            lines.append("### Recent Releases")
            lines.append("```json")
            lines.append(json.dumps(filtered, indent=2)[:3000])
            lines.append("")
            lines.append("```")


def _render_github_compare_metadata(cls: dict | None, lines: list[str], api: _GhApiCache, budget: BudgetTracker) -> None:
    """Render GitHub compare metadata + changed files for a compare URL."""
    if not (cls and cls["type"] == "github_compare"):
        return
    lines.append("")
    lines.append(f"### GitHub Compare Metadata: {cls['owner']}/{cls['repo']}@{cls['compare_spec']}")
    if budget.ok():
        data = api.get(f"repos/{cls['owner']}/{cls['repo']}/compare/{cls['compare_spec']}")
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
            file_list = [_pick(f, ("filename", "status", "additions", "deletions", "changes", "patch")) for f in files]
            lines.append("### GitHub Compare Files")
            lines.append("```json")
            lines.append(json.dumps(file_list, indent=2)[:7000])
            lines.append("")
            lines.append("```")
        else:
            lines.append(f"(Could not fetch compare metadata for {cls['owner']}/{cls['repo']}@{cls['compare_spec']})")


def _render_forgejo_metadata(cls: dict, lines: list[str], budget: BudgetTracker) -> None:
    """Render Forgejo release/compare metadata (non-github.com hosts)."""
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


def _render_source_section(i: int, url: str, allowed_hosts: set[str], fetched: dict[int, bytes | None], api: _GhApiCache, budget: BudgetTracker) -> tuple[list[str], str, bool, int, str | None]:
    """Render one ``## Source N`` section and its enrichment.

    Returns ``(section_lines, host, is_skip, enrich_start, repo_key)``;
    ``enrich_start`` marks where enrichment begins, so the caller can collapse
    a pure skip-boilerplate section (#372).
    """
    normalized = normalize_url(url)
    host = _extract_host(normalized)

    lines: list[str] = []
    lines.append(f"## Source {i}")
    lines.append(f"URL: {url}")
    if normalized != url:
        lines.append(f"Normalized URL: {normalized}")
    lines.append("")
    lines.append("### Fetched Content (truncated)")

    is_skip = _render_fetched_content(lines, normalized, host, i, fetched, allowed_hosts)
    enrich_start = len(lines)

    cls = classify_url(normalized)
    _render_github_release_metadata(cls, lines, api, budget)
    _render_github_compare_metadata(cls, lines, api, budget)
    if cls and host != "github.com" and host_allowed(normalized, allowed_hosts):
        _render_forgejo_metadata(cls, lines, budget)

    return lines, host, is_skip, enrich_start, _github_repo_key(normalized)


def _render_releases_enrichment(repo_candidates: list[str], lines: list[str], api: _GhApiCache, budget: BudgetTracker, target_version: str) -> None:
    """Phase 3: GitHub releases enrichment for candidate repos."""
    for repo_key in repo_candidates:
        if not budget.ok():
            break
        owner, repo = repo_key.split("/", 1)

        lines.append("")
        lines.append(f"### GitHub Releases Enrichment: {repo_key}")

        if budget.ok():
            data = api.releases(owner, repo)
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
                            tags = api.get(f"repos/{owner}/{repo}/tags?per_page=50")
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


def _render_ghcr_lookup(ghcr_images: list[str], seen_repos: set[str], lines: list[str], api: _GhApiCache, budget: BudgetTracker, target_version: str, compare_shas: tuple[str, str] | None) -> None:
    """Phase 4: GHCR image path lookup for images not already covered."""
    if not (ghcr_images and budget.ok()):
        return
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
                data = api.get(f"repos/{owner}/{repo}/releases/tags/{tag_prefix}")
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

        if not found_release and compare_shas and budget.ok():
            cmp_old, cmp_new = compare_shas
            data = api.get(f"repos/{owner}/{repo}/compare/{cmp_old}...{cmp_new}")
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


def _render_blocked_repos(blocked_repos: dict[str, list[str]], lines: list[str]) -> None:
    """Surface repos the #509 gate refused to query, for reviewer visibility."""
    if not blocked_repos:
        return
    lines.append("### Not Authorized for Enrichment")
    lines.append("")
    lines.append(
        "These repos were linked from the PR body but are not the repo under "
        "review (and were not listed in `TOOL_ALLOWED_GH_API_REPOS`), so the "
        "action did not query them with the operator token:"
    )
    lines.append("")
    for key in sorted(blocked_repos.keys()):
        lines.append(f"- `{key}`")
    lines.append("")
