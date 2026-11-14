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
 * - TRANSITIONAL CONSERVATIVE (material, until #1657/#1659 replace
 *   them with principled settlement): unresolved required-check rows
 *   and the #810 loop-stopped-early record. #1656 must not raise native
 *   APPROVE merely because the old proof machinery could not settle
 *   them (#1656 audit round 2). The requirement trace is NO LONGER
 *   transitional — #1658 settled it by provenance: the artifact's
 *   reason-coded summary classes feed this seam (material unresolved →
 *   material unknown; environmental advisory → diagnostic; mechanical
 *   refutation → the proven count; an IN-SCOPE bare claim → a material
 *   unknown; an out-of-scope claim → disclosure only, never a veto).
 */
import { isUnverifiedBlockingGrounding } from "../enforcement/verdict-policy.js";
import type { ReviewObligation } from "../enforcement/review-obligations.js";
import type { LoopEvidenceSettlement } from "../enforcement/settlement.js";
import { dispositionEvidence, type DispositionEvidence } from "./final.js";

export interface DispositionEvidenceParts {
  /** The completeness fold's rows: `{check, status, reason}` plus the
   * additive #1657 trusted metadata — `row_class` (attention / objective /
   * review-prompt / legacy) and `evidence` ({gate, state, receipt_ids}) —
   * which decide materiality here. Untagged rows are `legacy`. */
  completenessChecks: ReadonlyArray<{ check?: unknown; status?: unknown; reason?: unknown; row_class?: unknown; evidence?: unknown }>;
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
  /** #1658 summary class: at least one unresolved requirement-trace row
   * whose relevance class is MATERIAL (missing claim, invalid objective
   * provenance, malformed/unusable semantic claim, or an unresolved
   * mechanically decidable row on an in-scope mandatory requirement) — a
   * material unknown that withholds approval (INCOMPLETE). Replaces the
   * pre-#1658 TRANSITIONAL flag mapping: #1658 narrowed
   * `requirement_trace_incomplete` to deterministic refutations only, so
   * the artifact's summary classes, not the flag, settle these rows. */
  traceUnresolvedMaterial: boolean;
  /** #1658 summary class: at least one IN-SCOPE `unmet_claimed` row (the
   * reviewer's own well-formed gap claim, #1095 — substantive, never
   * confirmed and never a refutation). A material unknown that withholds
   * approval (INCOMPLETE): a claim alone can never certify an approve.
   * The disposition's fixed precedence means an ordinary grounded
   * blocker/major finding still yields REQUEST_CHANGES through the
   * existing finding path; an OUT-OF-SCOPE claim must not reach this
   * part (the caller distinguishes via the row's
   * `out-of-scope-reported-unmet` marker), so a scope-settled claim can
   * never independently prevent APPROVE. */
  traceUnmetClaimed: boolean;
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
  /**
   * #1659: the canonical per-row evidence-settlement record the native loop
   * persisted in the harness artifact's telemetry budget block
   * (`tool_loop_telemetry.budget.required_evidence_settlements`), parsed
   * fail-closed. Empty for legacy artifacts and every non-native path — the
   * pre-#1659 behavior. Objective provenance only: the record never
   * certifies a semantic resolution by itself (the #1657 boundary). It stops
   * the loop's settlement state from being lost between loop → verdict →
   * fallback → finalization, so a cap/budget release is disclosed as an
   * unknown instead of reading as completed.
   */
  loopSettlements?: ReadonlyArray<LoopEvidenceSettlement>;
}

/** The trusted #1657 row class of one completeness row, read from the
 * producer metadata the fold persisted (`row_class`). An unparseable or
 * absent tag means `legacy` — pre-#1657 gating semantics, never a prose
 * guess. */
function readRowClass(row: { row_class?: unknown }): "attention" | "objective" | "review-prompt" | "legacy" {
  const value = row.row_class;
  return value === "attention" || value === "objective" || value === "review-prompt" ? value : "legacy";
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
  // through its own reason code (#1656 audit delta) AND its own trusted
  // #1657 row class. Materiality per class:
  // - `objective` (producer-tagged mechanical gate): an `unmet` or
  //   `unresolved` row is a MATERIAL unknown (the objective unresolved
  //   receipt state stays material — receipts prove acquisition, never
  //   semantic correctness), and only the MECHANICAL refutation count
  //   below can prove a requirement false — a model-authored `unmet` is
  //   never objective proof (#1656 audit round 3).
  // - `legacy` (no trusted producer tag): pre-#1657 conservative
  //   semantics — the row gates exactly as before.
  // - `review-prompt` / `attention` (producer-tagged semantic review
  //   questions / attention signals): non-gating diagnostics — recorded as
  //   ADVISORY `generic_scrutiny_row_missing` from the trusted row
  //   metadata; the semantic negative belongs in a grounded finding and
  //   the final disposition (#1656/#1659), never in this seam.
  for (const row of parts.completenessChecks) {
    const check = typeof row.check === "string" ? row.check : "";
    const rowClass = readRowClass(row);
    const nonGating = rowClass === "review-prompt" || rowClass === "attention";
    if (row.status === "unmet") {
      if (nonGating) {
        // A semantic negative on a non-gating review prompt: recorded for
        // accounting, never an objective proven-unmet requirement (#1657
        // review) — an ordinary grounded defect blocks through a
        // blocker/major finding.
        evidence.push(dispositionEvidence("generic_scrutiny_row_missing", "deterministic", "advisory", check));
        continue;
      }
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
    if (nonGating) {
      // A producer-tagged review prompt or attention row left unresolved:
      // a non-gating diagnostic from trusted row metadata (#1657) — never
      // the material-unknown floor this TRANSITIONAL entry used to apply.
      evidence.push(dispositionEvidence("generic_scrutiny_row_missing", "deterministic", "advisory", check));
      continue;
    }
    // An unresolved objective row: its receipt state (receipt-absent /
    // receipt-unverified / receipt-mismatch / trace-refused) is trusted
    // provenance and the row stays a MATERIAL unknown — objective
    // unresolved receipt state remains material (#1657). A legacy row
    // keeps the TRANSITIONAL CONSERVATIVE mapping (pre-#1657 semantics).
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
  // The requirement trace settles by PROVENANCE (#1658 replaced the
  // TRANSITIONAL flag mapping): the artifact's reason-coded summary
  // classes decide materiality — this module consumes the classes and
  // never re-derives them. `confirmed_unmet` rows are NOT an unknown
  // here: they are the mechanical current-head refutation counted above
  // (`provenUnmetRequirement`). Material unresolved rows (missing
  // claims, invalid objective provenance, malformed claims) withhold
  // approval as a MATERIAL unknown, and so does an IN-SCOPE
  // `unmet_claimed` row: the reviewer's own gap claim is substantive —
  // a claim alone can never certify an approve — but it is never
  // converted into a refutation or a synthesized blocker: when a
  // grounded blocker/major finding already carries the claim, the fixed
  // precedence below yields REQUEST_CHANGES through the finding path.
  // Out-of-scope claims must not reach this part, and
  // `unresolved_advisory` (environmental unknowns, #1062)
  // stays a diagnostic on the artifact and can never veto approval.
  if (parts.traceUnresolvedMaterial) {
    evidence.push(dispositionEvidence("mandatory_requirement_unresolved", "deterministic", "material", "requirement-trace:unresolved-material"));
  }
  if (parts.traceUnmetClaimed) {
    evidence.push(dispositionEvidence("mandatory_requirement_unresolved", "deterministic", "material", "requirement-trace:unmet-claimed"));
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

  // #1659: the loop's own settlement record. A cap/budget release is NOT a
  // semantic settlement: a cap-released MATERIAL question becomes a named
  // material unknown (`investigation_unavailable`) — never "settled clean" —
  // and a cap-released ADVISORY question becomes an advisory entry that
  // never vetoes the approval. Terminal (`discharged`) and `open` rows
  // contribute nothing here: a discharged row is the loop's settled terminal
  // state (provenance only — it never certifies the semantics, #1657), and
  // an `open` row is already covered by the fold/completeness evidence
  // above — one question yields one evidence entry. Trace-kind rows are
  // skipped: the requirement trace settles by PROVENANCE (#1658) through the
  // summary classes above, so the record must not double-count it.
  const resolvedSatisfied = new Set(
    parts.obligations.filter((o) => o.status === "satisfied").map((o) => o.id),
  );
  for (const settlement of parts.loopSettlements ?? []) {
    if (settlement.settledVia !== "cap-released" || settlement.kind === "trace") continue;
    if (resolvedSatisfied.has(settlement.id)) continue;
    evidence.push(
      dispositionEvidence(
        "investigation_unavailable",
        "deterministic",
        settlement.materiality,
        `cap-released unprovable: ${settlement.id}`,
      ),
    );
  }

  return { evidence, provenUnmetRequirement };
}
