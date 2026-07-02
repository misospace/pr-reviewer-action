#!/usr/bin/env python3
"""CLI for PR enrichment: extraction + linked-source rendering.

Replaces brittle grep/sed pipelines in context.sh and enrichment.sh with
deterministic Python. Reads artifacts from CWD, writes output files to CWD.

Inputs (CWD):
  pr.json              — PR metadata (title, body, etc.)
  pr-body.txt          — PR body text
  pr.diff.truncated    — truncated PR diff

Optional env:
  ALLOWED_SOURCE_HOSTS — comma-separated host allowlist for URL fetch
  ENRICHMENT_BUDGET_SEC — max seconds for enrichment (default: 60)
  GH_TOKEN             — GitHub token for API calls

Outputs (CWD):
  urls.all.txt                  — all extracted URLs
  urls.txt                      — limited to 25
  version-hints.txt             — changed lines with version hints
  version-hints.truncated.txt   — truncated to 180 lines
  ghcr-images.txt               — ghcr.io image/chart repos
  compare-shas.txt              — old new SHA pair (or empty)
  linked-sources.md             — rendered linked-source markdown
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

# Ensure the project root is on sys.path so pr_reviewer is importable.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from pr_reviewer.enrichment import (  # noqa: E402
    classify_url,
    extract_compare_shas,
    extract_ghcr_images,
    extract_urls,
    extract_version_hints,
    host_allowed,
    normalize_url,
    parse_allowed_hosts,
    select_target_version,
)
from pr_reviewer.forgejo_backend import (  # noqa: E402
    fetch_forge_compare,
    fetch_forge_release,
)
from pr_reviewer.platform import USER_AGENT  # noqa: E402

# Import reduce_source from strip_source_text to avoid duplicating HTML-strip logic.
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
from strip_source_text import reduce_source  # noqa: E402

SKIP_FETCH_HOSTS = {"gitlab.com", "bitbucket.org"}


# --- File I/O helpers (injectable for tests) ---

def read_file(name: str) -> str:
    p = Path(name)
    if not p.exists():
        return ""
    return p.read_text(encoding="utf-8", errors="replace")


def write_file(name: str, content: str) -> None:
    Path(name).write_text(content, encoding="utf-8")


# --- Network helpers (injectable for tests) ---

def fetch_url(url: str, timeout: int = 25) -> bytes | None:
    """Best-effort URL fetch. Returns None on any failure."""
    try:
        req = Request(url, headers={"User-Agent": USER_AGENT})
        with urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except Exception:
        return None


def gh_api_call(endpoint: str, token: str | None = None) -> dict | list | None:
    """Best-effort GitHub API call via `gh` CLI. Returns parsed JSON or None."""
    try:
        cmd = ["gh", "api", endpoint]
        env = os.environ.copy()
        if token:
            env["GH_TOKEN"] = token
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30, env=env
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)
    except Exception:
        return None


def strip_source_to_text(raw_bytes: bytes, max_bytes: int = 4000) -> str:
    """Strip HTML to visible text, or pass through plain text."""
    return reduce_source(raw_bytes, max_bytes)


# --- Enrichment budget tracking ---

class BudgetTracker:
    def __init__(self, max_seconds: int = 60):
        self.start = time.time()
        self.max_seconds = max_seconds
        self._budget_logged = False

    def ok(self) -> bool:
        if (time.time() - self.start) >= self.max_seconds and not self._budget_logged:
            self._budget_logged = True
            print("WARNING: enrichment budget exceeded", file=sys.stderr, flush=True)
        return (time.time() - self.start) < self.max_seconds


# --- Markdown rendering ---

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


# --- Main ---

def main() -> None:
    pr_body = read_file("pr-body.txt")
    diff = read_file("pr.diff.truncated")

    # Parse pr.json gracefully — malformed JSON must not lose extraction artifacts.
    title = ""
    pr_json_text = read_file("pr.json")
    if pr_json_text:
        try:
            pr_json = json.loads(pr_json_text)
            if isinstance(pr_json, dict):
                title = pr_json.get("title", "") or ""
        except (json.JSONDecodeError, ValueError):
            title = ""

    allowed_hosts = parse_allowed_hosts(os.environ.get("ALLOWED_SOURCE_HOSTS", ""))
    budget_sec = int(os.environ.get("ENRICHMENT_BUDGET_SEC", "60"))
    gh_token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")

    # Extraction phase (deterministic, always writes)
    # urls.all.txt and version-hints.txt are unbounded; only the .txt/.truncated variants are capped.
    all_urls = extract_urls(pr_body, diff, limit=None)
    write_file("urls.all.txt", "\n".join(all_urls) + ("\n" if all_urls else ""))
    write_file("urls.txt", "\n".join(all_urls[:25]) + ("\n" if all_urls else ""))

    version_hints = extract_version_hints(diff, limit=None)
    write_file("version-hints.txt", "\n".join(version_hints) + ("\n" if version_hints else ""))
    write_file("version-hints.truncated.txt", "\n".join(version_hints[:180]) + ("\n" if version_hints else ""))

    ghcr_images = extract_ghcr_images(version_hints, diff)
    write_file("ghcr-images.txt", "\n".join(ghcr_images) + ("\n" if ghcr_images else ""))

    compare_shas = extract_compare_shas(version_hints)
    if compare_shas:
        write_file("compare-shas.txt", f"{compare_shas[0]} {compare_shas[1]}\n")
    else:
        write_file("compare-shas.txt", "")

    # Enrichment phase (best-effort, network calls)
    target_version = select_target_version(title, version_hints)
    budget = BudgetTracker(budget_sec)

    md = render_linked_sources(
        all_urls,
        allowed_hosts,
        gh_token,
        target_version,
        ghcr_images,
        compare_shas,
        budget,
    )
    write_file("linked-sources.md", md)


if __name__ == "__main__":
    main()
