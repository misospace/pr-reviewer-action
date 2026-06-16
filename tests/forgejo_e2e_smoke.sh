#!/usr/bin/env bash
set -euo pipefail

# End-to-end Forgejo smoke harness for the platform backend. It is opt-in
# because it starts a disposable Forgejo container and needs Docker.
# It exercises the real Forgejo REST seam that the composite action uses:
# precheck PR metadata/diff, CI commit-status polling, and sticky comments.
if [[ "${FORGEJO_E2E:-}" != "true" ]]; then
  echo "SKIP: set FORGEJO_E2E=true to run the Docker-backed Forgejo smoke test"
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${FORGEJO_E2E_IMAGE:-codeberg.org/forgejo/forgejo:1.21}"
NAME="pr-reviewer-forgejo-e2e-$$"
HTTP_PORT="${FORGEJO_E2E_PORT:-31080}"
PASSWORD="forgejo-e2e-pass"
TOKEN_NAME="pr-reviewer-e2e"
TMPDIR="$(mktemp -d)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

wait_http() {
  local url="$1"
  for _ in {1..90}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Forgejo did not become ready at $url" >&2
  return 1
}

api() {
  curl -fsS -H "Authorization: token $FORGEJO_TOKEN" "$@"
}

api_json() {
  local method="$1" url="$2" body="$3"
  curl -fsS -X "$method" \
    -H "Authorization: token $FORGEJO_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "$url"
}

container_forgejo() {
  docker exec -u git "$NAME" forgejo \
    --config /data/gitea/conf/app.ini \
    --work-path /data/gitea "$@"
}

docker run -d --name "$NAME" \
  -p "${HTTP_PORT}:3000" \
  -e USER_UID=1000 \
  -e USER_GID=1000 \
  -e FORGEJO__security__INSTALL_LOCK=true \
  -e FORGEJO__server__ROOT_URL="http://127.0.0.1:${HTTP_PORT}/" \
  -e FORGEJO__service__DISABLE_REGISTRATION=true \
  -e FORGEJO__repository__DEFAULT_BRANCH=main \
  -e FORGEJO__actions__ENABLED=false \
  "$IMAGE" >/dev/null

wait_http "http://127.0.0.1:${HTTP_PORT}/api/healthz"

container_forgejo admin user create \
  --username reviewer \
  --password "$PASSWORD" \
  --email reviewer@example.test \
  --admin \
  --must-change-password=false >/dev/null

TOKEN_JSON="$(curl -fsS \
  -u "reviewer:${PASSWORD}" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"${TOKEN_NAME}\",\"scopes\":[\"write:repository\",\"write:issue\",\"read:user\"]}" \
  "http://127.0.0.1:${HTTP_PORT}/api/v1/users/reviewer/tokens")"
FORGEJO_TOKEN="$(printf '%s' "$TOKEN_JSON" | jq -r '.sha1')"
export PLATFORM=forgejo
export FORGEJO_API_URL="http://127.0.0.1:${HTTP_PORT}"
export FORGEJO_TOKEN
export GH_TOKEN="$FORGEJO_TOKEN"
export PYTHONPATH="$ROOT_DIR"

api_json POST "$FORGEJO_API_URL/api/v1/user/repos" \
  '{"name":"sample","auto_init":true,"default_branch":"main"}' >/dev/null

cat > "$TMPDIR/commit.json" <<'JSON'
{
  "branch": "main",
  "message": "add fixture",
  "content": "b25lCg=="
}
JSON
api_json POST "$FORGEJO_API_URL/api/v1/repos/reviewer/sample/contents/fixture.txt" \
  "$(cat "$TMPDIR/commit.json")" >/dev/null

api_json POST "$FORGEJO_API_URL/api/v1/repos/reviewer/sample/branches" \
  '{"old_branch_name":"main","new_branch_name":"feature"}' >/dev/null

SHA="$(api "$FORGEJO_API_URL/api/v1/repos/reviewer/sample/contents/fixture.txt?ref=feature" | jq -r '.sha')"
cat > "$TMPDIR/update.json" <<JSON
{
  "branch": "feature",
  "message": "update fixture",
  "content": "dHdvCg==",
  "sha": "$SHA"
}
JSON
api_json PUT "$FORGEJO_API_URL/api/v1/repos/reviewer/sample/contents/fixture.txt" \
  "$(cat "$TMPDIR/update.json")" >/dev/null

PR_JSON="$(api_json POST "$FORGEJO_API_URL/api/v1/repos/reviewer/sample/pulls" \
  '{"base":"main","head":"feature","title":"Update fixture","body":"E2E smoke PR"}')"
PR_NUMBER="$(printf '%s' "$PR_JSON" | jq -r '.number')"
HEAD_SHA="$(printf '%s' "$PR_JSON" | jq -r '.head.sha')"

api_json POST "$FORGEJO_API_URL/api/v1/repos/reviewer/sample/statuses/${HEAD_SHA}" \
  '{"state":"success","context":"build","description":"E2E build passed"}' >/dev/null

WORK="$TMPDIR/work"
git clone -q "$FORGEJO_API_URL/reviewer/sample.git" "$WORK"
(
  cd "$WORK"
  git fetch -q origin pull/${PR_NUMBER}/head:pr-${PR_NUMBER}
  git checkout -q "pr-${PR_NUMBER}"

  export REPO=reviewer/sample
  export PR_NUMBER
  export COMMENT_MARKER='<!-- ai-pr-reviewer -->'
  export GITHUB_OUTPUT="$TMPDIR/precheck.out"
  export REVIEW_SCOPE=auto
  export SKIP_IF_DIFF_UNCHANGED=true
  export FORCE_REVIEW=false
  export PUBLISH_MODE=comment
  bash "$ROOT_DIR/scripts/check_review_needed.sh"

  grep -q '^should_review=true$' "$TMPDIR/precheck.out"
  jq -e '.head.sha == env.HEAD_SHA and .base.ref == "main"' pr-object.json >/dev/null

  export PR_HEAD_SHA="$HEAD_SHA"
  export GITHUB_OUTPUT="$TMPDIR/ci.out"
  export CI_STATUS_CHECK=true
  export CI_TIMEOUT_SEC=6
  export CI_INTERVAL_SEC=1
  export CI_CHECKS_FILE="$TMPDIR/ci-checks.md"
  bash "$ROOT_DIR/scripts/wait_for_ci.sh"
  grep -q '^ci_status_final=success$' "$TMPDIR/ci.out"

  source "$ROOT_DIR/scripts/platform_api.sh"
  printf '%s\n' "$COMMENT_MARKER" "Forgejo E2E sticky comment" > "$TMPDIR/comment.md"
  platform_comment_sticky "$REPO" "$PR_NUMBER" "$TMPDIR/comment.md"
  platform_issue_comments "$REPO" "$PR_NUMBER" | jq -e '.[] | select(.body | contains("Forgejo E2E sticky comment"))' >/dev/null
)

echo "PASS: Forgejo backend E2E smoke completed against $IMAGE"
