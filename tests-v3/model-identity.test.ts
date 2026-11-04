import test from "node:test";
import assert from "node:assert/strict";
import { differsOnlyByCase, opaqueModelId } from "../src/model/identity.js";
import { runConfidenceScorer } from "../src/confidence/scorer.js";
import type { ChatRequestInput, ChatRequestOutcome } from "../src/transport/transport.js";
import type { ConfidenceProfile } from "../src/routing/tiers.js";
import { resolveConfidenceProfile, resolveSpecialistProfiles, resolveTierProfiles } from "../src/routing/tiers.js";
import { renderIndependentConfidenceBlock } from "../src/publish/publish.js";
import { formatReviewStepOutputs } from "../src/publish/outputs.js";

// #1465: a provider model identifier is an OPAQUE token. The action carries
// the configured string to the provider and to the published telemetry
// byte-identically: no case folding, no title-casing, no lower-casing.

/** The scorer's profile fixture — the same shape the confidence suite uses. */
function profile(overrides: Partial<ConfidenceProfile> = {}): ConfidenceProfile {
  return {
    enabled: true,
    baseUrl: "https://api.example.com",
    model: "MiniMax-M3.1-Flash",
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
    refusalCause: "",
    ...overrides,
  };
}

/** An OpenAI-shaped provider answer, the same shape the confidence suite uses. */
function okOpenAiResponse(content: string): unknown {
  return {
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { completion_tokens: 12 },
  };
}

/** A successful transport outcome carrying the scorer's answer. */
function okOutcome(content: string): ChatRequestOutcome {
  return {
    status: "ok",
    raw: okOpenAiResponse(content),
    response: {
      id: "", object: "chat.completion", model: "MiniMax-M3.1-Flash",
      content, toolCalls: [], finishReason: "stop", usage: null, error: undefined,
    },
  };
}

/** A stub transport that captures the request the scorer dispatched. */
function capturingTransport(captured: Array<{ endpointPath: string; body: Record<string, unknown> }>, content: string) {
  return async (input: ChatRequestInput): Promise<ChatRequestOutcome> => {
    captured.push({
      endpointPath: input.payload.endpointPath,
      body: input.payload.body as unknown as Record<string, unknown>,
    });
    return okOutcome(content);
  };
}

test("opaqueModelId trims the value and never changes its letter case", () => {
  assert.equal(opaqueModelId("  MiniMax-M3.1-Flash  "), "MiniMax-M3.1-Flash");
  assert.equal(opaqueModelId("MiniMax-M3.1-Flash"), "MiniMax-M3.1-Flash");
  assert.equal(opaqueModelId("minimax-m3.1-flash"), "minimax-m3.1-flash");
  assert.equal(opaqueModelId(undefined), "");
  assert.equal(opaqueModelId(null), "");
  assert.equal(opaqueModelId("   "), "");
});

test("differsOnlyByCase is true only for a case variant of a non-empty name", () => {
  assert.equal(differsOnlyByCase("Minimax-M3.1-flash", "MiniMax-M3.1-Flash"), true);
  assert.equal(differsOnlyByCase("MiniMax-M3.1-Flash", "MiniMax-M3.1-Flash"), false);
  assert.equal(differsOnlyByCase("MiniMax-M3.1-Flash", "Claude-Sonnet-4"), false);
  assert.equal(differsOnlyByCase("", "MiniMax-M3.1-Flash"), false);
  assert.equal(differsOnlyByCase("MiniMax-M3.1-Flash", ""), false);
  assert.equal(differsOnlyByCase("", ""), false);
});

test("the confidence profile keeps the configured identifier byte-identically", () => {
  const resolved = resolveConfidenceProfile({ AI_CONFIDENCE_MODEL: "MiniMax-M3.1-Flash" });
  assert.equal(resolved.profile.model, "MiniMax-M3.1-Flash");
});

test("the confidence request carries the exact identifier on the wire, in both wire formats", async () => {
  const captured: Array<{ endpointPath: string; body: Record<string, unknown> }> = [];
  const transport = capturingTransport(captured, '{"score": 4, "risk": "low", "reason": "ok"}');
  for (const apiFormat of ["openai", "anthropic"] as const) {
    await runConfidenceScorer({
      profile: profile({ apiFormat }),
      primaryApiKey: "",
      prompt: { system: "s", user: "u" },
      connectTimeoutSec: 5,
      transport,
      findings: [],
      coverage: {},
    });
  }
  assert.equal(captured.length, 2);
  for (const request of captured) {
    assert.equal(request.body.model, "MiniMax-M3.1-Flash");
  }
  assert.equal(captured[0]!.endpointPath, "/chat/completions");
  assert.equal(captured[1]!.endpointPath, "/messages");
});

test("a successful confidence response is scored, not http_403", async () => {
  const captured: Array<{ endpointPath: string; body: Record<string, unknown> }> = [];
  const outcome = await runConfidenceScorer({
    profile: profile(),
    primaryApiKey: "",
    prompt: { system: "s", user: "u" },
    connectTimeoutSec: 5,
    transport: capturingTransport(captured, '{"score": 4, "risk": "low", "reason": "ok"}'),
    findings: [],
    coverage: {},
  });
  assert.equal(outcome.result.status, "scored");
  assert.equal(outcome.result.model, "MiniMax-M3.1-Flash");
});

test("published telemetry reports the same exact identifier", () => {
  const block = renderIndependentConfidenceBlock({
    status: "scored", score: "4", risk: "low", reason: "ok", model: "MiniMax-M3.1-Flash",
  }, "inert");
  assert.ok(block.includes("(model: MiniMax-M3.1-Flash)"), block);

  const outputs = formatReviewStepOutputs({
    verdict: "approve", verdictSource: "model", requiredChecks: "complete", reviewResult: "clean",
    incompleteReason: "none", reviewRoute: "primary", escalationReason: "",
    reviewTriageDecision: "", reviewTriageReason: "", reviewTriageRouting: "",
    findings: "[]", reviewMarkdown: "ok", analysisEngine: "engine", toolCalls: "[]", cacheHitRatio: "-",
    confidenceStatus: "scored", confidenceScore: "4", confidenceRisk: "low",
    confidenceReason: "ok", confidenceModel: "MiniMax-M3.1-Flash",
  }, () => new Uint8Array(16).fill(0xab));
  assert.ok(outputs.includes("confidence-model=MiniMax-M3.1-Flash\n"), outputs);
});

test("a case-mangled sibling model warns, and the configured identifier is never rewritten", () => {
  const resolved = resolveConfidenceProfile({
    AI_CONFIDENCE_MODEL: "Minimax-M3.1-flash",
    AI_MODEL: "MiniMax-M3.1-Flash",
  });
  assert.equal(resolved.profile.model, "Minimax-M3.1-flash");
  const nearMiss = resolved.warnings.filter((warning) => warning.includes("only in letter case"));
  assert.equal(nearMiss.length, 1, resolved.warnings.join("\n"));
  assert.ok(nearMiss[0]!.includes("ai-model"), nearMiss[0]!);
  assert.ok(nearMiss[0]!.includes("Minimax-M3.1-flash"), nearMiss[0]!);
  assert.ok(nearMiss[0]!.includes("MiniMax-M3.1-Flash"), nearMiss[0]!);
  assert.ok(nearMiss[0]!.includes("same endpoint"), nearMiss[0]!);
});

test("no case warning fires for an identical or a genuinely different sibling model", () => {
  const identical = resolveConfidenceProfile({
    AI_CONFIDENCE_MODEL: "MiniMax-M3.1-Flash",
    AI_MODEL: "MiniMax-M3.1-Flash",
  });
  assert.deepEqual(identical.warnings.filter((warning) => warning.includes("only in letter case")), []);

  const different = resolveConfidenceProfile({
    AI_CONFIDENCE_MODEL: "MiniMax-M3.1-Flash",
    AI_MODEL: "Claude-Sonnet-4",
  });
  assert.deepEqual(different.warnings.filter((warning) => warning.includes("only in letter case")), []);
});

test("the case warning names the smart and the fallback lane on the same endpoint", () => {
  const smart = resolveConfidenceProfile({
    AI_CONFIDENCE_MODEL: "minimax-m3.1-FLASH",
    AI_MODEL: "Claude-Sonnet-4",
    AI_SMART_MODEL: "minimax-m3.1-flash",
    AI_BASE_URL: "https://api.example.com",
  });
  const smartWarnings = smart.warnings.filter((warning) => warning.includes("only in letter case"));
  assert.equal(smartWarnings.length, 1, smart.warnings.join("\n"));
  assert.ok(smartWarnings[0]!.includes("ai-smart-model"), smartWarnings[0]!);

  const fallback = resolveConfidenceProfile({
    AI_CONFIDENCE_MODEL: "minimax-m3.1-FLASH",
    AI_MODEL: "Claude-Sonnet-4",
    AI_FALLBACK_MODEL: "minimax-m3.1-flash",
    AI_BASE_URL: "https://api.example.com",
  });
  const fallbackWarnings = fallback.warnings.filter((warning) => warning.includes("only in letter case"));
  assert.equal(fallbackWarnings.length, 1, fallback.warnings.join("\n"));
  assert.ok(fallbackWarnings[0]!.includes("ai-fallback-model"), fallbackWarnings[0]!);
});

test("the case warning stays silent when the names do not go to the same endpoint", () => {
  // The verifier runs against its own backend, so the two names belong to
  // two providers. Each provider names its own model as it likes, so the
  // case difference is not a typo the action can point at.
  const resolved = resolveConfidenceProfile({
    AI_CONFIDENCE_MODEL: "minimax-m3.1-flash",
    AI_MODEL: "MiniMax-M3.1-Flash",
    AI_BASE_URL: "https://gateway.example.com",
    AI_CONFIDENCE_BASE_URL: "https://minimax.example.com",
    AI_CONFIDENCE_API_KEY: "scorer-key",
  });
  assert.deepEqual(resolved.warnings.filter((warning) => warning.includes("only in letter case")), []);
});

test("the case warning stays silent when the verifier never calls the provider", () => {
  const disabled = resolveConfidenceProfile({ AI_MODEL: "MiniMax-M3.1-Flash" });
  assert.deepEqual(disabled.warnings.filter((warning) => warning.includes("only in letter case")), []);

  const fork = resolveConfidenceProfile({
    AI_CONFIDENCE_MODEL: "Minimax-M3.1-flash",
    AI_MODEL: "MiniMax-M3.1-Flash",
    IS_FORK_PR: "true",
  });
  assert.equal(fork.profile.enabled, false);
  assert.deepEqual(fork.warnings.filter((warning) => warning.includes("only in letter case")), []);
});

test("a model value that holds only whitespace is treated as unset, and the lane says so", () => {
  const tiers = resolveTierProfiles({
    AI_MODEL: "MiniMax-M3.1-Flash",
    AI_PRIMARY_MODEL: "   ",
  });
  // The whitespace-only override carries no name, so the lane inherits the
  // base model and says that it did.
  assert.equal(tiers.primary.model, "MiniMax-M3.1-Flash");
  assert.ok(
    tiers.warnings.some((warning) => warning.includes("ai-primary-model") && warning.includes("whitespace")),
    tiers.warnings.join("\n"),
  );

  const confidence = resolveConfidenceProfile({ AI_CONFIDENCE_MODEL: "  " });
  assert.equal(confidence.profile.enabled, false);
  assert.ok(
    confidence.warnings.some((warning) => warning.includes("ai-confidence-model") && warning.includes("whitespace")),
    confidence.warnings.join("\n"),
  );
});

test("a model name with padding is trimmed before it reaches the provider", () => {
  const profiles = resolveTierProfiles({
    AI_MODEL: "  MiniMax-M3.1-Flash  ",
    AI_SMART_MODEL: "MiniMax-M3.1-Flash ",
  });
  assert.equal(profiles.primary.model, "MiniMax-M3.1-Flash");
  // The padded smart name is the same model as the primary name, so the
  // smart lane is no longer a distinct escalation target.
  assert.equal(profiles.smart.model, profiles.primary.model);
});

test("the review and specialist lanes keep every configured model name exactly", () => {
  const profiles = resolveTierProfiles({
    AI_MODEL: "MiniMax-M3.1-Flash",
    AI_SMART_MODEL: "GLM-4.6",
    AI_FALLBACK_MODEL: "Qwen3-Coder-Next",
  });
  assert.equal(profiles.primary.model, "MiniMax-M3.1-Flash");
  assert.equal(profiles.smart.model, "GLM-4.6");
  assert.equal(profiles.fallback.model, "Qwen3-Coder-Next");

  const specialists = resolveSpecialistProfiles({
    AI_MODEL: "MiniMax-M3.1-Flash",
    AI_SPECIALIST_CORRECTNESS_MODEL: "MiniMax-M3.1-Flash",
  });
  assert.equal(specialists.roleModels.correctness.model, "MiniMax-M3.1-Flash");
});

test("the intentional lane mappings stay explicit and carry the name unchanged", () => {
  // The lane override wins; the base model fills in when the override is
  // empty. Both names reach the wire as written.
  const overridden = resolveTierProfiles({
    AI_MODEL: "MiniMax-M3.1-Flash",
    AI_PRIMARY_MODEL: "MiniMax-M3.1-Flash-Primary",
  });
  assert.equal(overridden.primary.model, "MiniMax-M3.1-Flash-Primary");

  const inherited = resolveTierProfiles({ AI_MODEL: "MiniMax-M3.1-Flash" });
  assert.equal(inherited.primary.model, "MiniMax-M3.1-Flash");

  const roleOverride = resolveSpecialistProfiles({
    AI_MODEL: "MiniMax-M3.1-Flash",
    AI_SPECIALIST_MODEL: "MiniMax-M3.1-Flash-Specialist",
    AI_SPECIALIST_SECURITY_MODEL: "MiniMax-M3.1-Flash-Security",
  });
  assert.equal(roleOverride.roleModels.security.model, "MiniMax-M3.1-Flash-Security");
  assert.equal(roleOverride.roleModels.correctness.model, "MiniMax-M3.1-Flash-Specialist");
});
