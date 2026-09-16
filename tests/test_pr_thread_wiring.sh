#!/usr/bin/env bash
set -euo pipefail

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown})" >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0
FAIL=0
source "$ROOT_DIR/tests/_lib/assert.sh"

BLOCK="$(mktemp)"
WORK="$(mktemp -d)"
REAL_PYTHON3="$(python3 -c 'import sys; print(sys.executable)')"
trap 'rm -f "$BLOCK"; rm -rf "$WORK"' EXIT

python3 - "$SCRIPT_DIR/sections/corpus.sh" "$BLOCK" <<'PY'
import re
import sys

source = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"^build_pr_thread_context\(\) \{\n(.*?)\n\}\n", source, re.S | re.M)
if not match:
    raise SystemExit("could not extract build_pr_thread_context")
open(sys.argv[2], "w", encoding="utf-8").write(
    "build_pr_thread_context() {\n" + match.group(1) + "\n}\n"
)
PY
source "$BLOCK"
log() { :; }

SOURCE_CONTENTS="$(<"$SCRIPT_DIR/sections/corpus.sh")"
check_contains "corpus gates PR-thread markdown" "$SOURCE_CONTENTS" "if [ -s pr-thread.md ]; then"
TOP_LEVEL_INVOCATION="$(python3 - "$SCRIPT_DIR/sections/corpus.sh" <<'PY'
import re
import sys

source = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"^build_pr_thread_context\(\) \{\n.*?\n\}\n", source, re.S | re.M)
outside = source[:match.start()] + source[match.end():] if match else ""
print("true" if re.search(r"^build_pr_thread_context\s*$", outside, re.M) else "false")
PY
)"
check "top-level PR-thread builder invocation" "$TOP_LEVEL_INVOCATION" "true"

cat > "$WORK/python3" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "-m" && "${2:-}" == "pr_reviewer.pr_thread" ]]; then
  if [[ "${PR_THREAD_MODE:-ok}" == "fail" ]]; then exit 1; fi
  exec "$REAL_PYTHON3" "$@"
fi
exec "$REAL_PYTHON3" "$@"
SH
chmod +x "$WORK/python3"

platform_pr_review_comments() {
  printf '%s\n' "$*" >> "$CALL_LOG"
  if [[ "${FETCH_MODE:-ok}" == "fail" ]]; then
    return 1
  fi
  printf '%s\n' '[{"id":1,"user":{"login":"alice"},"created_at":"2026-09-10T10:00:00Z","updated_at":"2026-09-10T10:00:00Z","body":"hello from alice"}]'
}

reset_artifacts() {
  printf 'stale\n' > "$WORK/pr-thread.json"
  printf 'stale\n' > "$WORK/pr-thread.md"
  : > "$WORK/calls.log"
}

run_context() {
  (
    cd "$WORK"
    PATH="$WORK:$PATH" PYTHONPATH="$ROOT_DIR${PYTHONPATH:+:$PYTHONPATH}" \
      REAL_PYTHON3="$REAL_PYTHON3" CALL_LOG="$WORK/calls.log" \
      PR_THREAD_CONTEXT="${PR_THREAD_CONTEXT:-true}" \
      PR_THREAD_MAX_BYTES="${PR_THREAD_MAX_BYTES:-8000}" \
      GITHUB_WORKSPACE="$WORK" REPO="example/repo" PR_NUMBER="123" \
      build_pr_thread_context
  )
}

reset_artifacts
PR_THREAD_CONTEXT=false run_context
check "disabled mode clears pr-thread.json" "$(wc -c < "$WORK/pr-thread.json" | tr -d ' ')" "0"
check "disabled mode clears pr-thread.md" "$(wc -c < "$WORK/pr-thread.md" | tr -d ' ')" "0"
check "disabled mode does not fetch comments" "$(wc -c < "$WORK/calls.log" | tr -d ' ')" "0"

reset_artifacts
FETCH_MODE=fail run_context
check "fetch failure clears pr-thread.json" "$(wc -c < "$WORK/pr-thread.json" | tr -d ' ')" "0"
check "fetch failure clears pr-thread.md" "$(wc -c < "$WORK/pr-thread.md" | tr -d ' ')" "0"

reset_artifacts
PR_THREAD_MODE=fail run_context
check "renderer failure clears pr-thread.json" "$(wc -c < "$WORK/pr-thread.json" | tr -d ' ')" "0"
check "renderer failure clears pr-thread.md" "$(wc -c < "$WORK/pr-thread.md" | tr -d ' ')" "0"

reset_artifacts
run_context
check_contains "successful fetch uses alice comment" "$(<"$WORK/pr-thread.json")" "alice"
FIRST_LINE="$(IFS= read -r line < "$WORK/pr-thread.md"; printf '%s' "$line")"
check "successful render starts with PR-thread heading" "$FIRST_LINE" "# PR Thread Context"
check_not_contains "successful JSON removes stale content" "$(<"$WORK/pr-thread.json")" "stale"
check_not_contains "successful markdown removes stale content" "$(<"$WORK/pr-thread.md")" "stale"

printf '\n=== Results: %s passed, %s failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
