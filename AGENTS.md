# Agents Guide: pr-reviewer-action

This is a GitHub Action that analyzes pull requests using OpenAI-compatible or Anthropic-compatible models (cloud or self-hosted) and optionally publishes a sticky PR comment with the review.

## What it does

The action collects rich PR context (diff, files, linked issues, version hints, image digests, repo impact/history, standards files), assembles a review corpus, sends it to an LLM via OpenAI `POST /chat/completions` or Anthropic `POST /messages`, parses the JSON verdict + markdown body, and optionally publishes or updates a managed PR comment.

## Key files

- **`action.yml`** - Action definition with all inputs/outputs and composite run steps
- **`scripts/run_review.sh`** - Main review orchestration script (collects context, builds corpus, calls model, enforces verdicts)
- **`scripts/check_review_needed.sh`** - Precheck: computes `git patch-id --stable` fingerprint and skips if unchanged since last managed comment
- **`scripts/default_system_prompt.txt`** - Bundled system prompt used when no override is provided
- **`scripts/run_evidence_providers.py`** - Runs user-defined evidence provider commands from a JSON config, parses severity/findings output
- **`scripts/run_tool_harness.py`** - Tool harness in `plan_execute_once` mode: model plans read-only tool requests (gh_api, read_file, web_fetch, git_grep), action executes them, appends results to corpus
- **`scripts/strip_metadata_markers.py`** - Strips internal metadata markers from model output before publishing (fixed in PR #47 / issue #33)
- **`scripts/image_digest_analysis.py`** - Analyzes image digests from the diff for provenance context
- **`tests/smoke_test.sh`** - Local smoke test against a real PR with mock OpenAI server
- **`tests/mock_openai_server.py`** - Mock API server used by the smoke test

## Architecture

```
check_review_needed.sh          → should_review + diff_fingerprint
run_review.sh                   → collects context → builds corpus → calls model → enforces verdicts
  ├─ gh pr view/diff/api        → PR metadata, files, linked issues
  ├─ URL fetching               → Linked sources from PR body (allowlisted hosts)
  ├─ image_digest_analysis.py   → Image digest provenance
  ├─ run_evidence_providers.py  → User-defined provider commands
  ├─ run_tool_harness.py        → Tool harness planning + execution
  └─ Model call with retries    → Primary model, fallback if needed
publish_review_comment         → sanitizes markdown → builds managed comment → publishes
  ├─ strip_metadata_markers.py  → Strips <!-- ai-pr-review-*:... --> from model output
  └─ gh pr comment              → Edit-last or create-if-none with metadata + review body
```

## Review corpus sections (in order)

1. Changed Manifest Context (Helm/K8s manifests)
2. PR Metadata (JSON from `gh pr view`)
3. Linked Issue Context (from Fixes/Closes references in PR body)
4. PR Files (truncated JSON with patches)
5. Version Hints from Diff
6. PR Diff (truncated)
7. Linked Sources (fetched URLs, GitHub releases/compare metadata)
8. Evidence Providers (user-defined command output)
9. Tool Harness Findings (planned + executed tool results)
10. Image Digest Provenance
11. Repository Impact Scan (git grep hits for extracted terms)
12. Repository History (git log context for extracted terms)
13. Repository Standards and Conventions (from CLAUDE.md, AGENTS.md, etc.)

## Running tests

```bash
# Run smoke test against a specific PR
PR_NUMBER=6757 tests/smoke_test.sh

# Let it pick the most recent open PR in misospace/pr-reviewer-action
tests/smoke_test.sh
```

The smoke test validates: GitHub PR data collection, corpus assembly, OpenAI/Anthropic response parsing, and tool harness request formatting.

## Important conventions

- All model calls use `curl -q` to avoid `.curlrc` timeouts interfering with local models
- Model responses are parsed by extracting JSON from markdown code blocks or scanning for the first valid JSON object
- Verdict must be `"approve"` or `"request_changes"` with a non-empty `review_markdown` string
- Context limit modes: `normal` (140k/70k/220k), `low` (80k/40k/120k), `minimal` (40k/20k/60k) — controls MAX_DIFF, MAX_FILES, MAX_CORPUS byte limits
- Evidence providers and tool harness are disabled by default on cross-repository PRs (`*_enable_for_forks=false`)
- Standards file resolution: explicit `standards_file` → first found from `standards_file_candidates` list (default: AGENTS.md, agents.md, CLAUDE.md, claude.md, .github/ai-review-rules.md, .github/ai-review-rules.txt). Candidates support glob patterns (e.g. `.agents/*.md`); first match wins.
- System prompt priority: inline `system_prompt` > file `system_prompt_file` > bundled default

## Inputs summary

Required: `github_token`, `ai_base_url`, `ai_model`
Optional but common: `ai_api_key`, `publish_review_comment`, `standards_file`, `context_limit_mode`, `evidence_providers_file`, `tool_mode`

## Outputs summary

- `verdict`: `"approve"` or `"request_changes"`
- `review_markdown`: Full markdown review body
- `analysis_engine`: Model and endpoint string (e.g. `qwen3-32b@http://llama-server.internal:8080/v1`)
- `should_review`: Whether a new LLM review was run
- `skip_reason`: Skip reason if skipped (e.g. `"diff-unchanged"`)
- `diff_fingerprint`: Stable fingerprint of the PR patch
