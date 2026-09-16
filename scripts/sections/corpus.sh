# shellcheck shell=bash
# Sourced by run_review.sh — standards context, review-corpus build, tool-harness execution.
# Verbatim in-order slice of the former monolith (#307); relies on globals/helpers
# set up by the orchestrator. Not executable on its own.

# Reap the advisory background phases (enrichment, image digests, evidence)
# before their output files are read into the corpus below (#371).
section_timer_start "advisory-phases"
harvest_advisory_phases
section_timer_end

build_related_code_context() {
  local diff_path="${1:-pr.diff}"
  local files_path="${2-pr-files.json}"
  local empty_artifact
  local artifacts="change-anchors.json related-code.json related-code.md related-code.truncated.md"
  for empty_artifact in $artifacts; do
    : > "$empty_artifact"
  done

  if [[ "$RELATED_CODE_CONTEXT" != "true" ]]; then
    return 0
  fi

  local anchor_args=(--diff "$diff_path" --output change-anchors.json)
  if [[ -n "$files_path" ]]; then
    anchor_args+=(--files "$files_path")
  fi
  if ! python3 -m pr_reviewer.change_anchors "${anchor_args[@]}"; then
    log "WARNING: related-code anchor generation failed; continuing without related-code context"
    for empty_artifact in $artifacts; do
      : > "$empty_artifact"
    done
    return 0
  fi

  local related_args=(--anchors change-anchors.json --workspace "${GITHUB_WORKSPACE:-$(pwd)}" --json related-code.json --markdown related-code.md)
  if [[ -n "$files_path" ]]; then
    related_args+=(--files "$files_path")
  fi
  if ! python3 -m pr_reviewer.related_context "${related_args[@]}"; then
    log "WARNING: related-code generation failed; continuing without related-code context"
    for empty_artifact in $artifacts; do
      : > "$empty_artifact"
    done
    return 0
  fi
  if ! jq -e '.errors | length == 0' related-code.json >/dev/null 2>&1; then
    log "WARNING: related-code scan reported errors; continuing without related-code context"
    for empty_artifact in $artifacts; do
      : > "$empty_artifact"
    done
    return 0
  fi

  if ! RELATED_CODE_MAX_BYTES="$RELATED_CODE_MAX_BYTES" python3 - <<'PY'
import os
from pathlib import Path

source = Path("related-code.md").read_bytes()
limit = int(os.environ["RELATED_CODE_MAX_BYTES"])
if len(source) <= limit:
    Path("related-code.truncated.md").write_bytes(source)
else:
    marker = b"\n[related-code context truncated]\n"
    clipped = source[:limit - len(marker)]
    newline = clipped.rfind(b"\n")
    if newline >= 0:
        clipped = clipped[:newline]
    Path("related-code.truncated.md").write_bytes(clipped + marker)
PY
  then
    log "WARNING: related-code truncation failed; continuing without related-code context"
    for empty_artifact in $artifacts; do
      : > "$empty_artifact"
    done
  fi
}

build_pr_thread_context() {
  # Bounded recent PR conversation comments (#578). Scope-independent: the
  # thread is about the whole PR, so this is built once and embedded in both
  # full and incremental corpora.
  local empty_artifact
  local artifacts="pr-thread.json pr-thread.md"
  for empty_artifact in $artifacts; do
    : > "$empty_artifact"
  done

  if [[ "$PR_THREAD_CONTEXT" != "true" ]]; then
    return 0
  fi

  if ! platform_pr_review_comments "$REPO" "$PR_NUMBER" > pr-thread.json; then
    log "WARNING: PR-thread comment fetch failed; continuing without PR thread context"
    for empty_artifact in $artifacts; do
      : > "$empty_artifact"
    done
    return 0
  fi

  if ! python3 -m pr_reviewer.pr_thread \
      --comments pr-thread.json \
      --output pr-thread.md \
      --max-bytes "$PR_THREAD_MAX_BYTES"; then
    log "WARNING: PR-thread context generation failed; continuing without PR thread context"
    for empty_artifact in $artifacts; do
      : > "$empty_artifact"
    done
  fi
}

log "Building review corpus..."
: > standards-context.md
# standards-context.md is never empty — it carries an explicit "unavailable"
# note when no file resolved — so it cannot double as the presence signal the
# publish step needs. standards-present.txt is that signal, and it is truncated
# on both paths so a persistent self-hosted runner can't leak a stale one.
: > standards-present.txt
if [ -f "$STANDARDS_FILE" ]; then
  echo "# Repository Standards and Conventions" >> standards-context.md
  echo "Derived from $STANDARDS_FILE for this repository." >> standards-context.md
  echo >> standards-context.md
  cat "$STANDARDS_FILE" >> standards-context.md
  printf '%s\n' "$STANDARDS_FILE" > standards-present.txt
else
  if [[ -n "$STANDARDS_FILE" ]]; then
    echo "($STANDARDS_FILE not found; standards context unavailable.)" >> standards-context.md
  else
    echo "(no standards file matched any candidate; standards context unavailable.)" >> standards-context.md
  fi
fi

case "$(printf '%s' "$TOOL_MODE" | tr '[:upper:]' '[:lower:]')" in
  native_loop)
    # The planner is about to be asked to plan tool calls, so it needs to see
    # that the harness is pending rather than an absent section (#101/#108).
    # Missing OR empty: a reused workspace can carry an empty file from an
    # earlier off-mode run, and -f alone would leave the planner without the
    # pending marker and the verdict turn without a section to substitute into.
    if [ ! -s tool-harness.md ]; then
      cat > tool-harness.md <<'EOF'
Tool harness planning pending.
EOF
    fi
    ;;
  *)
    # Off means no harness runs, so there is no output to report this review
    # and the header below is gated on this file being non-empty. Writing a
    # status line here instead would hand the model a populated section to
    # report on, which is the failure #400 fixed for linked-issues.md.
    #
    # Truncate rather than test for existence: on a reused workspace a file
    # left by an earlier run would otherwise present itself as this review's
    # findings, the same reason standards-context.md is truncated above.
    : > tool-harness.md
    # The JSON needs the same treatment, and it is the half that reaches
    # further. escalation.py reads planning_error and error out of this file, so
    # a stale one escalates a review that ran no tools; the step summary reports
    # its call counts, usage, cache-hit ratio and evidence digest, so a stale one
    # attributes the previous run's telemetry to this review. Gating it on
    # existence while truncating the Markdown leaves the reused-workspace
    # rationale half-applied.
    cat > tool-harness.json <<'EOF'
{"mode":"off","planned_request_count":0,"executed_request_count":0,"tool_results":[]}
EOF
    ;;
esac

if [ ! -f tool-harness.json ]; then
  cat > tool-harness.json <<'EOF'
{"mode":"off","planned_request_count":0,"executed_request_count":0,"tool_results":[]}
EOF
fi

build_bounded_repo_map() {
  : > repo-map.capped.md
  [ -s repo-map.md ] || return 0

  # Re-frame only; never truncate. The renderer already cut the document to
  # a body budget net of the framing overhead (see context.sh), so the
  # re-framed form fits REPO_MAP_MAX_BYTES by construction. The old code
  # applied a second, generic byte slice here that could land inside the
  # four-backtick tree fence and leave it open (#599). The cap is now a
  # verified invariant, not a truncation point: if it is ever violated
  # (stale/hand-edited artifact, renderer version skew) we emit no map
  # rather than partial data, and any failure is a graceful no-op — the map
  # is advisory context, never a review-blocking dependency.
  REPO_MAP_MAX_BYTES="$REPO_MAP_MAX_BYTES" PYTHONPATH="${SCRIPT_DIR}/.." \
    python3 - <<'PY' || true
import os
from pathlib import Path

from pr_reviewer.repo_map import reframe_for_corpus

cap = int(os.environ["REPO_MAP_MAX_BYTES"])
raw = Path("repo-map.md").read_text(encoding="utf-8")
final = reframe_for_corpus(raw)
if len(final.encode("utf-8")) <= cap:
    Path("repo-map.capped.md").write_text(final, encoding="utf-8")
PY
}

build_review_corpus() {
  local corpus_type="${1:-full}"  # 'full' or 'incremental'

  build_bounded_repo_map

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

    if [ -s related-code.truncated.md ]; then
      echo "# Related Code Context"
      cat related-code.truncated.md
      echo
    fi

    if [ -s repo-map.capped.md ]; then
      cat repo-map.capped.md
      echo
    fi

    # pr-thread.md carries its own trust-framed "# PR Thread Context" header
    # (pr_thread.py) and is empty when no comment survives filtering, so the
    # gate hides the section entirely rather than publishing a placeholder.
    if [ -s pr-thread.md ]; then
      cat pr-thread.md
      echo
    fi

    if [[ "$corpus_type" == "incremental" ]]; then
      # Linear is opt-in. Preserve its issue/spec context across incremental
      # reviews without changing the existing default treatment of linked
      # GitHub or Forgejo issues when the adapter is disabled.
      if [ -s linear-issues.md ]; then
        echo "# Linked Issue Context"
        cat linear-issues.md
        echo
      fi
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
      # context.sh leaves linked-issues.md empty when there's no linked issue
      # (#399/#400) so the model sees no section boundary to react to. Gate
      # the header the same way, matching the CI Check Results pattern below.
      if [ -s linked-issues.md ]; then
        echo "# Linked Issue Context"
        cat linked-issues.md
        echo
      fi
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
    if [ -s tool-harness.md ]; then
      if [[ "$corpus_type" == "incremental" ]]; then
        echo "# Tool Harness Findings (incremental review)"
      else
        echo "# Tool Harness Findings"
      fi
      cat tool-harness.md
      echo
    fi
    # run_evidence_providers.py leaves evidence-providers.md empty when no
    # providers are configured, same treatment as linked-issues.md above.
    if [ -s evidence-providers.md ]; then
      echo "# Evidence Providers"
      cat evidence-providers.md
      echo
    fi
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

log "Building PR-thread context..."
build_pr_thread_context

if [[ "$EFFECTIVE_SCOPE" == "incremental" && -n "$PREVIOUS_HEAD_SHA" ]]; then
  fetch_incremental_patch "$PREVIOUS_HEAD_SHA" "$(jq -r '.headRefOid' pr.json 2>/dev/null || echo "")" incremental.diff
  log "Building related-code context from incremental diff..."
  build_related_code_context incremental.diff ""
  build_review_corpus "incremental"
else
  log "Building related-code context from full diff..."
  build_related_code_context pr.diff pr-files.json
  build_review_corpus "full"
fi
cp review-corpus.md review-corpus.truncated.md
section_timer_end

case "$(printf '%s' "$TOOL_MODE" | tr '[:upper:]' '[:lower:]')" in native_loop) TOOL_HARNESS_ENABLED="true" ;; *) TOOL_HARNESS_ENABLED="false" ;; esac
if [[ "$TOOL_HARNESS_ENABLED" == "true" ]]; then
  if gate_feature_for_forks "$TOOL_ENABLE_FOR_FORKS" \
      tool-harness.md "Tool harness was skipped for a cross-repository pull request. Set tool_enable_for_forks=true to override." \
      tool-harness.json '{"mode":"native_loop","planned_request_count":0,"executed_request_count":0,"tool_results":[],"skipped":true,"skip_reason":"fork-pr"}'; then
    : # fork PR without tool_enable_for_forks — skip artifacts already written
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
