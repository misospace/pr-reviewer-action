import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryGenerationLedger,
  dispatchCanonicalEvent,
  gateJobPublication,
} from "../src/ingress/dispatch.js";
import type { GenerationLedger } from "../src/ingress/dispatch.js";
import { buildReviewJob, shouldSchedule } from "../src/jobs/index.js";
import type { ReviewJob } from "../src/jobs/types.js";
import type { CanonicalForgeEvent } from "../src/events/types.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const NEW_HEAD = "89abcdef0123456789abcdef0123456789abcdef";

/** A fully-populated canonical event; overrides win. */
function makeEvent(overrides: Partial<CanonicalForgeEvent> = {}): CanonicalForgeEvent {
  return Object.freeze({
    platform: "forgejo",
    source: "webhook",
    kind: "synchronize",
    installationId: "",
    repoFullName: "org/repo",
    prNumber: 7,
    prId: 700,
    headSha: HEAD,
    baseSha: BASE,
    draft: false,
    fork: false,
    labelName: "",
    actor: "",
    eventReference: "",
    ...overrides,
  });
}

/** Ledger wrapper counting addIfAbsent() calls (dedupe must not re-record). */
class CountingLedger implements GenerationLedger {
  readonly inner = new MemoryGenerationLedger();
  addIfAbsentCalls = 0;
  records = 0;

  has(jobId: string): boolean {
    return this.inner.has(jobId);
  }

  add(jobId: string): void {
    this.inner.add(jobId);
  }

  addIfAbsent(jobId: string): boolean {
    this.addIfAbsentCalls += 1;
    const added = this.inner.addIfAbsent(jobId);
    if (added) this.records += 1;
    return added;
  }

  remove(jobId: string): void {
    this.inner.remove(jobId);
  }
}

test("synchronize event schedules a review job and records it", async () => {
  const ledger = new MemoryGenerationLedger();
  const outcome = await dispatchCanonicalEvent(makeEvent(), { ledger });
  assert.equal(outcome.status, "scheduled");
  if (outcome.status !== "scheduled") return;
  assert.equal(outcome.job.kind, "review");
  assert.equal(outcome.job.trigger, "webhook");
  assert.equal(await ledger.has(outcome.job.jobId), true);
});

test("the same event dispatched twice is a duplicate with the same jobId", async () => {
  const ledger = new CountingLedger();
  const event = makeEvent();
  const first = await dispatchCanonicalEvent(event, { ledger });
  const second = await dispatchCanonicalEvent(event, { ledger });
  assert.equal(first.status, "scheduled");
  assert.equal(second.status, "duplicate");
  if (first.status !== "scheduled" || second.status !== "duplicate") return;
  assert.equal(second.job.jobId, first.job.jobId);
  // One addIfAbsent per dispatch, but the id is recorded exactly once.
  assert.equal(ledger.addIfAbsentCalls, 2);
  assert.equal(ledger.records, 1);
});

test("webhook then reconciliation poll of the same head dedupes (#730)", async () => {
  const ledger = new MemoryGenerationLedger();
  const webhook = makeEvent();
  const poll = makeEvent({ source: "poll", kind: "reconciliation_poll" });
  const first = await dispatchCanonicalEvent(webhook, { ledger });
  const second = await dispatchCanonicalEvent(poll, { ledger });
  assert.equal(first.status, "scheduled");
  assert.equal(second.status, "duplicate");
  if (first.status !== "scheduled" || second.status !== "duplicate") return;
  assert.equal(second.job.jobId, first.job.jobId);
});

test("a new headSha schedules a distinct generation", async () => {
  const ledger = new MemoryGenerationLedger();
  const first = await dispatchCanonicalEvent(makeEvent(), { ledger });
  const second = await dispatchCanonicalEvent(makeEvent({ headSha: NEW_HEAD }), { ledger });
  assert.equal(first.status, "scheduled");
  assert.equal(second.status, "scheduled");
  if (first.status !== "scheduled" || second.status !== "scheduled") return;
  assert.notEqual(second.job.jobId, first.job.jobId);
});

test("terminal and irrelevant kinds are ignored", async () => {
  const ledger = new MemoryGenerationLedger();
  for (const kind of [
    "pr_closed",
    "pr_merged",
    "installation_change",
    "visibility_change",
    "unknown",
  ] as const) {
    const outcome = await dispatchCanonicalEvent(makeEvent({ kind }), { ledger });
    assert.equal(outcome.status, "ignored", `kind ${kind}`);
  }
});

test("follow_up is ignored by dispatch even with a valid reference", async () => {
  const ledger = new MemoryGenerationLedger();
  const event = makeEvent({ kind: "follow_up", eventReference: "55" });
  const outcome = await dispatchCanonicalEvent(event, { ledger });
  assert.equal(outcome.status, "ignored");
  // shouldSchedule is what gates it (not a build failure).
  assert.equal(shouldSchedule(event), false);
});

test("follow_up still builds via buildReviewJob (layer boundary)", () => {
  const job = buildReviewJob(makeEvent({ kind: "follow_up", eventReference: "55" }), {});
  assert.notEqual(job, null);
  assert.equal(job?.kind, "follow_up");
});

test("config fingerprint change re-keys the generation", async () => {
  const ledger = new MemoryGenerationLedger();
  const withConfig = await dispatchCanonicalEvent(makeEvent(), {
    ledger,
    buildOptions: { configFingerprint: "abcd1234" },
  });
  const withoutConfig = await dispatchCanonicalEvent(makeEvent(), { ledger });
  assert.equal(withConfig.status, "scheduled");
  assert.equal(withoutConfig.status, "scheduled");
  if (withConfig.status !== "scheduled" || withoutConfig.status !== "scheduled") return;
  assert.notEqual(withoutConfig.job.jobId, withConfig.job.jobId);
});

async function freshJob(): Promise<ReviewJob> {
  const ledger = new MemoryGenerationLedger();
  const outcome = await dispatchCanonicalEvent(makeEvent(), { ledger });
  if (outcome.status !== "scheduled") throw new Error("expected scheduled");
  return outcome.job;
}

test("gate publishes when result head matches current head", async () => {
  const job = await freshJob();
  let publishCalls = 0;
  const gate = await gateJobPublication({
    job,
    resultHeadSha: job.headSha,
    fetchCurrentHeadSha: async () => HEAD,
    publish: async () => {
      publishCalls += 1;
    },
    nowMs: 10_000,
  });
  assert.equal(gate.status, "published");
  assert.equal(publishCalls, 1);
});

test("gate marks stale when current head moved, publish not called", async () => {
  const job = await freshJob();
  let publishCalls = 0;
  const gate = await gateJobPublication({
    job,
    resultHeadSha: job.headSha,
    fetchCurrentHeadSha: async () => NEW_HEAD,
    publish: async () => {
      publishCalls += 1;
    },
    nowMs: 10_000,
  });
  assert.equal(gate.status, "stale");
  assert.equal(publishCalls, 0);
});

test("gate fails closed to stale when the current head is unprovable", async () => {
  const job = await freshJob();
  let publishCalls = 0;
  const gate = await gateJobPublication({
    job,
    resultHeadSha: job.headSha,
    fetchCurrentHeadSha: async () => null,
    publish: async () => {
      publishCalls += 1;
    },
    nowMs: 10_000,
  });
  assert.equal(gate.status, "stale");
  assert.equal(publishCalls, 0);
});

test("expired gate skips the head fetch entirely", async () => {
  const ledger = new MemoryGenerationLedger();
  const outcome = await dispatchCanonicalEvent(makeEvent(), {
    ledger,
    buildOptions: { deadlineAtMs: 1000 },
  });
  if (outcome.status !== "scheduled") throw new Error("expected scheduled");
  let fetchCalls = 0;
  let publishCalls = 0;
  const gate = await gateJobPublication({
    job: outcome.job,
    resultHeadSha: outcome.job.headSha,
    fetchCurrentHeadSha: async () => {
      fetchCalls += 1;
      return HEAD;
    },
    publish: async () => {
      publishCalls += 1;
    },
    nowMs: 1000,
  });
  assert.equal(gate.status, "expired");
  assert.equal(fetchCalls, 0);
  assert.equal(publishCalls, 0);
});

test("a publish() rejection propagates out of the gate", async () => {
  const job = await freshJob();
  const failure = new Error("partial publication");
  await assert.rejects(
    gateJobPublication({
      job,
      resultHeadSha: job.headSha,
      fetchCurrentHeadSha: async () => HEAD,
      publish: async () => {
        throw failure;
      },
      nowMs: 10_000,
    }),
    (error: unknown) => error === failure,
  );
});

test("MemoryGenerationLedger tracks adds", async () => {
  const ledger = new MemoryGenerationLedger();
  assert.equal(await ledger.has("job-1"), false);
  ledger.add("job-1");
  assert.equal(await ledger.has("job-1"), true);
});

test("MemoryGenerationLedger.addIfAbsent reserves once, remove releases", async () => {
  const ledger = new MemoryGenerationLedger();
  assert.equal(await ledger.addIfAbsent("job-1"), true);
  assert.equal(await ledger.addIfAbsent("job-1"), false);
  assert.equal(await ledger.has("job-1"), true);
  ledger.remove("job-1");
  assert.equal(await ledger.has("job-1"), false);
  assert.equal(await ledger.addIfAbsent("job-1"), true);
});

test("concurrent dispatches of the same event: one scheduled, rest duplicate", async () => {
  const ledger = new MemoryGenerationLedger();
  const event = makeEvent();
  const outcomes = await Promise.all(
    Array.from({ length: 5 }, () => dispatchCanonicalEvent(event, { ledger })),
  );
  const scheduled = outcomes.filter((outcome) => outcome.status === "scheduled");
  const duplicates = outcomes.filter((outcome) => outcome.status === "duplicate");
  assert.equal(scheduled.length, 1);
  assert.equal(duplicates.length, 4);
});