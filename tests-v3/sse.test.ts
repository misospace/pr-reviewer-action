import test from "node:test";
import assert from "node:assert/strict";
import { reassembleSse } from "../src/transport/sse.js";

const data = (obj: unknown): string => `data: ${JSON.stringify(obj)}`;

test("openai streamed content accumulates in order", () => {
  const text = [
    data({ id: "c1", model: "m", choices: [{ index: 0, delta: { content: "Hel" } }] }),
    "",
    data({ id: "c1", choices: [{ index: 0, delta: { content: "lo" } }] }),
    data({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
    "data: [DONE]",
    "",
  ].join("\n");
  const response = reassembleSse(text, "openai");
  assert.equal(response.content, "Hello");
  assert.equal(response.finishReason, "stop");
  assert.deepEqual(response.usage, { promptTokens: 10, completionTokens: 2, totalTokens: 12 });
  assert.deepEqual(response.toolCalls, []);
  assert.equal(response.object, "chat.completion");
});

test("openai streamed usage is summed across chunks", () => {
  const text = [
    data({ choices: [{ delta: { content: "a" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
    data({ choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
  ].join("\n");
  const response = reassembleSse(text, "openai");
  assert.deepEqual(response.usage, { promptTokens: 8, completionTokens: 5, totalTokens: 13 });
});

test("openai streamed tool-call deltas accumulate into string arguments (#233)", () => {
  const text = [
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path' } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ': "a.md"}' } }] } }] }),
    data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
  ].join("\n");
  const response = reassembleSse(text, "openai");
  assert.equal(response.toolCalls.length, 1);
  assert.deepEqual(response.toolCalls[0], {
    id: "call_1",
    type: "function",
    function: { name: "read_file", arguments: '{"path: "a.md"}' },
  });
  assert.equal(response.finishReason, "tool_calls");
});

test("openai parallel tool-call deltas flush in index order even when delivered out of order", () => {
  const text = [
    data({ choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "git_grep", arguments: "{}" } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read_file", arguments: "{}" } }] } }] }),
  ].join("\n");
  const response = reassembleSse(text, "openai");
  assert.deepEqual(response.toolCalls.map((call) => call.id), ["call_a", "call_b"]);
});

test("openai single-object tool_calls shape (LiteLLM quirk) is tolerated", () => {
  const response = reassembleSse(
    data({ choices: [{ delta: { tool_calls: { index: 0, id: "t", function: { name: "git_log", arguments: "{}" } } } }] }),
    "openai",
  );
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0]!.function.name, "git_log");
});

test("tool calls without id or name are dropped, never emitted half-formed", () => {
  const response = reassembleSse(
    data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] }),
    "openai",
  );
  assert.deepEqual(response.toolCalls, []);
});

test("malformed tool-call fragment from a truncated stream passes through verbatim", () => {
  const response = reassembleSse(
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t", function: { name: "read_file", arguments: '{"path' } }] } }] }),
    "openai",
  );
  assert.equal(response.toolCalls[0]!.function.arguments, '{"path');
});

test("text-only streams never gain a tool_calls key", () => {
  const response = reassembleSse(data({ choices: [{ delta: { content: "hi" } }] }), "openai");
  assert.equal("toolCalls" in response, true);
  assert.deepEqual(response.toolCalls, []);
});

test("openai chunk-level error events are captured", () => {
  const response = reassembleSse(data({ error: { message: "overloaded" } }), "openai");
  assert.deepEqual(response.error, { message: "overloaded" });
});

test("keepalive lines, comment lines, and malformed payloads are skipped", () => {
  const text = [
    ": ping",
    "event: message",
    "data: not-json",
    "",
    data({ choices: [{ delta: { content: "ok" } }] }),
    "data: [DONE]",
  ].join("\n");
  const response = reassembleSse(text, "openai");
  assert.equal(response.content, "ok");
});

test("truncated stream flushes what it has", () => {
  const response = reassembleSse(data({ choices: [{ delta: { content: "partial" } }] }), "openai");
  assert.equal(response.content, "partial");
  assert.equal(response.finishReason, "stop");
});

test("anthropic streamed text and message_delta usage addition", () => {
  const text = [
    data({ type: "message_start", message: { id: "msg_1", model: "claude-x", usage: { input_tokens: 11, output_tokens: 1 } } }),
    data({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } }),
    data({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
    data({ type: "message_stop" }),
  ].join("\n");
  const response = reassembleSse(text, "anthropic");
  assert.equal(response.content, "Hi");
  assert.equal(response.id, "msg_1");
  assert.equal(response.model, "claude-x");
  assert.equal(response.finishReason, "end_turn");
  assert.deepEqual(response.usage, { promptTokens: 11, completionTokens: 6, totalTokens: 17 });
});

test("anthropic tool_use blocks accumulate input_json_delta fragments", () => {
  const text = [
    data({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "git_grep" } }),
    data({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pattern"' } }),
    data({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ': "x"}' } }),
    data({ type: "content_block_stop", index: 1 }),
    data({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
    data({ type: "message_stop" }),
  ].join("\n");
  const response = reassembleSse(text, "anthropic");
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0]!.function.arguments, '{"pattern": "x"}');
  // tool_use normalizes to the OpenAI spelling
  assert.equal(response.finishReason, "tool_calls");
});

test("anthropic dict-shaped input_json payload is re-serialized (proxy quirk)", () => {
  const text = [
    data({ type: "content_block_start", content_block: { type: "tool_use", id: "tu", name: "f" } }),
    data({ type: "content_block_delta", delta: { type: "input_json_delta", input: { path: "a.md" } } }),
    data({ type: "content_block_stop" }),
  ].join("\n");
  const response = reassembleSse(text, "anthropic");
  assert.equal(response.toolCalls[0]!.function.arguments, '{"path":"a.md"}');
});

test("anthropic index-less tool blocks still flush (proxy omitting index)", () => {
  const text = [
    data({ type: "content_block_start", content_block: { type: "tool_use", id: "tu", name: "f" } }),
    data({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } }),
    data({ type: "content_block_stop" }),
  ].join("\n");
  const response = reassembleSse(text, "anthropic");
  assert.equal(response.toolCalls.length, 1);
});

test("anthropic error events are captured", () => {
  const response = reassembleSse(data({ type: "error", error: { message: "overloaded" } }), "anthropic");
  assert.deepEqual(response.error, { message: "overloaded" });
});

test("thinking deltas are ignored", () => {
  const text = [
    data({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hm" } }),
    data({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } }),
  ].join("\n");
  const response = reassembleSse(text, "anthropic");
  assert.equal(response.content, "ok");
});

test("plain JSON error body with HTTP 200 is adopted as an error", () => {
  const text = JSON.stringify({ error: { message: "context length exceeded", type: "invalid_request_error" } });
  const response = reassembleSse(text, "openai");
  assert.deepEqual(response.error, { message: "context length exceeded", type: "invalid_request_error" });
  assert.equal(response.content, "");
});

test("plain JSON success body without SSE framing is not misread", () => {
  const text = JSON.stringify({ choices: [{ message: { content: "hi" } }] });
  const response = reassembleSse(text, "openai");
  // No SSE data lines: nothing reassembles, and no error key exists on the body.
  assert.equal(response.content, "");
  assert.equal(response.error, undefined);
});
