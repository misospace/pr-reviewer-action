#!/usr/bin/env bash
# Corpus-truncation runner for the #662 dataflow parity boundary (#673).
#
# Runs the production truncate_clean implementation, sliced verbatim from
# scripts/sections/config.sh (same slice technique as
# tests/test_issue_662_dataflow.py), against one input file. The `vulnerable`
# variant reconstructs the pre-fix broken-arrow branch (#662 counterexample:
# the oversized-marker suffix exceeding the requested budget) by mutating only
# that write, so the harness can prove that wiring drift of this shape is
# detected rather than normalized away.
#
# Usage: truncate_clean.sh <production|vulnerable> <src> <dst> <max_bytes> <marker>
# Writes the truncated output to <dst>; exits nonzero only on runner failure.
set -euo pipefail

VARIANT="$1"
SRC="$2"
DST="$3"
MAX_BYTES="$4"
MARKER="$5"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

case "$VARIANT" in
  production|vulnerable) ;;
  *) echo "unknown variant: $VARIANT" >&2; exit 2 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

python3 - "$ROOT_DIR" "$VARIANT" "$WORK/slice.sh" <<'PYEOF'
from pathlib import Path
import sys

root, variant, out = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
source = (root / "scripts/sections/config.sh").read_text()
start = source.index("truncate_clean() {")
end = source.index("\nif [[ -z \"$REPO\"", start)
trunc = source[start:end]
if variant == "vulnerable":
    broken = trunc.replace(
        'open(dst, "wb").write(b"." * min(max_b, 3))',
        'open(dst, "wb").write(suffix)',
    )
    if broken == trunc:
        raise SystemExit("vulnerable mutation did not apply; production source changed")
    trunc = broken
out.write_text(trunc + "\n")
PYEOF

bash -euc "$(cat "$WORK/slice.sh")
truncate_clean \"\$1\" \"\$2\" \"\$3\" \"\$4\"" _ "$SRC" "$DST" "$MAX_BYTES" "$MARKER"
