# shellcheck shell=bash
# Sourced by run_review.sh — linked-source enrichment (delegates to Python).
# The brittle grep/sed extraction and rendering pipelines have been moved to
# scripts/run_enrichment.py for deterministic, testable behavior (#7892).

section_timer_start "enrichment"
log "Gathering linked sources..."

python3 "$SCRIPT_DIR/run_enrichment.py" || {
  log "WARNING: enrichment.py failed, producing empty linked-sources.md"
  : > linked-sources.md
}

section_timer_end
