#!/usr/bin/env bash
# scripts/release/converge.sh: a partially published release is detected as
# incomplete and repaired idempotently, piece by piece.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/release/converge.sh"
PASS=0
FAIL=0
check() { if eval "$2"; then echo "  PASS: $1"; PASS=$((PASS + 1)); else echo "  FAIL: $1"; FAIL=$((FAIL + 1)); fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false
export GITHUB_REPOSITORY=o/r
FAKE="$WORK/fake"
mkdir -p "$FAKE/bin"

# Fake gh: Release and label state live in files; every write is logged.
cat > "$FAKE/bin/gh" <<'GH'
#!/usr/bin/env bash
state="$FAKE_STATE"
case "$1 $2" in
  "api repos/o/r/commits/"*) cat "$state/pr" 2>/dev/null || true ;;
  "api repos/o/r/issues/"*) cat "$state/labels" 2>/dev/null || true ;;
  "release view") [ -f "$state/release" ] ;;
  "release create") echo "release create $3" >> "$state/log"; touch "$state/release" ;;
  "pr edit") echo "pr edit $3" >> "$state/log"; printf 'autorelease: tagged\n' > "$state/labels" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
GH
chmod +x "$FAKE/bin/gh"
export PATH="$FAKE/bin:$PATH" FAKE_STATE="$FAKE"

git init -q --bare "$WORK/remote.git"
git init -q -b main "$WORK/repo"
cd "$WORK/repo"
printf '# Changelog\n\n## [3.0.0](x) (2026-09-29)\n\n* the notes\n\n## [2.5.0](x) (2026-09-20)\n\n* old\n' > CHANGELOG.md
git add -A && git -c user.name=t -c user.email=t@example.com commit -q -m base
git remote add origin "$WORK/remote.git"
BASE="$(git rev-parse HEAD)"
git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m "build: dist"
BUILD="$(git rev-parse HEAD)"
git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m "older build"
OLD="$(git rev-parse HEAD)"

reset_state() { rm -f "$FAKE/release" "$FAKE/log" "$FAKE/labels" "$FAKE/pr"; git push -q origin --delete v3.0.0 v3 2>/dev/null || true; }
state() { bash "$SCRIPT" state v3.0.0 "$BASE" | grep "^$1=" | cut -d= -f2; }

echo "=== nothing published: build needed ==="
reset_state
check "incomplete" '[ "$(state complete)" = false ]'
check "needs the build" '[ "$(state needs_build)" = true ]'
check "finish refuses without the version tag" '! bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1'

echo "=== version tag exists, floating tag stale, Release missing, PR pending ==="
reset_state
git push -q origin "$BUILD:refs/tags/v3.0.0" "$OLD:refs/tags/v3"
echo 42 > "$FAKE/pr"; printf 'autorelease: pending\n' > "$FAKE/labels"
check "still incomplete (tag existence is not completion)" '[ "$(state complete)" = false ]'
check "no rebuild needed" '[ "$(state needs_build)" = false ]'
check "major tag reported stale" '[ "$(state major_ok)" = false ]'
bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1
check "floating tag moved to the version tag's commit" '[ "$(git ls-remote origin refs/tags/v3 | cut -f1)" = "$BUILD" ]'
check "Release created" 'grep -qx "release create v3.0.0" "$FAKE/log"'
check "release PR marked tagged" 'grep -qx "pr edit 42" "$FAKE/log"'
check "now complete" '[ "$(state complete)" = true ]'

echo "=== version tag + floating tag exist, GitHub Release missing ==="
reset_state
git push -q origin "$BUILD:refs/tags/v3.0.0" "$BUILD:refs/tags/v3"
echo 42 > "$FAKE/pr"; printf 'autorelease: tagged\n' > "$FAKE/labels"
check "incomplete while the Release is missing" '[ "$(state complete)" = false ]'
bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1
check "creates only the Release" '[ "$(cat "$FAKE/log")" = "release create v3.0.0" ]'
check "complete afterwards" '[ "$(state complete)" = true ]'

echo "=== Release exists but the release PR is still pending ==="
reset_state
git push -q origin "$BUILD:refs/tags/v3.0.0" "$BUILD:refs/tags/v3"
touch "$FAKE/release"; echo 42 > "$FAKE/pr"; printf 'autorelease: pending\n' > "$FAKE/labels"
check "incomplete while the PR is pending" '[ "$(state complete)" = false ]'
bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1
check "only relabels the PR" '[ "$(cat "$FAKE/log")" = "pr edit 42" ]'
check "complete afterwards" '[ "$(state complete)" = true ]'

echo "=== fully published: finish is a no-op ==="
rm -f "$FAKE/log"
bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1
check "no writes" '[ ! -s "$FAKE/log" ]'

echo "=== pre-release: the floating tag is never required ==="
reset_state
git push -q origin "$BUILD:refs/tags/v3.1.0-rc.1"
touch "$FAKE/release"
check "complete without a floating tag" '[ "$(bash "$SCRIPT" state v3.1.0-rc.1 "$BASE" | grep ^complete= | cut -d= -f2)" = true ]'

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
