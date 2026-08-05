#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

ACTION_YML="$(cd "$SCRIPT_DIR/.." && pwd)/action.yml"
HELPERS="$(cd "$SCRIPT_DIR/.." && pwd)/scripts/publish_helpers.sh"

echo "=== resolve_finding_threads action wiring ==="

# Both publish steps call resolve_finding_threads
count=$(grep -c "resolve_finding_threads" "$ACTION_YML")
check "both publish steps resolve threads" "$count" "2"

# Resolution precedes comment build in both publish steps
first_build=$(grep -n "build_review_comments.py" "$ACTION_YML" | head -1 | cut -d: -f1)
first_resolve=$(grep -n "resolve_finding_threads" "$ACTION_YML" | head -1 | cut -d: -f1)
if [[ "$first_resolve" -lt "$first_build" ]]; then
  echo "  PASS: resolution precedes comment build (first pair)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: resolution precedes comment build (first pair) ($first_resolve >= $first_build)"
  FAIL=$((FAIL + 1))
fi

second_build=$(grep -n "build_review_comments.py" "$ACTION_YML" | tail -1 | cut -d: -f1)
second_resolve=$(grep -n "resolve_finding_threads" "$ACTION_YML" | tail -1 | cut -d: -f1)
if [[ "$second_resolve" -lt "$second_build" ]]; then
  echo "  PASS: resolution precedes comment build (second pair)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: resolution precedes comment build (second pair) ($second_resolve >= $second_build)"
  FAIL=$((FAIL + 1))
fi

# Builders receive suppression file
supp_count=$(grep -c "SUPPRESS_FINDINGS_FILE=finding-threads.json" "$ACTION_YML")
check "both builders receive suppression file" "$supp_count" "2"

# Helper gates on inline findings and carryover
check_contains "helper defines resolve_finding_threads function" "$(cat "$HELPERS")" "resolve_finding_threads()"
check_contains "helper references previous-findings.json" "$(cat "$HELPERS")" "previous-findings.json"
check_contains "helper checks INLINE_FINDINGS" "$(cat "$HELPERS")" "INLINE_FINDINGS"
# Stale suppression from a previous step must not leak.
check_contains "helper cleans stale suppression file" "$(cat "$HELPERS")" "rm -f finding-threads.json"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
