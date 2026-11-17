import test from "node:test";
import assert from "node:assert/strict";
import type { ParsedReviewVerdict } from "../src/model/types.js";
import {
  CI_ONLY_RELAXATION_NOTE,
  GATED_FINDINGS_RELAXATION_NOTE,
  REFUTED_GROUNDING_RELAXATION_NOTE,
  VERIFICATION_ONLY_RELAXATION_NOTE,
  markRelaxationNotesSuperseded,
  reviewArtifactFromParsed,
  type ReviewArtifact,
} from "../src/enforcement/artifact.js";
import { applyVerdictPolicy, applyStrictVerdictPolicy, capCiOnlyFindings, parseNonBlockingCategories, relaxCiOnlyVerdict, securityRiskFlagged } from "../src/enforcement/verdict-policy.js";
import { capCiEvidenceFindings, parseCiCheckNames } from "../src/enforcement/ci-evidence.js";
import { enforcementView, prepareThreads, renderReviewThreads } from "../src/context/review-threads.js";
import { applyRequiredCheckValidation } from "../src/enforcement/completeness.js";
import { applyReviewThreadEnforcement, evidenceCitesCode, type EnforcementThread } from "../src/enforcement/threads.js";
import { applyHumanReviewEnforcement, inlineCode } from "../src/enforcement/human-reviews.js";
import { buildDispositionEvidence, type DispositionEvidenceParts } from "../src/disposition/engine-evidence.js";
import { computeFinalDisposition } from "../src/disposition/final.js";
import {
  applyAllEnforcement,
  applyEvidenceBlockerEnforcement,
  applyToolHarnessFailureEnforcement,
  applyToolMinSuccessfulEnforcement,
  failClosedEnforcementFired,
  toolCapabilityFailure,
  toolMinSuccessfulFloorUnmet,
  normalizeEnforcedReviewMarkdown,
} from "../src/enforcement/enforce.js";
import { extractCoveragePayload, normalizeRequirementCoverage } from "../src/enforcement/requirement-coverage.js";
import { buildRunMetadataMarker, emitReviewMarkers, isManagedBody, stripReservedMarkers } from "../src/metadata/markers.js";

function artifact(overrides: Record<string, unknown> = {}): ReviewArtifact {
  return { verdict: "approve", review_markdown: "review", findings: [], ...overrides } as ReviewArtifact;
}
function finding(severity: string, category = "bug") {
  return { severity: severity as "blocker", category, file: "src/a.ts", line: 4, message: "finding" };
}
function parsed(overrides: Partial<ParsedReviewVerdict> = {}): ParsedReviewVerdict {
  return {
    verdict: "approve", reviewMarkdown: "parsed review", findings: [], requirementCoverage: null,
    requiredCheckDispositions: null, requiredCheckDispositionsEmitted: false,
    threadDispositions: null, threadDispositionsEmitted: false,
    humanReviewDispositions: null, humanReviewDispositionsEmitted: false,
    smartReviewRequested: false, smartReviewReason: null,
reviewTriageDecision: "unknown", reviewTriageReason: "",
reviewTriageTargets: [],
dependencyCoverage: null, dependencyCoverageEmitted: false,
extra: {}, ...overrides,
  };
}
const policyOptions = { nonBlockingCategories: new Set(["tests", "docs"]), securityFlagged: false };

test("artifact maps verdict, tri-state dispositions, findings, and extra fields", () => {
  const result = reviewArtifactFromParsed(parsed({
    verdict: "request_changes",
    findings: [{ severity: "major", category: "bug", file: "a.ts", line: 8, message: "bad", preliminaryFinding: 3 }],
    requiredCheckDispositionsEmitted: true, requiredCheckDispositions: null,
    threadDispositionsEmitted: true, threadDispositions: [{ threadId: "t1", disposition: "open", evidence: null }],
    humanReviewDispositionsEmitted: false,
    extra: { custom: 7, verdict: "override", requirement_trace_incomplete: true },
  }));
  assert.equal(result.verdict, "request_changes");
  assert.deepEqual(result.findings[0], { severity: "major", category: "bug", file: "a.ts", line: 8, message: "bad", preliminary_finding: 3 });
  assert.deepEqual(result.required_check_dispositions, []);
  assert.deepEqual(result.thread_dispositions, [{ thread_id: "t1", disposition: "open", evidence: null }]);
  assert.equal("human_review_dispositions" in result, false);
  assert.equal(result.custom, 7);
  assert.equal(result.requirement_trace_incomplete, undefined, "model extras cannot forge deterministic trace state");
  // #1003: the triage answer is persisted verbatim (fail-closed value and all)
  // so the outputs/publish/step-summary layers share one normalized answer.
  assert.equal(result.review_triage_decision, "unknown");
  assert.equal(result.review_triage_reason, "");
});

test("#1627: the artifact carries the disposition parser's drop receipt in snake_case, only when there is one", () => {
  const clean = reviewArtifactFromParsed(parsed({
    requiredCheckDispositionsEmitted: true,
    requiredCheckDispositions: [{ check: "check a", status: "satisfied", rationale: "ok" }],
  }));
  assert.equal("required_check_disposition_receipt" in clean, false);
  const dropped = reviewArtifactFromParsed(parsed({
    requiredCheckDispositionsEmitted: true,
    requiredCheckDispositions: [{ check: "check a", status: "satisfied", rationale: "ok" }],
    requiredCheckDispositionReceipt: { dropped: [{ reason: "non-object-entry" }, { reason: "unattributable-check" }], capReached: true },
  }));
  assert.deepEqual(dropped.required_check_disposition_receipt, {
    dropped: [{ reason: "non-object-entry" }, { reason: "unattributable-check" }],
    cap_reached: true,
  });
  // A model-supplied extra with the same name can never overwrite it — the
  // receipt is deterministic parser state, never model input.
  const forged = reviewArtifactFromParsed(parsed({
    requiredCheckDispositionsEmitted: true,
    requiredCheckDispositions: [{ check: "check a", status: "satisfied", rationale: "ok" }],
    requiredCheckDispositionReceipt: { dropped: [{ reason: "non-object-entry" }], capReached: false },
    extra: { required_check_disposition_receipt: { dropped: "junk", cap_reached: false } },
  }));
  assert.deepEqual(forged.required_check_disposition_receipt, { dropped: [{ reason: "non-object-entry" }], cap_reached: false });
  // …and when the parser reported nothing, no receipt exists at all — a
  // model extra cannot fabricate one either.
  const fabricated = reviewArtifactFromParsed(parsed({
    extra: { required_check_disposition_receipt: { dropped: [{ reason: "non-object-entry" }], cap_reached: true } },
  }));
  assert.equal("required_check_disposition_receipt" in fabricated, false);
});

test("#1003: the artifact carries the normalized triage decision and reason in snake_case", () => {
  const result = reviewArtifactFromParsed(parsed({
    reviewTriageDecision: "required",
    reviewTriageReason: "touches the payments gateway contract",
  }));
  assert.equal(result.review_triage_decision, "required");
  assert.equal(result.review_triage_reason, "touches the payments gateway contract");
  // A model-supplied extra with the same name can never overwrite it.
  const forged = reviewArtifactFromParsed(parsed({
    reviewTriageDecision: "not_required",
    extra: { review_triage_decision: "required" },
  }));
  assert.equal(forged.review_triage_decision, "not_required");
});

test("#762: a finding with endLine/suggestion/agentPrompt maps to snake_case artifact fields", () => {
  const result = reviewArtifactFromParsed(parsed({
    findings: [{ severity: "major", category: "bug", file: "a.ts", line: 8, message: "bad", endLine: 10, suggestion: "apply the fix", agentPrompt: "run the tests" }],
  }));
  assert.deepEqual(result.findings[0], { severity: "major", category: "bug", file: "a.ts", line: 8, message: "bad", end_line: 10, suggestion: "apply the fix", agent_prompt: "run the tests" });
});

test("#762: a finding without the optional fields emits none of the snake_case keys", () => {
  const result = reviewArtifactFromParsed(parsed({
    findings: [{ severity: "major", category: "bug", file: "a.ts", line: 8, message: "bad" }],
  }));
  assert.deepEqual(result.findings[0], { severity: "major", category: "bug", file: "a.ts", line: 8, message: "bad" });
});

test("#762: a finding's suggestion is inert to the strict verdict policy", () => {
  const base = { severity: "major", category: "bug", file: "src/a.ts", line: 4, message: "finding" };
  const withSuggestion = artifact({ findings: [{ ...base, suggestion: "apply the fix" }] });
  const withoutSuggestion = artifact({ findings: [{ ...base }] });
  const a = applyStrictVerdictPolicy(withSuggestion, { modelVerdict: "approve", forced: false });
  const b = applyStrictVerdictPolicy(withoutSuggestion, { modelVerdict: "approve", forced: false });
  assert.deepEqual(a, b);
  assert.equal(withSuggestion.verdict, withoutSuggestion.verdict);
});

test("model policy is a no-op and records model source", () => {
  const a = artifact({ verdict: "request_changes", findings: [finding("blocker")] });
  assert.deepEqual(applyVerdictPolicy(a, "model", policyOptions), { source: "model" });
  assert.equal(a.verdict, "request_changes");
  assert.equal(a.verdict_source, "model");
});

test("CI evidence parser handles escaped cells and requires a conclusion-only restatement", () => {
  const names = parseCiCheckNames("_context only_\n\n| Check | State |\n| --- | --- |\n| build \\| deploy | cancelled |\n| lint &amp; typecheck | failure |\n");
  assert.deepEqual([...names], ["build | deploy", "lint & typecheck"]);
  const findings: import("../src/enforcement/artifact.js").ArtifactFinding[] = [
    { severity: "blocker", category: "bug", file: null, line: null, message: "build | deploy was cancelled" },
    { severity: "major", category: "bug", file: "src/a.ts", line: 4, message: "lint & typecheck failed" },
  ];
  assert.equal(capCiOnlyFindings(findings, names), true);
  assert.deepEqual([findings[0]!.severity, findings[0]!.capped_from, findings[0]!.ci_capped], ["info", "blocker", true]);
  assert.deepEqual([findings[1]!.severity, findings[1]!.ci_capped], ["major", undefined]);
  const fromTable: import("../src/enforcement/artifact.js").ArtifactFinding[] = [
    { severity: "blocker", category: "bug", file: null, line: null, message: "lint & typecheck failed" },
  ];
  assert.equal(capCiEvidenceFindings(fromTable, "| Check | State |\n| --- | --- |\n| lint &amp; typecheck | failure |\n"), true);
  assert.equal(fromTable[0]!.severity, "info");

  const hostileName = "build.*|evil`";
  const hostileTable = "| Check | State |\n| --- | --- |\n| build.*\\|evil\\` | failure |\n";
  const hostileNames = parseCiCheckNames(hostileTable);
  assert.deepEqual([...hostileNames], [hostileName], "escaped pipe and backtick stay inside one check name");
  const notForged: import("../src/enforcement/artifact.js").ArtifactFinding[] = [
    { severity: "major", category: "bug", file: null, line: null, message: "evil failed" },
  ];
  assert.equal(capCiOnlyFindings(notForged, hostileNames), false, "regex metacharacters cannot forge an alternative check-name match");
  assert.equal(notForged[0]!.severity, "major");

  const escapedName: import("../src/enforcement/artifact.js").ArtifactFinding[] = [
    { severity: "major", category: "bug", file: null, line: null, message: "build.*|evil` failed" },
  ];
  assert.equal(capCiOnlyFindings(escapedName, hostileNames), true, "escaped Markdown and regex syntax remain safe in the status grammar");
  assert.equal(escapedName[0]!.severity, "info");

  const vocabularyName: import("../src/enforcement/artifact.js").ArtifactFinding[] = [
    { severity: "major", category: "bug", file: null, line: null, message: "failed build failed" },
  ];
  assert.equal(capCiOnlyFindings(vocabularyName, new Set(["failed build"])), true,
    "a multiword check name is a verified name slot in the grammar");
  assert.equal(vocabularyName[0]!.severity, "info");
});

test("CI-only cap accepts only anchored status-restatement syntax", () => {
  const names = new Set(["build", "test", "validate-toml"]);
  const accepted = [
    "build failed",
    "build has a terminal failure",
    "build is red",
    "build timed out",
    "build was cancelled",
    "validate-toml has a terminal failure",
    "The build failed.",
    "build and test failed",
    "build, test failed",
    "build,test failed",
    "build or test failed",
    "build failed again",
    "build again failed",
    "build still failed",
  ];
  for (const message of accepted) {
    const item: import("../src/enforcement/artifact.js").ArtifactFinding =
      { severity: "major", category: "bug", file: null, line: null, message };
    assert.equal(capCiOnlyFindings([item], names), true, message);
    assert.equal(item.severity, "info", message);
    assert.equal(item.ci_capped, true, message);
  }

  const rejected = [
    "build failed because this workflow should not run",
    "build failed because workflow runs when it should not",
    "test failed because authorization regressions are not covered",
    "build should not run",
    "build failed and this workflow should not run",
    "build failed or something worse",
    "The build failed because release artifacts can be published unsigned",
  ];
  for (const message of rejected) {
    const item: import("../src/enforcement/artifact.js").ArtifactFinding =
      { severity: "major", category: "bug", file: null, line: null, message };
    assert.equal(capCiOnlyFindings([item], names), false, message);
    assert.equal(item.severity, "major", message);
    assert.equal(item.ci_capped, undefined, message);
  }

  const repro: import("../src/enforcement/artifact.js").ArtifactFinding =
    { severity: "blocker", category: "bug", file: null, line: null,
      message: "build failed because this workflow should not run" };
  assert.equal(capCiOnlyFindings([repro], names), false);
  assert.equal(repro.severity, "blocker", "the maintainer's repro must remain blocking");
  const review = artifact({ verdict: "request_changes", findings: [repro] });
  assert.equal(relaxCiOnlyVerdict(review, { forced: false }), false);
  assert.equal(review.verdict, "request_changes", "the maintainer's repro must not trigger solo-finding approval");

  const authorization: import("../src/enforcement/artifact.js").ArtifactFinding =
    { severity: "blocker", category: "bug", file: null, line: null,
      message: "test failed because authorization regressions are not covered" };
  assert.equal(authorization.severity, "blocker");
  assert.equal(authorization.ci_capped, undefined);
});

test("generic check names and code-anchored findings stay blocking", () => {
  const table = "| Check | State |\n| --- | --- |\n| build | failure |\n| test | failure |\n";
  const findings: import("../src/enforcement/artifact.js").ArtifactFinding[] = [
    { severity: "major", category: "bug", file: null, line: null, message: "the build script mishandles env vars repo-wide" },
    { severity: "major", category: "bug", file: null, line: null, message: "test coverage is low in src/foo.ts" },
  ];
  assert.equal(capCiEvidenceFindings(findings, table), false);
  for (const item of findings) {
    const review = artifact({ verdict: "request_changes", findings: [item] });
    assert.equal(relaxCiOnlyVerdict(review, { forced: false }), false);
    assert.equal(review.verdict, "request_changes");
    assert.ok(item.severity === "blocker" || item.severity === "major");
  }
});

test("CI-only request_changes relaxes only after a proven cap and without forced/unresolved checks", () => {
  const findings = [
    { severity: "major" as const, category: "bug", file: null, line: null, message: "build is failing" },
    { severity: "blocker" as const, category: "bug", file: null, line: null, message: "test has a terminal failure" },
  ];
  assert.equal(capCiOnlyFindings(findings, new Set(["build", "test"])), true);
  assert.deepEqual(findings.map((item) => item.severity), ["info", "info"]);
  const eligible = artifact({ verdict: "request_changes", findings: structuredClone(findings) });
  assert.equal(relaxCiOnlyVerdict(eligible, { forced: false }), true);
  assert.equal(eligible.verdict, "approve");

  const mixedFindings: import("../src/enforcement/artifact.js").ArtifactFinding[] = [
    ...structuredClone(findings),
    {
      severity: "major",
      category: "bug",
      file: null,
      line: null,
      message: "build failed because this workflow should not run",
    },
  ];
  assert.equal(capCiOnlyFindings(mixedFindings, new Set(["build"])), false,
    "already-capped findings are unchanged and the non-status finding remains uncapped");
  assert.equal(mixedFindings[2]!.severity, "major");
  const mixed = artifact({ verdict: "request_changes", findings: mixedFindings });
  assert.equal(relaxCiOnlyVerdict(mixed, { forced: false }), false);
  assert.equal(mixed.verdict, "request_changes", "one non-capped finding keeps the solo relaxation closed");

  for (const blocked of [
    artifact({ verdict: "request_changes", findings: structuredClone(findings), required_check_dispositions: [{ status: "unresolved" }] }),
    artifact({ verdict: "request_changes", findings: structuredClone(findings), required_checks: "incomplete" }),
  ]) assert.equal(relaxCiOnlyVerdict(blocked, { forced: false }), false);
  assert.equal(relaxCiOnlyVerdict(artifact({ verdict: "request_changes", findings: structuredClone(findings) }), { forced: true }), false);
});

test("findings policy escalates blocker with contractual note", () => {
  const a = artifact({ findings: [finding("blocker")] });
  applyVerdictPolicy(a, "findings_severity_gated", policyOptions);
  assert.equal(a.verdict, "request_changes");
  assert.equal(a.verdict_source, "findings");
  assert.ok(a.review_markdown.includes("_Verdict escalated from structured findings (verdict_policy=findings_severity_gated): 1 blocker finding(s) out of 1; model verdict was 'approve'._"));
});

test("#1016 findings policy keeps an unverified blocker demotion blocking", () => {
  // The deterministic boundary demotes an originally-blocker finding to minor
  // when it could not confirm the source claim, which hides it from the
  // severity gate: with zero live blockers a model `approve` would survive as
  // a published approve even though the exact-head source was never read.
  // Unknown evidence is not refutation, so the gated policy must fail closed
  // the same way the strict mapping does.
  const demoted = (overrides: Record<string, unknown> = {}) => ({
    severity: "minor", category: "bug", file: "src/a.ts", line: 4, message: "finding",
    capped_from: "blocker", grounding_status: "unverified", ...overrides,
  });

  // #1656 (was #1016's gated-policy escalation): the unverified demotion no
  // longer escalates the model approve — the authoritative disposition
  // carries the `unverified_blocking_claim` MATERIAL unknown and withholds
  // certification instead, so no code blocker is fabricated from unknown
  // evidence and no approve silently certifies it either.
  const a = artifact({ findings: [demoted()] });
  applyVerdictPolicy(a, "findings_severity_gated", policyOptions);
  assert.equal(a.verdict, "approve");
  assert.equal(a.verdict_source, "model");
  assert.ok(!a.review_markdown.includes("escalated from structured findings"));

  // A positively REFUTED demotion is proof the claim is wrong: the model
  // approve stands and the note never implies an unverifiable blocker.
  const refuted = artifact({ findings: [demoted({ grounding_status: "refuted" })] });
  applyVerdictPolicy(refuted, "findings_severity_gated", policyOptions);
  assert.equal(refuted.verdict, "approve");
  assert.equal(refuted.verdict_source, "model");
  assert.ok(!refuted.review_markdown.includes("escalated from structured findings"));

  // The gate is blocker-level only: a demoted major never escalated under
  // this policy before #1016 and must not start now.
  const major = artifact({ findings: [demoted({ capped_from: "major" })] });
  applyVerdictPolicy(major, "findings_severity_gated", policyOptions);
  assert.equal(major.verdict, "approve");
  assert.equal(major.verdict_source, "model");

  // #977 verification asks can never request changes, capped or not.
  const verification = artifact({ findings: [demoted({ category: "verification" })] });
  applyVerdictPolicy(verification, "findings_severity_gated", policyOptions);
  assert.equal(verification.verdict, "approve");
  assert.equal(verification.verdict_source, "model");
});

test("#1016 findings policy attributes a live blocker and an unverified demotion as one note", () => {
  // Both signals fire: the composed note names each contribution and keeps the
  // live blocker count intact, mirroring `strictRequestChangesDetail`.
  const a = artifact({ findings: [finding("blocker"), {
    severity: "minor", category: "bug", file: "src/b.ts", line: 4, message: "finding",
    capped_from: "blocker", grounding_status: "unverified",
  }] });
  applyVerdictPolicy(a, "findings_severity_gated", policyOptions);
  assert.equal(a.verdict, "request_changes");
  assert.ok(
    a.review_markdown.includes("_Verdict escalated from structured findings (verdict_policy=findings_severity_gated): 1 blocker finding(s) out of 2; model verdict was 'approve'._"),
    `expected one composed attribution note, got: ${a.review_markdown}`,
  );
});

test("#775 caps opted-in blocker/major findings and relaxes only without remaining gates", () => {
  const a = artifact({ verdict: "request_changes", findings: [finding("blocker", "tests"), finding("major", "docs")] });
  applyVerdictPolicy(a, "findings_severity_gated", policyOptions);
  assert.deepEqual(a.findings.map((f: any) => [f.severity, f.capped_from]), [["minor", "blocker"], ["minor", "major"]]);
  assert.equal(a.verdict, "approve");
  assert.equal(a.verdict_source, "findings");
  assert.ok(a.review_markdown.includes("_Verdict relaxed from structured findings (verdict_policy=findings_severity_gated): every blocking finding was in a category this repository marks non-blocking (non_blocking_finding_categories); they remain listed above._"));
});

test("security is ineligible, security risk exempts all capping, and unresolved checks hold relaxation", () => {
  const security = artifact({ verdict: "request_changes", findings: [finding("blocker", "security")] });
  applyVerdictPolicy(security, "findings_severity_gated", { nonBlockingCategories: new Set(["security"]), securityFlagged: false });
  assert.equal(security.findings[0]!.severity, "blocker");
  assert.equal(security.verdict, "request_changes");

  const flagged = artifact({ verdict: "request_changes", findings: [finding("blocker", "tests")] });
  applyVerdictPolicy(flagged, "findings_severity_gated", { nonBlockingCategories: new Set(["tests"]), securityFlagged: true });
  assert.equal(flagged.findings[0]!.severity, "blocker");
  assert.equal(securityRiskFlagged({ risk_flags: ["auth_changes"] }), true);

  const unresolved = artifact({ verdict: "request_changes", findings: [finding("major", "tests")], required_check_dispositions: [{ status: "unresolved" }] });
  applyVerdictPolicy(unresolved, "findings_severity_gated", { nonBlockingCategories: new Set(["tests"]), securityFlagged: false });
  assert.equal(unresolved.findings[0]!.severity, "minor");
  assert.equal(unresolved.verdict, "request_changes");
});

test("remaining blocker prevents downgrade; non-blocker never escalates", () => {
  const remains = artifact({ verdict: "request_changes", findings: [finding("blocker", "tests"), finding("blocker", "security")] });
  applyVerdictPolicy(remains, "findings_severity_gated", { nonBlockingCategories: new Set(["tests"]), securityFlagged: false });
  assert.equal(remains.verdict, "request_changes");
  const minor = artifact({ findings: [finding("major")] });
  applyVerdictPolicy(minor, "findings_severity_gated", policyOptions);
  assert.equal(minor.verdict, "approve");
  assert.equal(minor.verdict_source, "model");
});

test("non-blocking categories normalize and intersect the eligible set", () => {
  assert.deepEqual([...parseNonBlockingCategories(" TESTS, Docs, SECURITY, ,BUG ")].sort(), ["bug", "docs", "tests"]);
  assert.deepEqual([...parseNonBlockingCategories(undefined)], []);
  assert.deepEqual([...parseNonBlockingCategories("security")], []);
});

test("required-check validation none, structured complete, warn/fail/metadata and invalid mode", () => {
  const none = artifact();
  assert.equal(applyRequiredCheckValidation(none, { enabled: "auto", mode: "warn", mustCheck: [] }).status, "none");
  assert.equal(none.required_checks, "none");

  const complete = artifact({ required_check_dispositions: [{ check: "run tests", status: "satisfied", rationale: "ran" }] });
  assert.equal(applyRequiredCheckValidation(complete, { enabled: "true", mode: "warn", mustCheck: ["run tests"] }).status, "complete");

  const warn = artifact({ required_check_dispositions: [] });
  applyRequiredCheckValidation(warn, { enabled: "true", mode: "warn", mustCheck: ["run tests"] });
  assert.equal(warn.verdict, "approve");
  assert.ok(warn.review_markdown.includes("### Unaddressed required checks"));

  const fail = artifact({ required_check_dispositions: [] });
  applyRequiredCheckValidation(fail, { enabled: "true", mode: "fail", mustCheck: ["run tests"] });
  assert.equal(fail.verdict, "request_changes");
  assert.ok(fail.review_markdown.endsWith("_required_check_validation_mode=fail: treating the missing required checks as blocking._"));

  const metadata = artifact({ required_check_dispositions: [] });
  const before = metadata.review_markdown;
  const metaResult = applyRequiredCheckValidation(metadata, { enabled: "true", mode: "metadata_only", mustCheck: ["run tests"] });
  assert.equal(metadata.review_markdown, before);
  assert.equal(metaResult.mode, "metadata_only");

  const invalidMode = applyRequiredCheckValidation(artifact(), { enabled: "true", mode: "wat", mustCheck: ["run tests"] });
  assert.equal(invalidMode.mode, "warn");
});

test("required-check structured key absent or unusable is unresolved; no keyword fallback (#1252)", () => {
  for (const a of [artifact(), artifact({ required_check_dispositions: "bad" })]) {
    const result = applyRequiredCheckValidation(a, { enabled: "true", mode: "metadata_only", mustCheck: ["run full test suite after upgrade"] });
    assert.equal(result.status, "incomplete");
    assert.equal((result.result.checks as any[])[0].reason, "no-structured-dispositions");
  }
});

test("thread settlement handles no rows, missing/fixed evidence, and retained valid dispositions", () => {
  assert.deepEqual(applyReviewThreadEnforcement(artifact(), [], "model"), { applied: false, reason: "" });
  const a = artifact({ thread_dispositions: [{ thread_id: "bad", disposition: "fixed", evidence: "text" }, { thread_id: "good", disposition: "fixed", evidence: "src/good.ts:12" }, { thread_id: "disputed", disposition: "disputed", evidence: null }] });
  const threads = ["missing", "bad", "good", "disputed"].map((thread_id) => ({ thread_id, path: `src/${thread_id}.ts`, line: 2, severity: "minor", message: "thread", own_finding: false, replies: 1 }));
  const result = applyReviewThreadEnforcement(a, threads, "model");
  assert.equal(result.applied, true);
  const rows = a.thread_dispositions as any[];
  assert.deepEqual(rows.map((x) => x.disposition), ["open", "open", "fixed", "open"]);
  assert.equal(rows[0].enforced, "no disposition given");
  assert.equal(rows[1].enforced, "fixed without evidence citing current code");
  assert.equal(rows[3].disposition, "open", "an unexplained invalidity claim is not a current-head resolution");
  assert.equal(rows[3].enforced, "disputed without an explanation");
  assert.ok(a.review_markdown.includes("## Unresolved Review Threads"));
  assert.ok(a.review_markdown.includes("- `bad`: open — fixed without evidence citing current code"));
  assert.equal((a.findings as any[]).filter((f) => f.thread_id).length, 3);
});

test("threads reemit severity once and findings policy escalates blocker threads", () => {
  const a = artifact({ thread_dispositions: [{ thread_id: "t", disposition: "open", evidence: "still present at this head: a.py:3 never validates the input" }] });
  const thread = { thread_id: "t", path: "a.py", line: 3, severity: "blocker", message: "issue", own_finding: false, replies: 0 };
  applyReviewThreadEnforcement(a, [thread], "findings_severity_gated");
  assert.equal(a.findings.length, 1);
  assert.equal(a.findings[0]!.severity, "blocker");
  assert.equal(a.verdict, "request_changes");
  assert.equal(a.verdict_source, "findings");
  assert.ok(a.review_markdown.includes("_Verdict escalated from unresolved review threads (verdict_policy=findings_severity_gated): 1 blocker thread(s) still open; model verdict was 'approve'._"));
  const existing = artifact({ findings: [{ ...finding("minor"), thread_id: "t" }], thread_dispositions: [{ thread_id: "t", disposition: "open", evidence: "still present at this head: a.py:3 never validates the input" }] });
  applyReviewThreadEnforcement(existing, [thread], "model");
  assert.equal(existing.findings.length, 1);
  const defaultSeverity = artifact({ thread_dispositions: [] });
  applyReviewThreadEnforcement(defaultSeverity, [{ ...thread, thread_id: "default", severity: "" }], "model");
  assert.equal(defaultSeverity.findings[0]!.severity, "minor");
});

test("code-citing evidence recognizes paths and line locations only", () => {
  assert.equal(evidenceCitesCode("see src/a.py", null), false);
  assert.equal(evidenceCitesCode("changed file.py:12", null), true);
  assert.equal(evidenceCitesCode("see line 12", null), true);
  assert.equal(evidenceCitesCode("the behavior looks fixed", null), false);
  assert.equal(evidenceCitesCode("edited file", "edited file"), true);
});

test("human reviews settle conservatively, render exact context, and never change verdict", () => {
  const a = artifact({ verdict: "approve", human_review_dispositions: [
    { review_id: "moved", disposition: "addressed", evidence: "src/fix.ts:12" },
    { review_id: "unchanged", disposition: "addressed", evidence: "looks good" },
    { review_id: "unknown", disposition: "maybe", evidence: null },
  ] });
  const result = applyHumanReviewEnforcement(a, [
    { review_id: "moved", login: "alice", commit_id: "123456789", head_moved: true, submitted_at: null },
    { review_id: "unchanged", login: "bob", commit_id: "abcdef012", head_moved: false, submitted_at: null },
    { review_id: "unknown", login: "c", commit_id: null, head_moved: "unknown", submitted_at: null },
  ]);
  assert.deepEqual(result, { applied: false, reason: "" });
  assert.equal(a.verdict, "approve");
  assert.deepEqual((a.human_review_dispositions as any[]).map((r) => r.disposition), ["addressed", "not_addressed", "not_addressed"]);
  assert.ok(a.review_markdown.includes("- @alice's change request (1234567, head moved since) judged addressed at this head: `src/fix.ts:12`"));
  assert.ok(a.review_markdown.includes("- @bob's change request (abcdef0, head unchanged since) is not shown addressed at this head; it stays unresolved until proven at the reviewed head."));
  assert.ok(a.review_markdown.includes("- @c's change request (unknown commit) is not shown addressed at this head; it stays unresolved until proven at the reviewed head."));
  assert.ok(a.review_markdown.includes("## Outstanding Human Change Requests"));
});

test("inlineCode uses safe fences, whitespace normalization, and bounded ellipsis", () => {
  assert.equal(inlineCode("  hello\n world  "), "`hello world`");
  assert.equal(inlineCode("x``y"), "```x``y```");
  assert.equal(inlineCode("a".repeat(302)), `\`${"a".repeat(299)}…\``);
  assert.equal(inlineCode("a".repeat(302)).length, 302);
});

test("enforced markdown normalization rewrites recommendations and banners idempotently", () => {
  for (const markdown of ["Recommendation: Approve", "### Recommendation: Approve"]) {
    const a = artifact({ verdict: "request_changes", review_markdown: markdown });
    normalizeEnforcedReviewMarkdown(a, ["reason one", "reason two"]);
    assert.ok(a.review_markdown.startsWith("## Final Recommendation\n"));
    assert.ok(a.review_markdown.includes("- reason one\n- reason two"));
    assert.ok(a.review_markdown.includes("Model recommendation before enforcement: Approve"));
    const once = a.review_markdown;
    normalizeEnforcedReviewMarkdown(a, ["again"]);
    assert.equal(a.review_markdown, once);
  }
  const noReasons = artifact({ verdict: "request_changes", review_markdown: "Review" });
  normalizeEnforcedReviewMarkdown(noReasons, null);
  assert.ok(noReasons.review_markdown.includes("One or more configured enforcement checks"));
  const approve = artifact({ review_markdown: "Recommendation: Approve" });
  normalizeEnforcedReviewMarkdown(approve, ["x"]);
  assert.equal(approve.review_markdown, "Recommendation: Approve");
});

test("applyAll counts evidence and tool enforcement, fallback, and applies settlements without counting humans", () => {
  const inputs = { evidenceBlockerEnabled: true, toolFailureEnabled: true, toolMinSuccessful: 0,
    evidence: { has_blocker: true, providers: [{ id: "scanner", provider_severity: "blocker" }] },
    toolHarness: { planning_error: "plan broke" }, threads: null, humanReviews: null, verdictPolicy: "model" };
  const both = artifact();
  // #1656: the tool overlay still counts as an applied action (it
  // discloses the capability failure in the body), but it no longer
  // contributes a forcing reason to the enforcement banner — the
  // disposition answers it with `investigation_unavailable` evidence.
  assert.equal(applyAllEnforcement(both, inputs), 2);
  assert.ok(both.review_markdown.includes("- Evidence provider blocker detected: scanner."));
  assert.ok(!both.review_markdown.includes("- Tool harness failure detected (plan broke)."));
  assert.ok(both.review_markdown.includes("## Tool Harness Failure\nThe tool harness failed during planning or execution (plan broke)."));

  const fallback = artifact();
  assert.equal(applyAllEnforcement(fallback, { ...inputs, evidenceBlockerEnabled: false, toolFailureEnabled: true,
    toolMinSuccessful: 2, evidence: null, toolHarness: { tool_results: [{ status: "ok" }] } }), 1);
  assert.ok(fallback.review_markdown.includes("Tool Harness Insufficient Evidence"));

  const settlement = artifact({ thread_dispositions: [], human_review_dispositions: [] });
  assert.equal(applyAllEnforcement(settlement, { ...inputs, evidenceBlockerEnabled: false, toolFailureEnabled: false,
    toolMinSuccessful: 0, evidence: null, toolHarness: null,
    threads: [{ thread_id: "t", path: null, line: null, severity: "minor", message: "m", own_finding: false, replies: 0 }],
    humanReviews: [{ review_id: "h", login: "x", commit_id: null, head_moved: "unknown", submitted_at: null }] }), 1);
});

test("evidence/tool helpers preserve exact sections, reasons, precedence, null behavior, and boundary", () => {
  const missing = artifact();
  assert.deepEqual(applyEvidenceBlockerEnforcement(missing, null), { applied: false, reason: "" });
  assert.deepEqual(applyEvidenceBlockerEnforcement(missing, { has_blocker: false }), { applied: false, reason: "" });
  const evidence = artifact();
  assert.deepEqual(applyEvidenceBlockerEnforcement(evidence, { has_blocker: true, providers: [{ id: "sec", provider_severity: "blocker" }] }), {
    applied: true, reason: "Evidence provider blocker detected: sec. One or more configured evidence providers reported blocker-level findings.",
  });
  assert.ok(evidence.review_markdown.endsWith("## Evidence Provider Blockers\nOne or more configured evidence providers reported blocker-level findings (sec). Resolve blocker findings before approval."));

  // #1656: the overlay is an observable diagnostic — it discloses the
  // failure and never touches the verdict.
  for (const [harness, reason] of [[{ planning_error: "planning", error: "execution", executed_request_count: 2 }, "planning"], [{ error: "execution" }, "execution"]] as Array<[any, string]>) {
    const a = artifact();
    const outcome = applyToolHarnessFailureEnforcement(a, harness);
    assert.deepEqual(outcome, { applied: true, reason: "" });
    assert.ok(a.review_markdown.includes(`## Tool Harness Failure\nThe tool harness failed during planning or execution (${reason}).`));
    assert.equal(a.verdict, "approve");
    assert.equal(a.verdict_source, undefined);
    assert.equal(toolCapabilityFailure(harness), reason);
  }
  assert.deepEqual(applyToolHarnessFailureEnforcement(artifact(), null), { applied: false, reason: "" });
  assert.deepEqual(applyToolMinSuccessfulEnforcement(artifact(), 1, { tool_results: [{ status: "ok" }] }), { applied: false, reason: "" });
});

test("#1606: the tool-harness failure check fires for a run whose every tool call failed", () => {
  // The artifact shapes below are the ones the harness ACTUALLY writes
  // (#1597 partitions: issued = executed + refused + deduplicated, and one
  // `tool_calls`/`tool_results` entry per executed call).
  const allFailed = {
    planned_request_count: 2,
    executed_request_count: 2,
    successful_request_count: 0,
    refused_request_count: 0,
    deduplicated_request_count: 0,
    tool_calls: [
      { tool: "read_file", args: { path: "missing.md" }, status: "error" },
      { tool: "list_dir", args: { path: "missing/" }, status: "error" },
    ],
    tool_results: [
      { tool: "read_file", status: "error", result: { error: "no such file" } },
      { tool: "list_dir", status: "error", result: { error: "no such directory" } },
    ],
  };
  const a = artifact();
  const outcome = applyToolHarnessFailureEnforcement(a, allFailed);
  // #1656: the failure is disclosed and reason-coded for the disposition —
  // it no longer forces a verdict (an abstention, never a fabricated block).
  assert.deepEqual(outcome, { applied: true, reason: "" });
  assert.ok(a.review_markdown.includes("## Tool Harness Failure\nThe tool harness failed during planning or execution (all tool requests failed)."));
  assert.ok(a.review_markdown.includes("no approval is certified"));
  assert.equal(a.verdict, "approve");
  assert.equal(a.verdict_source, undefined);
  assert.equal(toolCapabilityFailure(allFailed), "all tool requests failed");

  // A run with at least one successful call stays silent.
  const mixed = {
    ...allFailed,
    successful_request_count: 1,
    tool_calls: [
      { tool: "read_file", args: { path: "src/a.ts" }, status: "ok" },
      { tool: "list_dir", args: { path: "missing/" }, status: "error" },
    ],
    tool_results: [
      { tool: "read_file", status: "ok", result: { content: "code" } },
      { tool: "list_dir", status: "error", result: { error: "no such directory" } },
    ],
  };
  assert.deepEqual(applyToolHarnessFailureEnforcement(artifact(), mixed), { applied: false, reason: "" });

  // A run that dispatched NO call is not an all-failed run: there was no
  // tool call to fail (the min-successful gate owns that case).
  const none = {
    planned_request_count: 0,
    executed_request_count: 0,
    successful_request_count: 0,
    refused_request_count: 0,
    deduplicated_request_count: 0,
    tool_calls: [],
    tool_results: [],
  };
  assert.deepEqual(applyToolHarnessFailureEnforcement(artifact(), none), { applied: false, reason: "" });

  // #1656: a capability failure is no longer a fail-closed forcing
  // condition — the authoritative disposition answers it with
  // `investigation_unavailable` evidence (an abstention), so the
  // fail-closed FORCING signal stays silent for it.
  assert.equal(failClosedEnforcementFired({
    evidenceBlockerEnabled: false,
    evidence: null,
  }), false);
  assert.equal(toolCapabilityFailure(allFailed), "all tool requests failed");
  assert.equal(toolCapabilityFailure(mixed), null);
  assert.equal(toolMinSuccessfulFloorUnmet(none, 2), true);
  assert.equal(toolMinSuccessfulFloorUnmet(none, 0), false);
});

test("requirement coverage credits grounded claims, downgrades unsafe claims, and reports ledger errors", () => {
  const ledger = { sha: "abc", requirements: [{ id: "r1", verification_required: false }, { id: "r2", verification_required: true }, { id: "r3", verification_required: false }] };
  const normalized = normalizeRequirementCoverage([
    { requirement_id: "r1", status: "satisfied", evidence: [{ kind: "file", ref: "src/a.ts", detail: "changed" }] },
    { requirement_id: "r2", status: "satisfied", evidence: [{ kind: "file", ref: "src/a.ts", detail: "looked" }] },
    { requirement_id: "r3", status: "not_applicable", evidence: [{ kind: "test", ref: "test", detail: "scope" }] },
    { requirement_id: "r3", status: "unknown" }, { requirement_id: "outsider", status: "satisfied" },
  ], ledger);
  assert.equal(normalized.coverage[0]!.credited, true);
  assert.equal(normalized.coverage[1]!.status, "unknown");
  assert.ok(normalized.coverage[1]!.notes.includes("downgraded-invariant-unverified"));
  assert.equal(normalized.coverage[2]!.status, "unknown");
  assert.ok(normalized.coverage[2]!.notes.includes("downgraded-na-without-deterministic-scope-proof"));
  assert.ok(normalized.errors.includes("duplicate-coverage-r3"));
  assert.ok(normalized.errors.includes("dropped-coverage-outsider"));
  const noEvidence = normalizeRequirementCoverage([{ requirement_id: "r", status: "violated" }], { requirements: [{ id: "r" }] });
  assert.equal(noEvidence.coverage[0]!.status, "unknown");
  assert.ok(noEvidence.coverage[0]!.notes.includes("downgraded-no-concrete-evidence"));
  assert.ok(normalizeRequirementCoverage([], null).errors.includes("ledger-unavailable"));
});

test("coverage evidence vocabulary and caps; payload extraction supports objects and arrays", () => {
  const evidence = Array.from({ length: 10 }, (_, i) => ({ kind: i === 0 ? "NOPE" : "test", ref: "r".repeat(510), detail: `d${i}` }));
  const normalized = normalizeRequirementCoverage([{ requirement_id: "r", status: "satisfied", evidence }], { requirements: [{ id: "r" }] });
  assert.equal(normalized.coverage[0]!.evidence.length, 8);
  assert.equal(normalized.coverage[0]!.evidence[0]!.ref.length, 500);
  assert.ok(normalized.coverage[0]!.evidence[0]!.ref.endsWith("…"));
  assert.ok(normalized.coverage[0]!.notes.includes("dropped-evidence-invalid-kind"));
  assert.ok(normalized.coverage[0]!.notes.includes("evidence-truncated"));
  const rows = [{ requirement_id: "r" }];
  assert.deepEqual(extractCoveragePayload({ requirement_coverage: rows }), rows);
  assert.deepEqual(extractCoveragePayload(rows), rows);
});

test("metadata marker preserves exact key order and omits empty/legacy values", () => {
  assert.equal(buildRunMetadataMarker({ headSha: "h", baseSha: "b", reviewResult: "clean", requiredChecks: "complete", reviewRoute: "native", escalationReason: "a,b", cacheHitRatio: "0.5" }),
    '<!-- ai-pr-reviewer:{"version":1,"head_sha":"h","base_sha":"b","review_result":"clean","required_checks":"complete","review_route":"native","escalation_reason":["a","b"],"cache_hit_ratio":0.5} -->');
  assert.equal(buildRunMetadataMarker({ headSha: "h", baseSha: "b", reviewResult: "partial", incompleteReason: "requirement_trace" }),
    '<!-- ai-pr-reviewer:{"version":1,"head_sha":"h","base_sha":"b","review_result":"partial","incomplete_reason":"requirement_trace"} -->');
  assert.equal(buildRunMetadataMarker({ headSha: "", baseSha: "", reviewResult: "issues", requiredChecks: "none", reviewRoute: "legacy", escalationReason: "", cacheHitRatio: "-" }),
    '<!-- ai-pr-reviewer:{"version":1,"head_sha":"unknown","base_sha":"","review_result":"issues"} -->');
  assert.throws(() => buildRunMetadataMarker({ headSha: "h", baseSha: "b", reviewResult: "clean", cacheHitRatio: "nope" }), /cache_hit_ratio is not a number/);
});

test("metadata preamble, managed-body identity, and forged marker stripping", () => {
  assert.equal(emitReviewMarkers({ commentMarker: "managed", metadataMarker: "meta", headSha: "sha", broadFingerprint: "fp" }), "managed\nmeta\n<!-- ai-pr-review-sha:sha -->\n<!-- ai-pr-review-fingerprint:fp -->\n");
  assert.throws(() => emitReviewMarkers({ commentMarker: "", metadataMarker: "meta" }), /COMMENT_MARKER must be set/);
  assert.throws(() => emitReviewMarkers({ commentMarker: "managed", metadataMarker: "" }), /METADATA_MARKER must be set/);
  assert.equal(isManagedBody("<!-- ai-pr-reviewer: v3 -->rest"), true);
  assert.equal(isManagedBody("<!-- ai-pr-reviewer older"), true);
  assert.equal(isManagedBody("prefix <!-- ai-pr-reviewer: v3 -->"), false);
  assert.equal(stripReservedMarkers("before <!-- AI-PR-REVIEW-SHA: forged --> middle <!--ai-pr-review-fingerprint:bad--> after"), "before  middle  after");
});

// ---------------------------------------------------------------------------
// #792 regression (v3 disposition, #812): a carried thread blocker the same
// review settles as `fixed` — with evidence citing current code — is NOT
// re-emitted into the findings array, so the findings-severity gate counts
// only what is still open. (The v2 incremental carry-forward this bug lived
// in was removed with #619; the thread settlement is the remaining path a
// "resolved" item could re-enter the gate through.)
// ---------------------------------------------------------------------------

test("#792: a thread blocker settled as fixed with code evidence is not counted by the severity gate", () => {
  const a = artifact({ verdict: "approve", findings: [] });
  const threads = [
    { thread_id: "t1", path: "src/a.py", line: 3, severity: "blocker", message: "handles leak", own_finding: false, replies: 0 },
  ];
  a.thread_dispositions = [{ thread_id: "t1", disposition: "fixed", evidence: "the leak is gone; see src/a.py:5 handling" }];
  applyReviewThreadEnforcement(a, threads, "findings_severity_gated");
  assert.equal(a.findings.length, 0, "a settled thread must not re-enter the open findings");
  assert.equal(a.verdict, "approve", "the gate must not escalate on a resolved blocker");
});

test("#1663: the same blocker claimed fixed WITHOUT code evidence is withheld, never re-emitted as a blocker", () => {
  const a = artifact({ verdict: "approve", findings: [] });
  const threads: EnforcementThread[] = [
    { thread_id: "t1", path: "src/a.py", line: 3, severity: "blocker", message: "handles leak", own_finding: true, authorship: "action", replies: 0 },
  ];
  a.thread_dispositions = [{ thread_id: "t1", disposition: "fixed", evidence: "trust me it is fixed" }];
  applyReviewThreadEnforcement(a, threads, "findings_severity_gated", {
    available: true,
    unresolvedIds: new Set(["t1"]),
    resolvedIds: new Set(),
    headSha: "a".repeat(40),
  });
  assert.equal(a.findings.length, 0, "an unverified historical blocker does not re-enter the finding set");
  assert.equal((a.thread_dispositions as Array<Record<string, unknown>>)[0]!.disposition, "open");
  assert.equal(a.thread_reconciliation?.unreassessed, 1, "the uncertainty is materially recorded");
  assert.equal(a.verdict, "approve", "the historical severity no longer forces the verdict");
});

test("#812: the #814 shape — nine Minor/Info threads plus one Major resolved with evidence — never requests changes", () => {
  // Thread roots exactly as the publish step's managed finding comments are
  // posted: the enforcement view parses the ORIGINAL severity from each.
  const botThread = (id: string, label: string, message: string) => ({
    thread_id: id,
    path: "src/a.ts",
    line: 1,
    comments: [{
      id, user: "reviewer-bot", created_at: "2026-09-28T10:00:00Z",
      body: `**${label}:** ${message}\n\n_Automated finding from AI PR review._`,
    }],
  });
  const raw = [
    ...[1, 2, 3, 4].map((n) => botThread(`PRRT_t${n}`, "Minor (tests)", `nit ${n}`)),
    ...[5, 6, 7, 8, 9].map((n) => botThread(`PRRT_t${n}`, "Info (security)", `note ${n}`)),
    botThread("PRRT_major", "⚠️ Major (tests)", "parity fixture missing"),
  ];
  const view = enforcementView(renderReviewThreads(prepareThreads(raw))[1]);
  assert.deepEqual(
    [...view.map((v) => v.severity)].sort(),
    ["info", "info", "info", "info", "info", "major", "minor", "minor", "minor", "minor"],
  );

  const a = artifact({
    verdict: "approve",
    thread_dispositions: [
      { thread_id: "PRRT_major", disposition: "fixed", evidence: "added tests/fixtures/parity/corpus/v1.json:1" },
    ],
  });
  const settlement = applyReviewThreadEnforcement(a, view, "strict");
  assert.equal(settlement.applied, true);
  assert.equal(settlement.reason, "review threads: 9 disposition(s) downgraded, 9 finding(s) re-emitted");
  assert.deepEqual(
    (a.findings as Array<{ severity: string }>).map((f) => f.severity).sort(),
    ["info", "info", "info", "info", "info", "minor", "minor", "minor", "minor"],
    "each re-emitted finding carries its thread's original severity",
  );
  // Strict mapping over the final still-open set: Minor/Info alone approves.
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "approve", forced: false });
  assert.equal(a.verdict, "approve");
  assert.equal(outcome.reviewResult, "findings");
  assert.equal(outcome.overridden, false);
});

test("#812: an undeterminable re-emission severity defaults to minor and never blocks", () => {
  const a = artifact({ thread_dispositions: [] });
  applyReviewThreadEnforcement(a, [
    { thread_id: "g1", path: "a.py", line: 1, severity: "critical", message: "x", own_finding: true, replies: 0 },
    { thread_id: "g2", path: "a.py", line: 2, severity: "", message: "y", own_finding: true, replies: 0 },
    { thread_id: "g3", path: "a.py", line: 3, severity: "Major", message: "z", own_finding: true, replies: 0 },
  ], "strict");
  assert.deepEqual(
    (a.findings as Array<{ severity: string }>).map((f) => f.severity),
    ["minor", "minor", "minor"],
  );
  applyStrictVerdictPolicy(a, { modelVerdict: "approve", forced: false });
  assert.equal(a.verdict, "approve");
});

// ---------------------------------------------------------------------------
// #1645: stale carried thread state must not force REQUEST_CHANGES on the
// current head. A listed thread may re-enter the finding set only when the
// authoritative live listing proves it live and unresolved; resolved/absent
// threads drop, unknown (unreadable listing) fails open with disclosure, and
// bounded reconciliation provenance persists on the artifact.
// ---------------------------------------------------------------------------

const staleThreads = [
  { thread_id: "PRRT_stale1", path: "src/a.ts", line: 3, severity: "major", message: "old defect one", own_finding: true, replies: 0 },
  { thread_id: "PRRT_stale2", path: "src/b.ts", line: 7, severity: "major", message: "old defect two", own_finding: true, replies: 0 },
];

test("#1645: stale carried blockers absent from the live listing cannot block an approve", () => {
  const a = artifact({
    verdict: "approve",
    findings: [
      { severity: "minor", category: "tests", file: "src/a.ts", line: 9, message: "nit" },
      { severity: "info", category: "docs", file: "src/b.ts", line: 1, message: "note" },
    ],
    thread_dispositions: [],
  });
  const settlement = applyReviewThreadEnforcement(a, staleThreads, "strict", {
    available: true,
    unresolvedIds: new Set(),
    resolvedIds: new Set(),
    headSha: "a".repeat(40),
  });
  assert.equal(a.findings.length, 2, "historical majors must not re-enter the open finding set");
  assert.equal(settlement.applied, false, "dropping dead threads is not an enforcement action");
  const strict = applyStrictVerdictPolicy(a, { modelVerdict: "approve", forced: false });
  assert.equal(a.verdict, "approve", "strict mapping must not force REQUEST_CHANGES from historical rows");
  assert.equal(strict.reviewResult, "findings");
  assert.deepEqual(a.thread_reconciliation, {
    state: "complete",
    head_sha: "a".repeat(40),
    live_unresolved: 0,
    resolved: 0,
    absent: 2,
    unknown: 0,
  });
  assert.doesNotMatch(String(a.review_markdown), /Unresolved Review Threads/);
});

test("#1645: live carried blocker still blocks; sibling absent thread drops", () => {
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [{ thread_id: "PRRT_stale1", disposition: "open", evidence: "still present at this head: the defect the thread points at is unchanged" }],
  });
  applyReviewThreadEnforcement(a, staleThreads, "strict", {
    available: true,
    unresolvedIds: new Set(["PRRT_stale1"]),
    resolvedIds: new Set(),
    headSha: "b".repeat(40),
  });
  const reemitted = a.findings.filter((f) => f.thread_id === "PRRT_stale1");
  assert.equal(reemitted.length, 1, "a thread proven live-unresolved re-emits");
  assert.equal(reemitted[0]!.severity, "major");
  assert.equal(reemitted[0]!.thread_reconciliation, "live_unresolved");
  assert.ok(!a.findings.some((f) => f.thread_id === "PRRT_stale2"), "the absent sibling never re-emits");
  applyStrictVerdictPolicy(a, { modelVerdict: "approve", forced: false });
  assert.equal(a.verdict, "request_changes", "the live carried blocker still blocks");
});

test("#1645: historical blocker whose live thread resolved upstream does not block", () => {
  const a = artifact({ verdict: "approve", findings: [], thread_dispositions: [] });
  applyReviewThreadEnforcement(a, staleThreads.slice(0, 1), "strict", {
    available: true,
    unresolvedIds: new Set(),
    resolvedIds: new Set(["PRRT_stale1"]),
    headSha: "c".repeat(40),
  });
  assert.equal(a.findings.length, 0);
  applyStrictVerdictPolicy(a, { modelVerdict: "approve", forced: false });
  assert.equal(a.verdict, "approve");
  assert.equal(a.thread_reconciliation?.resolved, 1);
  const settled = a.thread_dispositions as Array<Record<string, unknown>>;
  assert.equal(settled[0]!.reconciliation, "resolved");
});

test("#1645: unreadable live listing fails open — no blocker invented, incompleteness disclosed", () => {
  const a = artifact({
    verdict: "approve",
    findings: [{ severity: "blocker", category: "bug", file: "src/a.ts", line: 1, message: "fresh current-head defect" }],
    thread_dispositions: [],
  });
  applyReviewThreadEnforcement(a, staleThreads, "strict", {
    available: false,
    unresolvedIds: new Set(),
    resolvedIds: new Set(),
    headSha: "d".repeat(40),
  });
  assert.equal(a.findings.length, 1, "only the current-head finding remains");
  assert.equal(a.findings[0]!.thread_id, undefined);
  applyStrictVerdictPolicy(a, { modelVerdict: "approve", forced: false });
  assert.equal(a.verdict, "request_changes", "a fresh current-head blocker still blocks");
  assert.equal(a.thread_reconciliation?.state, "incomplete");
  assert.equal(a.thread_reconciliation?.unknown, 2);
  assert.match(String(a.review_markdown), /reconciliation incomplete/, "the incompleteness is disclosed");
  assert.match(String(a.review_markdown), /PRRT_stale1/, "carried threads stay visible as bookkeeping");
});

test("#1645: a capped (incomplete) listing proves NO state — every carried thread reconciles unknown and none blocks", () => {
  // Only a proven-complete listing may yield a proven state (maintainer
  // review 5885372900). A partial enumeration cannot show that a thread is
  // live-unresolved, resolved, or gone, so even the thread it positively
  // reports reconciles `unknown`: historical state never blocks on a
  // listing that does not enumerate the whole set.
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [],
  });
  applyReviewThreadEnforcement(a, staleThreads, "strict", {
    available: true,
    unresolvedIds: new Set(["PRRT_stale1"]),
    resolvedIds: new Set(),
    headSha: "f".repeat(40),
    complete: false,
  });
  const carried = a.findings.filter((f) => f.thread_id === "PRRT_stale1");
  assert.equal(carried.length, 0, "a thread the partial listing reports is not a proven live thread");
  assert.ok(!a.findings.some((f) => f.thread_id === "PRRT_stale2"), "a thread the partial listing omits is not proven absent");
  assert.equal(a.thread_reconciliation?.state, "incomplete");
  assert.equal(a.thread_reconciliation?.unknown, 2, "both carried threads reconcile as unknown");
  assert.equal(a.thread_reconciliation?.live_unresolved, 0, "an incomplete listing proves no live thread");
  assert.equal(a.thread_reconciliation?.absent, 0);
  applyStrictVerdictPolicy(a, { modelVerdict: "approve", forced: false });
  assert.equal(a.verdict, "approve", "unverifiable historical state never forces REQUEST_CHANGES");
  assert.match(String(a.review_markdown), /reconciliation incomplete/, "the partial listing is disclosed");
  const settled = a.thread_dispositions as Array<Record<string, unknown>>;
  assert.deepEqual(settled.map((record) => record.reconciliation), ["unknown", "unknown"]);
});

test("#1645: without a reconciliation input the enforcement view stays authoritative (legacy)", () => {
  const a = artifact({ verdict: "approve", findings: [], thread_dispositions: [{ thread_id: "PRRT_stale1", disposition: "open", evidence: "still present at this head: the defect the thread points at is unchanged" }] });
  applyReviewThreadEnforcement(a, staleThreads.slice(0, 1), "strict");
  assert.equal(a.findings.length, 1, "legacy callers re-emit as before");
  assert.equal(a.thread_reconciliation, undefined, "no provenance is fabricated for a read that never ran");
  applyStrictVerdictPolicy(a, { modelVerdict: "approve", forced: false });
  assert.equal(a.verdict, "request_changes");
});

test("#1645: incomplete reconciliation is disclosed even when nothing changed", () => {
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [
      { thread_id: "PRRT_stale1", disposition: "open", evidence: "still present at this head: the defect the thread points at is unchanged" },
      { thread_id: "PRRT_stale2", disposition: "open", evidence: "still present at this head: the defect the thread points at is unchanged" },
    ],
  });
  const settlement = applyReviewThreadEnforcement(a, staleThreads, "strict", {
    available: false,
    unresolvedIds: new Set(),
    resolvedIds: new Set(),
    headSha: "e".repeat(40),
  });
  assert.equal(settlement.applied, false, "no settlement change is not a forcing action");
  assert.match(String(a.review_markdown), /reconciliation incomplete/, "the disclosure renders regardless");
  assert.equal(a.thread_reconciliation?.state, "incomplete");
});

test("#1645: a thread the live listing dropped is persisted withdrawn, never with a null disposition", () => {
  const a = artifact({ verdict: "approve", findings: [], thread_dispositions: [] });
  applyReviewThreadEnforcement(a, staleThreads, "strict", {
    available: true,
    unresolvedIds: new Set(),
    resolvedIds: new Set(["PRRT_stale1"]),
    headSha: "a".repeat(40),
  });
  const settled = a.thread_dispositions as Array<Record<string, unknown>>;
  assert.deepEqual(
    settled.map((record) => [record.thread_id, record.reconciliation, record.disposition]),
    [
      ["PRRT_stale1", "resolved", "withdrawn"],
      ["PRRT_stale2", "absent", "withdrawn"],
    ],
    "a dropped thread carries the terminal disposition and its reconciliation reason",
  );
  assert.ok(
    settled.every((record) => record.disposition !== null),
    "no dropped record reads back as 'no disposition given'",
  );
});

test("#1645: a dropped thread's stale record never supplies a disposition to a later settlement", () => {
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [
      { thread_id: "PRRT_stale1", reconciliation: "absent", disposition: "withdrawn", evidence: null },
      { thread_id: "PRRT_stale1", disposition: "open", evidence: "still present at this head: the defect the thread points at is unchanged" },
    ],
  });
  applyReviewThreadEnforcement(a, staleThreads.slice(0, 1), "strict", {
    available: true,
    unresolvedIds: new Set(["PRRT_stale1"]),
    resolvedIds: new Set(),
    headSha: "b".repeat(40),
  });
  const settled = a.thread_dispositions as Array<Record<string, unknown>>;
  assert.equal(settled[0]!.disposition, "open", "the stale withdrawn record supplied no disposition");
  assert.equal(settled[0]!.reconciliation, "live_unresolved");
  assert.equal(settled[0]!.enforced, undefined, "the fresh open disposition stands; the stale withdrawn record did not supply it");
  const reemitted = a.findings.filter((f) => f.thread_id === "PRRT_stale1");
  assert.equal(reemitted.length, 1, "the reappearing live thread is re-emitted");
  assert.match(String(reemitted[0]!.message), /\(review thread PRRT_stale1: open\)$/, "it re-emits as an open thread, not a withdrawn one");
});

test("#1645: a thread the listing still carries but cannot parse reconciles unknown, never absent", () => {
  const a = artifact({ verdict: "approve", findings: [], thread_dispositions: [] });
  applyReviewThreadEnforcement(a, staleThreads, "strict", {
    available: true,
    unresolvedIds: new Set(),
    resolvedIds: new Set(),
    unparsedIds: new Set(["PRRT_stale1"]),
    headSha: "1".repeat(40),
  });
  assert.equal(a.findings.length, 0, "an unparsable listed thread never re-emits (its live state is unproven)");
  assert.equal(a.thread_reconciliation?.absent, 1, "the genuinely absent sibling still proves absent");
  assert.equal(a.thread_reconciliation?.unknown, 1, "the carried-but-unparsable thread reconciles as unknown");
  assert.equal(a.thread_reconciliation?.live_unresolved, 0);
  // The transport read succeeded, but the carried thread set did not fully
  // reconcile: the persisted state must say incomplete, agreeing with the
  // disclosure (state and disclosure share one authority — counts.unknown).
  assert.equal(a.thread_reconciliation?.state, "incomplete", "an unresolved unknown makes the carried-set reconciliation incomplete even on a transport-complete listing");
  const settled = a.thread_dispositions as Array<Record<string, unknown>>;
  assert.equal(settled[0]!.reconciliation, "unknown", "the record carries the accurate unknown state");
  assert.equal(settled[0]!.disposition, "open", "its own disposition is not silently treated as settled truth");
  assert.equal(settled[1]!.reconciliation, "absent", "the proven-absent sibling keeps its proven state");
  assert.match(String(a.review_markdown), /reconciliation incomplete/, "the unverifiable state is disclosed");
});

test("#1645: a partial listing reconciles every carried thread unknown — only a complete listing proves a state", () => {
  // A globally partial listing (a capped window, a failed sub-read) proves NO
  // state at all (maintainer review 5885372900): a thread the partial listing
  // positively reports as live is not a proven live thread, and a thread it
  // reports as resolved is not a proven resolution — the enumeration does
  // not cover the whole set, so every carried thread is unverifiable.
  const live = artifact({ verdict: "approve", findings: [], thread_dispositions: [] });
  applyReviewThreadEnforcement(live, staleThreads.slice(0, 1), "strict", {
    available: true,
    unresolvedIds: new Set(["PRRT_stale1"]),
    resolvedIds: new Set(),
    headSha: "3".repeat(40),
    complete: false,
  });
  assert.equal(live.findings.length, 0, "a positively-reported thread is not proven live on a partial listing");
  assert.equal(live.thread_reconciliation?.state, "incomplete", "a partial listing never reconciles the carried set complete");
  assert.equal(live.thread_reconciliation?.unknown, 1);
  assert.match(String(live.review_markdown), /reconciliation incomplete/, "the partial listing is disclosed");

  const resolved = artifact({ verdict: "approve", findings: [], thread_dispositions: [] });
  applyReviewThreadEnforcement(resolved, staleThreads.slice(0, 1), "strict", {
    available: true,
    unresolvedIds: new Set(),
    resolvedIds: new Set(["PRRT_stale1"]),
    headSha: "4".repeat(40),
    complete: false,
  });
  assert.equal(resolved.findings.length, 0);
  assert.equal(resolved.thread_reconciliation?.state, "incomplete", "a positively-reported resolution is not a proven resolution");
  assert.equal(resolved.thread_reconciliation?.unknown, 1);
  assert.equal(resolved.thread_reconciliation?.resolved, 0);
  assert.match(String(resolved.review_markdown), /reconciliation incomplete/, "the partial listing is disclosed");
});

test("#1645: a listing that proves every carried thread's state owes no disclosure", () => {
  const a = artifact({ verdict: "approve", findings: [], thread_dispositions: [] });
  applyReviewThreadEnforcement(a, staleThreads, "strict", {
    available: true,
    unresolvedIds: new Set(),
    resolvedIds: new Set(["PRRT_stale1", "PRRT_stale2"]),
    headSha: "2".repeat(40),
  });
  assert.equal(a.thread_reconciliation?.state, "complete");
  assert.equal(a.thread_reconciliation?.unknown, 0);
  assert.doesNotMatch(String(a.review_markdown), /reconciliation incomplete/, "no unverifiable state remains, so nothing is disclosed");
  assert.equal(a.verdict, "approve");
});

// ---------------------------------------------------------------------------
// #1663: a live historical bot finding must be re-evaluated against the
// current head before its old blocking severity can force REQUEST_CHANGES.
// The model's disposition IS the re-evaluation (Reading A): `open` reaffirms,
// code-citing `fixed`/`disputed` settles it, and an omitted or unsupported
// answer is a MATERIAL unverified blocking claim (INCOMPLETE/COMMENT). Human
// threads are closed only by the forge's resolved state.
// ---------------------------------------------------------------------------

const EMPTY_DISPOSITION_PARTS: DispositionEvidenceParts = {
  completenessChecks: [],
  obligations: [],
  findings: [],
  toolCapabilityFailure: null,
  toolFloorUnmet: false,
  noEvidenceReason: null,
  partialCoverageStopReason: null,
  traceUnresolvedMaterial: false,
  traceUnmetClaimed: false,
  mechanicallyProvenUnmetRequirements: 0,
  ciConclusion: null,
  ciEvidenceContractActive: false,
};

const liveListing = (...ids: string[]) => ({
  available: true,
  unresolvedIds: new Set(ids),
  resolvedIds: new Set<string>(),
  headSha: "a".repeat(40),
});

const botMajor = (threadId: string, overrides: Partial<EnforcementThread> = {}): EnforcementThread => ({
  thread_id: threadId,
  path: "src/a.ts",
  line: 3,
  severity: "major",
  message: "old defect",
  category: "bug",
  own_finding: true,
  authorship: "action",
  replies: 0,
  ...overrides,
});

function finalKind(a: ReviewArtifact): string {
  const build = buildDispositionEvidence({
    ...EMPTY_DISPOSITION_PARTS,
    findings: a.findings,
    threadReconciliation: a.thread_reconciliation,
  });
  return computeFinalDisposition({
    reviewProduced: true,
    validVerdict: true,
    verdict: a.verdict,
    degraded: false,
    exactHead: true,
    publicationHeadBound: true,
    blockingFindingOpen: a.findings.some((item) => item.severity === "blocker" || item.severity === "major"),
    evidenceProviderBlocker: false,
    provenUnmetRequirement: false,
    verdictBearing: true,
    approvalScopeAllowed: true,
    evidence: build.evidence,
  }).kind;
}

test("#1663: live bot major with no current-head disposition => INCOMPLETE/COMMENT", () => {
  const a = artifact({ verdict: "approve", findings: [], thread_dispositions: [] });
  applyReviewThreadEnforcement(a, [botMajor("t")], "strict", liveListing("t"));
  assert.equal(a.findings.length, 0, "the old severity alone never manufactures a blocker");
  assert.equal(a.thread_reconciliation?.state, "incomplete");
  assert.equal(a.thread_reconciliation?.unreassessed, 1);
  assert.match(String(a.review_markdown), /no current-head re-evaluation/);
  const build = buildDispositionEvidence({ ...EMPTY_DISPOSITION_PARTS, findings: a.findings, threadReconciliation: a.thread_reconciliation });
  const disposition = computeFinalDisposition({
    reviewProduced: true, validVerdict: true, verdict: "approve", degraded: false,
    exactHead: true, publicationHeadBound: true, blockingFindingOpen: false,
    evidenceProviderBlocker: false, provenUnmetRequirement: false,
    verdictBearing: true, approvalScopeAllowed: true, evidence: build.evidence,
  });
  assert.equal(disposition.kind, "incomplete");
  assert.equal(disposition.nativeEvent, "COMMENT");
  assert.ok(disposition.materialUnknowns.some((entry) => entry.code === "unverified_blocking_claim"));
  assert.equal(finalKind(a), "incomplete");
});

test("#1663: live bot major re-affirmed `open` keeps its blocking severity", () => {
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [{ thread_id: "t", disposition: "open", evidence: "still present at this head: the defect the thread points at is unchanged" }],
  });
  applyReviewThreadEnforcement(a, [botMajor("t")], "strict", liveListing("t"));
  const reemitted = a.findings.find((item) => item.thread_id === "t");
  assert.equal(reemitted?.severity, "major");
  assert.equal(a.thread_reconciliation?.unreassessed, undefined);
  assert.equal(finalKind(a), "request_changes");
});

test("#1663: live bot major proven fixed with code evidence never re-blocks", () => {
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [{ thread_id: "t", disposition: "fixed", evidence: "the guard is gone; see src/a.ts:9" }],
  });
  applyReviewThreadEnforcement(a, [botMajor("t")], "strict", liveListing("t"));
  assert.equal(a.findings.some((item) => item.thread_id === "t"), false);
  assert.equal(a.thread_reconciliation?.unreassessed, undefined);
  assert.equal(finalKind(a), "approve");
});

test("#1663: live bot major proven invalid keeps the explanation and never re-blocks", () => {
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [{ thread_id: "t", disposition: "disputed", evidence: "src/a.ts:3 shows the old claim was wrong" }],
  });
  applyReviewThreadEnforcement(a, [botMajor("t")], "strict", liveListing("t"));
  assert.equal(a.findings.some((item) => item.thread_id === "t"), false);
  const record = (a.thread_dispositions as Array<Record<string, unknown>>)[0]!;
  assert.equal(record.disposition, "disputed");
  assert.equal(record.evidence, "src/a.ts:3 shows the old claim was wrong");
  assert.match(String(a.review_markdown), /`t`: disputed/, "the invalidity explanation stays visible");
  assert.equal(finalKind(a), "approve");
});

test("#1663: unsupported fixed or unexplained invalidity claims cannot certify clean", () => {
  for (const [disposition, evidence] of [["fixed", "trust me"], ["disputed", null], ["disputed", "   "]] as const) {
    const a = artifact({
      verdict: "approve",
      findings: [],
      thread_dispositions: [{ thread_id: "t", disposition, evidence }],
    });
    applyReviewThreadEnforcement(a, [botMajor("t")], "strict", liveListing("t"));
    assert.equal(a.findings.some((item) => item.thread_id === "t"), false, `unsupported ${disposition} never re-blocks`);
    assert.equal(a.thread_reconciliation?.unreassessed, 1, `unsupported ${disposition} stays a material unknown`);
    assert.equal(finalKind(a), "incomplete", `unsupported ${disposition} cannot certify a clean approval`);
  }
});

test("#1663: a reasoned (non-code-citing) invalidity claim settles an originally invalid concern", () => {
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [{
      thread_id: "t",
      disposition: "disputed",
      evidence: "the old finding misread the guard: it only defended the empty-input branch, which is unreachable here",
    }],
  });
  applyReviewThreadEnforcement(a, [botMajor("t")], "strict", liveListing("t"));
  assert.equal(a.findings.some((item) => item.thread_id === "t"), false);
  const record = (a.thread_dispositions as Array<Record<string, unknown>>)[0]!;
  assert.equal(record.disposition, "disputed", "the reasoned invalidity claim stands without a fabricated path:line");
  assert.equal(a.thread_reconciliation?.unreassessed, undefined);
  assert.equal(finalKind(a), "approve");
});

test("#1663: duplicate historical thread ids yield one current concern with full provenance", () => {
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [
      { thread_id: "t1", disposition: "open", evidence: "still present at this head: the defect the thread points at is unchanged" },
      { thread_id: "t2", disposition: "open", evidence: "still present at this head: the defect the thread points at is unchanged" },
    ],
  });
  applyReviewThreadEnforcement(a, [botMajor("t1"), botMajor("t2")], "strict", liveListing("t1", "t2"));
  const concerns = a.findings.filter((item) => item.thread_id);
  assert.equal(concerns.length, 1, "one underlying concern, one finding");
  assert.deepEqual(concerns[0]!.thread_ids, ["t1", "t2"], "every historical thread id remains traceable");
});

test("#1663: distinct defects on the same line stay distinct", () => {
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [
      { thread_id: "t1", disposition: "open", evidence: "still present at this head: the defect the thread points at is unchanged" },
      { thread_id: "t2", disposition: "open", evidence: "still present at this head: the defect the thread points at is unchanged" },
    ],
  });
  applyReviewThreadEnforcement(a, [
    botMajor("t1", { message: "the lock is released twice" }),
    botMajor("t2", { message: "the error path skips cleanup" }),
  ], "strict", liveListing("t1", "t2"));
  assert.equal(a.findings.filter((item) => item.thread_id).length, 2);
});

test("#1663: a fresh current-head major still requests changes regardless of historical settlement", () => {
  const a = artifact({
    verdict: "approve",
    findings: [{ severity: "major", category: "bug", file: "src/b.ts", line: 8, message: "fresh current-head defect" }],
    thread_dispositions: [{ thread_id: "t", disposition: "fixed", evidence: "src/a.ts:9" }],
  });
  applyReviewThreadEnforcement(a, [botMajor("t")], "strict", liveListing("t"));
  assert.equal(a.findings.filter((item) => item.thread_id).length, 0);
  assert.equal(finalKind(a), "request_changes");
});

test("#1681 round 5: a human thread proven fixed with code evidence is addressed, not re-emitted (#252 boundary)", () => {
  // The physical thread stays open (`liveListing` still reports it) because
  // the action must never mutate a human's conversation — but GitHub
  // `is_resolved` is not semantic authority over whether the defect exists.
  // Current-head, code-citing evidence settles the FINDING: no re-emission,
  // no obligation, nothing holding approval hostage; the open thread remains
  // disclosed in the provenance record and markdown.
  const human = botMajor("h", { severity: "minor", category: null, own_finding: false, authorship: "human", message: "Should this handle None?" });
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [{ thread_id: "h", disposition: "fixed", evidence: "src/a.ts:9 shows it is handled" }],
  });
  applyReviewThreadEnforcement(a, [human], "strict", liveListing("h"));
  const record = (a.thread_dispositions as Array<Record<string, unknown>>)[0]!;
  assert.equal(record.disposition, "fixed", "the settlement is recorded honestly");
  assert.match(String(record.enforced), /stays open on the forge — a bot disposition cannot close it/);
  assert.match(String(record.enforced), /not carried as a current finding/);
  assert.equal(a.findings.some((item) => item.thread_id === "h"), false, "no re-emitted finding for an addressed concern");
  assert.equal(a.thread_reconciliation?.unreassessed, undefined, "no unresolved semantic obligation");
  assert.match(String(a.review_markdown), /`h`: fixed/, "the physically open thread is still disclosed");
  assert.equal(finalKind(a), "approve", "an addressed human thread never blocks APPROVE");
});

test("#1681 round 5: an addressed human change request with several threads never resurfaces as current findings (the #1681 shape)", () => {
  // Three human findings from a prior REQUEST_CHANGES review, each proven
  // fixed at the current head, all GitHub conversations still open. Pinning
  // this so reviewer approval can never again require "PR gardening".
  const threads = ["h1", "h2", "h3"].map((id) =>
    botMajor(id, { severity: "blocker", category: "bug", own_finding: false, authorship: "human", message: `human concern ${id}` }));
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [
      { thread_id: "h1", disposition: "fixed", evidence: "src/a.ts:9 closes the first concern" },
      { thread_id: "h2", disposition: "fixed", evidence: "src/a.ts:21 fixes the second" },
      { thread_id: "h3", disposition: "fixed", evidence: "src/a.ts:33 resolves the third" },
    ],
  });
  applyReviewThreadEnforcement(a, threads, "strict", liveListing("h1", "h2", "h3"));
  assert.equal(a.findings.length, 0, "no addressed concern re-enters the current Findings set");
  for (const record of a.thread_dispositions as Array<Record<string, unknown>>) {
    assert.equal(record.disposition, "fixed");
    assert.equal(record.reconciliation, "live_unresolved", "the physical thread was live-open the whole time");
  }
  assert.equal(a.thread_reconciliation?.unreassessed, undefined);
  assert.equal(finalKind(a), "approve");
});

test("#1681 round 5: a human thread whose fix is NOT proven keeps the fail-closed reading", () => {
  // The other half of the split: an uncited `fixed`, a `withdrawn`, a
  // `disputed`, or no disposition at all does not establish the defect gone.
  // The thread keeps its historical open treatment — recorded open,
  // re-emitted at the human-side non-blocking severity — and only the
  // forge's resolved state closes it.
  for (const [disposition, evidence] of [
    ["fixed", "the author says it is fine now"],
    ["withdrawn", "closed per reply"],
    ["disputed", "closed per reply"],
  ] as const) {
    const a = artifact({
      verdict: "approve",
      findings: [],
      thread_dispositions: [{ thread_id: "h", disposition, evidence }],
    });
    applyReviewThreadEnforcement(a, [botMajor("h", { severity: "minor", category: null, own_finding: false, authorship: "human", message: "Should this handle None?" })], "strict", liveListing("h"));
    const record = (a.thread_dispositions as Array<Record<string, unknown>>)[0]!;
    assert.equal(record.disposition, "open", `${disposition}: an unproven claim cannot discharge a human thread`);
    assert.equal(record.enforced, "human-authored thread: a bot disposition cannot close it");
    assert.equal(a.findings.find((item) => item.thread_id === "h")?.severity, "minor");
  }
});

test("#1681 round 5: a human thread whose live state cannot be verified is disclosed, never silently declared fixed", () => {
  // Case C: the listing is unreadable, so neither closure nor continuation
  // can be proven. Existing #1645 semantics hold: nothing re-emits, nothing
  // blocks, the incompleteness is DISCLOSED — and the unproven claim is
  // recorded as `unknown` reconciliation, never dressed up as addressed.
  const a = artifact({ verdict: "approve", findings: [], thread_dispositions: [] });
  applyReviewThreadEnforcement(a, [botMajor("h", { severity: "minor", category: null, own_finding: false, authorship: "human", message: "Should this handle None?" })], "strict", { ...liveListing(), available: false });
  const record = (a.thread_dispositions as Array<Record<string, unknown>>)[0]!;
  assert.equal(record.reconciliation, "unknown");
  assert.equal(record.disposition, "open", "no disposition given: never auto-answered as fixed");
  assert.equal(a.findings.length, 0, "unverifiable live state never manufactures a current finding");
  assert.equal(a.thread_reconciliation?.unknown, 1);
  assert.match(String(a.review_markdown), /reconciliation incomplete/);
  assert.equal(finalKind(a), "approve", "and per #1645 it stays advisory, not a material veto");
});

test("#1663: unproven authorship neither closes nor re-blocks a carried marker finding", () => {
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [{ thread_id: "t", disposition: "fixed", evidence: "src/a.ts:9" }],
  });
  applyReviewThreadEnforcement(a, [botMajor("t", { authorship: "unproven" })], "strict", liveListing("t"));
  const record = (a.thread_dispositions as Array<Record<string, unknown>>)[0]!;
  assert.equal(record.disposition, "open", "an unproven root cannot be closed by a bot disposition");
  assert.equal(record.enforced, "authorship unproven: a bot disposition cannot close the thread");
  assert.equal(a.findings.some((item) => item.thread_id === "t"), false, "unproven authority never re-emits a blocking severity");
  assert.equal(a.thread_reconciliation?.unreassessed, 1, "the carried blocker stays a material unknown");
  assert.equal(finalKind(a), "incomplete", "clean approval cannot be certified on unproven authority");
});

test("#1663: unproven authorship withholds an explicit open re-affirmation's blocking severity", () => {
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [{ thread_id: "t", disposition: "open", evidence: "still present at this head: the defect the thread points at is unchanged" }],
  });
  applyReviewThreadEnforcement(a, [botMajor("t", { authorship: "unproven" })], "strict", liveListing("t"));
  const record = (a.thread_dispositions as Array<Record<string, unknown>>)[0]!;
  assert.equal(record.disposition, "open", "the re-affirmation is kept on the record");
  assert.equal(a.findings.some((item) => item.thread_id === "t"), false, "but unproven authority never re-emits the blocking severity");
  assert.equal(a.thread_reconciliation?.unreassessed, 1);
  assert.equal(finalKind(a), "incomplete");
});

test("#1663: a fresh current-head finding proves the concern, so it is not an unverified gap", () => {
  const a = artifact({
    verdict: "approve",
    findings: [{
      severity: "major",
      category: "bug",
      file: "src/a.ts",
      line: 3,
      message: "old defect",
    }],
    thread_dispositions: [],
  });
  applyReviewThreadEnforcement(a, [botMajor("t")], "strict", liveListing("t"));
  assert.equal(a.thread_reconciliation?.unreassessed, undefined, "the fresh finding is the current-head proof");
  assert.equal(finalKind(a), "request_changes", "and it blocks on its own authority");
});

test("#1663: the fresh-finding exemption is authorship-independent — it also covers an unproven row", () => {
  // Identity is keyed on the thread's historical severity, so a fresh
  // current-head finding proves the same concern under ANY provenance,
  // including ambiguous `unproven` (the review already re-evaluated it).
  const a = artifact({
    verdict: "approve",
    findings: [{
      severity: "major",
      category: "bug",
      file: "src/a.ts",
      line: 3,
      message: "old defect",
    }],
    thread_dispositions: [],
  });
  applyReviewThreadEnforcement(a, [botMajor("t", { authorship: "unproven" })], "strict", liveListing("t"));
  assert.equal(a.thread_reconciliation?.unreassessed, undefined, "the fresh finding closes the gap, not the marker");
  assert.equal(a.thread_reconciliation?.state, "complete");
  assert.equal(finalKind(a), "request_changes", "the fresh finding blocks on its own authority");
});

test("#1663: a blocking `open` re-affirmation WITHOUT a reason is unverified, not re-emitted", () => {
  for (const evidence of [null, "", "   "]) {
    const a = artifact({
      verdict: "approve",
      findings: [],
      thread_dispositions: [{ thread_id: "t", disposition: "open", evidence }],
    });
    applyReviewThreadEnforcement(a, [botMajor("t")], "strict", liveListing("t"));
    const record = (a.thread_dispositions as Array<Record<string, unknown>>)[0]!;
    assert.equal(record.disposition, "open", "the claim is kept on the record");
    assert.equal(record.enforced, "open without a current-head reason", `bare evidence ${JSON.stringify(evidence)}`);
    assert.equal(a.findings.some((item) => item.thread_id === "t"), false, "a bare `open` never re-emits the historical severity");
    assert.equal(a.thread_reconciliation?.unreassessed, 1, "the unsupported claim is the material unknown");
    assert.equal(finalKind(a), "incomplete", "neither a block nor a clean approval is certified");
  }
});

test("#1663: a rotated-identity bot finding settles on current-head evidence, bare or cited", () => {
  // A forge-proven automation author under another login keeps the full
  // bot contract: bare `open` withholds severity as the material unknown...
  const bare = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [{ thread_id: "t", disposition: "open", evidence: null }],
  });
  applyReviewThreadEnforcement(bare, [botMajor("t", { authorship: "other_bot" })], "strict", liveListing("t"));
  assert.equal((bare.thread_dispositions as Array<Record<string, unknown>>)[0]!.enforced, "open without a current-head reason");
  assert.equal(bare.findings.some((item) => item.thread_id === "t"), false);
  assert.equal(bare.thread_reconciliation?.unreassessed, 1);
  // ...a supported `open` re-affirms it at the historical severity...
  const affirmed = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [{ thread_id: "t", disposition: "open", evidence: "still present at this head: the defect the thread points at is unchanged" }],
  });
  applyReviewThreadEnforcement(affirmed, [botMajor("t", { authorship: "other_bot" })], "strict", liveListing("t"));
  assert.equal(affirmed.findings.find((item) => item.thread_id === "t")?.severity, "major",
    "the publisher mismatch never erases a supported current-head claim");
  assert.equal(finalKind(affirmed), "request_changes");
  // ...and a code-citing `fixed` CLOSES it: closure rides the current-head
  // evidence, not the author's login. This pins the deliberate reading that
  // an `other_bot` root is still inside the bot settlement contract.
  const fixed = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [{ thread_id: "t", disposition: "fixed", evidence: "src/a.ts:9 now guards the path" }],
  });
  applyReviewThreadEnforcement(fixed, [botMajor("t", { authorship: "other_bot" })], "strict", liveListing("t"));
  assert.equal(fixed.findings.some((item) => item.thread_id === "t"), false, "a cited fix settles the thread");
  assert.equal(fixed.thread_reconciliation?.unreassessed, undefined, "with no material unknown left");
  // A reasoned `disputed` settles it the same way.
  const disputed = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [{ thread_id: "t", disposition: "disputed", evidence: "the original finding assumed a lock the module never claims to hold" }],
  });
  applyReviewThreadEnforcement(disputed, [botMajor("t", { authorship: "other_bot" })], "strict", liveListing("t"));
  assert.equal(disputed.findings.some((item) => item.thread_id === "t"), false);
  assert.equal(disputed.thread_reconciliation?.unreassessed, undefined);
});

test("#1663: the settlement pass itself caps a hand-supplied blocking human/unproven row", () => {
  // `enforcementView` never emits a blocking human/unproven severity; the
  // cap makes the invariant local to this pass, so a synthesized row
  // cannot smuggle blocking authority through the settlement boundary.
  const human = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [{ thread_id: "h", disposition: "open", evidence: "still present at this head: the question is unanswered" }],
  });
  applyReviewThreadEnforcement(human, [botMajor("h", { authorship: "human", severity: "blocker", own_finding: false, message: "Should this handle None?" })], "strict", liveListing("h"));
  assert.equal(human.findings.find((item) => item.thread_id === "h")?.severity, "minor",
    "a human root never carries blocking authority, whatever the row claims");
  const unproven = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [{ thread_id: "u", disposition: "open", evidence: "still present at this head" }],
  });
  applyReviewThreadEnforcement(unproven, [botMajor("u", { authorship: "unproven", severity: "major", own_finding: false, category: null })], "strict", liveListing("u"));
  assert.equal(unproven.findings.find((item) => item.thread_id === "u")?.severity, "minor",
    "and neither does an unproven one");
  assert.equal(unproven.thread_reconciliation?.unreassessed, undefined, "a marker-less unproven row is no blocking claim of ours");
});

test("#1663: an unreadable listing keeps #1654's advisory-only unknown semantics", () => {
  const a = artifact({ verdict: "approve", findings: [], thread_dispositions: [] });
  applyReviewThreadEnforcement(a, [botMajor("t")], "strict", { ...liveListing(), available: false });
  assert.equal(a.findings.length, 0);
  assert.equal(a.thread_reconciliation?.unknown, 1);
  assert.equal(a.thread_reconciliation?.unreassessed, undefined, "unreadable live state is not a semantic re-evaluation gap");
  assert.equal(finalKind(a), "approve", "unknown live state remains advisory, never a material veto");
});

// ---------------------------------------------------------------------------
// #812: the publish path records the folded external-CI conclusion in the
// managed marker so the next diff-unchanged skip can compare it.
// ---------------------------------------------------------------------------

test("#812: publish ciState reaches the marker; omitted when not read", () => {
  const withCi = buildRunMetadataMarker({ headSha: "h", baseSha: "b", reviewResult: "issues", ciState: "failure" });
  assert.match(withCi, /"ci_state":"failure"/);
  assert.ok(withCi.endsWith('"ci_state":"failure"} -->'), "ci_state is the trailing field");
  const without = buildRunMetadataMarker({ headSha: "h", baseSha: "b", reviewResult: "issues" });
  assert.ok(!without.includes("ci_state"), "markers without a CI read stay byte-identical to pre-#812");
});

// ---------------------------------------------------------------------------
// #1248: relax-then-force provenance and body honesty.
// ---------------------------------------------------------------------------

const GATED_RELAX_NOTE = "\n\n_Verdict relaxed from structured findings "
  + "(verdict_policy=findings_severity_gated): every blocking finding was in a "
  + "category this repository marks non-blocking (non_blocking_finding_categories); "
  + "they remain listed above._";

test("#1248: enforcement overlays update verdict_source when forcing back a relaxed verdict", () => {
  const relaxed: ReviewArtifact = {
    verdict: "request_changes",
    review_markdown: "review" + GATED_RELAX_NOTE,
    findings: [finding("blocker", "tests")],
  };
  applyVerdictPolicy(relaxed, "findings_severity_gated", {
    nonBlockingCategories: parseNonBlockingCategories("tests"),
    securityFlagged: false,
  });
  assert.equal(relaxed.verdict, "approve");
  assert.equal(relaxed.verdict_source, "findings");

  const outcome = applyEvidenceBlockerEnforcement(relaxed, {
    has_blocker: true,
    providers: [{ id: "sec", provider_severity: "blocker" }],
  });
  assert.equal(outcome.applied, true);
  assert.equal(relaxed.verdict, "request_changes");
  assert.equal(relaxed.verdict_source, "enforcement", "the forcing layer owns the verdict, not the earlier relaxation");
  assert.ok(
    relaxed.review_markdown.includes("_Verdict relaxation superseded by enforcement: originally relaxed from structured findings"),
    `stale relaxed-verdict claim survives: ${relaxed.review_markdown}`,
  );
  assert.ok(!relaxed.review_markdown.includes("_Verdict relaxed from structured findings"), "the original claim must not stand unqualified");
});

test("#1248: required-check fail mode updates verdict_source when forcing back a relaxed verdict", () => {
  const relaxed: ReviewArtifact = {
    verdict: "request_changes",
    review_markdown: "review" + GATED_RELAX_NOTE,
    findings: [finding("blocker", "tests")],
    required_check_dispositions: [],
  };
  applyVerdictPolicy(relaxed, "findings_severity_gated", {
    nonBlockingCategories: parseNonBlockingCategories("tests"),
    securityFlagged: false,
  });
  assert.equal(relaxed.verdict, "approve");
  assert.equal(relaxed.verdict_source, "findings");

  const result = applyRequiredCheckValidation(relaxed, {
    enabled: "true",
    mode: "fail",
    // An OBJECTIVE must_check row (a concrete identity the gate binds): only
    // objective rows are merge-affecting under #1657, and this one has no
    // disposition, so the fail mode still forces and the #1248 provenance
    // flip fires. A generic review-prompt row would no longer gate.
    mustCheck: ["review the path resolution in src/paths.ts"],
  });
  assert.equal(result.status, "incomplete");
  assert.equal(relaxed.verdict, "request_changes");
  assert.equal(relaxed.verdict_source, "enforcement");
  assert.ok(
    relaxed.review_markdown.includes("_Verdict relaxation superseded by enforcement: originally relaxed from structured findings"),
    `stale relaxed-verdict claim survives: ${relaxed.review_markdown}`,
  );
});

test("#1248: forcing a verdict that was already request_changes keeps its provenance and untouched markdown", () => {
  const blocked: ReviewArtifact = {
    verdict: "request_changes",
    review_markdown: "review",
    findings: [finding("blocker")],
    verdict_source: "findings",
  };
  applyEvidenceBlockerEnforcement(blocked, { has_blocker: true, providers: [{ id: "sec", provider_severity: "blocker" }] });
  assert.equal(blocked.verdict_source, "findings", "no flip means no provenance rewrite");
  assert.ok(!blocked.review_markdown.includes("superseded"), "nothing to supersede without a relaxation note");
});

test("#1248: a findings_severity_gated thread-escalation flip supersedes the prior relaxation note", () => {
  const a = artifact({
    verdict: "approve",
    verdict_source: "findings",
    review_markdown: "review" + GATED_RELAX_NOTE,
    thread_dispositions: [{ thread_id: "t", disposition: "open", evidence: "still present at this head: the defect the thread points at is unchanged" }],
  });
  applyReviewThreadEnforcement(a, [
    { thread_id: "t", path: "a.py", line: 3, severity: "blocker", message: "issue", own_finding: false, replies: 0 },
  ], "findings_severity_gated");
  assert.equal(a.verdict, "request_changes");
  assert.equal(a.verdict_source, "findings", "thread settlement provenance stays findings");
  assert.ok(a.review_markdown.includes("_Verdict relaxation superseded by enforcement: originally relaxed from structured findings"));
  assert.ok(!a.review_markdown.includes("_Verdict relaxed from"), "the stale relaxed-verdict claim must not stand unqualified");
});

const VERIFICATION_RELAX_NOTE = "\n\n_Verdict relaxed from structured findings (#977): every open finding is a verification request the review tools cannot check, so the author has nothing to change. The findings remain listed above._";
const CI_ONLY_RELAX_NOTE = "\n\n_Verdict relaxed from CI-only findings (#976): check conclusions are shown for context and gate the merge independently; they are not review blockers._";
const REFUTED_GROUNDING_RELAX_NOTE = "\n\n_Verdict relaxed from structured findings (#1016): every open finding was either a verification request or a source claim the deterministic blocker-verification boundary positively refuted against exact-head source; the findings remain listed above and deterministic gates are unaffected._";

test("#1248: relaxation-note constants match their pinned note bytes", () => {
  assert.equal(GATED_FINDINGS_RELAXATION_NOTE, GATED_RELAX_NOTE.slice(2));
  assert.equal(VERIFICATION_ONLY_RELAXATION_NOTE, VERIFICATION_RELAX_NOTE.slice(2));
  assert.equal(CI_ONLY_RELAXATION_NOTE, CI_ONLY_RELAX_NOTE.slice(2));
  assert.equal(REFUTED_GROUNDING_RELAXATION_NOTE, REFUTED_GROUNDING_RELAX_NOTE.slice(2));
});

test("#1248: every action-authored relaxation note is superseded on a flip", () => {
  for (const note of [GATED_RELAX_NOTE, VERIFICATION_RELAX_NOTE, CI_ONLY_RELAX_NOTE, REFUTED_GROUNDING_RELAX_NOTE]) {
    const a = artifact({ verdict: "approve", verdict_source: "findings", review_markdown: "review" + note });
    applyEvidenceBlockerEnforcement(a, { has_blocker: true, providers: [{ id: "sec", provider_severity: "blocker" }] });
    assert.ok(
      a.review_markdown.includes("_Verdict relaxation superseded by enforcement: originally relaxed from"),
      `note not superseded: ${a.review_markdown}`,
    );
    assert.ok(!a.review_markdown.includes(note.slice(2)), "the original claim must not stand unqualified");
    const once = a.review_markdown;
    markRelaxationNotesSuperseded(a);
    assert.equal(a.review_markdown, once, "supersede is idempotent");
  }
});

test("#1248: supersede rewrites only the exact action-authored note lines (#252 boundary)", () => {
  const opener = "_Verdict relaxed from structured findings";
  // Hostile boundary token itself: line-initial model prose that imitates the
  // note opener (with and without the discriminator) but is not the action's
  // full note must survive byte-identical.
  const hostileLines = [
    `${opener} at the start of a model-authored line._`,
    `${opener} (verdict_policy=findings_severity_gated): model prose that stops early._`,
    "_Verdict relaxed from CI-only findings at the start of another line._",
    GATED_RELAX_NOTE.slice(2).replace("they remain listed above._", "quoted with a changed ending._"),
  ];
  const midLine = artifact({
    verdict: "approve",
    review_markdown: [
      `review — the model quoted: ${opener} (verdict_policy=findings_severity_gated): copied verbatim inline._`,
      ...hostileLines,
    ].join("\n"),
  });
  applyEvidenceBlockerEnforcement(midLine, { has_blocker: true, providers: [{ id: "sec", provider_severity: "blocker" }] });
  assert.ok(
    midLine.review_markdown.includes(`${opener} (verdict_policy=findings_severity_gated): copied verbatim inline.`),
    "a mid-line mention is not a note opener and stays byte-identical",
  );
  for (const line of hostileLines) {
    assert.ok(midLine.review_markdown.includes(line), `line-initial model prose was rewritten: ${line}`);
  }
  assert.ok(!midLine.review_markdown.includes("superseded"), "nothing to supersede in imitation prose");
});

// ---------------------------------------------------------------------------
// #1681 r6: the settlement channels consume the ONE citation grammar AND the
// engine's exact-head grounding. A `fixed`/`addressed` claim settles only on
// a cited location that RESOLVES at the reviewed head; a fake path or an
// out-of-range line proves nothing. A historical BOT `fixed` additionally
// settles on this run's head-bound acquisition of the thread's file when the
// evidence names no citation candidate (PhAd convergence) — never when an
// attempted citation resolves nowhere.
// ---------------------------------------------------------------------------

/** Grounding over a synthetic head: `src/a.ts` has 100 lines and nothing
 * else exists; `acquired` lists the files this run read at head-bound. */
function headGrounding(acquired?: readonly string[]): {
  resolveLocation: (file: string, line: number) => boolean;
  acquiredPaths: ReadonlySet<string>;
} {
  return {
    resolveLocation: (file, line) => file === "src/a.ts" && line >= 1 && line <= 100,
    acquiredPaths: new Set(acquired ?? []),
  };
}

test("#1681 r6: a human `fixed` settles only on a citation that resolves at head", () => {
  const human = botMajor("h", { severity: "minor", category: null, own_finding: false, authorship: "human", message: "Should this handle None?" });
  const cases: Array<[string, string]> = [
    ["src/a.ts:9 shows the guard now", "fixed"],
    ["src/a.ts:+10-12:1 the anchor from the diff resolves", "fixed"],
    ["src/does-not-exist.ts:999999 fixed it", "open"],
    ["src/a.ts:999999 fixed it", "open"],
    ["fixed now, trust me", "open"],
  ];
  for (const [evidence, expected] of cases) {
    const a = artifact({
      verdict: "approve",
      findings: [],
      thread_dispositions: [{ thread_id: "h", disposition: "fixed", evidence }],
    });
    applyReviewThreadEnforcement(a, [human], "strict", liveListing("h"), headGrounding(["src/a.ts"]));
    const record = (a.thread_dispositions as Array<Record<string, unknown>>)[0]!;
    assert.equal(record.disposition, expected, evidence);
    if (expected === "fixed") {
      assert.equal(a.findings.some((item) => item.thread_id === "h"), false);
      assert.equal(a.thread_reconciliation?.unreassessed, undefined);
    } else {
      const carried = a.findings.find((item) => item.thread_id === "h");
      assert.equal(carried?.severity, "minor", "the unproven concern keeps the human-side severity");
    }
  }
});

test("#1681 r6: a historical bot blocker reassessed on head-acquired content is not unverified", () => {
  // The PhAd shape: the review read the relevant file at this head and
  // concluded the boundary is correct, without restating a `path:line`
  // citation in the disposition field. That is a genuine re-evaluation.
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [{
      thread_id: "t",
      disposition: "fixed",
      evidence: "I re-read the ledger rendering at this head: hostile derived text now rides the inline code escape before the closing instruction, so the injection boundary holds",
    }],
  });
  applyReviewThreadEnforcement(a, [botMajor("t")], "strict", liveListing("t"), headGrounding(["src/a.ts"]));
  const record = (a.thread_dispositions as Array<Record<string, unknown>>)[0]!;
  assert.equal(record.disposition, "fixed", "the semantic judgment stands on the run's own head-bound acquisition");
  assert.equal(a.findings.some((item) => item.thread_id === "t"), false, "no re-emitted finding");
  assert.equal(a.thread_reconciliation?.unreassessed, undefined, "NOT an unverified_blocking_claim");
  assert.equal(a.thread_reconciliation?.state, "complete");
  assert.equal(finalKind(a), "approve", "the reassessed blocker cannot withhold approval");
});

test("#1681 r6: the inverse holds — no acquisition and no citation fails closed as unverified", () => {
  for (const evidence of [
    "the boundary looks correct to me",
    "see src/does-not-exist.ts:999999",
  ]) {
    const a = artifact({
      verdict: "approve",
      findings: [],
      thread_dispositions: [{ thread_id: "t", disposition: "fixed", evidence }],
    });
    applyReviewThreadEnforcement(a, [botMajor("t")], "strict", liveListing("t"), headGrounding());
    const record = (a.thread_dispositions as Array<Record<string, unknown>>)[0]!;
    assert.equal(record.disposition, "open", evidence);
    assert.equal(a.thread_reconciliation?.unreassessed, 1, `${evidence}: a genuinely unreassessed blocker stays material`);
    assert.equal(finalKind(a), "incomplete");
  }
});

test("#1681 r6: a human change request `addressed` requires a resolving citation", () => {
  const review = { review_id: "5931073237", login: "joryirving", commit_id: "a".repeat(40), head_moved: false, submitted_at: null };
  const run = (evidence: string): ReviewArtifact => {
    const a = artifact({ verdict: "approve", human_review_dispositions: [{ review_id: "5931073237", disposition: "addressed", evidence }] });
    applyHumanReviewEnforcement(a, [review], headGrounding());
    return a;
  };
  const settled = (a: ReviewArtifact): string => (a.human_review_dispositions as Array<{ disposition: string }>)[0]!.disposition;
  assert.equal(settled(run("all three concerns are closed; src/a.ts:+60-70:2 covers the seam")), "addressed");
  assert.equal(settled(run("src/does-not-exist.ts:1 closes it")), "not_addressed", "a fake path cannot discharge the request");
  assert.equal(settled(run("src/a.ts:999999 closes it")), "not_addressed", "an out-of-range line cannot either");
  assert.equal(settled(run("the prose says it is addressed")), "not_addressed");
});

// ---------------------------------------------------------------------------
// #1681 r6: ONE current-head answer for an outstanding human change request.
// The settled human-thread concern states are the authority; the duplicate
// `human_review_dispositions` claim may never contradict them, and physical
// conversation state never gates.
// ---------------------------------------------------------------------------

test("#1681 r6: the human change request aggregates the settled thread concerns — addressed", () => {
  const threads = ["h1", "h2", "h3"].map((id) =>
    botMajor(id, {
      severity: "blocker",
      category: "bug",
      own_finding: false,
      authorship: "human",
      message: `human concern ${id}`,
      parent_review_id: "5931073237",
    }));
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [
      { thread_id: "h1", disposition: "fixed", evidence: "src/a.ts:9 closes the first concern" },
      { thread_id: "h2", disposition: "fixed", evidence: "src/a.ts:21 fixes the second" },
      { thread_id: "h3", disposition: "fixed", evidence: "src/a.ts:33 resolves the third" },
    ],
    // The model's DUPLICATE answer contradicts its own thread work: the
    // settled concerns are authoritative, the duplicate never wins.
    human_review_dispositions: [{ review_id: "5931073237", disposition: "not_addressed", evidence: "leftover prose" }],
  });
  applyReviewThreadEnforcement(a, threads, "strict", liveListing("h1", "h2", "h3"), headGrounding(["src/a.ts"]));
  applyHumanReviewEnforcement(a, [
    { review_id: "5931073237", login: "joryirving", commit_id: "a".repeat(40), head_moved: false, submitted_at: null },
  ], headGrounding(["src/a.ts"]));
  const record = (a.human_review_dispositions as Array<Record<string, unknown>>)[0]!;
  assert.equal(record.disposition, "addressed", "every settled concern addressed → the request is addressed");
  assert.equal(record.basis, "thread-settlement", "the answer rides the settled concerns, not the duplicate claim");
  const settledThreads = a.thread_dispositions as Array<Record<string, unknown>>;
  assert.equal(settledThreads[0]!.parent_review_id, "5931073237", "the forge-proven owner rides the settled record");
  const markdown = String(a.review_markdown);
  assert.ok(markdown.includes("judged addressed at this head"));
  assert.ok(!markdown.includes("not shown addressed"), "one answer — never addressed AND not-addressed");
  assert.ok(!markdown.includes("needs the reviewer's own re-review"));
});

test("#1681 r6: a still-present human concern makes the change request not addressed", () => {
  const threads = ["h1", "h2", "h3"].map((id) =>
    botMajor(id, {
      severity: "major",
      category: "bug",
      own_finding: false,
      authorship: "human",
      message: `human concern ${id}`,
      parent_review_id: "r1",
    }));
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [
      { thread_id: "h1", disposition: "fixed", evidence: "src/a.ts:9 closes the first concern" },
      { thread_id: "h2", disposition: "fixed", evidence: "src/a.ts:21 fixes the second" },
      { thread_id: "h3", disposition: "open", evidence: "still present at this head: the guard is missing exactly as the thread says" },
    ],
  });
  applyReviewThreadEnforcement(a, threads, "strict", liveListing("h1", "h2", "h3"), headGrounding(["src/a.ts"]));
  applyHumanReviewEnforcement(a, [
    { review_id: "r1", login: "bob", commit_id: "a".repeat(40), head_moved: false, submitted_at: null },
  ], headGrounding(["src/a.ts"]));
  const record = (a.human_review_dispositions as Array<Record<string, unknown>>)[0]!;
  assert.equal(record.disposition, "not_addressed", "a proven-present concern dominates the fixed ones");
  assert.equal(record.basis, "thread-settlement");
});

test("#1681 r6: a genuinely un-reassessed concern yields unresolved, never a collapsed addressed", () => {
  const threads = ["h1", "h2", "h3"].map((id) =>
    botMajor(id, {
      severity: "major",
      category: "bug",
      own_finding: false,
      authorship: "human",
      message: `human concern ${id}`,
      parent_review_id: "r1",
    }));
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [
      { thread_id: "h1", disposition: "fixed", evidence: "src/a.ts:9 closes the first concern" },
      { thread_id: "h2", disposition: "fixed", evidence: "src/a.ts:21 fixes the second" },
      // h3: no disposition given — genuinely not reassessed.
    ],
    human_review_dispositions: [{ review_id: "r1", disposition: "addressed", evidence: "src/a.ts:1" }],
  });
  applyReviewThreadEnforcement(a, threads, "strict", liveListing("h1", "h2", "h3"), headGrounding(["src/a.ts"]));
  applyHumanReviewEnforcement(a, [
    { review_id: "r1", login: "bob", commit_id: "a".repeat(40), head_moved: false, submitted_at: null },
  ], headGrounding(["src/a.ts"]));
  const record = (a.human_review_dispositions as Array<Record<string, unknown>>)[0]!;
  assert.equal(record.disposition, "unresolved", "the model's optimistic duplicate cannot collapse a real unknown");
  assert.match(String(a.review_markdown), /is unresolved at this head/);
  assert.ok(!String(a.review_markdown).includes("judged addressed"));
});

test("#1681 r6: with no settled human threads the model claim remains the answer", () => {
  const a = artifact({
    verdict: "approve",
    thread_dispositions: [],
    human_review_dispositions: [{ review_id: "r1", disposition: "addressed", evidence: "src/a.ts:1" }],
  });
  applyHumanReviewEnforcement(a, [
    { review_id: "r1", login: "bob", commit_id: "a".repeat(40), head_moved: false, submitted_at: null },
  ], headGrounding(["src/a.ts"]));
  const record = (a.human_review_dispositions as Array<Record<string, unknown>>)[0]!;
  assert.equal(record.disposition, "addressed");
  assert.equal(record.basis, "model-claim", "no concerns settled ⇒ nothing to aggregate, the claim stands");
});

// ---------------------------------------------------------------------------
// #1681 r7: the human change-request aggregation is PER REVIEW. Ownership
// rides the forge-proven parent review id only — never login, timing, text
// or thread path — so two outstanding change requests can settle
// differently, and a body-only request keeps its own grounded claim.
// ---------------------------------------------------------------------------

test("#1681 r7: two human reviews settle independently — A addressed, B not addressed", () => {
  const owned = (id: string, review: string) =>
    botMajor(id, {
      severity: "major",
      category: "bug",
      own_finding: false,
      authorship: "human",
      message: `human concern ${id}`,
      parent_review_id: review,
    });
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [
      { thread_id: "a1", disposition: "fixed", evidence: "src/a.ts:9 closes it" },
      { thread_id: "a2", disposition: "fixed", evidence: "src/a.ts:21 closes it too" },
      { thread_id: "b1", disposition: "open", evidence: "still present at this head: the guard is missing exactly as the thread says" },
    ],
  });
  applyReviewThreadEnforcement(a, [owned("a1", "revA"), owned("a2", "revA"), owned("b1", "revB")], "strict",
    liveListing("a1", "a2", "b1"), headGrounding(["src/a.ts"]));
  applyHumanReviewEnforcement(a, [
    { review_id: "revA", login: "carol", commit_id: "a".repeat(40), head_moved: false, submitted_at: null },
    { review_id: "revB", login: "bob", commit_id: "a".repeat(40), head_moved: false, submitted_at: null },
  ], headGrounding(["src/a.ts"]));
  const settled = new Map((a.human_review_dispositions as Array<Record<string, unknown>>).map((r) => [String(r.review_id), r]));
  assert.equal(settled.get("revA")!.disposition, "addressed", "A's own threads are all fixed — B's defect must not drag it down");
  assert.equal(settled.get("revB")!.disposition, "not_addressed", "B's proven-present concern settles B, not A");
  assert.equal(settled.get("revA")!.basis, "thread-settlement");
  assert.equal(settled.get("revB")!.basis, "thread-settlement");
});

test("#1681 r7: a body-only human review keeps its grounded model claim; A keeps its threads", () => {
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [
      { thread_id: "a1", disposition: "fixed", evidence: "src/a.ts:9 closes it" },
    ],
    human_review_dispositions: [
      { review_id: "revB", disposition: "not_addressed", evidence: "the body-only complaint still stands; src/a.ts:40 proves nothing here" },
    ],
  });
  applyReviewThreadEnforcement(a, [
    botMajor("a1", { severity: "major", category: "bug", own_finding: false, authorship: "human", message: "A's concern", parent_review_id: "revA" }),
  ], "strict", liveListing("a1"), headGrounding(["src/a.ts"]));
  applyHumanReviewEnforcement(a, [
    { review_id: "revA", login: "carol", commit_id: "a".repeat(40), head_moved: false, submitted_at: null },
    { review_id: "revB", login: "bob", commit_id: "a".repeat(40), head_moved: false, submitted_at: null },
  ], headGrounding(["src/a.ts"]));
  const settled = new Map((a.human_review_dispositions as Array<Record<string, unknown>>).map((r) => [String(r.review_id), r]));
  assert.equal(settled.get("revA")!.disposition, "addressed");
  assert.equal(settled.get("revA")!.basis, "thread-settlement");
  assert.equal(settled.get("revB")!.disposition, "not_addressed", "A's fixed thread may never overwrite B's own claim");
  assert.equal(settled.get("revB")!.basis, "model-claim", "no attributable thread ⇒ the grounded claim stands");
});

test("#1681 r7: unknown parent-review identity is never guessed onto a review", () => {
  // A forge (Forgejo/Gitea, or a GitHub read without the parent field)
  // provides no ownership link. The settled concern stays unassociated: no
  // outstanding review is overridden by it, and the model claims stand.
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [
      { thread_id: "u1", disposition: "fixed", evidence: "src/a.ts:9 closes it" },
    ],
    human_review_dispositions: [
      { review_id: "revA", disposition: "not_addressed", evidence: "unrelated prose src/a.ts:40" },
    ],
  });
  applyReviewThreadEnforcement(a, [
    botMajor("u1", { severity: "major", category: "bug", own_finding: false, authorship: "human", message: "unowned concern" }),
  ], "strict", liveListing("u1"), headGrounding(["src/a.ts"]));
  applyHumanReviewEnforcement(a, [
    { review_id: "revA", login: "bob", commit_id: "a".repeat(40), head_moved: false, submitted_at: null },
  ], headGrounding(["src/a.ts"]));
  const settledThread = (a.thread_dispositions as Array<Record<string, unknown>>)[0]!;
  assert.ok(!("parent_review_id" in settledThread), "no forge link ⇒ nothing is stamped, nothing is guessed");
  const settled = (a.human_review_dispositions as Array<Record<string, unknown>>)[0]!;
  assert.equal(settled.disposition, "not_addressed", "the unassociated thread never becomes somebody's answer");
  assert.equal(settled.basis, "model-claim");
});

test("#1681 r7: per-review unknown is not dragged by another review's fixed threads", () => {
  const owned = (id: string, review: string) =>
    botMajor(id, {
      severity: "major",
      category: "bug",
      own_finding: false,
      authorship: "human",
      message: `human concern ${id}`,
      parent_review_id: review,
    });
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [
      { thread_id: "a1", disposition: "fixed", evidence: "src/a.ts:9 closes it" },
      // a2: genuinely never reassessed.
      { thread_id: "b1", disposition: "fixed", evidence: "src/a.ts:21 closes it" },
      { thread_id: "b2", disposition: "fixed", evidence: "src/a.ts:33 closes it" },
    ],
    // An optimistic global claim may not collapse A's real unknown.
    human_review_dispositions: [{ review_id: "revA", disposition: "addressed", evidence: "src/a.ts:1" }],
  });
  applyReviewThreadEnforcement(a, [owned("a1", "revA"), owned("a2", "revA"), owned("b1", "revB"), owned("b2", "revB")], "strict",
    liveListing("a1", "a2", "b1", "b2"), headGrounding(["src/a.ts"]));
  applyHumanReviewEnforcement(a, [
    { review_id: "revA", login: "carol", commit_id: "a".repeat(40), head_moved: false, submitted_at: null },
    { review_id: "revB", login: "bob", commit_id: "a".repeat(40), head_moved: false, submitted_at: null },
  ], headGrounding(["src/a.ts"]));
  const settled = new Map((a.human_review_dispositions as Array<Record<string, unknown>>).map((r) => [String(r.review_id), r]));
  assert.equal(settled.get("revA")!.disposition, "unresolved", "one un-reassessed own concern keeps A unresolved");
  assert.equal(settled.get("revB")!.disposition, "addressed", "B's own threads are all settled — A's gap must not drag it down");
});

test("#1681 r7: a disclosure note is not a downgrade — proven-addressed human threads settle without downgraded telemetry", () => {
  // The proven-addressed human branch keeps the model's `fixed` and stamps
  // a DISCLOSURE note; the settlement must not bill it as a disposition
  // downgrade, while the physical-open disclosure still renders.
  const threads = ["h1", "h2"].map((id) =>
    botMajor(id, {
      severity: "minor",
      category: null,
      own_finding: false,
      authorship: "human",
      message: `human concern ${id}`,
      parent_review_id: "revA",
    }));
  const a = artifact({
    verdict: "approve",
    findings: [],
    thread_dispositions: [
      { thread_id: "h1", disposition: "fixed", evidence: "src/a.ts:9 closes it" },
      { thread_id: "h2", disposition: "fixed", evidence: "src/a.ts:21 closes it" },
    ],
  });
  const settlement = applyReviewThreadEnforcement(a, threads, "strict", liveListing("h1", "h2"), headGrounding(["src/a.ts"]));
  assert.equal(settlement.applied, true, "the disclosure section still renders");
  assert.ok(settlement.reason.startsWith("review threads: 0 disposition(s) downgraded"), `no downgrade billed: ${settlement.reason}`);
  assert.match(String(a.review_markdown), /human-authored thread stays open on the forge/);
  const settled = a.thread_dispositions as Array<Record<string, unknown>>;
  assert.equal(settled.length, 2);
  assert.ok(settled.every((record) => record.disposition === "fixed" && typeof record.enforced === "string"));
});
