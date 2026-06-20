#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Tests for issue #106: cleanup of superseded native PR reviews
# These tests validate the shell logic used by the native review publish steps.

PASS=0
FAIL=0

check() {
  local desc="$1" result="$2" expected="$3"
  if [[ "$result" == "$expected" ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (got '$result', expected '$expected')"
    FAIL=$((FAIL + 1))
  fi
}

check_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected to contain '$needle')"
    FAIL=$((FAIL + 1))
  fi
}

check_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (got '$haystack', should not contain '$needle')"
    FAIL=$((FAIL + 1))
  fi
}

check_exists() {
  local desc="$1" result="$2"
  if [[ "$result" -gt 0 ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected to exist)"
    FAIL=$((FAIL + 1))
  fi
}

# The cleanup resolution logic extracted from action.yml.
# It resolves CLEANUP_PREVIOUS_NATIVE_REVIEWS to CLEANUP_NATIVE_REVIEWS based on PUBLISH_MODE.
resolve_cleanup() {
  local cleanup_input="$1" publish_mode="$2"
  local cleanup_native_reviews=false

  case "$(printf '%s' "$cleanup_input" | tr '[:upper:]' '[:lower:]')" in
    true) cleanup_native_reviews=true ;;
    false) cleanup_native_reviews=false ;;
    auto|"")
      if [ "$publish_mode" = "review_comment" ] || [ "$publish_mode" = "review_verdict" ]; then
        cleanup_native_reviews=true
      else
        cleanup_native_reviews=false
      fi
      ;;
    *) echo "Invalid value" >&2; return 1 ;;
  esac

  printf '%s' "$cleanup_native_reviews"
}

echo "=== Cleanup resolution: auto + review_comment ==="
result="$(resolve_cleanup "auto" "review_comment")"
check "auto resolves true for review_comment" "$result" "true"

echo ""
echo "=== Cleanup resolution: auto + review_verdict ==="
result="$(resolve_cleanup "auto" "review_verdict")"
check "auto resolves true for review_verdict" "$result" "true"

echo ""
echo "=== Cleanup resolution: auto + comment ==="
result="$(resolve_cleanup "auto" "comment")"
check "auto resolves false for comment" "$result" "false"

echo ""
echo "=== Cleanup resolution: explicit true ==="
result="$(resolve_cleanup "true" "comment")"
check "true forces cleanup even for comment mode" "$result" "true"

result="$(resolve_cleanup "TRUE" "comment")"
check "TRUE (uppercase) forces cleanup" "$result" "true"

echo ""
echo "=== Cleanup resolution: explicit false ==="
result="$(resolve_cleanup "false" "review_comment")"
check "false disables cleanup for review_comment" "$result" "false"

result="$(resolve_cleanup "False" "review_verdict")"
check "False (mixed case) disables cleanup" "$result" "false"

echo ""
echo "=== Cleanup resolution: empty defaults to auto ==="
result="$(resolve_cleanup "" "review_comment")"
check "empty string resolves true for review_comment" "$result" "true"

result="$(resolve_cleanup "" "comment")"
check "empty string resolves false for comment" "$result" "false"

echo ""
echo "=== Review body marker validation ==="

ACTION_YML="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/action.yml"

# The three publish modes are now case arms inside a single "Publish review"
# dispatcher step (#303): one superset env block, dispatching on $PUBLISH_MODE.
# Extract each arm by its case label so the per-mode assertions still target
# the right body.
PUBLISH_STEP_BODY=$(awk '/^    - name: Publish review$/,/^    - name: Clear re-review label/' "$ACTION_YML")
STICKY_COMMENT_BODY=$(awk '/^          comment\)/,/^          review_comment\)/' "$ACTION_YML")
BODY_CONTENT_REVIEW_COMMENT=$(awk '/^          review_comment\)/,/^          review_verdict\)/' "$ACTION_YML")
BODY_CONTENT_REVIEW_VERDICT=$(awk '/^          review_verdict\)/,/^          \*\)/' "$ACTION_YML")

check_contains "review_comment arm uses METADATA_MARKER in body" \
  "$BODY_CONTENT_REVIEW_COMMENT" "METADATA_MARKER"

check_contains "review_verdict arm uses METADATA_MARKER in body" \
  "$BODY_CONTENT_REVIEW_VERDICT" "METADATA_MARKER"

# The dispatcher wires COMMENT_MARKER into its (shared) env block; every arm
# emits it through emit_review_markers (asserted below).
check_contains "publish step wires COMMENT_MARKER in env" \
  "$PUBLISH_STEP_BODY" "COMMENT_MARKER:"

# Every published body must emit the marker preamble (sticky COMMENT_MARKER +
# METADATA_MARKER + head-sha + fingerprint) so the precheck can find prior
# state; otherwise skip-if-unchanged / incremental scope silently never trigger
# (regression guard). The preamble is emitted via emit_review_markers
# (publish_helpers.sh); its exact content and ordering are asserted in
# tests/test_emit_review_markers.sh.
check_contains "sticky comment arm emits markers via emit_review_markers" \
  "$STICKY_COMMENT_BODY" "emit_review_markers"
check_contains "review_comment arm emits markers via emit_review_markers" \
  "$BODY_CONTENT_REVIEW_COMMENT" "emit_review_markers"
check_contains "review_verdict arm emits markers via emit_review_markers" \
  "$BODY_CONTENT_REVIEW_VERDICT" "emit_review_markers"

echo ""
echo "=== Helper script validation ==="

HELPER_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/publish_helpers.sh"

check_exists "publish_helpers.sh exists" \
  "$(test -f "$HELPER_SCRIPT" && echo 1 || echo 0)"

check_exists "publish_helpers.sh is executable" \
  "$(test -x "$HELPER_SCRIPT" && echo 1 || echo 0)"

check_contains "helper contains sanitize_review_markdown function" \
  "$(cat "$HELPER_SCRIPT")" "sanitize_review_markdown"

check_contains "helper contains resolve_cleanup_flag function" \
  "$(cat "$HELPER_SCRIPT")" "resolve_cleanup_flag"

check_contains "helper contains cleanup_native_reviews function" \
  "$(cat "$HELPER_SCRIPT")" "cleanup_native_reviews"

check_contains "helper contains build_metadata_marker function" \
  "$(cat "$HELPER_SCRIPT")" "build_metadata_marker"

echo ""
echo "=== Cleanup logic presence validation ==="

# The dispatcher sources the helper script once (before the case); the
# review_comment / review_verdict arms each run the cleanup.
check_contains "publish step sources publish_helpers.sh" \
  "$PUBLISH_STEP_BODY" "publish_helpers.sh"

check_contains "review_comment arm calls cleanup_native_reviews" \
  "$BODY_CONTENT_REVIEW_COMMENT" "cleanup_native_reviews"

check_contains "review_verdict arm calls cleanup_native_reviews" \
  "$BODY_CONTENT_REVIEW_VERDICT" "cleanup_native_reviews"

check_contains "review_comment arm calls resolve_cleanup_flag" \
  "$BODY_CONTENT_REVIEW_COMMENT" "resolve_cleanup_flag"

check_contains "review_verdict arm calls resolve_cleanup_flag" \
  "$BODY_CONTENT_REVIEW_VERDICT" "resolve_cleanup_flag"

echo ""
echo "=== Input definition validation ==="

check_exists "action.yml has cleanup_previous_native_reviews input" \
  "$(grep -c 'cleanup_previous_native_reviews:' "$ACTION_YML" || echo 0)"

check_contains "cleanup_previous_native_reviews default is auto" \
  "$(cat "$ACTION_YML")" 'default: "auto"'

check_exists "review_comment arm reads CLEANUP_PREVIOUS_NATIVE_REVIEWS" \
  "$(grep -c 'CLEANUP_PREVIOUS_NATIVE_REVIEWS' <<< "$BODY_CONTENT_REVIEW_COMMENT" || echo 0)"

check_exists "review_verdict arm reads CLEANUP_PREVIOUS_NATIVE_REVIEWS" \
  "$(grep -c 'CLEANUP_PREVIOUS_NATIVE_REVIEWS' <<< "$BODY_CONTENT_REVIEW_VERDICT" || echo 0)"

echo ""
echo "=== README.md documentation validation ==="

README_MD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/README.md"

check_exists "README documents cleanup_previous_native_reviews input" \
  "$(grep -c 'cleanup_previous_native_reviews' "$README_MD" || echo 0)"

check_exists "README has native review cleanup section" \
  "$(grep -c 'Native review cleanup' "$README_MD" || echo 0)"

check_contains "README documents auto/default behavior" \
  "$(cat "$README_MD")" "auto"

check_contains "README documents cleanup for review_comment" \
  "$(cat "$README_MD")" "review_comment"

check_exists "README mentions ai-pr-reviewer marker" \
  "$(grep -c 'ai-pr-reviewer' "$README_MD" || echo 0)"

check_exists "README documents dismissal behavior" \
  "$(grep -ci 'dismiss' "$README_MD" || echo 0)"

check_exists "README warns about permission requirements" \
  "$(grep -ci 'permission\|warn' "$README_MD" || echo 0)"

echo ""
echo "=== Functional: cleanup_native_reviews matching + single list query ==="

CLEANUP_TMP="$(mktemp -d)"
trap 'rm -rf "$CLEANUP_TMP"' EXIT
mkdir -p "$CLEANUP_TMP/bin"
CALL_LOG="$CLEANUP_TMP/gh-calls.log"
: > "$CALL_LOG"

# Review fixtures: 11 carries a custom marker, 22 carries only the legacy
# v1.1.x JSON metadata marker, 33 is a human review, 44 is unmanaged bot output.
cat > "$CLEANUP_TMP/reviews.json" <<'JSONEOF'
[
  {"id": 11, "node_id": "PRR_node11", "state": "APPROVED", "user": {"login": "test-bot"},
   "body": "<!-- my-marker -->\n<!-- ai-pr-review-sha:abc -->\nold review"},
  {"id": 22, "node_id": "PRR_node22", "state": "CHANGES_REQUESTED", "user": {"login": "test-bot"},
   "body": "<!-- ai-pr-reviewer:{\"version\":1,\"head_sha\":\"abc\"} -->\nlegacy review"},
  {"id": 33, "node_id": "PRR_node33", "state": "APPROVED", "user": {"login": "human"},
   "body": "Quoting the bot here: <!-- my-marker -->\nhuman pasted the marker mid-body"},
  {"id": 44, "node_id": "PRR_node44", "state": "COMMENTED", "user": {"login": "test-bot"},
   "body": "unrelated bot output"}
]
JSONEOF

cat > "$CLEANUP_TMP/bin/gh" <<SHELLEOF
#!/usr/bin/env bash
echo "\$*" >> "$CALL_LOG"
case "\$*" in
  *"/reviews --paginate"*) cat "$CLEANUP_TMP/reviews.json" ;;
  *dismissals*) echo '{"id": 1}' ;;
  *"api graphql"*) echo '{"data":{"minimizeComment":{"minimizedComment":{"isMinimized":true}}}}' ;;
  *"--method PUT"*) echo '{}' ;;
esac
exit 0
SHELLEOF
chmod +x "$CLEANUP_TMP/bin/gh"

CLEANUP_OUTPUT="$(
  PATH="$CLEANUP_TMP/bin:$PATH" \
  GH_TOKEN=test REPO="test/repo" PR_NUMBER=9 COMMENT_MARKER="<!-- my-marker -->" \
  bash -c 'source "'"$HELPER_SCRIPT"'"; cleanup_native_reviews true' 2>&1
)"

check_contains "custom-marker review is dismissed" \
  "$CLEANUP_OUTPUT" "Dismissed outdated managed review #11 (APPROVED)"
check_contains "legacy JSON-marker review is dismissed" \
  "$CLEANUP_OUTPUT" "Dismissed outdated managed review #22 (CHANGES_REQUESTED)"
check_not_contains "human review with pasted marker is untouched" \
  "$CLEANUP_OUTPUT" "#33"
check_not_contains "unmanaged bot review is untouched" \
  "$CLEANUP_OUTPUT" "#44"

# State must come from the list query — no per-review GETs.
PER_REVIEW_GETS="$(grep -E 'reviews/[0-9]+' "$CALL_LOG" | grep -vc -- '--method' || true)"
check "review state read from list query (no per-review GET)" "$PER_REVIEW_GETS" "0"
LIST_QUERIES="$(grep -c '/reviews --paginate' "$CALL_LOG" || true)"
check "exactly one review list query" "$LIST_QUERIES" "1"

echo ""
echo "=== Functional: identity-independent matching (installation tokens) ==="

# Under installation tokens (default GITHUB_TOKEN and GitHub App tokens),
# /user returns 403 — and gh prints the JSON error body to STDOUT, which is
# how the old author-matching cleanup silently dismissed nothing on every
# production run (#190). Matching is now marker-based and must work for any
# bot identity without ever calling /user.
cat > "$CLEANUP_TMP/reviews.json" <<'JSONEOF'
[
  {"id": 55, "node_id": "PRR_node55", "state": "APPROVED", "user": {"login": "github-actions[bot]"},
   "body": "<!-- ai-pr-reviewer -->\nold default-token review"},
  {"id": 66, "node_id": "PRR_node66", "state": "APPROVED", "user": {"login": "its-saffron[bot]"},
   "body": "<!-- ai-pr-reviewer -->\nold app-token review"},
  {"id": 77, "node_id": "PRR_node77", "state": "APPROVED", "user": {"login": "human"},
   "body": "LGTM"}
]
JSONEOF

# True-to-production mock: /user prints the JSON error body to stdout and
# exits 1 (gh api does NOT apply --jq to error responses).
cat > "$CLEANUP_TMP/bin/gh" <<SHELLEOF
#!/usr/bin/env bash
echo "\$*" >> "$CALL_LOG"
if [ "\$1" = "api" ] && [ "\$2" = "user" ]; then
  printf '{\n  "message": "Resource not accessible by integration",\n  "status": "403"\n}\n'
  exit 1
fi
case "\$*" in
  *"/reviews --paginate"*) cat "$CLEANUP_TMP/reviews.json" ;;
  *dismissals*) echo '{"id": 1}' ;;
  *"api graphql"*) echo '{"data":{"minimizeComment":{"minimizedComment":{"isMinimized":true}}}}' ;;
  *"--method PUT"*) echo '{}' ;;
esac
exit 0
SHELLEOF
chmod +x "$CLEANUP_TMP/bin/gh"

CLEANUP_OUTPUT="$(
  PATH="$CLEANUP_TMP/bin:$PATH" \
  GH_TOKEN=test REPO="test/repo" PR_NUMBER=9 COMMENT_MARKER="<!-- ai-pr-reviewer -->" \
  bash -c 'source "'"$HELPER_SCRIPT"'"; cleanup_native_reviews true' 2>&1
)"

check_contains "default-token bot review is dismissed" \
  "$CLEANUP_OUTPUT" "Dismissed outdated managed review #55 (APPROVED)"
check_contains "app-token bot review is dismissed (no identity needed)" \
  "$CLEANUP_OUTPUT" "Dismissed outdated managed review #66 (APPROVED)"
check_contains "reviews are minimized (hidden) in the timeline" \
  "$CLEANUP_OUTPUT" "Minimized (hidden as outdated) review #55"
check_not_contains "human review untouched" \
  "$CLEANUP_OUTPUT" "#77"
check_not_contains "cleanup is not skipped" \
  "$CLEANUP_OUTPUT" "skipping cleanup"
check_not_contains "no identity fallback remains" \
  "$CLEANUP_OUTPUT" "assuming github-actions"
USER_CALLS="$(grep -c '^api user' "$CALL_LOG" || true)"
check "no /user lookup is made" "$USER_CALLS" "0"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
