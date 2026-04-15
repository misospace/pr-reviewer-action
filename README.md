# pr-reviewer-action

Analyze pull requests with a self-hosted or cloud OpenAI-compatible model.

[![CI](https://github.com/joryirving/pr-reviewer-action/actions/workflows/ci.yaml/badge.svg)](https://github.com/joryirving/pr-reviewer-action/actions/workflows/ci.yaml)

The action gathers PR metadata, diff context, linked sources, image digest provenance, basic repository impact/history, and an optional standards file such as `CLAUDE.md`. It returns a structured verdict and markdown review body, and it can also publish or update a sticky PR comment.

## What it supports

- self-hosted OpenAI-compatible endpoints
- cloud OpenAI-compatible subscriptions with bearer auth
- optional fallback model/endpoint
- optional managed PR comment publishing
- automatic skip when the effective PR diff is unchanged since the last managed review
- repo-provided rules via `CLAUDE.md`, `AGENTS.md`, or a custom file
- full prompt override via inline text or a file in the destination repo

## Requirements

- The repository under review must already be checked out.
- The runner must have `gh`, `jq`, `curl`, `git`, and `python3`.
- The workflow should run on `pull_request` events, or pass explicit `repo` and `pr_number` inputs.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `github_token` | GitHub token for PR and API access | Yes | - |
| `repo` | Repository in `owner/name` format | No | current repository |
| `pr_number` | Pull request number | No | current `pull_request` number |
| `ai_base_url` | Base URL of the primary OpenAI-compatible API | Yes | - |
| `ai_model` | Model name for the primary analysis pass | Yes | - |
| `ai_api_key` | Optional bearer token for the primary AI endpoint | No | `""` |
| `ai_fallback_base_url` | Optional fallback OpenAI-compatible API base URL | No | `""` |
| `ai_fallback_model` | Optional fallback model name | No | `""` |
| `ai_fallback_api_key` | Optional bearer token for the fallback AI endpoint | No | `""` |
| `ai_primary_retries` | Number of retries for the primary model | No | `8` |
| `ai_primary_retry_delay_sec` | Delay between retries in seconds | No | `15` |
| `allowed_source_hosts` | Comma-separated allowlist for linked URL fetching | No | `github.com,api.github.com,gitlab.com,registry.terraform.io,artifacthub.io` |
| `system_prompt` | Optional system prompt override | No | bundled prompt |
| `system_prompt_file` | File in the reviewed repo to use as the full system prompt | No | `""` |
| `standards_file` | Standards or conventions file from the reviewed repo | No | `CLAUDE.md` |
| `standards_file_candidates` | Candidate files to auto-discover when `standards_file` is missing or blank | No | `CLAUDE.md,claude.md,AGENTS.md,agents.md,.github/ai-review-rules.md,.github/ai-review-rules.txt` |
| `publish_review_comment` | Publish or update a managed PR comment | No | `false` |
| `skip_if_diff_unchanged` | Skip the LLM review when the current PR patch matches the last managed review fingerprint | No | `true` |
| `comment_marker` | HTML marker for the managed PR comment | No | `<!-- ai-pr-reviewer -->` |

## Outputs

| Output | Description |
|--------|-------------|
| `verdict` | `approve` or `request_changes` |
| `review_markdown` | Full markdown review body |
| `analysis_engine` | Model and endpoint that produced the final result |
| `should_review` | `true` when a new LLM review was run |
| `skip_reason` | Skip reason such as `diff-unchanged` |
| `diff_fingerprint` | Stable fingerprint of the current PR patch |

## Usage

### Self-hosted model

```yaml
name: AI PR Review

on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    if: ${{ !github.event.pull_request.draft }}
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}

      - uses: joryirving/pr-reviewer-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          ai_base_url: http://llama-server.internal:8080/v1
          ai_model: qwen3-32b
          publish_review_comment: "true"
```

### Cloud model subscription

```yaml
name: AI PR Review

on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    if: ${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}

      - uses: joryirving/pr-reviewer-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          ai_base_url: https://api.openai.com/v1
          ai_model: gpt-4.1
          ai_api_key: ${{ secrets.OPENAI_API_KEY }}
          standards_file: CLAUDE.md
          publish_review_comment: "true"
```

### With a fallback model

```yaml
- uses: joryirving/pr-reviewer-action@v1
  id: review
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    ai_base_url: http://llama-server.internal:8080/v1
    ai_model: qwen3-32b
    ai_fallback_base_url: https://api.openai.com/v1
    ai_fallback_model: gpt-4.1-mini
    ai_fallback_api_key: ${{ secrets.OPENAI_API_KEY }}
```

### Use repo-local review rules

If the destination repo has a `CLAUDE.md`, `claude.md`, `AGENTS.md`, or `.github/ai-review-rules.md`, the action can use that as review policy context.

```yaml
- uses: joryirving/pr-reviewer-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    ai_base_url: https://api.openai.com/v1
    ai_model: gpt-4.1
    ai_api_key: ${{ secrets.OPENAI_API_KEY }}
    standards_file: ""
```

You can also pin a specific rules file:

```yaml
- uses: joryirving/pr-reviewer-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    ai_base_url: https://api.openai.com/v1
    ai_model: gpt-4.1
    ai_api_key: ${{ secrets.OPENAI_API_KEY }}
    standards_file: .github/review-rules.md
```

### Use a repo-local prompt file

If a repo wants more than policy context and needs to fully control the reviewer behavior, it can provide a prompt file:

```yaml
- uses: joryirving/pr-reviewer-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    ai_base_url: https://api.openai.com/v1
    ai_model: gpt-4.1
    ai_api_key: ${{ secrets.OPENAI_API_KEY }}
    system_prompt_file: .github/pr-review-prompt.md
```

## Notes

- The action expects an OpenAI-compatible `POST /chat/completions` API.
- `system_prompt` takes precedence over `system_prompt_file`.
- `system_prompt_file` takes precedence over the bundled generic prompt.
- `standards_file` is optional; if it is missing, the action will try `standards_file_candidates` before continuing without repository standards context.
- By default, the action computes a stable patch fingerprint with `git patch-id --stable` and skips the LLM call when that fingerprint matches the most recent managed review comment. This avoids token spend on rebases and other history-only changes.
- `publish_review_comment` uses `gh pr comment --edit-last --create-if-none`, so the comment is managed by the token identity used in the workflow.

## Validation

This repo includes a local smoke test that exercises the action logic against a real GitHub pull request while using a mock OpenAI-compatible API server.

Run it with a specific PR:

```bash
PR_NUMBER=6757 tests/smoke_test.sh
```

Or let it pick the most recent open PR in `joryirving/home-ops`:

```bash
tests/smoke_test.sh
```

The smoke test validates:

- GitHub PR data collection through `gh`
- review corpus assembly
- OpenAI-compatible `chat/completions` request formatting
- output parsing and action output generation

## Examples

Copyable workflows are included here:

- `examples/workflow-self-hosted.yml`
- `examples/workflow-cloud.yml`

## License

MIT
