#!/usr/bin/env bash
set -uo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Verdict-turn contract — bash side (#362). The review verdict is built on two
# paths that must stay in lockstep (see the "VERDICT-TURN CONTRACT" divergence
# map in pr_reviewer/conversation.py):
#   Path A — build_model_request in scripts/model_call.sh (this file's focus)
#   Path B — Conversation.to_request_payload in the native loop (pinned by the
#            Python test tests/test_verdict_contract_equivalence.py)
# This suite pins the bash side of the shared invariants and the cross-language
# schema literal, so a bash-only edit that drifts from Python trips here.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

MODEL_CALL="$(cat "$ROOT_DIR/scripts/model_call.sh")"
REVIEW="$(cat "$ROOT_DIR/scripts/sections/review.sh")"

echo "=== Cross-reference comments point at the authoritative divergence map ==="
check_contains "model_call.sh references the verdict-turn contract" "$MODEL_CALL" "VERDICT-TURN CONTRACT (#362)"
check_contains "model_call.sh names the Python constant it mirrors" "$MODEL_CALL" "_OPENAI_VERDICT_JSON_SCHEMA"
check_contains "review.sh references the verdict-turn contract" "$REVIEW" "VERDICT-TURN CONTRACT (#362)"
check_contains "both point at the equivalence test" "$MODEL_CALL" "tests/test_verdict_contract_equivalence.py"

echo ""
echo "=== review.sh routes Path A vs the native (Path B) verdict ==="
check_contains "native verdict short-circuits the standard call" "$REVIEW" "native_loop_verdict_produced // false"
check_contains "standard review call is guarded by NATIVE_VERDICT_USED" "$REVIEW" 'if [ "$NATIVE_VERDICT_USED" -ne 1 ]; then'
check_contains "Path A builds the request via build_model_request" "$REVIEW" "build_model_request \\"
check_contains "Path A sends the reviewer SYSTEM_PROMPT" "$REVIEW" '"$SYSTEM_PROMPT" \'
check_contains "Path A sends the corpus file" "$REVIEW" "review-corpus.truncated.md \\"

echo ""
echo "=== Path A response_format is off|json_object|json_schema (shared modes) ==="
check_contains "AI_RESPONSE_FORMAT drives response_format" "$MODEL_CALL" 'case "${AI_RESPONSE_FORMAT:-off}" in'
check_contains "json_object arm" "$MODEL_CALL" 'rf_json='"'"'{"type":"json_object"}'"'"
check_contains "response_format omitted when off (rf stays null)" "$MODEL_CALL" 'rf_json="null"'

echo ""
echo "=== Cross-language schema literal carries the same load-bearing phrases ==="
# These must match _OPENAI_VERDICT_JSON_SCHEMA in pr_reviewer/conversation.py.
# The Python test asserts byte equality; this asserts the bash literal has not
# quietly lost the enums/required keys the parser and Python side depend on.
check_contains "schema name is pr_review" "$MODEL_CALL" '"name":"pr_review"'
check_contains "strict mode on" "$MODEL_CALL" '"strict":true'
check_contains "verdict enum" "$MODEL_CALL" '"enum":["approve","request_changes"]'
check_contains "severity enum" "$MODEL_CALL" '"enum":["blocker","major","minor","info"]'
check_contains "findings nullable array" "$MODEL_CALL" '"type":["array","null"]'
check_contains "top-level required keys" "$MODEL_CALL" '"required":["verdict","review_markdown","findings"]'

echo ""
echo "=== Path A never advertises tools (verdict/review request drops them) ==="
check_not_contains "no tools field in the request templates" "$MODEL_CALL" '"tools"'

echo ""
echo "=== Shared token/sampling knobs ==="
check_contains "default max_tokens cap is 8192" "$MODEL_CALL" 'AI_MAX_TOKENS:-8192'
check_contains "honours max_completion_tokens (newer OpenAI models)" "$MODEL_CALL" "max_completion_tokens"
check_contains "temperature omitted when empty" "$MODEL_CALL" 'if $temp == null then {} else {temperature:$temp} end'
check_contains "stream_options.include_usage when streaming" "$MODEL_CALL" "stream_options:{include_usage:true}"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
