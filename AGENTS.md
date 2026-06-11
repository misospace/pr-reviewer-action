# Agents Guide: pr-reviewer-action

This is a GitHub Action that analyzes pull requests using OpenAI-compatible or Anthropic-compatible models (cloud or self-hosted) and publishes the review as a sticky PR comment or a native GitHub review.

## What it does

The action collects rich PR context (diff, files, linked issues, version hints, image digests, repo impact/history, standards files), runs a deterministic rule-based classification (PR kind, risk flags, required checks), assembles a review corpus, routes the review to a fast or smart model (optional), sends it to an LLM via OpenAI `POST /chat/completions` or Anthropic `POST /messages`, parses the JSON verdict + markdown body + optional structured findings, validates/enforces the result (required checks, findings severity gating, carried-forward findings, evidence/tool enforcement), and publishes via one of three modes (`comment`, `review_comment`, `review_verdict`).

## Key files

### Action definition and orchestration

- **`action.yml`** — Action definition with all inputs/outputs and composite run steps (precheck → CI wait → review → publish). The publish steps live inline in this file using helpers from `scripts/publish_helpers.sh`.
- **`scripts/check_review_needed.sh`** — Precheck: computes `git patch-id --stable` fingerprint, decides full vs. incremental scope, and skips if unchanged since last managed comment
- **`scripts/wait_for_ci.sh`** — Optional CI gating: polls commit status until checks reach a terminal state (`ci_status_check=true`)
- **`scripts/run_review.sh`** — Main review orchestration script (collects context, builds corpus, classifies, routes, calls model, validates and enforces verdicts)
- **`scripts/model_call.sh`** — Shared model-call layer: request building, streaming/SSE handling, retries, error-body preservation for both API formats
- **`scripts/default_system_prompt.txt`** — Bundled system prompt used when no override is provided

### Python package (`pr_reviewer/`)

- **`classifier.py`** — Deterministic PR classification: `pr_kind`, `risk_flags`, `must_check` checklist (no model calls)
- **`completeness.py`** — Required-check completeness validation: keyword-matches `review_markdown` against `must_check` items
- **`enforcement.py`** — Verdict policy (`model` / `findings_severity_gated`), findings normalization, evidence/tool enforcement; records `verdict_source`
- **`escalation.py`** — Post-hoc escalation triggers for fast reviews (request_changes, low confidence, incomplete checks, blockers, dirty baseline)
- **`carry_forward.py`** — Carried-forward open findings for incremental reviews; surviving blockers force `request_changes` (`verdict_source: carry_forward`)
- **`metadata.py`** — Managed metadata marker (fingerprint, scope, open findings) embedded in published comments
- **`github_context.py`** — PR metadata/linked-issue context helpers
- **`response_parser.py`** — Tolerant model-output parsing (JSON in fences/prose, verdict + findings extraction)
- **`sse_reassembler.py`** — Reassembles streamed SSE responses into complete bodies

### Publishing and output hygiene

- **`scripts/publish_helpers.sh`** — Shared publish functions: sanitize, metadata marker build, native review cleanup, finding-thread resolution
- **`scripts/sanitize_review_markdown.py`** — Neutralizes upstream GitHub auto-links (PR/issue/commit URLs, `owner/repo#123`, bare `#123`) in review output
- **`scripts/strip_metadata_markers.py`** — Strips reserved `<!-- ai-pr-review-*:... -->` markers from model output before publishing
- **`scripts/redact.py`** — Shared secret-redaction pipeline applied to tool and evidence-provider output
- **`scripts/build_review_comments.py`** — Builds line-anchored inline review comments from structured findings, validated against the PR diff
- **`scripts/resolve_finding_threads.py`** — Resolves/replies on existing finding threads by content fingerprint on re-review
- **`scripts/strip_source_text.py`** — Strips fetched source text where needed for corpus hygiene

### Enrichment

- **`scripts/run_evidence_providers.py`** — Runs user-defined evidence provider commands from a JSON config, parses severity/findings output
- **`scripts/run_tool_harness.py`** — Tool harness (`plan_execute_once` and `plan_execute_loop`): model plans read-only tool requests (`gh_api`, `read_file`, `web_fetch`, `git_grep`, named-only `run_command`), action executes them, appends results to corpus
- **`scripts/image_digest_analysis.py`** — Analyzes image digests from the diff for provenance context

### Tests

- **`tests/smoke_test.sh`** — Local smoke test against a real PR with a mock OpenAI/Anthropic server
- **`tests/mock_openai_server.py`** — Mock API server used by the smoke test
- **`tests/test_*.py`** — pytest suite (run in CI via `pytest tests/`)
- **`tests/test_*.sh`** — shell-based behavior tests for action scripts

## Architecture

```
check_review_needed.sh          → should_review + diff_fingerprint + effective scope (full/incremental)
wait_for_ci.sh (optional)       → block until CI checks are terminal
run_review.sh                   → collects context → classifies → builds corpus → routes → calls model → validates/enforces
  ├─ gh pr view/diff/api        → PR metadata, files, linked issues
  ├─ pr_reviewer.classifier     → pr_kind, risk_flags, must_check (rule-based, no model)
  ├─ URL fetching               → Linked sources from PR body (allowlisted hosts)
  ├─ image_digest_analysis.py   → Image digest provenance
  ├─ run_evidence_providers.py  → User-defined provider commands
  ├─ run_tool_harness.py        → Tool harness planning + execution (once or loop)
  ├─ model_call.sh              → Fast/smart routing, retries, streaming, fallback
  └─ pr_reviewer.{completeness,enforcement,escalation,carry_forward}
                                 → required-check validation, verdict policy, escalation, carried findings
publish (action.yml steps)      → sanitize markdown → strip markers → build managed body → publish
  ├─ publish_mode=comment        → gh pr comment --edit-last --create-if-none (sticky)
  ├─ publish_mode=review_comment → sticky comment + optional inline-findings COMMENT review
  └─ publish_mode=review_verdict → native approve/request_changes (guardrailed) + inline comments
     ├─ cleanup_native_reviews   → dismiss/stub previous managed reviews
     └─ resolve_finding_threads  → resolve or reply on existing finding threads
```

## Review corpus sections (in order)

1. Changed Manifest Context (Helm/K8s manifests)
2. PR Metadata (JSON from `gh pr view`)
3. PR Classification (deterministic classifier output)
4. Incremental Review Delta + Carried-Forward Open Findings (incremental scope only)
5. Linked Issue Context (from Fixes/Closes references in PR body)
6. PR Files (truncated JSON with patches)
7. Version Hints from Diff
8. PR Diff (truncated)
9. Tool Harness Findings (planned + executed tool results)
10. Evidence Providers (user-defined command output)
11. Image Digest Provenance
12. Linked Sources (fetched URLs, GitHub releases/compare metadata)
13. Repository Impact Scan (git grep hits for extracted terms)
14. Repository History (git log context for extracted terms)
15. Repository Standards and Conventions (from AGENTS.md, CLAUDE.md, etc.)

Note: `MAX_CORPUS` truncation applies to sections 1–14; the standards section is always preserved in full.

## Running tests

```bash
# Python unit tests (what CI runs)
pytest tests/ -v --tb=short

# Shell behavior tests are standalone, e.g.
tests/test_check_review_needed.sh

# Smoke test against a specific PR
PR_NUMBER=6757 tests/smoke_test.sh

# Let it pick the most recent open PR in misospace/pr-reviewer-action
tests/smoke_test.sh
```

The smoke test validates: GitHub PR data collection, corpus assembly, OpenAI/Anthropic response parsing, and tool harness request formatting.

## Important conventions

- All model calls use `curl -q` to avoid `.curlrc` timeouts interfering with local models
- Model responses are parsed by extracting JSON from markdown code blocks or scanning for the first valid JSON object (`pr_reviewer/response_parser.py`)
- Verdict must be `"approve"` or `"request_changes"` with a non-empty `review_markdown` string; an optional `findings` array is normalized (severities mapped to `blocker`/`major`/`minor`/`info`, malformed entries dropped)
- Context limit modes: `normal` (140k/70k/220k), `low` (80k/40k/120k), `minimal` (40k/20k/60k) — controls MAX_DIFF, MAX_FILES, MAX_CORPUS byte limits. `model_context_tokens` overrides these by deriving budgets from the real context window
- Evidence providers and tool harness are disabled by default on cross-repository PRs (`*_enable_for_forks=false`)
- Native approvals are off by default (`allow_approve=false`); fork approvals additionally require `approve_forks=true`
- Standards file resolution: explicit `standards_file` → first found from `standards_file_candidates` list (default: AGENTS.md, agents.md, CLAUDE.md, claude.md, .github/ai-review-rules.md, .github/ai-review-rules.txt). Candidates support glob patterns (e.g. `.agents/*.md`); first match wins.
- System prompt priority: inline `system_prompt` > file `system_prompt_file` > bundled default
- Reserved metadata markers (`<!-- ai-pr-review-fingerprint:... -->`, `<!-- ai-pr-review-sha:... -->`) are stripped from model output before publishing; the precheck reads only the first occurrence of each
- The `run_command` tool never executes model-supplied shell text — only named argv definitions from a fixed read-only catalog (`git_status_short`, `git_diff_stat`, `git_diff_name_only`)
- Versioning: `v1.x.y` semver tags; feature releases stay on `1.2.x` (`v1.3.0` is reserved for the tool-calling milestone, issue #197)

## Inputs summary

Required: `github_token`, `ai_base_url`, `ai_model`
Optional but common: `ai_api_key`, `publish_review_comment`, `publish_mode`, `standards_file`, `model_context_tokens`, `ai_response_format`, `review_routing_mode`, `evidence_providers_file`, `tool_mode`

See `action.yml` (the source of truth) or the README's grouped input tables for the full list.

## Outputs summary

- `verdict`: `"approve"` or `"request_changes"`
- `verdict_source`: `"model"`, `"findings"`, or `"carry_forward"`
- `required_checks`: `"complete"`, `"incomplete"`, or `"none"`
- `review_route` / `escalation_reason`: routing outcome (`legacy`/`fast`/`smart`/`escalated`) and trigger names
- `findings`: normalized structured findings as a JSON array
- `review_markdown`: Full markdown review body
- `analysis_engine`: Model and endpoint string (e.g. `qwen3-32b@http://llama-server.internal:8080/v1`)
- `should_review` / `skip_reason` / `diff_fingerprint`: precheck results
- `ci_status_skipped` / `ci_status_final`: CI gating results
- `effective_review_scope` / `previous_head_sha` / `baseline_clean`: incremental-review state
