#!/usr/bin/env bash
# Drift guard for the mise development bootstrap (#1108): the committed
# config, the generated lock and the bootstrap script must stay in sync
# with the shipped action runtime and CI, the config must stay free of
# anything that would make mise demand `mise trust`, and the launcher
# install must stay digest-verified and privilege-free.
#
# Auto-discovered by the CI validate-bash job; no network, no downloads.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$ROOT_DIR/.mise/config.toml"
LOCK="$ROOT_DIR/.mise/mise.lock"
BOOTSTRAP="$ROOT_DIR/scripts/bootstrap.sh"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

echo "=== bootstrap files exist ==="
for f in "$CONFIG" "$LOCK" "$BOOTSTRAP"; do
  check_exists "${f#"$ROOT_DIR"/} exists" "$(test -f "$f" && echo 1 || echo 0)"
done
check "bootstrap.sh is executable" "$(test -x "$BOOTSTRAP" && echo yes || echo no)" "yes"
if bash -n "$BOOTSTRAP"; then SYNTAX_OK=yes; else SYNTAX_OK=no; fi
check "bootstrap.sh parses" "$SYNTAX_OK" "yes"

echo ""
echo "=== node pin matches the shipped runtime and CI ==="
PIN="$(sed -n 's/^[[:space:]]*node[[:space:]]*=[[:space:]]*"\([0-9.]*\)".*/\1/p' "$CONFIG" | head -n 1 || true)"
PIN_SHAPE="$(printf '%s' "$PIN" | grep -cE '^[0-9]+\.[0-9]+\.[0-9]+$' || true)"
check "config pins a full version" "$PIN_SHAPE" "1"
ACTION_MAJOR="$(sed -n 's/^[[:space:]]*using:[[:space:]]*node\([0-9]*\).*/\1/p' "$ROOT_DIR/action.yml" | head -n 1 || true)"
CI_MAJOR="$(sed -n "s/^[[:space:]]*node-version:[[:space:]]*'\([0-9]*\)'.*/\1/p" "$ROOT_DIR/.github/workflows/ci.yaml" | head -n 1 || true)"
check "pin major matches action.yml runs.using: node$ACTION_MAJOR" "${PIN%%.*}" "$ACTION_MAJOR"
check "pin major matches CI node-version '$CI_MAJOR'" "${PIN%%.*}" "$CI_MAJOR"
# Block-scoped rather than positional: a regenerated lock may reorder keys or
# carry comments without the configured version changing.
LOCK_VERSION="$(awk '/^\[\[tools\.node\]\]/{f=1;next} /^\[/{f=0} f&&/^version/{print}' "$LOCK" | head -n 1 | sed 's/^[^=]*=[[:space:]]*"\(.*\)"[[:space:]]*$/\1/' || true)"
check "mise.lock pins the same version as the config (not a stale lock)" "$LOCK_VERSION" "$PIN"

echo ""
echo "=== config stays trust-free and hook-free ==="
CONFIG_BODY="$(cat "$CONFIG")"
check_not_contains "no template interpolation" "$CONFIG_BODY" '{{'
check_not_contains "no [hooks] section" "$CONFIG_BODY" '[hooks]'
# An [env] block (or any interpolation) makes mise prompt for trust on every
# contributor's first run, silently breaking the trust-free contract.
for forbidden in '[env]' 'include' '${' '{%' 'os.'; do
  check_not_contains "no '$forbidden' (would force mise trust)" "$CONFIG_BODY" "$forbidden"
done
for task in bootstrap check test test-python; do
  check_contains "[tasks.$task] declared" "$CONFIG_BODY" "[tasks.$task]"
done
check_contains "test-python provisions its interpreter through mise" "$CONFIG_BODY" 'mise exec python@3.14 -- python3 -m pytest'

echo ""
echo "=== bootstrap script stays privilege-free (code lines only) ==="
# Comments are excluded so prose may name a forbidden thing while the code
# never can; a cosmetic "# no sudo needed" must not read as a breach.
BOOTSTRAP_CODE="$(grep -v '^[[:space:]]*#' "$BOOTSTRAP" | grep -v '^[[:space:]]*$')"
BOOTSTRAP_BODY="$(cat "$BOOTSTRAP")"
for forbidden in 'sudo' 'git config' 'mise trust' 'lefthook' 'npm test' 'npm run typecheck'; do
  check_not_contains "no '$forbidden'" "$BOOTSTRAP_CODE" "$forbidden"
done
check_contains "requires pgrep and pkill" "$BOOTSTRAP_BODY" 'pgrep pkill'
check_contains "installs with the lock" "$BOOTSTRAP_BODY" 'install --locked'

echo ""
echo "=== launcher install stays digest-verified ==="
check_contains "verifies with sha256sum or shasum" "$BOOTSTRAP_BODY" 'sha256sum'
check_contains "downloads with curl --fail" "$BOOTSTRAP_BODY" 'curl --fail'
check_contains "pins curl to https only" "$BOOTSTRAP_BODY" "--proto '=https'"
check_contains "refuses to install on digest mismatch" "$BOOTSTRAP_BODY" 'refusing to install'
for asset in linux-x64 linux-arm64 macos-arm64 macos-x64; do
  DIGEST="$(grep -E "^  $asset\) printf '" "$BOOTSTRAP" | grep -oE '[0-9a-f]{32,}' | head -n 1 || true)"
  DIGEST_SHAPE="$(printf '%s' "$DIGEST" | grep -cE '^[0-9a-f]{64}$' || true)"
  check "[$asset] pins exactly one 64-hex-char digest" "$DIGEST_SHAPE" "1"
done

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi