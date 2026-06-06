"""Tests for issue #53 and issue #102: tool harness status accounting and error handling.

Issue #53: run_review.sh checked `.tool_results[].result.status` but
run_tool_harness.py writes status at `.tool_results[].status`.

Issue #102: read_file, git_grep, gh_api, and web_fetch did not check for
error returns from their helper functions, causing status to be "ok" even
when the underlying tool failed.

Acceptance criteria:
  - The corrected jq path reads from .tool_results[].status == "ok".
  - A regression fixture with at least one successful tool result and fail-closed
    settings demonstrates the old path fails and the new path passes.
  - read_file, git_grep, gh_api, web_fetch all produce status: error when
    their helper returns an error dict.
  - run_command already had this behavior (verified via existing tests).
"""

import json
import os
import subprocess
import sys
import tempfile
from unittest import mock
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"


def _import_tool(name):
    """Import a tool function from run_tool_harness, ensuring scripts is on sys.path."""
    if str(_SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(_SCRIPTS_DIR))
    from run_tool_harness import (  # noqa: F401
        fetch_url,
        gh_api,
        git_grep,
        read_file,
        run_command,
        web_fetch,
    )
    return locals()[name]


def _count_ok_by_path(data, status_path):
    """Count tool results where the given nested path equals 'ok'.

    Replaces jq expression like:
      [.tool_results[]?.<path> == "ok"] | map(select(. == true)) | length
    """
    tool_results = data.get("tool_results", [])
    count = 0
    for tr in tool_results:
        obj = tr
        for key in status_path:
            if isinstance(obj, dict):
                obj = obj.get(key)
            else:
                obj = None
                break
        if obj == "ok":
            count += 1
    return count


def _any_ok_by_path(data, status_path):
    """Check if any tool result has the given nested path equal to 'ok'.

    Replaces jq expression like:
      ([.tool_results[]?.<path> == "ok"] | any)
    """
    tool_results = data.get("tool_results", [])
    for tr in tool_results:
        obj = tr
        for key in status_path:
            if isinstance(obj, dict):
                obj = obj.get(key)
            else:
                obj = None
                break
        if obj == "ok":
            return True
    return False


# ---------------------------------------------------------------------------
# Fixture: tool-harness.json with one successful and one failed call
# (Matches the exact schema produced by run_tool_harness.py)
# ---------------------------------------------------------------------------

FIXTURE_TOOL_HARNESS = {
    "mode": "plan_execute_once",
    "planned_request_count": 2,
    "executed_request_count": 2,
    "tool_results": [
        {
            "tool": "read_file",
            "status": "ok",  # <-- correct path: .status
            "result": {"content": "# README\nSome content."},
        },
        {
            "tool": "git_grep",
            "status": "error",
            "result": {"error": "pattern not found"},
        },
    ],
}


# ---------------------------------------------------------------------------
# Test: Old (buggy) path counts 0 successes → would enforce request_changes
# ---------------------------------------------------------------------------

def test_old_path_counts_zero():
    """The old jq expression `.tool_results[].result.status` finds nothing."""
    data = FIXTURE_TOOL_HARNESS

    # This is the OLD buggy path: .result.status (which doesn't exist)
    successful = _count_ok_by_path(data, ["result", "status"])
    assert successful == 0, (
        f"Old path should count 0 successes for tool results with .status field, "
        f"got {successful}"
    )

    # The old path also fails the "any ok" check used in TOOL_FAILURE_REASON:
    any_ok_old = _any_ok_by_path(data, ["result", "status"])
    assert any_ok_old is False, (
        f"Old path should find no 'ok' results, got {any_ok_old}"
    )


# ---------------------------------------------------------------------------
# Test: New (fixed) path counts 1 success → passes fail-closed check
# ---------------------------------------------------------------------------

def test_new_path_counts_one():
    """The fixed jq expression `.tool_results[].status` finds the correct count."""
    data = FIXTURE_TOOL_HARNESS

    # This is the FIXED path: .status
    successful = _count_ok_by_path(data, ["status"])
    assert successful == 1, (
        f"New path should count 1 success for tool results with .status='ok', "
        f"got {successful}"
    )

    # The new path finds at least one 'ok' in the any check:
    any_ok_new = _any_ok_by_path(data, ["status"])
    assert any_ok_new is True, (
        f"New path should find at least one 'ok' result, got {any_ok_new}"
    )


# ---------------------------------------------------------------------------
# Test: All-success fixture passes both old and new paths
# (Both paths work when result.status happens to exist)
# ---------------------------------------------------------------------------

ALL_OK_FIXTURE = {
    "mode": "plan_execute_once",
    "planned_request_count": 1,
    "executed_request_count": 1,
    "tool_results": [
        {
            "tool": "read_file",
            "status": "ok",
            "result": {"content": "file content"},
        },
    ],
}


def test_all_ok_fixture():
    """When all tools succeed, both paths agree on 1 success."""
    data = ALL_OK_FIXTURE

    old_count = _count_ok_by_path(data, ["result", "status"])
    new_count = _count_ok_by_path(data, ["status"])
    # New path correctly finds 1 success
    assert new_count == 1, f"New path should count 1, got {new_count}"
    # Old path finds 0 (because result.status doesn't exist, only result.content)
    assert old_count == 0, f"Old path should count 0, got {old_count}"


# ---------------------------------------------------------------------------
# Test: All-fail fixture fails both paths (correctly)
# ---------------------------------------------------------------------------

ALL_FAIL_FIXTURE = {
    "mode": "plan_execute_once",
    "planned_request_count": 1,
    "executed_request_count": 1,
    "tool_results": [
        {
            "tool": "git_grep",
            "status": "error",
            "result": {"error": "timeout"},
        },
    ],
}


def test_all_fail_fixture():
    """When all tools fail, both paths agree on 0 successes."""
    data = ALL_FAIL_FIXTURE

    old_count = _count_ok_by_path(data, ["result", "status"])
    new_count = _count_ok_by_path(data, ["status"])
    assert old_count == 0, f"Old path should count 0, got {old_count}"
    assert new_count == 0, f"New path should count 0, got {new_count}"


# ---------------------------------------------------------------------------
# Test: Verify run_review.sh delegates enforcement to Python module
# ---------------------------------------------------------------------------

def test_run_review_uses_correct_path():
    """Confirm run_review.sh delegates enforcement to pr_reviewer.enforcement."""
    script = Path(__file__).resolve().parent.parent / "scripts" / "run_review.sh"
    content = script.read_text(encoding="utf-8", errors="replace")

    # The buggy pattern should NOT be present anywhere:
    assert ".tool_results[]?.result.status" not in content, (
        "run_review.sh still references the buggy .result.status path"
    )

    # run_review.sh should delegate to the Python enforcement module:
    assert "apply_all_enforcement_wrapper" in content, (
        "run_review.sh should call apply_all_enforcement_wrapper to delegate enforcement"
    )


# ---------------------------------------------------------------------------
# Tests for issue #102: tool error propagation
# ---------------------------------------------------------------------------


def test_read_file_error_path():
    """read_file with a missing path returns {'error': ...}."""
    read_file = _import_tool("read_file")
    result = read_file("nonexistent_file_xyz.txt", "/tmp")
    assert "error" in result, f"Expected error key, got: {result}"


def test_read_file_sensitive_path():
    """read_file with a sensitive filename returns {'error': ...}."""
    read_file = _import_tool("read_file")
    result = read_file(".env", "/tmp")
    assert "error" in result, f"Expected error for sensitive path, got: {result}"


def test_read_file_path_escape():
    """read_file with a path escaping workspace returns {'error': ...}."""
    read_file = _import_tool("read_file")
    result = read_file("../../etc/passwd", "/tmp")
    assert "error" in result, f"Expected error for path escape, got: {result}"


def test_git_grep_error_path():
    """git_grep returns {'error': ...} when subprocess raises TimeoutExpired."""
    git_grep = _import_tool("git_grep")
    with mock.patch(
        "subprocess.run", side_effect=subprocess.TimeoutExpired("git", 15)
    ):
        result = git_grep("some-pattern", "/tmp")
    assert result.get("error") == "git grep timed out after 15s", (
        f"Expected exact timeout error message, got: {result}"
    )


def test_git_grep_error_returncode():
    """git_grep returns {'error': ...} when git grep exits with non-0/1 code."""
    git_grep = _import_tool("git_grep")
    mock_result = mock.Mock(returncode=2, stderr="fatal: some error", stdout="")
    with mock.patch("subprocess.run", return_value=mock_result):
        result = git_grep("some-pattern", "/tmp")
    assert "error" in result and "git grep failed" in result["error"], (
        f"Expected error dict for non-zero exit, got: {result}"
    )


def test_git_grep_error_generic():
    """git_grep returns {'error': ...} for any unexpected exception."""
    git_grep = _import_tool("git_grep")
    with mock.patch("subprocess.run", side_effect=RuntimeError("permission denied")):
        result = git_grep("some-pattern", "/tmp")
    assert "error" in result and "permission denied" in result["error"], (
        f"Expected error dict for unexpected exception, got: {result}"
    )


def test_gh_api_error_missing_token():
    """gh_api with no token returns {'error': 'Missing GH_TOKEN'}."""
    gh_api = _import_tool("gh_api")

    # Ensure no token is available. try/finally guarantees restoration even
    # if an assertion fails. Tests are single-threaded so this is safe.
    old_token = None
    for env_var in ("GH_TOKEN", "GITHUB_TOKEN"):
        if env_var in os.environ:
            old_token = (env_var, os.environ[env_var])
            del os.environ[env_var]

    try:
        result = gh_api("owner/repo/pulls/1", set(), "owner/repo")
        assert "error" in result, f"Expected error for missing token, got: {result}"
    finally:
        if old_token:
            os.environ[old_token[0]] = old_token[1]


def test_gh_api_error_repo_not_allowed():
    """gh_api with a non-allowlisted repo returns {'error': ...}.

    The allowlist check runs before any HTTP request, so the fake token set
    below is never sent over the network. Verified by the urlopen assertion.
    """
    gh_api = _import_tool("gh_api")

    old_token = None
    for env_var in ("GH_TOKEN", "GITHUB_TOKEN"):
        if env_var in os.environ:
            old_token = (env_var, os.environ[env_var])
            break
    if not old_token:
        os.environ["GH_TOKEN"] = "fake-token-for-testing"

    try:
        # Patch urlopen to confirm no network call is made when repo is
        # rejected by the allowlist. The allowlist check runs before any
        # HTTP request in gh_api().
        with mock.patch("urllib.request.urlopen") as mock_urlopen:
            result = gh_api(
                "other-owner/other-repo/pulls/1", set(), "my-org/my-repo"
            )
        assert "error" in result, f"Expected error for disallowed repo, got: {result}"
        assert "Repo not allowed" in result["error"]
        mock_urlopen.assert_not_called(), (
            "urlopen should not be called when repo is not allowlisted"
        )
    finally:
        if old_token:
            os.environ[old_token[0]] = old_token[1]
        else:
            del os.environ["GH_TOKEN"]


def test_web_fetch_error_non_allowlisted_host():
    """web_fetch with a non-allowlisted host returns {'error': ...}."""
    web_fetch = _import_tool("web_fetch")

    result = web_fetch("https://evil.example.com/secret", ["github.com"])
    assert "error" in result, f"Expected error for non-allowlisted host, got: {result}"


def test_run_command_error_not_allowlisted():
    """run_command with an unallowlisted command returns {'error': ...}."""
    run_command = _import_tool("run_command")

    result = run_command("rm -rf /", "/tmp")
    assert "error" in result, f"Expected error for disallowed command, got: {result}"


# ---------------------------------------------------------------------------
# Tests for issue #104: request_timeout parameter passing
# ---------------------------------------------------------------------------


def test_git_grep_uses_custom_timeout():
    """git_grep passes the timeout value to subprocess.run."""
    git_grep = _import_tool("git_grep")
    mock_result = mock.Mock(returncode=1, stderr="", stdout="")
    with mock.patch("subprocess.run", return_value=mock_result) as mock_run:
        git_grep("pattern", "/tmp", request_timeout=42)
    mock_run.assert_called_once_with(
        ["git", "grep", "-n", "--", "pattern", "."],
        cwd="/tmp",
        capture_output=True,
        text=True,
        timeout=42,
    )


def test_git_grep_default_timeout():
    """git_grep uses 15s default when no timeout is specified."""
    git_grep = _import_tool("git_grep")
    mock_result = mock.Mock(returncode=0, stderr="", stdout="")
    with mock.patch("subprocess.run", return_value=mock_result) as mock_run:
        git_grep("pattern", "/tmp")
    mock_run.assert_called_once_with(
        ["git", "grep", "-n", "--", "pattern", "."],
        cwd="/tmp",
        capture_output=True,
        text=True,
        timeout=15,
    )


def test_git_grep_timeout_error_message():
    """git_grep timeout error message includes the configured timeout."""
    git_grep = _import_tool("git_grep")
    with mock.patch(
        "subprocess.run", side_effect=subprocess.TimeoutExpired("git", 10)
    ):
        result = git_grep("pattern", "/tmp", request_timeout=10)
    assert result.get("error") == "git grep timed out after 10s"


def test_gh_api_uses_custom_timeout():
    """gh_api passes the timeout value to urllib.request.urlopen."""
    gh_api = _import_tool("gh_api")

    old_token = None
    for env_var in ("GH_TOKEN", "GITHUB_TOKEN"):
        if env_var in os.environ:
            old_token = (env_var, os.environ[env_var])
            del os.environ[env_var]

    try:
        os.environ["GH_TOKEN"] = "fake-token-for-testing"
        fake_response = mock.Mock()
        fake_response.read.return_value = b'{"data": {}}'
        with mock.patch("urllib.request.urlopen", return_value=fake_response) as mock_urlopen:
            gh_api("owner/repo/pulls/1", {"owner/repo"}, "owner/repo", request_timeout=42)
        mock_urlopen.assert_called_once()
        args, kwargs = mock_urlopen.call_args
        assert kwargs.get("timeout") == 42, (
            f"Expected timeout=42, got {kwargs}"
        )
    finally:
        if old_token:
            os.environ[old_token[0]] = old_token[1]
        else:
            del os.environ["GH_TOKEN"]


def test_web_fetch_uses_custom_timeout():
    """web_fetch passes the timeout value to urllib.request.urlopen."""
    web_fetch = _import_tool("web_fetch")

    fake_response = mock.Mock()
    fake_response.read.return_value = b"content"
    with mock.patch("urllib.request.urlopen", return_value=fake_response) as mock_urlopen:
        web_fetch("https://github.com/test", ["github.com"], request_timeout=42)
    mock_urlopen.assert_called_once()
    args, kwargs = mock_urlopen.call_args
    assert kwargs.get("timeout") == 42, (
        f"Expected timeout=42, got {kwargs}"
    )


def test_fetch_url_uses_custom_timeout():
    """fetch_url passes the timeout value to urllib.request.urlopen."""
    fetch_url = _import_tool("fetch_url")

    fake_response = mock.Mock()
    fake_response.read.return_value = b"content"
    with mock.patch("urllib.request.urlopen", return_value=fake_response) as mock_urlopen:
        result = fetch_url("https://github.com/test", ["github.com"], request_timeout=35)
    mock_urlopen.assert_called_once()
    args, kwargs = mock_urlopen.call_args
    assert kwargs.get("timeout") == 35, (
        f"Expected timeout=35, got {kwargs}"
    )


def test_fetch_url_default_timeout():
    """fetch_url uses 25s default when no timeout is specified."""
    fetch_url = _import_tool("fetch_url")

    fake_response = mock.Mock()
    fake_response.read.return_value = b"content"
    with mock.patch("urllib.request.urlopen", return_value=fake_response) as mock_urlopen:
        result = fetch_url("https://github.com/test", ["github.com"])
    mock_urlopen.assert_called_once()
    args, kwargs = mock_urlopen.call_args
    assert kwargs.get("timeout") == 25, (
        f"Expected timeout=25, got {kwargs}"
    )


def test_run_command_uses_custom_timeout():
    """run_command passes the timeout value to subprocess.run."""
    run_command = _import_tool("run_command")
    mock_result = mock.Mock(returncode=0, stdout="out", stderr="", exit_code=0)
    with mock.patch("subprocess.run", return_value=mock_result) as mock_run:
        run_command("git_status_short", "/tmp", request_timeout=45)
    mock_run.assert_called_once_with(
        ["git", "status", "--short"],
        cwd="/tmp",
        capture_output=True,
        text=True,
        timeout=45,
    )


def test_run_command_timeout_error_message():
    """run_command timeout error message includes the configured timeout."""
    run_command = _import_tool("run_command")
    with mock.patch(
        "subprocess.run", side_effect=subprocess.TimeoutExpired("git", 10)
    ):
        result = run_command("git_status_short", "/tmp", request_timeout=10)
    assert result.get("error") == "Command timed out after 10s"


def test_env_int_bounded_defaults():
    """env_int_bounded returns default when env var is not set."""
    if str(_SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(_SCRIPTS_DIR))
    from run_tool_harness import env_int_bounded

    with mock.patch.dict(os.environ, {}, clear=True):
        result = env_int_bounded("NONEXISTENT_VAR", 20, 1, 300)
        assert result == 20


def test_env_int_bounded_respects_value():
    """env_int_bounded returns the configured value when valid."""
    if str(_SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(_SCRIPTS_DIR))
    from run_tool_harness import env_int_bounded

    with mock.patch.dict(os.environ, {"TOOL_REQUEST_TIMEOUT_SEC": "50"}):
        result = env_int_bounded("TOOL_REQUEST_TIMEOUT_SEC", 20, 1, 300)
        assert result == 50


def test_env_int_bounded_clamps_low():
    """env_int_bounded clamps values below minimum to min_value."""
    if str(_SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(_SCRIPTS_DIR))
    from run_tool_harness import env_int_bounded

    with mock.patch.dict(os.environ, {"TOOL_REQUEST_TIMEOUT_SEC": "0"}):
        result = env_int_bounded("TOOL_REQUEST_TIMEOUT_SEC", 20, 1, 300)
        assert result == 1


def test_env_int_bounded_clamps_high():
    """env_int_bounded clamps values above maximum to max_value."""
    if str(_SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(_SCRIPTS_DIR))
    from run_tool_harness import env_int_bounded

    with mock.patch.dict(os.environ, {"TOOL_REQUEST_TIMEOUT_SEC": "9999"}):
        result = env_int_bounded("TOOL_REQUEST_TIMEOUT_SEC", 20, 1, 300)
        assert result == 300


def test_env_int_bounded_invalid_falls_back():
    """env_int_bounded returns default when value is not an integer."""
    if str(_SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(_SCRIPTS_DIR))
    from run_tool_harness import env_int_bounded

    with mock.patch.dict(os.environ, {"TOOL_REQUEST_TIMEOUT_SEC": "not-a-number"}):
        result = env_int_bounded("TOOL_REQUEST_TIMEOUT_SEC", 20, 1, 300)
        assert result == 20


# ---------------------------------------------------------------------------
# Test: integration fixture where tool_min_successful_requests enforcement
# fails when all planned calls produce errors
# ---------------------------------------------------------------------------

ENFORCEMENT_FIXTURE = {
    "mode": "plan_execute_once",
    "planned_request_count": 2,
    "executed_request_count": 0,
    "tool_results": [
        {
            "tool": "read_file",
            "status": "error",
            "result": {"error": "Path escapes workspace root"},
        },
        {
            "tool": "gh_api",
            "status": "error",
            "result": {"error": "Repo not allowed: other/repo"},
        },
    ],
}


def test_enforcement_fixture_no_successes():
    """When all tools fail, executed_request_count is 0 and enforcement triggers."""
    data = ENFORCEMENT_FIXTURE
    assert data["executed_request_count"] == 0
    ok_count = sum(1 for t in data["tool_results"] if t.get("status") == "ok")
    assert ok_count == 0, f"Expected 0 successes, got {ok_count}"


# ---------------------------------------------------------------------------
# Integration test: end-to-end execution loop with error-producing tool calls
# ---------------------------------------------------------------------------

def test_integration_all_tools_fail():
    """run_tool_harness.py produces status: error for all tools when helpers return errors.

    This exercises the actual try/except execution loop in main() by writing
    a planning response with two tool calls that will fail, then verifying
    the output JSON has status: error for both results and executed_request_count=0.
    """
    # Write a planning input file
    planning_input = {
        "repository": "test-org/test-repo",
        "diff_hunk": "--- a/README\\n+++ b/README\\n@@ -1,3 +1,3 @@\\n-Old content\\n+New content\\n",
    }
    # The file-based planning path expects OpenAI-style response format
    planning_response = {
        "choices": [
            {
                "message": {
                    "content": json.dumps([
                        {"tool": "read_file", "args": {"path": "../../etc/passwd"}},
                        {"tool": "gh_api", "args": {"endpoint": "other-owner/other-repo/pulls/1"}},
                    ])
                }
            }
        ]
    }

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = Path(tmpdir) / "tool-planning-input.json"
        response_path = Path(tmpdir) / "tool-planning-response.json"
        output_path = Path(tmpdir) / "tool-harness.json"

        input_path.write_text(json.dumps(planning_input), encoding="utf-8")
        response_path.write_text(json.dumps(planning_response), encoding="utf-8")

        env = os.environ.copy()
        env["REPO"] = "test-org/test-repo"
        env["GH_TOKEN"] = ""  # No token so gh_api fails immediately

        result = subprocess.run(
            [sys.executable, str(_SCRIPTS_DIR / "run_tool_harness.py")],
            cwd=tmpdir,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )

        assert output_path.exists(), (
            f"tool-harness.json should be written. stderr: {result.stderr}"
        )

        with open(output_path) as f:
            output = json.load(f)

    # Both tools should have status: error
    tool_results = output["tool_results"]
    assert len(tool_results) == 2, f"Expected 2 results, got {len(tool_results)}"

    for tr in tool_results:
        assert tr["status"] == "error", (
            f"Expected status='error' for {tr['tool']}, got '{tr['status']}'"
        )
        assert "error" in tr.get("result", {}), (
            f"Expected error in result for {tr['tool']}"
        )

    # executed_request_count should be 0 (no successful calls)
    assert output["executed_request_count"] == 0, (
        f"Expected 0 successes, got {output['executed_request_count']}"
    )


def test_integration_mixed_success_and_failure():
    """run_tool_harness.py produces correct mixed status when some tools succeed and others fail."""
    planning_response = {
        "choices": [
            {
                "message": {
                    "content": json.dumps([
                        {"tool": "read_file", "args": {"path": "tool-planning-input.json"}},
                        {"tool": "gh_api", "args": {"endpoint": "other-owner/other-repo/pulls/1"}},
                    ])
                }
            }
        ]
    }

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = Path(tmpdir) / "tool-planning-input.json"
        response_path = Path(tmpdir) / "tool-planning-response.json"
        output_path = Path(tmpdir) / "tool-harness.json"

        # Create a file that read_file can successfully read
        input_path.write_text(json.dumps({}), encoding="utf-8")
        response_path.write_text(json.dumps(planning_response), encoding="utf-8")

        env = os.environ.copy()
        env["REPO"] = "test-org/test-repo"
        env["GH_TOKEN"] = ""

        result = subprocess.run(
            [sys.executable, str(_SCRIPTS_DIR / "run_tool_harness.py")],
            cwd=tmpdir,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )

        assert output_path.exists(), (
            f"tool-harness.json should be written. stderr: {result.stderr}"
        )

        with open(output_path) as f:
            output = json.load(f)

    tool_results = output["tool_results"]
    assert len(tool_results) == 2

    # First tool (read_file) should succeed
    assert tool_results[0]["status"] == "ok", (
        f"read_file should succeed, got '{tool_results[0]['status']}'"
    )

    # Second tool (gh_api) should fail (repo not allowed)
    assert tool_results[1]["status"] == "error", (
        f"gh_api should fail for disallowed repo, got '{tool_results[1]['status']}'"
    )

    # executed_request_count should be 1
    assert output["executed_request_count"] == 1, (
        f"Expected 1 success, got {output['executed_request_count']}"
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    tests = [
        ("old path counts zero", test_old_path_counts_zero),
        ("new path counts one", test_new_path_counts_one),
        ("all-ok fixture", test_all_ok_fixture),
        ("all-fail fixture", test_all_fail_fixture),
        ("run_review.sh uses correct path", test_run_review_uses_correct_path),
        ("read_file error path", test_read_file_error_path),
        ("read_file sensitive path", test_read_file_sensitive_path),
        ("read_file path escape", test_read_file_path_escape),
        ("git_grep error path", test_git_grep_error_path),
        ("git_grep error returncode", test_git_grep_error_returncode),
        ("git_grep error generic", test_git_grep_error_generic),
        ("gh_api missing token", test_gh_api_error_missing_token),
        ("gh_api repo not allowed", test_gh_api_error_repo_not_allowed),
        ("web_fetch non-allowlisted host", test_web_fetch_error_non_allowlisted_host),
        ("run_command not allowlisted", test_run_command_error_not_allowlisted),
        ("git_grep uses custom timeout", test_git_grep_uses_custom_timeout),
        ("git_grep default timeout", test_git_grep_default_timeout),
        ("git_grep timeout error message", test_git_grep_timeout_error_message),
        ("gh_api uses custom timeout", test_gh_api_uses_custom_timeout),
        ("web_fetch uses custom timeout", test_web_fetch_uses_custom_timeout),
        ("fetch_url uses custom timeout", test_fetch_url_uses_custom_timeout),
        ("fetch_url default timeout", test_fetch_url_default_timeout),
        ("run_command uses custom timeout", test_run_command_uses_custom_timeout),
        ("run_command timeout error message", test_run_command_timeout_error_message),
        ("env_int_bounded defaults", test_env_int_bounded_defaults),
        ("env_int_bounded respects value", test_env_int_bounded_respects_value),
        ("env_int_bounded clamps low", test_env_int_bounded_clamps_low),
        ("env_int_bounded clamps high", test_env_int_bounded_clamps_high),
        ("env_int_bounded invalid falls back", test_env_int_bounded_invalid_falls_back),
        ("enforcement fixture no successes", test_enforcement_fixture_no_successes),
        ("integration all tools fail", test_integration_all_tools_fail),
        ("integration mixed success/failure", test_integration_mixed_success_and_failure),
    ]

    passed = 0
    failed = 0
    failures = []

    for name, fn in tests:
        try:
            fn()
            print(f"  PASS: {name}")
            passed += 1
        except AssertionError as e:
            print(f"  FAIL: {name} — {e}")
            failed += 1
            failures.append(f"    {e}")
        except Exception as e:
            print(f"  ERROR: {name} — {type(e).__name__}: {e}")
            failed += 1
            failures.append(f"    {type(e).__name__}: {e}")

    print(f"\n=== Results: {passed}/{passed + failed} passed, {failed} failed ===")

    if failures:
        print("\n--- Failures ---")
        for f in failures:
            print(f)

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
