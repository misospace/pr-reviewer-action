/**
 * #1658: the trace is non-certifying by default. Provider-free deterministic
 * fixtures pinning the narrowed contract:
 *
 * - ordinary runtime behavior (the #1643 counter-reporting shape) completes
 *   without a comparison predicate and without a regression-test citation;
 * - a mechanically decidable invariant (a pinned SHA literal, path
 *   containment) is still re-derived from the exact-head state — confirmed
 *   when it holds, deterministically refuted when it does not;
 * - a missing proof shape is never a confirmed defect: unknown rows are
 *   exposed (resolution/materiality/summary) for the final-disposition
 *   layer (#1656) without touching required_checks, findings, or verdict;
 * - prohibition-by-absence is not fabricated unmet for lack of a positive
 *   predicate;
 * - an external/post-merge criterion stays a pending advisory;
 * - no trace-only model pass or validator tutoring exists to make an
 *   otherwise adequate review "complete" — the machinery is deleted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyRequirementTraceEnforcement,
  PENDING_DISPOSITION,
  validateRequirementTrace,
  type RequirementTraceArtifact,
} from "../src/enforcement/requirement-trace.js";
import type { ReviewArtifact } from "../src/enforcement/artifact.js";

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "trace-narrow-"));
}
function writeFile(workspace: string, relPath: string, lines: readonly string[]): void {
  mkdirSync(join(workspace, ...relPath.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(workspace, relPath), `${lines.join("\n")}\n`);
}
function ledgerWith(entries: Array<{ id: string; text: string; kind: string; provenance?: Array<{ source: string }> }>): unknown {
  return { requirements: entries };
}
function artifact(overrides: Record<string, unknown> = {}): ReviewArtifact {
  return { verdict: "approve", required_checks: "none", review_markdown: "review", findings: [], ...overrides } as ReviewArtifact;
}

test("#1643: a copy-only citation with no predicate anywhere remains evidenced — the deleted lexical rules cannot downgrade it", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/telemetry/counter.ts", [
      "export function reportCounter(value: number): void {",
      "  summary.add(value);",
      "}",
    ]);
    writeFile(workspace, "tests/telemetry/counter.test.ts", [
      "import { reportCounter } from \"../src/telemetry/counter.ts\";",
      "reportCounter(1);",
    ]);
    const ledger = ledgerWith([{ id: "req-counter", text: "The counter must report its value in the run summary.", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-counter",
      disposition: "met",
      enforcement: [{ file: "src/telemetry/counter.ts", line: 2 }],
      test: [{ file: "tests/telemetry/counter.test.ts", line: 2 }],
      reason: "",
    }];
    // The cited line is assignment/copy-shaped (summary.add) and nothing in
    // the fixture compares anything: the deleted #874 proof-shape system
    // would have rejected exactly this review. It cannot come back.
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows.length, 1);
    assert.equal(trace.rows[0]!.disposition, "met");
    assert.equal(trace.rows[0]!.proof, "runtime_behavior");
    assert.equal(trace.rows[0]!.resolution, "evidenced");
    assert.equal(trace.rows[0]!.materiality, "advisory");
    assert.ok(!trace.rows[0]!.notes.includes("enforcement-location-copies-without-comparing"));
    assert.equal(trace.incomplete, false);
    assert.deepEqual(trace.summary, {
      confirmed_unmet: [], unmet_claimed: [], unresolved_material: [], unresolved_advisory: [], total_rows: 1,
    });
    // Non-certifying: the adequate review publishes untouched — no
    // required-check escalation, no synthesized finding, no verdict flip.
    const art = artifact({ requirement_coverage: claims });
    const result = applyRequirementTraceEnforcement(art, {
      enabled: true, ledger, workspace, changed: "+ summary.add(value);",
    });
    assert.equal(result.applied, true);
    assert.equal(art.required_checks, "none");
    assert.equal(art.verdict, "approve");
    assert.equal(art.findings.length, 0);
    assert.notEqual(art.requirement_trace_incomplete, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an arbitrary runtime requirement does not require a test-path/predicate-shaped citation", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/render/view.ts", ["export function render(v: string): string {", "  return v;", "}"]);
    const ledger = ledgerWith([{ id: "req-render", text: "The view must render the value it is given.", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-render",
      disposition: "met",
      enforcement: [{ file: "src/render/view.ts", line: 2 }],
      test: [],
      reason: "",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]!.disposition, "met");
    assert.equal(trace.rows[0]!.resolution, "evidenced");
    assert.equal(trace.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a mechanical pinned-SHA/path invariant still validates deterministically — confirmed when it holds", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "requirements/lockfile.txt", ["pinned: 3b224f851a7721d92161922fa49a722751b2a321"]);
    const ledger = ledgerWith([{
      id: "req-pin",
      text: "`requirements/lockfile.txt` must contain `3b224f851a7721d92161922fa49a722751b2a321`",
      kind: "acceptance",
    }]);
    const claims = [{
      requirement_id: "req-pin",
      disposition: "met",
      enforcement: [{ file: "requirements/lockfile.txt", line: 1 }],
      test: [],
      reason: "",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]!.disposition, "met");
    assert.equal(trace.rows[0]!.proof, "structural_state");
    assert.equal(trace.rows[0]!.resolution, "confirmed");
    assert.equal(trace.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a mechanically decidable invariant whose state contradicts it is a deterministic refutation, not a bookkeeping gap", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "requirements/lockfile.txt", ["pinned: 0000000000000000000000000000000000000000"]);
    const ledger = ledgerWith([{
      id: "req-pin",
      text: "`requirements/lockfile.txt` must contain `3b224f851a7721d92161922fa49a722751b2a321`",
      kind: "acceptance",
    }]);
    const claims = [{
      requirement_id: "req-pin",
      disposition: "met",
      enforcement: [{ file: "requirements/lockfile.txt", line: 1 }],
      test: [],
      reason: "",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]!.disposition, "unverifiable");
    assert.equal(trace.rows[0]!.resolution, "confirmed_unmet");
    assert.equal(trace.rows[0]!.materiality, "material");
    assert.equal(trace.incomplete, true);
    assert.deepEqual(trace.summary.confirmed_unmet, ["req-pin"]);
    // The one retained fail-closed guard: the relaxers cannot relax past a
    // deterministic refutation. It stays narrow — required_checks and the
    // verdict are untouched; #1656 maps the refutation.
    const art = artifact({ requirement_coverage: claims });
    applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    assert.equal(art.requirement_trace_incomplete, true);
    assert.equal(art.required_checks, "none");
    assert.equal(art.verdict, "approve");
    assert.equal(art.findings.length, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a semantic unmet flows through the reviewer's own finding, not a hidden trace blocker", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/gate.ts", ["export const gate = (ok: boolean) => ok;"]);
    const ledger = ledgerWith([{ id: "req-gate", text: "The gate must validate the account identity.", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-gate",
      disposition: "unmet",
      enforcement: [],
      test: [],
      reason: "the gate never validates anything",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]!.disposition, "unmet");
    assert.equal(trace.rows[0]!.resolution, "unmet_claimed");
    assert.equal(trace.rows[0]!.materiality, "material");
    assert.deepEqual(trace.summary.unmet_claimed, ["req-gate"]);
    // Exposure only: the model's own major finding carries the disposition.
    const art = artifact({ verdict: "request_changes", requirement_coverage: claims, findings: [{ severity: "major", category: "correctness", file: "src/gate.ts", line: 1, message: "gate does not validate" }] });
    applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    assert.equal(art.verdict, "request_changes");
    assert.equal(art.required_checks, "none");
    assert.equal(art.findings.length, 1, "the trace never synthesizes findings");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a material unknown feeds the disposition state instead of becoming a fabricated unmet", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/loop.ts", ["export const step = () => 1;"]);
    const ledger = ledgerWith([{ id: "req-untraced", text: "The loop must handle the resumed session.", kind: "acceptance" }]);
    const trace = validateRequirementTrace([], ledger, workspace);
    assert.equal(trace.rows[0]!.disposition, "unverifiable");
    assert.equal(trace.rows[0]!.resolution, "unresolved");
    assert.equal(trace.rows[0]!.materiality, "material");
    assert.ok(trace.rows[0]!.notes.includes("not-traced-by-reviewer"));
    assert.deepEqual(trace.summary.unresolved_material, ["req-untraced"]);
    assert.equal(trace.incomplete, false, "an unknown is never a fabricated unmet");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("invalid objective provenance for an in-scope mandatory runtime row is a material unknown", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/view.ts", ["export const view = () => 1;"]);
    const ledger = ledgerWith([{ id: "req-view", text: "The view must render the summary row.", kind: "acceptance" }]);
    // A met claim whose cited location does NOT exist at reviewed head: the
    // semantic assertion has no objective provenance behind it.
    const claims = [{
      requirement_id: "req-view",
      disposition: "met",
      enforcement: [{ file: "src/view.ts", line: 99999 }],
      test: [],
      reason: "",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]!.disposition, "unverifiable");
    assert.ok(trace.rows[0]!.notes.includes("downgraded-no-valid-enforcement-location"));
    // #1658 review: invalid provenance is a material unknown, not advisory
    // bookkeeping — the reviewer asserted a state the citation cannot back.
    // It is exposure, not certification: no incomplete, no veto by itself.
    assert.equal(trace.rows[0]!.resolution, "unresolved");
    assert.equal(trace.rows[0]!.materiality, "material");
    assert.deepEqual(trace.summary.unresolved_material, ["req-view"]);
    assert.deepEqual(trace.summary.unresolved_advisory, []);
    assert.equal(trace.incomplete, false);
    const art = artifact({ requirement_coverage: claims });
    applyRequirementTraceEnforcement(art, { enabled: true, ledger, workspace });
    assert.equal(art.required_checks, "none");
    assert.equal(art.verdict, "approve");
    assert.notEqual(art.requirement_trace_incomplete, true);
    // An out-of-RANGE line on an existing file is the same material case.
    writeFile(workspace, "src/wide.ts", ["export const a = 1;"]);
    const ledger2 = ledgerWith([{ id: "req-wide", text: "The wide module must export the value.", kind: "acceptance" }]);
    const trace2 = validateRequirementTrace([{
      requirement_id: "req-wide", disposition: "met",
      enforcement: [{ file: "src/wide.ts", line: 500 }], test: [], reason: "",
    }], ledger2, workspace);
    assert.equal(trace2.rows[0]!.materiality, "material");
    assert.deepEqual(trace2.summary.unresolved_material, ["req-wide"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a test_required row whose explicitly-required test provenance is invalid is a material unknown", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/gate.ts", ["export function check(t) {", "  return t === expected;", "}"]);
    const ledger = ledgerWith([{
      id: "req-gate-test",
      text: "The gate must validate the token and must be covered by a regression test.",
      kind: "acceptance",
    }]);
    // Valid enforcement provenance, but the demanded test citation points at
    // a file that does not exist at head.
    const claims = [{
      requirement_id: "req-gate-test",
      disposition: "met",
      enforcement: [{ file: "src/gate.ts", line: 2 }],
      test: [{ file: "tests/gate/missing.test.ts", line: 1 }],
      reason: "",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]!.disposition, "unverifiable");
    assert.ok(trace.rows[0]!.notes.includes("downgraded-no-valid-test-location"));
    assert.equal(trace.rows[0]!.proof, "test_required");
    assert.equal(trace.rows[0]!.resolution, "unresolved");
    assert.equal(trace.rows[0]!.materiality, "material");
    assert.deepEqual(trace.summary.unresolved_material, ["req-gate-test"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a malformed semantic disposition on an in-scope mandatory runtime row is a material unknown", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/loop.ts", ["export const step = () => 1;"]);
    const ledger = ledgerWith([{ id: "req-loop", text: "The loop must advance the session state.", kind: "acceptance" }]);
    // "pending" is not model vocabulary: the semantic claim is unusable.
    const trace = validateRequirementTrace(
      [{ requirement_id: "req-loop", disposition: "pending", reason: "trust me" }],
      ledger, workspace,
    );
    assert.equal(trace.rows[0]!.disposition, "unverifiable");
    assert.ok(trace.rows[0]!.notes.includes("disposition-invalid"));
    assert.equal(trace.rows[0]!.resolution, "unresolved");
    assert.equal(trace.rows[0]!.materiality, "material");
    assert.deepEqual(trace.summary.unresolved_material, ["req-loop"]);
    assert.equal(trace.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("prohibition-by-absence is not fabricated unmet merely for lack of a positive predicate", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "config/settings.yaml", ["log_level: info"]);
    const ledger = ledgerWith([{ id: "req-absent", text: "`config/settings.yaml` must not contain `debug_logging`", kind: "acceptance" }]);
    const claims = [{
      requirement_id: "req-absent",
      disposition: "met",
      enforcement: [{ file: "config/settings.yaml", line: 1 }],
      test: [],
      reason: "",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace);
    assert.equal(trace.rows[0]!.disposition, "met", "absence is objectively established from the head state");
    assert.equal(trace.rows[0]!.resolution, "confirmed");
    // A runtime prohibition is ordinary behavior: evidenced by its citation,
    // never rejected for lacking an artificial comparison.
    writeFile(workspace, "src/emit.ts", ["export const emit = () => null;"]);
    const ledger2 = ledgerWith([{ id: "req-noemit", text: "The exporter must never emit records to third-party endpoints.", kind: "acceptance" }]);
    const claims2 = [{
      requirement_id: "req-noemit",
      disposition: "met",
      enforcement: [{ file: "src/emit.ts", line: 1 }],
      test: [],
      reason: "",
    }];
    const trace2 = validateRequirementTrace(claims2, ledger2, workspace);
    assert.equal(trace2.rows[0]!.disposition, "met");
    assert.equal(trace2.rows[0]!.resolution, "evidenced");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an external/post-merge criterion is handled by applicability as a pending advisory", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/deploy.ts", ["export const plan = () => 1;"]);
    const ledger = ledgerWith([{ id: "req-postmerge", text: "Whether the unrelated pull request #42 will merge successfully after this change", kind: "acceptance" }]);
    const trace = validateRequirementTrace([], ledger, workspace);
    assert.equal(trace.rows[0]!.disposition, PENDING_DISPOSITION);
    assert.equal(trace.rows[0]!.proof, "external_state");
    assert.equal(trace.rows[0]!.resolution, "pending");
    assert.equal(trace.rows[0]!.materiality, "advisory");
    assert.equal(trace.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("linked-issue provenance alone is no mandatory current-change proof obligation; security vocabulary never narrows away", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/unrelated/widget.ts", ["export const widget = () => 1;"]);
    const ledger = ledgerWith([
      { id: "req-posting", text: "The changelog must be posted to the release discussion after merge.", kind: "acceptance", provenance: [{ source: "linked_issues" }] },
      { id: "req-secret", text: "The credential must never be written to the untrusted render buffer.", kind: "acceptance", provenance: [{ source: "linked_issues" }] },
    ]);
    const claims: unknown[] = [];
    // Attributable change evidence that touches neither requirement's
    // boundary: the ordinary linked row narrows out; the trust-boundary row
    // never does.
    const trace = validateRequirementTrace(claims, ledger, workspace, "+ export const widget = () => 1;", {
      paths: ["src/unrelated/widget.ts"],
      fileLines: [{ path: "src/unrelated/widget.ts", lines: ["+ export const widget = () => 1;"] }],
    });
    const posting = trace.rows.find((row) => row.requirement_id === "req-posting");
    const secret = trace.rows.find((row) => row.requirement_id === "req-secret");
    assert.equal(posting?.disposition, "not_applicable");
    assert.ok(posting?.notes.includes("out-of-scope"));
    assert.equal(secret?.disposition, "unverifiable", "the security/trust-boundary requirement stays in scope (fail closed)");
    assert.equal(trace.incomplete, false);
    assert.deepEqual(trace.summary.unresolved_material, ["req-secret"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("no trace-only model pass or validator tutoring exists to make an adequate review complete", () => {
  const fsmod = require("node:fs") as typeof import("node:fs");
  const here = resolve(__dirname, "..");
  assert.equal(fsmod.existsSync(join(here, "src/requirements/trace-repair.ts")), false, "the standalone repair pass is deleted");
  assert.equal(fsmod.existsSync(join(here, "src/requirements/trace-gap-probe.ts")), false, "the in-loop gap probe is deleted");
  // The validator itself carries no repair context option: the claim
  // hygiene it performs (bounded reason, dropped malformed locations,
  // disposition normalization) never changes substantive evidence.
  const trace: RequirementTraceArtifact = validateRequirementTrace(
    [{ requirement_id: "req-x", disposition: "met", enforcement: [{ file: "src/a.ts", line: 1 }] }],
    ledgerWith([{ id: "req-x", text: "must do x", kind: "acceptance" }]),
    makeWorkspace(),
  );
  assert.equal(trace.rows[0]!.disposition, "unverifiable");
  assert.ok(trace.rows[0]!.notes.includes("downgraded-no-valid-enforcement-location"));
  assert.equal(trace.incomplete, false);
});
