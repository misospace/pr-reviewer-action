# pr-reviewer-action

Analyze pull requests with a self-hosted or cloud OpenAI-compatible model.

[![CI](https://github.com/joryirving/pr-reviewer-action/actions/workflows/ci.yaml/badge.svg)](https://github.com/joryirving/pr-reviewer-action/actions/workflows/ci.yaml)

The action gathers PR metadata, diff context, linked issue context from PR-closing references, linked sources, optional evidence provider output, optional tool harness output, image digest provenance, basic repository impact/history, and an optional standards file such as `CLAUDE.md`. It returns a structured verdict and markdown review body, and it can also publish or update a sticky PR comment.

## What it supports

- self-hosted OpenAI-compatible endpoints
- cloud OpenAI-compatible subscriptions with bearer auth
- optional fallback model/endpoint
- optional evidence providers for repo-specific checks
- optional read-only tool harness for one planning round
- optional managed PR comment publishing
- automatic skip when the effective PR diff is unchanged since the last managed review
- linked issue body ingestion from `Fixes #123`, `Closes owner/repo#456`, and similar PR-body references
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
| `standards_file` | Explicit standards file path; takes priority over candidates | No | `""` |
| `standards_file_candidates` | Candidate files checked in order; first found is used | No | `AGENTS.md,agents.md,CLAUDE.md,claude.md,.github/ai-review-rules.md,.github/ai-review-rules.txt` |
| `publish_review_comment` | Publish or update a managed PR comment | No | `false` |
| `context_limit_mode` | Context budget mode: `normal` (140k/70k/220k), `low` (80k/40k/120k), `minimal` (40k/20k/60k) | No | `normal` |
| `evidence_providers_file` | Optional JSON file in the reviewed repo defining evidence provider commands | No | `""` |
| `evidence_provider_timeout_sec` | Default timeout in seconds for each evidence provider command | No | `30` |
| `evidence_provider_max_output_bytes` | Max stdout or stderr bytes captured per provider command | No | `20000` |
| `evidence_blocker_enforcement` | Force `request_changes` when any provider reports blocker severity | No | `false` |
| `evidence_enable_for_forks` | Allow evidence providers on cross-repository PRs | No | `false` |
| `tool_mode` | Tool harness mode: `off` or `plan_execute_once` | No | `off` |
| `tool_max_requests` | Maximum tool requests executed in one harness run | No | `4` |
| `tool_planning_timeout_sec` | Timeout in seconds for tool harness planning model call | No | `30` |
| `tool_planning_max_context_bytes` | Maximum corpus bytes passed to planning | No | `50000` |
| `tool_planning_max_tokens` | Maximum completion tokens for tool harness planning call | No | `400` |
| `tool_max_response_bytes` | Maximum bytes captured from each tool response | No | `12000` |
| `tool_allowed_gh_api_repos` | Comma-separated owner/repo allowlist for `gh_api` (empty = current repo only) | No | `""` |
| `tool_request_timeout_sec` | Timeout in seconds for each tool execution request | No | `20` |
| `tool_failure_enforcement` | Force `request_changes` when tool harness planning fails | No | `false` |
| `tool_min_successful_requests` | Minimum successful tool requests required when `tool_failure_enforcement=true` | No | `0` |
| `tool_enable_for_forks` | Allow tool harness on cross-repository PRs | No | `false` |
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

### With evidence providers

```yaml
- uses: joryirving/pr-reviewer-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    ai_base_url: http://llama-server.internal:8080/v1
    ai_model: qwen3-32b
    evidence_providers_file: .github/pr-review-providers.json
    evidence_provider_timeout_sec: "30"
    evidence_provider_max_output_bytes: "20000"
    evidence_blocker_enforcement: "true"
```

Example provider config (`.github/pr-review-providers.json`):

```json
{
  "providers": [
    {
      "id": "version-compat",
      "command": ["python3", "scripts/check_version_compat.py"],
      "timeout_sec": 45,
      "max_output_bytes": 15000
    }
  ]
}
```

Provider commands can print plain text, or JSON with fields such as `severity` and `findings`. If `evidence_blocker_enforcement` is `true`, any provider output with blocker severity forces a `request_changes` verdict.

### With tool harness planning

```yaml
- uses: joryirving/pr-reviewer-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    ai_base_url: http://llama-server.internal:8080/v1
    ai_model: qwen3-32b
    tool_mode: plan_execute_once
    tool_max_requests: "4"
    tool_planning_timeout_sec: "30"
    tool_planning_max_context_bytes: "50000"
    tool_planning_max_tokens: "400"
    tool_max_response_bytes: "12000"
    tool_allowed_gh_api_repos: "siderolabs/kubelet,siderolabs/talos"
    tool_request_timeout_sec: "20"
    tool_failure_enforcement: "true"
    tool_min_successful_requests: "1"
```

In `plan_execute_once` mode, the model first plans up to `tool_max_requests` read-only evidence calls, then the action executes those calls and appends the results to the final review corpus. Supported tools are:

- `gh_api` with a repo-local path like `repos/owner/repo/pulls/123/files`
- `read_file` for files inside the checked-out repository
- `web_fetch` for allowlisted hosts from `allowed_source_hosts`
- `git_grep` for local repository content search

By default, tool harness execution is skipped on cross-repository PRs unless `tool_enable_for_forks` is set to `true`.

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

### Issue-first review workflows

If PRs are driven by detailed GitHub issues, include closing references such as `Fixes #40` or `Closes owner/repo#12` in the PR body. The action will fetch those issue bodies and include them in the review corpus so the model can compare the implementation against issue guidance and acceptance criteria.

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
- `standards_file` is optional; if blank, the action checks `standards_file_candidates` in order and uses the first file found. `AGENTS.md` is checked first by default, then `CLAUDE.md`, making the action compatible with both Claude Code and non-Claude Code setups.
- By default, the action computes a stable patch fingerprint with `git patch-id --stable` and skips the LLM call when that fingerprint matches the most recent managed review comment. This avoids token spend on rebases and other history-only changes.
- `publish_review_comment` uses `gh pr comment --edit-last --create-if-none`, so the comment is managed by the token identity used in the workflow.
- `context_limit_mode` reduces the amount of PR data sent to the LLM. Use `minimal` for models with very small context windows. This skips nothing but truncates more aggressively.
- `evidence_providers_file` accepts JSON only. It can be either an object with `providers: []` or a top-level provider array.
- Provider `command` may be a shell string or an argument array. Each provider can override `timeout_sec` and `max_output_bytes`.
- Provider output is appended to the review corpus under an `Evidence Providers` section.
- `tool_mode=plan_execute_once` adds a single planning-and-execution tool round before final review synthesis.
- Tool harness output is appended to the review corpus under `Tool Harness Findings`.
- Tool harness planning treats corpus content as untrusted data and uses strict tool/path/host allowlists with output redaction.
- Evidence providers and tool harness are both disabled by default on cross-repository PRs (`*_enable_for_forks=false`).
- `gh_api` defaults to current-repo scope only. Use `tool_allowed_gh_api_repos` to allow specific upstream repos.
- For local models, reduce `tool_planning_max_context_bytes` and `tool_planning_max_tokens`, and increase `tool_planning_timeout_sec` as needed.
- Set `tool_failure_enforcement=true` to fail closed when tool harness planning fails or when every tool request fails.
- Use `tool_min_successful_requests` (for example `1`) to enforce a minimum successful tool-evidence threshold when the planner attempted tool requests.
- Model requests use `curl -q` so user-level `.curlrc` timeouts do not unexpectedly cancel long-running local model calls.

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

## Security

See `SECURITY.md` for threat model, controls, and operational guidance.
