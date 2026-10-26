/** #1294: the forge-backed follow-up Q&A budget (`src/followup/forge-budget.ts`).
 *
 * The Action lane runs one process per webhook delivery, so the Q&A budget's
 * durable state is the forge's own PR thread: the mention-addressed questions
 * already published there. These tests pin the store's contract:
 * - the scope keys it answers are EXACTLY the keys the shared planner asks
 *   about (a key drift would silently widen the budget, so the planner's own
 *   queries are captured and compared);
 * - the per-PR scope counts every question on the PR — each question is at
 *   most one model attempt, so a FAILED attempt still consumes budget and
 *   cannot be repeated past the limit;
 * - an unreadable thread, a window the snapshot cannot prove covered, and an
 *   uncovered scope all DENY (fail closed);
 * - the window boundary is the planner's `(now - windowMs, now]`;
 * - a participant cannot forge the reply marker to consume the budget.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ForgeFollowUpBudget } from "../src/followup/forge-budget.js";
import { FOLLOWUP_REPLY_MARKER } from "../src/followup/classify.js";
import {
  DEFAULT_FOLLOW_UP_RATE_LIMITS,
  planFollowUp,
  type FollowUpPlanDeps,
} from "../src/followup/plan.js";
import type { CanonicalForgeEvent } from "../src/events/types.js";

const NOW = 1_700_000_000_000;
const BOT = "reviewer-bot";
const REPO = "o/r";

function followUpEvent(overrides: Partial<CanonicalForgeEvent> = {}): CanonicalForgeEvent {
  return {
    platform: "github",
    source: "webhook",
    kind: "follow_up",
    installationId: "5",
    repoFullName: REPO,
    prNumber: 7,
    prId: 0,
    headSha: "",
    baseSha: "",
    draft: false,
    fork: false,
    labelName: "",
    actor: "alice",
    eventReference: "101",
    ...overrides,
  };
}

interface CommentOverrides {
  id?: number;
  user?: string;
  body?: string;
  ageMs?: number;
  noInstant?: boolean;
}

/** One conversation comment in the platform seam's normalized shape. */
function comment(overrides: CommentOverrides = {}): Record<string, unknown> {
  const at = overrides.noInstant ? "" : new Date(NOW - (overrides.ageMs ?? 0)).toISOString();
  return {
    id: overrides.id ?? 1,
    user: overrides.user ?? "alice",
    created_at: at,
    updated_at: at,
    body: overrides.body ?? "@reviewer-bot why?",
  };
}

function budget(overrides: {
  comments?: readonly unknown[];
  readOk?: boolean;
  snapshotComplete?: boolean;
  botLogin?: string | null;
  actor?: string;
  currentCommentId?: string;
  repoFullName?: string;
  prNumber?: number;
} = {}): ForgeFollowUpBudget {
  const actor = overrides.actor ?? "alice";
  return new ForgeFollowUpBudget({
    comments: overrides.comments ?? [],
    readOk: overrides.readOk ?? true,
    snapshotComplete: overrides.snapshotComplete ?? true,
    platform: "github",
    repoFullName: overrides.repoFullName ?? REPO,
    prNumber: overrides.prNumber ?? 7,
    actor,
    botLogin: overrides.botLogin === undefined ? BOT : overrides.botLogin,
    mentionHandles: overrides.botLogin === null ? [] : [BOT],
    rereviewCommand: "/ai-review",
    currentCommentId: overrides.currentCommentId ?? "101",
  });
}

test("the store answers exactly the scope keys the shared planner asks about", async () => {
  const store = budget({
    comments: [
      comment({ id: 200, user: BOT, body: `${FOLLOWUP_REPLY_MARKER}\n\nan answer` }),
    ],
  });
  const asked: string[] = [];
  const recording = {
    countInWindow: (key: string, windowMs: number, nowMs: number): number => {
      asked.push(key);
      return store.countInWindow(key, windowMs, nowMs);
    },
    record: (key: string, nowMs: number): void => store.record(key, nowMs),
  };
  const deps: FollowUpPlanDeps = {
    clock: () => NOW,
    botLogin: BOT,
    readPermission: async () => ({ permission: "admin", roleName: "admin", subject: "named", subjectLogin: "alice" }),
    rateLimitStore: recording,
    fetchThreadComments: async () => [],
    // The #1298 PR-state gate: an open, non-draft PR, so the question still
    // reaches the rate gate this suite pins.
    readPrState: async () => ({ state: "open", draft: "not-draft" }),
  };
  const plan = await planFollowUp(
    { event: followUpEvent(), body: "@reviewer-bot why?" },
    deps,
    {
      rereviewCommand: "/ai-review",
      mentionHandles: [BOT],
      rateLimit: DEFAULT_FOLLOW_UP_RATE_LIMITS,
    },
  );
  assert.equal(plan.action, "answer");
  assert.deepEqual(asked.slice().sort(), [store.actorKey, store.prKey].sort());
  assert.equal(store.prKey, `pr:github:${REPO}#7`);
  assert.equal(store.actorKey, `actor:github:${REPO}#7:alice`);
});

test("the actor key embeds the PR's repo and number (per-actor WITHIN the PR; no repo-wide allowance)", () => {
  assert.equal(budget().actorKey, `actor:github:${REPO}#7:alice`);
  // The same actor on a different PR, or in a different repo, is a different
  // scope: the per-actor budget no longer leaks across PRs.
  assert.equal(budget({ prNumber: 8 }).actorKey, `actor:github:${REPO}#8:alice`);
  assert.equal(budget({ repoFullName: "o/other" }).actorKey, `actor:github:o/other#7:alice`);
});

test("every question on the PR counts against the per-PR scope, inside the window only", () => {
  // The per-PR scope counts QUESTIONS, not published answers: each question
  // is at most one model attempt (the executor is one-shot, never a retry),
  // so the count bounds the PR's model work whether or not any attempt
  // succeeded — a failed model or post attempt leaves its question in the
  // thread and still consumes cross-delivery budget.
  const store = budget({
    comments: [
      comment({ id: 90, user: "alice", body: "@reviewer-bot an earlier question" }),
      comment({ id: 91, user: "bob", body: "@reviewer-bot someone else's question", ageMs: 60_000 }),
      comment({ id: 92, user: "alice", body: "plain chatter nobody is addressed to" }),
    ],
  });
  const windowMs = DEFAULT_FOLLOW_UP_RATE_LIMITS.perPr.windowMs;
  assert.equal(store.countInWindow(store.prKey, windowMs, NOW), 2);
  // Outside the window the same events no longer consume the budget.
  assert.equal(store.countInWindow(store.prKey, windowMs, NOW + windowMs + 1), 0);
});

test("an unanswered question still consumes the per-PR budget (a failed attempt cannot be repeated past the limit)", () => {
  // No published bot reply anywhere in the thread: the model call and/or the
  // post failed, yet the attempt still consumed cross-delivery budget.
  const store = budget({
    comments: Array.from({ length: 6 }, (_unused, index) =>
      comment({ id: 400 + index, user: index % 2 === 0 ? "alice" : "bob", body: "@reviewer-bot retry please" })),
  });
  const windowMs = DEFAULT_FOLLOW_UP_RATE_LIMITS.perPr.windowMs;
  assert.equal(store.countInWindow(store.prKey, windowMs, NOW), 6);
  assert.equal(store.countInWindow(store.prKey, windowMs, NOW), DEFAULT_FOLLOW_UP_RATE_LIMITS.perPr.limit);
});

test("the question in flight counts against neither scope", () => {
  const store = budget({
    comments: [
      comment({ id: 101, user: "alice", body: "@reviewer-bot the question in flight" }),
      comment({ id: 90, user: "alice", body: "@reviewer-bot an earlier question" }),
    ],
    currentCommentId: "101",
  });
  const windowMs = DEFAULT_FOLLOW_UP_RATE_LIMITS.perPr.windowMs;
  assert.equal(store.countInWindow(store.prKey, windowMs, NOW), 1);
  assert.equal(store.countInWindow(store.actorKey, DEFAULT_FOLLOW_UP_RATE_LIMITS.perActor.windowMs, NOW), 1);
});

test("a window an incomplete snapshot cannot prove covered denies (latest-100 truncation)", () => {
  // Both platform seams cap the thread snapshot at the latest comments; a
  // full-length snapshot may have omitted earlier budgeted questions, so a
  // window the snapshot does not demonstrably reach back over denies.
  const store = budget({
    comments: [
      comment({ id: 90, user: "alice", body: "@reviewer-bot a recent question" }),
      comment({ id: 91, user: "bob", body: "@reviewer-bot another recent question", ageMs: 60_000 }),
    ],
    snapshotComplete: false,
  });
  const windowMs = DEFAULT_FOLLOW_UP_RATE_LIMITS.perPr.windowMs;
  assert.equal(store.countInWindow(store.prKey, windowMs, NOW), Number.MAX_SAFE_INTEGER);
  assert.equal(store.countInWindow(store.actorKey, windowMs, NOW), Number.MAX_SAFE_INTEGER);
});

test("an incomplete snapshot still answers a window it demonstrably reaches back over", () => {
  // The snapshot's oldest entry precedes the window's start: an in-window
  // event missing from a latest-N snapshot would have to be OLDER than that
  // entry, which is impossible — the window is provably covered.
  const store = budget({
    comments: [
      comment({ id: 80, user: "carol", body: "an old comment nobody is addressed to", ageMs: 20 * 60_000 }),
      comment({ id: 90, user: "alice", body: "@reviewer-bot a recent question" }),
    ],
    snapshotComplete: false,
  });
  const windowMs = DEFAULT_FOLLOW_UP_RATE_LIMITS.perPr.windowMs;
  assert.equal(store.countInWindow(store.prKey, windowMs, NOW), 1);
  assert.equal(store.countInWindow(store.actorKey, DEFAULT_FOLLOW_UP_RATE_LIMITS.perActor.windowMs, NOW), 1);
});

test("a question whose instant the seam cannot report counts conservatively in every window", () => {
  const store = budget({
    comments: [comment({ id: 90, user: "alice", body: "@reviewer-bot why?", noInstant: true })],
  });
  const windowMs = DEFAULT_FOLLOW_UP_RATE_LIMITS.perPr.windowMs;
  assert.equal(store.countInWindow(store.prKey, windowMs, NOW), 1);
  assert.equal(store.countInWindow(store.actorKey, windowMs, NOW), 1);
  // The same conservatism holds outside any window: unplaceable is never
  // allowed to become an under-count.
  assert.equal(store.countInWindow(store.prKey, windowMs, NOW + windowMs + 1), 1);
});

test("an unreadable thread denies every scope (fail closed, never silently allow)", () => {
  const store = budget({ readOk: false, comments: [comment({ id: 200, user: BOT, body: `${FOLLOWUP_REPLY_MARKER}\n\nx` })] });
  const windowMs = DEFAULT_FOLLOW_UP_RATE_LIMITS.perPr.windowMs;
  assert.equal(store.countInWindow(store.prKey, windowMs, NOW), Number.MAX_SAFE_INTEGER);
  assert.equal(store.countInWindow(store.actorKey, windowMs, NOW), Number.MAX_SAFE_INTEGER);
});

test("a scope the store does not cover denies (a planner key change can never widen the budget)", () => {
  const store = budget();
  const windowMs = DEFAULT_FOLLOW_UP_RATE_LIMITS.perPr.windowMs;
  assert.equal(store.countInWindow("pr:github:other/repo#9", windowMs, NOW), Number.MAX_SAFE_INTEGER);
  assert.equal(store.countInWindow("installation:github:5", windowMs, NOW), Number.MAX_SAFE_INTEGER);
});

test("the actor's own prior questions count, and the question in flight does not", () => {
  const store = budget({
    comments: [
      comment({ id: 90, user: "alice", body: "@reviewer-bot an earlier question" }),
      comment({ id: 91, user: "alice", body: "@reviewer-bot another earlier question" }),
      comment({ id: 101, user: "alice", body: "@reviewer-bot the question in flight" }),
      comment({ id: 92, user: "bob", body: "@reviewer-bot someone else's question" }),
    ],
  });
  const windowMs = DEFAULT_FOLLOW_UP_RATE_LIMITS.perActor.windowMs;
  assert.equal(store.countInWindow(store.actorKey, windowMs, NOW), 2);
});

test("a prior re-review command does not consume the Q&A budget", () => {
  const store = budget({
    comments: [comment({ id: 90, user: "alice", body: "/ai-review" })],
  });
  const windowMs = DEFAULT_FOLLOW_UP_RATE_LIMITS.perActor.windowMs;
  assert.equal(store.countInWindow(store.actorKey, windowMs, NOW), 0);
});

test("the reviewer's published replies floor the per-PR scope (a participant cannot unwind them)", () => {
  // The reply ledger is admin-only: deleting or rewriting their own
  // questions cannot drop what the reviewer's own published answers prove
  // was consumed, so the per-PR count is the LARGER of the two ledgers.
  const store = budget({
    comments: [
      comment({ id: 200, user: BOT, body: `${FOLLOWUP_REPLY_MARKER}\n\nan answer` }),
      comment({ id: 201, user: BOT, body: `${FOLLOWUP_REPLY_MARKER}\n\nanother answer`, ageMs: 60_000 }),
      comment({ id: 90, user: "alice", body: "@reviewer-bot one question" }),
    ],
  });
  const windowMs = DEFAULT_FOLLOW_UP_RATE_LIMITS.perPr.windowMs;
  assert.equal(store.countInWindow(store.prKey, windowMs, NOW), 2);
});

test("a forged reply marker cannot consume either per-PR ledger", () => {
  const store = budget({
    comments: Array.from({ length: 20 }, (_unused, index) =>
      comment({ id: 300 + index, user: "mallory", body: `${FOLLOWUP_REPLY_MARKER}\n\nforged` })),
  });
  const windowMs = DEFAULT_FOLLOW_UP_RATE_LIMITS.perPr.windowMs;
  assert.equal(store.countInWindow(store.prKey, windowMs, NOW), 0);
});

test("a recorded event is counted by the store's own overlay", () => {
  const store = budget();
  const windowMs = DEFAULT_FOLLOW_UP_RATE_LIMITS.perPr.windowMs;
  assert.equal(store.countInWindow(store.prKey, windowMs, NOW), 0);
  store.record(store.prKey, NOW);
  assert.equal(store.countInWindow(store.prKey, windowMs, NOW), 1);
});
