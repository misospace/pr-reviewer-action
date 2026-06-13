#!/usr/bin/env bash
set -uo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Wiring contracts for tool_mode=plan_execute_loop (#192). Loop decision
# helpers are covered in tests/test_tool_loop.py.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
check_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  PASS: $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected to contain '$needle')"; FAIL=$((FAIL + 1))
  fi
}

SRC="$(cat "$ROOT_DIR/scripts/run_review.sh")"
ACTION="$(cat "$ROOT_DIR/action.yml")"
HARNESS="$(cat "$ROOT_DIR/scripts/run_tool_harness.py")"

echo "=== run_review.sh accepts the loop modes ==="
check_contains "mode validation accepts plan_execute_loop" "$SRC" "off|plan_execute_once|plan_execute_loop|native_loop)"
check_contains "harness pending stub covers loop mode" "$SRC" "plan_execute_once|plan_execute_loop|native_loop)"
check_contains "loop mode runs the harness" "$SRC" 'plan_execute_once|plan_execute_loop|native_loop) TOOL_HARNESS_ENABLED="true"'

echo ""
echo "=== action.yml wiring ==="
check_contains "tool_max_rounds input declared" "$ACTION" "tool_max_rounds:"
check_contains "TOOL_MAX_ROUNDS passed to steps" "$ACTION" 'TOOL_MAX_ROUNDS: ${{ inputs.tool_max_rounds }}'
check_contains "tool_mode description mentions the loop" "$ACTION" "plan_execute_loop"
check_contains "tool_mode description mentions native_loop" "$ACTION" "native_loop"
check_contains "tool_loop_wall_clock_sec input declared" "$ACTION" "tool_loop_wall_clock_sec:"
check_contains "TOOL_LOOP_WALL_CLOCK_SEC passed to steps" "$ACTION" 'TOOL_LOOP_WALL_CLOCK_SEC: ${{ inputs.tool_loop_wall_clock_sec }}'

echo ""
echo "=== harness loop contracts ==="
check_contains "rounds bounded by TOOL_MAX_ROUNDS" "$HARNESS" 'env_int_bounded("TOOL_MAX_ROUNDS", 3, 1, 6)'
check_contains "single round unless loop mode" "$HARNESS" 'if loop_mode else 1'
check_contains "budget is total across rounds" "$HARNESS" "budget = max_requests"
check_contains "requests deduplicated across rounds" "$HARNESS" "dedup_requests(normalized, seen_keys)"
check_contains "results fed back as untrusted data" "$HARNESS" "UNTRUSTED DATA"
check_contains "later-round parse failure degrades gracefully" "$HARNESS" "using evidence so far"
check_contains "planner can stop with empty requests" "$HARNESS" 'reply exactly {"requests": []}'

echo ""
echo "=== native_loop wiring ==="
check_contains "native_loop dispatches to run_native_loop" "$HARNESS" 'if tool_mode == "native_loop":'
check_contains "native_loop degrades to plan_execute_loop" "$HARNESS" 'tool_mode = "plan_execute_loop"'
check_contains "wall-clock budget bounded" "$HARNESS" 'env_int_bounded("TOOL_LOOP_WALL_CLOCK_SEC"'
check_contains "native loop driver imported lazily" "$HARNESS" "from pr_reviewer.tool_loop import"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
