import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { createOperatorHost } from "../src/ingress/index.js";
import { computeForgejoWebhookSignature } from "../src/ingress/signature.js";
import { MemoryGenerationLedger } from "../src/ingress/dispatch.js";
import type {
  FollowUpConsumerOptions,
  FollowUpForgeAdapter,
} from "../src/ingress/followup-host.js";
import type { CanonicalForgeEvent } from "../src/events/index.js";
import { FOLLOWUP_REPLY_MARKER } from "../src/followup/classify.js";
import { InMemoryRateLimitStore } from "../src/followup/rate-limit.js";
import type { AuthorityReading } from "../src/precheck/comment-authority.js";

// #1294: the operator-mode ingress PRODUCTION HOST — the in-repo production
// caller of the operator event router. It constructs the router (and with it
// the follow-up consumer) UNCONDITIONALLY and binds it into the Forgejo
// webhook handler, so an operator daemon gets a fully-wired ingress it cannot
// mis-bind. The single router owns every canonical event the handler accepts:
// `follow_up` through the handler's router branch, every other kind through
// onEvent -> the router -> the dispatch seam (or `ignored` with no seam).
//
// No network beyond the local loopback harness, no sleeps: every forge
// read/write goes through the injected adapter fake, and the seams the
// question path must never touch throw.

const SECRET = "whsec_test_secret_0123456789abcdef";
const BOT = "reviewer-bot";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const QUESTION = "@reviewer-bot how many times does the mirror fetch retry?";
const ANSWER = "it retries three times, then gives up";

// ── fixtures ────────────────────────────────────────────────────────────────

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
  postComment: [string, number, string][];
}
/** Recording forge-adapter fake. The actor is AUTHORIZED (an `admin`
 * reading for any login). The seams the QUESTION path must never touch
 * (head resolution, PR identity — the re-review path) THROW, so a routing
 * regression that reaches for them fails loudly. */
function makeAdapter(commentBody: string): {
  adapter: FollowUpForgeAdapter;
  calls: AdapterCalls;
} {
  const calls: AdapterCalls = {
    readPermission: [],
    readComment: [],
    fetchThreadComments: 0,
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

/** The operator follow-up host configuration the daemon binds; overrides win.
 * `answerCalls` counts the model seam invocations so a test can pin ONE plan
 * (and therefore one model call) per event directly, not only through the
 * posted-reply count. */
function makeFollowUpOptions(
  adapter: FollowUpForgeAdapter,
  overrides: Partial<FollowUpConsumerOptions> = {},
  answerCalls: { n: number } = { n: 0 },
): FollowUpConsumerOptions {
  return {
    adapter,
    botLogin: async () => BOT,
    clock: () => 1_000_000,
    rateLimitStore: new InMemoryRateLimitStore(),
    rereviewCommand: "/ai-review",
    mentionHandles: [BOT],
    answer: async () => {
      answerCalls.n += 1;
      return ANSWER;
    },
    ledger: new MemoryGenerationLedger(),
    ...overrides,
  };
}

// ── http harness ────────────────────────────────────────────────────────────

interface TestHandler {
  url: string;
  close: () => Promise<void>;
}

/** Install the host's BOUND handler (the host is the binding under test —
 * the test never constructs a router or a webhook handler itself). */
async function startTestHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestHandler> {
  const server: Server = createServer(handler);
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

// ── 1. the host itself is the binding: a follow-up is consumed end to end ──

test("a signed follow_up delivery is consumed end to end by the host — no router option exists to supply", async (t) => {
  const { adapter, calls } = makeAdapter(QUESTION);
  const answerCalls = { n: 0 };
  const host = createOperatorHost({
    secret: SECRET,
    followUp: makeFollowUpOptions(adapter, {}, answerCalls),
  });
  const h = await startTestHandler(host.handler);
  t.after(() => h.close());

  const body = JSON.stringify(makeForgejoCommentPayload(QUESTION));
  const res = await post(h.url, {
    event: "issue_comment",
    eventType: "pull_request_comment",
    body,
  });

  assert.equal(res.status, 202, "an authorized follow-up delivery is accepted");
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "follow_up" });
  assert.equal(answerCalls.n, 1, "exactly one plan, so exactly one model call");
  assert.deepEqual(
    calls.readComment,
    [["org/repo", "55"]],
    "the operator lane reads the comment body by its canonical id",
  );
  assert.equal(calls.postComment.length, 1, "exactly one posted reply");
  assert.ok(
    calls.postComment[0]![2].startsWith(FOLLOWUP_REPLY_MARKER),
    "the posted body is the marker-stamped rendered reply",
  );
  assert.deepEqual(calls.postComment[0]!.slice(0, 2), ["org/repo", 7]);
});

// ── 2. non-follow-up deliveries reach the dispatch seam ────────────────────

test("a non-follow-up delivery reaches the dispatch seam with the canonical event", async (t) => {
  const { adapter, calls } = makeAdapter(QUESTION);
  const dispatched: CanonicalForgeEvent[] = [];
  const host = createOperatorHost({
    secret: SECRET,
    followUp: makeFollowUpOptions(adapter),
    dispatch: (event) => {
      dispatched.push(event);
    },
  });
  const h = await startTestHandler(host.handler);
  t.after(() => h.close());

  const body = JSON.stringify(makeForgejoSyncPayload());
  const res = await post(h.url, { event: "pull_request", body });

  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "synchronize" });
  assert.equal(dispatched.length, 1, "exactly one dispatch-seam call");
  const ev = dispatched[0]!;
  assert.equal(ev.kind, "synchronize", "the canonical kind");
  assert.equal(ev.platform, "forgejo");
  assert.equal(ev.source, "webhook");
  assert.equal(ev.repoFullName, "org/repo");
  assert.equal(ev.prNumber, 7);
  assert.equal(ev.prId, 700);
  assert.equal(ev.headSha, HEAD_SHA);
  assert.equal(ev.baseSha, BASE_SHA);
  assert.equal(ev.actor, "octo");
  assert.equal(calls.readComment.length, 0, "the follow-up consumer is never entered");
  assert.equal(calls.postComment.length, 0);
});

// ── 3. error posture: a rejecting dispatch yields the handler's fixed 500 ──

test("a rejecting dispatch seam yields the fixed 500 with no error text echoed", async (t) => {
  const { adapter } = makeAdapter(QUESTION);
  const host = createOperatorHost({
    secret: SECRET,
    followUp: makeFollowUpOptions(adapter),
    // The daemon's scheduler seam rejects — the caller owns retry/redelivery;
    // the response must stay the fixed body.
    dispatch: () => {
      throw new Error("scheduler down");
    },
  });
  const h = await startTestHandler(host.handler);
  t.after(() => h.close());

  const body = JSON.stringify(makeForgejoSyncPayload());
  const res = await post(h.url, { event: "pull_request", body });

  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.text), { status: "internal error" });
  assert.ok(!res.text.includes("scheduler down"), "error text must not be echoed");
  assert.ok(!res.text.includes(SECRET), "the secret must not be echoed");
});

// ── 4. consumption is not opt-in: it works without a dispatch seam ─────────

test("with no dispatch seam a non-follow-up delivery is still accepted and follow-up consumption still works", async (t) => {
  const { adapter, calls } = makeAdapter(QUESTION);
  const host = createOperatorHost({
    secret: SECRET,
    followUp: makeFollowUpOptions(adapter),
  });
  const h = await startTestHandler(host.handler);
  t.after(() => h.close());

  // A non-follow-up delivery with no seam: accepted (the router reports it
  // `ignored`; nothing is scheduled), and it must not touch the consumer.
  const syncRes = await post(h.url, {
    event: "pull_request",
    body: JSON.stringify(makeForgejoSyncPayload()),
  });
  assert.equal(syncRes.status, 202, "a seam-less non-follow-up delivery is still accepted");
  assert.deepEqual(JSON.parse(syncRes.text), { status: "accepted", kind: "synchronize" });
  assert.equal(calls.postComment.length, 0, "the consumer is not entered for a non-follow-up");

  // A follow-up delivery on the SAME host: consumed, proving consumption is
  // not opt-in (it needs no dispatch seam at all).
  const questionRes = await post(h.url, {
    event: "issue_comment",
    eventType: "pull_request_comment",
    body: JSON.stringify(makeForgejoCommentPayload(QUESTION)),
  });
  assert.equal(questionRes.status, 202);
  assert.deepEqual(JSON.parse(questionRes.text), { status: "accepted", kind: "follow_up" });
  assert.equal(calls.postComment.length, 1, "the consumer posted exactly one reply");
  assert.ok(calls.postComment[0]![2].startsWith(FOLLOWUP_REPLY_MARKER));
});
