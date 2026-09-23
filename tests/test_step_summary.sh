#!/usr/bin/env bash
set -uo pipefail

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
    echo "SKIP: $dep is not available — cannot run test_step_summary.sh" >&2
    exit 0
  fi
done

# Tests for write_step_summary() in run_review.sh: emits a markdown table to
# GITHUB_STEP_SUMMARY with verdict, budget, and truncation flags; no-ops when
# GITHUB_STEP_SUMMARY is unset.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

FUNC="$(mktemp)"
TMP="$(mktemp -d)"
trap 'rm -f "$FUNC"; rm -rf "$TMP"' EXIT

python3 - "$ROOT_DIR/scripts/sections/review.sh" "$FUNC" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"^write_step_summary\(\) \{\n(.*?)\n\}", src, re.S | re.M)
if not m:
    sys.exit("could not extract write_step_summary")
open(sys.argv[2], "w").write("write_step_summary() {\n%s\n}\n" % m.group(1))
PY

log() { :; }
# shellcheck source=/dev/null
source "$FUNC"

cd "$TMP"
echo '{"verdict":"request_changes","review_markdown":"x"}' > ai-output.json
echo '{"executed_request_count":2,"tool_calls":[{"tool":"read_file","status":"ok"},{"tool":"web_fetch","status":"error"}]}' > tool-harness.json
# 100-byte diff with a small cap → should report truncation
printf 'd%.0s' $(seq 1 100) > pr.diff
printf 'c%.0s' $(seq 1 50) > review-corpus.md
cp review-corpus.md review-corpus.truncated.md
printf 'p%.0s' $(seq 1 23) > pr.diff.truncated
MAX_DIFF=10; MAX_CORPUS=1000
ANALYSIS_ENGINE="qwen@local (openai)"
CONTEXT_LIMIT_MODE="normal"; MODEL_CONTEXT_TOKENS=""; AI_FALLBACK_MODEL=""

echo "=== Test: no-op when GITHUB_STEP_SUMMARY unset ==="
unset GITHUB_STEP_SUMMARY
rc=0; write_step_summary || rc=$?
check "returns 0 with no summary target" "$rc" "0"

echo ""
echo "=== Test: writes a table with verdict + truncation flag ==="
export GITHUB_STEP_SUMMARY="$TMP/summary.md"
: > "$GITHUB_STEP_SUMMARY"
write_step_summary
check "summary mentions verdict" \
  "$(grep -c 'request_changes' "$GITHUB_STEP_SUMMARY")" "1"
check "summary flags diff truncation" \
  "$(grep -qi 'Diff bytes' "$GITHUB_STEP_SUMMARY" && grep -qi 'truncated: yes' "$GITHUB_STEP_SUMMARY" && echo yes || echo no)" "yes"
check "summary shows the budget mode" \
  "$(grep -qi 'context_limit_mode=normal' "$GITHUB_STEP_SUMMARY" && echo yes || echo no)" "yes"
check "summary shows tool call counts" \
  "$(grep -qi '2 executed (1 successful)' "$GITHUB_STEP_SUMMARY" && echo yes || echo no)" "yes"
check "primary telemetry uses actual sent bytes" \
  "$(grep -q 'tier=primary; model_context_tokens=unset; corpus_budget=1000B; corpus_actual=50B; diff_budget=10B; diff_actual=23B; request_shape=default' "$GITHUB_STEP_SUMMARY" && echo yes || echo no)" "yes"

echo ""
echo "=== Test: smart verdict reports smart tier, not primary values ==="
REVIEW_ROUTE=escalated
PRIMARY_OK=1
PRIMARY_MAX_CORPUS=1000; PRIMARY_MAX_DIFF=10
SMART_MAX_CORPUS=4000; SMART_MAX_DIFF=200
SMART_MODEL_CONTEXT_TOKENS=32000; SMART_REQUEST_SHAPE=trailing_task
printf 's%.0s' $(seq 1 150) > review-corpus.smart.truncated.md
printf 'x%.0s' $(seq 1 75) > pr.diff.smart.truncated
: > "$GITHUB_STEP_SUMMARY"
write_step_summary
check "smart telemetry reports effective and actual bytes" \
  "$(grep -q 'tier=smart; model_context_tokens=32000; corpus_budget=4000B; corpus_actual=150B; diff_budget=200B; diff_actual=75B; request_shape=trailing_task' "$GITHUB_STEP_SUMMARY" && echo yes || echo no)" "yes"
check "primary attempt remains visible" \
  "$(grep -q 'Primary context | corpus_budget=1000B; corpus_actual=50B; diff_budget=10B; request_shape=default' "$GITHUB_STEP_SUMMARY" && echo yes || echo no)" "yes"

echo ""
echo "=== Test: direct smart route uses initial artifacts with smart profile ==="
REVIEW_ROUTE=smart; REVIEW_CONTEXT_PROFILE=smart
printf 'd%.0s' $(seq 1 85) > review-corpus.truncated.md
printf 'q%.0s' $(seq 1 45) > pr.diff.smart.truncated
: > "$GITHUB_STEP_SUMMARY"
write_step_summary
check "direct smart reports smart cap and initial corpus bytes" \
  "$(grep -q 'tier=smart; model_context_tokens=32000; corpus_budget=4000B; corpus_actual=85B; diff_budget=200B; diff_actual=45B; request_shape=trailing_task' "$GITHUB_STEP_SUMMARY" && echo yes || echo no)" "yes"
check "direct smart does not report an earlier primary attempt" \
  "$(grep -c 'Primary context' "$GITHUB_STEP_SUMMARY" || true)" "0"

echo ""
echo "=== Test: failed initial smart route still reports fallback ==="
PRIMARY_OK=0
printf 'f%.0s' $(seq 1 40) > review-corpus.fallback.truncated.md
: > "$GITHUB_STEP_SUMMARY"
write_step_summary
check "fallback uses fallback tier and corpus" \
  "$(grep -q 'tier=fallback; model_context_tokens=unset; corpus_budget=120000B; corpus_actual=40B; diff_budget=unknown; diff_actual=unknown; request_shape=default' "$GITHUB_STEP_SUMMARY" && echo yes || echo no)" "yes"
check "fallback diff truncation is not inferred from smart source" \
  "$(grep -q 'Diff bytes | 100 (truncated: unknown (fallback corpus re-truncated))' "$GITHUB_STEP_SUMMARY" && echo yes || echo no)" "yes"

echo ""
echo "=== Test: failed primary route reports fallback with primary diff ==="
REVIEW_ROUTE=primary; REVIEW_CONTEXT_PROFILE=primary
: > "$GITHUB_STEP_SUMMARY"
write_step_summary
check "primary-to-fallback does not claim initial diff bytes were sent" \
  "$(grep -q 'tier=fallback; model_context_tokens=unset; corpus_budget=120000B; corpus_actual=40B; diff_budget=unknown; diff_actual=unknown; request_shape=default' "$GITHUB_STEP_SUMMARY" && echo yes || echo no)" "yes"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
