#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Tests for classification→prompt steering: build_user_message() in
# run_review.sh injects pr_kind / risk_flags / must_check into the user
# message, and the default system prompt explains how to treat them.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

# Extract build_user_message from run_review.sh so it can be called directly
# (same pattern as test_context_budget.sh).
FUNCS="$(mktemp)"
TMP="$(mktemp -d)"
trap 'rm -f "$FUNCS"; rm -rf "$TMP"' EXIT
python3 - "$ROOT_DIR/scripts/sections/review.sh" "$FUNCS" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"^build_user_message\(\) \{\n(.*?)\n\}", src, re.S | re.M)
if not m:
    sys.exit("could not extract build_user_message")
open(sys.argv[2], "w").write("build_user_message() {\n%s\n}\n" % m.group(1))
PY
# shellcheck source=/dev/null
source "$FUNCS"

BASE="Analyze this pull request corpus and return STRICT JSON."

echo "=== Test: full classification is injected ==="
cat > "$TMP/classification.json" <<'JSONEOF'
{
  "pr_kind": "file_serving_changes",
  "risk_flags": ["public_route_changes", "linked_security_issue"],
  "must_check": ["verify file path sanitization", "check for directory traversal vulnerabilities"]
}
JSONEOF
MSG="$(build_user_message "$TMP/classification.json")"
check_contains "base instruction kept" "$MSG" "$BASE"
check "base instruction comes first" "$(printf '%s' "$MSG" | head -n1)" "$BASE"
check_contains "pr_kind injected" "$MSG" "PR kind (deterministic classification): file_serving_changes."
check_contains "risk flags injected" "$MSG" "Risk flags: public_route_changes, linked_security_issue."
check_contains "required-checks framing present" "$MSG" "Required checks"
check_contains "first must_check item listed" "$MSG" "- verify file path sanitization"
check_contains "second must_check item listed" "$MSG" "- check for directory traversal vulnerabilities"

echo ""
echo "=== Test: empty risk/check lists omit their sections ==="
cat > "$TMP/classification.json" <<'JSONEOF'
{"pr_kind": "docs_only", "risk_flags": [], "must_check": []}
JSONEOF
MSG="$(build_user_message "$TMP/classification.json")"
check_contains "pr_kind still injected" "$MSG" "docs_only"
check_not_contains "no risk flags line" "$MSG" "Risk flags:"
check_not_contains "no required checks section" "$MSG" "Required checks"

echo ""
echo "=== Test: missing classification file falls back to base message ==="
MSG="$(build_user_message "$TMP/does-not-exist.json")"
check "base message only" "$MSG" "$BASE"

echo ""
echo "=== Test: invalid JSON falls back to base message ==="
echo 'not json at all' > "$TMP/classification.json"
MSG="$(build_user_message "$TMP/classification.json")"
check "base message only on invalid JSON" "$MSG" "$BASE"

echo ""
echo "=== Test: non-object JSON falls back to base message ==="
echo '["a","list"]' > "$TMP/classification.json"
MSG="$(build_user_message "$TMP/classification.json")"
check "base message only on non-object JSON" "$MSG" "$BASE"

echo ""
echo "=== Test: must_check list is capped ==="
python3 - "$TMP/classification.json" <<'PY'
import json, sys
data = {"pr_kind": "app_code", "risk_flags": [], "must_check": [f"check {i}" for i in range(30)]}
json.dump(data, open(sys.argv[1], "w"))
PY
MSG="$(build_user_message "$TMP/classification.json")"
check "at most 12 check bullets" "$(printf '%s\n' "$MSG" | grep -c '^- check ')" "12"

echo ""
echo "=== Test: wiring in the review section module and system prompt ==="
check "primary request uses the steered message" \
  "$(grep -c '"\$USER_MESSAGE" \\' "$ROOT_DIR/scripts/sections/review.sh")" "2"
PROMPT="$(cat "$ROOT_DIR/scripts/default_system_prompt.txt")"
check_contains "system prompt references the PR Classification section" \
  "$PROMPT" "# PR Classification"
check_contains "system prompt makes must_check mandatory" \
  "$PROMPT" "must_check"
check_contains "system prompt ties risk flags to scrutiny" \
  "$PROMPT" "risk_flags"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
