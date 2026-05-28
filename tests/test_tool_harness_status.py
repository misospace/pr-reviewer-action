"""Regression tests for issue #53: tool harness fail-closed status accounting.

The bug: run_review.sh checked `.tool_results[].result.status` but
run_tool_harness.py writes status at `.tool_results[].status`.

This means successful tool calls were counted as failures under
fail-closed settings (tool_failure_enforcement=true, tool_min_successful_requests>0),
causing spurious request_changes verdicts.

Acceptance criteria:
  - The corrected jq path reads from .tool_results[].status == "ok".
  - A regression fixture with at least one successful tool result and fail-closed
    settings demonstrates the old path fails and the new path passes.
  - Existing review parsing/model tests still pass.
"""

import json
import subprocess
import sys
from pathlib import Path


def _jq(expr, json_str):
    """Run a jq expression against a JSON string and return stdout."""
    result = subprocess.run(
        ["jq", "-r", expr],
        input=json_str,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"jq failed: {result.stderr.strip()}")
    return result.stdout.strip()


def _jq_count(expr, json_str):
    """Run a jq expression that returns a number."""
    raw = _jq(expr, json_str)
    try:
        return int(raw)
    except ValueError:
        return 0


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
    data = json.dumps(FIXTURE_TOOL_HARNESS)

    # This is the OLD buggy expression from run_review.sh line ~1123:
    successful = _jq_count(
        '[.tool_results[]?.result.status == "ok"] | map(select(. == true)) | length',
        data,
    )
    assert successful == 0, (
        f"Old path should count 0 successes for tool results with .status field, "
        f"got {successful}"
    )

    # The old path also fails the "any ok" check used in TOOL_FAILURE_REASON:
    any_ok_old = _jq(
        '([.tool_results[]?.result.status == "ok"] | any)',
        data,
    )
    assert any_ok_old == "false", (
        f"Old path should find no 'ok' results, got {any_ok_old}"
    )


# ---------------------------------------------------------------------------
# Test: New (fixed) path counts 1 success → passes fail-closed check
# ---------------------------------------------------------------------------

def test_new_path_counts_one():
    """The fixed jq expression `.tool_results[].status` finds the correct count."""
    data = json.dumps(FIXTURE_TOOL_HARNESS)

    # This is the FIXED expression:
    successful = _jq_count(
        '[.tool_results[]?.status == "ok"] | map(select(. == true)) | length',
        data,
    )
    assert successful == 1, (
        f"New path should count 1 success for tool results with .status='ok', "
        f"got {successful}"
    )

    # The new path finds at least one 'ok' in the any check:
    any_ok_new = _jq(
        '([.tool_results[]?.status == "ok"] | any)',
        data,
    )
    assert any_ok_new == "true", (
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
    data = json.dumps(ALL_OK_FIXTURE)

    old_count = _jq_count(
        '[.tool_results[]?.result.status == "ok"] | map(select(. == true)) | length',
        data,
    )
    new_count = _jq_count(
        '[.tool_results[]?.status == "ok"] | map(select(. == true)) | length',
        data,
    )
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
    data = json.dumps(ALL_FAIL_FIXTURE)

    old_count = _jq_count(
        '[.tool_results[]?.result.status == "ok"] | map(select(. == true)) | length',
        data,
    )
    new_count = _jq_count(
        '[.tool_results[]?.status == "ok"] | map(select(. == true)) | length',
        data,
    )
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
# Main
# ---------------------------------------------------------------------------

def main():
    tests = [
        ("old path counts zero", test_old_path_counts_zero),
        ("new path counts one", test_new_path_counts_one),
        ("all-ok fixture", test_all_ok_fixture),
        ("all-fail fixture", test_all_fail_fixture),
        ("run_review.sh uses correct path", test_run_review_uses_correct_path),
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
