import test from "node:test";
import assert from "node:assert/strict";
import { isLowConfidence, reviewerRequestedEscalation } from "../src/routing/escalation.js";
import { anthropicEffortInactiveWarning, anthropicEffortSupported, anthropicEffortSupportInput, anthropicJsonObjectsPromptOnlyWarning, anthropicStructuredOutputInactiveWarning, anthropicStructuredOutputSupportInput, effectiveWireEffort, effectiveWireResponseFormat, laneAnthropicEffortSupported, laneAnthropicStructuredOutputSupported, normalizeReasoningEffort, resolveConfidenceProfile, resolveReviewRoute, resolveSpecialistProfiles, resolveTierProfiles, tierReasoningEffort, tierRequestShape, tierResponseFormat } from "../src/routing/tiers.js";

const longReview = "The change is reviewed carefully and the behavior appears correct. No concerns identified in the touched paths.";

test("reviewer request requires strict boolean true and retains only nonblank reason", () => {
  for (const value of [false, 1, "true", "requested", null]) {
    assert.deepEqual(reviewerRequestedEscalation({ smart_review_requested: value, smart_review_reason: "why" }), { requested: false, reason: null });
  }
  assert.deepEqual(reviewerRequestedEscalation({ smart_review_requested: true, smart_review_reason: "  " }), { requested: true, reason: null });
  assert.deepEqual(reviewerRequestedEscalation({ smart_review_requested: true, smart_review_reason: "  check edge cases  " }), { requested: true, reason: "  check edge cases  " });
  assert.deepEqual(reviewerRequestedEscalation({}), { requested: false, reason: null });
  assert.deepEqual(reviewerRequestedEscalation(null as unknown as Record<string, unknown>), { requested: false, reason: null });
});

test("isLowConfidence detects stubs and substantive Unknowns but not environmental-only uncertainty", () => {
  assert.equal(isLowConfidence("LGTM."), true);
  assert.equal(isLowConfidence(`${longReview}\n\n## Unknowns\n
There may be a correctness regression in a state transition here.`), true);
  assert.equal(isLowConfidence(`${longReview}\n\n## Unknowns\n
CI test suite results and tool output are unavailable in this environment.`), false);
  assert.equal(isLowConfidence(longReview), false);
  assert.equal(isLowConfidence(`${longReview}\n\n## Unknowns\n
Could not determine behavior.`), false, "Unknowns content at or below the 40-character floor is ignored");
});

test("resolveReviewRoute always starts auto routing on the primary profile", () => {
  assert.deepEqual(resolveReviewRoute({ routingMode: "off" }), { route: "legacy", reason: "routing off" });
  const auto = { route: "primary", reason: "primary-first: the primary reviews first; smart is reviewer-requested only (#721)" };
  for (const routingMode of ["auto", "AUTO", " auto "]) {
    assert.deepEqual(resolveReviewRoute({ routingMode }), auto);
  }
});

test("specialist profiles resolve role, profile, and primary model precedence", () => {
  const resolved = resolveSpecialistProfiles({
    AI_BASE_URL: " https://primary ", AI_MODEL: " primary-model ", AI_API_KEY: " primary-key ",
    AI_SPECIALIST_MODEL: " specialist-model ", AI_SPECIALIST_BASE_URL: " https://specialist ",
    AI_SPECIALIST_API_FORMAT: " ANTHROPIC ", AI_SPECIALIST_API_KEY: " specialist-key ",
    AI_SPECIALIST_CORRECTNESS_MODEL: " correctness-model ", AI_SPECIALIST_TESTS_MODEL: "  ",
  });
  assert.equal(resolved.profileActive, true);
  assert.deepEqual(resolved.transport, {
    baseUrl: "https://specialist",
    model: "specialist-model",
    apiFormat: "anthropic",
    apiKey: "specialist-key",
    // #998: unset in this fixture, so nothing is emitted.
    reasoningEffort: "",
    anthropicEffortSupported: false,
  });
  assert.deepEqual(resolved.roleModels, {
    correctness: { model: "correctness-model", source: "role-override" },
    security: { model: "specialist-model", source: "specialist-profile" },
    tests: { model: "specialist-model", source: "specialist-profile" },
  });
  assert.equal(resolved.overridesActive, true);
  assert.deepEqual(resolved.warnings, []);

  const primary = resolveSpecialistProfiles({ AI_BASE_URL: " primary-url ", AI_MODEL: " primary-model ", AI_API_FORMAT: " OpenAI ", AI_API_KEY: " key ", AI_SPECIALIST_SECURITY_MODEL: " security-model " });
  assert.equal(primary.profileActive, false);
  assert.deepEqual(primary.transport, {
    baseUrl: "primary-url",
    model: "primary-model",
    apiFormat: "openai",
    apiKey: "key",
    reasoningEffort: "",
    anthropicEffortSupported: false,
  });
  assert.deepEqual(primary.roleModels, {
    correctness: { model: "primary-model", source: "primary" },
    security: { model: "security-model", source: "role-override" },
    tests: { model: "primary-model", source: "primary" },
  });
  assert.equal(primary.overridesActive, true);
});

test("specialist profiles reject invalid formats and report orphan transport fields", () => {
  const invalid = resolveSpecialistProfiles({
    AI_MODEL: "primary", AI_SPECIALIST_MODEL: "specialist", AI_SPECIALIST_API_FORMAT: "bogus",
    AI_SPECIALIST_CORRECTNESS_MODEL: " role-model ",
  });
  assert.equal(invalid.profileActive, false);
  assert.deepEqual(invalid.transport, {
    baseUrl: "",
    model: "primary",
    apiFormat: "openai",
    apiKey: "",
    reasoningEffort: "",
    anthropicEffortSupported: false,
  });
  assert.equal(invalid.roleModels.correctness.model, "role-model");
  assert.equal(invalid.roleModels.correctness.source, "role-override");
  assert.deepEqual(invalid.warnings, ["specialist profile ignored: AI_SPECIALIST_API_FORMAT must be openai or anthropic"]);

  const orphan = resolveSpecialistProfiles({
    AI_MODEL: "primary", AI_SPECIALIST_BASE_URL: " url ", AI_SPECIALIST_API_KEY: " secret ",
  });
  assert.equal(orphan.profileActive, false);
  assert.equal(orphan.overridesActive, false);
  assert.deepEqual(orphan.warnings, ["specialist profile ignored: ai-specialist-base-url/ai-specialist-api-key set without ai-specialist-model"]);
  assert.deepEqual(Object.keys(orphan.roleModels), ["correctness", "security", "tests"]);
});

test("tier profiles bind model defaults, retry/stream settings, and request shapes", () => {
  const base = resolveTierProfiles({ AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_API_KEY: "k" });
  assert.deepEqual(base.primary, { baseUrl: "https://primary", model: "main", apiFormat: "openai", apiKey: "k", resolved: true, retries: 8, retryDelaySec: 15, stream: true, requestTimeoutSec: 300, connectTimeoutSec: 30, responseFormat: "off", reasoningEffort: "", anthropicEffortSupported: false, anthropicStructuredOutputSupported: false });
  assert.equal(base.smart.resolved, false);
  assert.equal(base.smart.baseUrl, "https://primary");
  assert.equal(base.smart.apiKey, "k");
  assert.equal(base.smart.responseFormat, "off");
  assert.equal(base.fallback.resolved, false);
  assert.equal(base.fallback.responseFormat, "off");
  const configured = resolveTierProfiles({ AI_BASE_URL: "p", AI_MODEL: "m", AI_SMART_MODEL: "s", AI_SMART_API_FORMAT: "anthropic", AI_FALLBACK_BASE_URL: "f", AI_FALLBACK_MODEL: "fm", AI_STREAM: "true" });
  assert.equal(configured.smart.resolved, true);
  assert.equal(configured.smart.apiFormat, "anthropic");
  assert.equal(configured.fallback.resolved, true);
  // #1251: raw-env parity with the config loader — unset ai-fallback-stream
  // inherits ai-stream ("${AI_FALLBACK_STREAM:-$AI_STREAM}" in v2 config.sh).
  assert.equal(configured.fallback.stream, true);
  assert.equal(resolveTierProfiles({ AI_BASE_URL: "p", AI_MODEL: "m", AI_FALLBACK_BASE_URL: "f", AI_FALLBACK_MODEL: "fm", AI_STREAM: "true", AI_FALLBACK_STREAM: "false" }).fallback.stream, false);
  assert.equal(resolveTierProfiles({ AI_BASE_URL: "p", AI_MODEL: "m", AI_FALLBACK_BASE_URL: "f", AI_FALLBACK_MODEL: "fm" }).fallback.stream, true, "unset ai-stream inherits its own true default");
  assert.equal(configured.fallback.retries, 2);
  assert.equal(configured.smart.retries, 2);
  assert.equal(tierRequestShape("primary", { PRIMARY_REQUEST_SHAPE: "trailing_task" }), "trailing_task");
  // #1253: the profile argument decides; a stray REVIEW_CONTEXT_PROFILE env
  // value never flips the request shape.
  assert.equal(tierRequestShape("primary", { PRIMARY_REQUEST_SHAPE: "trailing_task", SMART_REQUEST_SHAPE: "default", REVIEW_CONTEXT_PROFILE: "smart" }), "trailing_task");
  assert.equal(tierRequestShape("smart", { SMART_REQUEST_SHAPE: "trailing_task" }), "trailing_task");
  assert.equal(tierRequestShape("fallback", { SMART_REQUEST_SHAPE: "trailing_task" }), "default");
  assert.equal(tierRequestShape("smart", { SMART_REQUEST_SHAPE: "unknown" }), "default");
});

test("#1251: the fallback lane's raw-env inheritance mirrors the config loader's resolveInherited", () => {
  // Only base inputs: the fallback endpoint (url/format/key) and stream
  // inherit the base, but the base model never becomes the fallback model,
  // so the lane stays unresolved until ai-fallback-model is configured.
  const base = resolveTierProfiles({ AI_BASE_URL: "https://b", AI_API_FORMAT: "anthropic", AI_API_KEY: "k", AI_MODEL: "m", AI_STREAM: "true" });
  assert.equal(base.fallback.baseUrl, "https://b");
  assert.equal(base.fallback.apiFormat, "anthropic");
  assert.equal(base.fallback.apiKey, "k");
  assert.equal(base.fallback.stream, true);
  assert.equal(base.fallback.model, "");
  assert.equal(base.fallback.resolved, false);
  // Explicit fallback values win over the base; an empty-string override
  // counts as unset and inherits, like `inherit()` in load-config.ts.
  const explicit = resolveTierProfiles({ AI_BASE_URL: "https://b", AI_API_KEY: "k", AI_FALLBACK_BASE_URL: "https://f", AI_FALLBACK_API_KEY: "fk", AI_FALLBACK_MODEL: "fm" });
  assert.equal(explicit.fallback.baseUrl, "https://f");
  assert.equal(explicit.fallback.apiKey, "fk");
  assert.equal(explicit.fallback.resolved, true);
  assert.equal(resolveTierProfiles({ AI_BASE_URL: "https://b", AI_API_KEY: "k", AI_FALLBACK_BASE_URL: "", AI_FALLBACK_MODEL: "fm" }).fallback.baseUrl, "https://b");
});

test("#1009: tierResponseFormat inherits the base setting when the lane override is empty", () => {
  // Empty lane overrides do not coerce off; they inherit the base setting
  // (`ai-response-format`), so existing single-value workflows stay
  // request-byte compatible.
  assert.equal(tierResponseFormat("primary", { AI_RESPONSE_FORMAT: "off" }), "off");
  assert.equal(tierResponseFormat("smart", { AI_RESPONSE_FORMAT: "off" }), "off");
  assert.equal(tierResponseFormat("fallback", { AI_RESPONSE_FORMAT: "off" }), "off");
  assert.equal(tierResponseFormat("primary", { AI_RESPONSE_FORMAT: "json_object" }), "json_object");
  assert.equal(tierResponseFormat("smart", { AI_RESPONSE_FORMAT: "json_object" }), "json_object");
  assert.equal(tierResponseFormat("fallback", { AI_RESPONSE_FORMAT: "json_object" }), "json_object");
  assert.equal(tierResponseFormat("primary", { AI_RESPONSE_FORMAT: "json_schema" }), "json_schema");
});

test("#1009: tierResponseFormat honors per-lane overrides independently of each other", () => {
  // Primary lane turned off (a primary model that rejects response_format),
  // smart lane uses the richer json_schema, fallback lane keeps the global
  // json_object default. None of these settings affect the Anthropic
  // transport, which still ignores the value at request time.
  const env = {
    AI_RESPONSE_FORMAT: "json_object",
    AI_PRIMARY_RESPONSE_FORMAT: "off",
    AI_SMART_RESPONSE_FORMAT: "json_schema",
    AI_FALLBACK_RESPONSE_FORMAT: "json_object",
  };
  assert.equal(tierResponseFormat("primary", env), "off");
  assert.equal(tierResponseFormat("smart", env), "json_schema");
  assert.equal(tierResponseFormat("fallback", env), "json_object");
});

test("#1009: tierResponseFormat treats unset AI_RESPONSE_FORMAT as off and ignores unknown values silently", () => {
  assert.equal(tierResponseFormat("primary", {}), "off");
  assert.equal(tierResponseFormat("primary", { AI_RESPONSE_FORMAT: "" }), "off");
  // The contract's enum validation rejects unknown values for user-supplied
  // inputs, but values can reach here from ambient overrides or test rigs;
  // the helper must not crash a live review.
  assert.equal(tierResponseFormat("primary", { AI_RESPONSE_FORMAT: "unknown", AI_PRIMARY_RESPONSE_FORMAT: "also-unknown" }), "off");
  assert.equal(tierResponseFormat("primary", { AI_PRIMARY_RESPONSE_FORMAT: "json_object" }), "json_object");
  assert.equal(tierResponseFormat("smart", { AI_PRIMARY_RESPONSE_FORMAT: "json_object", AI_SMART_RESPONSE_FORMAT: "" }), "off");
});

test("#1009: resolveTierProfiles threads the effective responseFormat through every tier", () => {
  // The helper is the single source for the value the request builder reads
  // for OpenAI-compatible lanes — Anthropic lanes still drop the field at
  // request build time regardless of value (#1009 acceptance).
  const profiles = resolveTierProfiles({
    AI_BASE_URL: "https://primary",
    AI_MODEL: "main",
    AI_API_KEY: "k",
    AI_SMART_MODEL: "s",
    AI_FALLBACK_BASE_URL: "https://fb",
    AI_FALLBACK_MODEL: "fb",
    AI_FALLBACK_API_KEY: "fb-key",
    AI_PRIMARY_RESPONSE_FORMAT: "off",
    AI_SMART_RESPONSE_FORMAT: "json_schema",
    AI_FALLBACK_RESPONSE_FORMAT: "json_object",
  });
  assert.equal(profiles.primary.responseFormat, "off");
  assert.equal(profiles.smart.responseFormat, "json_schema");
  assert.equal(profiles.fallback.responseFormat, "json_object");
});

// ── #998: profile-aware reasoning effort ────────────────────────────────

test("#998: tierReasoningEffort inherits the base when the lane override is empty", () => {
  // Same inheritance contract as the response_format family: an unset lane
  // override follows `ai-reasoning-effort`, so a single-value workflow stays
  // request-byte compatible.
  assert.equal(tierReasoningEffort("primary", { AI_REASONING_EFFORT: "high" }), "high");
  assert.equal(tierReasoningEffort("smart", { AI_REASONING_EFFORT: "high" }), "high");
  assert.equal(tierReasoningEffort("fallback", { AI_REASONING_EFFORT: "high" }), "high");
  // Unset everywhere resolves to "" (omit the field), never a default value.
  assert.equal(tierReasoningEffort("primary", {}), "");
  assert.equal(tierReasoningEffort("smart", { AI_REASONING_EFFORT: "" }), "");
  assert.equal(tierReasoningEffort("primary", { AI_REASONING_EFFORT: "   " }), "");
  // Values are passed through verbatim after trim+lowercase; no vocabulary is
  // imposed or clamped, so a provider-specific token survives intact.
  assert.equal(tierReasoningEffort("primary", { AI_REASONING_EFFORT: "  HIGH  " }), "high");
  assert.equal(tierReasoningEffort("primary", { AI_REASONING_EFFORT: "xhigh-ultra" }), "xhigh-ultra");
  assert.equal(tierReasoningEffort("primary", { AI_REASONING_EFFORT: "effort_2" }), "effort_2");
  assert.equal(normalizeReasoningEffort("xhigh-ultra"), "xhigh-ultra");
  assert.equal(normalizeReasoningEffort(undefined), null);
});

test("#998/#1053: tierReasoningEffort honors per-lane overrides independently; the fallback lane now has its own", () => {
  const env = {
    AI_REASONING_EFFORT: "low",
    AI_PRIMARY_REASONING_EFFORT: "high",
    AI_SMART_REASONING_EFFORT: "xhigh",
  };
  assert.equal(tierReasoningEffort("primary", env), "high");
  assert.equal(tierReasoningEffort("smart", env), "xhigh");
  // Fallback is availability recovery, never quality escalation (#965) — but
  // it now has its own override key (#1053). An empty fallback override still
  // inherits the base, so a build without the feature stays request-byte
  // compatible.
  assert.equal(tierReasoningEffort("fallback", env), "low");
  assert.equal(tierReasoningEffort("fallback", { ...env, AI_FALLBACK_REASONING_EFFORT: "" }), "low");
  // A configured fallback override wins over the base effort, mirroring the
  // primary/smart lane behaviour.
  assert.equal(tierReasoningEffort("fallback", { ...env, AI_FALLBACK_REASONING_EFFORT: "medium" }), "medium");
  // The fallback lane does NOT inherit any other lane's override (its own
  // override is empty here, so it sees the base "low", not primary's "high").
  assert.equal(tierReasoningEffort("fallback", { ...env, AI_FALLBACK_REASONING_EFFORT: "" }), "low");
  // A malformed fallback value is announced by key and behaves as empty
  // (inheriting the base, never crashing and never clamped).
  const warnings: string[] = [];
  const capture = (warning: string): void => { warnings.push(warning); };
  assert.equal(
    tierReasoningEffort("fallback", { ...env, AI_FALLBACK_REASONING_EFFORT: "-bad" }, capture),
    "low",
    "dropped fallback value inherits the base",
  );
  assert.ok(
    warnings.some((warning) => warning.includes("AI_FALLBACK_REASONING_EFFORT")),
    `AI_FALLBACK_REASONING_EFFORT is announced by key: ${warnings.join(" | ")}`,
  );
});

test("#998: a malformed effort is dropped as unset and announced, never clamped and never fatal", () => {
  // Values reach this layer from ambient env overrides and eval-harness rigs
  // that never passed through `loadConfig`, so the shape check repeats here.
  const warnings: string[] = [];
  const capture = (warning: string): void => { warnings.push(warning); };
  // #252: feed the boundary its own adversarial values (quote, newline,
  // leading dash, over-long, leading digit, inner space).
  for (const bad of ['high"', "high\nreasoning_effort: \"low\"", "-high", "a".repeat(33), "9lives", "high high", "high;drop"]) {
    assert.equal(tierReasoningEffort("primary", { AI_REASONING_EFFORT: bad }, capture), "", JSON.stringify(bad));
    assert.equal(tierReasoningEffort("smart", { AI_REASONING_EFFORT: "high", AI_SMART_REASONING_EFFORT: bad }, capture), "high", JSON.stringify(bad));
  }
  assert.equal(warnings.length > 0, true, "a dropped value is never silent");
  for (const warning of warnings) {
    assert.match(warning, /AI_(REASONING_EFFORT|PRIMARY_REASONING_EFFORT|SMART_REASONING_EFFORT) ignored/);
  }
  // Without a collector the drop is still loud: it goes out as a process
  // warning rather than crashing the review.
  assert.doesNotThrow(() => tierReasoningEffort("primary", { AI_REASONING_EFFORT: "-bad" }));
});

test("#998/#1053: resolveTierProfiles threads the effective reasoningEffort through every tier", () => {
  const profiles = resolveTierProfiles({
    AI_BASE_URL: "https://primary",
    AI_MODEL: "main",
    AI_SMART_MODEL: "s",
    AI_FALLBACK_BASE_URL: "https://fb",
    AI_FALLBACK_MODEL: "fb",
    AI_REASONING_EFFORT: "low",
    AI_PRIMARY_REASONING_EFFORT: "high",
    AI_SMART_REASONING_EFFORT: "xhigh",
    AI_FALLBACK_REASONING_EFFORT: "medium",
  });
  assert.equal(profiles.primary.reasoningEffort, "high");
  assert.equal(profiles.smart.reasoningEffort, "xhigh");
  assert.equal(profiles.fallback.reasoningEffort, "medium");
  assert.equal(resolveTierProfiles({ AI_BASE_URL: "p", AI_MODEL: "m" }).primary.reasoningEffort, "");
  // #1053: an explicit fallback override takes effect through the thread;
  // an empty/unset fallback override preserves #998 byte compatibility.
  const fallbackOwn = resolveTierProfiles({
    AI_BASE_URL: "https://primary",
    AI_MODEL: "main",
    AI_FALLBACK_BASE_URL: "https://fb",
    AI_FALLBACK_MODEL: "fb",
    AI_REASONING_EFFORT: "low",
    AI_FALLBACK_REASONING_EFFORT: "high",
  });
  assert.equal(fallbackOwn.fallback.reasoningEffort, "high");
  const fallbackEmpty = resolveTierProfiles({
    AI_BASE_URL: "https://primary",
    AI_MODEL: "main",
    AI_FALLBACK_BASE_URL: "https://fb",
    AI_FALLBACK_MODEL: "fb",
    AI_REASONING_EFFORT: "low",
  });
  assert.equal(fallbackEmpty.fallback.reasoningEffort, "low");
});

test("#998: the specialist lane inherits the primary resolved effort and reports a malformed one as a warning", () => {
  const base = { AI_MODEL: "primary", AI_SPECIALIST_MODEL: "specialist" };
  assert.equal(resolveSpecialistProfiles(base).transport.reasoningEffort, "");
  assert.equal(resolveSpecialistProfiles({ ...base, AI_REASONING_EFFORT: "high" }).transport.reasoningEffort, "high");
  assert.equal(
    resolveSpecialistProfiles({ ...base, AI_REASONING_EFFORT: "low", AI_PRIMARY_REASONING_EFFORT: "high" }).transport.reasoningEffort,
    "high",
  );
  assert.equal(
    resolveSpecialistProfiles({ ...base, AI_REASONING_EFFORT: "high", AI_SPECIALIST_REASONING_EFFORT: "minimal" }).transport.reasoningEffort,
    "minimal",
  );
  // #252: a hostile value is reported through the profiles' warnings channel
  // (the specialist phase prints them) and never reaches the transport.
  const rejected = resolveSpecialistProfiles({ ...base, AI_SPECIALIST_REASONING_EFFORT: "minimal\"}\n{\"format\": {}" });
  assert.equal(rejected.transport.reasoningEffort, "");
  assert.ok(rejected.warnings.some((warning) => warning.includes("AI_SPECIALIST_REASONING_EFFORT")), rejected.warnings.join(" | "));
  assert.equal(rejected.warnings.some((warning) => warning.includes("format")), false, "the rejected value is never echoed");
  // A malformed primary value is reported on the same channel and the
  // specialist lane then falls back to nothing (no inherited base either).
  const badPrimary = resolveSpecialistProfiles({ ...base, AI_REASONING_EFFORT: "high", AI_PRIMARY_REASONING_EFFORT: "-nope" });
  assert.equal(badPrimary.transport.reasoningEffort, "high", "a dropped lane value behaves as unset and inherits the base");
  assert.ok(badPrimary.warnings.some((warning) => warning.includes("AI_PRIMARY_REASONING_EFFORT")));
});

test("#998: the Anthropic output_config.effort opt-in accepts only the literal true", () => {
  assert.equal(anthropicEffortSupported({}), false);
  assert.equal(anthropicEffortSupported({ AI_ANTHROPIC_EFFORT_SUPPORT: "" }), false);
  assert.equal(anthropicEffortSupported({ AI_ANTHROPIC_EFFORT_SUPPORT: "false" }), false);
  assert.equal(anthropicEffortSupported({ AI_ANTHROPIC_EFFORT_SUPPORT: "yes" }), false);
  assert.equal(anthropicEffortSupported({ AI_ANTHROPIC_EFFORT_SUPPORT: "1" }), false);
  for (const value of ["true", "TRUE", " true "]) {
    assert.equal(anthropicEffortSupported({ AI_ANTHROPIC_EFFORT_SUPPORT: value }), true, value);
  }
  // #1049 review: the assertion is per-lane. The base flag scopes the
  // base/primary/fallback lanes; the specialist lane asserts its own endpoint
  // and never inherits it.
  assert.equal(resolveSpecialistProfiles({ AI_MODEL: "m", AI_ANTHROPIC_EFFORT_SUPPORT: "true" }).transport.anthropicEffortSupported, false);
  assert.equal(resolveSpecialistProfiles({ AI_MODEL: "m", AI_SPECIALIST_ANTHROPIC_EFFORT_SUPPORT: "true" }).transport.anthropicEffortSupported, true);
  assert.equal(resolveSpecialistProfiles({ AI_MODEL: "m" }).transport.anthropicEffortSupported, false);
});

test("#998 (#1049 review): the Anthropic effort opt-in never crosses lanes", () => {
  // A heterogeneous configuration: MiniMax Anthropic on the primary route, a
  // different Anthropic-compatible backend on the smart route. Asserting the
  // primary endpoint must not enable `output_config.effort` on the smart one.
  const baseEnv = {
    AI_API_FORMAT: "anthropic",
    AI_MODEL: "minimax",
    AI_SMART_MODEL: "other-anthropic",
    AI_SMART_API_FORMAT: "anthropic",
    AI_SMART_BASE_URL: "https://other.example",
    AI_REASONING_EFFORT: "medium",
  };
  assert.equal(laneAnthropicEffortSupported("primary", {}), false);
  assert.equal(laneAnthropicEffortSupported("smart", { AI_ANTHROPIC_EFFORT_SUPPORT: "true" }), false);
  assert.equal(laneAnthropicEffortSupported("smart", { AI_SMART_ANTHROPIC_EFFORT_SUPPORT: "true" }), true);
  // Only the literal "true" counts, same as the base flag.
  for (const value of ["", "false", "yes", "1", "True-ish"]) {
    assert.equal(laneAnthropicEffortSupported("smart", { AI_SMART_ANTHROPIC_EFFORT_SUPPORT: value }), false, value);
  }
  const profiles = resolveTierProfiles({ ...baseEnv, AI_ANTHROPIC_EFFORT_SUPPORT: "true" });
  assert.equal(profiles.primary.anthropicEffortSupported, true);
  // The fallback lane runs on its own ai-fallback-base-url, so it asserts its
  // own endpoint even though it inherits the base effort.
  assert.equal(profiles.fallback.anthropicEffortSupported, false);
  assert.equal(profiles.smart.anthropicEffortSupported, false);
  const smartAsserted = resolveTierProfiles({ ...baseEnv, AI_SMART_ANTHROPIC_EFFORT_SUPPORT: "true" });
  assert.equal(smartAsserted.smart.anthropicEffortSupported, true);
  assert.equal(smartAsserted.primary.anthropicEffortSupported, false);
  const fallbackAsserted = resolveTierProfiles({ ...baseEnv, AI_FALLBACK_ANTHROPIC_EFFORT_SUPPORT: "true" });
  assert.equal(fallbackAsserted.fallback.anthropicEffortSupported, true);
  assert.equal(fallbackAsserted.primary.anthropicEffortSupported, false);
  for (const value of ["", "false", "yes", "1"]) {
    assert.equal(laneAnthropicEffortSupported("fallback", { AI_FALLBACK_ANTHROPIC_EFFORT_SUPPORT: value, AI_ANTHROPIC_EFFORT_SUPPORT: "true" }), false, value);
  }
});

test("#998 (#1049 review): the wire effort a log may report is what was actually sent", () => {
  // Anthropic without the opt-in sends nothing, so a log must never claim the
  // configured value was applied.
  assert.equal(effectiveWireEffort("anthropic", "medium", false), "");
  assert.equal(effectiveWireEffort("anthropic", "medium", true), "medium");
  // OpenAI is unaffected by the Anthropic assertion.
  assert.equal(effectiveWireEffort("openai", "medium", false), "medium");
  assert.equal(effectiveWireEffort("openai", "", true), "");
});

test("#998 (#1049 review): a configured-but-inactive Anthropic effort is named, never silent", () => {
  const specialist = resolveSpecialistProfiles({
    AI_MODEL: "primary",
    AI_SPECIALIST_MODEL: "specialist",
    AI_SPECIALIST_API_FORMAT: "anthropic",
    AI_SPECIALIST_REASONING_EFFORT: "medium",
  });
  assert.equal(specialist.transport.anthropicEffortSupported, false);
  assert.ok(
    specialist.warnings.some((warning) =>
      warning.includes("specialist") && warning.includes("medium") && warning.includes("ai-specialist-anthropic-effort-support")),
    specialist.warnings.join(" | "),
  );
  // Asserting the endpoint silences it; the field is then actually sent.
  const asserted = resolveSpecialistProfiles({
    AI_MODEL: "primary",
    AI_SPECIALIST_MODEL: "specialist",
    AI_SPECIALIST_API_FORMAT: "anthropic",
    AI_SPECIALIST_REASONING_EFFORT: "medium",
    AI_SPECIALIST_ANTHROPIC_EFFORT_SUPPORT: "true",
  });
  assert.equal(asserted.transport.anthropicEffortSupported, true);
  assert.equal(asserted.warnings.length, 0, asserted.warnings.join(" | "));
  // An OpenAI specialist with an effort is the normal case: never a warning.
  const openai = resolveSpecialistProfiles({
    AI_MODEL: "primary",
    AI_SPECIALIST_MODEL: "specialist",
    AI_SPECIALIST_REASONING_EFFORT: "medium",
  });
  assert.equal(openai.warnings.length, 0, openai.warnings.join(" | "));
  // No effort configured at all stays completely quiet.
  const quiet = resolveSpecialistProfiles({
    AI_MODEL: "primary",
    AI_SPECIALIST_MODEL: "specialist",
    AI_SPECIALIST_API_FORMAT: "anthropic",
  });
  assert.equal(quiet.warnings.length, 0, quiet.warnings.join(" | "));
  // The warning names the lane's own input, never a secret and never another
  // lane's flag.
  const warning = anthropicEffortInactiveWarning("smart", "medium");
  assert.match(warning, /ai-smart-anthropic-effort-support/);
  assert.equal(warning.includes("medium"), true);
  assert.equal(anthropicEffortSupportInput("primary"), "ai-anthropic-effort-support");
  assert.equal(anthropicEffortSupportInput("fallback"), "ai-fallback-anthropic-effort-support");
  assert.equal(anthropicEffortSupportInput("specialist"), "ai-specialist-anthropic-effort-support");
});

// ── #1047: Anthropic-native structured output resolution ────────────────

test("#1047: the Anthropic structured-output opt-in accepts only the literal true, per lane", () => {
  assert.equal(laneAnthropicStructuredOutputSupported("primary", {}), false);
  assert.equal(laneAnthropicStructuredOutputSupported("primary", { AI_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT: "false" }), false);
  for (const value of ["true", "TRUE", " true "]) {
    assert.equal(laneAnthropicStructuredOutputSupported("primary", { AI_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT: value }), true, value);
  }
  // No cross-lane inheritance: each lane asserts its own endpoint.
  assert.equal(laneAnthropicStructuredOutputSupported("smart", { AI_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT: "true" }), false);
  assert.equal(laneAnthropicStructuredOutputSupported("smart", { AI_SMART_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT: "true" }), true);
  assert.equal(laneAnthropicStructuredOutputSupported("fallback", { AI_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT: "true" }), false);
  assert.equal(laneAnthropicStructuredOutputSupported("fallback", { AI_FALLBACK_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT: "true" }), true);
  for (const value of ["", "false", "yes", "1", "True-ish"]) {
    assert.equal(laneAnthropicStructuredOutputSupported("smart", { AI_SMART_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT: value }), false, value);
    assert.equal(laneAnthropicStructuredOutputSupported("fallback", { AI_FALLBACK_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT: value, AI_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT: "true" }), false, value);
  }
  const baseEnv = {
    AI_API_FORMAT: "anthropic",
    AI_MODEL: "minimax",
    AI_SMART_MODEL: "other-anthropic",
    AI_SMART_API_FORMAT: "anthropic",
    AI_SMART_BASE_URL: "https://other.example",
    AI_RESPONSE_FORMAT: "json_schema",
  };
  const profiles = resolveTierProfiles({ ...baseEnv, AI_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT: "true" });
  assert.equal(profiles.primary.anthropicStructuredOutputSupported, true);
  assert.equal(profiles.smart.anthropicStructuredOutputSupported, false);
  assert.equal(profiles.fallback.anthropicStructuredOutputSupported, false);
  const smartAsserted = resolveTierProfiles({ ...baseEnv, AI_SMART_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT: "true" });
  assert.equal(smartAsserted.smart.anthropicStructuredOutputSupported, true);
  assert.equal(smartAsserted.primary.anthropicStructuredOutputSupported, false);
});

test("#1047: the wire response_format a log may report is what was actually enforced", () => {
  // Anthropic without the opt-in enforces nothing — json_object can never be
  // enforced there at all.
  assert.equal(effectiveWireResponseFormat("anthropic", "json_schema", false), "off");
  assert.equal(effectiveWireResponseFormat("anthropic", "json_object", true), "off");
  assert.equal(effectiveWireResponseFormat("anthropic", "json_schema", true), "json_schema");
  assert.equal(effectiveWireResponseFormat("anthropic", "off", true), "off");
  // OpenAI is unaffected by the Anthropic assertion.
  assert.equal(effectiveWireResponseFormat("openai", "json_schema", false), "json_schema");
  assert.equal(effectiveWireResponseFormat("openai", "json_object", false), "json_object");
  assert.equal(effectiveWireResponseFormat("openai", "off", true), "off");
});

test("#1047: the warnings name the lane and the exact input that turns enforcement on", () => {
  const schemaWarning = anthropicStructuredOutputInactiveWarning("primary", " (review call)");
  assert.match(schemaWarning, /primary lane \(review call\)/);
  assert.match(schemaWarning, /json_schema/);
  assert.match(schemaWarning, /ai-anthropic-structured-output-support/);
  assert.match(anthropicStructuredOutputInactiveWarning("fallback"), /ai-fallback-anthropic-structured-output-support/);
  assert.match(anthropicStructuredOutputInactiveWarning("smart"), /ai-smart-anthropic-structured-output-support/);
  const objectWarning = anthropicJsonObjectsPromptOnlyWarning("primary", "json_object");
  assert.match(objectWarning, /json_object/);
  assert.match(objectWarning, /no Anthropic-native equivalent/);
  assert.match(objectWarning, /ai-anthropic-structured-output-support/);
  // The specialist lane has no opt-in input (its contracts are not the
  // verdict schema), so its warning must not name an input that would do
  // nothing.
  const specialistWarning = anthropicJsonObjectsPromptOnlyWarning("specialist", "json_schema");
  assert.match(specialistWarning, /specialist/);
  assert.equal(specialistWarning.includes("-support"), false, specialistWarning);
  assert.equal(anthropicStructuredOutputSupportInput("primary"), "ai-anthropic-structured-output-support");
  assert.equal(anthropicStructuredOutputSupportInput("smart"), "ai-smart-anthropic-structured-output-support");
  assert.equal(anthropicStructuredOutputSupportInput("fallback"), "ai-fallback-anthropic-structured-output-support");
});

test("#1073: confidence profile inherits the primary lane when ai-confidence-base-url is empty", () => {
  const resolved = resolveConfidenceProfile({
    AI_BASE_URL: " https://primary ", AI_MODEL: " main-model ", AI_API_FORMAT: " Anthropic ", AI_API_KEY: " primary-key ",
    AI_PRIMARY_BASE_URL: " https://primary-route ", AI_PRIMARY_API_KEY: " primary-route-key ",
    AI_CONFIDENCE_MODEL: " scorer-model ",
  });
  assert.equal(resolved.profile.enabled, true);
  assert.deepEqual(resolved.profile, {
    enabled: true,
    baseUrl: "https://primary-route",
    model: "scorer-model",
    apiFormat: "anthropic",
    apiKey: "primary-route-key",
    requestTimeoutSec: 120,
    reasoningEffort: "",
    inheritedTransport: true,
    credentialSource: "primary",
    // #1368: the documented defaults ride every resolved profile.
    maxTokens: 4096,
    promptTokens: 98304,
    modelContextTokens: 0,
    anthropicEffortSupported: false,
    structuredOutputSupported: false,
  });
  assert.deepEqual(resolved.warnings, []);
});

test("#1073: an explicit ai-confidence-api-key is used even when ai-confidence-base-url is empty", () => {
  // The operator named the credential they want the scorer to answer with:
  // it is used as-is even on the SAME endpoint (where only the transport is
  // inherited), and the primary lane's key is never sent instead.
  const resolved = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_API_KEY: "primary-key",
    AI_CONFIDENCE_MODEL: "scorer-model", AI_CONFIDENCE_API_KEY: "scorer-key",
  });
  assert.equal(resolved.profile.apiKey, "scorer-key");
  assert.equal(resolved.profile.credentialSource, "own");
  assert.equal(resolved.profile.inheritedTransport, true);
  assert.equal(resolved.profile.baseUrl, "https://primary");
  assert.deepEqual(resolved.warnings, []);
});

test("#1073: a distinct confidence base URL never inherits the primary credential", () => {
  const resolved = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_API_KEY: " primary-key ",
    AI_CONFIDENCE_MODEL: "scorer-model", AI_CONFIDENCE_BASE_URL: " https://independent ", AI_CONFIDENCE_API_KEY: " scorer-key ",
  });
  assert.equal(resolved.profile.baseUrl, "https://independent");
  assert.equal(resolved.profile.apiKey, "scorer-key");
  assert.equal(resolved.profile.inheritedTransport, false);
  assert.deepEqual(resolved.warnings, []);

  // A distinct endpoint WITHOUT an explicit key gets no primary credential —
  // the warning names both inputs, never any secret value.
  const keyless = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_API_KEY: "primary-key",
    AI_CONFIDENCE_MODEL: "scorer-model", AI_CONFIDENCE_BASE_URL: "https://independent",
  });
  assert.equal(keyless.profile.apiKey, "");
  assert.equal(keyless.profile.apiFormat, "openai");
  assert.equal(keyless.warnings.length, 1);
  assert.match(keyless.warnings[0]!, /ai-confidence-base-url is set but ai-confidence-api-key is empty/);
  assert.equal(keyless.warnings[0]!.includes("primary-key"), false);
});

test("#1073: same-endpoint same-model scoring emits the independence warning", () => {
  const same = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_API_KEY: "primary-key",
    AI_CONFIDENCE_MODEL: "main",
  });
  assert.equal(same.profile.enabled, true);
  assert.equal(same.warnings.length, 1);
  assert.match(same.warnings[0]!, /same-model scoring is less independent/);

  // Same endpoint, different model: no warning.
  const otherModel = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_CONFIDENCE_MODEL: "other",
  });
  assert.deepEqual(otherModel.warnings, []);
});

test("#1073: confidence profile resolves timeout, effort, and disabled state", () => {
  const configured = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main",
    AI_CONFIDENCE_MODEL: "scorer", AI_CONFIDENCE_TIMEOUT_SEC: "45", AI_CONFIDENCE_REASONING_EFFORT: " high ",
  });
  assert.equal(configured.profile.requestTimeoutSec, 45);
  assert.equal(configured.profile.reasoningEffort, "high");
  assert.deepEqual(configured.warnings, []);

  // A malformed effort is dropped as unset and announced by key.
  const dropped = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main",
    AI_CONFIDENCE_MODEL: "scorer", AI_CONFIDENCE_REASONING_EFFORT: "-bad",
  });
  assert.equal(dropped.profile.reasoningEffort, "");
  assert.ok(dropped.warnings.some((message) => message.includes("AI_CONFIDENCE_REASONING_EFFORT")));

  // Disabled by default: no model, empty profile, timeout default.
  const disabled = resolveConfidenceProfile({ AI_BASE_URL: "https://primary", AI_MODEL: "main" });
  assert.deepEqual(disabled.profile, {
    enabled: false, baseUrl: "", model: "", apiFormat: "", apiKey: "",
    requestTimeoutSec: 120, reasoningEffort: "", inheritedTransport: false,
    credentialSource: "own",
    maxTokens: 4096, promptTokens: 98304, modelContextTokens: 0,
    anthropicEffortSupported: false, structuredOutputSupported: false,
  });
  assert.deepEqual(disabled.warnings, []);

  // Orphan transport fields without a model are reported, not fatal.
  const orphan = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_CONFIDENCE_BASE_URL: "https://independent",
  });
  assert.equal(orphan.profile.enabled, false);
  assert.deepEqual(orphan.warnings, ["confidence scorer disabled: ai-confidence-base-url set without ai-confidence-model"]);
});

test("#1368: the confidence profile resolves its token budgets and capability assertions", () => {
  const configured = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main",
    AI_CONFIDENCE_MODEL: "scorer",
    AI_CONFIDENCE_MAX_TOKENS: " 8192 ",
    AI_CONFIDENCE_PROMPT_TOKENS: "131072",
    AI_CONFIDENCE_MODEL_CONTEXT_TOKENS: "200000",
    AI_CONFIDENCE_ANTHROPIC_EFFORT_SUPPORT: "true",
    AI_CONFIDENCE_STRUCTURED_OUTPUT_SUPPORT: "TRUE",
  });
  assert.equal(configured.profile.maxTokens, 8192);
  assert.equal(configured.profile.promptTokens, 131072);
  assert.equal(configured.profile.modelContextTokens, 200000);
  assert.equal(configured.profile.anthropicEffortSupported, true);
  assert.equal(configured.profile.structuredOutputSupported, true);
  assert.deepEqual(configured.warnings, []);

  // Defaults when unset: 4096 / 98304, context unknown (0), both flags off.
  const defaults = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_CONFIDENCE_MODEL: "scorer",
  });
  assert.equal(defaults.profile.maxTokens, 4096);
  assert.equal(defaults.profile.promptTokens, 98304);
  assert.equal(defaults.profile.modelContextTokens, 0);
  assert.equal(defaults.profile.anthropicEffortSupported, false);
  assert.equal(defaults.profile.structuredOutputSupported, false);
  assert.deepEqual(defaults.warnings, []);
});

test("#1368: an invalid token budget falls back to its default with a warning naming the input", () => {
  for (const [key, value] of [
    ["AI_CONFIDENCE_MAX_TOKENS", "0"],
    ["AI_CONFIDENCE_MAX_TOKENS", "-5"],
    ["AI_CONFIDENCE_MAX_TOKENS", "abc"],
    ["AI_CONFIDENCE_PROMPT_TOKENS", "1.5"],
    ["AI_CONFIDENCE_MODEL_CONTEXT_TOKENS", "nope"],
  ] as const) {
    const resolved = resolveConfidenceProfile({
      AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_CONFIDENCE_MODEL: "scorer",
      [key]: value,
    });
    const expected = key === "AI_CONFIDENCE_MAX_TOKENS" ? 4096
      : key === "AI_CONFIDENCE_PROMPT_TOKENS" ? 98304
      : 0;
    assert.equal((resolved.profile as unknown as Record<string, unknown>)[key === "AI_CONFIDENCE_MAX_TOKENS" ? "maxTokens" : key === "AI_CONFIDENCE_PROMPT_TOKENS" ? "promptTokens" : "modelContextTokens"], expected, `${key}=${value}`);
    assert.ok(resolved.warnings.some((message) => message.includes(key)), `${key}=${value}: ${JSON.stringify(resolved.warnings)}`);
  }
});

test("#1368: budgets clamp deterministically against the declared model context", () => {
  // A completion budget wider than the window is clamped to the window; the
  // prompt then clamps too (prompt + completion must fit the window), and
  // the declared window stays an ACTUAL bound (#1368 review).
  const maxClamped = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_CONFIDENCE_MODEL: "scorer",
    AI_CONFIDENCE_MAX_TOKENS: "5000", AI_CONFIDENCE_MODEL_CONTEXT_TOKENS: "4096",
  });
  assert.equal(maxClamped.profile.maxTokens, 3072);
  assert.equal(maxClamped.profile.promptTokens, 1024);
  assert.ok(maxClamped.profile.promptTokens + maxClamped.profile.maxTokens <= 4096);
  assert.ok(maxClamped.warnings.some((message) => message.includes("AI_CONFIDENCE_MAX_TOKENS clamped")));
  assert.ok(maxClamped.warnings.some((message) => message.includes("AI_CONFIDENCE_MAX_TOKENS reduced")));
  assert.ok(maxClamped.warnings.some((message) => message.includes("AI_CONFIDENCE_PROMPT_TOKENS clamped")));

  // Prompt + completion over the window clamps the prompt, keeping room for
  // the completion budget — floored so a tiny window never starves the
  // prompt to zero.
  const promptClamped = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_CONFIDENCE_MODEL: "scorer",
    AI_CONFIDENCE_MAX_TOKENS: "4096", AI_CONFIDENCE_PROMPT_TOKENS: "98304",
    AI_CONFIDENCE_MODEL_CONTEXT_TOKENS: "20000",
  });
  assert.equal(promptClamped.profile.promptTokens, 15904);
  assert.equal(promptClamped.profile.maxTokens, 4096);
  assert.ok(promptClamped.warnings.some((message) => message.includes("AI_CONFIDENCE_PROMPT_TOKENS clamped")));

  // The 1024 prompt floor never overrides the window: when the completion
  // budget leaves less than the floor, BOTH budgets are reduced
  // deterministically so prompt + completion fits the window exactly
  // (#1368 review blocker 1 — the floor used to break the invariant).
  const dualReduced = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_CONFIDENCE_MODEL: "scorer",
    AI_CONFIDENCE_MODEL_CONTEXT_TOKENS: "2048",
  });
  assert.equal(dualReduced.profile.maxTokens, 1024);
  assert.equal(dualReduced.profile.promptTokens, 1024);
  assert.ok(dualReduced.warnings.some((message) => message.includes("AI_CONFIDENCE_MAX_TOKENS reduced")));
  assert.ok(dualReduced.warnings.some((message) => message.includes("AI_CONFIDENCE_PROMPT_TOKENS clamped")));

  // Boundary: the default completion budget against a window exactly equal
  // to it reduces the completion to window - floor, never over the window.
  const equalWindow = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_CONFIDENCE_MODEL: "scorer",
    AI_CONFIDENCE_MODEL_CONTEXT_TOKENS: "4096",
  });
  assert.equal(equalWindow.profile.maxTokens, 3072);
  assert.equal(equalWindow.profile.promptTokens, 1024);

  // Boundary: the smallest window that can still fit the minimum shape
  // (1024-token prompt + a positive completion budget).
  const smallestFitting = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_CONFIDENCE_MODEL: "scorer",
    AI_CONFIDENCE_MODEL_CONTEXT_TOKENS: "1025",
  });
  assert.equal(smallestFitting.profile.enabled, true);
  assert.equal(smallestFitting.profile.maxTokens, 1);
  assert.equal(smallestFitting.profile.promptTokens, 1024);

  // An explicitly configured completion budget below the floor is reduced
  // the same way — the floor stays the minimum prompt shape whatever the
  // operator configured.
  const explicitSmall = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_CONFIDENCE_MODEL: "scorer",
    AI_CONFIDENCE_MAX_TOKENS: "1000", AI_CONFIDENCE_MODEL_CONTEXT_TOKENS: "1025",
  });
  assert.equal(explicitSmall.profile.maxTokens, 1);
  assert.equal(explicitSmall.profile.promptTokens, 1024);
  assert.ok(explicitSmall.warnings.some((message) => message.includes("AI_CONFIDENCE_MAX_TOKENS reduced")));

  // Boundary: a window that cannot fit the minimum shape fails the scorer
  // profile closed — disabled, loudly, never an over-budget request.
  for (const tooSmall of ["1024", "512"]) {
    const failedClosed = resolveConfidenceProfile({
      AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_CONFIDENCE_MODEL: "scorer",
      AI_CONFIDENCE_MODEL_CONTEXT_TOKENS: tooSmall,
    });
    assert.equal(failedClosed.profile.enabled, false, `context=${tooSmall}`);
    assert.ok(
      failedClosed.warnings.some((message) => message.includes("confidence scorer disabled") && message.includes("ai-confidence-model-context-tokens")),
      `context=${tooSmall}: ${JSON.stringify(failedClosed.warnings)}`,
    );
  }

  // Fitting budgets are never touched and never warn.
  const fits = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_CONFIDENCE_MODEL: "scorer",
    AI_CONFIDENCE_MAX_TOKENS: "4096", AI_CONFIDENCE_PROMPT_TOKENS: "98304",
    AI_CONFIDENCE_MODEL_CONTEXT_TOKENS: "102400",
  });
  assert.equal(fits.profile.maxTokens, 4096);
  assert.equal(fits.profile.promptTokens, 98304);
  assert.deepEqual(fits.warnings, []);
});

test("#1368: a configured Anthropic effort without the scorer's own opt-in warns and names the input", () => {
  const resolved = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main",
    AI_API_FORMAT: "anthropic",
    AI_CONFIDENCE_MODEL: "scorer", AI_CONFIDENCE_REASONING_EFFORT: "high",
  });
  assert.equal(resolved.profile.reasoningEffort, "high");
  assert.equal(resolved.profile.anthropicEffortSupported, false);
  assert.equal(resolved.warnings.length, 1);
  assert.match(resolved.warnings[0]!, /output_config\.effort/);
  assert.match(resolved.warnings[0]!, /ai-confidence-anthropic-effort-support/);

  // The opt-in silences the warning; the effort is then sent.
  const asserted = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main",
    AI_API_FORMAT: "anthropic",
    AI_CONFIDENCE_MODEL: "scorer", AI_CONFIDENCE_REASONING_EFFORT: "high",
    AI_CONFIDENCE_ANTHROPIC_EFFORT_SUPPORT: "true",
  });
  assert.equal(asserted.profile.anthropicEffortSupported, true);
  assert.deepEqual(asserted.warnings, []);

  // OpenAI format needs no assertion and never warns about it.
  const openai = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main",
    AI_CONFIDENCE_MODEL: "scorer", AI_CONFIDENCE_REASONING_EFFORT: "high",
  });
  assert.deepEqual(openai.warnings, []);

  // Another lane's assertion is never inherited: the confidence lane has its
  // own input only.
  const notInherited = resolveConfidenceProfile({
    AI_BASE_URL: "https://primary", AI_MODEL: "main",
    AI_API_FORMAT: "anthropic",
    AI_CONFIDENCE_MODEL: "scorer", AI_CONFIDENCE_REASONING_EFFORT: "high",
    AI_ANTHROPIC_EFFORT_SUPPORT: "true",
    AI_SMART_ANTHROPIC_EFFORT_SUPPORT: "true",
  });
  assert.equal(notInherited.profile.anthropicEffortSupported, false);
  assert.equal(notInherited.warnings.length, 1);
});
