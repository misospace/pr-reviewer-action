import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { validateContract } from "../config/contract.js";
import { loadConfig } from "../config/load-config.js";
import { runPrecheck, type PrecheckOutput } from "../precheck/decide.js";
import { resolvePlatform } from "../platform/resolve.js";
import { requireImplementedBackend } from "../platform/tangled.js";
import { repoScopedUrl } from "../platform/repo-ref.js";
import { V3_CONTRACT } from "../../.v3-generated/contract.generated.js";
import { stageEnvFromConfig } from "./env.js";
import { buildAdapter, buildPublishApi, publishInputFromEnv, publishWith, readEvent } from "./entrypoints.js";
import { rawInputsFromEnv, runReview } from "./review.js";
import { createRunDir } from "./run-dir.js";

export { createRunDir };

/**
 * The JavaScript action entry (`runs.using: node24`, #706): the whole review
 * in one process — precheck, review, publish, re-review label cleanup and
 * the fail-on-request-changes gate — with typed state passed between stages
 * instead of composite step outputs. The runner exports the inputs as
 * `INPUT_<ID>` with contract defaults already applied.
 */

type Env = Record<string, string | undefined>;

export function writeOutputs(env: NodeJS.ProcessEnv, outputs: ReadonlyArray<[string, string | undefined]>): void {
  const file = env.GITHUB_OUTPUT ?? "";
  if (file === "" || file === "/dev/null") return;
  let text = "";
  for (const [key, value] of outputs) {
    if (value === undefined) continue;
    if (!value.includes("\n")) {
      text += `${key}=${value}\n`;
      continue;
    }
    // Random heredoc delimiter, re-drawn if the value contains it, so a
    // multiline value can never forge another assignment.
    let delimiter = `ghadelimiter_${randomBytes(16).toString("hex")}`;
    while (value.includes(delimiter)) delimiter = `ghadelimiter_${randomBytes(16).toString("hex")}`;
    text += `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
  }
  if (text !== "") appendFileSync(file, text);
}

/** The label a `labeled` event carries (GitHub sends `{ name }`). */
export function eventLabelName(label: unknown): string {
  if (typeof label === "string") return label;
  if (label !== null && typeof label === "object" && typeof (label as { name?: unknown }).name === "string") {
    return (label as { name: string }).name;
  }
  return "";
}

/** The stage environment every ported stage reads: the typed config
 * projected to its SCREAMING_SNAKE ABI plus the derived runner context the
 * composite used to compute in its env blocks. */
export function actionStageEnv(env: NodeJS.ProcessEnv): Env {
  const contract = validateContract(V3_CONTRACT);
  const config = loadConfig(contract, rawInputsFromEnv(contract, env));
  const stage: Env = { ...env, ...stageEnvFromConfig(config) };
  // stageEnvFromConfig projects `github-token` (secret-revealed) as GITHUB_TOKEN.
  const token = stage.GITHUB_TOKEN || env.GH_TOKEN || "";
  stage.GH_TOKEN = token;
  stage.FORGEJO_TOKEN = stage.FORGEJO_TOKEN || token;
  stage.REPO = stage.REPO || env.GITHUB_REPOSITORY || "";
  stage.PR_NUMBER = stage.PR_NUMBER || readEvent(env).prNumber || "";
  const server = env.GITHUB_SERVER_URL ?? "";
  stage.FORGEJO_API_URL = stage.FORGEJO_API_URL || (server !== "" && server !== "https://github.com" ? server : "");
  stage.ACTION_REF = env.GITHUB_ACTION_REF ?? "";
  stage.LINEAR_API_KEY_CONFIGURED = stage.LINEAR_API_KEY ? "true" : "false";
  return stage;
}

function shouldPublish(stage: Env): boolean {
  const mode = stage.PUBLISH_MODE ?? "";
  return mode === "review_comment" || mode === "review_verdict" || (mode === "comment" && stage.PUBLISH_REVIEW_COMMENT === "true");
}

export async function actionMain(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const stage = actionStageEnv(env);
  const { event, headSha: eventHeadSha } = readEvent(env);
  stage.EVENT_HEAD_SHA = eventHeadSha ?? "";

  // ── Precheck ──────────────────────────────────────────────────────────
  const pre: PrecheckOutput = await runPrecheck({
    env: stage as Record<string, string>,
    adapter: buildAdapter(stage),
    ...(event !== undefined ? { event: event as never } : {}),
    ...(eventHeadSha !== undefined ? { eventHeadSha } : {}),
  });
  writeOutputs(env, [
    ["should-review", pre.should_review],
    ["skip-reason", pre.skip_reason],
    ["diff-fingerprint", pre.diff_fingerprint],
  ]);
  if (pre.should_review !== "true") {
    writeOutputs(env, [["verdict", pre.verdict], ["verdict-source", pre.verdict_source]]);
    return failOnRequestChanges(stage, pre.verdict ?? "");
  }

  // ── Review ────────────────────────────────────────────────────────────
  stage.PLATFORM = pre.resolved_platform || stage.PLATFORM;
  stage.FORGEJO_API_URL = pre.effective_forgejo_api_url;
  stage.PR_HEAD_SHA = eventHeadSha || pre.head_sha;
  stage.IS_FORK_PR = pre.is_fork_pr;
  const temp = env.RUNNER_TEMP || env.TMPDIR || "/tmp";
  stage.CI_CHECKS_FILE = join(temp, "ci-checks-context.md");
  const runDir = createRunDir(temp);
  stage.PR_REVIEWER_RUN_DIR = runDir;
  const review = await runReview({ env: stage as NodeJS.ProcessEnv, runDir, workspace: env.GITHUB_WORKSPACE ?? process.cwd() });

  // ── Publish ───────────────────────────────────────────────────────────
  let publishFailed = false;
  if (shouldPublish(stage)) {
    const publishEnv: Env = {
      ...stage,
      HEAD_SHA: stage.PR_HEAD_SHA,
      BASE_SHA: pre.base_sha,
      BROAD_FINGERPRINT: pre.diff_fingerprint,
      VERDICT: review.outputs.verdict,
      REQUIRED_CHECKS: review.outputs.requiredChecks,
      REVIEW_ROUTE: review.outputs.reviewRoute,
      ESCALATION_REASON: review.outputs.escalationReason,
      REVIEW_MARKDOWN: review.outputs.reviewMarkdown,
      FINDINGS: review.outputs.findings,
      ANALYSIS_ENGINE: review.outputs.analysisEngine,
      CACHE_HIT_RATIO: review.outputs.cacheHitRatio,
      VERDICT_POLICY: review.verdictPolicy,
    };
    const seam = buildPublishApi(publishEnv as NodeJS.ProcessEnv);
    const input = {
      ...publishInputFromEnv(publishEnv as NodeJS.ProcessEnv, seam.platform),
      // The #810 coverage notice and the #812 CI conclusion reach the
      // published marker and body only through these.
      ...(review.partialCoverage ? { partialCoverage: review.partialCoverage } : {}),
      ...(review.ciState !== undefined ? { ciState: review.ciState } : {}),
      // #847: the #810/#702 tool-budget provenance reaches the published
      // marker only through these, same as partialCoverage/ciState above.
      ...(review.toolBudget !== undefined ? { toolBudget: review.toolBudget } : {}),
      ...(review.toolBudgetSource !== undefined ? { toolBudgetSource: review.toolBudgetSource } : {}),
      ...(review.toolCallsUsed !== undefined ? { toolCalls: review.toolCallsUsed } : {}),
    };
    publishFailed = (await publishWith(input, seam)) !== 0;
  }

  // ── Re-review label ───────────────────────────────────────────────────
  const label = eventLabelName(event?.label);
  if (event?.action === "labeled" && label !== "" && label === stage.REREVIEW_LABEL) {
    await clearRereviewLabel(stage).catch(() => undefined);
  }

  const gate = failOnRequestChanges(stage, review.outputs.verdict);
  return publishFailed ? Math.max(gate, 1) : gate;
}

function failOnRequestChanges(stage: Env, verdict: string): number {
  if ((stage.FAIL_ON_REQUEST_CHANGES ?? "false").toLowerCase() !== "true") return 0;
  if (verdict === "request_changes") {
    process.stdout.write("::error::Final verdict is request_changes; failing the step (fail-on-request-changes=true).\n");
    return 1;
  }
  process.stdout.write(`Final verdict is '${verdict || "<none>"}'; not blocking (fail-on-request-changes=true).\n`);
  return 0;
}

async function clearRereviewLabel(stage: Env): Promise<void> {
  const platform = resolvePlatform(stage.PLATFORM, stage.FORGEJO_API_URL ?? "", stage.GITHUB_SERVER_URL ?? "", stage.TANGLED_REPO_DID ?? "");
  requireImplementedBackend(platform);
  const label = stage.REREVIEW_LABEL ?? "";
  const pr = stage.PR_NUMBER ?? "";
  if (label === "" || !/^\d+$/.test(pr)) return;
  const base = platform === "forgejo"
    ? `${(stage.FORGEJO_API_URL ?? "").replace(/\/+$/, "")}/api/v1`
    : (stage.GITHUB_API_URL || "https://api.github.com");
  const url = repoScopedUrl(base, stage.REPO ?? "", `/issues/${pr}/labels`, `/${encodeURIComponent(label)}`);
  if (url === null) return;
  const token = platform === "forgejo" ? (stage.FORGEJO_TOKEN ?? "") : (stage.GH_TOKEN ?? "");
  await fetch(url, {
    method: "DELETE",
    headers: { Authorization: platform === "forgejo" ? `token ${token}` : `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
}
