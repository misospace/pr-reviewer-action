/** #1558: the controller's forge-capability comment body is bounded by the
 * forge comment ceiling.
 *
 * The renderer assembles `marker + fence + payload + fence`, and the
 * payload's own ceiling is EXACTLY the comment ceiling (65,536), so the
 * unguarded body always overflows for a max-size payload and the forge
 * refuses the whole publication. The renderer is the fail-closed backstop
 * (it renders nothing over the bound), the fit helper is the payload's
 * admission test, and the durable publisher refuses a payload that cannot
 * fit BEFORE persisting a record or writing to the forge — TERMINALLY:
 * a size refusal cannot be fixed by a retry (the worker's bytes are
 * final), and publishing-with-result records are exempt from expiry
 * settlement with no terminal retry cap, so the publisher settles the
 * queue record and closes the run as failed instead of returning `false`.
 *
 * #252 discipline: the boundary is fed the boundary itself — a payload at
 * exactly the ceiling, one byte over, and a run of backticks that grows
 * the fence itself past the bound. */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTROLLER_STICKY_MARKER,
  FORGE_COMMENT_MAX_BYTES,
  durableResultPayloadFitsCeiling,
  renderDurableResultBody,
} from "../src/controller/forge-capability.js";
import {
  createDurablePublisher,
  type ForgeWriteCapability,
} from "../src/controller/publication.js";
import {
  executionResultPath,
  executionRunDir,
  executionRunId,
} from "../src/controller/execution.js";
import { InMemoryControlPlaneStore, newRunRecord } from "../src/state/index.js";
import { newJobRecord, withState } from "../src/queue/index.js";
import type { JobRecord } from "../src/queue/types.js";
import type { ReviewJob } from "../src/jobs/types.js";

const HEAD = "aa11bb22cc33dd44ee55ff667788990001122334";

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
  });
}

function makePublishingRecord(jobId: string): JobRecord {
  const base = newJobRecord(makeJob(jobId), 1000, 0);
  const started = { ...withState(withState(base, "starting", 1000), "running", 1000), attempt: 1 };
  return {
    ...withState(started, "publishing", 2000),
    resultHeadSha: HEAD,
  };
}

/** The exact scaffold bytes the renderer adds around a backtick-free
 * payload: `marker\n\n```json\n` + `\n``` `. */
function scaffoldBytes(payload: string): number {
  const body = renderDurableResultBody(CONTROLLER_STICKY_MARKER, payload);
  return Buffer.byteLength(body, "utf8") - Buffer.byteLength(payload, "utf8");
}

// ── the renderer boundary ────────────────────────────────────────────────

test("a payload that fits renders byte-identically to the marker + fence contract", () => {
  const payload = '{"verdict":"issues","findings":[]}';
  const body = renderDurableResultBody(CONTROLLER_STICKY_MARKER, payload);
  assert.equal(body, `${CONTROLLER_STICKY_MARKER}\n\n\`\`\`json\n${payload}\n\`\`\``);
});

test("a payload of exactly the room the marker and fences leave publishes", () => {
  const room = FORGE_COMMENT_MAX_BYTES - scaffoldBytes("x");
  const payload = "a".repeat(room);
  assert.equal(durableResultPayloadFitsCeiling(payload), true);
  const body = renderDurableResultBody(CONTROLLER_STICKY_MARKER, payload);
  assert.equal(Buffer.byteLength(body, "utf8"), FORGE_COMMENT_MAX_BYTES);
});

test("#1558: a payload ONE BYTE past the room fails closed instead of overflowing the ceiling", () => {
  const room = FORGE_COMMENT_MAX_BYTES - scaffoldBytes("x");
  const payload = "a".repeat(room + 1);
  assert.equal(durableResultPayloadFitsCeiling(payload), false);
  assert.throws(
    () => renderDurableResultBody(CONTROLLER_STICKY_MARKER, payload),
    /exceeds the forge comment ceiling by 1 byte/,
  );
});

test("#1558: a payload at the full comment ceiling is refused — the marker and fences leave no room", () => {
  const payload = "a".repeat(FORGE_COMMENT_MAX_BYTES);
  assert.equal(durableResultPayloadFitsCeiling(payload), false);
  assert.throws(() => renderDurableResultBody(CONTROLLER_STICKY_MARKER, payload));
});

test("#1558: a backtick run grows the fence and eats payload room (no static reserve fits)", () => {
  // Half the ceiling in backticks: the fence must be LONGER than the run,
  // so the assembled body is roughly 1.5× the payload — far past any
  // small static reserve, and the exact-render measure catches it.
  const payload = "`".repeat(Math.floor(FORGE_COMMENT_MAX_BYTES / 2));
  assert.equal(durableResultPayloadFitsCeiling(payload), false);
  assert.throws(() => renderDurableResultBody(CONTROLLER_STICKY_MARKER, payload));
  // And the same run at a size that still fits keeps the longer fence.
  const small = "x".repeat(10) + "`".repeat(5) + "y".repeat(10);
  const body = renderDurableResultBody(CONTROLLER_STICKY_MARKER, small);
  assert.ok(body.includes("``````json\n"));
  assert.equal(durableResultPayloadFitsCeiling(small), true);
});

test("#1558: multi-byte payload bytes count against the ceiling as bytes, not characters", () => {
  // "é" is one character but two UTF-8 bytes: the boundary must be the
  // byte measure the forge applies.
  const room = FORGE_COMMENT_MAX_BYTES - scaffoldBytes("x");
  const oddRoom = room - 1;
  const fits = "é".repeat(Math.floor(oddRoom / 2)) + "a";
  assert.ok(Buffer.byteLength(fits, "utf8") <= FORGE_COMMENT_MAX_BYTES - scaffoldBytes(fits));
  assert.equal(durableResultPayloadFitsCeiling(fits), true);
  const over = "é".repeat(Math.ceil((room + 1) / 2));
  assert.ok(Buffer.byteLength(over, "utf8") > FORGE_COMMENT_MAX_BYTES - scaffoldBytes("x"));
  assert.equal(durableResultPayloadFitsCeiling(over), false);
});

// ── the durable publisher refuses before persisting or writing ───────────

const REVIEW_ARTIFACT = Object.freeze({
  verdict: "issues",
  summary: "one finding",
  findings: [{ path: "src/app.ts", line: 12, message: "unvalidated input" }],
});

function executionEnvelope(jobId: string, artifactPath: string): Record<string, unknown> {
  return {
    status: "completed",
    runId: executionRunId(jobId, 1),
    jobId,
    resultHeadSha: HEAD,
    failureCategory: "",
    failureMessage: "",
    resultArtifactPath: artifactPath,
    diagnostics: "",
    artifactPaths: [],
    resourceMs: 12,
    observedAtMs: 4000,
  };
}

class FakeForge implements ForgeWriteCapability {
  readonly payloads: string[] = [];

  async publish(input: { job: ReviewJob; resultPayload: string }): Promise<{ publicationId: string }> {
    void input;
    throw new Error("the forge must never be reached for a refused payload");
  }
}

interface Harness {
  readonly store: InMemoryControlPlaneStore;
  readonly forge: FakeForge;
  readonly runsRoot: string;
  publish(record: JobRecord): Promise<boolean>;
}

function setup(): Harness {
  const store = new InMemoryControlPlaneStore();
  const forge = new FakeForge();
  const runsRoot = mkdtempSync(join(tmpdir(), "prv-ceiling-"));
  const publisher = createDurablePublisher({
    store,
    forge,
    currentHeadSha: async () => HEAD,
    runsRoot,
    now: () => 5_000,
  });
  return { store, forge, runsRoot, publish: (record) => publisher.publish(record) };
}

function writeArtifacts(runsRoot: string, jobId: string, review: unknown): void {
  const runDir = executionRunDir(runsRoot, jobId, 1);
  mkdirSync(runDir, { recursive: true });
  const reviewPath = join(runDir, "review.json");
  writeFileSync(reviewPath, JSON.stringify(review), "utf8");
  writeFileSync(executionResultPath(runsRoot, jobId, 1), JSON.stringify(executionEnvelope(jobId, reviewPath)), "utf8");
}

/** The run account the publisher's refusal must close as failed. The
 * daemon creates it before the worker launches; tests plant it so the
 * mirror has something to settle (a missing run is a no-op mirror). */
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

test("#1558: an artifact whose payload overflows the comment envelope is refused before any durable record or forge write", async (t) => {
  const h = setup();
  t.after(() => rmSync(h.runsRoot, { recursive: true, force: true }));
  // A canonical payload at exactly the comment ceiling: the marker and
  // the fences can only push the rendered comment past 65,536 bytes.
  const envelopeShell = Buffer.byteLength('{"blob":""}', "utf8");
  const review = { blob: "a".repeat(FORGE_COMMENT_MAX_BYTES - envelopeShell) };
  const canonical = JSON.stringify(review);
  assert.equal(Buffer.byteLength(canonical, "utf8"), FORGE_COMMENT_MAX_BYTES);
  assert.equal(durableResultPayloadFitsCeiling(canonical), false);
  writeArtifacts(h.runsRoot, "job-1", review);
  await plantRun(h.store, "job-1");
  // TERMINAL settlement: `true` (the queue record settles). Returning
  // `false` would retry forever — publishing-with-result is exempt from
  // expiry settlement and publication retries have no attempt cap.
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  // No durable publication record: the payload cannot be persisted by
  // contract, and there is nothing to replay.
  assert.equal(await h.store.getPublication("job-1"), null);
  // The run's durable account closes as failed with the bounded reason.
  const run = await h.store.getRun(executionRunId("job-1", 1));
  assert.ok(run !== null);
  assert.equal(run.state, "failed");
  assert.match(run.failureReason, /does not fit the comment ceiling/);
});

test("#1558: an artifact FILE past the payload byte cap is refused terminally too — the dominant oversized shape", async (t) => {
  const h = setup();
  t.after(() => rmSync(h.runsRoot, { recursive: true, force: true }));
  // The bounded read proves the size on its own descriptor and used to
  // flatten that into a retry-later `invalid` — the stranding the fix
  // targets: the identical oversized file re-read forever.
  const review = { blob: "a".repeat(FORGE_COMMENT_MAX_BYTES + 16) };
  writeArtifacts(h.runsRoot, "job-1", review);
  await plantRun(h.store, "job-1");
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  assert.equal(await h.store.getPublication("job-1"), null);
  const run = await h.store.getRun(executionRunId("job-1", 1));
  assert.ok(run !== null);
  assert.equal(run.state, "failed");
  assert.match(run.failureReason, /too large to publish/);
});

test("#1558: a refused size verdict is stable across replays — no durable mutation, forge never reached", async (t) => {
  const h = setup();
  t.after(() => rmSync(h.runsRoot, { recursive: true, force: true }));
  const envelopeShell = Buffer.byteLength('{"blob":""}', "utf8");
  const review = { blob: "a".repeat(FORGE_COMMENT_MAX_BYTES - envelopeShell) };
  writeArtifacts(h.runsRoot, "job-1", review);
  await plantRun(h.store, "job-1");
  // A restarted controller re-fires publish on the same record: the
  // refusal settles again identically (already-terminal run is a no-op
  // mirror), never mutating durable state toward a write.
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  assert.equal(await h.store.getPublication("job-1"), null);
});

test("#1558: a payload that fits the comment envelope right down to the byte publishes", async (t) => {
  const h = setup();
  t.after(() => rmSync(h.runsRoot, { recursive: true, force: true }));
  // The exact room the marker and fences leave: the rendered comment is
  // exactly 65,536 bytes, and it publishes.
  const envelopeShell = Buffer.byteLength('{"blob":""}', "utf8");
  const review = {
    blob: "a".repeat(FORGE_COMMENT_MAX_BYTES - envelopeShell - scaffoldBytes("x")),
  };
  const canonical = JSON.stringify(review);
  assert.equal(durableResultPayloadFitsCeiling(canonical), true);
  assert.equal(
    Buffer.byteLength(renderDurableResultBody(CONTROLLER_STICKY_MARKER, canonical), "utf8"),
    FORGE_COMMENT_MAX_BYTES,
  );
  writeArtifacts(h.runsRoot, "job-1", review);
  h.forge.publish = async (input) => {
    h.forge.payloads.push(input.resultPayload);
    return { publicationId: "github-comment:99" };
  };
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  assert.equal(h.forge.payloads.length, 1);
  const persisted = await h.store.getPublication("job-1");
  assert.ok(persisted !== null);
  assert.equal(persisted.publicationState, "published");
});

test("#1558: a normal-sized review artifact is untouched by the ceiling admission — it publishes", async (t) => {
  const h = setup();
  t.after(() => rmSync(h.runsRoot, { recursive: true, force: true }));
  // The ceiling check must be a boundary, not a size tax: an ordinary
  // review artifact passes it and publishes exactly as before.
  writeArtifacts(h.runsRoot, "job-1", REVIEW_ARTIFACT);
  h.forge.publish = async (input) => {
    h.forge.payloads.push(input.resultPayload);
    return { publicationId: "github-comment:100" };
  };
  assert.equal(await h.publish(makePublishingRecord("job-1")), true);
  assert.deepEqual(h.forge.payloads, [JSON.stringify(REVIEW_ARTIFACT)]);
  const persisted = await h.store.getPublication("job-1");
  assert.ok(persisted !== null);
  assert.equal(persisted.publicationState, "published");
});
