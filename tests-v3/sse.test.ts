import test from "node:test";
import assert from "node:assert/strict";
import { isContentBearingSseFrame, reassembleSse } from "../src/transport/sse.js";

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

test("anthropic streamed usage: the last NON-ZERO report of a field wins (message_delta's output_tokens is cumulative)", () => {
  // #1466: Anthropic's `message_delta.usage.output_tokens` is the CUMULATIVE
  // output count of the turn, not a delta — so it REPLACES the earlier
  // `message_start` value instead of adding to it. Adding them would count
  // the same turn twice (the placeholder plus the real count).
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
  assert.deepEqual(response.usage, { promptTokens: 11, completionTokens: 5, totalTokens: 16 });
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

// ── #1466: the Anthropic usage counters are per field, last non-zero report
// wins ──────────────────────────────────────────────────────────────────────
// MiniMax/LiteLLM report a `{input_tokens: 0, output_tokens: 0}` placeholder
// in `message_start` and the REAL counters in `message_delta`. Reading the
// usage only from `message_start` made the Action log `prompt=0 cached=-`
// for a turn the provider billed ~190k prompt tokens with ~190k cache reads.

test("#1466: the real MiniMax/LiteLLM Anthropic usage shape counts the counters message_delta carries", () => {
  const text = [
    data({ type: "message_start", message: { id: "m1", model: "minimax", usage: { input_tokens: 0, output_tokens: 0 } } }),
    data({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } }),
    data({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: 447,
        cache_read_input_tokens: 189952,
        output_tokens: 1330,
        output_tokens_details: { thinking_tokens: 512 },
      },
    }),
    data({ type: "message_stop" }),
  ].join("\n");
  const response = reassembleSse(text, "anthropic");
  assert.equal(response.usage?.promptTokens, 447);
  assert.equal(response.usage?.cacheReadTokens, 189952);
  assert.equal(response.usage?.completionTokens, 1330);
  assert.equal(response.usage?.totalTokens, 1777);
  // No cache write was reported, so no cache-write field appears at all.
  assert.equal(response.usage?.cacheWriteTokens, undefined);
});

test("#1466: a field reported by both events counts once — the later report replaces the earlier one", () => {
  const text = [
    data({
      type: "message_start",
      message: { id: "m1", usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 } },
    }),
    data({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } }),
    data({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 447, output_tokens: 1330, cache_read_input_tokens: 189952 },
    }),
    data({ type: "message_stop" }),
  ].join("\n");
  const response = reassembleSse(text, "anthropic");
  // Never the sum of the two reports of the same field.
  assert.equal(response.usage?.promptTokens, 447);
  assert.equal(response.usage?.completionTokens, 1330);
  // The cache READ was reported by both events and counts once — the later
  // non-zero report wins, so the turn is not billed twice.
  assert.equal(response.usage?.cacheReadTokens, 189952);
  // The cache WRITE was reported only by `message_start` and survives.
  assert.equal(response.usage?.cacheWriteTokens, 5);
});

test("#1466: cache counters reported only in message_start survive a message_delta that carries none", () => {
  const text = [
    data({
      type: "message_start",
      message: {
        id: "m1",
        usage: { input_tokens: 447, output_tokens: 0, cache_read_input_tokens: 189952, cache_creation_input_tokens: 2048 },
      },
    }),
    data({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } }),
    data({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1330 } }),
    data({ type: "message_stop" }),
  ].join("\n");
  const response = reassembleSse(text, "anthropic");
  assert.equal(response.usage?.promptTokens, 447);
  assert.equal(response.usage?.cacheReadTokens, 189952);
  assert.equal(response.usage?.cacheWriteTokens, 2048);
  assert.equal(response.usage?.completionTokens, 1330);
});

test("#1466: a zero placeholder in the LATER event never replaces the real counters of the earlier one", () => {
  // The INVERSE of the MiniMax shape: the real counters arrive in
  // `message_start` and the later `message_delta` carries a zero
  // placeholder. Anthropic's counters are cumulative and never decrease, so
  // the zero is a placeholder — taking it would reproduce the #1459 symptom
  // (`prompt=0 cached=-`) in the opposite order.
  const text = [
    data({
      type: "message_start",
      message: {
        id: "m1",
        model: "minimax",
        usage: { input_tokens: 447, output_tokens: 0, cache_read_input_tokens: 189952, cache_creation_input_tokens: 2048 },
      },
    }),
    data({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } }),
    data({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 0, output_tokens: 1330, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }),
    data({ type: "message_stop" }),
  ].join("\n");
  const response = reassembleSse(text, "anthropic");
  // The real counters survive the zero placeholder.
  assert.equal(response.usage?.promptTokens, 447);
  assert.equal(response.usage?.cacheReadTokens, 189952);
  assert.equal(response.usage?.cacheWriteTokens, 2048);
  // The one field the later event reported a NON-ZERO count for wins.
  assert.equal(response.usage?.completionTokens, 1330);
});

test("#1466: a cache counter the provider reported as zero rides the usage as a reported zero", () => {
  // A reported zero is a measurement ("nothing was cached"), so the streamed
  // turn publishes the same value the identical non-streamed body publishes.
  const text = [
    data({
      type: "message_start",
      message: { id: "m1", usage: { input_tokens: 447, output_tokens: 0, cache_read_input_tokens: 0 } },
    }),
    data({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } }),
    data({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } }),
    data({ type: "message_stop" }),
  ].join("\n");
  const response = reassembleSse(text, "anthropic");
  assert.equal(response.usage?.cacheReadTokens, 0);
  assert.equal(response.usage?.promptTokens, 447);
  // The cache WRITE was never reported, so it stays absent.
  assert.equal(response.usage?.cacheWriteTokens, undefined);
});

test("#1466: a cache counter the provider never reported stays absent", () => {
  const text = [
    data({ type: "message_start", message: { id: "m1", usage: { input_tokens: 447, output_tokens: 0 } } }),
    data({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } }),
    data({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } }),
    data({ type: "message_stop" }),
  ].join("\n");
  const response = reassembleSse(text, "anthropic");
  assert.equal(response.usage?.cacheReadTokens, undefined);
  assert.equal(response.usage?.cacheWriteTokens, undefined);
});

// ── #1466: what counts as a content-bearing stream event ───────────────────

test("#1466: isContentBearingSseFrame: an OpenAI text, reasoning, or tool-call delta is content", () => {
  assert.equal(isContentBearingSseFrame(JSON.stringify({ choices: [{ delta: { content: "hi" } }] }), "openai"), true);
  assert.equal(isContentBearingSseFrame(JSON.stringify({ choices: [{ delta: { reasoning_content: "chain" } }] }), "openai"), true);
  assert.equal(isContentBearingSseFrame(JSON.stringify({ choices: [{ delta: { reasoning: "chain" } }] }), "openai"), true);
  // The two reasoning spellings are read independently: an empty
  // `reasoning_content` beside a filled `reasoning` still carries content.
  assert.equal(isContentBearingSseFrame(JSON.stringify({ choices: [{ delta: { reasoning_content: "", reasoning: "chain" } }] }), "openai"), true);
  assert.equal(
    isContentBearingSseFrame(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t", function: { name: "f", arguments: "{}" } }] } }] }), "openai"),
    true,
  );
  // The LiteLLM single-object `tool_calls` shape is content too.
  assert.equal(isContentBearingSseFrame(JSON.stringify({ choices: [{ delta: { tool_calls: { index: 0, id: "t" } } }] }), "openai"), true);
});

test("#1466: isContentBearingSseFrame: an OpenAI frame without content is not content", () => {
  assert.equal(isContentBearingSseFrame(JSON.stringify({ choices: [{ delta: {} }] }), "openai"), false);
  assert.equal(isContentBearingSseFrame(JSON.stringify({ choices: [{ delta: { content: "" } }] }), "openai"), false);
  assert.equal(isContentBearingSseFrame(JSON.stringify({ choices: [{ delta: { reasoning_content: "" } }] }), "openai"), false);
  // An empty `tool_calls` array carries nothing.
  assert.equal(isContentBearingSseFrame(JSON.stringify({ choices: [{ delta: { tool_calls: [] } }] }), "openai"), false);
  // A frame with no choices at all (a usage-only chunk) is not content.
  assert.equal(isContentBearingSseFrame(JSON.stringify({ usage: { prompt_tokens: 1 } }), "openai"), false);
  assert.equal(isContentBearingSseFrame(JSON.stringify({ id: "c1" }), "openai"), false);
});

test("#1466: isContentBearingSseFrame: an Anthropic content block event is content, the envelope events are not", () => {
  assert.equal(isContentBearingSseFrame(JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), "anthropic"), true);
  assert.equal(isContentBearingSseFrame(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }), "anthropic"), true);
  assert.equal(isContentBearingSseFrame(JSON.stringify({ type: "message_start", message: { id: "m1", usage: { input_tokens: 1 } } }), "anthropic"), false);
  assert.equal(isContentBearingSseFrame(JSON.stringify({ type: "ping" }), "anthropic"), false);
  assert.equal(isContentBearingSseFrame(JSON.stringify({ type: "message_stop" }), "anthropic"), false);
});

test("#1466: isContentBearingSseFrame: a malformed payload is never content", () => {
  assert.equal(isContentBearingSseFrame("not json", "openai"), false);
  assert.equal(isContentBearingSseFrame("not json", "anthropic"), false);
  assert.equal(isContentBearingSseFrame("", "openai"), false);
  assert.equal(isContentBearingSseFrame("[1,2,3]", "openai"), false);
});

// ── #1047: block-shape counters for failure diagnostics ──────────────────

test("#1047: an Anthropic stream with thinking blocks records their count — never their text", () => {
  const text = [
    data({ type: "message_start", message: { id: "m1", model: "mm", usage: { input_tokens: 10 } } }),
    data({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    data({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "SECRET-REASONING" } }),
    data({ type: "content_block_stop", index: 0 }),
    data({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    data({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } }),
    data({ type: "content_block_stop", index: 1 }),
    data({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }),
    data({ type: "message_stop" }),
  ].join("\n");
  const response = reassembleSse(text, "anthropic");
  assert.deepEqual(response.blockCounts, { text: 1, thinking: 1, toolUse: 0 });
  assert.equal(JSON.stringify(response.blockCounts).includes("SECRET"), false);
});

test("#1047: redacted thinking blocks are counted as thinking", () => {
  const text = [
    data({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque" } }),
    data({ type: "content_block_stop", index: 0 }),
  ].join("\n");
  const response = reassembleSse(text, "anthropic");
  assert.equal(response.blockCounts?.thinking, 1);
});

test("#1047: an OpenAI-compatible stream counts reasoning_content segments as thinking", () => {
  const text = [
    data({ id: "c1", choices: [{ delta: { reasoning_content: "chain" } }] }),
    data({ id: "c1", choices: [{ delta: { content: "vis" } }] }),
    data({ id: "c1", choices: [{ delta: {}, finish_reason: "stop" }] }),
  ].join("\n");
  const response = reassembleSse(text, "openai");
  assert.deepEqual(response.blockCounts, { text: 1, thinking: 1, toolUse: 0 });
});

test("#1047: thinking-free responses keep the exact v2 shape (no blockCounts key)", () => {
  const text = [
    data({ type: "message_start", message: { id: "m1", model: "mm", usage: { input_tokens: 10 } } }),
    data({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "plain" } }),
    data({ type: "content_block_stop", index: 0 }),
    data({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
  ].join("\n");
  const response = reassembleSse(text, "anthropic");
  assert.equal("blockCounts" in response, false);
});
