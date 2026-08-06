#!/usr/bin/env bash
set -euo pipefail

# The Standards Compliance output section is conditional on a standards file
# actually resolving, and the deterministic stripper runs in the publish step —
# a different step from the one that resolved the file. standards-present.txt is
# the signal that crosses that boundary.
#
# standards-context.md cannot serve as the signal: it always has content (an
# explicit "standards context unavailable" note when nothing resolved), so
# [ -s standards-context.md ] is true either way. These tests pin the marker's
# two properties the publish step depends on: non-empty exactly when a file
# resolved, and truncated (never stale) when one did not.

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown})" >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0; FAIL=0
# shellcheck source=_lib/assert.sh
source "$ROOT_DIR/tests/_lib/assert.sh"

# Extract the standards-context block from corpus.sh (top-level code, so it is
# lifted into a function here) and run it in isolation. A refactor that moves
# the block fails this extraction loudly rather than passing vacuously.
BLOCK="$(mktemp)"; trap 'rm -f "$BLOCK"' EXIT
python3 - "$SCRIPT_DIR/sections/corpus.sh" "$BLOCK" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"^: > standards-context\.md\n(.*?^fi\n)", src, re.S | re.M)
if not m:
    sys.exit("could not extract the standards-context block from corpus.sh")
open(sys.argv[2], "w").write(
    "build_standards_context() {\n: > standards-context.md\n%s\n}\n" % m.group(1)
)
PY
# shellcheck source=/dev/null
source "$BLOCK"

WORK="$(mktemp -d)"; trap 'rm -f "$BLOCK"; rm -rf "$WORK"' EXIT

echo "=== a resolved standards file records its path as the presence signal ==="
OUT="$( cd "$WORK"
  printf '# rules\nscope every selector\n' > AGENTS.md
  STANDARDS_FILE="AGENTS.md"
  build_standards_context
  printf 'marker=[%s] context_has_rules=%s' \
    "$(cat standards-present.txt)" \
    "$(grep -qF 'scope every selector' standards-context.md && echo yes || echo no)" )"
check_contains "marker holds the resolved path" "$OUT" "marker=[AGENTS.md]"
check_contains "corpus still carries the standards body" "$OUT" "context_has_rules=yes"

echo "=== no standards file leaves the signal empty but the corpus non-empty ==="
OUT="$( cd "$WORK"
  rm -f AGENTS.md standards-present.txt standards-context.md
  STANDARDS_FILE=""
  build_standards_context
  marker_size="$(wc -c < standards-present.txt | tr -d ' ')"
  context_size="$(wc -c < standards-context.md | tr -d ' ')"
  printf 'marker_size=%s context_size_gt_zero=%s' \
    "$marker_size" \
    "$([ "$context_size" -gt 0 ] && echo yes || echo no)" )"
check_contains "presence signal is empty" "$OUT" "marker_size=0"
# This is the reason a separate marker file exists at all: the corpus file is
# never empty, so it cannot distinguish "no standards" from "standards".
check_contains "corpus file is still non-empty (the unavailable note)" \
  "$OUT" "context_size_gt_zero=yes"

echo "=== an unresolvable configured path is 'absent', not 'present' ==="
OUT="$( cd "$WORK"
  rm -f standards-present.txt standards-context.md
  STANDARDS_FILE="does/not/exist.md"
  build_standards_context
  printf 'marker_size=%s' "$(wc -c < standards-present.txt | tr -d ' ')" )"
check_contains "missing configured file yields an empty signal" "$OUT" "marker_size=0"

echo "=== a stale marker from a previous run is truncated, not inherited ==="
# Persistent self-hosted runners reuse the workspace: a marker left by an
# earlier PR that did have a standards file must not make this run look present.
OUT="$( cd "$WORK"
  printf 'AGENTS.md\n' > standards-present.txt
  rm -f standards-context.md
  STANDARDS_FILE=""
  build_standards_context
  printf 'marker_size=%s' "$(wc -c < standards-present.txt | tr -d ' ')" )"
check_contains "stale marker is cleared" "$OUT" "marker_size=0"

echo "=== publish_helpers reads the signal it is given ==="
check_contains "publish gates on the marker file" \
  "$(<"$SCRIPT_DIR/publish_helpers.sh")" "if [ -s standards-present.txt ]"
check_contains "publish exports STANDARDS_PRESENT to the stripper" \
  "$(<"$SCRIPT_DIR/publish_helpers.sh")" 'STANDARDS_PRESENT="$standards_present"'
check_contains "the marker is symlink-guarded like every other artifact" \
  "$(<"$SCRIPT_DIR/artifact_paths.sh")" "standards-present.txt"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
