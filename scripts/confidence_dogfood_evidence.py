#!/usr/bin/env python3
"""Collect the merge-safety verifier's published dogfood evidence (#1452).

The independent merge-safety verifier (#1369) publishes exactly one thing a
human can read after an ordinary dogfood run: the metadata marker, the
sibling fingerprint marker, and the ``## Independent Confidence`` section
inside the review body it posted. Most of what else it produces -- the
rubric version, the deterministic ceilings, the parser notes, the linkage
to a later review -- is written into the RUN DIRECTORY
(``confidence-score.json``, ``confidence-request.json``,
``confidence-response.json``, ``finding-outcomes.json``) and dies with the
runner. Since #1455 the metadata marker also carries the verifier's own
telemetry when the run measured it: the unscored cause
(``confidence_cause``), the provider latency (``confidence_latency_ms``)
and the provider token usage (``confidence_prompt_tokens``,
``confidence_completion_tokens``, ``confidence_total_tokens``). This
script assembles what IS published into one bounded, redacted evidence
file, so a human can adjudicate whether the verifier earns merge-gate
authority and can see, per run, exactly which evidence the published
record does not carry.

The collector READS ONLY what is already published: it never re-runs the
verifier, never recomputes a score, never changes a verdict, and never
touches the marker, the comment, or the review-bundle contracts. The forge
is reached ONLY through the repository's configured forge capability
(:mod:`pr_reviewer.forge`) -- never through a raw HTTP client and never
through a forge CLI -- so the token rides only the ``Authorization`` header
and redirects stay refused.

Every collected field is bounded and redacted BY CONSTRUCTION: each string
is capped, passes through the repository's own URL redactor
(:func:`pr_reviewer.http_safe.redact_urls_in_text`), and is refused outright
when it carries the configured bearer token, so a credential-shaped value in
a published comment can never be copied verbatim into the evidence file. The
file carries the extracted fields only -- never a comment or review body,
and never the marker JSON.

The READING of the published body lives in the shared library
(:mod:`pr_reviewer.confidence_evidence`, #1479): the renderer's quoting and
escaping, the verifier's closed vocabularies and the fingerprint's stored
shape are contracts, and two parsers of one contract drift apart. This
script keeps the collection, the record shape and the CLI; it reads the
publication from the shared parser.

Extraction is tolerant by design: a missing ``## Independent Confidence``
section is not an error, it means the verifier published nothing for that
run, and the record says so instead of guessing.

The evidence comes from the NEWEST published body, never the first one:
``publish-mode: review_verdict`` submits the body as a native review, and
native reviews ACCUMULATE (one per run), so the oldest marker-bearing body
is the oldest run's evidence. The record names the body it read
(``published_body``), so a reader can tell which run it describes.

Exit codes:

- ``0`` -- every requested pull request produced a record;
- ``1`` -- at least one pull request could not be read (the other records are
  still written);
- ``2`` -- the collection could not run at all (invalid input, an unusable
  forge configuration, or an unwritable evidence file).

A per-pull-request failure never aborts the run.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Make the repository root importable when this script is invoked by path
# (``python3 scripts/confidence_dogfood_evidence.py``) so the configured
# forge capability in ``pr_reviewer.forge`` is reachable. Same bootstrap as
# ``scripts/forge_cli.py``: the repo root is the parent of ``scripts/``.
SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pr_reviewer import confidence_evidence  # noqa: E402
# The library owns the definitions; the published-grammar names (and the
# three underscore constants) are re-exported here because the collectors
# and their callers read them off this module.
from pr_reviewer.confidence_evidence import (  # noqa: E402, F401
    NO_PUBLISHED_RECORD_REASON,
    UNAVAILABLE_REASONS,
    _EVIDENCE_SEPARATOR,
    _SCORED_LABEL,
    _UNSCORED_LABEL,
    empty_verifier,
    extract_confidence_section,
    extract_published_evidence,
    list_items_report,
    published_body_descriptor,
    published_id,
    published_instant,
    unescape_table_cell,
)
from pr_reviewer.forge import ForgeClient, ForgeError, default_forge  # noqa: E402
from pr_reviewer.metadata import parse_metadata  # noqa: E402

SCHEMA = "verifier-dogfood-evidence/v1"

# The page bound on one list endpoint. A forge that always answers a full
# page would page forever without it, and this collector reads a pull
# request's comments and reviews only to read its newest published body.
# The bound is generous: a pull request with more comments than this carries
# more published bodies than any human reads, and a walk the bound cuts
# short is reported as an incomplete read.
MAX_PAGES = 100

EXIT_OK = 0
EXIT_PARTIAL = 1
EXIT_ERROR = 2

# Input shapes, validated exactly as ``scripts/forge_cli.py`` validates them:
# the checks run before any byte goes out, and a rejected value is reported
# by field name only -- never echoed back. Anchored with ``\Z`` rather than
# ``$``: ``$`` also matches before a trailing newline, and a newline inside
# a request path must never validate.
REPO_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\Z")
NUMBER_RE = re.compile(r"^[0-9]{1,18}\Z")


class CliError(Exception):
    """A rejected input or a failed collection.

    The message names the offending field but never echoes the value, so
    nothing an operator typed (and nothing a hostile forge returned) can
    leak into a log line.
    """


# ---------------------------------------------------------------------------
# Pure helpers (unit-testable without any network access)
# ---------------------------------------------------------------------------


def valid_repo(value: str) -> bool:
    """True for a usable ``owner/name`` repository.

    Both segments use the allowed characters, and neither is ``.`` or
    ``..``: a traversal segment would address a path outside the
    ``/repos/OWNER/NAME/...`` endpoint shape the caller asked for.
    """
    if not REPO_RE.match(value):
        return False
    return all(segment not in (".", "..") for segment in value.split("/"))


# ---------------------------------------------------------------------------
# Forge read access
# ---------------------------------------------------------------------------


def list_items(
    forge: ForgeClient, path: str, max_pages: int | None = None
) -> list[dict[str, Any]]:
    """Every item across all pages of one forge list endpoint."""
    return confidence_evidence.list_items(forge, path, max_pages)


def newest_published_body(
    comments: list[dict[str, Any]], reviews: list[dict[str, Any]]
) -> tuple[str, str, dict[str, Any]] | None:
    """The NEWEST published body that carries the reviewer's marker.

    ``publish-mode: review_verdict`` submits the body as a native review,
    and native reviews ACCUMULATE (one per run), so the FIRST marker-bearing
    body is the OLDEST run's evidence -- silently stale. The newest body is
    the one with the newest timestamp (a review's ``submitted_at``; a
    comment's ``updated_at``, else ``created_at``);
    on an exact tie the higher id wins, and ids are only ever compared
    WITHIN one id space: a comment id and a review id are different
    sequences, so a tie across the two is broken by kind (the native review
    is the per-run publication; the managed comment is rewritten in place).

    The marker is parsed with the repository's own parser
    (:func:`pr_reviewer.metadata.parse_metadata`), never by hand.

    Returns ``(body, kind, item)`` -- the body, whether it is a comment or
    a review, and the forge item it came from -- or ``None`` when no
    published body carries the marker.
    """
    best: tuple[str, str, dict[str, Any]] | None = None
    best_key: tuple[datetime, int, int] | None = None
    for kind, items in (("comment", comments), ("review", reviews)):
        rank = 0 if kind == "comment" else 1
        for item in items:
            body = item.get("body")
            if not isinstance(body, str) or body == "":
                continue
            if parse_metadata(body) is None:
                continue
            identifier = published_id(item)
            key = (
                published_instant(item, kind),
                rank,
                identifier if identifier is not None else -1,
            )
            if best_key is None or key > best_key:
                best_key = key
                best = (body, kind, item)
    return best


# ---------------------------------------------------------------------------
# Collection
# ---------------------------------------------------------------------------


def collect_record(
    forge: ForgeClient, repo: str, number: int
) -> tuple[dict[str, Any], bool]:
    """The evidence record for one pull request, and whether the read was whole.

    Reads the pull request's issue comments and reviews through the forge
    capability and assembles what the verifier published. A pull request
    whose comments or reviews cannot be read raises
    :class:`pr_reviewer.forge.ForgeError`; the caller turns that into a
    record with ``read_error`` set, so one unreadable pull request never
    aborts the run.

    A walk the page bound cut short still yields the record: it carries what
    was read. The second value says the read was incomplete, because the
    newest published body may then be newer than the one the record names.
    """
    token = getattr(forge, "token", "") or ""
    comments, cut = list_items_report(
        forge, f"/repos/{repo}/issues/{number}/comments", MAX_PAGES
    )
    reviews, cut_reviews = list_items_report(
        forge, f"/repos/{repo}/pulls/{number}/reviews", MAX_PAGES
    )
    selected = newest_published_body(comments, reviews)
    if selected is None:
        unavailable = dict(UNAVAILABLE_REASONS)
        unavailable["published_record"] = NO_PUBLISHED_RECORD_REASON
        return build_record(number, unavailable=unavailable), not (cut or cut_reviews)
    body, kind, item = selected
    published = extract_published_evidence(body, token)
    return (
        build_record(
            number,
            published_body=published_body_descriptor(kind, item, token),
            **published,
        ),
        not (cut or cut_reviews),
    )


def build_record(
    number: int,
    *,
    head_sha: str | None = None,
    base_sha: str | None = None,
    review_result: str | None = None,
    required_checks: str | None = None,
    diff_fingerprint: str | None = None,
    config_fingerprint: str | None = None,
    verifier: dict[str, Any] | None = None,
    published_body: dict[str, Any] | None = None,
    unavailable: dict[str, str] | None = None,
    read_error: str | None = None,
) -> dict[str, Any]:
    """One evidence record, in the published shape."""
    return {
        "pr_number": number,
        "head_sha": head_sha,
        "base_sha": base_sha,
        "review_result": review_result,
        "required_checks": required_checks,
        "diff_fingerprint": diff_fingerprint,
        "config_fingerprint": config_fingerprint,
        "verifier": verifier if verifier is not None else empty_verifier(),
        "published_body": published_body,
        "unavailable": unavailable if unavailable is not None else dict(UNAVAILABLE_REASONS),
        "read_error": read_error,
    }


def failed_record(number: int, error: str) -> dict[str, Any]:
    """The record of a pull request the collector could not read.

    The error string is the forge capability's own fixed, credential-free
    message: it names the request path and the HTTP status, never the
    response body and never the token.
    """
    return build_record(number, read_error=error)


def build_document(repo: str, records: list[dict[str, Any]]) -> dict[str, Any]:
    """The evidence document: deterministic for a given input except for
    ``generated_at``."""
    return {
        "schema": SCHEMA,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "repository": repo,
        "records": records,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


class _QuietParser(argparse.ArgumentParser):
    """An argument parser whose error message never repeats a rejected value.

    argparse's default error text repeats the offending token, so a caller
    that passes a credential by mistake would put it in the log. The failure
    is reported without the value.
    """

    def error(self, message: str) -> None:  # noqa: ARG002
        raise CliError("invalid arguments")


def build_parser() -> argparse.ArgumentParser:
    parser = _QuietParser(
        prog="confidence_dogfood_evidence.py",
        description=(
            "Collect the merge-safety verifier's published dogfood evidence "
            "for one or more pull requests. Forge reads only, through the "
            "configured forge capability."
        ),
    )
    parser.add_argument("--repo", required=True, help="OWNER/NAME of the repository")
    parser.add_argument(
        "--pr",
        action="append",
        default=[],
        metavar="N",
        help="pull request number (repeatable)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="evidence file to write (default: stdout)",
    )
    return parser


def validate(args: argparse.Namespace) -> list[int]:
    """Reject every malformed input before a request goes out."""
    if not valid_repo(args.repo):
        raise CliError("invalid --repo")
    if not args.pr:
        raise CliError("--pr must name at least one pull request")
    numbers: list[int] = []
    for value in args.pr:
        if not NUMBER_RE.match(value) or int(value) <= 0:
            raise CliError("invalid --pr")
        numbers.append(int(value))
    return numbers


def write_document(payload: dict[str, Any], out: Path | None) -> None:
    """The evidence document, to a file or to stdout."""
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    if out is None:
        sys.stdout.write(text)
        return
    if out.parent and not out.parent.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
        numbers = validate(args)
    except CliError as exc:
        print(f"confidence_dogfood_evidence: {exc}", file=sys.stderr)
        return EXIT_ERROR
    try:
        forge = default_forge()
    except ForgeError as exc:
        print(f"confidence_dogfood_evidence: {exc}", file=sys.stderr)
        return EXIT_ERROR
    records: list[dict[str, Any]] = []
    failed = False
    for number in numbers:
        try:
            record, whole = collect_record(forge, args.repo, number)
            records.append(record)
            if not whole:
                # The page bound cut the walk, so the newest published body
                # may be newer than the one this record names. The record is
                # still written, and the run reports the incomplete read.
                failed = True
                print(
                    f"confidence_dogfood_evidence: pull request {number}: the "
                    "page bound cut the read short, so the recorded body may "
                    "not be the newest published body",
                    file=sys.stderr,
                )
        except ForgeError as exc:
            # One unreadable pull request never aborts the run: the other
            # records are still collected and written.
            failed = True
            records.append(failed_record(number, str(exc)))
    try:
        write_document(build_document(args.repo, records), args.out)
    except OSError:
        print(
            "confidence_dogfood_evidence: cannot write the evidence file",
            file=sys.stderr,
        )
        return EXIT_ERROR
    return EXIT_PARTIAL if failed else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
