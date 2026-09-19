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
#   f. corpus assembly (build_review_corpus + build_bounded_repo_map extracted
#      from sections/corpus.sh, truncate_clean from sections/config.sh — the
#      same function-extraction pattern as test_related_code_wiring.sh — and
#      driven hermetically): a non-empty requirement-ledger.md is RESERVED as
#      a final "# Explicit Requirement Ledger" block on every path (full AND
#      incremental): its bytes are carved out of the MAX_CORPUS budget like
#      the standards section, the block is appended after the truncated body
#      and is never eaten by truncation, even when the body is far over the
#      budget; and the presence signal and the section stay in lockstep
#      (non-empty signal iff the section is present) across the ledger ×
#      truncation-pressure combinations.
#   g. stale-artifact reset (build_requirement_ledger extracted from
#      sections/context.sh): a reused workspace's stale ledger artifacts are
#      truncated BEFORE the fail-soft build — a forced build failure and an
#      empty-input build both leave every ledger artifact 0 bytes (no stale
#      signal, no stale section) and never touch requirement-coverage.json.
#   h. fits sanity: a ledger that cannot fit the MAX_CORPUS reservation is
#      dropped from BOTH the presence signal and the corpus section.

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

# ── f. corpus assembly: the ledger block is reserved, not truncated ─────
echo "=== f. build_review_corpus reserves the ledger block (all paths) ==="
FUNCS2="$(mktemp)"
trap 'rm -rf "$WORK"; rm -f "$FUNCS" "$FUNCS2"' EXIT
python3 - "$SCRIPT_DIR/sections/corpus.sh" "$SCRIPT_DIR/sections/config.sh" "$FUNCS2" <<'PY'
import re, sys
corpus = open(sys.argv[1]).read()
config = open(sys.argv[2]).read()
out = []
for src, name in ((corpus, "build_bounded_repo_map"),
                  (corpus, "build_review_corpus"),
                  (config, "truncate_clean")):
    m = re.search(rf"^{name}\(\) \{{\n(.*?)\n\}}\n", src, re.S | re.M)
    if not m:
        sys.exit(f"could not extract {name}")
    out.append(f"{name}() {{\n{m.group(1)}\n}}\n")
open(sys.argv[3], "w").write("\n".join(out))
PY
# shellcheck source=/dev/null
source "$FUNCS2"
log() { :; }

LEDGER_MD='# Explicit requirements (2)
- (req-aaaaaaaaaaaa) `reserved ledger line` [acceptance]
- (req-bbbbbbbbbbbb) `second reserved line` [invariant]'

setup_corpus_workdir() {
  local d="$1"
  mkdir -p "$d"
  printf 'manifest line\n' > "$d/manifest-context.md"
  printf '{"number":1,"title":"feat: x","body":"b","author":{"login":"dev"},"baseRefName":"main","headRefName":"feat/x","headRefOid":"0123456789abcdef0123456789abcdef01234567","changedFiles":1,"additions":3,"deletions":1,"url":"u","files":[]}\n' > "$d/pr.json"
  printf '{"pr_kind":"app_code","risk_flags":[],"risk_flags_with_files":{},"changed_files_summary":[],"linked_issue_labels":[],"must_check":[]}\n' > "$d/classification.json"
  printf '[]\n' > "$d/pr-files.truncated.json"
  : > "$d/version-hints.truncated.txt"
  printf -- '--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n+x\n' > "$d/pr.diff.truncated"
  printf 'image digest line\n' > "$d/image-digest-context.md"
  printf 'linked source line\n' > "$d/linked-sources.md"
  printf 'impact line\n' > "$d/repo-impact.truncated.md"
  printf 'history line\n' > "$d/repo-history.truncated.md"
  printf 'standard S1\n' > "$d/standards-context.md"
  : > "$d/linked-issues.md"
  : > "$d/pr-thread.md"
  : > "$d/related-code.truncated.md"
  : > "$d/linear-issues.md"
  : > "$d/incremental.diff"
  : > "$d/tool-harness.md"
  : > "$d/evidence-providers.md"
  : > "$d/repo-map.md"
  : > "$d/requirement-ledger.md"
  : > "$d/requirement-ledger-present.txt"
  : > "$d/requirement-ledger.section.md"
}

run_corpus() {
  ( cd "$1"
    MAX_CORPUS="$2" \
    MAX_DIFF=8000 \
    STANDARDS_FILE="AGENTS.md" \
    CI_CHECKS_FILE="" \
    PREVIOUS_HEAD_SHA="0000000000000000000000000000000000000000" \
    TOOL_EVIDENCE_MEMORY="true" \
    build_review_corpus "$3" )
}

lockstep_check() {
  local d="$1" label="$2" sig hdr
  if [ -s "$d/requirement-ledger-present.txt" ]; then sig=on; else sig=off; fi
  if grep -qF '# Explicit Requirement Ledger' "$d/review-corpus.md"; then hdr=present; else hdr=absent; fi
  if { [ "$sig" = on ] && [ "$hdr" = present ]; } || { [ "$sig" = off ] && [ "$hdr" = absent ]; }; then
    check "lockstep ($label): signal=$sig, section=$hdr" ok ok
  else
    check "lockstep ($label): signal=$sig, section=$hdr" MISMATCH ok
  fi
}

# f1. full path, ledger present, no truncation pressure
setup_corpus_workdir "$WORK/c1"
printf '%s\n' "$LEDGER_MD" > "$WORK/c1/requirement-ledger.md"
printf 'aaaaaaaaaaaabb\n' > "$WORK/c1/requirement-ledger-present.txt"
run_corpus "$WORK/c1" 220000 full
check_contains "full: ledger section present in final corpus" \
  "$(<"$WORK/c1/review-corpus.md")" "# Explicit Requirement Ledger"
check_contains "full: ledger content intact (no truncation of the block)" \
  "$(<"$WORK/c1/review-corpus.md")" "second reserved line"
check "full: ledger section is the final corpus block (after Repository History)" \
  "$(awk '/^# Repository History$/{h=NR} /^# Explicit Requirement Ledger$/{l=NR} END{if (h && l && l>h) print "ok"; else print "bad"}' "$WORK/c1/review-corpus.md")" \
  "ok"

# f2. incremental path also reserves the ledger
setup_corpus_workdir "$WORK/c2"
printf '%s\n' "$LEDGER_MD" > "$WORK/c2/requirement-ledger.md"
printf 'aaaaaaaaaaaabb\n' > "$WORK/c2/requirement-ledger-present.txt"
printf -- '--- a/b.py\n+++ b/b.py\n@@ -1 +1,2 @@\n+y\n' > "$WORK/c2/incremental.diff"
run_corpus "$WORK/c2" 220000 incremental
check_contains "incremental: ledger section present in final corpus" \
  "$(<"$WORK/c2/review-corpus.md")" "# Explicit Requirement Ledger"
check_contains "incremental: ledger content intact" \
  "$(<"$WORK/c2/review-corpus.md")" "second reserved line"

# f3. truncation pressure: the body is far over budget; the ledger still lands
setup_corpus_workdir "$WORK/c3"
python3 - "$WORK/c3/linked-sources.md" <<'PY'
import sys
open(sys.argv[1], "w", encoding="utf-8").write("y" * 40000 + "\n")
PY
printf '%s\n' "$LEDGER_MD" > "$WORK/c3/requirement-ledger.md"
printf 'aaaaaaaaaaaabb\n' > "$WORK/c3/requirement-ledger-present.txt"
run_corpus "$WORK/c3" 20000 full
check_contains "pressure: body was truncated (marker present)" \
  "$(<"$WORK/c3/review-corpus.md")" "…[review corpus truncated to fit the model context budget]"
check_contains "pressure: ledger section survives the truncation" \
  "$(<"$WORK/c3/review-corpus.md")" "# Explicit Requirement Ledger"
check_contains "pressure: ledger content intact under the budget" \
  "$(<"$WORK/c3/review-corpus.md")" "second reserved line"
C3_BYTES="$(wc -c < "$WORK/c3/review-corpus.md" | tr -d ' ')"
if [ "$C3_BYTES" -le 20100 ]; then C3_SIZE=ok; else C3_SIZE="too large: $C3_BYTES"; fi
check "pressure: final corpus stays within MAX_CORPUS + standards-header slack" "$C3_SIZE" "ok"

# f4. no-ledger runs keep the section out (both with and without pressure)
setup_corpus_workdir "$WORK/c4"
run_corpus "$WORK/c4" 220000 full
setup_corpus_workdir "$WORK/c5"
python3 - "$WORK/c5/linked-sources.md" <<'PY'
import sys
open(sys.argv[1], "w", encoding="utf-8").write("y" * 40000 + "\n")
PY
run_corpus "$WORK/c5" 20000 full

# f5. signal and section are biconditionally in step, across all combinations
lockstep_check "$WORK/c1" "full, ledger"
lockstep_check "$WORK/c2" "incremental, ledger"
lockstep_check "$WORK/c3" "pressure, ledger"
lockstep_check "$WORK/c4" "full, no ledger"
lockstep_check "$WORK/c5" "pressure, no ledger"

# ── g. stale-artifact reset before the fail-soft build ─────────────────
echo "=== g. build_requirement_ledger resets stale artifacts first ==="
FUNCS3="$(mktemp)"
trap 'rm -rf "$WORK"; rm -f "$FUNCS" "$FUNCS2" "$FUNCS3"' EXIT
python3 - "$SCRIPT_DIR/sections/context.sh" "$FUNCS3" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"^build_requirement_ledger\(\) \{\n(.*?)\n\}\n", src, re.S | re.M)
if not m:
    sys.exit("could not extract build_requirement_ledger")
open(sys.argv[2], "w").write("build_requirement_ledger() {\n%s\n}\n" % m.group(1))
PY
# shellcheck source=/dev/null
source "$FUNCS3"

seed_stale() {
  ( cd "$1"
    printf '{"version":1,"sha":"stale","requirements":[]}\n' > requirement-ledger.json
    printf 'stale ledger line\n' > requirement-ledger.md
    printf 'stalesha\n' > requirement-ledger-present.txt
    printf 'stale section\n' > requirement-ledger.section.md
    printf '{"version":1,"coverage":[]}\n' > requirement-coverage.json
    printf '{"title":"","body":""}\n' > pr.json
    : > linked-issues.md
  )
}

# g1. forced build failure (module unimportable via a python3 PATH shim):
# every ledger artifact is reset, the stale ones are gone, coverage untouched
mkdir -p "$WORK/reset/shim"
REAL_PY="$(command -v python3)"
cat > "$WORK/reset/shim/python3" <<SH
#!/usr/bin/env bash
for a in "\$@"; do
  if [ "\$a" = "pr_reviewer.requirement_ledger" ]; then exit 1; fi
done
exec "$REAL_PY" "\$@"
SH
chmod +x "$WORK/reset/shim/python3"
mkdir -p "$WORK/reset/fail"
seed_stale "$WORK/reset/fail"
( cd "$WORK/reset/fail"
  PATH="$WORK/reset/shim:$PATH" MAX_CORPUS=220000 STANDARDS_FILE="" \
    build_requirement_ledger
)
check "fail: stale requirement-ledger.json is reset to 0 bytes" \
  "$(wc -c < "$WORK/reset/fail/requirement-ledger.json" | tr -d ' ')" "0"
check "fail: stale requirement-ledger.md is reset to 0 bytes" \
  "$(wc -c < "$WORK/reset/fail/requirement-ledger.md" | tr -d ' ')" "0"
check "fail: stale presence signal is reset to 0 bytes" \
  "$(wc -c < "$WORK/reset/fail/requirement-ledger-present.txt" | tr -d ' ')" "0"
check "fail: stale section file is reset to 0 bytes" \
  "$(wc -c < "$WORK/reset/fail/requirement-ledger.section.md" | tr -d ' ')" "0"
check "fail: requirement-coverage.json is untouched by the ledger build" \
  "$(cat "$WORK/reset/fail/requirement-coverage.json")" '{"version":1,"coverage":[]}'

# g2. empty inputs (build succeeds, nothing extracted): same reset guarantee
mkdir -p "$WORK/reset/empty"
seed_stale "$WORK/reset/empty"
( cd "$WORK/reset/empty"
  PYTHONPATH="$ROOT_DIR" MAX_CORPUS=220000 STANDARDS_FILE="" \
    build_requirement_ledger
)
check "empty: requirement-ledger.md is 0 bytes after a successful build" \
  "$(wc -c < "$WORK/reset/empty/requirement-ledger.md" | tr -d ' ')" "0"
check "empty: presence signal is 0 bytes (no stale signal)" \
  "$(wc -c < "$WORK/reset/empty/requirement-ledger-present.txt" | tr -d ' ')" "0"

# g3. non-empty inputs (build succeeds, requirements extracted): signal set
mkdir -p "$WORK/reset/full"
( cd "$WORK/reset/full"
  cat > pr.json <<'JSON'
{"title":"feat: x","body":"## Acceptance Criteria\n\n- [ ] ledger works\n"}
JSON
  : > linked-issues.md
  : > requirement-ledger.json
  PYTHONPATH="$ROOT_DIR" MAX_CORPUS=220000 STANDARDS_FILE="" \
    build_requirement_ledger
)
check "non-empty: presence signal is non-empty" \
  "$([ -s "$WORK/reset/full/requirement-ledger-present.txt" ] && echo yes || echo no)" "yes"
check "non-empty: signal carries the ledger sha" \
  "$(cat "$WORK/reset/full/requirement-ledger-present.txt")" \
  "$(jq -r '.sha // empty' "$WORK/reset/full/requirement-ledger.json")"

# ── h. fits sanity: oversized ledger is dropped from signal AND section ──
echo "=== h. ledger that cannot fit MAX_CORPUS is dropped from both ==="
mkdir -p "$WORK/oversize"
( cd "$WORK/oversize"
  python3 -c 'open("requirement-ledger.md", "w", encoding="utf-8").write("z" * 4000 + "\n")'
  printf '{"title":"","body":""}\n' > pr.json
  : > linked-issues.md
  : > requirement-ledger-present.txt
  MAX_CORPUS=100 STANDARDS_FILE="" build_requirement_ledger
)
check "oversize: presence signal is NOT written (does not fit)" \
  "$(wc -c < "$WORK/oversize/requirement-ledger-present.txt" | tr -d ' ')" "0"
setup_corpus_workdir "$WORK/oversize2"
cp "$WORK/oversize/requirement-ledger.md" "$WORK/oversize2/requirement-ledger.md"
run_corpus "$WORK/oversize2" 100 full
check_not_contains "oversize: ledger section is NOT in the final corpus" \
  "$(<"$WORK/oversize2/review-corpus.md")" "# Explicit Requirement Ledger"
lockstep_check "$WORK/oversize2" "oversize, no signal, no section"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
