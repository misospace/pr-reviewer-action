#!/usr/bin/env bash
set -uo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

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
# 100-byte diff with a small cap → should report truncation
printf 'd%.0s' $(seq 1 100) > pr.diff
printf 'c%.0s' $(seq 1 50) > review-corpus.md
MAX_DIFF=10; MAX_CORPUS=1000
ANALYSIS_ENGINE="qwen@local (openai)"; EFFECTIVE_SCOPE="full"
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

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
