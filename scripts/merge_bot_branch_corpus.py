#!/usr/bin/env python3
"""Merge an unmerged bot-branch corpus into the on-disk corpus before the
next harvest run (#801 follow-up: data loss across runs).

The harvest script (scripts/harvest_human_findings.py) reads and appends to
the corpus checked out from the base branch (main), and runs *before*
scripts/push_harvest_branch.sh. That push helper fetches the bot branch
only to compute a force-with-lease SHA, then `git checkout -B` resets the
branch to main's tip while keeping the new working-tree corpus. If a prior
run's harvest (entries "A") is still sitting in an unmerged bot-branch PR
when the next run harvests "B" from main (which doesn't have A yet), the
branch reset + force-push leaves main+B and silently drops A.

Run this *before* the harvest script, still on the base-branch checkout:
it fetches the bot branch (a first run has none -- that's fine, nothing to
merge) and unions its ``real_pr_corpus.vulnerable`` entries into the
on-disk corpus by ``id``, so the harvest script's own duplicate-id check
sees them too and the final push carries both the carried-forward entries
and whatever gets newly harvested this run. Main's entry wins when the
same id exists on both sides (e.g. the bot branch's PR already merged and
the entry is now on main too) -- no duplicate. Order is stable: main's
entries first in their existing order, then any bot-branch-only entries in
their existing order.

GitHub reads only (a git fetch of one ref); never writes to GitHub.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


def _run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, check=False)


def fetch_bot_branch_corpus(branch: str, corpus_path: str) -> dict[str, Any] | None:
    """The bot branch's corpus JSON (parsed), or ``None`` when the branch
    doesn't exist on the remote yet, or doesn't carry the corpus file."""
    remote_ref = f"refs/remotes/origin/{branch}"
    fetch = _run("git", "fetch", "origin", f"refs/heads/{branch}:{remote_ref}")
    if fetch.returncode != 0:
        return None  # branch doesn't exist remotely yet (first run)
    show = _run("git", "show", f"{remote_ref}:{corpus_path}")
    if show.returncode != 0:
        return None
    try:
        data = json.loads(show.stdout)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def merge_vulnerable(
    main_entries: list[Any], bot_entries: list[Any]
) -> list[dict[str, Any]]:
    """Union of ``main_entries`` and ``bot_entries`` by ``id``.

    Main's entries come first, in their existing order (and win on a
    conflicting id); any bot-branch-only entries follow, in their existing
    order. Non-dict / id-less entries in either list are dropped (matches
    ``build_entries``/``existing_ids`` treating malformed entries as absent).
    """
    merged = [e for e in main_entries if isinstance(e, dict)]
    seen_ids = {e.get("id") for e in merged}
    for entry in bot_entries:
        if not isinstance(entry, dict):
            continue
        entry_id = entry.get("id")
        if entry_id in seen_ids:
            continue
        merged.append(entry)
        seen_ids.add(entry_id)
    return merged


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--branch", required=True, help="Bot branch name (e.g. bot/harvest-human-findings)"
    )
    parser.add_argument(
        "--corpus", required=True, type=Path, help="Path to the on-disk corpus JSON"
    )
    args = parser.parse_args(argv)

    if os.environ.get("GH_TOKEN"):
        # checkout ran with persist-credentials: false; `gh auth setup-git`
        # registers `gh` as git's credential helper (reads GH_TOKEN from the
        # environment at fetch time, never argv/persisted config) so the
        # fetch below can reach a private repo. Skipped when GH_TOKEN isn't
        # set (local/test runs against a plain file:// remote need no auth).
        _run("gh", "auth", "setup-git")

    corpus_data = json.loads(args.corpus.read_text(encoding="utf-8"))
    block = corpus_data.setdefault("real_pr_corpus", {"vulnerable": [], "clean": []})
    main_vulnerable = block.setdefault("vulnerable", [])

    bot_corpus = fetch_bot_branch_corpus(args.branch, str(args.corpus))
    if bot_corpus is None:
        print(f"merge_bot_branch_corpus: no existing {args.branch} corpus to merge")
        return 0

    bot_vulnerable = (bot_corpus.get("real_pr_corpus") or {}).get("vulnerable") or []
    merged = merge_vulnerable(main_vulnerable, bot_vulnerable)
    added = len(merged) - len([e for e in main_vulnerable if isinstance(e, dict)])
    block["vulnerable"] = merged

    args.corpus.write_text(
        json.dumps(corpus_data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    noun = "entry" if added == 1 else "entries"
    print(f"merge_bot_branch_corpus: carried forward {added} unmerged {args.branch} {noun}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
