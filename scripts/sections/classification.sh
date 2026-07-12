# shellcheck shell=bash
# Sourced by run_review.sh — image digests, repo impact/history, evidence providers, classification, model routing.
# Verbatim in-order slice of the former monolith (#307); relies on globals/helpers
# set up by the orchestrator. Not executable on its own.

section_timer_start "image-digests"
log "Gathering image digest provenance..."
# Advisory phase parallelized in #371: writes only image-digest-context.md
# (consumed later at build_review_corpus). Launched in the background here and
# harvested in corpus.sh; its output is buffered to a per-phase log. Failure
# handling is deferred to harvest_advisory_phases, preserving the old fallback.
python3 "$SCRIPT_DIR/image_digest_analysis.py" >image-digest.phase.log 2>&1 &
IMAGE_DIGEST_PID=$!
section_timer_end

section_timer_start "repo-impact-history"
log "Gathering repository impact and history..."
{
  jq -r '.title, (.body // "")' pr.json
  cat version-hints.truncated.txt 2>/dev/null || true
} \
  | tr '[:upper:]' '[:lower:]' \
  | grep -Eo '[a-z0-9][a-z0-9._/-]{2,}' \
  | grep -Ev '^(https?|from|into|that|this|with|without|renovate|pull|request|release|notes|digest|sha|main|chart|image|version|github|com|www|docker|ghcr|io)$' \
  | sort -u > terms.all.txt || true
head -n 14 terms.all.txt > terms.txt || true

# Read the (already deduped + capped) terms into an ordered array so the
# combined scan and the assembled output share one fixed term order.
impact_terms=()
while IFS= read -r term; do
  [ -n "$term" ] && impact_terms+=("$term")
done < terms.txt

if [ "${#impact_terms[@]}" -gt 0 ]; then
  # #371: collapse the former per-term scans (up to 14 × git grep + 14 × git log
  # = 28 sequential passes) into ONE combined worktree grep plus concurrent
  # history scans. Terms come from `grep -Eo '[a-z0-9._/-]{...}'`, so the only
  # ERE metacharacter they can contain is '.'; escaping it lets us combine them
  # into a single alternation that matches each term literally (and keeps one
  # term from corrupting the pattern). Output stays per-term attributable and
  # deterministic: attribution and assembly always follow impact_terms order.
  alt=""
  hist_pids=()
  for ti in "${!impact_terms[@]}"; do
    esc="$(printf '%s' "${impact_terms[$ti]}" | sed 's/\./\\./g')"
    if [ -z "$alt" ]; then alt="$esc"; else alt="$alt|$esc"; fi

    # Launch each bounded history scan concurrently; assembled in term order
    # below, so completion order never affects the deterministic output.
    {
      echo "## Term: ${impact_terms[$ti]}"
      echo
      echo "### git log context"
      echo '```text'
      git log --oneline --decorate --grep="${impact_terms[$ti]}" -n 10 2>/dev/null || true
      echo '```'
      echo
    } > "repo-history.part.$ti" &
    hist_pids+=("$!")
  done

  # ONE combined worktree scan instead of one `git grep` per term. -I skips
  # binary files: their `Binary file X matches` lines carry no line number, so
  # they cannot be content-attributed to a term in the combined model — and
  # they are pure noise in a text corpus. Every remaining line is `path:lineno:
  # content`, which re-attributes byte-exactly to the old per-term matching.
  git grep -nEI -e "$alt" -- . 2>/dev/null > repo-impact.combined.txt || true

  # Re-attribute the single combined result to each term in fixed order,
  # matching only the file CONTENT (after the `path:lineno:` prefix that
  # `git grep -n` prints) so attribution matches the old per-term grep, and
  # keeping the 60-hit cap per term.
  : > repo-impact.md
  for ti in "${!impact_terms[@]}"; do
    esc="$(printf '%s' "${impact_terms[$ti]}" | sed 's/\./\\./g')"
    {
      echo "## Term: ${impact_terms[$ti]}"
      echo
      echo "### git grep hits"
      echo '```text'
      awk -v pat="$esc" '
        {
          c=$0
          sub(/^[^:]*:[0-9]+:/, "", c)
          if (c ~ pat) {
            print
            if (++matches == 60) exit
          }
        }
      ' repo-impact.combined.txt
      echo '```'
      echo
    } >> repo-impact.md
  done

  # Reap the concurrent history scans, then assemble in fixed term order.
  for pid in "${hist_pids[@]}"; do
    wait "$pid" || true
  done
  : > repo-history.md
  for ti in "${!impact_terms[@]}"; do
    cat "repo-history.part.$ti" >> repo-history.md
    rm -f "repo-history.part.$ti"
  done
  rm -f repo-impact.combined.txt

  # These grep/log dumps are the lowest-value corpus sections (and on small PRs
  # can dwarf the actual change), so keep their caps tight.
  truncate_clean repo-impact.md repo-impact.truncated.md 24000 '…[impact scan truncated]'
  truncate_clean repo-history.md repo-history.truncated.md 12000 '…[history truncated]'
else
  echo "No candidate dependency terms extracted." > repo-impact.md
  echo "No candidate dependency terms extracted." > repo-history.md
  cp repo-impact.md repo-impact.truncated.md
  cp repo-history.md repo-history.truncated.md
fi
section_timer_end

section_timer_start "evidence-providers"
log "Running optional evidence providers..."
if gate_feature_for_forks "$EVIDENCE_ENABLE_FOR_FORKS" \
    evidence-providers.md "Evidence providers were skipped for a cross-repository pull request. Set evidence_enable_for_forks=true to override." \
    evidence-providers.json '{"configured": false, "has_blocker": false, "providers": [], "skipped": true, "skip_reason": "fork-pr"}'; then
  : # fork PR without evidence_enable_for_forks — skip artifacts already written
else
  # Advisory phase parallelized in #371: writes only evidence-providers.{md,json}
  # (consumed later at build_review_corpus). Launched in the background here and
  # harvested in corpus.sh. EVIDENCE_PID being set is the signal to harvest;
  # failure handling is deferred to harvest_advisory_phases, preserving the old
  # fallback exactly.
  python3 "$SCRIPT_DIR/run_evidence_providers.py" >evidence-providers.phase.log 2>&1 &
  EVIDENCE_PID=$!
fi
section_timer_end

section_timer_start "pr-classification"
log "Running deterministic PR classification..."
if python3 "$SCRIPT_DIR/../pr_reviewer/classifier.py" \
    --pr-files pr-files.json \
    --diff pr.diff.truncated \
    --linked-issues linked-issues.json \
    --output classification.json 2>/dev/null; then
  log "PR classification complete: $(jq -r '.pr_kind' classification.json 2>/dev/null || echo unknown)"
else
  log "PR classification failed; continuing without it"
  echo '{"pr_kind":"unknown","risk_flags":[],"changed_files_summary":[],"linked_issue_labels":[],"must_check":[]}' > classification.json
fi
section_timer_end

# ── Model routing (#159) ─────────────────────────────────────────────
# With review_routing_mode=auto, most PRs run on the PRIMARY model and PRs whose
# route_signals (pr_kind + risk_flags, excluding content-only pattern matches)
# match ESCALATE_ON_RISK_FLAGS go to the smart model when one is configured.
# Routing only rebinds which model the existing retry/fallback
# machinery talks to — that machinery is unchanged. (The primary model is fully
# capable; the route is not a "fast/dumb" lane, and it gets the full tool budget.)
resolve_review_route() {
  REVIEW_ROUTE="legacy"
  ROUTE_REASON="routing off"
  if [[ "$(printf '%s' "$REVIEW_ROUTING_MODE" | tr '[:upper:]' '[:lower:]')" != "auto" ]]; then
    return
  fi

  local signals candidates matched="" raw_flag flag
  # Match against route_signals: pr_kind + risk_flags, but EXCLUDING content-only
  # pattern matches — a diff that merely mentions os.path or `token` no longer
  # routes a benign PR to the smart model. Falls back to the old pr_kind+flags
  # union for classification JSON written before route_signals existed.
  signals="$(jq -r '
      (if has("route_signals") then (.route_signals // [])
       else ((.risk_flags // []) + [(.pr_kind // "")]) end)
      | map(select(. != "")) | join(",")
    ' classification.json 2>/dev/null || echo "")"
  candidates=",${signals},"

  IFS=',' read -ra _esc_flags <<< "$ESCALATE_ON_RISK_FLAGS"
  for raw_flag in "${_esc_flags[@]}"; do
    flag="$(printf '%s' "$raw_flag" | xargs)"
    [ -n "$flag" ] || continue
    if [[ "$candidates" == *",${flag},"* ]]; then
      matched="$flag"
      break
    fi
  done

  if [[ -n "$matched" ]]; then
    if [[ -n "$SMART_MODEL_RESOLVED" ]]; then
      REVIEW_ROUTE="smart"
      ROUTE_REASON="risk match: ${matched}"
    else
      REVIEW_ROUTE="primary"
      ROUTE_REASON="risk match: ${matched}, but no smart model configured"
    fi
  else
    REVIEW_ROUTE="primary"
    ROUTE_REASON="no escalation flags matched"
  fi
}

# The primary route is the default model (ai_model). ai_primary_* overrides it.
PRIMARY_BASE_URL="${AI_PRIMARY_BASE_URL:-$AI_BASE_URL}"
PRIMARY_MODEL="${AI_PRIMARY_MODEL:-$AI_MODEL}"
PRIMARY_API_FORMAT="${AI_PRIMARY_API_FORMAT:-$AI_API_FORMAT}"
PRIMARY_API_KEY="${AI_PRIMARY_API_KEY:-$AI_API_KEY}"
# Smart is an OPT-IN quality tier resolved ONLY from ai_smart_*. It deliberately
# does NOT borrow the fallback model: the fallback exists solely to catch a
# primary-availability failure, never as an escalation target. With no
# ai_smart_model set there is no smart lane — auto-routing stays on the primary
# model and nothing escalates. The endpoint/format/key default to the primary's
# (a smart model usually shares the endpoint); ai_smart_model alone is the gate.
SMART_MODEL="${AI_SMART_MODEL}"
SMART_BASE_URL="${AI_SMART_BASE_URL:-$AI_BASE_URL}"
SMART_API_FORMAT="${AI_SMART_API_FORMAT:-$AI_API_FORMAT}"
SMART_API_KEY="${AI_SMART_API_KEY:-$AI_API_KEY}"
SMART_MODEL_RESOLVED=""
if [[ -n "$SMART_MODEL" ]]; then
  SMART_MODEL_RESOLVED=1
fi

resolve_review_route
# Exported for the native-loop harness; the loop budget is the same on every
# route (the route selects the model, not the tool budget — see adaptive_loop_budgets).
export REVIEW_ROUTE
if [[ "$REVIEW_ROUTE" == "primary" ]]; then
  AI_BASE_URL="$PRIMARY_BASE_URL"
  AI_MODEL="$PRIMARY_MODEL"
  AI_API_FORMAT="$PRIMARY_API_FORMAT"
  AI_API_KEY="$PRIMARY_API_KEY"
elif [[ "$REVIEW_ROUTE" == "smart" ]]; then
  AI_BASE_URL="$SMART_BASE_URL"
  AI_MODEL="$SMART_MODEL"
  AI_API_FORMAT="$SMART_API_FORMAT"
  AI_API_KEY="$SMART_API_KEY"
fi
log "Review route: $REVIEW_ROUTE ($ROUTE_REASON) → $AI_MODEL"

# Tailor the default system prompt to this PR now that pr_kind / has_version_bump
# are known: drop the host-platform and image-digest guidance blocks when they
# do not apply, so they stop re-prefilling on every native_loop round (#258).
apply_system_prompt_fragments
