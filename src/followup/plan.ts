/** Shared follow-up planner (#763): the one decision both the Action path and
 * the self-hosted operator path make for a canonical `follow_up` event.
 *
 * It composes the deterministic gates in a fixed order and never performs
 * model work itself — it returns a plan the host publishes:
 *
 *   1. kind guard           — only `follow_up` events are planned.
 *   2. loop guards + intent — classify the comment (bot's own body, the
 *                             explicit re-review command, or a mention).
 *   3. authority gate       — triage-or-higher via the SHARED predicate.
 *   4. explicit re-review   — handed straight back to the NORMAL review
 *                             pipeline (its own admission/dedup); never a
 *                             second reviewer, never a verdict here.
 *   5. PR-state gate (Q&A)  — a closed/merged or draft PR gets no answer
 *                             (#1298): mirrors the shipped `comment-pr-closed`
 *                             / `comment-pr-draft` comment-command gates
 *                             (#961) on a parity-safe capability read; an
 *                             unproven state fails closed. Runs BEFORE the
 *                             rate budget so dead lanes consume nothing.
 *   6. rate gate (Q&A only) — per-PR and per-actor-within-PR budgets for
 *                             open-ended questions, recorded atomically.
 *   7. answer               — a bounded discussion prompt.
 *
 * The authority gate mirrors but does NOT replace the review pipeline's own
 * gates: a re-review still runs precheck admission, exact-head checks,
 * deterministic enforcement and publication exactly as any other review, so a
 * follow-up can never carry or mutate a verdict — an `answer` plan has no
 * verdict-bearing field by construction, and a stale-head `answer` is only
 * ever discussion.
 *
 * Every forge read is injected through a capability-shaped callback so the
 * planner is backend-agnostic and testable; nothing here shells out to a forge
 * CLI.
 */

import { classifyCommentAuthority, type AuthorityReading } from "../precheck/comment-authority.js";
import type { CanonicalForgeEvent } from "../events/types.js";
import type { PrStateReading } from "../platform/pr.js";
import { classifyFollowUpComment } from "./classify.js";
import {
  consumeFollowUpBudget,
  type RateLimitRule,
  type RateLimitScope,
  type RateLimitStore,
} from "./rate-limit.js";
import { buildFollowUpPrompt } from "./prompt.js";
import type { FollowUpIgnoreReason, FollowUpPlan } from "./types.js";

/** The per-scope follow-up rate budget. Both scopes must pass for a follow-up
 * to trigger work. */
export interface FollowUpRateLimits {
  perPr: RateLimitRule;
  perActor: RateLimitRule;
}

/** Sensible default follow-up budgets: a generous-but-bounded per-PR budget
 * with a tighter per-actor budget, so one person cannot dominate a PR while a
 * busy review thread is not throttled unfairly. Callers may override. */
export const DEFAULT_FOLLOW_UP_RATE_LIMITS: FollowUpRateLimits = {
  perPr: { limit: 6, windowMs: 15 * 60_000 },
  perActor: { limit: 4, windowMs: 15 * 60_000 },
};

/** Host configuration for the planner. */
export interface FollowUpPlanConfig {
  /** Explicit re-review command (e.g. `/ai-review`); "" disables it. */
  rereviewCommand: string;
  /** Handles a question must address to reach the reviewer. */
  mentionHandles: readonly string[];
  rateLimit: FollowUpRateLimits;
}

/** A forge capability that reports a login's collaborator permission as the
 * shared authority reading, or `null` when it proves nothing. Both the read
 * seam (`ghApi` + `authorityReadingFromPayload`) and the publish seam
 * (`collaboratorPermission`) produce this shape; the host binds whichever it
 * has. */
export type PermissionProbe = (login: string) => Promise<AuthorityReading | null>;

export interface FollowUpPlanDeps {
  /** Deterministic clock (epoch ms). */
  clock: () => number;
  /** The reviewer's own authenticated identity, or null when unproven. */
  botLogin: string | null;
  readPermission: PermissionProbe;
  rateLimitStore: RateLimitStore;
  /** Recent PR conversation comments (raw platform shapes) for the answer
   * context. Only fetched for a question, never for a re-review. */
  fetchThreadComments: () => Promise<readonly unknown[]>;
  /** Reads the follow-up comment body when the caller does not already hold
   * it (operator mode). The Action path passes the body on the request and
   * omits this. */
  readComment?: (commentId: string) => Promise<string>;
  /** The latest managed review body (for the answer context), if any. */
  latestManagedReview?: () => Promise<string>;
  /** The PR description's last-edit instant (superseded-discussion labeling). */
  prLastEditedAt?: () => Promise<string | null>;
  /** The PR's open/closed + draft state through a parity-safe forge
   * capability (#1298) — a canonical `PrStateReading`, never a payload
   * sniff. REQUIRED: the closed/draft gate is policy, not context, so a host
   * that cannot read PR state must say so at the type, not silently skip the
   * gate. A throw or an `unknown` half fails closed (`pr-state-unknown`). */
  readPrState: () => Promise<PrStateReading>;
}

export interface FollowUpPlanRequest {
  /** The canonical event; must be kind `follow_up`. */
  event: CanonicalForgeEvent;
  /** The comment body, when the host already received it (Action mode). When
   * absent, the planner reads it through {@link FollowUpPlanDeps.readComment}. */
  body?: string;
}

function ignore(reason: FollowUpIgnoreReason): FollowUpPlan {
  return { action: "ignore", reason };
}

/** Decide what to do with a canonical `follow_up` event. See module header for
 * the gate order. Total and side-effect-free except through injected deps: it
 * never throws (a failing read degrades to a fail-closed ignore or, for answer
 * context, to a smaller prompt). */
export async function planFollowUp(
  request: FollowUpPlanRequest,
  deps: FollowUpPlanDeps,
  config: FollowUpPlanConfig,
): Promise<FollowUpPlan> {
  const { event } = request;
  if (event.kind !== "follow_up") return ignore("not-follow-up");

  // 2a. Resolve the comment body: the request carries it in Action mode;
  // operator mode reads it by its canonical comment id. An unreadable body
  // means unknown intent, so do nothing (fail closed — no model work).
  let body = request.body;
  if (typeof body !== "string") {
    body = "";
    if (event.eventReference !== "" && deps.readComment !== undefined) {
      try {
        body = await deps.readComment(event.eventReference);
      } catch {
        body = "";
      }
    }
  }
  if (body === "") return ignore("source-unavailable");

  // 2b. Classify intent (loop guards run inside, before any work intent).
  const classification = classifyFollowUpComment({
    body,
    authorLogin: event.actor,
    botLogin: deps.botLogin,
    rereviewCommand: config.rereviewCommand,
    mentionHandles: config.mentionHandles,
  });
  if (classification.intent === "ignored") return ignore(classification.reason);

  // 3. Authority gate — only reached for a work intent. An empty actor proves
  // nothing and can never be authorized.
  if (event.actor === "") return ignore("permission-unknown");
  let reading: AuthorityReading | null;
  try {
    reading = await deps.readPermission(event.actor);
  } catch {
    reading = null;
  }
  const authority = classifyCommentAuthority(reading, event.actor);
  if (authority === "unauthorized") return ignore("unauthorized");
  if (authority !== "authorized") return ignore("permission-unknown");

  // 4. Explicit re-review → hand back to the NORMAL review pipeline BEFORE the
  // follow-up budget. Its admission and generation dedup are the pipeline's own
  // job (a repeat on an unchanged head collapses to one generation id), and the
  // open-ended Q&A budget must never silently swallow a maintainer's explicit
  // command. Authority was already proven above.
  if (classification.intent === "rereview") return { action: "rereview" };

  // 5. PR-state gate (Q&A only, #1298) — a closed/merged or draft PR gets no
  // answer: the same deterministic states the shipped `/ai-review` comment
  // command refuses on (`comment-pr-closed` / `comment-pr-draft`, #961). The
  // state arrives as a parity-safe capability reading (GitHub's comment
  // payload carries `issue.state`, Forgejo's differs — so neither host
  // sniffs its payload; the gate lives here instead). Merged PRs report
  // `closed` on both forges. An unprovable state fails closed like the
  // comment path's `comment-pr-lookup-failed`: uncertainty never answers.
  // Before the rate budget, so a dead lane consumes no budget, and AFTER the
  // re-review hand-off, whose admission stays the review pipeline's own.
  let prState: PrStateReading;
  try {
    prState = await deps.readPrState();
  } catch {
    prState = { state: "unknown", draft: "unknown" };
  }
  if (prState.state === "unknown") return ignore("pr-state-unknown");
  if (prState.state === "closed") return ignore("pr-closed");
  if (prState.draft === "unknown") return ignore("pr-state-unknown");
  if (prState.draft === "draft") return ignore("pr-draft");

  // 6. Question rate gate — the open-ended, spam-able model work is bounded
  // per-PR and per-actor WITHIN the PR: the actor scope is that actor's own
  // questions on this PR (the intent "one person cannot dominate a PR"), not a
  // repo-wide allowance. `repoFullName` is canonical-lowercase at the event
  // boundary; it is lowercased again here — for both scopes — so a hand-built
  // event cannot split or share one PR's actor budget by casing. Recorded only
  // when BOTH scopes still allow.
  const now = deps.clock();
  const repo = event.repoFullName.toLowerCase();
  const scopes: RateLimitScope[] = [
    { key: `pr:${event.platform}:${repo}#${event.prNumber}`, rule: config.rateLimit.perPr },
    { key: `actor:${event.platform}:${repo}#${event.prNumber}:${event.actor.toLowerCase()}`, rule: config.rateLimit.perActor },
  ];
  if (!consumeFollowUpBudget(deps.rateLimitStore, scopes, now).allowed) {
    return ignore("rate-limited");
  }

  // 7. Question → bounded discussion prompt (never a verdict).
  const thread = await deps.fetchThreadComments().catch(() => [] as readonly unknown[]);
  const managed = deps.latestManagedReview === undefined
    ? undefined
    : await deps.latestManagedReview().catch(() => "");
  const editedAt = deps.prLastEditedAt === undefined
    ? null
    : await deps.prLastEditedAt().catch(() => null);
  const prompt = buildFollowUpPrompt({
    repository: event.repoFullName,
    prNumber: String(event.prNumber),
    headSha: event.headSha,
    question: classification.question,
    threadComments: thread,
    ...(managed !== undefined && managed !== "" ? { managedReviewBody: managed } : {}),
    ...(editedAt !== null && editedAt !== "" ? { supersededBefore: editedAt } : {}),
  });
  return { action: "answer", prompt, inReplyToCommentId: event.eventReference };
}
