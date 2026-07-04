# shellcheck shell=bash
# Sourced by run_review.sh — linked-source enrichment (delegates to Python).
# The brittle grep/sed extraction and rendering pipelines have been moved to
# scripts/run_enrichment.py for deterministic, testable behavior (#7892).

section_timer_start "enrichment"
log "Gathering linked sources..."

# Advisory phase parallelized in #371: this only writes the linked-sources.md
# file (consumed later at build_review_corpus), so we launch it in the
# background here and harvest it in corpus.sh before the corpus is built. Its
# stdout/stderr is buffered to a per-phase log so interleaved output with the
# other background phases stays attributable. Failure handling is deferred to
# harvest_advisory_phases, preserving the old fallback exactly.
python3 "$SCRIPT_DIR/run_enrichment.py" >enrichment.phase.log 2>&1 &
ENRICHMENT_PID=$!

section_timer_end
