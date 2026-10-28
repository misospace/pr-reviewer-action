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
 * cannot mis-bind: the production binding lives HERE — the low-level handler
 * seam keeps the router injectable for hosts that deliberately want the
 * pre-follow-up behavior, but a host built through this module never leaves
 * the consumer out.
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
 *
 * The Q&A budget's durable backend is OWNED HERE (#1295): the operator's
 * durable state location (`durableStateDir`) is the host's configuration, and
 * the host CONSTRUCTS the durable store (`DurableRateLimitStore`) over the
 * ledger inside it and injects that store into the follow-up consumer. The
 * shipped operator path therefore cannot be composed with a non-durable
 * budget: the follow-up configuration carries no budget backend at all, and a
 * caller that smuggles one in is refused at construction. The budget survives
 * a daemon restart and is shared across controller processes, because the
 * state lives in the operator's durable state location and not in a process.
 */

import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { CanonicalForgeEvent } from "../events/types.js";
import {
  DEFAULT_RATE_LIMIT_RETENTION_MS,
  DurableRateLimitStore,
} from "../followup/durable-rate-limit.js";
import type { FollowUpRateLimits } from "../followup/plan.js";
import type { FollowUpConsumerOptions } from "./followup-host.js";
import {
  createOperatorEventRouter,
  type OperatorEventRouter,
} from "./operator-router.js";
import {
  createForgejoWebhookHandler,
  type ForgejoWebhookHandlerOptions,
} from "./webhook-handler.js";

/** The file name of the durable Q&A-budget ledger inside the operator's
 * durable state location (#1295). */
export const OPERATOR_RATE_LIMIT_LEDGER_FILENAME = "followup-rate-limit.json";

/** Probe that the durable state location can actually accept a write: an
 * EXCLUSIVE temporary file (a random name, so nothing planted is touched),
 * written and removed again. Only a file THIS probe created is ever removed.
 * The probe is what turns "the location exists" into "the location works":
 * a directory the daemon cannot write would otherwise surface as a silent
 * denial wave at the first charged question. */
function probeWritable(dir: string): void {
  const probe = join(dir, `.pr-reviewer-probe-${randomUUID()}`);
  let created = false;
  try {
    const fd = openSync(probe, "wx", 0o600);
    created = true;
    try {
      writeSync(fd, "0");
    } finally {
      closeSync(fd);
    }
    rmSync(probe, { force: true });
  } catch (err) {
    if (created) {
      try {
        rmSync(probe, { force: true });
      } catch {
        // best effort: cleanup must not mask the original failure
      }
    }
    throw err;
  }
}

/** The ledger retention the durable budget needs: at least the store's
 * default, and never SHORTER than the widest budget window the operator
 * configured — a window the retention cannot cover would deny every question
 * (fail-closed, but indistinguishable from an exhausted budget). */
function effectiveRetentionMs(rateLimit: FollowUpRateLimits | undefined): number {
  const windows = [rateLimit?.perPr?.windowMs, rateLimit?.perActor?.windowMs].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return Math.max(DEFAULT_RATE_LIMIT_RETENTION_MS, ...windows);
}

/** Construct the operator lane's durable Q&A budget over the operator's
 * durable state location: the ledger file inside that directory, the
 * directory itself prepared when missing (private mode, like every other
 * durable-state directory in this repository) so the FIRST commit can land,
 * and a write probe proving the location works.
 *
 * A location that cannot be prepared is a CONSTRUCTION failure, not a
 * deferred one: the operator lane must not start with a budget whose state it
 * cannot persist. (A store that only failed at the first charge would latch
 * the budget shut and deny every question — fail-closed, but a
 * misconfiguration the operator deserves to see at startup instead of as a
 * silent denial wave.) The path is operator-supplied configuration, never
 * request-derived, so it carries no untrusted content into the filesystem. */
function createDurableRateLimitStore(
  durableStateDir: string,
  retentionMs: number,
): DurableRateLimitStore {
  if (typeof durableStateDir !== "string" || durableStateDir.trim() === "") {
    throw new TypeError("OperatorHostOptions: durableStateDir must be a non-empty path");
  }
  if (durableStateDir.includes("\u0000")) {
    throw new TypeError("OperatorHostOptions: durableStateDir must not contain a null byte");
  }
  try {
    mkdirSync(durableStateDir, { recursive: true, mode: 0o700 });
    probeWritable(durableStateDir);
  } catch (err) {
    throw new Error(
      `OperatorHostOptions: durable state location is not usable (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  return new DurableRateLimitStore({
    filePath: join(durableStateDir, OPERATOR_RATE_LIMIT_LEDGER_FILENAME),
    retentionMs,
  });
}

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
  /** The operator's DURABLE STATE LOCATION: the directory the operator keeps
   * its durable state in (the daemon's queue snapshot lives there too). The
   * host constructs the Q&A budget's durable ledger INSIDE it and injects
   * that store into the follow-up consumer, so the shipped operator path
   * always enforces a cross-RESTART budget (#1295) — it cannot be composed
   * without a durable budget. */
  readonly durableStateDir: string;
  /** The operator follow-up host configuration; the router builds the
   * follow-up consumer from it. UNCONDITIONAL — this construction is the
   * production binding.
   *
   * It carries NO budget backend: this host owns the Q&A budget (the durable
   * store it constructs from `durableStateDir`), so the operator lane cannot
   * be composed with a per-process budget. */
  readonly followUp: Omit<FollowUpConsumerOptions, "rateLimitStore" | "rateLimitLedgerPath">;
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
  /** The durable Q&A-budget store this host constructed — the operator's
   * window into WHY a question was refused: `degradedReason` (a refusal:
   * unreadable or corrupt state, a latched commit failure), `durabilityAdvisory`
   * (a committed charge whose directory fsync failed) and `identityAdvisory`
   * (a consume without a request identity). The webhook handler answers with
   * fixed bodies and never echoes them, so without this handle a budget
   * refusal would be indistinguishable from an exhausted budget. */
  readonly rateLimitStore: DurableRateLimitStore;
}

/** Create the operator-mode ingress host. See the module header for the
 * single-router invariant, the error posture, and the trust boundary. */
export function createOperatorHost(options: OperatorHostOptions): OperatorHost {
  if (options.followUp === undefined) {
    throw new TypeError("OperatorHostOptions: followUp is required");
  }
  // The Q&A budget's backend is the HOST's to own (#1295): a configuration
  // that carries its own store (or ledger path) would let the operator lane
  // be composed with a per-process budget, and two of them would silently
  // disagree about the same spend. Refused at construction, before any
  // request is served.
  const followUp = options.followUp as FollowUpConsumerOptions;
  if (followUp.rateLimitStore !== undefined || followUp.rateLimitLedgerPath !== undefined) {
    throw new TypeError(
      "OperatorHostOptions: the Q&A budget backend belongs to the operator host (durableStateDir); followUp must not carry rateLimitStore or rateLimitLedgerPath",
    );
  }
  // The durable backend is constructed HERE, from the operator's durable
  // state location — the production wiring of the cross-restart budget.
  const rateLimitStore = createDurableRateLimitStore(
    options.durableStateDir,
    effectiveRetentionMs(followUp.rateLimit),
  );
  // Constructed ONCE, here, UNCONDITIONALLY: this construction is the
  // in-repo production caller of the router (and through it of the
  // follow-up consumer) — the binding whose absence the router's header
  // names and this module exists to make real.
  const router = createOperatorEventRouter({
    followUp: { ...followUp, rateLimitStore },
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
  return {
    router,
    handler: createForgejoWebhookHandler(handlerOptions),
    rateLimitStore,
  };
}
