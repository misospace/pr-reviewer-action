#!/usr/bin/env bash
set -euo pipefail

# ── parse_review_command.sh ─────────────────────────────────────────────
# Decides whether an on-demand "re-review" command in a PR/issue comment
# should be honored. This is the authorization gate for a comment-triggered
# re-review (issue_comment workflows run with base-repo secrets and a
# write-scoped token — the pull_request_target trust class — so the command
# MUST be gated on the commenter's actual repository permission).
#
# Inputs (env):
#   COMMENT_BODY          – the triggering comment body
#   COMMENTER_LOGIN       – github.event.comment.user.login
#   REPO                  – owner/name
#   GH_TOKEN / GITHUB_TOKEN
#   REVIEW_COMMAND        – command token to match (default "/ai-review")
#   IS_PR_COMMENT         – "true" only for comments on PRs (default "true");
#                           issue_comment fires for plain issues too.
#   GITHUB_OUTPUT         – step output sink
#
# Outputs (GITHUB_OUTPUT):
#   should_review=true|false
#   reason=<no-command|not-a-pr|invalid-login|insufficient-permission|
#           permission-check-failed|command-authorized>
#
# Authorization is intentionally strict: author_association is NOT trusted
# (CONTRIBUTOR/NONE are external; org members may hold read-only roles).
# Permission is read from the collaborators API and must be write or admin.

COMMENT_BODY="${COMMENT_BODY:-}"
COMMENTER_LOGIN="${COMMENTER_LOGIN:-}"
REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
export GH_TOKEN
REVIEW_COMMAND="${REVIEW_COMMAND:-/ai-review}"
IS_PR_COMMENT="${IS_PR_COMMENT:-true}"
OUTPUT_FILE="${GITHUB_OUTPUT:-/dev/null}"

emit() {
  # $1=should_review  $2=reason
  echo "should_review=$1" >> "$OUTPUT_FILE"
  echo "reason=$2" >> "$OUTPUT_FILE"
  echo "[re-review] should_review=$1 reason=$2" >&2
  exit 0
}

# 1. Must be a comment on a PR (issue_comment also fires for plain issues).
if [[ "$IS_PR_COMMENT" != "true" ]]; then
  emit false "not-a-pr"
fi

# 2. The command must appear as its own token at the start of a line
#    (ignoring leading whitespace), so it isn't matched inside prose or a
#    quoted backlog of someone else's comment.
command_present=false
while IFS= read -r line; do
  trimmed="${line#"${line%%[![:space:]]*}"}"   # strip leading whitespace
  if [[ "$trimmed" == "$REVIEW_COMMAND" || "$trimmed" == "$REVIEW_COMMAND "* ]]; then
    command_present=true
    break
  fi
done <<< "$COMMENT_BODY"

if [[ "$command_present" != "true" ]]; then
  emit false "no-command"
fi

# 3. Validate the login shape before interpolating it into an API path.
if [[ ! "$COMMENTER_LOGIN" =~ ^[A-Za-z0-9](-?[A-Za-z0-9])*$ ]]; then
  emit false "invalid-login"
fi

# 4. Authorize against real repository permission. rc-check the call: gh
#    prints error bodies to stdout on failure, so `$(... || echo "")` would
#    capture JSON garbage — assign only when gh exits zero.
permission=""
if out="$(gh api "repos/${REPO}/collaborators/${COMMENTER_LOGIN}/permission" --jq '.permission' 2>/dev/null)"; then
  permission="$out"
else
  emit false "permission-check-failed"
fi

case "$permission" in
  admin|write) emit true "command-authorized" ;;
  *)           emit false "insufficient-permission" ;;
esac
