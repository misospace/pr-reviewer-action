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
import { buildEvidenceLedger, checkEvidenceTagsFromArtifact, evaluateRowEvidence } from "../src/enforcement/evidence-receipts.js";
import { canonicalRegistryCatalogImageIdentity, isCanonicalSourceRepoIdentity, registryDocumentSourceRepo, registryRedirectSourceMapping, sourceRepoSurfaceIdentity } from "../src/tools/dependency-evidence.js";
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
// and the cells bind per kind: provenance settles from the canonical registry
// acquisition that ESTABLISHES the artifact→source/build mapping (#1782) —
// either the claim the canonical document's body makes (OCI source
// annotation / registry metadata field) or, since #1782 round 2, the registry
// host's OWN validated redirect chain to the repository-addressing GitHub
// package page for exactly this artifact (ghcr.io 303s there organically,
// and its real HTML carries no annotation and is ALWAYS clipped by the
// executor's fetch slice) — the image/chart analogue of the #1748
// canonical-source rule. The version-asserting cells bind FETCHED surfaces
// through that retained mapping or the exact canonical catalog URL ONLY:
// #1782 round 2 removed even the generic full-slug token carry for
// image/chart entries (npm keeps it), so no attacker-chosen page that merely
// SPELLS the identity settles anything. Organic replays of the two
// false-INCOMPLETE reports (#12359 ghcr image, #12375 OCI chart), the Docker
// Hub spelling normalization, and the negative controls. The npm fixtures
// above are the untouched #1748 regression suite.
// ---------------------------------------------------------------------------

/** A canonical ghcr catalog document that CLAIMS its source repository —
 * the OCI source annotation GitHub's build-push action stamps into the
 * artifact the publisher's registry serves (#1782: provenance must prove
 * the image/source relationship, and settlement binds the version-asserting
 * rows through this claim). */
function catalogDocumentWithSource(source: string): string {
  return `{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","annotations":{"org.opencontainers.image.source":"${source}","org.opencontainers.image.revision":"7c4b3d5e6f708192a3b4c5d6e7f8091a2b3c4d5e"}}`;
}

const IMAGE_DIGEST_A = "0123456789abcdef".repeat(4);
const IMAGE_DIGEST_B = "fedcba9876543210".repeat(4);

const IMAGE_SCOPE = [{
  slug: "ghcr.io/sirkirby/unifi-network-mcp",
  versions: ["0.49.2", "0.50.0"],
  kind: "image",
  digests: [IMAGE_DIGEST_A, IMAGE_DIGEST_B],
}];

/** The REAL HTML head captured live from the reachable ghcr.io redirect
 * surface on 2026-11-22 (`curl -L https://ghcr.io/sirkirby/unifi-network-mcp`
 * landing on GitHub's pkgs page; first 15 non-blank lines). The GitHub pkgs
 * document head is generic — byte-identical between the unifi-network-mcp
 * and prometheus-blackbox-exporter package pages: a pkgs page's artifact
 * identity lives in the URL the redirect CHAIN asserts, never in this body,
 * which carries NO OCI source annotation and no registry metadata field
 * (#1782 round 2: the organic mapping must come off the executor-attested
 * finalUrl, because the real page is always larger than the 10k-codepoint
 * fetch slice). */
const GITHUB_PKGS_HTML_HEAD =
  "\n\n<!DOCTYPE html>\n<html\n  lang=\"en\"\n  \n  data-color-mode=\"auto\" data-light-theme=\"light\" data-dark-theme=\"dark\"\n  data-a11y-animated-images=\"system\" data-a11y-link-underlines=\"true\"\n  data-css-features=\"site_disable_smooth_scrolling\"\n  >\n\n\n\n\n  <head>\n    <meta charset=\"utf-8\">\n  <link rel=\"dns-prefetch\" href=\"https://github.githubassets.com\">\n  <link rel=\"dns-prefetch\" href=\"https://avatars.githubusercontent.com\">\n  <link rel=\"dns-prefetch\" href=\"https://github-cloud.s3.amazonaws.com\">\n  <link rel=\"dns-prefetch\" href=\"https://user-images.githubusercontent.com/\">\n  <link rel=\"preconnect\" href=\"https://github.githubassets.com\" crossorigin>\n  <link rel=\"preconnect\" href=\"https://avatars.githubusercontent.com\">";

/** The captured GitHub compare-page head shape (same generic document-head
 * family as the pkgs page, clipped by the executor's fetch slice — the
 * delta row's evidence is the acquisition target, never this body). */
const GITHUB_COMPARE_HTML_HEAD =
  "<!DOCTYPE html>\n<html\n  lang=\"en\"\n  data-color-mode=\"auto\" data-light-theme=\"light\" data-dark-theme=\"dark\"\n>\n  <head>\n    <meta charset=\"utf-8\">\n  <link rel=\"dns-prefetch\" href=\"https://github.githubassets.com\">\n  <link rel=\"dns-prefetch\" href=\"https://avatars.githubusercontent.com\">\n";

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
  // The Docker Hub repository-API document (#1782 round 2 — the publisher
  // METADATA JSON surface with the `source`/`repository` fields): the exact
  // repository path under the namespace-owning host, with deeper
  // sub-resources (`/tags`, `/images`) pages OF that same repository.
  assert.equal(canonicalRegistryCatalogImageIdentity("https://hub.docker.com/v2/repositories/library/alpine/"), "docker.io/alpine");
  assert.equal(canonicalRegistryCatalogImageIdentity("https://hub.docker.com/v2/repositories/prom/prometheus"), "docker.io/prom/prometheus");
  assert.equal(canonicalRegistryCatalogImageIdentity("https://hub.docker.com/v2/repositories/alpinelinux/docker-alpine/tags"), "docker.io/alpinelinux/docker-alpine");
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
    // Wrong repository-API shapes: the collection root, a namespace without
    // a repository, and the search endpoint all name no artifact
    // (#1782 round 2 — only `/v2/repositories/<owner>/<name>[/<sub>]`).
    "https://hub.docker.com/v2/repositories",
    "https://hub.docker.com/v2/repositories/onlyone",
    "https://hub.docker.com/v2/search",
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
    // #1782: the fetched catalog DOCUMENT claims its source repository via
    // the OCI source annotation — the artifact→source mapping provenance
    // must establish, and the mapping the delta row binds through.
    { status: "ok", result: { content: catalogDocumentWithSource("https://github.com/sirkirby/unifi-mcp") } },
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

test("#1782 round 2 organic GHCR replay: the registry host's OWN redirect chain settles all three rows — the real surface carries no OCI annotation and is always clipped", () => {
  // The provider-free regression the independent review asked for, replaying
  // the REAL captured acquisition shape (ghcr.io surface, 2026-11-22):
  // `https://ghcr.io/sirkirby/unifi-network-mcp` answers the fetch NOT with
  // a document at that path but with a 303 chain terminating at
  // `github.com/sirkirby/unifi-mcp/pkgs/container/unifi-network-mcp` — the
  // executor reports that terminal URL (`finalUrl`, every Location
  // re-validated against the source-host allowlist), and
  // `registryRedirectSourceMapping` reads the artifact→source mapping off it
  // with NO body authority at all. The captured pkgs HTML carries no OCI
  // annotation anywhere and arrives truncated (GitHub's page exceeds the
  // 10k-codepoint slice every single time — the exact false-INCOMPLETE #1763
  // exists to stop); the delta/advisory rows ride the mapped repository's
  // compare and the artifact-name advisory query, both clipped or advisory.
  const folded = foldDependencyRows(
    [
      { tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp" }, status: "ok" },
      { tool: "web_fetch", args: { url: "https://github.com/sirkirby/unifi-mcp/compare/network-0.49.2...network-0.50.0" }, status: "ok" },
      { tool: "web_search", args: { query: "unifi-network-mcp 0.49.2 0.50.0 advisory" }, status: "ok" },
    ],
    [
      { status: "ok", result: { content: GITHUB_PKGS_HTML_HEAD, truncated: true, finalUrl: "https://github.com/sirkirby/unifi-mcp/pkgs/container/unifi-network-mcp" } },
      { status: "ok", result: { content: GITHUB_COMPARE_HTML_HEAD, truncated: true } },
      { status: "ok", result: { results: "no advisories published for the 0.49.x/0.50.x line" } },
    ],
    imageRows(IMAGE_SCOPE),
  );
  for (const id of ["obligation-3", "obligation-4", "obligation-5"]) {
    const row = byId(folded, id);
    assert.equal(row.status, "satisfied", `${id}: ${JSON.stringify(row.evidence)}`);
    assert.equal(row.evidence?.state, "receipt-backed", id);
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
      { status: "ok", result: { content: catalogDocumentWithSource("https://github.com/prometheus-community/helm-charts") } },
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

test("#1782 round 2 organic OCI-chart replay: the %2f-joined nested-artifact redirect chain settles all three rows", () => {
  // The chart sibling of the organic GHCR replay above (real capture,
  // ghcr.io surface, 2026-11-22): `ghcr.io/prometheus-community/charts/…`
  // 303s to `github.com/prometheus-community/helm-charts/pkgs/container/charts%2F…`
  // — the registry's OWN spelling of a nested artifact path joins it with
  // `%2f` inside the pkgs marker, and the rule decodes it back to the slug's
  // path below the ghcr.io namespace (the marker never names the namespace
  // itself). Same clipped, annotation-free GitHub body; the mapping is the
  // chain's, and the version-asserting rows ride the mapped helm-charts
  // compare and the artifact-name advisory query.
  const folded = foldDependencyRows(
    [
      { tool: "web_fetch", args: { url: "https://ghcr.io/prometheus-community/charts/prometheus-blackbox-exporter" }, status: "ok" },
      { tool: "web_fetch", args: { url: "https://github.com/prometheus-community/helm-charts/compare/prometheus-blackbox-exporter-11.21.3...prometheus-blackbox-exporter-11.22.0" }, status: "ok" },
      { tool: "web_search", args: { query: "prometheus-blackbox-exporter 11.21.3 11.22.0 advisory" }, status: "ok" },
    ],
    [
      { status: "ok", result: { content: GITHUB_PKGS_HTML_HEAD, truncated: true, finalUrl: "https://github.com/prometheus-community/helm-charts/pkgs/container/charts%2Fprometheus-blackbox-exporter" } },
      { status: "ok", result: { content: GITHUB_COMPARE_HTML_HEAD, truncated: true } },
      { status: "ok", result: { results: "no CVEs in the chart's pinned images" } },
    ],
    imageRows([{
      slug: "ghcr.io/prometheus-community/charts/prometheus-blackbox-exporter",
      versions: ["11.21.3", "11.22.0"],
      kind: "chart",
    }]),
  );
  for (const id of ["obligation-3", "obligation-4", "obligation-5"]) {
    const row = byId(folded, id);
    assert.equal(row.status, "satisfied", `${id}: ${JSON.stringify(row.evidence)}`);
    assert.equal(row.evidence?.state, "receipt-backed", id);
  }
});

test("#1763: Docker Hub spellings normalize to the docker.io/<name> identity — official spellings settle, an unrelated owner does not", () => {
  const rows = imageRows([{ slug: "docker.io/alpine", versions: ["3.20.1", "3.21.0"], kind: "image" }]);
  // The Docker Hub repository metadata shape: the `source`/`repository`
  // fields name the build repository (#1782's registry-metadata claim).
  const provenanceStateFor = (url: string): string | undefined => byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url }, status: "ok" }],
    [{ status: "ok", result: { content: '{"name":"alpine","source":"https://github.com/alpinelinux/docker-alpine","repository":"https://github.com/alpinelinux/docker-alpine"}' } }],
    rows,
  ), "obligation-3").evidence?.state;
  // Both official spellings canonicalize to docker.io/alpine…
  assert.equal(provenanceStateFor("https://hub.docker.com/_/alpine"), "receipt-backed");
  assert.equal(provenanceStateFor("https://hub.docker.com/r/library/alpine"), "receipt-backed");
  // …a same-named image under another owner normalizes to docker.io/evil/
  // alpine — a DIFFERENT artifact the fetched surface binds nothing for:
  // an image entry binds a fetched surface only through the exact canonical
  // catalog identity (#1782 round 2 removed even the generic full-slug
  // token carry, and a two-segment identity has no owner-segment search
  // carry on a fetched surface anyway) — not even a candidate, never a
  // settle.
  assert.equal(provenanceStateFor("https://hub.docker.com/r/evil/alpine"), "receipt-absent");
  // #1782 round 2: the repository-API document is a canonical catalog
  // surface too — the publisher's own `source` field settles provenance
  // for the exact repository path…
  const apiRows = imageRows([{ slug: "docker.io/alpinelinux/docker-alpine", versions: ["3.20.1", "3.21.0"], kind: "image" }]);
  const apiProvenanceStateFor = (body: string): string | undefined => byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://hub.docker.com/v2/repositories/alpinelinux/docker-alpine/" }, status: "ok" }],
    [{ status: "ok", result: { content: body } }],
    apiRows,
  ), "obligation-3").evidence?.state;
  assert.equal(apiProvenanceStateFor('{"name":"docker-alpine","source":"https://github.com/alpinelinux/docker-alpine"}'), "receipt-backed");
  // …and its absence settles NOTHING (fail closed): a verified canonical
  // candidate establishing no mapping reads receipt-mismatch, never a
  // silent settle and never receipt-absent beside it.
  assert.equal(apiProvenanceStateFor('{"name":"docker-alpine"}'), "receipt-mismatch");
  assert.equal(apiProvenanceStateFor('{"name":"docker-alpine","source":null}'), "receipt-mismatch");
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

  // (b) release_delta with the WRONG old endpoint: the mapped source repo
  // IS a candidate (the catalog document established the mapping), it
  // carries the new version, but not the captured old endpoint — joint
  // coverage of EVERY captured version fails.
  const wrongDelta = byId(foldDependencyRows(
    [
      { tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp" }, status: "ok" },
      { tool: "web_fetch", args: { url: "https://github.com/sirkirby/unifi-mcp/compare/0.49.1...0.50.0" }, status: "ok" },
    ],
    [
      { status: "ok", result: { content: catalogDocumentWithSource("https://github.com/sirkirby/unifi-mcp") } },
      { status: "ok", result: { content: "40 commits" } },
    ],
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

  // (d) A FAILED acquisition of an otherwise-covering target is recorded and
  // reason-coded, never credited — it fetched nothing.
  const failed = byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp" }, status: "error" }],
    [{ status: "error", result: { error: "fetch failed" } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-3");
  assert.equal(failed.status, "unresolved");
  assert.equal(failed.evidence?.state, "receipt-unverified");
  // #1782 (round 2): a TRUNCATED catalog fetch is a different animal — the
  // acquisition itself succeeded (2xx on the canonical URL, an executor-
  // attested fact the clip cannot invalidate), so it sits in the VERIFIED
  // pool. But the one place the fetched body IS evidence — a document-
  // claimed source mapping — keeps its completeness gate, and this clipped
  // body claims none: a verified canonical candidate establishing no mapping
  // reads `receipt-mismatch` (fail closed, never settle), not the old
  // `receipt-unverified` split.
  const truncated = byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp" }, status: "ok" }],
    [{ status: "ok", result: { content: "{\"schemaVersion\":", truncated: true } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-3");
  assert.equal(truncated.status, "unresolved");
  assert.equal(truncated.evidence?.state, "receipt-mismatch");

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
    [{ status: "ok", result: { content: catalogDocumentWithSource("https://github.com/sirkirby/unifi-mcp") } }],
    digestRows,
  ), "obligation-3");
  assert.equal(digestProvenance.status, "satisfied");
  assert.equal(digestProvenance.evidence?.state, "receipt-backed");
  const digestDelta = byId(foldDependencyRows(
    [
      { tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp" }, status: "ok" },
      { tool: "web_fetch", args: { url: "https://github.com/sirkirby/unifi-mcp/compare/network-0.49.2...network-0.50.0" }, status: "ok" },
    ],
    [
      { status: "ok", result: { content: catalogDocumentWithSource("https://github.com/sirkirby/unifi-mcp") } },
      { status: "ok", result: { content: "9 commits" } },
    ],
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

test("#1782 (independent review): a FETCHED surface binds an image entry only through the ESTABLISHED artifact→source mapping — owner-token spelling settles nothing", () => {
  const catalogCall = { tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp" }, status: "ok" };
  const catalogResult = { status: "ok", result: { content: catalogDocumentWithSource("https://github.com/sirkirby/unifi-mcp") } };

  // (1) The exact attack the old owner carry accepted: an attacker-
  // registered same-named repo whose compare URL spells BOTH captured
  // versions. Even beside a perfectly-established mapping, the surface
  // addresses `evil/unifi-network-mcp`, not the mapped repository — no
  // candidate, `receipt-absent`.
  const attackerDelta = byId(foldDependencyRows(
    [catalogCall, { tool: "web_fetch", args: { url: "https://github.com/evil/unifi-network-mcp/compare/0.49.2...0.50.0" }, status: "ok" }],
    [catalogResult, { status: "ok", result: { content: "2 commits between attacker tags" } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-4");
  assert.equal(attackerDelta.status, "unresolved");
  assert.equal(attackerDelta.evidence?.state, "receipt-absent");

  // (2) The reviewer's exact example: an SAME-OWNER, entirely UNRELATED
  // repository whose compare URL happens to spell both captured versions
  // (`github.com/acme/completely-unrelated` settling `ghcr.io/acme/widget`
  // in the review's wording). The mapping names the artifact's build repo;
  // any other repository of the same owner addresses nothing for the entry.
  const unrelatedSameOwner = foldDependencyRows(
    [
      { tool: "web_fetch", args: { url: "https://ghcr.io/acme/widget" }, status: "ok" },
      { tool: "web_fetch", args: { url: "https://github.com/acme/completely-unrelated/compare/1.2.3...1.2.4" }, status: "ok" },
    ],
    [
      { status: "ok", result: { content: catalogDocumentWithSource("https://github.com/acme/widget") } },
      { status: "ok", result: { content: "spurious tag pair" } },
    ],
    imageRows([{ slug: "ghcr.io/acme/widget", versions: ["1.2.3", "1.2.4"], kind: "image" }]),
  );
  const unrelatedDelta = byId(unrelatedSameOwner, "obligation-4");
  assert.equal(unrelatedDelta.status, "unresolved");
  assert.equal(unrelatedDelta.evidence?.state, "receipt-absent");

  // (3) The pinned residual the review demanded be CLOSED: spelling the
  // owner string as a repository name the attacker controls
  // (`github.com/evil/sirkirby/compare/…`) no longer settles the delta. It
  // addresses `evil/sirkirby`, not the mapped `sirkirby/unifi-mcp`.
  const ownerAsRepoName = byId(foldDependencyRows(
    [catalogCall, { tool: "web_fetch", args: { url: "https://github.com/evil/sirkirby/compare/0.49.2...0.50.0" }, status: "ok" }],
    [catalogResult, { status: "ok", result: { content: "repo named after the owner, attacker-controlled" } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-4");
  assert.equal(ownerAsRepoName.status, "unresolved");
  assert.equal(ownerAsRepoName.evidence?.state, "receipt-absent");

  // (4) Hostile boundary tokens (#252): a LOOKALIKE source repo (an added
  // character) addresses a different repository even though the name and
  // versions fit, even beside the real mapping.
  const lookalike = byId(foldDependencyRows(
    [catalogCall, { tool: "web_fetch", args: { url: "https://github.com/sirkirbyy/unifi-mcp/compare/0.49.2...0.50.0" }, status: "ok" }],
    [catalogResult, { status: "ok", result: { content: "lookalike owner namespace" } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-4");
  assert.equal(lookalike.status, "unresolved");
  assert.equal(lookalike.evidence?.state, "receipt-absent");

  // (5) The cross-host carry-over: the mapping names `github.com/…`; the
  // same owner/repo spelling on ANOTHER forge addresses a different
  // repository and settles nothing.
  const crossHost = byId(foldDependencyRows(
    [catalogCall, { tool: "web_fetch", args: { url: "https://gitlab.com/sirkirby/unifi-mcp/compare/0.49.2...0.50.0" }, status: "ok" }],
    [catalogResult, { status: "ok", result: { content: "same-name fork on another forge" } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-4");
  assert.equal(crossHost.status, "unresolved");
  assert.equal(crossHost.evidence?.state, "receipt-absent");

  // (6) The intentional counterpart: the organic #12359 shape — the mapped
  // source repo spells a DIFFERENT name than the image artifact — settles
  // the delta through the mapping, and a source-repo read beside NO
  // canonical catalog names no identity at all for the entry (#1782:
  // without the registry document there is no established mapping — the
  // old owner-carry `receipt-mismatch` becomes the stricter `absent`).
  const ownerDelta = byId(foldDependencyRows(
    [catalogCall, { tool: "web_fetch", args: { url: "https://github.com/sirkirby/unifi-mcp/compare/0.49.2...0.50.0" }, status: "ok" }],
    [catalogResult, { status: "ok", result: { content: "9 commits" } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-4");
  assert.equal(ownerDelta.status, "satisfied");
  const bareOwnerRead = byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://github.com/sirkirby/unifi-mcp" }, status: "ok" }],
    [{ status: "ok", result: { content: "source repository root" } }],
    imageRows(IMAGE_SCOPE),
  ), "obligation-3");
  assert.equal(bareOwnerRead.status, "unresolved");
  assert.equal(bareOwnerRead.evidence?.state, "receipt-absent");
});

test("#1782 (independent review): provenance settles only from a catalog document that CLAIMS the source mapping — a bare index body stays fail-closed", () => {
  const catalogCall = { tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp" }, status: "ok" };
  const deltaCall = { tool: "web_fetch", args: { url: "https://github.com/sirkirby/unifi-mcp/compare/0.49.2...0.50.0" }, status: "ok" };

  // (a) The organic repro WITHOUT the mapping: a real, successful fetch of
  // the canonical catalog URL returning a bare OCI index body proves the
  // registry SERVES the artifact, never which repository builds it (#1763:
  // a pullable identity is insufficient). Provenance refuses it
  // (`receipt-mismatch` beside the verified same-slug acquisition), and
  // WITHOUT the mapping even the genuine source-repo compare is no
  // candidate — the whole row set stays unresolved, fail-closed.
  const bare = foldDependencyRows(
    [catalogCall, deltaCall],
    [
      { status: "ok", result: { content: "{\"schemaVersion\":2,\"mediaType\":\"application/vnd.oci.image.index.v1+json\"}" } },
      { status: "ok", result: { content: "9 commits" } },
    ],
    imageRows(IMAGE_SCOPE),
  );
  assert.equal(byId(bare, "obligation-3").evidence?.state, "receipt-mismatch");
  assert.equal(byId(bare, "obligation-4").evidence?.state, "receipt-absent");

  // (b) An UNATTRIBUTABLE claim — the source field values this runtime
  // cannot represent as one clean repository identity (a schemeless
  // display name, a host with a port, an escaped segment, a shallower
  // org page) — yields no mapping, same fail-closed reading as no claim.
  for (const claim of [
    "unifi-mcp on GitHub",
    "https://github.com:8443/sirkirby/unifi-mcp",
    "https://github.com/sirkirby%2Funifi-mcp/x",
    "https://github.com/sirkirby",
    "ftp://github.com/sirkirby/unifi-mcp",
  ]) {
    const folded = byId(foldDependencyRows(
      [catalogCall],
      [{ status: "ok", result: { content: `{"annotations":{"org.opencontainers.image.source":"${claim}"}}` } }],
      imageRows(IMAGE_SCOPE),
    ), "obligation-3");
    assert.equal(folded.evidence?.state, "receipt-mismatch", claim);
  }

  // (c) CONFLICTING claims across the artifact's catalog documents (a
  // repacked or ambiguous artifact) name no canonical mapping — provenance
  // refuses, and nothing binds through the ambiguity.
  const conflicting = foldDependencyRows(
    [catalogCall, { ...catalogCall, args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp/" } }, deltaCall],
    [
      { status: "ok", result: { content: catalogDocumentWithSource("https://github.com/sirkirby/unifi-mcp") } },
      { status: "ok", result: { content: catalogDocumentWithSource("https://gitlab.com/other-maintainer/unifi-mcp") } },
      { status: "ok", result: { content: "9 commits" } },
    ],
    imageRows(IMAGE_SCOPE),
  );
  assert.equal(byId(conflicting, "obligation-3").evidence?.state, "receipt-mismatch");
  assert.equal(byId(conflicting, "obligation-4").evidence?.state, "receipt-absent");

  // (d) The CLAIM is not a generic carry: the document's claimed owner/
  // repo tokens never make some OTHER surface speak for the entry — the
  // mapping flows only through the establishment rule.
  assert.equal(canonicalRegistryCatalogImageIdentity("https://ghcr.io/sirkirby/unifi-network-mcp"), "ghcr.io/sirkirby/unifi-network-mcp");
});

test("#1782 round 2: a forge read carries NOTHING for an image entry — never the mapping (its receipt records no forge host), and no generic token remains", () => {
  // The mapping names github.com/sirkirby/unifi-mcp; a gh_api compare on
  // the review's forge spells the same owner/repo, but the receipt cannot
  // prove WHICH host it read, so the mapping binds nothing — and since
  // #1782 round 2 there is no generic full-slug token carry left for an
  // image/chart entry to fall back to either (the clause npm cells keep):
  // the forge channel carries NOTHING for an image entry, the delta row
  // has not even a candidate, and an image run whose registry host was
  // refused fails provenance closed anyway.
  const folded = foldDependencyRows(
    [
      { tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp" }, status: "ok" },
      { tool: "gh_api", args: { endpoint: "repos/sirkirby/unifi-mcp/compare/network-0.49.2...network-0.50.0" }, status: "ok" },
    ],
    [
      { status: "ok", result: { content: catalogDocumentWithSource("https://github.com/sirkirby/unifi-mcp") } },
      { status: "ok", result: { response: "9 commits" } },
    ],
    imageRows(IMAGE_SCOPE),
  );
  const delta = byId(folded, "obligation-4");
  assert.equal(delta.status, "unresolved");
  assert.equal(delta.evidence?.state, "receipt-absent");
});

test("#1782 round 2: image/chart entries have NO generic full-slug carry — an attacker page spelling the exact slug and versions settles nothing", () => {
  // The generic full-slug token carry survives on the npm cells only (a
  // page `evil/webpack` beside the slug `webpack`). For an image/chart
  // entry #1782 round 2 REMOVED it: once a mapping strong enough to
  // establish provenance exists, #1763's negative control ("unrelated
  // image/repository evidence does not settle any row") means a page an
  // attacker chose that merely SPELLS the complete slug plus both captured
  // versions (`evil.example/compare?dep=<slug>&…`) settles nothing either —
  // spelling strings is not the established artifact→source relationship.
  // A fetched image/chart surface binds the exact canonical registry URL or
  // the mapped repository, nothing else: not even a candidate, never a
  // settle (npm keeps its residual, pinned by the #1726/#1748 fixtures
  // above).
  const folded = foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://evil.example/compare?dep=ghcr.io/sirkirby/unifi-network-mcp&base=0.49.2&head=0.50.0" }, status: "ok" }],
    [{ status: "ok", result: { content: "spelled identity" } }],
    imageRows(IMAGE_SCOPE),
  );
  const delta = byId(folded, "obligation-4");
  assert.equal(delta.status, "unresolved");
  assert.equal(delta.evidence?.state, "receipt-absent");
});

test("#1782: the retained mapping round-trips the persisted ledger and a hand-shaped claim refuses the whole artifact", async () => {
  const { evidenceLedgerToArtifact, evidenceLedgerFromArtifact } = await import("../src/enforcement/evidence-receipts.js");
  const ledger = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp" }, status: "ok" }],
    toolResults: [{ status: "ok", result: { content: catalogDocumentWithSource("https://github.com/sirkirby/unifi-mcp") } }],
    certifiedDiffPayloads: [], rawDiff: null, candidatePaths: [], ciEvidence: null, reviewedHeadSha: HEAD,
  });
  const artifact = evidenceLedgerToArtifact(ledger);
  const readBack = evidenceLedgerFromArtifact(artifact);
  assert.ok(readBack !== null);
  assert.equal(readBack.receipts[0]?.subject.sourceRepo, "github.com/sirkirby/unifi-mcp");
  // #1782 round 2: the mapping AUTHORITY persists beside the mapping — a
  // body claim reads "document", the stricter authority.
  assert.equal((JSON.parse(JSON.stringify(artifact)) as { receipts: Array<{ subject: Record<string, unknown> }> }).receipts[0]?.subject.source_repo_via, "document");
  assert.equal(readBack.receipts[0]?.subject.sourceRepoVia, "document");
  // The strict reader re-enforces the canonical grammar on reload.
  const tampered = JSON.parse(JSON.stringify(artifact));
  tampered.receipts[0].subject.source_repo = "https://github.com/sirkirby/unifi-mcp";
  assert.equal(evidenceLedgerFromArtifact(tampered), null);
  tampered.receipts[0].subject.source_repo = "github.com/evil%2fsirkirby/unifi-mcp";
  assert.equal(evidenceLedgerFromArtifact(tampered), null);
  // #1782 round 2: a redirect-style acquisition round-trips its chain
  // attestation — `source_repo_via: "redirect"` is exactly what exempts the
  // body-clipped organic catalog fetch from the document-completeness gate.
  const redirectLedger = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp" }, status: "ok" }],
    toolResults: [{ status: "ok", result: { content: "page", truncated: true, finalUrl: "https://github.com/sirkirby/unifi-mcp/pkgs/container/unifi-network-mcp" } }],
    certifiedDiffPayloads: [], rawDiff: null, candidatePaths: [], ciEvidence: null, reviewedHeadSha: HEAD,
  });
  const redirectArtifact = evidenceLedgerToArtifact(redirectLedger);
  const redirectSubject = (JSON.parse(JSON.stringify(redirectArtifact)) as { receipts: Array<{ subject: Record<string, unknown> }> }).receipts[0]!.subject;
  assert.equal(redirectSubject.source_repo, "github.com/sirkirby/unifi-mcp");
  assert.equal(redirectSubject.source_repo_via, "redirect");
  const redirectReadBack = evidenceLedgerFromArtifact(redirectArtifact);
  assert.ok(redirectReadBack !== null);
  assert.equal(redirectReadBack.receipts[0]?.subject.sourceRepo, "github.com/sirkirby/unifi-mcp");
  assert.equal(redirectReadBack.receipts[0]?.subject.sourceRepoVia, "redirect");
  // The authority is a closed vocabulary, and a dangling `via` (attesting no
  // mapping) is exactly as hand-shaped as a bogus one — both refuse the
  // whole artifact.
  const bogusVia = JSON.parse(JSON.stringify(redirectArtifact));
  bogusVia.receipts[0].subject.source_repo_via = "bogus";
  assert.equal(evidenceLedgerFromArtifact(bogusVia), null);
  const danglingVia = JSON.parse(JSON.stringify(redirectArtifact));
  delete danglingVia.receipts[0].subject.source_repo;
  assert.equal(evidenceLedgerFromArtifact(danglingVia), null);
});

test("#1782: registryDocumentSourceRepo / sourceRepoSurfaceIdentity — the lexical mapping rules fail closed", () => {
  // Publisher spellings that establish the mapping.
  const cases: Array<[string, string]> = [
    ['{"annotations":{"org.opencontainers.image.source":"https://github.com/o/r"}}', "github.com/o/r"],
    ['LABEL org.opencontainers.image.source=https://github.com/o/r', "github.com/o/r"],
    ['{"source":"https://www.GitHub.com/O/R.git"}', "github.com/o/r"],
    ['{"source":"https://github.com/o/r/tree/main"}', "github.com/o/r"],
    ['{"repository":"https://gitlab.example.org/team/component","x":1}', "gitlab.example.org/team/component"],
    ['"source": "https://github.com/o/r", "other": "https://github.com/o/r"', "github.com/o/r"],
    ['{"source":"https://github.com/o/r.git.git"}', "github.com/o/r"],
    ['{"source":"https://www.www.example.com/o/r"}', "example.com/o/r"],
  ];
  for (const [content, expected] of cases) {
    assert.equal(registryDocumentSourceRepo(content), expected, content);
    // Every accepted claim is exactly its own canonical form: the strict
    // ledger reader's re-check always survives the round-trip.
    assert.equal(isCanonicalSourceRepoIdentity(expected), true, expected);
  }
  // No claim, malformed claims, and CONFLICTING claims all yield nothing.
  for (const content of [
    "",
    "a prose page mentioning the word source",
    '{"source":"https://github.com/o"}',
    '{"source":"https://github.com"}',
    '{"source":"https://localhost/o/r"}',
    '{"source":"https://user@github.com/o/r"}',
    '{"source":"https://github.com:443/o/r"}',
    '{"source":"https://github.com/%6f/r"}',
    '{"source":"http://github.com/o/r","repository":"https://gitlab.com/x/y"}',
    '{"source":"git@github.com:o/r"}',
    '{"org.opencontainers.image.source":"https://github.com/a/b","source":"https://github.com/c/d"}',
  ]) {
    assert.equal(registryDocumentSourceRepo(content), null, content);
  }
  // The surface side: repository-addressing URLs canonicalize, everything
  // else names no repository.
  assert.equal(sourceRepoSurfaceIdentity("https://github.com/sirkirby/unifi-mcp/compare/1...2"), "github.com/sirkirby/unifi-mcp");
  assert.equal(sourceRepoSurfaceIdentity("https://www.github.com/o/r"), "github.com/o/r");
  assert.equal(sourceRepoSurfaceIdentity("https://github.com/o/r.git"), "github.com/o/r");
  for (const url of [
    "",
    "github.com/o/r",
    "https://github.com/o",
    "https://github.com",
    "https://user@github.com/o/r",
    "https://github.com:8443/o/r",
    "https://github.com/o/%72/releases",
    "ftp://github.com/o/r",
  ]) {
    assert.equal(sourceRepoSurfaceIdentity(url), null, url);
  }
});

test("#1782 round 2: registryRedirectSourceMapping — the lexical registry-host-asserted artifact→source rule fails closed", () => {
  // The organic GHCR image chain (real capture, 2026-11-22): the registry's
  // terminal page is the repository-addressing pkgs surface for exactly
  // THIS artifact, so the chain asserts `github.com/sirkirby/unifi-mcp`.
  assert.equal(
    registryRedirectSourceMapping("https://ghcr.io/sirkirby/unifi-network-mcp", "https://github.com/sirkirby/unifi-mcp/pkgs/container/unifi-network-mcp"),
    "github.com/sirkirby/unifi-mcp",
  );
  // The organic OCI-chart chain: the registry's OWN spelling of a nested
  // artifact path is `%2f`-joined and decodes to the slug's path BELOW the
  // ghcr.io namespace (the namespace itself is not part of the marker).
  assert.equal(
    registryRedirectSourceMapping("https://ghcr.io/prometheus-community/charts/prometheus-blackbox-exporter", "https://github.com/prometheus-community/helm-charts/pkgs/container/charts%2Fprometheus-blackbox-exporter"),
    "github.com/prometheus-community/helm-charts",
  );
  for (const finalUrl of [
    // Not github.com: a mirror spelling the whole marker asserts nothing —
    // only the registry operator's own host chain does.
    "https://mirror.example/sirkirby/unifi-mcp/pkgs/container/unifi-network-mcp",
    // The marker misspelled, or not immediately after <owner>/<repo>.
    "https://github.com/sirkirby/unifi-mcp/pkg/container/unifi-network-mcp",
    "https://github.com/sirkirby/unifi-mcp/docs/pkgs/container/x",
    // The marker spelled deeper than the repository's own five segments.
    "https://github.com/sirkirby/unifi-mcp/pkgs/container/unifi-network-mcp/too-deep",
    // The repository-INDEPENDENT GitHub package hop: it never resolved to
    // a repository, so it asserts none. The reserved `-` namespace is not
    // an owner — neither the 4-segment hop URL nor a five-segment
    // `pkgs/container` lookalike under it maps to anything.
    "https://github.com/-/sirkirby/packages/container/package/unifi-network-mcp",
    "https://github.com/-/sirkirby/pkgs/container/unifi-network-mcp",
    // Artifact mismatch: the redirect speaks about a different package.
    "https://github.com/sirkirby/unifi-mcp/pkgs/container/other-artifact",
    // The namespace-qualified spelling is not the registry's: the marker
    // names the artifact below ghcr.io/<namespace>, never the full path.
    "https://github.com/sirkirby/unifi-mcp/pkgs/container/sirkirby%2funifi-network-mcp",
    // Any percent-escape OTHER than the registry's own `%2f` is not a
    // clean identity character.
    "https://github.com/sirkirby/unifi-mcp/pkgs/container/unifi%2enetwork-mcp",
  ]) {
    assert.equal(registryRedirectSourceMapping("https://ghcr.io/sirkirby/unifi-network-mcp", finalUrl), null, finalUrl);
  }
  // And the REQUESTED side must itself be the canonical ghcr catalog: the
  // other accepted registry hosts answer no repository-addressing package
  // redirect, and a non-canonical ghcr target names no artifact to speak
  // about.
  assert.equal(registryRedirectSourceMapping("https://hub.docker.com/r/sirkirby/unifi-mcp", "https://github.com/sirkirby/unifi-mcp/pkgs/container/unifi-mcp"), null);
  assert.equal(registryRedirectSourceMapping("https://ghcr.io/o", "https://github.com/sirkirby/unifi-mcp/pkgs/container/unifi-network-mcp"), null);
  // A terminal URL carrying transport query/fragment noise canonicalizes
  // EXACTLY like the clean chain (the shared repository-surface grammar
  // strips `[?#]…` the same way it does for every other surface identity),
  // while garbage smuggled into the artifact segment WITHOUT a `?` is a
  // mismatch and asserts nothing.
  assert.equal(registryRedirectSourceMapping("https://ghcr.io/sirkirby/unifi-network-mcp", "https://github.com/sirkirby/unifi-mcp/pkgs/container/unifi-network-mcp?tab=overview"), "github.com/sirkirby/unifi-mcp");
  assert.equal(registryRedirectSourceMapping("https://ghcr.io/sirkirby/unifi-network-mcp", "https://github.com/sirkirby/unifi-mcp/pkgs/container/unifi-network-mcp&evil=1"), null);
});

test("#1782 round 2: a catalog fetch whose redirect chain asserts nothing establishes no mapping — and a redirected page's prose is never laundered into a source claim", () => {
  const catalogCall = { tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp" }, status: "ok" };
  const provenanceStateFor = (result: Record<string, unknown>) => byId(foldDependencyRows(
    [catalogCall], [{ status: "ok", result }], imageRows(IMAGE_SCOPE),
  ), "obligation-3").evidence?.state;

  // (a) The pkgs artifact MISMATCHES the slug: the five-segment marker is
  // about `some-other-pkg`, so no chain mapping is asserted; the verified
  // canonical candidate establishes nothing → receipt-mismatch.
  assert.equal(provenanceStateFor({ content: "html page", truncated: true, finalUrl: "https://github.com/sirkirby/unifi-mcp/pkgs/container/some-other-pkg" }), "receipt-mismatch");
  // (b) Redirected to a github page that carries no pkgs marker at all:
  // same fail-closed reading.
  assert.equal(provenanceStateFor({ content: "html page", truncated: true, finalUrl: "https://github.com/sirkirby/unifi-mcp" }), "receipt-mismatch");
  // (c) A redirect that lands on a DIFFERENT canonical registry identity
  // would still be a canonical document — but a redirect to an unrelated
  // surface is not: the landing page's injected source CLAIM never attaches
  // to the receipt (bodyIsCanonical false), and the row fails closed.
  const launderLedger = buildEvidenceLedger({
    toolCalls: [catalogCall],
    toolResults: [{ status: "ok", result: { content: '{"name":"x","source":"https://github.com/evil/mcp"}', truncated: true, finalUrl: "https://github.com/somebody/unrelated" } }],
    certifiedDiffPayloads: [], rawDiff: null, candidatePaths: [], ciEvidence: null, reviewedHeadSha: HEAD,
  });
  assert.equal(launderLedger.receipts[0]?.subject.sourceRepo, undefined);
  assert.equal(provenanceStateFor({ content: '{"name":"x","source":"https://github.com/evil/mcp"}', truncated: true, finalUrl: "https://github.com/somebody/unrelated" }), "receipt-mismatch");
  // (d) The repository-independent `github.com/-/<owner>/packages/…` hop:
  // the chain never resolved to a repository — nothing retained, same
  // fail-closed reading.
  assert.equal(provenanceStateFor({ content: "html page", truncated: true, finalUrl: "https://github.com/-/sirkirby/packages/container/package/unifi-network-mcp" }), "receipt-mismatch");
});

test("#1782 round 2: body clipping settles URL-attested cells but gates the ONE place body content is evidence — the document-claimed mapping", () => {
  // The redirect-mapped organic catalog fetch above (truncated by the very
  // real GitHub page size) ESTABLISHES the mapping and settles provenance —
  // pinned by the two organic replays. The document claim is the one place
  // the fetched content IS evidence, and completeness still gates it: a
  // clipped canonical document's claim may hide a conflicting claim below
  // the slice, so it never settles — but it does enter the full-ledger
  // mapping the unverified-fill REASON-CODING pass consults, so the row
  // reads `receipt-unverified`, never a silent mismatch.
  const hubRows = imageRows([{ slug: "docker.io/alpinelinux/docker-alpine", versions: ["3.20.1", "3.21.0"], kind: "image" }]);
  const hubCall = { tool: "web_fetch", args: { url: "https://hub.docker.com/v2/repositories/alpinelinux/docker-alpine" }, status: "ok" };
  const hubBody = '{"name":"docker-alpine","source":"https://github.com/alpinelinux/docker-alpine"}';
  const provenanceStateFor = (result: Record<string, unknown>) => byId(foldDependencyRows(
    [hubCall], [{ status: "ok", result }], hubRows,
  ), "obligation-3").evidence?.state;
  assert.equal(provenanceStateFor({ content: hubBody }), "receipt-backed");
  // The clip lands AFTER the publisher's claim (the real Hub JSON continues
  // with images/tags below the fetch slice): the claim is present in the
  // clipped body — and precisely BECAUSE the body is clipped (a conflicting
  // claim may follow below the slice) it establishes nothing, while the
  // full-ledger mapping the unverified-fill pass consults still carries it.
  assert.equal(provenanceStateFor({ content: `${hubBody.slice(0, -1)},`, truncated: true }), "receipt-unverified");
  // CONFLICTING authorities are fail-closed the same way as conflicting
  // documents: a redirect chain asserting the true source beside a COMPLETE
  // catalog document claiming a different repository (a repacked/re-tagged
  // artifact) establishes NO single mapping — the settle pool refuses the
  // ambiguity, the verified canonical candidates cover nothing, and the
  // row reads receipt-mismatch (never the convenient mapping).
  const conflicting = foldDependencyRows(
    [
      { tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp" }, status: "ok" },
      { tool: "web_fetch", args: { url: "https://ghcr.io/sirkirby/unifi-network-mcp/" }, status: "ok" },
    ],
    [
      { status: "ok", result: { content: "html page", truncated: true, finalUrl: "https://github.com/sirkirby/unifi-mcp/pkgs/container/unifi-network-mcp" } },
      { status: "ok", result: { content: catalogDocumentWithSource("https://github.com/repacked/unifi-mcp") } },
    ],
    imageRows(IMAGE_SCOPE),
  );
  const provenance = byId(conflicting, "obligation-3");
  assert.equal(provenance.status, "unresolved");
  assert.equal(provenance.evidence?.state, "receipt-mismatch");
});

test("#1763 (review): two-segment official-Hub identities settle advisories through the search NAME carry, never a fetched name", () => {
  const rows = imageRows([{ slug: "docker.io/alpine", versions: ["3.20.1", "3.21.0"], kind: "image" }]);
  // The base-image advisory shape names the ARTIFACT, not any owner: the
  // web-search channel carries it even with no owner segment to bind.
  const advisory = byId(foldDependencyRows(
    [{ tool: "web_search", args: { query: "alpine 3.20.1 3.21.0 advisory" }, status: "ok" }],
    [{ status: "ok", result: { results: "no CVEs reported for 3.21.0" } }],
    rows,
  ), "obligation-5");
  assert.equal(advisory.status, "satisfied");
  assert.equal(advisory.evidence?.state, "receipt-backed");
  // A fetched surface still needs more than the bare official-image name:
  // an image entry binds a fetched surface only through the exact canonical
  // catalog document or the established mapping (#1782 round 2 removed even
  // the generic full-slug carry, so there is no token to carry at all), and
  // an `example.com/alpine/…` page is no candidate for `docker.io/alpine`.
  const fetchedName = byId(foldDependencyRows(
    [{ tool: "web_fetch", args: { url: "https://example.com/alpine/releases/3.20.1-to-3.21.0" }, status: "ok" }],
    [{ status: "ok", result: { content: "release notes" } }],
    rows,
  ), "obligation-4");
  assert.equal(fetchedName.status, "unresolved");
  assert.equal(fetchedName.evidence?.state, "receipt-absent");
});

// ---------------------------------------------------------------------------
// #1821 (independent review): the organic #1819 acceptance shape.
// An `@types/node` 26.6.7 → 26.6.10 lockfile bump whose upstream
// (DefinitelyTyped) publishes NO per-version Git tag: the model's tag/compare
// lookups 404, and ordinary registry version-doc fetches attribute provenance
// only — so the mandatory `release_delta` row could not settle. The code-owned
// exact published-package comparison (integrity- and manifest-verified trees,
// compared without any tag) now rides the ledger and settles exactly what it
// proved — and nothing it did not.
// ---------------------------------------------------------------------------

const TYPES_NODE = [{ slug: "types/node", versions: ["26.6.7", "26.6.10"] }];

const NPM1819_ROWS = [
  { text: "establish upstream provenance for the updated dependency: publisher and canonical source repository", row_class: "objective", gate: "dependency-evidence", obligations: ["provenance"], dependency_scope: TYPES_NODE },
  { text: "inspect the exact old→new upstream release delta for the updated dependency", row_class: "objective", gate: "dependency-evidence", obligations: ["release_delta"], dependency_scope: TYPES_NODE },
  { text: "check upstream security advisories for the updated dependency version range, or report the advisory check as not performed", row_class: "objective", gate: "dependency-evidence", obligations: ["security_advisory"], dependency_scope: TYPES_NODE },
];

function npm1819Tags(text: string) {
  const row = NPM1819_ROWS.find((candidate) => candidate.text === text)!;
  const tags = checkEvidenceTagsFromArtifact([row]);
  assert.equal(tags.length, 1);
  return tags[0]!;
}

/** The #1819 run's trace: the tag-era lookups all failed (DefinitelyTyped has
 * no per-version tags), and NO successful acquisition carries the exact
 * old→new pair through lexical attribution. */
const NPM1819_CALLS = [
  { tool: "read_file", args: { path: "package-lock.json" }, status: "ok" },
  { tool: "web_fetch", args: { url: "https://github.com/DefinitelyTyped/DefinitelyTyped/compare/types-node-26.6.7...types-node-26.6.10" }, status: "error" },
  { tool: "web_fetch", args: { url: "https://registry.npmjs.org/@types%2Fnode" }, status: "ok" },
];
const NPM1819_RESULTS = [
  { status: "ok", result: { content: "lockfile" } },
  { status: "error", result: { error: "HTTP 404" } },
  { status: "ok", result: { content: "{}", truncated: false, status: 200 } },
];

function npm1819Ledger(verified: unknown[]) {
  return buildEvidenceLedger({
    toolCalls: NPM1819_CALLS,
    toolResults: NPM1819_RESULTS,
    certifiedDiffPayloads: [],
    rawDiff: null,
    candidatePaths: [],
    npmPackageComparisons: { schema: "npm-package-comparisons/v1", verified },
    reviewedHeadSha: HEAD,
  });
}

test("#1821 replay: a valid tag-less published-package comparison settles the mandatory release-delta row", () => {
  const ledger = npm1819Ledger([{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" }]);
  assert.equal(ledger.state, "valid");
  const delta = evaluateRowEvidence(npm1819Tags(NPM1819_ROWS[1]!.text), NPM1819_ROWS[1]!.text, ledger);
  assert.equal(delta.state, "receipt-backed");
  assert.deepEqual(delta.receipts.sort(), ["npm-compare:types/node@26.6.10", "npm-compare:types/node@26.6.7"]);
  // The canonical registry documents the phase read also settle provenance…
  const provenance = evaluateRowEvidence(npm1819Tags(NPM1819_ROWS[0]!.text), NPM1819_ROWS[0]!.text, ledger);
  assert.equal(provenance.state, "receipt-backed");
  // …but nothing here checked advisories: that row stays fail-closed, never
  // carried by proximity to the comparison (no manufactured clean verdict).
  const advisory = evaluateRowEvidence(npm1819Tags(NPM1819_ROWS[2]!.text), NPM1819_ROWS[2]!.text, ledger);
  assert.ok(advisory.state === "receipt-absent" || advisory.state === "receipt-mismatch", `advisory must not settle, got ${advisory.state}`);
});

test("#1821 replay negatives: failed, mismatched, and partial comparisons never settle the release-delta row", () => {
  const deltaTag = npm1819Tags(NPM1819_ROWS[1]!.text);
  // (a) The comparison FAILED (registry miss / integrity refusal): the
  // artifact carries nothing, and the run's own tag-era trace settles no
  // delta — the pre-#1821 fail-closed reading stands.
  const failed = evaluateRowEvidence(deltaTag, deltaTag.text, npm1819Ledger([]));
  assert.ok(failed.state === "receipt-absent" || failed.state === "receipt-mismatch", `failed comparison must not settle, got ${failed.state}`);
  // (b) WRONG slug: evidence for another package never speaks about this row.
  const wrongSlug = evaluateRowEvidence(deltaTag, deltaTag.text, npm1819Ledger([{ slug: "types/notes", oldVersion: "26.6.7", newVersion: "26.6.10" }]));
  assert.ok(wrongSlug.state === "receipt-absent" || wrongSlug.state === "receipt-mismatch", `wrong slug must not settle, got ${wrongSlug.state}`);
  // (c) WRONG version pair: provenance still binds (the document is for THIS
  // slug), but the asserted old→new pair never appears — mismatch, not backed.
  const wrongPair = npm1819Ledger([{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.9" }]);
  assert.equal(evaluateRowEvidence(deltaTag, deltaTag.text, wrongPair).state, "receipt-mismatch");
  assert.equal(evaluateRowEvidence(npm1819Tags(NPM1819_ROWS[0]!.text), NPM1819_ROWS[0]!.text, wrongPair).state, "receipt-backed");
  // (d) PARTIAL: an aggregate row naming two packages settles only when EVERY
  // entry's delta is covered — one verified package credits nothing.
  const aggregateRow = {
    text: "inspect the exact old→new upstream release delta for the updated dependency",
    row_class: "objective", gate: "dependency-evidence", obligations: ["release_delta"],
    dependency_scope: [{ slug: "lodash", versions: ["4.17.21", "4.18.0"] }],
  };
  const aggregateTags = checkEvidenceTagsFromArtifact([
    { ...aggregateRow, dependency_scope: [{ slug: "types/node", versions: ["26.6.7", "26.6.10"] }, { slug: "lodash", versions: ["4.17.21", "4.18.0"] }] },
  ]);
  assert.equal(aggregateTags.length, 1);
  const partial = evaluateRowEvidence(aggregateTags[0]!, aggregateRow.text, npm1819Ledger([{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" }]));
  assert.ok(partial.state === "receipt-mismatch" || partial.state === "receipt-absent", `partial coverage must not settle, got ${partial.state}`);
});

// Review of #1825: the artifact reader REJECTS a noncanonical identity field
// rather than case-folding it. The raw manifest spelled `26.6.7-RC1`; npm
// publishes case-sensitively, so folding it here would credit the SEPARATE
// lowercase `26.6.7-rc1` release the run never established — and the scope
// entry (also folded) would match, settling the row for the wrong version.
test("#1821 replay: a noncanonical artifact spelling is rejected, never folded into a settlement", () => {
  const rcScope = [{ slug: "types/node", versions: ["26.6.7-rc1", "26.6.10"] }];
  const deltaRow = { ...NPM1819_ROWS[1]!, dependency_scope: rcScope };
  const [deltaTag] = checkEvidenceTagsFromArtifact([deltaRow]);
  assert.ok(deltaTag !== undefined);
  const folded = npm1819Ledger([{ slug: "types/node", oldVersion: "26.6.7-RC1", newVersion: "26.6.10" }]);
  assert.equal(folded.state, "valid");
  const state = evaluateRowEvidence(deltaTag!, deltaRow.text, folded);
  assert.ok(state.state === "receipt-absent" || state.state === "receipt-mismatch", `a noncanonical entry must not settle, got ${state.state}`);
  // A padded field is not this runtime's record either.
  const padded = npm1819Ledger([{ slug: "types/node", oldVersion: " 26.6.7", newVersion: "26.6.10 " }]);
  assert.ok(evaluateRowEvidence(npm1819Tags(NPM1819_ROWS[1]!.text), NPM1819_ROWS[1]!.text, padded).state !== "receipt-backed");
  // Control: the canonical spelling the producer actually writes still settles.
  const canonical = npm1819Ledger([{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" }]);
  assert.equal(evaluateRowEvidence(npm1819Tags(NPM1819_ROWS[1]!.text), NPM1819_ROWS[1]!.text, canonical).state, "receipt-backed");
});

// Review of #1825 (Major): a no-tool or fork run carries no harness trace, but
// its own deterministic phase still verified the published-package transition —
// the code-owned receipts ride a valid ledger on their own and settle the rows
// they prove. The receipt gate this opens ALSO rejects unsupported positive
// claims on such a run (fail-closed, never laundering); with nothing derived
// the fold stays byte-identical to the inert pre-#1627 case.
function npmNoTraceLedger(verified: readonly unknown[]) {
  return buildEvidenceLedger({
    npmPackageComparisons: { schema: "npm-package-comparisons/v1", verified },
  });
}

function npmNoTraceObligations() {
  const rows = NPM1819_ROWS.map((row, index) => ({ id: `obligation-${index + 1}`, source: "must_check", ...row }));
  const tags = checkEvidenceTagsFromArtifact(NPM1819_ROWS);
  assert.equal(tags.length, NPM1819_ROWS.length);
  return candidateRowsToObligations(rows, NPM1819_ROWS.map((row) => row.text), tags);
}

test("#1821 no-trace replay: the code-owned ledger settles the provenance and release-delta rows end to end", () => {
  const ledger = npmNoTraceLedger([{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" }]);
  assert.equal(ledger.state, "valid");
  const folded = foldObligationDispositions(npmNoTraceObligations(), [], ledger, { readPaths: new Set<string>() });
  for (const id of ["obligation-1", "obligation-2"]) {
    assert.equal(byId(folded, id).status, "satisfied", id);
    assert.equal(byId(folded, id).reason, "dependency-evidence", id);
  }
  // The advisory row was never established by the comparison: it stays
  // unresolved fail-closed, never carried by proximity.
  const advisory = byId(folded, "obligation-3");
  assert.equal(advisory.status, "unresolved");
  assert.ok(advisory.evidence !== undefined && advisory.evidence.state !== "receipt-backed");
  // The #750 completeness fold settles the SAME rows row-for-row.
  const coverage = evaluateRequiredCheckCoverage(
    NPM1819_ROWS.map((row) => row.text),
    null,
    ledger,
    checkEvidenceTagsFromArtifact(NPM1819_ROWS),
  );
  const deltaRow = coverage.checks.find((row) => row.check === NPM1819_ROWS[1]!.text)!;
  assert.equal(deltaRow.status, "satisfied");
  assert.equal(deltaRow.reason, "dependency-evidence");
});

test("#1821 no-trace replay: the activated gate rejects a positive claim the comparison does not prove", () => {
  const ledger = npmNoTraceLedger([{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" }]);
  const folded = foldObligationDispositions(
    npmNoTraceObligations(),
    [{ check: NPM1819_ROWS[2]!.text, status: "satisfied" }],
    ledger,
    { readPaths: new Set<string>() },
  );
  const advisory = byId(folded, "obligation-3");
  assert.equal(advisory.status, "unresolved");
  assert.ok(advisory.reason === "receipt-absent" || advisory.reason === "receipt-mismatch", `got ${advisory.reason}`);
  // The claim the receipts DO prove still discharges through the gate.
  const proven = foldObligationDispositions(
    npmNoTraceObligations(),
    [{ check: NPM1819_ROWS[1]!.text, status: "satisfied" }],
    ledger,
    { readPaths: new Set<string>() },
  );
  assert.equal(byId(proven, "obligation-2").status, "satisfied");
});

test("#1821 no-trace control: nothing derived keeps the fold byte-identical to the inert pre-#1627 case", () => {
  const inert = buildEvidenceLedger({ npmPackageComparisons: { schema: "npm-package-comparisons/v1", verified: [] } });
  assert.equal(inert.state, "unavailable");
  const folded = foldObligationDispositions(
    npmNoTraceObligations(),
    [{ check: NPM1819_ROWS[2]!.text, status: "satisfied" }],
    inert,
    { readPaths: new Set<string>() },
  );
  // With an unavailable ledger the receipt gate never touches the answer.
  assert.equal(byId(folded, "obligation-3").status, "satisfied");
  assert.equal(byId(folded, "obligation-3").reason, "ok");
});

// Review of #1825 (round 11, #1836): the code-owned no-trace ledger activates
// the gate for EVERY objective row, so the run's OTHER recorded facts — a
// certified complete corpus diff — must stay legible to it. A no-tool mixed
// run (verified npm comparison + certified source diff) must not newly read
// its covered source-identity row as missing-receipt, while a row the
// comparison genuinely does not prove stays rejected.
test("#1821/#1836 no-trace mixed replay: certified corpus evidence stays legible to the gate the code-owned receipts open", () => {
  const rawDiff = "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-x\n+y\n";
  const ledger = buildEvidenceLedger({
    npmPackageComparisons: { schema: "npm-package-comparisons/v1", verified: [{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" }] },
    certifiedDiffPayloads: [rawDiff],
    rawDiff,
    candidatePaths: ["src/auth.ts"],
    reviewedHeadSha: HEAD,
  });
  assert.equal(ledger.state, "valid");
  const sourceRow = "check the auth path in src/auth.ts";
  const rows = [...NPM1819_ROWS, { text: sourceRow, row_class: "objective", gate: "source-identity" }];
  const tags = checkEvidenceTagsFromArtifact(rows);
  assert.equal(tags.length, rows.length);
  const obligations = candidateRowsToObligations(
    rows.map((row, index) => ({ id: `obligation-${index + 1}`, source: "must_check", ...row })),
    rows.map((row) => row.text),
    tags,
  );
  const folded = foldObligationDispositions(
    obligations,
    [
      { check: NPM1819_ROWS[1]!.text, status: "satisfied" },
      { check: NPM1819_ROWS[2]!.text, status: "satisfied" },
      { check: sourceRow, status: "satisfied" },
    ],
    ledger,
    { readPaths: new Set<string>() },
  );
  // The code-owned comparison settles the release-delta row.
  assert.equal(byId(folded, "obligation-2").status, "satisfied");
  // The certified corpus diff settles the source-identity row — the exact
  // false-INCOMPLETE the round-10 early return introduced.
  assert.equal(byId(folded, "obligation-4").status, "satisfied");
  // The advisory row stays genuinely unsupported: the shared derivation
  // launders nothing.
  const advisory = byId(folded, "obligation-3");
  assert.equal(advisory.status, "unresolved");
  assert.ok(advisory.reason === "receipt-absent" || advisory.reason === "receipt-mismatch", `got ${advisory.reason}`);
  // The #750 completeness fold agrees row-for-row on the same dispositions.
  const coverage = evaluateRequiredCheckCoverage(rows.map((row) => row.text), [
    { check: NPM1819_ROWS[1]!.text, status: "satisfied", rationale: null },
    { check: NPM1819_ROWS[2]!.text, status: "satisfied", rationale: null },
    { check: sourceRow, status: "satisfied", rationale: null },
  ], ledger, tags);
  assert.equal(coverage.checks.find((row) => row.check === sourceRow)!.status, "satisfied");
  assert.equal(coverage.checks.find((row) => row.check === NPM1819_ROWS[1]!.text)!.status, "satisfied");
  assert.equal(coverage.checks.find((row) => row.check === NPM1819_ROWS[2]!.text)!.status !== "satisfied", true);
});

// ---------------------------------------------------------------------------
// #1822: the per-cell uncovered diagnostic. The aggregate row state
// (receipt-absent / receipt-unverified / receipt-mismatch) cannot say WHICH
// obligation kind × scope entry the validated receipts do not cover; the
// coverage projection now carries the bounded `kind:slug` gap list so an
// unresolved row names the acquisition it still lacks.
// ---------------------------------------------------------------------------

test("#1822: an uncovered dependency row discloses the exact cells its receipts do not cover", () => {
  // (a) WRONG version pair: provenance still binds (the document is for
  // THIS slug) but the asserted old→new pair never appears — the gap names
  // exactly the release-delta cell.
  const deltaTag = npm1819Tags(NPM1819_ROWS[1]!.text);
  const wrongPair = evaluateRowEvidence(deltaTag, deltaTag.text, npm1819Ledger([{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.9" }]));
  assert.equal(wrongPair.state, "receipt-mismatch");
  assert.deepEqual([...wrongPair.uncoveredCells], ["release_delta:types/node"]);
  // (b) A covered row discloses no gap.
  const provenance = evaluateRowEvidence(npm1819Tags(NPM1819_ROWS[0]!.text), NPM1819_ROWS[0]!.text, npm1819Ledger([{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" }]));
  assert.equal(provenance.state, "receipt-backed");
  assert.deepEqual([...provenance.uncoveredCells], []);
  // (c) An aggregate row naming two packages names the UNCOVERED package —
  // not one undifferentiated failure for the whole scope.
  const aggregateTags = checkEvidenceTagsFromArtifact([
    { text: NPM1819_ROWS[1]!.text, row_class: "objective", gate: "dependency-evidence", obligations: ["release_delta"], dependency_scope: [TYPES_NODE[0]!, { slug: "lodash", versions: ["4.17.21", "4.18.0"] }] },
  ]);
  assert.equal(aggregateTags.length, 1);
  const partial = evaluateRowEvidence(aggregateTags[0]!, NPM1819_ROWS[1]!.text, npm1819Ledger([{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" }]));
  assert.equal(partial.state, "receipt-mismatch");
  assert.deepEqual([...partial.uncoveredCells], ["release_delta:lodash"]);
  // (d) The #1819 advisory row's gap names the advisory cell. NO receipt in
  // the run attributes security_advisory (the registry documents the
  // comparison acquired attribute provenance/release_delta), so the state is
  // receipt-absent — and the gap still names the exact cell the run must
  // still acquire, never an undifferentiated failure.
  const advisory = evaluateRowEvidence(npm1819Tags(NPM1819_ROWS[2]!.text), NPM1819_ROWS[2]!.text, npm1819Ledger([{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" }]));
  assert.equal(advisory.state, "receipt-absent");
  assert.deepEqual([...advisory.uncoveredCells], ["security_advisory:types/node"]);
});

test("#1822: the uncovered gap survives the strict obligation artifact reader and refuses malformed shapes", () => {
  const advisoryLedger = npm1819Ledger([{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" }]);
  const rows = NPM1819_ROWS.map((row, index) => ({ id: `obligation-${index + 1}`, source: "must_check", ...row }));
  const tags = checkEvidenceTagsFromArtifact(NPM1819_ROWS);
  const folded = foldObligationDispositions(candidateRowsToObligations(rows, NPM1819_ROWS.map((row) => row.text), tags), [], advisoryLedger, { readPaths: new Set<string>() });
  const readBack = reviewObligationsFromArtifact(reviewObligationsToArtifact(folded, null));
  assert.ok(readBack !== null);
  const advisory = readBack.find((row) => row.id === "obligation-3");
  assert.equal(advisory?.status, "unresolved");
  assert.deepEqual([...advisory?.evidence?.uncoveredCells ?? []], ["security_advisory:types/node"]);
  // A hand-edited gap list this runtime did not write refuses the artifact.
  const corrupted = reviewObligationsToArtifact(folded, null);
  const advisoryRow = (corrupted.obligations as Array<Record<string, unknown>>).find((row) => row.id === "obligation-3");
  assert.ok(advisoryRow !== undefined);
  advisoryRow.evidence = { ...(advisoryRow.evidence as Record<string, unknown>), uncovered_cells: "security_advisory" };
  assert.equal(reviewObligationsFromArtifact(corrupted), null);
});
