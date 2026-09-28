#!/usr/bin/env bash
set -euo pipefail

# Tests for scripts/resolve_harvest_scope.sh -- the app-token scope
# computation for the Harvest Human Findings workflow (#798/#800
# follow-up, nit 4).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCOPE_SCRIPT="$ROOT_DIR/scripts/resolve_harvest_scope.sh"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

run_scope() {
  # args: REPOS CURRENT_REPO
  local out="$TMPDIR/output-$RANDOM"
  : > "$out"
  set +e
  REPOS="$1" CURRENT_REPO="$2" GITHUB_OUTPUT="$out" bash "$SCOPE_SCRIPT" >"$TMPDIR/stdout" 2>"$TMPDIR/stderr"
  RC=$?
  set -e
  LAST_OUTPUT="$out"
}

echo "=== single owner, current repo folded in and de-duplicated ==="
run_scope "misospace/pr-reviewer-action,misospace/other-repo" "misospace/pr-reviewer-action"
check "exits 0" "$RC" "0"
OWNER="$(grep '^owner=' "$LAST_OUTPUT" | cut -d= -f2-)"
REPOS_OUT="$(grep '^repos=' "$LAST_OUTPUT" | cut -d= -f2-)"
check "owner resolved" "$OWNER" "misospace"
check "repos de-duplicated, order preserved" "$REPOS_OUT" "pr-reviewer-action,other-repo"

echo ""
echo "=== empty HARVEST_REPOS falls back to just the current repo ==="
run_scope "" "misospace/pr-reviewer-action"
check "exits 0" "$RC" "0"
OWNER="$(grep '^owner=' "$LAST_OUTPUT" | cut -d= -f2-)"
REPOS_OUT="$(grep '^repos=' "$LAST_OUTPUT" | cut -d= -f2-)"
check "owner resolved from current repo" "$OWNER" "misospace"
check "repos is just the current repo" "$REPOS_OUT" "pr-reviewer-action"

echo ""
echo "=== whitespace around CSV entries is trimmed ==="
run_scope " misospace/pr-reviewer-action , misospace/other-repo " "misospace/pr-reviewer-action"
check "exits 0" "$RC" "0"
REPOS_OUT="$(grep '^repos=' "$LAST_OUTPUT" | cut -d= -f2-)"
check "repos trimmed" "$REPOS_OUT" "pr-reviewer-action,other-repo"

echo ""
echo "=== malformed slug (no owner/repo separator) fails clearly ==="
run_scope "not-a-slug" "misospace/pr-reviewer-action"
check "exits non-zero" "$([ "$RC" -ne 0 ] && echo yes || echo no)" "yes"
ERR="$(cat "$TMPDIR/stdout" "$TMPDIR/stderr")"
check_contains "error names the bad slug" "$ERR" "not-a-slug"

echo ""
echo "=== repos spanning multiple owners fails clearly ==="
run_scope "misospace/pr-reviewer-action,otherorg/foo" "misospace/pr-reviewer-action"
check "exits non-zero" "$([ "$RC" -ne 0 ] && echo yes || echo no)" "yes"
ERR="$(cat "$TMPDIR/stdout" "$TMPDIR/stderr")"
check_contains "error explains the multi-owner conflict" "$ERR" "multiple owners"

echo ""
echo "=== missing owner segment ('/repo') fails clearly ==="
run_scope "/repo" "misospace/pr-reviewer-action"
check "exits non-zero" "$([ "$RC" -ne 0 ] && echo yes || echo no)" "yes"
ERR="$(cat "$TMPDIR/stdout" "$TMPDIR/stderr")"
check_contains "error names the bad slug" "$ERR" "/repo"

echo ""
echo "=== missing repo segment ('owner/') fails clearly ==="
run_scope "owner/" "misospace/pr-reviewer-action"
check "exits non-zero" "$([ "$RC" -ne 0 ] && echo yes || echo no)" "yes"
ERR="$(cat "$TMPDIR/stdout" "$TMPDIR/stderr")"
check_contains "error names the bad slug" "$ERR" "owner/"

echo ""
echo "=== extra segment ('owner/repo/extra') fails clearly ==="
run_scope "owner/repo/extra" "misospace/pr-reviewer-action"
check "exits non-zero" "$([ "$RC" -ne 0 ] && echo yes || echo no)" "yes"
ERR="$(cat "$TMPDIR/stdout" "$TMPDIR/stderr")"
check_contains "error names the bad slug" "$ERR" "owner/repo/extra"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
