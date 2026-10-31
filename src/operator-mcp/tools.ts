/** The read-only tool table and dispatch for the operator MCP surface
 * (#1349).
 *
 * v1 carries exactly three tools, all read verbs. There is deliberately no
 * mutation tool: no enqueue, cancel, rereview, config write, or anything
 * that could move control-plane state. A write tool can only enter through
 * a future contract change, never through a caller's request.
 *
 * Every tool result is built from the deps seam's own typed views — the
 * dispatcher validates REQUESTS, the seam owns authorization and truth, and
 * error messages are fixed strings that never echo argument content.
 */
import type {
  ControllerMcpDeps,
  McpPlatform,
} from "./types.js";
import {
  DEFAULT_MCP_FINDINGS_LIMIT,
  validateMcpCategory,
  validateMcpCursor,
  validateMcpJobId,
  validateMcpLimit,
  validateMcpPath,
  validateMcpPlatform,
  validateMcpRepository,
  validateMcpRunId,
  validateMcpSeverity,
  type McpAuditEvent,
  type McpMetrics,
} from "./types.js";

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: readonly McpToolDescriptor[] = Object.freeze([
  {
    name: "get_review",
    description:
      "Get one normalized code review by stable run identity (run_id) or job identity (job_id): verdict, findings, lifecycle state, and publication status. Exactly one of run_id/job_id is required.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Controller run id" },
        job_id: { type: "string", description: "Controller job id" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_findings",
    description:
      "List findings for ONE repository across its reviews, with bounded filters (severity, category, path) and keyset pagination. Cross-repository listing is not available: repository access is authorized per call.",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["github", "forgejo"], description: "Forge platform" },
        repository: { type: "string", description: "owner/name repository full name" },
        severity: { type: "string", description: "Exact severity filter (case-insensitive)" },
        category: { type: "string", description: "Exact category filter (case-insensitive)" },
        path: { type: "string", description: "Case-insensitive substring filter on finding paths" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size (default 25)" },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous page" },
      },
      required: ["platform", "repository"],
      additionalProperties: false,
    },
  },
  {
    name: "get_review_policy",
    description:
      "Read the effective review-policy identity and provenance that applied to a repository, or to one review by run_id. Returns config fingerprints and the opaque trusted-source reference — never repository content.",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["github", "forgejo"], description: "Forge platform (with repository)" },
        repository: { type: "string", description: "owner/name repository full name (with platform)" },
        run_id: { type: "string", description: "Controller run id (alternative to platform/repository)" },
      },
      additionalProperties: false,
    },
  },
] as const);

export type ToolCallOutcome =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: "invalid-arguments" | "not-found" | "denied" | "error"; readonly message: string };

const FIXED_MESSAGES = {
  "invalid-arguments": "invalid tool arguments",
  "not-found": "review not found",
  denied: "repository access denied",
  error: "review state unavailable",
} as const;

export interface McpToolContext {
  readonly deps: ControllerMcpDeps;
  readonly metrics?: McpMetrics;
  readonly nowMs?: () => number;
  readonly requestId: string;
}

export interface RebuiltToolArguments {
  readonly runId?: string;
  readonly jobId?: string;
  readonly platform?: McpPlatform;
  readonly repository?: string;
  readonly severity?: string;
  readonly category?: string;
  readonly path?: string;
  readonly limit: number;
  readonly cursor?: string;
}

/** Validate and REBUILD tool arguments. Unknown argument names are dropped;
 * a present-but-invalid value makes the whole argument set invalid (an
 * invalid filter is never silently ignored — a silently ignored filter
 * would widen the result set the caller believes it asked for). `limit`
 * defaults when absent and is rejected when malformed. */
export function validateToolArguments(tool: string, args: unknown): RebuiltToolArguments | null {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  const rebuilt: { runId?: string; jobId?: string; platform?: McpPlatform; repository?: string; severity?: string; category?: string; path?: string; limit: number; cursor?: string } = { limit: DEFAULT_MCP_FINDINGS_LIMIT };
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    switch (key) {
      case "run_id": {
        const validated = validateMcpRunId(value);
        if (validated === null) return null;
        rebuilt.runId = validated;
        break;
      }
      case "job_id": {
        const validated = validateMcpJobId(value);
        if (validated === null) return null;
        rebuilt.jobId = validated;
        break;
      }
      case "platform": {
        const validated = validateMcpPlatform(value);
        if (validated === null) return null;
        rebuilt.platform = validated;
        break;
      }
      case "repository": {
        const validated = validateMcpRepository(value);
        if (validated === null) return null;
        rebuilt.repository = validated;
        break;
      }
      case "severity": {
        const validated = validateMcpSeverity(value);
        if (validated === null) return null;
        rebuilt.severity = validated;
        break;
      }
      case "category": {
        const validated = validateMcpCategory(value);
        if (validated === null) return null;
        rebuilt.category = validated;
        break;
      }
      case "path": {
        const validated = validateMcpPath(value);
        if (validated === null) return null;
        rebuilt.path = validated;
        break;
      }
      case "limit": {
        const validated = validateMcpLimit(value);
        if (validated === null) return null;
        rebuilt.limit = validated;
        break;
      }
      case "cursor": {
        const validated = validateMcpCursor(value);
        if (validated === null) return null;
        rebuilt.cursor = validated;
        break;
      }
      default:
        // Unknown argument names are DROPPED, never forwarded: an unknown
        // field cannot smuggle behavior into a deps seam.
        break;
    }
  }
  // Empty arguments name no review, no repository, and no form: invalid
  // for every v1 tool.
  if (Object.keys(record).length === 0) return null;
  switch (tool) {
    case "get_review":
      if ((rebuilt.runId !== undefined) === (rebuilt.jobId !== undefined)) return null; // exactly one
      break;
    case "list_findings":
      if (rebuilt.platform === undefined || rebuilt.repository === undefined) return null;
      break;
    case "get_review_policy": {
      const hasRepositoryForm = rebuilt.platform !== undefined && rebuilt.repository !== undefined;
      const hasRunForm = rebuilt.runId !== undefined;
      if (hasRepositoryForm === hasRunForm) return null; // exactly one form
      break;
    }
    default:
      return null;
  }
  return rebuilt;
}

/** Deny authorization, audit the denial (never the token material or the
 * argument content), and count it. Audit failure is isolated: the denial
 * outcome is already decided, and a broken audit sink must not turn a
 * refusal into a 500. */
async function deny(context: McpToolContext, repository: string): Promise<ToolCallOutcome> {
  context.metrics?.request("denied");
  const event: McpAuditEvent = {
    atMs: safeTimestamp(context.nowMs),
    requestId: context.requestId,
    target: { kind: "repository", id: repository },
    outcome: "refused",
  };
  try {
    await context.deps.audit?.(event);
  } catch {
    context.metrics?.auditFailure();
  }
  return { ok: false, error: "denied", message: FIXED_MESSAGES.denied };
}

function safeTimestamp(nowMs: (() => number) | undefined): number {
  let value: number;
  try {
    value = nowMs?.() ?? Date.now();
  } catch {
    return Date.now();
  }
  if (!Number.isFinite(value) || value < 0) return Date.now();
  const truncated = Math.trunc(value);
  return Number.isSafeInteger(truncated) ? truncated : Date.now();
}

export async function callMcpTool(context: McpToolContext, tool: string, args: unknown): Promise<ToolCallOutcome> {
  const args2 = validateToolArguments(tool, args);
  if (args2 === null) {
    context.metrics?.request("invalid");
    return { ok: false, error: "invalid-arguments", message: FIXED_MESSAGES["invalid-arguments"] };
  }
  try {
    switch (tool) {
      case "get_review": {
        const review = await context.deps.getReview({
          ...(args2.runId === undefined ? {} : { runId: args2.runId }),
          ...(args2.jobId === undefined ? {} : { jobId: args2.jobId }),
        });
        if (review === null) return { ok: false, error: "not-found", message: FIXED_MESSAGES["not-found"] };
        context.metrics?.request("ok");
        return { ok: true, data: { review } };
      }
      case "list_findings": {
        // Authorization is checked PER REPOSITORY on EVERY call, before any
        // state is read. A thrown authorize is a denial, never an error.
        try {
          await context.deps.authorize({ platform: args2.platform!, repository: args2.repository! });
        } catch {
          return await deny(context, args2.repository!);
        }
        const page = await context.deps.listFindings({
          platform: args2.platform!,
          repository: args2.repository!,
          ...(args2.severity === undefined ? {} : { severity: args2.severity }),
          ...(args2.category === undefined ? {} : { category: args2.category }),
          ...(args2.path === undefined ? {} : { path: args2.path }),
          limit: args2.limit,
          ...(args2.cursor === undefined ? {} : { cursor: args2.cursor }),
        });
        context.metrics?.request("ok");
        return {
          ok: true,
          data: { findings: page.findings, ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }) },
        };
      }
      case "get_review_policy": {
        // The repository form authorizes HERE (same rule as list_findings);
        // the run_id form delegates authorization to the seam — the seam
        // returns null for a run its caller may not read, so a `null` is a
        // not-found, and a thrown authorize on the repository form is a
        // denial.
        if (args2.repository !== undefined && args2.platform !== undefined) {
          try {
            await context.deps.authorize({ platform: args2.platform, repository: args2.repository });
          } catch {
            return await deny(context, args2.repository);
          }
        }
        const policy = await context.deps.getReviewPolicy({
          ...(args2.platform === undefined ? {} : { platform: args2.platform }),
          ...(args2.repository === undefined ? {} : { repository: args2.repository }),
          ...(args2.runId === undefined ? {} : { runId: args2.runId }),
        });
        if (policy === null) return { ok: false, error: "not-found", message: "policy not found" };
        context.metrics?.request("ok");
        return { ok: true, data: { policy } };
      }
      default:
        context.metrics?.request("invalid");
        return { ok: false, error: "invalid-arguments", message: FIXED_MESSAGES["invalid-arguments"] };
    }
  } catch {
    context.metrics?.request("error");
    return { ok: false, error: "error", message: FIXED_MESSAGES.error };
  }
}
