#!/usr/bin/env python3
"""Manual check: does a real-PR corpus entry's pinned head actually contain
its defect (#842)?

For every ``vulnerable`` entry that pins both ``head_sha`` and ``base_sha``,
this compares the two commits (``GET /repos/{repo}/compare/{base}...{head}``)
and confirms the defect's anchor file is among the changed files. If it
isn't, the pinned head was reviewed *after* the defect was already fixed (or
never contained it), the defect can't be caught there, and the entry only
adds noise to recall — the exact #842 bug (`joryirving/home-ops#9075`
pinned `b3d77613`, the commit that already added the fix).

This is a manual, network-using script — never invoked by the unit test
suite or CI. Its logic (matching a defect's anchor file against a compare
response's file list) is unit-tested in
``tests/test_check_corpus_defect_in_diff.py`` against fixture JSON, with no
network calls.

Usage:
    python3 scripts/check_corpus_defect_in_diff.py evals/corpus-human-findings.json
    python3 scripts/check_corpus_defect_in_diff.py evals/corpus-real-prs.json --verbose

Reads via the `gh` CLI when present (auth via gh's own token handling),
otherwise falls back to `urllib` with GITHUB_TOKEN/GH_TOKEN from the
environment.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
for _p in (str(ROOT), str(SCRIPT_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from eval_harness import _normalize_path_for_match  # noqa: E402


class GitHubAPIError(RuntimeError):
    """A GitHub REST read failed."""


class GitHubClient:
    """Minimal read-only GitHub REST client (gh CLI, else urllib+token)."""

    def __init__(self, token: str | None = None, use_gh_cli: bool | None = None):
        self.token = token
        self.use_gh_cli = shutil.which("gh") is not None if use_gh_cli is None else use_gh_cli

    def get(self, path: str) -> Any:
        if self.use_gh_cli:
            result = subprocess.run(
                ["gh", "api", path], capture_output=True, text=True, check=False,
            )
            if result.returncode != 0:
                raise GitHubAPIError(f"gh api {path} failed: {result.stderr.strip()}")
            return json.loads(result.stdout)

        url = f"https://api.github.com{path}"
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = Request(url, headers=headers)
        try:
            with urlopen(req, timeout=30) as resp:  # noqa: S310 - fixed https host
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise GitHubAPIError(f"GET {path} failed: {exc}") from exc

    def compare(self, repo: str, base: str, head: str) -> dict[str, Any]:
        return self.get(f"/repos/{repo}/compare/{base}...{head}")


# ---------------------------------------------------------------------------
# Pure helpers (unit-testable without any network access)
# ---------------------------------------------------------------------------


def files_from_compare(compare_response: dict[str, Any]) -> set[str]:
    """The set of normalized filenames touched between base and head.

    Includes both the current filename and, for a rename, the previous one —
    a defect anchored to the pre-rename path should still count as present.
    """
    out: set[str] = set()
    for f in compare_response.get("files") or []:
        if not isinstance(f, dict):
            continue
        filename = f.get("filename")
        if isinstance(filename, str) and filename:
            out.add(_normalize_path_for_match(filename))
        previous = f.get("previous_filename")
        if isinstance(previous, str) and previous:
            out.add(_normalize_path_for_match(previous))
    return out


def defect_file_in_changed_files(defect_file: str | None, changed_files: set[str]) -> bool | None:
    """Whether the defect's anchor file is among the changed files.

    Returns None (not applicable) when the entry has no anchor file to
    check. Matching is exact-or-suffix on a '/' boundary, matching the
    scorer's own file-match leniency (`_finding_file_matches_anchor`).
    """
    if not defect_file:
        return None
    target = _normalize_path_for_match(defect_file)
    for changed in changed_files:
        if changed == target or changed.endswith(f"/{target}") or target.endswith(f"/{changed}"):
            return True
    return False


def check_entries(
    entries: list[dict[str, Any]],
    fetch_compare: "callable[[str, str, str], dict[str, Any]]",
) -> list[dict[str, Any]]:
    """Check every entry that pins both head_sha and base_sha.

    ``fetch_compare(repo, base, head)`` is injected so this stays
    network-free under test. Returns one result dict per checked entry:
    ``{"id", "ok", "reason"}`` — ``ok`` is True when the defect file is
    confirmed changed between base and head, False when it is not (the
    #842 failure mode), and entries without both shas pinned or without a
    defect file are skipped (not returned).
    """
    results: list[dict[str, Any]] = []
    for entry in entries:
        defect = entry.get("defect") or {}
        defect_file = defect.get("file")
        base_sha = entry.get("base_sha")
        head_sha = entry.get("head_sha")
        repo = entry.get("repo_full_name")
        entry_id = entry.get("id", "?")
        if not (base_sha and head_sha and repo and defect_file):
            continue
        try:
            compare_response = fetch_compare(repo, base_sha, head_sha)
        except GitHubAPIError as exc:
            results.append({"id": entry_id, "ok": None, "reason": f"compare failed: {exc}"})
            continue
        changed = files_from_compare(compare_response)
        present = defect_file_in_changed_files(defect_file, changed)
        results.append({
            "id": entry_id,
            "ok": bool(present),
            "reason": (
                "defect file changed between base and head" if present
                else f"defect file {defect_file!r} NOT in the base..head diff"
            ),
        })
    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("corpus", type=Path, help="Path to a real-PR corpus JSON file")
    parser.add_argument("--verbose", action="store_true", help="Print every entry, not just failures")
    args = parser.parse_args(argv)

    data = json.loads(args.corpus.read_text(encoding="utf-8"))
    block = data.get("real_pr_corpus") or {}
    entries = list(block.get("vulnerable") or [])

    client = GitHubClient(token=os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN"))
    results = check_entries(entries, client.compare)

    bad = [r for r in results if r["ok"] is not True]
    for r in results:
        if args.verbose or r["ok"] is not True:
            tag = "OK" if r["ok"] is True else ("SKIP" if r["ok"] is None else "BAD")
            print(f"[{tag}] {r['id']}: {r['reason']}")

    print(f"\n{len(results)} entries checked, {len(bad)} flagged", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
