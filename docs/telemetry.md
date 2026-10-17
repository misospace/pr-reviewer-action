# Telemetry: the metadata marker and step summary

Every published review (comment or native review) carries an action-owned
HTML comment marker, `<!-- ai-pr-reviewer:{...} -->`, with a compact JSON
object. It is the seam between runs: the precheck reads it to decide whether
a diff-unchanged skip can carry the prior verdict forward, and it's the most
reliable place to pull review telemetry from across many PRs without
re-running anything.

The marker is positional (fixed key order, keys appended at the end as new
fields ship) and model output can never forge it — `stripReservedMarkers`
removes any `ai-pr-review-sha`/`ai-pr-review-fingerprint` marker a model
might emit before the action appends its own.

## Marker fields

Every key below is the literal JSON key in the marker.

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | number | Marker schema version (currently `1`). |
| `head_sha` | string | PR head SHA this review is bound to (`"unknown"` if absent). |
| `base_sha` | string | PR base SHA at review time. |
| `review_result` | string | `clean`, `findings`, `partial`, or `issues` — derived from the same still-open findings and coverage the published review shows. `partial` means the review's own coverage is incomplete (required checks, the tool-loop investigation, or an unverifiable requirement trace — see `incomplete_reason` for which); `verdict: approve` with this is **not** an approval — gate merges on both, never on the verdict alone. |
| `required_checks` | string, omitted | `complete` or `incomplete` — present only when required-check validation ran (omitted for `none`). |
| `review_route` | string, omitted | Model route used: `primary` or `escalated` (`smart` is a legacy value from pre-#965 markers; omitted for `legacy`). |
| `escalation_reason` | string array, omitted | Why an escalated route was taken (e.g. `primary_requested`). Omitted when empty. |
| `cache_hit_ratio` | number, omitted | Prompt-cache hit ratio for this review, `0.0`–`1.0`. As of v3.1.0 this is **cache reads divided by total prompt tokens** for the run (cached prompt tokens over total prompt tokens, rounded to 3 decimals; `0.0` when there were no prompt tokens to divide by). Omitted when unavailable. |
| `coverage` | string, omitted | `"partial"` when the #810 tool-loop investigation stopped on a budget with changed files or specialist leads it never read/resolved. Omitted for complete coverage. |
| `coverage_stop_reason` | string, omitted | The loop stop reason behind a `coverage: "partial"` value — one of the budget-stop reasons in [`docs/tool-loop.md`](tool-loop.md#stop-reasons-and-partial-coverage) (`max-rounds`, `tool-call-budget-exhausted`, `wall-clock-exceeded`). Omitted alongside `coverage`. |
| `incomplete_reason` | string, omitted | Why the review's coverage is incomplete: `execution` (the tool-loop or required-check coverage did not finish), `requirement_trace` (the review completed, but an in-scope requirement lacks verifiable enforcement/test evidence), or `both`. Omitted when coverage is complete. Added in #954 so a finished review with an unverified requirement is distinguishable from one that stopped early — `review_result` is `partial` for both. |
| `ci_state` | string, omitted | Folded external-CI conclusion at the reviewed head (`success`/`failure`/`pending`/`none`). Omitted when CI wasn't read. |
| `tool_budget` | number, omitted | The effective tool-call budget this run resolved (`resolveToolMaxRequests`'s result) — see [`docs/tool-loop.md`](tool-loop.md#tool-call-budget-tier-defaults-size-scaling). Omitted when no tool harness ran. |
| `tool_budget_source` | string, omitted | Which input won that budget: `primary-override`, `smart-override`, `explicit`, `tier-default`, or `size-scaled`. Omitted alongside `tool_budget`. |
| `tool_calls` | number, omitted | Tool calls the loop actually executed against that budget. Omitted alongside `tool_budget`. |
| `tool_rounds` | number, omitted | Rounds the loop actually used. Omitted when no tool harness ran or the loop reported no round count. |
| `max_rounds` | number, omitted | The resolved round cap the loop ran against for this run (see [`docs/tool-loop.md`](tool-loop.md#round-cap)). Omitted alongside `tool_rounds`. |
| `context_budget` | number, omitted | The loop's conversation budget in approximate tokens: past it, older tool results are compacted. 24,000 unless a context window is declared (see [Context limits](tool-loop.md#context-limits)). Omitted when no loop ran. |
| `context_peak` | number, omitted | The largest conversation the loop reached (approximate tokens). Close to `context_budget` means compaction was in play. Omitted alongside `context_budget`. |

Two more action-owned markers can follow on their own line, outside the
`ai-pr-reviewer:{...}` JSON: `<!-- ai-pr-review-sha:<sha> -->` (the head SHA,
kept for publication traceability) and
`<!-- ai-pr-review-fingerprint:<fp> -->` (the diff+config fingerprint the
skip-on-unchanged check reads).

## Action outputs related to telemetry

| Output | Meaning |
| --- | --- |
| `cache-hit-ratio` | Same value as the marker's `required_checks` key — empty when unavailable. |
| `tool-calls` | JSON array of the read-only tools the native tool harness executed, with each tool's name and status. |
| `review-result` | Same value as the marker's `review_result`. |
| `incomplete-reason` | Same value as the marker's `incomplete_reason` key (`none` when the run completed with complete coverage; omitted on a carried skip whose marker carries no reason). |
| `review-route` | Same value as the marker's `required_checks` key (`legacy` when the marker field is omitted). |
| `escalation-reason` | Same value as the marker's `required_checks` key, joined. |
| `required-checks` | Same value as the marker's `required_checks` key (`none` when omitted from the marker). |

## Step summary

The action writes an `### AI PR Review` table to the job's step summary.
Rows that always appear: Engine, Verdict (with source), Findings (with
blocker count), Required checks, Primary tools (executed/successful calls,
rounds, stop reason), Route, Budget, Final context, Diff bytes, Corpus bytes,
Prompt tokens, Completion tokens. Rows that appear only when relevant:
Requirement coverage, Smart tools, Native verdict, Tool budget (one entry per
tier that ran a harness: route, used/effective-max requests, budget source,
stop reason, requests left at stop), Deep review, Primary context, and
Cache hit ratio (omitted entirely when unavailable, rather than shown empty).

## Reading a marker

A published review's body starts with the sticky comment marker followed by
the metadata marker, e.g.:

```html
<!-- ai-pr-reviewer -->
<!-- ai-pr-reviewer:{"version":1,"head_sha":"a1b2c3d","base_sha":"9f8e7d6","review_result":"findings","tool_budget":32,"tool_budget_source":"tier-default","tool_calls":11,"tool_rounds":6,"max_rounds":32} -->
<!-- ai-pr-review-sha:a1b2c3d4e5f6... -->
```

(A smart-route run with a measured prompt-cache hit would also carry the
`review_route` and `cache_hit_ratio` keys right after `review_result`, e.g.
`"review_route":"smart","cache_hit_ratio":0.842`.)

Reading this marker: the review found open findings (not clean, not
partial — full coverage), and the native tool loop spent 11 of a 32-call
tier-default budget across 6 of up to 32 rounds.

## Grepping markers across PRs

`gh` can pull the marker out of recent review comments or reviews without
cloning anything. For example, to see which recent PRs hit a `partial`
coverage gap:

```bash
gh api "repos/OWNER/REPO/issues/comments?per_page=100" --paginate \
  --jq '.[].body' \
  | grep -oE 'ai-pr-reviewer:\{[^}]*\}' \
  | grep '"coverage":"partial"'
```

Or, to compare tool-budget provenance across a set of PRs (how often the
size-scaled default kicks in versus the tier default):

```bash
gh api "repos/OWNER/REPO/issues/comments?per_page=100" --paginate \
  --jq '.[].body' \
  | grep -o '"tool_budget_source":"[a-z-]*"' \
  | sort | uniq -c
```

For native PR reviews (`publish-mode: review_comment` /
`publish-mode: review_verdict`), use `gh api
repos/OWNER/REPO/pulls/NUMBER/reviews` instead — the marker lives in each
review's `body` field the same way.
