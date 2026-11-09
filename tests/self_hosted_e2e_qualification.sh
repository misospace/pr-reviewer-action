#!/usr/bin/env bash
set -euo pipefail

# Self-hosted qualification harness (#1482): the core E2E pipeline for
# Operator mode with no per-repository workflow. It starts a disposable
# PostgreSQL and a disposable instance through Docker, runs the real
# controller daemon composition from the built v3 bundle with the local
# executor (which spawns `node dist/index.js worker <envelope>`), and
# drives one normal review end-to-end per forge:
#
#   forge event -> verified adapter -> canonical ReviewJob -> durable
#   queue/state -> isolated workspace -> executor -> worker -> review
#   engine -> durable ReviewResult -> exact-head publication
#
# Scenarios (one line each):
#   1. Forgejo: a webhook the instance's own HMAC gate verifies, through
#      the canonical job/engine boundary, published back with the
#      exact-head guard and confirmed from the durable state.
#   2. GitHub: a reconciler-discovered open pull request on the operator
#      test repository, reviewed through the same boundary with GitHub
#      App material, published with the exact-head guard and confirmed
#      from the durable state and the admin API.
#
# Rules (docs/self-hosted-qualification.md): every forge read and write
# the review pipeline performs travels through the configured forge
# capability inside the controller. The harness itself never calls a
# forge CLI against forge state and never reaches a remote forge API
# with a raw HTTP client: raw calls here target only the loopback
# instance and services the harness provisioned itself. The single
# provisioning exception is the in-container server CLI
# (`docker exec <disposable> forgejo admin user create`): the forge
# capability cannot create the disposable instance's first admin, so
# that call is instance setup on a container the harness owns, the same
# pattern as tests/forgejo_e2e_smoke.sh. Credentials (model key, App private key,
# forge token, admin token, webhook secret) ride only in the process
# environment or in curl config files, never in argv, URLs, or log lines.
# A GitHub App installation token minted by the controller follows the
# same rule: the harness reads it from a repository secret set by the
# operator, and the controller owns its lifecycle
# (docs/architecture/self-hosted-github-app-ingress.md).

if [[ "${SELF_HOSTED_QUALIFICATION:-}" != "true" ]]; then
  echo "SKIP: set SELF_HOSTED_QUALIFICATION=true to run the Docker-backed self-hosted qualification harness"
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── input-validation gates (tests/test_forgejo_e2e_smoke_safety.sh) ──
# These run before any Docker or network call so bad values fail fast.

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required: the harness reads every setting and credential from the environment (docs/self-hosted-qualification.md)" >&2
    exit 1
  fi
}

# Same conservative character class as tests/forgejo_e2e_smoke.sh: every
# value interpolated into URLs, config files, or SQL stays inside
# [A-Za-z0-9._:/@-] so it cannot alter quoting or structure.
safe_value() {
  local name="$1" value="$2"
  case "$value" in
    ''|*[!A-Za-z0-9._:/@-]*)
      echo "refusing unsafe $name" >&2
      exit 1
      ;;
  esac
}

# An http(s) endpoint with no embedded credentials: the instance-config
# schema refuses `user:pass@host` endpoints, and the harness holds to the
# same rule for every URL it interpolates into a config file.
endpoint_value() {
  local name="$1" value="$2" rest
  case "$value" in
    http://* | https://*) rest="${value#*://}" ;;
    *)
      echo "$name must be an absolute http(s) URL" >&2
      exit 1
      ;;
  esac
  case "$rest" in
    ''|*[!A-Za-z0-9._:/-]*)
      echo "$name must not embed credentials or unsupported characters in its URL" >&2
      exit 1
      ;;
  esac
}

id_value() {
  local name="$1" value="$2"
  # Digits only, no leading zero, nonzero: the same shape the
  # controller's App-id and installation-id guards require.
  case "$value" in
    '' | 0 | 0[0-9]* | *[!0-9]*)
      echo "$name must be a positive decimal id, got '$value'" >&2
      exit 1
      ;;
  esac
}

repository_value() {
  local name="$1" value="$2" owner repo
  if [[ "$value" != */* || "$value" == */*/* ]]; then
    echo "$name must be an 'owner/name' repository identity, got '$value'" >&2
    exit 1
  fi
  owner="${value%%/*}"
  repo="${value#*/}"
  case "$owner" in ''|*[!A-Za-z0-9._-]*)
    echo "$name must be an 'owner/name' repository identity, got '$value'" >&2
    exit 1
  ;; esac
  case "$repo" in ''|*[!A-Za-z0-9._-]*)
    echo "$name must be an 'owner/name' repository identity, got '$value'" >&2
    exit 1
  ;; esac
}

# Required settings and credentials (the model key and the App private
# key are only shape-checked for presence: their material is opaque and
# must never be printed or interpolated).
require_env AI_BASE_URL
require_env AI_MODEL
require_env AI_API_KEY
require_env PR_REVIEWER_GITHUB_APP_ID
require_env PR_REVIEWER_GITHUB_APP_PRIVATE_KEY
require_env PR_REVIEWER_GITHUB_APP_INSTALLATION_ID
require_env SELF_HOSTED_GITHUB_REPOSITORY
endpoint_value AI_BASE_URL "$AI_BASE_URL"
safe_value AI_MODEL "$AI_MODEL"
id_value PR_REVIEWER_GITHUB_APP_ID "$PR_REVIEWER_GITHUB_APP_ID"
id_value PR_REVIEWER_GITHUB_APP_INSTALLATION_ID "$PR_REVIEWER_GITHUB_APP_INSTALLATION_ID"
repository_value SELF_HOSTED_GITHUB_REPOSITORY "$SELF_HOSTED_GITHUB_REPOSITORY"

# Optional GitHub API base (a non-github.com GitHub side names it; the
# instance config then carries it as the forge endpoint).
GITHUB_API_URL="${GITHUB_API_URL:-https://api.github.com}"
endpoint_value GITHUB_API_URL "$GITHUB_API_URL"

# Tunables, each validated before any Docker call.
FORGEJO_IMAGE="${SELF_HOSTED_FORGEJO_IMAGE-codeberg.org/forgejo/forgejo:9}"
POSTGRES_IMAGE="${SELF_HOSTED_POSTGRES_IMAGE-postgres:16}"
FORGEJO_PORT="${SELF_HOSTED_FORGEJO_PORT-31090}"
POSTGRES_PORT="${SELF_HOSTED_POSTGRES_PORT-31543}"
WEBHOOK_PORT="${SELF_HOSTED_FORGEJO_WEBHOOK_PORT-31810}"
FORGEJO_ADMIN_PORT="${SELF_HOSTED_FORGEJO_ADMIN_PORT-31910}"
GITHUB_ADMIN_PORT="${SELF_HOSTED_GITHUB_ADMIN_PORT-31911}"
REVIEW_TIMEOUT_SEC="${SELF_HOSTED_REVIEW_TIMEOUT_SEC-900}"
safe_value SELF_HOSTED_FORGEJO_IMAGE "$FORGEJO_IMAGE"
safe_value SELF_HOSTED_POSTGRES_IMAGE "$POSTGRES_IMAGE"
for port_var in FORGEJO_PORT POSTGRES_PORT WEBHOOK_PORT FORGEJO_ADMIN_PORT GITHUB_ADMIN_PORT; do
  case "${!port_var}" in
    ''|*[!0-9]*)
      echo "SELF_HOSTED_* port setting $port_var must be numeric, got '${!port_var}'" >&2
      exit 1
      ;;
  esac
done
case "$REVIEW_TIMEOUT_SEC" in
  ''|*[!0-9]* | 0)
    echo "SELF_HOSTED_REVIEW_TIMEOUT_SEC must be a positive number of seconds, got '$REVIEW_TIMEOUT_SEC'" >&2
    exit 1
    ;;
esac
# The executor profile interpolates the bundle path into the instance
# config, so the checkout path itself must stay inside the same class.
safe_value ROOT_DIR "$ROOT_DIR"

# ── toolchain and Docker preflight ──
if ! command -v node >/dev/null 2>&1; then
  echo "node is required on PATH to drive the built v3 runtime bundle" >&2
  exit 1
fi
if [[ ! -f "$ROOT_DIR/dist/index.js" ]]; then
  echo "dist/index.js missing; building the v3 runtime bundle"
  (cd "$ROOT_DIR" && npm ci --no-audit --no-fund && npm run build)
fi
NODE_BIN="$(command -v node)"
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "a reachable Docker daemon is required: the harness starts disposable PostgreSQL and a disposable instance" >&2
  exit 1
fi
for tool in curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required on PATH to drive the disposable stack" >&2
    exit 1
  fi
done

# ── disposable stack ──
NAME="pr-reviewer-selfhosted-e2e-$$"
PG_NAME="$NAME-pg"
FORGEJO_NAME="$NAME-forgejo"
PG_USER=prreviewer
PG_DB=prreviewer
FORGEJO_USER=reviewer
FORGEJO_PASSWORD="selfhosted-e2e-pass"
TOKEN_NAME="pr-reviewer-selfhosted-e2e"
TMP="$(mktemp -d)"
PG_PASSWORD="$("$NODE_BIN" -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
WEBHOOK_SECRET="$("$NODE_BIN" -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
FORGEJO_ADMIN_TOKEN="$("$NODE_BIN" -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
GITHUB_ADMIN_TOKEN="$("$NODE_BIN" -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
CONTROL_PLANE_URL="postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${PG_DB}"
# Loopback targets for every raw call below: the harness owns this
# instance and these services, so these are test setup, not forge
# reads or writes of the review pipeline (docs/self-hosted-qualification.md).
FORGEJO_API_URL="http://127.0.0.1:${FORGEJO_PORT}"
CONTROLLER_PIDS=()

# shellcheck disable=SC2329  # invoked indirectly by the EXIT trap below
cleanup() {
  local pid
  for pid in "${CONTROLLER_PIDS[@]:-}"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  docker rm -f "$PG_NAME" "$FORGEJO_NAME" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# POSTGRES_PASSWORD rides the docker CLI's inherited environment: the
# assignment prefix is process environment, not argv.
POSTGRES_PASSWORD="$PG_PASSWORD" docker run -d --name "$PG_NAME" \
  -p "127.0.0.1:${POSTGRES_PORT}:5432" \
  -e POSTGRES_PASSWORD -e "POSTGRES_USER=${PG_USER}" -e "POSTGRES_DB=${PG_DB}" \
  "$POSTGRES_IMAGE" >/dev/null

pg_ready=0
for _ in {1..90}; do
  if PGPASSWORD="$PG_PASSWORD" docker exec -i -e PGPASSWORD "$PG_NAME" \
    pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    pg_ready=1
    break
  fi
  sleep 1
done
if [[ "$pg_ready" != 1 ]]; then
  echo "PostgreSQL did not become ready" >&2
  exit 1
fi

# pg_query runs against the durable control-plane store; the password
# rides docker's inherited environment, never argv.
pg_query() {
  PGPASSWORD="$PG_PASSWORD" docker exec -i -e PGPASSWORD "$PG_NAME" \
    psql -U "$PG_USER" -d "$PG_DB" -tA -F '|' -v ON_ERROR_STOP=1 -c "$1"
}

docker run -d --name "$FORGEJO_NAME" \
  -p "127.0.0.1:${FORGEJO_PORT}:3000" \
  -e USER_UID=1000 \
  -e USER_GID=1000 \
  -e FORGEJO__security__INSTALL_LOCK=true \
  -e FORGEJO__server__ROOT_URL="http://127.0.0.1:${FORGEJO_PORT}/" \
  -e FORGEJO__service__DISABLE_REGISTRATION=true \
  -e FORGEJO__repository__DEFAULT_BRANCH=main \
  "$FORGEJO_IMAGE" >/dev/null

wait_forgejo_http() {
  local path="$1"
  for _ in {1..90}; do
    if curl -fsS "$FORGEJO_API_URL$path" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Forgejo did not become ready at $FORGEJO_API_URL$path" >&2
  return 1
}
wait_forgejo_http /api/healthz

container_forgejo() {
  docker exec -u git "$FORGEJO_NAME" forgejo \
    --config /data/gitea/conf/app.ini \
    --work-path /data/gitea "$@"
}

container_forgejo admin user create \
  --username "$FORGEJO_USER" \
  --password "$FORGEJO_PASSWORD" \
  --email reviewer@example.test \
  --admin \
  --must-change-password=false >/dev/null

# The disposable admin's clear-text password mints the token the
# pipeline reads from environment; the password itself is never needed
# again and the token only ever reaches the loopback instance.
cat > "$TMP/token.cfg" <<CFGEOF
url = "$FORGEJO_API_URL/api/v1/users/$FORGEJO_USER/tokens"
user = "$FORGEJO_USER:$FORGEJO_PASSWORD"
header = "Content-Type: application/json"
data = "{\"name\":\"$TOKEN_NAME\",\"scopes\":[\"write:repository\",\"write:issue\",\"read:user\",\"write:user\"]}"
CFGEOF
FORGEJO_TOKEN="$(curl -fsS -K "$TMP/token.cfg" | jq -r '.sha1')"
if [[ -z "$FORGEJO_TOKEN" || "$FORGEJO_TOKEN" == "null" ]]; then
  echo "Forgejo token creation returned no token" >&2
  exit 1
fi
export FORGEJO_TOKEN
export PR_REVIEWER_CREDENTIAL_MODEL="$AI_API_KEY"

fapi_json() {
  local method="$1" path="$2" body="$3"
  printf 'header = "Authorization: token %s"\n' "$FORGEJO_TOKEN" > "$TMP/auth.cfg"
  curl -fsS -K "$TMP/auth.cfg" -X "$method" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "$FORGEJO_API_URL$path"
}
fapi_get() {
  printf 'header = "Authorization: token %s"\n' "$FORGEJO_TOKEN" > "$TMP/auth.cfg"
  curl -fsS -K "$TMP/auth.cfg" "$FORGEJO_API_URL$1"
}

# A normal pull request on a normal repository: base commit, feature
# branch, feature update, then the PR the event names.
fapi_json POST /api/v1/user/repos '{"name":"sample","auto_init":true,"default_branch":"main"}' >/dev/null
fapi_json POST /api/v1/repos/reviewer/sample/contents/fixture.txt \
  '{"branch":"main","message":"add fixture","content":"b25lCg=="}' >/dev/null
fapi_json POST /api/v1/repos/reviewer/sample/branches \
  '{"old_branch_name":"main","new_branch_name":"feature"}' >/dev/null
SHA="$(fapi_get "/api/v1/repos/reviewer/sample/contents/fixture.txt?ref=feature" | jq -r '.sha')"
fapi_json PUT /api/v1/repos/reviewer/sample/contents/fixture.txt \
  "{\"branch\":\"feature\",\"message\":\"update fixture\",\"content\":\"dHdvCg==\",\"sha\":\"$SHA\"}" >/dev/null
PR_JSON="$(fapi_json POST /api/v1/repos/reviewer/sample/pulls \
  '{"base":"main","head":"feature","title":"Self-hosted qualification PR","body":"normal review scenario"}')"
PR_NUMBER="$(printf '%s' "$PR_JSON" | jq -r '.number')"
PR_ID="$(printf '%s' "$PR_JSON" | jq -r '.id')"
HEAD_SHA="$(printf '%s' "$PR_JSON" | jq -r '.head.sha')"
BASE_SHA="$(printf '%s' "$PR_JSON" | jq -r '.base.sha')"
# PR number and id feed JSON (--argjson), the destination SQL, and the
# webhook URL, so they must be digits; the SHAs feed jq and durable-state
# comparisons, so they must stay hex-safe.
for value_name in PR_NUMBER PR_ID; do
  case "${!value_name}" in
    '' | null | *[!0-9]*)
      echo "Forgejo PR creation returned no numeric $value_name" >&2
      exit 1
      ;;
  esac
done
for value_name in HEAD_SHA BASE_SHA; do
  case "${!value_name}" in
    '' | null | *[!A-Fa-f0-9]*)
      echo "Forgejo PR creation returned no hexadecimal $value_name" >&2
      exit 1
      ;;
  esac
done

# ── instance configs ──
# Model profile names a wire model id (#1486 known limit: a profile
# without one refuses worker-driven reviews at composition).
write_model_section() {
  cat <<MODEEOF
model-profiles:
  - name: primary
    endpoint: "$AI_BASE_URL"
    api-format: openai
    credential: model
    model: "$AI_MODEL"
default-model-profile: primary
executor-profiles:
  - name: local
    kind: local
    local:
      command: "$NODE_BIN"
      args: ["$ROOT_DIR/dist/index.js", "worker"]
default-executor-profile: local
evidence-profiles:
  - name: qualification
    providers-file: "$TMP/evidence-providers.yml"
default-evidence-profile: qualification
MODEEOF
}
: > "$TMP/evidence-providers.yml"

cat > "$TMP/instance-forgejo.yaml" <<CFGEOF
version: 1
forges:
  - name: qualification-forgejo
    kind: forgejo
    endpoint: "$FORGEJO_API_URL"
    credential: forgejo
$(write_model_section)
adoption:
  mode: allowlist
  allowlist: ["reviewer/sample"]
CFGEOF

cat > "$TMP/instance-github.yaml" <<CFGEOF
version: 1
forges:
  - name: qualification-github
    kind: github
    endpoint: "$GITHUB_API_URL"
    credential: github
$(write_model_section)
adoption:
  mode: allowlist
  allowlist: ["$SELF_HOSTED_GITHUB_REPOSITORY"]
CFGEOF

# ── controller helper ──
# The controller runs in this harness's own environment so the exported
# credential material (model key via PR_REVIEWER_CREDENTIAL_MODEL,
# FORGEJO_TOKEN, GitHub App material) reaches it without ever entering
# argv. Platform-specific intake settings are exported by the caller
# immediately before start_controller and unset again after.
start_controller() {
  local instance_config="$1" log="$2" admin_port="$3" admin_token="$4" root_dir="$5"
  mkdir -p "$root_dir/state" "$root_dir/runs" "$root_dir/workspace-cache"
  (
    export PR_REVIEWER_INSTANCE_CONFIG="$instance_config"
    export PR_REVIEWER_CONTROL_PLANE_URL="$CONTROL_PLANE_URL"
    export PR_REVIEWER_DURABLE_STATE_DIR="$root_dir/state"
    export PR_REVIEWER_RUNS_ROOT="$root_dir/runs"
    export PR_REVIEWER_WORKSPACE_CACHE_ROOT="$root_dir/workspace-cache"
    export PR_REVIEWER_ADMIN_PORT="$admin_port"
    export PR_REVIEWER_ADMIN_TOKEN="$admin_token"
    exec "$NODE_BIN" "$ROOT_DIR/dist/index.js" controller
  ) >"$log" 2>&1 &
  CONTROLLER_PIDS+=("$!")
}

wait_controller_ready() {
  local port="$1" label="$2" log="$3" pid="$4"
  local stage path ready
  for stage in healthz readyz; do
    path="http://127.0.0.1:${port}/${stage}"
    ready=0
    for _ in {1..60}; do
      if curl -fsS "$path" >/dev/null 2>&1; then
        ready=1
        break
      fi
      if ! kill -0 "$pid" 2>/dev/null; then
        echo "$label controller exited before reporting $stage; last log lines:" >&2
        tail -n 30 "$log" >&2 || true
        return 1
      fi
      sleep 1
    done
    if [[ "$ready" != 1 ]]; then
      echo "$label controller did not report $stage at $path" >&2
      tail -n 30 "$log" >&2 || true
      return 1
    fi
  done
}

# ── durable-state wait ──
# The published row is the durable ReviewResult: cp_publications carries
# the forge-confirmed publication id, the result head, and the canonical
# result payload; cp_runs mirrors the run lifecycle.
wait_published() {
  local dest_clause="$1" label="$2" log="$3" deadline=$((SECONDS + REVIEW_TIMEOUT_SEC))
  local row bad
  while true; do
    bad="$(pg_query "SELECT state || '|' || COALESCE(failure_reason,'') || '|' || run_id FROM cp_runs WHERE state IN ('failed','cancelled','superseded') LIMIT 1")"
    if [[ -n "$bad" ]]; then
      echo "$label scenario ended in a terminal non-completed run state: $bad" >&2
      tail -n 30 "$log" >&2 || true
      return 1
    fi
    row="$(pg_query "SELECT r.state || '|' || p.publication_state || '|' || p.publication_id || '|' || p.result_head_sha || '|' || r.head_sha || '|' || r.run_id || '|' || (length(p.result_payload) > 0) FROM cp_publications p JOIN cp_runs r ON r.job_id = p.job_id WHERE $dest_clause ORDER BY r.attempt DESC LIMIT 1")"
    if [[ -n "$row" ]]; then
      IFS='|' read -r PUBLISHED_RUN_STATE PUBLICATION_STATE PUBLICATION_ID RESULT_HEAD_SHA RUN_HEAD_SHA RUN_ID HAS_RESULT_PAYLOAD <<<"$row"
      if [[ "$PUBLISHED_RUN_STATE" == completed && "$PUBLICATION_STATE" == published ]]; then
        return 0
      fi
    fi
    if (( SECONDS >= deadline )); then
      echo "$label scenario did not publish within ${REVIEW_TIMEOUT_SEC}s; last log lines:" >&2
      tail -n 30 "$log" >&2 || true
      return 1
    fi
    sleep 5
  done
}

assert_usage_counted() {
  local used
  used="$(pg_query "SELECT count(*) FROM cp_usage WHERE run_id = '$RUN_ID'")"
  case "$used" in
    '' | 0)
      echo "durable usage recorded no model spend for run $RUN_ID" >&2
      return 1
      ;;
  esac
}

assert_admin_reports_publication() {
  local port="$1" token="$2" cfg="$3"
  case "$RUN_ID" in
    ''|*[!A-Za-z0-9._-]*)
      echo "unexpected durable run id shape" >&2
      return 1
      ;;
  esac
  printf 'header = "Authorization: Bearer %s"\n' "$token" > "$cfg"
  curl -fsS -K "$cfg" "http://127.0.0.1:${port}/admin/runs/${RUN_ID}" |
    jq -e '.state == "completed" and .publication.state == "published" and .publication.attempt >= 1' >/dev/null
}

# ── scenario 1: normal Forgejo review through the webhook intake ──
# One forge kind per controller process ("the controller serves one
# forge per instance"), so each scenario gets its own daemon, roots, and
# admin port over the same disposable PostgreSQL.
export PR_REVIEWER_WEBHOOK_PORT="$WEBHOOK_PORT"
export PR_REVIEWER_WEBHOOK_SECRET="$WEBHOOK_SECRET"
start_controller "$TMP/instance-forgejo.yaml" "$TMP/forgejo-controller.log" \
  "$FORGEJO_ADMIN_PORT" "$FORGEJO_ADMIN_TOKEN" "$TMP/forgejo"
FORGEJO_CONTROLLER_PID="${CONTROLLER_PIDS[-1]}"
wait_controller_ready "$FORGEJO_ADMIN_PORT" forgejo "$TMP/forgejo-controller.log" "$FORGEJO_CONTROLLER_PID"

jq -n \
  --arg repo "reviewer/sample" \
  --argjson number "$PR_NUMBER" \
  --argjson prId "$PR_ID" \
  --arg sha "$HEAD_SHA" \
  --arg baseSha "$BASE_SHA" \
  --arg html "$FORGEJO_API_URL/reviewer/sample/pulls/${PR_NUMBER}" \
  --arg clone "$FORGEJO_API_URL/reviewer/sample.git" \
  '{
    action: "opened",
    number: $number,
    title: "Self-hosted qualification PR",
    body: "normal review scenario",
    draft: false,
    merged: false,
    merged_at: null,
    head_sha: $sha,
    base_sha: $baseSha,
    head: { label: "reviewer:feature", ref: "feature", sha: $sha, repo: { full_name: $repo } },
    base: { label: "reviewer:main", ref: "main", sha: $baseSha, repo: { full_name: $repo } },
    pull_request: {
      id: $prId,
      number: $number,
      title: "Self-hosted qualification PR",
      body: "normal review scenario",
      draft: false,
      merged: false,
      merged_at: null,
      head: { label: "reviewer:feature", ref: "feature", sha: $sha, repo: { full_name: $repo } },
      base: { label: "reviewer:main", ref: "main", sha: $baseSha, repo: { full_name: $repo } },
      user: { login: "reviewer" }
    },
    repository: {
      id: 1,
      name: "sample",
      full_name: $repo,
      private: false,
      fork: false,
      html_url: $html,
      clone_url: $clone,
      owner: { login: "reviewer" }
    },
    sender: { login: "reviewer" },
    user: { login: "reviewer" }
  }' > "$TMP/webhook.json"

# The webhook secret rides the node process environment, never argv.
WEBHOOK_SIGNATURE="$(WEBHOOK_SECRET="$WEBHOOK_SECRET" "$NODE_BIN" -e '
const fs = require("fs");
const crypto = require("crypto");
console.log(crypto.createHmac("sha256", process.env.WEBHOOK_SECRET).update(fs.readFileSync(process.argv[1])).digest("hex"));
' "$TMP/webhook.json")"

WEBHOOK_STATUS="$(curl -sS -o "$TMP/webhook-response.json" -w '%{http_code}' \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Gitea-Event: pull_request" \
  -H "X-Gitea-Signature: $WEBHOOK_SIGNATURE" \
  --data-binary "@$TMP/webhook.json" \
  "http://127.0.0.1:${WEBHOOK_PORT}/")"
if [[ "$WEBHOOK_STATUS" != 202 ]]; then
  echo "webhook intake did not accept the signed delivery (HTTP $WEBHOOK_STATUS)" >&2
  cat "$TMP/webhook-response.json" >&2 || true
  tail -n 30 "$TMP/forgejo-controller.log" >&2 || true
  exit 1
fi
jq -e '.status == "accepted" and .kind == "pr_opened"' "$TMP/webhook-response.json" >/dev/null

FORGEJO_DEST="forgejo:reviewer/sample#${PR_NUMBER}"
if ! wait_published "p.destination = '$FORGEJO_DEST'" \
  "Forgejo normal review" "$TMP/forgejo-controller.log"; then
  exit 1
fi
case "$PUBLICATION_ID" in
  forgejo-comment:*) FORGEJO_COMMENT_ID="${PUBLICATION_ID#forgejo-comment:}" ;;
  *)
    echo "Forgejo publication id did not carry the forge-confirmed comment identity: $PUBLICATION_ID" >&2
    exit 1
    ;;
esac
case "$FORGEJO_COMMENT_ID" in
  ''|*[!0-9]*)
    echo "unexpected Forgejo comment id shape" >&2
    exit 1
    ;;
esac
# Exact-head publication: the durable guard published against this head,
# and the forge-confirmed comment exists on the disposable instance.
if [[ "$RESULT_HEAD_SHA" != "$HEAD_SHA" || "$RUN_HEAD_SHA" != "$HEAD_SHA" ]]; then
  echo "Forgejo publication did not carry the event head as the result head" >&2
  exit 1
fi
fapi_get "/api/v1/repos/reviewer/sample/issues/comments/${FORGEJO_COMMENT_ID}" |
  jq -e --argjson commentId "$FORGEJO_COMMENT_ID" '.id == $commentId and (.body | length > 0)' >/dev/null
assert_usage_counted
assert_admin_reports_publication "$FORGEJO_ADMIN_PORT" "$FORGEJO_ADMIN_TOKEN" "$TMP/admin-forgejo.cfg"
echo "PASS: self-hosted Forgejo normal review qualified end-to-end through the canonical job and engine boundary (repo reviewer/sample, PR ${PR_NUMBER}, head ${HEAD_SHA}, publication ${PUBLICATION_ID})"

# ── scenario 2: normal GitHub review with no per-repository workflow ──
# The reconciler discovers the operator's open test PR through the
# GitHub App forge capability (webhook intake is not reachable from
# outside on a disposable host); everything the pipeline then reads or
# writes of GitHub state goes through that capability.
unset PR_REVIEWER_WEBHOOK_PORT PR_REVIEWER_WEBHOOK_SECRET
export PR_REVIEWER_RECONCILE_INTERVAL_MS=10000
export PR_REVIEWER_RECONCILE_REPOS="$SELF_HOSTED_GITHUB_REPOSITORY"
start_controller "$TMP/instance-github.yaml" "$TMP/github-controller.log" \
  "$GITHUB_ADMIN_PORT" "$GITHUB_ADMIN_TOKEN" "$TMP/github"
GITHUB_CONTROLLER_PID="${CONTROLLER_PIDS[-1]}"
wait_controller_ready "$GITHUB_ADMIN_PORT" github "$TMP/github-controller.log" "$GITHUB_CONTROLLER_PID"

if ! wait_published "p.destination LIKE 'github:${SELF_HOSTED_GITHUB_REPOSITORY}#%'" \
  "GitHub normal review" "$TMP/github-controller.log"; then
  exit 1
fi
case "$PUBLICATION_ID" in
  github-comment:*) ;;
  *)
    echo "GitHub publication id did not carry the forge-confirmed comment identity: $PUBLICATION_ID" >&2
    exit 1
    ;;
esac
if [[ "$RESULT_HEAD_SHA" != "$RUN_HEAD_SHA" ]]; then
  echo "GitHub publication did not carry the discovered head as the result head" >&2
  exit 1
fi
assert_usage_counted
assert_admin_reports_publication "$GITHUB_ADMIN_PORT" "$GITHUB_ADMIN_TOKEN" "$TMP/admin-github.cfg"
echo "PASS: self-hosted GitHub normal review qualified end-to-end with no per-repository workflow (repo ${SELF_HOSTED_GITHUB_REPOSITORY}, publication ${PUBLICATION_ID})"

exit 0
