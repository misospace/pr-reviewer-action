#!/usr/bin/env bash
set -euo pipefail

# Tests for scripts/verify_pr_head.sh — the publication-boundary guard that
# refuses to publish a verdict once a newer push has superseded the reviewed
# head (issue #451). Exit codes: 0=current, 2=head unavailable, 3=superseded.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERIFY_SCRIPT="$ROOT_DIR/scripts/verify_pr_head.sh"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
mkdir -p "$TMPDIR/bin"
cat > "$TMPDIR/bin/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == "api repos/o/r/pulls/7 --jq .head.sha" ]]; then
  if [[ -n "${TEST_CURRENT_HEAD:-}" ]]; then
    printf '%s\n' "$TEST_CURRENT_HEAD"
    exit 0
  fi
  exit 1
fi
exit 1
EOF
chmod +x "$TMPDIR/bin/gh"

run_verify() {
  PATH="$TMPDIR/bin:$PATH" \
    PLATFORM=github \
    REPO=o/r \
    PR_NUMBER=7 \
    EXPECTED_HEAD_SHA=abc123 \
    GITHUB_ACTION_PATH="$ROOT_DIR" \
    bash "$VERIFY_SCRIPT"
}

echo "=== current PR head publishes ==="
set +e
TEST_CURRENT_HEAD=abc123 run_verify >/dev/null 2>&1
RC=$?
set -e
check "current head exits 0" "$RC" "0"

echo ""
echo "=== superseded PR head is not published ==="
set +e
OUT="$(TEST_CURRENT_HEAD=def456 run_verify 2>&1)"
RC=$?
set -e
check "superseded head exits 3" "$RC" "3"
check_contains "superseded head explains itself" "$OUT" "superseded"

echo ""
echo "=== unavailable PR head fails closed ==="
set +e
TEST_CURRENT_HEAD= run_verify >/dev/null 2>&1
RC=$?
set -e
check "unavailable head exits 2" "$RC" "2"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
