/** The daemon's sync-over-async queue persistence adapter (#1348):
 * construction fail-closed on uncertain backend state, cache == durable
 * truth (rollback on failed persist), latched persistence errors, ordered
 * concurrent persists, malformed-snapshot refusal before any mutation, and
 * flush() as the shutdown durability proof. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  emptyQueueSnapshot,
  newJobRecord,
  type QueueSnapshot,
} from "../src/queue/index.js";
import type { QueueSnapshotStore } from "../src/state/index.js";
import {
  createSnapshotBackedQueueStore,
  SnapshotQueueStoreError,
} from "../src/controller/snapshot-adapter.js";
import type { ReviewJob } from "../src/jobs/types.js";

function makeJob(jobId: string): ReviewJob {
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
  });
}

function makeSnapshot(jobIds: readonly string[]): QueueSnapshot {
  const records = jobIds.map((jobId) => newJobRecord(makeJob(jobId), 1000, 0));
  return Object.freeze({ version: 1, records: Object.freeze(records) });
}

/** Scriptable async backend recording the persisted order. */
class FakeSnapshotStore implements QueueSnapshotStore {
  readonly savedOrder: number[] = [];
  private next = 1;
  private current: QueueSnapshot = emptyQueueSnapshot();
  private failNextSave = false;
  private failed = false;

  async load(): Promise<QueueSnapshot> {
    return this.current;
  }

  async save(snapshot: QueueSnapshot): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      this.failed = true;
      throw new Error("simulated database outage");
    }
    this.savedOrder.push(this.next);
    this.next += 1;
    this.current = snapshot;
  }

  failOnce(): void {
    this.failNextSave = true;
  }

  hasFailed(): boolean {
    return this.failed;
  }

  /** The raw current snapshot (for hostile-injection tests). */
  peek(): QueueSnapshot {
    return this.current;
  }
}

/** A backend whose load throws: the daemon must refuse to start. */
class CorruptBackend implements QueueSnapshotStore {
  async load(): Promise<QueueSnapshot> {
    throw new Error("corrupt state");
  }

  async save(_snapshot: QueueSnapshot): Promise<void> {
    throw new Error("unreachable");
  }
}

test("construction fails closed when the backend cannot prove its state", async () => {
  await assert.rejects(
    () => createSnapshotBackedQueueStore(new CorruptBackend()),
    /corrupt state/,
  );
});

test("load returns the initially loaded snapshot; save persists and load observes it", async () => {
  const backend = new FakeSnapshotStore();
  const store = await createSnapshotBackedQueueStore(backend);
  const initial = store.load();
  assert.equal(initial.version, 1);
  assert.equal(initial.records.length, 0);

  const snapshot = makeSnapshot(["job-1"]);
  store.save(snapshot);
  assert.equal(store.pending(), true, "persist is in flight before flush");
  await store.flush();
  assert.equal(store.pending(), false);
  assert.deepEqual(store.load(), snapshot);
  assert.deepEqual(backend.peek(), snapshot);
  assert.equal(store.persistenceError(), "");
});

test("a failed persist latches, rolls the cache back to durable truth, and reports on flush", async () => {
  const backend = new FakeSnapshotStore();
  const store = await createSnapshotBackedQueueStore(backend);
  const first = makeSnapshot(["job-1"]);
  store.save(first);
  await store.flush();

  backend.failOnce();
  const second = makeSnapshot(["job-1", "job-2"]);
  store.save(second);
  // The cache advanced (the caller's save "succeeded" synchronously)…
  assert.equal(store.load().records.length, 2);
  await assert.rejects(() => store.flush(), SnapshotQueueStoreError);
  // …but the failure rolled it back to what is actually durable.
  assert.deepEqual(store.load(), first);
  assert.notEqual(store.persistenceError(), "");
  assert.equal(backend.hasFailed(), true);
});

test("a later successful save clears the latch", async () => {
  const backend = new FakeSnapshotStore();
  const store = await createSnapshotBackedQueueStore(backend);
  const first = makeSnapshot(["job-1"]);
  store.save(first);
  await store.flush();

  backend.failOnce();
  store.save(makeSnapshot(["job-1", "job-2"]));
  await store.flush().catch(() => undefined);
  assert.notEqual(store.persistenceError(), "");

  const third = makeSnapshot(["job-3"]);
  store.save(third);
  await store.flush();
  assert.equal(store.persistenceError(), "");
  assert.deepEqual(store.load(), third);
  assert.deepEqual(backend.peek(), third);
});

test("concurrent saves persist in call order", async () => {
  const backend = new FakeSnapshotStore();
  const store = await createSnapshotBackedQueueStore(backend);
  store.save(makeSnapshot(["a"]));
  store.save(makeSnapshot(["a", "b"]));
  store.save(makeSnapshot(["a", "b", "c"]));
  await store.flush();
  assert.deepEqual(backend.savedOrder, [1, 2, 3]);
  assert.equal(store.load().records.length, 3);
});

test("a malformed snapshot is refused before any cache mutation or backend call", async () => {
  const backend = new FakeSnapshotStore();
  const store = await createSnapshotBackedQueueStore(backend);
  const good = makeSnapshot(["job-1"]);
  store.save(good);
  await store.flush();
  const savedBefore = backend.savedOrder.length;

  // Hostile shapes (#252 discipline): wrong version, unknown top-level
  // key, non-object garbage — each refused with the store unchanged.
  const hostile: readonly unknown[] = [
    { version: 2, records: [] },
    { version: 1, records: [], smuggled: true },
    "not-a-snapshot",
    null,
  ];
  for (const candidate of hostile) {
    assert.throws(
      () => store.save(candidate as QueueSnapshot),
      (err: unknown) => !(err instanceof SnapshotQueueStoreError),
      "malformed input must surface as the parser's own failure",
    );
    assert.deepEqual(store.load(), good);
    assert.equal(backend.savedOrder.length, savedBefore);
  }
});

test("flush resolves when healthy and rejects when a failure is latched", async () => {
  const backend = new FakeSnapshotStore();
  const store = await createSnapshotBackedQueueStore(backend);
  store.save(makeSnapshot(["job-1"]));
  await store.flush();

  backend.failOnce();
  store.save(makeSnapshot(["job-2"]));
  await assert.rejects(() => store.flush(), SnapshotQueueStoreError);
});

test("the adapter requires a real backend object", async () => {
  await assert.rejects(
    // @ts-expect-error — hostile input at the boundary
    () => createSnapshotBackedQueueStore(null),
    TypeError,
  );
  await assert.rejects(
    // @ts-expect-error — hostile input at the boundary
    () => createSnapshotBackedQueueStore({ load: () => Promise.resolve(emptyQueueSnapshot()) }),
    TypeError,
  );
});
