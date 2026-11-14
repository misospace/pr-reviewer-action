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
  type SettlementObligationSource,
} from "../src/enforcement/settlement.js";
import { buildDispositionEvidence } from "../src/disposition/engine-evidence.js";
import { computeFinalDisposition } from "../src/disposition/final.js";
import { buildToolLoopTelemetry } from "../src/tools/harness.js";

// ---------------------------------------------------------------------------
// #1659 — ONE canonical evidence-settlement record shared by the native
// loop's investigation stopping and final publication completeness.
//
// The record is OBJECTIVE PROVENANCE only (#1657's receipts-are-provenance
// boundary): it discloses what the loop did with each tracked question —
// discharged, cap-released (a budget release, never a semantic settlement),
// or still open — plus whether evidence was actually acquired. It never
// certifies a semantic resolution and never overrides the final disposition
// by admission bookkeeping alone. A cap/budget release is disclosed: a
// cap-released material question becomes a named material unknown; a
// cap-released advisory question never vetoes.
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

test("#1659: the persisted record rides the telemetry budget block and reads back", () => {
  // The raw `tool_loop_meta` is consumed at write time; the artifact's
  // telemetry budget block is the persisted surface the engine reads.
  const rows = [settlement(), settlement({ id: "security_advisory", kind: "dependency", source: undefined, settledVia: "cap-released", successfulAttempt: false, admittedBy: [], successfulBy: [], acquisition: "unavailable" })];
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
  // never targeted and stays open. Provenance only: the discharge does not
  // claim the question is semantically settled.
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

test("#1659: a cap-released row the fold resolved satisfied feeds nothing, and trace-kind rows stay with #1658's trace settlement", () => {
  assert.deepEqual(
    buildDispositionEvidence(dispositionParts({
      obligations: [
        { id: "obligation-1", source: "must_check", text: "check the bump", status: "satisfied", cause: null, reason: "ok" },
      ],
      loopSettlements: [settlement({ settledVia: "cap-released" })],
    })).evidence,
    [],
  );
  // The trace's disposition settlement is the #1658 provenance summary's
  // job; the loop record never adds a second entry for it.
  assert.deepEqual(
    buildDispositionEvidence(dispositionParts({
      loopSettlements: [settlement({ id: "trace:req-1", kind: "trace", source: undefined, settledVia: "cap-released" })],
    })).evidence,
    [],
  );
  // A discharged/open row contributes nothing either: discharged is the
  // loop's terminal state (provenance only), and open is already covered by
  // the fold evidence above — one question, one evidence entry.
  assert.deepEqual(
    buildDispositionEvidence(dispositionParts({
      loopSettlements: [
        settlement(),
        settlement({ id: "obligation-2", settledVia: "open", successfulAttempt: false, admittedBy: [], acquisition: "unavailable" }),
      ],
    })).evidence,
    [],
  );
});
