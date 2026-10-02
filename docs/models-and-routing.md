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

`ai-api-format` has a matching sibling for every model slot: `ai-fallback-api-format`, `ai-primary-api-format`, `ai-smart-api-format`. Each defaults to blank, which inherits `ai-api-format` — so a routed smart endpoint on a different provider format must set its own.

### Fallback model

`ai-fallback-*` configures an availability fallback, not an escalation target — it only catches the first-pass model's endpoint being unreachable or erroring out. That is the primary model, or the smart model when risk flags route the review to it directly:

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

## Fast/smart routing

`review-routing-mode: auto` sends boring PRs to a fast/local model and scary ones straight to a smarter one, based on the deterministic classification — before any review runs:

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

- `off` (default): preserves the existing primary/fallback behavior exactly; the `review-route` output reports `legacy`.
- `auto`: a PR whose `route_signals` (its `pr_kind` plus `risk_flags`) match `escalate-on-risk-flags` routes directly to the **smart** model; everything else routes to the **fast** (primary) model.
- `route_signals` excludes content-only pattern matches: a flag or kind that fired only because the diff *text* mentioned a pattern (e.g. `os.path`, `token`) doesn't route by itself — an actual changed filename, or a linked issue, has to back it. This keeps benign PRs on the fast model.
- The fast config defaults to the primary `ai-*` inputs. The smart config's endpoint/format/key also default to those same primary inputs, but the smart **model** is opt-in (`ai-smart-model`) — with no smart model configured, a risk match logs and stays on the fast model rather than failing.
- The chosen route is reported by the `review-route` output, the step summary, and the managed metadata marker. Routing config is part of the precheck fingerprint, so changing it forces a fresh review.

`escalate-on-risk-flags` default value:

```
linked_security_issue,linked_priority_p0,linked_priority_p1,auth_changes,public_route_changes,file_serving_changes,path_handling_changes,secret_handling_changes,db_or_migration_changes
```

## Escalation of insufficient fast reviews (#721)

In `auto` mode, a successful primary (fast) review can still be re-run on the smart model after the fact — but only when the **primary reviewer itself asks for it**. The primary model returns a structured `smart_review_requested` boolean (with a bounded `smart_review_reason`) in its verdict JSON; the action escalates only when that field is literally `true`. PR-controlled prose can't forge the request, malformed output is never treated as a request, and a smart review can never request another smart review.

The primary prompt asks the reviewer to request a second pass only when it believes one is materially necessary — e.g. it cannot confidently resolve a correctness/security question from the available evidence, or it identified a high-risk area it can't confidently disposition. It should not request one merely because the verdict is `request_changes`, because it wrote an Unknowns section, or because a tool failed.

A set of older heuristic triggers from `src/routing/escalation.ts` are **deprecated and inert** — they compute `reasons` for telemetry only and never gate a smart call:

- `fast_request_changes`, `fast_low_confidence`, `tool_or_evidence_blockers`, `incomplete_required_checks`, `tool_planning_failed`.
- The autonomous incomplete-requirement-coverage retry is removed entirely; unknown coverage stays visible in the coverage artifact and step summary, and the primary reviewer may fold it into its own `smart_review_requested` decision.

Unchanged: deterministic direct smart routing **before** the primary runs (`escalate-on-risk-flags`), first-pass failure (primary, or smart on a direct route) → fallback as an availability recovery (never an escalation target), and deterministic enforcement running independent of escalation.

Only the **final** review is published. If the smart model fails, the primary review publishes instead — escalation never turns into a failed run. `review-route` reports `escalated` and `escalation-reason` carries `primary_requested`; both land in the step summary, the managed metadata marker, and the published review's `_Analysis engine:_` line (`— routed smart (risk match: …)` vs `— escalated (…)` vs `— fallback (primary failed)` or `— fallback (smart failed)`), so you can tell a deliberate smart review from an escalation or an availability fallback at a glance. Worst case is two model calls per review; the unchanged-diff skip keeps that bounded across runs.
