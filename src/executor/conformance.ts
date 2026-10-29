/** Executor conformance suite for #733: the behavioral contract every
 * `Executor` implementation must satisfy, as a REUSABLE library module.
 *
 * This module deliberately does NOT import `node:test`: it exports pure
 * async test definitions (`ConformanceTest`) that a test file registers
 * with its own runner (`node --test`, or any future harness). One suite,
 * every executor: `tests-v3/executor-conformance.test.ts` runs it over
 * the real `LocalExecutor` and over a scripted in-process fake, proving
 * a non-local executor satisfies the same scenarios without spawning
 * processes.
 *
 * Scenario injection: the suite never builds executor-specific state on
 * its own. Each scenario names itself (`ConformanceScenario`), and the
 * suite user supplies
 * - `requestOf(scenario)` — the scenario's `ExecutionRequest` (the local
 *   executor is file-based and needs real temp paths; a fake does not),
 * - `executorFor(scenario)` — the executor under test for that scenario
 *   (defaults to the single `factory` executor; needed when the
 *   implementation's worker behavior is scenario-specific, as the local
 *   executor's fixture worker is).
 * - `restartedExecutorFor(scenario)` — the RESTARTED controller for that
 *   scenario: an executor instance that holds NO in-memory handle for the
 *   run, because the controller it replaces restarted (defaults to
 *   `executorFor`). The recovered-cancellation scenario needs one: with the
 *   handle gone, the cancellation can only work by correlation identity.
 *
 * Assertions use `node:assert/strict` INSIDE the definitions — a runtime
 * import of the assertion library, not a test framework. Every scenario
 * is one test definition; shared assertion logic is factored, never
 * duplicated.
 */

import assert from "node:assert/strict";
import {
  validateExecutionRequest,
  type ExecutionCredentialRef,
  type ExecutionRequest,
  type Executor,
} from "./types.js";

/** The scenario name union — the key every injection hook is keyed by. */
export type ConformanceScenario =
  | "happy-path"
  | "duplicate-collect"
  | "cancel-before-settle"
  | "deadline"
  | "past-deadline"
  | "worker-crash"
  | "no-result"
  | "stale-result"
  | "reconcile-unknown"
  | "reconcile-running"
  | "reconcile-terminal"
  | "recovered-cancel";

/** One conformance scenario, as a pure async definition a test file
 * registers with its runner. */
export interface ConformanceTest {
  readonly name: string;
  readonly run: () => Promise<void>;
}

/** Injection surface for the suite. Every hook is optional; the defaults
 * suit executors that never touch the filesystem (pure fakes). */
export interface ConformanceOptions {
  /** The scenario's execution request. Default:
   * `defaultConformanceRequest` — sentinel paths, no filesystem side
   * effects; a file-based executor MUST supply real paths (and own their
   * cleanup). The returned request is re-validated fail-closed before
   * use. */
  readonly requestOf?: (
    scenario: ConformanceScenario,
  ) => ExecutionRequest | Promise<ExecutionRequest>;
  /** The executor under test for one scenario. Default: the `factory`.
   * Supply this when worker behavior is scenario-specific (the local
   * executor picks its worker scenario per request). */
  readonly executorFor?: (scenario: ConformanceScenario) => Executor;
  /** The RESTARTED controller for one scenario: an executor instance that
   * holds NO in-memory handle for the run (the controller it replaces
   * restarted, so its handle is gone). Default: the `executorFor` executor
   * — a suite over an executor whose instances are already fresh per call
   * needs nothing more, while an executor that keeps its handles in
   * memory must hand over a fresh instance here. */
  readonly restartedExecutorFor?: (scenario: ConformanceScenario) => Executor;
}

/** The default scenario request: a fully valid `ExecutionRequest` with
 * sentinel paths under the conformance root — no directory is created and
 * no file is written by building it. runId/jobId derive from the scenario
 * so correlation failures are self-describing. */
export function defaultConformanceRequest(scenario: ConformanceScenario): ExecutionRequest {
  const runId = `conformance-${scenario}`;
  const runDir = `/tmp/pr-reviewer-conformance/${runId}`;
  const headSha = "aa11bb22cc33dd44ee55ff667788990001122334";
  return Object.freeze({
    jobId: `job-${scenario}`,
    runId,
    attempt: 1,
    kind: "review" as const,
    platform: "github" as const,
    repoFullName: "owner/repo",
    prNumber: 1,
    headSha,
    baseSha: "dd44ee55ff66aa77bb88cc99001122334455667788",
    deadlineAtMs: 0,
    workspace: Object.freeze({
      rootPath: `${runDir}/workspace`,
      headSha,
      mergeBaseSha: "dd44ee55ff66aa77bb88cc99001122334455667788",
      platform: "github" as const,
      repoFullName: "owner/repo",
      createdAtMs: 0,
    }),
    profiles: Object.freeze({
      executor: "conformance",
      model: "conformance",
      evidence: "conformance",
    }),
    credentials: Object.freeze([]) as readonly ExecutionCredentialRef[],
    runDir,
    requestPath: `${runDir}/request.json`,
    resultPath: `${runDir}/result.json`,
  });
}

/** The conformance scenarios, one test definition each:
 *
 * - start → observe → collect happy path: the completed result carries
 *   the request's runId/jobId/headSha correlation.
 * - duplicate collect: the identical frozen result (first terminal wins),
 *   and the underlying execution is not re-run (reconcile still reports
 *   the same completed result).
 * - cancel before settle: status "cancelled", cancel idempotent.
 * - deadline expiry → failed `deadline`.
 * - worker crash → failed `worker_crash`.
 * - worker exits without a result → failed `no_result`.
 * - a result from a foreign correlation identity → failed `stale_result`.
 * - a deadline already past at start → failed `deadline` without launching.
 * - reconcile for an unknown correlation → `{kind: "none"}`.
 * - reconcile while the worker is alive → `{kind: "running"}`.
 * - reconcile after terminal → `{kind: "settled"}` with the same result.
 * - recovered cancellation: a run whose controller RESTARTED (the handle
 *   is gone) is terminated by its correlation identity alone.
 */
export function executorConformanceTests(
  factory: () => Executor,
  options: ConformanceOptions = {},
): readonly ConformanceTest[] {
  const requestOf = options.requestOf ?? defaultConformanceRequest;
  const executorFor = options.executorFor ?? factory;
  // The restarted controller falls back to the executor under test: an
  // executor whose instances are already fresh per call needs no second
  // hook, and a pure fake has no handle to lose.
  const restartedExecutorFor = options.restartedExecutorFor ?? executorFor;
  const requestFor = async (scenario: ConformanceScenario): Promise<ExecutionRequest> =>
    validateExecutionRequest(await requestOf(scenario));

  /** Shared failed-outcome assertion for the failure-classification
   * scenarios (deadline, crash, no-result, stale-result). */
  const expectFailed = async (
    scenario: ConformanceScenario,
    category: string,
  ): Promise<void> => {
    const request = await requestFor(scenario);
    const handle = await executorFor(scenario).start(request, new AbortController().signal);
    const result = await handle.collect();
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, category);
    assert.equal(result.resultHeadSha, "", "a failed result never carries a head");
    assert.notEqual(result.failureMessage, "");
  };

  return Object.freeze([
    {
      name: "start → observe → collect: the completed result carries the request correlation",
      run: async () => {
        const request = await requestFor("happy-path");
        const handle = await executorFor("happy-path").start(request, new AbortController().signal);
        const before = await handle.observe();
        // A non-terminal report never carries a status (sentinel
        // discipline); the phase itself may race ahead to terminal.
        if (before.phase !== "terminal") assert.equal(before.status, "");
        const result = await handle.collect();
        assert.equal(result.status, "completed");
        assert.ok(Object.isFrozen(result));
        assert.equal(result.runId, request.runId);
        assert.equal(result.jobId, request.jobId);
        assert.equal(result.resultHeadSha, request.headSha);
        const after = await handle.observe();
        assert.equal(after.phase, "terminal");
        assert.equal(after.status, "completed");
      },
    },
    {
      name: "duplicate collect is idempotent: the identical frozen result, no re-run",
      run: async () => {
        const request = await requestFor("duplicate-collect");
        const executor = executorFor("duplicate-collect");
        const handle = await executor.start(request, new AbortController().signal);
        const first = await handle.collect();
        assert.equal(first.status, "completed");
        const second = await handle.collect();
        const third = await handle.collect();
        assert.ok(Object.is(first, second), "the identical frozen object, not a re-classification");
        assert.ok(Object.is(second, third));
        const reconciled = await executor.reconcile(request);
        assert.ok(reconciled.kind === "settled", "the underlying execution is not re-run");
        assert.equal(reconciled.result.status, "completed");
        assert.equal(reconciled.result.resultHeadSha, first.resultHeadSha);
      },
    },
    {
      name: "cancel before settle → cancelled, idempotent",
      run: async () => {
        const request = await requestFor("cancel-before-settle");
        const controller = new AbortController();
        const handle = await executorFor("cancel-before-settle").start(request, controller.signal);
        await handle.cancel();
        await handle.cancel();
        const result = await handle.collect();
        assert.equal(result.status, "cancelled");
        assert.equal(result.failureCategory, "");
        assert.equal(result.resultHeadSha, "");
        const after = await handle.observe();
        assert.equal(after.phase, "terminal");
        assert.equal(after.status, "cancelled");
      },
    },
    {
      name: "deadline expiry → failed deadline",
      run: async () => {
        await expectFailed("deadline", "deadline");
      },
    },
    {
      name: "a deadline already past at start → failed deadline, nothing launched or written",
      run: async () => {
        const request = await requestFor("past-deadline");
        const executor = executorFor("past-deadline");
        const handle = await executor.start(request, new AbortController().signal);
        const result = await handle.collect();
        assert.equal(result.status, "failed");
        assert.equal(result.failureCategory, "deadline");
        assert.notEqual(result.failureMessage, "");
        assert.equal(result.resultHeadSha, "");
        // Nothing was persisted: an already-expired execution leaves no
        // envelope or recovery state to reconcile against.
        const outcome = await executor.reconcile(request);
        assert.deepEqual(outcome, { kind: "none" });
      },
    },
    {
      name: "worker crash → failed worker_crash",
      run: async () => {
        await expectFailed("worker-crash", "worker_crash");
      },
    },
    {
      name: "worker exits without a result → failed no_result",
      run: async () => {
        await expectFailed("no-result", "no_result");
      },
    },
    {
      name: "a result from a foreign correlation identity → failed stale_result",
      run: async () => {
        await expectFailed("stale-result", "stale_result");
      },
    },
    {
      name: "reconcile for an unknown correlation → none",
      run: async () => {
        const request = await requestFor("reconcile-unknown");
        const outcome = await executorFor("reconcile-unknown").reconcile(request);
        assert.deepEqual(outcome, { kind: "none" });
      },
    },
    {
      name: "reconcile while the execution is alive → running",
      run: async () => {
        const request = await requestFor("reconcile-running");
        const executor = executorFor("reconcile-running");
        const handle = await executor.start(request, new AbortController().signal);
        const outcome = await executor.reconcile(request);
        assert.ok(outcome.kind === "running", `expected running, got '${outcome.kind}'`);
        await handle.cancel();
        const settled = await handle.collect();
        assert.equal(settled.status, "cancelled");
      },
    },
    {
      name: "reconcile after terminal → settled with the same completed result",
      run: async () => {
        const request = await requestFor("reconcile-terminal");
        const executor = executorFor("reconcile-terminal");
        const handle = await executor.start(request, new AbortController().signal);
        const collected = await handle.collect();
        assert.equal(collected.status, "completed");
        const reconciled = await executor.reconcile(request);
        assert.ok(reconciled.kind === "settled");
        assert.equal(reconciled.result.status, "completed");
        assert.equal(reconciled.result.runId, request.runId);
        assert.equal(reconciled.result.jobId, request.jobId);
        assert.equal(reconciled.result.resultHeadSha, collected.resultHeadSha);
        assert.equal(reconciled.result.resultArtifactPath, collected.resultArtifactPath);
      },
    },
    {
      name: "a recovered execution is cancelled by its correlation identity",
      run: async () => {
        const request = await requestFor("recovered-cancel");
        const started = executorFor("recovered-cancel");
        const handle = await started.start(request, new AbortController().signal);
        // The controller restarts: the next executor holds NO handle for
        // the run, so the cancellation can only work by correlation
        // identity.
        const restarted = restartedExecutorFor("recovered-cancel");
        const outcome = await restarted.cancel(request);
        assert.ok(outcome.kind === "terminated", `expected terminated, got '${outcome.kind}'`);
        // The worker is gone: the restarted controller no longer sees it
        // alive.
        const reconciled = await restarted.reconcile(request);
        assert.notEqual(reconciled.kind, "running", "the cancelled worker is not alive any more");
        // The original run settles too (its worker was terminated). The
        // exact terminal verdict differs per backend — a killed worker
        // settles `failed`, a deleted Job settles `orphaned` — but a
        // terminated run NEVER reports a completed result.
        await handle.cancel();
        const settled = await handle.collect();
        assert.notEqual(settled.status, "completed", "a terminated run never reports a completed result");
      },
    },
  ]);
}
