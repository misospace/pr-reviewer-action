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
  finalSettlementsToArtifact,
  foldOwnershipForDependencyQuestions,
  parseFinalSettlements,
  parseLoopSettlements,
  parseLoopSettlementsReport,
  reconcileSettlements,
  settlementsToArtifact,
  type FinalSettlementRow,
  type LoopEvidenceSettlement,
  type SettlementObligationSource,
} from "../src/enforcement/settlement.js";
import { persistedLoopSettlements } from "../src/engine/review.js";
import { buildDispositionEvidence } from "../src/disposition/engine-evidence.js";
import { computeFinalDisposition, parseFinalDisposition, reviewResultFromDisposition } from "../src/disposition/final.js";
import { buildToolLoopTelemetry } from "../src/tools/harness.js";

// ---------------------------------------------------------------------------
// #1659 — ONE canonical per-question record shared by the native loop's
// investigation stopping and the final publication disposition.
//
// The record has two deliberately distinct dimensions:
// - EVIDENCE state (`acquired` / `cap-released` / `open`) is the loop's
//   acquisition bookkeeping. The `obligations-settled` stop is evidence-ready,
//   never proof of a clean settlement.
// - SEMANTIC state (`resolved` / `finding` / `unknown` / `not-tracked`) is
//   reconciled AFTER the verdict from the same folds the final disposition
//   consumes, so the record and the disposition cannot disagree.
//
// Receipts are OBJECTIVE PROVENANCE only (#1657): a successful call never
// certifies a semantic resolution, one receipt may support several questions,
// and no allocation rule exists.
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
  return { postFn, executeFn, executedCalls };
}

const recordingTime = () => (() => Number.MAX_SAFE_INTEGER / 2);

const depRows = (reserve: number): Array<{ id: string; tokens: readonly string[]; obligation: DependencyEvidenceObligation }> =>
  (["provenance", "release_delta", "security_advisory"] as const).slice(0, reserve).map((obligation) => ({
    id: obligation,
    tokens: [],
    obligation,
  }));

const settlement = (
  overrides: Partial<Omit<LoopEvidenceSettlement, "source">> & { source?: SettlementObligationSource | undefined } = {},
): LoopEvidenceSettlement => {
  const { source, ...rest } = overrides;
  return {
    id: "obligation-1",
    kind: "prose",
    materiality: "material",
    source: "must_check",
    evidenceState: "acquired",
    successfulAttempt: true,
    admittedBy: ["call-1"],
    successfulBy: ["call-1"],
    acquisition: "available",
    ...rest,
    ...(source !== undefined ? { source } : {}),
  };
};

const final = (
  overrides: Partial<Omit<FinalSettlementRow, "source">> & { source?: SettlementObligationSource | undefined } = {},
): FinalSettlementRow => {
  const { source, ...rest } = overrides;
  const merged: FinalSettlementRow = { ...settlement(), semantic: "unknown", foldCovered: false, ...rest, ...(source !== undefined ? { source } : {}) };
  if (source === undefined && Object.prototype.hasOwnProperty.call(overrides, "source")) {
    const { source: _drop, ...withoutSource } = merged;
    return withoutSource;
  }
  return merged;
};

// ---------------------------------------------------------------------------
// the record module: serializer + fail-closed reader.
// ---------------------------------------------------------------------------

test("#1659: the evidence record round-trips through the artifact shape", () => {
  const rows: LoopEvidenceSettlement[] = [
    settlement(),
    settlement({ id: "provenance", kind: "dependency", source: undefined, admittedBy: ["call-2", "call-5"], successfulBy: ["call-5"] }),
    settlement({ id: "trace:req-1", kind: "trace", source: undefined, evidenceState: "open", successfulAttempt: false, admittedBy: [], successfulBy: [], acquisition: "unavailable" }),
  ];
  const parsed = parseLoopSettlements(settlementsToArtifact(rows));
  assert.deepEqual(parsed, rows);
});

test("#1659: the evidence reader is fail-closed — malformed rows are dropped, never repaired", () => {
  assert.deepEqual(parseLoopSettlements(null), []);
  assert.deepEqual(parseLoopSettlements(undefined), []);
  assert.deepEqual(parseLoopSettlements("nope"), []);
  assert.deepEqual(parseLoopSettlements({ id: "obligation-1" }), []);
  // Each malformed row drops WHOLE; its neighbors keep. A receipt id that
  // does not match the shared `call-<n>` scheme drops the row (the id↔trace
  // existence check is a write-time guarantee: the loop records ids from the
  // same counter that numbers the persisted trace). The retired semantic
  // vocabulary (`discharged`) is not evidence state and is rejected too.
  assert.deepEqual(
    parseLoopSettlements([
      null,
      {},
      settlement({ id: "" }),
      { ...settlementsToArtifact([settlement()])[0]!, kind: "invented-kind" },
      { ...settlementsToArtifact([settlement()])[0]!, evidence_state: "discharged" },
      { ...settlementsToArtifact([settlement()])[0]!, successful_attempt: "yes" },
      { ...settlementsToArtifact([settlement()])[0]!, admitted_by: ["call-1", 7] },
      { ...settlementsToArtifact([settlement()])[0]!, admitted_by: ["nonsense"] },
      { ...settlementsToArtifact([settlement()])[0]!, successful_by: ["fetch-1"] },
      { ...settlementsToArtifact([settlement()])[0]!, acquisition: "partial" },
      settlementsToArtifact([settlement()])[0],
    ]),
    [settlement()],
  );
  // The drop count is reported, so a corrupted record is never silent.
  const report = parseLoopSettlementsReport([
    { ...settlementsToArtifact([settlement()])[0]!, kind: "invented-kind" },
    settlementsToArtifact([settlement()])[0],
  ]);
  assert.deepEqual(report, { rows: [settlement()], dropped: 1 });
  assert.deepEqual(parseLoopSettlementsReport(undefined), { rows: [], dropped: 0 });
});

test("#1659: the final record carries the semantic state through its own strict reader", () => {
  const rows: FinalSettlementRow[] = [
    final({ semantic: "unknown" }),
    final({ id: "trace:req-1", kind: "trace", source: undefined, semantic: "not-tracked" }),
    final({ id: "obligation-2", semantic: "resolved" }),
  ];
  const artifact = finalSettlementsToArtifact(rows);
  assert.deepEqual(parseFinalSettlements(artifact), rows);
  // A missing/invented semantic state drops the row (the loop reader alone
  // cannot stand in for the post-verdict record), and so does a missing
  // `fold_covered` flag — the dedupe the disposition performs depends on it,
  // so an unreadable flag is never assumed. `not-tracked` on a NON-trace row
  // contradicts the reconciliation contract and is refused too.
  assert.deepEqual(
    parseFinalSettlements([
      { ...artifact[0]!, semantic: "settled-clean" },
      { ...artifact[1]!, semantic: undefined },
      { ...artifact[2]!, fold_covered: undefined },
      { ...artifact[0]!, semantic: "not-tracked" },
      artifact[2],
    ]),
    [rows[2]],
  );
});

test("#1659: one receipt may support several questions — the record never allocates", () => {
  // #1657 removed the one-call-per-row allocator: receipts are shareable
  // evidence, not consumable tokens. Two rows admitted by the same executed
  // call both keep that receipt through the strict reader.
  const rows: LoopEvidenceSettlement[] = [
    settlement({ id: "obligation-1", admittedBy: ["call-1"], successfulBy: ["call-1"] }),
    settlement({ id: "obligation-2", admittedBy: ["call-1"], successfulBy: ["call-1"] }),
  ];
  assert.deepEqual(
    parseLoopSettlements(settlementsToArtifact(rows)).map((row) => [row.id, row.admittedBy]),
    [["obligation-1", ["call-1"]], ["obligation-2", ["call-1"]]],
  );
});

test("#1659: the persisted record rides the telemetry budget block and reads back", () => {
  // The raw `tool_loop_meta` is consumed at write time; the artifact's
  // telemetry budget block is the persisted surface the engine reads.
  const rows = [settlement(), settlement({ id: "security_advisory", kind: "dependency", source: undefined, evidenceState: "cap-released", successfulAttempt: false, admittedBy: [], successfulBy: [], acquisition: "unavailable" })];
  const telemetry = buildToolLoopTelemetry({
    tool_loop_meta: { required_evidence_settlements: settlementsToArtifact(rows) },
  } as unknown as Parameters<typeof buildToolLoopTelemetry>[0]) as { budget: Record<string, unknown> } | null;
  assert.ok(telemetry !== null);
  const persisted = telemetry.budget.required_evidence_settlements;
  assert.deepEqual(persisted, settlementsToArtifact(rows));
  assert.deepEqual(parseLoopSettlements(persisted), rows);
  // Absent record ⇒ absent key (byte-identical pre-#1659 artifact).
  const legacy = buildToolLoopTelemetry({
    tool_loop_meta: {},
  } as unknown as Parameters<typeof buildToolLoopTelemetry>[0]) as { budget: Record<string, unknown> } | null;
  assert.equal(Object.prototype.hasOwnProperty.call(legacy!.budget, "required_evidence_settlements"), false);
});

// ---------------------------------------------------------------------------
// the reconciliation: evidence state joined with the fold's semantic outcome.
// ---------------------------------------------------------------------------

test("#1659: reconciliation derives the semantic state from the fold, never from admission", () => {
  const rows = [
    settlement({ id: "obligation-1" }),
    settlement({ id: "obligation-2" }),
    settlement({ id: "obligation-3" }),
    settlement({ id: "provenance", kind: "dependency", source: undefined }),
    settlement({ id: "release_delta", kind: "dependency", source: undefined, evidenceState: "open", successfulAttempt: false, admittedBy: [], acquisition: "unavailable" }),
    settlement({ id: "security_advisory", kind: "dependency", source: undefined, evidenceState: "cap-released", successfulAttempt: false, admittedBy: [], acquisition: "unavailable" }),
  ];
  const reconciled = reconcileSettlements(rows, [
    { id: "obligation-1", status: "satisfied" },
    { id: "obligation-2", status: "unmet" },
    { id: "obligation-3", status: "unresolved" },
  ]);
  assert.deepEqual(reconciled.map((row) => [row.id, row.semantic, row.foldCovered]), [
    // A successful admitted call is NOT a semantic resolution.
    ["obligation-1", "resolved", true],
    ["obligation-2", "finding", true],
    ["obligation-3", "unknown", true],
    // A shape row with NO fold row is `unknown`, not `not-tracked`: acquired
    // evidence with no semantic settlement is an unanswered question, and
    // `not-tracked` must never hide one.
    ["provenance", "unknown", false],
    // A row the loop never settled can never read as clean.
    ["release_delta", "unknown", false],
    // A cap/budget release is never a semantic settlement.
    ["security_advisory", "unknown", false],
  ]);
  // The fold still wins when it does have an outcome.
  assert.equal(
    reconcileSettlements([settlement({ id: "security_advisory", kind: "dependency", source: undefined, evidenceState: "cap-released" })], [{ id: "security_advisory", status: "satisfied" }])[0]!.semantic,
    "resolved",
  );
});

test("#1659: a dependency shape row joins ONLY the classifier-owned must_check row that NAMES its question", () => {
  // The loop keys a shape row by obligation NAME (`provenance`); the fold keys
  // the same question `obligation-<n>`. The join is the fold row's own TEXT
  // through the shared dependency mapping — no id fudging, no new key scheme —
  // and it is OWNERSHIP-gated: only the classifier-owned `must_check` source
  // may settle the question (the mirror of the harness's must_check-only
  // shape-row dedupe).
  const row = settlement({ id: "provenance", kind: "dependency", source: undefined });
  const foldRow = {
    id: "obligation-7",
    source: "must_check" as const,
    status: "satisfied" as const,
    text: "establish upstream provenance for the updated dependency: publisher and canonical source repository",
  };
  const resolved = reconcileSettlements([row], [foldRow]);
  assert.deepEqual([resolved[0]!.semantic, resolved[0]!.foldCovered], ["resolved", true]);
  // Conservative when several legitimate must_check rows name the same obligation.
  const conservative = reconcileSettlements([row], [
    foldRow,
    { id: "obligation-8", source: "must_check" as const, status: "unresolved" as const, text: "establish upstream provenance for the updated chart" },
  ]);
  assert.deepEqual([conservative[0]!.semantic, conservative[0]!.foldCovered], ["unknown", true]);
  // Unrelated fold text never matches.
  const unrelated = reconcileSettlements([row], [{ id: "obligation-9", source: "must_check" as const, status: "satisfied" as const, text: "run the test suite" }]);
  assert.deepEqual([unrelated[0]!.semantic, unrelated[0]!.foldCovered], ["unknown", false]);
  // A NON-must_check row is never an owner through its text, however exactly it
  // names the obligation: unrelated `derived`/`risk`/trusted-base prose cannot
  // resolve the dependency question, and a foreign NEGATIVE never makes the
  // shape row a `finding` either. Ids follow the real producers
  // (`obligation-<n>`, `derived-<n>`, `risk-<n>`) so the fixture stays
  // producible by the shipped pipeline.
  for (const [source, id] of [
    ["derived", "derived-1"],
    ["risk", "risk-1"],
    ["trusted_base_guidance", "obligation-9"],
  ] as const) {
    for (const status of ["satisfied", "unmet", "unresolved"] as const) {
      const foreign = reconcileSettlements([row], [{ id, source, status, text: foldRow.text }]);
      // Every foreign status leaves the shape question `unknown` — in
      // particular a foreign `unmet` never turns it into a `finding`, and a
      // foreign `satisfied` never resolves it.
      assert.deepEqual([foreign[0]!.semantic, foreign[0]!.foldCovered], ["unknown", false], `${source}/${status}`);
    }
  }
  // An outcome row with NO source is never an owner through its text either
  // (the field is optional; fail-closed, not lenient).
  const sourceless = reconcileSettlements([row], [{ id: "obligation-7", status: "satisfied" as const, text: foldRow.text }]);
  assert.deepEqual([sourceless[0]!.semantic, sourceless[0]!.foldCovered], ["unknown", false]);
  // The helper agrees, including conservative aggregation across legitimate
  // owners (a satisfied owner plus an `unmet` one settles to `unmet`).
  assert.equal(foldOwnershipForDependencyQuestions([{ id: "obligation-7", source: "derived" as const, status: "satisfied" as const, text: foldRow.text }]).has("provenance"), false);
  assert.deepEqual(
    foldOwnershipForDependencyQuestions([
      foldRow,
      { id: "obligation-8", source: "must_check" as const, status: "unmet" as const, text: "establish upstream provenance for the updated chart" },
    ]).get("provenance")?.status,
    "unmet",
  );
  // Only a trace row may be `not-tracked` (the #1658 provenance summary owns it).
  const trace = reconcileSettlements([settlement({ id: "trace:req-1", kind: "trace", source: undefined })], []);
  assert.deepEqual([trace[0]!.semantic, trace[0]!.foldCovered], ["not-tracked", false]);
});

// ---------------------------------------------------------------------------
// the loop side: the evidence record is written on every exit path.
// ---------------------------------------------------------------------------

test("#1659: a settled stop records acquired rows with their admitting call receipts", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Both dependency rows are admitted by successful calls (the provenance
  // fetch credits provenance, the releases fetch release_delta) — the
  // evidence-ready stop fires and the record carries each row's receipt.
  // `acquired` is acquisition bookkeeping: the semantic outcome is joined
  // after the verdict.
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
    { id: "provenance", kind: "dependency", materiality: "material", evidenceState: "acquired", successfulAttempt: true, admittedBy: ["call-1"], successfulBy: ["call-1"], acquisition: "available" },
    { id: "release_delta", kind: "dependency", materiality: "material", evidenceState: "acquired", successfulAttempt: true, admittedBy: ["call-2"], successfulBy: ["call-2"], acquisition: "available" },
  ]);
});

test("#1659: a cap-released row is recorded as `cap-released`, never acquired", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // The #1379 no-lockout shape: one pre-window read, then three gated
  // evidence fetches of unattributed hosts on budget 4/reserve 3. Nothing
  // is admitted to any row, the attempts cap fires, and the window
  // releases — the record says `cap-released` (the budget release it is,
  // never a settlement) with acquisition `unavailable` (the successful
  // fetches admitted to no row).
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
    assert.equal(row.evidenceState, "cap-released");
    assert.equal(row.kind, "dependency");
    assert.equal(row.materiality, "material");
    assert.equal(row.successfulAttempt, false);
    assert.deepEqual(row.admittedBy, []);
    assert.deepEqual(row.successfulBy, []);
    assert.equal(row.acquisition, "unavailable");
  }
});

test("#1659: a row admitted by a FAILED attempt records acquisition `failed` (the #1627 M1 shape)", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // A dependency row's admission covers it regardless of executor status, so
  // the record must expose the M1 stranding shape: acquired evidence whose
  // every admitted attempt failed — never readable as "evidence available".
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
  assert.equal(row.evidenceState, "acquired");
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
    assert.equal(row.evidenceState, "open");
    assert.equal(row.successfulAttempt, false);
    assert.deepEqual(row.admittedBy, []);
    assert.deepEqual(row.successfulBy, []);
    assert.equal(row.acquisition, "unavailable");
  }
});

test("#1659: a row seeded by the #1145 continuation records `truncated` acquisition, never `unavailable`", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // The prior loop already acquired this row; this loop holds no admitting
  // call id for it. `acquired` + `truncated` says exactly that — the old
  // `acquired` + `unavailable` pairing contradicted itself.
  const responses = [openAiCall("c1", "read_file", '{"path":"a.ts"}'), openAiText("done")];
  const { postFn, executeFn } = recordingLoop(responses);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(3, 4, 120),
    reserveForRequiredEvidence: 1,
    requiredEvidence: depRows(1),
    requiredEvidenceCredits: ["provenance"],
    timeFn: recordingTime(),
  });
  assert.deepEqual(outcome.requiredEvidenceSettlements.map((row) => [row.id, row.evidenceState, row.acquisition, row.admittedBy]), [
    ["provenance", "acquired", "truncated", []],
  ]);
});

test("#1659: a prose row's record derives materiality from its obligation source", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // The must_check row is acquired on its admitted read; the guidance row is
  // never targeted and stays open.
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
  assert.deepEqual(outcome.requiredEvidenceSettlements.map((row) => [row.id, row.kind, row.materiality, row.evidenceState, row.acquisition]), [
    ["obligation-1", "prose", "material", "acquired", "available"],
    ["obligation-2", "prose", "advisory", "open", "unavailable"],
  ]);
});

// ---------------------------------------------------------------------------
// the disposition consumes the reconciled record. A cap-released material
// question is a material unknown; a cap-released advisory never vetoes; an
// acquired-but-unresolved question is covered once by the existing fold.
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
    traceUnresolvedMaterial: false,
    traceUnmetClaimed: false,
    mechanicallyProvenUnmetRequirements: 0,
    ciConclusion: null,
    ciEvidenceContractActive: false,
    ...overrides,
  };
}

test("#1659: a cap-released MATERIAL question is a material unknown even when everything else is clean", () => {
  const build = buildDispositionEvidence(dispositionParts({
    finalSettlements: [
      final({ id: "security_advisory", kind: "dependency", source: undefined, evidenceState: "cap-released", semantic: "unknown", successfulAttempt: false, admittedBy: [], acquisition: "unavailable" }),
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
    finalSettlements: [
      final({ id: "obligation-9", source: "trusted_base_guidance", materiality: "advisory", evidenceState: "cap-released", semantic: "unknown", successfulAttempt: false, admittedBy: [], acquisition: "unavailable" }),
    ],
  }));
  // ADVISORY code, not `investigation_unavailable`: that code is MATERIAL-only
  // and `parseFinalDisposition` refuses a cross-pairing, so an advisory entry
  // carrying it would turn this certified APPROVE into an UNAVAILABLE
  // abstention at the standalone publisher.
  assert.deepEqual(build.evidence.map((entry) => [entry.code, entry.materiality]), [["investigation_partial", "advisory"]]);
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

test("#1659: both cap-release dispositions survive the serialized-artifact round trip", () => {
  // The standalone publisher reads `final-disposition.json` back with
  // `parseFinalDisposition`; a disposition that survives the decision table
  // but fails that reader is published as an UNAVAILABLE abstention. So the
  // acceptance check is the REAL artifact, not the in-memory object.
  const roundTrip = (build: ReturnType<typeof buildDispositionEvidence>) => {
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
    const parsed = parseFinalDisposition(JSON.parse(JSON.stringify(disposition)));
    assert.ok(parsed !== null, "the published artifact must be readable by the standalone publisher");
    assert.equal(parsed.kind, disposition.kind);
    assert.equal(parsed.reason, disposition.reason);
    // The native event the marker/attestation/native review all project.
    assert.equal(parsed.nativeEvent, disposition.nativeEvent);
    assert.deepEqual(parsed.advisoryDiagnostics, disposition.advisoryDiagnostics);
    assert.deepEqual(parsed.materialUnknowns, disposition.materialUnknowns);
    return disposition;
  };

  const materialRelease = buildDispositionEvidence(dispositionParts({
    finalSettlements: [
      final({ id: "security_advisory", kind: "dependency", source: undefined, evidenceState: "cap-released", semantic: "unknown", successfulAttempt: false, admittedBy: [], acquisition: "unavailable" }),
    ],
  }));
  assert.equal(roundTrip(materialRelease).kind, "incomplete");
  assert.equal(roundTrip(materialRelease).nativeEvent, "COMMENT");

  const advisoryRelease = buildDispositionEvidence(dispositionParts({
    finalSettlements: [
      final({ id: "obligation-9", source: "trusted_base_guidance", materiality: "advisory", evidenceState: "cap-released", semantic: "unknown", successfulAttempt: false, admittedBy: [], acquisition: "unavailable" }),
    ],
  }));
  assert.equal(roundTrip(advisoryRelease).kind, "approve");
  assert.equal(roundTrip(advisoryRelease).nativeEvent, "APPROVE");

  // A corrupted record discloses through the same artifact path.
  const corrupted = buildDispositionEvidence(dispositionParts({ settlementRecordDroppedRows: 1 }));
  assert.equal(roundTrip(corrupted).kind, "incomplete");
});

test("#1659: an ABSENT settlement field stays legacy-clean; a PRESENT malformed one withholds", () => {
  // Paired at the engine's reader seam, where the distinction is made.
  // Absent telemetry / absent budget / explicit null: no record, no gap.
  assert.deepEqual(persistedLoopSettlements({}), { settlements: [], dropped: 0 });
  assert.deepEqual(persistedLoopSettlements({ tool_loop_telemetry: null }), { settlements: [], dropped: 0 });
  assert.deepEqual(persistedLoopSettlements({ tool_loop_telemetry: { budget: {} } }), { settlements: [], dropped: 0 });
  assert.deepEqual(persistedLoopSettlements({ tool_loop_telemetry: { budget: { required_evidence_settlements: null } } }), { settlements: [], dropped: 0 });
  assert.deepEqual(persistedLoopSettlements({ tool_loop_telemetry: { budget: { required_evidence_settlements: [] } } }), { settlements: [], dropped: 0 });
  // Present-but-invalid at ANY level of the record: a drop, hence a material
  // unknown — never a silent "no record".
  for (const corrupted of [
    { tool_loop_telemetry: { budget: { required_evidence_settlements: "stripped" } } },
    { tool_loop_telemetry: { budget: { required_evidence_settlements: { id: "provenance" } } } },
    { tool_loop_telemetry: { budget: { required_evidence_settlements: 7 } } },
    { tool_loop_telemetry: { budget: "gone" } },
    { tool_loop_telemetry: "gone" },
  ]) {
    assert.equal(persistedLoopSettlements(corrupted).dropped, 1, JSON.stringify(corrupted));
  }
  // The material case end-to-end: same clean review, corrupted record ⇒
  // INCOMPLETE rather than a certified APPROVE.
  const corruptedBuild = buildDispositionEvidence(dispositionParts({
    settlementRecordDroppedRows: persistedLoopSettlements({ tool_loop_telemetry: { budget: { required_evidence_settlements: "stripped" } } }).dropped,
  }));
  const corruptedDisposition = computeFinalDisposition({
    reviewProduced: true,
    validVerdict: true,
    verdict: "approve",
    degraded: false,
    exactHead: true,
    publicationHeadBound: true,
    blockingFindingOpen: false,
    evidenceProviderBlocker: false,
    provenUnmetRequirement: corruptedBuild.provenUnmetRequirement,
    verdictBearing: true,
    approvalScopeAllowed: true,
    evidence: corruptedBuild.evidence,
  });
  assert.equal(corruptedDisposition.kind, "incomplete");
  // The legacy control: no record at all ⇒ the certified APPROVE stands.
  const legacyBuild = buildDispositionEvidence(dispositionParts({
    settlementRecordDroppedRows: persistedLoopSettlements({ tool_loop_telemetry: { budget: {} } }).dropped,
  }));
  assert.equal(legacyBuild.evidence.length, 0);
  const legacyDisposition = computeFinalDisposition({
    reviewProduced: true,
    validVerdict: true,
    verdict: "approve",
    degraded: false,
    exactHead: true,
    publicationHeadBound: true,
    blockingFindingOpen: false,
    evidenceProviderBlocker: false,
    provenUnmetRequirement: legacyBuild.provenUnmetRequirement,
    verdictBearing: true,
    approvalScopeAllowed: true,
    evidence: legacyBuild.evidence,
  });
  assert.equal(legacyDisposition.kind, "approve");
});

test("#1659 P1: a material open / failed-acquisition / unanswered question cannot escape the disposition", () => {
  // The escape this closes: the loop tracked a MATERIAL dependency question the
  // required-check fold cannot account for (e.g. the dependency plan falling
  // back to the full obligation set when the classifier's checklist is
  // missing/unusable), the acquisition stayed `open` or FAILED, and an
  // otherwise-clean model APPROVE was certified anyway. Every case below runs
  // the whole real path: loop record -> reconcileSettlements ->
  // buildDispositionEvidence -> computeFinalDisposition -> the serialized
  // artifact read back by the standalone publisher.
  const publish = (
    build: ReturnType<typeof buildDispositionEvidence>,
    extra: { blockingFindingOpen?: boolean } = {},
  ) => {
    const disposition = computeFinalDisposition({
      reviewProduced: true,
      validVerdict: true,
      verdict: "approve",
      degraded: false,
      exactHead: true,
      publicationHeadBound: true,
      blockingFindingOpen: extra.blockingFindingOpen ?? false,
      evidenceProviderBlocker: false,
      provenUnmetRequirement: build.provenUnmetRequirement,
      verdictBearing: true,
      approvalScopeAllowed: true,
      evidence: build.evidence,
    });
    const parsed = parseFinalDisposition(JSON.parse(JSON.stringify(disposition)));
    assert.ok(parsed !== null, "the published artifact must stay readable");
    assert.equal(parsed.nativeEvent, disposition.nativeEvent);
    assert.equal(parsed.kind, disposition.kind);
    return parsed;
  };
  const shapeRow = (overrides: Partial<LoopEvidenceSettlement>): LoopEvidenceSettlement => ({
    ...settlement({ id: "security_advisory", kind: "dependency", source: undefined, ...overrides }),
  });

  // (1) MATERIAL dependency question left `open`, no fold row: INCOMPLETE /
  // COMMENT, and the entry names the question.
  const open = reconcileSettlements(
    [shapeRow({ evidenceState: "open", successfulAttempt: false, admittedBy: [], successfulBy: [], acquisition: "unavailable" })],
    [],
  );
  assert.deepEqual([open[0]!.semantic, open[0]!.foldCovered], ["unknown", false]);
  const openBuild = buildDispositionEvidence(dispositionParts({ finalSettlements: open }));
  assert.deepEqual(openBuild.evidence.map((entry) => [entry.code, entry.materiality, entry.subject]),
    [["investigation_unavailable", "material", "left unanswered: security_advisory"]]);
  const openDisposition = publish(openBuild);
  assert.equal(openDisposition.kind, "incomplete");
  assert.equal(openDisposition.nativeEvent, "COMMENT");

  // (2) MATERIAL question whose acquisition FAILED: same withholding, through a
  // different loop state.
  const failed = reconcileSettlements(
    [shapeRow({ acquisition: "failed", successfulAttempt: false, successfulBy: [] })],
    [],
  );
  assert.equal(failed[0]!.semantic, "unknown");
  const failedBuild = buildDispositionEvidence(dispositionParts({ finalSettlements: failed }));
  assert.deepEqual(failedBuild.evidence.map((entry) => [entry.code, entry.subject]),
    [["investigation_unavailable", "acquisition failed: security_advisory"]]);
  assert.equal(publish(failedBuild).kind, "incomplete");

  // (3) The SAME question already accounted for by an unresolved objective
  // required-check row: the fold's entry is the single disclosure — no
  // duplicate material-unknown entry. The text is the classifier's real
  // dependency-evidence check for this obligation.
  const questionText = "check upstream security advisories for the updated dependency version range, or report the advisory check as not performed";
  const foldObligation = {
    id: "obligation-4",
    source: "must_check" as const,
    text: questionText,
    status: "unresolved" as const,
    cause: null,
    reason: "receipt-absent" as const,
  };
  const coveredRows = reconcileSettlements(
    [shapeRow({ evidenceState: "open", successfulAttempt: false, admittedBy: [], successfulBy: [], acquisition: "unavailable" })],
    [{ id: foldObligation.id, source: foldObligation.source, status: foldObligation.status, text: foldObligation.text }],
  );
  assert.deepEqual([coveredRows[0]!.semantic, coveredRows[0]!.foldCovered], ["unknown", true]);
  const coveredBuild = buildDispositionEvidence(dispositionParts({
    obligations: [foldObligation],
    completenessChecks: [{ check: questionText, status: "unresolved", reason: "receipt-absent", row_class: "objective" }],
    finalSettlements: coveredRows,
  }));
  // #1822: the subject leads with the row's own deterministic rejection
  // reason.
  assert.deepEqual(coveredBuild.evidence.map((entry) => [entry.code, entry.subject]),
    [["mandatory_requirement_unresolved", `receipt-absent: ${questionText}`]]);
  assert.equal(publish(coveredBuild).kind, "incomplete");

  // (3b) P1 (review round 5): the SAME open question with a SATISFIED
  // non-must_check obligation whose text mentions the dependency vocabulary:
  // that prose is NOT the question's owner, so it can neither resolve the
  // investigation nor hide it. Every foreign source withholds.
  const openShape = () => shapeRow({ evidenceState: "open", successfulAttempt: false, admittedBy: [], successfulBy: [], acquisition: "unavailable" });
  for (const [source, id] of [
    ["derived", "derived-1"],
    ["risk", "risk-1"],
    ["trusted_base_guidance", "obligation-9"],
  ] as const) {
    const outcome = { id, source, status: "satisfied" as const, text: questionText };
    // The shipped pipeline feeds the SAME rows to both consumers
    // (`review.ts` reconciles over `resolvedObligations.obligations` and hands
    // the identical fold rows to the disposition), so the fixture does too —
    // a foreign row stays a real fold row, it just never owns the question.
    const foreignObligation = { id, source, text: questionText, status: "satisfied" as const, cause: null, reason: "ok" as const };
    const foreignRows = reconcileSettlements([openShape()], [outcome]);
    assert.deepEqual([foreignRows[0]!.semantic, foreignRows[0]!.foldCovered], ["unknown", false], source);
    const foreignBuild = buildDispositionEvidence(dispositionParts({
      obligations: [foreignObligation],
      finalSettlements: foreignRows,
    }));
    // One entry only, and it belongs to the unanswered dependency question: a
    // SATISFIED foreign row self-discloses nothing, so the foreign prose
    // neither adds a false negative nor suppresses the real unknown.
    assert.deepEqual(foreignBuild.evidence.map((entry) => [entry.code, entry.materiality, entry.subject]),
      [["investigation_unavailable", "material", "left unanswered: security_advisory"]], source);
    const foreignDisposition = publish(foreignBuild);
    assert.equal(foreignDisposition.kind, "incomplete", source);
    assert.equal(foreignDisposition.nativeEvent, "COMMENT", source);
  }

  // (4) Acquired AND semantically resolved (the fold credits it through the
  // dependency-text join): APPROVE stays eligible, with no evidence entry.
  const resolvedRows = reconcileSettlements(
    [shapeRow({})],
    [{ id: foldObligation.id, source: foldObligation.source, status: "satisfied" as const, text: questionText }],
  );
  assert.deepEqual([resolvedRows[0]!.semantic, resolvedRows[0]!.foldCovered], ["resolved", true]);
  const resolvedBuild = buildDispositionEvidence(dispositionParts({
    obligations: [{ ...foldObligation, status: "satisfied" as const, reason: "ok" as const }],
    completenessChecks: [{ check: questionText, status: "satisfied", reason: "ok", row_class: "objective" }],
    finalSettlements: resolvedRows,
  }));
  assert.deepEqual(resolvedBuild.evidence, []);
  const resolvedDisposition = publish(resolvedBuild);
  assert.equal(resolvedDisposition.kind, "approve");
  assert.equal(resolvedDisposition.nativeEvent, "APPROVE");

  // (5) An ADVISORY unresolved question keeps APPROVE eligible (the diagnostic
  // rides the artifact, it never vetoes).
  const advisoryRows = reconcileSettlements(
    [settlement({ id: "obligation-9", source: "trusted_base_guidance", materiality: "advisory", evidenceState: "open", successfulAttempt: false, admittedBy: [], successfulBy: [], acquisition: "unavailable" })],
    [],
  );
  const advisoryBuild = buildDispositionEvidence(dispositionParts({ finalSettlements: advisoryRows }));
  assert.deepEqual(advisoryBuild.evidence.map((entry) => [entry.code, entry.materiality, entry.subject]),
    [["investigation_partial", "advisory", "left unanswered: obligation-9"]]);
  const advisoryDisposition = publish(advisoryBuild);
  assert.equal(advisoryDisposition.kind, "approve");
  assert.equal(advisoryDisposition.nativeEvent, "APPROVE");
  assert.deepEqual(advisoryDisposition.advisoryDiagnostics.map((entry) => entry.code), ["investigation_partial"]);

  // (6) A proven blocking finding still produces REQUEST_CHANGES — the
  // settlement unknown never outranks it, and never replaces it.
  const blockerBuild = buildDispositionEvidence(dispositionParts({ finalSettlements: open }));
  const blockerDisposition = publish(blockerBuild, { blockingFindingOpen: true });
  assert.equal(blockerDisposition.kind, "request_changes");
  assert.equal(blockerDisposition.reason, "blocker_proven");
  assert.equal(blockerDisposition.nativeEvent, "REQUEST_CHANGES");
});

test("#1659: the loop records a non-gating producer row as ADVISORY, never material", async () => {
  // #1657's row classes ride the admission row from the candidates artifact
  // (producer metadata, never wording). An `attention` row is additionally
  // dropped from the obligation fold, so the settlement record is its ONLY
  // surface — and it must never hand it a material veto.
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const responses = Array.from({ length: 4 }, (_, i) => openAiCall(`c${i}`, "read_file", `{"path":"misc/${i}.md"}`));
  const { postFn, executeFn } = recordingLoop(responses);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(3, 4, 120),
    reserveForRequiredEvidence: 2,
    requiredEvidence: [
      { id: "obligation-1", tokens: ["misc"], source: "must_check", rowClass: "attention" },
      { id: "obligation-2", tokens: ["other"], source: "must_check", rowClass: "review-prompt" },
    ],
    timeFn: recordingTime(),
  });
  assert.deepEqual(outcome.requiredEvidenceSettlements.map((row) => [row.id, row.kind, row.materiality, row.evidenceState]), [
    // obligation-1 is admitted by the `misc/…` reads; obligation-2 never is.
    ["obligation-1", "prose", "advisory", "acquired"],
    ["obligation-2", "prose", "advisory", "open"],
  ]);
  // End-to-end: the same row, unaccounted by any fold, stays a diagnostic.
  const reconciled = reconcileSettlements(outcome.requiredEvidenceSettlements, []);
  const build = buildDispositionEvidence(dispositionParts({ finalSettlements: reconciled }));
  assert.deepEqual(build.evidence.map((entry) => [entry.code, entry.materiality]), [
    ["investigation_partial", "advisory"],
    ["investigation_partial", "advisory"],
  ]);
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
  assert.equal(disposition.nativeEvent, "APPROVE");
});

test("#1659: a legitimate must_check owner is disclosed once; foreign-source prose never owns the question", () => {
  const questionText = "check upstream security advisories for the updated dependency version range, or report the advisory check as not performed";
  const shapeRow = settlement({ id: "security_advisory", kind: "dependency", source: undefined });

  // (a) An `unmet` must_check owner: the semantic state is `finding`, and the
  // completeness fold's own entry is the single disclosure — the record adds
  // nothing, and the negative semantics stay intact.
  const unmetObligation = {
    id: "obligation-5",
    source: "must_check" as const,
    text: questionText,
    status: "unmet" as const,
    cause: null,
    reason: "no-disposition" as const,
  };
  const unmetRows = reconcileSettlements(
    [shapeRow],
    [{ id: unmetObligation.id, source: unmetObligation.source, status: unmetObligation.status, text: unmetObligation.text }],
  );
  assert.deepEqual([unmetRows[0]!.semantic, unmetRows[0]!.foldCovered], ["finding", true]);
  const unmetBuild = buildDispositionEvidence(dispositionParts({
    obligations: [unmetObligation],
    completenessChecks: [{ check: questionText, status: "unmet", reason: "no-disposition", row_class: "objective" }],
    finalSettlements: unmetRows,
  }));
  assert.deepEqual(unmetBuild.evidence.map((entry) => [entry.code, entry.subject]),
    [["mandatory_requirement_unresolved", questionText]]);

  // (b) P1 (review round 5): a `derived` row naming the dependency vocabulary
  // is NOT the shape question's owner. It never resolves or hides the
  // dependency investigation; each question keeps its own entry — the derived
  // obligation discloses itself, the settlement record discloses the
  // unanswered dependency question. Neither side implements the ownership
  // rule independently: both call `foldOwnershipForDependencyQuestions`.
  const derivedObligation = {
    id: "derived-2",
    source: "derived" as const,
    text: questionText,
    status: "unresolved" as const,
    cause: null,
    reason: "ungrounded-derived" as const,
  };
  const derivedRows = reconcileSettlements(
    [shapeRow],
    [{ id: derivedObligation.id, source: derivedObligation.source, status: derivedObligation.status, text: derivedObligation.text }],
  );
  assert.deepEqual([derivedRows[0]!.semantic, derivedRows[0]!.foldCovered], ["unknown", false]);
  const derivedBuild = buildDispositionEvidence(dispositionParts({
    obligations: [derivedObligation],
    finalSettlements: derivedRows,
  }));
  assert.deepEqual(derivedBuild.evidence.map((entry) => [entry.code, entry.subject]),
    [["mandatory_requirement_unresolved", "derived-2"], ["investigation_unavailable", "unanswered: security_advisory"]]);
  // The helper itself agrees: the derived row is not an owner.
  assert.equal(foldOwnershipForDependencyQuestions([
    { id: derivedObligation.id, source: derivedObligation.source, status: derivedObligation.status, text: derivedObligation.text },
  ]).has("security_advisory"), false);
});

// ---------------------------------------------------------------------------
// the reachable loop shape end-to-end: the dependency plan tracked questions
// the required-check fold cannot account for (the plan's full-set fallback),
// the loop ran out of rounds, and nothing else settled them.
// ---------------------------------------------------------------------------

test("#1659 P1 end-to-end: an unsettled dependency question from the real loop withholds the native approve", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Every turn optional, nothing ever targets the shape rows: the loop stops
  // on rounds with the tracked dependency questions `open`.
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
  // The fold carries nothing for these questions (the classifier's checklist
  // was missing/unusable, which is what made the plan track the full set).
  const reconciled = reconcileSettlements(outcome.requiredEvidenceSettlements, []);
  assert.deepEqual(reconciled.map((row) => [row.id, row.semantic, row.foldCovered]), [
    ["provenance", "unknown", false],
    ["release_delta", "unknown", false],
    ["security_advisory", "unknown", false],
  ]);
  const build = buildDispositionEvidence(dispositionParts({ finalSettlements: reconciled }));
  assert.deepEqual(build.evidence.map((entry) => [entry.code, entry.materiality]), [
    ["investigation_unavailable", "material"],
    ["investigation_unavailable", "material"],
    ["investigation_unavailable", "material"],
  ]);
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
  const parsed = parseFinalDisposition(JSON.parse(JSON.stringify(disposition)));
  assert.ok(parsed !== null);
  assert.equal(parsed.kind, "incomplete");
  assert.equal(parsed.reason, "material_unknown");
  // The native event is a COMMENT: no certified approval, and no invented
  // blocker either.
  assert.equal(parsed.nativeEvent, "COMMENT");
  assert.equal(reviewResultFromDisposition(parsed, { strict: true, openFindings: 0 }), "partial");
});

test("#1659: a resolved/cap-released row the fold credited feeds nothing, and trace rows stay with #1658", () => {
  const satisfied = { id: "obligation-1", source: "must_check" as const, text: "check the bump", status: "satisfied" as const, cause: null, reason: "ok" as const };
  assert.deepEqual(
    buildDispositionEvidence(dispositionParts({
      obligations: [satisfied],
      finalSettlements: [final({ evidenceState: "cap-released", semantic: "resolved" })],
    })).evidence,
    [],
  );
  // The trace's disposition settlement is the #1658 provenance summary's
  // job; the record never adds a second entry for it.
  assert.deepEqual(
    buildDispositionEvidence(dispositionParts({
      finalSettlements: [final({ id: "trace:req-1", kind: "trace", source: undefined, evidenceState: "cap-released", semantic: "unknown" })],
    })).evidence,
    [],
  );
  // An acquired row whose fold is still unresolved is disclosed ONCE by the
  // completeness fold; the reconciled record must not duplicate it.
  const unresolved = { ...satisfied, status: "unresolved" as const };
  const build = buildDispositionEvidence(dispositionParts({
    obligations: [unresolved],
    completenessChecks: [{ check: "check the bump", status: "unresolved", reason: "receipt-absent", row_class: "objective" }],
    finalSettlements: [final({ semantic: "unknown" })],
  }));
  assert.deepEqual(build.evidence.map((entry) => [entry.code, entry.subject]), [["mandatory_requirement_unresolved", "receipt-absent: check the bump"]]);
});

test("#1659: a dependency shape row the fold resolved is never re-disclosed, and no receipt id is required", () => {
  // Regression (review round): the disposition used to skip cap-released rows
  // by matching `settlement.id` against `obligations[].id`. Dependency shape
  // row ids are obligation NAMES (`provenance`), never `obligation-<n>`, so
  // that skip was dead and a proven-satisfied review could carry a spurious
  // material unknown. The semantic state now comes from the fold itself.
  const shapeRow = final({
    id: "provenance",
    kind: "dependency",
    source: undefined,
    evidenceState: "cap-released",
    successfulAttempt: false,
    admittedBy: [],
    acquisition: "unavailable",
  });
  const reconciled = reconcileSettlements([shapeRow], [{ id: "provenance", status: "satisfied" }]);
  assert.equal(reconciled[0]!.semantic, "resolved");
  assert.deepEqual(
    buildDispositionEvidence(dispositionParts({ finalSettlements: reconciled })).evidence,
    [],
  );
  // Counterpart: the SAME row with an unrelated satisfied must_check row keeps
  // its material unknown — a cap-released dependency question was never
  // answered, whatever else the review proved.
  const stillUnknown = reconcileSettlements(
    [shapeRow],
    [{ id: "obligation-1", status: "satisfied" }],
  );
  assert.equal(stillUnknown[0]!.semantic, "unknown");
  assert.deepEqual(
    buildDispositionEvidence(dispositionParts({ finalSettlements: stillUnknown })).evidence
      .map((entry) => [entry.code, entry.materiality]),
    [["investigation_unavailable", "material"]],
  );
});

test("#1659: a corrupted persisted record is a material unknown, never 'no gaps'", () => {
  const build = buildDispositionEvidence(dispositionParts({ settlementRecordDroppedRows: 2 }));
  assert.deepEqual(build.evidence.map((entry) => [entry.code, entry.materiality]), [["investigation_unavailable", "material"]]);
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
  // A clean record (0 / absent) discloses nothing.
  assert.deepEqual(buildDispositionEvidence(dispositionParts({ settlementRecordDroppedRows: 0 })).evidence, []);
});

test("#1659: the harness telemetry → engine reader → reconciliation join keeps rows and counts drops", () => {
  // The join the unit tests used to miss: the harness artifact's telemetry
  // budget block is the surface `persistedLoopSettlements` reads.
  const rows = [
    settlement({ id: "obligation-1", evidenceState: "cap-released", successfulAttempt: false, admittedBy: [], successfulBy: [], acquisition: "unavailable" }),
  ];
  const telemetry = buildToolLoopTelemetry({
    tool_loop_meta: {
      required_evidence_settlements: [
        ...settlementsToArtifact(rows),
        { ...settlementsToArtifact([settlement()])[0]!, kind: "invented-kind" },
      ],
    },
  } as unknown as Parameters<typeof buildToolLoopTelemetry>[0]);
  const read = persistedLoopSettlements({ tool_loop_telemetry: telemetry });
  assert.deepEqual(read.settlements, rows);
  assert.equal(read.dropped, 1);
  // Absent telemetry/budget is the legacy shape: nothing, and no false drop.
  assert.deepEqual(persistedLoopSettlements(null), { settlements: [], dropped: 0 });
  assert.deepEqual(persistedLoopSettlements({}), { settlements: [], dropped: 0 });
});

// ---------------------------------------------------------------------------
// end-to-end: loop record -> post-verdict record -> disposition/native event.
//
// The acceptance shape: a successful admitted call acquires the evidence, but
// the verdict leaves the question unanswered. The loop record must say
// `acquired` (evidence ready, never a clean settlement), the reconciled
// record must say `unknown`, and the final disposition + shared review result
// (the handoff/marker/native-event projection) must withhold. The control
// pair resolves the same question and approves.
// ---------------------------------------------------------------------------

test("#1659 end-to-end: successful admission + a missing semantic disposition withholds; the resolved control approves", async () => {
  const question = "verify the dependency bump against package-lock.json";
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn } = recordingLoop([
    openAiCall("c1", "read_file", '{"path":"package-lock.json"}'),
    openAiText("done"),
  ]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(3, 6, 120),
    reserveForRequiredEvidence: 1,
    // #1657: must_check rows with tokens enter the loop as prose rows.
    requiredEvidence: [{ id: "obligation-1", tokens: ["package-lock", "bump"], source: "must_check" }],
    timeFn: recordingTime(),
  });
  // The loop is evidence-ready; it never claims a semantic settlement.
  assert.deepEqual(outcome.requiredEvidenceSettlements.map((row) => [row.id, row.evidenceState, row.successfulAttempt]), [
    ["obligation-1", "acquired", true],
  ]);

  const obligation = { id: "obligation-1", source: "must_check" as const, text: question, status: "unresolved" as const, cause: null, reason: "receipt-absent" as const };
  const completeness = [{ check: question, status: "unresolved", reason: "receipt-absent", row_class: "objective" }];

  // Repro: acquired evidence, no semantic answer.
  const missing = reconcileSettlements(outcome.requiredEvidenceSettlements, [{ id: "obligation-1", status: "unresolved" }]);
  assert.deepEqual(missing.map((row) => [row.evidenceState, row.semantic]), [["acquired", "unknown"]]);
  const missingBuild = buildDispositionEvidence(dispositionParts({
    obligations: [obligation],
    completenessChecks: completeness,
    finalSettlements: missing,
  }));
  const missingDisposition = computeFinalDisposition({
    reviewProduced: true,
    validVerdict: true,
    verdict: "approve",
    degraded: false,
    exactHead: true,
    publicationHeadBound: true,
    blockingFindingOpen: false,
    evidenceProviderBlocker: false,
    provenUnmetRequirement: missingBuild.provenUnmetRequirement,
    verdictBearing: true,
    approvalScopeAllowed: true,
    evidence: missingBuild.evidence,
  });
  assert.equal(missingDisposition.kind, "incomplete");
  // The handoff, the marker's review_result and the native event all project
  // THIS disposition: they agree with the loop/final record by construction.
  assert.equal(reviewResultFromDisposition(missingDisposition, { strict: true, openFindings: 0 }), "partial");

  // Control: the same acquired evidence, adequately resolved by the verdict.
  const resolved = reconcileSettlements(outcome.requiredEvidenceSettlements, [{ id: "obligation-1", status: "satisfied" }]);
  assert.deepEqual(resolved.map((row) => [row.evidenceState, row.semantic]), [["acquired", "resolved"]]);
  const resolvedBuild = buildDispositionEvidence(dispositionParts({
    obligations: [{ ...obligation, status: "satisfied" }],
    completenessChecks: [{ check: question, status: "satisfied", reason: "ok", row_class: "objective" }],
    finalSettlements: resolved,
  }));
  const resolvedDisposition = computeFinalDisposition({
    reviewProduced: true,
    validVerdict: true,
    verdict: "approve",
    degraded: false,
    exactHead: true,
    publicationHeadBound: true,
    blockingFindingOpen: false,
    evidenceProviderBlocker: false,
    provenUnmetRequirement: resolvedBuild.provenUnmetRequirement,
    verdictBearing: true,
    approvalScopeAllowed: true,
    evidence: resolvedBuild.evidence,
  });
  assert.equal(resolvedDisposition.kind, "approve");
  assert.equal(reviewResultFromDisposition(resolvedDisposition, { strict: true, openFindings: 0 }), "clean");
});
