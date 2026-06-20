#!/usr/bin/env bash
set -uo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Behavioral tests for cleanup_native_reviews (#190): run the real function
# against a mocked `gh` and assert which reviews get dismissed/stubbed.
# The prior author-matching implementation passed every structural test while
# never dismissing anything in production — these tests exercise the data path.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export CALLS_LOG="$TMP/calls.log"
export FIXTURE="$TMP/reviews.json"

# Mock gh: logs every invocation; serves the fixture for the reviews list.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'MOCK'
#!/usr/bin/env bash
echo "$*" >> "$CALLS_LOG"
if [ "${GH_MOCK_FAIL_LIST:-}" = "1" ] && [[ "$*" == *"/reviews --paginate"* ]]; then
  exit 1
fi
case "$*" in
  *"/reviews --paginate"*) cat "$FIXTURE" ;;
  *"/dismissals --method PUT"*) echo '{"id": 1}' ;;
  *"minimizeComment"*) echo '{"data":{"minimizeComment":{"minimizedComment":{"isMinimized":true}}}}' ;;
  *"isMinimized"*) printf '%s\n' "${GH_MOCK_MINIMIZED:-[]}" ;;
  *) echo '{}' ;;
esac
MOCK
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"

# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/publish_helpers.sh"
export REPO="misospace/example" PR_NUMBER=42 GH_TOKEN=dummy
unset COMMENT_MARKER

# Fixture: the realistic mix that production produced. Bodies are what the
# publish steps actually emit (marker first line). Review 101 is authored by
# an app bot, 102 by the default-token bot — author must not matter.
jq -n '[
  {id: 101, node_id: "PRR_node101", state: "APPROVED", user: {login: "its-saffron[bot]"},
   body: "<!-- ai-pr-reviewer -->\n<!-- ai-pr-reviewer:{\"version\":1} -->\n# AI Automated Review\nLooks fine."},
  {id: 102, node_id: "PRR_node102", state: "CHANGES_REQUESTED", user: {login: "github-actions[bot]"},
   body: "<!-- ai-pr-reviewer:{\"version\":1} -->\nOld-era managed review."},
  {id: 103, node_id: "PRR_node103", state: "APPROVED", user: {login: "human-reviewer"},
   body: "LGTM, nice work"},
  {id: 104, node_id: "PRR_node104", state: "COMMENTED", user: {login: "another-human"},
   body: "I noticed the bot marker <!-- ai-pr-reviewer --> appears mid-body here."},
  {id: 105, node_id: "PRR_node105", state: "DISMISSED", user: {login: "its-saffron[bot]"},
   body: "<!-- ai-pr-reviewer -->\nOld review, already minimized in a previous run."},
  {id: 106, node_id: "PRR_node106", state: "APPROVED", user: {login: "its-saffron[bot]"},
   body: "<!-- ai-pr-reviewer -->\nMinimized previously but the dismissal failed."}
]' > "$FIXTURE"

echo "=== Managed reviews are dismissed and stubbed regardless of author ==="
: > "$CALLS_LOG"
OUT="$(GH_MOCK_MINIMIZED="[105,106]" cleanup_native_reviews "true" 2>&1)"
CALLS="$(cat "$CALLS_LOG")"
check_contains "app-bot APPROVED review 101 dismissed" "$CALLS" "reviews/101/dismissals --method PUT"
check_contains "default-bot CHANGES_REQUESTED review 102 dismissed" "$CALLS" "reviews/102/dismissals --method PUT"
check_contains "review 101 minimized (hidden)" "$CALLS" "PRR_node101"
check_contains "review 102 minimized (hidden)" "$CALLS" "PRR_node102"
PUT_BODY_CALLS="$(grep -cE 'reviews/[0-9]+ --method PUT' "$CALLS_LOG" || true)"
check "review bodies are never rewritten" "$PUT_BODY_CALLS" "0"
check_not_contains "human review 103 untouched" "$CALLS" "reviews/103"
check_not_contains "mid-body marker mention 104 untouched" "$CALLS" "reviews/104"
check_not_contains "already-minimized dismissed review 105 fully skipped" "$CALLS" "reviews/105"
check_not_contains "review 105 not re-minimized" "$CALLS" "PRR_node105"
check_contains "minimized-but-still-APPROVED 106 re-dismissed" "$CALLS" "reviews/106/dismissals --method PUT"
check_not_contains "review 106 not re-minimized" "$CALLS" "PRR_node106"
check_contains "dismissals logged" "$OUT" "Dismissed outdated managed review #101"
check_contains "minimize logged" "$OUT" "Minimized (hidden as outdated) review #101"
check_not_contains "no actor lookup performed" "$CALLS" "api user"

echo ""
echo "=== Custom comment_marker is matched at body start ==="
: > "$CALLS_LOG"
jq -n '[
  {id: 201, node_id: "PRR_node201", state: "APPROVED", user: {login: "its-saffron[bot]"},
   body: "<!-- my-custom-marker -->\nManaged with a custom marker."},
  {id: 202, node_id: "PRR_node202", state: "APPROVED", user: {login: "human"},
   body: "Unrelated approval"}
]' > "$FIXTURE"
COMMENT_MARKER="<!-- my-custom-marker -->" cleanup_native_reviews "true" >/dev/null 2>&1
CALLS="$(cat "$CALLS_LOG")"
check_contains "custom-marker review 201 dismissed" "$CALLS" "reviews/201/dismissals --method PUT"
check_not_contains "human review 202 untouched" "$CALLS" "reviews/202"

echo ""
echo "=== List failure warns and returns cleanly ==="
: > "$CALLS_LOG"
OUT="$(GH_MOCK_FAIL_LIST=1 cleanup_native_reviews "true" 2>&1)"; RC=$?
check_contains "warns on list failure" "$OUT" "WARN: Could not list reviews"
[ "$RC" -eq 0 ] && { echo "  PASS: returns 0 on list failure"; PASS=$((PASS + 1)); } \
                || { echo "  FAIL: returned $RC on list failure"; FAIL=$((FAIL + 1)); }
CALLS="$(cat "$CALLS_LOG")"
check_not_contains "no mutations attempted after list failure" "$CALLS" "--method"

echo ""
echo "=== Disabled flag is a no-op ==="
: > "$CALLS_LOG"
cleanup_native_reviews "false" >/dev/null 2>&1
check_not_contains "no API calls when cleanup disabled" "$(cat "$CALLS_LOG")" "api"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
