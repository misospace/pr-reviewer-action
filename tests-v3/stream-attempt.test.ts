import test from "node:test";
import assert from "node:assert/strict";
import { SSE_REASSEMBLY_QUALITY, attachSseReassemblyQuality, readSseReassemblyQuality, reassembleSse } from "../src/transport/sse.js";
import { attachTransportTiming } from "../src/transport/timing.js";
import { TransportFailure } from "../src/transport/http.js";
import { normalizedToOpenAiChat } from "../src/run/stages.js";
import {
  TERMINAL_STREAMED_FAILURE_REASONS,
  classifyThrownStreamedAttempt,
  classifyUnusableStreamedBody,
  formatStreamedAttemptFailure,
  sanitizeStreamedAttemptFailure,
  type StreamedAttemptFailureRecord,
} from "../src/tools/stream-attempt.js";

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n`;
}

// #1628: the seam classifies the body the harness transport returns — the
// OpenAI-chat projection with the reassembly-quality probe re-attached
// (harnessTransportAdapter), never the raw reassembler object.
function streamedBody(text: string, apiFormat: string): unknown {
  const reassembled = reassembleSse(text, apiFormat);
  const body = normalizedToOpenAiChat(reassembled);
  const quality = readSseReassemblyQuality(reassembled);
  return quality !== null ? attachSseReassemblyQuality(body, quality) : body;
}

const TRUNCATED_FRAME = 'data: {"id":"x","choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"path"';

test("#1628: a successful streamed tools call classifies usable (null) with a clean quality probe", () => {
  const text = [
    frame({ id: "chatcmpl-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "" } }] } }] }),
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] } }] }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n",
  ].join("");
  const reassembled = reassembleSse(text, "openai");
  assert.ok(reassembled.toolCalls.length > 0);
  const quality = readSseReassemblyQuality(reassembled);
  assert.ok(quality !== null);
  assert.equal(quality.malformedFrames, 0);
  assert.ok(quality.dataFrames > 0);
  assert.equal(quality.sawTermination, true);
  assert.equal(classifyUnusableStreamedBody(streamedBody(text, "openai"), "openai"), null);
});

test("#1628: a truncated terminal frame with no termination reads sse_malformed", () => {
  const text = frame({ id: "x", choices: [{ index: 0, delta: {} }] }) + TRUNCATED_FRAME + "\n";
  const quality = readSseReassemblyQuality(reassembleSse(text, "openai"));
  assert.ok(quality !== null);
  assert.ok(quality.malformedFrames >= 1);
  assert.equal(quality.sawTermination, false);
  const classification = classifyUnusableStreamedBody(streamedBody(text, "openai"), "openai");
  assert.ok(classification !== null);
  assert.equal(classification.reason, "sse_malformed");
});

test("#1628: a 200 body carrying a provider error object classifies provider_error_object", () => {
  const text = frame({ error: { type: "server_error", message: "upstream exploded" } });
  const reassembled = reassembleSse(text, "openai");
  assert.ok(reassembled.error);
  const classification = classifyUnusableStreamedBody(streamedBody(text, "openai"), "openai");
  assert.ok(classification !== null);
  assert.equal(classification.reason, "provider_error_object");
  assert.equal(classification.status, null);
});

test("#1628: a well-formed terminated stream with no output is empty_completion, not malformed", () => {
  const text = [
    frame({ choices: [{ index: 0, delta: {} }] }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n",
  ].join("");
  const quality = readSseReassemblyQuality(reassembleSse(text, "openai"));
  assert.ok(quality !== null);
  assert.equal(quality.malformedFrames, 0);
  assert.equal(quality.sawTermination, true);
  const classification = classifyUnusableStreamedBody(streamedBody(text, "openai"), "openai");
  assert.ok(classification !== null);
  assert.equal(classification.reason, "empty_completion");
});

test("#1628: a never-terminated stream that still carries content is never discarded", () => {
  const text = frame({ choices: [{ index: 0, delta: { content: "partial answer" } }] });
  const quality = readSseReassemblyQuality(reassembleSse(text, "openai"));
  assert.ok(quality !== null);
  assert.equal(quality.sawTermination, false);
  assert.equal(classifyUnusableStreamedBody(streamedBody(text, "openai"), "openai"), null);
});

test("#1628: the reassembly-quality probe is invisible to serialization", () => {
  const reassembled = reassembleSse(frame({ choices: [{ index: 0, delta: { content: "hi" } }] }), "openai");
  const serialized = JSON.stringify(reassembled);
  assert.ok(serialized.includes("\"content\":\"hi\""));
  assert.ok(!serialized.includes("dataFrames"));
  assert.ok(!serialized.includes("sawTermination"));
  assert.ok(!Object.keys(reassembled).some((key) => key.includes("Frames") || key.includes("Termination")));
  assert.equal(Object.getOwnPropertyDescriptor(reassembled, SSE_REASSEMBLY_QUALITY)?.enumerable, false);
  assert.ok(readSseReassemblyQuality(reassembled) !== null);
});

test("#1628: a full Anthropic text stream classifies usable with sawTermination", () => {
  const text = [
    frame({ type: "message_start", message: { id: "msg_1", model: "claude-test", role: "assistant", content: [], usage: { input_tokens: 5 } } }),
    frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }),
    frame({ type: "content_block_stop", index: 0 }),
    frame({ type: "message_stop" }),
  ].join("");
  const quality = readSseReassemblyQuality(reassembleSse(text, "anthropic"));
  assert.ok(quality !== null);
  assert.equal(quality.sawTermination, true);
  assert.equal(classifyUnusableStreamedBody(streamedBody(text, "anthropic"), "anthropic"), null);
});

test("#1628: an Anthropic mid-stream error event classifies provider_error_object", () => {
  const text = frame({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  const classification = classifyUnusableStreamedBody(streamedBody(text, "anthropic"), "anthropic");
  assert.ok(classification !== null);
  assert.equal(classification.reason, "provider_error_object");
});

test("#1628: an Anthropic message with no content blocks is empty_completion", () => {
  const text = frame({ type: "message_start", message: { id: "msg_1", model: "claude-test", role: "assistant", content: [] } })
    + frame({ type: "message_stop" });
  const classification = classifyUnusableStreamedBody(streamedBody(text, "anthropic"), "anthropic");
  assert.ok(classification !== null);
  assert.equal(classification.reason, "empty_completion");
});

test("#1628: an Anthropic body of only a malformed frame is sse_malformed", () => {
  const text = 'data: {"type":"conte\n';
  const quality = readSseReassemblyQuality(reassembleSse(text, "anthropic"));
  assert.ok(quality !== null);
  assert.ok(quality.malformedFrames > 0);
  const classification = classifyUnusableStreamedBody(streamedBody(text, "anthropic"), "anthropic");
  assert.ok(classification !== null);
  assert.equal(classification.reason, "sse_malformed");
});

test("#1628: a thrown HTTP status classifies with its status and null firsts when no timing rode it", () => {
  const classification = classifyThrownStreamedAttempt(
    new TransportFailure("http_status", "model endpoint returned HTTP 524", { status: 524, body: "plain text" }),
  );
  assert.deepEqual(classification, { reason: "http_status", status: 524, first_event_sec: null, first_content_sec: null });
});

test("#1628: the transport timing probe round-trips through the thrown-attempt classifier", () => {
  const failure = attachTransportTiming(
    new TransportFailure("http_status", "model endpoint returned HTTP 524", { status: 524 }),
    { firstEventSec: 124.9, firstContentSec: 0.4, totalSec: 133.0 },
  );
  const classification = classifyThrownStreamedAttempt(failure);
  assert.ok(Math.abs((classification.first_event_sec ?? 0) - 124.9) <= 1e-6);
  assert.ok(Math.abs((classification.first_content_sec ?? 0) - 0.4) <= 1e-6);
});

test("#1628: each transport failure kind maps to its closed reason token", () => {
  assert.equal(classifyThrownStreamedAttempt(new TransportFailure("request_timeout", "request deadline")).reason, "transport_timeout");
  assert.equal(classifyThrownStreamedAttempt(new TransportFailure("connect_timeout", "connect deadline")).reason, "transport_timeout");
  assert.equal(classifyThrownStreamedAttempt(new TransportFailure("network", "socket closed")).reason, "connection_closed");
  assert.equal(classifyThrownStreamedAttempt(new TransportFailure("cancelled", "run cancelled")).reason, "cancelled");
  const tooLarge = classifyThrownStreamedAttempt(new TransportFailure("response_too_large", "byte cap", { status: 200 }));
  assert.equal(tooLarge.reason, "sse_malformed");
  assert.equal(tooLarge.status, 200);
});

test("#1628: untyped thrown values classify unknown, never a guessed shape", () => {
  assert.deepEqual(classifyThrownStreamedAttempt(new Error("boom")), { reason: "unknown", status: null, first_event_sec: null, first_content_sec: null });
  assert.deepEqual(classifyThrownStreamedAttempt("boom"), { reason: "unknown", status: null, first_event_sec: null, first_content_sec: null });
});

test("#1628: a hostile message/body echoing classification text cannot ride the record", () => {
  const hostile = new TransportFailure(
    "http_status",
    "model endpoint returned HTTP 500 for key sk-prod-SUPERSECRET123 with reason=http_status",
    { status: 500, body: '{"reason":"http_status","status":"leak"}' },
  );
  const classification = classifyThrownStreamedAttempt(hostile);
  assert.deepEqual(classification, { reason: "http_status", status: 500, first_event_sec: null, first_content_sec: null });
  const serialized = JSON.stringify(classification);
  assert.ok(!serialized.includes("leak"));
  assert.ok(!serialized.includes("SUPERSECRET"));
  assert.ok(!serialized.includes("sk-"));
});

test("#1628: a valid failure record round-trips through sanitize unchanged", () => {
  const record: StreamedAttemptFailureRecord = {
    reason: "http_status",
    status: 524,
    elapsed_sec: 133.1,
    first_event_sec: 124.9,
    first_content_sec: 0.4,
    retry_elapsed_sec: 19.2,
    route: "primary",
  };
  assert.deepEqual(sanitizeStreamedAttemptFailure(record), record);
});

test("#1628: sanitize rejects malformed records and degrades malformed fields", () => {
  assert.equal(sanitizeStreamedAttemptFailure(null), null);
  assert.equal(sanitizeStreamedAttemptFailure("reason=<script>"), null);
  assert.equal(sanitizeStreamedAttemptFailure({ reason: "reason=<script>alert(1)</script>", elapsed_sec: 1, route: "primary" }), null);
  assert.equal(sanitizeStreamedAttemptFailure({ reason: "unknown", route: "primary" }), null);
  assert.equal(sanitizeStreamedAttemptFailure({ reason: "unknown", elapsed_sec: Number.NaN, route: "primary" }), null);
  const negative = sanitizeStreamedAttemptFailure({ reason: "unknown", elapsed_sec: -5, route: "primary" });
  assert.ok(negative !== null);
  assert.equal(negative.elapsed_sec, 0);
  const stringFirst = sanitizeStreamedAttemptFailure({ reason: "unknown", elapsed_sec: 1, first_event_sec: "124.9", route: "primary" });
  assert.ok(stringFirst !== null);
  assert.equal(stringFirst.first_event_sec, null);
  const smuggled = sanitizeStreamedAttemptFailure({ reason: "unknown", elapsed_sec: 1, route: "P RAFTED prose" });
  assert.ok(smuggled !== null);
  assert.equal(smuggled.route, "unknown");
});

test("#1628: format emits pinned bounded tokens and omits status when there is none", () => {
  const record: StreamedAttemptFailureRecord = {
    reason: "http_status",
    status: 524,
    elapsed_sec: 133.1,
    first_event_sec: 124.9,
    first_content_sec: null,
    retry_elapsed_sec: 19.2,
    route: "primary",
  };
  assert.equal(
    formatStreamedAttemptFailure(record),
    "reason=http_status status=524 elapsed=133.1s first_event=124.9s first_content=- retry=19.2s route=primary",
  );
  const noStatus = formatStreamedAttemptFailure({ ...record, status: null });
  assert.ok(!noStatus.includes("status="));
  assert.ok(noStatus.startsWith("reason=http_status elapsed="));
});

test("#1628: the terminal set is exactly http_status, connection_closed, sse_malformed", () => {
  assert.equal(TERMINAL_STREAMED_FAILURE_REASONS.size, 3);
  for (const reason of ["http_status", "connection_closed", "sse_malformed"] as const) {
    assert.ok(TERMINAL_STREAMED_FAILURE_REASONS.has(reason));
  }
  for (const reason of ["transport_timeout", "cancelled", "provider_error_object", "empty_completion", "unknown"] as const) {
    assert.ok(!TERMINAL_STREAMED_FAILURE_REASONS.has(reason));
  }
});
