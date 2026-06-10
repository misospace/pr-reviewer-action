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

# Source just the resolve_standards_file function
resolve_standards_file() {
  if [[ -n "$STANDARDS_FILE" && -f "$STANDARDS_FILE" ]]; then
    return
  fi

  local candidate matches m
  IFS=',' read -ra candidates <<< "$STANDARDS_FILE_CANDIDATES"
  shopt -s nullglob
  for candidate in "${candidates[@]}"; do
    candidate="$(printf '%s' "$candidate" | xargs)"
    [[ -n "$candidate" ]] || continue
    matches=( $candidate )
    for m in "${matches[@]}"; do
      if [[ -f "$m" ]]; then
        STANDARDS_FILE="$m"
        shopt -u nullglob
        return
      fi
    done
  done
  shopt -u nullglob
}

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

# ── Results ───────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
