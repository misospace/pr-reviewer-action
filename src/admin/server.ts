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
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AdminAuthenticator } from "./auth.js";
import { AdminSessionStore, OidcAdminProvider, attestedEmail, buildCookie, parseCookie, authorizeClaims, csrfMatches, type AdminAuthConfig } from "./oidc.js";
import { readBoundedBody } from "./http-body.js";
import { serveDashboard, type AdminDashboardOptions, type DashboardResponse } from "./dashboard.js";
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
  readonly auth?: AdminAuthConfig;
  readonly maxBodyBytes?: number;
  readonly nowMs?: () => number;
  readonly requestId?: () => string;
  readonly mcp?: AdminMcpOptions;
  /** Optional #742 static dashboard shell on the SAME listener. When
   * present, `GET /dashboard` and `GET /dashboard/app.js` are served from
   * compile-time constants; when absent the `/dashboard` paths answer the
   * fixed 404 like any unknown path — the surface is not part of that
   * deployment, never open. The paths stay OUTSIDE the `/admin/`
   * namespace, so the every-admin-route-is-authenticated rule is untouched,
   * and the shell itself carries zero dynamic data: every data route stays
   * bearer-protected. */
  readonly dashboard?: AdminDashboardOptions;
  readonly oidcFetch?: typeof fetch;
}
export interface AdminHost { readonly handler: (request: IncomingMessage, response: ServerResponse) => void; readonly registry: AdminMetricsRegistry; readonly authenticator: AdminAuthenticator; readonly mcp: McpHost | null }
const BODY_TOO_LARGE = '{"error":"body too large"}';
const INTERNAL_ERROR = '{"error":"request failed"}';
const NOT_FOUND = '{"error":"not found"}';

function send(response: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  // Authenticated JSON responses (admin API and /auth/*) must never be stored
  // by an intervening cache: a cookie-authenticated body is not covered by
  // the Authorization-header rule that keeps shared caches honest.
  response.setHeader("cache-control", "no-store");
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}
function readBody(request: IncomingMessage, cap: number): Promise<{ readonly body: Buffer | null; readonly tooLarge: boolean }> {
  return readBoundedBody(request, cap);
}

export function createAdminHost(options: AdminHostOptions): AdminHost {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_ADMIN_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new RangeError("invalid admin body cap");
  const oidcConfig = options.auth?.mode === "oidc" ? options.auth.config : null;
  const authenticator = new AdminAuthenticator(options.token, oidcConfig !== null);
  const sessions = oidcConfig === null ? null : new AdminSessionStore();
  const oidc = oidcConfig === null ? null : new OidcAdminProvider(oidcConfig, options.oidcFetch ?? fetch);
  const secureCookies = oidcConfig?.redirectBase.startsWith("https://") ?? false;
  const callbackUrl = oidcConfig === null ? "" : `${oidcConfig.redirectBase}/auth/callback`;
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
      if (url.pathname.startsWith("/auth/")) {
        if (url.pathname === "/auth/config" && method === "GET") { send(response, 200, { mode: oidcConfig === null ? "token" : "oidc" }); return; }
        if (oidcConfig === null || oidc === null || sessions === null) { send(response, 404, NOT_FOUND); return; }
        const sessionId = parseCookie(request.headers.cookie, "pr_reviewer_admin_session");
        if (url.pathname === "/auth/session" && method === "GET") {
          const session = sessions.validate(sessionId);
          if (!session) { send(response, 401, { authenticated: false }); return; }
          send(response, 200, { authenticated: true, subject: session.subject, email: session.email, csrfToken: session.csrfToken }); return;
        }
        if (url.pathname === "/auth/logout" && method === "POST") {
          const session = sessions.validate(sessionId);
          if (!session) { send(response, 401, { error: "unauthorized" }); return; }
          if (!csrfMatches(session.csrfToken, request.headers["x-csrf-token"])) { send(response, 403, { error: "forbidden" }); return; }
          sessions.destroy(sessionId); response.statusCode = 204;
          // Cookie-bearing responses bypass send(): no-store must be set here
          // too, or an intermediary cache may store and replay them.
          response.setHeader("cache-control", "no-store");
          response.setHeader("set-cookie", [buildCookie("pr_reviewer_admin_session", "", secureCookies, 0), buildCookie("pr_reviewer_oidc_tx", "", secureCookies, 0)]); response.end(); return;
        }
        if (url.pathname === "/auth/login" && method === "GET") {
          const created = sessions.createTransaction();
          if (!created) {
            // Pending-transaction cap full (login flood): send the browser
            // back to the dashboard's sign-in state instead of a bare 503 —
            // /auth/login is a top-level browser navigation.
            response.statusCode = 302; response.setHeader("location", "/dashboard?login=failed"); response.setHeader("cache-control", "no-store"); response.end(); return;
          }
          try {
            response.statusCode = 302; response.setHeader("location", await oidc.authorizationUrl(created.transaction, callbackUrl));
            response.setHeader("cache-control", "no-store");
            response.setHeader("set-cookie", buildCookie("pr_reviewer_oidc_tx", created.id, secureCookies, 600)); response.end(); return;
          } catch { send(response, 503, { error: "authentication unavailable" }); return; }
        }
        if (url.pathname === "/auth/callback" && method === "GET") {
          const txId = parseCookie(request.headers.cookie, "pr_reviewer_oidc_tx");
          const tx = sessions.takeTransaction(txId);
          try {
            const code = url.searchParams.get("code"); const state = url.searchParams.get("state");
            if (!tx || !code || code.length > 4096 || !state || state.length !== tx.state.length || !timingSafeEqual(Buffer.from(state), Buffer.from(tx.state))) throw new Error("invalid login transaction");
            const claims = await oidc.exchange(code, tx, callbackUrl);
            if (!authorizeClaims(claims, oidcConfig)) throw new Error("OIDC identity is not allowed");
            if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 512) throw new Error("invalid subject");
            // The session identity must never display a bare `email` claim:
            // only a provider-attested `email_verified: true` earns it (#1785).
            // When a subject- or group-authorized token carries an unverified
            // email, the session stays subject-keyed and the dashboard falls
            // back to the subject.
            const id = sessions.create({ subject: claims.sub, email: attestedEmail(claims), groups: Array.isArray(claims.groups) ? claims.groups.filter((x): x is string => typeof x === "string").slice(0, 128) : [] }, oidcConfig.sessionTtlMs);
            response.statusCode = 302; response.setHeader("location", "/dashboard");
            response.setHeader("cache-control", "no-store");
            response.setHeader("set-cookie", [buildCookie("pr_reviewer_admin_session", id, secureCookies, Math.floor(oidcConfig.sessionTtlMs / 1000)), buildCookie("pr_reviewer_oidc_tx", "", secureCookies, 0)]); response.end(); return;
          } catch {
            response.statusCode = 302; response.setHeader("location", "/dashboard?login=failed"); response.setHeader("cache-control", "no-store"); response.setHeader("set-cookie", buildCookie("pr_reviewer_oidc_tx", "", secureCookies, 0)); response.end(); return;
          }
        }
        send(response, 404, NOT_FOUND); return;
      }
      if (mcp !== null && url.pathname === "/mcp") {
        mcp.handler(request, response);
        return;
      }
      // The optional #742 dashboard shell mounts on the SAME listener,
      // OUTSIDE the `/admin/` namespace: it serves compile-time constants
      // only (zero dynamic data, no request echo) and every data route the
      // shell fetches stays bearer-protected under `/admin/*`. When not
      // configured, `/dashboard` falls through to the fixed 404 like any
      // unknown path — the surface is not part of that deployment, never
      // open.
      if (options.dashboard !== undefined && method === "GET") {
        const dashboard: DashboardResponse | null = serveDashboard(url.pathname);
        if (dashboard !== null) {
          response.statusCode = dashboard.status;
          for (const [name, value] of Object.entries(dashboard.headers)) response.setHeader(name, value);
          response.setHeader("content-type", dashboard.contentType);
          response.end(dashboard.body);
          return;
        }
      }
      let body: unknown;
      if (method === "POST") {
        const raw = await readBody(request, maxBodyBytes);
        if (raw.tooLarge || raw.body === null) { send(response, 413, BODY_TOO_LARGE); return; }
        if (raw.body.length > 0) {
          try { body = JSON.parse(raw.body.toString("utf8")) as unknown; } catch { send(response, 400, { error: "invalid request" }); return; }
        }
      }
      const session = sessions?.validate(parseCookie(request.headers.cookie, "pr_reviewer_admin_session")) ?? undefined;
      const responseData = await dispatchAdminRoute({ deps: options.deps, auth: authenticator, metrics: registry, nowMs: safeNowMs }, {
        method,
        pathname: url.pathname,
        search: url.search,
        ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
        ...(session === undefined ? {} : { session }),
        ...(request.headers["x-csrf-token"] === undefined ? {} : { csrfToken: request.headers["x-csrf-token"] }),
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
