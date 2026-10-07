import test from "node:test";
import assert from "node:assert/strict";
import type { ReviewArtifact } from "../src/enforcement/artifact.js";
import {
  applyStrictVerdictPolicy,
  hasBlockingOpenFinding,
  strictReviewResult,
  type StrictReviewResult,
} from "../src/enforcement/verdict-policy.js";
import { resolveIncompleteReason } from "../src/publish/publish.js";
import { failOnRequestChanges } from "../src/run/action.js";
import { computeDeterministicBlock, resolveDegradedGateBypass } from "../src/run/review.js";
import { applyRequiredCheckValidation } from "../src/enforcement/completeness.js";
import { applyAllEnforcement, failClosedEnforcementFired, type EnforcementInputs } from "../src/enforcement/enforce.js";
import { applyReviewThreadEnforcement } from "../src/enforcement/threads.js";
import { buildRunMetadataMarker } from "../src/metadata/markers.js";
import { carriedVerdict } from "../src/precheck/decide.js";
import { publishReview } from "../src/publish/publish.js";
import type { PublishPlatformApi } from "../src/platform/publish-api.js";

// ---------------------------------------------------------------------------
// #811 — the published verdict is a deterministic function of the normalized
// still-open findings and coverage; the model's verdict is an input.
// ---------------------------------------------------------------------------

function artifact(modelVerdict: string, findings: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}): ReviewArtifact {
  return {
    verdict: modelVerdict,
    review_markdown: "## Review\n\nBody.",
    findings,
    ...overrides,
  } as unknown as ReviewArtifact;
}

function finding(severity: string, category = "bug"): Record<string, unknown> {
  return { severity, category, file: "src/a.ts", line: 4, message: "finding" };
}

const NO_ENFORCEMENT: EnforcementInputs = {
  evidenceBlockerEnabled: false, toolFailureEnabled: false, toolMinSuccessful: 0,
  evidence: null, toolHarness: null, threads: null, humanReviews: null, verdictPolicy: "strict",
};

/** The #811 strict composition: coverage → enforcement overlays → mapping,
 * with the fail-closed signal computed exactly as the fixture runner does. */
function runStrictPipeline(
  modelVerdict: string,
  findings: Array<Record<string, unknown>>,
  options: { coverage?: "complete" | "incomplete"; mode?: string; enforcement?: Partial<EnforcementInputs> } = {},
): {
  artifact: ReviewArtifact;
  completeness: ReturnType<typeof applyRequiredCheckValidation>;
  outcome: ReturnType<typeof applyStrictVerdictPolicy>;
} {
  const a = artifact(modelVerdict, findings);
  const mode = options.mode ?? "warn";
  const completeness = applyRequiredCheckValidation(a, {
    enabled: "auto",
    mode,
    mustCheck: options.coverage === "incomplete" ? ["run the test suite"] : [],
  });
  if (options.coverage === "incomplete") {
    // The model dispositioned nothing: conservatively unresolved.
    a.required_check_dispositions = [];
  }
  const inputs: EnforcementInputs = { ...NO_ENFORCEMENT, ...options.enforcement };
  applyAllEnforcement(a, inputs);
  const forced = failClosedEnforcementFired(inputs)
    || (completeness.status === "incomplete" && completeness.mode === "fail");
  return { artifact: a, completeness, outcome: applyStrictVerdictPolicy(a, { modelVerdict, forced }) };
}

const HIGHEST: Record<string, Array<Record<string, unknown>>> = {
  none: [],
  info: [finding("info")],
  minor: [finding("minor")],
  major: [finding("major")],
  blocker: [finding("blocker")],
};

// The verdict table: {model verdict} x {highest open severity} x {coverage},
// each giving the expected published verdict and marker review_result.
const TABLE: Array<{
  model: string;
  highest: keyof typeof HIGHEST;
  coverage: "complete" | "incomplete";
  verdict: string;
  reviewResult: StrictReviewResult;
  overridden: boolean;
}> = [
  { model: "approve", highest: "none", coverage: "complete", verdict: "approve", reviewResult: "clean", overridden: false },
  { model: "approve", highest: "none", coverage: "incomplete", verdict: "approve", reviewResult: "partial", overridden: false },
  { model: "approve", highest: "info", coverage: "complete", verdict: "approve", reviewResult: "findings", overridden: false },
  { model: "approve", highest: "info", coverage: "incomplete", verdict: "approve", reviewResult: "partial", overridden: false },
  { model: "approve", highest: "minor", coverage: "complete", verdict: "approve", reviewResult: "findings", overridden: false },
  { model: "approve", highest: "minor", coverage: "incomplete", verdict: "approve", reviewResult: "partial", overridden: false },
  { model: "approve", highest: "major", coverage: "complete", verdict: "request_changes", reviewResult: "issues", overridden: true },
  { model: "approve", highest: "major", coverage: "incomplete", verdict: "request_changes", reviewResult: "issues", overridden: true },
  { model: "approve", highest: "blocker", coverage: "complete", verdict: "request_changes", reviewResult: "issues", overridden: true },
  { model: "approve", highest: "blocker", coverage: "incomplete", verdict: "request_changes", reviewResult: "issues", overridden: true },
  { model: "request_changes", highest: "none", coverage: "complete", verdict: "approve", reviewResult: "clean", overridden: true },
  { model: "request_changes", highest: "none", coverage: "incomplete", verdict: "approve", reviewResult: "partial", overridden: true },
  { model: "request_changes", highest: "info", coverage: "complete", verdict: "approve", reviewResult: "findings", overridden: true },
  { model: "request_changes", highest: "info", coverage: "incomplete", verdict: "approve", reviewResult: "partial", overridden: true },
  // The regression: Minor/Info-only findings plus a model verdict of
  // request_changes gives the non-blocking state, never request_changes.
  { model: "request_changes", highest: "minor", coverage: "complete", verdict: "approve", reviewResult: "findings", overridden: true },
  { model: "request_changes", highest: "minor", coverage: "incomplete", verdict: "approve", reviewResult: "partial", overridden: true },
  { model: "request_changes", highest: "major", coverage: "complete", verdict: "request_changes", reviewResult: "issues", overridden: false },
  { model: "request_changes", highest: "major", coverage: "incomplete", verdict: "request_changes", reviewResult: "issues", overridden: false },
  { model: "request_changes", highest: "blocker", coverage: "complete", verdict: "request_changes", reviewResult: "issues", overridden: false },
  { model: "request_changes", highest: "blocker", coverage: "incomplete", verdict: "request_changes", reviewResult: "issues", overridden: false },
];

const NOTE = "_Verdict set from open findings (verdict_policy=strict):";

test("#954: incomplete-reason resolver separates trace and execution while retaining fail-closed legacy behavior", () => {
  assert.equal(resolveIncompleteReason({ requiredChecks: "incomplete", incompleteReason: "requirement_trace" }), "requirement_trace");
  assert.equal(resolveIncompleteReason({ requiredChecks: "incomplete", incompleteReason: "both" }), "both");
  assert.equal(resolveIncompleteReason({ requiredChecks: "incomplete", incompleteReason: "none" }), "execution");
  assert.equal(resolveIncompleteReason({ requiredChecks: "incomplete", incompleteReason: "invalid" }), "execution");
  assert.equal(resolveIncompleteReason({ requiredChecks: "complete", incompleteReason: "requirement_trace" }), "requirement_trace");
  assert.equal(resolveIncompleteReason({ requiredChecks: "complete", partialCoverage: { stop_reason: "budget-exhausted" } as never, incompleteReason: "requirement_trace" }), "both");
  assert.equal(resolveIncompleteReason({ requiredChecks: "complete", incompleteReason: "both" }), "both");
});

test("verdict table: model verdict x highest open severity x coverage", () => {
  for (const row of TABLE) {
    const { artifact: a, outcome } = runStrictPipeline(row.model, HIGHEST[row.highest]!, { coverage: row.coverage });
    assert.equal(a.verdict, row.verdict, JSON.stringify(row));
    assert.equal(outcome.verdict, row.verdict, JSON.stringify(row));
    assert.equal(outcome.reviewResult, row.reviewResult, JSON.stringify(row));
    assert.equal(outcome.overridden, row.overridden, JSON.stringify(row));
    assert.equal(a.verdict_source, row.overridden ? "findings" : "model", JSON.stringify(row));
    assert.equal(a.review_markdown.includes(NOTE), row.overridden, JSON.stringify(row));
    // The marker carries the strict review_result state.
    const marker = buildRunMetadataMarker({ headSha: "h", baseSha: "b", reviewResult: outcome.reviewResult });
    assert.ok(marker.includes(`"review_result":"${row.reviewResult}"`), JSON.stringify(row));
  }
});

test("regression: minor-only findings plus model request_changes publishes non-blocking", () => {
  const { artifact: a, outcome } = runStrictPipeline("request_changes", [finding("minor")], { coverage: "complete" });
  assert.equal(a.verdict, "approve");
  assert.equal(outcome.reviewResult, "findings");
  assert.ok(a.review_markdown.includes(
    `${NOTE} no blocker or major finding out of 1 open; model verdict was 'request_changes'._`,
  ));
  const infoOnly = runStrictPipeline("request_changes", [finding("info"), finding("info")], { coverage: "complete" });
  assert.equal(infoOnly.artifact.verdict, "approve");
  assert.equal(infoOnly.outcome.reviewResult, "findings");
});

test("escalation note counts blocker/major findings out of the open set", () => {
  const { artifact: a } = runStrictPipeline("approve", [finding("blocker"), finding("major"), finding("minor")], { coverage: "complete" });
  assert.equal(a.verdict, "request_changes");
  assert.ok(a.review_markdown.includes(
    `${NOTE} 2 blocker/major finding(s) out of 3 open; model verdict was 'approve'._`,
  ));
});

test("mapping agrees with the model verdict: no note, model source", () => {
  const clean = runStrictPipeline("approve", [], { coverage: "complete" });
  assert.equal(clean.artifact.verdict, "approve");
  assert.equal(clean.artifact.verdict_source, "model");
  assert.ok(!clean.artifact.review_markdown.includes(NOTE));
  const blocking = runStrictPipeline("request_changes", [finding("major")], { coverage: "complete" });
  assert.equal(blocking.artifact.verdict, "request_changes");
  assert.equal(blocking.artifact.verdict_source, "model");
  assert.ok(!blocking.artifact.review_markdown.includes(NOTE));
  // A forced verdict the model itself produced keeps "model" provenance.
  const agreedForced = runStrictPipeline("request_changes", [], { coverage: "complete", enforcement: { evidenceBlockerEnabled: true, evidence: { has_blocker: true, providers: [] } } });
  assert.equal(agreedForced.artifact.verdict, "request_changes");
  assert.equal(agreedForced.artifact.verdict_source, "model");
});

test("computeDeterministicBlock covers every fail-closed source and final verdict provenance", () => {
  const forcedEnforcement: EnforcementInputs = {
    ...NO_ENFORCEMENT,
    evidenceBlockerEnabled: true,
    evidence: { has_blocker: true, providers: [{ id: "scanner", provider_severity: "blocker" }] },
  };
  const base = {
    enforcementInputs: NO_ENFORCEMENT,
    completeness: null,
    requirementTraceFindingsAdded: 0,
    finalVerdict: "approve",
    verdictSource: "model",
  };
  assert.equal(computeDeterministicBlock(base), false);
  assert.equal(computeDeterministicBlock({ ...base, enforcementInputs: forcedEnforcement }), true);
  assert.equal(computeDeterministicBlock({
    ...base,
    completeness: { status: "incomplete", mode: "fail" },
  }), true);
  assert.equal(computeDeterministicBlock({ ...base, requirementTraceFindingsAdded: 1 }), true);
  assert.equal(computeDeterministicBlock({
    ...base,
    finalVerdict: "request_changes",
    verdictSource: "findings",
  }), true);
  assert.equal(computeDeterministicBlock({
    ...base,
    finalVerdict: "request_changes",
    verdictSource: "model",
  }), false, "a model-originated request_changes remains eligible for #978");
  assert.equal(computeDeterministicBlock({
    ...base,
    finalVerdict: "approve",
    verdictSource: "findings",
  }), false, "non-model provenance only blocks when the final verdict is request_changes");
});

test("enforcement-forced request_changes discloses the forced provenance", () => {
  const { artifact: a, outcome } = runStrictPipeline("approve", [], {
    coverage: "complete",
    enforcement: {
      evidenceBlockerEnabled: true,
      evidence: { has_blocker: true, providers: [{ id: "scanner", provider_severity: "blocker" }] },
    },
  });
  assert.equal(a.verdict, "request_changes");
  assert.equal(outcome.reviewResult, "issues");
  // The published verdict differs from the model's own: that is an override.
  assert.equal(outcome.overridden, true);
  // Provenance honesty (#811 review): the model said approve; the forced
  // verdict belongs to the enforcement layer, never to the model.
  assert.equal(a.verdict_source, "enforcement");
  assert.equal(outcome.source, "enforcement");
  assert.ok(a.review_markdown.includes("fail-closed enforcement layer forced request_changes"));
  assert.ok(a.review_markdown.includes("## Evidence Provider Blockers"));
});

test("evidence blocker prevents the degraded fallback gate bypass", () => {
  const enforcement: EnforcementInputs = {
    ...NO_ENFORCEMENT,
    evidenceBlockerEnabled: true,
    evidence: { has_blocker: true, providers: [{ id: "scanner", provider_severity: "blocker" }] },
  };
  const { artifact: a } = runStrictPipeline("approve", [], { coverage: "complete", enforcement });
  assert.equal(a.verdict, "request_changes");

  const deterministicBlock = computeDeterministicBlock({
    enforcementInputs: enforcement,
    completeness: null,
    requirementTraceFindingsAdded: 0,
    finalVerdict: String(a.verdict),
    verdictSource: String(a.verdict_source ?? "model"),
  });
  assert.equal(deterministicBlock, true);
  const degradedGateBypass = resolveDegradedGateBypass({
    notice: false, fromFallback: true, noEvidenceGathered: true, deterministicBlock,
  });
  assert.equal(degradedGateBypass, false);
  assert.equal(failOnRequestChanges({ FAIL_ON_REQUEST_CHANGES: "true" }, "request_changes", degradedGateBypass, false), 1);
  assert.equal(failOnRequestChanges({ FAIL_ON_REQUEST_CHANGES: "true" }, "request_changes", degradedGateBypass, true), 1);
});

test("required_check_validation_mode=fail still forces request_changes under strict", () => {
  const { artifact: a, outcome } = runStrictPipeline("approve", [finding("minor")], {
    coverage: "incomplete", mode: "fail",
  });
  assert.equal(a.verdict, "request_changes");
  assert.equal(outcome.reviewResult, "issues");
  // The model said approve; the forced verdict is the enforcement layer's.
  assert.equal(a.verdict_source, "enforcement");
  assert.ok(a.review_markdown.includes("fail-closed enforcement layer forced request_changes"));
});

test("required-check mode=fail incompleteness prevents the degraded fallback gate bypass", () => {
  const { artifact: a, completeness } = runStrictPipeline("approve", [finding("minor")], {
    coverage: "incomplete", mode: "fail",
  });
  assert.equal(a.verdict, "request_changes");
  assert.equal(completeness.status, "incomplete");
  assert.equal(completeness.mode, "fail");
  const deterministicBlock = computeDeterministicBlock({
    enforcementInputs: NO_ENFORCEMENT,
    completeness,
    requirementTraceFindingsAdded: 0,
    finalVerdict: String(a.verdict),
    verdictSource: String(a.verdict_source ?? "model"),
  });
  assert.equal(deterministicBlock, true);
  assert.equal(resolveDegradedGateBypass({
    notice: false, fromFallback: true, noEvidenceGathered: true, deterministicBlock,
  }), false);
});

test("a fail-closed layer firing beside a model request_changes is never relaxed", () => {
  // The model itself asked for changes AND an evidence blocker fired: the
  // strict mapping must not relax this to approve (fail-closed layers own
  // their verdict contribution even when the model verdict agrees).
  const { artifact: a, outcome } = runStrictPipeline("request_changes", [finding("minor")], {
    coverage: "complete",
    enforcement: {
      evidenceBlockerEnabled: true,
      evidence: { has_blocker: true, providers: [{ id: "scanner", provider_severity: "blocker" }] },
    },
  });
  assert.equal(a.verdict, "request_changes");
  assert.equal(outcome.reviewResult, "issues");
  assert.equal(outcome.overridden, false);
  // The model produced request_changes itself: "model" provenance is
  // truthful even though a layer also forced it.
  assert.equal(a.verdict_source, "model");
  assert.ok(!a.review_markdown.includes(NOTE));
  assert.ok(a.review_markdown.includes("## Evidence Provider Blockers"));
});

test("a fail-closed layer that only settles (never forces) does not hold the mapping back", () => {
  // Thread settlement fired (a disposition was downgraded) but no
  // forcing layer did: the model's minor-backed request_changes still
  // relaxes, per the strict contract.
  const { artifact: a, outcome } = runStrictPipeline("request_changes", [finding("minor")], {
    coverage: "complete",
    enforcement: {
      threads: [{ thread_id: "t", path: null, line: null, severity: "minor", message: "m", own_finding: false, replies: 0 }],
    },
  });
  assert.equal(a.verdict, "approve");
  assert.equal(outcome.reviewResult, "findings");
  assert.ok(a.review_markdown.includes(NOTE));
});

test("a blocker re-emitted by thread settlement escalates: the mapping sees the final open set", () => {
  const a = artifact("approve", []);
  a.thread_dispositions = [{ thread_id: "t1", disposition: "open", evidence: null }];
  // "strict" is not findings_severity_gated: settlement itself never
  // escalates — the strict mapping does, after settlement re-emits the
  // blocker into the open-findings set.
  applyReviewThreadEnforcement(a, [
    { thread_id: "t1", path: "a.py", line: 3, severity: "blocker", message: "still broken", own_finding: false, replies: 0 },
  ], "strict");
  assert.equal(a.findings.length, 1);
  assert.equal(a.verdict, "approve");
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "approve", forced: false });
  assert.equal(a.verdict, "request_changes");
  assert.equal(outcome.reviewResult, "issues");
  assert.equal(outcome.overridden, true);
  assert.ok(a.review_markdown.includes(`${NOTE} 1 blocker/major finding(s) out of 1 open`));
});

test("strictReviewResult precedence is issues > partial > findings > clean", () => {
  assert.equal(strictReviewResult("request_changes", [finding("minor")], "incomplete"), "issues");
  assert.equal(strictReviewResult("approve", [finding("minor")], "incomplete"), "partial");
  assert.equal(strictReviewResult("approve", [finding("minor")], "complete"), "findings");
  assert.equal(strictReviewResult("approve", [finding("minor")], "none"), "findings");
  assert.equal(strictReviewResult("approve", [], "none"), "clean");
  assert.equal(strictReviewResult("approve", "not-an-array", "complete"), "clean");
  assert.equal(hasBlockingOpenFinding([finding("major"), finding("minor")]), true);
  assert.equal(hasBlockingOpenFinding([finding("minor"), finding("info")]), false);
  assert.equal(hasBlockingOpenFinding("garbage"), false);
});

test("strict marker values carry an approve through the unchanged-diff skip", () => {
  const marker = (reviewResult: string) => buildRunMetadataMarker({ headSha: "h", baseSha: "b", reviewResult });
  for (const result of ["findings", "partial"]) {
    const carried = carriedVerdict(`${marker(result)}\nbody`);
    assert.deepEqual(carried, { verdict: "approve", verdictSource: "carry_forward", reviewResult: result, degradedGateBypass: false }, result);
  }
  assert.deepEqual(carriedVerdict(`${marker("issues")}\nbody`), { verdict: "request_changes", verdictSource: "carry_forward", reviewResult: "issues", degradedGateBypass: false });
  assert.deepEqual(carriedVerdict(`${marker("clean")}\nbody`), { verdict: "approve", verdictSource: "carry_forward", reviewResult: "clean", degradedGateBypass: false });
});

// ---------------------------------------------------------------------------
// Publish-side rendering (#752 shape, adopted by #811).
// ---------------------------------------------------------------------------

const MARKER = "<!-- ai-pr-review -->";
const HEAD = "head-123";

class MockPublishApi implements PublishPlatformApi {
  readonly platform: "github" | "forgejo" = "github";
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
  async createReview(request: Parameters<PublishPlatformApi["createReview"]>[0]) { this.submitted.push(request); return { ok: true }; }
  async dismissReview(): Promise<boolean> { return true; }
  async minimizedReviewIds(): Promise<string[]> { return []; }
  async minimizeReview(): Promise<boolean> { return true; }
  async unresolvedSupersededThreads() { return { ok: true, threads: [], hasNextPage: false }; }
  async resolveThread(): Promise<boolean> { return true; }
  async removeLabel(label: string): Promise<boolean> { this.removedLabels.push(label); return true; }
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

test("comment mode renders counts on the verdict line and the findings section at the top", async () => {
  const api = new MockPublishApi();
  await publishReview(publishInput({ findings: [finding("minor"), finding("minor"), finding("info")] }), api, { diffText: "" });
  const body = api.sticky[0]!.body;
  assert.ok(body.includes("✅ **Automated recommendation: APPROVE** · 2 minor, 1 info"));
  const engine = body.indexOf("_Analysis engine: test-engine_");
  const findingsHeading = body.indexOf("### Findings (2 minor, 1 info)");
  const reviewBody = body.indexOf("## Review");
  assert.ok(engine < findingsHeading && findingsHeading < reviewBody, "findings render at the top, before the review body");
  assert.ok(body.includes("| Severity | Location | Finding |"));
  assert.ok(body.includes("| Minor | `src/a.ts:4` | finding |"));
  assert.ok(body.includes('"review_result":"findings"'));
});

test("clean strict review renders no state block and a clean marker", async () => {
  const api = new MockPublishApi();
  await publishReview(publishInput(), api, { diffText: "" });
  const body = api.sticky[0]!.body;
  assert.ok(body.includes("✅ **Automated recommendation: APPROVE**\n"));
  assert.ok(!body.includes("### Findings"));
  assert.ok(!body.includes("Partial coverage"));
  assert.ok(body.includes('"review_result":"clean"'));
});

test("partial coverage renders the gap notice above the review and a partial marker", async () => {
  const api = new MockPublishApi();
  await publishReview(publishInput({ requiredChecks: "incomplete" }), api, { diffText: "" });
  const body = api.sticky[0]!.body;
  assert.ok(body.includes("> **Partial coverage**: required-check coverage is incomplete"));
  assert.ok(body.indexOf("Partial coverage") < body.indexOf("## Review"));
  assert.ok(body.includes('"review_result":"partial"'));
});

test("#954: trace-only incompleteness renders trace-appropriate prose and preserves partial result", async () => {
  const api = new MockPublishApi();
  await publishReview(publishInput({ requiredChecks: "incomplete", incompleteReason: "requirement_trace" }), api, { diffText: "" });
  const body = api.sticky[0]!.body;
  assert.ok(body.includes("🟡 **Automated recommendation: APPROVAL WITHHELD — requirement trace incomplete**"));
  assert.ok(body.includes("**Requirement traceability gap**"));
  assert.ok(body.includes('"review_result":"partial"'));
  assert.ok(!body.includes("did not resolve every required check"));

  const native = new MockPublishApi();
  await publishReview(publishInput({
    mode: "review_verdict", allowApprove: true,
    requiredChecks: "incomplete", incompleteReason: "requirement_trace",
  }), native, { diffText: "" });
  const nativeBody = native.submitted[0]!.body;
  assert.ok(nativeBody.includes("**Approval withheld**: the review completed, but an in-scope requirement lacks verifiable enforcement or test evidence"));
  assert.ok(!nativeBody.includes("required-check coverage or the tool-loop investigation did not finish"));
});

test("#954: execution plus trace incompleteness gets combined prose", async () => {
  const api = new MockPublishApi();
  await publishReview(publishInput({ requiredChecks: "incomplete", incompleteReason: "both" }), api, { diffText: "" });
  const body = api.sticky[0]!.body;
  assert.ok(body.includes("🟡 **Automated recommendation: APPROVAL WITHHELD — review coverage incomplete**"));
  assert.ok(body.includes("**Partial coverage and requirement traceability gap**"));
  assert.ok(body.includes("required-check coverage is incomplete, and one or more in-scope requirements could not be verified"));

  const native = new MockPublishApi();
  await publishReview(publishInput({ mode: "review_verdict", allowApprove: true, requiredChecks: "incomplete", incompleteReason: "both" }), native, { diffText: "" });
  assert.ok(native.submitted[0]!.body.includes("execution coverage and an in-scope requirement lacks verifiable enforcement or test evidence"));
});

test("#954: execution and legacy incomplete publish callers keep the generic coverage notice", async () => {
  for (const overrides of [
    { requiredChecks: "incomplete", incompleteReason: "execution" },
    { requiredChecks: "incomplete" },
  ]) {
    const api = new MockPublishApi();
    await publishReview(publishInput(overrides), api, { diffText: "" });
    const body = api.sticky[0]!.body;
    assert.ok(body.includes("did not resolve every required check"));
    assert.ok(body.includes("🟡 **Automated recommendation: INCOMPLETE — not an approval**"));
    assert.ok(!body.includes("Requirement traceability gap"));
  }
});

test("blocking strict review shows the blocker beside the verdict and an issues marker", async () => {
  const api = new MockPublishApi();
  await publishReview(publishInput({ verdict: "request_changes", findings: [finding("blocker")] }), api, { diffText: "" });
  const body = api.sticky[0]!.body;
  assert.ok(body.includes("⚠️ **Automated recommendation: REQUEST CHANGES** · 1 blocker"));
  assert.ok(body.includes("### Findings (1 blocker)"));
  assert.ok(body.includes('"review_result":"issues"'));
});

test("hostile findings cannot split the table or forge structure", async () => {
  const api = new MockPublishApi();
  const hostile = {
    severity: "minor", category: "bug", file: "a|b.ts", line: 3,
    message: "evil | row\n## Forged heading\n`code` <script> & <https://github.com/acme/lib/pull/8>",
  };
  await publishReview(publishInput({ findings: [hostile] }), api, { diffText: "" });
  const body = api.sticky[0]!.body;
  const tableRows = body.split("\n").filter((line) => line.startsWith("| Minor |"));
  assert.equal(tableRows.length, 1, "the hostile message stays one row");
  assert.ok(!body.split("\n").some((line) => line.startsWith("## Forged heading")), "no forged heading at line start");
  assert.ok(!body.includes("<script>"));
  assert.ok(body.includes("upstream acme/lib PR 8"), "upstream links are neutralized in the findings table");
  assert.ok(body.includes("| Minor | `a\\|b.ts:3` |"), "pipes in paths are escaped inside the location cell");
});

test("the findings table caps at 50 rows with a visible N-more line", async () => {
  const api = new MockPublishApi();
  const many = Array.from({ length: 55 }, (_, i) => finding("minor")).map((f, i) => ({ ...f, message: `m${i}` }));
  await publishReview(publishInput({ findings: many }), api, { diffText: "" });
  const body = api.sticky[0]!.body;
  assert.equal(body.split("\n").filter((line) => line.startsWith("| Minor |")).length, 50);
  assert.ok(body.includes("_…and 5 more finding(s) not listed._"));
});

test("withheld approval on a findings review does not call itself clean", async () => {
  const api = new MockPublishApi();
  await publishReview(publishInput({ mode: "review_verdict", findings: [finding("minor")] }), api, { diffText: "" });
  const body = api.submitted[0]!.body;
  assert.ok(body.includes("this review is advisory rather than a clean approval"));
  assert.ok(!body.includes("this clean review is advisory"));
  const clean = new MockPublishApi();
  await publishReview(publishInput({ mode: "review_verdict" }), clean, { diffText: "" });
  assert.ok(clean.submitted[0]!.body.includes("this clean review is advisory"));
});

test("non-strict policies keep today's bodies and the binary clean/issues marker", async () => {
  const api = new MockPublishApi();
  await publishReview(publishInput({ verdictPolicy: "model", findings: [finding("minor")] }), api, { diffText: "" });
  const body = api.sticky[0]!.body;
  assert.ok(!body.includes("### Findings"));
  assert.ok(!body.includes("· 1 minor"));
  assert.ok(body.includes('"review_result":"clean"'));
  assert.ok(!body.includes("Partial coverage"));

  const gated = new MockPublishApi();
  await publishReview(publishInput({ verdictPolicy: "findings_severity_gated", findings: [finding("minor")] }), gated, { diffText: "" });
  assert.ok(gated.sticky[0]!.body.includes('"review_result":"clean"'));
  assert.ok(!gated.sticky[0]!.body.includes("### Findings"));

  // #874 fail closed across policies: an incomplete required-check state
  // (which includes a known-`unmet` requirement trace) never reads as a
  // clean result, even under the binary clean/issues non-strict markers.
  for (const policy of ["model", "findings_severity_gated"]) {
    const partial = new MockPublishApi();
    await publishReview(publishInput({ verdictPolicy: policy, requiredChecks: "incomplete" }), partial, { diffText: "" });
    assert.ok(partial.sticky[0]!.body.includes('"review_result":"partial"'), policy);
    assert.ok(!partial.sticky[0]!.body.includes('"review_result":"clean"'), policy);
  }
});
