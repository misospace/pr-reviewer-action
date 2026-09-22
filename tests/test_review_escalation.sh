#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Dependency preflight
for dep in python3; do
  if ! command -v "$dep" &>/dev/null; then
    echo "SKIP: $dep is not available — cannot run test_review_escalation.sh" >&2
    exit 0
  fi
done

# Wiring tests for fast→smart escalation (#160). Decision logic is covered in
# tests/test_escalation.py; these assert the orchestration contracts.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# The escalation / enforcement / output logic now lives in the review section
# module (#307 split); the orchestrator just sources the sections in order.
RUN_REVIEW="$ROOT_DIR/scripts/sections/review.sh"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

SRC="$(cat "$ROOT_DIR/scripts/run_review.sh" "$ROOT_DIR"/scripts/sections/*.sh)"
ACTION="$(cat "$ROOT_DIR/action.yml")"

echo "=== Escalation gating ==="
check_contains "escalation requires auto routing" "$SRC" '[[ "$REVIEW_ROUTING_MODE" == "auto" ]] || return 0'
check_contains "escalation requires the primary route" "$SRC" '[[ "${REVIEW_ROUTE:-legacy}" == "primary" ]] || return 0'
check_contains "escalation requires a smart model" "$SRC" '[[ -n "$SMART_MODEL_RESOLVED" ]] || return 0'
check_contains "smart resolves ONLY from ai_smart_model (fallback is not the smart tier)" "$SRC" 'SMART_MODEL="${AI_SMART_MODEL}"'
check_contains "smart gating keys off the smart model alone" "$SRC" 'if [[ -n "$SMART_MODEL" ]]; then'
check_contains "no-op when smart equals the active fast config" "$SRC" 'nothing distinct to escalate to'
check_contains "no-op when the fallback already produced the review on the smart config" "$SRC" 'the fallback model that produced this review is the smart model'
check_contains "step summary reads smart-response usage when escalated" "$SRC" 'usage_file="ai-response.smart.json"'

echo ""
echo "=== Decision and publication contracts ==="
check_contains "decision made by pr_reviewer.escalation" "$SRC" "from pr_reviewer.escalation import should_escalate"
check_contains "decision runs on the raw fast output (before mutation)" "$SRC" "before verdict policy / completeness"
check_contains "primary output preserved as ai-output.primary.json" "$SRC" "cp ai-output.json ai-output.primary.json"
check_contains "escalated prompt names the reasons" "$SRC" "ESCALATED review"
check_contains "smart failure restores the primary review" "$SRC" "cp ai-output.primary.json ai-output.json"
check_contains "smart failure publishes the primary review" "$SRC" "publishing the primary review"
check_contains "route becomes escalated on success" "$SRC" 'REVIEW_ROUTE="escalated"'
check_contains "coverage gate is wired" "$SRC" "maybe_escalate_coverage_review"
check_contains "coverage gate follows deterministic normalization" "$SRC" "build_requirement_coverage"
check_contains "coverage gate uses a distinct reason" "$SRC" "incomplete_coverage"
check_contains "coverage gate preserves its preliminary output" "$SRC" "ai-output.coverage-primary.json"
check_contains "coverage gate keeps fallback-equals-smart guard" "$SRC" "Skipping coverage escalation: the fallback model"
check_contains "coverage gate uses the targeted retry prompt" "$SRC" 'call_model_tier smart "$retry_prompt" review-corpus.truncated.md'
check_contains "coverage retry prompt loads the backed-up preliminary output" "$SRC" 'load_coverage("ai-output.coverage-primary.json")'
check_contains "coverage retry prompt passes the preliminary output to the renderer" "$SRC" 'render_coverage_retry_prompt(coverage, ledger, primary)'
check_contains "coverage retry validates preliminary dispositions" "$SRC" "validate_preliminary_dispositions(primary, smart)"
check_contains "invalid smart disposition restores preliminary output" "$SRC" "Rejecting smart coverage retry: preliminary finding dispositions are incomplete"
# The preliminary output must be backed up BEFORE the retry prompt is built,
# so the renderer loads the preliminary result (never a half-written smart
# response) and the backup is ready to restore on smart-call failure.
COV_BACKUP_LINE="$(grep -n 'cp ai-output.json ai-output.coverage-primary.json' "$RUN_REVIEW" | head -1 | cut -d: -f1)"
COV_PROMPT_LINE="$(grep -n 'render_coverage_retry_prompt(coverage, ledger, primary)' "$RUN_REVIEW" | head -1 | cut -d: -f1)"
if [[ -n "$COV_BACKUP_LINE" && -n "$COV_PROMPT_LINE" && "$COV_BACKUP_LINE" -lt "$COV_PROMPT_LINE" ]]; then
  echo "  PASS: preliminary output backed up before the retry prompt is built"
  PASS=$((PASS + 1))
else
  echo "  FAIL: preliminary output backup ordering (backup=$COV_BACKUP_LINE prompt=$COV_PROMPT_LINE)"
  FAIL=$((FAIL + 1))
fi
# Escalation must be decided before the enforcement wrapper runs.
ESC_LINE="$(grep -n '^maybe_escalate_review$' "$RUN_REVIEW" | cut -d: -f1)"
ENF_LINE="$(grep -n '^apply_all_enforcement_wrapper ' "$RUN_REVIEW" | cut -d: -f1)"
COVERAGE_ESC_LINE="$(grep -n '^maybe_escalate_coverage_review$' "$RUN_REVIEW" | cut -d: -f1)"
if [[ -n "$COVERAGE_ESC_LINE" && -n "$ENF_LINE" && "$COVERAGE_ESC_LINE" -gt "$ENF_LINE" ]]; then
  echo "  PASS: coverage escalation runs after enforcement/normalization"
  PASS=$((PASS + 1))
else
  echo "  FAIL: coverage escalation ordering (coverage=$COVERAGE_ESC_LINE enforce=$ENF_LINE)"
  FAIL=$((FAIL + 1))
fi
check "escalation_reason output emitted" "$(grep -c '^echo "escalation_reason=' "$RUN_REVIEW")" "1"
if [[ -n "$ESC_LINE" && -n "$ENF_LINE" && "$ESC_LINE" -lt "$ENF_LINE" ]]; then
  echo "  PASS: escalation runs before enforcement/validation"
  PASS=$((PASS + 1))
else
  echo "  FAIL: escalation ordering (escalate=$ESC_LINE enforce=$ENF_LINE)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== action.yml wiring ==="
check_contains "input escalate_on_incomplete_required_checks" "$ACTION" "escalate_on_incomplete_required_checks:"
check_contains "input escalate_on_fast_request_changes" "$ACTION" "escalate_on_fast_request_changes:"
check_contains "input escalate_on_fast_low_confidence" "$ACTION" "escalate_on_fast_low_confidence:"
check_contains "input escalate_on_tool_or_evidence_blockers" "$ACTION" "escalate_on_tool_or_evidence_blockers:"
# #618 removes dirty-baseline escalation entirely: the input, the review-step
# env wiring, and the private prior-review-result signal are all gone.
check "action.yml drops escalate_on_dirty_baseline" \
  "$(printf '%s' "$ACTION" | grep -c 'escalate_on_dirty_baseline' || true)" "0"
check "action.yml drops ESCALATE_ON_DIRTY_BASELINE" \
  "$(printf '%s' "$ACTION" | grep -c 'ESCALATE_ON_DIRTY_BASELINE' || true)" "0"
check "config.sh drops ESCALATE_ON_DIRTY_BASELINE" \
  "$(grep -c 'ESCALATE_ON_DIRTY_BASELINE' "$ROOT_DIR/scripts/sections/config.sh" || true)" "0"
check "review.sh drops DIRTY_BASELINE" \
  "$(grep -c 'DIRTY_BASELINE' "$RUN_REVIEW" || true)" "0"
check "review.sh drops PREVIOUS_REVIEW_RESULT" \
  "$(grep -c 'PREVIOUS_REVIEW_RESULT' "$RUN_REVIEW" || true)" "0"
check "baseline_clean public output remains removed" \
  "$(printf '%s' "$ACTION" | grep -c 'baseline_clean:' || true)" "0"
check "review step no longer emits needs_full_review at all (#617)" \
  "$(grep -c 'NEEDS_FULL_REVIEW' "$RUN_REVIEW")" "0"
for obsolete_text in 'Incremental Review Insufficient' 'this review is incremental' 'the next run will be a full review'; do
  check "review step drops obsolete full-rerun text: $obsolete_text" \
    "$(grep -F -c "$obsolete_text" "$RUN_REVIEW" || true)" "0"
done
check_contains "escalation_reason output declared" "$ACTION" "escalation_reason:"
check "publish step receives ESCALATION_REASON" \
  "$(grep -c 'ESCALATION_REASON: \${{ steps.review.outputs.escalation_reason }}' "$ROOT_DIR/action.yml")" "1"

echo ""
echo "=== Marker carries escalation metadata ==="
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/publish_helpers.sh"
MARKER="$(HEAD_SHA=h REVIEW_RESULT=issues REQUIRED_CHECKS=incomplete \
  REVIEW_ROUTE=escalated ESCALATION_REASON="fast_request_changes,fast_low_confidence" \
  build_metadata_marker "b" "")"
check_contains "marker carries review_route=escalated" "$MARKER" '"review_route":"escalated"'
check_contains "marker carries escalation_reason array" "$MARKER" '"escalation_reason":["fast_request_changes","fast_low_confidence"]'
PARSED="$(printf '%s' "$MARKER" | PYTHONPATH="$ROOT_DIR" python3 -c "
import sys
from pr_reviewer.metadata import parse_metadata
data = parse_metadata(sys.stdin.read())
print('unparseable' if data is None else ','.join(data.get('escalation_reason', [])))
")"
check "nested escalation metadata round-trips through parse_metadata" \
  "$PARSED" "fast_request_changes,fast_low_confidence"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
