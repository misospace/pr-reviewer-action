import test from "node:test";
import assert from "node:assert/strict";
import type { ReviewArtifact } from "../src/enforcement/artifact.js";
import { applyStrictVerdictPolicy } from "../src/enforcement/verdict-policy.js";
import {
  computeReviewDisposition,
  normalizePublishedRecommendation,
  type ReviewDisposition,
} from "../src/publish/disposition.js";
import { publishReview } from "../src/publish/publish.js";
import { computeReviewAttestation } from "../src/publish/attestation.js";
import { parseReviewHandoffBlock } from "../src/publish/handoff.js";
import type { NativeReviewSurface, PublishPlatformApi } from "../src/platform/publish-api.js";

// ---------------------------------------------------------------------------
// #1596 — the published recommendation, the native review event and the
// model prose must never contradict the deterministic disposition.
// ---------------------------------------------------------------------------

const MARKER = "<!-- ai-pr-review -->";
/** A full git object id: the attestation's `approved` conclusion is only
 * reachable when the head is a bindable SHA. */
const HEAD = "a".repeat(40);

class MockPublishApi implements PublishPlatformApi {
  readonly platform: "github" | "forgejo" = "github";
  readonly nativeReviewSurface: NativeReviewSurface;
  constructor(surface: NativeReviewSurface = { supported: true }) { this.nativeReviewSurface = surface; }
  head: string | null = HEAD;
  sticky: { marker: string; body: string }[] = [];
  submitted: Parameters<PublishPlatformApi["createReview"]>[0][] = [];
  removedLabels: string[] = [];
  comments: never[] = [];
  reviews: never[] = [];
  async getHeadSha(): Promise<string | null> { return this.head; }
  async listIssueComments() { return this.comments; }
  async upsertStickyComment(marker: string, body: string) { this.sticky.push({ marker, body }); return { ok: true, created: true }; }
  async listReviews() { return this.reviews; }
  async listManagedInlineComments() { return { supported: true, complete: true, comments: [] }; }
  async retireInlineComment() { return true; }
  async createReview(request: Parameters<PublishPlatformApi["createReview"]>[0]) { this.submitted.push(request); return { ok: true }; }
  async dismissReview(): Promise<boolean> { return true; }
  async minimizedReviewIds(): Promise<string[]> { return []; }
  async minimizeReview(): Promise<boolean> { return true; }
  async unresolvedSupersededThreads() { return { ok: true, threads: [], hasNextPage: false }; }
  async resolveThread(): Promise<boolean> { return true; }
  async removeLabel(label: string): Promise<boolean> { this.removedLabels.push(label); return true; }
  async requestReviewers(): ReturnType<PublishPlatformApi["requestReviewers"]> {
    return { ok: true, supported: true, requestedUsers: [], requestedTeams: [], alreadyRequestedUsers: [], alreadyRequestedTeams: [] };
  }
}

function publishInput(overrides: Record<string, unknown> = {}): Parameters<typeof publishReview>[0] {
  return {
    mode: "comment", reviewMarkdown: "## Review\n\nBody.", verdict: "approve",
    verdictPolicy: "strict", analysisEngine: "test-engine", baseSha: "base-1", headSha: HEAD,
    prNumber: "42", commentMarker: MARKER, requiredChecks: "complete", reviewRoute: "primary",
    escalationReason: "", cacheHitRatio: "-", inlineFindings: false, inlineFindingsMax: 10,
    findings: [], cleanupPreviousNativeReviews: "false", allowApprove: false, approveForks: false,
    isForkPr: false, upstreamLinkMode: "inert", conditionalPresence: {
      linkedIssue: true, evidenceProvider: true, standards: true,
      toolHarnessFindings: true, toolHarnessResults: true,
    }, forgejoPositions: false, ...overrides,
  } as Parameters<typeof publishReview>[0];
}

function finding(severity: string, category = "bug"): Record<string, unknown> {
  return { severity, category, file: "src/a.ts", line: 4, message: "finding" };
}

/** The published `review-handoff/v1` payload of a body — the machine
 * surface that states the same verdict and review result as the marker. */
function handoffPayload(body: string): { verdict: string; review_result: string; required_checks: string } {
  const match = /<!-- ai-pr-reviewer-handoff:v1 -->\n```json\n([\s\S]*?)\n```/.exec(body);
  assert.ok(match !== null, "the body carries the handoff container");
  return JSON.parse(match![1]!) as { verdict: string; review_result: string; required_checks: string };
}

const INCOMPLETE_RECOMMENDATION = "🟡 **Automated recommendation: INCOMPLETE — no blocking code defect proven; approval withheld (review coverage incomplete)**";
const REQUEST_CHANGES_RECOMMENDATION = "⚠️ **Automated recommendation: REQUEST CHANGES**";
const APPROVE_RECOMMENDATION = "✅ **Automated recommendation: APPROVE**";
const ADVISORY_APPROVE_RECOMMENDATION = "🟡 **Automated recommendation: APPROVE — advisory, no approval certified**";

/**
 * The disposition inputs, with the neutral defaults the tests rely on: a
 * verdict-bearing native publication, an execution coverage gap and no open
 * blocking finding. Each test overrides only what it exercises.
 */
function disposition(overrides: Partial<Parameters<typeof computeReviewDisposition>[0]> = {}): ReviewDisposition {
  return computeReviewDisposition({
    verdict: "approve",
    validVerdict: true,
    reviewResult: "clean",
    coverageIncomplete: false,
    approvalCertified: true,
    verdictBearing: true,
    incompleteReason: "none",
    blockingFindingOpen: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. The #1579 deterministic fixture.
// ---------------------------------------------------------------------------

test("#1596: the #1579 fixture publishes the incomplete disposition, never the model's request-changes recommendation", async () => {
  // The organic #1579 run: the MODEL's JSON verdict was request_changes with
  // ZERO findings, so the strict findings policy relaxed the published
  // verdict to approve, and the required-evidence fence withheld the native
  // APPROVE. The deterministic machine state was "incomplete" — but the
  // model's prose still said "Recommendation: request changes".
  const artifact = {
    verdict: "request_changes",
    review_markdown: "## Review\n\nRecommendation: request changes\n\nThe config path is not covered.",
    findings: [],
  } as unknown as ReviewArtifact;
  const outcome = applyStrictVerdictPolicy(artifact, { modelVerdict: "request_changes", forced: false });
  assert.equal(outcome.verdict, "approve", "the strict policy relaxed the verdict: no blocking finding");
  assert.equal(outcome.overridden, true);

  const api = new MockPublishApi();
  const result = await publishReview(publishInput({
    mode: "review_verdict",
    verdict: outcome.verdict,
    requiredChecks: "incomplete",
    reviewMarkdown: artifact.review_markdown,
    findings: [],
  }), api, { diffText: "" });

  assert.equal(result.status, "published");
  // The native approval is withheld: the review is incomplete, never clean.
  assert.equal(api.submitted[0]!.event, "COMMENT");
  const body = api.submitted[0]!.body;
  // The published body states the DETERMINISTIC disposition.
  assert.ok(body.includes(INCOMPLETE_RECOMMENDATION), body);
  assert.ok(body.includes("no blocking code defect proven"), body);
  // ...and publishes no REQUEST CHANGES recommendation: no blocking code
  // defect was proven.
  assert.ok(!body.includes(REQUEST_CHANGES_RECOMMENDATION), body);
  assert.ok(!body.includes("Automated recommendation: REQUEST CHANGES"), body);
  // The model's actionable recommendation is neutralized — it survives only
  // as explicitly non-authoritative history.
  assert.ok(!body.includes("Recommendation: request changes"), body);
  assert.ok(
    body.includes("Recommendation: Incomplete — no blocking code defect proven; approval withheld (review coverage incomplete)."
      + " (Model suggestion before validation, not authoritative: request changes.)"),
    body,
  );
  // The machine surfaces agree with each other.
  assert.ok(body.includes('"review_result":"partial"'), body);
  assert.equal(handoffPayload(body).review_result, "partial");
  assert.equal(handoffPayload(body).verdict, "approve");
});

// ---------------------------------------------------------------------------
// 2. A true code blocker still publishes REQUEST CHANGES.
// ---------------------------------------------------------------------------

test("#1596: a proven blocker publishes REQUEST CHANGES and neutralizes an approving model recommendation", async () => {
  const api = new MockPublishApi();
  await publishReview(publishInput({
    mode: "review_verdict",
    verdict: "request_changes",
    findings: [finding("blocker")],
    reviewMarkdown: "## Review\n\nRecommendation: Approve\n\nBoth majors fixed.",
  }), api, { diffText: "" });

  assert.equal(api.submitted[0]!.event, "REQUEST_CHANGES");
  const body = api.submitted[0]!.body;
  assert.ok(body.includes(REQUEST_CHANGES_RECOMMENDATION), body);
  assert.ok(!body.includes("Recommendation: Approve"), body);
  assert.ok(
    body.includes("Recommendation: Request changes. (Model suggestion before validation, not authoritative: Approve.)"),
    body,
  );
});

// ---------------------------------------------------------------------------
// 3. A complete clean review still publishes APPROVE.
// ---------------------------------------------------------------------------

test("#1596: a complete clean review publishes APPROVE and keeps an agreeing model recommendation byte-identical", async () => {
  const api = new MockPublishApi();
  await publishReview(publishInput({
    mode: "review_verdict",
    verdict: "approve",
    reviewMarkdown: "## Review\n\nRecommendation: Approve\n\nNothing to change.",
  }), api, { diffText: "" });

  assert.equal(api.submitted[0]!.event, "APPROVE");
  const body = api.submitted[0]!.body;
  assert.ok(body.includes(APPROVE_RECOMMENDATION), body);
  // The model agreed with the disposition: its prose is untouched.
  assert.ok(body.includes("Recommendation: Approve"), body);
  assert.ok(!body.includes("not authoritative"), body);
});

// ---------------------------------------------------------------------------
// 4. Model prose disagreement, both ways.
// ---------------------------------------------------------------------------

test("#1596: an approving model recommendation is neutralized under an incomplete disposition", async () => {
  const api = new MockPublishApi();
  await publishReview(publishInput({
    mode: "review_verdict",
    verdict: "approve",
    requiredChecks: "incomplete",
    reviewMarkdown: "## Review\n\nRecommendation: Approve\n\nLooks fine to me.",
  }), api, { diffText: "" });

  assert.equal(api.submitted[0]!.event, "COMMENT");
  const body = api.submitted[0]!.body;
  assert.ok(!body.includes("Recommendation: Approve"), body);
  assert.ok(
    body.includes("Recommendation: Incomplete — no blocking code defect proven; approval withheld (review coverage incomplete)."
      + " (Model suggestion before validation, not authoritative: Approve.)"),
    body,
  );
});

test("#1596: a request-changes model recommendation is neutralized under an approve disposition", async () => {
  const api = new MockPublishApi();
  await publishReview(publishInput({
    mode: "review_verdict",
    verdict: "approve",
    reviewMarkdown: "## Review\n\nRecommendation: request changes\n\nThe handler is unvalidated.",
  }), api, { diffText: "" });

  assert.equal(api.submitted[0]!.event, "APPROVE");
  const body = api.submitted[0]!.body;
  assert.ok(!body.includes("Recommendation: request changes"), body);
  assert.ok(
    body.includes("Recommendation: Approve. (Model suggestion before validation, not authoritative: request changes.)"),
    body,
  );
});

test("#1596: a leading 'Approve.' statement is neutralized", async () => {
  const api = new MockPublishApi();
  await publishReview(publishInput({
    mode: "review_verdict",
    verdict: "request_changes",
    findings: [finding("blocker")],
    reviewMarkdown: "Approve. Both majors fixed.",
  }), api, { diffText: "" });

  assert.equal(api.submitted[0]!.event, "REQUEST_CHANGES");
  const body = api.submitted[0]!.body;
  assert.ok(!body.includes("Approve. Both majors fixed."), body);
  assert.ok(
    body.includes("Request changes. (Model suggestion before validation, not authoritative: Approve.) Both majors fixed."),
    body,
  );
});

// ---------------------------------------------------------------------------
// 5. A stale head publishes nothing.
// ---------------------------------------------------------------------------

test("#1596: a superseded head publishes nothing and claims no approval", async () => {
  const api = new MockPublishApi();
  api.head = "b".repeat(40);
  const result = await publishReview(publishInput({
    mode: "review_verdict",
    verdict: "approve",
    reviewMarkdown: "## Review\n\nRecommendation: Approve",
  }), api, { diffText: "" });

  assert.equal(result.status, "superseded");
  assert.equal(result.native, undefined, "no native event was attempted");
  assert.equal(api.sticky.length, 0, "nothing was published");
  assert.equal(api.submitted.length, 0, "no native review was submitted");
});

// ---------------------------------------------------------------------------
// 6. Cross-surface consistency.
// ---------------------------------------------------------------------------

test("#1596: the disposition, the body, the native event, the handoff and the attestation never contradict each other", async () => {
  // (a) The incomplete case: an abstention is never an approval anywhere.
  const incomplete = new MockPublishApi();
  const incompleteResult = await publishReview(publishInput({
    mode: "review_verdict",
    verdict: "approve",
    requiredChecks: "incomplete",
    reviewMarkdown: "## Review\n\nRecommendation: request changes",
  }), incomplete, { diffText: "" });
  assert.equal(incomplete.submitted[0]!.event, "COMMENT");
  const incompleteBody = incomplete.submitted[0]!.body;
  assert.ok(incompleteBody.includes(INCOMPLETE_RECOMMENDATION), incompleteBody);
  const incompleteHandoff = handoffPayload(incompleteBody);
  assert.equal(incompleteHandoff.review_result, "partial");
  assert.equal(incompleteHandoff.verdict, "approve");
  const incompleteAttestation = computeReviewAttestation({
    verdict: "approve",
    requiredChecks: "incomplete",
    reviewResult: "partial",
    incompleteReason: "execution",
    headSha: HEAD,
    publication: {
      status: incompleteResult.status,
      ...(incompleteResult.native ? { native: incompleteResult.native } : {}),
    },
  });
  assert.notEqual(incompleteAttestation.conclusion, "approved");
  assert.equal(incompleteAttestation.conclusion, "incomplete");

  // (b) The complete case: a landed, commit-bound native APPROVE is the one
  // conclusion every surface agrees on.
  const approved = new MockPublishApi();
  const approvedResult = await publishReview(publishInput({
    mode: "review_verdict",
    verdict: "approve",
    reviewMarkdown: "## Review\n\nRecommendation: Approve",
  }), approved, { diffText: "" });
  assert.equal(approved.submitted[0]!.event, "APPROVE");
  const approvedBody = approved.submitted[0]!.body;
  assert.ok(approvedBody.includes(APPROVE_RECOMMENDATION), approvedBody);
  const approvedHandoff = handoffPayload(approvedBody);
  assert.equal(approvedHandoff.review_result, "clean");
  assert.equal(approvedHandoff.verdict, "approve");
  const approvedAttestation = computeReviewAttestation({
    verdict: "approve",
    requiredChecks: "complete",
    reviewResult: "clean",
    incompleteReason: "none",
    headSha: HEAD,
    publication: {
      status: approvedResult.status,
      ...(approvedResult.native ? { native: approvedResult.native } : {}),
    },
  });
  assert.equal(approvedAttestation.conclusion, "approved");
  assert.equal(approvedAttestation.reason_code, "native_approval_submitted");
});

// ---------------------------------------------------------------------------
// 7. The pure functions.
// ---------------------------------------------------------------------------

test("#1596: computeReviewDisposition applies the kind precedence and the native-event rule", () => {
  // An invalid verdict is a failed run, never a clean review.
  const unavailable = disposition({
    verdict: "", validVerdict: false, reviewResult: "clean", coverageIncomplete: false, approvalCertified: false,
  });
  assert.equal(unavailable.kind, "unavailable");
  assert.equal(unavailable.nativeEvent, "COMMENT");
  assert.equal(unavailable.blockerProven, false);
  assert.equal(unavailable.recommendation, "🟡 **Automated recommendation: NO VERDICT**");
  assert.equal(unavailable.statement, "No verdict");

  // A proven blocker outranks a coverage gap.
  const blocking = disposition({
    verdict: "request_changes", validVerdict: true, reviewResult: "issues", coverageIncomplete: true, approvalCertified: false,
  });
  assert.equal(blocking.kind, "request_changes");
  assert.equal(blocking.nativeEvent, "REQUEST_CHANGES");
  assert.equal(blocking.blockerProven, true);
  assert.equal(blocking.recommendation, REQUEST_CHANGES_RECOMMENDATION);
  assert.equal(blocking.statement, "Request changes");

  // A coverage gap is an abstention: never an approval, never a block.
  const incomplete = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "partial", coverageIncomplete: true, approvalCertified: false,
  });
  assert.equal(incomplete.kind, "incomplete");
  assert.equal(incomplete.nativeEvent, "COMMENT");
  assert.equal(incomplete.blockerProven, false);
  assert.equal(incomplete.coverageIncomplete, true);
  assert.equal(incomplete.recommendation, INCOMPLETE_RECOMMENDATION);
  assert.equal(incomplete.statement, "Incomplete — no blocking code defect proven; approval withheld (review coverage incomplete)");

  // An approve only certifies a native APPROVE when the approval is certified.
  const certified = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "clean", coverageIncomplete: false, approvalCertified: true,
  });
  assert.equal(certified.kind, "approve");
  assert.equal(certified.nativeEvent, "APPROVE");
  assert.equal(certified.approvalCertified, true);
  assert.equal(certified.recommendation, APPROVE_RECOMMENDATION);
  assert.equal(certified.statement, "Approve");

  const uncertified = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "clean", coverageIncomplete: false, approvalCertified: false,
  });
  assert.equal(uncertified.kind, "approve");
  assert.equal(uncertified.nativeEvent, "COMMENT", "an uncertified approve never certifies a native APPROVE");
  assert.equal(uncertified.approvalCertified, false);
});

test("#1596: normalizePublishedRecommendation is a no-op when the prose agrees", () => {
  const approve = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "clean", coverageIncomplete: false, approvalCertified: true,
  });
  const prose = "## Review\n\nRecommendation: Approve\n\nNothing to change.\n";
  assert.equal(normalizePublishedRecommendation(prose, approve), prose, "byte-identical");
  // A neutral sentence is not an actionable recommendation: it stays too.
  const neutral = "## Review\n\nThe change looks reasonable.\n";
  assert.equal(normalizePublishedRecommendation(neutral, approve), neutral);
});

test("#1596: normalizePublishedRecommendation neutralizes a disagreeing structured recommendation", () => {
  const incomplete = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "partial", coverageIncomplete: true, approvalCertified: false,
  });
  assert.equal(
    normalizePublishedRecommendation("Recommendation: Approve\n", incomplete),
    "Recommendation: Incomplete — no blocking code defect proven; approval withheld (review coverage incomplete)."
      + " (Model suggestion before validation, not authoritative: Approve.)\n",
  );
  // The heading markers and the label survive; only the actionable text is
  // replaced.
  assert.equal(
    normalizePublishedRecommendation("## Recommendation: request changes\n", incomplete),
    "## Recommendation: Incomplete — no blocking code defect proven; approval withheld (review coverage incomplete)."
      + " (Model suggestion before validation, not authoritative: request changes.)\n",
  );
  // The line count never changes and no line break is introduced.
  const rewritten = normalizePublishedRecommendation("Recommendation: Approve\nmore prose\n", incomplete);
  assert.equal(rewritten.split("\n").length, "Recommendation: Approve\nmore prose\n".split("\n").length);
});

test("#1596: normalizePublishedRecommendation neutralizes a disagreeing leading statement", () => {
  const blocking = disposition({
    verdict: "request_changes", validVerdict: true, reviewResult: "issues", coverageIncomplete: false, approvalCertified: false,
  });
  assert.equal(
    normalizePublishedRecommendation("Approve. Both majors fixed.", blocking),
    "Request changes. (Model suggestion before validation, not authoritative: Approve.) Both majors fixed.",
  );
  // A leading statement that AGREES is left byte-identical.
  const agree = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "clean", coverageIncomplete: false, approvalCertified: true,
  });
  const prose = "Approve. Both majors fixed.";
  assert.equal(normalizePublishedRecommendation(prose, agree), prose);
});

test("#1596: 'Approve, no changes requested' resolves to approve (the earliest token wins)", () => {
  const approve = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "clean", coverageIncomplete: false, approvalCertified: true,
  });
  const incomplete = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "partial", coverageIncomplete: true, approvalCertified: false,
  });
  const prose = "Recommendation: Approve, no changes requested.";
  // It agrees with an approve disposition, so it stays byte-identical...
  assert.equal(normalizePublishedRecommendation(prose, approve), prose);
  // ...and it contradicts an incomplete disposition, so it is neutralized.
  assert.equal(
    normalizePublishedRecommendation(prose, incomplete),
    "Recommendation: Incomplete — no blocking code defect proven; approval withheld (review coverage incomplete)."
      + " (Model suggestion before validation, not authoritative: Approve, no changes requested.)",
  );
});

test("#1596: a label-only '## Recommendation' heading is reconciled with the disposition", () => {
  const incomplete = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "partial", coverageIncomplete: true, approvalCertified: false,
  });
  const approve = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "clean", coverageIncomplete: false, approvalCertified: true,
  });
  // The heading stays; the recommendation line below it is the actionable one.
  assert.equal(
    normalizePublishedRecommendation("## Recommendation\n\nApprove. Uses `snake_case` names.\n", incomplete),
    "## Recommendation\n\n"
      + "Incomplete — no blocking code defect proven; approval withheld (review coverage incomplete)."
      + " (Model suggestion before validation, not authoritative: Approve.) Uses `snake_case` names.\n",
  );
  // A heading form that AGREES is left byte-identical.
  const prose = "## Recommendation\n\nApprove. Uses `snake_case` names.\n";
  assert.equal(normalizePublishedRecommendation(prose, approve), prose);
  // A heading whose next line states no direction is left alone.
  const neutral = "## Recommendation\n\nThe change looks reasonable.\n";
  assert.equal(normalizePublishedRecommendation(neutral, incomplete), neutral);
});

test("#1596: a negated approval reads as a request for changes, not as an approval", () => {
  const approve = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "clean", coverageIncomplete: false, approvalCertified: true,
  });
  const blocking = disposition({
    verdict: "request_changes", validVerdict: true, reviewResult: "issues", coverageIncomplete: false, approvalCertified: false,
  });
  // "Do not approve" carries the approve word but states the opposite
  // direction: the negation turns the approve word into a request for
  // changes.
  for (const prose of [
    "Recommendation: Do not approve — the migration is missing.",
    "Recommendation: Cannot approve until the lockfile is regenerated.",
    "Recommendation: Don't approve yet.",
  ]) {
    // It agrees with a request-changes disposition, so it stays byte-identical.
    assert.equal(normalizePublishedRecommendation(prose, blocking), prose);
    // It contradicts an approve disposition, so it is neutralized.
    assert.ok(
      normalizePublishedRecommendation(prose, approve).startsWith("Recommendation: Approve. (Model suggestion before validation, not authoritative:"),
      prose,
    );
  }
});

test("#1596: a negated approval is neutralized as a leading statement too", () => {
  const approve = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "clean", coverageIncomplete: false, approvalCertified: true,
  });
  assert.equal(
    normalizePublishedRecommendation("Cannot approve — the migration is missing.", approve),
    "Approve. (Model suggestion before validation, not authoritative: Cannot approve.) — the migration is missing.",
  );
});

test("#1596: an unrelated sentence that merely contains 'blocking' is not read as a recommendation", () => {
  const approve = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "clean", coverageIncomplete: false, approvalCertified: true,
  });
  const incomplete = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "partial", coverageIncomplete: true, approvalCertified: false,
  });
  // "blocking" is not a request-direction token: a recommendation line that
  // does not state a direction stays untouched.
  const prose = "Recommendation: The queue worker is blocking the shutdown path.";
  assert.equal(normalizePublishedRecommendation(prose, incomplete), prose);
  assert.equal(normalizePublishedRecommendation(prose, approve), prose);
});

test("#1596: normalizePublishedRecommendation is total — empty and non-recommending prose stay unchanged", () => {
  const approve: ReviewDisposition = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "clean", coverageIncomplete: false, approvalCertified: true,
  });
  assert.equal(normalizePublishedRecommendation("", approve), "");
  assert.equal(normalizePublishedRecommendation("\n\n", approve), "\n\n");
  assert.equal(
    normalizePublishedRecommendation("## Review\n\nLooks good.\n", approve),
    "## Review\n\nLooks good.\n",
  );
});

// ---------------------------------------------------------------------------
// 8. The review findings of the #1596 change, as regressions.
// ---------------------------------------------------------------------------

test("#1596: a withheld approval publishes the advisory recommendation, never a certified APPROVE", async () => {
  // A fork pull request with `approve-forks: false`: the review concluded
  // approve, but the scope policy withholds the native approval, so the
  // native event is a non-blocking COMMENT. The published recommendation must
  // not read as a certified approval.
  const api = new MockPublishApi();
  await publishReview(publishInput({
    mode: "review_verdict",
    verdict: "approve",
    isForkPr: true,
    approveForks: false,
    reviewMarkdown: "## Review\n\nRecommendation: Approve",
  }), api, { diffText: "" });

  assert.equal(api.submitted[0]!.event, "COMMENT");
  const body = api.submitted[0]!.body;
  assert.ok(body.includes(ADVISORY_APPROVE_RECOMMENDATION), body);
  assert.ok(!body.includes(APPROVE_RECOMMENDATION), body);
  assert.ok(body.includes("Approval withheld by scope policy"), body);
});

test("#1596: the blockers-only mode publishes the advisory recommendation too", async () => {
  // `review_blockers` never publishes an approval, under any verdict.
  const api = new MockPublishApi();
  await publishReview(publishInput({
    mode: "review_blockers",
    verdict: "approve",
    reviewMarkdown: "## Review\n\nRecommendation: Approve",
  }), api, { diffText: "" });

  assert.equal(api.submitted[0]!.event, "COMMENT");
  const body = api.submitted[0]!.body;
  assert.ok(body.includes(ADVISORY_APPROVE_RECOMMENDATION), body);
  assert.ok(!body.includes(APPROVE_RECOMMENDATION), body);
});

test("#1596: an open blocker under a non-strict policy never certifies an approval", async () => {
  // The published defect owns the publication even when the verdict policy
  // left the model's own approve standing: the native event is
  // REQUEST_CHANGES, the recommendation line says so, and the approving
  // prose is reconciled — never a certified APPROVE, never a COMMENT.
  const api = new MockPublishApi();
  await publishReview(publishInput({
    mode: "review_verdict",
    verdictPolicy: "model",
    verdict: "approve",
    findings: [finding("major")],
    reviewMarkdown: "## Review\n\nRecommendation: Approve\n",
  }), api, { diffText: "" });

  assert.equal(api.submitted[0]!.event, "REQUEST_CHANGES");
  const body = api.submitted[0]!.body;
  assert.ok(body.includes(REQUEST_CHANGES_RECOMMENDATION), body);
  assert.ok(!body.includes(APPROVE_RECOMMENDATION), body);
  assert.ok(
    body.includes(
      "Recommendation: Request changes. (Model suggestion before validation, not authoritative: Approve.)",
    ),
    body,
  );
});

/** A reviewed diff with one changed file, so the inline-comment build has a
 * position map to anchor the suggestion-bearing finding against. */
const SUGGESTION_DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n old\n+new line\n";

test("#1596: the handoff agrees with a disposition-proven REQUEST CHANGES in both handoff variants", async () => {
  // The publication-contract blocker: computeReviewDisposition can prove a
  // blocking defect (an open major) while the raw model verdict stays an
  // approve, and the native event follows the disposition — so the published
  // handoff must follow it too, or the machine-readable document would tell
  // a controller `approve`/`clean` beside a blocking request. BOTH handoff
  // variants (the suggestion-carrying body and the suggestion-free
  // fallback/recovery body) are built from the disposition.
  const findings = [{
    severity: "major", category: "bug", file: "a.ts", line: 2,
    message: "A finding", suggestion: "REPL",
  }];
  const publishBlocking = (api: MockPublishApi): ReturnType<typeof publishReview> => publishReview(publishInput({
    mode: "review_verdict",
    verdictPolicy: "model",
    verdict: "approve",
    reviewId: "0123456789abcdef",
    inlineFindings: true,
    findings,
    reviewMarkdown: "## Review\n\nBody.",
  }), api, { diffText: SUGGESTION_DIFF });

  // (a) The suggestion-carrying variant: the commit-bound batch publishes the
  // inline comment that carries the replacement, and its body's handoff
  // states the authoritative words beside the native REQUEST_CHANGES.
  const carriedApi = new MockPublishApi();
  const carried = await publishBlocking(carriedApi);
  assert.equal(carried.status, "published");
  assert.equal(carriedApi.submitted.length, 1);
  assert.equal(carriedApi.submitted[0]!.event, "REQUEST_CHANGES");
  const carriedHandoff = parseReviewHandoffBlock(carriedApi.submitted[0]!.body);
  assert.ok(carriedHandoff !== null, "the suggestion-carrying body carries a parseable handoff");
  assert.equal(carriedHandoff.verdict, "request_changes", "the suggestion-carrying handoff states the disposition's verdict");
  assert.equal(carriedHandoff.review_result, "issues", "the suggestion-carrying handoff states the authoritative review result");
  assert.equal(carriedHandoff.items[0]!.suggestion, "REPL", "this IS the suggestion-carrying variant: the published replacement rides");

  // (b) The suggestion-free variant: the commit-bound batch is rejected, so
  // the body-only fallback publishes with the suggestion-free handoff — the
  // same authoritative words there too. The mock records EVERY createReview
  // call (a rejected submission still reached the forge), then fails the
  // first one.
  const fallbackApi = new MockPublishApi();
  let fallbackAttempts = 0;
  fallbackApi.createReview = async (request) => {
    fallbackApi.submitted.push(request);
    fallbackAttempts += 1;
    if (fallbackAttempts === 1) return { ok: false, error: "race" };
    return { ok: true };
  };
  const fellBack = await publishBlocking(fallbackApi);
  assert.equal(fellBack.status, "published");
  assert.equal(fallbackApi.submitted.length, 2, "the rejected commit-bound batch falls back body-only");
  assert.equal(fallbackApi.submitted[0]!.event, "REQUEST_CHANGES");
  const rejectedHandoff = parseReviewHandoffBlock(fallbackApi.submitted[0]!.body);
  assert.ok(rejectedHandoff !== null, "the rejected batch body carries a parseable handoff");
  assert.equal(rejectedHandoff.verdict, "request_changes");
  assert.equal(rejectedHandoff.review_result, "issues");
  assert.equal(rejectedHandoff.items[0]!.suggestion, "REPL");
  const fallbackHandoff = parseReviewHandoffBlock(fallbackApi.submitted[1]!.body);
  assert.ok(fallbackHandoff !== null, "the fallback body carries a parseable handoff");
  assert.equal(fallbackHandoff.verdict, "request_changes", "the suggestion-free handoff states the disposition's verdict");
  assert.equal(fallbackHandoff.review_result, "issues", "the suggestion-free handoff states the authoritative review result");
  assert.equal(fallbackHandoff.items[0]!.suggestion, undefined, "this IS the suggestion-free variant: no unbacked replacement rides");
});

test("#1596: a blocking disposition suppresses the advisory withholding notices", async () => {
  // Scope-withheld approval AND an open blocker: the publication is a
  // blocking REQUEST_CHANGES, so the "this review is advisory" notice must
  // not contradict the blocking recommendation beside it.
  const api = new MockPublishApi();
  await publishReview(publishInput({
    mode: "review_verdict",
    verdictPolicy: "model",
    verdict: "approve",
    findings: [finding("blocker")],
    isForkPr: true,
    reviewMarkdown: "## Review\n\nBody.",
  }), api, { diffText: "" });

  assert.equal(api.submitted[0]!.event, "REQUEST_CHANGES");
  const body = api.submitted[0]!.body;
  assert.ok(body.includes(REQUEST_CHANGES_RECOMMENDATION), body);
  assert.ok(!body.includes("Approval withheld by scope policy"), body);
});

test("#1596: a platform without a native surface states the blocking recommendation too", async () => {
  // The #588 advisory platform notice is the disposition's word, not the
  // verdict's: an open blocker under a non-strict approve reads as
  // REQUEST CHANGES, never as an APPROVE above the findings.
  const api = new MockPublishApi({ supported: false, reason: "no native review surface" });
  await publishReview(publishInput({
    mode: "review_verdict",
    verdictPolicy: "model",
    verdict: "approve",
    findings: [finding("major")],
    reviewMarkdown: "## Review\n\nBody.",
  }), api, { diffText: "" });

  assert.equal(api.submitted.length, 0, "no native review is created");
  const body = api.sticky[0]!.body;
  assert.ok(
    body.includes("**Automated recommendation: REQUEST CHANGES** — advisory only"),
    body,
  );
  assert.ok(!body.includes("**Automated recommendation: APPROVE** — advisory only"), body);
});

test("#1596: an advisory publication keeps the plain APPROVE recommendation", async () => {
  // A sticky comment carries no verdict-bearing native event, so there is
  // nothing for the recommendation to contradict: the review's own
  // conclusion is published.
  const api = new MockPublishApi();
  await publishReview(publishInput({
    mode: "comment",
    verdict: "approve",
    reviewMarkdown: "## Review\n\nRecommendation: Approve",
  }), api, { diffText: "" });

  const body = api.sticky[0]!.body;
  assert.ok(body.includes(APPROVE_RECOMMENDATION), body);
  assert.ok(!body.includes(ADVISORY_APPROVE_RECOMMENDATION), body);
});

test("#1596: a leading statement after a title is neutralized", async () => {
  // Real prose opens with a title, so the leading statement is not the first
  // line of the markdown — the title is skipped, the statement is not.
  const api = new MockPublishApi();
  await publishReview(publishInput({
    mode: "review_verdict",
    verdict: "request_changes",
    findings: [finding("blocker")],
    reviewMarkdown: "## Review\n\nApprove. Both majors fixed.\n",
  }), api, { diffText: "" });

  assert.equal(api.submitted[0]!.event, "REQUEST_CHANGES");
  const body = api.submitted[0]!.body;
  assert.ok(!body.includes("Approve. Both majors fixed."), body);
  assert.ok(
    body.includes("Request changes. (Model suggestion before validation, not authoritative: Approve.) Both majors fixed."),
    body,
  );
});

test("#1596: a sentence that merely opens with the noun 'Approval' is not mangled", async () => {
  const incomplete = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "partial", coverageIncomplete: true, approvalCertified: false,
  });
  const prose = "Approval of this change requires a migration.\n";
  assert.equal(normalizePublishedRecommendation(prose, incomplete), prose);
});

test("#1596: a bold recommendation label round-trips with its markers intact", async () => {
  const incomplete = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "partial", coverageIncomplete: true, approvalCertified: false,
  });
  // The label's own bold markers stay on the label; the recommendation text
  // is what changes.
  assert.equal(
    normalizePublishedRecommendation("**Recommendation:** Approve\n", incomplete),
    "**Recommendation:** Incomplete — no blocking code defect proven; approval withheld (review coverage incomplete)."
      + " (Model suggestion before validation, not authoritative: Approve.)\n",
  );
  // A label whose bold scope covers the whole line keeps the line balanced.
  assert.equal(
    normalizePublishedRecommendation("**Recommendation: Approve**\n", incomplete),
    "**Recommendation: Incomplete — no blocking code defect proven; approval withheld (review coverage incomplete)."
      + " (Model suggestion before validation, not authoritative: Approve.)**\n",
  );
});

test("#1596: a CRLF-terminated leading statement is neutralized like its LF twin", () => {
  const blocking = disposition({
    verdict: "request_changes", validVerdict: true, reviewResult: "issues", coverageIncomplete: false, approvalCertified: false,
  });
  assert.equal(
    normalizePublishedRecommendation("Approve. Both majors fixed.\r\n", blocking),
    "Request changes. (Model suggestion before validation, not authoritative: Approve.) Both majors fixed.\r\n",
  );
});

test("#1596: a model line cannot claim the action's own recommendation surface", async () => {
  const api = new MockPublishApi();
  await publishReview(publishInput({
    mode: "review_verdict",
    verdict: "request_changes",
    findings: [finding("blocker")],
    reviewMarkdown: "## Review\n\nAutomated recommendation: Approve\n",
  }), api, { diffText: "" });

  const body = api.submitted[0]!.body;
  // The action's own line is the only "Automated recommendation" statement.
  assert.equal(body.split("Automated recommendation:").length - 1, 1, body);
  assert.ok(body.includes("Model recommendation before validation"), body);
});

test("#1596: the incomplete recommendation names the coverage reason", () => {
  for (const [reason, clause] of [
    ["execution", "review coverage incomplete"],
    ["requirement_trace", "requirement trace incomplete"],
    ["both", "review coverage and requirement trace incomplete"],
  ] as const) {
    const incomplete = disposition({
      verdict: "approve", validVerdict: true, reviewResult: "partial", coverageIncomplete: true,
      approvalCertified: false, incompleteReason: reason,
    });
    assert.ok(incomplete.recommendation.includes(clause), incomplete.recommendation);
    assert.ok(incomplete.statement.includes(clause), incomplete.statement);
  }
});

test("#1596: an open blocking finding owns the disposition, never an approval or a COMMENT", () => {
  // A non-strict policy lets the model's own approve stand with an open
  // blocker finding; the disposition must still publish the proven defect:
  // REQUEST_CHANGES, never a certified APPROVE and never a COMMENT
  // abstention (the issue's distinction: code blocker -> REQUEST_CHANGES).
  const blocking = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "clean", coverageIncomplete: false,
    approvalCertified: true, blockingFindingOpen: true,
  });
  assert.equal(blocking.kind, "request_changes");
  assert.equal(blocking.nativeEvent, "REQUEST_CHANGES");
  assert.equal(blocking.blockerProven, true);
  assert.equal(blocking.recommendation, REQUEST_CHANGES_RECOMMENDATION);
  // The proven blocker also outranks a coverage gap (blocking > partial).
  const gapAndBlocker = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "partial", coverageIncomplete: true,
    approvalCertified: false, blockingFindingOpen: true,
  });
  assert.equal(gapAndBlocker.kind, "request_changes");
  assert.equal(gapAndBlocker.nativeEvent, "REQUEST_CHANGES");
  // An invalid verdict stays `unavailable`: a failed run is never turned into
  // a blocking request by carried findings either.
  const failed = disposition({
    verdict: "", validVerdict: false, reviewResult: "clean", coverageIncomplete: false,
    approvalCertified: false, blockingFindingOpen: true,
  });
  assert.equal(failed.kind, "unavailable");
  assert.equal(failed.nativeEvent, "COMMENT");
  // Without an open blocker the incomplete abstention states its own gap.
  const incomplete = disposition({
    verdict: "approve", validVerdict: true, reviewResult: "partial", coverageIncomplete: true,
    approvalCertified: false, blockingFindingOpen: false,
  });
  assert.equal(incomplete.kind, "incomplete");
  assert.ok(incomplete.recommendation.includes("no blocking code defect proven"), incomplete.recommendation);
});

test("#1596: a recommendation inside a fenced code block is still reconciled", () => {
  // The reconciliation is deliberately fence-blind: a quoted recommendation
  // is reconciled too, because skipping fences would let an unbalanced fence
  // hide a contradicting recommendation from the published body.
  const blocking = disposition({
    verdict: "request_changes", validVerdict: true, reviewResult: "issues", coverageIncomplete: false, approvalCertified: false,
  });
  const prose = "```markdown\nRecommendation: Approve\n```\n";
  const rewritten = normalizePublishedRecommendation(prose, blocking);
  assert.ok(rewritten.includes("Recommendation: Request changes."), rewritten);
  assert.equal(rewritten.split("```").length, prose.split("```").length, "the fence structure is unchanged");
});
