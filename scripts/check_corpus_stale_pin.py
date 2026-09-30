#!/usr/bin/env python3
"""Manual check: does a real-PR corpus entry pin the head the human actually
reviewed, or a later one that already contains the fix (#842)?

`check_corpus_anchor_in_diff.py` can't catch this: the defect's anchor file
is "changed between base and head" in both the buggy pre-fix commit and a
later commit that already fixed it, since a compare range spans every
commit in between. This script instead anchors on TIME: it fetches the
human finding's own timestamp from `source.url` (a PR issue comment, a
review-thread comment, or a top-level review), lists the PR's commits, and
computes which commit was actually the PR's head at or before that moment.
A pinned `head_sha` that isn't that commit is stale — the human's finding
was made against an earlier head, and the pinned one already carries a
later fix.

This is exactly the #842 shape: `joryirving/home-ops#9075` pinned
`b3d77613f68eff88127d014a5c5aa59a4dd38a84` (the commit that added
`mmproj-F16.gguf` to `files:`), but the review comment
(issuecomment-5295268901, 2026-08-14T15:43:42Z) was posted ~34s after that
commit landed (15:43:08Z) — the actual reviewed head was the prior commit,
`935d0f80ae4f151c0cfbb87c85712b064f2547ad` (15:40:41Z).

Caveats (read before trusting a flag):
  - Commit dates are the commit's own `committer.date`, not a push
    timestamp — a rebase or amend can rewrite it away from when the commit
    was actually pushed. This is a heuristic, not a proof.
  - A force-push can remove the commit a human actually reviewed from the
    PR's current commit list entirely. When the pinned `head_sha` isn't
    found in `GET .../pulls/{n}/commits` at all, this is reported as its
    own flag ("not in commit list") rather than folded into "stale" —
    the two need different fixes (re-pin vs. recover a dangling commit).
  - Comment timestamps and commit timestamps both come from GitHub's
    clocks, but a commit's committer date can itself be arbitrarily wrong
    (a local clock, a cherry-pick) — treat a near-simultaneous ordering
    (seconds apart, as in the #9075 case) as suggestive, not certain,
    without also reading the comment body.

This is a manual, network-using script — never invoked by the unit test
suite or CI. Its logic (parsing `source.url`, and picking the commit at or
before a timestamp) is unit-tested in
``tests/test_check_corpus_stale_pin.py`` against fixture data built from the
real #9075 history, with no network calls.

Usage:
    python3 scripts/check_corpus_stale_pin.py evals/corpus-human-findings.json
    python3 scripts/check_corpus_stale_pin.py evals/corpus-real-prs.json --verbose

Reads exclusively via the `gh` CLI (see check_corpus_anchor_in_diff.py's
docstring for why this has no direct-HTTP fallback).
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
for _p in (str(ROOT), str(SCRIPT_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, str(_p))


class GitHubAPIError(RuntimeError):
    """A GitHub REST read failed."""


class GitHubClient:
    """Read-only GitHub REST client, `gh` CLI only (see module docstring)."""

    def __init__(self):
        if shutil.which("gh") is None:
            raise GitHubAPIError("the `gh` CLI is required and was not found on PATH")

    def get(self, path: str) -> Any:
        result = subprocess.run(
            ["gh", "api", path], capture_output=True, text=True, check=False,
        )
        if result.returncode != 0:
            raise GitHubAPIError(f"gh api {path} failed: {result.stderr.strip()}")
        return json.loads(result.stdout)

    def get_pages(self, path: str) -> list[Any]:
        """Every item across a list endpoint's pages, via `gh api --paginate --slurp`."""
        result = subprocess.run(
            ["gh", "api", "--paginate", "--slurp", path],
            capture_output=True, text=True, check=False,
        )
        if result.returncode != 0:
            raise GitHubAPIError(f"gh api --paginate {path} failed: {result.stderr.strip()}")
        pages = json.loads(result.stdout)
        # --slurp wraps each page's own array in an outer array; flatten.
        out: list[Any] = []
        for page in pages:
            if isinstance(page, list):
                out.extend(page)
        return out

    def comment_created_at(self, repo: str, kind: str, comment_id: str, pr_number: int) -> str:
        if kind == "issuecomment":
            data = self.get(f"/repos/{repo}/issues/comments/{comment_id}")
            return data["created_at"]
        if kind == "discussion_r":
            data = self.get(f"/repos/{repo}/pulls/comments/{comment_id}")
            return data["created_at"]
        if kind == "pullrequestreview":
            data = self.get(f"/repos/{repo}/pulls/{pr_number}/reviews/{comment_id}")
            return data["submitted_at"]
        raise ValueError(f"unknown source.url kind: {kind}")

    def commits(self, repo: str, pr_number: int) -> list[dict[str, str]]:
        raw = self.get_pages(f"/repos/{repo}/pulls/{pr_number}/commits")
        out = []
        for c in raw:
            if not isinstance(c, dict):
                continue
            sha = c.get("sha")
            commit = c.get("commit") or {}
            date = (commit.get("committer") or {}).get("date") or (commit.get("author") or {}).get("date")
            if sha and date:
                out.append({"sha": sha, "date": date})
        return out


# ---------------------------------------------------------------------------
# Pure helpers (unit-testable without any network access)
# ---------------------------------------------------------------------------

# A source.url that points at one specific comment/review on a PR:
#   .../pull/{n}#issuecomment-{id}        (a plain PR/issue comment)
#   .../pull/{n}#discussion_r{id}         (an inline review-thread comment)
#   .../pull/{n}#pullrequestreview-{id}   (a top-level review submission)
_SOURCE_URL_RE = re.compile(
    r"github\.com/(?P<repo>[^/]+/[^/]+)/pull/(?P<number>\d+)#"
    r"(?:issuecomment-(?P<issuecomment_id>\d+)"
    r"|discussion_r(?P<discussion_id>\d+)"
    r"|pullrequestreview-(?P<review_id>\d+))"
)


def parse_source_url(url: str) -> dict[str, Any] | None:
    """Parse a corpus entry's `source.url` into repo/number/kind/comment_id.

    Returns None when the URL isn't one of the three recognized comment
    shapes (e.g. a bare PR link with no fragment) — such an entry has no
    timestamp to anchor on and is skipped, not flagged.
    """
    if not isinstance(url, str):
        return None
    m = _SOURCE_URL_RE.search(url)
    if not m:
        return None
    if m.group("issuecomment_id"):
        return {"repo": m.group("repo"), "number": int(m.group("number")),
                "kind": "issuecomment", "comment_id": m.group("issuecomment_id")}
    if m.group("discussion_id"):
        return {"repo": m.group("repo"), "number": int(m.group("number")),
                "kind": "discussion_r", "comment_id": m.group("discussion_id")}
    return {"repo": m.group("repo"), "number": int(m.group("number")),
            "kind": "pullrequestreview", "comment_id": m.group("review_id")}


def expected_head_at_time(commits: list[dict[str, str]], comment_time: str) -> str | None:
    """The sha of the latest commit at or before `comment_time`.

    Commit and comment timestamps are both ISO-8601 UTC ("...Z"), so
    lexicographic string comparison is a correct chronological ordering.
    Returns None when every commit postdates the comment (clock skew, or a
    comment somehow made before the PR's first commit).
    """
    candidates = [c for c in commits if c["date"] <= comment_time]
    if not candidates:
        return None
    return max(candidates, key=lambda c: c["date"])["sha"]


def check_stale_pin(
    entry: dict[str, Any],
    fetch_comment_time: "callable[[str, str, str, int], str]",
    fetch_commits: "callable[[str, int], list[dict[str, str]]]",
) -> dict[str, Any] | None:
    """Check one corpus entry. Returns None (skip) when `source.url` isn't
    a parseable single-comment link or `head_sha` is missing.

    Returns ``{"id", "ok", "reason", "expected_sha"}``:
      - ``ok`` True: the pinned head IS the commit that was live at the
        comment's timestamp.
      - ``ok`` False: it's a different commit that WAS in the PR's commit
        list — a stale pin (the #842 shape).
      - ``ok`` None: the pinned head isn't in the PR's current commit list
        at all (likely force-pushed away) or the comment predates every
        commit (clock skew) — ambiguous, needs a human look, not an
        automatic fix.
    """
    head_sha = entry.get("head_sha")
    entry_id = entry.get("id", "?")
    source = entry.get("source") or {}
    parsed = parse_source_url(source.get("url", ""))
    if not head_sha or parsed is None:
        return None

    comment_time = fetch_comment_time(parsed["repo"], parsed["kind"], parsed["comment_id"], parsed["number"])
    commits = fetch_commits(parsed["repo"], parsed["number"])
    in_list = any(c["sha"] == head_sha for c in commits)
    expected = expected_head_at_time(commits, comment_time)

    if not in_list:
        return {
            "id": entry_id, "ok": None, "expected_sha": expected,
            "reason": (
                f"pinned head {head_sha[:12]} not found in the PR's current commit "
                f"list (force-pushed away?); commit at/before the review comment "
                f"would be {expected[:12] if expected else '(none found)'}"
            ),
        }
    if expected is None:
        return {
            "id": entry_id, "ok": None, "expected_sha": None,
            "reason": "no commit found at/before the review comment's timestamp (clock skew?)",
        }
    if expected == head_sha:
        return {"id": entry_id, "ok": True, "expected_sha": expected, "reason": "pinned head matches the reviewed head"}
    dates = {c["sha"]: c["date"] for c in commits}
    direction = (
        "is a LATER commit than" if dates.get(head_sha, "") > dates.get(expected, "")
        else "is an EARLIER commit than"
    )
    return {
        "id": entry_id, "ok": False, "expected_sha": expected,
        "reason": (
            f"pinned head {head_sha[:12]} {direction} the commit actually live at the "
            f"review comment's timestamp ({expected[:12]})"
        ),
    }


def check_entries(
    entries: list[dict[str, Any]],
    fetch_comment_time: "callable[[str, str, str, int], str]",
    fetch_commits: "callable[[str, int], list[dict[str, str]]]",
) -> list[dict[str, Any]]:
    results = []
    for entry in entries:
        try:
            result = check_stale_pin(entry, fetch_comment_time, fetch_commits)
        except GitHubAPIError as exc:
            results.append({"id": entry.get("id", "?"), "ok": None, "expected_sha": None, "reason": f"lookup failed: {exc}"})
            continue
        if result is not None:
            results.append(result)
    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("corpus", type=Path, help="Path to a real-PR corpus JSON file")
    parser.add_argument("--verbose", action="store_true", help="Print every entry, not just flags")
    args = parser.parse_args(argv)

    data = json.loads(args.corpus.read_text(encoding="utf-8"))
    block = data.get("real_pr_corpus") or {}
    entries = list(block.get("vulnerable") or []) + list(block.get("clean") or [])

    client = GitHubClient()
    results = check_entries(entries, client.comment_created_at, client.commits)

    bad = [r for r in results if r["ok"] is not True]
    for r in results:
        if args.verbose or r["ok"] is not True:
            tag = "OK" if r["ok"] is True else ("AMBIGUOUS" if r["ok"] is None else "STALE")
            print(f"[{tag}] {r['id']}: {r['reason']}")

    print(f"\n{len(results)} entries checked, {len(bad)} flagged", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
