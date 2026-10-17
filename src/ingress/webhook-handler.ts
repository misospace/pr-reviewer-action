// Forgejo webhook ingress for self-hosted Operator mode (#730).
// X-Gitea-Signature is HMAC-SHA256 hex over the RAW body — verified BEFORE any
// JSON.parse; fail closed. Response bodies are fixed and short: payload, secret,
// signature, and error text are never echoed back to the caller. After the
// signature is verified, the delivery is projected (see forgejo-events.ts) from
// native Gitea/Forgejo event vocabulary onto the GitHub-shaped envelope the
// FROZEN #728 normalizer (normalizeForgejoEvent) already accepts; the normalizer
// remains the only consumer of the (projected) body and this seam never
// inspects untrusted content beyond the event-header shape and the canonical
// event's kind.
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeForgejoEvent } from "../events/normalize.js";
import type { CanonicalForgeEvent } from "../events/types.js";
import { projectForgejoWebhookPayload } from "./forgejo-events.js";
import { verifyForgejoWebhookSignature } from "./signature.js";

export const DEFAULT_MAX_WEBHOOK_BODY_BYTES = 1_048_576;

const EVENT_HEADER = /^[A-Za-z0-9._-]{1,64}$/;

export interface ForgejoWebhookHandlerOptions {
  readonly secret: string;
  readonly maxBodyBytes?: number | undefined;
  readonly rereviewLabel?: string | undefined;
  readonly onEvent: (event: CanonicalForgeEvent) => void | Promise<void>;
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
 *   authoritative over any `name`/`event` the payload carries; the delivery is
 *   projected by `projectForgejoWebhookPayload` onto the GitHub-shaped envelope
 *   and `normalizeForgejoEvent` is the only consumer of the (projected) body.
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

      // The specific-type header is trusted like the event header (it is part
      // of the HMAC-verified delivery) but is accepted only if it passes the
      // same shape guard; anything else is treated as absent. Deliberate
      // degradation: a duplicate header (array value) or non-conforming value
      // is treated as ABSENT (the grouped header alone still drives routing)
      // — unlike `X-Gitea-Event`, where a duplicate is rejected 400 — because
      // absence can only narrow, never mis-route.
      const typeHeader = req.headers["x-gitea-event-type"];
      const eventTypeHeader =
        typeof typeHeader === "string" && EVENT_HEADER.test(typeHeader) ? typeHeader : "";

      // X-Gitea-Event (and the type header) are authoritative; a hostile
      // payload name cannot re-route the delivery. The projection maps the
      // native Gitea/Forgejo vocabulary onto the GitHub-shaped envelope the
      // normalizer accepts before it runs and never mutates its input, so
      // the parsed body (guarded above to a non-null, non-array object) is
      // passed through directly.
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
        await options.onEvent(event);
      } catch {
        // Keep the error local — no logging of the event.
        settle(500, '{"status":"internal error"}');
        return;
      }
      settle(202, `{"status":"accepted","kind":"${event.kind}"}`);
    }
  };
}