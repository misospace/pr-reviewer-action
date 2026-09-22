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

# Explicit least-privilege allowlist for the CI child process. Before #634 the
# CI wait ran as its own composite-action step, so it only ever saw that step's
# narrow env block plus the runner's own defaults. Now that it is forked from
# inside the review step it would otherwise inherit the full review environment
# — AI_API_KEY / AI_PRIMARY_API_KEY / AI_SMART_API_KEY / AI_FALLBACK_API_KEY,
# TOOL_MCP_TOKEN, LINEAR_API_KEY, and every other reviewer-only input. This list
# is the boundary: only these keys (when set) are forwarded, and adding a new
# reviewer input can never silently widen the CI process — it has to be named
# here on purpose. It is an allowlist, not a denylist, so a future secret is
# excluded by default.
#
# Categories:
#   - process/runner basics the subprocess needs to execute at all, plus the
#     benign network transport/runtime configuration the pre-#634 standalone
#     step inherited from the workflow/runner (proxy and custom-CA vars in both
#     cases, and the gh CLI config dirs) so GitHub/Forgejo connectivity is
#     unchanged. RUNNER_TRACKING_ID is included because it is benign runner
#     lifecycle metadata (not reviewer authority) that GitHub Runner uses for
#     orphan-process cleanup;
#   - runner metadata: $GITHUB_OUTPUT (ci_status_* results), $GITHUB_RUN_ID +
#     $CI_STATUS_CONTEXT (own check/status self-exclusion), and the OIDC
#     request vars the Forgejo authorized-integration backend reads;
#   - GitHub/Forgejo auth + repository identity;
#   - the CI gate controls wait_for_ci.sh reads (timings, skip-on-timeout,
#     the published evidence path).
# Deliberately NOT included: model/tool/Linear/reviewer config and secrets, and
# AI_REQUEST_TIMEOUT_SEC (the pre-#634 CI step never received it, so the Forgejo
# backend keeps its own default).
_CI_GATE_ENV_KEYS=(
  PATH HOME
  RUNNER_TRACKING_ID
  HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY
  http_proxy https_proxy all_proxy no_proxy
  SSL_CERT_FILE SSL_CERT_DIR CURL_CA_BUNDLE
  GH_CONFIG_DIR XDG_CONFIG_HOME
  GITHUB_OUTPUT GITHUB_RUN_ID GITHUB_REPOSITORY
  GITHUB_SERVER_URL GITHUB_API_URL GH_HOST
  ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN
  GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
  REPO PR_NUMBER PR_HEAD_SHA
  PLATFORM FORGEJO_API_URL
  FORGEJO_TOKEN FORGEJO_AUTH_METHOD
  FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE FORGEJO_SKIP_PERMISSION_PREFLIGHT
  CI_STATUS_CHECK CI_TIMEOUT_SEC CI_INTERVAL_SEC CI_SKIP_ON_TIMEOUT
  CI_CHECKS_FILE CI_STATUS_CONTEXT
)

# Overridable branch entrypoint (tests substitute a fake-delay stub). Kept a
# function rather than an inline command so the composition can be exercised
# without the network/gh seam. Launches wait_for_ci.sh under `env -i` with the
# explicit allowlist above, restoring the pre-#634 least-privilege boundary.
wait_for_ci_command() {
  local -a env_args=()
  local key
  for key in "${_CI_GATE_ENV_KEYS[@]}"; do
    if [ -n "${!key+x}" ]; then
      env_args+=("${key}=${!key}")
    fi
  done
  env -i "${env_args[@]}" bash "$SCRIPT_DIR/wait_for_ci.sh"
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
# Retires the PID state so the abnormal-exit cleanup can never double-wait,
# double-kill, or target a reused PID; CI_GATE_ACTIVE stays "true" as the
# "gate ran this review" signal corpus.sh uses for its final-corpus rebuild.
join_ci_gate() {
  [[ "${CI_GATE_ACTIVE:-false}" == "true" ]] || return 0
  [[ -n "${CI_GATE_PID:-}" ]] || return 0
  local status=0
  wait "$CI_GATE_PID" || status=$?
  CI_GATE_PID=""
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
# final review. Retires the PID state so the abnormal-exit cleanup can never
# double-wait, double-kill, or target a reused PID; DEEP_REVIEW_ACTIVE stays
# "true" as the "phase ran" signal review.sh uses for its step-summary row.
join_specialist_gate() {
  [[ "${DEEP_REVIEW_ACTIVE:-false}" == "true" ]] || return 0
  [[ -n "${SPECIALIST_GATE_PID:-}" ]] || return 0
  local status=0
  wait "$SPECIALIST_GATE_PID" || status=$?
  SPECIALIST_GATE_PID=""
  cat "$SPECIALIST_GATE_LOG" 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    error "specialist phase exited ${status}; continuing (advisory passes never block the final review)"
  fi
}

# ── Abnormal-exit lifecycle (#634) ──────────────────────────────────────
# fork_* launch asynchronous children that are normally reaped by join_*. If
# the orchestrator exits between fork and join — set -e, TERM/INT, job
# cancellation, any unexpected failure — a surviving gate child would keep
# running: the CI child retains GitHub/Forgejo credentials and may keep
# polling, and the specialist child retains the full reviewer environment
# (model credentials included). install_gate_lifecycle_trap() gives both gate
# children deterministic ownership on abnormal exit. Cleanup is bounded: TERM,
# a short grace poll, then KILL, then a final wait to reap the child.
GATE_CLEANUP_GRACE_STEPS="${GATE_CLEANUP_GRACE_STEPS:-20}"
GATE_CLEANUP_GRACE_INTERVAL_SEC="${GATE_CLEANUP_GRACE_INTERVAL_SEC:-0.1}"

gate_terminate_and_reap() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  local i=0
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt "$GATE_CLEANUP_GRACE_STEPS" ]; do
      sleep "$GATE_CLEANUP_GRACE_INTERVAL_SEC" 2>/dev/null || true
      i=$((i + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  # Reap whatever is left (a no-op when the child already exited), so no
  # zombie or surviving process is left for the runner to clean up.
  wait "$pid" 2>/dev/null || true
}

# Terminate + reap whichever gate child is still active. A join_* that already
# reaped its child cleared the PID, so this is a no-op on the normal path and
# cannot double-kill or wait on an unrelated reused PID.
cleanup_gate_children() {
  if [[ -n "${CI_GATE_PID:-}" ]]; then
    log "abnormal exit: terminating active CI gate child (pid $CI_GATE_PID)"
    gate_terminate_and_reap "$CI_GATE_PID"
    CI_GATE_PID=""
  fi
  if [[ -n "${SPECIALIST_GATE_PID:-}" ]]; then
    log "abnormal exit: terminating active specialist gate child (pid $SPECIALIST_GATE_PID)"
    gate_terminate_and_reap "$SPECIALIST_GATE_PID"
    SPECIALIST_GATE_PID=""
  fi
}

_gate_lifecycle_on_exit() {
  local status=$?
  trap - EXIT INT TERM
  cleanup_gate_children
  exit "$status"
}

_gate_lifecycle_on_signal() {
  local signum="$1"
  trap - EXIT INT TERM
  cleanup_gate_children
  exit $((128 + signum))
}

# Installed by run_review.sh after this module is sourced and before corpus.sh
# forks the gates. Separate from source time so tests can install it explicitly
# in the subshell that exercises the abnormal-exit path (bash resets caught
# traps in subshells).
install_gate_lifecycle_trap() {
  trap '_gate_lifecycle_on_exit' EXIT
  trap '_gate_lifecycle_on_signal 2' INT
  trap '_gate_lifecycle_on_signal 15' TERM
}
