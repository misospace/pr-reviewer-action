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
import { readBoundedBody } from "./http-body.js";
import { AdminMetricsRegistry, type AdminMetricsOptions } from "./metrics.js";
import { dispatchAdminRoute } from "./routes.js";
import type { ControllerAdminDeps } from "./types.js";
import { createMcpHost, type McpHost, type McpMountOptions } from "../operator-mcp/server.js";

export const DEFAULT_ADMIN_BODY_BYTES = 8 * 1024;
/** Mount options for the #1349 read-only operator MCP surface on the admin
 * listener. When present, `POST /mcp` is served by the MCP host with its OWN
 * scoped capability token; when absent the `/mcp` path answers the fixed 404
 * like any unknown path — the surface is not part of that deployment, never
 * open. */
export interface AdminMcpOptions extends McpMountOptions {}
export interface AdminHostOptions extends AdminMetricsOptions {
  readonly deps: ControllerAdminDeps;
  readonly token?: string;
  readonly maxBodyBytes?: number;
  readonly nowMs?: () => number;
  readonly requestId?: () => string;
  readonly mcp?: AdminMcpOptions;
}
export interface AdminHost { readonly handler: (request: IncomingMessage, response: ServerResponse) => void; readonly registry: AdminMetricsRegistry; readonly authenticator: AdminAuthenticator; readonly mcp: McpHost | null }
const BODY_TOO_LARGE = '{"error":"body too large"}';
const INTERNAL_ERROR = '{"error":"request failed"}';
const NOT_FOUND = '{"error":"not found"}';

function send(response: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}
function readBody(request: IncomingMessage, cap: number): Promise<{ readonly body: Buffer | null; readonly tooLarge: boolean }> {
  return readBoundedBody(request, cap);
}

export function createAdminHost(options: AdminHostOptions): AdminHost {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_ADMIN_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new RangeError("invalid admin body cap");
  const authenticator = new AdminAuthenticator(options.token);
  const registry = new AdminMetricsRegistry(options);
  const nowMs = options.nowMs ?? Date.now;
  // A broken clock must never break the request path: an unusable value
  // falls back to wall-clock time instead of propagating.
  const safeNowMs = (): number => {
    let value: number;
    try { value = nowMs(); } catch { return Date.now(); }
    if (!Number.isFinite(value) || value < 0) return Date.now();
    const truncated = Math.trunc(value);
    return Number.isSafeInteger(truncated) ? truncated : Date.now();
  };
  const requestId = options.requestId ?? randomUUID;
  // The MCP surface mounts on the SAME listener but under its own
  // authenticated namespace with its OWN scoped capability token: the admin
  // authenticator never sees `/mcp` requests and the MCP authenticator never
  // sees `/admin/*` requests. Token separation is structural, not a check.
  const mcpMetrics = {
    request: (outcome: "ok" | "denied" | "invalid" | "error" | "too_large") => registry.recordMcpRequest(outcome),
    authFailure: () => registry.recordMcpAuthFailure(),
    auditFailure: () => registry.bumpAuditFailure(),
  };
  const mcp = options.mcp === undefined ? null : createMcpHost({ ...options.mcp, metrics: mcpMetrics, nowMs: safeNowMs, requestId });
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const method = request.method ?? "";
      const host = request.headers.host ?? "localhost";
      let url: URL;
      try { url = new URL(request.url ?? "/", `http://${host}`); } catch { send(response, 404, NOT_FOUND); return; }
      if (!(method === "GET" || method === "POST")) { send(response, 404, NOT_FOUND); return; }
      if (mcp !== null && url.pathname === "/mcp") {
        mcp.handler(request, response);
        return;
      }
      let body: unknown;
      if (method === "POST") {
        const raw = await readBody(request, maxBodyBytes);
        if (raw.tooLarge || raw.body === null) { send(response, 413, BODY_TOO_LARGE); return; }
        if (raw.body.length > 0) {
          try { body = JSON.parse(raw.body.toString("utf8")) as unknown; } catch { send(response, 400, { error: "invalid request" }); return; }
        }
      }
      const responseData = await dispatchAdminRoute({ deps: options.deps, auth: authenticator, metrics: registry, nowMs: safeNowMs }, {
        method,
        pathname: url.pathname,
        search: url.search,
        ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
        ...(request.headers["content-type"] === undefined ? {} : { contentType: request.headers["content-type"] }),
        ...(body === undefined ? {} : { body }),
        requestId: `${requestId()}-${safeNowMs().toString(36)}`,
      });
      send(response, responseData.status, responseData.body, responseData.contentType);
    })().catch(() => {
      if (!response.headersSent) send(response, 500, INTERNAL_ERROR);
      else response.destroy();
    });
  };
  return Object.freeze({ handler, registry, authenticator, mcp });
}
