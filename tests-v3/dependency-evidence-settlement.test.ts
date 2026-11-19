/**
 * #1726: dependency-evidence settlement — the offline replay of the organic
 * Renovate PR #1721 failure (native review 5962747394, head
 * 06c68c884ba5b64626f357cb37dd2ea728c7e9db, workflow run 44368963400,
 * v3.9.0-dev+06c68c8) plus the deterministic acceptance fixtures.
 *
 * THE REPRODUCED FAILURE (measured on main before the fix, and documented in
 * the issue): the primary model spent 40/40 tool calls (23 rounds, stop
 * `tool-call-budget-exhausted`), gathered the upstream evidence via `gh_api`
 * (registry.npmjs.org was not in allowed-source-hosts, so the npm lookups
 * failed the host guard and were re-run through GitHub), suggested APPROVE
 * in prose — and the authoritative ledger still emitted
 * `5 total, 0 satisfied, 0 unmet, 5 unresolved (no-disposition=5)` with
 * cause `budget-exhausted`, withholding native approval.
 *
 * The first missing link (deterministic, pinned in tools-loop.test.ts):
 * `dependencyEvidenceObligationsForCall` attributed ONLY `web_fetch` /
 * `web_search`, so every successful upstream `gh_api` acquisition (a) never
 * discharged the loop's tracked dependency-evidence rows (the reserve window
 * never released, the obligations-settled early stop never fired, the budget
 * burned to zero), and (b) produced evidence receipts carrying NO obligation
 * attribution — invisible to `dependencyReceiptCoverage`. The second missing
 * link: even a receipt-backed row had NO settlement path — the receipt gate
 * only ever REJECTED unproven `satisfied` answers; a closing verdict whose
 * structured dispositions failed to echo the exact check texts (the
 * `no-disposition` shape, with zero parser drops) left every row unresolved
 * no matter what the run had actually acquired. This module pins the fixed
 * contract: validated, identity-matched upstream receipts settle the rows
 * they cover (deterministically, never from prose), and rows the receipts do
 * NOT cover stay unresolved with the exact reason-coded evidence state.
 *
 * The replay reconstructs the run from the retained record only: the review
 * prose's cited calls (call-5/7/8 upstream GitHub lookups), the executed
 * config (`allowed-source-hosts` without registry.npmjs.org; harness
 * obligations off; derived/risk off), the head's actual check runs (no
 * test-named check), and the authoritative log line's reason counts.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  parseHeadBoundCiEvidenceValue,
  reconcileObligationsWithCiEvidence,
  type HeadBoundCiEvidence,
} from "../src/enforcement/required-check-ci.js";
import {
  candidateRowsToObligations,
  deriveUnresolvedCause,
  foldObligationDispositions,
  reviewObligationsFromArtifact,
  reviewObligationsToArtifact,
} from "../src/enforcement/review-obligations.js";
import { evaluateRequiredCheckCoverage, isMergeAffectingRowClass } from "../src/enforcement/required-checks.js";
import { reconcileRequiredCheckRows } from "../src/enforcement/required-check-ci.js";
import { buildEvidenceLedger, checkEvidenceTagsFromArtifact } from "../src/enforcement/evidence-receipts.js";
import type { NormalizedRequiredCheckDisposition } from "../src/model/types.js";
import { adaptiveLoopBudgets, DEPENDENCY_EVIDENCE_OBLIGATIONS, driveToolLoop, isDependencyEvidenceChannelCall, STOP_BUDGET, STOP_OBLIGATIONS_SETTLED, type DependencyEvidenceObligation } from "../src/tools/loop.js";
import { Conversation } from "../src/model/conversation.js";

// #1726 (review 5979360208): the loop's no-lockout admission predicate
// recognizes the forge-read channel through the SAME platform seam
// attribution consumes — capability-neutral (no literal tool name beyond
// the seam's), admission-only (it never discharges rows).
test("#1726: the evidence-channel admission predicate covers the forge-read channel via the platform seam", () => {
  assert.equal(isDependencyEvidenceChannelCall("web_fetch", {}), true);
  assert.equal(isDependencyEvidenceChannelCall("web_search", {}), true);
  assert.equal(isDependencyEvidenceChannelCall("gh_api", { endpoint: "repos/withastro/astro/issues/1" }), true);
  assert.equal(isDependencyEvidenceChannelCall("gh_api", { endpoint: "" }), false);
  assert.equal(isDependencyEvidenceChannelCall("gh_api", {}), false);
  assert.equal(isDependencyEvidenceChannelCall("read_file", { path: "a.ts" }), false);
  assert.equal(isDependencyEvidenceChannelCall("run_command", { command: "ls" }), false);
});

// ---------------------------------------------------------------------------
// The #1721 replay inputs (from the retained record — see module docstring).
// ---------------------------------------------------------------------------

const HEAD = "06c68c884ba5b64626f357cb37dd2ea728c7e9db";

const CANDIDATE_ROWS = [
  // obligation-1: the run's fifth row never rendered in the required-evidence
  // section — a non-gating (review-prompt) generic row; still folded.
  {
    id: "obligation-1",
    source: "must_check",
    text: "review the changed dependency manifest for consistency",
    row_class: "review-prompt",
  },
  {
    id: "obligation-2",
    source: "must_check",
    text: "run full test suite after upgrade",
    row_class: "objective",
    gate: "ci-evidence",
  },
  {
    id: "obligation-3",
    source: "must_check",
    text: "establish upstream provenance for the updated dependency: publisher and canonical source repository",
    row_class: "objective",
    gate: "dependency-evidence",
    obligations: ["provenance"],
    dependency_scope: [{ slug: "astro", versions: ["7.4.12", "7.4.13"] }],
  },
  {
    id: "obligation-4",
    source: "must_check",
    text: "inspect the exact old→new upstream release delta for the updated dependency",
    row_class: "objective",
    gate: "dependency-evidence",
    obligations: ["release_delta"],
    dependency_scope: [{ slug: "astro", versions: ["7.4.12", "7.4.13"] }],
  },
  {
    id: "obligation-5",
    source: "must_check",
    text: "check upstream security advisories for the updated dependency version range, or report the advisory check as not performed",
    row_class: "objective",
    gate: "dependency-evidence",
    obligations: ["security_advisory"],
    dependency_scope: [{ slug: "astro", versions: ["7.4.12", "7.4.13"] }],
  },
];

const MUST_CHECK = CANDIDATE_ROWS.map((row) => row.text);

/** The structured dispositions the closing verdict carried: PRESENT (the
 * final log reads `no-disposition`, not `no-structured-dispositions`) with
 * zero parser-dropped entries (the log shows no `disposition-drops`
 * segment), and matching NONE of the five row identities — the exact-text
 * echo the folds require never happened. */
const VERDICT_DISPOSITIONS: NormalizedRequiredCheckDisposition[] = [
  { check: "dependency evidence gathered for the astro bump", status: "satisfied", rationale: "provenance, exact delta and advisories were investigated upstream" },
];

/** The executed-call trace the run retained in prose: workspace reads plus
 * the upstream GitHub lookups the model re-ran through `gh_api` after the
 * npm registry host was refused by the source-host allowlist. The gh_api
 * results are real payload shapes ({response} bodies) — the acquisitions
 * SUCCEEDED; the question is what the ledger could prove from them. */
const TOOL_CALLS = [
  { tool: "read_file", args: { path: "site/package-lock.json" }, status: "ok" },
  { tool: "gh_api", args: { endpoint: "repos/withastro/astro/contents/packages/astro/package.json" }, status: "ok" },
  { tool: "gh_api", args: { endpoint: "repos/withastro/astro/security-advisories" }, status: "ok" },
  { tool: "gh_api", args: { endpoint: "repos/withastro/astro/releases/tags/v7.4.13" }, status: "ok" },
];

const TOOL_RESULTS = [
  { status: "ok", result: { content: "lockfile contents" } },
  { status: "ok", result: { response: "{\"name\":\"astro\",\"version\":\"7.4.13\"}" } },
  { status: "ok", result: { response: "[]" } },
  { status: "ok", result: { response: "{\"tag_name\":\"v7.4.13\",\"body\":\"patch fixes\"}" } },
];

/** The head's ACTUAL check runs (fetched from the PR's commit): green, and
 * carrying NO test-execution check name — `validate`, `CodeQL`,
 * `review`/`gate`/`build`/`deploy`. The full-suite ask was legitimately
 * undischargeable on this head; the ledger must say exactly that. */
const CI_EVIDENCE: HeadBoundCiEvidence = {
  headSha: HEAD,
  finalState: "success",
  checks: [
    { name: "validate", state: "success", conclusion: "success" },
    { name: "CodeQL", state: "success", conclusion: "success" },
    { name: "Analyze (javascript-typescript)", state: "success", conclusion: "success" },
  ],
};

interface ReplayOutput {
  obligations: ReturnType<typeof foldObligationDispositions>;
  cause: ReturnType<typeof deriveUnresolvedCause>;
}

/** The exact pipeline `resolveReviewObligations` runs: candidates rows →
 * obligations → disposition fold → cause annotation → CI reconciliation. */
function replay1721(input: {
  toolCalls?: unknown;
  toolResults?: unknown;
  ciEvidence?: HeadBoundCiEvidence | null;
  dispositions?: Array<{ check: string; status: string; rationale?: string | null }> | null;
}): ReplayOutput {
  const ledger = buildEvidenceLedger({
    toolCalls: input.toolCalls ?? TOOL_CALLS,
    toolResults: input.toolResults ?? TOOL_RESULTS,
    certifiedDiffPayloads: [],
    rawDiff: null,
    candidatePaths: [],
    ciEvidence: input.ciEvidence !== undefined ? input.ciEvidence : CI_EVIDENCE,
    reviewedHeadSha: HEAD,
  });
  const tags = checkEvidenceTagsFromArtifact(CANDIDATE_ROWS.map((row) => ({
    text: row.text,
    row_class: row.row_class,
    ...(row.gate !== undefined ? { gate: row.gate } : {}),
    ...(row.obligations !== undefined ? { obligations: row.obligations } : {}),
    ...(row.dependency_scope !== undefined ? { dependency_scope: row.dependency_scope } : {}),
  })));
  const obligations = candidateRowsToObligations(CANDIDATE_ROWS, MUST_CHECK, tags);
  const folded = foldObligationDispositions(
    obligations,
    input.dispositions !== undefined ? input.dispositions : VERDICT_DISPOSITIONS,
    ledger,
    { readPaths: new Set<string>() },
  );
  const cause = deriveUnresolvedCause({
    stopReason: "tool-call-budget-exhausted",
    harnessError: null,
    planningError: null,
    degraded: false,
  });
  const annotated = folded.map((obligation) => (
    obligation.status === "unresolved" ? { ...obligation, cause: obligation.cause ?? cause } : obligation
  ));
  return {
    obligations: reconcileObligationsWithCiEvidence(annotated, input.ciEvidence !== undefined ? input.ciEvidence : CI_EVIDENCE, HEAD),
    cause,
  };
}

function byId(rows: ReplayOutput["obligations"], id: string) {
  const row = rows.find((obligation) => obligation.id === id);
  assert.ok(row !== undefined, `missing obligation row ${id}`);
  return row;
}

// ---------------------------------------------------------------------------
// The #1721 replay (the authoritative failure shape and its fix).
// ---------------------------------------------------------------------------

test("#1726 replay: the run's upstream evidence the receipts could NOT see left 5/5 no-disposition on main — the fixed fold settles what the run acquired", () => {
  const { obligations } = replay1721({});
  const total = obligations.length;
  const satisfied = obligations.filter((obligation) => obligation.status === "satisfied");
  const unresolved = obligations.filter((obligation) => obligation.status === "unresolved");

  // Pre-fix (measured on main, and logged verbatim by run 44368963400):
  // `5 total, 0 satisfied, 0 unmet, 5 unresolved (no-disposition=5)` — every
  // row stayed unresolved with the generic no-disposition reason even though
  // the run had executed the upstream lookups and 36/40 calls succeeded.
  assert.equal(total, 5);

  // Post-fix: the provenance lookups the run demonstrably executed
  // (gh_api contents/packages/astro — canonical publisher/source identity on
  // the exact slug) settle the provenance row deterministically, with the
  // receipts as provenance and reason `dependency-evidence`.
  const provenance = byId(obligations, "obligation-3");
  assert.equal(provenance.status, "satisfied");
  assert.equal(provenance.reason, "dependency-evidence");
  assert.equal(provenance.cause, null);
  assert.equal(provenance.evidence?.state, "receipt-backed");
  assert.deepEqual(provenance.evidence?.receipts, ["call-2"]);

  // The release-delta row does NOT settle: the run's retained release lookup
  // carries only the NEW endpoint (v7.4.13) — a release_delta asserts the
  // old→new pair, so the receipts cover the slug but not the captured
  // version range. The row stays unresolved with its exact evidence state
  // (receipt-mismatch: relevant receipts, none covering the required
  // identity) — never silently `missing-source-evidence`.
  const delta = byId(obligations, "obligation-4");
  assert.equal(delta.status, "unresolved");
  assert.equal(delta.cause, "budget-exhausted");
  assert.equal(delta.evidence?.state, "receipt-mismatch");

  // Same for the advisory row: the advisory LIST endpoint proves the check
  // ran against the right repo, but carries no version identity at all, so
  // the changed version range is uncovered — receipt-mismatch, unresolved.
  const advisories = byId(obligations, "obligation-5");
  assert.equal(advisories.status, "unresolved");
  assert.equal(advisories.cause, "budget-exhausted");
  assert.equal(advisories.evidence?.state, "receipt-mismatch");

  // The full-suite CI row stays unresolved — this head genuinely ran no
  // test-named check — and the obligation row now carries the SAME exact
  // CI-evidence reason the #750 coverage row gets (the two artifacts agree;
  // pre-fix the obligation row kept the generic `no-disposition`).
  const ci = byId(obligations, "obligation-2");
  assert.equal(ci.status, "unresolved");
  assert.equal(ci.reason, "ci-evidence-no-matching-test-check");
  assert.equal(ci.cause, "budget-exhausted");

  // The non-gating review-prompt row keeps its pre-#1657 disclosure shape:
  // unresolved with the answer-level reason (no disposition matched it).
  const promptRow = byId(obligations, "obligation-1");
  assert.equal(promptRow.status, "unresolved");
  assert.equal(promptRow.reason, "no-disposition");

  // Net machine state: approval is STILL withheld — the delta and advisory
  // evidence the run actually held does not meet the deterministic bar —
  // but the ledger now names which rows settled and why the rest did not.
  assert.equal(satisfied.length, 1);
  assert.equal(unresolved.length, 4);
  assert.ok(unresolved.every((obligation) => obligation.source === "must_check" ? obligation.cause === "budget-exhausted" : true));
});

test("#1726 replay: with genuinely no upstream acquisition the fold stays fail-closed — no invented proof", () => {
  // The negative half of the replay: a run whose upstream lookups all hit
  // the host guard and were never re-run (only workspace reads executed).
  const { obligations } = replay1721({
    toolCalls: [{ tool: "read_file", args: { path: "site/package-lock.json" }, status: "ok" }],
    toolResults: [{ status: "ok", result: { content: "lockfile contents" } }],
    dispositions: VERDICT_DISPOSITIONS,
  });
  for (const id of ["obligation-3", "obligation-4", "obligation-5"]) {
    const row = byId(obligations, id);
    assert.equal(row.status, "unresolved");
    assert.equal(row.reason, "no-disposition");
    assert.equal(row.evidence?.state, "receipt-absent");
  }
});

// ---------------------------------------------------------------------------
// Acceptance: the positive path reaches a complete required-check surface
// within the existing budget's evidence.
// ---------------------------------------------------------------------------

test("#1726 positive: compare + version-bound advisory + head-bound green CI settle every applicable check", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [
      { tool: "gh_api", args: { endpoint: "repos/withastro/astro" }, status: "ok" },
      { tool: "gh_api", args: { endpoint: "repos/withastro/astro/compare/v7.4.12...v7.4.13" }, status: "ok" },
      { tool: "web_search", args: { query: "astro npm security advisories 7.4.12 7.4.13" }, status: "ok" },
    ],
    toolResults: [
      { status: "ok", result: { response: "{\"full_name\":\"withastro/astro\"}" } },
      { status: "ok", result: { response: "{\"total_commits\":9}" } },
      { status: "ok", result: { results: "no applicable advisories for 7.4.12..7.4.13" } },
    ],
    certifiedDiffPayloads: [],
    rawDiff: null,
    candidatePaths: [],
    ciEvidence: {
      headSha: HEAD,
      finalState: "success",
      checks: [{ name: "test (node-22)", state: "success", conclusion: "success" }],
    },
    reviewedHeadSha: HEAD,
  });
  const tags = checkEvidenceTagsFromArtifact(CANDIDATE_ROWS.map((row) => ({
    text: row.text,
    row_class: row.row_class,
    ...(row.gate !== undefined ? { gate: row.gate } : {}),
    ...(row.obligations !== undefined ? { obligations: row.obligations } : {}),
    ...(row.dependency_scope !== undefined ? { dependency_scope: row.dependency_scope } : {}),
  })));
  const obligations = candidateRowsToObligations(CANDIDATE_ROWS, MUST_CHECK, tags);
  // The model's closing verdict AGAIN failed to echo the exact check texts —
  // the settlement must not depend on the echo.
  const folded = foldObligationDispositions(obligations, VERDICT_DISPOSITIONS, ledger, { readPaths: new Set<string>() });
  const annotated = folded.map((obligation) => (
    obligation.status === "unresolved" ? { ...obligation, cause: obligation.cause ?? "missing-source-evidence" } : obligation
  ));
  const reconciled = reconcileObligationsWithCiEvidence(annotated, {
    headSha: HEAD,
    finalState: "success",
    checks: [{ name: "test (node-22)", state: "success", conclusion: "success" }],
  }, HEAD);

  const ci = byId(reconciled, "obligation-2");
  assert.equal(ci.status, "satisfied");
  assert.deepEqual(ci.resolvedBy, { kind: "ci-evidence", check: "test (node-22)", headSha: HEAD });
  const provenance = byId(reconciled, "obligation-3");
  assert.equal(provenance.status, "satisfied");
  assert.equal(provenance.reason, "dependency-evidence");
  const delta = byId(reconciled, "obligation-4");
  assert.equal(delta.status, "satisfied");
  assert.equal(delta.reason, "dependency-evidence");
  assert.ok(delta.evidence?.receipts.includes("call-2"));
  const advisories = byId(reconciled, "obligation-5");
  assert.equal(advisories.status, "satisfied");
  assert.equal(advisories.reason, "dependency-evidence");

  // Every GATING row settled; the only unresolved row is the non-gating
  // review prompt (disclosed, never independently withholding approval).
  assert.equal(reconciled.filter((obligation) => obligation.status === "satisfied").length, 4);
  assert.deepEqual(
    reconciled.filter((obligation) => obligation.status === "unresolved").map((obligation) => obligation.id),
    ["obligation-1"],
  );

  // The #750 coverage fold agrees row-for-row (same ledger, same tags,
  // then the SAME #1594 CI reconciliation applyRequiredCheckValidation
  // runs: evaluateRequiredCheckCoverage → reconcileRequiredCheckRows).
  const coverage = evaluateRequiredCheckCoverage(MUST_CHECK, VERDICT_DISPOSITIONS, ledger, tags);
  const reconciledCoverage = reconcileRequiredCheckRows(coverage.checks, {
    headSha: HEAD,
    finalState: "success",
    checks: [{ name: "test (node-22)", state: "success", conclusion: "success" }],
  }, HEAD);
  assert.equal(reconciledCoverage.rows.every((row) => !isMergeAffectingRowClass(row.rowClass)
    || ((row.status === "satisfied" || row.status === "not_applicable")
      && (row.reason === "ok" || row.reason === "ci-evidence" || row.reason === "dependency-evidence"))), true);
  for (const row of reconciledCoverage.rows) {
    const obligation = reconciled.find((entry) => entry.text === row.check)!;
    assert.equal(row.status, obligation.status, `coverage/obligation disagreement on: ${row.check}`);
  }
});

// ---------------------------------------------------------------------------
// Negative acceptance: exact reasons, no invented proof.
// ---------------------------------------------------------------------------

test("#1726 negative: mismatched version identity never settles the delta row", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [
      { tool: "gh_api", args: { endpoint: "repos/withastro/astro/compare/v7.4.11...v7.4.13" }, status: "ok" },
    ],
    toolResults: [
      { status: "ok", result: { response: "{\"total_commits\":40}" } },
    ],
    certifiedDiffPayloads: [],
    rawDiff: null,
    candidatePaths: [],
    ciEvidence: null,
    reviewedHeadSha: HEAD,
  });
  const tags = checkEvidenceTagsFromArtifact(CANDIDATE_ROWS.map((row) => ({
    text: row.text,
    row_class: row.row_class,
    ...(row.gate !== undefined ? { gate: row.gate } : {}),
    ...(row.obligations !== undefined ? { obligations: row.obligations } : {}),
    ...(row.dependency_scope !== undefined ? { dependency_scope: row.dependency_scope } : {}),
  })));
  const obligations = candidateRowsToObligations(CANDIDATE_ROWS, MUST_CHECK, tags);
  const folded = foldObligationDispositions(obligations, VERDICT_DISPOSITIONS, ledger, { readPaths: new Set<string>() });
  const delta = byId(folded, "obligation-4");
  assert.equal(delta.status, "unresolved");
  assert.equal(delta.evidence?.state, "receipt-mismatch");
  assert.deepEqual(delta.evidence?.receipts, []);
});

test("#1726 negative: a stale advisory check (old version only) never settles the advisory row", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [
      { tool: "web_search", args: { query: "astro npm advisories 7.4.12" }, status: "ok" },
    ],
    toolResults: [
      { status: "ok", result: { results: "GHSA-xxxx fixed in 7.4.5" } },
    ],
    certifiedDiffPayloads: [],
    rawDiff: null,
    candidatePaths: [],
    ciEvidence: null,
    reviewedHeadSha: HEAD,
  });
  const tags = checkEvidenceTagsFromArtifact(CANDIDATE_ROWS.map((row) => ({
    text: row.text,
    row_class: row.row_class,
    ...(row.gate !== undefined ? { gate: row.gate } : {}),
    ...(row.obligations !== undefined ? { obligations: row.obligations } : {}),
    ...(row.dependency_scope !== undefined ? { dependency_scope: row.dependency_scope } : {}),
  })));
  const obligations = candidateRowsToObligations(CANDIDATE_ROWS, MUST_CHECK, tags);
  const folded = foldObligationDispositions(obligations, VERDICT_DISPOSITIONS, ledger, { readPaths: new Set<string>() });
  const advisories = byId(folded, "obligation-5");
  assert.equal(advisories.status, "unresolved");
  assert.equal(advisories.evidence?.state, "receipt-mismatch");
});

test("#1726 negative: unrelated green CI stays unresolved with its exact reason", () => {
  const { obligations } = replay1721({
    ciEvidence: {
      headSha: HEAD,
      finalState: "success",
      checks: [{ name: "lint", state: "success", conclusion: "success" }],
    },
  });
  const ci = byId(obligations, "obligation-2");
  assert.equal(ci.status, "unresolved");
  assert.equal(ci.reason, "ci-evidence-no-matching-test-check");
});

test("#1726 negative: a confirmed negative (unmet) is never argued away by receipts", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [
      { tool: "gh_api", args: { endpoint: "repos/withastro/astro/compare/v7.4.12...v7.4.13" }, status: "ok" },
    ],
    toolResults: [
      { status: "ok", result: { response: "{\"total_commits\":9}" } },
    ],
    certifiedDiffPayloads: [],
    rawDiff: null,
    candidatePaths: [],
    ciEvidence: null,
    reviewedHeadSha: HEAD,
  });
  const tags = checkEvidenceTagsFromArtifact(CANDIDATE_ROWS.map((row) => ({
    text: row.text,
    row_class: row.row_class,
    ...(row.gate !== undefined ? { gate: row.gate } : {}),
    ...(row.obligations !== undefined ? { obligations: row.obligations } : {}),
    ...(row.dependency_scope !== undefined ? { dependency_scope: row.dependency_scope } : {}),
  })));
  const obligations = candidateRowsToObligations(CANDIDATE_ROWS, MUST_CHECK, tags);
  const folded = foldObligationDispositions(
    obligations,
    [{
      check: "inspect the exact old→new upstream release delta for the updated dependency",
      status: "unmet",
      rationale: "the delta introduced a breaking serializer change",
    }],
    ledger,
    { readPaths: new Set<string>() },
  );
  const delta = byId(folded, "obligation-4");
  assert.equal(delta.status, "unmet");
  assert.equal(delta.reason, "ok");
});

// ---------------------------------------------------------------------------
// Round-trip: the settled rows survive the strict obligation artifact.
// ---------------------------------------------------------------------------

test("#1726: the settlement reason round-trips through the strict artifact reader", () => {
  const { obligations } = replay1721({});
  const artifact = reviewObligationsToArtifact(obligations, null);
  const readBack = reviewObligationsFromArtifact(artifact);
  assert.ok(readBack !== null);
  const provenance = readBack.find((row) => row.id === "obligation-3");
  assert.equal(provenance?.status, "satisfied");
  assert.equal(provenance?.reason, "dependency-evidence");
});

// ---------------------------------------------------------------------------
// The CI evidence seam the replay builds on.
// ---------------------------------------------------------------------------

test("#1726: the replay's CI evidence shape is the gate's own parse output", () => {
  const parsed = parseHeadBoundCiEvidenceValue({
    version: 1,
    head_sha: HEAD,
    final_state: "success",
    checks: [{ name: "validate", state: "success", conclusion: "success" }],
  });
  assert.equal(parsed?.headSha, HEAD);
});

// ---------------------------------------------------------------------------
// The #1721 replay at the LOOP level: the 40-call budget burn, observed.
//
// The organic run's first missing link was channel-level: its successful
// upstream evidence rode a channel the attribution grammar did not
// recognize, so the tracked rows never discharged, the settled stop never
// fired, and the loop spent every one of its 40 requests (23 rounds, stop
// `tool-call-budget-exhausted`). This fixture replays that loop with the
// same budget/reserve/row configuration and an upstream channel that never
// attributes (workspace reads plus FORGE-READ calls — the organic gh_api
// channel class, #1726 review 5979360208 — whose endpoints name no
// obligation) — the burn is deterministic and still reachable
// post-fix whenever the evidence channel yields nothing attributable, and
// the fail-closed fold over the burned run reads exactly the #1721 shape.
// The channel-fixed counterpart (attributed upstream evidence settling the
// rows and stopping the loop early) is pinned in tools-loop.test.ts.
// ---------------------------------------------------------------------------

test("#1721 loop replay: 40/40 calls burn to tool-call-budget-exhausted and the fold reads 5/5 no-disposition when no executed call attributes", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // 20 scripted rounds x 2 calls = the full 40-request budget: rounds 1-18
  // pre-window workspace reads (36 calls), rounds 19-20 inside the reserved
  // window FORGE-READ calls (gh_api — the organic #1721 channel class) whose
  // endpoints attribute nothing (issue threads name no obligation keyword
  // and address no canonical repository identity). The no-lockout hatch
  // admits them while a shape row is active (#1726 review 5979360208: the
  // hatch's evidence-channel recognition consumes the same platform seam as
  // attribution), so they DO consume the reserved tail — exactly how the
  // organic burn reached 40/40.
  const responses: unknown[] = [];
  let callIndex = 0;
  for (let round = 0; round < 18; round++) {
    responses.push({
      choices: [{ message: { content: null, tool_calls: [0, 1].map((offset) => {
        const id = `r${callIndex++}`;
        return { id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `src/module-${id}.ts` }) } };
      }) } }],
    });
  }
  for (let round = 0; round < 2; round++) {
    responses.push({
      choices: [{ message: { content: null, tool_calls: [0, 1].map((offset) => {
        const id = `w${callIndex++}`;
        return { id, type: "function", function: { name: "gh_api", arguments: JSON.stringify({ endpoint: `repos/withastro/astro/issues/${callIndex - 36}` }) } };
      }) } }],
    });
  }
  let responseIndex = 0;
  const postFn = async () => responses[responseIndex++] ?? { choices: [{ message: { content: "done" } }] };
  const executed: Array<{ tool: string; args: Record<string, unknown>; result: Record<string, unknown> }> = [];
  const executeFn = async (tool: string, args: Record<string, unknown>) => {
    const record = { tool, args, result: { tool, status: "ok", result: { content: "irrelevant observation" } } };
    executed.push(record);
    return record.result;
  };
  const timeFn = (): number => Number.MAX_SAFE_INTEGER / 2;

  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: { ...adaptiveLoopBudgets(32, 40, 600), maxRounds: 32 },
    timeFn,
    reserveForRequiredEvidence: 4,
    requiredEvidence: DEPENDENCY_EVIDENCE_OBLIGATIONS.map((obligation) => ({ id: obligation, tokens: [], obligation: obligation as DependencyEvidenceObligation })),
  });

  // The budget burned to exactly the organic run's stop: every request
  // spent, the exhaustion stop (not an early settle, not max-rounds).
  assert.equal(outcome.stopReason, STOP_BUDGET);
  assert.equal(outcome.toolCallsIssued, 40);
  assert.equal(executed.length, 40);
  assert.equal(outcome.requestsRemaining, 0);
  // The reserve's tail provably went to evidence attempts, and the tracked
  // rows ended cap-released — used, then explicitly declined with a reason
  // (never silently open). The per-row acquisition is `unavailable`: the
  // hatch admitted the evidence-channel calls, but none of them TARGETED a
  // row (they attribute nothing), so no row was ever attempted — the honest
  // #1659 record of a reserve spent without a creditable acquisition.
  assert.equal(outcome.requiredEvidenceWindowAttempts, 4);
  assert.deepEqual(outcome.requiredEvidenceCredits, []);
  assert.ok(outcome.requiredEvidenceSettlements.every((row) => row.evidenceState === "cap-released"), JSON.stringify(outcome.requiredEvidenceSettlements));
  assert.ok(outcome.requiredEvidenceSettlements.every((row) => row.acquisition === "unavailable"), JSON.stringify(outcome.requiredEvidenceSettlements));

  // The burned run's harness trace, folded exactly as the engine folds it
  // (candidates rows, the closing verdict's non-echoing dispositions, the
  // executed-call ledger): every row stays unresolved with the answer-level
  // no-disposition reason and the budget-exhausted cause — the fail-closed
  // #1721 shape. No receipt carries the dependency identity, so nothing
  // settles: a burn without attributable evidence is still 5/5 no-disposition.
  const ledger = buildEvidenceLedger({
    toolCalls: executed.map((call) => ({ tool: call.tool, args: call.args, status: (call.result as { status?: string }).status ?? "error" })),
    toolResults: executed.map((call) => call.result),
    certifiedDiffPayloads: [],
    rawDiff: null,
    candidatePaths: [],
    ciEvidence: null,
    reviewedHeadSha: HEAD,
  });
  const tags = checkEvidenceTagsFromArtifact(CANDIDATE_ROWS.map((row) => ({
    text: row.text,
    row_class: row.row_class,
    ...(row.gate !== undefined ? { gate: row.gate } : {}),
    ...(row.obligations !== undefined ? { obligations: row.obligations } : {}),
    ...(row.dependency_scope !== undefined ? { dependency_scope: row.dependency_scope } : {}),
  })));
  const obligations = candidateRowsToObligations(CANDIDATE_ROWS, MUST_CHECK, tags);
  const folded = foldObligationDispositions(obligations, VERDICT_DISPOSITIONS, ledger, { readPaths: new Set<string>() });
  const cause = deriveUnresolvedCause({
    stopReason: outcome.stopReason,
    harnessError: null,
    planningError: null,
    degraded: false,
  });
  const annotated = folded.map((obligation) => (
    obligation.status === "unresolved" ? { ...obligation, cause: obligation.cause ?? cause } : obligation
  ));
  assert.equal(cause, "budget-exhausted");
  assert.equal(annotated.filter((obligation) => obligation.status === "unresolved").length, 5);
  assert.ok(annotated.every((obligation) => obligation.reason === "no-disposition"), JSON.stringify(annotated.map((row) => [row.id, row.status, row.reason])));
  assert.ok(annotated.filter((obligation) => obligation.source === "must_check" && obligation.status === "unresolved").every((obligation) => obligation.cause === "budget-exhausted"));
});

test("#1721 loop replay counterpart: attributed upstream evidence stops the same loop BEFORE the budget burns", async () => {
  // The fixed channel: the same 40-request budget, the same reserve, the
  // same three tracked rows — but the upstream evidence attributes, so the
  // rows discharge in round 1, the settled stop fires with 37 requests
  // unspent, and the reserve is recorded as used (acquired), never declined.
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const evidenceCalls = [
    { id: "t1", type: "function", function: { name: "gh_api", arguments: '{"endpoint":"repos/withastro/astro"}' } },
    { id: "t2", type: "function", function: { name: "gh_api", arguments: '{"endpoint":"repos/withastro/astro/compare/v7.4.12...v7.4.13"}' } },
    { id: "t3", type: "function", function: { name: "web_search", arguments: '{"query":"astro npm security advisories 7.4.12 7.4.13"}' } },
  ];
  const responses = [
    { choices: [{ message: { content: null, tool_calls: evidenceCalls } }] },
    { choices: [{ message: { content: "evidence gathered" } }] },
  ];
  let responseIndex = 0;
  const postFn = async () => responses[responseIndex++] ?? { choices: [{ message: { content: "done" } }] };
  const executeFn = async (tool: string, args: Record<string, unknown>) => ({ tool, status: "ok", result: { response: "{\"ok\":true}" } });
  const timeFn = (): number => Number.MAX_SAFE_INTEGER / 2;
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: { ...adaptiveLoopBudgets(32, 40, 600), maxRounds: 32 },
    timeFn,
    reserveForRequiredEvidence: 4,
    requiredEvidence: DEPENDENCY_EVIDENCE_OBLIGATIONS.map((obligation) => ({ id: obligation, tokens: [], obligation: obligation as DependencyEvidenceObligation })),
  });
  assert.equal(outcome.stopReason, STOP_OBLIGATIONS_SETTLED);
  assert.equal(outcome.requiredEvidenceSettledStop, true);
  assert.deepEqual(outcome.requiredEvidenceCredits, ["provenance", "release_delta", "security_advisory"]);
  assert.equal(outcome.requestsRemaining, 37);
});
