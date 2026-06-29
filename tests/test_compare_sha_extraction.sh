#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Post-migration verification: the brittle grep pipelines have been moved to
# pr_reviewer/enrichment.py. This test verifies the shell no longer contains
# the fragile patterns, and that the Python module handles the same edge cases.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

echo "=== Test: context.sh no longer contains brittle compare-sha grep pipelines ==="
CONTEXT_SH="$ROOT_DIR/scripts/sections/context.sh"
check "no _old_sha grep pipeline in context.sh" \
  "$(grep -cE '_old_sha=\$\(grep' "$CONTEXT_SH" || true)" "0"
check "no _new_sha grep pipeline in context.sh" \
  "$(grep -cE '_new_sha=\$\(grep' "$CONTEXT_SH" || true)" "0"

echo ""
echo "=== Test: enrichment.sh is a thin wrapper around Python ==="
ENRICHMENT_SH="$ROOT_DIR/scripts/sections/enrichment.sh"
check "enrichment.sh delegates to run_enrichment.py" \
  "$(grep -q 'run_enrichment.py' "$ENRICHMENT_SH" && echo yes || echo no)" "yes"
check "enrichment.sh no longer has TARGET_VERSION grep pipeline" \
  "$(grep -cE 'TARGET_VERSION=\"\$\(' "$ENRICHMENT_SH" || true)" "0"

echo ""
echo "=== Test: pr_reviewer/enrichment.py exists and is importable ==="
python3 -c "from pr_reviewer.enrichment import select_target_version, extract_compare_shas" 2>/dev/null
check "enrichment.py module is importable" "$?" "0"

echo ""
echo "=== Test: Python handles no-SHA image bump (home-ops #7892 regression) ==="
RESULT=$(python3 -c "
from pr_reviewer.enrichment import extract_compare_shas, select_target_version

# No-SHA hints should return None, not raise
hints = ['-image: ghcr.io/defilantech/charts/llmkube:0.8.19', '+image: ghcr.io/defilantech/charts/llmkube:0.8.21']
result = extract_compare_shas(hints)
print('compare_shas:', result)

# No version in title AND no semver in hints should return ''
digest_hints = ['-digest: sha256:aaaa1111', '+digest: sha256:bbbb2222']
version = select_target_version('chore(container): update llama.cpp group', digest_hints)
print('target_version_empty:', len(version) == 0)
")
check "no-SHA hints produce None" "$(echo "$RESULT" | grep 'compare_shas: None')" "compare_shas: None"
check "no-title-version produces empty string" "$(echo "$RESULT" | grep 'target_version_empty: True')" "target_version_empty: True"

echo ""
echo "=== Test: Python handles valid SHA pair ==="
RESULT=$(python3 -c "
from pr_reviewer.enrichment import extract_compare_shas
hints = ['-tag: llmkube-1.2.3-abc1234', '+tag: llmkube-1.2.4-def89ab']
result = extract_compare_shas(hints)
print(result)
")
check "valid SHA pair extracted" "$RESULT" "('abc1234', 'def89ab')"

echo ""
echo "=== Test: Python fallback version hints ==="
RESULT=$(python3 -c "
from pr_reviewer.enrichment import select_target_version
version = select_target_version('chore(container): update llama.cpp group', ['+tag: app-1.2.3'])
print(version)
")
check "fallback version from hints" "$RESULT" "1.2.3"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
