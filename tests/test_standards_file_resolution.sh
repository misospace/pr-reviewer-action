#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

# Source the production resolve_standards_file and its containment guard
# (workspace_regular_file, scripts/sections/common.sh) verbatim.
# shellcheck source=/dev/null
source <(python3 - "$ROOT_DIR/scripts/sections/common.sh" "$ROOT_DIR/scripts/sections/config.sh" <<'PY2'
import sys
common = open(sys.argv[1], encoding="utf-8").read()
config = open(sys.argv[2], encoding="utf-8").read()
print(common[common.index("workspace_regular_file() {"):])
print(config[config.index("resolve_standards_file() {"):config.index("resolve_system_prompt() {")])
PY2
)

PASS=0
FAIL=0

# ── Setup ─────────────────────────────────────────────────────────────
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

mkdir -p "$TMPDIR/.agents"
echo "agent rule 1" > "$TMPDIR/.agents/rule_a.md"
echo "agent rule 2" > "$TMPDIR/.agents/rule_b.md"
echo "standards content" > "$TMPDIR/AGENTS.md"
echo "other file" > "$TMPDIR/CLAUDE.md"

# ── Test: plain file candidate resolves ────────────────────────────────
STANDARDS_FILE=""
STANDARDS_FILE_CANDIDATES="$TMPDIR/AGENTS.md"
resolve_standards_file
check "plain file candidate" "$STANDARDS_FILE" "$TMPDIR/AGENTS.md"

# ── Test: glob matches multiple files, first wins ─────────────────────
STANDARDS_FILE=""
STANDARDS_FILE_CANDIDATES="$TMPDIR/.agents/*.md"
resolve_standards_file
check "glob first match wins" "$STANDARDS_FILE" "$TMPDIR/.agents/rule_a.md"

# ── Test: non-matching glob silently skipped, falls through to next ───
STANDARDS_FILE=""
STANDARDS_FILE_CANDIDATES="$TMPDIR/.nonexistent/*.md,$TMPDIR/CLAUDE.md"
resolve_standards_file
check "non-matching glob falls through" "$STANDARDS_FILE" "$TMPDIR/CLAUDE.md"

# ── Test: only non-matching globs — STANDARDS_FILE remains empty ──────
STANDARDS_FILE=""
STANDARDS_FILE_CANDIDATES="$TMPDIR/.nonexistent/*.md"
resolve_standards_file
check "no matches leaves empty" "$STANDARDS_FILE" ""

# ── Test: explicit STANDARDS_FILE takes priority ──────────────────────
STANDARDS_FILE="$TMPDIR/CLAUDE.md"
STANDARDS_FILE_CANDIDATES="$TMPDIR/AGENTS.md"
resolve_standards_file
check "explicit file takes priority" "$STANDARDS_FILE" "$TMPDIR/CLAUDE.md"

# ── Test: mixed plain and glob candidates, plain found first ─────────
STANDARDS_FILE=""
STANDARDS_FILE_CANDIDATES="$TMPDIR/AGENTS.md,$TMPDIR/.agents/*.md"
resolve_standards_file
check "plain before glob wins" "$STANDARDS_FILE" "$TMPDIR/AGENTS.md"

# ── Test: mixed plain and glob, plain missing, glob found ─────────────
STANDARDS_FILE=""
STANDARDS_FILE_CANDIDATES="$TMPDIR/MISSING.md,$TMPDIR/.agents/*.md"
resolve_standards_file
check "missing plain then glob wins" "$STANDARDS_FILE" "$TMPDIR/.agents/rule_a.md"

# ── Test: whitespace around candidates is trimmed ─────────────────────
SPACE_PATH=" $TMPDIR/AGENTS.md "
STANDARDS_FILE=""
STANDARDS_FILE_CANDIDATES="${SPACE_PATH},$TMPDIR/CLAUDE.md"
resolve_standards_file
check "whitespace trimmed" "$STANDARDS_FILE" "$TMPDIR/AGENTS.md"

# ── Containment (#805): PR-controlled symlinks never resolve ──────────
WS="$TMPDIR/ws"
mkdir -p "$WS/real" "$TMPDIR/outside"
echo "runner secret" > "$TMPDIR/outside/secret.md"
echo "real rules" > "$WS/CLAUDE.md"
ln -s "$TMPDIR/outside/secret.md" "$WS/AGENTS.md"
ln -s "$TMPDIR/outside" "$WS/docs"
pushd "$WS" >/dev/null

STANDARDS_FILE=""
STANDARDS_FILE_CANDIDATES="AGENTS.md,CLAUDE.md"
resolve_standards_file
check "file symlink candidate skipped" "$STANDARDS_FILE" "CLAUDE.md"

STANDARDS_FILE=""
STANDARDS_FILE_CANDIDATES="docs/*.md,docs/secret.md"
resolve_standards_file
check "directory symlink candidate skipped" "$STANDARDS_FILE" ""

STANDARDS_FILE="AGENTS.md"
STANDARDS_FILE_CANDIDATES="nope.md"
resolve_standards_file
check "symlinked standards_file refused and cleared" "$STANDARDS_FILE" ""

STANDARDS_FILE="../outside/secret.md"
STANDARDS_FILE_CANDIDATES="nope.md"
resolve_standards_file
check "relative escape refused and cleared" "$STANDARDS_FILE" ""

STANDARDS_FILE="$WS/docs/secret.md"
STANDARDS_FILE_CANDIDATES="nope.md"
resolve_standards_file
check "absolute path through a checkout symlink refused" "$STANDARDS_FILE" ""

STANDARDS_FILE="$TMPDIR/outside/secret.md"
STANDARDS_FILE_CANDIDATES="CLAUDE.md"
resolve_standards_file
check "operator absolute standards_file outside the checkout kept" "$STANDARDS_FILE" "$TMPDIR/outside/secret.md"

popd >/dev/null

# ── Results ───────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
