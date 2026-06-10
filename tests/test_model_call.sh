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
if [ -n "${MOCK_ARGV_LOG:-}" ]; then
  printf '%s\n' "$@" > "$MOCK_ARGV_LOG"
fi
out=""
cfg=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  if [ "$prev" = "--config" ]; then cfg="$a"; fi
  prev="$a"
done
if [ -n "$cfg" ] && [ -n "${MOCK_CONFIG_COPY:-}" ]; then
  cp "$cfg" "$MOCK_CONFIG_COPY"
  printf '%s' "$cfg" > "${MOCK_CONFIG_COPY}.path"
  # GNU stat first: BSD's -f flag is valid-but-different on GNU (filesystem
  # status), so probing -f first captured garbage on Linux. -c fails cleanly
  # on BSD/macOS, making it the safe first probe.
  { stat -c %a "$cfg" 2>/dev/null || stat -f %Lp "$cfg" 2>/dev/null; } > "${MOCK_CONFIG_COPY}.perms"
fi
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
echo "=== Test: API key stays out of curl argv (0600 --config file) ==="
OUT="$TMPDIR/auth.json"
ARGV_LOG="$TMPDIR/argv.log"
CONFIG_COPY="$TMPDIR/config.copy"
rm -f "$ARGV_LOG" "$CONFIG_COPY" "$CONFIG_COPY.path" "$CONFIG_COPY.perms"
(
  PATH="$TMPDIR/bin:$PATH" MOCK_CURL_MODE=ok \
  MOCK_ARGV_LOG="$ARGV_LOG" MOCK_CONFIG_COPY="$CONFIG_COPY" \
    curl_model "http://x/v1" "sk-supersecret123" "openai" "$PAYLOAD" "$OUT" "false" "5" "2" >/dev/null 2>&1
)
check "api key absent from curl argv" \
  "$(grep -c 'sk-supersecret123' "$ARGV_LOG" || true)" "0"
check "--config flag passed" "$(grep -cx -- '--config' "$ARGV_LOG")" "1"
check "config file carries the bearer header" \
  "$(grep -c 'header = "Authorization: Bearer sk-supersecret123"' "$CONFIG_COPY")" "1"
check "config file is 0600" "$(cat "$CONFIG_COPY.perms")" "600"
check "config file removed after the call" \
  "$(test -e "$(cat "$CONFIG_COPY.path")" && echo present || echo gone)" "gone"

echo ""
echo "=== Test: anthropic API key via config; version header stays in argv ==="
rm -f "$ARGV_LOG" "$CONFIG_COPY" "$CONFIG_COPY.path" "$CONFIG_COPY.perms"
(
  PATH="$TMPDIR/bin:$PATH" MOCK_CURL_MODE=ok \
  MOCK_ARGV_LOG="$ARGV_LOG" MOCK_CONFIG_COPY="$CONFIG_COPY" \
    curl_model "http://x/v1" "sk-ant-secret456" "anthropic" "$PAYLOAD" "$OUT" "false" "5" "2" >/dev/null 2>&1
)
check "anthropic key absent from curl argv" \
  "$(grep -c 'sk-ant-secret456' "$ARGV_LOG" || true)" "0"
check "config file carries the x-api-key header" \
  "$(grep -c 'header = "x-api-key: sk-ant-secret456"' "$CONFIG_COPY")" "1"
check "anthropic-version stays in argv (not secret)" \
  "$(grep -c 'anthropic-version' "$ARGV_LOG")" "1"

echo ""
echo "=== Test: empty API key produces no --config ==="
rm -f "$ARGV_LOG" "$CONFIG_COPY"
(
  PATH="$TMPDIR/bin:$PATH" MOCK_CURL_MODE=ok MOCK_ARGV_LOG="$ARGV_LOG" \
    curl_model "http://x/v1" "" "openai" "$PAYLOAD" "$OUT" "false" "5" "2" >/dev/null 2>&1
)
check "no --config without an api key" "$(grep -cx -- '--config' "$ARGV_LOG" || true)" "0"

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
