/** Operator-mode ingress production host (#1294): the in-repo PRODUCTION
 * CALLER of the operator event router.
 *
 * Why this module exists: `createOperatorEventRouter` (`./operator-router.ts`)
 * had no production caller in the repository. `createForgejoWebhookHandler`
 * (`./webhook-handler.ts`) consumes a canonical `follow_up` delivery only when
 * its caller happens to hand it a `router` — and nothing in the repo did — so
 * a self-hosted operator wiring the handler on its own got an ingress that
 * merely forwarded the follow-up to `onEvent`, and one that could be mis-bound
 * (or left unbound) by the wiring. This host IS the caller: it CONSTRUCTS the
 * router — and with it the follow-up consumer, UNCONDITIONALLY, which is the
 * production binding the router module's header describes — and BINDS it into
 * the webhook handler, so an operator daemon gets a fully-wired ingress it
 * cannot mis-bind: the only operator-mode ingress construction in this repo
 * already carries the follow-up consumer.
 *
 * Single-router invariant: every canonical event the handler accepts is routed
 * by that ONE router — a `follow_up` delivery through the handler's `router`
 * branch, and every other kind through `onEvent`, which this host wires
 * straight to `router.handleEvent`. There is no second entry point and no
 * path that reaches a canonical event without the router. Follow-up
 * consumption is therefore NOT opt-in: building the host is the whole
 * configuration.
 *
 * Error posture: a REJECTION from the injected `dispatch` seam PROPAGATES
 * through the router and the handler's `onEvent` into the handler's catch —
 * the response is the handler's fixed `500 {"status":"internal error"}` with
 * no error text, secret, or payload echoed, and the caller owns
 * retry/redelivery (the `gateJobPublication` convention in `./dispatch.ts`).
 * The router's follow-up branch is total (the consumer is), so a `follow_up`
 * delivery always settles with the handler's `202` acceptance, never the 500.
 *
 * Trust boundary: inherited unchanged from the two modules it binds — the
 * `X-Gitea-Signature` HMAC-SHA256 over the RAW body is verified BEFORE any
 * parse (fail closed), the `X-Gitea-Event`/`X-Gitea-Event-Type` headers stay
 * unauthenticated shape-guarded hints, and this module sees only CANONICAL
 * events: no forge payload-shape parsing, no forge CLI, no untrusted-content
 * inspection. Every forge read/write the follow-up path performs happens
 * inside the consumer through the injected forge capability
 * (`FollowUpForgeAdapter`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CanonicalForgeEvent } from "../events/types.js";
import type { FollowUpConsumerOptions } from "./followup-host.js";
import {
  createOperatorEventRouter,
  type OperatorEventRouter,
} from "./operator-router.js";
import {
  createForgejoWebhookHandler,
  type ForgejoWebhookHandlerOptions,
} from "./webhook-handler.js";

/** Configuration for {@link createOperatorHost}. */
export interface OperatorHostOptions {
  /** The webhook HMAC-SHA256 secret; the signature is verified over the raw
   * body before anything else (the handler's fail-closed boundary). */
  readonly secret: string;
  /** Maximum accepted body bytes; the handler's
   * `DEFAULT_MAX_WEBHOOK_BODY_BYTES` applies when omitted. */
  readonly maxBodyBytes?: number | undefined;
  /** The re-review trigger label; the normalizer's default applies when
   * omitted. */
  readonly rereviewLabel?: string | undefined;
  /** The operator follow-up host configuration; the router builds the
   * follow-up consumer from it. UNCONDITIONAL — this construction is the
   * production binding. */
  readonly followUp: FollowUpConsumerOptions;
  /** Where NON-follow-up canonical events go: the daemon's review-generation
   * scheduler. Absent → the router reports such events `ignored` (never
   * scheduled, never dropped). A rejection here PROPAGATES to the handler's
   * fixed 500. */
  readonly dispatch?: (event: CanonicalForgeEvent) => Promise<void> | void;
}

/** One operator-mode ingress host: the bound router plus the bound webhook
 * handler to pass to `http.createServer`. */
export interface OperatorHost {
  /** The single router every canonical event this ingress accepts goes
   * through — constructed here, unconditionally. */
  readonly router: OperatorEventRouter;
  /** The webhook handler (HMAC-verified, fixed response bodies) ready to be
   * installed on a Node http server. */
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
}

/** Create the operator-mode ingress host. See the module header for the
 * single-router invariant, the error posture, and the trust boundary. */
export function createOperatorHost(options: OperatorHostOptions): OperatorHost {
  // Constructed ONCE, here, UNCONDITIONALLY: this construction is the
  // in-repo production caller of the router (and through it of the
  // follow-up consumer) — the binding whose absence the router's header
  // names and this module exists to make real.
  const router = createOperatorEventRouter({
    followUp: options.followUp,
    dispatch: options.dispatch,
  });
  const handlerOptions: ForgejoWebhookHandlerOptions = {
    secret: options.secret,
    ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
    ...(options.rereviewLabel !== undefined ? { rereviewLabel: options.rereviewLabel } : {}),
    // The handler's follow-up lane: a canonical `follow_up` delivery is
    // handed to this router and never to onEvent — the operator lane
    // CONSUMES it (plan, answer, publish) instead of forwarding it.
    router,
    // Every OTHER canonical event the handler accepts lands here and goes to
    // the SAME router: one entry point for the whole operator lane, so no
    // delivery can bypass the routing policy above. `await` (not `void`)
    // keeps a dispatch rejection PROPAGATING to the handler's catch — the
    // handler owns the fixed 500 and the caller owns retry/redelivery.
    onEvent: async (event) => {
      await router.handleEvent(event);
    },
  };
  return { router, handler: createForgejoWebhookHandler(handlerOptions) };
}
