#!/usr/bin/env bash
set -uo pipefail

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown})" >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0
FAIL=0
source "$SCRIPT_DIR/_lib/assert.sh"

REVIEW="$ROOT_DIR/scripts/sections/review.sh"
ACTION="$ROOT_DIR/action.yml"
check_contains "review emits tool_calls output" "$(cat "$REVIEW")" 'echo "tool_calls<<$TC_DELIM"'
check_contains "tool_calls output projects tool and status" "$(cat "$REVIEW")" '.tool_calls[]? | {tool, status}'
check_contains "step summary reports executed tool count" "$(cat "$REVIEW")" 'Tool calls | ${tool_call_count} executed'
check_contains "action exposes tool_calls output" "$(cat "$ACTION")" 'tool_calls:'

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
