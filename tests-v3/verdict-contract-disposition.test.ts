import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDispositionEvidence, type DispositionEvidenceParts } from "../src/disposition/engine-evidence.js";
import {
  MATERIAL_CODE_CLAUSES,
  MATERIAL_DISPOSITION_CODES,
  computeFinalDisposition,
  dispositionEvidence,
  parseFinalDisposition,
  type FinalDispositionInput,
} from "../src/disposition/final.js";
import { applyRequirementTraceFragment } from "../src/prompt/system-prompt.js";
import { workspaceAt } from "../src/prompt/index.js";
import { BUNDLED_PROMPT_ASSETS } from "../src/prompt/assets.js";

// ---------------------------------------------------------------------------
// #1678 — the verdict-contract disposition feed and prompt-scoping seams.
// The exact-set requirement-decision contract failing on the authoritative
// closing verdict rides its OWN material code (`verdict_contract_incomplete`,
// distinct from the trace's per-row `mandatory_requirement_unresolved`), and
// a deterministic trace scope rewrites the default ledger sentence so the
// prompt demands exactly the set the contract validates.
// ---------------------------------------------------------------------------

/** Clean engine baseline identical in shape to final-disposition.test.ts's
 * DISPOSITION_BASE: every deterministic part silent. */
function parts(overrides: Partial<DispositionEvidenceParts> = {}): DispositionEvidenceParts {
  return {
    completenessChecks: [],
    obligations: [],
    findings: [],
    toolCapabilityFailure: null,
    toolFloorUnmet: false,
    noEvidenceReason: null,
    partialCoverageStopReason: null,
    traceUnresolvedMaterial: false,
    traceUnmetClaimed: false,
    mechanicallyProvenUnmetRequirements: 0,
    ciConclusion: null,
    ciEvidenceContractActive: false,
    ...overrides,
  };
}

/** Certified-eligible approve baseline (the composition final-disposition.test.ts
 * uses: engine build wired into the disposition's evidence seam). */
function input(overrides: Partial<FinalDispositionInput> = {}): FinalDispositionInput {
  return {
    reviewProduced: true,
    validVerdict: true,
    verdict: "approve",
    degraded: false,
    exactHead: true,
    publicationHeadBound: true,
    blockingFindingOpen: false,
    evidenceProviderBlocker: false,
    provenUnmetRequirement: false,
    verdictBearing: true,
    approvalScopeAllowed: true,
    evidence: [],
    ...overrides,
  };
}

function dispositions(inputOverrides: Partial<FinalDispositionInput>, partsOverrides: Partial<DispositionEvidenceParts> = {}) {
  const build = buildDispositionEvidence(parts(partsOverrides));
  return {
    build,
    disposition: computeFinalDisposition(input({ evidence: build.evidence, provenUnmetRequirement: build.provenUnmetRequirement, ...inputOverrides })),
  };
}

const CONTRACT_SUBJECT = "verdict-contract:requirement-rows-incomplete";

// ── A. disposition feed ─────────────────────────────────────────────

test("#1678: verdictContractIncomplete feeds its own MATERIAL code and withholds an otherwise-certified APPROVE", () => {
  // Clean baseline first: the same composition certifies APPROVE.
  const clean = dispositions({});
  assert.deepEqual(clean.build.evidence, []);
  assert.equal(clean.disposition.kind, "approve");

  const flagged = dispositions({}, { verdictContractIncomplete: true });
  assert.deepEqual(flagged.build.evidence, [
    { code: "verdict_contract_incomplete", ruledBy: "deterministic", materiality: "material", subject: CONTRACT_SUBJECT },
  ]);
  assert.equal(flagged.build.provenUnmetRequirement, false);
  assert.equal(flagged.disposition.kind, "incomplete");
  assert.equal(flagged.disposition.reason, "material_unknown");
  assert.equal(flagged.disposition.nativeEvent, "COMMENT");
  assert.equal(flagged.disposition.approvalCertified, false);
  assert.deepEqual(flagged.disposition.materialUnknowns.map((entry) => entry.code), ["verdict_contract_incomplete"]);
  // The serialized artifact round-trips: the new code is in the closed
  // material vocabulary the fail-closed parser accepts.
  assert.equal(parseFinalDisposition(JSON.parse(JSON.stringify(flagged.disposition)))?.kind, "incomplete");
});

test("#1678: absent or false verdictContractIncomplete feeds nothing (pre-#1678 callers unchanged)", () => {
  const baseline = buildDispositionEvidence(parts()).evidence;
  for (const overrides of [{}, { verdictContractIncomplete: false }] satisfies Partial<DispositionEvidenceParts>[]) {
    const build = buildDispositionEvidence(parts(overrides));
    assert.deepEqual(build.evidence, baseline);
    const disposition = computeFinalDisposition(input({ evidence: build.evidence, provenUnmetRequirement: build.provenUnmetRequirement }));
    assert.equal(disposition.kind, "approve");
    assert.equal(disposition.materialUnknowns.length, 0);
  }
});

test("#1678: the code is in MATERIAL_DISPOSITION_CODES and its material entry forces INCOMPLETE with the serialization prose", () => {
  assert.ok((MATERIAL_DISPOSITION_CODES as readonly string[]).includes("verdict_contract_incomplete"));
  assert.match(MATERIAL_CODE_CLAUSES.verdict_contract_incomplete, /did not decide every required requirement/);
  const disposition = computeFinalDisposition(input({
    evidence: [dispositionEvidence("verdict_contract_incomplete", "deterministic", "material", CONTRACT_SUBJECT)],
  }));
  assert.equal(disposition.kind, "incomplete");
  assert.equal(disposition.reason, "material_unknown");
  assert.equal(disposition.nativeEvent, "COMMENT");
  assert.ok(disposition.recommendation.includes(MATERIAL_CODE_CLAUSES.verdict_contract_incomplete));
  assert.ok(disposition.statement.includes("did not decide every required requirement"));
});

test("#1678: the contract code co-exists with the trace's material unknown — distinct reasons, neither replaces the other", () => {
  const { build, disposition } = dispositions({}, { verdictContractIncomplete: true, traceUnresolvedMaterial: true });
  assert.deepEqual(build.evidence.map((entry) => [entry.code, entry.materiality, entry.subject]), [
    ["mandatory_requirement_unresolved", "material", "requirement-trace:unresolved-material"],
    ["verdict_contract_incomplete", "material", CONTRACT_SUBJECT],
  ]);
  assert.equal(disposition.kind, "incomplete");
  assert.deepEqual(disposition.materialUnknowns.map((entry) => entry.code), [
    "mandatory_requirement_unresolved",
    "verdict_contract_incomplete",
  ]);
});

// ── B. prompt scoping ───────────────────────────────────────────────

/** The default ledger sentence `applyRequirementTraceFragment` rewrites when
 * a deterministic trace scope exists (#1678). Derived from the BUNDLED ledger
 * fragment itself so the drift pin below cannot silently pass on a stale
 * literal. */
const LEDGER_SENTENCE = "Every requirement in the Requirement Ledger must be assessed in requirement_coverage.";
const SCOPED_SENTENCE =
  "Every requirement named in the trace scope or in the Required requirement decisions block must be assessed in requirement_coverage; no other requirement may carry a coverage row.";
const TRACE_ANCHOR = "For every acceptance/normative requirement in trace scope,";
const TRACE_ROW_MARKER = "carries EXACTLY one row";
const SCOPE_ID = "req-000000000001";

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** #935-fixture shape: a temp run workspace with the requirement-ledger
 * presence file, plus a default-prompt state carrying the real bundled ledger
 * guidance (the sentence `applySystemPromptFragments` composes in production). */
function promptFixture(): { dir: string; state: { systemPrompt: string; isDefault: boolean; addendum: string } } {
  const dir = mkdtempSync(join(tmpdir(), "verdict-contract-prompt-"));
  writeFileSync(join(dir, "requirement-ledger-present.txt"), "1\n");
  return {
    dir,
    state: { systemPrompt: `BASE\n${BUNDLED_PROMPT_ASSETS.fragments.requirement_ledger}`, isDefault: true, addendum: "" },
  };
}

test("#1678: a deterministic trace scope replaces the default ledger sentence with the scoped-set sentence", () => {
  // The replace anchor must keep matching the real bundled ledger fragment's
  // first sentence — otherwise the scoping silently no-ops.
  assert.ok(BUNDLED_PROMPT_ASSETS.fragments.requirement_ledger!.startsWith(LEDGER_SENTENCE));
  const { dir, state } = promptFixture();
  try {
    const scoped = applyRequirementTraceFragment(state, workspaceAt(dir), true, undefined, [SCOPE_ID]);
    assert.ok(scoped.systemPrompt.includes(SCOPED_SENTENCE), "scoped ledger sentence present");
    assert.ok(!scoped.systemPrompt.includes(LEDGER_SENTENCE), "default ledger sentence replaced");
    assert.equal(countOccurrences(scoped.systemPrompt, "Required requirement decisions"), 1);
    // Idempotent like the other appended fragments: applying the scoped
    // guidance twice appends the trace fragment once.
    const twice = applyRequirementTraceFragment(scoped, workspaceAt(dir), true, undefined, [SCOPE_ID]);
    assert.equal(countOccurrences(twice.systemPrompt, TRACE_ROW_MARKER), 1);
    assert.equal(countOccurrences(twice.systemPrompt, "Required requirement decisions"), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1681 pin: empty trace scope still feeds no trace guidance at all (#935 behavior)", () => {
  const { dir, state } = promptFixture();
  try {
    const scoped = applyRequirementTraceFragment(state, workspaceAt(dir), true, undefined, []);
    assert.equal(scoped.systemPrompt, state.systemPrompt);
    assert.ok(!scoped.systemPrompt.includes(TRACE_ROW_MARKER));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1678: undefined scope keeps the default ledger sentence byte-identical for unscoped runs", () => {
  const { dir, state } = promptFixture();
  try {
    const unscoped = applyRequirementTraceFragment(state, workspaceAt(dir), true);
    assert.ok(unscoped.systemPrompt.includes(LEDGER_SENTENCE), "default ledger sentence not replaced");
    assert.ok(!unscoped.systemPrompt.includes("Required requirement decisions"));
    // The trace fragment appends with its unscoped anchor intact.
    assert.ok(unscoped.systemPrompt.includes(TRACE_ANCHOR));
    assert.equal(unscoped.systemPrompt.slice(0, state.systemPrompt.length), state.systemPrompt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1681 drift pin: the rewritten trace fragment teaches only satisfied/violated/unknown and keeps the scoping anchor", () => {
  const fragment = BUNDLED_PROMPT_ASSETS.fragments.requirement_trace!;
  // The .replace hook in applyRequirementTraceFragment must keep matching:
  // the fragment still STARTS with the anchor sentence.
  assert.ok(fragment.startsWith(TRACE_ANCHOR));
  // Only the three requirement_coverage statuses are taught.
  for (const status of ["satisfied", "violated", "unknown"]) assert.ok(fragment.includes(status));
  // The #1681 rewrite dropped every token the verdict contract no longer
  // recognizes — exact tokens, case-sensitive.
  for (const stale of ["disposition", "enforcement", "not_applicable", "unverifiable"]) {
    assert.ok(!fragment.includes(stale), `fragment must not teach stale token ${stale}`);
  }
  // With a scope, the substituted sentence still lands (the hook fires on
  // the live fragment, not a stale copy).
  const { dir, state } = promptFixture();
  try {
    const scoped = applyRequirementTraceFragment(state, workspaceAt(dir), true, undefined, [SCOPE_ID]);
    assert.ok(scoped.systemPrompt.includes(`For every requirement in trace scope (${SCOPE_ID}); other ledger requirements need no trace,`));
    assert.ok(!scoped.systemPrompt.includes(TRACE_ANCHOR));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
