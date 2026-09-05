#!/usr/bin/env bash
set -uo pipefail

# Tests for scripts/publish.sh (#541): the Publish step's dispatcher was
# extracted from action.yml's inline run block into a standalone script.
# These tests run the REAL scripts/publish.sh end-to-end with gh/jq/python3
# stubbed via PATH, pinning:
#   - each PUBLISH_MODE dispatches to the correct platform helper
#   - verify_pr_head exit 3 (superseded) is reported as ::notice, not a failure
#   - verify_pr_head exit 2 (head unavailable) still propagates as failure

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
check() {
  local desc="$1" result="$2" expected="$3"
  if [[ "$result" == "$expected" ]]; then
    echo "  PASS: $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc"; echo "    expected: [$expected]"; echo "    got:      [$result]"; FAIL=$((FAIL + 1))
  fi
}
check_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  PASS: $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected to contain '$needle')"; FAIL=$((FAIL + 1))
  fi
}
check_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "  PASS: $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (should not contain '$needle')"; FAIL=$((FAIL + 1))
  fi
}

# ── Stub harness ─────────────────────────────────────────────────────────
# A fresh temp dir per scenario: bin/ holds the gh/jq/python3 stubs, the
# rest is the working dir the publish script writes its body files into.
# GH_LOG records every gh invocation so dispatch assertions can inspect
# exactly which platform helper each mode reached.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
GH_LOG="$TMP/gh-calls.log"

make_stubs() {
  local head_sha="$1"
  : > "$GH_LOG"
  mkdir -p "$TMP/bin"
  cat > "$TMP/bin/gh" <<SHEOF
#!/usr/bin/env bash
echo "\$*" >> "$GH_LOG"
case "\$*" in
  *"/reviews --paginate"*) echo '[]' ;;
  *"/reviews"*) echo '{}' ;;
  *"pulls/42"*) printf '%s' "$head_sha" ;;
  *"pr comment"*) echo 'ok' ;;
  *"pr review"*) echo 'ok' ;;
esac
exit 0
SHEOF
  cat > "$TMP/bin/jq" <<'JQEOF'
#!/usr/bin/env bash
# Minimal jq stand-in for the publish dispatcher's call shapes:
#   jq -e 'type == "array"'            → 0 iff stdin is a JSON array
#   jq -nc --arg k v ... 'prog'        → marker JSON (args inlined)
#   jq -n --rawfile ... 'prog'         → review-request JSON
#   jq 'length'                        → element count of a JSON array
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --arg|--argjson)
      if [ $# -ge 2 ]; then shift 2; else shift; fi ;;
    *) args+=("$1"); shift ;;
  esac
done
joined="${args[*]:-}"
case "$joined" in
  *"-nc"*) printf '{"stub":true}' ;;
  *"-n"*)  printf '{"event":"COMMENT","commit_id":"abc123","comments":[{"path":"a.go","line":3,"body":"m"}],"stub":true}' ;;
  *"type == \"array\""*)
    if [[ "$(cat)" == \[* ]]; then exit 0; else exit 1; fi
    ;;
  *"length"*)
    n=$( { grep -o '{' || true; } | wc -l | tr -d ' ' )
    printf '%s' "$n"
    ;;
  *) printf '{"stub":true}' ;;
esac
exit 0
JQEOF
  cat > "$TMP/bin/python3" <<'PYEOF'
#!/usr/bin/env bash
# Stub for the publish pipeline's python calls:
#   build_review_comments.py findings diff out → write one comment to $3
#   *.py file (sanitizers, in-place)           → copy the file through
script=""
for a in "$@"; do
  case "$a" in *.py) script="$a" ;; esac
done
case "$script" in
  *build_review_comments.py)
    # build_review_comments.py findings diff out → write one comment to $4
    printf '[{"path":"a.go","line":3,"body":"m"}]' > "$4"
    ;;
  *)
    # In-place sanitizers: the file already holds the review markdown; no-op.
    ;;
esac
exit 0
PYEOF
  chmod +x "$TMP/bin/gh" "$TMP/bin/jq" "$TMP/bin/python3"
}

# Run the real dispatcher in a clean working dir; echoes nothing, sets
# OUT (combined output) and RC.
run_publish() {
  local work="$TMP/work"
  rm -rf "$work"; mkdir -p "$work"
  # pr.diff is written by the review step in production; the inline-findings
  # comment builder validates anchors against it.
  printf -- '--- a/a.go\n+++ b/a.go\n@@ -1 +1 @@\n-old\n+new\n' > "$work/pr.diff"
  OUT="$(
    cd "$work"
    PATH="$TMP/bin:$PATH" \
    GITHUB_ACTION_PATH="$ROOT_DIR" \
    GH_TOKEN=test-token \
    REPO="test/repo" \
    PR_NUMBER=42 \
    HEAD_SHA=abc123 \
    BROAD_FINGERPRINT="fp1|cfg:xyz" \
    VERDICT="${VERDICT:-approve}" \
    REVIEW_MARKDOWN="## Review body" \
    ANALYSIS_ENGINE="openai/gpt-test" \
    EFFECTIVE_SCOPE="${EFFECTIVE_SCOPE:-full}" \
    BASE_SHA=base123 \
    PREVIOUS_HEAD_SHA="" \
    COMMENT_MARKER="<!-- ai-pr-reviewer -->" \
    PUBLISH_MODE="$PUBLISH_MODE" \
    ALLOW_APPROVE="${ALLOW_APPROVE:-false}" \
    APPROVE_FORKS="${APPROVE_FORKS:-false}" \
    IS_FORK_PR=false \
    BASELINE_CLEAN=false \
    INLINE_FINDINGS="${INLINE_FINDINGS:-false}" \
    INLINE_FINDINGS_MAX=20 \
    FINDINGS="${FINDINGS:-}" \
    CLEANUP_PREVIOUS_NATIVE_REVIEWS=auto \
    bash "$ROOT_DIR/scripts/publish.sh" 2>&1
  )"
  RC=$?
}

echo "=== action.yml wiring ==="
ACTION_YML="$ROOT_DIR/action.yml"
check_contains "Publish step is a one-liner invoking scripts/publish.sh" \
  "$(cat "$ACTION_YML")" 'run: bash "${{ github.action_path }}/scripts/publish.sh"'
check "no inline case dispatch remains in action.yml" \
  "$(grep -c 'case "$PUBLISH_MODE"' "$ACTION_YML" || true)" "0"
check "dispatcher script exists and is executable" \
  "$(test -x "$ROOT_DIR/scripts/publish.sh" && echo 1 || echo 0)" "1"

echo ""
echo "=== PUBLISH_MODE=comment dispatches to platform_comment_sticky ==="
make_stubs "abc123"
PUBLISH_MODE=comment run_publish
check "exit 0" "$RC" "0"
check_contains "gh pr comment called (sticky)" \
  "$(cat "$GH_LOG")" 'pr comment 42 --repo test/repo --edit-last --create-if-none --body-file review-comment.md'
BODY="$(cat "$TMP/work/review-comment.md")"
check_contains "body starts with sticky marker" "$BODY" '<!-- ai-pr-reviewer -->'
check_contains "body carries metadata marker" "$BODY" '<!-- ai-pr-reviewer:'
check_contains "body carries head-sha marker" "$BODY" '<!-- ai-pr-review-sha:abc123 -->'
check_contains "body carries fingerprint marker" "$BODY" '<!-- ai-pr-review-fingerprint:fp1|cfg:xyz -->'
check_contains "body carries verdict prefix" "$BODY" 'Automated recommendation: APPROVE'
check_contains "body carries analysis engine line" "$BODY" '_Analysis engine: openai/gpt-test_'
check_contains "body carries sanitized markdown" "$BODY" '## Review body'
check_not_contains "no native review posted in comment mode" \
  "$(cat "$GH_LOG")" 'pr review'

echo ""
echo "=== PUBLISH_MODE=review_comment: sticky + cleanup + inline findings review ==="
make_stubs "abc123"
PUBLISH_MODE=review_comment INLINE_FINDINGS=true \
  FINDINGS='[{"severity":"major","category":"x","file":"a.go","line":3,"message":"m"}]' run_publish
check "exit 0" "$RC" "0"
check_contains "previous native reviews listed (cleanup)" \
  "$(cat "$GH_LOG")" 'api repos/test/repo/pulls/42/reviews --paginate'
check_contains "sticky comment posted" \
  "$(cat "$GH_LOG")" 'pr comment 42 --repo test/repo --edit-last --create-if-none --body-file review-comment-body.md'
check_contains "inline findings posted as native COMMENT review" \
  "$(cat "$GH_LOG")" 'api repos/test/repo/pulls/42/reviews --method POST --input review-request.json'
REQ="$(cat "$TMP/work/review-request.json")"
check_contains "inline review event is COMMENT" "$REQ" '"event":"COMMENT"'
check_contains "inline review body carries managed marker" \
  "$(cat "$TMP/work/inline-findings-body.md")" 'Inline findings from the automated review'
check_contains "inline review carries comments array" "$REQ" '"comments":'
check_contains "output reports attached inline findings" "$OUT" 'Attached 1 inline finding comment(s)'

echo ""
echo "=== PUBLISH_MODE=review_verdict dispatches to native review ==="
make_stubs "abc123"
PUBLISH_MODE=review_verdict ALLOW_APPROVE=true run_publish
check "exit 0" "$RC" "0"
check_contains "previous native reviews listed (cleanup)" \
  "$(cat "$GH_LOG")" 'api repos/test/repo/pulls/42/reviews --paginate'
check_contains "native approval submitted commit-bound (platform_review_create_json)" \
  "$(cat "$GH_LOG")" 'api repos/test/repo/pulls/42/reviews --method POST --input review-request.json'
check_contains "approval payload is commit-bound" \
  "$(cat "$TMP/work/review-request.json")" '"commit_id"'
check_contains "output reports native review" "$OUT" 'Submitted native review (APPROVE)'
VBODY="$(cat "$TMP/work/review-verdict-body.md")"
check_contains "verdict body carries managed marker" "$VBODY" '<!-- ai-pr-reviewer -->'
check_contains "verdict body carries full-review note" "$VBODY" '_Full PR review._'

echo ""
echo "=== verify_pr_head exit 3 (superseded) is a notice, not a failure ==="
make_stubs "newer-sha"
PUBLISH_MODE=comment run_publish
check "exit 0 (run not failed)" "$RC" "0"
check_contains "superseded reported as ::notice" "$OUT" '::notice title=AI review not published::'
check_not_contains "nothing published when superseded" \
  "$(cat "$GH_LOG")" 'pr comment'

echo ""
echo "=== verify_pr_head exit 2 (head unavailable) propagates as failure ==="
make_stubs ""
PUBLISH_MODE=comment run_publish
check "exit 2 propagates" "$RC" "2"
check_not_contains "no ::notice for a hard failure" "$OUT" '::notice'
check_not_contains "nothing published when head unavailable" \
  "$(cat "$GH_LOG")" 'pr comment'

echo ""
echo "=== unknown PUBLISH_MODE fails loudly ==="
make_stubs "abc123"
PUBLISH_MODE=bogus run_publish
check "non-zero exit" "$([ "$RC" -ne 0 ] && echo 1 || echo 0)" "1"
check_contains "unknown mode reported" "$OUT" 'Unknown publish_mode: bogus'

echo ""
echo "publish_dispatch: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
