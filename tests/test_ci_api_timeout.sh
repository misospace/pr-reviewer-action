#!/usr/bin/env bash
set -euo pipefail

# Tests for the bounded gh attempts on the CI polling path (#663).
#
# A hung `gh api` (blackholed network, stuck socket, interactive auth) used
# to stall the CI poll past CI_TIMEOUT_SEC with no chance to retry. These
# tests prove each GitHub CI-status API attempt is wall-clock bounded, that
# a timed-out attempt is terminated + reaped (no surviving child), that the
# result surfaces as the same transient/fail-soft failure callers already
# retry around, and that successful responses stay byte/semantics
# compatible. Everything runs against fake `gh` executables — no network.

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

PASS=0
FAIL=0
_TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$_TEST_DIR/.." && pwd)"
SEAM="$SCRIPT_DIR/scripts/platform_api.sh"
WAIT_SCRIPT="$SCRIPT_DIR/scripts/wait_for_ci.sh"
# shellcheck source=_lib/assert.sh
source "$_TEST_DIR/_lib/assert.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"
mkdir -p "$BIN"
export PATH="$BIN:$PATH"

CR_PID="$TMP/cr.pid"
CS_PID="$TMP/cs.pid"
ATTEMPT_LOG="$TMP/attempts.log"

# ── Harness ─────────────────────────────────────────────────────────────

# Run one seam call on the github backend in a clean subshell.
# Sets RC (exit status), RESULT (stdout), ERR (stderr). The caller exports
# CI_API_TIMEOUT_SEC / CI_TIMEOUT_SEC when the case needs them and unsets
# them afterwards.
github_call() {
  RC=0
  RESULT="$(
    {
      export PLATFORM=github
      set +e
      unset _PLATFORM_API_SOURCED
      # shellcheck source=/dev/null
      source "$SEAM"
      eval "$1"
    } 2>"$TMP/case.err"
  )" || RC=$?
  ERR="$(cat "$TMP/case.err" 2>/dev/null || true)"
}

# True when the process recorded in $1 is gone — dead AND reaped (a zombie
# would still answer `ps -p`).
process_gone() {
  local pid
  pid="$(cat "$1" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  ! ps -p "$pid" >/dev/null 2>&1
}

write_hang_gh() {
  # $1 = check-runs pidfile, $2 = status pidfile; hangs on both endpoints.
  # Each invocation appends to $ATTEMPT_LOG before hanging.
  cat > "$BIN/gh" <<SHELLEOF
#!/usr/bin/env bash
echo attempt >> "$ATTEMPT_LOG"
case "\$*" in
  *check-runs*) echo \$\$ > "$1"; exec sleep 30 ;;
  *)            echo \$\$ > "$2"; exec sleep 30 ;;
esac
exit 0
SHELLEOF
  chmod +x "$BIN/gh"
}

# ── 1. Helper lifecycle: hung gh is bounded, killed, reaped ─────────────

echo "=== _gh_api_bounded: hung attempt is terminated and reaped ==="
write_hang_gh "$CR_PID" "$CS_PID"
rm -f "$CR_PID" "$CS_PID"
T0="$(date +%s)"
export CI_API_TIMEOUT_SEC=1
github_call 'platform_check_runs o/r deadbeef'
T1="$(date +%s)"
unset CI_API_TIMEOUT_SEC
DUR=$((T1 - T0))
check "hung check-runs returns the timeout rc" "$RC" "124"
check "hung check-runs emits no stdout (transient contract)" "$RESULT" ""
check_contains "timeout diagnostic goes to stderr" "$ERR" "terminated (timeout)"
check_ne "timeout diagnostic carries no command env/output" "$ERR" "$RESULT"
if [ "$DUR" -ge 1 ] && [ "$DUR" -le 6 ]; then
  echo "  PASS: hung check-runs returns within the bound plus tolerance (${DUR}s)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: hung check-runs took ${DUR}s (expected 1–6s)"
  FAIL=$((FAIL + 1))
fi
if process_gone "$CR_PID"; then
  echo "  PASS: fake gh (check-runs) is dead and reaped"
  PASS=$((PASS + 1))
else
  echo "  FAIL: fake gh (check-runs) pid $(cat "$CR_PID" 2>/dev/null) still alive"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== _gh_api_bounded: hung combined status is terminated and reaped ==="
rm -f "$CS_PID"
github_call 'platform_commit_status o/r deadbeef'
check "hung combined status returns the timeout rc" "$RC" "124"
check "hung combined status emits no stdout" "$RESULT" ""
if process_gone "$CS_PID"; then
  echo "  PASS: fake gh (combined status) is dead and reaped"
  PASS=$((PASS + 1))
else
  echo "  FAIL: fake gh (combined status) still alive"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== _gh_api_bounded: gh that ignores TERM is escalated to KILL ==="
STUBBORN_PID="$TMP/stubborn.pid"
cat > "$BIN/gh" <<SHELLEOF
#!/usr/bin/env bash
echo \$\$ > "$STUBBORN_PID"
trap '' TERM
while :; do sleep 0.2; done
SHELLEOF
chmod +x "$BIN/gh"
export CI_API_TIMEOUT_SEC=1
github_call 'platform_commit_status o/r deadbeef'
unset CI_API_TIMEOUT_SEC
check "TERM-ignoring gh is killed via escalation" "$RC" "124"
check "escalated attempt emits no stdout" "$RESULT" ""
if process_gone "$STUBBORN_PID"; then
  echo "  PASS: TERM-ignoring fake gh is dead after KILL escalation"
  PASS=$((PASS + 1))
else
  echo "  FAIL: TERM-ignoring fake gh survived the timeout"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== _gh_api_bounded: bound is clamped to the outer CI timeout ==="
rm -f "$CS_PID"
export CI_API_TIMEOUT_SEC=60 CI_TIMEOUT_SEC=2
T0="$(date +%s)"
github_call 'platform_commit_status o/r deadbeef'
T1="$(date +%s)"
unset CI_API_TIMEOUT_SEC CI_TIMEOUT_SEC
DUR=$((T1 - T0))
check "clamped attempt still times out" "$RC" "124"
if [ "$DUR" -le 5 ]; then
  echo "  PASS: CI_API_TIMEOUT_SEC=60 clamped to CI_TIMEOUT_SEC=2 (${DUR}s)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: clamp not applied — attempt took ${DUR}s"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== _gh_api_bounded: invalid knob value falls back safely ==="
rm -f "$CS_PID"
export CI_API_TIMEOUT_SEC=banana CI_TIMEOUT_SEC=2
github_call 'platform_commit_status o/r deadbeef'
unset CI_API_TIMEOUT_SEC CI_TIMEOUT_SEC
check "non-numeric knob falls back and clamps" "$RC" "124"

echo ""
echo "=== _gh_api_bounded: default bound is declared ==="
SEAM_CONTENT="$(cat "$SEAM")"
check_contains "CI_API_TIMEOUT_SEC defaults to 10 (independent of AI_REQUEST_TIMEOUT_SEC)" \
  "$SEAM_CONTENT" 'CI_API_TIMEOUT_SEC:-10'

# ── 2. Normal behavior stays byte/semantics compatible ──────────────────

echo ""
echo "=== Successful responses: byte-identical, failure rc relayed ==="
FIXTURE="$TMP/check-runs.json"
printf '{"check_runs":[{"name":"build","status":"completed","conclusion":"success"}],"total_count":1}\n' > "$FIXTURE"
cat > "$BIN/gh" <<SHELLEOF
#!/usr/bin/env bash
cat "$FIXTURE"
SHELLEOF
chmod +x "$BIN/gh"
github_call 'platform_check_runs o/r deadbeef'
check "successful JSON relayed with rc 0" "$RC" "0"
check "successful JSON is byte-identical (no truncation/reframing)" "$RESULT" "$(cat "$FIXTURE")"
check "success path writes no timeout diagnostic" "$ERR" ""

ERRBODY="$TMP/error-body.txt"
printf '{"message":"Bad credentials","documentation_url":"https://docs.github.com/graphql"}\n' > "$ERRBODY"
cat > "$BIN/gh" <<SHELLEOF
#!/usr/bin/env bash
cat "$ERRBODY"
exit 1
SHELLEOF
chmod +x "$BIN/gh"
github_call 'platform_check_runs o/r deadbeef'
check "gh's own failure relays gh's rc (not 124)" "$RC" "1"
check "gh's error body still arrives on stdout (#190)" "$RESULT" "$(cat "$ERRBODY")"

# ── 3. platform_external_checks: bounded control return ────────────────

echo ""
echo "=== platform_external_checks returns control when APIs hang ==="
CR_PID="$TMP/cr.pid"
CS_PID="$TMP/cs.pid"
write_hang_gh "$CR_PID" "$CS_PID"
rm -f "$CR_PID" "$CS_PID"
T0="$(date +%s)"
export CI_API_TIMEOUT_SEC=1
github_call 'platform_external_checks o/r deadbeef'
T1="$(date +%s)"
unset CI_API_TIMEOUT_SEC
DUR=$((T1 - T0))
check "external_checks rc 0 on double timeout (transient contract)" "$RC" "0"
check "external_checks emits empty stdout on double timeout (retry signal)" "$RESULT" ""
if [ "$DUR" -le 8 ]; then
  echo "  PASS: external_checks returned control in ${DUR}s (both underlying calls bounded)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: external_checks took ${DUR}s to return"
  FAIL=$((FAIL + 1))
fi
if process_gone "$CR_PID" && process_gone "$CS_PID"; then
  echo "  PASS: both fake gh children are dead and reaped"
  PASS=$((PASS + 1))
else
  echo "  FAIL: a fake gh child survived external_checks"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== platform_external_checks degrades to the surviving signal ==="
rm -f "$CR_PID"
COMBINED_OK="$TMP/combined-ok.json"
printf '{"state":"pending","total_count":1,"statuses":[{"context":"golangci-lint","state":"success"}]}\n' > "$COMBINED_OK"
cat > "$BIN/gh" <<SHELLEOF
#!/usr/bin/env bash
case "\$*" in
  *check-runs*) echo \$\$ > "$CR_PID"; exec sleep 30 ;;
  *)            cat "$COMBINED_OK" ;;
esac
SHELLEOF
chmod +x "$BIN/gh"
github_call 'platform_external_checks o/r deadbeef'
check "one hung API does not sink the other's data" "$RESULT" '[{"name":"golangci-lint","state":"success"}]'
check "degraded external_checks still succeeds" "$RC" "0"
if process_gone "$CR_PID"; then
  echo "  PASS: hung check-runs fake is dead and reaped"
  PASS=$((PASS + 1))
else
  echo "  FAIL: hung check-runs fake survived"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Normalization is unchanged through the bounded path ==="
OWN_RUN='{"id": 1, "name": "ai-review", "status": "in_progress", "conclusion": null, "details_url": "https://github.com/test/repo/actions/runs/999/job/1", "html_url": "https://github.com/test/repo/actions/runs/999/job/1"}'
EXT_SUCCESS='{"id": 2, "name": "build", "status": "completed", "conclusion": "success", "details_url": "https://github.com/test/repo/actions/runs/555/job/2", "html_url": "https://github.com/test/repo/actions/runs/555/job/2"}'
printf '{"check_runs": [%s, %s], "total_count": 2}\n' "$OWN_RUN" "$EXT_SUCCESS" > "$BIN/check-runs.json"
printf '{"state": "pending", "total_count": 0}\n' > "$BIN/combined.json"
cat > "$BIN/gh" <<'SHELLEOF'
#!/usr/bin/env bash
case "$*" in
  *check-runs*) cat "$(dirname "$0")/check-runs.json" ;;
  *)            cat "$(dirname "$0")/combined.json" ;;
esac
SHELLEOF
chmod +x "$BIN/gh"
github_call 'GITHUB_RUN_ID=999 CI_STATUS_CONTEXT=pr-reviewer-action platform_external_checks o/r deadbeef'
check "own-run exclusion + normalization identical to the unbounded seam" \
  "$RESULT" '[{"name":"build","state":"success"}]'
check "normal-path external_checks rc 0" "$RC" "0"

# ── 4. Overall polling: wait_for_ci.sh under a hanging API ──────────────

echo ""
echo "=== wait_for_ci.sh: overall CI_TIMEOUT_SEC stays authoritative ==="

run_wait() { # $1 = extra env assignments (KEY=val KEY2=val2 ...); sets WAIT_RC, WAIT_OUT, WAIT_DUR
  local out_file="$TMP/wait-output.$RANDOM"
  : > "$ATTEMPT_LOG"
  rm -f "$CR_PID" "$CS_PID"
  unset CI_TIMEOUT_SEC CI_INTERVAL_SEC CI_SKIP_ON_TIMEOUT CI_API_TIMEOUT_SEC
  T0="$(date +%s)"
  WAIT_RC=0
  (
    eval "export $1"
    export PATH="$BIN:$PATH"
    GH_TOKEN=test REPO="test/repo" PR_NUMBER=7 PR_HEAD_SHA="deadbeef" \
      GITHUB_RUN_ID="999" CI_STATUS_CONTEXT="pr-reviewer-action" \
      CI_STATUS_CHECK=true CI_CHECKS_FILE="$TMP/ci-checks.md" \
      GITHUB_OUTPUT="$out_file" \
      bash "$WAIT_SCRIPT" >/dev/null 2>&1
  ) || WAIT_RC=$?
  T1="$(date +%s)"
  WAIT_DUR=$((T1 - T0))
  WAIT_OUT="$(cat "$out_file" 2>/dev/null || true)"
}

ATTEMPT_LOG="$TMP/attempts.log"

# Normal path first: fixtures reach a terminal success end-to-end.
cat > "$BIN/gh" <<SHELLEOF
#!/usr/bin/env bash
case "\$*" in
  *check-runs*) cat "$BIN/check-runs.json" ;;
  *)            cat "$BIN/combined.json" ;;
esac
SHELLEOF
chmod +x "$BIN/gh"
run_wait "CI_TIMEOUT_SEC=6 CI_INTERVAL_SEC=1 CI_SKIP_ON_TIMEOUT=true"
check "normal path: wait_for_ci exit 0" "$WAIT_RC" "0"
check_contains "normal path: final state success (unchanged)" "$WAIT_OUT" "ci_status_final=success"

# Both endpoints hang: one bounded attempt consumes the budget, then the
# outer timeout wins — a single hung gh can no longer hold the poller.
write_hang_gh "$CR_PID" "$CS_PID"
run_wait "CI_TIMEOUT_SEC=3 CI_INTERVAL_SEC=1 CI_API_TIMEOUT_SEC=1 CI_SKIP_ON_TIMEOUT=true"
check "hung API: exit 1 with skip=true" "$WAIT_RC" "1"
check_contains "hung API: skipped output written" "$WAIT_OUT" "ci_status_skipped=true"
ATTEMPTS="$(wc -l < "$ATTEMPT_LOG" | tr -d ' ')"
check "hung API: one bounded attempt per endpoint (both APIs tried once)" "$ATTEMPTS" "2"
if [ "$WAIT_DUR" -le 10 ]; then
  echo "  PASS: poller returned in ${WAIT_DUR}s despite two hung endpoints"
  PASS=$((PASS + 1))
else
  echo "  FAIL: poller took ${WAIT_DUR}s (outer policy not honored)"
  FAIL=$((FAIL + 1))
fi
if process_gone "$CR_PID" && process_gone "$CS_PID"; then
  echo "  PASS: no fake gh survives the overall timeout"
  PASS=$((PASS + 1))
else
  echo "  FAIL: a fake gh survived the overall timeout"
  FAIL=$((FAIL + 1))
fi

# Retry proof: check-runs hangs, combined status is pending — the poller
# regains control after each bounded attempt and keeps polling until the
# outer timeout, instead of stalling on the first hung call. CI_TIMEOUT_SEC=4
# guarantees at least two poll iterations: after iteration one, elapsed is at
# most 2 (attempt) + 1 (sleep) = 3 < 4.
cat > "$BIN/gh" <<SHELLEOF
#!/usr/bin/env bash
case "\$*" in
  *check-runs*) echo attempt >> "$ATTEMPT_LOG"; echo \$\$ > "$CR_PID"; exec sleep 30 ;;
  *)            printf '{"state":"pending","total_count":1,"statuses":[{"context":"lint","state":"pending"}]}\n' ;;
esac
SHELLEOF
chmod +x "$BIN/gh"
run_wait "CI_TIMEOUT_SEC=4 CI_INTERVAL_SEC=1 CI_API_TIMEOUT_SEC=1 CI_SKIP_ON_TIMEOUT=true"
check "retry path: exit 1 with skip=true" "$WAIT_RC" "1"
check_contains "retry path: skipped output written" "$WAIT_OUT" "ci_status_skipped=true"
ATTEMPTS="$(wc -l < "$ATTEMPT_LOG" | tr -d ' ')"
if [ "$ATTEMPTS" -ge 2 ]; then
  echo "  PASS: polling regained control and retried (${ATTEMPTS} attempts)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected multiple attempts after bounded timeouts, got ${ATTEMPTS}"
  FAIL=$((FAIL + 1))
fi
if [ "$WAIT_DUR" -le 12 ]; then
  echo "  PASS: retry loop honored the outer policy (${WAIT_DUR}s)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: retry loop ran ${WAIT_DUR}s"
  FAIL=$((FAIL + 1))
fi
if process_gone "$CR_PID"; then
  echo "  PASS: hung fake gh reaped after the retry loop"
  PASS=$((PASS + 1))
else
  echo "  FAIL: hung fake gh survived the retry loop"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -gt 0 ]] && exit 1 || exit 0
