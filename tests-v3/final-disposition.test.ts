import test from "node:test";
import assert from "node:assert/strict";
import {
  ADVISORY_DISPOSITION_CODES,
  MATERIAL_CODE_CLAUSES,
  MATERIAL_DISPOSITION_CODES,
  boundDispositionSubject,
  computeFinalDisposition,
  dispositionEvidence,
  parseFinalDisposition,
  unreadableFinalDisposition,
  reviewResultFromDisposition,
  type DispositionEvidence,
  type FinalDisposition,
  type FinalDispositionInput,
} from "../src/disposition/final.js";
import { buildDispositionEvidence, type DispositionEvidenceParts } from "../src/disposition/engine-evidence.js";
import { applyStrictVerdictPolicy } from "../src/enforcement/verdict-policy.js";
import {
  applyAllEnforcement,
  applyToolMinSuccessfulEnforcement,
  failClosedEnforcementFired,
  toolCapabilityFailure,
  toolMinSuccessfulFloorUnmet,
  type EnforcementInputs,
} from "../src/enforcement/enforce.js";
import { computeReviewAttestation, parseReviewAttestation } from "../src/publish/attestation.js";
import { failOnRequestChanges } from "../src/run/action.js";
import { publishReview } from "../src/publish/publish.js";
import type { NativeReviewSurface, PublishPlatformApi } from "../src/platform/publish-api.js";

// ---------------------------------------------------------------------------
// #1656 — ONE authoritative post-validation final disposition. The pins
// below are the issue's deterministic acceptance fixtures plus the audit
// delta: provider-free, no live models, every surface derived from the same
// object, and kind `approve` always means a CERTIFIED APPROVE.
// ---------------------------------------------------------------------------

/** A full git object id: the attestation's `approved` conclusion is only
 * reachable when the head is a bindable SHA. */
const HEAD = "a".repeat(40);
const MARKER = "<!-- ai-pr-review -->";

/** The neutral disposition input every fixture overrides: an exact-head,
 * head-bound, verdict-bearing, certified-eligible review with no findings,
 * no evidence and a valid approve verdict. Deliberately NO route/tier/lane
 * field exists — a fallback lane certifies exactly like a primary lane
 * when it actually performed an adequate review (#1656 audit delta). */
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

// ---------------------------------------------------------------------------
// The original issue's pins.
// ---------------------------------------------------------------------------

test("pin: adequately reviewed behavior despite a lexical/proof-shape diagnostic => APPROVE (#1643-shaped)", () => {
  // The requirement-trace validator could not match its predicate at the
  // cited location, but the model/evidence adequately established the
  // behavior. The seam carries that ruling as ADVISORY proof-shape
  // evidence; nothing material stands; the disposition certifies APPROVE.
  const disposition = computeFinalDisposition(input({
    evidence: [
      dispositionEvidence("proof_shape_mismatch", "reviewer", "advisory", "req-authz-check"),
      dispositionEvidence("generic_scrutiny_row_missing", "deterministic", "advisory", "treat as high priority — verify correctness carefully"),
    ],
  }));
  assert.equal(disposition.kind, "approve");
  assert.equal(disposition.reason, "approval_certified");
  assert.equal(disposition.nativeEvent, "APPROVE");
  assert.equal(disposition.approvalCertified, true);
  assert.equal(disposition.blockerProven, false);
  assert.equal(disposition.materialUnknowns.length, 0);
  assert.equal(disposition.advisoryDiagnostics.length, 2);
  assert.match(disposition.recommendation, /✅ \*\*Automated recommendation: APPROVE\*\*/);
});

test("pin: materially unread auth/trust-boundary behavior => INCOMPLETE, never APPROVE", () => {
  const disposition = computeFinalDisposition(input({
    evidence: [dispositionEvidence("unread_affected_path", "deterministic", "material", "src/auth/session.ts")],
  }));
  assert.equal(disposition.kind, "incomplete");
  assert.equal(disposition.reason, "material_unknown");
  assert.equal(disposition.nativeEvent, "COMMENT");
  assert.equal(disposition.approvalCertified, false);
  assert.deepEqual(disposition.materialUnknowns.map((entry) => entry.code), ["unread_affected_path"]);
  assert.match(disposition.recommendation, /INCOMPLETE/);
  assert.ok(disposition.recommendation.includes(MATERIAL_CODE_CLAUSES.unread_affected_path));
});

test("pin: grounded current-head major => REQUEST_CHANGES", () => {
  const disposition = computeFinalDisposition(input({
    verdict: "request_changes",
    blockingFindingOpen: true,
  }));
  assert.equal(disposition.kind, "request_changes");
  assert.equal(disposition.reason, "blocker_proven");
  assert.equal(disposition.nativeEvent, "REQUEST_CHANGES");
  assert.equal(disposition.blockerProven, true);
  // A proven defect outranks a coverage gap in the same run.
  const withGap = computeFinalDisposition(input({
    verdict: "request_changes",
    blockingFindingOpen: true,
    evidence: [dispositionEvidence("investigation_unavailable", "deterministic", "material", "harness planning failed")],
  }));
  assert.equal(withGap.kind, "request_changes");
  assert.equal(withGap.nativeEvent, "REQUEST_CHANGES");
});

test("pin: an objectively proven unmet mandatory requirement => REQUEST_CHANGES", () => {
  const disposition = computeFinalDisposition(input({ provenUnmetRequirement: true }));
  assert.equal(disposition.kind, "request_changes");
  assert.equal(disposition.reason, "requirement_unmet");
  assert.equal(disposition.nativeEvent, "REQUEST_CHANGES");
});

test("pin: current-head-relevant major claim that cannot be grounded/refuted => INCOMPLETE (not REQUEST_CHANGES, not APPROVE)", () => {
  const disposition = computeFinalDisposition(input({
    evidence: [dispositionEvidence("unverified_blocking_claim", "deterministic", "material", "src/auth/session.ts:41")],
  }));
  assert.equal(disposition.kind, "incomplete");
  assert.equal(disposition.nativeEvent, "COMMENT");
  assert.notEqual(disposition.kind, "request_changes");
  assert.notEqual(disposition.kind, "approve");
  // The strict mapping no longer manufactures a code blocker for the same
  // artifact state: the unverified demotion keeps the verdict approve and
  // the disposition withholds certification.
  const artifactState = {
    verdict: "approve",
    verdict_source: "model",
    review_markdown: "",
    findings: [
      { severity: "minor", category: "bug", file: "src/auth/session.ts", line: 41, message: "claim", capped_from: "major", grounding_status: "unverified" },
    ],
    required_checks: "complete",
  };
  const outcome = applyStrictVerdictPolicy(artifactState as never, { modelVerdict: "approve", forced: false });
  assert.equal(outcome.verdict, "approve");
  assert.equal(outcome.source, "model");
});

test("pin: provider failure before meaningful review => UNAVAILABLE, not a fabricated code blocker", () => {
  for (const fixture of [
    input({ reviewProduced: false, validVerdict: false, verdict: "" }),
    input({ validVerdict: false, verdict: "" }),
    input({ degraded: true, verdict: "approve" }),
  ]) {
    const disposition = computeFinalDisposition(fixture);
    assert.equal(disposition.kind, "unavailable");
    assert.equal(disposition.nativeEvent, "COMMENT");
    assert.equal(disposition.blockerProven, false);
    assert.equal(disposition.approvalCertified, false);
  }
  assert.equal(computeFinalDisposition(input({ reviewProduced: false, validVerdict: false, verdict: "" })).reason, "review_failed");
  assert.equal(computeFinalDisposition(input({ validVerdict: false, verdict: "" })).reason, "no_verdict");
  assert.equal(computeFinalDisposition(input({ degraded: true, verdict: "approve" })).reason, "degraded_no_evidence");
});

test("pin: bookkeeping identified by TRUSTED reason codes alone => advisory, does not veto APPROVE", () => {
  // #1656 audit round 2: advisory status comes from trusted deterministic
  // reason/source codes (the citation-gate family) — never from prose
  // matching. The seam codes for generic scrutiny and stale-thread
  // bookkeeping remain available to #1657/#1654 provenance feeds.
  const disposition = computeFinalDisposition(input({
    evidence: [
      dispositionEvidence("generic_scrutiny_row_missing", "reviewer", "advisory", "linked_priority_p1"),
      dispositionEvidence("citation_allocation_failed", "deterministic", "advisory", "must_check:citation-shared"),
      dispositionEvidence("stale_thread_bookkeeping", "deterministic", "advisory", "thread:88"),
    ],
  }));
  assert.equal(disposition.kind, "approve");
  assert.equal(disposition.nativeEvent, "APPROVE");
  assert.equal(disposition.advisoryDiagnostics.length, 3);
  assert.equal(disposition.materialUnknowns.length, 0);
});

test("material-unknown floor: exact-head evidence and upstream facts withhold approval", () => {
  const exactHead = computeFinalDisposition(input({
    evidence: [dispositionEvidence("exact_head_evidence_unavailable", "deterministic", "material", "ci:required-check pending")],
  }));
  assert.equal(exactHead.kind, "incomplete");
  assert.ok(exactHead.recommendation.includes(MATERIAL_CODE_CLAUSES.exact_head_evidence_unavailable));
  const upstream = computeFinalDisposition(input({
    evidence: [dispositionEvidence("upstream_source_unavailable", "reviewer", "material", "upstream advisory")],
  }));
  assert.equal(upstream.kind, "incomplete");
});

test("decision order: capability failure outranks everything; defect outranks material unknown; material unknown outranks advisory", () => {
  const evidence = [
    dispositionEvidence("unread_affected_path", "deterministic", "material", "src/auth"),
    dispositionEvidence("serialization_diagnostic", "deterministic", "advisory", "artifact trim"),
  ];
  // No verdict wins over proven defects and material unknowns.
  assert.equal(computeFinalDisposition(input({ validVerdict: false, verdict: "", blockingFindingOpen: true, evidence })).kind, "unavailable");
  // A proven defect wins over the material unknown.
  assert.equal(computeFinalDisposition(input({ verdict: "request_changes", blockingFindingOpen: true, evidence })).kind, "request_changes");
  // The material unknown wins over the advisory diagnostics.
  assert.equal(computeFinalDisposition(input({ evidence })).kind, "incomplete");
  // Advisory alone approves.
  assert.equal(computeFinalDisposition(input({ evidence: [evidence[1]!] })).kind, "approve");
});

// ---------------------------------------------------------------------------
// Audit delta: certification lives INSIDE the disposition.
// ---------------------------------------------------------------------------

test("APPROVE means certified APPROVE: the certification gates are inputs, not a downstream authority", () => {
  // Fork scope policy withholds INSIDE the disposition: kind `approve`
  // with a COMMENT event can no longer exist.
  const fork = computeFinalDisposition(input({ approvalScopeAllowed: false }));
  assert.equal(fork.kind, "incomplete");
  assert.equal(fork.reason, "approval_withheld");
  assert.equal(fork.approvalCertified, false);
  assert.equal(fork.nativeEvent, "COMMENT");
  // The review itself completed: the recommendation keeps the reviewer's
  // direction without reading as a certified approval.
  assert.match(fork.recommendation, /APPROVE — advisory, no approval certified/);
  assert.equal(fork.materialUnknowns.length, 0);

  // A non-verdict-bearing surface (comment mode) withholds the same way;
  // the plain APPROVE recommendation line is preserved there (pre-#1656
  // byte behavior — no verdict-bearing event exists to contradict).
  const advisorySurface = computeFinalDisposition(input({ verdictBearing: false, publicationHeadBound: false }));
  assert.equal(advisorySurface.kind, "incomplete");
  assert.equal(advisorySurface.reason, "approval_withheld");
  assert.equal(advisorySurface.nativeEvent, "COMMENT");
  assert.match(advisorySurface.recommendation, /✅ \*\*Automated recommendation: APPROVE\*\*/);

  // An unproven exact head cannot certify either.
  const unprovenHead = computeFinalDisposition(input({ exactHead: false, publicationHeadBound: false }));
  assert.equal(unprovenHead.kind, "incomplete");
  assert.equal(unprovenHead.reason, "approval_withheld");
  assert.equal(unprovenHead.nativeEvent, "COMMENT");

  // With every gate satisfied, kind `approve` and the APPROVE event agree.
  const certified = computeFinalDisposition(input({}));
  assert.equal(certified.kind, "approve");
  assert.equal(certified.reason, "approval_certified");
  assert.equal(certified.approvalCertified, true);
  assert.equal(certified.nativeEvent, "APPROVE");
  assert.equal(certified.approvalCertified, certified.kind === "approve");
});

test("the marker's review_result is a projection of the disposition (kind + reason)", () => {
  assert.equal(reviewResultFromDisposition({ kind: "request_changes", reason: "blocker_proven" }, { strict: true, openFindings: 0 }), "issues");
  assert.equal(reviewResultFromDisposition({ kind: "incomplete", reason: "material_unknown" }, { strict: true, openFindings: 0 }), "partial");
  assert.equal(reviewResultFromDisposition({ kind: "unavailable", reason: "degraded_no_evidence" }, { strict: true, openFindings: 0 }), "partial");
  assert.equal(reviewResultFromDisposition({ kind: "approve", reason: "approval_certified" }, { strict: true, openFindings: 2 }), "findings");
  assert.equal(reviewResultFromDisposition({ kind: "approve", reason: "approval_certified" }, { strict: true, openFindings: 0 }), "clean");
  // A certification withholding (fork scope, advisory surface) is NOT a
  // coverage gap: the review itself completed, so the marker reads
  // findings/clean, never partial.
  assert.equal(reviewResultFromDisposition({ kind: "incomplete", reason: "approval_withheld" }, { strict: true, openFindings: 0 }), "clean");
  assert.equal(reviewResultFromDisposition({ kind: "incomplete", reason: "approval_withheld" }, { strict: true, openFindings: 2 }), "findings");
  // Non-strict policies keep the binary v2 vocabulary.
  assert.equal(reviewResultFromDisposition({ kind: "approve", reason: "approval_certified" }, { strict: false, openFindings: 2 }), "clean");
});

// ---------------------------------------------------------------------------
// Audit delta: the objective APPROVE floor and its anti-adequacy rules.
// ---------------------------------------------------------------------------

test("pin: clean adequate review => APPROVE", () => {
  const disposition = computeFinalDisposition(input({}));
  assert.equal(disposition.kind, "approve");
  assert.equal(disposition.nativeEvent, "APPROVE");
});

test("pin: zero-evidence/degraded review => UNAVAILABLE or INCOMPLETE, never APPROVE", () => {
  // A degraded no-evidence fallback is UNAVAILABLE.
  assert.equal(computeFinalDisposition(input({ degraded: true })).kind, "unavailable");
  // A recorded no-evidence degradation in an otherwise-live review is a
  // material unknown: INCOMPLETE.
  const noEvidence = computeFinalDisposition(input({
    evidence: [dispositionEvidence("investigation_unavailable", "deterministic", "material", "loop degraded: provider exhausted")],
  }));
  assert.equal(noEvidence.kind, "incomplete");
  assert.equal(noEvidence.nativeEvent, "COMMENT");
  assert.equal(noEvidence.approvalCertified, false);
  for (const kind of [noEvidence.kind, computeFinalDisposition(input({ degraded: true })).kind]) {
    assert.notEqual(kind, "approve");
  }
});

test("pin: an adequately investigated fallback may APPROVE — no route/tier field exists", () => {
  // The disposition input type carries NO route/tier/lane field: a fallback
  // run that actually performed an adequate review presents the identical
  // input shape and certifies exactly like a primary run.
  const fallbackRun: FinalDispositionInput = input({});
  assert.equal("route" in fallbackRun, false);
  assert.equal("tier" in fallbackRun, false);
  assert.equal("fromFallback" in fallbackRun, false);
  const disposition = computeFinalDisposition(fallbackRun);
  assert.equal(disposition.kind, "approve");
  assert.equal(disposition.nativeEvent, "APPROVE");
});

test("pin: route name alone cannot decide the disposition (the engine feeds no route signal)", () => {
  // Two runs identical in every disposition input get identical
  // dispositions — there is no field a route name could flow through.
  const primary = computeFinalDisposition(input({}));
  const sameRunDifferentRouteName = computeFinalDisposition(input({}));
  assert.deepEqual(
    { kind: primary.kind, reason: primary.reason, nativeEvent: primary.nativeEvent },
    { kind: sameRunDifferentRouteName.kind, reason: sameRunDifferentRouteName.reason, nativeEvent: sameRunDifferentRouteName.nativeEvent },
  );
  assert.equal(primary.kind, "approve");
});

test("pin: known-failing required exact-head CI => no APPROVE", () => {
  const disposition = computeFinalDisposition(input({
    evidence: [dispositionEvidence("required_ci_failing", "deterministic", "material", "ci-status-final=failure")],
  }));
  assert.equal(disposition.kind, "incomplete");
  assert.notEqual(disposition.nativeEvent, "APPROVE");
  assert.equal(disposition.approvalCertified, false);
  assert.ok(disposition.recommendation.includes(MATERIAL_CODE_CLAUSES.required_ci_failing));
});

test("the engine evidence builder maps the exact-head CI floor per the audit delta", () => {
  const base = {
    completenessChecks: [],
    obligations: [],
    findings: [],
    toolCapabilityFailure: null,
    toolFloorUnmet: false,
    noEvidenceReason: null,
    partialCoverageStopReason: null,
    requirementTraceIncomplete: false,
    mechanicallyProvenUnmetRequirements: 0,
  };
  // KNOWN failing: material, always.
  const failing = buildDispositionEvidence({ ...base, ciConclusion: "failure", ciEvidenceContractActive: false });
  assert.deepEqual(failing.evidence.map((entry) => entry.code), ["required_ci_failing"]);
  assert.equal(failing.provenUnmetRequirement, false);
  // PENDING with the head-bound evidence contract active: materially
  // required => withholds.
  const pendingRequired = buildDispositionEvidence({ ...base, ciConclusion: "pending", ciEvidenceContractActive: true });
  assert.deepEqual(pendingRequired.evidence.map((entry) => entry.code), ["exact_head_evidence_unavailable"]);
  // PENDING without the contract: NOT a blanket rule — nothing feeds.
  const pendingOptional = buildDispositionEvidence({ ...base, ciConclusion: "pending", ciEvidenceContractActive: false });
  assert.deepEqual(pendingOptional.evidence, []);
  // Success and a gate that never ran contribute nothing.
  assert.deepEqual(buildDispositionEvidence({ ...base, ciConclusion: "success", ciEvidenceContractActive: true }).evidence, []);
  assert.deepEqual(buildDispositionEvidence({ ...base, ciConclusion: null, ciEvidenceContractActive: false }).evidence, []);
});

// ── #1657: trusted row metadata drives materiality on the seam ───────────

const DISPOSITION_BASE = {
  completenessChecks: [] as Array<{ check?: unknown; status?: unknown; reason?: unknown; row_class?: unknown }>,
  obligations: [] as DispositionEvidenceParts["obligations"],
  findings: [] as unknown[],
  toolCapabilityFailure: null as string | null,
  toolFloorUnmet: false,
  noEvidenceReason: null as string | null,
  partialCoverageStopReason: null as string | null,
  requirementTraceIncomplete: false,
  mechanicallyProvenUnmetRequirements: 0,
  ciConclusion: null as string | null,
  ciEvidenceContractActive: false,
};

test("#1657: producer-tagged review-prompt rows are ADVISORY diagnostics on the disposition seam — never material, never proven-unmet", () => {
  const base = { ...DISPOSITION_BASE };
  const rows = [
    // An unresolved tagged review prompt: a non-gating diagnostic.
    { check: "review auth flow for regression", status: "unresolved", reason: "no-disposition", row_class: "review-prompt" },
    // A semantic negative (`unmet`) on a tagged review prompt: recorded for
    // accounting, never an objective proven-unmet requirement (#1657
    // review issue 3) — and it does not set provenUnmetRequirement.
    { check: "verify session token handling is correct", status: "unmet", reason: "ok", row_class: "review-prompt" },
    // A tagged attention row: the same non-gating treatment.
    { check: "treat as high priority — verify correctness carefully", status: "unresolved", reason: "no-disposition", row_class: "attention" },
  ];
  const build = buildDispositionEvidence({ ...base, completenessChecks: rows });
  assert.deepEqual(build.evidence.map((entry) => [entry.code, entry.materiality]), [
    ["generic_scrutiny_row_missing", "advisory"],
    ["generic_scrutiny_row_missing", "advisory"],
    ["generic_scrutiny_row_missing", "advisory"],
  ]);
  assert.equal(build.provenUnmetRequirement, false);
  // The subjects stay the bounded check identities (provenance, not prose).
  assert.deepEqual(build.evidence.map((entry) => entry.subject), [
    "review auth flow for regression",
    "verify session token handling is correct",
    "treat as high priority — verify correctness carefully",
  ]);
});

test("#1657: untagged LEGACY rows keep the conservative material mapping — wording alone can never de-gate a row", () => {
  const base = { ...DISPOSITION_BASE };
  const rows = [
    // Looks exactly like a generic review prompt, but the producer did not
    // tag it: `legacy` — pre-#1657 gating semantics preserved.
    { check: "review auth flow for regression", status: "unresolved", reason: "no-disposition" },
    { check: "check secret rotation impact", status: "unmet", reason: "ok" },
  ];
  const build = buildDispositionEvidence({ ...base, completenessChecks: rows });
  assert.deepEqual(build.evidence.map((entry) => [entry.code, entry.materiality]), [
    ["mandatory_requirement_unresolved", "material"],
    ["mandatory_requirement_unresolved", "material"],
  ]);
  assert.equal(build.provenUnmetRequirement, false);
});

test("#1657: an unresolved explicitly-OBJECTIVE row stays a MATERIAL unknown (objective unresolved receipt state remains material)", () => {
  const base = { ...DISPOSITION_BASE };
  const rows = [
    { check: "review the path resolution in src/paths.ts", status: "unresolved", reason: "receipt-absent", row_class: "objective" },
  ];
  const build = buildDispositionEvidence({ ...base, completenessChecks: rows });
  assert.deepEqual(build.evidence.map((entry) => [entry.code, entry.materiality]), [
    ["mandatory_requirement_unresolved", "material"],
  ]);
  // A model-authored `unmet` on an objective row is likewise a material
  // unknown — never `provenUnmetRequirement` (only the mechanical
  // refutation count proves a requirement false).
  const unmet = buildDispositionEvidence({
    ...base,
    completenessChecks: [{ check: "review the path resolution in src/paths.ts", status: "unmet", reason: "ok", row_class: "objective" }],
    mechanicallyProvenUnmetRequirements: 0,
  });
  assert.deepEqual(unmet.evidence.map((entry) => [entry.code, entry.materiality]), [
    ["mandatory_requirement_unresolved", "material"],
  ]);
  assert.equal(unmet.provenUnmetRequirement, false);
  // The MECHANICAL refutation count remains the only proven-requirement
  // signal (#1145 escalation).
  const mechanical = buildDispositionEvidence({
    ...base,
    completenessChecks: [{ check: "review the path resolution in src/paths.ts", status: "unmet", reason: "ok", row_class: "objective" }],
    mechanicallyProvenUnmetRequirements: 1,
  });
  assert.equal(mechanical.provenUnmetRequirement, true);
});

test("pin: call-ID bookkeeping identified by trusted reason codes => advisory; trace/coverage rows stay conservative", () => {
  const base = {
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
  };
  // #1656 audit round 2: the configured COUNT floor is the one engine-fed
  // advisory signal. Unresolved required-check rows — call-ID allocation
  // refusals included — and the trace's incompleteness stay TRANSITIONAL
  // CONSERVATIVE material unknowns (#1634/#1488 safety contracts; #1657/
  // #1658 have not landed), and there is no prose/wording matching
  // anywhere.
  const bookkeeping = buildDispositionEvidence({
    ...base,
    completenessChecks: [
      { check: "run full test suite after upgrade", status: "unresolved", reason: "citation-already-used" },
      { check: "verify schema migration rollback", status: "unresolved", reason: "uncited-satisfaction" },
      { check: "treat as high priority — verify correctness carefully", status: "unresolved", reason: "no-disposition" },
    ],
    requirementTraceIncomplete: true,
    toolFloorUnmet: true,
  });
  const byCode = new Map(bookkeeping.evidence.map((entry) => [entry.code, entry.materiality]));
  assert.equal(byCode.get("investigation_floor_unmet"), "advisory");
  // Every unresolved row — the allocation refusals included — is a
  // conservative material unknown; no wording-based matcher downgraded it.
  assert.equal(byCode.get("mandatory_requirement_unresolved"), "material");
  assert.equal(bookkeeping.evidence.filter((entry) => entry.code === "mandatory_requirement_unresolved").length, 4);
  const disposition = computeFinalDisposition(input({ evidence: bookkeeping.evidence }));
  assert.equal(disposition.kind, "incomplete");
  assert.equal(disposition.nativeEvent, "COMMENT");
  // With ONLY the trusted-code advisory entries, APPROVE stands.
  const advisoryOnly = computeFinalDisposition(input({
    evidence: [
      dispositionEvidence("citation_allocation_failed", "deterministic", "advisory", "row"),
      dispositionEvidence("investigation_floor_unmet", "deterministic", "advisory", "floor"),
    ],
  }));
  assert.equal(advisoryOnly.kind, "approve");
  assert.equal(advisoryOnly.nativeEvent, "APPROVE");
  // A behavioral unresolved row (no bookkeeping reason) stays material.
  const behavioral = buildDispositionEvidence({
    ...base,
    completenessChecks: [{ check: "verify secrets are not logged or exposed in diffs", status: "unresolved", reason: "no-disposition" }],
  });
  assert.deepEqual(behavioral.evidence.map((entry) => entry.code), ["mandatory_requirement_unresolved"]);
  assert.deepEqual(behavioral.evidence.map((entry) => entry.materiality), ["material"]);
  // The #810 loop-stopped-early record is a conservative material unknown.
  const partial = buildDispositionEvidence({ ...base, completenessChecks: [], partialCoverageStopReason: "context-budget" });
  assert.deepEqual(partial.evidence.map((entry) => entry.code), ["investigation_unavailable"]);
  assert.deepEqual(partial.evidence.map((entry) => entry.materiality), ["material"]);
});

test("the engine evidence builder keeps capability failures material and confirmed negatives proven", () => {
  const base = {
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
  };
  // A tool CAPABILITY failure is material (an abstention, never a block).
  const capability = buildDispositionEvidence({ ...base, toolCapabilityFailure: "all tool requests failed" });
  assert.deepEqual(capability.evidence.map((entry) => entry.code), ["investigation_unavailable"]);
  assert.deepEqual(capability.evidence.map((entry) => entry.materiality), ["material"]);
  // #1656 audit round 3: a model-authored `unmet` is a MATERIAL UNKNOWN —
  // structurally valid, not objectively true. Only the mechanical count
  // proves a requirement.
  const unmet = buildDispositionEvidence({
    ...base,
    completenessChecks: [{ check: "verify audit findings are addressed", status: "unmet" }],
  });
  assert.deepEqual(unmet.evidence.map((entry) => entry.code), ["mandatory_requirement_unresolved"]);
  assert.deepEqual(unmet.evidence.map((entry) => entry.materiality), ["material"]);
  assert.equal(unmet.provenUnmetRequirement, false);
  // The mechanical refutation count is the ONLY proven-requirement signal.
  const mechanical = buildDispositionEvidence({ ...base, mechanicallyProvenUnmetRequirements: 2 });
  assert.equal(mechanical.provenUnmetRequirement, true);
  assert.deepEqual(mechanical.evidence, []);
  // An unresolved risk row is a materially unread affected path.
  const risk = buildDispositionEvidence({
    ...base,
    obligations: [{ id: "risk1", source: "risk", text: "check", status: "unresolved", cause: null, anchors: ["src/auth/session.ts"] } as never],
  });
  assert.deepEqual(risk.evidence.map((entry) => entry.code), ["unread_affected_path"]);
});

test("enforcement helpers split capability failure from the count floor", () => {
  const allFailed = {
    planned_request_count: 1,
    executed_request_count: 1,
    successful_request_count: 0,
    refused_request_count: 0,
    deduplicated_request_count: 0,
    tool_calls: [{ tool: "read_file", args: { path: "a.ts" }, status: "error" }],
    tool_results: [{ tool: "read_file", status: "error", result: { error: "no such file" } }],
  };
  assert.equal(toolCapabilityFailure(allFailed), "all tool requests failed");
  assert.equal(toolCapabilityFailure(null), null);
  assert.equal(toolMinSuccessfulFloorUnmet(null, 2), true);
  assert.equal(toolMinSuccessfulFloorUnmet(null, 0), false);
  assert.equal(toolMinSuccessfulFloorUnmet(allFailed, 1), true);

  const inputs: EnforcementInputs = {
    evidenceBlockerEnabled: false,
    toolFailureEnabled: true,
    toolMinSuccessful: 0,
    evidence: null,
    toolHarness: allFailed,
    threads: null,
    humanReviews: null,
    verdictPolicy: "strict",
  };
  // The fail-closed FORCING signal stays silent for a capability failure.
  assert.equal(failClosedEnforcementFired(inputs), false);

  // The overlays disclose and do not flip the verdict. A harness that
  // dispatched no call renders the min-successful section (the all-failed
  // section owns the failure case).
  const noCalls = {
    planned_request_count: 0,
    executed_request_count: 0,
    successful_request_count: 0,
    refused_request_count: 0,
    deduplicated_request_count: 0,
    tool_calls: [],
    tool_results: [],
  };
  const artifactRecord: Record<string, unknown> = {
    verdict: "approve", verdict_source: "model", review_markdown: "", findings: [],
  };
  const applied = applyAllEnforcement(artifactRecord as never, { ...inputs, toolHarness: noCalls, toolMinSuccessful: 2 });
  assert.equal(applied, 1);
  assert.ok(String(artifactRecord.review_markdown).includes("## Tool Harness Insufficient Evidence"));
  assert.equal(artifactRecord.verdict, "approve");
});

test("proven results still force: an evidence-provider blocker and an unmet obligation stay fail-closed", () => {
  assert.equal(failClosedEnforcementFired({
    evidenceBlockerEnabled: true,
    evidence: { has_blocker: true },
  }), true);
  assert.equal(failClosedEnforcementFired({
    evidenceBlockerEnabled: false,
    evidence: null,
    reviewObligations: [{ id: "mc1", source: "must_check", text: "check", status: "unmet", cause: null }],
  }), true);
});

// ---------------------------------------------------------------------------
// The attestation consumes the SAME disposition object.
// ---------------------------------------------------------------------------

test("the attestation derives its conclusion from the disposition object", () => {
  const certified: FinalDisposition = computeFinalDisposition(input({}));
  const approved = computeReviewAttestation({
    reviewProduced: true,
    verdict: "approve",
    headSha: HEAD,
    disposition: certified,
    publication: { status: "published", native: { event: "APPROVE", submitted: true } },
  });
  assert.equal(approved.conclusion, "approved");
  assert.equal(approved.reason_code, "native_approval_submitted");

  const incomplete: FinalDisposition = computeFinalDisposition(input({
    evidence: [dispositionEvidence("unread_affected_path", "deterministic", "material", "src/auth")],
  }));
  const withheld = computeReviewAttestation({
    reviewProduced: true,
    verdict: "approve",
    headSha: HEAD,
    disposition: incomplete,
    publication: { status: "published", native: { event: "COMMENT", submitted: true } },
  });
  assert.equal(withheld.conclusion, "incomplete");
  assert.equal(withheld.reason_code, "material_unknown");

  // A certification withholding attests `approval_withheld`, never a
  // coverage gap.
  const scopeWithheld: FinalDisposition = computeFinalDisposition(input({ approvalScopeAllowed: false }));
  const scopeAttestation = computeReviewAttestation({
    reviewProduced: true,
    verdict: "approve",
    headSha: HEAD,
    disposition: scopeWithheld,
    publication: { status: "published", native: { event: "COMMENT", submitted: true } },
  });
  assert.equal(scopeAttestation.conclusion, "incomplete");
  assert.equal(scopeAttestation.reason_code, "approval_withheld");

  const blocked: FinalDisposition = computeFinalDisposition(input({ verdict: "request_changes", blockingFindingOpen: true }));
  const blockedAttestation = computeReviewAttestation({
    reviewProduced: true,
    verdict: "request_changes",
    headSha: HEAD,
    disposition: blocked,
    publication: { status: "published", native: { event: "REQUEST_CHANGES", submitted: true } },
  });
  assert.equal(blockedAttestation.conclusion, "blocked");

  const unavailable: FinalDisposition = computeFinalDisposition(input({ degraded: true }));
  const unavailableAttestation = computeReviewAttestation({
    reviewProduced: true,
    verdict: "approve",
    degraded: true,
    headSha: HEAD,
    disposition: unavailable,
    publication: { status: "published", native: { event: "COMMENT", submitted: true } },
  });
  assert.equal(unavailableAttestation.conclusion, "unavailable");
  assert.equal(unavailableAttestation.reason_code, "degraded_no_evidence");

  // The serialized attestation still parses (the machine surfaces agree).
  assert.equal(parseReviewAttestation(JSON.parse(JSON.stringify(approved)))?.conclusion, "approved");
});

// ---------------------------------------------------------------------------
// The run-dir artifact parser is fail-closed and coherence-checked.
// ---------------------------------------------------------------------------

test("parseFinalDisposition accepts the computed object and refuses malformed shapes", () => {
  const disposition: FinalDisposition = computeFinalDisposition(input({
    evidence: [dispositionEvidence("unread_affected_path", "deterministic", "material", "src/auth")],
  }));
  assert.equal(parseFinalDisposition(JSON.parse(JSON.stringify(disposition)))?.kind, "incomplete");
  const certified: FinalDisposition = computeFinalDisposition(input({}));
  assert.equal(parseFinalDisposition(JSON.parse(JSON.stringify(certified)))?.kind, "approve");
  const scopeWithheld: FinalDisposition = computeFinalDisposition(input({ approvalScopeAllowed: false }));
  assert.equal(parseFinalDisposition(JSON.parse(JSON.stringify(scopeWithheld)))?.reason, "approval_withheld");

  // An approve/COMMENT forgery and a vocabulary escape are refused: kind
  // `approve` MUST carry the APPROVE event.
  const forged = JSON.parse(JSON.stringify(certified));
  forged.nativeEvent = "COMMENT";
  assert.equal(parseFinalDisposition(forged), null);

  // The COMPLETE native-event mapping is enforced: every kind carries
  // exactly one event, and any other pairing is refused (the fail-closed
  // unreadable-disposition path takes over).
  const blocked: FinalDisposition = computeFinalDisposition(input({ verdict: "request_changes", blockingFindingOpen: true }));
  const forgedBlockEvent = JSON.parse(JSON.stringify(blocked));
  forgedBlockEvent.nativeEvent = "COMMENT";
  assert.equal(parseFinalDisposition(forgedBlockEvent), null, "request_changes carries exactly REQUEST_CHANGES");
  const forgedIncompleteEvent = JSON.parse(JSON.stringify(disposition));
  forgedIncompleteEvent.nativeEvent = "REQUEST_CHANGES";
  assert.equal(parseFinalDisposition(forgedIncompleteEvent), null, "incomplete carries exactly COMMENT");
  const forgedUnavailableEvent = JSON.parse(JSON.stringify(unreadableFinalDisposition()));
  forgedUnavailableEvent.nativeEvent = "REQUEST_CHANGES";
  assert.equal(parseFinalDisposition(forgedUnavailableEvent), null, "unavailable carries exactly COMMENT");
  assert.equal(parseFinalDisposition({ ...JSON.parse(JSON.stringify(certified)), kind: "clean" }), null);
  assert.equal(parseFinalDisposition(null), null);
  assert.equal(parseFinalDisposition("approve"), null);
});

// ---------------------------------------------------------------------------
// Integration: recommendation, handoff, marker projection and the native
// event all derive from the SAME final object.
// ---------------------------------------------------------------------------

class MockPublishApi implements PublishPlatformApi {
  readonly platform: "github" | "forgejo" = "github";
  readonly nativeReviewSurface: NativeReviewSurface;
  constructor(surface: NativeReviewSurface = { supported: true }) { this.nativeReviewSurface = surface; }
  head: string | null = HEAD;
  sticky: { marker: string; body: string }[] = [];
  submitted: Parameters<PublishPlatformApi["createReview"]>[0][] = [];
  removedLabels: string[] = [];
  comments: never[] = [];
  reviews: never[] = [];
  async getHeadSha(): Promise<string | null> { return this.head; }
  async listIssueComments() { return this.comments; }
  async upsertStickyComment(marker: string, body: string) { this.sticky.push({ marker, body }); return { ok: true, created: true }; }
  async listReviews() { return this.reviews; }
  async listManagedInlineComments() { return { supported: true, complete: true, comments: [] }; }
  async retireInlineComment() { return true; }
  async createReview(request: Parameters<PublishPlatformApi["createReview"]>[0]) { this.submitted.push(request); return { ok: true }; }
  async dismissReview(): Promise<boolean> { return true; }
  async minimizedReviewIds(): Promise<string[]> { return []; }
  async minimizeReview(): Promise<boolean> { return true; }
  async unresolvedSupersededThreads() { return { ok: true, threads: [], hasNextPage: false }; }
  async resolveThread(): Promise<boolean> { return true; }
  async removeLabel(label: string): Promise<boolean> { this.removedLabels.push(label); return true; }
  async requestReviewers(): ReturnType<PublishPlatformApi["requestReviewers"]> {
    return { ok: true, supported: true, requestedUsers: [], requestedTeams: [], alreadyRequestedUsers: [], alreadyRequestedTeams: [] };
  }
}

function publishInput(overrides: Record<string, unknown> = {}): Parameters<typeof publishReview>[0] {
  return {
    mode: "review_verdict", reviewMarkdown: "## Review\n\nBody.", verdict: "approve",
    verdictPolicy: "strict", analysisEngine: "test-engine", baseSha: "base-1", headSha: HEAD,
    prNumber: "42", commentMarker: MARKER, requiredChecks: "complete", reviewRoute: "primary",
    escalationReason: "", cacheHitRatio: "-", inlineFindings: false, inlineFindingsMax: 10,
    findings: [], cleanupPreviousNativeReviews: "false", allowApprove: false, approveForks: false,
    isForkPr: false, upstreamLinkMode: "inert", conditionalPresence: {
      linkedIssue: true, evidenceProvider: true, standards: true,
      toolHarnessFindings: true, toolHarnessResults: true,
    },
    forgejoPositions: false, ...overrides,
  } as Parameters<typeof publishReview>[0];
}

function handoffPayload(body: string): { verdict: string; review_result: string } {
  const match = /<!-- ai-pr-reviewer-handoff:v1 -->\n```json\n([\s\S]*?)\n```/.exec(body);
  assert.ok(match !== null, "the body carries the handoff container");
  return JSON.parse(match![1]!) as { verdict: string; review_result: string };
}

const MATERIAL_AUTH: DispositionEvidence[] = [
  dispositionEvidence("unread_affected_path", "deterministic", "material", "src/auth/session.ts"),
];

test("same object: INCOMPLETE disposition drives recommendation, handoff, marker projection and native event", async () => {
  const disposition = computeFinalDisposition(input({ evidence: MATERIAL_AUTH }));
  const api = new MockPublishApi();
  const result = await publishReview(publishInput({
    finalDisposition: disposition,
    reviewResult: reviewResultFromDisposition(disposition, { strict: true, openFindings: 0 }),
  }), api, { diffText: "" });
  assert.equal(result.status, "published");
  const body = api.submitted[0]!.body;
  // The native event is the disposition's.
  assert.equal(api.submitted[0]!.event, "COMMENT");
  // The recommendation line is the disposition's wording.
  assert.ok(body.includes(disposition.recommendation));
  // The handoff names the disposition's abstention, not a clean approve.
  const handoff = handoffPayload(body);
  assert.equal(handoff.review_result, "partial");
  assert.notEqual(handoff.verdict, "request_changes");
});

test("same object: grounded major drives REQUEST_CHANGES everywhere", async () => {
  const disposition = computeFinalDisposition(input({ verdict: "request_changes", blockingFindingOpen: true }));
  const api = new MockPublishApi();
  await publishReview(publishInput({
    finalDisposition: disposition,
    verdict: "request_changes",
    reviewResult: reviewResultFromDisposition(disposition, { strict: true, openFindings: 1 }),
    findings: [{ severity: "major", category: "bug", file: "src/a.ts", line: 4, message: "grounded major" }],
  }), api, { diffText: "" });
  assert.equal(api.submitted[0]!.event, "REQUEST_CHANGES");
  const body = api.submitted[0]!.body;
  assert.ok(body.includes(disposition.recommendation));
  const handoff = handoffPayload(body);
  assert.equal(handoff.verdict, "request_changes");
  assert.equal(handoff.review_result, "issues");
});

test("same object: advisory-only diagnostics cannot stop a certified APPROVE", async () => {
  const disposition = computeFinalDisposition(input({
    evidence: [dispositionEvidence("generic_scrutiny_row_missing", "deterministic", "advisory", "linked_priority_p1")],
  }));
  const api = new MockPublishApi();
  await publishReview(publishInput({ finalDisposition: disposition }), api, { diffText: "" });
  assert.equal(api.submitted[0]!.event, "APPROVE");
  const body = api.submitted[0]!.body;
  assert.ok(body.includes(disposition.recommendation));
  const handoff = handoffPayload(body);
  assert.equal(handoff.review_result, "clean");
});

test("same object: a degraded no-evidence run publishes UNAVAILABLE, COMMENT, no certified approval", async () => {
  const disposition = computeFinalDisposition(input({ degraded: true }));
  const api = new MockPublishApi();
  await publishReview(publishInput({
    finalDisposition: disposition,
    degradedGateBypass: true,
    reviewResult: reviewResultFromDisposition(disposition, { strict: true, openFindings: 0 }),
  }), api, { diffText: "" });
  assert.equal(api.submitted[0]!.event, "COMMENT");
  const body = api.submitted[0]!.body;
  assert.ok(body.includes(disposition.recommendation));
  assert.ok(body.includes("**Review unavailable**"));
  const handoff = handoffPayload(body);
  assert.equal(handoff.review_result, "partial");
});

test("same object: a fork-scope withholding publishes the advisory-approve line with a COMMENT event", async () => {
  const disposition = computeFinalDisposition(input({ approvalScopeAllowed: false }));
  const api = new MockPublishApi();
  await publishReview(publishInput({
    finalDisposition: disposition,
    approveForks: false,
    isForkPr: true,
    reviewResult: reviewResultFromDisposition(disposition, { strict: true, openFindings: 0 }),
  }), api, { diffText: "" });
  assert.equal(api.submitted[0]!.event, "COMMENT");
  const body = api.submitted[0]!.body;
  assert.ok(body.includes(disposition.recommendation));
  assert.ok(body.includes("Approval withheld by scope policy"));
  const handoff = handoffPayload(body);
  assert.equal(handoff.review_result, "clean");
});

// ---------------------------------------------------------------------------
// Audit round 2: the raw model verdict is not proof of a blocker.
// ---------------------------------------------------------------------------

test("pin: verdict=request_changes with no grounded/proven blocker => INCOMPLETE, never REQUEST_CHANGES, never APPROVE", () => {
  const disposition = computeFinalDisposition(input({ verdict: "request_changes" }));
  assert.equal(disposition.kind, "incomplete");
  assert.equal(disposition.reason, "material_unknown");
  assert.equal(disposition.nativeEvent, "COMMENT");
  assert.notEqual(disposition.kind, "request_changes");
  assert.notEqual(disposition.kind, "approve");
  assert.equal(disposition.approvalCertified, false);
  // The inconsistency is represented as an unverified blocking claim.
  assert.deepEqual(disposition.materialUnknowns.map((entry) => entry.code), ["unverified_blocking_claim"]);
  // A model request_changes WITH a grounded finding is still a block.
  const grounded = computeFinalDisposition(input({ verdict: "request_changes", blockingFindingOpen: true }));
  assert.equal(grounded.kind, "request_changes");
  // ...and with an objectively proven unmet mandatory requirement.
  const proven = computeFinalDisposition(input({ verdict: "request_changes", provenUnmetRequirement: true }));
  assert.equal(proven.kind, "request_changes");
});

// ---------------------------------------------------------------------------
// Audit round 2: the serialized disposition record fails closed.
// ---------------------------------------------------------------------------

test("parseFinalDisposition refuses cross-polarity evidence and a forged certification flag", () => {
  const certified: FinalDisposition = computeFinalDisposition(input({}));
  const materialOnly: FinalDisposition = computeFinalDisposition(input({
    evidence: [dispositionEvidence("unread_affected_path", "deterministic", "material", "src/auth")],
  }));
  assert.equal(parseFinalDisposition(JSON.parse(JSON.stringify(materialOnly)))?.kind, "incomplete");

  // An `approve` carrying a MATERIAL code as advisory is refused.
  const forgedAdvisory = JSON.parse(JSON.stringify(certified));
  forgedAdvisory.advisoryDiagnostics = [{ code: "unread_affected_path", ruledBy: "deterministic", materiality: "advisory", subject: "src/auth" }];
  assert.equal(parseFinalDisposition(forgedAdvisory), null);

  // A material code under advisoryDiagnostics with material materiality is
  // refused (cross-pairing).
  const crossPaired = JSON.parse(JSON.stringify(certified));
  crossPaired.advisoryDiagnostics = [{ code: "unread_affected_path", ruledBy: "deterministic", materiality: "material", subject: "src/auth" }];
  assert.equal(parseFinalDisposition(crossPaired), null);

  // A certification flag that disagrees with the kind is refused.
  const forgedFlag = JSON.parse(JSON.stringify(certified));
  forgedFlag.approvalCertified = false;
  assert.equal(parseFinalDisposition(forgedFlag), null);
  const forgedFlag2 = JSON.parse(JSON.stringify(materialOnly));
  forgedFlag2.approvalCertified = true;
  assert.equal(parseFinalDisposition(forgedFlag2), null);

  // An incomplete abstention carrying materialUnknowns with advisory
  // polarity is refused.
  const forgedIncomplete = JSON.parse(JSON.stringify(materialOnly));
  forgedIncomplete.materialUnknowns = [{ ...forgedIncomplete.materialUnknowns[0], materiality: "advisory" }];
  assert.equal(parseFinalDisposition(forgedIncomplete), null);
});

test("unreadableFinalDisposition: the canonical unavailable abstention for a refused record", () => {
  const disposition = unreadableFinalDisposition();
  assert.equal(disposition.kind, "unavailable");
  assert.equal(disposition.reason, "disposition_unreadable");
  assert.equal(disposition.nativeEvent, "COMMENT");
  assert.equal(disposition.approvalCertified, false);
  // It round-trips through the parser (the artifact-era contract holds).
  assert.equal(parseFinalDisposition(JSON.parse(JSON.stringify(disposition)))?.kind, "unavailable");
});

// ---------------------------------------------------------------------------
// Audit round 2: fail-on-request-changes gates on the FINAL disposition.
// ---------------------------------------------------------------------------

test("pin: raw verdict request_changes + final disposition INCOMPLETE => the workflow does not fail", () => {
  const stage = { FAIL_ON_REQUEST_CHANGES: "true", FAIL_ON_DEGRADED_REVIEW: "false" };
  const disposition = computeFinalDisposition(input({ verdict: "request_changes" }));
  assert.equal(disposition.kind, "incomplete");
  // The disposition — not the raw verdict — is the gate's authority on a
  // #1656 run: an abstention never becomes a blocking workflow failure.
  assert.equal(
    failOnRequestChanges(stage as never, "request_changes", false, false, "[]", "", disposition.kind),
    0,
  );
  // A request_changes DISPOSITION still fails the workflow.
  const blocked = computeFinalDisposition(input({ verdict: "request_changes", blockingFindingOpen: true }));
  assert.equal(
    failOnRequestChanges(stage as never, "request_changes", false, false, "[]", "", blocked.kind),
    1,
  );
  // No disposition (the carried/precheck skip path) keeps the legacy
  // verdict-based behavior.
  assert.equal(failOnRequestChanges(stage as never, "request_changes", false, false, "", ""), 1);
  // UNAVAILABLE with the operator's degraded-failure opt-in still fails.
  assert.equal(
    failOnRequestChanges(stage as never, "approve", true, true, "", "", "unavailable"),
    1,
  );
  assert.equal(
    failOnRequestChanges(stage as never, "approve", true, false, "", "", "unavailable"),
    0,
  );
});

// ---------------------------------------------------------------------------
// Audit round 3: a model-authored `unmet` is NOT objective proof.
// ---------------------------------------------------------------------------

test("pin: must_check `unmet` from the model, no grounded finding/objective refutation => INCOMPLETE/COMMENT", () => {
  const build = buildDispositionEvidence({
    completenessChecks: [{ check: "verify audit findings are addressed", status: "unmet" }],
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
  });
  assert.equal(build.provenUnmetRequirement, false);
  const disposition = computeFinalDisposition(input({ evidence: build.evidence }));
  assert.equal(disposition.kind, "incomplete");
  assert.equal(disposition.nativeEvent, "COMMENT");
  assert.notEqual(disposition.kind, "request_changes");
  assert.notEqual(disposition.kind, "approve");
});

test("pin: trusted-base `unmet` from the model, no grounded finding/objective refutation => INCOMPLETE/COMMENT", () => {
  const build = buildDispositionEvidence({
    completenessChecks: [],
    obligations: [{ id: "tb1", source: "trusted_base_guidance", text: "verify before approval", status: "unmet", cause: null } as never],
    findings: [],
    toolCapabilityFailure: null,
    toolFloorUnmet: false,
    noEvidenceReason: null,
    partialCoverageStopReason: null,
    requirementTraceIncomplete: false,
    mechanicallyProvenUnmetRequirements: 0,
    ciConclusion: null,
    ciEvidenceContractActive: false,
  });
  assert.equal(build.provenUnmetRequirement, false);
  assert.deepEqual(build.evidence.map((entry) => entry.code), ["mandatory_requirement_unresolved"]);
  const disposition = computeFinalDisposition(input({ evidence: build.evidence }));
  assert.equal(disposition.kind, "incomplete");
  assert.equal(disposition.nativeEvent, "COMMENT");
});

test("pin: a grounded major finding still => REQUEST_CHANGES (the ordinary semantic-defect path)", () => {
  const disposition = computeFinalDisposition(input({ verdict: "request_changes", blockingFindingOpen: true }));
  assert.equal(disposition.kind, "request_changes");
  assert.equal(disposition.reason, "blocker_proven");
  assert.equal(disposition.nativeEvent, "REQUEST_CHANGES");
});

test("pin: an explicit mechanical proven-unmet input still => REQUEST_CHANGES", () => {
  const disposition = computeFinalDisposition(input({ provenUnmetRequirement: true }));
  assert.equal(disposition.kind, "request_changes");
  assert.equal(disposition.reason, "requirement_unmet");
  assert.equal(disposition.nativeEvent, "REQUEST_CHANGES");
  // And the builder's mechanical count feeds exactly that input.
  const mechanical = buildDispositionEvidence({
    completenessChecks: [],
    obligations: [],
    findings: [],
    toolCapabilityFailure: null,
    toolFloorUnmet: false,
    noEvidenceReason: null,
    partialCoverageStopReason: null,
    requirementTraceIncomplete: false,
    mechanicallyProvenUnmetRequirements: 1,
    ciConclusion: null,
    ciEvidenceContractActive: false,
  });
  const fromMechanical = computeFinalDisposition(input({ provenUnmetRequirement: mechanical.provenUnmetRequirement }));
  assert.equal(fromMechanical.kind, "request_changes");
});

// ---------------------------------------------------------------------------
// Audit round 3: the recorded zero-evidence degradation is consumed.
// ---------------------------------------------------------------------------

test("pin: a recorded zero-evidence degradation => never APPROVE, in either lane", () => {
  const build = buildDispositionEvidence({
    completenessChecks: [],
    obligations: [],
    findings: [],
    toolCapabilityFailure: null,
    toolFloorUnmet: false,
    noEvidenceReason: "no-tool-calls",
    partialCoverageStopReason: null,
    requirementTraceIncomplete: false,
    mechanicallyProvenUnmetRequirements: 0,
    ciConclusion: null,
    ciEvidenceContractActive: false,
  });
  assert.deepEqual(build.evidence.map((entry) => entry.code), ["investigation_unavailable"]);
  assert.deepEqual(build.evidence.map((entry) => entry.materiality), ["material"]);
  const disposition = computeFinalDisposition(input({ evidence: build.evidence }));
  assert.equal(disposition.kind, "incomplete");
  assert.notEqual(disposition.nativeEvent, "APPROVE");
  // The count floor is NOT this signal: an advisory floor alone still
  // approves — an adequately investigated run with no zero-evidence state.
  const adequateFallback = buildDispositionEvidence({
    completenessChecks: [],
    obligations: [],
    findings: [],
    toolCapabilityFailure: null,
    toolFloorUnmet: true,
    noEvidenceReason: null,
    partialCoverageStopReason: null,
    requirementTraceIncomplete: false,
    mechanicallyProvenUnmetRequirements: 0,
    ciConclusion: null,
    ciEvidenceContractActive: false,
  });
  assert.deepEqual(adequateFallback.evidence.map((entry) => entry.materiality), ["advisory"]);
  const approved = computeFinalDisposition(input({ evidence: adequateFallback.evidence }));
  assert.equal(approved.kind, "approve");
  assert.equal(approved.nativeEvent, "APPROVE");
});

// ---------------------------------------------------------------------------
// Audit round 3: hostile-boundary regression for `boundDispositionSubject`.
// ---------------------------------------------------------------------------

test("#252 hostile boundary: boundDispositionSubject collapses controls and bounds the subject", () => {
  // The hostile token is the boundary itself: control characters (which
  // could forge log lines or break single-line consumers) and oversized
  // input (which could bloat the disposition artifact).
  const controls = "src\u0000/\u001bauth\u0007/\nsession\u007f.ts";
  const bounded = boundDispositionSubject(controls);
  assert.equal(/[\u0000-\u001f\u007f]/.test(bounded), false, "no control character survives");
  assert.ok(bounded.length <= 200, "the subject stays within the cap");
  assert.ok(bounded.includes("src"), "readable content survives the collapse");
  // A 500-char hostile run is bounded to exactly the cap.
  const long = "x".repeat(500);
  assert.equal(boundDispositionSubject(long).length, 200);
  // A forged delimiter-style token is flattened but never grows the
  // subject beyond the cap.
  const forged = "ghadelimiter_" + "a".repeat(300) + "\u0000" + "b".repeat(300);
  const forgedBounded = boundDispositionSubject(forged);
  assert.equal(forgedBounded.length, 200);
  assert.equal(/[\u0000-\u001f\u007f]/.test(forgedBounded), false);
  // Empty and non-hostile inputs are stable.
  assert.equal(boundDispositionSubject(""), "");
  assert.equal(boundDispositionSubject("src/auth/session.ts"), "src/auth/session.ts");
});

// ---------------------------------------------------------------------------
// Audit round 3: the min-successful disclosure never denies a certification.
// ---------------------------------------------------------------------------

test("pin: the min-successful section is diagnostic-only and cannot contradict a certified APPROVE", async () => {
  // The section's own wording: it states the configured floor, not review
  // incompleteness and not a certification denial.
  const artifactRecord: Record<string, unknown> = {
    verdict: "approve", verdict_source: "model", review_markdown: "", findings: [],
  };
  const outcome = applyToolMinSuccessfulEnforcement(artifactRecord as never, 3, null);
  assert.equal(outcome.applied, true);
  const markdown = String(artifactRecord.review_markdown);
  assert.ok(markdown.includes("## Tool Harness Insufficient Evidence"));
  assert.ok(markdown.includes("Diagnostic: this workflow's configured floor"));
  assert.equal(/no approval is certified/.test(markdown), false, "the diagnostic must not deny certification");
  assert.equal(/investigation is incomplete/.test(markdown), false, "the diagnostic must not claim incompleteness");

  // Publication consistency: the same artifact publishes a certified
  // APPROVE beside the diagnostic section with no contradicting prose.
  const disposition = computeFinalDisposition(input({
    evidence: [dispositionEvidence("investigation_floor_unmet", "deterministic", "advisory", "min-successful tool requests unmet")],
  }));
  assert.equal(disposition.kind, "approve");
  assert.equal(disposition.nativeEvent, "APPROVE");
  const api = new MockPublishApi();
  await publishReview(publishInput({
    finalDisposition: disposition,
    reviewMarkdown: markdown,
  }), api, { diffText: "" });
  assert.equal(api.submitted[0]!.event, "APPROVE", "the advisory floor cannot withhold the certified event");
  const body = api.submitted[0]!.body;
  assert.ok(body.includes("## Tool Harness Insufficient Evidence"), "the diagnostic stays observable");
  assert.equal(/no approval is certified/.test(body), false, "no action-owned prose denies the certification");
  assert.equal(/investigation is incomplete/.test(body), false, "no action-owned prose claims incompleteness");
});

// ---------------------------------------------------------------------------
// Vocabulary discipline: the closed sets stay disjoint and total.
// ---------------------------------------------------------------------------

test("the evidence vocabularies are closed and disjoint", () => {
  const material = new Set<string>(MATERIAL_DISPOSITION_CODES);
  const advisory = new Set<string>(ADVISORY_DISPOSITION_CODES);
  for (const code of material) assert.equal(advisory.has(code), false);
  for (const code of advisory) assert.equal(material.has(code), false);
});
