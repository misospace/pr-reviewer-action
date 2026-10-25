import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewArtifact } from "../src/enforcement/artifact.js";
import { applyRequirementTraceFragment, workspaceAt } from "../src/prompt/index.js";
import { traceChangedText } from "../src/run/review.js";
import { RunWorkspace } from "../src/run/workspace.js";
import { applyStrictVerdictPolicy, relaxCiOnlyVerdict, relaxVerificationOnlyVerdict } from "../src/enforcement/verdict-policy.js";
import { isValidOwnerPattern, parseRequirementOwners, resolveRequirementOwners } from "../src/config/requirement-owners.js";
import {
  applyConfirmedUnmetEscalation,
  applyRequirementTraceEnforcement,
  confirmedUnmetRows,
  MAX_CONFIRMED_UNMET_FINDINGS,
  MAX_RENDERED_ID_CHARS,
  MAX_DECLARED_GROUPS_PER_RULE,
  MAX_DISTRIBUTED_HINTS,
  MAX_TRACE_REPAIR_SUMMARY_ERROR_CHARS,
  MAX_TRACE_REPAIR_SUMMARY_ID_CHARS,
  MAX_TRACE_REPAIR_SUMMARY_IDS,
  distributedRequirementHints,
  extractRequirementTerms,
  ledgerRequirementsById,
  mergeTraceClaims,
  missingTraceRequirementIds,
  renderRequirementTraceMarkdown,
  changedSubjectText,
  requirementSubjectSignals,
  requirementTraceScope,
  structuralStateClaim,
  explicitlyRequiresTest,
nonCodeProofDomain,
documentationProofSource,
DOC_SCAN_MAX_FILE_BYTES,
PENDING_DISPOSITION,
  validateRequirementTrace,
  type RequirementOwnership,
  type RequirementTraceArtifact,
} from "../src/enforcement/requirement-trace.js";
import { buildTraceRepairUserMessage, normalizeTraceRepairPayload, runRequirementTraceRepairPass, traceRepairOutcomeSummary, type TraceRepairPassResult } from "../src/requirements/trace-repair.js";
import { workspacePathHasSymlinkComponent } from "../src/context/workspace-path.js";

function artifact(overrides: Record<string, unknown> = {}): ReviewArtifact {
  return { verdict: "approve", review_markdown: "review", findings: [], ...overrides } as ReviewArtifact;
}

function ledgerWith(entries: Array<{ id: string; text: string; kind: string }>): unknown {
  return { requirements: entries };
}

/** A throwaway checkout with a few real files, so location validation has
 * something concrete to check against. Cleaned up by the caller. */
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "req-trace-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "src", "real.ts"), "line1\nline2\nline3\n");
  writeFileSync(join(dir, "tests", "real.test.ts"), "test1\ntest2\ntest3\n");
  return dir;
}

function writeFile(workspace: string, relPath: string, lines: readonly string[]): void {
  mkdirSync(join(workspace, ...relPath.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(workspace, relPath), `${lines.join("\n")}\n`);
}

const SOURCE_SHA_REQUIREMENT = "Context resolution MUST compare the source SHA against the resolved pull.";
const VALID_TEST_LOCATION = { file: "tests/real.test.ts", line: 1 };

test("validateRequirementTrace: empty ledger scope is a no-op", () => {
  const workspace = makeWorkspace();
  try {
    const result = validateRequirementTrace([], ledgerWith([]), workspace);
    assert.equal(result.rows.length, 0);
    assert.equal(result.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("validateRequirementTrace: invariant-kind entries are out of scope", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "ordering rule", kind: "invariant" }]);
    const result = validateRequirementTrace([], ledger, workspace);
    assert.equal(result.rows.length, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("validateRequirementTrace: met with a valid enforcement location, a valid test location, and a real predicate stays met", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/context-resolution-checked.ts", [
      "export function resolveContext(ctx, record) {",
      "  if (record.head !== ctx.sourceSha) {",
      "    throw new Error('source sha mismatch');",
      "  }",
      "  return { ok: true };",
      "}",
    ]);
    const ledger = ledgerWith([{ id: "req-1", text: SOURCE_SHA_REQUIREMENT, kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-1",
      disposition: "met",
      enforcement: [{ file: "src/context-resolution-checked.ts", line: 2 }],
      test: [VALID_TEST_LOCATION],
      reason: "compares record.head to ctx.sourceSha and throws on mismatch",
    }];
    const result = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows[0]?.notes, []);
    assert.equal(result.rows[0]?.disposition, "met");
    assert.equal(result.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("malformed-location regression: met citing an enforcement line that does not exist is downgraded", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "match source SHA", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-1",
      disposition: "met",
      enforcement: [{ file: "src/real.ts", line: 999 }],
      test: [VALID_TEST_LOCATION],
      reason: "sourceSha is present on the output object",
    }];
    const result = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(result.rows[0]?.disposition, "unverifiable");
    assert.ok(result.rows[0]?.notes.includes("downgraded-no-valid-enforcement-location"));
    assert.equal(result.incomplete, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#954: an unverifiable in-scope trace is recorded separately while strict result stays partial", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "match source SHA", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-1",
      disposition: "unverifiable",
      enforcement: [],
      test: [],
      reason: "The available evidence does not establish that source SHA is checked.",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.incomplete, true);
    assert.equal(trace.rows[0]?.disposition, "unverifiable");

    const art = artifact({ requirement_coverage: claims });
    applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    assert.equal(art.requirement_trace_incomplete, true);
    assert.equal(art.required_checks, "incomplete");
    const outcome = applyStrictVerdictPolicy(art, { modelVerdict: "approve", forced: false });
    assert.equal(outcome.reviewResult, "partial");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("malformed-location regression: met citing a non-existent enforcement file is downgraded", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "normative" }]);
    const claims = [{
      requirement_id: "req-1",
      disposition: "met",
      enforcement: [{ file: "src/nope.ts", line: 1 }],
      test: [VALID_TEST_LOCATION],
      reason: "x",
    }];
    const result = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(result.rows[0]?.disposition, "unverifiable");
    assert.ok(result.rows[0]?.notes.includes("downgraded-no-valid-enforcement-location"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#854 reproduction: met citing a line that exists and copies the value without comparing it is downgraded", () => {
  const workspace = makeWorkspace();
  try {
    // The real #854 defect: the cited line EXISTS, and even names the right
    // field — but it only copies ctx.sourceSha onto the output, and nothing
    // ever compares it. Location existence alone must not pass this.
    writeFile(workspace, "src/context-resolution.ts", [
      "export function resolveContext(ctx) {",
      "  const record = lookupPull(ctx);",
      "  return {",
      "    repo: record.repo,",
      "    sourceSha: ctx.sourceSha,",
      "    targetBranch: ctx.targetBranch,",
      "  };",
      "}",
    ]);
    const ledger = ledgerWith([{ id: "req-1", text: SOURCE_SHA_REQUIREMENT, kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-1",
      disposition: "met",
      enforcement: [{ file: "src/context-resolution.ts", line: 5 }],
      test: [VALID_TEST_LOCATION],
      reason: "sourceSha is present on the resolved context object",
    }];
    const result = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(result.rows[0]?.disposition, "unverifiable");
    assert.ok(result.rows[0]?.notes.includes("enforcement-location-copies-without-comparing"));
    assert.equal(result.incomplete, true);

    // Folded through the full enforcement pass: coverage goes partial, never
    // clean, from this downgrade alone.
    const art = artifact({ requirement_coverage: claims });
    const traceResult = applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    assert.equal(traceResult.trace.rows[0]?.disposition, "unverifiable");
    assert.equal(traceResult.trace.incomplete, true);
    assert.equal(art.requirement_trace_incomplete, true);
    assert.equal(art.required_checks, "incomplete");
    const outcome = applyStrictVerdictPolicy(art, { modelVerdict: "approve", forced: false });
    assert.equal(outcome.reviewResult, "partial");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("met with no test location at all is downgraded", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/context-resolution-checked.ts", [
      "export function resolveContext(ctx, record) {",
      "  if (record.head !== ctx.sourceSha) {",
      "    throw new Error('source sha mismatch');",
      "  }",
      "}",
    ]);
    const ledger = ledgerWith([{ id: "req-1", text: SOURCE_SHA_REQUIREMENT, kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-1",
      disposition: "met",
      enforcement: [{ file: "src/context-resolution-checked.ts", line: 2 }],
      test: [],
      reason: "compares record.head to ctx.sourceSha",
    }];
    const result = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(result.rows[0]?.disposition, "unverifiable");
    assert.ok(result.rows[0]?.notes.includes("downgraded-no-valid-test-location"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("met citing a test location that does not exist is downgraded", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/context-resolution-checked.ts", [
      "export function resolveContext(ctx, record) {",
      "  if (record.head !== ctx.sourceSha) {",
      "    throw new Error('source sha mismatch');",
      "  }",
      "}",
    ]);
    const ledger = ledgerWith([{ id: "req-1", text: SOURCE_SHA_REQUIREMENT, kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-1",
      disposition: "met",
      enforcement: [{ file: "src/context-resolution-checked.ts", line: 2 }],
      test: [{ file: "tests/nope.test.ts", line: 1 }],
      reason: "compares record.head to ctx.sourceSha",
    }];
    const result = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(result.rows[0]?.disposition, "unverifiable");
    assert.ok(result.rows[0]?.notes.includes("downgraded-no-valid-test-location"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("met citing a 'test' location that is actually a production file (fails isTestPath) is downgraded", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/context-resolution-checked.ts", [
      "export function resolveContext(ctx, record) {",
      "  if (record.head !== ctx.sourceSha) {",
      "    throw new Error('source sha mismatch');",
      "  }",
      "}",
    ]);
    const ledger = ledgerWith([{ id: "req-1", text: SOURCE_SHA_REQUIREMENT, kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-1",
      disposition: "met",
      enforcement: [{ file: "src/context-resolution-checked.ts", line: 2 }],
      // src/real.ts is a real, valid location — but not a test file.
      test: [{ file: "src/real.ts", line: 1 }],
      reason: "compares record.head to ctx.sourceSha",
    }];
    const result = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(result.rows[0]?.disposition, "unverifiable");
    assert.ok(result.rows[0]?.notes.includes("downgraded-no-valid-test-location"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a requirement the reviewer never traced is unverifiable and marks coverage incomplete", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "acceptance" }]);
    const result = validateRequirementTrace([], ledger, workspace);
    assert.equal(result.rows[0]?.disposition, "unverifiable");
    assert.ok(result.rows[0]?.notes.includes("not-traced-by-reviewer"));
    assert.equal(result.incomplete, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("not_applicable with a reason is accepted", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X in the removed module", kind: "acceptance" }]);
    const claims = [{ requirement_id: "req-1", disposition: "not_applicable", reason: "module removed in this PR" }];
    const result = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(result.rows[0]?.disposition, "not_applicable");
    assert.equal(result.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reason regression: not_applicable/unmet/unverifiable with an empty reason all downgrade to unverifiable", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([
      { id: "req-1", text: "must validate X", kind: "acceptance" },
      { id: "req-2", text: "must validate Y", kind: "acceptance" },
      { id: "req-3", text: "must validate Z", kind: "acceptance" },
    ]);
    const claims = [
      { requirement_id: "req-1", disposition: "not_applicable", reason: "" },
      { requirement_id: "req-2", disposition: "unmet", reason: "  " },
      { requirement_id: "req-3", disposition: "unverifiable" },
    ];
    const result = validateRequirementTrace(claims, ledger, workspace);
    for (const row of result.rows) {
      assert.equal(row.disposition, "unverifiable");
      assert.ok(row.notes.includes("missing-reason"), JSON.stringify(row));
    }
    assert.equal(result.incomplete, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reason regression, folded through enforcement: all not_applicable with empty reasons goes incomplete and renders the trace section", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "acceptance" }]);
    const art = artifact({
      requirement_coverage: [{ requirement_id: "req-1", disposition: "not_applicable", reason: "" }],
    });
    const result = applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    assert.equal(result.trace.rows[0]?.disposition, "unverifiable");
    assert.equal(art.required_checks, "incomplete");
    assert.match(art.review_markdown, /Requirement trace/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("malformed claim entries populate errors with field-naming diagnostics and fall back to the missing-claim path", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([
      { id: "req-1", text: "must validate X", kind: "acceptance" },
      { id: "req-2", text: "must validate Y", kind: "acceptance" },
    ]);
    const claims = [
      "not an object",
      { requirement_id: "req-1", disposition: "met", enforcement: [{ file: "src/real.ts", line: 1 }], test: [VALID_TEST_LOCATION], reason: "present" },
      { disposition: "met", reason: "no requirement_id" },
    ];
    const result = validateRequirementTrace(claims, ledger, workspace);
    assert.deepEqual(result.errors, [
      "requirement_trace[0]: entry is not an object; skipped",
      "requirement_trace[2]: missing or non-string requirement_id; skipped",
    ]);
    // The malformed entries are skipped, so the requirement whose only claim
    // lacked a requirement_id falls back to the missing-claim path:
    // unverifiable plus the not-traced-by-reviewer note. The well-formed
    // claim beside it is unaffected.
    assert.equal(result.rows[0]?.disposition, "met");
    assert.equal(result.rows[1]?.disposition, "unverifiable");
    assert.ok(result.rows[1]?.notes.includes("not-traced-by-reviewer"));
    assert.equal(result.incomplete, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("malformed claim entries cap errors at 8 with a final truncation note", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "acceptance" }]);
    // Alternate the two malformed shapes so both diagnostics flow through the cap.
    const claims = Array.from({ length: 12 }, (_unused, i) => (i % 2 === 0 ? "not an object" : { disposition: "met" }));
    const result = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(result.errors.length, 8);
    assert.ok(result.errors[0]?.startsWith("requirement_trace[0]:"));
    const truncationNotes = result.errors.filter((e) => e.includes("truncat") || e.includes("omitted"));
    assert.equal(truncationNotes.length, 1);
    assert.ok(result.errors[result.errors.length - 1]?.includes("omitted"));
    // The cap must not disturb the per-requirement fold.
    assert.equal(result.rows[0]?.disposition, "unverifiable");
    assert.equal(result.incomplete, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a well-formed unmet requirement is a coverage stop (incomplete), not just a finding", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "acceptance" }]);
    const claims = [{ requirement_id: "req-1", disposition: "unmet", reason: "no such check exists" }];
    const result = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.disposition, "unmet");
    assert.equal(result.incomplete, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1095: an unmet requirement the model did not substantiate with a finding is never synthesized into one", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "acceptance" }]);
    const art = artifact({
      verdict: "approve",
      requirement_coverage: [{ requirement_id: "req-1", disposition: "unmet", reason: "no such check exists" }],
    });
    const result = applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    assert.equal(result.applied, true);
    // The unmet row stays on the record and keeps coverage incomplete — but
    // the enforcement pass fabricates no blocking finding from the ledger
    // text alone (miso-gallery#543: three majors, zero code defects).
    assert.equal(result.trace.rows[0]?.disposition, "unmet");
    assert.equal(result.trace.incomplete, true);
    assert.equal(art.required_checks, "incomplete");
    assert.deepEqual(art.findings, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1095: a model-substantiated unmet (matching finding) is untouched and still blocks", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "acceptance" }]);
    const claims = [{ requirement_id: "req-1", disposition: "unmet", reason: "no such check exists" }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    const modelFinding = { severity: "major", category: "bug", file: "a.ts", line: 1, message: "must validate X is missing" };
    const art = artifact({ findings: [modelFinding] });
    const result = applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    assert.equal(result.applied, true);
    assert.equal(art.findings.length, 1);
    assert.equal(art.findings[0]?.message, "must validate X is missing");
    assert.equal(art.required_checks, "incomplete");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("renderRequirementTraceMarkdown: nothing to render when everything is met", () => {
  assert.equal(renderRequirementTraceMarkdown({ version: 1, rows: [{ requirement_id: "r", disposition: "met", proof: "runtime_behavior", enforcement: [], test: [], reason: "", notes: [] }], incomplete: false, errors: [] }), "");
});

test("renderRequirementTraceMarkdown: collapses behind <details> once the ledger is large", () => {
  const rows = Array.from({ length: 6 }, (_unused, i) => ({
    requirement_id: `r${i}`, disposition: i === 0 ? "unmet" : "met", proof: "runtime_behavior", enforcement: [], test: [], reason: "gap", notes: [],
  }));
  const rendered = renderRequirementTraceMarkdown({ version: 1, rows, incomplete: false, errors: [] });
  assert.ok(rendered.includes("<details>"));
  assert.ok(rendered.includes("r0"));
});

test("disabled: applyRequirementTraceEnforcement is a no-op", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "acceptance" }]);
    const art = artifact({ requirement_coverage: [] });
    const result = applyRequirementTraceEnforcement(art, { enabled: false, ledger, workspace });
    assert.equal(result.applied, false);
    assert.equal(art.required_checks, undefined);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#874/#1095 end-to-end: an unsubstantiated unmet keeps coverage incomplete and the model's approve stands", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "the list path must enforce target.repo === ctx.repoDid", kind: "acceptance" }]);
    const art = artifact({
      verdict: "approve",
      requirement_coverage: [{ requirement_id: "req-1", disposition: "unmet", reason: "list path has no such check" }],
    });
    const result = applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    // #1095: no fabricated blocking finding — the trace gap is disclosed via
    // the incomplete marker instead.
    assert.equal(art.findings.length, 0);
    assert.equal(result.trace.rows[0]?.disposition, "unmet");

    const outcome = applyStrictVerdictPolicy(art, { modelVerdict: "approve", forced: false });
    assert.equal(outcome.verdict, "approve");
    assert.equal(outcome.reviewResult, "partial");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ── extractRequirementTerms / enforcementPredicateFound: unit coverage ────

test("extractRequirementTerms: 'source SHA' yields sourcesha/source_sha/sourceSha", () => {
  const terms = extractRequirementTerms(SOURCE_SHA_REQUIREMENT);
  assert.ok(terms.includes("sourcesha"), JSON.stringify(terms));
  assert.ok(terms.includes("source_sha"), JSON.stringify(terms));
  assert.ok(terms.includes("sourceSha"), JSON.stringify(terms));
});

test("extractRequirementTerms: an explicit symbol is included even if not phrased in the text", () => {
  const terms = extractRequirementTerms("must validate the request", "repoDid");
  assert.ok(terms.includes("repodid"));
});

test("predicate window: a term + predicate signal far outside the ±3 window does not satisfy 'met' (via validateRequirementTrace)", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/far.ts", [
      "if (a !== b) { throw new Error('x'); }", // line 1: predicate, but no relevant term
      "// padding", "// padding", "// padding", "// padding", "// padding", "// padding", "// padding",
      "sourceSha: ctx.sourceSha,", // line 9: term present, no predicate; far outside a ±3 window of line 1
    ]);
    const ledger = ledgerWith([{ id: "req-1", text: SOURCE_SHA_REQUIREMENT, kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-1",
      disposition: "met",
      enforcement: [{ file: "src/far.ts", line: 1 }],
      test: [VALID_TEST_LOCATION],
      reason: "compares a to b",
    }];
    const result = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(result.rows[0]?.disposition, "unverifiable");
    assert.ok(result.rows[0]?.notes.includes("enforcement-location-copies-without-comparing"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("predicate check is skipped (documented limitation) when the requirement text yields no usable terms", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/copy.ts", ["export const x = { value: 1 };"]);
    // All-stopword text: extractRequirementTerms finds nothing to check, so
    // location validity alone stands — not a silent pass-everything default,
    // but a documented consequence of empty term extraction.
    const ledger = ledgerWith([{ id: "req-1", text: "This must be so and so", kind: "acceptance" }]);
    assert.deepEqual(extractRequirementTerms("This must be so and so"), []);
    const claims = [{
      requirement_id: "req-1",
      disposition: "met",
      enforcement: [{ file: "src/copy.ts", line: 1 }],
      test: [VALID_TEST_LOCATION],
      reason: "present",
    }];
    const result = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(result.rows[0]?.disposition, "met");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#935: trace scope = linked-issue requirements plus any requirement whose subject the change touches", () => {
  const ledger = {
    requirements: [
      { id: "req-wf", text: "The review workflow MUST pin every action by commit SHA.", kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 3 }] },
      { id: "req-db", text: "Database migrations MUST be reversible.", kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 5 }] },
      { id: "req-issue", text: "Resolution MUST compare the source SHA.", kind: "acceptance", provenance: [{ source: "linked_issues", ref: "#584", line: 9 }] },
      { id: "req-noprov", text: "Something MUST hold.", kind: "normative" },
    ],
  };
  const changed = changedSubjectText(
    "diff --git a/.github/workflows/review.yaml b/.github/workflows/review.yaml\n+++ b/.github/workflows/review.yaml\n-        uses: actions/checkout@v4\n+        uses: actions/checkout@3d3c42e5 # v7.0.1 pin by commit sha\n",
    [".github/workflows/review.yaml"],
  );
  const scope = requirementTraceScope(ledger, changed);
  assert.deepEqual(scope.inScope.map((e) => e.id).sort(), ["req-issue", "req-noprov", "req-wf"]);
  assert.deepEqual(scope.outOfScope.map((o) => o.entry.id), ["req-db"]);
  assert.match(scope.outOfScope[0]!.reason, /out of scope: from standards/);
  // Without changed text, nothing is dropped (fail closed).
  assert.equal(requirementTraceScope(ledger).inScope.length, 4);
});

test("#935: an untouched standards requirement is not_applicable with a reason and keeps coverage complete", () => {
  const ws = makeWorkspace();
  try {
    const ledger = { requirements: [
      { id: "req-db", text: "Database migrations MUST be reversible.", kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 5 }] },
      { id: "req-body", text: "The exporter MUST retry failed scrapes.", kind: "acceptance", provenance: [{ source: "pr_body", ref: "pr", line: 2 }] },
    ] };
    const changed = changedSubjectText("+  equivalent-paths: \"true\"\n", [".github/workflows/ai-pr-review.yaml"]);
    const trace = validateRequirementTrace([], ledger, ws, changed);
    assert.equal(trace.incomplete, false);
    assert.deepEqual(trace.rows.map((r) => [r.requirement_id, r.disposition]), [["req-db", "not_applicable"], ["req-body", "not_applicable"]]);
    assert.ok(trace.rows.every((r) => r.reason.startsWith("out of scope") && r.notes.includes("out-of-scope")));
    // The reviewer can still report one unmet, and then it counts.
    const reported = validateRequirementTrace([{ requirement_id: "req-db", disposition: "unmet", reason: "drops the down migration" }], ledger, ws, changed);
    assert.equal(reported.incomplete, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("#935: an untraced in-scope requirement still fails the trace", () => {
  const ws = makeWorkspace();
  try {
    const ledger = { requirements: [{ id: "req-issue", text: "Resolution MUST compare the source SHA.", kind: "acceptance", provenance: [{ source: "linked_issues", ref: "#584", line: 9 }] }] };
    const trace = validateRequirementTrace([], ledger, ws, changedSubjectText("+x\n", ["README.md"]));
    assert.equal(trace.incomplete, true);
    assert.equal(trace.rows[0]!.disposition, "unverifiable");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("#935: the trace prompt asks only for the in-scope requirements", () => {
  const dir = mkdtempSync(join(tmpdir(), "req-trace-prompt-"));
  try {
    writeFileSync(join(dir, "requirement-ledger-present.txt"), "1\n");
    const ws = workspaceAt(dir);
    const base = { systemPrompt: "BASE", isDefault: true, addendum: "" };
    const scoped = applyRequirementTraceFragment(base, ws, true, undefined, ["req-issue"]);
    assert.match(scoped.systemPrompt, /For every requirement in trace scope \(req-issue\); other ledger requirements need no trace,/);
    assert.doesNotMatch(scoped.systemPrompt, /in the Requirement Ledger,/);
    assert.equal(applyRequirementTraceFragment(base, ws, true, undefined, []).systemPrompt, "BASE");
    assert.match(applyRequirementTraceFragment(base, ws, true).systemPrompt, /For every acceptance\/normative requirement in the Requirement Ledger,/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#935: the touched-subject scope reads the full raw diff, not the budgeted one", () => {
  const ledger = { requirements: [{ id: "req-csrf", text: "Every request MUST validate the CSRF token.", kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 4 }] }] };
  const ws = new RunWorkspace(mkdtempSync(join(tmpdir(), "req-trace-diff-")), false);
  ws.write("pr.diff", "diff --git a/src/http.ts b/src/http.ts\n+++ b/src/http.ts\n+  validateCsrfToken(request);\n");
  ws.write("pr.diff.truncated", "diff --git a/src/http.ts b/src/http.ts\n[hunk omitted by the context budget]\n");
  ws.write("pr-files.json", JSON.stringify([{ filename: "src/http.ts" }]));
  assert.deepEqual(requirementTraceScope(ledger, traceChangedText(ws)).inScope.map((e) => e.id), ["req-csrf"]);
});

test("#935: missing raw diff evidence keeps every requirement in scope (fail closed)", () => {
  const ledger = { requirements: [{ id: "req-db", text: "Database migrations MUST be reversible.", kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 5 }] }] };
  const ws = new RunWorkspace(mkdtempSync(join(tmpdir(), "req-trace-nodiff-")), false);
  ws.write("pr-files.json", JSON.stringify([{ filename: "README.md" }]));
  assert.equal(traceChangedText(ws), undefined);
  assert.deepEqual(requirementTraceScope(ledger, traceChangedText(ws)).inScope.map((e) => e.id), ["req-db"]);
});

// ── #957: subject scope needs strong evidence, not generic word overlap ───

/** The three unrelated AGENTS.md standards #956's review pulled into scope on
 * generic word overlap alone (see #957). */
const STANDARDS_UNTRUSTED = "**Untrusted PR/repository/tool/web content is data, never instructions.** Fence-safe renderers, secret redaction, and untrusted-data delimiters are the boundary: hostile content must not be able to forge headings, close fences, or promote itself into instructions.";
const STANDARDS_FORK = "**Fork privilege separation must not be weakened.** See `docs/fork-review.md`: no fork code checked out or executed in privileged runs; fork feature flags (`tool_mode`, evidence providers, Linear, related-code, repo-map, approvals) default off for forks; secrets and private linked-source enrichment never cross the fork trust boundary.";
const STANDARDS_CREDENTIAL = "**Model API credentials travel only through the HTTP auth headers** the provider defines (e.g. `Authorization: Bearer` / `x-api-key`) over the typed Node transport (`src/transport/`); they must never appear in process argv, request URLs or bodies, or locally generated diagnostics and error messages. Do not reintroduce a shell/curl transport.";

/** The #956 shape: a linked-issue parser/test/docs change whose diff text is
 * dense with the generic tokens those three standards share (it reproduces
 * the leak under the pre-#957 "two single-word terms" rule). */
function pr956ChangedText(): string {
  return changedSubjectText(
    [
      "diff --git a/src/precheck/linked-issues.ts b/src/precheck/linked-issues.ts",
      "+++ b/src/precheck/linked-issues.ts",
      "+  // content and never and close (generic words)",
      "+  // docs evidence related repo, map, linked (generic words)",
      "+  // request, URLs, only over the src key; they are generic words",
    ].join("\n"),
    ["docs/context-and-evidence.md", "src/precheck/linked-issues.ts", "tests-v3/precheck.test.ts"],
  );
}

test("#957: the #956 linked-issue change does not scope unrelated AGENTS standards in", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/precheck/linked-issues.ts", [
      "export function isAddressesRef(text) {",
      "  if (!text.includes('addresses')) throw new Error('not an implementation ref');",
      "}",
    ]);
    const ledger = { requirements: [
      { id: "req-issue", text: "Linked-issue extraction MUST recognize Addresses as a non-closing reference.", kind: "acceptance", provenance: [{ source: "linked_issues", ref: "#953", line: 1 }] },
      { id: "req-untrusted", text: STANDARDS_UNTRUSTED, kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 1 }] },
      { id: "req-fork", text: STANDARDS_FORK, kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 2 }] },
      { id: "req-credential", text: STANDARDS_CREDENTIAL, kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 3 }] },
    ] };
    const changed = pr956ChangedText();
    // The #956 changed files, with the full owner map applied: the owner
    // mechanism must not widen scope back onto the three unrelated standards.
    const changedPaths = ["docs/context-and-evidence.md", "src/precheck/linked-issues.ts", "tests-v3/precheck.test.ts"];

    const scope = requirementTraceScope(ledger, changed, { ownership: OWNERSHIP, paths: changedPaths });
    assert.deepEqual(scope.inScope.map((e) => e.id), ["req-issue"], "only the linked-issue requirement is in scope");
    assert.deepEqual(scope.outOfScope.map((o) => o.entry.id).sort(), ["req-credential", "req-fork", "req-untrusted"]);

    // With the linked-issue requirement satisfied, the unrelated standards are
    // grounded not_applicable and coverage stays complete — no approval
    // withholding from generic word overlap alone.
    const claims = [{
      requirement_id: "req-issue",
      disposition: "met",
      enforcement: [{ file: "src/precheck/linked-issues.ts", line: 2 }],
      test: [VALID_TEST_LOCATION],
      reason: "the parser's implementation-ref predicate matches Addresses",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace, changed, { ownership: OWNERSHIP, paths: changedPaths });
    assert.equal(trace.incomplete, false);
    assert.equal(trace.rows.find((r) => r.requirement_id === "req-issue")?.disposition, "met");
    for (const id of ["req-untrusted", "req-fork", "req-credential"]) {
      const row = trace.rows.find((r) => r.requirement_id === id);
      assert.equal(row?.disposition, "not_applicable", id);
      assert.ok(row?.notes.includes("out-of-scope"), id);
      assert.match(row?.reason ?? "", /^out of scope: from standards/, id);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

/** The declared owner map a repository config would carry (#958): architectural
 * metadata, not an inferred lexical signal. */
const OWNERSHIP = [
  { match: ["fork", "privilege", "separation"], owners: [".github/workflows/ai-pr-review-fork.yaml", "scripts/fork_review_gate.py"] },
  { match: ["untrusted", "content", "data"], owners: ["src/context/pr-thread.ts", "src/context/review-threads.ts", "src/specialists/render.ts", "src/claims/render.ts", "src/requirements/ledger.ts", "src/publish/publish.ts"] },
  { match: ["model", "api", "credentials"], owners: ["src/transport/http.ts", "src/transport/sse.ts", "src/transport/transport.ts"] },
];

test("#958: a declared owner path scopes its requirement in; unrelated paths do not", () => {
  const ledger = { requirements: [
    { id: "req-fork", text: STANDARDS_FORK, kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 2 }] },
    { id: "req-untrusted", text: STANDARDS_UNTRUSTED, kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 1 }] },
    { id: "req-credential", text: STANDARDS_CREDENTIAL, kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 3 }] },
  ] };
  const scope = (paths: string[]): string[] =>
    requirementTraceScope(ledger, changedSubjectText("+  const x = 1;\n", paths), { ownership: OWNERSHIP, paths }).inScope.map((e) => e.id).sort();

  // The fork-privilege standard guards .github/workflows/ai-pr-review-fork.yaml:
  // ordinary workflow edits there need not repeat "fork privilege" or
  // "trust boundary", but the declared owner path keeps it in scope — and it
  // scopes only that standard.
  assert.deepEqual(scope([".github/workflows/ai-pr-review-fork.yaml"]), ["req-fork"]);
  assert.deepEqual(scope(["scripts/fork_review_gate.py"]), ["req-fork"]);
  // The untrusted-content boundary's fence renderers own it.
  assert.deepEqual(scope(["src/specialists/render.ts"]), ["req-untrusted"]);
  // An unrelated workflow is not an owner.
  assert.deepEqual(scope([".github/workflows/foo.yaml"]), []);
  // A path that merely contains `model` is not an owner of the credential
  // standard, and generic overlap alone must not scope it in.
  assert.deepEqual(scope(["src/model/foo.ts"]), []);
});

test("#958: a narrow owner glob matches; a broad pattern is rejected at parse time", () => {
  const parsed = parseRequirementOwners(
    "requirements:\n  untrusted-content-is-data:\n    owners:\n      - src/context/*-thread.ts\n",
    ".github/pr-reviewer-owners.yml",
  );
  assert.ok(!("malformed" in parsed));
  if ("malformed" in parsed) return;
  const ledger = { requirements: [{ id: "req-u", text: STANDARDS_UNTRUSTED, kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 1 }] }] };
  const changed = changedSubjectText("+x\n", ["src/context/pr-thread.ts"]);
  assert.deepEqual(requirementTraceScope(ledger, changed, { ownership: parsed.rules, paths: ["src/context/pr-thread.ts"] }).inScope.map((e) => e.id), ["req-u"]);
});

test("#958: parseRequirementOwners accepts a valid map and drops invalid owner globs", () => {
  const text = [
    "requirements:",
    "  fork-privilege-separation:",
    "    owners:",
    "      - .github/workflows/ai-pr-review-fork.yaml",
    "      - scripts/fork_review_gate.py",
    "  untrusted-content-is-data:",
    "    owners:",
    "      - src/specialists/render.ts",
    "      - src/**",
    "      - /etc/passwd",
    "      - ../escape.ts",
    "      - '*.ts'",
  ].join("\n");
  const parsed = parseRequirementOwners(text, ".github/pr-reviewer-owners.yml");
  assert.ok(!("malformed" in parsed));
  if ("malformed" in parsed) return;
  assert.deepEqual(parsed.rules, [
    { match: ["fork", "privilege", "separation"], owners: [".github/workflows/ai-pr-review-fork.yaml", "scripts/fork_review_gate.py"] },
    { match: ["untrusted", "content", "data"], owners: ["src/specialists/render.ts"] },
  ]);
  assert.ok(parsed.warnings.length >= 4, JSON.stringify(parsed.warnings));
});

test("#958: parseRequirementOwners never throws and degrades malformed input to no owners", () => {
  assert.deepEqual(parseRequirementOwners("", "p"), { rules: [], warnings: [] });
  assert.ok("malformed" in parseRequirementOwners("a: [1, 2", "p"), "invalid YAML is malformed");
  assert.ok("malformed" in parseRequirementOwners("- a\n- b", "p"), "a non-mapping file is malformed");
  assert.ok("malformed" in parseRequirementOwners("requirements: [1, 2]", "p"), "a non-mapping section is malformed");
  // A missing section is not malformed — just no owners.
  const noSection = parseRequirementOwners("other: 1", "p");
  assert.ok(!("malformed" in noSection));
  if ("malformed" in noSection) return;
  assert.deepEqual(noSection.rules, []);
  assert.equal(noSection.warnings.length, 1);
});

test("#958: isValidOwnerPattern rejects broad, escaping, or backtracking globs", () => {
  assert.equal(isValidOwnerPattern("src/context/pr-thread.ts"), true);
  assert.equal(isValidOwnerPattern("src/context/*-thread.ts"), true);
  assert.equal(isValidOwnerPattern("src/transport/*.ts"), true);
  assert.equal(isValidOwnerPattern("src/**"), false);
  assert.equal(isValidOwnerPattern("src/**/*.ts"), false);
  assert.equal(isValidOwnerPattern("/abs/path.ts"), false);
  assert.equal(isValidOwnerPattern("../escape.ts"), false);
  assert.equal(isValidOwnerPattern("*.ts"), false); // no directory component
  assert.equal(isValidOwnerPattern("*/foo.ts"), false); // all-wildcard segment
  assert.equal(isValidOwnerPattern("src/*/*.ts"), false); // all-wildcard segment
  assert.equal(isValidOwnerPattern("src/a*b*c.ts"), false); // >1 `*` backtracks
  assert.equal(isValidOwnerPattern("src/ spaced.ts"), false); // whitespace
  assert.equal(isValidOwnerPattern("a//b.ts"), false);
  assert.equal(isValidOwnerPattern(""), false);
});

test("#958: parseRequirementOwners warns on a non-slug key and an over-long owners list", () => {
  const parsed = parseRequirementOwners(
    [
      "requirements:",
      "  fork_privilege_separation:",
      "    owners:",
      "      - .github/workflows/ai-pr-review-fork.yaml",
      "  untrusted-content-is-data:",
      "    owners:",
      ...Array.from({ length: 40 }, (_unused, i) => `      - src/file-${i}.ts`),
    ].join("\n"),
    "p",
  );
  assert.ok(!("malformed" in parsed));
  if ("malformed" in parsed) return;
  // The underscore key is dropped; the valid rule keeps only the 32-owner cap.
  assert.deepEqual(parsed.rules.map((r) => r.match.join("-")), ["untrusted-content-data"]);
  assert.equal(parsed.rules[0]!.owners.length, 32);
  assert.ok(parsed.warnings.some((w) => w.includes("hyphenated slug")), JSON.stringify(parsed.warnings));
  assert.ok(parsed.warnings.some((w) => w.includes("more than 32 owners")), JSON.stringify(parsed.warnings));
});

test("#958: a malformed ownership context cannot crash the trace scope", () => {
  const ledger = { requirements: [{ id: "r", text: STANDARDS_FORK, kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 1 }] }] };
  const changed = changedSubjectText("+x\n", [".github/workflows/ai-pr-review-fork.yaml"]);
  // A non-string token (which the parser never produces) must be dropped, not throw.
  assert.doesNotThrow(() =>
    requirementTraceScope(ledger, changed, { ownership: [{ match: [42] as never, owners: [".github/workflows/ai-pr-review-fork.yaml"] }], paths: [".github/workflows/ai-pr-review-fork.yaml"] }),
  );
});

test("#958: resolveRequirementOwners degrades to no owners on an unresolvable ref", () => {
  // Exercises the real git-backed reader's failure path: never throws, never
  // broadens scope, and surfaces a warning.
  const result = resolveRequirementOwners({ baseRef: "definitely-not-a-real-ref-958", workspace: process.cwd() });
  assert.deepEqual(result.rules, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.sourcePath, null);
});

test("#958: the owner map is read from the base commit, not the PR head", () => {
  // The trust property the whole mechanism rests on: a PR must not be able to
  // edit the ownership metadata used to review itself. Base commit A, head
  // replaces it with B (then deletes it); the resolver called with the base
  // SHA must return A regardless of the working tree / head state.
  const repo = mkdtempSync(join(tmpdir(), "req-owners-git-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).toString();
  const writeMap = (owners: string): void => {
    mkdirSync(join(repo, ".github"), { recursive: true });
    writeFileSync(join(repo, ".github", "pr-reviewer-owners.yml"), owners);
  };
  const expected = (owner: string): unknown => [{ match: ["fork", "privilege", "separation"], owners: [owner] }];
  try {
    git("init", "-q");
    writeMap("requirements:\n  fork-privilege-separation:\n    owners:\n      - .github/workflows/base-only.yaml\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const baseSha = git("rev-parse", "HEAD").trim();

    // The PR head replaces the owner map with a different one...
    writeMap("requirements:\n  fork-privilege-separation:\n    owners:\n      - .github/workflows/head-only.yaml\n");
    git("add", "-A");
    git("commit", "-q", "-m", "head");
    const headSha = git("rev-parse", "HEAD").trim();

    // ...and a later commit removes it entirely.
    git("rm", "-q", ".github/pr-reviewer-owners.yml");
    git("commit", "-q", "-m", "delete");
    const deletedSha = git("rev-parse", "HEAD").trim();

    // The working tree is at head; reading the base ref must still yield the
    // base map — never the head's replacement or its deletion.
    assert.deepEqual(resolveRequirementOwners({ baseRef: baseSha, workspace: repo }).rules, expected(".github/workflows/base-only.yaml"));
    // Sanity: the resolver really does read the ref it is given.
    assert.deepEqual(resolveRequirementOwners({ baseRef: headSha, workspace: repo }).rules, expected(".github/workflows/head-only.yaml"));
    // A ref where the file is absent is genuine absence, not a head injection.
    const deleted = resolveRequirementOwners({ baseRef: deletedSha, workspace: repo });
    assert.deepEqual(deleted.rules, []);
    assert.equal(deleted.sourcePath, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("#957: weak generic-token overlap alone cannot scope a standards requirement in", () => {
  // None of these words is on the issue's example list — a fix that merely
  // appended docs/repo/request/only/never to a stoplist would still leak.
  const ledger = { requirements: [
    { id: "req-generic", text: "The manifest provider MUST emit release data.", kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 9 }] },
  ] };
  const changed = changedSubjectText("+  const manifest = load();\n+  const provider = pick();\n+  const data = emit();\n", ["src/manifest.ts"]);
  const scope = requirementTraceScope(ledger, changed);
  assert.deepEqual(scope.inScope, []);
  assert.deepEqual(scope.outOfScope.map((o) => o.entry.id), ["req-generic"]);
});

test("#957: strong subject overlap still scopes an applicable standards requirement in", () => {
  const scoped = (id: string, text: string, changed: string): string[] =>
    requirementTraceScope({ requirements: [{ id, text, kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 1 }] }] }, changed).inScope.map((e) => e.id);

  // A distinctive multi-word concept.
  assert.deepEqual(
    scoped("req-trust", "The fork trust boundary MUST be enforced at the transport seam.", changedSubjectText("+  if (!withinTrustBoundary(fork)) throw new Error('x');\n", ["src/platform/fork.ts"])),
    ["req-trust"],
  );
  // A single identifier-shaped term: an internal capital, a digit-bearing
  // token long enough not to be a version fragment, or an acronym-prefixed
  // identifier.
  assert.deepEqual(
    scoped("req-sha", "The resolved context MUST compare sourceSha against the head.", changedSubjectText("+  if (record.sourceSha !== ctx.sourceSha) {\n", ["src/context.ts"])),
    ["req-sha"],
  );
  assert.deepEqual(
    scoped("req-digest", "The digest MUST be sha256.", changedSubjectText("+  const digest = sha256(bytes);\n", ["src/digest.ts"])),
    ["req-digest"],
  );
  assert.deepEqual(
    scoped("req-sqlite", "The ledger MUST persist in SQLite.", changedSubjectText("+  const db = new SQLiteStore(path);\n", ["src/requirements/sqlite-store.ts"])),
    ["req-sqlite"],
  );
});

test("#957: a phrase does not match inside a longer word", () => {
  const ledger = { requirements: [
    { id: "req-untrusted", text: STANDARDS_UNTRUSTED, kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 1 }] },
  ] };
  // The untrusted-content standard's "data never" bigram must not match
  // `metadata never` (a bare-substring phrase path would).
  assert.deepEqual(requirementTraceScope(ledger, changedSubjectText("+  // the sandbox guarantees metadata never leaves the container\n", ["src/sandbox.ts"])).inScope, []);
  // A whole-word phrase still counts.
  assert.deepEqual(requirementTraceScope(ledger, changedSubjectText("+  // data never leaves the container\n", ["src/sandbox.ts"])).inScope.map((e) => e.id), ["req-untrusted"]);
});

test("#957: bare acronyms and short version fragments are not distinctive on their own", () => {
  const scoped = (id: string, text: string, changed: string): string[] =>
    requirementTraceScope({ requirements: [{ id, text, kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 4 }] }] }, changed).inScope.map((e) => e.id);
  assert.deepEqual(scoped("req-urls", "Request URLs MUST be validated.", changedSubjectText("+  // CSS/JS URLs covered by closed #479\n", ["src/a.ts"])), []);
  assert.deepEqual(scoped("req-v3", "The v3 public contract MUST use kebab-case names.", changedSubjectText("+  // tests-v3 and contracts/action-v3.yml\n", ["tests-v3/requirement-trace.test.ts"])), []);
});

test("#957: a path-shaped phrase still scopes in, and an oversized word cannot crash scope", () => {
  const scoped = (id: string, text: string, changed: string): string[] =>
    requirementTraceScope({ requirements: [{ id, text, kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 1 }] }] }, changed).inScope.map((e) => e.id);
  // A slash-joined path phrase (`src/transport`) is genuine subject overlap.
  assert.deepEqual(
    scoped("req-transport", "Code under src/transport keeps credentials out of argv.", changedSubjectText("+  export const x = 1;\n", ["src/transport/http.ts"])),
    ["req-transport"],
  );
  // A pathological word must not make `new RegExp` throw (the module contract
  // is to never throw on malformed input).
  const long = "x".repeat(20_000);
  assert.doesNotThrow(() =>
    requirementTraceScope(
      { requirements: [{ id: "req-long", text: `${long} ${long} MUST hold.`, kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 1 }] }] },
      changedSubjectText("+  const y = 1;\n", ["src/a.ts"]),
    ),
  );
});

test("#957: requirementSubjectSignals separates phrases from identifier-shaped terms", () => {
  const signals = requirementSubjectSignals("Fork trust boundary and sourceSha and p0 and SQLite and PR and URLs.");
  assert.deepEqual(signals.strongTerms, ["sourcesha", "sqlite"]);
  assert.deepEqual(signals.phrases.map((p) => p.join(" ")), ["Fork trust", "trust boundary"]);
});

// ── #1000: hyphenated/slash-bearing code spans are atomic subject terms ──

test("#1000: a hyphenated code span is not split into a fabricated prose phrase", () => {
  // The production leak (observed on the #997 review at 2ce2708f): the
  // credential-transport standard's parenthetical example `x-api-key` was
  // split into the words "api" and "key", and the joined form `apikey`
  // matched the generic `apiKey`/`API_KEY` vocabulary of the PR's added
  // redaction-test lines — scoping the standard into a redaction-only diff
  // and driving `required_checks: incomplete` on an unrelated change.
  const ledger = { requirements: [
    {
      id: "req-creds",
      text: "Model API credentials travel only through the HTTP auth headers the provider defines (e.g. `Authorization: Bearer` / `x-api-key`) over the typed Node transport; they must never appear in process argv, request URLs or bodies.",
      kind: "normative",
      provenance: [{ source: "standards", ref: "AGENTS.md", line: 30 }],
    },
  ] };
  const changed = changedSubjectText(
    '+  assert.equal(redactSourceText(`{"apiKey": "sk-proj-x"}`), `{"apiKey": "[REDACTED]"}`);\n' +
    '+  assert.equal(redactSourceText("API_KEY=sk-ant-y"), "API_KEY=[REDACTED]");\n',
    ["src/context/redact.ts", "tests-v3/redact.test.ts"],
  );
  const scope = requirementTraceScope(ledger, changed);
  assert.deepEqual(scope.inScope, []);
  assert.deepEqual(scope.outOfScope.map((o) => o.entry.id), ["req-creds"]);
});

test("#1000: an atomic code span still matches its literal in the change", () => {
  // The span is the requirement's ONLY subject signal here — no prose phrase
  // and no identifier-shaped term — so the match proves the atomic path.
  const scoped = (id: string, text: string, changed: string): string[] =>
    requirementTraceScope({ requirements: [{ id, text, kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 1 }] }] }, changed).inScope.map((e) => e.id);
  assert.deepEqual(
    scoped("req-span", "The `x-api-key` header name must never be logged.", changedSubjectText('+  headers.set("x-api-key", key);\n', ["src/transport/http.ts"])),
    ["req-span"],
  );
});

test("#1000: genuine transport prose still scopes the standard in", () => {
  // Tightening must not break real subject overlap: the standard's own prose
  // reaching the diff is scope evidence independent of any code span.
  const ledger = { requirements: [
    {
      id: "req-creds",
      text: "Model API credentials travel only through the HTTP auth headers the provider defines (e.g. `Authorization: Bearer` / `x-api-key`) over the typed Node transport.",
      kind: "normative",
      provenance: [{ source: "standards", ref: "AGENTS.md", line: 30 }],
    },
  ] };
  const changed = changedSubjectText("+  // forward the auth headers to the provider unchanged\n", ["src/transport/http.ts"]);
  assert.deepEqual(requirementTraceScope(ledger, changed).inScope.map((e) => e.id), ["req-creds"]);
});

test("#1000: spans that do not qualify keep the existing prose behavior", () => {
  // A trailing-hyphen fragment is not an atomic term and stays in the prose
  // stream exactly as before #1000.
  assert.deepEqual(requirementSubjectSignals("The `sk-` families MUST be masked.").phrases.map((p) => p.join(" ")), ["sk families"]);
  // A separator-less span is untouched.
  assert.deepEqual(requirementSubjectSignals("Compare `sourceSha` against the head.").strongTerms, ["sourcesha"]);
  // An oversized span must not build a huge match pattern (never-throw).
  const long = "x".repeat(20_000);
  assert.doesNotThrow(() => requirementSubjectSignals(`The \`${long}-${long}\` value MUST hold.`));
});

test("#1000: two spans separated by a separator survive span pairing", () => {
  // The span scan must pair backticks, not let a required separator fuse the
  // gap between two spans ("` / `") and swallow the next span's opening
  // backtick — the first cut of this fix did exactly that, leaving
  // `x-api-key` in the prose stream and the leak open.
  const signals = requirementSubjectSignals("e.g. `Authorization: Bearer` / `x-api-key` over the seam");
  assert.deepEqual(signals.phrases.map((p) => p.join(" ")), ["Authorization Bearer", "x-api-key"]);
  assert.deepEqual(signals.strongTerms, []);
});

test("#1000: an unbalanced backtick cannot resurrect the fabricated phrase", () => {
  // A stray or lost closing backtick is common in copy-pasted issue text.
  // With the span unpaired, `x-api-key` used to stay in the prose stream and
  // the original "api key" -> `apikey` fabrication returned (verified
  // end-to-end against the first cut of this fix).
  const scoped = (id: string, text: string, changed: string): string[] =>
    requirementTraceScope({ requirements: [{ id, text, kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 1 }] }] }, changed).inScope.map((e) => e.id);
  assert.deepEqual(
    scoped(
      "req-stray",
      "The `x-api-key header name MUST not appear in logs.",
      changedSubjectText('+  redactSourceText(`{"apiKey": "sk-x"}`);\n', ["src/context/redact.ts"]),
    ),
    [],
  );
  // The span's surviving head still matches its literal.
  assert.deepEqual(
    scoped(
      "req-stray-head",
      "The `x-api-key header name MUST not appear in logs.",
      changedSubjectText('+  headers.set("x-api-key", key);\n', ["src/transport/http.ts"]),
    ),
    ["req-stray-head"],
  );
});

test("#1000: a short separator-bearing span is not a loose substring term", () => {
  // `a-b` is 3 chars: below the atomic floor, it must stay prose (where its
  // words are dropped as single characters) rather than become a bare
  // substring term that matches `a-b-c` in any diff.
  const scoped = (id: string, text: string, changed: string): string[] =>
    requirementTraceScope({ requirements: [{ id, text, kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 1 }] }] }, changed).inScope.map((e) => e.id);
  assert.deepEqual(
    scoped("req-ab", "The `a-b` connector MUST be deprecated.", changedSubjectText('+  // version: a-b-c\n', ["src/a.ts"])),
    [],
  );
});

test("#1000: span tokens are normalized before qualifying", () => {
  // Edge separators and punctuation must not survive into the atomic term:
  // `---x-api-key` and `x-api-key,` both yield the term `x-api-key`, which
  // matches the literal in a diff.
  const signals = requirementSubjectSignals("see `---x-api-key and` plus `x-api-key,` headers");
  assert.deepEqual(signals.phrases.map((p) => p.join(" ")), ["x-api-key"]);
});

test("#1000: a terminated span with embedded prose yields its identifier, not a sentence", () => {
  // `x-api-key and` (sloppy span, trailing prose inside the backticks) must
  // contribute the identifier as an atomic term and return the prose to the
  // stream — not fuse the whole body into one unmatchable literal, and not
  // fabricate "api key" either.
  const signals = requirementSubjectSignals("The `x-api-key and` header MUST be masked.");
  assert.deepEqual(signals.phrases.map((p) => p.join(" ")), ["x-api-key"]);
  const scoped = requirementTraceScope(
    { requirements: [{ id: "req-span", text: "The `x-api-key and` header MUST be masked.", kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 1 }] }] },
    changedSubjectText('+  headers.set("x-api-key", key);\n', ["src/transport/http.ts"]),
  );
  assert.deepEqual(scoped.inScope.map((e) => e.id), ["req-span"]);
});

// ── #959: a verdict with zero trace claims ──────────────────────────────

test("#959: a missing-claim row renders its own reason, not 'no valid enforcement location'", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "acceptance" }]);
    const trace = validateRequirementTrace([], ledger, workspace);
    const md = renderRequirementTraceMarkdown(trace);
    assert.match(md, /the reviewer reported no trace for this requirement/);
    assert.doesNotMatch(md, /no valid enforcement location/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#959: a present claim with no usable location still renders 'no valid enforcement location'", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "acceptance" }]);
    const trace = validateRequirementTrace(
      [{ requirement_id: "req-1", disposition: "unmet", enforcement: [], test: [], reason: "no check exists" }],
      ledger,
      workspace,
    );
    const md = renderRequirementTraceMarkdown(trace);
    assert.match(md, /no valid enforcement location/);
    assert.doesNotMatch(md, /reported no trace/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#959 acceptance: a verdict with the trace fields omitted renders the missing-trace reason and stays incomplete", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([
      { id: "req-1", text: "must validate X", kind: "acceptance" },
      { id: "req-2", text: "must validate Y", kind: "acceptance" },
    ]);
    // The #947 shape: no `requirement_coverage` key at all.
    const art = artifact({});
    const result = applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    assert.equal(result.trace.rows.length, 2);
    for (const row of result.trace.rows) {
      assert.equal(row.disposition, "unverifiable");
      assert.ok(row.notes.includes("not-traced-by-reviewer"), JSON.stringify(row));
    }
    assert.equal(result.trace.incomplete, true);
    assert.equal(art.required_checks, "incomplete");
    assert.match(art.review_markdown, /the reviewer reported no trace for this requirement/);
    assert.doesNotMatch(art.review_markdown, /no valid enforcement location/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#959 acceptance: an explicit null requirement_coverage takes the same missing-trace path", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "acceptance" }]);
    const art = artifact({ requirement_coverage: null });
    const result = applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    assert.equal(result.trace.rows[0]?.disposition, "unverifiable");
    assert.ok(result.trace.rows[0]?.notes.includes("not-traced-by-reviewer"));
    assert.equal(result.trace.incomplete, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#959: missingTraceRequirementIds distinguishes a missing claim from an unusable one", () => {
  const coverage = [
    { requirement_id: "req-1", disposition: "met", enforcement: [] },
    { disposition: "met" },
    "junk",
    { requirement_id: "req-3", disposition: "unmet", reason: "gap" },
  ];
  assert.deepEqual(missingTraceRequirementIds(coverage, ["req-1", "req-2", "req-3"]), ["req-2"]);
  assert.deepEqual(missingTraceRequirementIds(null, ["req-1"]), ["req-1"]);
  assert.deepEqual(missingTraceRequirementIds(coverage, []), []);
});

test("#959: mergeTraceClaims appends only ids with no existing claim, never overwriting one", () => {
  const existing = [{ requirement_id: "req-1", disposition: "met", enforcement: [] }];
  const merged = mergeTraceClaims(existing, [
    { requirement_id: "req-1", disposition: "met", enforcement: [{ file: "src/x.ts", line: 1 }] },
    { requirement_id: "req-2", disposition: "met", enforcement: [{ file: "src/y.ts", line: 1 }] },
    "junk",
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], existing[0]);
  assert.equal((merged[1] as { requirement_id: string }).requirement_id, "req-2");
  assert.deepEqual(mergeTraceClaims(undefined, [{ requirement_id: "req-9" }]), [{ requirement_id: "req-9" }]);
  // Defensive: a non-array `repaired` must not throw (the "never throws" contract).
  assert.deepEqual(mergeTraceClaims(existing, undefined), existing);
});

test("#959: a hostile repair reason cannot forge a heading or bullet in the trace section", () => {
  const parsed = normalizeTraceRepairPayload(
    { requirement_coverage: [{ requirement_id: "req-1", disposition: "unverifiable", reason: "line one\n## Hacked heading\n- forged bullet" }] },
    new Set(["req-1"]),
  );
  const reason = String(parsed.claims[0]!.reason);
  assert.doesNotMatch(reason, /\n/);
  assert.match(reason, /## Hacked heading/); // content kept, structure neutralized
});

test("#959: ledgerRequirementsById returns only the requested acceptance/normative entries", () => {
  const ledger = { requirements: [
    { id: "req-1", text: "must validate X", kind: "acceptance" },
    { id: "req-2", text: "must validate Y", kind: "invariant" },
    { id: "req-3", text: "must validate Z", kind: "normative" },
  ] };
  assert.deepEqual(ledgerRequirementsById(ledger, ["req-1", "req-2", "req-3"]).map((e) => e.id), ["req-1", "req-3"]);
});

test("#959: normalizeTraceRepairPayload keeps only requested ids and sanitizes locations", () => {
  const allowed = new Set(["req-1"]);
  const parsed = normalizeTraceRepairPayload(
    {
      requirement_coverage: [
        {
          requirement_id: "req-1",
          disposition: "met",
          enforcement: [{ file: "src/a.ts", line: 2 }, { file: "", line: 3 }, { file: "src/b.ts", line: -1 }],
          test: [{ file: "tests/a.test.ts", line: 1 }],
          reason: "compares X",
          symbol: "sourceSha",
        },
        { requirement_id: "req-2", disposition: "met" },
        "junk",
        { disposition: "met" },
      ],
    },
    allowed,
  );
  assert.deepEqual(parsed.claims, [{
    requirement_id: "req-1",
    disposition: "met",
    enforcement: [{ file: "src/a.ts", line: 2 }],
    test: [{ file: "tests/a.test.ts", line: 1 }],
    reason: "compares X",
    symbol: "sourceSha",
  }]);
  assert.ok(parsed.errors.some((e) => e.includes("not requested")), JSON.stringify(parsed.errors));
  // A bare list is accepted; an unrequested-only payload yields nothing.
  assert.equal(normalizeTraceRepairPayload([{ requirement_id: "req-2", disposition: "met" }], allowed).claims.length, 0);
});

test("#959: the repair user message fences untrusted content and names the requested ids", () => {
  const [user] = buildTraceRepairUserMessage({
    requirements: [{ id: "req-1", text: "must validate X ``` close" }],
    title: "t",
    files: ["src/a.ts"],
    diff: "diff --git a/src/a.ts b/src/a.ts\n+const x = 1;\n",
  });
  assert.match(user, /req-1: must validate X/);
  // The hostile backtick run must not be able to close the fence.
  assert.match(user, /````/);
  assert.match(user, /untrusted PR content/);
});

test("#959: runRequirementTraceRepairPass is fail-soft and bounded", async () => {
  const config = {
    apiFormat: "openai", model: "m", baseUrl: "http://x", apiKey: "k", maxTokens: 4096,
    temperature: null, responseFormat: "off", tokensParam: "max_tokens", stream: false,
    timeoutSec: 30, inputMaxBytes: 48000,
  };
  const requirements = [{ id: "req-1", text: "must validate X" }];
  const transportFailure = await runRequirementTraceRepairPass({
    requirements, title: "t", files: [], diff: "", config,
    requestFn: () => Promise.reject(new Error("boom")),
  });
  assert.deepEqual(transportFailure.claims, []);
  assert.equal(transportFailure.status, "error");
  assert.equal(transportFailure.errorKind, "transport");

  const timeout = await runRequirementTraceRepairPass({
    requirements, title: "t", files: [], diff: "", config,
    requestFn: () => Promise.resolve({ ok: false, timeout: true, errorMessage: "timed out" }),
  });
  assert.equal(timeout.status, "timeout");

  // A transport that resolves a non-outcome must not throw either.
  const nullOutcome = await runRequirementTraceRepairPass({
    requirements, title: "t", files: [], diff: "", config,
    requestFn: () => Promise.resolve(null as never),
  });
  assert.deepEqual(nullOutcome.claims, []);
  assert.equal(nullOutcome.status, "error");

  const ok = await runRequirementTraceRepairPass({
    requirements, title: "t", files: [], diff: "", config,
    requestFn: () => Promise.resolve({
      ok: true,
      raw: { choices: [{ message: { content: JSON.stringify({ requirement_coverage: [
        { requirement_id: "req-1", disposition: "met", enforcement: [{ file: "src/a.ts", line: 1 }], test: [{ file: "tests/a.test.ts", line: 1 }], reason: "compares" },
      ] }) } }] },
    }),
  });
  assert.equal(ok.status, "ok");
  assert.equal(ok.claims.length, 1);
});

// ── #1044: bounded requirement_trace_repair summary ──────────────────────

function repairResult(status: TraceRepairPassResult["status"], overrides: Partial<TraceRepairPassResult> = {}): TraceRepairPassResult {
  return { claims: [], status, errorKind: null, error: null, diffClipped: false, ...overrides };
}

test("#1044: traceRepairOutcomeSummary maps pass statuses to summary outcomes", () => {
  const base = { attempted: true, outcome: null as null, missingIds: ["req-1"] };
  assert.equal(traceRepairOutcomeSummary({ ...base, result: repairResult("ok", { claims: [{ requirement_id: "req-1" }] }) }).outcome, "merged");
  assert.equal(traceRepairOutcomeSummary({ ...base, result: repairResult("empty") }).outcome, "no_claims");
  assert.equal(traceRepairOutcomeSummary({ ...base, result: repairResult("timeout", { errorKind: "timeout", error: "timed out" }) }).outcome, "timeout");
  assert.equal(traceRepairOutcomeSummary({ ...base, result: repairResult("error", { errorKind: "transport", error: "boom" }) }).outcome, "errored");
  // A null result means the fail-soft boundary caught a throw.
  const thrown = traceRepairOutcomeSummary({ ...base, result: null, thrownError: new Error("boom") });
  assert.equal(thrown.outcome, "errored");
  assert.equal(thrown.error, "boom");
  assert.equal(thrown.status, "error");
  assert.equal(thrown.error_kind, "thrown");
  assert.equal(thrown.claims, 0);
  // Gate facts: the pass never ran.
  const noMissing = traceRepairOutcomeSummary({ attempted: false, outcome: "no_missing_ids", missingIds: [] });
  assert.equal(noMissing.attempted, false);
  assert.equal(noMissing.outcome, "no_missing_ids");
  assert.deepEqual(noMissing.missing_ids, []);
  assert.equal(noMissing.claims, 0);
  const skipped = traceRepairOutcomeSummary({ attempted: false, outcome: "skipped_by_gate", missingIds: ["req-1"] });
  assert.equal(skipped.attempted, false);
  assert.equal(skipped.outcome, "skipped_by_gate");
  // Status passthrough on a completed run.
  const errored = traceRepairOutcomeSummary({ ...base, result: repairResult("error", { errorKind: "malformed", error: "bad json", diffClipped: true }) });
  assert.equal(errored.status, "error");
  assert.equal(errored.error_kind, "malformed");
  assert.equal(errored.error, "bad json");
  assert.equal(errored.diff_clipped, true);
  const merged = traceRepairOutcomeSummary({ ...base, result: repairResult("ok", { claims: [{ requirement_id: "req-1" }] }) });
  assert.equal(merged.status, "ok");
  assert.equal(merged.error_kind, null);
  assert.equal(merged.error, null);
  // For attempted runs the caller passes the POST-merge ids, so `missing_ids`
  // means "ids the pass did not fill" — a partial merge keeps the leftover id.
  const partial = traceRepairOutcomeSummary({ ...base, missingIds: ["req-2"], result: repairResult("ok", { claims: [{ requirement_id: "req-1" }] }) });
  assert.equal(partial.outcome, "merged");
  assert.deepEqual(partial.missing_ids, ["req-2"]);
});

test("#1044: traceRepairOutcomeSummary sanitizes control characters, caps fields, and masks configured credentials", () => {
  const hostile = traceRepairOutcomeSummary({
    attempted: true,
    outcome: null,
    missingIds: ["req-a\n## forged", "req-`x`", "req-a"],
    result: repairResult("error", { errorKind: "transport", error: "line1\nAuthorization: Bearer k\r\n\x00tail" }),
    secrets: ["k"],
  });
  assert.ok(!hostile.missing_ids.some((id) => /[\x00-\x1f\x7f`]/.test(id)), JSON.stringify(hostile.missing_ids));
  assert.deepEqual(hostile.missing_ids, ["req-a## forged", "req-x", "req-a"]);
  assert.ok(!/[\x00-\x1f\x7f]/.test(hostile.error ?? ""), JSON.stringify(hostile.error));
  // #1044 review follow-up: credential-shaped transport text must not
  // survive into the persisted artifact — the configured secret value is
  // masked (and the pattern redactor may also mask bearer-shaped text).
  assert.doesNotMatch(hostile.error ?? "", /Bearer k/);
  assert.match(hostile.error ?? "", /line1/);
  assert.match(hostile.error ?? "", /tail/);
  // Caps: ids deduped and bounded at 48, each at 80 chars; error at 200.
  const many = Array.from({ length: 60 }, (_v, i) => `req-${i}`);
  const capped = traceRepairOutcomeSummary({ attempted: false, outcome: "skipped_by_gate", missingIds: many });
  assert.equal(capped.missing_ids.length, MAX_TRACE_REPAIR_SUMMARY_IDS);
  assert.deepEqual(capped.missing_ids, many.slice(0, MAX_TRACE_REPAIR_SUMMARY_IDS));
  const longId = "req-" + "y".repeat(200);
  assert.equal(traceRepairOutcomeSummary({ attempted: false, outcome: "skipped_by_gate", missingIds: [longId] }).missing_ids[0]?.length, MAX_TRACE_REPAIR_SUMMARY_ID_CHARS);
  const longError = "e".repeat(500);
  assert.equal(traceRepairOutcomeSummary({ attempted: true, outcome: null, missingIds: [], result: repairResult("error", { error: longError }) }).error?.length, MAX_TRACE_REPAIR_SUMMARY_ERROR_CHARS);
});

test("#1044 review follow-up: a canary credential never reaches the persisted repair summary, on either error path", () => {
  // A canary matching no redactText pattern (`sk-` keys, `Bearer` tokens,
  // `key=value`, header-shaped text) so the assertion pins the
  // `maskKnownSecrets` pass itself, not a generic heuristic.
  const canary = "courier-canary-QW7x91";
  const viaResult = traceRepairOutcomeSummary({
    attempted: true,
    outcome: null,
    missingIds: [],
    result: repairResult("error", { errorKind: "transport", error: `connect ECONNREFUSED while calling ${canary}` }),
    secrets: [canary],
  });
  assert.match(viaResult.error ?? "", /ECONNREFUSED/);
  assert.ok(!JSON.stringify(viaResult).includes(canary), JSON.stringify(viaResult));
  const viaThrow = traceRepairOutcomeSummary({
    attempted: true,
    outcome: null,
    missingIds: [],
    result: null,
    thrownError: new Error(`repair attempt ${canary} aborted`),
    secrets: [canary],
  });
  assert.ok(!JSON.stringify(viaThrow).includes(canary), JSON.stringify(viaThrow));
  assert.equal(viaThrow.error_kind, "thrown");
});

test("#1044: a repair-pass failure note drives the repair wording on a missing-claim row", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "acceptance" }]);
    // The note keys off `attempted` + post-merge membership, never the
    // outcome value — "merged" with a still-missing id (a partial merge)
    // IS a row the pass ran for and did not fill.
    for (const outcome of ["no_claims", "errored", "timeout", "merged"] as const) {
      const trace = validateRequirementTrace([], ledger, workspace, undefined, {
        traceRepair: { attempted: true, outcome, missing_ids: ["req-1"], claims: 0, status: "empty", error_kind: null, error: null },
      });
      assert.ok(trace.rows[0]?.notes.includes("not-traced-by-reviewer"), outcome);
      assert.ok(trace.rows[0]?.notes.includes("trace-repair-ran-no-claims"), outcome);
      const md = renderRequirementTraceMarkdown(trace);
      assert.match(md, /the reviewer reported no trace for this requirement, and a bounded repair pass also returned no usable claim/, outcome);
    }
    // A failed id outside the summary's missing_ids does not get the note.
    const other = validateRequirementTrace([], ledger, workspace, undefined, {
      traceRepair: { attempted: true, outcome: "no_claims", missing_ids: ["req-other"], claims: 0 },
    });
    assert.ok(!other.rows[0]?.notes.includes("trace-repair-ran-no-claims"));
    assert.doesNotMatch(renderRequirementTraceMarkdown(other), /bounded repair pass/);
    // Non-attempted summaries never carry the note, even when the id is in
    // their missing_ids (the gate kept the pass off — nobody retried).
    for (const traceRepair of [
      { attempted: false, outcome: "skipped_by_gate" as const, missing_ids: ["req-1"], claims: 0 },
      { attempted: false, outcome: "no_missing_ids" as const, missing_ids: [], claims: 0 },
    ]) {
      const trace = validateRequirementTrace([], ledger, workspace, undefined, { traceRepair });
      assert.ok(!trace.rows[0]?.notes.includes("trace-repair-ran-no-claims"), JSON.stringify(traceRepair));
      const md = renderRequirementTraceMarkdown(trace);
      assert.match(md, /the reviewer reported no trace for this requirement/);
      assert.doesNotMatch(md, /bounded repair pass/);
    }
    // No summary at all: unchanged behavior.
    const absent = validateRequirementTrace([], ledger, workspace);
    assert.doesNotMatch(renderRequirementTraceMarkdown(absent), /bounded repair pass/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1044: a partial merge leaves the still-missing row noted, the filled row not", () => {
  const workspace = makeWorkspace();
  try {
    // Two requirements, the pass returned ok with a claim for req-2 only:
    // the post-merge coverage carries req-2's claim, req-1 is still absent.
    const coverage = [
      { requirement_id: "req-2", disposition: "met", enforcement: [{ file: "src/real.ts", line: 1 }], test: [{ file: "tests/real.test.ts", line: 1 }], reason: "filled by the repair pass" },
    ];
    const ledger = ledgerWith([
      { id: "req-1", text: "must validate X", kind: "acceptance" },
      { id: "req-2", text: "must validate Y", kind: "acceptance" },
    ]);
    const trace = validateRequirementTrace(coverage, ledger, workspace, undefined, {
      traceRepair: { attempted: true, outcome: "merged", missing_ids: ["req-1"], claims: 1, status: "ok" },
    });
    const byId = new Map(trace.rows.map((row) => [row.requirement_id, row]));
    assert.ok(byId.get("req-1")?.notes.includes("not-traced-by-reviewer"));
    assert.ok(byId.get("req-1")?.notes.includes("trace-repair-ran-no-claims"));
    assert.equal(byId.get("req-2")?.disposition, "met");
    assert.ok(!byId.get("req-2")?.notes.includes("trace-repair-ran-no-claims"));
    const md = renderRequirementTraceMarkdown(trace);
    assert.match(md, /req-1` — \*\*unverifiable\*\* \(the reviewer reported no trace for this requirement, and a bounded repair pass also returned no usable claim/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1044: applyRequirementTraceEnforcement threads the repair summary to the rows and render", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "acceptance" }]);
    const art = artifact({});
    const result = applyRequirementTraceEnforcement(art, {
      enabled: true,
      ledger,
      workspace,
      traceRepair: { attempted: true, outcome: "no_claims", missing_ids: ["req-1"], claims: 0, status: "empty" },
    });
    assert.ok(result.trace.rows[0]?.notes.includes("trace-repair-ran-no-claims"));
    assert.match(art.review_markdown, /and a bounded repair pass also returned no usable claim/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ── #962: trusted distributed-enforcement proof topology ────────────────

const FORK_TEST_LOCATIONS = [
  { file: "tests-v3/fork-privileged-checkout.test.ts", line: 1 },
  { file: "tests-v3/fork-feature-defaults.test.ts", line: 1 },
  { file: "tests-v3/fork-secret-boundary.test.ts", line: 1 },
];

const FORK_GROUPS = [
  { name: "privileged-checkout", owners: ["src/fork/privileged-checkout.ts"], tests: ["tests-v3/fork-privileged-checkout.test.ts"] },
  { name: "feature-defaults", owners: ["src/fork/feature-defaults.ts"], tests: ["tests-v3/fork-feature-defaults.test.ts"] },
  {
    name: "secret-boundary",
    owners: ["src/fork/secret-boundary.ts"],
    tests: ["tests-v3/fork-secret-boundary.test.ts"],
  },
] satisfies NonNullable<RequirementOwnership["groups"]>;

const FORK_DISTRIBUTED_OWNERSHIP: RequirementOwnership[] = [{
  match: ["fork", "privilege", "separation"],
  owners: [".github/workflows/ai-pr-review-fork.yaml"],
  groups: FORK_GROUPS,
}];

const UNTRUSTED_TEST_LOCATIONS = [
  { file: "tests-v3/untrusted-redaction.test.ts", line: 1 },
  { file: "tests-v3/untrusted-fence-safe-rendering.test.ts", line: 1 },
  { file: "tests-v3/untrusted-instruction-separation.test.ts", line: 1 },
];

const UNTRUSTED_GROUPS = [
  { name: "redaction", owners: ["src/context/redact.ts"], tests: ["tests-v3/untrusted-redaction.test.ts"] },
  { name: "fence-safe-rendering", owners: ["src/render/fence-safe.ts"], tests: ["tests-v3/untrusted-fence-safe-rendering.test.ts"] },
  { name: "instruction-separation", owners: ["src/prompt/instruction-separation.ts"], tests: ["tests-v3/untrusted-instruction-separation.test.ts"] },
] satisfies NonNullable<RequirementOwnership["groups"]>;

const UNTRUSTED_DISTRIBUTED_OWNERSHIP: RequirementOwnership[] = [{
  match: ["untrusted", "content", "data"],
  owners: ["src/context/redact.ts", "src/render/fence-safe.ts", "src/prompt/instruction-separation.ts"],
  groups: UNTRUSTED_GROUPS,
}];

function traceLedger(id: string, text: string): unknown {
  return ledgerWith([{ id, text, kind: "normative" }]);
}

function metTraceClaim(
  requirementId: string,
  enforcement: Array<{ file: string; line: number }>,
  testLocations: Array<{ file: string; line: number }> = [VALID_TEST_LOCATION],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requirement_id: requirementId,
    disposition: "met",
    enforcement,
    test: testLocations,
    reason: "the cited enforcement and regression-test seams cover the requirement",
    ...extra,
  };
}

function writeForkEnforcementFixture(workspace: string): Array<{ file: string; line: number }> {
  writeFile(workspace, "src/fork/privileged-checkout.ts", [
    "if (fork !== true) throw new Error('fork checkout must not be privileged');",
  ]);
  writeFile(workspace, "src/fork/feature-defaults.ts", [
    "export const forkFeatureDefaults = { toolMode: false, relatedCode: false };",
  ]);
  writeFile(workspace, "src/fork/secret-boundary.ts", [
    "if (isFork && secretsEnabled) throw new Error('fork secrets are blocked');",
  ]);
  writeFile(workspace, "tests-v3/fork-privileged-checkout.test.ts", [
    "assert.equal(privilegedForkCheckout, false);",
  ]);
  writeFile(workspace, "tests-v3/fork-feature-defaults.test.ts", [
    "assert.equal(forkFeatureDefaults.toolMode, false);",
  ]);
  writeFile(workspace, "tests-v3/fork-secret-boundary.test.ts", [
    "assert.equal(secretsForFork, undefined);",
  ]);
  return [
    { file: "src/fork/privileged-checkout.ts", line: 1 },
    { file: "src/fork/feature-defaults.ts", line: 1 },
    { file: "src/fork/secret-boundary.ts", line: 1 },
  ];
}

function writeUntrustedTestFixtures(workspace: string): void {
  writeFile(workspace, "tests-v3/untrusted-redaction.test.ts", ["assert.equal(redact(untrusted), safeContent);"]);
  writeFile(workspace, "tests-v3/untrusted-fence-safe-rendering.test.ts", ["assert.equal(renderedFence, safeFence);"]);
  writeFile(workspace, "tests-v3/untrusted-instruction-separation.test.ts", ["assert.notEqual(instructions, untrustedData);"]);
}

function writeUntrustedEnforcementFixture(workspace: string): Array<{ file: string; line: number }> {
  writeFile(workspace, "src/context/redact.ts", [
    "if (content !== sanitizedContent) throw new Error('unredacted content');",
  ]);
  writeFile(workspace, "src/render/fence-safe.ts", [
    "if (content !== fencedContent) throw new Error('unsafe fence rendering');",
  ]);
  writeFile(workspace, "src/prompt/instruction-separation.ts", [
    "if (instructions !== separatedData.instructions) throw new Error('instructions were not separated');",
  ]);
  writeFile(workspace, "tests-v3/untrusted-redaction.test.ts", ["assert.equal(redact(untrusted), safeContent);"]);
  writeFile(workspace, "tests-v3/untrusted-fence-safe-rendering.test.ts", ["assert.equal(renderedFence, safeFence);"]);
  writeFile(workspace, "tests-v3/untrusted-instruction-separation.test.ts", ["assert.notEqual(instructions, untrustedData);"]);
  return [
    { file: "src/context/redact.ts", line: 1 },
    { file: "src/render/fence-safe.ts", line: 1 },
    { file: "src/prompt/instruction-separation.ts", line: 1 },
  ];
}

function assertUnverifiableWithNotes(
  trace: ReturnType<typeof validateRequirementTrace>,
  requirementId: string,
  notes: string[],
): void {
  const row = trace.rows.find((candidate) => candidate.requirement_id === requirementId);
  assert.equal(row?.disposition, "unverifiable");
  assert.deepEqual(row?.notes, notes);
  assert.equal(trace.incomplete, true);
}

test("#962.1: fork privilege separation is met across three declared seams", () => {
  const workspace = makeWorkspace();
  try {
    const enforcement = writeForkEnforcementFixture(workspace);
    const trace = validateRequirementTrace(
      [metTraceClaim("req-fork", enforcement, FORK_TEST_LOCATIONS)],
      traceLedger("req-fork", STANDARDS_FORK),
      workspace,
      undefined,
      { ownership: FORK_DISTRIBUTED_OWNERSHIP },
    );
    assert.equal(trace.rows[0]?.disposition, "met");
    assert.deepEqual(trace.rows[0]?.notes, []);
    assert.equal(trace.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#962.2: untrusted content is data requires separate redaction and rendering seams", () => {
  const workspace = makeWorkspace();
  try {
    const enforcement = writeUntrustedEnforcementFixture(workspace);
    writeUntrustedTestFixtures(workspace);
    const trace = validateRequirementTrace(
      [metTraceClaim("req-untrusted", enforcement, UNTRUSTED_TEST_LOCATIONS)],
      traceLedger("req-untrusted", STANDARDS_UNTRUSTED),
      workspace,
      undefined,
      { ownership: UNTRUSTED_DISTRIBUTED_OWNERSHIP },
    );
    assert.equal(trace.rows[0]?.disposition, "met");
    assert.deepEqual(trace.rows[0]?.notes, []);
    assert.equal(trace.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#962.3: gateForkForForks() alone leaves two fork seams uncovered", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/gates/fork-gate.ts", ["gateForkForForks();"]);
    writeForkEnforcementFixture(workspace);
    const groups = FORK_GROUPS.map((group) => group.name === "privileged-checkout"
      ? { ...group, owners: ["src/gates/fork-gate.ts"] }
      : group);
    const trace = validateRequirementTrace(
      [metTraceClaim("req-fork", [{ file: "src/gates/fork-gate.ts", line: 1 }], FORK_TEST_LOCATIONS)],
      traceLedger("req-fork", STANDARDS_FORK),
      workspace,
      undefined,
      { ownership: [{ ...FORK_DISTRIBUTED_OWNERSHIP[0]!, groups }] },
    );
    assertUnverifiableWithNotes(trace, "req-fork", [
      "distributed-enforcement-group-uncovered:feature-defaults",
      "distributed-enforcement-group-uncovered:secret-boundary",
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#962.4: redact.ts alone leaves the rendering and instruction seams uncovered", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/context/redact.ts", ["const content = redact(untrustedContent);"]);
    writeUntrustedTestFixtures(workspace);
    const trace = validateRequirementTrace(
      [metTraceClaim("req-untrusted", [{ file: "src/context/redact.ts", line: 1 }], UNTRUSTED_TEST_LOCATIONS)],
      traceLedger("req-untrusted", STANDARDS_UNTRUSTED),
      workspace,
      undefined,
      { ownership: UNTRUSTED_DISTRIBUTED_OWNERSHIP },
    );
    assertUnverifiableWithNotes(trace, "req-untrusted", [
      "distributed-enforcement-group-uncovered:fence-safe-rendering",
      "distributed-enforcement-group-uncovered:instruction-separation",
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#962.5: four valid citations outside all group globs do not buy coverage", () => {
  const workspace = makeWorkspace();
  try {
    const irrelevant = [
      "src/unrelated/a.ts",
      "src/unrelated/b.ts",
      "src/unrelated/c.ts",
      "src/unrelated/d.ts",
    ];
    for (const file of irrelevant) writeFile(workspace, file, ["export const unrelated = true;"]);
    writeForkEnforcementFixture(workspace);
    const ownership = [{
      ...FORK_DISTRIBUTED_OWNERSHIP[0]!,
      groups: FORK_GROUPS,
    }];
    const trace = validateRequirementTrace(
      [metTraceClaim("req-fork", irrelevant.map((file) => ({ file, line: 1 })), FORK_TEST_LOCATIONS)],
      traceLedger("req-fork", STANDARDS_FORK),
      workspace,
      undefined,
      { ownership },
    );
    assertUnverifiableWithNotes(trace, "req-fork", [
      "distributed-enforcement-group-uncovered:feature-defaults",
      "distributed-enforcement-group-uncovered:privileged-checkout",
      "distributed-enforcement-group-uncovered:secret-boundary",
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#962.6: an off-seam predicate cannot launder value copies across covered seams", () => {
  const workspace = makeWorkspace();
  try {
    const copyFiles = [
      "src/context/redact.ts",
      "src/render/fence-safe.ts",
      "src/prompt/instruction-separation.ts",
    ];
    for (const file of copyFiles) writeFile(workspace, file, ["content: other.content,"]);
    writeFile(workspace, "src/unrelated/content-check.ts", ["if (content !== safeContent) throw new Error('mismatch');"]);
    writeUntrustedTestFixtures(workspace);
    const trace = validateRequirementTrace(
      [metTraceClaim("req-untrusted", [
        ...copyFiles.map((file) => ({ file, line: 1 })),
        { file: "src/unrelated/content-check.ts", line: 1 },
      ], UNTRUSTED_TEST_LOCATIONS)],
      traceLedger("req-untrusted", STANDARDS_UNTRUSTED),
      workspace,
      undefined,
      { ownership: UNTRUSTED_DISTRIBUTED_OWNERSHIP },
    );
    assertUnverifiableWithNotes(trace, "req-untrusted", ["enforcement-location-copies-without-comparing"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#962.7: a model-supplied symbol cannot make copied seam values predicate evidence", () => {
  const workspace = makeWorkspace();
  try {
    const copyFiles = [
      "src/context/redact.ts",
      "src/render/fence-safe.ts",
      "src/prompt/instruction-separation.ts",
    ];
    for (const file of copyFiles) {
      writeFile(workspace, file, [
        "export const record = {",
        "  opaqueValue: input.opaqueValue,",
        "  if (opaqueValue !== expectedValue) throw new Error('mismatch');",
      ]);
    }
    writeUntrustedTestFixtures(workspace);
    const trace = validateRequirementTrace(
      [metTraceClaim(
        "req-untrusted",
        copyFiles.map((file) => ({ file, line: 2 })),
        UNTRUSTED_TEST_LOCATIONS,
        { symbol: "opaqueValue" },
      )],
      traceLedger("req-untrusted", STANDARDS_UNTRUSTED),
      workspace,
      undefined,
      { ownership: UNTRUSTED_DISTRIBUTED_OWNERSHIP },
    );
    assertUnverifiableWithNotes(trace, "req-untrusted", ["enforcement-location-copies-without-comparing"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#962.8: overlapping owner globs still require distinct citations per seam", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/fork/gate.ts", ["if (forkPrivilege !== true) throw new Error('blocked');"]);
    writeFile(workspace, "tests/alpha.test.ts", ["assert.equal(alpha, true);"]);
    writeFile(workspace, "tests/beta.test.ts", ["assert.equal(beta, true);"]);
    const ownership: RequirementOwnership[] = [{
      match: ["injective", "coverage"],
      owners: ["src/fork/*.ts"],
      groups: [
        { name: "alpha-seam", owners: ["src/fork/*.ts"], tests: ["tests/alpha.test.ts"] },
        { name: "beta-seam", owners: ["src/fork/*.ts"], tests: ["tests/beta.test.ts"] },
      ],
    }];
    const trace = validateRequirementTrace(
      [metTraceClaim("req-injective", [{ file: "src/fork/gate.ts", line: 1 }], [
        { file: "tests/alpha.test.ts", line: 1 },
        { file: "tests/beta.test.ts", line: 1 },
      ])],
      traceLedger("req-injective", "Injective coverage requires a separate citation for each fork privilege seam."),
      workspace,
      undefined,
      { ownership },
    );
    assertUnverifiableWithNotes(trace, "req-injective", ["distributed-enforcement-group-uncovered:beta-seam"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#962.9: a missing group-specific test citation leaves that test seam uncovered", () => {
  const workspace = makeWorkspace();
  try {
    const enforcement = writeForkEnforcementFixture(workspace);
    const trace = validateRequirementTrace(
      [metTraceClaim("req-fork", enforcement, FORK_TEST_LOCATIONS.slice(0, 2))],
      traceLedger("req-fork", STANDARDS_FORK),
      workspace,
      undefined,
      { ownership: FORK_DISTRIBUTED_OWNERSHIP },
    );
    assertUnverifiableWithNotes(trace, "req-fork", ["distributed-test-group-uncovered:secret-boundary"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#962.10: distributed met rows never emit the narrow missing-location notes", () => {
  const workspace = makeWorkspace();
  try {
    const enforcement = writeForkEnforcementFixture(workspace);
    const trace = validateRequirementTrace(
      [metTraceClaim("req-fork", enforcement, FORK_TEST_LOCATIONS)],
      traceLedger("req-fork", STANDARDS_FORK),
      workspace,
      undefined,
      { ownership: FORK_DISTRIBUTED_OWNERSHIP },
    );
    assert.equal(trace.rows[0]?.disposition, "met");
    const notes = JSON.stringify(trace.rows[0]?.notes ?? []);
    assert.equal(notes, "[]");
    assert.equal(notes.includes("downgraded-no-valid-enforcement-location"), false);
    assert.equal(notes.includes("downgraded-no-valid-test-location"), false);
    assert.equal(trace.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#962.11: fewer than two valid config groups warn and retain plain ownership", () => {
  const parsed = parseRequirementOwners([
    "requirements:",
    "  fork-privilege-separation:",
    "    owners:",
    "      - src/fork/owner.ts",
    "    groups:",
    "      - name: privileged-checkout",
    "        owners:",
    "          - src/fork/privileged.ts",
  ].join("\n"), ".github/pr-reviewer-owners.yml");
  assert.ok(!("malformed" in parsed));
  if ("malformed" in parsed) return;
  assert.deepEqual(parsed.rules, [{
    match: ["fork", "privilege", "separation"],
    owners: ["src/fork/owner.ts"],
  }]);
  assert.ok(parsed.warnings.some((warning) => warning.includes("fewer than 2 valid groups")), JSON.stringify(parsed.warnings));
});

test("#962.12: identical owner globs across distributed groups warn", () => {
  const parsed = parseRequirementOwners([
    "requirements:",
    "  fork-privilege-separation:",
    "    owners:",
    "      - src/fork/owner.ts",
    "    groups:",
    "      - name: alpha-seam",
    "        owners:",
    "          - src/fork/shared.ts",
    "      - name: beta-seam",
    "        owners:",
    "          - src/fork/shared.ts",
  ].join("\n"), ".github/pr-reviewer-owners.yml");
  assert.ok(!("malformed" in parsed));
  if ("malformed" in parsed) return;
  assert.deepEqual(parsed.rules[0]?.groups?.map((group) => group.name), ["alpha-seam", "beta-seam"]);
  assert.ok(parsed.warnings.some((warning) => warning.includes("groups sharing owner glob 'src/fork/shared.ts'")), JSON.stringify(parsed.warnings));
});

test("#962.13: invalid group names and owner globs are dropped while valid groups remain", () => {
  const parsed = parseRequirementOwners([
    "requirements:",
    "  fork-privilege-separation:",
    "    owners:",
    "      - src/fork/owner.ts",
    "    groups:",
    "      - name: alpha-seam",
    "        owners:",
    "          - src/fork/alpha.ts",
    "      - name: invalid_name",
    "        owners:",
    "          - src/fork/invalid-name.ts",
    "      - name: beta-seam",
    "        owners:",
    "          - ../escape.ts",
    "      - name: gamma-seam",
    "        owners:",
    "          - src/fork/gamma.ts",
  ].join("\n"), ".github/pr-reviewer-owners.yml");
  assert.ok(!("malformed" in parsed));
  if ("malformed" in parsed) return;
  assert.deepEqual(parsed.rules[0]?.groups?.map((group) => group.name), ["alpha-seam", "gamma-seam"]);
  assert.ok(parsed.warnings.some((warning) => warning.includes("invalid group name")), JSON.stringify(parsed.warnings));
  assert.ok(parsed.warnings.some((warning) => warning.includes("invalid owner path")), JSON.stringify(parsed.warnings));
});

test("#962.14: distributed hints include only distributed ids in the requested scope", () => {
  const ledger = ledgerWith([
    { id: "req-fork", text: STANDARDS_FORK, kind: "normative" },
    { id: "req-narrow", text: SOURCE_SHA_REQUIREMENT, kind: "acceptance" },
  ]);
  assert.deepEqual(
    distributedRequirementHints(ledger, FORK_DISTRIBUTED_OWNERSHIP, ["req-fork", "req-narrow", "req-missing"]),
    [{ requirementId: "req-fork", groups: ["feature-defaults", "privileged-checkout", "secret-boundary"] }],
  );
});

test("#962.15: prompt hints append seam names, while empty hints preserve the no-hints prompt byte-for-byte", () => {
  const dir = mkdtempSync(join(tmpdir(), "req-trace-distributed-prompt-"));
  try {
    writeFileSync(join(dir, "requirement-ledger-present.txt"), "1\n");
    const workspace = workspaceAt(dir);
    const base = { systemPrompt: "BASE", isDefault: true, addendum: "" };
    const hints = [{ requirementId: "req-fork", groups: ["privileged-checkout", "feature-defaults", "secret-boundary"] }];
    const hinted = applyRequirementTraceFragment(base, workspace, true, undefined, ["req-fork"], hints).systemPrompt;
    const withoutHints = applyRequirementTraceFragment(base, workspace, true, undefined, ["req-fork"]).systemPrompt;
    const emptyHints = applyRequirementTraceFragment(base, workspace, true, undefined, ["req-fork"], []).systemPrompt;
    assert.match(hinted, /Distributed requirements.*`req-fork` → privileged-checkout, feature-defaults, secret-boundary/);
    assert.equal(emptyHints, withoutHints);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#962.16: trace repair messages name the declared distributed seams", () => {
  const [user] = buildTraceRepairUserMessage({
    requirements: [{ id: "req-fork", text: "Fork privilege separation must hold.", groups: ["privileged-checkout", "feature-defaults", "secret-boundary"] }],
    title: "t",
    files: [],
    diff: "",
  });
  assert.match(user, /req-fork: Fork privilege separation must hold\.; distributed seams: privileged-checkout, feature-defaults, secret-boundary/);
});

test("#962.17: claim-supplied groups cannot promote a narrow requirement", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/source-sha-check.ts", [
      "if (record.sourceSha !== context.sourceSha) throw new Error('source SHA mismatch');",
    ]);
    const trace = validateRequirementTrace(
      [metTraceClaim(
        "req-sha",
        [{ file: "src/source-sha-check.ts", line: 1 }],
        [VALID_TEST_LOCATION],
        { groups: [{ name: "invented-seam", owners: ["src/**"] }] },
      )],
      traceLedger("req-sha", SOURCE_SHA_REQUIREMENT),
      workspace,
      undefined,
      { ownership: [{ match: ["source", "sha"], owners: ["src/source-sha-check.ts"] }] },
    );
    assert.equal(trace.rows[0]?.disposition, "met");
    assert.deepEqual(trace.rows[0]?.notes, []);
    assert.equal(trace.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#962.18: a distributed all-stopword requirement still needs a predicate", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/stopwords/first.ts", ["value: other.value,"]);
    writeFile(workspace, "src/stopwords/second.ts", ["value: other.value,"]);
    writeFile(workspace, "tests/stopwords-first.test.ts", ["assert.equal(first.value, other.value);"]);
    writeFile(workspace, "tests/stopwords-second.test.ts", ["assert.equal(second.value, other.value);"]);
    const ownership: RequirementOwnership[] = [{
      match: ["must", "check"],
      owners: ["src/stopwords/*.ts"],
      groups: [
        { name: "first-seam", owners: ["src/stopwords/first.ts"], tests: ["tests/stopwords-first.test.ts"] },
        { name: "second-seam", owners: ["src/stopwords/second.ts"], tests: ["tests/stopwords-second.test.ts"] },
      ],
    }];
    const trace = validateRequirementTrace(
      [metTraceClaim("req-stopwords", [
        { file: "src/stopwords/first.ts", line: 1 },
        { file: "src/stopwords/second.ts", line: 1 },
      ], [
        { file: "tests/stopwords-first.test.ts", line: 1 },
        { file: "tests/stopwords-second.test.ts", line: 1 },
      ])],
      traceLedger("req-stopwords", "must check"),
      workspace,
      undefined,
      { ownership },
    );
    assertUnverifiableWithNotes(trace, "req-stopwords", ["enforcement-location-copies-without-comparing"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#962.19: distributed prompt hints respect the 20-requirement cap", () => {
  const count = MAX_DISTRIBUTED_HINTS + 1;
  const entries = Array.from({ length: count }, (_unused, index) => ({
    id: `req-distributed-${index}`,
    text: `Distributed topology-${index} must hold.`,
    kind: "normative",
  }));
  const ownership: RequirementOwnership[] = entries.map((_entry, index) => ({
    match: [`topology-${index}`],
    owners: [`src/topology/${index}.ts`],
    groups: [
      { name: `seam-${index}-a`, owners: [`src/topology/${index}-a.ts`], tests: [] },
      { name: `seam-${index}-b`, owners: [`src/topology/${index}-b.ts`], tests: [] },
    ],
  }));
  const ledger = ledgerWith(entries);
  const scopeIds = entries.map((entry) => entry.id);
  const hints = distributedRequirementHints(ledger, ownership, scopeIds);
  assert.equal(hints.length, MAX_DISTRIBUTED_HINTS);

  const dir = mkdtempSync(join(tmpdir(), "req-trace-hint-cap-"));
  try {
    writeFileSync(join(dir, "requirement-ledger-present.txt"), "1\n");
    const state = applyRequirementTraceFragment(
      { systemPrompt: "BASE", isDefault: true, addendum: "" },
      workspaceAt(dir),
      true,
      undefined,
      scopeIds,
      hints,
    );
    const hintLine = state.systemPrompt.split("\n").find((line) => line.startsWith("Distributed requirements"));
    assert.ok(hintLine);
    assert.equal((hintLine.match(/→/g) ?? []).length, MAX_DISTRIBUTED_HINTS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#962.20: hostile requirement ids and seam names are neutralized in prompt and rendering", () => {
  const workspace = makeWorkspace();
  const dir = mkdtempSync(join(tmpdir(), "req-trace-hostile-seam-"));
  const hostileId = "req-\u0001bad`tick";
  const hostileGroup = "secret`-boundary";
  try {
    writeFile(workspace, "src/hostile/one.ts", ["if (secret !== safeSecret) throw new Error('mismatch');"]);
    writeFile(workspace, "src/hostile/two.ts", ["if (boundary !== safeBoundary) throw new Error('mismatch');"]);
    writeFile(workspace, "tests/hostile-one.test.ts", ["assert.equal(secret, safeSecret);"]);
    writeFile(workspace, "tests/hostile-two.test.ts", ["assert.equal(boundary, safeBoundary);"]);
    const ownership: RequirementOwnership[] = [{
      match: ["untrusted", "content", "data"],
      owners: ["src/hostile/one.ts", "src/hostile/two.ts"],
      groups: [
        { name: hostileGroup, owners: ["src/hostile/one.ts"], tests: [] },
        { name: "safe-seam", owners: ["src/hostile/two.ts"], tests: ["tests/hostile-two.test.ts"] },
      ],
    }];
    const ledger = traceLedger(hostileId, STANDARDS_UNTRUSTED);
    const hints = distributedRequirementHints(ledger, ownership, [hostileId]);
    assert.equal(hints.length, 1);

    writeFileSync(join(dir, "requirement-ledger-present.txt"), "1\n");
    const prompt = applyRequirementTraceFragment(
      { systemPrompt: "BASE", isDefault: true, addendum: "" },
      workspaceAt(dir),
      true,
      undefined,
      undefined,
      hints,
    ).systemPrompt;
    assert.equal(prompt.includes("\u0001"), false);
    assert.equal(prompt.includes(hostileId), false);
    assert.equal(prompt.includes("bad`tick"), false);
    assert.equal(prompt.includes("secret`-boundary"), false);

    const trace = validateRequirementTrace(
      [{
        requirement_id: hostileId,
        disposition: "met",
        enforcement: [
          { file: "src/hostile/one.ts", line: 1 },
          { file: "src/hostile/two.ts", line: 1 },
        ],
        test: [
          { file: "tests/hostile-one.test.ts", line: 1 },
          { file: "tests/hostile-two.test.ts", line: 1 },
        ],
        reason: "the trusted seams are cited",
      }],
      ledger,
      workspace,
      undefined,
      { ownership },
    );
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.equal(trace.rows[0]?.notes.includes("distributed-test-group-uncovered:secret`-boundary"), true);
    assert.equal(trace.incomplete, true);

    const failedTrace = {
      ...trace,
      incomplete: true,
      rows: [{
        requirement_id: hostileId,
        disposition: "unverifiable",
        enforcement: [{ file: "src/hostile/one.ts", line: 1 }],
        test: [],
        reason: "missing a seam",
        proof: "distributed",
        notes: [`distributed-enforcement-group-uncovered:${hostileGroup}`],
      }],
    };
    const rendered = renderRequirementTraceMarkdown(failedTrace);
    assert.equal(rendered.includes("secret`-boundary"), false);
    assert.equal(rendered.includes("\u0001"), false);
    assert.equal(rendered.includes("bad`tick"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#962.21: a group without test globs cannot use generic test evidence", () => {
  const workspace = makeWorkspace();
  try {
    const enforcement = writeForkEnforcementFixture(workspace);
    const ownership: RequirementOwnership[] = [{
      ...FORK_DISTRIBUTED_OWNERSHIP[0]!,
      groups: FORK_GROUPS.map((group) => group.name === "secret-boundary" ? { ...group, tests: [] } : group),
    }];
    const testLocations = [...FORK_TEST_LOCATIONS.slice(0, 2), VALID_TEST_LOCATION];
    const trace = validateRequirementTrace(
      [metTraceClaim("req-fork", enforcement, testLocations)],
      traceLedger("req-fork", STANDARDS_FORK),
      workspace,
      undefined,
      { ownership },
    );
    assertUnverifiableWithNotes(trace, "req-fork", ["distributed-test-group-uncovered:secret-boundary"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#962.22: topology overflow fails closed despite a complete five-seam proof", () => {
  const workspace = makeWorkspace();
  try {
    const groups = Array.from({ length: 5 }, (_unused, index) => {
      const seam = `seam-${index + 1}`;
      const enforcementFile = `src/overflow/${seam}.ts`;
      const testFile = `tests-v3/overflow/${seam}.test.ts`;
      writeFile(workspace, enforcementFile, ["if (topology !== expectedTopology) throw new Error('mismatch');"]);
      writeFile(workspace, testFile, ["assert.ok(topology);"]);
      return { name: seam, owners: [enforcementFile], tests: [testFile] };
    });
    const trace = validateRequirementTrace(
      [metTraceClaim(
        "req-overflow",
        groups.map((group) => ({ file: group.owners[0]!, line: 1 })),
        groups.map((group) => ({ file: group.tests[0]!, line: 1 })),
      )],
      traceLedger("req-overflow", "Overflow topology enforcement must remain protected."),
      workspace,
      undefined,
      { ownership: [{ match: ["overflow", "topology"], owners: ["src/overflow/**"], groups }] },
    );
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.deepEqual(trace.rows[0]?.notes, ["distributed-topology-overflow"]);
    assert.equal(trace.incomplete, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#962.23: distributed hints omit overflowed requirements from the same ledger", () => {
  const overflowGroups = Array.from({ length: 5 }, (_unused, index) => ({
    name: `overflow-seam-${index + 1}`,
    owners: [`src/overflow/seam-${index + 1}.ts`],
    tests: [`tests-v3/overflow/seam-${index + 1}.test.ts`],
  }));
  const ownership: RequirementOwnership[] = [
    { match: ["overflow", "topology"], owners: ["src/overflow/**"], groups: overflowGroups },
    ...FORK_DISTRIBUTED_OWNERSHIP,
  ];
  const ledger = ledgerWith([
    { id: "req-overflow", text: "Overflow topology must remain protected.", kind: "normative" },
    { id: "req-fork", text: STANDARDS_FORK, kind: "normative" },
  ]);
  assert.deepEqual(
    distributedRequirementHints(ledger, ownership, ["req-overflow", "req-fork"]),
    [{ requirementId: "req-fork", groups: ["feature-defaults", "privileged-checkout", "secret-boundary"] }],
  );
});

test("#962.24: parseRequirementOwners caps declared groups and warns with dropped names", () => {
  const groups = Array.from({ length: MAX_DECLARED_GROUPS_PER_RULE + 1 }, (_unused, index) => {
    const name = `group-${String(index + 1).padStart(2, "0")}`;
    return [
      `      - name: ${name}`,
      `        owners:`,
      `          - src/groups/${name}.ts`,
      `        tests:`,
      `          - tests/groups/${name}.test.ts`,
    ];
  }).flat();
  const parsed = parseRequirementOwners([
    "requirements:",
    "  distributed-rule:",
    "    owners:",
    "      - src/groups/owner.ts",
    "    groups:",
    ...groups,
  ].join("\n"), ".github/pr-reviewer-owners.yml");
  assert.ok(!("malformed" in parsed));
  if ("malformed" in parsed) return;
  assert.equal(parsed.rules[0]?.groups?.length, MAX_DECLARED_GROUPS_PER_RULE);
  assert.ok(parsed.warnings.some((warning) =>
    warning.includes(`exceeds ${MAX_DECLARED_GROUPS_PER_RULE} declared groups`) && warning.includes("dropped: group-17"),
  ), JSON.stringify(parsed.warnings));
});

// ── #985: deterministic structural-state proofs ─────────────────────────

test("#985: a satisfied structural negative-state claim needs no test", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, ".dockerignore", ["node_modules/", "dist/"]);
    const ledger = ledgerWith([{ id: "req-ignore", text: "`.dockerignore` must not exclude `assets/`", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-ignore",
      disposition: "met",
      enforcement: [{ file: ".dockerignore", line: 1 }],
      test: [],
      reason: "assets/ is not excluded by the ignore file",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "met");
    assert.equal(trace.rows[0]?.proof, "structural_state");
    assert.deepEqual(trace.rows[0]?.notes, []);
    assert.equal(trace.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: a met structural trace does not withhold approval", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, ".dockerignore", ["node_modules/", "dist/"]);
    const ledger = ledgerWith([{ id: "req-ignore", text: "`.dockerignore` must not exclude `assets/`", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-ignore",
      disposition: "met",
      enforcement: [{ file: ".dockerignore", line: 1 }],
      test: [],
      reason: "assets/ is not excluded by the ignore file",
    }];
    const art = artifact({ requirement_coverage: claims });
    const result = applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    assert.equal(result.trace.rows[0]?.disposition, "met");
    assert.notEqual(art.requirement_trace_incomplete, true);
    assert.notEqual(art.required_checks, "incomplete");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: a structural negative-state claim is refuted by an excluding entry", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, ".dockerignore", ["node_modules/", "assets/"]);
    const ledger = ledgerWith([{ id: "req-ignore", text: "`.dockerignore` must not exclude `assets/`", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-ignore",
      disposition: "met",
      enforcement: [{ file: ".dockerignore", line: 1 }],
      test: [],
      reason: "assets/ should not be excluded",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.ok(trace.rows[0]?.notes.includes("structural-proof-unconfirmed"));
    assert.equal(trace.incomplete, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: a satisfied structural positive-state claim needs no test", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "package.json", ['{"dependencies":{"left-pad":"1.0.0"}}']);
    const ledger = ledgerWith([{ id: "req-package", text: "`package.json` must contain `left-pad`", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-package",
      disposition: "met",
      enforcement: [{ file: "package.json", line: 1 }],
      test: [],
      reason: "left-pad is listed in package.json",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "met");
    assert.equal(trace.rows[0]?.proof, "structural_state");
    assert.deepEqual(trace.rows[0]?.notes, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: a structural positive-state claim is refuted when its literal is absent", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "package.json", ['{"dependencies":{"left-pad":"1.0.0"}}']);
    const ledger = ledgerWith([{ id: "req-package", text: "`package.json` must contain `right-pad`", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-package",
      disposition: "met",
      enforcement: [{ file: "package.json", line: 1 }],
      test: [],
      reason: "right-pad is listed in package.json",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.ok(trace.rows[0]?.notes.includes("structural-proof-unconfirmed"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: a structural requirement that explicitly demands a test needs one", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, ".dockerignore", ["node_modules/", "dist/"]);
    const text = "`.dockerignore` must not exclude `assets/` and must be covered by a regression test";
    const ledger = ledgerWith([{ id: "req-ignore-test", text, kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-ignore-test",
      disposition: "met",
      enforcement: [{ file: ".dockerignore", line: 1 }],
      test: [],
      reason: "assets/ is absent from the ignore file",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.proof, "structural_state");
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.ok(trace.rows[0]?.notes.includes("downgraded-no-valid-test-location"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: an explicitly test-required structural claim passes with a valid test citation", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, ".dockerignore", ["node_modules/", "dist/"]);
    const text = "`.dockerignore` must not exclude `assets/` and must be covered by a regression test";
    const ledger = ledgerWith([{ id: "req-ignore-test", text, kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-ignore-test",
      disposition: "met",
      enforcement: [{ file: ".dockerignore", line: 1 }],
      test: [VALID_TEST_LOCATION],
      reason: "assets/ is absent and a regression test covers the rule",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "met");
    assert.equal(trace.rows[0]?.proof, "structural_state");
    assert.deepEqual(trace.rows[0]?.notes, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: the runtime predicate guard still rejects a value copy with a valid test", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/context-resolution.ts", ["sourceSha: ctx.sourceSha,"]);
    const ledger = ledgerWith([{ id: "req-sha", text: SOURCE_SHA_REQUIREMENT, kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-sha",
      disposition: "met",
      enforcement: [{ file: "src/context-resolution.ts", line: 1 }],
      test: [VALID_TEST_LOCATION],
      reason: "copies sourceSha to the resolved pull",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.proof, "runtime_behavior");
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.ok(trace.rows[0]?.notes.includes("enforcement-location-copies-without-comparing"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: naming a source file keeps the requirement on the strict path", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-source", text: "`src/real.ts` must contain `foo`", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-source",
      disposition: "met",
      enforcement: [{ file: "src/real.ts", line: 1 }],
      test: [],
      reason: "foo is present in the source file",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.proof, "runtime_behavior");
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.ok(trace.rows[0]?.notes.includes("downgraded-no-valid-test-location"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: a subordinate-clause negation is not structural state", () => {
  const workspace = makeWorkspace();
  try {
    const text = "The loader must fail when `config.yaml` does not contain `api_key`";
    const ledger = ledgerWith([{ id: "req-loader", text, kind: "acceptance" }]);
    const trace = validateRequirementTrace([], ledger, workspace);
    assert.equal(trace.rows[0]?.proof, "runtime_behavior");
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: an unquoted literal cannot create a vacuous structural claim", () => {
  const workspace = makeWorkspace();
  try {
    const text = "`config/production.yaml` must omit debug logging";
    const ledger = ledgerWith([{ id: "req-config", text, kind: "acceptance" }]);
    const trace = validateRequirementTrace([], ledger, workspace);
    assert.equal(trace.rows[0]?.proof, "runtime_behavior");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: an extensionless script is not a structural-state file target", () => {
  const workspace = makeWorkspace();
  try {
    const text = "`scripts/entrypoint` must not include `curl`";
    const ledger = ledgerWith([{ id: "req-script", text, kind: "acceptance" }]);
    const trace = validateRequirementTrace([], ledger, workspace);
    assert.equal(trace.rows[0]?.proof, "runtime_behavior");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: a matching gitignore glob prevents a negative-state proof", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, ".gitignore", ["**/dist/"]);
    const ledger = ledgerWith([{ id: "req-ignore", text: "`.gitignore` must not list `dist/`", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-ignore",
      disposition: "met",
      enforcement: [{ file: ".gitignore", line: 1 }],
      test: [],
      reason: "dist/ is not listed literally",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.proof, "structural_state");
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.ok(trace.rows[0]?.notes.includes("structural-proof-unconfirmed"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: an un-ignore pattern does not count as an exclusion", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, ".gitignore", ["!assets/"]);
    const ledger = ledgerWith([{ id: "req-ignore", text: "`.gitignore` must not exclude `assets/`", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-ignore",
      disposition: "met",
      enforcement: [{ file: ".gitignore", line: 1 }],
      test: [],
      reason: "assets/ is explicitly un-ignored",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "met");
    assert.equal(trace.rows[0]?.proof, "structural_state");
    assert.deepEqual(trace.rows[0]?.notes, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: a citation to the wrong file cannot prove a structural state", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "package.json", ['{"private":true}']);
    writeFile(workspace, "tests/fixtures/package.json", ['{"dependencies":{"left-pad":"1.0.0"}}']);
    const ledger = ledgerWith([{ id: "req-package", text: "Root `package.json` must not list `left-pad`", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-package",
      disposition: "met",
      enforcement: [{ file: "tests/fixtures/package.json", line: 1 }],
      test: [],
      reason: "the fixture package lists left-pad",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    // The citation must name the file the requirement names, so a citation to
    // a different (fixture) file is no valid enforcement location at all.
    assert.ok(trace.rows[0]?.notes.includes("downgraded-no-valid-enforcement-location"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: existence and absence assertions are checked against the workspace", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "package.json", ['{"private":true}']);
    const existsLedger = ledgerWith([{ id: "req-exists", text: "`package.json` must exist", kind: "acceptance" }]);
    const existsClaims = [{
      requirement_id: "req-exists",
      disposition: "met",
      enforcement: [{ file: "package.json", line: 1 }],
      test: [],
      reason: "package.json exists in the checkout",
    }];
    const existsTrace = validateRequirementTrace(existsClaims, existsLedger, workspace);
    assert.equal(existsTrace.rows[0]?.proof, "structural_state");
    assert.equal(existsTrace.rows[0]?.disposition, "met");

    const absentLedger = ledgerWith([{ id: "req-absent", text: "`package.json` must be absent", kind: "acceptance" }]);
    const absentClaims = [{
      requirement_id: "req-absent",
      disposition: "met",
      enforcement: [{ file: "package.json", line: 1 }],
      test: [],
      reason: "package.json is absent",
    }];
    const absentTrace = validateRequirementTrace(absentClaims, absentLedger, workspace);
    assert.equal(absentTrace.rows[0]?.proof, "structural_state");
    assert.equal(absentTrace.rows[0]?.disposition, "unverifiable");
    assert.ok(absentTrace.rows[0]?.notes.includes("structural-proof-unconfirmed"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: every trace row has a proof kind and out-of-scope rows are not applicable", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = {
      requirements: [
        { id: "req-issue", text: SOURCE_SHA_REQUIREMENT, kind: "acceptance", provenance: [{ source: "linked_issues", ref: "#985", line: 1 }] },
        { id: "req-package", text: "`package.json` must contain `left-pad`", kind: "normative", provenance: [{ source: "standards", ref: "AGENTS.md", line: 2 }] },
      ],
    };
    const changed = changedSubjectText("+  const unrelated = true;\n", ["src/unrelated.ts"]);
    const trace = validateRequirementTrace([], ledger, workspace, changed);
    assert.equal(trace.rows.length, 2);
    assert.ok(trace.rows.every((row) => typeof row.proof === "string" && row.proof.length > 0));
    assert.equal(trace.rows.find((row) => row.requirement_id === "req-package")?.proof, "not_applicable");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: exported proof classifiers pin polarity, vetoes, and explicit test demands", () => {
  assert.deepEqual(structuralStateClaim("`package.json` must contain `left-pad`"), {
    file: "package.json", literal: "left-pad", presence: true, mode: "content",
  });
  assert.deepEqual(structuralStateClaim("`package.json` must not contain `left-pad`"), {
    file: "package.json", literal: "left-pad", presence: false, mode: "content",
  });
  assert.deepEqual(structuralStateClaim("`.gitignore` must omit `dist/`"), {
    file: ".gitignore", literal: "dist/", presence: false, mode: "content",
  });
  assert.deepEqual(structuralStateClaim("`.gitignore` must not omit `dist/`"), {
    file: ".gitignore", literal: "dist/", presence: true, mode: "content",
  });
  assert.equal(structuralStateClaim("The loader must fail when `config.yaml` does not contain `api_key`"), null);
  assert.equal(structuralStateClaim("`config/production.yaml` must omit debug logging"), null);
  assert.equal(explicitlyRequiresTest("`.dockerignore` must not exclude `assets/`"), false);
  assert.equal(explicitlyRequiresTest("`.dockerignore` must not exclude `assets/` and must be covered by a regression test"), true);
});

test("#985: multiple named config files do not form a vacuous structural claim", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "a.json", ["b.json"]);
    writeFile(workspace, "b.json", ["{}"]);
    const text = "`a.json` and `b.json` must contain `x`";
    const ledger = ledgerWith([{ id: "req-multiple-configs", text, kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-multiple-configs",
      disposition: "met",
      enforcement: [{ file: "a.json", line: 1 }],
      test: [VALID_TEST_LOCATION],
      reason: "the named config files contain x",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.equal(trace.rows[0]?.proof, "runtime_behavior");
    assert.equal(structuralStateClaim(text), null);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: a file named after the assertion is only a locator, not a state claim", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "sample-error.json", ['{"code":500}']);
    const text = "Error responses must not include `stack_trace` in `sample-error.json`";
    const ledger = ledgerWith([{ id: "req-error-response", text, kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-error-response",
      disposition: "met",
      enforcement: [{ file: "sample-error.json", line: 1 }],
      test: [VALID_TEST_LOCATION],
      reason: "the sample error response omits stack_trace",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.equal(trace.rows[0]?.proof, "runtime_behavior");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: a compound existence-plus-content claim stays on the strict path", () => {
  const workspace = makeWorkspace();
  try {
    mkdirSync(join(workspace, "config"), { recursive: true });
    writeFileSync(join(workspace, "config", "settings.yaml"), "");
    const text = "`config/settings.yaml` must exist and must contain `secret_key`";
    // The claim cannot represent both conjuncts, so the validator declines the
    // structural shape rather than certifying a subset of what it asserts.
    assert.equal(structuralStateClaim(text), null);
    const ledger = ledgerWith([{ id: "req-settings", text, kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-settings",
      disposition: "met",
      enforcement: [{ file: "config/settings.yaml", line: 1 }],
      test: [VALID_TEST_LOCATION],
      reason: "the settings file exists and contains secret_key",
    }];
    const emptyTrace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(emptyTrace.rows[0]?.disposition, "unverifiable");
    assert.equal(emptyTrace.rows[0]?.proof, "runtime_behavior");

    // Populating the file does not change the classification — the shape is
    // still compound, so the strict path still applies.
    writeFile(workspace, "config/settings.yaml", ["secret_key: abc"]);
    const populatedTrace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(populatedTrace.rows[0]?.disposition, "unverifiable");
    assert.equal(populatedTrace.rows[0]?.proof, "runtime_behavior");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: an unmodellable ignore pattern fails closed", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, ".gitignore", ["[a]ssets/"]);
    const ledger = ledgerWith([{ id: "req-no-assets-ignore", text: "`.gitignore` must not exclude `assets/`", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-no-assets-ignore",
      disposition: "met",
      enforcement: [{ file: ".gitignore", line: 1 }],
      test: [],
      reason: "assets/ is not excluded",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.ok(trace.rows[0]?.notes.includes("structural-proof-unconfirmed"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: an ignore negation cannot prove positive content but permits a negative claim", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, ".npmignore", ["!build/"]);
    const positiveText = "`.npmignore` must not omit `build/`";
    const positiveLedger = ledgerWith([{ id: "req-build-present", text: positiveText, kind: "acceptance" }]);
    const positiveClaims = [{
      requirement_id: "req-build-present",
      disposition: "met",
      enforcement: [{ file: ".npmignore", line: 1 }],
      test: [],
      reason: "build/ is present",
    }];
    const positiveTrace = validateRequirementTrace(positiveClaims, positiveLedger, workspace);
    assert.equal(positiveTrace.rows[0]?.disposition, "unverifiable");

    const negativeText = "`.npmignore` must not exclude `build/`";
    const negativeLedger = ledgerWith([{ id: "req-build-not-excluded", text: negativeText, kind: "acceptance" }]);
    const negativeClaims = [{
      requirement_id: "req-build-not-excluded",
      disposition: "met",
      enforcement: [{ file: ".npmignore", line: 1 }],
      test: [],
      reason: "the negation line does not exclude build/",
    }];
    const negativeTrace = validateRequirementTrace(negativeClaims, negativeLedger, workspace);
    assert.equal(negativeTrace.rows[0]?.disposition, "met");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: an empty ignore file satisfies a negative-state claim", () => {
  const workspace = makeWorkspace();
  try {
    writeFileSync(join(workspace, ".dockerignore"), "");
    const ledger = ledgerWith([{ id: "req-no-assets-ignore", text: "`.dockerignore` must not exclude `assets/`", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-no-assets-ignore",
      disposition: "met",
      enforcement: [{ file: ".dockerignore", line: 1 }],
      test: [],
      reason: "the empty ignore file excludes no paths",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "met");
    assert.equal(trace.rows[0]?.proof, "structural_state");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: an ignore file outside the shared extension list is a structural target", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, ".npmignore", ["node_modules/"]);
    const ledger = ledgerWith([{ id: "req-no-assets-ignore", text: "`.npmignore` must not exclude `assets/`", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-no-assets-ignore",
      disposition: "met",
      enforcement: [{ file: ".npmignore", line: 1 }],
      test: [],
      reason: "assets/ is not excluded by the npm ignore file",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "met");
    assert.equal(trace.rows[0]?.proof, "structural_state");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: an over-long literal is not a structural-state claim", () => {
  assert.equal(structuralStateClaim("`.dockerignore` must not exclude `" + "z".repeat(300) + "`"), null);
});

test("#985: rendered structural-state traces explain a failed check", () => {
  const trace = {
    version: 1,
    rows: [{
      requirement_id: "req-x",
      disposition: "unverifiable",
      proof: "structural_state",
      enforcement: [{ file: ".dockerignore", line: 1 }],
      test: [],
      reason: "",
      notes: ["structural-proof-unconfirmed"],
    }],
    incomplete: true,
    errors: [],
  };
  assert.ok(renderRequirementTraceMarkdown(trace).includes("does not satisfy the requirement"));
});

test("#985: positive structural content uses token-bounded literals", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "policy.yaml", ["enable_audit_logger: false"]);
    const ledger = ledgerWith([{ id: "req-policy", text: "`policy.yaml` must contain `enable_audit_log`", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-policy",
      disposition: "met",
      enforcement: [{ file: "policy.yaml", line: 1 }],
      test: [],
      reason: "enable_audit_log is present in policy.yaml",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.ok(trace.rows[0]?.notes.includes("structural-proof-unconfirmed"));

    writeFile(workspace, "policy2.yaml", ["enable_audit_log: true"]);
    const controlLedger = ledgerWith([{ id: "req-policy-control", text: "`policy2.yaml` must contain `enable_audit_log`", kind: "acceptance" }]);
    const controlClaims = [{
      requirement_id: "req-policy-control",
      disposition: "met",
      enforcement: [{ file: "policy2.yaml", line: 1 }],
      test: [],
      reason: "enable_audit_log is present in policy2.yaml",
    }];
    const control = validateRequirementTrace(controlClaims, controlLedger, workspace);
    assert.equal(control.rows[0]?.disposition, "met");
    assert.equal(control.rows[0]?.proof, "structural_state");

    writeFile(workspace, ".dockerignore", ["foo/assets/bar"]);
    const pathLedger = ledgerWith([{ id: "req-assets", text: "`.dockerignore` must contain `assets/`", kind: "acceptance" }]);
    const pathClaims = [{
      requirement_id: "req-assets",
      disposition: "met",
      enforcement: [{ file: ".dockerignore", line: 1 }],
      test: [],
      reason: "assets/ occurs within the ignored path",
    }];
    const pathTrace = validateRequirementTrace(pathClaims, pathLedger, workspace);
    assert.equal(pathTrace.rows[0]?.disposition, "met");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: only dot-prefixed ignore files qualify as structural targets", () => {
  assert.equal(structuralStateClaim("`db-ignore` must contain `Flask`"), null);
  assert.deepEqual(structuralStateClaim("`.npmignore` must not exclude `assets/`"), {
    file: ".npmignore", literal: "assets/", presence: false, mode: "content",
  });
});

test("#985: an extensionless -ignore file falls back to runtime proof", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "db-ignore", ['print("hi")']);
    const ledger = ledgerWith([{ id: "req-db-ignore", text: "`db-ignore` must contain `Flask`", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-db-ignore",
      disposition: "met",
      enforcement: [{ file: "db-ignore", line: 1 }],
      test: [VALID_TEST_LOCATION],
      reason: "Flask is present in db-ignore",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.equal(trace.rows[0]?.proof, "runtime_behavior");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: structural targets must stay inside the checkout", () => {
  assert.equal(structuralStateClaim("`../outside.json` must exist"), null);
  assert.equal(structuralStateClaim("`/tmp/outside.json` must exist"), null);

  const workspace = makeWorkspace();
  const outsideFile = join(workspace, "..", "985-escape-outside.json");
  try {
    writeFile(join(workspace, ".."), "985-escape-outside.json", ["EXISTS"]);
    const ledger = ledgerWith([
      { id: "req-outside-exists", text: "`../985-escape-outside.json` must exist", kind: "acceptance" },
      { id: "req-outside-absent", text: "`../985-escape-outside.json` must be absent", kind: "acceptance" },
    ]);
    const claims = [
      {
        requirement_id: "req-outside-exists",
        disposition: "met",
        enforcement: [{ file: "../985-escape-outside.json", line: 1 }],
        test: [VALID_TEST_LOCATION],
        reason: "the sibling file exists",
      },
      {
        requirement_id: "req-outside-absent",
        disposition: "met",
        enforcement: [{ file: "../985-escape-outside.json", line: 1 }],
        test: [VALID_TEST_LOCATION],
        reason: "the sibling file is absent",
      },
    ];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    const exists = trace.rows.find((row) => row.requirement_id === "req-outside-exists");
    const absent = trace.rows.find((row) => row.requirement_id === "req-outside-absent");
    assert.equal(exists?.disposition, "unverifiable");
    assert.equal(exists?.proof, "runtime_behavior");
    assert.equal(absent?.disposition, "unverifiable");
    assert.equal(absent?.proof, "runtime_behavior");
  } finally {
    rmSync(outsideFile, { force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: structural classifiers reject compound and equality assertions", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "config.json", ["foo"]);
    writeFileSync(join(workspace, "config2.json"), "");
    writeFile(workspace, "config3.json", ['{"note":"foo","other":1}']);

    const requirements = [
      { id: "req-two-literals", text: "`config.json` must contain `foo` and `bar`", kind: "acceptance" },
      { id: "req-exists-and-content", text: "`config2.json` must exist and contain `foo`", kind: "acceptance" },
      { id: "req-equality", text: "`config3.json` must equal `foo`", kind: "acceptance" },
    ];
    const claims = [
      {
        requirement_id: "req-two-literals",
        disposition: "met",
        enforcement: [{ file: "config.json", line: 1 }],
        test: [VALID_TEST_LOCATION],
        reason: "the file contains foo and bar",
      },
      {
        requirement_id: "req-exists-and-content",
        disposition: "met",
        enforcement: [{ file: "config2.json", line: 1 }],
        test: [VALID_TEST_LOCATION],
        reason: "the file exists and contains foo",
      },
      {
        requirement_id: "req-equality",
        disposition: "met",
        enforcement: [{ file: "config3.json", line: 1 }],
        test: [VALID_TEST_LOCATION],
        reason: "the file equals foo",
      },
    ];
    const trace = validateRequirementTrace(claims, ledgerWith(requirements), workspace);
    for (const id of ["req-two-literals", "req-exists-and-content", "req-equality"]) {
      const row = trace.rows.find((candidate) => candidate.requirement_id === id);
      assert.equal(row?.disposition, "unverifiable", id);
      assert.equal(row?.proof, "runtime_behavior", id);
    }

    // A single-literal containment claim and a pure existence claim still
    // classify; only the compound and equality shapes decline.
    assert.equal(structuralStateClaim("`config2.json` must exist and contain `foo`"), null);
    assert.equal(structuralStateClaim("`config3.json` must equal `foo`"), null);
    assert.notEqual(structuralStateClaim("`config.json` must contain `foo`"), null);
    assert.notEqual(structuralStateClaim("`config2.json` must exist"), null);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: structural citations require an in-range line unless the file is empty", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, ".dockerignore", ["node_modules/", "dist/"]);
    const text = "`.dockerignore` must not exclude `assets/`";
    const ledger = ledgerWith([
      { id: "req-bad-line", text, kind: "acceptance" },
      { id: "req-good-line", text, kind: "acceptance" },
    ]);
    const claims = [
      {
        requirement_id: "req-bad-line",
        disposition: "met",
        enforcement: [{ file: ".dockerignore", line: 999999 }],
        test: [],
        reason: "assets/ is not excluded",
      },
      {
        requirement_id: "req-good-line",
        disposition: "met",
        enforcement: [{ file: ".dockerignore", line: 1 }],
        test: [],
        reason: "assets/ is not excluded",
      },
    ];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    const badLine = trace.rows.find((row) => row.requirement_id === "req-bad-line");
    const goodLine = trace.rows.find((row) => row.requirement_id === "req-good-line");
    assert.equal(badLine?.disposition, "unverifiable");
    assert.ok(badLine?.notes.includes("structural-citation-line-out-of-range"));
    assert.equal(goodLine?.disposition, "met");

    const renderedTrace: RequirementTraceArtifact = {
      version: 1,
      rows: [{
        requirement_id: "req-bad-line",
        disposition: "unverifiable",
        proof: "structural_state",
        enforcement: [{ file: ".dockerignore", line: 999999 }],
        test: [],
        reason: "",
        notes: ["structural-citation-line-out-of-range"],
      }],
      incomplete: true,
      errors: [],
    };
    assert.ok(renderRequirementTraceMarkdown(renderedTrace).includes("the cited line is outside the cited file"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: an empty ignore file accepts file-level structural provenance", () => {
  const workspace = makeWorkspace();
  try {
    writeFileSync(join(workspace, ".dockerignore"), "");
    const ledger = ledgerWith([{ id: "req-empty-ignore", text: "`.dockerignore` must not exclude `assets/`", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-empty-ignore",
      disposition: "met",
      enforcement: [{ file: ".dockerignore", line: 1 }],
      test: [],
      reason: "the empty ignore file excludes no paths",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "met");
    assert.deepEqual(trace.rows[0]?.notes, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: a second assertion clause the grammar cannot represent stays strict", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "config.json", ['{"foo":1}']);
    // The second clause is unbound, so the grammar cannot represent it —
    // proving `foo` is present must not certify the whole requirement.
    const text = "`config.json` must contain `foo` and omit debug logging";
    assert.equal(structuralStateClaim(text), null);

    const ledger = ledgerWith([{ id: "req-compound-verb", text, kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-compound-verb",
      disposition: "met",
      enforcement: [{ file: "config.json", line: 1 }],
      test: [VALID_TEST_LOCATION],
      reason: "foo is present",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.equal(trace.rows[0]?.proof, "runtime_behavior");

    // Two modal-bound clauses are equally unrepresentable.
    assert.equal(structuralStateClaim("`config.json` must contain `foo` and must omit `bar`"), null);
    // So is a second clause whose object is itself quoted.
    assert.equal(structuralStateClaim("`config.json` must contain `foo` and omit `bar`"), null);
    // A verb appearing only inside a backticked literal does not trip the guard,
    // and neither does a clause carrying no assertion verb.
    assert.notEqual(structuralStateClaim("`config.json` must contain `omit`"), null);
    assert.notEqual(structuralStateClaim("`config.json` must contain `foo`"), null);
    assert.notEqual(structuralStateClaim("`config.json` must contain `foo` and must be covered by a regression test"), null);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: a conjunctive tail is rejected syntactically, not by a verb list", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "config.json", ['{"foo":1}']);
    // The class is closed by the conjunction, so the trailing verb is
    // irrelevant: none of these may be certified by proving `foo` alone.
    for (const verb of ["enable", "use", "set", "keep", "disable", "require", "configure", "emit", "log"]) {
      const text = "`config.json` must contain `foo` and " + verb + " debug logging";
      assert.equal(structuralStateClaim(text), null, verb);
      const trace = validateRequirementTrace(
        [{
          requirement_id: "r",
          disposition: "met",
          enforcement: [{ file: "config.json", line: 1 }],
          test: [VALID_TEST_LOCATION],
          reason: "foo is present",
        }],
        ledgerWith([{ id: "r", text, kind: "acceptance" }]),
        workspace,
      );
      assert.equal(trace.rows[0]?.disposition, "unverifiable", verb);
      assert.equal(trace.rows[0]?.proof, "runtime_behavior", verb);
    }

    // A bare trailing noun carries no conjunction, so it stays structural.
    assert.notEqual(structuralStateClaim("`config.json` must contain `foo` key"), null);
    // Leading prose sits before the assertion and is not part of the claim.
    assert.notEqual(structuralStateClaim("Per policy, `config.json` must contain `foo`"), null);
    // The one modeled adjunct is a test demand, which asserts no further state.
    assert.notEqual(structuralStateClaim("`config.json` must contain `foo` and must be covered by a regression test"), null);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: the conjunctive tail must BE the test-demand adjunct, not merely contain one", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "config.json", ['{"foo":1}']);
    // A tail carrying an unmodeled clause *and* a test demand must not be
    // admitted just because a test demand appears somewhere inside it.
    const repro = "`config.json` must contain `foo`\nand enable debug logging\nand must add a regression test";
    assert.equal(structuralStateClaim(repro), null);
    const trace = validateRequirementTrace(
      [{
        requirement_id: "r",
        disposition: "met",
        enforcement: [{ file: "config.json", line: 1 }],
        test: [VALID_TEST_LOCATION],
        reason: "foo is present",
      }],
      ledgerWith([{ id: "r", text: repro, kind: "acceptance" }]),
      workspace,
    );
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.equal(trace.rows[0]?.proof, "test_required");

    // The same class in single-line and reversed order.
    assert.equal(structuralStateClaim("`config.json` must contain `foo` and enable debug logging and must add a regression test"), null);
    assert.equal(structuralStateClaim("`config.json` must contain `foo` and must add a regression test and enable debug logging"), null);

    // Exactly the adjunct, in several phrasings, still classifies.
    for (const adjunct of [
      "and must be covered by a regression test",
      "and must add a regression test",
      "and must have a regression test",
    ]) {
      assert.notEqual(structuralStateClaim("`config.json` must contain `foo` " + adjunct), null, adjunct);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: an outside-file symlink cannot satisfy a structural existence claim", () => {
  const workspace = makeWorkspace();
  const outsidePath = join(workspace, "..", "985-outside.json");
  try {
    writeFileSync(outsidePath, "{}\n");
    symlinkSync(outsidePath, join(workspace, "link.json"));
    const trace = validateRequirementTrace(
      [{
        requirement_id: "r",
        disposition: "met",
        enforcement: [{ file: "link.json", line: 1 }],
        test: [VALID_TEST_LOCATION],
        reason: "link.json exists",
      }],
      ledgerWith([{ id: "r", text: "`link.json` must exist", kind: "normative" }]),
      workspace,
    );
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.equal(trace.rows[0]?.proof, "structural_state");
  } finally {
    rmSync(outsidePath, { force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: an in-workspace file symlink cannot satisfy structural existence", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "real.json", ["{}"]);
    symlinkSync(join(workspace, "real.json"), join(workspace, "alias.json"));
    const trace = validateRequirementTrace(
      [{
        requirement_id: "r",
        disposition: "met",
        enforcement: [{ file: "alias.json", line: 1 }],
        test: [VALID_TEST_LOCATION],
        reason: "alias.json exists",
      }],
      ledgerWith([{ id: "r", text: "`alias.json` must exist", kind: "normative" }]),
      workspace,
    );
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.equal(trace.rows[0]?.proof, "structural_state");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: a symlinked directory component cannot satisfy structural existence", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "nested/real.json", ["{}"]);
    symlinkSync(join(workspace, "nested"), join(workspace, "linked"), "dir");
    const trace = validateRequirementTrace(
      [{
        requirement_id: "r",
        disposition: "met",
        enforcement: [{ file: "linked/real.json", line: 1 }],
        test: [VALID_TEST_LOCATION],
        reason: "linked/real.json exists",
      }],
      ledgerWith([{ id: "r", text: "`linked/real.json` must exist", kind: "normative" }]),
      workspace,
    );
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.equal(trace.rows[0]?.proof, "structural_state");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: a dangling symlink cannot satisfy a structural absence claim", () => {
  const workspace = makeWorkspace();
  try {
    symlinkSync(join(workspace, "does-not-exist-985"), join(workspace, "dangling.json"));
    const trace = validateRequirementTrace(
      [{
        requirement_id: "r",
        disposition: "met",
        enforcement: [{ file: "dangling.json", line: 1 }],
        test: [VALID_TEST_LOCATION],
        reason: "dangling.json is absent",
      }],
      ledgerWith([{ id: "r", text: "`dangling.json` must be absent", kind: "normative" }]),
      workspace,
    );
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.equal(trace.rows[0]?.proof, "structural_state");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: real existence and genuine absence still satisfy structural claims", () => {
  const existingWorkspace = makeWorkspace();
  try {
    writeFile(existingWorkspace, ".dockerignore", ["node_modules/"]);
    const trace = validateRequirementTrace(
      [{
        requirement_id: "r",
        disposition: "met",
        enforcement: [{ file: ".dockerignore", line: 1 }],
        test: [VALID_TEST_LOCATION],
        reason: ".dockerignore exists",
      }],
      ledgerWith([{ id: "r", text: "`.dockerignore` must exist", kind: "normative" }]),
      existingWorkspace,
    );
    assert.equal(trace.rows[0]?.disposition, "met");
    assert.equal(trace.rows[0]?.proof, "structural_state");
  } finally {
    rmSync(existingWorkspace, { recursive: true, force: true });
  }

  const absentWorkspace = makeWorkspace();
  try {
    const trace = validateRequirementTrace(
      [{
        requirement_id: "r",
        disposition: "met",
        enforcement: [{ file: "absent.json", line: 1 }],
        test: [VALID_TEST_LOCATION],
        reason: "absent.json is absent",
      }],
      ledgerWith([{ id: "r", text: "`absent.json` must be absent", kind: "normative" }]),
      absentWorkspace,
    );
    assert.equal(trace.rows[0]?.disposition, "met");
    assert.equal(trace.rows[0]?.proof, "structural_state");
  } finally {
    rmSync(absentWorkspace, { recursive: true, force: true });
  }
});

test("#985: workspacePathHasSymlinkComponent refuses symlinks and escaping paths", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "real.json", ["{}"]);
    writeFile(workspace, "real-dir/inside.json", ["{}"]);
    symlinkSync(join(workspace, "real.json"), join(workspace, "file-link.json"));
    symlinkSync(join(workspace, "real-dir"), join(workspace, "dir-link"), "dir");
    symlinkSync(join(workspace, "missing-target-985"), join(workspace, "dangling-link.json"));
    symlinkSync(join(workspace, "real-dir"), join(workspace, "component-link"), "dir");

    assert.equal(workspacePathHasSymlinkComponent(workspace, "real.json"), false);
    assert.equal(workspacePathHasSymlinkComponent(workspace, "real-dir"), false);
    assert.equal(workspacePathHasSymlinkComponent(workspace, "file-link.json"), true);
    assert.equal(workspacePathHasSymlinkComponent(workspace, "dir-link"), true);
    assert.equal(workspacePathHasSymlinkComponent(workspace, "dangling-link.json"), true);
    assert.equal(workspacePathHasSymlinkComponent(workspace, "/etc/hosts"), true);
    assert.equal(workspacePathHasSymlinkComponent(workspace, "../"), true);
    assert.equal(workspacePathHasSymlinkComponent(workspace, "component-link/inside.json"), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#985: an intermediate symlinked directory cannot prove absence either", () => {
  const workspace = makeWorkspace();
  const outside = join(workspace, "..", "985-outside-dir");
  try {
    // `linked/` resolves outside the checkout, so nothing about
    // `linked/missing.json` can be asserted from repository state — neither
    // its absence nor its existence.
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "real.json"), "{}\n");
    symlinkSync(outside, join(workspace, "linked"), "dir");

    const ledger = ledgerWith([{ id: "req-linked-absent", text: "`linked/missing.json` must be absent", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-linked-absent",
      disposition: "met",
      enforcement: [{ file: "linked/missing.json", line: 1 }],
      test: [VALID_TEST_LOCATION],
      reason: "nothing there",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.equal(trace.rows[0]?.proof, "structural_state");

    // The same holds when the outside target does exist.
    const populatedLedger = ledgerWith([{ id: "req-linked-exists", text: "`linked/real.json` must exist", kind: "acceptance" }]);
    const populated = validateRequirementTrace([{
      requirement_id: "req-linked-exists",
      disposition: "met",
      enforcement: [{ file: "linked/real.json", line: 1 }],
      test: [VALID_TEST_LOCATION],
      reason: "the outside file exists",
    }], populatedLedger, workspace);
    assert.equal(populated.rows[0]?.disposition, "unverifiable");
    assert.equal(populated.rows[0]?.proof, "structural_state");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ── #1062: non-code proof domains (external/future + PR metadata) ─────────

const FUTURE_MERGE_REQUIREMENT = "Whether the unrelated pull request #1052 will merge successfully after this change";
const CI_GREEN_REQUIREMENT = "The external CI checks must remain green for the whole suite";
const INVENTORY_REQUIREMENT = "The pull request description must record the removed-file inventory";
const CODE_COMPARE_REQUIREMENT = "Context resolution MUST compare the source SHA against the resolved pull";

test("#1062: classifier tags external/future and documentation criteria, vetoes code", () => {
  assert.equal(nonCodeProofDomain(FUTURE_MERGE_REQUIREMENT), "external_state");
  assert.equal(nonCodeProofDomain(CI_GREEN_REQUIREMENT), "external_state");
  assert.equal(nonCodeProofDomain(INVENTORY_REQUIREMENT), "documentation");
  // A genuine implementation obligation — a compare, a mandatory test, or a
  // security/crypto verb — is never a non-code domain, even when it also names
  // a merge or the CI.
  assert.equal(nonCodeProofDomain(CODE_COMPARE_REQUIREMENT), null);
  assert.equal(nonCodeProofDomain("The credential redaction path must be covered by a regression test"), null);
  assert.equal(nonCodeProofDomain("The fix will merge the source SHA comparison before release"), null);
  // A plain behavioural requirement with no external/process signal stays strict.
  assert.equal(nonCodeProofDomain("The loader must reject an oversized payload"), null);
});

test("#1062: recording/reporting/publishing verbs are code obligations, never non-code", () => {
  // #252 hostile-boundary: a bare "record"/"document" with no doc/metadata target
  // is a runtime obligation (audit logging, event recording), NOT documentation.
  assert.equal(nonCodeProofDomain("The audit logger must record the actor and action for every admin override"), null);
  assert.equal(nonCodeProofDomain("The new endpoint must record the `admin.override` event in the response log"), null);
  assert.equal(nonCodeProofDomain("The command must document its usage in the help output"), null);
  // Publishing a status / shipping a release is THIS product's own behaviour.
  assert.equal(nonCodeProofDomain("The publish step must report a green status check on pull request #1000"), null);
  assert.equal(nonCodeProofDomain("The workflow must ship the release artifact only after CI is green"), null);
  // External/future still needs an explicit external/unrelated frame; a bare CI
  // or PR mention does not carve a real obligation out of strict proof.
  assert.equal(nonCodeProofDomain("CI must stay green on this pull request"), null);
});

test("#1062: a documentation obligation cannot be self-certified into a blocking gap on absence", () => {
  const workspace = makeWorkspace();
  try {
    const text = "The PR description must document the new `--no-cache` flag";
    const ledger = ledgerWith([{ id: "req-doc", text, kind: "acceptance" }]);
    const claims = [{ requirement_id: "req-doc", disposition: "met", reason: "documented" }];
    // The literal is absent from the body: never blocking, and never a code `met`
    // — it is a non-blocking pending advisory.
    const absent = validateRequirementTrace(claims, ledger, workspace, undefined, { prBody: "no mention here" });
    assert.equal(absent.rows[0]?.disposition, PENDING_DISPOSITION);
    assert.equal(absent.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062: a bare unmet (no reason) on a non-code row still blocks", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-merge", text: FUTURE_MERGE_REQUIREMENT, kind: "acceptance" }]);
    const trace = validateRequirementTrace([{ requirement_id: "req-merge", disposition: "unmet" }], ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.equal(trace.incomplete, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062: an external/future criterion with no claim is a non-blocking pending advisory", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-merge", text: FUTURE_MERGE_REQUIREMENT, kind: "acceptance" }]);
    const trace = validateRequirementTrace([], ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, PENDING_DISPOSITION);
    assert.equal(trace.rows[0]?.proof, "external_state");
    assert.ok(trace.rows[0]?.notes.includes("external-state-pending"));
    assert.ok(trace.rows[0]?.notes.includes("non-code-not-traced"));
    assert.equal(trace.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062: a model cannot launder an external/future outcome into a met code proof", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-merge", text: FUTURE_MERGE_REQUIREMENT, kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-merge",
      disposition: "met",
      enforcement: [{ file: "src/real.ts", line: 1 }],
      test: [VALID_TEST_LOCATION],
      reason: "I confirmed the unrelated PR merged",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    // Never met: an outcome not observable at head cannot be certified, but it
    // also does not fold into incomplete (it is advisory, not a code gap).
    assert.equal(trace.rows[0]?.disposition, PENDING_DISPOSITION);
    assert.equal(trace.rows[0]?.proof, "external_state");
    assert.equal(trace.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062: a documented inventory recorded in the trusted PR body is met without code proof", () => {
  const workspace = makeWorkspace();
  try {
    const text = "The PR description must document the new `--no-cache` flag";
    const ledger = ledgerWith([{ id: "req-doc", text, kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-doc",
      disposition: "met",
      enforcement: [],
      test: [],
      reason: "the PR description documents the flag",
    }];
    const met = validateRequirementTrace(claims, ledger, workspace, undefined, { prBody: "Add a new `--no-cache` flag to the CLI." });
    assert.equal(met.rows[0]?.disposition, "met");
    assert.equal(met.rows[0]?.proof, "documentation");
    assert.ok(met.rows[0]?.notes.includes("documentation-verified-in-pr-body"));
    assert.equal(met.incomplete, false);
    // Without a trusted PR body it can never be `met` — it falls to pending, not
    // a blocking unverifiable, and never invents a source predicate.
    const noBody = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(noBody.rows[0]?.disposition, PENDING_DISPOSITION);
    assert.ok(noBody.rows[0]?.notes.includes("documentation-pending-unconfirmed"));
    assert.equal(noBody.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062: #1060-shape ledger no longer blocks on non-code criteria alone", () => {
  const workspace = makeWorkspace();
  try {
    const nonCodeOnly = [
      { id: "req-inventory", text: INVENTORY_REQUIREMENT, kind: "acceptance" },
      { id: "req-ci", text: CI_GREEN_REQUIREMENT, kind: "acceptance" },
      { id: "req-merge", text: FUTURE_MERGE_REQUIREMENT, kind: "acceptance" },
    ];
    const noneTraced = validateRequirementTrace([], ledgerWith(nonCodeOnly), workspace);
    assert.ok(noneTraced.rows.every((row) => row.disposition === PENDING_DISPOSITION), JSON.stringify(noneTraced.rows));
    assert.equal(noneTraced.incomplete, false);
    const enforced = applyRequirementTraceEnforcement(artifact({}), { enabled: true, ledger: ledgerWith(nonCodeOnly), workspace, prBody: "docs" });
    assert.equal(enforced.applied, true);
    assert.notEqual(enforced.trace.rows.length, 0);
    assert.notEqual(enforced.trace.incomplete, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062: a genuine unverified code requirement still blocks in a mixed ledger", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([
      { id: "req-inventory", text: INVENTORY_REQUIREMENT, kind: "acceptance" },
      { id: "req-merge", text: FUTURE_MERGE_REQUIREMENT, kind: "acceptance" },
      { id: "req-code", text: CODE_COMPARE_REQUIREMENT, kind: "normative" },
    ]);
    const trace = validateRequirementTrace([], ledger, workspace);
    assert.equal(trace.rows.find((r) => r.requirement_id === "req-code")?.disposition, "unverifiable");
    assert.equal(trace.rows.find((r) => r.requirement_id === "req-code")?.proof, "runtime_behavior");
    assert.equal(trace.rows.find((r) => r.requirement_id === "req-merge")?.disposition, PENDING_DISPOSITION);
    assert.equal(trace.incomplete, true, "the unverified code requirement keeps the review blocking");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062: a properly-traced code requirement alongside pending criteria does not block", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/context-resolution.ts", ["if (sourceSha === resolved.pull.sourceSha) { return true; }"]);
    const ledger = ledgerWith([
      { id: "req-inventory", text: INVENTORY_REQUIREMENT, kind: "acceptance" },
      { id: "req-code", text: CODE_COMPARE_REQUIREMENT, kind: "normative" },
    ]);
    const claims = [{
      requirement_id: "req-code",
      disposition: "met",
      enforcement: [{ file: "src/context-resolution.ts", line: 1 }],
      test: [VALID_TEST_LOCATION],
      reason: "compares sourceSha against the resolved pull",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows.find((r) => r.requirement_id === "req-code")?.disposition, "met");
    assert.equal(trace.rows.find((r) => r.requirement_id === "req-inventory")?.disposition, PENDING_DISPOSITION);
    assert.equal(trace.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062: a well-formed unmet on a non-code row stays a blocking gap", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-ci", text: CI_GREEN_REQUIREMENT, kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-ci",
      disposition: "unmet",
      enforcement: [],
      test: [],
      reason: "the CI suite is currently red on the changed files",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "unmet");
    assert.ok(trace.rows[0]?.notes.includes("non-code-reported-unmet"));
    assert.equal(trace.incomplete, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062: the model cannot self-declare a code row pending", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-code", text: CODE_COMPARE_REQUIREMENT, kind: "normative" }]);
    const claims = [{ requirement_id: "req-code", disposition: "pending", reason: "trust me" }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    // "pending" is not a model vocabulary; it is rejected and the code row falls
    // to unverifiable (blocking), so the domain cannot be used to self-waive.
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.equal(trace.rows[0]?.proof, "runtime_behavior");
    assert.equal(trace.incomplete, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062: pending rows render as advisory and never as a blocking trace failure", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([
      { id: "req-merge", text: FUTURE_MERGE_REQUIREMENT, kind: "acceptance" },
      { id: "req-code", text: CODE_COMPARE_REQUIREMENT, kind: "normative" },
    ]);
    const trace = validateRequirementTrace([], ledger, workspace);
    const rendered = renderRequirementTraceMarkdown(trace);
    assert.ok(rendered.includes("Non-code criteria (advisory"), rendered);
    assert.ok(rendered.includes("external/future outcome"), rendered);
    assert.ok(rendered.includes("`req-merge`"), rendered);
    // The blocking section still names the code gap; the pending row appears only
    // in the advisory list, never in the blocker count.
    assert.ok(rendered.includes("not fully traced to enforcement and a test"), rendered);
    assert.ok(rendered.includes("`req-code`"), rendered);
    const blockerSection = rendered.split("Non-code criteria")[0] ?? "";
    assert.ok(!blockerSection.includes("`req-merge`"), "pending row must not appear in the blocker count");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062: a pending-only ledger still renders the advisory section", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-ci", text: CI_GREEN_REQUIREMENT, kind: "acceptance" }]);
    const trace = validateRequirementTrace([], ledger, workspace);
    assert.equal(trace.incomplete, false);
    const rendered = renderRequirementTraceMarkdown(trace);
    assert.ok(rendered.includes("Non-code criteria (advisory"), rendered);
    assert.ok(!rendered.includes("not fully traced to enforcement and a test"), rendered);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ── #1062 review follow-up: proof-SOURCE split, advisory diagnostics, and the
// full #1060 eleven-class regression (joryirving + its-saffron reviews on
// #1067: a `README must document X` obligation must never be `met` because the
// PR body merely mentions X — confirmation comes from the exact-head checkout;
// advisories must state provenance/scope and the known exact-head CI state;
// and the motivating #1060 ledger needs an 11-row fixture, not an
// approximation).

test("#1062 review: documentation proof source follows the named target", () => {
  assert.equal(documentationProofSource("The PR description records the `x` inventory"), "pr_body");
  assert.equal(documentationProofSource("The pull request body must document the `x` flag"), "pr_body");
  assert.equal(documentationProofSource("The README must document the `x` flag"), "checkout_doc");
  assert.equal(documentationProofSource("The CHANGELOG records the `x` entry"), "checkout_doc");
  assert.equal(documentationProofSource("The docs must capture the `x` matrix"), "checkout_doc");
  assert.equal(documentationProofSource("The PR description and README must record the `x` inventory"), "mixed");
});

test("#1062 review: a README obligation is never certified from the PR body alone", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "README.md", ["# Project", "", "Nothing about that flag here."]);
    const ledger = ledgerWith([{ id: "req-readme", text: "The README must document the `preview-mode` flag", kind: "acceptance" }]);
    // The hostile shape: the PR body CLAIMS the flag is documented and quotes
    // the literal. That is self-certification from the wrong source — the
    // README at head is the obligation's target, and it does not carry it.
    const hostile = validateRequirementTrace([], ledger, workspace, undefined, {
      prBody: "This PR documents preview-mode thoroughly in the description.",
    });
    assert.equal(hostile.rows[0]?.disposition, PENDING_DISPOSITION);
    assert.ok(hostile.rows[0]?.notes.includes("documentation-pending-checkout-unconfirmed"));
    assert.ok(!hostile.rows[0]?.notes.includes("documentation-verified-in-pr-body"));
    assert.equal(hostile.incomplete, false);
    // Once the checkout itself carries the literal, the obligation is met —
    // from its own target, with the checkout note recorded.
    writeFile(workspace, "README.md", ["# Project", "", "Run with `preview-mode` to dry-run publication."]);
    const met = validateRequirementTrace([], ledger, workspace);
    assert.equal(met.rows[0]?.disposition, "met");
    assert.ok(met.rows[0]?.notes.includes("documentation-verified-in-checkout"));
    assert.equal(met.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062 review: CHANGELOG and docs/ checkout targets confirm only from the checkout", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([
      { id: "req-changelog", text: "The CHANGELOG records the `changelog-cleanup-note` entry", kind: "acceptance" },
      { id: "req-docs-tree", text: "The docs must capture the `effort-inputs` matrix", kind: "acceptance" },
    ]);
    const prBody = "The description mentions changelog-cleanup-note and the effort-inputs matrix.";
    const absent = validateRequirementTrace([], ledger, workspace, undefined, { prBody });
    assert.equal(absent.rows[0]?.disposition, PENDING_DISPOSITION);
    assert.equal(absent.rows[1]?.disposition, PENDING_DISPOSITION);
    assert.ok(absent.rows[0]?.notes.includes("documentation-pending-checkout-unconfirmed"));
    assert.ok(absent.rows[1]?.notes.includes("documentation-pending-checkout-unconfirmed"));
    assert.equal(absent.incomplete, false);
    writeFile(workspace, "CHANGELOG.md", ["# Changelog", "", "- changelog-cleanup-note added for the cleanup"]);
    writeFile(workspace, "docs/guide.md", ["See the effort-inputs matrix section for the four inputs."]);
    const met = validateRequirementTrace([], ledger, workspace);
    assert.equal(met.rows[0]?.disposition, "met");
    assert.equal(met.rows[1]?.disposition, "met");
    assert.ok(met.rows[0]?.notes.includes("documentation-verified-in-checkout"));
    assert.ok(met.rows[1]?.notes.includes("documentation-verified-in-checkout"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062 review: a symlinked docs/ root is never enumerated outside the workspace", () => {
  const workspace = makeWorkspace();
  const outside = mkdtempSync(join(tmpdir(), "req-trace-outside-"));
  try {
    writeFile(outside, "escape.md", ["the outside-effort matrix lives outside the checkout"]);
    symlinkSync(outside, join(workspace, "docs"));
    const ledger = ledgerWith([{ id: "req-docs", text: "The docs must capture the `outside-effort` matrix", kind: "acceptance" }]);
    // The literal sits in the linked tree; the scan must refuse the symlinked
    // root entirely — advisory, never a cross-boundary `met`.
    const trace = validateRequirementTrace([], ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, PENDING_DISPOSITION);
    assert.ok(trace.rows[0]?.notes.includes("documentation-pending-checkout-unconfirmed"));
    assert.equal(trace.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("#1062 review: an oversized README is never auto-read for confirmation", () => {
  const workspace = makeWorkspace();
  try {
    const literal = "oversized-review-note";
    // A hostile checkout puts the literal just past the per-file read cap.
    const filler = "x".repeat(DOC_SCAN_MAX_FILE_BYTES + 16);
    writeFileSync(join(workspace, "README.md"), `${literal}\n${filler}`);
    const ledger = ledgerWith([{ id: "req-readme", text: "The README must document the `oversized-review-note` entry", kind: "acceptance" }]);
    const trace = validateRequirementTrace([], ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, PENDING_DISPOSITION);
    assert.ok(trace.rows[0]?.notes.includes("documentation-pending-checkout-unconfirmed"));
    assert.equal(trace.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062 review: a target naming both PR metadata and a checkout doc stays advisory", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "README.md", ["retired-tooling inventory: two suites removed"]);
    const ledger = ledgerWith([{ id: "req-mixed", text: "The PR description and README must record the retired-tooling inventory", kind: "acceptance" }]);
    // Even with the prose present in BOTH sources, the single-source
    // confirmation rules cannot certify half-proved obligations: it stays a
    // non-blocking advisory naming both sources.
    const trace = validateRequirementTrace([], ledger, workspace, undefined, { prBody: "retired-tooling inventory recorded here" });
    assert.equal(trace.rows[0]?.disposition, PENDING_DISPOSITION);
    assert.ok(trace.rows[0]?.notes.includes("documentation-pending-mixed-target"));
    assert.equal(trace.incomplete, false);
    const rendered = renderRequirementTraceMarkdown(trace);
    assert.ok(rendered.includes("names both PR metadata and a checkout document"), rendered);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062 review: advisories report provenance, scope, and the known exact-head CI state", () => {
  const workspace = makeWorkspace();
  try {
    const provenance = [{ source: "linked_issues" }];
    const ledger = {
      requirements: [
        { id: "req-ci", text: CI_GREEN_REQUIREMENT, kind: "acceptance", provenance },
        { id: "req-merge", text: FUTURE_MERGE_REQUIREMENT, kind: "acceptance", provenance },
      ],
    };
    const known = validateRequirementTrace([], ledger, workspace, undefined, { ciState: "success" });
    assert.ok(known.rows[0]?.notes.includes("external-state-ci:success"));
    assert.ok(known.rows[0]?.notes.includes("provenance:linked_issues"));
    assert.ok(known.rows[1]?.notes.includes("external-state-ci:success"));
    const knownRendered = renderRequirementTraceMarkdown(known);
    assert.ok(knownRendered.includes("known exact-head CI state: `success`"), knownRendered);
    assert.ok(knownRendered.includes("from the linked issue, unconditionally in scope"), knownRendered);
    // No CI observation this run: the advisory says so explicitly instead of
    // silently omitting the state the author asked about.
    const unobserved = validateRequirementTrace([], ledger, workspace);
    assert.ok(unobserved.rows[0]?.notes.includes("external-state-ci-unavailable"));
    const unobservedRendered = renderRequirementTraceMarkdown(unobserved);
    assert.ok(unobservedRendered.includes("exact-head CI state was not observed during this review"), unobservedRendered);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

/** The PR #1060 published review (head e8c532a) reported 9 of 11 in-scope
 * linked-issue criteria `unverifiable`. This fixture reproduces all eleven
 * classes from that ledger — two traced code obligations, a genuine untraced
 * one, PR-description inventory, prose-only documentation, a README target, a
 * checkout-missing README target, a both-sources target, external CI state, an
 * unrelated PR's future merge, a docs/ tree target, and a CHANGELOG target —
 * and pins the corrected outcomes row by row. */
function pr1060FixtureWorkspace(): string {
  const workspace = makeWorkspace();
  writeFile(workspace, "src/compare-resolution.ts", ["if (sourceSha === resolved.pull.sourceSha) { return true; }"]);
  writeFile(workspace, "tests/cleanup.test.ts", ["test cleanup"]);
  writeFile(workspace, "README.md", ["# pr-reviewer-action", "", "Pass `--no-cache` to skip the review cache."]);
  writeFile(workspace, "CHANGELOG.md", ["# Changelog", "", "- changelog-cleanup-note for the retired Python suites"]);
  writeFile(workspace, "docs/guide.md", ["See the effort-inputs matrix in this guide."]);
  return workspace;
}

function pr1060Ledger(): unknown {
  const provenance = [{ source: "linked_issues" }];
  const entry = (id: string, text: string, kind = "acceptance"): unknown => ({ id, text, kind, provenance });
  return {
    requirements: [
      entry("req-compare", "Context resolution MUST compare the source SHA against the resolved pull request head"),
      entry("req-gate-order", "The publish-before-fail-gate comparison MUST be pinned by a regression test"),
      entry("req-inventory", "The PR description records the `dogfood-cleanup` inventory"),
      entry("req-suite-split", "The pull request description must record the inventory of removed and retained suites"),
      entry("req-readme-flag", "The README must document the `--no-cache` flag"),
      entry("req-readme-absent", "The README must document the `preview-mode` flag"),
      entry("req-both-sources", "The PR description and README must record the retired-tooling inventory"),
      entry("req-ci-green", "The external CI checks must remain green across the whole suite"),
      entry("req-future-merge", "Whether unrelated pull request #1052 merges successfully after this change"),
      entry("req-docs-matrix", "The docs must capture the `effort-inputs` matrix"),
      entry("req-changelog", "The CHANGELOG records the `changelog-cleanup-note` entry"),
    ],
  };
}

const PR1060_PR_BODY = "This PR records the dogfood-cleanup inventory in its description "
  + "and explains that preview-mode is fully documented (in this description).";

test("#1062 regression: the #1060 eleven-class ledger no longer yields a blanket unverifiable wall", () => {
  const workspace = pr1060FixtureWorkspace();
  try {
    const claims = [{
      requirement_id: "req-compare",
      disposition: "met",
      enforcement: [{ file: "src/compare-resolution.ts", line: 1 }],
      test: [{ file: "tests/cleanup.test.ts", line: 1 }],
      reason: "compares sourceSha against the resolved pull head",
    }];
    // `changed` names nothing the linked-issue criteria mention: their scope
    // must come from provenance alone (they are never silently dropped).
    const trace = validateRequirementTrace(claims, pr1060Ledger(), workspace, "src/unrelated-pipeline.ts", {
      prBody: PR1060_PR_BODY,
      ciState: "success",
    });
    assert.equal(trace.rows.length, 11);
    const byId = new Map(trace.rows.map((row) => [row.requirement_id, row]));
    // Proof kinds are derived deterministically per class.
    assert.equal(byId.get("req-compare")?.proof, "runtime_behavior");
    assert.equal(byId.get("req-gate-order")?.proof, "test_required");
    for (const id of ["req-inventory", "req-suite-split", "req-readme-flag", "req-readme-absent", "req-both-sources", "req-docs-matrix", "req-changelog"]) {
      assert.equal(byId.get(id)?.proof, "documentation", id);
    }
    for (const id of ["req-ci-green", "req-future-merge"]) assert.equal(byId.get(id)?.proof, "external_state", id);
    // The two traced/met-by-source rows are met from their OWN sources.
    assert.equal(byId.get("req-compare")?.disposition, "met");
    assert.equal(byId.get("req-inventory")?.disposition, "met");
    assert.ok(byId.get("req-inventory")?.notes.includes("documentation-verified-in-pr-body"));
    assert.equal(byId.get("req-readme-flag")?.disposition, "met");
    assert.ok(byId.get("req-readme-flag")?.notes.includes("documentation-verified-in-checkout"));
    assert.equal(byId.get("req-docs-matrix")?.disposition, "met");
    assert.equal(byId.get("req-changelog")?.disposition, "met");
    // The wrong-source row stays advisory despite the PR body quoting it.
    assert.equal(byId.get("req-readme-absent")?.disposition, PENDING_DISPOSITION);
    assert.ok(byId.get("req-readme-absent")?.notes.includes("documentation-pending-checkout-unconfirmed"));
    // Unconfirmable process/external rows are advisory, never `unverifiable`.
    assert.equal(byId.get("req-suite-split")?.disposition, PENDING_DISPOSITION);
    assert.equal(byId.get("req-both-sources")?.disposition, PENDING_DISPOSITION);
    assert.ok(byId.get("req-both-sources")?.notes.includes("documentation-pending-mixed-target"));
    assert.equal(byId.get("req-ci-green")?.disposition, PENDING_DISPOSITION);
    assert.ok(byId.get("req-ci-green")?.notes.includes("external-state-ci:success"));
    assert.equal(byId.get("req-future-merge")?.disposition, PENDING_DISPOSITION);
    // Every non-code row carries its provenance so the scope decision is explainable.
    for (const row of trace.rows) {
      if (row.proof === "documentation" || row.proof === "external_state") {
        assert.ok(row.notes.includes("provenance:linked_issues"), row.requirement_id);
      }
    }
    // The ONLY blocker left is the genuine untraced code obligation — not a
    // 9/11 wall of unobservable criteria.
    const blockers = trace.rows.filter((row) => row.disposition === "unverifiable" || row.disposition === "unmet");
    assert.deepEqual(blockers.map((row) => row.requirement_id), ["req-gate-order"]);
    assert.equal(trace.incomplete, true);
    const rendered = renderRequirementTraceMarkdown(trace);
    // The blocker denominator counts only code/test-verifiable rows (11 total
    // minus the 5 pending advisories), so the wall reads 1-of-6, not 9-of-11.
    assert.ok(rendered.includes("1 of 6 requirement(s) not fully traced"), rendered);
    const blockerSection = rendered.split("Non-code criteria")[0] ?? "";
    for (const pendingId of ["req-suite-split", "req-readme-absent", "req-both-sources", "req-ci-green", "req-future-merge"]) {
      assert.ok(!blockerSection.includes(pendingId), `${pendingId} must not appear as a blocker`);
    }
    const advisorySection = rendered.split("Non-code criteria")[1] ?? "";
    for (const pendingId of ["req-suite-split", "req-readme-absent", "req-both-sources", "req-ci-green", "req-future-merge"]) {
      assert.ok(advisorySection.includes(pendingId), `${pendingId} must appear in the advisory section`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062 regression: with the code gap traced, the eleven-class ledger completes without withholding", () => {
  const workspace = pr1060FixtureWorkspace();
  try {
    writeFile(workspace, "src/gate-comparison.ts", [
      "const gateOrder = compare(publishTime, gateTime);",
      "if (gateOrder < 0 && comparison === \"publish-before-gate\") { return true; }",
    ]);
    const claims = [
      {
        requirement_id: "req-compare",
        disposition: "met",
        enforcement: [{ file: "src/compare-resolution.ts", line: 1 }],
        test: [{ file: "tests/cleanup.test.ts", line: 1 }],
        reason: "compares sourceSha against the resolved pull head",
      },
      {
        requirement_id: "req-gate-order",
        disposition: "met",
        enforcement: [{ file: "src/gate-comparison.ts", line: 2 }],
        test: [{ file: "tests/cleanup.test.ts", line: 1 }],
        reason: "comparison pins publish-before-gate ordering",
      },
    ];
    const trace = validateRequirementTrace(claims, pr1060Ledger(), workspace, undefined, { prBody: PR1060_PR_BODY });
    assert.equal(trace.incomplete, false);
    assert.ok(trace.rows.every((row) => row.disposition === "met" || row.disposition === PENDING_DISPOSITION));
    const rendered = renderRequirementTraceMarkdown(trace);
    assert.ok(!rendered.includes("not fully traced to enforcement and a test"), rendered);
    assert.ok(rendered.includes("Non-code criteria (advisory"), rendered);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1062 regression: a hostile all-met payload cannot launder advisory rows or the code gap", () => {
  const workspace = pr1060FixtureWorkspace();
  try {
    const claims = (["req-compare", "req-gate-order", "req-inventory", "req-suite-split", "req-readme-flag",
      "req-readme-absent", "req-both-sources", "req-ci-green", "req-future-merge", "req-docs-matrix", "req-changelog"])
      .map((id) => ({ requirement_id: id, disposition: "met", enforcement: [], test: [], reason: "trust me, all done" }));
    const trace = validateRequirementTrace(claims, pr1060Ledger(), workspace, undefined, { prBody: PR1060_PR_BODY });
    const byId = new Map(trace.rows.map((row) => [row.requirement_id, row]));
    // Code rows without valid locations fall to unverifiable (blocking) no
    // matter what the model claims; the non-code domains ignore the claim
    // entirely (fail-soft to their own deterministic dispositions).
    assert.equal(byId.get("req-compare")?.disposition, "unverifiable");
    assert.equal(byId.get("req-gate-order")?.disposition, "unverifiable");
    assert.equal(byId.get("req-suite-split")?.disposition, PENDING_DISPOSITION);
    assert.equal(byId.get("req-readme-absent")?.disposition, PENDING_DISPOSITION);
    assert.equal(byId.get("req-both-sources")?.disposition, PENDING_DISPOSITION);
    assert.equal(byId.get("req-ci-green")?.disposition, PENDING_DISPOSITION);
    assert.equal(byId.get("req-future-merge")?.disposition, PENDING_DISPOSITION);
    // Source-confirmed rows stay met because the CHECKOUT/BODY proves them,
    // not the claim.
    assert.equal(byId.get("req-readme-flag")?.disposition, "met");
    assert.equal(byId.get("req-inventory")?.disposition, "met");
    assert.equal(trace.incomplete, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ── #1095: miso-gallery#543 false CHANGES_REQUESTED regression ────────────
const ISSUE_543_TESTS_PASS = "tests/test_bounded_scans.py, tests/test_gallery_scan_cache.py, tests/test_find_duplicate_media.py and tests/test_recent_smoke.py pass with only import-path updates (automated_test).";

test("#1095: a tests-pass acceptance criterion is an external_state advisory, never unverifiable", () => {
  const workspace = makeWorkspace();
  try {
    assert.equal(nonCodeProofDomain(ISSUE_543_TESTS_PASS), "external_state");
    const trace = validateRequirementTrace([], ledgerWith([{ id: "req-tests", text: ISSUE_543_TESTS_PASS, kind: "acceptance" }]), workspace);
    assert.equal(trace.rows[0]?.disposition, PENDING_DISPOSITION);
    assert.equal(trace.rows[0]?.proof, "external_state");
    assert.equal(trace.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1095: test-execution signal stays narrow — code demands never pend", () => {
  // A code demand naming test paths as proof targets stays strict...
  assert.equal(nonCodeProofDomain("tests/test_bounds.py must exercise the new scan limit"), null);
  // ...phrasal "pass through" is not an outcome...
  assert.equal(nonCodeProofDomain("tests must pass through the proxy layer"), null);
  // ...a test demand is caught upstream...
  assert.equal(nonCodeProofDomain("the new module must have test coverage"), null);
  // ...parser vocabulary stays an implementation obligation.
  assert.equal(nonCodeProofDomain("the parser must pass malformed input without crashing"), null);
  // #1095 review: a compound requirement naming a SOURCE path plus a
  // tests-pass clause cannot ride the tests-pass half out of strict proof —
  // only all-test-path subjects may pend.
  assert.equal(nonCodeProofDomain("`app.py` must define `GALLERY_SCAN_LIMIT` from the environment and the existing tests pass unchanged."), null);
  // Credential vocabulary (plural included) is never an advisory.
  assert.equal(nonCodeProofDomain("a test harness step must pass credentials to the sandbox"), null);
});

test("#1095: the #543 ledger shape yields no synthesized majors and cannot force request_changes", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([
      { id: "req-merge", text: "Sibling extractions touching app.py must be merged sequentially to avoid merge conflicts.", kind: "normative" },
      { id: "req-inspect", text: "gallery_scan.py exists and contains the moved helpers and constants (code_inspection).", kind: "acceptance" },
      { id: "req-tests", text: ISSUE_543_TESTS_PASS, kind: "acceptance" },
    ]);
    const art = artifact({
      verdict: "approve",
      requirement_coverage: [
        { requirement_id: "req-merge", disposition: "unmet", enforcement: [], test: [], reason: "merge-process constraint; no production predicate enforces it." },
        { requirement_id: "req-inspect", disposition: "unmet", enforcement: [{ file: "src/real.ts", line: 1 }], test: [], reason: "no regression test asserts the helpers are present; the cited line is not an enforcing predicate." },
        { requirement_id: "req-tests", disposition: "unverifiable", enforcement: [], test: [], reason: "no test execution results are provided." },
      ],
    });
    const result = applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    assert.equal(result.applied, true);
    assert.deepEqual(art.findings ?? [], [], JSON.stringify(art.findings));
    // Coverage stays incomplete (the unsubstantiated unmet is disclosed, not
    // laundered), so the run can never publish clean — but with zero blocking
    // findings the strict mapping keeps the model's approve.
    assert.equal(result.trace.incomplete, true);
    assert.equal(art.required_checks, "incomplete");
    const outcome = applyStrictVerdictPolicy(art as unknown as Parameters<typeof applyStrictVerdictPolicy>[0], { modelVerdict: "approve", forced: false });
    assert.equal(outcome.verdict, "approve");
    assert.equal(outcome.reviewResult, "partial");
    assert.equal(outcome.overridden, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ── #1145: confirmed-unmet → request_changes escalation ───────────────────

function traceWithRows(rows: RequirementTraceArtifact["rows"], incomplete = true): RequirementTraceArtifact {
  return { version: 1, rows, incomplete, errors: [] };
}

test("#1145: confirmedUnmetRows selects exactly the refutable-unverifiable rows", () => {
  const rows = [
    {
      requirement_id: "req-854", disposition: "unverifiable", proof: "runtime_behavior",
      enforcement: [{ file: "src/a.ts", line: 1 }], test: [], reason: "x",
      notes: ["enforcement-location-copies-without-comparing"],
    },
    {
      requirement_id: "req-985", disposition: "unverifiable", proof: "structural_state",
      enforcement: [{ file: ".dockerignore", line: 1 }], test: [], reason: "x",
      notes: ["structural-proof-unconfirmed"],
    },
    // Citation-gap rows: the citation failed validation — a different
    // location may still prove it, so they stay repairable, never escalated.
    {
      requirement_id: "req-citation", disposition: "unverifiable", proof: "runtime_behavior",
      enforcement: [], test: [], reason: "x",
      notes: ["downgraded-no-valid-enforcement-location"],
    },
    {
      requirement_id: "req-missing", disposition: "unverifiable", proof: "runtime_behavior",
      enforcement: [], test: [], reason: "x",
      notes: ["not-traced-by-reviewer"],
    },
    // Settled rows never escalate, even if a refutation note were attached.
    {
      requirement_id: "req-met", disposition: "met", proof: "runtime_behavior",
      enforcement: [{ file: "src/a.ts", line: 1 }], test: [], reason: "x",
      notes: ["enforcement-location-copies-without-comparing"],
    },
    // A model-claimed unmet is a known gap the reviewer substantiates
    // (#1095) — the validator cannot confirm or refute it.
    {
      requirement_id: "req-unmet", disposition: "unmet", proof: "runtime_behavior",
      enforcement: [], test: [], reason: "x",
      notes: ["structural-proof-unconfirmed"],
    },
    {
      requirement_id: "req-pending", disposition: "pending", proof: "external_state",
      enforcement: [], test: [], reason: "x",
      notes: ["external-state-ci-pending"],
    },
  ];
  const selected = confirmedUnmetRows(traceWithRows(rows));
  // Only the #985 structural refutation is a confirmed-unmet row: the
  // validator re-derived the requirement's truth from the repository state
  // at head, so nothing the reviewer reads can un-prove it.
  assert.deepEqual(selected.map((row) => row.requirement_id), ["req-985"]);
  // The #854 copies-without-comparing row is NOT selected: its predicate
  // searched only the cited locations, so it cannot prove the requirement is
  // unenforced elsewhere — it stays a repairable coverage gap.
  assert.ok(!selected.some((row) => row.requirement_id === "req-854"), "the copies-only row is repairable, not a refutation");
});

test("#1145: a copies-without-comparing trace (the real predicate lives elsewhere) does NOT escalate — no blocker, no verdict flip", () => {
  const workspace = makeWorkspace();
  try {
    // The reviewer's regression shape: the REAL enforcement predicate exists
    // in another implementation location (a genuine comparison of the source
    // SHA against the resolved pull), but the reviewer's claim cites ONLY the
    // copy/assignment line. The deterministic predicate searches the cited
    // locations, so it cannot prove the requirement is unenforced anywhere
    // else — the row is a repairable coverage gap, never a refutation.
    writeFile(workspace, "src/context-resolution.ts", [
      "export function resolveContext(ctx) {",
      "  const record = lookupPull(ctx);",
      "  return {",
      "    repo: record.repo,",
      "    sourceSha: ctx.sourceSha,",
      "    targetBranch: ctx.targetBranch,",
      "  };",
      "}",
    ]);
    writeFile(workspace, "src/other-implementation.ts", [
      "export function assertResolvedPull(ctx, record) {",
      "  if (record.head !== ctx.sourceSha) {",
      "    throw new Error('source SHA mismatch');",
      "  }",
      "}",
    ]);
    const ledger = ledgerWith([{ id: "req-1", text: "Context resolution MUST compare source SHA against the resolved pull.", kind: "acceptance" }]);
    // The "elsewhere" fixture is load-bearing: citing the real predicate
    // location satisfies the requirement, so the downgrade below is a
    // citation-scope artifact (the predicate only searched the cited
    // locations) and not a real gap. Without this assertion the fixture
    // would be inert — the test would pass with the file deleted.
    const citedElsewhere = validateRequirementTrace([{
      requirement_id: "req-1",
      disposition: "met",
      enforcement: [{ file: "src/other-implementation.ts", line: 2 }],
      test: [{ file: "tests/real.test.ts", line: 1 }],
      reason: "the comparison lives in the other implementation location",
    }], ledger, workspace);
    assert.equal(citedElsewhere.rows[0]?.disposition, "met", JSON.stringify(citedElsewhere.rows));
    assert.ok(!(citedElsewhere.rows[0]?.notes ?? []).includes("enforcement-location-copies-without-comparing"), JSON.stringify(citedElsewhere.rows));
    const art = artifact({
      verdict: "approve",
      verdict_source: "model",
      requirement_coverage: [{
        requirement_id: "req-1",
        disposition: "met",
        enforcement: [{ file: "src/context-resolution.ts", line: 5 }],
        test: [{ file: "tests/real.test.ts", line: 1 }],
        reason: "sourceSha is present on the resolved context object",
      }],
    });
    const traceResult = applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    assert.equal(traceResult.applied, true);
    // The row is still downgraded and the trace is still incomplete — the
    // #854 protection is untouched.
    assert.equal(traceResult.trace.rows[0]?.disposition, "unverifiable");
    assert.ok(traceResult.trace.rows[0]?.notes.includes("enforcement-location-copies-without-comparing"), JSON.stringify(traceResult.trace.rows));
    assert.equal(traceResult.trace.incomplete, true);
    assert.equal(art.required_checks, "incomplete");
    // ...but the copies-without-comparing note is NOT a confirmed-unmet
    // refutation, so nothing is synthesized and the verdict stands.
    const escalated = applyConfirmedUnmetEscalation(art, traceResult.trace, new Map(ledgerRequirementsById(ledger, ["req-1"]).map((e) => [e.id, e.text] as const)));
    assert.equal(escalated, 0);
    assert.deepEqual(art.findings, []);
    assert.equal(art.verdict, "approve");
    assert.equal(art.verdict_source, "model");
    assert.ok(!art.review_markdown.includes("confirmed unmet by deterministic repository-state proof"), art.review_markdown);
    // #811 strict mapping sees no synthesized blocker and no open blocker:
    // the run is not a clean approval (coverage is partial), but the model's
    // approve is not flipped into a blocking request_changes.
    const outcome = applyStrictVerdictPolicy(art as unknown as Parameters<typeof applyStrictVerdictPolicy>[0], { modelVerdict: "approve", forced: false });
    assert.equal(outcome.verdict, "approve");
    assert.equal(outcome.reviewResult, "partial");
    assert.equal(outcome.overridden, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1145: the surviving #985 structural refutation still escalates an approve to request_changes with a synthesized blocker finding", () => {
  const workspace = makeWorkspace();
  try {
    // #985: the requirement's truth is a property of the checkout, so the
    // validator re-derives it from the cited file at head — the state the
    // requirement demands is NOT the state at head. That IS deterministic
    // proof of absence, so the row escalates.
    writeFile(workspace, ".dockerignore", ["node_modules/", "assets/"]);
    const ledger = ledgerWith([{ id: "req-985", text: "`.dockerignore` must not exclude `assets/`", kind: "acceptance" }]);
    const art = artifact({
      verdict: "approve",
      verdict_source: "model",
      requirement_coverage: [{
        requirement_id: "req-985",
        disposition: "met",
        enforcement: [{ file: ".dockerignore", line: 1 }],
        test: [],
        reason: "assets/ should not be excluded",
      }],
    });
    const traceResult = applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    assert.equal(traceResult.applied, true);
    assert.equal(traceResult.trace.rows[0]?.disposition, "unverifiable");
    assert.ok(traceResult.trace.rows[0]?.notes.includes("structural-proof-unconfirmed"), JSON.stringify(traceResult.trace.rows));
    const escalated = applyConfirmedUnmetEscalation(art, traceResult.trace, new Map(ledgerRequirementsById(ledger, ["req-985"]).map((e) => [e.id, e.text] as const)));
    assert.equal(escalated, 1);
    // The synthesized finding: blocker, requirements category, at the cited
    // location, stating the deterministic refutation — never the model-claim
    // wording "requirement not enforced: ".
    assert.equal(art.findings.length, 1);
    const finding = art.findings[0]!;
    assert.equal(finding.severity, "blocker");
    assert.equal(finding.category, "requirements");
    assert.equal(finding.file, ".dockerignore");
    assert.equal(finding.line, 1);
    assert.ok(finding.message.startsWith("Confirmed-unmet requirement req-985:"), finding.message);
    assert.ok(finding.message.includes("the cited repository state at head does not satisfy it"), finding.message);
    assert.ok(!finding.message.includes("copies the value without comparing it"), finding.message);
    assert.ok(!finding.message.includes("requirement not enforced:"), "must not borrow the model-claim wording");
    assert.ok(finding.message.includes("`.dockerignore` must not exclude `assets/`"), finding.message);
    // The verdict flip with deterministic provenance, plus the one-line
    // markdown disclosure.
    assert.equal(art.verdict, "request_changes");
    assert.equal(art.verdict_source, "enforcement");
    assert.ok(art.review_markdown.includes("_1 in-scope requirement(s) are confirmed unmet by deterministic repository-state proof; the verdict is escalated to request changes._"));
    // #811 strict mapping agrees through the same synthesized finding.
    const outcome = applyStrictVerdictPolicy(art as unknown as Parameters<typeof applyStrictVerdictPolicy>[0], { modelVerdict: "approve", forced: false });
    assert.equal(outcome.verdict, "request_changes");
    assert.equal(outcome.reviewResult, "issues");
    assert.equal(outcome.overridden, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1145: the escalation is a no-op when no row is refuted (the #1095 boundary stays intact)", () => {
  const workspace = makeWorkspace();
  try {
    // Untraced (coverage gap) and model-claimed unmet (known gap): neither is
    // a refutation, so the escalate pass must not synthesize anything.
    const trace = traceWithRows([
      {
        requirement_id: "req-1", disposition: "unverifiable", proof: "runtime_behavior",
        enforcement: [], test: [], reason: "x",
        notes: ["not-traced-by-reviewer"],
      },
      {
        requirement_id: "req-2", disposition: "unmet", proof: "runtime_behavior",
        enforcement: [], test: [], reason: "no enforcement found",
        notes: [],
      },
    ]);
    const art = artifact({ verdict: "approve", verdict_source: "model" });
    const escalated = applyConfirmedUnmetEscalation(art, trace, new Map([["req-1", "text"], ["req-2", "text"]]));
    assert.equal(escalated, 0);
    assert.deepEqual(art.findings, []);
    assert.equal(art.verdict, "approve");
    assert.equal(art.verdict_source, "model");
    assert.equal(art.review_markdown, "review");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1145: a model that already returned request_changes is not re-labeled, but still gains the finding and disclosure", () => {
  const trace = traceWithRows([
    {
      requirement_id: "req-1", disposition: "unverifiable", proof: "structural_state",
      enforcement: [{ file: ".dockerignore", line: 1 }], test: [], reason: "x",
      notes: ["structural-proof-unconfirmed"],
    },
  ]);
  const art = artifact({ verdict: "request_changes", verdict_source: "findings" });
  const escalated = applyConfirmedUnmetEscalation(art, trace, new Map([["req-1", "`.dockerignore` must not exclude `assets/`"]]));
  assert.equal(escalated, 1);
  assert.equal(art.verdict, "request_changes");
  assert.equal(art.verdict_source, "findings", "the existing provenance label stands");
  assert.equal(art.findings.length, 1);
  assert.ok(art.findings[0]!.message.includes("the cited repository state at head does not satisfy it"));
  assert.ok(art.review_markdown.includes("confirmed unmet by deterministic repository-state proof"));
});

test("#1145: beyond MAX_CONFIRMED_UNMET_FINDINGS refuted rows the note carries the total", () => {
  const rows = Array.from({ length: MAX_CONFIRMED_UNMET_FINDINGS + 2 }, (_, i) => ({
    requirement_id: `req-${i}`,
    disposition: "unverifiable",
    proof: "runtime_behavior",
    enforcement: [{ file: "src/a.ts", line: i + 1 }],
    test: [],
    reason: "x",
    notes: ["structural-proof-unconfirmed"],
  }));
  const trace = traceWithRows(rows);
  const texts = new Map(rows.map((row) => [row.requirement_id, `Requirement ${row.requirement_id} must hold.`] as const));
  const art = artifact({ verdict: "approve", verdict_source: "model" });
  const escalated = applyConfirmedUnmetEscalation(art, trace, texts);
  assert.equal(escalated, MAX_CONFIRMED_UNMET_FINDINGS + 2);
  assert.equal(art.findings.length, MAX_CONFIRMED_UNMET_FINDINGS);
  assert.equal(art.verdict, "request_changes");
  assert.ok(art.review_markdown.includes(`${MAX_CONFIRMED_UNMET_FINDINGS + 2} in-scope requirement(s) are confirmed unmet`));
});

test("#1145: hostile id/text cannot forge artifact structure through the synthesized finding", () => {
  // The adversarial-boundary case (#252): ids and ledger texts are
  // untrusted — control chars stripped, ids backtick-stripped and capped,
  // texts capped — before they reach the finding message.
  const maliciousId = "req\x00evil\n`forged`\n".repeat(10);
  const rows = [{
    requirement_id: maliciousId,
    disposition: "unverifiable",
    proof: "structural_state",
    enforcement: [],
    test: [],
    reason: "x",
    notes: ["structural-proof-unconfirmed"],
  }];
  const trace = traceWithRows(rows);
  const art = artifact({ verdict: "approve", verdict_source: "model" });
  applyConfirmedUnmetEscalation(art, trace, new Map([[maliciousId, "y".repeat(500)]]));
  assert.equal(art.findings.length, 1);
  const message = art.findings[0]!.message;
  assert.ok(!/[\x00-\x1f\x7f]/.test(message), "no raw control characters");
  assert.ok(!message.includes("`"), "backticks stripped from the id");
  const sanitizedId = maliciousId.replace(/[\x00-\x1f\x7f`]/g, "").slice(0, MAX_RENDERED_ID_CHARS);
  assert.ok(message.startsWith(`Confirmed-unmet requirement ${sanitizedId}: `), message);
  assert.ok(message.length < 500, "ledger text is length-capped");
  assert.equal(art.findings[0]!.file, null, "no enforcement location → no location");
  assert.equal(art.findings[0]!.line, null);
});

test("#1145: the escalation is stable against the #976/#977 relaxers (they refuse to re-approve)", () => {
  // The non-strict branch order: the escalation runs, then the relaxers.
  // `canRelaxForCiOnly` refuses once `requirement_trace_incomplete` is set,
  // and the synthesized blocker is not a relaxable category — neither path
  // may flip the verdict back to approve.
  const art = artifact({
    verdict: "request_changes",
    verdict_source: "enforcement",
    requirement_trace_incomplete: true,
    findings: [
      { severity: "info", category: "ci", message: "ci only", ci_capped: true },
    ],
  });
  assert.equal(relaxCiOnlyVerdict(art, { forced: false }), false);
  assert.equal(relaxVerificationOnlyVerdict(art, { forced: false }), false);
  assert.equal(art.verdict, "request_changes");
});

test("#1248: a confirmed-unmet escalation flip supersedes a prior relaxation note", () => {
  const trace = traceWithRows([
    {
      requirement_id: "req-1", disposition: "unverifiable", proof: "structural_state",
      enforcement: [{ file: "src/a.ts", line: 1 }], test: [], reason: "x",
      notes: ["structural-proof-unconfirmed"],
    },
  ]);
  const art = artifact({
    verdict: "approve",
    verdict_source: "findings",
    review_markdown: "review\n\n_Verdict relaxed from structured findings (verdict_policy=findings_severity_gated): every blocking finding was in a category this repository marks non-blocking (non_blocking_finding_categories); they remain listed above._",
  });
  const escalated = applyConfirmedUnmetEscalation(art, trace, new Map([["req-1", "must hold"]]));
  assert.equal(escalated, 1);
  assert.equal(art.verdict, "request_changes");
  assert.equal(art.verdict_source, "enforcement");
  assert.ok(art.review_markdown.includes("_Verdict relaxation superseded by enforcement: originally relaxed from structured findings"));
  assert.ok(!art.review_markdown.includes("_Verdict relaxed from"));
});
