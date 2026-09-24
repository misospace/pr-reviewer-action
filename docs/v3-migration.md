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
| `escalate_on_incomplete_required_checks` | `escalate-on-incomplete-required-checks` |
| `escalate_on_fast_request_changes` | `escalate-on-fast-request-changes` |
| `escalate_on_fast_low_confidence` | `escalate-on-fast-low-confidence` |
| `escalate_on_tool_or_evidence_blockers` | `escalate-on-tool-or-evidence-blockers` |
| `escalate_on_tool_planning_failure` | `escalate-on-tool-planning-failure` |
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

### Tier-aware tool request budget (#701)

`tool_max_requests` defaults to **empty** on both sides. The empty value is
resolved at tool-harness time into a tier-aware budget — primary ~8, smart
route ~16, escalated (deep) up to 20, hard ceiling 20 — instead of one
undifferentiated ceiling. Explicit values override every tier (clamped to
1..20); `SMART_TOOL_MAX_REQUESTS` overrides on smart/escalated runs. The v3
native tool loop must reproduce this resolution and the exhaustion-aware
behavior (remaining-budget notes on later loop turns, low-budget pivot to
blocker hypotheses, `tool-call-budget-exhausted` kept as a distinct stop
reason); the contract description for `tool-max-requests` carries the same
semantics.

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

The `tool_planning_*` inputs are currently deprecated fallback inputs in v2
and are removed in v3. They are intentionally not copied into the v3 contract.

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
