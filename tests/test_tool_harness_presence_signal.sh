#!/usr/bin/env bash
set -euo pipefail

# The Tool Harness Findings section is conditional on the harness producing
# output, and tool-harness.md is the signal for it on both sides: corpus.sh
# gates the corpus header on it, and the publish step gates the deterministic
# stripper on the same file.
#
# The distinction that matters is between "no harness output" (tool_mode=off,
# empty file, no section) and "the harness had something to say": the
# native_loop planning placeholder, the fork skip, and the failure stub all
# carry text and must keep their section. Gating on the file rather than on
# TOOL_MODE is what keeps those three working.

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown})" >&2
  exit 0
fi

# Dependency preflight
for dep in python3; do
  if ! command -v "$dep" &>/dev/null; then
    echo "SKIP: $dep is not available — cannot run test_tool_harness_presence_signal.sh" >&2
    exit 0
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0; FAIL=0
# shellcheck source=_lib/assert.sh
source "$ROOT_DIR/tests/_lib/assert.sh"

# Lift the default-harness block out of corpus.sh and run it in isolation, the
# same idiom test_standards_presence_signal.sh uses. A refactor that moves the
# block fails this extraction loudly rather than passing vacuously.
BLOCK="$(mktemp)"; trap 'rm -f "$BLOCK"' EXIT
python3 - "$SCRIPT_DIR/sections/corpus.sh" "$BLOCK" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(
    r"^(case \"\$\(printf '%s' \"\$TOOL_MODE\".*?tool-harness\.md.*?^esac\n"
    r"\nif \[ ! -f tool-harness\.json \]; then\n.*?^fi)$",
    src, re.S | re.M,
)
if not m:
    sys.exit("could not extract the tool-harness default block from corpus.sh")
open(sys.argv[2], "w").write("default_tool_harness() {\n%s\n}\n" % m.group(1))
PY
# shellcheck source=/dev/null
source "$BLOCK"

WORK="$(mktemp -d)"; trap 'rm -f "$BLOCK"; rm -rf "$WORK"' EXIT

echo "=== tool_mode=off produces no harness output ==="
OUT="$( cd "$WORK"
  rm -f tool-harness.md
  TOOL_MODE="off"
  default_tool_harness
  printf 'size=%s' "$(wc -c < tool-harness.md | tr -d ' ')" )"
check_contains "off leaves the file empty" "$OUT" "size=0"

echo "=== native_loop keeps its planning placeholder (#101/#108) ==="
OUT="$( cd "$WORK"
  rm -f tool-harness.md
  TOOL_MODE="native_loop"
  default_tool_harness
  printf 'body=[%s]' "$(cat tool-harness.md)" )"
check_contains "planning placeholder survives" "$OUT" "body=[Tool harness planning pending.]"

echo "=== an unrecognised mode is treated as off, not as output ==="
# corpus.sh only enables the harness for the literal native_loop, so any other
# value must land on the empty branch rather than inventing a section.
OUT="$( cd "$WORK"
  rm -f tool-harness.md
  TOOL_MODE="plan_execute_once"
  default_tool_harness
  printf 'size=%s' "$(wc -c < tool-harness.md | tr -d ' ')" )"
check_contains "unknown mode leaves the file empty" "$OUT" "size=0"

echo "=== a reused workspace's empty file still gets the planning placeholder ==="
# off-mode now leaves an empty file behind, so a later native_loop run in the
# same workspace would find the file present but empty. Testing -f rather than
# -s here would leave the planner with no section and the verdict turn with
# nothing to substitute into.
OUT="$( cd "$WORK"
  : > tool-harness.md
  TOOL_MODE="native_loop"
  default_tool_harness
  printf 'body=[%s]' "$(cat tool-harness.md)" )"
check_contains "empty file is re-initialised for native_loop" \
  "$OUT" "body=[Tool harness planning pending.]"

echo "=== a stale file from a previous run cannot pose as this review ==="
OUT="$( cd "$WORK"
  printf 'Tool harness results from an earlier run\n' > tool-harness.md
  TOOL_MODE="off"
  default_tool_harness
  printf 'size=%s' "$(wc -c < tool-harness.md | tr -d ' ')" )"
check_contains "off truncates a stale harness file" "$OUT" "size=0"

echo "=== an existing file is never overwritten by the default ==="
# The harness itself writes tool-harness.md; the default only fills a gap.
OUT="$( cd "$WORK"
  printf 'real harness output\n' > tool-harness.md
  TOOL_MODE="native_loop"
  default_tool_harness
  printf 'body=[%s]' "$(cat tool-harness.md)" )"
check_contains "real output is preserved" "$OUT" "body=[real harness output]"

echo "=== off resets a stale JSON artifact, not just the Markdown ==="
# The reused-workspace case for the JSON half. escalation.py reads planning_error
# and error out of this file and the step summary reports its counts, usage and
# evidence digest, so a file left by an earlier native_loop run would escalate a
# review that ran no tools and attribute the previous run's telemetry to it.
OUT="$( cd "$WORK"
  rm -f tool-harness.md
  cat > tool-harness.json <<'STALE'
{"mode":"native_loop","planned_request_count":7,"executed_request_count":4,
 "tool_results":[{"tool":"read_file","status":"error"}],
 "planning_error":"boom","error":"execution failed",
 "usage":{"prompt_tokens":91234,"completion_tokens":2048,"cache_hit_ratio":0.62},
 "evidence_digest":"carried over from the previous review"}
STALE
  TOOL_MODE="off"
  default_tool_harness
  printf 'json=[%s]' "$(tr -d ' \n' < tool-harness.json)" )"
check_contains "stale planning_error is gone" "$OUT" '"mode":"off"'
[ "${OUT#*planning_error}" = "$OUT" ] \
  && { echo "  PASS: stale planning_error cleared"; PASS=$((PASS+1)); } \
  || { echo "  FAIL: stale planning_error survived off mode"; FAIL=$((FAIL+1)); }
[ "${OUT#*evidence_digest}" = "$OUT" ] \
  && { echo "  PASS: stale evidence digest cleared"; PASS=$((PASS+1)); } \
  || { echo "  FAIL: stale evidence digest survived off mode"; FAIL=$((FAIL+1)); }
[ "${OUT#*\"executed_request_count\":4}" = "$OUT" ] \
  && { echo "  PASS: stale call counts cleared"; PASS=$((PASS+1)); } \
  || { echo "  FAIL: stale call counts survived off mode"; FAIL=$((FAIL+1)); }

echo "=== native_loop keeps a JSON artifact it did not write ==="
# Only off resets it. The harness writes this file itself, and the default here
# fills a gap rather than clobbering a real run.
OUT="$( cd "$WORK"
  rm -f tool-harness.md
  printf '{"mode":"native_loop","executed_request_count":3}\n' > tool-harness.json
  TOOL_MODE="native_loop"
  default_tool_harness
  printf 'json=[%s]' "$(tr -d ' \n' < tool-harness.json)" )"
check_contains "real harness JSON is preserved" "$OUT" '"executed_request_count":3'

echo "=== the corpus gates the header on the file, not on TOOL_MODE ==="
check_contains "corpus.sh gates the Tool Harness header" \
  "$(<"$SCRIPT_DIR/sections/corpus.sh")" 'if [ -s "$harness_file" ]; then'

echo "=== publish_helpers reads the signal it is given ==="
check_contains "publish gates on the harness file" \
  "$(<"$SCRIPT_DIR/publish_helpers.sh")" "if [ -s tool-harness.md ]"
check_contains "publish exports TOOL_HARNESS_PRESENT to the stripper" \
  "$(<"$SCRIPT_DIR/publish_helpers.sh")" 'TOOL_HARNESS_PRESENT="$tool_harness_present"'
check_contains "the stripper knows the findings heading" \
  "$(<"$SCRIPT_DIR/strip_empty_conditional_sections.py")" '"tool_harness_findings": "tool harness findings"'
check_contains "the stripper knows the results heading" \
  "$(<"$SCRIPT_DIR/strip_empty_conditional_sections.py")" '"tool_harness_results": "tool harness results"'
check_contains "the harness file is symlink-guarded like every other artifact" \
  "$(<"$SCRIPT_DIR/artifact_paths.sh")" "tool-harness.md"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
