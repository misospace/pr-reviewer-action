#!/usr/bin/env bash
# scripts/release/smoke-tag.sh: a release build must carry a runnable node24
# bundle that accepts the drop-in inputs, checked from a clean fetch of a ref.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/release/smoke-tag.sh"
PASS=0
FAIL=0
check() { if eval "$2"; then echo "  PASS: $1"; PASS=$((PASS + 1)); else echo "  FAIL: $1"; FAIL=$((FAIL + 1)); fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false
git init -q --bare "$WORK/remote.git"
git init -q -b main "$WORK/repo"
cd "$WORK/repo"
commit() { git add -A && git -c user.name=t -c user.email=t@example.com commit -q -m "$1"; }

js_action() { printf 'name: t\nruns:\n  using: node24\n  main: dist/index.js\n' > action.yml; }

# A bundle that accepts `config` only when the three drop-in inputs are set.
good_bundle() {
  mkdir -p dist
  cat > dist/index.js <<'JS'
const need = ["INPUT_AI-BASE-URL", "INPUT_AI-API-KEY", "INPUT_AI-MODEL"];
if (process.argv[2] !== "config" || need.some((k) => !process.env[k])) process.exit(1);
JS
}

js_action; good_bundle; commit good; git tag v9.0.0
js_action; rm -rf dist; commit nodist; git tag v9.0.1
js_action; mkdir -p dist; echo 'process.exit(1)' > dist/index.js; commit broken; git tag v9.0.2
printf 'name: t\nruns:\n  using: composite\n  steps: []\n' > action.yml; good_bundle; commit composite; git tag v9.0.3
git push -q "$WORK/remote.git" --tags

check "a tag with a runnable bundle passes" "bash '$SCRIPT' '$WORK/remote.git' refs/tags/v9.0.0 >/dev/null 2>&1"
check "a tag without dist/ fails" "! bash '$SCRIPT' '$WORK/remote.git' refs/tags/v9.0.1 >/dev/null 2>&1"
check "a bundle that rejects the drop-in inputs fails" "! bash '$SCRIPT' '$WORK/remote.git' refs/tags/v9.0.2 >/dev/null 2>&1"
check "a non-node24 action fails" "! bash '$SCRIPT' '$WORK/remote.git' refs/tags/v9.0.3 >/dev/null 2>&1"
check "a missing tag fails" "! bash '$SCRIPT' '$WORK/remote.git' refs/tags/v9.9.9 >/dev/null 2>&1"
check "the missing-dist failure names the file" "{ bash '$SCRIPT' '$WORK/remote.git' refs/tags/v9.0.1 2>&1 || true; } | grep -q 'build does not carry dist/index.js'"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
