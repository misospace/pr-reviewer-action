
export interface ContractInput {
  readonly id: string;
  readonly v2_id: string;
  readonly required: boolean;
  readonly default?: string | number | boolean;
  readonly description: string;
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
  rejectUnknown(item, ["id", "v2_id", "required", "default", "description"], path);
  const id = stringAt(item.id, `${path}.id`);
  const v2_id = stringAt(item.v2_id, `${path}.v2_id`);
  if (typeof item.required !== "boolean") throw new Error(`${path}.required must be a boolean`);
  const description = stringAt(item.description, `${path}.description`);
  if ("default" in item && !["string", "number", "boolean"].includes(typeof item.default)) {
    throw new Error(`${path}.default must be a string, number, or boolean scalar`);
  }
  if (typeof item.default === "number" && !Number.isFinite(item.default)) throw new Error(`${path}.default must be finite`);
  return Object.freeze({ id, v2_id, required: item.required, ...( "default" in item ? { default: item.default as string | number | boolean } : {}), description });
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
