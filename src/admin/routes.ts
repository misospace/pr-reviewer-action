/** Pure admin route table and dispatcher (#737).
 *
 * The dispatcher owns route policy and response shaping, not sockets. Public
 * health/readiness/metrics routes are deliberately separated from the
 * bearer-protected `/admin/` namespace. Effect results are audited only
 * after settlement; audit failures are isolated and counted.
 */
import type { AdminAuthenticator } from "./auth.js";
import type { AdminMetricsRegistry } from "./metrics.js";
import { csrfMatches, type AdminSessionPrincipal } from "./oidc.js";
import { SECRET_KEY_ALTERNATION } from "../context/redact.js";
import { redactSecretShapes } from "../context/secret-shape.js";
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
  readonly session?: AdminSessionPrincipal;
  readonly csrfToken?: string | string[];
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
/** The dispatcher's route table (#737). The optional #742 dashboard shell
 * serves `GET /dashboard` and `GET /dashboard/app.js` OUTSIDE this table and
 * outside the `/admin/` namespace, so the every-route-here-is-authenticated
 * rule stays intact (see `src/admin/dashboard.ts`). */
export const ADMIN_ROUTE_TABLE = Object.freeze([
  "GET /healthz", "GET /readyz", "GET /metrics", "GET /admin/status", "GET /admin/runs", "GET /admin/runs/{runId}", "POST /admin/runs/{runId}/cancel", "POST /admin/rereview", "GET /admin/diagnostics",
]);
const JSON = "application/json; charset=utf-8";
const fixed = (status: number, body: unknown): AdminRouteResponse => ({ status, body, contentType: JSON });
const denied = (status: number): AdminRouteResponse => fixed(status, { error: status === 503 ? "admin unavailable" : "unauthorized" });

/** Diagnostics KEYS that are dropped wholesale. The vocabulary is the
 * canonical `SECRET_KEY_ALTERNATION` (src/context/redact.ts, #1170) plus
 * admin-only names the canonical list does not carry (`passwd`, `pwd`,
 * `credential`, `auth`), applied unanchored and case-insensitive — `token`
 * alone already covers `access_token`/`refresh_token`/`auth_token` spellings,
 * so a canonical credential key (`access_key`, `client_key`) never reaches
 * the response as a key, whatever its value shape. The diagnostics route
 * drops credential-shaped KEYS, but a free-form string (readiness `detail`)
 * carries no key structure — the shared `redactSecretShapes` assignment rule
 * is what protects it. */
const SENSITIVE_DIAGNOSTIC_KEY = new RegExp(`(?:${SECRET_KEY_ALTERNATION}|passwd|pwd|credential|auth)`, "i");
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
/** The refusal reason a seam supplied (#1772): free text that reaches the
 * operator, so it is bounded like every other seam string. The INPUT is
 * capped before any pattern runs, and the RESULT is capped after the
 * redaction (a redaction marker can be longer than the text it replaces). */
const MAX_REFUSAL_INPUT = 1024;
const MAX_REFUSAL_REASON = 200;
/** The phrase a blank or unusable refusal falls back to: the operator always
 * gets a reason, never an empty "why". */
const REFUSAL_FALLBACK = "the request was refused";
/** The audited operator reason's cap: the request's own bound
 * (`validateReason`), re-applied after the redaction can lengthen it. */
const MAX_AUDIT_REASON = 256;

/** The refusal reason as the operator may read it (#1772).
 *
 * The reason is seam-supplied free text: it may carry a credential shape, a
 * control/format/bidi character, or megabytes of noise. ONE bounded
 * projection owns that, so the admin layer never echoes an unbounded or
 * credential-shaped string: the input is capped BEFORE any pattern runs, the
 * unsafe characters are replaced (never rendered), the whitespace collapses,
 * the secret shapes are redacted, and the result is capped. A blank reason
 * falls back to a fixed phrase. */
function boundedRefusalReason(reason: unknown): string {
  if (typeof reason !== "string") return REFUSAL_FALLBACK;
  const cleaned = reason
    .slice(0, MAX_REFUSAL_INPUT)
    .replace(UNSAFE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return REFUSAL_FALLBACK;
  const redacted = redactSecretShapes(cleaned).replace(/\s+/g, " ").trim();
  if (redacted === "") return REFUSAL_FALLBACK;
  return redacted.slice(0, MAX_REFUSAL_REASON);
}
/** The unauthenticated surface echoes PLAIN IDENTIFIERS only, and only up to
 * the documented 64-character limit: a longer name is REFUSED outright, not
 * truncated into a different name the seam never declared. */
const PUBLIC_NAME = new RegExp(`^[A-Za-z0-9._-]{1,${MAX_COMPONENT_NAME}}$`);

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
  // The bound is re-applied after redaction as cheap future-proofing: the
  // identifier gate already forbids every assignment/userinfo shape and the
  // credential shapes are longer than their `[REDACTED]` replacement, so
  // here redaction can only shrink — but a future pattern must never be
  // able to return an over-long public name.
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
/** The operator's stated reason as the audit sink may record it (#1772).
 *
 * The reason is operator free text on its way to a DURABLE ledger, so it
 * passes the same redaction every other outbound string passes: a
 * credential shape must never be written down. It passes the same character
 * sanitation too: `validateReason` rejects only C0 controls and CR/LF, so a
 * C1 control, a bidi override, or a zero-width character would otherwise be
 * persisted verbatim — invisible to a human reader, present to anything that
 * renders or re-emits the ledger. The bounds are the request's own
 * (`validateReason`: trimmed, one line, at most 256 characters); the
 * redaction can lengthen the text, so the result is capped at the same
 * bound. */
function auditedReason(reason: string): string {
  const cleaned = reason.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  return redactSecretShapes(cleaned).slice(0, MAX_AUDIT_REASON);
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
  const bearer = context.auth.authenticate(request.authorization);
  if (!bearer && request.session === undefined) return denied(401);
  if (!bearer && method === "POST" && (request.session === undefined || !csrfMatches(request.session.csrfToken, request.csrfToken))) return fixed(403, { error: "forbidden" });

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
    // Every invalid shape NAMES the offending field and why (#1772): the
    // operator learns what to fix without reading the source.
    if (typeof body !== "object" || body === null || Array.isArray(body)) return fixed(400, { error: "invalid request", detail: "the request body must be a JSON object" });
    const record = body as Record<string, unknown>;
    const prKey = validatePrKey(record["prKey"]);
    if (prKey === null) return fixed(400, { error: "invalid request", detail: "the PR key must be a trimmed identifier of letters, digits, and . _ / @ # : -" });
    const reason = validateReason(record["reason"]);
    if (reason === null) return fixed(400, { error: "invalid request", detail: "the reason must be a trimmed, non-empty single line" });
    // The operator's WHY rides the audit row: a rereview the trail cannot
    // explain is a mutation nobody can justify later.
    const stated = auditedReason(reason);
    try {
      const result = await context.deps.forceRereview({ prKey, reason, requestId: request.requestId });
      if ("refused" in result) {
        await audit(context, { action: "rereview", requestId: request.requestId, target: { kind: "pr", id: prKey }, outcome: "refused", reason: stated });
        // The seam's refusal reason reaches the operator, bounded and
        // redacted: a refusal without a reason is a dead button.
        return fixed(409, { error: "request refused", detail: boundedRefusalReason(result.refused) });
      }
      await audit(context, { action: "rereview", requestId: request.requestId, target: { kind: "pr", id: prKey }, outcome: "accepted", reason: stated });
      return fixed(202, { jobId: result.jobId });
    } catch {
      await audit(context, { action: "rereview", requestId: request.requestId, target: { kind: "pr", id: prKey }, outcome: "error", reason: stated });
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
      let cancelled: { cancelled: true };
      try {
        const before = await context.deps.getRun(runId);
        // Admin-layer refusals settle too: the operator attempted a mutation
        // against a known target, so the audit trail records the attempt.
        if (before === null) {
          await audit(context, { action: "cancel", requestId: request.requestId, target: { kind: "run", id: runId }, outcome: "refused" });
          return fixed(404, { error: "run not found", detail: "no run with that id" });
        }
        if (["completed", "failed", "cancelled", "superseded"].includes(before.state)) {
          await audit(context, { action: "cancel", requestId: request.requestId, target: { kind: "run", id: runId }, outcome: "refused" });
          return fixed(409, { error: "run is terminal", detail: "the run already settled" });
        }
        const result = await context.deps.cancelRun({ runId, requestId: request.requestId });
        if ("undetermined" in result) {
          // The publication is already in flight: the forge side effect
          // may already have landed and it cannot be undone, so the
          // terminal state belongs to the publication — not to the
          // operator's click. The cancellation IS registered, but this
          // is NOT the applied-cancellation contract (#1772): the route
          // answers "accepted, undetermined" instead of the 200
          // `cancelled: true` that promises an operator-cancelled run.
          await audit(context, { action: "cancel", requestId: request.requestId, target: { kind: "run", id: runId }, outcome: "accepted" });
          return fixed(202, { status: "cancellation-registered", cancelled: false, detail: boundedRefusalReason(result.undetermined) });
        }
        if ("refused" in result) {
          await audit(context, { action: "cancel", requestId: request.requestId, target: { kind: "run", id: runId }, outcome: "refused" });
          // The seam's refusal reason reaches the operator, bounded and
          // redacted: the operator learns WHY the cancellation did not happen.
          return fixed(409, { error: "cancellation refused", detail: boundedRefusalReason(result.refused) });
        }
        await audit(context, { action: "cancel", requestId: request.requestId, target: { kind: "run", id: runId }, outcome: "accepted" });
        cancelled = result;
      } catch {
        await audit(context, { action: "cancel", requestId: request.requestId, target: { kind: "run", id: runId }, outcome: "error" });
        return fixed(500, { error: "request failed" });
      }
      // Outside the try: a metrics failure must not produce a second audit
      // record for a mutation that already settled.
      context.metrics.recordCancellation();
      // The cancellation is APPLIED when the route answers (#1772): the
      // effect seam stamped the generation and aborted its attempt, so the
      // operator gets an acknowledgement, not an acceptance promise. The
      // durable run settles `cancelled` when the attempt observes the
      // abort. This 200 is the ONLY answer that promises an
      // operator-cancelled run: every settle path behind it ends
      // `cancelled-by-operator`. The publication-in-flight case answers
      // 202 above, because its terminal state is the publication's
      // outcome and not the operator's click.
      return fixed(200, cancelled);
    }
  }
  return fixed(404, { error: "not found" });
}
