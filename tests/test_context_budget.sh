#!/usr/bin/env bash
set -euo pipefail

# Tests for the context-budget derivation (apply_context_limits) and the
# UTF-8/newline-safe truncate_clean helper in run_review.sh. These are extracted
# and exercised in isolation since the main driver has no end-to-end harness.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
check() {
  local desc="$1" result="$2" expected="$3"
  if [[ "$result" == "$expected" ]]; then
    echo "  PASS: $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (got '$result', expected '$expected')"; FAIL=$((FAIL + 1))
  fi
}

# Extract the two functions from run_review.sh so we can call them directly.
FUNCS="$(mktemp)"
trap 'rm -f "$FUNCS"' EXIT
python3 - "$ROOT_DIR/scripts/run_review.sh" "$FUNCS" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
out = []
for name in ("apply_context_limits", "truncate_clean"):
    m = re.search(r"^%s\(\) \{\n(.*?)\n\}" % re.escape(name), src, re.S | re.M)
    if not m:
        sys.exit(f"could not extract {name}")
    out.append("%s() {\n%s\n}\n" % (name, m.group(1)))
open(sys.argv[2], "w").write("\n".join(out))
PY

log() { :; }  # silence the log() calls inside apply_context_limits
# shellcheck source=/dev/null
source "$FUNCS"

echo "=== Test: MODEL_CONTEXT_TOKENS derives budgets and reserves output ==="
AI_MAX_TOKENS=2000 MODEL_CONTEXT_TOKENS=8192 CONTEXT_LIMIT_MODE=normal apply_context_limits
# usable = 8192 - (2000 + 2000) = 4192; bytes = 4192*3 = 12576
check "MAX_CORPUS derived from tokens" "$MAX_CORPUS" "12576"
check "MAX_DIFF is 60% of corpus" "$MAX_DIFF" "$((12576 * 6 / 10))"
check "derived corpus < normal-mode 220000" "$([ "$MAX_CORPUS" -lt 220000 ] && echo yes || echo no)" "yes"

echo ""
echo "=== Test: empty MODEL_CONTEXT_TOKENS falls back to named mode ==="
AI_MAX_TOKENS=4096 MODEL_CONTEXT_TOKENS="" CONTEXT_LIMIT_MODE=minimal apply_context_limits
check "minimal mode MAX_CORPUS" "$MAX_CORPUS" "60000"

echo ""
echo "=== Test: invalid MODEL_CONTEXT_TOKENS falls back to named mode ==="
AI_MAX_TOKENS=4096 MODEL_CONTEXT_TOKENS="lots" CONTEXT_LIMIT_MODE=normal apply_context_limits
check "invalid value uses normal mode" "$MAX_CORPUS" "220000"

echo ""
echo "=== Test: truncate_clean cuts at a newline boundary, adds marker ==="
TMP="$(mktemp -d)"; trap 'rm -f "$FUNCS"; rm -rf "$TMP"' EXIT
printf 'line1\nline2\nline3\nline4\n' > "$TMP/src"
truncate_clean "$TMP/src" "$TMP/dst" 9 'CUT'   # 9 bytes lands inside 'line2'
check "no partial line kept" "$(grep -c '^line2$' "$TMP/dst")" "0"
check "whole prior line kept" "$(grep -c '^line1$' "$TMP/dst")" "1"
check "marker appended" "$(grep -c '^CUT$' "$TMP/dst")" "1"

echo ""
echo "=== Test: truncate_clean copies through when under budget ==="
truncate_clean "$TMP/src" "$TMP/dst2" 100000 'CUT'
check "no marker when under budget" "$(grep -c '^CUT$' "$TMP/dst2")" "0"
check "content preserved" "$(grep -c '^line4$' "$TMP/dst2")" "1"

echo ""
echo "=== Test: truncate_clean does not split a multibyte UTF-8 char ==="
printf 'héllo wörld ☃ end\n' > "$TMP/utf"   # multibyte at known offsets
truncate_clean "$TMP/utf" "$TMP/utfdst" 8 'X'
check "output is valid UTF-8" \
  "$(python3 -c 'open("'"$TMP"'/utfdst",encoding="utf-8").read(); print("ok")')" "ok"

echo ""
echo "=== Test: enrichment context trims are wired into run_review.sh ==="
RUN_REVIEW="$(cat "$ROOT_DIR/scripts/run_review.sh")"
check "github.com raw HTML fetch is skipped" \
  "$(grep -c 'Raw HTML fetch skipped for github.com' "$ROOT_DIR/scripts/run_review.sh")" "1"
check "non-github sources go through strip_source_to_text" \
  "$(grep -c 'strip_source_to_text "source.$i.raw"' "$ROOT_DIR/scripts/run_review.sh")" "1"
check "github.com is excluded from the parallel prefetch" \
  "$(grep -c '"\$host" != "github.com"' "$ROOT_DIR/scripts/run_review.sh")" "1"
check "strip helper delegates to strip_source_text.py" \
  "$(grep -c 'strip_source_text.py' "$ROOT_DIR/scripts/run_review.sh")" "1"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
