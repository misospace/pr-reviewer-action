/** Controller admin API contracts (#737).
 *
 * This module is a pure boundary: the future daemon supplies all state and
 * effects through `ControllerAdminDeps`; HTTP-facing values are validated
 * here before they cross that seam. Identifiers are bounded, trimmed, and
 * control-character-free. No request field is treated as trusted merely
 * because it came from an authenticated administrator.
 */
import type { JobLifecycleState } from "../queue/types.js";
import type { AggregatedCostProvenance, UsageRole } from "../state/types.js";

export type { JobLifecycleState } from "../queue/types.js";
export type { UsageRole, AggregatedCostProvenance } from "../state/types.js";

export interface AdminRunSummary {
  readonly runId: string;
  readonly jobId: string;
  readonly kind: "review" | "follow_up";
  readonly state: JobLifecycleState;
  readonly executorIdentity: string;
  readonly attempt: number;
  readonly headSha: string;
  readonly failureReason: string;
  readonly supersededByJobId: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
}
export interface AdminUsageAggregate {
  readonly role: UsageRole;
  readonly requestCount: number;
  readonly tokens: number;
  readonly costMicros: number;
  readonly costProvenance: AggregatedCostProvenance;
}
export interface AdminRunDetail extends AdminRunSummary {
  readonly publication: {
    readonly jobId: string;
    readonly state: "pending" | "published" | "failed" | "none";
    readonly attempt: number;
    readonly lastOutcome: string;
  };
  readonly usage: readonly AdminUsageAggregate[];
}
export interface AdminAdoptionEntry {
  readonly platform: "github" | "forgejo";
  readonly repository: string;
  /** The effective reviewer-config fingerprint the adoption last saw; "" when unknown. */
  readonly configFingerprint: string;
  readonly enabled: boolean;
  readonly adoptedAtMs: number;
}
export interface AdminQueueStatus {
  readonly depthByState: Readonly<Record<JobLifecycleState, number>>;
  readonly oldestAgeMs: number;
  readonly activeWorkersByExecutor: Readonly<Record<string, number>>;
}
export interface ReadinessComponent {
  readonly name: string;
  readonly ok: boolean;
  readonly degraded?: boolean;
  readonly detail?: string;
}
/** Readiness as the UNAUTHENTICATED `/readyz` route may expose it.
 *
 * The public surface is synthetic by construction: a bounded component name
 * (a plain identifier, or `unknown` when the seam's name is anything else)
 * and the two booleans. The seam's free-form `detail` string never reaches
 * this projection — a readiness seam may populate it with a DSN, endpoint,
 * or exception text.
 */
export interface PublicReadinessComponent {
  readonly name: string;
  readonly ok: boolean;
  readonly degraded: boolean;
}
/** Readiness as the AUTHENTICATED `/admin/status` route may expose it.
 *
 * Same synthetic fields plus the seam's `detail`, bounded and
 * secret-redacted. The operator keeps the "why" without the admin surface
 * becoming a credential channel.
 */
export interface AdminReadinessComponent extends PublicReadinessComponent {
  readonly detail?: string;
}
/** The identity of the mutation an audit record describes. */
export interface AdminAuditTarget {
  readonly kind: "run" | "pr";
  /** The validated, bounded identifier of the mutated run or PR. */
  readonly id: string;
}
export interface AdminAuditEvent {
  /** Settlement time of the mutation, stamped by the admin layer. */
  readonly atMs: number;
  readonly action: "rereview" | "cancel";
  readonly requestId: string;
  readonly target: AdminAuditTarget;
  readonly outcome: "accepted" | "refused" | "error";
}
export interface ControllerAdminDeps {
  readiness(): Promise<{ readonly components: readonly ReadinessComponent[] }>;
  listRuns(input: { readonly limit: number; readonly cursor?: string }): Promise<{ readonly runs: readonly AdminRunSummary[]; readonly nextCursor?: string }>;
  getRun(runId: string): Promise<AdminRunDetail | null>;
  adoptionStatus(): Promise<{ readonly repositories: readonly AdminAdoptionEntry[] }>;
  queueStatus(): Promise<AdminQueueStatus>;
  diagnostics(): Promise<Record<string, string | number | boolean>>;
  forceRereview(input: { readonly prKey: string; readonly reason: string; readonly requestId: string }): Promise<{ readonly jobId: string } | { readonly refused: string }>;
  cancelRun(input: { readonly runId: string; readonly requestId: string }): Promise<{ readonly cancelled: true } | { readonly refused: string }>;
  audit(event: AdminAuditEvent): Promise<void> | void;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
function bounded(value: unknown, max: number, pattern: RegExp): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value !== value.trim() || CONTROL.test(value) || !pattern.test(value)) return null;
  return value;
}
export function validateRunId(value: unknown): string | null {
  return bounded(value, 128, /^[A-Za-z0-9._:-]+$/);
}
export function validatePrKey(value: unknown): string | null {
  return bounded(value, 512, /^[A-Za-z0-9._/@#:-]+$/);
}
export function validateReason(value: unknown): string | null {
  return bounded(value, 256, /^[^\r\n]+$/);
}
export function validateCursor(value: unknown): string | null {
  return bounded(value, 256, /^[A-Za-z0-9._~-]+$/);
}
export function validateRunListQuery(query: URLSearchParams): { readonly limit: number; readonly cursor?: string } | null {
  const limitRaw = query.get("limit");
  const cursorRaw = query.get("cursor");
  if (query.getAll("limit").length > 1 || query.getAll("cursor").length > 1) return null;
  const limit = limitRaw === null || limitRaw === "" ? 50 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return null;
  if (cursorRaw !== null && cursorRaw !== "") {
    const cursor = validateCursor(cursorRaw);
    if (cursor === null) return null;
    return { limit, cursor };
  }
  return { limit };
}
