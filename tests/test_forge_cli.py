"""Unit tests for ``scripts/forge_cli.py`` and its forge-capability seam.

The CLI adapter is the single place the operational tooling talks to the
forge. These tests pin the properties every caller depends on:

- every command makes exactly the documented request (method, path, body)
  and nothing else;
- the token rides only the ``Authorization`` header -- never the URL, the
  path, the query or the body;
- a hostile forge that reflects the token back cannot make the CLI echo
  it into stdout or stderr;
- malformed input is rejected before any request goes out (fail closed);
- the CLI never spawns a subprocess and never shells out to a forge CLI
  binary, even when one is on ``PATH``;
- no forge CLI invocation survives anywhere in the operational tooling,
  and no raw HTTP client (curl/wget) reaches the forge API there either
  (the guard tests at the end of this file pin that going forward).

No real network: the requests go to an in-process stub server
(``tests/_lib/forge_stub_server.py``).
"""

from __future__ import annotations

import ast
import contextlib
import io
import json
import os
import re
import stat
import subprocess
import sys
import threading
import tokenize
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
_LIB = Path(__file__).resolve().parent / "_lib"
CLI_PATH = ROOT / "scripts" / "forge_cli.py"
SECRET = "token-that-must-never-leak"

if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from forge_stub_server import ForgeStubServer  # noqa: E402


def _load_cli():
    """Import ``scripts/forge_cli.py`` as a module, without touching PATH."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("forge_cli_under_test", CLI_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def cli():
    return _load_cli()


@pytest.fixture()
def stub(monkeypatch):
    server = ForgeStubServer().start()
    monkeypatch.setenv("GITHUB_API_URL", server.base_url)
    monkeypatch.setenv("GITHUB_TOKEN", SECRET)
    monkeypatch.delenv("GH_TOKEN", raising=False)
    try:
        yield server
    finally:
        server.stop()


def run(cli, *args: str) -> tuple[int, str, str]:
    """Run the CLI in-process; return (exit code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = cli.cli(list(args))
    return code, out.getvalue(), err.getvalue()


def only_request(stub: ForgeStubServer) -> dict:
    assert len(stub.requests) == 1, stub.requests
    return stub.requests[0]


# ---------------------------------------------------------------------------
# pr-details
# ---------------------------------------------------------------------------


def _pr_payload(*, sha: str = "a" * 40, repo_id: int = 1234, draft: bool = False) -> dict:
    """The shape of the pull-request read the capability answers with."""
    return {
        "number": 42,
        "draft": draft,
        "head": {"sha": sha, "repo": {"id": repo_id}},
    }


class _PullRequestForge:
    """A one-endpoint forge stub for the pull-request read.

    The shared stub (``tests/_lib/forge_stub_server.py``) serves the
    commit, label, release and ref endpoints only, so the pull-request
    read gets its own tiny server: it answers
    ``GET /repos/{owner}/{repo}/pulls/{number}`` with a configurable
    payload and records the request it saw (method, path, query, headers).
    """

    def __init__(self, payload: dict, *, status: int = 200) -> None:
        self.payload = payload
        self.status = status
        self.requests: list[dict] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> "_PullRequestForge":
        forge = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args) -> None:  # noqa: ANN001
                """Keep the stub quiet."""

            def do_GET(self) -> None:  # noqa: N802
                parsed = urllib.parse.urlsplit(self.path)
                forge.requests.append({
                    "method": "GET",
                    "path": parsed.path,
                    "query": parsed.query,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                })
                body = json.dumps(forge.payload).encode("utf-8")
                self.send_response(forge.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    @property
    def base_url(self) -> str:
        if self._server is None:
            raise RuntimeError("the stub server is not running")
        return f"http://127.0.0.1:{self._server.server_port}"

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None


@pytest.fixture()
def pr_forge(monkeypatch):
    """A one-endpoint forge that answers the pull-request read."""
    forge = _PullRequestForge(_pr_payload()).start()
    monkeypatch.setenv("GITHUB_API_URL", forge.base_url)
    monkeypatch.setenv("GITHUB_TOKEN", SECRET)
    monkeypatch.delenv("GH_TOKEN", raising=False)
    try:
        yield forge
    finally:
        forge.stop()


class TestPrDetails:
    def test_prints_the_three_documented_lines(self, cli, pr_forge):
        pr_forge.payload = _pr_payload()
        code, out, err = run(cli, "pr-details", "--repo", "o/r", "--number", "42")
        assert code == 0
        assert out == f"head_sha={'a' * 40}\nhead_repo_id=1234\nis_draft=false\n"
        assert err == ""
        assert len(pr_forge.requests) == 1
        request = pr_forge.requests[0]
        assert request["method"] == "GET"
        assert request["path"] == "/repos/o/r/pulls/42"
        assert request["query"] == ""

    def test_the_token_rides_only_the_authorization_header(self, cli, pr_forge):
        pr_forge.payload = _pr_payload()
        run(cli, "pr-details", "--repo", "o/r", "--number", "42")
        request = pr_forge.requests[0]
        assert request["headers"].get("authorization") == f"Bearer {SECRET}"
        assert SECRET not in request["path"]
        assert SECRET not in request["query"]

    def test_a_draft_pull_request_is_reported(self, cli, pr_forge):
        pr_forge.payload = _pr_payload(draft=True)
        code, out, err = run(cli, "pr-details", "--repo", "o/r", "--number", "42")
        assert code == 0
        assert out.endswith("is_draft=true\n")

    def test_a_fork_head_reports_the_head_repository_id(self, cli, pr_forge):
        # The caller compares the head repository id with the base
        # repository id to tell a fork from a same-repository pull request.
        pr_forge.payload = _pr_payload(repo_id=999)
        code, out, err = run(cli, "pr-details", "--repo", "o/r", "--number", "42")
        assert code == 0
        assert "head_repo_id=999" in out

    def test_an_absent_pull_request_is_exit_one(self, cli, pr_forge):
        pr_forge.payload = {"message": "Not Found"}
        pr_forge.status = 404
        code, out, err = run(cli, "pr-details", "--repo", "o/r", "--number", "42")
        assert code == 1
        assert out == ""
        assert err == ""

    def test_a_forge_failure_is_exit_two(self, cli, pr_forge):
        pr_forge.payload = {"message": "boom"}
        pr_forge.status = 500
        code, out, err = run(cli, "pr-details", "--repo", "o/r", "--number", "42")
        assert code == 2
        assert out == ""
        assert SECRET not in err

    def test_an_unusable_response_is_exit_two(self, cli, pr_forge):
        # No head at all: the read fails closed instead of guessing.
        pr_forge.payload = {"number": 42, "draft": False}
        code, out, err = run(cli, "pr-details", "--repo", "o/r", "--number", "42")
        assert code == 2
        assert out == ""
        assert SECRET not in err

    def test_a_forged_head_sha_is_refused(self, cli, pr_forge):
        pr_forge.payload = _pr_payload(sha="not-a-sha")
        code, out, err = run(cli, "pr-details", "--repo", "o/r", "--number", "42")
        assert code == 2
        assert out == ""

    def test_a_hostile_forge_cannot_reflect_the_token_into_the_output(self, cli, pr_forge, monkeypatch):
        # The head sha is shape-validated, so a hex token passes the shape
        # check: the credential gate is what refuses it.
        token = "d" * 40
        monkeypatch.setenv("GITHUB_TOKEN", token)
        pr_forge.payload = _pr_payload(sha=token)
        code, out, err = run(cli, "pr-details", "--repo", "o/r", "--number", "42")
        assert code == 2
        assert out == ""
        assert token not in err

    def test_a_numeric_token_reflected_as_the_head_repo_id_is_refused(self, cli, pr_forge, monkeypatch):
        # The head repository id is an integer, so a numeric token is the
        # only shape a hostile forge can reflect through it.
        monkeypatch.setenv("GITHUB_TOKEN", "1234")
        pr_forge.payload = _pr_payload(repo_id=1234)
        code, out, err = run(cli, "pr-details", "--repo", "o/r", "--number", "42")
        assert code == 2
        assert out == ""
        assert "1234" not in err


# ---------------------------------------------------------------------------
# pr-number-for-commit
# ---------------------------------------------------------------------------


class TestPrNumberForCommit:
    def test_reads_the_first_pull_request_number(self, cli, stub):
        sha = "a" * 40
        stub.set_state(commit_pulls={sha: 42})
        code, out, err = run(cli, "pr-number-for-commit", "--repo", "o/r", "--sha", sha)
        assert code == 0
        assert out == "42\n"
        assert err == ""
        request = only_request(stub)
        assert request["method"] == "GET"
        assert request["path"] == f"/repos/o/r/commits/{sha}/pulls"

    def test_no_pull_request_is_exit_one_and_no_output(self, cli, stub):
        code, out, err = run(
            cli, "pr-number-for-commit", "--repo", "o/r", "--sha", "b" * 40
        )
        assert code == 1
        assert out == ""
        assert err == ""
        assert only_request(stub)["method"] == "GET"

    def test_a_forge_failure_is_exit_two(self, cli, stub):
        stub.set_state(fail_paths=["/commits/"])
        code, out, err = run(
            cli, "pr-number-for-commit", "--repo", "o/r", "--sha", "c" * 40
        )
        assert code == 2
        assert out == ""
        assert SECRET not in err


# ---------------------------------------------------------------------------
# issue-labels / set-issue-labels
# ---------------------------------------------------------------------------


class TestIssueLabels:
    def test_prints_one_label_name_per_line(self, cli, stub):
        stub.set_state(labels={"42": ["autorelease: pending", "bug"]})
        code, out, err = run(cli, "issue-labels", "--repo", "o/r", "--number", "42")
        assert code == 0
        assert out == "autorelease: pending\nbug\n"
        assert err == ""
        request = only_request(stub)
        assert request["method"] == "GET"
        assert request["path"] == "/repos/o/r/issues/42/labels"

    def test_no_labels_is_success_and_no_output(self, cli, stub):
        stub.set_state(labels={})
        code, out, err = run(cli, "issue-labels", "--repo", "o/r", "--number", "42")
        assert code == 0
        assert out == ""

    def test_a_label_name_with_a_line_break_fails_the_read_closed(self, cli, stub):
        # The names are read line by line: a name carrying a line break would
        # answer a comparison the caller makes, so the read fails instead.
        stub.set_state(labels={"42": ["autorelease: pending\nautorelease: tagged"]})
        code, out, err = run(cli, "issue-labels", "--repo", "o/r", "--number", "42")
        assert code == 2
        assert out == ""
        assert "autorelease" not in err


class TestSetIssueLabels:
    def test_removes_first_then_adds(self, cli, stub):
        stub.set_state(labels={"42": ["autorelease: pending"]})
        code, out, err = run(
            cli,
            "set-issue-labels",
            "--repo",
            "o/r",
            "--number",
            "42",
            "--remove",
            "autorelease: pending",
            "--add",
            "autorelease: tagged",
        )
        assert code == 0
        assert out == ""
        assert err == ""
        assert [(r["method"], r["path"]) for r in stub.requests] == [
            ("DELETE", "/repos/o/r/issues/42/labels/autorelease%3A%20pending"),
            ("POST", "/repos/o/r/issues/42/labels"),
        ]
        assert json.loads(stub.requests[1]["body"]) == {"labels": ["autorelease: tagged"]}
        assert stub.state["labels"]["42"] == ["autorelease: tagged"]

    def test_a_missing_label_on_delete_is_not_an_error(self, cli, stub):
        stub.set_state(labels={"42": []})
        code, out, err = run(
            cli,
            "set-issue-labels",
            "--repo",
            "o/r",
            "--number",
            "42",
            "--remove",
            "autorelease: pending",
        )
        assert code == 0
        assert err == ""
        assert [r["method"] for r in stub.requests] == ["DELETE"]

    def test_no_add_and_no_remove_makes_no_request(self, cli, stub):
        code, out, err = run(cli, "set-issue-labels", "--repo", "o/r", "--number", "42")
        assert code == 0
        assert stub.requests == []

    def test_a_forge_failure_on_delete_is_exit_two(self, cli, stub):
        stub.set_state(fail_paths=["/labels/"])
        code, out, err = run(
            cli,
            "set-issue-labels",
            "--repo",
            "o/r",
            "--number",
            "42",
            "--remove",
            "bug",
        )
        assert code == 2
        assert SECRET not in err


# ---------------------------------------------------------------------------
# release-exists / release-create
# ---------------------------------------------------------------------------


class TestReleaseExists:
    def test_an_existing_release_is_exit_zero(self, cli, stub):
        stub.set_state(releases=["v1.2.3"])
        code, out, err = run(cli, "release-exists", "--repo", "o/r", "--tag", "v1.2.3")
        assert code == 0
        assert only_request(stub)["path"] == "/repos/o/r/releases/tags/v1.2.3"

    def test_an_absent_release_is_exit_one(self, cli, stub):
        stub.set_state(releases=[])
        code, out, err = run(cli, "release-exists", "--repo", "o/r", "--tag", "v1.2.3")
        assert code == 1
        assert err == ""

    def test_any_other_failure_is_exit_two(self, cli, stub):
        stub.set_state(fail_paths=["/releases/"])
        code, out, err = run(cli, "release-exists", "--repo", "o/r", "--tag", "v1.2.3")
        assert code == 2
        assert err != ""


class TestReleaseCreate:
    def test_posts_the_documented_payload(self, cli, stub, tmp_path):
        notes = tmp_path / "notes.md"
        notes.write_text("the notes\n", encoding="utf-8")
        stub.set_state(releases=[])
        code, out, err = run(
            cli,
            "release-create",
            "--repo",
            "o/r",
            "--tag",
            "v1.2.3",
            "--title",
            "v1.2.3",
            "--notes-file",
            str(notes),
            "--generate-notes",
            "--prerelease",
        )
        assert code == 0
        assert err == ""
        assert out == "", "nothing from the forge response is printed"
        request = only_request(stub)
        assert request["method"] == "POST"
        assert request["path"] == "/repos/o/r/releases"
        assert json.loads(request["body"]) == {
            "tag_name": "v1.2.3",
            "name": "v1.2.3",
            "body": "the notes\n",
            "prerelease": True,
            "generate_release_notes": True,
        }

    def test_verify_tag_reads_the_ref_first(self, cli, stub):
        stub.set_state(releases=[], tag_refs={"v1.2.3": "d" * 40})
        code, out, err = run(
            cli,
            "release-create",
            "--repo",
            "o/r",
            "--tag",
            "v1.2.3",
            "--verify-tag",
        )
        assert code == 0
        assert [(r["method"], r["path"]) for r in stub.requests] == [
            ("GET", "/repos/o/r/git/ref/tags/v1.2.3"),
            ("POST", "/repos/o/r/releases"),
        ]

    def test_verify_tag_fails_when_the_tag_is_absent(self, cli, stub):
        stub.set_state(releases=[], tag_refs={})
        code, out, err = run(
            cli,
            "release-create",
            "--repo",
            "o/r",
            "--tag",
            "v1.2.3",
            "--verify-tag",
        )
        assert code == 2
        assert [r["method"] for r in stub.requests] == ["GET"]

    def test_a_missing_notes_file_is_an_error(self, cli, stub, tmp_path):
        stub.set_state(releases=[])
        code, out, err = run(
            cli,
            "release-create",
            "--repo",
            "o/r",
            "--tag",
            "v1.2.3",
            "--notes-file",
            str(tmp_path / "nope.md"),
        )
        assert code == 2
        assert stub.requests == []
        assert SECRET not in err


# ---------------------------------------------------------------------------
# pr-number-for-branch / pr-create
# ---------------------------------------------------------------------------


class TestPrNumberForBranch:
    def test_reads_the_open_pull_request(self, cli, stub):
        stub.set_state(open_prs={"bot/harvest-human-findings": 7})
        code, out, err = run(
            cli, "pr-number-for-branch", "--repo", "o/r", "--branch", "bot/harvest-human-findings"
        )
        assert code == 0
        assert out == "7\n"
        request = only_request(stub)
        assert request["method"] == "GET"
        assert request["path"] == "/repos/o/r/pulls"
        assert "state=open" in request["query"]
        assert "head=o%3Abot%2Fharvest-human-findings" in request["query"]

    def test_no_open_pull_request_is_exit_one(self, cli, stub):
        stub.set_state(open_prs={})
        code, out, err = run(
            cli, "pr-number-for-branch", "--repo", "o/r", "--branch", "bot/x"
        )
        assert code == 1
        assert out == ""


class TestPrCreate:
    def test_posts_the_documented_payload(self, cli, stub):
        stub.set_state(next_pr_number=123)
        code, out, err = run(
            cli,
            "pr-create",
            "--repo",
            "o/r",
            "--head",
            "bot/x",
            "--base",
            "main",
            "--title",
            "the title",
            "--body",
            "the body",
        )
        assert code == 0
        assert out == "123\n", "only the validated pull request number is printed"
        request = only_request(stub)
        assert request["method"] == "POST"
        assert request["path"] == "/repos/o/r/pulls"
        assert json.loads(request["body"]) == {
            "title": "the title",
            "head": "bot/x",
            "base": "main",
            "body": "the body",
        }


# ---------------------------------------------------------------------------
# tag-ref-sha / commit-parent-sha
# ---------------------------------------------------------------------------


class TestTagRefSha:
    def test_reads_the_tag_object_sha(self, cli, stub):
        stub.set_state(tag_refs={"v1.2.3": "e" * 40})
        code, out, err = run(cli, "tag-ref-sha", "--repo", "o/r", "--tag", "v1.2.3")
        assert code == 0
        assert out == f"{'e' * 40}\n"
        assert only_request(stub)["path"] == "/repos/o/r/git/ref/tags/v1.2.3"

    def test_an_absent_ref_is_exit_one(self, cli, stub):
        stub.set_state(tag_refs={})
        code, out, err = run(cli, "tag-ref-sha", "--repo", "o/r", "--tag", "v1.2.3")
        assert code == 1
        assert out == ""

    def test_a_non_hex_forged_sha_fails_closed(self, cli, stub):
        stub.set_state(tag_refs={"v1.2.3": "not-a-sha"})
        code, out, err = run(cli, "tag-ref-sha", "--repo", "o/r", "--tag", "v1.2.3")
        assert code == 2
        assert out == ""


class TestCommitParentSha:
    def test_reads_the_first_parent(self, cli, stub):
        sha = "1" * 40
        stub.set_state(commit_parents={sha: "2" * 40})
        code, out, err = run(cli, "commit-parent-sha", "--repo", "o/r", "--sha", sha)
        assert code == 0
        assert out == f"{'2' * 40}\n"
        assert only_request(stub)["path"] == f"/repos/o/r/git/commits/{sha}"

    def test_a_root_commit_prints_nothing_and_succeeds(self, cli, stub):
        sha = "3" * 40
        stub.set_state(commit_parents={sha: ""})
        code, out, err = run(cli, "commit-parent-sha", "--repo", "o/r", "--sha", sha)
        assert code == 0
        assert out == ""

    def test_an_unknown_commit_is_exit_two(self, cli, stub):
        code, out, err = run(
            cli, "commit-parent-sha", "--repo", "o/r", "--sha", "4" * 40
        )
        assert code == 2
        assert out == ""


# ---------------------------------------------------------------------------
# Credential handling
# ---------------------------------------------------------------------------


class TestTokenNeverLeaks:
    def test_the_token_rides_only_the_authorization_header(self, cli, stub):
        sha = "5" * 40
        stub.set_state(commit_pulls={sha: 42}, labels={"42": ["bug"]})
        run(cli, "pr-number-for-commit", "--repo", "o/r", "--sha", sha)
        run(cli, "issue-labels", "--repo", "o/r", "--number", "42")
        for request in stub.requests:
            assert request["headers"].get("authorization") == f"Bearer {SECRET}"
            assert SECRET not in request["path"]
            assert SECRET not in request["query"]
            assert SECRET not in request["body"]

    def test_a_hostile_forge_cannot_reflect_the_token_into_the_output(self, cli, stub):
        stub.set_state(fail_paths=["/commits/"], reflect_token=True)
        code, out, err = run(
            cli, "pr-number-for-commit", "--repo", "o/r", "--sha", "6" * 40
        )
        assert code == 2
        assert SECRET not in out
        assert SECRET not in err

    def test_a_hostile_forge_cannot_reflect_the_token_through_a_created_url(self, cli, stub):
        # The forge answers a successful create with a URL that carries the
        # credential it was given. The adapter prints nothing it did not
        # validate itself, so the reflected token reaches no log.
        stub.set_state(releases=[], reflect_token=True)
        code, out, err = run(
            cli, "release-create", "--repo", "o/r", "--tag", "v1.2.3"
        )
        assert code == 0
        assert SECRET not in out
        assert SECRET not in err
        stub.set_state(reflect_token=True)
        code, out, err = run(
            cli,
            "pr-create",
            "--repo",
            "o/r",
            "--head",
            "bot/x",
            "--base",
            "main",
            "--title",
            "t",
            "--body",
            "b",
        )
        assert code == 0
        assert SECRET not in out
        assert SECRET not in err

    def test_the_cli_accepts_no_token_argument(self, cli, stub):
        code, out, err = run(
            cli, "issue-labels", "--repo", "o/r", "--number", "42", "--token", SECRET
        )
        assert code == 2
        assert SECRET not in out, "a rejected credential must not be echoed"
        assert SECRET not in err, "a rejected credential must not be echoed"

    def test_a_hostile_label_cannot_reflect_the_token_into_the_output(self, cli, stub):
        # A hostile forge answers a *successful* label read with the
        # credential itself as the label name. The read fails closed
        # instead of printing a forge-controlled string that carries it.
        stub.set_state(labels={"42": [SECRET]})
        code, out, err = run(cli, "issue-labels", "--repo", "o/r", "--number", "42")
        assert code == 2
        assert out == ""
        assert SECRET not in err

    def test_labels_printed_before_a_hostile_one_still_reach_stdout(self, cli, stub):
        stub.set_state(labels={"42": ["bug", SECRET]})
        code, out, err = run(cli, "issue-labels", "--repo", "o/r", "--number", "42")
        assert code == 2
        assert out == "bug\n"
        assert SECRET not in out
        assert SECRET not in err

    def test_a_hostile_tag_sha_cannot_reflect_the_token_into_the_output(self, cli, stub):
        # The printed SHA is validated to the commit-ish shape first, so a
        # forge-controlled string carrying the credential is unusable.
        stub.set_state(tag_refs={"v1.2.3": SECRET})
        code, out, err = run(cli, "tag-ref-sha", "--repo", "o/r", "--tag", "v1.2.3")
        assert code == 2
        assert out == ""
        assert SECRET not in err

    def test_a_hostile_parent_sha_cannot_reflect_the_token_into_the_output(self, cli, stub):
        sha = "7" * 40
        stub.set_state(commit_parents={sha: SECRET})
        code, out, err = run(cli, "commit-parent-sha", "--repo", "o/r", "--sha", sha)
        assert code == 2
        assert out == ""
        assert SECRET not in err

    def test_a_malformed_status_line_cannot_reflect_the_token_into_the_output(self, cli, stub):
        # A hostile forge answers with a status line it forged, and it puts
        # the credential it read from the Authorization header into that
        # line. The transport must refuse the response: the forged line
        # must not reach the log as a traceback, and the refusal must be
        # the fixed error string, not the forge's own bytes.
        stub.set_state(malformed_status_paths=["/git/ref/tags/"])
        code, out, err = run(cli, "tag-ref-sha", "--repo", "o/r", "--tag", "v1.2.3")
        assert code == 2
        assert out == ""
        assert SECRET not in err
        assert "Traceback" not in err, "the refusal must be an error, not a traceback"

    def test_a_label_containing_the_token_is_refused(self, cli, stub, monkeypatch):
        # Containment, not equality, on the label path: the token is a
        # substring of the label, so the label must be refused.
        monkeypatch.setenv("GITHUB_TOKEN", "42")
        stub.set_state(labels={"42": ["x42y"]})
        code, out, err = run(cli, "issue-labels", "--repo", "o/r", "--number", "42")
        assert code == 2
        assert out == ""
        assert "42" not in err

    def test_a_sha_containing_the_token_is_refused(self, cli, stub, monkeypatch):
        # Containment, not equality, on the SHA path: the token is a
        # substring of a well-formed SHA, so the SHA must be refused.
        token = "deadbeef"
        monkeypatch.setenv("GITHUB_TOKEN", token)
        sha = token + "a" * 32
        stub.set_state(tag_refs={"v1.2.3": sha})
        code, out, err = run(cli, "tag-ref-sha", "--repo", "o/r", "--tag", "v1.2.3")
        assert code == 2
        assert out == ""
        assert token not in err

    def test_a_hex_token_reflected_as_a_tag_sha_is_refused(self, cli, stub, monkeypatch):
        # Shape validation alone proves nothing when the configured token
        # is itself 40-hex: the forge's "SHA" passes SHA_RE, so the
        # credential gate is what refuses it.
        hex_token = "d" * 40
        monkeypatch.setenv("GITHUB_TOKEN", hex_token)
        stub.set_state(tag_refs={"v1.2.3": hex_token})
        code, out, err = run(cli, "tag-ref-sha", "--repo", "o/r", "--tag", "v1.2.3")
        assert code == 2
        assert out == ""
        assert hex_token not in err

    def test_a_hex_token_reflected_as_a_parent_sha_is_refused(self, cli, stub, monkeypatch):
        hex_token = "e" * 64
        sha = "7" * 40
        monkeypatch.setenv("GITHUB_TOKEN", hex_token)
        stub.set_state(commit_parents={sha: hex_token})
        code, out, err = run(cli, "commit-parent-sha", "--repo", "o/r", "--sha", sha)
        assert code == 2
        assert out == ""
        assert hex_token not in err

    def test_a_numeric_token_reflected_as_a_pr_number_is_refused(self, cli, stub, monkeypatch):
        # A purely numeric configured token survives the integer shape
        # check the same way a hex one survives the SHA shape check.
        sha = "a" * 40
        monkeypatch.setenv("GITHUB_TOKEN", "42")
        stub.set_state(commit_pulls={sha: 42})
        code, out, err = run(cli, "pr-number-for-commit", "--repo", "o/r", "--sha", sha)
        assert code == 2
        assert out == ""
        assert "42" not in err

    def test_a_numeric_token_reflected_inside_a_larger_pr_number_is_refused(
        self, cli, stub, monkeypatch
    ):
        # The gate is containment, not equality: a hostile forge picks the
        # number it reports, so a partial reflection of a numeric token
        # must fail too.
        sha = "a" * 40
        monkeypatch.setenv("GITHUB_TOKEN", "42")
        stub.set_state(commit_pulls={sha: 142})
        code, out, err = run(cli, "pr-number-for-commit", "--repo", "o/r", "--sha", sha)
        assert code == 2
        assert out == ""
        assert "42" not in err

    def test_a_numeric_token_reflected_as_a_branch_pr_number_is_refused(
        self, cli, stub, monkeypatch
    ):
        monkeypatch.setenv("GITHUB_TOKEN", "42")
        stub.set_state(open_prs={"bot/x": 42})
        code, out, err = run(
            cli, "pr-number-for-branch", "--repo", "o/r", "--branch", "bot/x"
        )
        assert code == 2
        assert out == ""
        assert "42" not in err

    def test_a_numeric_token_reflected_as_a_created_pr_number_is_refused(
        self, cli, stub, monkeypatch
    ):
        # The create response's number is forge-supplied like the reads':
        # the stub hands out 900, so here the hostile forge returns the
        # numeric token itself as the created pull request's number.
        monkeypatch.setenv("GITHUB_TOKEN", "900")
        code, out, err = run(
            cli,
            "pr-create",
            "--repo",
            "o/r",
            "--head",
            "bot/x",
            "--base",
            "main",
            "--title",
            "t",
            "--body",
            "b",
        )
        assert code == 2
        assert out == ""
        assert "900" not in err

    def test_values_still_print_when_no_credential_is_configured(self, cli, stub, monkeypatch):
        # The gate compares with the configured credential: with none
        # configured there is nothing to reflect, and printed reads work.
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.delenv("GH_TOKEN", raising=False)
        sha = "a" * 40
        stub.set_state(tag_refs={"v1.2.3": sha}, labels={"42": ["bug"]})
        code, out, err = run(cli, "tag-ref-sha", "--repo", "o/r", "--tag", "v1.2.3")
        assert code == 0
        assert out == f"{sha}\n"
        code, out, err = run(cli, "issue-labels", "--repo", "o/r", "--number", "42")
        assert code == 0
        assert out == "bug\n"

    def test_a_legitimate_tag_sha_still_prints_when_the_token_is_hex(self, cli, stub, monkeypatch):
        # The gate refuses the credential, not every hex value: a SHA that
        # is not the token prints normally even when the token is hex.
        monkeypatch.setenv("GITHUB_TOKEN", "d" * 40)
        sha = "a" * 40
        stub.set_state(tag_refs={"v1.2.3": sha})
        code, out, err = run(cli, "tag-ref-sha", "--repo", "o/r", "--tag", "v1.2.3")
        assert code == 0
        assert out == f"{sha}\n"
        assert err == ""


# ---------------------------------------------------------------------------
# Input validation (fail closed, before any request)
# ---------------------------------------------------------------------------


class TestInputValidation:
    @pytest.mark.parametrize(
        "args",
        [
            ("issue-labels", "--repo", "o/r/extra", "--number", "42"),
            ("issue-labels", "--repo", "no-slash", "--number", "42"),
            ("issue-labels", "--repo", "./r", "--number", "42"),
            ("issue-labels", "--repo", "../r", "--number", "42"),
            ("issue-labels", "--repo", "o/.", "--number", "42"),
            ("issue-labels", "--repo", "o/..", "--number", "42"),
            ("issue-labels", "--repo", "./..", "--number", "42"),
            ("issue-labels", "--repo", "o/r\n", "--number", "42"),
            ("issue-labels", "--repo", "o/r", "--number", "42\n"),
            ("issue-labels", "--repo", "o/r", "--number", "42 "),
            ("issue-labels", "--repo", "o/r", "--number", "0"),
            ("issue-labels", "--repo", "o/r", "--number", "-1"),
            ("issue-labels", "--repo", "o/r", "--number", "abc"),
            ("issue-labels", "--repo", "o/r", "--number", "9" * 21),
            ("issue-labels", "--repo", "o/r", "--number", "٤٢"),
            ("release-exists", "--repo", "o/r", "--tag", "v1 2"),
            ("release-exists", "--repo", "o/r", "--tag", "v1?x=1"),
            ("release-exists", "--repo", "o/r", "--tag", ".."),
            ("release-exists", "--repo", "o/r", "--tag", "v1/../v2"),
            ("release-exists", "--repo", "o/r", "--tag", "./v1"),
            ("pr-number-for-branch", "--repo", "o/r", "--branch", "bot x"),
            ("pr-number-for-commit", "--repo", "o/r", "--sha", "nothex"),
            ("pr-number-for-commit", "--repo", "o/r", "--sha", "A" * 40),
            ("pr-number-for-commit", "--repo", "o/r", "--sha", "a" * 41),
            ("commit-parent-sha", "--repo", "o/r", "--sha", "a" * 39),
            ("pr-details", "--repo", "o/r/extra", "--number", "42"),
            ("pr-details", "--repo", "no-slash", "--number", "42"),
            ("pr-details", "--repo", "o/r", "--number", "0"),
            ("pr-details", "--repo", "o/r", "--number", "-1"),
            ("pr-details", "--repo", "o/r", "--number", "abc"),
            ("pr-details", "--repo", "o/r", "--number", "42\n"),
            ("pr-details", "--repo", "o/r", "--number", "9" * 21),
        ],
    )
    def test_malformed_input_is_rejected_without_a_request(self, cli, stub, args):
        code, out, err = run(cli, *args)
        assert code == 2
        assert stub.requests == [], "no request may go out for a rejected input"
        assert SECRET not in err
        assert SECRET not in out

    def test_a_label_with_a_control_character_is_rejected(self, cli, stub):
        code, out, err = run(
            cli,
            "set-issue-labels",
            "--repo",
            "o/r",
            "--number",
            "42",
            "--add",
            "bad\nlabel",
        )
        assert code == 2
        assert stub.requests == []

    def test_a_label_with_a_space_is_accepted_and_encoded(self, cli, stub):
        stub.set_state(labels={})
        code, out, err = run(
            cli,
            "set-issue-labels",
            "--repo",
            "o/r",
            "--number",
            "42",
            "--remove",
            "autorelease: pending",
        )
        assert code == 0
        assert stub.requests[0]["path"].endswith("/labels/autorelease%3A%20pending")

    def test_a_64_hex_sha_is_accepted(self, cli, stub):
        sha = "a" * 64
        stub.set_state(commit_pulls={sha: 42})
        code, out, err = run(cli, "pr-number-for-commit", "--repo", "o/r", "--sha", sha)
        assert code == 0
        assert out == "42\n"


class TestAbsentIsReadFromTheStructuredStatus:
    def test_the_status_decides_absent_not_the_message(self, cli):
        from pr_reviewer.forge import ForgeError

        assert cli._is_not_found(ForgeError("forge GET /x returned HTTP 404", status=404))
        assert not cli._is_not_found(
            ForgeError("forge GET /x returned HTTP 404")
        ), "the message alone must not decide: the status rides on the error"
        assert not cli._is_not_found(ForgeError("forge GET /x unreachable: URLError"))
        assert not cli._is_not_found(ForgeError("forge redirected; refusing to follow"))


# ---------------------------------------------------------------------------
# No subprocess, no forge CLI binary
# ---------------------------------------------------------------------------


class TestNoSubprocessAndNoForgeCli:
    def test_the_module_imports_no_subprocess(self):
        source = CLI_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imported.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    imported.add(node.module.split(".")[0])
        assert "subprocess" not in imported, (
            "the CLI adapter must not spawn a subprocess; the forge "
            "capability is the only transport"
        )
        called = {
            node.func.attr
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        }
        assert not called & {"system", "popen", "spawnl", "spawnv", "execv", "execve"}

    def test_a_forge_cli_binary_on_path_is_never_invoked(self, stub, tmp_path):
        marker = tmp_path / "gh-was-called"
        fake = tmp_path / "bin"
        fake.mkdir()
        binary = fake / "gh"
        binary.write_text(f"#!/bin/sh\ntouch {marker}\nexit 0\n", encoding="utf-8")
        binary.chmod(binary.stat().st_mode | stat.S_IEXEC)
        env = dict(os.environ)
        env["PATH"] = f"{fake}:{env['PATH']}"
        env["GITHUB_API_URL"] = stub.base_url
        env["GITHUB_TOKEN"] = SECRET
        sha = "7" * 40
        stub.set_state(commit_pulls={sha: 42})
        result = subprocess.run(
            [
                sys.executable,
                str(CLI_PATH),
                "pr-number-for-commit",
                "--repo",
                "o/r",
                "--sha",
                sha,
            ],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert result.returncode == 0
        assert result.stdout == "42\n"
        assert not marker.exists(), "the CLI must never invoke a forge CLI binary"
        assert stub.requests, "the real request still went to the configured forge"


# ---------------------------------------------------------------------------
# Guard: no forge CLI invocations left in the operational tooling
# ---------------------------------------------------------------------------

# A forge CLI invocation: the binary, then one of its subcommands.
_GH_CALL_RE = re.compile(r"(?<![\w.-])gh\s+([a-z][a-z-]*)\b")
# The same thing written as an argv list, e.g. ``["gh", "api", ...]``.
_GH_ARGV_RE = re.compile(
    r"['\"]gh['\"]\s*,\s*['\"]([a-z][a-z-]*)['\"]"
)

# The forge CLI subcommands that read or write forge state. ``auth`` is in
# the list: the one retained call is allow-listed below by its exact line,
# so any other ``gh auth ...`` invocation is flagged.
_FORGE_SUBCOMMANDS = frozenset(
    {
        "api",
        "auth",
        "cache",
        "gist",
        "issue",
        "label",
        "pr",
        "release",
        "repo",
        "ruleset",
        "run",
        "secret",
        "variable",
        "workflow",
    }
)

# The retained forge CLI calls: git-transport credential plumbing, not a
# forge API read or write. `gh auth setup-git` registers `gh` as git's
# credential helper -- it reads the token from the environment at fetch or
# push time, so the token never reaches argv or a persisted git config.
ALLOWED_GH_CALLS = {
    ("scripts/push_harvest_branch.sh", "gh auth setup-git"),
    ("scripts/merge_bot_branch_corpus.py", '_run("gh", "auth", "setup-git")'),
}


def _guard_files() -> list[Path]:
    files = sorted(ROOT.glob("*.sh"))
    files += sorted((ROOT / "scripts").rglob("*.sh"))
    files += sorted((ROOT / "scripts").rglob("*.py"))
    files += sorted((ROOT / "pr_reviewer").rglob("*.py"))
    workflows = ROOT / ".github" / "workflows"
    files += sorted(workflows.glob("*.yml"))
    files += sorted(workflows.glob("*.yaml"))
    return files


def _prose_lines(path: Path) -> set[int]:
    """Line numbers that are prose (a docstring or a comment), not code."""
    if path.suffix != ".py":
        return set()
    source = path.read_text(encoding="utf-8")
    prose: set[int] = set()
    try:
        tree = ast.parse(source)
    except SyntaxError:  # pragma: no cover - a syntax error fails elsewhere
        return prose
    for node in ast.walk(tree):
        if not isinstance(
            node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
        ):
            continue
        body = getattr(node, "body", None)
        if not body:
            continue
        first = body[0]
        if (
            isinstance(first, ast.Expr)
            and isinstance(first.value, ast.Constant)
            and isinstance(first.value.value, str)
        ):
            doc = first.value
            prose.update(range(doc.lineno, (doc.end_lineno or doc.lineno) + 1))
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.COMMENT:
            prose.add(token.start[0])
    return prose


def _invocations(path: Path) -> list[tuple[int, str]]:
    """Every forge CLI invocation in the file, as (line number, line)."""
    prose = _prose_lines(path)
    hits: list[tuple[int, str]] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if number in prose:
            continue
        if path.suffix in (".sh", ".yml", ".yaml") and line.strip().startswith("#"):
            continue
        subcommands = [
            match.group(1)
            for match in list(_GH_CALL_RE.finditer(line)) + list(_GH_ARGV_RE.finditer(line))
        ]
        if any(subcommand in _FORGE_SUBCOMMANDS for subcommand in subcommands):
            hits.append((number, line))
    return hits


def test_no_forge_cli_invocations_remain_in_the_operational_tooling():
    offenders: list[str] = []
    for path in _guard_files():
        relative = path.relative_to(ROOT).as_posix()
        for number, line in _invocations(path):
            if (relative, line.strip()) in ALLOWED_GH_CALLS:
                continue
            offenders.append(f"{relative}:{number}: {line.strip()}")
    assert not offenders, (
        "forge API reads and writes must go through the configured forge "
        "capability (scripts/forge_cli.py), never a forge CLI binary:\n"
        + "\n".join(offenders)
    )


def test_the_allow_list_covers_exactly_the_retained_calls():
    retained: set[tuple[str, str]] = set()
    for path in _guard_files():
        relative = path.relative_to(ROOT).as_posix()
        for _number, line in _invocations(path):
            retained.add((relative, line.strip()))
    assert retained == ALLOWED_GH_CALLS, (
        "every retained forge CLI invocation must be explicitly allow-listed "
        "(with the reason), and the allow-list must not name anything else:\n"
        f"retained: {sorted(retained)}\nallow-listed: {sorted(ALLOWED_GH_CALLS)}"
    )


def test_each_allow_listed_call_appears_exactly_once():
    for relative, allowed_line in ALLOWED_GH_CALLS:
        lines = [
            line.strip()
            for line in (ROOT / relative).read_text(encoding="utf-8").splitlines()
            if line.strip() == allowed_line
        ]
        assert lines == [allowed_line], (
            f"{relative} must contain exactly one {allowed_line!r} line"
        )


# ---------------------------------------------------------------------------
# Guard: no raw HTTP client reaches the forge API
# ---------------------------------------------------------------------------
#
# The forge CLI guard above closes the "forge-specific CLI" bypass. A raw
# HTTP client aimed at the forge API is the same bypass wearing a
# different hat: it would put the bearer token in argv, in the URL, or in
# a shell string, and it would bypass every guarantee the capability
# makes (validated base URL, HTTPS for non-loopback, refused redirects,
# credential-free errors). The detection is forge-shaped, not "any curl":
# fetching the mise installer from mise.jdx.dev is not a forge call.

# A raw HTTP client: the binary name, not part of a longer word. A path
# prefix is the SAME binary ("/usr/bin/curl"), so it is matched too -- a
# bypass that spells the binary with its full path must not slip through.
_RAW_HTTP_RE = re.compile(r"(?<![\w-])(curl|wget)(?![\w-])")

# The forge API shapes a request target can name. A raw client is flagged
# only when its target names one of them.
_FORGE_API_TARGETS = (
    "api.github.com",
    "GITHUB_API_URL",
    "GITHUB_REPOSITORY",
    "/repos/",
    "/pulls/",
    "/issues/",
)

# Files exempt from the raw-HTTP guard, each with a non-empty reason. The
# exemption style mirrors tests/test_forge.py: an exemption is visible and
# reasoned, never silent. The capability itself is exempt because it IS
# the configured forge capability -- the one place a forge request may be
# built, and the one place the credential rules are enforced.
RAW_HTTP_EXEMPT_FILES: dict[str, str] = {
    "pr_reviewer/forge.py": (
        "it IS the configured forge capability: the one place a forge "
        "request may be built"
    ),
    "pr_reviewer/http_safe.py": (
        "it IS the configured capability's transport (the no-redirect opener)"
    ),
}

# The retained raw HTTP calls against a forge API: none today. Every entry
# carries the reason it is retained and must appear exactly once.
ALLOWED_RAW_HTTP_CALLS: dict[tuple[str, str], str] = {}


def _relative_to_root(path: Path) -> str:
    """The repo-relative path of a scanned file."""
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def _joined_command(lines: list[str], index: int) -> str:
    """The command starting at ``index``, with its continuations joined.

    A raw HTTP client invocation is often wrapped over several lines (a
    trailing backslash), and the URL can sit on the next line: the target
    must be seen as a whole, so the continuation is joined here.
    """
    parts = [lines[index].rstrip()]
    while parts[-1].endswith("\\"):
        parts[-1] = parts[-1][:-1].rstrip()
        index += 1
        if index >= len(lines):
            break
        parts.append(lines[index].strip())
    return " ".join(parts)


def _raw_http_invocations(path: Path) -> list[tuple[int, str]]:
    """Every raw HTTP client aimed at a forge API, as (line number, line)."""
    if _relative_to_root(path) in RAW_HTTP_EXEMPT_FILES:
        return []
    prose = _prose_lines(path)
    lines = path.read_text(encoding="utf-8").splitlines()
    hits: list[tuple[int, str]] = []
    for index, line in enumerate(lines):
        number = index + 1
        if number in prose:
            continue
        if path.suffix in (".sh", ".yml", ".yaml") and line.strip().startswith("#"):
            continue
        match = _RAW_HTTP_RE.search(line)
        if not match:
            continue
        target = _joined_command(lines, index)[match.end():]
        if any(marker in target for marker in _FORGE_API_TARGETS):
            hits.append((number, line))
    return hits


def test_no_raw_http_client_reaches_a_forge_api_in_the_operational_tooling():
    offenders: list[str] = []
    for path in _guard_files():
        relative = _relative_to_root(path)
        for number, line in _raw_http_invocations(path):
            if (relative, line.strip()) in ALLOWED_RAW_HTTP_CALLS:
                continue
            offenders.append(f"{relative}:{number}: {line.strip()}")
    assert not offenders, (
        "forge API reads and writes must go through the configured forge "
        "capability (scripts/forge_cli.py), never a raw HTTP client:\n"
        + "\n".join(offenders)
    )


def test_the_raw_http_allow_list_covers_exactly_the_retained_calls():
    retained: set[tuple[str, str]] = set()
    for path in _guard_files():
        relative = _relative_to_root(path)
        for _number, line in _raw_http_invocations(path):
            retained.add((relative, line.strip()))
    assert retained == set(ALLOWED_RAW_HTTP_CALLS), (
        "every retained raw HTTP call against a forge API must be explicitly "
        "allow-listed (with the reason), and the allow-list must not name "
        "anything else:\n"
        f"retained: {sorted(retained)}\n"
        f"allow-listed: {sorted(ALLOWED_RAW_HTTP_CALLS)}"
    )


def test_each_raw_http_allow_listed_call_appears_exactly_once():
    for (relative, allowed_line), reason in ALLOWED_RAW_HTTP_CALLS.items():
        assert reason.strip(), (
            f"{relative} is allow-listed against the raw-HTTP guard without "
            "a reason"
        )
        lines = [
            line.strip()
            for line in (ROOT / relative).read_text(encoding="utf-8").splitlines()
            if line.strip() == allowed_line
        ]
        assert lines == [allowed_line], (
            f"{relative} must contain exactly one {allowed_line!r} line"
        )


def test_every_raw_http_exemption_carries_a_reason():
    for relative, reason in RAW_HTTP_EXEMPT_FILES.items():
        assert reason.strip(), (
            f"{relative} is exempt from the raw-HTTP guard without a reason"
        )


@pytest.mark.parametrize(
    "line",
    [
        'curl -fsS -H "Authorization: Bearer $TOKEN" "$GITHUB_API_URL/repos/o/r/pulls/1"',
        'curl -fsS "https://api.github.com/repos/o/r/pulls/1"',
        'wget -q -O- https://api.github.com/repos/o/r/issues/1',
        'curl -fsS "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/pulls/1"',
        'curl -fsS -o /dev/null "https://api.github.com/repos/o/r/pulls/1"',
        '/usr/bin/curl -fsS "https://api.github.com/repos/o/r/pulls/1"',
        './wget -q -O- "https://api.github.com/repos/o/r/issues/1"',
    ],
)
def test_the_raw_http_guard_flags_a_forge_api_target(tmp_path, line):
    script = tmp_path / "call.sh"
    script.write_text(line + "\n", encoding="utf-8")
    assert _raw_http_invocations(script), f"must be flagged: {line}"


@pytest.mark.parametrize(
    "line",
    [
        "curl --fail --silent --show-error --location https://mise.jdx.dev/install.sh",
        'wget --quiet --tries=3 --output-document="$dest" "$url"',
        "curl --version",
    ],
)
def test_the_raw_http_guard_ignores_a_non_forge_download(tmp_path, line):
    script = tmp_path / "download.sh"
    script.write_text(line + "\n", encoding="utf-8")
    assert not _raw_http_invocations(script), f"must not be flagged: {line}"


def test_the_dogfood_workflow_reads_the_pr_through_the_capability():
    """The dogfood PR read goes through the capability, not a raw client."""
    path = ROOT / ".github" / "workflows" / "ai-pr-review.yaml"
    text = path.read_text(encoding="utf-8")
    assert "scripts/forge_cli.py pr-details" in text, (
        "the dogfood pr-gate must read the pull request through the "
        "configured forge capability"
    )
    assert not _raw_http_invocations(path), (
        "the dogfood workflow must not reach the forge API with a raw HTTP "
        "client"
    )


def test_the_guard_scans_the_files_it_claims_to():
    scanned = {path.relative_to(ROOT).as_posix() for path in _guard_files()}
    assert "scripts/release/converge.sh" in scanned
    assert "scripts/push_harvest_branch.sh" in scanned
    assert "scripts/forge_cli.py" in scanned
    assert ".github/workflows/manual-release.yml" in scanned
    assert ".github/workflows/release-please.yaml" in scanned
    assert ".github/workflows/harvest-human-findings.yaml" in scanned
    assert ".github/workflows/ai-pr-review.yaml" in scanned
    assert "pr_reviewer/forge.py" in scanned
    assert "pr_reviewer/http_safe.py" in scanned
