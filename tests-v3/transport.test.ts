import test from "node:test";
import assert from "node:assert/strict";
import {
  runHttpRequest,
  resolveEndpoint,
  TransportFailure,
  classifySocketError,
  DEFAULT_MAX_RESPONSE_BYTES,
  OVERSIZE_ERROR_BODY_PREFIX_BYTES,
} from "../src/transport/http.js";
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

test("3xx redirects are typed http_status failures and are never followed", async () => {
  let requests = 0;
  const server = await startMockServer((_req, _body, res) => {
    requests++;
    res.statusCode = 302;
    res.setHeader("Location", `${_req.headers.origin ?? "http://elsewhere.invalid"}/redirected`);
    res.end("Moved: see the Location header");
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
    assert.equal(outcome.failure.status, 302);
    assert.equal(outcome.failure.body, "Moved: see the Location header");
    assert.equal(outcome.failure.message, "model endpoint returned HTTP 302");
    // Deterministic proof the redirect was not followed: exactly one request
    // hit the wire; the Location target was never requested.
    assert.equal(requests, 1);
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

// ---------------------------------------------------------------------------
// Response-byte ceiling (#745). The cap is enforced during receipt at the
// HTTP boundary, below the SSE reassembler, for successes, streams, and
// error bodies alike. Tests drive the real receive path
// (socket -> data chunks -> byte accounting -> abort -> typed failure)
// against the mock server; small caps keep them fast.
// ---------------------------------------------------------------------------

const CAP = 64;

function byteChunks(total: number, chunkSize: number, fill = 0x61): Buffer[] {
  const chunks: Buffer[] = [];
  for (let written = 0; written < total; written += chunkSize) {
    chunks.push(Buffer.alloc(Math.min(chunkSize, total - written), fill));
  }
  return chunks;
}

/** Streams raw byte chunks back-to-back, tolerating client aborts. */
function streamBytes(res: import("node:http").ServerResponse, chunks: Buffer[]): void {
  res.statusCode = 200;
  res.on("error", () => {});
  let index = 0;
  const writeNext = (): void => {
    if (res.destroyed || index >= chunks.length) {
      res.end();
      return;
    }
    res.write(chunks[index++]);
    setImmediate(writeNext);
  };
  writeNext();
}

test("within-limit non-streamed success succeeds under a small cap", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.end(JSON.stringify({ id: "1", choices: [{ message: { content: "hi" } }] }));
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
      maxResponseBytes: CAP,
    });
    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") assert.equal(outcome.response.content, "hi");
  } finally {
    await server.close();
  }
});

test("within-limit SSE response succeeds under a small cap", async () => {
  const server = await startMockServer(sseResponse([
    'data: {"choices":[{"delta":{"content":"a"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]",
  ]));
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload: payload({ model: "m", stream: true }),
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 5,
      connectTimeoutSec: 5,
      maxResponseBytes: 512,
    });
    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") assert.equal(outcome.response.content, "a");
  } finally {
    await server.close();
  }
});

test("within-limit HTTP error body is still fully preserved under a small cap", async () => {
  const body = JSON.stringify({ error: { message: "context length exceeded" } });
  assert.ok(Buffer.byteLength(body) <= CAP);
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 400;
    res.end(body);
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
      maxResponseBytes: CAP,
    });
    assert.equal(outcome.status, "failure");
    if (outcome.status !== "failure") return;
    assert.equal(outcome.failure.kind, "http_status");
    assert.equal(outcome.failure.body, body);
  } finally {
    await server.close();
  }
});

test("oversized non-streamed success aborts mid-receipt with a typed failure", async () => {
  // The server intends ~100x the cap; the client must bail out holding at
  // most the cap plus the single chunk that crossed it.
  const intended = CAP * 100;
  const chunkSize = 32;
  let sawClose: (() => void) | null = null;
  const responseClosed = new Promise<void>((resolve) => { sawClose = resolve; });
  const server = await startMockServer((_req, _body, res) => {
    streamBytes(res, byteChunks(intended, chunkSize));
    res.on("close", () => sawClose?.());
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
      maxResponseBytes: CAP,
    });
    assert.equal(outcome.status, "failure");
    if (outcome.status !== "failure") return;
    assert.equal(outcome.failure.kind, "response_too_large");
    assert.equal(outcome.failure.maxResponseBytes, CAP);
    assert.ok(outcome.failure.bytesReceived !== undefined);
    // The client never retained anywhere near the full body: at most the
    // cap plus the one crossing chunk was ever accumulated.
    assert.ok(outcome.failure.bytesReceived <= CAP + chunkSize);
    assert.ok(outcome.failure.bytesReceived > CAP);
    // The intentional abort tears the response down promptly; the server
    // side sees the close rather than streaming the full body.
    await Promise.race([responseClosed, new Promise<void>((r) => setTimeout(r, 1000))]);
    // Settles exactly once: no later socket error or timeout overwrote the
    // typed failure (an unhandled rejection or crash would fail the test).
    await new Promise<void>((r) => setTimeout(r, 100));
  } finally {
    await server.close();
  }
});

test("many small chunks collectively exceeding the cap abort mid-stream", async () => {
  // Deliberately not one giant chunk: N small writes cross the cap
  // cumulatively, exposing implementations that only check after concat.
  const chunkSize = 8;
  const intended = CAP * 20;
  const server = await startMockServer((_req, _body, res) => {
    streamBytes(res, byteChunks(intended, chunkSize));
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
      maxResponseBytes: CAP,
    });
    assert.equal(outcome.status, "failure");
    if (outcome.status !== "failure") return;
    assert.equal(outcome.failure.kind, "response_too_large");
    assert.ok(outcome.failure.bytesReceived !== undefined);
    assert.ok(outcome.failure.bytesReceived <= CAP + chunkSize);
    assert.ok(intended > CAP + chunkSize);
  } finally {
    await server.close();
  }
});

test("oversized SSE stream fails at the HTTP boundary, before reassembly", async () => {
  const event = 'data: {"choices":[{"delta":{"content":"aaaaaaaa"}}]}\n\n';
  const chunks: Buffer[] = [];
  for (let i = 0; i < CAP * 10; i += Buffer.byteLength(event)) chunks.push(Buffer.from(event));
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    streamBytes(res, chunks);
  });
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload: payload({ model: "m", stream: true }),
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 5,
      connectTimeoutSec: 5,
      maxResponseBytes: CAP,
    });
    assert.equal(outcome.status, "failure");
    if (outcome.status !== "failure") return;
    // Typed response-size failure, not a network/socket misclassification
    // of the intentional abort, and the SSE reassembler never ran.
    assert.equal(outcome.failure.kind, "response_too_large");
    assert.equal(outcome.failure.maxResponseBytes, CAP);
  } finally {
    await server.close();
  }
});

test("oversized HTTP error body is not retained; typed failure wins over http_status", async () => {
  // Larger than both the cap and the diagnostic-prefix budget, so real
  // truncation (not just cap-trip) is proven.
  const oversized = "E".repeat(CAP * 100);
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 500;
    res.end(oversized);
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
      maxResponseBytes: CAP,
    });
    assert.equal(outcome.status, "failure");
    if (outcome.status !== "failure") return;
    assert.equal(outcome.failure.kind, "response_too_large");
    assert.equal(outcome.failure.status, 500);
    assert.equal(outcome.failure.maxResponseBytes, CAP);
    assert.ok(outcome.failure.bytesReceived !== undefined && outcome.failure.bytesReceived > CAP);
    // Bounded diagnostic prefix with explicit truncation, never the body.
    assert.ok(outcome.failure.body !== undefined);
    assert.ok(outcome.failure.body.startsWith("E"));
    assert.ok(outcome.failure.body.endsWith("…[error body truncated: response exceeded the transport response-byte limit]"));
    assert.ok(outcome.failure.body.length <= OVERSIZE_ERROR_BODY_PREFIX_BYTES + 100);
    assert.ok(outcome.failure.body.length < oversized.length);  } finally {
    await server.close();
  }
});

test("a response of exactly the byte limit succeeds; one byte over fails", async () => {
  const atLimit = Buffer.alloc(CAP, 0x61).toString("latin1");
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.end(Buffer.from(atLimit, "latin1"));
  });
  try {
    const result = await runHttpRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      bodyText: "{}",
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 5,
      connectTimeoutSec: 5,
      stream: false,
      maxResponseBytes: CAP,
    });
    assert.equal(result.body, atLimit);
  } finally {
    await server.close();
  }

  const server2 = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.end(Buffer.alloc(CAP + 1, 0x61));
  });
  try {
    let caught: unknown = null;
    try {
      await runHttpRequest({
        baseUrl: server2.url,
        apiFormat: "openai",
        bodyText: "{}",
        apiKey: "",
        anthropicVersion: "2023-06-01",
        requestTimeoutSec: 5,
        connectTimeoutSec: 5,
        stream: false,
        maxResponseBytes: CAP,
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof TransportFailure);
    assert.equal((caught as TransportFailure).kind, "response_too_large");
    assert.equal((caught as TransportFailure).bytesReceived, CAP + 1);
  } finally {
    await server2.close();
  }
});

test("UTF-8 multibyte content is counted in bytes, including chunks split mid-character", async () => {
  // "😀αα" is 4 + 2 + 2 = 8 bytes; the first chunk deliberately splits the
  // emoji after 3 bytes so byte accounting, not string length, decides.
  const emoji = Buffer.from("😀", "utf8");
  const alpha = Buffer.from("αα", "utf8");
  const body = Buffer.concat([emoji, alpha]);
  assert.equal(body.length, 8);

  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.write(body.subarray(0, 3));
    res.write(body.subarray(3));
    res.end();
  });
  try {
    const result = await runHttpRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      bodyText: "{}",
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 5,
      connectTimeoutSec: 5,
      stream: false,
      maxResponseBytes: 8,
    });
    assert.equal(result.body, "😀αα");
  } finally {
    await server.close();
  }

  const server2 = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.write(body);
    res.end();
  });
  try {
    let caught: unknown = null;
    try {
      await runHttpRequest({
        baseUrl: server2.url,
        apiFormat: "openai",
        bodyText: "{}",
        apiKey: "",
        anthropicVersion: "2023-06-01",
        requestTimeoutSec: 5,
        connectTimeoutSec: 5,
        stream: false,
        maxResponseBytes: 7,
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof TransportFailure);
    assert.equal((caught as TransportFailure).kind, "response_too_large");
    assert.equal((caught as TransportFailure).bytesReceived, 8);
  } finally {
    await server2.close();
  }
});

test("the default response-byte ceiling is enforced without per-call configuration", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.end(Buffer.alloc(DEFAULT_MAX_RESPONSE_BYTES + 1, 0x61));
  });
  try {
    let caught: unknown = null;
    try {
      await runHttpRequest({
        baseUrl: server.url,
        apiFormat: "openai",
        bodyText: "{}",
        apiKey: "",
        anthropicVersion: "2023-06-01",
        requestTimeoutSec: 5,
        connectTimeoutSec: 5,
        stream: false,
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof TransportFailure);
    assert.equal((caught as TransportFailure).kind, "response_too_large");
    assert.equal((caught as TransportFailure).maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  } finally {
    await server.close();
  }
});

test("an endless response is abandoned at the cap without unbounded buffering or crashes", async () => {
  // Adversarial: the endpoint never stops writing. The transport must stop
  // receiving, settle exactly once with the typed failure, and survive the
  // server's post-abort writes (no unhandled socket errors, no
  // request_timeout overwrite) — node:test fails the test otherwise.
  let sawClose: (() => void) | null = null;
  const responseClosed = new Promise<void>((resolve) => { sawClose = resolve; });
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.on("error", () => {});
    const chunk = Buffer.alloc(32, 0x61);
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer);
        return;
      }
      res.write(chunk);
    }, 1);
    res.on("close", () => {
      clearInterval(timer);
      sawClose?.();
    });
  });
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload: payload({ model: "m", stream: false }),
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 30,
      connectTimeoutSec: 5,
      maxResponseBytes: CAP,
    });
    assert.equal(outcome.status, "failure");
    if (outcome.status !== "failure") return;
    assert.equal(outcome.failure.kind, "response_too_large");
    // The abort closed the connection while the server was still writing.
    await Promise.race([responseClosed, new Promise<void>((r) => setTimeout(r, 1000))]);
    // Give any post-abort socket noise time to surface; settle-once means
    // the original typed failure must stand and nothing may crash.
    await new Promise<void>((r) => setTimeout(r, 100));
    assert.equal(outcome.failure.kind, "response_too_large");
  } finally {
    await server.close();
  }
});

test("a slow but within-limit stream still succeeds (byte cap does not alter timing behavior)", async () => {
  const server = await startMockServer(sseResponse([
    'data: {"choices":[{"delta":{"content":"a"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]",
  ], { delayMs: 20 }));
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload: payload({ model: "m", stream: true }),
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 5,
      connectTimeoutSec: 5,
      maxResponseBytes: 512,
    });
    assert.equal(outcome.status, "ok");
  } finally {
    await server.close();
  }
});
