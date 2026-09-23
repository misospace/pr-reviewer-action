import { validateContract } from "./config/contract.js";
import { loadConfig } from "./config/load-config.js";
import { toJSON } from "./config/types.js";
import { assertSupportedNode } from "./runtime/node-version.js";
import { V3_CONTRACT } from "../.v3-generated/contract.generated.js";

export function main(): void {
  assertSupportedNode(process.versions.node);
  const contract = validateContract(V3_CONTRACT);
  const raw = Object.fromEntries(contract.inputs.map(({ id }) => [id, process.env[`INPUT_${id.toUpperCase().replaceAll("-", "_")}`]]));
  const config = loadConfig(contract, raw);
  if (process.env.PR_REVIEWER_V3_DEBUG === "true") {
    process.stdout.write(`${JSON.stringify({ schemaVersion: contract.schema_version, inputs: contract.inputs.length, config: toJSON(config) })}\n`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`v3 runtime configuration error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
