import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewArtifact } from "../src/enforcement/artifact.js";
import { applyRequirementTraceFragment, workspaceAt } from "../src/prompt/index.js";
import { applyStrictVerdictPolicy } from "../src/enforcement/verdict-policy.js";
import {
  applyRequirementTraceEnforcement,
  ensureUnmetRequirementFindings,
  extractRequirementTerms,
  renderRequirementTraceMarkdown,
  changedSubjectText,
  requirementNotEnforcedMessage,
  requirementTraceScope,
  validateRequirementTrace,
} from "../src/enforcement/requirement-trace.js";

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
