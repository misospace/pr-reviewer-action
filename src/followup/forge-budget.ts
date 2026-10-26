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
 * FORGE ITSELF is the durable state. The reviewer's answers are already
 * published in the PR thread, marker-stamped by the one authoritative renderer
 * (`./reply.js`), and the questioner's own questions are already there too —
 * so the thread the platform seam reads IS the ledger, and the budget is
 * recomputed from it on every delivery.
 *
 * What is counted (both only inside the queried window):
 * - the PER-PR scope counts the reviewer's own published follow-up REPLIES on
 *   this PR — one published answer is one unit of model work, which is exactly
 *   what the budget exists to bound;
 * - the PER-ACTOR scope is per-actor WITHIN the PR and counts THIS actor's own
 *   prior QUESTIONS on this PR — the intent the planner documents ("one person
 *   cannot dominate a PR").
 * Both scopes the store covers are therefore exactly PR-scoped, so the thread
 * the platform seam reads is the COMPLETE state for both keys it serves —
 * nothing the planner asks about under them lives outside this PR. #1295
 * remains the durable cross-RESTART store target for the operator lane, which
 * can hold state beyond a single PR thread; it is not a gap in this store.
 *
 * Fail-closed posture:
 * - an UNREADABLE thread proves no budget headroom, so every scope denies —
 *   an unreadable budget source must never silently ALLOW model work;
 * - a scope this store does not cover denies as well (a scope-key change in
 *   the planner can never silently widen the budget);
 * - the reviewer's replies are recognized by the loop-guard marker AND the
 *   reviewer's proven identity, so a participant cannot forge the marker to
 *   throttle the lane.
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
  /** The reviewer's own follow-up replies in the thread (epoch millis). */
  private readonly replyInstants: number[] = [];
  /** This actor's own prior questions in the thread (epoch millis). */
  private readonly questionInstants: number[] = [];
  /** Events recorded during THIS process (the store's own overlay). */
  private readonly recorded = new Map<string, number[]>();
  private readonly readOk: boolean;

  constructor(options: ForgeFollowUpBudgetOptions) {
    this.readOk = options.readOk;
    const repo = options.repoFullName.toLowerCase();
    this.prKey = `pr:${options.platform}:${repo}#${options.prNumber}`;
    this.actorKey = `actor:${options.platform}:${repo}#${options.prNumber}:${options.actor.toLowerCase()}`;
    if (!options.readOk) return;

    const botLogin = options.botLogin === null ? null : options.botLogin.toLowerCase();
    const actor = options.actor.toLowerCase();
    for (const raw of options.comments) {
      const comment = projectComment(raw);
      if (comment === null || comment.createdAtMs === null) continue;
      // The reviewer's answer: the marker the one authoritative renderer
      // stamps AND the reviewer's own proven identity. Requiring both keeps
      // a participant from forging the marker to throttle the lane.
      const isReply =
        comment.body.includes(FOLLOWUP_REPLY_MARKER)
        && botLogin !== null
        && comment.user.toLowerCase() === botLogin;
      if (isReply) {
        this.replyInstants.push(comment.createdAtMs);
        continue;
      }
      // The actor's own prior QUESTION: the same classifier the planner uses,
      // so a prior comment only counts when it would have triggered the same
      // work. A prior re-review command does not consume the Q&A budget.
      if (comment.user.toLowerCase() !== actor) continue;
      if (options.currentCommentId !== "" && comment.id === options.currentCommentId) continue;
      const intent = classifyFollowUpComment({
        body: comment.body,
        authorLogin: comment.user,
        botLogin: options.botLogin,
        rereviewCommand: options.rereviewCommand,
        mentionHandles: options.mentionHandles,
      });
      if (intent.intent === "question") this.questionInstants.push(comment.createdAtMs);
    }
  }

  countInWindow(key: string, windowMs: number, nowMs: number): number {
    // An unreadable budget source proves no headroom: deny every scope.
    if (!this.readOk) return DENY;
    const windowStart = nowMs - Math.max(0, windowMs);
    const source = key === this.prKey
      ? this.replyInstants
      : key === this.actorKey
        ? this.questionInstants
        : null;
    // A scope this store does not cover proves no headroom either: a scope
    // key the planner changes can never silently widen the budget.
    if (source === null) return DENY;
    let count = 0;
    for (const instant of source) {
      if (instant > windowStart && instant <= nowMs) count += 1;
    }
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
