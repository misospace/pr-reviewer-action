#!/usr/bin/env bash
set -euo pipefail

# ── wait_for_ci.sh ──────────────────────────────────────────────────────
# Polls GitHub's Checks API (primary signal) and the legacy commit-status
# API (supplementary) until every external check is final, a failure is
# detected, or the timeout expires.
#
# Two pitfalls this is built around:
#   1. Repos that only use GitHub Actions never produce legacy commit
#      statuses, so the combined-status state stays "pending" forever. The
#      combined state therefore only counts when total_count > 0.
#   2. The job running this action is itself a check run and would always be
#      "in_progress". Every job belonging to the current workflow run is
#      excluded via GITHUB_RUN_ID (check run detail/html URLs carry
#      /runs/<run_id>/).
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

# Render the per-check results gathered this iteration into CI_CHECKS_FILE so
# run_review.sh can surface them as review evidence. Own-workflow check runs are
# excluded with the same rule used for gating. A no-op when CI_CHECKS_FILE is
# unset or no external checks exist.
render_ci_checks() {
  local final_state="$1"
  [[ -n "$CI_CHECKS_FILE" ]] || return 0
  local runs="${check_runs_response:-{}}"
  local combined="${combined_response:-{}}"

  local rows
  rows="$(printf '%s' "$runs" | jq -r --arg run "$GITHUB_RUN_ID" '
    [.check_runs[]?
      | select(
          $run == ""
          or ((((.details_url // "") | test("/runs/" + $run + "(/|$)"))
               or ((.html_url // "") | test("/runs/" + $run + "(/|$)"))) | not)
        )] as $ext
    | $ext[]
    | "| \(.name // "(unnamed)") | \(.status // "?") | \(.conclusion // "—") |"' 2>/dev/null || echo "")"

  local legacy
  # On Forgejo: exclude our own status context by name.
  legacy="$(printf '%s' "$combined" | jq -r --arg ctx "$CI_STATUS_CONTEXT" '
    if ((.total_count // 0) > 0) then
      (.statuses[]?
        | select(.context != $ctx)
        | "| \(.context // "(status)") | \(.state // "?") | \(.description // "") |")
    else empty end' 2>/dev/null || echo "")"

  # Nothing external to report — leave no file so run_review omits the section.
  [[ -n "$rows" || -n "$legacy" ]] || return 0

  {
    echo "_CI reached a terminal state before this review began (overall: ${final_state}). These results are from the CI status API for commit ${sha} and are authoritative evidence of which checks ran and how they concluded._"
    echo
    if [[ -n "$rows" ]]; then
      echo "| Check | Status | Conclusion |"
      echo "| --- | --- | --- |"
      printf '%s\n' "$rows"
    fi
    if [[ -n "$legacy" ]]; then
      echo
      echo "Commit statuses:"
      echo
      echo "| Context | State | Description |"
      echo "| --- | --- | --- |"
      printf '%s\n' "$legacy"
    fi
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

  check_runs_response="$(platform_check_runs "$REPO" "$sha" 2>/dev/null || echo "")"
  combined_response="$(platform_commit_status "$REPO" "$sha" 2>/dev/null || echo "")"

  if [[ -z "$check_runs_response" && -z "$combined_response" ]]; then
    log "API returned empty; retrying in ${CI_INTERVAL_SEC}s..."
    sleep "$CI_INTERVAL_SEC"
    elapsed=$((elapsed + CI_INTERVAL_SEC))
    continue
  fi
  [[ -n "$check_runs_response" ]] || check_runs_response='{}'
  [[ -n "$combined_response" ]] || combined_response='{}'

  # Summarize external check runs, excluding every job of our own workflow
  # run. Conclusions that mean "CI did not pass or did not run" (failure,
  # timed_out, cancelled, action_required) all count as failed.
  summary="$(printf '%s' "$check_runs_response" | jq -c --arg run "$GITHUB_RUN_ID" '
    ([.check_runs[]?
      | select(
          $run == ""
          or ((((.details_url // "") | test("/runs/" + $run + "(/|$)"))
               or ((.html_url // "") | test("/runs/" + $run + "(/|$)"))) | not)
        )]) as $ext
    | {
        total: ($ext | length),
        pending: ([$ext[] | select(.status != "completed")] | length),
        failed: ([$ext[] | select(.status == "completed"
                  and ((.conclusion // "") as $c
                       | ($c == "failure" or $c == "timed_out"
                          or $c == "cancelled" or $c == "action_required")))] | length)
      }' 2>/dev/null || echo '{"total":0,"pending":0,"failed":0}')"
  total_checks="$(printf '%s' "$summary" | jq -r '.total' 2>/dev/null || echo 0)"
  pending_checks="$(printf '%s' "$summary" | jq -r '.pending' 2>/dev/null || echo 0)"
  failed_checks="$(printf '%s' "$summary" | jq -r '.failed' 2>/dev/null || echo 0)"

  combined_state="$(printf '%s' "$combined_response" | jq -r '.state // "pending"' 2>/dev/null || echo "pending")"
  combined_total="$(printf '%s' "$combined_response" | jq -r '.total_count // 0' 2>/dev/null || echo 0)"

  # Summarize external commit statuses, excluding our own context. This is
  # essential on Forgejo where check-runs are empty and the combined state
  # includes our own (always-pending) status. On GitHub it refines the
  # supplementary signal in the same way.
  status_summary="$(printf '%s' "$combined_response" | jq -c --arg ctx "$CI_STATUS_CONTEXT" '
    ([.statuses[]? | select(.context != $ctx)]) as $ext
    | {
        total: ($ext | length),
        pending: ([$ext[] | select(.state != "success" and .state != "failure" and .state != "error")] | length),
        failed: ([$ext[] | select(.state == "failure" or .state == "error")] | length)
      }' 2>/dev/null || echo '{"total":0,"pending":0,"failed":0}')"
  ext_status_total="$(printf '%s' "$status_summary" | jq -r '.total' 2>/dev/null || echo 0)"
  ext_status_pending="$(printf '%s' "$status_summary" | jq -r '.pending' 2>/dev/null || echo 0)"
  ext_status_failed="$(printf '%s' "$status_summary" | jq -r '.failed' 2>/dev/null || echo 0)"

  # Failure is terminal as soon as either signal reports it.
  if [[ "$failed_checks" -gt 0 ]]; then
    log "Detected $failed_checks failed check run(s) — treating as failure"
    finalize "failure"
  fi
  # Use external status count for failure detection so our own pending
  # context on Forgejo doesn't mask an external failure.
  if [[ "$ext_status_failed" -gt 0 ]]; then
    log "Detected $ext_status_failed failed commit status(es) — treating as failure"
    finalize "failure"
  fi
  if [[ "$combined_total" -gt 0 && ( "$combined_state" == "failure" || "$combined_state" == "error" ) ]]; then
    log "Combined commit status reports $combined_state"
    finalize "failure"
  fi

  # No external CI at all (no check runs, no external commit statuses).
  # On Forgejo: ext_status_total=0 means our own context is the only status;
  # combined_state stays "pending" but there's nothing external to wait for.
  # However, if combined_total>0 with a terminal state, use that signal.
  if [[ "$total_checks" -eq 0 && "$ext_status_total" -eq 0 ]] && \
     { [[ "$combined_total" -eq 0 ]] || [[ "$combined_state" == "pending" ]]; }; then
    if [[ "$elapsed" -ge $(( CI_INTERVAL_SEC * 2 )) ]]; then
      log "No external CI checks found after ${elapsed}s — proceeding without CI gating"
      finalize "none"
    fi
    log "No external CI checks registered yet — waiting ${CI_INTERVAL_SEC}s..."
    sleep "$CI_INTERVAL_SEC"
    elapsed=$((elapsed + CI_INTERVAL_SEC))
    continue
  fi

  # All external signals are final (no pending check runs, no pending
  # external commit statuses). Use ext_status_pending so our own pending
  # context on Forgejo doesn't block completion.
  # When individual statuses aren't available (ext_status_total=0 but
  # combined_total>0), fall back to the aggregate combined_state.
  if [[ "$pending_checks" -eq 0 ]] && \
     { [[ "$ext_status_pending" -eq 0 ]] || \
       [[ "$ext_status_total" -eq 0 && "$combined_state" == "success" ]]; }; then
    log "CI checks finalized: success (${total_checks} external check run(s), ${ext_status_total}+${combined_total} status(es))"
    finalize "success"
  else
    log "Pending: ${pending_checks}/${total_checks} external check(s), ${ext_status_pending}/${ext_status_total} external status(es) — waiting ${CI_INTERVAL_SEC}s..."
  fi

  sleep "$CI_INTERVAL_SEC"
  elapsed=$((elapsed + CI_INTERVAL_SEC))
done
