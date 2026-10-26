import test from "node:test";
import assert from "node:assert/strict";
import { runActionFollowUp, type ActionFollowUpDeps } from "../src/run/followup-action.js";
import { FOLLOWUP_REPLY_MARKER } from "../src/followup/classify.js";
import {
  DEFAULT_FOLLOW_UP_RATE_LIMITS,
  planFollowUp,
  type FollowUpPlanConfig,
  type FollowUpPlanDeps,
} from "../src/followup/plan.js";
import { InMemoryRateLimitStore } from "../src/followup/rate-limit.js";
import { normalizeForgeEvent } from "../src/events/index.js";
import { authorityReadingFromPayload } from "../src/precheck/comment-authority.js";
import { FOLLOWUP_ANSWER_MAX_BYTES, type FollowUpRunOutcome } from "../src/followup/controller.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";

// #1294: the Action-mode follow-up host. Events are built through the REAL
// normalizer from full GitHub / Forgejo `issue_comment` payloads (the
// `{ url }`-only `issue.pull_request` object GitHub actually sends), and every
// forge / model touch is stubbed — no test performs a network call, and any
// unexpected read seam call throws, so a test that reaches a seam the host
// must not use fails loudly.

const REPO = "o/r";
const BOT_LOGIN = "reviewer-bot";
const NOW = 1_000_000;

/** A full GitHub `issue_comment` webhook payload (the real shape). */
function ghCommentPayload(body: string, user = "alice"): Record<string, unknown> {
  return {
    name: "issue_comment",
    action: "created",
    issue: { number: 7, pull_request: { url: "https://api.github.com/repos/o/r/pulls/7" } },
    comment: { id: 101, body, user: { login: user } },
    repository: { full_name: REPO },
    installation: { id: 5 },
  };
}

/** A full Forgejo `comment` webhook payload (GitHub-compatible shape). */
function forgejoCommentPayload(body: string, user = "alice"): Record<string, unknown> {
  return {
    event: "comment",
    action: "created",
    issue: { number: 7, pull_request: { url: "https://forge.example.invalid/api/v1/repos/o/r/pulls/7" } },
    comment: { id: 101, body, user: { login: user } },
    repository: { full_name: REPO },
    installation: { id: 5 },
  };
}

function githubStage(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PLATFORM: "github",
    GITHUB_SERVER_URL: "https://github.com",
    REPO,
    PR_NUMBER: "7",
    GH_TOKEN: "tok",
    AI_PRIMARY_BASE_URL: "https://llm.example.invalid/v1",
    AI_PRIMARY_MODEL: "test-model",
    ...overrides,
  };
}

function forgejoStage(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PLATFORM: "forgejo",
    GITHUB_SERVER_URL: "https://forge.example.invalid",
    FORGEJO_API_URL: "https://forge.example.invalid",
    FORGEJO_TOKEN: "tok",
    REPO,
    PR_NUMBER: "7",
    AI_PRIMARY_BASE_URL: "https://llm.example.invalid/v1",
    AI_PRIMARY_MODEL: "test-model",
    ...overrides,
  };
}

interface StubAdapterOptions {
  platform?: "github" | "forgejo";
  /** The run's own authenticated identity; null when unproven. */
  botLogin?: string | null;
  /** The raw `data` the collaborator-permission `ghApi` probe returns. */
  permissionData?: unknown;
  /** When set, the permission probe reports this error instead. */
  permissionError?: string;
  /** PR-conversation comments for the answer thread context. */
  conversation?: { ok: true; data: unknown[] } | { ok: false; error: string };
}

/** Read-adapter stub: only the seams the follow-up host may call are
 * functional; every other seam throws, so an unexpected read fails the test. */
function stubReadAdapter(options: StubAdapterOptions = {}): PlatformReadAdapter {
  const unexpected = (name: string) => async (): Promise<never> => {
    throw new Error(`unexpected read seam call: ${name}`);
  };
  return {
    platform: options.platform ?? "github",
    getPr: unexpected("getPr"),
    getPrDiff: unexpected("getPrDiff"),
    listIssueComments: async () => [],
    listPrReviews: async () => [],
    authenticatedIdentity: async () => options.botLogin ?? null,
    repoPermission: unexpected("repoPermission"),
    ghApi: async (endpoint: string) => {
      if (!endpoint.includes("/collaborators/") || !endpoint.endsWith("/permission")) {
        throw new Error(`unexpected ghApi endpoint: ${endpoint}`);
      }
      return options.permissionError !== undefined
        ? { error: options.permissionError }
        : { data: options.permissionData ?? null };
    },
    listPrFiles: unexpected("listPrFiles"),
    getIssue: unexpected("getIssue"),
    listPrConversationComments: async () => options.conversation ?? { ok: true, data: [] },
    listReviewThreads: unexpected("listReviewThreads"),
    listPrReviewsPaginated: unexpected("listPrReviewsPaginated"),
    externalChecks: unexpected("externalChecks"),
  };
}

interface EffectRecs {
  answers: string[];
  posts: string[];
}

function followUpDeps(
  adapter: PlatformReadAdapter,
  recs: EffectRecs,
  overrides: {
    store?: InMemoryRateLimitStore;
    clock?: () => number;
    answer?: (prompt: string) => Promise<string>;
    postComment?: (body: string) => Promise<boolean>;
  } = {},
): ActionFollowUpDeps {
  return {
    readAdapter: adapter,
    clock: overrides.clock ?? (() => NOW),
    rateLimitStore: overrides.store ?? new InMemoryRateLimitStore(),
    answer: overrides.answer ?? (async (prompt: string) => {
      recs.answers.push(prompt);
      return "stub answer";
    }),
    postComment: overrides.postComment ?? (async (body: string) => {
      recs.posts.push(body);
      return true;
    }),
  };
}

/** Deps WITHOUT an explicit rate-limit store, so the host's DEFAULT budget
 *  (the forge-backed cross-delivery budget over the PR thread) is the one
 *  under test. */
function defaultBudgetDeps(
  adapter: PlatformReadAdapter,
  recs: EffectRecs,
  overrides: {
    clock?: () => number;
    answer?: (prompt: string) => Promise<string>;
    postComment?: (body: string) => Promise<boolean>;
  } = {},
): Partial<ActionFollowUpDeps> {
  return {
    readAdapter: adapter,
    clock: overrides.clock ?? (() => NOW),
    answer: overrides.answer ?? (async (prompt: string) => {
      recs.answers.push(prompt);
      return "stub answer";
    }),
    postComment: overrides.postComment ?? (async (body: string) => {
      recs.posts.push(body);
      return true;
    }),
  };
}

/** Deps where every callable throws — proves a call path was never reached. */
function throwingDeps(): ActionFollowUpDeps {
  const t = (name: string) => async (): Promise<never> => {
    throw new Error(`unexpected ${name} call`);
  };
  return {
    readAdapter: {
      platform: "github",
      getPr: t("getPr"),
      getPrDiff: t("getPrDiff"),
      listIssueComments: t("listIssueComments"),
      listPrReviews: t("listPrReviews"),
      authenticatedIdentity: t("authenticatedIdentity"),
      repoPermission: t("repoPermission"),
      ghApi: t("ghApi"),
      listPrFiles: t("listPrFiles"),
      getIssue: t("getIssue"),
      listPrConversationComments: t("listPrConversationComments"),
      listReviewThreads: t("listReviewThreads"),
      listPrReviewsPaginated: t("listPrReviewsPaginated"),
      externalChecks: t("externalChecks"),
    },
    postComment: t("postComment"),
    answer: t("answer"),
    clock: (): number => {
      throw new Error("unexpected clock call");
    },
    rateLimitStore: {
      countInWindow: (): number => {
        throw new Error("unexpected countInWindow call");
      },
      record: (): void => {
        throw new Error("unexpected record call");
      },
    },
  };
}

function followUpOutcome(result: { route: string; outcome?: FollowUpRunOutcome }): FollowUpRunOutcome {
  if (result.route !== "follow-up" || result.outcome === undefined) {
    throw new Error(`expected route "follow-up" with an outcome, got: ${result.route}`);
  }
  return result.outcome;
}

test("an authorized mention is answered once and posted exactly once, marker-stamped", async () => {
  const question = "@reviewer-bot why is line 42 a null check?";
  const recs: EffectRecs = { answers: [], posts: [] };
  const result = await runActionFollowUp(
    githubStage(),
    ghCommentPayload(question),
    followUpDeps(
      stubReadAdapter({ botLogin: BOT_LOGIN, permissionData: { permission: "admin", user: { login: "alice" } } }),
      recs,
    ),
  );
  assert.equal(result.route, "follow-up");
  assert.deepEqual(followUpOutcome(result), { status: "answered", posted: true });
  assert.equal(recs.answers.length, 1);
  assert.match(recs.answers[0] ?? "", /why is line 42 a null check/);
  assert.equal(recs.posts.length, 1);
  const posted = recs.posts[0] ?? "";
  assert.ok(posted.startsWith(FOLLOWUP_REPLY_MARKER));
  assert.match(posted, /stub answer/);
});

test("an unauthorized actor is ignored; the model and the write seam are never called", async () => {
  const recs: EffectRecs = { answers: [], posts: [] };
  const result = await runActionFollowUp(
    githubStage(),
    ghCommentPayload("@reviewer-bot hello"),
    followUpDeps(
      stubReadAdapter({ botLogin: BOT_LOGIN, permissionData: { permission: "read", user: { login: "alice" } } }),
      recs,
    ),
  );
  assert.deepEqual(followUpOutcome(result), { status: "ignored", reason: "unauthorized" });
  assert.equal(recs.answers.length, 0);
  assert.equal(recs.posts.length, 0);
});

test("the reviewer's own follow-up reply is dropped by the loop guard, no effects", async () => {
  const recs: EffectRecs = { answers: [], posts: [] };
  const body = `${FOLLOWUP_REPLY_MARKER}\n\n@reviewer-bot and one more?`;
  const result = await runActionFollowUp(
    githubStage(),
    ghCommentPayload(body),
    followUpDeps(
      stubReadAdapter({ botLogin: BOT_LOGIN, permissionData: { permission: "admin", user: { login: "alice" } } }),
      recs,
    ),
  );
  assert.deepEqual(followUpOutcome(result), { status: "ignored", reason: "managed-body" });
  assert.equal(recs.answers.length, 0);
  assert.equal(recs.posts.length, 0);
});

test("an exhausted per-PR budget is ignored without model or post work", async () => {
  const recs: EffectRecs = { answers: [], posts: [] };
  const store = new InMemoryRateLimitStore();
  for (let i = 0; i < DEFAULT_FOLLOW_UP_RATE_LIMITS.perPr.limit; i += 1) {
    store.record(`pr:github:${REPO}#7`, NOW);
  }
  const result = await runActionFollowUp(
    githubStage(),
    ghCommentPayload("@reviewer-bot one more question?"),
    followUpDeps(
      stubReadAdapter({ botLogin: BOT_LOGIN, permissionData: { permission: "admin", user: { login: "alice" } } }),
      recs,
      { store, clock: () => NOW },
    ),
  );
  assert.deepEqual(followUpOutcome(result), { status: "ignored", reason: "rate-limited" });
  assert.equal(recs.answers.length, 0);
  assert.equal(recs.posts.length, 0);
});

test("the Q&A budget survives a delivery: the questions earlier deliveries left in the thread deny the next question", async () => {
  // The regression this pins: the Action runs ONE PROCESS PER DELIVERY, so an
  // in-memory budget handed every delivery a fresh budget. The budget state
  // is the forge's own thread — the questions earlier deliveries planned (and
  // the answers they published) are still there, and the next delivery must
  // see them.
  const firstRecs: EffectRecs = { answers: [], posts: [] };
  const first = await runActionFollowUp(
    githubStage(),
    ghCommentPayload("@reviewer-bot why is line 42 a null check?"),
    defaultBudgetDeps(
      stubReadAdapter({ botLogin: BOT_LOGIN, permissionData: { permission: "admin", user: { login: "alice" } } }),
      firstRecs,
    ),
  );
  assert.equal(followUpOutcome(first).status, "answered");
  assert.equal(firstRecs.posts.length, 1);
  const published = firstRecs.posts[0]!;

  // The NEXT delivery — a fresh process, a fresh store — sees the PR's
  // question traffic in the thread and must not answer another question. The
  // per-PR scope counts every question whatever author posted it (each
  // question is at most one model attempt), so six questions from DIFFERENT
  // actors exhaust it while the per-actor scope alone would not.
  const others = ["bob", "carol", "dave", "erin", "frank"];
  const secondRecs: EffectRecs = { answers: [], posts: [] };
  const second = await runActionFollowUp(
    githubStage(),
    ghCommentPayload("@reviewer-bot and what about line 43?"),
    defaultBudgetDeps(
      stubReadAdapter({
        botLogin: BOT_LOGIN,
        permissionData: { permission: "admin", user: { login: "alice" } },
        conversation: {
          ok: true,
          data: [
            {
              id: 90,
              user: "alice",
              created_at: new Date(NOW - 60_000).toISOString(),
              body: "@reviewer-bot why is line 42 a null check?",
            },
            ...others.map((user, index) => ({
              id: 200 + index,
              user,
              created_at: new Date(NOW - 60_000).toISOString(),
              body: `@reviewer-bot question ${index}`,
            })),
            {
              id: 300,
              user: BOT_LOGIN,
              created_at: new Date(NOW - 30_000).toISOString(),
              // The answer the first delivery published is among the reads.
              body: published,
            },
          ],
        },
      }),
      secondRecs,
    ),
  );
  assert.deepEqual(followUpOutcome(second), { status: "ignored", reason: "rate-limited" });
  assert.equal(secondRecs.answers.length, 0, "no model work past the budget");
  assert.equal(secondRecs.posts.length, 0, "no write past the budget");
});

test("an answer older than the budget window does not consume the next delivery's budget", async () => {
  const recs: EffectRecs = { answers: [], posts: [] };
  const windowMs = DEFAULT_FOLLOW_UP_RATE_LIMITS.perPr.windowMs;
  const result = await runActionFollowUp(
    githubStage(),
    ghCommentPayload("@reviewer-bot why?"),
    defaultBudgetDeps(
      stubReadAdapter({
        botLogin: BOT_LOGIN,
        permissionData: { permission: "admin", user: { login: "alice" } },
        conversation: {
          ok: true,
          data: [{
            id: 102,
            user: BOT_LOGIN,
            created_at: new Date(NOW - windowMs - 60_000).toISOString(),
            body: `${FOLLOWUP_REPLY_MARKER}\n\nan old answer`,
          }],
        },
      }),
      recs,
    ),
  );
  assert.equal(followUpOutcome(result).status, "answered");
  assert.equal(recs.answers.length, 1);
});

test("a full-length thread snapshot denies a window it cannot prove covered", async () => {
  // Both platform seams cap the thread read at the latest comments: a
  // full-length snapshot may have omitted earlier budgeted questions, and
  // when none of its entries reach back past the window the host must deny
  // (the wiring of CONVERSATION_COMMENTS_SNAPSHOT_CAP into the store).
  const recs: EffectRecs = { answers: [], posts: [] };
  const result = await runActionFollowUp(
    githubStage(),
    ghCommentPayload("@reviewer-bot why?"),
    defaultBudgetDeps(
      stubReadAdapter({
        botLogin: BOT_LOGIN,
        permissionData: { permission: "admin", user: { login: "alice" } },
        conversation: {
          ok: true,
          data: Array.from({ length: 100 }, (_unused, index) => ({
            id: 500 + index,
            user: index % 2 === 0 ? "bob" : "carol",
            created_at: new Date(NOW - 60_000).toISOString(),
            body: "@reviewer-bot an in-window question",
          })),
        },
      }),
      recs,
    ),
  );
  assert.deepEqual(followUpOutcome(result), { status: "ignored", reason: "rate-limited" });
  assert.equal(recs.answers.length, 0, "no model work on an unprovable window");
  assert.equal(recs.posts.length, 0, "no write on an unprovable window");
});

test("an unreadable thread denies the question: an unproven budget never silently allows", async () => {
  const recs: EffectRecs = { answers: [], posts: [] };
  const result = await runActionFollowUp(
    githubStage(),
    ghCommentPayload("@reviewer-bot why?"),
    defaultBudgetDeps(
      stubReadAdapter({
        botLogin: BOT_LOGIN,
        permissionData: { permission: "admin", user: { login: "alice" } },
        conversation: { ok: false, error: "boom" },
      }),
      recs,
    ),
  );
  assert.deepEqual(followUpOutcome(result), { status: "ignored", reason: "rate-limited" });
  assert.equal(recs.answers.length, 0);
  assert.equal(recs.posts.length, 0);
});

test("the actor's own prior questions count across deliveries, and the question in flight does not", async () => {
  const priorQuestions = [90, 91, 92].map((id) => ({
    id,
    user: "alice",
    created_at: new Date(NOW - 120_000).toISOString(),
    body: "@reviewer-bot an earlier question",
  }));
  // The question IN FLIGHT is in the thread too (the webhook fires after the
  // comment is published). It must not count against its own budget: with the
  // three prior questions it is still under the per-actor limit, so it is
  // answered.
  const recs: EffectRecs = { answers: [], posts: [] };
  const answered = await runActionFollowUp(
    githubStage(),
    ghCommentPayload("@reviewer-bot why?"),
    defaultBudgetDeps(
      stubReadAdapter({
        botLogin: BOT_LOGIN,
        permissionData: { permission: "admin", user: { login: "alice" } },
        conversation: {
          ok: true,
          data: [...priorQuestions, { id: 101, user: "alice", created_at: new Date(NOW).toISOString(), body: "@reviewer-bot why?" }],
        },
      }),
      recs,
    ),
  );
  assert.equal(followUpOutcome(answered).status, "answered");
  assert.equal(recs.answers.length, 1);

  // One more prior question puts the actor AT the per-actor limit.
  const deniedRecs: EffectRecs = { answers: [], posts: [] };
  const denied = await runActionFollowUp(
    githubStage(),
    ghCommentPayload("@reviewer-bot why again?"),
    defaultBudgetDeps(
      stubReadAdapter({
        botLogin: BOT_LOGIN,
        permissionData: { permission: "admin", user: { login: "alice" } },
        conversation: {
          ok: true,
          data: [
            ...priorQuestions,
            { id: 93, user: "alice", created_at: new Date(NOW - 120_000).toISOString(), body: "@reviewer-bot another earlier question" },
            { id: 101, user: "alice", created_at: new Date(NOW).toISOString(), body: "@reviewer-bot why again?" },
          ],
        },
      }),
      deniedRecs,
    ),
  );
  assert.deepEqual(followUpOutcome(denied), { status: "ignored", reason: "rate-limited" });
  assert.equal(deniedRecs.answers.length, 0);
  assert.equal(deniedRecs.posts.length, 0);
});

test("a participant cannot forge the reply marker to throttle the lane", async () => {
  const recs: EffectRecs = { answers: [], posts: [] };
  const result = await runActionFollowUp(
    githubStage(),
    ghCommentPayload("@reviewer-bot why?"),
    defaultBudgetDeps(
      stubReadAdapter({
        botLogin: BOT_LOGIN,
        permissionData: { permission: "admin", user: { login: "alice" } },
        conversation: {
          ok: true,
          data: Array.from({ length: 20 }, (_unused, index) => ({
            id: 200 + index,
            user: "mallory",
            created_at: new Date(NOW - 60_000).toISOString(),
            body: `${FOLLOWUP_REPLY_MARKER}\n\nnot a real answer`,
          })),
        },
      }),
      recs,
    ),
  );
  assert.equal(followUpOutcome(result).status, "answered");
  assert.equal(recs.answers.length, 1);
});

test("an authorized explicit re-review hands back to the normal pipeline; no model, no post", async () => {
  const recs: EffectRecs = { answers: [], posts: [] };
  const result = await runActionFollowUp(
    githubStage({ REREVIEW_COMMAND: "/ai-review" }),
    ghCommentPayload("/ai-review"),
    followUpDeps(
      stubReadAdapter({ botLogin: BOT_LOGIN, permissionData: { permission: "admin", user: { login: "alice" } } }),
      recs,
    ),
  );
  assert.equal(result.route, "pipeline");
  assert.equal(recs.answers.length, 0);
  assert.equal(recs.posts.length, 0);
});

test("non-follow-up payloads fall through to the pipeline without touching any dep", async () => {
  const throwing = throwingDeps();
  const pullRequest = {
    name: "pull_request",
    action: "opened",
    number: 7,
    head: { sha: "a".repeat(40) },
    base: { sha: "b".repeat(40), repo: { full_name: REPO } },
    repository: { full_name: REPO },
    installation: { id: 5 },
  };
  const commentWithoutPr = {
    name: "issue_comment",
    action: "created",
    issue: { number: 7 },
    comment: { id: 102, body: "@reviewer-bot hi", user: { login: "alice" } },
    repository: { full_name: REPO },
    installation: { id: 5 },
  };
  assert.equal((await runActionFollowUp(githubStage(), pullRequest, throwing)).route, "pipeline");
  assert.equal((await runActionFollowUp(githubStage(), commentWithoutPr, throwing)).route, "pipeline");
});

test("a Forgejo 'comment' payload is answered through the same shared plan", async () => {
  const question = "@reviewer-bot what changed in this PR?";
  const recs: EffectRecs = { answers: [], posts: [] };
  const result = await runActionFollowUp(
    forgejoStage(),
    forgejoCommentPayload(question),
    followUpDeps(
      stubReadAdapter({
        platform: "forgejo",
        botLogin: BOT_LOGIN,
        permissionData: { permission: "admin", user: { login: "alice" } },
      }),
      recs,
    ),
  );
  assert.equal(result.route, "follow-up");
  assert.deepEqual(followUpOutcome(result), { status: "answered", posted: true });
  assert.equal(recs.answers.length, 1);
  assert.equal(recs.posts.length, 1);
  const posted = recs.posts[0] ?? "";
  assert.ok(posted.startsWith(FOLLOWUP_REPLY_MARKER));
  assert.match(posted, /stub answer/);
});

test("parity: the host's planner outcome equals a direct planFollowUp call on the same event", async () => {
  const directConfig: FollowUpPlanConfig = {
    rereviewCommand: "",
    mentionHandles: [BOT_LOGIN],
    rateLimit: DEFAULT_FOLLOW_UP_RATE_LIMITS,
  };
  const directDeps = (adapter: PlatformReadAdapter, store: InMemoryRateLimitStore): FollowUpPlanDeps => ({
    clock: () => NOW,
    botLogin: BOT_LOGIN,
    readPermission: async (login) => {
      const r = await adapter.ghApi(`repos/${REPO}/collaborators/${encodeURIComponent(login)}/permission`);
      return r.error ? null : authorityReadingFromPayload(r.data);
    },
    rateLimitStore: store,
    fetchThreadComments: async () => [],
    latestManagedReview: async () => "",
  });

  // (a) ignored: an unaddressed comment — same reason from both paths.
  {
    const body = "looks fine to me";
    const payload = ghCommentPayload(body);
    const recs: EffectRecs = { answers: [], posts: [] };
    const host = await runActionFollowUp(
      githubStage(),
      payload,
      followUpDeps(
        stubReadAdapter({ botLogin: BOT_LOGIN, permissionData: { permission: "admin", user: { login: "alice" } } }),
        recs,
        { store: new InMemoryRateLimitStore(), clock: () => NOW },
      ),
    );
    const event = normalizeForgeEvent("github", payload, "webhook");
    assert.ok(event !== null && event.kind === "follow_up");
    const plan = await planFollowUp(
      { event, body },
      directDeps(stubReadAdapter({ botLogin: BOT_LOGIN, permissionData: { permission: "admin", user: { login: "alice" } } }), new InMemoryRateLimitStore()),
      directConfig,
    );
    assert.deepEqual(followUpOutcome(host), { status: "ignored", reason: "not-addressed" });
    assert.deepEqual(plan, { action: "ignore", reason: "not-addressed" });
    assert.equal(recs.answers.length, 0);
  }

  // (b) answer: the SAME canonical event yields the SAME prompt on both sides
  // (thread/managed contexts are empty on both, so the prompts must match
  // exactly).
  {
    const question = "@reviewer-bot does this fix the null check?";
    const payload = ghCommentPayload(question);
    const recs: EffectRecs = { answers: [], posts: [] };
    const host = await runActionFollowUp(
      githubStage(),
      payload,
      followUpDeps(
        stubReadAdapter({ botLogin: BOT_LOGIN, permissionData: { permission: "admin", user: { login: "alice" } } }),
        recs,
        { store: new InMemoryRateLimitStore(), clock: () => NOW },
      ),
    );
    const event = normalizeForgeEvent("github", payload, "webhook");
    assert.ok(event !== null && event.kind === "follow_up");
    const plan = await planFollowUp(
      { event, body: question },
      directDeps(stubReadAdapter({ botLogin: BOT_LOGIN, permissionData: { permission: "admin", user: { login: "alice" } } }), new InMemoryRateLimitStore()),
      directConfig,
    );
    assert.equal(followUpOutcome(host).status, "answered");
    if (plan.action !== "answer") throw new Error(`expected an answer plan, got: ${JSON.stringify(plan)}`);
    assert.equal(recs.answers[0], plan.prompt);
  }
});

test("a throwing model answer degrades to answer-failed (model-unavailable); nothing is posted", async () => {
  const recs: EffectRecs = { answers: [], posts: [] };
  const result = await runActionFollowUp(
    githubStage(),
    ghCommentPayload("@reviewer-bot why?"),
    followUpDeps(
      stubReadAdapter({ botLogin: BOT_LOGIN, permissionData: { permission: "admin", user: { login: "alice" } } }),
      recs,
      {
        answer: async (): Promise<string> => {
          throw new Error("model down");
        },
      },
    ),
  );
  assert.deepEqual(followUpOutcome(result), { status: "answer-failed", cause: "model-unavailable" });
  assert.equal(recs.posts.length, 0);
});

test("an empty model answer degrades to answer-failed (empty-answer); nothing is posted", async () => {
  const recs: EffectRecs = { answers: [], posts: [] };
  const result = await runActionFollowUp(
    githubStage(),
    ghCommentPayload("@reviewer-bot why?"),
    followUpDeps(
      stubReadAdapter({ botLogin: BOT_LOGIN, permissionData: { permission: "admin", user: { login: "alice" } } }),
      recs,
      { answer: async (): Promise<string> => "" },
    ),
  );
  assert.deepEqual(followUpOutcome(result), { status: "answer-failed", cause: "empty-answer" });
  assert.equal(recs.posts.length, 0);
});

test("a post returning false settles as answered with posted: false (attempt recorded once)", async () => {
  const question = "@reviewer-bot is the retry bounded?";
  const recs: EffectRecs = { answers: [], posts: [] };
  const result = await runActionFollowUp(
    githubStage(),
    ghCommentPayload(question),
    followUpDeps(
      stubReadAdapter({ botLogin: BOT_LOGIN, permissionData: { permission: "admin", user: { login: "alice" } } }),
      recs,
      { postComment: async (body: string) => { recs.posts.push(body); return false; } },
    ),
  );
  assert.equal(result.route, "follow-up");
  assert.deepEqual(followUpOutcome(result), { status: "answered", posted: false });
  assert.equal(recs.posts.length, 1, "one attempt, no retry");
  assert.ok(recs.posts[0]!.startsWith(FOLLOWUP_REPLY_MARKER), "even a failing post only ever saw the RENDERED body");
});

test("an over-long answer is truncated WITHIN the hard byte cap (the suffix is budgeted, not added)", async () => {
  const question = "@reviewer-bot why?";
  const recs: EffectRecs = { answers: [], posts: [] };
  const result = await runActionFollowUp(
    githubStage(),
    ghCommentPayload(question),
    followUpDeps(
      stubReadAdapter({ botLogin: BOT_LOGIN, permissionData: { permission: "admin", user: { login: "alice" } } }),
      recs,
      { answer: async (): Promise<string> => "x".repeat(FOLLOWUP_ANSWER_MAX_BYTES + 5_000) },
    ),
  );
  assert.equal(followUpOutcome(result).status, "answered");
  assert.equal(recs.posts.length, 1);
  const body = recs.posts[0]!;
  const prefix = `${FOLLOWUP_REPLY_MARKER}\n\n`;
  assert.ok(body.startsWith(prefix), "the reply carries the marker the renderer stamps");
  const answer = body.slice(prefix.length);
  assert.ok(
    Buffer.byteLength(answer, "utf8") <= FOLLOWUP_ANSWER_MAX_BYTES,
    `the rendered answer stays within the hard cap (${Buffer.byteLength(answer, "utf8")} bytes)`,
  );
  assert.ok(answer.endsWith("\n[…truncated]"), "the truncation suffix is present");
});

test("a multi-byte answer that is cut mid-character still stays within the hard byte cap", async () => {
  const question = "@reviewer-bot why?";
  const recs: EffectRecs = { answers: [], posts: [] };
  const result = await runActionFollowUp(
    githubStage(),
    ghCommentPayload(question),
    followUpDeps(
      stubReadAdapter({ botLogin: BOT_LOGIN, permissionData: { permission: "admin", user: { login: "alice" } } }),
      recs,
      // A 3-byte character straddling the clip boundary decodes to a
      // replacement character (3 bytes) — the cap must still hold.
      { answer: async (): Promise<string> => "€".repeat(FOLLOWUP_ANSWER_MAX_BYTES) },
    ),
  );
  assert.equal(followUpOutcome(result).status, "answered");
  const body = recs.posts[0]!;
  const answer = body.slice(`${FOLLOWUP_REPLY_MARKER}\n\n`.length);
  assert.ok(
    Buffer.byteLength(answer, "utf8") <= FOLLOWUP_ANSWER_MAX_BYTES,
    `the rendered answer stays within the hard cap (${Buffer.byteLength(answer, "utf8")} bytes)`,
  );
});

test("a throwing post settles as answered with posted: false — the host call never rejects", async () => {
  const question = "@reviewer-bot is the retry bounded?";
  const recs: EffectRecs = { answers: [], posts: [] };
  const result = await runActionFollowUp(
    githubStage(),
    ghCommentPayload(question),
    followUpDeps(
      stubReadAdapter({ botLogin: BOT_LOGIN, permissionData: { permission: "admin", user: { login: "alice" } } }),
      recs,
      { postComment: async (body: string) => { recs.posts.push(body); throw new Error("forge refused"); } },
    ),
  );
  assert.equal(result.route, "follow-up");
  assert.deepEqual(followUpOutcome(result), { status: "answered", posted: false });
  assert.equal(recs.posts.length, 1);
});
