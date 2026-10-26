import test from "node:test";
import assert from "node:assert/strict";
import { tierProfileFrom } from "../src/engine/review.js";
import { resolveTierProfiles } from "../src/routing/tiers.js";
import type { StageEnv } from "../src/run/env.js";

// #1246 regression: `tierProfileFrom` built the profile temperature with
// `Number(temperatureRaw) || 0.1`, so an explicit `ai-temperature: "0"` — a
// valid value the contract and config loader accept — reached the wire as
// 0.1. Zero must survive on every tier; empty still omits the field.

function tierProfile(tier: "primary" | "fallback" | "smart", env: Record<string, string | undefined>) {
  return tierProfileFrom(resolveTierProfiles(env), tier, env as StageEnv);
}

test("#1246: an explicit ai-temperature of 0 reaches every tier profile unchanged", () => {
  for (const tier of ["primary", "fallback", "smart"] as const) {
    const profile = tierProfile(tier, { AI_TEMPERATURE: "0" });
    assert.equal(profile.temperature, 0, tier);
  }
});

test("#1246: an explicit ai-temperature of 0.0 is preserved, not defaulted", () => {
  const profile = tierProfile("primary", { AI_TEMPERATURE: "0.0" });
  assert.equal(profile.temperature, 0);
});

test("#1246: an empty ai-temperature still omits temperature from the profile", () => {
  for (const tier of ["primary", "fallback", "smart"] as const) {
    const profile = tierProfile(tier, { AI_TEMPERATURE: "" });
    assert.equal(profile.temperature, "", tier);
  }
});

test("#1246: an unset ai-temperature keeps the 0.1 contract default", () => {
  const profile = tierProfile("primary", {});
  assert.equal(profile.temperature, 0.1);
});

test("#1246: a non-finite ai-temperature falls back to 0.1 (config validation rejects it upstream)", () => {
  const profile = tierProfile("primary", { AI_TEMPERATURE: "not-a-number" });
  assert.equal(profile.temperature, 0.1);
});

// #1251: the AI_MAX_TOKENS raw-env default is the contract's (16384), not a
// second 8192 literal — one authoritative derivation, shared with the corpus
// budgets and the tool harness.
test("#1251: an unset ai-max-tokens resolves the 16384 contract default", () => {
  const profile = tierProfile("primary", {});
  assert.equal(profile.maxTokens, 16384);
});

test("#1251: an empty or garbage ai-max-tokens falls back to the contract default", () => {
  assert.equal(tierProfile("primary", { AI_MAX_TOKENS: "" }).maxTokens, 16384);
  assert.equal(tierProfile("primary", { AI_MAX_TOKENS: "not-a-number" }).maxTokens, 16384);
  assert.equal(tierProfile("fallback", { AI_MAX_TOKENS: "0" }).maxTokens, 16384);
});

test("#1251: an explicit ai-max-tokens reaches every tier profile unchanged", () => {
  for (const tier of ["primary", "fallback", "smart"] as const) {
    const profile = tierProfile(tier, { AI_MAX_TOKENS: "4096" });
    assert.equal(profile.maxTokens, 4096, tier);
  }
});

test("#1251: the fallback stream inherits ai-stream via the tier profile, not a second env read", () => {
  assert.equal(tierProfile("fallback", { AI_STREAM: "true" }).stream, true);
  assert.equal(tierProfile("fallback", { AI_STREAM: "true", AI_FALLBACK_STREAM: "false" }).stream, false);
  assert.equal(tierProfile("fallback", {}).stream, true, "unset ai-stream inherits its own true default");
  assert.equal(tierProfile("fallback", { AI_STREAM: "false" }).stream, false);
});

test("#1251: AI_MAX_TOKENS_DEFAULT equals the contract default for ai-max-tokens", async () => {
  const { AI_MAX_TOKENS_DEFAULT, contractInputDefault } = await import("../src/config/contract.js");
  assert.equal(AI_MAX_TOKENS_DEFAULT, 16384);
  assert.equal(Number(contractInputDefault("ai-max-tokens")), AI_MAX_TOKENS_DEFAULT);
});
