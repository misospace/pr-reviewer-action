# pr-reviewer-action

Analyze pull requests with a self-hosted or cloud OpenAI-compatible or Anthropic-compatible model.

[![CI](https://github.com/misospace/pr-reviewer-action/actions/workflows/ci.yaml/badge.svg)](https://github.com/misospace/pr-reviewer-action/actions/workflows/ci.yaml)

The action gathers PR metadata, diff context, linked issue context from PR-closing references, linked sources, optional evidence provider output, optional tool harness output, image digest provenance, basic repository impact/history, and an optional standards file such as `CLAUDE.md`. It returns a structured verdict and markdown review body, and it can also publish or update a sticky PR comment.

## What it supports

- self-hosted OpenAI-compatible endpoints
- native Anthropic-compatible `/messages` endpoints
- cloud OpenAI-compatible or Anthropic-compatible subscriptions
- optional fallback model/endpoint
- optional evidence providers for repo-specific checks
- optional read-only tool harness for one planning round
- optional managed PR comment publishing
- automatic skip when the effective PR diff is unchanged since the last managed review
- linked issue body ingestion from `Fixes #123`, `Closes owner/repo#456`, and similar PR-body references
- repo-provided rules via `CLAUDE.md`, `AGENTS.md`, or a custom file
- upstream link sanitizer to neutralize auto-linked PR/issue/commit references in published reviews

### Upstream Link Sanitizer

Before publishing, the action runs `scripts/sanitize_review_markdown.py` on the review markdown to neutralize upstream GitHub references (PR URLs, issue URLs, commit URLs, compare URLs, cross-repo `owner/repo#123` references, and bare `#123` references). This prevents GitHub from auto-linking them into the reviewed repository, which would create notification noise and misleading linkbacks to unrelated projects. Sanitization is documented as P0 hygiene in [issue #132](https://github.com/misospace/pr-reviewer-action/issues/132).



### Deterministic PR Classification

Before invoking the AI model, the action runs a deterministic classification step that analyzes changed file paths, diff content, and linked issue context to produce structured metadata about the PR. This helps smaller/weaker reviewer models stay focused and reduces the chance of being misled by irrelevant context.

**Classification output (injected into the review corpus):**

| Field | Description |
|-------|-------------|
| `pr_kind` | One of: `renovate_digest_only`, `dependency_upgrade`, `app_code`, `k8s_manifest`, `auth_changes`, `public_route_changes`, `file_serving_changes`, `path_handling_changes`, `secret_handling_changes`, `db_or_migration_changes` |
| `risk_flags` | Detected risk indicators such as `linked_security_issue`, `linked_audit_issue`, `linked_priority_p0`, `linked_priority_p1`, `file_serving_changes`, `path_handling_changes`, `auth_changes`, `secret_handling_changes` |
| `changed_files_summary` | List of changed file paths (truncated to 50) |
| `linked_issue_labels` | Labels from linked issues when available |
| `must_check` | Explicit checklist items derived from the classification (e.g., "review auth flow for regression" for `auth_changes`) |

The classification is purely rule-based — no model calls are involved. It uses pattern matching on file paths, diff content, and linked issue metadata to determine the PR type and associated risk flags.

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
| `ai_base_url` | Base URL of the primary AI API | Yes | - |
| `ai_api_format` | Primary API request/response format: `openai` or `anthropic` | No | `openai` |
| `ai_model` | Model name for the primary analysis pass | Yes | - |
| `ai_api_key` | Optional API key for the primary AI endpoint. OpenAI format sends `Authorization: Bearer`; Anthropic format sends `x-api-key` | No | `""` |
| `ai_max_tokens` | Maximum completion tokens for primary and fallback final review calls. Required by Anthropic-compatible APIs | No | `4096` |
| `anthropic_version` | `anthropic-version` header used for Anthropic-compatible requests | No | `2023-06-01` |
| `ai_fallback_base_url` | Optional fallback AI API base URL | No | `""` |
| `ai_fallback_api_format` | Fallback API request/response format; defaults to `ai_api_format` when blank | No | `""` |
| `ai_fallback_model` | Optional fallback model name | No | `""` |
| `ai_fallback_api_key` | Optional API key for the fallback AI endpoint | No | `""` |
| `ai_primary_retries` | Number of retries for the primary model | No | `8` |
| `ai_primary_retry_delay_sec` | Delay between retries in seconds | No | `15` |
| `allowed_source_hosts` | Comma-separated allowlist for linked URL fetching | No | `github.com,api.github.com,gitlab.com,registry.terraform.io,artifacthub.io` |
| `system_prompt` | Optional system prompt override | No | bundled prompt |
| `system_prompt_file` | File in the reviewed repo to use as the full system prompt | No | `""` |
| `standards_file` | Explicit standards file path; takes priority over candidates | No | `""` |
| `standards_file_candidates` | Candidate files checked in order; first found is used | No | `AGENTS.md,agents.md,CLAUDE.md,claude.md,.github/ai-review-rules.md,.github/ai-review-rules.txt` |
| `publish_review_comment` | Publish or update a managed PR comment | No | `false` |
| `publish_mode` | Publish mode for the review verdict: `comment` (sticky PR comment, default), `review_comment` (non-blocking native PR review comment), `review_verdict` (native approve/request_changes). Requires `pull-requests: write` for review_comment and review_verdict | No | `comment` |
| `allow_approve` | If true and publish_mode=review_verdict, the model's approve verdict can be submitted as a native approval. Defaults to false — approval is blocked unless explicitly enabled. WARNING: native approvals can affect branch protection rules and automerge pipelines. | No | `false` |
| `approve_forks` | If true and publish_mode=review_verdict with allow_approve=true, native approvals are also allowed for cross-repository (fork) PRs. Defaults to false — fork PRs are blocked from approval even when allow_approve is set. | No | `false` |
| `cleanup_previous_native_reviews` | Mark previous managed native PR reviews as outdated/superseded before publishing a new native review. Accepted values: `auto` (default, enables cleanup for review_comment and review_verdict modes), `true`, or `false`. Cleanup only targets reviews created by this action carrying the managed marker. Dismissal of old approval/request-changes reviews is attempted when permissions allow but is secondary to visual cleanup. | No | `auto` |
| `context_limit_mode` | Context budget mode: `normal` (140k/70k/220k), `low` (80k/40k/120k), `minimal` (40k/20k/60k) | No | `normal` |
| `enrichment_budget_sec` | Maximum seconds to spend on enrichment (linked source fetching, release metadata, ghcr.io lookups). Exceeding the budget stops further enrichment. | No | `60` |
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
| `tool_allowed_gh_api_repos` | Comma-separated owner/repo allowlist for `gh_api`; use `*` to allow any repo endpoint still permitted by the tool path allowlist (empty = current repo only) | No | `""` |
| `tool_request_timeout_sec` | Timeout in seconds for each tool execution request | No | `20` |
| `tool_failure_enforcement` | Force `request_changes` when tool harness planning fails | No | `false` |
| `tool_min_successful_requests` | Minimum successful tool requests required when `tool_failure_enforcement=true` | No | `0` |
| `tool_enable_for_forks` | Allow tool harness on cross-repository PRs | No | `false` |
| `ai_request_timeout_sec` | Timeout in seconds for the primary model API request (`curl --max-time`) | No | `300` |
| `ai_connect_timeout_sec` | Timeout in seconds for the primary model API connection (`curl --connect-timeout`) | No | `30` |
| `ai_fallback_request_timeout_sec` | Timeout in seconds for the fallback model API request (`curl --max-time`). Defaults to `ai_request_timeout_sec` when blank. | No | `""` |
| `ai_fallback_connect_timeout_sec` | Timeout in seconds for the fallback model API connection (`curl --connect-timeout`). Defaults to `ai_connect_timeout_sec` when blank. | No | `""` |
| `ai_stream` | If true, use streaming responses to avoid timeouts behind proxies with short read timeouts (e.g. Cloudflare 100s edge timer) | No | `"true"` |
| `ai_fallback_stream` | If set, overrides ai_stream for the fallback model; defaults to ai_stream value when blank | No | `""` |
| `skip_if_diff_unchanged` | Skip the LLM review when the current PR patch matches the last managed review fingerprint | No | `true` |
| `comment_marker` | HTML marker for the managed PR comment | No | `<!-- ai-pr-reviewer -->` |
| `review_scope` | Controls whether the action reviews the full PR or only changes since the last managed review. Accepted values: `auto` (default, full on first run, incremental on later safe updates), `full` (always full review), `incremental` (delta review, falls back to full if prior metadata unavailable) | No | `auto` |
| `ci_status_check` | Wait for all CI checks to reach a terminal state before starting the AI review. Default false — immediate review. | No | `false` |
| `ci_timeout_sec` | Maximum seconds to wait for CI checks to complete when ci_status_check=true. | No | `300` |
| `ci_interval_sec` | Seconds between CI status polls when ci_status_check=true. | No | `15` |
| `ci_skip_on_timeout` | If true, proceed with review after timeout instead of failing. | No | `true` |

## Outputs

| Output | Description |
|--------|-------------|
| `verdict` | `approve` or `request_changes` |
| `review_markdown` | Full markdown review body |
| `analysis_engine` | Model and endpoint that produced the final result |
| `should_review` | `true` when a new LLM review was run |
| `skip_reason` | Skip reason such as `diff-unchanged` |
| `diff_fingerprint` | Stable fingerprint of the current PR patch |
| `ci_status_skipped` | `true` if CI status check was skipped, `false` if it completed |
| `ci_status_final` | Final CI state (`success`/`failure`) when `ci_status_check` completed |
| `effective_review_scope` | Effective scope used: `full` or `incremental` |
| `previous_head_sha` | Previous head SHA when scope is `incremental` |
| `baseline_clean` | Whether the full-review baseline was clean (for verdict safety) |

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

      - uses: misospace/pr-reviewer-action@v1
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

      - uses: misospace/pr-reviewer-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          ai_base_url: https://api.openai.com/v1
          ai_model: gpt-4.1
          ai_api_key: ${{ secrets.OPENAI_API_KEY }}
          standards_file: CLAUDE.md
          publish_review_comment: "true"
```

### Native Anthropic-compatible endpoint

```yaml
- uses: misospace/pr-reviewer-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    ai_base_url: https://api.anthropic.com/v1
    ai_api_format: anthropic
    ai_model: claude-sonnet-4-5
    ai_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    ai_max_tokens: "4096"
    publish_review_comment: "true"
```

When `ai_api_format: anthropic` is set, the action posts to `/messages`, sends the `x-api-key` and `anthropic-version` headers, and parses only Anthropic `text` content blocks. Non-text blocks such as `thinking` are ignored so private reasoning is not copied into PR comments.

### With a fallback model

```yaml
- uses: misospace/pr-reviewer-action@v1
  id: review
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    ai_base_url: http://llama-server.internal:8080/v1
    ai_model: qwen3-32b
    ai_fallback_base_url: https://api.openai.com/v1
    ai_fallback_api_format: openai
    ai_fallback_model: gpt-4.1-mini
    ai_fallback_api_key: ${{ secrets.OPENAI_API_KEY }}
```

### Waiting for CI checks

Set `ci_status_check: true` to wait for all CI checks to reach a terminal state before starting the AI review. This ensures the review considers the final CI results rather than running against in-progress checks.

```yaml
- uses: misospace/pr-reviewer-action@v1
  id: review
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    ai_base_url: http://llama-server.internal:8080/v1
    ai_model: qwen3-32b
    ci_status_check: "true"
    ci_timeout_sec: "300"
    ci_interval_sec: "15"
    ci_skip_on_timeout: "true"
```

When `ci_skip_on_timeout: true` (the default), the action proceeds with the review after `ci_timeout_sec` even if checks are still running. Set it to `false` to fail the action on timeout instead. The `ci_status_skipped` and `ci_status_final` outputs indicate whether the CI wait completed and what the final state was.

### With evidence providers

```yaml
- uses: misospace/pr-reviewer-action@v1
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

#### Evidence provider execution model

Evidence providers execute in the context of the **checked-out pull request code**. The command runs from the repository root with full access to the PR's working tree, environment variables, and installed tools. This means:

- Provider scripts reference files relative to the PR branch being reviewed, not the base branch.
- Commands have access to all repository files staged or committed in the PR.
- Environment variables set by the GitHub Actions runner (such as `GITHUB_TOKEN`, `HOME`, etc.) are available to provider commands.

**Argv arrays are strongly recommended over shell strings.** When `command` is an array like `["python3", "scripts/check.py"]`, the action invokes the process directly via `subprocess.run` with no shell interpretation. When `command` is a string, it runs through `bash -lc`, which introduces shell injection risks if any part of the command or environment is influenced by untrusted PR content.

#### Cross-repository (fork) behavior

Evidence providers are **disabled by default on cross-repository pull requests** (`evidence_enable_for_forks=false`). This prevents forked PRs from executing arbitrary scripts defined in the destination repository's config. Set `evidence_enable_for_forks: "true"` only when you trust fork contributors or run reviews in an isolated environment.

### Publish modes

The action supports three publish modes via the `publish_mode` input:

| Mode | Behavior | Branch protection impact |
|------|----------|------------------------|
| `comment` | Posts a sticky PR comment with `<!-- ai-pr-reviewer -->` markers. The default mode. | None — comments are advisory only |
| `review_comment` | Submits a non-blocking native PR review comment via `gh pr review --comment`. | None — review comments don't affect status checks |
| `review_verdict` | Submits a native PR review verdict (`approve` or `request_changes`) via `gh pr review`. Affects branch protection and status checks. | Yes — counts as a real review |


### Permissions per publish mode

Each publish mode requires different GitHub token permissions in your workflow:

| Publish mode | Required permissions | Notes |
|---|---|---|
| `comment` | `contents: read`, `pull-requests: write` | The action posts a managed comment using the existing sticky-comment behavior. `pull-requests: write` is needed for the token to create/edit PR comments. |
| `review_comment` | `contents: read`, `pull-requests: write` | Submits non-blocking native review comments via `gh pr review --comment`. The token must have `pull-requests: write`. |
| `review_verdict` | `contents: read`, `pull-requests: write` | Submits native approve or request-changes verdicts. Requires `pull-requests: write` and may additionally require the **Allow GitHub Actions to create and approve pull requests** setting (see below). |

All modes require `contents: read` for the action to access repository files during review.

### Native PR review verdicts

When `publish_mode=review_verdict` is set, the action submits a native GitHub PR review
(`approve` or `request_changes`) instead of posting a comment. This integrates with branch
protection rules and status checks.

**Approval guardrails:**

- `allow_approve` defaults to `false`. The model's approve verdict will be blocked unless
  this input is explicitly set to `true`.
- `approve_forks` defaults to `false`. Even when `allow_approve=true`, native approvals are
  blocked for cross-repository (fork) PRs unless this is also set to `true`.
- If evidence provider enforcement or tool harness failure enforcement modified the verdict
  to `request_changes`, approval is automatically blocked.
- The review body must be non-empty for an approval to be submitted.

⚠️ **WARNING**: Native approvals can affect branch protection rules and automerge pipelines.
Enable `allow_approve` only when you understand the implications for your repository's
merge policy.

```yaml
- uses: misospace/pr-reviewer-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    ai_base_url: https://api.openai.com/v1
    ai_model: gpt-4.1
    ai_api_key: ${{ secrets.OPENAI_API_KEY }}
    publish_mode: review_verdict
    allow_approve: "true"
```


#### Example: full workflow with `publish_mode=review_verdict`

```yaml
name: AI PR Review (native verdicts)

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

      - uses: misospace/pr-reviewer-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          ai_base_url: https://api.openai.com/v1
          ai_model: gpt-4.1
          ai_api_key: ${{ secrets.OPENAI_API_KEY }}
          publish_review_comment: "true"
          publish_mode: review_verdict
          allow_approve: "true"
```

> **Note**: This workflow requires the **Allow GitHub Actions to create and approve pull requests** setting to be enabled for your repository or organization. Without it, native approvals will fail with a 403 error even though `pull-requests: write` is granted.

This configuration allows the AI to submit native approvals when its verdict is `approve`.
Fork PRs are still blocked from approval unless `approve_forks` is also set to `"true"`.

### Why approvals may fail even with `pull-requests: write`

Even when your workflow grants `pull-requests: write`, native PR review verdicts (approve/request-changes) may fail silently or error out because of **GitHub Actions repository settings**:

1. **Allow GitHub Actions to create and approve pull requests** — This organization or repository setting must be enabled for Actions to submit native approvals. Without it, the `gh pr review --approve` command will fail with a 403 error from the GitHub API. You can find this setting under:
   - **Repository**: Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"
   - **Organization**: Settings → Actions → Organization permissions → "Allow GitHub Actions to create and approve pull requests"

2. **Branch protection rules** — If branch protection requires a review from a specific user or team, the AI's approval may not satisfy that requirement. The PR will still show `request_changes` until the required reviewer approves.

3. **Fork PRs without `approve_forks: true`** — Approvals from fork PRs are blocked by default unless `approve_forks` is explicitly set to `"true"`.

When approval is blocked, the action always submits a `request_changes` verdict with an explanation in the review body rather than failing silently.

### Non-blocking review comments

When `publish_mode=review_comment` is set, the action submits a non-blocking native PR review comment via `gh pr review --comment`. This gives you a GitHub-native review entry in the PR's conversation thread without affecting branch protection or status checks.

```yaml
- uses: misospace/pr-reviewer-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    ai_base_url: https://api.openai.com/v1
    ai_model: gpt-4.1
    ai_api_key: ${{ secrets.OPENAI_API_KEY }}
    publish_mode: review_comment
```

### Native review cleanup

When `publish_mode` is set to `review_comment` or `review_verdict`, the action creates a new submitted native PR review on every run. Without cleanup, old AI reviews pile up in the PR timeline and make the conversation noisy.

By default, the action automatically cleans up previous managed native reviews for `review_comment` and `review_verdict` modes. The `cleanup_previous_native_reviews` input controls this behavior:

- `auto` (default): enables cleanup for `review_comment` and `review_verdict` modes, disabled for `comment` mode (which already edits one sticky comment in place).
- `true`: always enable cleanup regardless of publish mode.
- `false`: disable cleanup entirely.

The cleanup process:

1. Identifies previous managed AI reviews from the current authenticated actor that carry the `<!-- ai-pr-reviewer -->` marker.
2. Dismisses old approval or request-changes verdict reviews when permissions allow, so stale verdicts stop counting toward branch protection.
3. Updates the body of old managed reviews to a compact "Outdated: superseded by a newer automated review." stub.

Old reviews may still exist in the PR timeline, but they are visually minimized and explicitly marked as outdated. Human reviews and unmarked bot reviews are never modified.

Cleanup and dismissal failures produce warnings but do not prevent posting the new review. If you need to grant additional permissions for dismissal:

```yaml
permissions:
  contents: read
  pull-requests: write
```

The `pull-requests: write` permission is required for both posting reviews and dismissing them. On protected branches or stricter repositories, GitHub may require repository admin permissions or explicit review-dismissal settings to be enabled for the app/token.

### With tool harness planning


```yaml
- uses: misospace/pr-reviewer-action@v1
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
- uses: misospace/pr-reviewer-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    ai_base_url: https://api.openai.com/v1
    ai_model: gpt-4.1
    ai_api_key: ${{ secrets.OPENAI_API_KEY }}
    standards_file: ""
```

You can also pin a specific rules file:

```yaml
- uses: misospace/pr-reviewer-action@v1
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
- uses: misospace/pr-reviewer-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    ai_base_url: https://api.openai.com/v1
    ai_model: gpt-4.1
    ai_api_key: ${{ secrets.OPENAI_API_KEY }}
    system_prompt_file: .github/pr-review-prompt.md
```

### Token-saving with incremental reviews

When `review_scope: auto` (the default), the action performs a full PR review on the first run. On subsequent pushes to the same PR, it attempts an **incremental review** that only analyzes the delta since the last managed review. This can significantly reduce token usage for large PRs with multiple commits.

Key behaviors:
- **First run**: Full PR review (same as before).
- **Later pushes**: Incremental review of only new changes.
- **Fallback**: Automatically falls back to full review when incremental comparison is unsafe (force-push, rebase, base branch change, missing metadata, etc.).
- **Verdict safety**: With `publish_mode: review_verdict`, approvals based on incremental reviews require a trusted clean full-review baseline.

You can force specific behavior:
```yaml
# Always do full reviews (original behavior)
- uses: misospace/pr-reviewer-action@vX.Y.Z
  with:
    review_scope: full

# Always attempt incremental (falls back safely)
- uses: misospace/pr-reviewer-action@vX.Y.Z
  with:
    review_scope: incremental
```

## Notes
- **Reserved comment markers**: The managed PR comment uses HTML comment markers for internal metadata. These are reserved and must not appear in model-generated review markdown:
  - `<!-- ai-pr-review-fingerprint:<value> -->` — stable patch + config fingerprint used by the precheck to skip unchanged diffs.
  - `<!-- ai-pr-review-sha:<sha> -->` — PR head SHA used to detect out-of-date reviews.
  The action strips any matching markers from model output before publishing (see `scripts/strip_metadata_markers.py`). The precheck parser reads only the **first** occurrence of each marker for defense in depth.


- `ai_api_format=openai` posts to `/chat/completions` and parses `choices[0].message.content`.
- `ai_api_format=anthropic` posts to `/messages` and parses only `content[]` blocks where `type == "text"`.
- The tool harness planner uses the primary `ai_api_format`; fallback settings apply only to the final review call.
- `system_prompt` takes precedence over `system_prompt_file`.
- `system_prompt_file` takes precedence over the bundled generic prompt.
- `standards_file` is optional; if blank, the action checks `standards_file_candidates` in order and uses the first file found. `AGENTS.md` is checked first by default, then `CLAUDE.md`, making the action compatible with both Claude Code and non-Claude Code setups.
- By default, the action computes a stable patch fingerprint with `git patch-id --stable` and skips the LLM call when that fingerprint matches the most recent managed review comment. This avoids token spend on rebases and other history-only changes.
- `publish_review_comment` uses `gh pr comment --edit-last --create-if-none`, so the comment is managed by the token identity used in the workflow.
- `context_limit_mode` reduces the amount of PR data sent to the LLM. Use `minimal` for models with very small context windows. This skips nothing but truncates more aggressively.
- `evidence_providers_file` accepts JSON only. It can be either an object with `providers: []` or a top-level provider array.
- Provider `command` accepts either a shell string (executed via `bash -lc`) or an argument array (invoked directly). **Argv arrays are strongly recommended** to avoid shell injection risks. Each provider can override `timeout_sec` and `max_output_bytes`.
- Provider output is appended to the review corpus under an `Evidence Providers` section.
- `tool_mode=plan_execute_once` adds a single planning-and-execution tool round before final review synthesis.
- Tool harness output is appended to the review corpus under `Tool Harness Findings`.
- Tool harness planning treats corpus content as untrusted data and uses strict tool/path/host allowlists with output redaction. The `run_command` tool does not execute arbitrary shell text; it accepts only named read-only command definitions (`git_status_short`, `git_diff_stat`, `git_diff_name_only`) and runs them argv-only without `bash -lc`.
- Evidence providers and tool harness are both disabled by default on cross-repository PRs (`*_enable_for_forks=false`).
- `gh_api` defaults to current-repo scope only. Use `tool_allowed_gh_api_repos` to allow specific upstream repos, or `*` to allow any repository while keeping the path denylist and endpoint allowlist active.
- For local models, reduce `tool_planning_max_context_bytes` and `tool_planning_max_tokens`, and increase `tool_planning_timeout_sec` as needed.
- Set `tool_failure_enforcement=true` to fail closed when tool harness planning fails or when every tool request fails.
- Use `tool_min_successful_requests` (for example `1`) to enforce a minimum successful tool-evidence threshold when the planner attempted tool requests.
- Model requests use `curl -q` so user-level `.curlrc` timeouts do not unexpectedly cancel long-running local model calls.

## Validation

This repo includes a local smoke test that exercises the action logic against a real GitHub pull request while using a mock OpenAI/Anthropic-compatible API server.

Run it with a specific PR:

```bash
PR_NUMBER=6757 tests/smoke_test.sh
```

Or let it pick the most recent open PR in `misospace/home-ops`:

```bash
tests/smoke_test.sh
```

The smoke test validates:

- GitHub PR data collection through `gh`
- review corpus assembly
- OpenAI-compatible `chat/completions` and Anthropic-compatible `messages` response parsing
- output parsing and action output generation

## Examples

Copyable workflows are included here:

- `examples/workflow-self-hosted.yml`
- `examples/workflow-cloud.yml`

## Version pinning and releases

The action is versioned via Git tags (e.g., `v1.0.18`). The examples in this README use `@v1` as a shorthand; in production workflows, pin to a specific version tag or commit SHA for reproducible runs:

```yaml
# Pin to a specific release tag (recommended)
- uses: misospace/pr-reviewer-action@v1.0.18

# Pin to a specific commit (most stable during development)
- uses: misospace/pr-reviewer-action@f838c5b49d72d11dd33cfee6e29b85a28b5aa8df # v1.0.18
```

### Self-review version pinning

This repository's own self-review workflow (`.github/workflows/ai-pr-review.yaml`) pins the action to a specific commit SHA rather than `@v1` or `@main`. This ensures the self-review process uses a known-good, tested version while new changes are developed on `main`. After a release is cut and tagged, the self-review workflow is updated to pin the new tag.

### Release cadence

Releases are cut when features or fixes are ready. The `v1.x.y` scheme follows semver:
- **Patch** (`y`): bug fixes and minor improvements
- **Minor** (`x`): new features, backward-compatible changes
- **Major** (`v1` → `v2`): breaking changes to inputs/outputs or behavior

To stay current, subscribe to [GitHub Releases](https://github.com/misospace/pr-reviewer-action/releases) or enable Renovate to track the `misospace/pr-reviewer-action` dependency.

## License

MIT

## Security

See `SECURITY.md` for threat model, controls, and operational guidance.
