import { V3_CONTRACT } from "../../.v3-generated/contract.generated.js";
import { validateContract } from "../config/contract.js";
import type { RawInputs } from "../config/load-config.js";
import { createRunDir, nonEmpty } from "./run-dir.js";
import { runReviewEngine, GATE_CHILD_ENV } from "../engine/review.js";
import type { ReviewDependencies, ReviewRequest } from "../engine/types.js";
import type { RunReviewResult } from "../engine/review.js";
import type { PrecheckEvent, PrecheckOutput } from "../precheck/decide.js";
import type { FetchLike } from "../platform/http.js";
import type { PlatformReadAdapter } from "../platform/types.js";
import { ciGateBranch } from "../gates/workloads.js";

export { RunReviewError, GATE_CHILD_ENV, ciGateOutputs, computeDeterministicBlock, resolveDegradedGateBypass, resolvePartialCoverage, partialCoverageOf, traceChangedText, traceChangedFilePaths, configuredKnownSecrets, toolBudgetTelemetryOf } from "../engine/review.js";
export type { RunReviewResult } from "../engine/review.js";

/** The Action/`run`-CLI env adapter (#726): its only job is env to
 * ReviewRequest/ReviewDependencies. Hosts with events provide richer reason
 * and rereview intent directly to the engine. */
export interface RunReviewOptions {
  env: NodeJS.ProcessEnv;
  inputs?: RawInputs;
  workspace?: string;
  runDir?: string;
  fetchImpl?: FetchLike;
  platformAdapter?: PlatformReadAdapter;
  persistArtifacts?: boolean;
  now?: () => number;
  sleep?: (seconds: number) => Promise<void>;
  log?: (line: string) => void;
  error?: (line: string) => void;
  annotate?: (line: string) => void;
  ciGate?: ReturnType<typeof ciGateBranch> | null;
  ciGateEntry?: string;
  quiet?: boolean;
  /** #726: the received event summary the engine-owned admission decides
   * on, plus its head SHA (EVENT_HEAD_SHA). Omitted for manual runs —
   * admission then runs with no event (manual semantics). */
  event?: PrecheckEvent;
  eventHeadSha?: string;
  /** #726: host side effect after a PASSING admission, before any review
   * stage (the Action adapter's #914 ack reaction). */
  onAdmission?: (admission: PrecheckOutput) => void | Promise<void>;
}

export function runtimeBundleEntry(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.PR_REVIEWER_ENTRY ?? "";
  if (explicit !== "") return explicit;
  const own = process.argv[1] ?? "";
  return /(?:^|[\\/])dist[\\/]index\.js$/.test(own) ? own : null;
}

export function rawInputsFromEnv(
  contract: ReturnType<typeof validateContract>,
  env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  return Object.fromEntries(contract.inputs.map(({ id, v2_id }) => [
    id,
    env[`INPUT_${id.toUpperCase()}`]
      ?? env[`INPUT_${id.toUpperCase().replaceAll("-", "_")}`]
      ?? (v2_id !== undefined && v2_id !== "" ? env[v2_id.toUpperCase()] : undefined)
      ?? (id === "github-token" ? (env.GH_TOKEN ?? env.GITHUB_TOKEN) : undefined),
  ]));
}

export async function runReview(options: RunReviewOptions): Promise<RunReviewResult> {
  const env = options.env;
  const contract = validateContract(V3_CONTRACT);
  const inputs = options.inputs ?? rawInputsFromEnv(contract, env);
  const runDir = nonEmpty(options.runDir) ?? nonEmpty(env.PR_REVIEWER_RUN_DIR)
    ?? createRunDir(env.RUNNER_TEMP || env.TMPDIR || "/tmp");
  const workspace = options.workspace ?? env.GITHUB_WORKSPACE ?? process.cwd();
  const request: ReviewRequest = {
    repository: env.GITHUB_REPOSITORY ?? "",
    prNumber: env.PR_NUMBER ?? "",
    // #726 review: the caller's explicit pin only. GITHUB_SHA is the PR
    // merge-ref commit on synchronize events and the default-branch tip on
    // comment events — never the reviewed head on any event this action
    // consumes, and folding it here would newly activate the head pin with a
    // wrong value. "" = unset; admission resolves from the event.
    headSha: env.PR_HEAD_SHA ?? "",
    baseRef: env.PR_REVIEWER_BASE_REF ?? "",
    isForkPr: env.IS_FORK_PR ?? "",
    platform: env.PLATFORM ?? "",
    forgejoApiUrl: env.FORGEJO_API_URL ?? "",
    ciChecksFile: env.CI_CHECKS_FILE ?? `${runDir}/ci-checks-context.md`,
    inputs,
    ambient: env,
    triggerReason: "",
    forceRereview: false,
    ...(options.event !== undefined ? { event: options.event } : {}),
    ...(options.eventHeadSha !== undefined ? { eventHeadSha: options.eventHeadSha } : {}),
  };
  const dependencies: ReviewDependencies = {
    workspace,
    runDir,
    ...(options.platformAdapter !== undefined ? { adapter: options.platformAdapter } : {}),
    outputsSink: env.GITHUB_OUTPUT ?? "/dev/null",
    stepSummaryPath: env.GITHUB_STEP_SUMMARY ?? "",
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.persistArtifacts !== undefined ? { persistArtifacts: options.persistArtifacts } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    log: options.log ?? ((line: string): void => { process.stderr.write(`[v3] ${line}\n`); }),
    error: options.error ?? ((line: string): void => { process.stderr.write(`[v3] ERROR: ${line}\n`); }),
    annotate: options.annotate ?? ((line: string): void => { process.stdout.write(`${line}\n`); }),
    ...(options.quiet !== undefined ? { quiet: options.quiet } : {}),
    ...(options.ciGate !== undefined ? { ciGate: options.ciGate } : {}),
    ciGateEntry: (options.ciGate ? "" : (options.ciGateEntry ?? runtimeBundleEntry(env))) ?? "",
    ...(options.onAdmission !== undefined ? { onAdmission: options.onAdmission } : {}),
  };
  return runReviewEngine(request, dependencies);
}
