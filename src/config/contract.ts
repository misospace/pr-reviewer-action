import { SECRET_INPUTS } from "./schema.js";

export interface ContractInput {
  readonly id: string;
  readonly v2_id: string;
  readonly required: boolean;
  readonly default?: string | number | boolean;
  readonly description: string;
  /** Repository config (#727/#777) may narrow this input; see
   * `src/config/repository-config.ts` for the precedence rule. Absent/false
   * means the repository file may never set this key — the allowed set is
   * data here, not code. */
  readonly "repo-configurable"?: boolean;
  /** This input is no longer surfaced as a workflow `with:` input (the v3
   * runtime never reads it from the environment) — it is sourced solely from
   * its contract default, narrowable only by repository config. Implies
   * `repo-configurable: true`. */
  readonly "repo-config-only"?: boolean;
}

export interface ContractOutput {
  readonly id: string;
  readonly v2_id: string;
  readonly description: string;
}

export interface RemovedField {
  readonly kind: "inputs" | "outputs";
  readonly v2_id: string;
  readonly status: "removed";
  readonly reason: string;
}

export interface ActionContract {
  readonly schema_version: 1;
  readonly contract: "github-action";
  readonly inputs: readonly ContractInput[];
  readonly outputs: readonly ContractOutput[];
  readonly removed: readonly RemovedField[];
}

export function validateContract(value: unknown): ActionContract {
  const root = objectAt(value, "contract");
  const allowedTop = new Set(["schema_version", "contract", "inputs", "outputs", "removed"]);
  for (const key of Object.keys(root)) if (!allowedTop.has(key)) throw new Error(`contract has unsupported field '${key}'`);
  if (root.schema_version !== 1) throw new Error("contract.schema_version must be supported version 1");
  if (root.contract !== "github-action") throw new Error("contract.contract must be 'github-action'");
  if (!Array.isArray(root.inputs) || !Array.isArray(root.outputs) || !Array.isArray(root.removed)) {
    throw new Error("contract.inputs, contract.outputs, and contract.removed must be arrays");
  }
  const inputs = root.inputs.map((item, i) => validateInput(item, `inputs[${i}]`));
  const outputs = root.outputs.map((item, i) => validateOutput(item, `outputs[${i}]`));
  const removed = root.removed.map((item, i) => validateRemoved(item, `removed[${i}]`));
  unique([...inputs.map(({ id }) => id), ...outputs.map(({ id }) => id)], "canonical id");
  unique([...inputs.map(({ v2_id }) => v2_id), ...outputs.map(({ v2_id }) => v2_id)], "active v2_id");
  unique(removed.map(({ v2_id }) => v2_id), "removed v2_id");
  const activeIds = new Set([...inputs.map(({ id }) => id), ...outputs.map(({ id }) => id)]);
  const activeV2Ids = new Set([...inputs.map(({ v2_id }) => v2_id), ...outputs.map(({ v2_id }) => v2_id)]);
  for (const entry of removed) {
    if (!/^[a-z][a-z0-9_]*$/.test(entry.v2_id)) throw new Error(`removed ${entry.kind} v2_id '${entry.v2_id}' is invalid`);
    if (activeV2Ids.has(entry.v2_id)) throw new Error(`removed ${entry.kind} v2_id collides with active field`);
    const canonical = entry.v2_id.replaceAll("_", "-");
    if (activeIds.has(canonical)) throw new Error(`removed ${entry.kind} field collides with active id '${canonical}'`);
  }
  for (const input of inputs) validateNames(input.id, input.v2_id, "input");
  for (const output of outputs) validateNames(output.id, output.v2_id, "output");
  for (const input of inputs) {
    if (input["repo-config-only"] && !input["repo-configurable"]) {
      throw new Error(`input '${input.id}' has repo-config-only without repo-configurable`);
    }
    if (input["repo-configurable"] && input.required) {
      throw new Error(`input '${input.id}' cannot be both required and repo-configurable — a required input is an operator-supplied credential/endpoint/ceiling and must never gain authority from repository-controlled config`);
    }
    if (SECRET_INPUTS.has(input.id) && input["repo-configurable"]) {
      throw new Error(`input '${input.id}' is a secret and must never be repo-configurable`);
    }
  }
  return Object.freeze({ schema_version: 1, contract: "github-action", inputs, outputs, removed });
}

function validateNames(id: string, v2Id: string, label: string): void {
  if (id.includes("_")) throw new Error(`${label} id '${id}' must not contain underscores`);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`${label} id '${id}' is not a valid Action identifier`);
  if (!/^[a-z][a-z0-9_]*$/.test(v2Id)) throw new Error(`${label} v2_id '${v2Id}' is invalid`);
  if (id.replaceAll("-", "_") !== v2Id) throw new Error(`${label} '${id}' does not mechanically map to v2_id '${v2Id}'`);
}

function validateInput(value: unknown, path: string): ContractInput {
  const item = objectAt(value, path);
  rejectUnknown(item, ["id", "v2_id", "required", "default", "description", "repo-configurable", "repo-config-only"], path);
  const id = stringAt(item.id, `${path}.id`);
  const v2_id = stringAt(item.v2_id, `${path}.v2_id`);
  if (typeof item.required !== "boolean") throw new Error(`${path}.required must be a boolean`);
  const description = stringAt(item.description, `${path}.description`);
  if ("default" in item && !["string", "number", "boolean"].includes(typeof item.default)) {
    throw new Error(`${path}.default must be a string, number, or boolean scalar`);
  }
  if (typeof item.default === "number" && !Number.isFinite(item.default)) throw new Error(`${path}.default must be finite`);
  if ("repo-configurable" in item && typeof item["repo-configurable"] !== "boolean") {
    throw new Error(`${path}.repo-configurable must be a boolean`);
  }
  if ("repo-config-only" in item && typeof item["repo-config-only"] !== "boolean") {
    throw new Error(`${path}.repo-config-only must be a boolean`);
  }
  return Object.freeze({
    id,
    v2_id,
    required: item.required,
    ...("default" in item ? { default: item.default as string | number | boolean } : {}),
    description,
    ...(item["repo-configurable"] === true ? { "repo-configurable": true as const } : {}),
    ...(item["repo-config-only"] === true ? { "repo-config-only": true as const } : {}),
  });
}

function validateOutput(value: unknown, path: string): ContractOutput {
  const item = objectAt(value, path);
  rejectUnknown(item, ["id", "v2_id", "description"], path);
  return Object.freeze({ id: stringAt(item.id, `${path}.id`), v2_id: stringAt(item.v2_id, `${path}.v2_id`), description: stringAt(item.description, `${path}.description`) });
}

function validateRemoved(value: unknown, path: string): RemovedField {
  const item = objectAt(value, path);
  rejectUnknown(item, ["kind", "v2_id", "status", "reason"], path);
  if (item.kind !== "inputs" && item.kind !== "outputs") throw new Error(`${path}.kind must be 'inputs' or 'outputs'`);
  if (item.status !== "removed") throw new Error(`${path}.status must be 'removed'`);
  return Object.freeze({ kind: item.kind, v2_id: stringAt(item.v2_id, `${path}.v2_id`), status: "removed", reason: stringAt(item.reason, `${path}.reason`) });
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}
function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}
function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
}

function rejectUnknown(item: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(item)) if (!allowed.includes(key)) throw new Error(`${path} has unsupported field '${key}'`);
}
