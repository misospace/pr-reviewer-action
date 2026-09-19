#!/usr/bin/env bash
set -euo pipefail

# Requirement-ledger wiring tests (#624). Standalone and hermetic: all
# artifacts are produced in a mktemp workdir (never the repo workspace), and
# only bash + jq + coreutils + python3 are used (no network, no models).
#
# What this pins, at the narrowest observable seams:
#   a. the ledger BUILD CLI (python3 -m pr_reviewer.requirement_ledger build)
#      on a tiny PR + linked-issues fixture: an acceptance entry and a
#      linked-issue invariant (verification_required), plus the hostile
#      "heading/fence forge" case from repo convention #252 — a bullet whose
#      text contains ``` and "# forged heading" must render escaped, with no
#      line starting "# " in the markdown.
#   b. empty inputs render a 0-byte ledger markdown (the `[ -s ]` gate).
#   c. fragment GATING: apply_system_prompt_fragments (extracted from
#      sections/config.sh, same harness pattern as
#      tests/test_system_prompt_fragments.sh) substitutes the
#      {{REQUIREMENT_LEDGER_GUIDANCE}} placeholder only when a non-empty
#      requirement-ledger-present.txt exists; otherwise it is dropped.
#   d. SCHEMA EQUALITY: build_model_request (scripts/model_call.sh,
#      AI_RESPONSE_FORMAT=json_schema) emits a response_format that is
#      byte-identical (jq -S normalized) to
#      pr_reviewer.conversation._OPENAI_VERDICT_JSON_SCHEMA, and the shared
#      literal requires "requirement_coverage" with the satisfied/violated/
#      unknown status enum at the coverage-items level.
#   e. the coverage CLI (python3 -m pr_reviewer.requirement_coverage)
#      end-to-end: a "satisfied" claim on a verification_required invariant
#      evidenced only by a file item is downgraded to unknown / uncredited
#      with the downgraded-invariant-unverified note.
#
# The corpus.sh section-presence wiring (a non-empty requirement-ledger.md
# becomes a "# Explicit Requirement Ledger" corpus section) and the context.sh
# presence-signal logic are file-level gates on `[ -s requirement-ledger.md ]`
# whose behaviour is exercised here at the file/CLI level (a, b): nothing in
# those sections is executed without a full review run.

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown})" >&2
  exit 0
fi

for dep in jq python3; do
  if ! command -v "$dep" &>/dev/null; then
    echo "SKIP: $dep is not available — cannot run test_requirement_ledger_wiring.sh" >&2
    exit 0
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$ROOT_DIR/tests/_lib/assert.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── a. ledger build CLI ────────────────────────────────────────────────
echo "=== a. ledger build: acceptance entry + linked-issue invariant ==="
mkdir -p "$WORK/ledger"
(
  cd "$WORK/ledger"
  cat > pr.json <<'JSON'
{"title":"feat: x","body":"## Acceptance Criteria\n\n- [ ] ledger works\n"}
JSON
  cat > linked-issues.md <<'MD'
## misospace/x#608

```json
{"title":"deep review sequencing","body":"- All specialist workers MUST terminate and be reaped before the final review call starts."}
```
MD
  PYTHONPATH="$ROOT_DIR" python3 -m pr_reviewer.requirement_ledger build \
    --pr-json pr.json \
    --linked-issues-md linked-issues.md \
    --output requirement-ledger.json \
    --markdown requirement-ledger.md
)
check "requirement-ledger.json is non-empty, valid JSON (version 1)" \
  "$(jq -r '.version' "$WORK/ledger/requirement-ledger.json")" "1"
check "ledger holds the acceptance and the invariant entries" \
  "$(jq '.requirements | length' "$WORK/ledger/requirement-ledger.json")" "2"
check "invariant entry is flagged verification_required" \
  "$(jq -r '[.requirements[] | select(.kind == "invariant" and .verification_required == true)] | length' \
    "$WORK/ledger/requirement-ledger.json")" "1"
check "acceptance entry 'ledger works' extracted" \
  "$(jq -r '[.requirements[] | select(.kind == "acceptance" and .text == "ledger works")] | length' \
    "$WORK/ledger/requirement-ledger.json")" "1"
check "requirement-ledger.md is non-empty" \
  "$([ -s "$WORK/ledger/requirement-ledger.md" ] && echo yes || echo no)" "yes"

echo "=== a. hostile content: fence/heading forge stays escaped, entry kept ==="
# Repo convention #252: feed the fence/heading boundary tokens themselves. A
# hostile bullet carrying "```" and "# forged heading" must render inside a
# code span (strictly longer delimiter) with a leading '#' escaped, so no
# line of the markdown may start "# " — while the entry itself is retained.
mkdir -p "$WORK/hostile"
(
  cd "$WORK/hostile"
  cat > pr.json <<'JSON'
{"title":"t","body":"## Acceptance Criteria\n\n- [ ] escape ``` and # forged heading\n"}
JSON
  : > linked-issues.md
  PYTHONPATH="$ROOT_DIR" python3 -m pr_reviewer.requirement_ledger build \
    --pr-json pr.json \
    --linked-issues-md linked-issues.md \
    --output requirement-ledger.json \
    --markdown requirement-ledger.md
)
check "hostile entry is kept in the rendered markdown" \
  "$(grep -c 'forged heading' "$WORK/hostile/requirement-ledger.md")" "1"
check "no line starts '# ' (no forged heading)" \
  "$(grep -cE '^# ' "$WORK/hostile/requirement-ledger.md" || true)" "0"

# ── b. empty inputs → 0-byte markdown ──────────────────────────────────
echo "=== b. empty inputs render a 0-byte ledger markdown ==="
mkdir -p "$WORK/empty"
(
  cd "$WORK/empty"
  echo '{"title":"","body":""}' > pr.json
  : > linked-issues.md
  PYTHONPATH="$ROOT_DIR" python3 -m pr_reviewer.requirement_ledger build \
    --pr-json pr.json \
    --linked-issues-md linked-issues.md \
    --output requirement-ledger.json \
    --markdown requirement-ledger.md
)
check "requirement-ledger.md is 0 bytes" \
  "$(wc -c < "$WORK/empty/requirement-ledger.md" | tr -d ' ')" "0"

# ── c. fragment gating via apply_system_prompt_fragments ───────────────
echo "=== c. {{REQUIREMENT_LEDGER_GUIDANCE}} is gated on the presence signal ==="
FUNCS="$(mktemp)"
trap 'rm -rf "$WORK"; rm -f "$FUNCS"' EXIT
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
BASE="$(<"$SCRIPT_DIR/default_system_prompt.txt")"

assemble_in() {
  ( cd "$1"
    SYSTEM_PROMPT="$BASE" SYSTEM_PROMPT_IS_DEFAULT=1
    apply_system_prompt_fragments
    printf '%s' "$SYSTEM_PROMPT" )
}

mkdir -p "$WORK/frag1" "$WORK/frag2"
rm -f "$WORK/frag1/requirement-ledger-present.txt"
OUT1="$(assemble_in "$WORK/frag1")"
check "marker absent: no ledger guidance substituted" "$OUT1" "${OUT1/REQUIREMENT_LEDGER_GUIDANCE/}"
check_not_contains "marker absent: placeholder dropped (no leftover)" "$OUT1" "{{REQUIREMENT_LEDGER_GUIDANCE}}"
check_not_contains "marker absent: fragment text absent" "$OUT1" "must be assessed in requirement_coverage"

: > "$WORK/frag1/requirement-ledger-present.txt"   # stale, empty signal
OUT1E="$(assemble_in "$WORK/frag1")"
check_not_contains "empty marker file: placeholder still dropped" "$OUT1E" "{{REQUIREMENT_LEDGER_GUIDANCE}}"

printf '0123456789abcdef\n' > "$WORK/frag2/requirement-ledger-present.txt"
OUT2="$(assemble_in "$WORK/frag2")"
check_contains "marker present: requirement_coverage guidance substituted" "$OUT2" "requirement_coverage"
check_contains "marker present: invariant verification guidance substituted" "$OUT2" "invariant"
check_not_contains "marker present: no placeholder remains" "$OUT2" "{{REQUIREMENT_LEDGER_GUIDANCE}}"

# ── d. schema equality between bash and python ─────────────────────────
echo "=== d. build_model_request response_format == _OPENAI_VERDICT_JSON_SCHEMA ==="
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/model_call.sh"
CORPUS="$WORK/corpus.md"
REQ="$WORK/ai-request.json"
: > "$CORPUS"
( AI_RESPONSE_FORMAT=json_schema
  build_model_request openai "m" "sys" "usr" "$CORPUS" "$REQ" false )
jq -S '.response_format' "$REQ" > "$WORK/bash_rf.json"
( cd "$ROOT_DIR"
  python3 -c 'import json; from pr_reviewer.conversation import _OPENAI_VERDICT_JSON_SCHEMA; print(json.dumps(_OPENAI_VERDICT_JSON_SCHEMA, sort_keys=True))' \
  | jq -S . ) > "$WORK/py_rf.json"
if diff -q "$WORK/bash_rf.json" "$WORK/py_rf.json" >/dev/null 2>&1; then
  RF_DIFF="same"
else
  RF_DIFF="differs: $(diff "$WORK/bash_rf.json" "$WORK/py_rf.json" | head -5)"
fi
check "bash and python response_format are byte-identical (jq -S normalized)" "$RF_DIFF" "same"
check "shared schema requires requirement_coverage" \
  "$(jq '.json_schema.schema.required | contains(["requirement_coverage"])' "$WORK/py_rf.json")" "true"
check "coverage-item status enum is satisfied/violated/unknown" \
  "$(jq -c '.json_schema.schema.properties.requirement_coverage.items.properties.status.enum' "$WORK/py_rf.json")" \
  '["satisfied","violated","unknown"]'
check "coverage-item evidence kind enum matches the vocabulary" \
  "$(jq -c '.json_schema.schema.properties.requirement_coverage.items.properties.evidence.items.properties.kind.enum' "$WORK/py_rf.json")" \
  '["file","test","tool","ci","diff"]'

# ── e. coverage CLI end-to-end on a tiny fixture ───────────────────────
echo "=== e. coverage CLI downgrades an unverified invariant claim ==="
mkdir -p "$WORK/cov"
(
  cd "$WORK/cov"
  python3 - <<'PY'
import hashlib, json
rid = "req-" + hashlib.sha256(
    b"All specialist workers MUST be reaped before the final review call starts."
).hexdigest()[:12]
ledger = {
    "version": 1,
    "sha": "0" * 16,
    "requirements": [{
        "id": rid,
        "text": "All specialist workers MUST be reaped before the final review call starts.",
        "kind": "invariant",
        "verification_required": True,
        "truncated": False,
        "provenance": [{"source": "linked_issues", "ref": "misospace/x#608", "line": 4}],
    }],
    "truncation": {"truncated": False, "omitted_requirements": 0},
}
json.dump(ledger, open("requirement-ledger.json", "w"))
ai = {
    "verdict": "approve",
    "review_markdown": "x",
    "requirement_coverage": [{
        "requirement_id": rid,
        "status": "satisfied",
        "evidence": [{"kind": "file", "ref": "a.py", "detail": None}],
    }],
}
json.dump(ai, open("ai-output.json", "w"))
PY
  PYTHONPATH="$ROOT_DIR" python3 -m pr_reviewer.requirement_coverage \
    --coverage ai-output.json \
    --ledger requirement-ledger.json \
    --output requirement-coverage.json
)
check "invariant 'satisfied' claim is downgraded to unknown" \
  "$(jq -r '.coverage[0].status' "$WORK/cov/requirement-coverage.json")" "unknown"
check "downgraded claim is not credited" \
  "$(jq -r '.coverage[0].credited' "$WORK/cov/requirement-coverage.json")" "false"
check "downgrade note is downgraded-invariant-unverified" \
  "$(jq -r '.coverage[0].notes | contains(["downgraded-invariant-unverified"])' \
    "$WORK/cov/requirement-coverage.json")" "true"
# summary holds COUNTS (unknown=1 row, credited=0 rows) — credited is a numeric
# count there, distinct from the per-row boolean.
check "summary counts the downgrade" \
  "$(jq -c '[.summary.unknown, .summary.credited]' "$WORK/cov/requirement-coverage.json")" \
  '[1,0]'

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
