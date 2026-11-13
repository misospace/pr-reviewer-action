/**
 * The machine-verifiable trusted-review attestation (#1576).
 *
 * A green AI workflow and a model-prose `approve` are NOT a trusted native
 * APPROVE: #1565 showed a run with an exhausted primary provider, zero
 * native-loop investigation, `review_result=partial` and an advisory
 * fallback approve exiting 0. Consumers need ONE unambiguous conclusion per
 * run that they can merge-gate on, derived deterministically from signals
 * the run already records — never a second model call.
 *
 * The closed conclusion vocabulary:
 * - `approved`: a commit-bound native APPROVE review was actually submitted
 *   for the exact reviewed head, with complete required checks, complete
 *   coverage and no degraded bypass. This is the ONLY conclusion a merge
 *   automation may treat as a trusted approval. A body-only fallback
 *   submission (#1249) omits `commit_id` and is NOT bound to the reviewed
 *   head — it can never attest `approved`.
 * - `blocked`: the final verdict is a non-degraded `request_changes` and a
 *   native REQUEST_CHANGES review provably landed on the pull request —
 *   the same positive proof `approved` requires of a native APPROVE.
 * - `incomplete`: a review ran but its conclusion is not trustworthy for
 *   this head — withheld approval, an approval that landed without commit
 *   binding, partial coverage, superseded head, or advisory-only
 *   publication.
 * - `unavailable`: the review capability itself was unavailable — a crash,
 *   an unavailable model, a degraded zero-evidence fallback, no verdict, or
 *   a failed native publication attempt.
 * - `skipped`: no review ran (precheck skip, follow-up consumption, plain
 *   no-op). A carried verdict never promotes it to `approved`/`blocked`
 *   — the earlier run's attestation owns that decision.
 *
 * Fail-closed invariants:
 * - Nothing here re-reads model prose or re-scores anything; every input is
 *   an action-owned signal the pipeline already produced (verdict,
 *   required-check state, review result, incomplete reason, degraded gate
 *   bypass, publication status and native submission result).
 * - `approved` is unreachable unless the native submission record proves a
 *   commit-bound APPROVE landed for a non-empty exact head SHA; a body-only
 *   fallback landing (no `commit_id`) is unbound and certifies nothing.
 * - `blocked` is unreachable unless the native record proves a
 *   REQUEST_CHANGES review actually landed on the pull request: a failed
 *   publication reads `unavailable` (`native_submission_failed` when the
 *   API rejected the submission, `publication_failed` when no native
 *   record exists), and publication that was never attempted, withheld at
 *   the head re-check, or landed only advisory reads `incomplete`
 *   (`not_published`, `superseded_head`, `advisory_only`).
 * - Advisory publication (comment/review_comment modes, withheld approvals,
 *   platforms without a native review surface) can never reach `approved`.
 */

export const REVIEW_ATTESTATION_CONCLUSIONS = [
  "approved",
  "blocked",
  "incomplete",
  "unavailable",
  "skipped",
] as const;
export type ReviewAttestationConclusion = (typeof REVIEW_ATTESTATION_CONCLUSIONS)[number];

export const REVIEW_ATTESTATION_REASON_CODES = [
  /** A native APPROVE review submission landed for a non-empty exact head. */
  "native_approval_submitted",
  /** The final (non-degraded) verdict is request_changes. */
  "request_changes",
  /** Required-check validation reported `incomplete`. */
  "required_checks_incomplete",
  /** Execution or requirement-trace coverage was incomplete (or the review
   * result was `partial`). */
  "coverage_incomplete",
  /** #1656: the authoritative disposition withheld certification for a
   * material unknown (a materially relevant review question remains
   * unknown/unavailable). */
  "material_unknown",
  /** The publish boundary withheld the native approval (scope, derived
   * obligations, required evidence, degraded state, or coverage) and
   * published a non-blocking COMMENT instead. */
  "approval_withheld",
  /** Publication landed but carries no verdict-bearing native event: an
   * advisory comment/review_comment run, or a platform without a native
   * review surface. */
  "advisory_only",
  /** A complete review was produced but publication was not attempted —
   * nothing (approval or block) certifies it on the pull request. */
  "not_published",
  /** A newer push landed at the publication boundary; the review describes
   * a head that is no longer current. */
  "superseded_head",
  /** The run crashed before producing any review result. */
  "run_crashed",
  /** Every model route failed and the run published the model-unavailable
   * notice (on-model-failure=notice). */
  "model_unavailable",
  /** The verdict came from a degraded fallback with no evidence gathered —
   * the primary review capability was effectively unavailable. */
  "degraded_no_evidence",
  /** The run produced no valid verdict. */
  "no_verdict",
  /** The native APPROVE submission itself failed — the run is neither
   * approved nor silently incomplete; the approval attempt failed. */
  "native_approval_failed",
  /** The native REQUEST_CHANGES submission itself failed — the block did
   * not land on the pull request, so the run attests the capability
   * failure, not a landed block. */
  "native_submission_failed",
  /** The APPROVE landed through the body-only plain-review fallback
   * (#1249): the request omitted `commit_id`, so the approval is not bound
   * to the reviewed head. It certifies nothing for this exact head. */
  "native_approval_unbound",
  /** The publication attempt failed for a non-approval cause, and no native
   * block was proved to have landed. */
  "publication_failed",
  /** The head SHA the attestation would bind could not be proven. */
  "head_unknown",
  /** No review ran this run (the detailed cause rides the `skip-reason`
   * output and the bundle's `skip_reason`). */
  "skipped",
] as const;
export type ReviewAttestationReasonCode = (typeof REVIEW_ATTESTATION_REASON_CODES)[number];

/** A bindable attestation head: a full git object id (40-hex SHA-1 or
 * 64-hex SHA-256, the shapes the engine's own revision guard accepts). */
const ATTESTATION_HEAD_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** The conclusion/reason pairs the decision table can emit, keyed by every
 * reason code (the `Record` type makes adding a code without an entry a
 * compile error). The parser accepts only these pairs: a valid reason code
 * under an unrelated conclusion — `approved` with `request_changes`, for
 * instance — is a malformed attestation, never an approval (#1580 review
 * fix). */
export const REVIEW_ATTESTATION_CONCLUSION_REASONS: Readonly<
  Record<ReviewAttestationReasonCode, readonly ReviewAttestationConclusion[]>
> = {
  native_approval_submitted: ["approved"],
  request_changes: ["blocked"],
  required_checks_incomplete: ["incomplete"],
  coverage_incomplete: ["incomplete"],
  material_unknown: ["incomplete"],
  approval_withheld: ["incomplete"],
  advisory_only: ["incomplete"],
  not_published: ["incomplete"],
  superseded_head: ["incomplete"],
  run_crashed: ["unavailable"],
  model_unavailable: ["unavailable"],
  degraded_no_evidence: ["unavailable"],
  no_verdict: ["unavailable"],
  native_approval_failed: ["unavailable"],
  native_submission_failed: ["unavailable"],
  native_approval_unbound: ["incomplete"],
  publication_failed: ["unavailable"],
  head_unknown: ["unavailable"],
  skipped: ["skipped"],
};

export interface ReviewAttestation {
  conclusion: ReviewAttestationConclusion;
  reason_code: ReviewAttestationReasonCode;
  /** Exact head SHA the conclusion describes ("" when unprovable — and an
   * unprovable head can never carry `approved`). */
  head_sha: string;
}

export interface ReviewAttestationSignals {
  /** The run wrapper caught an uncaught crash before any result existed. */
  crashed?: boolean;
  /** False when precheck skipped the review or the run consumed no review
   * event. Defaults to true. */
  reviewProduced?: boolean;
  /** The final result came from the model-unavailable notice artifact
   * (`analysis_engine === MODEL_UNAVAILABLE_ENGINE`). */
  modelUnavailable?: boolean;
  /** The degraded gate bypass applies: fallback with no evidence gathered,
   * or the model-failure notice. */
  degraded?: boolean;
  /** The final verdict output: "approve" | "request_changes" | "". */
  verdict?: string;
  /** The required-check state output: "complete" | "incomplete" | "none". */
  requiredChecks?: string;
  /** The review-result output: "clean" | "findings" | "partial" | "issues". */
  reviewResult?: string;
  /** The incomplete-reason output: "none" | "execution" |
   * "requirement_trace" | "both". */
  incompleteReason?: string;
  /** The run's partial-coverage artifact was present (the same signal the
   * bundle lifecycle uses to mark `partial`). */
  partialCoverage?: boolean;
  /** #1656: the run's authoritative final disposition. When present, the
   * semantic conclusion comes from it (the same object every other
   * consumer reads) and only the publication proof below is decided here.
   * Absent (a caller without the disposition) keeps the legacy signal
   * table below unchanged. */
  disposition?: AttestationDisposition;
  /** Exact reviewed head SHA ("" when unknown). */
  headSha?: string;
  /** Publication was attempted: the publish outcome plus the native
   * verdict-submission record when one was attempted (only
   * `review_verdict`/`review_blockers` modes on a platform with a native
   * review surface carry verdict-bearing events). */
  publication?: {
    status: "published" | "superseded" | "failed";
    /** `fellBack` marks the body-only plain-review fallback (#1249): the
     * event landed without a `commit_id`, so it binds no head. */
    native?: { event: string; submitted: boolean; fellBack?: boolean };
  };
}

/**
 * Decide the attestation from the run's own signals. Total function, fixed
 * precedence (crash → skip → disposition-or-legacy-capability → verdict →
 * coverage → publication): the capability failures are answered before the
 * verdict exists so a synthetic notice or advisory fallback can never read
 * as a verdict-backed conclusion.
 *
 * #1656: when the run's authoritative final disposition is present, the
 * SEMANTIC conclusion comes from it — the same object the recommendation,
 * the handoff, the marker and the native event consume — and this function
 * owns only the publication proof (whether a commit-bound native event
 * actually landed). The legacy signal table further below stays for
 * callers without a disposition and is unchanged. */
export function computeReviewAttestation(signals: ReviewAttestationSignals): ReviewAttestation {
  const head = typeof signals.headSha === "string" ? signals.headSha : "";
  const finish = (conclusion: ReviewAttestationConclusion, reason_code: ReviewAttestationReasonCode): ReviewAttestation =>
    ({ conclusion, reason_code, head_sha: head });
  if (signals.crashed === true) return finish("unavailable", "run_crashed");
  if (signals.reviewProduced === false) return finish("skipped", "skipped");
  const disposition = signals.disposition;
  if (disposition !== undefined) {
    // The semantic state is the disposition's, word for word.
    if (disposition.kind === "unavailable") {
      return finish("unavailable",
        disposition.reason === "degraded_no_evidence" ? "degraded_no_evidence"
          : disposition.reason === "review_failed" ? "model_unavailable"
          : "no_verdict");
    }
    if (disposition.kind === "incomplete") {
      const publication = signals.publication;
      if (publication === undefined) return finish("incomplete", "not_published");
      if (publication.status === "superseded") return finish("incomplete", "superseded_head");
      // The abstention's own reason: a material unknown vs a certification
      // gate withholding. A withholding with NO verdict-bearing native
      // event (an advisory comment/review_comment publication) is
      // `advisory_only`; a withheld COMMENT on a verdict-bearing surface
      // (fork scope policy) is `approval_withheld`.
      if (disposition.reason === "material_unknown") return finish("incomplete", "material_unknown");
      return finish("incomplete", publication.native === undefined ? "advisory_only" : "approval_withheld");
    }
    if (disposition.kind === "request_changes") {
      // The block counts as LANDED only when the native record proves a
      // REQUEST_CHANGES review actually landed — the same positive proof
      // `approved` requires (#1580 review fix). A failed publication with
      // no proved landed native block attests the capability failure,
      // never `blocked`.
      const native = signals.publication?.native;
      if (native !== undefined && native.event === "REQUEST_CHANGES" && native.submitted === true) {
        return finish("blocked", "request_changes");
      }
      if (signals.publication?.status === "failed") {
        if (native !== undefined && native.event === "REQUEST_CHANGES") {
          return finish("unavailable", "native_submission_failed");
        }
        return finish("unavailable", "publication_failed");
      }
      if (signals.publication === undefined) return finish("incomplete", "not_published");
      if (signals.publication.status === "superseded") return finish("incomplete", "superseded_head");
      return finish("incomplete", "advisory_only");
    }
    // kind approve — the publication proof decides between a certified
    // approval and every abstention (the disposition already established
    // complete coverage and no material unknown).
    const publication = signals.publication;
    if (publication === undefined) return finish("incomplete", "not_published");
    if (publication.status === "superseded") return finish("incomplete", "superseded_head");
    const native = publication.native;
    if (publication.status === "failed") {
      if (native !== undefined && native.event === "APPROVE") return finish("unavailable", "native_approval_failed");
      return finish("unavailable", "publication_failed");
    }
    if (native === undefined) return finish("incomplete", "advisory_only");
    if (native.event === "APPROVE" && native.submitted === true) {
      if (head === "") return finish("unavailable", "head_unknown");
      if (native.fellBack === true) return finish("incomplete", "native_approval_unbound");
      return finish("approved", "native_approval_submitted");
    }
    return finish("incomplete", "approval_withheld");
  }
  // ── Legacy signal table (callers without the #1656 disposition) ────────
  if (signals.modelUnavailable === true) return finish("unavailable", "model_unavailable");
  if (signals.degraded === true) return finish("unavailable", "degraded_no_evidence");
  const verdict = signals.verdict ?? "";
  if (verdict === "request_changes") {
    // A non-degraded request_changes verdict is a trusted block. The block
    // counts as LANDED only when the native record proves a REQUEST_CHANGES
    // review actually landed.
    const native = signals.publication?.native;
    if (native !== undefined && native.event === "REQUEST_CHANGES" && native.submitted === true) {
      return finish("blocked", "request_changes");
    }
    // A FAILED publication lands no block of its own. The publish seam can
    // fail before any native submission is attempted (its outer catch, a
    // mode guard, a stale-head re-check) and then records no native event
    // at all — so a failed publication with no proved landed native block
    // must never attest `blocked` (#1580 review fix).
    if (signals.publication?.status === "failed") {
      // The API rejected the REQUEST_CHANGES submission: the block did not
      // reach the pull request. The capability failed, not the block —
      // symmetric with `native_approval_failed`.
      if (native !== undefined && native.event === "REQUEST_CHANGES") {
        return finish("unavailable", "native_submission_failed");
      }
      // No native record at all: nothing proves a block landed. The
      // publication failure is the honest cause.
      return finish("unavailable", "publication_failed");
    }
    // No landed native block: `blocked` requires the same positive proof
    // `approved` does — a native REQUEST_CHANGES review that actually
    // reached the pull request (#1580 review fix). Publication that was
    // never attempted, withheld at the head re-check, or landed only
    // advisory (comment mode / no native surface) attests the cause
    // instead, mirroring the approve path's `not_published`,
    // `superseded_head` and `advisory_only` rows.
    if (signals.publication === undefined) return finish("incomplete", "not_published");
    if (signals.publication.status === "superseded") return finish("incomplete", "superseded_head");
    return finish("incomplete", "advisory_only");
  }
  if (verdict !== "approve") return finish("unavailable", "no_verdict");
  if ((signals.requiredChecks ?? "none") === "incomplete") return finish("incomplete", "required_checks_incomplete");
  if ((signals.incompleteReason ?? "none") !== "none"
    || (signals.reviewResult ?? "") === "partial"
    || signals.partialCoverage === true) return finish("incomplete", "coverage_incomplete");
  const publication = signals.publication;
  if (publication === undefined) return finish("incomplete", "not_published");
  if (publication.status === "superseded") return finish("incomplete", "superseded_head");
  const native = publication.native;
  // A REQUEST_CHANGES verdict-bearing review that actually landed is a
  // block on the pull request itself — it outranks a contradicting verdict
  // field. The publish seam derives the event from the disposition (#1596),
  // so this mismatch is a live path: a still-open blocker/major finding
  // under a non-strict approve verdict publishes REQUEST_CHANGES, and the
  // attestation reads the landed block, never the stale verdict field.
  if (native !== undefined && native.event === "REQUEST_CHANGES" && native.submitted === true) {
    return finish("blocked", "request_changes");
  }
  if (publication.status === "failed") {
    if (native !== undefined && native.event === "APPROVE") return finish("unavailable", "native_approval_failed");
    return finish("unavailable", "publication_failed");
  }
  // published
  if (native === undefined) return finish("incomplete", "advisory_only");
  if (native.event === "APPROVE" && native.submitted === true) {
    if (head === "") return finish("unavailable", "head_unknown");
    // The body-only fallback (#1249) submitted the APPROVE WITHOUT a
    // `commit_id`: GitHub binds such a review to whatever head is current
    // at submission time, so it certifies nothing about THIS reviewed head.
    // An unbound approval is never `approved` (review finding on #1580).
    if (native.fellBack === true) return finish("incomplete", "native_approval_unbound");
    return finish("approved", "native_approval_submitted");
  }
  // A COMMENT submission on an otherwise-complete approve review is the
  // publish boundary's explicit abstention (#1447); a non-landed COMMENT
  // submission on a "published" outcome is unreachable — both read as
  // abstention, never approval.
  return finish("incomplete", "approval_withheld");
}

/** The compact single-line JSON serialization of one attestation (the
 * `review-attestation` step output surface). Closed-vocabulary fields are
 * written verbatim; the head SHA is a hex-or-empty token by construction. */
export function serializeReviewAttestation(attestation: ReviewAttestation): string {
  return JSON.stringify(attestation);
}

/** The disposition-shaped input the attestation consumes on the
 * #1656 authoritative path: the engine's ONE final object (kind, machine
 * reason and the material unknowns), carried from `FinalDisposition` — the
 * same object the published recommendation, the handoff, the marker and
 * the native event already read, so the attestation can never disagree
 * with any of them about what the run concluded. The structural subset
 * keeps the attestation decoupled from the disposition module's type. */
export interface AttestationDisposition {
  kind: "request_changes" | "approve" | "incomplete" | "unavailable";
  reason: string;
  blockerProven: boolean;
  approvalCertified: boolean;
  materialUnknowns: ReadonlyArray<{ code: string }>;
}

/** Fail-closed parse for consumers of the `review-attestation` output (and
 * the bundle's `attestation` section): exact vocabulary, string types, or
 * null. Anything this refuses must be treated as absent — a malformed
 * attestation must never be read as any conclusion, least of all
 * `approved`. The `head_sha` is shape-checked: `approved` must pin a full
 * 40/64-hex git object id (the shapes the engine's own revision guard
 * accepts), other conclusions may pin "" for an unprovable head, and any
 * other token is refused — a non-SHA value can never be read as a head
 * binding. The conclusion/reason pair must also be one the decision table
 * can emit: a valid reason code under an unrelated conclusion is refused.
 * */
export function parseReviewAttestation(value: unknown): ReviewAttestation | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.conclusion !== "string"
    || !(REVIEW_ATTESTATION_CONCLUSIONS as readonly string[]).includes(record.conclusion)) return null;
  if (typeof record.reason_code !== "string"
    || !(REVIEW_ATTESTATION_REASON_CODES as readonly string[]).includes(record.reason_code)) return null;
  // Coherence: the pair must be one `computeReviewAttestation` can emit.
  // An `approved` conclusion carrying an unrelated reason code is malformed
  // — never an approval.
  const reasons = REVIEW_ATTESTATION_CONCLUSION_REASONS[record.reason_code as ReviewAttestationReasonCode];
  if (!reasons.includes(record.conclusion as ReviewAttestationConclusion)) return null;
  if (typeof record.head_sha !== "string") return null;
  const headIsSha = ATTESTATION_HEAD_SHA_RE.test(record.head_sha);
  // `approved` MUST name a full exact head SHA (an unprovable head can
  // never carry it); other conclusions may pin "" for a crash whose head
  // was never proven. Any other shape is a malformed attestation.
  if (record.conclusion === "approved" ? !headIsSha : !(headIsSha || record.head_sha === "")) return null;
  return {
    conclusion: record.conclusion as ReviewAttestationConclusion,
    reason_code: record.reason_code as ReviewAttestationReasonCode,
    head_sha: record.head_sha,
  };
}
