import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewArtifact } from "../src/enforcement/artifact.js";
import { applyRequirementTraceFragment, workspaceAt } from "../src/prompt/index.js";
import { traceChangedText } from "../src/run/review.js";
import { RunWorkspace } from "../src/run/workspace.js";
import { applyStrictVerdictPolicy } from "../src/enforcement/verdict-policy.js";
import { isValidOwnerPattern, parseRequirementOwners, resolveRequirementOwners } from "../src/config/requirement-owners.js";
import {
  applyRequirementTraceEnforcement,
  MAX_DECLARED_GROUPS_PER_RULE,
  MAX_DISTRIBUTED_HINTS,
  distributedRequirementHints,
  ensureUnmetRequirementFindings,
  extractRequirementTerms,
  ledgerRequirementsById,
  mergeTraceClaims,
  missingTraceRequirementIds,
  renderRequirementTraceMarkdown,
  changedSubjectText,
  requirementNotEnforcedMessage,
  requirementSubjectSignals,
  requirementTraceScope,
  structuralStateClaim,
  explicitlyRequiresTest,
  validateRequirementTrace,
  type RequirementOwnership,
  type RequirementTraceArtifact,
} from "../src/enforcement/requirement-trace.js";
import { buildTraceRepairUserMessage, normalizeTraceRepairPayload, runRequirementTraceRepairPass } from "../src/requirements/trace-repair.js";

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

test("ensureUnmetRequirementFindings: synthesizes a finding for an unmet requirement with none", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "acceptance" }]);
    const claims = [{ requirement_id: "req-1", disposition: "unmet", reason: "no such check exists" }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    const art = artifact();
    const added = ensureUnmetRequirementFindings(art, trace, ledger);
    assert.equal(added, 1);
    assert.equal(art.findings.length, 1);
    assert.equal(art.findings[0]?.message, requirementNotEnforcedMessage("must validate X"));
    assert.equal(art.findings[0]?.severity, "major");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("ensureUnmetRequirementFindings: does not duplicate a finding the model already gave", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "acceptance" }]);
    const claims = [{ requirement_id: "req-1", disposition: "unmet", reason: "no such check exists" }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    const art = artifact({ findings: [{ severity: "major", category: "bug", file: "a.ts", line: 1, message: "must validate X is missing" }] });
    const added = ensureUnmetRequirementFindings(art, trace, ledger);
    assert.equal(added, 0);
    assert.equal(art.findings.length, 1);
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

test("#874 end-to-end: an unmet requirement with no finding gets one and forces request_changes under strict", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "the list path must enforce target.repo === ctx.repoDid", kind: "acceptance" }]);
    const art = artifact({
      verdict: "approve",
      requirement_coverage: [{ requirement_id: "req-1", disposition: "unmet", reason: "list path has no such check" }],
    });
    applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    assert.equal(art.findings.length, 1);
    assert.equal(art.findings[0]?.severity, "major");

    const outcome = applyStrictVerdictPolicy(art, { modelVerdict: "approve", forced: false });
    assert.equal(outcome.verdict, "request_changes");
    assert.equal(outcome.reviewResult, "issues");
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
  { match: ["fork", "privilege", "separation"], owners: [".github/workflows/fork-ai-review.yaml", "scripts/fork_review_gate.py"] },
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

  // The fork-privilege standard guards .github/workflows/fork-ai-review.yaml:
  // ordinary workflow edits there need not repeat "fork privilege" or
  // "trust boundary", but the declared owner path keeps it in scope — and it
  // scopes only that standard.
  assert.deepEqual(scope([".github/workflows/fork-ai-review.yaml"]), ["req-fork"]);
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
    "      - .github/workflows/fork-ai-review.yaml",
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
    { match: ["fork", "privilege", "separation"], owners: [".github/workflows/fork-ai-review.yaml", "scripts/fork_review_gate.py"] },
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
      "      - .github/workflows/fork-ai-review.yaml",
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
  const changed = changedSubjectText("+x\n", [".github/workflows/fork-ai-review.yaml"]);
  // A non-string token (which the parser never produces) must be dropped, not throw.
  assert.doesNotThrow(() =>
    requirementTraceScope(ledger, changed, { ownership: [{ match: [42] as never, owners: [".github/workflows/fork-ai-review.yaml"] }], paths: [".github/workflows/fork-ai-review.yaml"] }),
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
  owners: [".github/workflows/fork-ai-review.yaml"],
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
