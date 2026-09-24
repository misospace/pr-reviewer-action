import { validateContract } from "./config/contract.js";
import { loadConfig } from "./config/load-config.js";
import { toJSON } from "./config/types.js";
import { assertSupportedNode } from "./runtime/node-version.js";
import { runPrecheckFixture } from "./precheck/index.js";
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

/** Fixture-mode precheck CLI for the #673 parity harness and tests-v3:
 * `node dist/index.js precheck-fixture <fixture.json>` prints a single JSON
 * line `{ok, values, stderr}` describing the precheck decision outputs. */
export async function precheckFixtureMain(fixturePath: string): Promise<void> {
  assertSupportedNode(process.versions.node);
  const result = await runPrecheckFixture(fixturePath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === "precheck-fixture") {
    precheckFixtureMain(argv[1] ?? "").catch((error: unknown) => {
      process.stderr.write(`v3 precheck fixture error: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exitCode = 1;
    });
  } else {
    try {
      main();
    } catch (error) {
      process.stderr.write(`v3 runtime configuration error: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exitCode = 1;
    }
  }
}
