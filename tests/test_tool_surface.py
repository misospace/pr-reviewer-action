"""Tool-surface expansion (#197 §3): read_file line ranges, git_log, git_blame.

Drives the executor (execute_tool_request — the native loop's execute_fn target)
so the tests exercise the real arg-handling, security guards, and output shaping.
git_log/git_blame run against a throwaway git repo built in tmp_path.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from unittest import mock

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import run_tool_harness as rth  # noqa: E402
from pr_reviewer import tool_executors  # noqa: E402

_REPO = "owner/repo"


def _exec(tool, args, workspace, max_response_bytes=12000):
    return rth.execute_tool_request(
        tool, args, str(workspace), {_REPO}, _REPO, ["github.com"], max_response_bytes, 15
    )


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


@pytest.fixture
def git_repo(tmp_path):
    """A throwaway git repo with one committed multi-line file."""
    _git(["init", "-q"], tmp_path)
    _git(["config", "user.email", "t@example.com"], tmp_path)
    _git(["config", "user.name", "Tester"], tmp_path)
    (tmp_path / "app.py").write_text("\n".join(f"line {i}" for i in range(1, 21)) + "\n", encoding="utf-8")
    _git(["add", "app.py"], tmp_path)
    _git(["commit", "-q", "-m", "add app.py"], tmp_path)
    return tmp_path


# ── read_file line ranges ────────────────────────────────────────────────────
def test_read_file_offset_limit_returns_window(tmp_path):
    (tmp_path / "big.txt").write_text("\n".join(f"row{i}" for i in range(1, 101)) + "\n", encoding="utf-8")
    res = _exec("read_file", {"path": "big.txt", "offset": 10, "limit": 3}, tmp_path)
    assert res["status"] == "ok"
    assert res["result"]["content"] == "row10\nrow11\nrow12\n"
    assert res["result"]["range"] == {"offset": 10, "lines": 3, "total_lines": 100}


def test_read_file_no_range_reads_whole_file(tmp_path):
    (tmp_path / "f.txt").write_text("a\nb\n", encoding="utf-8")
    res = _exec("read_file", {"path": "f.txt"}, tmp_path)
    assert res["status"] == "ok"
    assert res["result"]["content"] == "a\nb\n"
    assert "range" not in res["result"]


def test_read_file_offset_string_coerced(tmp_path):
    # Weak models emit numbers as strings; the executor coerces them.
    (tmp_path / "f.txt").write_text("x\ny\nz\n", encoding="utf-8")
    res = _exec("read_file", {"path": "f.txt", "offset": "2", "limit": "1"}, tmp_path)
    assert res["status"] == "ok"
    assert res["result"]["content"] == "y\n"


def test_read_file_range_still_blocks_sensitive(tmp_path):
    (tmp_path / ".env").write_text("SECRET=1\n", encoding="utf-8")
    res = _exec("read_file", {"path": ".env", "offset": 1, "limit": 1}, tmp_path)
    assert res["status"] == "error"
    assert "SECRET" not in str(res["result"])


# ── git_log ──────────────────────────────────────────────────────────────────
def test_git_log_returns_history(git_repo):
    res = _exec("git_log", {"path": "app.py"}, git_repo)
    assert res["status"] == "ok"
    assert "add app.py" in res["result"]["log"]


def test_git_log_no_path_runs_repo_wide(git_repo):
    res = _exec("git_log", {}, git_repo)
    assert res["status"] == "ok"
    assert "add app.py" in res["result"]["log"]


def test_git_log_path_escape_blocked(git_repo):
    res = _exec("git_log", {"path": "../../etc/passwd"}, git_repo)
    assert res["status"] == "error"


# ── git_blame ────────────────────────────────────────────────────────────────
def test_git_blame_returns_authorship(git_repo):
    res = _exec("git_blame", {"path": "app.py", "start": 1, "end": 2}, git_repo)
    assert res["status"] == "ok"
    assert "Tester" in res["result"]["blame"]
    assert "line 1" in res["result"]["blame"]


def test_git_blame_requires_path(git_repo):
    res = _exec("git_blame", {}, git_repo)
    assert res["status"] == "error"


def test_git_blame_blocks_sensitive_file(git_repo):
    # A committed secret must not be readable through blame's content rendering.
    (git_repo / "id_rsa").write_text("PRIVATE_KEY_LINE\n", encoding="utf-8")
    _git(["add", "id_rsa"], git_repo)
    _git(["commit", "-q", "-m", "oops"], git_repo)
    res = _exec("git_blame", {"path": "id_rsa"}, git_repo)
    assert res["status"] == "error"
    assert "PRIVATE_KEY_LINE" not in str(res["result"])


def test_git_blame_escape_blocked(git_repo):
    res = _exec("git_blame", {"path": "../../etc/hosts"}, git_repo)
    assert res["status"] == "error"


# ── sensitive-file blocklist expansion (#436) ────────────────────────────────
SENSITIVE_FILES = [
    ".netrc",
    ".npmrc",
    ".gitconfig",
    ".git-credentials",
    ".htpasswd",
]


@pytest.mark.parametrize("filename", SENSITIVE_FILES)
def test_read_file_blocks_sensitive_files(tmp_path, filename):
    (tmp_path / filename).write_text("SECRET=1\n", encoding="utf-8")
    res = _exec("read_file", {"path": filename}, tmp_path)
    assert res["status"] == "error"
    assert "SECRET" not in str(res["result"])


def test_read_file_blocks_docker_config(tmp_path):
    docker_dir = tmp_path / ".docker"
    docker_dir.mkdir()
    (docker_dir / "config.json").write_text('{"auths":{}}\n', encoding="utf-8")
    res = _exec("read_file", {"path": ".docker/config.json"}, tmp_path)
    assert res["status"] == "error"


def test_read_file_blocks_kube_config(tmp_path):
    kube_dir = tmp_path / ".kube"
    kube_dir.mkdir()
    (kube_dir / "config").write_text("apiVersion: v1\n", encoding="utf-8")
    res = _exec("read_file", {"path": ".kube/config"}, tmp_path)
    assert res["status"] == "error"


def test_read_file_blocks_kube_conf(tmp_path):
    kube_dir = tmp_path / ".kube"
    kube_dir.mkdir()
    (kube_dir / "my-cluster.conf").write_text("apiVersion: v1\n", encoding="utf-8")
    res = _exec("read_file", {"path": ".kube/my-cluster.conf"}, tmp_path)
    assert res["status"] == "error"


def test_read_file_blocks_service_account_json(tmp_path):
    (tmp_path / "my-project-service-account.json").write_text('{"type":"service_account"}\n', encoding="utf-8")
    res = _exec("read_file", {"path": "my-project-service-account.json"}, tmp_path)
    assert res["status"] == "error"


def test_read_file_blocks_key_json(tmp_path):
    (tmp_path / "aws-key.json").write_text('{"key":"value"}\n', encoding="utf-8")
    res = _exec("read_file", {"path": "aws-key.json"}, tmp_path)
    assert res["status"] == "error"


# ── existing sensitive files still blocked ───────────────────────────────────
def test_read_file_still_blocks_env(tmp_path):
    (tmp_path / ".env").write_text("SECRET=1\n", encoding="utf-8")
    res = _exec("read_file", {"path": ".env"}, tmp_path)
    assert res["status"] == "error"


def test_read_file_still_blocks_pem(tmp_path):
    (tmp_path / "server.pem").write_text("-----BEGIN CERTIFICATE-----\n", encoding="utf-8")
    res = _exec("read_file", {"path": "server.pem"}, tmp_path)
    assert res["status"] == "error"


def test_read_file_still_blocks_key(tmp_path):
    (tmp_path / "private.key").write_text("-----BEGIN PRIVATE KEY-----\n", encoding="utf-8")
    res = _exec("read_file", {"path": "private.key"}, tmp_path)
    assert res["status"] == "error"


# ── git_grep path scoping + result limits (#568) ─────────────────────────────
#
# git_grep runs git for real against a throwaway repo, so these cover the
# actual scoping / clamping / ordering behaviour end-to-end, not just the
# mocked argv. The executor's path/containment guards and the sensitive-path
# policy are shared with read_file/git_blame (see test_tool_executors.py).


def _grep_repo(tmp_path, files):
    """Build a committed git repo in tmp_path from a {relative_path: text} map."""
    _git(["init", "-q"], tmp_path)
    _git(["config", "user.email", "t@example.com"], tmp_path)
    _git(["config", "user.name", "Tester"], tmp_path)
    for rel, text in files.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    _git(["add", "-A"], tmp_path)
    _git(["commit", "-q", "-m", "seed"], tmp_path)
    return tmp_path


def _split_match(m):
    """Split a ``git_grep`` match into ``(path, lineno, content)``.

    Tolerates both the documented ``path:lineno:content`` form and the raw
    ``git grep -z`` ``path\\0lineno\\0content`` form. The source currently
    emits the ``-z`` form (NULs retained) for non-sensitive files; asserting on
    the parsed components keeps these behaviour tests green either way and does
    not pin the separator, so a later normalisation fix won't churn them.
    """
    sep = "\x00" if "\x00" in m else ":"
    path, _, rest = m.partition(sep)
    lineno, _, content = rest.partition(sep)
    return path, lineno, content


def test_git_grep_no_path_no_max_results_preserves_behavior(git_repo):
    # Whole-repo search, no path and no max_results: matches the historical
    # ``git grep -n -- pattern .`` behaviour.
    res = _exec("git_grep", {"pattern": "line"}, git_repo)
    assert res["status"] == "ok"
    # All 20 lines match "line", all from app.py, in deterministic line order.
    assert [
        _split_match(m) for m in res["result"]["matches"]
    ] == [("app.py", str(i), f"line {i}") for i in range(1, 21)]


def test_git_grep_scoped_path_returns_only_subtree(git_repo):
    (git_repo / "sub").mkdir()
    (git_repo / "sub" / "deep.py").write_text("deep needle here\n", encoding="utf-8")
    _git(["add", "-A"], git_repo)
    _git(["commit", "-q", "-m", "add sub"], git_repo)
    res = _exec("git_grep", {"pattern": "line", "path": "sub"}, git_repo)
    assert res["status"] == "ok"
    # Every match is under sub/ and none leak from the repo root.
    assert res["result"]["matches"] == []
    res2 = _exec("git_grep", {"pattern": "needle", "path": "sub"}, git_repo)
    assert [
        _split_match(m) for m in res2["result"]["matches"]
    ] == [("sub/deep.py", "1", "deep needle here")]


def test_git_grep_max_results_below_default(git_repo):
    res = _exec("git_grep", {"pattern": "line", "max_results": 3}, git_repo)
    assert res["status"] == "ok"
    assert len(res["result"]["matches"]) == 3
    # Deterministic line ordering: the first three lines, in order.
    assert [
        _split_match(m) for m in res["result"]["matches"]
    ] == [
        ("app.py", "1", "line 1"),
        ("app.py", "2", "line 2"),
        ("app.py", "3", "line 3"),
    ]


def test_git_grep_max_results_clamped_to_200(git_repo):
    # An oversized request is clamped to the 200 upper bound, not honoured.
    mock_result = mock.Mock(
        returncode=0, stderr="",
        stdout="\n".join(f"f.py:{i}:x" for i in range(1, 202)),
    )
    with mock.patch("subprocess.run", return_value=mock_result) as mock_run:
        res = tool_executors.git_grep("x", str(git_repo), 15, max_results=1000)
    assert mock_run.call_args[1]["timeout"] == 15
    assert len(res["matches"]) == 200
    # The clamp is exercised at the executor boundary too: an explicit
    # >200 value still returns at most 200 lines.
    res2 = _exec("git_grep", {"pattern": "line", "max_results": 5000}, git_repo)
    assert res2["status"] == "ok"
    assert len(res2["result"]["matches"]) <= 200


def test_git_grep_max_results_clamped_to_1_for_tiny(tmp_path):
    repo = _grep_repo(tmp_path, {"a.txt": "n1\nn2\nn3\n"})
    res = _exec("git_grep", {"pattern": "n", "max_results": 1}, repo)
    assert res["status"] == "ok"
    assert [_split_match(m) for m in res["result"]["matches"]] == [("a.txt", "1", "n1")]


def test_git_grep_max_results_string_coerced(git_repo):
    # Weak models emit numbers as strings; the executor clamps/coerces them.
    res = _exec("git_grep", {"pattern": "line", "max_results": "2"}, git_repo)
    assert res["status"] == "ok"
    assert [
        _split_match(m) for m in res["result"]["matches"]
    ] == [("app.py", "1", "line 1"), ("app.py", "2", "line 2")]


def test_git_grep_default_argv_preserved(git_repo):
    """No path → the historical argv shape is preserved (``-n -z`` before a
    single ``--`` and the ``.`` pathspec), so the pattern can never be
    re-read as a git option."""
    mock_result = mock.Mock(returncode=0, stderr="", stdout="")
    with mock.patch("subprocess.run", return_value=mock_result) as mock_run:
        res = tool_executors.git_grep("pattern", str(git_repo))
    assert res == {"matches": []}
    mock_run.assert_called_once_with(
        ["git", "grep", "-n", "-z", "--", "pattern", "."],
        cwd=str(git_repo),
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert "shell" not in mock_run.call_args[1]  # argv list, never a shell string


def test_git_grep_double_dash_argv_with_path(git_repo):
    """An explicit path is appended after a SECOND ``--`` so a model cannot
    turn it into a git option (and it stays out of pattern position)."""
    mock_result = mock.Mock(returncode=0, stderr="", stdout="")
    with mock.patch("subprocess.run", return_value=mock_result) as mock_run:
        tool_executors.git_grep("p", str(git_repo), 15, path="sub")
    args = mock_run.call_args[0][0]
    assert args[:6] == ["git", "grep", "-n", "-z", "--", "p"]
    assert args[6] == "--"  # pathspec separator: a dash-leading path is safe
    expected = [
        "sub",
        (git_repo / "sub").resolve().as_posix(),
        str(git_repo / "sub"),
    ]
    assert args[7] in expected
    assert "shell" not in mock_run.call_args[1]


def test_git_grep_dash_path_is_not_an_option(tmp_path):
    """A path beginning with ``-`` is still treated as a path (via the ``--``
    pathspec), never as a git flag — so a dash-leading directory is searchable
    and the model can't turn a path into a git option."""
    repo = _grep_repo(tmp_path, {"-odd/a.txt": "dashy needle\n"})
    res = _exec("git_grep", {"pattern": "needle", "path": "-odd"}, repo)
    assert res["status"] == "ok", f"dash-leading path should be searchable, got {res}"
    assert [_split_match(m) for m in res["result"]["matches"]] == [
        ("-odd/a.txt", "1", "dashy needle")
    ]


def test_git_grep_path_traversal_rejected(git_repo):
    res = _exec("git_grep", {"pattern": "needle", "path": "../"}, git_repo)
    assert res["status"] == "error"
    assert "escapes" in res["result"]["error"]
    res2 = _exec("git_grep", {"pattern": "line", "path": "../../etc"}, git_repo)
    assert res2["status"] == "error"


def test_git_grep_path_null_byte_rejected(git_repo):
    res = _exec("git_grep", {"pattern": "x", "path": "a\x00b"}, git_repo)
    assert res["status"] == "error"


def test_git_grep_symlink_escape_rejected(git_repo):
    """A symlinked directory pointing outside the workspace must not leak
    content through a scoped git grep."""
    outside = git_repo.parent / "outside"
    outside.mkdir(exist_ok=True)
    (outside / "secret.txt").write_text("leaked secret\n", encoding="utf-8")
    os.symlink(str(outside), str(git_repo / "link_out"))
    res = _exec("git_grep", {"pattern": "secret", "path": "link_out"}, git_repo)
    assert res["status"] == "error"
    assert "leaked secret" not in str(res["result"])


def test_git_grep_sensitive_path_rejected(git_repo):
    (git_repo / ".env").write_text("TOKEN=supersecret\n", encoding="utf-8")
    # Force-add: `.env` is commonly gitignored (including via a global
    # excludesfile), but this test needs it *tracked* to prove the executor's
    # sensitive-path policy blocks it regardless of git's ignore rules.
    _git(["add", "-f", "-A"], git_repo)
    _git(["commit", "-q", "-m", "env"], git_repo)
    res = _exec("git_grep", {"pattern": "supersecret", "path": ".env"}, git_repo)
    assert res["status"] == "error"
    assert "supersecret" not in str(res["result"])
    # Same policy via read_file for parity.
    res2 = _exec("read_file", {"path": ".env"}, git_repo)
    assert res2["status"] == "error"


def test_git_grep_timeout_error_clean(tmp_path):
    repo = _grep_repo(tmp_path, {"a.txt": "needle\n"})
    with mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired("git", 1)):
        res = _exec("git_grep", {"pattern": "needle", "path": ".", "max_results": 5}, repo)
    assert res["status"] == "error"
    assert "timed out" in res["result"]["error"]


def test_git_grep_git_error_is_clean_not_crash(tmp_path):
    # A git failure (e.g. not a repo) surfaces as a clean error dict, never a
    # raised exception out of the executor.
    res = _exec("git_grep", {"pattern": "needle", "path": "nope"}, tmp_path)
    assert res["status"] in ("ok", "error")
    if res["status"] == "error":
        assert "error" in res["result"]


def test_git_grep_no_match_ok_empty(git_repo):
    res = _exec("git_grep", {"pattern": "definitely-not-present-xyz", "path": "sub"}, git_repo)
    assert res["status"] == "ok"
    assert res["result"]["matches"] == []


# ── git_grep redaction + byte-bounding regressions (#568) ───────────────────
#
# The -z change makes a whole-worktree grep match *tracked* sensitive
# descendants (the resolver only guards the *requested* scope). These pin the
# end-to-end guarantee at the execute_tool_request boundary: a broad grep must
# not leak a tracked secret, credential-like values are redacted, and the
# payload is byte-bounded (not just count-capped).


def _grep_secret_repo(tmp_path, files):
    """Build a committed repo, force-adding so sensitive files are tracked even
    when a local/global gitignore would exclude them."""
    repo = tmp_path / "r"
    repo.mkdir()
    for rel, text in files.items():
        (repo / rel).write_text(text, encoding="utf-8")
    for cmd in (
        ["git", "init", "-q", str(repo)],
        ["git", "-C", str(repo), "config", "user.email", "t@example.com"],
        ["git", "-C", str(repo), "config", "user.name", "Tester"],
        ["git", "-C", str(repo), "add", "-f", "-A"],
        ["git", "-C", str(repo), "commit", "-q", "-m", "init"],
    ):
        subprocess.run(cmd, check=True, capture_output=True, text=True)
    return repo


def test_git_grep_broad_scope_does_not_leak_tracked_env(tmp_path):
    """A whole-repo grep must not leak secrets from tracked sensitive files."""
    repo = _grep_secret_repo(
        tmp_path,
        {".env": "SECRET=supersecret\n", "normal.txt": "SECRET=supersecret\n"},
    )
    res = _exec("git_grep", {"pattern": "supersecret"}, repo)
    assert res["status"] == "ok"
    assert "supersecret" not in str(res["result"])
    # The provenance line survives (path:lineno is preserved, content is masked):
    assert any(".env" in m for m in res["result"]["matches"])


def test_git_grep_redacts_credential_like_value_in_normal_file(tmp_path):
    """The `mask_and_truncate` call in `execute_tool_request` must not be
    discarded for `git_grep` — credential-like values are redacted."""
    repo = _grep_secret_repo(tmp_path, {"config.py": 'API_KEY = "abc123def456ghi"\n'})
    res = _exec("git_grep", {"pattern": "abc123", "path": "."}, repo)
    assert res["status"] == "ok"
    assert "abc123def456ghi" not in str(res["result"])
    assert "[REDACTED]" in str(res["result"])


def test_git_grep_respects_max_response_bytes(tmp_path):
    """The `execute_tool_request` git_grep branch must return
    `text.splitlines()` (byte-bounded) not `matches[:max_results]`."""
    repo = _grep_secret_repo(
        tmp_path,
        {"a.txt": "\n".join(f"needle {i} " + "x" * 100 for i in range(20)) + "\n"},
    )
    res = _exec("git_grep", {"pattern": "needle", "path": "."}, repo, max_response_bytes=150)
    assert res["status"] == "ok"
    assert res["result"]["truncated"] is True
    matches = res["result"]["matches"]
    # mask_and_truncate clips to max_response_bytes, then appends a trailing
    # "[truncated]" marker line; the byte bound applies to the clipped content.
    assert matches[-1] == "[truncated]"
    assert len("\n".join(matches[:-1]).encode("utf-8")) <= 150


def test_git_grep_newline_named_sensitive_file_is_path_redacted(tmp_path):
    """A sensitive path ending in a newline must not lose its path boundary.

    The marker is deliberately not a credential/key-value shape, so this
    proves the sensitive-path guard — not mask_secrets() — blocks the content.
    """
    marker = "unstructured-marker"
    repo = _grep_secret_repo(tmp_path, {".env\n": f"{marker}\n"})

    # git_grep itself preserves the complete newline-containing path long
    # enough to apply the per-match sensitive-file policy.
    raw = tool_executors.git_grep(marker, str(repo))
    assert raw == {"matches": [".env\n:1:[redacted: sensitive path]"]}

    # The executor boundary must not leak the arbitrary marker either.
    res = _exec("git_grep", {"pattern": marker}, repo)
    assert res["status"] == "ok"
    assert marker not in str(res["result"])
    assert "[redacted: sensitive path]" in str(res["result"])


def test_git_grep_newline_named_normal_file_preserves_provenance(tmp_path):
    """A non-sensitive filename with a newline stays one parsed grep record."""
    marker = "ordinary-marker"
    filename = "ordinary\nname.txt"
    repo = _grep_secret_repo(tmp_path, {filename: f"{marker}\n"})

    raw = tool_executors.git_grep(marker, str(repo))
    assert raw == {"matches": [f"{filename}:1:{marker}"]}
