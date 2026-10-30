/** Isolated admin HTTP host (#737).
 *
 * Normative listener boundary: webhook routes (`src/ingress/webhook-handler.ts`
 * and `src/ingress/github-webhook-handler.ts`) stay on their OWN public
 * listener. This module serves only health, metrics, and authenticated admin
 * routes; never co-mingle webhook ingress with admin authentication/config.
 *
 * Diagnostics receive an additional local redaction pass in `routes.ts`
 * because this surface is an external output boundary; the shared context
 * text redactor is specialized for PR artifacts and is not sufficient as a
 * diagnostics key/URL sanitizer.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AdminAuthenticator } from "./auth.js";
import { AdminMetricsRegistry, type AdminMetricsOptions } from "./metrics.js";
import { dispatchAdminRoute } from "./routes.js";
import type { ControllerAdminDeps } from "./types.js";

export const DEFAULT_ADMIN_BODY_BYTES = 8 * 1024;
export interface AdminHostOptions extends AdminMetricsOptions {
  readonly deps: ControllerAdminDeps;
  readonly token?: string;
  readonly maxBodyBytes?: number;
  readonly nowMs?: () => number;
  readonly requestId?: () => string;
}
export interface AdminHost { readonly handler: (request: IncomingMessage, response: ServerResponse) => void; readonly registry: AdminMetricsRegistry; readonly authenticator: AdminAuthenticator }
const BODY_TOO_LARGE = '{"error":"body too large"}';
const INTERNAL_ERROR = '{"error":"request failed"}';
const NOT_FOUND = '{"error":"not found"}';

function send(response: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}
function readBody(request: IncomingMessage, cap: number): Promise<{ readonly body: Buffer | null; readonly tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > cap) {
        settled = true;
        chunks.length = 0;
        resolve({ body: null, tooLarge: true });
        request.resume();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => { if (!settled) { settled = true; resolve({ body: Buffer.concat(chunks), tooLarge: false }); } });
    request.on("error", () => { if (!settled) { settled = true; reject(new Error("request body failure")); } });
  });
}

export function createAdminHost(options: AdminHostOptions): AdminHost {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_ADMIN_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new RangeError("invalid admin body cap");
  const authenticator = new AdminAuthenticator(options.token);
  const registry = new AdminMetricsRegistry(options);
  const nowMs = options.nowMs ?? Date.now;
  const requestId = options.requestId ?? randomUUID;
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const method = request.method ?? "";
      const host = request.headers.host ?? "localhost";
      let url: URL;
      try { url = new URL(request.url ?? "/", `http://${host}`); } catch { send(response, 404, NOT_FOUND); return; }
      if (!(method === "GET" || method === "POST")) { send(response, 404, NOT_FOUND); return; }
      let body: unknown;
      if (method === "POST") {
        const raw = await readBody(request, maxBodyBytes);
        if (raw.tooLarge || raw.body === null) { send(response, 413, BODY_TOO_LARGE); return; }
        if (raw.body.length > 0) {
          try { body = JSON.parse(raw.body.toString("utf8")) as unknown; } catch { send(response, 400, { error: "invalid request" }); return; }
        }
      }
      const responseData = await dispatchAdminRoute({ deps: options.deps, auth: authenticator, metrics: registry }, {
        method,
        pathname: url.pathname,
        search: url.search,
        ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
        ...(request.headers["content-type"] === undefined ? {} : { contentType: request.headers["content-type"] }),
        ...(body === undefined ? {} : { body }),
        requestId: `${requestId()}-${Math.max(0, Math.floor(nowMs())).toString(36)}`,
      });
      send(response, responseData.status, responseData.body, responseData.contentType);
    })().catch(() => {
      if (!response.headersSent) send(response, 500, INTERNAL_ERROR);
      else response.destroy();
    });
  };
  return Object.freeze({ handler, registry, authenticator });
}
