# shellcheck shell=bash
# Sourced by run_review.sh — image digests, repo impact/history, evidence providers, classification, model routing.
# Verbatim in-order slice of the former monolith (#307); relies on globals/helpers
# set up by the orchestrator. Not executable on its own.

section_timer_start "image-digests"
log "Gathering image digest provenance..."
if ! python3 "$SCRIPT_DIR/image_digest_analysis.py"; then
  error "Image digest analysis failed"
  echo "Image digest provenance analysis failed for this run." > image-digest-context.md
fi
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

: > repo-impact.md
: > repo-history.md

if [ -s terms.txt ]; then
  while IFS= read -r term; do
    [ -z "$term" ] && continue

    {
      echo "## Term: $term"
      echo
      echo "### git grep hits"
      echo '```text'
      git grep -n -- "$term" -- . 2>/dev/null | head -n 60 || true
      echo '```'
      echo
    } >> repo-impact.md

    {
      echo "## Term: $term"
      echo
      echo "### git log context"
      echo '```text'
      git log --oneline --decorate --grep="$term" -n 10 || true
      echo '```'
      echo
    } >> repo-history.md
  done < terms.txt

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
if [[ "$IS_FORK_PR" == "true" ]] && [[ "$(printf '%s' "$EVIDENCE_ENABLE_FOR_FORKS" | tr '[:upper:]' '[:lower:]')" != "true" ]]; then
  cat > evidence-providers.md <<'EOF'
Evidence providers were skipped for a cross-repository pull request. Set evidence_enable_for_forks=true to override.
EOF
  cat > evidence-providers.json <<'EOF'
{"configured": false, "has_blocker": false, "providers": [], "skipped": true, "skip_reason": "fork-pr"}
EOF
else
  if ! python3 "$SCRIPT_DIR/run_evidence_providers.py"; then
    error "Evidence provider execution failed"
    cat > evidence-providers.md <<'EOF'
Evidence providers failed to run in this review.
EOF
    cat > evidence-providers.json <<'EOF'
{"configured": false, "has_blocker": false, "providers": [], "error": "execution failed"}
EOF
  fi
fi
section_timer_end

section_timer_start "pr-classification"
log "Running deterministic PR classification..."
if python3 "$SCRIPT_DIR/../pr_reviewer/classifier.py" \
    --pr-files pr-files.json \
    --diff pr.diff.truncated \
    --body pr-body.txt \
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
# pr_kind or risk_flags match ESCALATE_ON_RISK_FLAGS go to the smart model when
# one is configured. Routing only rebinds which model the existing retry/fallback
# machinery talks to — that machinery is unchanged. (The primary model is fully
# capable; the route is not a "fast/dumb" lane, and it gets the full tool budget.)
resolve_review_route() {
  REVIEW_ROUTE="legacy"
  ROUTE_REASON="routing off"
  if [[ "$(printf '%s' "$REVIEW_ROUTING_MODE" | tr '[:upper:]' '[:lower:]')" != "auto" ]]; then
    return
  fi

  local kind flags candidates matched="" raw_flag flag
  kind="$(jq -r '.pr_kind // ""' classification.json 2>/dev/null || echo "")"
  flags="$(jq -r '(.risk_flags // []) | join(",")' classification.json 2>/dev/null || echo "")"
  # Match against the union of pr_kind and risk_flags: the default escalation
  # list mixes kind names (auth_changes, ...) and flag names (linked_*).
  candidates=",${kind},${flags},"

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
