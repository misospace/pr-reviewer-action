import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_FAILURE_GUIDANCE,
  evaluateApprovalGuardrails,
  markerReviewResult,
  publishReview,
  renderFindingsSummary,
  renderOutsideDiffSection,
  renderPartialCoverageNotice,
  resolveCleanupFlag,
  sanitizeForPublication,
} from "../src/publish/publish.js";
import { cleanupManagedReviews, resolveSupersededThreads } from "../src/publish/cleanup.js";
import type { TrustedOwnerIdentity } from "../src/platform/owner-identity.js";
import type { ConditionalSectionPresence } from "../src/publish/sanitize.js";
import { ForgejoPublishApi, forgejoReviewEvent } from "../src/platform/publish-api.js";
import type {
  NativeReviewRequest,
  PublishCommentRef,
  PublishPlatformApi,
  PublishReviewRef,
  ReviewerRequestResult,
} from "../src/platform/publish-api.js";

const MARKER = "<!-- ai-pr-review -->";
const HEAD = "head-123";

class MockPublishApi implements PublishPlatformApi {
  readonly platform: "github" | "forgejo";
  head: string | null = HEAD;
  sticky: { marker: string; body: string }[] = [];
  reviews: PublishReviewRef[] = [];
  submitted: NativeReviewRequest[] = [];
  dismissed: string[] = [];
  minimized: string[] = [];
  resolved: string[] = [];
  removedLabels: string[] = [];
  threads = { ok: true, threads: [] as { id: string }[], hasNextPage: false };
  comments: PublishCommentRef[] = [];
  minimizeIds: string[] = [];
  listReviewsError = false;
  stickyResult: { ok: boolean; created: boolean; commentId?: number | string; updatedAt?: string; error?: string } = { ok: true, created: true };
  reviewResults: { ok: boolean; error?: string }[] = [];
  dismissResult = true;
  minimizeResult = true;
  resolveResult = true;
  threadQueryError = false;
  reviewerRequests: { users: string[]; teams: string[] }[] = [];
  reviewerRequestResult: ReviewerRequestResult = {
    ok: true,
    supported: true,
    requestedUsers: [],
    requestedTeams: [],
    alreadyRequestedUsers: [],
    alreadyRequestedTeams: [],
  };

  constructor(platform: "github" | "forgejo" = "github") { this.platform = platform; }
  async getHeadSha(): Promise<string | null> { return this.head; }
  async listIssueComments(): Promise<PublishCommentRef[]> { return this.comments; }
  async upsertStickyComment(marker: string, body: string) {
    this.sticky.push({ marker, body });
    // #1093: mirror the real forge — a successful upsert stores the exact
    // published body on the sticky comment, so the checkpoint's body
    // equality read observes the same bytes the run published.
    if (this.stickyResult.ok && this.stickyResult.commentId !== undefined) {
      const id = String(this.stickyResult.commentId);
      this.comments = this.comments.map((c) => String(c.id) === id ? { ...c, body } : c);
    }
    return this.stickyResult;
  }
  async listReviews(): Promise<PublishReviewRef[]> { if (this.listReviewsError) throw new Error("list failed"); return this.reviews; }
  async authenticatedIdentity() { return this.identity; }
  /** #1093: the trusted-owner seam; `identity === null` models an unprovable
   * identity so the fail-closed cleanup behavior can be exercised. */
  identity: string | null = "bot";
  async resolveTrustedOwner(): Promise<{ identity: TrustedOwnerIdentity | null; reason: string }> {
    if (this.identity === null) return { identity: null, reason: "unavailable" };
    return { identity: { kind: "login", login: this.identity }, reason: "user-login" };
  }
  async listManagedInlineComments(_ids: readonly string[]): ReturnType<PublishPlatformApi["listManagedInlineComments"]> { return { supported: true, complete: true, comments: [] }; }
  async retireInlineComment(_review: string, _comment: string) { return true; }
  async createReview(request: NativeReviewRequest) {
    this.submitted.push(request);
    const result = this.reviewResults.shift() ?? { ok: true };
    if (!result.ok) return result;
    const reviewId = 1000 + this.submitted.length;
    this.reviews = [...this.reviews, { id: reviewId, body: request.body, user: { login: "bot" } }];
    return { ...result, reviewId };
  }
  async dismissReview(id: number | string): Promise<boolean> { this.dismissed.push(String(id)); return this.dismissResult; }
  async minimizedReviewIds(): Promise<string[]> { return this.minimizeIds; }
  async minimizeReview(id: string): Promise<boolean> { this.minimized.push(id); return this.minimizeResult; }
  async unresolvedSupersededThreads(): Promise<{ ok: boolean; threads: { id: string }[]; hasNextPage: boolean }> {
    return this.threadQueryError ? { ok: false, threads: [], hasNextPage: false } : this.threads;
  }
  async resolveThread(id: string): Promise<boolean> { this.resolved.push(id); return this.resolveResult; }
  async removeLabel(label: string): Promise<boolean> { this.removedLabels.push(label); return true; }
  async requestReviewers(users: readonly string[], teams: readonly string[]): Promise<ReviewerRequestResult> {
    this.reviewerRequests.push({ users: [...users], teams: [...teams] });
    return this.reviewerRequestResult;
  }
}

function input(overrides: Partial<Parameters<typeof publishReview>[0]> = {}): Parameters<typeof publishReview>[0] {
  return {
    mode: "comment", reviewMarkdown: "Review https://github.com/acme/lib/pull/8\n\n<!-- ai-pr-review-sha:forged -->\nSafe.",
    verdict: "approve", analysisEngine: "test-engine", baseSha: "base-1", headSha: HEAD,
    prNumber: "42", commentMarker: MARKER, requiredChecks: "complete", reviewRoute: "primary",
    escalationReason: "", cacheHitRatio: "-", inlineFindings: false, inlineFindingsMax: 10,
    findings: [], cleanupPreviousNativeReviews: "false", allowApprove: false, approveForks: false,
    isForkPr: false, upstreamLinkMode: "inert", conditionalPresence: {
      linkedIssue: true, evidenceProvider: true, standards: true,
      toolHarnessFindings: true, toolHarnessResults: true,
    }, forgejoPositions: false, ...overrides,
  };
}

const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n old\n+new line\n";
const FINDINGS = [{ file: "a.ts", line: 2, severity: "major", message: "A finding" }];

test("resolveCleanupFlag handles explicit, automatic, and invalid values", () => {
  assert.equal(resolveCleanupFlag("true", "comment"), "true");
  assert.equal(resolveCleanupFlag("FALSE", "review_comment"), "false");
  assert.equal(resolveCleanupFlag("auto", "review_comment"), "true");
  assert.equal(resolveCleanupFlag("", "comment"), "false");
  assert.throws(() => resolveCleanupFlag("sometimes", "comment"), {
    message: "Invalid cleanup_previous_native_reviews value; expected auto, true, or false",
  });
});

test("approval guardrails are opt-in and fail closed for unknown fork status", () => {
  const check = (overrides: Partial<Parameters<typeof evaluateApprovalGuardrails>[0]>) => evaluateApprovalGuardrails({
    verdict: "approve", allowApprove: false, approveForks: false, isForkPr: false, ...overrides,
  });
  assert.equal(check({}).canApprove, false);
  assert.equal(check({ allowApprove: true }).canApprove, true);
  assert.equal(check({ allowApprove: true, isForkPr: true }).canApprove, false);
  assert.equal(check({ allowApprove: true, isForkPr: true, approveForks: true }).canApprove, true);
  assert.equal(check({ allowApprove: true, isForkPr: null }).canApprove, false);
  assert.equal(check({ allowApprove: true, isForkPr: null, approveForks: true }).canApprove, true);
  assert.equal(check({ verdict: "request_changes", allowApprove: true, approveForks: true }).canApprove, false);
});

test("comment publication appends findings tagged outside the diff", async () => {
  const api = new MockPublishApi();
  const findings = [...FINDINGS, { file: "b.ts", line: 9, severity: "minor", message: "Caller breaks", outside_diff: true }];
  await publishReview(input({ findings }), api, { diffText: DIFF });
  const body = api.sticky[0]!.body;
  assert.ok(body.includes("## Findings Outside This Diff"));
  assert.ok(body.includes("(outside this diff) Caller breaks"));
  assert.ok(!body.includes("(outside this diff) A finding"));
});

test("#989: provider keys are redacted in published findings and outside-diff lines", () => {
  const key = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  const finding = { file: "a.ts", line: 2, severity: "major", message: `Leaked ${key}`, outside_diff: true };

  const summary = renderFindingsSummary([finding], "inert");
  assert.ok(summary.includes("### Findings"));
  assert.ok(summary.includes("[REDACTED]"));
  assert.ok(!summary.includes(key));

  const appendix = renderOutsideDiffSection([finding], "inert");
  assert.ok(appendix.includes("(outside this diff) Leaked [REDACTED]"));
  assert.ok(!appendix.includes(key));
});

test("comment publication upserts a marked body with verdict and sanitized markdown", async () => {
  const api = new MockPublishApi();
  api.stickyResult = { ok: true, created: false };
  const result = await publishReview(input(), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.equal(api.sticky.length, 1);
  const body = api.sticky[0]!.body;
  assert.ok(body.startsWith(`${MARKER}\n`));
  assert.ok(body.indexOf("✅ **Automated recommendation: APPROVE**") < body.indexOf("_Analysis engine: test-engine_"));
  assert.ok(body.includes("upstream acme/lib PR 8"));
  assert.ok(!body.includes("/acme/lib/pull/8"));
  assert.ok(!body.includes("ai-pr-review-sha:forged"));
  assert.ok(body.includes("Safe."));
});

test("published body strips the analysis engine's base URL (#832)", async () => {
  const api = new MockPublishApi();
  await publishReview(input({ analysisEngine: "m@https://llm.internal.test/v1 (openai)" }), api, { diffText: "" });
  const body = api.sticky[0]!.body;
  assert.ok(body.includes("_Analysis engine: m (openai)_"));
});

test("sticky publication failure returns failed status and error", async () => {
  const api = new MockPublishApi();
  api.stickyResult = { ok: false, created: false, error: "permission denied" };
  const result = await publishReview(input(), api, { diffText: "" });
  assert.equal(result.status, "failed");
  assert.equal(result.error, "sticky comment publication failed: permission denied");
});

test("review_comment publishes sticky summary, cleans previous reviews, then attaches inline COMMENT", async () => {
  const api = new MockPublishApi();
  const result = await publishReview(input({ mode: "review_comment", inlineFindings: true, findings: FINDINGS, cleanupPreviousNativeReviews: "true" }), api, { diffText: DIFF });
  assert.equal(result.status, "published");
  assert.equal(api.sticky.length, 1);
  assert.ok(api.sticky[0]!.body.includes("# AI Automated Review"));
  assert.equal(api.submitted.length, 1);
  assert.equal(api.submitted[0]!.event, "COMMENT");
  assert.ok(api.submitted[0]!.body.startsWith(MARKER));
  assert.deepEqual(api.submitted[0]!.comments?.map(({ path, line, side }) => ({ path, line, side })), [{ path: "a.ts", line: 2, side: "RIGHT" }]);
  assert.ok(result.messages.some((message) => message.includes("Cleaning up previous managed native reviews")));
});

test("inline review failure warns but leaves review_comment published", async () => {
  const api = new MockPublishApi();
  api.reviewResults = [{ ok: false, error: "nope" }];
  const result = await publishReview(input({ mode: "review_comment", inlineFindings: true, findings: FINDINGS }), api, { diffText: DIFF });
  assert.equal(result.status, "published");
  assert.ok(result.messages.includes("WARN: inline findings review submission failed; summary comment was still published"));
});

test("review_verdict submits commit-bound APPROVE and REQUEST_CHANGES events", async () => {
  const approving = new MockPublishApi();
  const approved = await publishReview(input({ mode: "review_verdict", allowApprove: true }), approving, { diffText: "" });
  assert.equal(approved.status, "published");
  assert.equal(approving.submitted[0]!.event, "APPROVE");
  assert.equal(approving.submitted[0]!.commit_id, HEAD);

  const blocking = new MockPublishApi();
  const requested = await publishReview(input({ mode: "review_verdict", verdict: "request_changes" }), blocking, { diffText: "" });
  assert.equal(requested.status, "published");
  assert.equal(blocking.submitted[0]!.event, "REQUEST_CHANGES");
  assert.equal(blocking.submitted[0]!.commit_id, HEAD);
});

test("withheld approval becomes advisory COMMENT with policy explanation", async () => {
  const api = new MockPublishApi();
  const result = await publishReview(input({ mode: "review_verdict", allowApprove: false }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.equal(api.submitted[0]!.event, "COMMENT");
  assert.ok(api.submitted[0]!.body.includes("> **Approval blocked by policy**"));
});

test("approval submission failure includes remediation guidance", async () => {
  const api = new MockPublishApi();
  api.reviewResults = [{ ok: false, error: "first" }, { ok: false, error: "second" }];
  const result = await publishReview(input({ mode: "review_verdict", allowApprove: true }), api, { diffText: "" });
  assert.equal(result.status, "failed");
  assert.equal(result.error, "native approval failed for #42");
  for (const line of APPROVAL_FAILURE_GUIDANCE) assert.ok(result.messages.includes(line));
});

test("publication head boundary skips superseded review and fails closed when unknown", async () => {
  const superseded = new MockPublishApi(); superseded.head = "new-head";
  assert.equal((await publishReview(input(), superseded, { diffText: "" })).status, "superseded");
  assert.equal(superseded.sticky.length, 0);
  const unknown = new MockPublishApi(); unknown.head = null;
  const failed = await publishReview(input(), unknown, { diffText: "" });
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /refusing to publish a potentially stale review/);
});

test("cleanup selects marker and legacy reviews, skips minimized comments, but dismisses minimized verdicts", async () => {
  const api = new MockPublishApi();
  api.reviews = [
    { id: 1, node_id: "node-1", state: "COMMENTED", body: `${MARKER}\nbody` },
    { id: 2, node_id: "node-2", state: "COMMENTED", body: "<!-- ai-pr-reviewer old -->" },
    { id: 3, node_id: "node-3", state: "COMMENTED", body: `${MARKER}\nold` },
    { id: 4, node_id: "node-4", state: "APPROVED", body: `${MARKER}\nold` },
    { id: 5, node_id: "node-5", state: "CHANGES_REQUESTED", body: "human" },
  ];
  api.minimizeIds = ["3", "4"];
  api.dismissResult = false;
  const logs: string[] = [];
  const ids = await cleanupManagedReviews(api, "42", MARKER, (line) => logs.push(line));
  assert.deepEqual(ids, ["1", "2", "4"]);
  assert.deepEqual(api.minimized, ["node-1", "node-2"]);
  assert.deepEqual(api.dismissed, ["4"]);
  assert.ok(logs.some((line) => line.includes("WARN: Could not dismiss review #4")));
});

test("cleanup listing failure skips cleanup; Forgejo degrades GraphQL operations with notes", async () => {
  const failed = new MockPublishApi(); failed.listReviewsError = true;
  const failureLogs: string[] = [];
  assert.deepEqual(await cleanupManagedReviews(failed, "42", MARKER, (line) => failureLogs.push(line)), []);
  assert.ok(failureLogs.some((line) => line.includes("skipping cleanup")));

  const forgejo = new MockPublishApi("forgejo");
  forgejo.stickyResult = { ok: true, created: true, commentId: 9, updatedAt: "2026-01-01T00:00:00Z" };
  forgejo.comments = [{ id: 9, body: MARKER, updated_at: "2026-01-01T00:00:00Z", user: { login: "bot" } }];
  forgejo.reviews = [{ id: 8, node_id: "node-8", state: "COMMENTED", body: MARKER, submitted_at: "2025-01-01T00:00:00Z" }];
  forgejo.minimizeResult = false;
  const logs: string[] = [];
  await cleanupManagedReviews(forgejo, "42", MARKER, (line) => logs.push(line));
  assert.deepEqual(forgejo.minimized, ["node-8"]);
  assert.ok(logs.some((line) => line.includes("Skipping GraphQL minimized-state query")));
  assert.ok(logs.some((line) => line.includes("Skipping minimizeComment")));
  const result = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "true" }), forgejo, { diffText: "" });
  assert.ok(result.messages.some((line) => line.includes("Skipping review-thread resolution")));
});

test("superseded-thread resolution only attempts API-selected managed unresolved threads", async () => {
  const api = new MockPublishApi();
  api.threads = { ok: true, threads: [{ id: "thread-managed" }], hasNextPage: true };
  const logs: string[] = [];
  assert.equal(await resolveSupersededThreads(api, ["11"], (line) => logs.push(line)), 1);
  assert.deepEqual(api.resolved, ["thread-managed"]);
  assert.ok(logs.some((line) => line.includes("More than 100 review threads")));
  api.threadQueryError = true;
  assert.equal(await resolveSupersededThreads(api, ["11"], (line) => logs.push(line)), 0);
  assert.ok(logs.some((line) => line.includes("Could not list review threads")));
  // Non-managed and already-resolved threads are filtered by the platform query;
  // the consumer only sees the managed, unresolved subset.
  api.threads = { ok: true, threads: [], hasNextPage: false };
  assert.equal(await resolveSupersededThreads(api, ["11"], () => undefined), 0);
  assert.deepEqual(api.resolved, ["thread-managed"]);
});

test("Forgejo event mapping and fresh-diff inline position translation", async () => {
  assert.equal(forgejoReviewEvent("APPROVE"), "APPROVED");
  assert.equal(forgejoReviewEvent("REQUEST_CHANGES"), "REQUEST_CHANGES");
  assert.equal(forgejoReviewEvent("COMMENT"), "COMMENT");
  const payloads: Record<string, unknown>[] = [];
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response("{}", { status: 201 });
  };
  const api = new ForgejoPublishApi({
    repo: "owner/repo", prNumber: "42", baseUrl: "https://forge.example", token: "token",
    fetchImpl, diffProvider: async () => DIFF,
  });
  const result = await api.createReview({
    body: "summary", event: "APPROVE", comments: [
      { path: "a.ts", line: 2, side: "RIGHT", body: "anchored" },
      { path: "missing.ts", line: 2, side: "RIGHT", body: "not anchorable" },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(payloads[0]!.event, "APPROVED");
  assert.deepEqual(payloads[0]!.comments, [{ path: "a.ts", new_position: 2, body: "anchored" }]);
});

// ---------------------------------------------------------------------------
// #810: partial-coverage notice and coverage: partial metadata marker
// ---------------------------------------------------------------------------

const PARTIAL_COVERAGE = {
  stop_reason: "tool-call-budget-exhausted",
  changed_files_total: 3,
  unread_files: ["src/b.ts", "src/c.ts"],
  leads_total: 2,
  unresolved_leads: [
    { role: "security", file: "src/c.ts", excerpt: "unvalidated input" },
    { role: "tests", file: null, excerpt: "new flag untested" },
  ],
};

test("#810: partial coverage renders the notice near the top and records it in the marker", async () => {
  const api = new MockPublishApi();
  const result = await publishReview(input({ partialCoverage: PARTIAL_COVERAGE }), api, { diffText: "" });
  assert.equal(result.status, "published");
  const body = api.sticky[0]!.body;
  const noticeAt = body.indexOf("## Partial Coverage Notice");
  assert.ok(noticeAt > -1, "notice section must be present");
  // Near the top: after the engine line, before any model-produced text.
  assert.ok(noticeAt > body.indexOf("_Analysis engine: test-engine_"));
  assert.ok(noticeAt < body.indexOf("Safe."));
  assert.match(body, /stopped on its budget \(`tool-call-budget-exhausted`\) before finishing/);
  assert.match(body, /Changed files never read \(2 of 3\): `src\/b\.ts`, `src\/c\.ts`/);
  assert.match(body, /Specialist leads never resolved \(2 of 2\): `security` \(`src\/c\.ts`\): unvalidated input; `tests` \(no file path\): new flag untested/);
  assert.match(body, /Absence of findings in the unread paths is not evidence they are safe\./);
  // The metadata marker carries coverage: partial plus the stop reason,
  // appended after the existing keys (insertion order preserved).
  const marker = body.split("\n").find((line) => line.startsWith("<!-- ai-pr-reviewer:"));
  assert.ok(marker);
  assert.ok(marker.includes('"coverage":"partial"'));
  assert.ok(marker.includes('"coverage_stop_reason":"tool-call-budget-exhausted"'));
  assert.ok(marker.indexOf('"cache_hit_ratio"') < marker.indexOf('"coverage"'));
});

test("#810: without partial coverage the body and marker stay byte-identical to the #680 shape", async () => {
  const api = new MockPublishApi();
  await publishReview(input(), api, { diffText: "" });
  const body = api.sticky[0]!.body;
  assert.ok(!body.includes("Partial Coverage Notice"));
  const marker = body.split("\n").find((line) => line.startsWith("<!-- ai-pr-reviewer:"));
  assert.ok(marker);
  assert.ok(!marker.includes("coverage"));
});

test("#810: the notice caps long lists deterministically and escapes code-span content", () => {
  const many = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
  const notice = renderPartialCoverageNotice({
    stop_reason: "max-rounds",
    changed_files_total: 25,
    unread_files: many,
    leads_total: 1,
    unresolved_leads: [{ role: "security", file: "src/`back`.ts", excerpt: "multi\nline\nmsg" }],
  });
  assert.match(notice, /`src\/f19\.ts`, … and 5 more/);
  assert.ok(!notice.includes("src/f20.ts"));
  assert.ok(!notice.includes("`src/`back`.ts`"));
  assert.match(notice, /`src\/'back'\.ts`/);
  assert.match(notice, /multi line msg/);
});

test("#810: control characters and NUL in coverage paths are stripped, never rendered", () => {
  const notice = renderPartialCoverageNotice({
    stop_reason: "max-rounds\u0000",
    changed_files_total: 1,
    unread_files: ["src/a\u0000b\u001b[31m.ts\u0007"],
    leads_total: 0,
    unresolved_leads: [],
  });
  assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(notice));
  assert.match(notice, /`src\/ab\[31m\.ts`/);
  assert.match(notice, /`max-rounds`/);
});

// ---------------------------------------------------------------------------
// #847: tool_budget / tool_budget_source / tool_calls in the metadata marker
// ---------------------------------------------------------------------------

test("#847: the tool-budget provenance reaches the published marker additively", async () => {
  const api = new MockPublishApi();
  const result = await publishReview(
    input({ toolBudget: 26, toolBudgetSource: "size-scaled", toolCalls: 12 }),
    api,
    { diffText: "" },
  );
  assert.equal(result.status, "published");
  const body = api.sticky[0]!.body;
  const marker = body.split("\n").find((line) => line.startsWith("<!-- ai-pr-reviewer:"));
  assert.ok(marker);
  assert.ok(marker.includes('"tool_budget":26'));
  assert.ok(marker.includes('"tool_budget_source":"size-scaled"'));
  assert.ok(marker.includes('"tool_calls":12'));
  // Appended after the pre-existing keys, so a marker parser ignoring them
  // reads exactly the pre-#847 fields.
  assert.ok(marker.indexOf('"tool_budget"') > marker.indexOf('"cache_hit_ratio"'));
});

test("#895: tool_rounds / max_rounds reach the published marker", async () => {
  const api = new MockPublishApi();
  await publishReview(
    input({ toolBudget: 32, toolBudgetSource: "tier-default", toolCalls: 14, toolRounds: 8, maxRounds: 16 }),
    api,
    { diffText: "" },
  );
  const marker = api.sticky[0]!.body.split("\n").find((line) => line.startsWith("<!-- ai-pr-reviewer:"));
  assert.ok(marker);
  assert.ok(marker.includes('"tool_rounds":8'));
  assert.ok(marker.includes('"max_rounds":16'));
});

test("#922: the loop's context budget and peak reach the published marker", async () => {
  const api = new MockPublishApi();
  await publishReview(input({ toolBudget: 24, toolCalls: 10, toolRounds: 6, maxRounds: 24, contextBudget: 250000, contextPeak: 61234 }), api, { diffText: "" });
  const marker = api.sticky[0]!.body.split("\n").find((line) => line.startsWith("<!-- ai-pr-reviewer:"));
  assert.ok(marker);
  assert.ok(marker.includes('"context_budget":250000'));
  assert.ok(marker.includes('"context_peak":61234'));
});

test("#847: without a tool harness the marker stays byte-identical to the pre-#847 shape", async () => {
  const api = new MockPublishApi();
  await publishReview(input(), api, { diffText: "" });
  const body = api.sticky[0]!.body;
  const marker = body.split("\n").find((line) => line.startsWith("<!-- ai-pr-reviewer:"));
  assert.ok(marker);
  assert.ok(!marker.includes("tool_budget"));
  assert.ok(!marker.includes("tool_calls"));
});

// ---------------------------------------------------------------------------
// #873 — required-check coverage incomplete (or a #810 tool-loop coverage
// gap) must never let an approve publish as APPROVE, under every verdict
// policy and publish mode. Evidence: PR #854 published APPROVE with
// "review_result":"partial","required_checks":"incomplete" in its marker.
// ---------------------------------------------------------------------------

const VERDICT_POLICIES = [undefined, "model", "findings_severity_gated", "strict"] as const;

test("markerReviewResult: required-check coverage incomplete is 'partial' under every verdict policy", () => {
  for (const verdictPolicy of VERDICT_POLICIES) {
    assert.equal(
      markerReviewResult({ verdictPolicy, verdict: "approve", findings: [], requiredChecks: "incomplete" }),
      "partial",
      `policy=${verdictPolicy}`,
    );
    assert.equal(
      markerReviewResult({ verdictPolicy, verdict: "approve", findings: [], requiredChecks: "complete" }),
      "clean",
      `policy=${verdictPolicy}`,
    );
    // A #810 tool-loop coverage gap is also 'partial', independent of required_checks.
    assert.equal(
      markerReviewResult({
        verdictPolicy, verdict: "approve", findings: [], requiredChecks: "complete",
        partialCoverage: PARTIAL_COVERAGE,
      }),
      "partial",
      `policy=${verdictPolicy}`,
    );
    // request_changes always reads as 'issues', coverage notwithstanding.
    assert.equal(
      markerReviewResult({ verdictPolicy, verdict: "request_changes", findings: [], requiredChecks: "incomplete" }),
      "issues",
      `policy=${verdictPolicy}`,
    );
  }
});

const INCOMPLETE_STATES: Array<{ name: string; requiredChecks: string; partialCoverage?: typeof PARTIAL_COVERAGE }> = [
  { name: "required_checks incomplete", requiredChecks: "incomplete" },
  { name: "#810 tool-loop partial coverage", requiredChecks: "complete", partialCoverage: PARTIAL_COVERAGE },
];

for (const state of INCOMPLETE_STATES) {
  for (const verdictPolicy of VERDICT_POLICIES) {
    test(`review_verdict: ${state.name} + approve (policy=${verdictPolicy ?? "default"}) never publishes APPROVE`, async () => {
      const api = new MockPublishApi();
      const result = await publishReview(input({
        mode: "review_verdict", allowApprove: true, verdict: "approve",
        requiredChecks: state.requiredChecks,
        ...(state.partialCoverage ? { partialCoverage: state.partialCoverage } : {}),
        ...(verdictPolicy ? { verdictPolicy } : {}),
      }), api, { diffText: "" });
      assert.equal(result.status, "published");
      assert.equal(api.submitted.length, 1);
      assert.notEqual(api.submitted[0]!.event, "APPROVE");
      assert.equal(api.submitted[0]!.event, "COMMENT");
      assert.match(api.submitted[0]!.body, /Approval withheld/);
    });

    test(`comment: ${state.name} + approve (policy=${verdictPolicy ?? "default"}) never headers as APPROVE`, async () => {
      const api = new MockPublishApi();
      await publishReview(input({
        mode: "comment", verdict: "approve",
        requiredChecks: state.requiredChecks,
        ...(state.partialCoverage ? { partialCoverage: state.partialCoverage } : {}),
        ...(verdictPolicy ? { verdictPolicy } : {}),
      }), api, { diffText: "" });
      const body = api.sticky[0]!.body;
      assert.ok(!body.includes("Automated recommendation: APPROVE"));
      assert.match(body, /INCOMPLETE — not an approval/);
    });

    test(`review_comment: ${state.name} + approve (policy=${verdictPolicy ?? "default"}) never submits a native APPROVE`, async () => {
      const api = new MockPublishApi();
      const result = await publishReview(input({
        mode: "review_comment", verdict: "approve",
        requiredChecks: state.requiredChecks,
        ...(state.partialCoverage ? { partialCoverage: state.partialCoverage } : {}),
        ...(verdictPolicy ? { verdictPolicy } : {}),
      }), api, { diffText: "" });
      assert.equal(result.status, "published");
      // review_comment never submits a native review event for the summary
      // (only best-effort inline COMMENT findings), so there is nothing to
      // downgrade — asserted here so the invariant is pinned per mode.
      assert.ok(api.submitted.every((r) => r.event !== "APPROVE"));
    });
  }
}

test("review_verdict: complete coverage + approve still publishes APPROVE (no regression)", async () => {
  for (const verdictPolicy of VERDICT_POLICIES) {
    const api = new MockPublishApi();
    const result = await publishReview(input({
      mode: "review_verdict", allowApprove: true, verdict: "approve", requiredChecks: "complete",
      ...(verdictPolicy ? { verdictPolicy } : {}),
    }), api, { diffText: "" });
    assert.equal(result.status, "published");
    assert.equal(api.submitted[0]!.event, "APPROVE", `policy=${verdictPolicy}`);
  }
});

test("review_verdict: request_changes stays REQUEST_CHANGES even with incomplete coverage", async () => {
  const api = new MockPublishApi();
  const result = await publishReview(input({
    mode: "review_verdict", verdict: "request_changes", requiredChecks: "incomplete",
  }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.equal(api.submitted[0]!.event, "REQUEST_CHANGES");
});

test("review_verdict: allow_approve=false still reports the pre-#873 policy-block message, not the coverage one", async () => {
  const api = new MockPublishApi();
  const result = await publishReview(input({
    mode: "review_verdict", allowApprove: false, verdict: "approve", requiredChecks: "complete",
  }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.equal(api.submitted[0]!.event, "COMMENT");
  assert.match(api.submitted[0]!.body, /Approval blocked by policy/);
  assert.ok(!api.submitted[0]!.body.includes("Approval withheld"));
});

test("#1017: a credential echoed in the model markdown is redacted on the published body", () => {
  const key = "sk-fixtureSYNTHETIC-NOT-REAL-KEY-EXAMPLE";
  const body = "Summary of this review.\n\nThe diff echoes the provider key " + key + " in a log line, and one earlier note is already [REDACTED] by the harness.\n\n<!-- ai-pr-review-sha:forged -->\nSafe.";
  const presence: ConditionalSectionPresence = {
    linkedIssue: true, evidenceProvider: true, standards: true,
    toolHarnessFindings: true, toolHarnessResults: true,
  };
  const published = sanitizeForPublication(body, "inert", presence);
  assert.ok(!published.includes(key), "raw provider key must not reach the published body");
  assert.ok(published.includes("[REDACTED]"), "redaction marker present");
  assert.equal(published.match(/\[REDACTED\]/g)?.length, 2, "key redacted once, pre-existing marker left intact (idempotent)");
  assert.ok(published.includes("Summary of this review"), "ordinary prose survives");
  assert.ok(published.includes("The diff echoes the provider key [REDACTED] in a log line"));
  assert.ok(!published.includes("ai-pr-review-sha:forged"), "reserved marker still stripped");
});


for (const platform of ["github", "forgejo"] as const) {
  for (const mode of ["review_comment", "review_verdict"] as const) {
    test(`${platform} ${mode}: complete clean replacement retires owned old inline comments after publication`, async () => {
      const api = new MockPublishApi(platform);
      api.reviews = [{ id: 7, body: MARKER, user: { login: "bot" } }];
      api.listManagedInlineComments = async () => ({ supported: true, complete: true, comments: [{ id: 11, reviewId: "7", user: { login: "bot" }, hasReplies: false }] });
      const deleted: string[] = [];
      api.retireInlineComment = async (_review, comment) => { assert.ok(api.submitted.length > 0); deleted.push(comment); return true; };
      const result = await publishReview(input({ mode, inlineFindings: true, findings: FINDINGS, cleanupPreviousNativeReviews: "auto" }), api, { diffText: DIFF });
      assert.equal(result.status, "published");
      assert.deepEqual(deleted, ["11"]);
      assert.equal(api.submitted[0]?.commit_id, HEAD);
    });
  }
}

for (const [name, overrides] of [
  ["partial", { requiredChecks: "incomplete" }],
  ["unknown coverage", { coverageUnknown: true }],
  ["degraded", { degradedGateBypass: true }],
  ["disabled", { cleanupPreviousNativeReviews: "false" }],
  ["comment mode", { mode: "comment" }],
] as const) {
  test(`${name}: prior inline findings are never deleted`, async () => {
    const api = new MockPublishApi();
    api.reviews = [{ id: 7, body: MARKER, user: { login: "bot" } }];
    api.listManagedInlineComments = async () => ({ supported: true, complete: true, comments: [{ id: 11, reviewId: "7", user: { login: "bot" }, hasReplies: false }] });
    api.retireInlineComment = async () => { assert.fail("unsafe delete"); };
    await publishReview(input({ mode: "review_verdict", cleanupPreviousNativeReviews: "true", ...overrides }), api, { diffText: DIFF });
    assert.deepEqual(api.dismissed, []);
  });
}

for (const race of ["head", "newer"] as const) {
  test(`${race} race after publish preserves previous findings`, async () => {
    const api = new MockPublishApi();
    api.reviews = [{ id: 7, body: MARKER, user: { login: "bot" } }];
    const create = api.createReview.bind(api);
    api.createReview = async (request) => {
      const result = await create(request);
      if (race === "head") api.head = "different";
      else api.reviews.push({ id: 2000, body: MARKER, user: { login: "bot" } });
      return result;
    };
    api.retireInlineComment = async () => { assert.fail("unsafe race deletion"); };
    await publishReview(input({ mode: "review_verdict", cleanupPreviousNativeReviews: "true" }), api, { diffText: DIFF });
    assert.deepEqual(api.dismissed, []);
  });
}

test("failed and plain fallback native submissions preserve previous findings", async () => {
  for (const results of [[{ ok: false }, { ok: false }], [{ ok: false }, { ok: true }]]) {
    const api = new MockPublishApi();
    api.reviews = [{ id: 7, body: MARKER, user: { login: "bot" } }];
    api.reviewResults = results;
    api.retireInlineComment = async () => { assert.fail("unsafe failure deletion"); };
    await publishReview(input({ mode: "review_verdict", cleanupPreviousNativeReviews: "true" }), api, { diffText: DIFF });
    assert.deepEqual(api.dismissed, []);
  }
});


test("cleanup cap skips cleanup but still removes the rerun label", async () => {
  const api = new MockPublishApi();
  // #1093: no inline findings means the sticky comment is the checkpoint.
  api.stickyResult = { ok: true, created: true, commentId: 9, updatedAt: "2026-01-01T00:00:00Z" };
  api.comments = [{ id: 9, body: MARKER, updated_at: "2026-01-01T00:00:00Z", user: { login: "bot" } }];
  api.reviews = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, body: MARKER, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" }));
  const result = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "true", rerunLabel: "ai-review" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.deepEqual(api.removedLabels, ["ai-review"]);
  assert.ok(result.messages.some((line) => line.includes("cleanup skipped")));
  assert.deepEqual(api.dismissed, []);
});

test("spoofed managed marker in a human review grants no cleanup authority", async () => {
  const api = new MockPublishApi();
  api.reviews = [{ id: 7, body: MARKER, state: "CHANGES_REQUESTED", user: { login: "human" } }];
  api.retireInlineComment = async () => { assert.fail("human review mutation"); };
  await publishReview(input({ mode: "review_verdict", cleanupPreviousNativeReviews: "true" }), api, { diffText: DIFF });
  assert.deepEqual(api.dismissed, []);
  assert.deepEqual(api.resolved, []);
});

// ---------------------------------------------------------------------------
// #1093: a clean re-review must not emit an empty native "Inline findings"
// review; cleanup keys on the sticky summary comment (or the replacement
// review) under the shared owner-identity policy.
// ---------------------------------------------------------------------------

test("#1093: a clean review_comment re-review publishes no empty native review and retires via the sticky checkpoint", async () => {
  const api = new MockPublishApi();
  api.reviews = [{ id: 7, body: MARKER, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" }];
  api.comments = [{ id: 9, body: MARKER, user: { login: "bot" }, updated_at: "2026-01-01T00:00:00Z" }];
  api.stickyResult = { ok: true, created: false, commentId: 9, updatedAt: "2026-01-01T00:00:00Z" };
  api.listManagedInlineComments = async (ids) => ids.length === 1 && ids[0] === "7"
    ? { supported: true, complete: true, comments: [{ id: 11, reviewId: "7", user: { login: "bot" }, hasReplies: false }] }
    : { supported: true, complete: false, comments: [] };
  const deleted: string[] = [];
  api.retireInlineComment = async (review, comment) => { deleted.push(`${review}/${comment}`); return true; };
  const result = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "auto" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.deepEqual(api.submitted, [], "a clean re-review must not create an empty native Inline findings review");
  assert.deepEqual(deleted, ["7/11"], "the previous run's owned inline comment is retired under the sticky checkpoint");
  assert.equal(api.sticky.length, 1);
  assert.ok(result.messages.some((line) => line.includes("Inline comments: eligible=1 retired=1")));
  assert.deepEqual(api.dismissed, []);
});

test("#1093: an unprovable identity fails closed — nothing is retired or dismissed, publication still succeeds", async () => {
  const api = new MockPublishApi();
  api.reviews = [{ id: 7, body: MARKER, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" }];
  api.comments = [{ id: 9, body: MARKER, user: { login: "bot" }, updated_at: "2026-01-01T00:00:00Z" }];
  api.stickyResult = { ok: true, created: false, commentId: 9, updatedAt: "2026-01-01T00:00:00Z" };
  api.listManagedInlineComments = async () => ({ supported: true, complete: true, comments: [{ id: 11, reviewId: "7", user: { login: "bot" }, hasReplies: false }] });
  api.identity = null;
  api.retireInlineComment = async () => { assert.fail("unprovable identity must never delete"); };
  api.dismissReview = async () => { assert.fail("unprovable identity must never dismiss"); };
  const result = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "auto" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.ok(
    result.messages.some((line) => line.includes("Could not verify authenticated owner") && line.includes("identity reason: unavailable")),
  );
  assert.ok(!result.messages.some((line) => line.includes("Inline comments:")), "no retirement ran");
});

test("#1093: a managed review published after the sticky checkpoint supersedes the run; cleanup is skipped", async () => {
  const api = new MockPublishApi();
  api.reviews = [{ id: 7, body: MARKER, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" }];
  api.comments = [{ id: 9, body: MARKER, user: { login: "bot" }, updated_at: "2026-01-01T00:00:00Z" }];
  api.stickyResult = { ok: true, created: false, commentId: 9, updatedAt: "2026-01-01T00:00:00Z" };
  api.listManagedInlineComments = async () => ({ supported: true, complete: true, comments: [{ id: 11, reviewId: "7", user: { login: "bot" }, hasReplies: false }] });
  const sticky = api.upsertStickyComment.bind(api);
  api.upsertStickyComment = async (marker, body) => {
    const result = await sticky(marker, body);
    api.reviews = [...api.reviews, { id: 2000, body: MARKER, user: { login: "bot" }, submitted_at: "2026-06-01T00:00:00Z" }];
    return result;
  };
  api.retireInlineComment = async () => { assert.fail("a superseded run must never delete"); };
  const result = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "auto" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.ok(result.messages.some((line) => line.includes("A newer review superseded this run; cleanup skipped")));
  assert.ok(!result.messages.some((line) => line.includes("Inline comments:")));
});

test("#1093: a sticky publication without a usable timestamp provides no cleanup checkpoint", async () => {
  // Missing updatedAt entirely: no checkpoint exists, so cleanup is skipped
  // with a bounded WARN (fail closed) — nothing is retired or dismissed.
  const missing = new MockPublishApi();
  missing.reviews = [{ id: 7, body: MARKER, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" }];
  missing.comments = [{ id: 9, body: MARKER, user: { login: "bot" }, updated_at: "2026-01-01T00:00:00Z" }];
  missing.stickyResult = { ok: true, created: false, commentId: 9 };
  missing.listManagedInlineComments = async () => ({ supported: true, complete: true, comments: [{ id: 11, reviewId: "7", user: { login: "bot" }, hasReplies: false }] });
  missing.retireInlineComment = async () => { assert.fail("no checkpoint must never delete"); };
  const missingResult = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "auto" }), missing, { diffText: "" });
  assert.equal(missingResult.status, "published");
  assert.ok(missingResult.messages.some((line) => line.includes("No replacement checkpoint")));
  assert.ok(!missingResult.messages.some((line) => line.includes("Inline comments:")));
  assert.deepEqual(missing.dismissed, []);

  // An unparseable timestamp still anchors a checkpoint, but the refreshed
  // sticky state can never satisfy it: cleanup is skipped with a WARN.
  const unparseable = new MockPublishApi();
  unparseable.reviews = [{ id: 7, body: MARKER, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" }];
  unparseable.comments = [{ id: 9, body: MARKER, user: { login: "bot" }, updated_at: "2026-01-01T00:00:00Z" }];
  unparseable.stickyResult = { ok: true, created: false, commentId: 9, updatedAt: "not-a-timestamp" };
  unparseable.listManagedInlineComments = async () => ({ supported: true, complete: true, comments: [{ id: 11, reviewId: "7", user: { login: "bot" }, hasReplies: false }] });
  unparseable.retireInlineComment = async () => { assert.fail("an unusable checkpoint must never delete"); };
  const unparseableResult = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "auto" }), unparseable, { diffText: "" });
  assert.equal(unparseableResult.status, "published");
  assert.ok(unparseableResult.messages.some((line) => line.includes("cleanup skipped")));
  assert.ok(!unparseableResult.messages.some((line) => line.includes("Inline comments:")));
  assert.deepEqual(unparseable.dismissed, []);
});

test("#1093: a failed inline-findings submission leaves the sticky unable to authorize retiring the previous set", async () => {
  // The native findings review IS the replacement for the old inline set.
  // If its submission fails, the sticky summary alone is not a complete
  // replacement, so cleanup must not retire the previous owned comments
  // (the invariant: retire only after a complete replacement at the head).
  const api = new MockPublishApi();
  api.reviews = [{ id: 7, body: MARKER, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" }];
  api.comments = [{ id: 9, body: MARKER, user: { login: "bot" }, updated_at: "2026-01-01T00:00:00Z" }];
  api.stickyResult = { ok: true, created: false, commentId: 9, updatedAt: "2026-01-01T00:00:00Z" };
  api.reviewResults = [{ ok: false, error: "422 unanchored finding" }];
  api.listManagedInlineComments = async () => ({ supported: true, complete: true, comments: [{ id: 11, reviewId: "7", user: { login: "bot" }, hasReplies: false }] });
  api.retireInlineComment = async () => { assert.fail("an unreplaced findings set must never be retired"); };
  const result = await publishReview(input({
    mode: "review_comment", inlineFindings: true, findings: FINDINGS,
    cleanupPreviousNativeReviews: "auto",
  }), api, { diffText: DIFF });
  assert.equal(result.status, "published");
  assert.equal(api.submitted.length, 1, "the findings review submission was attempted");
  assert.ok(result.messages.some((line) => line.includes("inline findings review submission failed")));
  assert.ok(result.messages.some((line) => line.includes("No replacement checkpoint")));
  assert.ok(!result.messages.some((line) => line.includes("Inline comments:")), "no retirement ran");
  assert.deepEqual(api.dismissed, []);
});

test("#1093: a sticky re-published after the checkpoint fails the still-current guard; cleanup is skipped", async () => {
  // Two overlapping same-head runs: run B PATCHes the sticky after run A
  // captured its checkpoint timestamp. Run A's refreshed-sticky read now
  // shows a NEWER instant, which proves re-publication, not still-current
  // state — run A must retire nothing.
  const api = new MockPublishApi();
  api.reviews = [{ id: 7, body: MARKER, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" }];
  api.stickyResult = { ok: true, created: false, commentId: 9, updatedAt: "2026-01-01T00:00:00Z" };
  api.comments = [{ id: 9, body: MARKER, user: { login: "bot" }, updated_at: "2026-06-01T00:00:00Z" }];
  api.listManagedInlineComments = async () => ({ supported: true, complete: true, comments: [{ id: 11, reviewId: "7", user: { login: "bot" }, hasReplies: false }] });
  api.retireInlineComment = async () => { assert.fail("a re-published sticky invalidates this run's checkpoint"); };
  const result = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "auto" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.ok(result.messages.some((line) => line.includes("A newer review superseded this run; cleanup skipped")));
  assert.ok(!result.messages.some((line) => line.includes("Inline comments:")));
  assert.deepEqual(api.dismissed, []);
});

// ---------------------------------------------------------------------------
// #1093: Forgejo Authorized Integration cleanup over the offline REST seam —
// the audience's owner id (`u:<id>:<uuid>`) proves ownership even though the
// repo-scoped JWT cannot read `GET /user`; credentials travel only in
// Authorization headers.
// ---------------------------------------------------------------------------

const FORGEJO_BASE = "https://forgejo.test";
const INTEGRATION_AUDIENCE = "u:7:12345678-1234-1234-1234-123456789abc";
const OIDC_ENDPOINT = "https://oidc.example/token?job=1";
const OIDC_REQUEST_URL = `${OIDC_ENDPOINT}&audience=${encodeURIComponent(INTEGRATION_AUDIENCE)}`;
const JWT_VALUE = "integration-jwt-value";
const OIDC_TOKEN_VALUE = "runner-oidc";

function withIntegrationOidcEnv(fn: () => Promise<void>): Promise<void> {
  const saved = {
    url: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  };
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = OIDC_ENDPOINT;
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = OIDC_TOKEN_VALUE;
  return fn().finally(() => {
    if (saved.url === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = saved.url;
    if (saved.token === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = saved.token;
  });
}

interface ForgejoCleanupScenario {
  reviews: unknown[];
  review5Comments: unknown[];
  review6Comments?: unknown[];
  userStatus?: number;
}

async function runIntegrationCleanupScenario(scenario: ForgejoCleanupScenario): Promise<{
  result: Awaited<ReturnType<typeof publishReview>>;
  requests: Array<{ method: string; url: string; auth: string | null; body: string }>;
}> {
  const requests: Array<{ method: string; url: string; auth: string | null; body: string }> = [];
  // The PATCH really does refresh the sticky comment's timestamp AND stores
  // the exact published body; later reads must observe both or the checkpoint
  // anchor could never be satisfied.
  let stickyUpdatedAt = "2025-01-01T00:00:00Z";
  let stickyBody = MARKER;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const auth = new Headers(init?.headers).get("authorization");
    requests.push({ method, url, auth, body });
    if (url === OIDC_REQUEST_URL) return Response.json({ value: JWT_VALUE });
    if (method === "GET" && url === `${FORGEJO_BASE}/api/v1/repos/o/r/pulls/42`) {
      return Response.json({ number: 42, head: { sha: HEAD } });
    }
    if (method === "GET" && url === `${FORGEJO_BASE}/api/v1/repos/o/r/issues/42/comments?limit=50&page=1`) {
      return Response.json([{ id: 3, body: stickyBody, user: { id: 7 }, updated_at: stickyUpdatedAt }]);
    }
    if (method === "PATCH" && url === `${FORGEJO_BASE}/api/v1/repos/o/r/issues/comments/3`) {
      stickyUpdatedAt = "2026-01-01T00:00:00Z";
      try { stickyBody = (JSON.parse(body) as { body?: string }).body ?? stickyBody; } catch { /* keep previous */ }
      return Response.json({ id: 3, updated_at: stickyUpdatedAt });
    }
    if (method === "GET" && url === `${FORGEJO_BASE}/api/v1/repos/o/r/pulls/42/reviews?limit=100&page=1`) {
      return Response.json(scenario.reviews);
    }
    if (method === "GET" && url === `${FORGEJO_BASE}/api/v1/repos/o/r/pulls/42/reviews/5/comments`) {
      return Response.json(scenario.review5Comments);
    }
    if (method === "GET" && url === `${FORGEJO_BASE}/api/v1/repos/o/r/pulls/42/reviews/6/comments`) {
      return Response.json(scenario.review6Comments ?? []);
    }
    if (method === "GET" && url === `${FORGEJO_BASE}/api/v1/user`) {
      return Response.json({}, { status: scenario.userStatus ?? 403 });
    }
    if (method === "DELETE" && url === `${FORGEJO_BASE}/api/v1/repos/o/r/pulls/42/reviews/5/comments/11`) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const api = new ForgejoPublishApi({
    repo: "o/r", prNumber: "42", baseUrl: FORGEJO_BASE, authMethod: "authorized_integration",
    authorizedIntegrationAudience: INTEGRATION_AUDIENCE, fetchImpl,
  });
  const result = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "auto" }), api, { diffText: "" });
  return { result, requests };
}

test("#1093: Forgejo authorized integration — a clean re-review retires the owned inline comment by user id without creating a native review", async () => withIntegrationOidcEnv(async () => {
  const { result, requests } = await runIntegrationCleanupScenario({
    reviews: [
      { id: 5, body: MARKER, user: { id: 7 }, state: "COMMENTED", submitted_at: "2025-01-01T00:00:00Z" },
      { id: 6, body: MARKER, user: { id: 99, login: "human" }, state: "CHANGES_REQUESTED", submitted_at: "2025-06-01T00:00:00Z" },
    ],
    review5Comments: [{ id: 11, pull_request_review_id: 5, user: { id: 7 } }],
    review6Comments: [{ id: 12, pull_request_review_id: 6, user: { id: 99, login: "human" } }],
  });
  assert.equal(result.status, "published");
  assert.equal(
    requests.filter((r) => r.method === "POST" && r.url.endsWith("/pulls/42/reviews")).length,
    0,
    "a clean re-review must not create an empty native Inline findings review",
  );
  assert.deepEqual(
    requests.filter((r) => r.method === "DELETE").map((r) => r.url),
    [`${FORGEJO_BASE}/api/v1/repos/o/r/pulls/42/reviews/5/comments/11`],
    "the owned inline comment (id-only author) is retired via the audience's user id",
  );
  assert.ok(!requests.some((r) => r.url.includes("/reviews/6/")), "the human's review and its comments are never touched");
  assert.ok(result.messages.some((line) => line.includes("Inline comments: eligible=1 retired=1")));
  // Secret travel: the JWT and the runner OIDC token appear only in
  // Authorization headers — never in any Forgejo URL or request body.
  for (const request of requests) {
    if (request.url !== FORGEJO_BASE && !request.url.startsWith(`${FORGEJO_BASE}/`)) continue;
    assert.equal(request.auth, `Bearer ${JWT_VALUE}`);
    assert.ok(!request.url.includes("token=") && !request.url.includes(JWT_VALUE) && !request.url.includes(OIDC_TOKEN_VALUE));
    assert.ok(!request.body.includes(JWT_VALUE) && !request.body.includes(OIDC_TOKEN_VALUE));
  }
  const exchange = requests.find((r) => r.url === OIDC_REQUEST_URL);
  assert.equal(exchange?.auth, `bearer ${OIDC_TOKEN_VALUE}`);
}));

test("#1093: Forgejo authorized integration — an inline comment whose author id does not match the audience is never deleted", async () => withIntegrationOidcEnv(async () => {
  const { result, requests } = await runIntegrationCleanupScenario({
    reviews: [{ id: 5, body: MARKER, user: { id: 8 }, state: "COMMENTED", submitted_at: "2025-01-01T00:00:00Z" }],
    review5Comments: [{ id: 11, pull_request_review_id: 5, user: { id: 8 } }],
  });
  assert.equal(result.status, "published");
  assert.equal(requests.filter((r) => r.method === "DELETE").length, 0);
  // #1093: an empty eligible set is a bounded, reported outcome — distinct
  // from the incomplete-enumeration refusal asserted in the next test and
  // from a run that never reached cleanup.
  assert.ok(
    result.messages.some((line) => line.includes("No managed native reviews owned by the trusted identity")),
    "no eligible prior managed reviews is reported, not silent",
  );
  assert.ok(!result.messages.some((line) => line.includes("Inline comments:")));
}));

test("#1093: Forgejo authorized integration — an inline comment with no attributed author fails the enumeration closed", async () => withIntegrationOidcEnv(async () => {
  const { result, requests } = await runIntegrationCleanupScenario({
    reviews: [{ id: 5, body: MARKER, user: { id: 7 }, state: "COMMENTED", submitted_at: "2025-01-01T00:00:00Z" }],
    review5Comments: [{ id: 11, pull_request_review_id: 5 }],
  });
  assert.equal(result.status, "published");
  assert.equal(requests.filter((r) => r.method === "DELETE").length, 0);
  assert.ok(result.messages.some((line) => line.includes("Inline-comment enumeration incomplete; no comments retired")));
}));

// ---------------------------------------------------------------------------
// #1093: repo-scoped Forgejo PAT cleanup over the offline REST seam — the
// token lacks the /user scope (403), so ownership is proven by the reaction
// self-write probe on the PR issue; the POST response's user.id attests the
// doer and the DELETE is best-effort.
// ---------------------------------------------------------------------------

const REPO_PAT = "repo-scoped-pat";
const REACTIONS_URL = `${FORGEJO_BASE}/api/v1/repos/o/r/issues/42/reactions`;

interface ForgejoTokenCleanupScenario {
  reviews: unknown[];
  review5Comments: unknown[];
  review6Comments?: unknown[];
  reactionPost?: { status: number; payload?: unknown };
  reactionDeleteStatus?: number;
  /** What the comments listing serves after the upsert; defaults to the exact body this run published. */
  stickyBodyOverride?: string;
}

async function runTokenCleanupScenario(scenario: ForgejoTokenCleanupScenario): Promise<{
  result: Awaited<ReturnType<typeof publishReview>>;
  requests: Array<{ method: string; url: string; auth: string | null; body: string }>;
}> {
  const requests: Array<{ method: string; url: string; auth: string | null; body: string }> = [];
  let stickyUpdatedAt = "2025-01-01T00:00:00Z";
  let stickyBody = MARKER;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const auth = new Headers(init?.headers).get("authorization");
    requests.push({ method, url, auth, body });
    if (method === "GET" && url === `${FORGEJO_BASE}/api/v1/repos/o/r/pulls/42`) {
      return Response.json({ number: 42, head: { sha: HEAD } });
    }
    if (method === "GET" && url === `${FORGEJO_BASE}/api/v1/repos/o/r/issues/42/comments?limit=50&page=1`) {
      return Response.json([{ id: 3, body: stickyBody, user: { id: 7 }, updated_at: stickyUpdatedAt }]);
    }
    if (method === "PATCH" && url === `${FORGEJO_BASE}/api/v1/repos/o/r/issues/comments/3`) {
      stickyUpdatedAt = "2026-01-01T00:00:00Z";
      try { stickyBody = (JSON.parse(body) as { body?: string }).body ?? stickyBody; } catch { /* keep previous */ }
      if (scenario.stickyBodyOverride !== undefined) stickyBody = scenario.stickyBodyOverride;
      return Response.json({ id: 3, updated_at: stickyUpdatedAt });
    }
    if (method === "GET" && url === `${FORGEJO_BASE}/api/v1/repos/o/r/pulls/42/reviews?limit=100&page=1`) {
      return Response.json(scenario.reviews);
    }
    if (method === "GET" && url === `${FORGEJO_BASE}/api/v1/repos/o/r/pulls/42/reviews/5/comments`) {
      return Response.json(scenario.review5Comments);
    }
    if (method === "GET" && url === `${FORGEJO_BASE}/api/v1/repos/o/r/pulls/42/reviews/6/comments`) {
      return Response.json(scenario.review6Comments ?? []);
    }
    if (method === "GET" && url === `${FORGEJO_BASE}/api/v1/user`) {
      return Response.json({}, { status: 403 });
    }
    if (method === "POST" && url === REACTIONS_URL) {
      return Response.json(scenario.reactionPost?.payload ?? { user: { id: 7 } }, { status: scenario.reactionPost?.status ?? 201 });
    }
    if (method === "DELETE" && url === REACTIONS_URL) {
      // The cleanup must mirror the POST's body so the forge deletes the
      // doer's `eyes` reaction instead of binding an empty reaction type.
      assert.equal(body, '{"content":"eyes"}', "DELETE body mirrors the POST");
      assert.equal(new Headers(init?.headers).get("content-type"), "application/json", "DELETE carries an explicit JSON content type");
      return new Response(null, { status: scenario.reactionDeleteStatus ?? 204 });
    }
    if (method === "DELETE" && url === `${FORGEJO_BASE}/api/v1/repos/o/r/pulls/42/reviews/5/comments/11`) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const api = new ForgejoPublishApi({
    repo: "o/r", prNumber: "42", baseUrl: FORGEJO_BASE, token: REPO_PAT, fetchImpl,
  });
  const result = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "auto" }), api, { diffText: "" });
  return { result, requests };
}

test("#1093: Forgejo repo-scoped PAT — cleanup retires only self-authored managed inline comments via the reaction-proven identity", async () => {
  const { result, requests } = await runTokenCleanupScenario({
    reviews: [
      { id: 5, body: MARKER, user: { id: 7 }, state: "COMMENTED", submitted_at: "2025-01-01T00:00:00Z" },
      { id: 6, body: MARKER, user: { id: 9, login: "foreign-bot" }, state: "COMMENTED", submitted_at: "2025-06-01T00:00:00Z" },
    ],
    review5Comments: [{ id: 11, pull_request_review_id: 5, user: { id: 7 } }],
    review6Comments: [{ id: 12, pull_request_review_id: 6, user: { id: 9, login: "foreign-bot" } }],
  });
  assert.equal(result.status, "published");
  // The cleanup flow resolves the trusted owner twice (in publishReview and
  // again inside retireManagedInlineComments), so the probe runs per
  // resolution; each POST is the bounded repo-scoped eyes reaction.
  assert.deepEqual(
    requests.filter((r) => r.method === "POST" && r.url === REACTIONS_URL).map((r) => r.body),
    ['{"content":"eyes"}', '{"content":"eyes"}'],
    "the probe posts repo-scoped eyes reactions",
  );
  assert.deepEqual(
    requests.filter((r) => r.method === "DELETE").map((r) => r.url),
    [REACTIONS_URL, REACTIONS_URL, `${FORGEJO_BASE}/api/v1/repos/o/r/pulls/42/reviews/5/comments/11`],
    "each reaction is cleaned up once and only the self-authored inline comment is retired",
  );
  assert.ok(!requests.some((r) => r.url.includes("/reviews/6/")), "the foreign-bot review and its comments are never touched");
  assert.ok(result.messages.some((line) => line.includes("Inline comments: eligible=1 retired=1")));
  // Secret travel: the PAT appears only in Authorization headers.
  for (const request of requests) {
    assert.equal(request.auth, `token ${REPO_PAT}`);
    assert.ok(!request.url.includes(REPO_PAT) && !request.body.includes(REPO_PAT));
  }
});

test("#1093: Forgejo repo-scoped PAT — a refused reaction probe fails closed and nothing is retired", async () => {
  const { result, requests } = await runTokenCleanupScenario({
    reviews: [{ id: 5, body: MARKER, user: { id: 7 }, state: "COMMENTED", submitted_at: "2025-01-01T00:00:00Z" }],
    review5Comments: [{ id: 11, pull_request_review_id: 5, user: { id: 7 } }],
    reactionPost: { status: 403, payload: {} },
  });
  assert.equal(result.status, "published");
  assert.ok(
    result.messages.some((line) => line.includes("Could not verify authenticated owner") && line.includes("identity reason: user-http-403-and-reaction-http-403") && line.includes("no inline comments retired")),
  );
  assert.equal(
    requests.filter((r) => r.method === "DELETE" && r.url !== REACTIONS_URL).length,
    0,
    "no inline comments are retired when the probe is refused",
  );
});

test("#1093: Forgejo REST seam — a same-second sticky re-publication with a different body fails the still-current guard", async () => {
  // The REST-seam variant of the MockPublishApi scenario: the sticky
  // comment's stored body differs from the body this run published (an
  // overlapping run re-published it in the same second), so the checkpoint's
  // body anchor fails the still-current guard even though the refreshed
  // timestamp equals the checkpoint.
  const { result, requests } = await runTokenCleanupScenario({
    reviews: [{ id: 5, body: MARKER, user: { id: 7 }, state: "COMMENTED", submitted_at: "2025-01-01T00:00:00Z" }],
    review5Comments: [{ id: 11, pull_request_review_id: 5, user: { id: 7 } }],
    stickyBodyOverride: `${MARKER}\nbody of the overlapping run`,
  });
  assert.equal(result.status, "published");
  assert.ok(result.messages.some((line) => line.includes("A newer review superseded this run; cleanup skipped")));
  assert.ok(!result.messages.some((line) => line.includes("Inline comments:")));
  assert.equal(
    requests.filter((r) => r.method === "DELETE" && r.url !== REACTIONS_URL).length,
    0,
    "a same-second re-publication with a different body retires nothing",
  );
});

test("#1093: a managed review submitted in the same second as the sticky checkpoint supersedes the run; cleanup is skipped", async () => {
  // The tie case: a competing managed review carries a timestamp EQUAL to the
  // sticky checkpoint, so it cannot be proven older than the checkpoint —
  // fail closed.
  const api = new MockPublishApi();
  api.reviews = [{ id: 7, body: MARKER, user: { login: "bot" }, submitted_at: "2026-01-01T00:00:00Z" }];
  api.comments = [{ id: 9, body: MARKER, user: { login: "bot" }, updated_at: "2026-01-01T00:00:00Z" }];
  api.stickyResult = { ok: true, created: false, commentId: 9, updatedAt: "2026-01-01T00:00:00Z" };
  api.listManagedInlineComments = async () => ({ supported: true, complete: true, comments: [{ id: 11, reviewId: "7", user: { login: "bot" }, hasReplies: false }] });
  api.retireInlineComment = async () => { assert.fail("a same-second managed review must fail the cleanup closed"); };
  const result = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "auto" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.ok(result.messages.some((line) => line.includes("A newer review superseded this run; cleanup skipped")));
  assert.ok(!result.messages.some((line) => line.includes("Inline comments:")));
  assert.deepEqual(api.dismissed, []);
});

test("#1093: a managed review with no usable timestamp fails the still-current guard closed; cleanup is skipped", async () => {
  // The absent-timestamp arm, distinct from the same-second tie above: a
  // managed review of ANY author (here a foreign identity, proving the check
  // is not ownership-scoped) with neither submitted_at nor updated_at cannot
  // be proven older than the checkpoint, so it fails the gate closed.
  const api = new MockPublishApi();
  api.reviews = [
    { id: 7, body: MARKER, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" },
    { id: 2000, body: MARKER, user: { login: "human" } },
  ];
  api.comments = [{ id: 9, body: MARKER, user: { login: "bot" }, updated_at: "2026-01-01T00:00:00Z" }];
  api.stickyResult = { ok: true, created: false, commentId: 9, updatedAt: "2026-01-01T00:00:00Z" };
  api.listManagedInlineComments = async () => ({ supported: true, complete: true, comments: [{ id: 11, reviewId: "7", user: { login: "bot" }, hasReplies: false }] });
  api.retireInlineComment = async () => { assert.fail("an unplaceable managed review must never delete"); };
  api.dismissReview = async () => { assert.fail("an unplaceable managed review must never dismiss"); };
  const result = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "auto" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.ok(result.messages.some((line) => line.includes("A newer review superseded this run; cleanup skipped")));
  assert.ok(!result.messages.some((line) => line.includes("Inline comments:")));
  assert.deepEqual(api.dismissed, []);
});

test("#1093: a sticky checkpoint comment owned by a foreign identity fails the still-current guard; cleanup is skipped", async () => {
  // Pins the sticky-ownership guard: the checkpoint comment must still be
  // authored by the identity this run proved. A foreign author's comment at
  // the checkpoint id attests nothing, so the gate fails closed.
  const api = new MockPublishApi();
  api.reviews = [{ id: 7, body: MARKER, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" }];
  api.comments = [{ id: 9, body: MARKER, user: { login: "human" }, updated_at: "2026-01-01T00:00:00Z" }];
  api.stickyResult = { ok: true, created: false, commentId: 9, updatedAt: "2026-01-01T00:00:00Z" };
  api.listManagedInlineComments = async () => ({ supported: true, complete: true, comments: [{ id: 11, reviewId: "7", user: { login: "bot" }, hasReplies: false }] });
  api.retireInlineComment = async () => { assert.fail("a foreign-authored sticky must never delete"); };
  api.dismissReview = async () => { assert.fail("a foreign-authored sticky must never dismiss"); };
  const result = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "auto" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.ok(result.messages.some((line) => line.includes("A newer review superseded this run; cleanup skipped")));
  assert.ok(!result.messages.some((line) => line.includes("Inline comments:")));
  assert.deepEqual(api.dismissed, []);
});

test("#1093: a sticky checkpoint comment that is not the managed body fails the still-current guard; cleanup is skipped", async () => {
  // Pins the managed-body guard on the refreshed sticky: an unannotated (or
  // near-miss) body at the checkpoint id is not this action's publication, so
  // it can never authorize retiring the previous owned inline comments.
  const api = new MockPublishApi();
  api.reviews = [{ id: 7, body: MARKER, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" }];
  api.comments = [{ id: 9, body: MARKER, user: { login: "bot" }, updated_at: "2026-01-01T00:00:00Z" }];
  api.stickyResult = { ok: true, created: false, commentId: 9, updatedAt: "2026-01-01T00:00:00Z" };
  api.listManagedInlineComments = async () => ({ supported: true, complete: true, comments: [{ id: 11, reviewId: "7", user: { login: "bot" }, hasReplies: false }] });
  // The stored comment loses the managed marker (near-miss prefix) after the
  // upsert, as a human edit or a spoofed id would.
  const sticky = api.upsertStickyComment.bind(api);
  api.upsertStickyComment = async (marker, body) => {
    const result = await sticky(marker, body);
    api.comments = api.comments.map((c) => String(c.id) === "9" ? { ...c, body: `${MARKER}x not this action's body` } : c);
    return result;
  };
  api.retireInlineComment = async () => { assert.fail("an unmanaged sticky must never delete"); };
  api.dismissReview = async () => { assert.fail("an unmanaged sticky must never dismiss"); };
  const result = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "auto" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.ok(result.messages.some((line) => line.includes("A newer review superseded this run; cleanup skipped")));
  assert.ok(!result.messages.some((line) => line.includes("Inline comments:")));
  assert.deepEqual(api.dismissed, []);
});

test("#1093: a same-second sticky re-publication with a different body fails the still-current guard; cleanup is skipped", async () => {
  // An overlapping run re-publishes the sticky in the SAME second (refreshed
  // timestamp equals the checkpoint) but with a DIFFERENT body; the
  // refreshedMs equality guard alone cannot detect this, so the checkpoint
  // also pins the exact published body.
  const api = new MockPublishApi();
  api.reviews = [{ id: 7, body: MARKER, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" }];
  api.comments = [{ id: 9, body: MARKER, user: { login: "bot" }, updated_at: "2026-01-01T00:00:00Z" }];
  api.stickyResult = { ok: true, created: false, commentId: 9, updatedAt: "2026-01-01T00:00:00Z" };
  api.listManagedInlineComments = async () => ({ supported: true, complete: true, comments: [{ id: 11, reviewId: "7", user: { login: "bot" }, hasReplies: false }] });
  const sticky = api.upsertStickyComment.bind(api);
  api.upsertStickyComment = async (marker, body) => {
    const result = await sticky(marker, body);
    api.comments = api.comments.map((c) => String(c.id) === "9" ? { ...c, body: `${MARKER}\nbody of the overlapping run` } : c);
    return result;
  };
  api.retireInlineComment = async () => { assert.fail("a same-second re-publication with a different body must fail cleanup closed"); };
  const result = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "auto" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.ok(result.messages.some((line) => line.includes("A newer review superseded this run; cleanup skipped")));
  assert.ok(!result.messages.some((line) => line.includes("Inline comments:")));
  assert.deepEqual(api.dismissed, []);
});

test("#1093: a sticky with the identical published body but a strictly later timestamp fails the refreshed-sticky guard; cleanup is skipped", async () => {
  // The body matches byte-for-byte, but the refreshed timestamp is strictly
  // later than the checkpoint: the existing refreshedMs guard alone fails
  // the still-current check closed.
  const api = new MockPublishApi();
  api.reviews = [{ id: 7, body: MARKER, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" }];
  api.stickyResult = { ok: true, created: false, commentId: 9, updatedAt: "2026-01-01T00:00:00Z" };
  api.comments = [{ id: 9, body: MARKER, user: { login: "bot" }, updated_at: "2026-06-01T00:00:00Z" }];
  api.listManagedInlineComments = async () => ({ supported: true, complete: true, comments: [{ id: 11, reviewId: "7", user: { login: "bot" }, hasReplies: false }] });
  api.retireInlineComment = async () => { assert.fail("a re-published sticky invalidates this run's checkpoint"); };
  const result = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "auto" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.ok(result.messages.some((line) => line.includes("A newer review superseded this run; cleanup skipped")));
  assert.ok(!result.messages.some((line) => line.includes("Inline comments:")));
  assert.deepEqual(api.dismissed, []);
});
