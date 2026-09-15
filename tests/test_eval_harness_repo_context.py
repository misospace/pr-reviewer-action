from __future__ import annotations

import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from eval_harness import BenchmarkCorpus, ReviewRun, evaluate_capability


CORPUS_PATH = Path(__file__).resolve().parent.parent / "evals" / "corpus-repo-context.json"
RECOGNIZED_TYPES = {"tool_call", "review_mentions", "max_tool_calls"}


def corpus() -> BenchmarkCorpus:
    return BenchmarkCorpus.from_file(CORPUS_PATH)


def scenario(number: int) -> dict:
    return next(pr for pr in corpus().prs if pr["number"] == number)


def run(number: int, review_markdown: str = "", tool_calls: list[dict] | None = None) -> ReviewRun:
    entry = scenario(number)
    return ReviewRun(
        mode="native_loop",
        pr_number=number,
        repo_full_name=entry["repo_full_name"],
        review_markdown=review_markdown,
        tool_calls=tool_calls or [],
    )


def call(tool: str, path: str, status: str = "ok") -> dict:
    return {"tool": tool, "args": {"path": path}, "status": status}


def check(run_number: int, run_value: ReviewRun) -> dict:
    return evaluate_capability(run_value, scenario(run_number)["expected_evidence"])


def test_repo_context_corpus_schema_and_load() -> None:
    loaded = corpus()
    assert [pr["number"] for pr in loaded.prs] == [598, 600, 601, 599]
    assert len(loaded.prs) == 4
    assert all(pr["repo_full_name"] == "misospace/pr-reviewer-action" for pr in loaded.prs)
    assert [pr["url"] for pr in loaded.prs] == [
        f"https://github.com/misospace/pr-reviewer-action/pull/{number}"
        for number in [598, 600, 601, 599]
    ]

    for pr in loaded.prs:
        assert {"number", "repo_full_name", "url", "title", "known_findings", "expected_evidence"} <= pr.keys()
        expected = pr["expected_evidence"]
        assert isinstance(expected.get("description"), str)
        assert "grader-only" in expected["description"].lower()
        assert "recipe" in expected["description"].lower()
        assert expected["checks"]
        for item in expected["checks"]:
            assert item["type"] in RECOGNIZED_TYPES
            assert item.get("id")
            if item["type"] == "tool_call":
                assert item.get("tool")
            elif item["type"] == "review_mentions":
                assert item.get("any_of")
            else:
                assert item.get("max") is not None


def test_discovery_and_auth_read_scenario_passes() -> None:
    result = check(
        598,
        run(
            598,
            "Reviewed the repository discovery behavior and list_tree tool.",
            [
                call("list_tree", "pr_reviewer"),
                call("read_file", "pr_reviewer/tool_executors.py"),
            ],
        ),
    )
    assert result["passed"] is True


def test_discovery_and_auth_read_scenario_fails_without_chain() -> None:
    result = check(
        598,
        run(598, "The change looks good.", [call("read_file", "pr_reviewer/tool_executors.py")]),
    )
    assert result["passed"] is False
    assert {item["id"] for item in result["checks"] if not item["passed"]} == {
        "discover_tool_executors_path",
        "mentions_repository_discovery_context",
    }


def test_find_files_is_an_accepted_discovery_path() -> None:
    result = check(
        598,
        run(
            598,
            "The repository discovery tool preserves the list_tree behavior.",
            [
                call("find_files", "pr_reviewer/tool_executors.py"),
                call("read_file", "pr_reviewer/tool_executors.py"),
            ],
        ),
    )
    assert result["passed"] is True


def test_unrelated_discovery_or_path_does_not_satisfy_tool_executors_scenario() -> None:
    result = check(
        598,
        run(
            598,
            "The patch is acceptable.",
            [
                call("list_tree", "src/billing"),
                call("read_file", "src/billing/policy.py"),
            ],
        ),
    )
    assert result["passed"] is False
    assert {item["id"] for item in result["checks"] if not item["passed"]} == {
        "read_tool_executors_path",
        "mentions_repository_discovery_context",
    }


def test_related_test_scenario_passes_and_fails() -> None:
    passing = check(
        600,
        run(
            600,
            "The related test covers the scanner regression.",
            [call("read_file", "tests/test_related_context.py")],
        ),
    )
    failing = check(
        600,
        run(
            600,
            "The patch is sound.",
            [call("read_file", "pr_reviewer/related_context.py")],
        ),
    )
    assert passing["passed"] is True
    assert {item["id"] for item in failing["checks"] if not item["passed"]} == {
        "read_related_test_path",
        "mentions_related_test",
    }


def test_unrelated_tool_and_path_do_not_satisfy_related_test() -> None:
    result = check(
        600,
        run(
            600,
            "The test coverage is adequate.",
            [call("list_tree", "tests"), call("read_file", "docs/release-notes.md")],
        ),
    )
    assert result["passed"] is False
    assert {item["id"] for item in result["checks"] if not item["passed"]} == {"read_related_test_path"}


def test_downstream_caller_scenario_passes_and_fails() -> None:
    passing = check(
        601,
        run(
            601,
            "The downstream caller path in corpus.sh preserves the contract.",
            [call("read_file", "scripts/sections/corpus.sh")],
        ),
    )
    failing = check(
        601,
        run(
            601,
            "The helper refactor is clean.",
            [call("read_file", "pr_reviewer/related_context.py")],
        ),
    )
    assert passing["passed"] is True
    assert {item["id"] for item in failing["checks"] if not item["passed"]} == {
        "read_downstream_caller_path",
        "mentions_caller_contract_downstream",
    }


def test_unrelated_tool_and_path_do_not_satisfy_downstream_caller() -> None:
    result = check(
        601,
        run(
            601,
            "The patch is acceptable.",
            [call("find_files", "pr_reviewer"), call("read_file", "pr_reviewer/other.py")],
        ),
    )
    assert result["passed"] is False
    assert {item["id"] for item in result["checks"] if not item["passed"]} == {
        "read_downstream_caller_path",
        "mentions_caller_contract_downstream",
    }


def test_max_tool_calls_threshold_is_deterministic() -> None:
    under = check(599, run(599, "Clean change; approve.", [call("list_tree", "src")] * 3))
    over = check(599, run(599, "Clean change; approve.", [call("list_tree", "src")] * 4))
    assert under["passed"] is True
    assert over["passed"] is False
    assert any(item["id"] == "limits_unnecessary_tool_calls" and not item["passed"] for item in over["checks"])


def test_errored_run_fails_repository_context_checks() -> None:
    errored = run(599, "Clean change; approve.", [])
    errored.error = "review failed"
    result = check(599, errored)
    assert result["passed"] is False
    assert not any(item["passed"] for item in result["checks"])


def test_old_agentic_canonical_behavior_is_unchanged() -> None:
    old_path = CORPUS_PATH.parent / "corpus-agentic.json"
    old_corpus = BenchmarkCorpus.from_file(old_path)
    canonical = next(pr for pr in old_corpus.prs if pr["number"] == 7462)
    passing = ReviewRun(
        mode="native_loop",
        pr_number=7462,
        repo_full_name=canonical["repo_full_name"],
        review_markdown="Verified against the Talos support matrix.",
        tool_calls=[
            call("read_file", "talos/main/machineconfig.yaml.j2"),
            {"tool": "web_fetch", "args": {"url": "https://www.talos.dev/support-matrix"}, "status": "ok"},
        ],
    )
    failing = ReviewRun(
        mode="native_loop",
        pr_number=7462,
        repo_full_name=canonical["repo_full_name"],
        review_markdown="Patch bump, approve.",
    )
    assert evaluate_capability(passing, canonical["expected_evidence"])["passed"] is True
    assert evaluate_capability(failing, canonical["expected_evidence"])["passed"] is False


@pytest.mark.parametrize(
    "count, maximum, expected_passed",
    [(0, 0, True), (1, 0, False), (1, 1, True), (2, 1, False)],
)
def test_max_tool_calls_zero_and_one_call_boundaries(
    count: int, maximum: int, expected_passed: bool
) -> None:
    expected = {"checks": [{"id": "limit", "type": "max_tool_calls", "max": maximum}]}
    result = evaluate_capability(run(599, "approve", [call("list_tree", "src")] * count), expected)
    assert result["passed"] is expected_passed


def test_max_tool_calls_counts_failed_requests() -> None:
    expected = {"checks": [{"id": "limit", "type": "max_tool_calls", "max": 1}]}
    result = evaluate_capability(
        run(599, "approve", [call("list_tree", "src", status="error")]), expected
    )
    assert result["passed"] is True


@pytest.mark.parametrize("bad_max", [True, 3.0, "3"])
def test_max_tool_calls_requires_integer_limit(bad_max: object) -> None:
    expected = {"checks": [{"id": "limit", "type": "max_tool_calls", "max": bad_max}]}
    result = evaluate_capability(run(599, "approve"), expected)
    assert result["passed"] is False


def test_max_tool_calls_rejects_none_runtime_trace() -> None:
    expected = {"checks": [{"id": "limit", "type": "max_tool_calls", "max": 0}]}
    malformed = run(599, "approve")
    malformed.tool_calls = None  # type: ignore[assignment]
    result = evaluate_capability(malformed, expected)
    assert result["passed"] is False
