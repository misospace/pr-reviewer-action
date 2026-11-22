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
import { canonicalRegistryCatalogImageIdentity } from "../src/tools/dependency-evidence.js";
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

/** The candidate-row shape the fold consumes (structurally — the helpers
 * accept `unknown`; the annotation exists so a test can derive a variant
 * scope, e.g. a scoped dependency slug, without fighting the literal
 * union `CANDIDATE_ROWS` infers). */
type FoldCandidateRow = {
  id: string;
  source: string;
  text: string;
  row_class: string;
  gate?: string;
  obligations?: string[];
  dependency_scope?: Array<{ slug: string; versions: string[]; kind?: string; digests?: string[] }>;
};

const CANDIDATE_ROWS: FoldCandidateRow[] = [
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

test("#1726 replay: the run's upstream evidence the receipts could NOT see left 5/5 no-disposition on main — the fixed fold settles what the run's acquisitions can prove", () => {
  const { obligations } = replay1721({});
  const total = obligations.length;
  const satisfied = obligations.filter((obligation) => obligation.status === "satisfied");
  const unresolved = obligations.filter((obligation) => obligation.status === "unresolved");

  // Pre-fix (measured on main, and logged verbatim by run 44368963400):
  // `5 total, 0 satisfied, 0 unmet, 5 unresolved (no-disposition=5)` — every
  // row stayed unresolved with the generic no-disposition reason even though
  // the run had executed the upstream lookups and 36/40 calls succeeded.
  assert.equal(total, 5);

  // #1748: the provenance lookups the run demonstrably executed
  // (gh_api contents/packages/astro — the exact slug on a forge) no longer
  // settle the provenance row: a forge repository under ANY owner carries
  // the slug identity without being the canonical publisher/source, so the
  // canonical-source rule demands the dependency's authoritative registry
  // document (npm — which the run's config refused). The row stays
  // unresolved with the specific reason-coded state: relevant receipts,
  // none binding the canonical identity (receipt-mismatch) — fail closed,
  // never inferred from the run's prose.
  const provenance = byId(obligations, "obligation-3");
  assert.equal(provenance.status, "unresolved");
  assert.equal(provenance.reason, "no-disposition");
  assert.equal(provenance.cause, "budget-exhausted");
  assert.equal(provenance.evidence?.state, "receipt-mismatch");
  assert.deepEqual(provenance.evidence?.receipts, []);

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

  // Net machine state: approval is STILL withheld — nothing the run's
  // forge-only acquisitions could prove meets the deterministic bar —
  // and the ledger now names exactly why each row did not settle.
  assert.equal(satisfied.length, 0);
  assert.equal(unresolved.length, 5);
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

test("#1726 positive: registry provenance + compare + version-bound advisory + head-bound green CI settle every applicable check", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [
      // #1748: the provenance acquisition is the dependency's authoritative
      // registry document (the npm packument for the exact slug) — the one
      // target whose identity binds the dependency to its canonical
      // publisher/source.
      { tool: "web_fetch", args: { url: "https://registry.npmjs.org/astro" }, status: "ok" },
      { tool: "gh_api", args: { endpoint: "repos/withastro/astro/compare/v7.4.12...v7.4.13" }, status: "ok" },
      { tool: "web_search", args: { query: "astro npm security advisories 7.4.12 7.4.13" }, status: "ok" },
    ],
    toolResults: [
      { status: "ok", result: { content: "{\"name\":\"astro\",\"dist-tags\":{\"latest\":\"7.4.13\"}}" } },
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
  assert.ok(provenance.evidence?.receipts.includes("call-1"), "the registry document receipt backs the provenance row");
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
// #1748: canonical-source provenance. The provenance cell settles ONLY from
// evidence deterministically binding the changed dependency identity to its
// canonical publisher/source — the dependency's authoritative registry
// document (npm: the only ecosystem the trusted scope parse reads, and the
// registry that owns its slugs' uniqueness). Positive and attacker-repo
// negative fixtures for BOTH channels (web + forge-read); the
// release-delta/advisory cells, the reserve budgets, and the loop are
// untouched.
// ---------------------------------------------------------------------------

/** The obligation fold over one acquisition set (the replay's pipeline,
 * without the CI reconciliation the provenance assertions don't need). The
 * candidate rows default to the replay's fixture; a test may pass its own
 * row list (same shape) to pin a scope the replay does not carry. */
function foldDependencyRows(
  toolCalls: unknown[],
  toolResults: unknown[],
  rows: readonly FoldCandidateRow[] = CANDIDATE_ROWS,
): ReturnType<typeof foldObligationDispositions> {
  const ledger = buildEvidenceLedger({
    toolCalls, toolResults,
    certifiedDiffPayloads: [], rawDiff: null, candidatePaths: [],
    ciEvidence: null, reviewedHeadSha: HEAD,
  });
  const tags = checkEvidenceTagsFromArtifact(rows.map((row) => ({
    text: row.text,
    row_class: row.row_class,
    ...(row.gate !== undefined ? { gate: row.gate } : {}),
    ...(row.obligations !== undefined ? { obligations: row.obligations } : {}),
    ...(row.dependency_scope !== undefined ? { dependency_scope: row.dependency_scope } : {}),
  })));
  const obligations = candidateRowsToObligations(rows, rows.map((row) => row.text), tags);
  return foldObligationDispositions(obligations, VERDICT_DISPOSITIONS, ledger, { readPaths: new Set<string>() });
}

test("#1748 positive (web channel): the npm registry document settles the provenance row — and only that row", () => {
  const rows = foldDependencyRows(
    [
      { tool: "web_fetch", args: { url: "https://registry.npmjs.org/astro/7.4.13" }, status: "ok" },
      { tool: "gh_api", args: { endpoint: "repos/withastro/astro/compare/v7.4.12...v7.4.13" }, status: "ok" },
    ],
    [
      { status: "ok", result: { content: "{\"name\":\"astro\",\"version\":\"7.4.13\",\"repository\":{\"url\":\"git+https://github.com/withastro/astro.git\"}}" } },
      { status: "ok", result: { response: "{\"total_commits\":9}" } },
    ],
  );
  const provenance = byId(rows, "obligation-3");
  assert.equal(provenance.status, "satisfied");
  assert.equal(provenance.reason, "dependency-evidence");
  assert.equal(provenance.evidence?.state, "receipt-backed");
  assert.deepEqual(provenance.evidence?.receipts, ["call-1"]);
  // The version-asserting cells keep their own contracts: the compare
  // receipt (both captured versions) settles the delta; the registry
  // document alone never leaks into them, and the advisory row has no
  // attributed acquisition at all in this fixture (receipt-absent).
  const delta = byId(rows, "obligation-4");
  assert.equal(delta.status, "satisfied");
  assert.deepEqual(delta.evidence?.receipts, ["call-2"]);
  assert.equal(byId(rows, "obligation-5").evidence?.state, "receipt-absent");
});

test("#1748 positive (web channel, canonical scoped encoding): the encoded registry document settles the scoped provenance row", () => {
  // npm spells a scoped packument with the encoded slash — `/@scope%2Fastro`
  // — the registry's own canonical form for the slug. That URL carries no
  // literal `scope/astro` token, so the canonical registry binding must
  // satisfy the identity gate itself (review fix); everything else —
  // attribution, trust, completeness, the provenance-only cell contract —
  // is the same fold as the plain spelling.
  const scopedRows = CANDIDATE_ROWS.map((row) => (
    row.gate === "dependency-evidence"
      ? { ...row, dependency_scope: [{ slug: "scope/astro", versions: ["7.4.12", "7.4.13"] }] }
      : row
  ));
  const rows = foldDependencyRows(
    [
      { tool: "web_fetch", args: { url: "https://registry.npmjs.org/@scope%2Fastro/7.4.13" }, status: "ok" },
      { tool: "gh_api", args: { endpoint: "repos/withastro/astro/compare/v7.4.12...v7.4.13" }, status: "ok" },
    ],
    [
      { status: "ok", result: { content: "{\"name\":\"@scope/astro\",\"version\":\"7.4.13\",\"repository\":{\"url\":\"git+https://github.com/withastro/astro.git\"}}" } },
      { status: "ok", result: { response: "{\"total_commits\":9}" } },
    ],
    scopedRows,
  );
  const provenance = byId(rows, "obligation-3");
  assert.equal(provenance.status, "satisfied");
  assert.equal(provenance.reason, "dependency-evidence");
  assert.equal(provenance.evidence?.state, "receipt-backed");
  assert.deepEqual(provenance.evidence?.receipts, ["call-1"]);
  // The canonical clause neither leaks into the version-asserting cells nor
  // substitutes for their own identity: the registry document is attributed
  // provenance-only, and the compare fetch addresses the bare-astro repo —
  // it carries no `scope/astro` identity at all — so the delta row stays
  // receipt-absent in this scoped scope.
  assert.equal(byId(rows, "obligation-4").evidence?.state, "receipt-absent");
  // The encoded sibling under ANOTHER scope binds `evil/astro` — a different
  // package — and carries no literal `scope/astro` token: the row stays
  // specifically unresolved with no candidate receipt (fail-closed).
  const siblingRows = foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://registry.npmjs.org/@evil%2Fastro/7.4.13" }, status: "ok" }],
    [{ status: "ok", result: { content: "{\"name\":\"@evil/astro\",\"version\":\"7.4.13\"}", truncated: false } }],
    scopedRows,
  );
  const siblingProvenance = byId(siblingRows, "obligation-3");
  assert.equal(siblingProvenance.status, "unresolved");
  assert.equal(siblingProvenance.evidence?.state, "receipt-absent");
});

test("#1748 attacker-repo negative (both channels): wildcard forge reads and source-repo fetches never settle provenance", () => {
  // With a wildcard forge-read allowlist every one of these acquisitions
  // succeeds and is attributed provenance on the exact slug — the
  // attacker-controlled repo, the TRUE canonical repo read through the
  // forge, and a source-repo web fetch of a same-named repo. None of them
  // is the registry document, so the provenance row stays specifically
  // unresolved (relevant receipts, none binding the canonical identity) on
  // both channels.
  const rows = foldDependencyRows(
    [
      { tool: "gh_api", args: { endpoint: "repos/evil/astro" }, status: "ok" },
      { tool: "gh_api", args: { endpoint: "repos/withastro/astro" }, status: "ok" },
      { tool: "web_fetch", args: { url: "https://github.com/evil/astro" }, status: "ok" },
    ],
    [
      { status: "ok", result: { response: "{\"full_name\":\"evil/astro\"}" } },
      { status: "ok", result: { response: "{\"full_name\":\"withastro/astro\"}" } },
      { status: "ok", result: { content: "evil/astro — same-named repository", truncated: false } },
    ],
  );
  const provenance = byId(rows, "obligation-3");
  assert.equal(provenance.status, "unresolved");
  assert.equal(provenance.reason, "no-disposition");
  assert.equal(provenance.evidence?.state, "receipt-mismatch");
  assert.deepEqual(provenance.evidence?.receipts, []);
  // The unchanged cells are untouched: nothing in these acquisitions
  // addresses a release delta or an advisory surface, so those rows stay
  // receipt-absent — the provenance hardening neither credits nor flips them.
  assert.equal(byId(rows, "obligation-4").evidence?.state, "receipt-absent");
  assert.equal(byId(rows, "obligation-5").evidence?.state, "receipt-absent");
});

test("#1748: registry provenance settles beside forge acquisitions it cannot vouch for — cells stay independent", () => {
  // The registry document proves WHO publishes astro; the compare proves
  // the exact old→new delta; the wildcard forge read proves nothing and
  // credits nothing — the row settles from the joint cover of the two
  // bindings it does have, with the forged receipt never listed.
  const rows = foldDependencyRows(
    [
      { tool: "web_fetch", args: { url: "https://registry.npmjs.org/astro" }, status: "ok" },
      { tool: "gh_api", args: { endpoint: "repos/evil/astro/compare/v7.4.12...v7.4.13" }, status: "ok" },
    ],
    [
      { status: "ok", result: { content: "{\"name\":\"astro\",\"dist-tags\":{\"latest\":\"7.4.13\"}}" } },
      { status: "ok", result: { response: "{\"total_commits\":40}" } },
    ],
  );
  const provenance = byId(rows, "obligation-3");
  assert.equal(provenance.status, "satisfied");
  assert.deepEqual(provenance.evidence?.receipts, ["call-1"]);
  // The DELTA cell is identity-bound, not registry-bound: the compare's
  // version pair (even on an attacker repo) still covers the captured
  // old→new identity — that settlement is untouched by #1748.
  assert.equal(byId(rows, "obligation-4").status, "satisfied");
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
// Round-trip: the reason-coded rows survive the strict obligation artifact.
// ---------------------------------------------------------------------------

test("#1726: the reason-coded evidence state round-trips through the strict artifact reader", () => {
  const { obligations } = replay1721({});
  const artifact = reviewObligationsToArtifact(obligations, null);
  const readBack = reviewObligationsFromArtifact(artifact);
  assert.ok(readBack !== null);
  // #1748: the replay's forge-only provenance acquisition stays unresolved —
  // the specific receipt-mismatch state survives the strict artifact reader.
  const provenance = readBack.find((row) => row.id === "obligation-3");
  assert.equal(provenance?.status, "unresolved");
  assert.equal(provenance?.evidence?.state, "receipt-mismatch");
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

// ---------------------------------------------------------------------------
// #1763: container-image / OCI-chart dependency updates. The trusted scope
// now names canonical registry identities (`kind: "image"|"chart"`, digests),
// and the cells bind per kind: provenance settles from the canonical
// registry CATALOG page — the image/chart analogue of the #1748 canonical-
// source rule — while the version-asserting cells carry dotted tag tokens
// under the version boundary. Organic replays of the two false-INCOMPLETE
// reports (#12359 ghcr image, #12375 OCI chart), the Docker Hub spelling
// normalization, and the negative controls. The npm fixtures above are the
// untouched #1748 regression suite.
// ---------------------------------------------------------------------------

const IMAGE_DIGEST_A = "0123456789abcdef".repeat(4);
const IMAGE_DIGEST_B = "fedcba9876543210".repeat(4);

const IMAGE_SCOPE = [{
  slug: "ghcr.io/sirkirby/unifi-network-mcp",
  versions: ["0.49.2", "0.50.0"],
  kind: "image",
  digests: [IMAGE_DIGEST_A, IMAGE_DIGEST_B],
}];

/** The three obligation rows over one trusted scope entry (the replay's
 * obligation-3/4/5 shapes with the image scope substituted). */
function imageRows(scope: NonNullable<FoldCandidateRow["dependency_scope"]>): FoldCandidateRow[] {
  return [
    {
      id: "obligation-3", source: "must_check",
      text: "establish upstream provenance for the updated dependency: publisher and canonical source repository",
      row_class: "objective", gate: "dependency-evidence", obligations: ["provenance"], dependency_scope: scope,
    },
    {
      id: "obligation-4", source: "must_check",
      text: "inspect the exact old→new upstream release delta for the updated dependency",
      row_class: "objective", gate: "dependency-evidence", obligations: ["release_delta"], dependency_scope: scope,
    },
    {
      id: "obligation-5", source: "must_check",
      text: "check upstream security advisories for the updated dependency version range, or report the advisory check as not performed",
      row_class: "objective", gate: "dependency-evidence", obligations: ["security_advisory"], dependency_scope: scope,
    },
  ];
}

function tagsForRows(rows: readonly FoldCandidateRow[]) {
  return checkEvidenceTagsFromArtifact(rows.map((row) => ({
    text: row.text,
    row_class: row.row_class,
    ...(row.gate !== undefined ? { gate: row.gate } : {}),
    ...(row.obligations !== undefined ? { obligations: row.obligations } : {}),
    ...(row.dependency_scope !== undefined ? { dependency_scope: row.dependency_scope } : {}),
  })));
}

test("#1763: canonicalRegistryCatalogImageIdentity recognizes only canonical catalog surfaces — everything else fails closed", () => {
  // The accepted catalog surfaces, canonicalized to the scope identity.
  assert.equal(
    canonicalRegistryCatalogImageIdentity("https://ghcr.io/prometheus-community/charts/prometheus-blackbox-exporter"),
    "ghcr.io/prometheus-community/charts/prometheus-blackbox-exporter",
  );
  assert.equal(canonicalRegistryCatalogImageIdentity("HTTPS://GHCR.IO/SirKirby/Unifi-Network-MCP"), "ghcr.io/sirkirby/unifi-network-mcp");
  assert.equal(canonicalRegistryCatalogImageIdentity("https://hub.docker.com/r/open-telemetry/opentelemetry-collector"), "docker.io/open-telemetry/opentelemetry-collector");
  assert.equal(canonicalRegistryCatalogImageIdentity("https://hub.docker.com/_/alpine"), "docker.io/alpine");
  assert.equal(canonicalRegistryCatalogImageIdentity("https://hub.docker.com/r/library/alpine/"), "docker.io/alpine");
  assert.equal(canonicalRegistryCatalogImageIdentity("https://www.hub.docker.com/r/library/nginx"), "docker.io/nginx");
  assert.equal(canonicalRegistryCatalogImageIdentity("https://docker.io/r/library/alpine"), "docker.io/alpine");
  assert.equal(canonicalRegistryCatalogImageIdentity("https://quay.io/repository/prometheus/prometheus"), "quay.io/prometheus/prometheus");
  assert.equal(canonicalRegistryCatalogImageIdentity("https://quay.io/coreos/etcd"), "quay.io/coreos/etcd");
  assert.equal(canonicalRegistryCatalogImageIdentity("https://mcr.microsoft.com/dotnet/runtime"), "mcr.microsoft.com/dotnet/runtime");
  assert.equal(canonicalRegistryCatalogImageIdentity("https://public.ecr.aws/nginx/nginx"), "public.ecr.aws/nginx/nginx");
  assert.equal(canonicalRegistryCatalogImageIdentity("https://gallery.ecr.aws/nginx/nginx"), "gallery.ecr.aws/nginx/nginx");
  assert.equal(canonicalRegistryCatalogImageIdentity("https://registry.k8s.io/ingress-nginx/controller"), "registry.k8s.io/ingress-nginx/controller");
  // Off-vocabulary hosts, dirty hosts, escapes, shallower/deeper pages, and
  // non-URLs name nothing (fail closed).
  for (const negative of [
    "https://docker.limited/library/alpine",
    "https://ghcr.io:443/o/n",
    "https://token@ghcr.io/o/n",
    "https://ghcr.io/o/r%2Fx",
    "https://quay.io/repository/%41/b",
    "https://hub.docker.com/r/o/n/extra",
    "https://hub.docker.com/r/o",
    "https://hub.docker.com/search?q=alpine",
    "https://hub.docker.com/u/sirkirby",
    "https://hub.docker.com",
    "https://ghcr.io",
    "https://ghcr.io/",
    "https://ghcr.io/o",
    "https://gcr.io/single",
    "alpine",
    "",
  ]) {
    assert.equal(canonicalRegistryCatalogImageIdentity(negative), null, negative);
  }
});

test("#1763 organic #12359 (image): the ghcr catalog + source-repo compare + version advisory settle all three rows", () => {
  const rows = imageRows(IMAGE_SCOPE);
  const toolCalls = [
    // ghcr.io is an exact publisher-registry host → provenance attribution;
    // the canonical catalog identity binds the scope entry exactly.
    { tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp" }, status: "ok" },
    // The image's releases live on the SOURCE repo under its own tag scheme
    // ("network-…"): the release token attributes the delta, the version
    // boundary carries both captured endpoints through the `network-` prefix.
    { tool: "web_fetch", args: { url: "https://github.com/sirkirby/unifi-mcp/compare/network-0.49.2...network-0.50.0" }, status: "ok" },
    { tool: "web_search", args: { query: "unifi-network-mcp 0.49.2 0.50.0 advisory" }, status: "ok" },
  ];
  const toolResults = [
    { status: "ok", result: { content: "{\"schemaVersion\":2,\"mediaType\":\"application/vnd.oci.image.index.v1+json\"}" } },
    { status: "ok", result: { content: "9 commits between the two tags" } },
    { status: "ok", result: { results: "no advisories published for the 0.49.x/0.50.x line" } },
  ];
  const folded = foldDependencyRows(toolCalls, toolResults, rows);
  const provenance = byId(folded, "obligation-3");
  assert.equal(provenance.status, "satisfied");
  assert.equal(provenance.reason, "dependency-evidence");
  assert.equal(provenance.evidence?.state, "receipt-backed");
  assert.deepEqual(provenance.evidence?.receipts, ["call-1"]);
  const delta = byId(folded, "obligation-4");
  assert.equal(delta.status, "satisfied");
  assert.equal(delta.reason, "dependency-evidence");
  assert.deepEqual(delta.evidence?.receipts, ["call-2"]);
  const advisories = byId(folded, "obligation-5");
  assert.equal(advisories.status, "satisfied");
  assert.equal(advisories.reason, "dependency-evidence");

  // The #750 coverage fold agrees row-for-row on the SAME ledger and tags.
  const ledger = buildEvidenceLedger({
    toolCalls, toolResults,
    certifiedDiffPayloads: [], rawDiff: null, candidatePaths: [],
    ciEvidence: null, reviewedHeadSha: HEAD,
  });
  const tags = tagsForRows(rows);
  const coverage = evaluateRequiredCheckCoverage(rows.map((row) => row.text), VERDICT_DISPOSITIONS, ledger, tags);
  for (const row of coverage.checks) {
    const obligation = folded.find((entry) => entry.text === row.check)!;
    assert.equal(row.status, obligation.status, `coverage/obligation disagreement on: ${row.check}`);
  }
  assert.deepEqual(
    coverage.checks.filter((row) => isMergeAffectingRowClass(row.rowClass)).map((row) => row.status),
    ["satisfied", "satisfied", "satisfied"],
  );

  // The reason-coded rows survive the strict obligation artifact round-trip.
  const readBack = reviewObligationsFromArtifact(reviewObligationsToArtifact(folded, null));
  assert.ok(readBack !== null);
  for (const id of ["obligation-3", "obligation-4", "obligation-5"]) {
    assert.equal(readBack.find((row) => row.id === id)?.evidence?.state, "receipt-backed", id);
  }
});

test("#1763 organic #12375 (OCI chart): the ghcr chart catalog + helm-charts compare + version advisory settle all three rows", () => {
  const rows = imageRows([{
    slug: "ghcr.io/prometheus-community/charts/prometheus-blackbox-exporter",
    versions: ["11.21.3", "11.22.0"],
    kind: "chart",
  }]);
  const folded = foldDependencyRows(
    [
      { tool: "web_fetch", args: { url: "https://ghcr.io/prometheus-community/charts/prometheus-blackbox-exporter" }, status: "ok" },
      { tool: "web_fetch", args: { url: "https://github.com/prometheus-community/helm-charts/compare/prometheus-blackbox-exporter-11.21.3...prometheus-blackbox-exporter-11.22.0" }, status: "ok" },
      { tool: "web_search", args: { query: "prometheus-blackbox-exporter 11.21.3 11.22.0 advisory" }, status: "ok" },
    ],
    [
      { status: "ok", result: { content: "{\"mediaType\":\"application/vnd.cncf.helm.config.v1+json\"}" } },
      { status: "ok", result: { content: "3 commits" } },
      { status: "ok", result: { results: "no CVEs in the chart's pinned images" } },
    ],
    rows,
  );
  for (const id of ["obligation-3", "obligation-4", "obligation-5"]) {
    const row = byId(folded, id);
    assert.equal(row.status, "satisfied", `${id}: ${JSON.stringify(row.evidence)}`);
    assert.equal(row.evidence?.state, "receipt-backed", id);
  }
});

test("#1763: Docker Hub spellings normalize to the docker.io/<name> identity — official spellings settle, an unrelated owner does not", () => {
  const rows = imageRows([{ slug: "docker.io/alpine", versions: ["3.20.1", "3.21.0"], kind: "image" }]);
  const provenanceStateFor = (url: string): string | undefined => byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url }, status: "ok" }],
    [{ status: "ok", result: { content: "alpine — minimal rootfs images" } }],
    rows,
  ), "obligation-3").evidence?.state;
  // Both official spellings canonicalize to docker.io/alpine…
  assert.equal(provenanceStateFor("https://hub.docker.com/_/alpine"), "receipt-backed");
  assert.equal(provenanceStateFor("https://hub.docker.com/r/library/alpine"), "receipt-backed");
  // …a same-named image under another owner normalizes to docker.io/evil/
  // alpine — a DIFFERENT artifact that carries no binding identity token
  // for the official entry (the generic carry needs the full slug, and a
  // two-segment identity has no namespace/name pair to carry) — not even a
  // candidate, never a settle.
  assert.equal(provenanceStateFor("https://hub.docker.com/r/evil/alpine"), "receipt-absent");
});

test("#1763 negative controls: attacker catalogs, wrong endpoints, stale advisories, and unverified acquisitions never settle image rows", () => {
  // (a) A same-named repository under an UNRELATED owner carries the bare
  // artifact NAME, but a FETCHED surface binds only through the OWNER
  // segment: the attacker-registered repo names no candidate identity for
  // this entry at all — `receipt-absent`, fail closed even before the
  // canonical-catalog provenance rule (a same-OWNER source read is the
  // mismatch case, pinned below).
  const attacker = byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://github.com/evil/unifi-network-mcp" }, status: "ok" }],
    [{ status: "ok", result: { content: "same-named repository, different owner" } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-3");
  assert.equal(attacker.status, "unresolved");
  assert.equal(attacker.evidence?.state, "receipt-absent");

  // (b) release_delta with the WRONG old endpoint: the candidate carries
  // the namespace identity and the new version, but not the captured old
  // endpoint — joint coverage of EVERY captured version fails.
  const wrongDelta = byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://github.com/sirkirby/unifi-mcp/compare/0.49.1...0.50.0" }, status: "ok" }],
    [{ status: "ok", result: { content: "40 commits" } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-4");
  assert.equal(wrongDelta.status, "unresolved");
  assert.equal(wrongDelta.evidence?.state, "receipt-mismatch");

  // (c) A security_advisory naming only the OLD version proves nothing
  // about the updated one.
  const staleAdvisory = byId(foldDependencyRows(
    [{ tool: "web_search", args: { query: "unifi-network-mcp 0.49.2 advisory" }, status: "ok" }],
    [{ status: "ok", result: { results: "GHSA-xxxx fixed in 0.49.2" } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-5");
  assert.equal(staleAdvisory.status, "unresolved");
  assert.equal(staleAdvisory.evidence?.state, "receipt-mismatch");

  // (d) A FAILED or TRUNCATED acquisition of an otherwise-covering target is
  // recorded and reason-coded, never credited.
  const failed = byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp" }, status: "error" }],
    [{ status: "error", result: { error: "fetch failed" } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-3");
  assert.equal(failed.status, "unresolved");
  assert.equal(failed.evidence?.state, "receipt-unverified");
  const truncated = byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp" }, status: "ok" }],
    [{ status: "ok", result: { content: "{\"schemaVersion\":", truncated: true } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-3");
  assert.equal(truncated.status, "unresolved");
  assert.equal(truncated.evidence?.state, "receipt-unverified");

  // (e) A digest-only image entry (no captured version identity): provenance
  // still settles from the canonical catalog, while the version-asserting
  // rows stay uncovered — nothing was captured to assert (round 9 rule).
  const digestRows = imageRows([{
    slug: "ghcr.io/sirkirby/unifi-network-mcp",
    versions: [],
    kind: "image",
    digests: [IMAGE_DIGEST_A],
  }]);
  const digestProvenance = byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp" }, status: "ok" }],
    [{ status: "ok", result: { content: "multi-arch manifest index" } }],
    digestRows,
  ), "obligation-3");
  assert.equal(digestProvenance.status, "satisfied");
  assert.equal(digestProvenance.evidence?.state, "receipt-backed");
  const digestDelta = byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://github.com/sirkirby/unifi-mcp/compare/network-0.49.2...network-0.50.0" }, status: "ok" }],
    [{ status: "ok", result: { content: "9 commits" } }],
    digestRows,
  ), "obligation-4");
  assert.equal(digestDelta.status, "unresolved");
  assert.equal(digestDelta.evidence?.state, "receipt-mismatch");
  const digestAdvisory = byId(foldDependencyRows(
    [{ tool: "web_search", args: { query: "unifi-network-mcp 0.49.2 0.50.0 advisory" }, status: "ok" }],
    [{ status: "ok", result: { results: "none" } }],
    digestRows,
  ), "obligation-5");
  assert.equal(digestAdvisory.status, "unresolved");
  assert.equal(digestAdvisory.evidence?.state, "receipt-mismatch");
});

test("#1763 (review): a FETCHED surface binds an image entry only through its OWNER segment — attacker same-name artifacts are no candidate", () => {
  // (1) The exact attack the carry must refuse: an attacker-registered
  // same-named repo whose compare URL spells BOTH captured versions. The
  // fetched name token carries nothing without the owner, so the delta row
  // never even sees a candidate — `receipt-absent`, not a settle.
  const attackerDelta = byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://github.com/evil/unifi-network-mcp/compare/0.49.2...0.50.0" }, status: "ok" }],
    [{ status: "ok", result: { content: "2 commits between attacker tags" } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-4");
  assert.equal(attackerDelta.status, "unresolved");
  assert.equal(attackerDelta.evidence?.state, "receipt-absent");

  // (2) The same-named IMAGE on the registry under another owner: a real
  // canonical catalog page OF A DIFFERENT artifact — it attributes
  // provenance and carries the name, but names no identity for THIS entry.
  const attackerImage = byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://ghcr.io/evil/unifi-network-mcp" }, status: "ok" }],
    [{ status: "ok", result: { content: "{\"schemaVersion\":2}" } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-3");
  assert.equal(attackerImage.status, "unresolved");
  assert.equal(attackerImage.evidence?.state, "receipt-absent");

  // (3) Hostile boundary tokens (#252): the owner segment must appear as
  // an exact slug token — a lookalike namespace embeds it inside a longer
  // identity and carries nothing, even though the name and versions fit.
  const lookalike = byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://github.com/sirkirbyy/unifi-mcp/compare/0.49.2...0.50.0" }, status: "ok" }],
    [{ status: "ok", result: { content: "lookalike owner namespace" } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-4");
  assert.equal(lookalike.status, "unresolved");
  assert.equal(lookalike.evidence?.state, "receipt-absent");

  // (4) The intentional counterpart of (1): the organic #12359 shape —
  // the owner's source repo spells a DIFFERENT name than the image
  // artifact — still settles through the owner carry, and a same-owner
  // source read beside no canonical catalog is the provenance MISMATCH
  // case (a relevant acquisition that covers nothing).
  const ownerDelta = byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://github.com/sirkirby/unifi-mcp/compare/0.49.2...0.50.0" }, status: "ok" }],
    [{ status: "ok", result: { content: "9 commits" } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-4");
  assert.equal(ownerDelta.status, "satisfied");
  const ownerRead = byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://github.com/sirkirby/unifi-mcp" }, status: "ok" }],
    [{ status: "ok", result: { content: "source repository root" } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-3");
  assert.equal(ownerRead.status, "unresolved");
  assert.equal(ownerRead.evidence?.state, "receipt-mismatch");
});
