import { validateContract } from "./config/contract.js";
import { loadConfig } from "./config/load-config.js";
import { toJSON } from "./config/types.js";
import { assertSupportedNode } from "./runtime/node-version.js";
import { runRequestBuilderMode, runRequiredCheckCoverageMode, runToolBudgetMode, runVerdictParserMode } from "./modes/parity.js";
import { classificationFixtureMain } from "./classification/fixture.js";
import { runPrecheckFixture } from "./precheck/index.js";
import { requirementLedgerFixtureMain } from "./requirements/fixture.js";
import {
  runEnrichmentFixture,
  runImageProvenanceFixture,
  runPrThreadFixture,
  runReviewThreadsFixture,
  runRelatedCodeFixture,
  runRepoMapFixture,
} from "./context/fixture.js";
import { runCorpusFixture, runDiffPriorityFixture } from "./corpus/index.js";
import { conversationFixtureMain } from "./model/fixture.js";
import { escalationFixtureMain } from "./routing/fixture.js";
import { toolLoopFixtureMain } from "./tools/fixture.js";
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

/** Fixture-mode classification CLI for the #675 parity harness and tests-v3:
 * `node dist/index.js classification-fixture <fixture.json>` prints a single
 * JSON line `{ok, values}` describing the canonical classification and the
 * specialist role selection. */
export async function classificationParityMain(fixturePath: string): Promise<void> {
  assertSupportedNode(process.versions.node);
  await classificationFixtureMain(fixturePath);
}

/** Fixture-mode requirement-ledger CLI for the #675 parity harness and
 * tests-v3: `node dist/index.js requirement-ledger-fixture <fixture.json>`
 * prints a single JSON line `{ok, values}` with the ledger artifact and its
 * rendered markdown. */
export async function requirementLedgerParityMain(fixturePath: string): Promise<void> {
  assertSupportedNode(process.versions.node);
  await requirementLedgerFixtureMain(fixturePath);
}

/** Fixture-mode corpus-assembly CLI for the #676 parity harness and
 * tests-v3: `node dist/index.js corpus-fixture <fixture.json>` prints a
 * single JSON line `{ok, values, stderr}` comparing the assembled corpus and
 * its diagnostic artifacts byte-for-byte with the v2 shell pipeline. */
export async function corpusFixtureMain(fixturePath: string): Promise<void> {
  assertSupportedNode(process.versions.node);
  const result = runCorpusFixture(fixturePath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function contextFixtureMain(mode: string, fixturePath: string): Promise<void> {
  assertSupportedNode(process.versions.node);
  const result = await (mode === "enrichment-fixture" ? Promise.resolve(runEnrichmentFixture(fixturePath))
    : mode === "repo-map-fixture" ? Promise.resolve(runRepoMapFixture(fixturePath))
    : mode === "pr-thread-fixture" ? Promise.resolve(runPrThreadFixture(fixturePath))
    : mode === "review-threads-fixture" ? Promise.resolve(runReviewThreadsFixture(fixturePath))
    : mode === "related-code-fixture" ? runRelatedCodeFixture(fixturePath)
    : runImageProvenanceFixture(fixturePath));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const mode = process.env.PR_REVIEWER_V3_MODE ?? "";
  const firstArg = argv[0] ?? "";
  if (firstArg === "precheck-fixture") {
    precheckFixtureMain(argv[1] ?? "").catch((error: unknown) => {
      process.stderr.write(`v3 precheck fixture error: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exitCode = 1;
    });
  } else if (firstArg === "classification-fixture") {
    classificationParityMain(argv[1] ?? "").catch((error: unknown) => {
      process.stderr.write(`v3 classification fixture error: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exitCode = 1;
    });
  } else if (firstArg === "requirement-ledger-fixture") {
    requirementLedgerParityMain(argv[1] ?? "").catch((error: unknown) => {
      process.stderr.write(`v3 requirement-ledger fixture error: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exitCode = 1;
    });
  } else if (["enrichment-fixture", "repo-map-fixture", "pr-thread-fixture", "review-threads-fixture", "related-code-fixture", "image-provenance-fixture"].includes(firstArg)) {
    contextFixtureMain(firstArg, argv[1] ?? "").catch((error: unknown) => {
      process.stderr.write(`v3 context fixture error: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exitCode = 1;
    });
  } else if (firstArg === "diff-priority-fixture") {
    assertSupportedNode(process.versions.node);
    process.stdout.write(`${JSON.stringify(runDiffPriorityFixture(argv[1] ?? ""))}\n`);
  } else if (firstArg === "corpus-fixture") {
    corpusFixtureMain(argv[1] ?? "").catch((error: unknown) => {
      process.stderr.write(`v3 corpus fixture error: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exitCode = 1;
    });
  } else if (firstArg === "conversation-fixture") {
    conversationFixtureMain(argv[1] ?? "").catch((error: unknown) => { process.stderr.write(`v3 conversation fixture error: ${error instanceof Error ? error.message : "unknown error"}\\n`); process.exitCode = 1; });
  } else if (firstArg === "escalation-fixture") {
    escalationFixtureMain(argv[1] ?? "");
  } else if (firstArg === "tool-loop-fixture") {
    toolLoopFixtureMain(argv[1] ?? "").catch((error: unknown) => { process.stderr.write(`v3 tool-loop fixture error: ${error instanceof Error ? error.message : "unknown error"}\\n`); process.exitCode = 1; });
  } else if (firstArg === "required-check-coverage-fixture") {
    runRequiredCheckCoverageMode(argv[1] ?? "");
  } else if (mode === "v3-request-builder" && firstArg) {
    runRequestBuilderMode(firstArg);
  } else if (mode === "v3-verdict-parser" && firstArg) {
    runVerdictParserMode(firstArg);
  } else if (mode === "tool-budget" && firstArg) {
    runToolBudgetMode(firstArg);
  } else if (mode !== "") {
    process.stderr.write(`v3 runtime: unknown parity mode '${mode}'\n`);
    process.exitCode = 1;
  } else {
    try {
      main();
    } catch (error) {
      process.stderr.write(`v3 runtime configuration error: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exitCode = 1;
    }
  }
}
