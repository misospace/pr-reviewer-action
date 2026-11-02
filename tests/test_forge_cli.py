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
- no forge CLI invocation survives anywhere in the operational tooling
  (the guard test at the end of this file pins that going forward).

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
import tokenize
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

    def test_labels_before_a_hostile_one_are_not_reprinted_after_failure(self, cli, stub):
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


def test_the_guard_scans_the_files_it_claims_to():
    scanned = {path.relative_to(ROOT).as_posix() for path in _guard_files()}
    assert "scripts/release/converge.sh" in scanned
    assert "scripts/push_harvest_branch.sh" in scanned
    assert "scripts/forge_cli.py" in scanned
    assert ".github/workflows/manual-release.yml" in scanned
    assert ".github/workflows/release-please.yaml" in scanned
    assert ".github/workflows/harvest-human-findings.yaml" in scanned
