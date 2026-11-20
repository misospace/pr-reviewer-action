#!/usr/bin/env bash
# #1741 review: the image-publish workflow gates each target's build-push step
# on that target's `sha-<commit>` tag being ABSENT, so a rerun never re-pushes
# (never moves) an immutable ref. But that gate also skipped the target's
# MOVING refs — `pr-<number>` and the exact SemVer release alias (#1742: no
# floating alias of any shape) — so a run that died after the sha push but
# before the aliases could never republish them on a rerun.
#
# This script is the ONLY writer of moving refs in the workflow (r3 review):
# the build steps push nothing but the immutable sha ref, because they carry
# no supersession check and an ungated alias push there could move a moving
# ref before any guard ran. Moving refs are written here for EVERY target,
# reused or freshly built, with `docker buildx imagetools create`: each alias
# is set to the exact manifest the immutable sha tag holds. There is NO
# rebuild, so a moving ref can never drift off the immutable digest the run
# summary published.
#
# Supersession guard (r2 review): a rerun of an OLD workflow run must not
# repoint `pr-<number>` BACKWARD at the older commit's sha manifest — the
# pre-#1741 run simply refused in that situation, and a moving ref moving
# backward is a regression the resume feature must not reintroduce. So before
# ANY moving-ref write the script confirms through the forge API that this run's commit
# is still the live coordinate behind the event's moving refs: the PR HEAD
# commit for a pull_request run, the tagged commit for a release-tag run (a
# release tag that was re-pointed at a different commit supersedes the old
# run). A superseded run (or any uncertain forge
# answer, including a failed or unparseable API call) fails the run CLOSED
# and writes nothing. Runs whose event defines no moving refs never contact
# the forge API.
#
# Inputs (env): GHCR_OWNER, SOURCE_SHA, CONTROLLER_STATE, WORKER_STATE from
# the sha-tag resolver, plus the event's moving-ref coordinates PR_REF and
# RELEASE_VERSION (each empty when the event defines none). A target of an
# event with no moving refs is a no-op — imagetools create is never run just
# to retag the sha ref onto itself. When moving refs ARE due, the guard
# additionally requires GITHUB_TOKEN and GITHUB_REPOSITORY (the runner
# provides both; GITHUB_API_URL defaults to the runner's API base so a
# GitHub Enterprise host is addressed correctly).
#
# Like resolve-sha-tag-state.sh, the registry writes go through the
# already-authenticated Docker CLI. The supersession read is a forge read:
# this workflow runs inside the forge's own runner, so it uses the forge REST
# API directly with the workflow's GITHUB_TOKEN, header-only (the token is
# handed to curl through a config on stdin, never through process argv).
set -euo pipefail

die() {
  echo "::error::$*" >&2
  exit 1
}

# One authenticated GET. The token travels only in the authorization header,
# fed to curl as a config file on stdin so it never appears in argv (`ps`).
api_get() {
  local url="$1"
  printf 'header = "accept: application/vnd.github+json"\nheader = "x-github-api-version: 2022-11-28"\nheader = "authorization: Bearer %s"\n' "$GITHUB_TOKEN" \
    | curl -fsS --config - "$url" 2>&1
}

# The forge git-ref response embeds EXACTLY one object reference:
# "object":{"sha":"<40hex>","type":"commit"|"tag"}. The body is compacted
# first (whitespace is insignificant in JSON), so the match does not depend
# on whether the API pretty-prints. A body carrying none is unparseable and
# one carrying more than one — or an object type outside commit/tag — is
# ambiguous; all of it is uncertain state, so parse_ref_object fails.
# Sets REF_SHA/REF_TYPE.
parse_ref_object() {
  local compact="$1"
  [ "$(printf '%s' "$compact" | grep -o '"object":{' | wc -l)" -eq 1 ] || return 1
  local re='"object":\{"sha":"([0-9a-f]{40})","type":"(commit|tag)"'
  [[ "$compact" =~ $re ]] || return 1
  REF_SHA="${BASH_REMATCH[1]}"
  REF_TYPE="${BASH_REMATCH[2]}"
}

# Confirm this run is the live run for the event's moving refs: resolve the
# forge coordinate those refs follow and require it to equal SOURCE_SHA.
assert_current_run_owns_moving_refs() {
  local coordinate url body compact sha
  if [ -n "$PR_REF" ]; then
    local number="${PR_REF#pr-}"
    case "$number" in
      '' | *[!0-9]*) die "PR_REF '${PR_REF}' carries no PR number; cannot confirm the moving-ref coordinate." ;;
    esac
    coordinate="the head of pull request ${number} (${PR_REF})"
    url="${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/git/ref/pull/${number}/head"
  elif [ -n "$RELEASE_VERSION" ]; then
    # #1744: the exact vX.Y.Z is the only release alias, so there is no
    # shared floating X.Y ref whose newest patch could supersede this run.
    # The tag-coordinate check is the whole release rule: once the tag still
    # resolves to SOURCE_SHA, re-pointing X.Y.Z at this run's commit is
    # correct, and no tag enumeration (an API read with no write reason) is
    # warranted.
    coordinate="the release tag v${RELEASE_VERSION}"
    url="${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/git/ref/tags/v${RELEASE_VERSION}"
  else
    die "moving refs are defined but neither a PR ref nor a release version resolves to a forge coordinate; refusing to retag."
  fi

  if ! body=$(api_get "$url"); then
    printf '%s\n' "$body" >&2
    die "cannot confirm ${coordinate}: the forge API refused the supersession check; refusing to move moving refs over uncertain state."
  fi
  compact=$(printf '%s' "$body" | tr -d '[:space:]')
  if ! parse_ref_object "$compact"; then
    printf '%s\n' "$body" >&2
    die "cannot confirm ${coordinate}: the forge API answer carried no single object reference; refusing to move moving refs over uncertain state."
  fi
  sha="$REF_SHA"
  if [ "$REF_TYPE" = "tag" ]; then
    # Annotated tag: the ref points at a tag OBJECT; follow it to the commit.
    if ! body=$(api_get "${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/git/tags/${sha}"); then
      printf '%s\n' "$body" >&2
      die "cannot dereference the annotated tag behind ${coordinate}; refusing to move moving refs over uncertain state."
    fi
    compact=$(printf '%s' "$body" | tr -d '[:space:]')
    if ! parse_ref_object "$compact" || [ "$REF_TYPE" != "commit" ]; then
      printf '%s\n' "$body" >&2
      die "the annotated tag behind ${coordinate} does not dereference to a commit; refusing to move moving refs over uncertain state."
    fi
    sha="$REF_SHA"
  fi

  if [ "$sha" != "$SOURCE_SHA" ]; then
    die "superseded run: ${coordinate} is at ${sha}, this run builds ${SOURCE_SHA}; refusing to repoint ${PR_REF:-$RELEASE_VERSION} backward at an older commit."
  fi
  echo "supersession check: ${coordinate} still resolves to ${SOURCE_SHA} - safe to republish moving refs"
}

validate_state() {
  local name="$1" state="$2"
  # Fail closed on a state outside the resolver's vocabulary: an unknown
  # value is uncertain publication state, never a silent skip. Both targets
  # are validated BEFORE any write, so a valid target is never retagged while
  # its sibling's state is already known to be uncertain.
  case "$state" in
    present | absent) : ;;
    *) die "${name}: unknown sha-tag state '${state}'; refusing to republish moving refs." ;;
  esac
}

republish_target() {
  local name="$1"
  # Both states write here: a reused target re-converges its aliases on the
  # sha manifest it already holds, a freshly built one gets its aliases from
  # the sha manifest its build step just pushed. The build steps never touch
  # moving refs, so every write below happens behind the supersession guard.
  local repo="ghcr.io/${GHCR_OWNER}/pr-reviewer-${name}"
  local args=()
  [ -n "$PR_REF" ] && args+=( -t "${repo}:${PR_REF}" )
  [ -n "$RELEASE_VERSION" ] && args+=( -t "${repo}:${RELEASE_VERSION}" )
  # #1742: the exact SemVer above is the only release alias — no floating
  # major.minor (or major-only) ref is ever repointed.
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
GITHUB_API_URL="${GITHUB_API_URL:-https://api.github.com}"

validate_state controller "$CONTROLLER_STATE"
validate_state worker "$WORKER_STATE"

# The supersession guard protects EVERY moving-ref write this run can perform
# (this script is the workflow's only moving-ref writer, and it runs after
# every build step has pushed nothing but its immutable sha ref). It runs
# once, whenever the event defines moving refs — regardless of which targets
# were reused or freshly built. Runs with no moving refs (a `main` push)
# write nothing and never contact the forge API.
if [ -n "${PR_REF}${RELEASE_VERSION}" ]; then
  : "${GITHUB_TOKEN:?GITHUB_TOKEN is required to confirm the moving-ref coordinate}"
  : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required to confirm the moving-ref coordinate}"
  assert_current_run_owns_moving_refs
fi

republish_target controller
republish_target worker
