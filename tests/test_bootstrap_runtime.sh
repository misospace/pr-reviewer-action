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
  if [ -n "$mode" ]; then
    env "$@" bash "$BOOTSTRAP" "$mode" >"$outfile" 2>&1 &
  else
    env "$@" bash "$BOOTSTRAP" >"$outfile" 2>&1 &
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

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
