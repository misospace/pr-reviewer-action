"""Unit tests for pr_reviewer.tool_executors.

Target: >= 50% line coverage of pr_reviewer/tool_executors.py.

All tests are hermetic: every external dependency (read_file, git_log,
git_blame, git_grep, gh_api, web_fetch, web_search, run_command) is
patched so no live subprocess or network call is made.
"""
from __future__ import annotations

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
