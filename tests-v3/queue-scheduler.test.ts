/** Durable review-queue controller (#731): dedupe/coalesce, supersession
 * (queued and running), settle-window dispatch, crash recovery, lease
 * expiry cycles, the publication supersession gate, publish retry without
 * executor rerun, bounded backoff, heartbeat, shutdown drain/cancel,
 * concurrency, scope caps, and round-robin fairness — all driven by a
 * fake clock and a controllable deferred executor. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryQueueStore,
  ReviewQueueController,
  newJobRecord,
  type ExecutionOutcome,
  type JobExecutor,
  type JobPublisher,
  type JobRecord,
  type QueueSnapshot,
  type SchedulerOptions,
} from "../src/queue/index.js";
import type { ReviewJob } from "../src/jobs/types.js";

// ── in-file harness ─────────────────────────────────────────────────────

/** A fully-populated immutable ReviewJob with the given jobId. */
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
    headSha: "aa11bb22cc33dd44ee55ff667788990001122334",
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

const HEAD_SHA = "aa11bb22cc33dd44ee55ff667788990001122334";

const DONE: ExecutionOutcome = Object.freeze({
  status: "completed",
  resultHeadSha: HEAD_SHA,
  failureCategory: "",
});
const CANCELLED: ExecutionOutcome = Object.freeze({
  status: "cancelled",
  resultHeadSha: "",
  failureCategory: "",
});
const FAILED: ExecutionOutcome = Object.freeze({
  status: "failed",
  resultHeadSha: "",
  failureCategory: "",
});

/** One recorded executor invocation with a manually settled deferred. */
interface Invocation {
  readonly record: JobRecord;
  readonly signal: AbortSignal;
  settle(outcome: ExecutionOutcome): void;
  fail(error: Error): void;
}

class ControllableExecutor implements JobExecutor {
  readonly invocations: Invocation[] = [];

  start(record: JobRecord, signal: AbortSignal): Promise<ExecutionOutcome> {
    let settle!: (outcome: ExecutionOutcome) => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<ExecutionOutcome>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    this.invocations.push(
      Object.freeze({
        record,
        signal,
        settle: (outcome: ExecutionOutcome) => {
          settle(outcome);
        },
        fail: (error: Error) => {
          fail(error);
        },
      }),
    );
    return promise;
  }

  last(): Invocation {
    return this.invocations[this.invocations.length - 1]!;
  }
}

/** Publisher whose returns come from a scripted queue (default true). */
class RecordingPublisher implements JobPublisher {
  readonly calls: JobRecord[] = [];

  constructor(private readonly script: boolean[] = []) {}

  async publish(record: JobRecord): Promise<boolean> {
    this.calls.push(record);
    return this.script.length > 0 ? this.script.shift()! : true;
  }
}

interface Clock {
  t: number;
}

/** Drain the executor/publisher microtask chains (no real timers). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function baseOptions(executor: JobExecutor): SchedulerOptions {
  return {
    maxConcurrent: 1,
    settleWindowMs: 0,
    leaseTtlMs: 1000,
    maxAttempts: 3,
    retryBaseMs: 100,
    retryMaxMs: 1000,
    executor,
  };
}

interface Harness {
  readonly clock: Clock;
  readonly store: InMemoryQueueStore;
  readonly executor: ControllableExecutor;
  readonly controller: ReviewQueueController;
}

/** Fresh store + controller (already recovered) on a fake clock. */
function setup(overrides: Partial<SchedulerOptions> = {}): Harness {
  const clock: Clock = { t: 1_000_000 };
  const store = new InMemoryQueueStore();
  const executor = new ControllableExecutor();
  const options: SchedulerOptions = { ...baseOptions(executor), ...overrides };
  const controller = new ReviewQueueController(store, options, () => clock.t);
  controller.recover();
  return { clock, store, executor, controller };
}

function makeSnapshot(records: readonly JobRecord[]): QueueSnapshot {
  return Object.freeze({ version: 1, records: Object.freeze(records) });
}

// ── dedupe & supersession ───────────────────────────────────────────────

test("enqueue: duplicate webhooks for one jobId create exactly one record", async () => {
  const { controller } = setup();
  const job = makeJob("job-a");
  assert.deepEqual(controller.enqueue(job), { disposition: "queued", jobId: "job-a" });
  assert.deepEqual(controller.enqueue(job), { disposition: "duplicate", jobId: "job-a" });
  assert.equal(controller.snapshot().records.length, 1);
  assert.equal(controller.recordFor("job-a")!.state, "queued");
});

test("enqueue: B while A is queued supersedes A; only B dispatches", async () => {
  const { executor, controller } = setup();
  controller.enqueue(makeJob("job-a"));
  const result = controller.enqueue(makeJob("job-b"));
  assert.equal(result.disposition, "superseded-queued");

  const a = controller.recordFor("job-a")!;
  assert.equal(a.state, "superseded");
  assert.equal(a.failureReason, "superseded-by-newer-head");
  assert.equal(a.supersededByJobId, "job-b");

  await controller.tick();
  assert.equal(executor.invocations.length, 1);
  assert.equal(executor.last().record.job.jobId, "job-b");
});

test("enqueue: B while A is running cancels A via signal; B dispatches as the trailing generation", async () => {
  const { executor, controller } = setup();
  controller.enqueue(makeJob("job-a"));
  await controller.tick();
  const inv = executor.last();

  const result = controller.enqueue(makeJob("job-b"));
  assert.equal(result.disposition, "superseded-running");
  assert.equal(controller.recordFor("job-a")!.cancelRequested, true);
  assert.equal(inv.signal.aborted, true, "the running executor's signal is aborted");

  inv.settle(CANCELLED);
  await flush();
  const a = controller.recordFor("job-a")!;
  assert.equal(a.state, "cancelled");
  assert.equal(a.failureReason, "cancelled-by-supersession");

  await controller.tick();
  assert.equal(executor.invocations.length, 2, "exactly one trailing dispatch");
  assert.equal(executor.last().record.job.jobId, "job-b");
});

test("kind separation: a follow_up enqueue never supersedes or cancels a running review", async () => {
  const { executor, controller } = setup();
  controller.enqueue(makeJob("review-a"));
  await controller.tick();
  const inv = executor.last();

  const result = controller.enqueue(
    makeJob("followup-b", { kind: "follow_up", headSha: "", eventReference: "17" }),
  );
  assert.equal(result.disposition, "queued", "independent kinds never supersede");
  assert.equal(controller.recordFor("review-a")!.cancelRequested, false);
  assert.equal(inv.signal.aborted, false, "the running review keeps its signal");

  inv.settle(DONE);
  await flush();
  assert.equal(controller.recordFor("review-a")!.state, "completed");

  await controller.tick();
  assert.equal(executor.invocations.length, 2, "the follow_up then dispatches");
  assert.equal(executor.last().record.job.jobId, "followup-b");
  executor.last().settle(DONE);
  await flush();
  assert.equal(controller.recordFor("followup-b")!.state, "completed", "both complete");
});

// ── settle window ────────────────────────────────────────────────────────

test("settle window: a burst inside the window collapses to the newest, dispatched at expiry only", async () => {
  const { clock, executor, controller } = setup({ settleWindowMs: 500 });
  controller.enqueue(makeJob("job-a"));
  controller.enqueue(makeJob("job-b"));
  controller.enqueue(makeJob("job-c"));
  assert.equal(controller.recordFor("job-a")!.state, "superseded");
  assert.equal(controller.recordFor("job-b")!.state, "superseded");
  assert.equal(controller.recordFor("job-c")!.state, "queued");

  await controller.tick();
  assert.equal(executor.invocations.length, 0, "nothing dispatches before the window");
  clock.t += 499;
  await controller.tick();
  assert.equal(executor.invocations.length, 0);

  clock.t += 1;
  await controller.tick();
  assert.equal(executor.invocations.length, 1, "exactly one dispatch at expiry");
  assert.equal(executor.last().record.job.jobId, "job-c");
});

test("settle 0: a fresh enqueue dispatches on the very next tick", async () => {
  const { executor, controller } = setup({ settleWindowMs: 0 });
  controller.enqueue(makeJob("job-a"));
  await controller.tick();
  assert.equal(executor.invocations.length, 1);
  assert.equal(executor.last().record.state, "running");
});

// ── crash recovery & lease expiry ───────────────────────────────────────

test("restart mid-run: a fresh controller over the same store requeues the abandoned run", async () => {
  const { clock, store, executor, controller } = setup();
  controller.enqueue(makeJob("job-a"));
  await controller.tick();
  assert.equal(executor.invocations.length, 1);
  clock.t += 1001; // past the lease expiry

  const second = new ReviewQueueController(store, baseOptions(new ControllableExecutor()), () => clock.t);
  const recovered = second.recover();
  assert.deepEqual(recovered.requeued, ["job-a"]);
  assert.deepEqual(recovered.failed, []);

  const record = second.recordFor("job-a")!;
  assert.equal(record.state, "queued");
  assert.equal(record.attempt, 1, "attempt unchanged: the abandoned dispatch was already counted");
  assert.equal(record.leaseOwner, "");
  assert.equal(record.leaseExpiresAtMs, 0);
});

test("lease expiry: requeues each cycle, fails at the attempt limit, ignores the late resolution", async () => {
  const { clock, executor, controller } = setup();
  controller.enqueue(makeJob("job-a"));
  await controller.tick();
  const first = executor.last();
  assert.equal(controller.recordFor("job-a")!.attempt, 1);

  let cycles = 0;
  while (controller.recordFor("job-a")!.state !== "failed" && cycles < 5) {
    clock.t += 1001;
    await controller.tick();
    cycles += 1;
  }
  const failed = controller.recordFor("job-a")!;
  assert.ok(cycles < 5, "the retry cycle terminates");
  assert.ok(executor.invocations.length >= 2, "expired runs are redispatched");
  assert.equal(failed.state, "failed");
  assert.equal(failed.failureReason, "lease-expired-attempt-limit");

  first.settle(DONE);
  await flush();
  const still = controller.recordFor("job-a")!;
  assert.equal(still.state, "failed", "the abandoned generation cannot resurrect itself");
  assert.equal(still.failureReason, "lease-expired-attempt-limit");
});

test("lease tokens are unique per dispatch: the abandoned attempt's late resolution is revoked", async () => {
  const { clock, executor, controller } = setup();
  controller.enqueue(makeJob("job-a"));
  await controller.tick();
  const first = executor.last();
  const firstToken = controller.recordFor("job-a")!.leaseOwner;

  clock.t += 1001; // lease expiry -> requeue -> redispatch
  await controller.tick();
  assert.equal(executor.invocations.length, 2, "the requeued record was redispatched");
  const secondToken = controller.recordFor("job-a")!.leaseOwner;
  assert.notEqual(secondToken, firstToken, "each dispatch carries a unique token");

  first.settle(DONE);
  await flush();
  const held = controller.recordFor("job-a")!;
  assert.equal(held.state, "running", "the late first-attempt resolution is revoked");

  executor.last().settle(DONE);
  await flush();
  const done = controller.recordFor("job-a")!;
  assert.equal(done.state, "completed", "the live attempt still completes normally");
});

test("lease expiry never resurrects a superseded generation: the old record ends superseded", async () => {
  const { clock, executor, controller } = setup();
  controller.enqueue(makeJob("job-a"));
  await controller.tick();
  controller.enqueue(makeJob("job-b"));
  assert.equal(controller.recordFor("job-a")!.cancelRequested, true);

  clock.t += 1001; // A's lease dies while B is already queued
  await controller.tick();

  const a = controller.recordFor("job-a")!;
  assert.equal(a.state, "superseded", "A is retired, not requeued");
  assert.equal(a.failureReason, "superseded-by-newer-head");
  assert.equal(a.supersededByJobId, "job-b");
  assert.equal(executor.invocations.length, 2, "B dispatches as the trailing generation");
  assert.equal(executor.last().record.job.jobId, "job-b");
});

test("attempt budget: lease expiry requeues without consuming an attempt, so the third dispatch can still complete", async () => {
  const { clock, store, executor, controller } = setup({ maxAttempts: 3 });
  controller.enqueue(makeJob("job-a"));
  await controller.tick();
  assert.equal(executor.invocations.length, 1);
  assert.equal(controller.recordFor("job-a")!.attempt, 1);

  // First lease expiry: the requeue leaves the attempt unchanged (the
  // abandoned attempt was already counted at dispatch).
  clock.t += 1001;
  const firstRecovery = new ReviewQueueController(
    store,
    baseOptions(new ControllableExecutor()),
    () => clock.t,
  );
  assert.deepEqual(firstRecovery.recover().requeued, ["job-a"]);
  assert.equal(firstRecovery.recordFor("job-a")!.state, "queued");
  assert.equal(firstRecovery.recordFor("job-a")!.attempt, 1, "requeue keeps the attempt count");

  await controller.tick();
  assert.equal(executor.invocations.length, 2, "redispatch #2 counts attempt 2");
  assert.equal(controller.recordFor("job-a")!.attempt, 2);

  // Second lease expiry: again unchanged, leaving budget for a third dispatch.
  clock.t += 1001;
  const secondRecovery = new ReviewQueueController(
    store,
    baseOptions(new ControllableExecutor()),
    () => clock.t,
  );
  assert.deepEqual(secondRecovery.recover().requeued, ["job-a"]);
  assert.equal(secondRecovery.recordFor("job-a")!.attempt, 2, "requeue keeps the attempt count");

  await controller.tick();
  assert.equal(executor.invocations.length, 3, "the third dispatch still fits the budget");
  assert.equal(controller.recordFor("job-a")!.state, "running", "the double count would have burned the budget");
  executor.last().settle(DONE);
  await flush();
  const done = controller.recordFor("job-a")!;
  assert.equal(done.state, "completed");
});

// ── publication gate & publish retry ────────────────────────────────────

test("stale completion: a superseded generation never publishes", async () => {
  const publisher = new RecordingPublisher([true]);
  const { executor, controller } = setup({ publisher });
  controller.enqueue(makeJob("job-a"));
  await controller.tick();
  controller.enqueue(makeJob("job-b"));

  executor.last().settle(DONE);
  await flush();

  const a = controller.recordFor("job-a")!;
  assert.equal(a.state, "superseded");
  assert.equal(a.failureReason, "superseded-by-newer-head");
  assert.equal(a.supersededByJobId, "job-b");
  assert.equal(publisher.calls.length, 0, "the publisher is never called");
});

test("publish retry: publisher false then true completes WITHOUT rerunning the executor", async () => {
  const publisher = new RecordingPublisher([false, true]);
  const { clock, executor, controller } = setup({ publisher });
  controller.enqueue(makeJob("job-a"));
  await controller.tick();
  executor.last().settle(DONE);
  await flush();

  const publishing = controller.recordFor("job-a")!;
  assert.equal(publishing.state, "publishing");
  assert.equal(publishing.resultHeadSha, HEAD_SHA);
  assert.equal(publishing.nextRetryAtMs, clock.t + 100, "backoff = retryBaseMs");
  assert.equal(publisher.calls.length, 1);

  await controller.tick();
  assert.equal(publisher.calls.length, 1, "no retry before the backoff window");
  assert.equal(controller.recordFor("job-a")!.state, "publishing");

  clock.t += 100;
  await controller.tick();
  await flush();
  const done = controller.recordFor("job-a")!;
  assert.equal(done.state, "completed");
  assert.equal(publisher.calls.length, 2);
  assert.equal(executor.invocations.length, 1, "the executor never reran");
});

test("publish throw: a throwing publisher retries like false and never crashes the pass", async () => {
  const calls: JobRecord[] = [];
  let throwNext = true;
  const publisher: JobPublisher = {
    async publish(record: JobRecord): Promise<boolean> {
      calls.push(record);
      if (throwNext) {
        throwNext = false;
        throw new Error("publisher exploded");
      }
      return true;
    },
  };
  const { clock, executor, controller } = setup({ publisher });
  controller.enqueue(makeJob("job-a"));
  await controller.tick();
  executor.last().settle(DONE);
  await flush();

  const publishing = controller.recordFor("job-a")!;
  assert.equal(publishing.state, "publishing", "the throw leaves the record publishing");
  assert.equal(publishing.resultHeadSha, HEAD_SHA);
  assert.equal(publishing.nextRetryAtMs, clock.t + 100, "throw maps to the false-backoff");
  assert.equal(publishing.leaseOwner, "", "publishing-with-result is lease-exempt");
  assert.equal(publishing.leaseExpiresAtMs, 0);
  assert.equal(calls.length, 1);
  assert.equal(executor.invocations.length, 1, "the executor never reran");

  await controller.tick();
  assert.equal(calls.length, 1, "no retry before the backoff window");

  clock.t += 100;
  await controller.tick();
  await flush();
  const done = controller.recordFor("job-a")!;
  assert.equal(done.state, "completed");
  assert.equal(calls.length, 2, "the pass retried after the backoff");
  assert.equal(executor.invocations.length, 1, "still no executor rerun");
});

// ── bounded retry on failure ────────────────────────────────────────────

test("failed outcomes back off exponentially and terminate at the attempt limit", async () => {
  const { clock, executor, controller } = setup();
  controller.enqueue(makeJob("job-a"));

  await controller.tick();
  executor.last().settle(FAILED);
  await flush();
  const after1 = controller.recordFor("job-a")!;
  assert.equal(after1.state, "queued");
  assert.equal(after1.nextRetryAtMs - clock.t, 100, "first backoff = retryBaseMs");

  clock.t += 100;
  await controller.tick();
  assert.equal(executor.invocations.length, 2);
  executor.last().settle(FAILED);
  await flush();
  const after2 = controller.recordFor("job-a")!;
  assert.equal(after2.state, "queued");
  assert.equal(after2.nextRetryAtMs - clock.t, 200, "second backoff doubles");

  clock.t += 200;
  await controller.tick();
  assert.equal(executor.invocations.length, 3);
  executor.last().settle(FAILED);
  await flush();
  const terminal = controller.recordFor("job-a")!;
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.failureReason, "execution-failed");
  assert.equal(terminal.attempt, 3);
});

test("failed-outcome backoff is capped by retryMaxMs", async () => {
  const { clock, executor, controller } = setup({ retryMaxMs: 150 });
  controller.enqueue(makeJob("job-a"));

  await controller.tick();
  executor.last().settle(FAILED);
  await flush();
  assert.equal(controller.recordFor("job-a")!.nextRetryAtMs - clock.t, 100);

  clock.t += 100;
  await controller.tick();
  executor.last().settle(FAILED);
  await flush();
  assert.equal(
    controller.recordFor("job-a")!.nextRetryAtMs - clock.t,
    150,
    "200 capped to retryMaxMs",
  );
});

// ── heartbeat ────────────────────────────────────────────────────────────

test("heartbeat renews for the lease owner only, and only while the lease is live", async () => {
  const { clock, controller } = setup();
  controller.enqueue(makeJob("job-a"));
  await controller.tick();
  const owner = controller.recordFor("job-a")!.leaseOwner;
  assert.ok(owner !== "");

  assert.equal(controller.heartbeat("job-a", owner), true);
  assert.equal(controller.recordFor("job-a")!.leaseExpiresAtMs, clock.t + 1000);
  assert.equal(controller.heartbeat("job-a", "wrong-worker"), false);
  assert.equal(controller.heartbeat("unknown-job", owner), false);

  clock.t += 1000;
  assert.equal(controller.heartbeat("job-a", owner), false, "expiry == now is not live");
});

// ── shutdown ─────────────────────────────────────────────────────────────

test("shutdown(0): closes intake, cancels the run, and later enqueues throw", async () => {
  const { executor, controller } = setup();
  controller.enqueue(makeJob("job-a"));
  await controller.tick();
  const inv = executor.last();

  await controller.shutdown(0);
  assert.equal(controller.intakeClosed, true);
  const record = controller.recordFor("job-a")!;
  assert.equal(record.state, "cancelled");
  assert.equal(record.failureReason, "shutdown");
  assert.equal(inv.signal.aborted, true);
  assert.throws(() => controller.enqueue(makeJob("job-b")), /intake closed/);
});

test("shutdown drain: a run resolving during the drain window completes instead of cancelling", async () => {
  const { executor, controller } = setup();
  controller.enqueue(makeJob("job-a"));
  await controller.tick();
  executor.last().settle(DONE);

  await controller.shutdown(5000);
  const record = controller.recordFor("job-a")!;
  assert.equal(record.state, "completed");
  assert.equal(record.failureReason, "");
  assert.equal(controller.intakeClosed, true);
});

test("shutdown on a frozen clock returns: stuck work is cancelled, queued work is never dispatched", async () => {
  const { executor, controller } = setup();
  controller.enqueue(makeJob("job-a", { prNumber: 1 }));
  controller.enqueue(makeJob("job-b", { prNumber: 2 }));
  await controller.tick();
  assert.equal(executor.invocations.length, 1, "maxConcurrent 1 leaves job-b queued");

  // Frozen clock + an executor that never settles: the bounded drain
  // must terminate with no timers, then cancel.
  await controller.shutdown(1000);

  const a = controller.recordFor("job-a")!;
  assert.equal(a.state, "cancelled");
  assert.equal(a.failureReason, "shutdown");
  assert.equal(controller.recordFor("job-b")!.state, "queued", "closed intake dispatches nothing");
  assert.equal(executor.invocations.length, 1, "job-b was never dispatched");
});

// ── deadline expiry ──────────────────────────────────────────────────────

test("deadline expiry cancels the job and aborts its executor", async () => {
  const { clock, executor, controller } = setup();
  controller.enqueue(makeJob("job-a", { deadlineAtMs: clock.t + 500 }));
  await controller.tick();
  const inv = executor.last();
  assert.equal(inv.signal.aborted, false);

  clock.t += 500;
  await controller.tick();
  const record = controller.recordFor("job-a")!;
  assert.equal(record.state, "cancelled");
  assert.equal(record.failureReason, "deadline-expired");
  assert.equal(inv.signal.aborted, true, "the deadline aborts the worker");
});

test("deadline expiry spares a publishing record holding its durable result", async () => {
  const publisher = new RecordingPublisher([false, false]);
  const { clock, executor, controller } = setup({ publisher });
  controller.enqueue(makeJob("job-a", { deadlineAtMs: clock.t + 500 }));
  await controller.tick();
  executor.last().settle(DONE);
  await flush();
  assert.equal(controller.recordFor("job-a")!.state, "publishing");

  clock.t += 500;
  await controller.tick();
  await flush();
  assert.equal(
    controller.recordFor("job-a")!.state,
    "publishing",
    "the deadline never throws away durable work",
  );
});

// ── concurrency, scope caps, fairness ───────────────────────────────────

test("concurrency: distinct prKeys share the global bound", async () => {
  const both = setup({ maxConcurrent: 2 });
  both.controller.enqueue(makeJob("job-a", { prNumber: 1 }));
  both.clock.t += 10;
  both.controller.enqueue(makeJob("job-b", { prNumber: 2 }));
  await both.controller.tick();
  assert.equal(both.executor.invocations.length, 2, "both dispatch in one tick");

  const single = setup({ maxConcurrent: 1 });
  single.controller.enqueue(makeJob("job-a", { prNumber: 1 }));
  single.clock.t += 10;
  single.controller.enqueue(makeJob("job-b", { prNumber: 2 }));
  await single.controller.tick();
  assert.equal(single.executor.invocations.length, 1);
  assert.equal(single.executor.last().record.job.jobId, "job-a", "the older one wins");
});

test("scope cap: a saturated scope admits one dispatch per tick across prKeys", async () => {
  const { executor, controller } = setup({
    maxConcurrent: 4,
    scopeKeyOf: () => "x",
    scopeLimitOf: (scopeKey) => (scopeKey === "x" ? 1 : 0),
  });
  controller.enqueue(makeJob("job-a", { prNumber: 1 }));
  controller.enqueue(makeJob("job-b", { prNumber: 2 }));
  await controller.tick();
  assert.equal(executor.invocations.length, 1, "the scope cap blocks the second");
});

test("fairness: round-robin across prKeys dispatches one per prKey per pass", async () => {
  const clock: Clock = { t: 1_000_000 };
  const store = new InMemoryQueueStore();
  store.save(
    makeSnapshot([
      newJobRecord(makeJob("job-a1", { prNumber: 1 }), clock.t, 0),
      newJobRecord(makeJob("job-b1", { prNumber: 2 }), clock.t, 0),
      newJobRecord(makeJob("job-a2", { prNumber: 1 }), clock.t + 1, 0),
      newJobRecord(makeJob("job-b2", { prNumber: 2 }), clock.t + 1, 0),
    ]),
  );
  const executor = new ControllableExecutor();
  const options: SchedulerOptions = { ...baseOptions(executor), maxConcurrent: 4 };
  const controller = new ReviewQueueController(store, options, () => clock.t);
  controller.recover();

  clock.t += 1; // the newer pair (created at t+1) is now past its settle window
  await controller.tick();
  assert.equal(executor.invocations.length, 2, "exactly one dispatch per prKey");
  assert.deepEqual(
    executor.invocations.map((inv) => inv.record.job.jobId).sort(),
    ["job-a2", "job-b2"],
    "the newer generation wins: the stale older siblings are defensively skipped",
  );
});