import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_FAILURE_GUIDANCE,
  evaluateApprovalGuardrails,
  markerReviewResult,
  publishReview,
  renderPartialCoverageNotice,
  resolveCleanupFlag,
} from "../src/publish/publish.js";
import { cleanupManagedReviews, resolveSupersededThreads } from "../src/publish/cleanup.js";
import { ForgejoPublishApi, forgejoReviewEvent } from "../src/platform/publish-api.js";
import type {
  NativeReviewRequest,
  PublishCommentRef,
  PublishPlatformApi,
  PublishReviewRef,
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
  stickyResult: { ok: boolean; created: boolean; error?: string } = { ok: true, created: true };
  reviewResults: { ok: boolean; error?: string }[] = [];
  dismissResult = true;
  minimizeResult = true;
  resolveResult = true;
  threadQueryError = false;

  constructor(platform: "github" | "forgejo" = "github") { this.platform = platform; }
  async getHeadSha(): Promise<string | null> { return this.head; }
  async listIssueComments(): Promise<PublishCommentRef[]> { return this.comments; }
  async upsertStickyComment(marker: string, body: string) { this.sticky.push({ marker, body }); return this.stickyResult; }
  async listReviews(): Promise<PublishReviewRef[]> { if (this.listReviewsError) throw new Error("list failed"); return this.reviews; }
  async createReview(request: NativeReviewRequest) { this.submitted.push(request); return this.reviewResults.shift() ?? { ok: true }; }
  async dismissReview(id: number | string): Promise<boolean> { this.dismissed.push(String(id)); return this.dismissResult; }
  async minimizedReviewIds(): Promise<string[]> { return this.minimizeIds; }
  async minimizeReview(id: string): Promise<boolean> { this.minimized.push(id); return this.minimizeResult; }
  async unresolvedSupersededThreads(): Promise<{ ok: boolean; threads: { id: string }[]; hasNextPage: boolean }> {
    return this.threadQueryError ? { ok: false, threads: [], hasNextPage: false } : this.threads;
  }
  async resolveThread(id: string): Promise<boolean> { this.resolved.push(id); return this.resolveResult; }
  async removeLabel(label: string): Promise<boolean> { this.removedLabels.push(label); return true; }
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
  forgejo.reviews = [{ id: 8, node_id: "node-8", state: "COMMENTED", body: MARKER }];
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
