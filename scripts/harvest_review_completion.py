#!/usr/bin/env python3
"""Harvest organic review-completion metrics from published markers (#1602).

The action already publishes, on every review it completes, the
``ai-pr-reviewer`` metadata marker (``pr_reviewer/metadata.py``) and the
``_Analysis engine: ... · pr-reviewer-action vX.Y.Z_`` body line. This
script harvests exactly those published artifacts — plus native review
events and optional trusted-review attestations — into one normalized
row per eligible (head, review attempt) and two rollups
(``operational_completion`` and ``correctness``), without re-running any
model. See ``docs/review-completion-harvest.md`` for the row and rollup
semantics.

What this script must never do, by construction: it never calls a model
or a provider, never schedules anything, never closes or edits the
attestation tracking issue, never posts anything to the forge, and never
writes raw comment bodies, secrets, or tokens into its report: only
parsed, bounded fields and HTML links reach it.

Forge reads go through ``pr_reviewer.forge``, the configured forge
capability — the one module that knows how to authenticate, refuses
redirects, requires HTTPS for non-loopback origins, and reports failures
as fixed, credential-free error strings. This script never shells out to
a forge CLI, never hand-rolls an ``urllib`` request, and never accepts a
token as an argument. As a second rail, the serialized report is refused
when it carries the configured credential, so a hostile forge that
reflects the bearer token back — as a SHA or an HTML URL — fails closed
instead of reaching the report file or the log.

Offline mode (``--from-json``) replays a fixture containing the same
records the forge calls would return and bypasses all network access,
so the whole pipeline is analyzable without any forge at all.

Everything is agnostic: repos, bot logins, and the action-version scope
are inputs (``--repo``, ``--bot-login``, ``--action-version``), never
hardcoded. The version scope narrows the collected rows after the
collection and before the rollups, so every denominator describes the
scoped population, and the report still names the collected total the
scope was applied to.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

# Make the repository root importable when this script is invoked by path
# (``python3 scripts/harvest_review_completion.py``) so the configured
# forge capability in ``pr_reviewer.forge`` and the pure core in
# ``pr_reviewer.review_completion`` are reachable. Same bootstrap as
# ``scripts/forge_cli.py``: the repo root is the parent of ``scripts/``.
SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pr_reviewer.forge import ForgeClient, ForgeError, default_forge  # noqa: E402
from pr_reviewer.review_completion import (  # noqa: E402
    ACTION_VERSION_LIMIT,
    build_report,
    collect_rows,
    collect_rows_multi,
    filter_by_action_version,
)

# Input shapes, mirroring ``scripts/forge_cli.py``: every value that
# reaches a request path or names a record is validated before use, and a
# rejected value is reported by field name only — never echoed back.
REPO_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\Z")
DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")
LOGIN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-_\[\]\.]{0,80}\Z")

# An action-version token: an optional leading ``v``, then letters,
# digits, ``.``, ``-``, and ``+``. The token never reaches a request
# path, but it is still bounded by the published version bound
# (``ACTION_VERSION_LIMIT``, the core's single source of truth), because
# a longer token could never match a published version. A rejected token
# is reported by field name only.
VERSION_RE = re.compile(r"\A[vV]?[A-Za-z0-9][A-Za-z0-9.+-]*\Z")

EXIT_OK = 0
EXIT_ERROR = 2


class HarvestError(Exception):
    """A rejected input or an unusable record set.

    The message names the offending field but never echoes the value.
    """


def _invalid(field: str) -> HarvestError:
    return HarvestError(f"invalid {field}")


def _valid_repo(value: str) -> bool:
    """True for a usable ``owner/name`` repository (same rule as forge_cli)."""
    if not REPO_RE.match(value):
        return False
    return all(segment not in (".", "..") for segment in value.split("/"))


def _positive_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError:
        raise _invalid("numeric option") from None
    if number <= 0:
        raise _invalid("numeric option")
    return number


# ---------------------------------------------------------------------------
# Forge reads (read-only, through the configured capability)
# ---------------------------------------------------------------------------


class _QuietParser(argparse.ArgumentParser):
    """An argument parser whose error message never repeats a rejected value.

    Same guard as ``scripts/forge_cli.py``: argparse's default error text
    repeats the offending token, so a mistyped secret-bearing value would
    land in the log. The failure is reported without the value.
    """

    def error(self, message: str) -> None:  # noqa: ARG002
        raise HarvestError("invalid arguments")


def fetch_repo_pulls(
    client: ForgeClient,
    repo: str,
    *,
    since_floor: str | None,
    until_ceiling: str | None,
    max_prs: int,
    per_page: int,
    max_pages: int,
) -> tuple[list[dict[str, Any]], bool]:
    """The in-scope pull requests of one repo, newest-updated first.

    Returns ``(pulls, truncated)`` where ``truncated`` is True when the
    page bound cut the PR-list walk short (the walk may then have missed
    PRs; the report says so rather than presenting a cut list as
    complete). The walk stops at ``--max-prs`` collected or at the first
    PR whose ``updated_at`` is older than ``since`` — the list is sorted
    descending, so everything after is older too.
    """
    pulls, truncated = client.get_pages_report(
        f"/repos/{repo}/pulls",
        {"state": "all", "sort": "updated", "direction": "desc"},
        per_page=per_page,
        max_pages=max_pages,
    )
    collected: list[dict[str, Any]] = []
    for pull in pulls:
        if not isinstance(pull, dict):
            continue
        updated_at = pull.get("updated_at") or ""
        if since_floor and updated_at < since_floor:
            break
        if until_ceiling and updated_at > until_ceiling:
            continue
        number = pull.get("number")
        if not isinstance(number, int) or isinstance(number, bool):
            continue
        head = (pull.get("head") or {}).get("sha") if isinstance(pull.get("head"), dict) else None
        collected.append(
            {"number": number, "head_sha": head if isinstance(head, str) else "", "updated_at": updated_at}
        )
        if len(collected) >= max_prs:
            break
    return collected, truncated


def hydrate_pull(
    client: ForgeClient,
    repo: str,
    pull: dict[str, Any],
    *,
    per_page: int,
    max_pages: int,
) -> tuple[dict[str, Any], bool]:
    """Attach the PR's native reviews and issue comments; report truncation."""
    number = pull["number"]
    reviews, reviews_truncated = client.get_pages_report(
        f"/repos/{repo}/pulls/{number}/reviews", per_page=per_page, max_pages=max_pages
    )
    comments, comments_truncated = client.get_pages_report(
        f"/repos/{repo}/issues/{number}/comments", per_page=per_page, max_pages=max_pages
    )
    hydrated = dict(pull)
    hydrated["reviews"] = [r for r in reviews if isinstance(r, dict)]
    hydrated["comments"] = [c for c in comments if isinstance(c, dict)]
    return hydrated, reviews_truncated or comments_truncated


# ---------------------------------------------------------------------------
# Offline input loading
# ---------------------------------------------------------------------------


def load_offline_fixture(path: Path) -> tuple[list[tuple[str, list[dict[str, Any]]]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Load ``--from-json`` fixture: per-repo pull records + optional inputs.

    The fixture holds the same records the forge calls would return —
    native review records (``id``, ``user.login``, ``state``,
    ``commit_id``, ``body``, ``submitted_at``, ``html_url``), issue-comment
    records (``id``, ``user.login``, ``body``, ``created_at``,
    ``html_url``), and optionally ``attestations`` and ``adjudications``
    arrays. No network path is touched in this mode.
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise _invalid("--from-json fixture") from None
    if not isinstance(data, dict) or not isinstance(data.get("repos"), list):
        raise _invalid("--from-json fixture")
    repos: list[tuple[str, list[dict[str, Any]]]] = []
    for entry in data["repos"]:
        if not isinstance(entry, dict):
            raise _invalid("--from-json fixture repo entry")
        full_name = entry.get("full_name")
        pulls = entry.get("pulls")
        if not isinstance(full_name, str) or not _valid_repo(full_name):
            raise _invalid("--from-json fixture repo entry")
        if not isinstance(pulls, list):
            raise _invalid("--from-json fixture repo entry")
        repos.append((full_name, [p for p in pulls if isinstance(p, dict)]))

    attestations = data.get("attestations")
    adjudications = data.get("adjudications")
    return (
        repos,
        attestations if isinstance(attestations, list) else [],
        adjudications if isinstance(adjudications, list) else [],
    )


def load_json_records(path: Path, field: str) -> list[dict[str, Any]]:
    """Load an optional JSON array of records from ``path``."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise _invalid(field) from None
    if not isinstance(data, list) or not all(isinstance(item, dict) for item in data):
        raise _invalid(field)
    return data


# ---------------------------------------------------------------------------
# Report output
# ---------------------------------------------------------------------------


def _refuse_credential(token: str | None, text: str, field: str) -> str:
    """Refuse output that carries the configured credential.

    The forge module already refuses to reflect the token in its error
    strings; this is the report-side rail. A hostile forge can put the
    configured token into any record field it returns (a SHA, an HTML
    URL), and a token is an arbitrary string that no shape check can
    exclude — so the serialized report is compared with the credential
    and fails closed instead of writing it anywhere.
    """
    if token and token in text:
        raise HarvestError(f"refusing to write {field}: credential reflected by the forge")
    return text


def emit_report(report: dict[str, Any], out_path: Path | None, token: str | None) -> None:
    """Write the report as JSON — to ``--out`` or stdout, never both raw.

    The whole serialized report passes the credential gate before any of
    it is written: a hostile forge must not get half a reflected record
    into a report file or a log.
    """
    text = json.dumps(report, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    _refuse_credential(token, text, "the report")
    if out_path is not None:
        out_path.write_text(text, encoding="utf-8")
        print(
            f"harvest_review_completion: rows={len(report['rows'])} "
            f"wrote {out_path}"
        )
    else:
        print(text, end="")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> _QuietParser:
    parser = _QuietParser(
        prog="harvest_review_completion.py",
        description=(
            "Harvest organic review-completion metrics from published "
            "markers and attestations (#1602). Read-only forge reads, or "
            "fully offline with --from-json. Never calls a model, never "
            "posts to the forge."
        ),
    )
    parser.add_argument(
        "--repo",
        action="append",
        default=[],
        help="OWNER/NAME repository to harvest (repeatable)",
    )
    parser.add_argument(
        "--since",
        default=None,
        help="YYYY-MM-DD; only PRs updated on/after this date",
    )
    parser.add_argument(
        "--until",
        default=None,
        help="YYYY-MM-DD; only PRs updated on/before this date",
    )
    parser.add_argument(
        "--bot-login",
        action="append",
        default=[],
        help="reviewer bot login for native-event attribution (repeatable)",
    )
    parser.add_argument(
        "--action-version",
        action="append",
        default=[],
        help="action version token in scope, e.g. 3.5.0 or v3.5.0 (repeatable)",
    )
    parser.add_argument(
        "--max-prs",
        type=_positive_int,
        default=100,
        help="maximum PRs collected per repo (default: 100)",
    )
    parser.add_argument(
        "--max-pages",
        type=_positive_int,
        default=20,
        help="page-walk bound per list read (default: 20)",
    )
    parser.add_argument(
        "--per-page",
        type=_positive_int,
        default=100,
        help="page size for list reads (default: 100)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="JSON report path (default: stdout only)",
    )
    parser.add_argument(
        "--from-json",
        type=Path,
        default=None,
        help="offline mode: replay these forge-shaped records instead of the network",
    )
    parser.add_argument(
        "--attestations",
        type=Path,
        default=None,
        help="optional JSON array of trusted-review attestation records",
    )
    parser.add_argument(
        "--adjudications",
        type=Path,
        default=None,
        help="optional JSON array of human-label adjudication records",
    )
    return parser


def _validate(args: argparse.Namespace) -> None:
    """Reject every malformed input before any read happens."""
    for repo in args.repo:
        if not _valid_repo(repo):
            raise _invalid("--repo")
    for field in ("since", "until"):
        value = getattr(args, field)
        if value is not None and not DATE_RE.match(value):
            raise _invalid(f"--{field}")
    for login in args.bot_login:
        if not LOGIN_RE.match(login):
            raise _invalid("--bot-login")
    for version in args.action_version:
        if (
            not version
            or len(version) > ACTION_VERSION_LIMIT
            or not VERSION_RE.match(version)
        ):
            raise _invalid("--action-version")
    if args.out is not None and args.out.is_dir():
        raise _invalid("--out")
    if args.from_json is not None and not args.from_json.is_file():
        raise _invalid("--from-json")
    for field in ("attestations", "adjudications"):
        path = getattr(args, field)
        if path is not None and not path.is_file():
            raise _invalid(f"--{field}")


def collect(
    args: argparse.Namespace,
    client: ForgeClient | None,
) -> tuple[list[dict[str, Any]], list[str], bool, list[dict[str, Any]], list[dict[str, Any]]]:
    """Gather rows and optional inputs from the network or the fixture.

    Returns ``(rows, repo_names, truncated, attestations, adjudications)``.
    ``client`` is the configured forge capability for live mode and
    ``None`` for offline mode.
    """
    attestations_path = args.attestations
    adjudications_path = args.adjudications

    if args.from_json is not None:
        repos, attestations, adjudications = load_offline_fixture(args.from_json)
        # Explicit record files override/extend fixture-embedded ones.
        if attestations_path is not None:
            attestations = load_json_records(attestations_path, "--attestations")
        if adjudications_path is not None:
            adjudications = load_json_records(adjudications_path, "--adjudications")
        rows: list[dict[str, Any]] = []
        names: list[str] = []
        truncated = False
        rows.extend(
            collect_rows_multi(repos, args.bot_login, attestations)
        )
        names.extend(full_name for full_name, _pulls in repos)
        return rows, names, truncated, attestations, adjudications

    if not args.repo:
        raise HarvestError("either --repo or --from-json is required")

    if client is None:  # pragma: no cover - main() always passes a client here
        raise HarvestError("either --repo or --from-json is required")
    since_floor = f"{args.since}T00:00:00Z" if args.since else None
    until_ceiling = f"{args.until}T23:59:59Z" if args.until else None

    attestations = (
        load_json_records(attestations_path, "--attestations") if attestations_path else []
    )
    adjudications = (
        load_json_records(adjudications_path, "--adjudications") if adjudications_path else []
    )

    rows = []
    names = []
    truncated = False
    repo_pulls: list[tuple[str, list[dict[str, Any]]]] = []
    for repo in args.repo:
        pulls, pulls_truncated = fetch_repo_pulls(
            client,
            repo,
            since_floor=since_floor,
            until_ceiling=until_ceiling,
            max_prs=args.max_prs,
            per_page=args.per_page,
            max_pages=args.max_pages,
        )
        truncated = truncated or pulls_truncated
        hydrated: list[dict[str, Any]] = []
        for pull in pulls:
            record, detail_truncated = hydrate_pull(
                client, repo, pull, per_page=args.per_page, max_pages=args.max_pages
            )
            truncated = truncated or detail_truncated
            hydrated.append(record)
        repo_pulls.append((repo, hydrated))
        names.append(repo)
    # One collection pass across every repository: head-only attestation
    # uniqueness must not reset between repositories, or one record could
    # certify unrelated attempts sharing a head in different repos.
    rows.extend(collect_rows_multi(repo_pulls, args.bot_login, attestations))
    return rows, names, truncated, attestations, adjudications


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    _validate(args)
    offline = args.from_json is not None
    client = None if offline else default_forge()
    rows, names, truncated, attestations, adjudications = collect(args, client)
    # The scope filter runs after the collection and before the rollups, so
    # every denominator in the report describes the scoped population. The
    # pre-scope count is kept, so the report can name the collected
    # population honestly instead of claiming the scoped count was
    # everything that was collected.
    collected_total = len(rows)
    scoped_rows, scope_excluded = filter_by_action_version(rows, args.action_version)
    report = build_report(
        scoped_rows,
        mode="offline" if offline else "live",
        repos=names,
        truncated=truncated,
        attestations=attestations,
        adjudications=adjudications,
        action_versions=args.action_version,
        scope_excluded=scope_excluded,
        collected_total=collected_total,
    )
    emit_report(report, args.out, client.token if client else None)
    return EXIT_OK


def cli(argv: list[str] | None = None) -> int:
    try:
        return main(argv)
    except ForgeError as exc:
        # The capability's own fixed, credential-free error string.
        print(f"harvest_review_completion: {exc}", file=sys.stderr)
        return EXIT_ERROR
    except HarvestError as exc:
        print(f"harvest_review_completion: {exc}", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(cli())