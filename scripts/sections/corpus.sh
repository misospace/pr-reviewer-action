# shellcheck shell=bash
# Sourced by run_review.sh — standards context, review-corpus build, tool-harness execution.
# Verbatim in-order slice of the former monolith (#307); relies on globals/helpers
# set up by the orchestrator. Not executable on its own.

# Reap the advisory background phases (enrichment, image digests, evidence)
# before their output files are read into the corpus below (#371).
section_timer_start "advisory-phases"

# ── Concurrent review gates (#634) ──────────────────────────────────────
# Fork the CI gate first thing: it needs none of the artifacts collected here,
# so its wait can overlap the advisory-phase harvest, the deterministic corpus
# build, and the advisory specialist gate. It is non-blocking (gating.sh), and
# the final corpus is assembled only AFTER both gates are reaped below, so it
# always carries the finalized CI evidence and any usable specialist leads.
fork_ci_gate

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
  # Bounded recent PR conversation comments (#578): the thread is about the
  # whole PR, so it is built once and embedded in the review corpus.
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
  local tier="${1:-primary}"
  local slot="${2:-$tier}"
  # The initial review always owns the primary artifact slot; a directly
  # routed smart model only changes the context profile, not artifact names.
  local MAX_CORPUS="${PRIMARY_MAX_CORPUS:-$MAX_CORPUS}" diff_budget="${PRIMARY_MAX_DIFF:-${MAX_DIFF:-140000}}" files_budget="${PRIMARY_MAX_FILES:-${MAX_FILES:-70000}}"
  local output="review-corpus.md" diff_file="pr.diff.truncated" files_file="pr-files.truncated.json"
  local harness_file="tool-harness.md"
  if [[ "$tier" == smart ]]; then
    MAX_CORPUS="${SMART_MAX_CORPUS:-$MAX_CORPUS}"; diff_budget="${SMART_MAX_DIFF:-${MAX_DIFF:-140000}}"; files_budget="${SMART_MAX_FILES:-${MAX_FILES:-70000}}"
    if [[ "$slot" == smart ]]; then
      output="review-corpus.smart.truncated.md"
    fi
    diff_file="pr.diff.smart.truncated"; files_file="pr-files.smart.truncated.json"
    truncate_clean pr.diff "$diff_file" "$diff_budget" '…[diff truncated to fit context budget]'
    truncate_clean pr-files.json "$files_file" "$files_budget" '…[file list truncated]'
    if [[ "$slot" == smart ]]; then
      harness_file="tool-harness.smart.md"
      if [[ ! -s "$harness_file" && -s tool-harness.md ]]; then
        printf '%s\n' 'Primary tool investigation omitted; conduct your own independent review.' > "$harness_file"
      fi
    fi
  fi
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
      # Materialize the projection before cutting: `jq | head -c` races a
      # SIGPIPE abort whenever the compact projection exceeds the cap
      # (jq dies writing into a closed pipe, and pipefail then aborts the
      # review), nondeterministically. Emitting to a file and cutting from
      # it produces byte-identical output deterministically, and jq's own
      # nonzero exit still fails the build under set -e.
      jq -c '{pr_kind, risk_flags, risk_flags_with_files, changed_files_summary: (.changed_files_summary | .[0:20]), linked_issue_labels, must_check}' classification.json > classification.compact.json
      head -c 8000 classification.compact.json
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

    # context.sh leaves linked-issues.md empty when there's no linked issue
    # (#399/#400) so the model sees no section boundary to react to. Gate
    # the header the same way, matching the CI Check Results pattern below.
    if [ -s linked-issues.md ]; then
      echo "# Linked Issue Context"
      cat linked-issues.md
      echo
    fi
    # Exact-head external checks are authoritative evidence. Place them ahead
    # of the bulky diff so a body-budget truncation cannot silently turn a
    # completed check into "not verified" for the final reviewer.
    if [ -n "$CI_CHECKS_FILE" ] && [ -s "$CI_CHECKS_FILE" ]; then
      echo "# CI Check Results"
      cat "$CI_CHECKS_FILE"
      echo
    fi
    echo "# PR Files (truncated)"
    echo '```json'
    cat "$files_file"
    echo '```'
    echo
    echo "# Version Hints from Diff"
    echo '```text'
    cat version-hints.truncated.txt 2>/dev/null || echo "(none)"
    echo '```'
    echo
    echo "# PR Diff (truncated)"
    echo '```diff'
    cat "$diff_file"
    echo '```'
    echo

    # High-value evidence comes BEFORE linked sources / repo scans so that when
    # the corpus overflows the budget, the noisy low-value sections at the tail
    # are dropped first instead of this evidence.
    if [ -s "$harness_file" ]; then
      echo "# Tool Harness Findings"
      cat "$harness_file"
      echo
    fi
    # run_evidence_providers.py leaves evidence-providers.md empty when no
    # providers are configured, same treatment as linked-issues.md above.
    if [ -s evidence-providers.md ]; then
      echo "# Evidence Providers"
      cat evidence-providers.md
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

  # MAX_CORPUS is the total budget (standards + body + reserved ledger +
  # reserved specialist leads). Cap the standards section first, carve out the
  # reserved ledger and specialist-lead sections, then give the body the
  # remaining budget so a large standards file, ledger, or lead section can't
  # silently blow past the model's context window.
  local std_cap=16000
  # Leave the body floor and framing room even for a small explicit window.
  if [[ "$std_cap" -gt $(( MAX_CORPUS - 4100 )) ]]; then
    std_cap=$(( MAX_CORPUS - 4100 ))
  fi
  truncate_clean standards-context.md standards-context.capped.md "$std_cap" '…[standards truncated]'
  local std_bytes ledger_bytes sp_bytes body_budget framing_bytes
  std_bytes="$(wc -c < standards-context.capped.md | tr -d ' ')"

  # ── Explicit Requirement Ledger (#624) — reserved, like standards ─────
  # Rebuild the ledger section from scratch on EVERY assembly (the initial
  # build and every rebuild all go through this function), exactly once,
  # into requirement-ledger.section.md: the header line + the
  # exact bytes of requirement-ledger.md + a trailing blank line. Its size
  # is subtracted from the body budget below, so the body truncation can
  # never eat it — the block is appended after the truncated body, never
  # truncated itself, and every assembly reserves it. The ledger content
  # is already hard-capped at
  # MAX_LEDGER_MARKDOWN_BYTES (8192) by the renderer. The same fits-sanity
  # that gated the presence signal in context.sh applies here — the section's
  # measured bytes equal the ledger bytes plus the framing (the header line
  # and its newline, plus the trailing blank line), which context.sh derives
  # from the same header string — so signal and section cannot diverge: a
  # ledger that does not fit is dropped from both.
  : > requirement-ledger.section.md
  if [ -s requirement-ledger.md ]; then
    {
      echo "# Explicit Requirement Ledger"
      cat requirement-ledger.md
      echo
    } > requirement-ledger.section.md
  fi
  ledger_bytes="$(wc -c < requirement-ledger.section.md | tr -d ' ')"
  if [ "$ledger_bytes" -gt 0 ] && [ "$ledger_bytes" -ge $(( MAX_CORPUS - std_bytes - 4100 )) ]; then
    : > requirement-ledger.section.md
    ledger_bytes=0
  fi

  # ── Specialist Review Leads (#609) — reserved, but LAST ─────────────────
  # specialists.md is the advisory lead section rendered by run_specialists.py
  # at the end of the deep-review phase (empty whenever deep review is
  # disabled, no usable lead survived, or the section could not fit its own
  # SPECIALISTS_SECTION_MAX_BYTES cap). Its exact bytes are carved out of the
  # body budget below — reserved like the ledger — and the block is appended
  # after the truncated body and after the ledger, never truncated itself.
  # Authority order is deliberate: standards (first) > explicit requirement
  # ledger > advisory leads (last), so specialist content can never evict
  # higher-authority standards/ledger material. The same fits-sanity the
  # ledger applies (drop when it cannot fit a sane reservation) keeps this
  # assembly and the run_specialists.py presence signal in lockstep.
  sp_bytes=0
  if [ -s specialists.md ]; then
    sp_bytes="$(wc -c < specialists.md | tr -d ' ')"
    if [ "$sp_bytes" -ge $(( MAX_CORPUS - std_bytes - ledger_bytes - 4100 )) ]; then
      sp_bytes=0
    fi
  fi

  # The header and separators are outside the truncated body; reserve their
  # exact bytes, including the newline after an appended specialist section.
  framing_bytes="$( { printf '# Repository Standards and Conventions (%s)\n\n' "$STANDARDS_FILE"; if [ "$sp_bytes" -gt 0 ]; then printf '\n'; fi; } | wc -c | tr -d ' ')"
  body_budget=$(( MAX_CORPUS - std_bytes - ledger_bytes - sp_bytes - framing_bytes ))
  [ "$body_budget" -lt 0 ] && body_budget=0
  truncate_clean review-corpus.body.md review-corpus.body.truncated.md "$body_budget" \
    '```
 …[review corpus truncated to fit the model context budget]'

  # Prepend the (capped) standards section — first and highest-authority,
  # truncation-exempt (see tests/test_corpus_standards_survival.sh) — then the
  # truncated body, then the reserved ledger block, then the reserved
  # specialist-lead block (#609) last: lowest authority, appended after
  # everything, never sliced by truncation (whole-section granularity).
  {
    echo "# Repository Standards and Conventions ($STANDARDS_FILE)"
    cat standards-context.capped.md
    echo
    cat review-corpus.body.truncated.md
    cat requirement-ledger.section.md
    if [ "$sp_bytes" -gt 0 ]; then
      cat specialists.md
      echo
    fi
  } > "$output"
  if [[ "$tier" == smart || -n "${PRIMARY_MODEL_CONTEXT_TOKENS:-}" || -n "${MODEL_CONTEXT_TOKENS:-}" ]]; then
    local actual_bytes
    actual_bytes="$(wc -c < "$output" | tr -d ' ')"
    if [[ "$actual_bytes" -gt "$MAX_CORPUS" ]]; then
      log "ERROR: assembled $tier corpus ($actual_bytes bytes) exceeds its $MAX_CORPUS-byte context budget"
      return 1
    fi
  fi

  # Lockstep guard: the system-prompt fragment was already substituted from
  # requirement-ledger-present.txt (apply_system_prompt_fragments in
  # classification.sh, which runs before this assembly) — so a non-empty
  # signal must correspond to a ledger section in the final corpus. Unreachable
  # by construction (the section's bytes were carved out of the body budget
  # above, and the shared fits-sanity keeps signal and section in step),
  # asserted defensively.
  if [[ "$slot" != smart ]] && [ -s requirement-ledger-present.txt ] \
     && ! grep -qF '# Explicit Requirement Ledger' "$output"; then
    log "WARNING: requirement-ledger-present.txt is set but the ledger section is missing from review-corpus.md; clearing the stale signal"
    : > requirement-ledger-present.txt
  fi

  # Lockstep guard (#609): the specialist guidance fragment is substituted
  # from specialist-leads-present.txt right after the specialist phase
  # (below), so a non-empty signal must correspond to a "# Specialist Review
  # Leads" section in the final corpus. Unreachable by construction —
  # run_specialists.py applies the identical MAX_CORPUS fits-sanity before
  # writing both artifacts — asserted defensively.
  if [[ "$slot" != smart ]] && [ -s specialist-leads-present.txt ] \
     && ! grep -qF '# Specialist Review Leads' "$output"; then
    log "WARNING: specialist-leads-present.txt is set but the specialist section is missing from review-corpus.md; clearing the stale signal"
    : > specialist-leads-present.txt
  fi
}

section_timer_start "corpus-building"
log "Building review corpus..."

log "Building PR-thread context..."
build_pr_thread_context

log "Building related-code context from full diff..."
build_related_code_context pr.diff pr-files.json

build_review_corpus "${REVIEW_CONTEXT_PROFILE:-primary}" primary
cp review-corpus.md review-corpus.truncated.md
section_timer_end

# ── Advisory specialist gate (#608/#609/#632), concurrent with CI (#634) ─
# The three fixed specialist roles (correctness / security / tests —
# pr_reviewer/specialists.py) run as a BACKGROUND JOB over a compact,
# independently bounded pre-final specialist corpus (#632) built from the
# artifacts collected so far, reusing the primary model settings but with an
# independent completion budget. The roles run concurrently WITH EACH OTHER
# (the runner fans them out on internal threads) and, since #634, concurrently
# with the CI gate. Both gates are fully reaped before the final corpus is
# rebuilt below — critically before the native_loop tool harness starts, so the
# final reviewer's FIRST tool-planning turn already sees the rendered leads and
# the finalized CI evidence. Fail-soft: a specialist that times out or fails is
# recorded as an error in the artifacts and the final reviewer still runs —
# never blocked, never aborted. Advisory only: specialist leads never touch
# enforcement, the verdict policy, or the published body directly; the final
# reviewer remains the sole verdict authority. When DEEP_REVIEW is false the
# specialist gate is not entered; when ci_status_check is false the CI gate is
# not entered — each normal path is preserved untouched (no artifacts, no
# corpus change — a fully disabled run stays byte-identical to a pre-#609
# build). 'auto' (#633) enters the same gate: run_specialists.py
# deterministically selects the roles from classification data (possibly
# zero) and skipped roles are telemetry, not failures — an empty selection
# leaves the corpus byte-identical to the disabled run.
section_timer_start "review-gates"
fork_specialist_gate
join_specialist_gate
join_ci_gate
section_timer_end

# Rebuild the corpus with both branches resolved. build_review_corpus reserves
# the "# Specialist Review Leads" block (appended last, after the ledger) and
# the CI Check Results section, so the rebuilt corpus carries finalized CI
# evidence plus any usable leads before the final review call and before
# native-loop planning. The rebuild runs whenever a gate was active — this
# guarantees a late CI result reaches the corpus even with no specialist leads
# — or when a rendered lead section appeared. When both gates are off, NO
# rebuild happens and disabled output stays byte-for-byte as before.
if [ "${CI_GATE_ACTIVE:-false}" == "true" ] || [ -s specialists.md ]; then
  log "review gates resolved: rebuilding corpus with finalized CI evidence and specialist leads"
  build_review_corpus "${REVIEW_CONTEXT_PROFILE:-primary}" primary
  cp review-corpus.md review-corpus.truncated.md
fi

# Substitute the specialist guidance fragment into the default system prompt
# (config.sh): substituted iff run_specialists.py left a non-empty
# specialist-leads-present.txt signal, so the final reviewer is told to
# verify/deduplicate the leads it can actually see; called unconditionally so
# the {{SPECIALIST_LEADS_GUIDANCE}} placeholder is stripped on every other
# path and never leaks to the model. Runs before the native_loop harness
# launches below, so its conversation inherits the guidance-substituted
# SYSTEM_PROMPT.
apply_specialist_leads_fragment

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
  build_review_corpus "${REVIEW_CONTEXT_PROFILE:-primary}" primary
  cp review-corpus.md review-corpus.truncated.md
fi
