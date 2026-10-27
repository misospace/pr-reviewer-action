/** Forge-backed follow-up Q&A budget (#1294/#1295).
 *
 * The shared planner's Q&A budget is a `RateLimitStore` seam
 * (`./rate-limit.js`): the deterministic policy owns the DECISION, the host
 * injects the STATE. The in-memory store in that module is correct for one
 * process, but the Action lane runs ONE PROCESS PER WEBHOOK DELIVERY, so an
 * in-memory store hands every delivery a fresh budget — the per-PR and
 * per-actor limits the planner enforces then bound nothing ACROSS deliveries.
 *
 * This module is the store that survives deliveries in the Action lane: the
 * FORGE ITSELF is the durable state. The questioner's questions are already
 * published in the PR thread before any model work is planned, so the thread
 * the platform seam reads IS the ledger, and the budget is recomputed from it
 * on every delivery.
 *
 * What is counted (both only inside the queried window):
 * - the PER-PR scope is the LARGER of two ledgers:
 *   - every mention-addressed QUESTION on this PR, whatever author posted
 *     it. Each question is at most one model attempt (the planner plans once
 *     per event and the executor is one-shot, never a retry), so the question
 *     count bounds the PR's follow-up model work whether or not any attempt
 *     SUCCEEDED: a failed model call or a failed post leaves its question in
 *     the thread, so the attempt still consumes cross-delivery budget;
 *   - the reviewer's own published follow-up REPLIES (marker AND proven
 *     identity). These are the admin-only records a participant cannot edit
 *     or erase, so the floor survives a participant deleting or rewriting
 *     their own questions — what the reply ledger says succeeded, stayed
 *     succeeded.
 *   The larger of the two keeps both properties: attempts consume (a failed
 *   attempt cannot be repeated past the limit) and successful work is
 *   durably floored. Residual, documented honestly: a participant can still
 *   evade the ATTEMPT bound by deleting their own failed questions (the
 *   admin-only floor keeps bounding what actually succeeded), and a question
 *   the planner DENIED — including an unauthorized one — also sits in the
 *   thread and counts (the store over-counts rather than under-counts;
 *   mention-spam can throttle the Q&A lane for a window, self-healing, which
 *   is the accepted cost of never letting comment traffic widen model spend —
 *   the review pipeline itself is never throttled by this budget). The
 *   per-actor scope still caps any single account;
 * - the PER-ACTOR scope is per-actor WITHIN the PR and counts THIS actor's
 *   own prior QUESTIONS on this PR — the intent the planner documents ("one
 *   person cannot dominate a PR").
 * Both scopes the store covers are therefore exactly PR-scoped, so the thread
 * is the COMPLETE state for both keys it serves — nothing the planner asks
  * about under them lives outside this PR. The durable cross-RESTART store
  * for the operator lane shipped in #1295 (`./durable-rate-limit.ts`); it is
  * not a gap in this store.
 *
 * Snapshot coverage (fail closed): the platform seam's thread read is
 * bounded to the LATEST comments (both platforms cap the snapshot), so a
 * busy thread's snapshot can silently omit earlier budgeted questions. The
 * host reports whether the snapshot provably covers the PR's whole comment
 * history (`snapshotComplete`); when it does not, a window is answerable
 * only when the snapshot demonstrably reaches back past the window's start —
 * the snapshot keeps the LATEST comments, so an in-window event missing from
 * it must be older than the snapshot's oldest entry, which is impossible
 * once that entry precedes the window. A window the snapshot cannot prove
 * covered denies every scope: an unprovable budget source must never
 * silently ALLOW model work. A comment whose creation instant the seam could
 * not report is unplaceable in any window, so a question-intent one counts
 * toward BOTH scopes in every window (conservative, never an under-count).
 *
 * Fail-closed posture:
 * - an UNREADABLE thread proves no budget headroom, so every scope denies;
 * - a window the snapshot does not provably cover denies as above;
 * - a scope this store does not cover denies as well (a scope-key change in
 *   the planner can never silently widen the budget);
 * - the question classification is the SAME classifier the planner uses, so
 *   a prior comment only counts when it would have triggered the same work —
 *   the reviewer's own publications never classify as questions (loop
 *   guards), so a participant cannot forge consumption to throttle the lane.
 *
 * The store is read-only: it never writes to the forge and never performs
 * model work. It is a projection of forge-reported data (author login,
 * creation instant, body), so the shape handling stays tolerant of the
 * platform seam's normalized comment shape.
 */

import { FOLLOWUP_REPLY_MARKER, classifyFollowUpComment } from "./classify.js";
import type { RateLimitStore } from "./rate-limit.js";

/** The count returned for a scope whose budget headroom cannot be proven.
 * `consumeFollowUpBudget` denies when the count reaches the scope's limit,
 * so any count at or above every sane limit denies the request. */
const DENY = Number.MAX_SAFE_INTEGER;

/** One conversation comment, projected to the fields the budget needs. */
interface BudgetComment {
  /** The comment id ("" when the platform did not report one). */
  id: string;
  /** The forge-reported author login ("" when unknown). */
  user: string;
  /** Creation instant in epoch millis; null when it cannot be read. */
  createdAtMs: number | null;
  /** The comment body. */
  body: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The author's login from the platform seam's comment shape. Both platforms
 * normalize `user` to a login string; the object form (`{ login }`) is
 * tolerated because a raw platform shape may reach the seam unchanged. */
function extractUser(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (isPlainObject(raw)) {
    const login = raw.login ?? raw.login_name;
    if (typeof login === "string") return login;
  }
  return "";
}

/** The creation instant from the platform seam's comment shape. An ISO-8601
 * string (what both platforms report) or epoch millis; null when it cannot be
 * read. */
function extractInstant(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Project one raw comment onto the fields the budget reads. */
function projectComment(raw: unknown): BudgetComment | null {
  if (!isPlainObject(raw)) return null;
  const id = raw.id === undefined || raw.id === null ? "" : String(raw.id);
  return {
    id,
    user: extractUser(raw.user),
    createdAtMs: extractInstant(raw.created_at),
    body: typeof raw.body === "string" ? raw.body : "",
  };
}

/** Configuration for {@link ForgeFollowUpBudget}. */
export interface ForgeFollowUpBudgetOptions {
  /** The PR conversation comments as the platform seam reported them (raw
   * platform shapes; both platforms normalize to `{id,user,created_at,body}`). */
  readonly comments: readonly unknown[];
  /** Whether the comment read SUCCEEDED. `false` proves no budget headroom,
   * so every scope denies (fail closed, never silently allow). */
  readonly readOk: boolean;
  /** Whether the snapshot provably covers the PR's WHOLE comment history.
   * Both platforms cap the thread read at the latest comments, so a host
   * that read a full-length snapshot must report `false` — a window the
   * snapshot then cannot prove covered denies (see the module header). */
  readonly snapshotComplete: boolean;
  /** The canonical platform id ("github" / "forgejo"). */
  readonly platform: string;
  /** The canonical repository full name (lowercased for the scope key, the
   * same way the planner keys its scopes). */
  readonly repoFullName: string;
  /** The PR number. */
  readonly prNumber: number;
  /** The actor whose follow-up is being planned. */
  readonly actor: string;
  /** The reviewer's proven identity; null when it could not be proven. */
  readonly botLogin: string | null;
  /** The handles a question must address to reach the reviewer. */
  readonly mentionHandles: readonly string[];
  /** The configured explicit re-review command ("" disables it). */
  readonly rereviewCommand: string;
  /** The comment id being answered — the question in flight is not yet part
   * of the thread's history and must never count against its own budget. */
  readonly currentCommentId: string;
}

/** A `RateLimitStore` whose state is the forge's own PR thread. See the
 * module header for what is counted and the fail-closed posture. */
export class ForgeFollowUpBudget implements RateLimitStore {
  /** The planner's per-PR scope key (see `planFollowUp`). */
  readonly prKey: string;
  /** The planner's per-actor scope key (see `planFollowUp`). */
  readonly actorKey: string;
  /** Every mention-addressed question on this PR, whatever author posted
   * it (epoch millis) — the per-PR scope's attempt count. */
  private readonly prQuestionInstants: number[] = [];
  /** The reviewer's own published follow-up replies (marker AND proven
   * identity, epoch millis) — the per-PR scope's admin-only floor: a
   * successful exchange's durable record is authored by the reviewer, so a
   * participant deleting their own questions cannot unwind it. The per-PR
   * count is the LARGER of the two, so the question ledger bounds attempts
   * (failed attempts consume) while the reply ledger bounds what succeeded
   * against records a participant cannot erase. */
  private readonly prReplyInstants: number[] = [];
  /** This actor's own prior questions in the thread (epoch millis). */
  private readonly questionInstants: number[] = [];
  /** Question-intent comments whose creation instant the seam could not
   * report: unplaceable in any window, so they count toward BOTH scopes in
   * EVERY window (conservative — never an under-count; counted, not
   * deduplicated, so two distinct comments count twice). */
  private unplaceableQuestions = 0;
  /** The oldest creation instant the snapshot reports (null when it reports
   * none): the reach-back marker the window-coverage proof uses. */
  private oldestObservedMs: number | null = null;
  /** Events recorded during THIS process (the store's own overlay). */
  private readonly recorded = new Map<string, number[]>();
  private readonly readOk: boolean;
  private readonly snapshotComplete: boolean;

  constructor(options: ForgeFollowUpBudgetOptions) {
    this.readOk = options.readOk;
    this.snapshotComplete = options.snapshotComplete;
    const repo = options.repoFullName.toLowerCase();
    this.prKey = `pr:${options.platform}:${repo}#${options.prNumber}`;
    this.actorKey = `actor:${options.platform}:${repo}#${options.prNumber}:${options.actor.toLowerCase()}`;
    if (!options.readOk) return;

    const actor = options.actor.toLowerCase();
    const botLogin = options.botLogin === null ? null : options.botLogin.toLowerCase();
    for (const raw of options.comments) {
      const comment = projectComment(raw);
      if (comment === null) continue;
      if (comment.createdAtMs !== null
        && (this.oldestObservedMs === null || comment.createdAtMs < this.oldestObservedMs)) {
        this.oldestObservedMs = comment.createdAtMs;
      }
      // The reviewer's own published reply: the marker the one authoritative
      // renderer stamps AND the reviewer's own proven identity — the ledger a
      // participant cannot edit or erase (forge permissions for the app's own
      // comments are admin-only). Requiring both keeps a participant from
      // forging the marker to throttle the lane.
      const isReply = comment.body.includes(FOLLOWUP_REPLY_MARKER)
        && botLogin !== null
        && comment.user.toLowerCase() === botLogin;
      if (isReply) {
        if (comment.createdAtMs !== null) this.prReplyInstants.push(comment.createdAtMs);
        else this.unplaceableQuestions += 1;
        continue;
      }
      // The same classifier the planner uses: a prior comment only counts
      // when it would have triggered the same work. A prior re-review
      // command does not consume the Q&A budget either.
      const intent = classifyFollowUpComment({
        body: comment.body,
        authorLogin: comment.user,
        botLogin: options.botLogin,
        rereviewCommand: options.rereviewCommand,
        mentionHandles: options.mentionHandles,
      });
      if (intent.intent !== "question") continue;
      // The question in flight is not yet part of the thread's history and
      // must never count against its own budget — in either scope.
      if (options.currentCommentId !== "" && comment.id === options.currentCommentId) continue;
      if (comment.createdAtMs === null) {
        // Unplaceable in any window: count it conservatively in every one.
        this.unplaceableQuestions += 1;
        continue;
      }
      this.prQuestionInstants.push(comment.createdAtMs);
      // The per-actor scope stays THIS actor's own prior questions.
      if (comment.user.toLowerCase() !== actor) continue;
      this.questionInstants.push(comment.createdAtMs);
    }
  }

  countInWindow(key: string, windowMs: number, nowMs: number): number {
    // An unreadable budget source proves no headroom: deny every scope.
    if (!this.readOk) return DENY;
    const windowStart = nowMs - Math.max(0, windowMs);
    // Snapshot coverage: a complete snapshot proves every in-window event is
    // visible outright; an incomplete (latest-N) snapshot proves it only when
    // its oldest entry precedes the window — an in-window event missing from
    // a latest-N snapshot must be OLDER than that entry, which is impossible
    // then (both seams truncate in creation-instant order, the space this
    // proof reasons in). A window the snapshot cannot prove covered denies
    // every scope.
    const covered = this.snapshotComplete
      || (this.oldestObservedMs !== null && this.oldestObservedMs <= windowStart);
    if (!covered) return DENY;
    if (key === this.prKey) {
      // The larger of the two ledgers: the question count bounds ATTEMPTS
      // (a failed model or post attempt still consumes), the reply count is
      // the admin-only floor a participant cannot unwind; the unplaceable
      // comments count in every window on top (never an under-count).
      let questions = 0;
      for (const instant of this.prQuestionInstants) {
        if (instant > windowStart && instant <= nowMs) questions += 1;
      }
      let replies = 0;
      for (const instant of this.prReplyInstants) {
        if (instant > windowStart && instant <= nowMs) replies += 1;
      }
      return this.unplaceableQuestions + Math.max(questions, replies)
        + this.overlayCount(key, windowStart, nowMs);
    }
    const source = key === this.actorKey
      ? this.questionInstants
      : null;
    // A scope this store does not cover proves no headroom either: a scope
    // key the planner changes can never silently widen the budget.
    if (source === null) return DENY;
    let count = this.unplaceableQuestions;
    for (const instant of source) {
      if (instant > windowStart && instant <= nowMs) count += 1;
    }
    return count + this.overlayCount(key, windowStart, nowMs);
  }

  /** The process's own overlay events for `key` inside the window. */
  private overlayCount(key: string, windowStart: number, nowMs: number): number {
    let count = 0;
    for (const instant of this.recorded.get(key) ?? []) {
      if (instant > windowStart && instant <= nowMs) count += 1;
    }
    return count;
  }

  record(key: string, nowMs: number): void {
    const list = this.recorded.get(key);
    if (list === undefined) {
      this.recorded.set(key, [nowMs]);
      return;
    }
    list.push(nowMs);
  }
}
