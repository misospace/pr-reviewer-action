import test from "node:test";
import assert from "node:assert/strict";
import { Conversation } from "../src/model/conversation.js";
import {
  STOP_MAX_ROUNDS,
  STOP_MODEL_DONE,
  STOP_OBLIGATIONS_SETTLED,
  adaptiveLoopBudgets,
  driveToolLoop,
  type DependencyEvidenceObligation,
} from "../src/tools/loop.js";
import {
  parseLoopSettlements,
  settlementsToArtifact,
  type LoopEvidenceSettlement,
} from "../src/enforcement/settlement.js";
import { foldObligationDispositions, candidateRowsToObligations, reviewObligationsFromArtifact, reviewObligationsToArtifact, unresolvedReviewObligations } from "../src/enforcement/review-obligations.js";
import { evaluateRequiredCheckCoverage } from "../src/enforcement/required-checks.js";
import { executedCallEvidenceIndex, type ExecutedCallEvidenceIndex } from "../src/enforcement/executed-calls.js";
import { buildDispositionEvidence } from "../src/disposition/engine-evidence.js";
import { computeFinalDisposition } from "../src/disposition/final.js";
import { harnessEvidenceDigest } from "../src/requirements/trace-repair.js";
import { insertProofIndexSection, standardCorpusProofIndexSection, verdictProofIndexSection } from "../src/tools/harness.js";

// ---------------------------------------------------------------------------
// #1659 — ONE canonical evidence-settlement record shared by the native
// loop's investigation stopping and final publication completeness. The
// loop's terminal state per tracked question rides the record; finalization
// defers to a loop-settled row's receipts instead of re-deriving with a
// second, incompatible citation vocabulary; a cap/budget release is NEVER a
// semantic settlement (a cap-released material question becomes a named
// material unknown; a cap-released advisory question never vetoes).
// ---------------------------------------------------------------------------

const openAiCall = (id: string, name: string, args: string) => ({
  choices: [{ message: { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] } }],
});
const openAiText = (text: string) => ({ choices: [{ message: { content: text } }] });

function recordingLoop(responses: unknown[], execStatus: "ok" | "error" = "ok") {
  let responseIndex = 0;
  const executedCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const postFn = async () => responses[responseIndex++];
  const executeFn = async (tool: string, args: Record<string, unknown>) => {
    executedCalls.push({ tool, args });
    return execStatus === "ok"
      ? { tool, status: "ok", result: { content: "body" } }
      : { tool, status: "error", result: { error: "fetch failed" } };
  };
  const timeFn = () => Number.MAX_SAFE_INTEGER / 2;
  return { postFn, executeFn, timeFn, executedCalls };
}

const recordingTime = () => (() => Number.MAX_SAFE_INTEGER / 2);

const depRows = (reserve: number): Array<{ id: string; tokens: readonly string[]; obligation: DependencyEvidenceObligation }> =>
  (["provenance", "release_delta", "security_advisory"] as const).slice(0, reserve).map((obligation) => ({
    id: obligation,
    tokens: [],
    obligation,
  }));

const settlement = (overrides: Partial<Omit<LoopEvidenceSettlement, "source">> & { source?: "must_check" | "trusted_base_guidance" | "derived" | "risk" | undefined } = {}): LoopEvidenceSettlement => {
  const { source, ...rest } = overrides;
  return {
    id: "obligation-1",
    kind: "prose",
    materiality: "material",
    source: "must_check",
    settledVia: "discharged",
    successfulAttempt: true,
    admittedBy: ["call-1"],
    successfulBy: ["call-1"],
    acquisition: "available",
    ...rest,
    ...(source !== undefined ? { source } : {}),
  };
};

// ---------------------------------------------------------------------------
// the record module: serializer + fail-closed reader.
// ---------------------------------------------------------------------------

test("#1659: settlement record round-trips through the artifact shape", () => {
  const rows: LoopEvidenceSettlement[] = [
    settlement(),
    settlement({ id: "provenance", kind: "dependency", source: undefined, admittedBy: ["call-2", "call-5"], successfulBy: ["call-5"] }),
    settlement({ id: "trace:req-1", kind: "trace", source: undefined, settledVia: "open", successfulAttempt: false, admittedBy: [], successfulBy: [], acquisition: "unavailable" }),
  ];
  const parsed = parseLoopSettlements(settlementsToArtifact(rows));
  assert.deepEqual(parsed, rows);
});

test("#1659: the reader is fail-closed — malformed rows are dropped, never repaired", () => {
  assert.deepEqual(parseLoopSettlements(null), []);
  assert.deepEqual(parseLoopSettlements(undefined), []);
  assert.deepEqual(parseLoopSettlements("nope"), []);
  assert.deepEqual(parseLoopSettlements({ id: "obligation-1" }), []);
  // Each malformed row drops WHOLE; its neighbors keep. A receipt id that
  // does not match the shared `call-<n>` scheme drops the row too — a
  // record naming ids the artifact's own trace cannot contain is never
  // trusted.
  assert.deepEqual(
    parseLoopSettlements([
      null,
      {},
      settlement({ id: "" }),
      { ...settlementsToArtifact([settlement()])[0]!, kind: "invented-kind" },
      { ...settlementsToArtifact([settlement()])[0]!, settled_via: "settled-clean" },
      { ...settlementsToArtifact([settlement()])[0]!, successful_attempt: "yes" },
      { ...settlementsToArtifact([settlement()])[0]!, admitted_by: ["call-1", 7] },
      { ...settlementsToArtifact([settlement()])[0]!, admitted_by: ["nonsense"] },
      { ...settlementsToArtifact([settlement()])[0]!, successful_by: ["fetch-1"] },
      { ...settlementsToArtifact([settlement()])[0]!, acquisition: "partial" },
      settlementsToArtifact([settlement()])[0],
    ]),
    [settlement()],
  );
});

// ---------------------------------------------------------------------------
// the loop side: the record is written on every exit path.
// ---------------------------------------------------------------------------

test("#1659: a settled stop records discharged rows with their admitting call receipts", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Both dependency rows are discharged by admitted, successful calls
  // (the provenance fetch credits provenance, the releases fetch
  // release_delta) — the settled stop fires and the record carries each
  // row's receipt.
  const { postFn, executeFn } = recordingLoop([
    openAiCall("c1", "web_fetch", '{"url":"https://github.com/owner/repo"}'),
    openAiCall("c2", "web_fetch", '{"url":"https://upstream.test/releases"}'),
  ]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 4, 120),
    reserveForRequiredEvidence: 2,
    requiredEvidence: depRows(2),
    timeFn: recordingTime(),
  });
  assert.equal(outcome.stopReason, STOP_OBLIGATIONS_SETTLED);
  assert.deepEqual(outcome.requiredEvidenceSettlements, [
    { id: "provenance", kind: "dependency", materiality: "material", settledVia: "discharged", successfulAttempt: true, admittedBy: ["call-1"], successfulBy: ["call-1"], acquisition: "available" },
    { id: "release_delta", kind: "dependency", materiality: "material", settledVia: "discharged", successfulAttempt: true, admittedBy: ["call-2"], successfulBy: ["call-2"], acquisition: "available" },
  ]);
});

test("#1659: a cap-released row is recorded as `cap-released`, never discharged", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // The #1379 no-lockout shape: one pre-window read, then three gated
  // evidence fetches of unattributed hosts on budget 4/reserve 3. Nothing
  // is admitted to any row, the attempts cap fires, and the window
  // releases — the record says `cap-released` (the budget release it is,
  // never a semantic settlement) with acquisition `unavailable` (the
  // successful fetches admitted to no row).
  const { postFn, executeFn } = recordingLoop([
    openAiCall("c1", "read_file", '{"path":"a.ts"}'),
    openAiCall("c2", "web_fetch", '{"url":"https://unrelated.test/a"}'),
    openAiCall("c3", "web_fetch", '{"url":"https://nowhere.test/b"}'),
    openAiCall("c4", "web_fetch", '{"url":"https://elsewhere.test/c"}'),
  ]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 4, 120),
    reserveForRequiredEvidence: 3,
    requiredEvidence: depRows(3),
    timeFn: recordingTime(),
  });
  assert.deepEqual(outcome.requiredEvidenceCredits, []);
  assert.equal(outcome.requiredEvidenceWindowAttempts, 3);
  for (const row of outcome.requiredEvidenceSettlements) {
    assert.equal(row.settledVia, "cap-released");
    assert.equal(row.kind, "dependency");
    assert.equal(row.materiality, "material");
    assert.equal(row.successfulAttempt, false);
    assert.deepEqual(row.admittedBy, []);
    assert.deepEqual(row.successfulBy, []);
    assert.equal(row.acquisition, "unavailable");
  }
});

test("#1659: a row discharged by a FAILED admitted attempt records acquisition `failed` (the #1627 M1 shape)", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // A dependency row's admission discharges it executor-status-agnostically
  // (an attempt is the discharge), so the record must expose the shape the
  // M1 stranding guard suppresses the settled stop for: a discharged row
  // whose every admitted attempt failed — never readable as "evidence
  // available".
  const { postFn, executeFn } = recordingLoop([
    openAiCall("c1", "web_fetch", '{"url":"https://github.com/owner/repo"}'),
    openAiText("done"),
  ], "error");
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(2, 4, 120),
    reserveForRequiredEvidence: 1,
    requiredEvidence: depRows(1),
    timeFn: recordingTime(),
  });
  assert.deepEqual(outcome.requiredEvidenceCredits, ["provenance"]);
  const row = outcome.requiredEvidenceSettlements[0]!;
  assert.equal(row.settledVia, "discharged");
  assert.equal(row.successfulAttempt, false);
  assert.deepEqual(row.admittedBy, ["call-1"]);
  assert.deepEqual(row.successfulBy, []);
  assert.equal(row.acquisition, "failed");
});

test("#1659: a budget/rounds stop records rows the loop never settled as `open` with truthful acquisition", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // The hostile-model shape: every turn optional, nothing ever targets the
  // rows. The loop stops on rounds with the rows open — and the record's
  // acquisition is `unavailable`, NOT evidence the reviewer "checked".
  const responses = Array.from({ length: 6 }, (_, i) => openAiCall(`c${i}`, "read_file", `{"path":"misc/${i}.md"}`));
  const { postFn, executeFn } = recordingLoop(responses);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(3, 6, 120),
    reserveForRequiredEvidence: 3,
    requiredEvidence: depRows(3),
    timeFn: recordingTime(),
  });
  assert.equal(outcome.stopReason, STOP_MAX_ROUNDS);
  assert.equal(outcome.requiredEvidenceSettlements.length, 3);
  for (const row of outcome.requiredEvidenceSettlements) {
    assert.equal(row.settledVia, "open");
    assert.equal(row.successfulAttempt, false);
    assert.deepEqual(row.admittedBy, []);
    assert.deepEqual(row.successfulBy, []);
    assert.equal(row.acquisition, "unavailable");
  }
});

test("#1659: a prose row's record derives materiality from its obligation source", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // The must_check row discharges on its admitted read; the guidance row is
  // never targeted and stays open (a single discharge must not settle the
  // surface — the loop keeps its pre-#1659 stop behavior exactly).
  const { postFn, executeFn } = recordingLoop([
    openAiCall("c1", "read_file", '{"path":"docs/talos-matrix.md"}'),
    openAiText("done"),
  ]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 6, 120),
    reserveForRequiredEvidence: 2,
    requiredEvidence: [
      { id: "obligation-1", tokens: ["talos", "matrix"], source: "must_check" },
      { id: "obligation-2", tokens: ["advisory", "guidance"], source: "trusted_base_guidance" },
    ],
    timeFn: recordingTime(),
  });
  assert.equal(outcome.stopReason, STOP_MODEL_DONE);
  assert.deepEqual(outcome.requiredEvidenceSettlements.map((row) => [row.id, row.kind, row.materiality, row.settledVia, row.acquisition]), [
    ["obligation-1", "prose", "material", "discharged", "available"],
    ["obligation-2", "prose", "advisory", "open", "unavailable"],
  ]);
});

// ---------------------------------------------------------------------------
// finalization defers to the loop's settlement (#1659 acceptance: a row
// reported settled by the loop cannot later become unresolved solely
// because finalization uses a different citation allocator).
// ---------------------------------------------------------------------------

const citationTexts = [
  "check exact version bump recorded in package-lock.json",
  "check exact upstream provenance recorded in package-lock.json",
];

function foldFixture() {
  const obligations = candidateRowsToObligations([], citationTexts);
  const executedCalls: ExecutedCallEvidenceIndex = {
    gate: true,
    refused: false,
    entries: [
      { id: "call-1", ok: true, tool: "read_file", target: "package-lock.json" },
      { id: "call-2", ok: true, tool: "read_file", target: "unrelated.md" },
    ],
  };
  return { obligations, executedCalls };
}

test("#1659: an allocator-only refusal cannot flip a loop-settled row — the fold defers to the receipt", () => {
  const { obligations, executedCalls } = foldFixture();
  const dispositions = [
    // Both rows cite call-1; the allocator assigns it once and marks the
    // OTHER row `citation-already-used` (the allocation lands on the second
    // row here). The loop's settlement record shows the shared row
    // discharged with a successful admitted call — the terminal settlement
    // stands.
    { check: citationTexts[0]!, status: "satisfied", rationale: "the lockfile read at call-1 shows the bump" },
    { check: citationTexts[1]!, status: "satisfied", rationale: "the lockfile read at call-1 shows the provenance" },
  ];
  const settlements = new Map([
    ["obligation-1", settlement()],
    ["obligation-2", settlement({ id: "obligation-2", admittedBy: ["call-1"] })],
  ]);
  const folded = foldObligationDispositions(obligations, dispositions, executedCalls, undefined, settlements);
  assert.deepEqual(folded.map((row) => [row.status, row.reason]), [["satisfied", "ok"], ["satisfied", "ok"]]);
  assert.deepEqual(folded[0]!.settledBy, { kind: "loop-settlement", call: "call-1" });
  assert.equal(folded[1]!.settledBy, undefined, "an allocator-ASSIGNED row carries no deferral receipt");
  assert.equal(unresolvedReviewObligations(folded).length, 0);
});

test("#1659: an UNCITED satisfaction never defers — a prose-only claim is not credit, receipt or no receipt", () => {
  const { obligations, executedCalls } = foldFixture();
  const dispositions = [
    { check: citationTexts[0]!, status: "satisfied", rationale: "verified by reading the lockfile — no id cited" },
  ];
  const settlements = new Map([["obligation-1", settlement()]]);
  const folded = foldObligationDispositions(obligations, dispositions, executedCalls, undefined, settlements);
  assert.equal(folded[0]!.status, "unresolved");
  assert.equal(folded[0]!.reason, "uncited-satisfaction");
  assert.equal(folded[0]!.settledBy, undefined);
});

test("#1659: no deferral without a successful admitted call — cap-released, open, and absent records fail closed", () => {
  const { obligations, executedCalls } = foldFixture();
  // Both rows cite call-1; the allocator assigns it to the second row, so
  // the FIRST row lands `shared`. Only a `discharged` settlement with a
  // SUCCESSFUL admitted call defers it — cap-released/open/no-success
  // records keep failing closed.
  const dispositions = [
    { check: citationTexts[0]!, status: "satisfied", rationale: "the lockfile read at call-1 shows the bump" },
    { check: citationTexts[1]!, status: "satisfied", rationale: "the lockfile read at call-1 shows the provenance" },
  ];
  for (const record of [
    settlement({ settledVia: "cap-released", successfulBy: [] }),
    settlement({ settledVia: "open" }),
    settlement({ successfulBy: [] }),
    settlement({ admittedBy: [], successfulBy: [] }),
  ]) {
    const folded = foldObligationDispositions(obligations, dispositions, executedCalls, undefined, new Map([["obligation-1", record]]));
    assert.equal(folded[0]!.status, "unresolved", `settledVia=${record.settledVia} must not defer`);
    assert.equal(folded[0]!.reason, "citation-already-used");
    assert.equal(folded[0]!.settledBy, undefined);
  }
  // Legacy: no record at all — byte-identical pre-#1659 behavior.
  const legacy = foldObligationDispositions(obligations, dispositions, executedCalls);
  assert.equal(legacy[0]!.status, "unresolved");
  assert.equal(legacy[0]!.reason, "citation-already-used");
});

test("#1659: a refused/unparseable trace never defers, even with a discharged settlement", () => {
  const { obligations } = foldFixture();
  const refused: ExecutedCallEvidenceIndex = { gate: true, refused: true, entries: [] };
  const dispositions = [{ check: citationTexts[0]!, status: "satisfied", rationale: "verified at call-1" }];
  const settlements = new Map([["obligation-1", settlement()]]);
  const folded = foldObligationDispositions(obligations, dispositions, refused, undefined, settlements);
  assert.equal(folded[0]!.status, "unresolved");
  assert.equal(folded[0]!.reason, "malformed-executed-trace");
});

test("#1659: an UNRELATED executed call never defers — the deterministic identity refusal stands, receipt or no receipt", () => {
  const { obligations, executedCalls } = foldFixture();
  // The lockfile row cites call-2, whose target (unrelated.md) cannot bind
  // to the row's identity — the allocator refuses with `unrelated`. Even a
  // discharged settlement with a successful admitted call must NOT flip it:
  // a real identity objection is never a bookkeeping disagreement.
  const dispositions = [{ check: citationTexts[0]!, status: "satisfied", rationale: "the read at call-2 confirms it" }];
  const settlements = new Map([["obligation-1", settlement()]]);
  const folded = foldObligationDispositions(obligations, dispositions, executedCalls, undefined, settlements);
  assert.equal(folded[0]!.status, "unresolved");
  assert.equal(folded[0]!.reason, "unrelated-executed-call");
  assert.equal(folded[0]!.settledBy, undefined);
});

test("#1659: the #750 completeness fold defers on the same rows the obligation fold defers", () => {
  const { executedCalls } = foldFixture();
  const dispositions = [
    { check: citationTexts[0]!, status: "satisfied", rationale: "the lockfile read at call-1 shows the bump" },
    { check: citationTexts[1]!, status: "satisfied", rationale: "the lockfile read at call-1 shows the provenance" },
  ];
  const byCheck = new Map([
    [citationTexts[0]!, settlement()],
    [citationTexts[1]!, settlement({ id: "obligation-2", admittedBy: ["call-1"] })],
  ]);
  const coverage = evaluateRequiredCheckCoverage(citationTexts, dispositions as never, executedCalls, byCheck);
  assert.equal(coverage.status, "complete");
  assert.deepEqual(coverage.checks.map((row) => [row.status, row.reason]), [["satisfied", "ok"], ["satisfied", "ok"]]);
  // The shared row carries the deferral receipt; the assigned one does not.
  assert.deepEqual(coverage.checks[0]!.settledBy, { kind: "loop-settlement", call: "call-1" });
  assert.equal(coverage.checks[1]!.settledBy, undefined);
  // Without the record the same inputs stay incomplete (pre-#1659).
  const legacy = evaluateRequiredCheckCoverage(citationTexts, dispositions as never, executedCalls);
  assert.equal(legacy.status, "incomplete");
});

test("#1659: the obligation artifact round-trips the deferral receipt through the strict reader", () => {
  const rows = [
    {
      id: "obligation-1",
      source: "must_check" as const,
      text: citationTexts[0]!,
      status: "satisfied" as const,
      cause: null,
      reason: "ok" as const,
      settledBy: { kind: "loop-settlement" as const, call: "call-1" },
    },
  ];
  const artifact = reviewObligationsToArtifact(rows as never);
  assert.deepEqual(reviewObligationsFromArtifact(artifact), rows);
  // A malformed receipt refuses the WHOLE artifact (never a half-trusted row).
  (artifact.obligations as Record<string, unknown>[])[0]!["settled_by"] = { kind: "invented", call: "call-1" };
  assert.equal(reviewObligationsFromArtifact(artifact), null);
  (artifact.obligations as Record<string, unknown>[])[0]!["settled_by"] = { kind: "loop-settlement", call: "call-x" };
  assert.equal(reviewObligationsFromArtifact(artifact), null);
});

// ---------------------------------------------------------------------------
// the disposition consumes the record (#1659 acceptance: a cap-released
// material auth/security question becomes INCOMPLETE/material-unknown, never
// "settled clean"; a cap-released non-material advisory does not veto).
// ---------------------------------------------------------------------------

function dispositionParts(overrides: Partial<Parameters<typeof buildDispositionEvidence>[0]> = {}) {
  return {
    completenessChecks: [],
    obligations: [],
    findings: [],
    toolCapabilityFailure: null,
    toolFloorUnmet: false,
    noEvidenceReason: null,
    partialCoverageStopReason: null,
    requirementTraceIncomplete: false,
    mechanicallyProvenUnmetRequirements: 0,
    ciConclusion: null,
    ciEvidenceContractActive: false,
    ...overrides,
  };
}

test("#1659: a cap-released MATERIAL question is a material unknown even when everything else is clean", () => {
  const build = buildDispositionEvidence(dispositionParts({
    loopSettlements: [
      settlement({ id: "security_advisory", kind: "dependency", source: undefined, settledVia: "cap-released", successfulAttempt: false, admittedBy: [], acquisition: "unavailable" }),
    ],
  }));
  assert.deepEqual(build.evidence.map((entry) => [entry.code, entry.materiality]), [["investigation_unavailable", "material"]]);
  assert.equal(build.provenUnmetRequirement, false);
  // The disposition withholds: an otherwise-clean approve plus this
  // material unknown is INCOMPLETE, never a certified "settled clean".
  const disposition = computeFinalDisposition({
    reviewProduced: true,
    validVerdict: true,
    verdict: "approve",
    degraded: false,
    exactHead: true,
    publicationHeadBound: true,
    blockingFindingOpen: false,
    evidenceProviderBlocker: false,
    provenUnmetRequirement: build.provenUnmetRequirement,
    verdictBearing: true,
    approvalScopeAllowed: true,
    evidence: build.evidence,
  });
  assert.equal(disposition.kind, "incomplete");
});

test("#1659: a cap-released ADVISORY question never vetoes the approval", () => {
  const build = buildDispositionEvidence(dispositionParts({
    loopSettlements: [
      settlement({ id: "obligation-9", source: "trusted_base_guidance", materiality: "advisory", settledVia: "cap-released", successfulAttempt: false, admittedBy: [], acquisition: "unavailable" }),
    ],
  }));
  assert.deepEqual(build.evidence.map((entry) => [entry.code, entry.materiality]), [["investigation_unavailable", "advisory"]]);
  const disposition = computeFinalDisposition({
    reviewProduced: true,
    validVerdict: true,
    verdict: "approve",
    degraded: false,
    exactHead: true,
    publicationHeadBound: true,
    blockingFindingOpen: false,
    evidenceProviderBlocker: false,
    provenUnmetRequirement: build.provenUnmetRequirement,
    verdictBearing: true,
    approvalScopeAllowed: true,
    evidence: build.evidence,
  });
  assert.equal(disposition.kind, "approve");
});

test("#1659: a cap-released row the fold resolved satisfied feeds nothing, and trace-kind rows stay with the trace question", () => {
  const obligations = candidateRowsToObligations([], citationTexts).map((row) => ({ ...row, status: "satisfied" as const }));
  assert.deepEqual(
    buildDispositionEvidence(dispositionParts({
      obligations,
      loopSettlements: [settlement()],
    })).evidence,
    [],
  );
  assert.deepEqual(
    buildDispositionEvidence(dispositionParts({
      loopSettlements: [settlement({ id: "trace:req-1", kind: "trace", source: undefined, settledVia: "cap-released" })],
    })).evidence,
    [],
  );
});

// ---------------------------------------------------------------------------
// the evidence contract for verdict producers (#1659 acceptance: a fallback
// verdict receives ALL objective evidence identifiers/content it is required
// to reference — no unseen call-N contract).
// ---------------------------------------------------------------------------

test("#1659: the proof index shows every executed call id the enforcement folds can verify — no unseen call-N", () => {
  // The fallback tier runs the SAME native loop and the SAME
  // `runNativeLoop` verdict-corpus injection (tier only picks the corpus
  // file), so this pin holds for every producer tier.
  const outcome = {
    executed: [
      { tool: "read_file", args: { path: "a.ts" }, result: { status: "ok", result: {} } },
      { tool: "web_fetch", args: { url: "https://upstream.test/releases" }, result: { status: "ok", result: {} } },
      { tool: "gh_api", args: { endpoint: "/repos/o/r" }, result: { status: "error", result: { error: "x" } } },
    ],
  } as never as Parameters<typeof verdictProofIndexSection>[1];
  const rows = [{ id: "obligation-1", text: "check the lockfile" }];
  const section = verdictProofIndexSection(rows, outcome);
  // Every executed call appears with the EXACT id the enforcement-side
  // evidence index parses back from the artifact's tool_calls trace.
  const foldIds = executedCallEvidenceIndex(outcome.executed.map((call) => ({ tool: call.tool, args: call.args, status: (call.result as { status?: string }).status }))).entries.map((entry) => entry.id);
  assert.deepEqual(foldIds, ["call-1", "call-2", "call-3"]);
  for (const id of foldIds) {
    assert.ok(section.includes(`- ${id} `), `the proof index must show ${id} — the fold validates against it`);
  }
});

test("#1659 (review): the standard/fallback corpus path carries the same executed-call identifier contract", () => {
  // The standard `callTier` verdict reached after a loop ran (native-loop
  // verdict fell back, or the fallback/smart evidence harness ran) is gated
  // on the artifact's `call-<n>` ids exactly like the in-conversation
  // verdict — its corpus must show them first. Built from the PERSISTED
  // surfaces: the candidates artifact and the artifact's tool_calls trace
  // (`{tool, args, status}`), not the in-memory loop outcome.
  const corpus = "# PR Diff\n+ change\n\n# Tool Harness Findings\n- Tool 1 read_file (ok)\n";
  const candidates = JSON.stringify({
    injected: true,
    obligations: [{ id: "obligation-1", source: "must_check", text: "check the lockfile" }],
  });
  const harnessArtifact = { tool_calls: [{ tool: "read_file", args: { path: "package-lock.json" }, status: "ok" }] };
  const section = standardCorpusProofIndexSection(candidates, harnessArtifact);
  assert.ok(section.startsWith("# Required-Check Proof Index"));
  assert.ok(section.includes("- call-1 "), "the persisted trace's call id is shown");
  assert.ok(section.includes("check the lockfile"), "the must_check identity rows are shown");

  const injected = insertProofIndexSection(corpus, section);
  assert.ok(injected.includes("# Required-Check Proof Index"), "the fallback-corpus-shaped corpus carries the proof index");
  assert.ok(injected.includes("- call-1 "), "the producer sees the exact id the fold validates against");
  assert.ok(injected.includes("# Tool Harness Findings"), "the section is placed, not replacing existing sections");

  // Inert exactly when the citation gate is inert — the corpus stays
  // byte-identical (no harness artifact, empty trace, no must_check rows).
  const noTrace = standardCorpusProofIndexSection(candidates, { stop_reason: "completed" });
  assert.equal(noTrace, "");
  const emptyTrace = standardCorpusProofIndexSection(candidates, { tool_calls: [] });
  assert.equal(emptyTrace, "");
  const noRows = standardCorpusProofIndexSection(
    JSON.stringify({ injected: true, obligations: [{ id: "obligation-1", source: "derived", text: "derived row" }] }),
    harnessArtifact,
  );
  assert.equal(noRows, "");
  const malformedCandidates = standardCorpusProofIndexSection("garbage", harnessArtifact);
  assert.equal(malformedCandidates, "");
  assert.equal(insertProofIndexSection(corpus, ""), corpus, "an inert section never rewrites the corpus");
});

test("#1659: the standalone repair digest carries the canonical settlement record, not only the call digest", () => {
  const harness = {
    tool_calls: [{ tool: "read_file", args: { path: "a.ts" }, status: "ok" }],
    tool_loop_meta: {
      required_evidence_settlements: settlementsToArtifact([
        settlement({ id: "provenance", kind: "dependency", source: undefined, settledVia: "cap-released", successfulAttempt: false, admittedBy: [], successfulBy: [], acquisition: "unavailable" }),
      ]),
    },
  };
  const digest = harnessEvidenceDigest(harness);
  // Settlement lines come FIRST — the block is head-truncated, and the
  // settled state is what a formatting repair must always see.
  assert.equal(digest.startsWith("- question provenance kind=dependency materiality=material state=cap-released evidence=unavailable successful_attempt=no calls=none"), true);
  assert.ok(digest.includes("- read_file"));
  // Absent/malformed records keep the plain call digest (pre-#1659 shape).
  const plain = harnessEvidenceDigest({ tool_calls: [{ tool: "read_file", args: { path: "a.ts" }, status: "ok" }] });
  assert.ok(plain.includes("- read_file"));
  assert.ok(!plain.includes("question "));
  assert.equal(harnessEvidenceDigest({ tool_loop_meta: { required_evidence_settlements: "garbage" } }), "");
});

test("#1659: many settlement rows cannot push the tool-call digest out of the repair digest", () => {
  // More tracked rows than the settlement entry share (half of the digest
  // entry cap): the settlement block saturates and the call digest always
  // keeps entries after it — the repair never loses the call bulk.
  const harness = {
    tool_calls: [{ tool: "read_file", args: { path: "a.ts" }, status: "ok" }],
    tool_loop_meta: {
      required_evidence_settlements: settlementsToArtifact(
        Array.from({ length: 60 }, (_, i) => settlement({ id: `obligation-${i + 1}` })),
      ),
    },
  };
  const digest = harnessEvidenceDigest(harness);
  assert.ok(digest.startsWith("- question obligation-1 "), "settlement rows still come first");
  assert.ok(digest.includes("- read_file"), "the tool-call digest survives a saturated settlement block");
});
