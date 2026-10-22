import test from "node:test";
import assert from "node:assert/strict";
import { cacheHitRatio, normalizeUsageTelemetry } from "../src/model/telemetry.js";

test("openai usage with cached-token details (reasoning-model variants)", () => {
  const telemetry = normalizeUsageTelemetry({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 40 },
  }, "openai");
  assert.deepEqual(telemetry, { promptTokens: 100, completionTokens: 20, cachedTokens: 40, totalTokens: 120 });
  assert.equal(cacheHitRatio(telemetry), 0.4);
});

test("anthropic usage field family: the cache tokens count in the prompt total", () => {
  // Anthropic reports the cache read/write tokens OUTSIDE input_tokens, so the
  // prompt total is uncached + cache read + cache write (#910) — the same
  // accounting the loop aggregate folds, so the persisted per-turn records sum
  // to it instead of under-reporting it.
  assert.deepEqual(
    normalizeUsageTelemetry({ input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 25 }, "anthropic"),
    { promptTokens: 75, completionTokens: 10, cachedTokens: 25, totalTokens: 85 },
  );
  // A cache WRITE is part of the prompt total but not a cache READ, so it is
  // not counted as a cached token (the aggregate counts reads only).
  assert.deepEqual(
    normalizeUsageTelemetry({ input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 5 }, "anthropic"),
    { promptTokens: 55, completionTokens: 10, cachedTokens: null, totalTokens: 65 },
  );
});

test("anthropic streamed turn reassembled into the OpenAI chat shape counts the same", () => {
  // A streamed Anthropic turn is reassembled into the OpenAI chat shape: the
  // uncached count arrives as prompt_tokens with the cache fields kept, and the
  // projected total_tokens EXCLUDES the cache tokens — so the total is derived
  // from the accounted prompt instead of trusting the projection.
  assert.deepEqual(
    normalizeUsageTelemetry({
      prompt_tokens: 500,
      completion_tokens: 40,
      total_tokens: 540,
      prompt_tokens_details: { cached_tokens: 300 },
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 200,
    }, "anthropic"),
    { promptTokens: 1000, completionTokens: 40, cachedTokens: 300, totalTokens: 1040 },
  );
  // The cached subset is a fraction of the accounted prompt, matching the
  // aggregate's cache_hit_ratio.
  assert.equal(
    cacheHitRatio(normalizeUsageTelemetry({
      prompt_tokens: 500,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 300 },
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 200,
    }, "anthropic")),
    0.3,
  );
});

test("a body reporting the other format's field names under the OpenAI format counts nothing", () => {
  // An Anthropic-shaped body under the OpenAI format is a misconfigured relay.
  // The OpenAI branch reads only the OpenAI names, so the record reports
  // "not reported" — exactly what the aggregate counts (nothing), keeping the
  // records and the aggregate in step.
  assert.deepEqual(
    normalizeUsageTelemetry({ input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 25 }, "openai"),
    { promptTokens: null, completionTokens: null, cachedTokens: null, totalTokens: null },
  );
});

test("junk token fields are never published as counts", () => {
  assert.deepEqual(
    normalizeUsageTelemetry({ prompt_tokens: true, completion_tokens: "", total_tokens: {} }, "openai"),
    { promptTokens: null, completionTokens: null, cachedTokens: null, totalTokens: null },
  );
  // A numeric string is a reported number (gateways have been known to send
  // those), so it counts — like the aggregate counts it.
  assert.deepEqual(
    normalizeUsageTelemetry({ prompt_tokens: "500", completion_tokens: 40 }, "openai"),
    { promptTokens: 500, completionTokens: 40, cachedTokens: null, totalTokens: 540 },
  );
});

test("missing usage degrades to nulls, never throws", () => {
  assert.deepEqual(
    normalizeUsageTelemetry(undefined, "openai"),
    { promptTokens: null, completionTokens: null, cachedTokens: null, totalTokens: null },
  );
  assert.deepEqual(
    normalizeUsageTelemetry("junk", "openai"),
    { promptTokens: null, completionTokens: null, cachedTokens: null, totalTokens: null },
  );
});

test("total is derived when absent; cache ratio is null without a usable prompt", () => {
  const telemetry = normalizeUsageTelemetry({ prompt_tokens: 8, completion_tokens: 2 }, "openai");
  assert.equal(telemetry.totalTokens, 10);
  assert.equal(telemetry.cachedTokens, null);
  assert.equal(cacheHitRatio(telemetry), null);
  assert.equal(cacheHitRatio(normalizeUsageTelemetry({ prompt_tokens: 0, cache_read_input_tokens: 0 }, "openai")), null);
});
