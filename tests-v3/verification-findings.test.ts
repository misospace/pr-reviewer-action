import test from "node:test";
import assert from "node:assert/strict";
import type { ReviewArtifact } from "../src/enforcement/artifact.js";
import {
  applyStrictVerdictPolicy,
  applyVerdictPolicy,
  relaxVerificationOnlyVerdict,
} from "../src/enforcement/verdict-policy.js";
import { applyReviewThreadEnforcement, type EnforcementThread } from "../src/enforcement/threads.js";
import { applyAllEnforcement, normalizeEnforcedReviewMarkdown, reconcileEnforcedReviewMarkdown } from "../src/enforcement/enforce.js";

function artifact(overrides: Record<string, unknown> = {}): ReviewArtifact {
  return { verdict: "approve", review_markdown: "review", findings: [], ...overrides } as ReviewArtifact;
}

function finding(severity: string, category = "bug") {
  return { severity: severity as "blocker", category, file: "src/a.ts", line: 4, message: "finding" };
}

const policyOptions = { nonBlockingCategories: new Set(["tests", "docs"]), securityFlagged: false };

test("strict verdict keeps verification-only major findings non-blocking but reports findings", () => {
  const a = artifact({ verdict: "request_changes", findings: [finding("major", "verification")] });
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "approve");
  assert.equal(outcome.verdict, "approve");
  assert.equal(outcome.reviewResult, "findings");
});

test("strict verdict keeps verification-only blocker findings non-blocking but reports findings", () => {
  const a = artifact({ findings: [finding("blocker", "verification")] });
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "approve", forced: false });
  assert.equal(a.verdict, "approve");
  assert.equal(outcome.verdict, "approve");
  assert.equal(outcome.reviewResult, "findings");
});

test("strict verdict still blocks when verification and bug findings are mixed", () => {
  const a = artifact({ findings: [finding("major", "verification"), finding("major", "bug")] });
  applyStrictVerdictPolicy(a, { modelVerdict: "approve", forced: false });
  assert.equal(a.verdict, "request_changes");
});

test("strict fail-closed enforcement still blocks verification-only findings", () => {
  const a = artifact({ findings: [finding("major", "verification")] });
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "approve", forced: true });
  assert.equal(a.verdict, "request_changes");
  assert.equal(outcome.verdict, "request_changes");
  assert.equal(a.verdict_source, "enforcement");
  assert.equal(outcome.source, "enforcement");
});

test("verification-only relaxation approves and adds a markdown note", () => {
  const a = artifact({ verdict: "request_changes", findings: [finding("major", "verification")] });
  const before = a.review_markdown;
  assert.equal(relaxVerificationOnlyVerdict(a, { forced: false }), true);
  assert.equal(a.verdict, "approve");
  assert.equal(a.verdict_source, "findings");
  assert.equal(a.review_markdown.startsWith(before), true);
  assert.equal(a.review_markdown.includes("_Verdict relaxed from structured findings (#977): every open finding is a verification request the review tools cannot check, so the author has nothing to change. The findings remain listed above._"), true);
});

test("verification-only relaxation refuses zero findings without mutation", () => {
  const a = artifact({ verdict: "request_changes" });
  const before = JSON.stringify(a);
  assert.equal(relaxVerificationOnlyVerdict(a, { forced: false }), false);
  assert.equal(JSON.stringify(a), before);
});

test("verification-only relaxation refuses mixed finding categories without mutation", () => {
  const a = artifact({ verdict: "request_changes", findings: [finding("major", "verification"), finding("major", "bug")] });
  const before = JSON.stringify(a);
  assert.equal(relaxVerificationOnlyVerdict(a, { forced: false }), false);
  assert.equal(JSON.stringify(a), before);
});

test("verification-only relaxation refuses incomplete required checks", () => {
  const a = artifact({ verdict: "request_changes", findings: [finding("major", "verification")], required_checks: "incomplete" });
  const before = JSON.stringify(a);
  assert.equal(relaxVerificationOnlyVerdict(a, { forced: false }), false);
  assert.equal(JSON.stringify(a), before);
});

test("verification-only relaxation refuses unresolved required-check rows", () => {
  const a = artifact({ verdict: "request_changes", findings: [finding("major", "verification")], required_check_dispositions: [{ status: "unresolved" }] });
  const before = JSON.stringify(a);
  assert.equal(relaxVerificationOnlyVerdict(a, { forced: false }), false);
  assert.equal(JSON.stringify(a), before);
});

test("verification-only relaxation refuses an incomplete requirement trace", () => {
  const a = artifact({ verdict: "request_changes", findings: [finding("major", "verification")], requirement_trace_incomplete: true });
  const before = JSON.stringify(a);
  assert.equal(relaxVerificationOnlyVerdict(a, { forced: false }), false);
  assert.equal(JSON.stringify(a), before);
});

test("verification-only relaxation refuses forced verdicts", () => {
  const a = artifact({ verdict: "request_changes", findings: [finding("major", "verification")] });
  const before = JSON.stringify(a);
  assert.equal(relaxVerificationOnlyVerdict(a, { forced: true }), false);
  assert.equal(JSON.stringify(a), before);
});

test("model verdict policy remains a pass-through", () => {
  const a = artifact({ verdict: "request_changes", findings: [finding("blocker", "verification")] });
  assert.deepEqual(applyVerdictPolicy(a, "model", policyOptions), { source: "model" });
  assert.equal(a.verdict, "request_changes");
  assert.equal(a.verdict_source, "model");
  assert.equal(a.review_markdown, "review");
  assert.deepEqual(a.findings, [finding("blocker", "verification")]);
});

test("findings-severity policy does not escalate a verification blocker", () => {
  const a = artifact({ findings: [finding("blocker", "verification")] });
  applyVerdictPolicy(a, "findings_severity_gated", policyOptions);
  assert.equal(a.verdict, "approve");
});

test("verified withdrawal settles without re-emitting its verification thread", () => {
  const a = artifact({ thread_dispositions: [{ thread_id: "t", disposition: "withdrawn", evidence: "human confirmed this was a false positive" }] });
  applyReviewThreadEnforcement(a, [{ thread_id: "t", path: "src/a.ts", line: 4, severity: "major", message: "check behavior", category: "verification", own_finding: false, replies: 1 }], "strict");
  const rows = a.thread_dispositions as Array<Record<string, unknown>>;
  assert.equal(rows[0]!.disposition, "withdrawn");
  assert.equal(a.findings.filter((item) => item.thread_id === "t").length, 0);
});

test("withdrawal of a bug thread is downgraded and re-emitted", () => {
  const a = artifact({ thread_dispositions: [{ thread_id: "t", disposition: "withdrawn", evidence: "human confirmed" }] });
  applyReviewThreadEnforcement(a, [{ thread_id: "t", path: "src/a.ts", line: 4, severity: "major", message: "fix bug", category: "bug", own_finding: false, replies: 1 }], "strict");
  assert.deepEqual(a.thread_dispositions, [{ thread_id: "t", disposition: "open", evidence: "human confirmed", enforced: "withdrawn without a verification/question finding" }]);
  assert.equal(a.findings.some((item) => item.thread_id === "t"), true);
  assert.equal(a.findings.find((item) => item.thread_id === "t")!.category, "other");
});

test("withdrawal without non-empty evidence is downgraded", () => {
  for (const evidence of ["", null]) {
    const a = artifact({ thread_dispositions: [{ thread_id: "t", disposition: "withdrawn", evidence }] });
    applyReviewThreadEnforcement(a, [{ thread_id: "t", path: "src/a.ts", line: 4, severity: "major", message: "check behavior", category: "verification", own_finding: false, replies: 1 }], "strict");
    const rows = a.thread_dispositions as Array<Record<string, unknown>>;
    assert.equal(rows[0]!.disposition, "open");
    assert.equal(rows[0]!.enforced, "withdrawn without evidence from a reply");
  }
});

test("an open verification thread re-emits as non-blocking under strict policy", () => {
  const a = artifact({ thread_dispositions: [{ thread_id: "t", disposition: "open", evidence: null }] });
  applyReviewThreadEnforcement(a, [{ thread_id: "t", path: "src/a.ts", line: 4, severity: "major", message: "check behavior", category: "verification", own_finding: false, replies: 1 }], "strict");
  assert.equal((a.thread_dispositions as Array<Record<string, unknown>>)[0]!.disposition, "open");
  assert.equal(a.findings[0]!.severity, "major");
  assert.equal(a.findings[0]!.category, "verification");
  assert.equal(a.findings[0]!.thread_id, "t");
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "approve", forced: false });
  assert.equal(a.verdict, "approve");
  assert.equal(outcome.reviewResult, "findings");
});

test("blocking question threads cannot be withdrawn with evidence", () => {
  const a = artifact({ thread_dispositions: [{ thread_id: "q", disposition: "withdrawn", evidence: "answered in the thread" }] });
  applyReviewThreadEnforcement(a, [{ thread_id: "q", path: null, line: null, severity: "blocker", message: "question", category: "question", own_finding: false, replies: 1 }], "strict");
  const rows = a.thread_dispositions as Array<Record<string, unknown>>;
  assert.equal(rows[0]!.disposition, "open");
  assert.equal(rows[0]!.enforced, "withdrawn on a blocking finding");
  assert.equal(a.findings.some((item) => item.thread_id === "q"), true);
});

test("major question threads cannot be withdrawn with evidence", () => {
  const a = artifact({ thread_dispositions: [{ thread_id: "q", disposition: "withdrawn", evidence: "answered in the thread" }] });
  applyReviewThreadEnforcement(a, [{ thread_id: "q", path: null, line: null, severity: "major", message: "question", category: "question", own_finding: false, replies: 1 }], "strict");
  const rows = a.thread_dispositions as Array<Record<string, unknown>>;
  assert.equal(rows[0]!.disposition, "open");
  assert.equal(rows[0]!.enforced, "withdrawn on a blocking finding");
  assert.equal(a.findings.some((item) => item.thread_id === "q"), true);
});

test("question threads can also be withdrawn with evidence", () => {
  const a = artifact({ thread_dispositions: [{ thread_id: "q", disposition: "withdrawn", evidence: "answered in the thread" }] });
  applyReviewThreadEnforcement(a, [{ thread_id: "q", path: null, line: null, severity: "minor", message: "question", category: "question", own_finding: false, replies: 1 }], "strict");
  const rows = a.thread_dispositions as Array<Record<string, unknown>>;
  assert.equal(rows[0]!.disposition, "withdrawn");
  assert.equal(a.findings.some((item) => item.thread_id === "q"), false);
});

test("reconciliation strips the action-authored banner with reasons from an approve", () => {
  const original = "Original model prose.\n";
  const a = artifact({ verdict: "request_changes", review_markdown: original });
  normalizeEnforcedReviewMarkdown(a, ["verification enforcement"]);
  a.verdict = "approve";
  reconcileEnforcedReviewMarkdown(a);
  assert.equal(a.review_markdown, original);
  assert.doesNotMatch(a.review_markdown, /Final Recommendation/);
});

test("reconciliation strips the action-authored banner without reasons from an approve", () => {
  const original = "Original model prose.\n";
  const a = artifact({ verdict: "request_changes", review_markdown: original });
  normalizeEnforcedReviewMarkdown(a, null);
  a.verdict = "approve";
  reconcileEnforcedReviewMarkdown(a);
  assert.equal(a.review_markdown, original);
  assert.doesNotMatch(a.review_markdown, /Final Recommendation/);
});

test("reconciliation is a byte-identical no-op while the verdict requests changes", () => {
  const a = artifact({ verdict: "request_changes", review_markdown: "Original model prose.\n" });
  normalizeEnforcedReviewMarkdown(a, ["verification enforcement"]);
  const withBanner = a.review_markdown;
  reconcileEnforcedReviewMarkdown(a);
  assert.equal(a.review_markdown, withBanner);
  assert.match(a.review_markdown, /Final Recommendation/);
});

test("reconciliation preserves model-authored Final Recommendation prose", () => {
  const markdown = "## Final Recommendation\nRequest changes because the API is wrong.";
  const a = artifact({ verdict: "approve", review_markdown: markdown });
  reconcileEnforcedReviewMarkdown(a);
  assert.equal(a.review_markdown, markdown);
});

function enforcementInputs(threads: EnforcementThread[]) {
  return {
    evidenceBlockerEnabled: false,
    toolFailureEnabled: false,
    toolMinSuccessful: 0,
    evidence: null,
    toolHarness: null,
    threads,
    humanReviews: null,
    verdictPolicy: "model",
  };
}

const unresolvedVerificationThread = {
  thread_id: "t",
  path: "src/a.ts",
  line: 4,
  severity: "major",
  message: "confirm the metric exists",
  category: "verification",
  own_finding: true,
  replies: 0,
};

test("#977: reconciles the banner after an unresolved verification thread relaxes the verdict", () => {
  const a = artifact({
    verdict: "request_changes",
    findings: [finding("major", "verification")],
    thread_dispositions: [],
  });
  applyAllEnforcement(a, enforcementInputs([unresolvedVerificationThread]));
  assert.equal(relaxVerificationOnlyVerdict(a, { forced: false }), true);
  reconcileEnforcedReviewMarkdown(a);
  assert.equal(a.verdict, "approve");
  assert.doesNotMatch(a.review_markdown, /Final Recommendation/);
  assert.doesNotMatch(a.review_markdown, /Request changes/);
});

test("#977: reconciles the banner after a verification thread is withdrawn", () => {
  const a = artifact({
    verdict: "request_changes",
    findings: [finding("major", "verification")],
    thread_dispositions: [{ thread_id: "t", disposition: "withdrawn", evidence: "human confirmed the metric exists" }],
  });
  applyAllEnforcement(a, enforcementInputs([unresolvedVerificationThread]));
  assert.equal(relaxVerificationOnlyVerdict(a, { forced: false }), true);
  reconcileEnforcedReviewMarkdown(a);
  assert.equal(a.verdict, "approve");
  assert.doesNotMatch(a.review_markdown, /Final Recommendation/);
  assert.doesNotMatch(a.review_markdown, /Request changes/);
});

test("#977: a non-forcing thread settlement never claims the enforcement banner", () => {
  const a = artifact({
    verdict: "request_changes",
    findings: [finding("major", "bug")],
    thread_dispositions: [],
  });
  applyAllEnforcement(a, enforcementInputs([unresolvedVerificationThread]));
  assert.equal(relaxVerificationOnlyVerdict(a, { forced: false }), false);
  assert.equal(a.verdict, "request_changes");
  assert.doesNotMatch(a.review_markdown, /Final Recommendation/);
  assert.match(a.review_markdown, /## Unresolved Review Threads/);
});

test("#977: an evidence blocker that forced request_changes still writes the banner", () => {
  const a = artifact({ verdict: "approve", findings: [], thread_dispositions: [] });
  applyAllEnforcement(a, {
    ...enforcementInputs([unresolvedVerificationThread]),
    evidenceBlockerEnabled: true,
    evidence: { has_blocker: true, providers: [{ id: "scanner", provider_severity: "blocker" }] },
  });
  assert.equal(a.verdict, "request_changes");
  assert.match(a.review_markdown, /## Final Recommendation/);
  assert.match(a.review_markdown, /^- Evidence provider blocker detected: scanner\./m);
  assert.doesNotMatch(a.review_markdown, /- review threads:/);
});

test("#977: a thread settlement that escalated the verdict does contribute to the banner", () => {
  const a = artifact({ verdict: "approve", findings: [], thread_dispositions: [] });
  const blockerThread = { ...unresolvedVerificationThread, severity: "blocker", category: "bug" };
  applyAllEnforcement(a, {
    ...enforcementInputs([blockerThread]),
    verdictPolicy: "findings_severity_gated",
  });
  assert.equal(a.verdict, "request_changes");
  assert.match(a.review_markdown, /## Final Recommendation/);
  assert.match(a.review_markdown, /- review threads:/);
});

test("#977: human-review settlement never contributes to the banner", () => {
  const a = artifact({ verdict: "request_changes", findings: [], human_review_dispositions: [] });
  applyAllEnforcement(a, {
    ...enforcementInputs([]),
    humanReviews: [{ review_id: "h", login: "x", commit_id: null, head_moved: "unknown", submitted_at: null }],
  });
  assert.equal(a.verdict, "request_changes");
  assert.doesNotMatch(a.review_markdown, /Final Recommendation/);
});
