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

echo "=== dependency_upgrade keeps host-platform + release-notes guidance ==="
OUT="$(assemble dependency_upgrade)"
check_contains "dependency_upgrade includes HOST PLATFORM block" "$OUT" "HOST PLATFORM"
check_contains "dependency_upgrade includes release-notes guidance" "$OUT" "upstream release notes"

echo "=== app_code shaves host-platform + digest + release-notes guidance ==="
OUT="$(assemble app_code)"
check_not_contains "app_code drops HOST PLATFORM block" "$OUT" "HOST PLATFORM"
check_not_contains "app_code drops digest block" "$OUT" "digest-only image"
check_not_contains "app_code drops release-notes guidance" "$OUT" "upstream release notes"
check_not_contains "no placeholder remains" "$OUT" "{{"
check_contains "base output schema preserved" "$OUT" "Return STRICT JSON"

echo "=== renovate_digest_only includes digest + release-notes, not host-platform ==="
OUT="$(assemble renovate_digest_only)"
check_contains "digest PR includes digest block" "$OUT" "digest-only image"
check_contains "digest PR includes release-notes guidance" "$OUT" "upstream release notes"
check_not_contains "digest PR drops HOST PLATFORM block" "$OUT" "HOST PLATFORM"
check_not_contains "no placeholder remains" "$OUT" "{{"

echo "=== bump path is byte-identical to the pre-split prompt ==="
VB="$(<"$SCRIPT_DIR/prompt_fragments/version_bump.txt") "
DG="$(<"$SCRIPT_DIR/prompt_fragments/image_digest.txt") "
RN="$(<"$SCRIPT_DIR/prompt_fragments/release_notes.txt") "
RECON="${BASE/\{\{VERSION_BUMP_GUIDANCE\}\}/$VB}"
RECON="${RECON/\{\{IMAGE_DIGEST_GUIDANCE\}\}/$DG}"
RECON="${RECON/\{\{RELEASE_NOTES_GUIDANCE\}\}/$RN}"
check_contains "reconstructed prompt has both guidance blocks" "$RECON" "HOST PLATFORM"
check_contains "reconstructed prompt has digest block" "$RECON" "digest-only image"
check_contains "reconstructed prompt has release-notes block" "$RECON" "upstream release notes"
check_not_contains "fully reconstructed prompt has no placeholder" "$RECON" "{{"

# Extract resolve_system_prompt to test replace vs append mode end-to-end.
RFUNCS="$(mktemp)"
python3 - "$SCRIPT_DIR/sections/config.sh" "$RFUNCS" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"^resolve_system_prompt\(\) \{\n(.*?)\n\}", src, re.S | re.M)
if not m:
    sys.exit("could not extract resolve_system_prompt")
open(sys.argv[2], "w").write("resolve_system_prompt() {\n%s\n}\n" % m.group(1))
PY
# shellcheck source=/dev/null
source "$RFUNCS"; rm -f "$RFUNCS"

echo "=== replace mode (default): a supplied prompt is used verbatim, no default ==="
OUT="$(
  SYSTEM_PROMPT="MY CUSTOM PROMPT" SYSTEM_PROMPT_FILE="" SYSTEM_PROMPT_MODE="replace"
  SYSTEM_PROMPT_ADDENDUM="" SYSTEM_PROMPT_IS_DEFAULT=0
  resolve_system_prompt
  printf 'prompt=%s|default=%s|addendum=%s' "$SYSTEM_PROMPT" "${SYSTEM_PROMPT_IS_DEFAULT:-0}" "${SYSTEM_PROMPT_ADDENDUM:-}"
)"
check_contains "replace uses the supplied prompt verbatim" "$OUT" "prompt=MY CUSTOM PROMPT|"
check_contains "replace does not flag the default" "$OUT" "|default=0|"
check_contains "replace stashes no addendum" "$OUT" "|addendum="

echo "=== append mode: supplied prompt composes onto the assembled default ==="
OUT="$( cd "$WORK"
  printf '{"pr_kind":"app_code"}' > classification.json
  SYSTEM_PROMPT="REPO ADDENDUM SENTINEL" SYSTEM_PROMPT_FILE="" SYSTEM_PROMPT_MODE="append"
  SYSTEM_PROMPT_ADDENDUM="" SYSTEM_PROMPT_IS_DEFAULT=0
  resolve_system_prompt
  apply_system_prompt_fragments
  printf '%s' "$SYSTEM_PROMPT"
)"
check_contains "append keeps the base output schema" "$OUT" "Return STRICT JSON"
check_contains "append composes the repo addendum on the end" "$OUT" "REPO ADDENDUM SENTINEL"
check_not_contains "append on app_code still drops irrelevant V3" "$OUT" "HOST PLATFORM"
check_not_contains "append leaves no unsubstituted placeholder" "$OUT" "{{"

echo "=== resolve_system_prompt: file + inline are concatenated when both are set (#426) ==="
# When both SYSTEM_PROMPT_FILE and SYSTEM_PROMPT are set, the file content is
# read first and the inline value is appended after two newlines. With only one
# input the result must remain byte-identical to the prior single-source
# behavior.
TMPF="$(mktemp)"; printf 'STATIC CONVENTIONS FROM FILE' > "$TMPF"
TMPF_FILE_ONLY="$(mktemp)"; printf 'FILE ONLY SENTINEL' > "$TMPF_FILE_ONLY"
WORKF="$WORK/CONVENTIONS.md"; printf 'FAKE CONVENTIONS SENTINEL' > "$WORKF"

# Both set: file first, then inline, separated by two newlines.
run_resolve() {
  (
    cd "$WORK"
    set +u
    SYSTEM_PROMPT="$1"
    SYSTEM_PROMPT_FILE="$2"
    SYSTEM_PROMPT_MODE="$3"
    SYSTEM_PROMPT_ADDENDUM=""
    SYSTEM_PROMPT_IS_DEFAULT=0
    set -u
    resolve_system_prompt
    printf '%s' "$SYSTEM_PROMPT"
  )
}

OUT_BOTH="$( run_resolve "PER-PR STEERING" "$TMPF" "replace" )"
check_contains "both set: keeps the file content" "$OUT_BOTH" "STATIC CONVENTIONS FROM FILE"
check_contains "both set: keeps the inline content" "$OUT_BOTH" "PER-PR STEERING"
# Ordering: file content must appear before inline content.
FILE_POS="$(printf '%s' "$OUT_BOTH" | grep -bo "STATIC CONVENTIONS FROM FILE" | head -1 | cut -d: -f1)"
INLINE_POS="$(printf '%s' "$OUT_BOTH" | grep -bo "PER-PR STEERING" | head -1 | cut -d: -f1)"
if [[ -n "$FILE_POS" && -n "$INLINE_POS" && "$FILE_POS" -lt "$INLINE_POS" ]]; then
  check_contains "both set: file content precedes inline" "$OUT_BOTH" "STATIC CONVENTIONS FROM FILE"
else
  echo "FAIL: file content does not precede inline content (file_pos=$FILE_POS, inline_pos=$INLINE_POS)"
  FAIL=$((FAIL+1))
fi
# Separator: exactly two newlines between file and inline content.
check_contains "both set: separated by two newlines" "$OUT_BOTH" "STATIC CONVENTIONS FROM FILE"$'\n\n'"PER-PR STEERING"

# Inline only: unchanged from prior behavior, no file content sneaks in.
OUT_INLINE_ONLY="$( run_resolve "INLINE ONLY SENTINEL" "" "replace" )"
check_contains "inline-only is unchanged" "$OUT_INLINE_ONLY" "INLINE ONLY SENTINEL"

# File only: unchanged from prior behavior, no synthetic separators added.
OUT_FILE_ONLY="$( run_resolve "" "$TMPF_FILE_ONLY" "replace" )"
check_contains "file-only is unchanged" "$OUT_FILE_ONLY" "FILE ONLY SENTINEL"

# Missing file is still a hard error even when inline is also set, so a
# typo in the path doesn't silently fall back to inline-only. The function
# calls `error` (defined in common.sh) and then `exit 1`, so we stub `error`
# to record the message and capture the exit status in a subshell.
ERR_OUT="$( ( cd "$WORK"
   set +u
   SYSTEM_PROMPT="PER-PR STEERING" SYSTEM_PROMPT_FILE="/nonexistent/path"
   SYSTEM_PROMPT_MODE="replace" SYSTEM_PROMPT_ADDENDUM="" SYSTEM_PROMPT_IS_DEFAULT=0
   set -u
   error() { echo "ERROR: $*" >&2; }
   resolve_system_prompt
 ) 2>&1 )" || true
check_contains "missing file still errors when inline is also set" "$ERR_OUT" \
  "SYSTEM_PROMPT_FILE does not exist"

rm -f "$TMPF" "$TMPF_FILE_ONLY"

echo "=== append mode: file + inline are concatenated, then composed onto the default ==="
OUT="$( cd "$WORK"
  printf '{"pr_kind":"app_code"}' > classification.json
  SYSTEM_PROMPT="COMBINED INLINE SENTINEL" SYSTEM_PROMPT_FILE="$WORKF" \
    SYSTEM_PROMPT_MODE="append" SYSTEM_PROMPT_ADDENDUM="" SYSTEM_PROMPT_IS_DEFAULT=0
  resolve_system_prompt
  apply_system_prompt_fragments
  printf '%s' "$SYSTEM_PROMPT"
)"
# Both file and inline content are present, file before inline.
check_contains "append on file+inline: file content present" "$OUT" "FAKE CONVENTIONS SENTINEL"
check_contains "append on file+inline: inline content present" "$OUT" "COMBINED INLINE SENTINEL"
FILE_POS="$(printf '%s' "$OUT" | grep -bo "FAKE CONVENTIONS SENTINEL" | head -1 | cut -d: -f1)"
INLINE_POS="$(printf '%s' "$OUT" | grep -bo "COMBINED INLINE SENTINEL" | head -1 | cut -d: -f1)"
if [[ -n "$FILE_POS" && -n "$INLINE_POS" && "$FILE_POS" -lt "$INLINE_POS" ]]; then
  check_contains "append on file+inline: file content precedes inline" "$OUT" "FAKE CONVENTIONS SENTINEL"
else
  echo "FAIL: append mode file content does not precede inline (file_pos=$FILE_POS, inline_pos=$INLINE_POS)"
  FAIL=$((FAIL+1))
fi
check_contains "append on file+inline keeps the base output schema" "$OUT" "Return STRICT JSON"

echo "=== fingerprint includes both sources when both are set (#426) ==="
# Extract compute_config_hash from check_review_needed.sh for fingerprint tests.
CFUNCS="$(mktemp)"
python3 - "$SCRIPT_DIR/check_review_needed.sh" "$CFUNCS" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"^compute_config_hash\(\) \{\n(.*?)\n\}", src, re.S | re.M)
if not m:
    sys.exit("could not extract compute_config_hash")
open(sys.argv[2], "w").write("compute_config_hash() {\n%s\n}\n" % m.group(1))
PY
# shellcheck source=/dev/null
source "$CFUNCS"; rm -f "$CFUNCS"

TMPF_FP="$(mktemp)"; printf 'FILE CONTENT FOR FP' > "$TMPF_FP"

# Both set: fingerprint must differ from file-only and inline-only.
FP_BOTH="$(SYSTEM_PROMPT="INLINE FOR FP" SYSTEM_PROMPT_FILE="$TMPF_FP" compute_config_hash)"
FP_FILE_ONLY="$(SYSTEM_PROMPT="" SYSTEM_PROMPT_FILE="$TMPF_FP" compute_config_hash)"
FP_INLINE_ONLY="$(SYSTEM_PROMPT="INLINE FOR FP" SYSTEM_PROMPT_FILE="" compute_config_hash)"
if [[ "$FP_BOTH" != "$FP_FILE_ONLY" && "$FP_BOTH" != "$FP_INLINE_ONLY" \
   && "$FP_FILE_ONLY" != "$FP_INLINE_ONLY" ]]; then
  echo "PASS: fingerprint differs across both/file-only/inline-only"
  PASS=$((PASS+1))
else
  echo "FAIL: fingerprint did not distinguish sources (both=$FP_BOTH file=$FP_FILE_ONLY inline=$FP_INLINE_ONLY)"
  FAIL=$((FAIL+1))
fi

# Changing the inline content changes the combined fingerprint.
FP_BOTH_ALT="$(SYSTEM_PROMPT="DIFFERENT INLINE" SYSTEM_PROMPT_FILE="$TMPF_FP" compute_config_hash)"
if [[ "$FP_BOTH" != "$FP_BOTH_ALT" ]]; then
  echo "PASS: changing inline content changes the combined fingerprint"
  PASS=$((PASS+1))
else
  echo "FAIL: changing inline content did not change the combined fingerprint"
  FAIL=$((FAIL+1))
fi

rm -f "$TMPF_FP"

echo "=== base prompt directs the model to omit unmet conditional sections (#409/#414) ==="
check_contains "explicit omit-not-filler directive present" "$BASE" "omit the section entirely"
# Each conditional section's omit instruction is tied to its own trigger
# condition (Linked Issue Fit → issue context, Evidence Provider Findings →
# provider output, Tool Harness Findings → tool output), and the prompt
# explicitly forbids the "- findings: []" placeholder the model has been
# emitting as filler. This guards against weakening the instruction back to
# a single generic sentence that the model ignores (#414 follow-up).
check_contains "Linked Issue Fit trigger is named in the omit directive" \
  "$BASE" "Linked Issue Fit section to the presence of linked issue context"
check_contains "Evidence Provider Findings trigger is named in the omit directive" \
  "$BASE" "Evidence Provider Findings section to the presence of evidence provider output"
check_contains "Tool Harness Findings trigger is named in the omit directive" \
  "$BASE" "Tool Harness Findings section to the presence of tool harness output"
check_contains "explicit '- findings: []' filler is forbidden" \
  "$BASE" 'no "- findings: []" filler'

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
