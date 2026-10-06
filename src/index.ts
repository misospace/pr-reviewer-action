import { validateContract } from "./config/contract.js";
import { loadConfig } from "./config/load-config.js";
import { toJSON } from "./config/types.js";
import { resolveRepositoryConfig } from "./config/repository-config.js";
import { assertSupportedNode } from "./runtime/node-version.js";
import { V3_CONTRACT } from "../.v3-generated/contract.generated.js";
import { runPromptAssemblyFixture } from "./prompt/fixture.js";
import { runStripSourceTextFixture } from "./context/linked-sources-fixture.js";
import { CI_GATE_SUBMODE, SPECIALIST_GATE_SUBMODE, ciGateMain, exitAfterFlush, specialistsGateMain } from "./gates/workloads.js";
import { runReview, RunReviewError } from "./run/index.js";
import { precheckMain, publishMain } from "./run/entrypoints.js";
import { actionMain } from "./run/action.js";

export function main(): void {
  assertSupportedNode(process.versions.node);
  const contract = validateContract(V3_CONTRACT);
  const raw: Record<string, string | undefined> = Object.fromEntries(contract.inputs.map(({ id }) => [
    id,
    // Kebab IDs are exported literally (`INPUT_GITHUB-TOKEN`); the
    // underscore form is the compatibility fallback.
    process.env[`INPUT_${id.toUpperCase()}`] ?? process.env[`INPUT_${id.toUpperCase().replaceAll("-", "_")}`],
  ]));
  // #727/#777: read repository config from the trusted base ref, never the
  // PR head. `PR_REVIEWER_BASE_REF` is the base commit-ish the platform/
  // precheck layer resolves (see `src/platform/pr.ts`'s `PrIdentity.baseSha`);
  // it is intentionally optional here — until the #681 orchestrator cutover
  // wires that resolution end to end, an unset value leaves the operator's
  // inputs untouched rather than failing the review.
  const baseRef = process.env.PR_REVIEWER_BASE_REF ?? "";
  let effectiveRaw = raw;
  if (baseRef !== "") {
    const resolution = resolveRepositoryConfig(contract, raw, {
      baseRef,
      ...(process.env.GITHUB_WORKSPACE === undefined ? {} : { workspace: process.env.GITHUB_WORKSPACE }),
    });
    for (const warning of resolution.warnings) process.stderr.write(`repository config: ${warning}\n`);
    effectiveRaw = resolution.raw;
  }
  const config = loadConfig(contract, effectiveRaw);
  if (process.env.PR_REVIEWER_V3_DEBUG === "true") {
    process.stdout.write(`${JSON.stringify({ schemaVersion: contract.schema_version, inputs: contract.inputs.length, config: toJSON(config) })}\n`);
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const firstArg = argv[0] ?? "";
  if (process.env.PR_REVIEWER_GATE_CHILD === "1" && firstArg !== CI_GATE_SUBMODE && firstArg !== SPECIALIST_GATE_SUBMODE) {
    // Recursion guard: a gate child only ever runs its gate workload.
    process.stderr.write(`v3 runtime: refusing '${firstArg || "<action>"}' inside a gate child process\n`);
    process.exit(1);
  }
  if (firstArg === "precheck") {
    assertSupportedNode(process.versions.node);
    precheckMain(process.env)
      .then((code) => exitAfterFlush(code))
      .catch((error: unknown) => {
        process.stderr.write(`v3 precheck error: ${error instanceof Error ? error.message : "unknown error"}\n`);
        exitAfterFlush(2);
      });
  } else if (firstArg === "publish") {
    assertSupportedNode(process.versions.node);
    publishMain(process.env)
      .then((code) => exitAfterFlush(code))
      .catch((error: unknown) => {
        process.stderr.write(`v3 publish error: ${error instanceof Error ? error.message : "unknown error"}\n`);
        exitAfterFlush(1);
      });
  } else if (firstArg === "run") {
    // The end-to-end review orchestrator (#809): the typed successor of
    // scripts/run_review.sh. Review only — it never publishes. The normal
    // action entry (`actionMain`) is what sequences precheck → review →
    // publish in one Node process; this standalone CLI stays review-only.
    runReview({ env: process.env })
      .then(() => { exitAfterFlush(0); })
      .catch((error: unknown) => {
        process.stderr.write(`v3 run error: ${error instanceof Error ? error.message : "unknown error"}\n`);
        exitAfterFlush(error instanceof RunReviewError ? error.exitCode : 1);
      });
  } else if (firstArg === CI_GATE_SUBMODE || firstArg === SPECIALIST_GATE_SUBMODE) {
    // Gate workloads (#706 PR 6), launched by runConcurrentGates.
    assertSupportedNode(process.versions.node);
    const run = firstArg === CI_GATE_SUBMODE ? ciGateMain() : specialistsGateMain(argv.slice(1));
    run.then(exitAfterFlush, (error: unknown) => {
      process.stderr.write(`v3 ${firstArg} error: ${error instanceof Error ? error.message : "unknown error"}\n`);
      // wait_for_ci.sh's fatal code is 2; run_specialists.py dies with 1.
      exitAfterFlush(firstArg === CI_GATE_SUBMODE ? 2 : 1);
    });
  } else if (firstArg === "strip-source-text-fixture") {
    assertSupportedNode(process.versions.node);
    process.stdout.write(`${JSON.stringify(runStripSourceTextFixture(argv[1] ?? ""))}\n`);
  } else if (firstArg === "prompt-assembly-fixture") {
    assertSupportedNode(process.versions.node);
    process.stdout.write(`${JSON.stringify(runPromptAssemblyFixture(argv[1] ?? ""))}\n`);
  } else if (firstArg === "config") {
    // Validate the inputs and (with PR_REVIEWER_V3_DEBUG=true) print the
    // resolved, redacted config.
    try {
      main();
    } catch (error) {
      process.stderr.write(`v3 runtime configuration error: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exitCode = 1;
    }
  } else if (firstArg === "") {
    // The JavaScript action entry (`runs.using: node24`, `main: dist/index.js`).
    assertSupportedNode(process.versions.node);
    actionMain(process.env)
      .then((code) => { exitAfterFlush(code); })
      .catch((error: unknown) => {
        process.stdout.write(`::error::${error instanceof Error ? error.message : "unknown error"}\n`);
        exitAfterFlush(error instanceof RunReviewError ? error.exitCode : 1);
      });
  } else {
    process.stderr.write(`v3 runtime: unknown command '${firstArg}'\n`);
    process.exitCode = 1;
  }
}
