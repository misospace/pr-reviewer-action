#!/usr/bin/env bash
set -euo pipefail

# Shared helpers for publish steps in action.yml.
# Source this script from each publish step, then call the functions.

# shellcheck source=scripts/platform_api.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/platform_api.sh"

# Sanitize model output: strip metadata markers and neutralize upstream references.
# Args: $1 = output file path
# Writes sanitized markdown to the output file using $REVIEW_MARKDOWN env var.
sanitize_review_markdown() {
  local output_file="$1"
  printf '%s\n' "$REVIEW_MARKDOWN" > "$output_file"
  python3 "${GITHUB_ACTION_PATH}/scripts/strip_metadata_markers.py" "$output_file"
  # UPSTREAM_LINK_MODE (#561): "inert" (default) rewrites upstream
  # PR/issue/commit/compare URLs to plain text; "togithub" rewrites them to
  # https://togithub.com/... so they stay clickable without notification or
  # auto-link noise.
  UPSTREAM_LINK_MODE="${UPSTREAM_LINK_MODE:-inert}" \
    python3 "${GITHUB_ACTION_PATH}/scripts/sanitize_review_markdown.py" "$output_file"

  # Deterministic backstop for #415: even with a clean, header-free corpus the
  # model confabulates "## Linked Issue Fit" / "## Evidence Provider Findings" /
  # "## Standards Compliance" / "## Tool Harness Findings" sections padded with
  # "nothing was found" filler.
  # Presence mirrors the exact [ -s file ] gates scripts/sections/corpus.sh uses
  # to emit (or omit) those section headers, so this only ever strips sections
  # the corpus never offered. corpus.sh writes standards-present.txt on both
  # paths (resolved path, or truncated), so its absence means the corpus was
  # never built — in which case there is no review markdown to strip either.
  local linked_present=false evidence_present=false standards_present=false
  local tool_harness_present=false
  if [ -s linked-issues.md ]; then linked_present=true; fi
  if [ -s evidence-providers.md ]; then evidence_present=true; fi
  if [ -s standards-present.txt ]; then standards_present=true; fi
  if [ -s tool-harness.md ]; then tool_harness_present=true; fi
  LINKED_ISSUE_PRESENT="$linked_present" \
  EVIDENCE_PROVIDER_PRESENT="$evidence_present" \
  STANDARDS_PRESENT="$standards_present" \
  TOOL_HARNESS_PRESENT="$tool_harness_present" \
    python3 "${GITHUB_ACTION_PATH}/scripts/strip_empty_conditional_sections.py" "$output_file"
}

# Resolve cleanup flag based on input value and publish mode.
# Args: $1 = CLEANUP_PREVIOUS_NATIVE_REVIEWS input, $2 = PUBLISH_MODE
# Outputs: "true" or "false" to stdout
resolve_cleanup_flag() {
  local cleanup_input="$1"
  local publish_mode="$2"
  local result=false

  case "$(printf '%s' "$cleanup_input" | tr '[:upper:]' '[:lower:]')" in
    true) result=true ;;
    false) result=false ;;
    auto|"")
      if [ "$publish_mode" = "review_comment" ] || [ "$publish_mode" = "review_verdict" ]; then
        result=true
      else
        result=false
      fi
      ;;
    *) echo "Invalid cleanup_previous_native_reviews value; expected auto, true, or false" >&2; return 1 ;;
  esac

  printf '%s' "$result"
}

# Cleanup previous managed native reviews.
# Requires env: GH_TOKEN, REPO, PR_NUMBER; optional COMMENT_MARKER.
# Args: $1 = resolved cleanup flag ("true"/"false")
#
# Managed reviews are matched by the marker their bodies START with, never by
# author. Author matching via `gh api user` was structurally broken: /user
# returns 403 for installation tokens (both the default GITHUB_TOKEN and
# GitHub App tokens), and on HTTP errors gh prints the JSON error body to
# stdout — so the "actor" became a JSON blob that matched no review and
# cleanup silently did nothing on every run (#190). Marker matching is safe
# because cleanup runs before the new review is posted, so it can never touch
# the review the current run is about to create, and it keeps working when
# the workflow's token identity changes (e.g. default token → app token).
cleanup_native_reviews() {
  local should_cleanup="$1"
  if [ "$should_cleanup" != "true" ]; then
    return 0
  fi

  echo "Cleaning up previous managed native reviews for #$PR_NUMBER"
  local reviews_json
  if ! reviews_json="$(platform_pr_reviews "$REPO" "$PR_NUMBER" paginate 2>/dev/null)"; then
    echo "  WARN: Could not list reviews for #$PR_NUMBER; skipping cleanup" >&2
    return 0
  fi

  # Minimized state lives only in GraphQL (the REST review list does not
  # expose it); one query maps databaseId → isMinimized for skip logic. On
  # failure the map is empty and minimization is simply retried (idempotent).
  # On Forgejo, GraphQL is unavailable so the query is skipped.
  local minimized_ids
  local _platform
  _platform="$(platform_resolve)"
  if [ "$_platform" = "github" ]; then
    minimized_ids="$(platform_graphql \
      -f query='query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviews(first: 100) { nodes { databaseId isMinimized } } } } }' \
      -f owner="${REPO%%/*}" -f name="${REPO#*/}" -F number="$PR_NUMBER" \
      --jq '[.data.repository.pullRequest.reviews.nodes[] | select(.isMinimized) | .databaseId]' 2>/dev/null || echo '[]')"
  else
    echo "  NOTE: Skipping GraphQL minimized-state query (platform=$_platform; no GraphQL API)" >&2
    minimized_ids='[]'
  fi
  printf '%s' "$minimized_ids" | jq -e 'type == "array"' >/dev/null 2>&1 || minimized_ids='[]'

  # Managed bodies start with the configured marker (or, for reviews created
  # by older action versions, the bare/JSON "<!-- ai-pr-reviewer" prefix).
  # Review CONTENT is never modified — the review is hidden, not rewritten —
  # so a human expanding an outdated review still sees what it said.
  # Already-minimized reviews are skipped unless they still carry a live
  # verdict (a previous run may have minimized but failed the dismissal).
  # The list query carries id and state together so no per-review GET is
  # needed afterwards.
  PREV_REVIEWS="$(printf '%s' "$reviews_json" \
    | jq -r --arg marker "${COMMENT_MARKER:-<!-- ai-pr-reviewer -->}" \
        --argjson minimized "$minimized_ids" \
        '.[] | select(((.body // "") | startswith($marker))
                   or ((.body // "") | startswith("<!-- ai-pr-reviewer")))
             | select(((.state // "") == "APPROVED" or (.state // "") == "CHANGES_REQUESTED")
                   or ((.id as $i | $minimized | index($i)) == null))
             | "\(.id)\t\(.node_id // "")\t\(.state // "")\t\(if (.id as $i | $minimized | index($i)) != null then "minimized" else "" end)"' 2>/dev/null || echo "")"
  if [ -n "$PREV_REVIEWS" ]; then
    while IFS=$'\t' read -r REVIEW_ID REVIEW_NODE_ID REVIEW_STATE REVIEW_MINIMIZED; do
      if [ -z "$REVIEW_ID" ]; then continue; fi
      # Dismiss approval/request-changes reviews to stop stale verdicts from counting
      if [ "$REVIEW_STATE" = "APPROVED" ] || [ "$REVIEW_STATE" = "CHANGES_REQUESTED" ]; then
        if platform_review_dismiss "$REPO" "$PR_NUMBER" "$REVIEW_ID" "Superseded by a newer automated review for this pull request." >/dev/null 2>&1; then
          echo "  Dismissed outdated managed review #$REVIEW_ID ($REVIEW_STATE)"
        else
          echo "  WARN: Could not dismiss review #$REVIEW_ID (may require additional permissions)" >&2
        fi
      fi
      # Hide the review in the PR timeline. Dismissal only strikes the verdict;
      # the full review text stays expanded without this. PullRequestReview
      # implements GraphQL's Minimizable, the same mechanism as the UI's
      # "Hide" menu. Not available on Forgejo (no GraphQL API).
      if [ -n "$REVIEW_NODE_ID" ] && [ "$REVIEW_MINIMIZED" != "minimized" ]; then
        if platform_graphql \
            -f query='mutation($id: ID!) { minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) { minimizedComment { isMinimized } } }' \
            -f id="$REVIEW_NODE_ID" >/dev/null 2>&1; then
          echo "  Minimized (hidden as outdated) review #$REVIEW_ID"
        elif [ "$_platform" = "forgejo" ]; then
          echo "  NOTE: Skipping minimizeComment for review #$REVIEW_ID (platform=$_platform; no GraphQL API)" >&2
        else
          echo "  WARN: Could not minimize review #$REVIEW_ID (may require additional permissions)" >&2
        fi
      fi
    done <<< "$PREV_REVIEWS"
  else
    echo "  No previous managed native reviews to clean up for #$PR_NUMBER"
  fi
}

# Build metadata marker JSON string.
# Requires env: HEAD_SHA, REVIEW_RESULT
# Args: $1 = base_sha
# Outputs: metadata marker string to stdout
build_metadata_marker() {
  local base_sha="$1"

  # Built with jq to keep the marker a single declarative expression.
  local marker_json
  marker_json="$(jq -nc \
    --arg head "${HEAD_SHA:-unknown}" \
    --arg base "$base_sha" \
    --arg result "${REVIEW_RESULT}" \
    --arg checks "${REQUIRED_CHECKS:-}" \
    --arg route "${REVIEW_ROUTE:-}" \
    --arg esc "${ESCALATION_REASON:-}" \
    --arg chr "${CACHE_HIT_RATIO:-}" \
    '{version: 1, head_sha: $head, base_sha: $base, review_result: $result}
      + (if $checks == "" or $checks == "none" then {} else {required_checks: $checks} end)
      + (if $route == "" or $route == "legacy" then {} else {review_route: $route} end)
      + (if $esc == "" then {} else {escalation_reason: ($esc | split(","))} end)
      + (if $chr != "" and $chr != "-" then {cache_hit_ratio: ($chr | tonumber)} else {} end)')"
  printf '<!-- ai-pr-reviewer:%s -->' "$marker_json"
}

# Emit the managed review-comment marker preamble to stdout: the sticky
# comment marker, the metadata marker, and (when set) the head-sha and
# fingerprint markers. Centralizes the strip-then-append discipline so a
# publish step cannot silently drop the markers that skip-on-unchanged
# (check_review_needed.sh) and managed-comment cleanup depend on. The two
# required markers are guarded so a future refactor that forgets to set them
# fails loudly under `set -e` rather than publishing an unmatchable comment.
# Reads env/globals: COMMENT_MARKER, METADATA_MARKER, HEAD_SHA (optional),
# BROAD_FINGERPRINT (optional).
emit_review_markers() {
  : "${COMMENT_MARKER:?emit_review_markers: COMMENT_MARKER must be set}"
  : "${METADATA_MARKER:?emit_review_markers: METADATA_MARKER must be set}"
  echo "$COMMENT_MARKER"
  echo "$METADATA_MARKER"
  if [ -n "${HEAD_SHA:-}" ]; then
    # The value is the PR head SHA (a git commit hash), not a fingerprint.
    echo "<!-- ai-pr-review-sha:${HEAD_SHA} -->"
  fi
  if [ -n "${BROAD_FINGERPRINT:-}" ]; then
    echo "<!-- ai-pr-review-fingerprint:${BROAD_FINGERPRINT} -->"
  fi
}

# Validate that PR_NUMBER is set.
# Requires env: PR_NUMBER
# Args: $1 = mode description for error message
validate_pr_number() {
  local mode_desc="$1"
  if [ -z "${PR_NUMBER:-}" ]; then
    echo "publish_${mode_desc} requires a pull_request event or explicit pr_number" >&2
    exit 1
  fi
}
