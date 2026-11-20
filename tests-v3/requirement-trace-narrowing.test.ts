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
import { buildLinkedIssueContext } from "../src/context/index.js";
import { extractRequirementLedger } from "../src/requirements/index.js";

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "trace-narrow-"));
}
function writeFile(workspace: string, relPath: string, lines: readonly string[]): void {
  mkdirSync(join(workspace, ...relPath.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(workspace, relPath), `${lines.join("\n")}\n`);
}
function ledgerWith(entries: Array<{
  id: string;
  text: string;
  kind: string;
  provenance?: Array<{ source: string; ref?: string; line?: number; closing?: boolean; labels?: string[]; childRefs?: string[] }>;
}>): unknown {
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

// ---------------------------------------------------------------------------
// #1658 review round: an IN-SCOPE `unmet_claimed` row is a material unknown
// at the single FinalDisposition seam — validator → scope marker → seam →
// disposition composition (no mocked flags, no synthesized blocker).
// ---------------------------------------------------------------------------

import { buildDispositionEvidence } from "../src/disposition/engine-evidence.js";
import { computeFinalDisposition } from "../src/disposition/final.js";
import { confirmedUnmetRows, requirementTraceScope, traceUnmetClaimedInScopeRows } from "../src/enforcement/requirement-trace.js";

/** The EXACT part derivation review.ts performs over an applied trace —
 * one seam, exercised against real validator output. */
function dispositionFromTrace(trace: RequirementTraceArtifact): ReturnType<typeof buildDispositionEvidence> {
  return buildDispositionEvidence({
    completenessChecks: [],
    obligations: [],
    findings: [],
    toolCapabilityFailure: null,
    toolFloorUnmet: false,
    noEvidenceReason: null,
    partialCoverageStopReason: null,
    traceUnresolvedMaterial: trace.summary.unresolved_material.length > 0,
    traceUnmetClaimed: traceUnmetClaimedInScopeRows(trace).length > 0,
    mechanicallyProvenUnmetRequirements: confirmedUnmetRows(trace).length,
    ciConclusion: null,
    ciEvidenceContractActive: false,
  });
}

function dispositionInput(evidence: ReturnType<typeof buildDispositionEvidence>["evidence"], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reviewProduced: true, validVerdict: true, verdict: "approve", degraded: false,
    exactHead: true, publicationHeadBound: true, blockingFindingOpen: false,
    evidenceProviderBlocker: false, provenUnmetRequirement: false,
    verdictBearing: true, approvalScopeAllowed: true, evidence, ...overrides,
  };
}

test("an in-scope unmet claim with model approve and no grounded finding withholds as INCOMPLETE (real composition)", () => {
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
    assert.equal(trace.summary.unmet_claimed.length, 1);
    assert.equal(traceUnmetClaimedInScopeRows(trace).length, 1, "the claim is in scope");
    const build = dispositionFromTrace(trace);
    assert.deepEqual(build.evidence.map((entry) => entry.subject), ["requirement-trace:unmet-claimed"]);
    assert.deepEqual(build.evidence.map((entry) => entry.materiality), ["material"]);
    assert.equal(build.provenUnmetRequirement, false, "a claim is never a refutation");
    const disposition = computeFinalDisposition(dispositionInput(build.evidence) as never);
    assert.equal(disposition.kind, "incomplete");
    assert.equal(disposition.reason, "material_unknown");
    assert.equal(disposition.nativeEvent, "COMMENT");
    assert.equal(disposition.approvalCertified, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the same claim with a grounded major finding is REQUEST_CHANGES through the finding path", () => {
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
    const build = dispositionFromTrace(trace);
    // The existing finding path: a grounded open blocker/major finding is
    // the input `blockingFindingOpen` — the disposition's fixed precedence
    // (step 2, proven defects) outranks the material unknown (step 3), so
    // the native event is REQUEST_CHANGES without any trace machinery.
    const disposition = computeFinalDisposition(dispositionInput(build.evidence, { blockingFindingOpen: true }) as never);
    assert.equal(disposition.kind, "request_changes");
    assert.equal(disposition.reason, "blocker_proven");
    assert.equal(disposition.nativeEvent, "REQUEST_CHANGES");
    assert.equal(disposition.blockerProven, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an out-of-scope unmet claim alone never prevents APPROVE (scope marker composition)", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/unrelated/widget.ts", ["export const widget = () => 1;"]);
    const ledger = ledgerWith([
      { id: "req-posting", text: "The changelog must be posted to the release discussion after merge.", kind: "acceptance", provenance: [{ source: "linked_issues" }] },
    ]);
    // The affected boundary is NOT touched, so the linked row narrows out;
    // the model still claims `unmet` on it — a well-formed gap claim on a
    // scope-settled requirement.
    const claims = [{
      requirement_id: "req-posting",
      disposition: "unmet",
      enforcement: [],
      test: [],
      reason: "no changelog posting exists yet",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace, "+ export const widget = () => 1;", {
      paths: ["src/unrelated/widget.ts"],
      fileLines: [{ path: "src/unrelated/widget.ts", lines: ["+ export const widget = () => 1;"] }],
    });
    const row = trace.rows.find((candidate) => candidate.requirement_id === "req-posting");
    assert.equal(row?.resolution, "unmet_claimed");
    assert.ok(row?.notes.includes("out-of-scope-reported-unmet"), "the out-of-scope claim carries the trusted disclosure marker");
    assert.deepEqual(trace.summary.unmet_claimed, ["req-posting"], "the claim stays disclosed on the artifact");
    // The scope marker keeps it OUT of the seam: no material evidence.
    assert.equal(traceUnmetClaimedInScopeRows(trace).length, 0);
    const build = dispositionFromTrace(trace);
    assert.deepEqual(build.evidence, [], "an out-of-scope claim is disclosure-only");
    const disposition = computeFinalDisposition(dispositionInput(build.evidence) as never);
    assert.equal(disposition.kind, "approve", "approval eligibility is unchanged");
    assert.equal(disposition.nativeEvent, "APPROVE");
    assert.equal(disposition.approvalCertified, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1749: a deferred umbrella criterion is disclosure-only — the clean scoped increment reaches native APPROVE (real composition)", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/planner/feed.ts", ["export const feed = (x: number) => x;"]);
    // The umbrella shape from the PR's own metadata: a non-closing ref to an
    // umbrella-labeled parent. The criterion shares the increment's
    // vocabulary — under the pre-#1749 scope rule that overlap alone made
    // the parent criterion a merge contract. #1750: the provenance also
    // carries the RICH TRUSTED SHAPE — the umbrella's own decomposition
    // associating this criterion with an owning child the PR does not
    // reference — without which the row now (correctly) stays in scope.
    const ledger = ledgerWith([
      {
        id: "req-umb",
        text: "The planner and the scheduler engine MUST share one feed.",
        kind: "acceptance",
        provenance: [{ source: "linked_issues", ref: "#42", line: 1, closing: false, labels: ["umbrella"], childRefs: ["o/r#101"] }],
      },
    ]);
    // The scope decision itself is proven first: out of scope, with the
    // machine reason citing the owning child.
    const scope = requirementTraceScope(ledger, "+// the planner feeds the scheduler engine", { prLinkedRefs: ["o/r#42"] });
    assert.deepEqual(scope.inScope, []);
    assert.match(scope.outOfScope[0]!.reason, /o\/r#101/, "the reason cites the owning child from the trusted decomposition");
    const claims = [{
      requirement_id: "req-umb",
      disposition: "unmet",
      enforcement: [],
      test: [],
      reason: "deferred to the separately linked engine-composition child; this PR does not claim the parent",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace, "+// the planner feeds the scheduler engine", { prLinkedRefs: ["o/r#42"] });
    const row = trace.rows.find((candidate) => candidate.requirement_id === "req-umb");
    assert.equal(row?.resolution, "unmet_claimed");
    assert.ok(row?.notes.includes("out-of-scope-umbrella-parent"), "the umbrella relationship is machine-readable on the row");
    assert.ok(row?.notes.includes("out-of-scope-reported-unmet"), "the claim stays disclosure-only");
    const build = dispositionFromTrace(trace);
    assert.deepEqual(build.evidence, [], "a deferred umbrella claim produces no disposition evidence");
    const disposition = computeFinalDisposition(dispositionInput(build.evidence) as never);
    assert.equal(disposition.kind, "approve", "the clean increment is not held at INCOMPLETE by parent work");
    assert.equal(disposition.reason, "approval_certified");
    assert.equal(disposition.nativeEvent, "APPROVE");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// #1750 (operator CR) NEGATIVE: the first #1749 cut let "non-closing ref +
// umbrella label" scope a criterion out on its own — the machine reason then
// claimed the criterion was owned by separate child work with no evidence
// that this was true. Without trusted ownership evidence the row stays in
// scope, the reviewer's unmet report is a material unknown, and the real
// disposition composition withholds as INCOMPLETE.
test("#1750 NEGATIVE: umbrella label + non-closing ref without trusted child ownership withholds approval (real composition)", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/planner/feed.ts", ["export const feed = (x: number) => x;"]);
    // The UNSAFE fixture: umbrella shape, no childRefs — the provenance
    // carries no trusted criterion→child association, so nothing may scope
    // the criterion out.
    const ledger = ledgerWith([
      {
        id: "req-umb",
        text: "The planner and the scheduler engine MUST share one feed.",
        kind: "acceptance",
        provenance: [{ source: "linked_issues", ref: "#42", line: 1, closing: false, labels: ["umbrella"] }],
      },
    ]);
    const claims = [{
      requirement_id: "req-umb",
      disposition: "unmet",
      enforcement: [],
      test: [],
      reason: "the shared feed is not implemented",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace, "+// the planner feeds the scheduler engine");
    const row = trace.rows.find((candidate) => candidate.requirement_id === "req-umb");
    assert.equal(row?.resolution, "unmet_claimed", "the criterion stayed in scope");
    assert.ok(!row?.notes.includes("out-of-scope-umbrella-parent"), "no ownership claim without the evidence");
    assert.equal(traceUnmetClaimedInScopeRows(trace).length, 1, "the claim is material");
    const build = dispositionFromTrace(trace);
    assert.deepEqual(build.evidence.map((entry) => entry.subject), ["requirement-trace:unmet-claimed"]);
    const disposition = computeFinalDisposition(dispositionInput(build.evidence) as never);
    assert.equal(disposition.kind, "incomplete", "the unsafe scope-out would have approved here");
    assert.equal(disposition.reason, "material_unknown");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1749 closing control: the same umbrella criterion claimed by a closing PR stays material (real composition)", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/planner/feed.ts", ["export const feed = (x: number) => x;"]);
    // Identical criterion, identical vocabulary — but the PR claims the
    // parent (a closing-keyword ref), so the criterion is a merge contract
    // and its unmet claim withholds certification. #1750: the trusted
    // ownership evidence is present too — a closing claim outranks it.
    const ledger = ledgerWith([
      {
        id: "req-umb",
        text: "The planner and the scheduler engine MUST share one feed.",
        kind: "acceptance",
        provenance: [{ source: "linked_issues", ref: "#42", line: 1, closing: true, labels: ["umbrella"], childRefs: ["o/r#101"] }],
      },
    ]);
    const claims = [{
      requirement_id: "req-umb",
      disposition: "unmet",
      enforcement: [],
      test: [],
      reason: "the shared feed is not implemented",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace, "+// the planner feeds the scheduler engine");
    const row = trace.rows.find((candidate) => candidate.requirement_id === "req-umb");
    assert.equal(row?.resolution, "unmet_claimed");
    assert.ok(!row?.notes.includes("out-of-scope-umbrella-parent"), "a closing claim is never umbrella-narrowed");
    assert.equal(traceUnmetClaimedInScopeRows(trace).length, 1, "the in-scope claim is material");
    const build = dispositionFromTrace(trace);
    assert.deepEqual(build.evidence.map((entry) => entry.subject), ["requirement-trace:unmet-claimed"]);
    const disposition = computeFinalDisposition(dispositionInput(build.evidence) as never);
    assert.equal(disposition.kind, "incomplete");
    assert.equal(disposition.reason, "material_unknown");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ── #1750 round 3 (operator follow-up): child-attested ownership, end to end
// through the REAL seams — intake renders the `(decomposition: …)` line from
// the organic umbrella shape (flat decomposition list + a parent-naming
// child), the ledger attaches it as `childRefs` provenance, the unchanged
// scope predicate consumes it, and the disposition composition certifies the
// clean increment. The organic POSITIVE uses the calibrated real texts
// (#740's scheduler/engine criterion ↔ #1677's own criterion); the AMBIGUOUS
// negative adds #1678, whose twin criterion also attests it — many-to-many
// stays in scope by rule.

const ORGANIC_PARENT_CRITERION = "GitLab and Gitea feed the same scheduler/engine.";
const ORGANIC_CHILD_CRITERION = "GitLab merge_request webhook events normalize to CanonicalForgeEvent and produce ReviewJobs that enter the same scheduler/engine as GitHub/Forgejo";
const ORGANIC_TWIN_CHILD_CRITERION = "Gitea pull_request webhook events normalize to CanonicalForgeEvent and produce ReviewJobs that enter the same scheduler/engine as GitHub/Forgejo";

function organicUmbrellaBody(criteriaLines: readonly string[], decompositionLines: readonly string[]): string {
  return [
    "## Acceptance criteria",
    "",
    ...criteriaLines,
    "",
    "<!-- dispatch-groomer:decomposition:start -->",
    "## Decomposition",
    "",
    "Created from this parent's grooming decomposition plan.",
    "",
    ...decompositionLines,
    "<!-- dispatch-groomer:decomposition:end -->",
    "",
  ].join("\n");
}

function organicChildBody(parentLine: string): string {
  return [
    "Parent: https://github.com/o/r/issues/42",
    "",
    "## Acceptance criteria",
    "",
    `- [ ] ${parentLine}`,
    "",
  ].join("\n");
}

async function organicLedger(decompositionLines: readonly string[], childCriteria: readonly string[]): Promise<unknown> {
  const children = new Map(childCriteria.map((criterion, index) => [
    String(1677 + index),
    { ok: true as const, data: { number: 1677 + index, title: `Child ${index}`, state: "open", html_url: "u", labels: [], body: organicChildBody(criterion) } },
  ]));
  const intake = await buildLinkedIssueContext({
    pr: { title: "feat: increment", body: "Part of #42" },
    repo: "o/r",
    adapter: {
      getIssue: async (repo: string, number: string) => {
        if (repo === "o/r" && number === "42") {
          return { ok: true as const, data: { number: 42, title: "Umbrella", state: "open", html_url: "u", labels: [{ name: "umbrella" }], body: organicUmbrellaBody([`- [ ] ${ORGANIC_PARENT_CRITERION}`], decompositionLines) } };
        }
        return children.get(number) ?? { ok: false as const, error: `no ${repo}#${number}` };
      },
    },
    isForkPr: "false",
    linear: { apiKey: "", prefixes: "", timeoutSec: "20", enableForForks: "false" },
  });
  return extractRequirementLedger({ linkedIssuesMarkdown: Buffer.from(intake.artifacts.get("linked-issues.md") ?? new Uint8Array()).toString("utf8") });
}

test("#1750 r3 organic: the flat-decomposition umbrella criterion scopes out via child attestation — the clean increment reaches native APPROVE (intake→ledger→scope→disposition)", async () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/planner/feed.ts", ["export const feed = (x: number) => x;"]);
    const ledger = await organicLedger(
      ["- #1677: https://forge.example/o/r/issues/1677"],
      [ORGANIC_CHILD_CRITERION],
    );
    const umb = (ledger as { requirements: Array<{ id: string; text: string; provenance: Array<Record<string, unknown>> }> }).requirements
      .find((entry) => entry.text === ORGANIC_PARENT_CRITERION);
    assert.ok(umb, "the umbrella criterion reached the ledger");
    assert.deepEqual(umb.provenance[0]?.childRefs, ["o/r#1677"], "the child attestation rode the ledger provenance seam unchanged");
    assert.equal(umb.provenance[0]?.closing, false);
    assert.deepEqual(umb.provenance[0]?.labels, ["umbrella"]);
    // The scope decision itself: out of scope, machine reason citing the
    // owning child, even though the change shares the criterion's vocabulary.
    const scope = requirementTraceScope(ledger, "+// feeds the same scheduler engine", { prLinkedRefs: ["o/r#42"] });
    assert.deepEqual(scope.inScope, []);
    assert.equal(scope.outOfScope.length, 1);
    assert.match(scope.outOfScope[0]!.reason, /o\/r#1677/, "the machine reason cites the owning child");
    const claims = [{
      requirement_id: umb.id,
      disposition: "unmet",
      enforcement: [],
      test: [],
      reason: "deferred to the attested owning child; this PR does not claim the parent",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace, "+// feeds the same scheduler engine", { prLinkedRefs: ["o/r#42"] });
    const row = trace.rows.find((candidate) => candidate.requirement_id === umb.id);
    assert.equal(row?.resolution, "unmet_claimed");
    assert.ok(row?.notes.includes("out-of-scope-umbrella-parent"), "the umbrella relationship is machine-readable on the row");
    assert.ok(row?.notes.includes("out-of-scope-reported-unmet"), "the claim stays disclosure-only");
    const build = dispositionFromTrace(trace);
    assert.deepEqual(build.evidence, [], "a deferred umbrella claim produces no disposition evidence");
    const disposition = computeFinalDisposition(dispositionInput(build.evidence) as never);
    assert.equal(disposition.kind, "approve", "the clean increment is not held at INCOMPLETE by parent work");
    assert.equal(disposition.reason, "approval_certified");
    assert.equal(disposition.nativeEvent, "APPROVE");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1750 r4 organic: the real #740/#1677/#1678 JOINT ownership scopes the scheduler/engine criterion out — the clean increment reaches native APPROVE (real texts)", async () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/planner/feed.ts", ["export const feed = (x: number) => x;"]);
    // Operator follow-up 7025382962: both decomposition children carry a twin
    // of the parent criterion (the real GitLab/Gitea texts) and each
    // independently passes every attestation gate, so this is JOINT
    // OWNERSHIP — the ledger entry carries the full bounded owner set and
    // the unchanged consumer scopes the criterion out of a clean increment
    // that references neither child.
    const ledger = await organicLedger(
      ["- #1677: https://forge.example/o/r/issues/1677", "- #1678: https://forge.example/o/r/issues/1678"],
      [ORGANIC_CHILD_CRITERION, ORGANIC_TWIN_CHILD_CRITERION],
    );
    const umb = (ledger as { requirements: Array<{ id: string; text: string; provenance: Array<Record<string, unknown>> }> }).requirements
      .find((entry) => entry.text === ORGANIC_PARENT_CRITERION);
    assert.ok(umb, "the umbrella criterion reached the ledger");
    assert.deepEqual(umb.provenance[0]?.childRefs, ["o/r#1677", "o/r#1678"], "the joint owner set rode the ledger provenance seam unchanged");
    assert.equal(umb.provenance[0]?.closing, false);
    assert.deepEqual(umb.provenance[0]?.labels, ["umbrella"]);
    const scope = requirementTraceScope(ledger, "+// feeds the same scheduler engine", { prLinkedRefs: ["o/r#42"] });
    assert.deepEqual(scope.inScope, []);
    assert.equal(scope.outOfScope.length, 1);
    assert.match(scope.outOfScope[0]!.reason, /o\/r#1677/, "the machine reason cites the first owning child");
    assert.match(scope.outOfScope[0]!.reason, /o\/r#1678/, "the machine reason cites the second owning child");
    const claims = [{
      requirement_id: umb.id,
      disposition: "unmet",
      enforcement: [],
      test: [],
      reason: "jointly owned by the two attested decomposition children; this PR does not claim the parent",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace, "+// feeds the same scheduler engine", { prLinkedRefs: ["o/r#42"] });
    const row = trace.rows.find((candidate) => candidate.requirement_id === umb.id);
    assert.equal(row?.resolution, "unmet_claimed");
    assert.ok(row?.notes.includes("out-of-scope-umbrella-parent"), "the joint ownership is machine-readable on the row");
    assert.ok(row?.notes.includes("out-of-scope-reported-unmet"), "the claim stays disclosure-only");
    const build = dispositionFromTrace(trace);
    assert.deepEqual(build.evidence, [], "a jointly-owned deferred criterion produces no disposition evidence");
    const disposition = computeFinalDisposition(dispositionInput(build.evidence) as never);
    assert.equal(disposition.kind, "approve", "the clean increment is not held at INCOMPLETE by jointly-owned parent work");
    assert.equal(disposition.reason, "approval_certified");
    assert.equal(disposition.nativeEvent, "APPROVE");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1750 r4 boundary: a PR referencing EITHER jointly-owning child keeps the parent criterion mandatory (real texts)", async () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/planner/feed.ts", ["export const feed = (x: number) => x;"]);
    // The joint owner set is two children; the operator's boundary control
    // holds per-child: a PR whose body references EITHER owner through the
    // trusted title/Implements/Refs grammar may be that child's implementer,
    // so the criterion stays mandatory (consumer semantics, unchanged).
    const ledger = await organicLedger(
      ["- #1677: https://forge.example/o/r/issues/1677", "- #1678: https://forge.example/o/r/issues/1678"],
      [ORGANIC_CHILD_CRITERION, ORGANIC_TWIN_CHILD_CRITERION],
    );
    const umb = (ledger as { requirements: Array<{ id: string; text: string; provenance: Array<Record<string, unknown>> }> }).requirements
      .find((entry) => entry.text === ORGANIC_PARENT_CRITERION);
    assert.ok(umb, "the umbrella criterion reached the ledger");
    const scope = requirementTraceScope(ledger, "+// the gitlab adapter normalizes webhook events", { prLinkedRefs: ["o/r#42", "o/r#1677"] });
    assert.equal(scope.inScope.length, 1, "referencing the first joint owner keeps the criterion in scope");
    assert.deepEqual(scope.outOfScope, []);
    const claims = [{
      requirement_id: umb.id,
      disposition: "unmet",
      enforcement: [],
      test: [],
      reason: "the shared scheduler/engine feed is not implemented",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace, "+// the gitlab adapter normalizes webhook events", { prLinkedRefs: ["o/r#42", "o/r#1677"] });
    const row = trace.rows.find((candidate) => candidate.requirement_id === umb.id);
    assert.equal(row?.resolution, "unmet_claimed");
    assert.ok(!row?.notes.includes("out-of-scope-umbrella-parent"), "referencing an owning child voids the ownership evidence");
    assert.equal(traceUnmetClaimedInScopeRows(trace).length, 1, "the claim is material");
    const build = dispositionFromTrace(trace);
    assert.deepEqual(build.evidence.map((entry) => entry.subject), ["requirement-trace:unmet-claimed"]);
    const disposition = computeFinalDisposition(dispositionInput(build.evidence) as never);
    assert.equal(disposition.kind, "incomplete", "referencing either jointly-owning child withholds");
    assert.equal(disposition.reason, "material_unknown");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #1749 follow-up: a plain `Refs` link is context, not a merge contract.
//
// `Refs owner/repo#N` is valid PR syntax for "related background" — GitHub
// gives it no development-link meaning. Intake renders the context
// relationship line, the ledger refuses the document as a requirement
// source, and the trace has nothing to hold the increment to — even when the
// referenced issue's criteria share the change's vocabulary, which is exactly
// the shape that made closing/implementation links contract-bearing.
// `Implements` (and the whole #1749/#1750 umbrella machinery) is unchanged:
// the control below keeps the identical criterion contract-carrying.
// ---------------------------------------------------------------------------

const CONTEXT_ISSUE_BODY = [
  "## Acceptance criteria",
  "",
  "- [ ] The planner and the scheduler engine MUST share one feed.",
  "",
  "Tracked separately; linked for background.",
  "",
].join("\n");

async function refRelationshipLedger(reference: string): Promise<unknown> {
  const intake = await buildLinkedIssueContext({
    pr: { title: "feat: planner feed increment", body: `${reference} #7` },
    repo: "o/r",
    adapter: {
      getIssue: async (repo: string, number: string) => number === "7"
        ? { ok: true as const, data: { number: 7, title: "Planner notes", state: "open", html_url: "u", labels: [], body: CONTEXT_ISSUE_BODY } }
        : { ok: false as const, error: `no ${repo}#${number}` },
    },
    isForkPr: "false",
    linear: { apiKey: "", prefixes: "", timeoutSec: "20", enableForForks: "false" },
  });
  return extractRequirementLedger({ linkedIssuesMarkdown: Buffer.from(intake.artifacts.get("linked-issues.md") ?? new Uint8Array()).toString("utf8") });
}

test("#1749 follow-up: a Refs-linked issue's criteria never scope the increment (intake→ledger→scope→disposition)", async () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/planner/feed.ts", ["export const feed = (x: number) => x;"]);
    const ledger = await refRelationshipLedger("Refs");
    assert.deepEqual((ledger as { requirements: unknown[] }).requirements, [],
      "the context issue contributed no requirement entries at all");
    const scope = requirementTraceScope(ledger, "+// planner feeds the scheduler engine", { prLinkedRefs: ["o/r#7"] });
    assert.deepEqual(scope.inScope, [], "nothing rides a context link into the enforced scope");
    assert.deepEqual(scope.outOfScope, []);
    const trace = validateRequirementTrace([], ledger, workspace, "+// planner feeds the scheduler engine", { prLinkedRefs: ["o/r#7"] });
    const build = dispositionFromTrace(trace);
    assert.deepEqual(build.evidence, [], "a clean increment referenced by `Refs` only holds no contract rows");
    const disposition = computeFinalDisposition(dispositionInput(build.evidence) as never);
    assert.equal(disposition.kind, "approve");
    assert.equal(disposition.nativeEvent, "APPROVE");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1749 follow-up control: the identical issue linked by Implements stays contract-bearing", async () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/planner/feed.ts", ["export const feed = (x: number) => x;"]);
    const ledger = await refRelationshipLedger("Implements");
    const entry = (ledger as { requirements: Array<{ id: string; text: string; provenance: Array<Record<string, unknown>> }> }).requirements
      .find((candidate) => candidate.text === "The planner and the scheduler engine MUST share one feed.");
    assert.ok(entry, "the implementation-linked criterion reaches the ledger");
    assert.equal(entry.provenance[0]?.closing, false);
    assert.equal((entry.provenance[0] as { contextOnly?: unknown }).contextOnly, undefined,
      "the persisted provenance shape is unchanged — context docs simply never enter it");
    const scope = requirementTraceScope(ledger, "+// planner feeds the scheduler engine", { prLinkedRefs: ["o/r#7"] });
    assert.equal(scope.inScope.length, 1, "the shared-vocabulary criterion scopes in for an implementation link");
    const claims = [{
      requirement_id: entry.id,
      disposition: "unmet",
      enforcement: [],
      test: [],
      reason: "the shared feed is not implemented",
    }];
    const trace = validateRequirementTrace(claims, ledger, workspace, "+// planner feeds the scheduler engine", { prLinkedRefs: ["o/r#7"] });
    const row = trace.rows.find((candidate) => candidate.requirement_id === entry.id);
    assert.equal(row?.resolution, "unmet_claimed");
    assert.equal(traceUnmetClaimedInScopeRows(trace).length, 1, "the claim stays material");
    const build = dispositionFromTrace(trace);
    assert.deepEqual(build.evidence.map((item) => item.subject), ["requirement-trace:unmet-claimed"]);
    const disposition = computeFinalDisposition(dispositionInput(build.evidence) as never);
    assert.equal(disposition.kind, "incomplete", "an implementation link holds its contract exactly as before");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
