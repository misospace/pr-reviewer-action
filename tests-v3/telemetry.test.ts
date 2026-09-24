import test from "node:test";
import assert from "node:assert/strict";
import { cacheHitRatio, normalizeUsageTelemetry } from "../src/model/telemetry.js";

test("openai usage with cached-token details (reasoning-model variants)", () => {
  const telemetry = normalizeUsageTelemetry({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 40 },
  });
  assert.deepEqual(telemetry, { promptTokens: 100, completionTokens: 20, cachedTokens: 40, totalTokens: 120 });
  assert.equal(cacheHitRatio(telemetry), 0.4);
});

test("anthropic usage field family with cache fallbacks", () => {
  assert.deepEqual(
    normalizeUsageTelemetry({ input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 25 }),
    { promptTokens: 50, completionTokens: 10, cachedTokens: 25, totalTokens: 60 },
  );
  assert.deepEqual(
    normalizeUsageTelemetry({ input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 5 }),
    { promptTokens: 50, completionTokens: 10, cachedTokens: 5, totalTokens: 60 },
  );
});

test("missing usage degrades to nulls, never throws", () => {
  assert.deepEqual(
    normalizeUsageTelemetry(undefined),
    { promptTokens: null, completionTokens: null, cachedTokens: null, totalTokens: null },
  );
  assert.deepEqual(
    normalizeUsageTelemetry("junk"),
    { promptTokens: null, completionTokens: null, cachedTokens: null, totalTokens: null },
  );
});

test("total is derived when absent; cache ratio is null without a usable prompt", () => {
  const telemetry = normalizeUsageTelemetry({ prompt_tokens: 8, completion_tokens: 2 });
  assert.equal(telemetry.totalTokens, 10);
  assert.equal(telemetry.cachedTokens, null);
  assert.equal(cacheHitRatio(telemetry), null);
  assert.equal(cacheHitRatio(normalizeUsageTelemetry({ prompt_tokens: 0, cache_read_input_tokens: 0 })), null);
});
