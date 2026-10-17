/** Job lifecycle state machine (#731): the full 64-pair transition
 * table, the active/terminal partitions, `prIdentityKey` stability,
 * `newJobRecord` settle math, and fail-closed guards (illegal
 * transitions, non-finite clocks, bad settle windows). */

import test from "node:test";
import assert from "node:assert/strict";

import {
  canTransition,
  isActiveState,
  isTerminalState,
  newJobRecord,
  prIdentityKey,
  withState,
  type JobLifecycleState,
  type JobRecord,
} from "../src/queue/types.js";
import type { ReviewJob } from "../src/jobs/types.js";

// ── fixtures ────────────────────────────────────────────────────────────

/** A fully-populated immutable ReviewJob; overrides win. */
function makeJob(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return Object.freeze({
    jobId: "gen-000000000000000000000001",
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
    configFingerprint: "0123456789abcdef",
    nonce: "",
    adoptionEpoch: "",
    eventReference: "",
    fork: false,
    deadlineAtMs: 0,
    runId: "",
    ...overrides,
  });
}

/** Build a record in any of the eight states: non-terminal states via
 * legal `withState` chains, terminal states via direct construction
 * (no legal transition into them from `queued` exists). */
function recordIn(state: JobLifecycleState, overrides: Partial<JobRecord> = {}): JobRecord {
  let record: JobRecord = newJobRecord(makeJob(), 0, 0);
  const path: Partial<Record<JobLifecycleState, readonly JobLifecycleState[]>> = {
    starting: ["starting"],
    running: ["starting", "running"],
    publishing: ["starting", "running", "publishing"],
  };
  for (const step of path[state] ?? []) {
    record = withState(record, step, 0);
  }
  if (isTerminalState(state)) {
    record = Object.freeze({
      ...record,
      state,
      failureReason: state === "failed" ? "test-failure" : "",
      supersededByJobId: state === "superseded" ? "gen-newer" : "",
    } as JobRecord);
  }
  return Object.freeze({ ...record, ...overrides } as JobRecord);
}

const ALL: readonly JobLifecycleState[] = [
  "queued",
  "starting",
  "running",
  "publishing",
  "completed",
  "failed",
  "cancelled",
  "superseded",
];

/** The settled transition table: the ONLY allowed targets per state. */
const ALLOWED: Record<JobLifecycleState, readonly JobLifecycleState[]> = {
  queued: ["starting", "cancelled", "superseded", "failed"],
  starting: ["running", "queued", "failed", "cancelled", "superseded"],
  running: ["publishing", "queued", "failed", "cancelled", "superseded"],
  publishing: ["completed", "queued", "failed", "cancelled", "superseded"],
  completed: [],
  failed: [],
  cancelled: [],
  superseded: [],
};

// ── state machine: full table ───────────────────────────────────────────

test("canTransition matches the settled table for every from×to pair (64 cases)", () => {
  for (const from of ALL) {
    for (const to of ALL) {
      assert.equal(
        canTransition(from, to),
        ALLOWED[from].includes(to),
        `expected ${from} -> ${to} = ${ALLOWED[from].includes(to)}`,
      );
    }
  }
});

test("withState permits exactly the table's legal transitions and stamps the clock", () => {
  for (const from of ALL) {
    for (const to of ALLOWED[from]) {
      const record = recordIn(from);
      const next = withState(record, to, 42);
      assert.equal(next.state, to, `${from} -> ${to}`);
      assert.equal(next.updatedAtMs, 42, `${from} -> ${to} clock stamp`);
      assert.equal(next.enqueuedAtMs, record.enqueuedAtMs, "no other field moves");
    }
  }
});

test("withState rejects every illegal transition in the table", () => {
  for (const from of ALL) {
    for (const to of ALL) {
      if (ALLOWED[from].includes(to)) continue;
      assert.throws(
        () => withState(recordIn(from), to, 1),
        RangeError,
        `${from} -> ${to} must be rejected`,
      );
    }
  }
});

test("withState rejects non-finite clocks", () => {
  const record = recordIn("queued");
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => withState(record, "starting", bad),
      RangeError,
      `nowMs=${String(bad)}`,
    );
  }
});

test("withState never mutates its input", () => {
  const record = newJobRecord(makeJob(), 100, 0);
  withState(record, "starting", 200);
  assert.equal(record.state, "queued");
  assert.equal(record.updatedAtMs, 100);
  assert.ok(Object.isFrozen(record));
});

// ── active/terminal partitions ──────────────────────────────────────────

test("active states are exactly {starting, running, publishing}", () => {
  assert.deepEqual(
    ALL.filter(isActiveState).sort(),
    ["publishing", "running", "starting"],
  );
});

test("terminal states are exactly {completed, failed, cancelled, superseded}", () => {
  assert.deepEqual(
    ALL.filter(isTerminalState).sort(),
    ["cancelled", "completed", "failed", "superseded"],
  );
});

test("active and terminal are disjoint; queued belongs to neither", () => {
  for (const state of ALL) {
    assert.notEqual(
      isActiveState(state) && isTerminalState(state),
      true,
      `${state} cannot be both active and terminal`,
    );
    if (state === "queued") {
      assert.equal(isActiveState(state), false);
      assert.equal(isTerminalState(state), false);
    }
  }
});

// ── prIdentityKey ───────────────────────────────────────────────────────

test("prIdentityKey is `${platform}/${installationId}/${repoFullName}#${prNumber}/${kind}`", () => {
  assert.equal(prIdentityKey(makeJob()), "github/12345/owner/repo#7/review");
});

test("prIdentityKey is stable under head/config/nonce/reason/trigger changes", () => {
  const base = prIdentityKey(makeJob());
  assert.equal(
    base,
    prIdentityKey(
      makeJob({
        headSha: "dd44ee55ff66aa77bb88cc990011223344556677",
        configFingerprint: "fedcba9876543210",
        nonce: "manual-rerun-1",
        adoptionEpoch: "epoch-2",
        reason: "rereview_label",
        trigger: "manual",
      }),
    ),
  );
});

test("prIdentityKey is NOT stable across kinds: follow_up has its own scope", () => {
  const review = prIdentityKey(makeJob());
  const followUp = prIdentityKey(makeJob({ kind: "follow_up" }));
  assert.notEqual(followUp, review, "a follow_up never shares a prKey with a review");
  assert.equal(followUp, "github/12345/owner/repo#7/follow_up");
});

test("prIdentityKey separates platform/installation/repo/pr within one kind", () => {
  const followUp = prIdentityKey(makeJob({ kind: "follow_up" }));
  assert.notEqual(prIdentityKey(makeJob({ kind: "follow_up", platform: "forgejo" })), followUp);
  assert.notEqual(
    prIdentityKey(makeJob({ kind: "follow_up", installationId: "99999" })),
    followUp,
  );
  assert.notEqual(
    prIdentityKey(makeJob({ kind: "follow_up", repoFullName: "other/repo" })),
    followUp,
  );
  assert.notEqual(prIdentityKey(makeJob({ kind: "follow_up", prNumber: 8 })), followUp);
});

test("prIdentityKey changes with each identity component", () => {
  const base = prIdentityKey(makeJob());
  assert.notEqual(prIdentityKey(makeJob({ platform: "forgejo" })), base);
  assert.notEqual(prIdentityKey(makeJob({ installationId: "99999" })), base);
  assert.notEqual(prIdentityKey(makeJob({ repoFullName: "other/repo" })), base);
  assert.notEqual(prIdentityKey(makeJob({ prNumber: 8 })), base);
});

// ── newJobRecord: settle math + hostile inputs ─────────────────────────

test("newJobRecord settles: readyAtMs = nowMs + settleWindowMs, attempt 0, sentinels", () => {
  const job = makeJob();
  const record = newJobRecord(job, 1000, 2500);
  assert.equal(record.state, "queued");
  assert.equal(record.job, job, "the job reference is carried through");
  assert.equal(record.prKey, prIdentityKey(job));
  assert.equal(record.enqueuedAtMs, 1000);
  assert.equal(record.readyAtMs, 3500);
  assert.equal(record.attempt, 0);
  assert.equal(record.nextRetryAtMs, 0);
  assert.equal(record.leaseOwner, "");
  assert.equal(record.leaseExpiresAtMs, 0);
  assert.equal(record.cancelRequested, false);
  assert.equal(record.resultHeadSha, "");
  assert.equal(record.failureReason, "");
  assert.equal(record.supersededByJobId, "");
  assert.equal(record.updatedAtMs, 1000);
  assert.ok(Object.isFrozen(record));
});

test("newJobRecord with settleWindowMs 0 is ready immediately", () => {
  const record = newJobRecord(makeJob(), 50, 0);
  assert.equal(record.readyAtMs, 50);
});

test("newJobRecord rejects non-finite nowMs", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => newJobRecord(makeJob(), bad, 100),
      RangeError,
      `nowMs=${String(bad)}`,
    );
  }
});

test("newJobRecord rejects non-finite, negative, and non-integer settle windows", () => {
  for (const bad of [NaN, Infinity, -Infinity, -1, -0.5, 0.5, 1.5]) {
    assert.throws(
      () => newJobRecord(makeJob(), 100, bad),
      RangeError,
      `settleWindowMs=${String(bad)}`,
    );
  }
});

test("newJobRecord accepts a large finite settle window", () => {
  const record = newJobRecord(makeJob(), 1, 2 ** 31);
  assert.equal(record.readyAtMs, 1 + 2 ** 31);
});

// ── happy-path chain ────────────────────────────────────────────────────

test("happy path: queued -> starting -> running -> publishing -> completed", () => {
  let record = newJobRecord(makeJob(), 10, 0);
  record = withState(record, "starting", 20);
  record = withState(record, "running", 30);
  record = withState(record, "publishing", 40);
  record = withState(record, "completed", 50);
  assert.equal(record.state, "completed");
  assert.equal(record.updatedAtMs, 50);
  assert.equal(record.enqueuedAtMs, 10);
  assert.equal(record.failureReason, "", "completion carries no failure reason");
});
