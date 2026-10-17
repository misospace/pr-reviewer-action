import test from "node:test";
import assert from "node:assert/strict";
import { ANTHROPIC_VERDICT_OUTPUT_FORMAT, buildAnthropicOutputConfig, buildModelRequest, OPENAI_VERDICT_JSON_SCHEMA } from "../src/model/request.js";
import { resolveSpecialistProfiles, resolveTierProfiles } from "../src/routing/tiers.js";
import type { ModelRequestConfig } from "../src/model/types.js";

// Frozen copy of the v2 `rf_json` bash literal (scripts/model_call.sh's
// json_schema arm) as of the #706 wave-0 re-point. The shell file is deleted
// in teardown wave 1; this snapshot keeps the byte-for-byte pin without
// reading v2 at test time.
const V2_RF_JSON_SCHEMA_LITERAL =
  '{"type":"json_schema","json_schema":{"name":"pr_review","strict":true,"schema":{"type":"object","properties":{"verdict":{"type":"string","enum":["approve","request_changes"]},"review_markdown":{"type":"string"},"smart_review_requested":{"type":"boolean"},"smart_review_reason":{"type":["string","null"]},"findings":{"type":["array","null"],"items":{"type":"object","properties":{"severity":{"type":"string","enum":["blocker","major","minor","info"]},"category":{"type":["string","null"]},"file":{"type":["string","null"]},"line":{"type":["integer","null"]},"message":{"type":"string"},"preliminary_finding":{"type":["integer","null"]},"end_line":{"type":["integer","null"],"description":"Inclusive last line of the affected range; use the same value as line for a single-line change, or null when the finding is not tied to a replaceable range."},"suggestion":{"type":["string","null"],"description":"Exact replacement text for the affected file lines (line through end_line), suitable for a one-click suggestion; null when you cannot provide a safe exact replacement."},"agent_prompt":{"type":["string","null"],"description":"A concise prompt a human can hand to a coding agent to make the fix; null when not applicable."}},"required":["severity","category","file","line","message","preliminary_finding","end_line","suggestion","agent_prompt"],"additionalProperties":false}},"requirement_coverage":{"type":["array","null"],"items":{"type":"object","properties":{"requirement_id":{"type":"string"},"status":{"type":"string","enum":["satisfied","violated","unknown"]},"evidence":{"type":["array","null"],"items":{"type":"object","properties":{"kind":{"type":"string","enum":["file","test","tool","ci","diff"]},"ref":{"type":["string","null"]},"detail":{"type":["string","null"]}},"required":["kind","ref","detail"],"additionalProperties":false}}},"required":["requirement_id","status","evidence"],"additionalProperties":false}},"required_check_dispositions":{"type":["array","null"],"items":{"type":"object","properties":{"check":{"type":"string"},"status":{"type":"string","enum":["satisfied","not_applicable","unresolved"]},"rationale":{"type":["string","null"]}},"required":["check","status","rationale"],"additionalProperties":false}}},"required":["verdict","review_markdown","smart_review_requested","smart_review_reason","findings","requirement_coverage","required_check_dispositions"],"additionalProperties":false}}}';

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
    // #998: unset by default so every pre-existing shape assertion below stays
    // a byte-compatibility pin.
    reasoningEffort: "",
    anthropicEffortSupported: false,
    // #1047: the structured-output opt-in, default off for byte compatibility.
    anthropicStructuredOutputSupported: false,
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

test("#1009: request body honors the resolved lane response_format", () => {
  // Each lane's effective value is chosen by the routing layer; this test
  // pins that the request body shape matches the chosen value and is
  // distinct across lanes. The omitted path is the request builder's
  // response to a lane override of `off`, so the per-lane selection is
  // an actual request-byte change between lanes, not just telemetry.
  const off = buildModelRequest(config({ responseFormat: "off" })).body as unknown as Record<string, unknown>;
  assert.equal("response_format" in off, false);
  const objectBody = buildModelRequest(config({ responseFormat: "json_object" })).body as unknown as Record<string, unknown>;
  assert.deepEqual(objectBody.response_format, { type: "json_object" });
  const schemaBody = buildModelRequest(config({ responseFormat: "json_schema" })).body as unknown as Record<string, unknown>;
  assert.deepEqual(schemaBody.response_format, OPENAI_VERDICT_JSON_SCHEMA);
});

test("#1009: anthropic lanes drop response_format regardless of the lane selection (#1009 acceptance)", () => {
  // Anthropic transport ignores OpenAI response_format semantics. The
  // routing layer can resolve a per-lane value of `json_schema` for an
  // Anthropic-format smart lane (the user might pipe it through anyway);
  // the request builder still drops the key, matching v2's request-shape
  // contract.
  for (const responseFormat of ["off", "json_object", "json_schema"] as const) {
    const payload = buildModelRequest(config({ apiFormat: "anthropic", responseFormat }));
    const body = payload.body as unknown as Record<string, unknown>;
    assert.equal("response_format" in body, false, responseFormat);
  }
});

// ── #998: profile-aware reasoning effort ────────────────────────────────

test("#998: an unset effort keeps the request body byte-compatible on both wire families", () => {
  // The unset case must be indistinguishable from a build without the
  // feature: no `reasoning_effort`, no `output_config`, nothing else moved.
  const openai = buildModelRequest(config()).body as unknown as Record<string, unknown>;
  assert.equal("reasoning_effort" in openai, false);
  assert.equal("output_config" in openai, false);
  const anthropic = buildModelRequest(config({ apiFormat: "anthropic" })).body as unknown as Record<string, unknown>;
  assert.equal("output_config" in anthropic, false);
  assert.equal("reasoning_effort" in anthropic, false);
  assert.deepEqual(
    buildModelRequest(config()),
    buildModelRequest(config({ reasoningEffort: "", anthropicEffortSupported: false })),
  );
  // An Anthropic call with the opt-in ON but no effort configured is still
  // byte-identical: the opt-in only permits the field, it does not invent one.
  assert.deepEqual(
    buildModelRequest(config({ apiFormat: "anthropic", anthropicEffortSupported: true })),
    buildModelRequest(config({ apiFormat: "anthropic" })),
  );
});

test("#998: the base effort reaches the primary OpenAI body as reasoning_effort", () => {
  const profiles = resolveTierProfiles({ AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_REASONING_EFFORT: "high" });
  assert.equal(profiles.primary.reasoningEffort, "high");
  const body = buildModelRequest(config({ reasoningEffort: profiles.primary.reasoningEffort })).body as unknown as Record<string, unknown>;
  assert.equal(body.reasoning_effort, "high");
  // Verbatim, never translated: no clamping, no invented vocabulary.
  const verbatim = resolveTierProfiles({ AI_REASONING_EFFORT: "xhigh-ultra" }).primary.reasoningEffort;
  assert.equal(verbatim, "xhigh-ultra");
  assert.equal(
    (buildModelRequest(config({ reasoningEffort: verbatim })).body as unknown as Record<string, unknown>).reasoning_effort,
    "xhigh-ultra",
  );
});

test("#998: a primary override beats the base, and the smart override applies only to the smart route", () => {
  const profiles = resolveTierProfiles({
    AI_BASE_URL: "https://primary",
    AI_MODEL: "main",
    AI_SMART_MODEL: "smart",
    AI_REASONING_EFFORT: "low",
    AI_PRIMARY_REASONING_EFFORT: "high",
    AI_SMART_REASONING_EFFORT: "xhigh",
  });
  assert.equal(profiles.primary.reasoningEffort, "high");
  assert.equal(profiles.smart.reasoningEffort, "xhigh");
  // Fallback is availability recovery, never escalation: it keeps the base.
  assert.equal(profiles.fallback.reasoningEffort, "low");
  const primaryBody = buildModelRequest(config({ reasoningEffort: profiles.primary.reasoningEffort })).body as unknown as Record<string, unknown>;
  const smartBody = buildModelRequest(config({ reasoningEffort: profiles.smart.reasoningEffort })).body as unknown as Record<string, unknown>;
  assert.equal(primaryBody.reasoning_effort, "high");
  assert.equal(smartBody.reasoning_effort, "xhigh");
  assert.notEqual(primaryBody.reasoning_effort, smartBody.reasoning_effort);
});

test("#998: the specialist override applies to specialist calls and inherits the primary value when empty", () => {
  const base = { AI_BASE_URL: "https://primary", AI_MODEL: "main", AI_SPECIALIST_MODEL: "specialist" };
  const inherited = resolveSpecialistProfiles({ ...base, AI_REASONING_EFFORT: "high" });
  assert.equal(inherited.transport.reasoningEffort, "high");
  // An explicit primary lane value is what the specialist lane inherits.
  const primaryLane = resolveSpecialistProfiles({ ...base, AI_REASONING_EFFORT: "low", AI_PRIMARY_REASONING_EFFORT: "high" });
  assert.equal(primaryLane.transport.reasoningEffort, "high");
  const overridden = resolveSpecialistProfiles({ ...base, AI_REASONING_EFFORT: "high", AI_SPECIALIST_REASONING_EFFORT: "minimal" });
  assert.equal(overridden.transport.reasoningEffort, "minimal");
  // Unset everywhere: nothing is emitted.
  assert.equal(resolveSpecialistProfiles(base).transport.reasoningEffort, "");
});

test("#998: Anthropic carries output_config.effort only under the explicit opt-in, never reasoning_effort", () => {
  const optedIn = buildModelRequest(config({ apiFormat: "anthropic", reasoningEffort: "high", anthropicEffortSupported: true }));
  assert.equal(optedIn.endpointPath, "/messages");
  assert.deepEqual((optedIn.body as unknown as Record<string, unknown>).output_config, { effort: "high" });
  // OpenAI's field never appears anywhere on the Anthropic wire family.
  assert.equal("reasoning_effort" in (optedIn.body as object), false);
  assert.equal(JSON.stringify(optedIn.body).includes("reasoning_effort"), false);
  // No `thinking` disable trick and no invented "none" effort.
  assert.equal("thinking" in (optedIn.body as object), false);
  assert.equal(JSON.stringify(optedIn.body).includes('"none"'), false);

  // Configured but NOT opted in: byte-compatible, no output_config at all.
  const notOptedIn = buildModelRequest(config({ apiFormat: "anthropic", reasoningEffort: "high", anthropicEffortSupported: false }));
  assert.deepEqual(notOptedIn, buildModelRequest(config({ apiFormat: "anthropic" })));
  // A malformed flag is not an opt-in (the helper only accepts "true").
  const env = { AI_BASE_URL: "https://p", AI_MODEL: "m", AI_API_FORMAT: "anthropic", AI_REASONING_EFFORT: "high", AI_ANTHROPIC_EFFORT_SUPPORT: "yes" };
  assert.equal(resolveTierProfiles(env).primary.reasoningEffort, "high");
  assert.equal(JSON.stringify(buildModelRequest(config({ apiFormat: "anthropic", reasoningEffort: "high", anthropicEffortSupported: false }))).includes("output_config"), false);
});

test("#998: buildAnthropicOutputConfig merges format and effort without either overwriting the other", () => {
  assert.deepEqual(buildAnthropicOutputConfig("high", { type: "json_schema" }), {
    format: { type: "json_schema" },
    effort: "high",
  });
  assert.deepEqual(buildAnthropicOutputConfig("high", undefined), { effort: "high" });
  assert.deepEqual(buildAnthropicOutputConfig("", { type: "json_object" }), { format: { type: "json_object" } });
  // Nothing to merge ⇒ no key at all (so the body stays byte-compatible).
  assert.equal(buildAnthropicOutputConfig(""), null);
  assert.equal(buildAnthropicOutputConfig("", undefined), null);
  assert.equal(buildAnthropicOutputConfig("", null), null);
  // Neither key clobbers the other, and a null/undefined format is dropped
  // rather than sent as a null.
  const merged = buildAnthropicOutputConfig("high", { type: "json_schema" });
  assert.equal((merged as Record<string, unknown>).effort, "high");
  assert.deepEqual((merged as Record<string, unknown>).format, { type: "json_schema" });
});

// ── #1047: Anthropic-native structured output ───────────────────────────

test("#1047: json_schema + opt-in sends output_config.format with the verdict schema", () => {
  const payload = buildModelRequest(config({
    apiFormat: "anthropic",
    responseFormat: "json_schema",
    anthropicStructuredOutputSupported: true,
  }));
  assert.equal(payload.endpointPath, "/messages");
  const body = payload.body as unknown as Record<string, unknown>;
  const outputConfig = body.output_config as Record<string, unknown> | undefined;
  assert.ok(outputConfig, "output_config must be present");
  assert.deepEqual(outputConfig.format, ANTHROPIC_VERDICT_OUTPUT_FORMAT);
  // The envelope carries the SAME inner schema the OpenAI json_schema mode
  // enforces — one verdict contract, two wire families.
  assert.deepEqual(outputConfig.format, {
    type: "json_schema",
    schema: (OPENAI_VERDICT_JSON_SCHEMA.json_schema as { schema: unknown }).schema,
  });
  // The OpenAI wrapper never leaks onto the Anthropic wire.
  assert.equal(JSON.stringify(outputConfig).includes("json_schema\":{"), false);
  assert.equal("response_format" in body, false);
  // The whole body stays valid JSON with no OpenAI-only keys.
  assert.equal(JSON.stringify(body).includes("response_format"), false);
});

test("#1047: json_schema without the opt-in is never silently enforced (byte-compatible)", () => {
  // The truth-telling core of #1047: a resolved json_schema on an un-asserted
  // Anthropic endpoint sends NOTHING — byte-identical to off — and no
  // json_object-style translation is invented.
  for (const responseFormat of ["off", "json_object", "json_schema"] as const) {
    const unasserted = buildModelRequest(config({ apiFormat: "anthropic", responseFormat }));
    assert.deepEqual(unasserted, buildModelRequest(config({ apiFormat: "anthropic", responseFormat: "off" })), responseFormat);
  }
  // json_object + opt-in is ALSO nothing: there is no Anthropic-native
  // json_object to opt into, so the flag cannot make one appear.
  assert.deepEqual(
    buildModelRequest(config({ apiFormat: "anthropic", responseFormat: "json_object", anthropicStructuredOutputSupported: true })),
    buildModelRequest(config({ apiFormat: "anthropic", responseFormat: "off" })),
  );
  // And the flag alone (json_schema unset) still sends nothing.
  assert.deepEqual(
    buildModelRequest(config({ apiFormat: "anthropic", responseFormat: "off", anthropicStructuredOutputSupported: true })),
    buildModelRequest(config({ apiFormat: "anthropic", responseFormat: "off" })),
  );
});

test("#1047: format and effort merge in one output_config without clobbering", () => {
  const payload = buildModelRequest(config({
    apiFormat: "anthropic",
    responseFormat: "json_schema",
    reasoningEffort: "medium",
    anthropicStructuredOutputSupported: true,
    anthropicEffortSupported: true,
  }));
  const body = payload.body as unknown as Record<string, unknown>;
  assert.deepEqual(body.output_config, {
    format: ANTHROPIC_VERDICT_OUTPUT_FORMAT,
    effort: "medium",
  });
  // Each key still honors its own opt-in: format asserted, effort not.
  const effortless = buildModelRequest(config({
    apiFormat: "anthropic",
    responseFormat: "json_schema",
    reasoningEffort: "medium",
    anthropicStructuredOutputSupported: true,
    anthropicEffortSupported: false,
  }));
  assert.deepEqual((effortless.body as unknown as Record<string, unknown>).output_config, {
    format: ANTHROPIC_VERDICT_OUTPUT_FORMAT,
  });
});

test("#1047: the Anthropic output format envelope carries the exact verdict schema object", () => {
  const inner = (OPENAI_VERDICT_JSON_SCHEMA.json_schema as { schema: Record<string, unknown> }).schema;
  assert.deepEqual(ANTHROPIC_VERDICT_OUTPUT_FORMAT, { type: "json_schema", schema: inner });
  // And it is a plain (non-wrapped) JSON-Schema object: type/properties/
  // required at the top, exactly the shape the Messages API documents.
  assert.equal((ANTHROPIC_VERDICT_OUTPUT_FORMAT.schema as Record<string, unknown>).type, "object");
  assert.ok("properties" in (ANTHROPIC_VERDICT_OUTPUT_FORMAT.schema as Record<string, unknown>));
});

test("#998: a hostile or malformed effort never reaches a request body", () => {
  // #252: feed the boundary its own adversarial values. Each is dropped as
  // unset (with a warning) at resolution time, so no provider request can
  // carry a quote, a newline, a dash-led token, or an over-long one.
  const hostile = ['high"', "high\nreasoning_effort: \"low\"", "-high", "high high", "a".repeat(33), "9lives", ""];
  for (const value of hostile) {
    const profiles = resolveTierProfiles({ AI_BASE_URL: "https://p", AI_MODEL: "m", AI_REASONING_EFFORT: value });
    const body = buildModelRequest(config({ reasoningEffort: profiles.primary.reasoningEffort })).body as unknown as Record<string, unknown>;
    assert.equal("reasoning_effort" in body, false, JSON.stringify(value));
    const anthropic = buildModelRequest(config({
      apiFormat: "anthropic",
      reasoningEffort: profiles.primary.reasoningEffort,
      anthropicEffortSupported: true,
    })).body as unknown as Record<string, unknown>;
    assert.equal("output_config" in anthropic, false, JSON.stringify(value));
  }
  // The whole body is still valid JSON — a dropped value can never corrupt
  // the request bytes.
  assert.doesNotThrow(() => JSON.stringify(buildModelRequest(config()).body));
});

test("request construction is provider-neutral: no branching on model names", () => {
  const a = buildModelRequest(config({ model: "gpt-9-mini" }));
  const b = buildModelRequest(config({ model: "qwen3-local@proxy" }));
  assert.deepEqual(
    { ...(a.body as object), model: undefined },
    { ...(b.body as object), model: undefined },
  );
});

test("the strict verdict schema matches the frozen v2 bash literal plus only the v3 triage fields (#1003)", () => {
  // #1003 adds exactly two properties (the human-review triage answer) and
  // two `required` entries on top of the frozen v2 literal. #1005 adds the
  // `review_triage_targets` logical-id selection alongside the #1003 pair.
  // Strip every `review_triage_*` property and required entry and the pin is
  // byte-for-byte the v2 snapshot again, so a future drift in anything else
  // still fails here.
  const live = structuredClone(OPENAI_VERDICT_JSON_SCHEMA) as {
    json_schema: { schema: { properties: Record<string, unknown>; required: string[] } };
  };
  const schema = live.json_schema.schema;
  for (const key of Object.keys(schema.properties)) {
    if (key.startsWith("review_triage_")) delete schema.properties[key];
  }
  schema.required = schema.required.filter((name) => !name.startsWith("review_triage_"));
  assert.deepEqual(live, JSON.parse(V2_RF_JSON_SCHEMA_LITERAL));
});

test("the strict verdict schema requires every property (OpenAI strict mode)", () => {
  const schema = (OPENAI_VERDICT_JSON_SCHEMA.json_schema as unknown as Record<string, unknown>).schema as unknown as Record<string, unknown>;
  assert.deepEqual(
    schema.required,
    ["verdict", "review_markdown", "smart_review_requested", "smart_review_reason", "review_triage_decision", "review_triage_reason", "review_triage_targets", "findings", "requirement_coverage", "required_check_dispositions"],
  );
  const properties = schema.properties as unknown as Record<string, { type: unknown; enum?: string[] }>;
  assert.deepEqual(properties.smart_review_requested!.type, "boolean");
  assert.deepEqual(properties.smart_review_reason!.type, ["string", "null"]);
  // #1003: the triage decision is exactly the three literal words; there is
  // no fourth value for a malformed answer to normalize into.
  assert.deepEqual(properties.review_triage_decision!.enum, ["not_required", "required", "unknown"]);
  assert.deepEqual(properties.review_triage_decision!.type, "string");
  assert.deepEqual(properties.review_triage_reason!.type, ["string", "null"]);
  // #1005: routing targets are a nullable array of strings; the parser caps
  // the list and drops non-string/empty/oversized entries.
  assert.deepEqual(properties.review_triage_targets!.type, ["array", "null"]);
  assert.deepEqual(
    (properties.review_triage_targets as unknown as { items: { type: string } }).items.type,
    "string",
  );
  const findings = properties.findings! as unknown as { type: string[] };
  assert.deepEqual(findings.type, ["array", "null"]);
  // #750: one disposition per deterministic must_check item; identity is
  // the echoed check text; not_applicable carries a grounded rationale.
  const dispositions = properties.required_check_dispositions! as unknown as {
    type: string[];
    items: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
  };
  assert.deepEqual(dispositions.type, ["array", "null"]);
  assert.deepEqual(dispositions.items.required, ["check", "status", "rationale"]);
  assert.equal(dispositions.items.additionalProperties, false);
  assert.deepEqual(
    (dispositions.items.properties.status as { enum: string[] }).enum,
    ["satisfied", "not_applicable", "unresolved"],
  );
});
