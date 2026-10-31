/** Operator read-only MCP endpoint host (#1349).
 *
 * A stateless streamable-HTTP MCP endpoint speaking JSON-RPC over plain
 * POST bodies, mounted on the controller admin listener under `POST /mcp`
 * with its OWN scoped capability token. The mount is fail closed in BOTH
 * directions: an unconfigured token answers the fixed 404 (the surface is
 * not part of that deployment — never open), and the admin token never
 * authenticates `/mcp` while the MCP token never authenticates `/admin/*`.
 *
 * Like `src/admin/server.ts`, the dispatcher (`dispatchMcpRequest`) is a
 * pure function; the host is only the socket wrapper. Error bodies are
 * fixed JSON that never echo request content, and every response is
 * serialized under a hard byte cap — a partial document is never sent.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBoundedBody } from "../admin/http-body.js";
import { errorResponse, JsonRpcErrorCode, parseJsonRpcRequest, resultResponse, sanitizeProtocolVersion } from "./jsonrpc.js";
import { callMcpTool, MCP_TOOLS } from "./tools.js";
import { DEFAULT_MCP_BODY_BYTES, MAX_MCP_RESPONSE_BYTES, type ControllerMcpDeps, type McpMetrics } from "./types.js";

export interface McpMountOptions {
  readonly deps: ControllerMcpDeps;
  /** The scoped capability token. ABSENT means the surface is not part of
   * this deployment: requests answer the fixed 404, never an open listener.
   * An empty or whitespace-only token is a construction error. */
  readonly token?: string;
  readonly maxBodyBytes?: number;
  readonly maxResponseBytes?: number;
}

export interface McpHost { readonly handler: (request: IncomingMessage, response: ServerResponse) => void }

export interface McpDispatchContext {
  readonly deps: ControllerMcpDeps;
  readonly auth: McpAuthenticator;
  readonly metrics?: McpMetrics;
  readonly maxResponseBytes: number;
  readonly nowMs?: () => number;
  readonly requestId: string;
}

export interface McpDispatchInput {
  readonly method: string;
  readonly authorization?: string | string[];
  readonly contentType?: string;
  readonly body?: unknown;
}

export interface McpHttpResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
}

export class McpAuthenticator {
  private readonly digest: Buffer | null;

  constructor(token: string | undefined) {
    if (token !== undefined && (typeof token !== "string" || token.trim() === "")) {
      throw new TypeError("mcp token must not be empty or whitespace");
    }
    this.digest = token === undefined ? null : createHash("sha256").update(token, "utf8").digest();
  }

  configured(): boolean {
    return this.digest !== null;
  }

  authenticate(header: string | string[] | undefined): boolean {
    if (this.digest === null || typeof header !== "string") return false;
    const match = /^Bearer ([^\s]+)$/i.exec(header);
    if (match === null) return false;
    const candidate = createHash("sha256").update(match[1]!, "utf8").digest();
    return timingSafeEqual(this.digest, candidate);
  }
}

const JSON_TYPE = "application/json; charset=utf-8";
const fixed = (status: number, body: unknown): McpHttpResponse => ({ status, body: JSON.stringify(body), contentType: JSON_TYPE });
const NOT_FOUND = { error: "not found" };
const UNAUTHORIZED = { error: "unauthorized" };
const WRONG_TYPE = { error: "content type required" };
const BODY_TOO_LARGE = { error: "body too large" };

export async function dispatchMcpRequest(context: McpDispatchContext, request: McpDispatchInput): Promise<McpHttpResponse> {
  // Unconfigured surface FIRST, before any method dispatch: the fixed 404
  // an unknown path gets. An MCP host built without a token is UNAVAILABLE,
  // never open — and the refusal is indistinguishable from any other
  // unknown path, so the endpoint's existence is not advertised to an
  // unauthenticated caller.
  if (!context.auth.configured()) return fixed(404, NOT_FOUND);
  const { method } = request;
  if (method !== "POST") return fixed(method === "GET" ? 405 : 404, NOT_FOUND);
  if (!context.auth.authenticate(request.authorization)) {
    context.metrics?.authFailure();
    return fixed(401, UNAUTHORIZED);
  }
  if (request.contentType === undefined || request.contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return fixed(415, WRONG_TYPE);
  }
  const body = request.body;
  if (typeof body !== "string" || body.length === 0) {
    return fixed(200, errorResponse(null, JsonRpcErrorCode.invalidRequest, "invalid request"));
  }
  const parsed = parseJsonRpcRequest(body);
  if (!parsed.ok) {
    return fixed(200, errorResponse(null, parsed.code, "invalid request"));
  }
  const { request: rpc } = parsed;
  if (rpc.isNotification) {
    // Notifications get no JSON-RPC response; `notifications/initialized`
    // (and any unknown notification) is accepted with an empty 202.
    return { status: 202, body: "", contentType: JSON_TYPE };
  }
  switch (rpc.method) {
    case "initialize": {
      const params = typeof rpc.params === "object" && rpc.params !== null ? (rpc.params as Record<string, unknown>) : {};
      return fixed(200, resultResponse(rpc.id, {
        protocolVersion: sanitizeProtocolVersion(params["protocolVersion"]),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "pr-reviewer-operator-mcp", version: "1.0.0" },
      }));
    }
    case "ping":
      return fixed(200, resultResponse(rpc.id, {}));
    case "tools/list":
      return fixed(200, resultResponse(rpc.id, { tools: MCP_TOOLS }));
    case "tools/call": {
      const params = typeof rpc.params === "object" && rpc.params !== null ? (rpc.params as Record<string, unknown>) : {};
      const tool = params["name"];
      const args = params["arguments"] ?? {};
      // An unknown TOOL is a protocol-level refusal (-32602); a known tool
      // with invalid ARGUMENTS stays a tool-level error (isError true), the
      // shape MCP clients render to the model.
      if (typeof tool !== "string" || !MCP_TOOLS.some((entry) => entry.name === tool)) {
        context.metrics?.request("invalid");
        return fixed(200, errorResponse(rpc.id, JsonRpcErrorCode.invalidParams, "unknown tool"));
      }
      const result = await callMcpTool(
        {
          deps: context.deps,
          ...(context.metrics === undefined ? {} : { metrics: context.metrics }),
          ...(context.nowMs === undefined ? {} : { nowMs: context.nowMs }),
          requestId: context.requestId,
        },
        tool,
        args,
      );
      const payload = result.ok
        ? { content: [{ type: "text", text: JSON.stringify(result.data) }], isError: false }
        : { content: [{ type: "text", text: result.message }], isError: true };
      const response = resultResponse(rpc.id, payload);
      // Hard response-byte ceiling: a serialized response beyond the cap is
      // refused as a fixed bounded error — never truncated into a partial
      // document, never silently clipped mid-finding.
      if (JSON.stringify(response).length > context.maxResponseBytes) {
        context.metrics?.request("too_large");
        return fixed(200, errorResponse(rpc.id, JsonRpcErrorCode.responseTooLarge, "response too large"));
      }
      return fixed(200, response);
    }
    default:
      return fixed(200, errorResponse(rpc.id, JsonRpcErrorCode.methodNotFound, "method not found"));
  }
}

export function createMcpHost(options: McpMountOptions & { metrics?: McpMetrics; nowMs?: () => number; requestId?: () => string }): McpHost {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MCP_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new RangeError("invalid mcp body cap");
  const maxResponseBytes = options.maxResponseBytes ?? MAX_MCP_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new RangeError("invalid mcp response cap");
  const authenticator = new McpAuthenticator(options.token);
  const requestId = options.requestId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const method = request.method ?? "";
      let body: string | undefined;
      if (method === "POST") {
        const raw = await readBoundedBody(request, maxBodyBytes);
        if (raw.tooLarge || raw.body === null) {
          response.statusCode = 413;
          response.setHeader("content-type", JSON_TYPE);
          response.end(JSON.stringify(BODY_TOO_LARGE));
          return;
        }
        body = raw.body.toString("utf8");
      }
      const responseData = await dispatchMcpRequest(
        {
          deps: options.deps,
          auth: authenticator,
          ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
          maxResponseBytes,
          ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
          requestId: requestId(),
        },
        {
          method,
          ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
          ...(request.headers["content-type"] === undefined ? {} : { contentType: request.headers["content-type"] }),
          ...(body === undefined ? {} : { body }),
        },
      );
      response.statusCode = responseData.status;
      response.setHeader("content-type", responseData.contentType);
      response.end(responseData.body);
    })().catch(() => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("content-type", JSON_TYPE);
        response.end('{"error":"request failed"}');
      } else {
        response.destroy();
      }
    });
  };
  return Object.freeze({ handler });
}
