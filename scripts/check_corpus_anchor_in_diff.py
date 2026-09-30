#!/usr/bin/env python3
"""Manual check: is a real-PR corpus entry's defect anchor file untouched
between its pinned base and head?

For every ``vulnerable`` entry that pins both ``head_sha`` and ``base_sha``,
this compares the two commits (``GET /repos/{repo}/compare/{base}...{head}``)
and confirms the defect's anchor file is among the changed files. When it
isn't, the anchor file was never modified in that base..head range at all —
a corpus-authoring mistake (wrong file, wrong shas, or a base/head pair from
the wrong PR).

Important limitation: this check is NOT sufficient to catch a #842-style
stale pin (a head that already contains the fix a human asked for). The
anchor file can perfectly well be "changed between base and head" in BOTH
the buggy pre-fix commit and a later commit that already fixed it — the
file shows up in the compare diff either way, because the compare range
spans every commit in between, defect-introducing and defect-fixing alike.
A timestamp-based heuristic (pinned head vs. the commit live when the
human finding was posted) was tried and abandoned: it inverts whenever the
finding's own timestamp postdates the fix commit (e.g. a PR author's
post-hoc comment narrating a fix they'd already pushed), which is exactly
the #9075 case — see issue #861 for the writeup. Catching a #842-style
stale pin currently needs per-entry diff inspection (does the described
defect state actually exist at the pinned head?), not an automated check.
Treat this script as a narrower, complementary sanity check: "does the
diff even touch the right file", not "is the defect still present at
head".

This is a manual, network-using script — never invoked by the unit test
suite or CI. Its logic (matching a defect's anchor file against a compare
response's file list) is unit-tested in
``tests/test_check_corpus_anchor_in_diff.py`` against fixture JSON, with no
network calls.

Usage:
    python3 scripts/check_corpus_anchor_in_diff.py evals/corpus-human-findings.json
    python3 scripts/check_corpus_anchor_in_diff.py evals/corpus-real-prs.json --verbose

Reads exclusively via the `gh` CLI (auth flows through gh's own token
handling; this deliberately has no direct-HTTP fallback — a hand-rolled
`Authorization: Bearer` header over `urllib.request.urlopen` follows
redirects by default and would forward the token cross-origin on a 3xx).
Requires `gh` on PATH and authenticated.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
for _p in (str(ROOT), str(SCRIPT_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from eval_harness import _normalize_path_for_match  # noqa: E402


class GitHubAPIError(RuntimeError):
    """A GitHub REST read failed."""


class GitHubClient:
    """Read-only GitHub REST client, `gh` CLI only.

    No direct-HTTP fallback on purpose (#855-class risk): a hand-rolled
    `Authorization: Bearer <token>` header over `urlopen` follows redirects
    by default, which can forward the token cross-origin on a 3xx response.
    The `gh` CLI handles auth and redirects safely on its own.
    """

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
    scorer's own file-match leniency (`_finding_file_matches_anchor`), plus
    a directory-prefix match: an anchor with no '.' in its final segment
    (e.g. a defect that spans every file under a directory, like a
    virtualkeys/ folder) also matches any changed file nested under it.
    """
    if not defect_file:
        return None
    target = _normalize_path_for_match(defect_file)
    is_dir_anchor = "." not in target.rsplit("/", 1)[-1]
    for changed in changed_files:
        if changed == target or changed.endswith(f"/{target}") or target.endswith(f"/{changed}"):
            return True
        if is_dir_anchor and (changed.startswith(f"{target}/") or f"/{target}/" in changed):
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
    confirmed changed somewhere between base and head, False when it is
    not touched at all in that range, and entries without both shas pinned
    or without a defect file are skipped (not returned). A `False` here
    means the anchor is wrong or the base/head pair doesn't bracket the
    defect commit — it does NOT by itself mean "the defect is still live
    at head" (see the module docstring and issue #861: that needs
    per-entry diff inspection, not an automated check).

    An entry with ``defect_outside_diff: true`` is also skipped (not
    returned): per #861, that flag records a defect confirmed present at
    the pinned head by direct inspection, but living in a file the PR's
    own diff doesn't touch (e.g. a caller the change broke) — this check's
    anchor-in-diff predicate does not apply to it by design.
    """
    results: list[dict[str, Any]] = []
    for entry in entries:
        if entry.get("defect_outside_diff"):
            continue
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
                "defect file changed somewhere between base and head" if present
                else f"defect file {defect_file!r} NOT touched anywhere in the base..head diff"
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

    client = GitHubClient()
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
