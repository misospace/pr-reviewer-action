import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolvePlatform } from "../platform/resolve.js";
import { GitHubAdapter } from "../platform/github.js";
import { ForgejoAdapter } from "../platform/forgejo.js";
import type { PlatformAdapter } from "../platform/types.js";
import { GitHubPublishApi } from "../platform/publish-api.js";
import { ForgejoPublishApi } from "../platform/publish-api.js";
import { runPrecheck } from "../precheck/decide.js";
import { publishReview, type PublishInput, type PublishResult, type PublishMode } from "../publish/publish.js";
import type { PublishPlatformApi } from "../platform/publish-api.js";
import type { UpstreamLinkMode } from "../publish/sanitize.js";

/**
 * Production entrypoints for the #706 composite cutover: the precheck and
 * publish steps call the same typed ports the review entry uses, with the
 * composite's resolved environment as the only input surface. Env-variable
 * names keep the SCREAMING_SNAKE stage ABI; the public action input IDs are
 * the kebab-case contract (the composite's env blocks bind them).
 */

export class EntrypointError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "EntrypointError";
    this.exitCode = exitCode;
  }
}

function ghToken(env: NodeJS.ProcessEnv): string {
  return env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "";
}

export function buildAdapter(env: NodeJS.ProcessEnv): PlatformAdapter {
  const repo = env.REPO ?? "";
  const prNumber = env.PR_NUMBER ?? "";
  const platform = resolvePlatform(env.PLATFORM, env.FORGEJO_API_URL ?? "", env.GITHUB_SERVER_URL ?? "");
  if (platform === "forgejo") {
    return new ForgejoAdapter({
      repo,
      prNumber,
      baseUrl: env.FORGEJO_API_URL ?? "",
      token: env.FORGEJO_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || undefined,
      ...(env.FORGEJO_AUTH_METHOD !== undefined ? { authMethod: env.FORGEJO_AUTH_METHOD } : {}),
      ...(env.FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE !== undefined
        ? { authorizedIntegrationAudience: env.FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE }
        : {}),
    });
  }
  const token = ghToken(env);
  return new GitHubAdapter({
    repo,
    prNumber,
    ...(token ? { token: `Bearer ${token}` } : {}),
    ...(env.GITHUB_API_URL ? { baseUrl: env.GITHUB_API_URL } : {}),
  });
}

interface StepEvent {
  name?: string;
  action?: string;
  label?: string;
}

export function readEvent(env: NodeJS.ProcessEnv): { event?: StepEvent; headSha?: string; prNumber?: string } {
  const path = env.GITHUB_EVENT_PATH ?? "";
  if (path === "") return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StepEvent & { pull_request?: { number?: number; head?: { sha?: string } } };
    const event: StepEvent = {};
    if (parsed.name !== undefined) event.name = parsed.name;
    if (parsed.action !== undefined) event.action = parsed.action;
    if (parsed.label !== undefined) event.label = parsed.label;
    return {
      ...(Object.keys(event).length > 0 ? { event } : {}),
      ...(parsed.pull_request?.head?.sha !== undefined ? { headSha: parsed.pull_request.head.sha } : {}),
      ...(typeof parsed.pull_request?.number === "number" ? { prNumber: String(parsed.pull_request.number) } : {}),
    };
  } catch {
    return {};
  }
}

function persistOutputs(filePath: string, assignments: ReadonlyArray<[string, string]>): void {
  if (filePath === "" || filePath === "/dev/null") return;
  const text = assignments
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  if (text === "") return;
  appendFileSync(filePath, text);
}

/** `node dist/index.js precheck` — the typed successor of
 * `scripts/check_review_needed.sh` in the composite. */
export async function precheckMain(env: NodeJS.ProcessEnv): Promise<number> {
  const { event, headSha: eventHeadSha } = readEvent(env);
  const output = await runPrecheck({
    env: env as Record<string, string>,
    adapter: buildAdapter(env),
    ...(event !== undefined ? { event: event as never } : {}),
    ...(eventHeadSha !== undefined ? { eventHeadSha } : {}),
  });
  persistOutputs(env.GITHUB_OUTPUT ?? "", Object.entries(output));
  return 0;
}

function boolInput(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined || raw === "") return fallback;
  return raw.trim().toLowerCase() === "true";
}

function publishMode(raw: string | undefined): PublishMode {
  const value = raw ?? "";
  if (value === "comment" || value === "review_comment" || value === "review_verdict") return value;
  throw new EntrypointError(`Invalid publish_mode '${value}'`);
}

function upstreamLinkMode(raw: string | undefined): UpstreamLinkMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "inert" || value === "togithub") return value;
  return "inert";
}

function isFileNonEmpty(env: NodeJS.ProcessEnv, name: string): boolean {
  const runDir = env.PR_REVIEWER_RUN_DIR ?? env.GITHUB_WORKSPACE ?? process.cwd();
  try {
    return statSync(join(runDir, name)).size > 0;
  } catch {
    return false;
  }
}

/** The platform publish seam (GitHub REST/GraphQL or Forgejo /api/v1). */
export function buildPublishApi(env: NodeJS.ProcessEnv): { api: PublishPlatformApi; platform: string; diffProvider: () => Promise<string> } {
  const repo = env.REPO ?? "";
  const prNumber = env.PR_NUMBER ?? "";
  const platform = resolvePlatform(env.PLATFORM, env.FORGEJO_API_URL ?? "", env.GITHUB_SERVER_URL ?? "");
  const token = platform === "forgejo"
    ? (env.FORGEJO_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || "")
    : ghToken(env);
  const apiOptions = {
    repo,
    prNumber,
    ...(token ? { token: platform === "forgejo" ? token : `Bearer ${token}` } : {}),
    ...(platform === "github" && env.GITHUB_API_URL ? { baseUrl: env.GITHUB_API_URL } : {}),
  };
  const diffProvider = async (): Promise<string> => buildAdapter(env).getPrDiff();
  const api: PublishPlatformApi = platform === "forgejo"
    ? new ForgejoPublishApi({ ...apiOptions, baseUrl: env.FORGEJO_API_URL ?? "", diffProvider })
    : new GitHubPublishApi(apiOptions);
  return { api, platform, diffProvider };
}

/** PublishInput from the stage environment (the composite's publish-step
 * bindings, or the action entry's in-process equivalents). */
export function publishInputFromEnv(env: NodeJS.ProcessEnv, platform: string): PublishInput {
  return {
    mode: publishMode(env.PUBLISH_MODE),
    reviewMarkdown: env.REVIEW_MARKDOWN ?? "",
    verdict: env.VERDICT ?? "",
    analysisEngine: env.ANALYSIS_ENGINE ?? "",
    baseSha: env.BASE_SHA ?? "",
    headSha: env.HEAD_SHA ?? "",
    prNumber: env.PR_NUMBER ?? "",
    commentMarker: env.COMMENT_MARKER ?? "",
    ...(env.BROAD_FINGERPRINT !== undefined ? { broadFingerprint: env.BROAD_FINGERPRINT } : {}),
    requiredChecks: env.REQUIRED_CHECKS ?? "",
    reviewRoute: env.REVIEW_ROUTE ?? "",
    escalationReason: env.ESCALATION_REASON ?? "",
    cacheHitRatio: env.CACHE_HIT_RATIO ?? "",
    inlineFindings: boolInput(env.INLINE_FINDINGS),
    inlineFindingsMax: Number(env.INLINE_FINDINGS_MAX ?? "5") || 5,
    findings: parseJsonish(env.FINDINGS ?? ""),
    cleanupPreviousNativeReviews: env.CLEANUP_PREVIOUS_NATIVE_REVIEWS ?? "",
    allowApprove: boolInput(env.ALLOW_APPROVE),
    approveForks: boolInput(env.APPROVE_FORKS),
    isForkPr: env.IS_FORK_PR === undefined || env.IS_FORK_PR === "" ? null : env.IS_FORK_PR === "true",
    upstreamLinkMode: upstreamLinkMode(env.UPSTREAM_LINK_MODE),
    conditionalPresence: {
      linkedIssue: isFileNonEmpty(env, "linked-issues.md"),
      evidenceProvider: isFileNonEmpty(env, "evidence-providers.md"),
      standards: isFileNonEmpty(env, "standards-present.txt"),
      toolHarnessFindings: isFileNonEmpty(env, "tool-harness.json"),
      toolHarnessResults: isFileNonEmpty(env, "tool-harness.md"),
    },
    ...(env.REREVIEW_LABEL ? { rerunLabel: env.REREVIEW_LABEL } : {}),
    ...(env.VERDICT_POLICY ? { verdictPolicy: env.VERDICT_POLICY } : {}),
    forgejoPositions: platform === "forgejo",
  };
}

/** Publish and relay messages; fail-soft (1 only on a failed publication). */
export async function publishWith(input: PublishInput, seam: ReturnType<typeof buildPublishApi>): Promise<number> {
  const result: PublishResult = await publishReview(input, seam.api, {
    diffText: seam.platform === "forgejo" ? await seam.diffProvider() : "",
  });
  for (const message of result.messages) process.stdout.write(`${message}\n`);
  if (result.error) process.stderr.write(`${result.error}\n`);
  return result.status === "failed" ? 1 : 0;
}

/** `node dist/index.js publish` — the typed successor of
 * `scripts/publish.sh`. Fail-soft: exit 0 on published/superseded, 1 on
 * failed, matching the v2 dispatcher's semantics. */
export async function publishMain(env: NodeJS.ProcessEnv): Promise<number> {
  const seam = buildPublishApi(env);
  return publishWith(publishInputFromEnv(env, seam.platform), seam);
}

function parseJsonish(raw: string): unknown {
  if (raw.trim() === "") return [];
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
