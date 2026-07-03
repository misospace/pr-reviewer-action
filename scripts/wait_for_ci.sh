#!/usr/bin/env bash
set -euo pipefail

# ── wait_for_ci.sh ──────────────────────────────────────────────────────
# Polls CI state until every external check is final, a failure is detected,
# or the timeout expires.
#
# The platform seam (platform_external_checks in platform_api.sh) does all the
# normalization: it merges GitHub's check-runs with the combined commit-status
# object into ONE list of external checks [{name, state}] (state ∈
# pending|success|failure) and applies self-exclusion there. This loop is then
# a pure reducer over that list: any failure → failure; any pending → wait;
# empty → no external CI; all success → success.
#
# Two pitfalls the seam is built around (documented here for context):
#   1. Repos that only use GitHub Actions never produce legacy commit
#      statuses. The seam drops the combined aggregate unless it is terminal
#      over total_count > 0 statuses, so an always-"pending" combined state
#      does not masquerade as an external check to wait on.
#   2. The job running this action is itself a check run and would always be
#      "in_progress". Every job belonging to the current workflow run is
#      excluded via GITHUB_RUN_ID (check run detail/html URLs carry
#      /runs/<run_id>/); our own commit-status context is excluded by name
#      (CI_STATUS_CONTEXT). Both exclusions happen once, inside the seam.
#
# Exit codes:
#   0 – All external checks reached a terminal state (success/failure/none).
#   1 – Timeout reached and ci_skip_on_timeout=true (review may proceed anyway).
#   2 – Fatal error (no token, repo/PR unresolvable) or timeout with
#       ci_skip_on_timeout=false.

GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
# shellcheck source=scripts/platform_api.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/platform_api.sh"
PR_NUMBER="${PR_NUMBER:-}"
PR_HEAD_SHA="${PR_HEAD_SHA:-}"
GITHUB_RUN_ID="${GITHUB_RUN_ID:-}"
# On Forgejo, exclude our own commit status by context name instead of run ID.
CI_STATUS_CONTEXT="${CI_STATUS_CONTEXT:-pr-reviewer-action}"
CI_STATUS_CHECK="${CI_STATUS_CHECK:-false}"
CI_TIMEOUT_SEC="${CI_TIMEOUT_SEC:-300}"
CI_INTERVAL_SEC="${CI_INTERVAL_SEC:-15}"
CI_SKIP_ON_TIMEOUT="${CI_SKIP_ON_TIMEOUT:-true}"
OUTPUT_FILE="${GITHUB_OUTPUT:-/dev/null}"
# When set, render a per-check markdown summary here for run_review.sh to fold
# into the review corpus. The data is already fetched for gating; this just
# stops it from being discarded so the model can cite real CI outcomes.
CI_CHECKS_FILE="${CI_CHECKS_FILE:-}"

if [[ "$CI_STATUS_CHECK" != "true" ]]; then
  echo "ci_status_skipped=true" >> "$OUTPUT_FILE"
  exit 0
fi

if [[ -z "$GH_TOKEN" || -z "$REPO" || -z "$PR_NUMBER" ]]; then
  echo "Missing GH_TOKEN, REPO, or PR_NUMBER for CI status check" >&2
  echo "ci_status_skipped=true" >> "$OUTPUT_FILE"
  exit 0
fi

# ── Helpers ─────────────────────────────────────────────────────────────

log() {
  echo "[CI-status] $(date +'%H:%M:%S') $1"
}

error() {
  log "ERROR: $1" >&2
}

# Get the head SHA of the PR (may differ from event.pull_request.head.sha if
# the action is invoked manually with a stale pr_number).
get_head_sha() {
  platform_pr_head_sha "$REPO" "$PR_NUMBER" 2>/dev/null
}

# Render the normalized external checks gathered this iteration into
# CI_CHECKS_FILE so run_review.sh can surface them as review evidence. The list
# already has self-exclusion applied (see platform_external_checks). A no-op
# when CI_CHECKS_FILE is unset or no external checks exist.
render_ci_checks() {
  local final_state="$1"
  [[ -n "$CI_CHECKS_FILE" ]] || return 0
  local checks="${ci_checks_json:-[]}"

  local rows
  rows="$(printf '%s' "$checks" | jq -r '.[] | "| \(.name) | \(.state) |"' 2>/dev/null || echo "")"

  # Nothing external to report — leave no file so run_review omits the section.
  [[ -n "$rows" ]] || return 0

  {
    echo "_CI reached a terminal state before this review began (overall: ${final_state}). These results are from the CI status API for commit ${sha} and are authoritative evidence of which checks ran and how they concluded._"
    echo
    echo "| Check | State |"
    echo "| --- | --- |"
    printf '%s\n' "$rows"
  } > "$CI_CHECKS_FILE" 2>/dev/null || true
}

finalize() {
  local state="$1"
  render_ci_checks "$state"
  echo "ci_status_final=$state" >> "$OUTPUT_FILE"
  echo "ci_status_skipped=false" >> "$OUTPUT_FILE"
  exit 0
}

# ── Main loop ───────────────────────────────────────────────────────────

# The precheck step already fetched the PR object; reuse its head SHA when
# forwarded instead of re-fetching.
sha="$PR_HEAD_SHA"
if [[ -z "$sha" ]]; then
  sha="$(get_head_sha)"
fi
if [[ -z "$sha" ]]; then
  error "Could not resolve head SHA for #$PR_NUMBER"
  exit 2
fi

log "Polling CI checks for $sha (timeout=${CI_TIMEOUT_SEC}s, interval=${CI_INTERVAL_SEC}s, own run=${GITHUB_RUN_ID:-none})..."

elapsed=0
while true; do
  if [[ "$elapsed" -ge "$CI_TIMEOUT_SEC" ]]; then
    log "Timeout reached after ${elapsed}s"
    if [[ "$(printf '%s' "$CI_SKIP_ON_TIMEOUT" | tr '[:upper:]' '[:lower:]')" == "true" ]]; then
      log "ci_skip_on_timeout=true — proceeding without CI context"
      render_ci_checks "timeout (CI did not finish in time)"
      echo "ci_status_skipped=true" >> "$OUTPUT_FILE"
      exit 1   # non-zero so the caller can decide whether to skip or continue
    else
      error "Timeout reached and ci_skip_on_timeout=false — aborting review"
      echo "ci_status_skipped=true" >> "$OUTPUT_FILE"
      exit 2
    fi
  fi

  # One normalization seam merges check-runs + commit statuses into a single
  # list of EXTERNAL checks [{name, state}] (state ∈ pending|success|failure),
  # with self-exclusion (GITHUB_RUN_ID + CI_STATUS_CONTEXT) already applied.
  # Empty stdout means both underlying APIs came back empty — a transient
  # failure worth retrying; an empty JSON array means "no external CI".
  ci_checks_json="$(platform_external_checks "$REPO" "$sha" 2>/dev/null || echo "")"

  if [[ -z "$ci_checks_json" ]]; then
    log "API returned empty; retrying in ${CI_INTERVAL_SEC}s..."
    sleep "$CI_INTERVAL_SEC"
    elapsed=$((elapsed + CI_INTERVAL_SEC))
    continue
  fi

  total_checks="$(printf '%s' "$ci_checks_json" | jq -r 'length' 2>/dev/null || echo 0)"
  pending_checks="$(printf '%s' "$ci_checks_json" | jq -r '[.[] | select(.state == "pending")] | length' 2>/dev/null || echo 0)"
  failed_checks="$(printf '%s' "$ci_checks_json" | jq -r '[.[] | select(.state == "failure")] | length' 2>/dev/null || echo 0)"

  # Any failure is terminal.
  if [[ "$failed_checks" -gt 0 ]]; then
    log "Detected $failed_checks failed check(s) — treating as failure"
    finalize "failure"
  fi

  # No external CI at all: the merged list is empty (own workflow run / own
  # status context were the only signals, or nothing has registered yet).
  if [[ "$total_checks" -eq 0 ]]; then
    if [[ "$elapsed" -ge $(( CI_INTERVAL_SEC * 2 )) ]]; then
      log "No external CI checks found after ${elapsed}s — proceeding without CI gating"
      finalize "none"
    fi
    log "No external CI checks registered yet — waiting ${CI_INTERVAL_SEC}s..."
    sleep "$CI_INTERVAL_SEC"
    elapsed=$((elapsed + CI_INTERVAL_SEC))
    continue
  fi

  # Every external check is final (none pending).
  if [[ "$pending_checks" -eq 0 ]]; then
    log "CI checks finalized: success (${total_checks} external check(s))"
    finalize "success"
  else
    log "Pending: ${pending_checks}/${total_checks} external check(s) — waiting ${CI_INTERVAL_SEC}s..."
  fi

  sleep "$CI_INTERVAL_SEC"
  elapsed=$((elapsed + CI_INTERVAL_SEC))
done
