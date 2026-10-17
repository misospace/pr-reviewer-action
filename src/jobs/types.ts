/** Immutable ReviewJob contract (#728).
 *
 * The job a canonical forge event (`CanonicalForgeEvent`) can spawn: the
 * unit of work a future queue/executor (Operator mode) would schedule.
 * Like `CanonicalForgeEvent`, every field is required and uses an
 * explicit sentinel (""/0/false) instead of an optional, so consumers
 * never branch on `undefined`.
 *
 * No runtime logic lives in this module.
 */

/** What the job is. `follow_up` is Q&A on an existing review: it must
 * never mutate the managed review/verdict of the `review` job for the
 * same head. `kind` is an identity field, so the two can never share a
 * generation id either. */
export type ReviewJobKind = "review" | "follow_up";

/** How the producing observation arrived (the event's `source`). Routing
 * metadata only — NOT an identity field. */
export type ReviewTrigger = "webhook" | "poll" | "manual";

/** One immutable unit of review work. */
export interface ReviewJob {
  /** Deterministic generation id (see `deriveGenerationId`); the dedupe
   * key. Same identity fields (any source, any producing kind) => same id. */
  readonly jobId: string;
  readonly kind: ReviewJobKind;
  /** The producing event's source. Not part of the generation identity. */
  readonly trigger: ReviewTrigger;
  /** The producing event's kind (the event kind that produced the job).
   * Not part of the generation identity. */
  readonly reason: string;
  readonly platform: "github" | "forgejo";
  readonly installationId: string;
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly prId: number;
  /** Head commit SHA the review is about; review jobs require it
   * non-empty (fail closed), follow_up jobs may carry the sentinel "". */
  readonly headSha: string;
  /** Effective base/merge-base input; "" when not required. */
  readonly baseSha: string;
  /** Effective reviewer-config fingerprint (a hash; "" when unset). */
  readonly configFingerprint: string;
  /** Manual forced-rereview nonce; "" unless a manual forced rereview.
   * Always "" for follow_up jobs. */
  readonly nonce: string;
  /** Operator adoption/config-generation reference layered on the
   * `configFingerprint` (the #728 epoch dimension); "" =
   * pre-adoption/absent epoch. Changing it re-keys every job for the
   * same head+config — a disable→re-enable cycle on the unchanged
   * head+config must carry a new one so it triggers a fresh review. */
  readonly adoptionEpoch: string;
  /** The follow-up comment id the `follow_up` job answers (1–19 digits,
   * no leading zero); "" for `review` jobs — a review's identity never
   * depends on a comment id, even if a stray event carries one. */
  readonly eventReference: string;
  /** Trust metadata preserved from the event. */
  readonly fork: boolean;
  /** Deadline in epoch ms; 0 = no deadline (deadline/cancellation
   * identity). */
  readonly deadlineAtMs: number;
  /** Assigned run id; "" when not yet assigned. */
  readonly runId: string;
}

/** Options for `buildReviewJob`. */
export interface BuildJobOptions {
  /** Effective reviewer-config fingerprint. Default "". */
  configFingerprint?: string;
  /** Manual forced-rereview nonce. Must match
    * `[A-Za-z0-9._-]{1,64}` when provided for a review job (a
    * provided-but-invalid nonce fails the build); ignored for follow_up
    * jobs. */
  nonce?: string;
  /** Operator adoption/config-generation reference. Must match
    * `[A-Za-z0-9._-]{1,64}` when provided (a provided-but-invalid epoch
    * fails the build); an EMPTY/absent epoch is treated as absent
    * (becomes ""). Default "". Applies to every job kind. */
  adoptionEpoch?: string;
  /** Deadline in epoch ms. Default 0 (no deadline). */
  deadlineAtMs?: number;
  /** Run id. Default "" (not yet assigned). */
  runId?: string;
}
