import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildReviewJob,
  deriveGenerationId,
  isExpired,
  isResultStale,
  resultMatchesJob,
  shouldSchedule,
} from "../src/jobs/index.js";
import type { GenerationIdentity } from "../src/jobs/generation.js";
import type { ReviewJob } from "../src/jobs/types.js";
import type { CanonicalForgeEvent } from "../src/events/types.js";
import { normalizeGitHubEvent, reconciliationPollEvent } from "../src/events/normalize.js";

/** A fully-populated canonical event; overrides win. */
function makeEvent(overrides: Partial<CanonicalForgeEvent> = {}): CanonicalForgeEvent {
  return Object.freeze({
    platform: "github",
    source: "webhook",
    kind: "synchronize",
    installationId: "42",
    repoFullName: "owner/repo",
    prNumber: 7,
    prId: 4242,
    headSha: "aa11bb22cc33",
    baseSha: "dd44ee55ff66",
    draft: false,
    fork: false,
    labelName: "",
    actor: "opener",
    ...overrides,
  });
}

/** The job minus the two non-identity fields (reason/trigger). */
function withoutNonIdentity(job: ReviewJob): Record<string, unknown> {
  const { reason, trigger, ...rest } = job;
  void reason;
  void trigger;
  return rest as Record<string, unknown>;
}

// ── Generation identity: dedupe ───────────────────────────────────────────

test("webhook and poll of the same PR with the same config yield identical jobs", () => {
  // REAL payloads through the normalizers: the webhook envelope carries
  // installation.id; the poll supplies the SAME installationId.
  const pr = {
    number: 7,
    id: 4242,
    draft: false,
    head: { sha: "AA11BB22CC33", repo: { full_name: "owner/repo" } },
    base: { sha: "dd44ee55ff66", repo: { full_name: "owner/repo" } },
    user: { login: "opener" },
  };
  const webhook = normalizeGitHubEvent({
    name: "pull_request",
    action: "synchronize",
    pull_request: pr,
    repository: { full_name: "owner/repo" },
    installation: { id: 12345 },
    sender: { login: "webhook-sender" },
  });
  const poll = reconciliationPollEvent("github", pr, { installationId: "12345" });
  assert.notEqual(webhook, null);
  assert.notEqual(poll, null);
  const a = buildReviewJob(webhook!, { configFingerprint: "0123456789abcdef" });
  const b = buildReviewJob(poll!, { configFingerprint: "0123456789abcdef" });
  assert.notEqual(a, null);
  assert.notEqual(b, null);
  // Dedupe: same generation id.
  assert.equal(a!.jobId, b!.jobId);
  // Only the non-identity fields differ.
  assert.equal(a!.reason, "synchronize");
  assert.equal(b!.reason, "reconciliation_poll");
  assert.equal(a!.trigger, "webhook");
  assert.equal(b!.trigger, "poll");
  assert.deepEqual(withoutNonIdentity(a!), withoutNonIdentity(b!));
});

test("a new headSha yields a distinct jobId", () => {
  const a = buildReviewJob(makeEvent({ headSha: "aa11bb22cc33" }));
  const b = buildReviewJob(makeEvent({ headSha: "dd44ee55ff66" }));
  assert.notEqual(a, null);
  assert.notEqual(b, null);
  assert.notEqual(a!.jobId, b!.jobId);
});

test("a different configFingerprint yields a distinct jobId", () => {
  const ev = makeEvent();
  const a = buildReviewJob(ev, { configFingerprint: "0123456789abcdef" });
  const b = buildReviewJob(ev, { configFingerprint: "fedcba9876543210" });
  const c = buildReviewJob(ev);
  assert.notEqual(a, null);
  assert.notEqual(b, null);
  assert.notEqual(c, null);
  assert.notEqual(a!.jobId, b!.jobId);
  assert.notEqual(a!.jobId, c!.jobId);
  // Default config fingerprint is the "" sentinel.
  assert.equal(c!.configFingerprint, "");
});

test("rereview_label and synchronize of the same head share a jobId; reason is not identity", () => {
  const sync = buildReviewJob(makeEvent({ kind: "synchronize" }));
  const labeled = buildReviewJob(makeEvent({ kind: "rereview_label", labelName: "ai-review" }));
  assert.notEqual(sync, null);
  assert.notEqual(labeled, null);
  assert.equal(sync!.jobId, labeled!.jobId);
  assert.equal(sync!.reason, "synchronize");
  assert.equal(labeled!.reason, "rereview_label");
});

test("deriveGenerationId pins the canonical serialization (fixed key=value order)", () => {
  const identity = {
    platform: "github",
    installationId: "",
    repoFullName: "owner/repo",
    prNumber: 1,
    prId: 2,
    headSha: "h",
    baseSha: "",
    configFingerprint: "",
    kind: "review",
    nonce: "",
  } as const;
  const canonical =
    "platform=github\n" +
    "installationId=\n" +
    "repoFullName=owner/repo\n" +
    "prNumber=1\n" +
    "prId=2\n" +
    "headSha=h\n" +
    "baseSha=\n" +
    "configFingerprint=\n" +
    "kind=review\n" +
    "nonce=\n";
  const expected = createHash("sha256").update(canonical, "utf8").digest("hex");
  assert.equal(deriveGenerationId(identity), expected);
});

test("a newline/CR in any identity value yields the empty id (newline-injection guard)", () => {
  const base: GenerationIdentity = {
    platform: "github",
    installationId: "42",
    repoFullName: "owner/repo",
    prNumber: 7,
    prId: 4242,
    headSha: "aa11bb22cc33",
    baseSha: "dd44ee55ff66",
    configFingerprint: "",
    kind: "review",
    nonce: "",
  };
  // The exact hostile boundary: two DISTINCT identities that serialize to
  // the SAME bytes in the `key=value\n` form.
  const serialize = (headSha: string, baseSha: string): string =>
    "platform=github\ninstallationId=42\nrepoFullName=owner/repo\nprNumber=7\nprId=4242\n" +
    `headSha=${headSha}\n` +
    `baseSha=${baseSha}\n` +
    "configFingerprint=\nkind=review\nnonce=\n";
  assert.equal(serialize("x\nbaseSha=b", ""), serialize("x", "b\nbaseSha="));
  // With the guard, neither mints an id:
  assert.equal(deriveGenerationId({ ...base, headSha: "x\nbaseSha=b", baseSha: "" }), "");
  assert.equal(deriveGenerationId({ ...base, headSha: "x", baseSha: "b\nbaseSha=" }), "");
  // A \r in any value is rejected too:
  assert.equal(deriveGenerationId({ ...base, nonce: "a\rb" }), "");
  // ...and buildReviewJob refuses to build a job for them:
  assert.equal(buildReviewJob(makeEvent({ headSha: "x\nbaseSha=b", baseSha: "" })), null);
  assert.equal(buildReviewJob(makeEvent({ headSha: "x", baseSha: "b\nbaseSha=" })), null);
  // A value without \n/\r still mints an id.
  assert.notEqual(deriveGenerationId(base), "");
});

// ── Scheduling policy and job refusal ──────────────────────────────────────

test("every review-producing kind schedules and builds a job", () => {
  for (const kind of [
    "pr_opened",
    "pr_reopened",
    "synchronize",
    "ready_for_review",
    "rereview_label",
    "reconciliation_poll",
    "check_update",
  ] as const) {
    const ev = makeEvent({ kind });
    assert.equal(shouldSchedule(ev), true, kind);
    assert.notEqual(buildReviewJob(ev), null, kind);
  }
});

test("a headless check_update (no PR number) schedules no generation", () => {
  assert.equal(shouldSchedule(makeEvent({ kind: "check_update", prNumber: 0 })), false);
  // With a resolvable PR number, a check_update schedules as before.
  assert.equal(shouldSchedule(makeEvent({ kind: "check_update", prNumber: 7 })), true);
});

test("irrelevant events: shouldSchedule false and buildReviewJob null", () => {
  for (const kind of [
    "pr_closed",
    "pr_merged",
    "installation_change",
    "visibility_change",
    "unknown",
  ] as const) {
    const ev = makeEvent({ kind });
    assert.equal(shouldSchedule(ev), false, kind);
    assert.equal(buildReviewJob(ev), null, kind);
  }
});

test("follow_up does not schedule a review generation but does build a job", () => {
  const ev = makeEvent({ kind: "follow_up" });
  assert.equal(shouldSchedule(ev), false);
  assert.notEqual(buildReviewJob(ev), null);
});

// ── Manual rereview nonce ───────────────────────────────────────────────────

test("manual nonce changes the generation; the same nonce twice is stable", () => {
  const ev = makeEvent();
  const base = buildReviewJob(ev);
  const n1a = buildReviewJob(ev, { nonce: "n-1" });
  const n1b = buildReviewJob(ev, { nonce: "n-1" });
  const n2 = buildReviewJob(ev, { nonce: "n-2" });
  assert.notEqual(base, null);
  assert.notEqual(n1a, null);
  assert.notEqual(n1b, null);
  assert.notEqual(n2, null);
  assert.notEqual(n1a!.jobId, base!.jobId);
  assert.equal(n1a!.jobId, n1b!.jobId);
  assert.notEqual(n1a!.jobId, n2!.jobId);
  assert.equal(n1a!.nonce, "n-1");
  assert.equal(n2!.nonce, "n-2");
});

test("a manual forced rereview with a nonce differs from the webhook job for identical head+config", () => {
  const webhook = buildReviewJob(makeEvent({ kind: "synchronize", source: "webhook" }));
  const manual = buildReviewJob(
    makeEvent({ kind: "synchronize", source: "manual" }),
    { nonce: "force-1" },
  );
  assert.notEqual(webhook, null);
  assert.notEqual(manual, null);
  assert.notEqual(manual!.jobId, webhook!.jobId);
});

test("an empty nonce is ABSENT: it builds the plain job; non-empty nonces are validated", () => {
  const ev = makeEvent();
  const base = buildReviewJob(ev);
  const empty = buildReviewJob(ev, { nonce: "" });
  assert.notEqual(base, null);
  assert.notEqual(empty, null);
  assert.equal(empty!.jobId, base!.jobId);
  assert.equal(empty!.nonce, "");
  assert.equal(buildReviewJob(ev, { nonce: "!!!" }), null);
  // Boundary: exactly 64 valid chars is accepted, 65 is not.
  assert.notEqual(buildReviewJob(ev, { nonce: "a".repeat(64) }), null);
  assert.equal(buildReviewJob(ev, { nonce: "a".repeat(65) }), null);
});

test("an invalid provided nonce fails the build (never silently emptied)", () => {
  const ev = makeEvent();
  assert.equal(buildReviewJob(ev, { nonce: "!!!" }), null);
  assert.equal(buildReviewJob(ev, { nonce: "has space" }), null);
});

// ── follow_up isolation ─────────────────────────────────────────────────────

test("follow_up job: kind follow_up, nonce ignored, never shares a review jobId", () => {
  const fu = makeEvent({ kind: "follow_up" });
  const plain = buildReviewJob(fu);
  const withNonce = buildReviewJob(fu, { nonce: "q-a-1" });
  assert.notEqual(plain, null);
  assert.notEqual(withNonce, null);
  assert.equal(plain!.kind, "follow_up");
  assert.equal(withNonce!.kind, "follow_up");
  // The nonce is IGNORED: dropped, not validated, not stored.
  assert.equal(withNonce!.nonce, "");
  assert.equal(plain!.jobId, withNonce!.jobId);

  // kind IS an identity field: a follow_up job for the same head/config
  // can never share a generation id with a review job.
  const review = buildReviewJob(makeEvent({ kind: "synchronize" }));
  assert.notEqual(review, null);
  assert.notEqual(plain!.jobId, review!.jobId);
});

// ── Field preservation ──────────────────────────────────────────────────────

test("event fields (including fork) are preserved into the job", () => {
  const job = buildReviewJob(makeEvent({ fork: true }));
  assert.notEqual(job, null);
  assert.equal(job!.fork, true);
  assert.equal(job!.platform, "github");
  assert.equal(job!.installationId, "42");
  assert.equal(job!.repoFullName, "owner/repo");
  assert.equal(job!.prNumber, 7);
  assert.equal(job!.prId, 4242);
  assert.equal(job!.headSha, "aa11bb22cc33");
  assert.equal(job!.baseSha, "dd44ee55ff66");
  assert.equal(buildReviewJob(makeEvent({ fork: false }))!.fork, false);
});

test("build options pass through with sentinel defaults; the job is frozen", () => {
  const job = buildReviewJob(makeEvent(), {
    configFingerprint: "0123456789abcdef",
    deadlineAtMs: 5,
    runId: "run-1",
  });
  assert.notEqual(job, null);
  assert.ok(Object.isFrozen(job));
  assert.equal(job!.configFingerprint, "0123456789abcdef");
  assert.equal(job!.deadlineAtMs, 5);
  assert.equal(job!.runId, "run-1");
  assert.equal(job!.nonce, "");

  const defaults = buildReviewJob(makeEvent());
  assert.notEqual(defaults, null);
  assert.equal(defaults!.deadlineAtMs, 0);
  assert.equal(defaults!.runId, "");
  assert.equal(defaults!.configFingerprint, "");
});

test("a provided deadlineAtMs must be a safe integer >= 0", () => {
  const ev = makeEvent();
  assert.equal(buildReviewJob(ev, { deadlineAtMs: Number.NaN }), null);
  assert.equal(buildReviewJob(ev, { deadlineAtMs: -1 }), null);
  assert.notEqual(buildReviewJob(ev, { deadlineAtMs: 0 }), null);
  assert.notEqual(buildReviewJob(ev, { deadlineAtMs: 1000 }), null);
});

test("a non-empty configFingerprint must be an 8–64 hex digest", () => {
  const ev = makeEvent();
  assert.equal(buildReviewJob(ev, { configFingerprint: "not-a-hash" }), null);
  assert.equal(buildReviewJob(ev, { configFingerprint: "0123456" }), null); // 7: too short
  assert.notEqual(buildReviewJob(ev, { configFingerprint: "0123456789abcdef" }), null);
  assert.notEqual(buildReviewJob(ev, { configFingerprint: "a".repeat(64) }), null);
  assert.equal(buildReviewJob(ev, { configFingerprint: "a".repeat(65) }), null);
});

// ── Malformed event paths (fail closed) ────────────────────────────────────

test("a review-kind event without a headSha builds no job", () => {
  assert.equal(buildReviewJob(makeEvent({ kind: "synchronize", headSha: "" })), null);
  assert.equal(buildReviewJob(makeEvent({ kind: "pr_opened", headSha: "" })), null);
  // A follow_up without a head is fine: "" is its sentinel.
  const fu = buildReviewJob(makeEvent({ kind: "follow_up", headSha: "" }));
  assert.notEqual(fu, null);
  assert.equal(fu!.headSha, "");
});

test("buildReviewJob normalizes head/base SHAs and fails closed on malformed ones", () => {
  const job = buildReviewJob(makeEvent({ headSha: " AA11BB22CC33 ", baseSha: "DD44EE55FF66" }));
  assert.notEqual(job, null);
  assert.equal(job!.headSha, "aa11bb22cc33");
  assert.equal(job!.baseSha, "dd44ee55ff66");
  assert.equal(buildReviewJob(makeEvent({ headSha: "not-a-sha" })), null);
  assert.equal(buildReviewJob(makeEvent({ headSha: "aa11bb22cc33", baseSha: "zzz" })), null);
  // follow_up: a non-empty head must also be well-formed.
  assert.equal(buildReviewJob(makeEvent({ kind: "follow_up", headSha: "not-a-sha" })), null);
});

test("a 10KB headSha in a review event builds no job", () => {
  assert.equal(buildReviewJob(makeEvent({ headSha: "a".repeat(10 * 1024) })), null);
});

// ── Per-field identity distinctness and hostile shapes ─────────────────────

test("each of the ten identity fields, varied alone, yields a distinct jobId", () => {
  const base = buildReviewJob(makeEvent());
  assert.notEqual(base, null);
  const eventFields: Array<[string, Partial<CanonicalForgeEvent>]> = [
    ["platform", { platform: "forgejo" }],
    ["installationId", { installationId: "43" }],
    ["repoFullName", { repoFullName: "other/repo" }],
    ["prNumber", { prNumber: 8 }],
    ["prId", { prId: 4243 }],
    ["headSha", { headSha: "dd44ee55ff66" }],
    ["baseSha", { baseSha: "ee55ff66aa77" }],
    ["kind", { kind: "follow_up" }],
  ];
  for (const [field, overrides] of eventFields) {
    const job = buildReviewJob(makeEvent(overrides));
    assert.notEqual(job, null, field);
    assert.notEqual(job!.jobId, base!.jobId, field);
  }
  // configFingerprint and nonce are build options, not event fields.
  const cfg = buildReviewJob(makeEvent(), { configFingerprint: "0123456789abcdef" });
  assert.notEqual(cfg, null, "configFingerprint");
  assert.notEqual(cfg!.jobId, base!.jobId, "configFingerprint");
  const nonce = buildReviewJob(makeEvent(), { nonce: "n-1" });
  assert.notEqual(nonce, null, "nonce");
  assert.notEqual(nonce!.jobId, base!.jobId, "nonce");
});

test("a __proto__-keyed event object does not throw and does not pollute Object.prototype", () => {
  const ev: Record<string, unknown> = { ...makeEvent() };
  Object.defineProperty(ev, "__proto__", {
    value: { polluted: true },
    enumerable: true,
  });
  const asEvent = ev as unknown as CanonicalForgeEvent;
  assert.doesNotThrow(() => buildReviewJob(asEvent));
  assert.notEqual(buildReviewJob(asEvent), null);

  const identity: Record<string, unknown> = {
    platform: "github",
    installationId: "42",
    repoFullName: "owner/repo",
    prNumber: 7,
    prId: 4242,
    headSha: "aa11bb22cc33",
    baseSha: "dd44ee55ff66",
    configFingerprint: "",
    kind: "review",
    nonce: "",
  };
  Object.defineProperty(identity, "__proto__", {
    value: { polluted: true },
    enumerable: true,
  });
  assert.doesNotThrow(() => deriveGenerationId(identity as unknown as GenerationIdentity));

  // Object.prototype was not polluted.
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});

// ── Staleness ───────────────────────────────────────────────────────────────

test("isResultStale: differ → stale; case/whitespace-insensitive; malformed/empty → fail closed", () => {
  assert.equal(isResultStale("aa11bb22cc33", "dd44ee55ff66"), true);
  assert.equal(isResultStale("AA11BB22CC33", "aa11bb22cc33"), false);
  assert.equal(isResultStale(" aa11bb22cc33 ", "AA11BB22CC33"), false);
  assert.equal(isResultStale("", "aa11bb22cc33"), true);
  assert.equal(isResultStale("aa11bb22cc33", ""), true);
  assert.equal(isResultStale("", ""), true);
  // Malformed (non-hex) SHAs fail closed as stale.
  assert.equal(isResultStale("head-1", "aa11bb22cc33"), true);
  assert.equal(isResultStale("aa11bb22cc33", "HEAD-1"), true);
});

test("resultMatchesJob: fresh AND the job's own head", () => {
  const job = buildReviewJob(makeEvent({ headSha: "aa11bb22cc33" }));
  assert.notEqual(job, null);
  // All match and fresh.
  assert.equal(resultMatchesJob(job!, "AA11BB22CC33", "aa11bb22cc33"), true);
  // Current head moved: a stale worker result for the old head.
  assert.equal(resultMatchesJob(job!, "aa11bb22cc33", "dd44ee55ff66"), false);
  // Result sha is not the job's head sha.
  assert.equal(resultMatchesJob(job!, "dd44ee55ff66", "dd44ee55ff66"), false);
  // Empty side: fail closed.
  assert.equal(resultMatchesJob(job!, "", "aa11bb22cc33"), false);
  // Malformed result sha: fail closed.
  assert.equal(resultMatchesJob(job!, "head-1", "aa11bb22cc33"), false);
});

test("isExpired: 0 deadline never expires; now >= deadline is expired", () => {
  const open = buildReviewJob(makeEvent());
  assert.notEqual(open, null);
  assert.equal(open!.deadlineAtMs, 0);
  assert.equal(isExpired(open!, Number.MAX_SAFE_INTEGER), false);

  const due = buildReviewJob(makeEvent(), { deadlineAtMs: 1000 });
  assert.notEqual(due, null);
  assert.equal(isExpired(due!, 999), false);
  assert.equal(isExpired(due!, 1000), true);
  assert.equal(isExpired(due!, 1001), true);
});
