#!/usr/bin/env bash
set -euo pipefail

# Negative-path tests for the validation gates of tests/forgejo_e2e_smoke.sh.
# The gates run before any Docker call, so bad values fail fast without
# starting the disposable stack; nothing here requires Docker.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT_DIR/tests/forgejo_e2e_smoke.sh"

expect_skip() {
  local output status=0
  output="$(env -u FORGEJO_E2E bash "$SCRIPT" 2>&1)" || status=$?
  [[ "$status" -eq 0 ]]
  grep -q 'SKIP: set FORGEJO_E2E=true' <<<"$output"
}

expect_refused() {
  local label="$1" expect_message="$2"
  shift 2
  local output status=0
  output="$(env FORGEJO_E2E=true "$@" bash "$SCRIPT" 2>&1)" || status=$?
  [[ "$status" -eq 1 ]] || {
    echo "$label: expected exit 1, got $status" >&2
    return 1
  }
  grep -q "$expect_message" <<<"$output" || {
    echo "$label: expected message '$expect_message', got: $output" >&2
    return 1
  }
}

expect_skip

# HOST_ALIAS interpolates into ROOT_URL and the runner registration URL; it
# must stay within [A-Za-z0-9._-]+.
expect_refused 'empty alias' 'must match' FORGEJO_E2E_HOST_ALIAS=
expect_refused 'space in alias' 'must match' FORGEJO_E2E_HOST_ALIAS='bad alias'
expect_refused 'shell metachar in alias' 'must match' FORGEJO_E2E_HOST_ALIAS='host;rm'
expect_refused 'slash in alias' 'must match' FORGEJO_E2E_HOST_ALIAS=a/b

# Every value interpolated into URLs or the runner command goes through
# safe_value; characters outside [A-Za-z0-9._:/@-] are refused. The port is
# additionally restricted to digits before Docker consumes it.
expect_refused 'non-numeric port' 'must be numeric' FORGEJO_E2E_PORT=31o80
expect_refused 'image with shell metachar' 'refusing unsafe' FORGEJO_E2E_JOB_IMAGE='node:22;rm -rf /'
expect_refused 'image with newline' 'refusing unsafe' FORGEJO_E2E_JOB_IMAGE=$'node:22\nx'
expect_refused 'empty runner image' 'refusing unsafe' FORGEJO_E2E_RUNNER_IMAGE=
expect_refused 'empty forgejo image' 'refusing unsafe' FORGEJO_E2E_IMAGE=

# Values just inside the accepted classes are refused only later (by Docker),
# so they cannot be asserted here without Docker; the classes themselves are
# pinned by the refusals above.

echo "PASS: forgejo_e2e_smoke validation gates refuse unsafe values before Docker"

# ---------------------------------------------------------------------------
# Negative-path tests for tests/self_hosted_e2e_qualification.sh (#1482).
# Same pattern: the gates run before any Docker or network call, so every
# case here exits at a gate. No case carries fully valid inputs (that would
# start the disposable stack), so the suite never provisions containers.

QUAL_SCRIPT="$ROOT_DIR/tests/self_hosted_e2e_qualification.sh"

# Valid baseline so each case exercises exactly one injected defect. The
# private-key value is a fixed non-secret placeholder: the gate only
# requires presence, and no case reaches a network call.
QUAL_BASELINE=(
  "SELF_HOSTED_QUALIFICATION=true"
  "AI_BASE_URL=https://model.example.test/v1"
  "AI_MODEL=test/model:1"
  "AI_API_KEY=presence-only"
  "PR_REVIEWER_GITHUB_APP_ID=123456"
  "PR_REVIEWER_GITHUB_APP_PRIVATE_KEY=-----BEGIN FAKE KEY-----"
  "PR_REVIEWER_GITHUB_APP_INSTALLATION_ID=777"
  "SELF_HOSTED_GITHUB_REPOSITORY=acme/qualification"
)

qual_expect_skip() {
  local output status=0
  output="$(env -u SELF_HOSTED_QUALIFICATION bash "$QUAL_SCRIPT" 2>&1)" || status=$?
  [[ "$status" -eq 0 ]] || {
    echo "opt-in gate: expected exit 0, got $status" >&2
    return 1
  }
  grep -q 'SKIP: set SELF_HOSTED_QUALIFICATION=true' <<<"$output"
}

qual_expect_refused() {
  local label="$1" expect_message="$2"
  shift 2
  local output status=0
  output="$(env "${QUAL_BASELINE[@]}" "$@" bash "$QUAL_SCRIPT" 2>&1)" || status=$?
  [[ "$status" -eq 1 ]] || {
    echo "$label: expected exit 1, got $status" >&2
    return 1
  }
  grep -q "$expect_message" <<<"$output" || {
    echo "$label: expected message '$expect_message', got: $output" >&2
    return 1
  }
}

qual_expect_skip

# Every required setting and credential is demanded by name, fail closed.
# env parses options before the first assignment, so -u leads.
qual_expect_missing() {
  local name="$1"
  local args=() entry
  # Drop the assignment itself: env applies assignments after -u, so an
  # unset plus a re-assignment would still provide the setting.
  for entry in "${QUAL_BASELINE[@]}"; do
    [[ "$entry" == "$name="* ]] || args+=("$entry")
  done
  local output status=0
  output="$(env "${args[@]}" bash "$QUAL_SCRIPT" 2>&1)" || status=$?
  [[ "$status" -eq 1 ]] || {
    echo "missing $name: expected exit 1, got $status" >&2
    return 1
  }
  grep -q "$name is required" <<<"$output" || {
    echo "missing $name: expected the refusal to name the setting, got: $output" >&2
    return 1
  }
}

for required_name in AI_BASE_URL AI_MODEL AI_API_KEY PR_REVIEWER_GITHUB_APP_ID \
  PR_REVIEWER_GITHUB_APP_PRIVATE_KEY PR_REVIEWER_GITHUB_APP_INSTALLATION_ID \
  SELF_HOSTED_GITHUB_REPOSITORY; do
  qual_expect_missing "$required_name"
done

# Endpoints are absolute http(s) URLs with no embedded credentials.
qual_expect_refused 'non-http endpoint' 'must be an absolute http(s) URL' AI_BASE_URL=ftp://model.example.test/v1
qual_expect_refused 'endpoint with credentials' 'must not embed credentials' AI_BASE_URL=https://user:pass@model.example.test/v1
qual_expect_refused 'github api with credentials' 'must not embed credentials' GITHUB_API_URL=https://user:pass@api.github.internal

# Positive decimal ids, same shape as the controller's guards.
qual_expect_refused 'app id with letters' 'positive decimal id' PR_REVIEWER_GITHUB_APP_ID=12a34
qual_expect_refused 'app id zero' 'positive decimal id' PR_REVIEWER_GITHUB_APP_ID=0
qual_expect_refused 'installation id leading zero' 'positive decimal id' PR_REVIEWER_GITHUB_APP_INSTALLATION_ID=007
qual_expect_refused 'installation id letters' 'positive decimal id' PR_REVIEWER_GITHUB_APP_INSTALLATION_ID=abc

# Repository identities are 'owner/name'.
qual_expect_refused 'repo without owner' "'owner/name' repository identity" SELF_HOSTED_GITHUB_REPOSITORY=qualification
qual_expect_refused 'repo with extra path' "'owner/name' repository identity" SELF_HOSTED_GITHUB_REPOSITORY=acme/qualification/extra
qual_expect_refused 'repo with empty owner' "'owner/name' repository identity" SELF_HOSTED_GITHUB_REPOSITORY=/qualification
qual_expect_refused 'repo with empty name' "'owner/name' repository identity" SELF_HOSTED_GITHUB_REPOSITORY=acme/

# Values interpolated into config files and URLs stay inside the
# [A-Za-z0-9._:/@-] class; ports are digits; the timeout is a positive
# number of seconds.
qual_expect_refused 'model with space' 'refusing unsafe AI_MODEL' AI_MODEL='test model'
qual_expect_refused 'image with shell metachar' 'refusing unsafe' SELF_HOSTED_FORGEJO_IMAGE='forgejo:9;rm -rf /'
qual_expect_refused 'postgres image with newline' 'refusing unsafe' SELF_HOSTED_POSTGRES_IMAGE=$'postgres:16\nx'
qual_expect_refused 'non-numeric webhook port' 'must be numeric' SELF_HOSTED_FORGEJO_WEBHOOK_PORT=318l0
qual_expect_refused 'non-numeric postgres port' 'must be numeric' SELF_HOSTED_POSTGRES_PORT=543a
qual_expect_refused 'zero review timeout' 'positive number of seconds' SELF_HOSTED_REVIEW_TIMEOUT_SEC=0

echo "PASS: self_hosted_e2e_qualification validation gates refuse bad inputs before Docker"
