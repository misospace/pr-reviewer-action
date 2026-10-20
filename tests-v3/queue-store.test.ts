/** Durable queue snapshot store + crash-recovery reconciliation (#731):
 * file roundtrip, atomic overwrite (temp + fsync + rename, no temp
 * leftovers), fail-closed loads (corrupt / wrong version / unknown key /
 * malformed record vs. missing file), the reconcile matrix, and the
 * lease helpers. */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  emptyQueueSnapshot,
  InMemoryQueueStore,
  JsonFileQueueStore,
  leaseIsValid,
  newJobRecord,
  prIdentityKey,
  reconcileRecoveredSnapshot,
  withRenewedLease,
  withState,
  type JobRecord,
  type QueueSnapshot,
} from "../src/queue/index.js";
import type { ReviewJob } from "../src/jobs/types.js";

// ── fixtures & scratch space ────────────────────────────────────────────

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

/** A valid JobRecord in any state; overrides win (frozen result). */
function makeRecord(jobId: string, overrides: Partial<JobRecord> = {}): JobRecord {
  const job = makeJob(jobId);
  const record: JobRecord = Object.freeze({
    job,
    prKey: prIdentityKey(job),
    state: "queued",
    enqueuedAtMs: 0,
    readyAtMs: 0,
    attempt: 0,
    nextRetryAtMs: 0,
    leaseOwner: "",
    leaseExpiresAtMs: 0,
    cancelRequested: false,
    resultHeadSha: "",
    failureReason: "",
    supersededByJobId: "",
    updatedAtMs: 0,
    ...overrides,
  });
  return record;
}

function makeSnapshot(records: readonly JobRecord[]): QueueSnapshot {
  const snapshot: QueueSnapshot = {
    version: 1,
    records: Object.freeze(records),
  };
  return Object.freeze(snapshot);
}

const SCRATCH = mkdtempSync(path.join(tmpdir(), "queue-store-"));

/** A fresh scratch subdirectory. Tests clean it up in a `finally`. */
function makeDir(tag: string): string {
  return mkdtempSync(path.join(SCRATCH, `${tag}-`));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

after(() => {
  // Last-resort cleanup: remove whatever scratch state the tests left.
  rmSync(SCRATCH, { recursive: true, force: true });
});

// ── in-memory backend ───────────────────────────────────────────────────

test("in-memory store: fresh load is the empty snapshot; save then load round-trips", () => {
  const store = new InMemoryQueueStore();
  const fresh = store.load();
  assert.equal(fresh.version, 1);
  assert.deepEqual(fresh.records, []);

  const snapshot = makeSnapshot([makeRecord("job-a"), makeRecord("job-b")]);
  store.save(snapshot);
  const loaded = store.load();
  assert.equal(loaded.version, 1);
  assert.equal(loaded.records.length, 2);
  assert.deepEqual(loaded.records[0], snapshot.records[0]);
  assert.deepEqual(loaded.records[1], snapshot.records[1]);
  assert.ok(Object.isFrozen(loaded));
  assert.ok(Object.isFrozen(loaded.records));
});

test("in-memory store: save fails closed on an invalid snapshot", () => {
  const store = new InMemoryQueueStore();
  store.save(makeSnapshot([makeRecord("job-a")]));
  assert.throws(
    () => store.save({ version: 2, records: [] } as unknown as QueueSnapshot),
    /version must be 1/,
  );
  assert.throws(
    () =>
      store.save({
        version: 1,
        records: [],
        futureField: true,
      } as unknown as QueueSnapshot),
    /unknown top-level key/,
  );
  // The store still holds the last valid snapshot.
  assert.equal(store.load().records.length, 1);
});

// ── JSON file backend: roundtrip & atomicity ───────────────────────────

test("file store: constructor does no I/O (missing parent is fine until load)", () => {
  const dir = makeDir("ctor");
  try {
    assert.doesNotThrow(
      () => new JsonFileQueueStore(path.join(dir, "no-such-dir", "queue.json")),
    );
    assert.throws(() => new JsonFileQueueStore(""), RangeError);
  } finally {
    cleanup(dir);
  }
});

test("file store: save then load round-trips the snapshot", () => {
  const dir = makeDir("roundtrip");
  try {
    const file = path.join(dir, "queue.json");
    const original = makeSnapshot([
      makeRecord("job-a", { state: "running", attempt: 1, enqueuedAtMs: 111 }),
      makeRecord("job-b", { state: "completed" }),
    ]);
    new JsonFileQueueStore(file).save(original);

    const loaded = new JsonFileQueueStore(file).load();
    assert.equal(loaded.version, 1);
    assert.equal(loaded.records.length, 2);
    assert.deepEqual(loaded.records[0], original.records[0]);
    assert.deepEqual(loaded.records[1], original.records[1]);
  } finally {
    cleanup(dir);
  }
});

test("file store: atomic overwrite — no temp leftovers, target never partial", () => {
  const dir = makeDir("atomic");
  try {
    const file = path.join(dir, "queue.json");
    const store = new JsonFileQueueStore(file);

    // Pre-populate the target, then overwrite it.
    const before = makeSnapshot([makeRecord("old-1", { state: "running" })]);
    store.save(before);
    const after = makeSnapshot([makeRecord("new-1"), makeRecord("new-2")]);
    store.save(after);

    // The directory holds exactly the target file: no .tmp leftovers.
    assert.deepEqual(readdirSync(dir), ["queue.json"]);
    // The target is the NEW snapshot, fully valid JSON (no partial
    // state): the old content is gone, the new content is complete.
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      records: Array<{ job: { jobId: string } }>;
    };
    assert.deepEqual(
      raw.records.map((r) => r.job.jobId),
      ["new-1", "new-2"],
    );
    assert.deepEqual(new JsonFileQueueStore(file).load(), after);
  } finally {
    cleanup(dir);
  }
});

// ── JSON file backend: fail-closed loads ───────────────────────────────

function writeRawFile(dir: string, name: string, content: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, content);
  return file;
}

test("file store: missing file loads as the empty snapshot", () => {
  const dir = makeDir("missing");
  try {
    const loaded = new JsonFileQueueStore(path.join(dir, "does-not-exist.json")).load();
    assert.deepEqual(loaded, emptyQueueSnapshot());
  } finally {
    cleanup(dir);
  }
});

test("file store: corrupt (unparseable) file throws", () => {
  const dir = makeDir("corrupt");
  try {
    const file = writeRawFile(dir, "queue.json", "{ this is not json");
    assert.throws(() => new JsonFileQueueStore(file).load(), /corrupt/);
  } finally {
    cleanup(dir);
  }
});

test("file store: wrong version throws", () => {
  const dir = makeDir("version");
  try {
    const file = writeRawFile(
      dir,
      "queue.json",
      JSON.stringify({ version: 2, records: [] }),
    );
    assert.throws(() => new JsonFileQueueStore(file).load(), /version must be 1/);
  } finally {
    cleanup(dir);
  }
});

test("file store: unknown top-level key throws (forward-compat fails closed)", () => {
  const dir = makeDir("unknown-key");
  try {
    const file = writeRawFile(
      dir,
      "queue.json",
      JSON.stringify({ version: 1, records: [], futureField: true }),
    );
    assert.throws(
      () => new JsonFileQueueStore(file).load(),
      /unknown top-level key "futureField"/,
    );
  } finally {
    cleanup(dir);
  }
});

test("file store: non-object top level and missing records throw", () => {
  const dir = makeDir("shape");
  try {
    assert.throws(
      () =>
        new JsonFileQueueStore(
          writeRawFile(dir, "arr.json", JSON.stringify([1, 2])),
        ).load(),
      /plain object/,
    );
    assert.throws(
      () =>
        new JsonFileQueueStore(
          writeRawFile(dir, "no-records.json", JSON.stringify({ version: 1 })),
        ).load(),
      /records must be an array/,
    );
    assert.throws(
      () =>
        new JsonFileQueueStore(
          writeRawFile(
            dir,
            "bad-records.json",
            JSON.stringify({ version: 1, records: "nope" }),
          ),
        ).load(),
      /records must be an array/,
    );
  } finally {
    cleanup(dir);
  }
});

function rawRecord(
  jobId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const job = makeJob(jobId);
  return {
    job,
    prKey: prIdentityKey(job),
    state: "queued",
    enqueuedAtMs: 0,
    readyAtMs: 0,
    attempt: 0,
    nextRetryAtMs: 0,
    leaseOwner: "",
    resultHeadSha: "",
    failureReason: "",
    supersededByJobId: "",
    cancelRequested: false,
    leaseExpiresAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

test("file store: record shape violations throw on load", () => {
  const dir = makeDir("record-shape");
  try {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["unknown state", { state: "bogus" }],
      ["missing job", { job: undefined }],
      ["job not an object", { job: "nope" }],
      ["empty jobId", { job: { ...makeJob("x"), jobId: "" } }],
      ["negative time", { enqueuedAtMs: -1 }],
      ["non-integer attempt", { attempt: 1.5 }],
      ["negative attempt", { attempt: -2 }],
      ["non-boolean cancelRequested", { cancelRequested: "yes" }],
      ["non-string leaseOwner", { leaseOwner: 42 }],
      ["non-finite time (null after JSON)", { readyAtMs: null }],
    ];
    for (const [name, overrides] of cases) {
      const file = writeRawFile(
        dir,
        `${name.replace(/\W+/g, "-")}.json`,
        JSON.stringify({ version: 1, records: [rawRecord("x", overrides)] }),
      );
      assert.throws(
        () => new JsonFileQueueStore(file).load(),
        /malformed job record/,
        name,
      );
    }
    // A record with a missing field is also malformed.
    const { updatedAtMs, ...rest } = rawRecord("x");
    void updatedAtMs;
    const file = writeRawFile(
      dir,
      "missing-field.json",
      JSON.stringify({ version: 1, records: [rest] }),
    );
    assert.throws(() => new JsonFileQueueStore(file).load(), /malformed job record/);
  } finally {
    cleanup(dir);
  }
});

// ── fail-closed nested-job validation (#1130) ───────────────────────────

/** A plain job object carrying every contract field, so a case can drop
 * or corrupt exactly one of them. */
function rawJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: "job-raw",
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
  };
}

/** The same job object without one field (a missing field is
 * malformed). */
function rawJobWithout(field: string): Record<string, unknown> {
  const job = rawJob();
  delete job[field];
  return job;
}

/** The prKey a job implies — the same shape `prIdentityKey` builds. */
function rawPrKey(job: Record<string, unknown>): string {
  return `${String(job["platform"])}/${String(job["installationId"])}/${String(job["repoFullName"])}#${String(job["prNumber"])}/${String(job["kind"])}`;
}

/** A raw record around a raw job; the prKey agrees with the job unless
 * a case overrides it. */
function rawJobRecord(
  job: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    job,
    prKey: rawPrKey(job),
    state: "queued",
    enqueuedAtMs: 0,
    readyAtMs: 0,
    attempt: 0,
    nextRetryAtMs: 0,
    leaseOwner: "",
    leaseExpiresAtMs: 0,
    cancelRequested: false,
    resultHeadSha: "",
    failureReason: "",
    supersededByJobId: "",
    updatedAtMs: 0,
    ...overrides,
  };
}

/** A snapshot of raw (not yet validated) records. */
function rawSnapshot(
  records: readonly Record<string, unknown>[],
): QueueSnapshot {
  return Object.freeze({
    version: 1,
    records: Object.freeze(records as unknown as readonly JobRecord[]),
  });
}

test("file store: a malformed nested job fails the load closed", () => {
  const dir = makeDir("nested-job");
  try {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["incomplete nested job", { job: { jobId: "broken" } }],
      ["nested job missing a field", { job: rawJobWithout("baseSha") }],
      ["nested job missing runId", { job: rawJobWithout("runId") }],
      ["invalid kind", { job: rawJob({ kind: "reviewer" }) }],
      ["invalid trigger", { job: rawJob({ trigger: "schedule" }) }],
      ["invalid platform", { job: rawJob({ platform: "gitlab" }) }],
      ["non-integer prNumber", { job: rawJob({ prNumber: 7.5 }) }],
      ["non-positive prNumber", { job: rawJob({ prNumber: 0 }) }],
      ["negative prId", { job: rawJob({ prId: -1 }) }],
      ["non-boolean fork", { job: rawJob({ fork: "yes" }) }],
      ["empty repoFullName", { job: rawJob({ repoFullName: "" }) }],
      ["empty headSha on a review job", { job: rawJob({ headSha: "" }) }],
      ["malformed configFingerprint", { job: rawJob({ configFingerprint: "not-hex" }) }],
      ["malformed nonce", { job: rawJob({ nonce: "not a nonce" }) }],
      ["malformed adoptionEpoch", { job: rawJob({ adoptionEpoch: "not an epoch" }) }],
      ["non-empty eventReference on a review job", { job: rawJob({ eventReference: "17" }) }],
      [
        "follow_up without an eventReference",
        { job: rawJob({ kind: "follow_up", headSha: "", eventReference: "" }) },
      ],
      [
        "follow_up carrying a nonce",
        {
          job: rawJob({
            kind: "follow_up",
            headSha: "",
            eventReference: "17",
            nonce: "n1",
          }),
        },
      ],
      // Adversarial-boundary cases (#252 convention): feed the boundary
      // token ITSELF — a control character, a padded value, an
      // over-long value, an out-of-range id — not just benign input.
      ["job id with a newline", { job: rawJob({ jobId: "job\nid" }) }],
      ["job id with a DEL character", { job: rawJob({ jobId: "job\u007fid" }) }],
      ["reason with a control character", { job: rawJob({ reason: "syn\u0007chronize" }) }],
      ["repoFullName with a control character", { job: rawJob({ repoFullName: "owner/\u0007repo" }) }],
      ["runId with surrounding whitespace", { job: rawJob({ runId: " padded " }) }],
      ["runId longer than 128 characters", { job: rawJob({ runId: "r".repeat(129) }) }],
      ["runId with a control character", { job: rawJob({ runId: "run\u0007id" }) }],
      ["uppercase-hex headSha", { job: rawJob({ headSha: "AA11BB22CC33DD44EE55FF667788990001122334" }) }],
      ["headSha of 65 hex characters", { job: rawJob({ headSha: "a".repeat(65) }) }],
      ["negative deadlineAtMs", { job: rawJob({ deadlineAtMs: -1 }) }],
      ["non-integer deadlineAtMs", { job: rawJob({ deadlineAtMs: 1.5 }) }],
      ["installationId with a leading zero", { job: rawJob({ installationId: "012345" }) }],
      [
        "follow_up eventReference with a leading zero",
        { job: rawJob({ kind: "follow_up", headSha: "", eventReference: "017" }) },
      ],
      [
        "follow_up eventReference with 20 digits",
        {
          job: rawJob({
            kind: "follow_up",
            headSha: "",
            eventReference: "12345678901234567890",
          }),
        },
      ],
      ["nonce of 65 characters", { job: rawJob({ nonce: "n".repeat(65) }) }],
      ["adoptionEpoch of 65 characters", { job: rawJob({ adoptionEpoch: "e".repeat(65) }) }],
      ["configFingerprint that is too short", { job: rawJob({ configFingerprint: "abc" }) }],
      [
        "prNumber that is not a safe integer",
        { job: rawJob({ prNumber: Number.MAX_SAFE_INTEGER + 1 }) },
      ],
    ];
    for (const [name, overrides] of cases) {
      const file = writeRawFile(
        dir,
        `${name.replace(/\W+/g, "-")}.json`,
        JSON.stringify({
          version: 1,
          records: [rawJobRecord(rawJob(), overrides)],
        }),
      );
      assert.throws(
        () => new JsonFileQueueStore(file).load(),
        /malformed job record/,
        name,
      );
    }
  } finally {
    cleanup(dir);
  }
});

test("file store: a record whose prKey disagrees with its job fails the load closed", () => {
  const dir = makeDir("prkey");
  try {
    const file = writeRawFile(
      dir,
      "queue.json",
      JSON.stringify({
        version: 1,
        records: [
          rawJobRecord(rawJob(), {
            prKey: "github/12345/owner/repo#9/review",
          }),
        ],
      }),
    );
    assert.throws(
      () => new JsonFileQueueStore(file).load(),
      /prKey/,
      "prKey inconsistent with its job",
    );
  } finally {
    cleanup(dir);
  }
});

test("file store: two records with the same job id fail the load closed", () => {
  const dir = makeDir("duplicate");
  try {
    const job = rawJob({ jobId: "job-dup" });
    const file = writeRawFile(
      dir,
      "queue.json",
      JSON.stringify({
        version: 1,
        records: [rawJobRecord(job), rawJobRecord(job)],
      }),
    );
    assert.throws(
      () => new JsonFileQueueStore(file).load(),
      /duplicate/,
      "duplicate generation id",
    );
  } finally {
    cleanup(dir);
  }
});

test("in-memory store: save fails closed on a malformed job, an inconsistent prKey, and duplicate ids", () => {
  const store = new InMemoryQueueStore();
  assert.throws(
    () => store.save(rawSnapshot([rawJobRecord({ jobId: "broken" })])),
    /malformed job record/,
    "incomplete nested job",
  );
  assert.throws(
    () =>
      store.save(
        rawSnapshot([
          rawJobRecord(rawJob(), {
            prKey: "github/12345/owner/repo#9/review",
          }),
        ]),
      ),
    /prKey/,
    "prKey inconsistent with its job",
  );
  const duplicate = rawJob({ jobId: "job-dup" });
  assert.throws(
    () =>
      store.save(
        rawSnapshot([rawJobRecord(duplicate), rawJobRecord(duplicate)]),
      ),
    /duplicate/,
    "duplicate generation id",
  );
});

test("file store: sentinel-valued jobs and a follow_up job round-trip unchanged", () => {
  const dir = makeDir("sentinels");
  try {
    const file = path.join(dir, "queue.json");
    const sentinel = makeJob("job-sentinel", {
      configFingerprint: "",
      nonce: "",
      adoptionEpoch: "",
      eventReference: "",
      baseSha: "",
      deadlineAtMs: 0,
      runId: "",
      fork: false,
      installationId: "",
    });
    const followUp = makeJob("job-followup", {
      kind: "follow_up",
      headSha: "",
      eventReference: "17",
    });
    const original = makeSnapshot([
      makeRecord("job-sentinel", { job: sentinel, prKey: prIdentityKey(sentinel) }),
      makeRecord("job-followup", { job: followUp, prKey: prIdentityKey(followUp) }),
    ]);

    new JsonFileQueueStore(file).save(original);
    const loaded = new JsonFileQueueStore(file).load();

    assert.equal(loaded.records.length, 2);
    assert.deepEqual(loaded.records[0], original.records[0]);
    assert.deepEqual(loaded.records[1], original.records[1]);
    assert.equal(loaded.records[0]!.job.installationId, "");
    assert.equal(loaded.records[0]!.job.baseSha, "");
    assert.equal(loaded.records[0]!.job.headSha, sentinel.headSha);
    assert.equal(loaded.records[1]!.job.kind, "follow_up");
    assert.equal(loaded.records[1]!.job.eventReference, "17");
  } finally {
    cleanup(dir);
  }
});

test("the empty snapshot's records array is frozen", () => {
  const snapshot = emptyQueueSnapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(
    Object.isFrozen(snapshot.records),
    "the shared empty snapshot's records array is frozen",
  );
  assert.throws(
    () => {
      (snapshot.records as JobRecord[]).push(makeRecord("job-x"));
    },
    TypeError,
    "a frozen records array cannot be pushed into",
  );
  assert.equal(snapshot.records.length, 0, "the empty snapshot stays empty");
});

test("the loaded nested job is rebuilt and frozen", () => {
  const store = new InMemoryQueueStore();
  const job = Object.freeze({
    ...makeJob("job-frozen"),
    extraField: "dropped",
  });
  const record = makeRecord("job-frozen", {
    job,
    prKey: prIdentityKey(job),
  });
  store.save(makeSnapshot([record]));

  const loaded = store.load();
  const loadedJob = loaded.records[0]!.job;
  assert.notEqual(loadedJob, job, "the nested job is rebuilt, not carried by reference");
  assert.ok(Object.isFrozen(loadedJob), "the rebuilt job is frozen");
  assert.throws(
    () => {
      (loadedJob as { jobId: string }).jobId = "mutated";
    },
    TypeError,
    "a frozen job cannot be mutated",
  );
  assert.equal(loadedJob.jobId, "job-frozen", "the value is unchanged");
  assert.equal(
    "extraField" in loadedJob,
    false,
    "unknown extra job fields are dropped",
  );
});

// ── reconcileRecoveredSnapshot ─────────────────────────────────────────

const NOW = 1_000_000;

test("reconcile: live-lease active, queued, and terminal records pass through unchanged", () => {
  const live = withRenewedLease(
    withState(
      withState(newJobRecord(makeJob("j-live"), 0, 0), "starting", 0),
      "running",
      0,
    ),
    "worker-1",
    NOW - 100,
    1000, // expires at NOW + 900, still live
  );
  const queued = newJobRecord(makeJob("j-queued"), 0, 0);
  const completed = withState(
    withState(
      withState(
        withState(newJobRecord(makeJob("j-done"), 0, 0), "starting", 0),
        "running",
        0,
      ),
      "publishing",
      0,
    ),
    "completed",
    0,
  );
  const snapshot = makeSnapshot([live, queued, completed]);
  const before = JSON.stringify(snapshot);

  const result = reconcileRecoveredSnapshot(snapshot, NOW, 3);

  assert.deepEqual(result.requeued, []);
  assert.deepEqual(result.failed, []);
  assert.equal(result.snapshot.version, 1);
  assert.equal(result.snapshot.records.length, 3);
  // Identical records, in order, same references (untouched).
  assert.equal(result.snapshot.records[0], live);
  assert.equal(result.snapshot.records[1], queued);
  assert.equal(result.snapshot.records[2], completed);
  // The input snapshot was never mutated.
  assert.equal(JSON.stringify(snapshot), before);
});

test("reconcile: absent and expired leases requeue active records under the limit", () => {
  const unleased = withState(
    withState(newJobRecord(makeJob("j-a"), 0, 0), "starting", 0),
    "running",
    0,
  );
  const expired = withRenewedLease(
    withState(
      withState(newJobRecord(makeJob("j-b"), 0, 0), "starting", 0),
      "running",
      0,
    ),
    "worker-2",
    0,
    500, // expires at 500 <= NOW
  );
  const unleasedPublishing = withState(
    withState(
      withState(newJobRecord(makeJob("j-c"), 0, 0), "starting", 0),
      "running",
      0,
    ),
    "publishing",
    0,
  );
  const zeroExpiryLeased = makeRecord("j-d", {
    state: "running",
    leaseOwner: "worker-3",
    leaseExpiresAtMs: 0, // a lease without an expiry is treated as gone
  });

  const result = reconcileRecoveredSnapshot(
    makeSnapshot([unleased, expired, unleasedPublishing, zeroExpiryLeased]),
    NOW,
    3,
  );

  assert.deepEqual(result.requeued, ["j-a", "j-b", "j-c", "j-d"]);
  assert.deepEqual(result.failed, []);
  for (const record of result.snapshot.records) {
    assert.equal(record.state, "queued");
    assert.equal(record.attempt, 0, "attempt unchanged: it counts dispatches only");
    assert.equal(record.readyAtMs, NOW);
    assert.equal(record.nextRetryAtMs, 0);
    assert.equal(record.leaseOwner, "");
    assert.equal(record.leaseExpiresAtMs, 0);
    assert.equal(record.cancelRequested, false);
    assert.equal(record.updatedAtMs, NOW);
  }
});

test("reconcile: publishing WITH a durable result stays publishing, lease cleared; without a result it requeues", () => {
  const resultSha = "aa11bb22cc33dd44ee55ff667788990001122334";
  const publishWithResult = makeRecord("j-keep", {
    state: "publishing",
    attempt: 1,
    leaseOwner: "lease-stale",
    leaseExpiresAtMs: NOW - 1, // expired
    resultHeadSha: resultSha,
  });
  const publishWithResultAtLimit = makeRecord("j-keep-2", {
    state: "publishing",
    attempt: 3, // at the attempt limit: still never failed
    resultHeadSha: resultSha,
  });
  const publishNoResult = makeRecord("j-rerun", {
    state: "publishing",
    attempt: 1,
    leaseOwner: "lease-stale",
    leaseExpiresAtMs: NOW - 1,
    resultHeadSha: "", // no durable result: current requeue behavior
  });

  const result = reconcileRecoveredSnapshot(
    makeSnapshot([publishWithResult, publishWithResultAtLimit, publishNoResult]),
    NOW,
    3,
  );

  assert.deepEqual(result.requeued, ["j-rerun"]);
  assert.deepEqual(result.failed, []);

  const kept = result.snapshot.records[0]!;
  assert.equal(kept.state, "publishing", "durable work is never requeued or failed");
  assert.equal(kept.resultHeadSha, resultSha);
  assert.equal(kept.leaseOwner, "", "the abandoned lease is cleared");
  assert.equal(kept.leaseExpiresAtMs, 0);

  const keptAtLimit = result.snapshot.records[1]!;
  assert.equal(keptAtLimit.state, "publishing");
  assert.equal(keptAtLimit.leaseOwner, "");
  assert.equal(keptAtLimit.leaseExpiresAtMs, 0);

  const rerun = result.snapshot.records[2]!;
  assert.equal(rerun.state, "queued", "a result-less publish keeps requeuing");
  assert.equal(rerun.readyAtMs, NOW);
});

test("reconcile: at the attempt limit the record fails with the lease-expired reason", () => {
  const exhausted = makeRecord("j-x", { state: "running", attempt: 3 });
  const oneBefore = makeRecord("j-y", { state: "running", attempt: 2 });

  const result = reconcileRecoveredSnapshot(
    makeSnapshot([exhausted, oneBefore]),
    NOW,
    3,
  );
  assert.deepEqual(result.requeued, ["j-y"]);
  assert.deepEqual(result.failed, ["j-x"]);

  const failed = result.snapshot.records[0]!;
  assert.equal(failed.state, "failed");
  assert.equal(failed.failureReason, "lease-expired-attempt-limit");
  assert.equal(failed.attempt, 3, "attempt is not incremented on the terminal move");
  assert.equal(failed.leaseOwner, "");
  assert.equal(failed.leaseExpiresAtMs, 0);

  const requeued = result.snapshot.records[1]!;
  assert.equal(requeued.state, "queued");
  assert.equal(requeued.attempt, 2, "attempt unchanged on the requeue move");
  assert.equal(requeued.readyAtMs, NOW);
});

test("reconcile: moved-job arrays are sorted lexicographically", () => {
  const records = [
    makeRecord("zeta", { state: "running" }),
    makeRecord("alpha", { state: "running" }),
    makeRecord("mid", { state: "publishing" }),
    makeRecord("omega", { state: "running", attempt: 3 }),
  ];
  const result = reconcileRecoveredSnapshot(makeSnapshot(records), NOW, 3);
  assert.deepEqual(result.requeued, ["alpha", "mid", "zeta"]);
  assert.deepEqual(result.failed, ["omega"]);
});

test("reconcile: never mutates the input snapshot or its records", () => {
  const victim = makeRecord("j-v", { state: "running", cancelRequested: true, attempt: 1 });
  const snapshot = makeSnapshot([victim]);
  const before = JSON.stringify(snapshot);

  const result = reconcileRecoveredSnapshot(snapshot, NOW, 5);

  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(victim.state, "running");
  assert.equal(victim.cancelRequested, true);
  const moved = result.snapshot.records[0]!;
  assert.notEqual(moved, victim, "a new record instance");
  assert.equal(moved.state, "queued");
  assert.equal(moved.cancelRequested, false);
  assert.equal(moved.attempt, 1, "attempt unchanged on the requeue move");
});

test("reconcile: non-finite nowMs and invalid maxAttempts throw RangeError", () => {
  const snapshot = makeSnapshot([makeRecord("j", { state: "running" })]);
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => reconcileRecoveredSnapshot(snapshot, bad, 3), RangeError);
  }
  for (const bad of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => reconcileRecoveredSnapshot(snapshot, NOW, bad), RangeError);
  }
});

test("reconcile: an empty snapshot reconciles to an empty snapshot", () => {
  const result = reconcileRecoveredSnapshot(emptyQueueSnapshot(), NOW, 3);
  assert.deepEqual(result.snapshot, emptyQueueSnapshot());
  assert.deepEqual(result.requeued, []);
  assert.deepEqual(result.failed, []);
});

test("reconcile: a moved record carries a rebuilt, frozen job", () => {
  const job = makeJob("j-moved");
  const record = makeRecord("j-moved", { state: "running", job });
  const result = reconcileRecoveredSnapshot(makeSnapshot([record]), NOW, 3);

  const moved = result.snapshot.records[0]!;
  assert.equal(moved.state, "queued", "the abandoned record is requeued");
  assert.notEqual(moved.job, job, "the moved record carries a rebuilt job");
  assert.ok(Object.isFrozen(moved.job), "the rebuilt job is frozen");
  assert.deepEqual(moved.job, job, "the rebuilt job has the same content");
});

test("reconcile: a malformed or duplicate-laden snapshot is not adopted", () => {
  const malformed = rawSnapshot([
    rawJobRecord({ jobId: "broken" }),
  ]) as QueueSnapshot;
  assert.throws(
    () => reconcileRecoveredSnapshot(malformed, NOW, 3),
    /malformed job record/,
    "malformed nested job",
  );
  const duplicate = rawJob({ jobId: "job-dup" });
  const duplicated = rawSnapshot([
    rawJobRecord(duplicate),
    rawJobRecord(duplicate),
  ]) as QueueSnapshot;
  assert.throws(
    () => reconcileRecoveredSnapshot(duplicated, NOW, 3),
    /duplicate/,
    "duplicate generation id",
  );
});

// ── lease helpers ──────────────────────────────────────────────────────

test("leaseIsValid: owner match and expiry strictly in the future", () => {
  const leased = withRenewedLease(
    makeRecord("j", { state: "running" }),
    "worker-9",
    1000,
    500,
  );
  assert.equal(leaseIsValid(leased, "worker-9", 1499), true);
  assert.equal(leaseIsValid(leased, "worker-9", 1500), false, "expiry == now is not live");
  assert.equal(leaseIsValid(leased, "worker-9", 1501), false);
  assert.equal(leaseIsValid(leased, "other-worker", 1499), false);
  assert.equal(leaseIsValid(leased, "", 1499), false);
  assert.equal(leaseIsValid(makeRecord("j"), "worker-9", 1499), false, "unleased record");
  assert.equal(
    leaseIsValid(leased, "worker-9", NaN),
    false,
    "non-finite clock fails closed",
  );
});

test("withRenewedLease: stamps owner/expiry/updatedAt and preserves the rest", () => {
  const record = makeRecord("j", { state: "running", enqueuedAtMs: 77, attempt: 2 });
  const renewed = withRenewedLease(record, "w", 1000, 250);
  assert.equal(renewed.leaseOwner, "w");
  assert.equal(renewed.leaseExpiresAtMs, 1250);
  assert.equal(renewed.updatedAtMs, 1000);
  assert.equal(renewed.state, "running");
  assert.equal(renewed.enqueuedAtMs, 77);
  assert.equal(renewed.attempt, 2);
  assert.equal(renewed.job, record.job, "the job reference is carried through");
  assert.ok(Object.isFrozen(renewed));
  assert.equal(record.leaseOwner, "", "input record is not mutated");
});

test("withRenewedLease: hostile inputs throw RangeError", () => {
  const record = makeRecord("j");
  assert.throws(() => withRenewedLease(record, "", 0, 100), RangeError);
  assert.throws(() => withRenewedLease(record, "w", 0, 0), RangeError);
  assert.throws(() => withRenewedLease(record, "w", 0, -5), RangeError);
  assert.throws(() => withRenewedLease(record, "w", 0, NaN), RangeError);
  assert.throws(() => withRenewedLease(record, "w", 0, Infinity), RangeError);
  assert.throws(() => withRenewedLease(record, "w", NaN, 100), RangeError);
  assert.throws(() => withRenewedLease(record, "w", Infinity, 100), RangeError);
});
