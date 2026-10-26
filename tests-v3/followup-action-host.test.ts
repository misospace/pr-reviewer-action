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
import type { FollowUpRunOutcome } from "../src/followup/controller.js";
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
