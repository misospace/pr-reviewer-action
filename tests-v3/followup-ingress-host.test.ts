import test from "node:test";
import assert from "node:assert/strict";
import {
  createFollowUpConsumer,
  type FollowUpConsumer,
  type FollowUpConsumerOptions,
  type FollowUpForgeAdapter,
} from "../src/ingress/followup-host.js";
import {
  DEFAULT_FOLLOW_UP_RATE_LIMITS,
  planFollowUp,
  type FollowUpPlanConfig,
  type FollowUpPlanDeps,
} from "../src/followup/plan.js";
import { FOLLOWUP_REPLY_MARKER } from "../src/followup/classify.js";
import { InMemoryRateLimitStore } from "../src/followup/rate-limit.js";
import { MemoryGenerationLedger, type GenerationLedger } from "../src/ingress/dispatch.js";
import {
  normalizeForgejoEvent,
  normalizeGitHubEvent,
  type CanonicalForgeEvent,
} from "../src/events/index.js";
import type { AuthorityReading } from "../src/precheck/comment-authority.js";
import type { ReviewJob } from "../src/jobs/types.js";

// #1294: the SELF-HOSTED OPERATOR-mode consumer host for canonical
// `follow_up` events. Same canonical event + same shared planner as the
// Action path (parity is pinned in the last test); every forge read/write
// goes through the injected adapter = the configured forge capability, never
// a forge CLI. Rereviews reuse the shipped dispatch path (generation ledger
// included) and never run a second reviewer.

const BOT = "reviewer-bot";
const REREVIEW_COMMAND = "/ai-review";
const MENTION_HANDLES = [BOT];
const RESOLVED_HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

/** A REAL GitHub `issue_comment` shape: `issue.pull_request` is a url-only
 * stub, so the PR number comes from `issue.number` and the normalized head
 * stays "" (the platform adapter hydrates heads later — this host must
 * resolve them through the adapter). */
function commentEvent(body: string, user = "alice", commentId = 555): CanonicalForgeEvent {
  const event = normalizeGitHubEvent({
    name: "issue_comment",
    action: "created",
    repository: { full_name: "o/r" },
    installation: { id: 1 },
    issue: { number: 7, pull_request: { url: "https://api.github.com/repos/o/r/pulls/7" } },
    comment: { id: commentId, user: { login: user }, body },
    sender: { login: user },
  });
  assert.ok(event !== null, "fixture comment payload must normalize");
  assert.equal(event.kind, "follow_up");
  assert.equal(event.headSha, "", "comment payloads normalize with an empty head");
  return event;
}

/** The Forgejo `comment` equivalent of the same fixture. */
function forgejoCommentEvent(body: string, user = "alice", commentId = 555): CanonicalForgeEvent {
  const event = normalizeForgejoEvent({
    event: "comment",
    action: "created",
    repository: { full_name: "o/r" },
    issue: { number: 7, pull_request: { url: "https://forge.example/o/r/pulls/7" } },
    comment: { id: commentId, user: { login: user }, body },
    sender: { login: user },
  });
  assert.ok(event !== null, "fixture comment payload must normalize");
  assert.equal(event.kind, "follow_up");
  assert.equal(event.headSha, "", "comment payloads normalize with an empty head");
  return event;
}

interface AdapterCalls {
  readPermission: string[];
  readComment: [string, string][];
  fetchThreadComments: number;
  latestManagedReview: number;
  prLastEditedAt: number;
  postComment: string[];
  resolveHeadSha: number;
}

interface AdapterFixtureOptions {
  permission?: AuthorityReading | null;
  permissionThrows?: boolean;
  readCommentBody?: string;
  readCommentThrows?: boolean;
  threadComments?: readonly unknown[];
  managedReview?: string;
  prLastEditedAt?: string | null;
  postCommentOk?: boolean;
  postCommentThrows?: boolean;
  resolveHeadSha?: string | null;
  resolveHeadShaThrows?: boolean;
}

/** Recording forge-adapter fake. Defaults: an authorized (admin) reading, an
 * unreadable comment body, an empty thread, no managed review, no
 * last-edit instant, a successful post, and an unresolvable head — so a
 * test opts into the capability it wants to exercise. */
function makeAdapter(options: AdapterFixtureOptions = {}): {
  adapter: FollowUpForgeAdapter;
  calls: AdapterCalls;
} {
  const calls: AdapterCalls = {
    readPermission: [],
    readComment: [],
    fetchThreadComments: 0,
    latestManagedReview: 0,
    prLastEditedAt: 0,
    postComment: [],
    resolveHeadSha: 0,
  };
  const defaultReading: AuthorityReading = { permission: "admin", roleName: "", subject: "absent" };
  const adapter: FollowUpForgeAdapter = {
    async readPermission(_repoFullName, login) {
      calls.readPermission.push(login);
      if (options.permissionThrows) throw new Error("permission probe failed");
      return options.permission === undefined ? defaultReading : options.permission;
    },
    async readComment(repoFullName, commentId) {
      calls.readComment.push([repoFullName, commentId]);
      if (options.readCommentThrows) throw new Error("comment read failed");
      return options.readCommentBody ?? "";
    },
    async fetchThreadComments() {
      calls.fetchThreadComments += 1;
      return options.threadComments ?? [];
    },
    async latestManagedReview() {
      calls.latestManagedReview += 1;
      return options.managedReview ?? "";
    },
    async prLastEditedAt() {
      calls.prLastEditedAt += 1;
      return options.prLastEditedAt ?? null;
    },
    async postComment(_repoFullName, _prNumber, body) {
      calls.postComment.push(body);
      if (options.postCommentThrows) throw new Error("post failed");
      return options.postCommentOk ?? true;
    },
    async resolveHeadSha() {
      calls.resolveHeadSha += 1;
      if (options.resolveHeadShaThrows) throw new Error("head read failed");
      return options.resolveHeadSha ?? null;
    },
  };
  return { adapter, calls };
}

/** Consumer with the daemon's standard bindings; overrides win. */
function makeConsumer(
  adapter: FollowUpForgeAdapter,
  overrides: Partial<FollowUpConsumerOptions> = {},
): FollowUpConsumer {
  return createFollowUpConsumer({
    adapter,
    botLogin: async () => BOT,
    clock: () => 1_000_000,
    rateLimitStore: new InMemoryRateLimitStore(),
    rereviewCommand: REREVIEW_COMMAND,
    mentionHandles: MENTION_HANDLES,
    rateLimit: DEFAULT_FOLLOW_UP_RATE_LIMITS,
    answer: async () => "a bounded answer",
    ledger: new MemoryGenerationLedger(),
    ...overrides,
  });
}

/** Ledger wrapper recording addIfAbsent/remove, for reservation-contract
 * assertions. */
class RecordingLedger implements GenerationLedger {
  readonly addIfAbsentCalls: string[] = [];
  readonly removed: string[] = [];
  private readonly inner = new MemoryGenerationLedger();

  has(jobId: string): boolean {
    return this.inner.has(jobId);
  }

  add(jobId: string): void {
    this.inner.add(jobId);
  }

  addIfAbsent(jobId: string): boolean {
    this.addIfAbsentCalls.push(jobId);
    return this.inner.addIfAbsent(jobId);
  }

  remove(jobId: string): void {
    this.removed.push(jobId);
    this.inner.remove(jobId);
  }
}

test("an authorized question with the body passed is answered and posted exactly once", async () => {
  const { adapter, calls } = makeAdapter();
  const prompts: string[] = [];
  const consumer = makeConsumer(adapter, {
    answer: async (prompt) => {
      prompts.push(prompt);
      return "it retries three times, then gives up";
    },
  });
  const question = "@reviewer-bot does this fix the null check?";
  const outcome = await consumer.handleEvent(commentEvent(question), question);
  assert.deepEqual(outcome, { status: "answered", posted: true });
  assert.equal(prompts.length, 1, "exactly one model answer per event");
  assert.match(prompts[0]!, /does this fix the null check/);
  assert.equal(calls.postComment.length, 1);
  assert.ok(
    calls.postComment[0]!.startsWith(FOLLOWUP_REPLY_MARKER),
    "the posted body carries the loop-guard marker",
  );
  assert.equal(calls.readComment.length, 0, "a body passed on the request must not re-read the comment");
});

test("a body-absent event reads the comment through the adapter by its canonical id", async () => {
  const question = "@reviewer-bot why is the cache key installation-scoped?";
  const { adapter, calls } = makeAdapter({ readCommentBody: question });
  const prompts: string[] = [];
  const consumer = makeConsumer(adapter, {
    answer: async (prompt) => {
      prompts.push(prompt);
      return "because the installation token is scoped to it";
    },
  });
  const event = commentEvent(question);
  assert.equal(event.eventReference, "555");
  const outcome = await consumer.handleEvent(event);
  assert.deepEqual(outcome, { status: "answered", posted: true });
  assert.deepEqual(calls.readComment, [["o/r", "555"]], "readComment is called with the canonical comment id");
  assert.match(prompts[0]!, /why is the cache key installation-scoped/);
});

test("an unauthorized actor is ignored; answer and post never run", async () => {
  let answerCalls = 0;
  const { adapter, calls } = makeAdapter({
    permission: { permission: "read", roleName: "", subject: "absent" },
    postCommentThrows: true,
  });
  const consumer = makeConsumer(adapter, {
    answer: async () => {
      answerCalls += 1;
      throw new Error("model work must not run for an unauthorized actor");
    },
  });
  const outcome = await consumer.handleEvent(
    commentEvent("@reviewer-bot hello"),
    "@reviewer-bot hello",
  );
  assert.deepEqual(outcome, { status: "ignored", reason: "unauthorized" });
  assert.equal(answerCalls, 0);
  assert.equal(calls.postComment.length, 0);
});

test("an explicit rereview command mints the exact-head review generation and enqueues it once", async () => {
  const { adapter, calls } = makeAdapter({ resolveHeadSha: RESOLVED_HEAD });
  const enqueued: ReviewJob[] = [];
  const consumer = makeConsumer(adapter, {
    enqueueRereviewJob: async (job) => {
      enqueued.push(job);
      return true;
    },
  });
  const outcome = await consumer.handleEvent(commentEvent("/ai-review"), "/ai-review");
  assert.deepEqual(outcome, { status: "rereview", disposition: "enqueued" });
  assert.equal(calls.resolveHeadSha, 1, "a comment payload's empty head is resolved through the adapter");
  assert.equal(calls.postComment.length, 0, "a rereview never posts a comment");
  assert.equal(calls.fetchThreadComments, 0, "a rereview never builds answer context");
  assert.equal(enqueued.length, 1);
  const job = enqueued[0]!;
  assert.equal(job.kind, "review");
  assert.equal(job.headSha, RESOLVED_HEAD);
  assert.equal(job.reason, "rereview_label");
  assert.equal(job.eventReference, "", "a review job's identity never carries the comment id");
  assert.equal(job.repoFullName, "o/r");
  assert.equal(job.prNumber, 7);
});

test("a rereview event that already carries a head is not re-resolved", async () => {
  const { adapter, calls } = makeAdapter({
    resolveHeadSha: "ffffffffffffffffffffffffffffffffffffffff",
  });
  const enqueued: ReviewJob[] = [];
  const consumer = makeConsumer(adapter, {
    enqueueRereviewJob: async (job) => {
      enqueued.push(job);
      return true;
    },
  });
  const event = { ...commentEvent("/ai-review"), headSha: RESOLVED_HEAD };
  const outcome = await consumer.handleEvent(event, "/ai-review");
  assert.deepEqual(outcome, { status: "rereview", disposition: "enqueued" });
  assert.equal(calls.resolveHeadSha, 0, "a carried head is never re-resolved");
  assert.equal(enqueued[0]!.headSha, RESOLVED_HEAD);
});

test("a second rereview of the same head under a different comment dedupes without re-enqueueing", async () => {
  const { adapter } = makeAdapter({ resolveHeadSha: RESOLVED_HEAD });
  const ledger = new MemoryGenerationLedger();
  const enqueued: ReviewJob[] = [];
  const consumer = makeConsumer(adapter, {
    ledger,
    enqueueRereviewJob: async (job) => {
      enqueued.push(job);
      return true;
    },
  });
  const first = await consumer.handleEvent(commentEvent("/ai-review", "alice", 555), "/ai-review");
  const second = await consumer.handleEvent(commentEvent("/ai-review", "alice", 556), "/ai-review");
  assert.deepEqual(first, { status: "rereview", disposition: "enqueued" });
  assert.deepEqual(second, { status: "rereview", disposition: "duplicate" });
  assert.equal(enqueued.length, 1, "one head+config review generation is enqueued once");
  assert.equal(await ledger.has(enqueued[0]!.jobId), true);
});

test("a rereview with an unresolvable head is refused before any ledger reservation", async () => {
  for (const options of [{ resolveHeadSha: null }, { resolveHeadShaThrows: true }] as const) {
    const { adapter } = makeAdapter(options);
    const ledger = new RecordingLedger();
    let enqueueCalls = 0;
    const consumer = makeConsumer(adapter, {
      ledger,
      enqueueRereviewJob: async () => {
        enqueueCalls += 1;
        throw new Error("must not enqueue an unresolvable head");
      },
    });
    const outcome = await consumer.handleEvent(commentEvent("/ai-review"), "/ai-review");
    assert.deepEqual(outcome, { status: "rereview", disposition: "refused" });
    assert.equal(ledger.addIfAbsentCalls.length, 0, "no generation is minted without a provable exact head");
    assert.equal(ledger.removed.length, 0);
    assert.equal(enqueueCalls, 0);
  }
});

test("a failed enqueue handoff releases the minted reservation", async () => {
  const { adapter } = makeAdapter({ resolveHeadSha: RESOLVED_HEAD });
  const ledger = new RecordingLedger();
  const consumer = makeConsumer(adapter, {
    ledger,
    enqueueRereviewJob: async () => false,
  });
  const outcome = await consumer.handleEvent(commentEvent("/ai-review"), "/ai-review");
  assert.deepEqual(outcome, { status: "rereview", disposition: "refused" });
  assert.equal(ledger.addIfAbsentCalls.length, 1);
  assert.deepEqual(ledger.removed, ledger.addIfAbsentCalls, "the reservation is released with the minted id");
  assert.equal(await ledger.has(ledger.addIfAbsentCalls[0]!), false, "released, so a redelivery can re-mint");
});

test("a throwing enqueue handoff releases the minted reservation too", async () => {
  const { adapter } = makeAdapter({ resolveHeadSha: RESOLVED_HEAD });
  const ledger = new RecordingLedger();
  const consumer = makeConsumer(adapter, {
    ledger,
    enqueueRereviewJob: async () => {
      throw new Error("queue down");
    },
  });
  const outcome = await consumer.handleEvent(commentEvent("/ai-review"), "/ai-review");
  assert.deepEqual(outcome, { status: "rereview", disposition: "refused" });
  assert.equal(ledger.addIfAbsentCalls.length, 1);
  assert.deepEqual(ledger.removed, ledger.addIfAbsentCalls);
  assert.equal(await ledger.has(ledger.addIfAbsentCalls[0]!), false);
});

test("a Forgejo comment rereview mints the same exact-head generation shape", async () => {
  const { adapter, calls } = makeAdapter({ resolveHeadSha: RESOLVED_HEAD });
  const enqueued: ReviewJob[] = [];
  const consumer = makeConsumer(adapter, {
    enqueueRereviewJob: async (job) => {
      enqueued.push(job);
      return true;
    },
  });
  const outcome = await consumer.handleEvent(forgejoCommentEvent("/ai-review"), "/ai-review");
  assert.deepEqual(outcome, { status: "rereview", disposition: "enqueued" });
  assert.equal(calls.resolveHeadSha, 1);
  const job = enqueued[0]!;
  assert.equal(job.kind, "review");
  assert.equal(job.platform, "forgejo");
  assert.equal(job.headSha, RESOLVED_HEAD);
  assert.equal(job.reason, "rereview_label");
  assert.equal(job.eventReference, "");
});

test("action/operator parity: one event + fixtures yields a byte-identical prompt and plan", async () => {
  const question = "@reviewer-bot what happens when the mirror fetch is interrupted?";
  const thread = [
    { id: 11, user: { login: "alice" }, created_at: "2024-01-01T00:00:00Z", body: "context A" },
    { id: 12, user: { login: "bob" }, created_at: "2024-01-01T01:00:00Z", body: "context B" },
  ];
  const managed = "<!-- ai-pr-reviewer -->\n## Findings\n- one finding";
  const editedAt = "2024-01-02T00:00:00Z";
  const { adapter } = makeAdapter({
    threadComments: thread,
    managedReview: managed,
    prLastEditedAt: editedAt,
  });
  const event = commentEvent(question);

  // The operator host (this module).
  let hostPrompt = "";
  const consumer = makeConsumer(adapter, {
    answer: async (prompt) => {
      hostPrompt = prompt;
      return "it resumes from the last fetched ref";
    },
  });
  const outcome = await consumer.handleEvent(event, question);

  // The Action path: the SAME shared planner, the SAME fixtures.
  const deps: FollowUpPlanDeps = {
    clock: () => 1_000_000,
    botLogin: BOT,
    readPermission: (login) => adapter.readPermission(event.repoFullName, login),
    rateLimitStore: new InMemoryRateLimitStore(),
    fetchThreadComments: () => adapter.fetchThreadComments(event.repoFullName, event.prNumber),
    latestManagedReview: () => adapter.latestManagedReview!(event.repoFullName, event.prNumber),
    prLastEditedAt: () => adapter.prLastEditedAt!(event.repoFullName, event.prNumber),
  };
  const config: FollowUpPlanConfig = {
    rereviewCommand: REREVIEW_COMMAND,
    mentionHandles: MENTION_HANDLES,
    rateLimit: DEFAULT_FOLLOW_UP_RATE_LIMITS,
  };
  const plan = await planFollowUp({ event, body: question }, deps, config);

  assert.equal(plan.action, "answer");
  assert.deepEqual(outcome, { status: "answered", posted: true });
  assert.equal(hostPrompt, plan.prompt, "the two hosts must build byte-identical prompts for the same event");
});
