# Migrating from v2 to v3

The v3 public Action API uses kebab-case IDs. The canonical, machine-readable
contract is [`../contracts/action-v3.yml`](../contracts/action-v3.yml). This
contract documents the future API; the production `action.yml` remains on the
v2 snake_case IDs until the atomic cutover in #681. Do not use v3 IDs before
that cutover.

## Retained inputs

| v2 input | v3 input |
| --- | --- |
| `github_token` | `github-token` |
| `repo` | `repo` |
| `pr_number` | `pr-number` |
| `ai_base_url` | `ai-base-url` |
| `ai_api_format` | `ai-api-format` |
| `ai_model` | `ai-model` |
| `ai_api_key` | `ai-api-key` |
| `ai_max_tokens` | `ai-max-tokens` |
| `ai_temperature` | `ai-temperature` |
| `ai_response_format` | `ai-response-format` |
| `ai_tokens_param` | `ai-tokens-param` |
| `anthropic_version` | `anthropic-version` |
| `ai_fallback_base_url` | `ai-fallback-base-url` |
| `ai_fallback_api_format` | `ai-fallback-api-format` |
| `ai_fallback_model` | `ai-fallback-model` |
| `ai_fallback_api_key` | `ai-fallback-api-key` |
| `ai_primary_retries` | `ai-primary-retries` |
| `ai_primary_retry_delay_sec` | `ai-primary-retry-delay-sec` |
| `on_model_failure` | `on-model-failure` |
| `fail_on_request_changes` | `fail-on-request-changes` |
| `verdict_policy` | `verdict-policy` |
| `non_blocking_finding_categories` | `non-blocking-finding-categories` |
| `inline_findings` | `inline-findings` |
| `inline_findings_max` | `inline-findings-max` |
| `validate_required_checks` | `validate-required-checks` |
| `required_check_validation_mode` | `required-check-validation-mode` |
| `review_routing_mode` | `review-routing-mode` |
| `ai_primary_model` | `ai-primary-model` |
| `ai_primary_base_url` | `ai-primary-base-url` |
| `ai_primary_api_format` | `ai-primary-api-format` |
| `ai_primary_api_key` | `ai-primary-api-key` |
| `ai_smart_model` | `ai-smart-model` |
| `ai_smart_base_url` | `ai-smart-base-url` |
| `ai_smart_api_format` | `ai-smart-api-format` |
| `ai_smart_api_key` | `ai-smart-api-key` |
| `escalate_on_risk_flags` | `escalate-on-risk-flags` |
| `ai_stream` | `ai-stream` |
| `ai_fallback_stream` | `ai-fallback-stream` |
| `allowed_source_hosts` | `allowed-source-hosts` |
| `related_code_context` | `related-code-context` |
| `related_code_max_bytes` | `related-code-max-bytes` |
| `linear_api_key` | `linear-api-key` |
| `linear_issue_prefixes` | `linear-issue-prefixes` |
| `linear_issue_timeout_sec` | `linear-issue-timeout-sec` |
| `linear_enable_for_forks` | `linear-enable-for-forks` |
| `system_prompt` | `system-prompt` |
| `system_prompt_file` | `system-prompt-file` |
| `system_prompt_mode` | `system-prompt-mode` |
| `review_verbosity` | `review-verbosity` |
| `standards_file` | `standards-file` |
| `standards_file_candidates` | `standards-file-candidates` |
| `publish_review_comment` | `publish-review-comment` |
| `publish_mode` | `publish-mode` |
| `allow_approve` | `allow-approve` |
| `allow_repo_policy_overrides` | `allow-repo-policy-overrides` |
| `approve_forks` | `approve-forks` |
| `cleanup_previous_native_reviews` | `cleanup-previous-native-reviews` |
| `upstream_link_mode` | `upstream-link-mode` |
| `context_limit_mode` | `context-limit-mode` |
| `model_context_tokens` | `model-context-tokens` |
| `primary_model_context_tokens` | `primary-model-context-tokens` |
| `smart_model_context_tokens` | `smart-model-context-tokens` |
| `primary_request_shape` | `primary-request-shape` |
| `smart_request_shape` | `smart-request-shape` |
| `repo_map_context` | `repo-map-context` |
| `repo_map_max_bytes` | `repo-map-max-bytes` |
| `pr_thread_context` | `pr-thread-context` |
| `pr_thread_max_bytes` | `pr-thread-max-bytes` |
| `review_threads_context` | `review-threads-context` |
| `review_threads_max_bytes` | `review-threads-max-bytes` |
| `deep_review` | `deep-review` |
| `deep_review_timeout_sec` | `deep-review-timeout-sec` |
| `deep_review_max_tokens` | `deep-review-max-tokens` |
| `deep_review_corpus_max_bytes` | `deep-review-corpus-max-bytes` |
| `enrichment_budget_sec` | `enrichment-budget-sec` |
| `image_digest_budget_sec` | `image-digest-budget-sec` |
| `evidence_providers_file` | `evidence-providers-file` |
| `sarif_files` | `sarif-files` |
| `sarif_max_findings` | `sarif-max-findings` |
| `evidence_provider_timeout_sec` | `evidence-provider-timeout-sec` |
| `evidence_provider_max_output_bytes` | `evidence-provider-max-output-bytes` |
| `evidence_provider_parallelism` | `evidence-provider-parallelism` |
| `evidence_blocker_enforcement` | `evidence-blocker-enforcement` |
| `evidence_enable_for_forks` | `evidence-enable-for-forks` |
| `tool_mode` | `tool-mode` |
| `tool_loop_wall_clock_sec` | `tool-loop-wall-clock-sec` |
| `tool_loop_summarize` | `tool-loop-summarize` |
| `tool_loop_summarize_max_tokens` | `tool-loop-summarize-max-tokens` |
| `tool_max_requests` | `tool-max-requests` |
| `primary_tool_max_requests` | `primary-tool-max-requests` |
| `smart_tool_max_requests` | `smart-tool-max-requests` |
| `tool_max_rounds` | `tool-max-rounds` |
| `tool_turn_timeout_sec` | `tool-turn-timeout-sec` |
| `tool_corpus_max_bytes` | `tool-corpus-max-bytes` |
| `tool_max_tokens_per_turn` | `tool-max-tokens-per-turn` |
| `tool_max_response_bytes` | `tool-max-response-bytes` |
| `tool_allowed_gh_api_repos` | `tool-allowed-gh-api-repos` |
| `tool_request_timeout_sec` | `tool-request-timeout-sec` |
| `search_url` | `search-url` |
| `tool_max_search_results` | `tool-max-search-results` |
| `tool_failure_enforcement` | `tool-failure-enforcement` |
| `tool_min_successful_requests` | `tool-min-successful-requests` |
| `tool_enable_for_forks` | `tool-enable-for-forks` |
| `tool_mcp_servers` | `tool-mcp-servers` |
| `tool_mcp_token` | `tool-mcp-token` |
| `tool_mcp_name_prefixes` | `tool-mcp-name-prefixes` |
| `ai_request_timeout_sec` | `ai-request-timeout-sec` |
| `ai_connect_timeout_sec` | `ai-connect-timeout-sec` |
| `ai_fallback_request_timeout_sec` | `ai-fallback-request-timeout-sec` |
| `ai_fallback_connect_timeout_sec` | `ai-fallback-connect-timeout-sec` |
| `platform` | `platform` |
| `forgejo_api_url` | `forgejo-api-url` |
| `forgejo_token` | `forgejo-token` |
| `forgejo_auth_method` | `forgejo-auth-method` |
| `forgejo_authorized_integration_audience` | `forgejo-authorized-integration-audience` |
| `forgejo_skip_permission_preflight` | `forgejo-skip-permission-preflight` |
| `skip_if_diff_unchanged` | `skip-if-diff-unchanged` |
| `force_review` | `force-review` |
| `rereview_label` | `rereview-label` |
| `comment_marker` | `comment-marker` |
| `ci_status_check` | `ci-status-check` |
| `ci_timeout_sec` | `ci-timeout-sec` |
| `ci_interval_sec` | `ci-interval-sec` |
| `ci_skip_on_timeout` | `ci-skip-on-timeout` |

One default differs on purpose: v2's `verdict_policy` defaults to `model`;
v3's `verdict-policy` defaults to `strict` (#811, below). Set
`verdict-policy: model` to keep the v2 passthrough.

### Tier-aware tool request budget (#701)

`tool_max_requests` defaults to **empty** on both sides. The empty value is
resolved at tool-harness time into a tier-aware budget — primary ~16, smart
route ~32, escalated (deep) up to 40, hard ceiling 50 — instead of one
undifferentiated ceiling. Explicit values override every tier (bounded to
1..50); `SMART_TOOL_MAX_REQUESTS` overrides on smart/escalated runs.
Precedence: `SMART_TOOL_MAX_REQUESTS` (smart/escalated) > `tool_max_requests`
> tier default. The v3 native tool loop must reproduce this resolution and
the exhaustion-aware behavior (remaining-budget notes on later loop turns,
low-budget pivot to blocker hypotheses, `tool-call-budget-exhausted` kept as
a distinct stop reason); the contract description for `tool-max-requests`
carries the same semantics.

The behavior is pinned by the `tool-request-budget` parity boundary
(#673): `tests/fixtures/parity/tool-budget/tool-budget-tiers.json` carries
the expected (route, budget) per case, `tests/parity_runners/v2_tool_budget.py`
runs the real v2 harness resolver, and `src/tools/budget.ts` is the v3 port
(`PR_REVIEWER_V3_MODE=tool-budget`). Both sides fail closed on any
expectation mismatch, so #678 cannot regress to a single undifferentiated
request ceiling.

## Retained outputs

| v2 output | v3 output |
| --- | --- |
| `verdict` | `verdict` |
| `verdict_source` | `verdict-source` |
| `required_checks` | `required-checks` |
| `review_route` | `review-route` |
| `escalation_reason` | `escalation-reason` |
| `findings` | `findings` |
| `review_markdown` | `review-markdown` |
| `analysis_engine` | `analysis-engine` |
| `should_review` | `should-review` |
| `skip_reason` | `skip-reason` |
| `diff_fingerprint` | `diff-fingerprint` |
| `ci_status_skipped` | `ci-status-skipped` |
| `ci_status_final` | `ci-status-final` |
| `cache_hit_ratio` | `cache-hit-ratio` |
| `tool_calls` | `tool-calls` |

Hyphenated Action output IDs are referenced with normal property syntax, for
example `${{ steps.review.outputs.review-markdown }}`. GitHub Actions property
deref names allow hyphens; #670's runner test also exercised kebab-case output
IDs through native and composite actions.

## Removed fields

These v2 fields have no v3 ID or compatibility alias:

| v2 field | Kind | Migration |
| --- | --- | --- |
| `review_scope` | Input | Remove it. Every changed review uses the full current PR; use `skip_if_diff_unchanged` for the unchanged-diff skip. |
| `escalate_on_dirty_baseline` | Input | Remove it. Dirty-baseline escalation no longer exists. |
| `effective_review_scope` | Output | Stop consuming it. No replacement; reviews use the full current PR. |
| `previous_head_sha` | Output | Stop consuming it. Incremental baseline state is no longer exposed. |
| `previous_base_sha` | Output | Stop consuming it. Incremental baseline state is no longer exposed. |
| `baseline_clean` | Output | Stop consuming it. Dirty-baseline state is no longer exposed. |
| `tool_planning_timeout_sec` | Input | Remove it and use `tool_turn_timeout_sec`. |
| `tool_planning_max_context_bytes` | Input | Remove it and use `tool_corpus_max_bytes`. |
| `tool_planning_max_tokens` | Input | Remove it and use `tool_max_tokens_per_turn`. |
| `escalate_on_incomplete_required_checks` | Input | Remove it. Deprecated since #721; no longer affects escalation. |
| `escalate_on_fast_request_changes` | Input | Remove it. Deprecated since #721; no longer affects escalation. |
| `escalate_on_fast_low_confidence` | Input | Remove it. Deprecated since #721; no longer affects escalation. |
| `escalate_on_tool_or_evidence_blockers` | Input | Remove it. Deprecated since #721; no longer affects escalation (deterministic evidence/tool enforcement is unaffected). |
| `escalate_on_tool_planning_failure` | Input | Remove it. Deprecated since #721; no longer affects escalation. |

The `tool_planning_*` inputs are currently deprecated fallback inputs in v2
and are removed in v3. They are intentionally not copied into the v3 contract.

The five `escalate_on_*` inputs above are also currently deprecated in v2
(accepted for backward compatibility since #721 but already inert — they no
longer trigger escalation, which is reviewer-requested only via the
structured `smart_review_requested` verdict field). #777's moderate input
trim drops this dead weight from the v3 contract too; they are not copied
forward under any name.

## Repository config (#727, adopted for the Action by #777)

The v3.0.0 Action reads an optional repository-owned config file — same
schema and trust rules as the #727 self-hosted operator design — instead of
requiring every knob to be a workflow input. See
[`docs/repository-config.md`](repository-config.md) for the file locations,
the precedence rule, and the full list of keys a repository may set.

As part of the same change, these rarely tuned byte caps are
`repo-configurable: true` in the v3 contract: a repository config file may
narrow them below the operator's workflow-level ceiling (their explicit
value, or the contract default when unset). They remain ordinary workflow
`with:` inputs — the operator's workflow input is always the ceiling, and
repository config can only narrow it, never replace or exceed it: `related_code_max_bytes`,
`repo_map_max_bytes`, `pr_thread_max_bytes`, `review_threads_max_bytes`,
`deep_review_corpus_max_bytes`, `tool_max_response_bytes`.

`primary_tool_max_requests` and `smart_tool_max_requests` are deliberately
**not** repo-configurable: their default is an empty string on purpose (a
tier-aware budget resolved at harness time), so there is no config-time
ceiling to narrow against — see `docs/repository-config.md` for why falling
back to the type's hard range would be unsafe.

## The strict verdict default (#811)

Under the v3 default `verdict-policy: strict`, the published verdict is a
deterministic function of the normalized still-open findings and the
required-check coverage. The model's verdict is an input to that mapping,
not the final answer:

| Highest open severity | Coverage | Published verdict | Marker `review_result` |
| --- | --- | --- | --- |
| blocker or major present | any | `request_changes` | `issues` |
| none, minor or info only | incomplete | `approve` | `partial` |
| none, minor or info only | complete | `approve` | `findings` when any open finding exists, else `clean` |

- Minor and info findings can never request changes on their own; a model
  `request_changes` backed only by them publishes as the non-blocking state
  (the regression row of the verdict table in
  `tests-v3/strict-verdict.test.ts`).
- Enforcement overlays (evidence blockers, tool-harness failure,
  min-successful, `required_check_validation_mode=fail`) run after the
  coverage pass and still force `request_changes`; the mapping never
  relaxes a forced verdict.
- The mapping runs last in the enforcement pipeline, so the findings it
  decides on are the final still-open set — the same normalized array the
  publish step renders and the `findings` output carries, including threads
  the #770 settlement pass re-emitted. "Still-open" is that one set; there
  is no second open-findings state to reconcile (#792). #812 (separate
  change) fixes the stale-carried-verdict fingerprint; this change only
  consumes the resolved set.
- When the mapping overrides the model's verdict, the review says so in one
  line — `_Verdict set from open findings (verdict_policy=strict): …_` —
  exactly as `findings_severity_gated` discloses its own overrides. The
  `verdict-source` output stays in the existing `model`/`findings`
  vocabulary.
- The published review renders the coverage gap and the still-open findings
  near the top of the body — severity counts on the verdict line in comment
  mode, a `### Findings (…)` table with one row per finding — so an approve
  with findings never reads as clean (#752). Messages are redacted,
  upstream-neutralized and table-escaped; the table caps at 50 rows with a
  visible "N more" line.
- The metadata marker's `review_result` distinguishes `clean`, `findings`
  and `partial` beside the v2 `issues`. The unchanged-diff carry-forward
  consumes the new values: `findings` and `partial` carry an `approve`,
  like `clean`.

`verdict_source` under strict remains `model` when the published verdict
equals the model's and `findings` when the mapping overrode it.

### Opting out

Consumers that gate merges on the model's own verdict set:

```yaml
verdict-policy: model
```

Under `model` (and under `findings_severity_gated`), v3 keeps today's
behavior: the binary `clean`/`issues` marker, no findings section, no
coverage-gap notice, and the model verdict passthrough (with
`findings_severity_gated`'s existing blocker escalation). The `verdict`
output remains `approve` | `request_changes` under every policy.

The default change is pinned as the `verdictPolicy` divergence on the
`config-default-resolution` fixtures in
[`tests/fixtures/parity/approved-divergences.json`](../tests/fixtures/parity/approved-divergences.json).
The publish-side rendering and the marker states are v3-only behavior
covered by `tests-v3/strict-verdict.test.ts`; no parity fixture exercises
them, because the enforcement-pipeline boundary pins the v2 policies, whose
behavior is unchanged.

## Parity harness (#673)

The `tests/parity_harness.py` harness blocks the TypeScript cutover on
observable behavior drift, not on source comparison or unit-test counts. It
runs equivalent v2/v3 runtime stages against the same fixtures, normalizes
only expected-to-vary nondeterministic values (temp paths, timestamps,
durations, PIDs, request ids — never verdicts, risk flags, roles, corpus
content, security-gate decisions, routing, or error categories), and emits a
structured report naming the first divergent boundary.

- **Boundaries** are declared in `BOUNDARIES` in the harness; each knows how
  to run one fixture through both implementations. Currently:
  `config-default-resolution` (v2: action.yml env-block expression resolution
  plus `scripts/sections/config.sh` vs v3: the typed loader in
  `dist/index.js`), `dataflow-662-corpus-truncation` (the #662
  broken-arrow counterexample: the vulnerable variant must fail parity, the
  fixed variant must pass), `model-request-construction` (#677: the v2
  `build_model_request` jq assembly versus the v3 typed builder in
  `src/model/request.ts`) and `verdict-parsing` (#677: the v2 tolerant
  response parser in `pr_reviewer/response_parser.py` versus the v3 port in
  `src/model/verdict.ts`).
- **Fixtures** live under `tests/fixtures/parity/<boundary>/*.json`. Later
  migration tickets add fixtures for their boundary as JSON only — never
  harness logic.
- **Approved divergences** (`tests/fixtures/parity/approved-divergences.json`)
  pin intentional v3 contract changes to the EXACT divergence: boundary +
  fixture(s) + key + the expected old AND new values (for outcome-level
  drift, the `ok` / `error:<category>` tokens). An approval never extends
  beyond the pinned fixture and value pair — if v3 starts returning a
  different wrong value for an approved key, the run fails. Drift on any
  fixture/key/value not pinned here fails the run.
- **Counterexample fixtures** (fixtures whose `expected.outcome` is `drift`)
  must declare their divergence signature: every key that must drift with
  its exact old/new values, and nothing beyond them. A missing declared
  drift, a changed drift value, or any undeclared extra drift fails the run.
- **Numeric equality** applies only to keys the v3 contract declares numeric
  (`INTEGER_INPUTS`/`FLOAT_INPUTS`); every other key — including strings
  that look numeric — compares as an exact canonical string.
- **Error categories** fail closed: two errors that both map to no known
  category never compare equal by category — their scrubbed texts must
  match byte-for-byte or the fixture drifts, forcing the boundary's category
  table to name the category.
- **Migration gates** run before the boundaries: the #698 production dataflow
  qualification (`tests/test_issue_662_dataflow.py`) and the #661/#666
  semantic qualification (`scripts/run_semantic_eval_ci.py` over
  `evals/corpus-historical-dogfood.json`). A gate failure fails the harness;
  the scorer is referenced, not duplicated.

```bash
python3 tests/parity_harness.py                      # gates + all boundaries
python3 tests/parity_harness.py --report parity-report.json
python3 tests/parity_harness.py --boundary config-default-resolution --skip-gates
```

Config-boundary notes: the v2 side replays the action.yml env-block
expressions (plain `inputs.x`, `a || b` chains, the `x != '' && x || y`
legacy-fallback idiom; `github.*` context terms come from the fixture's
`ambient` map; unmodelable expressions are skipped and reported as
`unresolved_bindings`). Inputs the v2 pipeline never transports through the
resolved environment (it reads them from the raw input in later steps) are
mechanically scoped out of the config boundary and reported as
`excluded_keys`. The v2 `github_token` binding is compared through `GH_TOKEN`
(config.sh's `GH_TOKEN:-${GITHUB_TOKEN:-}` fallback). Numeric-class values
compare by numeric equality; secrets compare by redacted presence only.

### The `precheck-decision` boundary (#674)

Compares the full precheck decision path: the v2 production stack
(`scripts/check_review_needed.sh` + `pr_reviewer.precheck` +
`scripts/build_selection_fingerprint.py`, with platform I/O served through
the real platform seam stubs) versus the v3 TypeScript modules under
`src/platform/` and `src/precheck/` (`node dist/index.js precheck-fixture`).
Fixtures under `tests/fixtures/parity/precheck/` cover unchanged and changed
fingerprints, changed linked-issue labels, changed Linear priority/labels,
failed metadata lookups, fork-disabled private lookups, forced rereview,
unrelated-label no-ops, superseded heads, and GitHub vs Forgejo — each
compared over the exact `$GITHUB_OUTPUT` key/value surface.

The selection-signature hash is compared byte-for-byte whenever the
signature is determinate; when a fixture declares
`"selection": "unavailable"`, the conservative per-run-unique sentinel makes
the config-hash half nondeterministic by design (it must never match a
stored marker), so both sides' hash half is normalized to a shared
placeholder while the diff half and the forced-review decision still compare
as-is. Error cases compare through the boundary's category table
(missing input, unsupported platform, Forgejo permission refusal modes).

### The `conversation-rendering` boundary (#678)

Pins the v3 `Conversation` port (`src/model/conversation.ts`) against
`pr_reviewer.conversation`. Fixtures are declarative op scripts
(`add_user` / `add_assistant_text` / `add_assistant_tool_calls` /
`add_tool_result` / `add_system_note` / `add_turn_note` /
`truncate_oldest_tool_results` / `summarize_oldest_tool_results`) with
`emit` (per-API `toRequestPayload` options) and `introspect` (turns, open
tool-call ids, approx tokens). Both sides (`tests/parity_runners/v2_conversation.py`
and `node dist/index.js conversation-fixture`) replay the identical script
and dump one JSON: payloads, introspection, and — when the fixture carries
`dedup` — the `dedupe_verdict_corpus` result (byte-duplicate drop, partial
overlap non-drop, Related Code continuation headers, headerless blobs).
Everything is deterministic; nothing is scrubbed.

### The `escalation-decision` boundary (#678)

Compares the v2 `pr_reviewer.escalation` (run over temp-file artifacts,
exactly as production invokes it) against the v3 in-memory ports in
`src/routing/escalation.ts`. Each fixture carries the four production dicts
(`output` / `classification` / `evidence` / `harness`) plus the five
telemetry flags, and both sides emit `requested` / `reason` / `escalate` /
`reasons` / `low_confidence`. Covers the #721 strict-boolean contract
(string `"true"`, `1`, and prose never request), reason kept vs dropped,
each telemetry reason firing in isolation, the #750 structured-coverage
path (grounded `not_applicable` is not incomplete; `unresolved` is), the
legacy keyword fallback, environmental-only vs substantive Unknowns, stub
reviews, evidence blockers, all-failed tool results, and planning failure.

### The `tool-loop` boundary (#678)

Drives the v2 `pr_reviewer.tool_loop.drive_tool_loop` and the v3
`driveToolLoop` over the same scripted transcript: a queue of raw model
responses (including a `{"raise": ...}` transport-error form), per-call
executor results, an optional summarizer queue, and an explicit `clock`
array replacing `time.monotonic` so wall-clock stops are deterministic.
Both sides print the same `{outcome, messages, payload_last}` JSON;
`elapsed_sec` is intentionally not emitted. Fixtures cover no-tool-call
degradation, model-stop after calls, max-rounds exhaustion, mid-round
budget exhaustion, duplicate-call dedup, malformed arguments, mixed
error/dup/exec rounds, wall-clock stop, request error, compaction
(truncate path, summarize path, summarize-fail → truncate fallback),
Anthropic `tool_use` extraction, and OpenAI nested function form.

### What #678 removed from the required Python runtime surface

With the routing/escalation/conversation/tool-loop ports, the entire
native-loop review runtime now exists in TypeScript (`src/routing/`,
`src/model/conversation.ts`, `src/tools/`): tier profiles, direct smart
routing, the #721 reviewer-requested escalation contract, the fallback
availability path, the conversation state machine, the read-only executor
catalogue with its guards, the MCP client, the loop driver, the planning
context, the in-conversation verdict turn, and the #702 telemetry object.
The Python side of these modules is now a temporary oracle for the parity
boundaries above; production wiring still invokes the v2 scripts until the
#681 orchestrator cutover. Remaining Python-only runtime after #678 (the
#680/#706 backlog): the v2 publish/precheck shell pipeline, and the platform
`gh` subprocess seams behind `scripts/platform_api.sh`.

### The deep-review specialist runtime (#776)

`src/specialists/` is a byte/behavior-exact port of the deep-review
specialist runtime: `pr_reviewer/specialists.py` (normalize/parse contract,
fence-safe markdown rendering, the #758 adversarial-correctness contract),
`pr_reviewer/specialist_corpus.py` (the bounded #632 corpus builder and its
#758 author-blinded `adversarial_correctness` variant), and the concurrent
runner half of `scripts/run_specialists.py` (per-role payload construction,
the three #635 execution shapes, the completion-overrun retry, request
metering). The port is transport/filesystem-agnostic by design — the caller
supplies a `requestFn` and receives artifacts to persist, matching the
#678 routing/tool-loop modules — since no v3 orchestrator yet exists to wire
a real workspace writer or the `gates.ts` `specialists` branch's subprocess
before #681. `src/tools/harness.ts`'s `renderSpecialistLeads` seam is wired
to the real `renderSpecialistLeadsSection` port. New parity boundaries:
`specialist-corpus`, `specialist-payload`, `specialist-normalize`
(`tests/fixtures/parity/specialist-*/`, `tests/parity_runners/v2_specialist_*.py`).

### The `enforcement-pipeline` boundary (#680)

Compares the full deterministic enforcement pipeline: the v2 production
composition (`apply_verdict_policy` → `apply_required_check_validation` →
`apply_all_enforcement`, over cwd-relative artifacts exactly as
`scripts/sections/config.sh::apply_all_enforcement_wrapper` invokes them)
versus the v3 ports in `src/enforcement/` (`node dist/index.js
enforcement-fixture`). Fixtures under `tests/fixtures/parity/enforcement-pipeline/`
carry the parsed `ai-output.json` artifact plus the optional evidence,
tool-harness, review-thread, human-review, and classification inputs, and
both sides emit the resulting artifact, the `completeness.json` result, the
required-checks status, and the applied-enforcement count (canonicalized
with sorted keys). Covers the model-policy no-op, #773-era blocker
escalation, #775 opt-in non-blocking category capping (with the
security-flag exemption and the unresolved-check relaxation gate), evidence
blockers, tool-harness failure and min-successful overlays, #770 thread
settlement (downgrades, re-emitted `thread_id` findings, blocker
escalation), #774 human change-request settlement, malformed/missing
structured coverage, and the enforced banner normalization.

One approved divergence pins the #680 contract change: when the model emits
no structured required-check dispositions at all, v2 fell back to the legacy
shallow keyword match; v3 is structured-authoritative and treats key absence
as conservatively unresolved (`key-absence-legacy-bridge`).

### The `requirement-coverage` boundary (#680)

Pins the #624 requirement-coverage fold (`pr_reviewer.requirement_coverage`
versus `src/enforcement/requirement-coverage.ts`) over the tolerant ledger
load: evidence-gated credit, `not_applicable` downgrades, invariant
verification kinds, duplicate/out-of-ledger/invalid-kind errors, and the
visible caps.

### The publication boundaries (#680)

Three boundaries pin the publish path:

- `review-sanitize` — reserved-marker stripping, upstream-link
  neutralization (`inert`/`togithub`) with inline-code-span preservation,
  and fence-aware empty-conditional-section stripping (`src/publish/sanitize.ts`
  versus the three production scripts).
- `inline-findings` — `scripts/build_review_comments.py` versus
  `src/publish/inline-findings.ts`: diff-position mapping for both the
  GitHub (`line`/`side`) and Forgejo (`new_position`) backends, anchor
  validation, `thread_id` dedup, caps, redaction, and body sanitization.
- `metadata-markers` — marker serialization (fixed key order, conditional
  fields, `escalation_reason` array, numeric `cache_hit_ratio`), preamble
  emission, managed-body detection by content prefix, and reserved-marker
  stripping that keeps model output from forging action-owned markers.

The publish *orchestration* (mode dispatch, head re-check, approval
guardrails, cleanup sequencing, output writing) is covered by `tests-v3/publish.test.ts`
and `tests-v3/outputs.test.ts` over a mock platform seam rather than a
bash-vs-TS boundary: the v2 side is a shell dispatcher whose observable
behavior depends on `gh`/`forgejo` subprocess stubs, and the #681 cutover
will qualify it end-to-end through the runner.

### The `platform-normalization` boundary (#706)

Pins the platform read seams: raw GitHub REST/GraphQL and Forgejo `/api/v1`
responses (a route table in each fixture under
`tests/fixtures/parity/platform-normalization/`) are served to the real v2
seam — `scripts/platform_api.sh`, `forgejo_backend.py` via `_forgejo_py`,
`gh_api_call`, and the `pr-files.json` jq projection read from
`scripts/sections/context.sh` — through stub `gh`/`curl` binaries, and to
the v3 adapters through an injected fetch (`node dist/index.js
platform-normalization-fixture`). Both sides emit each read's `{ok, data}`
as order-preserving ASCII JSON, the byte-significant artifacts (the
`pr-files.json` line, the external-checks line, the raw diff), and the
request log. Each fixture also records its expected output, pinned against
the v2 side by `tests/test_platform_normalization_goldens.py`.

v2 quirks kept for parity (candidates for approved divergences once the
orchestrator owns these reads): a failed Forgejo issue fetch is a successful
read of `null`; a failed Forgejo file, comment or review listing is an empty
list; a failed or unparseable commit-status read folds to `[]` ("no external
CI") rather than to the empty transient signal; and the Forgejo
conversation branch is newest-first while GitHub's is oldest-first.

### The `prompt-assembly` boundary (#706)

Pins the prompt and message layer (`src/prompt/`): the v2 runner
(`tests/parity_runners/v2_prompt_assembly.py`) slices the real
`resolve_system_prompt`, `apply_system_prompt_fragments` and
`apply_specialist_leads_fragment` out of `scripts/sections/config.sh`, and
`build_user_message`, `handle_model_failure` and `annotate_analysis_engine`
out of `review.sh`, with config.sh's own defaults for the variables they
read, and runs them under `set -euo pipefail` in a scratch workspace seeded
with the fixture's presence files, `classification.json` and custom prompt
file. `node dist/index.js prompt-assembly-fixture` runs the v3 port over the
same workspace. Both sides emit the resolved, assembled and final system
prompt, the user message (each with a sha256 of the exact bytes), the
failure notices (`ai-output.json` bytes) and the engine annotations.
`tests/test_prompt_assembly_fixtures.py` pins the corpus coverage (every
gated fragment on and off, replace vs append, the error outcomes) by
fragment text rather than golden prompts, so wording edits never force
fixture regeneration.

**Prompt assets are embedded at build time.** `scripts/generate-v3-contract.mjs`
writes `default_system_prompt.txt` and every `prompt_fragments/*.txt` into
`.v3-generated/prompt-assets.generated.ts`, exactly as it embeds the
contract, so `dist/index.js` never reads `scripts/` (at runtime the cwd is
the consumer's checkout). The files stay the single source of truth for both
runtimes; `tests-v3/prompt-assembly.test.ts` asserts the embedded texts are
byte-identical to them. The specialist loader (`src/specialists/prompts.ts`)
still reads `scripts/prompt_fragments/` relative to the cwd and should move
to the embedded map when the orchestrator wires it.

v2 semantics kept for parity: the three `pr_kind` placeholders are stripped
(first occurrence) from a replace-mode operator prompt too; the kind is read
with jq (a leading BOM is skipped and a multi-document file still gates)
while the user message parses with Python `json.load` (either shape falls
back to the base message); an operator prompt file loses its trailing
newlines and NUL bytes; and a classification shape the embedded Python would
raise on aborts the review (`UserMessageBuildError`). Fragments must not
contain `&` or `\`: v2 inserts them with an unquoted `${var/pattern/$frag}`,
which bash >= 5.2 expands.

### The `linked-sources` boundary (#706)

Pins `render_linked_sources` and its SSRF-safe fetch. The real v2 render
(`fetch_url`'s urllib opener and allowlist redirect handler, the
`host_allowed` public-DNS gate, `strip_source_text.py`, `gh_api_call`, the
Forgejo enrich reads, the #509 repo gate and `BudgetTracker`) runs with only
its transport seams fixture-routed: `enrichment.socket.getaddrinfo`,
urllib's `http(s)_open`, stub `gh`/`curl` binaries, and the budget clock
(`tests/parity_runners/v2_linked_sources.py`). The v3 side
(`node dist/index.js linked-sources-fixture`) injects the same data at the
resolver, the `Exchange` transport, the enrich clients' fetch, and the
`BudgetTracker` clock. Both emit the rendered `linked-sources.md`, the
sorted request log, and the budget-warning count;
`tests/test_linked_sources_goldens.py` pins each fixture's recorded v2
output.

The v3 fetch (`src/platform/safe-fetch.ts`) resolves each hop once, requires
every address to be public (`src/platform/ip-policy.ts`, CPython 3.14's
`ipaddress` classification), and pins the socket to those addresses through
its `lookup` hook, closing the rebinding window v2's urllib left open. TLS
SNI and `Host` keep the hostname.

Approved divergences (all fail closed):

- `100.64.0.0/10` (CGNAT) and `fec0::/10` (site-local) are blocked; CPython
  classifies neither as private or reserved.
- Raw source bodies are capped at 5 MiB (fixture `oversize-over-cap`) and
  Forgejo enrich API responses at 32 MiB (pinned in
  `tests-v3/safe-fetch.test.ts`); v2 read both unbounded.
- Raw fetching honors `ALLOWED_SOURCE_HOSTS` as the input documents
  (maintainer-approved fix). v2's `_fetch_sections` never passed it to
  `fetch_url`, which re-checked against its built-in
  `{github.com, gitlab.com, registry.terraform.io, artifacthub.io}`, so an
  operator-added host always rendered "Failed to fetch". Every SSRF gate
  still applies to it.
- Every redirect hop must stay inside `ALLOWED_SOURCE_HOSTS`; v2 checked hops
  only against `fetch_url`'s built-in list.
- Redirect hops go only to http/https (urllib also followed `ftp://`), and
  proxy environment variables are not honored.
- A URL whose Python hostname and connection target disagree (userinfo,
  backslash tricks, non-ASCII request targets) fails instead of connecting.
- A URL `urlparse` rejects, or an API entry v2's shaping would raise on
  (`.get` on a non-dict, slicing `None`, `.lower()` on a non-string), no
  longer aborts the whole render: v3 drops just that URL (listed as
  `unparseable URL` in the skipped-hosts summary) or entry. Fixtures whose v3
  output differs from v2 record it as `v3_golden`, pinned by
  `tests-v3/linked-sources.test.ts`.
- Fetched text is fenced with more backticks than any run it contains (the
  related-code `_fenced` approach), so a page cannot close the fence and turn
  the rest of the corpus into code.

v2 behavior kept: github.com is never fetched raw (its release/compare
metadata comes from the API), and gitlab.com/bitbucket.org are skipped as
known non-Forgejo hosts whose pages are client-rendered. JSON goes
through `JSON.parse`, so integer-valued floats, integers beyond 2^53 and
integer-like object keys do not round-trip byte for byte (approved
divergence, fixture `json-number-precision`).

### The `context-producers` boundary (#706)

Pins the deterministic corpus producers that existed only as v2 shell:
the changed-manifest block (`src/context/manifest-context.ts`), the repo
impact/history scan (`repo-impact.ts`), the linked-issue fetch loop with the
Linear adapter, label merge-back and `linked-metadata-status.json`
(`linked-issue-context.ts`), `resolve_standards_file` (`standards-file.ts`),
the requirement-ledger presence signal and MAX_CORPUS fit predicate
(`src/requirements/presence.ts`), and the fence-safe related-code clip
(`clipMarkdown` in `related-context.ts`). The v2 runner
(`tests/parity_runners/v2_context_producers.py`) slices each block verbatim
out of `scripts/sections/` and runs it under `set -euo pipefail` in a
harness-prepared worktree (`repo_fixture.py`, now with deterministic
`commits` for `git log`); only external seams are stubbed at their call
sites (`platform_issue_get`, `urlopen` inside the real `linear_context.py`,
the ledger/anchor/related-context builders). Every artifact is compared
byte for byte (`file:<name>`, strict UTF-8 or `!b64:`).

Checkout containment (#805) is a production fix in both runtimes, so the
two sides still agree and no divergence is approved. A repository path
(changed manifests, standards-file candidates and a relative or in-checkout
`standards_file`) is read only when it names a regular file reachable
without following any symlink and without `..`
(`workspace_regular_file` in `scripts/sections/common.sh`,
`workspaceRegularFile` in `src/context/workspace-path.ts`). A refused
manifest renders a "not embedded" notice. A refused `standards_file` that
still reads as a file is cleared, because the corpus and ledger readers only
test `-f`. An absolute `standards_file` or candidate outside the checkout is
operator-owned and keeps working; a relative `../` escape no longer
resolves, so operators give an absolute path instead. Adversarial fixtures
put runner content behind file and directory symlinks and fail the run if
it reaches either side's output (`forbidden_output`).

The repo-impact scan streams: grep rows are attributed as they arrive,
each term keeps only what can reach its capped section, the grep stops once
every term is full, and each `git log` keeps cap + 1 bytes. v3 therefore
materializes only the capped `repo-impact.truncated.md` and
`repo-history.truncated.md` (the files the corpus reads); v2's untruncated
intermediates are not compared. The Linear timeout follows CPython 3.14
(`argparse` plus `int()`: Unicode digits, whitespace, underscores, then
`max(1, t)`), although config already limits the input to `^[0-9]+$` >= 1.

The runner pins the production runner environment: `LC_ALL=C` (the byte
collation C.UTF-8 gives `sort -u` and bash globs here) and GNU `wc`'s
unpadded count. Semantics that follow GNU tools rather than the macOS ones
(`xargs` running `echo` before an unterminated-quote error, `tr` lowercasing
ASCII only) are not exercised by fixtures, because a macOS oracle would
disagree with production. Not modeled: NUL bytes in a PR title or body (GNU
`grep` switches to binary-file mode), issue numbers beyond 2^53, and
Linear payload shapes that crash the Python adapter (a non-dict `state`,
`labels` or `data`); v3 treats those as absent fields.

### The `ci-gate` and `specialists-gate` boundaries (#706 PR 6)

`ci-gate` runs the real `scripts/wait_for_ci.sh` against stub
`gh`/`curl`/`date`/`sleep` binaries that share a virtual clock (only the poll
loop's own `sleep` advances it; the `_gh_api_bounded` watchdog sleeps for
real), and the v3 `gate-ci` workload over an injected fetch and the same
clock. Fixtures serve per-route response sequences and compare exit code,
`$GITHUB_OUTPUT`, the `ci-checks-context.md` bytes, leftover temp files, the
request log, elapsed virtual time and the log lines.

The first approved divergence is the commit-status quirk above: the v3 CI gate
reads with `transientAsUnknown`, so no response, HTTP 429/5xx, or a non-JSON
body on either read is "unknown, retry" instead of `[]`. v2 could finalize
`none` (or a partial list) while CI was still running. It is pinned for the
GitHub and Forgejo `transient-status-read` fixtures. The head SHA stays
pinned once for the whole wait, as in v2; a head that moves mid-wait is the
publish boundary's exact-head guard's problem, not the CI gate's.

The second (`hostile-check-names`): v2 wrote check names raw into the
evidence table, so a name with `|`, a newline plus a forged `## heading`, or
control characters split rows. v3 escapes every cell (`escapeTableCell`):
control runs become one space, `\` `|` and backticks are backslash-escaped,
and `&` `<` `>` become entities, so the table keeps one row per check.

`specialists-gate` runs `scripts/run_specialists.py` (curl transport) and the
v3 `gate-specialists` workload (v3 model transport) against local mock model
endpoints serving the same per-role responses, and compares every artifact
byte for byte. Only `elapsed_sec` values and the mock port are normalized.
Porting the glue surfaced three runner fixes, now matching v2: skipped
aggregate entries carry v2's exact keys, `request_bytes` measures Python's
`json.dumps` (ASCII-escaped, space-separated), and the contract's float fields
serialize as Python floats (`0.0`, `1.0`). Float coercion is scoped by exact
path per artifact (`temperature` in a request, `aggregate_elapsed_sec` and
`roles[].elapsed_sec` in `specialists.json`), never by bare key name: raw
provider response bodies are written as v2's `json.dumps(json.loads(body))`,
so a same-named integer field in them stays an integer
(`raw-response-integer-fields`). Later fixes, also
matching v2: a role's request artifact is recorded before its first attempt,
so a role reaped at the phase deadline still leaves it (`phase-deadline-reap`);
a failed combined scout leaves `specialist-scout.request.json` and no
response artifact (`combined-scout-failed`); timeout failures carry the
`timeout:` message in the role and response artifacts; and an error-body
message quotes the error as Python `str()` does, redacted.

### The `evidence-providers` and `sarif` boundaries (#706)

Both run the real v2 evidence phase — the fork-gate block sliced from
`scripts/sections/classification.sh`, `run_evidence_providers.py` under a
frozen monotonic clock, and `harvest_advisory_phases` with its fallback —
against `node dist/index.js evidence-providers-fixture` over identical
throwaway workspaces with real provider processes, and compare the
`evidence-providers.json` / `.md` bytes (plus `normalize_sarif` artifacts
for SARIF fixtures).

Deliberate v3 differences, none visible in the fixtures: the provider env is
the explicit allowlist, not v2's scrubbed `os.environ`; output capture is
bounded at `4 * max_output_bytes + 64 KiB` (v2 read unbounded), and an
overflowing capture is cut back to its last whitespace before masking so a
split credential cannot survive, then always marked truncated; timeouts kill
the process tree. v2 quirks kept for parity: an argv provider whose program
cannot be spawned, an `int(inf)` override, or a JSON integer over 4300 digits
aborts the whole phase into the fallback artifacts, as does a lone surrogate
that cannot be written.

The `image-provenance` boundary gained transport fixtures: the real v2
`http_json` over a stub `curl`, versus `image-transport.ts` over an injected
fetch, comparing the document and the request log. They caught a #675 port
bug: `parse.quote(..., safe=":")` percent-encodes `/` in the registry token
scope (`repository:o%2Fapp:pull`). The transport refuses anything outside the
endpoints the renderer builds (hostile config digests or revision labels).
Every hop, the first and each redirect, goes through #808's `safeFetchLike`
(http(s) only, no userinfo, public-only DNS/IP, the socket pinned to the
validated addresses), redirect hops must be https, and responses are capped
at 32 MiB. Public registry/CDN redirects still work (fixture
`transport-redirect-cdn`). v2's curl followed redirects to any address;
refusing the internal hops is an approved divergence (fixture
`transport-redirect-ssrf`: link-local metadata and an RFC1918 hostname).

## What #680 removed from the Python runtime surface

`src/enforcement/`, `src/publish/`, and `src/metadata/` now own the
deterministic enforcement, managed metadata, publication, and output
boundaries in TypeScript; the Python/bash side of these modules remains
only as the temporary parity oracle above until the #681 orchestrator
cutover. Two deliberate contract changes ship with the port:

- the legacy keyword-completeness bridge is removed (structured
  dispositions are authoritative; pinned as the approved divergence above);
- the managed metadata marker serializes with insertion-order keys
  (`json.dumps(..., separators=(',', ':'))` / jq object order), which the
  earlier precheck-side port had canonicalized with sorted keys.

Remaining Python-only runtime after #680: the deep-review specialist
runner/corpus (`scripts/run_specialists.py`, `pr_reviewer/specialist_corpus.py`
— the #706 backlog) and the v2 shell orchestration itself (`scripts/run_review.sh`
and the composite action steps), which the #681 cutover replaces.

## Workflow examples

```yaml
# v2
- uses: misospace/pr-reviewer-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    ai_base_url: ${{ vars.LITELLM_URL }}
    review_routing_mode: smart
```

```yaml
# v3 (after the #681 cutover)
- uses: misospace/pr-reviewer-action@v3
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-base-url: ${{ vars.LITELLM_URL }}
    review-routing-mode: smart
```

```yaml
# v2 output
- name: Enforce review verdict
  if: steps.review.outputs.verdict == 'request_changes'
```

```yaml
# v3 output; hyphens are valid in GitHub expression property dereferences
- name: Enforce review verdict
  if: steps.review.outputs.verdict == 'request_changes'
- name: Publish review text
  env:
    REVIEW_MARKDOWN: ${{ steps.review.outputs.review-markdown }}
```

## Repository dogfood cutover checklist for #681

Do not migrate these files before the root metadata cutover. In the atomic #681
change:

1. Rename every action-owned key under `with:` in
   `.github/workflows/ai-pr-review.yaml` using the retained-input map above;
   leave expressions, secrets, vars, and external action input names alone.
2. Search repository workflow/config examples and tests for action invocations
   and action output references, then rename only project-owned Action IDs.
   Keep step outputs such as `steps.app-token.outputs.token` unchanged.
3. Keep process environment variables (for example `AI_BASE_URL`) and payload,
   persisted diagnostic, and versioned JSON schema fields as they are.
4. Materialize and validate root `action.yml` from this contract in the same
   cutover; do not ship a partially renamed metadata/runtime boundary.
5. Confirm no underscore aliases remain in the v3 public input/output IDs.

Kebab-case is limited to the project-owned public Action API. Internal
TypeScript properties should use camelCase; external payloads, environment
variables, and existing versioned machine schemas retain their established
names.
