#!/usr/bin/env bash
# scripts/release/tag-with-dist.sh: commits a prebuilt dist/ on a detached child
# of the release commit and force-points the version (and major) tag at it,
# leaving the base branch source-only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/release/tag-with-dist.sh"
PASS=0
FAIL=0
check() { if eval "$2"; then echo "  PASS: $1"; PASS=$((PASS + 1)); else echo "  FAIL: $1"; FAIL=$((FAIL + 1)); fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false
git init -q --bare "$WORK/remote.git"
git init -q -b main "$WORK/repo"
cd "$WORK/repo"
git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m base
printf 'dist/\n' > .gitignore
git add .gitignore
git -c user.name=t -c user.email=t@example.com commit -q -m ignore-dist
git remote add origin "$WORK/remote.git"
git push -q origin main
BASE="$(git rev-parse HEAD)"

echo "=== Test: missing dist fails without touching tags ==="
check "exits non-zero" '! "$SCRIPT" "$BASE" v1.2.3 v1 >/dev/null 2>&1'
check "no tag created" '[ -z "$(git ls-remote --tags origin v1.2.3)" ]'

echo "=== Test: tags point at a dist commit whose parent is the release commit ==="
mkdir -p dist
echo 'console.log("bundle")' > dist/index.js
SHA="$("$SCRIPT" "$BASE" v1.2.3 v1 2>/dev/null)"
check "version tag moved to build commit" '[ "$(git ls-remote origin refs/tags/v1.2.3 | cut -f1)" = "$SHA" ]'
check "major tag moved to build commit" '[ "$(git ls-remote origin refs/tags/v1 | cut -f1)" = "$SHA" ]'
check "build commit parent is the release commit" '[ "$(git rev-parse "$SHA^")" = "$BASE" ]'
check "build commit carries dist/index.js" 'git cat-file -e "$SHA:dist/index.js"'
check "main stays source-only" '! git cat-file -e "$(git ls-remote origin refs/heads/main | cut -f1):dist/index.js" 2>/dev/null'

echo "=== Test: empty major tag leaves it alone (pre-release) ==="
PRE="$("$SCRIPT" "$BASE" v1.3.0-rc.1 "" 2>/dev/null)"
check "pre-release tag created" '[ "$(git ls-remote origin refs/tags/v1.3.0-rc.1 | cut -f1)" = "$PRE" ]'
check "major tag unchanged" '[ "$(git ls-remote origin refs/tags/v1 | cut -f1)" = "$SHA" ]'

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
