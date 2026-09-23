#!/usr/bin/env bash
set -euo pipefail

# End-to-end Forgejo smoke harness for the platform backend and the v3
# runner-facing contract (#683). It is opt-in because it starts disposable
# Forgejo + act_runner containers and needs Docker. It exercises the real
# Forgejo REST seam that the composite action uses: precheck PR metadata/diff,
# CI commit-status polling, and sticky comments — then registers an ephemeral
# Forgejo Actions runner and executes the retained v3 runtime compatibility
# fixture (#682) as a real workflow job.
if [[ "${FORGEJO_E2E:-}" != "true" ]]; then
  echo "SKIP: set FORGEJO_E2E=true to run the Docker-backed Forgejo smoke test"
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${FORGEJO_E2E_IMAGE:-codeberg.org/forgejo/forgejo:9}"
RUNNER_IMAGE="${FORGEJO_E2E_RUNNER_IMAGE:-code.forgejo.org/forgejo/runner:6.3.1}"
JOB_IMAGE="${FORGEJO_E2E_JOB_IMAGE:-node:22-bullseye}"
# Host alias job containers use to reach the Forgejo service. Docker
# Desktop/OrbStack resolve host.docker.internal by default; on a plain Linux
# daemon set it to the bridge gateway (for example 172.17.0.1).
HOST_ALIAS="${FORGEJO_E2E_HOST_ALIAS:-host.docker.internal}"
NAME="pr-reviewer-forgejo-e2e-$$"
RUNNER_NAME="$NAME-runner"
HTTP_PORT="${FORGEJO_E2E_PORT:-31080}"
PASSWORD="forgejo-e2e-pass"
TOKEN_NAME="pr-reviewer-e2e"
TMPDIR="$(mktemp -d)"

# HOST_ALIAS is interpolated into ROOT_URL and the runner registration URL;
# keep it to hostname characters so it cannot alter the URL structure.
case "$HOST_ALIAS" in
  ''|*[!A-Za-z0-9._-]*)
    echo "FORGEJO_E2E_HOST_ALIAS must match [A-Za-z0-9._-]+, got '$HOST_ALIAS'" >&2
    exit 1
    ;;
esac

cleanup() {
  docker rm -f "$NAME" "$RUNNER_NAME" >/dev/null 2>&1 || true
  docker volume rm "vol-$RUNNER_NAME" >/dev/null 2>&1 || true
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
  -e FORGEJO__server__ROOT_URL="http://${HOST_ALIAS}:${HTTP_PORT}/" \
  -e FORGEJO__service__DISABLE_REGISTRATION=true \
  -e FORGEJO__repository__DEFAULT_BRANCH=main \
  -e FORGEJO__actions__ENABLED=true \
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
  -d "{\"name\":\"${TOKEN_NAME}\",\"scopes\":[\"write:repository\",\"write:issue\",\"read:user\",\"write:user\"]}" \
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
export HEAD_SHA

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

### Runner compatibility phase (#683): register an ephemeral act_runner and
### execute the retained v3 runtime compatibility fixture (#682) as a real
### Forgejo Actions workflow job on this disposable Forgejo instance.

RUNNER_INSTANCE_URL="http://${HOST_ALIAS}:${HTTP_PORT}"
COMPAT_REPO="runner-compat"
api_json POST "$FORGEJO_API_URL/api/v1/user/repos" \
  "{\"name\":\"${COMPAT_REPO}\",\"auto_init\":true,\"default_branch\":\"main\",\"private\":false}" >/dev/null

# Forgejo 9 has no REST endpoint for runner registration tokens; the server
# CLI generates one.
RUNNER_TOKEN="$(container_forgejo actions generate-runner-token | tail -n1 | tr -d '[:space:]')"

# The job image is pulled on the host daemon up front so the runner uses the
# pinned, already-present image instead of racing a registry pull.
docker pull -q "$JOB_IMAGE" >/dev/null

# The runner launches job containers through the host Docker daemon, so it
# needs the Docker socket (root-owned there) and its registration state is
# kept in a named volume to avoid host bind-mount permission differences.
# The registration token is generated by this same disposable container and
# dies with it; it is never exported or reused beyond this registration.
docker run -d --name "$RUNNER_NAME" --user 0:0 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "vol-$RUNNER_NAME:/data" \
  -w /data \
  "$RUNNER_IMAGE" \
  sh -c "forgejo-runner register --no-interactive --instance '$RUNNER_INSTANCE_URL' --token '$RUNNER_TOKEN' --name compat-runner --labels 'node22:docker://$JOB_IMAGE' && exec forgejo-runner daemon" >/dev/null

COMPAT_WORK="$TMPDIR/compat-work"
git clone -q "$FORGEJO_API_URL/reviewer/${COMPAT_REPO}.git" "$COMPAT_WORK"
mkdir -p "$COMPAT_WORK/.forgejo/workflows" "$COMPAT_WORK/v3/composite"
cp "$ROOT_DIR/tests/fixtures/v3-runtime/cli-entry.mjs" \
  "$ROOT_DIR/tests/fixtures/v3-runtime/cli.mjs" \
  "$ROOT_DIR/tests/fixtures/v3-runtime/marker.txt" \
  "$COMPAT_WORK/v3/"
cp "$ROOT_DIR/tests/fixtures/v3-runtime/composite/action.yml" "$COMPAT_WORK/v3/composite/"
cp "$ROOT_DIR/tests/fixtures/forgejo/runner-compat/compat-workflow.yml" \
  "$COMPAT_WORK/.forgejo/workflows/compat.yml"
(
  cd "$COMPAT_WORK"
  git add -A
  git -c user.email=runner-compat@example.test -c user.name=runner-compat commit -qm "compatibility probe"
  git push -q "http://reviewer:${PASSWORD}@127.0.0.1:${HTTP_PORT}/reviewer/${COMPAT_REPO}.git" main
)

# Wait for the workflow task triggered by the push and require success.
TASK_STATUS=""
TASK_ID=""
for _ in {1..60}; do
  TASK_LINE="$(api "$FORGEJO_API_URL/api/v1/repos/reviewer/${COMPAT_REPO}/actions/tasks" |
    jq -r '[.workflow_runs[] | select(.workflow_id == "compat.yml")] | sort_by(.id) | last | "\(.id // "") \(.status // "")" // empty')"
  TASK_ID="${TASK_LINE%% *}"
  TASK_STATUS="${TASK_LINE#* }"
  case "$TASK_STATUS" in
    success | failure | cancelled) break ;;
  esac
  sleep 5
done

if [[ "$TASK_STATUS" != "success" ]]; then
  echo "compat workflow task ${TASK_ID:-?} ended with status '${TASK_STATUS:-unknown}'" >&2
  exit 1
fi

# Job logs are stored zstd-compressed inside the Forgejo container and are
# not exposed over REST; decompress with a host zstd when available.
LOG_ZST="$(docker exec "$NAME" find /data/gitea/actions_log -name "${TASK_ID}.log.zst" | head -n1)"
docker exec "$NAME" cat "$LOG_ZST" > "$TMPDIR/compat.log.zst"
if command -v zstd >/dev/null 2>&1; then
  zstd -d -f -o "$TMPDIR/compat.log" "$TMPDIR/compat.log.zst"
elif command -v unzstd >/dev/null 2>&1; then
  unzstd -f -o "$TMPDIR/compat.log" "$TMPDIR/compat.log.zst"
else
  docker run --rm -i alpine:3.20 sh -c 'apk add -q zstd >/dev/null 2>&1; zstd -d -c' \
    < "$TMPDIR/compat.log.zst" > "$TMPDIR/compat.log"
fi

# The workflow itself asserted execution, kebab inputs, GITHUB_ACTION_PATH,
# outputs, event/repository aliases, GITHUB_OUTPUT, the in-step step summary,
# and failure/finalization semantics; reaching success means all held. The log
# adds the masking evidence: the add-mask probe is redacted and the raw probe
# string and raw token never appear.
grep -qF 'Job succeeded' "$TMPDIR/compat.log"
grep -qF 'mask probe: ***' "$TMPDIR/compat.log"
grep -qF 'intentional spike failure' "$TMPDIR/compat.log"
[[ "$(grep -cF 'spike composite: finalizer ran' "$TMPDIR/compat.log")" -eq 2 ]]
if grep -qF 'v3-spike-mask-probe' "$TMPDIR/compat.log"; then
  echo "mask probe leaked unredacted into the job log" >&2
  exit 1
fi
if [[ -n "${FORGEJO_TOKEN:-}" ]] && grep -qF "$FORGEJO_TOKEN" "$TMPDIR/compat.log"; then
  echo "Forgejo token leaked unredacted into the job log" >&2
  exit 1
fi

echo "PASS: Forgejo runner compat qualified against $IMAGE with $RUNNER_IMAGE (task $TASK_ID, job image $JOB_IMAGE): composite local action, node launcher preflight, GITHUB_ACTION_PATH, kebab inputs, output propagation, event/repository aliases, GITHUB_OUTPUT, in-step step summary, secret masking, failure/finalization, Forgejo REST adapter"
