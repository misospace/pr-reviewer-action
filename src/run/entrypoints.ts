import { appendFileSync, closeSync, constants, existsSync, fstatSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
import { readTangledCurrentHeadForContext } from "../platform/tangled-head.js";
import { TangledAtprotoClient, atprotoConfigFromEnv } from "../platform/tangled-atproto.js";
import { tangledContextFromEnv } from "../platform/tangled.js";
import { eventLabelName } from "../precheck/decide.js";
import { publishReview, type PublishInput, type PublishResult, type PublishMode } from "../publish/publish.js";
import { parseInlineFindingsMax } from "../publish/inline-findings.js";
import type { PublishPlatformApi } from "../platform/publish-api.js";
import type { UpstreamLinkMode } from "../publish/sanitize.js";
import { nonEmpty } from "./run-dir.js";
import { buildPlatformReadAdapter } from "./platform.js";
import { partialCoverageOf } from "./review.js";
import type { RunReviewResult } from "./review.js";
import type { PartialCoverage } from "../tools/coverage.js";
import { formatOutputAssignment, isIncompleteReason, type IncompleteReason } from "../publish/outputs.js";
import { resolveReviewTriageDecision } from "../model/triage.js";
import { confidenceTelemetryFromArtifact, type ConfidenceTelemetry } from "../confidence/telemetry.js";
import { isHumanReviewRoutingStatus, type HumanReviewRoutingPlan } from "../routing/human-review-routing.js";
import { blockingReviewObligations, reviewObligationsFromArtifact } from "../enforcement/review-obligations.js";
import { structuredCoverage } from "../enforcement/completeness.js";
import { unresolvedTraceRequirementIds } from "../enforcement/requirement-trace.js";
import { boundedIdList } from "../context/id-lists.js";
import { MODEL_UNAVAILABLE_ENGINE } from "../prompt/failure.js";

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

/** #1449: the run's derived-obligation state, read from the run dir's own
 * `review-coverage.json` artifact (never cwd, never ambient env).
 *
 * This is the ONE seam the standalone `publish` CLI reads the state through,
 * so the composite action and the standalone CLI publish the SAME record from
 * the SAME run — neither path re-derives the state.
 *
 * The state IS a gate, not only disclosure: it decides whether a native
 * approval may publish. So an UNCERTAIN state must fail CLOSED, never open:
 * the engine writes `derived-obligation-state.json` ONLY when the operator
 * enabled the feature, so that file is the run's own "the feature was on"
 * sentinel. When the sentinel is present but the coverage record's state is
 * missing, unreadable, or unrecognized, the state is `unavailable` — the
 * derived coverage is unknown, so the approval is withheld. When the sentinel
 * is absent the feature was off and the state stays absent (the published
 * bytes are exactly the pre-#1449 ones).
 *
 * A run dir that carries neither file is a run without the feature: the
 * state is simply not published, and the publish step's own guardrail sees
 * no derived state. */
function derivedObligationStateFromRunDir(env: NodeJS.ProcessEnv): string | undefined {
  const runDir = nonEmpty(env.PR_REVIEWER_RUN_DIR);
  if (runDir === undefined) return undefined;
  const record = readJsonObject(join(runDir, "review-coverage.json"));
  const state = record === null ? undefined : record.derived_obligation_state;
  if (state === "complete" || state === "unresolved" || state === "unavailable") {
    return state;
  }
  // #1449: fail closed when the run says the feature was on but the state
  // cannot be read — an unknown derived coverage must never certify an
  // approval. The sentinel exists only in a feature-on run.
  const featureEnabled = existsSync(join(runDir, "derived-obligation-state.json"));
  return featureEnabled ? "unavailable" : undefined;
}

/** #1505: the run's required-evidence state, read from the run dir's own
 * `review-coverage.json` artifact (never cwd, never ambient env) — the same
 * seam and the same fail-closed discipline as the derived state above: the
 * engine writes `required-evidence-state.json` ONLY when the review-owned
 * required-evidence contract was active, so a present sentinel with an
 * unreadable state reads `unavailable` (approval withheld), and an absent
 * sentinel means the contract was off (state stays absent, published bytes
 * unchanged). */
function requiredEvidenceStateFromRunDir(env: NodeJS.ProcessEnv): string | undefined {
  const runDir = nonEmpty(env.PR_REVIEWER_RUN_DIR);
  if (runDir === undefined) return undefined;
  const record = readJsonObject(join(runDir, "review-coverage.json"));
  const state = record === null ? undefined : record.required_evidence_state;
  if (state === "complete" || state === "unresolved") {
    return state;
  }
  const featureEnabled = existsSync(join(runDir, "required-evidence-state.json"));
  return featureEnabled ? "unavailable" : undefined;
}

/**
 * #1537: the three merge-gating members the Action path holds in memory
 * (`reviewDerivedPublishFields`) read back from the run directory's OWN
 * artifacts — the obligation rows that blocked the review (#1381/#1521), the
 * open requirement ids (#874), and the unresolved required-check ids (#750/
 * #1518). Without them a review the obligation gate blocked with
 * `request_changes` published a handoff whose empty lists read as "nothing
 * blocked the review". Same doctrine as every other run-dir read here:
 * the run dir, never cwd; an unreadable member stays ABSENT, never a guess
 * (the handoff's own `?? []` keeps the published document identical, and no
 * policy branch reads these lists — they are disclosure).
 *
 * Per-member sources and their fail-closed rules:
 * - `review-obligations.json` — the folded rows, parsed strictly by
 *   `reviewObligationsFromArtifact`; a structurally unrecognizable artifact
 *   publishes nothing. `blockingReviewObligations` keeps only the forcing rows,
 *   non-satisfied rows — exactly what the engine's #1521 in-memory pass names.
 * - `requirement-trace.json` — the trace artifact, written ONLY when the
 *   trace applied; its absence is the review path's own empty list (an
 *   unapplied trace has no rows). Rows are shape-checked here rather than
 *   trusted: `unresolvedTraceRequirementIds` reads a property of every row
 *   directly, and a run-dir artifact is a file any earlier tool could have
 *   written — a non-object row must yield no ids, never an exception.
 * - the required-check ids are NOT persisted on their own; the #750 fold is
 *   recomputed from the run's OWN inputs — the classifier's `must_check` list
 *   (`classification.json`) and the artifact's `required_check_dispositions`
 *   (`ai-output.json`) — but only when the run's coverage record says the
 *   required-check dimension is `incomplete`. The recomputation can then
 *   never contradict what the review published, and a run whose fold was
 *   clean or never validated publishes nothing instead of guessing. A flip
 *   whose only reason is the requirement trace (`incomplete_reason:
 *   "requirement_trace"`) means the completeness fold itself was clean — the
 *   execution reasons include its incompleteness — so there are no open fold
 *   ids either, and nothing is recomputed.
 *
 * The model-unavailable notice path runs NONE of these folds (#1521): its
 * `request_changes` is the notice's own, and the engine still persisted its
 * FALLBACK `must_check` rows to `review-obligations.json`. Reading them back
 * would name checks a review that never reached the model never performed,
 * so the whole set stays absent for a notice run. `analysis_engine.txt` is
 * the run's own record of that path, written by every run that reached the
 * review tail; a run dir without a readable one has no merge-gating state to
 * read back (the admission-skip path writes none of these artifacts).
 */
function mergeGatingFieldsFromRunDir(env: NodeJS.ProcessEnv): Partial<PublishInput> {
  const runDir = nonEmpty(env.PR_REVIEWER_RUN_DIR);
  if (runDir === undefined) return {};
  let engine: string;
  try {
    engine = readFileSync(join(runDir, "analysis_engine.txt"), "utf8").trim();
  } catch {
    return {};
  }
  if (engine === MODEL_UNAVAILABLE_ENGINE) return {};
  const fields: Partial<PublishInput> = {};

  const obligations = reviewObligationsFromArtifact(readJsonObject(join(runDir, "review-obligations.json")));
  if (obligations !== null) fields.unresolvedReviewObligations = blockingReviewObligations(obligations);

  const trace = readJsonObject(join(runDir, "requirement-trace.json"));
  if (trace !== null && Array.isArray(trace.rows)
    && trace.rows.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) {
    fields.unresolvedRequirementIds = unresolvedTraceRequirementIds(trace as never);
  }

  const coverageRecord = readJsonObject(join(runDir, "review-coverage.json"));
  const requiredChecks = coverageRecord === null ? undefined : validateRequiredChecks(coverageRecord.required_checks);
  const incompleteReason = coverageRecord !== null && isIncompleteReason(coverageRecord.incomplete_reason)
    ? coverageRecord.incomplete_reason
    : undefined;
  if (requiredChecks === "incomplete" && incompleteReason !== "requirement_trace") {
    const classification = readJsonObject(join(runDir, "classification.json"));
    const output = readJsonObject(join(runDir, "ai-output.json"));
    if (classification !== null && output !== null) {
      const mustCheck = Array.isArray(classification.must_check)
        ? classification.must_check.filter((item): item is string => typeof item === "string")
        : [];
      const checkCoverage = structuredCoverage(mustCheck, output as never);
      fields.unresolvedRequiredChecks = boundedIdList(
        checkCoverage.checks
          .filter((row) => row.status === "unresolved" || row.status === "unmet")
          .map((row) => row.check),
      );
    }
  }
  return fields;
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

/** #1455: read the verifier's telemetry from the run dir's own
 * `confidence-score.json` artifact (never cwd, never ambient env).
 *
 * This is the ONE seam the publish step reads the telemetry through, so the
 * composite action and the standalone `publish` CLI publish the SAME values
 * from the SAME record — neither path re-derives them, and neither can
 * publish a value the other would not.
 *
 * A missing, unreadable, or structurally unrecognized artifact yields
 * `undefined` (no telemetry), so an uncertain record never publishes a
 * half-validated value. */
function confidenceTelemetryFromRunDir(env: NodeJS.ProcessEnv): ConfidenceTelemetry | undefined {
  const runDir = nonEmpty(env.PR_REVIEWER_RUN_DIR);
  if (runDir === undefined) return undefined;
  const record = readJsonObject(join(runDir, "confidence-score.json"));
  if (record === null) return undefined;
  const telemetry = confidenceTelemetryFromArtifact(record);
  // A record the verifier never ran for publishes nothing: the marker keeps
  // its pre-#1455 bytes exactly.
  if (telemetry.status === "") return undefined;
  return telemetry;
}

/** #1520: the reviewed diff the publish step anchors inline findings against,
 * read from the run dir's own `pr.diff` artifact — the exact bytes the engine
 * reviewed (redacted, complete; `review.ts` writes it before any finding
 * exists). The publish boundary takes its other run-dir artifacts
 * (`review-coverage.json`, `confidence-score.json`) from the same source and
 * for the same reason: a FRESH forge read of the CURRENT head races a push,
 * and the #451 publication-boundary head re-check runs inside
 * `publishReview` — so the anchor map must be built from the revision the
 * review actually covered, never from whatever the forge serves at publish
 * time.
 *
 * `undefined` means "no reviewed diff available" (no run dir, or a missing/
 * unreadable artifact) and the caller falls back to its historical
 * per-platform source. A present-but-empty file IS the reviewed diff (an
 * empty anchor map — nothing can anchor) and is returned as "".
 *
 * The artifact is opened once with no-follow semantics (the same regular-file
 * guarantee as the other security-sensitive reads in `change-anchors.ts` /
 * `mirror.ts`): a symlinked `pr.diff` is refused, never followed, and a run
 * dir containing a NUL byte fails closed — both are "no reviewed diff
 * available" (fallback), never a read through the link. `O_NONBLOCK` keeps a
 * planted FIFO from blocking the open (the regular-file check then refuses
 * it). Where `O_NOFOLLOW` is undefined (Windows: Node exposes the constant
 * only under `#ifdef O_NOFOLLOW` and the Windows CRT has no such flag) the
 * no-follow guarantee degrades to the platform default — intentional and
 * unreachable on a supported deployment: the v3 runner contract is
 * POSIX-only (#679, `src/runtime/platform.ts`), Windows was never
 * demonstrated, and the review's tree-owning children fail closed there, so
 * no shipped run ever produces a run dir whose `pr.diff` could be followed.
 * The sibling no-follow reads (`mirror.ts`, `executor/paths.ts`) state the
 * same accepted degradation. */
function reviewedDiffFromRunDir(runDir: string | undefined): string | undefined {
  if (runDir === undefined) return undefined;
  let fd: number;
  try {
    fd = openSync(join(runDir, "pr.diff"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    return readFileSync(fd, "utf8");
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** The platform publish seam (GitHub REST/GraphQL, Forgejo /api/v1, or the
 * Tangled ATProto record client). `runDir` is the same run directory the
 * caller hands to `publishWithOutcome`; the Forgejo inline-position
 * re-validation anchors against the reviewed diff from THAT run dir and from
 * no other source. */
export function buildPublishApi(env: NodeJS.ProcessEnv, runDir?: string): { api: PublishPlatformApi; platform: string; diffProvider: () => Promise<string> } {
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
    // #1165: the #451 head re-check reads the trusted current head from
    // the knot's `org.tangled.review.patch` records (`tangled-head.ts`):
    // a fresh read on every publication, never the launch-time
    // `TANGLED_PR_SOURCE_SHA` and never the forgeable patch
    // `declaredHeadSha`. An unknown/unreadable head still fails closed
    // (the reader returns null and publication is refused).
    const api = new TangledPublishApi({
      context,
      atproto: new TangledAtprotoClient(atprotoConfigFromEnv(env)),
      // The combined reader correlates the ticket and head in one pass:
      // patch records are keyed by org.tangled.track.ticket, and the
      // source-branch correlation (not target-branch uniqueness) picks
      // this pull's ticket among several open PRs to the same target.
      // Ambiguous/unknown -> null (publication refused).
      currentHeadSha: () => readTangledCurrentHeadForContext(context, {}),
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
  const diffProvider = async (): Promise<string> =>
    // #1520: the Forgejo adapter's inline-position re-validation anchors
    // against the REVIEWED diff when the caller's run dir carries it — a
    // fresh read here would let a comment anchor on content this run never
    // reviewed. The forge's own server-side re-validation against the
    // current head stays the final arbiter and drops what no longer anchors
    // (fail closed). Single source of truth: the run dir enters ONLY through
    // the `runDir` parameter — the same value the caller hands to
    // `publishWithOutcome` — so the two anchor decisions cannot diverge by
    // construction; ambient `PR_REVIEWER_RUN_DIR` is never consulted here.
    // A caller that passes no run dir gets only the fresh-read fallback.
    reviewedDiffFromRunDir(runDir) ?? buildAdapter(env).getPrDiff();
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
  const confidenceTelemetry = confidenceTelemetryFromRunDir(env);
  const derivedObligationState = derivedObligationStateFromRunDir(env);
  const requiredEvidenceState = requiredEvidenceStateFromRunDir(env);
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
    // #1250: the contract default (`inline-findings-max`) is the fallback
    // when the environment carries no INLINE_FINDINGS_MAX. The action path
    // always exports the merged contract default, so only the standalone
    // `publish` CLI — which reads raw env — could fall back to something
    // else; reusing the shared parser keeps the fallback in one place, so
    // the CLI cannot drift from the contract.
    inlineFindingsMax: parseInlineFindingsMax(env.INLINE_FINDINGS_MAX),
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
    // #1455: the verifier's telemetry (the unscored cause, the measured
    // latency, the provider's token counts), read back from the run dir's own
    // artifact so the standalone `publish` CLI publishes the SAME values the
    // composite action does. Absent when the run measured none of them.
    ...(confidenceTelemetry !== undefined ? { confidenceTelemetry } : {}),
    // #1449: the run's derived-obligation state, read back from the run
    // dir's own artifact so the standalone `publish` CLI publishes the SAME
    // record the composite action does. It is a GATE as well as disclosure:
    // the publish boundary refuses a native approval while the state is not
    // `complete`, and an unreadable state in a feature-on run reads
    // `unavailable` (fail closed) so a coverage gap can never certify an
    // approval. Absent when the feature was off.
    ...(derivedObligationState !== undefined ? { derivedObligationState } : {}),
    // #1505: the run's required-evidence state, the same gate-as-disclosure
    // seam as the derived state above (unreadable over an active-contract
    // sentinel fails closed to `unavailable`). Absent when the contract was
    // off.
    ...(requiredEvidenceState !== undefined ? { requiredEvidenceState } : {}),
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
    // #1537: the merge-gating members the Action path derives in memory —
    // the blocking obligation rows, the open requirement ids, and the
    // unresolved required-check ids — read back from the run's own artifacts,
    // so a standalone `publish` of an obligation-blocked review names what
    // blocked it instead of claiming the empty lists did. Unreadable members
    // stay absent, never guessed (see `mergeGatingFieldsFromRunDir`).
    ...mergeGatingFieldsFromRunDir(env),
    forgejoPositions: platform === "forgejo",
  };
}

/** #1257: the publish outcome — the fail-soft exit code plus the typed
 * publication status (`published` / `superseded` / `failed`), so a caller can
 * distinguish "this run published the review" from "the publication boundary
 * withheld it for a newer head" instead of inferring it from exit code 0. */
export interface PublishOutcome {
  exitCode: number;
  status: PublishResult["status"];
}

/** Runs one publication, persists the #1027 findings ledger, relays the
 * step messages, and reports the outcome. */
export async function publishWithOutcome(input: PublishInput, seam: ReturnType<typeof buildPublishApi>, runDir?: string): Promise<PublishOutcome> {
  // #1520: hand the REVIEWED diff to the publish step on EVERY platform. The
  // anchor map `buildComments` derives from it is what makes the contract's
  // `inline-findings` promise real on GitHub (native line-anchored review
  // comments) and lets `hasPublishablePrescription` see the prescriptions, so
  // the #762 usefulness-feedback read runs there too and #1518's handoff can
  // carry a `suggestion`. The historical per-platform sources below remain
  // only as the fallback for a caller with no run dir / no `pr.diff` artifact.
  const diffText = reviewedDiffFromRunDir(runDir)
    ?? (seam.platform === "forgejo" ? await seam.diffProvider() : "");
  const result: PublishResult = await publishReview(input, seam.api, { diffText });
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
  return { exitCode: result.status === "failed" ? 1 : 0, status: result.status };
}

/** Publish and relay messages; fail-soft (1 only on a failed publication). */
export async function publishWith(input: PublishInput, seam: ReturnType<typeof buildPublishApi>, runDir?: string): Promise<number> {
  return (await publishWithOutcome(input, seam, runDir)).exitCode;
}

/** #1257: append the `publish-status` action output (the declared contract
 * id, one closed single-line token — the multiline-delimiter path of
 * `formatOutputAssignment` can never trigger here, but using it keeps the
 * writer shared). A no-op outside a runner (no path, or the /dev/null
 * sentinel), same rule as `writeOutputs`. */
function writePublishStatusOutput(env: NodeJS.ProcessEnv, status: PublishResult["status"]): void {
  const file = env.GITHUB_OUTPUT ?? "";
  if (file === "" || file === "/dev/null") return;
  appendFileSync(file, formatOutputAssignment("publish-status", status));
}

/** `node dist/index.js publish` — the typed successor of
 * `scripts/publish.sh`. Fail-soft: exit 0 on published/superseded, 1 on
 * failed, matching the v2 dispatcher's semantics. #1257: the exit code alone
 * cannot distinguish published from superseded (both exit 0), so this step
 * also writes the `publish-status` output. */
export async function publishMain(env: NodeJS.ProcessEnv): Promise<number> {
  const runDir = nonEmpty(env.PR_REVIEWER_RUN_DIR);
  const seam = buildPublishApi(env, runDir);
  // #1518: this path publishes its own handoff, so it needs its own per-run
  // review id — the same random id the Action entry and the Tangled runner
  // generate. A publisher that carried no review id would publish a handoff
  // that names no review, and the strict parser refuses such a document.
  const reviewId = randomBytes(8).toString("hex");
  const publishInput = { ...publishInputFromEnv(env, seam.platform), reviewId };
  const outcome = await publishWithOutcome(publishInput, seam, runDir);
  writePublishStatusOutput(env, outcome.status);
  return outcome.exitCode;
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
 * JSON. #1369: verifier concerns carry their closed-vocabulary `type` and
 * `severity` tokens through with the file/line/evidence bound; an entry
 * whose tokens are not in the verifier vocabulary degrades to untyped
 * rendering, never a garbage bullet. Absent or malformed means none render. */
function confidenceConcernsFromEnv(raw: string): {
  concerns: Array<{
    file: string;
    line: number | null;
    evidence: string;
    type?: string;
    severity?: string;
  }>;
} | Record<string, never> {
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};
    const CONCERN_TYPES = new Set(["missed_issue", "unsupported_finding"]);
    const CONCERN_SEVERITIES = new Set(["blocker", "major"]);
    const concerns = parsed
      .filter((entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry))
      .slice(0, 8)
      .map((entry) => ({
        file: typeof entry.file === "string" ? entry.file.slice(0, 300) : "",
        line: typeof entry.line === "number" && Number.isInteger(entry.line) && entry.line >= 0 ? entry.line : null,
        evidence: typeof entry.evidence === "string" ? entry.evidence.slice(0, 400) : "",
        ...(typeof entry.type === "string" && CONCERN_TYPES.has(entry.type) ? { type: entry.type } : {}),
        ...(typeof entry.severity === "string" && CONCERN_SEVERITIES.has(entry.severity) ? { severity: entry.severity } : {}),
      }))
      .filter((concern) => concern.file !== "" || concern.evidence !== "");
    return concerns.length > 0 ? { concerns } : {};
  } catch {
    return {};
  }
}

/**
 * #590: the review-result → publish-environment mapping the Action entry and
 * the host-neutral platform runner SHARE. Every field the published review
 * reads from THIS run's engine result is assembled here once, so a Tangled run
 * publishes exactly the same record the GitHub/Forgejo Action would for the
 * identical `RunReviewResult` — the two hosts can never drift on what reaches
 * the publish boundary. The values are the folded engine outputs (the reviewed
 * head is the explicit `reviewedHeadSha` pin, else the event head or
 * admission's resolved head; BASE_SHA/BROAD_FINGERPRINT are admission's;
 * IS_FORK_PR is the final fork flag the review stages ran with, on which
 * publish's approval guardrail fails closed). This is a pure function of its
 * arguments; it mutates nothing and reads no ambient state.
 */
export function publishEnvFromReview(
  stage: Record<string, string | undefined>,
  review: RunReviewResult,
  eventHeadSha: string | undefined,
): Record<string, string | undefined> {
  const pre = review.admission;
  return {
    ...stage,
    HEAD_SHA: review.reviewedHeadSha || eventHeadSha || pre.head_sha,
    BASE_SHA: pre.base_sha,
    IS_FORK_PR: review.isForkPr,
    BROAD_FINGERPRINT: pre.diff_fingerprint,
    VERDICT: review.outputs.verdict,
    REQUIRED_CHECKS: review.outputs.requiredChecks,
    REVIEW_ROUTE: review.outputs.reviewRoute,
    ESCALATION_REASON: review.outputs.escalationReason,
    // #1003: both empty when review-triage is disabled ("did not run"),
    // distinct from the fail-closed "unknown" answer.
    REVIEW_TRIAGE_DECISION: review.outputs.reviewTriageDecision,
    REVIEW_TRIAGE_REASON: review.outputs.reviewTriageReason,
    REVIEW_MARKDOWN: review.outputs.reviewMarkdown,
    FINDINGS: review.outputs.findings,
    ANALYSIS_ENGINE: review.outputs.analysisEngine,
    CACHE_HIT_RATIO: review.outputs.cacheHitRatio,
    DEGRADED_GATE_BYPASS: review.outputs.degradedGateBypass ? "true" : "false",
    VERDICT_POLICY: review.verdictPolicy,
    // #1073: the confidence scorer's results, all empty when disabled.
    CONFIDENCE_STATUS: review.outputs.confidenceStatus ?? "",
    CONFIDENCE_SCORE: review.outputs.confidenceScore ?? "",
    CONFIDENCE_RISK: review.outputs.confidenceRisk ?? "",
    CONFIDENCE_REASON: review.outputs.confidenceReason ?? "",
    CONFIDENCE_MODEL: review.outputs.confidenceModel ?? "",
    ...(review.confidenceConcerns !== undefined
      ? { CONFIDENCE_CONCERNS: JSON.stringify(review.confidenceConcerns) }
      : {}),
  };
}

/**
 * #590: the per-run evidence the PUBLISHED marker carries that does NOT ride
 * the SCREAMING_SNAKE publish environment (partial coverage, the #812 CI
 * conclusion, the #1449 derived-obligation gate, the #1455 verifier telemetry,
 * the #847 tool/context budget provenance, and the #1003 human-review triage
 * section). Shared with the Action entry so both hosts publish one identical
 * record for the same review, in the same field order. Absent values are
 * omitted (never `undefined`) so a feature that did not run leaves the
 * published marker byte-identical to its pre-feature form.
 */
export function reviewDerivedPublishFields(review: RunReviewResult): Partial<PublishInput> {
  return {
    // The #810 coverage notice and the #812 CI conclusion reach the published
    // marker and body only through these.
    ...(review.partialCoverage ? { partialCoverage: review.partialCoverage } : {}),
    ...(review.ciState !== undefined ? { ciState: review.ciState } : {}),
    // #1449: a GATE as well as disclosure — the publish boundary refuses a
    // native approval while the state is not `complete`. Absent when off.
    ...(review.derivedObligationState !== undefined ? { derivedObligationState: review.derivedObligationState } : {}),
    // #1505: a GATE as well as disclosure — the publish boundary refuses a
    // native approval while required review evidence stayed unresolved.
    // Absent when the contract was inactive.
    ...(review.requiredEvidenceState !== undefined ? { requiredEvidenceState: review.requiredEvidenceState } : {}),
    // #1455: advisory verifier telemetry (never touches the verdict).
    ...(review.confidenceTelemetry !== undefined ? { confidenceTelemetry: review.confidenceTelemetry } : {}),
    // #847: the #810/#702 tool-budget provenance.
    ...(review.toolBudget !== undefined ? { toolBudget: review.toolBudget } : {}),
    ...(review.toolBudgetSource !== undefined ? { toolBudgetSource: review.toolBudgetSource } : {}),
    ...(review.toolCallsUsed !== undefined ? { toolCalls: review.toolCallsUsed } : {}),
    ...(review.toolRoundsUsed !== undefined ? { toolRounds: review.toolRoundsUsed } : {}),
    ...(review.toolMaxRounds !== undefined ? { maxRounds: review.toolMaxRounds } : {}),
    ...(review.contextBudget !== undefined ? { contextBudget: review.contextBudget } : {}),
    ...(review.contextPeak !== undefined ? { contextPeak: review.contextPeak } : {}),
    ...(review.toolStopReason !== undefined ? { toolStopReason: review.toolStopReason } : {}),
    // #1518: the enforcement pass's merge-gating ids. They ride the
    // published handoff so a controller can see WHICH obligation stayed
    // open. Absent when the run never reviewed (the admission skip path),
    // so such a run keeps the pre-#1518 publish-input shape.
    ...(review.unresolvedRequirementIds !== undefined ? { unresolvedRequirementIds: review.unresolvedRequirementIds } : {}),
    ...(review.unresolvedRequiredChecks !== undefined ? { unresolvedRequiredChecks: review.unresolvedRequiredChecks } : {}),
    // #1521: the obligation ROWS that blocked the review, so the published
    // handoff names WHAT blocked it and not only an opaque id. Absent when
    // the run never reviewed (the admission skip path), on the same presence
    // rule as the two id lists above.
    ...(review.unresolvedReviewObligations !== undefined ? { unresolvedReviewObligations: review.unresolvedReviewObligations } : {}),
    // #1003: the human-review triage answer reaches the published body only
    // when triage ran ("" when off), so a disabled run's review is
    // byte-identical to pre-#1003. Triage grants no capability.
    ...(review.outputs.reviewTriageDecision !== ""
      ? {
        reviewTriage: {
          decision: review.outputs.reviewTriageDecision,
          reason: review.outputs.reviewTriageReason,
        },
      }
      : {}),
  };
}
