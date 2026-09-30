import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolvePlatform } from "../platform/resolve.js";
import { requireImplementedBackend } from "../platform/tangled.js";
import { GitHubAdapter } from "../platform/github.js";
import { ForgejoAdapter } from "../platform/forgejo.js";
import type { PlatformAdapter } from "../platform/types.js";
import { GitHubPublishApi } from "../platform/publish-api.js";
import { ForgejoPublishApi } from "../platform/publish-api.js";
import { runPrecheck } from "../precheck/decide.js";
import { publishReview, type PublishInput, type PublishResult, type PublishMode } from "../publish/publish.js";
import type { PublishPlatformApi } from "../platform/publish-api.js";
import type { UpstreamLinkMode } from "../publish/sanitize.js";
import { nonEmpty } from "./run-dir.js";
import { partialCoverageOf } from "./review.js";
import type { PartialCoverage } from "../tools/coverage.js";

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
  const platform = resolvePlatform(env.PLATFORM, env.FORGEJO_API_URL ?? "", env.GITHUB_SERVER_URL ?? "", env.TANGLED_REPO_DID ?? "");
  requireImplementedBackend(platform);
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

/** #838: `publish` reads a previous `run`'s artifacts only from an explicit
 * `PR_REVIEWER_RUN_DIR` — never from `GITHUB_WORKSPACE`/the process cwd,
 * which is the reviewed checkout. Falling back to the checkout would let a
 * PR that commits `linked-issues.md` / `evidence-providers.md` /
 * `standards-present.txt` / `tool-harness.json` / `tool-harness.md` at its
 * repository root forge the `conditionalPresence` flags the published review
 * renders. With no run dir given, every conditional reads as absent; a
 * caller that wants a real `run`'s artifacts must pass its `PR_REVIEWER_RUN_DIR`
 * to `publish` explicitly (the action entry does this by construction). */
function isFileNonEmpty(env: NodeJS.ProcessEnv, name: string): boolean {
  const runDir = nonEmpty(env.PR_REVIEWER_RUN_DIR);
  if (runDir === undefined) return false;
  try {
    return statSync(join(runDir, name)).size > 0;
  } catch {
    return false;
  }
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** The result of resolving #810's coverage-gap record for the `publish` CLI
 * path. `unknown: true` (no explicit run dir, or an unreadable/missing
 * harness artifact) is distinct from a confirmed-complete run: it means
 * publish could not confirm the coverage state at all, and must fail
 * closed for approval exactly as a confirmed gap does — see
 * `partialCoverageFromRunDir` below. */
interface CoverageResolution {
  partialCoverage: PartialCoverage | undefined;
  unknown: boolean;
}

/** Mirrors review.ts's own `(env.TOOL_MODE ?? "off").toLowerCase()`
 * normalization exactly (any value other than "native_loop" — including
 * empty, a stale planner-mode value, or an unset var — is "off"), so
 * `publish` and `run` agree on whether a tool harness was ever expected to
 * exist. There is no run artifact recording this independently: `run`
 * simply never writes tool-harness.json when tools are off, which is the
 * one signal ambient TOOL_MODE lets publish tell apart from "the harness
 * ran and its artifact went missing". */
function toolLoopExpected(env: NodeJS.ProcessEnv): boolean {
  return (env.TOOL_MODE ?? "off").trim().toLowerCase() === "native_loop";
}

/** #873/#838: the `publish` CLI subcommand is a separate process from
 * `run`, so it cannot hold the tool harness in memory — it reads the same
 * persisted artifact `runReview` wrote, from the same explicit, non-empty
 * `PR_REVIEWER_RUN_DIR` `isFileNonEmpty` above already requires (never
 * `GITHUB_WORKSPACE`/the process cwd — the reviewed checkout, per #838:
 * a PR could otherwise forge or hide a "complete" tool-harness.json at its
 * repository root). The harness filename mirrors review.ts's own
 * `enforcementHarness` selection: an escalated run publishes the smart
 * harness, everything else the primary one.
 *
 * Three states, not two:
 * - no explicit run dir at all: UNKNOWN — publish cannot check anything.
 * - an explicit run dir, but tools were never expected (tool-mode=off, or
 *   any value review.ts itself treats as off): no harness is ever written
 *   by design, so its absence is NOT a gap — coverage from the tool loop
 *   simply doesn't apply, and a tools-off review can still approve.
 * - an explicit run dir, tools expected, but the harness artifact is
 *   missing or fails to parse: UNKNOWN — the loop should have left a
 *   record and didn't, so publish fails closed exactly like a confirmed
 *   #810 gap, never reading the silence as "it was clean". */
function partialCoverageFromRunDir(env: NodeJS.ProcessEnv): CoverageResolution {
  const runDir = nonEmpty(env.PR_REVIEWER_RUN_DIR);
  if (runDir === undefined) return { partialCoverage: undefined, unknown: true };
  if (!toolLoopExpected(env)) return { partialCoverage: undefined, unknown: false };
  const harnessName = env.REVIEW_ROUTE === "escalated" ? "tool-harness.smart.json" : "tool-harness.json";
  const harness = readJsonObject(join(runDir, harnessName));
  if (harness === null) return { partialCoverage: undefined, unknown: true };
  return { partialCoverage: partialCoverageOf(harness), unknown: false };
}

/** The platform publish seam (GitHub REST/GraphQL or Forgejo /api/v1). */
export function buildPublishApi(env: NodeJS.ProcessEnv): { api: PublishPlatformApi; platform: string; diffProvider: () => Promise<string> } {
  const repo = env.REPO ?? "";
  const prNumber = env.PR_NUMBER ?? "";
  const platform = resolvePlatform(env.PLATFORM, env.FORGEJO_API_URL ?? "", env.GITHUB_SERVER_URL ?? "", env.TANGLED_REPO_DID ?? "");
  requireImplementedBackend(platform);
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
    // #873: the same coverage-gap record `run` computed, read back from its
    // persisted tool-harness artifact so a partial-coverage run can never
    // publish APPROVE through the standalone `publish` CLI path either.
    // `unknown` (no explicit run dir, or an unreadable harness artifact)
    // fails closed the same way: publish must never read "I couldn't check"
    // as "it was clean".
    ...(() => {
      const coverage = partialCoverageFromRunDir(env);
      return {
        ...(coverage.partialCoverage ? { partialCoverage: coverage.partialCoverage } : {}),
        ...(coverage.unknown ? { coverageUnknown: true } : {}),
      };
    })(),
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
