#!/usr/bin/env bash
# #1741 review: the image-publish workflow gates each target's build-push step
# on that target's `sha-<commit>` tag being ABSENT, so a rerun never re-pushes
# (never moves) an immutable ref. But that gate also skipped the target's
# MOVING refs — `pr-<number>`, the SemVer release alias, and the major.minor
# alias — so a run that died after the sha push but before the aliases could
# never republish them on a rerun.
#
# Moving refs may legally be retagged, so this step repoints them for every
# REUSED target with `docker buildx imagetools create`: each alias is set to
# the exact manifest the immutable sha tag already holds. There is NO rebuild,
# so a moving ref can never drift off the immutable digest the run summary
# published. Freshly pushed targets already carry their aliases from the
# gated build step and are skipped here.
#
# Inputs (env): GHCR_OWNER, SOURCE_SHA, CONTROLLER_STATE, WORKER_STATE from
# the sha-tag resolver, plus the event's moving-ref coordinates PR_REF,
# RELEASE_VERSION, RELEASE_MAJOR_MINOR (each empty when the event defines
# none). A reused target with no moving refs for the event is a no-op —
# imagetools create is never run just to retag the sha ref onto itself.
#
# Like resolve-sha-tag-state.sh, this talks to the container registry through
# the already-authenticated Docker CLI, never through the forge capability.
set -euo pipefail

republish_target() {
  local name="$1" state="$2"
  # Fail closed on a state outside the resolver's vocabulary: an unknown
  # value is uncertain publication state, never a silent skip.
  case "$state" in
    present) : ;;
    absent) return 0 ;;
    *)
      echo "::error::${name}: unknown sha-tag state '${state}'; refusing to republish moving refs." >&2
      exit 1
      ;;
  esac
  local repo="ghcr.io/${GHCR_OWNER}/pr-reviewer-${name}"
  local args=()
  [ -n "$PR_REF" ] && args+=( -t "${repo}:${PR_REF}" )
  [ -n "$RELEASE_VERSION" ] && args+=( -t "${repo}:${RELEASE_VERSION}" )
  [ -n "$RELEASE_MAJOR_MINOR" ] && args+=( -t "${repo}:${RELEASE_MAJOR_MINOR}" )
  if [ "${#args[@]}" -eq 0 ]; then
    echo "${name}: no moving refs for this event - nothing to republish"
    return 0
  fi
  docker buildx imagetools create "${args[@]}" "${repo}:sha-${SOURCE_SHA}"
  echo "${name}: repointed $(( ${#args[@]} / 2 )) moving ref(s) at ${repo}:sha-${SOURCE_SHA}"
}

: "${GHCR_OWNER:?GHCR_OWNER is required}"
: "${SOURCE_SHA:?SOURCE_SHA is required}"
: "${CONTROLLER_STATE:?CONTROLLER_STATE is required}"
: "${WORKER_STATE:?WORKER_STATE is required}"
PR_REF="${PR_REF:-}"
RELEASE_VERSION="${RELEASE_VERSION:-}"
RELEASE_MAJOR_MINOR="${RELEASE_MAJOR_MINOR:-}"

republish_target controller "$CONTROLLER_STATE"
republish_target worker "$WORKER_STATE"
