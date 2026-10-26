import test from "node:test";
import assert from "node:assert/strict";
import { planFollowUp, type FollowUpPlanConfig, type FollowUpPlanDeps } from "../src/followup/plan.js";
import { InMemoryRateLimitStore } from "../src/followup/rate-limit.js";
import { normalizeForgejoEvent, normalizeGitHubEvent, type CanonicalForgeEvent } from "../src/events/index.js";
import type { AuthorityReading } from "../src/precheck/comment-authority.js";

// #763: the shared follow-up planner. It consumes only a canonical `follow_up`
// event plus injected forge capabilities, so the Action path and the operator
// path get the SAME plan — proved below by feeding both normalizers' events for
// the same comment. No verdict ever rides on an answer.

const HEAD = "abc1234def5678abc1234def5678abcdef0123";

function ghEvent(body: string, user = "alice"): CanonicalForgeEvent {
  const e = normalizeGitHubEvent({
    name: "issue_comment",
    action: "created",
    repository: { full_name: "o/r" },
    installation: { id: 1 },
    issue: { number: 7, pull_request: { head: { sha: HEAD, repo: { full_name: "o/r" } }, base: { sha: "def5678abcd", repo: { full_name: "o/r" } } } },
    comment: { id: 555, user: { login: user }, body },
    sender: { login: user },
  });
  assert.ok(e !== null, "fixture event must normalize");
  return e;
}

function forgejoEvent(body: string, user = "alice"): CanonicalForgeEvent {
  const e = normalizeForgejoEvent({
    event: "comment",
    action: "created",
    repository: { full_name: "o/r" },
    issue: { number: 7, pull_request: { head: { sha: HEAD, repo: { full_name: "o/r" } }, base: { sha: "def5678abcd", repo: { full_name: "o/r" } } } },
    comment: { id: 555, user: { login: user }, body },
    sender: { login: user },
  });
  assert.ok(e !== null, "fixture event must normalize");
  return e;
}

const CONFIG: FollowUpPlanConfig = {
  rereviewCommand: "/ai-review",
  mentionHandles: ["reviewer-bot"],
  rateLimit: { perPr: { limit: 6, windowMs: 60_000 }, perActor: { limit: 4, windowMs: 60_000 } },
};

const ALLOW: AuthorityReading = { permission: "write", roleName: "", subject: "absent" };

function deps(overrides: Partial<FollowUpPlanDeps> = {}): FollowUpPlanDeps {
  return {
    clock: () => 1_000_000,
    botLogin: "reviewer-bot",
    readPermission: async () => ALLOW,
    rateLimitStore: new InMemoryRateLimitStore(),
    fetchThreadComments: async () => [],
    ...overrides,
  };
}

test("kind guard: a non-follow_up event is ignored", async () => {
  const opened = { ...ghEvent("hi"), kind: "pr_opened" as const };
  const plan = await planFollowUp({ event: opened, body: "hi" }, deps(), CONFIG);
  assert.deepEqual(plan, { action: "ignore", reason: "not-follow-up" });
});

test("an authorized mention yields a bounded discussion answer, never a verdict", async () => {
  const plan = await planFollowUp({ event: ghEvent("@reviewer-bot why line 42?"), body: "@reviewer-bot why line 42?" }, deps(), CONFIG);
  assert.equal(plan.action, "answer");
  assert.ok(plan.action === "answer");
  assert.equal(plan.inReplyToCommentId, "555");
  assert.equal("verdict" in plan, false, "an answer plan carries no verdict-bearing field");
  assert.match(plan.prompt, /discussion answer, NOT a review verdict/);
  assert.match(plan.prompt, /why line 42/);
  assert.match(plan.prompt, new RegExp(HEAD), "the prompt carries the current head");
  assert.match(plan.prompt, /Repository: o\/r/);
  assert.match(plan.prompt, /Pull request: #7/);
});

test("unauthorized actor is refused and consumes no rate budget", async () => {
  const store = new InMemoryRateLimitStore();
  const plan = await planFollowUp(
    { event: ghEvent("@reviewer-bot hello"), body: "@reviewer-bot hello" },
    deps({ readPermission: async () => ({ permission: "read", roleName: "", subject: "absent" }), rateLimitStore: store }),
    CONFIG,
  );
  assert.deepEqual(plan, { action: "ignore", reason: "unauthorized" });
  assert.equal(store.countInWindow("pr:github:o/r#7", 60_000, 1_000_000), 0);
});

test("an unproven permission (null) fails closed as permission-unknown", async () => {
  const plan = await planFollowUp(
    { event: ghEvent("@reviewer-bot hello"), body: "@reviewer-bot hello" },
    deps({ readPermission: async () => null }),
    CONFIG,
  );
  assert.deepEqual(plan, { action: "ignore", reason: "permission-unknown" });
});

test("a permission lookup that throws fails closed as permission-unknown", async () => {
  const plan = await planFollowUp(
    { event: ghEvent("@reviewer-bot hello"), body: "@reviewer-bot hello" },
    deps({ readPermission: async () => { throw new Error("403"); } }),
    CONFIG,
  );
  assert.deepEqual(plan, { action: "ignore", reason: "permission-unknown" });
});

test("the reviewer's own comment is dropped before any authority lookup", async () => {
  let lookups = 0;
  const plan = await planFollowUp(
    { event: ghEvent("@reviewer-bot self", "reviewer-bot"), body: "@reviewer-bot self" },
    deps({ readPermission: async () => { lookups += 1; return ALLOW; } }),
    CONFIG,
  );
  assert.deepEqual(plan, { action: "ignore", reason: "bot-author" });
  assert.equal(lookups, 0);
});

test("a managed review body is dropped even from a foreign author", async () => {
  const plan = await planFollowUp(
    { event: ghEvent("@reviewer-bot <!-- ai-pr-reviewer -->"), body: "@reviewer-bot <!-- ai-pr-reviewer -->" },
    deps(),
    CONFIG,
  );
  assert.deepEqual(plan, { action: "ignore", reason: "managed-body" });
});

test("an unaddressed comment never reaches the authority lookup", async () => {
  let lookups = 0;
  const plan = await planFollowUp(
    { event: ghEvent("looks fine to me"), body: "looks fine to me" },
    deps({ readPermission: async () => { lookups += 1; return ALLOW; } }),
    CONFIG,
  );
  assert.deepEqual(plan, { action: "ignore", reason: "not-addressed" });
  assert.equal(lookups, 0);
});

test("an explicit re-review command hands back to the normal review pipeline", async () => {
  let threadFetched = false;
  const plan = await planFollowUp(
    { event: ghEvent("/ai-review"), body: "/ai-review" },
    deps({ fetchThreadComments: async () => { threadFetched = true; return []; } }),
    CONFIG,
  );
  assert.deepEqual(plan, { action: "rereview" });
  assert.equal(threadFetched, false, "a re-review does not build an answer context");
});

test("a re-review from an unauthorized actor is refused (never forces a review)", async () => {
  const plan = await planFollowUp(
    { event: ghEvent("/ai-review"), body: "/ai-review" },
    deps({ readPermission: async () => ({ permission: "read", roleName: "", subject: "absent" }) }),
    CONFIG,
  );
  assert.deepEqual(plan, { action: "ignore", reason: "unauthorized" });
});

test("the per-PR rate budget stops follow-up work", async () => {
  const config: FollowUpPlanConfig = { ...CONFIG, rateLimit: { perPr: { limit: 1, windowMs: 60_000 }, perActor: { limit: 4, windowMs: 60_000 } } };
  const store = new InMemoryRateLimitStore();
  const first = await planFollowUp({ event: ghEvent("@reviewer-bot a"), body: "@reviewer-bot a" }, deps({ rateLimitStore: store }), config);
  const second = await planFollowUp({ event: ghEvent("@reviewer-bot b"), body: "@reviewer-bot b" }, deps({ rateLimitStore: store }), config);
  assert.equal(first.action, "answer");
  assert.deepEqual(second, { action: "ignore", reason: "rate-limited" });
});

test("an explicit rereview is NOT bound by the open-ended Q&A budget (#763)", async () => {
  // Exhaust the per-PR Q&A budget, then the maintainer's explicit command must
  // still hand back to the normal review pipeline (its own admission governs).
  const config: FollowUpPlanConfig = { ...CONFIG, rateLimit: { perPr: { limit: 1, windowMs: 60_000 }, perActor: { limit: 4, windowMs: 60_000 } } };
  const store = new InMemoryRateLimitStore();
  const first = await planFollowUp({ event: ghEvent("@reviewer-bot a"), body: "@reviewer-bot a" }, deps({ rateLimitStore: store }), config);
  const second = await planFollowUp({ event: ghEvent("@reviewer-bot b"), body: "@reviewer-bot b" }, deps({ rateLimitStore: store }), config);
  assert.equal(first.action, "answer");
  assert.deepEqual(second, { action: "ignore", reason: "rate-limited" });
  // Budget exhausted for questions, yet the explicit rereview still passes.
  const rereview = await planFollowUp({ event: ghEvent("/ai-review"), body: "/ai-review" }, deps({ rateLimitStore: store }), config);
  assert.deepEqual(rereview, { action: "rereview" });
});

test("an unreadable follow-up body is source-unavailable (fail closed)", async () => {
  // No request body and no readComment.
  assert.deepEqual(await planFollowUp({ event: ghEvent("@reviewer-bot hi") }, deps(), CONFIG), { action: "ignore", reason: "source-unavailable" });
  // readComment returns empty.
  const plan = await planFollowUp(
    { event: ghEvent("@reviewer-bot hi") },
    deps({ readComment: async () => "" }),
    CONFIG,
  );
  assert.deepEqual(plan, { action: "ignore", reason: "source-unavailable" });
  // readComment supplies the body → answer (operator mode).
  const answered = await planFollowUp(
    { event: ghEvent("@reviewer-bot hi") },
    deps({ readComment: async () => "@reviewer-bot hi there" }),
    CONFIG,
  );
  assert.equal(answered.action, "answer");
});

test("a failing thread read still answers (degrades to a smaller prompt)", async () => {
  const plan = await planFollowUp(
    { event: ghEvent("@reviewer-bot hi"), body: "@reviewer-bot hi" },
    deps({ fetchThreadComments: async () => { throw new Error("read failed"); } }),
    CONFIG,
  );
  assert.equal(plan.action, "answer");
});

test("the Action event and the operator canonical event produce the SAME answer", async () => {
  const store = new InMemoryRateLimitStore();
  const question = "@reviewer-bot does this fix the null check?";
  const baseDeps = () => deps({ rateLimitStore: store, fetchThreadComments: async () => [
    { id: 1, user: { login: "alice" }, created_at: "2024-01-01T00:00:00Z", body: "context" },
  ], latestManagedReview: async () => "<!-- ai-pr-reviewer -->\n## Findings\n- issue" });
  const fromGitHub = await planFollowUp({ event: ghEvent(question), body: question }, baseDeps(), CONFIG);
  const fromForgejo = await planFollowUp({ event: forgejoEvent(question), body: question }, baseDeps(), CONFIG);
  assert.equal(fromGitHub.action, "answer");
  assert.equal(fromForgejo.action, "answer");
  assert.ok(fromGitHub.action === "answer" && fromForgejo.action === "answer");
  assert.equal(fromGitHub.prompt, fromForgejo.prompt, "adapter-local payload differences must not leak into the shared prompt");
  assert.equal(fromGitHub.inReplyToCommentId, fromForgejo.inReplyToCommentId);
});
