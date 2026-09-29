import { V3_CONTRACT } from "../../.v3-generated/contract.generated.js";
import { isSecretValue, type RuntimeConfig } from "../config/types.js";
import type { EnvLike } from "../tools/budget.js";

/**
 * The resolved review environment (#809). The v3 public contract is
 * kebab-case (`INPUT_*` from action metadata), but every ported stage reads
 * the SCREAMING_SNAKE environment the v2 composite steps assembled — that
 * surface is the pinned parity boundary (`config-default-resolution`). This
 * projection is the typed bridge: contract inputs by mechanical name map,
 * plus the ambient runner context and the derived budget bindings v2
 * exported from config.sh. Downstream stage mutations (REVIEW_ROUTE,
 * TOOL_HARNESS_TIER, ...) go through the same record, exactly like v2's
 * exported shell variables.
 */

export interface RunContext {
  /** The reviewed checkout (GITHUB_WORKSPACE). */
  workspace: string;
  /** Where run artifacts persist (v2: the review step's cwd). */
  runDir: string;
  repo: string;
  prNumber: string;
  headSha: string;
  isForkPr: string;
  platform: string;
  forgejoApiUrl: string;
  /** Where wait_for_ci writes the evidence table (v2: $runner.temp). */
  ciChecksFile: string;
  outputFilePath: string;
  stepSummaryPath: string;
  /** PR_REVIEWER_BASE_REF: the trusted base for repository config. */
  baseRef: string;
}

/** Every contract input, projected to the SCREAMING_SNAKE env keys the ported
 * stages read (no INPUT_ prefix — v2's env-block names are the stage ABI). */
export function stageEnvFromConfig(config: RuntimeConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const input of V3_CONTRACT.inputs) {
    const camel = input.id.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
    const value = (config as Record<string, unknown>)[camel];
    if (value === undefined) continue;
    const name = input.id.toUpperCase().replaceAll("-", "_");
    env[name] = isSecretValue(value) ? value.reveal() : String(value);
  }
  return env;
}

export function stageEnvFromContext(context: RunContext): Record<string, string> {
  return {
    GITHUB_WORKSPACE: context.workspace,
    REPO: context.repo,
    PR_NUMBER: context.prNumber,
    PR_HEAD_SHA: context.headSha,
    IS_FORK_PR: context.isForkPr,
    PLATFORM: context.platform,
    FORGEJO_API_URL: context.forgejoApiUrl,
    CI_CHECKS_FILE: context.ciChecksFile,
    GITHUB_OUTPUT: context.outputFilePath,
    ...(context.stepSummaryPath ? { GITHUB_STEP_SUMMARY: context.stepSummaryPath } : {}),
    PR_REVIEWER_BASE_REF: context.baseRef,
  };
}

/** Ambient runner keys the ports read directly (identity/self-exclusion,
 * forge auth family, runner plumbing). Deliberately NOT a general
 * passthrough: anything else must arrive through config or RunContext.
 * The two SEMANTIC_FIXTURE_* keys are the eval harness's offline-mode
 * seam (#706 wave 0): `buildPlatformReadAdapter` serves every platform
 * read from the fixture directory when both are set. Production runs
 * never set them. */
const AMBIENT_KEYS = [
  "GITHUB_SERVER_URL", "GITHUB_API_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID",
  "GITHUB_SHA", "CI_STATUS_CONTEXT", "GH_HOST", "ANTHROPIC_VERSION",
  "SEMANTIC_FIXTURE_MODE", "SEMANTIC_FIXTURE_DIR",
  // Tangled identity signal (#583): DID-first auto resolution in
  // src/platform/resolve.ts reads it from the projected stage env.
  "TANGLED_REPO_DID",
] as const;

export function buildStageEnv(
  config: RuntimeConfig,
  context: RunContext,
  ambient: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = stageEnvFromConfig(config);
  Object.assign(env, stageEnvFromContext(context));
  for (const key of AMBIENT_KEYS) {
    const value = ambient[key];
    if (value !== undefined) env[key] = value;
  }
  // v2 binding: GH_TOKEN := GH_TOKEN || GITHUB_TOKEN (config.sh) — the
  // ambient binding wins. The token input lands under its contract name and
  // feeds GH_TOKEN only when the ambient has neither.
  if (env.GH_TOKEN === undefined || env.GH_TOKEN === "") {
    const ambientToken = ambient.GH_TOKEN || ambient.GITHUB_TOKEN || "";
    if (ambientToken !== "") {
      env.GH_TOKEN = ambientToken;
    } else {
      const token = config.githubToken;
      env.GH_TOKEN = typeof token === "object" && token !== null && "reveal" in token ? token.reveal() : "";
    }
  }
  // v2: empty means "unset" everywhere down the stages.
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env;
}

export type StageEnv = EnvLike & Record<string, string>;

/** v2 config.sh: required bindings beyond the contract's required inputs. */
export function validateStageEnv(env: StageEnv): string | null {
  if (!env.REPO) return "Missing required environment variables: REPO";
  if (!env.PR_NUMBER) return "Missing required environment variables: PR_NUMBER";
  if (!env.AI_BASE_URL) return "Missing required environment variables: AI_BASE_URL";
  if (!env.AI_MODEL) return "Missing required environment variables: AI_MODEL";
  if (!env.GH_TOKEN) return "Missing GitHub token in GH_TOKEN or GITHUB_TOKEN";
  return null;
}
