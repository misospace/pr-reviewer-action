# Models and routing

Endpoint setup recipes, then fast/smart routing and escalation.

## Endpoint setup recipes

### OpenAI-compatible (cloud subscription)

Any OpenAI-compatible endpoint — including a cloud subscription key — works with the default `ai-api-format: openai`:

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

      - uses: misospace/pr-reviewer-action@v3
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          ai-base-url: https://api.openai.com/v1
          ai-model: gpt-4.1
          ai-api-key: ${{ secrets.OPENAI_API_KEY }}
          standards-file: CLAUDE.md
          publish-review-comment: "true"
```

### Anthropic-compatible via `ai-api-format`

Set `ai-api-format: anthropic` to post to `/messages` instead of `/chat/completions`. The action sends the `x-api-key` and `anthropic-version` headers, and parses only `content[]` blocks where `type == "text"` — non-text blocks such as `thinking` are ignored, so private reasoning is never copied into PR comments.

```yaml
- uses: misospace/pr-reviewer-action@v3
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-base-url: https://api.anthropic.com/v1
    ai-api-format: anthropic
    ai-model: claude-sonnet-4-5
    ai-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    ai-max-tokens: "8192"
    publish-review-comment: "true"
```

`ai-api-format` has a matching sibling for every model slot: `ai-fallback-api-format`, `ai-primary-api-format`, `ai-smart-api-format`, and `ai-specialist-api-format`. Each defaults to blank and inherits the primary `ai-api-format` unless that profile is active with its own format — so a model on a different provider format must set its own.

### Fallback model

`ai-fallback-*` configures an availability fallback, not an escalation target — it only catches the primary model's endpoint being unreachable or erroring out (the first pass is always primary under the #965 routing policy; smart runs only as the reviewer-requested rerun, whose failure publishes the primary review rather than falling back):

```yaml
- uses: misospace/pr-reviewer-action@v3
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-base-url: http://llama-server.internal:8080/v1
    ai-model: qwen3-32b
    ai-fallback-base-url: https://api.openai.com/v1
    ai-fallback-api-format: openai
    ai-fallback-model: gpt-4.1-mini
    ai-fallback-api-key: ${{ secrets.OPENAI_API_KEY }}
```

`ai-fallback-base-url`/`ai-fallback-api-format`/`ai-fallback-api-key` each default to the primary `ai-*` value when left blank; only `ai-fallback-model` has no default (an empty value means no fallback is configured).

## Primary-first routing (#965)

`review-routing-mode: auto` is the primary-first policy: every review starts on the primary model, and the smart model has exactly one entrance — a completed primary verdict that explicitly requests it:

```yaml
- uses: misospace/pr-reviewer-action@v3
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-base-url: http://llama-server.internal:8080/v1   # fast (default = primary)
    ai-model: qwen3-32b
    ai-smart-base-url: https://api.anthropic.com/v1
    ai-smart-api-format: anthropic
    ai-smart-model: claude-sonnet-4-6
    ai-smart-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    review-routing-mode: auto
```

- `off` (default): preserves legacy behavior; the `ai-*` model configuration is used as-is, the `review-route` output reports `legacy`, and no profile binding or post-primary escalation happens.
- `auto`: the initial review **always** runs on the primary model — deterministic classification never selects the smart model before any review runs (#965). Deep-review specialists inherit the primary profile. The smart model is reached only when the completed primary verdict sets `smart_review_requested: true` (#721), bounded to one rerun.
- Deterministic classification (`route_signals` — the `pr_kind` plus file-backed risk flags) remains available for specialist role selection, required-check validation, and telemetry. It never routes the model. Since #965 the `escalate-on-risk-flags` input no longer exists: there is no pre-primary smart route to configure.
- The fast config defaults to the primary `ai-*` inputs. The smart config's endpoint/format/key also default to those same primary inputs, but the smart **model** is opt-in (`ai-smart-model`) — with no smart model configured, an escalation request logs and the primary review publishes rather than failing.
- The chosen route is reported by the `review-route` output, the step summary, and the managed metadata marker. Routing config is part of the precheck fingerprint, so changing it forces a fresh review.

## Specialist profile overrides (#966)

Deep-review specialists keep inheriting the primary route unless `ai-specialist-model` is set. That model activates a shared specialist profile; blank endpoint, format, and key values inherit from the primary route. The API format must be `openai` or `anthropic`; an invalid value disables the whole specialist profile and emits a warning, while role-only overrides still use the primary transport.

```yaml
- uses: misospace/pr-reviewer-action@v3
  with:
    ai-specialist-model: qwen3-32b
    ai-specialist-base-url: http://llama-server.internal:8080/v1
    ai-specialist-api-key: ${{ secrets.LOCAL_MODEL_KEY }}
    ai-specialist-correctness-model: qwen3-coder
    ai-specialist-tests-model: qwen3-14b
```

Precedence is per role: role override, then `ai-specialist-model`, then primary model. Endpoint/format/key selection remains shared across roles; per-role endpoints are a follow-up. Overrides are model selection only and do not change prompts, selection, advisory authority, concurrency, or retry behavior. `combined_scout` issues one shared call, so it ignores role model overrides with a warning and uses the specialist-profile model (or primary if there is no profile). These trusted values come from workflow inputs, not repository config.

## Escalation of insufficient primary reviews (#721)

In `auto` mode, a successful primary (fast) review can still be re-run on the smart model after the fact — but only when the **primary reviewer itself asks for it**. The primary model returns a structured `smart_review_requested` boolean (with a bounded `smart_review_reason`) in its verdict JSON; the action escalates only when that field is literally `true`. PR-controlled prose can't forge the request, malformed output is never treated as a request, and a smart review can never request another smart review.

The primary prompt asks the reviewer to request a second pass only when it believes one is materially necessary — e.g. it cannot confidently resolve a correctness/security question from the available evidence, or it identified a high-risk area it can't confidently disposition. It should not request one merely because the verdict is `request_changes`, because it wrote an Unknowns section, or because a tool failed.

A set of older heuristic triggers from `src/routing/escalation.ts` are **deprecated and inert** — they compute `reasons` for telemetry only and never gate a smart call:

- `fast_request_changes`, `fast_low_confidence`, `tool_or_evidence_blockers`, `incomplete_required_checks`, `tool_planning_failed`.
- The autonomous incomplete-requirement-coverage retry is removed entirely; unknown coverage stays visible in the coverage artifact and step summary, and the primary reviewer may fold it into its own `smart_review_requested` decision.

Fallback remains availability recovery, never an escalation target, and deterministic enforcement runs independent of escalation.

Only the **final** review is published. If the smart model fails, the primary review publishes instead — escalation never turns into a failed run. `review-route` reports `escalated` and `escalation-reason` carries `primary_requested`; both land in the step summary, the managed metadata marker, and the published review's `_Analysis engine:_` line (`— primary route` vs `— escalated (…)` vs `— fallback (primary failed)`), so you can tell a deliberate escalation from an availability fallback at a glance. Worst case is two model calls per review; the unchanged-diff skip keeps that bounded across runs.
