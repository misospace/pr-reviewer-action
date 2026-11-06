/** Controller admin API library (#737) — public surface. */
export type {
  AdminAdoptionEntry,
  AdminAuditEvent,
  AdminAuditTarget,
  AdminQueueStatus,
  AdminReadinessComponent,
  AdminRunDetail,
  AdminRunSummary,
  AdminUsageAggregate,
  ControllerAdminDeps,
  JobLifecycleState,
  PublicReadinessComponent,
  ReadinessComponent,
  UsageRole,
  AggregatedCostProvenance,
} from "./types.js";
export { validateCursor, validatePrKey, validateReason, validateRunId, validateRunListQuery } from "./types.js";
export { AdminAuthenticator } from "./auth.js";
export type { AdminFailureCategory, AdminMcpOutcome, AdminMetricDefinition, AdminMetricsOptions, AdminPublicationOutcome, AdminToolStopReason, AdminVerdict, AdminWebhookOutcome } from "./metrics.js";
export { AdminMetricsRegistry } from "./metrics.js";
export type { AdminDispatchInput, AdminRouteContext, AdminRouteResponse } from "./routes.js";
export { ADMIN_ROUTE_TABLE, dispatchAdminRoute } from "./routes.js";
export type { AdminHost, AdminHostOptions, AdminMcpOptions } from "./server.js";
export { createAdminHost, DEFAULT_ADMIN_BODY_BYTES } from "./server.js";
export type {
  ControllerMcpDeps,
  McpAuditEvent,
  McpAuthorizeInput,
  McpFindingView,
  McpMetrics,
  McpPlatform,
  McpPolicyView,
  McpReviewView,
} from "../operator-mcp/types.js";
export { createMcpHost, dispatchMcpRequest, McpAuthenticator } from "../operator-mcp/server.js";
export { MCP_TOOLS } from "../operator-mcp/tools.js";
export { buildStoreBackedMcpDeps } from "../operator-mcp/store-deps.js";
