"""Tests for normalize_tool_request: tolerance of common planner output mistakes."""

import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from run_tool_harness import normalize_tool_request  # noqa: E402


def test_well_formed_request_passes_through():
    tool, args = normalize_tool_request(
        {"tool": "read_file", "args": {"path": "values.yaml"}}
    )
    assert tool == "read_file"
    assert args == {"path": "values.yaml"}


def test_top_level_params_promoted_into_args():
    # Planner emitted the param at the top level instead of nesting under args.
    tool, args = normalize_tool_request({"tool": "read_file", "path": "charts/app.yaml"})
    assert tool == "read_file"
    assert args.get("path") == "charts/app.yaml"


def test_gh_api_path_aliases_to_endpoint():
    # The prompt now says "endpoint", but tolerate the old "path" key too.
    tool, args = normalize_tool_request(
        {"tool": "gh_api", "args": {"path": "repos/acme/app/releases/tags/v1.2.3"}}
    )
    assert tool == "gh_api"
    assert args.get("endpoint") == "repos/acme/app/releases/tags/v1.2.3"


def test_gh_api_top_level_path_promoted_and_aliased():
    tool, args = normalize_tool_request(
        {"tool": "gh_api", "endpoint": "repos/acme/app/pulls/5"}
    )
    assert tool == "gh_api"
    assert args.get("endpoint") == "repos/acme/app/pulls/5"


def test_name_key_accepted_as_tool():
    tool, _ = normalize_tool_request({"name": "git_grep", "args": {"pattern": "x"}})
    assert tool == "git_grep"


def test_non_dict_returns_empty():
    assert normalize_tool_request("read_file") == ("", {})
    assert normalize_tool_request(None) == ("", {})


def test_git_grep_nested_optional_args_preserved():
    # #568: model-emitted git_grep optional args (path/max_results) must pass
    # through normalization untouched so they reach the executor.
    tool, args = normalize_tool_request(
        {
            "tool": "git_grep",
            "args": {"pattern": "load_config", "path": "pr_reviewer", "max_results": 40},
        }
    )
    assert tool == "git_grep"
    assert args == {"pattern": "load_config", "path": "pr_reviewer", "max_results": 40}


def test_git_grep_top_level_max_results_promoted():
    # A model that flattens params to the top level (like the string params)
    # still has its integer max_results forwarded.
    tool, args = normalize_tool_request(
        {"tool": "git_grep", "args": {"pattern": "x"}, "max_results": 25}
    )
    assert tool == "git_grep"
    assert args["max_results"] == 25


def test_git_grep_max_results_only_promoted_for_git_grep():
    # The top-level max_results promotion is scoped to git_grep so it can't
    # leak into other tools' args.
    tool, args = normalize_tool_request(
        {"tool": "read_file", "args": {"path": "a.yaml"}, "max_results": 25}
    )
    assert tool == "read_file"
    assert "max_results" not in args


def test_explicit_endpoint_not_overwritten_by_path():
    tool, args = normalize_tool_request(
        {"tool": "gh_api", "args": {"endpoint": "repos/a/b/pulls/1", "path": "repos/x/y/pulls/2"}}
    )
    assert args.get("endpoint") == "repos/a/b/pulls/1"


def test_repo_contents_top_level_arguments_are_hoisted():
    tool, args = normalize_tool_request(
        {"tool": "repo_contents", "repo": "acme/app", "path": "src", "ref": "v1", "max_entries": 9}
    )
    assert tool == "repo_contents"
    assert args == {"repo": "acme/app", "path": "src", "ref": "v1", "max_entries": 9}


if __name__ == "__main__":
    import pytest

    pytest.main([__file__, "-v"])
