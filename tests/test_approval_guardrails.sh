#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Tests for PR #40: guarded approval controls for review_verdict mode
# These tests validate the shell logic used by the "Publish review verdict" step.

PASS=0
FAIL=0

check() {
  local desc="$1" result="$2" expected="$3"
  if [[ "$result" == "$expected" ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (got '$result', expected '$expected')"
    FAIL=$((FAIL + 1))
  fi
}

check_ne() {
  local desc="$1" result="$2" not_expected="$3"
  if [[ "$result" != "$not_expected" ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (got '$result', should not be '$not_expected')"
    FAIL=$((FAIL + 1))
  fi
}

check_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected to contain '$needle')"
    FAIL=$((FAIL + 1))
  fi
}

check_exists() {
  local desc="$1" result="$2"
  if [[ "$result" -gt 0 ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected to exist)"
    FAIL=$((FAIL + 1))
  fi
}

# The core guardrail logic extracted from action.yml's publish verdict step.
# It sets CAN_APPROVE based on VERDICT, ALLOW_APPROVE, APPROVE_FORKS, IS_FORK_PR.
evaluate_approval() {
  local verdict="$1" allow_approve="$2" approve_forks="$3" is_fork_pr="$4"

  local can_approve=false

  if [ "$verdict" = "approve" ] && [ "$(printf '%s' "$allow_approve" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
    if [ "$is_fork_pr" != "true" ]; then
      can_approve=true
    elif [ "$(printf '%s' "$approve_forks" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
      can_approve=true
    fi
  fi

  printf '%s' "$can_approve"
}

echo "=== Guardrail: deny approval when allow_approve=false (verdict=approve) ==="
result="$(evaluate_approval "approve" "false" "false" "false")"
check "deny when allow_approve=false" "$result" "false"

echo ""
echo "=== Guardrail: allow approval when allow_approve=true (non-fork) ==="
result="$(evaluate_approval "approve" "true" "false" "false")"
check "allow for non-fork with allow_approve=true" "$result" "true"

echo ""
echo "=== Guardrail: deny approval for fork PR even when allow_approve=true ==="
result="$(evaluate_approval "approve" "true" "false" "true")"
check "deny fork approval when approve_forks=false" "$result" "false"

echo ""
echo "=== Guardrail: allow approval for fork when both flags are true ==="
result="$(evaluate_approval "approve" "true" "true" "true")"
check "allow fork approval when both flags=true" "$result" "true"

echo ""
echo "=== Guardrail: request_changes verdict never approves ==="
result="$(evaluate_approval "request_changes" "true" "true" "false")"
check "never approve for request_changes" "$result" "false"

echo ""
echo "=== Guardrail: case-insensitive allow_approve ==="
result="$(evaluate_approval "approve" "TRUE" "false" "false")"
check "TRUE (uppercase) treated as true" "$result" "true"
result="$(evaluate_approval "approve" "True" "false" "false")"
check "True (mixed case) treated as true" "$result" "true"
result="$(evaluate_approval "approve" "1" "false" "false")"
check "1 (not 'true') treated as false" "$result" "false"

echo ""
echo "=== Guardrail: case-insensitive approve_forks ==="
result="$(evaluate_approval "approve" "true" "TRUE" "true")"
check "approve_forks=TRUE works" "$result" "true"

echo ""
echo "=== Action.yml input validation ==="
ACTION_YML="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/action.yml"

check_exists "action.yml has publish_mode input" \
  "$(grep -c 'publish_mode:' "$ACTION_YML" 2>/dev/null || echo 0)"

check_exists "action.yml has allow_approve input" \
  "$(grep -c 'allow_approve:' "$ACTION_YML" 2>/dev/null || echo 0)"

check_exists "action.yml has approve_forks input" \
  "$(grep -c 'approve_forks:' "$ACTION_YML" 2>/dev/null || echo 0)"

check_contains "publish_mode default is comment" \
  "$(cat "$ACTION_YML")" "default: \"comment\""

check_contains "allow_approve default is false" \
  "$(cat "$ACTION_YML")" "default: \"false\""

check_exists "action.yml has native review step" \
  "$(grep -c 'Publish review verdict' "$ACTION_YML" || echo 0)"

# The native-review invocations route through the platform seam (#221):
# action.yml calls platform_review_native, whose github backend holds the
# actual `gh pr review --approve/--request-changes` command lines.
PLATFORM_SEAM="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/platform_api.sh"

check_exists "action.yml routes approve through the seam" \
  "$(grep -c 'platform_review_native "\$REPO" "\$PR_NUMBER" APPROVE' "$ACTION_YML" || echo 0)"

check_exists "seam github backend has gh pr review approve" \
  "$(grep -c 'gh pr review.*--approve' "$PLATFORM_SEAM" || echo 0)"

check_exists "seam github backend has gh pr review request-changes" \
  "$(grep -c 'gh pr review.*--request-changes' "$PLATFORM_SEAM" || echo 0)"

echo ""
echo "=== README.md documentation validation ==="
README_MD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/README.md"

check_exists "README documents publish_mode" \
  "$(grep -c 'publish_mode' "$README_MD" || echo 0)"

check_exists "README documents allow_approve" \
  "$(grep -c 'allow_approve' "$README_MD" || echo 0)"

check_exists "README documents approve_forks" \
  "$(grep -c 'approve_forks' "$README_MD" || echo 0)"

check_exists "README has branch protection warning" \
  "$(grep -ci 'branch protection' "$README_MD" || echo 0)"

check_exists "README has review_verdict usage example" \
  "$(grep -c 'publish_mode: review_verdict' "$README_MD" || echo 0)"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
