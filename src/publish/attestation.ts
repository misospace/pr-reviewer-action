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
 * - `approved`: a native APPROVE review was actually submitted for the
 *   exact reviewed head, with complete required checks, complete coverage
 *   and no degraded bypass. This is the ONLY conclusion a merge automation
 *   may treat as a trusted approval.
 * - `blocked`: the final verdict is a non-degraded `request_changes` (and a
 *   native REQUEST_CHANGES review landed when publication was attempted).
 * - `incomplete`: a review ran but its conclusion is not trustworthy for
 *   this head — withheld approval, partial coverage, superseded head, or
 *   advisory-only publication.
 * - `unavailable`: the review capability itself was unavailable — a crash,
 *   an unavailable model, a degraded zero-evidence fallback, no verdict, or
 *   a failed native publication attempt.
 * - `skipped`: no review ran (precheck skip, follow-up consumption, plain
 *   no-op). A carried verdict never promotes a skip to `approved`/`blocked`
 *   — the earlier run's attestation owns that decision.
 *
 * Fail-closed invariants:
 * - Nothing here re-reads model prose or re-scores anything; every input is
 *   an action-owned signal the pipeline already produced (verdict,
 *   required-check state, review result, incomplete reason, degraded gate
 *   bypass, publication status and native submission result).
 * - `approved` is unreachable unless the native submission record proves an
 *   APPROVE landed for a non-empty exact head SHA.
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
  /** The publish boundary withheld the native approval (scope, derived
   * obligations, required evidence, degraded state, or coverage) and
   * published a non-blocking COMMENT instead. */
  "approval_withheld",
  /** Publication landed but carries no verdict-bearing native event: an
   * advisory comment/review_comment run, or a platform without a native
   * review surface. */
  "advisory_only",
  /** A complete approve review was produced but publication was not
   * attempted — nothing certifies it on the pull request. */
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
  /** The publication attempt failed for a non-approval cause. */
  "publication_failed",
  /** The head SHA the attestation would bind could not be proven. */
  "head_unknown",
  /** No review ran this run (the detailed cause rides the `skip-reason`
   * output and the bundle's `skip_reason`). */
  "skipped",
] as const;
export type ReviewAttestationReasonCode = (typeof REVIEW_ATTESTATION_REASON_CODES)[number];

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
  /** Exact reviewed head SHA ("" when unknown). */
  headSha?: string;
  /** Publication was attempted: the publish outcome plus the native
   * verdict-submission record when one was attempted (only
   * `review_verdict`/`review_blockers` modes on a platform with a native
   * review surface carry verdict-bearing events). */
  publication?: {
    status: "published" | "superseded" | "failed";
    native?: { event: string; submitted: boolean };
  };
}

/** Decide the attestation from the run's own signals. Total function, fixed
 * precedence (crash → skip → model/degraded capability → verdict → coverage →
 * publication): the capability failures are answered before the verdict
 * exists so a synthetic notice or advisory fallback can never read as a
 * verdict-backed conclusion. */
export function computeReviewAttestation(signals: ReviewAttestationSignals): ReviewAttestation {
  const head = typeof signals.headSha === "string" ? signals.headSha : "";
  const finish = (conclusion: ReviewAttestationConclusion, reason_code: ReviewAttestationReasonCode): ReviewAttestation =>
    ({ conclusion, reason_code, head_sha: head });
  if (signals.crashed === true) return finish("unavailable", "run_crashed");
  if (signals.reviewProduced === false) return finish("skipped", "skipped");
  if (signals.modelUnavailable === true) return finish("unavailable", "model_unavailable");
  if (signals.degraded === true) return finish("unavailable", "degraded_no_evidence");
  const verdict = signals.verdict ?? "";
  if (verdict === "request_changes") return finish("blocked", "request_changes");
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
  // field (defensive: the publish seam derives the event FROM the verdict,
  // so this stays fail-closed for any caller with inconsistent inputs).
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

/** Fail-closed parse for consumers of the `review-attestation` output (and
 * the bundle's `attestation` section): exact vocabulary, string types, or
 * null. Anything this refuses must be treated as absent — a malformed
 * attestation must never be read as any conclusion, least of all
 * `approved`. */
export function parseReviewAttestation(value: unknown): ReviewAttestation | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.conclusion !== "string"
    || !(REVIEW_ATTESTATION_CONCLUSIONS as readonly string[]).includes(record.conclusion)) return null;
  if (typeof record.reason_code !== "string"
    || !(REVIEW_ATTESTATION_REASON_CODES as readonly string[]).includes(record.reason_code)) return null;
  if (typeof record.head_sha !== "string") return null;
  return {
    conclusion: record.conclusion as ReviewAttestationConclusion,
    reason_code: record.reason_code as ReviewAttestationReasonCode,
    head_sha: record.head_sha,
  };
}
