/** Operator-mode canonical event router (#763/#1299): the PRODUCTION BINDING
 * that makes the self-hosted operator CONSUME the canonical `follow_up` event
 * instead of only forwarding it.
 *
 * Why this module exists: the operator ingress (`./webhook-handler.ts`) hands
 * every canonical event to the daemon's `onEvent` callback, and a `follow_up`
 * delivery was therefore never planned, never answered and never published —
 * the operator-mode follow-up consumer (`./followup-host.ts`) existed, but
 * nothing in the repo ever called it. This router IS that caller: it
 * CONSTRUCTS the consumer and routes every canonical event by kind, so the
 * operator lane consumes the SAME canonical event through the SAME shared
 * planner (`src/followup/controller.ts`) the Action lane uses — the
 * action/operator parity guarantee of #1294, now actually wired.
 *
 * Routing policy (the whole of it — the router adds no decisions of its own):
 * - a `follow_up` event goes to the follow-up consumer, and nowhere else. The
 *   consumer settles its EFFECTS as a {@link FollowUpRunOutcome}; a store
 *   contract violation out of the planner (a `record` that refuses an
 *   unpersistable charge) REJECTS, and the webhook handler's boundary catch
 *   degrades it to the fixed 500 the forge redelivers.
 * - every other canonical event goes to the injected `dispatch` seam — the
 *   daemon's review-generation scheduler, the same consumer of review
 *   generations the operator has always had. With no `dispatch` configured the
 *   event is reported as `ignored` (the router never invents a review
 *   generation, and never pretends one was scheduled).
 *
 * Error posture: a REJECTION from `dispatch` PROPAGATES to the caller, which
 * owns retry/redelivery — the same convention `gateJobPublication`
 * (`./dispatch.js`) uses for a `publish()` rejection. Swallowing it here would
 * hide a partially-scheduled generation behind a status value and lose the
 * delivery. Only the follow-up branch is exception-free, and that is a property
 * of the consumer it calls, not of this router.
 *
 * Trust boundary: the router sees only CANONICAL events — it never parses a
 * forge payload shape, never shells out to a forge CLI, and never reads
 * untrusted content. Every forge read/write the follow-up path performs
 * happens inside the consumer through the injected forge capability
 * (`FollowUpForgeAdapter`), so this module stays forge-agnostic by
 * construction.
 *
 * Budget ownership: the router is the CONSUMER seam — it carries whatever
 * budget backend its caller injects, and a router composed directly (tests,
 * a daemon that wants its own store) enforces exactly that backend and
 * nothing more. The OPERATOR PRODUCTION composition owns the cross-restart
 * budget: `createOperatorHost` (`./operator-host.ts`) constructs the durable
 * store over the operator's durable state location and injects it here, so
 * the shipped operator path always enforces a durable budget (#1295).
 */

import type { CanonicalForgeEvent } from "../events/types.js";
import type { FollowUpRunOutcome } from "../followup/controller.js";
import { createFollowUpConsumer, type FollowUpConsumerOptions } from "./followup-host.js";

/** What the router did with one canonical event.
 *
 * - `follow-up` — the event was a `follow_up` and the follow-up consumer
 *   settled it; `outcome` is the consumer's own verdict shape (the shared
 *   `FollowUpRunOutcome`, never a verdict).
 * - `dispatched` — the event was handed to the injected dispatch seam (the
 *   daemon's review-generation scheduler).
 * - `ignored` — the event was not a follow-up and no dispatch seam is
 *   configured, so nothing claimed it. */
export type OperatorEventOutcome =
  | { readonly kind: "follow-up"; readonly outcome: FollowUpRunOutcome }
  | { readonly kind: "dispatched" }
  | { readonly kind: "ignored" };

/** Configuration for {@link createOperatorEventRouter}. */
export interface OperatorEventRouterOptions {
  /** The operator follow-up host configuration — the exact binding the
   * follow-up consumer needs (the forge capability, the cached identity
   * probe, the clock, the Q&A budget store, the answer executor, the
   * generation ledger). The router builds the consumer from it. */
  readonly followUp: FollowUpConsumerOptions;
  /** Where NON-follow-up canonical events go: the daemon's review-generation
   * scheduler. Optional — without it such an event is reported as `ignored`
   * (never silently scheduled). A rejection here PROPAGATES: the caller owns
   * retry/redelivery. */
  readonly dispatch?: ((event: CanonicalForgeEvent) => Promise<void> | void) | undefined;
}

/** One operator-mode event router; call `handleEvent` per canonical event. */
export interface OperatorEventRouter {
  handleEvent(event: CanonicalForgeEvent): Promise<OperatorEventOutcome>;
}

/** Create the operator-mode event router. See the module header for the
 * routing policy, the error posture and the trust boundary. */
export function createOperatorEventRouter(options: OperatorEventRouterOptions): OperatorEventRouter {
  // Constructed ONCE, here: this construction is the production caller of the
  // follow-up consumer — the operator's canonical `follow_up` delivery now
  // reaches the shared planner instead of being forwarded and forgotten.
  const consumer = createFollowUpConsumer(options.followUp);
  return {
    async handleEvent(event: CanonicalForgeEvent): Promise<OperatorEventOutcome> {
      if (event.kind === "follow_up") {
        // The consumer settles its effects here; a store contract violation
        // out of the planner rejects (the webhook handler's catch owns the
        // fixed 500) — a follow-up delivery never falls through to the
        // review scheduler.
        const outcome = await consumer.handleEvent(event);
        return { kind: "follow-up", outcome };
      }
      const dispatch = options.dispatch;
      if (dispatch === undefined) return { kind: "ignored" };
      // A dispatch rejection PROPAGATES — the caller owns retry/redelivery
      // (the `gateJobPublication` convention in ./dispatch.js).
      await dispatch(event);
      return { kind: "dispatched" };
    },
  };
}
