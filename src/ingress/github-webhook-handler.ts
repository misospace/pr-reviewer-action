// GitHub App webhook ingress for self-hosted Operator mode (#729).
//
// TRUST BOUNDARY (the whole of it):
// - The `X-Hub-Signature-256` HMAC-SHA256 is verified over the RAW body —
//   BEFORE any JSON.parse. Unauthenticated bytes never reach the parser,
//   and the verification fails CLOSED (`verifyGitHubWebhookSignature`
//   refuses an empty secret, a duplicate header, a missing `sha256=`
//   prefix, and a non-lowercase-hex digest).
// - The `X-GitHub-Event` header is an UNAUTHENTICATED HINT: the HMAC covers
//   the BODY ONLY, so the header is not authenticated. It may only select
//   the event VOCABULARY, and the SIGNED BODY must support that vocabulary
//   (a `pull_request` header needs a `pull_request` object in the signed
//   body, an `issue_comment` header needs a `comment` object, and so on) —
//   a vocabulary the signed body cannot support is REFUSED. Within the
//   vocabulary, the signed `action` and the signed payload shape stay
//   authoritative: the normalizer's `mapKind` admits only the
//   vocabulary/action pairs the signed body authorizes, and its own gates
//   (a PR-scoped kind needs a resolvable PR; a check/status kind needs its
//   shape) drop the rest.
// - KNOWN LIMIT (stated, not hidden): GitHub signs the body only, so a
//   captured signed delivery can be REPLAYED under a different header — the
//   vocabulary may be re-aimed within the action map. The blast radius is
//   bounded: the durable generation ledger dedupes the replayed generation
//   (one review per head+config), the exact-head publication gate still
//   refuses a stale head, and the review is of the PR head the signed body
//   carries.
// - Every response body is FIXED and short. The payload, the secret, the
//   signature header, and any error text are NEVER echoed back to the
//   caller.
//
// This handler mirrors `webhook-handler.ts` (the Forgejo intake) response
// for response: the same statuses, the same fixed bodies, the same
// body-size cap (the ONE `DEFAULT_MAX_WEBHOOK_BODY_BYTES` constant is
// imported, never redefined), and the same routing seam — a canonical
// `follow_up` delivery goes to the injected `router` INSTEAD of `onEvent`,
// and every other delivery goes to `onEvent`.
//
// GitHub delivers the event NAME only in the `X-GitHub-Event` header (the
// body carries no `name`/`event` field), while the FROZEN #728 normalizer
// (`normalizeGitHubEvent`) reads the name from `raw.name || raw.event`.
// `projectGitHubWebhookPayload` bridges that gap: it sets `name` from the
// header ONLY when the signed payload carries no `name`/`event` string of
// its own, never rewrites the signed `action`, and never mutates its input
// (it always returns a copy).
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeGitHubEvent } from "../events/normalize.js";
import type { CanonicalForgeEvent } from "../events/types.js";
import { verifyGitHubWebhookSignature } from "./github-app-signature.js";
import type { OperatorEventRouter } from "./operator-router.js";
import { DEFAULT_MAX_WEBHOOK_BODY_BYTES } from "./webhook-handler.js";

const EVENT_HEADER = /^[A-Za-z0-9._-]{1,64}$/;

/** The SIGNED-BODY shape each event vocabulary requires. The header is
 * unauthenticated, so it may only select a vocabulary the signed body
 * itself supports. A vocabulary without a shape anchor here (the
 * installation/visibility families) never mints a review generation, so
 * its shape is not load-bearing. */
const VOCABULARY_ANCHORS: Readonly<Record<string, string>> = {
  pull_request: "pull_request",
  issue_comment: "comment",
  check_run: "check_run",
  check_suite: "check_suite",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** True when the SIGNED body carries the shape the named vocabulary
 * requires, and can therefore authorize it. A vocabulary without a shape
 * anchor is accepted as it is: none of those kinds mints a review
 * generation. */
export function githubBodySupportsVocabulary(
  eventHeader: string,
  payload: Record<string, unknown>,
): boolean {
  const anchor = VOCABULARY_ANCHORS[eventHeader];
  if (anchor === undefined) return true;
  return isPlainObject(payload[anchor]);
}

export interface GitHubWebhookHandlerOptions {
  /** The webhook secret; the signature is verified over the raw body before
   * anything else (the handler's fail-closed boundary). */
  readonly secret: string;
  /** Maximum accepted body bytes; the handler's
   * `DEFAULT_MAX_WEBHOOK_BODY_BYTES` applies when omitted. */
  readonly maxBodyBytes?: number | undefined;
  /** The re-review trigger label; the normalizer's default applies when
   * omitted. */
  readonly rereviewLabel?: string | undefined;
  readonly onEvent: (event: CanonicalForgeEvent) => void | Promise<void>;
  /** The operator-mode event router. When present, a canonical `follow_up`
   * delivery is handed to it (and never to `onEvent`); everything else is
   * unchanged. Absent → the handler behaves exactly as it did before. */
  readonly router?: OperatorEventRouter | undefined;
}

function send(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(body);
}

/** Project a signed GitHub delivery onto the envelope the #728 normalizer
 * accepts: the event NAME lives in the unauthenticated `X-GitHub-Event`
 * header, so the projection copies it onto `name` — but ONLY when the
 * signed payload carries no `name`/`event` string of its own.
 *
 * The signed `action` is NEVER rewritten, and the input is NEVER mutated (a
 * copy is returned). The projection is pure and never throws: a hostile
 * accessor degrades to the header-only name, which the normalizer maps to
 * `unknown`.
 *
 * @param eventHeader the (UNAUTHENTICATED, shape-validated) value of the
 *   `X-GitHub-Event` header — the event VOCABULARY hint.
 * @param payload the parsed (untrusted, but signature-verified) webhook
 *   body. Its own `action` is authoritative — it is inside the HMAC, the
 *   header is not.
 */
export function projectGitHubWebhookPayload(
  eventHeader: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  try {
    // The name the normalizer would read on its own: `raw.name || raw.event`.
    // A signed body that already states its vocabulary keeps it — the header
    // never overrides an authenticated statement.
    const ownName =
      typeof payload.name === "string" && payload.name !== ""
        ? payload.name
        : typeof payload.event === "string" && payload.event !== ""
          ? payload.event
          : "";
    if (ownName !== "") return { ...payload };
    return { ...payload, name: eventHeader };
  } catch {
    // Fail closed, mirroring the normalizer's own try/catch: a throwing
    // accessor degrades to the header-only name (which the normalizer maps
    // to `unknown`), never to a scheduleable kind.
    return { name: eventHeader };
  }
}

/**
 * A Node http request handler for GitHub App webhook deliveries.
 *
 * Security invariants (mirroring the #674/#670/#682 boundary discipline):
 * - the signature is verified over the raw bytes before the payload is
 *   parsed, so unauthenticated bytes never reach the JSON parser;
 * - every rejection is a fixed status + fixed body — the payload, the
 *   secret, the signature header, and any error text are never reflected;
 * - oversize bodies are refused mid-stream and buffering stops immediately;
 * - the `X-GitHub-Event` header is an UNAUTHENTICATED HINT — the HMAC
 *   covers the body only, so shape validation is not authentication. It
 *   selects the event VOCABULARY and nothing more: the signed `action` and
 *   the signed payload shape stay authoritative, so a forged header can
 *   only degrade a delivery to `unknown`, never schedule one.
 */
export function createGitHubWebhookHandler(
  options: GitHubWebhookHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    let settled = false;
    const settle = (status: number, body: string): void => {
      if (settled) return;
      settled = true;
      send(res, status, body);
    };

    void handle().catch(() => settle(500, '{"status":"internal error"}'));

    async function handle(): Promise<void> {
      if (req.method !== "POST") {
        settle(405, '{"status":"method not allowed"}');
        return;
      }

      const eventHeader = req.headers["x-github-event"];
      if (typeof eventHeader !== "string" || !EVENT_HEADER.test(eventHeader)) {
        settle(400, '{"status":"invalid event header"}');
        return;
      }

      const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_WEBHOOK_BODY_BYTES;
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      let tooLarge = false;
      const bodyBuffer = await new Promise<Buffer | null>((resolve, reject) => {
        req.on("data", (chunk: Buffer | string) => {
          if (tooLarge) return;
          const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += piece.length;
          if (receivedBytes > maxBodyBytes) {
            tooLarge = true;
            chunks.length = 0;
            resolve(null);
            return;
          }
          chunks.push(piece);
        });
        req.on("error", () => reject(new Error("unreadable body")));
        req.on("end", () => {
          if (!tooLarge) resolve(Buffer.concat(chunks));
        });
      });
      if (bodyBuffer === null) {
        settle(413, '{"status":"body too large"}');
        // Drop the inbound stream so the client cannot keep pushing bytes
        // into a request we already refused.
        if (!req.destroyed) req.destroy();
        return;
      }

      // Unauthenticated bytes never reach the JSON parser.
      if (
        !verifyGitHubWebhookSignature(
          options.secret,
          req.headers["x-hub-signature-256"],
          bodyBuffer,
        )
      ) {
        settle(401, '{"status":"invalid signature"}');
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyBuffer.toString("utf8"));
      } catch {
        settle(400, '{"status":"invalid json"}');
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        settle(400, '{"status":"invalid payload"}');
        return;
      }

    if (eventHeader === "ping") {
      settle(200, '{"status":"ignored"}');
      return;
    }
    // The header may only select a vocabulary the SIGNED body supports: a
    // header that claims a PR (or comment) vocabulary the body does not
    // carry is refused, so a captured delivery replayed under a forged
    // header cannot be re-aimed at a vocabulary its body never carried.
    if (!githubBodySupportsVocabulary(eventHeader, parsed as Record<string, unknown>)) {
      settle(200, '{"status":"ignored"}');
      return;
    }

      // The header supplies the event NAME (GitHub's body carries none); the
      // signed `action` and the signed payload shape stay authoritative, so
      // the projection can only refine a projection the signed body already
      // authorizes — never rewrite one. The projection never mutates the
      // parsed body (it returns a copy).
      const normalizeOptions =
        options.rereviewLabel === undefined ? {} : { rereviewLabel: options.rereviewLabel };
      const payload = projectGitHubWebhookPayload(
        eventHeader,
        parsed as Record<string, unknown>,
      );
      const event = normalizeGitHubEvent(payload, "webhook", normalizeOptions);
      if (event === null) {
        // Ack so the forge stops redelivering a permanently unroutable
        // delivery.
        settle(200, '{"status":"ignored"}');
        return;
      }

      try {
        const router = options.router;
        if (event.kind === "follow_up" && router !== undefined) {
          // The operator lane CONSUMES the canonical follow-up event here:
          // the router drives the shared follow-up consumer, so the delivery
          // is planned and answered instead of only being forwarded. The
          // follow-up branch settles its EFFECTS inside the consumer; a
          // store contract violation out of the planner still degrades to
          // the same fixed 500 as a throwing `onEvent` — the response
          // contract is identical, and the forge redelivers.
          await router.handleEvent(event);
        } else {
          await options.onEvent(event);
        }
      } catch {
        // Keep the error local — no logging of the event.
        settle(500, '{"status":"internal error"}');
        return;
      }
      settle(202, `{"status":"accepted","kind":"${event.kind}"}`);
    }
  };
}
