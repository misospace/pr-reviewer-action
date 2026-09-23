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
