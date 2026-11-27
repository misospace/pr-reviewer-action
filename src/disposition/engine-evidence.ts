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
import { foldOwnershipForDependencyQuestions, type FinalSettlementRow } from "../enforcement/settlement.js";
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
  /** #1753: true when the requirement trace degraded at least one satisfied
   * ordinary-runtime row to ADVISORY proof-shape bookkeeping because the
   * claim emitted NO enforcement-location citation while still disclosing
   * its evidence (the `satisfied-no-enforcement-citation` note). Feeds the
   * reserved ADVISORY `proof_shape_mismatch` code — the omission stays
   * observable on the authoritative disposition, never vetoing: the
   * reviewer's satisfied conclusion is the semantic answer and a missing
   * validator-shaped field is serialization bookkeeping, not a demonstrated
   * material gap. Optional so pre-#1753 callers compile; absent = no
   * signal. */
  traceProofShapeOmission?: boolean;
  /** #1678 hardening: the authoritative closing verdict's
   * `requirement_coverage` failed the exact-set requirement-decision contract
   * (rows missing, duplicated, unexpected, malformed, or absent while
   * in-scope requirements exist) even after that lane's single bounded
   * correction. An invalid serialization withholds approval as its own
   * material code — distinct from the trace's per-row
   * `mandatory_requirement_unresolved`, so the INCOMPLETE reason names the
   * serialization failure instead of pretending seven semantic unknowns were
   * ever answered. Optional so pre-#1678 callers compile; absent = no signal. */
  verdictContractIncomplete?: boolean;
  /** The harness's recorded zero-evidence degradation reason
   * (`native_loop_degraded` — written only for a zero-call stop the LOOP
   * chose: a transport failure or deadline before any model reply; the
   * model's own no-tool-calls reply is a deliberate corpus-direct
   * completion and is not recorded as a degradation, #1837), or null. A
   * recorded zero-evidence degradation is MATERIAL in either lane — the
   * harness's own record, never a route/tier name (#1656 audit round 3).
   * Distinct from the min-successful COUNT floor. */
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
   * #1659: the canonical post-verdict settlement rows — the native loop's
   * evidence state (`acquired`/`cap-released`/`open`) JOINED with the fold's
   * semantic outcome (`resolved`/`finding`/`unknown`/`not-tracked`) by
   * `reconcileSettlements` over the SAME `obligations` above (dependency shape
   * rows join their fold row through the row's own text). Persisted in
   * `review-coverage.json`; absent for legacy artifacts and every non-native
   * path (the pre-#1659 behavior). Objective provenance only: a successful
   * call never certifies a semantic resolution (#1657), and a cap/budget
   * release or a failed acquisition is never a clean settlement. The record
   * discloses exactly what no fold carries — a MATERIAL question with no
   * semantic resolution becomes `investigation_unavailable`, a non-material
   * one the ADVISORY `investigation_partial` diagnostic — and `foldCovered`
   * is what keeps a question the folds already own from being counted twice.
   */
  finalSettlements?: ReadonlyArray<FinalSettlementRow>;
  /** #1659: how many persisted settlement rows the strict reader refused
   * (present-but-malformed record). Any drop is a MATERIAL
   * `investigation_unavailable` disclosure, never silence. Absent/0 is the
   * clean and the legacy shape alike. */
  settlementRecordDroppedRows?: number;
  /**
   * #1645: the run's `thread_reconciliation` artifact field — the bounded
   * provenance of the settlement-time reconciliation of CARRIED review-thread
   * findings against the live forge thread listing (null/absent when no
   * reconciliation ran). Consumed as PROVENANCE ONLY, never as a second
   * verdict authority: a carried thread the listing proved resolved or gone is
   * already out of the finding set, and a carried thread whose live state could
   * NOT be proven was dropped from the finding set too (#1645 fails open) — so
   * this part must never add a material unknown (it would withhold approval for
   * a stale bookkeeping state the listing cannot speak about) and can never
   * manufacture a blocking defect. `unknown` rides the reserved ADVISORY
   * `stale_thread_bookkeeping` code so the single authoritative disposition
   * carries the disclosure alongside the review's own incomplete-reconciliation
   * note, and a run whose listing proved every carried thread's state carries
   * nothing. #1663's `unreassessed` count is different: a LIVE historical bot
   * blocker with no usable current-head re-evaluation is a MATERIAL
   * `unverified_blocking_claim` (INCOMPLETE/COMMENT), never a blocker.
   */
  threadReconciliation?: unknown;
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
  // A RECORDED zero-evidence degradation (a zero-call stop the loop chose —
  // transport failure or deadline before any reply; the model's own
  // no-tool-calls reply is never recorded as one, #1837) is a material
  // unknown in either lane — the harness's own record, never a route/tier
  // rule (#1656 audit round 3). Distinct from the advisory count floor
  // above.
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
  // #1753: the satisfied-no-citation serialization omission is the one trace
  // class the reserved ADVISORY `proof_shape_mismatch` vocabulary was pinned
  // for — "a requirement-trace predicate/test-shape mismatch established by
  // trusted provenance". Trusted provenance here is the trace row's own note
  // (deterministic: no citation emitted, evidence disclosed); the disclosure
  // rides `advisoryDiagnostics` and can never veto an approval.
  if (parts.traceProofShapeOmission === true) {
    evidence.push(dispositionEvidence("proof_shape_mismatch", "deterministic", "advisory", "requirement-trace:satisfied-no-enforcement-citation"));
  }
  // #1678 hardening: the exact-set verdict-contract failure is its OWN
  // material reason — the serialization broke, the semantics were never
  // claimed. Deterministic validator over the authoritative artifact; never
  // synthesized, never advisory: a closing verdict that did not decide every
  // required requirement can never certify an approval.
  if (parts.verdictContractIncomplete === true) {
    evidence.push(dispositionEvidence("verdict_contract_incomplete", "deterministic", "material", "verdict-contract:requirement-rows-incomplete"));
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

  // #1659: the canonical post-verdict settlement rows. A cap/budget release, a
  // question the loop left `open`, or an acquisition that FAILED is not a
  // semantic settlement — the loop's `obligations-settled` stop only means the
  // evidence window is ready — and the folds cannot see those loop states, so a
  // MATERIAL question in that state becomes a named material unknown
  // (`investigation_unavailable`) here, never a clean settlement that certifies
  // a native APPROVE. A NON-material question in the same state becomes the
  // ADVISORY `investigation_partial` diagnostic that never vetoes — never a
  // material code carrying advisory materiality, since `parseFinalDisposition`
  // refuses that cross-pairing and the standalone publisher would then read the
  // run as an UNAVAILABLE abstention instead of preserving its result.
  //
  // Dedup is decided by FOLD ACCOUNT, not by assumption: a question the
  // obligation fold carries (directly by `obligation-<n>`/`derived-<n>` id, or
  // — for a dependency shape row keyed by obligation NAME — ONLY through the
  // shared ownership rule in `foldOwnershipForDependencyQuestions`: the
  // classifier-owned `must_check` fold row whose TEXT names that obligation)
  // is already disclosed by the fold's own entry: the obligation loop above
  // for a non-must_check row, the completeness fold by check text for a
  // must_check row. A `derived`, `risk` or trusted-base row is NEVER an owner
  // through its text — that prose may mention "security advisories" while
  // knowing nothing about the upstream investigation, so it can neither resolve
  // the dependency question in `reconcileSettlements` nor hide it here; both
  // sides call the SAME helper, so the ownership rule cannot drift. A question
  // with NO fold row has no other surface, so the settlement record discloses
  // it — that is the case where the loop tracked a question the required-check
  // fold cannot account for (e.g. the dependency plan falling back to the full
  // obligation set). `not-tracked` can therefore never hide a material
  // unanswered question: reconciliation only assigns it when evidence
  // demonstrably reached the reviewer or the #1658 trace provenance owns the
  // row. Trace-kind rows are skipped: the requirement trace settles by
  // PROVENANCE through the summary classes above. The join lives in
  // `reconcileSettlements`, which derives the semantic state from these same
  // fold outcomes, so the canonical record and the disposition cannot disagree.
  const foldCheckTexts = new Set(
    parts.completenessChecks
      .map((row) => (typeof row.check === "string" ? row.check : ""))
      .filter((text) => text !== ""),
  );
  const obligationById = new Map(parts.obligations.map((row) => [row.id, row]));
  const dependencyOwnership = foldOwnershipForDependencyQuestions(
    parts.obligations.map((row) => ({ id: row.id, source: row.source, status: row.status, text: row.text })),
  );
  for (const settlement of parts.finalSettlements ?? []) {
    if (settlement.kind === "trace") continue;
    if (settlement.semantic !== "unknown") continue;
    const ownerId = settlement.kind === "dependency"
      ? dependencyOwnership.get(settlement.id)?.id
      : settlement.id;
    const owner = ownerId === undefined ? undefined : obligationById.get(ownerId);
    if (owner !== undefined) {
      if (owner.source !== "must_check") continue;
      if (owner.text !== undefined && owner.text !== "" && foldCheckTexts.has(owner.text)) continue;
    }
    const reason = settlement.evidenceState === "cap-released"
      ? `cap-released unprovable: ${settlement.id}`
      : settlement.evidenceState === "open"
        ? `left unanswered: ${settlement.id}`
        : settlement.acquisition === "available" || settlement.acquisition === "truncated"
          ? `unanswered: ${settlement.id}`
          : `acquisition failed: ${settlement.id}`;
    evidence.push(
      settlement.materiality === "material"
        ? dispositionEvidence("investigation_unavailable", "deterministic", "material", reason)
        : dispositionEvidence("investigation_partial", "deterministic", "advisory", reason),
    );
  }

  // #1659 review round: a persisted record the strict reader had to DROP rows
  // from is not "no gaps" — the pre-#1659 failure was exactly a cap release
  // reading as a clean settlement, and a stripped/corrupted record would
  // reintroduce it. The count (never the raw content) is disclosed as a
  // MATERIAL unknown, so the run withholds rather than certifying a review
  // whose settlement evidence is unreadable.
  if ((parts.settlementRecordDroppedRows ?? 0) > 0) {
    evidence.push(
      dispositionEvidence(
        "investigation_unavailable",
        "deterministic",
        "material",
        `malformed settlement rows dropped: ${parts.settlementRecordDroppedRows}`,
      ),
    );
  }

  // #1645: carried review-thread bookkeeping. The reconciliation pass already
  // decided what may block — only a thread PROVEN live and unresolved in a
  // complete listing re-enters the finding set, so the blocking question is
  // settled by the finding set above. What is left to disclose is the
  // uncertainty: `state: "incomplete"` means at least one carried thread could
  // not be reconciled (an unreadable read, a capped/partial listing, or a
  // listed row whose live state could not be parsed). That stays an ADVISORY
  // diagnostic under #1656's reserved code — never a material unknown (a stale,
  // unverifiable historical thread state must not withhold an approval that the
  // current head earned, and must not be promoted into a defect) and never a
  // second decision table. `state: "complete"` proved every carried thread, so
  // nothing is disclosed.
  const rawThreadReconciliation = parts.threadReconciliation;
  const threadReconciliation = typeof rawThreadReconciliation === "object"
    && rawThreadReconciliation !== null
    && !Array.isArray(rawThreadReconciliation)
    ? rawThreadReconciliation as Record<string, unknown>
    : null;
  if (threadReconciliation !== null && threadReconciliation.state === "incomplete") {
    const unknown = typeof threadReconciliation.unknown === "number" && Number.isFinite(threadReconciliation.unknown)
      ? Math.max(Math.trunc(threadReconciliation.unknown), 0)
      : 1;
    if (unknown > 0) {
      evidence.push(
        dispositionEvidence(
          "stale_thread_bookkeeping",
          "deterministic",
          "advisory",
          `carried review threads with no provable live state at settlement: ${unknown}`,
        ),
      );
    }
    // #1663: a live historical bot blocker/major the current head did not
    // support (no disposition, an evidence-free `open`, or an unsupported
    // claim) is a MATERIAL unverified blocking claim. The original severity
    // is already withheld from the finding set (the thread did not re-emit),
    // so this is the one place that uncertainty reaches the authoritative
    // disposition — INCOMPLETE/COMMENT, never a fabricated blocker and never
    // a clean approval. Duplicate historical threads are counted once (the
    // settlement stores distinct concern identities), and a fresh
    // current-head finding proving the same concern removes the gap.
    const unreassessed = typeof threadReconciliation.unreassessed === "number" && Number.isFinite(threadReconciliation.unreassessed)
      ? Math.max(Math.trunc(threadReconciliation.unreassessed), 0)
      : 0;
    if (unreassessed > 0) {
      evidence.push(
        dispositionEvidence(
          "unverified_blocking_claim",
          "deterministic",
          "material",
          `carried review threads without current-head re-evaluation: ${unreassessed}`,
        ),
      );
    }
  }

  return { evidence, provenUnmetRequirement };
}
