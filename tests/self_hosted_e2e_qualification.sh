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
# Failure/restart/supersession/idempotency scenarios (#1483), each a
# discrete function over the same disposable stack:
#   3. A duplicate webhook produces exactly one review.
#   4. A webhook burst settles into one paid review of the newest head.
#   5. A new head while the old review waits in the queue: the old
#      generation is superseded with no spend, the newest head is paid
#      once.
#   6. A new head while the old review runs: the old worker is cancelled
#      by identity with no spend, the newest head is paid once.
#   7. A stale result tries to publish: the exact-head gate refuses it
#      and the newest head publishes.
#   8. A worker that times out: NOT drivable in this composition (jobs
#      are minted without a deadline and the lease default is 30 minutes)
#      — the function prints the documented limitation and skips, per
#      docs/self-hosted-qualification.md.
#   9. A worker crash: the attempt fails, the queue requeues, and the
#      retry's spend is the only spend counted.
#  10. A controller crash while a worker runs: the restarted daemon
#      adopts the orphaned worker and publishes its result without a
#      second model call.
#  11. An operator restart with queued settle-window work: the queued
#      generation survives the crash and dispatches exactly once.
#  12. A cancelled review: the graceful stop cancels the run; nothing is
#      published and no spend is counted.
#  13. A publication that fails (forge unreadable at publish time), then
#      retries from the durable record with no second model call.
#  14. Usage and cost accounting stays single-counted across the
#      retries and restarts the earlier scenarios produced.
#  15. A primary model failure: every attempt fails with no spend
#      counted. The fallback leg is NOT drivable (the execution envelope
#      carries a single model selection) — documented, not fabricated.
#  16. A missed webhook: the reconciler discovers the pull request and
#      reviews it exactly once.
#
# Engine parity and eval-qualification scenarios (#1484), over one
# dedicated parity pull request and a harness-owned stub model server:
# the stub is a loopback Node service the harness starts before the
# parity scenarios and kills in cleanup(), shaped like the disposable
# Forgejo — harness-provisioned test infrastructure, not a remote
# dependency. It answers OpenAI-format chat-completions requests with a
# FIXED verdict, streamed (SSE frames) or not, so model-output
# nondeterminism is removed and artifact parity is assertable:
#  17. Route A, the self-hosted local executor: a parity instance
#      config (model profile pointed at the stub) drives a webhook
#      controller that reviews the parity head; the published artifact
#      is read back from the durable state (cp_publications.result_payload).
#  18. Route B, the Action adapter: the shipped JavaScript action entry
#      (node dist/index.js, the very entry action.yml runs) reviews the
#      same head the way the runner drives it: the contract inputs as
#      INPUT_* environment variables, the received pull_request payload
#      as GITHUB_EVENT_PATH, and the ambient runner context.
#  19. Route C, the OCI worker image: the built worker image reviews the
#      same head from Route A's rewritten execution envelope over a
#      fresh exact-head clone (credentials ride the environment only).
#  20. Route D, the Kubernetes executor: the real executor
#      (src/executor/kubernetes.ts) reviews the same head over the same
#      worker image, with the cluster side bound to a harness-owned
#      double (the executor's own API and credential-store seams, driven
#      by tests/harness/kubernetes-route.ts) — no cluster, no scheduler.
#  21. The four produced artifacts normalize to the policy-stable
#      field set and must be byte-identical; run-specific fields
#      (ids, timestamps, durations, usage/token accounting, run-dir and
#      workspace paths, comment ids) are the approved nondeterminism.
#  22. The deterministic eval suites re-run from the tree that
#      produced the engine build (the offline semantic gate; no
#      model, no network).
#  23. The v3 parity suites re-run from the tree that produced the
#      engine build, and the bundle-level suites drive dist/index.js
#      itself: the built bundle's contract and entrypoint parity, the
#      recorded golden decisions, the platform seam, and the generated
#      action manifest.
#  24. The v3 security suites re-run from the tree that produced the
#      engine build: the sanitizer, the redaction and secret shapes, the
#      adaptive fence, the safe fetch, the path safety, the tool
#      allowlists, the credential broker, the MCP read-only surface, and
#      the ingress signature.
#  25. The broader eval corpus re-runs against the engine build: the
#      retained real-PR fixtures replay offline through the built
#      bundle (review context only, no model call).
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
# environment or in curl config files, or in the harness's own temp-dir
# files a tool reads back (engine request files), never in argv, URLs, or
# log lines.
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
STUB_MODEL_PORT="${SELF_HOSTED_STUB_MODEL_PORT-31920}"
REVIEW_TIMEOUT_SEC="${SELF_HOSTED_REVIEW_TIMEOUT_SEC-900}"
safe_value SELF_HOSTED_FORGEJO_IMAGE "$FORGEJO_IMAGE"
safe_value SELF_HOSTED_POSTGRES_IMAGE "$POSTGRES_IMAGE"
for port_var in FORGEJO_PORT POSTGRES_PORT WEBHOOK_PORT FORGEJO_ADMIN_PORT GITHUB_ADMIN_PORT STUB_MODEL_PORT; do
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
STUB_MODEL_PID=""

# shellcheck disable=SC2329  # invoked indirectly by the EXIT trap below
cleanup() {
  local pid
  for pid in "${CONTROLLER_PIDS[@]:-}"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  if [[ -n "$STUB_MODEL_PID" ]]; then
    kill "$STUB_MODEL_PID" >/dev/null 2>&1 || true
  fi
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
# The forge integration's #735 credential material (#1484): the instance
# configs name `credential: forgejo`, and the controller collects this
# env-defined material opportunistically so the worker credential plan's
# `forge-publish` reference resolves (the worker's engine performs the
# review's forge reads). The GitHub instance config's `credential: github`
# resolves the same way, from `PR_REVIEWER_CREDENTIAL_GITHUB`, when the
# operator provides it.
export PR_REVIEWER_CREDENTIAL_FORGEJO="$FORGEJO_TOKEN"

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
# discovered-default: adopt is what makes the allowlist effective for a
# fresh disposable control plane: with the skip default an allowlisted
# repository only reaches eligible, the adoption identity resolver
# returns null for it, and no worker is ever enqueued (review of be86aac).
adoption:
  mode: allowlist
  allowlist: ["reviewer/sample"]
  discovered-default: adopt
CFGEOF

cat > "$TMP/instance-github.yaml" <<CFGEOF
version: 1
forges:
  - name: qualification-github
    kind: github
    endpoint: "$GITHUB_API_URL"
    credential: github
$(write_model_section)
# Same as the Forgejo config: without discovered-default: adopt the
# allowlisted reconciler target holds at eligible and never enqueues.
adoption:
  mode: allowlist
  allowlist: ["$SELF_HOSTED_GITHUB_REPOSITORY"]
  discovered-default: adopt
CFGEOF

# ── engine parity instance config (#1484) ──
# Same shape as instance-forgejo.yaml, but the model profile points at
# the harness-owned stub model server instead of the operator's model
# endpoint. The stub URL keeps the path-less base form: the transport
# joins `/chat/completions` onto the base (`resolveEndpointChannel`,
# src/transport/http.ts), so `http://127.0.0.1:<port>/v1` becomes
# `http://127.0.0.1:<port>/v1/chat/completions`, which the stub answers.
write_stub_model_section() {
  cat <<MODEEOF
model-profiles:
  - name: primary
    endpoint: "http://127.0.0.1:${STUB_MODEL_PORT}/v1"
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

cat > "$TMP/instance-parity.yaml" <<CFGEOF
version: 1
forges:
  - name: qualification-forgejo
    kind: forgejo
    endpoint: "$FORGEJO_API_URL"
    credential: forgejo
$(write_stub_model_section)
# Same as the Forgejo config: without discovered-default: adopt the
# allowlisted repository holds at eligible and never enqueues.
adoption:
  mode: allowlist
  allowlist: ["reviewer/sample"]
  discovered-default: adopt
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
#
# PER-SCENARIO SCOPING (#1483): the harness shares one PostgreSQL across
# every scenario controller, so a global "any terminal run fails the
# wait" check would trip on another scenario's expected terminal state
# (a superseded head, a stale-refused result, a crashed attempt). The
# terminal check therefore only sees runs of jobs that belong to THIS
# scenario's destination — jobs with a publication row for it, plus jobs
# the durable queue snapshot names for its repository and PR number —
# and the caller names the terminal states its own scenario EXPECTS
# (`expected_terminal`, an extended regex over `state|failure_reason`
# rows). Anything else fails the wait fast instead of burning the
# scenario timeout.
wait_published() {
  local dest_clause="$1" label="$2" log="$3" expected_terminal="${4:-^$}" deadline=$((SECONDS + REVIEW_TIMEOUT_SEC))
  local row bad line
  # The queue snapshot is one jsonb row of JobRecords; a record's job
  # carries the repository and PR number the destination names. The
  # clause embeds the destination as its single quoted literal
  # (`p.destination = 'forgejo:owner/name#7'`).
  local dest repo pr_number
  dest="$(printf '%s' "$dest_clause" | sed -n "s/^[^']*'\([^']*\)'.*/\1/p")"
  repo="${dest#*:}"
  repo="${repo%%#*}"
  pr_number="${dest##*#}"
  case "$repo" in
    */*) ;;   # owner/name: usable for the snapshot scope
    *) repo="" ;;
  esac
  case "$pr_number" in ''|*[!0-9]*) pr_number="" ;; esac
  while true; do
    if [[ -n "$repo" && -n "$pr_number" ]]; then
      bad="$(pg_query "SELECT r.state || '|' || COALESCE(r.failure_reason,'') || '|' || r.run_id FROM cp_runs r WHERE r.state IN ('failed','cancelled','superseded') AND r.job_id IN (
        SELECT p.job_id FROM cp_publications p WHERE $dest_clause
        UNION
        SELECT rec->>'jobId' FROM cp_queue_snapshot, jsonb_array_elements(snapshot->'records') rec
        WHERE (rec->'job'->>'repoFullName') = '$repo' AND (rec->'job'->>'prNumber') = '$pr_number'
      ) ORDER BY r.run_id")"
      while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        if [[ "$line" =~ $expected_terminal ]]; then
          continue
        fi
        echo "$label scenario ended in an unexpected terminal run state: $line" >&2
        tail -n 30 "$log" >&2 || true
        return 1
      done <<<"$bad"
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

# PER-SCENARIO SCOPING (#1483): the usage assertion takes the run id it
# asserts against explicitly — the published run wait_published resolved —
# instead of an implicit global, so a scenario always proves the spend of
# ITS published run and never of a later scenario's.
assert_usage_counted() {
  local run_id="$1" used
  case "$run_id" in
    ''|*[!A-Za-z0-9._-]*)
      echo "unexpected durable run id shape: '$run_id'" >&2
      return 1
      ;;
  esac
  used="$(pg_query "SELECT count(*) FROM cp_usage WHERE run_id = '$run_id'")"
  case "$used" in
    '' | 0)
      echo "durable usage recorded no model spend for run $run_id" >&2
      return 1
      ;;
  esac
}

assert_admin_reports_publication() {
  local port="$1" token="$2" cfg="$3" run_id="$4"
  case "$run_id" in
    ''|*[!A-Za-z0-9._-]*)
      echo "unexpected durable run id shape" >&2
      return 1
      ;;
  esac
  printf 'header = "Authorization: Bearer %s"\n' "$token" > "$cfg"
  curl -fsS -K "$cfg" "http://127.0.0.1:${port}/admin/runs/${run_id}" |
    jq -e '.state == "completed" and .publication.state == "published" and .publication.attempt >= 1' >/dev/null
}

# ── scenario helpers (#1483) ──
# The failure/restart/supersession/idempotency scenarios reuse one
# disposable Forgejo instance and one control-plane database, so every
# helper reads durable state scoped to the values the scenario controls
# (a destination string, a head sha, a PR number) and never a global
# "anything terminal anywhere" predicate.

# Durable-state readers. Each returns rows of `a|b|c` for the caller to
# assert on; an empty string means "no rows yet". Every reader that
# interpolates a destination clause aliases cp_publications as `p`, the
# way the clause itself is written.
published_count_for() {
  pg_query "SELECT count(*) FROM cp_publications p WHERE ($1) AND p.publication_state = 'published'"
}
publication_rows_for() {
  pg_query "SELECT count(*) FROM cp_publications p WHERE ($1)"
}
publication_row_for_head() {
  # $1 destination equality clause, $2 result head sha
  pg_query "SELECT p.publication_state || '|' || p.last_error || '|' || (length(p.result_payload) > 0) FROM cp_publications p WHERE ($1) AND p.result_head_sha = '$2'"
}
runs_for_head() {
  pg_query "SELECT state || '|' || attempt || '|' || run_id || '|' || COALESCE(failure_reason,'') FROM cp_runs WHERE head_sha = '$1' ORDER BY attempt"
}
usage_summary_for_run() {
  # rows|requests|tokens|cost_micros for one run's usage rows
  pg_query "SELECT count(*) || '|' || COALESCE(sum(request_count),0) || '|' || COALESCE(sum(input_tokens + cache_read_tokens + cache_write_tokens + output_tokens),0) || '|' || COALESCE(sum(cost_micros),0) FROM cp_usage WHERE run_id = '$1'"
}
usage_rows_for_destination() {
  # per-run usage summary for every run of the destination's jobs:
  # run_id|rows|tokens|cost_micros
  pg_query "SELECT u.run_id || '|' || count(*) || '|' || COALESCE(sum(u.input_tokens + u.cache_read_tokens + u.cache_write_tokens + u.output_tokens),0) || '|' || COALESCE(sum(u.cost_micros),0) FROM cp_usage u WHERE u.run_id IN (SELECT run_id FROM cp_runs WHERE job_id IN (SELECT p.job_id FROM cp_publications p WHERE ($1))) GROUP BY u.run_id ORDER BY u.run_id"
}
orphan_usage_count() {
  pg_query "SELECT count(*) FROM cp_usage u WHERE NOT EXISTS (SELECT 1 FROM cp_runs r WHERE r.run_id = u.run_id)"
}
queue_records_for_pr() {
  # The durable queue snapshot (cp_queue_snapshot, one jsonb row) holds
  # every JobRecord the controllers committed; the scenario filters the
  # records of its repository and PR number. Output: one
  # jobId|state|supersededByJobId row per record.
  pg_query "SELECT rec->>'jobId' || '|' || (rec->>'state') || '|' || COALESCE(rec->>'supersededByJobId','') FROM cp_queue_snapshot, jsonb_array_elements(snapshot->'records') rec WHERE (rec->'job'->>'repoFullName') = '$1' AND (rec->'job'->>'prNumber') = '$2' ORDER BY 1"
}

wait_run_state() {
  # $1 head sha, $2 expected run state, $3 label — poll the durable run
  # mirror until a run of this head reports the state.
  local sha="$1" want="$2" label="$3" deadline=$((SECONDS + REVIEW_TIMEOUT_SEC)) got
  while true; do
    got="$(pg_query "SELECT state FROM cp_runs WHERE head_sha = '$sha' ORDER BY created_at_ms DESC LIMIT 1")"
    if [[ "$got" == "$want" ]]; then
      return 0
    fi
    if (( SECONDS >= deadline )); then
      echo "$label: no run of head ${sha} reached state '$want' within ${REVIEW_TIMEOUT_SEC}s (last: '${got}')" >&2
      return 1
    fi
    sleep 1
  done
}

wait_queue_record_state() {
  # $1 repo, $2 PR number, $3 expected queue-record state, $4 label,
  # $5 optional deadline in seconds (default 60) — poll the durable
  # queue snapshot until a record of this PR reports the state (the
  # snapshot write is asynchronous behind the accepted webhook response,
  # so the poll proves durability, not intent).
  local repo="$1" pr="$2" want="$3" label="$4" deadline=$((SECONDS + ${5:-60})) got
  while true; do
    got="$(pg_query "SELECT count(*) FROM cp_queue_snapshot, jsonb_array_elements(snapshot->'records') rec WHERE (rec->'job'->>'repoFullName') = '$repo' AND (rec->'job'->>'prNumber') = '$pr' AND (rec->>'state') = '$want'")"
    if [[ "$got" != 0 && -n "$got" ]]; then
      return 0
    fi
    if (( SECONDS >= deadline )); then
      echo "$label: no queue record of ${repo}#${pr} reached state '$want' within 60s" >&2
      return 1
    fi
    sleep 1
  done
}

# Forge side (test setup on the harness's own disposable instance).
branch_head_sha() {
  # $1 repository (owner/name), $2 branch — the branch's commit sha
  fapi_get "/api/v1/repos/$1/branches/$2" | jq -r '.commit.id'
}
push_fixture_commit() {
  # $1 branch, $2 base64 content, $3 message — one content commit on the
  # branch; echoes the new branch head sha.
  local branch="$1" content="$2" message="$3" file_sha new_head
  file_sha="$(fapi_get "/api/v1/repos/reviewer/sample/contents/fixture.txt?ref=$branch" | jq -r '.sha')"
  fapi_json PUT /api/v1/repos/reviewer/sample/contents/fixture.txt \
    "{\"branch\":\"$branch\",\"message\":\"$message\",\"content\":\"$content\",\"sha\":\"$file_sha\"}" >/dev/null
  new_head="$(branch_head_sha reviewer/sample "$branch")"
  case "$new_head" in
    '' | null | *[!A-Fa-f0-9]*)
      echo "content push returned no hexadecimal head sha" >&2
      return 1
      ;;
  esac
  printf '%s' "$new_head"
}
open_scenario_pr() {
  # $1 branch name, $2 title — branch off main, change the fixture so the
  # PR carries a diff, open the PR. Echoes `<number>|<prId>|<head sha>`.
  local branch="$1" title="$2" created head_sha file_sha
  fapi_json POST /api/v1/repos/reviewer/sample/branches \
    "{\"old_branch_name\":\"main\",\"new_branch_name\":\"$branch\"}" >/dev/null
  # The contents API requires the file's current sha on the branch for an
  # update (fixture.txt exists on main, so the branch inherited it).
  file_sha="$(fapi_get "/api/v1/repos/reviewer/sample/contents/fixture.txt?ref=$branch" | jq -r '.sha')"
  fapi_json PUT /api/v1/repos/reviewer/sample/contents/fixture.txt \
    "{\"branch\":\"$branch\",\"message\":\"$branch scenario fixture\",\"content\":\"c2NlbmFyaW8tZml4dHVyZQo=\",\"sha\":\"$file_sha\"}" >/dev/null
  head_sha="$(branch_head_sha reviewer/sample "$branch")"
  created="$(fapi_json POST /api/v1/repos/reviewer/sample/pulls \
    "{\"base\":\"main\",\"head\":\"$branch\",\"title\":\"$title\",\"body\":\"qualification scenario\"}")"
  local number pr_id
  number="$(printf '%s' "$created" | jq -r '.number')"
  pr_id="$(printf '%s' "$created" | jq -r '.id')"
  case "$number" in '' | null | *[!0-9]*)
    echo "scenario PR creation returned no numeric number" >&2
    return 1
    ;;
  esac
  case "$pr_id" in '' | null | *[!0-9]*)
    echo "scenario PR creation returned no numeric id" >&2
    return 1
    ;;
  esac
  printf '%s|%s|%s' "$number" "$pr_id" "$head_sha"
}

# Forgejo webhook delivery (the same signed intake scenario 1 drives).
build_pr_webhook() {
  # $1 action ("opened"|"synchronized"), $2 branch, $3 PR number,
  # $4 PR id, $5 head sha, $6 title, $7 output file. Mirrors the payload
  # shape scenario 1 posts (the reviewer/sample disposable repository).
  jq -n \
    --arg action "$1" \
    --arg repo "reviewer/sample" \
    --argjson number "$3" \
    --argjson prId "$4" \
    --arg sha "$5" \
    --arg baseSha "$BASE_SHA" \
    --arg branch "$2" \
    --arg title "$6" \
    --arg html "$FORGEJO_API_URL/reviewer/sample/pulls/$3" \
    --arg clone "$FORGEJO_API_URL/reviewer/sample.git" \
    '{
      action: $action,
      number: $number,
      title: $title,
      body: "qualification scenario",
      draft: false,
      merged: false,
      merged_at: null,
      head_sha: $sha,
      base_sha: $baseSha,
      head: { label: ("reviewer:" + $branch), ref: $branch, sha: $sha, repo: { full_name: $repo } },
      base: { label: "reviewer:main", ref: "main", sha: $baseSha, repo: { full_name: $repo } },
      pull_request: {
        id: $prId,
        number: $number,
        title: $title,
        body: "qualification scenario",
        draft: false,
        merged: false,
        merged_at: null,
        head: { label: ("reviewer:" + $branch), ref: $branch, sha: $sha, repo: { full_name: $repo } },
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
    }' > "$7"
}
post_webhook() {
  # $1 payload file, $2 expected canonical kind — sign the body with the
  # webhook secret (environment, never argv) and deliver it; asserts the
  # intake's accepted answer.
  local payload="$1" want_kind="$2" signature status response
  response="$TMP/webhook-response-$$.json"
  signature="$(WEBHOOK_SECRET="$WEBHOOK_SECRET" "$NODE_BIN" -e '
const fs = require("fs");
const crypto = require("crypto");
console.log(crypto.createHmac("sha256", process.env.WEBHOOK_SECRET).update(fs.readFileSync(process.argv[1])).digest("hex"));
' "$payload")"
  status="$(curl -sS -o "$response" -w '%{http_code}' \
    -X POST \
    -H "Content-Type: application/json" \
    -H "X-Gitea-Event: pull_request" \
    -H "X-Gitea-Signature: $signature" \
    --data-binary "@$payload" \
    "http://127.0.0.1:${WEBHOOK_PORT}/")"
  if [[ "$status" != 202 ]]; then
    echo "webhook intake refused the signed delivery (HTTP $status)" >&2
    cat "$response" >&2 || true
    return 1
  fi
  jq -e --arg kind "$want_kind" '.status == "accepted" and .kind == $kind' "$response" >/dev/null
}

# Controller lifecycle for the per-scenario daemons.
start_webhook_controller() {
  # $1 label, $2 instance config, $3 admin port, $4 admin token — the
  # webhook-intake env is bound for THIS start only, so a later
  # reconciler-only controller (which binds no webhook) never inherits it.
  local label="$1" config="$2" port="$3" token="$4"
  export PR_REVIEWER_WEBHOOK_PORT="$WEBHOOK_PORT"
  export PR_REVIEWER_WEBHOOK_SECRET="$WEBHOOK_SECRET"
  start_controller "$config" "$TMP/$label.log" "$port" "$token" "$TMP/$label"
  wait_controller_ready "$port" "$label" "$TMP/$label.log" "${CONTROLLER_PIDS[-1]}"
}
stop_controller_gracefully() {
  # $1 pid, $2 label — SIGTERM (the daemon's graceful stop: drain, cancel
  # the remainder, flush) and wait for the exit; SIGKILL only as the
  # last resort so a scenario that needs crash semantics kills explicitly.
  local pid="$1" label="$2" i
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || true
  for i in {1..30}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "$label controller did not exit on SIGTERM; sending SIGKILL" >&2
  kill -KILL "$pid" 2>/dev/null || true
  sleep 1
}
scenario_worker_pids() {
  # The worker processes of ONE controller: the local executor spawns
  # `node <root>/dist/index.js worker <root>/runs/<job>/<attempt>/request.json`,
  # so the run root scopes the match to this controller's children. The
  # disposable mktemp path stays inside the harness's safe charset.
  local root="$1"
  pgrep -f "$root/runs/.*request\.json" 2>/dev/null || true
}

# ── stub model server (#1484) ──
# A harness-owned loopback service, started before the parity scenarios
# and killed by cleanup(). It answers OpenAI-format POSTs whose path
# ends in /chat/completions with a FIXED verdict JSON — streamed as SSE
# `data:` frames (delta.content, a finish_reason frame, a usage frame,
# then `data: [DONE]`, the framing src/transport/sse.ts reassembles)
# when the request carries stream:true, plain JSON otherwise. Request
# bodies are swallowed, never logged, and no credential is read or
# checked: the stub removes model-output nondeterminism, it does not
# model authentication.
start_stub_model() {
  cat > "$TMP/stub-model.mjs" <<'STUBEOF'
import http from "node:http";
const VERDICT = JSON.stringify({
  verdict: "approve",
  review_markdown: "## Engine parity review\n\nStub model verdict for the parity fixture: no findings on the reviewed diff.\n",
  findings: [],
  requirement_coverage: null,
  smart_review_requested: false,
  smart_review_reason: null,
  review_triage_decision: "unknown",
  review_triage_reason: null,
  review_triage_targets: [],
});
const frame = (body) => `data: ${JSON.stringify(body)}\n\n`;
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.setHeader("Content-Type", "text/plain");
    res.end("ok");
    return;
  }
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let stream = false;
    try {
      stream = JSON.parse(Buffer.concat(chunks).toString("utf8")).stream === true;
    } catch {
      stream = false;
    }
    res.setHeader("Content-Type", stream ? "text/event-stream" : "application/json");
    if (stream) {
      res.write(frame({
        id: "parity", object: "chat.completion.chunk", model: "stub-model",
        choices: [{ index: 0, delta: { content: VERDICT }, finish_reason: null }],
      }));
      res.write(frame({
        id: "parity", object: "chat.completion.chunk", model: "stub-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }));
      res.write(frame({
        id: "parity", object: "chat.completion.chunk", model: "stub-model",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.end(JSON.stringify({
      id: "parity", object: "chat.completion", model: "stub-model",
      choices: [{
        index: 0,
        message: { role: "assistant", content: VERDICT },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});
server.listen(Number(process.env.STUB_MODEL_PORT), "127.0.0.1");
STUBEOF
  STUB_MODEL_PORT="$STUB_MODEL_PORT" "$NODE_BIN" "$TMP/stub-model.mjs" \
    >"$TMP/stub-model.log" 2>&1 &
  STUB_MODEL_PID="$!"
  local ready=0
  for _ in {1..30}; do
    if curl -fsS "http://127.0.0.1:${STUB_MODEL_PORT}/healthz" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ "$ready" != 1 ]]; then
    echo "the stub model server did not become ready on 127.0.0.1:${STUB_MODEL_PORT}" >&2
    tail -n 30 "$TMP/stub-model.log" >&2 || true
    return 1
  fi
}

# The policy-stable field set the three parity artifacts normalize to
# (the fields src/enforcement/artifact.ts always writes from the parsed
# verdict). EXCLUDED as approved nondeterminism — everything embedding
# run-specific data: run/job ids and publication identity (comment ids),
# observed-at timestamps and resource timings, usage/token accounting,
# and the run-dir and workspace paths that leak through diagnostics
# surfaces; the artifact's own deterministic enforcement state
# (verdict_source, completeness fields) is excluded too because it is
# compared through the engine build, not per route.
normalize_parity_artifact() {
  jq -S '{
    verdict: .verdict,
    review_markdown: .review_markdown,
    smart_review_requested: .smart_review_requested,
    smart_review_reason: .smart_review_reason,
    review_triage_decision: .review_triage_decision,
    review_triage_reason: .review_triage_reason,
    review_triage_targets: .review_triage_targets,
    findings: .findings,
    requirement_coverage: .requirement_coverage
  }' "$1"
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
assert_usage_counted "$RUN_ID"
assert_admin_reports_publication "$FORGEJO_ADMIN_PORT" "$FORGEJO_ADMIN_TOKEN" "$TMP/admin-forgejo.cfg" "$RUN_ID"
echo "PASS: self-hosted Forgejo normal review qualified end-to-end through the canonical job and engine boundary (repo reviewer/sample, PR ${PR_NUMBER}, head ${HEAD_SHA}, publication ${PUBLICATION_ID})"

# ── scenario 2: normal GitHub review with no per-repository workflow ──
# The reconciler discovers the operator's open test PR through the
# GitHub App forge capability (webhook intake is not reachable from
# outside on a disposable host); everything the pipeline then reads or
# writes of GitHub state goes through that capability.
#
# The review run's worker draws its forge-read material (#1484) from the
# instance config's `credential: github` reference, resolved from the
# environment (`PR_REVIEWER_CREDENTIAL_GITHUB`). An App-based deployment
# whose operator does not provide that material has no env-defined forge
# credential: the worker's publish-purpose resolution fails closed
# (`unknown_reference`) and the review can never publish. Wiring the
# controller's per-job installation-token mint into the worker projection
# is a follow-up (#1484-split). Until then the scenario skips with that
# reason rather than burning its timeout on a guaranteed-fail wait, and
# it runs whenever the operator provides the material.
scenario_github_normal_review() {
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
  assert_usage_counted "$RUN_ID"
  assert_admin_reports_publication "$GITHUB_ADMIN_PORT" "$GITHUB_ADMIN_TOKEN" "$TMP/admin-github.cfg" "$RUN_ID"
  echo "PASS: self-hosted GitHub normal review qualified end-to-end with no per-repository workflow (repo ${SELF_HOSTED_GITHUB_REPOSITORY}, publication ${PUBLICATION_ID})"
}
if [[ -z "${PR_REVIEWER_CREDENTIAL_GITHUB:-}" ]]; then
  echo "SKIP: GitHub normal review is not drivable without the forge credential material (set PR_REVIEWER_CREDENTIAL_GITHUB; an App-only deployment's worker forge reads fail closed until the installation-token projection lands, #1484-split); see docs/self-hosted-qualification.md known limits"
else
  scenario_github_normal_review
fi

# ══ failure/restart/supersession/idempotency scenarios (#1483) ══
#
# Scenario 1's Forgejo webhook controller stays up for the webhook-driven
# supersession and idempotency scenarios; the restart, cancellation, dead
# model, and reconciliation scenarios run their own daemons over the same
# disposable Forgejo instance and control-plane database. Scenario admin
# ports derive from the validated GITHUB_ADMIN_PORT (no new settings
# surface), and every daemon gets its own roots under the harness's temp
# directory so a restart re-derives the exact run layout the crashed
# daemon left behind.
SCENARIO_ADMIN_BASE=$((GITHUB_ADMIN_PORT + 10))
SCENARIO_ADMIN_TOKEN="$("$NODE_BIN" -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
SCENARIO_REPO="reviewer/sample"
# The destinations the retry/restart scenarios produced, for the
# accounting scenario's cross-scenario assertions.
CRASH_DEST=""
RESTART_RUN_DEST=""
RESTART_QUEUED_DEST=""

scenario_duplicate_webhook_produces_exactly_one_review() {
  local label="duplicate webhook"
  local dest="forgejo:${SCENARIO_REPO}#${PR_NUMBER}"
  local dest_clause="p.destination = '${dest}'"
  local runs pubs usage_runs
  # Redeliver the EXACT signed body scenario 1 posted: the identity hash
  # over the same head mints the same generation, so the durable
  # generation claim must answer "duplicate" — no second mint, no second
  # run, no second publication, no second spend.
  post_webhook "$TMP/webhook.json" "pr_opened"
  # A wrongly minted duplicate would dispatch its own run within the
  # settle window (2s) plus one tick; 30s also lets a fast second review
  # surface a second publication. One run, one publication, one spend.
  sleep 30
  runs="$(pg_query "SELECT count(*) FROM cp_runs WHERE head_sha = '$HEAD_SHA'")"
  pubs="$(published_count_for "$dest_clause")"
  usage_runs="$(usage_rows_for_destination "$dest_clause" | /usr/bin/grep -c . || true)"
  if [[ "$runs" != 1 || "$pubs" != 1 ]]; then
    echo "$label scenario produced extra durable work: runs=${runs} published=${pubs}" >&2
    return 1
  fi
  if [[ "$usage_runs" != 1 ]]; then
    echo "$label scenario counted model spend for more than one run: ${usage_runs}" >&2
    return 1
  fi
  assert_usage_counted "$RUN_ID"
  echo "PASS: duplicate webhook produced exactly one review (repo ${SCENARIO_REPO}, PR ${PR_NUMBER}, one run, one publication, one counted spend)"
}

scenario_webhook_burst_settles_to_one_paid_newest_head_review() {
  local label="webhook burst settle"
  local branch="scn-burst"
  local created first_head head
  local pr_number pr_id dest dest_clause
  created="$(open_scenario_pr "$branch" "Webhook burst scenario")"
  IFS='|' read -r pr_number pr_id first_head <<<"$created"
  # first_head is the pull request's own opening head — the burst's
  # synchronizations supersede any review of it, so it is asserted below
  # to hold no run.
  # Push three more heads, then deliver all three synchronizations
  # back-to-back: every delivery lands inside the queue's settle window
  # (2s default), so the burst must coalesce into ONE paid review of the
  # newest head — the superseded queued generations hold no worker and
  # no model budget.
  local commits=() i
  # Distinct content per commit: a content PUT Forgejo would see as an
  # empty diff is refused, and each burst head needs its own sha.
  local burst_contents=("YnVyc3QtaGVhZC0xCg==" "YnVyc3QtaGVhZC0yCg==" "YnVyc3QtaGVhZC0zCg==")
  for i in 1 2 3; do
    head="$(push_fixture_commit "$branch" "${burst_contents[$((i - 1))]}" "burst head ${i}")"
    commits+=("$head")
  done
  local burst_payloads=()
  for i in 1 2 3; do
    build_pr_webhook "synchronized" "$branch" "$pr_number" "$pr_id" "${commits[$((i - 1))]}" \
      "Webhook burst scenario" "$TMP/burst-${i}.json"
    burst_payloads+=("$TMP/burst-${i}.json")
  done
  for i in 1 2 3; do
    post_webhook "${burst_payloads[$((i - 1))]}" "synchronize"
  done
  dest="forgejo:${SCENARIO_REPO}#${pr_number}"
  dest_clause="p.destination = '${dest}'"
  if ! wait_published "$dest_clause" "$label" "$TMP/forgejo-controller.log"; then
    return 1
  fi
  if [[ "$RESULT_HEAD_SHA" != "${commits[2]}" || "$RUN_HEAD_SHA" != "${commits[2]}" ]]; then
    echo "$label scenario published head ${RESULT_HEAD_SHA} instead of the newest burst head ${commits[2]}" >&2
    return 1
  fi
  local pubs runs usage_rows superseded_count completed_count
  pubs="$(published_count_for "$dest_clause")"
  runs="$(pg_query "SELECT count(*) FROM cp_runs WHERE head_sha IN ('$first_head','${commits[0]}','${commits[1]}','${commits[2]}')")"
  usage_rows="$(usage_rows_for_destination "$dest_clause" | /usr/bin/grep -c . || true)"
  superseded_count="$(queue_records_for_pr "$SCENARIO_REPO" "$pr_number" | /usr/bin/grep -c '|superseded|' || true)"
  completed_count="$(queue_records_for_pr "$SCENARIO_REPO" "$pr_number" | /usr/bin/grep -c '|completed|' || true)"
  if [[ "$pubs" != 1 || "$runs" != 1 || "$usage_rows" != 1 ]]; then
    echo "$label scenario did not settle into one paid newest-head review: published=${pubs} runs=${runs} usage-bearing=${usage_rows}" >&2
    return 1
  fi
  if [[ "$superseded_count" != 2 || "$completed_count" != 1 ]]; then
    echo "$label scenario durable queue records disagree with the burst: superseded=${superseded_count} completed=${completed_count}" >&2
    return 1
  fi
  assert_usage_counted "$RUN_ID"
  echo "PASS: webhook burst settled into one paid review of the newest head (repo ${SCENARIO_REPO}, PR ${pr_number}, opening head ${first_head} unpaid, newest head ${commits[2]} paid once)"
}

scenario_new_head_while_old_review_queued_supersedes_without_spend() {
  local label="new head while old review queued"
  local branch="scn-queued"
  local created head_a head_b
  local pr_number pr_id dest dest_clause
  created="$(open_scenario_pr "$branch" "Queued supersession scenario")"
  IFS='|' read -r pr_number pr_id head_a <<<"$created"
  push_fixture_commit "$branch" "cXVldWVkLWhlYWQtYgo=" "queued supersession head b" >/dev/null
  head_b="$(branch_head_sha "$SCENARIO_REPO" "$branch")"
  build_pr_webhook "opened" "$branch" "$pr_number" "$pr_id" "$head_a" \
    "Queued supersession scenario" "$TMP/queued-a.json"
  build_pr_webhook "synchronized" "$branch" "$pr_number" "$pr_id" "$head_b" \
    "Queued supersession scenario" "$TMP/queued-b.json"
  # Both deliveries land inside the settle window: generation A is
  # superseded while queued (it never dispatches, so it never holds a
  # worker or a model budget), generation B reviews the newest head.
  post_webhook "$TMP/queued-a.json" "pr_opened"
  post_webhook "$TMP/queued-b.json" "synchronize"
  dest="forgejo:${SCENARIO_REPO}#${pr_number}"
  dest_clause="p.destination = '${dest}'"
  if ! wait_published "$dest_clause" "$label" "$TMP/forgejo-controller.log"; then
    return 1
  fi
  local pubs runs_a superseded_record completed_job
  pubs="$(published_count_for "$dest_clause")"
  runs_a="$(pg_query "SELECT count(*) FROM cp_runs WHERE head_sha = '$head_a'")"
  superseded_record="$(queue_records_for_pr "$SCENARIO_REPO" "$pr_number" | /usr/bin/grep '|superseded|' | head -1)"
  completed_job="$(queue_records_for_pr "$SCENARIO_REPO" "$pr_number" | /usr/bin/grep '|completed|' | cut -d'|' -f1)"
  if [[ "$pubs" != 1 || "$RESULT_HEAD_SHA" != "$head_b" ]]; then
    echo "$label scenario did not publish exactly the newest head: published=${pubs} head=${RESULT_HEAD_SHA}" >&2
    return 1
  fi
  if [[ "$runs_a" != 0 ]]; then
    echo "$label scenario dispatched the superseded queued generation (${runs_a} runs for the old head)" >&2
    return 1
  fi
  if [[ ! "$superseded_record" =~ \|superseded\| ]]; then
    echo "$label scenario left no superseded queue record for the old head: ${superseded_record:-none}" >&2
    return 1
  fi
  if [[ "${superseded_record##*|}" != "$completed_job" ]]; then
    echo "$label scenario superseded record does not name the superseding jobId: ${superseded_record} vs completed ${completed_job}" >&2
    return 1
  fi
  assert_usage_counted "$RUN_ID"
  echo "PASS: new head while the old review queued superseded the old generation with no spend (repo ${SCENARIO_REPO}, PR ${pr_number}, old head superseded, newest head paid once)"
}

scenario_new_head_while_old_review_running_supersedes_without_spend() {
  local label="new head while old review running"
  local branch="scn-running"
  local created head_a head_b worker_pid
  local pr_number pr_id dest dest_clause
  created="$(open_scenario_pr "$branch" "Running supersession scenario")"
  IFS='|' read -r pr_number pr_id head_a <<<"$created"
  build_pr_webhook "opened" "$branch" "$pr_number" "$pr_id" "$head_a" \
    "Running supersession scenario" "$TMP/running-a.json"
  post_webhook "$TMP/running-a.json" "pr_opened"
  if ! wait_run_state "$head_a" "running" "$label"; then
    return 1
  fi
  # Freeze the old worker mid-review so the supersession's cancellation
  # is deterministic: the review cannot complete inside the race window.
  worker_pid="$(scenario_worker_pids "$TMP/forgejo" | head -1)"
  if [[ -z "$worker_pid" ]]; then
    echo "$label scenario found no worker process to freeze for the running review" >&2
    return 1
  fi
  kill -STOP "$worker_pid"
  push_fixture_commit "$branch" "cnVubmluZy1oZWFkLWIK" "running supersession head b" >/dev/null
  head_b="$(branch_head_sha "$SCENARIO_REPO" "$branch")"
  build_pr_webhook "synchronized" "$branch" "$pr_number" "$pr_id" "$head_b" \
    "Running supersession scenario" "$TMP/running-b.json"
  post_webhook "$TMP/running-b.json" "synchronize"
  dest="forgejo:${SCENARIO_REPO}#${pr_number}"
  dest_clause="p.destination = '${dest}'"
  if ! wait_published "$dest_clause" "$label" "$TMP/forgejo-controller.log" \
    '^superseded\||^cancelled\|'; then
    return 1
  fi
  local pubs state_a usage_a usage_a_rows
  pubs="$(published_count_for "$dest_clause")"
  state_a="$(pg_query "SELECT state || '|' || COALESCE(superseded_by_job_id,'') || '|' || COALESCE(failure_reason,'') FROM cp_runs WHERE head_sha = '$head_a' ORDER BY attempt DESC LIMIT 1")"
  usage_a="$(usage_summary_for_run "$(pg_query "SELECT run_id FROM cp_runs WHERE head_sha = '$head_a' LIMIT 1")")"
  usage_a_rows="${usage_a%%|*}"
  if [[ "$pubs" != 1 || "$RESULT_HEAD_SHA" != "$head_b" ]]; then
    echo "$label scenario did not publish exactly the newest head: published=${pubs} head=${RESULT_HEAD_SHA}" >&2
    return 1
  fi
  case "$state_a" in
    superseded\|* | cancelled\|*) ;;
    *)
      echo "$label scenario left the old run non-terminal or completed: $state_a" >&2
      return 1
      ;;
  esac
  if [[ "$usage_a_rows" != 0 ]]; then
    echo "$label scenario counted model spend for the cancelled old run: ${usage_a}" >&2
    return 1
  fi
  assert_usage_counted "$RUN_ID"
  echo "PASS: new head while the old review running cancelled the old worker by identity with no spend (repo ${SCENARIO_REPO}, PR ${pr_number}, old head terminal, newest head paid once)"
}

scenario_stale_result_publication_is_refused_and_newest_head_publishes() {
  local label="stale result publication"
  local branch="scn-stale"
  local created head_a head_b
  local pr_number pr_id dest dest_clause
  created="$(open_scenario_pr "$branch" "Stale result scenario")"
  IFS='|' read -r pr_number pr_id head_a <<<"$created"
  build_pr_webhook "opened" "$branch" "$pr_number" "$pr_id" "$head_a" \
    "Stale result scenario" "$TMP/stale-a.json"
  # Deliver the review request for head A, then move the branch head on
  # the forge WITHOUT delivering a webhook: no new generation is minted,
  # so generation A still runs to completion — and its publication then
  # faces a forge head that is no longer its result head. The exact-head
  # gate must refuse the stale result terminally.
  post_webhook "$TMP/stale-a.json" "pr_opened"
  # Head B is pushed only once A's review is verifiably dispatched and
  # running: moving the forge head before dispatch would let A's
  # generation be refused before any paid model call, proving a
  # pre-dispatch skip instead of the intended stale-result publication
  # refusal with persisted spend.
  if ! wait_run_state "$head_a" "running" "$label"; then
    return 1
  fi
  push_fixture_commit "$branch" "c3RhbGUtaGVhZC1iCg==" "stale scenario head b" >/dev/null
  head_b="$(branch_head_sha "$SCENARIO_REPO" "$branch")"
  dest="forgejo:${SCENARIO_REPO}#${pr_number}"
  dest_clause="p.destination = '${dest}'"
  # Deliver head B only after A's stale refusal: poll for the durable
  # refusal first (the publication row closes as failed/stale-head), so
  # the ordering is deterministic.
  local stale_row="" deadline=$((SECONDS + REVIEW_TIMEOUT_SEC))
  while true; do
    stale_row="$(publication_row_for_head "$dest_clause" "$head_a")"
    if [[ "$stale_row" == failed\|stale-head\|* ]]; then
      break
    fi
    if (( SECONDS >= deadline )); then
      echo "$label scenario: head A's publication was never refused as stale (row: '${stale_row:-none}')" >&2
      tail -n 30 "$TMP/forgejo-controller.log" >&2 || true
      return 1
    fi
    sleep 2
  done
  build_pr_webhook "synchronized" "$branch" "$pr_number" "$pr_id" "$head_b" \
    "Stale result scenario" "$TMP/stale-b.json"
  post_webhook "$TMP/stale-b.json" "synchronize"
  if ! wait_published "$dest_clause" "$label" "$TMP/forgejo-controller.log" \
    '^failed\|stale-head'; then
    return 1
  fi
  local pubs usage_a usage_a_rows
  pubs="$(published_count_for "$dest_clause")"
  usage_a="$(usage_summary_for_run "$(pg_query "SELECT run_id FROM cp_runs WHERE head_sha = '$head_a' LIMIT 1")")"
  usage_a_rows="${usage_a%%|*}"
  if [[ "$pubs" != 1 || "$RESULT_HEAD_SHA" != "$head_b" ]]; then
    echo "$label scenario did not publish exactly the newest head: published=${pubs} head=${RESULT_HEAD_SHA}" >&2
    return 1
  fi
  if [[ "$usage_a_rows" == 0 ]]; then
    echo "$label scenario: the stale run completed a real model call but no spend was persisted" >&2
    return 1
  fi
  assert_usage_counted "$RUN_ID"
  echo "PASS: stale result publication refused by the exact-head gate and newest head published (repo ${SCENARIO_REPO}, PR ${pr_number}, stale head refused, newest head paid once)"
}

scenario_worker_timeout() {
  # NOT drivable in this composition, and the harness refuses to
  # fabricate coverage (docs/self-hosted-qualification.md): webhook-minted
  # jobs carry no execution deadline (`buildReviewJob` leaves
  # `deadlineAtMs` 0), the controller composition exposes no queue-timing
  # settings (the settle window, lease TTL and retry backoff are daemon
  # defaults — the lease default is 30 minutes), so neither the worker's
  # whole-process deadline backstop nor the queue's lease-expiry path can
  # be driven inside the scenario budget. The queue-level deadline and
  # lease-expiry semantics are qualified at the composition level by
  # tests-v3/controller-daemon.test.ts and
  # tests-v3/queue-recovery-settle.test.ts.
  echo "SKIP: worker timeout scenario is not drivable in this composition (no job deadline is minted and the lease default is 30 minutes); see docs/self-hosted-qualification.md known limits"
}

scenario_worker_crash_requeues_without_duplicate_spend() {
  local label="worker crash requeue"
  local branch="scn-crash"
  local created head_a worker_pid
  local pr_number pr_id dest dest_clause
  created="$(open_scenario_pr "$branch" "Worker crash scenario")"
  IFS='|' read -r pr_number pr_id head_a <<<"$created"
  build_pr_webhook "opened" "$branch" "$pr_number" "$pr_id" "$head_a" \
    "Worker crash scenario" "$TMP/crash.json"
  post_webhook "$TMP/crash.json" "pr_opened"
  if ! wait_run_state "$head_a" "running" "$label"; then
    return 1
  fi
  # Kill the worker mid-review: the executor reports the crashed child,
  # the queue requeues the record (bounded retry backoff), and the
  # second attempt runs the review to publication.
  worker_pid="$(scenario_worker_pids "$TMP/forgejo" | head -1)"
  if [[ -z "$worker_pid" ]]; then
    echo "$label scenario found no worker process to crash" >&2
    return 1
  fi
  kill -KILL "$worker_pid"
  dest="forgejo:${SCENARIO_REPO}#${pr_number}"
  dest_clause="p.destination = '${dest}'"
  # The first attempt's run settles failed (worker_crash) by design.
  if ! wait_published "$dest_clause" "$label" "$TMP/forgejo-controller.log" \
    '^failed\|worker_crash'; then
    return 1
  fi
  local run_rows failed_row usage_first usage_rows
  run_rows="$(runs_for_head "$head_a")"
  if [[ "$(printf '%s\n' "$run_rows" | /usr/bin/grep -c .)" != 2 ]]; then
    echo "$label scenario expected a failed attempt and a retried attempt, got: ${run_rows}" >&2
    return 1
  fi
  failed_row="$(printf '%s\n' "$run_rows" | head -1)"
  case "$failed_row" in
    failed\|1\|*worker_crash*) ;;
    *)
      echo "$label scenario first attempt did not fail as a worker crash: $failed_row" >&2
      return 1
      ;;
  esac
  # The crashed attempt left no result and must carry no spend; the
  # requeued attempt is the only counted run.
  usage_first="$(usage_summary_for_run "$(printf '%s\n' "$failed_row" | cut -d'|' -f3)")"
  if [[ "$usage_first" != 0\|0\|0\|0 ]]; then
    echo "$label scenario counted model spend for the crashed attempt: ${usage_first}" >&2
    return 1
  fi
  usage_rows="$(usage_rows_for_destination "$dest_clause" | /usr/bin/grep -c . || true)"
  if [[ "$usage_rows" != 1 ]]; then
    echo "$label scenario counted spend for more than the retried run: ${usage_rows}" >&2
    return 1
  fi
  assert_usage_counted "$RUN_ID"
  echo "PASS: worker crash requeued the record without duplicate spend (repo ${SCENARIO_REPO}, PR ${pr_number}, attempt 1 failed worker_crash, attempt 2 published once)"
  CRASH_DEST="$dest"
}

scenario_controller_restart_with_running_worker_resumes_without_rerun() {
  local label="controller restart with running worker"
  local branch="scn-restart"
  local created head_a controller_pid
  local pr_number pr_id dest dest_clause
  created="$(open_scenario_pr "$branch" "Controller restart scenario")"
  IFS='|' read -r pr_number pr_id head_a <<<"$created"
  build_pr_webhook "opened" "$branch" "$pr_number" "$pr_id" "$head_a" \
    "Controller restart scenario" "$TMP/restart.json"
  post_webhook "$TMP/restart.json" "pr_opened"
  if ! wait_run_state "$head_a" "running" "$label"; then
    return 1
  fi
  # The Forgejo webhook controller from scenario 1 (the GitHub daemon is
  # also running and must not be touched) — kill the CONTROLLER only:
  # the worker is orphaned and keeps running.
  controller_pid="$FORGEJO_CONTROLLER_PID"
  kill -KILL "$controller_pid"
  sleep 2
  # The restarted daemon reconciles the recovered worker BEFORE recover():
  # the executor reports it alive, the daemon adopts it (never
  # redispatches), and its settled result routes into the publish path.
  start_webhook_controller "forgejo-scenario" "$TMP/instance-forgejo.yaml" \
    "$SCENARIO_ADMIN_BASE" "$SCENARIO_ADMIN_TOKEN"
  FORGEJO_SCENARIO_PID="${CONTROLLER_PIDS[-1]}"
  dest="forgejo:${SCENARIO_REPO}#${pr_number}"
  dest_clause="p.destination = '${dest}'"
  if ! wait_published "$dest_clause" "$label" "$TMP/forgejo-scenario.log"; then
    return 1
  fi
  local run_count usage_rows
  run_count="$(pg_query "SELECT count(*) FROM cp_runs WHERE head_sha = '$head_a'")"
  usage_rows="$(usage_rows_for_destination "$dest_clause" | /usr/bin/grep -c . || true)"
  if [[ "$run_count" != 1 ]]; then
    echo "$label scenario reran the review across the restart: ${run_count} runs for head ${head_a}" >&2
    return 1
  fi
  if [[ "$usage_rows" != 1 ]]; then
    echo "$label scenario counted spend for more than the adopted run: ${usage_rows}" >&2
    return 1
  fi
  assert_usage_counted "$RUN_ID"
  echo "PASS: controller restart with a running worker adopted the orphaned worker and published without a second model call (repo ${SCENARIO_REPO}, PR ${pr_number}, one run, one counted spend)"
  RESTART_RUN_DEST="$dest"
}

scenario_operator_restart_with_queued_settle_window_work() {
  local label="operator restart with queued settle-window work"
  local branch="scn-restart-queued"
  local created head_a controller_pid
  local pr_number pr_id dest dest_clause
  created="$(open_scenario_pr "$branch" "Restart with queued work scenario")"
  IFS='|' read -r pr_number pr_id head_a <<<"$created"
  build_pr_webhook "opened" "$branch" "$pr_number" "$pr_id" "$head_a" \
    "Restart with queued work scenario" "$TMP/restart-queued.json"
  post_webhook "$TMP/restart-queued.json" "pr_opened"
  # The accepted response proves the generation was claimed; wait until
  # the queued record is DURABLE in the control-plane snapshot, then kill
  # the operator inside the settle window (the record cannot have
  # dispatched: the window is 2s and no run exists yet).
  if ! wait_queue_record_state "$SCENARIO_REPO" "$pr_number" "queued" "$label"; then
    return 1
  fi
  controller_pid="$FORGEJO_SCENARIO_PID"
  kill -KILL "$controller_pid"
  local queued_records
  queued_records="$(queue_records_for_pr "$SCENARIO_REPO" "$pr_number")"
  if [[ ! "$queued_records" =~ \|queued\| ]]; then
    echo "$label scenario: the killed operator left no queued record behind: ${queued_records:-none}" >&2
    return 1
  fi
  start_webhook_controller "forgejo-scenario" "$TMP/instance-forgejo.yaml" \
    "$SCENARIO_ADMIN_BASE" "$SCENARIO_ADMIN_TOKEN"
  FORGEJO_SCENARIO_PID="${CONTROLLER_PIDS[-1]}"
  dest="forgejo:${SCENARIO_REPO}#${pr_number}"
  dest_clause="p.destination = '${dest}'"
  if ! wait_published "$dest_clause" "$label" "$TMP/forgejo-scenario.log"; then
    return 1
  fi
  local run_count pubs usage_rows
  run_count="$(pg_query "SELECT count(*) FROM cp_runs WHERE head_sha = '$head_a'")"
  pubs="$(published_count_for "$dest_clause")"
  usage_rows="$(usage_rows_for_destination "$dest_clause" | /usr/bin/grep -c . || true)"
  if [[ "$run_count" != 1 || "$pubs" != 1 || "$usage_rows" != 1 ]]; then
    echo "$label scenario did not resume the queued generation exactly once: runs=${run_count} published=${pubs} usage-bearing=${usage_rows}" >&2
    return 1
  fi
  assert_usage_counted "$RUN_ID"
  echo "PASS: operator restart with queued settle-window work resumed without duplicate work (repo ${SCENARIO_REPO}, PR ${pr_number}, one run, one publication, one counted spend)"
  RESTART_QUEUED_DEST="$dest"
}

scenario_cancellation_cancels_the_review_without_publication() {
  local label="cancelled review"
  local branch="scn-cancel"
  local created head_a controller_pid worker_pid run_id
  local pr_number pr_id dest dest_clause
  created="$(open_scenario_pr "$branch" "Cancellation scenario")"
  IFS='|' read -r pr_number pr_id head_a <<<"$created"
  build_pr_webhook "opened" "$branch" "$pr_number" "$pr_id" "$head_a" \
    "Cancellation scenario" "$TMP/cancel.json"
  post_webhook "$TMP/cancel.json" "pr_opened"
  if ! wait_run_state "$head_a" "running" "$label"; then
    return 1
  fi
  # Freeze the worker so the review cannot complete inside the drain
  # window: the graceful stop must drain, then cancel the remainder by
  # identity, retiring the record with no publication and no spend.
  worker_pid="$(scenario_worker_pids "$TMP/forgejo-scenario" | head -1)"
  if [[ -z "$worker_pid" ]]; then
    echo "$label scenario found no worker process to freeze" >&2
    return 1
  fi
  kill -STOP "$worker_pid"
  controller_pid="$FORGEJO_SCENARIO_PID"
  kill -TERM "$controller_pid"
  local i dead=0
  for i in {1..60}; do
    if ! kill -0 "$controller_pid" 2>/dev/null; then
      dead=1
      break
    fi
    sleep 1
  done
  if [[ "$dead" != 1 ]]; then
    echo "$label scenario: the controller did not exit after SIGTERM within 60s" >&2
    kill -KILL "$controller_pid" 2>/dev/null || true
    return 1
  fi
  run_id="$(pg_query "SELECT run_id FROM cp_runs WHERE head_sha = '$head_a' ORDER BY attempt DESC LIMIT 1")"
  local deadline=$((SECONDS + 60)) state=""
  while true; do
    state="$(pg_query "SELECT state || '|' || COALESCE(failure_reason,'') FROM cp_runs WHERE run_id = '$run_id'")"
    case "$state" in
      cancelled\|*) break ;;
    esac
    if (( SECONDS >= deadline )); then
      echo "$label scenario: the run did not settle cancelled after the graceful stop (last: '${state}')" >&2
      return 1
    fi
    sleep 1
  done
  dest="forgejo:${SCENARIO_REPO}#${pr_number}"
  dest_clause="p.destination = '${dest}'"
  local pubs usage
  pubs="$(publication_rows_for "$dest_clause")"
  usage="$(usage_summary_for_run "$run_id")"
  if [[ "$pubs" != 0 ]]; then
    echo "$label scenario published a cancelled review (${pubs} publication rows)" >&2
    return 1
  fi
  if [[ "$usage" != 0\|0\|0\|0 ]]; then
    echo "$label scenario counted model spend for a cancelled run: ${usage}" >&2
    return 1
  fi
  echo "PASS: cancelled review settled cancelled with no publication and no counted spend (repo ${SCENARIO_REPO}, PR ${pr_number}, run ${run_id})"
}

scenario_publication_retry_without_model_rerun() {
  local label="publication retry without model rerun"
  local branch="scn-publish-retry"
  local created head_a
  local pr_number pr_id dest dest_clause
  # The cancellation scenario terminated the previous daemon; this
  # scenario starts its own (same roots, fresh process) to drive the
  # intake.
  start_webhook_controller "forgejo-scenario" "$TMP/instance-forgejo.yaml" \
    "$SCENARIO_ADMIN_BASE" "$SCENARIO_ADMIN_TOKEN"
  FORGEJO_SCENARIO_PID="${CONTROLLER_PIDS[-1]}"
  created="$(open_scenario_pr "$branch" "Publication retry scenario")"
  IFS='|' read -r pr_number pr_id head_a <<<"$created"
  build_pr_webhook "opened" "$branch" "$pr_number" "$pr_id" "$head_a" \
    "Publication retry scenario" "$TMP/pub-retry.json"
  post_webhook "$TMP/pub-retry.json" "pr_opened"
  if ! wait_run_state "$head_a" "running" "$label"; then
    return 1
  fi
  # The worker needs no forge credential (all forge I/O is
  # controller-side), so stopping the disposable instance mid-review
  # leaves the model call untouched — and makes the publication's
  # freshness read fail (retry-later), which is the durable-record retry
  # path the scenario drives.
  POSTGRES_PASSWORD="$PG_PASSWORD" docker stop "$FORGEJO_NAME" >/dev/null
  dest="forgejo:${SCENARIO_REPO}#${pr_number}"
  local pending_row="" deadline=$((SECONDS + REVIEW_TIMEOUT_SEC))
  while true; do
    pending_row="$(pg_query "SELECT publication_state || '|' || (length(result_payload) > 0) FROM cp_publications WHERE destination = '${dest}'")"
    if [[ "$pending_row" == pending\|true ]]; then
      break
    fi
    if (( SECONDS >= deadline )); then
      echo "$label scenario: the publication never held its durable pending payload (row: '${pending_row:-none}')" >&2
      POSTGRES_PASSWORD="$PG_PASSWORD" docker start "$FORGEJO_NAME" >/dev/null || true
      return 1
    fi
    sleep 2
  done
  local run_id usage_before usage_after
  run_id="$(pg_query "SELECT run_id FROM cp_runs WHERE head_sha = '$head_a' ORDER BY attempt DESC LIMIT 1")"
  usage_before="$(usage_summary_for_run "$run_id")"
  POSTGRES_PASSWORD="$PG_PASSWORD" docker start "$FORGEJO_NAME" >/dev/null
  dest_clause="p.destination = '${dest}'"
  if ! wait_published "$dest_clause" "$label" "$TMP/forgejo-scenario.log"; then
    return 1
  fi
  usage_after="$(usage_summary_for_run "$run_id")"
  local run_count attempts
  run_count="$(pg_query "SELECT count(*) FROM cp_runs WHERE head_sha = '$head_a'")"
  attempts="$(pg_query "SELECT attempt FROM cp_publications WHERE destination = '${dest}'")"
  if [[ "$run_count" != 1 ]]; then
    echo "$label scenario reran the model across the publication retry: ${run_count} runs" >&2
    return 1
  fi
  if [[ "$usage_before" != "$usage_after" ]]; then
    echo "$label scenario changed the durable usage across the retry: before='${usage_before}' after='${usage_after}'" >&2
    return 1
  fi
  if [[ "$usage_before" == 0\|* ]]; then
    echo "$label scenario recorded no spend for the published review" >&2
    return 1
  fi
  case "$attempts" in
    '' | 0 | 1)
      echo "$label scenario recorded no retry attempt on the publication record (attempt=${attempts})" >&2
      return 1
      ;;
  esac
  assert_usage_counted "$RUN_ID"
  echo "PASS: failed publication retried from the durable record with no model rerun (repo ${SCENARIO_REPO}, PR ${pr_number}, publication attempt ${attempts}, usage stable at ${usage_after})"
}

scenario_usage_accounting_single_counted_across_retries_and_restarts() {
  local label="usage accounting across retries and restarts"
  local crash_rows restart_rows queued_rows orphans read_again
  if [[ -z "$CRASH_DEST" || -z "$RESTART_RUN_DEST" || -z "$RESTART_QUEUED_DEST" ]]; then
    echo "$label scenario is missing its prerequisite destinations (crash='${CRASH_DEST}' restart='${RESTART_RUN_DEST}' queued='${RESTART_QUEUED_DEST}')" >&2
    return 1
  fi
  # Across a retry (worker crash -> requeue): exactly ONE run of the
  # crash destination's job carries spend — the retried one.
  crash_rows="$(usage_rows_for_destination "p.destination = '${CRASH_DEST}'")"
  if [[ "$(printf '%s\n' "$crash_rows" | /usr/bin/grep -c .)" != 1 ]]; then
    echo "$label scenario: the retried job carries spend for more than one run: ${crash_rows}" >&2
    return 1
  fi
  # Across restarts (running worker and queued settle-window work):
  # exactly one counted run per destination.
  restart_rows="$(usage_rows_for_destination "p.destination = '${RESTART_RUN_DEST}'")"
  queued_rows="$(usage_rows_for_destination "p.destination = '${RESTART_QUEUED_DEST}'")"
  if [[ "$(printf '%s\n' "$restart_rows" | /usr/bin/grep -c .)" != 1 || "$(printf '%s\n' "$queued_rows" | /usr/bin/grep -c .)" != 1 ]]; then
    echo "$label scenario: a restarted job carries spend for more than one run: restart='${restart_rows}' queued='${queued_rows}'" >&2
    return 1
  fi
  # The durable usage records are replay-idempotent: a re-read after a
  # beat must return identical aggregates (no replay re-inserted rows).
  sleep 2
  read_again="$(usage_rows_for_destination "p.destination = '${CRASH_DEST}'")"
  if [[ "$read_again" != "$crash_rows" ]]; then
    echo "$label scenario: usage aggregates moved between reads: before='${crash_rows}' after='${read_again}'" >&2
    return 1
  fi
  # No usage row may exist without the run record it belongs to.
  orphans="$(orphan_usage_count)"
  if [[ "$orphans" != 0 ]]; then
    echo "$label scenario: ${orphans} usage rows carry no run record" >&2
    return 1
  fi
  echo "PASS: usage and cost accounting stayed single-counted across retries and restarts (crash ${CRASH_DEST}, restart ${RESTART_RUN_DEST}, queued-restart ${RESTART_QUEUED_DEST}, no orphan usage rows)"
}

scenario_model_primary_failure_and_fallback() {
  local label="model primary failure"
  local branch="scn-dead-model"
  local created head_a
  local pr_number pr_id dest dest_clause
  created="$(open_scenario_pr "$branch" "Dead model scenario")"
  IFS='|' read -r pr_number pr_id head_a <<<"$created"
  build_pr_webhook "opened" "$branch" "$pr_number" "$pr_id" "$head_a" \
    "Dead model scenario" "$TMP/dead-model.json"
  # The dead-model daemon (below) serves this PR through an instance
  # config whose only model profile points at a closed loopback port:
  # every model call fails, the bounded attempts exhaust, and the job
  # retires failed — with NO spend counted (usage is never fabricated).
  stop_controller_gracefully "$FORGEJO_SCENARIO_PID" "forgejo-scenario"
  cat > "$TMP/instance-dead-model.yaml" <<CFGEOF
version: 1
forges:
  - name: qualification-forgejo
    kind: forgejo
    endpoint: "$FORGEJO_API_URL"
    credential: forgejo
model-profiles:
  - name: primary
    endpoint: "http://127.0.0.1:9"
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
adoption:
  mode: allowlist
  allowlist: ["$SCENARIO_REPO"]
  discovered-default: adopt
CFGEOF
  start_webhook_controller "forgejo-dead-model" "$TMP/instance-dead-model.yaml" \
    "$((SCENARIO_ADMIN_BASE + 1))" "$SCENARIO_ADMIN_TOKEN"
  post_webhook "$TMP/dead-model.json" "pr_opened"
  if ! wait_queue_record_state "$SCENARIO_REPO" "$pr_number" "failed" "$label" 600; then
    return 1
  fi
  dest="forgejo:${SCENARIO_REPO}#${pr_number}"
  dest_clause="p.destination = '${dest}'"
  local bad_runs usage pubs
  bad_runs="$(pg_query "SELECT count(*) FROM cp_runs WHERE head_sha = '$head_a' AND state != 'failed'")"
  usage="$(usage_rows_for_destination "$dest_clause" | /usr/bin/grep -c . || true)"
  pubs="$(publication_rows_for "$dest_clause")"
  if [[ "$bad_runs" != 0 ]]; then
    echo "$label scenario left non-failed runs behind: ${bad_runs}" >&2
    return 1
  fi
  if [[ "$usage" != 0 ]]; then
    echo "$label scenario counted model spend for failed reviews: ${usage} usage rows" >&2
    return 1
  fi
  if [[ "$pubs" != 0 ]]; then
    echo "$label scenario published a review without a model: ${pubs} publication rows" >&2
    return 1
  fi
  local dead_model_pid="${CONTROLLER_PIDS[-1]}"
  stop_controller_gracefully "$dead_model_pid" "forgejo-dead-model"
  # The FALLBACK leg is not drivable and the harness refuses to fabricate
  # it: the execution envelope carries ONE model selection (baseUrl, wire
  # model id, wire format — #1496), and the worker's engine inputs map no
  # `ai-fallback-*` coordinates, so an availability fallback to a second
  # model cannot be exercised end-to-end here. Labeled per #739's
  # "clearly label externally untestable behavior" rule.
  echo "SKIP: model fallback leg is not drivable in this composition (the execution envelope carries a single model selection); see docs/self-hosted-qualification.md known limits"
  echo "PASS: primary model failure exhausted the bounded attempts with no spend counted and nothing published (repo ${SCENARIO_REPO}, PR ${pr_number})"
}

scenario_missed_webhook_reconciliation_reviews_once() {
  local label="missed webhook via reconciliation"
  local repo="reviewer/reconcile-sample"
  local created head_sha feature_sha
  local pr_number pr_id dest dest_clause
  # A pull request whose webhook was NEVER delivered: the reconciler is
  # the only discoverer. A dedicated repository keeps the poll scoped
  # away from the webhook-reviewed pull requests of the earlier
  # scenarios.
  fapi_json POST /api/v1/user/repos "{\"name\":\"reconcile-sample\",\"auto_init\":true,\"default_branch\":\"main\"}" >/dev/null
  fapi_json POST "/api/v1/repos/$repo/contents/fixture.txt" \
    '{"branch":"main","message":"add fixture","content":"b25lCg=="}' >/dev/null
  fapi_json POST "/api/v1/repos/$repo/branches" \
    '{"old_branch_name":"main","new_branch_name":"feature"}' >/dev/null
  # The contents API update of an EXISTING file requires its current sha
  # on the target branch (same contract push_fixture_commit honours); the
  # feature branch inherited fixture.txt from main.
  feature_sha="$(fapi_get "/api/v1/repos/$repo/contents/fixture.txt?ref=feature" | jq -r '.sha')"
  fapi_json PUT "/api/v1/repos/$repo/contents/fixture.txt" \
    "{\"branch\":\"feature\",\"message\":\"reconcile scenario fixture\",\"content\":\"cmVjb25jaWxlLXNjZW5hcmlvCg==\",\"sha\":\"$feature_sha\"}" >/dev/null
  head_sha="$(branch_head_sha "$repo" "feature")"
  created="$(fapi_json POST "/api/v1/repos/$repo/pulls" \
    '{"base":"main","head":"feature","title":"Reconciliation scenario PR","body":"missed webhook scenario"}')"
  pr_number="$(printf '%s' "$created" | jq -r '.number')"
  pr_id="$(printf '%s' "$created" | jq -r '.id')"
  case "$pr_number" in '' | null | *[!0-9]*)
    echo "reconciliation scenario PR creation returned no numeric number" >&2
    return 1
    ;;
  esac
  cat > "$TMP/instance-reconcile.yaml" <<CFGEOF
version: 1
forges:
  - name: qualification-forgejo
    kind: forgejo
    endpoint: "$FORGEJO_API_URL"
    credential: forgejo
$(write_model_section)
adoption:
  mode: allowlist
  allowlist: ["$repo"]
  discovered-default: adopt
CFGEOF
  # A reconciler-only daemon: no webhook intake is bound (the missed
  # webhook is the premise), the poll discovers the pull request itself.
  unset PR_REVIEWER_WEBHOOK_PORT PR_REVIEWER_WEBHOOK_SECRET
  export PR_REVIEWER_RECONCILE_INTERVAL_MS=1000
  export PR_REVIEWER_RECONCILE_REPOS="$repo"
  start_controller "$TMP/instance-reconcile.yaml" "$TMP/reconcile.log" \
    "$((SCENARIO_ADMIN_BASE + 2))" "$SCENARIO_ADMIN_TOKEN" "$TMP/reconcile"
  wait_controller_ready "$((SCENARIO_ADMIN_BASE + 2))" "reconcile" "$TMP/reconcile.log" "${CONTROLLER_PIDS[-1]}"
  dest="forgejo:${repo}#${pr_number}"
  dest_clause="p.destination = '${dest}'"
  if ! wait_published "$dest_clause" "$label" "$TMP/reconcile.log"; then
    return 1
  fi
  local runs pubs usage_runs
  runs="$(pg_query "SELECT count(*) FROM cp_runs WHERE head_sha = '$head_sha'")"
  pubs="$(published_count_for "$dest_clause")"
  usage_runs="$(usage_rows_for_destination "$dest_clause" | /usr/bin/grep -c . || true)"
  if [[ "$runs" != 1 || "$pubs" != 1 || "$usage_runs" != 1 ]]; then
    echo "$label scenario did not review the missed pull request exactly once: runs=${runs} published=${pubs} usage-bearing=${usage_runs}" >&2
    return 1
  fi
  # Subsequent passes must not duplicate the work: the reconciler keeps
  # polling, and the durable generation claim answers duplicate.
  sleep 4
  runs="$(pg_query "SELECT count(*) FROM cp_runs WHERE head_sha = '$head_sha'")"
  usage_runs="$(usage_rows_for_destination "$dest_clause" | /usr/bin/grep -c . || true)"
  if [[ "$runs" != 1 || "$usage_runs" != 1 ]]; then
    echo "$label scenario duplicated work on a later reconciliation pass: runs=${runs} usage-bearing=${usage_runs}" >&2
    return 1
  fi
  assert_usage_counted "$RUN_ID"
  unset PR_REVIEWER_RECONCILE_INTERVAL_MS PR_REVIEWER_RECONCILE_REPOS
  echo "PASS: missed webhook discovered by reconciliation reviewed exactly once (repo ${repo}, PR ${pr_number}, head ${head_sha}, no duplicate work on later passes)"
}

# ── scenario runner ──
# Scenario 1's Forgejo webhook controller is still serving; the
# webhook-driven scenarios reuse it, and each daemon-owned scenario
# stops it before binding the intake port itself.
echo "RUN: duplicate webhook produces exactly one review"
scenario_duplicate_webhook_produces_exactly_one_review

echo "RUN: webhook burst settles into one paid newest-head review"
scenario_webhook_burst_settles_to_one_paid_newest_head_review

echo "RUN: new head while the old review waits in the queue"
scenario_new_head_while_old_review_queued_supersedes_without_spend

echo "RUN: new head while the old review runs"
scenario_new_head_while_old_review_running_supersedes_without_spend

echo "RUN: stale result attempts publication"
scenario_stale_result_publication_is_refused_and_newest_head_publishes

echo "RUN: worker timeout"
scenario_worker_timeout

echo "RUN: worker crash requeues without a duplicate counted model call"
scenario_worker_crash_requeues_without_duplicate_spend

echo "RUN: controller restart while a worker runs resumes without duplicate work"
scenario_controller_restart_with_running_worker_resumes_without_rerun

echo "RUN: operator restart with queued settle-window work"
scenario_operator_restart_with_queued_settle_window_work

echo "RUN: cancelled review"
scenario_cancellation_cancels_the_review_without_publication

echo "RUN: failed publication followed by a retry with no second model call"
scenario_publication_retry_without_model_rerun

echo "RUN: usage and cost accounting single-counted across retries and restarts"
scenario_usage_accounting_single_counted_across_retries_and_restarts

echo "RUN: primary model failure and fallback"
scenario_model_primary_failure_and_fallback

echo "RUN: missed webhook discovered by reconciliation without duplicate work"
scenario_missed_webhook_reconciliation_reviews_once

# ══ engine parity and eval-qualification scenarios (#1484) ══
#
# One dedicated parity pull request, one head, and the harness-owned
# stub model server: every route reviews the SAME fixture head with the
# SAME engine build (dist/index.js), so the three produced artifacts
# must agree byte-for-byte once normalized to the policy-stable field
# set. The parity controller is its own daemon (own roots, own admin
# port) over the same disposable Forgejo and control-plane database;
# the stub is killed by cleanup().

# ── scenario 17: route A — the self-hosted local executor ──
scenario_engine_parity_route_a_self_hosted_executor() {
  local label="engine parity route A (self-hosted local executor)"
  local created
  local pr_number pr_id head_sha
  created="$(open_scenario_pr "scn-parity" "Engine parity scenario")"
  IFS='|' read -r pr_number pr_id head_sha <<<"$created"
  case "$pr_number" in '' | null | *[!0-9]*)
    echo "$label scenario: PR creation returned no numeric number" >&2
    return 1
    ;;
  esac
  case "$head_sha" in '' | null | *[!A-Fa-f0-9]*)
    echo "$label scenario: PR creation returned no hexadecimal head sha" >&2
    return 1
    ;;
  esac
  # Globals for the later parity routes: all three review THIS head.
  PARITY_PR_NUMBER="$pr_number"
  PARITY_PR_ID="$pr_id"
  PARITY_HEAD_SHA="$head_sha"
  PARITY_DEST="forgejo:${SCENARIO_REPO}#${PARITY_PR_NUMBER}"
  build_pr_webhook "opened" "scn-parity" "$PARITY_PR_NUMBER" "$PARITY_PR_ID" "$PARITY_HEAD_SHA" \
    "Engine parity scenario" "$TMP/parity-webhook.json"
  post_webhook "$TMP/parity-webhook.json" "pr_opened"
  if ! wait_published "p.destination = '${PARITY_DEST}'" "$label" "$TMP/forgejo-parity.log"; then
    return 1
  fi
  case "$PUBLICATION_ID" in
    forgejo-comment:*) ;;
    *)
      echo "$label scenario: publication id did not carry the forge-confirmed comment identity: $PUBLICATION_ID" >&2
      return 1
      ;;
  esac
  if [[ "$RESULT_HEAD_SHA" != "$PARITY_HEAD_SHA" || "$RUN_HEAD_SHA" != "$PARITY_HEAD_SHA" ]]; then
    echo "$label scenario published head ${RESULT_HEAD_SHA} instead of the parity head ${PARITY_HEAD_SHA}" >&2
    return 1
  fi
  # Route A's artifact is the durable published payload itself.
  PARITY_PAYLOAD_A="$(pg_query "SELECT p.result_payload FROM cp_publications p WHERE p.destination = '${PARITY_DEST}' AND p.publication_state = 'published' ORDER BY p.attempt DESC LIMIT 1")"
  if [[ -z "$PARITY_PAYLOAD_A" ]]; then
    echo "$label scenario: the published record carries no result payload" >&2
    return 1
  fi
  printf '%s' "$PARITY_PAYLOAD_A" > "$TMP/parity-payload-a.json"
  normalize_parity_artifact "$TMP/parity-payload-a.json" > "$TMP/parity-artifact-a.json"
  assert_usage_counted "$RUN_ID"
  echo "PASS: engine parity route A reviewed the parity head through the self-hosted controller and local executor (repo ${SCENARIO_REPO}, PR ${PARITY_PR_NUMBER}, head ${PARITY_HEAD_SHA}, publication ${PUBLICATION_ID})"
}

# ── scenario 18: route B — the Action adapter ──
# The shipped JavaScript action entry (`node dist/index.js`, the very
# entry action.yml runs) reviews the parity head the way the runner
# drives it: the contract inputs as INPUT_* environment variables, the
# received pull_request payload as GITHUB_EVENT_PATH, and the ambient
# runner context (PLATFORM, FORGEJO_API_URL/FORGEJO_TOKEN, REPO,
# PR_NUMBER). The engine CLI (`engine --request`) is NOT the Action
# adapter — it skips the input, event and publish boundary — so a route
# driven by it proved the engine, never the adapter.
scenario_engine_parity_route_b_action_adapter() {
  local label="engine parity route B (Action adapter)"
  local work="$TMP/parity-action-work"
  local temp="$TMP/parity-action-temp"
  git clone -q "$FORGEJO_API_URL/reviewer/sample.git" "$work"
  (
    cd "$work"
    git fetch -q origin "pull/${PARITY_PR_NUMBER}/head:pr-${PARITY_PR_NUMBER}"
    git checkout -q "pr-${PARITY_PR_NUMBER}"
  )
  mkdir -p "$temp"
  # The action creates its own run directory under RUNNER_TEMP. The
  # directory is emptied first, so exactly one run directory can be
  # there after the run and the artifact below is unambiguous.
  rm -rf "$temp"/v3-review-run-*
  # The event the runner hands the action is the pull_request payload
  # route A's webhook carried: the same PR, the same head. It is read
  # from the file the harness already wrote, never rebuilt here.
  if [[ ! -f "$TMP/parity-webhook.json" ]]; then
    echo "$label scenario: the parity webhook payload is missing" >&2
    return 1
  fi
  local status
  set +e
  (
    cd "$work"
    # The forge token and the operator's model key ride the environment
    # only: never an argument, never a URL. Every other credential the
    # operator brought is scrubbed — this route talks to the
    # harness-owned stub model server and the disposable Forgejo, nothing
    # else.
    #
    # FORCE_REVIEW is the precheck's force gate: route A already reviewed
    # this head, so the diff-unchanged skip would leave this route with
    # no review and no artifact to compare. The gate overrides only that
    # skip — it is outside the fingerprint config sweep, so the reviewed
    # diff and therefore the artifact are unchanged.
    env -u AI_API_KEY -u AI_BASE_URL -u PR_REVIEWER_CREDENTIAL_MODEL \
      -u PR_REVIEWER_CREDENTIAL_GITHUB -u PR_REVIEWER_CREDENTIAL_FORGEJO \
      -u PR_REVIEWER_GITHUB_APP_ID -u PR_REVIEWER_GITHUB_APP_PRIVATE_KEY \
      -u PR_REVIEWER_GITHUB_APP_INSTALLATION_ID -u GH_TOKEN -u GITHUB_TOKEN \
      "INPUT_AI-BASE-URL=http://127.0.0.1:${STUB_MODEL_PORT}/v1" \
      "INPUT_AI-MODEL=${AI_MODEL}" \
      "GITHUB_EVENT_NAME=pull_request" \
      "GITHUB_EVENT_PATH=${TMP}/parity-webhook.json" \
      "GITHUB_REPOSITORY=reviewer/sample" \
      "GITHUB_WORKSPACE=${work}" \
      "RUNNER_TEMP=${temp}" \
      "GITHUB_OUTPUT=${TMP}/parity-action-output.txt" \
      "GITHUB_STEP_SUMMARY=${TMP}/parity-action-summary.md" \
      "PR_NUMBER=${PARITY_PR_NUMBER}" \
      "PLATFORM=forgejo" \
      "FORGEJO_API_URL=${FORGEJO_API_URL}" \
      "FORGEJO_TOKEN=${FORGEJO_TOKEN}" \
      "COMMENT_MARKER=<!-- ai-pr-reviewer -->" \
      "FORCE_REVIEW=true" \
      "$NODE_BIN" "$ROOT_DIR/dist/index.js"
  ) >"$TMP/parity-action.log" 2>&1
  status=$?
  set -e
  if [[ "$status" != 0 ]]; then
    echo "$label scenario: the action run failed (exit $status); last log lines:" >&2
    tail -n 30 "$TMP/parity-action.log" >&2 || true
    return 1
  fi
  # The Action adapter decides whether a run reviews at all: the
  # diff-unchanged skip (route A already reviewed this head) would
  # leave no artifact, so the route asserts the review happened rather
  # than comparing a missing artifact.
  if [[ ! -f "$TMP/parity-action-output.txt" ]]; then
    echo "$label scenario: the action run wrote no step outputs" >&2
    tail -n 30 "$TMP/parity-action.log" >&2 || true
    return 1
  fi
  if ! grep -q "^should-review=true$" "$TMP/parity-action-output.txt"; then
    echo "$label scenario: the action run did not review (should-review is not true); last log lines:" >&2
    tail -n 30 "$TMP/parity-action.log" >&2 || true
    return 1
  fi
  local run_dir=""
  local candidate
  for candidate in "$temp"/v3-review-run-*; do
    if [[ -d "$candidate" ]]; then
      run_dir="$candidate"
      break
    fi
  done
  if [[ -z "$run_dir" || ! -f "$run_dir/ai-output.json" ]]; then
    echo "$label scenario: the action run left no ai-output.json in its run directory" >&2
    tail -n 30 "$TMP/parity-action.log" >&2 || true
    return 1
  fi
  normalize_parity_artifact "$run_dir/ai-output.json" > "$TMP/parity-artifact-b.json"
  echo "PASS: engine parity route B reviewed the parity head through the Action adapter against the disposable Forgejo (repo ${SCENARIO_REPO}, PR ${PARITY_PR_NUMBER}, head ${PARITY_HEAD_SHA})"
}

# ── scenario 19: route C — the OCI worker image ──
# The built worker image reruns ONE execution from Route A's
# controller-written envelope, rewritten to container-visible paths
# (run dir mounted at /run, workspace at /ws) so
# `validateExecutionRequest` still holds (the envelope paths stay
# lexically inside runDir). The workspace is a fresh clone checked out
# at the parity head; git reaches only the disposable loopback instance
# and carries no credential material (the repo is the harness's own
# disposable one); the model credential rides the environment only.
scenario_engine_parity_route_c_oci_worker_image() {
  local label="engine parity route C (OCI worker image)"
  local req
  # The envelope of the attempt that PUBLISHED (route A's durable run id),
  # not the lexicographically first one: a retried route A job would leave
  # several envelopes and only the published attempt's is the parity run.
  req=""
  for candidate in "$TMP/forgejo-parity/runs"/*/*/request.json; do
    if [[ -f "$candidate" ]] &&
      jq -e --arg runId "$RUN_ID" '.runId == $runId' "$candidate" >/dev/null 2>&1; then
      req="$candidate"
      break
    fi
  done
  if [[ -z "$req" || ! -f "$req" ]]; then
    echo "$label scenario: no execution envelope of the published run ${RUN_ID} found under $TMP/forgejo-parity/runs" >&2
    return 1
  fi
  # The built worker target (deploy/images/Dockerfile): the same
  # dist/index.js bundle the local executor runs, packaged per the #733
  # worker-image contract. Idempotent to rebuild.
  if ! docker build -f "$ROOT_DIR/deploy/images/Dockerfile" \
    --target worker -t pr-reviewer-worker-parity "$ROOT_DIR" \
    >"$TMP/parity-worker-build.log" 2>&1; then
    echo "$label scenario: the worker image build failed; last log lines:" >&2
    tail -n 30 "$TMP/parity-worker-build.log" >&2 || true
    return 1
  fi
  local ws="$TMP/parity-worker-ws" run="$TMP/parity-worker-run"
  git clone -q "$FORGEJO_API_URL/reviewer/sample.git" "$ws"
  (
    cd "$ws"
    git checkout -q "$PARITY_HEAD_SHA"
  )
  mkdir -p "$run"
  jq --arg rd "/run" --arg ws "/ws" '
    .runDir = $rd
    | .requestPath = ($rd + "/" + (.requestPath | split("/") | last))
    | .resultPath = ($rd + "/" + (.resultPath | split("/") | last))
    | .workspace.rootPath = $ws' "$req" > "$run/request.json"
  # The image runs as uid 1000; the mounted run dir must accept its
  # result and artifact writes.
  chmod 0777 "$run"
  local status
  set +e
  # The worker's #735-projected forge-read material (#1484) rides the
  # environment only: the assignment prefix, never argv or a URL.
  #
  # The container argv carries the image's "worker" SUBCOMMAND before the
  # envelope path: the image's ENTRYPOINT is `node /app/dist/index.js`
  # and its CMD is `worker`, so docker REPLACES the CMD with whatever
  # arguments follow the image — an argv of just the envelope path would
  # run `node /app/dist/index.js /run/request.json`, which the bundle
  # refuses as an unknown command.
  PR_REVIEWER_CREDENTIAL_FORGE_PUBLISH="$FORGEJO_TOKEN" \
    docker run --rm --network host \
    -v "$run":/run -v "$ws":/ws \
    -e PR_REVIEWER_CREDENTIAL_MODEL \
    -e PR_REVIEWER_CREDENTIAL_FORGE_PUBLISH \
    -e GIT_CONFIG_COUNT=1 \
    -e GIT_CONFIG_KEY_0=safe.directory \
    -e GIT_CONFIG_VALUE_0='*' \
    pr-reviewer-worker-parity worker /run/request.json >"$TMP/parity-worker.log" 2>&1
  status=$?
  set -e
  if [[ "$status" != 0 ]]; then
    echo "$label scenario: the worker image run failed (exit $status); last log lines:" >&2
    tail -n 30 "$TMP/parity-worker.log" >&2 || true
    return 1
  fi
  if ! jq -e --arg sha "$PARITY_HEAD_SHA" '.status == "completed" and .resultHeadSha == $sha' \
    "$run/result.json" >/dev/null; then
    echo "$label scenario: the worker result did not complete at the parity head" >&2
    cat "$run/result.json" >&2 || true
    return 1
  fi
  if [[ ! -f "$run/ai-output.json" ]]; then
    echo "$label scenario: the worker left no ai-output.json in the mounted run directory" >&2
    return 1
  fi
  normalize_parity_artifact "$run/ai-output.json" > "$TMP/parity-artifact-c.json"
  echo "PASS: engine parity route C reviewed the parity head in the OCI worker image from the rewritten execution envelope (repo ${SCENARIO_REPO}, PR ${PARITY_PR_NUMBER}, head ${PARITY_HEAD_SHA})"
}

# ── scenario 20: route D — the Kubernetes executor ──
# The REAL Kubernetes executor (src/executor/kubernetes.ts) reviews the
# same parity head over the same worker image. The harness has no
# Kubernetes cluster, so the CLUSTER side is a harness-owned double: the
# executor's own API seam and credential-store seam, bound in-process to
# a docker launcher by the driver the harness compiles from
# tests/harness/kubernetes-route.ts. The executor's manifest building,
# envelope write, credential projection, job polling and result
# collection therefore run unmodified — the route drives the shipped
# executor, never a stand-in for it.
#
# The volume mapping names ONE claim, mounted at the SAME absolute path
# on both sides, because the envelope carries the controller's own
# coordinates: every request, result and workspace path of this route
# therefore lives under that one root (the parity root), and the run
# directory and the fresh exact-head clone are its children.
scenario_engine_parity_route_d_kubernetes_executor() {
  local label="engine parity route D (Kubernetes executor)"
  local root="$TMP/parity"
  local run="$root/k8s-runs/$RUN_ID"
  local ws="$root/k8s-workspace"
  local config="$TMP/parity-kubernetes-config.json"
  local req
  # The driver is compiled from the same source tree that produced the
  # engine build, so the executor under test is the shipped executor.
  ensure_test_build "$label" || return 1
  case "$RUN_ID" in
    '' | *[!A-Za-z0-9._:-]*)
      echo "$label scenario: the published run id has an unusable shape for a run directory: '$RUN_ID'" >&2
      return 1
      ;;
  esac
  # The envelope of the attempt that PUBLISHED (route A's durable run id),
  # exactly like route C reads it.
  req=""
  for candidate in "$TMP/forgejo-parity/runs"/*/*/request.json; do
    if [[ -f "$candidate" ]] &&
      jq -e --arg runId "$RUN_ID" '.runId == $runId' "$candidate" >/dev/null 2>&1; then
      req="$candidate"
      break
    fi
  done
  if [[ -z "$req" || ! -f "$req" ]]; then
    echo "$label scenario: no execution envelope of the published run ${RUN_ID} found under $TMP/forgejo-parity/runs" >&2
    return 1
  fi
  mkdir -p "$root" "$run"
  # The workspace is a fresh exact-head clone: the route reviews the same
  # head the other routes reviewed, over its own checkout.
  git clone -q "$FORGEJO_API_URL/reviewer/sample.git" "$ws"
  (
    cd "$ws"
    git checkout -q "$PARITY_HEAD_SHA"
  )
  # The envelope is rewritten to the coordinates the claim's shared path
  # makes visible to both sides (the run directory under the claim root),
  # and gets a fresh deadline: the Kubernetes executor refuses a request
  # without one.
  jq --arg run "$run" --arg ws "$ws" '
    .runDir = $run
    | .requestPath = ($run + "/request.json")
    | .resultPath = ($run + "/result.json")
    | .workspace.rootPath = $ws
    | .deadlineAtMs = (now * 1000 + 600000 | floor)
  ' "$req" > "$run/execution-request.json"
  # The executor's operator spec: the image route C already built, the
  # worker argv prefix the image's entrypoint expects, and the single
  # volume mapping the shared claim is mounted through.
  #
  # The credential material travels in the file only (0600, outside the
  # claim root): the model credential is a placeholder — the stub model
  # server does not authenticate, so the operator's real key must not
  # reach the container — and the forge-read material is the harness's
  # own disposable token. The token is read from the environment by the
  # jq program, never from an argument, and the file is created under a
  # restrictive umask so the material is never briefly world-readable.
  (
    umask 077
    FORGEJO_TOKEN="$FORGEJO_TOKEN" jq -n \
      --arg image "pr-reviewer-worker-parity" \
      --arg namespace "pr-reviewer-qualification" \
      --arg serviceAccount "pr-reviewer-worker" \
      --argjson ttl 600 \
      --arg root "$root" \
      --arg claim "pr-reviewer-parity" \
      --arg modelMaterial "parity-stub-model-key" '
      {
        image: $image,
        args: ["worker"],
        namespace: $namespace,
        serviceAccount: $serviceAccount,
        ttlSecondsAfterFinished: $ttl,
        resources: {
          requests: { cpu: "100m", memory: "256Mi" },
          limits: { cpu: "1", memory: "1Gi" }
        },
        volumes: [{ claim: $claim, controllerRoot: $root }],
        credentialMaterial: {
          model: $modelMaterial,
          "forge-publish": env.FORGEJO_TOKEN
        }
      }' > "$config"
  )
  chmod 0600 "$config"
  # The worker runs as the executor's pinned uid, so the shared paths it
  # writes to must accept it: the run directory takes its result and its
  # artifact, the clone takes the worker's git writes.
  chmod 0777 "$run"
  chmod -R a+rwX "$ws"
  local status
  set +e
  "$NODE_BIN" "$ROOT_DIR/.test-build/tests/harness/kubernetes-route.js" \
    --request "$run/execution-request.json" \
    --config "$config" \
    >"$TMP/parity-kubernetes.json" 2>"$TMP/parity-kubernetes.log"
  status=$?
  set -e
  if [[ "$status" != 0 ]]; then
    echo "$label scenario: the Kubernetes executor route failed (exit $status); last log lines:" >&2
    tail -n 30 "$TMP/parity-kubernetes.log" >&2 || true
    cat "$TMP/parity-kubernetes.json" >&2 || true
    return 1
  fi
  if ! jq -e --arg sha "$PARITY_HEAD_SHA" '.status == "completed" and .resultHeadSha == $sha' \
    "$TMP/parity-kubernetes.json" >/dev/null; then
    echo "$label scenario: the Kubernetes executor did not complete at the parity head" >&2
    cat "$TMP/parity-kubernetes.json" >&2 || true
    return 1
  fi
  local artifact
  artifact="$(jq -r '.artifactPath' "$TMP/parity-kubernetes.json")"
  if [[ -z "$artifact" || ! -s "$artifact" ]]; then
    echo "$label scenario: the Kubernetes executor left no review artifact" >&2
    return 1
  fi
  if [[ ! -r "$artifact" ]]; then
    echo "$label scenario: the review artifact is not readable by the harness user: ${artifact}" >&2
    return 1
  fi
  # The double reports whether it had to stand in for the shared claim's
  # permission model: the controller writes the envelope 0600 as its own
  # uid and the worker writes the result 0600 as the pod's uid, so a
  # claim both sides can read had to be stood in for. The route says so
  # in words, so a run never hides the emulation it relied on.
  local relaxed
  relaxed="$(jq -r '.sharedClaimRelaxed // false' "$TMP/parity-kubernetes.json")"
  normalize_parity_artifact "$artifact" > "$TMP/parity-artifact-d.json"
  if [[ "$relaxed" == "true" ]]; then
    echo "PASS: engine parity route D reviewed the parity head through the Kubernetes executor over the cluster double (repo ${SCENARIO_REPO}, PR ${PARITY_PR_NUMBER}, head ${PARITY_HEAD_SHA}); the executor path only — the double stood in for the shared claim's permission model, which the shipped chart cannot provide today (issue #1631)"
  else
    echo "PASS: engine parity route D reviewed the parity head through the Kubernetes executor over the cluster double (repo ${SCENARIO_REPO}, PR ${PARITY_PR_NUMBER}, head ${PARITY_HEAD_SHA}); the shared claim's own permission model applied"
  fi
}

# The parity routes, by artifact family: every one of them reviews the
# same head, and every one of them must produce a normalized artifact
# the comparison reads. The repository gate
# (tests/test_self_hosted_qualification.py) keeps this list complete: a
# route that stops being compared is a silent narrowing of the
# qualification.
PARITY_ARTIFACT_FAMILIES=(a b c d)

# ── scenario 21: the four artifacts agree byte-for-byte ──
scenario_engine_parity_artifacts_byte_identical() {
  local label="engine parity artifact comparison"
  local family
  for family in "${PARITY_ARTIFACT_FAMILIES[@]}"; do
    if [[ ! -s "$TMP/parity-artifact-$family.json" ]]; then
      echo "$label scenario: normalized artifact $family is missing or empty" >&2
      return 1
    fi
    # The normalized artifact must CARRY the policy-stable fields: a
    # missing field normalizes to null, so four identically empty
    # artifacts would compare equal and report a parity that never
    # happened.
    if ! jq -e '
      (.verdict | type == "string" and length > 0)
      and (.review_markdown | type == "string" and length > 0)
      and (.findings | type == "array")
      and (.smart_review_requested | type == "boolean")
      and (.review_triage_decision | type == "string" and length > 0)
    ' "$TMP/parity-artifact-$family.json" >/dev/null; then
      echo "$label scenario: the normalized artifact $family does not carry the policy-stable fields" >&2
      cat "$TMP/parity-artifact-$family.json" >&2 || true
      return 1
    fi
  done
  for family in "${PARITY_ARTIFACT_FAMILIES[@]:1}"; do
    if ! cmp -s "$TMP/parity-artifact-${PARITY_ARTIFACT_FAMILIES[0]}.json" \
      "$TMP/parity-artifact-$family.json"; then
      echo "$label scenario: the routes produced different policy-stable artifacts" >&2
      diff -u "$TMP/parity-artifact-${PARITY_ARTIFACT_FAMILIES[0]}.json" \
        "$TMP/parity-artifact-$family.json" >&2 || true
      return 1
    fi
  done
  echo "PASS: engine parity held byte-for-byte across the Action adapter and the self-hosted local, worker-image and Kubernetes-executor routes (repo ${SCENARIO_REPO}, PR ${PARITY_PR_NUMBER}, head ${PARITY_HEAD_SHA})"
}

# ── scenario 22: the deterministic eval suites against the engine build ──
scenario_eval_suites_rerun_against_engine_build() {
  local label="eval suites against the engine build"
  if [[ ! -f "$ROOT_DIR/dist/index.js" ]]; then
    echo "$label scenario: dist/index.js is missing" >&2
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: the eval-suite scenario needs python3 on PATH (the dispatched runner provides it); see docs/self-hosted-qualification.md known limits"
    return 0
  fi
  mkdir -p "$TMP/semantic-eval-report"
  if ! (
    cd "$ROOT_DIR"
    python3 scripts/run_semantic_eval_ci.py \
      --corpus evals/corpus-historical-dogfood.json \
      --output "$TMP/semantic-eval-report/report.json"
  ) >"$TMP/semantic-eval.log" 2>&1; then
    echo "$label scenario: the deterministic eval gate failed; last log lines:" >&2
    tail -n 30 "$TMP/semantic-eval.log" >&2 || true
    return 1
  fi
  echo "PASS: the deterministic eval suites re-ran from the tree that produced the self-hosted engine build (report $TMP/semantic-eval-report/report.json)"
}

# ── the v3 qualification suites re-run against the engine build ──
# The suites below are the repository's own v3 qualification suites,
# re-run from the SAME source tree that produced the engine build the
# self-hosted workers run (dist/index.js). The bundle-level suites
# (bundle, gate-workloads) and the eval-corpus replay drive
# dist/index.js itself; the other node suites run against the compiled
# runtime.

# Each name is a compiled test file under .test-build/tests-v3/; the
# source of truth is tests-v3/<name>.test.ts. The repository gate
# (tests/test_self_hosted_qualification.py) fails when a declared suite
# file is renamed or removed, and when a new adversarial-boundary suite
# whose file name carries one of its vocabulary tokens appears that the
# list does not cover, so the list cannot rot silently.
QUALIFICATION_PARITY_SUITES=(
  action-yml
  bundle
  entrypoints
  gate-workloads
  golden-replay
  platform
)

QUALIFICATION_SECURITY_SUITES=(
  credentials-result-channel
  credentials-vault
  credentials-worker-set
  executor-kubernetes-credential-store
  fence
  findings-safe-path
  ingress-github-app-signature
  ingress-signature
  instance-config
  mcp-host
  mcp-jsonrpc
  mcp-tools
  publish-body-bound
  publish-comment-post
  redact
  safe-fetch
  sanitize
  secret-shape
  tools-executors
  worker-main
)

# The shipped eval corpora that carry a retained real-PR fixture
# (#1609). The scenario replays those fixtures offline through the
# built bundle, and every named corpus must contribute: a corpus that
# loses its fixture fails the qualification instead of narrowing it.
EVAL_CORPUS_FILES=(
  evals/corpus-human-findings.json
  evals/corpus-real-prs.json
)

# The compiled v3 test build is produced once per harness run: the
# first caller compiles it and the later ones reuse it (nothing in the
# harness changes the source tree between them).
TEST_BUILD_READY=0

# Compiles the v3 test build and fails loudly when the toolchain is
# missing: a qualification that cannot run its suites must never
# report a pass.
ensure_test_build() {
  local label="$1"
  if [[ "$TEST_BUILD_READY" == 1 ]]; then
    return 0
  fi
  local tsc="$ROOT_DIR/node_modules/typescript/bin/tsc"
  if [[ ! -f "$tsc" ]]; then
    echo "$label scenario: the TypeScript compiler is missing (node_modules/typescript); run 'npm ci' before the harness (docs/self-hosted-qualification.md)" >&2
    return 1
  fi
  if ! (cd "$ROOT_DIR" && "$NODE_BIN" "$tsc" -p tsconfig.test.json) \
    >"$TMP/test-build.log" 2>&1; then
    echo "$label scenario: the v3 test build failed to compile; last log lines:" >&2
    tail -n 30 "$TMP/test-build.log" >&2 || true
    return 1
  fi
  TEST_BUILD_READY=1
}

# Runs a command with the harness's credentials scrubbed out of its
# environment. The qualification suites and the eval replay must never
# reach a live model endpoint or a live forge, and no credential may
# travel into a child process that has no business holding one: the
# suites are offline, and the replay drives the engine against the eval
# harness's own closed loopback port with a dummy key.
run_without_credentials() {
  env -u AI_API_KEY -u AI_BASE_URL -u AI_MODEL \
    -u PR_REVIEWER_CREDENTIAL_MODEL -u PR_REVIEWER_CREDENTIAL_FORGEJO \
    -u PR_REVIEWER_CREDENTIAL_GITHUB -u FORGEJO_TOKEN \
    -u PR_REVIEWER_GITHUB_APP_ID -u PR_REVIEWER_GITHUB_APP_PRIVATE_KEY \
    -u PR_REVIEWER_GITHUB_APP_INSTALLATION_ID \
    "$@"
}

# Runs one declared suite list against the engine build. The first
# failing suite fails the scenario, with its log tail.
run_qualification_suites() {
  local label="$1"
  local log="$2"
  shift 2
  local name compiled
  local files=()
  for name in "$@"; do
    compiled="$ROOT_DIR/.test-build/tests-v3/${name}.test.js"
    if [[ ! -f "$compiled" ]]; then
      echo "$label scenario: the compiled suite ${name}.test.js is missing" >&2
      return 1
    fi
    files+=("$compiled")
  done
  local status
  set +e
  (cd "$ROOT_DIR" && run_without_credentials "$NODE_BIN" --test "${files[@]}") \
    >"$log" 2>&1
  status=$?
  set -e
  if [[ "$status" != 0 ]]; then
    echo "$label scenario: a qualification suite failed; last log lines:" >&2
    tail -n 40 "$log" >&2 || true
    return 1
  fi
}

# ── scenario 23: the v3 parity suites against the engine build ──
scenario_v3_parity_suites_rerun_against_engine_build() {
  local label="v3 parity suites against the engine build"
  if [[ ! -f "$ROOT_DIR/dist/index.js" ]]; then
    echo "$label scenario: dist/index.js is missing" >&2
    return 1
  fi
  ensure_test_build "$label" || return 1
  run_qualification_suites "$label" "$TMP/parity-suites.log" \
    "${QUALIFICATION_PARITY_SUITES[@]}" || return 1
  echo "PASS: the v3 parity suites re-ran from the tree that produced the self-hosted engine build (${#QUALIFICATION_PARITY_SUITES[@]} suites; the bundle suites drive dist/index.js itself; log $TMP/parity-suites.log)"
}

# ── scenario 24: the v3 security suites against the engine build ──
scenario_v3_security_suites_rerun_against_engine_build() {
  local label="v3 security suites against the engine build"
  if [[ ! -f "$ROOT_DIR/dist/index.js" ]]; then
    echo "$label scenario: dist/index.js is missing" >&2
    return 1
  fi
  ensure_test_build "$label" || return 1
  run_qualification_suites "$label" "$TMP/security-suites.log" \
    "${QUALIFICATION_SECURITY_SUITES[@]}" || return 1
  echo "PASS: the v3 security suites re-ran from the tree that produced the self-hosted engine build (${#QUALIFICATION_SECURITY_SUITES[@]} suites; log $TMP/security-suites.log)"
}

# ── scenario 25: the broader eval corpus against the engine build ──
# The shipped eval corpora carry a retained real-PR fixture each
# (#1609): the fixture replays offline through the built bundle, with
# the review context assembled and the model call stopped before it
# happens. An entry WITHOUT a retained fixture needs a live forge
# clone, which this harness never does, so the scenario covers the
# retained-fixture entries and says so.
scenario_eval_corpus_replay_against_engine_build() {
  local label="eval corpus replay against the engine build"
  if [[ ! -f "$ROOT_DIR/dist/index.js" ]]; then
    echo "$label scenario: dist/index.js is missing" >&2
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: the eval-corpus scenario needs python3 on PATH (the dispatched runner provides it); see docs/self-hosted-qualification.md known limits"
    return 0
  fi
  local corpus_dir="$TMP/eval-corpus"
  mkdir -p "$corpus_dir"
  # Build the fixture-only corpus. The retained fixture travels with
  # it: the corpus loader resolves a fixture ref under the corpus
  # file's own directory and verifies its sha256.
  if ! (
    cd "$ROOT_DIR"
    EVAL_CORPUS_DIR="$corpus_dir" \
      EVAL_CORPUS_LIST="$(printf '%s\n' "${EVAL_CORPUS_FILES[@]}")" \
      "$NODE_BIN" -e '
const fs = require("fs");
const path = require("path");
const dir = process.env.EVAL_CORPUS_DIR;
const corpora = (process.env.EVAL_CORPUS_LIST || "").split("\n").filter(Boolean);
let kept = 0;
for (const name of corpora) {
  const data = JSON.parse(fs.readFileSync(name, "utf8"));
  const block = data.real_pr_corpus || {};
  const pinned = (list) => (list || []).filter(
    (entry) => entry && typeof entry === "object" && entry.fixture
  );
  const vulnerable = pinned(block.vulnerable);
  const clean = pinned(block.clean);
  const entries = [...vulnerable, ...clean];
  if (!entries.length) {
    console.error(name + " carries no retained fixture");
    process.exit(1);
  }
  const target = path.join(
    dir, path.basename(name).replace(/\.json$/, "") + "-fixtures.json"
  );
  fs.writeFileSync(target, JSON.stringify({
    real_pr_corpus: { vulnerable, clean },
    metadata: { note: "retained-fixture subset of " + name },
  }, null, 2));
  for (const entry of entries) {
    const reference = entry.fixture.path;
    const root = path.resolve(path.dirname(name));
    const source = path.resolve(root, reference);
    if (source !== root && !source.startsWith(root + path.sep)) {
      console.error(name + " pins a fixture outside its corpus directory: " + reference);
      process.exit(1);
    }
    const destination = path.join(dir, reference);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  kept += entries.length;
}
if (!kept) {
  console.error("no shipped eval corpus carries a retained fixture");
  process.exit(1);
}
'
  ) >"$TMP/eval-corpus-build.log" 2>&1; then
    echo "$label scenario: the retained-fixture corpus could not be built; last log lines:" >&2
    tail -n 30 "$TMP/eval-corpus-build.log" >&2 || true
    return 1
  fi
  local corpus report status replayed=0
  for corpus in "$corpus_dir"/*-fixtures.json; do
    report="${corpus%.json}-report.json"
    set +e
    (
      cd "$ROOT_DIR"
      # The operator's credentials never reach the replay: the
      # environment is scrubbed, and the eval harness drives the engine
      # against its own closed loopback port with a dummy key.
      run_without_credentials python3 scripts/eval_harness.py \
        --corpus "$corpus" --context-only --output "$report"
    ) >"${corpus%.json}.log" 2>&1
    status=$?
    set -e
    if [[ "$status" != 0 ]]; then
      echo "$label scenario: the eval corpus replay failed for $corpus; last log lines:" >&2
      tail -n 30 "${corpus%.json}.log" >&2 || true
      return 1
    fi
    # The replay must have assembled the review context from the
    # retained fixture, with the defect file still in the diff.
    if ! (
      cd "$ROOT_DIR"
      EVAL_REPORT="$report" "$NODE_BIN" -e '
const fs = require("fs");
const report = JSON.parse(fs.readFileSync(process.env.EVAL_REPORT, "utf8"));
const rows = report.per_scenario || [];
if (!rows.length) {
  console.error("the replay report carries no scenario row");
  process.exit(1);
}
for (const row of rows) {
  if (row.fixture !== true || row.context_built !== true) {
    console.error(
      "the retained fixture did not reach the review context: " + JSON.stringify(row)
    );
    process.exit(1);
  }
  if (row.kind === "vulnerable" && row.defect_file_in_diff !== true) {
    console.error("the retained fixture lost its defect file: " + JSON.stringify(row));
    process.exit(1);
  }
}
'
    ) >"${corpus%.json}-check.log" 2>&1; then
      echo "$label scenario: the eval corpus replay did not assemble the review context; last log lines:" >&2
      tail -n 30 "${corpus%.json}-check.log" >&2 || true
      return 1
    fi
    replayed=$((replayed + 1))
  done
  if [[ "$replayed" != "${#EVAL_CORPUS_FILES[@]}" ]]; then
    echo "$label scenario: ${#EVAL_CORPUS_FILES[@]} corpora were declared, but $replayed replayed" >&2
    return 1
  fi
  echo "PASS: the broader eval corpus re-ran against the self-hosted engine build (${replayed} retained-fixture corpora replayed offline through the built bundle)"
}
# ── engine parity runner (#1484) ──
# The stub's loopback port must not collide with any other loopback
# service this harness binds: all derive from the validated numeric
# settings above, so the collision check is a fail-fast, not a guess.
for used_port in "$FORGEJO_PORT" "$POSTGRES_PORT" "$WEBHOOK_PORT" \
  "$FORGEJO_ADMIN_PORT" "$GITHUB_ADMIN_PORT" \
  "$SCENARIO_ADMIN_BASE" "$((SCENARIO_ADMIN_BASE + 1))" \
  "$((SCENARIO_ADMIN_BASE + 2))" "$((SCENARIO_ADMIN_BASE + 3))"; do
  if [[ "$STUB_MODEL_PORT" == "$used_port" ]]; then
    echo "SELF_HOSTED_STUB_MODEL_PORT (${STUB_MODEL_PORT}) collides with another loopback service port this harness binds" >&2
    exit 1
  fi
done
start_stub_model
start_webhook_controller "forgejo-parity" "$TMP/instance-parity.yaml" \
  "$((SCENARIO_ADMIN_BASE + 3))" "$SCENARIO_ADMIN_TOKEN"

echo "RUN: engine parity route A — the self-hosted local executor reviews the parity pull request"
scenario_engine_parity_route_a_self_hosted_executor

echo "RUN: engine parity route B — the Action adapter reviews the same parity head"
scenario_engine_parity_route_b_action_adapter

echo "RUN: engine parity route C — the OCI worker image reviews the same parity head"
scenario_engine_parity_route_c_oci_worker_image

echo "RUN: engine parity route D — the Kubernetes executor"
scenario_engine_parity_route_d_kubernetes_executor

echo "RUN: engine parity — the four produced artifacts agree byte-for-byte"
scenario_engine_parity_artifacts_byte_identical

echo "RUN: the deterministic eval suites re-run from the tree that produced the engine build"
scenario_eval_suites_rerun_against_engine_build

echo "RUN: the v3 parity suites re-run against the same engine build"
scenario_v3_parity_suites_rerun_against_engine_build

echo "RUN: the v3 security suites re-run against the same engine build"
scenario_v3_security_suites_rerun_against_engine_build

echo "RUN: the broader eval corpus re-runs against the same engine build"
scenario_eval_corpus_replay_against_engine_build

exit 0
