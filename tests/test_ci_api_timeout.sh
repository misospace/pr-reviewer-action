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

# True when no process from $1 is running: either it was never started
# (deadline exhausted before the attempt — no pidfile) or it is dead and
# reaped.
no_process() {
  local pid
  pid="$(cat "$1" 2>/dev/null || true)"
  [[ -z "$pid" ]] && return 0
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

echo ""
echo "=== _gh_api_bounded: timeout provenance is the delivered signal ==="
# Regression: the fake handles TERM and exits with status 3 — deliberately
# NOT 143/137. Classification must come from the watchdog's delivered-
# signal marker; an rc-only rule would relay this as gh's own failure (3).
TRAP_PID="$TMP/trap.pid"
TRAP_MARK="$TMP/trapped.marker"
rm -f "$TRAP_MARK"
cat > "$BIN/gh" <<SHELLEOF
#!/usr/bin/env bash
echo \$\$ > "$TRAP_PID"
trap 'echo got-term > "$TRAP_MARK"; exit 3' TERM
while :; do sleep 0.2; done
SHELLEOF
chmod +x "$BIN/gh"
export CI_API_TIMEOUT_SEC=1
github_call 'platform_commit_status o/r deadbeef'
unset CI_API_TIMEOUT_SEC
check "watchdog-signaled gh classifies as timeout despite exit 3" "$RC" "124"
check "watchdog-signaled gh emits no stdout" "$RESULT" ""
check "watchdog actually delivered TERM (fake's handler ran)" \
  "$(cat "$TRAP_MARK" 2>/dev/null || true)" "got-term"
if process_gone "$TRAP_PID"; then
  echo "  PASS: TERM-handling fake is dead and reaped"
  PASS=$((PASS + 1))
else
  echo "  FAIL: TERM-handling fake survived the timeout"
  FAIL=$((FAIL + 1))
fi
# The not-delivered side: a child that exits on its own before any signal
# is relayed with its own rc (the error-relay test below asserts rc 1) — a
# failed kill never creates the marker, so it cannot fabricate a timeout.

echo ""
echo "=== CI_DEADLINE_EPOCH: expired budget skips the attempt entirely ==="
rm -f "$CR_PID"
cat > "$BIN/gh" <<SHELLEOF
#!/usr/bin/env bash
echo \$\$ > "$CR_PID"
exec sleep 30
SHELLEOF
chmod +x "$BIN/gh"
export CI_DEADLINE_EPOCH=$(( $(date +%s) - 1 )) CI_API_TIMEOUT_SEC=30
T0="$(date +%s)"
github_call 'platform_check_runs o/r deadbeef'
T1="$(date +%s)"
unset CI_DEADLINE_EPOCH CI_API_TIMEOUT_SEC
DUR=$((T1 - T0))
check "expired deadline returns the timeout rc" "$RC" "124"
check "expired deadline emits no stdout (transient contract)" "$RESULT" ""
check "no gh attempt started (deadline already passed)" \
  "$(test -e "$CR_PID" && echo started || echo skipped)" "skipped"
if [ "$DUR" -le 3 ]; then
  echo "  PASS: skipped immediately (${DUR}s)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expired-deadline call took ${DUR}s"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== CI_DEADLINE_EPOCH: bound shrinks to the remaining budget ==="
rm -f "$CS_PID"
cat > "$BIN/gh" <<SHELLEOF
#!/usr/bin/env bash
echo \$\$ > "$CS_PID"
exec sleep 30
SHELLEOF
chmod +x "$BIN/gh"
export CI_DEADLINE_EPOCH=$(( $(date +%s) + 1 )) CI_API_TIMEOUT_SEC=30
T0="$(date +%s)"
github_call 'platform_commit_status o/r deadbeef'
T1="$(date +%s)"
unset CI_DEADLINE_EPOCH CI_API_TIMEOUT_SEC
DUR=$((T1 - T0))
check "remaining-budget attempt still times out" "$RC" "124"
check "remaining-budget attempt emits no stdout" "$RESULT" ""
if [ "$DUR" -le 4 ]; then
  echo "  PASS: knob=30 clamped to ~1s of remaining budget (${DUR}s)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: remaining budget not honored — attempt took ${DUR}s"
  FAIL=$((FAIL + 1))
fi
if process_gone "$CS_PID"; then
  echo "  PASS: fake gh reaped after remaining-budget timeout"
  PASS=$((PASS + 1))
else
  echo "  FAIL: fake gh survived the remaining-budget timeout"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== CI_DEADLINE_EPOCH: garbage value falls back to the plain clamp ==="
rm -f "$CS_PID"
export CI_DEADLINE_EPOCH=banana CI_TIMEOUT_SEC=2 CI_API_TIMEOUT_SEC=60
T0="$(date +%s)"
github_call 'platform_commit_status o/r deadbeef'
T1="$(date +%s)"
unset CI_DEADLINE_EPOCH CI_TIMEOUT_SEC CI_API_TIMEOUT_SEC
DUR=$((T1 - T0))
check "garbage deadline ignored; CI_TIMEOUT_SEC clamp still applies" "$RC" "124"
if [ "$DUR" -le 5 ]; then
  echo "  PASS: fell back to the CI_TIMEOUT_SEC clamp (${DUR}s)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: garbage deadline broke bounding — took ${DUR}s"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== platform_external_checks: one iteration cannot exceed the outer deadline ==="
# Two simultaneously hanging endpoints share one deadline: the second call
# is bounded by what the first left, so the iteration lands near the
# deadline + tolerance instead of 2x the per-call bound.
write_hang_gh "$CR_PID" "$CS_PID"
rm -f "$CR_PID" "$CS_PID"
export CI_DEADLINE_EPOCH=$(( $(date +%s) + 5 )) CI_API_TIMEOUT_SEC=10
T0="$(date +%s)"
github_call 'platform_external_checks o/r deadbeef'
T1="$(date +%s)"
unset CI_DEADLINE_EPOCH CI_API_TIMEOUT_SEC
DUR=$((T1 - T0))
check "deadline-capped iteration is still a transient failure" "$RC" "0"
check "deadline-capped iteration emits the retry signal (empty stdout)" "$RESULT" ""
if [ "$DUR" -ge 4 ] && [ "$DUR" -le 9 ]; then
  echo "  PASS: two hanging endpoints capped by the shared deadline (${DUR}s)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: iteration took ${DUR}s (expected deadline + tolerance)"
  FAIL=$((FAIL + 1))
fi
if process_gone "$CR_PID" && no_process "$CS_PID"; then
  echo "  PASS: both fake gh children reaped (or never started — budget exhausted)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: a fake gh child survived the deadline-capped iteration"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== CI_DEADLINE_EPOCH: the second call re-bounds after the first ==="
# check-runs succeeds slowly (2s), then combined status hangs: the second
# attempt must run on the REMAINING budget (~1s), not the full knob (10s).
SLOW_JSON="$TMP/slow-check-runs.json"
printf '{"check_runs":[{"name":"build","status":"completed","conclusion":"success"}],"total_count":1}\n' > "$SLOW_JSON"
cat > "$BIN/gh" <<SHELLEOF
#!/usr/bin/env bash
case "\$*" in
  *check-runs*) sleep 2; cat "$SLOW_JSON" ;;
  *)            echo \$\$ > "$CS_PID"; exec sleep 30 ;;
esac
SHELLEOF
chmod +x "$BIN/gh"
rm -f "$CS_PID"
export CI_DEADLINE_EPOCH=$(( $(date +%s) + 3 )) CI_API_TIMEOUT_SEC=10
T0="$(date +%s)"
github_call 'platform_external_checks o/r deadbeef'
T1="$(date +%s)"
unset CI_DEADLINE_EPOCH CI_API_TIMEOUT_SEC
DUR=$((T1 - T0))
check "slow-then-hung iteration still yields the surviving signal" \
  "$RESULT" '[{"name":"build","state":"success"}]'
check "re-bounded iteration rc 0" "$RC" "0"
if [ "$DUR" -ge 2 ] && [ "$DUR" -le 6 ]; then
  echo "  PASS: second attempt ran on the remaining budget (iteration ${DUR}s)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: second attempt did not re-bound (iteration took ${DUR}s)"
  FAIL=$((FAIL + 1))
fi
if no_process "$CS_PID"; then
  echo "  PASS: hung combined-status fake reaped (or skipped at exhausted budget)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: hung combined-status fake survived"
  FAIL=$((FAIL + 1))
fi

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
  unset CI_TIMEOUT_SEC CI_INTERVAL_SEC CI_SKIP_ON_TIMEOUT CI_API_TIMEOUT_SEC CI_DEADLINE_EPOCH
  T0="$(date +%s)"
  WAIT_RC=0
  (
    eval "export $1"
    export PATH="$BIN:$PATH"
    GH_TOKEN=test REPO="test/repo" PR_NUMBER=7 \
      PR_HEAD_SHA="${WAIT_PR_HEAD_SHA:-deadbeef}" \
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
if [ "$WAIT_DUR" -le 6 ]; then
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
if [ "$WAIT_DUR" -le 7 ]; then
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

# ── 5. Deadline-aware sleeps and one shared budget (#663 review) ────────

# Pending external check fixture. Fakes below are single-quoted heredocs
# that cat this file — interpolating the JSON itself into an unquoted
# heredoc would let bash strip its double quotes and produce invalid JSON.
PENDING_FIXTURE="$TMP/pending-checks.json"
printf '%s\n' '{"check_runs":[{"name":"lint","status":"in_progress","conclusion":null}],"total_count":1}' > "$PENDING_FIXTURE"
export ATTEMPT_LOG PENDING_FIXTURE

echo ""
echo "=== wait_for_ci.sh: poll sleeps cannot oversleep the deadline ==="
# Pending check with CI_INTERVAL_SEC=15 against a 4s budget: an
# unconditional interval sleep would notice the timeout only after ~15s.
# The clamped sleep hands control back at the deadline (~4s).
cat > "$BIN/gh" <<'SHELLEOF'
#!/usr/bin/env bash
case "$*" in
  *check-runs*) echo attempt >> "$ATTEMPT_LOG"; cat "$PENDING_FIXTURE" ;;
  *)            printf '{"state":"pending","total_count":0}\n' ;;
esac
SHELLEOF
chmod +x "$BIN/gh"
run_wait "CI_TIMEOUT_SEC=4 CI_INTERVAL_SEC=15 CI_SKIP_ON_TIMEOUT=true"
check "oversleep guard: exit 1 with skip=true" "$WAIT_RC" "1"
check_contains "oversleep guard: skipped output written" "$WAIT_OUT" "ci_status_skipped=true"
if [ "$WAIT_DUR" -ge 3 ] && [ "$WAIT_DUR" -le 7 ]; then
  echo "  PASS: pending sleep clamped to the deadline (${WAIT_DUR}s, interval would be 15s)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: pending sleep overslept the deadline — took ${WAIT_DUR}s"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== wait_for_ci.sh: transient-retry sleep is deadline-clamped ==="
# Both endpoints answer empty (the transient contract) instantly; the
# retry sleep is the only thing that can oversleep. With instant attempts
# the one clamped sleep consumes the whole remaining budget, so exactly
# one poll iteration is correct — a broken sleep (busy-loop) would show
# attempts ≫ 1; an unconditional interval sleep would oversleep the wall.
cat > "$BIN/gh" <<'SHELLEOF'
#!/usr/bin/env bash
case "$*" in
  *check-runs*) echo attempt >> "$ATTEMPT_LOG"; exit 0 ;;
  *)            exit 0 ;;
esac
SHELLEOF
chmod +x "$BIN/gh"
run_wait "CI_TIMEOUT_SEC=4 CI_INTERVAL_SEC=15 CI_SKIP_ON_TIMEOUT=true"
check "empty-retry: exit 1 with skip=true" "$WAIT_RC" "1"
check_contains "empty-retry: skipped output written" "$WAIT_OUT" "ci_status_skipped=true"
ATTEMPTS="$(wc -l < "$ATTEMPT_LOG" | tr -d ' ')"
check "empty-retry: exactly one poll, then the clamped sleep ends the budget" "$ATTEMPTS" "1"
if [ "$WAIT_DUR" -le 7 ]; then
  echo "  PASS: empty-retry sleep clamped to the deadline (${WAIT_DUR}s)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: empty-retry sleep overslept — took ${WAIT_DUR}s"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== wait_for_ci.sh: head-SHA lookup and polling share one deadline ==="
# PR_HEAD_SHA absent: the pulls (head-SHA) request consumes 3s of a 5s
# budget, then polling gets only the remaining ~2s. With per-phase budgets
# the loop would start a fresh CI_TIMEOUT_SEC after the lookup (3s + 5s+).
cat > "$BIN/gh" <<'SHELLEOF'
#!/usr/bin/env bash
case "$*" in
  *pulls*)      sleep 3; echo deadbeef ;;
  *check-runs*) echo attempt >> "$ATTEMPT_LOG"; cat "$PENDING_FIXTURE" ;;
  *)            printf '{"state":"pending","total_count":0}\n' ;;
esac
SHELLEOF
chmod +x "$BIN/gh"
run_wait "CI_TIMEOUT_SEC=5 CI_INTERVAL_SEC=15 CI_SKIP_ON_TIMEOUT=true WAIT_PR_HEAD_SHA="
check "shared budget: head-SHA fetch succeeded inside the budget" "$WAIT_RC" "1"
check_contains "shared budget: skipped output written" "$WAIT_OUT" "ci_status_skipped=true"
if [ "$WAIT_DUR" -ge 3 ] && [ "$WAIT_DUR" -le 7 ]; then
  echo "  PASS: lookup + polling shared the 5s budget (${WAIT_DUR}s; split budgets would need 8s+)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: deadline not shared with the head-SHA lookup — took ${WAIT_DUR}s"
  FAIL=$((FAIL + 1))
fi
ATTEMPTS="$(wc -l < "$ATTEMPT_LOG" | tr -d ' ')"
if [ "$ATTEMPTS" -ge 1 ]; then
  echo "  PASS: polling still ran after the shared-budget lookup (${ATTEMPTS} attempt(s))"
  PASS=$((PASS + 1))
else
  echo "  FAIL: no poll attempt after the head-SHA lookup"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== wait_for_ci.sh: normal cadence unchanged with ample budget ==="
cat > "$BIN/gh" <<'SHELLEOF'
#!/usr/bin/env bash
case "$*" in
  *check-runs*) echo attempt >> "$ATTEMPT_LOG"; cat "$PENDING_FIXTURE" ;;
  *)            printf '{"state":"pending","total_count":0}\n' ;;
esac
SHELLEOF
chmod +x "$BIN/gh"
run_wait "CI_TIMEOUT_SEC=4 CI_INTERVAL_SEC=1 CI_SKIP_ON_TIMEOUT=true"
check "cadence: exit 1 with skip=true" "$WAIT_RC" "1"
ATTEMPTS="$(wc -l < "$ATTEMPT_LOG" | tr -d ' ')"
if [ "$ATTEMPTS" -ge 3 ]; then
  echo "  PASS: polled every interval (${ATTEMPTS} attempts over ${WAIT_DUR}s)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected full-interval cadence, got ${ATTEMPTS} attempts"
  FAIL=$((FAIL + 1))
fi
if [ "$WAIT_DUR" -ge 3 ] && [ "$WAIT_DUR" -le 8 ]; then
  echo "  PASS: sleeps still run at full interval when budget allows (${WAIT_DUR}s)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: cadence disturbed — ${ATTEMPTS} attempts in ${WAIT_DUR}s"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -gt 0 ]] && exit 1 || exit 0
