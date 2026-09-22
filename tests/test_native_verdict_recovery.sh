#!/usr/bin/env bash
set -uo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Wiring contracts for native-loop verdict recovery (#637): an unusable
# in-conversation verdict must emit a specific diagnostic and leave the
# standard final review as the correctness fallback instead of silently
# claiming success and skipping it.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

REVIEW="$(cat "$ROOT_DIR/scripts/sections/review.sh")"
HARNESS="$(cat "$ROOT_DIR/scripts/run_tool_harness.py")"
CONTRACT="$(cat "$ROOT_DIR/tests/test_verdict_contract.sh")"

echo "=== review.sh consumes the validated native verdict ==="
check_contains "gate still keys off the produced flag" "$REVIEW" "native_loop_verdict_produced // false"
check_contains "reads the harness verdict status" "$REVIEW" "native_loop_verdict_status // empty"
check_contains "reads the harness verdict reason" "$REVIEW" "native_loop_verdict_reason // empty"
check_contains "missing artifact is a distinct diagnostic" "$REVIEW" "flagged a verdict but ai-response.primary.json is missing or empty"
check_contains "fallback path names the harness reason" "$REVIEW" 'native_loop did not produce a reusable in-conversation verdict'
check_contains "parse failure diagnostic names the reason" "$REVIEW" 'native_loop verdict did not parse'

echo ""
echo "=== the standard review call is not suppressed ==="
check_contains "standard call remains guarded by NATIVE_VERDICT_USED" "$REVIEW" 'if [ "$NATIVE_VERDICT_USED" -ne 1 ]; then'
check_contains "standard call still invokes call_model_tier primary" "$REVIEW" 'call_model_tier primary'

echo ""
echo "=== step summary exposes verdict attempts/retries ==="
check_contains "step summary has a native verdict row" "$REVIEW" "| Native verdict |"
check_contains "step summary reports attempts" "$REVIEW" 'attempts: ${native_verdict_attempts}'

echo ""
echo "=== harness validates BEFORE claiming success (#637) ==="
check_contains "harness classifies the verdict against the final contract" "$HARNESS" "def evaluate_native_verdict("
check_contains "harness consumes the final parser" "$HARNESS" "from pr_reviewer.response_parser import"
check_contains "harness drives a content-aware retry" "$HARNESS" "def produce_native_verdict("
check_contains "retry is non-streamed" "$HARNESS" 'retry_payload["stream"] = False'
check_contains "produced flag requires contract check and live deadline" "$HARNESS" 'if verdict["ok"] and (deadline is None or time.monotonic() < deadline):'
check_contains "a produced verdict requires a reusable body" "$HARNESS" 'result["native_loop_verdict_produced"] = True'

echo ""
echo "=== existing verdict-contract suite still references the equivalence test ==="
check_contains "contract suite pinpoints the Python equivalence test" "$CONTRACT" "tests/test_verdict_contract_equivalence.py"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
