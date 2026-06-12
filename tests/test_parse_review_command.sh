#!/usr/bin/env bash
set -euo pipefail

# Tests for scripts/parse_review_command.sh — the authorization gate for a
# comment-triggered re-review.

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$ROOT_DIR/scripts/parse_review_command.sh"

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

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

# Mock gh: derive permission from the login in the API path. The "ghost404"
# login mimics gh's real failure mode — it writes a JSON error body to STDOUT
# and exits non-zero, so we verify the helper rc-checks rather than capturing
# that body as a "permission".
cat > "$TMP/bin/gh" <<'SHELLEOF'
#!/usr/bin/env bash
args="$*"
case "$args" in
  *collaborators/adminuser/permission*) echo "admin"; exit 0 ;;
  *collaborators/writeuser/permission*) echo "write"; exit 0 ;;
  *collaborators/readuser/permission*)  echo "read";  exit 0 ;;
  *collaborators/ghost404/permission*)  echo '{"message":"Not Found","status":"404"}'; exit 1 ;;
esac
echo '{"message":"unexpected mock call"}'; exit 1
SHELLEOF
chmod +x "$TMP/bin/gh"

# $1=body $2=login $3=is_pr -> echoes "should_review|reason"
run_helper() {
  local out="$TMP/out_$RANDOM$RANDOM"
  (
    PATH="$TMP/bin:$PATH" \
    REPO="test/repo" GH_TOKEN="x" \
    COMMENT_BODY="$1" COMMENTER_LOGIN="$2" IS_PR_COMMENT="${3:-true}" \
    REVIEW_COMMAND="${REVIEW_COMMAND:-/ai-review}" \
    GITHUB_OUTPUT="$out" \
    bash "$HELPER" >/dev/null 2>&1
  )
  local sr rs
  sr="$(grep '^should_review=' "$out" | head -1 | cut -d= -f2)"
  rs="$(grep '^reason=' "$out" | head -1 | cut -d= -f2)"
  echo "${sr}|${rs}"
}

echo "=== parse_review_command.sh ==="

check "write-access user with command is authorized" \
  "$(run_helper "/ai-review please" writeuser)" "true|command-authorized"

check "admin user is authorized" \
  "$(run_helper "/ai-review" adminuser)" "true|command-authorized"

check "read-only user is rejected" \
  "$(run_helper "/ai-review" readuser)" "false|insufficient-permission"

check "non-collaborator (gh 404 to stdout) is rejected, not mis-parsed" \
  "$(run_helper "/ai-review" ghost404)" "false|permission-check-failed"

check "no command in body is a silent no-op" \
  "$(run_helper "looks good to me, /ai-reviews are great" writeuser)" "false|no-command"

check "command only mid-line (in prose) does not match" \
  "$(run_helper "I think we should run /ai-review later" adminuser)" "false|no-command"

check "command indented on its own line still matches" \
  "$(run_helper "  /ai-review" writeuser)" "true|command-authorized"

check "comment on a plain issue (not a PR) is ignored" \
  "$(run_helper "/ai-review" adminuser false)" "false|not-a-pr"

check "malformed login is rejected before any API call" \
  "$(run_helper "/ai-review" "bad login;rm -rf")" "false|invalid-login"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -gt 0 ]] && exit 1 || exit 0
