/** Minimal JSON-RPC 2.0 framing for the stateless operator MCP endpoint
 * (#1349).
 *
 * The endpoint speaks the MCP streamable-HTTP transport's JSON-RPC dialect
 * over plain POST bodies: one request object per body (batch requests are
 * refused — a bounded v1 surface has no need for them), one response object
 * back. Error messages are FIXED strings that never echo request content.
 */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

export const JsonRpcErrorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  responseTooLarge: -32003,
} as const;

export interface JsonRpcRequest {
  readonly id: string | number | null;
  readonly method: string;
  readonly params: unknown;
  readonly isNotification: boolean;
}

export type ParsedRequest =
  | { readonly ok: true; readonly request: JsonRpcRequest }
  | { readonly ok: false; readonly code: number };

export function parseJsonRpcRequest(text: string): ParsedRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: JsonRpcErrorCode.parseError };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: JsonRpcErrorCode.invalidRequest };
  }
  const record = parsed as Record<string, unknown>;
  if (record["jsonrpc"] !== "2.0" || typeof record["method"] !== "string" || record["method"].length === 0) {
    return { ok: false, code: JsonRpcErrorCode.invalidRequest };
  }
  const idValue = record["id"];
  const id = typeof idValue === "string" || typeof idValue === "number" ? idValue : null;
  return {
    ok: true,
    request: {
      id,
      method: record["method"],
      params: record["params"] ?? undefined,
      isNotification: !("id" in record),
    },
  };
}

/** The `id` is echoed only when it is a string or number; anything else
 * (including a hostile object/array id) responds with null. */
function safeId(id: unknown): string | number | null {
  return typeof id === "string" || typeof id === "number" ? id : null;
}

export function resultResponse(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: safeId(id), result };
}

export function errorResponse(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: safeId(id), error: { code, message } };
}

/** A client-declared protocol version is echoed only when it is a plausible
 * version string; anything else (an over-long string, control characters, a
 * hostile shape) answers with the server's own constant. */
export function sanitizeProtocolVersion(clientVersion: unknown): string {
  if (typeof clientVersion !== "string") return MCP_PROTOCOL_VERSION;
  if (clientVersion.length < 1 || clientVersion.length > 32) return MCP_PROTOCOL_VERSION;
  // Must START with an alphanumeric: a version is a date-like identifier,
  // so separator-led shapes (an all-underscore `__proto__`-lookalike) are
  // refused, never echoed.
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(clientVersion)) return MCP_PROTOCOL_VERSION;
  return clientVersion;
}
