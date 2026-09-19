#!/usr/bin/env bash
set -euo pipefail

# Specialist-leads wiring tests (#609): the rendered "# Specialist Review
# Leads" section is reserved into the final review corpus AFTER the #624
# Explicit Requirement Ledger (authority: standards > ledger > advisory
# leads), its bytes carved out of the body budget so body truncation can
# never slice it; a section that cannot fit MAX_CORPUS is dropped from the
# corpus AND its presence signal cleared (lockstep); a reused workspace's
# stale artifacts are truncated at run start; and the cross-language title
# constant cannot drift from the grep anchors. Standalone and hermetic:
# mktemp workdirs only, bash + jq + coreutils + python3, no network, no
# models. Same extraction idiom as tests/test_requirement_ledger_wiring.sh.

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown})" >&2
  exit 0
fi

for dep in jq python3; do
  if ! command -v "$dep" &>/dev/null; then
    echo "SKIP: $dep is not available — cannot run test_specialist_leads_wiring.sh" >&2
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

# ── extract the corpus-assembly functions ──────────────────────────────
FUNCS="$(mktemp)"
python3 - "$SCRIPT_DIR/sections/corpus.sh" "$SCRIPT_DIR/sections/config.sh" "$FUNCS" <<'PY'
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
source "$FUNCS"
log() { :; }

SP_MD='# Specialist Review Leads

These are unverified advisory leads from independent specialist passes. They are not findings or proof. Verify each relevant claim against the PR/repository evidence before using it in the final review.

## Correctness

- [major] ledger wiring test lead correctness

## Security

- [minor] ledger wiring test lead security

## Tests

- [info] ledger wiring test lead tests
'

LEDGER_MD='# Explicit requirements (1)
- (req-aaaaaaaaaaaa) `reserved ledger line` [acceptance]'

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
  : > "$d/specialists.md"
  : > "$d/specialist-leads-present.txt"
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

sp_lockstep() {
  local d="$1" label="$2" sig hdr
  if [ -s "$d/specialist-leads-present.txt" ]; then sig=on; else sig=off; fi
  if grep -qF '# Specialist Review Leads' "$d/review-corpus.md"; then hdr=present; else hdr=absent; fi
  if { [ "$sig" = on ] && [ "$hdr" = present ]; } || { [ "$sig" = off ] && [ "$hdr" = absent ]; }; then
    check "lockstep ($label): signal=$sig section=$hdr" ok ok
  else
    check "lockstep ($label): signal=$sig section=$hdr" MISMATCH ok
  fi
}

# ── a. reserved placement, fixed order, bytes intact (full + incremental) ──
echo "=== a. corpus reserves the specialist-lead block after the ledger ==="
for scope in full incremental; do
  d="$WORK/a-$scope"
  setup_corpus_workdir "$d"
  printf '%s\n' "$LEDGER_MD" > "$d/requirement-ledger.md"
  printf 'aaaaaaaaaaaa\n' > "$d/requirement-ledger-present.txt"
  printf '%s' "$SP_MD" > "$d/specialists.md"
  printf '%s\n' "$(wc -c < "$d/specialists.md" | tr -d ' ')" > "$d/specialist-leads-present.txt"
  run_corpus "$d" 220000 "$scope"
  check_contains "$scope: specialist section present" \
    "$(<"$d/review-corpus.md")" "# Specialist Review Leads"
  check "$scope: section AFTER the requirement ledger block" \
    "$(awk '/^# Explicit Requirement Ledger$/{l=NR} /^# Specialist Review Leads$/{s=NR} END{if (l && s && s>l) print "ok"; else print "bad"}' "$d/review-corpus.md")" "ok"
  check "$scope: role headings in fixed order correctness->security->tests" \
    "$(awk '/^## Correctness$/{c=NR} /^## Security$/{e=NR} /^## Tests$/{t=NR} END{if (c && e && t && c<e && e<t) print "ok"; else print "bad"}' "$d/review-corpus.md")" "ok"
  # Whole-section granularity: the first `sp_bytes` bytes of the corpus tail
  # (from the section header to EOF) equal specialists.md byte-for-byte.
  sp_bytes="$(wc -c < "$d/specialists.md" | tr -d ' ')"
  if cmp -s \
      <(awk '/^# Specialist Review Leads$/{f=1} f' "$d/review-corpus.md" | head -c "$sp_bytes") \
      "$d/specialists.md"; then
    check "$scope: section bytes survive intact (never sliced)" ok ok
  else
    check "$scope: section bytes survive intact (never sliced)" differs ok
  fi
  sp_lockstep "$d" "$scope"
done

# ── b. truncation pressure: reserved blocks outlive the body budget ───────
echo "=== b. reserved specialist block survives truncation pressure ==="
d="$WORK/b"
setup_corpus_workdir "$d"
python3 - "$d/linked-sources.md" <<'PY'
import sys
open(sys.argv[1], "w", encoding="utf-8").write("y" * 40000 + "\n")
PY
printf '%s\n' "$LEDGER_MD" > "$d/requirement-ledger.md"
printf 'aaaaaaaaaaaa\n' > "$d/requirement-ledger-present.txt"
printf '%s' "$SP_MD" > "$d/specialists.md"
printf '%s\n' "$(wc -c < "$d/specialists.md" | tr -d ' ')" > "$d/specialist-leads-present.txt"
run_corpus "$d" 20000 full
CORPUS_CONTENT="$(<"$d/review-corpus.md")"
check_contains "pressure: body truncation notice present" "$CORPUS_CONTENT" \
  "[review corpus truncated to fit the model context budget]"
check_contains "pressure: standards survive" "$CORPUS_CONTENT" "standard S1"
check_contains "pressure: ledger block survives" "$CORPUS_CONTENT" "# Explicit Requirement Ledger"
check_contains "pressure: ledger content intact" "$CORPUS_CONTENT" "reserved ledger line"
check_contains "pressure: specialist block survives" "$CORPUS_CONTENT" "# Specialist Review Leads"
check_contains "pressure: lead lines intact" "$CORPUS_CONTENT" "ledger wiring test lead security"
BYTES="$(wc -c < "$d/review-corpus.md" | tr -d ' ')"
if [ "$BYTES" -le 20200 ]; then SIZE=ok; else SIZE="too-large:$BYTES"; fi
check "pressure: corpus within MAX_CORPUS + framing slack" "$SIZE" "ok"
sp_lockstep "$d" "pressure"

# ── c. absent/empty: no section, disabled-shaped corpus, no regression ────
echo "=== c. missing/empty specialists.md adds no section ==="
d="$WORK/c"
setup_corpus_workdir "$d"
printf '%s\n' "$LEDGER_MD" > "$d/requirement-ledger.md"
printf 'aaaaaaaaaaaa\n' > "$d/requirement-ledger-present.txt"
run_corpus "$d" 220000 full
check_not_contains "absent: no specialist section in corpus" \
  "$(<"$d/review-corpus.md")" "# Specialist Review Leads"
check_contains "absent: ledger block still present (no regression)" \
  "$(<"$d/review-corpus.md")" "# Explicit Requirement Ledger"
sp_lockstep "$d" "absent"

# ── d. fit-sanity + lockstep guard: oversize dropped, stale signal cleared ─
echo "=== d. section that cannot fit MAX_CORPUS is dropped from both ==="
d="$WORK/d"
setup_corpus_workdir "$d"
{
  printf '# Specialist Review Leads\n'
  python3 -c 'print("z" * 4000)'
} > "$d/specialists.md"
printf 'pre-existing-stale-signal\n' > "$d/specialist-leads-present.txt"
run_corpus "$d" 100 full
check_not_contains "oversize: section dropped from the corpus" \
  "$(<"$d/review-corpus.md")" "# Specialist Review Leads"
check "oversize: lockstep guard truncated the presence signal to 0 bytes" \
  "$(wc -c < "$d/specialist-leads-present.txt" | tr -d ' ')" "0"

# ── e. stale-artifact reset (context.sh) zeroes reused-workspace files ────
echo "=== e. reset_specialist_lead_artifacts truncates stale artifacts ==="
FUNCS2="$(mktemp)"
trap 'rm -rf "$WORK"; rm -f "$FUNCS" "$FUNCS2"' EXIT
python3 - "$SCRIPT_DIR/sections/context.sh" "$FUNCS2" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"^reset_specialist_lead_artifacts\(\) \{\n(.*?)\n\}\n", src, re.S | re.M)
if not m:
    sys.exit("could not extract reset_specialist_lead_artifacts")
open(sys.argv[2], "w").write("reset_specialist_lead_artifacts() {\n%s\n}\n" % m.group(1))
PY
# shellcheck source=/dev/null
source "$FUNCS2"
d="$WORK/e"
mkdir -p "$d"
(
  cd "$d"
  printf 'stale section content\n' > specialists.md
  printf 'stale-signal\n' > specialist-leads-present.txt
  reset_specialist_lead_artifacts
)
check "reset: stale specialists.md truncated to 0 bytes" \
  "$(wc -c < "$d/specialists.md" | tr -d ' ')" "0"
check "reset: stale presence signal truncated to 0 bytes" \
  "$(wc -c < "$d/specialist-leads-present.txt" | tr -d ' ')" "0"

# ── f. cross-language title constant cannot drift ─────────────────────────
echo "=== f. renderers' title matches the grep anchors used by the rails ==="
TITLE="$(cd "$ROOT_DIR" && PYTHONPATH="$ROOT_DIR" python3 - <<'PY'
from pr_reviewer import specialists
print(specialists.SPECIALIST_LEADS_TITLE)
PY
)"
check "python SPECIALIST_LEADS_TITLE matches the corpus/guard anchor" \
  "$TITLE" "Specialist Review Leads"
check_contains "corpus lockstep guard greps the same anchor" \
  "$(<"$SCRIPT_DIR/sections/corpus.sh")" "# Specialist Review Leads"
# Zero usable leads renders no section at all (the "" contract the artifact
# writer relies on).
EMPTY="$(cd "$ROOT_DIR" && PYTHONPATH="$ROOT_DIR" python3 - <<'PY'
from pr_reviewer import specialists
print(repr(specialists.render_specialist_leads_section(
    {"correctness": None, "security": None, "tests": None}, max_bytes=12000)))
PY
)"
check "zero usable leads -> empty section" "$EMPTY" "''"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
