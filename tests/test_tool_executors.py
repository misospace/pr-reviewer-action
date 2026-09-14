"""Unit tests for pr_reviewer.tool_executors.

Target: >= 50% line coverage of pr_reviewer/tool_executors.py.

All tests are hermetic: every external dependency (read_file, git_log,
git_blame, git_grep, gh_api, web_fetch, web_search, run_command) is
patched so no live subprocess or network call is made.
"""
from __future__ import annotations

import json
from typing import Any, Dict
from unittest.mock import patch

import pytest

from pr_reviewer import tool_executors


def _call(name: str, args: Dict[str, Any], **kwargs: Any) -> Dict[str, Any]:
    """Call execute_tool_request with sensible default kwargs."""
    defaults = dict(
        workspace_root="/tmp",
        allowed_gh_repos=["*"],
        current_repo="example/repo",
        allowed_hosts=["*"],
        max_response_bytes=10_000,
        request_timeout=1,
        search_url="",
        max_search_results=5,
    )
    defaults.update(kwargs)
    return tool_executors.execute_tool_request(name, args, **defaults)


def test_module_exposes_expected_symbols() -> None:
    """Module exposes execute_tool_request as the public entry point."""
    assert hasattr(tool_executors, "execute_tool_request")
    assert callable(tool_executors.execute_tool_request)


def test_execute_tool_request_unknown_tool_returns_error_status() -> None:
    """An unknown tool name should produce status=='error' with an error message."""
    res = _call("does_not_exist", {})
    assert isinstance(res, dict)
    assert res.get("status") == "error"
    assert "result" in res
    assert "Unknown tool" in res["result"].get("error", "")


def test_execute_tool_request_empty_arguments_dict() -> None:
    """Empty args should be accepted (no crash)."""
    res = _call("does_not_exist", {})
    assert isinstance(res, dict)
    assert res.get("status") == "error"


def test_execute_tool_request_read_file_happy_path() -> None:
    """read_file tool with valid path should return content via mocked reader."""
    fake_res: Dict[str, Any] = {"content": "the file body", "range": None}

    with patch.object(tool_executors, "read_file", return_value=fake_res) as rd:
        res = _call("read_file", {"path": "README.md"})
    assert rd.called
    assert isinstance(res, dict)
    assert res.get("status") == "ok"
    assert "result" in res
    assert res["result"].get("content") == "the file body"


def test_execute_tool_request_read_file_missing_path() -> None:
    """read_file without 'path' should surface an error."""
    res = _call("read_file", {})
    assert isinstance(res, dict)
    assert res.get("status") == "error"
    assert "path" in res.get("result", {}).get("error", "").lower()


def test_execute_tool_request_read_file_returns_error_from_reader() -> None:
    """If the reader returns an error key, the executor should surface it."""
    fake_res: Dict[str, Any] = {"error": "File not found", "content": ""}
    with patch.object(tool_executors, "read_file", return_value=fake_res):
        res = _call("read_file", {"path": "missing.md"})
    assert res.get("status") == "error"
    assert "error" in res.get("result", {})


def test_execute_tool_request_git_log_happy_path() -> None:
    """git_log tool should accept path + max_count and return a 'log' field."""
    fake_log = {"log": ["commit abc", "commit def"]}
    with patch.object(tool_executors, "git_log", return_value=fake_log) as gl:
        res = _call("git_log", {"path": ".", "max_count": 5})
    assert gl.called
    assert res.get("status") == "ok"
    assert "log" in res.get("result", {})


def test_execute_tool_request_git_log_missing_path_defaults() -> None:
    """git_log without 'path' should still call git_log with empty path."""
    fake_log = {"log": []}
    with patch.object(tool_executors, "git_log", return_value=fake_log) as gl:
        res = _call("git_log", {})
    assert gl.called
    assert res.get("status") == "ok"


def test_execute_tool_request_git_blame_happy_path() -> None:
    """git_blame tool should accept path and return a 'blame' field."""
    fake_blame = {"blame": "alice 1 line one"}
    with patch.object(tool_executors, "git_blame", return_value=fake_blame) as gb:
        res = _call("git_blame", {"path": "a.py", "start": 1, "end": 5})
    assert gb.called
    assert res.get("status") == "ok"
    assert "blame" in res.get("result", {})


def test_execute_tool_request_git_blame_missing_path() -> None:
    """git_blame without 'path' should surface a clear error."""
    res = _call("git_blame", {})
    assert res.get("status") == "error"
    assert "path" in res.get("result", {}).get("error", "").lower()


def test_execute_tool_request_git_grep_happy_path() -> None:
    """git_grep tool should accept pattern and return matches."""
    fake_grep = {"matches": ["a.py:1:foo", "b.py:2:foo"]}
    with patch.object(tool_executors, "git_grep", return_value=fake_grep) as gg:
        res = _call("git_grep", {"pattern": "foo"})
    assert gg.called
    assert res.get("status") == "ok"
    assert "matches" in res.get("result", {})


def test_execute_tool_request_git_grep_missing_pattern() -> None:
    """git_grep without 'pattern' should surface an error."""
    res = _call("git_grep", {})
    assert res.get("status") == "error"
    assert "pattern" in res.get("result", {}).get("error", "").lower()


def test_execute_tool_request_gh_api_returns_dict_for_known_tool() -> None:
    """gh_api tool: mock gh_api to avoid any live subprocess call."""
    fake_res: Dict[str, Any] = {"data": {"login": "octocat"}, "error": None}
    with patch.object(tool_executors, "gh_api", return_value=fake_res) as gh:
        res = _call("gh_api", {"endpoint": "repos/example/repo"})
    assert gh.called
    assert isinstance(res, dict)
    assert res.get("status") == "ok"
    assert "response" in res.get("result", {})
    assert "octocat" in res["result"]["response"]


def test_execute_tool_request_gh_api_missing_endpoint() -> None:
    """gh_api without endpoint should error."""
    res = _call("gh_api", {})
    assert res.get("status") == "error"
    assert "endpoint" in res.get("result", {}).get("error", "").lower()


def test_execute_tool_request_web_fetch_happy_path() -> None:
    """web_fetch tool should accept a URL and return content (mocked)."""
    fake_fetch = {"content": "<html>hi</html>"}
    with patch.object(tool_executors, "web_fetch", return_value=fake_fetch) as wf:
        res = _call("web_fetch", {"url": "https://example.com/"})
    assert wf.called
    assert res.get("status") == "ok"
    assert "content" in res.get("result", {})


def test_execute_tool_request_web_fetch_missing_url() -> None:
    """web_fetch without url should error."""
    res = _call("web_fetch", {})
    assert res.get("status") == "error"
    assert "url" in res.get("result", {}).get("error", "").lower()


def test_execute_tool_request_web_search_happy_path() -> None:
    """web_search tool should accept a query and return results (mocked)."""
    fake_search = {"results": [{"title": "x", "url": "https://x.test"}]}
    with patch.object(tool_executors, "web_search", return_value=fake_search) as ws:
        res = _call("web_search", {"query": "pytest"})
    assert ws.called
    assert res.get("status") == "ok"
    assert "results" in res.get("result", {})


def test_execute_tool_request_web_search_missing_query() -> None:
    """web_search without query should error."""
    res = _call("web_search", {})
    assert res.get("status") == "error"
    assert "query" in res.get("result", {}).get("error", "").lower()


def test_execute_tool_request_run_command_happy_path() -> None:
    """run_command tool should accept a command and return stdout/stderr (mocked)."""
    fake_rc = {
        "stdout": "hello\n",
        "stderr": "",
        "exit_code": 0,
        "command": "echo hello",
    }
    with patch.object(tool_executors, "run_command", return_value=fake_rc) as rc:
        res = _call("run_command", {"command": "echo hello"})
    assert rc.called
    assert res.get("status") == "ok"
    payload = res["result"]
    assert payload["stdout"] == "hello\n"
    assert payload["exit_code"] == 0


def test_execute_tool_request_run_command_missing_command() -> None:
    """run_command without command should error."""
    res = _call("run_command", {})
    assert res.get("status") == "error"
    assert "command" in res.get("result", {}).get("error", "").lower()


# ── find_files (#567) ────────────────────────────────────────────────────────
# These exercise the real executor against a throwaway workspace in tmp_path
# (no mocks) so the matching semantics and security boundaries are pinned.


def _ff(pattern, workspace, path=".", max_results=None):
    """Call the find_files executor directly with a real workspace."""
    kwargs = {"pattern": pattern, "workspace_root": str(workspace), "path": path}
    if max_results is not None:
        kwargs["max_results"] = max_results
    return tool_executors.find_files(**kwargs)


def _ff_exec(pattern, workspace, path=".", max_results=None):
    """Call find_files through execute_tool_request (the loop's execute_fn)."""
    args = {"pattern": pattern, "path": path}
    if max_results is not None:
        args["max_results"] = max_results
    return _call("find_files", args, workspace_root=str(workspace))


def _make_tree(tmp_path):
    """Build a small deterministic tree with a .git dir and a symlink."""
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "config.sh").write_text("x", encoding="utf-8")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_foo.py").write_text("x", encoding="utf-8")
    (tmp_path / "tests" / "test_bar.py").write_text("x", encoding="utf-8")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "route.ts").write_text("x", encoding="utf-8")
    (tmp_path / "pyproject.toml").write_text("x", encoding="utf-8")
    (tmp_path / "README.md").write_text("x", encoding="utf-8")
    # A .git dir that must never be descended into.
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_text("x", encoding="utf-8")
    (tmp_path / ".git" / "objects").mkdir()
    (tmp_path / ".git" / "objects" / "config").write_text("x", encoding="utf-8")
    return tmp_path


def test_find_files_exact_basename_match(tmp_path):
    _make_tree(tmp_path)
    res = _ff("pyproject.toml", tmp_path)
    assert res == {"files": ["pyproject.toml"], "total": 1, "truncated": False}


def test_find_files_wildcard_filename_match(tmp_path):
    _make_tree(tmp_path)
    res = _ff("*config*", tmp_path)
    # Matches the basename anywhere in the tree; .git/config is excluded.
    assert res["files"] == ["scripts/config.sh"]
    assert res["total"] == 1


def test_find_files_nested_path_match(tmp_path):
    _make_tree(tmp_path)
    res = _ff("*/route.ts", tmp_path)
    assert res["files"] == ["src/route.ts"]


def test_find_files_scoped_under_path(tmp_path):
    _make_tree(tmp_path)
    res = _ff("test_*.py", tmp_path, path="tests")
    assert res["files"] == ["tests/test_bar.py", "tests/test_foo.py"]
    # Scoped search returns repo-relative paths, not paths relative to `path`.
    assert all(p.startswith("tests/") for p in res["files"])


def test_find_files_scoped_path_is_repo_relative(tmp_path):
    _make_tree(tmp_path)
    res = _ff("*.py", tmp_path, path="tests")
    assert res["files"] == ["tests/test_bar.py", "tests/test_foo.py"]


def test_find_files_deterministic_ordering(tmp_path):
    _make_tree(tmp_path)
    res = _ff("*.py", tmp_path)
    assert res["files"] == sorted(res["files"])
    # Repeated calls are stable.
    assert _ff("*.py", tmp_path)["files"] == res["files"]


def test_find_files_result_cap(tmp_path):
    for i in range(10):
        (tmp_path / f"f{i:02d}.txt").write_text("x", encoding="utf-8")
    res = _ff("f*.txt", tmp_path, max_results=3)
    assert res["files"] == ["f00.txt", "f01.txt", "f02.txt"]
    assert res["total"] == 3
    assert res["truncated"] is True


def test_find_files_cap_clamped_to_max(tmp_path):
    for i in range(5):
        (tmp_path / f"g{i}.txt").write_text("x", encoding="utf-8")
    # A model-supplied cap above the hard ceiling is clamped to 300.
    res = _ff("g*.txt", tmp_path, max_results=9999)
    assert res["total"] == 5
    assert res["truncated"] is False


def test_find_files_no_matches_returns_empty_not_error(tmp_path):
    _make_tree(tmp_path)
    res = _ff("does_not_exist_*.xyz", tmp_path)
    assert res == {"files": [], "total": 0, "truncated": False}


def test_find_files_nonexistent_root_returns_clean_error(tmp_path):
    _make_tree(tmp_path)
    res = _ff("*.py", tmp_path, path="no_such_dir")
    assert "error" in res
    assert "files" not in res


def test_find_files_path_escape_rejected(tmp_path):
    _make_tree(tmp_path)
    res = _ff("*.py", tmp_path, path="../")
    assert "error" in res
    assert "escapes workspace" in res["error"]


def test_find_files_null_byte_rejected(tmp_path):
    _make_tree(tmp_path)
    res = _ff("*.py", tmp_path, path="a\x00b")
    assert "error" in res
    assert "Null byte" in res["error"]


def test_find_files_does_not_descend_into_git(tmp_path):
    _make_tree(tmp_path)
    # .git/config and .git/objects/config both match "*config*" by basename,
    # but neither may be returned.
    res = _ff("*config*", tmp_path)
    assert all(not p.startswith(".git/") for p in res["files"])
    assert res["files"] == ["scripts/config.sh"]


def test_find_files_rejects_git_metadata_roots(tmp_path):
    _make_tree(tmp_path)
    for path in (".git", ".git/objects"):
        res = _ff("*", tmp_path, path=path)
        assert "error" in res
        assert ".git" in res["error"]


def test_find_files_does_not_follow_symlinked_dir(tmp_path):
    _make_tree(tmp_path)
    # A symlinked directory pointing outside the workspace must not be
    # descended into (followlinks=False), so its files are never returned.
    outside = tmp_path.parent / "outside"
    outside.mkdir(exist_ok=True)
    (outside / "secret.py").write_text("x", encoding="utf-8")
    link = tmp_path / "linkdir"
    link.symlink_to(outside, target_is_directory=True)
    res = _ff("*.py", tmp_path)
    assert all(not p.startswith("linkdir/") for p in res["files"])
    assert "secret.py" not in res["files"]


def test_find_files_skips_symlinked_file(tmp_path):
    _make_tree(tmp_path)
    # A symlinked file (even inside the workspace) is not reported.
    target = tmp_path / "real_target.txt"
    target.write_text("x", encoding="utf-8")
    (tmp_path / "link.txt").symlink_to(target)
    res = _ff("*.txt", tmp_path)
    assert "link.txt" not in res["files"]
    assert "real_target.txt" in res["files"]


def test_find_files_directories_not_returned(tmp_path):
    _make_tree(tmp_path)
    res = _ff("*", tmp_path)
    # Only files, never directories, even when the pattern matches a dir name.
    assert "scripts" not in res["files"]
    assert "tests" not in res["files"]
    assert "src" not in res["files"]


def test_find_files_missing_pattern_via_executor(tmp_path):
    _make_tree(tmp_path)
    res = _ff_exec("", tmp_path)
    assert res.get("status") == "error"
    assert "pattern" in res.get("result", {}).get("error", "").lower()


def test_find_files_via_executor_happy_path(tmp_path):
    _make_tree(tmp_path)
    res = _ff_exec("*.toml", tmp_path)
    assert res.get("status") == "ok"
    assert res["result"]["files"] == ["pyproject.toml"]
    assert res["result"]["total"] == 1
    assert res["result"]["truncated"] is False


def test_find_files_via_executor_no_matches_ok(tmp_path):
    _make_tree(tmp_path)
    res = _ff_exec("nope_*.xyz", tmp_path)
    assert res.get("status") == "ok"
    assert res["result"]["files"] == []
    assert res["result"]["total"] == 0


def test_find_files_via_executor_zero_cap_clamps_to_one(tmp_path):
    for i in range(3):
        (tmp_path / f"f{i}.txt").write_text("x", encoding="utf-8")
    res = _ff_exec("f*.txt", tmp_path, max_results=0)
    assert res.get("status") == "ok"
    assert res["result"]["files"] == ["f0.txt"]
    assert res["result"]["total"] == 1
    assert res["result"]["truncated"] is True


def test_find_files_via_executor_bad_path_error(tmp_path):
    _make_tree(tmp_path)
    res = _ff_exec("*.py", tmp_path, path="../")
    assert res.get("status") == "error"
    assert "escapes workspace" in res.get("result", {}).get("error", "")


# ── list_tree (#566) ─────────────────────────────────────────────────────────
# Mirrors the find_files battery: the real executor against a throwaway
# workspace in tmp_path (no mocks), pinning the listing semantics and the
# security boundaries (.git, symlinks, traversal, null bytes, hostile names).


def _lt(path, workspace, depth=None, max_entries=None):
    """Call the list_tree executor directly with a real workspace."""
    kwargs = {"path": path, "workspace_root": workspace}
    if depth is not None:
        kwargs["depth"] = depth
    if max_entries is not None:
        kwargs["max_entries"] = max_entries
    return tool_executors.list_tree(**kwargs)


def _lt_exec(path, workspace, depth=None, max_entries=None):
    """Call list_tree through execute_tool_request (the loop's execute_fn)."""
    args = {"path": path}
    if depth is not None:
        args["depth"] = depth
    if max_entries is not None:
        args["max_entries"] = max_entries
    return _call("list_tree", args, workspace_root=str(workspace))


def test_list_tree_root_default_depth(tmp_path):
    _make_tree(tmp_path)
    # Pre-order: each level emitted in sorted name order, dirs recursed in that
    # same order. .git is pruned; the result is the exact, stable prefix.
    res = _lt(".", tmp_path)
    assert res == {
        "entries": [
            {"path": "README.md", "type": "file"},
            {"path": "pyproject.toml", "type": "file"},
            {"path": "scripts", "type": "dir"},
            {"path": "scripts/config.sh", "type": "file"},
            {"path": "src", "type": "dir"},
            {"path": "src/route.ts", "type": "file"},
            {"path": "tests", "type": "dir"},
            {"path": "tests/test_bar.py", "type": "file"},
            {"path": "tests/test_foo.py", "type": "file"},
        ],
        "total": 9,
        "truncated": False,
    }


def test_list_tree_nested_path_is_repo_relative(tmp_path):
    _make_tree(tmp_path)
    res = _lt("tests", tmp_path)
    assert res["entries"] == [
        {"path": "tests/test_bar.py", "type": "file"},
        {"path": "tests/test_foo.py", "type": "file"},
    ]
    assert res["total"] == 2
    assert res["truncated"] is False
    # Repo-relative paths, not paths relative to the requested `path`.
    assert all(e["path"].startswith("tests/") for e in res["entries"])


def test_list_tree_deterministic_ordering(tmp_path):
    _make_tree(tmp_path)
    res = _lt(".", tmp_path)
    # For this fixture the pre-order listing equals the full path sort.
    assert res["entries"] == sorted(res["entries"], key=lambda e: e["path"])
    # Repeated calls are byte-stable (prompt-cache / repeat-review friendly).
    assert _lt(".", tmp_path) == res


def test_list_tree_depth_clamped(tmp_path):
    _make_tree(tmp_path)
    # depth=1: only the direct children of the root (dirs not expanded).
    d1 = _lt(".", tmp_path, depth=1)
    assert d1["entries"] == [
        {"path": "README.md", "type": "file"},
        {"path": "pyproject.toml", "type": "file"},
        {"path": "scripts", "type": "dir"},
        {"path": "src", "type": "dir"},
        {"path": "tests", "type": "dir"},
    ]
    assert d1["total"] == 5
    assert d1["truncated"] is False
    # depth=0 clamps to the low bound (1) — same listing as depth=1.
    assert _lt(".", tmp_path, depth=0) == d1
    # depth=99 clamps to the high bound (4); the fixture is only 2 deep, so it
    # equals the default depth=2 listing.
    assert _lt(".", tmp_path, depth=99) == _lt(".", tmp_path, depth=2)
    # A model-supplied string depth is coerced through _opt_int.
    assert _lt(".", tmp_path, depth="2") == _lt(".", tmp_path, depth=2)


def test_list_tree_max_entries_cap(tmp_path):
    _make_tree(tmp_path)
    # cap=3: the first 3 pre-order rows, with a truncated flag.
    res3 = _lt(".", tmp_path, max_entries=3)
    assert res3["entries"] == [
        {"path": "README.md", "type": "file"},
        {"path": "pyproject.toml", "type": "file"},
        {"path": "scripts", "type": "dir"},
    ]
    assert res3["total"] == 3
    assert res3["truncated"] is True
    # cap=0 clamps to the low bound (1): one row, truncated.
    res0 = _lt(".", tmp_path, max_entries=0)
    assert res0["entries"] == [{"path": "README.md", "type": "file"}]
    assert res0["total"] == 1
    assert res0["truncated"] is True
    # cap=9999 clamps to the high bound (500): the whole listing, not
    # truncated, no error.
    res_big = _lt(".", tmp_path, depth=1, max_entries=9999)
    assert res_big["total"] == 5
    assert res_big["truncated"] is False


def test_list_tree_nonexistent_path_returns_clean_error(tmp_path):
    _make_tree(tmp_path)
    res = _lt("no_such_dir", tmp_path)
    assert "error" in res
    assert "entries" not in res
    assert "not found" in res["error"].lower()


def test_list_tree_path_escape_rejected(tmp_path):
    _make_tree(tmp_path)
    res = _lt("../", tmp_path)
    assert "error" in res
    assert "escapes workspace" in res["error"]


def test_list_tree_null_byte_rejected(tmp_path):
    _make_tree(tmp_path)
    res = _lt("a\x00b", tmp_path)
    assert "error" in res
    assert "Null byte" in res["error"]


def test_list_tree_does_not_descend_into_git(tmp_path):
    _make_tree(tmp_path)
    # .git/config and .git/objects/config exist, but neither may be listed.
    res = _lt(".", tmp_path)
    paths = [e["path"] for e in res["entries"]]
    assert ".git" not in paths
    assert all(not p.startswith(".git/") for p in paths)


def test_list_tree_rejects_git_metadata_roots(tmp_path):
    _make_tree(tmp_path)
    for path in (".git", ".git/objects"):
        res = _lt(path, tmp_path)
        assert "error" in res
        assert ".git" in res["error"]


def test_list_tree_does_not_follow_symlinked_dir(tmp_path):
    _make_tree(tmp_path)
    # A symlinked directory pointing outside the workspace is skipped entirely
    # — never listed and never descended into, so its files are unreachable.
    outside = tmp_path.parent / "outside"
    outside.mkdir(exist_ok=True)
    (outside / "secret.py").write_text("x", encoding="utf-8")
    link = tmp_path / "linkdir"
    link.symlink_to(outside, target_is_directory=True)
    res = _lt(".", tmp_path)
    paths = [e["path"] for e in res["entries"]]
    assert "linkdir" not in paths
    assert all(not p.startswith("linkdir/") for p in paths)
    assert "secret.py" not in paths


def test_list_tree_skips_symlinked_file(tmp_path):
    _make_tree(tmp_path)
    # A symlinked file (even inside the workspace) is not listed — consistent
    # with find_files, so a symlink pointing outside cannot be traversed.
    target = tmp_path / "real_target.txt"
    target.write_text("x", encoding="utf-8")
    (tmp_path / "link.txt").symlink_to(target)
    res = _lt(".", tmp_path)
    paths = [e["path"] for e in res["entries"]]
    assert "link.txt" not in paths
    assert "real_target.txt" in paths


def test_list_tree_file_as_path_returns_single_row(tmp_path):
    _make_tree(tmp_path)
    # A file passed as path is a valid one-row listing (not an error).
    res = _lt("README.md", tmp_path)
    assert res == {
        "entries": [{"path": "README.md", "type": "file"}],
        "total": 1,
        "truncated": False,
    }


def test_list_tree_hostile_name_with_newline(tmp_path):
    """#252 convention: a hostile filename carrying a newline must not inject a
    raw newline into the serialized tool result — json.dumps escapes it."""
    _make_tree(tmp_path)
    (tmp_path / "scripts" / "bad\nname.txt").write_text("x", encoding="utf-8")
    res = _lt(".", tmp_path)
    assert "scripts/bad\nname.txt" in [e["path"] for e in res["entries"]]
    blob = json.dumps(res, separators=(",", ":"))
    # The embedded newline is escaped by json.dumps, so no raw control char
    # survives into a single-line serialized result.
    assert "\n" not in blob
    assert "\\n" in blob


def test_list_tree_via_executor_happy_path(tmp_path):
    _make_tree(tmp_path)
    res = _lt_exec(".", tmp_path)
    assert res.get("status") == "ok"
    assert res["result"]["total"] == 9
    assert res["result"]["truncated"] is False
    assert res["result"]["entries"][0] == {"path": "README.md", "type": "file"}
    assert res["result"]["entries"][-1] == {
        "path": "tests/test_foo.py",
        "type": "file",
    }


def test_list_tree_via_executor_bad_path_error(tmp_path):
    _make_tree(tmp_path)
    res = _lt_exec("../", tmp_path)
    assert res.get("status") == "error"
    assert "escapes workspace" in res.get("result", {}).get("error", "")


def test_list_tree_via_executor_zero_cap_clamps_to_one(tmp_path):
    _make_tree(tmp_path)
    res = _lt_exec(".", tmp_path, max_entries=0)
    assert res.get("status") == "ok"
    assert res["result"]["entries"] == [{"path": "README.md", "type": "file"}]
    assert res["result"]["total"] == 1
    assert res["result"]["truncated"] is True


def test_list_tree_via_executor_byte_cap(tmp_path):
    _make_tree(tmp_path)
    # A tiny max_response_bytes truncates at row boundaries: a deterministic
    # pre-order prefix is kept, a byte cut never splits an entry, and
    # truncated is set (driven directly via _call to inject the small cap).
    # {"path":"README.md","type":"file"} = 34 bytes; {"path":"pyproject.toml",...} = 60+ bytes.
    # A cap of 70 fits the first row (34) but not the second (34+60=94 > 70).
    res = _call(
        "list_tree",
        {"path": "."},
        workspace_root=str(tmp_path),
        max_response_bytes=70,
    )
    assert res.get("status") == "ok"
    entries = res["result"]["entries"]
    assert entries == [{"path": "README.md", "type": "file"}]
    assert res["result"]["total"] == len(entries)
    assert res["result"]["truncated"] is True


def test_list_tree_via_executor_byte_cap_multibyte_filename(tmp_path):
    # Regression: the byte cap must measure UTF-8 bytes, not char count.
    # A multibyte filename (e.g. "café.txt" = 9 bytes) must not slip past a
    # tiny cap that would have accepted it under the old char-count logic.
    (tmp_path / "café.txt").write_text("x", encoding="utf-8")
    res = _call(
        "list_tree",
        {"path": "."},
        workspace_root=str(tmp_path),
        max_response_bytes=20,
    )
    assert res.get("status") == "ok"
    # {"path":"café.txt","type":"file"} = 34 bytes UTF-8 (the "é" is 2 bytes)
    # > 20, so the entry is dropped and truncated is set.
    assert res["result"]["entries"] == []
    assert res["result"]["total"] == 0
    assert res["result"]["truncated"] is True


def test_list_tree_via_executor_byte_cap_no_first_row_slip(tmp_path):
    # Regression: the first row must not be admitted unconditionally. A
    # single row that exceeds the cap yields an empty result with truncated.
    (tmp_path / ("a" * 100)).write_text("x", encoding="utf-8")
    res = _call(
        "list_tree",
        {"path": "."},
        workspace_root=str(tmp_path),
        max_response_bytes=10,
    )
    assert res.get("status") == "ok"
    assert res["result"]["entries"] == []
    assert res["result"]["total"] == 0
    assert res["result"]["truncated"] is True


def test_list_tree_via_executor_byte_cap_array_separators(tmp_path):
    # Regression: the byte cap applies to the serialized `entries` array,
    # including the `[` `]` brackets and the `,` between rows. Two 30-byte
    # rows with a 60-byte cap: sum(row_sizes) = 60 <= 60, but the serialized
    # array is [a,b] = 63 > 60. The second row must be dropped.
    (tmp_path / "a.txt").write_text("x", encoding="utf-8")
    (tmp_path / "b.txt").write_text("x", encoding="utf-8")
    res = _call(
        "list_tree",
        {"path": "."},
        workspace_root=str(tmp_path),
        max_response_bytes=60,
    )
    assert res.get("status") == "ok"
    # Both rows are 30 bytes. The first fits (2 + 30 = 32 <= 60), the second
    # does not (32 + 30 + 1 = 63 > 60). So only the first row is retained.
    assert res["result"]["entries"] == [{"path": "a.txt", "type": "file"}]
    assert res["result"]["total"] == 1
    assert res["result"]["truncated"] is True


# ── repo_contents (#576) ──────────────────────────────────────────────────────
# The repo_contents tool is the read-only related-repo primitive on top of the
# platform seam: gh_api carries the call (with the existing repo allowlist and
# path prefix denylist), and the executor normalizes the GitHub / Forgejo
# Contents API response into one bounded shape. We mock gh_api so the tests
# exercise the executor's logic (allowlist reuse, path/repo validation, output
# normalization, byte cap, binary detection) without any real network call.


import base64 as _b64

_REPO = "example/repo"


def _rc(**kwargs):
    """Call the repo_contents executor with sensible defaults.

    Default allowlist matches the executor's auth boundary: the current repo
    plus a deliberately explicit second repo, so we can assert both are
    accepted (current) and that an unlisted one is rejected (below).
    """
    defaults = dict(
        repo=kwargs.pop("repo", _REPO),
        path=kwargs.pop("path", ""),
        allowed_repos=kwargs.pop("allowed_repos", {_REPO, "allowed/other"}),
        current_repo=_REPO,
        ref=kwargs.pop("ref", ""),
        request_timeout=1,
    )
    defaults.update(kwargs)
    return tool_executors.repo_contents(**defaults)


def _rc_exec(args, **kwargs):
    """Call repo_contents through execute_tool_request."""
    return _call("repo_contents", args, **kwargs)


def _b64_text(s):
    return _b64.b64encode(s.encode("utf-8")).decode("ascii")


def test_repo_contents_current_repo_directory_listing():
    """A directory response is normalized to sorted {path,type} entries."""
    fake_data = [
        {"name": "z.py", "path": "src/z.py", "type": "file", "size": 10},
        {"name": "a", "path": "src/a", "type": "dir"},
        {"name": "B", "path": "src/B", "type": "dir"},
        {"name": "skip", "path": "src/skip", "type": "submodule"},  # filtered out
        {"name": "broken", "path": "", "type": "file"},  # filtered out (no path)
    ]
    with patch.object(tool_executors, "gh_api", return_value={"data": fake_data}) as gh:
        res = _rc(path="src")
    assert "error" not in res, res
    # Symlinks/submodules/no-path rows are dropped. The rest is sorted by path.
    assert res["type"] == "directory"
    assert res["repo"] == _REPO
    assert res["path"] == "src"
    assert res["entries"] == [
        {"path": "src/B", "type": "dir"},
        {"path": "src/a", "type": "dir"},
        {"path": "src/z.py", "type": "file"},
    ]
    assert res["total"] == 3
    assert res["truncated"] is False
    # gh_api was called with the repo-scoped contents endpoint (no host
    # anywhere in the model-supplied args).
    assert gh.called
    args, kwargs = gh.call_args
    assert args[0] == "repos/example/repo/contents/src"


def test_repo_contents_empty_path_lists_repo_root():
    """An empty path routes to /repos/{o}/{r}/contents (no trailing slash)."""
    fake_data = [{"name": "README.md", "path": "README.md", "type": "file"}]
    with patch.object(tool_executors, "gh_api", return_value={"data": fake_data}) as gh:
        res = _rc(path="")
    assert "error" not in res, res
    assert res["path"] == ""
    assert res["entries"] == [{"path": "README.md", "type": "file"}]
    args, _ = gh.call_args
    assert args[0] == "repos/example/repo/contents"


def test_repo_contents_directory_payload_with_trailing_slash_normalizes():
    """Some backends normalize a directory into a {type: "dir"} object; the
    executor surfaces it as an empty directory listing rather than failing."""
    fake_data = {"type": "dir", "name": "src", "path": "src"}
    with patch.object(tool_executors, "gh_api", return_value={"data": fake_data}):
        res = _rc(path="src")
    assert res["type"] == "directory"
    assert res["entries"] == []


def test_repo_contents_text_file_is_decoded_and_byte_capped():
    """A file response is base64-decoded to UTF-8 text, then byte-capped."""
    body = "alpha\n" * 5000  # ~30k bytes
    fake_data = {
        "name": "client.py",
        "path": "src/client.py",
        "type": "file",
        "encoding": "base64",
        "content": _b64_text(body),
        "size": len(body),
    }
    with patch.object(tool_executors, "gh_api", return_value={"data": fake_data}):
        res = _rc(path="src/client.py")
    assert "error" not in res, res
    assert res["type"] == "file"
    assert res["repo"] == _REPO
    assert res["path"] == "src/client.py"
    # Capped at REPO_CONTENTS_FILE_MAX_BYTES; the cut is on a newline boundary
    # so the text is well-formed.
    assert res["truncated"] is True
    content_bytes = res["content"].encode("utf-8")
    assert len(content_bytes) <= tool_executors.REPO_CONTENTS_FILE_MAX_BYTES
    assert "alpha" in res["content"]


def test_repo_contents_small_file_returns_full_text():
    """A small text file under the cap is returned in full."""
    fake_data = {
        "name": "client.py",
        "path": "src/client.py",
        "type": "file",
        "encoding": "base64",
        "content": _b64_text("print('hi')\n"),
        "size": 11,
    }
    with patch.object(tool_executors, "gh_api", return_value={"data": fake_data}):
        res = _rc(path="src/client.py")
    assert res["content"] == "print('hi')\n"
    assert res["truncated"] is False


def test_repo_contents_binary_file_returns_metadata_only():
    """Binary content is detected and surfaced as metadata, never raw bytes."""
    binary = bytes(range(256))  # arbitrary non-UTF-8 byte sequence
    fake_data = {
        "name": "logo.png",
        "path": "assets/logo.png",
        "type": "file",
        "encoding": "base64",
        "content": _b64.b64encode(binary).decode("ascii"),
        "size": len(binary),
    }
    with patch.object(tool_executors, "gh_api", return_value={"data": fake_data}):
        res = _rc(path="assets/logo.png")
    assert res["type"] == "file"
    assert res["binary"] is True
    assert res["size"] == len(binary)
    assert "content" not in res
    assert res["truncated"] is False


def test_repo_contents_symlink_response_is_clean_error():
    """A symlink/submodule payload type is not actionable; return a clean error."""
    fake_data = {
        "name": "link",
        "path": "link",
        "type": "symlink",
        "target": "/elsewhere",
    }
    with patch.object(tool_executors, "gh_api", return_value={"data": fake_data}):
        res = _rc(path="link")
    assert "error" in res
    assert "Unsupported" in res["error"] or "symlink" in res["error"].lower()


def test_repo_contents_current_repo_allowed_by_default():
    """The current repo is always allowlisted (single source of truth)."""
    fake_data = [{"name": "x", "path": "x", "type": "file"}]
    with patch.object(tool_executors, "gh_api", return_value={"data": fake_data}):
        # Empty allowed_repos + explicit current_repo: still permitted.
        res = tool_executors.repo_contents(
            repo=_REPO,
            path="x",
            allowed_repos=set(),
            current_repo=_REPO,
            request_timeout=1,
        )
    assert "error" not in res, res


def test_repo_contents_explicitly_allowlisted_second_repo_allowed():
    """A second repo from tool_allowed_gh_api_repos is accepted."""
    fake_data = [{"name": "y", "path": "y", "type": "file"}]
    with patch.object(tool_executors, "gh_api", return_value={"data": fake_data}) as gh:
        res = tool_executors.repo_contents(
            repo="other/repo",
            path="y",
            allowed_repos={"other/repo"},
            current_repo=_REPO,
            request_timeout=1,
        )
    assert "error" not in res, res
    args, _ = gh.call_args
    assert args[0] == "repos/other/repo/contents/y"


def test_repo_contents_unlisted_repo_rejected():
    """A repo outside the allowlist is rejected before any network call."""
    with patch.object(tool_executors, "gh_api") as gh:
        res = tool_executors.repo_contents(
            repo="attacker/evil",
            path="x",
            allowed_repos={"other/repo"},
            current_repo=_REPO,
            request_timeout=1,
        )
    assert "error" in res
    assert "not allowed" in res["error"].lower()
    gh.assert_not_called()


def test_repo_contents_wildcard_allows_any_repo():
    """The '*' wildcard in the allowlist is honoured (no second gate)."""
    fake_data = [{"name": "y", "path": "y", "type": "file"}]
    with patch.object(tool_executors, "gh_api", return_value={"data": fake_data}) as gh:
        res = tool_executors.repo_contents(
            repo="any-org/any-repo",
            path="y",
            allowed_repos={"*"},
            current_repo=_REPO,
            request_timeout=1,
        )
    assert "error" not in res, res
    args, _ = gh.call_args
    assert args[0] == "repos/any-org/any-repo/contents/y"


def test_repo_contents_path_traversal_rejected():
    """A '..' path segment is rejected before any network call."""
    with patch.object(tool_executors, "gh_api") as gh:
        res = tool_executors.repo_contents(
            repo=_REPO,
            path="../etc/passwd",
            allowed_repos={_REPO},
            current_repo=_REPO,
            request_timeout=1,
        )
    assert "error" in res
    assert "segment" in res["error"].lower() or "invalid" in res["error"].lower()
    gh.assert_not_called()


def test_repo_contents_null_byte_in_path_rejected():
    """An embedded NUL byte is rejected (no syscall truncation)."""
    with patch.object(tool_executors, "gh_api") as gh:
        res = tool_executors.repo_contents(
            repo=_REPO,
            path="a\x00b",
            allowed_repos={_REPO},
            current_repo=_REPO,
            request_timeout=1,
        )
    assert "error" in res
    assert "control" in res["error"].lower() or "invalid" in res["error"].lower()
    gh.assert_not_called()


def test_repo_contents_leading_slash_stripped():
    """A leading '/' on the path is normalised away so the URL stays at
    /repos/{o}/{r}/contents/path (no double slash)."""
    fake_data = [{"name": "x", "path": "x", "type": "file"}]
    with patch.object(tool_executors, "gh_api", return_value={"data": fake_data}) as gh:
        res = tool_executors.repo_contents(
            repo=_REPO,
            path="/src/x",
            allowed_repos={_REPO},
            current_repo=_REPO,
            request_timeout=1,
        )
    assert "error" not in res, res
    args, _ = gh.call_args
    assert args[0] == "repos/example/repo/contents/src/x"


def test_repo_contents_ref_appended_as_query():
    """A 'ref' branch/tag/SHA is appended as ?ref=... (no path smuggling)."""
    fake_data = [{"name": "x", "path": "x", "type": "file"}]
    with patch.object(tool_executors, "gh_api", return_value={"data": fake_data}) as gh:
        res = tool_executors.repo_contents(
            repo=_REPO,
            path="x",
            ref="v1.2.3",
            allowed_repos={_REPO},
            current_repo=_REPO,
            request_timeout=1,
        )
    assert "error" not in res, res
    args, _ = gh.call_args
    assert args[0] == "repos/example/repo/contents/x?ref=v1.2.3"


def test_repo_contents_bad_ref_rejected():
    """A ref with disallowed characters is rejected before any network call."""
    with patch.object(tool_executors, "gh_api") as gh:
        res = tool_executors.repo_contents(
            repo=_REPO,
            path="x",
            ref="v1; rm -rf /",
            allowed_repos={_REPO},
            current_repo=_REPO,
            request_timeout=1,
        )
    assert "error" in res
    assert "ref" in res["error"].lower()
    gh.assert_not_called()


def test_repo_contents_api_error_propagated():
    """An error from gh_api (404, timeout, unsupported) is surfaced intact."""
    with patch.object(
        tool_executors,
        "gh_api",
        return_value={"error": "Forgejo API error: 404 not found"},
    ):
        res = tool_executors.repo_contents(
            repo=_REPO,
            path="missing",
            allowed_repos={_REPO},
            current_repo=_REPO,
            request_timeout=1,
        )
    assert "error" in res
    assert "404" in res["error"]


def test_repo_contents_api_timeout_propagated():
    """A timeout from gh_api reaches the model as a clean error."""
    with patch.object(
        tool_executors,
        "gh_api",
        return_value={"error": "Forgejo API timed out after 25s"},
    ):
        res = tool_executors.repo_contents(
            repo=_REPO,
            path="x",
            allowed_repos={_REPO},
            current_repo=_REPO,
            request_timeout=25,
        )
    assert "error" in res
    assert "timed out" in res["error"].lower()


def test_repo_contents_forgejo_unsupported_explicitly_reported():
    """When Forgejo cannot service the endpoint, the seam returns a clear
    'Endpoint not supported on PLATFORM=forgejo' rather than silently
    routing to api.github.com."""
    with patch.object(
        tool_executors,
        "gh_api",
        return_value={
            "error": "Endpoint not supported on PLATFORM=forgejo: /repos/o/r/contents"
        },
    ):
        res = tool_executors.repo_contents(
            repo=_REPO,
            path="",
            allowed_repos={_REPO},
            current_repo=_REPO,
            request_timeout=1,
        )
    assert "error" in res
    assert "not supported" in res["error"].lower()
    assert "forgejo" in res["error"].lower()
    assert "api.github.com" not in res["error"]


def test_repo_contents_directory_sorted_deterministic():
    """Directory entries come out sorted on every call (stable ordering)."""
    rows = [
        {"name": f"f{i}", "path": f"src/f{i}", "type": "file"} for i in range(20, 0, -1)
    ]
    with patch.object(tool_executors, "gh_api", return_value={"data": rows}):
        out1 = _rc(path="src")
    with patch.object(tool_executors, "gh_api", return_value={"data": rows}):
        out2 = _rc(path="src")
    paths = [e["path"] for e in out1["entries"]]
    assert paths == sorted(paths)
    assert out1 == out2  # byte-stable across calls (prompt-cache friendly)


def test_repo_contents_directory_capped_at_default():
    """Large directories are truncated to REPO_CONTENTS_DEFAULT_MAX_ENTRIES."""
    rows = [
        {"name": f"f{i:04d}", "path": f"src/f{i:04d}.txt", "type": "file"}
        for i in range(500)
    ]
    with patch.object(tool_executors, "gh_api", return_value={"data": rows}):
        res = _rc(path="src")
    assert res["total"] == tool_executors.REPO_CONTENTS_DEFAULT_MAX_ENTRIES
    assert res["truncated"] is True
    # The prefix is the lexicographic head (sort happened before the cap).
    assert res["entries"][0]["path"] == "src/f0000.txt"


# ── execute_tool_request dispatch (#576) ────────────────────────────────────


def test_execute_tool_request_repo_contents_dispatches_to_executor():
    """The loop's execute_fn reaches repo_contents with the right arg flow."""
    fake = {
        "repo": _REPO,
        "path": "x",
        "type": "directory",
        "entries": [{"path": "x/y", "type": "file"}],
        "total": 1,
        "truncated": False,
    }
    with patch.object(tool_executors, "repo_contents", return_value=fake) as rc:
        res = _rc_exec({"repo": _REPO, "path": "x"}, current_repo=_REPO)
    assert rc.called
    assert res.get("status") == "ok"
    assert res["result"] == fake


def test_execute_tool_request_repo_contents_error_propagates():
    """A repo not in the allowlist surfaces as a clean error status."""
    with patch.object(
        tool_executors,
        "repo_contents",
        return_value={"error": "Repo not allowed: attacker/evil"},
    ):
        res = _rc_exec(
            {"repo": "attacker/evil", "path": "x"},
            current_repo=_REPO,
            allowed_gh_repos={_REPO},
        )
    assert res.get("status") == "error"
    assert "not allowed" in res["result"]["error"].lower()


def test_execute_tool_request_repo_contents_default_repo():
    """Omitting 'repo' defaults to the current repo (the executor's call site)."""
    fake = {
        "repo": _REPO,
        "path": "",
        "type": "directory",
        "entries": [],
        "total": 0,
        "truncated": False,
    }
    with patch.object(tool_executors, "repo_contents", return_value=fake) as rc:
        res = _rc_exec({"path": ""}, current_repo=_REPO)
    assert res.get("status") == "ok"
    args, _ = rc.call_args
    assert args[0] == _REPO  # default repo argument
