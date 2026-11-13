/**
 * The authoritative final review disposition (#1656).
 *
 * A run publishes ONE statement about what the review concluded, and every
 * downstream surface — the human-readable recommendation line, the machine
 * handoff, the marker/attestation and the native review event — reads it
 * from THIS object. Before #1656 the semantics were re-derived in parallel
 * (the publish-time disposition #1596, the attestation's own decision table
 * #1576, `markerReviewResult`'s coverage rollup and the publish boundary's
 * withheld-approval ladder), so materially different states could reach the
 * native event through different paths and two machine surfaces could
 * disagree about the same run.
 *
 * The closed kind vocabulary (the five-audit synthesis for #1636):
 * - `request_changes` — an evidenced current-head blocker/major defect, or
 *   an objectively proven unmet mandatory requirement.
 * - `approve` — exact head, materially adequate investigation, no
 *   blocker/major finding, no material unknown, and the applicable
 *   objective approval gates satisfied.
 * - `incomplete` — no proven blocker, but a materially relevant review
 *   question remains unknown/unavailable.
 * - `unavailable` — the review failed before enough semantic assessment
 *   existed to certify anything (provider/transport/platform failure).
 *
 * Authority model (the #1656 architecture boundary):
 * - DETERMINISTIC code establishes objective state and provenance. The
 *   inputs below are objective facts the pipeline already produced; the
 *   decision table is a pure function of them.
 * - REVIEWER SEMANTICS determine relevance/materiality where it is genuinely
 *   semantic. Materiality arrives through the reason-coded evidence seam
 *   (`DispositionEvidence`), each entry carrying WHO ruled it
 *   (`ruledBy: "deterministic"` for the objective floors, `"reviewer"` for
 *   the semantic calls #1657/#1658/#1659 feed). This module never infers
 *   materiality from the `required_checks=incomplete` bit alone — a
 *   material unknown is material because a reason-coded entry says so and
 *   carries its provenance, never because a coverage bit flipped.
 * - ONE final authority: no other module may decide the native event from
 *   parallel guardrails. The publish boundary's scope policy and the
 *   publication-proof machinery stay (they are objective gates the
 *   disposition consumes), but they no longer independently choose the
 *   event.
 *
 * Materiality floors — the deterministic codes below are CAPABLE of
 * withholding approval when they apply to the changed behavior; the seam's
 * builder (and, where genuinely semantic, the reviewer's own structured
 * answer) decides applicability. Non-material proof-shape/bookkeeping/
 * serialization diagnostics are `advisory`: they stay observable in
 * `advisoryDiagnostics` but never veto an otherwise adequate approval.
 */

export type FinalDispositionKind = "request_changes" | "approve" | "incomplete" | "unavailable";

/** The native review events a disposition can permit. */
export type FinalDispositionNativeEvent = "REQUEST_CHANGES" | "COMMENT" | "APPROVE";

/**
 * Material-capable evidence codes — the objective floors that remain
 * capable of withholding approval when applicable to the changed behavior
 * (#1656 "material-unknown floor"). A material entry under one of these
 * codes makes the disposition `incomplete`.
 */
export const MATERIAL_DISPOSITION_CODES = [
  /** A materially affected (e.g. auth/security/trust-boundary) path could
   * not be inspected. */
  "unread_affected_path",
  /** Required exact-head CI/test evidence is unavailable or pending where
   * the changed behavior needs it — pending/unavailable CI withholds only
   * when that CI is materially required (#1656 audit delta), never as a
   * blanket rule. */
  "exact_head_evidence_unavailable",
  /** Required exact-head CI is KNOWN failing — an objective current-head
   * gate failure; it can never certify an approval (#1656 audit delta). */
  "required_ci_failing",
  /** A necessary upstream/source fact could not be acquired. */
  "upstream_source_unavailable",
  /** A blocker/major claim remains current-head relevant but could not be
   * grounded or refuted (unknown evidence, not a refutation). */
  "unverified_blocking_claim",
  /** An applicable mandatory objective requirement remains genuinely
   * unresolved. */
  "mandatory_requirement_unresolved",
  /** The investigation capability itself failed (tool-harness planning/
   * execution failure, every call failed, the loop recorded a no-evidence
   * degradation) — a genuine capability failure, never a call count. */
  "investigation_unavailable",
] as const;
export type MaterialDispositionCode = (typeof MATERIAL_DISPOSITION_CODES)[number];

/**
 * Advisory evidence codes — non-material proof-shape, bookkeeping and
 * serialization diagnostics (#1656 + audit delta). They stay observable but
 * never independently veto an approval, and they are never independent
 * final-disposition authorities.
 */
export const ADVISORY_DISPOSITION_CODES = [
  /** A requirement-trace predicate/test-shape mismatch (or other proof-
   * shape diagnostic, including the trace's repairable coverage rows) where
   * the underlying behavior was adequately assessed. #1658 refines. */
  "proof_shape_mismatch",
  /** The one-call-per-row citation allocation could not back satisfied rows
   * with their own executed calls (allocation, uncited, unrelated, or
   * unparseable-trace shapes). A compatibility diagnostic while #1657 is in
   * flight — never an approval veto on its own. */
  "citation_allocation_failed",
  /** Stale historical thread bookkeeping (#1654's reconciliation state is
   * consumed as provenance only). */
  "stale_thread_bookkeeping",
  /** A missing/invalid disposition for a generic scrutiny prompt (a P0/P1
   * "verify carefully/thoroughly" exhortation without a named behavior). */
  "generic_scrutiny_row_missing",
  /** A non-material serialization/bookkeeping failure. */
  "serialization_diagnostic",
  /** The configured minimum-successful tool-call floor was unmet — a
   * configured count, which must never define investigation adequacy by
   * itself (#1656 audit delta). */
  "investigation_floor_unmet",
  /** The tool loop stopped early (budget/rounds/context) — disclosure
   * only; whether the affected behavior lacked evidence is a seam question
   * (#1657), never a blanket veto (#1656 audit delta). */
  "investigation_partial",
] as const;
export type AdvisoryDispositionCode = (typeof ADVISORY_DISPOSITION_CODES)[number];

export type DispositionEvidenceCode = MaterialDispositionCode | AdvisoryDispositionCode;

/**
 * One reason-coded evidence entry on the #1656 seam. `code` is closed;
 * `ruledBy` records the authority that decided the materiality
 * (`deterministic` for the objective floors, `reviewer` for the genuinely
 * semantic calls the parallel work feeds); `subject` is a bounded,
 * content-free identity of WHAT the entry is about (a check id, a path, a
 * finding identity) so the disposition stays explainable from provenance.
 */
export interface DispositionEvidence {
  readonly code: DispositionEvidenceCode;
  readonly ruledBy: "deterministic" | "reviewer";
  readonly materiality: "material" | "advisory";
  readonly subject: string;
}

/** The closed reason vocabulary: WHY the kind is what it is. */
export const FINAL_DISPOSITION_REASONS = [
  /** A grounded blocker/major finding or an evidence-provider blocker. */
  "blocker_proven",
  /** An objectively proven unmet mandatory requirement (a confirmed
   * negative), with no separate finding-level blocker driving the event. */
  "requirement_unmet",
  /** Approved with the FULL objective APPROVE floor satisfied — the only
   * approve reason; kind `approve` always carries it (#1656 audit delta). */
  "approval_certified",
  /** At least one material unknown withheld certification. */
  "material_unknown",
  /** The review itself completed with no proven defect and no material
   * unknown, but the objective certification gates (fork scope policy, a
   * non-verdict-bearing surface, an unproven exact head, an unbound
   * publication) withheld the native approval (#1656 audit delta). */
  "approval_withheld",
  /** The review stage ran but produced no usable verdict. */
  "no_verdict",
  /** The review never produced a semantic assessment at all. */
  "review_failed",
  /** The verdict came from a degraded fallback with no evidence gathered. */
  "degraded_no_evidence",
] as const;
export type FinalDispositionReason = (typeof FINAL_DISPOSITION_REASONS)[number];

/**
 * The authoritative disposition. Everything a consumer needs is derived
 * here ONCE: the kind, the machine reason, the native event, the wording
 * and the evidence that explains it.
 *
 * #1656 audit delta: the disposition itself carries certification. Kind
 * `approve` exists ONLY when the full objective APPROVE floor passed, and
 * it always carries nativeEvent APPROVE — no downstream `approvalCertified`
 * authority can change the event, because there is nothing left to change:
 * `approvalCertified` is DERIVED (`kind === "approve"`), never an
 * independent input. An approve the objective gates cannot certify (fork
 * scope policy, an advisory surface, an unproven/unbound head) is kind
 * `incomplete` with reason `approval_withheld` — the certification
 * withholding is INSIDE this object.
 */
export interface FinalDisposition {
  readonly kind: FinalDispositionKind;
  readonly reason: FinalDispositionReason;
  readonly nativeEvent: FinalDispositionNativeEvent;
  /** True when a blocking code defect is proven (a grounded current-head
   * blocker/major finding, an evidence-provider blocker, or the final
   * verdict itself). */
  readonly blockerProven: boolean;
  /** Derived, never independent: true exactly when kind is `approve` (the
   * full APPROVE floor passed and the native event is a certified APPROVE). */
  readonly approvalCertified: boolean;
  /** The material unknowns that withheld certification. Non-empty only for
   * kind `incomplete` under reason `material_unknown`. */
  readonly materialUnknowns: readonly DispositionEvidence[];
  /** Non-material diagnostics: observable, never vetoing. */
  readonly advisoryDiagnostics: readonly DispositionEvidence[];
  /** The action-owned recommendation line published above the model prose. */
  readonly recommendation: string;
  /** The plain-language statement of the disposition (no emoji/bold). */
  readonly statement: string;
}

/**
 * The objective inputs `computeFinalDisposition` consumes. Every field is
 * deterministic state the pipeline already produced; materiality arrives
 * only through `evidence`. There is deliberately NO route/tier/lane field:
 * a fallback lane certifies exactly like a primary lane when it actually
 * performed an adequate review, and no route name can decide the
 * disposition (#1656 audit delta).
 */
export interface FinalDispositionInput {
  /** True when the review stage produced a semantic assessment this run
   * could certify (a review ran; the model-unavailable notice never sets
   * it) — the "meaningful semantic review actually completed" floor. */
  reviewProduced: boolean;
  /** True when the run produced a parseable final verdict. */
  validVerdict: boolean;
  /** The final verdict ("approve" | "request_changes" | "" when none). */
  verdict: string;
  /** True when the verdict came from a degraded no-evidence fallback (or
   * the model-failure notice) — the review capability was effectively
   * unavailable (#978). A degraded/zero-evidence review can never approve. */
  degraded: boolean;
  /** True when the reviewed head is a proven full git object id — the
   * exact-head APPROVE floor. The publish seam's exact-head currency
   * re-check stays upstream of any submission. */
  exactHead: boolean;
  /** True when the publication will bind to the reviewed exact head (a
   * verdict-bearing native review with the head proven). The body-only
   * fallback (#1249) remains caught downstream by the attestation's
   * `native_approval_unbound` — the publication-proof layer is preserved. */
  publicationHeadBound: boolean;
  /** True when a grounded current-head blocker/major finding is still open
   * (after verification, demotions and negative evidence). */
  blockingFindingOpen: boolean;
  /** True when a configured evidence provider reported blocker-level
   * findings. */
  evidenceProviderBlocker: boolean;
  /** True when a mandatory objective requirement is objectively proven
   * unmet (a confirmed-negative obligation row / deterministic refutation),
   * independent of any finding. */
  provenUnmetRequirement: boolean;
  /** True when this publication's authoritative surface is a verdict-
   * bearing native review. */
  verdictBearing: boolean;
  /** True when the objective approval scope gates allow a native approval
   * on this surface (fork policy, publish mode). Fails closed on unknown
   * fork state. */
  approvalScopeAllowed: boolean;
  /** The reason-coded evidence seam (#1657/#1658/#1659 feed this). */
  evidence: readonly DispositionEvidence[];
}

/** Cap on one evidence subject; builders bound the identity they carry. */
export const DISPOSITION_SUBJECT_MAX_CHARS = 200;

/** Bound one evidence subject: control characters collapse, the value is
 * trimmed and capped. The subject is provenance, never free text. */
export function boundDispositionSubject(subject: string): string {
  return subject.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, DISPOSITION_SUBJECT_MAX_CHARS);
}

/** Build one evidence entry, bounding the subject. */
export function dispositionEvidence(
  code: DispositionEvidenceCode,
  ruledBy: DispositionEvidence["ruledBy"],
  materiality: DispositionEvidence["materiality"],
  subject: string,
): DispositionEvidence {
  return { code, ruledBy, materiality, subject: boundDispositionSubject(subject) };
}

/**
 * The user-visible wording of each disposition. These strings are a
 * CONTRACT (the published recommendation line is what a human reads), so
 * they live here — one place — and every surface renders the same line.
 * The request_changes/approve/advisory-approve/no-verdict lines are
 * byte-identical to the pre-#1656 published wording (#1596).
 */
const REQUEST_CHANGES_WORDING = {
  recommendation: "⚠️ **Automated recommendation: REQUEST CHANGES**",
  statement: "Request changes",
} as const;
const APPROVE_WORDING = {
  recommendation: "✅ **Automated recommendation: APPROVE**",
  statement: "Approve",
} as const;
const ADVISORY_APPROVE_WORDING = {
  recommendation: "🟡 **Automated recommendation: APPROVE — advisory, no approval certified**",
  statement: "Approve",
} as const;
const NO_VERDICT_WORDING = {
  recommendation: "🟡 **Automated recommendation: NO VERDICT**",
  statement: "No verdict",
} as const;
const DEGRADED_NO_EVIDENCE_WORDING = {
  recommendation: "🟡 **Automated recommendation: REVIEW UNAVAILABLE — no review conclusion could be certified (degraded no-evidence fallback)**",
  statement: "Review unavailable",
} as const;

/**
 * The reader-facing clause per material code, used in the INCOMPLETE
 * recommendation line and statement: the published line names WHY the
 * approval was withheld, so an abstention is never unexplained.
 */
export const MATERIAL_CODE_CLAUSES: Readonly<Record<MaterialDispositionCode, string>> = Object.freeze({
  unread_affected_path: "changed behavior could not be fully inspected",
  exact_head_evidence_unavailable: "required exact-head evidence is unavailable",
  required_ci_failing: "required exact-head CI is failing",
  upstream_source_unavailable: "a necessary source fact could not be acquired",
  unverified_blocking_claim: "an open blocker/major claim could not be grounded or refuted",
  mandatory_requirement_unresolved: "a mandatory requirement remains unresolved",
  investigation_unavailable: "the investigation did not finish",
});

function incompleteWording(materialUnknowns: readonly DispositionEvidence[]): {
  recommendation: string;
  statement: string;
} {
  const first = materialUnknowns[0];
  const clause = first !== undefined && MATERIAL_CODE_CLAUSES[first.code as MaterialDispositionCode] !== undefined
    ? MATERIAL_CODE_CLAUSES[first.code as MaterialDispositionCode]!
    : "material review questions remain unresolved";
  return {
    recommendation: `🟡 **Automated recommendation: INCOMPLETE — no blocking code defect proven; approval withheld (${clause})**`,
    statement: `Incomplete — no blocking code defect proven; approval withheld (${clause})`,
  };
}

/**
 * Compute THE final disposition of a review. Total, pure, fail-closed at
 * every step; the decision order is fixed:
 *
 * 1. Capability failures first — a run with no semantic assessment (no
 *    review, no usable verdict, or a degraded no-evidence fallback) is
 *    `unavailable`. It can never certify anything, and it never
 *    fabricates a code blocker out of its own failure.
 * 2. Proven defects — a grounded current-head blocker/major finding, an
 *    evidence-provider blocker, an objectively proven unmet mandatory
 *    requirement, or the final verdict itself — are `request_changes`.
 *    A proven defect outranks every coverage state.
 * 3. Material unknowns — any material evidence entry (an uninspected
 *    affected path, known-failing required exact-head CI, an unverified
 *    blocking claim, …) — withhold certification as `incomplete` under
 *    `material_unknown`. Never an approval, never a defect claim.
 * 4. The APPROVE floor (#1656 audit delta): kind `approve` requires the
 *    full objective floor — exact head, publication bound to it, the
 *    verdict-bearing surface, the scope gates, no blocker/major, no
 *    material unknown, a meaningful semantic review actually completed.
 *    When the review itself is complete but the certification gates
 *    withhold (fork scope policy, an advisory surface, an unproven or
 *    unbound head), the disposition is `incomplete` under
 *    `approval_withheld` — the withholding lives INSIDE this object, so
 *    no downstream authority can change an approve's native event.
 *
 * Adequacy is never defined by a tool-call count, a route/tier name, a
 * primary-good/fallback-bad rule, or a read-every-file requirement: a
 * fallback lane certifies exactly like a primary lane when the evidence it
 * actually gathered was adequate (#1656 audit delta).
 */
export function computeFinalDisposition(input: FinalDispositionInput): FinalDisposition {
  const materialUnknowns = input.evidence.filter((entry) => entry.materiality === "material");
  const advisoryDiagnostics = input.evidence.filter((entry) => entry.materiality === "advisory");

  let kind: FinalDispositionKind;
  let reason: FinalDispositionReason;
  if (!input.reviewProduced || !input.validVerdict) {
    kind = "unavailable";
    reason = input.reviewProduced ? "no_verdict" : "review_failed";
  } else if (input.degraded) {
    kind = "unavailable";
    reason = "degraded_no_evidence";
  } else {
    const findingBlocker = input.blockingFindingOpen || input.evidenceProviderBlocker;
    const verdictBlocker = input.verdict === "request_changes";
    if (findingBlocker || input.provenUnmetRequirement || verdictBlocker) {
      kind = "request_changes";
      reason = findingBlocker || !input.provenUnmetRequirement ? "blocker_proven" : "requirement_unmet";
    } else if (materialUnknowns.length > 0) {
      kind = "incomplete";
      reason = "material_unknown";
    } else if (
      input.verdictBearing
      && input.approvalScopeAllowed
      && input.exactHead
      && input.publicationHeadBound
    ) {
      kind = "approve";
      reason = "approval_certified";
    } else {
      // The review itself completed clean, but the objective certification
      // gates withheld the native approval. The withholding is part of THIS
      // disposition — kind `approve` always means a certified APPROVE.
      kind = "incomplete";
      reason = "approval_withheld";
    }
  }

  const blockerProven = kind === "request_changes";
  // #1656 audit delta: certification is DERIVED from the kind, never an
  // independent authority — kind `approve` is emitted only above the full
  // APPROVE floor and always carries the APPROVE event.
  const approvalCertified = kind === "approve";
  const nativeEvent: FinalDispositionNativeEvent = blockerProven
    ? "REQUEST_CHANGES"
    : approvalCertified
      ? "APPROVE"
      : "COMMENT";
  const wording = kind === "request_changes"
    ? REQUEST_CHANGES_WORDING
    : kind === "incomplete"
      ? reason === "approval_withheld"
        ? // The review completed clean; the certification gates withheld the
          // native approval. On a verdict-bearing surface the line must never
          // read as a certified approval; on an advisory surface there is no
          // verdict-bearing event to contradict (pre-#1656 byte behavior).
          input.verdictBearing ? ADVISORY_APPROVE_WORDING : APPROVE_WORDING
        : incompleteWording(materialUnknowns)
      : kind === "approve"
        ? APPROVE_WORDING
        : reason === "degraded_no_evidence" ? DEGRADED_NO_EVIDENCE_WORDING : NO_VERDICT_WORDING;
  return {
    kind,
    reason,
    nativeEvent,
    blockerProven,
    approvalCertified,
    // Only a `material_unknown` abstention is EXPLAINED by its material
    // unknowns; other kinds record the evidence in the advisory/diagnostic
    // trail so the object stays explainable without implying a coverage
    // veto that did not fire.
    materialUnknowns: kind === "incomplete" && reason === "material_unknown" ? materialUnknowns : [],
    advisoryDiagnostics,
    recommendation: wording.recommendation,
    statement: wording.statement,
  };
}

/**
 * The metadata marker's `review_result`, projected from the authoritative
 * disposition (#1656) so the marker can never disagree with it: `issues`
 * for a proven defect; `partial` for a coverage abstention (a material
 * unknown) or an unavailable review; `findings`/`clean` when the review
 * itself completed — including an `approval_withheld` abstention, where
 * the review is complete and only the native certification was withheld
 * (fork scope policy, advisory surface). The `findings` state only exists
 * under the strict policy (every other policy keeps the v2 binary
 * vocabulary consumers rely on). Open non-blocking findings count only for
 * the completed states.
 */
export function reviewResultFromDisposition(
  disposition: { kind: FinalDispositionKind; reason: FinalDispositionReason },
  options: { strict: boolean; openFindings: number },
): "issues" | "partial" | "findings" | "clean" {
  if (disposition.kind === "request_changes") return "issues";
  if (disposition.kind === "unavailable") return "partial";
  if (disposition.kind === "incomplete" && disposition.reason === "material_unknown") return "partial";
  return options.strict && options.openFindings > 0 ? "findings" : "clean";
}

// ---------------------------------------------------------------------------
// The deterministic generic-scrutiny shape (#1656): a required check that
// exhorts scrutiny without naming any behavior, path or artifact of the
// change. A missing/invalid disposition for such a row is bookkeeping, not
// a material unknown.
// ---------------------------------------------------------------------------

/**
 * A scrutiny exhortation: an imperative asking for care/thoroughness. The
 * known classification rows ("treat as critical — verify all changes
 * thoroughly", "treat as high priority — verify correctness carefully")
 * match the first alternative.
 */
const SCRUTINY_EXHORTATION_RE =
  /\btreat as (?:critical|high priority)\b|\b(?:verify|check|review|inspect|test)\b[^.\n]*\b(?:carefully|thoroughly)\b/i;

/**
 * A specific anchor: a quoted identifier, a path-like or file-extension
 * token, or a concrete behavior vocabulary (auth, secrets, paths, schema,
 * ...). A row carrying one names something specific about THIS change —
 * an unresolved answer for it stays material.
 */
const ANCHORED_CHECK_RE =
  /`[^`]+`|(?:[\w@.-]+\/)?[\w@.-]+\.[a-z]{1,8}\b|\b(?:auth|authenticat|authoriz|token|secret|credential|password|cryptograph|path|traversal|sanitiz|escap|injection|xsrf|csrf|xss|permission|privilege|sandbox|migration|schema|transaction|api|endpoint|route|webhook|download|upload|extract|archive|symlink|dependency|provenance|advisory|license)\b/i;

/**
 * Fail-closed parse for consumers of the `final-disposition.json` run-dir
 * artifact (the standalone `publish` CLI read-back). Exact closed
 * vocabularies for every field, booleans as booleans, and the core
 * coherence invariants the decision table guarantees (a `request_changes`
 * kind proves a blocker; `approval_certified` implies kind `approve`;
 * `incomplete` carries its material unknowns). Anything this refuses is
 * treated as absent — a malformed disposition is never read as any kind,
 * least of all an approval.
 */
export function parseFinalDisposition(value: unknown): FinalDisposition | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const reason = record.reason;
  if (typeof kind !== "string" || !isFinalDispositionKind(kind)) return null;
  if (typeof reason !== "string" || !isFinalDispositionReason(reason)) return null;
  if (typeof record.nativeEvent !== "string"
    || !(record.nativeEvent === "REQUEST_CHANGES" || record.nativeEvent === "COMMENT" || record.nativeEvent === "APPROVE")) return null;
  if (typeof record.blockerProven !== "boolean" || typeof record.approvalCertified !== "boolean") return null;
  if (typeof record.recommendation !== "string" || typeof record.statement !== "string") return null;
  const evidence = parseEvidenceList(record.materialUnknowns);
  const advisory = parseEvidenceList(record.advisoryDiagnostics);
  if (evidence === null || advisory === null) return null;
  // Coherence: the pair and the flags must be ones `computeFinalDisposition`
  // can emit for the kind. Kind `approve` exists only above the full APPROVE
  // floor (always `approval_certified`, always nativeEvent APPROVE); an
  // `approval_withheld` abstention carries no material unknowns; a
  // `material_unknown` abstention carries at least one.
  if (kind === "request_changes" && (!record.blockerProven || evidence.length > 0)) return null;
  if (kind === "incomplete" && record.blockerProven) return null;
  if (kind === "approve" && record.blockerProven) return null;
  if (kind === "unavailable" && (record.blockerProven || evidence.length > 0)) return null;
  if (reason === "material_unknown" && (kind !== "incomplete" || evidence.length === 0)) return null;
  if (reason === "approval_withheld" && (kind !== "incomplete" || evidence.length > 0)) return null;
  if ((reason === "no_verdict" || reason === "review_failed" || reason === "degraded_no_evidence") && kind !== "unavailable") return null;
  if ((reason === "blocker_proven" || reason === "requirement_unmet") && kind !== "request_changes") return null;
  // The certify flag is DERIVED: kind `approve` always certified, and the
  // APPROVE event always follows it.
  if ((reason === "approval_certified") !== (kind === "approve")) return null;
  if ((record.nativeEvent === "APPROVE") !== (kind === "approve")) return null;
  return {
    kind,
    reason,
    nativeEvent: record.nativeEvent as FinalDisposition["nativeEvent"],
    blockerProven: record.blockerProven,
    approvalCertified: record.approvalCertified,
    materialUnknowns: evidence,
    advisoryDiagnostics: advisory,
    recommendation: record.recommendation,
    statement: record.statement,
  };
}

function isFinalDispositionKind(value: string): value is FinalDispositionKind {
  return value === "request_changes" || value === "approve" || value === "incomplete" || value === "unavailable";
}

function isFinalDispositionReason(value: string): value is FinalDispositionReason {
  return (FINAL_DISPOSITION_REASONS as readonly string[]).includes(value);
}

function parseEvidenceList(value: unknown): DispositionEvidence[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const entries: DispositionEvidence[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    const code = entry.code;
    if (typeof code !== "string"
      || !(MATERIAL_DISPOSITION_CODES as readonly string[]).includes(code)
      && !(ADVISORY_DISPOSITION_CODES as readonly string[]).includes(code)) return null;
    if (entry.ruledBy !== "deterministic" && entry.ruledBy !== "reviewer") return null;
    if (entry.materiality !== "material" && entry.materiality !== "advisory") return null;
    if (typeof entry.subject !== "string" || entry.subject.length > DISPOSITION_SUBJECT_MAX_CHARS) return null;
    entries.push({
      code: code as DispositionEvidenceCode,
      ruledBy: entry.ruledBy,
      materiality: entry.materiality,
      subject: entry.subject,
    });
  }
  return entries;
}

/**
 * True when a required-check row is a generic scrutiny prompt: it exhorts
 * care without anchoring any specific behavior, path or artifact. Such a
 * row's missing/invalid disposition is an advisory bookkeeping diagnostic
 * (`generic_scrutiny_row_missing`), never an automatic material unknown
 * (#1656). Narrow by design — an unanchored row that carries neither the
 * exhortation shape nor a scrutiny adverb stays material, and any anchored
 * token keeps the row material regardless of its wording.
 */
export function isGenericScrutinyCheckText(text: string): boolean {
  if (typeof text !== "string") return false;
  const normalized = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (normalized === "" || normalized.length > 400) return false;
  if (!SCRUTINY_EXHORTATION_RE.test(normalized)) return false;
  return !ANCHORED_CHECK_RE.test(normalized);
}
