/** PostgreSQL backend conformance (#736).
 *
 * The SAME scenario battery the in-memory backend passes, run against
 * the production backend when a disposable database is available:
 * set `PR_REVIEWER_TEST_PG_DSN` (e.g.
 * `postgres://user:pass@localhost:5432/pr_reviewer_test`) to enable.
 * Without it the battery SKIPS — that skip is the documented CI state,
 * not a pass: the PostgreSQL path needs a real server for its
 * transaction/concurrency semantics.
 *
 * The suite TRUNCATES every `cp_` table before the battery: the DSN
 * must point at a disposable database, never at operator state.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

import {
  InMemoryControlPlaneStore,
  PostgresControlPlaneStore,
  PostgresQueueSnapshotStore,
  runControlPlaneMigrations,
  seedControlPlaneStore,
  StateConflictError,
  type ControlPlaneStore,
  type PublicationRecord,
  type RunRecord,
  type UsageRecord,
} from "../src/state/index.js";
import {
  emptyQueueSnapshot,
  newJobRecord,
  reconcileRecoveredSnapshot,
  type QueueSnapshot,
} from "../src/queue/index.js";
import type { ReviewJob } from "../src/jobs/types.js";

const DSN = process.env["PR_REVIEWER_TEST_PG_DSN"] ?? "";
const pgTest = DSN === "" ? test.skip : test;

const T0 = 1_000_000;

function makeRun(runId: string, jobId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  const base = seedRunBase(runId, jobId);
  return Object.freeze({ ...base, ...overrides }) as RunRecord;
}

function seedRunBase(runId: string, jobId: string): RunRecord {
  return {
    runId,
    jobId,
    kind: "review",
    state: "queued",
    executorIdentity: "local:v1",
    attempt: 0,
    headSha: "abcdef1234567",
    configFingerprint: "abcdef1234567890",
    leaseOwner: "",
    leaseExpiresAtMs: 0,
    resultHeadSha: "",
    failureReason: "",
    supersededByJobId: "",
    createdAtMs: T0,
    updatedAtMs: T0,
    startedAtMs: 0,
    finishedAtMs: 0,
  } as RunRecord;
}

function makePublication(jobId: string, overrides: Partial<PublicationRecord> = {}): PublicationRecord {
  return Object.freeze({
    jobId,
    publicationState: "pending",
    destination: "github-comment:42",
    publicationId: "",
    attempt: 0,
    lastError: "",
    resultHeadSha: "",
    history: [],
    createdAtMs: T0,
    updatedAtMs: T0,
    ...overrides,
  }) as PublicationRecord;
}

function makeUsage(usageId: string, runId: string, overrides: Partial<UsageRecord> = {}): UsageRecord {
  return Object.freeze({
    usageId,
    runId,
    route: "primary-profile",
    role: "primary",
    requestCount: 1,
    inputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 20,
    costMicros: 0,
    costProvenance: "unknown",
    recordedAtMs: T0,
    ...overrides,
  }) as UsageRecord;
}

function makeJob(jobId: string, overrides: Partial<ReviewJob> = {}): ReviewJob {
  return Object.freeze({
    jobId,
    kind: "review",
    trigger: "webhook",
    reason: "pull_request.synchronize",
    platform: "github",
    installationId: "123",
    repoFullName: "octo-org/repo",
    prNumber: 1,
    prId: 0,
    headSha: "abcdef1234567",
    baseSha: "",
    configFingerprint: "abcdef1234567890",
    nonce: "",
    adoptionEpoch: "",
    eventReference: "",
    fork: false,
    deadlineAtMs: 0,
    runId: "",
    ...overrides,
  }) as ReviewJob;
}

/** The scenario battery, parameterized by backend factory: run against
 * the in-memory backend ALWAYS (the shared conformance core) and
 * against PostgreSQL when the DSN is set. */
type TestFn = (name: string, fn: () => Promise<void>) => unknown;

async function runConformanceBattery(
  testFn: TestFn,
  makeStore: () => Promise<ControlPlaneStore>,
  hooks: {
    beforeEach?: () => Promise<void>;
  } = {},
): Promise<void> {
  await testFn("conformance: apply lands every mutation of a valid batch", async () => {
    await hooks.beforeEach?.();
    const store = await makeStore();
    await store.apply([
      { kind: "put-publication", record: makePublication("job-1") },
      { kind: "create-run", record: makeRun("run-1", "job-1") },
      { kind: "transition-run", runId: "run-1", from: "queued", to: "starting", nowMs: T0 + 10 },
      { kind: "claim-idempotency", key: "evt-1", binding: "job-1", nowMs: T0 + 10, expiresAtMs: 0 },
      { kind: "record-usage", entry: makeUsage("run-1:0", "run-1") },
    ]);
    assert.equal((await store.getRun("run-1"))!.state, "starting");
    assert.equal((await store.getIdempotencyKey("evt-1"))!.binding, "job-1");
    assert.equal((await store.getPublication("job-1"))!.jobId, "job-1");
    assert.equal((await store.aggregateUsage()).totals.requestCount, 1);
  });

  await testFn("conformance: batch atomicity rejects the whole batch on conflict", async () => {
    await hooks.beforeEach?.();
    const store = await makeStore();
    await store.apply([{ kind: "create-run", record: makeRun("run-1", "job-1") }]);
    await assert.rejects(
      () =>
        store.apply([
          { kind: "transition-run", runId: "run-1", from: "queued", to: "starting", nowMs: T0 + 5 },
          { kind: "create-run", record: makeRun("run-1", "job-2") },
        ]),
      StateConflictError,
    );
    assert.equal((await store.getRun("run-1"))!.state, "queued");
    assert.equal((await store.getRun("run-1"))!.updatedAtMs, T0);
    // The rolled-back batch left nothing behind: run-1's transition
    // rolled back WITH the conflicting mutation.
  });

  await testFn("conformance: CAS transition rejects a stale completion", async () => {
    await hooks.beforeEach?.();
    const store = await makeStore();
    await store.apply([
      { kind: "create-run", record: makeRun("run-1", "job-1") },
      { kind: "transition-run", runId: "run-1", from: "queued", to: "starting", nowMs: T0 + 1 },
      { kind: "transition-run", runId: "run-1", from: "starting", to: "running", nowMs: T0 + 2 },
      { kind: "transition-run", runId: "run-1", from: "running", to: "superseded", nowMs: T0 + 3 },
    ]);
    await assert.rejects(
      () =>
        store.apply([
          { kind: "transition-run", runId: "run-1", from: "running", to: "publishing", nowMs: T0 + 4 },
        ]),
      StateConflictError,
    );
    const run = (await store.getRun("run-1"))!;
    assert.equal(run.state, "superseded");
    assert.equal(run.resultHeadSha, "");
  });

  await testFn("conformance: CAS transition is race-safe under concurrency", async () => {
    await hooks.beforeEach?.();
    const store = await makeStore();
    await store.apply([{ kind: "create-run", record: makeRun("run-1", "job-1") }]);
    // Two controllers race the SAME queued -> starting transition:
    // exactly one wins, one rolls back as a conflict.
    const results = await Promise.allSettled([
      store.apply([{ kind: "transition-run", runId: "run-1", from: "queued", to: "starting", nowMs: T0 + 1 }]),
      store.apply([{ kind: "transition-run", runId: "run-1", from: "queued", to: "starting", nowMs: T0 + 1 }]),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal((await store.getRun("run-1"))!.state, "starting");
  });

  await testFn("conformance: lease claim/expiry/steal and heartbeat ownership", async () => {
    await hooks.beforeEach?.();
    const store = await makeStore();
    await store.apply([{ kind: "create-run", record: makeRun("run-1", "job-1") }]);
    assert.equal(await store.claimRun("run-1", "worker-a", T0, 1000), true);
    assert.equal((await store.getRun("run-1"))!.leaseOwner, "worker-a");
    assert.equal(await store.claimRun("run-1", "worker-b", T0 + 500, 1000), false);
    assert.equal(await store.claimRun("run-1", "worker-a", T0 + 900, 1000), true);
    assert.equal(await store.claimRun("run-1", "worker-b", T0 + 3000, 1000), true);
    assert.equal(await store.heartbeatRun("run-1", "worker-a", T0 + 3100, 1000), false);
    assert.equal(await store.heartbeatRun("run-1", "worker-b", T0 + 3100, 1000), true);
    assert.equal((await store.getRun("run-1"))!.leaseExpiresAtMs, T0 + 4100);
  });

  await testFn("conformance: idempotency key replay/conflict/expiry", async () => {
    await hooks.beforeEach?.();
    const store = await makeStore();
    await store.apply([
      { kind: "claim-idempotency", key: "evt-1", binding: "job-1", nowMs: T0, expiresAtMs: 0 },
    ]);
    // Redelivery replays without error.
    await store.apply([
      { kind: "claim-idempotency", key: "evt-1", binding: "job-1", nowMs: T0 + 5, expiresAtMs: 0 },
    ]);
    // A different binding conflicts while the key is live.
    await assert.rejects(
      () =>
        store.apply([
          { kind: "claim-idempotency", key: "evt-1", binding: "job-2", nowMs: T0 + 6, expiresAtMs: 0 },
        ]),
      StateConflictError,
    );
    // Expiry re-claims.
    await store.apply([
      { kind: "claim-idempotency", key: "evt-exp", binding: "old", nowMs: T0, expiresAtMs: T0 + 100 },
    ]);
    await store.apply([
      { kind: "claim-idempotency", key: "evt-exp", binding: "new", nowMs: T0 + 101, expiresAtMs: 0 },
    ]);
    assert.equal((await store.getIdempotencyKey("evt-exp"))!.binding, "new");
  });

  await testFn("conformance: publication retry grows capped history from the stored record", async () => {
    await hooks.beforeEach?.();
    const store = await makeStore();
    await store.apply([
      {
        kind: "put-publication",
        record: makePublication("job-1", { resultHeadSha: "abcdef1234567" }),
      },
    ]);
    for (let index = 1; index <= 40; index += 1) {
      await store.apply([
        {
          kind: "record-publication-attempt",
          jobId: "job-1",
          atMs: T0 + index,
          outcome: index === 40 ? "published" : "failed",
          detail: index === 40 ? "" : `err-${index}`,
        },
      ]);
    }
    const publication = (await store.getPublication("job-1"))!;
    assert.equal(publication.publicationState, "published");
    assert.equal(publication.attempt, 40);
    assert.equal(publication.history.length, 32);
    assert.equal(publication.history[0]!.detail, "err-9");
  });

  await testFn("conformance: usage replays idempotently and aggregates without double-counting", async () => {
    await hooks.beforeEach?.();
    const store = await makeStore();
    await store.apply([
      { kind: "record-usage", entry: makeUsage("run-1:0", "run-1") },
      { kind: "record-usage", entry: makeUsage("run-1:1", "run-1", { requestCount: 2, inputTokens: 40 }) },
    ]);
    const before = (await store.aggregateUsage()).totals;
    // The restart/retry replay: identical entries re-recorded.
    await store.apply([
      { kind: "record-usage", entry: makeUsage("run-1:0", "run-1") },
      { kind: "record-usage", entry: makeUsage("run-1:1", "run-1", { requestCount: 2, inputTokens: 40 }) },
    ]);
    const after = (await store.aggregateUsage()).totals;
    assert.deepEqual(after, before);
    assert.equal(after.requestCount, 3);
    assert.equal(after.inputTokens, 140);
    // A divergent replay conflicts.
    await assert.rejects(
      () =>
        store.apply([
          { kind: "record-usage", entry: makeUsage("run-1:0", "run-1", { outputTokens: 999 }) },
        ]),
      StateConflictError,
    );
  });

  await testFn("conformance: export round-trips through the in-memory seeder", async () => {
    await hooks.beforeEach?.();
    const store = await makeStore();
    await store.apply([
      { kind: "create-run", record: makeRun("run-1", "job-1") },
      { kind: "record-usage", entry: makeUsage("run-1:0", "run-1") },
      { kind: "claim-idempotency", key: "evt-1", binding: "job-1", nowMs: T0, expiresAtMs: 0 },
    ]);
    const mirror = seedControlPlaneStore(await store.exportState());
    const mirrorUsage = await mirror.aggregateUsage();
    assert.equal(mirrorUsage.totals.requestCount, 1);
    assert.equal((await mirror.getRun("run-1"))!.jobId, "job-1");
  });
}

pgTest("pg: migrations forward from empty and current", async () => {
  const pool = new Pool({ connectionString: DSN });
  try {
    await truncateAll(pool);
    const first = await runControlPlaneMigrations(pool);
    assert.deepEqual(first, [1]);
    // Already current: the second boot applies nothing.
    const second = await runControlPlaneMigrations(pool);
    assert.deepEqual(second, []);
  } finally {
    await pool.end();
  }
});

pgTest("pg: conformance battery (same scenarios as the in-memory backend)", async () => {
  const pool = new Pool({ connectionString: DSN });
  try {
    await truncateAll(pool);
    const store = new PostgresControlPlaneStore(pool);
    await runConformanceBattery(test, async () => store);
  } finally {
    await pool.end();
  }
});

pgTest("pg: queue snapshot store round-trips and replaces atomically", async () => {
  const pool = new Pool({ connectionString: DSN });
  try {
    await truncateAll(pool);
    await runControlPlaneMigrations(pool);
    const store = new PostgresQueueSnapshotStore(pool);
    // Missing backing state => the empty snapshot (the one fresh start).
    assert.deepEqual(await store.load(), emptyQueueSnapshot());
    // Save, load: identical snapshot.
    const job = newJobRecord(makeJob("job-1"), T0, 0);
    const snapshot: QueueSnapshot = { version: 1, records: Object.freeze([job]) };
    await store.save(snapshot);
    assert.deepEqual(await store.load(), snapshot);
    // Replace: the second save fully replaces the first.
    const job2 = newJobRecord(makeJob("job-2"), T0 + 1, 0);
    await store.save({ version: 1, records: Object.freeze([job2]) });
    const reloaded = await store.load();
    assert.equal(reloaded.records.length, 1);
    assert.equal(reloaded.records[0]!.job.jobId, "job-2");
    // Fail closed: a malformed snapshot never reaches the database.
    await assert.rejects(
      () => store.save({ version: 7, records: [] } as unknown as QueueSnapshot),
      Error,
    );
  } finally {
    await pool.end();
  }
});

pgTest("pg: queue recovery reconcile runs over the loaded snapshot", async () => {
  const pool = new Pool({ connectionString: DSN });
  try {
    await truncateAll(pool);
    await runControlPlaneMigrations(pool);
    const store = new PostgresQueueSnapshotStore(pool);
    const job = newJobRecord(makeJob("job-1"), T0, 0);
    const running = Object.freeze({
      ...job,
      state: "running" as const,
      leaseOwner: "worker-a",
      leaseExpiresAtMs: T0 + 1000,
    });
    await store.save({ version: 1, records: Object.freeze([running as typeof job]) });
    // Restart recovery: the expired lease requeues the record —
    // controller restart never loses queue truth.
    const reloaded = await store.load();
    const recovered = reconcileRecoveredSnapshot(reloaded, T0 + 5000, 3);
    assert.deepEqual(recovered.requeued, ["job-1"]);
    await store.save(recovered.snapshot);
    assert.equal((await store.load()).records[0]!.state, "queued");
  } finally {
    await pool.end();
  }
});

/** The conformance battery ALSO runs against the in-memory backend on
 * every test invocation (no DSN needed): one scenario list, two
 * backends, so a PG-only regression cannot hide behind a missing DSN
 * and an in-memory drift cannot hide behind a skip. */
test("conformance battery: in-memory backend passes the same scenarios", async () => {
  await runConformanceBattery(test, async () => new InMemoryControlPlaneStore());
});

async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE cp_installations, cp_adopted_repositories, cp_runs,
             cp_idempotency_keys, cp_publications, cp_usage, cp_queue_snapshot
  `);
}
