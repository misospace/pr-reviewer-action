# shellcheck shell=bash
# Sourced by run_review.sh — logging, sed wrapper, section timers.
# Verbatim in-order slice of the former monolith (#307); relies on globals/helpers
# set up by the orchestrator. Not executable on its own.

log() {
  echo "[$(date +'%Y-%m-%dT%H:%M:%S%z')] $1"
}

error() {
  log "ERROR: $1" >&2
}

sedi() {
  local expr="$1"
  local target="$2"
  if sed --version >/dev/null 2>&1; then
    sed -i "$expr" "$target"
  else
    sed -i '' "$expr" "$target"
  fi
}

# Timing helpers for per-section performance logging
SECTION_TIMERS=()
section_timer_start() {
  local name="$1"
  SECTION_TIMERS+=("${name}:$(date +%s)")
}
section_timer_end() {
  local elapsed
  local last="${SECTION_TIMERS[-1]}"
  local name="${last%%:*}"
  local start_ts="${last##*:}"
  elapsed=$(( $(date +%s) - start_ts ))
  log "PERF: section=$name elapsed=${elapsed}s"
}

# Harvest the advisory background phases (#371) launched in enrichment.sh and
# classification.sh: linked-source enrichment, image-digest provenance, and the
# evidence providers. None consumes another's output — each only writes files
# read together later at build_review_corpus — so they run concurrently and are
# reaped here before the corpus is built. We PARALLELIZE THE FETCH, never the
# render order, so the corpus stays byte-deterministic. Each phase is advisory:
# `wait` returns the job's exit status (guarded with `|| status=$?` so a nonzero
# code cannot trip `set -e`), and on failure we apply the SAME fallback the old
# sequential guards did. Per-phase logs are echoed in a FIXED order so
# interleaved output stays attributable.
harvest_advisory_phases() {
  local status

  status=0
  wait "$ENRICHMENT_PID" || status=$?
  cat enrichment.phase.log 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    log "WARNING: enrichment.py failed, producing empty linked-sources.md"
    : > linked-sources.md
  fi

  status=0
  wait "$IMAGE_DIGEST_PID" || status=$?
  cat image-digest.phase.log 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    error "Image digest analysis failed"
    echo "Image digest provenance analysis failed for this run." > image-digest-context.md
  fi

  # EVIDENCE_PID is unset when the evidence phase was skipped by the fork gate
  # (its skip artifacts are already written) — nothing to harvest in that case.
  if [ -n "${EVIDENCE_PID:-}" ]; then
    status=0
    wait "$EVIDENCE_PID" || status=$?
    cat evidence-providers.phase.log 2>/dev/null || true
    if [ "$status" -ne 0 ]; then
      error "Evidence provider execution failed"
      cat > evidence-providers.md <<'EOF'
Evidence providers failed to run in this review.
EOF
      cat > evidence-providers.json <<'EOF'
{"configured": false, "has_blocker": false, "providers": [], "error": "execution failed"}
EOF
    fi
  fi
}

# Fork gate for a per-feature capability that runs untrusted PR content (#370).
# When the PR is a fork and the feature is not explicitly enabled for forks,
# write the paired skip artifacts (.md + .json) and return 0 (gated → skip).
# Otherwise write nothing and return 1 (caller runs the feature). Consumes the
# fail-closed $IS_FORK_PR resolved once in context.sh.
#
# Args: $1 enable-for-forks flag value  $2 md path   $3 md content
#       $4 json path                    $5 json content
gate_feature_for_forks() {
  local enable_flag="$1" md_path="$2" md_content="$3" json_path="$4" json_content="$5"
  if [[ "${IS_FORK_PR:-}" == "true" ]] \
    && [[ "$(printf '%s' "$enable_flag" | tr '[:upper:]' '[:lower:]')" != "true" ]]; then
    printf '%s\n' "$md_content" > "$md_path"
    printf '%s\n' "$json_content" > "$json_path"
    return 0
  fi
  return 1
}
