#!/usr/bin/env bash
set -euo pipefail

# Publish dispatcher for the "Publish review" step in action.yml (#541).
#
# Extracted verbatim from the step's inline `run:` block so the gnarly
# case-dispatch shell is shellcheck-sourceable and unit-testable (mirrors the
# #307 split of run_review.sh into scripts/sections/). The step now just runs
# this script; all per-mode env is still exported by the step's superset env
# block, so behaviour is unchanged.
#
# Requires env (exported by the Publish step): GITHUB_ACTION_PATH, PUBLISH_MODE,
# HEAD_SHA, REPO, PR_NUMBER, VERDICT, REVIEW_MARKDOWN, ANALYSIS_ENGINE,
# EFFECTIVE_SCOPE, BASE_SHA, PREVIOUS_HEAD_SHA, COMMENT_MARKER, and the
# per-mode keys (ALLOW_APPROVE, APPROVE_FORKS, IS_FORK_PR, BASELINE_CLEAN,
# INLINE_FINDINGS, INLINE_FINDINGS_MAX, FINDINGS, CLEANUP_PREVIOUS_NATIVE_REVIEWS).

# shellcheck source=scripts/publish_helpers.sh
source "${GITHUB_ACTION_PATH}/scripts/publish_helpers.sh"

# The model can run for minutes. Re-check at the publication boundary
# (issue #451) so no comment, blocking review, or approval can land
# against a head the model never saw.
set +e
EXPECTED_HEAD_SHA="$HEAD_SHA" bash "${GITHUB_ACTION_PATH}/scripts/verify_pr_head.sh"
VERIFY_RC=$?
set -e
case "$VERIFY_RC" in
  0) ;;
  3)
    echo "::notice title=AI review not published::A newer push superseded the commit reviewed by this run."
    exit 0
    ;;
  *) exit "$VERIFY_RC" ;;
esac

case "$PUBLISH_MODE" in
  comment)
    # Sanitize model output
    sanitize_review_markdown "review-markdown.raw.md"

    # Validate PR number
    validate_pr_number "review_comment"

    # Resolve review result
    REVIEW_RESULT="clean"
    if [ "$VERDICT" = "request_changes" ]; then
      REVIEW_RESULT="issues"
    fi

    # Build metadata marker
    METADATA_MARKER="$(build_metadata_marker "$BASE_SHA" "$PREVIOUS_HEAD_SHA")"

    if [ "$VERDICT" = "request_changes" ]; then
      VERDICT_PREFIX="⚠️ **Automated recommendation: REQUEST CHANGES**"
    else
      VERDICT_PREFIX="✅ **Automated recommendation: APPROVE**"
    fi
    if [ "$EFFECTIVE_SCOPE" = "incremental" ]; then
      VERDICT_PREFIX="$VERDICT_PREFIX (incremental)"
    fi

    {
      emit_review_markers
      echo "$VERDICT_PREFIX"
      echo
      printf '_Analysis engine: %s_\n' "$ANALYSIS_ENGINE"
      echo
      cat review-markdown.raw.md
    } > review-comment.md

    platform_comment_sticky "$REPO" "$PR_NUMBER" review-comment.md
    ;;

  review_comment)
    # Sanitize model output
    sanitize_review_markdown "review-comment-markdown.raw.md"

    # Validate PR number
    validate_pr_number "mode=review_comment"

    # Resolve cleanup flag and execute cleanup
    CLEANUP_NATIVE_REVIEWS="$(resolve_cleanup_flag "${CLEANUP_PREVIOUS_NATIVE_REVIEWS:-auto}" "review_comment")"
    cleanup_native_reviews "$CLEANUP_NATIVE_REVIEWS"

    # Resolve review result
    REVIEW_RESULT="clean"
    if [ "$VERDICT" = "request_changes" ]; then
      REVIEW_RESULT="issues"
    fi

    # Build metadata marker
    METADATA_MARKER="$(build_metadata_marker "$BASE_SHA" "")"
    REVIEW_HEADER="# AI Automated Review"
    if [ "$EFFECTIVE_SCOPE" = "incremental" ]; then
      REVIEW_HEADER="# AI Automated Review (incremental)"
    fi

    # Build the review body with managed marker
    BODY_FILE="review-comment-body.md"
    {
      emit_review_markers
      echo "$REVIEW_HEADER"
      echo
      printf '_Analysis engine: %s_\n' "$ANALYSIS_ENGINE"
      echo
      cat review-comment-markdown.raw.md
    } > "$BODY_FILE"

    if [ "$VERDICT" = "request_changes" ]; then
      echo "Submitting non-blocking review comment (request_changes) for #$PR_NUMBER"
    else
      echo "Submitting non-blocking review comment (approve) for #$PR_NUMBER"
    fi

    # NOTE: gh pr review --comment creates a COMMENTED review that is NOT visible in the PR UI timeline.
    # Use gh pr comment instead for visibility, with --edit-last/--create-if-none for sticky behavior.
    platform_comment_sticky "$REPO" "$PR_NUMBER" "$BODY_FILE"

    # Resolve threads of carried findings this review verified as fixed,
    # and reply on threads still open (#208, #209). Must precede the
    # comment build so finding-threads.json suppresses duplicates.
    resolve_finding_threads

    # Optionally attach line-anchored inline comments from the structured
    # findings as a separate native COMMENT review. It carries the managed
    # marker so the next run's cleanup marks it superseded. Best-effort:
    # the summary comment above is already published.
    if [ "$(printf '%s' "${INLINE_FINDINGS:-false}" | tr '[:upper:]' '[:lower:]')" = "true" ] && [ -n "${FINDINGS:-}" ]; then
      printf '%s' "$FINDINGS" > findings.json
      COMMENTS_JSON="[]"
      if SUPPRESS_FINDINGS_FILE=finding-threads.json INLINE_FINDINGS_MAX="${INLINE_FINDINGS_MAX:-20}" python3 "${GITHUB_ACTION_PATH}/scripts/build_review_comments.py" findings.json pr.diff review-comments.json; then
        COMMENTS_JSON="$(cat review-comments.json)"
      fi
      if [ -n "$COMMENTS_JSON" ] && [ "$COMMENTS_JSON" != "[]" ]; then
        {
          echo "$COMMENT_MARKER"
          echo "_Inline findings from the automated review (summary in the sticky comment)._"
        } > inline-findings-body.md
        jq -n --rawfile body inline-findings-body.md --argjson comments "$COMMENTS_JSON" \
          '{body: $body, event: "COMMENT", comments: $comments}' > review-request.json
        if platform_review_create_json "$REPO" "$PR_NUMBER" review-request.json >/dev/null 2>&1; then
          echo "Attached $(printf '%s' "$COMMENTS_JSON" | jq 'length') inline finding comment(s)"
        else
          echo "WARN: inline findings review submission failed; summary comment was still published" >&2
        fi
      fi
    fi
    ;;

  review_verdict)
    # Sanitize model output
    sanitize_review_markdown "review-verdict-markdown.raw.md"

    # Validate PR number
    validate_pr_number "mode=review_verdict"

    # Resolve cleanup flag and execute cleanup
    CLEANUP_NATIVE_REVIEWS="$(resolve_cleanup_flag "${CLEANUP_PREVIOUS_NATIVE_REVIEWS:-auto}" "review_verdict")"
    cleanup_native_reviews "$CLEANUP_NATIVE_REVIEWS"

    # Fork-ness is derived once by the precheck (fail-closed) and
    # forwarded via IS_FORK_PR. Fall back to the PR object the precheck
    # saved only when that output is missing; derive_is_fork_pr fails
    # closed (missing/empty head, missing base, or absent file → fork)
    # rather than re-fetching the PR object.
    if [ -z "$IS_FORK_PR" ]; then
      IS_FORK_PR="$(derive_is_fork_pr pr-object.json)"
    fi

    # Resolve review result
    REVIEW_RESULT="clean"
    if [ "$VERDICT" = "request_changes" ]; then
      REVIEW_RESULT="issues"
    fi

    # Build metadata marker with verdict safety for incremental
    METADATA_MARKER="$(build_metadata_marker "$BASE_SHA" "$PREVIOUS_HEAD_SHA")"
    REVIEW_HEADER="# AI Automated Review"
    if [ "$EFFECTIVE_SCOPE" = "incremental" ]; then
      REVIEW_HEADER="# AI Automated Review (incremental)"
    fi

    # Evaluate approval guardrails with baseline check for incremental
    ALLOW_APPROVE_BOOL="$(printf '%s' "$ALLOW_APPROVE" | tr '[:upper:]' '[:lower:]')"
    APPROVE_FORKS_BOOL="$(printf '%s' "$APPROVE_FORKS" | tr '[:upper:]' '[:lower:]')"

    CAN_APPROVE=false

    if [ "$VERDICT" = "approve" ] && [ "$ALLOW_APPROVE_BOOL" = "true" ]; then
      # For incremental reviews, require a trusted clean full baseline
      if [ "$EFFECTIVE_SCOPE" = "incremental" ] && [ "$BASELINE_CLEAN" != "true" ]; then
        echo "Blocking approval: incremental review without trusted clean full baseline" >&2
        CAN_APPROVE=false
      else
        # Check fork gate
        if [ "$IS_FORK_PR" != "true" ]; then
          CAN_APPROVE=true
        elif [ "$APPROVE_FORKS_BOOL" = "true" ]; then
          CAN_APPROVE=true
        fi
      fi
    fi

    # Build the review body with managed marker
    BODY_FILE="review-verdict-body.md"
    {
      emit_review_markers
      echo "$REVIEW_HEADER"
      echo
      if [ "$EFFECTIVE_SCOPE" = "incremental" ]; then
        echo "_Incremental review: reviewed the changes since the last managed review; unresolved findings from that review are carried forward._"
      else
        echo "_Full PR review._"
      fi
      echo
      printf '_Analysis engine: %s_\n' "$ANALYSIS_ENGINE"
      echo
      cat review-verdict-markdown.raw.md
    } > "$BODY_FILE"

    # Resolve threads of carried findings this review verified as fixed,
    # and reply on threads still open (#208, #209). Must precede the
    # comment build so finding-threads.json suppresses duplicates.
    resolve_finding_threads

    # Build line-anchored inline comments from the structured findings
    # when enabled. Anchors are validated against pr.diff (written by the
    # review step); non-anchorable findings stay in the body only.
    COMMENTS_JSON="[]"
    if [ "$(printf '%s' "${INLINE_FINDINGS:-false}" | tr '[:upper:]' '[:lower:]')" = "true" ] && [ -n "${FINDINGS:-}" ]; then
      printf '%s' "$FINDINGS" > findings.json
      if SUPPRESS_FINDINGS_FILE=finding-threads.json INLINE_FINDINGS_MAX="${INLINE_FINDINGS_MAX:-20}" python3 "${GITHUB_ACTION_PATH}/scripts/build_review_comments.py" findings.json pr.diff review-comments.json; then
        COMMENTS_JSON="$(cat review-comments.json)"
      fi
    fi

    # Submit the native review bound to the reviewed commit, attaching
    # inline comments when present. If the platform rejects the JSON
    # payload (e.g. an anchor raced a new push), fall back to the plain
    # seam review so publishing never breaks because of inline findings
    # or commit binding.
    submit_native_review() {
      local event="$1" body_file="$2"
      case "$event" in
        APPROVE|REQUEST_CHANGES|COMMENT) ;;
        *) echo "Unsupported native review event: $event" >&2; return 2 ;;
      esac
      local inline_count=0
      if [ -n "$COMMENTS_JSON" ] && [ "$COMMENTS_JSON" != "[]" ]; then
        jq -n --rawfile body "$body_file" --arg event "$event" --arg commit_id "$HEAD_SHA" --argjson comments "$COMMENTS_JSON" \
          '{body: $body, event: $event, comments: $comments} + (if $commit_id != "" then {commit_id: $commit_id} else {} end)' > review-request.json
        inline_count="$(printf '%s' "$COMMENTS_JSON" | jq 'length')"
      else
        jq -n --rawfile body "$body_file" --arg event "$event" --arg commit_id "$HEAD_SHA" \
          '{body: $body, event: $event} + (if $commit_id != "" then {commit_id: $commit_id} else {} end)' > review-request.json
      fi
      if platform_review_create_json "$REPO" "$PR_NUMBER" review-request.json >/dev/null 2>&1; then
        echo "Submitted native review ($event) with $inline_count inline comment(s)"
        return 0
      fi
      echo "WARN: commit-bound review submission failed; falling back to plain review" >&2
      platform_review_native "$REPO" "$PR_NUMBER" "$event" "$body_file"
    }

    if [ "$CAN_APPROVE" = true ]; then
      echo "Submitting native approval for #$PR_NUMBER"
      if ! submit_native_review APPROVE "$BODY_FILE" 2>&1; then
        echo "ERROR: Native approval failed for #$PR_NUMBER." >&2
        echo "This may be caused by the 'Allow GitHub Actions to create and approve pull requests' setting being disabled." >&2
        echo "Enable this setting at: Repository Settings → Actions → General → Allow GitHub Actions to create and approve pull requests" >&2
        echo "Or at the organization level: Organization Settings → Actions → Organization permissions → Allow GitHub Actions to create and approve pull requests" >&2
        exit 1
      fi
    else
      if [ "$VERDICT" = "request_changes" ]; then
        echo "Submitting blocking findings for #$PR_NUMBER"
        submit_native_review REQUEST_CHANGES "$BODY_FILE"
      else
        # A clean verdict withheld by a guardrail stays advisory: a
        # blocking REQUEST_CHANGES would invent an issue the model did
        # not find, especially for forks where approval is intentionally
        # off. Explain the actual reason and submit a COMMENT review.
        echo "Withholding native approval for #$PR_NUMBER (allow_approve=${ALLOW_APPROVE_BOOL}, approve_forks=${APPROVE_FORKS_BOOL}, is_fork=${IS_FORK_PR})"
        if [ "$EFFECTIVE_SCOPE" = "incremental" ] && [ "$BASELINE_CLEAN" != "true" ]; then
          {
            echo ""
            echo "> **Approval withheld**: the previous review of this PR found blocking issues. This clean incremental review is advisory until a full review against a clean baseline confirms the PR as a whole."
          } >> "$BODY_FILE"
        else
          {
            echo ""
            echo "> **Approval blocked by policy**: this clean review is advisory. Native approvals require \`allow_approve: true\` (and \`approve_forks: true\` for cross-repository PRs)."
          } >> "$BODY_FILE"
        fi

        submit_native_review COMMENT "$BODY_FILE"
      fi
    fi
    ;;

  *)
    echo "Unknown publish_mode: $PUBLISH_MODE" >&2
    exit 1
    ;;
esac
