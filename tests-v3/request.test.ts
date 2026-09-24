import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildModelRequest, OPENAI_VERDICT_JSON_SCHEMA } from "../src/model/request.js";
import type { ModelRequestConfig } from "../src/model/types.js";

function config(overrides: Partial<ModelRequestConfig> = {}): ModelRequestConfig {
  return {
    apiFormat: "openai",
    model: "test-model",
    system: "SYSTEM",
    user: "USER",
    corpus: "CORPUS",
    stream: false,
    shape: "default",
    maxTokens: 8192,
    temperature: 0.1,
    responseFormat: "off",
    tokensParam: "max_tokens",
    ...overrides,
  };
}

test("openai default request shape", () => {
  const payload = buildModelRequest(config());
  assert.equal(payload.endpointPath, "/chat/completions");
  assert.deepEqual(payload.body, {
    model: "test-model",
    stream: false,
    messages: [
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "USER\n\nCORPUS" },
    ],
    max_tokens: 8192,
    temperature: 0.1,
  });
});

test("openai trailing_task shape puts the corpus first", () => {
  const payload = buildModelRequest(config({ shape: "trailing_task" }));
  const messages = payload.body as unknown as { messages: { content: string }[] };
  assert.equal(messages.messages[1]!.content, "CORPUS\n\nUSER");
});

test("empty temperature omits the field; set temperature is sent", () => {
  const omitted = buildModelRequest(config({ temperature: "" }));
  assert.equal("temperature" in (omitted.body as object), false);
  const explicit = buildModelRequest(config({ temperature: 0 }));
  assert.equal((explicit.body as unknown as { temperature: number }).temperature, 0);
});

test("max_completion_tokens replaces max_tokens wholesale", () => {
  const payload = buildModelRequest(config({ tokensParam: "max_completion_tokens" }));
  const body = payload.body as unknown as Record<string, unknown>;
  assert.equal(body.max_completion_tokens, 8192);
  assert.equal("max_tokens" in body, false);
});

test("response_format modes", () => {
  assert.equal("response_format" in (buildModelRequest(config()).body as object), false);
  assert.deepEqual(
    (buildModelRequest(config({ responseFormat: "json_object" })).body as { response_format: unknown }).response_format,
    { type: "json_object" },
  );
  const schemaPayload = buildModelRequest(config({ responseFormat: "json_schema" }));
  assert.deepEqual(
    (schemaPayload.body as { response_format: unknown }).response_format,
    OPENAI_VERDICT_JSON_SCHEMA,
  );
});

test("stream_options only attaches while streaming", () => {
  assert.equal("stream_options" in (buildModelRequest(config({ stream: false })).body as object), false);
  assert.deepEqual(
    (buildModelRequest(config({ stream: true })).body as { stream_options: unknown }).stream_options,
    { include_usage: true },
  );
});

test("anthropic request shape: max_tokens always, no response_format, no token-param switching", () => {
  const payload = buildModelRequest(config({
    apiFormat: "anthropic",
    tokensParam: "max_completion_tokens",
    responseFormat: "json_schema",
    stream: true,
  }));
  assert.equal(payload.endpointPath, "/messages");
  assert.deepEqual(payload.body, {
    model: "test-model",
    max_tokens: 8192,
    stream: true,
    system: "SYSTEM",
    messages: [{ role: "user", content: "USER\n\nCORPUS" }],
    temperature: 0.1,
  });
  const body = payload.body as unknown as Record<string, unknown>;
  assert.equal("response_format" in body, false);
  assert.equal("stream_options" in body, false);
});

test("anthropic omits temperature when empty and supports trailing_task", () => {
  const payload = buildModelRequest(config({
    apiFormat: "anthropic",
    temperature: "",
    shape: "trailing_task",
  }));
  const body = payload.body as unknown as Record<string, unknown>;
  assert.equal("temperature" in body, false);
  assert.equal((body.messages as { content: string }[])[0]!.content, "CORPUS\n\nUSER");
});

test("request construction is provider-neutral: no branching on model names", () => {
  // The same config with different model names produces identical structure.
  const a = buildModelRequest(config({ model: "gpt-9-mini" }));
  const b = buildModelRequest(config({ model: "qwen3-local@proxy" }));
  assert.deepEqual(
    { ...(a.body as object), model: undefined },
    { ...(b.body as object), model: undefined },
  );
});

test("the strict verdict schema matches the v2 bash literal byte for byte", () => {
  const shell = readFileSync("scripts/model_call.sh", "utf8");
  const match = shell.match(/rf_json='(\{"type":"json_schema".*?)' ;;/s);
  assert.ok(match, "json_schema rf_json literal not found in scripts/model_call.sh");
  const literal = JSON.parse(match[1]!) as unknown;
  assert.deepEqual(OPENAI_VERDICT_JSON_SCHEMA, literal);
});

test("the strict verdict schema requires every property (OpenAI strict mode)", () => {
  const schema = (OPENAI_VERDICT_JSON_SCHEMA.json_schema as unknown as Record<string, unknown>).schema as unknown as Record<string, unknown>;
  assert.deepEqual(
    schema.required,
    ["verdict", "review_markdown", "smart_review_requested", "smart_review_reason", "findings", "requirement_coverage"],
  );
  const properties = schema.properties as unknown as Record<string, { type: unknown }>;
  assert.deepEqual(properties.smart_review_requested!.type, "boolean");
  assert.deepEqual(properties.smart_review_reason!.type, ["string", "null"]);
  const findings = properties.findings! as unknown as { type: string[] };
  assert.deepEqual(findings.type, ["array", "null"]);
});
