#!/usr/bin/env bash
# ── platform_api.sh ─────────────────────────────────────────────────────
# Platform seam for every host-forge API interaction (issue #221).
#
# Sourced (not executed) by the action's scripts. Exposes platform_* shell
# functions for operations against the repository under review. The github
# backend reproduces the exact pre-seam `gh` invocations so output is
# byte-identical to the un-seamed scripts — the existing test suites (which
# stub `gh` via PATH) are the regression harness and must pass unmodified.
#
# Mode resolution (PLATFORM env, set by action.yml from the `platform` input):
#   github  – default; all operations via the gh CLI.
#   forgejo – operations via pr_reviewer/forgejo_backend.py (curl /api/v1).
#             Requires FORGEJO_API_URL. Implemented per-operation across the
#             1.4.x line; unimplemented operations fail loudly, never silently.
#   auto    – resolved here: forgejo when GITHUB_SERVER_URL is set to a
#             non-github.com host (Forgejo Actions runners populate it with
#             the instance URL), github otherwise.
#
# Two function classes:
#   platform_*       – the repo under review; switches on PLATFORM.
#   github_enrich_*  – linked-source enrichment for third-party repos (which
#                      live on github.com regardless of the host platform).
#                      Always gh; #227 decides degradation behavior on
#                      non-github hosts.
#
# The #190 pitfall applies throughout: gh prints JSON error bodies to STDOUT
# on HTTP errors. Callers' existing rc-check / stdout-discard semantics are
# preserved by keeping each wrapper a thin exec of the original command —
# wrappers must not capture-and-echo, which would launder an error body into
# a success-shaped stdout.

# Guard against double-sourcing (publish_helpers.sh and the caller may both
# source this).
if [[ -n "${_PLATFORM_API_SOURCED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
_PLATFORM_API_SOURCED=1

_PLATFORM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

platform_resolve() {
  # Normalise PLATFORM, resolving `auto` from GITHUB_SERVER_URL.
  local p="${PLATFORM:-github}"
  p="$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')"
  if [[ "$p" == "auto" ]]; then
    local server="${GITHUB_SERVER_URL:-}"
    if [[ -n "$server" && "$server" != "https://github.com" && "$server" != "https://github.com/" ]]; then
      p="forgejo"
    else
      p="github"
    fi
  fi
  case "$p" in
    github|forgejo) printf '%s' "$p" ;;
    *)
      echo "platform_api: unsupported PLATFORM '$p' (expected github|forgejo|auto)" >&2
      return 1
      ;;
  esac
}

_platform_is_forgejo() {
  [[ "$(platform_resolve)" == "forgejo" ]]
}

_forgejo_py() {
  # Invoke the python backend CLI. FORGEJO_API_URL is required in forgejo
  # mode; failing loudly here beats every caller debugging empty output.
  if [[ -z "${FORGEJO_API_URL:-}" ]]; then
    echo "platform_api: PLATFORM=forgejo requires FORGEJO_API_URL" >&2
    return 1
  fi
  PYTHONPATH="${_PLATFORM_SCRIPT_DIR}/..${PYTHONPATH:+:${PYTHONPATH}}" \
    python3 -m pr_reviewer.forgejo_backend "$@"
}

_forgejo_unimplemented() {
  # Operations that land later in the 1.4.x line (#223–#226) fail loudly.
  echo "platform_api: operation '$1' is not yet implemented for PLATFORM=forgejo" >&2
  return 1
}

# ── Core PR I/O ─────────────────────────────────────────────────────────

platform_pr_get() {
  # $1=repo $2=pr_number [extra gh api flags, e.g. --jq] → PR object
  # (GitHub REST shape, or the --jq projection) on stdout
  if _platform_is_forgejo; then
    local repo="$1" num="$2"
    shift 2
    if [[ "${1:-}" == "--jq" && -n "${2:-}" ]]; then
      _forgejo_py get-pr-metadata "$repo" "$num" | jq -r "$2"
    else
      _forgejo_py get-pr-metadata "$repo" "$num"
    fi
  else
    local repo="$1" num="$2"
    shift 2
    gh api "repos/$repo/pulls/$num" "$@"
  fi
}

platform_pr_head_sha() {
  # $1=repo $2=pr_number → head sha on stdout
  if _platform_is_forgejo; then
    _forgejo_py get-pr-metadata "$1" "$2" | jq -r '.head.sha // empty'
  else
    gh api "repos/$1/pulls/$2" --jq '.head.sha'
  fi
}

platform_pr_diff() {
  # $1=repo $2=pr_number → unified diff on stdout
  if _platform_is_forgejo; then
    _forgejo_py get-pr-diff "$1" "$2"
  else
    gh pr diff "$2" --repo "$1"
  fi
}

platform_pr_files() {
  # $1=repo $2=pr_number → first page of changed files (GitHub REST shape)
  if _platform_is_forgejo; then
    _forgejo_py list-pr-files "$1" "$2"
  else
    gh api "repos/$1/pulls/$2/files?per_page=100"
  fi
}

platform_issue_get() {
  # $1=repo $2=issue_number → issue object on stdout
  if _platform_is_forgejo; then
    _forgejo_py fetch-issue "$1" "$2"
  else
    gh api "repos/$1/issues/$2"
  fi
}

platform_issue_comments() {
  # $1=repo $2=issue_number → first page of issue comments
  if _platform_is_forgejo; then
    _forgejo_py list-comments "$1" "$2"
  else
    gh api "repos/$1/issues/$2/comments?per_page=100"
  fi
}

platform_compare() {
  # $1=repo $2=base...head spec [extra gh api flags, e.g. --jq] → compare
  # object (or the --jq projection) on stdout
  if _platform_is_forgejo; then
    _forgejo_unimplemented "compare"   # lands with #223 (incremental scope)
  else
    local repo="$1" spec="$2"
    shift 2
    gh api "repos/$repo/compare/$spec" "$@"
  fi
}

# ── Sticky comment + reviews (publish surface) ─────────────────────────

platform_comment_sticky() {
  # $1=repo $2=pr_number $3=body_file — edit the managed comment or create it
  if _platform_is_forgejo; then
    _forgejo_py edit-last-comment "$1" "$2" "$(cat "$3")" >/dev/null
  else
    gh pr comment "$2" --repo "$1" --edit-last --create-if-none --body-file "$3"
  fi
}

platform_pr_reviews() {
  # $1=repo $2=pr_number [first-page|paginate] → reviews JSON
  if _platform_is_forgejo; then
    _forgejo_unimplemented "pr_reviews"   # lands with #224 (native reviews)
  elif [[ "${3:-first-page}" == "paginate" ]]; then
    gh api "repos/$1/pulls/$2/reviews" --paginate
  else
    gh api "repos/$1/pulls/$2/reviews?per_page=100"
  fi
}

platform_review_create_json() {
  # $1=repo $2=pr_number $3=request_json_file — POST a review (inline comments)
  if _platform_is_forgejo; then
    _forgejo_unimplemented "review_create_json"   # #224
  else
    gh api "repos/$1/pulls/$2/reviews" --method POST --input "$3"
  fi
}

platform_review_native() {
  # $1=repo $2=pr_number $3=APPROVE|REQUEST_CHANGES $4=body_file
  if _platform_is_forgejo; then
    _forgejo_unimplemented "review_native"   # #224
  else
    case "$3" in
      APPROVE) gh pr review "$2" --repo "$1" --approve --body-file "$4" ;;
      *)       gh pr review "$2" --repo "$1" --request-changes --body-file "$4" ;;
    esac
  fi
}

platform_review_dismiss() {
  # $1=repo $2=pr_number $3=review_id $4=message
  if _platform_is_forgejo; then
    _forgejo_unimplemented "review_dismiss"   # #224
  else
    gh api "repos/$1/pulls/$2/reviews/$3/dismissals" --method PUT -f message="$4" --jq '.id'
  fi
}

platform_graphql() {
  # GraphQL passthrough (comment minimisation). GitHub-only API surface; the
  # forgejo path must degrade at the call site per #227, not crash here.
  if _platform_is_forgejo; then
    _forgejo_unimplemented "graphql"
  else
    gh api graphql "$@"
  fi
}

platform_collaborator_permission() {
  # $1=repo $2=login → permission string (admin|write|read|none) on stdout
  if _platform_is_forgejo; then
    _forgejo_unimplemented "collaborator_permission"   # comment-trigger wiring is GitHub-only today
  else
    gh api "repos/$1/collaborators/$2/permission" --jq '.permission'
  fi
}

# ── CI status (wait_for_ci.sh) ──────────────────────────────────────────

platform_check_runs() {
  # $1=repo $2=sha → check-runs JSON
  if _platform_is_forgejo; then
    _forgejo_unimplemented "check_runs"   # #225 uses commit statuses instead
  else
    gh api "repos/$1/commits/$2/check-runs?per_page=100"
  fi
}

platform_commit_status() {
  # $1=repo $2=sha → combined commit status JSON
  if _platform_is_forgejo; then
    _forgejo_unimplemented "commit_status"   # #225
  else
    gh api "repos/$1/commits/$2/status"
  fi
}

# ── GitHub-targeted enrichment (linked third-party sources) ─────────────
# These hit github.com-hosted upstream repos (release notes, compares, tags
# for version hints) and are NOT host-platform operations: on a Forgejo
# deployment the linked sources still live on github.com. #227 gates their
# behavior when no GitHub credentials are available.

github_enrich_api() {
  gh api "$@"
}
