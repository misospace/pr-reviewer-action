#!/usr/bin/env python3
"""Merge an unmerged bot-branch corpus into the on-disk corpus before the
next harvest run (#801 follow-up: data loss across runs).

The harvest script (scripts/harvest_human_findings.py) reads and appends to
the corpus checked out from the base branch (main), and runs *before*
scripts/push_harvest_branch.sh. That push helper commits this run's
working-tree corpus onto a fixed bot branch. If a prior run's harvest
(entries "A") is still sitting in an unmerged bot-branch PR when the next
run harvests "B" from main (which doesn't have A yet), resetting that
branch and pushing this run's output on top would silently drop A.

Run this *before* the harvest script, still on the base-branch checkout:
it captures the bot branch's exact current remote SHA (or "absent" if it
doesn't exist yet -- a first run has none, that's fine) and unions its
``real_pr_corpus.vulnerable`` entries into the on-disk corpus by ``id``, so
the harvest script's own duplicate-id check sees them too and the final
push carries both the carried-forward entries and whatever gets newly
harvested this run. Main's entry wins when the same id exists on both
sides (e.g. the bot branch's PR already merged and the entry is now on
main too) -- no duplicate. Order is stable: main's entries first in their
existing order, then any bot-branch-only entries in their existing order.
Non-dict entries, or dict entries without a usable (non-empty string)
``id``, are dropped from both sides rather than perpetuated.

Atomicity (#801 second follow-up): the SHA captured here is written to a
step output (``bot_branch_sha``) for scripts/push_harvest_branch.sh to use
*directly* as its ``--force-with-lease`` expected value, without
re-fetching. If push_harvest_branch.sh instead re-fetched at push time, a
concurrent run's push landing between this script and that one would go
undetected -- this run's merge was computed against the OLD remote state,
so re-fetching a newer SHA there and using it as the lease's expected value
would make the lease check pass and silently clobber the concurrent run's
newer content. Threading the exact SHA this merge was based on through
means the lease instead correctly rejects the push if the branch moved.

A genuinely absent bot branch is distinguished from a failure to read it
(network/auth/transport error) via ``git ls-remote --exit-code``, whose
exit code is well-defined (0 = found, 2 = no matching ref, anything else is
a real error) -- unlike a plain ``git fetch``, whose exit code doesn't
reliably distinguish "ref doesn't exist" from "couldn't reach the remote".
A real error here fails this script (and so the workflow step), rather
than silently proceeding as "nothing to merge" and letting the next push
clobber whatever's actually on the branch.

Once the branch is known to exist (a real ``bot_sha``), any failure to
fetch it, ``git show`` its corpus file, or parse that file as JSON is
*also* a hard failure (#801 third follow-up) -- never silently "nothing
merged". Collapsing those into a soft "nothing to merge" would still write
``bot_branch_sha`` and return success, so push_harvest_branch.sh's lease
would then succeed against a real SHA whose entries were never actually
carried forward, silently dropping them exactly like the original bug this
script exists to fix. Only a genuinely absent branch (``bot_sha is None``)
is safe to treat as "nothing to merge, empty snapshot".

Atomicity of the read itself: this fetches ``bot_sha`` *by that exact
object id*, not the (moving) branch ref, and reads the corpus from that
same sha -- so a concurrent run's force-push landing between the
``ls-remote`` that captured ``bot_sha`` and the fetch that reads its
content can't substitute a newer commit's entries for the snapshot this
run already committed to exporting. Fetching by sha either recovers
exactly that commit's content (the object is still present, whether or
not any ref still points at it) or fails outright (treated as the hard
failure above) -- it can never silently return a different commit's data.

GitHub reads only (ls-remote + a fetch of one commit); never writes to
GitHub.
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


def resolve_bot_branch_sha(branch: str) -> tuple[str | None, bool]:
    """The bot branch's current remote SHA, or ``None`` if it genuinely
    doesn't exist yet.

    Returns ``(sha, ok)``. ``ok`` is ``False`` only when the existence
    check itself failed (network/auth/transport error) -- that must fail
    the caller, never be treated as "branch absent".
    """
    result = _run("git", "ls-remote", "--exit-code", "origin", f"refs/heads/{branch}")
    if result.returncode == 0:
        lines = (result.stdout or "").strip().splitlines()
        fields = lines[0].split() if lines else []
        return (fields[0] if fields else None), True
    if result.returncode == 2:
        return None, True  # no matching ref: genuinely absent
    return None, False  # transport/auth/other error


class CorpusReadError(RuntimeError):
    """A bot branch is known to exist, but its corpus couldn't be read at
    the exact sha it was known to exist at. Callers must treat this as a
    hard failure (see module docstring) -- never as "nothing to merge"."""


def fetch_bot_branch_corpus_at(branch: str, sha: str, corpus_path: str) -> dict[str, Any]:
    """The corpus JSON (parsed) at the bot branch's exact ``sha`` (already
    known, via ``resolve_bot_branch_sha``, to exist).

    Fetches ``sha`` itself -- not the branch ref, which may have moved --
    so a concurrent push landing between the ``ls-remote`` that produced
    ``sha`` and this call can't substitute a different commit's content.
    Raises ``CorpusReadError`` if the fetch fails, the file is missing at
    that commit, it isn't valid JSON, or it doesn't parse to a JSON object.
    A bot branch that exists but is missing the corpus file (or has one
    that doesn't parse) is not a safe substitute for "no entries to merge"
    -- it's unexpected, and callers must fail loud rather than merge
    nothing while still reporting success.
    """
    fetch = _run("git", "fetch", "origin", sha)
    if fetch.returncode != 0:
        raise CorpusReadError(
            f"git fetch of {branch}@{sha} failed: {fetch.stderr.strip()}"
        )
    show = _run("git", "show", f"{sha}:{corpus_path}")
    if show.returncode != 0:
        raise CorpusReadError(
            f"{corpus_path} not found on {branch}@{sha} (git show failed): "
            f"{show.stderr.strip()}"
        )
    try:
        data = json.loads(show.stdout)
    except json.JSONDecodeError as exc:
        raise CorpusReadError(
            f"{corpus_path} on {branch}@{sha} is not valid JSON: {exc}"
        ) from exc
    if not isinstance(data, dict):
        raise CorpusReadError(
            f"{corpus_path} on {branch}@{sha} did not parse to a JSON object"
        )
    return data


def _valid_entries(entries: list[Any]) -> list[dict[str, Any]]:
    """Dict entries with a usable (non-empty string) ``id``; anything else
    (non-dict, missing id, non-string id, empty string id) is dropped."""
    return [
        e
        for e in entries
        if isinstance(e, dict) and isinstance(e.get("id"), str) and e.get("id") != ""
    ]


def merge_vulnerable(
    main_entries: list[Any], bot_entries: list[Any]
) -> list[dict[str, Any]]:
    """Union of ``main_entries`` and ``bot_entries`` by ``id``.

    Main's entries come first, in their existing order (and win on a
    conflicting id); any bot-branch-only entries follow, in their existing
    order. Entries without a usable id (on either side) are dropped, not
    perpetuated -- see ``_valid_entries``.
    """
    merged = _valid_entries(main_entries)
    seen_ids = {e["id"] for e in merged}
    for entry in _valid_entries(bot_entries):
        if entry["id"] in seen_ids:
            continue
        merged.append(entry)
        seen_ids.add(entry["id"])
    return merged


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--branch", required=True, help="Bot branch name (e.g. bot/harvest-human-findings)"
    )
    parser.add_argument(
        "--corpus", required=True, type=Path, help="Path to the on-disk corpus JSON"
    )
    parser.add_argument(
        "--github-output",
        type=Path,
        default=None,
        help=(
            "Path to append 'bot_branch_sha=<sha-or-empty>' to (default: "
            "$GITHUB_OUTPUT if set, else no output is written)"
        ),
    )
    args = parser.parse_args(argv)

    github_output = args.github_output
    if github_output is None:
        env_output = os.environ.get("GITHUB_OUTPUT")
        github_output = Path(env_output) if env_output else None

    if os.environ.get("GH_TOKEN"):
        # checkout ran with persist-credentials: false; `gh auth setup-git`
        # registers `gh` as git's credential helper (reads GH_TOKEN from the
        # environment at fetch time, never argv/persisted config) so the
        # reads below can reach a private repo. Skipped when GH_TOKEN isn't
        # set (local/test runs against a plain file:// remote need no auth).
        _run("gh", "auth", "setup-git")

    bot_sha, ok = resolve_bot_branch_sha(args.branch)
    if not ok:
        print(
            f"::error::could not determine whether {args.branch} exists on "
            "the remote (git ls-remote failed) -- treating this as a hard "
            'failure, not "nothing to merge", since a transport/auth error '
            "must not silently look like an absent branch",
            file=sys.stderr,
        )
        return 1

    corpus_data = json.loads(args.corpus.read_text(encoding="utf-8"))
    block = corpus_data.setdefault("real_pr_corpus", {"vulnerable": [], "clean": []})
    main_vulnerable = block.setdefault("vulnerable", [])

    if bot_sha is None:
        print(f"merge_bot_branch_corpus: no existing {args.branch} on the remote; nothing to merge")
    else:
        try:
            bot_corpus = fetch_bot_branch_corpus_at(args.branch, bot_sha, str(args.corpus))
        except CorpusReadError as exc:
            print(
                f"::error::{args.branch} exists at {bot_sha} but its corpus "
                f"could not be read: {exc} -- treating this as a hard "
                "failure, not \"nothing to merge\", since the lease must "
                "never succeed against a sha whose entries were never "
                "actually carried forward",
                file=sys.stderr,
            )
            return 1

        bot_vulnerable = (bot_corpus.get("real_pr_corpus") or {}).get("vulnerable") or []
        merged = merge_vulnerable(main_vulnerable, bot_vulnerable)
        added = len(merged) - len(_valid_entries(main_vulnerable))
        block["vulnerable"] = merged
        args.corpus.write_text(
            json.dumps(corpus_data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        noun = "entry" if added == 1 else "entries"
        print(
            f"merge_bot_branch_corpus: carried forward {added} unmerged "
            f"{args.branch} {noun} (remote at {bot_sha})"
        )

    if github_output is not None:
        with github_output.open("a", encoding="utf-8") as fh:
            fh.write(f"bot_branch_sha={bot_sha or ''}\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
