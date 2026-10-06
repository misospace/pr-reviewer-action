import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validateContract } from "../src/config/contract.js";
import { V3_CONTRACT } from "../.v3-generated/contract.generated.js";
import { loadConfig, toCamelCase } from "../src/config/load-config.js";
import { isSecretValue, redactConfig, toJSON } from "../src/config/types.js";
import { BOOLEAN_INPUTS, ENUM_INPUTS, FLOAT_INPUTS, INTEGER_INPUTS, SECRET_INPUTS } from "../src/config/schema.js";
import { assertSupportedNode } from "../src/runtime/node-version.js";

const source = readFileSync("contracts/action-v3.yml", "utf8");
const rawContract: unknown = parse(source);
const contract = validateContract(rawContract);

test("current canonical contract validates and maps every input once", () => {
  const raw = Object.fromEntries(contract.inputs.map((input) => [input.id, input.default === undefined ? "test-value" : String(input.default)]));
  const config = loadConfig(contract, raw);
  for (const input of contract.inputs) {
    assert.ok(Object.hasOwn(config, toCamelCase(input.id)), input.id);
    assert.equal(toCamelCase(input.id).includes("_"), false);
  }
  assert.equal(contract.inputs.length, 137);
  assert.equal(Object.hasOwn(config, "ai_base_url"), false);
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
