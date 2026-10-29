/** The scheduler's recovery settle seam (#1348): `resolveRecovered` feeds
 * a reconciled worker's terminal outcome into the queue without a new
 * dispatch — a settled reconciliation result is never rerun — while live
 * in-process dispatches, publishing records, and terminal records refuse. */

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
  type SchedulerOptions,
} from "../src/queue/index.js";
import type { ReviewJob } from "../src/jobs/types.js";

const HEAD = "aa11bb22cc33dd44ee55ff667788990001122334";

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
    headSha: HEAD,
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

class ControllableExecutor implements JobExecutor {
  readonly records: JobRecord[] = [];
  readonly signals: AbortSignal[] = [];

  start(record: JobRecord, signal: AbortSignal): Promise<ExecutionOutcome> {
    this.records.push(record);
    this.signals.push(signal);
    return new Promise<ExecutionOutcome>(() => undefined);
  }
}

class RecordingPublisher implements JobPublisher {
  readonly calls: JobRecord[] = [];

  async publish(record: JobRecord): Promise<boolean> {
    this.calls.push(record);
    return true;
  }
}

function baseOptions(executor: JobExecutor, publisher?: JobPublisher): SchedulerOptions {
  return {
    maxConcurrent: 2,
    settleWindowMs: 0,
    leaseTtlMs: 1000,
    maxAttempts: 3,
    retryBaseMs: 100,
    retryMaxMs: 1000,
    executor,
    ...(publisher !== undefined ? { publisher } : {}),
  };
}

test("a recovered settled completion routes through publishing without a new dispatch", async () => {
  const executor = new ControllableExecutor();
  const publisher = new RecordingPublisher();
  const store = new InMemoryQueueStore();
  const controller = new ReviewQueueController(store, baseOptions(executor, publisher), () => 1000);
  controller.enqueue(makeJob("job-1"));
  await controller.tick();
  assert.equal(executor.records.length, 1);

  // Simulate a controller restart: a NEW controller instance over the same
  // store, whose in-memory handle map is empty. The worker reconciled to a
  // completed result.
  const restarted = new ReviewQueueController(store, baseOptions(executor, publisher), () => 1000);
  restarted.recover();
  const accepted = await restarted.resolveRecovered("job-1", {
    status: "completed",
    resultHeadSha: HEAD,
    failureCategory: "",
  });
  assert.equal(accepted, true);
  const record = restarted.recordFor("job-1")!;
  assert.ok(
    record.state === "publishing" || record.state === "completed",
    `a recovered completion routes through publishing (saw ${record.state})`,
  );
  assert.equal(record.resultHeadSha, HEAD);
  assert.equal(executor.records.length, 1, "the executor was never asked to rerun");
  // The publisher is fired (background): flush the microtask chain.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  assert.equal(publisher.calls.length, 1);
  await restarted.tick();
  assert.equal(restarted.recordFor("job-1")!.state, "completed");
});

test("a recovered failure requeues with backoff (attempts preserved), then fails at the attempt limit", async () => {
  const executor = new ControllableExecutor();
  const store = new InMemoryQueueStore();
  const clock = { t: 1000 };
  const controller = new ReviewQueueController(store, baseOptions(executor), () => clock.t);
  controller.enqueue(makeJob("job-1"));
  await controller.tick();
  assert.equal(executor.records.length, 1);

  const restarted = new ReviewQueueController(store, baseOptions(executor), () => clock.t);
  restarted.recover();
  const accepted = await restarted.resolveRecovered("job-1", {
    status: "failed",
    resultHeadSha: "",
    failureCategory: "worker_crash",
  });
  assert.equal(accepted, true);
  const record = restarted.recordFor("job-1")!;
  assert.equal(record.state, "queued", "a failure with attempts left requeues");
  assert.equal(record.attempt, 1, "the abandoned attempt stays counted");
  assert.equal(record.nextRetryAtMs, 1100);
  assert.equal(executor.records.length, 1);
});

test("a record a live dispatch owns refuses a recovered resolution", async () => {
  const executor = new ControllableExecutor();
  const store = new InMemoryQueueStore();
  const controller = new ReviewQueueController(store, baseOptions(executor), () => 1000);
  controller.enqueue(makeJob("job-1"));
  await controller.tick();
  assert.equal(executor.records.length, 1);

  const accepted = await controller.resolveRecovered("job-1", {
    status: "completed",
    resultHeadSha: HEAD,
    failureCategory: "",
  });
  assert.equal(accepted, false, "the live dispatch's own settle path must stay the only writer");
  assert.equal(controller.recordFor("job-1")!.state, "running");
});

test("publishing, terminal, and unknown records refuse a recovered resolution", async () => {
  const executor = new ControllableExecutor();
  const publisher = new RecordingPublisher();
  const store = new InMemoryQueueStore();
  const controller = new ReviewQueueController(store, baseOptions(executor, publisher), () => 1000);
  controller.enqueue(makeJob("job-1"));
  await controller.tick();
  assert.equal(executor.records.length, 1);

  // Restart, then recover the settled worker: the record reaches
  // publishing (holding its durable result).
  const restarted = new ReviewQueueController(store, baseOptions(executor, publisher), () => 1000);
  restarted.recover();
  assert.equal(
    await restarted.resolveRecovered("job-1", {
      status: "completed",
      resultHeadSha: HEAD,
      failureCategory: "",
    }),
    true,
  );
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  const publishing = restarted.recordFor("job-1")!;
  if (publishing.state === "publishing") {
    // A publishing record (with its durable result) is the queue's own
    // retry path — a recovered resolution must not touch it.
    assert.equal(
      await restarted.resolveRecovered("job-1", {
        status: "completed",
        resultHeadSha: HEAD,
        failureCategory: "",
      }),
      false,
    );
    await restarted.tick();
  }
  assert.equal(restarted.recordFor("job-1")!.state, "completed");

  // Terminal records refuse.
  const terminal = await restarted.resolveRecovered("job-1", {
    status: "completed",
    resultHeadSha: HEAD,
    failureCategory: "",
  });
  assert.equal(terminal, false);
  // Unknown records refuse.
  const unknown = await restarted.resolveRecovered("job-missing", {
    status: "completed",
    resultHeadSha: HEAD,
    failureCategory: "",
  });
  assert.equal(unknown, false);
});

test("a recovered resolution whose generation was superseded is retired as superseded", async () => {
  const executor = new ControllableExecutor();
  const store = new InMemoryQueueStore();
  const controller = new ReviewQueueController(store, baseOptions(executor), () => 1000);
  controller.enqueue(makeJob("job-old"));
  await controller.tick();
  assert.equal(executor.records.length, 1);

  // A newer head arrives while the old generation is running.
  const supersede = controller.enqueue(makeJob("job-new", { headSha: "bb22cc33dd44ee55ff66778899000112233444" }));
  assert.equal(supersede.disposition, "superseded-running");

  // The restarted controller feeds the OLD generation's (late) result in.
  const restarted = new ReviewQueueController(store, baseOptions(executor), () => 1000);
  restarted.recover();
  const accepted = await restarted.resolveRecovered("job-old", {
    status: "completed",
    resultHeadSha: HEAD,
    failureCategory: "",
  });
  assert.equal(accepted, true);
  assert.equal(restarted.recordFor("job-old")!.state, "superseded");
  assert.equal(
    restarted.recordFor("job-old")!.supersededByJobId,
    "job-new",
    "a superseded generation's result can never publish",
  );
});
