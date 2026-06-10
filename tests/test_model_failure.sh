#!/usr/bin/env bash
set -uo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Tests for handle_model_failure() in run_review.sh: fail mode exits non-zero;
# notice mode writes a request_changes notice and returns 0 so publishing can
# post a visible explanation. Extracted and driven in isolation.

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

FUNC="$(mktemp)"
TMP="$(mktemp -d)"
trap 'rm -f "$FUNC"; rm -rf "$TMP"' EXIT

python3 - "$ROOT_DIR/scripts/run_review.sh" "$FUNC" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"^handle_model_failure\(\) \{\n(.*?)\n\}", src, re.S | re.M)
if not m:
    sys.exit("could not extract handle_model_failure")
open(sys.argv[2], "w").write("handle_model_failure() {\n%s\n}\n" % m.group(1))
PY

log() { :; }
error() { :; }
# shellcheck source=/dev/null
source "$FUNC"

cd "$TMP"

echo "=== Test: fail mode exits non-zero ==="
rc=0
( ON_MODEL_FAILURE="fail" ANALYSIS_ENGINE="x" handle_model_failure 'boom' ) >/dev/null 2>&1 || rc=$?
check "fail mode returns non-zero" "$rc" "1"

echo ""
echo "=== Test: notice mode returns 0 and writes a request_changes notice ==="
rc=0
( ON_MODEL_FAILURE="notice" ANALYSIS_ENGINE="x" handle_model_failure "endpoint down" ) >/dev/null 2>&1 || rc=$?
check "notice mode returns 0" "$rc" "0"
check "notice ai-output.json verdict is request_changes" \
  "$(jq -r '.verdict' ai-output.json 2>/dev/null)" "request_changes"
check "notice markdown explains the failure" \
  "$(jq -r '.review_markdown' ai-output.json 2>/dev/null | grep -qi 'could not run' && echo yes || echo no)" "yes"
check "notice markdown mentions the reason" \
  "$(jq -r '.review_markdown' ai-output.json 2>/dev/null | grep -qi 'endpoint down' && echo yes || echo no)" "yes"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
