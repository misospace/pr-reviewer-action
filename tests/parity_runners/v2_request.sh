#!/usr/bin/env bash
# Parity runner (v2 side, model-request-construction boundary, #677): runs the
# real scripts/model_call.sh build_model_request against a fixture and prints
# the canonical wire payload for the harness to compare with the v3 builder.
set -euo pipefail

fixture="$1"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/model_call.sh
source "$repo_root/scripts/model_call.sh"

api_format=$(jq -r '.request.api_format' "$fixture")
model=$(jq -r '.request.model' "$fixture")
system=$(jq -r '.request.system' "$fixture")
user=$(jq -r '.request.user' "$fixture")
stream=$(jq -r '.request.stream' "$fixture")
shape=$(jq -r '.request.shape' "$fixture")
response_format=$(jq -r '.request.response_format' "$fixture")
tokens_param=$(jq -r '.request.tokens_param' "$fixture")

max_tokens=$(jq -r '.request.max_tokens' "$fixture")
if [[ "$max_tokens" == "null" ]]; then
  unset AI_MAX_TOKENS
else
  export AI_MAX_TOKENS="$max_tokens"
fi

temperature=$(jq -r '.request.temperature' "$fixture")
# null means "config default": config.sh always exports AI_TEMPERATURE (0.1
# unless the input was explicitly empty), so the runner mirrors that layer.
if [[ "$temperature" == "null" ]]; then
  export AI_TEMPERATURE="0.1"
else
  export AI_TEMPERATURE="$temperature"
fi

export AI_RESPONSE_FORMAT="$response_format"
export AI_TOKENS_PARAM="$tokens_param"

corpus_file=$(mktemp)
payload_file=$(mktemp)
trap 'rm -f "$corpus_file" "$payload_file"' EXIT
jq -j '.request.corpus' "$fixture" > "$corpus_file"

build_model_request "$api_format" "$model" "$system" "$user" "$corpus_file" "$payload_file" "$stream" "$shape"

payload=$(jq -Sc . "$payload_file")
jq -cn --arg payload "$payload" '{ok: true, values: {payload: $payload}}'
