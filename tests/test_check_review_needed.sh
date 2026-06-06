#!/usr/bin/env bash
set -euo pipefail

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
case "$1" in
  "pr")
    case "$2" in
      "diff") cat /tmp/testfp_diff ;;
    esac
    ;;
  "api")
    if echo "$*" | grep -q 'comments'; then
      cat /tmp/testfp_comments.json
    fi
    ;;
esac
exit 0
SHELLEOF
chmod +x "$TMPDIR/bin/gh"

run_precheck() {
  local output_file="$TMPDIR/out_$RANDOM$RANDOM"
  printf '%s' "$FIXED_DIFF" > /tmp/testfp_diff
  (
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
    bash "$PRECHECK_SCRIPT"
  )
  cat "$output_file"
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
  (
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

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
