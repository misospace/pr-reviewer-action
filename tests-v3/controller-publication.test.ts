/** The daemon's durable publication path (#1348): persist-before-side-
 * effect ordering, retry from durable state without rerunning the model,
 * the exact-head gate outcomes (published / stale / expired / unreadable),
 * publication idempotency, usage idempotency, hostile-artifact refusal
 * fed directly at the boundary (#252), and the #1560 envelope-refusal
 * settlement: provably permanent envelope failures are terminal, I/O-class
 * ones are retried but bounded — and a full tracking map never resets an
 * active streak, it only reclaims provably-retired runs.
 *
 * WHAT IS PUBLISHED: the worker's structured REVIEW artifact — the
 * coordinate the validated execution result names
 * (`ExecutionResult.resultArtifactPath`) — never the `result.json`
 * execution wrapper beside it. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryControlPlaneStore,
  StateRecordValidationError,
  newRunRecord,
  validatePublication,
  type PublicationRecord,
} from "../src/state/index.js";
import { newJobRecord, withState } from "../src/queue/index.js";
import type { JobRecord } from "../src/queue/types.js";
import type { ReviewJob } from "../src/jobs/types.js";
import {
  createDurablePublisher,
  MAX_ENVELOPE_READ_ATTEMPTS,
  MAX_TRACKED_ENVELOPE_READ_FAILURES,
  type ForgeWriteCapability,
} from "../src/controller/publication.js";
import { durableResultPayloadFitsCeiling } from "../src/controller/forge-capability.js";
import {
  executionResultPath,
  executionRunDir,
  executionRunId,
} from "../src/controller/execution.js";
import { mirrorRunTransition } from "../src/controller/run-lifecycle.js";

const HEAD = "aa11bb22cc33dd44ee55ff667788990001122334";
const NEWER_HEAD = "bb22cc33dd44ee55ff66778899000112233444";

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
    configFingerprint: "ecfg-v1-0123456789abcdef",
    nonce: "",
    adoptionEpoch: "",
    eventReference: "",
    forgeIntegration: "",
    fork: false,
    deadlineAtMs: 0,
    runId: "",
    ...overrides,
  });
}

/** A record in the exact state the scheduler hands the publisher:
 * `publishing` with a durable result head, attempt already counted. */
function makePublishingRecord(jobId: string, resultHeadSha = HEAD): JobRecord {
  const base = newJobRecord(makeJob(jobId), 1000, 0);
  const started = { ...withState(withState(base, "starting", 1000), "running", 1000), attempt: 1 };
  return {
    ...withState(started, "publishing", 2000),
    resultHeadSha,
  };
}

/** The worker's structured REVIEW artifact — the content the
 * publication persists and writes to the forge. */
const REVIEW_ARTIFACT = Object.freeze({
  verdict: "issues",
  summary: "one finding",
  findings: [{ path: "src/app.ts", line: 12, message: "unvalidated input" }],
});

/** The EXECUTION wrapper the worker writes beside the review artifact:
 * the correlation record that NAMES the artifact. */
function executionEnvelope(
  jobId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: "completed",
    runId: executionRunId(jobId, 1),
    jobId,
    resultHeadSha: HEAD,
    failureCategory: "",
    failureMessage: "",
    resultArtifactPath: "",
    diagnostics: "",
    artifactPaths: [],
    resourceMs: 12,
    observedAtMs: 4000,
    ...overrides,
  };
}

interface ArtifactPaths {
  readonly envelopePath: string;
  readonly reviewPath: string;
}

/** Write the execution envelope and the review artifact it names, the
 * way a worker does: two files inside the attempt's run directory. */
function writeArtifacts(
  runsRoot: string,
  jobId: string,
  options: {
    readonly review?: unknown;
    readonly envelope?: Record<string, unknown>;
    /** Plant the review artifact as a symlink (a hostile run directory). */
    readonly symlinkReview?: boolean;
    /** Plant the ENVELOPE as a symlink. */
    readonly symlinkEnvelope?: boolean;
  } = {},
): ArtifactPaths {
  const runDir = executionRunDir(runsRoot, jobId, 1);
  mkdirSync(runDir, { recursive: true });
  const envelopePath = executionResultPath(runsRoot, jobId, 1);
  const reviewPath = join(runDir, "review.json");
  const review = options.review ?? REVIEW_ARTIFACT;
  writeFileSync(
    reviewPath,
    typeof review === "string" ? review : JSON.stringify(review),
    "utf8",
  );
  const envelope = executionEnvelope(jobId, {
    resultArtifactPath: reviewPath,
    ...(options.envelope ?? {}),
  });
  writeFileSync(envelopePath, JSON.stringify(envelope), "utf8");
  if (options.symlinkReview === true) {
    // #252: a symlink planted at the artifact coordinate must never be
    // followed into attacker-chosen bytes.
    writeFileSync(`${reviewPath}.target`, JSON.stringify({ verdict: "planted" }), "utf8");
    rmSync(reviewPath, { force: true });
    symlinkSync(`${reviewPath}.target`, reviewPath);
  }
  if (options.symlinkEnvelope === true) {
    writeFileSync(`${envelopePath}.target`, JSON.stringify({ verdict: "planted" }), "utf8");
    rmSync(envelopePath, { force: true });
    symlinkSync(`${envelopePath}.target`, envelopePath);
  }
  return { envelopePath, reviewPath };
}

interface ForgeCall {
  readonly job: ReviewJob;
  readonly resultPayload: string;
}

class FakeForge implements ForgeWriteCapability {
  readonly calls: ForgeCall[] = [];
  private failNext = false;

  async publish(input: { job: ReviewJob; resultPayload: string }): Promise<{ publicationId: string }> {
    this.calls.push({ job: input.job, resultPayload: input.resultPayload });
    if (this.failNext) {
      this.failNext = false;
      throw new Error("forge write failed");
    }
    return { publicationId: "github-comment:12345" };
  }

  failOnce(): void {
    this.failNext = true;
  }
}

interface Harness {
  readonly store: InMemoryControlPlaneStore;
  readonly forge: FakeForge;
  readonly heads: Array<string | null>;
  readonly runsRoot: string;
  publish(record: JobRecord): Promise<boolean>;
}

function setup(options: {
  currentHead?: string | null;
  heads?: Array<string | null>;
  store?: InMemoryControlPlaneStore;
} = {}): Harness {
  const store = options.store ?? new InMemoryControlPlaneStore();
  const forge = new FakeForge();
  const heads = [...(options.heads ?? [options.currentHead ?? HEAD])];
  const runsRoot = mkdtempSync(join(tmpdir(), "prv-pub-"));
  const publisher = createDurablePublisher({
    store,
    forge,
    currentHeadSha: async () => {
      const head = heads.shift();
      return head === undefined ? HEAD : head;
    },
    runsRoot,
    now: () => 5_000,
  });
  return {
    store,
    forge,
    heads,
    runsRoot,
    publish: (record) => publisher.publish(record),
  };
}

function cleanup(h: Harness): void {
  rmSync(h.runsRoot, { recursive: true, force: true });
}

/** Seed the attempt's control-plane run record (the daemon creates it
 * before the worker launches) so a terminal settlement has a durable
 * account to close. */
async function seedRun(store: InMemoryControlPlaneStore, jobId: string): Promise<void> {
  await store.apply([
    {
      kind: "create-run",
      record: newRunRecord(
        {
          runId: executionRunId(jobId, 1),
          jobId,
          kind: "review",
          executorIdentity: "local",
          headSha: HEAD,
          configFingerprint: "0123456789abcdef",
          attempt: 1,
        },
        3_000,
      ),
    },
  ]);
}

async function runState(store: InMemoryControlPlaneStore, jobId: string): Promise<string> {
  const run = await store.getRun(executionRunId(jobId, 1));
  assert.notEqual(run, null);
  return run!.state;
}

test("first publish persists the publication record before any forge side effect", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  writeArtifacts(h.runsRoot, "job-1");
  const order: string[] = [];
  const originalPublish = h.forge.publish.bind(h.forge);
  h.forge.publish = async (input) => {
    const persisted = await h.store.getPublication("job-1");
    order.push(persisted !== null ? "persisted" : "missing");
    return originalPublish(input);
  };
  const ok = await h.publish(makePublishingRecord("job-1"));
  assert.equal(ok, true);
  assert.deepEqual(order, ["persisted"], "the record is durable before the forge call");
  const record = await h.store.getPublication("job-1");
  assert.notEqual(record, null);
  assert.equal(record!.publicationState, "published");
  assert.equal(record!.publicationId, "github-comment:12345");
  assert.equal(record!.resultHeadSha, HEAD);
  assert.equal(h.forge.calls.length, 1);
  // The durable payload is the canonical single-line encoding of the
  // REVIEW artifact — the execution wrapper is never published.
  assert.equal(h.forge.calls[0]!.resultPayload, JSON.stringify(REVIEW_ARTIFACT));
  assert.equal(
    h.forge.calls[0]!.resultPayload.includes("resultArtifactPath"),
    false,
    "the execution wrapper is not the published payload",
  );
});

test("the published payload is the review artifact, never the execution wrapper", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  const { envelopePath } = writeArtifacts(h.runsRoot, "job-1");
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  const payload = h.forge.calls[0]!.resultPayload;
  const envelope = JSON.parse(readFileSync(envelopePath, "utf8")) as Record<string, unknown>;
  assert.notEqual(payload, JSON.stringify(envelope));
  assert.equal(payload, JSON.stringify(REVIEW_ARTIFACT));
  const durable = await h.store.getPublication("job-1");
  assert.equal(durable!.resultPayload, payload);
});

test("a forge failure records the attempt and a retry replays the durable payload without touching the artifact", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  writeArtifacts(h.runsRoot, "job-1");
  h.forge.failOnce();
  const first = await h.publish(makePublishingRecord("job-1"));
  assert.equal(first, false, "a forge failure is a retry-later, not a completion");
  const pending = await h.store.getPublication("job-1");
  assert.notEqual(pending, null);
  assert.equal(pending!.publicationState, "pending", "a transient forge failure is a retry-later");
  assert.equal(pending!.attempt, 1);
  const lastEntry = pending!.history[pending!.history.length - 1]!;
  assert.equal(lastEntry.outcome, "attempt");
  assert.equal(lastEntry.detail, "forge write failed");

  // Retry: the whole run directory is DELETED — the retry must read the
  // durable record, never the filesystem, and never rerun the model.
  rmSync(executionRunDir(h.runsRoot, "job-1", 1), { recursive: true, force: true });
  const second = await h.publish(makePublishingRecord("job-1"));
  assert.equal(second, true);
  assert.equal(h.forge.calls.length, 2);
  assert.equal(h.forge.calls[1]!.resultPayload, h.forge.calls[0]!.resultPayload);
  const done = await h.store.getPublication("job-1");
  assert.equal(done!.publicationState, "published");
  assert.equal(done!.attempt, 2);
});

test("an already-published record short-circuits without a second forge write", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  writeArtifacts(h.runsRoot, "job-1");
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  assert.equal(h.forge.calls.length, 1);
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  assert.equal(h.forge.calls.length, 1, "the replay is a no-op, never a second write");
});

test("a stale result never publishes and settles terminally", async (t) => {
  const h = setup({ heads: [NEWER_HEAD] });
  t.after(() => cleanup(h));
  writeArtifacts(h.runsRoot, "job-1");
  const ok = await h.publish(makePublishingRecord("job-1"));
  assert.equal(ok, true, "the queue record settles — a stale result is never retried forever");
  assert.equal(h.forge.calls.length, 0, "the forge write never happened");
  const record = await h.store.getPublication("job-1");
  assert.equal(record!.publicationState, "failed");
  assert.equal(record!.lastError, "stale-head");
});

test("an expired result never publishes", async (t) => {
  const expiredJob = makeJob("job-1", { deadlineAtMs: 3000 });
  const h = setup({ heads: [HEAD] });
  t.after(() => cleanup(h));
  writeArtifacts(h.runsRoot, "job-1");
  const record: JobRecord = {
    ...makePublishingRecord("job-1"),
    job: expiredJob,
  };
  const ok = await h.publish(record);
  assert.equal(ok, true);
  assert.equal(h.forge.calls.length, 0);
  const publication = await h.store.getPublication("job-1");
  assert.equal(publication!.publicationState, "failed");
  assert.equal(publication!.lastError, "expired");
});

test("an unreadable current head fails closed: no write, retry later", async (t) => {
  const h = setup({ heads: [null] });
  t.after(() => cleanup(h));
  writeArtifacts(h.runsRoot, "job-1");
  const ok = await h.publish(makePublishingRecord("job-1"));
  assert.equal(ok, false);
  assert.equal(h.forge.calls.length, 0);
  const record = await h.store.getPublication("job-1");
  assert.equal(record!.publicationState, "pending");
});

test("usage entries are recorded with stable ids and an identical replay does not double-count", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  writeArtifacts(h.runsRoot, "job-1", {
    review: {
      ...REVIEW_ARTIFACT,
      usage: [
        {
          route: "local-fast",
          role: "primary",
          requestCount: 2,
          inputTokens: 100,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          outputTokens: 50,
          costMicros: 0,
          costProvenance: "unknown",
        },
      ],
    },
  });
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  const once = await h.store.aggregateUsage();
  assert.equal(once.totals.requestCount, 2);
  assert.equal(once.totals.outputTokens, 50);
  // Replay the same publish call: the store conflicts on divergent
  // replays but an identical one is a no-op — the aggregate is unchanged.
  const store2 = h.store;
  await store2.apply([
    {
      kind: "record-usage",
      entry: {
        usageId: "job-1-a1:0",
        runId: "job-1-a1",
        route: "local-fast",
        role: "primary",
        requestCount: 2,
        inputTokens: 100,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        outputTokens: 50,
        costMicros: 0,
        costProvenance: "unknown",
        recordedAtMs: 5_000,
      },
    },
  ]);
  const twice = await h.store.aggregateUsage();
  assert.equal(twice.totals.requestCount, 2, "the identical replay counted nothing new");
});

test("an artifact with a fabricated unknown-provenance cost is refused, never persisted", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  writeArtifacts(h.runsRoot, "job-1", {
    review: {
      ...REVIEW_ARTIFACT,
      usage: [
        {
          route: "local-fast",
          role: "primary",
          requestCount: 1,
          inputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 5,
          costMicros: 42,
          costProvenance: "unknown",
        },
      ],
    },
  });
  const ok = await h.publish(makePublishingRecord("job-1"));
  assert.equal(ok, false, "the publication refused (usage validation failed the batch)");
  assert.equal(h.forge.calls.length, 0, "no forge side effect followed a failed batch");
  const record = await h.store.getPublication("job-1");
  assert.equal(record, null, "the whole batch was rejected: nothing was persisted");
});

test("hostile result artifacts are refused without durable mutation", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));

  // REVIEW-artifact damage stays retry-later (#1558's taxonomy: only the
  // size refusals are terminal there): not JSON at all.
  writeArtifacts(h.runsRoot, "job-bad", { review: "{not json" });
  // Missing files for job-absent (first failures are under the #1560
  // envelope-read bound; the bounded terminal conversion is pinned by
  // its own test below).

  for (const jobId of ["job-bad", "job-absent"]) {
    const ok = await h.publish(makePublishingRecord(jobId));
    assert.equal(ok, false, `${jobId} must not publish`);
    assert.equal(h.forge.calls.length, 0, `${jobId} must never reach the forge`);
    const record = await h.store.getPublication(jobId);
    assert.equal(record, null, `${jobId} must leave no durable payload behind`);
  }
});

test("deterministic ENVELOPE refusals settle terminally (#1560)", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));

  // Duplicate-key hiding trick in the ENVELOPE: raw bytes carry a secret
  // under a repeated key — the envelope's own validator refuses the
  // unknown field outright.
  writeArtifacts(h.runsRoot, "job-dup", {
    envelope: { token: "ghp_ABCDEFGHIJKLMNOP" },
  });
  // Foreign correlation identity.
  writeArtifacts(h.runsRoot, "job-foreign", {
    envelope: { runId: "other-a1", jobId: "job-foreign" },
  });
  // A review artifact outside the run directory: the envelope's own
  // validator refuses it.
  writeArtifacts(h.runsRoot, "job-escape", {
    envelope: { resultArtifactPath: "/tmp/prv-outside.json" },
  });
  // An envelope that is not JSON: fully read, content-verdict failure.
  mkdirSync(executionRunDir(h.runsRoot, "job-notjson", 1), { recursive: true });
  writeFileSync(executionResultPath(h.runsRoot, "job-notjson", 1), "{not json", "utf8");
  // A non-completed envelope: the record could only reach `publishing`
  // with a completed result, so this file is not that result.
  writeArtifacts(h.runsRoot, "job-status", {
    envelope: {
      status: "failed",
      resultHeadSha: "",
      resultArtifactPath: "",
      failureCategory: "worker_error",
      failureMessage: "worker exited",
    },
  });

  const cases: Array<[string, string]> = [
    ["job-dup", "worker execution result envelope is invalid"],
    ["job-foreign", "worker execution result envelope belongs to another run"],
    ["job-escape", "worker execution result envelope is invalid"],
    ["job-notjson", "worker execution result envelope is not JSON"],
    ["job-status", "worker execution result envelope is not a completed result"],
  ];
  for (const [jobId, reason] of cases) {
    await seedRun(h.store, jobId);
    const ok = await h.publish(makePublishingRecord(jobId));
    assert.equal(ok, true, `${jobId}: the queue record settles — no retry can fix final bytes`);
    assert.equal(h.forge.calls.length, 0, `${jobId} must never reach the forge`);
    const record = await h.store.getPublication(jobId);
    assert.equal(record, null, `${jobId} must leave no durable payload behind`);
    const run = await h.store.getRun(executionRunId(jobId, 1));
    assert.equal(run!.state, "failed", `${jobId}: the run account closes as failed`);
    assert.equal(run!.failureReason, reason, `${jobId}: the bounded reason is the account`);
  }
  const usage = await h.store.aggregateUsage();
  assert.equal(usage.totals.requestCount, 0, "a refusal records no usage");
});

test("transient envelope failures are bounded, then settle terminally (#1560)", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  await seedRun(h.store, "job-1");
  // The run directory exists but holds no envelope: every read fails
  // `missing` — an I/O-class failure, retried under the bound.
  mkdirSync(executionRunDir(h.runsRoot, "job-1", 1), { recursive: true });
  for (let attempt = 1; attempt < MAX_ENVELOPE_READ_ATTEMPTS; attempt += 1) {
    assert.equal(
      await h.publish(makePublishingRecord("job-1")),
      false,
      `attempt ${String(attempt)} of ${String(MAX_ENVELOPE_READ_ATTEMPTS)} stays retry-later`,
    );
  }
  assert.equal(await h.store.getPublication("job-1"), null);
  assert.equal(await runState(h.store, "job-1"), "queued", "no settlement while the bound holds");

  const settled = await h.publish(makePublishingRecord("job-1"));
  assert.equal(settled, true, "the bound is reached: the strand settles terminally");
  const run = await h.store.getRun(executionRunId("job-1", 1));
  assert.equal(run!.state, "failed");
  assert.ok(
    run!.failureReason.includes(
      `remained unreadable after ${String(MAX_ENVELOPE_READ_ATTEMPTS)} publication attempts`,
    ),
    `the bounded reason names the bound, got: ${run!.failureReason}`,
  );
  assert.ok(
    run!.failureReason.includes("worker execution result envelope is missing"),
    "the bounded reason carries the last I/O reason",
  );
  assert.ok(run!.failureReason.length <= 256, "the durable reason stays bounded");
});

test("a successful envelope read restarts the transient failure streak (#1560)", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  const runDir = executionRunDir(h.runsRoot, "job-1", 1);
  mkdirSync(runDir, { recursive: true });
  const envelopePath = executionResultPath(h.runsRoot, "job-1", 1);
  const reviewPath = join(runDir, "review.json");

  // Five missing-envelope failures count toward the streak…
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal(await h.publish(makePublishingRecord("job-1")), false);
  }
  // …a VALID envelope whose review artifact is merely missing clears it
  // (the envelope read succeeded; the artifact is the other class)…
  writeFileSync(envelopePath, JSON.stringify(executionEnvelope("job-1", {
    resultArtifactPath: reviewPath,
  })), "utf8");
  assert.equal(await h.publish(makePublishingRecord("job-1")), false);
  // …so the FULL bound is available again for the fresh failures.
  rmSync(envelopePath);
  for (let attempt = 1; attempt < MAX_ENVELOPE_READ_ATTEMPTS; attempt += 1) {
    assert.equal(
      await h.publish(makePublishingRecord("job-1")),
      false,
      `the restarted streak still has ${String(MAX_ENVELOPE_READ_ATTEMPTS - attempt)} reads left`,
    );
  }
  assert.equal(await h.publish(makePublishingRecord("job-1")), true, "the bound, then terminal");
});

test("a containment failure at the envelope coordinate joins the bounded class (#1560)", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  writeArtifacts(h.runsRoot, "job-1", { symlinkEnvelope: true });
  for (let attempt = 1; attempt < MAX_ENVELOPE_READ_ATTEMPTS; attempt += 1) {
    assert.equal(await h.publish(makePublishingRecord("job-1")), false);
  }
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  assert.equal(h.forge.calls.length, 0, "the planted symlink was never followed");
});

test("a full tracking map never resets an active streak (#1560 review finding)", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  const jobIds: string[] = [];
  for (let index = 0; index < MAX_TRACKED_ENVELOPE_READ_FAILURES; index += 1) {
    const jobId = `job-active-${String(index)}`;
    jobIds.push(jobId);
    await seedRun(h.store, jobId);
    assert.equal(await h.publish(makePublishingRecord(jobId)), false, "one failure each");
  }
  // The map is full of ACTIVE (non-terminal-run) streaks: a 129th
  // failing run is retry-later, and NO tracked entry is dropped to
  // admit it — under the old evict-oldest rotation this admission reset
  // the oldest streak, and with cap+1 concurrent failures every streak
  // could be reset before reaching the bound, spinning forever.
  assert.equal(await h.publish(makePublishingRecord("job-saturated")), false);
  // The oldest tracked streak keeps its progress: it already holds 1,
  // so MAX-1 further consecutive failures settle it terminally.
  for (let attempt = 2; attempt < MAX_ENVELOPE_READ_ATTEMPTS; attempt += 1) {
    assert.equal(
      await h.publish(makePublishingRecord(jobIds[0]!)),
      false,
      `tracked read ${String(attempt)} of ${String(MAX_ENVELOPE_READ_ATTEMPTS)} stays retry-later`,
    );
  }
  assert.equal(
    await h.publish(makePublishingRecord(jobIds[0]!)),
    true,
    "no reset: the streak reached its bound and settled",
  );
  const run = await h.store.getRun(executionRunId(jobIds[0]!, 1));
  assert.equal(run!.state, "failed");
  assert.ok(
    run!.failureReason.includes(
      `remained unreadable after ${String(MAX_ENVELOPE_READ_ATTEMPTS)} publication attempts`,
    ),
    `the bounded reason names the bound, got: ${run!.failureReason}`,
  );
  assert.equal(h.forge.calls.length, 0);
});

test("retired runs reclaim tracking capacity; active streaks never (#1560 review finding)", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  const jobIds: string[] = [];
  for (let index = 0; index < MAX_TRACKED_ENVELOPE_READ_FAILURES; index += 1) {
    const jobId = `job-fill-${String(index)}`;
    jobIds.push(jobId);
    await seedRun(h.store, jobId);
    assert.equal(await h.publish(makePublishingRecord(jobId)), false);
  }
  // Retire HALF the runs the way the daemon does it: the queue retired
  // the record, the reconcile pass mirrors the run account to terminal.
  const half = MAX_TRACKED_ENVELOPE_READ_FAILURES / 2;
  for (const jobId of jobIds.slice(0, half)) {
    await mirrorRunTransition(h.store, executionRunId(jobId, 1), "superseded", { nowMs: 6_000 });
  }
  // A new failing run is ADMITTED on the full-map sweep (it converges
  // on its OWN bound — a saturated run would spin retry-later instead):
  for (let attempt = 1; attempt < MAX_ENVELOPE_READ_ATTEMPTS; attempt += 1) {
    assert.equal(await h.publish(makePublishingRecord("job-after")), false);
  }
  assert.equal(await h.publish(makePublishingRecord("job-after")), true, "admitted, then bounded");
  // The UNRETIRED half kept every unit of progress: MAX-1 further
  // consecutive failures settle the last tracked streak.
  const active = jobIds[jobIds.length - 1]!;
  for (let attempt = 2; attempt < MAX_ENVELOPE_READ_ATTEMPTS; attempt += 1) {
    assert.equal(await h.publish(makePublishingRecord(active)), false);
  }
  assert.equal(await h.publish(makePublishingRecord(active)), true);
});

test("an absent run record does not rotate active streaks under saturation (#1560 finding)", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  // A diverged control plane: NO run records exist (e.g. a restore that
  // lost the run rows while the queue still retries the publications).
  // Absence must not be treated as instant proof of retirement: under
  // saturation that would wipe the map on every admission — the same
  // rotate-forever spin, just driven by the sweep instead of eviction.
  const jobIds: string[] = [];
  for (let index = 0; index < MAX_TRACKED_ENVELOPE_READ_FAILURES; index += 1) {
    const jobId = `job-noaccount-${String(index)}`;
    jobIds.push(jobId);
    assert.equal(await h.publish(makePublishingRecord(jobId)), false);
  }
  // The 129th failing run triggers the sweep: absent is not proof of
  // retirement, so nothing is dropped and the new run is retry-later
  // (saturated).
  assert.equal(await h.publish(makePublishingRecord("job-noaccount-new")), false);
  // The oldest tracked run keeps its progress — the sweep never drops
  // a streak whose run record is merely absent — and converges on the
  // remaining bound.
  for (let attempt = 2; attempt < MAX_ENVELOPE_READ_ATTEMPTS; attempt += 1) {
    assert.equal(await h.publish(makePublishingRecord(jobIds[0]!)), false);
  }
  assert.equal(
    await h.publish(makePublishingRecord(jobIds[0]!)),
    true,
    "absent is not proof: the active streak converged",
  );
  const run = await h.store.getRun(executionRunId(jobIds[0]!, 1));
  assert.equal(run, null, "the mirror is a no-op for an absent run; the queue record still settled");
  // The settlement freed a slot: the previously saturated run is now
  // admitted and converges on its own bound (9 tracked failures, then
  // the terminal 10th — its earlier saturated read was untracked).
  for (let attempt = 1; attempt < MAX_ENVELOPE_READ_ATTEMPTS; attempt += 1) {
    assert.equal(await h.publish(makePublishingRecord("job-noaccount-new")), false);
  }
  assert.equal(await h.publish(makePublishingRecord("job-noaccount-new")), true);
});

test("a symlink planted at the artifact coordinate is never followed", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  writeArtifacts(h.runsRoot, "job-1", { symlinkReview: true });
  const ok = await h.publish(makePublishingRecord("job-1"));
  assert.equal(ok, false);
  assert.equal(h.forge.calls.length, 0);
  assert.equal(await h.store.getPublication("job-1"), null);
});

test("a symlink planted at the envelope coordinate is never followed", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  writeArtifacts(h.runsRoot, "job-1", { symlinkEnvelope: true });
  const ok = await h.publish(makePublishingRecord("job-1"));
  assert.equal(ok, false);
  assert.equal(h.forge.calls.length, 0);
  assert.equal(await h.store.getPublication("job-1"), null);
});

test("an envelope whose head disagrees with the queue record settles terminally (#1560)", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  writeArtifacts(h.runsRoot, "job-1", {
    envelope: { resultHeadSha: NEWER_HEAD },
  });
  await seedRun(h.store, "job-1");
  // Both sides are durable and immutable once the record holds its
  // result: the disagreement can never resolve, so it is terminal.
  const ok = await h.publish(makePublishingRecord("job-1"));
  assert.equal(ok, true, "the artifact on disk is not the result the queue publishes");
  assert.equal(h.forge.calls.length, 0);
  assert.equal(await h.store.getPublication("job-1"), null);
  const run = await h.store.getRun(executionRunId("job-1", 1));
  assert.equal(run!.state, "failed");
  assert.equal(
    run!.failureReason,
    "execution result envelope head disagrees with the queue record",
  );
});

test("a duplicate-key review artifact publishes only its canonical parse", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  // The raw bytes carry a credential shape under a repeated key; the
  // parse keeps the LAST occurrence, and the published bytes ARE that
  // parse — the hidden value can never reach the forge or the durable
  // record.
  writeArtifacts(h.runsRoot, "job-1", {
    review:
      '{"verdict":"issues","note":"ghp_ABCDEFGHIJKLMNOP","note":"safe"}',
  });
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  const payload = h.forge.calls[0]!.resultPayload;
  assert.equal(payload, JSON.stringify({ verdict: "issues", note: "safe" }));
  assert.equal(payload.includes("ghp_"), false);
});

test("publish ignores records that are not publishing with a durable result", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  const queued = newJobRecord(makeJob("job-1"), 1000, 0);
  assert.equal(await h.publish(queued), false);
  const runningNoResult: JobRecord = {
    ...withState(withState(queued, "starting", 1000), "running", 1000),
    resultHeadSha: "",
  };
  assert.equal(await h.publish(runningNoResult), false);
  assert.equal(h.forge.calls.length, 0);
  assert.equal(await h.store.getPublication("job-1"), null);
});

// ── #1561: a persisted record that fails the CURRENT validator ──────────
//
// A pre-fix record written under an older validator's rules can fail a
// rule added since (canonical-encoding or secret-shape checks). Every
// mutation routed through the validator refuses it — the attempt-recording
// mutation throws "next record failed validation", which used to propagate
// out of `publish` into the scheduler's retry-later catch and strand the
// expiry-exempt record in `publishing` forever. The stale record cannot be
// planted through the store's own writer (put-publication validates), so
// these tests override the READ seam the publisher uses — exactly where
// the PostgreSQL backend's row mapper revalidates persisted rows.

/** The run account the terminal settlement must close as failed. */
async function plantRun(store: InMemoryControlPlaneStore, jobId: string): Promise<void> {
  await store.apply([
    {
      kind: "create-run",
      record: newRunRecord(
        {
          runId: executionRunId(jobId, 1),
          jobId,
          kind: "review",
          executorIdentity: "test-executor",
          headSha: HEAD,
          configFingerprint: "0123456789abcdef",
          attempt: 1,
        },
        4_000,
      ),
    },
  ]);
}

/** Serves a record the CURRENT validator refuses — the state a deployed
 * pre-fix row is in after a validator-rule change. */
class StalePublicationStore extends InMemoryControlPlaneStore {
  constructor(private readonly stale: PublicationRecord) {
    super();
  }
  override async getPublication(_jobId: string): Promise<PublicationRecord | null> {
    void _jobId;
    return this.stale;
  }
}

/** The PostgreSQL backend's read-time shape: the row mapper refuses the
 * stored bytes with the typed error instead of returning them. */
class ReadRefusingStore extends InMemoryControlPlaneStore {
  override async getPublication(_jobId: string): Promise<PublicationRecord | null> {
    void _jobId;
    throw new StateRecordValidationError("postgres backend: malformed publication row");
  }
}

/** A store failure that is NOT a validator refusal: transient, retry-later. */
class FlakyStore extends InMemoryControlPlaneStore {
  override async getPublication(_jobId: string): Promise<PublicationRecord | null> {
    void _jobId;
    throw new Error("connection reset");
  }
}

function staleRecord(payload: string): PublicationRecord {
  return {
    jobId: "job-1",
    publicationState: "pending",
    destination: "github:owner/repo#7",
    publicationId: "",
    attempt: 0,
    lastError: "",
    resultHeadSha: HEAD,
    resultPayload: payload,
    history: [],
    createdAtMs: 4000,
    updatedAtMs: 4000,
  };
}

test("#1561: a pre-fix record whose payload fails the current validator settles terminally on replay", async (t) => {
  // Duplicate keys: canonical under no current rule, small enough to fit
  // the comment ceiling — the #1558 replay check must NOT be what settles
  // this record, and the attempt-recording mutation must never be reached
  // (it would throw "next record failed validation" into the retry loop).
  const payload = '{"verdict":"issues","verdict":"passed"}';
  const stale = staleRecord(payload);
  assert.equal(validatePublication(stale), null, "the record fails the CURRENT validator");
  assert.equal(durableResultPayloadFitsCeiling(payload), true, "not the #1558 size shape");
  const store = new StalePublicationStore(stale);
  const h = setup({ store });
  t.after(() => cleanup(h));
  await plantRun(store, "job-1");
  // TERMINAL: `true` settles the queue record; `false` (or a throw) would
  // retry the identical refused replay forever.
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  assert.equal(h.forge.calls.length, 0, "the refused payload is never replayed");
  const run = await store.getRun(executionRunId("job-1", 1));
  assert.ok(run !== null);
  assert.equal(run.state, "failed");
  assert.match(run.failureReason, /current record validator/);
  // The stale record stays untouched: no mutation routed through the
  // validator can persist anything against this payload.
  assert.equal(await store.getPublication("job-1"), stale);
  // A restarted controller re-fires publish on the same record: the
  // settlement is stable, never mutating toward a write.
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  assert.equal(h.forge.calls.length, 0);
});

test("#1561: a pre-fix record carrying secret-shaped persisted content settles terminally too", async (t) => {
  // The payload's canonical encoding is fine; the CONTENT is what the
  // current boundary refuses — a credential shape that must never be
  // replayed to the forge.
  const payload = JSON.stringify({ note: `ghp_${"a1b2c3d4e5".repeat(4)}` });
  const stale = staleRecord(payload);
  assert.equal(validatePublication(stale), null);
  assert.equal(durableResultPayloadFitsCeiling(payload), true);
  const store = new StalePublicationStore(stale);
  const h = setup({ store });
  t.after(() => cleanup(h));
  await plantRun(store, "job-1");
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  assert.equal(h.forge.calls.length, 0);
  const run = await store.getRun(executionRunId("job-1", 1));
  assert.ok(run !== null);
  assert.equal(run.state, "failed");
});

test("#1561: a read-time validator refusal settles terminally without surfacing the record", async (t) => {
  const store = new ReadRefusingStore();
  const h = setup({ store });
  t.after(() => cleanup(h));
  await plantRun(store, "job-1");
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  assert.equal(h.forge.calls.length, 0);
  const run = await store.getRun(executionRunId("job-1", 1));
  assert.ok(run !== null);
  assert.equal(run.state, "failed");
  assert.match(run.failureReason, /current record validator/);
});

test("#1561: a transient store failure on the read stays retry-later, never terminal", async (t) => {
  const store = new FlakyStore();
  const h = setup({ store });
  t.after(() => cleanup(h));
  await plantRun(store, "job-1");
  await assert.rejects(h.publish(makePublishingRecord("job-1")), /connection reset/);
  assert.equal(h.forge.calls.length, 0);
  const run = await store.getRun(executionRunId("job-1", 1));
  assert.ok(run !== null);
  assert.equal(run.state, "queued", "a transient failure records no terminal mirror");
});
