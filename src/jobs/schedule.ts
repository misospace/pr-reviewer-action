/** Review-generation scheduling policy (#728): which canonical event
 * kinds create a review generation.
 *
 * This is the single scheduling decision; `buildReviewJob` enforces the
 * same boundary independently (defense in depth).
 */

import type { CanonicalForgeEvent, ForgeEventKind } from "../events/types.js";

/** The canonical kinds that create a review generation. */
const SCHEDULED_KINDS: ReadonlySet<ForgeEventKind> = new Set<ForgeEventKind>([
  "pr_opened",
  "pr_reopened",
  "synchronize",
  "ready_for_review",
  "rereview_label",
  "reconciliation_poll",
  "check_update",
]);

/** Which canonical events create a review generation.
 *
 * Every scheduleable kind requires `event.prNumber > 0`: a headless
 * `check_update` (a CI check event with no resolvable PR) creates NO
 * generation.
 *
 * `follow_up` returns FALSE here on purpose: it is not a VERDICT review.
 * A follow-up Q&A still becomes a (follow_up) job via `buildReviewJob` —
 * it is just never a candidate for the review generation a verdict would
 * be published against. `pr_closed` / `pr_merged` / `installation_change`
 * / `visibility_change` / `unknown` create no job at all. */
export function shouldSchedule(event: CanonicalForgeEvent): boolean {
  return event.prNumber > 0 && SCHEDULED_KINDS.has(event.kind);
}
