/** Operator read-only MCP surface contracts (#1349).
 *
 * This module is a pure boundary, like the #737 admin layer before it: the
 * daemon supplies all state and every authorization decision through
 * `ControllerMcpDeps`; HTTP-facing values are validated here before they
 * cross that seam. Identifiers are bounded, trimmed, and control-char-free.
 * No request field is trusted merely because it arrived authenticated with
 * the scoped capability token.
 *
 * v1 is READ-ONLY by construction: the tool table carries no mutation, and
 * nothing in this module can enqueue, cancel, rereview, or reconfigure. A
 * write tool can only enter through a future contract change, never through
 * a caller's request.
 */
import type { ControlPlanePlatform } from "../state/types.js";

export type McpPlatform = ControlPlanePlatform;

/** One projected finding: the bounded, redacted view a coding agent may
 * see. `line` is 0 when the payload named no anchor. `status` is `open` in
 * v1 — the #1027 outcome/usefulness state (resolved/dismissed/adjudicated)
 * is preserved by the durable contract but is not yet persisted in operator
 * mode, so the surface refuses to guess it. */
export interface McpFindingView {
  readonly runId: string;
  readonly jobId: string;
  readonly platform: McpPlatform;
  readonly repository: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly path: string;
  readonly line: number;
  readonly severity: string;
  readonly category: string;
  readonly message: string;
  readonly status: "open";
}

/** One projected review: controller-domain identity plus the bounded
 * projection of the durable review payload. `pr` is the queue-joined forge
 * identity and is `null` when no queue record proves it — never guessed
 * from ids. */
export interface McpReviewView {
  readonly runId: string;
  readonly jobId: string;
  readonly kind: string;
  readonly state: string;
  readonly executorIdentity: string;
  readonly attempt: number;
  readonly headSha: string;
  readonly configFingerprint: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly pr: { readonly platform: McpPlatform; readonly repository: string; readonly prNumber: number } | null;
  readonly verdict: string;
  readonly reviewResult: string;
  readonly requiredChecks: readonly string[];
  readonly findings: readonly { readonly path: string; readonly line: number; readonly severity: string; readonly category: string; readonly message: string }[];
  readonly findingCount: number;
  readonly publication: { readonly state: string; readonly destination: string; readonly publicationId: string; readonly attempt: number; readonly lastError: string } | null;
}

/** One projected review-policy view: the effective reviewer-config identity
 * the controller recorded, with the PROVENANCE of its trusted source. The
 * reference is opaque (never config material, never a repository file), so
 * the surface answers "what applied and where it came from" without
 * exposing arbitrary repository content. */
export interface McpPolicyView {
  readonly platform: McpPlatform;
  readonly repository: string;
  readonly configFingerprint: string;
  readonly adoptionEpoch: string;
  readonly enabled: boolean;
  readonly adoptedAtMs: number;
  readonly updatedAtMs: number;
  /** Opaque reference to the operator-side trusted source of the policy. */
  readonly configRef: string;
  readonly provenance: "control-plane adoption record";
}

/** Authorization is checked PER REPOSITORY on EVERY call that names one.
 * The seam denies by throwing or by returning a refusal; the dispatcher
 * converts any throw into a fixed denial — never the exception text. The
 * seam must fail closed: an uncertain state denies. */
export interface McpAuthorizeInput {
  readonly platform: McpPlatform;
  readonly repository: string;
}

/** Only DENIED authorization is audited (bounded: no token material, no
 * request content, no argument echo). Authentication failures are counted,
 * not audited, so a flooding client cannot drive unbounded audit writes. */
export interface McpAuditEvent {
  readonly atMs: number;
  readonly requestId: string;
  readonly target: { readonly kind: "repository"; readonly id: string };
  readonly outcome: "refused";
}

/** Bounded-cardinality metrics seam; the admin registry adapts to this. */
export interface McpMetrics {
  request(outcome: "ok" | "denied" | "invalid" | "error" | "too_large"): void;
  authFailure(): void;
  auditFailure(): void;
}

export interface ControllerMcpDeps {
  authorize(input: McpAuthorizeInput): Promise<void> | void;
  /** Identity-addressed reads (getReview by run/job id, getReviewPolicy by
   * run id) carry no repository argument, so THE SEAM owns their
   * authorization: it must refuse (null) any record whose repository the
   * scoped capability may not read, and must never derive permission from
   * the identifier itself. The dispatcher cannot check what it cannot name. */
  getReview(input: { readonly runId?: string; readonly jobId?: string }): Promise<McpReviewView | null>;
  listFindings(input: {
    readonly platform: McpPlatform;
    readonly repository: string;
    readonly severity?: string;
    readonly category?: string;
    readonly path?: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{ readonly findings: readonly McpFindingView[]; readonly nextCursor?: string }>;
  getReviewPolicy(input: { readonly platform?: McpPlatform; readonly repository?: string; readonly runId?: string }): Promise<McpPolicyView | null>;
  audit?(event: McpAuditEvent): Promise<void> | void;
}

/** Bounded field caps. The response-byte ceiling lives in server.ts. */
export const MAX_MCP_MESSAGE_CHARS = 500;
export const MAX_MCP_FINDINGS_PER_REVIEW = 200;
export const MAX_MCP_FINDINGS_PER_PAGE = 100;
export const DEFAULT_MCP_FINDINGS_LIMIT = 25;
export const MAX_MCP_LIST_JOBS_SCANNED = 500;
export const DEFAULT_MCP_BODY_BYTES = 64 * 1024;
export const MAX_MCP_RESPONSE_BYTES = 256 * 1024;

const CONTROL = /[\u0000-\u001f\u007f]/;
function bounded(value: unknown, max: number, pattern: RegExp): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value !== value.trim() || CONTROL.test(value) || !pattern.test(value)) return null;
  return value;
}

export function validateMcpRunId(value: unknown): string | null {
  return bounded(value, 256, /^[A-Za-z0-9._:-]+$/);
}
export function validateMcpJobId(value: unknown): string | null {
  return bounded(value, 256, /^[A-Za-z0-9._:-]+$/);
}
/** `owner/name` form; `.` and `..` segments are refused so a repository
 * filter can never be a traversal shape. */
export function validateMcpRepository(value: unknown): string | null {
  const text = bounded(value, 256, /^[A-Za-z0-9._/-]+$/);
  if (text === null) return null;
  for (const segment of text.split("/")) {
    if (segment === "." || segment === "..") return null;
  }
  return text;
}
export function validateMcpSeverity(value: unknown): string | null {
  return bounded(value, 64, /^[A-Za-z0-9._-]+$/);
}
export function validateMcpCategory(value: unknown): string | null {
  return bounded(value, 64, /^[A-Za-z0-9._-]+$/);
}
/** A filter value matched against finding paths — never a file read. */
export function validateMcpPath(value: unknown): string | null {
  const text = bounded(value, 512, /^[^\\]+$/);
  if (text === null) return null;
  for (const segment of text.split("/")) {
    if (segment === "..") return null;
  }
  return text;
}
export function validateMcpLimit(value: unknown): number | null {
  if (typeof value === "string" && value !== "") value = Number(value);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_MCP_FINDINGS_PER_PAGE) return null;
  return value;
}
export function validateMcpCursor(value: unknown): string | null {
  return bounded(value, 512, /^[A-Za-z0-9_-]+$/);
}
export function validateMcpPlatform(value: unknown): McpPlatform | null {
  return value === "github" || value === "forgejo" ? value : null;
}
