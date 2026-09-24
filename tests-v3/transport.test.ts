import test from "node:test";
import assert from "node:assert/strict";
import { runHttpRequest, resolveEndpoint, TransportFailure, classifySocketError } from "../src/transport/http.js";
import { runChatRequest } from "../src/transport/transport.js";
import { startMockServer, sseResponse } from "./helpers.js";
import type { TransportWirePayload } from "../src/model/types.js";

function payload(body: Record<string, unknown>): TransportWirePayload {
  return { endpointPath: "/chat/completions", body: body as unknown as TransportWirePayload["body"] };
}

test("endpoint join strips trailing slashes and picks the protocol path", () => {
  assert.equal(resolveEndpoint("http://x:8080/v1", "openai").toString(), "http://x:8080/v1/chat/completions");
  assert.equal(resolveEndpoint("http://x:8080/v1/", "openai").toString(), "http://x:8080/v1/chat/completions");
  assert.equal(resolveEndpoint("http://x:8080", "anthropic").toString(), "http://x:8080/messages");
});

test("openai non-streamed success sends Bearer auth and the wire payload", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.end(JSON.stringify({ id: "1", choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  });
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload: payload({ model: "m", stream: false, messages: [] }),
      apiKey: "sk-test",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 5,
      connectTimeoutSec: 5,
    });
    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;
    assert.equal(outcome.response.content, "hi");
    assert.deepEqual(outcome.response.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]!.headers.authorization, "Bearer sk-test");
    assert.equal(server.requests[0]!.headers["content-type"], "application/json");
    assert.equal(server.requests[0]!.headers["anthropic-version"], undefined);
    assert.equal(JSON.parse(server.requests[0]!.body).model, "m");
  } finally {
    await server.close();
  }
});

test("anthropic sends x-api-key and anthropic-version, never Bearer", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.end(JSON.stringify({ id: "m1", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 4, output_tokens: 1 }, stop_reason: "end_turn" }));
  });
  try {
    const outcome = await runChatRequest({
      baseUrl: `${server.url}/v1/`,
      apiFormat: "anthropic",
      payload: { endpointPath: "/messages", body: { model: "m", stream: false, max_tokens: 8 } as unknown as TransportWirePayload["body"] },
      apiKey: "ak-test",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 5,
      connectTimeoutSec: 5,
    });
    assert.equal(outcome.status, "ok");
    assert.equal(server.requests[0]!.headers["x-api-key"], "ak-test");
    assert.equal(server.requests[0]!.headers["anthropic-version"], "2023-06-01");
    assert.equal(server.requests[0]!.headers.authorization, undefined);
    // Anthropic non-streamed bodies normalize into the shared shape too.
    if (outcome.status === "ok") {
      assert.equal(outcome.response.content, "ok");
      assert.equal(outcome.response.finishReason, "end_turn");
      assert.deepEqual(outcome.response.usage, { promptTokens: 4, completionTokens: 1, totalTokens: 5 });
    }
  } finally {
    await server.close();
  }
});

test("empty api key sends no auth header", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.end("{}");
  });
  try {
    await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload: payload({ model: "m", stream: false }),
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 5,
      connectTimeoutSec: 5,
    });
    assert.equal(server.requests[0]!.headers.authorization, undefined);
  } finally {
    await server.close();
  }
});

test("streamed responses reassemble through the transport", async () => {
  const server = await startMockServer(sseResponse([
    'data: {"choices":[{"delta":{"content":"a"}}]}',
    'data: {"choices":[{"delta":{"content":"b"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2}}',
    "data: [DONE]",
  ]));
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload: payload({ model: "m", stream: true }),
      apiKey: "k",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 5,
      connectTimeoutSec: 5,
    });
    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") assert.equal(outcome.response.content, "ab");
  } finally {
    await server.close();
  }
});

test("HTTP error bodies are preserved on typed failures", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: { message: "context length exceeded" } }));
  });
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload: payload({ model: "m", stream: false }),
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 5,
      connectTimeoutSec: 5,
    });
    assert.equal(outcome.status, "failure");
    if (outcome.status !== "failure") return;
    assert.equal(outcome.failure.kind, "http_status");
    assert.equal(outcome.failure.status, 400);
    assert.equal(outcome.failure.body, '{"error":{"message":"context length exceeded"}}');
    assert.equal(outcome.failure.message, "model endpoint returned HTTP 400");
  } finally {
    await server.close();
  }
});

test("connection refused is a typed network failure", async () => {
  const outcome = await runChatRequest({
    baseUrl: "http://127.0.0.1:1",
    apiFormat: "openai",
    payload: payload({ model: "m", stream: false }),
    apiKey: "",
    anthropicVersion: "2023-06-01",
    requestTimeoutSec: 5,
    connectTimeoutSec: 5,
  });
  assert.equal(outcome.status, "failure");
  if (outcome.status === "failure") assert.equal(outcome.failure.kind, "network");
});

test("a server that never responds trips the request deadline", async () => {
  const server = await startMockServer(() => { /* never respond */ });
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload: payload({ model: "m", stream: false }),
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 0.3,
      connectTimeoutSec: 5,
    });
    assert.equal(outcome.status, "failure");
    if (outcome.status === "failure") assert.equal(outcome.failure.kind, "request_timeout");
  } finally {
    await server.close();
  }
});

test("connect-timeout classification maps socket codes to typed failures", () => {
  assert.equal(classifySocketError(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })).kind, "network");
  assert.equal(classifySocketError(Object.assign(new Error("dns"), { code: "ENOTFOUND" })).kind, "network");
  assert.equal(classifySocketError(new Error("weird")).kind, "network");
  const existing = new TransportFailure("connect_timeout", "x");
  assert.equal(classifySocketError(existing), existing);
});

test("non-JSON 200 bodies are a typed failure, not a crash", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.end("<html>gateway</html>");
  });
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload: payload({ model: "m", stream: false }),
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 5,
      connectTimeoutSec: 5,
    });
    if (outcome.status === "failure") assert.equal(outcome.failure.kind, "network");
    else assert.fail("expected failure");
  } finally {
    await server.close();
  }
});
