#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Regression test for the compare-shas extraction block in context.sh
# (scripts/sections/context.sh). The two `_old_sha`/`_new_sha` assignments are
# bare `$(grep … | grep … | sort -u)` under `set -euo pipefail`. When a PR diff
# contains no hex SHAs (the common renovate image-tag bump, e.g.
# `0.8.19 → 0.8.21`), the inner `grep -iE '[a-f]'` returns no matches → exit 1
# → with pipefail the assignment aborts run_review.sh silently with exit code 1.
# The workflow run home-ops#7883 died exactly this way. The block must tolerate
# the no-SHA case (its own `if [ -n "$_old_sha" ]` guard already handles empty
# results) — the pipelines only need a `|| true` so set -e doesn't fire.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

# Extract the real production block (lines bounded by `: > compare-shas.txt`
# through its closing `fi`) so the test exercises the actual code, not a copy.
BLOCK="$(mktemp)"
trap 'rm -f "$BLOCK"' EXIT
python3 - "$ROOT_DIR/scripts/sections/context.sh" "$BLOCK" <<'PY'
import sys
src = open(sys.argv[1]).read().splitlines()
try:
    start = next(i for i, l in enumerate(src) if l.strip() == ': > compare-shas.txt')
except StopIteration:
    sys.exit("could not find ': > compare-shas.txt' in context.sh")
end = None
seen_if = False
for j in range(start + 1, len(src)):
    s = src[j].strip()
    if s.startswith('if [ -n "$_old_sha" ]'):
        seen_if = True
    if seen_if and s == 'fi':
        end = j
        break
if end is None:
    sys.exit("could not locate closing 'fi' of the compare-shas block")
open(sys.argv[2], "w").write("\n".join(src[start:end + 1]) + "\n")
PY

# Run the extracted block under the same flags run_review.sh establishes, in an
# isolated CWD, via a child process (not a subshell) so that `set -e` inside
# the child is independent of the parent’s `|| rc=$?` context.  A bash
# subshell in an `||` list runs in an "ignored context" where errexit is
# inert even if `set -e` is set inside it — that would defeat the test.
run_block() {
  local workdir="$1"
  rc=0
  bash -c 'cd "$1"; set -euo pipefail; source "$2"' _ "$workdir" "$BLOCK" || rc=$?
  # Always return 0: the child’s result is reported via the global $rc so the
  # parent test (which runs under set -e) can assert on it without aborting.
  return 0
}

echo "=== Test: no-SHA image bump must not abort under set -euo pipefail ==="
TD="$(mktemp -d)"
printf -- '-image: ghcr.io/defilantech/charts/llmkube:0.8.19\n+image: ghcr.io/defilantech/charts/llmkube:0.8.21\n-chart: llmkube-0.8.19\n+chart: llmkube-0.8.21\n' > "$TD/version-hints.txt"
run_block "$TD"
check "block survives no-SHA hints (exit 0)" "$rc" "0"
check "compare-shas.txt empty when no SHAs" "$(wc -l < "$TD/compare-shas.txt" | tr -d ' ')" "0"
rm -rf "$TD"

echo ""
echo "=== Test: only one side has a SHA (ambiguous) must not abort, writes nothing ==="
TD="$(mktemp -d)"
printf -- '-tag: app-1.2.3-abc1234\n+tag: app-1.2.4\n' > "$TD/version-hints.txt"
run_block "$TD"
check "block survives one-sided SHA hints (exit 0)" "$rc" "0"
check "compare-shas.txt empty when pair is ambiguous" "$(wc -l < "$TD/compare-shas.txt" | tr -d ' ')" "0"
rm -rf "$TD"

echo ""
echo "=== Test: unambiguous old->new short-SHA pair writes compare-shas.txt ==="
TD="$(mktemp -d)"
printf -- '-tag: llmkube-1.2.3-abc1234\n+tag: llmkube-1.2.4-def89ab\n' > "$TD/version-hints.txt"
run_block "$TD"
check "block survives paired-SHA hints (exit 0)" "$rc" "0"
check "compare-shas.txt holds the old->new pair" "$(cat "$TD/compare-shas.txt")" "abc1234 def89ab"
rm -rf "$TD"

echo ""
echo "=== Test: the production block guards both assignments with || true ==="
check "old_sha assignment guarded (|| true)" \
  "$(grep -cE '_old_sha=.*\|\| true' "$ROOT_DIR/scripts/sections/context.sh")" "1"
check "new_sha assignment guarded (|| true)" \
  "$(grep -cE '_new_sha=.*\|\| true' "$ROOT_DIR/scripts/sections/context.sh")" "1"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
