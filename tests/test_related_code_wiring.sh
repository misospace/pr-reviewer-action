#!/usr/bin/env bash
set -euo pipefail

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown})" >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" )/../scripts" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0
FAIL=0
source "$ROOT_DIR/tests/_lib/assert.sh"

BLOCK="$(mktemp)"
WORK="$(mktemp -d)"
REAL_PYTHON3="/usr/bin/python3"
trap 'rm -f "$BLOCK"; rm -rf "$WORK"' EXIT

python3 - "$SCRIPT_DIR/sections/corpus.sh" "$BLOCK" <<'PY'
import re
import sys

source = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"^build_related_code_context\(\) \{\n(.*?)\n\}\n", source, re.S | re.M)
if not match:
    raise SystemExit("could not extract build_related_code_context")
open(sys.argv[2], "w", encoding="utf-8").write(
    "build_related_code_context() {\n" + match.group(1) + "\n}\n"
)
PY
source "$BLOCK"
log() { :; }

cat > "$WORK/python3" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CALL_LOG"
if [[ "${1:-}" == "-m" && "${2:-}" == "pr_reviewer.change_anchors" ]]; then
  if [[ "${ANCHOR_MODE:-ok}" == "fail" ]]; then exit 1; fi
  output=""
  for ((i=1; i<=$#; i++)); do
    if [[ "${!i}" == "--output" ]]; then
      j=$((i+1)); output="${!j}"
    fi
  done
  printf '{"version":1,"anchors":[]}' > "$output"
  exit 0
fi
if [[ "${1:-}" == "-m" && "${2:-}" == "pr_reviewer.related_context" ]]; then
  if [[ "${RELATED_MODE:-ok}" == "fail" ]]; then exit 1; fi
  output_json="related-code.json"
  output_md="related-code.md"
  for ((i=1; i<=$#; i++)); do
    if [[ "${!i}" == "--json" ]]; then j=$((i+1)); output_json="${!j}"; fi
    if [[ "${!i}" == "--markdown" ]]; then j=$((i+1)); output_md="${!j}"; fi
  done
  printf '{"version":1,"errors":[]}' > "$output_json"
  printf '%s\n' "${RELATED_BODY:-# Related Code (v1)}" > "$output_md"
  exit 0
fi
exec "$REAL_PYTHON3" "$@"
SH
chmod +x "$WORK/python3"

reset_artifacts() {
  for artifact in change-anchors.json related-code.json related-code.md related-code.truncated.md; do
    printf 'stale\n' > "$WORK/$artifact"
  done
  : > "$WORK/calls.log"
}

run_context() {
  (
    cd "$WORK"
    PATH="$WORK:$PATH" REAL_PYTHON3="$REAL_PYTHON3" CALL_LOG="$WORK/calls.log" \
      RELATED_CODE_CONTEXT="${RELATED_CODE_CONTEXT:-true}" \
      RELATED_CODE_MAX_BYTES="${RELATED_CODE_MAX_BYTES:-64}" \
      GITHUB_WORKSPACE="$WORK" build_related_code_context "$@"
  )
}

reset_artifacts
RELATED_CODE_CONTEXT=false run_context pr.diff pr-files.json
for artifact in change-anchors.json related-code.json related-code.md related-code.truncated.md; do
  check "disabled mode clears $artifact" "$(wc -c < "$WORK/$artifact" | tr -d ' ')" "0"
done

reset_artifacts
ANCHOR_MODE=fail run_context incremental.diff ""
for artifact in change-anchors.json related-code.json related-code.md related-code.truncated.md; do
  check "anchor failure clears $artifact" "$(wc -c < "$WORK/$artifact" | tr -d ' ')" "0"
done

reset_artifacts
RELATED_MODE=fail run_context incremental.diff ""
for artifact in change-anchors.json related-code.json related-code.md related-code.truncated.md; do
  check "related scan failure clears $artifact" "$(wc -c < "$WORK/$artifact" | tr -d ' ')" "0"
done

reset_artifacts
RELATED_BODY="$(printf '# Related Code (v1)\n%s' 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')" run_context incremental.diff ""
check_contains "incremental anchor uses current diff" "$(<"$WORK/calls.log")" "--diff incremental.diff"
check_not_contains "incremental anchor omits file manifest" "$(<"$WORK/calls.log")" "--files"
check_contains "incremental output keeps truncation marker" "$(<"$WORK/related-code.truncated.md")" "[related-code context truncated]"
TRUNCATED_BYTES="$(wc -c < "$WORK/related-code.truncated.md" | tr -d ' ')"
if [ "$TRUNCATED_BYTES" -le 64 ]; then
  echo "  PASS: truncated related-code output respects minimum cap ($TRUNCATED_BYTES bytes)"
  PASS=$((PASS+1))
else
  echo "  FAIL: truncated related-code output exceeds cap ($TRUNCATED_BYTES bytes)"
  FAIL=$((FAIL+1))
fi

reset_artifacts
RELATED_BODY="# Related Code (v1)" run_context pr.diff pr-files.json
check_contains "full anchor uses full diff" "$(<"$WORK/calls.log")" "--diff pr.diff"
check_contains "full anchor receives file manifest" "$(<"$WORK/calls.log")" "--files pr-files.json"

printf '\n=== Results: %s passed, %s failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
