/** Conversational PR follow-up control plane (#763).
 *
 * The forge-agnostic shapes a follow-up decision is expressed in. NOTHING
 * here performs I/O or model work; the planner (`./plan.js`) composes these
 * from a canonical `follow_up` event and injected forge capabilities, and the
 * Action path and the self-hosted operator path feed it the SAME canonical
 * event so they get the SAME plan (the issue's "shared conversation/review
 * semantics" criterion). No verdict ever rides on a follow-up answer — that is
 * encoded structurally: only the `answer`/`rereview` actions exist and neither
 * carries a verdict.
 */

/** Why a follow-up was dropped, in one deterministic word. Every value maps a
 * concrete gate, so a rejected follow-up is always explainable. */
export type FollowUpIgnoreReason =
  /** The event is not a `follow_up` kind — nothing to plan. */
  | "not-follow-up"
  /** The comment was authored by the reviewer's own identity (loop guard). */
  | "bot-author"
  /** The comment carries the managed-review marker: the reviewer's own body,
   * caught even when its identity could not be proven (loop guard). */
  | "managed-body"
  /** The follow-up comment body could not be read, so its intent is unknown. */
  | "source-unavailable"
  /** Neither the explicit re-review command nor a bot mention — not addressed
   * to the reviewer, so it must never trigger model work. */
  | "not-addressed"
  /** A question needs a bot handle to be addressed to, but none is configured
   * and the bot identity is unproven (fail closed — no model work). */
  | "bot-identity-unknown"
  /** The actor is proven below the permission threshold (read/none). */
  | "unauthorized"
  /** The permission lookup could not prove the actor (uncertain → fail
   * closed). */
  | "permission-unknown"
  /** The per-PR/per-actor follow-up rate budget is exhausted. */
  | "rate-limited";

/** The classifier's coarse intent for one follow-up comment. */
export type FollowUpIntent = "ignored" | "rereview" | "question";

/** The classifier's result: an ignored reason, an explicit re-review command,
 * or a question with its text. A tagged union so no variant carries an unused
 * field. */
export type ClassifyResult =
  | { intent: "ignored"; reason: FollowUpIgnoreReason }
  | { intent: "rereview" }
  | { intent: "question"; question: string };

/** The planner's terminal decision for one canonical follow-up event.
 *
 * - `ignore`  — no forge write, no model call, no review generation.
 * - `rereview` — the reviewer must run a NORMAL review generation for the
 *   event's head. The caller hands this back to the ordinary review pipeline
 *   (exact-head checks, deterministic enforcement, publication) — a
 *   follow-up NEVER creates a second reviewer.
 * - `answer`  — a discussion reply bounded to `prompt`; it is discussion, not
 *   a verdict, and carries no verdict-bearing field. `inReplyToCommentId` is
 *   the canonical follow-up comment id being answered; the issues-comment seam
 *   posts top-level only, so the host surfaces the linkage however its forge
 *   supports (quote/at-prefix). The publishable body is produced by ONE
 *   authoritative renderer, `renderFollowUpReply` (./reply.js), which stamps
 *   `FOLLOWUP_REPLY_MARKER` for the loop guard; `postIssueComment` then posts
 *   that body verbatim — the seam never adds or strips markers.
 */
export type FollowUpPlan =
  | { action: "ignore"; reason: FollowUpIgnoreReason }
  | { action: "rereview" }
  | { action: "answer"; prompt: string; inReplyToCommentId: string };
