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
# Requires env: GH_TOKEN, REPO, PR_NUMBER
# Args: $1 = resolved cleanup flag ("true"/"false")
cleanup_native_reviews() {
  local should_cleanup="$1"
  if [ "$should_cleanup" != "true" ]; then
    return 0
  fi

  echo "Cleaning up previous managed native reviews for #$PR_NUMBER"
  CURRENT_ACTOR="$(gh api user --jq .login 2>/dev/null || echo "")"
  if [ -n "$CURRENT_ACTOR" ]; then
    PREV_REVIEWS="$(gh api "repos/$REPO/pulls/$PR_NUMBER/reviews" --paginate --jq '.[] | select(.user.login == "'"$CURRENT_ACTOR"'" and (.body | contains("<!-- ai-pr-reviewer -->"))) | .id' 2>/dev/null || echo "")"
    if [ -n "$PREV_REVIEWS" ]; then
      while IFS= read -r REVIEW_ID; do
        if [ -z "$REVIEW_ID" ]; then continue; fi
        # Dismiss approval/request-changes reviews to stop stale verdicts from counting
        REVIEW_STATE="$(gh api "repos/$REPO/pulls/$PR_NUMBER/reviews/$REVIEW_ID" --jq '.state // ""' 2>/dev/null || echo "")"
        if [ "$REVIEW_STATE" = "APPROVED" ] || [ "$REVIEW_STATE" = "CHANGES_REQUESTED" ]; then
          if gh api "repos/$REPO/pulls/$PR_NUMBER/reviews/$REVIEW_ID/dismissals" --method PUT -f message="Superseded by a newer automated review for this pull request." --jq '.id' >/dev/null 2>&1; then
            echo "  Dismissed outdated managed review #$REVIEW_ID ($REVIEW_STATE)"
          else
            echo "  WARN: Could not dismiss review #$REVIEW_ID (may require additional permissions)" >&2
          fi
        fi
        # Update body to compact outdated stub (best-effort)
        OUTDATED_BODY="$(printf '<!-- ai-pr-reviewer -->\n_Outdated: superseded by a newer automated review._')"
        if ! gh api "repos/$REPO/pulls/$PR_NUMBER/reviews/$REVIEW_ID" --method PATCH -f body="$OUTDATED_BODY" >/dev/null 2>&1; then
          echo "  WARN: Could not update review #$REVIEW_ID body (submitted reviews may be read-only)" >&2
        else
          echo "  Marked review #$REVIEW_ID as outdated/superseded"
        fi
      done <<< "$PREV_REVIEWS"
    else
      echo "  No previous managed native reviews found for #$PR_NUMBER"
    fi
  else
    echo "  WARN: Could not determine current actor; skipping cleanup" >&2
  fi
}

# Build metadata marker JSON string.
# Requires env: HEAD_SHA, EFFECTIVE_SCOPE, REVIEW_RESULT
# Args: $1 = base_sha, $2 = previous_head_sha (optional, empty if not incremental)
# Outputs: metadata marker string to stdout
build_metadata_marker() {
  local base_sha="$1"
  local previous_head_sha="${2:-}"

  local marker="<!-- ai-pr-reviewer:{\"version\":1,\"head_sha\":\"${HEAD_SHA:-unknown}\",\"base_sha\":\"${base_sha}\",\"review_scope\":\"${EFFECTIVE_SCOPE}\",\"review_result\":\"${REVIEW_RESULT}\"} -->"
  if [ "$EFFECTIVE_SCOPE" = "incremental" ] && [ -n "$previous_head_sha" ]; then
    marker="${marker%,*},\"previous_head_sha\":\"${previous_head_sha}\"}"
  fi
  printf '%s' "$marker"
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
