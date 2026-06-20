#!/usr/bin/env python3
"""Tests for run_tool_harness.execute_tool_requests — parallel execution must
preserve request order and per-request error isolation."""

import sys
import threading
import time
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import pytest

import run_tool_harness as rth  # noqa: F401  (kept for execute_tool_requests re-export)
from pr_reviewer import tool_executors


def _call(requests, fake_execute):
    # execute_tool_request[s] now live in pr_reviewer.tool_executors (#304 split);
    # execute_tool_requests calls the module-local execute_tool_request, so the
    # fake must be patched there to be invoked.
    with mock.patch.object(tool_executors, "execute_tool_request", fake_execute):
        return rth.execute_tool_requests(
            requests,
            workspace_root="/tmp",
            allowed_gh_repos=set(),
            current_repo="acme/app",
            allowed_hosts=["github.com"],
            max_response_bytes=1000,
            request_timeout=5,
        )


class TestExecuteToolRequests:
    def test_results_preserve_request_order(self):
        # The first request is the slowest; results must still come back in
        # request order, not completion order.
        def fake_execute(tool_name, args, *rest):
            if tool_name == "slow":
                time.sleep(0.3)
            return {"tool": tool_name, "status": "ok", "result": {}}

        requests = [("slow", {}), ("fast1", {}), ("fast2", {})]
        results = _call(requests, fake_execute)
        assert [r["tool"] for r in results] == ["slow", "fast1", "fast2"]

    def test_requests_run_concurrently(self):
        barrier = threading.Barrier(2, timeout=5)

        def fake_execute(tool_name, args, *rest):
            # Both requests must be in flight at once to pass the barrier.
            barrier.wait()
            return {"tool": tool_name, "status": "ok", "result": {}}

        results = _call([("a", {}), ("b", {})], fake_execute)
        assert len(results) == 2

    def test_single_request_runs_inline(self):
        seen_threads = []

        def fake_execute(tool_name, args, *rest):
            seen_threads.append(threading.current_thread().name)
            return {"tool": tool_name, "status": "ok", "result": {}}

        results = _call([("only", {})], fake_execute)
        assert len(results) == 1
        assert seen_threads == [threading.main_thread().name]

    def test_empty_requests(self):
        assert _call([], lambda *a: None) == []

    def test_real_executor_errors_stay_per_request(self):
        # Unknown tool produces an error result without breaking the others.
        results = rth.execute_tool_requests(
            [("nonsense_tool", {}), ("git_grep", {"pattern": ""})],
            workspace_root="/tmp",
            allowed_gh_repos=set(),
            current_repo="acme/app",
            allowed_hosts=[],
            max_response_bytes=1000,
            request_timeout=5,
        )
        assert results[0]["status"] == "error"
        assert "Unknown tool" in results[0]["result"]["error"]
        assert results[1]["status"] == "error"
        assert "pattern" in results[1]["result"]["error"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
