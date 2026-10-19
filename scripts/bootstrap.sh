#!/usr/bin/env bash
# Reproducible, noninteractive development bootstrap (#1108).
#
# Usage:
#   scripts/bootstrap.sh          # the single command for a clean checkout:
#                                 # ensure a pinned, digest-verified mise
#                                 # launcher, then run the `bootstrap` task,
#                                 # which re-enters this script in `setup` mode
#   scripts/bootstrap.sh setup    # inside a mise environment only (normally
#                                 # reached via `mise run bootstrap`): install
#                                 # the locked toolchain, verify prerequisites,
#                                 # then `npm ci`
#
# Both modes are idempotent and convergent: a re-run re-validates the
# prerequisites and re-runs `npm ci`, so it is safe to repeat but not free.
# Neither mode runs tests, formatters or generators, neither mutates global
# configuration or git hooks, and neither needs secrets.
#
# Every long-running phase (launcher download, `mise install --locked`,
# `npm ci`) is bounded in wall time; an overrun terminates the phase's
# whole process tree and fails the bootstrap with the phase's output tail,
# so a stalled network or a hung child cannot hang setup indefinitely.
# Optional env:
#   MISE_INSTALL_DIR - user-scoped install dir for the pinned launcher
#                      (default: $HOME/.local/bin). Never a privileged
#                      install, never a global mise-settings write.
#   BOOTSTRAP_MISE   - launcher to use in `setup` mode; exported by the
#                      default mode so the task runs the digest-verified one.
#   BOOTSTRAP_DOWNLOAD_TIMEOUT_SECS     - wall-time bound for the launcher
#                                         download (default: 300)
#   BOOTSTRAP_MISE_INSTALL_TIMEOUT_SECS - wall-time bound for
#                                         `mise install --locked` (default: 600)
#   BOOTSTRAP_NPM_CI_TIMEOUT_SECS       - wall-time bound for `npm ci`
#                                         (default: 900)
set -euo pipefail

MISE_VERSION="2026.10.13"
MISE_ASSET_PREFIX="mise-v${MISE_VERSION}"
MISE_RELEASE_URL="https://github.com/jdx/mise/releases/download/v${MISE_VERSION}"

BOOTSTRAP_DOWNLOAD_TIMEOUT_SECS="${BOOTSTRAP_DOWNLOAD_TIMEOUT_SECS:-300}"
BOOTSTRAP_MISE_INSTALL_TIMEOUT_SECS="${BOOTSTRAP_MISE_INSTALL_TIMEOUT_SECS:-600}"
BOOTSTRAP_NPM_CI_TIMEOUT_SECS="${BOOTSTRAP_NPM_CI_TIMEOUT_SECS:-900}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MISE_CONFIG="$REPO_ROOT/.mise/config.toml"

CLEANUP_DIR=""
RUN_BOUNDED_NOTE=""

log() { printf '%s\n' "$*"; }

note() { printf '==> note: %s\n' "$*"; }

fail() {
  printf 'bootstrap: %s\n' "$*" >&2
  exit 1
}

# True when the exact directory is already on PATH. Compared as a literal
# `:PATH:` member so empty entries and globs cannot produce a false match.
dir_on_path() {
  case ":${PATH}:" in
  *":${1%/}:"*) return 0 ;;
  esac
  return 1
}

cleanup() {
  if [ -n "$CLEANUP_DIR" ] && [ -d "$CLEANUP_DIR" ]; then
    rm -rf "$CLEANUP_DIR"
  fi
}

abspath() {
  case "$1" in
  /*) printf '%s\n' "$1" ;;
  *) printf '%s/%s\n' "$PWD" "$1" ;;
  esac
}

sha256_of() {
  local out
  if command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum "$1")" || return 1
  elif command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 "$1")" || return 1
  else
    return 1
  fi
  printf '%s\n' "${out%% *}"
}

# Platform asset name for the pinned launcher; empty and non-zero when the
# platform has no pinned digest (the caller then tells the user what to do).
# musl is deliberately NOT routed to the glibc assets: a musl host would
# digest-verify a glibc-linked binary and then fail at exec. Pinning musl
# launcher digests is a deliberate future change (it needs published
# musl checksums, not a guess).
mise_asset() {
  case "$(uname -s)/$(uname -m)" in
  Linux/x86_64 | Linux/amd64)
    if [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; then
      return 1
    fi
    printf 'linux-x64\n'
    ;;
  Linux/aarch64 | Linux/arm64)
    if [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; then
      return 1
    fi
    printf 'linux-arm64\n'
    ;;
  Darwin/arm64 | Darwin/aarch64) printf 'macos-arm64\n' ;;
  Darwin/x86_64 | Darwin/amd64) printf 'macos-x64\n' ;;
  *) return 1 ;;
  esac
}

# Digests verified against mise v${MISE_VERSION}'s official SHASUMS256.txt.
mise_digest() {
  case "$1" in
  linux-x64) printf '94c45523c7b6760b7da704f16051171ca32e8447a849a02266a439a4455e9a12\n' ;;
  linux-arm64) printf '983fabf36625566f216400b907b33b4daca99adb5bc3d3cdab123b5e791575b2\n' ;;
  macos-arm64) printf '92fd6898dc213808d1c81f0bead9668dbea036e5946c94c0e82554603205a3aa\n' ;;
  macos-x64) printf '4e4a996f4747eb59d55497fdd4b0d60d3add9a06c0dc5d65a70402015ee445d0\n' ;;
  *) return 1 ;;
  esac
}

# Walk pgrep -P from a root pid breadth-first and print the whole tree
# (root plus every descendant), one pid per line. Deliberately avoids
# bash 4 features (associative arrays, mapfile): macOS still ships bash
# 3.2, and this script must run there. A pid has exactly one parent, so
# no de-duplication is needed. Relies on pgrep from procps -- the same
# tools require_process_tools enforces in setup mode.
collect_process_tree() {
  local root="$1" pid child frontier next kids
  printf '%s\n' "$root"
  frontier="$root"
  while [ -n "$frontier" ]; do
    next=""
    for pid in $frontier; do
      kids="$(pgrep -P "$pid" 2>/dev/null || true)"
      for child in $kids; do
        next="$next $child"
        printf '%s\n' "$child"
      done
    done
    frontier="${next# }"
  done
}

# Run a phase under a wall-time bound: `run_bounded LABEL SECONDS LOGFILE
# -- cmd args...` runs cmd with stdout+stderr redirected to LOGFILE, polls
# at 1s granularity, and on overrun terminates the whole process tree
# (TERM, brief grace, then KILL) before failing with a message naming the
# phase, the exceeded bound and the tail of LOGFILE. Relies on pgrep/pkill
# from procps for the tree teardown -- the same tools require_process_tools
# enforces in setup mode. A non-zero exit is also a controlled failure with
# the output tail. RUN_BOUNDED_NOTE, when set, is appended to the failure
# message (used for the mise.lock drift hint).
run_bounded() {
  local label="$1" limit="$2" logfile="$3"
  shift 3
  if [ "${1:-}" = "--" ]; then
    shift
  fi
  local pid deadline rc=0 member tree tail
  : >"$logfile"
  "$@" >"$logfile" 2>&1 &
  pid=$!
  deadline=$((SECONDS + limit))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      tree="$(collect_process_tree "$pid")"
      for member in $tree; do
        pkill -TERM -P "$member" 2>/dev/null || true
      done
      kill -TERM "$pid" 2>/dev/null || true
      sleep 1
      if kill -0 "$pid" 2>/dev/null; then
        tree="$(collect_process_tree "$pid")"
        for member in $tree; do
          pkill -KILL -P "$member" 2>/dev/null || true
        done
        kill -9 "$pid" 2>/dev/null || true
      fi
      tail="$(tail -n 20 "$logfile" 2>/dev/null || true)"
      rm -f "$logfile"
      fail "phase '$label' exceeded its ${limit}s wall-time bound and was terminated; last output:
$tail${RUN_BOUNDED_NOTE:+

$RUN_BOUNDED_NOTE}"
    fi
    sleep 1
  done
  wait "$pid" || rc=$?
  if [ "$rc" -ne 0 ]; then
    tail="$(tail -n 20 "$logfile" 2>/dev/null || true)"
    rm -f "$logfile"
    fail "phase '$label' failed with exit status $rc; last output:
$tail${RUN_BOUNDED_NOTE:+

$RUN_BOUNDED_NOTE}"
  fi
}

download() {
  # The bounded log lives under CLEANUP_DIR, which run_default creates
  # immediately before calling this function.
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    run_bounded "download" "$BOOTSTRAP_DOWNLOAD_TIMEOUT_SECS" "$CLEANUP_DIR/download.log" -- \
      curl --fail --silent --show-error --location --proto '=https' \
        --connect-timeout 30 --max-time "$BOOTSTRAP_DOWNLOAD_TIMEOUT_SECS" --output "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    run_bounded "download" "$BOOTSTRAP_DOWNLOAD_TIMEOUT_SECS" "$CLEANUP_DIR/download.log" -- \
      wget --quiet --timeout="$BOOTSTRAP_DOWNLOAD_TIMEOUT_SECS" --tries=3 --output-document="$dest" "$url"
  elif command -v node >/dev/null 2>&1; then
    run_bounded "download" "$BOOTSTRAP_DOWNLOAD_TIMEOUT_SECS" "$CLEANUP_DIR/download.log" -- \
      node -e '
        const fs = require("fs");
        const [url, dest, timeoutSecs] = process.argv.slice(1);
        (async () => {
          const res = await fetch(url, {
            redirect: "follow",
            signal: AbortSignal.timeout(Number(timeoutSecs) * 1000),
          });
          if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
          fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
        })().catch((err) => { console.error(err.message); process.exit(1); });
      ' "$url" "$dest" "$BOOTSTRAP_DOWNLOAD_TIMEOUT_SECS"
  else
    fail "no downloader available: curl, wget and node were all absent. Install one of them, or install mise v${MISE_VERSION} yourself (https://mise.jdx.dev/getting-started.html) and run: mise run bootstrap"
  fi
}

configured_node_version() {
  local line
  line="$(grep -E '^[[:space:]]*node[[:space:]]*=' "$MISE_CONFIG" | head -n1 | cut -d= -f2- | sed 's/#.*//' | tr -d '"'\''[:space:]')" || true
  printf '%s\n' "$line"
}

verify_node_pin() {
  local expected actual
  expected="$(configured_node_version)"
  [ -n "$expected" ] || fail "no node pin found in $MISE_CONFIG"
  actual="$(node --version)"
  if [ "$actual" != "v$expected" ]; then
    fail "active node is $actual but $MISE_CONFIG pins v$expected. Run this through mise (scripts/bootstrap.sh) so the pinned toolchain is on PATH"
  fi
}

require_process_tools() {
  local tool
  for tool in pgrep pkill; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      fail "'$tool' is not on PATH. Process-tree cleanup (src/runtime/process-tree.ts) and gate preflight (src/gates/gates.ts) require procps and refuse to run without it -- install procps (Debian/Ubuntu: apt-get install procps, macOS: brew install procps) and re-run"
    fi
  done
}

print_receipt() {
  local start="$1" npm_cache launcher_dir
  launcher_dir="$(dirname "$MISE_BIN")"
  npm_cache="$(npm config get cache 2>/dev/null || printf 'unknown')"
  printf '\n'
  printf 'Setup complete in %ss. Nothing was tested, formatted or generated.\n' "$((SECONDS - start))"
  printf '\n'
  printf '  mise       %s (%s)\n' "$("$MISE_BIN" --version)" "$MISE_BIN"
  printf '  node       %s (%s)\n' "$(node --version)" "$(command -v node)"
  printf '  npm        %s (%s)\n' "$(npm --version)" "$(command -v npm)"
  printf '  pgrep      %s\n' "$(command -v pgrep)"
  printf '  pkill      %s\n' "$(command -v pkill)"
  printf '  modules    %s\n' "$REPO_ROOT/node_modules"
  printf '  npm cache  %s\n' "$npm_cache"
  printf '\n'
  if ! dir_on_path "$launcher_dir"; then
    printf '%s is not on PATH, so a bare mise will not resolve. Run:\n' "$launcher_dir"
    printf '  export PATH="%s:$PATH"\n' "$launcher_dir"
    printf 'and add the same line to your shell rc to keep it in later shells.\n'
    printf '\n'
  fi
  printf 'Reuse this environment with:\n'
  printf '  %s exec -- <command>   run any command with the pinned toolchain\n' "$MISE_BIN"
  printf '  %s run check           fast static validation (typecheck)\n' "$MISE_BIN"
  printf '  %s run test            authoritative Node suite (build + node --test)\n' "$MISE_BIN"
}

run_default() {
  local asset digest install_dir path_mise staged actual resolved launcher_dir

  cd "$REPO_ROOT" || fail "cannot enter the repository root at $REPO_ROOT"

  # Verify-then-install only: nothing else can run without a digest tool.
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    fail "neither sha256sum nor shasum is available, so the pinned mise launcher cannot be verified. Install coreutils, or install mise v${MISE_VERSION} yourself and run: mise run bootstrap"
  fi

  if ! asset="$(mise_asset)"; then
    fail "no pinned mise launcher for $(uname -s)/$(uname -m). Install mise v${MISE_VERSION} yourself (https://mise.jdx.dev/getting-started.html) and run: mise run bootstrap"
  fi
  digest="$(mise_digest "$asset")"

  if [ -n "${MISE_INSTALL_DIR:-}" ]; then
    install_dir="$(abspath "$MISE_INSTALL_DIR")"
  elif [ -n "${HOME:-}" ]; then
    install_dir="$(abspath "$HOME/.local/bin")"
  else
    fail "neither MISE_INSTALL_DIR nor HOME is set, so there is nowhere user-scoped to install the mise launcher"
  fi

  MISE_BIN=""
  if path_mise="$(command -v mise 2>/dev/null)"; then
    if [ "$(sha256_of "$path_mise" 2>/dev/null || true)" = "$digest" ]; then
      MISE_BIN="$(abspath "$path_mise")"
      log "==> mise v${MISE_VERSION} already at ${MISE_BIN} (digest verified)"
    else
      log "==> mise on PATH (${path_mise}) is not the pinned v${MISE_VERSION} build; installing the pinned launcher"
    fi
  fi

  if [ -z "$MISE_BIN" ]; then
    if [ -f "$install_dir/mise" ] && [ "$(sha256_of "$install_dir/mise" 2>/dev/null || true)" = "$digest" ]; then
      MISE_BIN="$install_dir/mise"
      log "==> pinned mise launcher already at ${MISE_BIN} (digest verified)"
    else
      CLEANUP_DIR="$(mktemp -d)"
      log "==> downloading mise v${MISE_VERSION} (${asset}) to ${install_dir}"
      download "$MISE_RELEASE_URL/${MISE_ASSET_PREFIX}-${asset}" "$CLEANUP_DIR/mise"
      actual="$(sha256_of "$CLEANUP_DIR/mise")" || fail "could not hash the downloaded mise launcher"
      if [ "$actual" != "$digest" ]; then
        fail "digest mismatch for the downloaded mise launcher (expected $digest, got $actual) -- refusing to install"
      fi
      mkdir -p "$install_dir"
      # mktemp creates the staging name exclusively (O_EXCL) with an
      # unpredictable suffix inside the install dir, so a pre-planted
      # symlink at a guessable name is never followed and the later rename
      # stays on one filesystem.
      staged="$(mktemp "$install_dir/.mise.bootstrap.XXXXXX")"
      trap 'rm -f "$staged"; cleanup' ERR INT TERM
      # The digest check protects the download source, not the staging
      # destination: assert the staged path is still a plain regular file
      # (never a symlink) before any bytes are written to it.
      if [ ! -f "$staged" ] || [ -L "$staged" ]; then
        fail "staging path $staged is not a plain regular file; refusing to install"
      fi
      cp "$CLEANUP_DIR/mise" "$staged"
      chmod 755 "$staged"
      mv -f "$staged" "$install_dir/mise"
      trap cleanup EXIT INT TERM
      MISE_BIN="$install_dir/mise"
      log "==> installed pinned mise launcher at ${MISE_BIN} (digest verified)"
    fi
  fi

  launcher_dir="$(dirname "$MISE_BIN")"
  resolved="$(command -v mise 2>/dev/null || true)"
  if [ "$(abspath "$resolved")" != "$MISE_BIN" ]; then
    note "$launcher_dir is not on PATH, so a bare 'mise' will not resolve in this shell. Run: export PATH=\"$launcher_dir:\$PATH\" -- and put that same line in your shell rc to keep it in later shells. Bootstrap completed; only the PATH convenience is missing."
  fi
  if [ -n "$resolved" ] && [ "$(abspath "$resolved")" != "$MISE_BIN" ]; then
    note "the mise at $resolved still resolves first. Put $launcher_dir ahead of it (export PATH=\"$launcher_dir:\$PATH\") or remove that older binary: a mise older than this config's min_version may not understand the lockfile and can silently ignore the committed .mise/mise.lock."
  fi

  cleanup
  CLEANUP_DIR=""
  trap - EXIT INT TERM

  export BOOTSTRAP_MISE="$MISE_BIN"
  exec "$MISE_BIN" run bootstrap
}

run_setup() {
  local start mise_log npm_log
  start=$SECONDS
  cd "$REPO_ROOT" || fail "cannot enter the repository root at $REPO_ROOT"

  # Cheapest prerequisite first: a host without procps should not pay for a
  # toolchain download before learning the test suites cannot run here.
  require_process_tools

  if ! command -v "$MISE_BIN" >/dev/null 2>&1; then
    fail "mise launcher not found at $MISE_BIN. Run 'mise run bootstrap' through the pinned launcher, or run scripts/bootstrap.sh from the repository root"
  fi

  log "==> installing the locked toolchain (.mise/mise.lock)"
  mise_log="$(mktemp)"
  RUN_BOUNDED_NOTE="If .mise/config.toml and the committed .mise/mise.lock disagree, run 'mise lock' and commit the regenerated .mise/mise.lock"
  run_bounded "mise install --locked" "$BOOTSTRAP_MISE_INSTALL_TIMEOUT_SECS" "$mise_log" -- \
    "$MISE_BIN" install --locked
  RUN_BOUNDED_NOTE=""
  if [ -s "$mise_log" ]; then
    cat "$mise_log"
  fi
  rm -f "$mise_log"

  verify_node_pin

  log "==> installing npm dependencies (npm ci)"
  npm_log="$(mktemp)"
  run_bounded "npm ci" "$BOOTSTRAP_NPM_CI_TIMEOUT_SECS" "$npm_log" -- npm ci
  cat "$npm_log"
  rm -f "$npm_log"

  print_receipt "$start"
}

MISE_BIN="${BOOTSTRAP_MISE:-mise}"

case "${1:-}" in
setup)
  trap cleanup EXIT INT TERM
  run_setup
  ;;
'')
  trap cleanup EXIT INT TERM
  run_default
  ;;
*)
  fail "usage: scripts/bootstrap.sh [setup]"
  ;;
esac