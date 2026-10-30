/** The daemon's durable publication path (#1348): persist-before-side-
 * effect ordering, retry from durable state without rerunning the model,
 * the exact-head gate outcomes (published / stale / expired / unreadable),
 * publication idempotency, usage idempotency, and hostile-artifact
 * refusal fed directly at the boundary (#252).
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

import { InMemoryControlPlaneStore } from "../src/state/index.js";
import { newJobRecord, withState } from "../src/queue/index.js";
import type { JobRecord } from "../src/queue/types.js";
import type { ReviewJob } from "../src/jobs/types.js";
import {
  createDurablePublisher,
  type ForgeWriteCapability,
} from "../src/controller/publication.js";
import {
  executionResultPath,
  executionRunDir,
  executionRunId,
} from "../src/controller/execution.js";

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
} = {}): Harness {
  const store = new InMemoryControlPlaneStore();
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

  // Duplicate-key hiding trick in the ENVELOPE: raw bytes carry a secret
  // under a repeated key, but a lossy parse keeps only the last
  // occurrence — and the envelope's own validator refuses the unknown
  // field outright.
  writeArtifacts(h.runsRoot, "job-dup", {
    envelope: { token: "ghp_ABCDEFGHIJKLMNOP" },
  });
  // Not JSON at all.
  writeArtifacts(h.runsRoot, "job-bad", { review: "{not json" });
  // Foreign correlation identity.
  writeArtifacts(h.runsRoot, "job-foreign", {
    envelope: { runId: "other-a1", jobId: "job-foreign" },
  });
  // A review artifact outside the run directory.
  writeArtifacts(h.runsRoot, "job-escape", {
    envelope: { resultArtifactPath: "/tmp/prv-outside.json" },
  });
  // Missing files for job-absent.
  void writeArtifacts;

  for (const jobId of ["job-dup", "job-bad", "job-foreign", "job-escape", "job-absent"]) {
    const ok = await h.publish(makePublishingRecord(jobId));
    assert.equal(ok, false, `${jobId} must not publish`);
    assert.equal(h.forge.calls.length, 0, `${jobId} must never reach the forge`);
    const record = await h.store.getPublication(jobId);
    assert.equal(record, null, `${jobId} must leave no durable payload behind`);
  }
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

test("a review artifact whose head disagrees with the queue record is refused", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  writeArtifacts(h.runsRoot, "job-1", {
    envelope: { resultHeadSha: NEWER_HEAD },
  });
  const ok = await h.publish(makePublishingRecord("job-1"));
  assert.equal(ok, false, "the artifact on disk is not the result the queue publishes");
  assert.equal(h.forge.calls.length, 0);
  assert.equal(await h.store.getPublication("job-1"), null);
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
