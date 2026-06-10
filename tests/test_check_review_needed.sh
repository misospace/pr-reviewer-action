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
    echo "SKIP: $dep is not available — cannot run test_check_review_needed.sh" >&2
    exit 0
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PRECHECK_SCRIPT="$ROOT_DIR/scripts/check_review_needed.sh"

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

# ── Setup ─────────────────────────────────────────────────────────────
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

mkdir -p "$TMPDIR/bin"

FIXED_DIFF='diff --git a/x b/x
index 123..456 644
--- a/x
+++ b/x
@@ -0,0 +1 @@
+new'

cat > "$TMPDIR/bin/gh" <<'SHELLEOF'
#!/usr/bin/env bash
echo "$*" >> /tmp/testfp_gh_calls.log
case "$1" in
  "pr")
    case "$2" in
      "diff") cat /tmp/testfp_diff ;;
    esac
    ;;
  "api")
    if echo "$*" | grep -q 'reviews'; then
      [ -f /tmp/testfp_reviews.json ] && cat /tmp/testfp_reviews.json
    elif echo "$*" | grep -q 'comments'; then
      cat /tmp/testfp_comments.json
    elif echo "$*" | grep -q 'pulls/42'; then
      [ -f /tmp/testfp_pr_object.json ] && cat /tmp/testfp_pr_object.json
    fi
    ;;
esac
exit 0
SHELLEOF
chmod +x "$TMPDIR/bin/gh"

cat > /tmp/testfp_pr_object.json <<'JSONEOF'
{
  "number": 42,
  "head": {"sha": "aaaa111122223333aaaa111122223333aaaa1111", "ref": "feature", "repo": {"full_name": "test/repo"}},
  "base": {"sha": "bbbb111122223333bbbb111122223333bbbb1111", "ref": "main", "repo": {"full_name": "test/repo"}}
}
JSONEOF

# The precheck writes pr.diff / pr-object.json into its CWD; run it in a
# scratch workdir so test runs do not litter the repository root.
WORKDIR="$TMPDIR/work"

run_precheck() {
  local output_file="$TMPDIR/out_$RANDOM$RANDOM"
  printf '%s' "$FIXED_DIFF" > /tmp/testfp_diff
  rm -rf "$WORKDIR" && mkdir -p "$WORKDIR"
  (
    cd "$WORKDIR" || exit 1
    PATH="$TMPDIR/bin:$PATH" \
    REPO="test/repo" \
    PR_NUMBER=42 \
    GITHUB_OUTPUT="$output_file" \
    ACTION_REF="${ACTION_REF:-}" \
    AI_MODEL="${AI_MODEL:-gpt-4}" \
    AI_API_FORMAT="${AI_API_FORMAT:-openai}" \
    AI_FALLBACK_MODEL="${AI_FALLBACK_MODEL:-}" \
    ANTHROPIC_VERSION="${ANTHROPIC_VERSION:-2023-06-01}" \
    SYSTEM_PROMPT="${SYSTEM_PROMPT:-}" \
    SYSTEM_PROMPT_FILE="${SYSTEM_PROMPT_FILE:-}" \
    STANDARDS_FILE="${STANDARDS_FILE:-}" \
    STANDARDS_FILE_CANDIDATES="${STANDARDS_FILE_CANDIDATES:-AGENTS.md,agents.md,CLAUDE.md}" \
    CONTEXT_LIMIT_MODE="${CONTEXT_LIMIT_MODE:-normal}" \
    EVIDENCE_PROVIDERS_FILE="${EVIDENCE_PROVIDERS_FILE:-}" \
    EVIDENCE_PROVIDER_TIMEOUT_SEC="${EVIDENCE_PROVIDER_TIMEOUT_SEC:-30}" \
    EVIDENCE_PROVIDER_MAX_OUTPUT_BYTES="${EVIDENCE_PROVIDER_MAX_OUTPUT_BYTES:-20000}" \
    EVIDENCE_BLOCKER_ENFORCEMENT="${EVIDENCE_BLOCKER_ENFORCEMENT:-false}" \
    EVIDENCE_ENABLE_FOR_FORKS="${EVIDENCE_ENABLE_FOR_FORKS:-false}" \
    TOOL_MODE="${TOOL_MODE:-off}" \
    TOOL_MAX_REQUESTS="${TOOL_MAX_REQUESTS:-4}" \
    TOOL_PLANNING_TIMEOUT_SEC="${TOOL_PLANNING_TIMEOUT_SEC:-30}" \
    TOOL_PLANNING_MAX_CONTEXT_BYTES="${TOOL_PLANNING_MAX_CONTEXT_BYTES:-50000}" \
    TOOL_PLANNING_MAX_TOKENS="${TOOL_PLANNING_MAX_TOKENS:-400}" \
    TOOL_MAX_RESPONSE_BYTES="${TOOL_MAX_RESPONSE_BYTES:-12000}" \
    TOOL_ALLOWED_GH_API_REPOS="${TOOL_ALLOWED_GH_API_REPOS:-}" \
    TOOL_REQUEST_TIMEOUT_SEC="${TOOL_REQUEST_TIMEOUT_SEC:-20}" \
    TOOL_FAILURE_ENFORCEMENT="${TOOL_FAILURE_ENFORCEMENT:-false}" \
    TOOL_MIN_SUCCESSFUL_REQUESTS="${TOOL_MIN_SUCCESSFUL_REQUESTS:-0}" \
    TOOL_ENABLE_FOR_FORKS="${TOOL_ENABLE_FOR_FORKS:-false}" \
    SKIP_IF_DIFF_UNCHANGED="${SKIP_IF_DIFF_UNCHANGED:-true}" \
    COMMENT_MARKER="${COMMENT_MARKER:-<!-- ai-pr-reviewer -->}" \
    PUBLISH_MODE="${PUBLISH_MODE:-comment}" \
    bash "$PRECHECK_SCRIPT"
  )
  cat "$output_file"
}

set_reviews() {
  local body="$1"
  python3 <<PYEOF > /tmp/testfp_reviews.json
import json
body = """${body}"""
print(json.dumps([{"body": body, "submitted_at": "2024-01-01T00:00:00Z"}]))
PYEOF
}

set_comments() {
  local body="$1"
  python3 <<PYEOF > /tmp/testfp_comments.json
import json
body = """${body}"""
print(json.dumps([{"body": body}]))
PYEOF
}

set_empty_comments() {
  echo '[]' > /tmp/testfp_comments.json
}

run_precheck_empty_diff() {
  local output_file="$TMPDIR/out_$RANDOM$RANDOM"
  printf '' > /tmp/testfp_diff
  rm -rf "$WORKDIR" && mkdir -p "$WORKDIR"
  (
    cd "$WORKDIR" || exit 1
    PATH="$TMPDIR/bin:$PATH" \
    REPO="test/repo" \
    PR_NUMBER=42 \
    GITHUB_OUTPUT="$output_file" \
    ACTION_REF="${ACTION_REF:-}" \
    AI_MODEL="${AI_MODEL:-gpt-4}" \
    AI_API_FORMAT="${AI_API_FORMAT:-openai}" \
    TOOL_MODE="${TOOL_MODE:-off}" \
    SKIP_IF_DIFF_UNCHANGED="${SKIP_IF_DIFF_UNCHANGED:-true}" \
    bash "$PRECHECK_SCRIPT"
  )
  cat "$output_file"
}

# ── Test 1: No previous comment → should_review=true ──────────────────
echo "=== Test 1: No previous review comment → must review ==="
set_empty_comments
RESULT="$(run_precheck)"
check "should_review=true when no prior comment" "$(echo "$RESULT" | grep '^should_review=' | head -1 | cut -d= -f2)" "true"

# ── Test 2: Matching broad fingerprint → should_review=false ─────────
echo ""
echo "=== Test 2: Matching broad fingerprint → skip ==="

OUTPUT_FP="$(run_precheck)"
BROAD_FP="$(echo "$OUTPUT_FP" | grep '^diff_fingerprint=' | head -1 | cut -d= -f2)"
set_comments "<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${BROAD_FP} -->
APPROVE"

RESULT="$(run_precheck)"
check "should_review=false when broad fingerprint matches" "$(echo "$RESULT" | grep '^should_review=' | head -1 | cut -d= -f2)" "false"

# ── Test 3: Changed model → different fingerprint → should_review=true ─
echo ""
echo "=== Test 3: Changed model triggers fresh review ==="
set_comments "<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${BROAD_FP} -->
APPROVE"
ACTION_REF="v1.0.0" AI_MODEL="claude-sonnet-4" AI_API_FORMAT="anthropic" CONTEXT_LIMIT_MODE="normal" TOOL_MODE="off" SKIP_IF_DIFF_UNCHANGED=true RESULT="$(run_precheck)"
check "should_review=true when model changed" "$(echo "$RESULT" | grep '^should_review=' | head -1 | cut -d= -f2)" "true"

# ── Test 4: Changed context limit mode → different fingerprint ────────
echo ""
echo "=== Test 4: Changed context limit mode triggers fresh review ==="
ACTION_REF="v1.0.0" AI_MODEL="gpt-4" AI_API_FORMAT="openai" CONTEXT_LIMIT_MODE="low" TOOL_MODE="off" SKIP_IF_DIFF_UNCHANGED=true RESULT="$(run_precheck)"
check "should_review=true when context_limit_mode changed" "$(echo "$RESULT" | grep '^should_review=' | head -1 | cut -d= -f2)" "true"

# ── Test 5: Changed tool mode → different fingerprint ─────────────────
echo ""
echo "=== Test 5: Changed tool mode triggers fresh review ==="
ACTION_REF="v1.0.0" AI_MODEL="gpt-4" AI_API_FORMAT="openai" CONTEXT_LIMIT_MODE="normal" TOOL_MODE="plan_execute_once" SKIP_IF_DIFF_UNCHANGED=true RESULT="$(run_precheck)"
check "should_review=true when tool_mode changed" "$(echo "$RESULT" | grep '^should_review=' | head -1 | cut -d= -f2)" "true"

# ── Test 6: skip_if_diff_unchanged=false → always review ─────────────
echo ""
echo "=== Test 6: SKIP_IF_DIFF_UNCHANGED=false → always review ==="
ACTION_REF="v1.0.0" AI_MODEL="gpt-4" AI_API_FORMAT="openai" CONTEXT_LIMIT_MODE="normal" TOOL_MODE="off" SKIP_IF_DIFF_UNCHANGED=false RESULT="$(run_precheck)"
check "should_review=true when skip disabled" "$(echo "$RESULT" | grep '^should_review=' | head -1 | cut -d= -f2)" "true"

# ── Test 7: Fingerprint format includes both diff and config parts ───
echo ""
echo "=== Test 7: Fingerprint contains pipe-delimited config hash ==="
SKIP_IF_DIFF_UNCHANGED=true RESULT="$(run_precheck)"
DIFF_FP="$(echo "$RESULT" | grep '^diff_fingerprint=' | head -1 | cut -d= -f2)"
if [[ "$DIFF_FP" == *"|"* ]]; then
  check "broad fingerprint has pipe delimiter (diff|cfg:hash)" "yes" "yes"
else
  check "broad fingerprint has pipe delimiter" "no" "yes"
fi

# ── Test 8: Empty diff produces "empty-diff" placeholder ──────────────
echo ""
echo "=== Test 8: Empty diff fingerprint ==="
set_empty_comments
ACTION_REF="v1.0.0" AI_MODEL="gpt-4" AI_API_FORMAT="openai" TOOL_MODE="off" SKIP_IF_DIFF_UNCHANGED=true RESULT="$(run_precheck_empty_diff)"
DIFF_FP="$(echo "$RESULT" | grep '^diff_fingerprint=' | head -1 | cut -d= -f2)"
if [[ "$DIFF_FP" == *"empty-diff"* ]]; then
  check "empty diff handled with empty-diff placeholder" "yes" "yes"
else
  check "empty diff fingerprint contains 'empty-diff'" "no" "yes"
fi

# ── Test 9: Changed action ref triggers review ──────────────────────
echo ""
echo "=== Test 9: Changed action ref triggers fresh review ==="
printf '%s' "$FIXED_DIFF" > /tmp/testfp_diff
set_comments "<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${BROAD_FP} -->
APPROVE"
ACTION_REF="v2.0.0" AI_MODEL="gpt-4" AI_API_FORMAT="openai" CONTEXT_LIMIT_MODE="normal" TOOL_MODE="off" SKIP_IF_DIFF_UNCHANGED=true RESULT="$(run_precheck)"
check "should_review=true when action_ref changed" "$(echo "$RESULT" | grep '^should_review=' | head -1 | cut -d= -f2)" "true"

# ── Test 10: Same config + same diff → skip ─────────────────────────
echo ""
echo "=== Test 10: Same config + same diff → skip ==="
set_comments "<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${BROAD_FP} -->
APPROVE"

# Unset ACTION_REF to ensure it uses default (empty), matching test 2's fingerprint
unset ACTION_REF
RESULT="$(run_precheck)"

check "should_review=false when everything matches" "$(echo "$RESULT" | grep '^should_review=' | head -1 | cut -d= -f2)" "false"

# ── Test 11: review_verdict mode reads prior state from PR reviews ────
echo ""
echo "=== Test 11: review_verdict mode finds the fingerprint in a PR review → skip ==="
unset ACTION_REF
rm -f /tmp/testfp_reviews.json
set_empty_comments
OUTPUT_FP_RV="$(PUBLISH_MODE=review_verdict run_precheck)"
BROAD_FP_RV="$(echo "$OUTPUT_FP_RV" | grep '^diff_fingerprint=' | head -1 | cut -d= -f2)"
set_reviews "<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${BROAD_FP_RV} -->
APPROVE"
RESULT="$(PUBLISH_MODE=review_verdict run_precheck)"
check "should_review=false when a PR review fingerprint matches (review_verdict)" "$(echo "$RESULT" | grep '^should_review=' | head -1 | cut -d= -f2)" "false"

# ── Test 12: review_verdict ignores issue comments for prior state ───
echo ""
echo "=== Test 12: review_verdict does not read issue comments for prior state ==="
rm -f /tmp/testfp_reviews.json
# The matching fingerprint is only in an issue comment now; with no PR review
# carrying it, review_verdict mode must fall back to a fresh review.
set_comments "<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${BROAD_FP_RV} -->
APPROVE"
RESULT="$(PUBLISH_MODE=review_verdict run_precheck)"
check "should_review=true when only an issue comment matches (review_verdict)" "$(echo "$RESULT" | grep '^should_review=' | head -1 | cut -d= -f2)" "true"

# ── Test 13: skip path short-circuits the PR-object fetch ─────────────
echo ""
echo "=== Test 13: should_review=false short-circuits scope resolution ==="
rm -f /tmp/testfp_reviews.json
set_empty_comments
OUTPUT_FP_SC="$(run_precheck)"
BROAD_FP_SC="$(echo "$OUTPUT_FP_SC" | grep '^diff_fingerprint=' | head -1 | cut -d= -f2)"
set_comments "<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${BROAD_FP_SC} -->
APPROVE"
: > /tmp/testfp_gh_calls.log
RESULT="$(run_precheck)"
check "should_review=false on matching fingerprint" "$(echo "$RESULT" | grep '^should_review=' | head -1 | cut -d= -f2)" "false"
PULLS_FETCHES="$(grep -c 'api repos/test/repo/pulls/42$' /tmp/testfp_gh_calls.log || true)"
check "PR object is not fetched when skipping" "$PULLS_FETCHES" "0"
check "skip path still emits scope output" "$(echo "$RESULT" | grep -c '^effective_review_scope=')" "1"

# ── Test 14: review path emits PR facts and reusable files ───────────
echo ""
echo "=== Test 14: review path forwards head/base SHA, fork flag, and files ==="
set_empty_comments
: > /tmp/testfp_gh_calls.log
RESULT="$(run_precheck)"
check "should_review=true" "$(echo "$RESULT" | grep '^should_review=' | head -1 | cut -d= -f2)" "true"
check "head_sha output forwarded" "$(echo "$RESULT" | grep '^head_sha=' | head -1 | cut -d= -f2)" "aaaa111122223333aaaa111122223333aaaa1111"
check "base_sha output forwarded" "$(echo "$RESULT" | grep '^base_sha=' | head -1 | cut -d= -f2)" "bbbb111122223333bbbb111122223333bbbb1111"
check "is_fork_pr output forwarded" "$(echo "$RESULT" | grep '^is_fork_pr=' | head -1 | cut -d= -f2)" "false"
check "pr.diff saved for reuse by run_review" "$(test -s "$WORKDIR/pr.diff" && echo yes || echo no)" "yes"
check "pr-object.json saved for reuse by run_review" "$(test -s "$WORKDIR/pr-object.json" && echo yes || echo no)" "yes"
PULLS_FETCHES="$(grep -c 'api repos/test/repo/pulls/42$' /tmp/testfp_gh_calls.log || true)"
check "PR object fetched exactly once" "$PULLS_FETCHES" "1"
DIFF_FETCHES="$(grep -c '^pr diff' /tmp/testfp_gh_calls.log || true)"
check "diff fetched exactly once" "$DIFF_FETCHES" "1"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
