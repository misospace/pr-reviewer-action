#!/usr/bin/env bash
set -euo pipefail

# Tests for scripts/model_call.sh curl_model(): HTTP-status handling, body
# preservation, and exit-code contract, driven by a mock `curl` on PATH.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/model_call.sh"

PASS=0
FAIL=0
check() {
  local desc="$1" result="$2" expected="$3"
  if [[ "$result" == "$expected" ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (got '$result', expected '$expected')"
    FAIL=$((FAIL + 1))
  fi
}

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
mkdir -p "$TMPDIR/bin"

# Mock curl: honours -o <file> and the MOCK_CURL_MODE env var, writes a body,
# prints an HTTP status to stdout (as -w '%{http_code}' would), or fails.
cat > "$TMPDIR/bin/curl" <<'MOCK'
#!/usr/bin/env bash
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
case "${MOCK_CURL_MODE:-ok}" in
  ok)
    [ -n "$out" ] && printf '{"choices":[{"message":{"content":"hi"}}]}' > "$out"
    printf '200'; exit 0 ;;
  http_error)
    [ -n "$out" ] && printf '{"error":{"message":"context length exceeded"}}' > "$out"
    printf '400'; exit 0 ;;
  transport)
    printf '000'; exit 7 ;;
esac
printf '200'; exit 0
MOCK
chmod +x "$TMPDIR/bin/curl"

PAYLOAD="$TMPDIR/payload.json"
echo '{}' > "$PAYLOAD"

run_curl_model() {
  local mode="$1" out="$2"
  (
    PATH="$TMPDIR/bin:$PATH" MOCK_CURL_MODE="$mode" \
      curl_model "http://x/v1" "" "openai" "$PAYLOAD" "$out" "false" "5" "2" >/dev/null 2>&1
  )
}

echo "=== Test: HTTP 200 → rc 0, body written ==="
OUT="$TMPDIR/ok.json"
rc=0; run_curl_model ok "$OUT" || rc=$?
check "rc is 0 on success" "$rc" "0"
check "body written on success" "$([ -s "$OUT" ] && echo yes || echo no)" "yes"

echo ""
echo "=== Test: HTTP 400 → rc 22, error body preserved ==="
OUT="$TMPDIR/err.json"
rc=0; run_curl_model http_error "$OUT" || rc=$?
check "rc is 22 on HTTP >= 400" "$rc" "22"
check "error body preserved (not discarded)" \
  "$(grep -q 'context length exceeded' "$OUT" && echo yes || echo no)" "yes"

echo ""
echo "=== Test: transport error → curl exit code propagated ==="
OUT="$TMPDIR/transport.json"
rc=0; run_curl_model transport "$OUT" || rc=$?
check "rc is 7 (curl transport exit) on connection failure" "$rc" "7"

echo ""
echo "=== Test: error body head is logged on HTTP error ==="
OUT="$TMPDIR/err2.json"
LOG="$(PATH="$TMPDIR/bin:$PATH" MOCK_CURL_MODE=http_error \
  curl_model "http://x/v1" "" "openai" "$PAYLOAD" "$OUT" "false" "5" "2" 2>&1 >/dev/null || true)"
check "HTTP error is logged to stderr" \
  "$(printf '%s' "$LOG" | grep -q 'HTTP 400' && echo yes || echo no)" "yes"

echo ""
echo "=== build_model_request: payload shaping ==="
CORPUS="$TMPDIR/corpus.md"
printf 'CORPUS BODY' > "$CORPUS"
REQ="$TMPDIR/req.json"

( AI_MAX_TOKENS=4096; AI_TEMPERATURE=0.1; AI_RESPONSE_FORMAT=off; AI_TOKENS_PARAM=max_tokens
  build_model_request openai m "sys" "usr" "$CORPUS" "$REQ" false )
check "openai default: temperature included" "$(jq -r '.temperature' "$REQ")" "0.1"
check "openai default: max_tokens key present" "$(jq -r 'has("max_tokens")' "$REQ")" "true"
check "openai default: no response_format" "$(jq -r 'has("response_format")' "$REQ")" "false"
check "openai: corpus appended to user message" \
  "$(jq -r '.messages[1].content' "$REQ" | grep -q 'CORPUS BODY' && echo yes || echo no)" "yes"

( AI_MAX_TOKENS=4096; AI_RESPONSE_FORMAT=json_object
  build_model_request openai m "sys" "usr" "$CORPUS" "$REQ" false )
check "openai json_object: response_format.type" "$(jq -r '.response_format.type' "$REQ")" "json_object"

( AI_MAX_TOKENS=4096; AI_RESPONSE_FORMAT=json_schema
  build_model_request openai m "sys" "usr" "$CORPUS" "$REQ" false )
check "openai json_schema: response_format.type" "$(jq -r '.response_format.type' "$REQ")" "json_schema"
check "openai json_schema: required keys" \
  "$(jq -r '.response_format.json_schema.schema.required | sort | join(",")' "$REQ")" "review_markdown,verdict"

( AI_MAX_TOKENS=4096; AI_TOKENS_PARAM=max_completion_tokens
  build_model_request openai m "sys" "usr" "$CORPUS" "$REQ" false )
check "openai: uses max_completion_tokens" "$(jq -r 'has("max_completion_tokens")' "$REQ")" "true"
check "openai: drops max_tokens when using max_completion_tokens" "$(jq -r 'has("max_tokens")' "$REQ")" "false"

( AI_MAX_TOKENS=4096; AI_TEMPERATURE=""
  build_model_request openai m "sys" "usr" "$CORPUS" "$REQ" false )
check "openai: temperature omitted when empty" "$(jq -r 'has("temperature")' "$REQ")" "false"

( AI_MAX_TOKENS=4096; AI_TEMPERATURE=0.1; AI_RESPONSE_FORMAT=json_object
  build_model_request anthropic m "sys" "usr" "$CORPUS" "$REQ" false )
check "anthropic: max_tokens present" "$(jq -r 'has("max_tokens")' "$REQ")" "true"
check "anthropic: no response_format (unsupported)" "$(jq -r 'has("response_format")' "$REQ")" "false"
check "anthropic: system field present" "$(jq -r 'has("system")' "$REQ")" "true"

CORPUS="$TMPDIR/corpus.md"
printf '# corpus\nbody' > "$CORPUS"
REQ="$TMPDIR/req.json"

build_req() {
  # Run build_model_request with a controlled env, writing to $REQ.
  local fmt="$1"
  ( AI_MAX_TOKENS=4096 \
    AI_TEMPERATURE="${T_AI_TEMPERATURE-0.1}" \
    AI_RESPONSE_FORMAT="${T_AI_RESPONSE_FORMAT:-off}" \
    AI_TOKENS_PARAM="${T_AI_TOKENS_PARAM:-max_tokens}" \
    build_model_request "$fmt" "m" "sys" "usr" "$CORPUS" "$REQ" "false" )
}

echo ""
echo "=== Test: OpenAI default → max_tokens, temperature 0.1, no response_format ==="
T_AI_TEMPERATURE=0.1 T_AI_RESPONSE_FORMAT=off T_AI_TOKENS_PARAM=max_tokens build_req openai
check "has max_tokens" "$(jq 'has("max_tokens")' "$REQ")" "true"
check "temperature included" "$(jq '.temperature' "$REQ")" "0.1"
check "no response_format" "$(jq 'has("response_format")' "$REQ")" "false"

echo ""
echo "=== Test: empty AI_TEMPERATURE omits the field ==="
T_AI_TEMPERATURE="" build_req openai
check "temperature omitted when empty" "$(jq 'has("temperature")' "$REQ")" "false"

echo ""
echo "=== Test: response_format=json_object ==="
T_AI_RESPONSE_FORMAT=json_object build_req openai
check "response_format type is json_object" "$(jq -r '.response_format.type' "$REQ")" "json_object"

echo ""
echo "=== Test: response_format=json_schema enforces verdict/review_markdown ==="
T_AI_RESPONSE_FORMAT=json_schema build_req openai
check "response_format type is json_schema" "$(jq -r '.response_format.type' "$REQ")" "json_schema"
check "schema requires verdict+review_markdown" \
  "$(jq -c '.response_format.json_schema.schema.required' "$REQ")" '["verdict","review_markdown"]'

echo ""
echo "=== Test: AI_TOKENS_PARAM=max_completion_tokens (newer OpenAI models) ==="
T_AI_TOKENS_PARAM=max_completion_tokens build_req openai
check "uses max_completion_tokens" "$(jq 'has("max_completion_tokens")' "$REQ")" "true"
check "drops plain max_tokens" "$(jq 'has("max_tokens")' "$REQ")" "false"

echo ""
echo "=== Test: anthropic always sends max_tokens and never response_format ==="
T_AI_RESPONSE_FORMAT=json_object T_AI_TOKENS_PARAM=max_completion_tokens build_req anthropic
check "anthropic keeps max_tokens" "$(jq 'has("max_tokens")' "$REQ")" "true"
check "anthropic ignores response_format" "$(jq 'has("response_format")' "$REQ")" "false"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
