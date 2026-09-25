#!/usr/bin/env python3
"""Trusted authorization and identity gate for the fork AI review workflow.

The fork reviewer (``.github/workflows/fork-ai-review.yaml``) runs privileged
code with model credentials. This script is the only component allowed to
decide whether that privilege is spent, and it decides exclusively from
**trusted GitHub API state** — never from PR-controlled text:

- The PR is resolved through ``commits/{sha}/pulls`` (workflow_run mode) or
  fetched by number (labeled mode); the event payload only supplies the
  triggering SHA / label name / PR number hint.
- The ``ai-review-fork`` label must be present on the *currently fetched* PR
  object, so a stale event cannot authorize a review the maintainer already
  revoked.
- The PR must be open and cross-repository (``head.repo`` differs from the
  base repository), so same-repository PRs always stay on the existing
  dogfood reviewer.
- In workflow_run mode the PR's current head SHA must equal the triggering
  run's head SHA — a superseded head is skipped here (a newer CI completion
  will trigger its own review) rather than burning model compute.

Untrusted-data hygiene (issue: fork PR metadata is attacker-controlled):

- Every value crossing a trust boundary is validated against a strict shape
  before use: PR numbers must be positive integers, head SHAs must be
  40-hex strings, the label name is a fixed ASCII token.
- PR titles, bodies, branch names, ref names and every other free-form
  field are parsed with ``json`` and **never** echoed, emitted to
  ``GITHUB_OUTPUT``, logged, or passed to a shell. All subprocess
  invocations are argv lists (``shell=False``); untrusted text has no path
  into a command line.

Exit codes:

- ``gate``: 0 = a decision was reached (inspect the ``proceed`` output;
  ``false`` means skip-without-model), 1 = unexpected error (fail visibly —
  fail closed: an error never authorizes a review).
- ``verify``: 0 = the PR's current head still matches the reviewed SHA and
  the label is still present, 2 = head/PR unavailable, 3 = superseded or no
  longer authorized (label removed, closed, no longer cross-repo).

This script performs read-only GitHub API calls. It never checks out, reads
from disk, or executes any repository content — fork-controlled or
otherwise.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

LABEL_DEFAULT = "ai-review-fork"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
# Label names on GitHub are bounded (<=50 chars) and cannot contain
# whitespace beyond a constrained charset; we only ever compare against our
# own constant, but validating the constant keeps the argv surface honest.
LABEL_RE = re.compile(r"^[A-Za-z0-9_-]{1,50}$")

# Static decision reasons — never interpolated with untrusted text.
REASON_NOT_PR_RUN = "triggering-workflow-was-not-a-pull-request-run"
REASON_UNSUPPORTED_CONCLUSION = "triggering-ci-run-conclusion-not-reviewable"
REASON_BAD_HEAD_SHA = "triggering-head-sha-missing-or-malformed"
REASON_NO_ASSOCIATED_PR = "no-open-cross-repository-pr-for-head"
REASON_NOT_AUTHORIZED = "ai-review-fork-label-not-present"
REASON_AMBIGUOUS = "multiple-labeled-cross-repository-prs-for-head"
REASON_STALE_HEAD = "pr-head-advanced-past-triggering-run"
REASON_NOT_FORK = "pr-is-not-cross-repository"
REASON_NOT_OPEN = "pr-not-open"
REASON_LABEL_REMOVED = "label-removed-since-trigger"
REASON_BAD_PR_NUMBER = "pr-number-missing-or-malformed"
REASON_BAD_LABEL_NAME = "label-name-missing-or-malformed"


class GateError(Exception):
    """Unexpected failure — the caller must fail visibly, never silently skip."""


def gh_api(endpoint: str) -> dict | list:
    """Run a read-only ``gh api`` call, argv-only (no shell interpolation)."""
    gh = os.environ.get("GH_PATH", "gh")
    proc = subprocess.run(
        [gh, "api", endpoint],
        capture_output=True,
        text=True,
        timeout=60,
        shell=False,
        check=False,
    )
    if proc.returncode != 0:
        raise GateError(
            f"gh api {endpoint.split('?')[0]} failed with exit {proc.returncode}"
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:  # pragma: no cover - defensive
        raise GateError(f"gh api {endpoint.split('?')[0]} returned non-JSON") from exc


def _repo() -> str:
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise GateError("GITHUB_REPOSITORY missing or malformed")
    return repo


def _is_cross_repository(pr: dict) -> bool:
    """Compare head vs base repository, by id when available, else full name."""
    head_repo = pr.get("head", {}).get("repo") or {}
    base_repo = pr.get("base", {}).get("repo") or {}
    head_id, base_id = head_repo.get("id"), base_repo.get("id")
    if isinstance(head_id, int) and isinstance(base_id, int):
        return head_id != base_id
    head_name = str(head_repo.get("full_name") or "").lower()
    base_name = str(base_repo.get("full_name") or "").lower()
    if not head_name or not base_name:
        # A PR object without resolvable head/base repos is unusable for a
        # security decision — treat as same-repo (deny), never as fork.
        return False
    return head_name != base_name


def _has_label(pr: dict, label: str) -> bool:
    labels = pr.get("labels") or []
    return any(
        isinstance(entry, dict) and entry.get("name") == label for entry in labels
    )


def _validated_head_sha(pr: dict) -> str:
    sha = pr.get("head", {}).get("sha")
    if not isinstance(sha, str) or not SHA_RE.fullmatch(sha):
        raise GateError("PR head SHA missing or malformed; refusing to proceed")
    return sha


def _validated_pr_number(pr: dict) -> int:
    number = pr.get("number")
    if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
        raise GateError("PR number missing or malformed; refusing to proceed")
    return number


def _fetch_pr(repo: str, pr_number: int) -> dict:
    pr = gh_api(f"repos/{repo}/pulls/{pr_number}")
    if not isinstance(pr, dict):
        raise GateError("PR lookup returned a non-object payload")
    return pr


def _associated_prs(repo: str, head_sha: str) -> list:
    pulls = gh_api(f"repos/{repo}/commits/{head_sha}/pulls")
    if not isinstance(pulls, list):
        raise GateError("commits/{sha}/pulls returned a non-array payload")
    return [pr for pr in pulls if isinstance(pr, dict)]


def _decide(pr: dict, label: str, expected_head_sha: str | None) -> tuple[bool, str, int, str]:
    """Shared decision core. Returns (proceed, reason, pr_number, head_sha)."""
    if pr.get("state") != "open":
        return False, REASON_NOT_OPEN, 0, ""
    if not _is_cross_repository(pr):
        return False, REASON_NOT_FORK, 0, ""
    if not _has_label(pr, label):
        return False, REASON_NOT_AUTHORIZED, 0, ""
    head_sha = _validated_head_sha(pr)
    pr_number = _validated_pr_number(pr)
    if expected_head_sha is not None and head_sha != expected_head_sha:
        return False, REASON_STALE_HEAD, 0, ""
    return True, "", pr_number, head_sha


def _write_outputs(proceed: bool, reason: str, pr_number: int, head_sha: str) -> None:
    lines = [
        f"proceed={'true' if proceed else 'false'}",
        f"reason={reason}",
        f"pr_number={pr_number if proceed else ''}",
        f"head_sha={head_sha if proceed else ''}",
    ]
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as handle:
            for line in lines:
                handle.write(line + "\n")
    else:
        for line in lines:
            print(line)


def _notice(message: str) -> None:
    # Static decision text only — untrusted PR content never reaches this.
    print(f"::notice title=Fork AI review gate::{message}", file=sys.stderr)


def run_gate(event_file: str, label: str) -> int:
    try:
        with open(event_file, encoding="utf-8") as handle:
            event = json.load(handle)
        if not isinstance(event, dict):
            raise GateError("event payload is not a JSON object")
    except (OSError, json.JSONDecodeError) as exc:
        raise GateError(f"cannot read event payload: {exc}") from exc

    repo = _repo()
    workflow_run = event.get("workflow_run")
    if isinstance(workflow_run, dict):
        # workflow_run mode: the triggering CI run completed.
        if workflow_run.get("event") != "pull_request":
            _notice(f"skip: {REASON_NOT_PR_RUN}")
            _write_outputs(False, REASON_NOT_PR_RUN, 0, "")
            return 0
        if workflow_run.get("conclusion") not in ("success", "failure"):
            _notice(f"skip: {REASON_UNSUPPORTED_CONCLUSION}")
            _write_outputs(False, REASON_UNSUPPORTED_CONCLUSION, 0, "")
            return 0
        head_sha = workflow_run.get("head_sha")
        if not isinstance(head_sha, str) or not SHA_RE.fullmatch(head_sha):
            _notice(f"skip: {REASON_BAD_HEAD_SHA}")
            _write_outputs(False, REASON_BAD_HEAD_SHA, 0, "")
            return 0

        candidates = []
        for pr in _associated_prs(repo, head_sha):
            number = pr.get("number")
            if isinstance(number, int) and not isinstance(number, bool) and number > 0:
                candidates.append(number)
        # Resolve each candidate against fresh API state (the association
        # endpoint's objects can lag); then apply the shared decision core.
        authorized: list[tuple[int, str]] = []
        saw_other_reason = ""
        for number in candidates:
            pr = _fetch_pr(repo, number)
            proceed, reason, pr_number, sha = _decide(pr, label, expected_head_sha=head_sha)
            if proceed:
                authorized.append((pr_number, sha))
            elif reason != REASON_NOT_AUTHORIZED:
                # A candidate PR exists for this head but is not reviewable
                # (superseded head / closed / same-repo). Prefer reporting
                # that specific reason over the generic label reason; a
                # newer CI completion owns superseded heads.
                saw_other_reason = reason
        if not authorized:
            reason = saw_other_reason or REASON_NOT_AUTHORIZED
            _notice(f"skip: {reason}")
            _write_outputs(False, reason, 0, "")
            return 0
        if len(authorized) > 1:
            _notice(f"skip: {REASON_AMBIGUOUS}")
            _write_outputs(False, REASON_AMBIGUOUS, 0, "")
            return 0
        pr_number, sha = authorized[0]
        _write_outputs(True, "", pr_number, sha)
        return 0

    pull_request = event.get("pull_request")
    if isinstance(pull_request, dict):
        # pull_request_target labeled mode: a maintainer added the label.
        if event.get("action") != "labeled" or event.get("label", {}).get("name") != label:
            _notice(f"skip: {REASON_NOT_AUTHORIZED}")
            _write_outputs(False, REASON_NOT_AUTHORIZED, 0, "")
            return 0
        number = pull_request.get("number")
        if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
            _notice(f"skip: {REASON_BAD_PR_NUMBER}")
            _write_outputs(False, REASON_BAD_PR_NUMBER, 0, "")
            return 0
        # Authorization always comes from fresh API state, never from the
        # event payload.
        pr = _fetch_pr(repo, number)
        proceed, reason, pr_number, sha = _decide(pr, label, expected_head_sha=None)
        if not proceed:
            _notice(f"skip: {reason}")
            _write_outputs(False, reason, 0, "")
            return 0
        _write_outputs(True, "", pr_number, sha)
        return 0

    raise GateError("event payload carries neither workflow_run nor pull_request")


def run_verify(pr_number: int, expected_sha: str, label: str) -> int:
    repo = _repo()
    try:
        pr = _fetch_pr(repo, pr_number)
    except GateError:
        print(
            "ERROR: could not re-fetch the PR before spending model compute; "
            "refusing to proceed.",
            file=sys.stderr,
        )
        return 2
    if pr.get("state") != "open":
        print("ERROR: PR is no longer open; refusing to proceed.", file=sys.stderr)
        return 3
    if not _is_cross_repository(pr):
        print("ERROR: PR is no longer cross-repository; refusing to proceed.", file=sys.stderr)
        return 3
    if not _has_label(pr, label):
        print(
            f"ERROR: the '{label}' label is no longer present; refusing to proceed.",
            file=sys.stderr,
        )
        return 3
    current_sha = pr.get("head", {}).get("sha")
    if not isinstance(current_sha, str) or not SHA_RE.fullmatch(current_sha):
        print("ERROR: current head SHA unusable; refusing to proceed.", file=sys.stderr)
        return 2
    if current_sha != expected_sha:
        print(
            f"ERROR: PR head advanced past reviewed commit {expected_sha}; "
            "not reviewing a superseded head.",
            file=sys.stderr,
        )
        return 3
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    gate = sub.add_parser("gate", help="decide whether the fork review may run")
    gate.add_argument("--event-file", default=os.environ.get("GITHUB_EVENT_PATH", ""))
    gate.add_argument("--label", default=LABEL_DEFAULT)

    verify = sub.add_parser("verify", help="re-verify head SHA before model work")
    verify.add_argument("--pr-number", type=int, required=True)
    verify.add_argument("--expected-sha", required=True)
    verify.add_argument("--label", default=LABEL_DEFAULT)

    args = parser.parse_args(argv)

    if args.command == "gate":
        if not args.event_file:
            raise GateError("no event payload available (--event-file or GITHUB_EVENT_PATH)")
        if not LABEL_RE.fullmatch(args.label):
            raise GateError("label name malformed")
        return run_gate(args.event_file, args.label)

    if not SHA_RE.fullmatch(args.expected_sha):
        raise GateError("--expected-sha must be a 40-hex commit SHA")
    if not LABEL_RE.fullmatch(args.label):
        raise GateError("label name malformed")
    return run_verify(args.pr_number, args.expected_sha, args.label)


def cli() -> int:
    try:
        return main()
    except GateError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(cli())
