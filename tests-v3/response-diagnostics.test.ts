import test from "node:test";
import assert from "node:assert/strict";
import {
  describeUnusableResponse,
  formatResponseDiagnosticsLine,
  shouldRaiseCompletionBudget,
} from "../src/model/response-diagnostics.js";

// #1047: the bounded, content-free diagnostics for unusable model responses.
// The record must never carry response text, reasoning, or credentials — only
// counts, reasons, and token figures — because it lands in logs, step
// summaries, and run artifacts.

function anthropicBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_1",
    model: "m",
    role: "assistant",
    type: "message",
    content: [],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 4 },
    ...overrides,
  };
}

function openaiBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "c1",
    model: "m",
    choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 0 },
    ...overrides,
  };
}

test("#1047: a token-cap truncation is classified truncated and carries the stop reason", () => {
  for (const stop of ["max_tokens", "length", "max_output_tokens"]) {
    const result = describeUnusableResponse({
      response: anthropicBody({
        stop_reason: stop,
        content: [{ type: "text", text: "{\"verdict\": \"appr" }],
      }),
      apiFormat: "anthropic",
      profile: "Primary",
      streamed: true,
      failureKind: "not_object",
    });
    assert.ok(result);
    assert.equal(result.class, "truncated", stop);
    assert.equal(result.record.finish_reason, stop);
    assert.equal(result.record.text_blocks, 1);
    assert.equal(result.record.profile, "Primary");
    assert.equal(result.record.api_format, "anthropic");
    assert.equal(result.record.streamed, true);
    assert.equal(result.record.failure_kind, "not_object");
  }
});

test("#1047: a reasoning-only Anthropic body (thinking blocks, no text) is not zero-output", () => {
  // The exact #1033 dogfood shape: the model spent the turn thinking and the
  // visible text never arrived.
  const result = describeUnusableResponse({
    response: anthropicBody({
      stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "SECRET REASONING TEXT", signature: "sig" }],
      usage: { input_tokens: 100, output_tokens: 512 },
    }),
    apiFormat: "anthropic",
    profile: "Primary",
    streamed: true,
    failureKind: "not_object",
  });
  assert.ok(result);
  assert.equal(result.class, "reasoning-only");
  assert.equal(result.record.thinking_blocks, 1);
  assert.equal(result.record.text_blocks, 0);
  assert.equal(result.record.completion_tokens, 512);
  // The thinking TEXT itself never enters the record.
  assert.equal(JSON.stringify(result.record).includes("SECRET"), false);
});

test("#1047: a reasoning-only OpenAI-style body (reasoning_content, no content) is classified", () => {
  const result = describeUnusableResponse({
    response: openaiBody({
      choices: [{ message: { role: "assistant", content: "", reasoning_content: "chain of thought" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 300 },
    }),
    apiFormat: "openai",
    profile: "Fallback",
    streamed: false,
    failureKind: "not_object",
  });
  assert.ok(result);
  assert.equal(result.class, "reasoning-only");
  assert.equal(result.record.thinking_blocks, 1);
  assert.equal(JSON.stringify(result.record).includes("chain"), false);
});

test("#1047: present-but-unparseable text is malformed-json, never zero-output", () => {
  const result = describeUnusableResponse({
    response: anthropicBody({
      content: [{ type: "text", text: "sure! here is my answer: [partial" }],
    }),
    apiFormat: "anthropic",
    profile: "Primary",
    streamed: false,
    failureKind: "not_object",
  });
  assert.ok(result);
  assert.equal(result.class, "malformed-json");
  // Bounded shape only: the character COUNT is kept, the text is not.
  assert.equal(result.record.text_chars, "sure! here is my answer: [partial".length);
  assert.equal(JSON.stringify(result.record).includes("sure!"), false);
});

test("#1047: streamed tokens billed but no text frame delivered is sse-framing-loss", () => {
  // The reassembler saw usage deltas but zero text deltas — the payload
  // frames were lost while the accounting frames were not.
  const result = describeUnusableResponse({
    response: {
      id: "msg_1", object: "chat.completion", model: "m",
      content: "", toolCalls: [], finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 640, totalTokens: 740 },
      error: undefined,
      blockCounts: { text: 0, thinking: 0, toolUse: 0 },
    },
    apiFormat: "anthropic",
    profile: "Primary",
    streamed: true,
    failureKind: "empty_completion",
  });
  assert.ok(result);
  assert.equal(result.class, "sse-framing-loss");
  assert.equal(result.record.completion_tokens, 640);
});

test("#1047: a zero-output body (no text, no thinking, no tokens) is zero-output", () => {
  const result = describeUnusableResponse({
    response: anthropicBody({ usage: { input_tokens: 100, output_tokens: 0 } }),
    apiFormat: "anthropic",
    profile: "Primary",
    streamed: false,
    failureKind: "empty_completion",
  });
  assert.ok(result);
  assert.equal(result.class, "zero-output");
  assert.equal(result.record.completion_tokens, 0);
});

test("#1047: transport failures classify by kind: timeout, http-error, network", () => {
  const timeout = describeUnusableResponse({
    response: null, apiFormat: "anthropic", profile: "Primary", streamed: true,
    failureKind: "request_timeout",
  });
  assert.ok(timeout);
  assert.equal(timeout.class, "timeout");
  assert.equal(timeout.record.finish_reason, undefined);

  const http = describeUnusableResponse({
    response: null, apiFormat: "anthropic", profile: "Primary", streamed: true,
    httpStatus: 524, failureKind: "http_status",
  });
  assert.ok(http);
  assert.equal(http.class, "http-error");
  assert.equal(http.record.http_status, 524);

  const network = describeUnusableResponse({
    response: null, apiFormat: "openai", profile: "Fallback", streamed: false,
    failureKind: "network",
  });
  assert.ok(network);
  assert.equal(network.class, "transport-error");
  assert.equal(network.record.api_format, "openai");
});

test("#1047: a 200 body carrying an error object is endpoint-error", () => {
  const result = describeUnusableResponse({
    response: anthropicBody({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    apiFormat: "anthropic",
    profile: "Smart",
    streamed: true,
  });
  assert.ok(result);
  assert.equal(result.class, "endpoint-error");
});

test("#1047: the record is hostile-input safe — control chars and key-shaped tokens in a stop reason never survive", () => {
  // #252: a hostile endpoint controls the stop_reason string. It arrives
  // control-flattened (no log-line forgery), bounded, and run through the
  // same redaction every other provider-controlled string gets.
  const result = describeUnusableResponse({
    response: anthropicBody({
      stop_reason: "end_turn\nERROR: key sk-abcdefghijklmnop1234",
      content: [{ type: "text", text: "x" }],
    }),
    apiFormat: "anthropic",
    profile: "Primary",
    streamed: false,
    failureKind: "not_object",
  });
  assert.ok(result);
  const line = formatResponseDiagnosticsLine(result.record);
  assert.equal(line.includes("\n"), false, line);
  assert.ok(line.startsWith("response_class="));
  assert.equal(line.includes("sk-abcdefghijklmnop1234"), false, line);
  assert.ok(line.includes("finish_reason=end_turn ERROR: key [REDACTED]"), line);
});

test("#1047: the log line renders only present fields, in canonical order", () => {
  const line = formatResponseDiagnosticsLine({
    response_class: "http-error", profile: "Primary", api_format: "anthropic",
    streamed: true, http_status: 524, failure_kind: "http_status",
  });
  assert.equal(
    line,
    "response_class=http-error profile=Primary api_format=anthropic streamed=true http_status=524 failure_kind=http_status",
  );
});

test("#1047: the completion-budget raise fires only on cap-destroyed verdicts", () => {
  assert.equal(shouldRaiseCompletionBudget("truncated"), true);
  assert.equal(shouldRaiseCompletionBudget("reasoning-only"), true);
  // Everything else is not helped by more tokens.
  for (const klass of [
    "zero-output", "malformed-json", "sse-framing-loss",
    "http-error", "timeout", "transport-error", "endpoint-error",
  ] as const) {
    assert.equal(shouldRaiseCompletionBudget(klass), false, klass);
  }
});

test("#1047: a hostile profile label is flattened and bounded like every other field", () => {
  const result = describeUnusableResponse({
    response: anthropicBody(),
    apiFormat: "anthropic",
    profile: "Bad\nLabel\twith control\u0007chars".padEnd(120, "x"),
    streamed: false,
    failureKind: "empty_completion",
  });
  assert.ok(result);
  const profile = String(result.record.profile);
  assert.equal(profile.includes("\n"), false);
  assert.equal(profile.length <= 64, true);
});
