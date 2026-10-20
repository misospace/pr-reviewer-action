import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_FAILURE_GUIDANCE,
  evaluateApprovalGuardrails,
  FEEDBACK_ACTOR_CAP,
  markerReviewResult,
  publishReview,
  renderFindingsSummary,
  renderOutsideDiffSection,
  renderPartialCoverageNotice,
  resolveCleanupFlag,
  sanitizeForPublication,
} from "../src/publish/publish.js";
import { cleanupManagedReviews, retireManagedInlineComments, resolveSupersededThreads, hideSupersededManagedReviews } from "../src/publish/cleanup.js";
import { buildComments, prescriptionKey, prescriptionKeyDigest, FEEDBACK_AFFORDANCE, INLINE_DISCLAIMER } from "../src/publish/inline-findings.js";
import { enforcementView, normalizeThread } from "../src/context/review-threads.js";
import { applyReviewThreadEnforcement } from "../src/enforcement/threads.js";
import type { ReviewArtifact } from "../src/enforcement/artifact.js";
import type { TrustedOwnerIdentity } from "../src/platform/owner-identity.js";
import type { ConditionalSectionPresence } from "../src/publish/sanitize.js";
import { ForgejoPublishApi, forgejoReviewEvent } from "../src/platform/publish-api.js";
import type { FetchLike } from "../src/platform/http.js";
import type {
  CollaboratorPermissionReading,
  CommentFeedbackRecord,
  CommentFeedbackResult,
  ManagedInlineCommentRef,
  NativeReviewRequest,
  NativeReviewSurface,
  PublishCommentRef,
  PublishPlatformApi,
  PublishReviewRef,
  ReviewerRequestResult,
} from "../src/platform/publish-api.js";

const MARKER = "<!-- ai-pr-review -->";
const HEAD = "head-123";

class MockPublishApi implements PublishPlatformApi {
  readonly platform: "github" | "forgejo";
  readonly nativeReviewSurface: NativeReviewSurface = { supported: true };
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
  minimizeIdsError = false;
  /** #1144: the production GitHub adapter answers an unreadable minimized
   * state with an EMPTY SET (it never throws) — the minimized-state read is
   * an idempotency guard, not a safety gate. */
  minimizeIdsUnreadable = false;
  listReviewsError = false;
  inlineListCalls = 0;
  threadQueryCalls = 0;
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

  /** #762: the usefulness-feedback seams, assigned per test — an instance that
   * leaves them undefined models a forge without the capability. */
  reviewCommentFeedback?: (commentIds: readonly string[]) => Promise<CommentFeedbackResult>;
  collaboratorPermission?: (login: string) => Promise<CollaboratorPermissionReading | null>;
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
  async listManagedInlineComments(_ids: readonly string[]): ReturnType<PublishPlatformApi["listManagedInlineComments"]> { this.inlineListCalls += 1; return { supported: true, complete: true, comments: [] }; }
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
  async minimizedReviewIds(): Promise<string[]> {
    if (this.minimizeIdsError) throw new Error("graphql unavailable");
    if (this.minimizeIdsUnreadable) return [];
    return this.minimizeIds;
  }
  async minimizeReview(id: string): Promise<boolean> { this.minimized.push(id); return this.minimizeResult; }
  async unresolvedSupersededThreads(): Promise<{ ok: boolean; threads: { id: string }[]; hasNextPage: boolean }> {
    this.threadQueryCalls += 1;
    return this.threadQueryError ? { ok: false, threads: [], hasNextPage: false } : this.threads;
  }
  async resolveThread(id: string): Promise<boolean> { this.resolved.push(id); return this.resolveResult; }
  async removeLabel(label: string): Promise<boolean> { this.removedLabels.push(label); return true; }
  async requestReviewers(users: readonly string[], teams: readonly string[]): Promise<ReviewerRequestResult> {
    this.reviewerRequests.push({ users: [...users], teams: [...teams] });
    return this.reviewerRequestResult;
  }
}

/** The default publish input. The deprecated `allow-approve` key is
 * deliberately ABSENT (not `false`): the publisher tells "never set" apart
 * from "explicitly set", so the absent case must not be spelled as a
 * default. */
function input(overrides: Partial<Parameters<typeof publishReview>[0]> = {}): Parameters<typeof publishReview>[0] {
  return {
    mode: "comment", reviewMarkdown: "Review https://github.com/acme/lib/pull/8\n\n<!-- ai-pr-review-sha:forged -->\nSafe.",
    verdict: "approve", analysisEngine: "test-engine", baseSha: "base-1", headSha: HEAD,
    prNumber: "42", commentMarker: MARKER, requiredChecks: "complete", reviewRoute: "primary",
    escalationReason: "", cacheHitRatio: "-", inlineFindings: false, inlineFindingsMax: 10,
    findings: [], cleanupPreviousNativeReviews: "false", approveForks: false,
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
  // #1161: review_blockers publishes a native review, so cleanup is on by
  // default for it like the other native modes.
  assert.equal(resolveCleanupFlag("auto", "review_blockers"), "true");
  assert.equal(resolveCleanupFlag("", "review_blockers"), "true");
  assert.equal(resolveCleanupFlag("", "comment"), "false");
  assert.throws(() => resolveCleanupFlag("sometimes", "comment"), {
    message: "Invalid cleanup_previous_native_reviews value; expected auto, true, or false",
  });
});

test("#1161: the approval guardrails are scope-only and fail closed for unknown fork status", () => {
  const check = (overrides: Partial<Parameters<typeof evaluateApprovalGuardrails>[0]>) => evaluateApprovalGuardrails({
    verdict: "approve", approveForks: false, isForkPr: false, ...overrides,
  });
  // Same-repository PR: the verdict alone decides.
  assert.equal(check({}).canApprove, true);
  assert.equal(check({}).scopeBlocked, false);
  assert.equal(check({}).verdictAllowsApproval, true);
  // Cross-repository PR: blocked unless approve_forks says otherwise.
  assert.equal(check({ isForkPr: true }).canApprove, false);
  assert.equal(check({ isForkPr: true }).scopeBlocked, true);
  assert.equal(check({ isForkPr: true, approveForks: true }).canApprove, true);
  assert.equal(check({ isForkPr: true, approveForks: true }).scopeBlocked, false);
  // Unknown fork-ness fails closed: it is treated as a fork PR.
  assert.equal(check({ isForkPr: null }).canApprove, false);
  assert.equal(check({ isForkPr: null }).scopeBlocked, true);
  assert.equal(check({ isForkPr: null, approveForks: true }).canApprove, true);
  // A verdict that is not an approve never allows an approval.
  assert.equal(check({ verdict: "request_changes", approveForks: true }).canApprove, false);
  assert.equal(check({ verdict: "request_changes", approveForks: true }).verdictAllowsApproval, false);
  assert.equal(check({ verdict: "" }).canApprove, false);
  assert.equal(check({ verdict: "" }).scopeBlocked, false);
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

test("#1161: review_verdict publishes the verdict natively — a clean same-repository approve is an APPROVE", async () => {
  for (const [label, publishInput] of [
    ["allow-approve: false", input({ mode: "review_verdict", allowApprove: false })],
    ["allow-approve absent", input({ mode: "review_verdict" })],
  ] as const) {
    const api = new MockPublishApi();
    const result = await publishReview(publishInput, api, { diffText: "" });
    assert.equal(result.status, "published", label);
    assert.equal(api.submitted.length, 1, label);
    assert.equal(api.submitted[0]!.event, "APPROVE", label);
    assert.ok(result.messages.includes("Submitting native approval for #42"), label);
  }
});

test("#1161: review_verdict publishes a request_changes verdict as a native REQUEST_CHANGES", async () => {
  const api = new MockPublishApi();
  const result = await publishReview(input({ mode: "review_verdict", verdict: "request_changes" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.equal(api.submitted[0]!.event, "REQUEST_CHANGES");
  assert.equal(api.submitted[0]!.commit_id, HEAD);
  assert.ok(result.messages.includes("Submitting blocking findings for #42"));
});

test("#1161: a fork PR without approve-forks never approves and states the scope policy", async () => {
  const api = new MockPublishApi();
  const result = await publishReview(input({ mode: "review_verdict", isForkPr: true, approveForks: false }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.equal(api.submitted[0]!.event, "COMMENT");
  const body = api.submitted[0]!.body;
  assert.ok(body.includes("Approval withheld by scope policy"));
  assert.ok(body.includes("cross-repository (fork) pull request"));
  assert.ok(body.includes("approve-forks: false"));
  // The deprecated input is never named, and the old policy wording is gone.
  assert.ok(!body.includes("Approval blocked by policy"));
  assert.ok(!body.includes("allow_approve"));
  assert.ok(!body.includes("allow-approve"));
  assert.ok(result.messages.some((message) => message === "Withholding native approval for #42 (cross-repository PR, approve_forks=false, is_fork=true)"));
});

test("#1161: an undeterminable fork status fails closed like a fork PR", async () => {
  const api = new MockPublishApi();
  const result = await publishReview(input({ mode: "review_verdict", isForkPr: null, approveForks: false }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.equal(api.submitted[0]!.event, "COMMENT");
  assert.ok(api.submitted[0]!.body.includes("Approval withheld by scope policy"));
  assert.ok(api.submitted[0]!.body.includes("could not be determined"));
  assert.ok(result.messages.some((message) => message.includes("is_fork=unknown")));
});

test("#1161: a fork PR with approve-forks publishes the approve natively", async () => {
  const api = new MockPublishApi();
  const result = await publishReview(input({ mode: "review_verdict", isForkPr: true, approveForks: true }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.equal(api.submitted[0]!.event, "APPROVE");
});

test("#1161: review_blockers publishes blockers as a native REQUEST_CHANGES", async () => {
  const api = new MockPublishApi();
  const result = await publishReview(input({ mode: "review_blockers", verdict: "request_changes" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.equal(api.submitted[0]!.event, "REQUEST_CHANGES");
  assert.equal(api.submitted[0]!.commit_id, HEAD);
  assert.ok(result.messages.includes("Submitting blocking findings for #42"));
  // Nothing is withheld in this mode, so no advisory note is rendered.
  assert.ok(!api.submitted[0]!.body.includes("blockers-only mode"));
});

test("#1161: a blocking request is never downgraded by the scope or the coverage state", async () => {
  // The scope policy and the coverage gate withhold APPROVALS only. A
  // genuine blocking verdict must survive both: a fork PR, an
  // undeterminable fork state, and incomplete coverage all still publish
  // the REQUEST_CHANGES the model asked for.
  for (const [label, publishInput] of [
    ["review_blockers on a fork PR", input({ mode: "review_blockers", verdict: "request_changes", isForkPr: true })],
    ["review_blockers with incomplete coverage", input({ mode: "review_blockers", verdict: "request_changes", requiredChecks: "incomplete" })],
    ["review_verdict on a fork PR", input({ mode: "review_verdict", verdict: "request_changes", isForkPr: true })],
    ["review_verdict with an undeterminable fork state", input({ mode: "review_verdict", verdict: "request_changes", isForkPr: null })],
    ["review_verdict with incomplete coverage", input({ mode: "review_verdict", verdict: "request_changes", requiredChecks: "incomplete" })],
  ] as const) {
    const api = new MockPublishApi();
    const result = await publishReview(publishInput, api, { diffText: "" });
    assert.equal(result.status, "published", label);
    assert.equal(api.submitted[0]!.event, "REQUEST_CHANGES", label);
  }
});

test("#1161/#1145: a hostile verdict is never published as an approval, even under a permissive scope", async () => {
  // `toString` is the inherited-property trap for a plain object lookup:
  // a verdict map indexed without a type guard would read it as a verdict.
  for (const verdict of ["toString", "constructor", "hasOwnProperty", "APPROVE", ""]) {
    // #1145: in `review_verdict` a run without a valid final verdict is an
    // explicit action failure — nothing is published, so a hostile verdict
    // can never reach the forge at all.
    const api = new MockPublishApi();
    const result = await publishReview(input({
      mode: "review_verdict", verdict, isForkPr: true, approveForks: true,
    }), api, { diffText: "" });
    assert.equal(result.status, "failed", verdict);
    assert.equal(api.submitted.length, 0, verdict);
    assert.match(result.error ?? "", /#1145/, verdict);

    // #1161: the blockers-only mode publishes an advisory comment, so the
    // hostile verdict still has to be neutralized there.
    const blockersApi = new MockPublishApi();
    const blockersResult = await publishReview(input({
      mode: "review_blockers", verdict, isForkPr: true, approveForks: true,
    }), blockersApi, { diffText: "" });
    assert.equal(blockersResult.status, "published", verdict);
    assert.equal(blockersApi.submitted[0]!.event, "COMMENT", verdict);
    assert.ok(blockersApi.submitted[0]!.body.includes("No review verdict"), verdict);
  }
});

test("#1161: review_blockers never publishes an approval — a clean review is an advisory COMMENT", async () => {
  const api = new MockPublishApi();
  const result = await publishReview(input({ mode: "review_blockers" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.equal(api.submitted[0]!.event, "COMMENT");
  const body = api.submitted[0]!.body;
  assert.ok(body.includes("Advisory review (blockers-only mode)"));
  assert.ok(body.includes("publish-mode: review_blockers"));
  assert.ok(!body.includes("Approval blocked by policy"));
  assert.ok(!body.includes("Approval withheld"));
});

test("#1161: review_blockers never approves, even with every approval opt-in set", async () => {
  const api = new MockPublishApi();
  const result = await publishReview(input({
    mode: "review_blockers", allowApprove: true, approveForks: true, isForkPr: false,
  }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.equal(api.submitted[0]!.event, "COMMENT");
  assert.ok(!api.submitted[0]!.body.includes("Approval withheld"));
  assert.ok(!api.submitted[0]!.body.includes("Approval blocked by policy"));
});

test("#1161: the deprecated allow-approve input is inert — it never changes the published event", async () => {
  const events: string[] = [];
  for (const publishInput of [
    input({ mode: "review_verdict", allowApprove: false }),
    input({ mode: "review_verdict", allowApprove: true }),
    input({ mode: "review_verdict" }),
  ]) {
    const api = new MockPublishApi();
    const result = await publishReview(publishInput, api, { diffText: "" });
    assert.equal(result.status, "published");
    events.push(api.submitted[0]!.event);
  }
  assert.deepEqual(events, ["APPROVE", "APPROVE", "APPROVE"]);
});

test("#1161: an observed allow-approve warns about its deprecation; an absent input stays silent", async () => {
  // The publisher is told the input was set to a value that DIFFERS from
  // the contract default (the runner merges the default, so an explicit
  // "false" is indistinguishable from an unset one). Any observed value
  // warns — the operator has to learn the input no longer decides anything.
  for (const value of [true, false]) {
    const api = new MockPublishApi();
    const result = await publishReview(input({ mode: "review_verdict", allowApprove: value }), api, { diffText: "" });
    assert.ok(result.messages.some((message) => message.startsWith("WARN: ")
      && message.includes("'allow-approve' is deprecated")
      && message.includes("no longer affects publication")
      && message.includes(`value: ${value}`)
      && message.includes("publish-mode: review_blockers")), `value: ${value}`);
  }

  const absent = new MockPublishApi();
  const absentResult = await publishReview(input({ mode: "review_verdict" }), absent, { diffText: "" });
  assert.ok(!absentResult.messages.some((message) => message.includes("allow-approve")));
});

test("#1161/#1145: a missing or invalid verdict is never published as an approval or a blocking request", async () => {
  // `toString` is the hostile case for the verdict lookup: a plain object
  // index would return an inherited member instead of "no verdict".
  for (const verdict of ["", "maybe", "APPROVE", "toString"]) {
    // #1145: verdict mode fails the action — `COMMENTED` is not an
    // alternate failure state for a run that never produced a verdict.
    const api = new MockPublishApi();
    const result = await publishReview(input({ mode: "review_verdict", verdict }), api, { diffText: "" });
    assert.equal(result.status, "failed", `review_verdict/${verdict}`);
    assert.equal(api.submitted.length, 0, `review_verdict/${verdict}`);
    assert.match(result.error ?? "", /review_verdict mode requires a final verdict/, `review_verdict/${verdict}`);

    // #1161: the blockers-only mode publishes an advisory comment instead.
    const blockersApi = new MockPublishApi();
    const blockersResult = await publishReview(input({ mode: "review_blockers", verdict }), blockersApi, { diffText: "" });
    assert.equal(blockersResult.status, "published", `review_blockers/${verdict}`);
    assert.equal(blockersApi.submitted.length, 1, `review_blockers/${verdict}`);
    assert.equal(blockersApi.submitted[0]!.event, "COMMENT", `review_blockers/${verdict}`);
    assert.ok(blockersApi.submitted[0]!.body.includes("No review verdict"), `review_blockers/${verdict}`);
    assert.ok(blockersResult.messages.some((message) => message.includes("no valid verdict produced")), `review_blockers/${verdict}`);
  }
});

test("#1161: comment mode renders a verdict-neutral header for a missing or invalid verdict", async () => {
  for (const verdict of ["", "maybe", "toString"]) {
    const api = new MockPublishApi();
    await publishReview(input({ mode: "comment", verdict }), api, { diffText: "" });
    const body = api.sticky[0]!.body;
    assert.ok(body.includes("🟡 **Automated recommendation: NO VERDICT**"), verdict);
    assert.ok(!body.includes("Automated recommendation: APPROVE"), verdict);
  }
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

test("#847: tool_stop_reason reaches the published marker with complete coverage", async () => {
  const api = new MockPublishApi();
  await publishReview(
    input({ toolBudget: 26, toolBudgetSource: "size-scaled", toolCalls: 26, toolStopReason: "tool-call-budget-exhausted" }),
    api,
    { diffText: "" },
  );
  const marker = api.sticky[0]!.body.split("\n").find((line) => line.startsWith("<!-- ai-pr-reviewer:"));
  assert.ok(marker);
  // A budget stop whose coverage the corpus credit completed: no `coverage`
  // gap, yet the stop reason is still recorded for the exhaustion-rate
  // measurement.
  assert.ok(!marker.includes('"coverage":'));
  assert.ok(marker.includes('"tool_stop_reason":"tool-call-budget-exhausted"'));
  assert.ok(marker.indexOf('"tool_stop_reason"') > marker.indexOf('"tool_budget"'));
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
// gap) must never let a run READ as clean: the marker stays `partial` under
// every verdict policy. #1145 restated the event rule: in `review_verdict`
// the valid verdict publishes its native event with the gap stated (no
// COMMENT downgrade); comment-only modes still never header as an approval.
// Evidence: PR #854 published APPROVE with
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
    test(`review_verdict: ${state.name} + approve (policy=${verdictPolicy ?? "default"}) publishes APPROVE with an explicit gaps note (#1145)`, async () => {
      const api = new MockPublishApi();
      const result = await publishReview(input({
        mode: "review_verdict", allowApprove: true, verdict: "approve",
        requiredChecks: state.requiredChecks,
        ...(state.partialCoverage ? { partialCoverage: state.partialCoverage } : {}),
        ...(verdictPolicy ? { verdictPolicy } : {}),
      }), api, { diffText: "" });
      assert.equal(result.status, "published");
      assert.equal(api.submitted.length, 1);
      // #1145: the publish mode is authoritative — the verdict's native event
      // is never downgraded by a coverage/trace shortfall...
      assert.equal(api.submitted[0]!.event, "APPROVE", `policy=${verdictPolicy}`);
      // ...but the shortfall stays machine- and human-readable: partial
      // marker + explicit note on the approved review.
      assert.match(api.submitted[0]!.body, /Approval published with incomplete coverage/);
      assert.match(api.submitted[0]!.body, /"review_result":"partial"/);
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

test("review_verdict: an unknown coverage state names BOTH possible causes in the approval note", async () => {
  // #1145: coverage can be unknown because the run directory was missing OR
  // because the run directory's coverage artifact was unreadable or
  // unrecognized. The note must not claim the run directory was absent —
  // that would be a fact the publisher cannot know.
  const api = new MockPublishApi();
  const result = await publishReview(input({
    mode: "review_verdict", allowApprove: true, verdict: "approve", requiredChecks: "complete",
    coverageUnknown: true,
  }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.equal(api.submitted[0]!.event, "APPROVE");
  const body = api.submitted[0]!.body;
  assert.match(body, /Approval published with incomplete coverage/);
  assert.ok(body.includes("tool-loop coverage could not be verified"), "the stable phrase is kept");
  assert.ok(
    body.includes("(the run directory or its coverage artifact was unavailable to confirm it)"),
    "the parenthetical names both causes",
  );
  assert.ok(!body.includes("no run directory was available"), "the old, narrower claim is gone");
});

test("#1161: the deprecated allow-approve input no longer withholds an approval (the pre-#1161 policy-block message is gone)", async () => {
  const api = new MockPublishApi();
  const result = await publishReview(input({
    mode: "review_verdict", allowApprove: false, verdict: "approve", requiredChecks: "complete",
  }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.equal(api.submitted[0]!.event, "APPROVE");
  assert.ok(!api.submitted[0]!.body.includes("Approval blocked by policy"));
  assert.ok(!api.submitted[0]!.body.includes("Approval withheld"));
  assert.ok(!result.messages.some((message) => message.includes("Withholding native approval")));
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

test("#1136: a model-authored unclosed fence is dissolved before the conditional-section backstop sees it", () => {
  // Pinned composition decision: the walk's end-of-text dissolution makes a
  // formerly fence-hidden tail visible to stripEmptyConditionalSections, so
  // a conditional heading inside an unclosed block is now stripped by that
  // backstop's own policy instead of being trapped in an unterminated code
  // block that also swallowed everything published after the review body.
  const presence: ConditionalSectionPresence = {
    linkedIssue: false, evidenceProvider: true, standards: true,
    toolHarnessFindings: true, toolHarnessResults: true,
  };
  const published = sanitizeForPublication("Summary\n```md\n## Linked Issue Fit\n#123\n", "inert", presence);
  assert.ok(!published.includes("```md"), "the unclosed block is dissolved, not left open");
  assert.ok(!published.includes("## Linked Issue Fit"), "the hidden tail is no longer fence-inert, so the backstop's policy strips the section");
  assert.ok(published.includes("Summary"), "prose before the unclosed block survives");
  // And with the section marked present, the same tail survives verbatim —
  // the dissolution itself deletes nothing, the backstop's policy governs.
  const kept = sanitizeForPublication("Summary\n```md\n## Linked Issue Fit\n#123\n", "inert", { ...presence, linkedIssue: true });
  assert.equal(kept, "Summary\n\\`\\`\\`md\n## Linked Issue Fit\nPR 123\n", "with the section present, the dissolved tail survives verbatim");
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
  /** #1116: publish in inline-findings mode, so the run also enumerates prior
   * managed comments for the #762 carry marker and the #1027 finding-identity
   * marker — the two ownership consumers that share cleanup's proof. */
  inlineFindings?: boolean;
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
  const result = await publishReview(input({
    mode: "review_comment",
    inlineFindings: scenario.inlineFindings ?? false,
    cleanupPreviousNativeReviews: "auto",
  }), api, { diffText: "" });
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
  // #1099: the trusted owner is resolved once per publish run (in
  // publishReview) and threaded into retireManagedInlineComments, so the
  // Forgejo reaction self-write probe fires exactly once; the POST is the
  // bounded repo-scoped eyes reaction.
  assert.deepEqual(
    requests.filter((r) => r.method === "POST" && r.url === REACTIONS_URL).map((r) => r.body),
    ['{"content":"eyes"}'],
    "the probe posts exactly one repo-scoped eyes reaction per run",
  );
  assert.deepEqual(
    requests.filter((r) => r.method === "DELETE").map((r) => r.url),
    [REACTIONS_URL, `${FORGEJO_BASE}/api/v1/repos/o/r/pulls/42/reviews/5/comments/11`],
    "the reaction is cleaned up once and only the self-authored inline comment is retired",
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

/** #1116: a prior managed comment carrying BOTH the #762 carry marker and the
 * #1027 finding-identity marker, authored by the trusted owner — the fixture
 * that makes every ownership consumer in one run fire at once. */
const SHARED_OWNERSHIP_PRIOR_BODY = [
  "**Major (bug):** unchecked null deref",
  "",
  INLINE_DISCLAIMER,
  `<!-- pr-reviewer:rejected-prescriptions:v1:${"c".repeat(64)} -->`,
  `<!-- pr-reviewer:finding-id:v1:${"d".repeat(64)} -->`,
].join("\n");

test("#1116: Forgejo repo-scoped PAT — a run that ALSO carries prior managed comments still probes exactly once", async () => {
  // #1116: the probe-count pin above covers a run whose only ownership
  // consumer is cleanup. This run additionally carries a prior managed comment
  // bearing the #762 carry marker and the #1027 finding-identity marker, so
  // the carry-marker read and the outcome-identity read both need the same
  // proof cleanup already used. Three consumers, ONE probe: on a watched PR
  // each extra probe is another 👀 notification cycle, and a probe that fails
  // on its way out leaves a visible reaction behind.
  const { result, requests } = await runTokenCleanupScenario({
    reviews: [
      { id: 5, body: MARKER, user: { id: 7 }, state: "COMMENTED", submitted_at: "2025-01-01T00:00:00Z" },
      { id: 6, body: MARKER, user: { id: 9, login: "foreign-bot" }, state: "COMMENTED", submitted_at: "2025-06-01T00:00:00Z" },
    ],
    review5Comments: [{ id: 11, pull_request_review_id: 5, user: { id: 7 }, body: SHARED_OWNERSHIP_PRIOR_BODY }],
    review6Comments: [{ id: 12, pull_request_review_id: 6, user: { id: 9, login: "foreign-bot" } }],
    inlineFindings: true,
  });
  assert.equal(result.status, "published");
  assert.deepEqual(
    requests.filter((r) => r.method === "POST" && r.url === REACTIONS_URL).map((r) => r.body),
    ['{"content":"eyes"}'],
    "the carry-marker read, the outcome-identity read and cleanup share one probe",
  );
  assert.equal(
    requests.filter((r) => r.method === "DELETE" && r.url === REACTIONS_URL).length,
    1,
    "the probe is best-effort cleaned up exactly once",
  );
  // The shared proof still authorizes: the owned carry marker is trusted and
  // the owned inline comment is still retired.
  assert.ok(
    result.messages.some((line) => line.includes("1 carried rejection key(s) inherited")),
    "the reaction-proven identity still authorizes the carry marker",
  );
  assert.ok(result.messages.some((line) => line.includes("Inline comments: eligible=1 retired=1")));
  // Enumeration reads the foreign review's comments (a bounded read of prior
  // managed comments); what must never happen is any WRITE to them.
  assert.ok(
    !requests.some((r) => r.method === "DELETE" && r.url.includes("/reviews/6/")),
    "the foreign-bot review is never written to",
  );
});

test("#1116: a refused probe on the FIRST consumer fails cleanup closed — one probe, bounded WARN, nothing retired", async () => {
  // #1116 adversarial boundary: the shared resolution is poisoned by whichever
  // consumer asks FIRST. Here the carry-marker read asks first and its probe
  // is refused, so cleanup later receives a `null` identity it never proved
  // itself. Feeds the fence the hostile case: cleanup must fail closed on a
  // null it did not resolve, emit its bounded identity-reason WARN, and retire
  // nothing — while still proving ownership only once.
  const { result, requests } = await runTokenCleanupScenario({
    reviews: [{ id: 5, body: MARKER, user: { id: 7 }, state: "COMMENTED", submitted_at: "2025-01-01T00:00:00Z" }],
    review5Comments: [{ id: 11, pull_request_review_id: 5, user: { id: 7 }, body: SHARED_OWNERSHIP_PRIOR_BODY }],
    reactionPost: { status: 403, payload: {} },
    inlineFindings: true,
  });
  assert.equal(result.status, "published");
  assert.deepEqual(
    requests.filter((r) => r.method === "POST" && r.url === REACTIONS_URL).map((r) => r.body),
    ['{"content":"eyes"}'],
    "the refused probe is made once and reused, never re-attempted per consumer",
  );
  assert.ok(
    result.messages.some((line) => line.includes("Could not verify authenticated owner") && line.includes("identity reason:") && line.includes("no inline comments retired")),
    "cleanup fails closed on the shared null and still emits its bounded identity-reason WARN",
  );
  assert.ok(
    !result.messages.some((line) => line.includes("carried rejection key")),
    "the refused identity authorizes no carry digest either",
  );
  assert.equal(
    requests.filter((r) => r.method === "DELETE" && r.url !== REACTIONS_URL).length,
    0,
    "nothing is retired when the shared identity is unprovable",
  );
});

test("#1099: a resolved null identity threaded into retireManagedInlineComments retires nothing", async () => {
  // The identity proof is threaded in by the caller (#1099); when the run
  // resolved no trusted owner, retirement must fail closed before any
  // enumeration or deletion — and still emit the bounded identity-reason WARN.
  const api = new MockPublishApi();
  api.reviews = [{ id: 5, body: MARKER, user: { login: "bot" }, state: "COMMENTED", submitted_at: "2025-01-01T00:00:00Z" }];
  api.listManagedInlineComments = async () => {
    assert.fail("a null identity must never reach comment enumeration");
  };
  api.retireInlineComment = async () => {
    assert.fail("a null identity must never delete a comment");
  };
  const lines: string[] = [];
  await retireManagedInlineComments(api, api.reviews, MARKER, (line) => lines.push(line), { owner: null, reason: "unavailable" });
  assert.ok(
    lines.some((line) => line.includes("Could not verify authenticated owner") && line.includes("identity reason: unavailable") && line.includes("no inline comments retired")),
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

// ---------------------------------------------------------------------------
// #762: the usefulness-feedback surface, end to end. A trusted 👎 on the
// prior run's identical prescription removes only the replacement block; every
// uncertain state (unsupported reader, incomplete read, lookup failure, an
// unauthorized actor, the bot's own reaction) leaves publication exactly as
// it was, and the verdict is never involved.
// ---------------------------------------------------------------------------

interface PriorComment {
  /** Absent when the caller names the id at the use site. */
  id?: number;
  path: string;
  /** The published anchor: for a multi-line prescription this is its END. */
  line: number;
  /** Present exactly when the comment was published as a multi-line range. */
  startLine?: number;
  body: string;
  /** Set to model a reply that inherited its parent review's id. */
  inReplyToId?: number;
}

/** The comment a previous run of this action published for a finding. */
function priorPrescription(file: string, line: number, suggestion: string, endLine?: number): PriorComment {
  const diff = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,3 @@\n a\n+b\n+c\n`;
  const finding: Record<string, unknown> = { file, line, message: "m", suggestion };
  if (endLine !== undefined) finding.end_line = endLine;
  const built = buildComments([finding], diff, 20, { forgejoPositions: false });
  const comment = built.comments[0] as { path: string; body: string; line: number; start_line?: number };
  return {
    path: comment.path, line: comment.line, body: comment.body,
    ...(comment.start_line === undefined ? {} : { startLine: comment.start_line }),
  };
}

/** A mock whose feedback seams report the given prior comment and reactions,
 * counting every request each seam is asked to make. */
function feedbackApi(options: {
  prior?: PriorComment;
  /** Login the prior comment is attributed to (defaults to the bot). */
  priorAuthor?: string;
  /** Additional managed inline comments listed alongside `prior`. */
  extras?: Array<{ id: number; path: string; line: number; body: string; author?: string }>;
  records?: CommentFeedbackRecord[];
  permissions?: Record<string, CollaboratorPermissionReading | "error">;
  feedback?: "unsupported" | "incomplete" | "throws";
  identity?: string | null;
}): MockPublishApi & { feedbackCalls: number; permissionLookups: string[] } {
  const api = new MockPublishApi() as MockPublishApi & { feedbackCalls: number; permissionLookups: string[] };
  api.feedbackCalls = 0;
  api.permissionLookups = [];
  api.identity = options.identity === undefined ? "bot" : options.identity;
  api.reviews = [{ id: 7, body: `${MARKER}\n_Inline findings_`, user: { login: api.identity ?? "bot" } }];
  api.listManagedInlineComments = async () => ({
    supported: true,
    complete: true,
    comments: [
      ...(options.prior === undefined ? [] : [{
        id: options.prior.id ?? 501, reviewId: "7", path: options.prior.path, line: options.prior.line,
        ...(options.prior.startLine === undefined ? {} : { start_line: options.prior.startLine }),
        ...(options.prior.inReplyToId === undefined ? {} : { in_reply_to_id: options.prior.inReplyToId }),
        body: options.prior.body, user: { login: options.priorAuthor ?? api.identity ?? "bot" }, hasReplies: false,
      }]),
      ...(options.extras ?? []).map((extra) => ({
        id: extra.id, reviewId: "7", path: extra.path, line: extra.line,
        body: extra.body, user: { login: extra.author ?? api.identity ?? "bot" }, hasReplies: false,
      })),
    ],
  });
  api.reviewCommentFeedback = async (ids: readonly string[]) => {
    api.feedbackCalls += 1;
    if (options.feedback === "throws") throw new Error("reactions unavailable");
    if (options.feedback === "unsupported") return { supported: false, complete: false, records: [] };
    if (options.feedback === "incomplete") return { supported: true, complete: false, records: options.records ?? [] };
    return { supported: true, complete: true, records: options.records ?? [] };
  };
  api.collaboratorPermission = async (login: string) => {
    api.permissionLookups.push(login);
    const reading = options.permissions?.[login];
    if (reading === undefined) return null;
    if (reading === "error") throw new Error("collaborator lookup failed");
    return reading;
  };
  return api;
}

const PRIOR = priorPrescription("a.ts", 2, "REPL");
const ACTIONABLE = [{ file: "a.ts", line: 2, severity: "major", message: "A finding", suggestion: "REPL", agent_prompt: "apply the fix" }];

async function publishActionable(api: MockPublishApi, findings: unknown[] = ACTIONABLE): Promise<{ body: string; messages: string[] }> {
  const result = await publishReview(
    input({ mode: "review_comment", inlineFindings: true, findings, cleanupPreviousNativeReviews: "false" }),
    api,
    { diffText: DIFF },
  );
  assert.equal(result.status, "published");
  const comment = api.submitted.at(-1)?.comments?.[0];
  return { body: comment?.body ?? "", messages: result.messages };
}

test("#762: a trusted 👎 on the prior run's identical prescription suppresses the replacement only", async () => {
  const api = feedbackApi({
    prior: { id: 501, ...PRIOR },
    records: [{ commentId: "501", content: "-1", login: "maintainer" }],
    permissions: { maintainer: { permission: "write", roleName: "", subject: "absent" } },
  });
  const { body, messages } = await publishActionable(api);
  assert.equal(body.includes("```suggestion"), false);
  assert.equal(body.includes("REPL"), false);
  assert.ok(body.startsWith("**⚠️ Major:** A finding"));
  assert.ok(body.includes("Suggested agent prompt") && body.includes("apply the fix"));
  assert.equal(body.includes(FEEDBACK_AFFORDANCE), false, "a suppressed prescription offers no affordance");
  assert.deepEqual(api.submitted.at(-1)!.comments?.[0], { path: "a.ts", line: 2, side: "RIGHT", body });
  const telemetry = messages.filter((line) => line.includes("usefulness feedback"));
  assert.equal(telemetry.length, 1);
  assert.ok(telemetry[0]!.includes("inspected 1 prior comment(s)"));
  assert.ok(telemetry[0]!.includes("1 trusted rejection(s)"));
  assert.ok(telemetry[0]!.includes("1 suppressed prescription(s)"));
  // Telemetry is counts only: no reaction login and no comment body.
  assert.equal(messages.join("\n").includes("maintainer"), false);
  assert.equal(messages.join("\n").includes("A finding"), false);
});

test("#762: only an authorized actor's rejection suppresses; every uncertain actor stays telemetry", async () => {
  const cases: Array<[string, CollaboratorPermissionReading | "error" | undefined]> = [
    ["write", { permission: "write", roleName: "", subject: "absent" }],
    ["admin", { permission: "admin", roleName: "", subject: "absent" }],
    ["owner", { permission: "owner", roleName: "", subject: "absent" }],
    ["collapsed-triage", { permission: "read", roleName: "triage", subject: "absent" }],
    ["named-self", { permission: "write", roleName: "", subject: "named", subjectLogin: "reviewer" }],
    ["read", { permission: "read", roleName: "", subject: "absent" }],
    ["none", { permission: "none", roleName: "", subject: "absent" }],
    ["unknown-value", { permission: "some-future-role", roleName: "", subject: "absent" }],
    ["lookup-error", "error"],
    ["no-reading", undefined],
    ["other-subject", { permission: "admin", roleName: "", subject: "named", subjectLogin: "someone-else" }],
    ["unusable-subject", { permission: "admin", roleName: "", subject: "unusable" }],
  ];
  for (const [label, reading] of cases) {
    // The trusted-actor bar, restated: an authorized permission (with the
    // un-collapsed role name when the forge collapsed it) AND a response
    // subject that either names this actor or names none. A lookup failure,
    // a missing reading, and an unusable subject are all "not trusted".
    const suppressing = reading !== undefined && reading !== "error"
      && reading.subject !== "unusable"
      && (reading.subject === "absent" || reading.subjectLogin === "reviewer")
      && (["admin", "maintain", "write", "triage", "owner"].includes(reading.permission)
        || (reading.permission === "read" && ["triage", "triage_plus"].includes(reading.roleName)));
    const api = feedbackApi({
      prior: { id: 501, ...PRIOR },
      records: [{ commentId: "501", content: "-1", login: "reviewer" }],
      permissions: reading === undefined ? {} : { reviewer: reading },
    });
    const { body, messages } = await publishActionable(api);
    assert.equal(body.includes("```suggestion"), !suppressing, `${label}: suppression must be ${suppressing}`);
    const telemetry = messages.find((line) => line.includes("usefulness feedback")) ?? "";
    assert.ok(telemetry.includes(suppressing ? "1 trusted rejection(s)" : "0 trusted rejection(s)"), `${label}: ${telemetry}`);
  }
});

test("#762: the bot's own reaction never suppresses, and a 👍 never does either", async () => {
  const own = feedbackApi({
    prior: { id: 501, ...PRIOR },
    records: [{ commentId: "501", content: "-1", login: "bot" }],
    permissions: { bot: { permission: "admin", roleName: "", subject: "absent" } },
  });
  const selfRejected = await publishActionable(own);
  assert.equal(selfRejected.body.includes("```suggestion"), true);
  assert.ok(selfRejected.messages.some((line) => line.includes("0 trusted rejection(s)")));

  const thumbs = feedbackApi({
    prior: { id: 501, ...PRIOR },
    records: [{ commentId: "501", content: "+1", login: "maintainer" }],
    permissions: { maintainer: { permission: "admin", roleName: "", subject: "absent" } },
  });
  const liked = await publishActionable(thumbs);
  assert.equal(liked.body.includes("```suggestion"), true);
  assert.ok(liked.messages.some((line) => line.includes("0 trusted rejection(s)")));
});

test("#762: an unresolvable authenticated identity authorizes nobody — the bot-self exclusion is required proof", async () => {
  for (const [label, identityOverride] of [
    ["null-identity", undefined],
    ["throwing-identity", "throws"],
  ] as Array<[string, "throws" | undefined]>) {
    const api = feedbackApi({
      prior: { id: 501, ...PRIOR },
      records: [{ commentId: "501", content: "-1", login: "maintainer" }],
      // A permission read that WOULD authorize this actor: only the missing
      // identity proof must stand between the reaction and suppression.
      permissions: { maintainer: { permission: "admin", roleName: "", subject: "absent" } },
      identity: null,
    });
    if (identityOverride === "throws") {
      api.authenticatedIdentity = async () => { throw new Error("identity unavailable"); };
    }
    const { body, messages } = await publishActionable(api);
    assert.ok(body.includes("```suggestion") && body.includes("REPL"), `${label}: nothing is suppressed`);
    assert.ok(messages.some((line) => line.includes("0 trusted rejection(s)")), `${label}: ${messages.join("\n")}`);
    assert.deepEqual(api.permissionLookups, [], `${label}: nobody is verified without the exclusion proof`);
    assert.ok(messages.some((line) => line.includes("usefulness feedback")), `${label}: the read itself still happened`);
  }
});

test("#762: the reacting bot's own login is excluded by its resolved identity, and a distinct identity still suppresses", async () => {
  // The bot's own 👎 — its identity resolves to the reacting login, so the
  // reaction is the publisher's own and never a rejection signal, even though
  // its permission would pass the collaborator gate.
  const own = feedbackApi({
    prior: { id: 501, ...PRIOR },
    records: [{ commentId: "501", content: "-1", login: "ci-bot" }],
    permissions: { "ci-bot": { permission: "admin", roleName: "", subject: "absent" } },
    identity: "ci-bot",
  });
  const selfRejected = await publishActionable(own);
  assert.ok(selfRejected.body.includes("```suggestion"));
  assert.ok(selfRejected.messages.some((line) => line.includes("0 trusted rejection(s)")));

  // A distinct identity leaves the trusted-👍 suppression intact end to end,
  // with the identity read made at most once for the whole run.
  let identityCalls = 0;
  const other = feedbackApi({
    prior: { id: 501, ...PRIOR },
    records: [{ commentId: "501", content: "-1", login: "maintainer" }],
    permissions: { maintainer: { permission: "write", roleName: "", subject: "absent" } },
    identity: "ci-bot",
  });
  const resolved = other.authenticatedIdentity.bind(other);
  other.authenticatedIdentity = async () => { identityCalls += 1; return resolved(); };
  const suppressed = await publishActionable(other);
  assert.equal(suppressed.body.includes("```suggestion"), false);
  assert.ok(suppressed.messages.some((line) => line.includes("1 trusted rejection(s)")));
  assert.equal(identityCalls, 1);
});

test("#762: a whitespace-only or non-string identity is unprovable — nobody is authorized", async () => {
  for (const [label, identity] of [["whitespace-only", "   "], ["non-string", 7]] as Array<[string, unknown]>) {
    const api = feedbackApi({
      prior: { id: 501, ...PRIOR },
      records: [{ commentId: "501", content: "-1", login: "maintainer" }],
      permissions: { maintainer: { permission: "admin", roleName: "", subject: "absent" } },
      identity: null,
    });
    (api as unknown as { identity: unknown }).identity = identity;
    const { body } = await publishActionable(api);
    assert.ok(body.includes("```suggestion") && body.includes("REPL"), `${label}: nothing is suppressed`);
    assert.deepEqual(api.permissionLookups, [], `${label}: nobody is verified without the exclusion proof`);
  }
});

test("#762: the identity read is made at most once across multiple distinct reacting logins", async () => {
  const api = feedbackApi({
    prior: { id: 501, ...PRIOR },
    records: [
      { commentId: "501", content: "-1", login: "alice" },
      { commentId: "501", content: "-1", login: "bob" },
    ],
    permissions: {
      alice: { permission: "write", roleName: "", subject: "absent" },
      bob: { permission: "triage", roleName: "", subject: "absent" },
    },
    identity: "ci-bot",
  });
  const resolved = api.authenticatedIdentity.bind(api);
  let identityCalls = 0;
  api.authenticatedIdentity = async () => { identityCalls += 1; return resolved(); };
  const { messages } = await publishActionable(api);
  assert.ok(messages.some((line) => line.includes("2 trusted rejection(s)")), messages.join("\n"));
  assert.equal(identityCalls, 1);
});

test("#762: the feedback read is fail-open — an unsupported, incomplete, or throwing read changes nothing", async () => {
  for (const feedback of ["unsupported", "incomplete", "throws"] as const) {
    const api = feedbackApi({
      prior: { id: 501, ...PRIOR },
      records: [{ commentId: "501", content: "-1", login: "maintainer" }],
      permissions: { maintainer: { permission: "admin", roleName: "", subject: "absent" } },
      feedback,
    });
    const { body, messages } = await publishActionable(api);
    assert.ok(body.includes("```suggestion") && body.includes("REPL"), `${feedback}: the prescription still posts`);
    assert.equal(messages.some((line) => line.includes("usefulness feedback")), false);
  }
  // A seam the forge does not implement at all (no reader, no permission read)
  // leaves the run byte-identical to the pre-#762 behavior.
  const plain = new MockPublishApi();
  const result = await publishReview(
    input({ mode: "review_comment", inlineFindings: true, findings: ACTIONABLE, cleanupPreviousNativeReviews: "false" }),
    plain,
    { diffText: DIFF },
  );
  assert.equal(result.status, "published");
  assert.equal(result.messages.some((line) => line.includes("usefulness feedback")), false);
  const comment = plain.submitted.at(-1)!.comments![0]!;
  assert.ok(comment.body.includes("```suggestion"));
});

test("#762: a prior comment we cannot read a prescription from never suppresses", async () => {
  const api = feedbackApi({
    prior: { id: 501, path: "a.ts", line: 2, body: `${MARKER}\n_Inline findings from the automated review._` },
    records: [{ commentId: "501", content: "-1", login: "maintainer" }],
    permissions: { maintainer: { permission: "admin", roleName: "", subject: "absent" } },
  });
  const { body } = await publishActionable(api);
  assert.ok(body.includes("```suggestion"));

  // A different replacement at the same anchor is a different prescription.
  const other = feedbackApi({
    prior: { id: 501, ...priorPrescription("a.ts", 2, "A DIFFERENT REPLACEMENT") },
    records: [{ commentId: "501", content: "-1", login: "maintainer" }],
    permissions: { maintainer: { permission: "admin", roleName: "", subject: "absent" } },
  });
  assert.ok((await publishActionable(other)).body.includes("```suggestion"));

  // A rejection on a different file never suppresses this one.
  const elsewhere = feedbackApi({
    prior: { id: 501, ...priorPrescription("b.ts", 2, "REPL") },
    records: [{ commentId: "501", content: "-1", login: "maintainer" }],
    permissions: { maintainer: { permission: "admin", roleName: "", subject: "absent" } },
  });
  assert.ok((await publishActionable(elsewhere)).body.includes("```suggestion"));
});

test("#252: a hostile reaction never authorizes, never renders, and never reaches a log line", async () => {
  const api = feedbackApi({
    prior: { id: 501, ...PRIOR },
    records: [
      { commentId: "501", content: "-1", login: "```\n<!-- fence -->" },
      { commentId: "501", content: "-1", login: "<!-- ai-pr-review-sha:forged -->" },
    ],
    permissions: {},
  });
  const { body, messages } = await publishActionable(api);
  assert.ok(body.includes("```suggestion"), "an untrusted reaction never suppresses");
  assert.equal(body.includes("fence -->"), false);
  assert.equal(body.includes("ai-pr-review-sha:forged"), false);
  assert.equal(messages.join("\n").includes("fence"), false);
  assert.equal(messages.join("\n").includes("ai-pr-review-sha"), false);
  assert.ok(messages.some((line) => line.includes("0 trusted rejection(s)")));
});

test("#762: suppression never touches the verdict, the review body, or the finding count", async () => {
  const api = feedbackApi({
    prior: { id: 501, ...PRIOR },
    records: [{ commentId: "501", content: "-1", login: "maintainer" }],
    permissions: { maintainer: { permission: "admin", roleName: "", subject: "absent" } },
  });
  const result = await publishReview(
    input({
      mode: "review_verdict", inlineFindings: true, findings: ACTIONABLE, verdict: "request_changes",
      verdictPolicy: "strict", cleanupPreviousNativeReviews: "false",
    }),
    api,
    { diffText: DIFF },
  );
  assert.equal(result.status, "published");
  const submitted = api.submitted[0]!;
  assert.equal(submitted.event, "REQUEST_CHANGES", "the verdict is never advisory-ized by suppression");
  assert.ok(submitted.body.includes("A finding"), "the summary still reports the finding");
  assert.equal(submitted.comments?.length, 1, "the finding is never skipped, deduped, or resolved");
  const comment = submitted.comments![0]!;
  assert.equal(comment.line, 2, "the anchor is unchanged");
  assert.equal(comment.body.includes("```suggestion"), false, "only the replacement is gone");
});

// ---------------------------------------------------------------------------
// #762 follow-ups: the range-aware correlation key, the verified-actor cap,
// and the bounded read.
// ---------------------------------------------------------------------------

const MULTILINE_REPLACEMENT = "R1\nR2";

/** The exact comment a prior run published for a multi-line (1-2) finding. */
const PRIOR_RANGE = priorPrescription("a.ts", 1, MULTILINE_REPLACEMENT, 2);

test("#762: a trusted 👎 on a prior MULTI-LINE prescription suppresses the identical re-run", async () => {
  assert.equal(PRIOR_RANGE.line, 2, "the prior run published the range END as its anchor");
  assert.equal(PRIOR_RANGE.startLine, 1);
  const api = feedbackApi({
    prior: { id: 501, ...PRIOR_RANGE },
    records: [{ commentId: "501", content: "-1", login: "maintainer" }],
    permissions: { maintainer: { permission: "write", roleName: "", subject: "absent" } },
  });
  const { body, messages } = await publishActionable(api, [
    { file: "a.ts", line: 1, end_line: 2, severity: "major", message: "A finding", suggestion: MULTILINE_REPLACEMENT },
  ]);
  assert.equal(body.includes("```suggestion"), false, "the identical 1-2 prescription is not re-posted");
  assert.equal(body.includes("R1"), false);
  assert.ok(body.includes("**⚠️ Major:** A finding"));
  assert.ok(messages.some((line) => line.includes("1 suppressed prescription(s)")));
});

test("#762: a prior 1-2 rejection never suppresses a single-line-at-2 finding with the same text", async () => {
  const api = feedbackApi({
    prior: { id: 501, ...PRIOR_RANGE },
    records: [{ commentId: "501", content: "-1", login: "maintainer" }],
    permissions: { maintainer: { permission: "admin", roleName: "", subject: "absent" } },
  });
  const { body } = await publishActionable(api, [
    { file: "a.ts", line: 2, severity: "major", message: "A finding", suggestion: MULTILINE_REPLACEMENT },
  ]);
  assert.ok(body.includes("```suggestion"), "a different published range is a different prescription");
  assert.ok(body.includes("R1\nR2"));
});

test("#762: key equality requires identical replacement text over the same range", async () => {
  const api = feedbackApi({
    prior: { id: 501, ...PRIOR_RANGE },
    records: [{ commentId: "501", content: "-1", login: "maintainer" }],
    permissions: { maintainer: { permission: "admin", roleName: "", subject: "absent" } },
  });
  const { body } = await publishActionable(api, [
    { file: "a.ts", line: 1, end_line: 2, severity: "major", message: "A finding", suggestion: "R1\nDIFFERENT" },
  ]);
  assert.ok(body.includes("```suggestion"));
  assert.ok(body.includes("DIFFERENT"));
});

test("#762: past the verification cap no actor is looked up and nothing is suppressed", async () => {
  const logins = Array.from({ length: FEEDBACK_ACTOR_CAP + 1 }, (_, i) => `reactor-${i}`);
  const permissions: Record<string, CollaboratorPermissionReading> = {};
  for (const login of logins) permissions[login] = { permission: "admin", roleName: "", subject: "absent" };
  const api = feedbackApi({
    prior: { id: 501, ...PRIOR },
    records: logins.map((login) => ({ commentId: "501", content: "-1", login })),
    permissions,
  });
  const { body, messages } = await publishActionable(api);
  assert.deepEqual(api.permissionLookups, [], "untrusted reactors can never drive a request");
  assert.equal(api.feedbackCalls, 1);
  assert.ok(body.includes("```suggestion"), "an over-cap read trusts nobody (fail-open)");
  const telemetry = messages.find((line) => line.includes("usefulness feedback")) ?? "";
  assert.ok(telemetry.includes("0 trusted rejection(s)"), telemetry);
  assert.ok(telemetry.includes(`${FEEDBACK_ACTOR_CAP + 1} login(s) past the verification cap`), telemetry);
  assert.equal(telemetry.includes("reactor-0"), false, "telemetry is counts only");
  // At the cap exactly, the read proceeds.
  const atCap = feedbackApi({
    prior: { id: 501, ...PRIOR },
    records: logins.slice(0, FEEDBACK_ACTOR_CAP).map((login) => ({ commentId: "501", content: "-1", login })),
    permissions,
  });
  await publishActionable(atCap);
  assert.equal(atCap.permissionLookups.length, FEEDBACK_ACTOR_CAP);
});

test("#762: a run with no usable suggestion issues zero feedback or permission requests", async () => {
  const api = feedbackApi({
    prior: { id: 501, ...PRIOR },
    records: [{ commentId: "501", content: "-1", login: "maintainer" }],
    permissions: { maintainer: { permission: "admin", roleName: "", subject: "absent" } },
  });
  const nonActionable: unknown[][] = [
    [],
    [{ file: "a.ts", line: 2, message: "A finding" }],
    [{ file: "a.ts", line: 2, message: "m", suggestion: "\n" }],
    [{ file: "a.ts", line: 2, message: "m", suggestion: 7 }],
    [{ file: "a.ts", line: 2, message: "m", suggestion: null }],
  ];
  for (const findings of nonActionable) {
    await publishActionable(api, findings);
    assert.equal(api.feedbackCalls, 0);
    assert.deepEqual(api.permissionLookups, []);
  }
  // An actionable finding in the same run does turn the read back on — and the
  // pre-check uses exactly the validation the renderer uses, so a
  // whitespace-only replacement (which publishablePrescription still renders) counts.
  await publishActionable(api, [{ file: "a.ts", line: 2, message: "m", suggestion: "  " }]);
  assert.equal(api.feedbackCalls, 1);
  await publishActionable(api);
  assert.equal(api.feedbackCalls, 2);
});

test("#1107: the feedback pre-check and publication agree — the read runs exactly when a prescription renders", async () => {
  // #1107: the pre-check asks publication's own question through publication's
  // own predicates, so a shape that renders no prescription must spend ZERO
  // reaction reads and ZERO permission lookups. Each arm below pins one of the
  // four ways `publishablePrescription` returns null, plus the positive control
  // that turns the read back on.
  const MARKER_LINE = `<!-- pr-reviewer:rejected-prescriptions:v1:${"a".repeat(64)} -->`;
  const arms: Array<[string, unknown[], boolean]> = [
    // Blank: the replacement normalizes to nothing, so no block is rendered.
    // (A spaces-only replacement is NOT this shape — it renders a whitespace
    // block, and is pinned as actionable by the "no usable suggestion" test
    // above.)
    ["empty-string", [{ file: "a.ts", line: 2, message: "A finding", suggestion: "" }], false],
    ["newline-only", [{ file: "a.ts", line: 2, message: "A finding", suggestion: "\n" }], false],
    ["newline-only-multi", [{ file: "a.ts", line: 2, message: "A finding", suggestion: "\n\n\n" }], false],
    // Fence-hostile: a line whose trim opens a backtick or tilde fence.
    ["fence-hostile-backtick", [{ file: "a.ts", line: 2, message: "A finding", suggestion: "ok\n```\nbad" }], false],
    ["fence-hostile-tilde", [{ file: "a.ts", line: 2, message: "A finding", suggestion: "ok\n   ~~~\nbad" }], false],
    // Out-of-range: DIFF presents a.ts lines 1-2 only, so end_line 3 (and 99)
    // leave the diff and the whole range is refused.
    ["out-of-range-adjacent", [{ file: "a.ts", line: 2, end_line: 3, message: "A finding", suggestion: "REPL" }], false],
    ["out-of-range-far", [{ file: "a.ts", line: 1, end_line: 99, message: "A finding", suggestion: "R1\nR2" }], false],
    // Marker-stripped-to-nothing: the replacement is only reserved carry lines.
    ["marker-only", [{ file: "a.ts", line: 2, message: "A finding", suggestion: MARKER_LINE }], false],
    ["marker-only-spaced", [{ file: "a.ts", line: 2, message: "A finding", suggestion: `${MARKER_LINE}\n\n\n${MARKER_LINE}` }], false],
    // Positive control: the same harness, same prior comment, same trusted
    // rejection — but the replacement differs from the prior run's, so
    // publication renders a prescription and the read ran to find that out.
    ["valid-suggestion", [{ file: "a.ts", line: 2, severity: "major", message: "A finding", suggestion: "A DIFFERENT REPLACEMENT" }], true],
  ];
  for (const [label, findings, publishes] of arms) {
    const api = feedbackApi({
      prior: { id: 501, ...PRIOR },
      records: [{ commentId: "501", content: "-1", login: "maintainer" }],
      permissions: { maintainer: { permission: "admin", roleName: "", subject: "absent" } },
    });
    const { body, messages } = await publishActionable(api, findings);
    // What publication rendered...
    assert.equal(body.includes("```suggestion"), publishes, `${label}: publication`);
    assert.equal(body.includes(FEEDBACK_AFFORDANCE), publishes, `${label}: affordance follows the replacement block`);
    // ...and what the pre-check cost for it. `feedbackCalls` counts every
    // `reviewCommentFeedback` request, i.e. every reaction read.
    assert.equal(api.feedbackCalls, publishes ? 1 : 0, `${label}: reaction reads`);
    assert.deepEqual(api.permissionLookups, publishes ? ["maintainer"] : [], `${label}: permission lookups`);
    assert.equal(
      messages.some((line) => line.includes("usefulness feedback")), publishes,
      `${label}: the usefulness-feedback read was ${publishes ? "made" : "skipped"}`,
    );
    if (publishes) {
      assert.ok(messages.some((line) => line.includes("inspected 1 prior comment(s)")), `${label}: the prior comment was read`);
      assert.ok(body.includes("A DIFFERENT REPLACEMENT"), `${label}: the current replacement is what renders`);
    } else {
      assert.ok(body.startsWith("**Info:** A finding"), `${label}: the finding itself still posts unchanged`);
      assert.ok(body.includes("_Automated finding from AI PR review._"), `${label}: the comment is still published`);
    }
  }

  // The pre-check asks about PUBLISHABILITY, not about whether the published
  // block survives suppression: the identical, already-rejected prescription
  // still runs the read (and still verifies the reacting actor) — it is a
  // prescription publication could render, so the read may find the rejection
  // that withholds it.
  const suppressed = feedbackApi({
    prior: { id: 501, ...PRIOR },
    records: [{ commentId: "501", content: "-1", login: "maintainer" }],
    permissions: { maintainer: { permission: "admin", roleName: "", subject: "absent" } },
  });
  const suppressedRun = await publishActionable(suppressed, ACTIONABLE);
  assert.equal(suppressedRun.body.includes("```suggestion"), false, "the rejection withheld the replacement");
  assert.equal(suppressed.feedbackCalls, 1, "a publishable-but-rejected prescription still spends the read");
  assert.deepEqual(suppressed.permissionLookups, ["maintainer"]);
  assert.ok(suppressedRun.messages.some((line) => line.includes("1 suppressed prescription(s)")), suppressedRun.messages.join("\n"));
});

test("#762: a reply that inherited the review id is never a candidate", async () => {
  for (const inReplyToId of [7, 9001]) {
    const api = feedbackApi({
      prior: { id: 501, ...PRIOR, inReplyToId },
      records: [{ commentId: "501", content: "-1", login: "maintainer" }],
      permissions: { maintainer: { permission: "admin", roleName: "", subject: "absent" } },
    });
    const { body, messages } = await publishActionable(api);
    assert.ok(body.includes("```suggestion"), `in_reply_to_id ${inReplyToId} must not enter the candidate set`);
    assert.equal(messages.some((line) => line.includes("usefulness feedback")), false);
    assert.equal(api.feedbackCalls, 0);
  }
});

test("#762: the affordance is not finding content — the deterministic thread message stays clean", async () => {
  const actionable = buildComments(
    [{ file: "pr_reviewer/x.py", line: 1, severity: "major", category: "bug", message: "retry drops the separator", suggestion: "REPL" }],
    "diff --git a/pr_reviewer/x.py b/pr_reviewer/x.py\n--- a/pr_reviewer/x.py\n+++ b/pr_reviewer/x.py\n@@ -0,0 +1,2 @@\n a\n+b\n",
    20,
    { forgejoPositions: false },
  ).comments[0] as { body: string };
  assert.ok(actionable.body.includes(FEEDBACK_AFFORDANCE), "the affordance still renders for humans");
  const view = enforcementView([normalizeThread({
    thread_id: "PRRT_1",
    path: "pr_reviewer/x.py",
    line: 1,
    original_line: 1,
    resolved: false,
    outdated: false,
    comments: [{ id: 1, user: { login: "bot" }, created_at: "2026-09-25T22:32:00Z", updated_at: "2026-09-25T22:32:00Z", body: actionable.body }],
  })!]);
  assert.equal(view[0]!.own_finding, true);
  assert.equal(view[0]!.severity, "major");
  assert.equal(view[0]!.category, "bug");
  assert.ok(view[0]!.message.startsWith("retry drops the separator"));
  assert.equal(view[0]!.message.includes("👍"), false, "the affordance is not finding content");
  assert.equal(view[0]!.message.includes("not helpful"), false, "the affordance is not finding content");
  assert.equal(view[0]!.message.includes("this review's verdict"), false);
});

// ---------------------------------------------------------------------------
// #1101 (review round): durable suppression — the rejection outlives the
// comment the trusted 👎 landed on, through the action's own carry markers.
// ---------------------------------------------------------------------------

/** The suppressed comment a prior run leaves behind for prescription REPL:
 * no suggestion region, one carry marker naming the rejection. */
function suppressedPriorBody(): string {
  const digest = prescriptionKeyDigest(prescriptionKey("a.ts", 2, 2, "REPL"));
  const built = buildComments(
    [{ file: "a.ts", line: 2, severity: "major", message: "A finding", suggestion: "REPL" }],
    DIFF, 20, { forgejoPositions: false, rejectedPrescriptions: new Set([digest]) },
  );
  const body = (built.comments[0] as { body: string }).body;
  assert.ok(body.includes(`pr-reviewer:rejected-prescriptions:v1:${digest}`), "the fixture carries its own digest");
  return body;
}

test("#1101: a carry marker on the action's own comment suppresses with zero reaction requests", async () => {
  const api = feedbackApi({ prior: { id: 501, path: "a.ts", line: 2, body: suppressedPriorBody() }, records: [] });
  const { body, messages } = await publishActionable(api);
  assert.equal(body.includes("```suggestion"), false, "the rejected prescription stays withheld with no reactions left to read");
  assert.equal(api.feedbackCalls, 0, "a carry-only read needs no reaction request");
  assert.deepEqual(api.permissionLookups, [], "carry needs no permission lookup — it names no actor");
  const telemetry = messages.find((line) => line.includes("usefulness feedback")) ?? "";
  assert.ok(telemetry.includes("1 carried rejection key(s)"), telemetry);
  assert.ok(telemetry.includes("1 suppressed prescription(s)"), telemetry);
  // The new comment re-carries the digest: the chain continues.
  assert.ok(body.includes("pr-reviewer:rejected-prescriptions:v1:"), "the replacement comment inherits the carry");
});

test("#1101: a carry marker is trusted only with owner provenance — a foreign author carries nothing", async () => {
  const marker = suppressedPriorBody();
  // A foreign top-level comment in a marker-prefixed review forging the claim.
  const forged = feedbackApi({ prior: { id: 501, path: "a.ts", line: 2, body: marker }, priorAuthor: "attacker", records: [] });
  const forgedRun = await publishActionable(forged);
  assert.ok(forgedRun.body.includes("```suggestion") && forgedRun.body.includes("REPL"), "unauthenticated body text is never authority");
  assert.equal(forgedRun.messages.some((line) => line.includes("carried rejection")), false);

  // An unprovable identity fails closed for carry too: the marker is inert.
  const anonymous = feedbackApi({ prior: { id: 501, path: "a.ts", line: 2, body: marker }, records: [], identity: null });
  const anonRun = await publishActionable(anonymous);
  assert.ok(anonRun.body.includes("```suggestion") && anonRun.body.includes("REPL"), "no owner proof, no carry");

  // The bot's own comment still carries.
  const own = feedbackApi({ prior: { id: 501, path: "a.ts", line: 2, body: marker }, records: [] });
  const ownRun = await publishActionable(own);
  assert.equal(ownRun.body.includes("```suggestion"), false);
});

test("#1101: a carried digest suppresses only the exact prescription it names", async () => {
  const marker = suppressedPriorBody();
  // A different replacement at the same anchor is a different prescription.
  const other = feedbackApi({ prior: { id: 501, path: "a.ts", line: 2, body: marker }, records: [] });
  const otherRun = await publishActionable(other, [{ file: "a.ts", line: 2, severity: "major", message: "A finding", suggestion: "A DIFFERENT REPLACEMENT" }]);
  assert.ok(otherRun.body.includes("```suggestion") && otherRun.body.includes("DIFFERENT"), "carry is key-exact, not line-vague");

  // The same text published at a different range is a different prescription.
  const elsewhere = feedbackApi({ prior: { id: 501, path: "a.ts", line: 2, body: marker }, records: [] });
  const elsewhereRun = await publishActionable(elsewhere, [{ file: "a.ts", line: 1, severity: "major", message: "A finding", suggestion: "REPL" }]);
  assert.ok(elsewhereRun.body.includes("```suggestion"), "carry is range-exact, not text-vague");
});

test("#1101: carried and live rejections merge; a reply's forged marker never counts", async () => {
  // One prior comment carries the digest for the ACTIONABLE prescription, a
  // second carries an unrelated digest — both on the bot's own comments.
  const unrelated = prescriptionKeyDigest(prescriptionKey("z.ts", 9, 9, "OTHER"));
  const api = feedbackApi({
    prior: { id: 501, path: "a.ts", line: 2, body: suppressedPriorBody() },
    extras: [{ id: 502, path: "z.ts", line: 9, body: `**Info:** z\n\n_Automated finding from AI PR review._\n\n<!-- pr-reviewer:rejected-prescriptions:v1:${unrelated} -->` }],
    records: [],
  });
  const { body, messages } = await publishActionable(api);
  assert.equal(body.includes("```suggestion"), false, "the carried digest suppresses its own prescription");
  const telemetry = messages.find((line) => line.includes("usefulness feedback")) ?? "";
  assert.ok(telemetry.includes("2 carried rejection key(s)"), telemetry);

  // The same digest arriving on a REPLY (in_reply_to set) never carries:
  // replies are discussion, not this action's published state.
  const reply = feedbackApi({ prior: { id: 501, ...PRIOR, inReplyToId: 7 }, records: [] });
  reply.listManagedInlineComments = async () => ({
    supported: true, complete: true,
    comments: [{ id: 502, reviewId: "7", path: "a.ts", line: 2, body: suppressedPriorBody(), user: { login: "bot" }, in_reply_to_id: 501, hasReplies: false }],
  });
  const replyRun = await publishActionable(reply);
  assert.ok(replyRun.body.includes("```suggestion"), "a reply carries no rejection state");
});

test("#1101: the carry marker is never finding content in the deterministic thread view", async () => {
  const view = enforcementView([normalizeThread({
    thread_id: "PRRT_1",
    path: "a.ts",
    line: 2,
    original_line: 2,
    resolved: false,
    outdated: false,
    comments: [{ id: 1, user: { login: "bot" }, created_at: "2026-10-17T00:00:00Z", updated_at: "2026-10-17T00:00:00Z", body: suppressedPriorBody() }],
  })!]);
  assert.equal(view[0]!.own_finding, true);
  assert.ok(view[0]!.message.startsWith("A finding"));
  assert.equal(view[0]!.message.includes("pr-reviewer:rejected-prescriptions"), false, "the carry marker never enters artifact finding text");
  assert.match(view[0]!.message, /^A finding\s*$/, "the stripped message is exactly the finding text");
});

/** A stateful forge double for the three-run lifecycle: published inline
 * comments persist and are removable, reactions attach by comment id, and the
 * reviewer identity is the action's own ("bot"). */
class LifecycleApi extends MockPublishApi {
  inlineComments: ManagedInlineCommentRef[] = [];
  private reactions = new Map<string, CommentFeedbackRecord[]>();
  private nextInlineId = 5000;
  feedbackCalls = 0;
  permissionLookups: string[] = [];
  constructor() {
    super("github");
    this.identity = "bot";
    this.reviewCommentFeedback = async (ids: readonly string[]) => {
      this.feedbackCalls += 1;
      return { supported: true, complete: true, records: ids.flatMap((id) => this.reactions.get(id) ?? []) };
    };
    this.collaboratorPermission = async (login: string) => {
      this.permissionLookups.push(login);
      return login === "maintainer"
        ? { permission: "write", roleName: "", subject: "absent" as const }
        : null;
    };
  }
  reactTo(commentId: string, login: string): void {
    const record: CommentFeedbackRecord = { commentId, content: "-1", login };
    this.reactions.set(commentId, [...(this.reactions.get(commentId) ?? []), record]);
  }
  override async createReview(request: NativeReviewRequest) {
    this.submitted.push(request);
    const reviewId = 1000 + this.submitted.length;
    this.reviews = [...this.reviews, { id: reviewId, body: request.body, user: { login: "bot" } }];
    for (const comment of request.comments ?? []) {
      this.nextInlineId += 1;
      this.inlineComments.push({
        id: this.nextInlineId, reviewId: String(reviewId), path: comment.path,
        ...(comment.line === undefined ? {} : { line: comment.line }),
        ...(comment.start_line === undefined ? {} : { start_line: comment.start_line }),
        body: comment.body, user: { login: "bot" }, hasReplies: false,
      });
    }
    return { ok: true, reviewId };
  }
  override async listManagedInlineComments(reviewIds: readonly string[]) {
    return {
      supported: true,
      complete: true,
      comments: this.inlineComments.filter((row) => reviewIds.includes(String(row.reviewId))),
    };
  }
  override async retireInlineComment(_reviewId: string, commentId: string): Promise<boolean> {
    const before = this.inlineComments.length;
    this.inlineComments = this.inlineComments.filter((row) => String(row.id) !== commentId);
    return this.inlineComments.length === before - 1;
  }
}

test("#1101 lifecycle: a trusted rejection survives its own comment being retired (A→B→C)", async () => {
  const api = new LifecycleApi();
  const run = async () => publishReview(
    input({
      mode: "review_comment", inlineFindings: true, findings: ACTIONABLE,
      cleanupPreviousNativeReviews: "auto",
    }),
    api,
    { diffText: DIFF },
  );

  // Run A: the prescription publishes normally.
  const a = await run();
  assert.equal(a.status, "published");
  const commentA = api.inlineComments[0]!;
  assert.ok(String(commentA.body).includes("```suggestion") && String(commentA.body).includes("REPL"), "A posts the prescription");
  assert.ok(String(commentA.body).includes(FEEDBACK_AFFORDANCE));

  // A trusted collaborator 👎 on A's comment.
  api.reactTo(String(commentA.id), "maintainer");

  // Run B: identical finding. The prescription is withheld from the reaction,
  // and B's own cleanup then retires A's comment (reaction history included).
  const b = await run();
  assert.equal(b.status, "published");
  assert.equal(api.inlineComments.some((row) => row.id === commentA.id), false, "cleanup retired the reacted-to comment");
  const commentB = api.inlineComments.at(-1)!;
  const bodyB = String(commentB.body);
  assert.equal(bodyB.includes("```suggestion"), false, "B does not re-post the rejected prescription");
  assert.ok(bodyB.includes("**⚠️ Major:** A finding"), "the finding itself still posts unchanged");
  assert.ok(bodyB.includes("Suggested agent prompt"), "the agent prompt is untouched");
  assert.ok(bodyB.includes("pr-reviewer:rejected-prescriptions:v1:"), "B carries the rejection forward");
  assert.ok(b.messages.some((line) => line.includes("1 trusted rejection(s)")));

  // Run C: the reacted-to comment is gone and B's comment holds only a
  // carry marker — the identical prescription remains withheld, with zero
  // reaction or permission requests for the rejection itself.
  const feedbackBefore = api.feedbackCalls;
  const lookupsBefore = api.permissionLookups.length;
  const commentBId = commentB.id;
  const c = await run();
  assert.equal(c.status, "published");
  const commentC = api.inlineComments.at(-1)!;
  // Identity, not position: C's own comment is strictly newer than B's and
  // survives C's own cleanup (which retired B's — the marker's source).
  assert.ok(Number(commentC.id) > Number(commentBId), "the newest comment is C's own");
  assert.equal(api.inlineComments.some((row) => String(row.id) === String(commentBId)), false, "C retired B's carried comment");
  assert.ok(api.inlineComments.some((row) => String(row.id) === String(commentC.id)), "C never retires its own replacement comment");
  const bodyC = String(commentC.body);
  assert.equal(bodyC.includes("```suggestion"), false, "the rejected prescription stays withheld in C");
  assert.ok(bodyC.includes("**⚠️ Major:** A finding"), "the finding still posts");
  assert.ok(bodyC.includes("pr-reviewer:rejected-prescriptions:v1:"), "the carry chain continues in C");
  assert.ok(c.messages.some((line) => line.includes("1 carried rejection key(s)")), c.messages.join("\n"));
  assert.ok(c.messages.some((line) => line.includes("1 suppressed prescription(s)")), c.messages.join("\n"));
  assert.equal(api.feedbackCalls, feedbackBefore, "a carry-only run makes no reaction request");
  assert.equal(api.permissionLookups.length, lookupsBefore, "a carry-only run verifies nobody");
  // Telemetry stays counts-only: no login and no prescription text leak.
  assert.equal(c.messages.join("\n").includes("maintainer"), false);
});

test("#762: the author's own different fix settles the finding with no reaction read (A→B→thread)", async () => {
  const api = new LifecycleApi();
  const run = (findings: unknown[]) => publishReview(
    input({
      mode: "review_verdict", inlineFindings: true, findings,
      cleanupPreviousNativeReviews: "auto",
    }),
    api,
    { diffText: DIFF },
  );

  // Run A: the finding publishes with the replacement this reviewer suggested.
  const a = await run(ACTIONABLE);
  assert.equal(a.status, "published");
  const commentA = api.inlineComments[0]!;
  const bodyA = String(commentA.body);
  assert.ok(bodyA.includes("```suggestion") && bodyA.includes("REPL"), "A posts the prescription");

  // Run B: the author fixed the defect with their own text, so the review no
  // longer reports it. `reactTo` is never called — no 👎 exists anywhere.
  const b = await run([]);
  assert.equal(b.status, "published");
  assert.equal(api.feedbackCalls, 0, "neither run reads a reaction");
  assert.equal(api.permissionLookups.length, 0, "and neither authorizes a reacting actor");
  assert.deepEqual(api.submitted.at(-1)!.comments ?? [], [], "B posts no inline comment at all");
  const published = JSON.stringify(api.submitted.at(-1));
  assert.equal(published.includes("```suggestion"), false, "B publishes no replacement block");
  assert.equal(published.includes("REPL"), false, "and never re-issues A's replacement text");
  assert.equal(
    api.inlineComments.some((row) => String(row.id) === String(commentA.id)), false,
    "B's own cleanup retired A's comment through the normal path",
  );

  // The finding settles on A's thread: disposition plus code evidence naming
  // the author's own change. Nothing here quotes the suggested replacement.
  const view = enforcementView([normalizeThread({
    thread_id: "PRRT_1",
    path: "a.ts",
    line: 2,
    original_line: 2,
    resolved: false,
    outdated: false,
    comments: [{ id: 1, user: { login: "bot" }, created_at: "2026-10-17T00:00:00Z", updated_at: "2026-10-17T00:00:00Z", body: bodyA }],
  })!]);
  assert.equal(view.length, 1, "A's published body is exactly one review thread");
  assert.equal(view[0]!.own_finding, true);
  assert.ok(view[0]!.message.startsWith("A finding"));
  const evidence = "a.ts:2 now drops the duplicated separator before joining — the author's own implementation";
  assert.equal(evidence.includes("REPL"), false, "the settlement cites the author's code, not the suggested replacement");
  const artifact = {
    verdict: "approve", review_markdown: "review", findings: [],
    thread_dispositions: [{ thread_id: "PRRT_1", disposition: "fixed", evidence }],
  } as ReviewArtifact;
  applyReviewThreadEnforcement(artifact, view, "strict");
  assert.deepEqual(artifact.thread_dispositions, [{ thread_id: "PRRT_1", disposition: "fixed", evidence }], "the disposition stands, unrejected");
  assert.equal(artifact.findings.length, 0, "the finding resolves without ever matching the suggested replacement");
});

test("#1101: the carry grammar is reserved model markdown — it never survives into any published body", async () => {
  const api = new MockPublishApi();
  const smuggled = `<!-- pr-reviewer:rejected-prescriptions:v1:${"f".repeat(64)} -->`;
  await publishReview(input({ reviewMarkdown: `Review.\n\n${smuggled}\n` }), api, { diffText: "" });
  const body = api.sticky[0]!.body;
  assert.equal(body.includes("pr-reviewer:rejected-prescriptions"), false, "reserved marker stripped from model markdown");
});

test("#1101 lifecycle: a smuggled marker line cannot desync a 👎 from the prescription it reviewed (A→B)", async () => {
  const smuggled = `<!-- pr-reviewer:rejected-prescriptions:v1:${prescriptionKeyDigest(prescriptionKey("a.ts", 2, 2, "OTHER"))} -->`;
  const findings = [{
    file: "a.ts", line: 2, severity: "major", message: "A finding",
    suggestion: `REPL\n${smuggled}`, agent_prompt: "apply the fix",
  }];
  const api = new LifecycleApi();
  const run = async () => publishReview(
    input({ mode: "review_comment", inlineFindings: true, findings, cleanupPreviousNativeReviews: "auto" }),
    api,
    { diffText: DIFF },
  );

  // Run A: the prescription publishes, and the smuggled line never reaches it.
  const a = await run();
  assert.equal(a.status, "published");
  const commentA = api.inlineComments[0]!;
  const bodyA = String(commentA.body);
  assert.ok(bodyA.includes("```suggestion") && bodyA.includes("REPL"), "A posts the prescription");
  assert.equal(bodyA.includes("pr-reviewer:rejected-prescriptions"), false, "model text never carries the grammar");

  api.reactTo(String(commentA.id), "maintainer");

  // Run B: the rejection still matches what A actually published.
  const b = await run();
  assert.equal(b.status, "published");
  const bodyB = String(api.inlineComments.at(-1)!.body);
  assert.equal(bodyB.includes("```suggestion"), false, "B withholds the prescription the 👎 landed on");
  assert.ok(bodyB.includes("pr-reviewer:rejected-prescriptions:v1:"), "B carries the rejection forward");
  assert.ok(bodyB.includes("**⚠️ Major:** A finding"), "the finding itself still posts unchanged");
  assert.ok(b.messages.some((line) => line.includes("1 trusted rejection(s)")), b.messages.join("\n"));
});

// ---- #1144: only the latest managed review stays visible after any verified replacement ----

const BOT = { owner: { kind: "login", login: "bot" } as const, reason: "user-login" };

test("#1144: hiding selects every owned managed review state, dismisses verdicts, and skips the rest", async () => {
  const api = new MockPublishApi();
  api.reviews = [
    { id: 1, node_id: "node-1", state: "COMMENTED", body: `${MARKER}\nalready minimized`, user: { login: "bot" } },
    { id: 2, node_id: "node-2", state: "COMMENTED", body: `${MARKER}\nmarker forgery by a human`, user: { login: "human" } },
    { id: 3, node_id: "node-3", state: "CHANGES_REQUESTED", body: `${MARKER}\nblocking verdict`, user: { login: "bot" } },
    { id: 4, node_id: "node-4", state: "APPROVED", body: `${MARKER}\napproval`, user: { login: "bot" } },
    { id: 5, node_id: "node-5", state: "COMMENTED", body: "unmanaged human body", user: { login: "bot" } },
    { id: 6, state: "COMMENTED", body: `${MARKER}\nno node id`, user: { login: "bot" } },
    { id: 7, node_id: "node-7", state: "PENDING", body: `${MARKER}\nunproven state`, user: { login: "bot" } },
    { id: 8, node_id: "node-8", state: "COMMENTED", body: `${MARKER}\nstale advisory`, user: { login: "bot" } },
    { id: 9, node_id: "node-9", state: "COMMENTED", body: `${MARKER}\njust published`, user: { login: "bot" } },
    { id: 10, node_id: "node-10", state: "DISMISSED", body: `${MARKER}\ndismissed but still visible`, user: { login: "bot" } },
    { id: 11, node_id: "node-11", state: "CHANGES_REQUESTED", body: `${MARKER}\nhuman marker-forged verdict`, user: { login: "human" } },
  ];
  api.minimizeIds = ["1"];
  const logs: string[] = [];
  await hideSupersededManagedReviews(api, api.reviews, MARKER, (line) => logs.push(line), BOT, ["9"]);
  assert.deepEqual(api.minimized, ["node-3", "node-4", "node-8", "node-10"],
    "verdict bodies are dismissed then hidden; the already-hidden advisory stays skipped");
  assert.deepEqual(api.dismissed, ["3", "4"], "only bot-owned verdicts are dismissed");
  assert.equal(api.inlineListCalls, 0, "hiding superseded reviews never enumerates or retires inline comments");
  assert.equal(api.threadQueryCalls, 0, "and never resolves review threads");
  assert.ok(logs.some((line) => line.includes("Superseded reviews: eligible=4 dismissed=2 minimized=4 failed=0")));
});

test("#1144: hiding fails closed on unproven owner, lost supersession; unreadable minimized state blocks only minimization", async () => {
  const stale = [
    { id: 1, node_id: "node-1", state: "COMMENTED", body: `${MARKER}\nstale advisory`, user: { login: "bot" } },
    { id: 2, state: "COMMENTED", body: `${MARKER}\nforeign`, user: { login: "other-bot" } },
  ];

  const noOwner = new MockPublishApi();
  const ownerLogs: string[] = [];
  await hideSupersededManagedReviews(noOwner, stale, MARKER, (line) => ownerLogs.push(line), { owner: null, reason: "unavailable" });
  assert.deepEqual(noOwner.minimized, []);
  assert.deepEqual(noOwner.dismissed, [], "an unproven identity dismisses nothing either");
  assert.ok(ownerLogs.some((line) => line.includes("Could not verify authenticated owner") && line.includes("identity reason: unavailable")));

  // Defensive case: an adapter that actually THROWS on the minimized-state
  // read hides no bodies (the catch in the cleanup layer). The dismissal
  // path never depended on GraphQL, so the stale verdict is still dismissed.
  const unreadable = new MockPublishApi();
  unreadable.minimizeIdsError = true;
  const unreadableLogs: string[] = [];
  await hideSupersededManagedReviews(unreadable, stale, MARKER, (line) => unreadableLogs.push(line), BOT);
  assert.deepEqual(unreadable.minimized, [], "an adapter that throws on the minimized-state read hides no bodies");
  assert.ok(unreadableLogs.some((line) => line.includes("Could not read minimized review state")));

  // The same unreadable GraphQL state does NOT block the REST dismissal of a
  // stale verdict: dismissal provenance never depended on GraphQL.
  const unreadableVerdict = new MockPublishApi();
  unreadableVerdict.minimizeIdsError = true;
  unreadableVerdict.reviews = [{ id: 5, node_id: "node-5", state: "CHANGES_REQUESTED", body: `${MARKER}\nstale verdict`, user: { login: "bot" } }];
  await hideSupersededManagedReviews(unreadableVerdict, unreadableVerdict.reviews, MARKER, () => undefined, BOT);
  assert.deepEqual(unreadableVerdict.dismissed, ["5"]);
  assert.deepEqual(unreadableVerdict.minimized, []);

  // Production shape: the GitHub adapter answers an unreadable minimized
  // state with an EMPTY SET (it never throws), so the hide still runs — the
  // read is an idempotency guard (it only prevents re-hiding an
  // already-hidden body), never a safety gate.
  const unreadableSet = new MockPublishApi();
  unreadableSet.minimizeIdsUnreadable = true;
  unreadableSet.reviews = [
    { id: 5, node_id: "node-5", state: "CHANGES_REQUESTED", body: `${MARKER}\nstale verdict`, user: { login: "bot" } },
    { id: 6, node_id: "node-6", state: "COMMENTED", body: `${MARKER}\nstale advisory`, user: { login: "bot" } },
  ];
  const unreadableSetLogs: string[] = [];
  await hideSupersededManagedReviews(unreadableSet, unreadableSet.reviews, MARKER, (line) => unreadableSetLogs.push(line), BOT);
  assert.deepEqual(unreadableSet.dismissed, ["5"], "the stale verdict is still dismissed");
  assert.deepEqual(unreadableSet.minimized, ["node-5", "node-6"], "the stale advisory body is still hidden");
  assert.equal(unreadableSetLogs.some((line) => line.includes("Could not read minimized review state")), false,
    "an empty set is not a read failure — nothing was unreadable");

  const lost = new MockPublishApi();
  const lostLogs: string[] = [];
  await hideSupersededManagedReviews(lost, stale, MARKER, (line) => lostLogs.push(line), BOT, [], async () => false);
  assert.deepEqual(lost.minimized, []);
  assert.ok(lostLogs.some((line) => line.includes("Head or latest review changed; stopping superseded review cleanup")));

  const lostVerdict = new MockPublishApi();
  lostVerdict.reviews = [{ id: 5, node_id: "node-5", state: "CHANGES_REQUESTED", body: `${MARKER}\nstale verdict`, user: { login: "bot" } }];
  const lostVerdictLogs: string[] = [];
  await hideSupersededManagedReviews(lostVerdict, lostVerdict.reviews, MARKER, (line) => lostVerdictLogs.push(line), BOT, [], async () => false);
  assert.deepEqual(lostVerdict.dismissed, [], "a lost supersession never dismisses");
  assert.ok(lostVerdictLogs.some((line) => line.includes("stopping superseded review cleanup")));

  const forgejo = new MockPublishApi("forgejo");
  const forgejoLogs: string[] = [];
  await hideSupersededManagedReviews(forgejo, stale, MARKER, (line) => forgejoLogs.push(line), BOT);
  assert.deepEqual(forgejo.minimized, [], "Forgejo makes zero GraphQL minimization calls");
  assert.deepEqual(forgejo.dismissed, []);
  assert.ok(forgejoLogs.some((line) => line.includes("no GraphQL API")));

  // Without GraphQL a Forgejo verdict state still loses its stale merge-gate
  // vote through the REST dismissal path, matching the complete path.
  const forgejoVerdict = new MockPublishApi("forgejo");
  forgejoVerdict.reviews = [{ id: 6, state: "CHANGES_REQUESTED", body: `${MARKER}\nstale verdict`, user: { login: "bot" } }];
  const forgejoVerdictLogs: string[] = [];
  await hideSupersededManagedReviews(forgejoVerdict, forgejoVerdict.reviews, MARKER, (line) => forgejoVerdictLogs.push(line), BOT);
  assert.deepEqual(forgejoVerdict.dismissed, ["6"], "dismissal is REST, not GraphQL");
  assert.deepEqual(forgejoVerdict.minimized, [], "the body hide degrades with an explicit note");
  assert.ok(forgejoVerdictLogs.some((line) => line.includes("no GraphQL API")));
});

// #1144: the review id is the review's identity for the whole cleanup
// decision, and the dismissal interpolates it into a REST path. A managed
// review whose id is not a positive integer is therefore not targetable at
// all: it is neither dismissed nor body-hidden, on either cleanup path.
test("#1144: a managed review with a malformed id is neither dismissed nor body-hidden", async () => {
  const malformed = { id: "../x", node_id: "node-bad", state: "CHANGES_REQUESTED", body: `${MARKER}\nmalformed id`, user: { login: "bot" } };

  const hidden = new MockPublishApi();
  hidden.reviews = [malformed];
  await hideSupersededManagedReviews(hidden, hidden.reviews, MARKER, () => undefined, BOT);
  assert.deepEqual(hidden.dismissed, [], "a malformed id is never dismissed");
  assert.deepEqual(hidden.minimized, [], "and its body is never hidden");

  const complete = new MockPublishApi();
  complete.reviews = [malformed];
  await cleanupManagedReviews(complete, "42", MARKER, () => undefined);
  assert.deepEqual(complete.dismissed, [], "a malformed id is never dismissed");
  assert.deepEqual(complete.minimized, [], "and its body is never hidden");

  // A well-formed neighbour is still cleaned up — the malformed row does not
  // disable the cleanup of the rest.
  const mixed = new MockPublishApi();
  mixed.reviews = [
    malformed,
    { id: 8, node_id: "node-8", state: "CHANGES_REQUESTED", body: `${MARKER}\nstale verdict`, user: { login: "bot" } },
  ];
  await cleanupManagedReviews(mixed, "42", MARKER, () => undefined);
  assert.deepEqual(mixed.dismissed, ["8"]);
  assert.deepEqual(mixed.minimized, ["node-8"]);
});

test("#1144: successive requirement-trace-partial re-runs leave only the newest managed review visible, without destructive cleanup", async () => {
  const api = new MockPublishApi();
  api.reviews = [
    { id: 400, node_id: "node-400", state: "CHANGES_REQUESTED", body: `${MARKER}\nblocking verdict`, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" },
    { id: 500, node_id: "node-500", state: "COMMENTED", body: `${MARKER}\nforeign advisory`, user: { login: "other-bot" }, submitted_at: "2025-01-02T00:00:00Z" },
  ];
  // The observed Release Please state: review_result=partial with
  // incomplete_reason=requirement_trace, verdict approve (withheld to COMMENT).
  const partial = {
    mode: "review_verdict", cleanupPreviousNativeReviews: "true",
    requiredChecks: "incomplete", incompleteReason: "requirement_trace", verdict: "approve",
  } as const;
  const settle = () => {
    // Mirror the forge: submitted reviews land as COMMENTED with node ids,
    // dismissed reviews change state, and ids minimized by the run are
    // visible to the next run's GraphQL read.
    api.reviews = api.reviews.map((r) => {
      let next = r.state === undefined ? { ...r, state: "COMMENTED", node_id: `node-${r.id}` } : { ...r };
      if (api.dismissed.includes(String(next.id))) next = { ...next, state: "DISMISSED" };
      return next;
    });
    api.minimizeIds = api.minimized
      .map((node) => node.replace(/^node-/, ""))
      .filter((id) => /^[1-9]\d*$/.test(id));
  };

  // Run A: the older bot CHANGES_REQUESTED verdict is proven superseded by
  // this newer partial publication and is dismissed + hidden; the foreign
  // advisory is never touched.
  const a = await publishReview(input(partial), api, { diffText: "" });
  assert.equal(a.status, "published");
  settle();
  assert.deepEqual(api.dismissed, ["400"], "a partial replacement dismisses the old blocking verdict");
  assert.deepEqual(api.minimized, ["node-400"]);

  // Run B: A's advisory body is proven stale by this newer managed review.
  const b = await publishReview(input(partial), api, { diffText: "" });
  assert.equal(b.status, "published");
  settle();
  assert.deepEqual(api.dismissed, ["400"], "the already-dismissed review is not dismissed again");
  assert.deepEqual(api.minimized, ["node-400", "node-1001"]);

  // Run C: A and B are already hidden (idempotent), C is the newest and
  // stays visible — across the mixed CHANGES_REQUESTED/COMMENTED states only
  // the latest managed review remains.
  const c = await publishReview(input(partial), api, { diffText: "" });
  assert.equal(c.status, "published");
  assert.deepEqual(api.minimized, ["node-400", "node-1001", "node-1002"], "hiding is idempotent and the newest review remains visible");
  assert.equal(api.minimized.includes("node-1003"), false, "the just-published review is never hidden");
  assert.equal(api.inlineListCalls, 0, "no inline-comment enumeration or deletion on the partial path");
  assert.equal(api.threadQueryCalls, 0, "no review-thread resolution on the partial path");
  assert.deepEqual(api.dismissed, ["400"]);
  assert.ok(c.messages.some((line) => line.includes("hiding superseded managed review bodies")));
});

test("#1144: a complete replacement keeps the existing dismiss/retire semantics", async () => {
  const api = new MockPublishApi();
  api.reviews = [
    { id: 700, node_id: "node-700", state: "COMMENTED", body: `${MARKER}\nold advisory`, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" },
  ];
  api.listManagedInlineComments = async () => { api.inlineListCalls += 1; return { supported: true, complete: true, comments: [{ id: 11, reviewId: "700", user: { login: "bot" }, hasReplies: false }] }; };
  const result = await publishReview(input({ mode: "review_verdict", cleanupPreviousNativeReviews: "true" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.ok(api.inlineListCalls > 0, "the complete path still enumerates inline comments for retirement");
  assert.ok(result.messages.some((line) => line.includes("Inline comments: eligible=1 retired=1")));
  assert.ok(result.messages.some((line) => line.includes("Cleaning up previous managed native reviews")));
  assert.ok(!result.messages.some((line) => line.includes("Replacement is not complete")));
});

test("#1144: fail-closed guards block superseded-review hiding on an incomplete re-run", async () => {
  const stale = [
    { id: 7, node_id: "node-7", state: "COMMENTED", body: `${MARKER}\nold advisory`, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" },
    { id: 8, node_id: "node-8", state: "CHANGES_REQUESTED", body: `${MARKER}\nold verdict`, user: { login: "bot" }, submitted_at: "2025-01-02T00:00:00Z" },
  ];
  const partialVerdict = { mode: "review_verdict", cleanupPreviousNativeReviews: "true", requiredChecks: "incomplete" } as const;

  // Unknown owner: bounded identity WARN, nothing minimized or dismissed.
  const unknownOwner = new MockPublishApi();
  unknownOwner.reviews = stale;
  unknownOwner.identity = null;
  const unknownResult = await publishReview(input(partialVerdict), unknownOwner, { diffText: "" });
  assert.equal(unknownResult.status, "published");
  assert.deepEqual(unknownOwner.minimized, []);
  assert.deepEqual(unknownOwner.dismissed, []);
  assert.ok(unknownResult.messages.some((line) => line.includes("Could not verify authenticated owner")));

  // Head moved after publication: the verified-head guard blocks everything.
  const headMoved = new MockPublishApi();
  headMoved.reviews = stale;
  let headReads = 0;
  headMoved.getHeadSha = async () => (headReads++ === 0 ? HEAD : "new-head");
  const headResult = await publishReview(input(partialVerdict), headMoved, { diffText: "" });
  assert.equal(headResult.status, "published");
  assert.deepEqual(headMoved.minimized, []);
  assert.deepEqual(headMoved.dismissed, []);
  assert.ok(headResult.messages.some((line) => line.includes("Head changed after publication")));

  // Overlapping run: a newer managed review published during this run means
  // this run is no longer the winner and must not hide it.
  const competing = new MockPublishApi();
  competing.reviews = stale;
  const submit = competing.createReview.bind(competing);
  competing.createReview = async (request) => {
    const submitted = await submit(request);
    competing.reviews = [...competing.reviews, { id: 2000, node_id: "node-2000", state: "COMMENTED", body: MARKER, user: { login: "bot" } }];
    return submitted;
  };
  const competingResult = await publishReview(input(partialVerdict), competing, { diffText: "" });
  assert.equal(competingResult.status, "published");
  assert.deepEqual(competing.minimized, [], "a stale run never hides the newer review");
  assert.deepEqual(competing.dismissed, [], "and never dismisses a verdict it no longer owns the ordering of");
  assert.ok(competingResult.messages.some((line) => line.includes("A newer review superseded this run; cleanup skipped")));
});

// #1144: the native-review checkpoint fails closed on a FOREIGN managed
// review too — a managed review of ANY author that is newer than this run's
// own replacement supersedes the run, so nothing is dismissed and nothing is
// hidden. Mirrors the sticky-checkpoint competing case.
test("#1144: a foreign managed review newer than this run's own replacement blocks every cleanup effect", async () => {
  const api = new MockPublishApi();
  api.reviews = [
    { id: 7, node_id: "node-7", state: "CHANGES_REQUESTED", body: `${MARKER}\nold verdict`, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" },
    // A foreign managed review: a HIGHER id than the replacement this run
    // publishes (the mock's next native review id), a DIFFERENT author, and
    // the managed marker.
    { id: 2000, node_id: "node-2000", state: "COMMENTED", body: `${MARKER}\nforeign managed review`, user: { login: "other-bot" }, submitted_at: "2099-01-01T00:00:00Z" },
  ];
  const result = await publishReview(input({ mode: "review_verdict", cleanupPreviousNativeReviews: "true" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.ok(api.submitted.length > 0, "the run published its own native review");
  assert.deepEqual(api.dismissed, [], "a superseded run never dismisses a stale verdict");
  assert.deepEqual(api.minimized, [], "and never hides a body");
  assert.equal(api.inlineListCalls, 0, "and never retires inline comments");
  assert.equal(api.threadQueryCalls, 0, "and never resolves review threads");
  assert.ok(result.messages.some((line) => line.includes("A newer review superseded this run; cleanup skipped")));
});

test("#1144: a run with no published replacement checkpoint hides and dismisses nothing", async () => {
  const api = new MockPublishApi();
  // Hide-eligible fixtures (known states with GraphQL node ids): without a
  // checkpoint these must stay untouched, not merely be filtered by state.
  api.reviews = [
    { id: 300, node_id: "node-300", state: "CHANGES_REQUESTED", body: `${MARKER}\nold verdict`, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" },
    { id: 301, node_id: "node-301", state: "COMMENTED", body: `${MARKER}\nold advisory`, user: { login: "bot" }, submitted_at: "2025-01-02T00:00:00Z" },
  ];
  // Sticky publication succeeds but reports neither an id nor a publication
  // timestamp, and no native review is created: no checkpoint, fail closed.
  api.stickyResult = { ok: true, created: false };
  const result = await publishReview(input({ mode: "review_comment", cleanupPreviousNativeReviews: "true", requiredChecks: "incomplete" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.ok(result.messages.some((line) => line.includes("No replacement checkpoint")));
  assert.deepEqual(api.minimized, [], "an unproven replacement never hides the current latest review");
  assert.deepEqual(api.dismissed, []);
  assert.equal(api.inlineListCalls, 0);
});

test("#1144: a partial review_comment run hides and dismisses through the sticky checkpoint; a competing managed review blocks it", async () => {
  const staleAdvisory = [
    { id: 6, node_id: "node-6", state: "CHANGES_REQUESTED", body: `${MARKER}\nold blocking verdict`, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" },
    { id: 7, node_id: "node-7", state: "COMMENTED", body: `${MARKER}\nold advisory`, user: { login: "bot" }, submitted_at: "2025-01-02T00:00:00Z" },
  ];
  const partialSticky = { mode: "review_comment", cleanupPreviousNativeReviews: "auto", requiredChecks: "incomplete" } as const;

  const api = new MockPublishApi();
  api.reviews = staleAdvisory;
  api.comments = [{ id: 9, body: MARKER, user: { login: "bot" }, updated_at: "2026-01-01T00:00:00Z" }];
  api.stickyResult = { ok: true, created: false, commentId: 9, updatedAt: "2026-01-01T00:00:00Z" };
  const result = await publishReview(input(partialSticky), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.deepEqual(api.minimized, ["node-6", "node-7"], "the sticky checkpoint authorizes hiding every older managed review");
  assert.deepEqual(api.dismissed, ["6"], "and the dismissal of the older verdict state");
  assert.equal(api.inlineListCalls, 0);

  // An overlapping managed review submitted after the checkpoint fails the
  // sticky still-current revalidation: the stale run hides nothing.
  const competing = new MockPublishApi();
  competing.reviews = staleAdvisory;
  competing.comments = [{ id: 9, body: MARKER, user: { login: "bot" }, updated_at: "2026-01-01T00:00:00Z" }];
  competing.stickyResult = { ok: true, created: false, commentId: 9, updatedAt: "2026-01-01T00:00:00Z" };
  const sticky = competing.upsertStickyComment.bind(competing);
  competing.upsertStickyComment = async (marker, body) => {
    const upserted = await sticky(marker, body);
    competing.reviews = [...competing.reviews, { id: 2000, node_id: "node-2000", state: "COMMENTED", body: MARKER, user: { login: "bot" }, submitted_at: "2099-01-01T00:00:00Z" }];
    return upserted;
  };
  const competingResult = await publishReview(input(partialSticky), competing, { diffText: "" });
  assert.equal(competingResult.status, "published");
  assert.deepEqual(competing.minimized, [], "a competing managed review newer than the sticky checkpoint blocks minimization");
  assert.deepEqual(competing.dismissed, [], "and dismissal");
  assert.ok(competingResult.messages.some((line) => line.includes("A newer review superseded this run; cleanup skipped")));
});

test("#1144: a fallback-submitted review is an incomplete replacement and still hides and dismisses old reviews", async () => {
  const api = new MockPublishApi();
  api.reviews = [
    { id: 600, node_id: "node-600", state: "COMMENTED", body: `${MARKER}\nold advisory`, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" },
    { id: 601, node_id: "node-601", state: "APPROVED", body: `${MARKER}\nold approval`, user: { login: "bot" }, submitted_at: "2025-01-02T00:00:00Z" },
  ];
  api.reviewResults = [{ ok: false, error: "commit-bound submission rejected" }];
  const result = await publishReview(input({ mode: "review_verdict", cleanupPreviousNativeReviews: "true" }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.ok(result.messages.some((line) => line.includes("falling back to plain review")));
  assert.deepEqual(api.minimized, ["node-600", "node-601"]);
  assert.deepEqual(api.dismissed, ["601"], "the fallback path dismisses the stale approval too");
  assert.equal(api.inlineListCalls, 0, "a fallback submission never retires inline comments");
});

test("#1144: an old COMMENTED review is hidden by a newer partial CHANGES_REQUESTED review, which stays visible", async () => {
  const api = new MockPublishApi();
  api.reviews = [{ id: 100, node_id: "node-100", state: "COMMENTED", body: `${MARKER}\nold advisory`, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" }];
  const result = await publishReview(input({
    mode: "review_verdict", cleanupPreviousNativeReviews: "true",
    requiredChecks: "incomplete", verdict: "request_changes",
  }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.equal(api.submitted.at(-1)!.event, "REQUEST_CHANGES", "the partial run publishes its blocking verdict");
  assert.deepEqual(api.minimized, ["node-100"], "the superseded advisory is hidden");
  assert.deepEqual(api.dismissed, [], "the just-published changes-requested review is never dismissed");
  assert.equal(api.inlineListCalls, 0);
  assert.equal(api.threadQueryCalls, 0);
});

test("#1144: an old DISMISSED bot review is body-hidden by a newer partial publication", async () => {
  const api = new MockPublishApi();
  // A dismissed verdict still shows its body in the timeline: the dismissal
  // strikes the merge gate, the hide is what stops it from being visible.
  api.reviews = [{ id: 100, node_id: "node-100", state: "DISMISSED", body: `${MARKER}\nold dismissed body`, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" }];
  const result = await publishReview(input({
    mode: "review_verdict", cleanupPreviousNativeReviews: "true",
    requiredChecks: "incomplete", verdict: "request_changes",
  }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.deepEqual(api.minimized, ["node-100"], "a dismissed but still visible body is hidden");
  assert.deepEqual(api.dismissed, [], "an already-dismissed review is not dismissed again");
  assert.equal(api.inlineListCalls, 0);
});

test("#1144: an incomplete review listing fails closed — nothing is dismissed and no body is hidden", async () => {
  const api = new MockPublishApi();
  api.reviews = [
    { id: 500, node_id: "node-500", state: "CHANGES_REQUESTED", body: `${MARKER}\nold verdict`, user: { login: "bot" }, submitted_at: "2025-01-01T00:00:00Z" },
    { id: 501, node_id: "node-501", state: "COMMENTED", body: `${MARKER}\nold advisory`, user: { login: "bot" }, submitted_at: "2025-01-02T00:00:00Z" },
  ];
  // The review listing cannot be read: no supersession can be proven, so
  // nothing is hidden and no stale verdict is dismissed.
  api.listReviewsError = true;
  const result = await publishReview(input({
    mode: "review_verdict", cleanupPreviousNativeReviews: "true", requiredChecks: "incomplete",
  }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.deepEqual(api.dismissed, [], "an incomplete listing dismisses nothing");
  assert.deepEqual(api.minimized, [], "an incomplete listing hides nothing");
  assert.ok(result.messages.some((line) => line.includes("Could not snapshot previous reviews")));
});

test("#1144: hide failures are counted with a bounded diagnostic and never abort the run", async () => {
  const api = new MockPublishApi();
  api.reviews = [{ id: 1, node_id: "node-1", state: "COMMENTED", body: `${MARKER}\nstale advisory`, user: { login: "bot" } }];
  api.minimizeResult = false;
  const logs: string[] = [];
  await hideSupersededManagedReviews(api, api.reviews, MARKER, (line) => logs.push(line), BOT);
  assert.deepEqual(api.minimized, ["node-1"]);
  assert.ok(logs.some((line) => line.includes("Superseded reviews: eligible=1 dismissed=0 minimized=0 failed=1")));

  // A failed dismissal still hides the body, and both failures are counted.
  const dismissApi = new MockPublishApi();
  dismissApi.reviews = [{ id: 2, node_id: "node-2", state: "CHANGES_REQUESTED", body: `${MARKER}\nstale verdict`, user: { login: "bot" } }];
  dismissApi.dismissResult = false;
  const dismissLogs: string[] = [];
  await hideSupersededManagedReviews(dismissApi, dismissApi.reviews, MARKER, (line) => dismissLogs.push(line), BOT);
  assert.deepEqual(dismissApi.dismissed, ["2"]);
  assert.deepEqual(dismissApi.minimized, ["node-2"], "a failed dismissal still hides the body");
  assert.ok(dismissLogs.some((line) => line.includes("Could not dismiss review #2")));
  assert.ok(dismissLogs.some((line) => line.includes("Superseded reviews: eligible=1 dismissed=0 minimized=1 failed=1")));
});

// #1144: end-to-end against the REAL Forgejo adapter — the publish seam's
// normalized review states and the REST dismissal path, driven through the
// publisher itself (no mock adapter in between).
test("#1144: a Forgejo publish run dismisses a stale REQUEST_CHANGES verdict and hides no body", async () => {
  const FORGE = "https://forge.example";
  const reviews: Array<Record<string, unknown>> = [
    { id: 10, state: "REQUEST_CHANGES", body: `${MARKER}\nstale blocking verdict`, user: { login: "bot" } },
    { id: 11, state: "COMMENT", body: `${MARKER}\nstale advisory`, user: { login: "bot" } },
  ];
  const calls: { method: string; url: string }[] = [];
  const json = (status: number, data: unknown): Response =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    if (method === "GET" && url === `${FORGE}/api/v1/repos/o/r/pulls/42`) return json(200, { head: { sha: HEAD } });
    if (method === "GET" && url === `${FORGE}/api/v1/repos/o/r/pulls/42/reviews?limit=100&page=1`) return json(200, reviews);
    if (method === "GET" && url === `${FORGE}/api/v1/user`) return json(200, { login: "bot" });
    if (method === "POST" && url === `${FORGE}/api/v1/repos/o/r/pulls/42/reviews`) {
      const body = JSON.parse(String(init?.body)) as { body: string };
      reviews.push({ id: 12, state: "COMMENT", body: body.body, user: { login: "bot" } });
      return json(201, { id: 12 });
    }
    if (method === "POST" && url.endsWith("/dismissals")) return json(200, {});
    return json(404, {});
  };
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "42", token: "pat", baseUrl: FORGE, fetchImpl });
  const result = await publishReview(
    input({ mode: "review_verdict", cleanupPreviousNativeReviews: "true", requiredChecks: "incomplete" }),
    api,
    { diffText: "" },
  );
  assert.equal(result.status, "published");
  assert.deepEqual(
    calls.filter((c) => c.method === "POST" && c.url.includes("/dismissals")).map((c) => c.url),
    [`${FORGE}/api/v1/repos/o/r/pulls/42/reviews/10/dismissals`],
    "the stale REQUEST_CHANGES verdict is dismissed over REST",
  );
  assert.equal(calls.some((c) => c.url.includes("/reviews/11/dismissals")), false, "an advisory body is never dismissed");
  assert.equal(calls.some((c) => c.url.includes("/reviews/12/dismissals")), false, "the just-published review is never dismissed");
  assert.equal(calls.some((c) => c.url.includes("/graphql")), false, "Forgejo makes zero GraphQL calls");
  assert.ok(result.messages.some((line) => line.includes("no GraphQL API")), "the body-hide degradation is stated");
  assert.ok(result.messages.some((line) => line.includes("Superseded reviews: eligible=1 dismissed=1")), result.messages.join("\n"));
});
