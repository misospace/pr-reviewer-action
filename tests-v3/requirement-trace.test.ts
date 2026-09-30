import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewArtifact } from "../src/enforcement/artifact.js";
import { applyStrictVerdictPolicy } from "../src/enforcement/verdict-policy.js";
import {
  applyRequirementTraceEnforcement,
  ensureUnmetRequirementFindings,
  renderRequirementTraceMarkdown,
  requirementNotEnforcedMessage,
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
  writeFileSync(join(dir, "src", "real.ts"), "line1\nline2\nline3\n");
  return dir;
}

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

test("validateRequirementTrace: met with a valid enforcement location stays met", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-1",
      disposition: "met",
      enforcement: [{ file: "src/real.ts", line: 2 }],
      test: [{ file: "src/real.ts", line: 3 }],
      reason: "checked",
    }];
    const result = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.disposition, "met");
    assert.equal(result.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#854 reproduction: met with a non-existent enforcement line is downgraded to unverifiable", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "match source SHA", kind: "acceptance" }]);
    // The model claims the requirement is met, citing a line that does not
    // exist in the file — exactly #854's shape: sourceSha was copied into
    // output and never compared, but the review said satisfied anyway.
    const claims = [{
      requirement_id: "req-1",
      disposition: "met",
      enforcement: [{ file: "src/real.ts", line: 999 }],
      test: [],
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

test("met citing a non-existent file is downgraded", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "must validate X", kind: "normative" }]);
    const claims = [{ requirement_id: "req-1", disposition: "met", enforcement: [{ file: "src/nope.ts", line: 1 }] }];
    const result = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(result.rows[0]?.disposition, "unverifiable");
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

test("not_applicable needs no enforcement/test evidence", () => {
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
    const claims = [{ requirement_id: "req-1", disposition: "unmet" }];
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

test("#854 end-to-end: a downgraded met-claim marks coverage incomplete (partial), never approve from findings alone", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([{ id: "req-1", text: "review context must match the PR's source SHA and target branch", kind: "acceptance" }]);
    const art = artifact({
      verdict: "approve",
      requirement_coverage: [{
        requirement_id: "req-1",
        disposition: "met",
        enforcement: [{ file: "src/real.ts", line: 999 }],
        test: [],
        reason: "sourceSha is copied onto the output object",
      }],
    });
    const traceResult = applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    assert.equal(traceResult.trace.rows[0]?.disposition, "unverifiable");
    assert.equal(art.required_checks, "incomplete");
    assert.ok(art.review_markdown.includes("Requirement trace"));

    // The strict verdict mapping (#811, production composition order: this
    // pass runs before it) still finds no blocking finding here (#873, which
    // makes an incomplete review non-approving, is a separate in-review PR —
    // see #878), so the verdict itself is unaffected; only review_result
    // (derived from required_checks) is partial.
    const outcome = applyStrictVerdictPolicy(art, { modelVerdict: "approve", forced: false });
    assert.equal(outcome.reviewResult, "partial");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#854 end-to-end: an unmet requirement with no finding gets one and forces request_changes under strict", () => {
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
