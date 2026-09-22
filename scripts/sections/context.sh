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

# Fork-ness is derived once by the precheck (fail-closed) and forwarded via the
# IS_FORK_PR env. Derive locally only when the env is genuinely absent — e.g. a
# standalone smoke test or manual run with no precheck step — and then with the
# same fail-closed rule.
if [[ -z "${IS_FORK_PR:-}" ]]; then
  IS_FORK_PR="$(derive_is_fork_pr pr-object.json)"
fi
if [[ "$IS_FORK_PR" == "true" ]]; then
  log "Detected cross-repository pull request"
fi

# ── Specialist lead artifacts reset (#609) ───────────────────────────
# Truncate the #609 corpus-feed artifacts (the bounded "Specialist Review
# Leads" section and its presence signal) BEFORE anything can consume a stale
# value. The call is UNCONDITIONAL — not gated on DEEP_REVIEW — because a
# reused workspace whose previous run had deep_review on must not present a
# stale presence signal into a run where deep_review is off (the system-prompt
# fragment gate and the corpus section both read the file). A fresh run always
# starts from empty artifacts; run_specialists.py re-writes them (with empty
# content where there is no section) before the corpus step can read them.
# Create-if-missing so a first-time workspace is also covered.
reset_specialist_lead_artifacts() {
  # NOTE: one redirection per file — `: > a b` would truncate ONLY `a` and
  # silently ignore `b`, which is exactly the stale-signal leak this exists to
  # prevent.
  : > specialists.md
  : > specialist-leads-present.txt
}
reset_specialist_lead_artifacts

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

: > repo-map.json repo-map.md
if [[ "$REPO_MAP_CONTEXT" == "true" ]]; then
  # The corpus re-frames the rendered map: the renderer's first line is
  # replaced by a fixed trust-framing prefix, making the final section a
  # fixed number of bytes LARGER than the raw render. Hand the renderer a
  # body budget net of that overhead (computed from the shared constant,
  # before rendering) so its hard cap holds on the final framed section —
  # corpus.sh then only reframes and never slices, because a slice can
  # land inside the four-backtick tree fence and leave it open (#599). A
  # cap that cannot contain the framing plus the renderer's smallest safe
  # output skips generation entirely.
  REPO_MAP_BODY_BUDGET="$(REPO_MAP_MAX_BYTES="$REPO_MAP_MAX_BYTES" \
      PYTHONPATH="${SCRIPT_DIR}/.." python3 -c '
import os
from pr_reviewer.repo_map import SCHEMA_VERSION, trust_framing_overhead
print(int(os.environ["REPO_MAP_MAX_BYTES"]) - trust_framing_overhead(SCHEMA_VERSION))
' 2>/dev/null || true)"
  # A one-byte renderer marker has no map header, so re-framing it adds the
  # full prefix rather than only the normal header-replacement overhead.
  if [[ "$REPO_MAP_BODY_BUDGET" =~ ^[0-9]+$ && "$REPO_MAP_BODY_BUDGET" -ge 23 ]]; then
    if ! python3 "$SCRIPT_DIR/build_repo_map.py" \
        --workspace "${GITHUB_WORKSPACE:-$PWD}" \
        --json repo-map.json \
        --markdown repo-map.md \
        --max-markdown-bytes "$REPO_MAP_BODY_BUDGET"; then
      error "Repository map generation failed; continuing without repository map context"
      : > repo-map.json repo-map.md
    fi
  else
    log "Skipping repository map: REPO_MAP_MAX_BYTES=$REPO_MAP_MAX_BYTES cannot contain the trust framing plus the smallest safe body"
  fi
fi
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
: > linked-issue-labels.json
# #633: linked-metadata completeness for deterministic role selection. A
# failed GitHub/Linear lookup means SELECTION-RELEVANT signals (security /
# audit / priority labels, Linear priority) are UNKNOWN — role_selection.py
# must see that uncertainty and fail toward scrutiny, not read missing
# signals as absent ones. Known-disabled state (Linear skipped for a fork PR
# by the LINEAR_ENABLE_FOR_FORKS gate) is NOT uncertainty.
: > linked-metadata-status.json
: > linked-issue-fetch-failures.txt
LINEAR_FETCH_FAILURES_JSON='[]'
LINEAR_KNOWN_DISABLED=false
if [ "$(jq 'length' linked-issues.json)" -gt 0 ]; then
  # The "# Linked Issue Context" header is emitted by scripts/sections/corpus.sh,
  # so we deliberately do not prepend it here. Doing so previously produced a
  # duplicate header in the rendered corpus whenever at least one linked issue
  # was present (#399).
  jq -c '.[]' linked-issues.json | while IFS= read -r item; do
    issue_repo="$(printf '%s' "$item" | jq -r '.repo')"
    issue_number="$(printf '%s' "$item" | jq -r '.number')"
    issue_ref="$(printf '%s' "$item" | jq -r '.ref')"

    echo "## $issue_ref" >> linked-issues.md
    if platform_issue_get "$issue_repo" "$issue_number" > linked-issue.raw.json 2>/dev/null; then
      jq '{number,title,state,html_url,labels:[.labels[]?.name],body}' linked-issue.raw.json > linked-issue.filtered.json
      # #633: feed the fetched labels back into the canonical
      # linked-issues.json — classifier.py consumes THIS file, so a GitHub
      # security/audit/priority label must land here, not only in the
      # rendered markdown (the bare-ref start below carries no labels, so
      # linked risk flags never fired in real runs). Canonical label shape
      # is [{name: str}] — the same shape Linear issue objects already
      # carry. One record per ref; failed fetches simply write no record
      # (fail-soft: the merged item keeps empty labels).
      jq -c --arg ref "$issue_ref" '{ref: $ref, labels: [.labels[]? | {name: .}]}' linked-issue.filtered.json >> linked-issue-labels.json
      echo '```json' >> linked-issues.md
      head -c 12000 linked-issue.filtered.json >> linked-issues.md
      echo >> linked-issues.md
      echo '```' >> linked-issues.md
    else
      echo "(Could not fetch issue $issue_ref from $issue_repo)" >> linked-issues.md
      printf '%s\n' "$issue_ref" >> linked-issue-fetch-failures.txt
    fi
    echo >> linked-issues.md
  done

  # Merge the fetched GitHub labels back into the canonical
  # linked-issues.json in place (identity preserved: ref/repo/number are
  # kept, labels are additive). No second linked-issue representation is
  # created — this is the same file classification consumes.
  if [ -s linked-issue-labels.json ]; then
    jq -s --slurpfile issues linked-issues.json '
      map({key: .ref, value: .labels}) | from_entries as $labels_by_ref
      | $issues[0] | map(. + {labels: ($labels_by_ref[.ref] // [])})
    ' linked-issue-labels.json > linked-issues.enriched.json \
      && mv linked-issues.enriched.json linked-issues.json
  fi
  rm -f linked-issue-labels.json
else
  # Leave linked-issues.md empty when there are no linked issues so the
  # rendered section in scripts/sections/corpus.sh is just the bare
  # "# Linked Issue Context" header with no stray placeholder line (#399).
  :
fi

# Optional Linear adapter: deterministically discover configured TEAM-123 keys
# in the PR title and fetch their issue/spec context before the model call. The
# API key stays in the environment (never argv). Fork PRs are fail-closed so a
# public review cannot disclose private tracker content unless explicitly opted in.
: > linear-issues.md
printf '[]\n' > linear-issues.json
if [[ -n "$LINEAR_API_KEY" && -n "$LINEAR_ISSUE_PREFIXES" ]]; then
  if gate_feature_for_forks "$LINEAR_ENABLE_FOR_FORKS" \
      linear-issues.md "" linear-issues.json "[]"; then
    : > linear-issues.md
    # Known-disabled state, not uncertainty: the pipeline deliberately does
    # not fetch Linear for fork PRs unless linear_enable_for_forks is set,
    # so no selection signal is hidden here.
    LINEAR_KNOWN_DISABLED=true
    log "Skipping Linear issue context for cross-repository PR"
  elif LINEAR_API_KEY="$LINEAR_API_KEY" python3 "$SCRIPT_DIR/../pr_reviewer/linear_context.py" \
      --pr-json pr.json \
      --prefixes "$LINEAR_ISSUE_PREFIXES" \
      --timeout "$LINEAR_ISSUE_TIMEOUT_SEC" \
      --output-json linear-issues.json \
      --output-markdown linear-issues.md \
      --errors-json linear-fetch-failures.json; then
    # Per-identifier lookup failures are uncertainty (#633): a configured
    # identifier whose priority/labels could not be fetched may have held
    # selection-relevant signals. Partial success still merges the issues
    # that WERE fetched.
    if [ -s linear-fetch-failures.json ] \
        && [ "$(jq 'length' linear-fetch-failures.json)" -gt 0 ]; then
      LINEAR_FETCH_FAILURES_JSON="$(jq -c 'map(.[0])' linear-fetch-failures.json)"
      error "Linear lookup failed for $(jq -r 'map(.[0]) | join(", ")' linear-fetch-failures.json); continuing with fetched issues (selection treats the missing metadata as uncertain)"
    fi
    cat linear-issues.md >> linked-issues.md
    jq -s '.[0] + .[1]' linked-issues.json linear-issues.json > linked-issues.merged.json
    mv linked-issues.merged.json linked-issues.json
    linear_count="$(jq 'length' linear-issues.json 2>/dev/null || echo 0)"
    if [[ "$linear_count" -gt 0 ]]; then
      log "Added $linear_count Linear issue(s) to linked issue context"
    fi
  else
    error "Linear issue context adapter failed; continuing without Linear context"
    printf '[]\n' > linear-issues.json
    : > linear-issues.md
    # The adapter itself failed (config/PR-JSON problem): any identifier the
    # title carried could not be looked up — uncertainty, not absence (#633).
     LINEAR_FETCH_FAILURES_JSON='["linear-adapter-failed"]'
  fi
fi

# Fold every failure record into the completeness status consumed by
# classification (classifier.py --metadata-status) and, through it, by
# deterministic role selection (#633).
GH_FAILURES_JSON="$(jq -R . linked-issue-fetch-failures.txt 2>/dev/null | jq -s . || echo '[]')"
jq -n \
  --argjson github_failures "${GH_FAILURES_JSON:-[]}" \
  --argjson linear_failures "$LINEAR_FETCH_FAILURES_JSON" \
  --argjson linear_known_disabled "$LINEAR_KNOWN_DISABLED" \
  '{
    version: 1,
    github_fetch_failures: $github_failures,
    linear_fetch_failures: $linear_failures,
    linear_known_disabled: $linear_known_disabled
  }' > linked-metadata-status.json
rm -f linked-issue-fetch-failures.txt linear-fetch-failures.json
section_timer_end

# ── Requirement Ledger (#624) ─────────────────────────────────────────
# Build the requirement ledger now that linked-issues.md is finalized, and
# BEFORE classification.sh runs apply_system_prompt_fragments: the ledger's
# requirement-ledger-present.txt signal gates the system-prompt fragment, so the
# ledger must exist before the fragment is substituted.
#
# Stale-artifact reset: every ledger artifact is truncated BEFORE the build is
# attempted (the same reset dance the corpus applies to standards-present.txt
# and tool-harness.{md,json} in corpus.sh). A reused workspace whose previous
# run had a ledger must not present STALE requirements, a stale presence
# signal, or a stale section file when this run's build fails or extracts
# nothing. Post-build logic never consults a file that can predate this run.
#
# The presence signal is conservative: it is written only when the ledger is
# non-empty AND fits the corpus reservation (ledger bytes + the section
# framing < MAX_CORPUS). The fragment substitution runs BEFORE corpus
# assembly (classification.sh precedes corpus.sh in run_review.sh's source
# order), and the fragments cannot be re-substituted once assembled — so the
# signal must never promise a section the corpus cannot sanely reserve. The
# corpus build applies the identical predicate when deciding whether to emit
# the reserved ledger block, keeping guidance and corpus in lockstep.
#
# Fail-soft: a ledger failure (or a missing module) never aborts the review —
# the run continues with empty artifacts, an empty signal, and no ledger
# section.
build_requirement_ledger() {
  local ledger_md_bytes ledger_sha
  : > requirement-ledger.json
  : > requirement-ledger.md
  : > requirement-ledger-present.txt
  : > requirement-ledger.section.md

  if [[ -n "${STANDARDS_FILE:-}" && -f "${STANDARDS_FILE}" ]]; then
    python3 -m pr_reviewer.requirement_ledger build \
      --pr-json pr.json \
      --linked-issues-md linked-issues.md \
      --standards "$STANDARDS_FILE" \
      --standards-ref "$(basename "$STANDARDS_FILE")" \
      --output requirement-ledger.json \
      --markdown requirement-ledger.md 2>/dev/null || true
  else
    python3 -m pr_reviewer.requirement_ledger build \
      --pr-json pr.json \
      --linked-issues-md linked-issues.md \
      --output requirement-ledger.json \
      --markdown requirement-ledger.md 2>/dev/null || true
  fi

  # Presence signal: a non-empty ledger writes its sha (or '1' if the sha is
  # absent); an empty ledger leaves the signal empty so the system-prompt
  # fragment stays dropped and the corpus section stays out. The framing
  # overhead is derived from the header string itself (header text + its
  # newline + the trailing blank line that corpus.sh appends), so this
  # predicate and corpus.sh's section-emission predicate are exact
  # complements — the measured section bytes are always ledger_md_bytes +
  # ledger_overhead — leaving no window where the signal promises a section
  # the corpus would drop.
  local ledger_header='# Explicit Requirement Ledger'
  local ledger_overhead=$(( ${#ledger_header} + 2 ))
  if [[ -s requirement-ledger.md ]]; then
    ledger_md_bytes="$(wc -c < requirement-ledger.md | tr -d ' ')"
    if [ $(( ledger_md_bytes + ledger_overhead )) -lt "$MAX_CORPUS" ]; then
      ledger_sha="$(jq -r '.sha // empty' requirement-ledger.json 2>/dev/null || true)"
      printf '%s\n' "${ledger_sha:-1}" > requirement-ledger-present.txt
    else
      log "WARNING: requirement ledger (${ledger_md_bytes}B + ${ledger_overhead}B framing) does not fit a MAX_CORPUS=${MAX_CORPUS} reservation; dropping the ledger signal and corpus section for this run"
      : > requirement-ledger-present.txt
    fi
  else
    : > requirement-ledger-present.txt
    : > requirement-ledger.json
  fi
}

build_requirement_ledger

# Extraction (URLs, version hints, GHCR images, compare SHAs) is now handled
# by scripts/run_enrichment.py which runs in the enrichment section below.
# This avoids brittle grep pipelines under set -euo pipefail (#7892).
: > urls.all.txt urls.txt version-hints.txt version-hints.truncated.txt ghcr-images.txt compare-shas.txt 2>/dev/null || {
  : > urls.all.txt; : > urls.txt; : > version-hints.txt
  : > version-hints.truncated.txt; : > ghcr-images.txt; : > compare-shas.txt
}

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
