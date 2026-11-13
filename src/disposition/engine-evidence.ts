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
 * Materiality mapping (#1656, through audit round 3):
 * - MATERIAL: a model-authored `unmet` required-check/obligation row (a
 *   usable rationale makes the disposition structurally VALID, not
 *   objectively TRUE — without a mechanical current-head refutation it is
 *   a material unknown, never `provenUnmetRequirement`; #1656 audit round
 *   3), an unresolved behavioral required check (the
 *   `required_check=incomplete` BIT itself is never read), a risk-scan
 *   unread affected path, an undischarged derived/trusted-base
 *   obligation, an unverified current-head blocker/major claim, a tool
 *   CAPABILITY failure (planning/execution error, every call failed), a
 *   RECORDED zero-evidence loop degradation (lane-independent — the
 *   harness's own record, never a route/tier name), known-failing
 *   required exact-head CI, and materially-required pending CI.
 * - ADVISORY: the operator-configured min-successful CALL-COUNT floor
 *   only — a count must never define adequacy. No prose/wording matching
 *   exists anywhere in this module: lexical materiality inference is
 *   forbidden (#1656 audit round 2).
 * - TRANSITIONAL CONSERVATIVE (material, until #1657/#1658/#1659 replace
 *   them with principled settlement): the requirement trace's remaining
 *   incompleteness, unresolved required-check rows, and the #810
 *   loop-stopped-early record. #1656 must not raise native APPROVE merely
 *   because the old proof machinery could not settle them (#1656 audit
 *   round 2).
 */
import { isUnverifiedBlockingGrounding } from "../enforcement/verdict-policy.js";
import type { ReviewObligation } from "../enforcement/review-obligations.js";
import { dispositionEvidence, type DispositionEvidence } from "./final.js";

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
  /** The #810 partial-coverage stop reason, or null — a TRANSITIONAL
   * CONSERVATIVE material unknown until #1657 settles it (#1656 audit
   * round 2). */
  partialCoverageStopReason: string | null;
  /** The #874 requirement-trace incompleteness flag — a TRANSITIONAL
   * CONSERVATIVE material unknown while #1658 is in flight; the trace's
   * mechanically refuted rows escalate as synthesized blockers BEFORE
   * this builder runs. */
  requirementTraceIncomplete: boolean;
  /** The harness's recorded zero-evidence degradation reason
   * (`native_loop_degraded` — the loop ran and the model issued no tool
   * calls), or null. A recorded zero-evidence degradation is MATERIAL in
   * either lane — the harness's own record, never a route/tier name
   * (#1656 audit round 3). Distinct from the min-successful COUNT floor. */
  noEvidenceReason: string | null;
  /** The count of requirements a MECHANICAL current-head refutation
   * proved false (the #1145 confirmed-unmet escalation, re-derived from
   * the checkout at head). The ONLY signal allowed to set
   * `provenUnmetRequirement` (#1656 audit round 3). */
  mechanicallyProvenUnmetRequirements: number;
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
      // #1656 audit round 3: the model's structured `unmet` is NOT
      // objective proof — a usable rationale makes it structurally valid,
      // not objectively true. Without a mechanical current-head
      // refutation it is a MATERIAL UNKNOWN (INCOMPLETE/COMMENT), never a
      // proven requirement and never a silent approve. An ordinary
      // semantic defect blocks through a grounded blocker/major finding.
      evidence.push(dispositionEvidence("mandatory_requirement_unresolved", "deterministic", "material", check));
      continue;
    }
    if (row.status !== "unresolved" || check === "") continue;
    // #1656 audit round 2: an unresolved required-check row whose
    // satisfaction could not be backed (including the call-ID allocation
    // refusals) stays a TRANSITIONAL CONSERVATIVE material unknown — the
    // #1634 safety contract pins that unbacked satisfactions withhold the
    // approval, and #1656 must not raise native APPROVE merely because the
    // old proof machinery could not settle the row. The trusted reason
    // codes stay visible in the completeness artifact; #1657 may feed
    // proven bookkeeping-only advisory entries through the seam once it
    // owns the settlement.
    evidence.push(dispositionEvidence("mandatory_requirement_unresolved", "deterministic", "material", check));
  }

  // The obligation fold's rows. #1656 audit round 3: materiality is never
  // inferred from the row's source name or via `isForcingObligation` — a
  // model-authored `unmet` is a material unknown, and only the mechanical
  // count below may prove a requirement false. must_check rows are the
  // completeness fold's rows above — skipped here so one row yields one
  // evidence entry.
  for (const obligation of parts.obligations) {
    if (obligation.status === "unmet") {
      if (obligation.source !== "must_check") {
        evidence.push(dispositionEvidence("mandatory_requirement_unresolved", "deterministic", "material", obligation.id));
      }
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
  // The ONLY proven-requirement signal: a mechanical current-head
  // refutation (the #1145 confirmed-unmet escalation's count). Everything
  // the model asserted stays subject to the material-unknown floor.
  provenUnmetRequirement = parts.mechanicallyProvenUnmetRequirements > 0;

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
  // A RECORDED zero-evidence degradation (the loop ran; the model issued
  // no tool calls) is a material unknown in either lane — the harness's
  // own record, never a route/tier rule (#1656 audit round 3). Distinct
  // from the advisory count floor above.
  if (parts.noEvidenceReason !== null) {
    evidence.push(dispositionEvidence("investigation_unavailable", "deterministic", "material", parts.noEvidenceReason));
  }
  // The loop stopping early is a TRANSITIONAL CONSERVATIVE material
  // unknown (#1656 audit round 2): while #1657 has not landed, the run
  // cannot prove the affected behavior had adequate available evidence, so
  // the approval is withheld inside this disposition — never re-derived by
  // a downstream guardrail.
  if (parts.partialCoverageStopReason !== null) {
    evidence.push(dispositionEvidence("investigation_unavailable", "deterministic", "material", parts.partialCoverageStopReason));
  }
  // The requirement trace's remaining incompleteness is a TRANSITIONAL
  // CONSERVATIVE material unknown (#1656 audit round 2): #1658 has not
  // landed, so the disposition must not certify an approve while the trace
  // could not settle its rows — the refuted rows already escalated as
  // synthesized blockers before this builder runs. #1658 will replace this
  // with provenance-based settlement (the seam's `proof_shape_mismatch`
  // advisory code stands ready for trusted provenance).
  if (parts.requirementTraceIncomplete) {
    evidence.push(dispositionEvidence("mandatory_requirement_unresolved", "deterministic", "material", "requirement-trace"));
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
