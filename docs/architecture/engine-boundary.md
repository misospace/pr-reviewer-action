# Review engine boundary (#726)

The review pipeline is one action-independent engine. `src/engine/review.ts` owns precheck/fingerprint interplay, context and enrichment, classification and role selection, requirements, corpus assembly, model routing/conversation/tool loop, evidence execution, deterministic enforcement, and the final structured verdict. The engine consumes a `ReviewRequest` and injected `ReviewDependencies`; it does not receive a path to `process.env` or resolve `GITHUB_*`/`INPUT_*` bindings itself.

The host remains responsible for webhook/event reception, installation auth, durable queue/state, repository clone/cache lifecycle, executor scheduling, controller HTTP API, and final forge publication orchestration. The engine is review-only: publication remains outside it.

`ReviewRequest` carries forge/repository identity, PR/head/base state, raw contract inputs, explicit ambient forge context, trigger reason, rereview intent, and optional cancellation. `ReviewDependencies` supplies workspace/run directories, platform-read capabilities, output/summary sinks, and injectable runtime hooks. The `src/run/review.ts` adapter is the Action/`run`-CLI boundary: its only job is translating runner environment and defaults into those engine contracts.

A local host can invoke the JSON request CLI with `node dist/index.js engine --request request.json`. The request contains the `ReviewRequest` fields and explicit `workspace`, `runDir`, `outputsSink`, and optional `stepSummaryPath`/`persistArtifacts`; it never publishes. CI-gate subprocess re-entry is intentionally unavailable unless a host explicitly provides a bundle entry.

Parity policy: changes to the engine must preserve the Action adapter behavior. `tests-v3/engine.test.ts` pins Action-free engine execution, engine/adapter structured-result parity, cancellation, provenance redaction, and the local CLI contract alongside the existing `run.test.ts` behavior surface.

This boundary is the foundation for #725; queueing, worker lifecycle, and controller responsibilities remain external capabilities rather than duplicated reviewer logic.
