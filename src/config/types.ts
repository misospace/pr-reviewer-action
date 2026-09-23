import { V3_CONTRACT } from "../../.v3-generated/contract.generated.js";

export type ApiFormat = "openai" | "anthropic";
export type BoolText = "true" | "false";
export type SecretValue = Readonly<{ present: boolean; reveal(): string; toJSON(): string }>;

type CamelCase<S extends string> = S extends `${infer Head}-${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S;
type InputId = (typeof V3_CONTRACT.inputs)[number]["id"];
type ConfigValue = string | number | boolean | SecretValue;
export type RuntimeConfig = Readonly<{ [K in CamelCase<InputId>]: ConfigValue }>;

export function secretValue(value: string): SecretValue {
  return Object.freeze({
    present: value !== "",
    reveal: () => value,
    toJSON: () => value === "" ? "" : "[REDACTED]",
  });
}

export function redactConfig(config: RuntimeConfig): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(Object.entries(config).map(([key, value]) => [
    key,
    isSecretValue(value) ? (value.present ? "[REDACTED]" : "") : value,
  ])));
}

export function toJSON(config: RuntimeConfig): Readonly<Record<string, unknown>> {
  return redactConfig(config);
}

export function isSecretValue(value: unknown): value is SecretValue {
  return typeof value === "object" && value !== null && "reveal" in value && "present" in value;
}

export function isRuntimeConfig(value: unknown): value is RuntimeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const expected = V3_CONTRACT.inputs.map(({ id }) => id.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase()));
  const keys = Object.keys(record);
  return keys.length === expected.length
    && expected.every((key) => Object.hasOwn(record, key)
      && (typeof record[key] === "string" || typeof record[key] === "number" || typeof record[key] === "boolean" || isSecretValue(record[key])));
}
