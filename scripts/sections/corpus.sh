# shellcheck shell=bash
# Sourced by run_review.sh — standards context, review-corpus build, tool-harness execution.
# Verbatim in-order slice of the former monolith (#307); relies on globals/helpers
# set up by the orchestrator. Not executable on its own.

log "Building review corpus..."
: > standards-context.md
if [ -f "$STANDARDS_FILE" ]; then
  echo "# Repository Standards and Conventions" >> standards-context.md
  echo "Derived from $STANDARDS_FILE for this repository." >> standards-context.md
  echo >> standards-context.md
  cat "$STANDARDS_FILE" >> standards-context.md
else
  if [[ -n "$STANDARDS_FILE" ]]; then
    echo "($STANDARDS_FILE not found; standards context unavailable.)" >> standards-context.md
  else
    echo "(no standards file matched any candidate; standards context unavailable.)" >> standards-context.md
  fi
fi

if [ ! -f tool-harness.md ]; then
  case "$(printf '%s' "$TOOL_MODE" | tr '[:upper:]' '[:lower:]')" in
    native_loop)
      cat > tool-harness.md <<'EOF'
Tool harness planning pending.
EOF
      ;;
    *)
      cat > tool-harness.md <<'EOF'
Tool harness disabled.
EOF
      ;;
  esac
fi

if [ ! -f tool-harness.json ]; then
  cat > tool-harness.json <<'EOF'
{"mode":"off","planned_request_count":0,"executed_request_count":0,"tool_results":[]}
EOF
fi

build_review_corpus() {
  local corpus_type="${1:-full}"  # 'full' or 'incremental'

  # Build non-standards body first (this is the portion subject to truncation)
  {
    echo "# Changed Manifest Context"
    cat manifest-context.md
    echo
    echo "# PR Metadata"
    echo '```json'
    # Project to review-relevant fields and cap the body: the full object also
    # carries the entire .files array (duplicating the PR Files section and the
    # classification summary) and an unbounded body.
    jq -c '{number, title, author: (.author.login // .author), baseRefName, headRefName, headRefOid, changedFiles, additions, deletions, url, body: ((.body // "")[0:4000])}' pr.json
    echo '```'
    echo


    echo "# PR Classification"
    if [ -f classification.json ]; then
      jq -c '{pr_kind, risk_flags, risk_flags_with_files, changed_files_summary: (.changed_files_summary | .[0:20]), linked_issue_labels, must_check}' classification.json | head -c 8000
    else
      echo "(Classification data unavailable for this review)"
    fi
    echo

    if [[ "$corpus_type" == "incremental" ]]; then
      local head_sha
      head_sha="$(jq -r '.headRefOid' pr.json 2>/dev/null || echo 'unknown')"
      echo "# Incremental Review Delta"
      echo "_Reviewing changes from $PREVIOUS_HEAD_SHA to $head_sha. This is not a full re-review of the entire PR._"
      echo
      if [ -f incremental.diff ]; then
        echo '```diff'
        truncate_clean incremental.diff incremental.diff.truncated "$MAX_DIFF" '…[delta truncated]'
        cat incremental.diff.truncated
        echo '```'
      else
        echo "(No incremental diff available)"
      fi
      echo
      # Carried-forward open findings (#193): the previous review's unresolved
      # findings, which the model must answer one-by-one. High in the corpus
      # on purpose — it is the most important context an incremental review has.
      if [ -s previous-findings.json ] && [ "$(jq 'length' previous-findings.json 2>/dev/null || echo 0)" -gt 0 ]; then
        PYTHONPATH="${SCRIPT_DIR}/.." python3 -c "
from pr_reviewer.carry_forward import load_carried_findings, render_carried_findings_section
print(render_carried_findings_section(load_carried_findings()), end='')
" 2>/dev/null || echo "(Previous review findings could not be loaded)"
      fi
      # Cross-run evidence memory (#265): reuse the evidence the previous review
      # already gathered so this delta review doesn't re-run the same reads/
      # fetches. Rendered with fail-safe "re-verify the delta" framing. Below
      # carried findings on purpose — findings are the more important context.
      if [ "$(printf '%s' "${TOOL_EVIDENCE_MEMORY:-true}" | tr '[:upper:]' '[:lower:]')" = "true" ] \
         && [ -s previous-evidence.json ]; then
        PYTHONPATH="${SCRIPT_DIR}/.." python3 -c "
from pr_reviewer.evidence_memory import load_evidence_memory, render_evidence_memory_section
print(render_evidence_memory_section(load_evidence_memory()), end='')
" 2>/dev/null || true
      fi
    else
      echo "# Linked Issue Context"
      cat linked-issues.md
      echo
      echo "# PR Files (truncated)"
      echo '```json'
      cat pr-files.truncated.json
      echo '```'
      echo
      echo "# Version Hints from Diff"
      echo '```text'
      cat version-hints.truncated.txt 2>/dev/null || echo "(none)"
      echo '```'
      echo
      echo "# PR Diff (truncated)"
      echo '```diff'
      cat pr.diff.truncated
      echo '```'
      echo
    fi

    # High-value evidence comes BEFORE linked sources / repo scans so that when
    # the corpus overflows the budget, the noisy low-value sections at the tail
    # are dropped first instead of this evidence.
    if [[ "$corpus_type" == "incremental" ]]; then
      echo "# Tool Harness Findings (incremental review)"
    else
      echo "# Tool Harness Findings"
    fi
    cat tool-harness.md
    echo
    echo "# Evidence Providers"
    cat evidence-providers.md
    echo
    # CI ran to completion in its own sandbox before this review; surface the
    # per-check outcomes so the model cites real test/lint results instead of
    # reporting them as "not verifiable". Only present when ci_status_check=true
    # and external checks existed.
    if [ -n "$CI_CHECKS_FILE" ] && [ -s "$CI_CHECKS_FILE" ]; then
      echo "# CI Check Results"
      cat "$CI_CHECKS_FILE"
      echo
    fi
    echo "# Image Digest Provenance"
    cat image-digest-context.md
    echo

    # Lowest-value sections last — first to be dropped on truncation.
    echo "# Linked Sources"
    cat linked-sources.md
    echo
    echo "# Repository Impact Scan"
    cat repo-impact.truncated.md
    echo
    echo "# Repository History"
    cat repo-history.truncated.md
    echo
  } > review-corpus.body.md

  # MAX_CORPUS is the total budget (standards + body). Cap the standards section
  # first, then give the truncatable body whatever budget remains so a large
  # standards file can't silently blow past the model's context window.
  local std_cap=16000
  truncate_clean standards-context.md standards-context.capped.md "$std_cap" '…[standards truncated]'
  local std_bytes body_budget
  std_bytes="$(wc -c < standards-context.capped.md | tr -d ' ')"
  body_budget=$(( MAX_CORPUS - std_bytes ))
  [ "$body_budget" -lt 4000 ] && body_budget=4000
  truncate_clean review-corpus.body.md review-corpus.body.truncated.md "$body_budget" \
    '```
…[review corpus truncated to fit the model context budget]'

  # Prepend the (capped) standards section, then append the truncated body
  {
    echo "# Repository Standards and Conventions ($STANDARDS_FILE)"
    cat standards-context.capped.md
    echo
    cat review-corpus.body.truncated.md
  } > review-corpus.md
}

section_timer_start "corpus-building"
log "Building review corpus (scope: $EFFECTIVE_SCOPE)..."

if [[ "$EFFECTIVE_SCOPE" == "incremental" && -n "$PREVIOUS_HEAD_SHA" ]]; then
  fetch_incremental_patch "$PREVIOUS_HEAD_SHA" "$(jq -r '.headRefOid' pr.json 2>/dev/null || echo "")" incremental.diff
  build_review_corpus "incremental"
else
  build_review_corpus "full"
fi
cp review-corpus.md review-corpus.truncated.md
section_timer_end

case "$(printf '%s' "$TOOL_MODE" | tr '[:upper:]' '[:lower:]')" in native_loop) TOOL_HARNESS_ENABLED="true" ;; *) TOOL_HARNESS_ENABLED="false" ;; esac
if [[ "$TOOL_HARNESS_ENABLED" == "true" ]]; then
  if [[ "$IS_FORK_PR" == "true" ]] && [[ "$(printf '%s' "$TOOL_ENABLE_FOR_FORKS" | tr '[:upper:]' '[:lower:]')" != "true" ]]; then
    cat > tool-harness.md <<'EOF'
Tool harness was skipped for a cross-repository pull request. Set tool_enable_for_forks=true to override.
EOF
    cat > tool-harness.json <<'EOF'
{"mode":"native_loop","planned_request_count":0,"executed_request_count":0,"tool_results":[],"skipped":true,"skip_reason":"fork-pr"}
EOF
  else
    log "Running tool harness in mode: $TOOL_MODE"
    if ! python3 "$SCRIPT_DIR/run_tool_harness.py"; then
      error "Tool harness execution failed"
      cat > tool-harness.md <<'EOF'
Tool harness failed to run in this review.
EOF
      cat > tool-harness.json <<'EOF'
{"mode":"native_loop","planned_request_count":0,"executed_request_count":0,"tool_results":[],"error":"execution failed"}
EOF
    fi
  fi
  # Rebuild with the same scope used before the harness ran; build_review_corpus
  # defaults to "full", which would silently discard an incremental delta review.
  if [[ "$EFFECTIVE_SCOPE" == "incremental" && -n "$PREVIOUS_HEAD_SHA" ]]; then
    build_review_corpus "incremental"
  else
    build_review_corpus "full"
  fi
  cp review-corpus.md review-corpus.truncated.md
fi
