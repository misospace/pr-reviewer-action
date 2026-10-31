/** JSON-RPC framing for the operator MCP endpoint (#1349). */
import test from "node:test";
import assert from "node:assert/strict";
import { errorResponse, JsonRpcErrorCode, MCP_PROTOCOL_VERSION, parseJsonRpcRequest, resultResponse, sanitizeProtocolVersion } from "../src/operator-mcp/jsonrpc.js";

test("valid requests parse with id, method, params, and notification flag", () => {
  const parsed = parseJsonRpcRequest(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }));
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.equal(parsed.request.id, 7);
    assert.equal(parsed.request.method, "tools/list");
    assert.equal(parsed.request.isNotification, false);
  }
  const withParams = parseJsonRpcRequest(JSON.stringify({ jsonrpc: "2.0", id: "abc", method: "tools/call", params: { name: "get_review", arguments: { run_id: "r-1" } } }));
  assert.ok(withParams.ok);
  if (withParams.ok) {
    assert.equal(withParams.request.id, "abc");
    assert.deepEqual(withParams.request.params, { name: "get_review", arguments: { run_id: "r-1" } });
  }
  const notification = parseJsonRpcRequest(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.ok(notification.ok);
  if (notification.ok) assert.equal(notification.request.isNotification, true);
});

test("malformed JSON is a parse error; wrong shapes are invalid requests", () => {
  assert.deepEqual(parseJsonRpcRequest("not json"), { ok: false, code: JsonRpcErrorCode.parseError });
  assert.deepEqual(parseJsonRpcRequest(""), { ok: false, code: JsonRpcErrorCode.parseError });
  assert.deepEqual(parseJsonRpcRequest("[1,2,3]"), { ok: false, code: JsonRpcErrorCode.invalidRequest });
  assert.deepEqual(parseJsonRpcRequest("null"), { ok: false, code: JsonRpcErrorCode.invalidRequest });
  assert.deepEqual(parseJsonRpcRequest(JSON.stringify({ id: 1, method: "tools/list" })), { ok: false, code: JsonRpcErrorCode.invalidRequest });
  assert.deepEqual(parseJsonRpcRequest(JSON.stringify({ jsonrpc: "1.0", id: 1, method: "tools/list" })), { ok: false, code: JsonRpcErrorCode.invalidRequest });
  assert.deepEqual(parseJsonRpcRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "" })), { ok: false, code: JsonRpcErrorCode.invalidRequest });
});

test("ids echo only as string or number; hostile ids become null", () => {
  const stringId = parseJsonRpcRequest(JSON.stringify({ jsonrpc: "2.0", id: "x".repeat(300), method: "ping" }));
  assert.ok(stringId.ok);
  if (stringId.ok) assert.equal(stringId.request.id, "x".repeat(300));
  const objectId = parseJsonRpcRequest('{"jsonrpc":"2.0","id":{"deep":{"nested":1}},"method":"ping"}');
  assert.ok(objectId.ok);
  if (objectId.ok) assert.equal(objectId.request.id, null);
  assert.deepEqual(resultResponse({ toString: () => "hostile" } as unknown as string, {}), { jsonrpc: "2.0", id: null, result: {} });
});

test("response builders produce fixed shapes", () => {
  assert.deepEqual(resultResponse(1, { a: true }), { jsonrpc: "2.0", id: 1, result: { a: true } });
  assert.deepEqual(errorResponse(null, -32700, "invalid request"), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid request" } });
});

test("protocol version is echoed only when plausible", () => {
  assert.equal(sanitizeProtocolVersion("2025-06-18"), "2025-06-18");
  assert.equal(sanitizeProtocolVersion(MCP_PROTOCOL_VERSION), MCP_PROTOCOL_VERSION);
  assert.equal(sanitizeProtocolVersion("__proto__"), MCP_PROTOCOL_VERSION);
  assert.equal(sanitizeProtocolVersion("a".repeat(300)), MCP_PROTOCOL_VERSION);
  assert.equal(sanitizeProtocolVersion("2024\n11-05"), MCP_PROTOCOL_VERSION);
  assert.equal(sanitizeProtocolVersion(2024), MCP_PROTOCOL_VERSION);
  assert.equal(sanitizeProtocolVersion(undefined), MCP_PROTOCOL_VERSION);
  assert.equal(sanitizeProtocolVersion(""), MCP_PROTOCOL_VERSION);
});

test("protocol version accepts exactly the documented separator set and nothing else", () => {
  for (const accepted of ["2024-11-05+rev_1", "v1.2.3-rc.1_2", "a", "a+b", "a_b", "a-b", "a.b"]) {
    assert.equal(sanitizeProtocolVersion(accepted), accepted);
  }
  for (const refused of ["-2024", ".2024", "+2024", "_2024", "2024/11-05", "2024:11", "2024 11", "2024*", "2024%00", "2024\u0000", "é", "2024\u200b"]) {
    assert.equal(sanitizeProtocolVersion(refused), MCP_PROTOCOL_VERSION);
  }
});
