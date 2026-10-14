import test from "node:test";
import assert from "node:assert/strict";
import { isLowConfidence, reviewerRequestedEscalation, shouldEscalate } from "../src/routing/escalation.js";
import { anthropicEffortInactiveWarning, anthropicEffortSupported, anthropicEffortSupportInput, effectiveWireEffort, laneAnthropicEffortSupported, normalizeReasoningEffort, resolveReviewRoute, resolveSpecialistProfiles, resolveTierProfiles, tierReasoningEffort, tierRequestShape, tierResponseFormat } from "../src/routing/tiers.js";

const flags = { onIncomplete: true, onRequestChanges: true, onLowConfidence: true, onBlockers: true, onPlanningFailure: true };
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

test("shouldEscalate reports each telemetry reason only when enabled and applicable", () => {
  const base = { review_markdown: longReview, verdict: "approve" };
  assert.deepEqual(shouldEscalate(base), { escalate: false, reasons: [] });
  assert.deepEqual(shouldEscalate({ ...base, verdict: "request_changes" }, {}, {}, {}, { onRequestChanges: true }), { escalate: true, reasons: ["fast_request_changes"] });
  assert.deepEqual(shouldEscalate({ ...base, verdict: "request_changes" }, {}, {}, {}, { onRequestChanges: false }), { escalate: false, reasons: [] });
  assert.deepEqual(shouldEscalate({ review_markdown: "LGTM." }, {}, {}, {}, { onLowConfidence: true }), { escalate: true, reasons: ["fast_low_confidence"] });
  assert.deepEqual(shouldEscalate(base, {}, { has_blocker: true }), { escalate: true, reasons: ["tool_or_evidence_blockers"] });
  assert.deepEqual(shouldEscalate(base, {}, {}, { executed_request_count: 1, tool_results: [{ status: "error" }] }), { escalate: true, reasons: ["tool_or_evidence_blockers"] });
  assert.deepEqual(shouldEscalate(base, {}, {}, { executed_request_count: 1, tool_results: [{ status: "ok" }] }), { escalate: false, reasons: [] });
  assert.deepEqual(shouldEscalate(base, {}, {}, { planning_error: "failed" }, { onPlanningFailure: true }), { escalate: true, reasons: ["tool_planning_failed"] });
  assert.deepEqual(shouldEscalate(base, {}, {}, { error: "failed" }, { onPlanningFailure: true }), { escalate: true, reasons: ["tool_planning_failed"] });
  assert.deepEqual(shouldEscalate({}, {}, {}, {}, flags), { escalate: true, reasons: ["fast_low_confidence"] });
});

test("structured required-check dispositions take precedence over legacy prose", () => {
  const checks = { must_check: ["review auth flow for regression"] };
  const review_markdown = "The auth behavior is reviewed and confirmed.";
  const notApplicable = { check: checks.must_check[0], status: "not_applicable", rationale: "This change has no authentication flow." };
  assert.deepEqual(shouldEscalate({ review_markdown, required_check_dispositions: [notApplicable] }, checks, {}, {}, { onIncomplete: true, onLowConfidence: false }), { escalate: false, reasons: [] });
  assert.deepEqual(shouldEscalate({ review_markdown, required_check_dispositions: null }, checks, {}, {}, { onIncomplete: true, onLowConfidence: false }), { escalate: true, reasons: ["incomplete_required_checks"] });
  assert.deepEqual(shouldEscalate({ review_markdown }, checks, {}, {}, { onIncomplete: true, onLowConfidence: false }), { escalate: false, reasons: [] });
  assert.deepEqual(shouldEscalate({ review_markdown: "No discussion." }, checks, {}, {}, { onIncomplete: true, onLowConfidence: false }), { escalate: true, reasons: ["incomplete_required_checks"] });
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
  assert.deepEqual(base.primary, { baseUrl: "https://primary", model: "main", apiFormat: "openai", apiKey: "k", resolved: true, retries: 8, retryDelaySec: 15, stream: true, requestTimeoutSec: 300, connectTimeoutSec: 30, responseFormat: "off", reasoningEffort: "", anthropicEffortSupported: false });
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
  assert.equal(configured.fallback.stream, false);
  assert.equal(configured.fallback.retries, 2);
  assert.equal(configured.smart.retries, 2);
  assert.equal(tierRequestShape("primary", { PRIMARY_REQUEST_SHAPE: "trailing_task" }), "trailing_task");
  assert.equal(tierRequestShape("primary", { PRIMARY_REQUEST_SHAPE: "trailing_task", SMART_REQUEST_SHAPE: "default", REVIEW_CONTEXT_PROFILE: "smart" }), "default");
  assert.equal(tierRequestShape("smart", { SMART_REQUEST_SHAPE: "trailing_task" }), "trailing_task");
  assert.equal(tierRequestShape("fallback", { SMART_REQUEST_SHAPE: "trailing_task" }), "default");
  assert.equal(tierRequestShape("smart", { SMART_REQUEST_SHAPE: "unknown" }), "default");
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

test("#998: tierReasoningEffort honors per-lane overrides independently, and the fallback lane has none", () => {
  const env = {
    AI_REASONING_EFFORT: "low",
    AI_PRIMARY_REASONING_EFFORT: "high",
    AI_SMART_REASONING_EFFORT: "xhigh",
  };
  assert.equal(tierReasoningEffort("primary", env), "high");
  assert.equal(tierReasoningEffort("smart", env), "xhigh");
  // Fallback is availability recovery, never quality escalation (#965): it
  // always inherits the base and no input can move it (there is no
  // `AI_FALLBACK_REASONING_EFFORT` env key at all).
  assert.equal(tierReasoningEffort("fallback", env), "low");
  assert.equal(tierReasoningEffort("fallback", { ...env, AI_FALLBACK_REASONING_EFFORT: "medium" }), "low");
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

test("#998: resolveTierProfiles threads the effective reasoningEffort through every tier", () => {
  const profiles = resolveTierProfiles({
    AI_BASE_URL: "https://primary",
    AI_MODEL: "main",
    AI_SMART_MODEL: "s",
    AI_FALLBACK_BASE_URL: "https://fb",
    AI_FALLBACK_MODEL: "fb",
    AI_REASONING_EFFORT: "low",
    AI_PRIMARY_REASONING_EFFORT: "high",
    AI_SMART_REASONING_EFFORT: "xhigh",
  });
  assert.equal(profiles.primary.reasoningEffort, "high");
  assert.equal(profiles.smart.reasoningEffort, "xhigh");
  assert.equal(profiles.fallback.reasoningEffort, "low");
  assert.equal(resolveTierProfiles({ AI_BASE_URL: "p", AI_MODEL: "m" }).primary.reasoningEffort, "");
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
  // The fallback lane is availability recovery on the base endpoint: it shares
  // the base assertion exactly like it inherits the base effort.
  assert.equal(profiles.fallback.anthropicEffortSupported, true);
  assert.equal(profiles.smart.anthropicEffortSupported, false);
  const smartAsserted = resolveTierProfiles({ ...baseEnv, AI_SMART_ANTHROPIC_EFFORT_SUPPORT: "true" });
  assert.equal(smartAsserted.smart.anthropicEffortSupported, true);
  assert.equal(smartAsserted.primary.anthropicEffortSupported, false);
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
  assert.equal(anthropicEffortSupportInput("fallback"), "ai-anthropic-effort-support");
  assert.equal(anthropicEffortSupportInput("specialist"), "ai-specialist-anthropic-effort-support");
});
