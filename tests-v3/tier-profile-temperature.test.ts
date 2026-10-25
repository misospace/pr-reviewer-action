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
