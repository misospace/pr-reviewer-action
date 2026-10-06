import test from "node:test";
import assert from "node:assert/strict";
import { isLowConfidence, reviewerRequestedEscalation, shouldEscalate } from "../src/routing/escalation.js";
import { resolveReviewRoute, resolveSpecialistProfiles, resolveTierProfiles, tierRequestShape } from "../src/routing/tiers.js";

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
  assert.deepEqual(resolved.transport, { baseUrl: "https://specialist", model: "specialist-model", apiFormat: "anthropic", apiKey: "specialist-key" });
  assert.deepEqual(resolved.roleModels, {
    correctness: { model: "correctness-model", source: "role-override" },
    security: { model: "specialist-model", source: "specialist-profile" },
    tests: { model: "specialist-model", source: "specialist-profile" },
  });
  assert.equal(resolved.overridesActive, true);
  assert.deepEqual(resolved.warnings, []);

  const primary = resolveSpecialistProfiles({ AI_BASE_URL: " primary-url ", AI_MODEL: " primary-model ", AI_API_FORMAT: " OpenAI ", AI_API_KEY: " key ", AI_SPECIALIST_SECURITY_MODEL: " security-model " });
  assert.equal(primary.profileActive, false);
  assert.deepEqual(primary.transport, { baseUrl: "primary-url", model: "primary-model", apiFormat: "openai", apiKey: "key" });
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
  assert.deepEqual(invalid.transport, { baseUrl: "", model: "primary", apiFormat: "openai", apiKey: "" });
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
  assert.deepEqual(base.primary, { baseUrl: "https://primary", model: "main", apiFormat: "openai", apiKey: "k", resolved: true, retries: 8, retryDelaySec: 15, stream: true, requestTimeoutSec: 300, connectTimeoutSec: 30 });
  assert.equal(base.smart.resolved, false);
  assert.equal(base.smart.baseUrl, "https://primary");
  assert.equal(base.smart.apiKey, "k");
  assert.equal(base.fallback.resolved, false);
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
