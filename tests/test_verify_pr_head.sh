#!/usr/bin/env bash
set -euo pipefail

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
  printf '%s\n' "${TEST_CURRENT_HEAD:-}"
  exit 0
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

echo "=== current PR head ==="
TEST_CURRENT_HEAD=abc123 run_verify >/dev/null
check "current head succeeds" "$?" "0"

echo "=== superseded PR head ==="
set +e
TEST_CURRENT_HEAD=def456 run_verify >/dev/null 2>&1
RC=$?
set -e
check "superseded head has distinct no-publication status" "$RC" "3"

echo "=== unavailable PR head ==="
set +e
TEST_CURRENT_HEAD= run_verify >/dev/null 2>&1
RC=$?
set -e
check "unavailable head fails closed" "$RC" "2"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
