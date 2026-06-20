#!/usr/bin/env bash
set -uo pipefail

# Tests for emit_review_markers (#296): the publish steps' marker preamble is
# now a single sourced helper instead of inline heredoc text in three places.
# This pins the emitted order/content AND the fail-loud guard, so a future
# refactor can't silently drop the markers that skip-on-unchanged
# (check_review_needed.sh) and managed-comment cleanup rely on.

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

# shellcheck disable=SC1090
source "$ROOT_DIR/scripts/publish_helpers.sh"
set +e  # we deliberately exercise the fail-loud path below

# Full preamble: sticky marker, metadata marker, head-sha, fingerprint — in order.
out="$(COMMENT_MARKER='<!-- ai-pr-reviewer -->' METADATA_MARKER='<!-- ai-pr-reviewer:{} -->' HEAD_SHA='abc123' BROAD_FINGERPRINT='fp1|cfg:xyz' emit_review_markers)"
check "sticky marker first"       "$(printf '%s\n' "$out" | sed -n '1p')" '<!-- ai-pr-reviewer -->'
check "metadata marker second"    "$(printf '%s\n' "$out" | sed -n '2p')" '<!-- ai-pr-reviewer:{} -->'
check "head-sha marker third"     "$(printf '%s\n' "$out" | sed -n '3p')" '<!-- ai-pr-review-sha:abc123 -->'
check "fingerprint marker fourth" "$(printf '%s\n' "$out" | sed -n '4p')" '<!-- ai-pr-review-fingerprint:fp1|cfg:xyz -->'
check "exactly four lines"        "$(printf '%s\n' "$out" | grep -c .)" "4"

# Optional markers omitted when unset → only the two required lines.
out2="$(COMMENT_MARKER='<!-- ai-pr-reviewer -->' METADATA_MARKER='<!-- ai-pr-reviewer:{} -->' HEAD_SHA='' BROAD_FINGERPRINT='' emit_review_markers)"
check "omits optional markers when unset" "$(printf '%s\n' "$out2" | grep -c .)" "2"

# Fail-loud: a missing required marker must abort (non-zero), never emit a
# marker-less comment that breaks skip-on-unchanged.
if ( unset COMMENT_MARKER; METADATA_MARKER='x' emit_review_markers >/dev/null 2>&1 ); then
  check "missing COMMENT_MARKER fails loudly" "did-not-fail" "should-fail"
else
  check "missing COMMENT_MARKER fails loudly" "should-fail" "should-fail"
fi

echo ""
echo "emit_review_markers: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
