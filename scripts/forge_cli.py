#!/usr/bin/env python3
"""Thin command-line adapter over the repository's configured forge capability.

Operational tooling (release convergence, the manual release, the harvest
branch push, the dogfood re-review gate) needs a small, fixed set of forge
API reads and writes. This adapter is the single place those calls are
expressed: it is a thin, stdlib-only wrapper over :mod:`pr_reviewer.forge`,
so every forge request inherits the capability's guarantees unchanged:

- the base URL comes from ``GITHUB_API_URL`` and is validated (HTTPS for
  every non-loopback origin);
- the token is read from ``GITHUB_TOKEN``/``GH_TOKEN`` and rides only the
  ``Authorization`` header -- never argv, never the request URL, never the
  request body;
- redirects are refused, so a 3xx can never carry the bearer token to
  another origin;
- failures are reported as the capability's fixed, credential-free error
  strings -- never the raw response body.

The adapter itself never spawns a subprocess, never accepts a token as an
argument, and never prints one. Every value printed goes through one gate:
it is refused when it contains the configured credential, so a hostile forge
that reflects the bearer token back -- as a label name, a SHA, or a number --
can never put it into a job log; the read fails closed instead. Input-shape
validation (a 40/64-hex SHA, a positive integer) is kept as a second rail,
never as the proof: a token is an arbitrary string, and a configured token
that happens to be hex or all-digits would pass any shape check.

Exit codes, shared by every command:

- ``0`` -- the command succeeded;
- ``1`` -- the thing does not exist (no pull request for the commit or the
  branch, no such pull request, no release for the tag, no such tag ref);
- ``2`` -- the command failed: invalid input, an unusable response, or a
  forge that could not be reached / rejected the request.

``pr-details`` is the read a comment-triggered re-review needs: it prints
exactly three lines -- ``head_sha=<sha>``, ``head_repo_id=<id>`` and
``is_draft=true|false`` -- so a caller can decide where to check out
without ever seeing the raw response body.
"""

from __future__ import annotations

import argparse
import re
import sys
import urllib.parse
from pathlib import Path

# Make the repository root importable when this script is invoked by path
# (``python3 scripts/forge_cli.py``) so the configured forge capability in
# ``pr_reviewer.forge`` is reachable. Same bootstrap as
# ``scripts/fork_review_gate.py``: the repo root is the parent of
# ``scripts/``.
SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pr_reviewer.forge import ForgeClient, ForgeError, default_forge  # noqa: E402

EXIT_OK = 0
EXIT_ABSENT = 1
EXIT_ERROR = 2

# Input shapes. Every value that reaches a request path is validated here
# first: the checks run before any byte goes out, and a rejected value is
# reported by field name only -- never echoed back. Anchored with ``\Z``
# rather than ``$``: ``$`` also matches before a trailing newline, and a
# newline inside a request path must never validate.
REPO_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\Z")
# Ref names: slashes are allowed so nested refs (``release/v1``) work.
REF_RE = re.compile(r"^[A-Za-z0-9._/-]+\Z")
# Commit-ish identifiers: 40-hex (SHA-1) or 64-hex (SHA-256).
SHA_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
# Issue/pull request numbers: ASCII digits only, bounded so the value can
# never be an unbounded integer.
NUMBER_RE = re.compile(r"^[0-9]{1,18}\Z")

# Fixed message for a response the capability returned but this adapter
# cannot use. Deliberately does not echo the payload.
ERR_UNUSABLE_PAYLOAD = "unusable forge response"


class CliError(Exception):
    """A rejected input or an unusable response.

    The message names the offending field but never echoes the value, so
    nothing an operator typed (and nothing a hostile forge returned) can
    leak into a log line.
    """


def _invalid(field: str) -> CliError:
    return CliError(f"invalid {field}")


def _valid_label(name: str) -> bool:
    """True for a usable label name.

    A label name is non-empty and free of control characters (CR/LF
    included). It is URL-encoded into the DELETE path, so a name with a
    newline could otherwise split the request line.
    """
    if not name:
        return False
    return all(ch >= " " and ch != "\x7f" for ch in name)


def _valid_repo(value: str) -> bool:
    """True for a usable ``owner/name`` repository.

    Both segments use the allowed characters, and neither is ``.`` or
    ``..``: a traversal segment would address a path outside the
    ``/repos/OWNER/NAME/...`` endpoint shape the caller asked for.
    """
    if not REPO_RE.match(value):
        return False
    return all(segment not in (".", "..") for segment in value.split("/"))


def _valid_ref(value: str) -> bool:
    """True for a usable ref name.

    A ref name is made of the allowed characters, and no segment is ``.``
    or ``..``: a traversal segment would address a different endpoint than
    the caller asked for.
    """
    if not REF_RE.match(value):
        return False
    return all(segment not in (".", "..") for segment in value.split("/"))


def _is_not_found(exc: ForgeError) -> bool:
    """True when the forge answered "this does not exist" (HTTP 404).

    The capability carries the HTTP status on the error (``ForgeError.status``)
    so a caller can tell "absent" from "broken" without parsing the error
    message. A transport failure, a refused redirect or an unusable payload
    carries no status and is never "absent".
    """
    return getattr(exc, "status", None) == 404


def _repo_owner(repo: str) -> str:
    """The owner part of an ``owner/name`` repository."""
    return repo.split("/", 1)[0]


def _require_dict(payload: object) -> dict:
    if not isinstance(payload, dict):
        raise CliError(ERR_UNUSABLE_PAYLOAD)
    return payload


def _require_list(payload: object) -> list:
    if not isinstance(payload, list):
        raise CliError(ERR_UNUSABLE_PAYLOAD)
    return payload


def _reject_credential(client: ForgeClient, value: object) -> str:
    """The value as text, refused when it carries the credential.

    Split out of :func:`_print_value` so a command that prints several
    values can refuse all of them before printing any: a hostile forge
    cannot get half of a record into a log.
    """
    text = str(value)
    if client.token and client.token in text:
        raise CliError(ERR_UNUSABLE_PAYLOAD)
    return text


def _print_value(client: ForgeClient, value: object) -> None:
    """Print one forge-derived value only after proving it cannot carry the credential.

    Shape validation is not that proof: the capability accepts an arbitrary
    token string, so a hostile forge can return the configured credential
    itself as a "SHA" (the token is 40- or 64-hex) or as a "number" (the
    token is all digits) and it passes every shape check. Every printed
    value is therefore compared with the credential: a value that contains
    it fails closed instead of reaching the log.
    """
    print(_reject_credential(client, value))


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_pr_number_for_commit(client: ForgeClient, args: argparse.Namespace) -> int:
    """The number of the first pull request that contains the commit."""
    path = f"/repos/{args.repo}/commits/{args.sha}/pulls"
    pulls = _require_list(client.get(path))
    if not pulls:
        return EXIT_ABSENT
    number = _require_dict(pulls[0]).get("number")
    if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
        raise CliError(ERR_UNUSABLE_PAYLOAD)
    _print_value(client, number)
    return EXIT_OK


def cmd_issue_labels(client: ForgeClient, args: argparse.Namespace) -> int:
    """Every label name currently on the issue, one per line."""
    path = f"/repos/{args.repo}/issues/{args.number}/labels"
    labels = _require_list(client.get(path))
    for entry in labels:
        name = _require_dict(entry).get("name")
        # The names are read line by line: a name carrying a line break would
        # split into two names and could answer a comparison the caller
        # makes. An unusable name fails the read closed instead.
        if not isinstance(name, str) or not _valid_label(name):
            raise CliError(ERR_UNUSABLE_PAYLOAD)
        # The credential gate inside refuses a hostile forge that echoes
        # the bearer token back as a label name.
        _print_value(client, name)
    return EXIT_OK


def cmd_set_issue_labels(client: ForgeClient, args: argparse.Namespace) -> int:
    """Remove labels first, then add labels.

    A 404 while removing means the label was already absent -- that is
    the expected outcome of an idempotent relabel, not an error.
    """
    number = args.number
    for label in args.remove:
        quoted = urllib.parse.quote(label, safe="")
        path = f"/repos/{args.repo}/issues/{number}/labels/{quoted}"
        try:
            client.delete(path)
        except ForgeError as exc:
            if not _is_not_found(exc):
                raise
    if args.add:
        payload = {"labels": list(args.add)}
        client.post(f"/repos/{args.repo}/issues/{number}/labels", payload)
    return EXIT_OK


def cmd_release_exists(client: ForgeClient, args: argparse.Namespace) -> int:
    """Whether a release for the tag exists."""
    path = f"/repos/{args.repo}/releases/tags/{args.tag}"
    try:
        client.get(path)
    except ForgeError as exc:
        if _is_not_found(exc):
            return EXIT_ABSENT
        raise
    return EXIT_OK


def cmd_release_create(client: ForgeClient, args: argparse.Namespace) -> int:
    """Create a release for the tag."""
    if args.verify_tag:
        # The tag must already exist: a release for a tag nobody can
        # resolve is not publishable.
        try:
            client.get(f"/repos/{args.repo}/git/ref/tags/{args.tag}")
        except ForgeError as exc:
            if _is_not_found(exc):
                raise CliError("the release tag does not exist") from None
            raise
    body = ""
    if args.notes_file:
        try:
            body = Path(args.notes_file).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            raise CliError("cannot read the release notes file") from None
    payload = {
        "tag_name": args.tag,
        "name": args.title or args.tag,
        "body": body,
        "prerelease": bool(args.prerelease),
        "generate_release_notes": bool(args.generate_notes),
    }
    # The response is validated but not printed: the release URL is
    # forge-supplied data, and a hostile forge could put anything (a
    # reflected credential) into it. The caller already knows the tag it
    # asked for.
    _require_dict(client.post(f"/repos/{args.repo}/releases", payload))
    return EXIT_OK


def cmd_pr_number_for_branch(client: ForgeClient, args: argparse.Namespace) -> int:
    """The number of the open pull request whose head is the branch."""
    owner = _repo_owner(args.repo)
    path = f"/repos/{args.repo}/pulls"
    params = {"state": "open", "head": f"{owner}:{args.branch}"}
    pulls = _require_list(client.get(path, params))
    if not pulls:
        return EXIT_ABSENT
    number = _require_dict(pulls[0]).get("number")
    if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
        raise CliError(ERR_UNUSABLE_PAYLOAD)
    _print_value(client, number)
    return EXIT_OK


def cmd_pr_details(client: ForgeClient, args: argparse.Namespace) -> int:
    """The head SHA, the head repository id and the draft flag of a pull request.

    Prints exactly three lines, in this order:

    - ``head_sha=<sha>``
    - ``head_repo_id=<id>``
    - ``is_draft=true|false``

    A caller (the dogfood re-review gate) needs those three facts to route
    the run -- the head SHA of a same-repository pull request, the head
    repository id to tell a fork from the base repository, and the draft
    flag to skip a draft before anything is checked out. Nothing else of
    the response is printed: the payload is forge-supplied data, and a
    hostile forge can put anything (a reflected credential) into it.

    Every printed line goes through the credential gate, and all three
    lines are checked before any of them is printed: a forge that reflects
    the bearer token back fails the read closed instead of putting it --
    or half of the record -- into a job log.
    """
    path = f"/repos/{args.repo}/pulls/{args.number}"
    try:
        payload = _require_dict(client.get(path))
    except ForgeError as exc:
        # A pull request that does not exist is "absent" (exit 1), the
        # same shape the other read commands use.
        if _is_not_found(exc):
            return EXIT_ABSENT
        raise
    head = _require_dict(payload.get("head"))
    sha = head.get("sha")
    # Shape first (40- or 64-hex), then the credential gate: shape alone
    # is not proof, because a configured token can itself be 40- or 64-hex
    # and a hostile forge can return that exact token here.
    if not isinstance(sha, str) or not SHA_RE.match(sha):
        raise CliError(ERR_UNUSABLE_PAYLOAD)
    head_repo = _require_dict(head.get("repo"))
    repo_id = head_repo.get("id")
    if not isinstance(repo_id, int) or isinstance(repo_id, bool) or repo_id <= 0:
        raise CliError(ERR_UNUSABLE_PAYLOAD)
    draft = payload.get("draft")
    if not isinstance(draft, bool):
        raise CliError(ERR_UNUSABLE_PAYLOAD)
    # All three lines are checked against the credential before any of them
    # is printed: a hostile forge that reflects the token back must not get
    # half of the record into the log.
    lines = [
        _reject_credential(client, f"head_sha={sha}"),
        _reject_credential(client, f"head_repo_id={repo_id}"),
        _reject_credential(client, f"is_draft={'true' if draft else 'false'}"),
    ]
    for line in lines:
        _print_value(client, line)
    return EXIT_OK


def cmd_pr_create(client: ForgeClient, args: argparse.Namespace) -> int:
    """Open a pull request."""
    payload = {
        "title": args.title,
        "head": args.head,
        "base": args.base,
        "body": args.body,
    }
    created = _require_dict(client.post(f"/repos/{args.repo}/pulls", payload))
    # Only the number is printed, and only through the credential gate:
    # a hostile forge that answers with the configured token as a "number"
    # (possible when the token is all digits) fails closed instead.
    number = created.get("number")
    if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
        raise CliError(ERR_UNUSABLE_PAYLOAD)
    _print_value(client, number)
    return EXIT_OK


def cmd_tag_ref_sha(client: ForgeClient, args: argparse.Namespace) -> int:
    """The object SHA the tag ref points at.

    This is the ref's object SHA -- an annotated tag is NOT peeled to the
    commit it wraps, so the value matches what the historical
    ``gh api .../git/ref/tags/<tag> --jq .object.sha`` returned.
    """
    path = f"/repos/{args.repo}/git/ref/tags/{args.tag}"
    try:
        payload = _require_dict(client.get(path))
    except ForgeError as exc:
        if _is_not_found(exc):
            return EXIT_ABSENT
        raise
    obj = payload.get("object")
    if not isinstance(obj, dict):
        raise CliError(ERR_UNUSABLE_PAYLOAD)
    sha = obj.get("sha")
    # Shape first (40- or 64-hex), then the credential gate: shape alone is
    # not proof, because a configured token can itself be 40- or 64-hex and
    # a hostile forge can return that exact token here.
    if not isinstance(sha, str) or not SHA_RE.match(sha):
        raise CliError(ERR_UNUSABLE_PAYLOAD)
    _print_value(client, sha)
    return EXIT_OK


def cmd_commit_parent_sha(client: ForgeClient, args: argparse.Namespace) -> int:
    """The first parent of the commit, or nothing when it has no parent."""
    path = f"/repos/{args.repo}/git/commits/{args.sha}"
    payload = _require_dict(client.get(path))
    parents = payload.get("parents")
    if not isinstance(parents, list):
        raise CliError(ERR_UNUSABLE_PAYLOAD)
    if not parents:
        return EXIT_OK
    sha = _require_dict(parents[0]).get("sha")
    # Same commit-ish shape plus credential gate as the tag ref.
    if not isinstance(sha, str) or not SHA_RE.match(sha):
        raise CliError(ERR_UNUSABLE_PAYLOAD)
    _print_value(client, sha)
    return EXIT_OK


# ---------------------------------------------------------------------------
# Argument wiring
# ---------------------------------------------------------------------------


def _add_repo(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--repo", required=True, help="OWNER/NAME of the repository")


class _QuietParser(argparse.ArgumentParser):
    """An argument parser whose error message never repeats a rejected value.

    argparse's default error text repeats the offending token
    ("unrecognized arguments: --token <secret>"), so a caller that passes a
    credential by mistake would put it in the log. The failure is reported
    without the value.
    """

    def error(self, message: str) -> None:  # noqa: ARG002
        raise CliError("invalid arguments")


def build_parser() -> argparse.ArgumentParser:
    parser = _QuietParser(
        prog="forge_cli.py",
        description="Forge API reads and writes through the configured forge capability.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    commit = sub.add_parser(
        "pr-number-for-commit",
        help="number of the first pull request containing a commit",
    )
    _add_repo(commit)
    commit.add_argument("--sha", required=True)
    commit.set_defaults(handler=cmd_pr_number_for_commit)

    labels = sub.add_parser("issue-labels", help="label names on an issue")
    _add_repo(labels)
    labels.add_argument("--number", required=True)
    labels.set_defaults(handler=cmd_issue_labels)

    set_labels = sub.add_parser(
        "set-issue-labels", help="remove labels first, then add labels"
    )
    _add_repo(set_labels)
    set_labels.add_argument("--number", required=True)
    set_labels.add_argument("--add", action="append", default=[])
    set_labels.add_argument("--remove", action="append", default=[])
    set_labels.set_defaults(handler=cmd_set_issue_labels)

    release_exists = sub.add_parser("release-exists", help="does a release exist")
    _add_repo(release_exists)
    release_exists.add_argument("--tag", required=True)
    release_exists.set_defaults(handler=cmd_release_exists)

    release_create = sub.add_parser("release-create", help="create a release")
    _add_repo(release_create)
    release_create.add_argument("--tag", required=True)
    release_create.add_argument("--title", default="")
    release_create.add_argument("--notes-file", default="")
    release_create.add_argument("--generate-notes", action="store_true")
    release_create.add_argument("--prerelease", action="store_true")
    release_create.add_argument("--verify-tag", action="store_true")
    release_create.set_defaults(handler=cmd_release_create)

    branch_pr = sub.add_parser(
        "pr-number-for-branch", help="number of the open pull request for a branch"
    )
    _add_repo(branch_pr)
    branch_pr.add_argument("--branch", required=True)
    branch_pr.set_defaults(handler=cmd_pr_number_for_branch)

    pr_details = sub.add_parser(
        "pr-details",
        help="head sha, head repo id and draft flag of a pull request",
    )
    _add_repo(pr_details)
    pr_details.add_argument("--number", required=True)
    pr_details.set_defaults(handler=cmd_pr_details)

    pr_create = sub.add_parser("pr-create", help="open a pull request")
    _add_repo(pr_create)
    pr_create.add_argument("--head", required=True)
    pr_create.add_argument("--base", required=True)
    pr_create.add_argument("--title", required=True)
    pr_create.add_argument("--body", required=True)
    pr_create.set_defaults(handler=cmd_pr_create)

    tag_ref = sub.add_parser("tag-ref-sha", help="object SHA of a tag ref")
    _add_repo(tag_ref)
    tag_ref.add_argument("--tag", required=True)
    tag_ref.set_defaults(handler=cmd_tag_ref_sha)

    parent = sub.add_parser("commit-parent-sha", help="first parent of a commit")
    _add_repo(parent)
    parent.add_argument("--sha", required=True)
    parent.set_defaults(handler=cmd_commit_parent_sha)

    return parser


def _validate(args: argparse.Namespace) -> None:
    """Reject every malformed input before a request goes out."""
    if not _valid_repo(args.repo):
        raise _invalid("--repo")
    number = getattr(args, "number", None)
    if number is not None:
        if not NUMBER_RE.match(number) or int(number) <= 0:
            raise _invalid("--number")
        # Normalize so "007" and "7" address the same issue.
        args.number = int(number)
    sha = getattr(args, "sha", None)
    if sha is not None and not SHA_RE.match(sha):
        raise _invalid("--sha")
    tag = getattr(args, "tag", None)
    if tag is not None and not _valid_ref(tag):
        raise _invalid("--tag")
    branch = getattr(args, "branch", None)
    if branch is not None and not _valid_ref(branch):
        raise _invalid("--branch")
    for field in ("head", "base"):
        value = getattr(args, field, None)
        if value is not None and not _valid_ref(value):
            raise _invalid(f"--{field}")
    for field in ("add", "remove"):
        for label in getattr(args, field, []) or []:
            if not _valid_label(label):
                raise _invalid(f"--{field} label")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    _validate(args)
    client = default_forge()
    return args.handler(client, args)


def cli(argv: list[str] | None = None) -> int:
    try:
        return main(argv)
    except ForgeError as exc:
        # The capability's own fixed, credential-free error string.
        print(f"forge_cli: {exc}", file=sys.stderr)
        return EXIT_ERROR
    except CliError as exc:
        print(f"forge_cli: {exc}", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(cli())
