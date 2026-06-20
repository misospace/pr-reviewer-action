#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Tests for fast/smart model routing (#159): resolve_review_route() extracted
# from run_review.sh, plus wiring assertions.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

# Extract resolve_review_route from run_review.sh (same pattern as
# test_context_budget.sh / test_classification_steering.sh).
FUNCS="$(mktemp)"
WORKDIR="$(mktemp -d)"
trap 'rm -f "$FUNCS"; rm -rf "$WORKDIR"' EXIT
python3 - "$ROOT_DIR/scripts/sections/classification.sh" "$FUNCS" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"^resolve_review_route\(\) \{\n(.*?)\n\}", src, re.S | re.M)
if not m:
    sys.exit("could not extract resolve_review_route")
open(sys.argv[2], "w").write("resolve_review_route() {\n%s\n}\n" % m.group(1))
PY
# shellcheck source=/dev/null
source "$FUNCS"

cd "$WORKDIR"
DEFAULT_FLAGS="linked_security_issue,linked_priority_p0,linked_priority_p1,auth_changes,public_route_changes,file_serving_changes,path_handling_changes,secret_handling_changes,db_or_migration_changes"

route_for() {
  # $1 = routing mode, $2 = pr_kind, $3 = risk_flags csv, $4 = smart resolved, [$5 = escalate list]
  local flags_json="[]"
  if [ -n "$3" ]; then
    flags_json="$(printf '%s' "$3" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().split(",")))')"
  fi
  printf '{"pr_kind": "%s", "risk_flags": %s}' "$2" "$flags_json" > classification.json
  REVIEW_ROUTING_MODE="$1" \
  SMART_MODEL_RESOLVED="$4" \
  ESCALATE_ON_RISK_FLAGS="${5:-$DEFAULT_FLAGS}" \
  REVIEW_ROUTE="" ROUTE_REASON=""
  REVIEW_ROUTING_MODE="$1" SMART_MODEL_RESOLVED="$4" ESCALATE_ON_RISK_FLAGS="${5:-$DEFAULT_FLAGS}" resolve_review_route
  echo "$REVIEW_ROUTE"
}

echo "=== Test: routing off → legacy ==="
check "off mode is legacy" "$(route_for off auth_changes "" 1)" "legacy"
check "default-ish empty mode handled upstream (off)" "$(route_for off app_code "" 1)" "legacy"

echo ""
echo "=== Test: auto + low risk → primary ==="
check "app_code with no flags routes primary" "$(route_for auto app_code "" 1)" "primary"
check "renovate digest routes primary" "$(route_for auto renovate_digest_only "" 1)" "primary"

echo ""
echo "=== Test: auto + risky pr_kind → smart ==="
check "auth_changes kind routes smart" "$(route_for auto auth_changes "" 1)" "smart"
check "db_or_migration_changes kind routes smart" "$(route_for auto db_or_migration_changes "" 1)" "smart"

echo ""
echo "=== Test: auto + risky flag on benign kind → smart (union matching) ==="
check "app_code with linked_security_issue flag routes smart" \
  "$(route_for auto app_code "linked_security_issue" 1)" "smart"
check "app_code with path_handling_changes flag routes smart" \
  "$(route_for auto app_code "other_flag,path_handling_changes" 1)" "smart"

echo ""
echo "=== Test: risky PR without smart config stays primary ==="
check "risky PR without smart model stays primary" "$(route_for auto auth_changes "" "")" "primary"

echo ""
echo "=== Test: custom escalation list ==="
check "custom list: kind not in list routes primary" \
  "$(route_for auto auth_changes "" 1 "db_or_migration_changes")" "primary"
check "custom list: matching kind routes smart" \
  "$(route_for auto db_or_migration_changes "" 1 "db_or_migration_changes")" "smart"

echo ""
echo "=== Test: wiring ==="
RUN_REVIEW="$(cat "$ROOT_DIR/scripts/run_review.sh" "$ROOT_DIR"/scripts/sections/*.sh)"
check_contains "primary route config defaults to ai_model" "$RUN_REVIEW" 'PRIMARY_MODEL="${AI_PRIMARY_MODEL:-$AI_MODEL}"'
check_contains "smart resolves ONLY from ai_smart_model (not the fallback)" "$RUN_REVIEW" 'SMART_MODEL="${AI_SMART_MODEL}"'
check "review_route output emitted" "$(grep -c '^echo "review_route=' "$ROOT_DIR/scripts/sections/review.sh")" "1"
check "precheck fingerprints routing mode" "$(grep -c 'routing_mode:' "$ROOT_DIR/scripts/check_review_needed.sh")" "1"
check "precheck fingerprints escalate flags" "$(grep -c 'escalate_flags:' "$ROOT_DIR/scripts/check_review_needed.sh")" "1"
ACTION="$(cat "$ROOT_DIR/action.yml")"
check_contains "action.yml declares review_routing_mode" "$ACTION" "review_routing_mode:"
check_contains "action.yml declares ai_smart_model" "$ACTION" "ai_smart_model:"
check_contains "action.yml declares review_route output" "$ACTION" "review_route:"
check "publish step receives REVIEW_ROUTE" \
  "$(grep -c 'REVIEW_ROUTE: \${{ steps.review.outputs.review_route }}' "$ROOT_DIR/action.yml")" "1"
check_contains "marker carries review_route" "$(cat "$ROOT_DIR/scripts/publish_helpers.sh")" "review_route"

echo ""
echo "=== Test: annotate_analysis_engine ==="
# Extract annotate_analysis_engine from the review section module.
AAE_FUNCS="$(mktemp)"
python3 - "$ROOT_DIR/scripts/sections/review.sh" "$AAE_FUNCS" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"^annotate_analysis_engine\(\) \{\n(.*?)\n\}", src, re.S | re.M)
if not m:
    sys.exit("could not extract annotate_analysis_engine")
open(sys.argv[2], "w").write("annotate_analysis_engine() {\n%s\n}\n" % m.group(1))
PY
# shellcheck source=/dev/null
source "$AAE_FUNCS"
rm -f "$AAE_FUNCS"

BASE="review@http://llm:8080/v1 (openai)"
check "legacy primary stays unannotated" \
  "$(REVIEW_ROUTE=legacy annotate_analysis_engine "$BASE" primary)" "$BASE"
check "routing-off default stays unannotated" \
  "$(REVIEW_ROUTE= annotate_analysis_engine "$BASE" primary)" "$BASE"
check "primary route annotated" \
  "$(REVIEW_ROUTE=primary annotate_analysis_engine "$BASE" primary)" "$BASE — primary route"
check "smart route carries the risk reason" \
  "$(REVIEW_ROUTE=smart ROUTE_REASON="risk match: auth_changes" annotate_analysis_engine "$BASE" primary)" \
  "$BASE — routed smart (risk match: auth_changes)"
check "fallback annotated" \
  "$(annotate_analysis_engine "$BASE" fallback)" "$BASE — fallback (primary failed)"
check "escalated carries trigger names" \
  "$(ESCALATION_REASONS="fast_low_confidence" annotate_analysis_engine "$BASE" escalated)" \
  "$BASE — escalated (fast_low_confidence)"
# The step-summary usage-file branch greps the engine string for "fallback";
# only the fallback origin may introduce that word.
check "primary annotation does not claim fallback" \
  "$(case "$(REVIEW_ROUTE=primary annotate_analysis_engine "$BASE" primary)" in *fallback*) echo yes;; *) echo no;; esac)" "no"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
