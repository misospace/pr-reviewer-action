import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVerdictResponse } from "../src/model/verdict.js";
import {
  HUMAN_REVIEW_ROUTING_STATUSES,
  NON_MUTATING_ROUTING_STATUSES,
  resolveHumanReviewRouting,
} from "../src/routing/human-review-routing.js";
import type { ReviewerRoutingTarget } from "../src/config/reviewer-routing.js";
import { applyReviewTriageFragment, renderReviewTriageRoutingFragment } from "../src/prompt/system-prompt.js";
import { GitHubPublishApi, ForgejoPublishApi } from "../src/platform/publish-api.js";
import type {
  NativeReviewRequest,
  PublishCommentRef,
  PublishPlatformApi,
  PublishReviewRef,
  ReviewerRequestResult,
} from "../src/platform/publish-api.js";
import { publishReview, renderReviewRoutingBlock } from "../src/publish/publish.js";
import { publishInputFromEnv } from "../src/run/entrypoints.js";
import type { HumanReviewRoutingPlan } from "../src/routing/human-review-routing.js";
import type { FetchLike } from "../src/platform/http.js";

// ---------------------------------------------------------------------------
// Parser: review_triage_targets normalization
// ---------------------------------------------------------------------------

function responseWith(parsed: Record<string, unknown>): unknown {
  return {
    choices: [{ message: { content: JSON.stringify({ verdict: "approve", review_markdown: "## Review\n\nok", ...parsed }) }, finish_reason: "stop" }],
  };
}

test("#1005: parser normalizes review_triage_targets (bounded, lowercased, deduped)", () => {
  const parsed = parseVerdictResponse(responseWith({
    review_triage_decision: "required",
    review_triage_reason: "policy",
    review_triage_targets: ["Platform", "  security ", "platform", "", 7, null, "x".repeat(200)],
  }));
  assert.deepEqual(parsed.reviewTriageTargets, ["platform", "security"]);
  // Never passed through as a raw model extra.
  assert.equal("review_triage_targets" in parsed.extra, false);
});

test("#1005: parser yields [] for absent or non-array review_triage_targets", () => {
  assert.deepEqual(parseVerdictResponse(responseWith({ review_triage_decision: "required" })).reviewTriageTargets, []);
  assert.deepEqual(parseVerdictResponse(responseWith({ review_triage_targets: "platform" })).reviewTriageTargets, []);
  assert.deepEqual(parseVerdictResponse(responseWith({ review_triage_targets: { a: 1 } })).reviewTriageTargets, []);
});

test("#1005: parser caps the target list at 32", () => {
  const many = Array.from({ length: 40 }, (_, i) => `t${i}`);
  assert.equal(parseVerdictResponse(responseWith({ review_triage_targets: many })).reviewTriageTargets.length, 32);
});

// ---------------------------------------------------------------------------
// Deterministic resolver
// ---------------------------------------------------------------------------

const CONFIG: ReadonlyMap<string, ReviewerRoutingTarget> = new Map([
  ["platform", { users: ["alice"], teams: ["platform-team"] }],
  ["security", { users: ["bob"], teams: [] }],
]);

function resolve(overrides: Partial<Parameters<typeof resolveHumanReviewRouting>[0]> = {}): HumanReviewRoutingPlan {
  return resolveHumanReviewRouting({
    mode: "request",
    decision: "required",
    targets: ["platform"],
    config: CONFIG,
    isForkPr: false,
    ...overrides,
  });
}

test("#1005: mode off never routes", () => {
  const plan = resolve({ mode: "off" });
  assert.equal(plan.status, "off");
  assert.deepEqual(plan.users, []);
});

test("#1005: not_required/unknown route nothing; targets alongside them are invalid", () => {
  assert.equal(resolve({ decision: "not_required", targets: [] }).status, "not_required");
  assert.equal(resolve({ decision: "unknown", targets: [] }).status, "not_required");
  assert.equal(resolve({ decision: "not_required", targets: ["platform"] }).status, "invalid");
  assert.equal(resolve({ decision: "unknown", targets: ["platform"] }).status, "invalid");
});

test("#1005: required with no targets is no_targets; unknown target is invalid", () => {
  assert.equal(resolve({ targets: [] }).status, "no_targets");
  assert.equal(resolve({ targets: ["platform", "attacker"] }).status, "invalid");
  assert.equal(resolve({ targets: ["attacker"] }).status, "invalid");
});

test("#1005: required with configured targets resolves trusted identities deterministically", () => {
  const plan = resolve({ targets: ["security", "platform"] });
  assert.equal(plan.status, "request");
  assert.deepEqual(plan.targetIds, ["platform", "security"]);
  assert.deepEqual(plan.users, ["alice", "bob"]);
  assert.deepEqual(plan.teams, ["platform-team"]);
});

test("#1005: advisory computes the plan but never requests; fork request mode is blocked", () => {
  const advisory = resolve({ mode: "advisory" });
  assert.equal(advisory.status, "advisory");
  assert.deepEqual(advisory.users, ["alice"]);
  const fork = resolve({ isForkPr: true });
  assert.equal(fork.status, "fork_blocked");
  assert.deepEqual(fork.users, ["alice"]);
  // Advisory on a fork is read-only and still allowed.
  assert.equal(resolve({ mode: "advisory", isForkPr: true }).status, "advisory");
});

test("#1005: a configured target resolving to no identities is invalid", () => {
  const empty: ReadonlyMap<string, ReviewerRoutingTarget> = new Map([["ghost", { users: [], teams: [] }]]);
  assert.equal(resolve({ targets: ["ghost"], config: empty }).status, "invalid");
});

// ---------------------------------------------------------------------------
// Prompt fragment
// ---------------------------------------------------------------------------

const BASE_STATE = { systemPrompt: "BASE", isDefault: true, addendum: "" };

test("#1005: routing addendum is appended only when targets are configured", () => {
  const off = applyReviewTriageFragment(BASE_STATE, true);
  const on = applyReviewTriageFragment(BASE_STATE, true, ["security", "platform", "platform"]);
  assert.ok(on.systemPrompt.startsWith(off.systemPrompt));
  assert.match(on.systemPrompt, /platform, security/);
  assert.match(on.systemPrompt, /review_triage_targets/);
  // Empty target list is byte-identical to the pre-#1005 fragment.
  assert.equal(applyReviewTriageFragment(BASE_STATE, true, []).systemPrompt, off.systemPrompt);
  // Idempotent.
  assert.equal(applyReviewTriageFragment(on, true, ["platform", "security"]).systemPrompt, on.systemPrompt);
  assert.equal(renderReviewTriageRoutingFragment([]), "");
});

// ---------------------------------------------------------------------------
// Platform write seam
// ---------------------------------------------------------------------------

interface Call { method: string; url: string; body: unknown; }

function recorder(routes: Array<[string, number, unknown]>): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = typeof init?.body === "string" ? init.body : null;
    calls.push({ method, url, body: raw === null ? null : JSON.parse(raw) });
    const hit = routes.find(([key]) => `${method} ${url}`.startsWith(key));
    const [, status, data] = hit ?? ["", 404, {}];
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

const BASE = "https://api.github.com";
const github = (fetchImpl: FetchLike): GitHubPublishApi => new GitHubPublishApi({ repo: "o/r", prNumber: "9", token: "test-token", fetchImpl });

test("#1005: GitHub requestReviewers diffs existing and posts only the new set", async () => {
  const { fetchImpl, calls } = recorder([
    [`GET ${BASE}/repos/o/r/pulls/9/requested_reviewers`, 200, { users: [{ login: "alice" }], teams: [{ slug: "platform-team" }] }],
    [`POST ${BASE}/repos/o/r/pulls/9/requested_reviewers`, 201, {}],
  ]);
  const result = await github(fetchImpl).requestReviewers(["alice", "bob"], ["platform-team", "security"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.requestedUsers, ["bob"]);
  assert.deepEqual(result.requestedTeams, ["security"]);
  assert.deepEqual(result.alreadyRequestedUsers, ["alice"]);
  assert.deepEqual(result.alreadyRequestedTeams, ["platform-team"]);
  const post = calls.find((c) => c.method === "POST")!;
  assert.deepEqual(post.body, { reviewers: ["bob"], team_reviewers: ["security"] });
  assert.ok(!calls.some((c) => c.method === "DELETE"));
});

test("#1005: GitHub requestReviewers is a no-op POST when everything is already requested", async () => {
  const { fetchImpl, calls } = recorder([
    [`GET ${BASE}/repos/o/r/pulls/9/requested_reviewers`, 200, { users: [{ login: "alice" }], teams: [] }],
  ]);
  const result = await github(fetchImpl).requestReviewers(["alice"], []);
  assert.equal(result.ok, true);
  assert.ok(!calls.some((c) => c.method === "POST"));
});

test("#1005: GitHub requestReviewers fails closed on a read failure or an invalid identity", async () => {
  const readFail = recorder([[`GET ${BASE}/repos/o/r/pulls/9/requested_reviewers`, 500, {}]]);
  const failed = await github(readFail.fetchImpl).requestReviewers(["alice"], []);
  assert.equal(failed.ok, false);
  assert.ok(!readFail.calls.some((c) => c.method === "POST"));

  const invalid = recorder([]);
  const rejected = await github(invalid.fetchImpl).requestReviewers(["not a login"], []);
  assert.equal(rejected.ok, false);
  assert.equal(invalid.calls.length, 0, "invalid identity must never reach the API");
});

test("#1005: Forgejo requestReviewers is explicitly unsupported with no network call", async () => {
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.example", token: "t" });
  const result = await api.requestReviewers(["alice"], ["platform-team"]);
  assert.equal(result.ok, false);
  assert.equal(result.supported, false);
  assert.deepEqual(result.requestedUsers, []);
});

// ---------------------------------------------------------------------------
// Publish integration
// ---------------------------------------------------------------------------

const HEAD = "head-1";

class CapturingPublishApi implements PublishPlatformApi {
  readonly platform = "github" as const;
  requests: { users: string[]; teams: string[] }[] = [];
  requestResult: ReviewerRequestResult = { ok: true, supported: true, requestedUsers: ["alice"], requestedTeams: [], alreadyRequestedUsers: [], alreadyRequestedTeams: [] };
  sticky: { marker: string; body: string }[] = [];
  async getHeadSha(): Promise<string | null> { return HEAD; }
  async listIssueComments(): Promise<PublishCommentRef[]> { return []; }
  async upsertStickyComment(marker: string, body: string) { this.sticky.push({ marker, body }); return { ok: true, created: true }; }
  async listReviews(): Promise<PublishReviewRef[]> { return []; }
  async listManagedInlineComments(): ReturnType<PublishPlatformApi["listManagedInlineComments"]> { return { supported: true, complete: true, comments: [] }; }
  async retireInlineComment(): Promise<boolean> { return true; }
  async createReview(_request: NativeReviewRequest) { return { ok: true, reviewId: 1 }; }
  async dismissReview(): Promise<boolean> { return true; }
  async minimizedReviewIds(): Promise<string[]> { return []; }
  async minimizeReview(): Promise<boolean> { return true; }
  async unresolvedSupersededThreads(): ReturnType<PublishPlatformApi["unresolvedSupersededThreads"]> { return { ok: true, threads: [], hasNextPage: false }; }
  async resolveThread(): Promise<boolean> { return true; }
  async removeLabel(): Promise<boolean> { return true; }
  async requestReviewers(users: readonly string[], teams: readonly string[]): Promise<ReviewerRequestResult> {
    this.requests.push({ users: [...users], teams: [...teams] });
    return this.requestResult;
  }
}

function publishInput(overrides: Record<string, unknown> = {}): Parameters<typeof publishReview>[0] {
  return {
    mode: "comment", reviewMarkdown: "## Review\n\nok", verdict: "approve", analysisEngine: "engine",
    baseSha: "base-1", headSha: HEAD, prNumber: "42", commentMarker: "<!-- m -->", requiredChecks: "complete",
    reviewRoute: "primary", escalationReason: "", cacheHitRatio: "-", inlineFindings: false, inlineFindingsMax: 10,
    findings: [], cleanupPreviousNativeReviews: "false", allowApprove: false, approveForks: false, isForkPr: false,
    upstreamLinkMode: "inert", conditionalPresence: {
      linkedIssue: true, evidenceProvider: true, standards: true, toolHarnessFindings: true, toolHarnessResults: true,
    }, forgejoPositions: false, ...overrides,
  };
}

const REQUEST_PLAN: HumanReviewRoutingPlan = {
  mode: "request", status: "request", targetIds: ["platform"], users: ["alice"], teams: ["platform-team"], detail: "d",
};

test("#1005: publish performs the request for status request and reports it in the body", async () => {
  const api = new CapturingPublishApi();
  await publishReview(publishInput({ reviewRouting: REQUEST_PLAN }), api, { diffText: "" });
  assert.deepEqual(api.requests, [{ users: ["alice"], teams: ["platform-team"] }]);
  const body = api.sticky[0]!.body;
  assert.ok(body.includes("## Reviewer Routing"));
  assert.ok(body.includes("configured reviewers requested"));
});

test("#1005: publish never mutates for advisory, fork_blocked, or invalid", async () => {
  for (const status of ["advisory", "fork_blocked", "invalid"] as const) {
    const api = new CapturingPublishApi();
    await publishReview(publishInput({ reviewRouting: { ...REQUEST_PLAN, status } }), api, { diffText: "" });
    assert.equal(api.requests.length, 0, `status ${status} must not request`);
    assert.ok(api.sticky[0]!.body.includes("## Reviewer Routing"));
  }
});

test("#1005: publish surfaces a request failure without substituting and still publishes", async () => {
  const api = new CapturingPublishApi();
  api.requestResult = { ok: false, supported: true, requestedUsers: [], requestedTeams: [], alreadyRequestedUsers: [], alreadyRequestedTeams: [], error: "status 403" };
  const result = await publishReview(publishInput({ reviewRouting: REQUEST_PLAN }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.ok(result.messages.some((m) => /reviewer routing failed.*403/.test(m)));
  assert.ok(api.sticky[0]!.body.includes("reviewer request failed"));
});

test("#1005: no routing plan renders no routing section (byte-compatible)", async () => {
  const api = new CapturingPublishApi();
  await publishReview(publishInput(), api, { diffText: "" });
  assert.equal(api.requests.length, 0);
  assert.ok(!api.sticky[0]!.body.includes("Reviewer Routing"));
});

test("#1005: renderReviewRoutingBlock renders nothing for non-decision statuses", () => {
  for (const status of ["off", "not_required", "no_targets"] as const) {
    assert.equal(renderReviewRoutingBlock({ ...REQUEST_PLAN, status }), "");
  }
});

test("#1005: only `request` is a mutating status; the non-mutating set partitions the enum", () => {
  assert.deepEqual(
    HUMAN_REVIEW_ROUTING_STATUSES.filter((s) => !NON_MUTATING_ROUTING_STATUSES.includes(s)),
    ["request", "requested", "request_failed"],
  );
  assert.ok(!NON_MUTATING_ROUTING_STATUSES.includes("request"));
  // The resolver never yields a mutating status for off/advisory/fork.
  for (const mode of ["off", "advisory"] as const) {
    assert.ok(NON_MUTATING_ROUTING_STATUSES.includes(resolve({ mode }).status));
  }
  assert.equal(resolve({ isForkPr: true }).status, "fork_blocked");
});

test("#1005: publish boundary refuses a carried-forward request plan whose mode is not request", async () => {
  const api = new CapturingPublishApi();
  const result = await publishReview(publishInput({ reviewRouting: { ...REQUEST_PLAN, mode: "advisory" } }), api, { diffText: "" });
  assert.equal(api.requests.length, 0);
  assert.ok(result.messages.some((m) => /inconsistent at the publish boundary/.test(m)));
  assert.ok(api.sticky[0]!.body.includes("invalid selection"));
});

test("#1005: publish boundary refuses a request plan on a fork or an unknown fork state", async () => {
  for (const isForkPr of [true, null] as const) {
    const api = new CapturingPublishApi();
    await publishReview(publishInput({ reviewRouting: REQUEST_PLAN, isForkPr }), api, { diffText: "" });
    assert.equal(api.requests.length, 0, `isForkPr=${isForkPr} must not request`);
  }
});

test("#1005: publishInputFromEnv reads the persisted plan from the run dir, not cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-routing-rundir-"));
  writeFileSync(join(dir, "review-routing.json"), JSON.stringify({
    mode: "request", status: "request", target_ids: ["platform"], users: ["alice"], teams: ["platform-team"], detail: "d",
  }));
  const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
  assert.deepEqual(input.reviewRouting, {
    mode: "request", status: "request", targetIds: ["platform"], users: ["alice"], teams: ["platform-team"], detail: "d",
  });
  // A structurally unrecognizable plan is dropped (no routing), fail closed.
  writeFileSync(join(dir, "review-routing.json"), JSON.stringify({ mode: "request", status: "bogus", users: ["alice"] }));
  assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").reviewRouting, undefined);
});

test("#1005: routing block and step-summary row neutralize hostile trusted-config values", () => {
  const hostile: HumanReviewRoutingPlan = {
    ...REQUEST_PLAN,
    status: "requested",
    targetIds: ["plat`form|x"],
    users: ["ali`ce|bob"],
    teams: ["team`a|b"],
  };
  const block = renderReviewRoutingBlock(hostile);
  // Backticks are stripped inside code spans and no raw pipe can forge table
  // structure in the blockquote section.
  assert.ok(!block.includes("plat`form"));
  assert.ok(block.includes("Reviewer Routing"));
});

