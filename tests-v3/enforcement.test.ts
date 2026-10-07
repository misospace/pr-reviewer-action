import test from "node:test";
import assert from "node:assert/strict";
import type { ParsedReviewVerdict } from "../src/model/types.js";
import { reviewArtifactFromParsed, type ReviewArtifact } from "../src/enforcement/artifact.js";
import { applyVerdictPolicy, applyStrictVerdictPolicy, capCiOnlyFindings, parseNonBlockingCategories, relaxCiOnlyVerdict, securityRiskFlagged } from "../src/enforcement/verdict-policy.js";
import { capCiEvidenceFindings, parseCiCheckNames } from "../src/enforcement/ci-evidence.js";
import { enforcementView, prepareThreads, renderReviewThreads } from "../src/context/review-threads.js";
import { applyRequiredCheckValidation, CHECK_CONCEPTS, validateReview } from "../src/enforcement/completeness.js";
import { applyReviewThreadEnforcement, evidenceCitesCode } from "../src/enforcement/threads.js";
import { applyHumanReviewEnforcement, inlineCode } from "../src/enforcement/human-reviews.js";
import {
  applyAllEnforcement,
  applyEvidenceBlockerEnforcement,
  applyToolHarnessFailureEnforcement,
  applyToolMinSuccessfulEnforcement,
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
    smartReviewRequested: false, smartReviewReason: null, extra: {}, ...overrides,
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

test("required-check structured key absent or unusable is unresolved; legacy keyword oracle remains available", () => {
  for (const a of [artifact(), artifact({ required_check_dispositions: "bad" })]) {
    const result = applyRequiredCheckValidation(a, { enabled: "true", mode: "metadata_only", mustCheck: ["run full test suite after upgrade"] });
    assert.equal(result.status, "incomplete");
    assert.equal((result.result.checks as any[])[0].reason, "no-structured-dispositions");
  }
  for (const [concept, keywords] of Object.entries(CHECK_CONCEPTS)) {
    assert.equal(validateReview([concept], keywords.join(" / ")).validated, true, concept);
  }
  assert.equal(validateReview(["audit repository configuration carefully"], "repository configuration was checked").validated, true);
});

test("thread settlement handles no rows, missing/fixed evidence, and retained valid dispositions", () => {
  assert.deepEqual(applyReviewThreadEnforcement(artifact(), [], "model"), { applied: false, reason: "" });
  const a = artifact({ thread_dispositions: [{ thread_id: "bad", disposition: "fixed", evidence: "text" }, { thread_id: "good", disposition: "fixed", evidence: "src/good.ts:12" }, { thread_id: "disputed", disposition: "disputed", evidence: null }] });
  const threads = ["missing", "bad", "good", "disputed"].map((thread_id) => ({ thread_id, path: `src/${thread_id}.ts`, line: 2, severity: "minor", message: "thread", own_finding: false, replies: 1 }));
  const result = applyReviewThreadEnforcement(a, threads, "model");
  assert.equal(result.applied, true);
  const rows = a.thread_dispositions as any[];
  assert.deepEqual(rows.map((x) => x.disposition), ["open", "open", "fixed", "disputed"]);
  assert.equal(rows[0].enforced, "no disposition given");
  assert.equal(rows[1].enforced, "fixed without evidence citing current code");
  assert.ok(a.review_markdown.includes("## Unresolved Review Threads"));
  assert.ok(a.review_markdown.includes("- `bad`: open — fixed without evidence citing current code"));
  assert.equal((a.findings as any[]).filter((f) => f.thread_id).length, 3);
});

test("threads reemit severity once and findings policy escalates blocker threads", () => {
  const a = artifact({ thread_dispositions: [{ thread_id: "t", disposition: "open", evidence: null }] });
  const thread = { thread_id: "t", path: "a.py", line: 3, severity: "blocker", message: "issue", own_finding: false, replies: 0 };
  applyReviewThreadEnforcement(a, [thread], "findings_severity_gated");
  assert.equal(a.findings.length, 1);
  assert.equal(a.findings[0]!.severity, "blocker");
  assert.equal(a.verdict, "request_changes");
  assert.equal(a.verdict_source, "findings");
  assert.ok(a.review_markdown.includes("_Verdict escalated from unresolved review threads (verdict_policy=findings_severity_gated): 1 blocker thread(s) still open; model verdict was 'approve'._"));
  const existing = artifact({ findings: [{ ...finding("minor"), thread_id: "t" }], thread_dispositions: [{ thread_id: "t", disposition: "open" }] });
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
  assert.ok(a.review_markdown.includes("- @bob's change request (abcdef0, head unchanged since) is not shown addressed at this head; it needs the reviewer's own re-review."));
  assert.ok(a.review_markdown.includes("- @c's change request (unknown commit) is not shown addressed at this head; it needs the reviewer's own re-review."));
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
  assert.equal(applyAllEnforcement(both, inputs), 2);
  assert.ok(both.review_markdown.includes("- Evidence provider blocker detected: scanner."));
  assert.ok(both.review_markdown.includes("- Tool harness failure detected (plan broke)."));

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

  for (const [harness, reason] of [[{ planning_error: "planning", error: "execution", executed_request_count: 2 }, "planning"], [{ error: "execution" }, "execution"], [{ executed_request_count: 2, tool_results: [{ status: "failed" }] }, "all tool requests failed"]] as Array<[any, string]>) {
    const a = artifact();
    const outcome = applyToolHarnessFailureEnforcement(a, harness);
    assert.equal(outcome.reason, `Tool harness failure detected (${reason}). The tool harness failed during planning or execution; this workflow is configured fail-closed for tool harness failures.`);
    assert.ok(a.review_markdown.includes(`## Tool Harness Failure\nThe tool harness failed during planning or execution (${reason}).`));
  }
  assert.deepEqual(applyToolHarnessFailureEnforcement(artifact(), null), { applied: false, reason: "" });
  assert.deepEqual(applyToolMinSuccessfulEnforcement(artifact(), 1, { tool_results: [{ status: "ok" }] }), { applied: false, reason: "" });
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

test("#792: the same blocker claimed fixed WITHOUT code evidence stays open and escalates", () => {
  const a = artifact({ verdict: "approve", findings: [] });
  const threads = [
    { thread_id: "t1", path: "src/a.py", line: 3, severity: "blocker", message: "handles leak", own_finding: false, replies: 0 },
  ];
  a.thread_dispositions = [{ thread_id: "t1", disposition: "fixed", evidence: "trust me it is fixed" }];
  applyReviewThreadEnforcement(a, threads, "findings_severity_gated");
  assert.equal(a.findings.length, 1, "an unevidenced resolution downgrades to open");
  const reemitted = a.findings[0] as unknown as { severity: string; thread_id?: string };
  assert.equal(reemitted.severity, "blocker");
  assert.equal(reemitted.thread_id, "t1");
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
