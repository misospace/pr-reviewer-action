# AI PR Review: pr-reviewer-action

## Review conventions

This is a GitHub Action for AI PR review. Review for correctness, security, and backward compatibility.

Areas to watch:
- **Token handling** (`src/transport/`, `src/platform/`): `GITHUB_TOKEN` / `GH_TOKEN` must never be logged, echoed, or exposed in output
- **Comment publishing** (`src/publish/`): avoid notification/linkback spam — managed comment edits preferred
- **Model response parsing** (`src/model/verdict.ts`): JSON extraction from markdown blocks, handle both object and array responses
- **URL fetching** (`src/platform/safe-fetch.ts`): `ALLOWED_SOURCE_HOSTS` enforcement — new hosts must be intentional
- **Tool harness** (`src/tools/`): `tool_allowed_gh_api_repos` scoping; fork repos get limited or disabled tools
- **Evidence providers** (`src/evidence/`): commands run during review — must be sandboxed and not write to disk
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
