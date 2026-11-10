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
| `coverage` | string, omitted | `"partial"` when the review's tool-loop coverage is an unconfirmed gap: the #810 loop stopped on a budget with changed files or specialist leads it never read/resolved, or (#899) the loop ran but left its harness artifact unreadable and coverage is fail-closed incomplete. `"unknown"` is the standalone `publish` CLI's #873/#838 fail-closed value: no run artifact could confirm coverage at all, so no stop reason exists to report. Omitted for confirmed complete coverage. |
| `coverage_stop_reason` | string, omitted | The loop stop reason behind a `coverage: "partial"` value — one of the budget-stop reasons in [`docs/tool-loop.md`](tool-loop.md#stop-reasons-and-partial-coverage) (`max-rounds`, `tool-call-budget-exhausted`, `wall-clock-exceeded`, `wall-clock-verdict-reserve`), or `harness-unreadable` when the loop ran but its harness artifact was unreadable (#899 fail-closed). `coverage: "unknown"` carries no stop reason. Omitted alongside `coverage`. |
| `incomplete_reason` | string, omitted | Why the review's coverage is incomplete: `execution` (the tool-loop or required-check coverage did not finish), `requirement_trace` (the review completed, but an in-scope requirement lacks verifiable enforcement/test evidence), or `both`. Omitted when coverage is complete. Added in #954 so a finished review with an unverified requirement is distinguishable from one that stopped early — `review_result` is `partial` for both. |
| `ci_state` | string, omitted | Folded external-CI conclusion at the reviewed head (`success`/`failure`/`pending`/`none`). Omitted when CI wasn't read. |
| `tool_budget` | number, omitted | The effective tool-call ceiling for this run. It starts from `resolveToolMaxRequests`; when primary requirement-trace is active, the bounded four-request trace-closure allowance is included so `tool_calls` never appears to exceed the published ceiling. See [`docs/tool-loop.md`](tool-loop.md#tool-call-budget-tier-defaults-size-scaling). Omitted when no tool harness ran. |
| `tool_budget_source` | string, omitted | Which input won the ordinary exploration ceiling before any bounded trace-closure allowance: `primary-override`, `smart-override`, `explicit`, `tier-default`, or `size-scaled`. Omitted alongside `tool_budget`. |
| `tool_calls` | number, omitted | Tool calls the loop actually EXECUTED against that budget (#1597: attempted executions — the same population as the run log's "N tool call(s) executed" line and the `tool_calls` trace; executor errors included). Before #1597 this key carried the successful-only count; that number is now published as `tool_calls_successful`. A budget stop reads `tool_calls == tool_budget`. Omitted alongside `tool_budget`. |
| `tool_calls_issued` | number, omitted | All tool calls the model asked for: executed + refused + deduplicated (#1597). Omitted when the harness artifact carries no partition fields (pre-#1597 shape, or no tool harness ran). |
| `tool_calls_successful` | number, omitted | Executed calls whose executor answered `ok` — the historical value of `tool_calls` (#1597). Omitted alongside `tool_calls_issued`. |
| `tool_calls_refused` | number, omitted | Calls the loop refused without executing them: invalid arguments, over-budget, or reserve-window refusals (#1597). Omitted alongside `tool_calls_issued`. |
| `tool_calls_deduplicated` | number, omitted | Calls answered with the duplicate-note without running (#1597). Omitted alongside `tool_calls_issued`. |
| `tool_rounds` | number, omitted | Rounds the loop actually used. Omitted when no tool harness ran or the loop reported no round count. |
| `max_rounds` | number, omitted | The resolved round cap the loop ran against for this run (see [`docs/tool-loop.md`](tool-loop.md#round-cap)). Omitted alongside `tool_rounds`. |
| `verdict_reserve_sec` | number, omitted | The wall-clock slice the native loop reserved for the closing in-conversation verdict this run (`verdictWallClockReserveSec`'s deterministic result — see [`docs/tool-loop.md`](tool-loop.md#verdict-wall-clock-reserve)). `0` when the reserve is off; omitted when no tool harness ran. |
| `context_budget` | number, omitted | The loop's conversation budget in approximate tokens: past it, older tool results are compacted. 24,000 unless a context window is declared (see [Context limits](tool-loop.md#context-limits)). Omitted when no loop ran. |
| `context_peak` | number, omitted | The largest conversation the loop reached (approximate tokens). Close to `context_budget` means compaction was in play. Omitted alongside `context_budget`. |
| `tool_stop_reason` | string, omitted | The tool loop's own stop reason for the route the marker was built from — one of the values in [`docs/tool-loop.md`](tool-loop.md#stop-reasons-and-partial-coverage) (`model-stopped`, `no-tool-calls`, `max-rounds`, `tool-call-budget-exhausted`, `wall-clock-exceeded`, `wall-clock-verdict-reserve`, `request-error`), or `harness-abort` when the harness aborted before the loop ran. Recorded on every harness run: unlike `coverage_stop_reason` (only on a confirmed coverage gap), a budget stop with complete coverage is recorded too, so budget-exhaustion rates are measurable per `tool_budget_source`. Omitted when no tool harness reported one. |
| `confidence_status` | string, omitted | The independent verifier's status: `scored` or `unscored`. Omitted when the verifier did not run. |
| `confidence_score` | number, omitted | The independent verifier's score, `0` to `5`. Omitted unless the status is `scored`. |
| `confidence_cause` | string, omitted | Why the verifier did not score: an action-owned token such as `timeout`, `http_429`, or `incomplete_review`. Omitted for a scored run and when the verifier did not run. |
| `confidence_latency_ms` | number, omitted | How long the verifier's provider call took, in milliseconds: the time the provider took to answer a request that reached it. Omitted when no such call happened — a refusal before the wire, a request that never left the machine (a connect timeout or a cancellation), or a transport failure before a request existed. |
| `confidence_prompt_tokens` | number, omitted | The prompt tokens the verifier's call used. On the Anthropic wire this is the billed prompt: the reported `input_tokens` plus the cache tokens the provider reports beside it. Omitted when the provider reported no count. |
| `confidence_completion_tokens` | number, omitted | The completion tokens the verifier's call used. Omitted when the provider reported no count. |
| `confidence_total_tokens` | number, omitted | The total tokens the verifier's call used: the provider's own `total_tokens` when it reported one, otherwise the prompt plus completion counts. Omitted when the provider reported no count. |

Two more action-owned markers can follow on their own line, outside the
`ai-pr-reviewer:{...}` JSON: `<!-- ai-pr-review-sha:<sha> -->` (the head SHA,
kept for publication traceability) and
`<!-- ai-pr-review-fingerprint:<fp> -->` (the diff+config fingerprint the
skip-on-unchanged check reads).

### Tool-call partitions (#1597)

The loop counts each issued call exactly once, at one settled snapshot —
the loop's own disposition pass — and every published surface reads that
snapshot, never a re-derivation: the harness artifact's top-level
`planned_request_count` / `executed_request_count` /
`successful_request_count` / `refused_request_count` /
`deduplicated_request_count`, the artifact's `tool_loop_telemetry.usage`
block (`tool_calls_issued` / `tool_calls_executed` /
`tool_calls_successful` / `tool_calls_refused` /
`tool_calls_deduplicated`), the step-summary rows, and the marker keys
above. The invariants are `issued = executed + refused + deduplicated` and
`successful <= executed`. Counts are never synthesized from message counts
or model claims: a surface missing a partition (a pre-#1597 artifact, a
harness that aborted before the loop) omits the key instead of guessing a
number. The #1145 trace-gap repair continuation folds its own dispositions
into the same counts, so a repaired run stays internally consistent with
its `tool_stop_reason`.

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

Or, to compare budget-exhaustion rates by provenance (the #847 measurement —
`tool_stop_reason` rides every harness run, so budget stops that left
nothing unread are counted, not just the `coverage: "partial"` ones):

```bash
gh api "repos/OWNER/REPO/issues/comments?per_page=100" --paginate \
  --jq '.[].body' \
  | grep -oE '"tool_budget_source":"[a-z-]*"[^}]*"tool_stop_reason":"[a-z-]*"' \
  | sort | uniq -c
```

For native PR reviews (`publish-mode: review_comment` /
`publish-mode: review_verdict` / `publish-mode: review_blockers`), use `gh api
repos/OWNER/REPO/pulls/NUMBER/reviews` instead — the marker lives in each
review's `body` field the same way.

## Native-loop round telemetry

The native tool loop writes one record per model turn. The records live in
`tool_loop_telemetry.rounds` of the harness artifact (`tool-harness.json`,
and `tool-harness.smart.json` for the escalated tier). The closing verdict
turn has its own record in `tool_loop_telemetry.verdict`. The repair
continuation writes its records to `tool_loop_telemetry.repair_rounds`.

Every field is a number, a boolean, or a short stop reason. The records never
carry prompt text, response text, tool arguments, tool results, or
credentials.

| Field | Meaning |
| --- | --- |
| `round` | The model turn number, counted from 1. |
| `model_sec` | The seconds the turn waited for the answer. The value includes a retry that the turn made. |
| `first_event_sec` | The seconds from the request to the first byte of the answer. The value includes the connection time, the wait for the provider, and the prefill. |
| `ttft_sec` | The seconds from the request to the first content event. This is the time to the first token. The value is null when the answer did not stream. |
| `decode_tokens_per_sec` | The completion tokens per second after the first content event. The value is null when the answer did not stream, or when the provider reported no completion tokens. |
| `prompt_tokens` | The prompt tokens the provider reported for the turn. |
| `completion_tokens` | The completion tokens the provider reported for the turn. |
| `cached_tokens` | The prompt tokens the provider served from its cache. |
| `cache_write_tokens` | The prompt tokens the provider wrote into its cache. |
| `uncached_prompt_tokens` | The prompt tokens the provider did not serve from its cache. |
| `attempts` | The number of model calls the turn made. This is a count, not a measurement. The value is 0 when the record carries no count. The value is 2 when a streamed answer was unusable and the turn called the provider again without streaming. |
| `wire_calls` | The number of HTTP requests the turn made. This is a count, not a measurement. The value is 0 when the record carries no count. The value counts the retries that the transport made. |
| `finish_reason` | The provider's stop reason for the accepted attempt. The value is reduced to a short token, so a provider cannot put free text in the artifact. |
| `streamed_fallback` | True when a streamed answer was unusable and the turn called the provider again without streaming. |
| `tools_requested` | The tool calls the model asked for in the turn. |
| `tools_executed` | The tool calls the turn ran. |
| `tools_refused` | The tool calls the turn refused, because they were over budget or had invalid arguments. |
| `tools_deduplicated` | The tool calls the turn answered from the dedup note without running them. |
| `tool_elapsed_sec` | The seconds the tool calls of the turn took. |
| `requests_remaining` | The tool calls the turn left in the budget. |
| `rounds_remaining` | The model turns the turn left in the budget. |
| `wall_clock_remaining_sec` | The seconds the turn left in the wall clock budget. |

A null token count means that the provider reported no count. The loop never
estimates a token count from elapsed time. The verdict record carries the
same fields, except that it has no round number and no tool counts.

The verdict record's token counts are the billed sums over the turn's
attempts. Every attempt of the turn is added into them. Its timing fields
(`ttft_sec`, `first_event_sec`, `decode_tokens_per_sec`) describe the
accepted attempt only. A duration belongs to one attempt.

### Cache accounting on the Anthropic wire

The Anthropic wire format reports the cache counters beside the input
tokens, so the prompt total adds them: `prompt_tokens` is the input tokens
plus the cache reads plus the cache writes. This is the same accounting that
the marker's cache hit ratio uses. The OpenAI wire format already counts the
cached tokens inside `prompt_tokens`, so the total does not add them again.

### Reading the counters off the wire

The two wire formats report their counters differently, so the Action reads
them differently.

On the OpenAI wire the Action adds up the usage counts of every chunk that
carries them. Most OpenAI-compatible providers report the usage once, at
the end of the stream, so the sum is that single report.

On the Anthropic wire the Action reads the counters per field. A streamed
Anthropic answer can report its counters in more than one event. A field
takes the value of its last non-zero report. Anthropic's counters are
cumulative and never decrease, so a zero report that follows a non-zero one
is a placeholder and never replaces the real count. A field that was only
ever reported as zero keeps its zero. A field that was never reported stays
unreported.

The loop therefore never counts one turn twice, and it never keeps a
placeholder count from the first event when a later event reports the real
one.
