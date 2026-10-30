/** Pure admin route table and dispatcher (#737).
 *
 * The dispatcher owns route policy and response shaping, not sockets. Public
 * health/readiness/metrics routes are deliberately separated from the
 * bearer-protected `/admin/` namespace. Effect results are audited only
 * after settlement; audit failures are isolated and counted.
 */
import type { AdminAuthenticator } from "./auth.js";
import type { AdminMetricsRegistry } from "./metrics.js";
import { SECRET_KEY_ALTERNATION } from "../context/redact.js";
import {
  validatePrKey,
  validateReason,
  validateRunId,
  validateRunListQuery,
  type AdminAuditEvent,
  type AdminReadinessComponent,
  type ControllerAdminDeps,
  type PublicReadinessComponent,
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
export interface AdminRouteContext {
  readonly deps: ControllerAdminDeps;
  readonly auth: AdminAuthenticator;
  readonly metrics: AdminMetricsRegistry;
  /** Clock used to stamp audit events; defaults to `Date.now`. */
  readonly nowMs?: () => number;
}
export const ADMIN_ROUTE_TABLE = Object.freeze([
  "GET /healthz", "GET /readyz", "GET /metrics", "GET /admin/status", "GET /admin/runs", "GET /admin/runs/{runId}", "POST /admin/runs/{runId}/cancel", "POST /admin/rereview", "GET /admin/diagnostics",
]);
const JSON = "application/json; charset=utf-8";
const fixed = (status: number, body: unknown): AdminRouteResponse => ({ status, body, contentType: JSON });
const denied = (status: number): AdminRouteResponse => fixed(status, { error: status === 503 ? "admin unavailable" : "unauthorized" });

/** Credential SHAPES. The leading guard allows a separator (`_`, `-`, `.`,
 * quotes) before the token but not a letter or digit, so `prefix_sk-…` is
 * caught while an ordinary word that merely contains `sk-` is not. */
const SECRET_SHAPE = /(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|Bearer\s+\S+|Basic\s+[A-Za-z0-9+/=]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
/** `key=value` / `key: value` credential assignments. The key vocabulary is
 * DERIVED from the canonical `SECRET_KEY_ALTERNATION` (src/context/redact.ts,
 * #1170) — the single source of truth behind every key-name rule in the
 * repository — plus admin-only names the canonical list does not carry
 * (`passwd`, `pwd`, `credential`, `authorization`; `access_token` /
 * `refresh_token` are already covered by the canonical `token` alternative).
 * A second hand-copied vocabulary is exactly the drift class #1170 closed:
 * canonical names (`access_key`, `client_key`) must redact here too. The
 * diagnostics route drops credential-shaped KEYS, but a free-form string
 * (readiness `detail`) carries no key structure — the assignment rule is
 * what protects it. The value may be quoted: JSON-shaped exception and DSN
 * blobs quote theirs. */
const CREDENTIAL_ASSIGNMENT = new RegExp(
  `((?:${SECRET_KEY_ALTERNATION}|passwd|pwd|credential|authorization)["']?\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^"'\\s,;}]+)`,
  "gi",
);
/** Diagnostics KEYS that are dropped wholesale. Same derived vocabulary as
 * `CREDENTIAL_ASSIGNMENT` (unanchored, case-insensitive — `token` alone
 * already covers `access_token`/`refresh_token`/`auth_token` spellings),
 * so a canonical credential key (`access_key`, `client_key`) never reaches
 * the response as a key, whatever its value shape. */
const SENSITIVE_DIAGNOSTIC_KEY = new RegExp(`(?:${SECRET_KEY_ALTERNATION}|passwd|pwd|credential|auth)`, "i");
/** URL userinfo: `scheme://user:pass@host`. The credential part may contain
 * `/` (base64) and the host may contain `@`, so the match runs to the LAST
 * `@` of the token. The scheme repetition is bounded so the pattern cannot
 * go quadratic on a long run of lowercase characters. */
const USERINFO_URL = /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s]+@/gi;
/** Control, format, line, and paragraph characters — ANSI escapes, bidi
 * overrides, zero-width joiners. Replaced, never rendered. */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const MAX_COMPONENT_NAME = 64;
const MAX_COMPONENT_DETAIL = 512;
const MAX_READINESS_COMPONENTS = 64;
/** Inputs are bounded BEFORE any pattern runs, so a hostile seam cannot make
 * the redactor work on an unbounded string. */
const MAX_NAME_INPUT = 256;
const MAX_DETAIL_INPUT = 1024;
/** The unauthenticated surface echoes PLAIN IDENTIFIERS only. */
const PUBLIC_NAME = /^[A-Za-z0-9._-]{1,256}$/;

/** Replace credential-shaped substrings, credential assignments, and URL
 * userinfo. Pattern-based defense in depth, not a secret oracle. */
function redactSecretShapes(value: string): string {
  return value.replace(SECRET_SHAPE, "[REDACTED]").replace(CREDENTIAL_ASSIGNMENT, "$1[REDACTED]").replace(USERINFO_URL, "$1[REDACTED]@");
}

/** Bounded, sanitized component name for the AUTHENTICATED surface. */
function boundedComponentName(name: unknown): string {
  if (typeof name !== "string") return "unknown";
  const cleaned = redactSecretShapes(name.slice(0, MAX_NAME_INPUT).replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim());
  if (cleaned.length === 0) return "unknown";
  return cleaned.slice(0, MAX_COMPONENT_NAME);
}

/** The PUBLIC component name. Structural rule: only a plain identifier is
 * echoed; anything else (a DSN, a URL, free text, a name carrying unsafe
 * characters) is refused outright as `unknown`. The unauthenticated route
 * therefore carries no free-form seam text, whatever the redactor misses. */
function publicComponentName(name: unknown): string {
  if (typeof name !== "string") return "unknown";
  const cleaned = name.slice(0, MAX_NAME_INPUT).replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  if (!PUBLIC_NAME.test(cleaned)) return "unknown";
  const redacted = redactSecretShapes(cleaned);
  if (redacted.length === 0) return "unknown";
  return redacted.slice(0, MAX_COMPONENT_NAME);
}

/** `ok` fails closed: only a real `true` is healthy, so an absent or
 * malformed value never reports readiness. */
function componentOk(component: ReadinessComponent): boolean {
  return component.ok === true;
}
/** `degraded` fails closed on a malformed flag, but treats an ABSENT flag
 * as absent: a JSON-sourced seam yields `null` for an unset boolean, and a
 * healthy component must not be pulled out of rotation by its own silence. */
function componentDegraded(component: ReadinessComponent): boolean {
  const raw = component.degraded as boolean | null | undefined;
  return raw == null ? false : raw !== false;
}

/** The public `/readyz` projection: synthetic fields only, never `detail`. */
function publicReadinessComponent(component: ReadinessComponent): PublicReadinessComponent {
  return { name: publicComponentName(component.name), ok: componentOk(component), degraded: componentDegraded(component) };
}

/** The authenticated `/admin/status` projection: synthetic fields plus a
 * bounded, secret-redacted `detail` so the operator keeps the "why". */
function adminReadinessComponent(component: ReadinessComponent): AdminReadinessComponent {
  const base = { name: boundedComponentName(component.name), ok: componentOk(component), degraded: componentDegraded(component) };
  if (typeof component.detail !== "string") return base;
  const detail = redactSecretShapes(component.detail.slice(0, MAX_DETAIL_INPUT).replace(UNSAFE_CHARS, " ")).trim().slice(0, MAX_COMPONENT_DETAIL);
  return detail.length === 0 ? base : { ...base, detail };
}

/** Project a readiness set for exposure. Readiness is decided over EVERY
 * component the seam reports; only the exposed list is capped, and failing
 * components are listed FIRST so the cap cannot hide the component that
 * made the endpoint answer `503`. */
function projectReadiness(components: readonly ReadinessComponent[], limit: number): { readonly ready: boolean; readonly components: readonly PublicReadinessComponent[] } {
  const failing: PublicReadinessComponent[] = [];
  const healthy: PublicReadinessComponent[] = [];
  let ready = true;
  for (const component of components) {
    const failingComponent = !componentOk(component) || componentDegraded(component);
    if (failingComponent) {
      ready = false;
      if (failing.length < limit) failing.push(publicReadinessComponent(component));
    } else if (healthy.length < limit) healthy.push(publicReadinessComponent(component));
  }
  return { ready, components: [...failing, ...healthy].slice(0, limit) };
}
function projectAdminReadiness(components: readonly ReadinessComponent[], limit: number): readonly AdminReadinessComponent[] {
  const failing: AdminReadinessComponent[] = [];
  const healthy: AdminReadinessComponent[] = [];
  for (const component of components) {
    const failingComponent = !componentOk(component) || componentDegraded(component);
    if (failingComponent) {
      if (failing.length < limit) failing.push(adminReadinessComponent(component));
    } else if (healthy.length < limit) healthy.push(adminReadinessComponent(component));
  }
  return [...failing, ...healthy].slice(0, limit);
}

/** The audit timestamp. A missing, throwing, non-finite, negative, or
 * unsafe clock falls back to wall-clock time rather than recording a lie. */
function auditTimestamp(context: AdminRouteContext): number {
  let raw: number;
  try { raw = context.nowMs?.() ?? Date.now(); } catch { return Date.now(); }
  if (!Number.isFinite(raw) || raw < 0) return Date.now();
  const truncated = Math.trunc(raw);
  return Number.isSafeInteger(truncated) ? truncated : Date.now();
}
async function audit(context: AdminRouteContext, event: Omit<AdminAuditEvent, "atMs">): Promise<void> {
  const settled: AdminAuditEvent = { ...event, atMs: auditTimestamp(context) };
  try { await context.deps.audit(settled); } catch { context.metrics.bumpAuditFailure(); }
}
function redactDiagnostics(values: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  for (const [rawKey, value] of Object.entries(values).slice(0, 128)) {
    const key = rawKey.slice(0, 128);
    if (SENSITIVE_DIAGNOSTIC_KEY.test(key)) continue;
    // Only the contract's flat primitive shapes may pass through; anything
    // else (a misbehaving seam returning nested/array values) is DROPPED
    // rather than rendered unredacted.
    if (typeof value === "string") {
      output[key] = redactSecretShapes(value.slice(0, 2048));
    } else if (typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
    }
  }
  return output;
}

export async function dispatchAdminRoute(context: AdminRouteContext, request: AdminDispatchInput): Promise<AdminRouteResponse> {
  const { method, pathname } = request;
  if (method === "GET" && pathname === "/healthz") return fixed(200, { status: "ok" });
  if (method === "GET" && pathname === "/readyz") {
    const readiness = await context.deps.readiness();
    // Public surface: synthetic fields only. The seam's free-form `detail`
    // never leaves this route — it may carry a DSN or exception text.
    const projected = projectReadiness(readiness.components, MAX_READINESS_COMPONENTS);
    return fixed(projected.ready ? 200 : 503, { status: projected.ready ? "ok" : "not ready", components: projected.components });
  }
  if (method === "GET" && pathname === "/metrics") return { status: 200, body: context.metrics.renderPrometheus(), contentType: "text/plain; version=0.0.4; charset=utf-8" };
  if (!pathname.startsWith("/admin/") && pathname !== "/admin") return fixed(404, { error: "not found" });
  if (!context.auth.configured()) return denied(503);
  if (!context.auth.authenticate(request.authorization)) return denied(401);

  if (method === "GET" && pathname === "/admin/status") {
    const [queue, adoption, readiness] = await Promise.all([context.deps.queueStatus(), context.deps.adoptionStatus(), context.deps.readiness()]);
    context.metrics.deriveQueue(queue);
    return fixed(200, { queue, adoption, readiness: { components: projectAdminReadiness(readiness.components, MAX_READINESS_COMPONENTS) } });
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
    let event: Omit<AdminAuditEvent, "atMs">;
    try {
      const result = await context.deps.forceRereview({ prKey, reason, requestId: request.requestId });
      const refused = "refused" in result;
      event = { action: "rereview", requestId: request.requestId, target: { kind: "pr", id: prKey }, outcome: refused ? "refused" : "accepted" };
      await audit(context, event);
      return refused ? fixed(409, { error: "request refused" }) : fixed(202, { jobId: result.jobId });
    } catch {
      await audit(context, { action: "rereview", requestId: request.requestId, target: { kind: "pr", id: prKey }, outcome: "error" });
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
      let accepted: { cancelled: true } | { refused: string };
      try {
        const before = await context.deps.getRun(runId);
        // Admin-layer refusals settle too: the operator attempted a mutation
        // against a known target, so the audit trail records the attempt.
        if (before === null) {
          await audit(context, { action: "cancel", requestId: request.requestId, target: { kind: "run", id: runId }, outcome: "refused" });
          return fixed(404, { error: "run not found" });
        }
        if (["completed", "failed", "cancelled", "superseded"].includes(before.state)) {
          await audit(context, { action: "cancel", requestId: request.requestId, target: { kind: "run", id: runId }, outcome: "refused" });
          return fixed(409, { error: "run is terminal" });
        }
        const result = await context.deps.cancelRun({ runId, requestId: request.requestId });
        const refused = "refused" in result;
        await audit(context, { action: "cancel", requestId: request.requestId, target: { kind: "run", id: runId }, outcome: refused ? "refused" : "accepted" });
        if (refused) return fixed(409, { error: "cancellation refused" });
        accepted = result;
      } catch {
        await audit(context, { action: "cancel", requestId: request.requestId, target: { kind: "run", id: runId }, outcome: "error" });
        return fixed(500, { error: "request failed" });
      }
      // Outside the try: a metrics failure must not produce a second audit
      // record for a mutation that already settled.
      context.metrics.recordCancellation();
      return fixed(202, accepted);
    }
  }
  return fixed(404, { error: "not found" });
}
