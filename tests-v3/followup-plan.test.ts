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

function ghEvent(body: string, user = "alice", repoPr?: { repo?: string; pr?: number }): CanonicalForgeEvent {
  const repo = repoPr?.repo ?? "o/r";
  const pr = repoPr?.pr ?? 7;
  const e = normalizeGitHubEvent({
    name: "issue_comment",
    action: "created",
    repository: { full_name: repo },
    installation: { id: 1 },
    issue: { number: pr, pull_request: { head: { sha: HEAD, repo: { full_name: repo } }, base: { sha: "def5678abcd", repo: { full_name: repo } } } },
    comment: { id: 555, user: { login: user }, body },
    sender: { login: user },
  });
  assert.ok(e !== null, "fixture event must normalize");
  return e;
}

/** A hand-built canonical event (operator-mode shape): bypasses the
 * normalizer's lowercasing, so casing hardening must happen in the planner. */
function canonicalFollowUp(overrides: Partial<CanonicalForgeEvent> = {}): CanonicalForgeEvent {
  return {
    platform: "github",
    source: "webhook",
    kind: "follow_up",
    installationId: "5",
    repoFullName: "o/r",
    prNumber: 7,
    prId: 0,
    headSha: HEAD,
    baseSha: "",
    draft: false,
    fork: false,
    labelName: "",
    actor: "alice",
    eventReference: "101",
    ...overrides,
  };
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
    readPrState: async () => ({ state: "open", draft: "not-draft" }),
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

test("the per-actor budget is per-actor WITHIN the PR, not repo-wide (#1294)", async () => {
  const config: FollowUpPlanConfig = { ...CONFIG, rateLimit: { perPr: { limit: 6, windowMs: 60_000 }, perActor: { limit: 1, windowMs: 60_000 } } };
  const store = new InMemoryRateLimitStore();
  const d = () => deps({ rateLimitStore: store });
  // Same actor, same PR: the first question is allowed, the second is not.
  const first = await planFollowUp({ event: ghEvent("@reviewer-bot q1"), body: "@reviewer-bot q1" }, d(), config);
  const second = await planFollowUp({ event: ghEvent("@reviewer-bot q2"), body: "@reviewer-bot q2" }, d(), config);
  assert.equal(first.action, "answer");
  assert.deepEqual(second, { action: "ignore", reason: "rate-limited" });
  // Same actor, a different PR: a fresh per-actor-within-PR scope allows it.
  const otherPr = await planFollowUp(
    { event: ghEvent("@reviewer-bot q3", "alice", { pr: 8 }), body: "@reviewer-bot q3" },
    d(),
    config,
  );
  assert.equal(otherPr.action, "answer");
  // Same actor, a different repo: likewise a fresh scope.
  const otherRepo = await planFollowUp(
    { event: ghEvent("@reviewer-bot q4", "alice", { repo: "o/other" }), body: "@reviewer-bot q4" },
    d(),
    config,
  );
  assert.equal(otherRepo.action, "answer");
  // A different actor on the original PR is independent: alice's scope is
  // exhausted but bob's fresh per-actor-within-PR scope still allows.
  const otherActor = await planFollowUp({ event: ghEvent("@reviewer-bot q5", "bob"), body: "@reviewer-bot q5" }, d(), config);
  assert.equal(otherActor.action, "answer");
});

test("a hand-built event cannot split one PR's actor budget by casing", async () => {
  const config: FollowUpPlanConfig = { ...CONFIG, rateLimit: { perPr: { limit: 6, windowMs: 60_000 }, perActor: { limit: 1, windowMs: 60_000 } } };
  const store = new InMemoryRateLimitStore();
  const d = () => deps({ rateLimitStore: store });
  // Normalized webhook shape (lowercase at the event boundary): allowed.
  const first = await planFollowUp({ event: ghEvent("@reviewer-bot q1"), body: "@reviewer-bot q1" }, d(), config);
  assert.equal(first.action, "answer");
  // Hand-built canonical event with mixed case: the planner's lowercase makes
  // it the SAME repo/PR/actor scopes, so it is rate-limited, not fresh.
  const cased = await planFollowUp(
    { event: canonicalFollowUp({ repoFullName: "O/R", actor: "Alice" }), body: "@reviewer-bot q2" },
    d(),
    config,
  );
  assert.deepEqual(cased, { action: "ignore", reason: "rate-limited" });
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

// #1298: the PR-state gate mirrors the shipped comment-command refusals
// (`comment-pr-closed` / `comment-pr-draft`) for the Q&A lane: a closed/merged
// or draft PR spends no model work and posts no reply, on EITHER host, from a
// capability reading — never a payload sniff.
test("#1298: a question on a closed PR is ignored and consumes no budget", async () => {
  const store = new InMemoryRateLimitStore();
  let threadFetched = false;
  const plan = await planFollowUp(
    { event: ghEvent("@reviewer-bot still relevant?"), body: "@reviewer-bot still relevant?" },
    deps({ rateLimitStore: store, readPrState: async () => ({ state: "closed", draft: "not-draft" }), fetchThreadComments: async () => { threadFetched = true; return []; } }),
    CONFIG,
  );
  assert.deepEqual(plan, { action: "ignore", reason: "pr-closed" });
  assert.equal(store.countInWindow("pr:github:o/r#7", 60_000, 1_000_000), 0, "a dead lane consumes no Q&A budget");
  assert.equal(threadFetched, false, "a refused question builds no answer context");
});

test("#1298: a question on a draft PR is ignored", async () => {
  const plan = await planFollowUp(
    { event: ghEvent("@reviewer-bot thoughts?"), body: "@reviewer-bot thoughts?" },
    deps({ readPrState: async () => ({ state: "open", draft: "draft" }) }),
    CONFIG,
  );
  assert.deepEqual(plan, { action: "ignore", reason: "pr-draft" });
});

test("#1298: an unproven PR state fails closed — no answer on uncertainty", async () => {
  const cases: Array<{
    readPrState: () => Promise<{ state: "open" | "closed" | "unknown"; draft: "draft" | "not-draft" | "unknown" }>;
    reason: "pr-state-unknown" | "pr-draft-unknown";
  }> = [
    { readPrState: async () => ({ state: "unknown", draft: "unknown" }), reason: "pr-state-unknown" },
    { readPrState: async () => ({ state: "unknown", draft: "not-draft" }), reason: "pr-state-unknown" },
    // #1310: an unprovable draft is a distinct refusal from an unprovable
    // open/closed state, so an operator can tell the two apart.
    { readPrState: async () => ({ state: "open", draft: "unknown" }), reason: "pr-draft-unknown" },
    { readPrState: async () => { throw new Error("pr lookup failed"); }, reason: "pr-state-unknown" },
  ];
  for (const { readPrState, reason } of cases) {
    const plan = await planFollowUp(
      { event: ghEvent("@reviewer-bot ping"), body: "@reviewer-bot ping" },
      deps({ readPrState }),
      CONFIG,
    );
    assert.deepEqual(plan, { action: "ignore", reason });
  }
});

test("#1298: the gate runs only for questions — never before authority, never for a re-review", async () => {
  let stateReads = 0;
  const counting = async () => { stateReads += 1; return { state: "closed" as const, draft: "not-draft" as const }; };
  // Unauthorized: refused on authority, the state is never consulted.
  const unauthorized = await planFollowUp(
    { event: ghEvent("@reviewer-bot hello"), body: "@reviewer-bot hello" },
    deps({ readPermission: async () => ({ permission: "read", roleName: "", subject: "absent" }), readPrState: counting }),
    CONFIG,
  );
  assert.deepEqual(unauthorized, { action: "ignore", reason: "unauthorized" });
  // Unaddressed comment: intent guard outranks everything, no state read.
  const unaddressed = await planFollowUp(
    { event: ghEvent("looks fine"), body: "looks fine" },
    deps({ readPrState: counting }),
    CONFIG,
  );
  assert.deepEqual(unaddressed, { action: "ignore", reason: "not-addressed" });
  // Explicit re-review: its admission stays the review pipeline's own (#1294),
  // so even a closed PR's command hands back unchanged, without a state read.
  const rereview = await planFollowUp(
    { event: ghEvent("/ai-review"), body: "/ai-review" },
    deps({ readPrState: counting }),
    CONFIG,
  );
  assert.deepEqual(rereview, { action: "rereview" });
  assert.equal(stateReads, 0, "only a planned question reaches the PR-state gate");
});
