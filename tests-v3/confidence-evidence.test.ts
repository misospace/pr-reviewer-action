import test from "node:test";
import assert from "node:assert/strict";
import { startMockServer } from "./helpers.js";
import { runConfidenceScorer } from "../src/confidence/scorer.js";
import { buildRunMetadataMarker } from "../src/metadata/markers.js";
import { parseMetadata } from "../src/precheck/metadata.js";
import { confidenceTelemetryOf, type ConfidenceTelemetry } from "../src/confidence/telemetry.js";
import type { ConfidenceProfile } from "../src/routing/tiers.js";

/** #1455: the verifier's three facts — its action-owned cause, its measured
 * latency and its provider token usage — must reach a published PR record,
 * not only the run directory that dies with the runner.
 *
 * This file covers the two halves that need no run harness: the scorer's
 * own outcome (what it measured) and the marker (what it publishes). The
 * run-level artifact and the end-to-end publication live in
 * `run-confidence.test.ts`, which already carries the run harness. */

/** A minimal enabled scorer profile; the overrides pick the lane shape. */
function profile(overrides: Partial<ConfidenceProfile> = {}): ConfidenceProfile {
  return {
    enabled: true,
    baseUrl: "https://api.example.com",
    model: "scorer-model",
    apiFormat: "openai",
    apiKey: "scorer-key",
    requestTimeoutSec: 10,
    reasoningEffort: "",
    inheritedTransport: true,
    credentialSource: "own",
    maxTokens: 4096,
    promptTokens: 98304,
    modelContextTokens: 0,
    anthropicEffortSupported: false,
    structuredOutputSupported: false,
    ...overrides,
  };
}

/** An OpenAI-shaped provider answer carrying the token usage the provider
 * reports. */
function providerAnswer(content: string, usage?: Record<string, number>): string {
  return JSON.stringify({
    id: "s1",
    object: "chat.completion",
    model: "scorer-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    ...(usage === undefined ? {} : { usage }),
  });
}

/** An Anthropic-shaped provider answer: the cache tokens ride OUTSIDE
 * `input_tokens`, so the canonical accounting adds them to the prompt
 * total. */
function anthropicAnswer(content: string, usage: Record<string, number>): string {
  return JSON.stringify({
    id: "s1",
    type: "message",
    role: "assistant",
    model: "scorer-model",
    content: [{ type: "text", text: content }],
    stop_reason: "end_turn",
    usage,
  });
}

// ── the scorer's own measurement ──────────────────────────────────────────
test("#1455: a scored call carries the provider's reported usage and a measured latency", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(providerAnswer(
      JSON.stringify({ score: 4, risk: "low", reason: "thin but covered", concerns: [] }),
      { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 },
    ));
  });
  try {
    const outcome = await runConfidenceScorer({
      profile: profile({ baseUrl: server.url }),
      primaryApiKey: "primary-key",
      prompt: { system: "s", user: "u" },
      connectTimeoutSec: 5,
      findings: [],
      coverage: {},
    });
    assert.equal(outcome.result.status, "scored");
    // The provider's own accounting; the scorer no longer drops it.
    assert.deepEqual(outcome.usage, {
      promptTokens: 1234,
      completionTokens: 56,
      totalTokens: 1290,
    });
    // The latency is a real measurement of the one wire attempt.
    assert.equal(typeof outcome.latencyMs, "number");
    assert.ok((outcome.latencyMs ?? -1) >= 0, "the measured latency must be a non-negative duration");
  } finally {
    await server.close();
  }
});

test("#1455: the token usage follows the canonical format-aware accounting", async () => {
  // The Anthropic wire reports its cache tokens OUTSIDE `input_tokens`, so
  // the prompt total adds them: the published prompt count is the billed
  // prompt, not the uncached subset.
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(anthropicAnswer(
      JSON.stringify({ score: 4, risk: "low", reason: "ok", concerns: [] }),
      { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 7 },
    ));
  });
  try {
    const outcome = await runConfidenceScorer({
      profile: profile({ baseUrl: server.url, apiFormat: "anthropic" }),
      primaryApiKey: "primary-key",
      prompt: { system: "s", user: "u" },
      connectTimeoutSec: 5,
      findings: [],
      coverage: {},
    });
    assert.deepEqual(outcome.usage, {
      promptTokens: 157,
      completionTokens: 20,
      totalTokens: 177,
    });
  } finally {
    await server.close();
  }
});

test("#1455: a call the provider answered without usage carries no usage", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(providerAnswer(JSON.stringify({ score: 3, risk: "low", reason: "ok", concerns: [] })));
  });
  try {
    const outcome = await runConfidenceScorer({
      profile: profile({ baseUrl: server.url }),
      primaryApiKey: "primary-key",
      prompt: { system: "s", user: "u" },
      connectTimeoutSec: 5,
      findings: [],
      coverage: {},
    });
    assert.equal(outcome.result.status, "scored");
    assert.equal(outcome.usage, null, "no provider usage means no usage to publish");
  } finally {
    await server.close();
  }
});

test("#1455: a transport failure carries a measured latency and no usage", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 429;
    res.end("rate limited");
  });
  try {
    const outcome = await runConfidenceScorer({
      profile: profile({ baseUrl: server.url }),
      primaryApiKey: "primary-key",
      prompt: { system: "s", user: "u" },
      connectTimeoutSec: 5,
      findings: [],
      coverage: {},
    });
    assert.equal(outcome.result.status, "unscored");
    assert.equal(outcome.result.cause, "http_429");
    assert.equal(outcome.usage, null, "a failed call has no usage to report");
    assert.equal(typeof outcome.latencyMs, "number");
    assert.ok((outcome.latencyMs ?? -1) >= 0, "the measured latency must be a non-negative duration");
  } finally {
    await server.close();
  }
});

test("#1455: a thrown transport carries no latency, because nothing reached the provider", async () => {
  const outcome = await runConfidenceScorer({
    profile: profile(),
    primaryApiKey: "primary-key",
    prompt: { system: "s", user: "u" },
    connectTimeoutSec: 5,
    transport: async () => { throw new Error("socket exploded"); },
    findings: [],
    coverage: {},
  });
  assert.equal(outcome.result.status, "unscored");
  assert.equal(outcome.result.cause, "transport_error");
  assert.equal(outcome.usage, null);
  // A thrown transport never produced a request, so there is no provider
  // call to wait for: the time spent failing locally is not a latency.
  assert.equal(outcome.latencyMs, null);
});

test("#1455: a malformed answer carries a measured latency and the provider's usage", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(providerAnswer("Sure! Here is my answer: {\"score\": 4, \"risk\": \"lo", { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }));
  });
  try {
    const outcome = await runConfidenceScorer({
      profile: profile({ baseUrl: server.url }),
      primaryApiKey: "primary-key",
      prompt: { system: "s", user: "u" },
      connectTimeoutSec: 5,
      findings: [],
      coverage: {},
    });
    assert.equal(outcome.result.status, "unscored");
    assert.equal(outcome.result.cause, "malformed_answer");
    // The provider answered and reported its accounting; only the parse
    // failed. The tokens were spent, so the usage is reported.
    assert.deepEqual(outcome.usage, { promptTokens: 5, completionTokens: 5, totalTokens: 10 });
    assert.equal(typeof outcome.latencyMs, "number");
  } finally {
    await server.close();
  }
});

test("#1455: a refusal before the wire carries neither latency nor usage", async () => {
  // A missing credential: the scorer never dials, so there is no call whose
  // duration or cost the run could report.
  const refused = await runConfidenceScorer({
    profile: profile({ apiKey: "", inheritedTransport: false, baseUrl: "https://independent.example.com" }),
    primaryApiKey: "primary-key",
    prompt: { system: "s", user: "u" },
    connectTimeoutSec: 5,
    transport: async () => { throw new Error("must not be called"); },
    findings: [],
    coverage: {},
  });
  assert.equal(refused.result.cause, "missing_credential");
  assert.equal(refused.latencyMs, null, "a call that never happened has no latency");
  assert.equal(refused.usage, null);

  // A prompt over the declared budget: refused before the wire, same shape.
  const overBudget = await runConfidenceScorer({
    profile: profile({ promptTokens: 1 }),
    primaryApiKey: "primary-key",
    prompt: { system: "s".repeat(200), user: "u" },
    connectTimeoutSec: 5,
    transport: async () => { throw new Error("must not be called"); },
    findings: [],
    coverage: {},
  });
  assert.equal(overBudget.result.cause, "prompt_over_budget");
  assert.equal(overBudget.latencyMs, null);
  assert.equal(overBudget.usage, null);

  // A disabled profile: no request at all.
  const disabled = await runConfidenceScorer({
    profile: profile({ enabled: false }),
    primaryApiKey: "primary-key",
    prompt: { system: "s", user: "u" },
    connectTimeoutSec: 5,
    findings: [],
    coverage: {},
  });
  assert.equal(disabled.result.status, "disabled");
  assert.equal(disabled.latencyMs, null);
  assert.equal(disabled.usage, null);
});

// ── the telemetry authority ───────────────────────────────────────────────
test("#1455: the telemetry authority publishes a cause only for an unscored run", () => {
  const unscored = confidenceTelemetryOf({
    status: "unscored",
    cause: "http_429",
    latencyMs: 42,
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
  });
  assert.equal(unscored.cause, "http_429");
  assert.equal(unscored.latencyMs, 42);

  // A scored run has no cause to explain.
  const scored = confidenceTelemetryOf({
    status: "scored",
    cause: "http_429",
    latencyMs: 42,
    usage: null,
  });
  assert.equal(scored.cause, "");
});

test("#1455: the telemetry authority drops a cause that is not a conservative machine token", () => {
  for (const cause of ["HTTP 429", "provider said: rate limited", "", "a".repeat(65)]) {
    const telemetry = confidenceTelemetryOf({
      status: "unscored",
      cause,
      latencyMs: null,
      usage: null,
    });
    assert.equal(telemetry.cause, "", `cause ${JSON.stringify(cause)} must not be published`);
  }
});

test("#1455: the telemetry authority drops a latency or usage that fails validation", () => {
  const telemetry = confidenceTelemetryOf({
    status: "unscored",
    cause: "timeout",
    latencyMs: -1,
    usage: { promptTokens: 1.5, completionTokens: 20, totalTokens: 120 },
  });
  assert.equal(telemetry.latencyMs, null, "a negative duration is not a measurement");
  assert.equal(telemetry.usage, null, "a fractional token count is not a token count");

  const fractionalLatency = confidenceTelemetryOf({
    status: "unscored",
    cause: "timeout",
    latencyMs: 12.5,
    usage: null,
  });
  assert.equal(fractionalLatency.latencyMs, null);
});

// ── the marker ────────────────────────────────────────────────────────────
/** The marker a run with no verifier telemetry produces — the pre-#1455
 * bytes every other key already commits to. */
const BASELINE_MARKER = buildRunMetadataMarker({
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  reviewResult: "clean",
});

test("#1455: a marker without the telemetry is byte-identical to the pre-change marker", () => {
  assert.equal(
    BASELINE_MARKER,
    '<!-- ai-pr-reviewer:{"version":1,"head_sha":"' + "a".repeat(40) + '","base_sha":"' + "b".repeat(40) + '","review_result":"clean"} -->',
  );
  assert.doesNotMatch(BASELINE_MARKER, /confidence_cause|confidence_latency_ms|confidence_prompt_tokens/);
});

test("#1455: an unscored run publishes its cause, a scored run does not", () => {
  const unscored = buildRunMetadataMarker({
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    reviewResult: "clean",
    confidenceStatus: "unscored",
    confidenceTelemetry: {
      status: "unscored",
      cause: "http_429",
      latencyMs: 120,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    },
  });
  assert.match(unscored, /"confidence_cause":"http_429"/);
  // The cause rides last, after every pre-existing key.
  assert.ok(
    unscored.indexOf('"confidence_cause"') > unscored.indexOf('"review_result"'),
    "the new key must not move an existing one",
  );

  const scored = buildRunMetadataMarker({
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    reviewResult: "clean",
    confidenceStatus: "scored",
    confidenceScore: 4,
    confidenceTelemetry: {
      status: "unscored",
      cause: "http_429",
      latencyMs: 120,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    },
  });
  assert.match(scored, /"confidence_status":"scored"/);
  assert.doesNotMatch(scored, /confidence_cause/, "a scored run has no cause to publish");
});

test("#1455: the marker publishes the measured latency and the token counts", () => {
  const marker = buildRunMetadataMarker({
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    reviewResult: "clean",
    confidenceStatus: "scored",
    confidenceScore: 4,
    confidenceTelemetry: {
      status: "scored",
      cause: "",
      latencyMs: 1234,
      usage: { promptTokens: 1200, completionTokens: 34, totalTokens: 1234 },
    },
  });
  assert.match(marker, /"confidence_latency_ms":1234/);
  const parsed = parseMetadata(marker);
  assert.equal(parsed?.confidence_latency_ms, 1234);
  assert.equal(parsed?.confidence_prompt_tokens, 1200);
  assert.equal(parsed?.confidence_completion_tokens, 34);
  assert.equal(parsed?.confidence_total_tokens, 1234);
  // The marker stays a flat wire format: every published value is a scalar,
  // so the documented `grep -oE 'ai-pr-reviewer:\{[^}]*\}'` recipe still
  // extracts the whole marker.
  assert.doesNotMatch(marker, /confidence_usage/);
});

test("#1455: a token count the provider did not report is absent, never zero", () => {
  const marker = buildRunMetadataMarker({
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    reviewResult: "clean",
    confidenceStatus: "scored",
    confidenceScore: 4,
    confidenceTelemetry: {
      status: "scored",
      cause: "",
      latencyMs: 10,
      usage: { promptTokens: null, completionTokens: 5, totalTokens: null },
    },
  });
  const parsed = parseMetadata(marker);
  assert.equal(parsed?.confidence_completion_tokens, 5);
  assert.ok(!("confidence_prompt_tokens" in (parsed ?? {})), "an unreported count is absent");
  assert.ok(!("confidence_total_tokens" in (parsed ?? {})), "an unreported count is absent");
});

test("#1455: the telemetry rides its own status, not the marker's claim", () => {
  // A telemetry with no status (the verifier never ran) publishes nothing.
  const noStatus = buildRunMetadataMarker({
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    reviewResult: "clean",
    confidenceTelemetry: {
      status: "",
      cause: "timeout",
      latencyMs: 12,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    },
  });
  assert.doesNotMatch(noStatus, /confidence_latency_ms/);
  assert.doesNotMatch(noStatus, /confidence_cause/);

  // The telemetry's own status is what it publishes under: the marker does
  // not need an ambient confidence status to carry the evidence.
  const ownStatus = buildRunMetadataMarker({
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    reviewResult: "clean",
    confidenceTelemetry: {
      status: "unscored",
      cause: "timeout",
      latencyMs: 12,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    },
  });
  assert.match(ownStatus, /"confidence_cause":"timeout"/);
  assert.match(ownStatus, /"confidence_latency_ms":12/);
});

test("#1455: the new keys come last and never move an existing one", () => {
  const marker = buildRunMetadataMarker({
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    reviewResult: "clean",
    confidenceStatus: "unscored",
    confidenceTelemetry: {
      status: "unscored",
      cause: "timeout",
      latencyMs: 42,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    },
  });
  const keys = Object.keys(parseMetadata(marker) ?? {});
  assert.deepEqual(keys, [
    "version",
    "head_sha",
    "base_sha",
    "review_result",
    "confidence_status",
    "confidence_cause",
    "confidence_latency_ms",
    "confidence_prompt_tokens",
    "confidence_completion_tokens",
    "confidence_total_tokens",
  ]);
});

test("#1455: a rich marker's pre-existing key order is untouched", () => {
  // The marker is a positional wire format: the new keys are appended last
  // and no pre-existing key moves. This pins the FULL order of a marker that
  // carries every key family, so a regression in the pre-existing order is
  // caught rather than only the minimal marker.
  const marker = buildRunMetadataMarker({
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    reviewResult: "issues",
    requiredChecks: "build",
    reviewRoute: "primary",
    escalationReason: "primary_requested",
    cacheHitRatio: "0.5",
    coverage: "complete",
    incompleteReason: "none",
    ciState: "pending",
    toolBudget: 26,
    toolBudgetSource: "tier-default",
    toolCalls: 26,
    toolRounds: 6,
    maxRounds: 32,
    contextBudget: 24000,
    contextPeak: 900,
    toolStopReason: "model-stopped",
    actionVersion: "v3.9.0",
    degradedGateBypass: true,
    confidenceStatus: "unscored",
    confidenceTelemetry: {
      status: "unscored",
      cause: "timeout",
      latencyMs: 42,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    },
  });
  const keys = Object.keys(parseMetadata(marker) ?? {});
  assert.deepEqual(keys, [
    "version",
    "head_sha",
    "base_sha",
    "review_result",
    "required_checks",
    "review_route",
    "escalation_reason",
    "cache_hit_ratio",
    "coverage",
    "ci_state",
    "tool_budget",
    "tool_budget_source",
    "tool_calls",
    "tool_rounds",
    "max_rounds",
    "context_budget",
    "context_peak",
    "action_version",
    "degraded_gate_bypass",
    "tool_stop_reason",
    "confidence_status",
    "confidence_cause",
    "confidence_latency_ms",
    "confidence_prompt_tokens",
    "confidence_completion_tokens",
    "confidence_total_tokens",
  ]);
});

// ── the artifact → the publish seam ───────────────────────────────────────
test("#1455: the telemetry round-trips through the run artifact", async () => {
  const { confidenceTelemetryFromArtifact } = await import("../src/confidence/telemetry.js");
  const artifact = {
    version: 2,
    rubric: "merge-safety-v1",
    status: "unscored",
    score: null,
    risk: "unknown",
    reason: "",
    concerns: [],
    model: "scorer-model",
    cause: "http_429",
    caps: [],
    parser_notes: [],
    latency_ms: 250,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const telemetry = confidenceTelemetryFromArtifact(artifact);
  assert.deepEqual(telemetry, {
    status: "unscored",
    cause: "http_429",
    latencyMs: 250,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  });

  // A version-1 artifact is a pre-#1369 prose-quality confidence grade:
  // its semantics are not comparable, so it is trusted for nothing.
  const legacy = confidenceTelemetryFromArtifact({ ...artifact, version: 1 });
  assert.deepEqual(legacy, { status: "", cause: "", latencyMs: null, usage: null });
});

test("#1455: a hostile artifact cannot publish a cause", async () => {
  const { confidenceTelemetryFromArtifact } = await import("../src/confidence/telemetry.js");
  // A cause that is not a conservative token is dropped on the way out of
  // the artifact, so a hostile artifact cannot publish a cause.
  const telemetry: ConfidenceTelemetry = confidenceTelemetryFromArtifact({
    version: 2,
    status: "unscored",
    cause: "provider said: rate limited",
    latency_ms: 10,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  assert.equal(telemetry.cause, "");
  assert.equal(telemetry.latencyMs, 10);
});

test("#1455: a usage with one invalid count is rejected whole, never half-published", async () => {
  const { confidenceTelemetryFromArtifact } = await import("../src/confidence/telemetry.js");
  const telemetry = confidenceTelemetryFromArtifact({
    version: 2,
    status: "scored",
    cause: "",
    latency_ms: 10,
    usage: { prompt_tokens: -5, completion_tokens: 10, total_tokens: 5 },
  });
  assert.equal(telemetry.usage, null, "a corrupt usage is not published half-validated");
});

test("#1455: the total is the provider's own when it reported one, else the accounted sum", async () => {
  // The provider reported its own total: that is the number published.
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(providerAnswer(
      JSON.stringify({ score: 4, risk: "low", reason: "ok", concerns: [] }),
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 999 },
    ));
  });
  try {
    const outcome = await runConfidenceScorer({
      profile: profile({ baseUrl: server.url }),
      primaryApiKey: "primary-key",
      prompt: { system: "s", user: "u" },
      connectTimeoutSec: 5,
      findings: [],
      coverage: {},
    });
    assert.deepEqual(outcome.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 999 });
  } finally {
    await server.close();
  }

  // The provider reported no total: the accounted sum is published, and the
  // doc says so.
  const noTotal = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(providerAnswer(
      JSON.stringify({ score: 4, risk: "low", reason: "ok", concerns: [] }),
      { prompt_tokens: 10, completion_tokens: 5 },
    ));
  });
  try {
    const outcome = await runConfidenceScorer({
      profile: profile({ baseUrl: noTotal.url }),
      primaryApiKey: "primary-key",
      prompt: { system: "s", user: "u" },
      connectTimeoutSec: 5,
      findings: [],
      coverage: {},
    });
    assert.deepEqual(outcome.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  } finally {
    await noTotal.close();
  }
});
