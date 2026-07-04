#!/usr/bin/env bash
set -euo pipefail

# Wiring assertions for #371: the independent advisory context-gathering phases
# (linked-source enrichment, image-digest provenance, evidence providers) must
# run as background jobs and be harvested before the corpus is built, and the
# classification repo-impact scan must use a single combined git grep instead of
# one pass per term. These are static grep checks (same idiom as
# test_review_routing.sh) — the sections rely on orchestrator globals and are
# not executable standalone.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

ENRICHMENT="$(cat "$ROOT_DIR/scripts/sections/enrichment.sh")"
CLASSIFICATION="$(cat "$ROOT_DIR/scripts/sections/classification.sh")"
COMMON="$(cat "$ROOT_DIR/scripts/sections/common.sh")"
CORPUS="$(cat "$ROOT_DIR/scripts/sections/corpus.sh")"

echo "=== Test: advisory phases launched in the background ==="
check_contains "enrichment.py runs as a background job" \
  "$ENRICHMENT" 'run_enrichment.py" >enrichment.phase.log 2>&1 &'
check_contains "enrichment records its pid" "$ENRICHMENT" 'ENRICHMENT_PID=$!'
check_contains "image digest runs as a background job" \
  "$CLASSIFICATION" 'image_digest_analysis.py" >image-digest.phase.log 2>&1 &'
check_contains "image digest records its pid" "$CLASSIFICATION" 'IMAGE_DIGEST_PID=$!'
check_contains "evidence providers run as a background job" \
  "$CLASSIFICATION" 'run_evidence_providers.py" >evidence-providers.phase.log 2>&1 &'
check_contains "evidence records its pid" "$CLASSIFICATION" 'EVIDENCE_PID=$!'

echo ""
echo "=== Test: advisory phases harvested before the corpus is built ==="
check_contains "harvest waits on the enrichment pid" "$COMMON" 'wait "$ENRICHMENT_PID"'
check_contains "harvest waits on the image-digest pid" "$COMMON" 'wait "$IMAGE_DIGEST_PID"'
check_contains "harvest waits on the evidence pid" "$COMMON" 'wait "$EVIDENCE_PID"'
# Advisory failure must degrade, never abort: waits are guarded with || status=$?.
check_contains "harvest guards wait status against set -e" "$COMMON" '|| status=$?'
# Fallbacks preserved verbatim from the old sequential guards.
check_contains "harvest keeps the enrichment fallback" \
  "$COMMON" 'WARNING: enrichment.py failed, producing empty linked-sources.md'
check_contains "harvest keeps the image-digest fallback" \
  "$COMMON" 'Image digest provenance analysis failed for this run.'
check_contains "harvest keeps the evidence fallback" \
  "$COMMON" 'Evidence providers failed to run in this review.'
check "corpus harvests exactly once before building" \
  "$(grep -c 'harvest_advisory_phases' "$ROOT_DIR/scripts/sections/corpus.sh")" "1"

echo ""
echo "=== Test: repo-impact uses ONE combined git grep, not per-term ==="
# Exactly one git grep command (the combined -E alternation); the old
# per-term `git grep -n -- "$term"` must be gone.
check "single combined git grep command in classification" \
  "$(grep -c 'git grep -nEI -e' "$ROOT_DIR/scripts/sections/classification.sh")" "1"
check_contains "combined grep uses an escaped -E alternation" \
  "$CLASSIFICATION" 'git grep -nEI -e "$alt"'
check_not_contains "no per-term git grep remains" \
  "$CLASSIFICATION" 'git grep -n -- "$term"'
check_contains "history scans run concurrently and are reaped" \
  "$CLASSIFICATION" 'wait "$pid"'

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
