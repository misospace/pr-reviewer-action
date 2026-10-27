// Forgejo webhook ingress for self-hosted Operator mode (#730).
// X-Gitea-Signature is HMAC-SHA256 hex over the RAW body — verified BEFORE any
// JSON.parse; fail closed. That HMAC covers the BODY ONLY, so the event headers
// are UNAUTHENTICATED HINTS: they are shape-guarded (not authenticated) and may
// only refine a projection compatible with the signed payload's own action
// (#1024). Response bodies are fixed and short: payload, secret, signature, and
// error text are never echoed back to the caller. After the signature is
// verified, the delivery is projected (see forgejo-events.ts) from native
// Gitea/Forgejo event vocabulary onto the GitHub-shaped envelope the FROZEN
// #728 normalizer (normalizeForgejoEvent) already accepts; the normalizer
// remains the only consumer of the (projected) body and this seam never
// inspects untrusted content beyond the event-header shape and the canonical
// event's kind.
//
// Routing seam: an injected `router` (the operator-mode event router,
// ./operator-router.js) receives a `follow_up` delivery INSTEAD of `onEvent` —
// that is how the operator lane CONSUMES the canonical follow-up event rather
// than merely forwarding it. The router is optional: with none configured the
// handler behaves exactly as before (every delivery, a `follow_up` included,
// goes to `onEvent`), and every non-follow-up delivery ALWAYS goes to
// `onEvent`. A throwing router is handled exactly like a throwing `onEvent` —
// a fixed 500, no error text echoed.
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeForgejoEvent } from "../events/normalize.js";
import type { CanonicalForgeEvent } from "../events/types.js";
import { projectForgejoWebhookPayload } from "./forgejo-events.js";
import { verifyForgejoWebhookSignature } from "./signature.js";
import type { OperatorEventRouter } from "./operator-router.js";

export const DEFAULT_MAX_WEBHOOK_BODY_BYTES = 1_048_576;

const EVENT_HEADER = /^[A-Za-z0-9._-]{1,64}$/;

export interface ForgejoWebhookHandlerOptions {
  readonly secret: string;
  readonly maxBodyBytes?: number | undefined;
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

/**
 * A Node http request handler for Forgejo webhook deliveries.
 *
 * Security invariants (mirroring the #674/#670/#682 boundary discipline):
 * - the signature is verified over the raw bytes before the payload is parsed,
 *   so unauthenticated bytes never reach the JSON parser;
 * - every rejection is a fixed status + fixed body — the payload, the secret,
 *   the signature header, and any error text are never reflected;
 * - oversize bodies are refused mid-stream and buffering stops immediately;
 * - the `X-Gitea-Event` header (and the `X-Gitea-Event-Type` header) are
 *   UNAUTHENTICATED HINTS — the HMAC covers the body only, so shape validation
 *   is not authentication. They decide the projected `name` (which overrides
 *   any `name`/`event` the payload carries), but each is honored only when the
 *   SIGNED payload's own `action` authorizes it; a hint conflicting with that
 *   action degrades fail-closed instead of re-routing the delivery (#1024).
 *   The delivery is projected by `projectForgejoWebhookPayload` onto the
 *   GitHub-shaped envelope and `normalizeForgejoEvent` is the only consumer of
 *   the (projected) body.
 */
export function createForgejoWebhookHandler(
  options: ForgejoWebhookHandlerOptions,
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

      const eventHeader = req.headers["x-gitea-event"];
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
        // Drop the inbound stream so the client cannot keep pushing bytes into
        // a request we already refused.
        if (!req.destroyed) req.destroy();
        return;
      }

      // Unauthenticated bytes never reach the JSON parser.
      if (!verifyForgejoWebhookSignature(options.secret, req.headers["x-gitea-signature"], bodyBuffer)) {
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

      // The specific-type header is a HINT like the event header and is NOT
      // authenticated (the HMAC covers the body only): it is accepted only if
      // it passes the same shape guard, and `forgejo-events.ts` honors it only
      // when the signed payload's action authorizes it. Deliberate degradation:
      // a duplicate header (array value) or non-conforming value is treated as
      // ABSENT (the grouped header alone still drives routing) — unlike
      // `X-Gitea-Event`, where a duplicate is rejected 400 — because absence
      // can only narrow, never mis-route.
      const typeHeader = req.headers["x-gitea-event-type"];
      const eventTypeHeader =
        typeof typeHeader === "string" && EVENT_HEADER.test(typeHeader) ? typeHeader : "";

      // X-Gitea-Event (and the type header) decide the projected name, so a
      // hostile payload name cannot re-route the delivery — but they cannot
      // override the signed action either: the projection gates every hint on
      // it. The projection maps the native Gitea/Forgejo vocabulary onto the
      // GitHub-shaped envelope the normalizer accepts before it runs and never
      // mutates its input, so the parsed body (guarded above to a non-null,
      // non-array object) is passed through directly.
      const normalizeOptions =
        options.rereviewLabel === undefined ? {} : { rereviewLabel: options.rereviewLabel };
      const payload = projectForgejoWebhookPayload(
        eventHeader,
        eventTypeHeader,
        parsed as Record<string, unknown>,
        normalizeOptions,
      );
      const event = normalizeForgejoEvent(payload, "webhook", normalizeOptions);
      if (event === null) {
        // Ack so the forge stops redelivering a permanently unroutable delivery.
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