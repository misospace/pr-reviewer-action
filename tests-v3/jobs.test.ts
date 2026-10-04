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
    eventReference: "",
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
    adoptionEpoch: "",
    eventReference: "",
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
    "nonce=\n" +
    "adoptionEpoch=\n" +
    "eventReference=\n";
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
    adoptionEpoch: "",
    eventReference: "",
  };
  // The exact hostile boundary: two DISTINCT identities that serialize to
  // the SAME bytes in the full TWELVE-line `key=value\n` form.
  const serialize = (headSha: string, baseSha: string): string =>
    "platform=github\ninstallationId=42\nrepoFullName=owner/repo\nprNumber=7\nprId=4242\n" +
    `headSha=${headSha}\n` +
    `baseSha=${baseSha}\n` +
    "configFingerprint=\nkind=review\nnonce=\nadoptionEpoch=\neventReference=\n";
  assert.equal(serialize("x\nbaseSha=b", ""), serialize("x", "b\nbaseSha="));
  // With the guard, neither mints an id:
  assert.equal(deriveGenerationId({ ...base, headSha: "x\nbaseSha=b", baseSha: "" }), "");
  assert.equal(deriveGenerationId({ ...base, headSha: "x", baseSha: "b\nbaseSha=" }), "");
  // A \r in any value is rejected too:
  assert.equal(deriveGenerationId({ ...base, nonce: "a\rb" }), "");
  // The two NEW identity fields (adoptionEpoch, eventReference) are
  // guarded the same way:
  assert.equal(deriveGenerationId({ ...base, adoptionEpoch: "a\rb" }), "");
  assert.equal(deriveGenerationId({ ...base, eventReference: "1\n2" }), "");
  // ...and one more CR case:
  assert.equal(deriveGenerationId({ ...base, eventReference: "1\r2" }), "");
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
  const ev = makeEvent({ kind: "follow_up", eventReference: "1234" });
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

test("a type-cast numeric nonce is stored as its String() form in the frozen job", () => {
  // A type-cast number can never land in the string field / persisted
  // payload: after validation the builder stores String(value).
  const ev = makeEvent();
  const job = buildReviewJob(ev, { nonce: 123 as unknown as string });
  assert.notEqual(job, null);
  assert.equal(typeof job!.nonce, "string");
  assert.equal(job!.nonce, "123");
  // The same id as the string form:
  const stringJob = buildReviewJob(ev, { nonce: "123" });
  assert.notEqual(stringJob, null);
  assert.equal(job!.jobId, stringJob!.jobId);
});

// ── Adoption epoch ───────────────────────────────────────────────────────────

test("disable→re-enable: same head+config, a new adoptionEpoch yields a distinct jobId", () => {
  const ev = makeEvent();
  const cfg = { configFingerprint: "0123456789abcdef" };
  const preAdoption = buildReviewJob(ev, cfg);
  const gen1 = buildReviewJob(ev, { ...cfg, adoptionEpoch: "1" });
  const gen2 = buildReviewJob(ev, { ...cfg, adoptionEpoch: "2" });
  assert.notEqual(preAdoption, null);
  assert.notEqual(gen1, null);
  assert.notEqual(gen2, null);
  // The unchanged head+config hashes back to the same configFingerprint,
  // so the epoch is what re-keys the generation:
  assert.notEqual(gen2!.jobId, preAdoption!.jobId);
  assert.notEqual(gen1!.jobId, preAdoption!.jobId);
  assert.notEqual(gen1!.jobId, gen2!.jobId);
  // The same epoch twice is stable (idempotent).
  const gen2b = buildReviewJob(ev, { ...cfg, adoptionEpoch: "2" });
  assert.notEqual(gen2b, null);
  assert.equal(gen2!.jobId, gen2b!.jobId);
  // The job carries the validated value.
  assert.equal(preAdoption!.adoptionEpoch, "");
  assert.equal(gen1!.adoptionEpoch, "1");
  assert.equal(gen2!.adoptionEpoch, "2");
});

test("an empty adoptionEpoch is ABSENT: it builds the plain job; non-empty epochs are validated", () => {
  const ev = makeEvent();
  const base = buildReviewJob(ev);
  const empty = buildReviewJob(ev, { adoptionEpoch: "" });
  assert.notEqual(base, null);
  assert.notEqual(empty, null);
  assert.equal(empty!.jobId, base!.jobId);
  assert.equal(empty!.adoptionEpoch, "");
  // Boundary: exactly 64 valid chars is accepted, 65 is not.
  assert.notEqual(buildReviewJob(ev, { adoptionEpoch: "a".repeat(64) }), null);
  assert.equal(buildReviewJob(ev, { adoptionEpoch: "a".repeat(65) }), null);
});

test("an invalid provided adoptionEpoch fails the build (newline, too long, bad charset)", () => {
  const ev = makeEvent();
  assert.equal(buildReviewJob(ev, { adoptionEpoch: "gen\n2" }), null);
  assert.equal(buildReviewJob(ev, { adoptionEpoch: "gen\r2" }), null);
  assert.equal(buildReviewJob(ev, { adoptionEpoch: "a".repeat(65) }), null);
  assert.equal(buildReviewJob(ev, { adoptionEpoch: "!!!" }), null);
  assert.equal(buildReviewJob(ev, { adoptionEpoch: "has space" }), null);
});

// ── follow_up isolation ─────────────────────────────────────────────────────

test("follow_up job: kind follow_up, nonce ignored, never shares a review jobId", () => {
  const fu = makeEvent({ kind: "follow_up", eventReference: "1234" });
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

// ── follow_up eventReference ────────────────────────────────────────────────

test("follow_up: two events differing only by eventReference yield distinct jobIds", () => {
  const a = buildReviewJob(makeEvent({ kind: "follow_up", eventReference: "1234" }));
  const b = buildReviewJob(makeEvent({ kind: "follow_up", eventReference: "5678" }));
  assert.notEqual(a, null);
  assert.notEqual(b, null);
  assert.notEqual(a!.jobId, b!.jobId);
  // The frozen job carries the effective reference.
  assert.equal(a!.eventReference, "1234");
  assert.equal(b!.eventReference, "5678");
});

test("follow_up: the same comment id from any source dedupes to one jobId (source-independent)", () => {
  // The builder is SOURCE-INDEPENDENT: no real poll path produces a
  // follow_up today (polls are never comment-shaped), so this pin
  // documents the id contract, not a real webhook/poll convergence.
  const webhook = buildReviewJob(
    makeEvent({ kind: "follow_up", eventReference: "1234", source: "webhook" }),
  );
  const poll = buildReviewJob(makeEvent({ kind: "follow_up", eventReference: "1234", source: "poll" }));
  assert.notEqual(webhook, null);
  assert.notEqual(poll, null);
  // Same comment id, any source => one job.
  assert.equal(webhook!.jobId, poll!.jobId);
});

test("follow_up: an empty or invalid eventReference fails the build (fail closed)", () => {
  const fu = { kind: "follow_up" as const };
  assert.equal(buildReviewJob(makeEvent(fu)), null); // "" (absent)
  assert.equal(buildReviewJob(makeEvent({ ...fu, eventReference: "0" })), null);
  // Leading zero: not canonical, fails closed.
  assert.equal(buildReviewJob(makeEvent({ ...fu, eventReference: "007" })), null);
  assert.equal(buildReviewJob(makeEvent({ ...fu, eventReference: "-5" })), null);
  assert.equal(buildReviewJob(makeEvent({ ...fu, eventReference: "abc" })), null);
  // Newline-injection boundary: the hostile token itself.
  assert.equal(buildReviewJob(makeEvent({ ...fu, eventReference: "12\n34" })), null);
  // Oversized: 20 digits fails, 19 is the boundary that passes.
  assert.equal(buildReviewJob(makeEvent({ ...fu, eventReference: "1".repeat(20) })), null);
  assert.notEqual(buildReviewJob(makeEvent({ ...fu, eventReference: "1".repeat(19) })), null);
});

test("a non-string eventReference is stored as its String() form in the frozen job", () => {
  // A type-cast number can never land in the string field / persisted
  // payload: after validation the builder stores String(value).
  const ev = makeEvent({ kind: "follow_up", eventReference: 1234 as unknown as string });
  const job = buildReviewJob(ev);
  assert.notEqual(job, null);
  assert.equal(job!.eventReference, "1234");
  assert.equal(typeof job!.eventReference, "string");
});

test("review jobs force eventReference to '': a stray reference changes nothing", () => {
  const clean = buildReviewJob(makeEvent({ kind: "synchronize", eventReference: "" }));
  const stray = buildReviewJob(makeEvent({ kind: "synchronize", eventReference: "1234" }));
  assert.notEqual(clean, null);
  assert.notEqual(stray, null);
  // The review generation dedupes across sources even when a stray event
  // carries a comment id:
  assert.equal(stray!.jobId, clean!.jobId);
  assert.equal(stray!.eventReference, "");
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

test("a runId with control characters, over 128 chars, or a non-string value is sanitized to ''", () => {
  const ev = makeEvent();
  // Newline / control character: the hostile tokens themselves.
  let job = buildReviewJob(ev, { runId: "run\n1" });
  assert.notEqual(job, null);
  assert.equal(job!.runId, "");
  job = buildReviewJob(ev, { runId: "run\u00001" });
  assert.notEqual(job, null);
  assert.equal(job!.runId, "");
  // Boundary: 128 chars (after trim) is accepted, 129 is not.
  job = buildReviewJob(ev, { runId: "r".repeat(128) });
  assert.notEqual(job, null);
  assert.equal(job!.runId, "r".repeat(128));
  job = buildReviewJob(ev, { runId: "r".repeat(129) });
  assert.notEqual(job, null);
  assert.equal(job!.runId, "");
  // A normal runId is preserved (trimmed).
  job = buildReviewJob(ev, { runId: " run-1 " });
  assert.notEqual(job, null);
  assert.equal(job!.runId, "run-1");
  // A cast-away non-string becomes "" (never stringified into the payload).
  job = buildReviewJob(ev, { runId: 42 as unknown as string });
  assert.notEqual(job, null);
  assert.equal(job!.runId, "");
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
  const fu = buildReviewJob(makeEvent({ kind: "follow_up", headSha: "", eventReference: "1234" }));
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
  assert.equal(
    buildReviewJob(makeEvent({ kind: "follow_up", headSha: "not-a-sha", eventReference: "1234" })),
    null,
  );
});

test("a 10KB headSha in a review event builds no job", () => {
  assert.equal(buildReviewJob(makeEvent({ headSha: "a".repeat(10 * 1024) })), null);
});

test("a hand-built event with a malformed scoping identity field builds no job (each alone)", () => {
  // Each field, cast away to a malformed value, alone must fail the
  // build — the builder's own fail-closed guard for hand-built events:
  const variants: Array<Partial<CanonicalForgeEvent>> = [
    { installationId: undefined as unknown as string },
    { repoFullName: "" },
    { prNumber: 0 },
    { prId: -1 },
    { fork: "yes" as unknown as boolean },
    { platform: "gitlab" as unknown as "github" | "forgejo" },
  ];
  for (const overrides of variants) {
    assert.equal(buildReviewJob(makeEvent(overrides)), null);
  }
  // Control: a well-formed event still builds.
  assert.notEqual(buildReviewJob(makeEvent()), null);
});

test("a cast-away undefined installationId does not collide with a real 'undefined' installation", () => {
  // Without the guard, `undefined` serialized as the literal text
  // "undefined" and hashed identically to a real installation literally
  // named "undefined" — two distinct tuples, one id.
  const missing = buildReviewJob(makeEvent({ installationId: undefined as unknown as string }));
  assert.equal(missing, null);
  // "undefined" is not a digits-only installation id, so the literal
  // form is refused too: the two can never share a job id.
  assert.equal(buildReviewJob(makeEvent({ installationId: "undefined" })), null);
});

test("a leading-zero installation id fails the build; 32 digits builds, 33 does not", () => {
  // "" is the absent sentinel: it still builds.
  assert.notEqual(buildReviewJob(makeEvent({ installationId: "" })), null);
  // Leading zero: not canonical, fails closed.
  assert.equal(buildReviewJob(makeEvent({ installationId: "007" })), null);
  assert.equal(buildReviewJob(makeEvent({ installationId: "0" })), null);
  // Boundary: exactly 32 digits is accepted, 33 is not.
  assert.notEqual(
    buildReviewJob(makeEvent({ installationId: "12345678901234567890123456789012" })),
    null,
  );
  assert.equal(buildReviewJob(makeEvent({ installationId: "1".repeat(33) })), null);
});

// ── Per-field identity distinctness and hostile shapes ─────────────────────

test("each of the twelve identity fields, varied alone, yields a distinct jobId", () => {
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
    // Varying the kind to follow_up also requires a valid eventReference.
    ["kind", { kind: "follow_up", eventReference: "1234" }],
  ];
  for (const [field, overrides] of eventFields) {
    const job = buildReviewJob(makeEvent(overrides));
    assert.notEqual(job, null, field);
    assert.notEqual(job!.jobId, base!.jobId, field);
  }
  // configFingerprint, nonce and adoptionEpoch are build options, not
  // event fields.
  const cfg = buildReviewJob(makeEvent(), { configFingerprint: "0123456789abcdef" });
  assert.notEqual(cfg, null, "configFingerprint");
  assert.notEqual(cfg!.jobId, base!.jobId, "configFingerprint");
  const nonce = buildReviewJob(makeEvent(), { nonce: "n-1" });
  assert.notEqual(nonce, null, "nonce");
  assert.notEqual(nonce!.jobId, base!.jobId, "nonce");
  const epoch = buildReviewJob(makeEvent(), { adoptionEpoch: "2" });
  assert.notEqual(epoch, null, "adoptionEpoch");
  assert.notEqual(epoch!.jobId, base!.jobId, "adoptionEpoch");
  // eventReference is an identity field for follow_up jobs only.
  const fuBase = buildReviewJob(makeEvent({ kind: "follow_up", eventReference: "1234" }));
  const fuVaried = buildReviewJob(makeEvent({ kind: "follow_up", eventReference: "5678" }));
  assert.notEqual(fuBase, null, "eventReference");
  assert.notEqual(fuVaried, null, "eventReference");
  assert.notEqual(fuVaried!.jobId, fuBase!.jobId, "eventReference");
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
    adoptionEpoch: "",
    eventReference: "",
  };
  Object.defineProperty(identity, "__proto__", {
    value: { polluted: true },
    enumerable: true,
  });
  assert.doesNotThrow(() => deriveGenerationId(identity as unknown as GenerationIdentity));

  // Object.prototype was not polluted.
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});

test("a symbol-valued identity field does not throw (fail closed, never raise)", () => {
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
    adoptionEpoch: "",
    eventReference: "",
  };
  // Observed: `String()` is total over any field value (a symbol renders
  // as "Symbol(nonce)"), which carries no \n/\r, so a symbol-valued field
  // mints a 64-hex id (NOT the "" sentinel) instead of raising a
  // TypeError. (A template literal — the pre-fix serialization — DOES
  // throw on a symbol.)
  let id = "";
  assert.doesNotThrow(() => {
    id = deriveGenerationId({ ...base, nonce: Symbol("nonce") as unknown as string });
  });
  assert.match(id, /^[0-9a-f]{64}$/);
  // A hand-built event with a symbol scoping-identity field fails closed
  // (null) without throwing too.
  assert.equal(buildReviewJob(makeEvent({ installationId: Symbol("x") as unknown as string })), null);
});

// ── Accepted-type boundary (fail closed, never throws) ─────────────────────────────────────────────

test("buildReviewJob refuses a cast-away non-string headSha/baseSha without throwing", () => {
  // A SHA is a string by contract: a cast-away non-string (undefined, a
  // number) is refused before normalizeSha's .trim() could throw.
  const cases: Array<Partial<CanonicalForgeEvent>> = [
    { headSha: undefined as unknown as string },
    { headSha: 12345 as unknown as string },
    { baseSha: undefined as unknown as string },
    { baseSha: 12345 as unknown as string },
  ];
  for (const overrides of cases) {
    assert.doesNotThrow(() => buildReviewJob(makeEvent(overrides)));
    assert.equal(buildReviewJob(makeEvent(overrides)), null);
  }
  // Control: a well-formed event still builds.
  assert.notEqual(buildReviewJob(makeEvent()), null);
});

test("a symbol-valued nonce / adoptionEpoch / eventReference is refused without throwing", () => {
  // Adversarial boundary: the hostile value itself. A symbol makes a
  // regex .test() throw at coercion, so it is refused (null) before the
  // pattern test.
  assert.doesNotThrow(() =>
    buildReviewJob(makeEvent(), { nonce: Symbol("nonce") as unknown as string }),
  );
  assert.equal(
    buildReviewJob(makeEvent(), { nonce: Symbol("nonce") as unknown as string }),
    null,
  );
  assert.doesNotThrow(() =>
    buildReviewJob(makeEvent(), { adoptionEpoch: Symbol("epoch") as unknown as string }),
  );
  assert.equal(
    buildReviewJob(makeEvent(), { adoptionEpoch: Symbol("epoch") as unknown as string }),
    null,
  );
  const fu = makeEvent({ kind: "follow_up", eventReference: Symbol("ref") as unknown as string });
  assert.doesNotThrow(() => buildReviewJob(fu));
  assert.equal(buildReviewJob(fu), null);
});

test("an object with a throwing toString for nonce / adoptionEpoch / eventReference is refused without throwing", () => {
  // Adversarial boundary: an object whose toString throws. The
  // accepted-type guard refuses it (typeof "object") before any
  // String() coercion or regex .test() could call toString and throw.
  const hostile: object = {};
  Object.defineProperty(hostile, "toString", {
    value: () => {
      throw new Error("hostile toString");
    },
    configurable: true,
  });
  const hostileStr = hostile as unknown as string;
  assert.doesNotThrow(() => buildReviewJob(makeEvent(), { nonce: hostileStr }));
  assert.equal(buildReviewJob(makeEvent(), { nonce: hostileStr }), null);
  assert.doesNotThrow(() => buildReviewJob(makeEvent(), { adoptionEpoch: hostileStr }));
  assert.equal(buildReviewJob(makeEvent(), { adoptionEpoch: hostileStr }), null);
  const fu = makeEvent({ kind: "follow_up", eventReference: hostileStr });
  assert.doesNotThrow(() => buildReviewJob(fu));
  assert.equal(buildReviewJob(fu), null);
});

test("a numeric nonce / adoptionEpoch / eventReference normalizes to its String() form", () => {
  // Accepted-type list: a number is a valid input and is stored as its
  // String() form (regression guard for the string-or-number list).
  const withNonce = buildReviewJob(makeEvent(), { nonce: 42 as unknown as string });
  assert.notEqual(withNonce, null);
  assert.equal(withNonce!.nonce, "42");

  const withEpoch = buildReviewJob(makeEvent(), { adoptionEpoch: 7 as unknown as string });
  assert.notEqual(withEpoch, null);
  assert.equal(withEpoch!.adoptionEpoch, "7");

  const fu = buildReviewJob(
    makeEvent({ kind: "follow_up", eventReference: 1234 as unknown as string }),
  );
  assert.notEqual(fu, null);
  assert.equal(fu!.eventReference, "1234");
});

test("a hostile configFingerprint (symbol / throwing toString) is refused without throwing; a numeric one normalizes", () => {
  // Adversarial boundary: the hostile value itself. A symbol (or an
  // object whose toString throws) makes a regex .test() throw at
  // coercion, so it is refused (null) before the pattern test.
  assert.doesNotThrow(() =>
    buildReviewJob(makeEvent(), { configFingerprint: Symbol("cfg") as unknown as string }),
  );
  assert.equal(
    buildReviewJob(makeEvent(), { configFingerprint: Symbol("cfg") as unknown as string }),
    null,
  );
  const hostile: object = {};
  Object.defineProperty(hostile, "toString", {
    value: () => {
      throw new Error("hostile toString");
    },
    configurable: true,
  });
  const hostileStr = hostile as unknown as string;
  assert.doesNotThrow(() => buildReviewJob(makeEvent(), { configFingerprint: hostileStr }));
  assert.equal(buildReviewJob(makeEvent(), { configFingerprint: hostileStr }), null);
  // Accepted-type list: a number is a valid input and is stored as its
  // String() form (regression guard for the string-or-number list).
  const withCfg = buildReviewJob(makeEvent(), {
    configFingerprint: 1234567890123456 as unknown as string,
  });
  assert.notEqual(withCfg, null);
  assert.equal(typeof withCfg!.configFingerprint, "string");
  assert.equal(withCfg!.configFingerprint, "1234567890123456");
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

test("isExpired: a non-finite clock fails closed (expired); the 0-deadline and >= rules are unchanged", () => {
  const due = buildReviewJob(makeEvent(), { deadlineAtMs: 1000 });
  assert.notEqual(due, null);
  // Non-finite clock: the deadline state is unknowable → fail closed.
  assert.equal(isExpired(due!, Number.NaN), true);
  assert.equal(isExpired(due!, Number.NEGATIVE_INFINITY), true);
  // Finite clocks: the documented >= boundary is unchanged.
  assert.equal(isExpired(due!, 999), false);
  assert.equal(isExpired(due!, 1000), true);
  // A 0 deadline never expires, for ANY clock including NaN.
  const open = buildReviewJob(makeEvent());
  assert.notEqual(open, null);
  assert.equal(isExpired(open!, Number.NaN), false);
  assert.equal(isExpired(open!, Number.NEGATIVE_INFINITY), false);
});
