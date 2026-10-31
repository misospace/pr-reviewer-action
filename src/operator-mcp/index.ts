/** Operator read-only MCP surface (#1349) — public surface. */
export type {
  ControllerMcpDeps,
  McpAuditEvent,
  McpAuthorizeInput,
  McpFindingView,
  McpMetrics,
  McpPlatform,
  McpPolicyView,
  McpReviewView,
} from "./types.js";
export {
  DEFAULT_MCP_BODY_BYTES,
  DEFAULT_MCP_FINDINGS_LIMIT,
  MAX_MCP_FINDINGS_PER_PAGE,
  MAX_MCP_FINDINGS_PER_REVIEW,
  MAX_MCP_LIST_JOBS_SCANNED,
  MAX_MCP_MESSAGE_CHARS,
  MAX_MCP_RESPONSE_BYTES,
  validateMcpCategory,
  validateMcpCursor,
  validateMcpJobId,
  validateMcpLimit,
  validateMcpPath,
  validateMcpPlatform,
  validateMcpRepository,
  validateMcpRunId,
  validateMcpSeverity,
} from "./types.js";
export { parsePayloadProjection, type PayloadFinding, type PayloadProjection } from "./projection.js";
export { errorResponse, JsonRpcErrorCode, MCP_PROTOCOL_VERSION, parseJsonRpcRequest, resultResponse, sanitizeProtocolVersion, type JsonRpcRequest, type ParsedRequest } from "./jsonrpc.js";
export { callMcpTool, MCP_TOOLS, validateToolArguments, type McpToolContext, type McpToolDescriptor, type RebuiltToolArguments, type ToolCallOutcome } from "./tools.js";
export type { McpDispatchContext, McpDispatchInput, McpHost, McpHttpResponse, McpMountOptions } from "./server.js";
export { createMcpHost, dispatchMcpRequest, McpAuthenticator } from "./server.js";
export { buildStoreBackedMcpDeps, type StoreBackedMcpInput } from "./store-deps.js";
