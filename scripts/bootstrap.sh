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
# Published by validate_install_dir: the canonical path that was actually
# validated. Everything that touches the install dir after that point
# uses this, never the caller's literal, so the object that was
# inspected is the object that is written to.
INSTALL_DIR_CANONICAL=""

# The script's own argv, captured before any function can rebind $*/$@,
# so the receipt can report how setup was actually invoked. `${*:-}`
# rather than a bare `$*`: although POSIX exempts $@/$* from `set -u`,
# the default costs nothing and removes any reliance on that exemption
# under the bash 3.2 that macOS still ships.
SCRIPT_ARGS="${*:-}"

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
# (leaf-first TERM of every captured member, brief grace, then an
# unconditional KILL pass) before failing with a message naming the
# phase, the exceeded bound and the tail of LOGFILE. Relies on pgrep
# from procps for the tree snapshot -- the same tools
# require_process_tools enforces in setup mode. A non-zero exit is also
# a controlled failure with the output tail. RUN_BOUNDED_NOTE, when set,
# is appended to the failure message (used for the mise.lock drift hint).
run_bounded() {
  local label="$1" limit="$2" logfile="$3"
  shift 3
  if [ "${1:-}" = "--" ]; then
    shift
  fi
  local pid deadline rc=0 member tree leaf_first tail
  : >"$logfile"
  "$@" >"$logfile" 2>&1 &
  pid=$!
  deadline=$((SECONDS + limit))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      # Snapshot the tree once at TERM time. collect_process_tree lists
      # root-first, so reverse it and signal leaf-first: children die
      # before their parents, shrinking the window in which a
      # TERM-surviving intermediate could reparent a grandchild out of
      # the captured set. The root is signalled last, not first.
      tree="$(collect_process_tree "$pid")"
      leaf_first=""
      for member in $tree; do
        leaf_first="$member${leaf_first:+ $leaf_first}"
      done
      for member in $leaf_first; do
        kill -TERM "$member" 2>/dev/null || true
      done
      sleep 1
      # The KILL pass is unconditional: a descendant that ignored TERM
      # can outlive the root, so membership in the captured set -- not
      # the root's survival -- decides who is killed. If the root is
      # still alive after the grace period, re-collect its tree so
      # members that appeared after the first snapshot are covered too
      # (duplicates are harmless: the kill -0 guard makes a repeated
      # signal a no-op). Residual window: if the root dies on TERM, a
      # member spawned after the snapshot escapes this sweep -- closing
      # that fully needs a process-group kill, out of scope here.
      if kill -0 "$pid" 2>/dev/null; then
        leaf_first="$leaf_first $(collect_process_tree "$pid")"
      fi
      for member in $leaf_first; do
        kill -0 "$member" 2>/dev/null || continue
        kill -9 "$member" 2>/dev/null || true
      done
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

# The receipt states what was set up and where. Versions and paths say
# what is installed; the repo, revision and setup lines say WHICH
# checkout state was prepared and HOW setup was invoked -- the two facts
# a clean-environment receipt otherwise cannot recover. All three are
# read from live state and degrade to `unknown` instead of failing the
# run: no git, or a REPO_ROOT that is not a checkout, is not an error
# here -- the setup it reports already succeeded.
print_receipt() {
  local start="$1" npm_cache launcher_dir
  local revision="unknown" revision_short="unknown" branch="unknown" invocation
  launcher_dir="$(dirname "$MISE_BIN")"
  npm_cache="$(npm config get cache 2>/dev/null || printf 'unknown')"
  if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    revision="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')"
    revision_short="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
    branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')"
    # The toolchain and node_modules were built from the working tree,
    # not from the commit, so a bare sha would misreport a dirty checkout
    # (including an in-progress change to this script).
    if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
      revision="$revision-dirty"
    fi
  fi
  [ -n "$revision" ] || revision="unknown"
  [ -n "$revision_short" ] || revision_short="unknown"
  [ -n "$branch" ] || branch="unknown"
  # $0 plus the script's own argv, both captured before any function
  # could rebind them: a checkout-relative path when $0 sits under
  # REPO_ROOT (the documented `scripts/bootstrap.sh` invocation), the
  # absolute path otherwise. `bash` is the interpreter this script
  # requires, so the printed line stays a runnable command.
  invocation="$0"
  case "$invocation" in
  "$REPO_ROOT"/*) invocation="${invocation#"$REPO_ROOT"/}" ;;
  esac
  [ -z "$SCRIPT_ARGS" ] || invocation="$invocation $SCRIPT_ARGS"
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
  printf '  repo       %s\n' "$REPO_ROOT"
  printf '  revision   %s (%s, %s)\n' "$revision" "$revision_short" "$branch"
  printf '  setup      bash %s\n' "$invocation"
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

# The install dir is the trust boundary for the staged launcher, and the
# boundary is the whole chain that reaches it, not just the leaf: a
# group-writable non-sticky *parent* lets another principal rename the
# validated dir and swap a symlink into its place after the checks pass,
# so mktemp/cp/mv would resolve a different object than the one
# validated. So every component from / down to the install dir is
# validated, with two properties:
#
#   - each is an existing directory, is neither group- nor
#     other-writable -- unless it carries the sticky bit (sticky forbids
#     renaming an entry a writer does not own, which is what makes /tmp
#     safe) -- AND is owned by the current uid or by root. Both halves
#     are load-bearing: permissions govern what an *unprivileged*
#     stranger may do inside a directory, but the owner governs
#     everything that owner may do, including renaming or unlinking an
#     entry, so a 0755 directory owned by another user is not a trust
#     boundary however well its mode reads. Root-owned components (/,
#     /home, /usr, /tmp) and your own ($HOME) both pass. Writable
#     components are rejected regardless of owner, so a shared
#     /usr/local/lib fails closed rather than being waved through
#     because root owns it.
#   - the final component must be owned by the current uid: that is the
#     directory the launcher is installed into.
#
# POSIX ACL entries are invisible to a mode-bit check, so a component
# whose ACL grants another user write access passes this validation; no
# setfacl/getfacl dependency is added for that, and it is a documented
# residual rather than an oversight. Out of scope: root can rewrite any
# of this by design, and the post-snapshot process-tree residual in
# run_bounded is an unrelated concern (see its own comment). Parsed from
# `ls -ldn` because stat flags differ between GNU and BSD/macOS; field 1
# is the mode string and field 3 the numeric owner uid.
validate_install_dir() {
  local dir="$1" canonical
  # The literal path the caller asked for: a symlinked final component
  # is refused even when its target would itself validate.
  if [ -L "$dir" ]; then
    fail "install dir $dir is a symlink; refusing to install through it"
  fi
  if [ ! -d "$dir" ]; then
    fail "install dir $dir does not exist or is not a directory; refusing to install into it"
  fi
  # Canonicalize before walking the chain, so symlinked *ancestors*
  # (macOS /tmp -> /private/tmp, /var -> /private/var) and any . or ..
  # are resolved rather than rejected, and the components actually
  # inspected are the components actually used. A cd we cannot make
  # means the path cannot be proven at all, so refuse.
  canonical="$(cd "$dir" 2>/dev/null && pwd -P)" ||
    fail "cannot resolve install dir $dir to a canonical path; refusing to install into it"
  [ -n "$canonical" ] ||
    fail "cannot resolve install dir $dir to a canonical path; refusing to install into it"
  validate_dir_chain "$canonical" final
  # Publish the validated object, so the caller installs into the exact
  # path that was inspected. Re-using the literal instead would mean
  # validating one path and writing through another whenever an ancestor
  # was a symlink.
  INSTALL_DIR_CANONICAL="$canonical"
}

# Validate a canonical path root-first: every ancestor, then the path
# itself. Walks up by string-stripping the last component, so it needs
# no arrays, mapfile or other bash 4 feature -- macOS still ships bash
# 3.2 and this script has to run there.
validate_dir_chain() { # validate_dir_chain PATH ROLE   (ROLE: final | ancestor)
  local path="$1" role="$2" parent
  if [ "$path" != "/" ]; then
    case "$path" in
    /*/?*)
      parent="${path%/*}"
      [ -n "$parent" ] || parent="/"
      validate_dir_chain "$parent" ancestor
      ;;
    # A single-component path's parent is /, and / is validated too: a
    # world-writable / would let any user rename /home out from under a
    # validated /home/courier/... chain, so skipping it would leave the
    # very swap this walk exists to stop. Recursing on / is terminal
    # because the `[ "$path" != "/" ]` guard above stops there.
    /*) validate_dir_chain "/" ancestor ;;
    *) fail "install dir $path is not an absolute path; refusing to install into it" ;;
    esac
  fi
  validate_dir_component "$path" "$role"
}

validate_dir_component() { # validate_dir_component PATH ROLE
  local path="$1" role="$2"
  local line mode owner bits group_w other_w sticky
  if [ ! -d "$path" ]; then
    fail "install dir path component $path is not an existing directory; refusing to install into it"
  fi
  line="$(ls -ldn "$path" 2>/dev/null)" ||
    fail "cannot inspect install dir path component $path to validate its ownership and permissions"
  mode="$(printf '%s\n' "$line" | awk '{print $1}')"
  owner="$(printf '%s\n' "$line" | awk '{print $3}')"
  # The mode field is a type char, nine permission chars and then the
  # special char that setuid/setgid/sticky replace on the matching
  # execute position -- so awk's 1-based positions 6, 9 and 10 are
  # group-write, other-write and sticky. No GNU-only stat needed.
  bits="$(printf '%s\n' "$mode" | awk '{print substr($1, 6, 1) "|" substr($1, 9, 1) "|" substr($1, 10, 1)}')"
  group_w="${bits%%|*}"
  bits="${bits#*|}"
  other_w="${bits%%|*}"
  sticky="${bits#*|}"
  if [ "$role" = "ancestor" ] && [ "$owner" != "$(id -u)" ] && [ "$owner" != "0" ]; then
    fail "install dir path component $path is owned by uid $owner, neither the current user nor root; that user can rename or unlink anything inside it. Point MISE_INSTALL_DIR under a directory you own, or one root owns (/, /home, /tmp, ...)"
  fi
  if [ "$role" = "final" ] && [ "$owner" != "$(id -u)" ]; then
    fail "install dir $path is not owned by the current user (owner uid $owner, current uid $(id -u)); refusing to install into a directory another user controls"
  fi
  if [ "$group_w" = "w" ] || [ "$other_w" = "w" ]; then
    case "$sticky" in
    t | T) ;; # sticky: a writer cannot rename an entry it does not own
    *)
      fail "install dir path component $path is writable by group or others (mode $mode) without the sticky bit, so another user could rename it and swap a validated path for a symlink. Point MISE_INSTALL_DIR at a private directory you own, under ancestors that are not group/other-writable"
      ;;
    esac
  fi
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
    # One validation path, and it always runs before the downloader --
    # previously an install dir that did not exist yet was only validated
    # AFTER the download had already run. mkdir -p runs first because
    # there is nothing to canonicalize or validate before the path
    # exists; creating empty directories is benign because nothing is
    # written into them until validation has passed.
    mkdir -p "$install_dir"
    validate_install_dir "$install_dir"
    # From here on every touch of the install dir uses the canonical path
    # that was just validated, not the caller's literal: with a symlinked
    # ancestor those are different paths into the same object, and the
    # literal is the one a symlink swap can move.
    install_dir="$INSTALL_DIR_CANONICAL"
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
      # mktemp creates the staging name exclusively (O_EXCL) with an
      # unpredictable suffix inside the validated install dir, so a
      # pre-planted symlink at a guessable name is never followed and
      # the later rename stays on one filesystem.
      staged="$(mktemp "$install_dir/.mise.bootstrap.XXXXXX")"
      # EXIT, not just ERR: every refusal below leaves through `fail`,
      # which exits normally, and the staged file has to be cleaned up on
      # that path too -- not only when a command fails.
      trap 'rm -f "$staged"; cleanup' EXIT INT TERM
      # The validated chain is the trust boundary: only the invoking user
      # (or root) can write into the install dir or rename it through a
      # writable ancestor. The digest check protects the download source,
      # not the staging destination, and the regular-file re-check below
      # is defense-in-depth hardening, NOT a race-safe guarantee -- a
      # writer able to mutate the directory could still swap the staged
      # path between this check and the copy; such a writer is out of
      # scope by the validation above, not defeated by this check.
      if [ ! -f "$staged" ] || [ -L "$staged" ]; then
        fail "staging path $staged is not a plain regular file; refusing to install"
      fi
      # The destination has to be a file slot. `mv -f` into a directory
      # NESTS the launcher inside it (mise/.mise.bootstrap.XXXX), which
      # still exits 0 here and only fails later at exec time -- so refuse
      # before staging anything. The check runs while the staged-cleanup
      # trap is installed, so nothing is left behind.
      if [ -d "$install_dir/mise" ]; then
        fail "install destination $install_dir/mise is a directory; refusing to install into it (mv would nest the launcher inside instead of replacing it)"
      fi
      cp "$CLEANUP_DIR/mise" "$staged"
      chmod 755 "$staged"
      mv -f "$staged" "$install_dir/mise"
      # Belt and braces against the nesting case above: whatever the
      # rename did, the path we are about to exec must be a plain file.
      if [ ! -f "$install_dir/mise" ]; then
        fail "installed launcher at $install_dir/mise is not a regular file; refusing to exec it"
      fi
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