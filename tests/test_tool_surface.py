"""Tool-surface expansion (#197 §3): read_file line ranges, git_log, git_blame.

Drives the executor (execute_tool_request — the native loop's execute_fn target)
so the tests exercise the real arg-handling, security guards, and output shaping.
git_log/git_blame run against a throwaway git repo built in tmp_path.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import run_tool_harness as rth  # noqa: E402

_REPO = "owner/repo"


def _exec(tool, args, workspace):
    return rth.execute_tool_request(
        tool, args, str(workspace), {_REPO}, _REPO, ["github.com"], 12000, 15
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
