#!/usr/bin/env bash
set -euo pipefail

# Tests for conditional system-prompt assembly (#258): the bundled default
# prompt carries PR-type placeholders that apply_system_prompt_fragments
# substitutes (or drops) based on the classification, so irrelevant guidance
# stops re-prefilling on every native_loop round.

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown})" >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0; FAIL=0
# shellcheck source=_lib/assert.sh
source "$ROOT_DIR/tests/_lib/assert.sh"

# Extract apply_system_prompt_fragments from config.sh (same pattern as the
# other section-function tests).
FUNCS="$(mktemp)"; trap 'rm -f "$FUNCS"' EXIT
python3 - "$SCRIPT_DIR/sections/config.sh" "$FUNCS" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"^apply_system_prompt_fragments\(\) \{\n(.*?)\n\}", src, re.S | re.M)
if not m:
    sys.exit("could not extract apply_system_prompt_fragments")
open(sys.argv[2], "w").write("apply_system_prompt_fragments() {\n%s\n}\n" % m.group(1))
PY
# shellcheck source=/dev/null
source "$FUNCS"

WORK="$(mktemp -d)"; trap 'rm -f "$FUNCS"; rm -rf "$WORK"' EXIT
BASE="$(<"$SCRIPT_DIR/default_system_prompt.txt")"

# Run the assembler for a given pr_kind, echo the resulting prompt.
assemble() {
  local kind="$1"
  ( cd "$WORK"
    printf '{"pr_kind":"%s"}' "$kind" > classification.json
    SYSTEM_PROMPT="$BASE" SYSTEM_PROMPT_IS_DEFAULT=1
    apply_system_prompt_fragments
    printf '%s' "$SYSTEM_PROMPT" )
}

echo "=== k8s_manifest (the Talos founding case) keeps host-platform guidance ==="
OUT="$(assemble k8s_manifest)"
check_contains "k8s_manifest includes HOST PLATFORM block" "$OUT" "HOST PLATFORM"
check_not_contains "no unsubstituted placeholder remains" "$OUT" "{{"

echo "=== dependency_upgrade keeps host-platform guidance ==="
OUT="$(assemble dependency_upgrade)"
check_contains "dependency_upgrade includes HOST PLATFORM block" "$OUT" "HOST PLATFORM"

echo "=== app_code shaves the host-platform + digest guidance ==="
OUT="$(assemble app_code)"
check_not_contains "app_code drops HOST PLATFORM block" "$OUT" "HOST PLATFORM"
check_not_contains "app_code drops digest block" "$OUT" "digest-only image"
check_not_contains "no placeholder remains" "$OUT" "{{"
check_contains "base output schema preserved" "$OUT" "Return STRICT JSON"

echo "=== renovate_digest_only includes digest guidance, not host-platform ==="
OUT="$(assemble renovate_digest_only)"
check_contains "digest PR includes digest block" "$OUT" "digest-only image"
check_not_contains "digest PR drops HOST PLATFORM block" "$OUT" "HOST PLATFORM"
check_not_contains "no placeholder remains" "$OUT" "{{"

echo "=== bump path is byte-identical to the pre-split prompt ==="
VB="$(<"$SCRIPT_DIR/prompt_fragments/version_bump.txt") "
DG="$(<"$SCRIPT_DIR/prompt_fragments/image_digest.txt") "
RECON="${BASE/\{\{VERSION_BUMP_GUIDANCE\}\}/$VB}"
RECON="${RECON/\{\{IMAGE_DIGEST_GUIDANCE\}\}/$DG}"
check_contains "reconstructed prompt has both guidance blocks" "$RECON" "HOST PLATFORM"
check_contains "reconstructed prompt has digest block" "$RECON" "digest-only image"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
