#!/usr/bin/env bash
set -euo pipefail

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown})" >&2
  exit 0
fi

# Dependency preflight
for dep in python3; do
  if ! command -v "$dep" &>/dev/null; then
    echo "SKIP: $dep is not available — cannot run test_related_code_wiring.sh" >&2
    exit 0
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" )/../scripts" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0
FAIL=0
source "$ROOT_DIR/tests/_lib/assert.sh"

BLOCK="$(mktemp)"
WORK="$(mktemp -d)"
REAL_PYTHON3="$(command -v python3)"
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
if [[ "${1:-}" == "-m" && "${2:-}" == "pr_reviewer.related_context" && "${3:-}" == "--clip" ]]; then
  PYTHONPATH="$ROOT_DIR" exec "$REAL_PYTHON3" "$@"
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
    PATH="$WORK:$PATH" REAL_PYTHON3="$REAL_PYTHON3" ROOT_DIR="$ROOT_DIR" CALL_LOG="$WORK/calls.log" \
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
ANCHOR_MODE=fail run_context pr.diff pr-files.json
for artifact in change-anchors.json related-code.json related-code.md related-code.truncated.md; do
  check "anchor failure clears $artifact" "$(wc -c < "$WORK/$artifact" | tr -d ' ')" "0"
done

reset_artifacts
RELATED_MODE=fail run_context pr.diff pr-files.json
for artifact in change-anchors.json related-code.json related-code.md related-code.truncated.md; do
  check "related scan failure clears $artifact" "$(wc -c < "$WORK/$artifact" | tr -d ' ')" "0"
done

reset_artifacts
RELATED_BODY="$(printf '# Related Code (v1)\n%s' 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')" run_context pr.diff pr-files.json
check_contains "single path: anchor uses the current full-PR diff" "$(<"$WORK/calls.log")" "--diff pr.diff"
check_contains "single path: anchor receives the file manifest" "$(<"$WORK/calls.log")" "--files pr-files.json"
check_contains "single path: anchor reads the head checkout" "$(<"$WORK/calls.log")" "--workspace-root $WORK"
check_contains "single path: output keeps truncation marker" "$(<"$WORK/related-code.truncated.md")" "[related-code context truncated]"
TRUNCATED_BYTES="$(wc -c < "$WORK/related-code.truncated.md" | tr -d ' ')"
if [ "$TRUNCATED_BYTES" -le 64 ]; then
  echo "  PASS: truncated related-code output respects minimum cap ($TRUNCATED_BYTES bytes)"
  PASS=$((PASS+1))
else
  echo "  FAIL: truncated related-code output exceeds cap ($TRUNCATED_BYTES bytes)"
  FAIL=$((FAIL+1))
fi

# Fenced consumer windows and counterpart bodies: whatever cap lands inside a
# block, the clipped artifact keeps every fence closed and stays within the cap.
FENCED_BODY="$(cat <<'MD'
# Related Code (v1)

## Consumers of Changed Keys

- `evidence-providers-file` (entity, `contracts/action.yml`:7):
  - `scripts/run_evidence_providers.py`:10 as `EVIDENCE_PROVIDERS_FILE`
    ````
    9: def main():
    10:     path = os.getenv("EVIDENCE_PROVIDERS_FILE", "")  # ``` hostile
    11:     return path
    ````

## Referenced Counterparts

- `pr_reviewer/v2.py`:4 `_build_pr_metadata` for `buildPrMetadata` in `src/v3.ts`:4:
  ```
  4: def _build_pr_metadata(root):
  5:     obj = read_json(root, "pr.json")
  6:     return render(obj)
  ```

## Changed Files
MD
)"
FENCED_TOTAL="$(printf '%s\n' "$FENCED_BODY" | wc -c | tr -d ' ')"
fence_failures=""
for ((cap=40; cap<FENCED_TOTAL; cap+=7)); do
  reset_artifacts
  RELATED_BODY="$FENCED_BODY" RELATED_CODE_MAX_BYTES="$cap" run_context pr.diff pr-files.json
  verdict="$("$REAL_PYTHON3" - "$WORK/related-code.truncated.md" "$cap" <<'PY'
import re
import sys

data = open(sys.argv[1], "rb").read()
text = data.decode("utf-8")
fence = ""
for line in text.splitlines():
    stripped = line.strip()
    if fence:
        if len(stripped) >= len(fence) and stripped == fence[0] * len(stripped):
            fence = ""
    elif re.match(r"^[ \t]*(`{3,}|~{3,})", line):
        fence = re.match(r"^[ \t]*(`{3,}|~{3,})", line).group(1)
ok = not fence and len(data) <= int(sys.argv[2]) and text.endswith("[related-code context truncated]\n")
print("ok" if ok else "bad")
PY
)"
  [ "$verdict" = "ok" ] || fence_failures="$fence_failures $cap"
done
check "fenced blocks are never left open by the byte cap" "${fence_failures:-none}" "none"

reset_artifacts
RELATED_BODY="# Related Code (v1)" run_context pr.diff pr-files.json
check_contains "full anchor uses full diff" "$(<"$WORK/calls.log")" "--diff pr.diff"
check_contains "full anchor receives file manifest" "$(<"$WORK/calls.log")" "--files pr-files.json"

printf '\n=== Results: %s passed, %s failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
