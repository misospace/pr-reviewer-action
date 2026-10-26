/** The Action-mode follow-up host (#1294): the Action path's entry point into
 * the already-built follow-up consumer (`src/followup/controller.ts`).
 *
 * It takes the raw webhook payload the Action already holds (GITHUB_EVENT_PATH),
 * normalizes it through the SAME event boundary every other event goes through
 * (`normalizeForgeEvent`), and — when the canonical event is a `follow_up` —
 * runs the shared planner + consumer once with Action-bound effects, then
 * reports one of two routes:
 *
 *   - `{ route: "follow-up" }` — the event was fully handled inside this call
 *     (an ignored comment, or an answered question posted through the publish
 *     seam). The caller must NOT run the review pipeline for this event.
 *   - `{ route: "pipeline" }` — the event is not a `follow_up` (or the
 *     follow-up asked for a re-review): the caller continues exactly as today
 *     (precheck admission, exact-head, enforcement, publication). This is the
 *     behavior-preserving fall-through for every non-follow-up delivery.
 *
 * Trust model:
 *   - The comment body is DATA, never instructions: it reaches the planner
 *     only as a classification/prompt input, and the only model output that
 *     can leave the process is the reply rendered by `renderFollowUpReply`
 *     (the loop-guard marker is stamped by the renderer, not the caller).
 *   - The reviewer's own identity comes from the forge, never from payload
 *     content: the mention handle and the loop guard use
 *     `authenticatedIdentity()`, and the managed-body context is selected
 *     under `resolveTrustedOwner()` resolved exactly the way the precheck's
 *     `selectAuthenticatedManagedBody` does. An unproven identity fails
 *     closed (no handle, no managed body — never a guess).
 *   - Actor authority is proven per comment through the read-only `ghApi`
 *     collaborator-permission seam with the shared triage-or-higher
 *     predicate; an unreadable, errored, or subject-mismatched reading fails
 *     closed (`permission-unknown` / `unauthorized`).
 *   - Re-review performs NO work here: the `rereview` effect is a pure
 *     hand-off (no side effect, no model work), and the rereview outcome is
 *     mapped back to `route: "pipeline"` so the shipped review path (its own
 *     admission, exact-head checks, deterministic enforcement, generation
 *     dedup) remains the single owner of review generations. A follow-up can
 *     never carry or mutate a verdict.
 *   - This module is silent: it never logs untrusted content (comment
 *     bodies, prompts, answers) and writes no outputs — the caller owns the
 *     action output surface and its own diagnostics.
 */

import { buildPublishApi } from "./entrypoints.js";
import { buildPlatformReadAdapter } from "./platform.js";
import { resolvePlatform } from "../platform/resolve.js";
import type { PlatformReadAdapter } from "../platform/types.js";
import type { IdentityResolution, TrustedOwnerIdentity } from "../platform/owner-identity.js";
import { normalizeForgeEvent } from "../events/normalize.js";
import { authorityReadingFromPayload, type AuthorityReading } from "../precheck/comment-authority.js";
import { lastManagedBody } from "../precheck/decide.js";
import { resolveTierProfiles } from "../routing/tiers.js";
import {
  runFollowUpEvent,
  type FollowUpEffects,
  type FollowUpRereviewDisposition,
  type FollowUpRunOutcome,
} from "../followup/controller.js";
import { createFollowUpAnswerExecutor } from "../followup/executor.js";
import { InMemoryRateLimitStore, type RateLimitStore } from "../followup/rate-limit.js";
import {
  DEFAULT_FOLLOW_UP_RATE_LIMITS,
  type FollowUpPlanConfig,
  type FollowUpPlanDeps,
  type FollowUpPlanRequest,
} from "../followup/plan.js";

/** The process-shared follow-up Q&A budget for the Action path. The Action
 * runs one webhook delivery per process, so one in-memory store per process
 * is the entire budget surface here; a cross-process host (the operator
 * controller) injects its own durable store. */
const actionFollowUpRateLimitStore = new InMemoryRateLimitStore();

/** Host-bound dependencies for one Action-mode follow-up run. Every field
 * has the production default documented; overrides exist for tests and for
 * controller-driven hosts. */
export interface ActionFollowUpDeps {
  /** The run's platform read seam. Default: `buildPlatformReadAdapter(stage)`.
   * Consumed only by a `follow_up` event; a non-follow-up event never
   * touches it. */
  readAdapter: PlatformReadAdapter;
  /** Post one already-rendered reply body through the publish seam; true only
   * when the forge confirms a created comment. Default: the run's
   * `buildPublishApi(stage).api.postIssueComment`, constructed LAZILY at call
   * time inside the effect so an override never triggers a network client. */
  postComment: (body: string) => Promise<boolean>;
  /** Run one bounded follow-up prompt through the model transport (no
   * verdict surface); "" when no answer is available. Default:
   * `createFollowUpAnswerExecutor` on the primary tier profile. */
  answer: (prompt: string) => Promise<string>;
  /** Deterministic clock (epoch ms) for the Q&A rate budget. Default:
   * `Date.now`. */
  clock: () => number;
  /** The per-PR/per-actor follow-up budget. Default: the process-shared
   * in-memory store above. */
  rateLimitStore: RateLimitStore;
}

/** What the Action host decided for one event. `follow-up`: the event was
 * fully handled inside `runActionFollowUp` (ignored, or answered and
 * posted); the caller must not run the review pipeline for it. `pipeline`:
 * continue exactly as today (precheck admission, exact-head, enforcement,
 * publication) — including a follow-up that asked for a re-review. */
export type ActionFollowUpResult =
  | { route: "follow-up"; outcome: FollowUpRunOutcome }
  | { route: "pipeline" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The comment body the host already holds (the parsed webhook payload).
 * Action mode never injects a `readComment` dep: the body arrives on the
 * plan request, and an unreadable one fails closed as `source-unavailable`. */
function commentBodyOf(rawPayload: unknown): string | undefined {
  if (!isPlainObject(rawPayload)) return undefined;
  const comment = rawPayload.comment;
  if (!isPlainObject(comment)) return undefined;
  return typeof comment.body === "string" ? comment.body : undefined;
}

/** Default answer executor: the primary tier profile's model/transport,
 * through the one-shot executor the confidence scorer's wire pattern
 * (#1073) was reused for the conversation lane. */
function defaultAnswerExecutor(stage: NodeJS.ProcessEnv): (prompt: string) => Promise<string> {
  const profile = resolveTierProfiles(stage).primary;
  return createFollowUpAnswerExecutor({
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiFormat: profile.apiFormat === "anthropic" ? "anthropic" : "openai",
    apiKey: profile.apiKey,
    reasoningEffort: profile.reasoningEffort,
    anthropicEffortSupported: profile.anthropicEffortSupported,
    requestTimeoutSec: profile.requestTimeoutSec,
    connectTimeoutSec: profile.connectTimeoutSec,
  });
}

/** Default write seam: a plain issue-comment post through the run's publish
 * API (the platform/token resolution happens inside `buildPublishApi`). The
 * client is constructed LAZILY at call time inside the effect — never at
 * host construction — so a dependency override can never trigger a network
 * client. A missing capability or any thrown error reads as "not posted". */
function defaultPostComment(stage: NodeJS.ProcessEnv): (body: string) => Promise<boolean> {
  return async (body: string): Promise<boolean> => {
    try {
      const { api } = buildPublishApi(stage as NodeJS.ProcessEnv);
      const result = await api.postIssueComment?.(body);
      return result?.created === true;
    } catch {
      return false;
    }
  };
}

/** The run's own trusted owner identity, resolved EXACTLY the way the
 * precheck's `selectAuthenticatedManagedBody` does (`src/precheck/decide.ts`):
 * a `resolveTrustedOwner()` proof when the adapter has one (Forgejo
 * Authorized Integration), else a login-kind identity from
 * `authenticatedIdentity()`. Null when it cannot be proven — a managed-body
 * read then fails closed rather than trusting an unauthenticated marker. */
async function resolveTrustedIdentity(adapter: PlatformReadAdapter): Promise<TrustedOwnerIdentity | null> {
  let resolution: IdentityResolution;
  if (typeof adapter.resolveTrustedOwner === "function") {
    try {
      resolution = await adapter.resolveTrustedOwner();
    } catch {
      resolution = { identity: null, reason: "unavailable" };
    }
  } else {
    let login: string | null = null;
    try {
      login = await adapter.authenticatedIdentity();
    } catch {
      login = null;
    }
    resolution = login === null || login.trim() === ""
      ? { identity: null, reason: "unavailable" }
      : { identity: { kind: "login", login }, reason: "user-login" };
  }
  if (resolution.identity === null) return null;
  if (resolution.identity.kind === "login" && resolution.identity.login.trim() === "") return null;
  return resolution.identity;
}

/** The superseded-discussion cutoff: the PR description's last-edited
 * revision, fail-closed (a failing snapshot proves nothing). */
function makePrBodyRevisionProbe(
  probe: () => Promise<{ body: string; editedAt: string | null } | null>,
): () => Promise<string | null> {
  return async (): Promise<string | null> => {
    try {
      return (await probe())?.editedAt ?? null;
    } catch {
      return null;
    }
  };
}

/** Bind the shared planner's forge capabilities to the Action's read seam.
 * Every probe is fail-closed (a failing read proves nothing: null/[]/""),
 * and the trust decisions stay the planner's — this host supplies
 * capabilities, not policy.
 *
 * The identity-sensitive bindings mirror the precheck exactly: the bot's
 * proven login becomes the mention handle (unproven → none, so no question
 * can fire — the planner fails closed), and the managed-review context is
 * selected only under a proven trusted owner. */
async function bindPlannerDeps(
  stage: NodeJS.ProcessEnv,
  adapter: PlatformReadAdapter,
  clock: () => number,
  rateLimitStore: RateLimitStore,
): Promise<FollowUpPlanDeps> {
  const repo = stage.REPO ?? "";
  let botLogin: string | null = null;
  try {
    botLogin = await adapter.authenticatedIdentity();
  } catch {
    botLogin = null;
  }
  return {
    clock,
    botLogin,
    readPermission: async (login): Promise<AuthorityReading | null> => {
      try {
        const r = await adapter.ghApi(`repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
        return r.error ? null : authorityReadingFromPayload(r.data);
      } catch {
        return null;
      }
    },
    rateLimitStore,
    fetchThreadComments: async (): Promise<readonly unknown[]> => {
      try {
        const rr = await adapter.listPrConversationComments();
        return rr.ok ? rr.data : [];
      } catch {
        return [];
      }
    },
    latestManagedReview: async (): Promise<string> => {
      try {
        const comments = await adapter.listIssueComments();
        const reviews = await adapter.listPrReviews();
        const identity = await resolveTrustedIdentity(adapter);
        if (identity === null) return "";
        return lastManagedBody(comments, reviews, stage.PUBLISH_MODE ?? "", "", identity);
      } catch {
        return "";
      }
    },
    // Only adapters that can snapshot the PR description revision expose the
    // superseded-discussion cutoff; the key is OMITTED (never set to
    // undefined) on the others — exactOptionalPropertyTypes. Captured in a
    // local so the optional-member narrowing survives into the closure.
    ...((typeof adapter.getPrBodyRevision === "function"
      ? {
        prLastEditedAt: makePrBodyRevisionProbe(adapter.getPrBodyRevision),
      }
      : {})),
  };
}

/** Route one Action webhook delivery through the shared follow-up consumer.
 * See the module header for the trust model and the route contract. The
 * follow-up path never throws (the consumer is total); a platform
 * resolution failure propagates exactly as the pipeline's own would. */
export async function runActionFollowUp(
  stage: NodeJS.ProcessEnv,
  rawPayload: unknown,
  overrides?: Partial<ActionFollowUpDeps>,
): Promise<ActionFollowUpResult> {
  // 1. Platform gate: the follow-up lane exists only on the Action's two
  //    implemented backends. Tangled (or anything that does not resolve to
  //    github/forgejo) continues on the normal pipeline path, unchanged.
  const platform = resolvePlatform(
    stage.PLATFORM,
    stage.FORGEJO_API_URL ?? "",
    stage.GITHUB_SERVER_URL ?? "",
    stage.TANGLED_REPO_DID ?? "",
  );
  if (platform !== "github" && platform !== "forgejo") return { route: "pipeline" };

  // 2. Canonical event through the shared boundary. Anything that does not
  //    normalize to a `follow_up` is the behavior-preserving fall-through to
  //    today's pipeline (no deps are touched past this point).
  const event = normalizeForgeEvent(platform, rawPayload, "webhook");
  if (event === null || event.kind !== "follow_up") return { route: "pipeline" };

  // 3. Host deps: overrides win; every default is constructed lazily so an
  //    override never triggers a network client.
  const readAdapter = overrides?.readAdapter ?? buildPlatformReadAdapter(stage);
  const deps: ActionFollowUpDeps = {
    readAdapter,
    postComment: overrides?.postComment ?? defaultPostComment(stage),
    answer: overrides?.answer ?? defaultAnswerExecutor(stage),
    clock: overrides?.clock ?? (() => Date.now()),
    rateLimitStore: overrides?.rateLimitStore ?? actionFollowUpRateLimitStore,
  };

  // 4. Planner bindings + config. The bot's proven login is the ONLY mention
  //    handle: a question must be addressed to the reviewer, and an
  //    unproven identity can be addressed by nothing (fail closed).
  const planDeps = await bindPlannerDeps(stage, readAdapter, deps.clock, deps.rateLimitStore);
  const config: FollowUpPlanConfig = {
    rereviewCommand: (stage.REREVIEW_COMMAND ?? "").trim(),
    mentionHandles: planDeps.botLogin ? [planDeps.botLogin] : [],
    rateLimit: DEFAULT_FOLLOW_UP_RATE_LIMITS,
  };

  // 5. Effects. The rereview hand-off performs NO side effect and NO model
  //    work: in Action mode the CURRENT run IS the normal pipeline, so the
  //    rereview outcome is mapped (step 6) to `route: "pipeline"` and the
  //    shipped review path — precheck admission, exact-head checks,
  //    deterministic enforcement, publication, generation dedup — executes
  //    for this event in this process. The effect only reports the
  //    consumer's documented success disposition.
  const effects: FollowUpEffects = {
    answer: deps.answer,
    postComment: deps.postComment,
    rereview: async (): Promise<FollowUpRereviewDisposition> => "enqueued",
  };

  // 6. The ONE execution of the shared consumer for this event (the plan and
  //    its effects are identical to the operator host's for the same event).
  const body = commentBodyOf(rawPayload);
  const request: FollowUpPlanRequest = {
    event,
    ...(body !== undefined ? { body } : {}),
  };
  const outcome = await runFollowUpEvent(request, planDeps, config, effects);
  return outcome.status === "rereview" ? { route: "pipeline" } : { route: "follow-up", outcome };
}
