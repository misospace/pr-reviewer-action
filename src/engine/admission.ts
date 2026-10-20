import type { ActionContract } from "../config/contract.js";
import { loadConfig } from "../config/load-config.js";
import { runPrecheck, type PrecheckOutput } from "../precheck/decide.js";
import type { PlatformAdapter } from "../platform/types.js";
import { stageEnvFromConfig } from "../run/env.js";
import type { ReviewRequest } from "./types.js";

/**
 * #726: the engine-owned admission stage. The precheck/fingerprint DECISION
 * belongs to the reusable engine — the host only RECEIVED the event (webhook
 * reception, outputs writes, acks, replies, label cleanup and publication
 * stay host-side). The decision logic itself is unchanged (`src/precheck/*`);
 * this module only adapts engine state to `runPrecheck`, so in the runtime
 * the decision is reachable exclusively through the engine's first stage.
 */

/** The validated contract shape the engine's stages share. */
type EngineContract = ActionContract;

/**
 * The PRE-ADMISSION stage env: config projected from `request.inputs` ONLY —
 * repository config is not resolved yet because the trusted base ref is
 * unknown until admission resolves it — merged over `request.ambient` with
 * the request identity fields projected as the stage ABI keys precheck reads.
 *
 * This mirrors `actionStageEnv` (src/run/action.ts) exactly so the
 * fingerprint config hash (`collectConfigLines`) stays byte-identical on the
 * Action path: same `AI_*`/exact-key sweep, same `ACTION_REF` and
 * `LINEAR_API_KEY_CONFIGURED` derivations, same token bindings. Runner
 * context keys (GITHUB_SERVER_URL, TANGLED_REPO_DID, PR_REVIEWER_GATE_HEAD_SHA, …)
 * arrive through `ambient`, never process.env.
 */
export function admissionStageEnv(
  contract: EngineContract,
  request: ReviewRequest,
  workspace: string,
): Record<string, string> {
  const config = loadConfig(contract, request.inputs);
  const ambient = request.ambient;
  const env: Record<string, string | undefined> = { ...ambient, ...stageEnvFromConfig(config) };
  // The derived runner-context bindings actionStageEnv computes. The token
  // bindings exist so `buildPlatformReadAdapter` can construct the SAME
  // adapter the review stages use from this env.
  const token = env.GITHUB_TOKEN || ambient.GH_TOKEN || "";
  env.GH_TOKEN = token;
  if ((env.FORGEJO_AUTH_METHOD ?? "token").trim().toLowerCase() !== "authorized_integration") {
    env.FORGEJO_TOKEN = env.FORGEJO_TOKEN || ambient.FORGEJO_TOKEN || token;
  }
  env.REPO = env.REPO || request.repository || ambient.GITHUB_REPOSITORY || "";
  env.PR_NUMBER = env.PR_NUMBER || request.prNumber;
  const server = ambient.GITHUB_SERVER_URL ?? "";
  env.FORGEJO_API_URL = env.FORGEJO_API_URL || request.forgejoApiUrl
    || (server !== "" && server !== "https://github.com" ? server : "");
  env.PLATFORM = env.PLATFORM || request.platform;
  env.ACTION_REF = ambient.GITHUB_ACTION_REF ?? "";
  env.LINEAR_API_KEY_CONFIGURED = env.LINEAR_API_KEY ? "true" : "false";
  env.EVENT_HEAD_SHA = request.eventHeadSha ?? "";
  // Precheck's repository-skills discovery reads the reviewed checkout.
  env.GITHUB_WORKSPACE = workspace;
  // v2 binding: empty means "unset" everywhere down the stages.
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env as Record<string, string>;
}

/** Run the admission decision for one review request: the engine's first
 * stage. Returns the `PrecheckOutput` surface (should_review, skip_reason,
 * fingerprints, resolved SHAs) verbatim; `should_review !== "true"` means the
 * engine stops before any review stage — no model spend. Precheck's legacy
 * stderr diagnostics flow through the precheck spec's injected `diagnostics`
 * sink (no process-stream patching): they are routed to the engine's error
 * sink, so admission does not bypass explicit output sinks. */
export async function runEngineAdmission(
  contract: EngineContract,
  request: ReviewRequest,
  workspace: string,
  adapter: PlatformAdapter,
  error: (line: string) => void,
): Promise<PrecheckOutput> {
  return await runPrecheck({
    env: admissionStageEnv(contract, request, workspace),
    adapter,
    diagnostics: error,
    ...(request.event !== undefined ? { event: request.event } : {}),
    ...(request.eventHeadSha !== undefined ? { eventHeadSha: request.eventHeadSha } : {}),
  });
}
