/** Pure admin route table and dispatcher (#737).
 *
 * The dispatcher owns route policy and response shaping, not sockets. Public
 * health/readiness/metrics routes are deliberately separated from the
 * bearer-protected `/admin/` namespace. Effect results are audited only
 * after settlement; audit failures are isolated and counted.
 */
import type { AdminAuthenticator } from "./auth.js";
import type { AdminMetricsRegistry } from "./metrics.js";
import {
  validatePrKey,
  validateReason,
  validateRunId,
  validateRunListQuery,
  type AdminAuditEvent,
  type ControllerAdminDeps,
  type ReadinessComponent,
} from "./types.js";

export interface AdminRouteResponse { readonly status: number; readonly body: unknown; readonly contentType?: string }
export interface AdminDispatchInput {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly authorization?: string | string[];
  readonly contentType?: string;
  readonly body?: unknown;
  readonly requestId: string;
}
export interface AdminRouteContext { readonly deps: ControllerAdminDeps; readonly auth: AdminAuthenticator; readonly metrics: AdminMetricsRegistry }
export const ADMIN_ROUTE_TABLE = Object.freeze([
  "GET /healthz", "GET /readyz", "GET /metrics", "GET /admin/status", "GET /admin/runs", "GET /admin/runs/{runId}", "POST /admin/runs/{runId}/cancel", "POST /admin/rereview", "GET /admin/diagnostics",
]);
const JSON = "application/json; charset=utf-8";
const fixed = (status: number, body: unknown): AdminRouteResponse => ({ status, body, contentType: JSON });
const denied = (status: number): AdminRouteResponse => fixed(status, { error: status === 503 ? "admin unavailable" : "unauthorized" });

async function audit(context: AdminRouteContext, event: AdminAuditEvent): Promise<void> {
  try { await context.deps.audit(event); } catch { context.metrics.bumpAuditFailure(); }
}
function redactDiagnostics(values: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  const sensitiveKey = /(?:secret|token|password|credential|api[_-]?key|private[_-]?key|auth)/i;
  const secret = /(?:\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|Bearer\s+\S+|AKIA[0-9A-Z]{16})\b)/g;
  const userInfoUrl = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;
  for (const [key, value] of Object.entries(values).slice(0, 128)) {
    if (sensitiveKey.test(key)) continue;
    // Only the contract's flat primitive shapes may pass through; anything
    // else (a misbehaving seam returning nested/array values) is DROPPED
    // rather than rendered unredacted.
    if (typeof value === "string") {
      output[key.slice(0, 128)] = value.slice(0, 2048).replace(secret, "[REDACTED]").replace(userInfoUrl, "$1[REDACTED]@");
    } else if (typeof value === "number" || typeof value === "boolean") {
      output[key.slice(0, 128)] = value;
    }
  }
  return output;
}

export async function dispatchAdminRoute(context: AdminRouteContext, request: AdminDispatchInput): Promise<AdminRouteResponse> {
  const { method, pathname } = request;
  if (method === "GET" && pathname === "/healthz") return fixed(200, { status: "ok" });
  if (method === "GET" && pathname === "/readyz") {
    const readiness = await context.deps.readiness();
    const components: readonly ReadinessComponent[] = readiness.components;
    return fixed(components.every((component) => component.ok && component.degraded !== true) ? 200 : 503, { status: components.every((component) => component.ok && component.degraded !== true) ? "ok" : "not ready", components });
  }
  if (method === "GET" && pathname === "/metrics") return { status: 200, body: context.metrics.renderPrometheus(), contentType: "text/plain; version=0.0.4; charset=utf-8" };
  if (!pathname.startsWith("/admin/") && pathname !== "/admin") return fixed(404, { error: "not found" });
  if (!context.auth.configured()) return denied(503);
  if (!context.auth.authenticate(request.authorization)) return denied(401);

  if (method === "GET" && pathname === "/admin/status") {
    const [queue, adoption] = await Promise.all([context.deps.queueStatus(), context.deps.adoptionStatus()]);
    context.metrics.deriveQueue(queue);
    return fixed(200, { queue, adoption });
  }
  if (method === "GET" && pathname === "/admin/runs") {
    const query = validateRunListQuery(new URLSearchParams(request.search));
    if (query === null) return fixed(400, { error: "invalid query" });
    return fixed(200, await context.deps.listRuns(query));
  }
  if (method === "GET" && pathname === "/admin/diagnostics") return fixed(200, redactDiagnostics(await context.deps.diagnostics()));
  if (method === "POST" && pathname === "/admin/rereview") {
    if (request.contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return fixed(415, { error: "content type required" });
    const body = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return fixed(400, { error: "invalid request" });
    const record = body as Record<string, unknown>;
    const prKey = validatePrKey(record["prKey"]);
    const reason = validateReason(record["reason"]);
    if (prKey === null || reason === null) return fixed(400, { error: "invalid request" });
    let event: AdminAuditEvent;
    try {
      const result = await context.deps.forceRereview({ prKey, reason, requestId: request.requestId });
      const refused = "refused" in result;
      event = { action: "rereview", requestId: request.requestId, target: "pr", outcome: refused ? "refused" : "accepted" };
      await audit(context, event);
      return refused ? fixed(409, { error: "request refused" }) : fixed(202, { jobId: result.jobId });
    } catch {
      await audit(context, { action: "rereview", requestId: request.requestId, target: "pr", outcome: "error" });
      return fixed(500, { error: "request failed" });
    }
  }
  const match = /^\/admin\/runs\/([^/]+)(?:\/(cancel))?$/.exec(pathname);
  if (match !== null) {
    let decoded: string;
    try { decoded = decodeURIComponent(match[1]!); } catch { return fixed(400, { error: "invalid run id" }); }
    const runId = validateRunId(decoded);
    if (runId === null) return fixed(400, { error: "invalid run id" });
    if (method === "GET" && match[2] === undefined) {
      const run = await context.deps.getRun(runId);
      return run === null ? fixed(404, { error: "run not found" }) : fixed(200, run);
    }
    if (method === "POST" && match[2] === "cancel") {
      if (request.contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return fixed(415, { error: "content type required" });
      const before = await context.deps.getRun(runId);
      if (before === null) return fixed(404, { error: "run not found" });
      if (["completed", "failed", "cancelled", "superseded"].includes(before.state)) return fixed(409, { error: "run is terminal" });
      try {
        const result = await context.deps.cancelRun({ runId, requestId: request.requestId });
        const refused = "refused" in result;
        await audit(context, { action: "cancel", requestId: request.requestId, target: "run", outcome: refused ? "refused" : "accepted" });
        if (refused) return fixed(409, { error: "cancellation refused" });
        context.metrics.recordCancellation();
        return fixed(202, result);
      } catch {
        await audit(context, { action: "cancel", requestId: request.requestId, target: "run", outcome: "error" });
        return fixed(500, { error: "request failed" });
      }
    }
  }
  return fixed(404, { error: "not found" });
}
