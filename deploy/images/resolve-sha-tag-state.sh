#!/usr/bin/env bash
# #1741: resolve the per-target state of the immutable sha-<commit> tags so a
# rerun of the image-publish workflow can RESUME a partially published
# controller/worker pair instead of refusing whenever either tag already exists.
#
# GHCR has no registry-side tag immutability (a push always overwrites), so the
# workflow must never re-push a tag that already exists. The original guard
# refused the whole run when EITHER sha tag was present, so a run that pushed
# the controller image and then failed on the worker build/push could never
# finish the pair for that commit: the rerun saw the controller tag and exited,
# and cutting a new commit only published a NEW commit's pair while the
# original release kept a controller ref with no matching worker artifact.
#
# This script classifies each target INDEPENDENTLY and writes to GITHUB_OUTPUT:
#
#   controller_state / worker_state     present | absent
#   controller_digest / worker_digest   the exact sha256 digest of a present tag
#
# Rules, per target:
#   - present   : `docker manifest inspect` succeeds -> the workflow must REUSE
#                 the tag (never re-push, never move it) and report the captured
#                 digest.
#   - absent    : the registry explicitly answers absent (404 MANIFEST_UNKNOWN /
#                 NAME_UNKNOWN / not-found) -> the workflow builds and pushes it.
#   - ambiguous : any other registry answer (auth, TLS "unknown authority",
#                 network, an OCI UNKNOWN code), or a present tag whose digest
#                 cannot be read, fails the run CLOSED: never push over
#                 uncertain state, never reuse an unverifiable digest.
#
# The digest of a present tag is read with `docker buildx imagetools inspect`,
# whose first `Digest:` line is exactly the reference `docker pull` / Kubernetes
# resolves for the tag, matching the digest format build-push-action reports for
# a freshly pushed image.
#
# The container registry (GHCR) is NOT the forge: this read goes through the
# Docker CLI against the already-authenticated registry, exactly as the publish
# push does. It never goes through the forge capability (scripts/forge_cli.py),
# which speaks only the forge platform API and cannot address a registry tag.
set -euo pipefail

# Only these registry answers prove a tag is absent; anything else is uncertain.
# The `.` in `manifest.unknown` / `name.unknown` is an intentional regex
# wildcard: the registry's 404 body spells them with a space or a dot
# ("manifest unknown" / "MANIFEST_UNKNOWN"), and both must classify as absent.
ABSENT_CLASSIFIER='manifest.unknown|name.unknown|not found'

resolve_target() {
  local name="$1" tag="$2"
  local out digest

  if out=$(docker manifest inspect "$tag" 2>&1); then
    # Present: capture the exact digest a pull resolves to, so the rerun can
    # report it without re-pushing (and without moving) the tag. A present tag
    # whose digest cannot be read is uncertain state and fails closed.
    digest=$(docker buildx imagetools inspect "$tag" 2>&1 \
      | grep -m1 -oE 'sha256:[0-9a-f]{64}' || true)
    if [ -z "$digest" ]; then
      echo "::error::${tag} exists but its digest could not be read; refusing to reuse an unverifiable reference." >&2
      printf '%s\n' "$out" >&2
      exit 1
    fi
    printf '%s_state=present\n' "$name" >> "$GITHUB_OUTPUT"
    printf '%s_digest=%s\n' "$name" "$digest" >> "$GITHUB_OUTPUT"
    echo "${name}: present at ${digest} (${tag}) - reuse, never re-push"
    return
  fi

  # Inspect failed: only an explicit registry absence proves the tag is absent.
  # Anything else -- auth, TLS ("unknown authority"), network, an OCI UNKNOWN
  # error code -- refuses the run. (An access denial also means this same token
  # could not overwrite the tag later, so refusing can never mask an overwrite;
  # at worst it fails one run loudly.)
  if ! printf '%s\n' "$out" | grep -Eqi "$ABSENT_CLASSIFIER"; then
    echo "registry answer for ${tag}:" >&2
    printf '%s\n' "$out" >&2
    echo "::error::cannot confirm that ${tag} is absent; refusing to push over uncertain registry state."
    exit 1
  fi
  printf '%s_state=absent\n' "$name" >> "$GITHUB_OUTPUT"
  echo "${name}: absent (${tag}) - will build and push"
}

: "${CONTROLLER_TAG:?CONTROLLER_TAG is required}"
: "${WORKER_TAG:?WORKER_TAG is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

resolve_target controller "$CONTROLLER_TAG"
resolve_target worker "$WORKER_TAG"
