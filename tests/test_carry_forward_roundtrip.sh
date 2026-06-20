#!/usr/bin/env bash
set -uo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# End-to-end round trip for carried-forward findings (#193):
#   publish (build_metadata_marker, FINDINGS env)
#     → precheck (extract_review_metadata → previous-findings.json)
#       → review (load_carried_findings ids + sanitization)
# Uses the REAL code at each hop — the publish helper sourced directly and the
# precheck function extracted verbatim from check_review_needed.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

TMP="$(mktemp -d)"
FUNC="$TMP/extract.sh"
trap 'rm -rf "$TMP"' EXIT

# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/publish_helpers.sh"

# Extract extract_review_metadata verbatim from the precheck script.
python3 - "$ROOT_DIR/scripts/check_review_needed.sh" "$FUNC" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"^extract_review_metadata\(\) \{\n(.*?)\n\}", src, re.S | re.M)
if not m:
    sys.exit("could not extract extract_review_metadata")
open(sys.argv[2], "w").write("extract_review_metadata() {\n%s\n}\n" % m.group(1))
PY
# shellcheck source=/dev/null
source "$FUNC"

echo "=== Publish: marker persists open findings ==="
FINDINGS='[
  {"severity":"blocker","category":"security","file":"auth.go","line":10,"message":"token not validated","id":"P1","resolution":"still_open"},
  {"severity":"minor","category":"style","file":null,"line":null,"message":"naming nit"},
  {"severity":"major","category":"bug","file":"x.py","line":3,"message":"was fixed","id":"P2","resolution":"resolved"}
]'
MARKER="$(HEAD_SHA=abc123 EFFECTIVE_SCOPE=full REVIEW_RESULT=issues FINDINGS="$FINDINGS" build_metadata_marker "b" "")"
check_contains "marker carries open_findings" "$MARKER" '"open_findings":'
check_contains "unresolved blocker persisted" "$MARKER" "token not validated"
check_not_contains "resolved finding filtered out of the marker" "$MARKER" "was fixed"

MARKER_CLEAN="$(HEAD_SHA=h EFFECTIVE_SCOPE=full REVIEW_RESULT=clean FINDINGS="$FINDINGS" build_metadata_marker "b" "")"
check_not_contains "clean reviews persist no findings" "$MARKER_CLEAN" "open_findings"

MARKER_BADF="$(HEAD_SHA=h EFFECTIVE_SCOPE=full REVIEW_RESULT=issues FINDINGS='not json' build_metadata_marker "b" "")"
check_not_contains "malformed FINDINGS tolerated" "$MARKER_BADF" "open_findings"
check_contains "malformed FINDINGS still yields a marker" "$MARKER_BADF" '"review_result":"issues"'

echo ""
echo "=== Precheck: extraction writes sanitized previous-findings.json ==="
cd "$TMP"
ln -sf "$ROOT_DIR/pr_reviewer" pr_reviewer
BODY="$(printf '<!-- ai-pr-reviewer -->\n%s\n# AI Automated Review\nbody' "$MARKER")"
extract_review_metadata "$BODY"
check "head sha extracted alongside findings" "$LAST_HEAD_SHA" "abc123"
COUNT="$(jq 'length' previous-findings.json)"
check "both unresolved findings extracted" "$COUNT" "2"
check "severity survives the round trip" "$(jq -r '.[0].severity' previous-findings.json)" "blocker"
check "file/line survive the round trip" "$(jq -r '.[0].file + ":" + (.[0].line|tostring)' previous-findings.json)" "auth.go:10"

# Hostile marker: control characters and HTML stripped, oversized list capped.
HOSTILE='<!-- ai-pr-reviewer:{"version":1,"head_sha":"abc","base_sha":"b","review_scope":"full","review_result":"issues","open_findings":['
for i in $(seq 1 30); do
  HOSTILE+='{"severity":"blocker","message":"<script>x</script>finding '"$i"'"},'
done
HOSTILE="${HOSTILE%,}]} -->"
extract_review_metadata "$HOSTILE"
check "hostile list capped at 20" "$(jq 'length' previous-findings.json)" "20"
check_not_contains "angle brackets stripped from messages" "$(cat previous-findings.json)" "<script>"

echo ""
echo "=== Review: load_carried_findings consumes the precheck output ==="
extract_review_metadata "$BODY"
LOADED="$(PYTHONPATH="$ROOT_DIR" python3 -c "
from pr_reviewer.carry_forward import load_carried_findings
items = load_carried_findings()
print(';'.join(f\"{i['id']}:{i['severity']}\" for i in items))
")"
check "carried findings get sequential ids" "$LOADED" "P1:blocker;P2:minor"

echo ""
echo "=== Cross-run evidence memory: marker persists → precheck extracts → load reuses ==="
# build_metadata_marker carries the evidence digest, tagged with HEAD_SHA.
MARKER_EV="$(HEAD_SHA=deadbeef EFFECTIVE_SCOPE=full REVIEW_RESULT=clean EVIDENCE_DIGEST="- read_file → installer:v1.13.4" build_metadata_marker "b" "")"
check_contains "marker carries evidence_digest" "$MARKER_EV" '"evidence_digest":'
check_contains "digest content persisted" "$MARKER_EV" "installer:v1.13.4"

# Disabled → omitted even when a digest was produced.
MARKER_EVOFF="$(HEAD_SHA=h EFFECTIVE_SCOPE=full REVIEW_RESULT=clean EVIDENCE_DIGEST="x" TOOL_EVIDENCE_MEMORY=false build_metadata_marker "b" "")"
check_not_contains "evidence memory off omits the digest" "$MARKER_EVOFF" "evidence_digest"

# No digest (non-native / nothing gathered) → no field.
MARKER_EVEMPTY="$(HEAD_SHA=h EFFECTIVE_SCOPE=full REVIEW_RESULT=clean build_metadata_marker "b" "")"
check_not_contains "no digest yields no evidence_digest field" "$MARKER_EVEMPTY" "evidence_digest"

# Precheck extracts it into previous-evidence.json, tagged with the gathered-at sha.
BODY_EV="$(printf '<!-- ai-pr-reviewer -->\n%s\n# AI Automated Review\nbody' "$MARKER_EV")"
extract_review_metadata "$BODY_EV"
check_contains "previous-evidence.json carries the digest" "$(jq -r '.digest' previous-evidence.json)" "installer:v1.13.4"
check "evidence tagged with the gathered-at sha" "$(jq -r '.head_sha' previous-evidence.json)" "deadbeef"

# Review side: load + render reuse it in the corpus.
RENDERED_EV="$(PYTHONPATH="$ROOT_DIR" python3 -c "
from pr_reviewer.evidence_memory import load_evidence_memory, render_evidence_memory_section
print(render_evidence_memory_section(load_evidence_memory()), end='')
")"
check_contains "rendered section reuses the digest" "$RENDERED_EV" "installer:v1.13.4"
check_contains "rendered section tags the gathered-at sha" "$RENDERED_EV" "deadbeef"

# Hostile digest: a control char (BELL 0x07) and HTML must be stripped by the
# precheck's shell-embedded regex BEFORE the file is written (the regex doubling
# is correct inside bash's double-quoted python3 -c string — this guards it).
DIGEST_HOSTILE="$(printf 'fact v1.13.4 \007 <script>alert(1)</script> end')"
MARKER_HOSTILE="$(HEAD_SHA=h EFFECTIVE_SCOPE=full REVIEW_RESULT=clean EVIDENCE_DIGEST="$DIGEST_HOSTILE" build_metadata_marker "b" "")"
BODY_HOSTILE="$(printf '<!-- ai-pr-reviewer -->\n%s\n# AI Automated Review\nbody' "$MARKER_HOSTILE")"
extract_review_metadata "$BODY_HOSTILE"
HOSTILE_DIGEST="$(jq -r '.digest' previous-evidence.json)"
check_not_contains "control char stripped from digest by precheck" "$HOSTILE_DIGEST" "$(printf '\007')"
check_not_contains "angle brackets stripped from digest by precheck" "$HOSTILE_DIGEST" "<script>"
check_contains "real fact preserved through sanitization" "$HOSTILE_DIGEST" "v1.13.4"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
