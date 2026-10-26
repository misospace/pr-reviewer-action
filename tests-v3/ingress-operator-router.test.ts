import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createOperatorEventRouter } from "../src/ingress/index.js";
import {
  createForgejoWebhookHandler,
  type ForgejoWebhookHandlerOptions,
} from "../src/ingress/webhook-handler.js";
import { computeForgejoWebhookSignature } from "../src/ingress/signature.js";
import { MemoryGenerationLedger } from "../src/ingress/dispatch.js";
import type {
  FollowUpConsumerOptions,
  FollowUpForgeAdapter,
} from "../src/ingress/followup-host.js";
import { normalizeForgejoEvent, type CanonicalForgeEvent } from "../src/events/index.js";
import { FOLLOWUP_REPLY_MARKER } from "../src/followup/classify.js";
import { InMemoryRateLimitStore } from "../src/followup/rate-limit.js";
import type { AuthorityReading } from "../src/precheck/comment-authority.js";
import type { PrStateReading } from "../src/platform/pr.js";

// #1299: the operator-mode event router — the PRODUCTION BINDING that makes
// the self-hosted operator CONSUME the canonical `follow_up` event instead of
// only forwarding it. The router builds the follow-up consumer (the shared
// planner + the operator-mode effects), routes `follow_up` to it, and routes
// every other canonical event to the injected dispatch seam. The Forgejo
// webhook ingress routes a `follow_up` delivery to the router instead of to
// `onEvent`, so the canonical follow-up event reaches the consumer end to end.
//
// No network, no sleeps: every forge read/write goes through the injected
// adapter fake, and the seams the question path must never touch throw.

const SECRET = "whsec_test_secret_0123456789abcdef";
const BOT = "reviewer-bot";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const QUESTION = "@reviewer-bot how many times does the mirror fetch retry?";
const ANSWER = "it retries three times, then gives up";

// ── fixtures ────────────────────────────────────────────────────────────────

/** A canonical `follow_up` event from the Forgejo native comment envelope. */
function followUpEvent(body: string): CanonicalForgeEvent {
  const event = normalizeForgejoEvent({
    event: "comment",
    action: "created",
    repository: { full_name: "org/repo" },
    issue: { number: 7, pull_request: { url: "https://forge.example/org/repo/pulls/7" } },
    comment: { id: 55, user: { login: "dev" }, body },
    sender: { login: "dev" },
  });
  assert.ok(event !== null, "the fixture comment payload must normalize");
  assert.equal(event.kind, "follow_up");
  assert.equal(event.eventReference, "55");
  assert.equal(event.actor, "dev");
  return event;
}

/** A canonical NON-follow-up event (a PR synchronization). */
function synchronizeEvent(): CanonicalForgeEvent {
  const event = normalizeForgejoEvent({
    event: "pull_request",
    action: "synchronize",
    repository: { full_name: "org/repo" },
    pull_request: {
      number: 7,
      id: 700,
      head: { sha: HEAD_SHA, repo: { full_name: "org/repo" } },
      base: { sha: BASE_SHA, repo: { full_name: "org/repo" } },
    },
    sender: { login: "octo" },
  });
  assert.ok(event !== null, "the fixture PR payload must normalize");
  assert.equal(event.kind, "synchronize");
  return event;
}

/** A REAL native Forgejo PR-comment delivery: the PR sits on a TOP-LEVEL
 * `pull_request` object with `issue` and `comment` as siblings (the shape the
 * ingress projection documents). */
function makeForgejoCommentPayload(body: string): Record<string, unknown> {
  return {
    action: "created",
    repository: { full_name: "org/repo" },
    comment: { id: 55, user: { login: "dev" }, body },
    issue: { number: 7, title: "a PR" },
    pull_request: {
      number: 7,
      id: 700,
      head: { sha: HEAD_SHA, repo: { full_name: "org/repo" } },
      base: { sha: BASE_SHA, repo: { full_name: "org/repo" } },
    },
    sender: { login: "dev" },
  };
}

/** A REAL native Forgejo PR-synchronization delivery. */
function makeForgejoSyncPayload(): Record<string, unknown> {
  return {
    action: "synchronized",
    repository: { full_name: "org/repo" },
    pull_request: {
      number: 7,
      id: 700,
      head: { sha: HEAD_SHA, repo: { full_name: "org/repo" } },
      base: { sha: BASE_SHA, repo: { full_name: "org/repo" } },
    },
    sender: { login: "octo" },
  };
}

interface AdapterCalls {
  readPermission: string[];
  readComment: [string, string][];
  fetchThreadComments: number;
  readPrState: [string, number][];
  postComment: [string, number, string][];
}

/** Recording forge-adapter fake. The seams the QUESTION path must never
 * touch (head resolution, PR identity — the re-review path) THROW, so a
 * routing regression that reaches for them fails loudly. The PR-state
 * reading defaults to open + non-draft so the question path stays
 * answerable. */
function makeAdapter(commentBody: string, prState: PrStateReading = { state: "open", draft: "not-draft" }): {
  adapter: FollowUpForgeAdapter;
  calls: AdapterCalls;
} {
  const calls: AdapterCalls = {
    readPermission: [],
    readComment: [],
    fetchThreadComments: 0,
    readPrState: [],
    postComment: [],
  };
  const admin: AuthorityReading = { permission: "admin", roleName: "", subject: "absent" };
  const adapter: FollowUpForgeAdapter = {
    async readPermission(_repoFullName, login) {
      calls.readPermission.push(login);
      return admin;
    },
    async readComment(repoFullName, commentId) {
      calls.readComment.push([repoFullName, commentId]);
      return commentBody;
    },
    async fetchThreadComments() {
      calls.fetchThreadComments += 1;
      return [];
    },
    async readPrState(repoFullName, prNumber) {
      calls.readPrState.push([repoFullName, prNumber]);
      return prState;
    },
    async latestManagedReview() {
      return "";
    },
    async postComment(repoFullName, prNumber, body) {
      calls.postComment.push([repoFullName, prNumber, body]);
      return true;
    },
    async resolveHeadSha() {
      throw new Error("a question must never resolve a head (the re-review path)");
    },
    async resolvePrIdentity() {
      throw new Error("a question must never resolve a PR identity (the re-review path)");
    },
  };
  return { adapter, calls };
}

/** The operator follow-up host configuration the daemon binds; overrides win. */
function makeFollowUpOptions(
  adapter: FollowUpForgeAdapter,
  overrides: Partial<FollowUpConsumerOptions> = {},
): FollowUpConsumerOptions {
  return {
    adapter,
    botLogin: async () => BOT,
    clock: () => 1_000_000,
    rateLimitStore: new InMemoryRateLimitStore(),
    rereviewCommand: "/ai-review",
    mentionHandles: [BOT],
    answer: async () => ANSWER,
    ledger: new MemoryGenerationLedger(),
    ...overrides,
  };
}

// ── http harness ────────────────────────────────────────────────────────────

interface TestHandler {
  url: string;
  close: () => Promise<void>;
}

async function startTestHandler(options: ForgejoWebhookHandlerOptions): Promise<TestHandler> {
  const server: Server = createServer(createForgejoWebhookHandler(options));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface PostOptions {
  event: string;
  eventType?: string;
  body: string;
}

async function post(
  url: string,
  opts: PostOptions,
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { "x-gitea-event": opts.event };
  if (opts.eventType !== undefined) headers["x-gitea-event-type"] = opts.eventType;
  headers["x-gitea-signature"] = computeForgejoWebhookSignature(SECRET, opts.body);
  const res = await fetch(url, { method: "POST", headers, body: opts.body });
  return { status: res.status, text: await res.text() };
}

// ── 1. the router drives the follow-up consumer ─────────────────────────────

test("a canonical follow_up event reaches the follow-up consumer: one answer, one posted reply, no dispatch", async () => {
  const { adapter, calls } = makeAdapter(QUESTION);
  const prompts: string[] = [];
  const dispatched: CanonicalForgeEvent[] = [];
  const router = createOperatorEventRouter({
    followUp: makeFollowUpOptions(adapter, {
      answer: async (prompt) => {
        prompts.push(prompt);
        return ANSWER;
      },
    }),
    dispatch: (event) => {
      dispatched.push(event);
    },
  });

  const outcome = await router.handleEvent(followUpEvent(QUESTION));

  assert.deepEqual(outcome, {
    kind: "follow-up",
    outcome: { status: "answered", posted: true },
  });
  assert.equal(prompts.length, 1, "exactly one model answer per follow-up event");
  assert.match(prompts[0]!, /how many times does the mirror fetch retry/);
  assert.equal(calls.postComment.length, 1, "exactly one posted reply");
  assert.equal(
    calls.postComment[0]![2],
    `${FOLLOWUP_REPLY_MARKER}\n\n${ANSWER}`,
    "the posted body is the marker-stamped rendered reply",
  );
  assert.deepEqual(
    calls.readComment,
    [["org/repo", "55"]],
    "the operator lane reads the comment body by its canonical id",
  );
  assert.deepEqual(calls.postComment[0]!.slice(0, 2), ["org/repo", 7]);
  assert.equal(dispatched.length, 0, "a follow-up never reaches the review scheduler");
});

test("a closed-PR follow_up is reported as the consumer's own ignore outcome; the router invents no policy", async () => {
  const { adapter, calls } = makeAdapter(QUESTION, { state: "closed", draft: "not-draft" });
  const dispatched: CanonicalForgeEvent[] = [];
  const router = createOperatorEventRouter({
    followUp: makeFollowUpOptions(adapter),
    dispatch: (event) => {
      dispatched.push(event);
    },
  });

  const outcome = await router.handleEvent(followUpEvent(QUESTION));

  assert.deepEqual(outcome, { kind: "follow-up", outcome: { status: "ignored", reason: "pr-closed" } });
  assert.equal(calls.postComment.length, 0, "no reply for a dead lane");
  assert.deepEqual(
    calls.readPrState,
    [["org/repo", 7]],
    "the gate read the PR state once, through the injected capability with the event's coordinates",
  );
  assert.equal(dispatched.length, 0, "an ignored follow-up never reaches the review scheduler");
});

test("a non-follow-up canonical event goes to dispatch and never to the follow-up consumer", async () => {
  const { adapter, calls } = makeAdapter(QUESTION);
  const dispatched: CanonicalForgeEvent[] = [];
  const router = createOperatorEventRouter({
    followUp: makeFollowUpOptions(adapter, {
      answer: async () => {
        throw new Error("model work must not run for a non-follow-up event");
      },
    }),
    dispatch: (event) => {
      dispatched.push(event);
    },
  });

  const outcome = await router.handleEvent(synchronizeEvent());

  assert.deepEqual(outcome, { kind: "dispatched" });
  assert.deepEqual(dispatched.map((ev) => ev.kind), ["synchronize"]);
  assert.equal(calls.readComment.length, 0, "the consumer is never entered");
  assert.equal(calls.postComment.length, 0);
});

test("without a dispatch seam a non-follow-up event is reported as ignored, never scheduled", async () => {
  const { adapter, calls } = makeAdapter(QUESTION);
  const router = createOperatorEventRouter({
    followUp: makeFollowUpOptions(adapter),
  });

  const outcome = await router.handleEvent(synchronizeEvent());

  assert.deepEqual(outcome, { kind: "ignored" });
  assert.equal(calls.postComment.length, 0);
});

// ── 2. the production binding through the Forgejo ingress ──────────────────

test("production binding: a Forgejo comment delivery is consumed by the follow-up consumer through the router", async (t) => {
  const { adapter, calls } = makeAdapter(QUESTION);
  const onEventCalls: CanonicalForgeEvent[] = [];
  const router = createOperatorEventRouter({
    followUp: makeFollowUpOptions(adapter),
  });
  const h = await startTestHandler({
    secret: SECRET,
    onEvent: (ev) => {
      onEventCalls.push(ev);
    },
    router,
  });
  t.after(() => h.close());

  const body = JSON.stringify(makeForgejoCommentPayload(QUESTION));
  const res = await post(h.url, {
    event: "issue_comment",
    eventType: "pull_request_comment",
    body,
  });

  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "follow_up" });
  assert.equal(onEventCalls.length, 0, "the router owns the follow-up delivery; onEvent must not see it");
  assert.equal(calls.postComment.length, 1, "the consumer posted exactly one reply");
  assert.equal(
    calls.postComment[0]![2],
    `${FOLLOWUP_REPLY_MARKER}\n\n${ANSWER}`,
    "the posted body is the marker-stamped rendered reply",
  );
  assert.deepEqual(calls.readComment, [["org/repo", "55"]]);
});

test("without a router the handler still forwards the same delivery to onEvent and never touches the consumer", async (t) => {
  const { calls } = makeAdapter(QUESTION);
  const onEventCalls: CanonicalForgeEvent[] = [];
  const h = await startTestHandler({
    secret: SECRET,
    onEvent: (ev) => {
      onEventCalls.push(ev);
    },
  });
  t.after(() => h.close());

  const body = JSON.stringify(makeForgejoCommentPayload(QUESTION));
  const res = await post(h.url, {
    event: "issue_comment",
    eventType: "pull_request_comment",
    body,
  });

  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "follow_up" });
  assert.equal(onEventCalls.length, 1, "the pre-router behavior is unchanged");
  assert.equal(onEventCalls[0]!.kind, "follow_up");
  assert.equal(calls.postComment.length, 0, "no consumer is built without a router");
  assert.equal(calls.readComment.length, 0);
});

// ── 3. error posture: a throwing dispatch propagates ───────────────────────

test("a throwing dispatch propagates to the caller: the router rejects and the handler answers a fixed 500", async (t) => {
  const { adapter } = makeAdapter(QUESTION);
  // The daemon's scheduler seam: the SAME function the handler forwards to and
  // the router dispatches to. It rejects — the caller owns retry/redelivery.
  const scheduler = (): void => {
    throw new Error("scheduler down");
  };
  const router = createOperatorEventRouter({
    followUp: makeFollowUpOptions(adapter),
    dispatch: scheduler,
  });
  const h = await startTestHandler({
    secret: SECRET,
    // The router is the daemon's single event entry point: every event the
    // handler forwards lands on it.
    onEvent: async (ev) => {
      await router.handleEvent(ev);
    },
    router,
  });
  t.after(() => h.close());

  // The router does not swallow the rejection.
  await assert.rejects(() => router.handleEvent(synchronizeEvent()), /scheduler down/);

  const body = JSON.stringify(makeForgejoSyncPayload());
  const res = await post(h.url, { event: "pull_request", body });

  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.text), { status: "internal error" });
  assert.ok(!res.text.includes("scheduler down"), "error text must not be echoed");
  assert.ok(!res.text.includes(SECRET), "the secret must not be echoed");
});
