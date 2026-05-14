#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v jq >/dev/null; then
  echo "jq is required" >&2
  exit 1
fi

if ! command -v python3 >/dev/null; then
  echo "python3 is required" >&2
  exit 1
fi

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

python3 "$SCRIPT_DIR/mock_openai_server.py" &
SERVER_PID=$!
sleep 1

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"; cleanup' EXIT

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

# Shared Python code for parse_and_validate (same as run_review.sh)
PARSE_PY='
import sys, json
from pathlib import Path

response = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace"))

content = None
if isinstance(response.get("choices"), list):
    content = ((response.get("choices") or [{}])[0].get("message") or {}).get("content")
elif isinstance(response.get("content"), list):
    parts = []
    for item in response.get("content") or []:
        if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
            parts.append(item["text"])
    content = "".join(parts)
elif isinstance(response.get("content"), str):
    content = response.get("content")

if isinstance(content, str):
    text = content.strip()
elif isinstance(content, list):
    parts = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict):
            item_type = item.get("type")
            if item_type in (None, "text"):
                text_part = item.get("text")
                if isinstance(text_part, str):
                    parts.append(text_part)
    text = "".join(parts).strip()
elif content is None:
    text = ""
else:
    text = str(content).strip()

if text.startswith("```"):
    lines = text.splitlines()
    if lines:
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    text = "\n".join(lines).strip()

decoder = json.JSONDecoder()
parsed = None

for start in range(len(text)):
    if text[start] not in "[{":
        continue
    try:
        candidate, end = decoder.raw_decode(text[start:])
        parsed = candidate
        break
    except json.JSONDecodeError:
        continue

if parsed is None:
    raise SystemExit("Could not extract JSON object from model response")

if isinstance(parsed, list) and len(parsed) == 1 and isinstance(parsed[0], dict):
    parsed = parsed[0]

if not isinstance(parsed, dict):
    raise SystemExit(f"Expected JSON object but got {type(parsed).__name__}")

print(json.dumps(parsed))
'

run_parse() {
  python3 - "$1" > "$TMPDIR/out.json" <<PYEOF
$PARSE_PY
PYEOF
}

# Shared Python code for reassemble_sse_response (must match run_review.sh anthropic branch).
REASSEMBLE_ANTHROPIC_PY='
import sys, json
from pathlib import Path

response_file = sys.argv[1]
lines = Path(response_file).read_text(encoding="utf-8", errors="replace").splitlines()

content_parts = []
stop_reason = None
model = None
message_id = None
input_tokens = 0
output_tokens = 0

for line in lines:
    line = line.strip()
    if not line.startswith("data:"):
        continue
    data = line[5:].strip()
    if not data or data == "[DONE]":
        continue
    try:
        event = json.loads(data)
    except json.JSONDecodeError:
        continue

    etype = event.get("type", "")
    if etype == "message_start":
        message_id = event.get("message", {}).get("id")
        model = event.get("message", {}).get("model")
    elif etype == "content_block_delta":
        delta = event.get("delta", {})
        if delta.get("type") in ("text_delta", "text"):
            text_chunk = delta.get("text", "")
            if isinstance(text_chunk, str):
                content_parts.append(text_chunk)
    elif etype == "message_delta":
        delta = event.get("delta", {})
        stop_reason = delta.get("stop_reason")

content_text = "".join(content_parts)
result = {
    "id": message_id or "",
    "object": "chat.completion",
    "model": model or "",
    "choices": [{
        "index": 0,
        "message": {"role": "assistant", "content": content_text},
        "finish_reason": stop_reason or "stop"
    }],
}
Path(response_file).write_text(json.dumps(result) + "\n", encoding="utf-8")
'

run_reassemble_anthropic() {
  python3 - "$1" <<PYEOF
$REASSEMBLE_ANTHROPIC_PY
PYEOF
}

echo "=== parse_and_validate: standard object response ==="
cat > "$TMPDIR/resp-object.json" <<'EOF'
{"id":"chatcmpl-test","choices":[{"message":{"content":"{\"verdict\":\"approve\",\"review_markdown\":\"Looks good.\"}"}}]}
EOF
run_parse "$TMPDIR/resp-object.json"
check "verdict=approve" "$(jq -r '.verdict' "$TMPDIR/out.json")" "approve"
check "review_markdown present" "$(jq -r 'if .review_markdown and (.review_markdown | length > 0) then "yes" else "no" end' "$TMPDIR/out.json")" "yes"

echo ""
echo "=== parse_and_validate: array response (MiniMax-style) ==="
cat > "$TMPDIR/resp-array.json" <<'EOF'
{"id":"chatcmpl-test","choices":[{"message":{"content":"[{\"verdict\":\"request_changes\",\"review_markdown\":\"Needs work.\"}]"}}]}
EOF
run_parse "$TMPDIR/resp-array.json"
check "verdict=request_changes" "$(jq -r '.verdict' "$TMPDIR/out.json")" "request_changes"
check "review_markdown present" "$(jq -r 'if .review_markdown and (.review_markdown | length > 0) then "yes" else "no" end' "$TMPDIR/out.json")" "yes"

echo ""
echo "=== parse_and_validate: markdown code block ==="
cat > "$TMPDIR/resp-block.json" <<'EOF'
{"id":"chatcmpl-test","choices":[{"message":{"content":"```json\n{\"verdict\":\"approve\",\"review_markdown\":\"Clean.\"}\n```"}}]}
EOF
run_parse "$TMPDIR/resp-block.json"
check "verdict=approve" "$(jq -r '.verdict' "$TMPDIR/out.json")" "approve"

echo ""
echo "=== parse_and_validate: rejects bare numeric list ==="
cat > "$TMPDIR/resp-bare-list.json" <<'EOF'
{"id":"chatcmpl-test","choices":[{"message":{"content":"[1,2,3]"}}]}
EOF
if run_parse "$TMPDIR/resp-bare-list.json"; then
  check "rejects bare numeric list" "no" "yes"
else
  check "rejects bare numeric list" "yes" "yes"
fi

echo ""
echo "=== parse_and_validate: rejects empty array ==="
cat > "$TMPDIR/resp-empty-array.json" <<'EOF'
{"id":"chatcmpl-test","choices":[{"message":{"content":"[]"}}]}
EOF
if run_parse "$TMPDIR/resp-empty-array.json"; then
  check "rejects empty array" "no" "yes"
else
  check "rejects empty array" "yes" "yes"
fi

echo ""
echo "=== parse_and_validate: Anthropic text blocks ignore thinking ==="
cat > "$TMPDIR/resp-anthropic.json" <<'EOF'
{"id":"msg-test","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"private reasoning"},{"type":"text","text":"{\"verdict\":\"approve\",\"review_markdown\":\"Anthropic clean.\"}"}]}
EOF
run_parse "$TMPDIR/resp-anthropic.json"
check "anthropic verdict=approve" "$(jq -r '.verdict' "$TMPDIR/out.json")" "approve"
check "anthropic ignores thinking" "$(jq -r '.review_markdown' "$TMPDIR/out.json")" "Anthropic clean."

echo ""
echo "=== reassemble_sse_response: Anthropic text_delta stream ==="
cat > "$TMPDIR/stream-anthropic.sse" <<'EOF'
data: {"type":"message_start","message":{"id":"msg_smoke","model":"anthropic/test","usage":{"input_tokens":10,"output_tokens":0}}}

data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\"verdict\":\"approve\","}}

data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\"review_markdown\":\"Streamed clean.\"}"}}

data: {"type":"content_block_stop","index":0}

data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}

data: {"type":"message_stop"}

EOF
run_reassemble_anthropic "$TMPDIR/stream-anthropic.sse"
run_parse "$TMPDIR/stream-anthropic.sse"
check "anthropic stream verdict=approve" "$(jq -r '.verdict' "$TMPDIR/out.json")" "approve"
check "anthropic stream review_markdown" "$(jq -r '.review_markdown' "$TMPDIR/out.json")" "Streamed clean."

echo ""
echo "=== reassemble_sse_response: Anthropic thinking_delta is ignored ==="
cat > "$TMPDIR/stream-anthropic-thinking.sse" <<'EOF'
data: {"type":"message_start","message":{"id":"msg_smoke","model":"anthropic/test"}}

data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"private reasoning that must not leak"}}

data: {"type":"content_block_stop","index":0}

data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"{\"verdict\":\"request_changes\",\"review_markdown\":\"After thinking.\"}"}}

data: {"type":"content_block_stop","index":1}

data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}

data: {"type":"message_stop"}

EOF
run_reassemble_anthropic "$TMPDIR/stream-anthropic-thinking.sse"
run_parse "$TMPDIR/stream-anthropic-thinking.sse"
check "thinking-only stream verdict" "$(jq -r '.verdict' "$TMPDIR/out.json")" "request_changes"
check "thinking content excluded" "$(jq -r '.review_markdown' "$TMPDIR/out.json")" "After thinking."

echo ""
echo "=== reassemble_sse_response: Anthropic stream with no text deltas fails parse ==="
cat > "$TMPDIR/stream-anthropic-empty.sse" <<'EOF'
data: {"type":"message_start","message":{"id":"msg_smoke","model":"anthropic/test"}}

data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"only thinking, no text"}}

data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}

data: {"type":"message_stop"}

EOF
run_reassemble_anthropic "$TMPDIR/stream-anthropic-empty.sse"
if run_parse "$TMPDIR/stream-anthropic-empty.sse"; then
  check "empty stream rejected" "no" "yes"
else
  check "empty stream rejected" "yes" "yes"
fi

echo ""
echo "=== Tool harness: Anthropic planner request ==="
mkdir -p "$TMPDIR/harness-anthropic"
printf '# Review corpus\n' > "$TMPDIR/harness-anthropic/review-corpus.truncated.md"
(
  cd "$TMPDIR/harness-anthropic"
  REPO=joryirving/home-ops \
    AI_BASE_URL=http://127.0.0.1:18080/v1 \
    AI_API_FORMAT=anthropic \
    AI_MODEL=mock-anthropic \
    TOOL_MODE=plan_execute_once \
    TOOL_ALLOWED_GH_API_REPOS='*' \
    ALLOWED_SOURCE_HOSTS=github.com \
    python3 "$ROOT_DIR/scripts/run_tool_harness.py"
)
check "anthropic planner completed" "$(jq -r '.mode' "$TMPDIR/harness-anthropic/tool-harness.json")" "plan_execute_once"
check "anthropic planner ignored non-requests response" "$(jq -r '.planning_warning' "$TMPDIR/harness-anthropic/tool-harness.json")" "Planner response did not contain requests[]"

echo ""
echo "=== Evidence provider execution ==="
cat > "$TMPDIR/provider-smoke.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat <<'JSON'
{"severity":"info","findings":[{"severity":"info","message":"smoke provider executed"}]}
JSON
EOF
chmod +x "$TMPDIR/provider-smoke.sh"

OUTPUT=$(bash "$TMPDIR/provider-smoke.sh" 2>&1)
check "provider outputs JSON" "$(echo "$OUTPUT" | jq -r '.findings[0].message' 2>/dev/null)" "smoke provider executed"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
