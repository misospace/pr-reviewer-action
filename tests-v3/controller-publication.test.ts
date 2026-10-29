/** The daemon's durable publication path (#1348): persist-before-side-
 * effect ordering, retry from durable state without rerunning the model,
 * the exact-head gate outcomes (published / stale / expired / unreadable),
 * publication idempotency, usage idempotency, and hostile-artifact
 * refusal fed directly at the boundary (#252). */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
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
import { executionResultPath, executionRunDir } from "../src/controller/execution.js";

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

function writeResultArtifact(
  runsRoot: string,
  jobId: string,
  body: unknown,
  options: { symlink?: boolean } = {},
): string {
  const resultPath = executionResultPath(runsRoot, jobId, 1);
  mkdirSync(executionRunDir(runsRoot, jobId, 1), { recursive: true });
  if (options.symlink === true) {
    // #252: a symlink planted at the result coordinate must never be
    // followed into attacker-chosen bytes.
    writeFileSync(`${resultPath}.target`, JSON.stringify({ verdict: "planted" }), "utf8");
    rmSync(resultPath, { force: true });
    symlinkSync(`${resultPath}.target`, resultPath);
    return resultPath;
  }
  writeFileSync(resultPath, typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return resultPath;
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

const RESULT_ARTIFACT = Object.freeze({
  status: "completed",
  runId: "job-1-a1",
  jobId: "job-1",
  resultHeadSha: HEAD,
  failureCategory: "",
  failureMessage: "",
  resultArtifactPath: "",
  diagnostics: "",
  artifactPaths: [],
  resourceMs: 12,
  observedAtMs: 4000,
});

test("first publish persists the publication record before any forge side effect", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  writeResultArtifact(h.runsRoot, "job-1", RESULT_ARTIFACT);
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
  // parsed artifact object.
  assert.equal(h.forge.calls[0]!.resultPayload, JSON.stringify(RESULT_ARTIFACT));
});

test("a forge failure records the attempt and a retry replays the durable payload without touching the artifact", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  writeResultArtifact(h.runsRoot, "job-1", RESULT_ARTIFACT);
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

  // Retry: the artifact file is DELETED — the retry must read the durable
  // record, never the filesystem, and never rerun the model.
  rmSync(executionResultPath(h.runsRoot, "job-1", 1), { force: true });
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
  writeResultArtifact(h.runsRoot, "job-1", RESULT_ARTIFACT);
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  assert.equal(h.forge.calls.length, 1);
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  assert.equal(h.forge.calls.length, 1, "the replay is a no-op, never a second write");
});

test("a stale result never publishes and settles terminally", async (t) => {
  const h = setup({ heads: [NEWER_HEAD] });
  t.after(() => cleanup(h));
  writeResultArtifact(h.runsRoot, "job-1", RESULT_ARTIFACT);
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
  writeResultArtifact(h.runsRoot, "job-1", RESULT_ARTIFACT);
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
  writeResultArtifact(h.runsRoot, "job-1", RESULT_ARTIFACT);
  const ok = await h.publish(makePublishingRecord("job-1"));
  assert.equal(ok, false);
  assert.equal(h.forge.calls.length, 0);
  const record = await h.store.getPublication("job-1");
  assert.equal(record!.publicationState, "pending");
});

test("usage entries are recorded with stable ids and an identical replay does not double-count", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  writeResultArtifact(h.runsRoot, "job-1", {
    ...RESULT_ARTIFACT,
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
  writeResultArtifact(h.runsRoot, "job-1", {
    ...RESULT_ARTIFACT,
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

  // Duplicate-key hiding trick: raw bytes carry a secret under a repeated
  // key, but a lossy parse keeps only the last occurrence.
  writeResultArtifact(
    h.runsRoot,
    "job-dup",
    '{"runId":"job-dup-a1","jobId":"job-dup","resultHeadSha":"' + HEAD +
      '","token":"ghp_ABCDEFGHIJKLMNOP","token":"safe"}',
  );
  // Not JSON at all.
  writeResultArtifact(h.runsRoot, "job-bad", "{not json");
  // Foreign correlation identity.
  writeResultArtifact(h.runsRoot, "job-foreign", { ...RESULT_ARTIFACT, runId: "other-a1", jobId: "job-foreign" });
  // Missing file for job-absent.
  void writeResultArtifact;

  for (const jobId of ["job-dup", "job-bad", "job-foreign", "job-absent"]) {
    const ok = await h.publish(makePublishingRecord(jobId));
    assert.equal(ok, false, `${jobId} must not publish`);
    assert.equal(h.forge.calls.length, 0, `${jobId} must never reach the forge`);
    const record = await h.store.getPublication(jobId);
    assert.equal(record, null, `${jobId} must leave no durable payload behind`);
  }
});

test("a symlink planted at the result coordinate is never followed", async (t) => {
  const h = setup();
  t.after(() => cleanup(h));
  writeResultArtifact(h.runsRoot, "job-1", undefined, { symlink: true });
  const ok = await h.publish(makePublishingRecord("job-1"));
  assert.equal(ok, false);
  assert.equal(h.forge.calls.length, 0);
  assert.equal(await h.store.getPublication("job-1"), null);
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
