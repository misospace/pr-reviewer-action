#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Tests for PR verdict safety: incremental reviews require clean full baseline for approval

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

# Core verdict safety evaluation extracted from action.yml publish_verdict step.
evaluate_verdict_approval() {
  local verdict="$1" allow_approve="$2" effective_scope="$3" baseline_clean="$4" approve_forks="$5" is_fork_pr="$6"

  local can_approve=false

  if [ "$verdict" = "approve" ] && [ "$(printf '%s' "$allow_approve" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
    # For incremental reviews, require a trusted clean full baseline
    if [ "$effective_scope" = "incremental" ] && [ "$baseline_clean" != "true" ]; then
      can_approve=false
    else
      # Check fork gate
      if [ "$is_fork_pr" != "true" ]; then
        can_approve=true
      elif [ "$(printf '%s' "$approve_forks" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
        can_approve=true
      fi
    fi
  fi

  printf '%s' "$can_approve"
}

echo "=== Verdict Safety: incremental without baseline → deny approval ==="
result="$(evaluate_verdict_approval "approve" "true" "incremental" "false" "false" "false")"
check "deny approval for incremental without clean baseline" "$result" "false"

echo ""
echo "=== Verdict Safety: incremental with clean baseline → allow (non-fork) ==="
result="$(evaluate_verdict_approval "approve" "true" "incremental" "true" "false" "false")"
check "allow approval for incremental with clean baseline" "$result" "true"

echo ""
echo "=== Verdict Safety: full review with allow_approve → allow ==="
result="$(evaluate_verdict_approval "approve" "true" "full" "true" "false" "false")"
check "allow approval for full review" "$result" "true"

echo ""
echo "=== Verdict Safety: incremental with issues baseline → deny ==="
result="$(evaluate_verdict_approval "approve" "true" "incremental" "false" "false" "false")"
check "deny approval when prior review had issues" "$result" "false"

echo ""
echo "=== Verdict Safety: request_changes never approves ==="
result="$(evaluate_verdict_approval "request_changes" "true" "incremental" "true" "false" "false")"
check "never approve for request_changes" "$result" "false"

echo ""
echo "=== Verdict Safety: incremental on fork with clean baseline → check approve_forks ==="
result="$(evaluate_verdict_approval "approve" "true" "incremental" "true" "false" "true")"
check "deny fork incremental approval when approve_forks=false" "$result" "false"
result="$(evaluate_verdict_approval "approve" "true" "incremental" "true" "true" "true")"
check "allow fork incremental approval when approve_forks=true" "$result" "true"

echo ""
echo "=== Verdict Safety: allow_approve=false blocks all approvals ==="
result="$(evaluate_verdict_approval "approve" "false" "full" "true" "false" "false")"
check "deny when allow_approve=false regardless of scope" "$result" "false"

echo ""
echo "=== Verdict Safety: case-insensitive flags ==="
result="$(evaluate_verdict_approval "approve" "TRUE" "incremental" "true" "false" "false")"
check "TRUE (uppercase) allow_approve works" "$result" "true"
result="$(evaluate_verdict_approval "approve" "true" "INCREMENTAL" "true" "false" "false")"
check "INCREMENTAL scope not matched (case-sensitive)" "$result" "true"

echo ""
echo "=== action.yml integration checks ==="
ACTION_YML="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/action.yml"

check_exists "action.yml has EFFECTIVE_SCOPE reference in verdict step" \
  "$(grep -c 'EFFECTIVE_SCOPE' "$ACTION_YML" || echo 0)"
check_exists "action.yml has BASELINE_CLEAN reference in verdict step" \
  "$(grep -c 'BASELINE_CLEAN' "$ACTION_YML" || echo 0)"
check_exists "action.yml marks incremental reviews in the header" \
  "$(grep -c 'AI Automated Review (incremental)' "$ACTION_YML" || echo 0)"
check_exists "action.yml has carried-forward disclaimer text" \
  "$(grep -c 'carried forward' "$ACTION_YML" || echo 0)"
check_exists "action.yml explains dirty-baseline withheld approvals" \
  "$(grep -c 'Approval withheld' "$ACTION_YML" || echo 0)"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
