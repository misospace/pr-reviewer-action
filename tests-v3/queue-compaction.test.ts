/** Terminal-record compaction (#736): retention drop, cap drop
 * (oldest first), the protection rules (never drop a terminal sibling
 * of an active generation; never drop the newest terminal record per
 * prKey), fail-closed options, and input immutability. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  compactQueueSnapshot,
  emptyQueueSnapshot,
  newJobRecord,
  prIdentityKey,
  type JobRecord,
  type QueueSnapshot,
} from "../src/queue/index.js";
import type { ReviewJob } from "../src/jobs/types.js";

const T0 = 1_000_000;

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

function makeRecord(jobId: string, state: JobRecord["state"], updatedAtMs: number, prOverrides: Partial<ReviewJob> = {}): JobRecord {
  const base = newJobRecord(makeJob(jobId, prOverrides), T0, 0);
  // Compaction consumes only state/prKey/updatedAtMs/jobId, so the
  // record is stamped directly (state-legality is the scheduler's
  // concern, already covered by queue-state.test.ts).
  return Object.freeze({ ...base, state, updatedAtMs });
}

function snapshotOf(records: readonly JobRecord[]): QueueSnapshot {
  return { version: 1, records: Object.freeze([...records]) };
}

const RETENTION = 10_000;

test("compaction drops terminal records past the retention horizon", () => {
  const old = makeRecord("job-old", "completed", T0 - 20_000);
  const fresh = makeRecord("job-fresh", "completed", T0 - 1_000);
  const result = compactQueueSnapshot(snapshotOf([old, fresh]), {
    nowMs: T0,
    retentionMs: RETENTION,
    maxTerminalRecords: 100,
  });
  assert.deepEqual(result.dropped, ["job-old"]);
  assert.deepEqual(
    result.snapshot.records.map((r) => r.job.jobId),
    ["job-fresh"],
  );
});

test("compaction keeps terminal records inside the retention horizon when nothing else forces a drop", () => {
  const edge = makeRecord("job-edge", "failed", T0 - RETENTION);
  const result = compactQueueSnapshot(snapshotOf([edge]), {
    nowMs: T0,
    retentionMs: RETENTION,
    maxTerminalRecords: 100,
  });
  // Exactly at the horizon boundary is NOT older than the horizon, and
  // the cap (100) is not over — the record stays.
  assert.deepEqual(result.dropped, []);
});

test("aged-out terminal history for a settled prKey drops entirely", () => {
  const older = makeRecord("job-older", "completed", T0 - 20_000);
  const newer = makeRecord("job-newer", "superseded", T0 - 19_000);
  const result = compactQueueSnapshot(snapshotOf([older, newer]), {
    nowMs: T0,
    retentionMs: RETENTION,
    maxTerminalRecords: 100,
  });
  // Same prKey, no active generation: BOTH age out by retention. The
  // durable last-good result lives in the run/publication layer, not
  // in the queue snapshot.
  assert.deepEqual(result.dropped, ["job-newer", "job-older"]);
  assert.equal(result.snapshot.records.length, 0);
});

test("compaction never drops a terminal sibling of an active generation", () => {
  const supersededSibling = makeRecord("job-superseded", "superseded", T0 - 20_000);
  const active = makeRecord("job-active", "running", T0 - 100, {
    prNumber: 2,
  });
  const result = compactQueueSnapshot(snapshotOf([supersededSibling, active]), {
    nowMs: T0,
    retentionMs: RETENTION,
    maxTerminalRecords: 0,
  });
  // The active record is for prNumber 2, the terminal for prNumber 1 —
  // different prKeys, so the terminal one is droppable. Now the same-
  // prKey case: an ACTIVE generation with an aged-out superseded
  // sibling must keep the sibling.
  const activeSame = makeRecord("job-active-2", "running", T0 - 100, { prNumber: 3 });
  const siblingSame = makeRecord("job-sibling", "superseded", T0 - 20_000, { prNumber: 3 });
  const guarded = compactQueueSnapshot(snapshotOf([siblingSame, activeSame]), {
    nowMs: T0,
    retentionMs: RETENTION,
    maxTerminalRecords: 0,
  });
  assert.deepEqual(guarded.dropped, []);
  assert.deepEqual(
    guarded.snapshot.records.map((r) => r.job.jobId),
    ["job-sibling", "job-active-2"],
  );
  assert.deepEqual(result.dropped, ["job-superseded"]);
});

test("cap drops the oldest droppable terminal records first", () => {
  const a = makeRecord("job-a", "completed", T0 - 500);
  const b = makeRecord("job-b", "completed", T0 - 400, { prNumber: 2 });
  const c = makeRecord("job-c", "completed", T0 - 300, { prNumber: 3 });
  const d = makeRecord("job-d", "completed", T0 - 200, { prNumber: 4 });
  const result = compactQueueSnapshot(snapshotOf([a, b, c, d]), {
    nowMs: T0,
    retentionMs: RETENTION,
    maxTerminalRecords: 2,
  });
  // Nothing is aged out yet (all within retention), so the cap does
  // the dropping, oldest-updated first.
  assert.deepEqual(result.dropped, ["job-a", "job-b"]);
  assert.deepEqual(
    result.snapshot.records.map((r) => r.job.jobId),
    ["job-c", "job-d"],
  );
});

test("cap is best-effort: protected records may exceed it", () => {
  const protectedOld = makeRecord("job-protected", "superseded", T0 - 20_000, { prNumber: 3 });
  const activeSame = makeRecord("job-active", "running", T0 - 100, { prNumber: 3 });
  const droppable = makeRecord("job-droppable", "completed", T0 - 300, { prNumber: 4 });
  const result = compactQueueSnapshot(snapshotOf([protectedOld, activeSame, droppable]), {
    nowMs: T0,
    retentionMs: RETENTION,
    maxTerminalRecords: 0,
  });
  // The protected sibling survives even though the terminal count (2)
  // exceeds the cap; the droppable one goes.
  assert.deepEqual(result.dropped, ["job-droppable"]);
  assert.deepEqual(
    result.snapshot.records.map((r) => r.job.jobId),
    ["job-protected", "job-active"],
  );
});

test("compaction keeps non-terminal records regardless of age", () => {
  const staleActive = makeRecord("job-active", "queued", T0 - 500_000);
  const result = compactQueueSnapshot(snapshotOf([staleActive]), {
    nowMs: T0,
    retentionMs: RETENTION,
    maxTerminalRecords: 0,
  });
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(
    result.snapshot.records.map((r) => r.job.jobId),
    ["job-active"],
  );
});

test("follow_up and review generations for one PR are distinct prKeys", () => {
  const followUp = makeRecord("job-fu", "completed", T0 - 20_000, {
    kind: "follow_up",
    headSha: "",
    eventReference: "42",
    nonce: "",
  });
  const review = makeRecord("job-review", "completed", T0 - 19_000, { prNumber: 5 });
  const result = compactQueueSnapshot(snapshotOf([followUp, review]), {
    nowMs: T0,
    retentionMs: RETENTION,
    maxTerminalRecords: 0,
  });
  // Different kinds scope independently: both histories age out on
  // their own prKey (a follow_up sibling never protects a review
  // record or vice versa).
  assert.notEqual(prIdentityKey(followUp.job), prIdentityKey(review.job));
  assert.deepEqual(result.dropped, ["job-fu", "job-review"]);
});

test("compaction fails closed on bad options and never mutates the input", () => {
  const record = makeRecord("job-old", "completed", T0 - 20_000);
  const snapshot = snapshotOf([record]);
  assert.throws(
    () => compactQueueSnapshot(snapshot, { nowMs: Number.NaN, retentionMs: RETENTION, maxTerminalRecords: 0 }),
    RangeError,
  );
  assert.throws(
    () => compactQueueSnapshot(snapshot, { nowMs: T0, retentionMs: 0, maxTerminalRecords: 0 }),
    RangeError,
  );
  assert.throws(
    () => compactQueueSnapshot(snapshot, { nowMs: T0, retentionMs: -1, maxTerminalRecords: 0 }),
    RangeError,
  );
  assert.throws(
    () => compactQueueSnapshot(snapshot, { nowMs: T0, retentionMs: RETENTION, maxTerminalRecords: -1 }),
    RangeError,
  );
  assert.throws(
    () =>
      compactQueueSnapshot(snapshot, {
        nowMs: T0,
        retentionMs: RETENTION,
        maxTerminalRecords: 1.5,
      }),
    RangeError,
  );
  const before = JSON.stringify(snapshot);
  compactQueueSnapshot(snapshot, { nowMs: T0, retentionMs: RETENTION, maxTerminalRecords: 0 });
  assert.equal(JSON.stringify(snapshot), before);
});

test("compaction of an empty snapshot is the empty snapshot", () => {
  const result = compactQueueSnapshot(emptyQueueSnapshot(), {
    nowMs: T0,
    retentionMs: RETENTION,
    maxTerminalRecords: 0,
  });
  assert.deepEqual(result.dropped, []);
  assert.equal(result.snapshot.records.length, 0);
});

test("compaction result is frozen and validated-shaped", () => {
  const old = makeRecord("job-old", "completed", T0 - 20_000);
  const result = compactQueueSnapshot(snapshotOf([old]), {
    nowMs: T0,
    retentionMs: RETENTION,
    maxTerminalRecords: 100,
  });
  assert.equal(Object.isFrozen(result.snapshot), true);
  assert.equal(Object.isFrozen(result.snapshot.records), true);
});
