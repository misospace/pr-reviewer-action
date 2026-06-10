#!/usr/bin/env python3
"""Tests for the plan→execute loop helpers in run_tool_harness.py (#192)."""

import sys
from pathlib import Path

import pytest

# Ensure the scripts directory is on sys.path.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from run_tool_harness import (  # noqa: E402
    build_results_feedback,
    dedup_requests,
    parse_planned_requests,
    request_key,
)


class TestRequestKey:
    def test_stable_across_arg_order(self):
        a = request_key("gh_api", {"endpoint": "repos/a/b", "x": 1})
        b = request_key("gh_api", {"x": 1, "endpoint": "repos/a/b"})
        assert a == b

    def test_distinguishes_tools_and_args(self):
        assert request_key("read_file", {"path": "a"}) != request_key("read_file", {"path": "b"})
        assert request_key("read_file", {"path": "a"}) != request_key("git_grep", {"path": "a"})


class TestDedupRequests:
    def test_drops_repeats_across_rounds(self):
        seen = set()
        first = dedup_requests([("read_file", {"path": "a"}), ("read_file", {"path": "b"})], seen)
        assert len(first) == 2
        second = dedup_requests(
            [("read_file", {"path": "a"}), ("git_grep", {"pattern": "x"})], seen
        )
        assert second == [("git_grep", {"pattern": "x"})]

    def test_drops_repeats_within_a_round(self):
        seen = set()
        fresh = dedup_requests(
            [("read_file", {"path": "a"}), ("read_file", {"path": "a"})], seen
        )
        assert len(fresh) == 1


class TestParsePlannedRequests:
    def test_requests_object(self):
        reqs, done = parse_planned_requests('{"requests": [{"tool": "read_file", "args": {"path": "a"}}]}')
        assert len(reqs) == 1 and done is False

    def test_empty_requests_signals_done(self):
        reqs, done = parse_planned_requests('{"requests": []}')
        assert reqs == [] and done is True

    def test_bare_done_signals_done(self):
        for text in ("DONE", "done", " Done. "):
            reqs, done = parse_planned_requests(text)
            assert reqs == [] and done is True

    def test_bare_list_accepted(self):
        reqs, done = parse_planned_requests('[{"tool": "git_grep", "args": {"pattern": "x"}}]')
        assert len(reqs) == 1 and done is False

    def test_prose_wrapped_json_extracted(self):
        reqs, done = parse_planned_requests(
            'Sure! Here is my plan:\n{"requests": [{"tool": "read_file", "args": {"path": "a"}}]}'
        )
        assert len(reqs) == 1 and done is False

    def test_unparseable_raises(self):
        with pytest.raises(ValueError):
            parse_planned_requests("I need to look at some files first.")

    def test_object_without_requests_raises(self):
        with pytest.raises(ValueError):
            parse_planned_requests('{"plan": "read everything"}')


class TestBuildResultsFeedback:
    def test_marks_results_untrusted_and_caps(self):
        executed = [
            (("read_file", {"path": "a"}), {"status": "ok", "result": {"content": "x" * 5000}}),
            (("gh_api", {"endpoint": "repos/a/b"}), {"status": "error", "result": {"error": "404"}}),
        ]
        text = build_results_feedback(executed, 2000)
        assert "UNTRUSTED DATA" in text
        assert "read_file" in text and "gh_api" in text
        assert len(text.encode("utf-8")) <= 2100  # cap plus truncation marker

    def test_empty_results(self):
        text = build_results_feedback([], 1000)
        assert "UNTRUSTED DATA" in text


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
