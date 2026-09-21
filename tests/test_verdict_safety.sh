#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Approval guardrails. Since #615 every review is a full review of the current
# PR — there is no incremental/baseline gate anymore. Approve requires
# allow_approve=true, and a cross-repository PR additionally requires
# approve_forks=true; request_changes never approves.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

# Core verdict approval evaluation extracted from scripts/publish.sh guardrails.
evaluate_verdict_approval() {
  local verdict="$1" allow_approve="$2" approve_forks="$3" is_fork_pr="$4"

  local can_approve=false

  if [ "$verdict" = "approve" ] && [ "$(printf '%s' "$allow_approve" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
    # Check fork gate
    if [ "$is_fork_pr" != "true" ]; then
      can_approve=true
    elif [ "$(printf '%s' "$approve_forks" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
      can_approve=true
    fi
  fi

  printf '%s' "$can_approve"
}

echo "=== Verdict Safety: approve with allow_approve on a non-fork → allow ==="
result="$(evaluate_verdict_approval "approve" "true" "false" "false")"
check "allow approval for a non-fork with allow_approve" "$result" "true"

echo ""
echo "=== Verdict Safety: allow_approve=false blocks all approvals ==="
result="$(evaluate_verdict_approval "approve" "false" "true" "false")"
check "deny when allow_approve=false" "$result" "false"

echo ""
echo "=== Verdict Safety: request_changes never approves ==="
result="$(evaluate_verdict_approval "request_changes" "true" "true" "false")"
check "never approve for request_changes" "$result" "false"

echo ""
echo "=== Verdict Safety: fork needs approve_forks ==="
result="$(evaluate_verdict_approval "approve" "true" "false" "true")"
check "deny fork approval when approve_forks=false" "$result" "false"
result="$(evaluate_verdict_approval "approve" "true" "true" "true")"
check "allow fork approval when approve_forks=true" "$result" "true"

echo ""
echo "=== Verdict Safety: case-insensitive allow_approve ==="
result="$(evaluate_verdict_approval "approve" "TRUE" "false" "false")"
check "TRUE (uppercase) allow_approve works" "$result" "true"

echo ""
echo "=== v3 seam removal: scope plumbing is gone from the action contract ==="
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ACTION_YML="$ROOT_DIR/action.yml"
PUBLISH_SH="$ROOT_DIR/scripts/publish.sh"

# The verdict/comment publish paths no longer consult the removed scope API or
# baseline_clean. Dirty-baseline escalation is removed in #618 as well; none of
# it restores the removed publication guardrail.
for needle in 'review_scope' 'effective_review_scope' 'baseline_clean'; do
  check "action.yml drops $needle" \
    "$(grep -c "$needle" "$ACTION_YML" || true)" "0"
done
check "action.yml drops dirty-baseline escalation (#618)" \
  "$(grep -c 'escalate_on_dirty_baseline:' "$ACTION_YML" || true)" "0"

# publish.sh drops the incremental header, the withheld-approval advisory, and
# the scope/baseline guardrail inputs entirely.
check "publish.sh drops EFFECTIVE_SCOPE" "$(grep -c 'EFFECTIVE_SCOPE' "$PUBLISH_SH" || true)" "0"
check "publish.sh drops BASELINE_CLEAN" "$(grep -c 'BASELINE_CLEAN' "$PUBLISH_SH" || true)" "0"
check "publish.sh drops the incremental review header" \
  "$(grep -c 'AI Automated Review (incremental)' "$PUBLISH_SH" || true)" "0"
check "publish.sh drops the dirty-baseline 'Approval withheld' advisory" \
  "$(grep -c 'Approval withheld' "$PUBLISH_SH" || true)" "0"
# The generic policy advisory that replaced it stays.
check_contains "publish.sh keeps the 'Approval blocked by policy' advisory" \
  "$(cat "$PUBLISH_SH")" "Approval blocked by policy"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
