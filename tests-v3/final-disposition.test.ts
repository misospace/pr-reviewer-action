import test from "node:test";
import assert from "node:assert/strict";
import {
  ADVISORY_DISPOSITION_CODES,
  MATERIAL_CODE_CLAUSES,
  MATERIAL_DISPOSITION_CODES,
  computeFinalDisposition,
  dispositionEvidence,
  isGenericScrutinyCheckText,
  parseFinalDisposition,
  reviewResultFromDisposition,
  type DispositionEvidence,
  type FinalDisposition,
  type FinalDispositionInput,
} from "../src/disposition/final.js";
import { buildDispositionEvidence } from "../src/disposition/engine-evidence.js";
import { applyStrictVerdictPolicy } from "../src/enforcement/verdict-policy.js";
import {
  applyAllEnforcement,
  failClosedEnforcementFired,
  toolCapabilityFailure,
  toolMinSuccessfulFloorUnmet,
  type EnforcementInputs,
} from "../src/enforcement/enforce.js";
import { computeReviewAttestation, parseReviewAttestation } from "../src/publish/attestation.js";
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

test("pin: a generic scrutiny/checklist bookkeeping failure alone => advisory, does not veto APPROVE", () => {
  // The classifier's own P0/P1 exhortation rows are generic scrutiny.
  assert.equal(isGenericScrutinyCheckText("treat as critical — verify all changes thoroughly"), true);
  assert.equal(isGenericScrutinyCheckText("treat as high priority — verify correctness carefully"), true);
  // A behavioral row stays material: it names concrete behavior.
  assert.equal(isGenericScrutinyCheckText("review for path traversal vulnerabilities"), false);
  assert.equal(isGenericScrutinyCheckText("verify secrets are not logged or exposed in diffs"), false);
  assert.equal(isGenericScrutinyCheckText("run full test suite after upgrade"), false);

  const disposition = computeFinalDisposition(input({
    evidence: [
      dispositionEvidence("generic_scrutiny_row_missing", "deterministic", "advisory", "linked_priority_p1"),
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

test("pin: generic trace/call-ID bookkeeping failure alone => advisory, never an authority", () => {
  const base = {
    obligations: [],
    findings: [],
    toolCapabilityFailure: null,
    toolFloorUnmet: false,
    noEvidenceReason: null,
    partialCoverageStopReason: null,
    requirementTraceIncomplete: false,
    ciConclusion: null,
    ciEvidenceContractActive: false,
  };
  // The whole compatibility family is advisory: trace proof-shape rows,
  // the citation-gate reasons, the min-successful COUNT floor, the
  // loop-stopped-early record, and the required-check BIT is never read.
  const bookkeeping = buildDispositionEvidence({
    ...base,
    completenessChecks: [
      { check: "run full test suite after upgrade", status: "unresolved", reason: "citation-already-used" },
      { check: "verify schema migration rollback", status: "unresolved", reason: "uncited-satisfaction" },
      { check: "treat as high priority — verify correctness carefully", status: "unresolved", reason: "no-disposition" },
    ],
    requirementTraceIncomplete: true,
    toolFloorUnmet: true,
    partialCoverageStopReason: "context-budget",
  });
  assert.deepEqual(bookkeeping.evidence.map((entry) => entry.materiality), Array(bookkeeping.evidence.length).fill("advisory"));
  assert.deepEqual(
    new Set(bookkeeping.evidence.map((entry) => entry.code)),
    new Set(["citation_allocation_failed", "generic_scrutiny_row_missing", "proof_shape_mismatch", "investigation_floor_unmet", "investigation_partial"]),
  );
  // With nothing else standing, the disposition still certifies APPROVE.
  const disposition = computeFinalDisposition(input({ evidence: bookkeeping.evidence }));
  assert.equal(disposition.kind, "approve");
  assert.equal(disposition.nativeEvent, "APPROVE");
  // A behavioral unresolved row (not bookkeeping) stays material.
  const behavioral = buildDispositionEvidence({
    ...base,
    completenessChecks: [{ check: "verify secrets are not logged or exposed in diffs", status: "unresolved", reason: "no-disposition" }],
  });
  assert.deepEqual(behavioral.evidence.map((entry) => entry.code), ["mandatory_requirement_unresolved"]);
  assert.deepEqual(behavioral.evidence.map((entry) => entry.materiality), ["material"]);
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
    ciConclusion: null,
    ciEvidenceContractActive: false,
  };
  // A tool CAPABILITY failure is material (an abstention, never a block).
  const capability = buildDispositionEvidence({ ...base, toolCapabilityFailure: "all tool requests failed" });
  assert.deepEqual(capability.evidence.map((entry) => entry.code), ["investigation_unavailable"]);
  assert.deepEqual(capability.evidence.map((entry) => entry.materiality), ["material"]);
  // A recorded no-evidence degradation is material in either lane.
  const noEvidence = buildDispositionEvidence({ ...base, noEvidenceReason: "native loop degraded: provider exhausted" });
  assert.deepEqual(noEvidence.evidence.map((entry) => entry.code), ["investigation_unavailable"]);
  // A confirmed-negative obligation stays proven.
  const unmet = buildDispositionEvidence({
    ...base,
    obligations: [{ id: "mc1", source: "must_check", text: "check", status: "unmet", cause: null } as never],
  });
  assert.equal(unmet.provenUnmetRequirement, true);
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
// Vocabulary discipline: the closed sets stay disjoint and total.
// ---------------------------------------------------------------------------

test("the evidence vocabularies are closed and disjoint", () => {
  const material = new Set<string>(MATERIAL_DISPOSITION_CODES);
  const advisory = new Set<string>(ADVISORY_DISPOSITION_CODES);
  for (const code of material) assert.equal(advisory.has(code), false);
  for (const code of advisory) assert.equal(material.has(code), false);
});
