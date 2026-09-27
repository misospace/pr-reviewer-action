#!/usr/bin/env python3
"""Harvest maintainer-flagged findings into the human-findings eval corpus (#798).

Maintainers sometimes copy a PR into a frontier chat model and paste its
findings back onto the PR as a change request, after the production reviewer
has already approved that exact head. Each such miss is the direct yardstick
tracked in ``evals/corpus-human-findings.json`` (see ``docs/evals.md``,
"Human-findings corpus"). This script mines that pattern automatically:

  - a maintainer review with state ``CHANGES_REQUESTED`` (the review's own
    ``commit_id`` is the head), or a maintainer review left in any other
    state whose body reads as blocking (maintainers commonly leave a plain
    ``COMMENTED`` review with "Merge blocker: ..." rather than formally
    requesting changes), or
  - a maintainer PR issue comment that reads as blocking ("merge blocker",
    "blocker", "before merge", "request changes" — case-insensitive; its head
    is the latest PR commit before the comment's timestamp),

kept only when the reviewer bot's own review *at that exact head* was an
approval. The bot dismisses its own older reviews as newer heads land, which
flips ``state`` to ``DISMISSED`` after the fact — so the approval decision is
read from the bot's ``ai-pr-reviewer:{...}`` metadata marker
(``pr_reviewer/metadata.py``) when present (``review_result: "clean"``), and
only falls back to the raw ``state`` when no marker parses.

GitHub reads only (``gh api`` when available, otherwise ``urllib`` with a
token from the environment — never argv). This script never writes to
GitHub: it only ever rewrites the local corpus JSON file.

Everything is agnostic: repos, maintainer logins and bot logins are inputs
(argparse or environment), never hardcoded.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
for _p in (str(ROOT), str(SCRIPT_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from eval_harness import RealPRCorpus  # noqa: E402
from pr_reviewer.metadata import parse_metadata  # noqa: E402

_FULL_SHA_RE = re.compile(r"[0-9a-f]{40}")

_BLOCKING_PHRASES = ("merge blocker", "blocker", "before merge", "request changes")

_BLOCKER_RE = re.compile(r"\bblocker\b|\bcritical\b", re.IGNORECASE)
_MAJOR_RE = re.compile(r"\bmajor\b", re.IGNORECASE)


# ---------------------------------------------------------------------------
# GitHub read access
# ---------------------------------------------------------------------------


class GitHubAPIError(RuntimeError):
    """A GitHub REST read failed."""


class GitHubClient:
    """Read-only GitHub REST client.

    Uses the ``gh`` CLI when it's on PATH (so auth flows through gh's own
    token handling), otherwise falls back to ``urllib`` with a token read
    from the environment. The token is never passed via argv either way, and
    no method here performs a write.
    """

    def __init__(self, token: str | None = None, use_gh_cli: bool | None = None):
        self.token = token
        self.use_gh_cli = shutil.which("gh") is not None if use_gh_cli is None else use_gh_cli

    def _request(self, path_with_query: str) -> Any:
        if self.use_gh_cli:
            result = subprocess.run(
                ["gh", "api", path_with_query],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode != 0:
                raise GitHubAPIError(
                    f"gh api {path_with_query} failed: {result.stderr.strip()}"
                )
            return json.loads(result.stdout)

        url = f"https://api.github.com{path_with_query}"
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
            raise GitHubAPIError(f"GET {path_with_query} failed: {exc}") from exc

    def get_pages(self, path: str, params: dict[str, str] | None = None) -> Iterator[Any]:
        """Yield every item across all pages of a GitHub list endpoint."""
        params = dict(params or {})
        params.setdefault("per_page", "100")
        page = 1
        while True:
            params["page"] = str(page)
            full_path = f"{path}?{urlencode(params)}"
            data = self._request(full_path)
            if not isinstance(data, list) or not data:
                return
            yield from data
            if len(data) < int(params["per_page"]):
                return
            page += 1

    def list_pulls(self, repo: str, since: str | None = None) -> list[dict[str, Any]]:
        """PRs in ``repo``, newest-updated first, stopping once older than ``since``."""
        results: list[dict[str, Any]] = []
        since_floor = f"{since}T00:00:00Z" if since else None
        for pr in self.get_pages(
            f"/repos/{repo}/pulls",
            {"state": "all", "sort": "updated", "direction": "desc"},
        ):
            updated_at = pr.get("updated_at") or ""
            if since_floor and updated_at < since_floor:
                break
            results.append(pr)
        results.sort(key=lambda p: p.get("number", 0))
        return results

    def list_reviews(self, repo: str, number: int) -> list[dict[str, Any]]:
        return list(self.get_pages(f"/repos/{repo}/pulls/{number}/reviews"))

    def list_issue_comments(self, repo: str, number: int) -> list[dict[str, Any]]:
        return list(self.get_pages(f"/repos/{repo}/issues/{number}/comments"))

    def list_review_comments(self, repo: str, number: int) -> list[dict[str, Any]]:
        return list(self.get_pages(f"/repos/{repo}/pulls/{number}/comments"))

    def list_commits(self, repo: str, number: int) -> list[dict[str, Any]]:
        return list(self.get_pages(f"/repos/{repo}/pulls/{number}/commits"))

    def list_files(self, repo: str, number: int) -> list[dict[str, Any]]:
        return list(self.get_pages(f"/repos/{repo}/pulls/{number}/files"))


def _resolve_token() -> str | None:
    return os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")


# ---------------------------------------------------------------------------
# Pure helpers (unit-testable without any network access)
# ---------------------------------------------------------------------------


def is_blocking_comment(body: str) -> bool:
    """True when a comment body reads as a maintainer merge-blocking finding."""
    if not body:
        return False
    lowered = body.lower()
    return any(phrase in lowered for phrase in _BLOCKING_PHRASES)


def parse_severity(text: str) -> str:
    """Best-effort severity from finding text; defaults to 'major'."""
    if _BLOCKER_RE.search(text or ""):
        return "blocker"
    if _MAJOR_RE.search(text or ""):
        return "major"
    return "major"


def resolve_head_for_comment(commits: list[dict[str, Any]], comment_created_at: str | None) -> str | None:
    """The latest PR commit sha at or before ``comment_created_at``."""
    if not comment_created_at:
        return None
    dated: list[tuple[str, str]] = []
    for c in commits:
        commit = c.get("commit") or {}
        date = (commit.get("committer") or {}).get("date") or (commit.get("author") or {}).get("date")
        sha = c.get("sha")
        if date and sha:
            dated.append((date, sha))
    if not dated:
        return None
    dated.sort(key=lambda pair: pair[0])
    chosen: str | None = None
    for date, sha in dated:
        if date <= comment_created_at:
            chosen = sha
        else:
            break
    return chosen if chosen is not None else dated[0][1]


def determine_bot_approval(
    reviews: list[dict[str, Any]], bots: set[str], head_sha: str
) -> tuple[bool, str | None]:
    """Whether the reviewer bot's review at ``head_sha`` was an approval.

    Prefers the bot's ``ai-pr-reviewer:{...}`` metadata marker
    (``review_result == "clean"``) over the review's raw ``state``, since a
    later dismissal (the bot superseding its own stale review) flips
    ``state`` to ``DISMISSED`` without changing what the marker recorded at
    the time. Returns ``(approved, base_sha)`` — ``base_sha`` is the marker's
    ``base_sha`` field when it is a full 40-hex commit sha, else ``None``.
    """
    bots_lower = {b.lower() for b in bots}
    candidates = [
        r
        for r in reviews
        if (r.get("user") or {}).get("login", "").lower() in bots_lower
        and r.get("commit_id") == head_sha
    ]
    if not candidates:
        return False, None
    candidates.sort(key=lambda r: r.get("submitted_at") or "")
    chosen = candidates[-1]
    body = chosen.get("body") or ""
    marker = parse_metadata(body)
    base_sha = None
    if isinstance(marker, dict):
        raw_base = marker.get("base_sha")
        if isinstance(raw_base, str) and _FULL_SHA_RE.fullmatch(raw_base):
            base_sha = raw_base
        result = str(marker.get("review_result", "")).lower()
        return result == "clean", base_sha
    return chosen.get("state") == "APPROVED", base_sha


def resolve_anchor(
    text: str,
    review_id: int | None,
    review_comments: list[dict[str, Any]],
    changed_files: list[str],
) -> tuple[str, tuple[int, int] | None, str] | None:
    """Resolve ``(file, line_range, anchor_confidence)`` for one finding.

    Prefers an inline review comment attached to the same review (``path`` /
    ``line`` / ``start_line``, confidence "high"); falls back to the first
    changed-file path named in the finding text, by leftmost position in the
    text (confidence "medium"). Returns None when neither resolves.
    """
    if review_id is not None:
        attached = [
            c
            for c in review_comments
            if c.get("pull_request_review_id") == review_id and c.get("path")
        ]
        attached.sort(key=lambda c: c.get("id") or 0)
        for c in attached:
            line = c.get("line")
            if line is None:
                line = c.get("original_line")
            if line is None:
                continue
            start = c.get("start_line")
            if start is None:
                start = c.get("original_start_line")
            lo, hi = (start, line) if start is not None else (line, line)
            if lo > hi:
                lo, hi = hi, lo
            return c["path"], (lo, hi), "high"

    best_file: str | None = None
    best_pos: int | None = None
    for f in changed_files:
        if not f:
            continue
        idx = text.find(f)
        if idx == -1:
            continue
        if best_pos is None or idx < best_pos:
            best_pos = idx
            best_file = f
    if best_file is not None:
        return best_file, None, "medium"
    return None


def make_entry_id(repo: str, number: int, head_sha: str, seq: int) -> str:
    base = f"{repo}#{number}@{head_sha[:8]}"
    return base if seq <= 1 else f"{base}-{seq}"


# ---------------------------------------------------------------------------
# Harvest pipeline
# ---------------------------------------------------------------------------


def harvest_repo(
    client: Any,
    repo: str,
    maintainers: set[str],
    bots: set[str],
    since: str | None = None,
) -> list[dict[str, Any]]:
    """Raw findings (unresolved defect anchor) for one repo.

    ``client`` needs only the six read methods ``GitHubClient`` exposes
    (list_pulls/list_reviews/list_issue_comments/list_review_comments/
    list_commits/list_files) — tests pass a fake with canned data instead of
    hitting the network.
    """
    maintainers_lower = {m.lower() for m in maintainers}
    findings: list[dict[str, Any]] = []

    for pr in client.list_pulls(repo, since=since):
        number = pr.get("number")
        if not isinstance(number, int):
            continue

        reviews = client.list_reviews(repo, number)
        issue_comments = client.list_issue_comments(repo, number)
        review_comments = client.list_review_comments(repo, number)
        commits = client.list_commits(repo, number)
        files = client.list_files(repo, number)
        changed_files = [f["filename"] for f in files if isinstance(f, dict) and f.get("filename")]

        candidates: list[dict[str, Any]] = []

        for rv in reviews:
            login = (rv.get("user") or {}).get("login", "")
            if login.lower() not in maintainers_lower:
                continue
            head_sha = rv.get("commit_id")
            if not head_sha:
                continue
            body = (rv.get("body") or "").strip()
            review_id = rv.get("id")
            if not body:
                attached = [
                    c
                    for c in review_comments
                    if c.get("pull_request_review_id") == review_id
                ]
                body = "\n".join(
                    (c.get("body") or "").strip() for c in attached if c.get("body")
                ).strip()
            if not body:
                continue
            # A formal CHANGES_REQUESTED review is always kept. Any other
            # review state (in practice, maintainers often leave a
            # COMMENTED review whose body reads as a blocking finding
            # rather than formally requesting changes) is kept only when
            # its body matches the same blocking-language heuristic used
            # for issue comments.
            if rv.get("state") != "CHANGES_REQUESTED" and not is_blocking_comment(body):
                continue
            candidates.append(
                {
                    "created_at": rv.get("submitted_at") or "",
                    "kind": "review",
                    "source_id": review_id or 0,
                    "text": body,
                    "head_sha": head_sha,
                    "review_id": review_id,
                    "url": f"https://github.com/{repo}/pull/{number}#pullrequestreview-{review_id}",
                }
            )

        for c in issue_comments:
            login = (c.get("user") or {}).get("login", "")
            if login.lower() not in maintainers_lower:
                continue
            body = c.get("body") or ""
            if not is_blocking_comment(body):
                continue
            created_at = c.get("created_at")
            head_sha = resolve_head_for_comment(commits, created_at)
            if not head_sha:
                continue
            comment_id = c.get("id")
            candidates.append(
                {
                    "created_at": created_at or "",
                    "kind": "comment",
                    "source_id": comment_id or 0,
                    "text": body.strip(),
                    "head_sha": head_sha,
                    "review_id": None,
                    "url": f"https://github.com/{repo}/pull/{number}#issuecomment-{comment_id}",
                }
            )

        candidates.sort(key=lambda c: (c["created_at"], c["kind"], c["source_id"]))

        for cand in candidates:
            approved, base_sha = determine_bot_approval(reviews, bots, cand["head_sha"])
            if not approved:
                continue
            anchor = resolve_anchor(cand["text"], cand["review_id"], review_comments, changed_files)
            finding = {
                "repo": repo,
                "number": number,
                "head_sha": cand["head_sha"],
                "base_sha": base_sha,
                "text": cand["text"],
                "url": cand["url"],
                "file": None,
                "line_range": None,
                "confidence": None,
            }
            if anchor is not None:
                finding["file"], finding["line_range"], finding["confidence"] = anchor
            findings.append(finding)

    return findings


def build_entries(
    findings: list[dict[str, Any]], existing_ids: set[str]
) -> tuple[list[dict[str, Any]], int, int]:
    """Turn raw findings into corpus entries.

    Skips findings with no resolvable ``defect.file`` and entries whose
    (deterministically computed) id is already present in the corpus.
    Returns ``(new_entries, skipped_no_file, skipped_existing)``.
    """
    new_entries: list[dict[str, Any]] = []
    skipped_no_file = 0
    skipped_existing = 0
    seq_by_key: dict[tuple[str, int, str], int] = {}

    for f in findings:
        if not f.get("file"):
            skipped_no_file += 1
            continue

        key = (f["repo"], f["number"], f["head_sha"][:8])
        seq = seq_by_key.get(key, 0) + 1
        seq_by_key[key] = seq
        entry_id = make_entry_id(f["repo"], f["number"], f["head_sha"], seq)

        if entry_id in existing_ids:
            skipped_existing += 1
            continue

        defect: dict[str, Any] = {
            "description": f["text"],
            "file": f["file"],
            "severity": parse_severity(f["text"]),
        }
        if f.get("line_range"):
            defect["line_range"] = list(f["line_range"])

        entry: dict[str, Any] = {
            "id": entry_id,
            "repo_full_name": f["repo"],
            "number": f["number"],
            "head_sha": f["head_sha"],
        }
        if f.get("base_sha"):
            entry["base_sha"] = f["base_sha"]
        entry["defect"] = defect
        entry["source"] = {
            "url": f["url"],
            "production_bot_at_head": "APPROVED",
            "production_bot_flagged_same": False,
            "anchor_confidence": f["confidence"],
        }

        new_entries.append(entry)
        existing_ids.add(entry_id)

    return new_entries, skipped_no_file, skipped_existing


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Harvest maintainer CHANGES_REQUESTED reviews / blocking PR "
            "comments at a head the reviewer bot approved into "
            "evals/corpus-human-findings.json (#798). GitHub reads only; "
            "never writes to GitHub."
        )
    )
    parser.add_argument(
        "--repos",
        default=os.environ.get("HARVEST_REPOS", ""),
        help="Comma-separated owner/repo list (env: HARVEST_REPOS)",
    )
    parser.add_argument(
        "--maintainers",
        default=os.environ.get("HARVEST_MAINTAINERS", ""),
        help="Comma-separated maintainer GitHub logins (env: HARVEST_MAINTAINERS)",
    )
    parser.add_argument(
        "--bots",
        default=os.environ.get("HARVEST_BOTS", ""),
        help="Comma-separated reviewer-bot GitHub logins (env: HARVEST_BOTS)",
    )
    parser.add_argument(
        "--corpus",
        type=Path,
        default=Path(os.environ.get("HARVEST_CORPUS", "evals/corpus-human-findings.json")),
        help="Path to the human-findings corpus JSON",
    )
    parser.add_argument(
        "--since",
        default=os.environ.get("HARVEST_SINCE") or None,
        help="YYYY-MM-DD; only PRs updated on/after this date (default: no lower bound)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output path (default: rewrite --corpus in place)",
    )
    args = parser.parse_args(argv)

    repos = _split_csv(args.repos)
    maintainers = set(_split_csv(args.maintainers))
    bots = set(_split_csv(args.bots))
    if not repos:
        parser.error("--repos (or HARVEST_REPOS) must name at least one owner/repo")
    if not maintainers:
        parser.error("--maintainers (or HARVEST_MAINTAINERS) must name at least one login")
    if not bots:
        parser.error("--bots (or HARVEST_BOTS) must name at least one login")

    corpus_data = json.loads(args.corpus.read_text(encoding="utf-8"))
    block = corpus_data.setdefault("real_pr_corpus", {"vulnerable": [], "clean": []})
    vulnerable = block.setdefault("vulnerable", [])
    existing_ids = {e.get("id") for e in vulnerable if isinstance(e, dict)}

    client = GitHubClient(token=_resolve_token())

    all_findings: list[dict[str, Any]] = []
    for repo in repos:
        all_findings.extend(harvest_repo(client, repo, maintainers, bots, since=args.since))

    new_entries, skipped_no_file, skipped_existing = build_entries(all_findings, existing_ids)
    vulnerable.extend(new_entries)

    output_path = args.output or args.corpus
    output_path.write_text(
        json.dumps(corpus_data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    # The corpus must stay loadable by the eval harness (#779's format).
    RealPRCorpus.from_file(output_path)

    print(
        f"harvest_human_findings: new={len(new_entries)} "
        f"skipped_no_file={skipped_no_file} skipped_existing={skipped_existing}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
