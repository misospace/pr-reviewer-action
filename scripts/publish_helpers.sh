#!/usr/bin/env bash
set -euo pipefail

# Shared helpers for publish steps in action.yml.
# Source this script from each publish step, then call the functions.

# Sanitize model output: strip metadata markers and neutralize upstream references.
# Args: $1 = output file path
# Writes sanitized markdown to the output file using $REVIEW_MARKDOWN env var.
sanitize_review_markdown() {
  local output_file="$1"
  printf '%s\n' "$REVIEW_MARKDOWN" > "$output_file"
  python3 "${GITHUB_ACTION_PATH}/scripts/strip_metadata_markers.py" "$output_file"
  python3 "${GITHUB_ACTION_PATH}/scripts/sanitize_review_markdown.py" "$output_file"
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
  if ! reviews_json="$(gh api "repos/$REPO/pulls/$PR_NUMBER/reviews" --paginate 2>/dev/null)"; then
    echo "  WARN: Could not list reviews for #$PR_NUMBER; skipping cleanup" >&2
    return 0
  fi

  # Minimized state lives only in GraphQL (the REST review list does not
  # expose it); one query maps databaseId → isMinimized for skip logic. On
  # failure the map is empty and minimization is simply retried (idempotent).
  local minimized_ids
  minimized_ids="$(gh api graphql \
    -f query='query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviews(first: 100) { nodes { databaseId isMinimized } } } } }' \
    -f owner="${REPO%%/*}" -f name="${REPO#*/}" -F number="$PR_NUMBER" \
    --jq '[.data.repository.pullRequest.reviews.nodes[] | select(.isMinimized) | .databaseId]' 2>/dev/null || echo '[]')"
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
        if gh api "repos/$REPO/pulls/$PR_NUMBER/reviews/$REVIEW_ID/dismissals" --method PUT -f message="Superseded by a newer automated review for this pull request." --jq '.id' >/dev/null 2>&1; then
          echo "  Dismissed outdated managed review #$REVIEW_ID ($REVIEW_STATE)"
        else
          echo "  WARN: Could not dismiss review #$REVIEW_ID (may require additional permissions)" >&2
        fi
      fi
      # Hide the review in the PR timeline. Dismissal only strikes the verdict;
      # the full review text stays expanded without this. PullRequestReview
      # implements GraphQL's Minimizable, the same mechanism as the UI's
      # "Hide" menu.
      if [ -n "$REVIEW_NODE_ID" ] && [ "$REVIEW_MINIMIZED" != "minimized" ]; then
        if gh api graphql \
            -f query='mutation($id: ID!) { minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) { minimizedComment { isMinimized } } }' \
            -f id="$REVIEW_NODE_ID" >/dev/null 2>&1; then
          echo "  Minimized (hidden as outdated) review #$REVIEW_ID"
        else
          echo "  WARN: Could not minimize review #$REVIEW_ID (may require additional permissions)" >&2
        fi
      fi
    done <<< "$PREV_REVIEWS"
  else
    echo "  No previous managed native reviews to clean up for #$PR_NUMBER"
  fi
}

# Resolve inline finding threads for carried findings this run verified as
# fixed (#208). Requires env: GH_TOKEN, REPO, PR_NUMBER, GITHUB_ACTION_PATH;
# optional FINDINGS, INLINE_FINDINGS. Best-effort: never fails the publish —
# the python script exits 0 on API errors and this wrapper swallows the rest.
# Gated on inline_findings because without it no marker-bearing threads can
# exist, and on a non-empty previous-findings.json because resolution only
# makes sense when this run carried findings forward.
resolve_finding_threads() {
  if [ "$(printf '%s' "${INLINE_FINDINGS:-false}" | tr '[:upper:]' '[:lower:]')" != "true" ]; then
    return 0
  fi
  if [ ! -s previous-findings.json ]; then
    return 0
  fi
  printf '%s' "${FINDINGS:-[]}" > resolve-findings.json
  if ! python3 "${GITHUB_ACTION_PATH}/scripts/resolve_finding_threads.py" previous-findings.json resolve-findings.json; then
    echo "  WARN: finding-thread resolution failed; continuing" >&2
  fi
  return 0
}

# Build metadata marker JSON string.
# Requires env: HEAD_SHA, EFFECTIVE_SCOPE, REVIEW_RESULT; optional FINDINGS
# (JSON array — persisted as open_findings when the review found issues, so
# the next incremental review can carry them forward, #193).
# Args: $1 = base_sha, $2 = previous_head_sha (optional, empty if not incremental)
# Outputs: metadata marker string to stdout
build_metadata_marker() {
  local base_sha="$1"
  local previous_head_sha="${2:-}"

  # FINDINGS comes from the review step output; tolerate anything malformed.
  local findings_json="${FINDINGS:-[]}"
  if ! printf '%s' "$findings_json" | jq -e 'type == "array"' >/dev/null 2>&1; then
    findings_json="[]"
  fi

  # Built with jq instead of string surgery: the old "${marker%,*}" trick for
  # appending previous_head_sha cut at the LAST comma, silently dropping
  # review_result and the closing " -->" — which made incremental markers
  # unparseable and degraded the next run back to a full review.
  local marker_json
  marker_json="$(jq -nc \
    --arg head "${HEAD_SHA:-unknown}" \
    --arg base "$base_sha" \
    --arg scope "${EFFECTIVE_SCOPE}" \
    --arg result "${REVIEW_RESULT}" \
    --arg checks "${REQUIRED_CHECKS:-}" \
    --arg route "${REVIEW_ROUTE:-}" \
    --arg esc "${ESCALATION_REASON:-}" \
    --arg prev "$previous_head_sha" \
    --argjson findings "$findings_json" \
    '{version: 1, head_sha: $head, base_sha: $base, review_scope: $scope, review_result: $result}
     + (if $checks == "" or $checks == "none" then {} else {required_checks: $checks} end)
     + (if $route == "" or $route == "legacy" then {} else {review_route: $route} end)
     + (if $esc == "" then {} else {escalation_reason: ($esc | split(","))} end)
     + (if $scope == "incremental" and $prev != "" then {previous_head_sha: $prev} else {} end)
     + (if $result == "issues" and ($findings | length) > 0
        then {open_findings: ($findings
          | map(select(type == "object" and (.resolution // "") != "resolved")
              | {severity, category, file, line, message: ((.message // "") | tostring | .[0:200])})
          | .[0:20])}
        else {} end)')"
  printf '<!-- ai-pr-reviewer:%s -->' "$marker_json"
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
