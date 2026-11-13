/**
 * The engine-side builder for the #1656 disposition evidence seam.
 *
 * A pure function over the run's own deterministic parts — the completeness
 * fold rows, the obligation fold rows, the verified findings, the tool
 * capability record, the #810 partial-coverage record, the #874 requirement-
 * trace flag and the CI gate's exact-head conclusion — producing the
 * reason-coded `DispositionEvidence` list the authoritative disposition
 * consumes, plus the confirmed-negative flag.
 *
 * Materiality mapping (#1656 + audit delta):
 * - MATERIAL: a confirmed-negative obligation (`unmet` — proven, and it
 *   also drives `provenUnmetRequirement`), an unresolved behavioral
   * required check (the `required_check=incomplete` BIT itself is never
 *   read), a risk-scan unread affected path, an undischarged derived/
 *   trusted-base obligation, an unverified current-head blocker/major
 *   claim, a tool CAPABILITY failure (planning/execution error, every call
 *   failed, a recorded no-evidence degradation), known-failing required
 *   exact-head CI, and materially-required pending CI.
 * - ADVISORY: the citation-gate reason family (call-ID allocation,
 *   uncited/unrelated/parse failures — a compatibility diagnostic while
 *   #1657 is in flight), a generic-scrutiny row, the requirement-trace
 *   proof-shape/coverage rows (a compatibility diagnostic while #1658 is
 *   in flight), the configured min-successful CALL-COUNT floor, and the
 *   #810 loop-stopped-early record — none of them defines investigation
 *   adequacy by itself.
 */
import { isUnverifiedBlockingGrounding } from "../enforcement/verdict-policy.js";
import { isForcingObligation, type ReviewObligation } from "../enforcement/review-obligations.js";
import { dispositionEvidence, isGenericScrutinyCheckText, type DispositionEvidence } from "./final.js";

/** The #1627/#1634 citation-gate rejection reasons — the call-ID proof
 * machinery's own shapes. All of them are compatibility diagnostics for the
 * disposition while #1657 re-owns the evidence internals. */
const CITATION_GATE_REASONS: ReadonlySet<string> = new Set([
  "citation-already-used",
  "uncited-satisfaction",
  "unrelated-executed-call",
  "malformed-executed-trace",
]);

export interface DispositionEvidenceParts {
  /** The completeness fold's rows: `{check, status, reason}`. */
  completenessChecks: ReadonlyArray<{ check?: unknown; status?: unknown; reason?: unknown }>;
  /** The obligation fold's rows. */
  obligations: ReadonlyArray<ReviewObligation>;
  /** The final verified findings (for the unverified-blocking-claim floor). */
  findings: ReadonlyArray<unknown>;
  /** The tool CAPABILITY failure reason (planning/execution error, every
   * call failed), or null. Never a call count. */
  toolCapabilityFailure: string | null;
  /** True when the configured min-successful CALL-COUNT floor was unmet —
   * advisory only (#1656 audit delta). */
  toolFloorUnmet: boolean;
  /** The harness's recorded no-evidence degradation reason
   * (`native_loop_degraded`), or null — an evidence-availability fact in
   * either lane (#1656 audit delta: never a route/tier rule). */
  noEvidenceReason: string | null;
  /** The #810 partial-coverage stop reason, or null — advisory disclosure
   * only (#1656 audit delta). */
  partialCoverageStopReason: string | null;
  /** The #874 requirement-trace incompleteness flag — a compatibility
   * diagnostic (proof-shape/coverage-repair rows) while #1658 is in
   * flight; the trace's confirmed-unmet rows escalate as synthesized
   * blockers BEFORE this builder runs. */
  requirementTraceIncomplete: boolean;
  /** The CI gate's exact-head conclusion ("success" | "failure" |
   * "pending" | "none"), or null when the gate did not run. */
  ciConclusion: string | null;
  /** True when the CI gate produced head-bound check evidence (#1594) —
   * the signal that CI is materially required for this run, so a PENDING
   * conclusion withholds (#1656 audit delta: never a blanket rule). */
  ciEvidenceContractActive: boolean;
}

export interface DispositionEvidenceBuild {
  evidence: DispositionEvidence[];
  /** True when a mandatory objective requirement is objectively proven
   * unmet (a confirmed-negative row) — an APPROVE-floor failure that ranks
   * with a proven defect. */
  provenUnmetRequirement: boolean;
}

export function buildDispositionEvidence(parts: DispositionEvidenceParts): DispositionEvidenceBuild {
  const evidence: DispositionEvidence[] = [];
  let provenUnmetRequirement = false;

  // The completeness fold's rows (the required-check contract). The
  // `required_checks=incomplete` BIT is never read here — each row speaks
  // through its own reason code (#1656 audit delta).
  for (const row of parts.completenessChecks) {
    const check = typeof row.check === "string" ? row.check : "";
    if (row.status === "unmet") {
      provenUnmetRequirement = true;
      continue;
    }
    if (row.status !== "unresolved" || check === "") continue;
    if (typeof row.reason === "string" && CITATION_GATE_REASONS.has(row.reason)) {
      // #1656 audit delta: a call-ID bookkeeping failure alone is advisory.
      evidence.push(dispositionEvidence("citation_allocation_failed", "deterministic", "advisory", check));
    } else if (isGenericScrutinyCheckText(check)) {
      evidence.push(dispositionEvidence("generic_scrutiny_row_missing", "deterministic", "advisory", check));
    } else {
      evidence.push(dispositionEvidence("mandatory_requirement_unresolved", "deterministic", "material", check));
    }
  }

  // The obligation fold's rows: forcing rows are confirmed negatives; the
  // coverage-only sources are material unknowns of their own kind.
  // must_check rows are the completeness fold's rows above — skipped here so
  // one row yields one evidence entry.
  for (const obligation of parts.obligations) {
    if (isForcingObligation(obligation)) {
      provenUnmetRequirement = true;
      continue;
    }
    if (obligation.status !== "unresolved") continue;
    if (obligation.source === "risk") {
      const anchors = (obligation.anchors ?? []).join(", ");
      evidence.push(dispositionEvidence("unread_affected_path", "deterministic", "material", anchors !== "" ? anchors : obligation.id));
    } else if (obligation.source !== "must_check") {
      evidence.push(dispositionEvidence("mandatory_requirement_unresolved", "deterministic", "material", obligation.id));
    }
  }

  // An unverified blocker/major demotion (the verifier could not check the
  // claim) is a MATERIAL UNKNOWN, not a forced code blocker (#1656).
  for (const finding of parts.findings) {
    if (isUnverifiedBlockingGrounding(finding as never)) {
      const record = finding as { file?: unknown; line?: unknown };
      const file = typeof record.file === "string" ? record.file : "unlocated";
      const line = typeof record.line === "number" && Number.isInteger(record.line) ? `:${record.line}` : "";
      evidence.push(dispositionEvidence("unverified_blocking_claim", "deterministic", "material", `${file}${line}`));
    }
  }

  // A tool CAPABILITY failure is an abstention (`investigation_unavailable`),
  // never a fabricated code blocker (#1656). The configured CALL-COUNT
  // floor is advisory — a count must never define adequacy (#1656 audit
  // delta).
  if (parts.toolCapabilityFailure !== null) {
    evidence.push(dispositionEvidence("investigation_unavailable", "deterministic", "material", parts.toolCapabilityFailure));
  }
  if (parts.toolFloorUnmet) {
    evidence.push(dispositionEvidence("investigation_floor_unmet", "deterministic", "advisory", "min-successful tool requests unmet"));
  }
  // A recorded no-evidence degradation is an evidence-availability fact in
  // EITHER lane — never a route/tier rule (#1656 audit delta).
  if (parts.noEvidenceReason !== null) {
    evidence.push(dispositionEvidence("investigation_unavailable", "deterministic", "material", parts.noEvidenceReason));
  }
  // The loop stopping early is disclosure, not a blanket veto (#1656 audit
  // delta); whether the affected behavior lacked evidence is a seam
  // question (#1657).
  if (parts.partialCoverageStopReason !== null) {
    evidence.push(dispositionEvidence("investigation_partial", "deterministic", "advisory", parts.partialCoverageStopReason));
  }
  // The requirement trace's remaining incompleteness is proof-shape/
  // coverage-repair territory — a compatibility diagnostic while #1658 is
  // in flight (#1656 audit delta); its confirmed-unmet rows already
  // escalated as synthesized blockers before this builder runs.
  if (parts.requirementTraceIncomplete) {
    evidence.push(dispositionEvidence("proof_shape_mismatch", "deterministic", "advisory", "requirement-trace"));
  }

  // The exact-head CI floor (#1656 audit delta): a KNOWN failing conclusion
  // can never certify an approval; a PENDING one withholds only when the
  // head-bound CI-evidence contract proves CI materially required for this
  // run — never as a blanket rule. A gate that did not run contributes
  // nothing.
  if (parts.ciConclusion === "failure") {
    evidence.push(dispositionEvidence("required_ci_failing", "deterministic", "material", "ci-status-final=failure"));
  } else if (parts.ciConclusion === "pending" && parts.ciEvidenceContractActive) {
    evidence.push(dispositionEvidence("exact_head_evidence_unavailable", "deterministic", "material", "required ci pending"));
  }

  return { evidence, provenUnmetRequirement };
}
