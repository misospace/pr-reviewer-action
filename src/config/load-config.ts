import type { ActionContract } from "./contract.js";
import { BOOLEAN_INPUTS, ENUM_INPUTS, FLOAT_INPUTS, INTEGER_INPUTS, POSITIVE_INTEGER_INPUTS, SECRET_INPUTS } from "./schema.js";
import { isRuntimeConfig, secretValue, type RuntimeConfig } from "./types.js";

type MutableConfig = Record<string, string | number | boolean | ReturnType<typeof secretValue>>;
const INTEGER_BOUNDS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  "repo-map-max-bytes": [1, 200_000],
  "pr-thread-max-bytes": [1, 200_000],
  "deep-review-corpus-max-bytes": [1, 500_000],
  // #701: the tool request budget is bounded by the same hard ceiling the v2
  // harness clamps to — an out-of-range explicit value can never widen it.
  "tool-max-requests": [1, 20],
});

export type RawInputs = Readonly<Record<string, string | undefined>>;

export function toCamelCase(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

export function loadConfig(contract: ActionContract, raw: RawInputs): RuntimeConfig {
  const config: MutableConfig = {};
  for (const input of contract.inputs) {
    const external = raw[input.id];
    const source = external === undefined
      ? input.default
      : external === "" && input.default !== undefined && input.id !== "ai-temperature"
        ? String(input.default)
        : external;
    if (source === undefined) {
      if (input.required) throw new Error(`Required input '${input.id}' is missing`);
      config[toCamelCase(input.id)] = "";
      continue;
    }
    const text = String(source);
    if (input.required && text === "") throw new Error(`Required input '${input.id}' is missing`);
    let value: string | number | boolean = text;
    if (BOOLEAN_INPUTS.has(input.id)) {
      if (text === "") value = "";
      else if (text !== "true" && text !== "false") throw new Error(`Input '${input.id}' must be 'true' or 'false'`);
      else value = text === "true";
    } else if (INTEGER_INPUTS.has(input.id) && text !== "") {
      if (!/^-?(?:0|[1-9]\d*)$/.test(text)) throw new Error(`Input '${input.id}' must be an integer`);
      const number = Number(text);
      if (!Number.isSafeInteger(number)) throw new Error(`Input '${input.id}' is outside the safe integer range`);
      const bounds = INTEGER_BOUNDS[input.id];
      if (bounds && (number < bounds[0] || number > bounds[1])) throw new Error(`Input '${input.id}' must be between ${bounds[0]} and ${bounds[1]}`);
      if (POSITIVE_INTEGER_INPUTS.has(input.id) && number < 1) throw new Error(`Input '${input.id}' must be at least 1`);
      if (input.id === "pr-number" && number < 1) throw new Error("Input 'pr-number' must be at least 1");
      if (input.id === "tool-min-successful-requests" && number < 0) throw new Error("Input 'tool-min-successful-requests' must be at least 0");
      if (input.id === "ai-primary-retries" && number < 0) throw new Error("Input 'ai-primary-retries' must be at least 0");
      if (input.id === "ai-primary-retry-delay-sec" && number < 0) throw new Error("Input 'ai-primary-retry-delay-sec' must be at least 0");
      if (input.id === "image-digest-budget-sec" && number < 0) throw new Error("Input 'image-digest-budget-sec' must be at least 0");
      value = number;
    } else if (FLOAT_INPUTS.has(input.id) && text !== "") {
      const number = Number(text);
      if (!Number.isFinite(number)) throw new Error(`Input '${input.id}' must be a finite number`);
      value = number;
    }
    const allowed = ENUM_INPUTS[input.id];
    if (allowed && text !== "" && !allowed.includes(text)) throw new Error(`Input '${input.id}' must be one of: ${allowed.join(", ")}`);
    config[toCamelCase(input.id)] = SECRET_INPUTS.has(input.id) ? secretValue(text) : value;
  }
  resolveInherited(config);
  const frozen: unknown = Object.freeze(config);
  if (!isRuntimeConfig(frozen)) throw new Error("Internal config does not match the canonical v3 contract");
  return frozen;
}

function resolveInherited(config: MutableConfig): void {
  inherit(config, "aiFallbackBaseUrl", "aiBaseUrl");
  inherit(config, "aiFallbackApiFormat", "aiApiFormat");
  inheritSecret(config, "aiFallbackApiKey", "aiApiKey");
  inherit(config, "aiFallbackRequestTimeoutSec", "aiRequestTimeoutSec");
  inherit(config, "aiFallbackConnectTimeoutSec", "aiConnectTimeoutSec");
  inherit(config, "aiFallbackStream", "aiStream");
  inherit(config, "aiPrimaryModel", "aiModel");
  inherit(config, "aiPrimaryBaseUrl", "aiBaseUrl");
  inherit(config, "aiPrimaryApiFormat", "aiApiFormat");
  inheritSecret(config, "aiPrimaryApiKey", "aiApiKey");
  inherit(config, "aiSmartBaseUrl", "aiBaseUrl");
  inherit(config, "aiSmartApiFormat", "aiApiFormat");
  inheritSecret(config, "aiSmartApiKey", "aiApiKey");
  inherit(config, "primaryModelContextTokens", "modelContextTokens");
  inherit(config, "smartModelContextTokens", "modelContextTokens");
}

function inherit(config: MutableConfig, target: string, fallback: string): void {
  if (config[target] === "") config[target] = config[fallback] ?? "";
}

function inheritSecret(config: MutableConfig, target: string, fallback: string): void {
  const current = config[target];
  if (typeof current === "object" && current.present === false) {
    const value = config[fallback];
    config[target] = typeof value === "object" ? value : secretValue("");
  }
}
