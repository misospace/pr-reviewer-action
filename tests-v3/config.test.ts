import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validateContract } from "../src/config/contract.js";
import { loadConfig, toCamelCase } from "../src/config/load-config.js";
import { redactConfig, toJSON } from "../src/config/types.js";
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
  assert.equal(contract.inputs.length, 123);
  assert.equal(Object.hasOwn(config, "ai_base_url"), false);
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
  assert.equal(loadConfig(contract, { ...raw, "ai-max-tokens": "" }).aiMaxTokens, 8192);
  assert.equal(loadConfig(contract, { ...raw, "ai-max-tokens": "12" }).aiMaxTokens, 12);
  assert.equal(config.aiTemperature, 0.1);
  assert.equal(loadConfig(contract, { ...raw, "ai-temperature": "" }).aiTemperature, "");
  assert.equal(config.aiFallbackBaseUrl, config.aiBaseUrl);
  assert.equal(config.aiPrimaryModel, config.aiModel);
  assert.equal(config.aiFallbackStream, config.aiStream);
  assert.equal(config.aiMaxTokens, 8192);
  assert.throws(() => loadConfig(contract, { ...raw, "ai-max-tokens": "12foo" }), /must be an integer/);
  assert.throws(() => loadConfig(contract, { ...raw, "ai-max-tokens": "Infinity" }), /must be an integer/);
  assert.throws(() => loadConfig(contract, { ...raw, "ai-max-tokens": "1.5" }), /must be an integer/);
  assert.throws(() => loadConfig(contract, { ...raw, "repo-map-max-bytes": "200001" }), /between 1 and 200000/);
  assert.throws(() => loadConfig(contract, { ...raw, "ai-api-format": "provider" }), /must be one of/);
  assert.throws(() => loadConfig(contract, { ...raw, "ai-stream": "yes" }), /must be 'true' or 'false'/);
  assert.throws(() => loadConfig(contract, { ...raw, "github-token": "" }), /Required input 'github-token' is missing/);
  raw["ai-temperature"] = "NaN";
  assert.throws(() => loadConfig(contract, raw), /finite number/);
});

test("secret values are redacted and never included in validation errors", () => {
  const token = "highly-sensitive-test-token";
  const raw = Object.fromEntries(contract.inputs.map((input) => [input.id, input.default === undefined ? "present" : String(input.default)]));
  raw["github-token"] = token;
  raw["ai-stream"] = "not-a-boolean";
  assert.throws(() => loadConfig(contract, raw), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  raw["ai-stream"] = "true";
  const config = loadConfig(contract, raw);
  assert.equal(JSON.stringify(redactConfig(config)).includes(token), false);
  assert.equal(JSON.stringify(toJSON(config)).includes(token), false);
  assert.equal(JSON.stringify(config).includes(token), false);
  assert.equal(JSON.stringify(config).includes("[REDACTED]"), true);
  assert.equal(JSON.stringify(redactConfig(config)).includes("[REDACTED]"), true);
});

test("Node baseline accepts 24+ and rejects old or malformed versions", () => {
  assert.doesNotThrow(() => assertSupportedNode("v24.0.0"));
  assert.doesNotThrow(() => assertSupportedNode("26.9.0"));
  assert.throws(() => assertSupportedNode("23.99.0"), /24 or newer/);
  assert.throws(() => assertSupportedNode("node-latest"), /parse/);
});
