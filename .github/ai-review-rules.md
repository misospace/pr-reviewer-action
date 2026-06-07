# AI PR Review: pr-reviewer-action

## Review conventions

This is a GitHub Action for AI PR review. Review for correctness, security, and backward compatibility.

Areas to watch:
- **Token handling** (`scripts/run_review.sh`): `GITHUB_TOKEN` / `GH_TOKEN` must never be logged, echoed, or exposed in output
- **Comment publishing** (`scripts/publish_review_comment*.sh`): avoid notification/linkback spam — managed comment edits preferred
- **Model response parsing** (`pr_reviewer/response_parser.py`): JSON extraction from markdown blocks, handle both object and array responses
- **URL fetching** (`scripts/run_review.sh`): `ALLOWED_SOURCE_HOSTS` enforcement — new hosts must be intentional
- **Tool harness** (`scripts/run_tool_harness.py`): `tool_allowed_gh_api_repos` scoping; fork repos get limited or disabled tools
- **Evidence providers** (`scripts/run_evidence_providers.py`): commands run during review — must be sandboxed and not write to disk
- **New inputs/outputs**: must be backward-compatible (defaults must preserve existing behavior)
- **Security**: the action receives a `github_token` with write scope — avoid token leakage in output, error messages, or cache

For Renovate digest-only updates (same repository and tag, only `@sha256:` changes):
- Keep review compact: short recommendation, changed files summary, non-blocking caveats only
- No need for full section structure unless there's an actual warning or blocker

## Review tone

- Be direct and practical.
- Flag only real defects, regressions, or meaningful risks as blocking.
- Do not nitpick formatting, naming, or style unless it affects readability or correctness.
- Prefer `approve` or non-blocking comments for PRs that look reasonable overall.
