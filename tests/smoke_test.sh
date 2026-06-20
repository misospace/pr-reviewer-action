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
echo "=== Tool harness: native_loop degrades on a no-tool-call response ==="
mkdir -p "$TMPDIR/harness-anthropic"
printf '# Review corpus\n' > "$TMPDIR/harness-anthropic/review-corpus.truncated.md"
(
  cd "$TMPDIR/harness-anthropic"
  REPO=misospace/pr-reviewer-action \
    AI_BASE_URL=http://127.0.0.1:18080/v1 \
    AI_API_FORMAT=anthropic \
    AI_MODEL=mock-anthropic \
    TOOL_MODE=native_loop \
    TOOL_ALLOWED_GH_API_REPOS='*' \
    ALLOWED_SOURCE_HOSTS=github.com \
    python3 "$ROOT_DIR/scripts/run_tool_harness.py"
)
# The mock returns a plain text response (no tool_use), so the native loop
# issues no tool calls and the harness degrades to a corpus-only review —
# still writing a native_loop-tagged tool-harness.json (#304).
check "native_loop harness wrote a result" "$(jq -r '.mode' "$TMPDIR/harness-anthropic/tool-harness.json")" "native_loop"
check "native_loop degraded (no tool calls)" "$(jq -r 'has("native_loop_degraded")' "$TMPDIR/harness-anthropic/tool-harness.json")" "true"

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
echo "=== Standards file discovery order ==="

# Extract just the resolve_standards_file function for testing
resolve_standards_file() {
  if [[ -n "$STANDARDS_FILE" && -f "$STANDARDS_FILE" ]]; then
    return
  fi

  local candidate
  IFS=',' read -ra candidates <<< "$STANDARDS_FILE_CANDIDATES"
  for candidate in "${candidates[@]}"; do
    candidate="$(printf '%s' "$candidate" | xargs)"
    [[ -n "$candidate" ]] || continue
    if [[ -f "$candidate" ]]; then
      STANDARDS_FILE="$candidate"
      return
    fi
  done
}


# Test 1: AGENTS.md should be picked before CLAUDE.md when both exist
mkdir -p "$TMPDIR/std-order-test"
echo "agents content" > "$TMPDIR/std-order-test/AGENTS.md"
echo "claude content" > "$TMPDIR/std-order-test/CLAUDE.md"

(
  cd "$TMPDIR/std-order-test"
  STANDARDS_FILE="" STANDARDS_FILE_CANDIDATES="AGENTS.md,agents.md,CLAUDE.md,claude.md,.github/ai-review-rules.md,.github/ai-review-rules.txt"
  resolve_standards_file
  check "AGENTS.md preferred over CLAUDE.md" "$STANDARDS_FILE" "AGENTS.md"
)

# Test 2: explicit STANDARDS_FILE takes priority
(
  cd "$TMPDIR/std-order-test"
  STANDARDS_FILE="CLAUDE.md" STANDARDS_FILE_CANDIDATES="AGENTS.md,agents.md,CLAUDE.md"
  resolve_standards_file
  check "explicit STANDARDS_FILE takes priority" "$STANDARDS_FILE" "CLAUDE.md"
)

# Test 3: first found candidate is used (AGENTS.md before agents.md)
mkdir -p "$TMPDIR/std-order-test2"
echo "agents" > "$TMPDIR/std-order-test2/AGENTS.md"
echo "agents-lower" > "$TMPDIR/std-order-test2/agents.md"

(
  cd "$TMPDIR/std-order-test2"
  STANDARDS_FILE="" STANDARDS_FILE_CANDIDATES="AGENTS.md,agents.md,CLAUDE.md"
  resolve_standards_file
  check "uppercase AGENTS.md preferred over lowercase agents.md" "$STANDARDS_FILE" "AGENTS.md"
)

echo ""
echo "=== Publish mode: review_comment command construction ==="

REVIEW_MARKDOWN="Test review body content"
ANALYSIS_ENGINE="gpt-4.1@https://api.openai.com/v1 (openai)"
VERDICT="approve"

cat > "$TMPDIR/review-comment-body.md" <<EOF
# AI Automated Review

_Analysis engine: ${ANALYSIS_ENGINE}_

${REVIEW_MARKDOWN}
EOF

COMMAND_REVIEW_COMMENT="gh pr review 123 --repo owner/repo --comment --body-file $TMPDIR/review-comment-body.md"
if echo "$COMMAND_REVIEW_COMMENT" | grep -q '\-\-comment'; then
  check "review_comment mode uses --comment flag" "PASS" "PASS"
else
  check "review_comment mode uses --comment flag" "FAIL" "PASS"
fi

echo ""
echo "=== Publish mode: review_verdict command construction ==="

REVIEW_MARKDOWN="Test verdict review body"
ANALYSIS_ENGINE="qwen3-32b@http://llama-server:8080/v1 (openai)"

cat > "$TMPDIR/review-verdict-body.md" <<EOF
# AI Automated Review

_Analysis engine: ${ANALYSIS_ENGINE}_

${REVIEW_MARKDOWN}
EOF

IS_FORK_PR="false"
ALLOW_APPROVE_BOOL="true"
APPROVE_FORKS_BOOL="false"
VERDICT="approve"

CAN_APPROVE="false"
if [ "$VERDICT" = "approve" ] && [ "$ALLOW_APPROVE_BOOL" = "true" ]; then
  if [ "$IS_FORK_PR" != "true" ]; then
    CAN_APPROVE="true"
  elif [ "$APPROVE_FORKS_BOOL" = "true" ]; then
    CAN_APPROVE="true"
  fi
fi

if [ "$CAN_APPROVE" = true ]; then
  COMMAND_REVIEW_VERDICT="gh pr review 123 --repo owner/repo --approve --body-file $TMPDIR/review-verdict-body.md"
else
  COMMAND_REVIEW_VERDICT="gh pr review 123 --repo owner/repo --request-changes --body-file $TMPDIR/review-verdict-body.md"
fi

if echo "$COMMAND_REVIEW_VERDICT" | grep -q '\-\-approve'; then
  check "review_verdict approve with allow_approve uses --approve" "PASS" "PASS"
else
  check "review_verdict approve with allow_approve uses --approve" "FAIL" "PASS"
fi

echo ""
echo "=== Publish mode: review_verdict request_changes command ==="

VERDICT="request_changes"
ALLOW_APPROVE_BOOL="false"
IS_FORK_PR="false"
CAN_APPROVE="false"

if [ "$VERDICT" = "approve" ] && [ "$ALLOW_APPROVE_BOOL" = "true" ]; then
  if [ "$IS_FORK_PR" != "true" ]; then
    CAN_APPROVE="true"
  elif [ "$APPROVE_FORKS_BOOL" = "true" ]; then
    CAN_APPROVE="true"
  fi
fi

if [ "$CAN_APPROVE" = true ]; then
  COMMAND_RC="gh pr review 123 --repo owner/repo --approve --body-file $TMPDIR/review-verdict-body.md"
else
  COMMAND_RC="gh pr review 123 --repo owner/repo --request-changes --body-file $TMPDIR/review-verdict-body.md"
fi

if echo "$COMMAND_RC" | grep -q '\-\-request-changes'; then
  check "review_verdict request_changes uses --request-changes" "PASS" "PASS"
else
  check "review_verdict request_changes uses --request-changes" "FAIL" "PASS"
fi

echo ""
echo "=== Publish mode: review_verdict approve blocked by allow_approve=false ==="

VERDICT="approve"
ALLOW_APPROVE_BOOL="false"
IS_FORK_PR="false"
CAN_APPROVE="false"

if [ "$VERDICT" = "approve" ] && [ "$ALLOW_APPROVE_BOOL" = "true" ]; then
  if [ "$IS_FORK_PR" != "true" ]; then
    CAN_APPROVE="true"
  elif [ "$APPROVE_FORKS_BOOL" = "true" ]; then
    CAN_APPROVE="true"
  fi
fi

if [ "$CAN_APPROVE" = true ]; then
  COMMAND_BLOCKED="gh pr review 123 --repo owner/repo --approve --body-file $TMPDIR/review-verdict-body.md"
else
  COMMAND_BLOCKED="gh pr review 123 --repo owner/repo --request-changes --body-file $TMPDIR/review-verdict-body.md"
fi

if echo "$COMMAND_BLOCKED" | grep -q '\-\-request-changes'; then
  check "approve blocked when allow_approve=false uses --request-changes" "PASS" "PASS"
else
  check "approve blocked when allow_approve=false uses --request-changes" "FAIL" "PASS"
fi

echo ""
echo "=== Publish mode: review_verdict fork approval blocked by approve_forks=false ==="

VERDICT="approve"
ALLOW_APPROVE_BOOL="true"
APPROVE_FORKS_BOOL="false"
IS_FORK_PR="true"
CAN_APPROVE="false"

if [ "$VERDICT" = "approve" ] && [ "$ALLOW_APPROVE_BOOL" = "true" ]; then
  if [ "$IS_FORK_PR" != "true" ]; then
    CAN_APPROVE="true"
  elif [ "$APPROVE_FORKS_BOOL" = "true" ]; then
    CAN_APPROVE="true"
  fi
fi

if [ "$CAN_APPROVE" = true ]; then
  COMMAND_FORK_BLOCKED="gh pr review 123 --repo owner/repo --approve --body-file $TMPDIR/review-verdict-body.md"
else
  COMMAND_FORK_BLOCKED="gh pr review 123 --repo owner/repo --request-changes --body-file $TMPDIR/review-verdict-body.md"
fi

if echo "$COMMAND_FORK_BLOCKED" | grep -q '\-\-request-changes'; then
  check "fork approval blocked when approve_forks=false uses --request-changes" "PASS" "PASS"
else
  check "fork approval blocked when approve_forks=false uses --request-changes" "FAIL" "PASS"
fi

echo ""
echo "=== Tool harness planning corpus: native_loop uses neutral text ==="

# Simulate the initial tool-harness.md creation logic from run_review.sh
create_default_tool_harness() {
  local tool_mode="$1"
  local output_file="$2"

  case "$(printf '%s' "$tool_mode" | tr '[:upper:]' '[:lower:]')" in
    native_loop)
      cat > "$output_file" <<'EOF'
Tool harness planning pending.
EOF
      ;;
    *)
      cat > "$output_file" <<'EOF'
Tool harness disabled.
EOF
      ;;
  esac
}

# Test: native_loop should NOT contain "disabled"
create_default_tool_harness "native_loop" "$TMPDIR/th-planning.md"
check "planning mode has neutral text" "$(cat "$TMPDIR/th-planning.md")" "Tool harness planning pending."
check "planning mode does not say disabled" "$(grep -c 'disabled' "$TMPDIR/th-planning.md" || true)" "0"

# Test: off mode should still contain "disabled"
create_default_tool_harness "off" "$TMPDIR/th-disabled.md"
check "off mode has disabled text" "$(cat "$TMPDIR/th-disabled.md")" "Tool harness disabled."

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
