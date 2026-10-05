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
  validateRequirementTrace,
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
  assert.equal(renderRequirementTraceMarkdown({ version: 1, rows: [{ requirement_id: "r", disposition: "met", enforcement: [], test: [], reason: "", notes: [] }], incomplete: false, errors: [] }), "");
});

test("renderRequirementTraceMarkdown: collapses behind <details> once the ledger is large", () => {
  const rows = Array.from({ length: 6 }, (_unused, i) => ({
    requirement_id: `r${i}`, disposition: i === 0 ? "unmet" : "met", enforcement: [], test: [], reason: "gap", notes: [],
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
