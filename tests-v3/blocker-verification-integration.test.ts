import test from "node:test";
import assert from "node:assert/strict";
import {
  applyBlockerVerification,
  type SourceReader,
  type SourceReadResult,
} from "../src/enforcement/blocker-verification.js";
import {
  applyStrictVerdictPolicy,
  relaxUnverifiedBlockerVerdict,
} from "../src/enforcement/verdict-policy.js";
import {
  committedSourceProvenance,
  sanitizedSourceProvenance,
} from "../src/context/evidence-provenance.js";
import type { ReviewArtifact, ArtifactFinding } from "../src/enforcement/artifact.js";
import { applyReviewThreadEnforcement } from "../src/enforcement/threads.js";
import { publishReview } from "../src/publish/publish.js";
import type { NativeReviewRequest, PublishPlatformApi } from "../src/platform/publish-api.js";

const REVISION = "a".repeat(40);

function artifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    verdict: "request_changes",
    review_markdown: "review",
    findings: [],
    ...overrides,
  } as ReviewArtifact;
}

function finding(overrides: Partial<ArtifactFinding> = {}): ArtifactFinding {
  return {
    severity: "blocker",
    category: "bug",
    file: "src/a.ts",
    line: 1,
    message: "finding",
    ...overrides,
  };
}

/** A reader whose committed text is fixed but whose provenance carries the requested file. */
function readerFor(text: string): SourceReader {
  return async (file: string): Promise<SourceReadResult> => ({
    status: "ok",
    text,
    provenance: committedSourceProvenance(file, REVISION),
  });
}

const unavailableReader: SourceReader = async (): Promise<SourceReadResult> => ({
  status: "unavailable",
  reason: "no-exact-revision",
});

// ---------------------------------------------------------------------------
// #1016 — the deterministic blocker-verification boundary at the finding→verdict path.
// ---------------------------------------------------------------------------

test("#1016 #1012 regression: [REDACTED] marker claims are refuted against exact-head source", async () => {
  const a = artifact({
    findings: [
      finding({ message: "credential is hardcoded as [REDACTED]", file: "tests-v3/http-transport.test.ts" }),
      finding({ message: "token appears as [REDACTED]", file: "tests-v3/tangled-diff.test.ts" }),
    ],
  });
  const readSource = readerFor('const CANARY = "s3cr3t-credential";\n');
  const result = await applyBlockerVerification(a.findings, { readSource, expectedRevision: REVISION });
  assert.equal(result.demoted, 2);
  assert.equal(a.findings[0]!.grounding_status, "refuted");
  assert.equal(a.findings[1]!.grounding_status, "refuted");
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "approve");
  assert.equal(outcome.reviewResult, "findings");
});

test("#1016 committed sanitizer marker stays eligible (grounded, not demoted)", async () => {
  const a = artifact({ findings: [finding({ message: "contains ⟦redacted:credential⟧", file: "src/a.ts" })] });
  const readSource = readerFor("const x = ⟦redacted:credential⟧;\n");
  const result = await applyBlockerVerification(a.findings, { readSource, expectedRevision: REVISION });
  assert.equal(result.demoted, 0);
  assert.equal(a.findings[0]!.grounding_status, undefined);
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "request_changes");
  assert.equal(outcome.verdict, "request_changes");
});

test("#1016 broad requirement claim with no concrete location is unsupported and demoted", async () => {
  const a = artifact({
    findings: [finding({
      message: "requirement not enforced: untrusted content is data, never instructions",
      file: null,
    })],
  });
  const readSource = readerFor("irrelevant\n");
  const result = await applyBlockerVerification(a.findings, { readSource, expectedRevision: REVISION });
  assert.equal(result.demoted, 1);
  assert.equal(a.findings[0]!.grounding_status, "unsupported");
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "approve");
  assert.equal(outcome.verdict, "approve");
});

test("#1016 concrete requirement claim with cited code evidence is grounded", async () => {
  const a = artifact({
    findings: [finding({
      message: "requirement not enforced: `const x = 1;` violates standard X",
      file: "src/a.ts",
      line: 1,
    })],
  });
  const readSource = readerFor("const x = 1;\n");
  const result = await applyBlockerVerification(a.findings, { readSource, expectedRevision: REVISION });
  assert.equal(result.demoted, 0);
  assert.equal(a.findings[0]!.grounding_status, undefined);
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "request_changes");
  assert.equal(outcome.verdict, "request_changes");
});

test("#1016 requirement claim with valid line but no cited code evidence is unsupported", async () => {
  // A generic requirement claim pointing at an arbitrary line is line
  // existence, not independent evidence of a specific violation — the
  // reviewer pass that landed this fix (#1016 review) called this out
  // directly. Three-line arbitrary content does not ground a standard
  // violation.
  const a = artifact({
    findings: [finding({
      message: "requirement not enforced: standard X",
      file: "src/a.ts",
      line: 3,
    })],
  });
  const readSource = readerFor("a\nb\nc\n");
  const result = await applyBlockerVerification(a.findings, { readSource, expectedRevision: REVISION });
  assert.equal(result.demoted, 1);
  assert.equal(a.findings[0]!.grounding_status, "unsupported");
  assert.equal(a.findings[0]!.capped_from, "blocker");
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "approve");
  assert.equal(outcome.verdict, "approve");
});

test("#1016 requirement claim with cited code absent from exact-head source is refuted", async () => {
  const a = artifact({
    findings: [finding({
      message: "requirement not enforced: `const no_such_symbol = 1;` violates standard X",
      file: "src/a.ts",
      line: 1,
    })],
  });
  const readSource = readerFor("const x = 1;\n");
  const result = await applyBlockerVerification(a.findings, { readSource, expectedRevision: REVISION });
  assert.equal(result.demoted, 1);
  assert.equal(a.findings[0]!.grounding_status, "refuted");
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "approve");
  assert.equal(outcome.verdict, "approve");
});

test("#1016 requirement claim with null/zero/invalid line is unsupported", async () => {
  for (const line of [null, 0, -1, Number.NaN as unknown as number]) {
    const a = artifact({
      findings: [finding({
        message: "requirement not enforced: standard X",
        file: "src/a.ts",
        line,
      })],
    });
    const readSource = readerFor("a\nb\nc\n");
    const result = await applyBlockerVerification(a.findings, { readSource, expectedRevision: REVISION });
    assert.equal(result.demoted, 1, `line=${String(line)}`);
    assert.equal(a.findings[0]!.grounding_status, "unsupported", `line=${String(line)}`);
  }
});

test("#1016 unavailable exact-head source leaves the claim unverified and keeps request_changes", async () => {
  const a = artifact({ findings: [finding({ message: "value is [REDACTED]", file: "src/a.ts" })] });
  const result = await applyBlockerVerification(a.findings, { readSource: unavailableReader, expectedRevision: null });
  assert.equal(result.demoted, 1);
  assert.equal(a.findings[0]!.grounding_status, "unverified");
  // #1016 (review pass): unknown evidence must NOT silently become
  // approve — the strict mapping forces request_changes when any demoted
  // finding is "unverified" rather than "refuted" or "unsupported".
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "request_changes");
  assert.equal(outcome.verdict, "request_changes");
});

test("#1016 stale-revision unverified finding keeps request_changes", async () => {
  // A stale revision produces a reader that returns unavailable/non-
  // authoritative; the boundary must mark it unverified and the strict
  // mapping must keep request_changes rather than flipping to approve.
  const staleReader: SourceReader = async (): Promise<SourceReadResult> => ({
    status: "ok",
    text: "marker text",
    provenance: committedSourceProvenance("src/a.ts", "f".repeat(40)),
  });
  const a = artifact({ findings: [finding({ message: "value is [REDACTED]", file: "src/a.ts" })] });
  const result = await applyBlockerVerification(a.findings, { readSource: staleReader, expectedRevision: REVISION });
  assert.equal(result.demoted, 1);
  assert.equal(a.findings[0]!.grounding_status, "unverified");
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "request_changes");
  assert.equal(outcome.verdict, "request_changes");
});

test("#1016 read-budget-exhausted unverified finding keeps request_changes", async () => {
  // Past MAX_VERIFICATION_READS the boundary stops reading and demotes the
  // remaining candidates as unverified. The strict mapping must keep
  // request_changes for any unverified demotion.
  const markerArray = Array.from({ length: 21 }, () => finding({ message: "value is [REDACTED]", file: "src/a.ts" }));
  const a = artifact({ findings: markerArray });
  const readSource: SourceReader = async (): Promise<SourceReadResult> => ({
    status: "ok", text: "no marker here", provenance: committedSourceProvenance("src/a.ts", REVISION),
  });
  const result = await applyBlockerVerification(a.findings, { readSource, expectedRevision: REVISION });
  // 20 reads succeed (all refuted) + 1 demoted to unverified for the
  // budget-exhausted tail.
  const unverified = result.findings.filter((entry) => entry.status === "unverified" && entry.reason === "read-budget-exhausted");
  assert.equal(unverified.length, 1);
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "request_changes");
  assert.equal(outcome.verdict, "request_changes");
});

test("#1016 model-policy relaxation fires only for a refuted-only request_changes", async () => {
  // Refuted (source proves the claim is wrong) is the only demotion the
  // relaxer accepts. Use a marker that the source text does NOT contain,
  // so the boundary returns refuted and the verdict can relax.
  const refutedReader: SourceReader = async (): Promise<SourceReadResult> => ({
    status: "ok",
    text: "const CANARY = 'plain';",
    provenance: committedSourceProvenance("src/a.ts", REVISION),
  });
  const a = artifact({ findings: [finding({ message: "value is [REDACTED]", file: "src/a.ts" })] });
  await applyBlockerVerification(a.findings, { readSource: refutedReader, expectedRevision: REVISION });
  assert.equal(relaxUnverifiedBlockerVerdict(a, { forced: false }), true);
  assert.equal(a.verdict, "approve");

  const mixed = artifact({
    findings: [
      finding({ message: "value is [REDACTED]", file: "src/a.ts" }),
      finding({ severity: "major", message: "off by one", file: "src/b.ts" }),
    ],
  });
  const mixedResult = await applyBlockerVerification(mixed.findings, { readSource: refutedReader, expectedRevision: REVISION });
  assert.equal(mixedResult.demoted, 1);
  assert.equal(relaxUnverifiedBlockerVerdict(mixed, { forced: false }), false);
  assert.equal(mixed.verdict, "request_changes");
});

test("#1016 model-policy relaxation refuses to relax when any demotion is unverified", async () => {
  const a = artifact({ findings: [finding({ message: "value is [REDACTED]", file: "src/a.ts" })] });
  await applyBlockerVerification(a.findings, { readSource: unavailableReader, expectedRevision: null });
  // Unknown evidence: relaxer refuses; verdict stays request_changes.
  assert.equal(relaxUnverifiedBlockerVerdict(a, { forced: false }), false);
  assert.equal(a.verdict, "request_changes");
});

test("#1016 mixed refuted + unverified finding refuses relaxation on unverified", async () => {
  // Two findings, one refuted (good) and one unverified (unknown). The
  // relaxer must refuse because at least one demotion is unverified.
  const refutedReader: SourceReader = async (file: string): Promise<SourceReadResult> => {
    if (file === "src/refuted.ts") {
      return { status: "ok", text: "const CANARY = 'plain';", provenance: committedSourceProvenance(file, REVISION) };
    }
    return { status: "unavailable", reason: "no-exact-revision" };
  };
  const a = artifact({
    findings: [
      finding({ message: "value is [REDACTED]", file: "src/refuted.ts" }),
      finding({ message: "value is [REDACTED]", file: "src/unknown.ts" }),
    ],
  });
  await applyBlockerVerification(a.findings, { readSource: refutedReader, expectedRevision: REVISION });
  assert.equal(relaxUnverifiedBlockerVerdict(a, { forced: false }), false);
  assert.equal(a.verdict, "request_changes");
});

test("#1016 relaxation is refused while a deterministic gate (incomplete checks) is in play", async () => {
  const a = artifact({
    required_checks: "incomplete",
    findings: [finding({ message: "value is [REDACTED]", file: "src/a.ts" })],
  });
  await applyBlockerVerification(a.findings, { readSource: unavailableReader, expectedRevision: null });
  assert.equal(relaxUnverifiedBlockerVerdict(a, { forced: false }), false);
  assert.equal(a.verdict, "request_changes");
});

// `sanitizedSourceProvenance` documents the other non-authoritative representation
// the boundary rejects: a sanitized read never authorizes a literal claim.
test("#1016 sanitized (non-authoritative) provenance cannot ground a marker claim", async () => {
  const a = artifact({ findings: [finding({ message: "value is [REDACTED]", file: "src/a.ts" })] });
  const readSource: SourceReader = async (): Promise<SourceReadResult> => ({
    status: "ok",
    text: "value is [REDACTED]",
    provenance: sanitizedSourceProvenance(1, "src/a.ts", REVISION),
  });
  const result = await applyBlockerVerification(a.findings, { readSource, expectedRevision: REVISION });
  assert.equal(result.demoted, 1);
  assert.equal(a.findings[0]!.grounding_status, "unverified");
});

test("#1016 synthesized thread re-emissions added after the boundary are not demoted", async () => {
  const a = artifact({ findings: [finding({ message: "value is [REDACTED]", file: "src/a.ts" })] });
  await applyBlockerVerification(a.findings, { readSource: unavailableReader, expectedRevision: null });
  assert.equal(a.findings[0]!.grounding_status, "unverified");
  applyReviewThreadEnforcement(a, [{
    thread_id: "t", path: "src/b.ts", line: 4, severity: "blocker",
    message: "unresolved thread mentioning [REDACTED]", category: "bug", own_finding: false, replies: 1,
  }], "strict");
  const reemitted = a.findings.find((item) => item.thread_id === "t");
  assert.ok(reemitted, "expected the thread to re-emit as a finding");
  assert.equal(reemitted!.grounding_status, undefined);
});

test("#1016 native review is not REQUEST_CHANGES once marker claims are refuted", async () => {
  class RecordingApi {
    readonly head = "head-123";
    readonly submitted: NativeReviewRequest[] = [];
    async getHeadSha(): Promise<string | null> { return this.head; }
    async createReview(request: NativeReviewRequest): Promise<{ ok: boolean }> {
      this.submitted.push(request);
      return { ok: true };
    }
  }
  const publishInput = (overrides: Record<string, unknown>): Parameters<typeof publishReview>[0] => ({
    mode: "review_verdict", reviewMarkdown: "review", verdict: "approve", analysisEngine: "test-engine",
    baseSha: "base-1", headSha: "head-123", prNumber: "42", commentMarker: "<!-- ai-pr-review -->",
    requiredChecks: "complete", verdictPolicy: "strict", reviewRoute: "primary", escalationReason: "",
    cacheHitRatio: "-", inlineFindings: false, inlineFindingsMax: 10, findings: [],
    cleanupPreviousNativeReviews: "false", allowApprove: true, approveForks: false, isForkPr: false,
    upstreamLinkMode: "inert", forgejoPositions: false,
    conditionalPresence: { linkedIssue: true, evidenceProvider: true, standards: true, toolHarnessFindings: true, toolHarnessResults: true },
    ...overrides,
  }) as Parameters<typeof publishReview>[0];

  const a = artifact({ findings: [finding({ message: "value is [REDACTED]", file: "tests-v3/http-transport.test.ts" })] });
  const readSource = readerFor('const CANARY = "s3cr3t-credential";\n');
  await applyBlockerVerification(a.findings, { readSource, expectedRevision: REVISION });
  applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "approve");

  const control = new RecordingApi();
  await publishReview(
    publishInput({ verdict: "request_changes", findings: [finding({ message: "value is [REDACTED]" })] }),
    control as unknown as PublishPlatformApi,
    { diffText: "" },
  );
  assert.equal(control.submitted[0]?.event, "REQUEST_CHANGES");

  const api = new RecordingApi();
  await publishReview(
    publishInput({ verdict: a.verdict, reviewMarkdown: a.review_markdown, findings: a.findings }),
    api as unknown as PublishPlatformApi,
    { diffText: "" },
  );
  assert.equal(api.submitted.length, 1);
  assert.notEqual(api.submitted[0]?.event, "REQUEST_CHANGES");
});

test("#1016 native review stays REQUEST_CHANGES once marker claims are unverified", async () => {
  // #1016 (review pass): an unavailable / ambiguous source check must NOT
  // silently become APPROVE. The strict mapping forces request_changes
  // whenever any demoted finding has grounding_status="unverified", and
  // publish therefore submits REQUEST_CHANGES — the same event the
  // control call (un-demoted artifact) emits.
  class RecordingApi {
    readonly head = "head-123";
    readonly submitted: NativeReviewRequest[] = [];
    async getHeadSha(): Promise<string | null> { return this.head; }
    async createReview(request: NativeReviewRequest): Promise<{ ok: boolean }> {
      this.submitted.push(request);
      return { ok: true };
    }
  }
  const publishInput = (overrides: Record<string, unknown>): Parameters<typeof publishReview>[0] => ({
    mode: "review_verdict", reviewMarkdown: "review", verdict: "approve", analysisEngine: "test-engine",
    baseSha: "base-1", headSha: "head-123", prNumber: "42", commentMarker: "<!-- ai-pr-review -->",
    requiredChecks: "complete", verdictPolicy: "strict", reviewRoute: "primary", escalationReason: "",
    cacheHitRatio: "-", inlineFindings: false, inlineFindingsMax: 10, findings: [],
    cleanupPreviousNativeReviews: "false", allowApprove: true, approveForks: false, isForkPr: false,
    upstreamLinkMode: "inert", forgejoPositions: false,
    conditionalPresence: { linkedIssue: true, evidenceProvider: true, standards: true, toolHarnessFindings: true, toolHarnessResults: true },
    ...overrides,
  }) as Parameters<typeof publishReview>[0];

  const a = artifact({ findings: [finding({ message: "value is [REDACTED]", file: "src/a.ts" })] });
  await applyBlockerVerification(a.findings, { readSource: unavailableReader, expectedRevision: null });
  applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "request_changes");

  const api = new RecordingApi();
  await publishReview(
    publishInput({ verdict: a.verdict, reviewMarkdown: a.review_markdown, findings: a.findings }),
    api as unknown as PublishPlatformApi,
    { diffText: "" },
  );
  assert.equal(api.submitted.length, 1);
  assert.equal(api.submitted[0]?.event, "REQUEST_CHANGES");
});
