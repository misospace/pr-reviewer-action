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
    echo "SKIP: $dep is not available — cannot run test_corpus_standards_survival.sh" >&2
    exit 0
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

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
  local desc="$1" file="$2" needle="$3"
  if grep -qF "$needle" "$file"; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (needle '$needle' not found in $file)"
    FAIL=$((FAIL + 1))
  fi
}

check_not_contains() {
  local desc="$1" file="$2" needle="$3"
  if ! grep -qF "$needle" "$file"; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (needle '$needle' unexpectedly found in $file)"
    FAIL=$((FAIL + 1))
  fi
}

# ── Setup ─────────────────────────────────────────────────────────────
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# MAX_CORPUS for normal mode is 220 KB
MAX_CORPUS=220000

# Create a small standards file (~1 KB) with unique marker
STANDARDS_MARKER="UNIQUE-STANDARDS-MARKER-abc123xyz"
{
  echo "# Repository Standards and Conventions"
  echo "Derived from AGENTS.md for this repository."
  echo ""
  echo "$STANDARDS_MARKER"
  echo "This is a critical convention that must always be preserved in the review corpus,"
  echo "even when the diff is very large and exceeds MAX_CORPUS byte limits."
} > "$TMPDIR/standards-context.md"

# Create a body file larger than MAX_CORPUS (~250 KB of dummy content)
BODY_MARKER="UNIQUE-BODY-MARKER-def456uvw"
python3 -c "
import sys
marker = '$BODY_MARKER'
line = 'x' * 79 + chr(10)
buf = '# PR Diff (truncated)\n\`\`\`diff\n' + marker + chr(10)
target = 250000
while len(buf) < target:
    buf += line
buf += '\`\`\`\n'
sys.stdout.write(buf)
" > "$TMPDIR/review-corpus.body.md"

BODY_SIZE=$(wc -c < "$TMPDIR/review-corpus.body.md")
STANDARDS_SIZE=$(wc -c < "$TMPDIR/standards-context.md")

echo "Body size: $BODY_SIZE bytes (exceeds MAX_CORPUS=$MAX_CORPUS)"
echo "Standards size: $STANDARDS_SIZE bytes"

# ── Test 1: New truncation logic preserves standards ───────────────────
# Simulate the new build_review_corpus logic:
#   head -c "$MAX_CORPUS" review-corpus.body.md > review-corpus.body.truncated.md
#   { echo "# Repository Standards..."; cat standards-context.md; echo; cat body.truncated; } > review-corpus.md

head -c "$MAX_CORPUS" "$TMPDIR/review-corpus.body.md" > "$TMPDIR/review-corpus.body.truncated.md"

{
  echo "# Repository Standards and Conventions (AGENTS.md)"
  cat "$TMPDIR/standards-context.md"
  echo
  cat "$TMPDIR/review-corpus.body.truncated.md"
} > "$TMPDIR/review-corpus.md"

check_contains "Standards marker present in final corpus (new logic)" \
  "$TMPDIR/review-corpus.md" "$STANDARDS_MARKER"

check_contains "Body marker present in final corpus (new logic)" \
  "$TMPDIR/review-corpus.md" "$BODY_MARKER"

CORPUS_SIZE=$(wc -c < "$TMPDIR/review-corpus.md")
echo "Final corpus size: $CORPUS_SIZE bytes (MAX_CORPUS + standards = ~$(( MAX_CORPUS + STANDARDS_SIZE )) expected)"

# Verify final corpus exceeds MAX_CORPUS (standards + truncated body)
if [[ "$CORPUS_SIZE" -gt "$MAX_CORPUS" ]]; then
  echo "  PASS: Final corpus exceeds MAX_CORPUS (standards preserved in full)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Final corpus does not exceed MAX_CORPUS ($CORPUS_SIZE <= $MAX_CORPUS)"
  FAIL=$((FAIL + 1))
fi

# ── Test 2: Old truncation logic would have lost standards ─────────────
# Simulate the old build_review_corpus logic where standards was appended last:
#   { body sections; echo "# Standards"; cat standards-context.md; } > review-corpus.old.md
#   head -c "$MAX_CORPUS" review-corpus.old.md > review-corpus.truncated.old.md

{
  cat "$TMPDIR/review-corpus.body.md"
  echo
  echo "# Repository Standards and Conventions (AGENTS.md)"
  cat "$TMPDIR/standards-context.md"
} > "$TMPDIR/review-corpus.old.md"

head -c "$MAX_CORPUS" "$TMPDIR/review-corpus.old.md" > "$TMPDIR/review-corpus.truncated.old.md"

check_not_contains "Standards marker absent from old truncated corpus (old logic)" \
  "$TMPDIR/review-corpus.truncated.old.md" "$STANDARDS_MARKER"

# ── Test 3: Standards at beginning survives even extreme truncation ────
# With MAX_CORPUS=100, standards (~200 bytes) should still be partially present
# since it's prepended before the truncated body. The key assertion is that
# the standards header appears regardless of how small MAX_CORPUS gets.

SMALL_MAX=500

head -c "$SMALL_MAX" "$TMPDIR/review-corpus.body.md" > "$TMPDIR/small-body.truncated.md"

{
  echo "# Repository Standards and Conventions (AGENTS.md)"
  cat "$TMPDIR/standards-context.md"
  echo
  cat "$TMPDIR/small-body.truncated.md"
} > "$TMPDIR/small-corpus.md"

check_contains "Standards present even with extreme truncation (MAX=500)" \
  "$TMPDIR/small-corpus.md" "$STANDARDS_MARKER"

# ── Results ───────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi