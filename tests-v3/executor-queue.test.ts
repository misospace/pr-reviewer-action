/** Queue-seam adapter (#733): the rich `Executor` contract rides inside
 * the queue's `JobExecutor` seam. Covers the result → `ExecutionOutcome`
 * mapping (head only on completed, category passthrough/fallback), the
 * builder- and collect-rejection mapping (mirroring the scheduler's
 * rejected-start shape), signal forwarding, and end-to-end dispatch: a
 * real `ReviewQueueController` over `InMemoryQueueStore` settling jobs
 * through the adapter. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryQueueStore,
  ReviewQueueController,
  newJobRecord,
  type ExecutionOutcome,
  type JobRecord,
  type SchedulerOptions,
} from "../src/queue/index.js";
import {
  toQueueJobExecutor,
  type ExecutionCancelOutcome,
  type ExecutionHandle,
  type ExecutionReconcileOutcome,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type QueueRequestBuilder,
} from "../src/executor/index.js";
import type { ReviewJob } from "../src/jobs/types.js";

// ── in-file harness ─────────────────────────────────────────────────────

const HEAD_SHA = "aa11bb22cc33dd44ee55ff667788990001122334";

function makeJob(jobId: string, overrides: Partial<ReviewJob> = {}): ReviewJob {
  return Object.freeze({
    jobId,
    kind: "review",
    trigger: "webhook",
    reason: "synchronize",
    platform: "github",
    installationId: "12345",
    repoFullName: "owner/repo",
    prNumber: 7,
    prId: 4242,
    headSha: HEAD_SHA,
    baseSha: "dd44ee55ff66aa77bb88cc99001122334455667788",
    configFingerprint: "",
    nonce: "",
    adoptionEpoch: "",
    eventReference: "",
    fork: false,
    deadlineAtMs: 0,
    runId: "",
    ...overrides,
  });
}

function makeRecord(jobId: string): JobRecord {
  return newJobRecord(makeJob(jobId), 1_000, 0);
}

/** The request for one (job, attempt) is DETERMINISTIC: the adapter builds
 * the request it dispatches, and the result it collects must correlate
 * with THAT request — so the harness must hand both sides the same
 * identity (a per-call counter would make every scripted result belong
 * to a different run than the request the adapter built). The attempt
 * number comes from the record, so a scheduler retry still gets its own
 * generation identity (`run-<job>-<attempt>`). */
function makeRequest(jobId: string, attempt: number): ExecutionRequest {
  const runId = `run-${jobId}-${attempt}`;
  const runDir = `/tmp/pr-reviewer-queue/${runId}`;
  return Object.freeze({
    jobId,
    runId,
    attempt,
    kind: "review",
    platform: "github",
    repoFullName: "owner/repo",
    prNumber: 7,
    headSha: HEAD_SHA,
    baseSha: "dd44ee55ff66aa77bb88cc99001122334455667788",
    deadlineAtMs: 0,
    workspace: Object.freeze({
      rootPath: `${runDir}/workspace`,
      headSha: HEAD_SHA,
      mergeBaseSha: "dd44ee55ff66aa77bb88cc99001122334455667788",
      platform: "github",
      repoFullName: "owner/repo",
      createdAtMs: 0,
    }),
    profiles: Object.freeze({ executor: "local-dev", model: "fast", evidence: "default" }),
    credentials: Object.freeze([]),
    runDir,
    requestPath: `${runDir}/request.json`,
    resultPath: `${runDir}/result.json`,
  });
}

function completedResult(request: ExecutionRequest): ExecutionResult {
  return Object.freeze({
    status: "completed" as const,
    runId: request.runId,
    jobId: request.jobId,
    resultHeadSha: request.headSha,
    failureCategory: "" as const,
    failureMessage: "",
    resultArtifactPath: request.resultPath,
    diagnostics: "",
    artifactPaths: Object.freeze([]),
    resourceMs: 1,
    observedAtMs: 1,
  });
}

function failedResult(request: ExecutionRequest, category: string, message: string): ExecutionResult {
  return Object.freeze({
    status: "failed" as const,
    runId: request.runId,
    jobId: request.jobId,
    resultHeadSha: "",
    failureCategory: category as ExecutionResult["failureCategory"],
    failureMessage: message,
    resultArtifactPath: "",
    diagnostics: "",
    artifactPaths: Object.freeze([]),
    resourceMs: 1,
    observedAtMs: 1,
  });
}

function cancelledResult(request: ExecutionRequest): ExecutionResult {
  return Object.freeze({
    status: "cancelled" as const,
    runId: request.runId,
    jobId: request.jobId,
    resultHeadSha: "",
    failureCategory: "" as const,
    failureMessage: "",
    resultArtifactPath: "",
    diagnostics: "",
    artifactPaths: Object.freeze([]),
    resourceMs: 0,
    observedAtMs: 1,
  });
}

/** A handle whose collect resolves one scripted result. */
function handleFor(result: ExecutionResult): ExecutionHandle {
  return {
    observe: async () =>
      Object.freeze({
        phase: "terminal" as const,
        status: result.status,
        observedAtMs: result.observedAtMs,
      }),
    cancel: async () => undefined,
    collect: async () => result,
  };
}

/** Executor stub scripted by a queue of results (or throwers). */
class StubExecutor implements Executor {
  readonly startedRequests: ExecutionRequest[] = [];
  readonly startedSignals: AbortSignal[] = [];

  constructor(private readonly next: () => Promise<ExecutionHandle>) {}

  async start(request: ExecutionRequest, signal: AbortSignal): Promise<ExecutionHandle> {
    this.startedRequests.push(request);
    this.startedSignals.push(signal);
    return this.next();
  }

  async reconcile(): Promise<ExecutionReconcileOutcome> {
    return { kind: "none" };
  }

  /** The correlation-keyed cancellation: the queue adapter never drives
   * it, so the stub only has to satisfy the seam. */
  async cancel(_request: ExecutionRequest): Promise<ExecutionCancelOutcome> {
    return { kind: "terminated" };
  }
}

function adapterOver(
  next: () => Promise<ExecutionHandle>,
  build: QueueRequestBuilder = async (record) => makeRequest(record.job.jobId, Math.max(1, record.attempt)),
): { adapter: ReturnType<typeof toQueueJobExecutor>; executor: StubExecutor } {
  const executor = new StubExecutor(next);
  return { adapter: toQueueJobExecutor(build, executor), executor };
}

/** Drain the executor → settle microtask chains (no real timers). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function waitForState(
  controller: ReviewQueueController,
  jobId: string,
  want: string,
): Promise<JobRecord> {
  for (let i = 0; i < 200; i += 1) {
    const record = controller.recordFor(jobId);
    if (record !== null && record.state === want) return record;
    await flush();
  }
  throw new Error(`job ${jobId} never reached state '${want}'`);
}

function baseOptions(executor: Executor): SchedulerOptions {
  const queueExecutor = toQueueJobExecutor(
    async (record) => makeRequest(record.job.jobId, Math.max(1, record.attempt)),
    executor,
  );
  return {
    maxConcurrent: 1,
    settleWindowMs: 0,
    leaseTtlMs: 1000,
    maxAttempts: 3,
    retryBaseMs: 100,
    retryMaxMs: 1000,
    executor: queueExecutor,
  };
}

// ── outcome mapping ─────────────────────────────────────────────────────

test("a completed collect maps to the scheduler outcome with the head", async () => {
  const request = makeRequest("job-a", 1);
  const { adapter, executor } = adapterOver(async () => handleFor(completedResult(request)));
  const signal = new AbortController().signal;
  const outcome = await adapter.start(makeRecord("job-a"), signal);
  // The scheduler reads failureCategory only on its failed path; the ""
  // sentinel of a non-failed result maps to the same "executor-error"
  // fallback its rejection path uses.
  assert.deepEqual(
    { ...outcome },
    { status: "completed", resultHeadSha: HEAD_SHA, failureCategory: "executor-error" },
  );
  assert.equal(executor.startedRequests.length, 1);
  assert.equal(executor.startedRequests[0]!.jobId, "job-a");
  assert.equal(executor.startedSignals[0], signal, "the scheduler's signal is forwarded to the executor");
});

test("a failed collect maps to a failed outcome with the category passthrough", async () => {
  const request = makeRequest("job-a", 1);
  const { adapter } = adapterOver(
    async () => handleFor(failedResult(request, "worker_error", "the worker exited with code 3")),
  );
  const outcome = await adapter.start(makeRecord("job-a"), new AbortController().signal);
  assert.deepEqual(
    { ...outcome },
    { status: "failed", resultHeadSha: "", failureCategory: "worker_error" },
  );
});

test("a cancelled collect maps to a cancelled outcome without a head", async () => {
  const request = makeRequest("job-a", 1);
  const { adapter } = adapterOver(async () => handleFor(cancelledResult(request)));
  const outcome = await adapter.start(makeRecord("job-a"), new AbortController().signal);
  assert.deepEqual(
    { ...outcome },
    { status: "cancelled", resultHeadSha: "", failureCategory: "executor-error" },
  );
});

test("resultHeadSha is '' unless the result completed, whatever the executor reported", async () => {
  // A misbehaving executor must not be able to smuggle a head through a
  // failed result: the adapter re-derives the sentinel from the status.
  const request = makeRequest("job-a", 1);
  const smuggled = Object.freeze({
    ...failedResult(request, "worker_error", "boom"),
    resultHeadSha: HEAD_SHA,
  }) as ExecutionResult;
  const { adapter } = adapterOver(async () => handleFor(smuggled));
  const outcome = await adapter.start(makeRecord("job-a"), new AbortController().signal);
  assert.equal(outcome.resultHeadSha, "");
});

// ── correlation: the adapter never trusts a backend's result identity ───

test("a result for a foreign runId is refused: the scheduler never sees a foreign success", async () => {
  // The boundary holds the result-correlation invariant for EVERY backend,
  // not only for the LocalExecutor: a result that belongs to another
  // generation must never reach the scheduler as a completed outcome.
  const request = makeRequest("job-a", 1);
  const foreign = Object.freeze({
    ...completedResult(request),
    runId: "run-somebody-else",
  }) as ExecutionResult;
  const { adapter } = adapterOver(async () => handleFor(foreign));
  const outcome = await adapter.start(makeRecord("job-a"), new AbortController().signal);
  assert.deepEqual(
    { ...outcome },
    { status: "failed", resultHeadSha: "", failureCategory: "stale_result" },
  );
});

test("a result for a foreign jobId is refused", async () => {
  const request = makeRequest("job-a", 1);
  const foreign = Object.freeze({
    ...completedResult(request),
    jobId: "job-b",
  }) as ExecutionResult;
  const { adapter } = adapterOver(async () => handleFor(foreign));
  const outcome = await adapter.start(makeRecord("job-a"), new AbortController().signal);
  assert.deepEqual(
    { ...outcome },
    { status: "failed", resultHeadSha: "", failureCategory: "stale_result" },
  );
});

test("a result that violates the result contract is refused", async () => {
  // The result channel is untrusted at the queue seam: a backend that
  // returns a malformed result (unknown field, bogus status, a head on a
  // failed result) must not be mapped onto a scheduler outcome.
  const request = makeRequest("job-a", 1);
  const malformed = Object.freeze({
    ...completedResult(request),
    extra: "not part of the contract",
  }) as unknown as ExecutionResult;
  const { adapter } = adapterOver(async () => handleFor(malformed));
  const outcome = await adapter.start(makeRecord("job-a"), new AbortController().signal);
  assert.deepEqual(
    { ...outcome },
    { status: "failed", resultHeadSha: "", failureCategory: "executor-error" },
  );
});

test("a result whose failure message exceeds the contract cap is refused", async () => {
  // The result contract bounds its free-text fields, so a backend that
  // ignores the cap is a contract violation like any other — the adapter
  // must not launder it into a scheduler outcome.
  const request = makeRequest("job-a", 1);
  const oversized = Object.freeze({
    ...failedResult(request, "launch_refused", "m".repeat(2_001)),
  }) as ExecutionResult;
  const { adapter } = adapterOver(async () => handleFor(oversized));
  const outcome = await adapter.start(makeRecord("job-a"), new AbortController().signal);
  assert.deepEqual(
    { ...outcome },
    { status: "failed", resultHeadSha: "", failureCategory: "executor-error" },
  );
});

// ── rejection mapping ───────────────────────────────────────────────────

test("a builder rejection maps to a failed outcome carrying the message as category", async () => {
  const { adapter, executor } = adapterOver(
    async () => handleFor(completedResult(makeRequest("job-a", 1))),
    async () => {
      throw new Error("no workspace for owner/repo");
    },
  );
  const outcome = await adapter.start(makeRecord("job-a"), new AbortController().signal);
  assert.deepEqual(
    { ...outcome },
    { status: "failed", resultHeadSha: "", failureCategory: "no workspace for owner/repo" },
  );
  assert.equal(executor.startedRequests.length, 0, "the executor was never started");
});

test("a message-less builder rejection falls back to the executor-error category", async () => {
  const { adapter } = adapterOver(
    async () => handleFor(completedResult(makeRequest("job-a", 1))),
    async () => {
      throw "nope";
    },
  );
  const outcome = await adapter.start(makeRecord("job-a"), new AbortController().signal);
  assert.equal(outcome.failureCategory, "executor-error");
  assert.equal(outcome.status, "failed");
});

test("a collect rejection maps to a failed outcome carrying the message as category", async () => {
  const { adapter } = adapterOver(
    async () => ({
      observe: async () => Object.freeze({ phase: "running" as const, status: "" as const, observedAtMs: 0 }),
      cancel: async () => undefined,
      collect: async () => {
        throw new Error("result file vanished");
      },
    }),
  );
  const outcome = await adapter.start(makeRecord("job-a"), new AbortController().signal);
  assert.deepEqual(
    { ...outcome },
    { status: "failed", resultHeadSha: "", failureCategory: "result file vanished" },
  );
});

test("a rejected executor.start propagates — the scheduler owns that path", async () => {
  const { adapter } = adapterOver(async () => {
    throw new Error("launch refused");
  });
  await assert.rejects(
    () => adapter.start(makeRecord("job-a"), new AbortController().signal),
    /launch refused/,
  );
});

// ── end-to-end through the real controller ──────────────────────────────

test("the controller settles a dispatched job completed through the adapter", async () => {
  const clock = { t: 1_000_000 };
  const store = new InMemoryQueueStore();
  const executor: Executor = {
    start: async (request: ExecutionRequest) => handleFor(completedResult(request)),
    reconcile: async () => ({ kind: "none" as const }),
    cancel: async () => ({ kind: "terminated" as const }),
  };
  const controller = new ReviewQueueController(store, baseOptions(executor), () => clock.t);
  controller.recover();
  controller.enqueue(makeJob("job-a"));
  await controller.tick();
  const record = await waitForState(controller, "job-a", "completed");
  assert.equal(record.resultHeadSha, HEAD_SHA);
  assert.equal(record.failureReason, "");
});

test("the controller settles a dispatched job failed through the adapter", async () => {
  const clock = { t: 1_000_000 };
  const store = new InMemoryQueueStore();
  const executor: Executor = {
    start: async (request: ExecutionRequest) =>
      handleFor(failedResult(request, "worker_error", "the worker exited with code 3")),
    reconcile: async () => ({ kind: "none" as const }),
    cancel: async () => ({ kind: "terminated" as const }),
  };
  const controller = new ReviewQueueController(
    store,
    { ...baseOptions(executor), maxAttempts: 1 },
    () => clock.t,
  );
  controller.recover();
  controller.enqueue(makeJob("job-a"));
  await controller.tick();
  const record = await waitForState(controller, "job-a", "failed");
  assert.equal(record.failureReason, "worker_error");
  assert.equal(record.resultHeadSha, "");
});

test("the adapter keeps the scheduler's outcome type intact", async () => {
  // Type-level seam check: an adapter-produced outcome is assignable to
  // the scheduler's own ExecutionOutcome contract.
  const outcome: ExecutionOutcome = {
    status: "completed",
    resultHeadSha: HEAD_SHA,
    failureCategory: "executor-error",
  };
  assert.equal(outcome.status, "completed");
});
