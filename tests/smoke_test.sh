#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v gh >/dev/null; then
  echo "gh is required" >&2
  exit 1
fi

if ! command -v jq >/dev/null; then
  echo "jq is required" >&2
  exit 1
fi

if ! command -v python3 >/dev/null; then
  echo "python3 is required" >&2
  exit 1
fi

REPO="${REPO:-joryirving/home-ops}"
PR_NUMBER="${PR_NUMBER:-}"

if [[ -z "$PR_NUMBER" ]]; then
  PR_NUMBER="$(gh pr list --repo "$REPO" --limit 1 --json number --jq '.[0].number')"
fi

if [[ -z "$PR_NUMBER" || "$PR_NUMBER" == "null" ]]; then
  echo "No PR number available for smoke test" >&2
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

cp "$ROOT_DIR/scripts/run_review.sh" "$TMPDIR/run_review.sh"
cp "$ROOT_DIR/scripts/default_system_prompt.txt" "$TMPDIR/default_system_prompt.txt"
cp "$ROOT_DIR/scripts/image_digest_analysis.py" "$TMPDIR/image_digest_analysis.py"
cp "$ROOT_DIR/scripts/run_evidence_providers.py" "$TMPDIR/run_evidence_providers.py"

cat > "$TMPDIR/provider-smoke.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat <<'JSON'
{"severity":"info","findings":[{"severity":"info","message":"smoke provider executed"}]}
JSON
EOF
chmod +x "$TMPDIR/provider-smoke.sh"

cat > "$TMPDIR/evidence-providers.json" <<EOF
{
  "providers": [
    {
      "id": "smoke-provider",
      "command": ["$TMPDIR/provider-smoke.sh"]
    }
  ]
}
EOF

pushd /Users/joryirving/git/home-ops >/dev/null

GITHUB_OUTPUT="$TMPDIR/github_output.txt" \
GH_TOKEN="$(gh auth token)" \
REPO="$REPO" \
PR_NUMBER="$PR_NUMBER" \
AI_BASE_URL="http://127.0.0.1:18080/v1" \
AI_MODEL="mock-model" \
SYSTEM_PROMPT="You are a smoke test reviewer. Return valid JSON only." \
EVIDENCE_PROVIDERS_FILE="$TMPDIR/evidence-providers.json" \
bash "$TMPDIR/run_review.sh"

popd >/dev/null

echo "Smoke test outputs:"
cat "$TMPDIR/github_output.txt"
