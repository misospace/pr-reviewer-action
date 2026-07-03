#!/usr/bin/env python3
"""CLI for PR enrichment: extraction + linked-source rendering.

Replaces brittle grep/sed pipelines in context.sh and enrichment.sh with
deterministic Python. Reads artifacts from CWD, writes output files to CWD.

The core logic lives in ``pr_reviewer/``: pure extraction/classification in
``enrichment``, network transport in ``http_client``, the wall-clock
``BudgetTracker`` in ``budget``, and linked-source rendering in
``linked_sources``. This module keeps only the file-I/O wrappers and the
``main()`` orchestration (#359).

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
import sys
from pathlib import Path

# Ensure the project root is on sys.path so pr_reviewer is importable.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from pr_reviewer.budget import BudgetTracker  # noqa: E402,F401  (re-exported for tests)
from pr_reviewer.enrichment import (  # noqa: E402
    extract_compare_shas,
    extract_ghcr_images,
    extract_urls,
    extract_version_hints,
    parse_allowed_hosts,
    select_target_version,
)
# fetch_url / gh_api_call are re-exported here so existing tests can reach
# them as run_enrichment.<name>; render_linked_sources looks them up in the
# pr_reviewer.linked_sources namespace.
from pr_reviewer.http_client import fetch_url, gh_api_call  # noqa: E402,F401
from pr_reviewer.linked_sources import render_linked_sources  # noqa: E402


# --- File I/O helpers (injectable for tests) ---

def read_file(name: str) -> str:
    p = Path(name)
    if not p.exists():
        return ""
    return p.read_text(encoding="utf-8", errors="replace")


def write_file(name: str, content: str) -> None:
    Path(name).write_text(content, encoding="utf-8")


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
