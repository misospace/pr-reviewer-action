#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Wiring tests for required-check validation (#157/#158) and the
# build_metadata_marker rewrite (required_checks field + the incremental
# marker corruption fix).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER_SCRIPT="$ROOT_DIR/scripts/publish_helpers.sh"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

echo "=== Wiring: run_review section modules and action.yml ==="
check "run_review validates VALIDATE_REQUIRED_CHECKS values" \
  "$(grep -c 'Invalid VALIDATE_REQUIRED_CHECKS' "$ROOT_DIR/scripts/sections/config.sh")" "1"
check "run_review validates REQUIRED_CHECK_VALIDATION_MODE values" \
  "$(grep -c 'Invalid REQUIRED_CHECK_VALIDATION_MODE' "$ROOT_DIR/scripts/sections/config.sh")" "1"
check "wrapper calls apply_required_check_validation" \
  "$(grep -c 'apply_required_check_validation' "$ROOT_DIR/scripts/sections/config.sh")" "2"
check "required_checks step output emitted" \
  "$(grep -c '^echo "required_checks=' "$ROOT_DIR/scripts/sections/review.sh")" "1"
ACTION="$(cat "$ROOT_DIR/action.yml")"
check_contains "action.yml declares validate_required_checks input" "$ACTION" "validate_required_checks:"
check_contains "action.yml declares required_check_validation_mode input" "$ACTION" "required_check_validation_mode:"
check_contains "action.yml declares required_checks output" "$ACTION" "required_checks:"
check "publish step receives REQUIRED_CHECKS" \
  "$(grep -c 'REQUIRED_CHECKS: \${{ steps.review.outputs.required_checks }}' "$ROOT_DIR/action.yml")" "1"

echo ""
echo "=== Functional: build_metadata_marker carries required_checks ==="
# shellcheck source=/dev/null
source "$HELPER_SCRIPT"

MARKER="$(HEAD_SHA=headsha EFFECTIVE_SCOPE=full REVIEW_RESULT=clean REQUIRED_CHECKS=incomplete \
  build_metadata_marker "basesha" "")"
check_contains "marker carries required_checks" "$MARKER" '"required_checks":"incomplete"'
check_contains "marker keeps review_result" "$MARKER" '"review_result":"clean"'
check_contains "marker terminates with -->" "$MARKER" " -->"

MARKER_NONE="$(HEAD_SHA=headsha EFFECTIVE_SCOPE=full REVIEW_RESULT=clean REQUIRED_CHECKS=none \
  build_metadata_marker "basesha" "")"
check "required_checks=none omitted from marker" \
  "$(printf '%s' "$MARKER_NONE" | grep -c 'required_checks' || true)" "0"

echo ""
echo "=== Functional: incremental marker is complete and parseable (regression) ==="
# The old string-surgery builder dropped review_result and the closing ' -->'
# whenever previous_head_sha was appended, making incremental markers
# unparseable (next run silently degraded to a full review).
MARKER_INC="$(HEAD_SHA=headsha EFFECTIVE_SCOPE=incremental REVIEW_RESULT=issues REQUIRED_CHECKS=complete \
  build_metadata_marker "basesha" "prevsha")"
check_contains "incremental marker keeps review_result" "$MARKER_INC" '"review_result":"issues"'
check_contains "incremental marker carries previous_head_sha" "$MARKER_INC" '"previous_head_sha":"prevsha"'
check_contains "incremental marker terminates with -->" "$MARKER_INC" " -->"

PARSED="$(printf '%s' "$MARKER_INC" | PYTHONPATH="$ROOT_DIR" python3 -c "
import sys
from pr_reviewer.metadata import parse_metadata
data = parse_metadata(sys.stdin.read())
print('unparseable' if data is None else f\"{data['review_scope']}|{data['review_result']}|{data['previous_head_sha']}|{data.get('required_checks')}\")
")"
check "parse_metadata reads the incremental marker" "$PARSED" "incremental|issues|prevsha|complete"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
