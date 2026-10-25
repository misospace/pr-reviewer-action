#!/usr/bin/env bash
# Runtime tests for the mise development bootstrap (#1108), fully offline:
# every network-facing or slow tool is a stub on a fake PATH, so nothing
# here downloads, installs or talks to a registry.
#
# Covered here (the static side lives in test_dev_bootstrap_contract.sh):
#   - the launcher staging path is created unpredictably and never follows
#     a pre-planted symlink in the install dir
#   - the download, `mise install --locked` and `npm ci` phases are bounded
#     in wall time: an overrun fails the bootstrap with a controlled
#     message naming the phase and the bound, and no stub process survives
#   - teardown signals the captured tree leaf-first and kills a TERM-immune
#     grandchild even when its parent and the phase root die on TERM
#   - a group/world-writable install dir fails closed before any download
#     or launcher install proceeds
#   - a sticky world-writable FINAL install dir fails closed (the sticky
#     exemption is for ancestors only), and a symlink at the install
#     destination is refused before the launcher is staged
#   - a symlink planted at the install destination DURING the download --
#     i.e. after the destination pre-check and before the move -- is
#     refused too, and nothing is written through it
#   - with pgrep missing, the default mode fails closed with the
#     prerequisite error before the downloader ever starts
#   - with no usable dirname on PATH (its own directory must come from
#     ${BASH_SOURCE[0]}, #1274), setup still roots itself correctly and
#     completes: the receipt records the real checkout and the stubbed
#     dirname is never invoked
#
# Auto-discovered by the CI validate-bash job. Target runtime: seconds.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BOOTSTRAP="$ROOT_DIR/scripts/bootstrap.sh"
CONFIG="$ROOT_DIR/.mise/config.toml"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

TMPROOT="${TMPDIR:-/tmp}"

# The pinned digest the stub sha256sum reports; parsed out of the script
# under test so the fixture cannot drift from the pinned value.
PINNED_DIGEST="$(grep -E 'linux-x64\) printf' "$BOOTSTRAP" | grep -oE '[0-9a-f]{64}' | head -n 1)"
NODE_PIN="$(sed -n 's/^[[:space:]]*node[[:space:]]*=[[:space:]]*"\([0-9.]*\)".*/\1/p' "$CONFIG" | head -n 1)"

SANDBOX=""
BIN=""
INSTALL_DIR=""
BOOTSTRAP_PID=""
BOOTSTRAP_RC=""

cleanup_sandboxes() {
  if [ -n "$SANDBOX" ] && [ -d "$SANDBOX" ]; then
    rm -rf "$SANDBOX"
  fi
}
trap cleanup_sandboxes EXIT

new_sandbox() {
  SANDBOX="$(mktemp -d "$TMPROOT/bootstrap-runtime.XXXXXX")"
  BIN="$SANDBOX/bin"
  INSTALL_DIR="$SANDBOX/install"
  mkdir -p "$BIN" "$INSTALL_DIR" "$SANDBOX/home"
}

write_stub() { # write_stub NAME <<heredoc body>>
  local name="$1"
  cat >"$BIN/$name"
  chmod 755 "$BIN/$name"
}

# Run the bootstrap script with the sandbox env in the background and poll
# for exit up to a real-time cap, so a regression that hangs setup fails
# the test on the cap instead of hanging the suite.
run_bootstrap_bg() { # run_bootstrap_bg OUTFILE MODE ENV_ASSIGNMENTS...
  local outfile="$1" mode="$2"
  shift 2
  # "${BASH:-bash}", not a bare `bash`: a test that restricts the child
  # PATH (the missing-pgrep case below) would otherwise leave `env` with
  # no way to resolve the interpreter itself.
  if [ -n "$mode" ]; then
    env "$@" "${BASH:-bash}" "$BOOTSTRAP" "$mode" >"$outfile" 2>&1 &
  else
    env "$@" "${BASH:-bash}" "$BOOTSTRAP" >"$outfile" 2>&1 &
  fi
  BOOTSTRAP_PID=$!
}

wait_exited_or_deadline() { # wait_exited_or_deadline CAP_SECONDS
  local cap="$1"
  local deadline=$((SECONDS + cap))
  BOOTSTRAP_RC=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! kill -0 "$BOOTSTRAP_PID" 2>/dev/null; then
      BOOTSTRAP_RC=0
      wait "$BOOTSTRAP_PID" || BOOTSTRAP_RC=$?
      return 0
    fi
    sleep 1
  done
  return 1
}

reap_bootstrap() {
  if [ -n "$BOOTSTRAP_PID" ]; then
    kill -9 "$BOOTSTRAP_PID" 2>/dev/null || true
    wait "$BOOTSTRAP_PID" 2>/dev/null || true
    BOOTSTRAP_PID=""
  fi
}

assert_no_survivors() { # assert_no_survivors PGREP_PATTERN
  local pattern="$1" survivors="" i
  for i in 1 2 3 4 5; do
    survivors="$(pgrep -f "$pattern" 2>/dev/null || true)"
    if [ -z "$survivors" ]; then
      break
    fi
    sleep 1
  done
  check "no process matching '$pattern' survives the teardown" "${survivors:-}" ""
}

# The bootstrap reads each component's owner uid from `ls -ldn`, and a
# non-root test run cannot chown a directory over to a second uid. This
# stub reports a foreign uid for exactly one path and delegates every
# other invocation to the real ls, which reproduces "owned by another
# user" identically on every machine. The mode it reports is 0755 on
# purpose: nothing but ownership can decide these cases.
write_foreign_owner_ls() { # write_foreign_owner_ls PATH UID
  local target="$1" uid="$2" real_ls
  real_ls="$(command -v ls)"
  cat >"$BIN/ls" <<EOF
#!/usr/bin/env bash
# The bootstrap calls \`ls -ldn PATH\`: exactly two arguments.
if [ "\$#" -eq 2 ] && [ "\$1" = "-ldn" ] && [ "\$2" = "$target" ]; then
  printf 'drwxr-xr-x 2 $uid 0 4096 Jan  1 00:00 %s\n' "\$2"
  exit 0
fi
exec "$real_ls" "\$@"
EOF
  chmod 755 "$BIN/ls"
}

# Precondition, checked once up front. Every sandbox below is created
# beneath TMPROOT, and the bootstrap validates the WHOLE ancestor chain
# of the install dir -- so if TMPROOT itself would fail that policy,
# every test below fails with a confusing per-test message instead of
# one clear explanation. Same three rules the bootstrap applies: a
# component is owned by the current user or by root, and is not
# group/other-writable unless sticky.
tmp_root_chain_is_usable() {
  local chain line mode owner bits
  chain="$(cd "$TMPROOT" 2>/dev/null && pwd -P)" || return 1
  while :; do
    line="$(ls -ldn "$chain" 2>/dev/null)" || return 1
    mode="$(printf '%s\n' "$line" | awk '{print $1}')"
    owner="$(printf '%s\n' "$line" | awk '{print $3}')"
    if [ "$owner" != "$(id -u)" ] && [ "$owner" != "0" ]; then
      return 1
    fi
    bits="$(printf '%s\n' "$mode" | awk '{print substr($1, 6, 1) substr($1, 9, 1) substr($1, 10, 1)}')"
    if [ "${bits:0:1}" = "w" ] || [ "${bits:1:1}" = "w" ]; then
      case "${bits:2:1}" in
      t | T) ;;
      *) return 1 ;;
      esac
    fi
    if [ "$chain" = "/" ]; then
      break
    fi
    chain="${chain%/*}"
    # A single-component path's parent is / -- the same edge the bootstrap
    # walks, and the same reason / has to be checked: a writable / could
    # rename /tmp out from under a validated chain.
    [ -n "$chain" ] || chain="/"
  done
  return 0
}

if ! tmp_root_chain_is_usable; then
  {
    echo "bootstrap-runtime: this environment cannot host the sandbox."
    echo "  TMPROOT is ${TMPROOT} (from TMPDIR=${TMPDIR:-<unset>}) and every sandbox is"
    echo "  created beneath it, so the bootstrap validates TMPROOT's whole ancestor"
    echo "  chain as part of the install dir. Some component there is owned by neither"
    echo "  the current user nor root, or is writable by group/others without sticky."
    echo "  Re-run with a TMPDIR the bootstrap itself would accept -- CI leaves TMPDIR"
    echo "  unset, so /tmp (mode 1777, sticky, root-owned) is used:"
    echo "    env -u TMPDIR bash tests/test_bootstrap_runtime.sh"
  } >&2
  exit 1
fi

echo "=== bootstrap runtime: staging is symlink-safe (default mode) ==="
new_sandbox
SENTINEL="$SANDBOX/sentinel"
printf 'sentinel-content\n' >"$SENTINEL"
ln -s "$SENTINEL" "$INSTALL_DIR/.mise.bootstrap.decoy"
# The "downloaded launcher" is a shell script that logs its invocation, so
# the exec'd `mise run bootstrap` re-entry proves the staged bytes run.
cat >"$SANDBOX/fake-mise" <<EOF
#!/usr/bin/env bash
printf '%s\n' "fake-mise \$*" >> "$SANDBOX/mise-calls.log"
exit 0
EOF
chmod 755 "$SANDBOX/fake-mise"
write_stub sha256sum <<EOF
#!/usr/bin/env bash
printf '%s\n' '$PINNED_DIGEST'
EOF
write_stub curl <<EOF
#!/usr/bin/env bash
prev=""
for arg in "\$@"; do
  if [ "\$prev" = "--output" ]; then
    cp "$SANDBOX/fake-mise" "\$arg"
  fi
  prev="\$arg"
done
EOF
default_out="$SANDBOX/default.out"
run_bootstrap_bg "$default_out" "" \
  "MISE_INSTALL_DIR=$INSTALL_DIR" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
reap_needed=0
if wait_exited_or_deadline 20; then
  check "default mode exits 0 with a fake succeeding mise" "$BOOTSTRAP_RC" "0"
else
  reap_needed=1
  check "default mode exits 0 with a fake succeeding mise" "timed-out" "0"
fi
reap_bootstrap
launcher_state="$(test -x "$INSTALL_DIR/mise" && printf yes || printf no)"
check "install dir holds an executable mise launcher" "$launcher_state" "yes"
if [ "$reap_needed" -eq 0 ] && [ -x "$INSTALL_DIR/mise" ]; then
  "$INSTALL_DIR/mise" selfcheck
  check "exec'd launcher is the fake staged binary" "$(cat "$SANDBOX/mise-calls.log" 2>/dev/null || true)" "fake-mise run bootstrap
fake-mise selfcheck"
else
  check "exec'd launcher is the fake staged binary" "not-run" "fake-mise run bootstrap
fake-mise selfcheck"
fi
decoy_state="$(test -L "$INSTALL_DIR/.mise.bootstrap.decoy" && printf yes || printf no)"
check "pre-planted decoy symlink still exists unmodified" "$decoy_state" "yes"
check "sentinel behind the decoy symlink is untouched" "$(cat "$SENTINEL")" "sentinel-content"
entries="$(cd "$INSTALL_DIR" && find . -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | tr '\n' ',')"
check "no file beyond the launcher and decoy was created in the install dir" \
  "$entries" ".mise.bootstrap.decoy,mise,"

echo ""
echo "=== bootstrap runtime: mise install --locked is bounded ==="
new_sandbox
write_stub mise <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "install" ] && [ "$2" = "--locked" ]; then
  sleep 30
fi
exit 0
EOF
write_stub node <<EOF
#!/usr/bin/env bash
if [ "\$1" = "--version" ]; then
  printf 'v%s\n' '$NODE_PIN'
fi
exit 0
EOF
write_stub npm <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
mise_stall_out="$SANDBOX/mise-stall.out"
run_bootstrap_bg "$mise_stall_out" setup \
  "BOOTSTRAP_MISE=$BIN/mise" \
  "BOOTSTRAP_MISE_INSTALL_TIMEOUT_SECS=2" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 25; then
  check_ne "bootstrap exits non-zero when mise install overruns" "$BOOTSTRAP_RC" "0"
else
  check_ne "bootstrap exits non-zero when mise install overruns" "timed-out" "0"
fi
reap_bootstrap
mise_stall_body="$(cat "$mise_stall_out")"
check_contains "failure names the mise install phase" "$mise_stall_body" "phase 'mise install --locked'"
check_contains "failure names the exceeded bound" "$mise_stall_body" "exceeded its 2s wall-time bound"
assert_no_survivors "$BIN/mise"

echo ""
echo "=== bootstrap runtime: npm ci is bounded ==="
new_sandbox
write_stub mise <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "install" ] && [ "$2" = "--locked" ]; then
  printf 'mise: locked toolchain ready\n'
fi
exit 0
EOF
write_stub node <<EOF
#!/usr/bin/env bash
if [ "\$1" = "--version" ]; then
  printf 'v%s\n' '$NODE_PIN'
fi
exit 0
EOF
write_stub npm <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "ci" ]; then
  sleep 30
fi
exit 0
EOF
npm_stall_out="$SANDBOX/npm-stall.out"
run_bootstrap_bg "$npm_stall_out" setup \
  "BOOTSTRAP_MISE=$BIN/mise" \
  "BOOTSTRAP_NPM_CI_TIMEOUT_SECS=2" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 25; then
  check_ne "bootstrap exits non-zero when npm ci overruns" "$BOOTSTRAP_RC" "0"
else
  check_ne "bootstrap exits non-zero when npm ci overruns" "timed-out" "0"
fi
reap_bootstrap
npm_stall_body="$(cat "$npm_stall_out")"
check_contains "failure names the npm ci phase" "$npm_stall_body" "phase 'npm ci'"
check_contains "failure names the exceeded bound" "$npm_stall_body" "exceeded its 2s wall-time bound"
assert_no_survivors "$BIN/npm"

echo ""
echo "=== bootstrap runtime: launcher download is bounded ==="
new_sandbox
write_stub sha256sum <<EOF
#!/usr/bin/env bash
printf '%s\n' '$PINNED_DIGEST'
EOF
# Deliberately ignores --max-time: the wall-time bound must catch a
# downloader that does not honor its own per-tool timeout.
write_stub curl <<'EOF'
#!/usr/bin/env bash
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output" ]; then
    printf 'partial' > "$arg"
  fi
  prev="$arg"
done
sleep 30
EOF
download_stall_out="$SANDBOX/download-stall.out"
run_bootstrap_bg "$download_stall_out" "" \
  "MISE_INSTALL_DIR=$INSTALL_DIR" \
  "BOOTSTRAP_DOWNLOAD_TIMEOUT_SECS=2" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 25; then
  check_ne "bootstrap exits non-zero when the download overruns" "$BOOTSTRAP_RC" "0"
else
  check_ne "bootstrap exits non-zero when the download overruns" "timed-out" "0"
fi
reap_bootstrap
download_stall_body="$(cat "$download_stall_out")"
check_contains "failure names the download phase" "$download_stall_body" "phase 'download'"
check_contains "failure names the exceeded bound" "$download_stall_body" "exceeded its 2s wall-time bound"
assert_no_survivors "$BIN/curl"

echo ""
echo "=== bootstrap runtime: bounded phases still pass through output on success ==="
new_sandbox
write_stub mise <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "install" ] && [ "$2" = "--locked" ]; then
  printf 'mise: locked toolchain ready\n'
fi
exit 0
EOF
write_stub node <<EOF
#!/usr/bin/env bash
if [ "\$1" = "--version" ]; then
  printf 'v%s\n' '$NODE_PIN'
fi
exit 0
EOF
write_stub npm <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "ci" ]; then
  printf 'added 128 packages in 1s\n'
fi
exit 0
EOF
setup_ok_out="$SANDBOX/setup-ok.out"
run_bootstrap_bg "$setup_ok_out" setup \
  "BOOTSTRAP_MISE=$BIN/mise" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 20; then
  check "setup mode exits 0 with succeeding stubs" "$BOOTSTRAP_RC" "0"
else
  check "setup mode exits 0 with succeeding stubs" "timed-out" "0"
fi
reap_bootstrap
setup_ok_body="$(cat "$setup_ok_out")"
check_contains "mise install output is shown on success" "$setup_ok_body" "mise: locked toolchain ready"
check_contains "npm ci output is shown on success" "$setup_ok_body" "added 128 packages in 1s"
check_contains "setup prints its receipt" "$setup_ok_body" "Setup complete in"
check_contains "the receipt records the checkout it prepared" "$setup_ok_body" "  repo       $ROOT_DIR"
check_contains "the receipt records the setup command it ran" "$setup_ok_body" \
  "  setup      bash scripts/bootstrap.sh setup"

echo ""
echo "=== bootstrap runtime: teardown kills a TERM-immune grandchild whose parent dies on TERM ==="
new_sandbox
cat >"$SANDBOX/bootstrap-nested-grandchild" <<'EOF'
#!/usr/bin/env bash
trap '' TERM
while :; do
  sleep 1
done
EOF
chmod 755 "$SANDBOX/bootstrap-nested-grandchild"
cat >"$SANDBOX/bootstrap-nested-intermediate" <<EOF
#!/usr/bin/env bash
"$SANDBOX/bootstrap-nested-grandchild" &
wait
EOF
chmod 755 "$SANDBOX/bootstrap-nested-intermediate"
write_stub mise <<EOF
#!/usr/bin/env bash
if [ "\$1" = "install" ] && [ "\$2" = "--locked" ]; then
  bash "$SANDBOX/bootstrap-nested-intermediate"
fi
exit 0
EOF
nested_out="$SANDBOX/nested.out"
run_bootstrap_bg "$nested_out" setup \
  "BOOTSTRAP_MISE=$BIN/mise" \
  "BOOTSTRAP_MISE_INSTALL_TIMEOUT_SECS=2" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 25; then
  check_ne "bootstrap exits non-zero when mise install overruns" "$BOOTSTRAP_RC" "0"
else
  check_ne "bootstrap exits non-zero when mise install overruns" "timed-out" "0"
fi
reap_bootstrap
nested_body="$(cat "$nested_out")"
check_contains "failure names mise install phase" "$nested_body" "phase 'mise install --locked'"
check_contains "failure names exceeded bound" "$nested_body" "exceeded its 2s wall-time bound"
assert_no_survivors "$SANDBOX/bootstrap-nested-grandchild"
assert_no_survivors "$SANDBOX/bootstrap-nested-intermediate"

echo ""
echo "=== bootstrap runtime: group/world-writable install dir fails closed ==="
new_sandbox
OPEN_DIR="$SANDBOX/open-install"
mkdir -p "$OPEN_DIR"
chmod 777 "$OPEN_DIR"
write_stub sha256sum <<EOF
#!/usr/bin/env bash
printf '%s\n' '$PINNED_DIGEST'
EOF
write_stub curl <<EOF
#!/usr/bin/env bash
printf downloaded > "$SANDBOX/curl-ran"
exit 0
EOF
# Deliberately no mise stub: with the digest stub always reporting the
# pinned digest, a mise on PATH would short-circuit the install branch
# and the install dir would never be validated at all. The remaining
# negative blocks below follow the same rule.
insecure_out="$SANDBOX/insecure.out"
run_bootstrap_bg "$insecure_out" "" \
  "MISE_INSTALL_DIR=$OPEN_DIR" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 20; then
  check_ne "bootstrap exits non-zero on an insecure install dir" "$BOOTSTRAP_RC" "0"
else
  check_ne "bootstrap exits non-zero on an insecure install dir" "timed-out" "0"
fi
reap_bootstrap
insecure_body="$(cat "$insecure_out")"
check_contains "failure names the insecure install dir" "$insecure_body" "$OPEN_DIR"
check_contains "failure cites the violated trust property" "$insecure_body" "writable by group or others"
check "no launcher was installed into the insecure dir" \
  "$(test -e "$OPEN_DIR/mise" && printf yes || printf no)" "no"
check "the downloader never ran" \
  "$(test -e "$SANDBOX/curl-ran" && printf yes || printf no)" "no"

echo ""
echo "=== bootstrap runtime: world-writable-only install dir (707) fails closed ==="
new_sandbox
WW_DIR="$SANDBOX/world-only-install"
mkdir -p "$WW_DIR"
chmod 707 "$WW_DIR"
write_stub sha256sum <<EOF
#!/usr/bin/env bash
printf '%s\n' '$PINNED_DIGEST'
EOF
write_stub curl <<EOF
#!/usr/bin/env bash
printf downloaded > "$SANDBOX/curl-ran-707"
exit 0
EOF
ww_out="$SANDBOX/world-only.out"
run_bootstrap_bg "$ww_out" "" \
  "MISE_INSTALL_DIR=$WW_DIR" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 20; then
  check_ne "bootstrap exits non-zero on a world-writable-only install dir" "$BOOTSTRAP_RC" "0"
else
  check_ne "bootstrap exits non-zero on a world-writable-only install dir" "timed-out" "0"
fi
reap_bootstrap
ww_body="$(cat "$ww_out")"
check_contains "failure cites the violated trust property (707)" "$ww_body" "writable by group or others"
check "no launcher was installed into the 707 dir" \
  "$(test -e "$WW_DIR/mise" && printf yes || printf no)" "no"
check "the downloader never ran (707)" \
  "$(test -e "$SANDBOX/curl-ran-707" && printf yes || printf no)" "no"

echo ""
echo "=== bootstrap runtime: symlinked install dir fails closed ==="
new_sandbox
REAL_DIR="$SANDBOX/real-install"
mkdir -p "$REAL_DIR"
LINK_DIR="$SANDBOX/link-install"
ln -s "$REAL_DIR" "$LINK_DIR"
write_stub sha256sum <<EOF
#!/usr/bin/env bash
printf '%s\n' '$PINNED_DIGEST'
EOF
write_stub curl <<EOF
#!/usr/bin/env bash
printf downloaded > "$SANDBOX/curl-ran-link"
exit 0
EOF
link_out="$SANDBOX/link.out"
run_bootstrap_bg "$link_out" "" \
  "MISE_INSTALL_DIR=$LINK_DIR" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 20; then
  check_ne "bootstrap exits non-zero on a symlinked install dir" "$BOOTSTRAP_RC" "0"
else
  check_ne "bootstrap exits non-zero on a symlinked install dir" "timed-out" "0"
fi
reap_bootstrap
link_body="$(cat "$link_out")"
check_contains "failure names the symlinked install dir" "$link_body" "is a symlink"
check "no launcher was installed through the symlink" \
  "$(test -e "$REAL_DIR/mise" && printf yes || printf no)" "no"
check "the downloader never ran (symlink)" \
  "$(test -e "$SANDBOX/curl-ran-link" && printf yes || printf no)" "no"

echo ""
echo "=== bootstrap runtime: group-writable non-sticky ANCESTOR of the install dir fails closed ==="
new_sandbox
ANCESTOR="$SANDBOX/shared-parent"
mkdir -p "$ANCESTOR/install"
# The install dir itself is unimpeachable: current-user-owned, 755. The
# parent is the hole -- group-writable without sticky, so another
# principal can rename the validated dir and swap a symlink in its
# place after validation has passed. Validating only the leaf would
# miss this entirely.
chmod 755 "$ANCESTOR/install"
chmod 775 "$ANCESTOR"
write_stub sha256sum <<EOF
#!/usr/bin/env bash
printf '%s\n' '$PINNED_DIGEST'
EOF
write_stub curl <<EOF
#!/usr/bin/env bash
printf downloaded > "$SANDBOX/curl-ran-ancestor"
exit 0
EOF
ancestor_out="$SANDBOX/ancestor.out"
run_bootstrap_bg "$ancestor_out" "" \
  "MISE_INSTALL_DIR=$ANCESTOR/install" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 20; then
  check_ne "bootstrap exits non-zero when an ancestor is group-writable" "$BOOTSTRAP_RC" "0"
else
  check_ne "bootstrap exits non-zero when an ancestor is group-writable" "timed-out" "0"
fi
reap_bootstrap
ancestor_body="$(cat "$ancestor_out")"
# The trailing space pins the assertion to the PARENT path: a failure that
# named only the install dir would still contain the parent as a prefix.
check_contains "failure names the offending ancestor, not the install dir" "$ancestor_body" "component $ANCESTOR "
check_contains "failure cites the violated trust property (ancestor)" "$ancestor_body" "writable by group or others"
check "no launcher was installed under the group-writable ancestor" \
  "$(test -e "$ANCESTOR/install/mise" && printf yes || printf no)" "no"
check "the downloader never ran (group-writable ancestor)" \
  "$(test -e "$SANDBOX/curl-ran-ancestor" && printf yes || printf no)" "no"

echo ""
echo "=== bootstrap runtime: a sticky ancestor is accepted, not blanket-rejected ==="
new_sandbox
STICKY_PARENT="$SANDBOX/sticky-parent"
mkdir -p "$STICKY_PARENT/install"
# 1777 on the parent is the /tmp shape: writable by everyone, but sticky,
# so a writer still cannot rename an entry it does not own. The install
# dir beneath it is ordinary (755, current-user-owned), so the whole
# download-and-stage path must run to completion.
chmod 755 "$STICKY_PARENT/install"
chmod 1777 "$STICKY_PARENT"
cat >"$SANDBOX/sticky-fake-mise" <<EOF
#!/usr/bin/env bash
printf '%s\n' "fake-mise \$*" >> "$SANDBOX/sticky-mise-calls.log"
exit 0
EOF
chmod 755 "$SANDBOX/sticky-fake-mise"
write_stub sha256sum <<EOF
#!/usr/bin/env bash
printf '%s\n' '$PINNED_DIGEST'
EOF
write_stub curl <<EOF
#!/usr/bin/env bash
prev=""
for arg in "\$@"; do
  if [ "\$prev" = "--output" ]; then
    cp "$SANDBOX/sticky-fake-mise" "\$arg"
  fi
  prev="\$arg"
done
EOF
sticky_out="$SANDBOX/sticky-ancestor.out"
run_bootstrap_bg "$sticky_out" "" \
  "MISE_INSTALL_DIR=$STICKY_PARENT/install" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 20; then
  check "bootstrap exits 0 with a sticky ancestor" "$BOOTSTRAP_RC" "0"
else
  check "bootstrap exits 0 with a sticky ancestor" "timed-out" "0"
fi
reap_bootstrap
check "install dir holds an executable mise launcher under a sticky ancestor" \
  "$(test -x "$STICKY_PARENT/install/mise" && printf yes || printf no)" "yes"
check "the staged launcher really ran under a sticky ancestor" \
  "$(cat "$SANDBOX/sticky-mise-calls.log" 2>/dev/null || true)" "fake-mise run bootstrap"

echo ""
echo "=== bootstrap runtime: a symlinked ancestor with a safe canonical chain is accepted ==="
new_sandbox
LINK_PARENT="$SANDBOX/link-parent"
REAL_PARENT="$SANDBOX/real-parent"
mkdir -p "$REAL_PARENT/install"
chmod 755 "$REAL_PARENT/install"
ln -s "$REAL_PARENT" "$LINK_PARENT"
# Only the FINAL component must not be a symlink; ancestors are resolved
# through `pwd -P` and then validated at their canonical location (this
# is the macOS /tmp -> /private/tmp shape). Every canonical component
# here is a private 755/700 dir, so the run must succeed and the
# launcher must land in the real directory.
cat >"$SANDBOX/linked-fake-mise" <<EOF
#!/usr/bin/env bash
printf '%s\n' "fake-mise \$*" >> "$SANDBOX/linked-mise-calls.log"
exit 0
EOF
chmod 755 "$SANDBOX/linked-fake-mise"
write_stub sha256sum <<EOF
#!/usr/bin/env bash
printf '%s\n' '$PINNED_DIGEST'
EOF
write_stub curl <<EOF
#!/usr/bin/env bash
prev=""
for arg in "\$@"; do
  if [ "\$prev" = "--output" ]; then
    cp "$SANDBOX/linked-fake-mise" "\$arg"
  fi
  prev="\$arg"
done
EOF
linked_out="$SANDBOX/symlinked-ancestor.out"
run_bootstrap_bg "$linked_out" "" \
  "MISE_INSTALL_DIR=$LINK_PARENT/install" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 20; then
  check "bootstrap exits 0 with a symlinked ancestor over a safe chain" "$BOOTSTRAP_RC" "0"
else
  check "bootstrap exits 0 with a symlinked ancestor over a safe chain" "timed-out" "0"
fi
reap_bootstrap
check "the launcher is installed at the canonical target, not rejected" \
  "$(test -x "$REAL_PARENT/install/mise" && printf yes || printf no)" "yes"
check "the staged launcher really ran through the symlinked ancestor" \
  "$(cat "$SANDBOX/linked-mise-calls.log" 2>/dev/null || true)" "fake-mise run bootstrap"

echo ""
echo "=== bootstrap runtime: an ANCESTOR owned by another uid fails closed even at 0755 ==="
new_sandbox
ATTACKER_PARENT="$SANDBOX/attacker-parent"
mkdir -p "$ATTACKER_PARENT/install"
# 0755 on both: no group/other write bit anywhere, so the mode rules
# pass and ownership is the only thing left that can refuse. The
# ancestor's owner may rename or unlink anything inside it, which is the
# swap this validation exists to prevent -- a leaf-only check waved this
# through and installed.
chmod 755 "$ATTACKER_PARENT/install"
chmod 755 "$ATTACKER_PARENT"
write_stub sha256sum <<EOF
#!/usr/bin/env bash
printf '%s\n' '$PINNED_DIGEST'
EOF
write_stub curl <<EOF
#!/usr/bin/env bash
printf downloaded > "$SANDBOX/curl-ran-foreign-ancestor"
exit 0
EOF
write_foreign_owner_ls "$ATTACKER_PARENT" 12345
foreign_ancestor_out="$SANDBOX/foreign-ancestor.out"
run_bootstrap_bg "$foreign_ancestor_out" "" \
  "MISE_INSTALL_DIR=$ATTACKER_PARENT/install" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 20; then
  check_ne "bootstrap exits non-zero on an ancestor owned by another uid" "$BOOTSTRAP_RC" "0"
else
  check_ne "bootstrap exits non-zero on an ancestor owned by another uid" "timed-out" "0"
fi
reap_bootstrap
foreign_ancestor_body="$(cat "$foreign_ancestor_out")"
check_contains "failure names the foreign-owned ancestor" "$foreign_ancestor_body" "component $ATTACKER_PARENT "
check_contains "failure names the offending uid" "$foreign_ancestor_body" "12345"
check "no launcher was installed under a foreign-owned ancestor" \
  "$(test -e "$ATTACKER_PARENT/install/mise" && printf yes || printf no)" "no"
check "the downloader never ran (foreign-owned ancestor)" \
  "$(test -e "$SANDBOX/curl-ran-foreign-ancestor" && printf yes || printf no)" "no"

echo ""
echo "=== bootstrap runtime: an install dir owned by another uid fails closed ==="
new_sandbox
write_stub sha256sum <<EOF
#!/usr/bin/env bash
printf '%s\n' '$PINNED_DIGEST'
EOF
write_stub curl <<EOF
#!/usr/bin/env bash
printf downloaded > "$SANDBOX/curl-ran-foreign-leaf"
exit 0
EOF
write_foreign_owner_ls "$INSTALL_DIR" 12345
foreign_leaf_out="$SANDBOX/foreign-leaf.out"
run_bootstrap_bg "$foreign_leaf_out" "" \
  "MISE_INSTALL_DIR=$INSTALL_DIR" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 20; then
  check_ne "bootstrap exits non-zero on an install dir owned by another uid" "$BOOTSTRAP_RC" "0"
else
  check_ne "bootstrap exits non-zero on an install dir owned by another uid" "timed-out" "0"
fi
reap_bootstrap
foreign_leaf_body="$(cat "$foreign_leaf_out")"
check_contains "failure cites leaf ownership (not just ancestors)" "$foreign_leaf_body" "not owned by the current user"
check_contains "failure names the leaf owner uid" "$foreign_leaf_body" "12345"
check "no launcher was installed into a foreign-owned install dir" \
  "$(test -e "$INSTALL_DIR/mise" && printf yes || printf no)" "no"
check "the downloader never ran (foreign-owned install dir)" \
  "$(test -e "$SANDBOX/curl-ran-foreign-leaf" && printf yes || printf no)" "no"

echo ""
echo "=== bootstrap runtime: a 0775 ancestor with a NOT-YET-EXISTENT leaf still fails before the downloader ==="
new_sandbox
OPEN_PARENT="$SANDBOX/open-parent"
mkdir -p "$OPEN_PARENT"
chmod 775 "$OPEN_PARENT"
# The leaf does not exist yet. That used to skip the first validation
# entirely and start the download; mkdir -p now runs first, so the whole
# chain is refused before any network call. The created leaf is left
# behind on purpose -- creating it is benign, nothing is written into it.
write_stub sha256sum <<EOF
#!/usr/bin/env bash
printf '%s\n' '$PINNED_DIGEST'
EOF
write_stub curl <<EOF
#!/usr/bin/env bash
printf downloaded > "$SANDBOX/curl-ran-open-parent"
exit 0
EOF
open_parent_out="$SANDBOX/open-parent.out"
run_bootstrap_bg "$open_parent_out" "" \
  "MISE_INSTALL_DIR=$OPEN_PARENT/install" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 20; then
  check_ne "bootstrap exits non-zero on a 0775 ancestor with a missing leaf" "$BOOTSTRAP_RC" "0"
else
  check_ne "bootstrap exits non-zero on a 0775 ancestor with a missing leaf" "timed-out" "0"
fi
reap_bootstrap
open_parent_body="$(cat "$open_parent_out")"
check_contains "failure cites the violated trust property (missing leaf)" "$open_parent_body" "writable by group or others"
check_contains "failure names the 0775 ancestor" "$open_parent_body" "component $OPEN_PARENT "
check "the downloader never ran (0775 ancestor, leaf created first)" \
  "$(test -e "$SANDBOX/curl-ran-open-parent" && printf yes || printf no)" "no"
check "the created leaf was left empty, not written into" \
  "$(cd "$OPEN_PARENT/install" && find . -mindepth 1 | wc -l | tr -d ' ')" "0"

echo ""
echo "=== bootstrap runtime: a directory at the install destination is refused, not nested into ==="
new_sandbox
# The final component must validate on its own: the sticky exemption is
# ancestors-only now, so a hostile `mise` directory needs a clean (755,
# current-user-owned) leaf to be reachable. `mv -f` into a directory
# NESTS the launcher (mise/.mise.bootstrap.XXXX) and still reports
# success, failing only later at exec with 126 -- and it used to leave
# the staged file behind as well.
chmod 755 "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/mise"
printf 'squatter\n' >"$INSTALL_DIR/mise/squatter"
cat >"$SANDBOX/squatter-fake-mise" <<EOF
#!/usr/bin/env bash
printf '%s\n' "fake-mise \$*" >> "$SANDBOX/squatter-mise-calls.log"
exit 0
EOF
chmod 755 "$SANDBOX/squatter-fake-mise"
write_stub sha256sum <<EOF
#!/usr/bin/env bash
printf '%s\n' '$PINNED_DIGEST'
EOF
write_stub curl <<EOF
#!/usr/bin/env bash
prev=""
for arg in "\$@"; do
  if [ "\$prev" = "--output" ]; then
    cp "$SANDBOX/squatter-fake-mise" "\$arg"
  fi
  prev="\$arg"
done
EOF
squatter_out="$SANDBOX/squatter.out"
run_bootstrap_bg "$squatter_out" "" \
  "MISE_INSTALL_DIR=$INSTALL_DIR" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 20; then
  check_ne "bootstrap exits non-zero when the destination is a directory" "$BOOTSTRAP_RC" "0"
else
  check_ne "bootstrap exits non-zero when the destination is a directory" "timed-out" "0"
fi
reap_bootstrap
squatter_body="$(cat "$squatter_out")"
check_contains "failure names the directory destination" "$squatter_body" "$INSTALL_DIR/mise is a directory"
check "nothing was nested into the destination directory" \
  "$(cd "$INSTALL_DIR/mise" && find . -mindepth 1 -printf '%f\n' | sort | tr '\n' ',')" "squatter,"
check "no staged file was left behind in the install dir" \
  "$(cd "$INSTALL_DIR" && find . -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | tr '\n' ',')" "mise,"
check "the squatter contents are untouched" \
  "$(cat "$INSTALL_DIR/mise/squatter")" "squatter"

echo ""
echo "=== bootstrap runtime: sticky world-writable FINAL install dir fails closed ==="
new_sandbox
# 1777 on the FINAL component: the ancestor /tmp shape must not exempt
# the install dir itself, because the launcher is created inside it.
chmod 1777 "$INSTALL_DIR"
write_stub sha256sum <<EOF
#!/usr/bin/env bash
printf '%s\n' '$PINNED_DIGEST'
EOF
write_stub curl <<EOF
#!/usr/bin/env bash
printf downloaded > "$SANDBOX/curl-ran-sticky-final"
exit 0
EOF
# Deliberately no mise stub, as in the negative blocks above.
sticky_final_out="$SANDBOX/sticky-final.out"
run_bootstrap_bg "$sticky_final_out" "" \
  "MISE_INSTALL_DIR=$INSTALL_DIR" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 20; then
  check_ne "bootstrap exits non-zero on a sticky 1777 final install dir" "$BOOTSTRAP_RC" "0"
else
  check_ne "bootstrap exits non-zero on a sticky 1777 final install dir" "timed-out" "0"
fi
reap_bootstrap
sticky_final_body="$(cat "$sticky_final_out")"
check_contains "failure cites the violated trust property (sticky final)" \
  "$sticky_final_body" "writable by group or others"
check_contains "failure names that sticky does not exempt the final dir" \
  "$sticky_final_body" "sticky bit does not exempt the final install directory"
check "no launcher installed into the sticky final dir" \
  "$(test -e "$INSTALL_DIR/mise" && printf yes || printf no)" "no"
check "the downloader never ran (sticky final)" \
  "$(test -e "$SANDBOX/curl-ran-sticky-final" && printf yes || printf no)" "no"

echo ""
echo "=== bootstrap runtime: symlinked install destination refused before staging ==="
new_sandbox
# The destination `mise` is a symlink to a directory OUTSIDE the install
# dir, planted before the run: the refusal must fire on the literal path
# while the staged-cleanup trap is active, so the sentinel is never
# written through and no staged file survives.
SENTINEL_DIR="$SANDBOX/sentinel-dir"
mkdir -p "$SENTINEL_DIR"
printf 'sentinel-content\n' >"$SENTINEL_DIR/keepme"
ln -s "$SENTINEL_DIR" "$INSTALL_DIR/mise"
cat >"$SANDBOX/symlink-fake-mise" <<EOF
#!/usr/bin/env bash
printf '%s\n' "fake-mise \$*" >> "$SANDBOX/symlink-mise-calls.log"
exit 0
EOF
chmod 755 "$SANDBOX/symlink-fake-mise"
write_stub sha256sum <<EOF
#!/usr/bin/env bash
printf '%s\n' '$PINNED_DIGEST'
EOF
write_stub curl <<EOF
#!/usr/bin/env bash
prev=""
for arg in "\$@"; do
  if [ "\$prev" = "--output" ]; then
    cp "$SANDBOX/symlink-fake-mise" "\$arg"
  fi
  prev="\$arg"
done
EOF
symlink_dest_out="$SANDBOX/symlink-dest.out"
run_bootstrap_bg "$symlink_dest_out" "" \
  "MISE_INSTALL_DIR=$INSTALL_DIR" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 20; then
  check_ne "bootstrap exits non-zero when the destination is a symlink" "$BOOTSTRAP_RC" "0"
else
  check_ne "bootstrap exits non-zero when the destination is a symlink" "timed-out" "0"
fi
reap_bootstrap
symlink_dest_body="$(cat "$symlink_dest_out")"
check_contains "failure names the symlinked destination" \
  "$symlink_dest_body" "$INSTALL_DIR/mise is a symlink"
check "the destination symlink was not replaced" \
  "$(test -L "$INSTALL_DIR/mise" && printf yes || printf no)" "yes"
check "the sentinel directory behind the link is untouched" \
  "$(cd "$SENTINEL_DIR" && find . -mindepth 1 -printf '%f\n' | sort | tr '\n' ',')" "keepme,"
check "the sentinel file content is unchanged" \
  "$(cat "$SENTINEL_DIR/keepme")" "sentinel-content"
check "no staged file was left behind in the install dir (symlink dest)" \
  "$(cd "$INSTALL_DIR" && find . -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | tr '\n' ',')" "mise,"
check "the downloader's output never landed outside the install dir" \
  "$(test -e "$SENTINEL_DIR/mise" && printf yes || printf no)" "no"

echo ""
echo "=== bootstrap runtime: a symlink planted during the download is refused at the destination check ==="
new_sandbox
# The window the destination pre-check cannot cover on its own: the link
# appears AFTER the early destination pre-check (the destination was not a
# file yet, so the fast path is not taken) and BEFORE the refusal that
# guards the move. The downloader is the one phase that provably runs
# inside that window, so the stub plants the link while it delivers the
# payload. The refusal then has to fire on the link that is there now,
# and nothing may be written through it.
#
# Scope, stated precisely: this case covers the refusal standing between
# the pre-check and the move. The residual window between that refusal
# and the `mv` itself is closed by the install-dir permission requirement
# (only the invoking user or root can write there), not by this case --
# see the comment in scripts/bootstrap.sh.
RACE_SENTINEL_DIR="$SANDBOX/race-sentinel"
mkdir -p "$RACE_SENTINEL_DIR"
printf 'sentinel-content\n' >"$RACE_SENTINEL_DIR/keepme"
# Baseline of the sentinel listing, captured with the same pipeline the
# assertions use: an empty expectation is only meaningful next to a
# non-empty baseline, so a broken `find` cannot make the check pass.
RACE_SENTINEL_BASELINE="$(cd "$RACE_SENTINEL_DIR" && find . -mindepth 1 -printf '%f\n' | sort | tr '\n' ',')"
# Control directory for the write-through pipeline: it holds a file named
# `mise`, so the same command has to report it there. Without this control
# an erroring pipeline would report nothing, and the empty expectation
# below would pass for the wrong reason.
RACE_CONTROL_DIR="$SANDBOX/race-control"
mkdir -p "$RACE_CONTROL_DIR"
: >"$RACE_CONTROL_DIR/mise"
# The bootstrap validates the install dir and then installs into the
# canonical path, so the link has to be planted where the install lands.
RACE_INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
cat >"$SANDBOX/race-fake-mise" <<EOF
#!/usr/bin/env bash
printf '%s\n' "fake-mise \$*" >> "$SANDBOX/race-mise-calls.log"
exit 0
EOF
chmod 755 "$SANDBOX/race-fake-mise"
write_stub sha256sum <<EOF
#!/usr/bin/env bash
printf '%s\n' '$PINNED_DIGEST'
EOF
write_stub curl <<EOF
#!/usr/bin/env bash
# Plant the symlink here, exactly where a racing writer would, and still
# deliver the payload so the download phase completes and the script
# proceeds past the digest check to the destination checks.
printf 'downloaded\n' > "$SANDBOX/race-download-ran"
ln -s "$RACE_SENTINEL_DIR" "$RACE_INSTALL_DIR/mise"
prev=""
for arg in "\$@"; do
  if [ "\$prev" = "--output" ]; then
    cp "$SANDBOX/race-fake-mise" "\$arg"
  fi
  prev="\$arg"
done
EOF
race_out="$SANDBOX/race-symlink.out"
run_bootstrap_bg "$race_out" "" \
  "MISE_INSTALL_DIR=$INSTALL_DIR" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 20; then
  check_ne "bootstrap exits non-zero when the symlink appears during the download" "$BOOTSTRAP_RC" "0"
else
  check_ne "bootstrap exits non-zero when the symlink appears during the download" "timed-out" "0"
fi
reap_bootstrap
race_body="$(cat "$race_out")"
check "the sentinel listing baseline is non-empty (the find pipeline works)" \
  "$RACE_SENTINEL_BASELINE" "keepme,"
check_contains "failure names the symlinked destination (planted during the download)" \
  "$race_body" "$RACE_INSTALL_DIR/mise is a symlink"
check_contains "failure names the destination path (planted during the download)" \
  "$race_body" "install destination $RACE_INSTALL_DIR/mise"
check "the destination symlink still points at the sentinel directory" \
  "$(readlink "$INSTALL_DIR/mise" 2>/dev/null || printf '')" "$RACE_SENTINEL_DIR"
check "the destination symlink was not replaced (planted during the download)" \
  "$(test -L "$INSTALL_DIR/mise" && printf yes || printf no)" "yes"
check "the sentinel directory behind the link is untouched (planted during the download)" \
  "$(cd "$RACE_SENTINEL_DIR" && find . -mindepth 1 -printf '%f\n' | sort | tr '\n' ',')" "$RACE_SENTINEL_BASELINE"
check "the sentinel file content is unchanged (planted during the download)" \
  "$(cat "$RACE_SENTINEL_DIR/keepme")" "sentinel-content"
check "the write-through control pipeline reports the control file" \
  "$(cd "$RACE_CONTROL_DIR" && find . -mindepth 1 \( -name 'mise' -o -name '.mise.bootstrap.*' \) -printf '%f\n' | sort | tr '\n' ',')" "mise,"
check "nothing was written through the link into the sentinel directory" \
  "$(cd "$RACE_SENTINEL_DIR" && find . -mindepth 1 \( -name 'mise' -o -name '.mise.bootstrap.*' \) -printf '%f\n' | sort | tr '\n' ',')" ""
check "no staged file was left behind in the install dir (symlink planted during the download)" \
  "$(cd "$INSTALL_DIR" && find . -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | tr '\n' ',')" "mise,"
check "the downloader really ran, so the link was planted inside the window" \
  "$(test -e "$SANDBOX/race-download-ran" && printf yes || printf no)" "yes"
check "the launcher was never executed (the refusal came before the exec)" \
  "$(test -e "$SANDBOX/race-mise-calls.log" && printf yes || printf no)" "no"

echo ""
echo "=== bootstrap runtime: missing pgrep fails closed before the downloader starts ==="
new_sandbox
# A PATH that contains the stub tools but no pgrep at all -- and no
# dirname and no shell either: resolving the script's own directory must
# not depend on either (#1274), or the raw failure would kill the
# bootstrap here before the prerequisite error this scenario asserts on.
# The default mode must refuse with that controlled error before any
# bounded phase, not silently degrade the timeout cleanup to killing
# only the root.
NOPGREP_BIN="$SANDBOX/bin-nopgrep"
mkdir -p "$NOPGREP_BIN"
cat >"$NOPGREP_BIN/sha256sum" <<EOF
#!/usr/bin/env bash
printf '%s\n' '$PINNED_DIGEST'
EOF
cat >"$NOPGREP_BIN/curl" <<EOF
#!/usr/bin/env bash
printf downloaded > "$SANDBOX/curl-ran-nopgrep"
exit 0
EOF
nopgrep_out="$SANDBOX/nopgrep.out"
run_bootstrap_bg "$nopgrep_out" "" \
  "MISE_INSTALL_DIR=$INSTALL_DIR" \
  "HOME=$SANDBOX/home" \
  "PATH=$NOPGREP_BIN"
if wait_exited_or_deadline 20; then
  check_ne "bootstrap exits non-zero when pgrep is missing" "$BOOTSTRAP_RC" "0"
else
  check_ne "bootstrap exits non-zero when pgrep is missing" "timed-out" "0"
fi
reap_bootstrap
nopgrep_body="$(cat "$nopgrep_out")"
check_contains "failure names the missing process tool" "$nopgrep_body" "pgrep"
check_contains "failure names the prerequisite, not a degraded timeout" \
  "$nopgrep_body" "procps"
check_not_contains "failure is controlled, not a raw bash cd error" \
  "$nopgrep_body" "No such file or directory"
check "the downloader never ran without pgrep" \
  "$(test -e "$SANDBOX/curl-ran-nopgrep" && printf yes || printf no)" "no"
check "no launcher was installed without pgrep" \
  "$(test -e "$INSTALL_DIR/mise" && printf yes || printf no)" "no"

echo ""
echo "=== bootstrap runtime: an unusable dirname on PATH cannot mis-root the bootstrap ==="
new_sandbox
# A dirname that shadows the real one and always fails: resolving the
# script's own directory must not go through dirname(1) (#1274). Under
# the old `cd "$(dirname ...)"` this stub produced no output, so `cd ""`
# either silently kept the caller's cwd (bash <= 5.2, mis-rooting setup)
# or aborted with a raw cd error (bash 5.3+); either way the node-pin
# check below could not pass with a mis-rooted .mise/config.toml. The
# stub's log proves the bootstrap never even tries.
cat >"$BIN/dirname" <<EOF
#!/usr/bin/env bash
printf 'called\n' >> "$SANDBOX/dirname-calls.log"
exit 1
EOF
chmod 755 "$BIN/dirname"
write_stub mise <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "install" ] && [ "$2" = "--locked" ]; then
  printf 'mise: locked toolchain ready\n'
fi
exit 0
EOF
write_stub node <<EOF
#!/usr/bin/env bash
if [ "\$1" = "--version" ]; then
  printf 'v%s\n' '$NODE_PIN'
fi
exit 0
EOF
write_stub npm <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "ci" ]; then
  printf 'added 128 packages in 1s\n'
fi
exit 0
EOF
nodirname_out="$SANDBOX/no-dirname.out"
run_bootstrap_bg "$nodirname_out" setup \
  "BOOTSTRAP_MISE=$BIN/mise" \
  "HOME=$SANDBOX/home" \
  "PATH=$BIN:/usr/bin:/bin"
if wait_exited_or_deadline 20; then
  check "setup mode exits 0 with an unusable dirname on PATH" "$BOOTSTRAP_RC" "0"
else
  check "setup mode exits 0 with an unusable dirname on PATH" "timed-out" "0"
fi
reap_bootstrap
nodirname_body="$(cat "$nodirname_out")"
check_contains "setup with an unusable dirname reaches its receipt" \
  "$nodirname_body" "Setup complete in"
check_contains "the receipt records the correctly rooted checkout" \
  "$nodirname_body" "  repo       $ROOT_DIR"
check_contains "the receipt names the launcher directory it derived itself" \
  "$nodirname_body" "($BIN/mise)"
check "the unusable dirname stub was never invoked" \
  "$(test -e "$SANDBOX/dirname-calls.log" && printf yes || printf no)" "no"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
