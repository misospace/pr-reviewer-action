# shellcheck shell=bash
# Sourced by run_review.sh — concurrent review-gate orchestration (#634).
#
# Two independent, expensive branches must both resolve before the final
# reviewer may start:
#
#   * the CI gate — wait_for_ci.sh polls external checks to a terminal state
#     and writes the finalized per-check evidence to $CI_CHECKS_FILE, and
#   * the advisory specialist gate — the three fixed deep-review roles run
#     over the #632 compact pre-final specialist corpus.
#
# Before #634 the CI wait was its own composite-action step, so it always
# finished before run_review.sh started and specialist latency could never
# hide behind it. The specialist corpus is deliberately independent of CI
# (#632), so the two branches can run concurrently: this module forks both,
# reaps both, and lets the caller build the *final* corpus only after both are
# resolved. Specialists stay advisory and fail-soft; CI gating keeps its exact
# historical timeout/failure semantics (a nonzero wait never blocks the
# review — the old separate step ran with continue-on-error).
#
# Only function definitions and their state vars live here (no top-level
# execution), so tests can source the module and substitute the
# `*_command` hooks with controlled fake-delay stubs.
#
# This module relies on orchestrator globals/helpers (`SCRIPT_DIR`, `log`,
# `error`) and on the config.sh CI defaults; it is not executable on its own.

# ── CI gate ─────────────────────────────────────────────────────────────
CI_GATE_ACTIVE="false"
CI_GATE_PID=""
CI_GATE_LOG="ci-status.phase.log"

# Overridable branch entrypoint (tests substitute a fake-delay stub). Kept a
# function rather than an inline command so the composition can be exercised
# without the network/gh seam.
wait_for_ci_command() {
  bash "$SCRIPT_DIR/wait_for_ci.sh"
}

# Fork the CI gate when ci_status_check=true. Non-blocking: the caller keeps
# building deterministic context / the specialist branch while wait_for_ci.sh
# polls. A stale $CI_CHECKS_FILE from a previous run in a reused workspace is
# removed first, so any specialist corpus built during the concurrent window
# can only ever see CI evidence this run actually produced (never a prior
# run's); wait_for_ci.sh re-writes it atomically at its terminal state.
fork_ci_gate() {
  CI_GATE_ACTIVE="false"
  CI_GATE_PID=""
  if [[ "$(printf '%s' "${CI_STATUS_CHECK:-false}" | tr '[:upper:]' '[:lower:]')" != "true" ]]; then
    return 0
  fi

  if [[ -n "${CI_CHECKS_FILE:-}" ]]; then
    rm -f -- "$CI_CHECKS_FILE" 2>/dev/null || true
  fi

  CI_GATE_ACTIVE="true"
  wait_for_ci_command >"$CI_GATE_LOG" 2>&1 &
  CI_GATE_PID=$!
  log "CI status gating launched concurrently (pid $CI_GATE_PID)"
}

# Reap the CI gate fully before the finalized evidence is read into the final
# corpus. Fail-soft: wait is guarded against set -e and a nonzero status only
# logs — the standalone step's continue-on-error meant a timeout (exit 1) or
# fatal (exit 2) never blocked the review, and that behavior is preserved.
join_ci_gate() {
  [[ "${CI_GATE_ACTIVE:-false}" == "true" ]] || return 0
  [[ -n "${CI_GATE_PID:-}" ]] || return 0
  local status=0
  wait "$CI_GATE_PID" || status=$?
  cat "$CI_GATE_LOG" 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    log "CI status gating exited ${status}; continuing (CI evidence is advisory)"
  fi
}

# ── Advisory specialist gate ────────────────────────────────────────────
DEEP_REVIEW_ACTIVE="false"
SPECIALIST_GATE_PID=""
SPECIALIST_GATE_LOG="specialists.phase.log"

# Overridable branch entrypoint (tests substitute a fake-delay stub).
specialist_command() {
  python3 "$SCRIPT_DIR/run_specialists.py" --corpus specialist-corpus.md
}

# Overridable specialist-corpus build (tests substitute a no-op stub). Fail-soft:
# a builder failure leaves an empty corpus that run_specialists.py records as a
# per-role input error; the final review is never blocked.
build_specialist_corpus_command() {
  python3 "$SCRIPT_DIR/build_specialist_corpus.py" \
    --workspace "${GITHUB_WORKSPACE:-$(pwd)}" \
    --output specialist-corpus.md \
    --max-bytes "$DEEP_REVIEW_CORPUS_MAX_BYTES"
}

# Build the compact #632 pre-final specialist corpus, then fork the three fixed
# roles (concurrent with each other inside run_specialists.py) when deep_review
# is enabled. The build happens here, before the fork, so the corpus is fixed
# from the artifacts collected so far — never the final review corpus, and
# never retroactively mutated by a CI result that lands later.
fork_specialist_gate() {
  DEEP_REVIEW_ACTIVE="false"
  SPECIALIST_GATE_PID=""
  if [[ "$(printf '%s' "${DEEP_REVIEW:-false}" | tr '[:upper:]' '[:lower:]')" != "true" ]]; then
    return 0
  fi

  DEEP_REVIEW_ACTIVE="true"
  if ! build_specialist_corpus_command; then
    error "specialist corpus build failed; specialists will record an input error"
    : > specialist-corpus.md
  fi
  specialist_command >"$SPECIALIST_GATE_LOG" 2>&1 &
  SPECIALIST_GATE_PID=$!
  log "deep_review: specialist roles (correctness/security/tests) launched concurrently over the bounded specialist corpus (pid $SPECIALIST_GATE_PID)"
}

# Reap the specialist phase fully before its rendered leads are read. Fail-soft:
# a nonzero phase status only logs an error — advisory passes never block the
# final review.
join_specialist_gate() {
  [[ "${DEEP_REVIEW_ACTIVE:-false}" == "true" ]] || return 0
  [[ -n "${SPECIALIST_GATE_PID:-}" ]] || return 0
  local status=0
  wait "$SPECIALIST_GATE_PID" || status=$?
  cat "$SPECIALIST_GATE_LOG" 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    error "specialist phase exited ${status}; continuing (advisory passes never block the final review)"
  fi
}
