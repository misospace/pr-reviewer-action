#!/usr/bin/env bash
# Loader for the action-local shared environment (#641).
#
# The "Export shared review environment" step serializes the input/github
# bindings that the precheck and the review step share into a NUL-separated
# key/value file under $RUNNER_TEMP (mktemp, umask 077) and passes only the
# file path between composite steps via a step output. Consumers source this
# file and call load_shared_env with the path. Nothing ever touches
# $GITHUB_ENV: the caller's job environment is never read, mutated, or
# extended, and no shared value outlives the composite action.
#
# Sourced, never executed. Values load byte-for-byte: NUL is the only
# delimiter and an environment value cannot contain NUL, so any content
# (newlines, quotes, '=', empty, shell metacharacters) round-trips exactly.
# Loaded vars are exported unconditionally, matching step-env precedence over
# inherited job env — a caller-set REPO/GH_TOKEN is overridden inside the
# consuming step exactly as the pre-#641 step-level env block did, and is
# untouched again as soon as the step's process exits.
#
# The file carries tokens (GH_TOKEN, FORGEJO_TOKEN, TOOL_MCP_TOKEN, ...):
# mktemp creates it 0600 under $RUNNER_TEMP, which the runner cleans up after
# the job. Nothing here prints values or echoes the file contents.

load_shared_env() {
  local file="${1:-}"
  if [ -z "$file" ] || [ ! -f "$file" ]; then
    echo "::error::Shared environment file not found (expected path: '${file:-<unset>}')." >&2
    return 1
  fi
  local key val
  while IFS= read -r -d '' key && IFS= read -r -d '' val; do
    export "$key=$val"
  done < "$file"
}
