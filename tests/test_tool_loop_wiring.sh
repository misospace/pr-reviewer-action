#!/usr/bin/env bash
set -uo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Wiring contracts for tool_mode=native_loop (#197 §1). The plan_execute_*
# planner modes were removed in 2.0 (#304); native_loop is the only tool mode.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

SRC="$(cat "$ROOT_DIR/scripts/run_review.sh" "$ROOT_DIR"/scripts/sections/*.sh)"
ACTION="$(cat "$ROOT_DIR/action.yml")"
HARNESS="$(cat "$ROOT_DIR/scripts/run_tool_harness.py")"

echo "=== run_review.sh accepts only off|native_loop ==="
check_contains "mode validation accepts native_loop only" "$SRC" "off|native_loop)"
check_contains "stale plan_execute_* degrades to off" "$SRC" "plan_execute_once|plan_execute_loop)"
check_contains "harness pending stub covers native_loop" "$SRC" "    native_loop)"
check_contains "native_loop runs the harness" "$SRC" 'native_loop) TOOL_HARNESS_ENABLED="true"'

echo ""
echo "=== action.yml wiring ==="
check_contains "tool_max_rounds input declared" "$ACTION" "tool_max_rounds:"
check_contains "TOOL_MAX_ROUNDS passed to steps" "$ACTION" 'TOOL_MAX_ROUNDS: ${{ inputs.tool_max_rounds }}'
check_contains "tool_mode description mentions native_loop" "$ACTION" "native_loop"
check_contains "tool_loop_wall_clock_sec input declared" "$ACTION" "tool_loop_wall_clock_sec:"
check_contains "TOOL_LOOP_WALL_CLOCK_SEC passed to steps" "$ACTION" 'TOOL_LOOP_WALL_CLOCK_SEC: ${{ inputs.tool_loop_wall_clock_sec }}'

echo ""
echo "=== native_loop harness contracts ==="
check_contains "harness drives the native loop" "$HARNESS" "handled = run_native_loop("
check_contains "round budget bounded by TOOL_MAX_ROUNDS" "$HARNESS" 'env_int_bounded("TOOL_MAX_ROUNDS"'
check_contains "wall-clock budget bounded" "$HARNESS" 'env_int_bounded("TOOL_LOOP_WALL_CLOCK_SEC"'
check_contains "native loop driver imported lazily" "$HARNESS" "from pr_reviewer.tool_loop import"
check_contains "no-tool-call run degrades to a corpus-only review" "$HARNESS" "if not handled:"
check_contains "degrade still records native_loop mode" "$HARNESS" 'result["mode"] = "native_loop"'

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
