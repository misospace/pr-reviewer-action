/** The transactional `ControlPlaneStore` seam (#736): atomic batches,
 * CAS run transitions (stale completions rejected), lease/heartbeat
 * semantics, idempotency claims, publication retry history, batch
 * atomicity, and restart-through-export (a restarted controller's
 * state round-trips through validation). */

import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryControlPlaneStore,
  PUBLICATION_HISTORY_CAP,
  StateConflictError,
  newRunRecord,
  seedControlPlaneStore,
  type PublicationRecord,
  type RunRecord,
  type StateExport,
  type StateMutation,
  type UsageRecord,
} from "../src/state/index.js";


const T0 = 1_000_000;

function makeRun(runId: string, jobId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  const base = newRunRecord(
    {
      runId,
      jobId,
      kind: "review",
      executorIdentity: "local:v1",
      headSha: "abcdef1234567",
      configFingerprint: "abcdef1234567890",
    },
    T0,
  );
  return Object.freeze({ ...base, ...overrides }) as RunRecord;
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
    resultPayload: '{"verdict":"approved"}',
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

test("apply applies every mutation of a valid batch", async () => {
  const store = new InMemoryControlPlaneStore();
  const run = makeRun("run-1", "job-1");
  await store.apply([
    { kind: "put-publication", record: makePublication("job-1") },
    { kind: "create-run", record: run },
    {
      kind: "transition-run",
      runId: "run-1",
      from: "queued",
      to: "starting",
      nowMs: T0 + 10,
    },
    {
      kind: "claim-idempotency",
      key: "evt-1",
      binding: "job-1",
      nowMs: T0 + 10,
      expiresAtMs: 0,
    },
    { kind: "record-usage", entry: makeUsage("run-1:0", "run-1") },
  ]);
  assert.equal((await store.getRun("run-1"))!.state, "starting");
  assert.equal((await store.getRun("run-1"))!.startedAtMs, 0);
  assert.equal((await store.getIdempotencyKey("evt-1"))!.binding, "job-1");
  assert.equal((await store.getPublication("job-1"))!.jobId, "job-1");
  assert.equal((await store.aggregateUsage()).totals.requestCount, 1);
});

test("batch atomicity: a conflicting later mutation rejects the whole batch", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([{ kind: "create-run", record: makeRun("run-1", "job-1") }]);
  await assert.rejects(
    async () =>
      await store.apply([
        {
          kind: "transition-run",
          runId: "run-1",
          from: "queued",
          to: "starting",
          nowMs: T0 + 5,
        },
        // Duplicate run id: the FIRST mutation must not survive.
        { kind: "create-run", record: makeRun("run-1", "job-2") },
      ]),
    StateConflictError,
  );
  assert.equal((await store.getRun("run-1"))!.state, "queued");
  assert.equal((await store.getRun("run-1"))!.updatedAtMs, T0);
});

test("create-run conflicts on a duplicate run id", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([{ kind: "create-run", record: makeRun("run-1", "job-1") }]);
  await assert.rejects(
    () => store.apply([{ kind: "create-run", record: makeRun("run-1", "job-2") }]),
    StateConflictError,
  );
});

test("CAS transition: stale completions are rejected, store unchanged", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([
    { kind: "create-run", record: makeRun("run-1", "job-1") },
    { kind: "transition-run", runId: "run-1", from: "queued", to: "starting", nowMs: T0 + 1 },
    { kind: "transition-run", runId: "run-1", from: "starting", to: "running", nowMs: T0 + 2 },
    { kind: "transition-run", runId: "run-1", from: "running", to: "superseded", nowMs: T0 + 3 },
  ]);
  // A stale worker publishes/completes the superseded generation: the
  // CAS `from` no longer matches, so the whole mutation is rejected.
  await assert.rejects(
    async () =>
      await store.apply([
        {
          kind: "transition-run",
          runId: "run-1",
          from: "running",
          to: "publishing",
          nowMs: T0 + 4,
        },
      ]),
    StateConflictError,
  );
  const run = (await store.getRun("run-1"))!;
  assert.equal(run.state, "superseded");
  assert.equal(run.resultHeadSha, "");
  assert.equal(run.finishedAtMs, T0 + 3);
});

test("transition-run follows the queue's table and stamps lifecycle times", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([{ kind: "create-run", record: makeRun("run-1", "job-1") }]);
  // Illegal jump (queued -> running) is a programmer error.
  await assert.rejects(
    async () =>
      await store.apply([
        { kind: "transition-run", runId: "run-1", from: "queued", to: "running", nowMs: T0 + 1 },
      ]),
    RangeError,
  );
  await store.apply([
    { kind: "transition-run", runId: "run-1", from: "queued", to: "starting", nowMs: T0 + 1 },
    { kind: "transition-run", runId: "run-1", from: "starting", to: "running", nowMs: T0 + 2 },
    { kind: "transition-run", runId: "run-1", from: "running", to: "publishing", nowMs: T0 + 3 },
    {
      kind: "transition-run",
      runId: "run-1",
      from: "publishing",
      to: "completed",
      patch: { resultHeadSha: "abcdef1234567" },
      nowMs: T0 + 4,
    },
  ]);
  const run = (await store.getRun("run-1"))!;
  assert.equal(run.startedAtMs, T0 + 2);
  assert.equal(run.finishedAtMs, T0 + 4);
  assert.equal(run.resultHeadSha, "abcdef1234567");
});

test("transition-run into a terminal state stamps finishedAtMs exactly once", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([
    { kind: "create-run", record: makeRun("run-1", "job-1") },
    { kind: "transition-run", runId: "run-1", from: "queued", to: "failed", nowMs: T0 + 1 },
  ]);
  const run = (await store.getRun("run-1"))!;
  assert.equal(run.finishedAtMs, T0 + 1);
  assert.equal(run.failureReason, "");
});

test("transition-run validates patches fail closed", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([{ kind: "create-run", record: makeRun("run-1", "job-1") }]);
  await assert.rejects(
    async () =>
      await store.apply([
        {
          kind: "transition-run",
          runId: "run-1",
          from: "queued",
          to: "starting",
          patch: { resultHeadSha: "NOT-A-SHA" },
          nowMs: T0 + 1,
        },
      ]),
    /malformed patch/,
  );
  await assert.rejects(
    async () =>
      await store.apply([
        {
          kind: "transition-run",
          runId: "run-1",
          from: "queued",
          to: "starting",
          patch: { failureReason: "bad\u0000reason" },
          nowMs: T0 + 1,
        },
      ]),
    /malformed patch/,
  );
});

test("transition-run rejects an unknown run and a non-finite nowMs", async () => {
  const store = new InMemoryControlPlaneStore();
  await assert.rejects(
    async () =>
      await store.apply([
        { kind: "transition-run", runId: "ghost", from: "queued", to: "starting", nowMs: T0 },
      ]),
    StateConflictError,
  );
  await assert.rejects(
    async () =>
      await store.apply([
        { kind: "transition-run", runId: "ghost", from: "queued", to: "starting", nowMs: Number.NaN },
      ]),
    RangeError,
  );
});

test("lease: claim, expiry, steal-after-expiry, terminal refusal", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([{ kind: "create-run", record: makeRun("run-1", "job-1") }]);
  assert.equal(await store.claimRun("run-1", "worker-a", T0, 1000), true);
  assert.equal((await store.getRun("run-1"))!.leaseOwner, "worker-a");
  // A different owner cannot steal a live lease.
  assert.equal(await store.claimRun("run-1", "worker-b", T0 + 500, 1000), false);
  assert.equal((await store.getRun("run-1"))!.leaseOwner, "worker-a");
  // The same owner re-claims (idempotent renewal by claim).
  assert.equal(await store.claimRun("run-1", "worker-a", T0 + 900, 1000), true);
  // After expiry a new owner claims.
  assert.equal(await store.claimRun("run-1", "worker-b", T0 + 3000, 1000), true);
  assert.equal((await store.getRun("run-1"))!.leaseOwner, "worker-b");
  // Terminal runs are never claimable.
  await store.apply([
    { kind: "transition-run", runId: "run-1", from: "queued", to: "cancelled", nowMs: T0 + 3001 },
  ]);
  assert.equal(await store.claimRun("run-1", "worker-c", T0 + 4000, 1000), false);
  // Unknown runs are never claimable.
  assert.equal(await store.claimRun("ghost", "worker-c", T0 + 4000, 1000), false);
});

test("heartbeat renews only for the live lease holder", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([{ kind: "create-run", record: makeRun("run-1", "job-1") }]);
  assert.equal(await store.heartbeatRun("run-1", "worker-a", T0, 1000), false);
  await store.claimRun("run-1", "worker-a", T0, 1000);
  assert.equal(await store.heartbeatRun("run-1", "worker-b", T0 + 100, 1000), false);
  assert.equal(await store.heartbeatRun("run-1", "worker-a", T0 + 100, 1000), true);
  assert.equal((await store.getRun("run-1"))!.leaseExpiresAtMs, T0 + 1100);
  // A lost/expired lease cannot be renewed by its previous owner.
  assert.equal(await store.heartbeatRun("run-1", "worker-a", T0 + 5000, 1000), false);
  assert.equal((await store.getRun("run-1"))!.leaseExpiresAtMs, T0 + 1100);
});

test("lease/heartbeat helpers fail closed on bad arguments", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([{ kind: "create-run", record: makeRun("run-1", "job-1") }]);
  await assert.rejects(() => store.claimRun("run-1", "w", Number.NaN, 1000), RangeError);
  await assert.rejects(() => store.claimRun("run-1", "w", T0, 0), RangeError);
  await assert.rejects(() => store.claimRun("run-1", "w", T0, -5), RangeError);
  await assert.rejects(() => store.heartbeatRun("run-1", "w", Number.NaN, 1000), RangeError);
  await assert.rejects(() => store.heartbeatRun("run-1", "w", T0, -1), RangeError);
});

test("idempotency: same binding replays, different binding conflicts, expiry re-claims", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([
    { kind: "claim-idempotency", key: "evt-1", binding: "job-1", nowMs: T0, expiresAtMs: 0 },
  ]);
  // Redelivery of the same event: idempotent replay, no error.
  await store.apply([
    { kind: "claim-idempotency", key: "evt-1", binding: "job-1", nowMs: T0 + 5, expiresAtMs: 0 },
  ]);
  assert.equal((await store.getIdempotencyKey("evt-1"))!.binding, "job-1");
  // A DIFFERENT work item on the same unexpired key conflicts.
  await assert.rejects(
    async () =>
      await store.apply([
        { kind: "claim-idempotency", key: "evt-1", binding: "job-2", nowMs: T0 + 6, expiresAtMs: 0 },
      ]),
    StateConflictError,
  );
  // Expiry re-claims.
  await store.apply([
    {
      kind: "claim-idempotency",
      key: "evt-exp",
      binding: "old",
      nowMs: T0,
      expiresAtMs: T0 + 100,
    },
  ]);
  await store.apply([
    {
      kind: "claim-idempotency",
      key: "evt-exp",
      binding: "new",
      nowMs: T0 + 101,
      expiresAtMs: 0,
    },
  ]);
  assert.equal((await store.getIdempotencyKey("evt-exp"))!.binding, "new");
});

test("claim-idempotency fails closed on bad arguments", async () => {
  const store = new InMemoryControlPlaneStore();
  await assert.rejects(
    async () =>
      await store.apply([
        { kind: "claim-idempotency", key: "k", binding: "b", nowMs: Number.NaN, expiresAtMs: 0 },
      ]),
    RangeError,
  );
  await assert.rejects(
    async () =>
      await store.apply([
        {
          kind: "claim-idempotency",
          key: "k",
          binding: "b",
          nowMs: T0,
          expiresAtMs: -1,
        },
      ]),
    RangeError,
  );
});

test("publication retry: history grows from the stored record, capped oldest-first", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([
    {
      kind: "put-publication",
      record: makePublication("job-1", {
        resultHeadSha: "abcdef1234567",
        destination: "github-comment:42",
      }),
    },
  ]);
  // Retry loop: each attempt reads the STORED record and appends.
  for (let index = 1; index <= PUBLICATION_HISTORY_CAP + 5; index += 1) {
    await store.apply([
      {
        kind: "record-publication-attempt",
        jobId: "job-1",
        atMs: T0 + index,
        outcome: index === PUBLICATION_HISTORY_CAP + 5 ? "published" : "failed",
        detail: index === PUBLICATION_HISTORY_CAP + 5 ? "" : `err-${index}`,
      },
    ]);
  }
  const publication = (await store.getPublication("job-1"))!;
  assert.equal(publication.publicationState, "published");
  assert.equal(publication.attempt, PUBLICATION_HISTORY_CAP + 5);
  assert.equal(publication.history.length, PUBLICATION_HISTORY_CAP);
  // Oldest dropped first: the first kept entry is attempt #6.
  assert.equal(publication.history[0]!.detail, "err-6");
  assert.equal(publication.history[publication.history.length - 1]!.outcome, "published");
});

test("record-publication-attempt rejects an unknown publication", async () => {
  const store = new InMemoryControlPlaneStore();
  await assert.rejects(
    async () =>
      await store.apply([
        {
          kind: "record-publication-attempt",
          jobId: "ghost",
          atMs: T0,
          outcome: "attempt",
          detail: "",
        },
      ]),
    StateConflictError,
  );
});

test("failed publication attempt records the error and state", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([{ kind: "put-publication", record: makePublication("job-1") }]);
  await store.apply([
    {
      kind: "record-publication-attempt",
      jobId: "job-1",
      atMs: T0 + 1,
      outcome: "failed",
      detail: "forge 502",
    },
  ]);
  const publication = (await store.getPublication("job-1"))!;
  assert.equal(publication.publicationState, "failed");
  assert.equal(publication.lastError, "forge 502");
  assert.equal(publication.attempt, 1);
  // Retrying must never cost the durable payload: without it a retry
  // could only mean rerunning the model.
  assert.equal(publication.resultPayload, '{"verdict":"approved"}');
});

test("restart through export: full state survives identically", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([
    {
      kind: "put-installation",
      record: {
        installationId: "123",
        platform: "github",
        profileName: "default",
        accountLogin: "octo-org",
        configRef: "cfg-1",
        createdAtMs: T0,
        updatedAtMs: T0,
      },
    },
    { kind: "put-adopted-repository", record: {
      platform: "github",
      installationId: "123",
      repoFullName: "octo-org/repo",
      adoptionEpoch: "epoch-1",
      configFingerprint: "abcdef1234567890",
      headFingerprint: "",
      enabled: true,
      adoptedAtMs: T0,
      updatedAtMs: T0,
    } },
    { kind: "create-run", record: makeRun("run-1", "job-1") },
    { kind: "transition-run", runId: "run-1", from: "queued", to: "starting", nowMs: T0 + 1 },
    { kind: "transition-run", runId: "run-1", from: "starting", to: "running", nowMs: T0 + 2 },
    { kind: "claim-idempotency", key: "evt-1", binding: "job-1", nowMs: T0, expiresAtMs: 0 },
    { kind: "put-publication", record: makePublication("job-1") },
    { kind: "record-usage", entry: makeUsage("run-1:0", "run-1") },
  ]);
  await store.claimRun("run-1", "worker-a", T0 + 3, 1000);

  // A "restarted controller": a NEW store instance seeded from the
  // export — process memory is gone, durable state is not.
  const restarted = seedControlPlaneStore((await store.exportState()));
  const before = (await store.exportState());
  const after = (await restarted.exportState());
  assert.deepEqual(after, before);
  assert.equal((await restarted.getRun("run-1"))!.state, "running");
  assert.equal((await restarted.getRun("run-1"))!.leaseOwner, "worker-a");
  assert.equal((await restarted.getIdempotencyKey("evt-1"))!.binding, "job-1");
  assert.equal((await restarted.getPublication("job-1"))!.resultPayload, '{"verdict":"approved"}');
  assert.ok((await restarted.getAdoptedRepository("github", "123", "octo-org/repo")) !== null);
  assert.ok((await restarted.getInstallation("123")) !== null);
  assert.equal((await restarted.aggregateUsage()).totals.requestCount, 1);
});

test("seedControlPlaneStore fails closed on malformed exports", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([{ kind: "create-run", record: makeRun("run-1", "job-1") }]);
  const valid = (await store.exportState());
  assert.throws(() => seedControlPlaneStore(null), /top-level value/);
  assert.throws(() => seedControlPlaneStore({ ...valid, version: 2 }), /version/);
  assert.throws(() => seedControlPlaneStore({ ...valid, runs: "nope" }), /array/);
  assert.throws(
    () => seedControlPlaneStore({ ...valid, runs: [{ bogus: true }] }),
    /malformed run record/,
  );
  assert.throws(
    () =>
      seedControlPlaneStore({
        ...valid,
        runs: [makeRun("run-1", "job-1"), makeRun("run-1", "job-2")],
      }),
    /duplicate run id/,
  );
  assert.throws(
    () =>
      seedControlPlaneStore({
        ...valid,
        idempotencyKeys: [
          { key: "k", binding: "a", createdAtMs: T0, expiresAtMs: 0 },
          { key: "k", binding: "b", createdAtMs: T0, expiresAtMs: 0 },
        ],
      }),
    /duplicate idempotency key/,
  );
});

test("export is frozen and mutations do not leak through it", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([{ kind: "create-run", record: makeRun("run-1", "job-1") }]);
  const exported = (await store.exportState());
  assert.equal(Object.isFrozen(exported), true);
  assert.equal(Object.isFrozen(exported.runs), true);
  await store.apply([
    { kind: "transition-run", runId: "run-1", from: "queued", to: "starting", nowMs: T0 + 1 },
  ]);
  assert.equal((exported.runs[0] as RunRecord).state, "queued");
});

test("apply validates every mutation shape", async () => {
  const store = new InMemoryControlPlaneStore();
  await assert.rejects(() => store.apply("nope" as unknown as StateMutation[]), TypeError);
  await assert.rejects(
    async () =>
      await store.apply([
        {
          kind: "put-installation",
          record: { bogus: true } as unknown as never,
        },
      ]),
    /malformed installation/,
  );
  await assert.rejects(
    async () =>
      await store.apply([
        {
          kind: "put-adopted-repository",
          record: { bogus: true } as unknown as never,
        },
      ]),
    /malformed adopted-repository/,
  );
  await assert.rejects(
    () => store.apply([{ kind: "create-run", record: { bogus: true } as unknown as RunRecord }]),
    /malformed run/,
  );
  await assert.rejects(
    async () =>
      await store.apply([
        { kind: "put-publication", record: { bogus: true } as unknown as PublicationRecord },
      ]),
    /malformed publication/,
  );
  await assert.rejects(
    () => store.apply([{ kind: "record-usage", entry: { bogus: true } as unknown as UsageRecord }]),
    /malformed usage/,
  );
});

test("installations and adopted repositories round-trip through typed getters", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([
    {
      kind: "put-installation",
      record: {
        installationId: "123",
        platform: "github",
        profileName: "default",
        accountLogin: "octo-org",
        configRef: "cfg-1",
        createdAtMs: T0,
        updatedAtMs: T0,
      },
    },
    {
      kind: "put-adopted-repository",
      record: {
        platform: "forgejo",
        installationId: "456",
        repoFullName: "forge/repo",
        adoptionEpoch: "epoch-1",
        configFingerprint: "abcdef1234567890",
        headFingerprint: "abcdef1234567",
        enabled: true,
        adoptedAtMs: T0,
        updatedAtMs: T0,
      },
    },
  ]);
  assert.ok((await store.getInstallation("123")) !== null);
  assert.equal((await store.getInstallation("999")), null);
  assert.equal((await store.getAdoptedRepository("github", "123", "missing")), null);
  const adopted = (await store.getAdoptedRepository("forgejo", "456", "forge/repo"));
  assert.ok(adopted !== null);
  assert.equal(adopted!.enabled, true);
  assert.equal(adopted!.headFingerprint, "abcdef1234567");
});

test("an adopted repository with an empty installation id is refused", async () => {
  const store = new InMemoryControlPlaneStore();
  await assert.rejects(
    async () =>
      await store.apply([
        {
          kind: "put-adopted-repository",
          record: {
            platform: "forgejo",
            installationId: "",
            repoFullName: "forge/repo",
            adoptionEpoch: "epoch-1",
            configFingerprint: "abcdef1234567890",
            headFingerprint: "abcdef1234567",
            enabled: true,
            adoptedAtMs: T0,
            updatedAtMs: T0,
          } as never,
        },
      ]),
    Error,
  );
});

test("supersededByJobId patch flows through transition-run", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([
    { kind: "create-run", record: makeRun("run-1", "job-1") },
    {
      kind: "transition-run",
      runId: "run-1",
      from: "queued",
      to: "superseded",
      patch: { failureReason: "superseded-by-newer-head", supersededByJobId: "job-2" },
      nowMs: T0 + 1,
    },
  ]);
  const run = (await store.getRun("run-1"))!;
  assert.equal(run.state, "superseded");
  assert.equal(run.supersededByJobId, "job-2");
  assert.equal(run.failureReason, "superseded-by-newer-head");
});

test("usage-free StateExport serializes losslessly as JSON", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([
    { kind: "create-run", record: makeRun("run-1", "job-1") },
    { kind: "record-usage", entry: makeUsage("run-1:0", "run-1") },
  ]);
  const round = JSON.parse(JSON.stringify((await store.exportState()))) as StateExport;
  const restarted = seedControlPlaneStore(round);
  assert.deepEqual((await restarted.exportState()), (await store.exportState()));
});
