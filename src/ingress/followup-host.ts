/** Self-hosted operator-mode consumer host for canonical `follow_up` events
 * (#1294).
 *
 * This host is the operator side of the split in
 * `src/followup/controller.ts`: it feeds the SAME canonical event into the
 * SAME shared planner (`planFollowUp`, through `runFollowUpEvent`) that the
 * Action path uses, so both hosts reach the identical plan — and, for
 * identical fixtures, the byte-identical answer prompt — for an identical
 * event (the action/operator parity guarantee). One `handleEvent` call plans
 * exactly once; this module adds no decision of its own.
 *
 * All forge I/O arrives through the injected {@link FollowUpForgeAdapter} —
 * the configured forge capability (the read-only API client or the GitHub App
 * client bound by the daemon). Nothing here shells out to a forge CLI and
 * nothing here parses a forge payload shape: raw webhook payloads are
 * normalized to `CanonicalForgeEvent` at the ingress boundary before this
 * host ever sees one, so the host is forge-agnostic by construction.
 *
 * Fail-closed posture:
 * - the bot identity probe is injected and caller-cached; a failure or
 *   `null` leaves the identity unproven, and the planner's loop/mention
 *   guards fail closed on that — no model work is ever guessed;
 * - a body-absent (operator-mode) request reads the comment through
 *   `adapter.readComment` by its canonical comment id; an unreadable body
 *   means unknown intent and is ignored;
 * - Q&A answers only open, non-draft PRs (#1298): the planner's PR-state
 *   gate reads through `adapter.readPrState` — the parity-safe capability
 *   read mirroring the shipped `comment-pr-closed` / `comment-pr-draft`
 *   comment-command gates — never a payload sniff; an unproven state fails
 *   closed with no model work and no reply;
 * - a rereview request whose exact head cannot be resolved is refused BEFORE
 *   the generation ledger is touched (no partial generation, no leaked
 *   reservation);
 * - a failed enqueue handoff releases the ledger reservation (the
 *   reservation contract in `./dispatch.js`) so a redelivery can re-mint the
 *   review instead of losing it until restart.
 *
 * The rereview path reuses the shipped dispatch path —
 * `dispatchCanonicalEvent` — to mint the exact-head NORMAL review generation
 * and hands it to the queue through the optional `enqueueRereviewJob`: no
 * second reviewer, no model work; the review's own admission, exact-head,
 * enforcement, and publication pipeline owns it.
 */

import type { CanonicalForgeEvent } from "../events/types.js";
import {
  runFollowUpEvent,
  type FollowUpEffects,
  type FollowUpRunOutcome,
} from "../followup/controller.js";
import {
  DEFAULT_FOLLOW_UP_RATE_LIMITS,
  type FollowUpPlanConfig,
  type FollowUpPlanDeps,
  type FollowUpRateLimits,
} from "../followup/plan.js";
import type { RateLimitStore } from "../followup/rate-limit.js";
import type { AuthorityReading } from "../precheck/comment-authority.js";
import type { PrStateReading } from "../platform/pr.js";
import type { BuildJobOptions, ReviewJob } from "../jobs/types.js";
import { dispatchCanonicalEvent, type GenerationLedger } from "./dispatch.js";

/** The forge capability surface one follow-up event needs. Every member is a
 * configured forge API call (read-only client / App client over the typed
 * transport), bound by the daemon — never a forge CLI. */
export interface FollowUpForgeAdapter {
  /** The actor's repository-collaborator permission as the shared authority
   * reading; `null` when it proves nothing. A throw is tolerated by the
   * planner, which fails closed on both. */
  readPermission(repoFullName: string, login: string): Promise<AuthorityReading | null>;
  /** The body of one follow-up comment, by canonical comment id. Throwing or
   * returning empty means unknown intent — the planner fails closed
   * (`source-unavailable`). */
  readComment(repoFullName: string, commentId: string): Promise<string>;
  /** Recent PR conversation comments (raw platform shapes) for the answer
   * context. Only fetched for a question, never for a re-review. */
  fetchThreadComments(repoFullName: string, prNumber: number): Promise<readonly unknown[]>;
  /** The PR's open/closed + draft state as the parity-safe
   * {@link PrStateReading} (#1298), derived at the daemon binding from the
   * forge's own PR read (GitHub pulls shape; the Forgejo client's
   * `getPullRequest` normalizes to it) — never a webhook-payload sniff.
   * REQUIRED: the planner's closed/draft gate is policy; a throw or an
   * `unknown` half fails closed (`pr-state-unknown`). */
  readPrState(repoFullName: string, prNumber: number): Promise<PrStateReading>;
  /** The latest managed review body (for the answer context), if any;
   * optional capability — absent means the prompt degrades without it. */
  latestManagedReview?(repoFullName: string, prNumber: number): Promise<string>;
  /** The PR description's last-edit instant (superseded-discussion labeling);
   * optional capability — absent means no superseded labeling. */
  prLastEditedAt?(repoFullName: string, prNumber: number): Promise<string | null>;
  /** Post an already-rendered comment body verbatim through the configured
   * forge capability; `false` when the write failed or the forge refuses
   * plain comment posts. */
  postComment(repoFullName: string, prNumber: number, body: string): Promise<boolean>;
  /** The PR's current head commit SHA; `null` when it cannot be read (the
   * rereview path fails closed on `null`). */
  resolveHeadSha(repoFullName: string, prNumber: number): Promise<string | null>;
  /** The PR's stable identity (`prId`, base SHA) for the rereview projection;
   * optional best-effort capability. Comment payloads normalize with
   * `prId: 0`/`baseSha: ""` (the `issue.pull_request` link carries no PR
   * object), and both are generation-IDENTITY fields — hydrating them lets a
   * comment-command rereview dedupe against a label/push generation of the
   * same head. A failed or absent read only loses that cross-trigger dedupe
   * (the projection stays a valid single generation); it never refuses the
   * rereview. */
  resolvePrIdentity?(repoFullName: string, prNumber: number): Promise<{ prId: number; baseSha: string } | null>;
}

/** Host configuration for {@link createFollowUpConsumer}. */
export interface FollowUpConsumerOptions {
  /** The configured forge capability; the ONLY forge I/O seam of this host. */
  adapter: FollowUpForgeAdapter;
  /** The reviewer's own authenticated identity probe. The caller caches it;
   * `null` means unproven identity and fails closed in the planner's guards. */
  botLogin: () => Promise<string | null>;
  /** Deterministic clock (epoch ms) for the follow-up rate budget. */
  clock: () => number;
  /** The follow-up rate budget store, shared per process; the durable
   * cross-restart store is `DurableRateLimitStore` (#1295). */
  rateLimitStore: RateLimitStore;
  /** Explicit re-review command (e.g. `/ai-review`); "" disables it. */
  rereviewCommand: string;
  /** Handles a question must address to reach the reviewer. */
  mentionHandles: readonly string[];
  /** The Q&A rate budget; defaults to `DEFAULT_FOLLOW_UP_RATE_LIMITS`. */
  rateLimit?: FollowUpRateLimits;
  /** One-shot model executor for answer prompts (`createFollowUpAnswerExecutor`
   * bound by the daemon). Runs only after the planner's authority gate and
   * Q&A budget allowed a question. */
  answer: (prompt: string) => Promise<string>;
  /** The process-shared generation ledger for review dedupe. */
  ledger: GenerationLedger;
  /** Job build options (config fingerprint, adoption epoch, …) for the
   * rereview generation; forwarded to the dispatch path unchanged. */
  buildOptions?: BuildJobOptions;
  /** Hand the minted review generation to the queue. `false` (or a throw)
   * means the enqueue failed: the reservation is released and the outcome is
   * `refused`. Absent means the ledger reservation is the handoff the
   * daemon drains. */
  enqueueRereviewJob?(job: ReviewJob): Promise<boolean>;
}

/** One operator-mode follow-up consumer; call `handleEvent` per canonical
 * event. Total over its effects; a store contract violation out of the
 * planner (a `record` that refuses an unpersistable charge) rejects, and the
 * webhook handler's boundary catch degrades it. */
export interface FollowUpConsumer {
  handleEvent(event: CanonicalForgeEvent, body?: string): Promise<FollowUpRunOutcome>;
}

/** Create the operator-mode follow-up consumer. See the module header for the
 * parity and fail-closed guarantees. */
export function createFollowUpConsumer(options: FollowUpConsumerOptions): FollowUpConsumer {
  const { adapter } = options;
  return {
    async handleEvent(event, body) {
      const repoFullName = event.repoFullName;
      const prNumber = event.prNumber;

      // The identity probe is caller-cached; a failure or `null` leaves the
      // bot identity unproven — the planner's loop/mention guards fail
      // closed on that, they never guess.
      let botLogin: string | null;
      try {
        botLogin = await options.botLogin();
      } catch {
        botLogin = null;
      }

      const deps: FollowUpPlanDeps = {
        clock: options.clock,
        botLogin,
        // Forwarded as-is: the planner catches a throwing probe and fails
        // closed (null reading).
        readPermission: (login) => adapter.readPermission(repoFullName, login),
        rateLimitStore: options.rateLimitStore,
        // Forwarded as-is: the planner catches a throwing thread read and
        // degrades to a smaller prompt.
        fetchThreadComments: () => adapter.fetchThreadComments(repoFullName, prNumber),
        // Forwarded as-is: the planner catches a throwing state read and
        // fails closed (`pr-state-unknown`) — no model work, no reply.
        readPrState: () => adapter.readPrState(repoFullName, prNumber),
        // Operator mode: the caller does not already hold the comment body,
        // so the planner reads it by its canonical comment id. Action mode
        // passes the body on the request and omits this.
        ...(body === undefined
          ? { readComment: (commentId: string) => adapter.readComment(repoFullName, commentId) }
          : {}),
        ...(adapter.latestManagedReview !== undefined
          ? { latestManagedReview: () => adapter.latestManagedReview!(repoFullName, prNumber) }
          : {}),
        ...(adapter.prLastEditedAt !== undefined
          ? { prLastEditedAt: () => adapter.prLastEditedAt!(repoFullName, prNumber) }
          : {}),
      };

      const config: FollowUpPlanConfig = {
        rereviewCommand: options.rereviewCommand,
        mentionHandles: options.mentionHandles,
        rateLimit: options.rateLimit ?? DEFAULT_FOLLOW_UP_RATE_LIMITS,
      };

      const effects: FollowUpEffects = {
        answer: options.answer,
        // The rendered body is the only thing this write seam ever sees
        // (the consumer renders it); the adapter posts it verbatim.
        postComment: (commentBody) => adapter.postComment(repoFullName, prNumber, commentBody),
        rereview: async (rereviewEvent) => {
          // The exact head the rereview generation is about. Comment
          // payloads normalize with headSha "" (the platform adapter has not
          // hydrated them), so resolve the current head through the
          // configured forge capability.
          let headSha: string | null = rereviewEvent.headSha;
          if (headSha === "") {
            try {
              headSha = await adapter.resolveHeadSha(repoFullName, prNumber);
            } catch {
              headSha = null;
            }
          }
          // Unprovable exact head → fail closed: refuse before touching the
          // ledger, so no partial generation and no leaked reservation.
          if (headSha === null || headSha === "") return "refused";
          // Hydrate the identity fields a comment payload cannot carry
          // (`prId: 0`/`baseSha: ""` — the url-only `issue.pull_request`
          // link). Both are generation IDENTITY fields, so hydration is what
          // makes a comment-command rereview dedupe against a label/push
          // generation of the same head+config. Best-effort: a missing or
          // failed read (or an unusable value) only loses that CROSS-TRIGGER
          // dedupe — the projected generation is still exactly one valid
          // review — while comment-vs-comment dedupe always holds (same
          // head, same sentinel identity).
          let prId = rereviewEvent.prId;
          let baseSha = rereviewEvent.baseSha;
          if (prId === 0 || baseSha === "") {
            // try/catch (not `.catch`) so a non-compliant adapter that throws
            // SYNCHRONOUSLY is absorbed exactly like a rejection — a failed
            // read must only lose the cross-trigger dedupe, never refuse.
            let identity: { prId: number; baseSha: string } | null | undefined;
            try {
              identity = await adapter.resolvePrIdentity?.(repoFullName, prNumber);
            } catch {
              identity = null;
            }
            if (identity !== null && identity !== undefined) {
              if (prId === 0 && Number.isSafeInteger(identity.prId) && identity.prId >= 0) prId = identity.prId;
              const hydratedBase = identity.baseSha.trim().toLowerCase();
              if (baseSha === "" && /^[0-9a-f]{7,64}$/.test(hydratedBase)) baseSha = hydratedBase;
            }
          }
          // Project the follow-up onto the NORMAL rereview generation and
          // reuse the shipped dispatch path — no second reviewer, no model
          // work. The projection is safe because the generation identity
          // deliberately excludes the producing event kind (reason is
          // routing metadata, `src/jobs/generation.ts`) and a `review` job's
          // identity forces `eventReference` "" (a review's identity never
          // depends on a comment id, even if a stray event carries one):
          // two rereview commands on an unchanged head therefore mint the
          // SAME generation — and, once the PR identity is hydrated above,
          // so does a rereview command and a `ai-review`-label (or push)
          // generation of the same head+config. When the identity cannot be
          // hydrated the cross-trigger id may differ (an extra full review
          // of an unchanged head is waste, not corruption), and the queue's
          // at-most-one-active-generation-per-PR rule stays the bound.
          const projected: CanonicalForgeEvent = {
            ...rereviewEvent,
            kind: "rereview_label",
            headSha,
            prId,
            baseSha,
          };
          const outcome = await dispatchCanonicalEvent(projected, {
            ledger: options.ledger,
            buildOptions: options.buildOptions,
          });
          if (outcome.status === "ignored") return "refused";
          if (outcome.status === "duplicate") return "duplicate";
          // "scheduled" means the generation is RESERVED in the ledger, not
          // enqueued (the reservation contract in ./dispatch.js). A failed
          // handoff releases the reservation so a redelivery can re-mint
          // the review; without an enqueue seam the reservation itself is
          // the handoff the daemon drains.
          if (options.enqueueRereviewJob !== undefined) {
            let enqueued = false;
            try {
              enqueued = await options.enqueueRereviewJob(outcome.job);
            } catch {
              enqueued = false;
            }
            if (!enqueued) {
              await options.ledger.remove(outcome.job.jobId);
              return "refused";
            }
          }
          return "enqueued";
        },
      };

      // One plan per event through the shared planner; the effects above are
      // the only place this host acts.
      const request = body === undefined ? { event } : { event, body };
      return runFollowUpEvent(request, deps, config, effects);
    },
  };
}
