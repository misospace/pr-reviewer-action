#!/usr/bin/env bash
# Model HTTP call helper, sourced by run_review.sh.
#
# Kept in its own file so the curl/HTTP-status handling can be unit-tested
# (tests/test_model_call.sh) — the main driver has no end-to-end harness, and
# this is the part with the subtlest behaviour (transport vs HTTP errors).

# curl_model BASE_URL API_KEY API_FORMAT PAYLOAD_FILE OUTPUT_FILE \
#            [STREAM] [REQUEST_TIMEOUT_SEC] [CONNECT_TIMEOUT_SEC]
#
# Writes the response body to OUTPUT_FILE. Returns:
#   0   on HTTP 2xx/3xx (body in OUTPUT_FILE)
#   22  on HTTP >= 400  (body in OUTPUT_FILE, a redacted head is logged to stderr)
#   N   curl's own non-zero exit code on a transport error (timeout, DNS, reset)
#
# Unlike `curl -f`, the response body is preserved on HTTP errors so a local
# endpoint's "context length exceeded" / "model not found" message is visible
# instead of silently discarded and retried.
# Escape a value for use inside a double-quoted curl-config string.
curl_config_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

curl_model() {
  local base_url="$1" api_key="$2" api_format="$3" payload_file="$4" output_file="$5"
  local stream="${6:-false}" request_timeout_sec="${7:-300}" connect_timeout_sec="${8:-30}"

  local endpoint
  local auth_header=""
  if [[ "$api_format" == "anthropic" ]]; then
    endpoint="$base_url/messages"
    if [[ -n "$api_key" ]]; then
      auth_header="x-api-key: $api_key"
    fi
  else
    endpoint="$base_url/chat/completions"
    if [[ -n "$api_key" ]]; then
      auth_header="Authorization: Bearer $api_key"
    fi
  fi

  local args=(
    -q
    -sS
    -L
    "$endpoint"
    -H "Content-Type: application/json"
    --data "@$payload_file"
    --max-time "$request_timeout_sec"
    --connect-timeout "$connect_timeout_sec"
    -o "$output_file"
    -w '%{http_code}'
  )

  if [[ "$api_format" == "anthropic" ]]; then
    args+=( -H "anthropic-version: ${ANTHROPIC_VERSION:-2023-06-01}" )
  fi

  # The API key goes through a 0600 curl --config file rather than argv, so
  # it never appears in /proc/<pid>/cmdline or `ps` output on shared runners.
  local auth_config=""
  if [[ -n "$auth_header" ]]; then
    auth_config="$(mktemp)"
    chmod 600 "$auth_config"
    printf 'header = "%s"\n' "$(curl_config_escape "$auth_header")" > "$auth_config"
    args+=( --config "$auth_config" )
  fi

  if [[ "$stream" == "true" ]]; then
    args+=( --no-buffer )
    if [[ "$api_format" == "anthropic" ]]; then
      args+=( -H "Accept: text/event-stream" )
    fi
  fi

  local http_code curl_rc=0
  http_code="$(curl "${args[@]}")" || curl_rc=$?

  if [[ -n "$auth_config" ]]; then
    rm -f "$auth_config"
  fi

  if [[ "$curl_rc" -ne 0 ]]; then
    echo "  curl transport error (exit ${curl_rc}) calling model endpoint" >&2
    return "$curl_rc"
  fi

  if [[ "${http_code:-0}" -ge 400 ]]; then
    echo "  model endpoint returned HTTP ${http_code}" >&2
    if [[ -s "$output_file" ]]; then
      # Log a short head so operators can see the real error. Redact obvious
      # credential-looking tokens defensively in case a proxy echoes a header.
      printf '  response body (first 600 bytes): ' >&2
      head -c 600 "$output_file" \
        | sed -E 's/([Bb]earer|x-api-key|api[_-]?key|token|secret)([":= ]+)[A-Za-z0-9._-]+/\1\2[REDACTED]/g' >&2
      echo >&2
    fi
    return 22
  fi

  return 0
}

# build_model_request API_FORMAT MODEL SYSTEM USER CORPUS_FILE OUTPUT_FILE [STREAM]
#
# Reads globals (with safe defaults so the historical behaviour is preserved):
#   AI_MAX_TOKENS     completion-token cap (default 8192)
#   AI_TEMPERATURE    sampling temperature; empty => omit the field entirely
#                     (some newer cloud models reject any non-default value)
#   AI_RESPONSE_FORMAT  OpenAI-compatible structured output: off|json_object|json_schema
#   AI_TOKENS_PARAM     OpenAI token-limit field name: max_tokens|max_completion_tokens
#
# response_format and the token-field name apply only to OpenAI-format requests
# (incl. LiteLLM). Anthropic always sends max_tokens and has no response_format.
build_model_request() {
  local api_format="$1"
  local model="$2"
  local system="$3"
  local user="$4"
  local corpus_file="$5"
  local output_file="$6"
  local stream="${7:-false}"

  local max_tokens="${AI_MAX_TOKENS:-8192}"

  # temperature: empty string omits the field; otherwise pass through as JSON.
  local temp_json="null"
  if [[ -n "${AI_TEMPERATURE-}" ]]; then
    temp_json="$AI_TEMPERATURE"
  fi

  if [[ "$api_format" == "anthropic" ]]; then
    jq -n \
      --arg model "$model" \
      --arg system "$system" \
      --arg user "$user" \
      --argjson max_tokens "$max_tokens" \
      --argjson stream "$stream" \
      --argjson temp "$temp_json" \
      --rawfile corpus "$corpus_file" \
      '{model:$model,max_tokens:$max_tokens,stream:$stream,system:$system,messages:[{role:"user",content:($user + "\n\n" + $corpus)}]}
       + (if $temp == null then {} else {temperature:$temp} end)' > "$output_file"
  else
    local tok_field="max_tokens"
    if [[ "${AI_TOKENS_PARAM:-max_tokens}" == "max_completion_tokens" ]]; then
      tok_field="max_completion_tokens"
    fi

    local rf_json="null"
    case "${AI_RESPONSE_FORMAT:-off}" in
      json_object)
        rf_json='{"type":"json_object"}' ;;
      json_schema)
        # findings is nullable-but-required: OpenAI strict mode requires every
        # property to be listed in required, so optionality is expressed via
        # the null type. The parser tolerates null/absent/malformed findings.
        #
        # VERDICT-TURN CONTRACT (#362): this literal is duplicated as
        # _OPENAI_VERDICT_JSON_SCHEMA in pr_reviewer/conversation.py (the
        # native_loop verdict path) and MUST stay byte-identical to it —
        # see the divergence map in that module's docstring. Drift is pinned
        # by tests/test_verdict_contract_equivalence.py.
        rf_json='{"type":"json_schema","json_schema":{"name":"pr_review","strict":true,"schema":{"type":"object","properties":{"verdict":{"type":"string","enum":["approve","request_changes"]},"review_markdown":{"type":"string"},"findings":{"type":["array","null"],"items":{"type":"object","properties":{"severity":{"type":"string","enum":["blocker","major","minor","info"]},"category":{"type":["string","null"]},"file":{"type":["string","null"]},"line":{"type":["integer","null"]},"message":{"type":"string"}},"required":["severity","category","file","line","message"],"additionalProperties":false}}},"required":["verdict","review_markdown","findings"],"additionalProperties":false}}}' ;;
    esac

    jq -n \
      --arg model "$model" \
      --arg system "$system" \
      --arg user "$user" \
      --argjson max_tokens "$max_tokens" \
      --argjson stream "$stream" \
      --arg tokfield "$tok_field" \
      --argjson temp "$temp_json" \
      --argjson rf "$rf_json" \
      --rawfile corpus "$corpus_file" \
      '{model:$model,stream:$stream,messages:[{role:"system",content:$system},{role:"user",content:($user + "\n\n" + $corpus)}]}
       + {($tokfield): $max_tokens}
       + (if $temp == null then {} else {temperature:$temp} end)
       + (if $rf == null then {} else {response_format:$rf} end)
       + (if $stream then {stream_options:{include_usage:true}} else {} end)' > "$output_file"
  fi
}

# call_model_tier TIER USER_MESSAGE CORPUS_FILE REQUEST_OUT RESPONSE_OUT
#
# Single entry point for the primary / fallback / smart model calls, which had
# drifted apart while copy-pasted into review.sh (#368: divergent retry, stream
# and truncation handling). Resolves the tier profile — endpoint, model,
# api_format, key, stream flag, request/connect timeouts, retry budget and base
# delay — from the existing env prefixes in ONE place, then runs the shared loop:
#   build_model_request → curl_model → (stream? reassemble_sse_response) → parse_and_validate
# On success the validated review lands in ai-output.json (via parse_and_validate)
# exactly as before; returns 0. Returns non-zero once the tier budget is spent.
#
# Retry semantics (formerly only the primary's): a parse/validate failure is
# usually deterministic, so it is capped at 2 attempts; transport/HTTP failures
# keep the full budget with exponential backoff capped at 120s.
#
# Reads globals set by config.sh / classification.sh / review.sh: SYSTEM_PROMPT,
# STREAM_BOOL, the AI_* / AI_FALLBACK_* / SMART_* profiles and the per-tier retry
# knobs. truncate_clean / reassemble_sse_response / parse_and_validate live in
# config.sh and are resolved at call time (this only runs from review.sh).
call_model_tier() {
  local tier="$1" user_message="$2" corpus_file="$3" request_out="$4" response_out="$5"

  local base_url model api_format api_key stream label
  local request_timeout connect_timeout retries retry_delay corpus_for_request
  case "$tier" in
    primary)
      label="Primary"
      base_url="$AI_BASE_URL"; model="$AI_MODEL"; api_format="$AI_API_FORMAT"; api_key="$AI_API_KEY"
      stream="$STREAM_BOOL"
      request_timeout="$AI_REQUEST_TIMEOUT_SEC"; connect_timeout="$AI_CONNECT_TIMEOUT_SEC"
      retries="$AI_PRIMARY_RETRIES"; retry_delay="$AI_PRIMARY_RETRY_DELAY_SEC"
      corpus_for_request="$corpus_file"
      ;;
    fallback)
      label="Fallback"
      base_url="$AI_FALLBACK_BASE_URL"; model="$AI_FALLBACK_MODEL"
      api_format="$AI_FALLBACK_API_FORMAT"; api_key="$AI_FALLBACK_API_KEY"
      stream="false"
      if [[ "$(printf '%s' "$AI_FALLBACK_STREAM" | tr '[:upper:]' '[:lower:]')" == "true" ]]; then
        stream="true"
      fi
      request_timeout="$AI_FALLBACK_REQUEST_TIMEOUT_SEC"; connect_timeout="$AI_FALLBACK_CONNECT_TIMEOUT_SEC"
      # #368: the fallback used to get exactly ONE attempt (drift from the
      # primary loop); AI_FALLBACK_RETRIES (default 2) runs it through the same
      # retry budget.
      retries="$AI_FALLBACK_RETRIES"; retry_delay="$AI_PRIMARY_RETRY_DELAY_SEC"
      # #368: clean UTF-8/newline-boundary truncation instead of a bare
      # `head -c 120000`, which could split a multibyte character.
      truncate_clean "$corpus_file" review-corpus.fallback.truncated.md 120000
      corpus_for_request="review-corpus.fallback.truncated.md"
      ;;
    smart)
      label="Smart"
      base_url="$SMART_BASE_URL"; model="$SMART_MODEL"; api_format="$SMART_API_FORMAT"; api_key="$SMART_API_KEY"
      stream="$STREAM_BOOL"
      request_timeout="$AI_REQUEST_TIMEOUT_SEC"; connect_timeout="$AI_CONNECT_TIMEOUT_SEC"
      retries="$AI_SMART_RETRIES"; retry_delay="$AI_PRIMARY_RETRY_DELAY_SEC"
      corpus_for_request="$corpus_file"
      ;;
    *)
      echo "call_model_tier: unknown tier '$tier'" >&2
      return 2
      ;;
  esac

  build_model_request \
    "$api_format" \
    "$model" \
    "$SYSTEM_PROMPT" \
    "$user_message" \
    "$corpus_for_request" \
    "$request_out" \
    "$stream"

  local attempt=1 parse_fails=0 delay="$retry_delay"
  local parse_fail_cap=2
  while [ "$attempt" -le "$retries" ]; do
    echo "${label} model attempt ${attempt}/${retries}: $model @ $base_url ($api_format)"
    if curl_model "$base_url" "$api_key" "$api_format" "$request_out" "$response_out" "$stream" "$request_timeout" "$connect_timeout"; then
      if { [[ "$stream" != "true" ]] || reassemble_sse_response "$response_out" "$api_format"; } && \
        parse_and_validate "$response_out"; then
        return 0
      fi

      parse_fails=$((parse_fails + 1))
      echo "${label} attempt $attempt: response received but parse/validate failed (parse failure ${parse_fails}/${parse_fail_cap})" >&2
      if [ -s "$response_out" ]; then
        printf '  response head (first 400 bytes): ' >&2
        head -c 400 "$response_out" >&2 || true
        echo >&2
      fi
      if [ "$parse_fails" -ge "$parse_fail_cap" ]; then
        echo "Reached parse-failure cap; not retrying ${tier} further" >&2
        break
      fi
      attempt=$((attempt + 1))
      sleep "$delay"
    else
      # Transport or HTTP error (curl_model already logged the details/body).
      echo "${label} attempt $attempt failed (connection/HTTP); waiting ${delay}s" >&2
      attempt=$((attempt + 1))
      sleep "$delay"
      delay=$((delay * 2))
      [ "$delay" -gt 120 ] && delay=120
    fi
  done
  return 1
}
