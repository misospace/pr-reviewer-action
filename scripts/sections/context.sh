# shellcheck shell=bash
# Sourced by run_review.sh — PR context, linked issues, URL/version extraction, manifest context.
# Verbatim in-order slice of the former monolith (#307); relies on globals/helpers
# set up by the orchestrator. Not executable on its own.

section_timer_start "pr-context"
log "Collecting PR context for #$PR_NUMBER in $REPO..."

# check_review_needed.sh (the precheck step) already fetched the PR object and
# the full diff. Reuse them when present so the PR object and diff are each
# fetched exactly once per run; fall back to fetching for standalone use
# (smoke test, manual invocation).
if [[ -s pr-object.json && "$(jq -r '.number // empty' pr-object.json 2>/dev/null)" == "$PR_NUMBER" ]]; then
  log "Reusing PR object fetched by precheck"
else
  platform_pr_get "$REPO" "$PR_NUMBER" > pr-object.json
fi
jq '{number, title, body, headRefOid: .head.sha, baseRefName: .base.ref, headRefName: .head.ref, author: {login: (.user.login // "")}, changedFiles: .changed_files, additions, deletions, url: .html_url}' \
  pr-object.json > pr.json

IS_FORK_PR="$(jq -r '((.head.repo.full_name // "") != (.base.repo.full_name // ""))' pr-object.json 2>/dev/null || echo false)"
if [[ "$IS_FORK_PR" == "true" ]]; then
  log "Detected cross-repository pull request"
fi

if [[ -s pr.diff ]]; then
  log "Reusing PR diff fetched by precheck"
else
  platform_pr_diff "$REPO" "$PR_NUMBER" > pr.diff
fi
truncate_clean pr.diff pr.diff.truncated "$MAX_DIFF" '…[diff truncated to fit context budget]'

# One bounded page instead of --paginate: 100 files is far beyond what the
# MAX_FILES byte budget keeps anyway, and unbounded pagination on huge PRs
# both burned API quota and produced concatenated JSON documents.
platform_pr_files "$REPO" "$PR_NUMBER" > pr-files.raw.json
# Note: 'patch' is intentionally dropped — the per-file patches duplicate the
# raw diff that is already embedded in the corpus, and the classifier does not
# read them. Keeping them here doubled the diff bytes sent to the model.
TOTAL_CHANGED_FILES="$(jq -r '.changedFiles // 0' pr.json 2>/dev/null || echo 0)"
jq -c --argjson total "${TOTAL_CHANGED_FILES:-0}" \
  '[.[] | {filename,status,additions,deletions,changes,previous_filename}]
   + (if $total > 100 then [{note: "file list truncated to first 100 of \($total) changed files"}] else [] end)' \
  pr-files.raw.json > pr-files.json
truncate_clean pr-files.json pr-files.truncated.json "$MAX_FILES" '…[file list truncated]'

jq -r '.body // ""' pr.json > pr-body.txt
section_timer_end

section_timer_start "linked-issues"
log "Gathering linked issue context..."
REPO="$REPO" python3 - <<'PY' > linked-issues.json
import json
import os
from pathlib import Path
from pr_reviewer.github_context import extract_linked_issue_refs, linked_issues_to_json

repo = os.environ["REPO"]
body = Path("pr-body.txt").read_text(encoding="utf-8", errors="replace")
items = extract_linked_issue_refs(body, default_repo=repo)
print(json.dumps(linked_issues_to_json(items)))
PY

: > linked-issues.md
if [ "$(jq 'length' linked-issues.json)" -gt 0 ]; then
  echo "# Linked Issue Context" >> linked-issues.md
  echo >> linked-issues.md
  jq -c '.[]' linked-issues.json | while IFS= read -r item; do
    issue_repo="$(printf '%s' "$item" | jq -r '.repo')"
    issue_number="$(printf '%s' "$item" | jq -r '.number')"
    issue_ref="$(printf '%s' "$item" | jq -r '.ref')"

    echo "## $issue_ref" >> linked-issues.md
    if platform_issue_get "$issue_repo" "$issue_number" > linked-issue.raw.json 2>/dev/null; then
      jq '{number,title,state,html_url,labels:[.labels[]?.name],body}' linked-issue.raw.json > linked-issue.filtered.json
      echo '```json' >> linked-issues.md
      head -c 12000 linked-issue.filtered.json >> linked-issues.md
      echo >> linked-issues.md
      echo '```' >> linked-issues.md
    else
      echo "(Could not fetch issue $issue_ref from $issue_repo)" >> linked-issues.md
    fi
    echo >> linked-issues.md
  done
else
  echo "No linked issue references found in the PR body." >> linked-issues.md
fi
section_timer_end

cat pr-body.txt pr.diff.truncated \
  | grep -Eo 'https?://[^ )]+' \
  | sed 's/[",.;]$//' \
  | sort -u > urls.all.txt || true
head -n 25 urls.all.txt > urls.txt || true

grep -E '^[+-].*(image:|tag:|version:|chart:|appVersion:|digest:)' pr.diff.truncated > version-hints.txt || true
head -n 180 version-hints.txt > version-hints.truncated.txt || true

grep -Eo 'ghcr\.io/[^/]+/[^:"@ ]+' version-hints.txt | sort -u > ghcr-images.txt || true
sedi 's#ghcr\.io/##' ghcr-images.txt
sedi 's#:.*##' ghcr-images.txt
sort -u ghcr-images.txt -o ghcr-images.txt

section_timer_start "manifest-context"
log "Gathering changed manifest context..."
CHANGED_MANIFESTS=$(jq -r '.[] | select(.filename | test("(helmrelease|deployment|statefulset|daemonset|kustomization)\\.ya?ml$"; "i")) | .filename' pr-files.raw.json 2>/dev/null || true)

: > manifest-context.md
if [ -n "$CHANGED_MANIFESTS" ]; then
  echo "# Changed Manifest Context (modified files only)" >> manifest-context.md
  echo >> manifest-context.md

  TOTAL=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ ! -f "$f" ]; then
      echo "## File: $f" >> manifest-context.md
      echo "(file not present in checked-out tree at this ref)" >> manifest-context.md
      echo >> manifest-context.md
      continue
    fi

    LINES=$(wc -l < "$f")
    if [ $((TOTAL + LINES)) -gt 1200 ]; then
      echo "(manifest content truncated - too many total lines)" >> manifest-context.md
      break
    fi

    TOTAL=$((TOTAL + LINES))
    echo "## File: $f (${LINES} lines)" >> manifest-context.md
    echo '```yaml' >> manifest-context.md
    cat "$f" >> manifest-context.md
    echo '```' >> manifest-context.md
    echo >> manifest-context.md
  done <<< "$CHANGED_MANIFESTS"
else
  echo "No common manifest files changed in this PR." >> manifest-context.md
fi
section_timer_end

# Returns 0 when the URL's host is in ALLOWED_SOURCE_HOSTS.
url_host_allowed() {
  local host raw_host candidate
  host=$(printf '%s' "$1" | sed -E 's#^https?://([^/]+).*#\1#' | tr '[:upper:]' '[:lower:]')
  IFS=',' read -ra _allowed_hosts <<< "$ALLOWED_SOURCE_HOSTS"
  for raw_host in "${_allowed_hosts[@]}"; do
    candidate=$(printf '%s' "$raw_host" | xargs | tr '[:upper:]' '[:lower:]')
    [ -n "$candidate" ] || continue
    if [ "$host" = "$candidate" ]; then
      return 0
    fi
  done
  return 1
}

# Reduce a fetched linked-source body to corpus-worthy text: HTML pages are
# stripped to visible text, non-HTML passes through, output capped on a clean
# boundary. Raw HTML heads were mostly <head> boilerplate that burned corpus
# budget without giving the model anything to read.
strip_source_to_text() {
  python3 "$SCRIPT_DIR/strip_source_text.py" "$1" "$2" "$3"
}
