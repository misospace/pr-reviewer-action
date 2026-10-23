import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePlatform } from "../platform/resolve.js";
import { requireImplementedBackend } from "../platform/tangled.js";
import { GitHubAdapter } from "../platform/github.js";
import { ForgejoAdapter } from "../platform/forgejo.js";
import { forgejoTokenFromEnv } from "../platform/forgejo-auth.js";
import type { PlatformAdapter } from "../platform/types.js";
import { GitHubPublishApi } from "../platform/publish-api.js";
import { ForgejoPublishApi } from "../platform/publish-api.js";
import { TangledPublishApi } from "../platform/tangled-publish.js";
import { TangledAtprotoClient, atprotoConfigFromEnv } from "../platform/tangled-atproto.js";
import { tangledContextFromEnv } from "../platform/tangled.js";
import { eventLabelName } from "../precheck/decide.js";
import { publishReview, type PublishInput, type PublishResult, type PublishMode } from "../publish/publish.js";
import type { PublishPlatformApi } from "../platform/publish-api.js";
import type { UpstreamLinkMode } from "../publish/sanitize.js";
import { nonEmpty } from "./run-dir.js";
import { buildPlatformReadAdapter } from "./platform.js";
import { partialCoverageOf } from "./review.js";
import type { PartialCoverage } from "../tools/coverage.js";
import { isIncompleteReason, type IncompleteReason } from "../publish/outputs.js";
import { resolveReviewTriageDecision } from "../model/triage.js";
import { isHumanReviewRoutingStatus, type HumanReviewRoutingPlan } from "../routing/human-review-routing.js";

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
      token: forgejoTokenFromEnv(env),
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

// #914: the `issue_comment` payload's top-level `comment` object, parsed
// defensively into a flat shape the /ai-review re-review command consumes.
// Each sub-field is optional because a malformed / hostile comment must
// degrade to fewer fields, never a throw.
export interface StepEventComment {
  id?: number | string;
  body?: string;
  user?: string;
}

export interface StepEvent {
  name?: string;
  action?: string;
  label?: string;
  comment?: StepEventComment;
}

export function readEvent(env: NodeJS.ProcessEnv): { event?: StepEvent; headSha?: string; prNumber?: string } {
  const path = env.GITHUB_EVENT_PATH ?? "";
  if (path === "") return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      name?: string;
      action?: string;
      label?: unknown;
      pull_request?: { number?: number; head?: { sha?: string } };
      // #914: the `issue_comment` payload shape. The comment's `issue`
      // carries the PR number on `issue.number`, and `issue.pull_request` is
      // present ONLY for comments on a PR (GitHub includes that key only
      // then). A top-level `comment` (`{ id, body, user: { login } }`)
      // carries the comment the re-review command acts on.
      issue?: { number?: number; pull_request?: unknown };
      comment?: { id?: unknown; body?: unknown; user?: { login?: unknown } };
    };
    const event: StepEvent = {};
    // #892: the GitHub (and Forgejo act_runner) event payload has no
    // top-level `name` — the event name lives only in GITHUB_EVENT_NAME.
    // Prefer a payload-provided name if one is ever present, else fall back
    // to the env var.
    const name = parsed.name ?? env.GITHUB_EVENT_NAME;
    if (name !== undefined && name !== "") event.name = name;
    if (parsed.action !== undefined) event.action = parsed.action;
    // #892: a real `labeled` event's `label` is an object (`{ name, color,
    // ... }`), not a string — normalize it the same way the label-cleanup
    // path in action.ts already does, so the precheck gate sees a string.
    const labelName = eventLabelName(parsed.label);
    if (labelName !== "") event.label = labelName;
    // #914: a real `issue_comment` payload has a top-level `comment`
    // (`{ id, body, user: { login } }`). Parse it defensively: each
    // sub-field is kept only when present AND the right type, so a
    // malformed / hostile comment degrades to fewer fields, never a throw.
    // `comment` is omitted entirely when the payload has no comment object.
    const rawComment = parsed.comment;
    if (rawComment !== null && typeof rawComment === "object" && !Array.isArray(rawComment)) {
      const comment: StepEventComment = {};
      const commentId = rawComment.id;
      if (typeof commentId === "number" || typeof commentId === "string") comment.id = commentId;
      if (typeof rawComment.body === "string") comment.body = rawComment.body;
      const commentUser = rawComment.user;
      if (commentUser !== null && typeof commentUser === "object" && !Array.isArray(commentUser)) {
        const commentLogin = commentUser.login;
        if (typeof commentLogin === "string") comment.user = commentLogin;
      }
      event.comment = comment;
    }
    // #914: an `issue_comment` payload has NO top-level `pull_request`, so
    // the PR number lives on `issue.number` — but ONLY when the comment is
    // on a PR, i.e. ONLY when `issue.pull_request` is present. A comment on
    // a plain issue (no `issue.pull_request`) must yield NO prNumber: that
    // absence is the honest signal the workflow/PR check uses to no-op.
    // (headSha is unchanged: issue_comment payloads genuinely have no head
    // SHA and we never fabricate one — the action fetches the PR later.)
    const prNumber =
      typeof parsed.pull_request?.number === "number"
        ? String(parsed.pull_request.number)
        : parsed.pull_request === undefined
          && parsed.issue?.pull_request !== undefined
          && typeof parsed.issue?.number === "number"
          ? String(parsed.issue.number)
          : undefined;
    return {
      ...(Object.keys(event).length > 0 ? { event } : {}),
      ...(parsed.pull_request?.head?.sha !== undefined ? { headSha: parsed.pull_request.head.sha } : {}),
      ...(prNumber !== undefined ? { prNumber } : {}),
    };
  } catch {
    return {};
  }
}

function boolInput(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined || raw === "") return fallback;
  return raw.trim().toLowerCase() === "true";
}

function publishMode(raw: string | undefined): PublishMode {
  const value = raw ?? "";
  if (value === "comment" || value === "review_comment" || value === "review_verdict" || value === "review_blockers") return value;
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
 * path. `unknown: true` (no explicit run dir, an unreadable/unrecognizable
 * artifact, or — when the tool loop ran — a harness pointer that can't be
 * trusted) is distinct from a confirmed-complete run: it means publish
 * could not confirm the coverage state at all, and must fail closed for
 * approval exactly as a confirmed gap does — see `partialCoverageFromRunDir`
 * below. `requiredChecks` is always a validated value (never ambient env,
 * never a normalization of an absent/invalid recorded value — that case is
 * `unknown: true` with the conservative "incomplete"): see
 * `validateRequiredChecks`. */
interface CoverageResolution {
  partialCoverage: PartialCoverage | undefined;
  unknown: boolean;
  requiredChecks: string;
  incompleteReason: string;
}

/** Validates one field of #873's authoritative `review-coverage.json`
 * artifact (see the write site in `review.ts`) — the same shape check
 * `partialCoverageOf` applies to a raw harness's `partial_coverage` field,
 * reused here since the artifact stores the identical structure directly. */
function parsePartialCoverageField(value: unknown): PartialCoverage | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { stop_reason?: unknown }).stop_reason === "string"
    ? value as PartialCoverage
    : undefined;
}

/** The exact value set `completeness.ts`'s `RequiredCheckValidationResult.
 * status` (and so `review.ts`'s `required_checks` artifact field) can
 * produce. Anything else — absent, malformed, a future schema addition — is
 * not a known status: the resolution fails closed (unknown coverage, and
 * the publish input conservatively carries "incomplete") rather than
 * normalizing to "none", which is a legitimate *recorded* status (no
 * required checks configured) and therefore approve-eligible — not a
 * sentinel. */
const REQUIRED_CHECKS_VALUES: ReadonlySet<string> = new Set(["complete", "incomplete", "none"]);

function validateRequiredChecks(value: unknown): string | undefined {
  return typeof value === "string" && REQUIRED_CHECKS_VALUES.has(value) ? value : undefined;
}

/** The only two harness filenames `review.ts` ever records as
 * `enforcement_harness` (see its write site). An allowlist, not a
 * traversal check: `readJsonObject` is only ever called with one of these
 * two literal strings joined to the run dir, so a forged value like
 * `"../x.json"` is simply never a member and is never read at all — it
 * fails the resolution below exactly like `null` or any other stray
 * string would. */
const ENFORCEMENT_HARNESS_NAMES: ReadonlySet<string> = new Set(["tool-harness.json", "tool-harness.smart.json"]);

/** #873 maintainer follow-up: the `publish` CLI subcommand is a separate
 * process from `run`, so it cannot hold `toolMode`/`enforcementHarness`/
 * `required_checks` in memory — and re-deriving any of them from ambient
 * stage env (`TOOL_MODE`, `REVIEW_ROUTE`, `REQUIRED_CHECKS`) is exactly the
 * hole this closes: any of those vars can be omitted, stale, or simply
 * wrong for the run actually being published, letting a partial run read
 * as clean (or a clean run's harness never get consulted). `run`
 * (`review.ts`) instead writes its own authoritative `review-coverage.json`
 * — the one file that always reflects what THIS run actually did — and
 * `publish` reads only that, from the same explicit, non-empty
 * `PR_REVIEWER_RUN_DIR` `isFileNonEmpty` above already requires (never
 * `GITHUB_WORKSPACE`/the process cwd — the reviewed checkout, per #838).
 *
 * Three coverage states, not two:
 * - no explicit run dir, or the artifact is missing/unparseable/
 *   structurally unrecognizable: UNKNOWN — `run` should always have
 *   written this file; publish fails closed rather than guess.
 * - `tool_loop_ran: false` (tool-mode was off for this run): no harness
 *   was ever expected, so there is no gap — a tools-off review can still
 *   approve.
 * - `tool_loop_ran: true`: the artifact's own recorded `partial_coverage`
 *   is authoritative on its own when it's a well-formed confirmed gap —
 *   no need to also read the harness. Otherwise (no confirmed gap
 *   recorded), the ONLY way to confirm the run was actually complete is to
 *   read the exact harness `enforcement_harness` names: that name must be
 *   exactly `tool-harness.json` or `tool-harness.smart.json` (anything
 *   else, including `null`, is never read and resolves UNKNOWN), and the
 *   named file must exist and parse (missing/unparseable also resolves
 *   UNKNOWN, never "must have been clean"). Only a harness that reads
 *   cleanly settles the question, either way. */
function partialCoverageFromRunDir(env: NodeJS.ProcessEnv): CoverageResolution {
  const runDir = nonEmpty(env.PR_REVIEWER_RUN_DIR);
  if (runDir === undefined) return { partialCoverage: undefined, unknown: true, requiredChecks: "none", incompleteReason: "none" };
  const artifact = readJsonObject(join(runDir, "review-coverage.json"));
  if (artifact === null || artifact.version !== 1 || typeof artifact.tool_loop_ran !== "boolean") {
    return { partialCoverage: undefined, unknown: true, requiredChecks: "none", incompleteReason: "none" };
  }
  let requiredChecks = validateRequiredChecks(artifact.required_checks);
  const recordedGap = parsePartialCoverageField(artifact.partial_coverage);
  const recordedReason = isIncompleteReason(artifact.incomplete_reason) ? artifact.incomplete_reason : undefined;
  if (requiredChecks === undefined) {
    // #873 maintainer follow-up: the run writer always emits this field, so
    // an absent or invalid value means the artifact is not one this runtime
    // wrote. Normalizing to "none" would be approve-eligible; fail closed
    // instead — coverage unknown, and the publish input carries the
    // conservative "incomplete" so no policy branch can read the
    // required-check dimension as clean.
    return { partialCoverage: undefined, unknown: true, requiredChecks: "incomplete", incompleteReason: recordedReason ?? "execution" };
  }
  if (recordedReason === "requirement_trace" || recordedReason === "both") requiredChecks = "incomplete";
  const incompleteReason: IncompleteReason = recordedReason !== undefined && recordedReason !== "none"
    ? recordedReason
    : (requiredChecks === "incomplete" || recordedGap !== undefined) ? "execution" : "none";
  if (!artifact.tool_loop_ran) return { partialCoverage: undefined, unknown: false, requiredChecks, incompleteReason };

  if (recordedGap !== undefined) return { partialCoverage: recordedGap, unknown: false, requiredChecks, incompleteReason };

  const harnessName = typeof artifact.enforcement_harness === "string" && ENFORCEMENT_HARNESS_NAMES.has(artifact.enforcement_harness)
    ? artifact.enforcement_harness
    : undefined;
  if (harnessName === undefined) return { partialCoverage: undefined, unknown: true, requiredChecks, incompleteReason };
  const harness = readJsonObject(join(runDir, harnessName));
  if (harness === null) return { partialCoverage: undefined, unknown: true, requiredChecks, incompleteReason };
  return { partialCoverage: partialCoverageOf(harness), unknown: false, requiredChecks, incompleteReason };
}

/** #1005: read the persisted reviewer-routing plan from the run dir (never
 * cwd). A missing, unparseable, or structurally unrecognizable plan yields
 * `undefined` (no routing) so an uncertain plan can never mutate the forge. */
function reviewRoutingFromRunDir(env: NodeJS.ProcessEnv): HumanReviewRoutingPlan | undefined {
  const runDir = nonEmpty(env.PR_REVIEWER_RUN_DIR);
  if (runDir === undefined) return undefined;
  const record = readJsonObject(join(runDir, "review-routing.json"));
  if (record === null) return undefined;
  if (!isHumanReviewRoutingStatus(record.status)) return undefined;
  if (record.mode !== "off" && record.mode !== "advisory" && record.mode !== "request") return undefined;
  const strArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    mode: record.mode,
    status: record.status,
    targetIds: strArray(record.target_ids),
    users: strArray(record.users),
    teams: strArray(record.teams),
    detail: typeof record.detail === "string" ? record.detail : "",
  };
}

/** The platform publish seam (GitHub REST/GraphQL, Forgejo /api/v1, or the
 * Tangled ATProto record client). */
export function buildPublishApi(env: NodeJS.ProcessEnv): { api: PublishPlatformApi; platform: string; diffProvider: () => Promise<string> } {
  const repo = env.REPO ?? "";
  const prNumber = env.PR_NUMBER ?? "";
  const platform = resolvePlatform(env.PLATFORM, env.FORGEJO_API_URL ?? "", env.GITHUB_SERVER_URL ?? "", env.TANGLED_REPO_DID ?? "");
  // #588: Tangled publishes through its own ATProto record seam — it is
  // never routed through the GitHub/Forgejo publish APIs below. The
  // canonical pull identity comes from the Bobbin resolver (#584) inside
  // the adapter; missing ATProto configuration fails closed here with a
  // descriptive error naming the missing variable.
  if (platform === "tangled") {
    const context = tangledContextFromEnv(env);
    // #588: no `currentHeadSha` provider is wired here on purpose — Tangled
    // has no trustworthy current-head source yet (the pull record and the
    // read XRPC expose no head commit, and the patch's `declaredHeadSha` is
    // forgeable advisory metadata). The #451 head re-check therefore FAILS
    // CLOSED for Tangled: the publish step refuses to publish until a
    // trustworthy current-head read exists (#1165). The launch-time
    // `TANGLED_PR_SOURCE_SHA` is never used for that re-check.
    const api = new TangledPublishApi({
      context,
      atproto: new TangledAtprotoClient(atprotoConfigFromEnv(env)),
    });
    const diffProvider = async (): Promise<string> => buildPlatformReadAdapter(env).getPrDiff();
    return { api, platform, diffProvider };
  }
  requireImplementedBackend(platform);
  const token = platform === "forgejo" ? forgejoTokenFromEnv(env) : ghToken(env);
  const apiOptions = {
    repo,
    prNumber,
    ...(token ? { token: platform === "forgejo" ? token : `Bearer ${token}` } : {}),
    ...(platform === "github" && env.GITHUB_API_URL ? { baseUrl: env.GITHUB_API_URL } : {}),
  };
  const diffProvider = async (): Promise<string> => buildAdapter(env).getPrDiff();
  const api: PublishPlatformApi = platform === "forgejo"
    ? new ForgejoPublishApi({
      ...apiOptions,
      baseUrl: env.FORGEJO_API_URL ?? "",
      authMethod: env.FORGEJO_AUTH_METHOD,
      authorizedIntegrationAudience: env.FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE,
      diffProvider,
    })
    : new GitHubPublishApi(apiOptions);
  return { api, platform, diffProvider };
}

/** PublishInput from the stage environment (the composite's publish-step
 * bindings, or the action entry's in-process equivalents). */
export function publishInputFromEnv(env: NodeJS.ProcessEnv, platform: string): PublishInput {
  // #873 maintainer follow-up: resolved once so `requiredChecks` and the
  // coverage-gap fields below come from the SAME read of the run's own
  // authoritative artifact — never from ambient `REQUIRED_CHECKS` stage
  // env, which (like `TOOL_MODE`/`REVIEW_ROUTE` before it) can be omitted
  // or stale for the run actually being published.
  const coverage = partialCoverageFromRunDir(env);
  const reviewRouting = reviewRoutingFromRunDir(env);
  return {
    mode: publishMode(env.PUBLISH_MODE),
    reviewMarkdown: env.REVIEW_MARKDOWN ?? "",
    verdict: env.VERDICT ?? "",
    analysisEngine: env.ANALYSIS_ENGINE ?? "",
    baseSha: env.BASE_SHA ?? "",
    headSha: env.HEAD_SHA ?? "",
    ...(typeof env.PRIOR_HEAD_SHA === "string" && env.PRIOR_HEAD_SHA !== "" ? { priorHeadSha: env.PRIOR_HEAD_SHA.slice(0, 64) } : {}),
    prNumber: env.PR_NUMBER ?? "",
    commentMarker: env.COMMENT_MARKER ?? "",
    ...(env.BROAD_FINGERPRINT !== undefined ? { broadFingerprint: env.BROAD_FINGERPRINT } : {}),
    requiredChecks: coverage.requiredChecks,
    incompleteReason: coverage.incompleteReason,
    reviewRoute: env.REVIEW_ROUTE ?? "",
    escalationReason: env.ESCALATION_REASON ?? "",
    cacheHitRatio: env.CACHE_HIT_RATIO ?? "",
    inlineFindings: boolInput(env.INLINE_FINDINGS),
    inlineFindingsMax: Number(env.INLINE_FINDINGS_MAX ?? "5") || 5,
    findings: parseJsonish(env.FINDINGS ?? ""),
    cleanupPreviousNativeReviews: env.CLEANUP_PREVIOUS_NATIVE_REVIEWS ?? "",
    // #1161: the deprecated `allow-approve` input is read only so the
    // publisher can warn that it no longer affects publication. It gates
    // nothing. The runner merges the contract default into every input it
    // exports, so an input explicitly set to "false" is indistinguishable
    // from an unset one (the same limitation the repository-config
    // narrowing has): only a value that DIFFERS from the default is
    // observable, and only that one warns.
    ...(env.ALLOW_APPROVE !== undefined
      && env.ALLOW_APPROVE.trim() !== ""
      && env.ALLOW_APPROVE.trim().toLowerCase() !== "false"
      ? { allowApprove: boolInput(env.ALLOW_APPROVE) }
      : {}),
    // #1158: the deprecated `publish-review-comment` input, the same
    // observable-value shape as `allow-approve` above: the runner merges the
    // contract default into every input it exports, so an explicitly "false"
    // value is indistinguishable from an unset one, and only the value that
    // differs from the default ("true") warns. It gates nothing — the
    // publisher reads it only to warn that the input no longer has an effect.
    ...(env.PUBLISH_REVIEW_COMMENT !== undefined
      && env.PUBLISH_REVIEW_COMMENT.trim() !== ""
      && env.PUBLISH_REVIEW_COMMENT.trim().toLowerCase() !== "false"
      ? { publishReviewComment: boolInput(env.PUBLISH_REVIEW_COMMENT) }
      : {}),
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
    // #1003: the human-review triage answer, mirrored from the action's own
    // publish env so a standalone `publish` re-publish carries the same
    // section the review run would have written. Empty means triage did not
    // run — distinct from the fail-closed `unknown` answer, which is a real
    // value here and must still render. A value that is neither empty nor one
    // of the three literals — and an unsubstantiated `not_required` — fails
    // closed here too, at this boundary, rather than relying on a downstream
    // renderer to reject it.
    ...(env.REVIEW_TRIAGE_DECISION
      ? {
        reviewTriage: {
          decision: resolveReviewTriageDecision(env.REVIEW_TRIAGE_DECISION, env.REVIEW_TRIAGE_REASON ?? ""),
          reason: env.REVIEW_TRIAGE_REASON ?? "",
        },
      }
      : {}),
    ...(env.VERDICT_POLICY ? { verdictPolicy: env.VERDICT_POLICY } : {}),
    // #1073: the confidence scorer's result, present only when the scorer ran
    // (confidence-status is "" when disabled). Advisory only.
    ...(env.CONFIDENCE_STATUS
      ? {
        confidence: {
          status: env.CONFIDENCE_STATUS,
          score: env.CONFIDENCE_SCORE ?? "",
          risk: env.CONFIDENCE_RISK ?? "",
          reason: env.CONFIDENCE_REASON ?? "",
          model: env.CONFIDENCE_MODEL ?? "",
          ...(confidenceConcernsFromEnv(env.CONFIDENCE_CONCERNS ?? "")),
        },
      }
      : {}),
    degradedGateBypass: env.DEGRADED_GATE_BYPASS === "true",
    // #1005: the deterministic reviewer-routing plan the review step persisted
    // (read from the run dir, never cwd). Absent when routing did not run.
    ...(reviewRouting ? { reviewRouting } : {}),
    // #873: the same coverage-gap record `run` computed, read back from its
    // persisted artifact so a partial-coverage run can never publish
    // APPROVE through the standalone `publish` CLI path either. `unknown`
    // (no explicit run dir, or an unreadable/unrecognizable artifact)
    // fails closed the same way: publish must never read "I couldn't check"
    // as "it was clean".
    ...(coverage.partialCoverage ? { partialCoverage: coverage.partialCoverage } : {}),
    ...(coverage.unknown ? { coverageUnknown: true } : {}),
    forgejoPositions: platform === "forgejo",
  };
}

/** Publish and relay messages; fail-soft (1 only on a failed publication). */
export async function publishWith(input: PublishInput, seam: ReturnType<typeof buildPublishApi>, runDir?: string): Promise<number> {
  const result: PublishResult = await publishReview(input, seam.api, {
    diffText: seam.platform === "forgejo" ? await seam.diffProvider() : "",
  });
  // #1027: the artifact is written only for a review that was actually
  // published (or superseded): a failed publication never published the
  // current findings, so their `reported` events must not reach the ledger.
  // #1128: the lifecycle is explicit in BOTH directions. A reused run
  // directory (`PR_REVIEWER_RUN_DIR`) can still hold the PREVIOUS run's
  // ledger, so an invocation that withholds the artifact (unproven head) or
  // fails publication must REMOVE the stale file instead of leaving it: a
  // withheld artifact means "this run has no provable ledger", and a stale
  // prior ledger left in place would read to downstream consumers as if it
  // were the current run's. A removal failure is never silent.
  if (runDir) {
    const artifactPath = join(runDir, "finding-outcomes.json");
    const ledger = result.status !== "failed" ? result.outcomes : undefined;
    let persisted = false;
    if (ledger !== undefined) {
      try { writeFileSync(artifactPath, ledger, "utf8"); persisted = true; }
      catch { process.stderr.write("WARN: Could not write finding outcomes artifact\n"); }
    }
    if (!persisted) {
      // Withheld (unproven head), failed publication, or a failed write: a
      // prior (or half-written) ledger must never stay readable as this
      // run's artifact.
      try { rmSync(artifactPath, { force: true }); }
      catch { process.stderr.write("WARN: Could not remove stale finding outcomes artifact\n"); }
    }
  }
  for (const message of result.messages) process.stdout.write(`${message}\n`);
  if (result.error) process.stderr.write(`${result.error}\n`);
  return result.status === "failed" ? 1 : 0;
}

/** `node dist/index.js publish` — the typed successor of
 * `scripts/publish.sh`. Fail-soft: exit 0 on published/superseded, 1 on
 * failed, matching the v2 dispatcher's semantics. */
export async function publishMain(env: NodeJS.ProcessEnv): Promise<number> {
  const seam = buildPublishApi(env);
  return publishWith(publishInputFromEnv(env, seam.platform), seam, nonEmpty(env.PR_REVIEWER_RUN_DIR));
}

function parseJsonish(raw: string): unknown {
  if (raw.trim() === "") return [];
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** #1073: bounded confidence concerns from the review step, serialized as
 * JSON. Absent or malformed means none render — never a garbage bullet. */
function confidenceConcernsFromEnv(raw: string): { concerns: Array<{ file: string; line: number | null; evidence: string }> } | Record<string, never> {
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};
    const concerns = parsed
      .filter((entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry))
      .slice(0, 8)
      .map((entry) => ({
        file: typeof entry.file === "string" ? entry.file.slice(0, 300) : "",
        line: typeof entry.line === "number" && Number.isInteger(entry.line) && entry.line >= 0 ? entry.line : null,
        evidence: typeof entry.evidence === "string" ? entry.evidence.slice(0, 400) : "",
      }))
      .filter((concern) => concern.file !== "" || concern.evidence !== "");
    return concerns.length > 0 ? { concerns } : {};
  } catch {
    return {};
  }
}
