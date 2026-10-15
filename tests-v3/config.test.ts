import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validateContract } from "../src/config/contract.js";
import { V3_CONTRACT } from "../.v3-generated/contract.generated.js";
import { EMPTY_DISABLING_INPUTS, loadConfig, REASONING_EFFORT_INPUTS, toCamelCase } from "../src/config/load-config.js";
import { isSecretValue, redactConfig, toJSON } from "../src/config/types.js";
import { BOOLEAN_INPUTS, ENUM_INPUTS, FLOAT_INPUTS, INTEGER_INPUTS, SECRET_INPUTS } from "../src/config/schema.js";
import { tierReasoningEffort } from "../src/routing/tiers.js";
import { assertSupportedNode } from "../src/runtime/node-version.js";

const source = readFileSync("contracts/action-v3.yml", "utf8");
const rawContract: unknown = parse(source);
const contract = validateContract(rawContract);

test("Forgejo Authorized Integration requires an audience and refuses an explicit token before review", () => {
  const base = { "ai-base-url": "https://llm.example", "ai-model": "m", "forgejo-auth-method": "authorized_integration" };
  assert.throws(
    () => loadConfig(contract, base),
    /forgejo-authorized-integration-audience.*required/,
  );
  assert.throws(
    () => loadConfig(contract, { ...base, "forgejo-authorized-integration-audience": "   " }),
    /forgejo-authorized-integration-audience.*required/,
  );
  assert.throws(
    () => loadConfig(contract, { ...base, "forgejo-authorized-integration-audience": "aud", "forgejo-token": "secret" }),
    /forgejo-token.*cannot be set.*token' mode/,
  );
  assert.equal(loadConfig(contract, { ...base, "forgejo-authorized-integration-audience": "aud" }).forgejoAuthMethod, "authorized_integration");
  assert.equal(loadConfig(contract, { ...base, "forgejo-auth-method": "token", "forgejo-token": "secret" }).forgejoAuthMethod, "token");
});

test("current canonical contract validates and maps every input once", () => {
  const raw = Object.fromEntries(contract.inputs.map((input) => [input.id, input.default === undefined ? "test-value" : String(input.default)]));
  const config = loadConfig(contract, raw);
  for (const input of contract.inputs) {
    assert.ok(Object.hasOwn(config, toCamelCase(input.id)), input.id);
    assert.equal(toCamelCase(input.id).includes("_"), false);
  }
  assert.equal(contract.inputs.length, 158);
  assert.equal(Object.hasOwn(config, "ai_base_url"), false);
});

test("#1009: per-lane response_format inputs default empty and inherit ai-response-format; explicit values are preserved; enum rejects bad values", () => {
  // No lane override: effective primary/smart/fallback values all match
  // the base (`off`). Existing single-value workflows stay request-byte
  // compatible.
  const baseline = loadConfig(contract, {
    "ai-base-url": "https://primary",
    "ai-model": "main",
  });
  assert.equal(baseline.aiResponseFormat, "off");
  assert.equal(baseline.aiPrimaryResponseFormat, "off");
  assert.equal(baseline.aiSmartResponseFormat, "off");
  assert.equal(baseline.aiFallbackResponseFormat, "off");

  // Base value changes: each lane override (empty) inherits the base.
  const jsonObject = loadConfig(contract, {
    ...Object.fromEntries(contract.inputs.map((input) => [input.id, ""])),
    "ai-base-url": "https://primary",
    "ai-model": "main",
    "ai-response-format": "json_object",
  });
  assert.equal(jsonObject.aiResponseFormat, "json_object");
  assert.equal(jsonObject.aiPrimaryResponseFormat, "json_object");
  assert.equal(jsonObject.aiSmartResponseFormat, "json_object");
  assert.equal(jsonObject.aiFallbackResponseFormat, "json_object");

  // Explicit lane overrides are preserved (and never coalesced back to the
  // base setting — only empty values inherit).
  const overrides = loadConfig(contract, {
    "ai-base-url": "https://primary",
    "ai-model": "main",
    "ai-response-format": "json_object",
    "ai-primary-response-format": "off",
    "ai-smart-response-format": "json_schema",
    "ai-fallback-response-format": "json_object",
  });
  assert.equal(overrides.aiPrimaryResponseFormat, "off");
  assert.equal(overrides.aiSmartResponseFormat, "json_schema");
  assert.equal(overrides.aiFallbackResponseFormat, "json_object");

  // Invalid values: rejected by the existing enum validator.
  const required = Object.fromEntries(contract.inputs.filter((input) => input.required).map((input) => [input.id, `required-${input.id}`]));
  for (const id of ["ai-primary-response-format", "ai-smart-response-format", "ai-fallback-response-format"]) {
    assert.throws(
      () => loadConfig(contract, { ...required, "ai-response-format": "json_object", [id]: "bogus" }),
      new RegExp(`must be one of: off, json_object, json_schema`),
      id,
    );
  }

  // Each per-lane override can also be left empty without disturbing the
  // sibling lanes or the base setting.
  const onlyPrimary = loadConfig(contract, {
    "ai-base-url": "https://primary",
    "ai-model": "main",
    "ai-response-format": "json_schema",
    "ai-primary-response-format": "",
    "ai-smart-response-format": "json_object",
    "ai-fallback-response-format": "json_schema",
  });
  assert.equal(onlyPrimary.aiPrimaryResponseFormat, "json_schema");
  assert.equal(onlyPrimary.aiSmartResponseFormat, "json_object");
  assert.equal(onlyPrimary.aiFallbackResponseFormat, "json_schema");
});

test("#998: reasoning-effort inputs default empty, inherit per lane, pass values through, and reject malformed values loudly", async () => {
  // Declared, optional, and empty by default: an unset configuration must
  // resolve to no effort anywhere, which is what keeps request bytes
  // identical to a build without the feature.
  const baseline = loadConfig(contract, { "ai-base-url": "https://primary", "ai-model": "main" });
  assert.equal(baseline.aiReasoningEffort, "");
  assert.equal(baseline.aiPrimaryReasoningEffort, "");
  assert.equal(baseline.aiSmartReasoningEffort, "");
  assert.equal(baseline.aiFallbackReasoningEffort, "");
  assert.equal(baseline.aiSpecialistReasoningEffort, "");
  // The Anthropic opt-in is a boolean input defaulting to false — the
  // endpoint assertion is never implied by configuring an effort.
  assert.equal(baseline.aiAnthropicEffortSupport, false);
  for (const id of ["ai-reasoning-effort", "ai-primary-reasoning-effort", "ai-smart-reasoning-effort", "ai-fallback-reasoning-effort", "ai-specialist-reasoning-effort"]) {
    const input = contract.inputs.find((entry) => entry.id === id);
    assert.ok(input, id);
    assert.equal(input.required, false, id);
    assert.equal(input.default, "", id);
    assert.equal(input["repo-configurable"], undefined, `${id} is operator-only`);
  }
  assert.equal(ENUM_INPUTS["ai-reasoning-effort"], undefined, "free-form, not an enum");

  // Base value: each lane override (empty) inherits it, and the specialist
  // input inherits the primary lane's resolved value.
  const inherited = loadConfig(contract, {
    "ai-base-url": "https://primary",
    "ai-model": "main",
    "ai-reasoning-effort": "high",
  });
  assert.equal(inherited.aiReasoningEffort, "high");
  assert.equal(inherited.aiPrimaryReasoningEffort, "high");
  assert.equal(inherited.aiSmartReasoningEffort, "high");
  // #1053: the fallback override stays "" in the RESOLVED config when unset
  // — the lane inherits the base at request time in `tierReasoningEffort`
  // instead, so an installation that never configured the new input keeps
  // the unset value distinguishable from a configured one at the
  // fingerprint boundary.
  assert.equal(inherited.aiFallbackReasoningEffort, "");
  assert.equal(inherited.aiSpecialistReasoningEffort, "high");

  // Explicit lane overrides win, and normalization is trim + lowercase (no
  // vocabulary is imposed: `xhigh-ultra` is as valid as `high`).
  const overrides = loadConfig(contract, {
    "ai-base-url": "https://primary",
    "ai-model": "main",
    "ai-reasoning-effort": "low",
    "ai-primary-reasoning-effort": "HIGH",
    "ai-smart-reasoning-effort": "  xhigh-ultra  ",
    "ai-specialist-reasoning-effort": "minimal_1",
    "ai-anthropic-effort-support": "true",
  });
  assert.equal(overrides.aiReasoningEffort, "low");
  assert.equal(overrides.aiPrimaryReasoningEffort, "high");
  assert.equal(overrides.aiSmartReasoningEffort, "xhigh-ultra");
  assert.equal(overrides.aiSpecialistReasoningEffort, "minimal_1");
  assert.equal(overrides.aiAnthropicEffortSupport, true);

  // #1053: the fallback lane now has its own override, independent of the
  // base. With the base set to "low" and the fallback lane to "high", the
  // primary and smart lanes still inherit the base while the fallback lane
  // uses its own value — confirming the per-lane override and that
  // specialists still inherit the primary lane's resolved effort.
  const fallbackOverride = loadConfig(contract, {
    "ai-base-url": "https://primary",
    "ai-model": "main",
    "ai-reasoning-effort": "low",
    "ai-fallback-reasoning-effort": "high",
  });
  assert.equal(fallbackOverride.aiReasoningEffort, "low");
  assert.equal(fallbackOverride.aiPrimaryReasoningEffort, "low");
  assert.equal(fallbackOverride.aiSmartReasoningEffort, "low");
  assert.equal(fallbackOverride.aiFallbackReasoningEffort, "high");
  assert.equal(fallbackOverride.aiSpecialistReasoningEffort, "low");

  // #252: a dropped fallback value is announced by key and the lane then
  // falls back to the base (no crash, no silent clamp).
  const fallbackRequired = Object.fromEntries(contract.inputs.filter((input) => input.required).map((input) => [input.id, `required-${input.id}`]));
  const fallbackWarnings: string[] = [];
  const captureFallback = (warning: Error): void => { fallbackWarnings.push(warning.message); };
  process.on("warning", captureFallback);
  let droppedFallback: ReturnType<typeof loadConfig>;
  try {
    droppedFallback = loadConfig(contract, { ...fallbackRequired, "ai-reasoning-effort": "low", "ai-fallback-reasoning-effort": "-bad" });
    // process.emitWarning delivers on the next tick, so the assertion needs
    // the listener still attached when the event fires.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(droppedFallback.aiFallbackReasoningEffort, "", "a dropped value stays unset in the resolved config (#1053)");
    // The lane still falls back to the base at request time: the resolved
    // stage env carries the empty override and `tierReasoningEffort`
    // inherits the base from it.
    assert.equal(
      tierReasoningEffort("fallback", { AI_REASONING_EFFORT: "low", AI_FALLBACK_REASONING_EFFORT: "" }),
      "low",
      "the dropped fallback value behaves as unset and inherits the base",
    );
    assert.ok(
      fallbackWarnings.some((message) => message.includes("ai-fallback-reasoning-effort")),
      `ai-fallback-reasoning-effort is announced by key: ${fallbackWarnings.join(" | ")}`,
    );
    assert.equal(fallbackWarnings.some((message) => message.includes("-bad")), false, "the rejected value is never echoed into the notice");
  } finally {
    process.off("warning", captureFallback);
  }

  // The opt-in is a strict boolean like every other boolean input.
  assert.throws(
    () => loadConfig(contract, { "ai-base-url": "https://primary", "ai-model": "main", "ai-anthropic-effort-support": "yes" }),
    /must be 'true' or 'false'/,
  );

  // #252: malformed values are rejected AT THE BOUNDARY ITSELF — dropped as
  // unset with a loud warning naming the key, never a crash and never a
  // silent clamp. The rejected text must not survive into the config.
  const required = Object.fromEntries(contract.inputs.filter((input) => input.required).map((input) => [input.id, `required-${input.id}`]));
  const warnings: string[] = [];
  const onWarning = (warning: Error): void => { warnings.push(warning.message); };
  process.on("warning", onWarning);
  try {
    const dropped = loadConfig(contract, { ...required, "ai-reasoning-effort": "high", "ai-primary-reasoning-effort": "-bad" });
    // A dropped lane value then behaves as unset: it inherits the base rather
    // than failing the run.
    assert.equal(dropped.aiPrimaryReasoningEffort, "high");
    const badValues = [
      ["ai-reasoning-effort", 'high"'],
      ["ai-primary-reasoning-effort", "high\nreasoning_effort"],
      ["ai-smart-reasoning-effort", "-high"],
      ["ai-fallback-reasoning-effort", "-bad"],
      ["ai-specialist-reasoning-effort", "a".repeat(33)],
    ] as const;
    const droppedConfigs = badValues.map(([id, bad]) => [
      id,
      bad,
      loadConfig(contract, { ...required, [id]: bad }),
    ] as const);
    // process.emitWarning delivers on the next tick.
    await new Promise((resolve) => setImmediate(resolve));
    for (const [id, bad, config] of droppedConfigs) {
      assert.equal((config as Record<string, unknown>)[toCamelCase(id)], "", id);
      assert.ok(warnings.some((message) => message.includes(id)), `${id} is announced by key: ${warnings.join(" | ")}`);
      assert.equal(warnings.some((message) => message.includes(bad)), false, "the rejected value is never echoed into the notice");
    }
  } finally {
    process.off("warning", onWarning);
  }
});

test("#1057: empty-disabling carve-outs are never no-ops and every effort input is registered", () => {
  const byId = new Map(contract.inputs.map((input) => [input.id, input]));
  // An input whose contract default is already "" preserves an explicit ""
  // by construction, so listing it in EMPTY_DISABLING_INPUTS would be
  // redundant registration. Every member must actually need the carve-out.
  for (const id of EMPTY_DISABLING_INPUTS) {
    const input = byId.get(id);
    assert.ok(input, `EMPTY_DISABLING_INPUTS entry '${id}' is a contract input`);
    assert.notEqual(input!.default, "", `EMPTY_DISABLING_INPUTS entry '${id}' must have a non-empty default`);
  }
  // The free-form effort family is validated by shape, not by an ENUM_INPUTS
  // vocabulary: a new lane override (e.g. #1053) that is not registered here
  // would skip the boundary check. Pin the whole family both ways.
  const family = contract.inputs.map((input) => input.id).filter((id) => id.endsWith("-reasoning-effort"));
  for (const id of family) {
    assert.ok(REASONING_EFFORT_INPUTS.has(id), `reasoning-effort input '${id}' is registered for shape validation`);
  }
  for (const id of REASONING_EFFORT_INPUTS) {
    assert.ok(byId.has(id), `REASONING_EFFORT_INPUTS entry '${id}' is a contract input`);
  }
});

test("#875: equivalent-paths-max-bytes is a positive integer — zero and negative are rejected", () => {
  // Matches related-code-max-bytes: 0 must not silently fall back to the
  // 6000 default, and a negative value must not reach the clipping helper
  // (which would reject it and leave the hint empty).
  const required = Object.fromEntries(contract.inputs.filter((input) => input.required).map((input) => [input.id, `required-${input.id}`]));
  for (const bad of ["0", "-1"]) {
    assert.throws(
      () => loadConfig(contract, { ...required, "equivalent-paths-max-bytes": bad }),
      (e: unknown) => e instanceof Error && e.message === "Input 'equivalent-paths-max-bytes' must be at least 1",
      bad,
    );
  }
  // Unset keeps the contract default.
  const config = loadConfig(contract, required);
  assert.equal(config.equivalentPathsMaxBytes, 6000);
});

test("contract defaults and typed parsing agree for every input", () => {
  const required = Object.fromEntries(contract.inputs.filter((input) => input.required).map((input) => [input.id, `required-${input.id}`]));
  const config = loadConfig(contract, required);
  const empty = loadConfig(contract, {
    ...required,
    "ai-fallback-base-url": "",
    "ai-primary-model": "",
  });
  assert.equal(empty.aiFallbackBaseUrl, empty.aiBaseUrl);
  assert.equal(empty.aiPrimaryModel, empty.aiModel);
  const inherited: Readonly<Record<string, keyof typeof config>> = {
    "ai-fallback-base-url": "aiBaseUrl",
    "ai-fallback-api-format": "aiApiFormat",
    "ai-fallback-api-key": "aiApiKey",
    "ai-fallback-request-timeout-sec": "aiRequestTimeoutSec",
    "ai-fallback-connect-timeout-sec": "aiConnectTimeoutSec",
    "ai-fallback-stream": "aiStream",
    // #1009: per-lane `response_format` inherits the base setting when
    // explicitly empty; config inheritance is the single source of truth
    // for which effective value each lane's request body uses.
    "ai-primary-response-format": "aiResponseFormat",
    "ai-smart-response-format": "aiResponseFormat",
    "ai-fallback-response-format": "aiResponseFormat",
    // #998: per-lane reasoning effort inherits the base when empty, and the
    // specialist input inherits the primary lane's already-resolved value.
    "ai-primary-reasoning-effort": "aiReasoningEffort",
    "ai-smart-reasoning-effort": "aiReasoningEffort",
    // #1053: NOT inherited at load on purpose. The resolved value is
    // projected verbatim into the stage env and `AI_FALLBACK_REASONING_EFFORT`
    // feeds the config fingerprint, so copying the base into an unset
    // override would change existing fingerprints on upgrade. The fallback
    // lane inherits the base in `tierReasoningEffort` instead, keeping the
    // unset configuration request-byte compatible with #998.
    "ai-specialist-reasoning-effort": "aiPrimaryReasoningEffort",
    "ai-primary-model": "aiModel",
    "ai-primary-base-url": "aiBaseUrl",
    "ai-primary-api-format": "aiApiFormat",
    "ai-primary-api-key": "aiApiKey",
    "ai-smart-base-url": "aiBaseUrl",
    "ai-smart-api-format": "aiApiFormat",
    "ai-smart-api-key": "aiApiKey",
    "primary-model-context-tokens": "modelContextTokens",
    "smart-model-context-tokens": "modelContextTokens",
  };
  for (const input of contract.inputs) {
    const key = toCamelCase(input.id) as keyof typeof config;
    // A `${{ ... }}` default is evaluated by the runner, not the loader.
    const runnerExpression = typeof input.default === "string" && input.default.startsWith("${{");
    const text = input.required ? required[input.id]! : input.default === undefined || runnerExpression ? "" : String(input.default);
    const expected = BOOLEAN_INPUTS.has(input.id) && text !== "" ? text === "true"
      : (INTEGER_INPUTS.has(input.id) || FLOAT_INPUTS.has(input.id)) && text !== "" ? Number(text) : text;
    const inheritedKey = inherited[input.id];
    if (SECRET_INPUTS.has(input.id)) {
      assert.ok(isSecretValue(config[key]), input.id);
      assert.equal(config[key].present, inheritedKey ? isSecretValue(config[inheritedKey]) && config[inheritedKey].present : text !== "", input.id);
    } else if (inheritedKey && text === "") {
      assert.equal(config[key], config[inheritedKey], input.id);
    } else {
      assert.equal(config[key], expected, input.id);
    }
  }
  for (const id of [...BOOLEAN_INPUTS, ...INTEGER_INPUTS, ...FLOAT_INPUTS, ...Object.keys(ENUM_INPUTS), ...SECRET_INPUTS]) {
    assert.ok(contract.inputs.some((input) => input.id === id), `schema entry ${id} is in the contract`);
  }
  for (const input of contract.inputs.filter((entry) => entry.required)) {
    const missing = { ...required };
    delete missing[input.id];
    assert.throws(() => loadConfig(contract, missing), new RegExp(`Required input '${input.id}' is missing`));
    assert.throws(() => loadConfig(contract, { ...required, [input.id]: "" }), new RegExp(`Required input '${input.id}' is missing`));
  }
});

test("contract accepts v3-only inputs and validates legacy mappings", () => {
  const makeContract = (input: Record<string, unknown>): unknown => ({
    schema_version: 1,
    contract: "github-action",
    inputs: [input],
    outputs: [],
    removed: [],
  });
  const base = { id: "new-v3-input", required: false, description: "v3-only input" };
  assert.equal(validateContract(makeContract(base)).inputs[0]?.v2_id, undefined);

  const withLegacyId = validateContract(makeContract({ ...base, id: "legacy-input", v2_id: "legacy_input" }));
  assert.equal(withLegacyId.inputs[0]?.v2_id, "legacy_input");
});

test("contract validation rejects malformed schema and collisions", () => {
  const mutate = (change: (copy: Record<string, unknown>) => void): unknown => {
    const copy = structuredClone(rawContract) as Record<string, unknown>;
    change(copy);
    return copy;
  };
  assert.throws(() => validateContract(mutate((v) => { v.schema_version = 2; })), /schema_version/);
  assert.throws(() => validateContract(mutate((v) => { delete v.inputs; })), /must be arrays/);
  assert.throws(() => validateContract(mutate((v) => { (v.inputs as unknown[])[1] = {}; })), /inputs\[1\]\.id/);
  assert.throws(() => validateContract(mutate((v) => { (v.inputs as Record<string, unknown>[])[1]!.id = "pr-number"; })), /duplicate canonical id/);
  assert.throws(() => validateContract(mutate((v) => { (v.inputs as Record<string, unknown>[])[1]!.v2_id = "github_token"; })), /duplicate active v2_id/);
  assert.throws(() => validateContract(mutate((v) => { (v.inputs as Record<string, unknown>[])[1]!.id = "bad_id"; })), /underscores/);
  assert.throws(() => validateContract(mutate((v) => { (v.inputs as Record<string, unknown>[])[1]!.id = "Bad"; (v.inputs as Record<string, unknown>[])[1]!.v2_id = "bad"; })), /valid Action identifier/);
  assert.throws(() => validateContract(mutate((v) => { (v.inputs as Record<string, unknown>[])[1]!.v2_id = "other"; })), /mechanically map/);
  assert.throws(() => validateContract(mutate((v) => { (v.inputs as Record<string, unknown>[])[1]!.default = []; })), /default/);
  assert.throws(() => validateContract(mutate((v) => { (v.removed as Record<string, unknown>[])[0]!.v2_id = "repo"; })), /collides with active/);
});

test("defaults are contract sourced and parsing is explicit", () => {
  const raw = Object.fromEntries(contract.inputs.map((input) => [input.id, input.default === undefined ? "present" : String(input.default)]));
  raw["ai-stream"] = "false";
  raw["ai-max-tokens"] = "8192";
  delete raw["ai-temperature"];
  const config = loadConfig(contract, raw);
  assert.equal(config.aiStream, false);
  assert.equal(config.aiMaxTokens, 8192);
  assert.equal(loadConfig(contract, { ...raw, "ai-max-tokens": "" }).aiMaxTokens, 16384);
  assert.equal(loadConfig(contract, { ...raw, "ai-max-tokens": "12" }).aiMaxTokens, 12);
  assert.equal(config.aiTemperature, 0.1);
  assert.equal(loadConfig(contract, { ...raw, "ai-temperature": "" }).aiTemperature, "");
  // #914: rereview-command is an empty-string carve-out like ai-temperature —
  // an explicit "" disables comment-triggered re-reviews, so it must not fall
  // back to the "/ai-review" default.
  const noRereviewCommand = { ...raw };
  delete noRereviewCommand["rereview-command"];
  assert.equal(loadConfig(contract, noRereviewCommand).rereviewCommand, "/ai-review");
  assert.equal(loadConfig(contract, { ...raw, "rereview-command": "" }).rereviewCommand, "");
  assert.equal(loadConfig(contract, { ...raw, "rereview-command": "/rerun" }).rereviewCommand, "/rerun");
  // The carve-out did not widen: an explicit empty rereview-label still falls
  // back to its default.
  assert.equal(loadConfig(contract, { ...raw, "rereview-label": "" }).rereviewLabel, "ai-review");
  assert.equal(config.aiFallbackBaseUrl, config.aiBaseUrl);
  assert.equal(config.aiPrimaryModel, config.aiModel);
  assert.equal(config.aiFallbackStream, config.aiStream);
  assert.equal(config.aiMaxTokens, 8192);
  assert.throws(() => loadConfig(contract, { ...raw, "ai-max-tokens": "12foo" }), /must be an integer/);
  assert.throws(() => loadConfig(contract, { ...raw, "ai-max-tokens": "Infinity" }), /must be an integer/);
  assert.throws(() => loadConfig(contract, { ...raw, "ai-max-tokens": "1.5" }), /must be an integer/);
  assert.throws(() => loadConfig(contract, { ...raw, "repo-map-max-bytes": "200001" }), /between 1 and 200000/);
  // #701: the tool request budget is bounded to the same 1..50 ceiling on both sides.
  assert.throws(() => loadConfig(contract, { ...raw, "tool-max-requests": "51" }), /between 1 and 50/);
  assert.throws(() => loadConfig(contract, { ...raw, "tool-max-requests": "0" }), /between 1 and 50/);
  // #1020: the smart-tier loop limits default empty (inherit the primary
  // pair at runtime) and parse like the primary pair: positive integers.
  for (const id of ["smart-tool-max-rounds", "smart-tool-loop-wall-clock-sec"] as const) {
    assert.equal((config as Record<string, unknown>)[toCamelCase(id)], "", id);
    assert.throws(() => loadConfig(contract, { ...raw, [id]: "0" }), /must be at least 1/, id);
    assert.throws(() => loadConfig(contract, { ...raw, [id]: "abc" }), /must be an integer/, id);
  }
  assert.throws(() => loadConfig(contract, { ...raw, "ai-api-format": "provider" }), /must be one of/);
  assert.throws(() => loadConfig(contract, { ...raw, "ai-stream": "yes" }), /must be 'true' or 'false'/);
  // github-token defaults to the runner's `${{ github.token }}`; the loader
  // never treats that expression as a value.
  const noToken = loadConfig(contract, { ...raw, "github-token": "" }).githubToken;
  assert.ok(isSecretValue(noToken) && !noToken.present);
  raw["ai-temperature"] = "NaN";
  assert.throws(() => loadConfig(contract, raw), /finite number/);
});

test("secret values are redacted and never included in validation errors", () => {
  const raw = Object.fromEntries(contract.inputs.map((input) => [input.id, input.default === undefined ? "present" : String(input.default)]));
  const secrets = Object.fromEntries([...SECRET_INPUTS].map((id) => [id, `sensitive-${id}-probe`]));
  Object.assign(raw, secrets);
  for (const [id, invalid] of ([
    ["ai-stream", "not-a-boolean"],
    ["ai-max-tokens", "not-an-integer"],
    ["ai-temperature", "not-a-float"],
    ["ai-api-format", "not-an-enum"],
  ] as const)) {
    assert.throws(() => loadConfig(contract, { ...raw, [id]: invalid }), (error: unknown) => {
      assert.ok(error instanceof Error);
      for (const [secretId, token] of Object.entries(secrets)) {
        assert.equal(error.message.includes(token), false, `${id}: ${secretId}`);
      }
      return true;
    });
  }
  const config = loadConfig(contract, raw);
  for (const snapshot of [JSON.stringify(redactConfig(config)), JSON.stringify(toJSON(config)), JSON.stringify(config)]) {
    for (const [id, token] of Object.entries(secrets)) {
      assert.equal(snapshot.includes(token), false, id);
      assert.equal(JSON.parse(snapshot)[toCamelCase(id)], "[REDACTED]", id);
    }
  }
});

test("Node baseline accepts 22+ and rejects old or malformed versions", () => {
  assert.doesNotThrow(() => assertSupportedNode("v22.0.0"));
  assert.doesNotThrow(() => assertSupportedNode("v24.0.0"));
  assert.doesNotThrow(() => assertSupportedNode("26.9.0"));
  assert.throws(() => assertSupportedNode("21.99.0"), /22 or newer/);
  assert.throws(() => assertSupportedNode("node-latest"), /parse/);
});

test("a runner-expression default is never used as a value outside the runner", () => {
  const contract = validateContract(V3_CONTRACT);
  const config = loadConfig(contract, { "ai-base-url": "https://example.invalid", "ai-model": "m" });
  assert.ok(isSecretValue(config.githubToken) && !config.githubToken.present);
});
