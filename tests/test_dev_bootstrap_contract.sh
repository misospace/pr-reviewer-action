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
echo "=== launcher staging is exclusive, not predictable ==="
# A predictable staging name (PID-derived) lets a local attacker pre-plant
# a symlink so the digest-verified copy lands on an attacker-chosen target.
# The staging path must be created by mktemp inside the install dir:
# unpredictable name, exclusive creation, same filesystem as the rename.
check_contains "staging created via mktemp inside the install dir" \
  "$BOOTSTRAP_BODY" 'staged="$(mktemp "$install_dir/.mise.bootstrap.'
check_not_contains "no PID-predictable staging name" "$BOOTSTRAP_BODY" '.mise.bootstrap.$$'
check_contains "staging asserted plain regular non-symlink before the copy" \
  "$BOOTSTRAP_BODY" '[ -L "$staged" ]'

echo ""
echo "=== every long-running phase is bounded ==="
check_contains "run_bounded helper is defined" "$BOOTSTRAP_BODY" 'run_bounded() {'
check_contains "download runs through run_bounded" \
  "$BOOTSTRAP_BODY" 'run_bounded "download" "$BOOTSTRAP_DOWNLOAD_TIMEOUT_SECS"'
check_contains "mise install --locked runs through run_bounded" \
  "$BOOTSTRAP_BODY" 'run_bounded "mise install --locked" "$BOOTSTRAP_MISE_INSTALL_TIMEOUT_SECS"'
check_contains "npm ci runs through run_bounded" \
  "$BOOTSTRAP_BODY" 'run_bounded "npm ci" "$BOOTSTRAP_NPM_CI_TIMEOUT_SECS"'
check_contains "download bound has a fixed default (300s)" \
  "$BOOTSTRAP_BODY" 'BOOTSTRAP_DOWNLOAD_TIMEOUT_SECS="${BOOTSTRAP_DOWNLOAD_TIMEOUT_SECS:-300}"'
check_contains "mise install bound has a fixed default (600s)" \
  "$BOOTSTRAP_BODY" 'BOOTSTRAP_MISE_INSTALL_TIMEOUT_SECS="${BOOTSTRAP_MISE_INSTALL_TIMEOUT_SECS:-600}"'
check_contains "npm ci bound has a fixed default (900s)" \
  "$BOOTSTRAP_BODY" 'BOOTSTRAP_NPM_CI_TIMEOUT_SECS="${BOOTSTRAP_NPM_CI_TIMEOUT_SECS:-900}"'
check_contains "curl defense-in-depth max-time bound" \
  "$BOOTSTRAP_BODY" '--max-time "$BOOTSTRAP_DOWNLOAD_TIMEOUT_SECS"'

echo ""
echo "=== bounded-phase teardown is leaf-first and unconditional ==="
# The old shape signalled parents before descendants via `pkill -P` and
# gated the KILL pass on the root still being alive; an intermediate that
# exits on TERM could then reparent a grandchild out of the traversal and
# a TERM-immune descendant could survive the root's death. The current
# shape snapshots the tree once, TERMs each captured member individually
# leaf-first, and runs the KILL pass unconditionally over the captured
# members (re-collecting from the root only to append members that
# appeared after the first snapshot).
check_not_contains "no parent-first pkill TERM pass" "$BOOTSTRAP_CODE" 'pkill -TERM -P'
check_not_contains "no parent-first pkill KILL pass" "$BOOTSTRAP_CODE" 'pkill -KILL -P'
check_contains "TERM is sent to each captured member individually" \
  "$BOOTSTRAP_BODY" 'kill -TERM "$member"'
check_contains "KILL pass guards each member with kill -0" \
  "$BOOTSTRAP_BODY" 'kill -0 "$member"'
check_contains "KILL pass kills each surviving member individually" \
  "$BOOTSTRAP_BODY" 'kill -9 "$member"'
check_contains "tree re-collected after grace to append newly observed pids" \
  "$BOOTSTRAP_BODY" 'leaf_first="$leaf_first $(collect_process_tree "$pid")"'

echo ""
echo "=== install dir is a validated user-owned trust boundary ==="
# The staging check-then-use sequence cannot be race-safe against a writer
# who can mutate the install dir; instead the path that reaches it is
# constrained, so such a writer is out of scope and the mktemp staging
# plus regular-file re-check are defense-in-depth only. Validating only
# the final directory would not be enough: a group-writable non-sticky
# parent lets another principal rename the validated dir and swap a
# symlink into its place after the checks pass. So the whole canonical
# ancestor chain is validated -- each component an existing directory,
# neither group- nor other-writable unless sticky, AND owned by the
# invoking user or by root (permissions bound an unprivileged stranger;
# ownership is what bounds the owner, who may rename or unlink any entry).
# The final one additionally must be the invoking user's own.
check_contains "install dir ownership/permissions validated" \
  "$BOOTSTRAP_BODY" 'validate_install_dir "$install_dir"'
check_contains "validation parses ls -ldn (portable across GNU/BSD stat)" \
  "$BOOTSTRAP_BODY" 'ls -ldn'
check_contains "rejects an install dir not owned by the current user" \
  "$BOOTSTRAP_BODY" 'not owned by the current user'
check_contains "rejects a group/world-writable install dir" \
  "$BOOTSTRAP_BODY" 'writable by group or others'
check_contains "a symlinked final component is refused on the literal path" \
  "$BOOTSTRAP_BODY" '[ -L "$dir" ]'
check_contains "the path is canonicalized (pwd -P) before the chain walk" \
  "$BOOTSTRAP_BODY" 'pwd -P'
check_contains "the chain is walked root-first, not just the final dir" \
  "$BOOTSTRAP_BODY" 'parent="${path%/*}"'
check_contains "each ancestor is validated as an ancestor, the leaf as final" \
  "$BOOTSTRAP_BODY" 'validate_dir_chain "$parent" ancestor'
check_contains "the install dir itself is validated as the final component" \
  "$BOOTSTRAP_BODY" 'validate_dir_chain "$canonical" final'
# A single-component path bottoms the walk out, and the naive fix is to
# treat / as terminal. It is not: a world-writable / would let any user
# rename /home out from under a validated /home/<user>/... chain, which
# is the same swap the walk exists to stop. / is pinned here because it
# cannot be regression-tested at runtime (no test may chmod /).
check_contains "the walk reaches / instead of stopping at a single component" \
  "$BOOTSTRAP_BODY" '/*) validate_dir_chain "/" ancestor ;;'
check_contains "sticky is the only writability exemption" \
  "$BOOTSTRAP_BODY" 't | T) ;; # sticky: a writer cannot rename an entry it does not own'
check_contains "writability bits come from portable awk substr, not GNU stat" \
  "$BOOTSTRAP_BODY" 'substr($1, 6, 1) "|" substr($1, 9, 1) "|" substr($1, 10, 1)'
# The assertions above pin HOW the mode bits are parsed; these pin the
# comparisons that actually decide. Pinning only the message text let
# `if false; then` in front of the leaf-owner check turn every suite
# green while the predicate was gone.
check_contains "the writability decision is the parsed group/other-write comparison" \
  "$BOOTSTRAP_BODY" 'if [ "$group_w" = "w" ] || [ "$other_w" = "w" ]; then'
check_contains "an ancestor owned by neither the current user nor root is refused" \
  "$BOOTSTRAP_BODY" 'if [ "$role" = "ancestor" ] && [ "$owner" != "$(id -u)" ] && [ "$owner" != "0" ]; then'
check_contains "the final component must be owned by the current user" \
  "$BOOTSTRAP_BODY" 'if [ "$role" = "final" ] && [ "$owner" != "$(id -u)" ]; then'
check_contains "a component that is not an existing directory is refused" \
  "$BOOTSTRAP_BODY" 'if [ ! -d "$path" ]; then'
check_contains "the validated canonical path is published for the caller" \
  "$BOOTSTRAP_BODY" 'INSTALL_DIR_CANONICAL="$canonical"'
check_contains "the caller installs into the validated canonical path" \
  "$BOOTSTRAP_BODY" 'install_dir="$INSTALL_DIR_CANONICAL"'
# Ordering is part of the contract, not formatting: validation must run
# before the download can start, and the canonical path must be bound
# before anything stages a file in the install dir.
line_of() { grep -n -m1 -F "$1" "$BOOTSTRAP" | cut -d: -f1; }
VALIDATE_AT="$(line_of 'validate_install_dir "$install_dir"')"
DOWNLOAD_AT="$(line_of 'download "$MISE_RELEASE_URL')"
CANONICAL_AT="$(line_of 'install_dir="$INSTALL_DIR_CANONICAL"')"
STAGE_AT="$(line_of 'staged="$(mktemp "$install_dir/.mise.bootstrap.')"
check "validation runs before the download can start" \
  "$([ -n "$VALIDATE_AT" ] && [ "$VALIDATE_AT" -lt "$DOWNLOAD_AT" ] && echo yes || echo no)" "yes"
check "the canonical path is bound before the staging file is created" \
  "$([ -n "$CANONICAL_AT" ] && [ "$CANONICAL_AT" -lt "$STAGE_AT" ] && echo yes || echo no)" "yes"
check_contains "a directory at the install destination is refused, not nested into" \
  "$BOOTSTRAP_BODY" 'if [ -d "$install_dir/mise" ]; then'
check_contains "the installed launcher is verified to be a regular file" \
  "$BOOTSTRAP_BODY" 'if [ ! -f "$install_dir/mise" ]; then'
check_contains "the staged file is cleaned up on every exit path, not only on ERR" \
  "$BOOTSTRAP_BODY" "trap 'rm -f \"\$staged\"; cleanup' EXIT INT TERM"
check_not_contains "no GNU-only stat call in the install-dir validation" \
  "$BOOTSTRAP_CODE" 'stat -'
check_not_contains "staging check is not described as race-safe" \
  "$BOOTSTRAP_BODY" 'race-safe guarantee against'

echo ""
echo "=== the receipt records what was prepared and how it was invoked ==="
# A clean-environment receipt reports versions and paths; without these
# two lines it cannot say WHICH checkout state was prepared or HOW setup
# was invoked, which is exactly what a later reader needs.
check_contains "receipt prints the repository root" \
  "$BOOTSTRAP_BODY" '  repo       %s'
check_contains "receipt prints the full HEAD sha" \
  "$BOOTSTRAP_BODY" 'git -C "$REPO_ROOT" rev-parse HEAD'
check_contains "receipt prints the short sha and the branch" \
  "$BOOTSTRAP_BODY" 'rev-parse --short HEAD'
check_contains "receipt prints the branch" \
  "$BOOTSTRAP_BODY" 'rev-parse --abbrev-ref HEAD'
check_contains "missing git data degrades to unknown, never fails the run" \
  "$BOOTSTRAP_BODY" "printf 'unknown'"
check_contains "the degrade guard, not just the unknown literal, is present" \
  "$BOOTSTRAP_BODY" '[ -n "$revision" ] || revision="unknown"'
check_contains "a dirty working tree is reported as such" \
  "$BOOTSTRAP_BODY" 'git -C "$REPO_ROOT" status --porcelain'
check_contains "a dirty checkout marks the revision dirty" \
  "$BOOTSTRAP_BODY" 'revision="$revision-dirty"'
check_contains "receipt prints how setup was invoked" \
  "$BOOTSTRAP_BODY" '  setup      bash %s'
check_contains "the invocation is the script's own argv, captured at the top level" \
  "$BOOTSTRAP_BODY" 'SCRIPT_ARGS="${*:-}"'
check_contains "an invocation under the repo root prints repo-relative" \
  "$BOOTSTRAP_BODY" '${invocation#"$REPO_ROOT"/}'

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi