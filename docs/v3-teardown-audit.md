# v2 teardown plan: file-by-file consumer audit (#706)

The cutover (#815) made the TypeScript runtime the shipped production path:
the no-subcommand JavaScript action entry (`src/run/action.ts`, the
`firstArg === ""` branch of the bundled `dist/index.js`) runs every stage
in-process — no Python interpreter, and no `jq`/`curl`/`gh` for internal
orchestration. The `{precheck,run,publish}` subcommands remain only as CLI
entrypoints (`src/run/entrypoints.ts`). `src/` invokes no `scripts/` or
`pr_reviewer/` file at runtime (every match in `src/` is a port-provenance
comment).

The cutover-time revision of this document recorded the consumer audit at
switch-over. This revision is the **teardown plan** the #706 sequence calls
for: every file under `scripts/`, `pr_reviewer/`, `tests/` (Python and bash)
and `tests/parity_runners/` is dispositioned as one of:

- **(a) delete** — v2 production runtime, or a test of it. No retained
  consumer exists, or the only one is `scripts/eval_harness.py`, which is
  re-pointed at the v3 entry before wave 1 (see [Deletion waves](#deletion-waves)).
- **(b) keep** — still consumed by v3 CI, the eval tooling
  (`scripts/eval_harness.py`, `scripts/run_semantic_eval_ci.py`,
  `scripts/harvest_human_findings.py` and friends), the fork workflow
  (`scripts/fork_review_gate.py`), release tooling, or the v3 build itself.
- **(c) keep temporarily** — a parity oracle the parity harness
  (`tests/parity_harness.py`) still executes, with the condition for
  deleting it.

Every (b) and (c) row names its concrete consumer (workflow file, script, or
test). Classifications were derived by reference scan, not by assuming a
TypeScript equivalent is enough: `git grep` over all tracked code (workflows,
`package.json`, `scripts/`, `pr_reviewer/`, `tests/`, `tests-v3/`, `evals/`,
`src/`, docs), with eval report/corpus JSON treated as data, not consumers.

## Retained non-production consumers

Four consumer groups keep v2 code alive after the cutover. Everything in
(a) and (c) traces back to them:

1. **The parity harness** (`tests/parity_harness.py`) — the #673 boundary
   harness and a #681 release gate. It executes v2 runners under
   `tests/parity_runners/`, imports `pr_reviewer.{precheck,completeness,sarif}`
   directly, runs `scripts/check_review_needed.sh`, `scripts/wait_for_ci.sh`
   and `scripts/run_specialists.py` as boundary v2 sides, and runs the
   `dataflow-qualification-698` (`tests/test_issue_662_dataflow.py`) and
   `semantic-qualification-666` (`scripts/run_semantic_eval_ci.py`) migration
   gates. Four pytest goldens tests also execute runners directly
   (listed in the tests table).
2. **The eval harness** (`scripts/eval_harness.py`) — run by
   `.github/workflows/eval-harness.yaml`. Its `run_review_for_pr` resolves
   and executes the bundled `scripts/run_review.sh`, which sources
   `scripts/platform_api.sh`, `scripts/artifact_paths.sh` and every
   `scripts/sections/*.sh`, which in turn invoke the v2 Python entry points
   — i.e. the whole v2 pipeline is still transitively alive through the eval
   tooling. It also imports `pr_reviewer.semantic_eval`. #706's own sequence
   requires re-pointing it at the v3 entry before `run_review.sh` goes.
3. **The Forgejo E2E smoke** (`tests/forgejo_e2e_smoke.sh`, the #683
   qualification harness, guarded by `tests/test_forgejo_e2e_smoke_safety.sh`)
   — it exercises `scripts/platform_api.sh`, `scripts/check_review_needed.sh`
   and `scripts/wait_for_ci.sh` against real Forgejo REST endpoints.
4. **The v3 build and v3 tests** — `scripts/generate-v3-contract.mjs` embeds
   `scripts/default_system_prompt.txt` and `scripts/prompt_fragments/*.txt`
   into `src/prompt/assets.ts`; `tests-v3/request.test.ts` reads
   `scripts/model_call.sh` to pin the `rf_json` literal across the port;
   `tests-v3/specialists-gate.test.ts` reads
   `scripts/prompt_fragments/specialist_correctness_adversarial.txt`.

## Deletion waves

- **Wave 0 — preparation (no deletions).** Re-point `scripts/eval_harness.py`
  at the v3 entry (`node dist/index.js run`) and adjust its tests
  (`tests/test_eval_harness_real_pr_corpus.py` fake-orchestrator names,
  `tests/test_eval_harness_repo_context.py` expectations). This re-point must
  land before the #681 measurement work (#810, #796), which has to measure
  v3. Inline the
  `rf_json` assertion in `tests-v3/request.test.ts` so it stops reading
  `scripts/model_call.sh`. Re-point `tests/forgejo_e2e_smoke.sh` at the v3
  platform seam. Confirm the adversarial-boundary pattern exemplars cited by
  AGENTS.md (#252: `tests/test_native_loop_exfil_redteam.py`,
  `tests/test_outbound_user_agent.py`) have v3-side equivalents, then update
  the AGENTS.md pointers. Update docs that still describe v2 as live
  (AGENTS.md code map, `README.md`, `docs/architecture/code-map.md`,
  `docs/v3-migration.md`, `SECURITY.md`, `.github/ai-review-rules.md`, and the
  `scripts/verify_pr_head.sh` mention in `.github/workflows/fork-ai-review.yaml`).
  Port-provenance comments inside `src/` are history, not consumers, and stay.
- **Wave 1 — delete the (a) set** (v2 production runtime, its tests, and the
  dead CI jobs/steps listed below). The (c) set and the parity harness stay.
- **Wave 2 — at the #681 release gate.** Freeze or retire each parity
  boundary, then delete the (c) set, the runners, and the remaining
  oracle-only tests. After wave 2 the **shipped action** contains no Bash and
  no Python; the repository retains only the (b) keep-list tooling.

## (a) delete — v2 production runtime and its tests

Nothing outside the v2 runtime itself, its test suites — including
`tests-v3/shadow-runner.test.ts`, the one v3-side consumer in this section,
deleted in the same commit as its subject — the smoke test, or the eval
harness (re-pointed in wave 0) consumes any file listed here.

### scripts/

| File | Note |
| --- | --- |
| `scripts/run_review.sh` | v2 orchestrator; executed only by the eval harness (re-pointed in wave 0) and v2 tests. |
| `scripts/sections/enrichment.sh` | Sourced only by `run_review.sh`. |
| `scripts/verify_pr_head.sh` | Only executable consumer is v2 `scripts/publish.sh`; the fork workflow verifies heads via `scripts/fork_review_gate.py verify` (it only mentions this script in a comment). |
| `scripts/summarize_tool_loop_telemetry.py` | Invoked only by `scripts/run_tool_harness.py` and its v2 test. |
| `scripts/v3_shadow_run.mjs` | The v2-vs-v3 shadow comparison was dropped by maintainer decision (#706, 2026-09-29). Its one remaining consumer is `tests-v3/shadow-runner.test.ts:13`, which executes the script's CLI — a `join("scripts", "v3_shadow_run.mjs")` path invisible to a literal-path grep. Delete both together in wave 1; the qualification evidence already captured under `evals/reports/` is data and stays. |
| `scripts/redact.py` | Imported only by v2 modules (`pr_thread`, `tool_executors`, `transport`, `forgejo_backend`) and the v2 pr-thread runner. The v3 port `src/context/redact.ts` is self-contained — port-provenance comment only, no runtime invocation (verified for wave 1). |

`scripts/sections/gating.sh` is deliberately **not** in this table: the
dataflow-qualification gate reads it, so it is (c) until wave 2 (see below).

### pr_reviewer/

| File | Note |
| --- | --- |
| `pr_reviewer/failure_paths.py` | True dead code: nothing in the v2 runtime, the runners, or the eval path imports it — only its own test (`tests/test_failure_paths.py`, fixtures under `tests/fixtures/failure_paths/`). Self-contained #625 deterministic oracle; if the failure-path obligation corpus is wanted for future v3 specialist work, move it to (b) instead — nothing else consumes it either way. |

Every other `pr_reviewer/` module is (c) — see that table. `__init__.py`
goes with the last module deleted (wave 2).

### tests/

Rules used: a test is (a) when it tests v2 runtime behavior (imports a v2
module or executes a v2 script/section), even when its subject happens to be
a (c) file — the retained oracle surface is the harness, the runners, and the
pytest goldens listed under (c). Deletable in wave 1 unless noted.

Python (`tests/`): `test_action_python_path.py` (its remaining assertions pin
the v2 runtime's `PYTHONPATH`/`PYTHONSAFEPATH` export and `pr_reviewer`
package-shadowing behavior in `run_review.sh`/`check_review_needed.sh`/
`platform_api.sh` — v2 behavior, not the v3 `action.yml`),
`test_api_key_argv.py`, `test_budget.py`,
`test_build_review_comments.py`, `test_change_anchors.py`,
`test_classifier.py`, `test_compare_url_regex.py`, `test_completeness.py`,
`test_conversation.py`, `test_diff_priority.py`, `test_empty_completion.py`,
`test_enforcement.py`, `test_enforcement_human_reviews.py`,
`test_enforcement_review_threads.py`, `test_enrichment.py`, `test_env.py`,
`test_escalation.py`, `test_failure_paths.py` (with its subject),
`test_forgejo_backend.py`, `test_forgejo_golden.py` (the
`tests/fixtures/forgejo/` goldens stay — the e2e smoke uses them),
`test_gh_api.py`, `test_github_context.py`, `test_http_client.py`,
`test_human_review_dispositions.py`, `test_human_reviews.py`,
`test_human_reviews_context_switch.py`, `test_image_digest_analysis.py`,
`test_issue_749_path_classification.py` (the #749 signal model stays covered
by `tests-v3/classification.test.ts` and the classification parity fixtures),
`test_linear_context.py`, `test_linked_sources.py`, `test_max_tokens.py`,
`test_mcp_client.py`, `test_metadata.py`, `test_metadata_extended.py`,
`test_model_parsing.py` (self-contained #32 parse-contract fixture test; the
contract is pinned on the v3 side by the `tests-v3` verdict tests and the
verdict parity boundary), `test_native_loop_exfil_redteam.py` (re-home the
#252 adversarial pattern on a v3 fence before deleting — wave 0),
`test_native_loop_verdict_recovery.py`, `test_native_tool_loop.py`,
`test_outbound_user_agent.py` (same wave-0 note as the redteam exemplar),
`test_platform.py`, `test_platform_gh_api_forgejo.py`, `test_pr_thread.py`,
`test_precheck.py`, `test_redact.py`, `test_redirect_ssrf.py`,
`test_related_context.py`, `test_repo_map.py`, `test_requirement_coverage.py`,
`test_requirement_ledger.py`, `test_resolved_ip_ssrf.py`,
`test_response_parser.py`, `test_review_threads.py`, `test_role_selection.py`,
`test_run_native_loop_wiring.py`, `test_run_specialists.py`,
`test_run_specialists_overrun.py`, `test_run_specialists_payloads.py`,
`test_run_specialists_scout.py`, `test_sanitize_review_markdown.py`,
`test_sarif.py`, `test_selection_fingerprint.py`, `test_specialist_corpus.py`,
`test_specialists.py`, `test_specialists_enforcement_neutrality.py`,
`test_specialists_native_loop.py`, `test_specialists_section.py`,
`test_sse_reassembler.py`, `test_strip_empty_conditional_sections.py`,
`test_strip_metadata_markers.py`, `test_strip_source_text.py`,
`test_tangled_session.py`, `test_thread_dispositions.py`,
`test_tier_context.py`, `test_tool_budget_tiers.py`, `test_tool_executors.py`,
`test_tool_harness_command_guardrails.py`, `test_tool_harness_status.py`,
`test_tool_loop.py`, `test_tool_loop_telemetry.py`,
`test_tool_max_requests.py`, `test_tool_planning_context.py`,
`test_tool_planning_rename.py`, `test_tool_request_normalization.py`,
`test_tool_surface.py`, `test_transport.py`,
`test_verdict_contract_equivalence.py`, `test_web_search.py`, and
`tests/unit/test_precheck_unit.py`.

Bash (`tests/`): `test_advisory_parallel.sh`, `test_approval_guardrails.sh`,
`test_artifact_paths.sh`, `test_artifact_paths_drift.sh` (the #495 symlink
guard protects the v2 publish write path; a v3-side write-inventory guard,
if wanted, must be re-derived from `src/` — follow-up issue),
`test_check_review_needed.sh`, `test_ci_api_timeout.sh` (dies at wave 2 with
its (c) subjects — it is the `validate-bash-timeout` suite),
`test_ci_status_check.sh`, `test_classification_steering.sh`,
`test_cleanup_native_reviews_behavior.sh`,
`test_cleanup_previous_native_reviews.sh`, `test_compare_sha_extraction.sh`,
`test_concurrent_gating.sh` (dies at wave 1 with `sections/gating.sh` — it is
the `validate-bash-gating` suite), `test_context_budget.sh`,
`test_deep_review_wiring.sh`, `test_emit_review_markers.sh`,
`test_fallback_config_validation.sh`, `test_linked_issue_classification.sh`,
`test_model_call.sh`, `test_model_failure.sh`,
`test_native_verdict_recovery.sh`, `test_platform_api.sh`,
`test_precheck_linear_fingerprint.sh`, `test_pr_thread_wiring.sh`,
`test_publish_dispatch.sh`, `test_related_code_wiring.sh`,
`test_required_checks.sh`, `test_requirement_ledger_wiring.sh`,
`test_review_escalation.sh`, `test_review_routing.sh`,
`test_specialist_leads_wiring.sh`, `test_standards_file_resolution.sh`,
`test_standards_presence_signal.sh`, `test_step_summary.sh`,
`test_system_prompt_fragments.sh`, `test_tool_harness_enforcement.sh`,
`test_tool_harness_presence_signal.sh`, `test_tool_loop_wiring.sh`,
`test_tool_trace_output.sh`, `test_verdict_contract.sh`,
`test_verdict_safety.sh`, `test_verify_pr_head.sh`, and
`tests/smoke_test.sh` (drives only v2: `scripts/run_tool_harness.py`, the
mock server, and an inline copy of the v2 parse step) together with
`tests/mock_openai_server.py` (its only consumer).

Also deleted: `tests/slow-bash-suites.txt` (its two rows are the two slow
suites above; the second goes at wave 2), and — wave 1 — the
`validate-bash-gating` CI job, the `validate-bash` "Run smoke test" step, and
the `validate-static` "Verify smoke test helper is executable" step (see
[CI jobs that become dead](#ci-jobs-that-become-dead)).

## (b) keep — retained tooling, with concrete consumers

### scripts/

| File | Consumer(s) |
| --- | --- |
| `scripts/build-v3.mjs` | `package.json` `build`/`test` scripts (esbuild bundle). |
| `scripts/generate-action-yml.mjs` | Generates the shipped `action.yml`; `tests-v3/action-yml.test.ts` fails on drift. |
| `scripts/generate-v3-contract.mjs` | `package.json` `typecheck`/`build`; embeds the prompt assets (next two rows) into `src/prompt/assets.ts`. |
| `scripts/default_system_prompt.txt` | Build asset read by `scripts/generate-v3-contract.mjs`. |
| `scripts/prompt_fragments/*.txt` (14 files) | Build assets walked by `scripts/generate-v3-contract.mjs`; `tests-v3/specialists-gate.test.ts` reads `specialist_correctness_adversarial.txt`. |
| `scripts/eval_harness.py` | `.github/workflows/eval-harness.yaml`; `tests/test_eval_*.py`. |
| `scripts/eval_weekly_summary.py` | `.github/workflows/eval-harness.yaml`; `tests/test_eval_weekly_summary.py`, `tests/test_eval_harness_workflow_lint.py`. |
| `scripts/run_semantic_eval_ci.py` | `.github/workflows/ci.yaml` (`validate-python` semantic regression gate); `tests/parity_harness.py` `semantic-qualification-666` gate. |
| `scripts/live_judge_score.py` | `docs/evals.md` runbook; `tests/test_live_judge_score.py` (manual semantic-judge scoring). |
| `scripts/run_judge_calibration.py` | `docs/evals.md` runbook; invoked with `scripts/live_judge_score.py`; `tests/test_run_judge_calibration.py`. |
| `scripts/harvest_human_findings.py` | `.github/workflows/harvest-human-findings.yaml`; `tests/test_harvest_human_findings.py`. |
| `scripts/merge_bot_branch_corpus.py` | `harvest-human-findings.yaml` and `scripts/push_harvest_branch.sh`; `tests/test_merge_bot_branch_corpus.py`. |
| `scripts/push_harvest_branch.sh` | `harvest-human-findings.yaml`; `tests/test_push_harvest_branch.sh`. |
| `scripts/resolve_harvest_scope.sh` | `harvest-human-findings.yaml`; `tests/test_resolve_harvest_scope.sh`. |
| `scripts/fork_review_gate.py` | `.github/workflows/fork-ai-review.yaml` (`gate` and `verify` steps); `tests/test_fork_review_gate.py`, `tests/test_fork_review_workflow.py`. |
| `scripts/release/tag-with-dist.sh` | `.github/workflows/manual-release.yml`; `tests/test_release_tag_with_dist.sh`. |

### pr_reviewer/

| File | Consumer(s) |
| --- | --- |
| `pr_reviewer/semantic_eval.py` | Imported by `scripts/eval_harness.py`, `scripts/run_semantic_eval_ci.py`, `scripts/live_judge_score.py`; exercised by `tests/test_issue_662_dataflow.py`. |
| `pr_reviewer/semantic_judge.py` | Imported by `pr_reviewer/semantic_eval.py`, `scripts/live_judge_score.py`, `scripts/run_judge_calibration.py`. |
| `pr_reviewer/metadata.py` | Imported by `scripts/harvest_human_findings.py` (also consumed by v2 precheck until wave 1). |

### tests/

| File | Consumer(s) / subject |
| --- | --- |
| `test_action_inputs.py`, `test_action_v3_contract.py` | Pin the shipped `action.yml` / `contracts/action-v3.yml` (v3 CI). |
| `test_agents_md_budget.py` | AGENTS.md budget regression guard (repo hygiene, not v2). |
| `test_dogfood_workflow.py` | Pins `.github/workflows/ai-pr-review.yaml` + `action.yml` defaults. |
| `test_html_entities_table.py` | Pins `src/context/html-entities.ts` (v3) to CPython's `html.entities` tables. |
| `test_parity_harness.py` | The parity harness itself (CLI/exit-code contract). |
| `test_eval_harness.py`, `test_eval_harness_boundary.py`, `test_eval_harness_fixture_fork.py`, `test_eval_harness_real_pr_corpus.py`, `test_eval_harness_repo_context.py`, `test_eval_harness_scout.py`, `test_eval_harness_semantic.py`, `test_eval_harness_specialists.py`, `test_eval_harness_specialists_corpus.py`, `test_eval_harness_workflow_lint.py`, `test_eval_weekly_summary.py` | Import/exercise `scripts/eval_harness.py` and `scripts/eval_weekly_summary.py`. Wave-0 notes: the first two re-point their `run_review.sh` string fixtures when the harness moves; `test_eval_harness_repo_context.py` touches v2 sections only through the harness's repo-context mode. |
| `test_semantic_eval.py`, `test_semantic_judge.py` | Import `pr_reviewer/semantic_eval.py` / `semantic_judge.py`; `test_semantic_eval.py` also asserts `scripts/sections/corpus.sh` content — re-point that assertion in wave 2 when the sections go. |
| `test_live_judge_score.py`, `test_run_judge_calibration.py` | The judge tooling above. |
| `test_harvest_human_findings.py`, `test_harvest_human_findings_workflow.py`, `test_merge_bot_branch_corpus.py`, `test_push_harvest_branch.sh`, `test_resolve_harvest_scope.sh` | The harvest tooling and its workflow. |
| `test_fork_review_gate.py`, `test_fork_review_workflow.py` | `scripts/fork_review_gate.py` and the fork workflow (docstring mentions `scripts/verify_pr_head.sh` — drop in wave 1). |
| `test_release_tag_with_dist.sh` | `scripts/release/tag-with-dist.sh`. |
| `test_forgejo_e2e_smoke_safety.sh` | Guards `tests/forgejo_e2e_smoke.sh`. |
| `tests/_lib/assert.sh` | Bash helper sourced by every retained suite. |

Preserved data (not Python/bash, listed for completeness): `tests/fixtures/`
(`parity/`, `forgejo/`, `requirement-ledger/`, `v3-runtime/`, `failure_paths/`,
`eval_weekly_summary/`) and the `evals/` corpora — the deterministic parity,
#662, and Forgejo qualification fixtures #706 says to preserve.

## (c) keep temporarily — parity oracles, with deletion conditions

All of these exist after wave 1 only because the parity harness (or the
dataflow gate) still executes them, or the Forgejo smoke / a v3 test still
reads them. Condition shorthand: **freeze boundary X** = at the #681 gate the
boundary is declared frozen (fixtures become goldens) and its v2 side is
deleted together with the runner.

### scripts/

| File | Concrete consumer(s) | Deletion condition |
| --- | --- | --- |
| `scripts/check_review_needed.sh` | `tests/parity_harness.py` (precheck boundary, direct) and `tests/parity_runners/v2_precheck.py`; `tests/forgejo_e2e_smoke.sh`. | Freeze the precheck boundary **and** re-point the Forgejo smoke (wave 0). |
| `scripts/build_selection_fingerprint.py` | Invoked by `scripts/check_review_needed.sh`; `tests/parity_runners/v2_precheck.py`. | Freeze the precheck boundary. |
| `scripts/wait_for_ci.sh` | `tests/parity_harness.py` (ci-gate boundary, direct); `tests/parity_runners/v2_ci_gate.py`; `tests/forgejo_e2e_smoke.sh`. | Freeze the ci-gate boundary **and** re-point the Forgejo smoke. |
| `scripts/run_specialists.py` | `tests/parity_harness.py` (specialists-gate boundary, direct); `tests/parity_runners/v2_specialists_gate.py`, `v2_specialist_normalize.py`, `v2_specialist_payload.py`. | Freeze the specialists-gate boundary. |
| `scripts/build_specialist_corpus.py` | Invoked by `scripts/run_specialists.py`. | Same as `run_specialists.py`. |
| `scripts/platform_api.sh` | `tests/parity_runners/v2_platform_normalization.py`; `tests/forgejo_e2e_smoke.sh`. | Freeze the platform-normalization boundary **and** re-point the Forgejo smoke. |
| `scripts/model_call.sh` | `tests/parity_runners/v2_request.sh` (model-request boundary); read by `tests-v3/request.test.ts` (inlined in wave 0). | Freeze the model-request boundary. |
| `scripts/artifact_paths.sh` | Sourced by `check_review_needed.sh`, `run_specialists.py` and the sections below. | Wave 2 with the last file that sources it. |
| `scripts/run_enrichment.py` | `tests/parity_runners/v2_enrichment.py`, `v2_linked_sources.py`; eval pipeline (`sections/context.sh`/`enrichment.sh`). | Freeze the enrichment/linked-sources boundaries; eval re-pointed in wave 0. |
| `scripts/image_digest_analysis.py` | `tests/parity_runners/v2_image_provenance.py`; eval pipeline. | Freeze the image-provenance boundary. |
| `scripts/run_evidence_providers.py` | `tests/parity_runners/v2_evidence_providers.py` (which sources `sections/classification.sh` + `common.sh` around it); eval pipeline. | Freeze the evidence boundary. |
| `scripts/run_tool_harness.py` | `tests/parity_runners/v2_corpus.sh`, `v2_tool_budget.py`; eval pipeline (`sections/corpus.sh`, `review.sh`). | Freeze the corpus and tool-budget boundaries. |
| `scripts/summarize_tool_loop_telemetry.py` | Invoked by `scripts/run_tool_harness.py`. | Wave 2 with `run_tool_harness.py`. |
| `scripts/build_repo_map.py` | `tests/parity_runners/v2_repo_map.py`; eval pipeline (`sections/context.sh`). | Freeze the repo-map boundary. |
| `scripts/build_related_context.py` | `tests/parity_runners/v2_related_code.py`; eval pipeline. | Freeze the related-code boundary. |
| `scripts/prioritize_diff.py` | `tests/parity_runners/v2_diff_priority.py`; eval pipeline (`sections/corpus.sh`). | Freeze the diff-priority boundary. |
| `scripts/strip_source_text.py` | Dual-side goldens `tests/test_strip_source_text_diff.py` (v2 side vs `node dist/index.js strip-source-text-fixture`); v2 `pr_reviewer/linked_sources.py`. | Freeze the linked-sources boundary; re-freeze the goldens v3-only. |
| `scripts/publish.sh` | `tests/parity_runners/v2_metadata_markers.py` chain; referenced by the frozen `tests/parity_runners/v2-action.yml` composite oracle. | Freeze the publication boundaries. Not on the eval path (the harness never publishes). |
| `scripts/publish_helpers.sh` | `tests/parity_runners/v2_metadata_markers.py`; frozen `v2-action.yml`. | Freeze the metadata-marker boundary. |
| `scripts/build_review_comments.py` | `tests/parity_runners/v2_inline_findings.py`; `scripts/publish_helpers.sh`. | Freeze the inline-findings boundary. |
| `scripts/sanitize_review_markdown.py` | `tests/parity_runners/v2_sanitize.py`; `scripts/publish_helpers.sh`. | Freeze the sanitize boundary. |
| `scripts/strip_metadata_markers.py` | `tests/parity_runners/v2_metadata_markers.py`; `scripts/publish_helpers.sh`. | Freeze the metadata-marker boundary. |
| `scripts/strip_empty_conditional_sections.py` | `scripts/publish_helpers.sh` (and the sanitize runner chain). | Freeze the publication boundaries. |
| `scripts/load_shared_env.sh` | Sourced by the frozen `tests/parity_runners/v2-action.yml` composite oracle (lines 1106–1107 and 1168–1169). | Freeze the config-default-resolution boundary. |
| `scripts/sections/common.sh` | `tests/parity_runners/v2_config.sh`, `v2_corpus_slicer.py`, `v2_evidence_providers.py`; eval pipeline. | Freeze the config/evidence boundaries. |
| `scripts/sections/config.sh` | `tests/parity_runners/v2_config.sh` + `dump_v2_config.py`, `v2_context_producers.py`, `v2_prompt_assembly.py`; eval pipeline. | Freeze the config/prompt-assembly boundaries. |
| `scripts/sections/classification.sh` | `tests/parity_runners/v2_context_producers.py`, `v2_evidence_providers.py`; eval pipeline. | Freeze the context-producers/evidence boundaries. |
| `scripts/sections/context.sh` | `tests/parity_runners/v2_context_producers.py`, `v2_platform_normalization.py`; eval pipeline. | Freeze the context-producers/platform boundaries. |
| `scripts/sections/corpus.sh` | `tests/parity_runners/v2_corpus.sh` + `v2_corpus_slicer.py`, `v2_context_producers.py`; eval pipeline. | Freeze the corpus boundary. |
| `scripts/sections/review.sh` | `tests/parity_runners/v2_prompt_assembly.py`; eval pipeline. | Freeze the prompt-assembly boundary. |
| `scripts/sections/gating.sh` | `tests/test_issue_662_dataflow.py:131` reads it directly for the harness's `dataflow-qualification-698` gate; eval pipeline. | Re-point or retire the dataflow gate, then wave 2. |

### pr_reviewer/

Every module below is executed by a named parity runner (the harness's v2
side) and/or by the eval pipeline via the sections above. Deletion condition
for all of them: **freeze the boundary/boundaries that exercise it** (eval
pipeline consumers disappear in wave 0). `pr_reviewer/__init__.py` goes last.

| Module | Runner(s) / direct harness use |
| --- | --- |
| `precheck.py` | `v2_precheck.py`; the harness imports it for the precheck boundary. |
| `classifier.py` | `v2_classification.py`. |
| `role_selection.py` | `v2_classification.py`. |
| `completeness.py` | `v2_enforcement.py`, `v2_required_checks.py`; the harness imports it. |
| `enforcement.py` | `v2_enforcement.py`. |
| `escalation.py` | `v2_escalation.py`. |
| `response_parser.py` | `v2_verdict.py`. |
| `conversation.py` | `v2_conversation.py`, `v2_tool_loop.py`. |
| `sse_reassembler.py` | Via `config.sh`/`transport.py` chains (`v2_config.sh`, `v2_specialists_gate.py`). |
| `transport.py` | `v2_specialists_gate.py`. |
| `tangled_session.py` | Via `transport.py` (`v2_specialists_gate.py`). |
| `tool_loop.py` | `v2_tool_loop.py`. |
| `tool_executors.py` | Via `run_tool_harness.py` (`v2_corpus.sh`, `v2_tool_budget.py`). |
| `mcp_client.py` | Via `run_tool_harness.py`. |
| `budget.py` | Via `run_enrichment.py`/`linked_sources.py` (`v2_enrichment.py`, `v2_linked_sources.py`). |
| `enrichment.py` | `v2_enrichment.py`, `v2_linked_sources.py`. |
| `linked_sources.py` | `v2_linked_sources.py`. |
| `http_client.py` | Via `v2_platform_normalization.py`. |
| `platform.py` | `v2_precheck.py`. |
| `forgejo_backend.py` | `v2_platform_normalization.py`. |
| `github_context.py` | Via `build_selection_fingerprint.py` (`v2_precheck.py`) and `sections/context.sh`. |
| `linear_context.py` | `v2_context_producers.py` (+ `_stub`), `v2_precheck.py`. |
| `human_reviews.py` | `v2_human_reviews.py`. |
| `review_threads.py` | `v2_review_threads.py`. |
| `pr_thread.py` | `v2_pr_thread.py`. |
| `repo_map.py` | `v2_repo_map.py`. |
| `related_context.py` | `v2_related_code.py`, `v2_context_producers.py`. |
| `change_anchors.py` | `v2_change_anchors.py`, `v2_context_producers.py`. |
| `diff_priority.py` | `v2_diff_priority.py`. |
| `requirement_coverage.py` | `v2_requirement_coverage.py`, `v2_enforcement.py`. |
| `requirement_ledger.py` | `v2_requirement_ledger.py`. |
| `specialists.py` | `v2_specialist_normalize.py`; `sections/corpus.sh`. |
| `specialist_corpus.py` | `v2_specialist_corpus.py`. |
| `sarif.py` | `v2_evidence_providers.py`; the harness imports it. |
| `env.py` | Via `run_evidence_providers.py` (`v2_evidence_providers.py`). |

### tests/

| File | Concrete consumer(s) | Deletion condition |
| --- | --- | --- |
| `tests/parity_runners/*` (all 47 files) | `tests/parity_harness.py` boundary registry; `tests/test_tool_planning_rename.py` and docs reference `v2-action.yml` textually. | Freeze each boundary at #681; runner helpers (`repo_fixture.py`, `dump_v2_config.py`, `truncate_clean.sh`, `v2_corpus_slicer.py`, `v2_context_producers_stub.py`, `v2-action.yml`) go with their boundaries. |
| `test_prompt_assembly_fixtures.py` | Executes `tests/parity_runners/v2_prompt_assembly.py` over the prompt-assembly fixtures. | Freeze the prompt-assembly boundary. |
| `test_linked_sources_goldens.py` | Executes `tests/parity_runners/v2_linked_sources.py`. | Freeze the linked-sources boundary. |
| `test_platform_normalization_goldens.py` | Executes `tests/parity_runners/v2_platform_normalization.py`. | Freeze the platform-normalization boundary. |
| `test_corpus_body_fence_truncation.py` | Executes `tests/parity_runners/v2_corpus.sh` (#791 fence-truncation regression over the corpus fixtures). | Freeze the corpus boundary. |
| `test_strip_source_text_diff.py` | Dual-side goldens: v2 `scripts/strip_source_text.py` vs `node dist/index.js strip-source-text-fixture`. | Freeze the linked-sources boundary; keep the v3-only goldens. |
| `test_issue_662_dataflow.py` | The parity harness's `dataflow-qualification-698` gate; imports `pr_reviewer/semantic_eval.py`; reads `scripts/sections/{config,corpus,gating}.sh`. | The #662 fixtures are on the preserve list — when the gate retires, keep the fixtures and re-home the test v3-only. |

## CI jobs that become dead

In `.github/workflows/ci.yaml`:

| Job / step | Dies | Why |
| --- | --- | --- |
| `validate-bash-gating` | Wave 1 | Its only assignment in `tests/slow-bash-suites.txt` is `tests/test_concurrent_gating.sh`, which sources `scripts/sections/gating.sh` — (a), wave 1. |
| `validate-bash-timeout` | Wave 2 | Its only assignment is `tests/test_ci_api_timeout.sh`, which exercises the (c) `scripts/platform_api.sh` + `scripts/wait_for_ci.sh`. |
| `validate-bash` → "Run smoke test" step | Wave 1 | `tests/smoke_test.sh` is (a). |
| `validate-static` → "Verify smoke test helper is executable" | Wave 1 | Same. |
| `tests/slow-bash-suites.txt` + the slow-suite guard loop inside `validate-bash` | Wave 2 | Both rows gone. |

Not dead but re-scoped at each wave:

- `validate` (aggregate): `needs` shrinks as the two slow jobs die; the
  explicit per-job result check keeps its always()-evaluate semantics.
- `validate-bash`: auto-discovery continues over the four surviving suites
  (`test_forgejo_e2e_smoke_safety.sh`, `test_push_harvest_branch.sh`,
  `test_release_tag_with_dist.sh`, `test_resolve_harvest_scope.sh`).
- `validate-static`: "Check shell scripts" (`bash -n`) and the shellcheck
  scope shrink to the surviving scripts (release, harvest, and the (c)
  holdovers until wave 2); "Verify Forgejo E2E smoke harness parses" stays.
- `validate-python`: the `py_compile` find over `scripts pr_reviewer tests`
  shrinks; `pytest --cov=pr_reviewer --cov=scripts --cov-fail-under=72` needs
  its denominator and threshold re-baselined after each wave (the coverage
  gate is scoped to the v2 trees by design).

## Verification for the teardown commits

Per #706's required verification, each deletion wave proves:

- `git grep` shows no remaining reference to any deleted path outside the
  deletion commit itself (docs updated in wave 0; port-provenance comments in
  `src/` excluded as history);
- `npm ci && npm run typecheck && npm test` stays green (the shipped action
  never required Python; no `jq`/`curl`/`gh` for internal orchestration);
- the parity harness (retained boundaries), the semantic gate
  (`scripts/run_semantic_eval_ci.py`), and the Forgejo E2E smoke stay green;
- the surviving `pytest tests/` selection passes with the re-baselined
  coverage gate;
- CodeQL, gitleaks, actionlint, and bundle-freshness checks stay green;
- after wave 2: `find scripts pr_reviewer -name '*.py'` returns only the (b)
  tooling, and the shipped action executes with no Python interpreter
  installed.
