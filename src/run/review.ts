import { V3_CONTRACT } from "../../.v3-generated/contract.generated.js";
import { validateContract } from "../config/contract.js";
import { loadConfig, type RawInputs } from "../config/load-config.js";
import { resolveRepositoryConfig } from "../config/repository-config.js";
import { resolveRequirementOwners } from "../config/requirement-owners.js";
import { assertSupportedNode } from "../runtime/node-version.js";
import { createCancellationScope } from "../runtime/signals.js";
import { resolveTierBudgets } from "../corpus/budgets.js";
import { prioritizeDiff } from "../corpus/diff-priority.js";
import { truncateClean } from "../corpus/truncate.js";
import { readFileSync, appendFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { canonicalChangedFile, normalizeLinkedIssues } from "../context/types.js";
import { pythonJsonStringify } from "../precheck/metadata.js";
import { buildHarnessObligations } from "../requirements/obligations.js";
import { externalChecksConclusion } from "../precheck/decide.js";
import { readStandardsFileAtRef, StandardsFileRefError } from "../context/standards-file-ref.js";
import { loopContextLimits } from "../tools/harness.js";
import { DEFAULT_STANDARDS_FILE_CANDIDATES } from "../context/standards-file.js";
import { runChatRequest } from "../transport/transport.js";
import { describeTransportFailure } from "../transport/http.js";
import type { FetchLike } from "../platform/http.js";
import { normalizePrIdentity } from "../platform/pr.js";
import type { PlatformReadAdapter } from "../platform/types.js";
import { buildPlatformReadAdapter } from "./platform.js";
import { buildStageEnv, validateStageEnv, type RunContext, type StageEnv } from "./env.js";
import { RunWorkspace } from "./workspace.js";
import { createRunDir, nonEmpty } from "./run-dir.js";
import { trustFramingOverhead } from "../context/repo-map.js";
import { generateRepoMap, renderRepoMapJson, renderRepoMapMarkdown } from "../context/repo-map.js";
import {
  buildLinkedIssueContext,
  buildManifestContext,
  buildRepoImpactHistory,
} from "../context/index.js";
import { extractRequirementLedger, ledgerToArtifact, renderRequirementLedgerMarkdown } from "../requirements/ledger.js";
import { requirementLedgerPresence } from "../requirements/presence.js";
import { classifyPr, classificationToArtifact } from "../classification/classify.js";
import { resolveReviewRoute, resolveTierProfiles, tierRequestShape, type TierProfiles } from "../routing/tiers.js";
import { reviewerRequestedEscalation } from "../routing/escalation.js";
import { buildSpecialistCorpus } from "../specialists/corpus.js";
import { forkGate, type ForkedGate, type GateName, type GateOutcome } from "../gates/gates.js";
import { ciGateBranch } from "../gates/workloads.js";
import { runSpecialistsGate } from "../gates/specialists-gate.js";
import { specialistRequestFn } from "../gates/specialist-transport.js";
import { runClaimFalsificationPass } from "../claims/pass.js";
import { renderClaimsSection } from "../claims/render.js";
import { buildModelRequest } from "../model/request.js";
import { callModelTier, type TierProfile } from "../model/call.js";
import { parseVerdictResponse } from "../model/verdict.js";
import { annotateAnalysisEngine, analysisEngineBase, buildUserMessage, handleModelFailure, MODEL_UNAVAILABLE_ENGINE, publicAnalysisEngine, applySystemPromptFragments, applySpecialistLeadsFragment, applySupersededDiscussionFragment, applyRequirementTraceFragment, resolveSystemPrompt, workspaceAt, type PromptWorkspace } from "../prompt/index.js";
import { reviewArtifactFromParsed } from "../enforcement/artifact.js";
import { applyStrictVerdictPolicy, applyVerdictPolicy, relaxVerificationOnlyVerdict } from "../enforcement/verdict-policy.js";
import { markerReviewResult } from "../publish/publish.js";
import type { PartialCoverage } from "../tools/coverage.js";
import { applyRequiredCheckValidation } from "../enforcement/completeness.js";
import { applyAllEnforcement, failClosedEnforcementFired, type EnforcementInputs } from "../enforcement/enforce.js";
import { normalizeRequirementCoverage } from "../enforcement/requirement-coverage.js";
import { applyRequirementTraceEnforcement, changedSubjectText, distributedRequirementHints, distributedRequirementWarnings, ledgerRequirementsById, mergeTraceClaims, missingTraceRequirementIds, requirementTraceScope } from "../enforcement/requirement-trace.js";
import { runRequirementTraceRepairPass } from "../requirements/trace-repair.js";
import { pyJsonDumps } from "../evidence/pyjson.js";
import { buildRunMetadataMarker } from "../metadata/markers.js";
import { ACTION_VERSION } from "../version.js";
import {
  buildCacheHitRatioOutput,
  buildToolCallsOutput,
  formatOutputAssignment,
  formatReviewStepOutputs,
  renderStepSummary,
  type IncompleteReason,
  type ReviewStepOutputs,
} from "../publish/outputs.js";
import {
  assembleCorpus,
  buildEquivalentPathsSection,
  buildHumanReviewsSection,
  buildPrThreadSection,
  buildRelatedCodeSection,
  buildReviewThreadsSection,
  ciChecksBytes,
  deriveFork,
  extractEnrichmentArtifacts,
  filesProjection,
  generatedAttributePaths,
  persistOutputs,
  projectPr,
  renderLinkedSourcesPhase,
  runEvidencePhase,
  runImageDigestPhase,
  authoritativeBodyRevision,
  runToolHarnessPhase,
  safeJson,
  safeJsonArray,
  seededFileTotals,
  specialistWorkspace,
} from "./stages.js";
import type { ReadResult } from "../platform/types.js";

/**
 * The v3 end-to-end review orchestrator (#809): the typed successor of
 * `scripts/run_review.sh`. Stage order, artifact names and decision points
 * are v2's; state between stages is typed in-memory values (config,
 * classification, route, system prompt, verdict) plus the run workspace's
 * artifact bus — persisted to the run directory only where outputs, evals,
 * diagnostics or the shadow comparison read it. No Python, no shell.
 */

export class RunReviewError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "RunReviewError";
    this.exitCode = exitCode;
  }
}

export interface RunReviewOptions {
  /** The ambient runner environment (INPUT_* values, GITHUB_* context). */
  env: NodeJS.ProcessEnv;
  /** Direct input overrides (tests); defaults to INPUT_* extraction. */
  inputs?: RawInputs;
  /** The reviewed checkout; defaults to GITHUB_WORKSPACE or the process cwd. */
  workspace?: string;
  /** Where artifacts persist; defaults to PR_REVIEWER_RUN_DIR, or a fresh
   * private temp directory when neither is set (#838: never the process
   * cwd/workspace — that would let a reviewed checkout seed its own
   * artifacts). */
  runDir?: string;
  fetchImpl?: FetchLike;
  /** Direct adapter override (tests); default builds one from the env. */
  platformAdapter?: PlatformReadAdapter;
  /** Disk mirror of the artifact bus (default true). */
  persistArtifacts?: boolean;
  now?: () => number;
  sleep?: (seconds: number) => Promise<void>;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Override the CI gate branch (tests). Explicit null disables the gate
   * even when ci-status-check is on; undefined = the default subprocess
   * branch re-entering the bundle. */
  ciGate?: ReturnType<typeof ciGateBranch> | null;
  /** Override the bundle entry the CI subprocess re-enters (tests). */
  ciGateEntry?: string;
  /** Quiet: suppress the default stderr log sink (tests). */
  quiet?: boolean;
}

export interface RunReviewResult {
  outputs: ReviewStepOutputs;
  /** The resolved artifact directory this run wrote to (#838 follow-up): the
   * caller's own `runDir`/`PR_REVIEWER_RUN_DIR` when given, else the fresh
   * private temp directory the default created — also logged once (`run
   * artifacts: <path>`) and written to `GITHUB_OUTPUT` as `run-dir`. */
  runDir: string;
  /** The run metadata marker the publish step embeds (a shadow-comparison
   * surface; the run entry itself never publishes). */
  marker: string;
  artifacts: ReadonlyMap<string, Uint8Array>;
  reviewArtifact: Record<string, unknown>;
  route: string;
  routeReason: string;
  analysisEngine: string;
  classification: Record<string, unknown>;
  ciGate: GateOutcome;
  specialistGate: GateOutcome;
  /** The resolved verdict policy, plus the #810 coverage record and the #812
   * CI conclusion the publish step needs for the marker and body. */
  verdictPolicy: string;
  partialCoverage?: PartialCoverage;
  ciState?: string;
  /** #847: the #810/#702 tool-loop budget the marker recorded (mirrors the
   * harness's `tool_request_budget` for the route the marker was built
   * from); undefined when no tool harness ran. */
  toolBudget?: number;
  /** #847: which source won ("primary-override" | "smart-override" |
   * "explicit" | "tier-default" | "size-scaled"). */
  toolBudgetSource?: string;
  /** #847: tool calls the loop actually executed against that budget. */
  toolCallsUsed?: number;
  /** #895: rounds the loop actually used, and the resolved round cap it ran
   * against (see `adaptiveLoopBudgets` in src/tools/loop.ts). */
  toolRoundsUsed?: number;
  toolMaxRounds?: number;
  /** #922: the loop's conversation budget and peak (approx tokens). */
  contextBudget?: number;
  contextPeak?: number;
  /** Wall-clock seconds for the whole run. */
  durationSec: number;
}

const NO_GATE_OUTCOME = (gate: GateName): GateOutcome => ({
  gate,
  ran: false,
  ok: true,
  status: "not_launched",
  exitCode: null,
  durationMs: 0,
  error: null,
  survivedPids: [],
});

/** Scratch file the CI gate child writes its step outputs to. */
const CI_GATE_OUTPUT_FILE = "ci-gate-outputs.txt";

/** The CI gate's `ci_status_final` / `ci_status_skipped` step outputs as the
 * contract's kebab-case output assignments. */
export function ciGateOutputs(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^(ci_status_final|ci_status_skipped)=([A-Za-z_-]*)$/.exec(line.trim());
    if (match) values.set(match[1]!.replaceAll("_", "-"), match[2]!);
  }
  return [...values].map(([key, value]) => `${key}=${value}\n`).join("");
}

/** Set on every gate child; a process carrying it never starts a review. */
export const GATE_CHILD_ENV = "PR_REVIEWER_GATE_CHILD";

/** The bundle a gate child is launched from: an explicit PR_REVIEWER_ENTRY,
 * or this process's own entry when it is the built `dist/index.js`. Anything
 * else (a test runner file) is not a runtime entry — launching it would
 * re-run that file instead of the gate. */
export function runtimeBundleEntry(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.PR_REVIEWER_ENTRY ?? "";
  if (explicit !== "") return explicit;
  const own = process.argv[1] ?? "";
  return /(?:^|[\\/])dist[\\/]index\.js$/.test(own) ? own : null;
}

/** The contract inputs as the runner exports them: `INPUT_<ID>` with kebab
 * IDs kept literally (`INPUT_GITHUB-TOKEN`), then the underscore form, the
 * v2 SCREAMING_SNAKE binding, and GH_TOKEN/GITHUB_TOKEN for the token. */
export function rawInputsFromEnv(
  contract: ReturnType<typeof validateContract>,
  env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const options = { env };
  return Object.fromEntries(contract.inputs.map(({ id, v2_id }) => [
      id,
      // The runner exports composite inputs as INPUT_<ID uppercased
      // literally — kebab IDs keep their hyphens (`INPUT_GITHUB-TOKEN`).
      // The underscore form and the composite's SCREAMING_SNAKE bindings
      // (the v2 names, unchanged — only the public IDs went kebab) are the
      // compatibility fallbacks.
      options.env[`INPUT_${id.toUpperCase()}`]
        ?? options.env[`INPUT_${id.toUpperCase().replaceAll("-", "_")}`]
        ?? (v2_id !== undefined && v2_id !== "" ? options.env[v2_id.toUpperCase()] : undefined)
        // The token rides the shared env file as GH_TOKEN/GITHUB_TOKEN (the
        // composite's only token consumer is the platform auth binding);
        // the runner does not export a hyphenated INPUT_ name for it.
        ?? (id === "github-token" ? (options.env.GH_TOKEN ?? options.env.GITHUB_TOKEN) : undefined),
    ]));
}

export async function runReview(options: RunReviewOptions): Promise<RunReviewResult> {
  const clock = options.now ?? ((): number => Date.now() / 1000);
  const started = clock();
  const log = (line: string): void => {
    if (options.quiet) return;
    (options.log ?? ((text) => process.stderr.write(`[v3] ${text}\n`)))(line);
  };
  const errorLog = (line: string): void =>
    (options.error ?? ((text) => process.stderr.write(`[v3] ERROR: ${text}\n`)))(line);

  assertSupportedNode(process.versions.node);
  if (options.env[GATE_CHILD_ENV] === "1") {
    throw new RunReviewError("refusing to start a review inside a gate child process");
  }
  const contract = validateContract(V3_CONTRACT);

  // ── Config stage (config.sh) ─────────────────────────────────────────
  const raw: Record<string, string | undefined> = options.inputs
    ? { ...options.inputs }
    : rawInputsFromEnv(contract, options.env);
  const baseRef = options.env.PR_REVIEWER_BASE_REF ?? "";
  let effectiveRaw = raw;
  if (baseRef !== "") {
    const resolution = resolveRepositoryConfig(contract, raw, {
      baseRef,
      workspace: options.workspace ?? options.env.GITHUB_WORKSPACE,
    });
    for (const warning of resolution.warnings) errorLog(`repository config: ${warning}`);
    effectiveRaw = resolution.raw;
  }
  const config = loadConfig(contract, effectiveRaw);

  // #838: an explicit run dir (the caller's own, or PR_REVIEWER_RUN_DIR) is
  // reused as given; with neither, the default is a fresh private temp dir —
  // never process.cwd(), which for the `run` CLI subcommand is the reviewed
  // PR checkout. Reusing checkout content as this run's own artifacts (the
  // "Reusing PR diff fetched by precheck" / pr-files.seed.json paths below)
  // would let a PR that commits pr.diff / pr-files.seed.json at its root
  // control the diff/file list the reviewer sees. `nonEmpty` normalizes an
  // empty/whitespace-only value to absent: `""` would otherwise survive `??`
  // and resolve (via Node's path APIs) to the process cwd anyway — silently
  // reopening the exact hole this default was fixed to close.
  const runDir = nonEmpty(options.runDir) ?? nonEmpty(options.env.PR_REVIEWER_RUN_DIR)
    ?? createRunDir(options.env.RUNNER_TEMP || options.env.TMPDIR || "/tmp");
  // The run dir is reported once — stderr for a human/log reader, and
  // GITHUB_OUTPUT (when set) for a caller chaining `run` into a later step —
  // since with no explicit runDir/PR_REVIEWER_RUN_DIR it is an anonymous
  // private temp directory the caller has no other way to discover. A
  // caller chaining `run` into `publish` should still pass PR_REVIEWER_RUN_DIR
  // explicitly to both rather than relying on this output.
  log(`run artifacts: ${runDir}`);
  persistOutputs(options.env.GITHUB_OUTPUT ?? "/dev/null", formatOutputAssignment("run-dir", runDir));
  // #838: the workspace (the checkout tools read: repo map, standards file,
  // related-code context) stays GITHUB_WORKSPACE/cwd as before — only the
  // artifact run dir's default changed above. Falling back to `runDir` here
  // would point the workspace at the fresh, empty private temp dir instead
  // of the actual checkout.
  const workspace = options.workspace ?? options.env.GITHUB_WORKSPACE ?? process.cwd();
  const repo = config.repo !== "" ? String(config.repo) : options.env.GITHUB_REPOSITORY ?? "";
  const prNumberRaw = config.prNumber;
  const prNumber = prNumberRaw !== "" && prNumberRaw !== undefined ? String(prNumberRaw) : options.env.PR_NUMBER ?? "";
  const headSha = options.env.PR_HEAD_SHA ?? options.env.GITHUB_SHA ?? "";
  const context: RunContext = {
    workspace,
    runDir,
    repo,
    prNumber,
    headSha,
    isForkPr: options.env.IS_FORK_PR ?? "",
    platform: options.env.PLATFORM ?? "",
    forgejoApiUrl: options.env.FORGEJO_API_URL ?? "",
    ciChecksFile: options.env.CI_CHECKS_FILE ?? `${runDir}/ci-checks-context.md`,
    outputFilePath: options.env.GITHUB_OUTPUT ?? "/dev/null",
    stepSummaryPath: options.env.GITHUB_STEP_SUMMARY ?? "",
    baseRef,
  };
  const env = buildStageEnv(config, context, options.env) as StageEnv;
  const missing = validateStageEnv(env);
  if (missing !== null) throw new RunReviewError(missing);

  const budgets = resolveTierBudgets({
    modelContextTokens: env.MODEL_CONTEXT_TOKENS,
    primaryModelContextTokens: env.PRIMARY_MODEL_CONTEXT_TOKENS,
    smartModelContextTokens: env.SMART_MODEL_CONTEXT_TOKENS,
    // #922: only a configured fallback model can receive the shared corpus.
    fallbackModelContextTokens: (env.AI_FALLBACK_MODEL ?? "") !== "" ? env.FALLBACK_MODEL_CONTEXT_TOKENS : undefined,
    aiMaxTokens: env.AI_MAX_TOKENS,
    contextLimitMode: env.CONTEXT_LIMIT_MODE,
  });
  // #922: a declared window too small for the native loop fails up front,
  // like a too-small corpus window, rather than overflowing every turn.
  if ((env.TOOL_MODE ?? "off").toLowerCase() === "native_loop") {
    loopContextLimits(env, "primary");
    if (env.AI_SMART_MODEL) loopContextLimits(env, "smart");
  }
  env.MAX_CORPUS = String(budgets.primary.maxCorpus);
  env.MAX_DIFF = String(budgets.primary.maxDiff);
  env.MAX_FILES = String(budgets.primary.maxFiles);
  env.PRIMARY_MAX_CORPUS = String(budgets.primary.maxCorpus);
  env.PRIMARY_MAX_DIFF = String(budgets.primary.maxDiff);
  env.PRIMARY_MAX_FILES = String(budgets.primary.maxFiles);
  env.SMART_MAX_CORPUS = String(budgets.smart.maxCorpus);
  env.SMART_MAX_DIFF = String(budgets.smart.maxDiff);
  env.SMART_MAX_FILES = String(budgets.smart.maxFiles);

  // Every ws.write below persists forge/model-read data as run artifacts —
  // untrusted data on disk is the pipeline's design (CodeQL
  // js/http-to-file-access); the trust boundaries are the publication
  // sanitizer, the corpus fences, and the never-execute rule.
  const ws = new RunWorkspace(runDir, options.persistArtifacts ?? true);
  const adapter: PlatformReadAdapter = options.platformAdapter ?? buildPlatformReadAdapter(env, options.fetchImpl);
  const profiles: TierProfiles = resolveTierProfiles(env);
  const streamBool = (env.AI_STREAM ?? "true").toLowerCase() === "true";

  // Standards resolution + initial system prompt (config.sh).
  const standards = resolveStandards(env, workspace, baseRef, errorLog);
  let promptState = resolveSystemPrompt(
    {
      ...(env.SYSTEM_PROMPT !== undefined ? { systemPrompt: env.SYSTEM_PROMPT } : {}),
      ...(env.SYSTEM_PROMPT_FILE !== undefined ? { systemPromptFile: env.SYSTEM_PROMPT_FILE } : {}),
      ...(env.SYSTEM_PROMPT_MODE !== undefined ? { systemPromptMode: env.SYSTEM_PROMPT_MODE } : {}),
    },
    promptFileWorkspace(workspace, baseRef),
  );
  log(`Analyzing #${prNumber} in ${repo} with ${env.AI_MODEL} using ${env.AI_API_FORMAT} API format...`);

  // ── Context stage (context.sh) ───────────────────────────────────────
  let prObject: unknown = null;
  const cachedObject = ws.read("pr-object.json");
  if (cachedObject !== null && cachedProjectNumber(cachedObject) === Number(prNumber)) {
    log("Reusing PR object fetched by precheck");
    prObject = JSON.parse(Buffer.from(cachedObject).toString("utf8")) as unknown;
  } else {
    prObject = await adapter.getPr();
    if (prObject !== null && prObject !== undefined) ws.write("pr-object.json", pyJsonDumps(prObject));
  }
  const pr = projectPr(prObject, prNumber);
  // #812 review: the authoritative body and its edit instant are ONE atomic
  // platform snapshot, fetched once per metadata pass. The snapshot's body
  // is what the corpus presents and its `editedAt` the only cutoff the
  // discussion renderers label with — a separately fetched timestamp could
  // soften discussion against a description the corpus never showed. Null
  // (no seam, failed read) keeps the REST body and labels nothing.
  let bodyRevision = await authoritativeBodyRevision(adapter);
  if (bodyRevision !== null) pr.body = bodyRevision.body;
  let supersededCutoff = bodyRevision === null ? null : bodyRevision.editedAt;
  ws.write("pr.json", pyJsonDumps(pr));
  if (context.isForkPr === "") {
    env.IS_FORK_PR = deriveFork(prObject);
    context.isForkPr = env.IS_FORK_PR;
  }
  const forkFlag = env.IS_FORK_PR ?? "false";
  if (forkFlag === "true") log("Detected cross-repository pull request");

  // Specialist lead artifacts reset (#609): unconditional, before anything
  // can consume a stale value.
  ws.write("specialists.md", "");
  ws.write("specialist-leads-present.txt", "");

  let diffText: string;
  const cachedDiff = ws.readText("pr.diff");
  if (cachedDiff !== null && cachedDiff !== "") {
    log("Reusing PR diff fetched by precheck");
    diffText = cachedDiff;
  } else {
    diffText = await adapter.getPrDiff();
    ws.write("pr.diff", diffText);
  }
  const identity = normalizePrIdentity(prObject);
  const generatedPaths = await generatedAttributePaths(workspace, diffText, budgets.primary.maxDiff);
  ws.write("pr.diff.truncated", prioritizeDiff(Buffer.from(diffText, "utf8"), budgets.primary.maxDiff, { generated: generatedPaths }));

  const seedBytes = ws.read("pr-files.seed.json");
  let rawFilesList: unknown[];
  let totalChangedFiles: number;
  if (seedBytes !== null) {
    // #833/#835: the file manifest is part of a pinned replay's identity — a
    // present-but-unusable seed (unparsable, not an array, or an entry
    // without a string filename; a zero-byte file included) must never fall
    // back to the live list, which would silently reintroduce the bug this
    // seam fixes. Absence alone (no seed at all) is the unchanged production
    // path below.
    const seededFiles = seedBytes.length > 0 ? safeJsonArray(seedBytes) : null;
    const seedValid = seededFiles !== null && seededFiles.every(
      (file) => typeof file === "object" && file !== null && typeof (file as Record<string, unknown>).filename === "string",
    );
    if (!seedValid) throw new RunReviewError("pr-files.seed.json is present but malformed (expected a JSON array of file objects with a string filename)");
    log("Reusing PR file list derived from the pinned diff");
    rawFilesList = seededFiles;
    const totals = seededFileTotals(rawFilesList);
    totalChangedFiles = totals.changedFiles;
    pr.changedFiles = totals.changedFiles;
    pr.additions = totals.additions;
    pr.deletions = totals.deletions;
    ws.write("pr.json", pyJsonDumps(pr));
    ws.write("pr-files.raw.json", pyJsonDumps(rawFilesList));
  } else {
    const filesResult = await adapter.listPrFiles();
    if (!filesResult.ok) throw new RunReviewError(`platform_pr_files failed: ${filesResult.error}`);
    const prFilesRaw = filesResult.data;
    ws.write("pr-files.raw.json", pyJsonDumps(prFilesRaw));
    totalChangedFiles = typeof pr.changedFiles === "number" ? pr.changedFiles : 0;
    rawFilesList = Array.isArray(prFilesRaw) ? prFilesRaw : [];
  }
  ws.write("pr-files.json", filesProjection(rawFilesList, totalChangedFiles));
  ws.write("pr-files.truncated.json", truncateClean(Buffer.from(filesProjection(rawFilesList, totalChangedFiles)), budgets.primary.maxFiles, "…[file list truncated]"));
  ws.write("pr-body.txt", String(pr.body ?? ""));

  // #885: the corpus note that this PR edits its own (base-ref-resolved)
  // standards file — its changes appear only in the diff under review, never
  // as a live rewrite of the rules the review enforces.
  if (standards.resolved !== null) {
    standards.changedInPr = rawFilesList.some((raw) => {
      const filename = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).filename : undefined;
      return typeof filename === "string" && filename === standards.resolved;
    });
  }

  // Repository map (context.sh).
  if ((env.REPO_MAP_CONTEXT ?? "true").toLowerCase() === "true") {
    const bodyBudget = Number(env.REPO_MAP_MAX_BYTES || "12000") - trustFramingOverhead();
    if (bodyBudget >= 23) {
      try {
        const map = generateRepoMap(workspace);
        ws.write("repo-map.json", renderRepoMapJson(map));
        ws.write("repo-map.md", renderRepoMapMarkdown(map, bodyBudget));
      } catch (cause) {
        errorLog(`Repository map generation failed; continuing without repository map context: ${cause instanceof Error ? cause.message : String(cause)}`);
        ws.write("repo-map.json", "");
        ws.write("repo-map.md", "");
      }
    } else {
      log(`Skipping repository map: REPO_MAP_MAX_BYTES=${env.REPO_MAP_MAX_BYTES} cannot contain the trust framing plus the smallest safe body`);
      ws.write("repo-map.json", "");
      ws.write("repo-map.md", "");
    }
  } else {
    ws.write("repo-map.json", "");
    ws.write("repo-map.md", "");
  }

  // Related-code context (corpus.sh). Built before the requirement ledger:
  // its anchors and related context are the #796 obligation inputs. It
  // reads only the diff, the file list and the checkout.
  const relatedInputs = await buildRelatedCodeSection(ws, env, workspace);
  const obligationsOn = (env.HARNESS_OBLIGATIONS ?? "false").toLowerCase() === "true";
  const harnessObligations = relatedInputs === null || !obligationsOn ? [] : buildHarnessObligations(relatedInputs);

  // #875: bounded equivalent-implementation-path detection, from the same
  // anchors. Off by default; a lead-generation hint, not a ledger entry —
  // see the correctness specialist wiring below.
  buildEquivalentPathsSection(ws, env, workspace, relatedInputs === null ? null : relatedInputs.anchors);

  // PR-metadata-derived context (context.sh): linked issues + Linear, the
  // requirement ledger, review threads and human reviews. Built here and
  // again after the CI wait (#812), so edits made while CI runs are seen.
  const buildMetadataContext = async (prRecord: typeof pr, passCutoff: string | null): Promise<Awaited<ReturnType<typeof buildLinkedIssueContext>>> => {
    // Linked issues + Linear (context.sh).
    const linkedResult = await buildLinkedIssueContext({
      pr: prRecord,
      repo,
      adapter: {
        getIssue: (issueRepo: string, issueNumber: string): Promise<ReadResult<unknown>> => adapter.getIssue(issueRepo, issueNumber),
      },
      isForkPr: forkFlag,
      linear: {
        apiKey: env.LINEAR_API_KEY ?? "",
        prefixes: env.LINEAR_ISSUE_PREFIXES ?? "",
        timeoutSec: env.LINEAR_ISSUE_TIMEOUT_SEC ?? "20",
        enableForForks: env.LINEAR_ENABLE_FOR_FORKS ?? "false",
      },
    });
    for (const [name, data] of linkedResult.artifacts) ws.write(name, data);

    // Requirement ledger (context.sh): before the fragment gate that reads it.
    const ledger = extractRequirementLedger({
      prJson: prRecord,
      linkedIssuesMarkdown: ws.readText("linked-issues.md"),
      standardsText: standards.content === null ? null : Buffer.from(standards.content).toString("utf8"),
      standardsRef: standards.resolved === null ? null : standards.resolved.split("/").pop() ?? standards.resolved,
      harnessObligations,
    });
    const ledgerArtifact = ledgerToArtifact(ledger);
    const ledgerJson = Buffer.from(`${pyJsonDumps(ledgerArtifact)}\n`, "utf8");
    const ledgerMd = Buffer.from(renderRequirementLedgerMarkdown(ledgerArtifact), "utf8");
    const ledgerPresence = requirementLedgerPresence(ledgerMd, ledgerJson, budgets.primary.maxCorpus);
    for (const [name, data] of ledgerPresence.artifacts) ws.write(name, data);

    // Review threads + human reviews (context.sh).
    await buildReviewThreadsSection(ws, adapter, env, passCutoff);
    await buildHumanReviewsSection(ws, adapter, String(prRecord.headRefOid ?? ""), env);
    return linkedResult;
  };
  const linked = await buildMetadataContext(pr, supersededCutoff);

  // Manifest context (context.sh tail).
  const manifest = buildManifestContext(rawFilesList, workspace);
  for (const [name, data] of manifest.artifacts) ws.write(name, data);

  // ── Advisory phases (the #371 background forks, in-process) ──────────
  const extraction = extractEnrichmentArtifacts(env, ws, diffText, pr);
  const enrichmentPromise = renderLinkedSourcesPhase(env, ws, extraction, options.now).catch((cause: unknown) => {
    log(`WARNING: enrichment failed, producing empty linked-sources.md: ${cause instanceof Error ? cause.message : String(cause)}`);
    ws.write("linked-sources.md", "");
    return null;
  });
  const imageDigestPromise = runImageDigestPhase(ws, diffText, env).catch((cause: unknown) => {
    errorLog(`Image digest analysis failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    ws.write("image-digest-context.md", "Image digest provenance analysis failed for this run.\n");
    return null;
  });
  const evidencePromise = runEvidencePhase(ws, env, forkFlag, runDir, log).catch((cause: unknown) => {
    errorLog(`Evidence provider execution failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    ws.write("evidence-providers.md", "Evidence providers failed to run in this review.\n");
    ws.write("evidence-providers.json", '{"configured": false, "has_blocker": false, "providers": [], "error": "execution failed"}\n');
    return null;
  });

  // Repository impact/history scan (classification.sh) — needs the
  // version hints the extraction just wrote.
  const impact = await buildRepoImpactHistory({ pr, versionHintsTruncated: ws.read("version-hints.truncated.txt"), workspace });
  for (const [name, data] of impact.artifacts) ws.write(name, data);

  // ── Classification + routing (classification.sh) ─────────────────────
  const classification = classifyPr({
    prFiles: rawFilesList.map((raw) => canonicalChangedFile(raw)),
    diffText: ws.readText("pr.diff.truncated") ?? "",
    // #909: the deterministic image-digest kind must see every changed line;
    // `pr.diff.truncated` is the prioritized context diff and can omit
    // functional changes. `diffText` here is the complete fetched PR diff.
    fullDiffText: diffText,
    // The PR object's authoritative changed-file count; the image-digest rule
    // reconciles the (single-page) file list and diff against it.
    authoritativeChangedFiles: totalChangedFiles,
    // classifyPr sits behind the canonical LinkedIssue boundary
    // (src/context/types.ts): the linked-issue stage's raw collection —
    // GitHub refs with labels only when fetched, Linear records — is
    // normalized here, exactly like the classification fixture path.
    linkedIssues: normalizeLinkedIssues(linked.linkedIssues, repo),
    metadataStatus: safeJson(ws.read("linked-metadata-status.json")),
  });
  const classificationArtifact = classificationToArtifact(classification) as Record<string, unknown>;
  ws.write("classification.json", `${pythonJsonStringify(classificationArtifact)}\n`);
  log(`PR classification complete: ${String(classificationArtifact.pr_kind ?? "unknown")}`);
  // #871: substantialCodeChange isn't part of the persisted classification
  // artifact (see PRClassification's field doc); thread it to the
  // specialists gate through env instead, so role selection can force the
  // correctness lane for a substantial PR regardless of what pr_kind ended
  // up being.
  env.SUBSTANTIAL_CODE_CHANGE = classification.substantialCodeChange ? "true" : "false";

  const { route, reason } = resolveReviewRoute({ routingMode: env.REVIEW_ROUTING_MODE ?? "off" });
  env.REVIEW_ROUTE = route;
  env.ROUTE_REASON = reason;
  if (route === "primary") {
    Object.assign(env, { AI_BASE_URL: profiles.primary.baseUrl, AI_MODEL: profiles.primary.model, AI_API_FORMAT: profiles.primary.apiFormat, AI_API_KEY: profiles.primary.apiKey });
  }
  env.REVIEW_CONTEXT_PROFILE = "primary";
  log(`Review route: ${route} (${reason}) → ${env.AI_MODEL}`);

  promptState = applySystemPromptFragments(promptState, {
    ...(env.RELATED_CODE_CONTEXT !== undefined ? { relatedCodeContext: env.RELATED_CODE_CONTEXT } : {}),
    ...(env.PR_THREAD_CONTEXT !== undefined ? { prThreadContext: env.PR_THREAD_CONTEXT } : {}),
    ...(env.REVIEW_VERBOSITY !== undefined ? { reviewVerbosity: env.REVIEW_VERBOSITY } : {}),
  }, ws);
  env.SYSTEM_PROMPT = promptState.systemPrompt;

  // ── Corpus stage part 1 (corpus.sh): fork CI, harvest advisory ───────
  const scope = createCancellationScope();
  let ciFork: ForkedGate | null = null;
  if ((env.CI_STATUS_CHECK ?? "false").toLowerCase() === "true" && options.ciGate !== null) {
    const entry = options.ciGate ? "" : (options.ciGateEntry ?? runtimeBundleEntry(options.env));
    if (options.ciGate || entry !== null) {
      // The gate child is marked so it can never start a review (or another
      // gate) itself: the recursion stops at depth one.
      ciFork = await forkGate("ci", options.ciGate ?? ciGateBranch({ entry: entry ?? "" }), {
        // The gate writes its v2 step outputs (ci_status_final/skipped) to a
        // scratch file; the run republishes them under the contract names.
        ambientEnv: { ...options.env, [GATE_CHILD_ENV]: "1", GITHUB_OUTPUT: join(runDir, CI_GATE_OUTPUT_FILE) },
        scope,
      });
      log("CI status gating launched concurrently");
      env.CI_GATE_ACTIVE = "true";
    } else {
      log("CI status gating skipped: no runtime bundle entry to launch it from");
    }
  }

  await Promise.all([enrichmentPromise, imageDigestPromise, evidencePromise]);

  // PR-thread context (corpus.sh) — same pass cutoff as the review threads.
  await buildPrThreadSection(ws, adapter, env, supersededCutoff);
  // #812: the superseded-discussion rule, appended only now that the
  // discussion sections exist (the fragments phase runs before this stage).
  promptState = applySupersededDiscussionFragment(promptState, ws);
  env.SYSTEM_PROMPT = promptState.systemPrompt;

  // Corpus build #1 (initial review owns the primary artifact slot).
  // #965: the first pass is always the primary profile — the smart tier is
  // selected at escalation, not before the review runs.
  const profileKey: "primary" | "smart" = "primary";
  let corpusResult = assembleCorpus(ws, env, budgets, profileKey, "primary", generatedPaths, standards);
  ws.write("review-corpus.truncated.md", ws.read(corpusResult.outputName) ?? new Uint8Array(0));

  // ── Claim falsification pre-pass (#785), in flight with the other gates ──
  // Fail-soft: any failure leaves claim-falsification.md empty and the
  // review proceeds unchanged. Deterministic scan first; the bounded model
  // pass on the primary route always runs when configured and merges on top
  // of the scan's claims (#898).
  ws.write("claim-falsification.md", new Uint8Array(0));
  let claimsPromise: Promise<void> = Promise.resolve();
  if ((env.CLAIM_FALSIFICATION ?? "false").toLowerCase() === "true") {
    const rawTemp = (env.AI_TEMPERATURE ?? "").trim();
    const temperature = rawTemp === "" || Number.isNaN(Number(rawTemp)) ? null : Number(rawTemp);
    const claimsTimeoutSec = Math.min(
      Number(env.CLAIM_FALSIFICATION_TIMEOUT_SEC ?? "180") || 180,
      Number(env.AI_REQUEST_TIMEOUT_SEC ?? "180") || 180,
    );
    claimsPromise = runClaimFalsificationPass({
      title: String(pr.title ?? ""),
      body: String(pr.body ?? ""),
      files: safeJson(ws.read("pr-files.json")),
      diff: (ws.readText("pr.diff.truncated") ?? ws.readText("pr.diff") ?? ""),
      model:
        profiles.primary.baseUrl && profiles.primary.model
          ? {
              config: {
                apiFormat: profiles.primary.apiFormat,
                model: profiles.primary.model,
                baseUrl: profiles.primary.baseUrl,
                apiKey: profiles.primary.apiKey,
                maxTokens: Number(env.CLAIM_FALSIFICATION_MAX_TOKENS ?? "4096") || 4096,
                temperature,
                responseFormat: env.AI_RESPONSE_FORMAT ?? "off",
                tokensParam: env.AI_TOKENS_PARAM ?? "max_tokens",
                stream: (env.AI_STREAM ?? "true").toLowerCase() === "true",
                timeoutSec: claimsTimeoutSec,
                inputMaxBytes: Number(env.CLAIM_FALSIFICATION_INPUT_MAX_BYTES ?? "48000") || 48000,
              },
              requestFn: specialistRequestFn({
                baseUrl: profiles.primary.baseUrl,
                apiKey: profiles.primary.apiKey,
                anthropicVersion: env.ANTHROPIC_VERSION ?? "2023-06-01",
              }),
            }
          : undefined,
    })
      .then((result) => {
        const section =
          result.status === "ok"
            ? renderClaimsSection(result.artifact, Number(env.CLAIMS_SECTION_MAX_BYTES ?? "8000") || 8000)
            : "";
        const record = {
          status: result.status,
          error_kind: result.errorKind,
          error: result.error,
          method: result.artifact.method,
          claims: result.artifact.claims,
          truncated: result.artifact.truncated,
          errors: result.artifact.errors,
          section_bytes: Buffer.byteLength(section, "utf8"),
        };
        ws.write("claim-falsification.json", Buffer.from(`${pyJsonDumps(record)}\n`, "utf8"));
        ws.write("claim-falsification.md", Buffer.from(section, "utf8"));
      })
      .catch((cause: unknown) => {
        log(`WARNING: claim falsification pre-pass failed; continuing without claims: ${cause instanceof Error ? cause.message : String(cause)}`);
        ws.write("claim-falsification.md", new Uint8Array(0));
      });
  }

  // ── Gates: advisory specialists (in-process) + CI join (#634) ────────
  const deepMode = (env.DEEP_REVIEW ?? "false").toLowerCase();
  let specialistOutcome: GateOutcome = NO_GATE_OUTCOME("specialists");
  if (deepMode === "true" || deepMode === "auto") {
    env.DEEP_REVIEW_ACTIVE = "true";
    // The compact #632 pre-final specialist corpus is fixed from the
    // artifacts collected so far — never the final review corpus.
    const corpus = buildSpecialistCorpus(specialistWorkspace(ws, ciChecksBytes(env)));
    ws.write("specialist-corpus.md", corpus[0]);
    // #875: the equivalent-paths section is a correctness-only hint, kept
    // out of the shared specialist corpus above and passed as its own file
    // so the gate can inject it into just the correctness role's input.
    const equivalentPathsMd = ws.readText("equivalent-paths.truncated.md") ?? "";
    const equivalentPathsArgv: string[] = [];
    if (equivalentPathsMd.trim() !== "") {
      ws.write("specialist-equivalent-paths.md", equivalentPathsMd);
      equivalentPathsArgv.push("--equivalent-paths", "specialist-equivalent-paths.md");
    }
    const specialistFork = await forkGate("specialists", {
      file: "",
      envAllowlist: [],
      workload: async () => runSpecialistsGate({
        env,
        // The gate's artifacts (role files, specialists.json/.md) must land
        // in the run dir this workspace reads, not GITHUB_WORKSPACE.
        argv: ["--corpus", "specialist-corpus.md", "--workspace-root", runDir, ...equivalentPathsArgv],
        cwd: runDir,
        stdout: (line) => log(line),
        stderr: (line) => errorLog(line),
        ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      }),
    }, { scope });
    specialistOutcome = await specialistFork.join();
  }
  await claimsPromise;
  if (ciFork !== null) {
    const outcome = await ciFork.join();
    env.CI_GATE_ACTIVE = outcome.ran ? "true" : "false";
    if (!outcome.ok) log("CI status gating exited non-zero; continuing (CI evidence is advisory)");
    persistOutputs(context.outputFilePath, ciGateOutputs(join(runDir, CI_GATE_OUTPUT_FILE)));
  }

  // #812: the PR body, linked issues and thread context are re-read after
  // the CI wait, so edits made while CI ran (push first, then update the
  // body/issue) reach the model with no extra review. Only when the head is
  // unchanged: a moved head supersedes this review anyway.
  if (env.CI_GATE_ACTIVE === "true") {
    const refreshed = await adapter.getPr().catch(() => null);
    const next = refreshed === null || refreshed === undefined ? null : projectPr(refreshed, prNumber);
    if (next !== null && String(next.headRefOid ?? "") === String(pr.headRefOid ?? "")) {
      log("Refreshing PR metadata context after the CI wait");
      // A fresh atomic snapshot for the rebuilt pass: its body is presented
      // and its `editedAt` is the only cutoff this pass labels with. A
      // failed snapshot read keeps the REST-refreshed body and no cutoff.
      bodyRevision = await authoritativeBodyRevision(adapter);
      if (bodyRevision !== null) next.body = bodyRevision.body;
      supersededCutoff = bodyRevision === null ? null : bodyRevision.editedAt;
      Object.assign(pr, next);
      ws.write("pr-object.json", pyJsonDumps(refreshed));
      ws.write("pr.json", pyJsonDumps(pr));
      ws.write("pr-body.txt", String(pr.body ?? ""));
      await buildMetadataContext(pr, supersededCutoff);
      await buildPrThreadSection(ws, adapter, env, supersededCutoff);
      // #812 review: discussion can appear while CI runs. The fragment is
      // idempotent; without this reapplication the rebuilt corpus could
      // carry discussion the system prompt has no superseded-discussion
      // rule for.
      promptState = applySupersededDiscussionFragment(promptState, ws);
      env.SYSTEM_PROMPT = promptState.systemPrompt;
    }
  }

  // Rebuild the corpus with both branches resolved (finalized CI evidence
  // + any rendered specialist leads + refreshed PR metadata).
  if (env.CI_GATE_ACTIVE === "true" || ws.isNonEmpty("specialists.md") || ws.isNonEmpty("claim-falsification.md")) {
    log("review gates resolved: rebuilding corpus with finalized CI evidence and specialist leads");
    corpusResult = assembleCorpus(ws, env, budgets, profileKey, "primary", generatedPaths, standards);
    ws.write("review-corpus.truncated.md", ws.read(corpusResult.outputName) ?? new Uint8Array(0));
  }

  promptState = applySpecialistLeadsFragment(promptState, ws);
  // #935: scope the trace from the FINAL ledger (the #812 same-head refresh
  // above can rebuild it), so the tool loop, the verdict turn and the
  // validator below all see the same in-scope requirement ids.
  const traceChanged = traceChangedText(ws);
  const requirementTraceEnabled = (env.REQUIREMENT_TRACE ?? "false").toLowerCase() === "true";
  const traceOwnership = !requirementTraceEnabled || baseRef === "" ? { rules: [], warnings: [] } : resolveRequirementOwners({ baseRef, workspace });
  for (const warning of traceOwnership.warnings) errorLog(`requirement owners: ${warning}`);
  const tracePaths = requirementTraceEnabled ? traceChangedFilePaths(ws) : undefined;
  const ledgerValue = safeJson(ws.read("requirement-ledger.json"));
  // #959: the in-scope ids are computed once here and reused by the repair
  // pass below, so the prompt, the repair and the validator all see the same
  // scope.
  const traceScopeIds = requirementTraceEnabled
    ? requirementTraceScope(ledgerValue, traceChanged, { ownership: traceOwnership.rules, paths: tracePaths }).inScope.map((entry) => entry.id)
    : [];
  const distributedHints = distributedRequirementHints(ledgerValue, traceOwnership.rules, traceScopeIds);
  for (const warning of distributedRequirementWarnings(ledgerValue, traceOwnership.rules, traceScopeIds)) {
    errorLog(`requirement owners: ${warning}`);
  }
  promptState = applyRequirementTraceFragment(promptState, ws, requirementTraceEnabled, undefined, traceScopeIds, distributedHints);
  env.SYSTEM_PROMPT = promptState.systemPrompt;

  // ── Native tool harness (corpus.sh tail) ─────────────────────────────
  const toolMode = (env.TOOL_MODE ?? "off").toLowerCase();
  if (toolMode === "native_loop") {
    const toolGate = gateForkForForks(env, forkFlag);
    if (toolGate !== null) {
      ws.write("tool-harness.md", toolGate.md);
      ws.write("tool-harness.json", toolGate.json);
    } else {
      log(`Running tool harness in mode: ${toolMode}`);
      // The tier names the first-pass artifact slot; the loop limits follow
      // the tier (loopLimitsProfile).
      env.TOOL_HARNESS_TIER = "primary";
      await runToolHarnessPhase(ws, env, workspace, log);
    }
    corpusResult = assembleCorpus(ws, env, budgets, profileKey, "primary", generatedPaths, standards);
    if (corpusResult.overBudget) errorLog(`ERROR: assembled corpus exceeds its context budget`);
    ws.write("review-corpus.truncated.md", ws.read(corpusResult.outputName) ?? new Uint8Array(0));
  }

  // ── Review stage (review.sh) ─────────────────────────────────────────
  const userMessage = buildUserMessage(ws, "classification.json");
  const primary = await producePrimaryReview({
    env, ws, profiles, streamBool, userMessage, log, errorLog, clock, sleep: options.sleep, budgets,
  });
  let analysisEngine = primary.analysisEngine;
  let primaryProduced = primary.fromPrimary;
  let artifact = primary.artifact;

  // ── Escalation (#721: reviewer-requested only) ───────────────────────
  let escalationReasons = "";
  let enforcementHarness = "tool-harness.json";
  if (
    (env.REVIEW_ROUTING_MODE ?? "off").toLowerCase() === "auto"
    && (env.REVIEW_ROUTE ?? "legacy") === "primary"
    && primaryProduced
    && profiles.smart.resolved
    && !(profiles.smart.baseUrl === profiles.primary.baseUrl && profiles.smart.model === profiles.primary.model)
    && reviewerRequestedEscalation(safeJson(ws.read("ai-output.json")) ?? {}).requested
  ) {
    escalationReasons = "primary_requested";
    log(`Escalating to smart model ${profiles.smart.model} (primary_requested)`);
    ws.write("ai-output.primary.json", ws.read("ai-output.json") ?? new Uint8Array(0));
    env.TOOL_ESCALATION = "true";
    const smart = await runSmartReview({
      env, ws, profiles, streamBool, userMessage, log, errorLog, clock, sleep: options.sleep,
      budgets, generatedPaths, standards, runDir, workspace,
    });
    delete env.TOOL_ESCALATION;
    if (smart.ok) {
      // No-recursion invariant: the smart review cannot request another.
      const smartArtifact = safeJson(ws.read("ai-output.json"));
      if (smartArtifact !== null) {
        smartArtifact.smart_review_requested = false;
        smartArtifact.smart_review_reason = null;
        ws.write("ai-output.json", Buffer.from(`${pyJsonDumps(smartArtifact)}\n`, "utf8"));
      }
      enforcementHarness = "tool-harness.smart.json";
      env.REVIEW_ROUTE = "escalated";
      env.ROUTE_REASON = `escalated: ${escalationReasons}`;
      analysisEngine = annotateAnalysisEngine(analysisEngineBase(profiles.smart.model, profiles.smart.baseUrl, profiles.smart.apiFormat), "escalated", { escalationReasons });
      log("Smart model succeeded; publishing the escalated review");
    } else {
      ws.write("ai-output.json", ws.read("ai-output.primary.json") ?? new Uint8Array(0));
      escalationReasons = "";
      log("Smart model failed after escalation; publishing the primary review");
    }
    artifact = safeJson(ws.read("ai-output.json")) ?? (artifact as Record<string, unknown>);
  }

  // ── #959: one bounded trace-repair pass ──────────────────────────────
  // A verdict can carry no trace claim at all for an in-scope requirement
  // (the #947 shape: `requirement_coverage: null` even though the prose
  // review cites real locations). Before publishing, re-ask ONCE, for exactly
  // the missing ids, on the same route as the primary review — mirroring the
  // claim-falsification pre-pass. Gated on the default prompt (`isDefault`):
  // the repair IS the trace fragment's retry, so with an operator replace-mode
  // prompt there is no fragment to retry and the documented fail-closed
  // behavior stands. Fail-soft: any failure leaves the artifact unchanged, and
  // the missing rows then render as "the reviewer reported no trace" rather
  // than implying enforcement does not exist. A claim that IS present with
  // unusable locations is never repaired, so this cannot become a way to pass
  // an untraceable change.
  if (requirementTraceEnabled && promptState.isDefault && analysisEngine !== MODEL_UNAVAILABLE_ENGINE && artifact !== null) {
    const repairTarget = (artifact ?? {}) as Record<string, unknown>;
    const missingTraceIds = missingTraceRequirementIds(repairTarget.requirement_coverage, traceScopeIds);
    const repairRequirements = missingTraceIds.length > 0 ? ledgerRequirementsById(ledgerValue, missingTraceIds) : [];
    if (repairRequirements.length > 0 && profiles.primary.baseUrl && profiles.primary.model) {
      const rawTemp = (env.AI_TEMPERATURE ?? "").trim();
      const temperature = rawTemp === "" || Number.isNaN(Number(rawTemp)) ? null : Number(rawTemp);
      const repairTimeoutSec = Math.min(
        Number(env.REQUIREMENT_TRACE_REPAIR_TIMEOUT_SEC ?? "180") || 180,
        Number(env.AI_REQUEST_TIMEOUT_SEC ?? "180") || 180,
      );
      log(`requirement trace: ${repairRequirements.length} in-scope requirement(s) carried no claim; attempting one bounded repair pass`);
      // Fail-soft at the boundary too, mirroring the claim-falsification
      // pre-pass: a throw here must never abort the review.
      let repaired: Awaited<ReturnType<typeof runRequirementTraceRepairPass>> | null = null;
      try {
        repaired = await runRequirementTraceRepairPass({
          requirements: repairRequirements.map((entry) => {
            const groups = distributedHints.find((hint) => hint.requirementId === entry.id)?.groups;
            return { id: entry.id, text: entry.text, ...(groups ? { groups } : {}) };
          }),
          title: String(pr.title ?? ""),
          files: safeJson(ws.read("pr-files.json")),
          diff: ws.readText("pr.diff.truncated") ?? ws.readText("pr.diff") ?? "",
          config: {
            apiFormat: profiles.primary.apiFormat,
            model: profiles.primary.model,
            baseUrl: profiles.primary.baseUrl,
            apiKey: profiles.primary.apiKey,
            maxTokens: Number(env.REQUIREMENT_TRACE_REPAIR_MAX_TOKENS ?? "4096") || 4096,
            temperature,
            responseFormat: env.AI_RESPONSE_FORMAT ?? "off",
            tokensParam: env.AI_TOKENS_PARAM ?? "max_tokens",
            stream: (env.AI_STREAM ?? "true").toLowerCase() === "true",
            timeoutSec: repairTimeoutSec,
            inputMaxBytes: Number(env.REQUIREMENT_TRACE_REPAIR_INPUT_MAX_BYTES ?? "48000") || 48000,
          },
          requestFn: specialistRequestFn({
            baseUrl: profiles.primary.baseUrl,
            apiKey: profiles.primary.apiKey,
            anthropicVersion: env.ANTHROPIC_VERSION ?? "2023-06-01",
          }),
        });
      } catch (cause) {
        log(`WARNING: requirement trace repair pass failed; continuing without repair: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      if (repaired !== null) {
        // Per-run record, mirroring claim-falsification.json: the merged
        // claims land in ai-output.json, but the pass's status is otherwise
        // unobservable.
        ws.write("requirement-trace-repair.json", Buffer.from(`${pyJsonDumps({
          status: repaired.status,
          error_kind: repaired.errorKind,
          error: repaired.error,
          missing_ids: missingTraceIds,
          claims: repaired.claims.length,
          diff_clipped: repaired.diffClipped,
        })}\n`, "utf8"));
        if (repaired.claims.length > 0) {
          repairTarget.requirement_coverage = mergeTraceClaims(repairTarget.requirement_coverage, repaired.claims);
          log(`requirement trace: repair pass returned ${repaired.claims.length} claim(s)`);
        } else {
          log(`requirement trace: repair pass returned no claims (${repaired.status}${repaired.error ? `: ${repaired.error}` : ""})`);
        }
      }
    }
  }

  // ── Enforcement (review.sh) + requirement coverage ───────────────────
  const reviewRecord = (artifact ?? {}) as Record<string, unknown>;
  const verdictPolicy = env.VERDICT_POLICY ?? "strict";
  // Captured before any layer mutates it: the strict mapping (#811) takes the
  // model verdict as an input, not as the final answer.
  const modelVerdict = String(reviewRecord.verdict ?? "");
  const completenessOptions = {
    enabled: env.VALIDATE_REQUIRED_CHECKS ?? "auto",
    mode: env.REQUIRED_CHECK_VALIDATION_MODE ?? "warn",
    mustCheck: stringList(classificationArtifact.must_check),
  };
  const enforcementInputs: EnforcementInputs = {
    evidenceBlockerEnabled: (env.EVIDENCE_BLOCKER_ENFORCEMENT ?? "false").toLowerCase() === "true",
    toolFailureEnabled: toolMode !== "off" && (env.TOOL_FAILURE_ENFORCEMENT ?? "false").toLowerCase() === "true",
    toolMinSuccessful: Number(env.TOOL_MIN_SUCCESSFUL_REQUESTS ?? "0") || 0,
    evidence: safeJson(ws.read("evidence-providers.json")) as never,
    toolHarness: safeJson(ws.read(enforcementHarness)) as never,
    // #812: the settlement views are JSON arrays — the object-only safeJson
    // nulled them, so review-thread and human-review settlement never ran.
    threads: safeJsonArray(ws.read("review-threads.json")) as never,
    humanReviews: safeJsonArray(ws.read("human-reviews.json")) as never,
    verdictPolicy,
  };
  // #874: the ledger (read above for the #959 trace scope) feeds the trace
  // escalation, which must be visible to the verdict mapping, not just
  // recorded afterward.
  let requirementTraceResult: ReturnType<typeof applyRequirementTraceEnforcement> | null = null;
  let completenessStatus = "none";
  if (analysisEngine === MODEL_UNAVAILABLE_ENGINE) {
    // on-model-failure=notice (#863): no model reviewed this PR, so the
    // notice's request_changes is final; no verdict policy may relax it.
  } else if (verdictPolicy === "strict") {
    // #811 composition (same order as the enforcement-pipeline fixture):
    // coverage, then the enforcement overlays, then the strict mapping over
    // the final still-open findings set. #874's requirement-trace pass runs
    // between completeness and the overlays: it needs completeness's
    // `required_checks` write to have already happened (its own escalation
    // must not be clobbered by it), and its synthesized findings must be in
    // place before the strict mapping counts open findings.
    const completeness = applyRequiredCheckValidation(reviewRecord as never, completenessOptions);
    completenessStatus = completeness.status;
    requirementTraceResult = applyRequirementTraceEnforcement(reviewRecord as never, { enabled: requirementTraceEnabled, ledger: ledgerValue, workspace, changed: traceChanged, ownership: traceOwnership.rules, paths: tracePaths });
    applyAllEnforcement(reviewRecord as never, enforcementInputs);
    const forced = failClosedEnforcementFired(enforcementInputs)
      || (completeness.status === "incomplete" && completeness.mode === "fail");
    applyStrictVerdictPolicy(reviewRecord as never, { modelVerdict, forced });
  } else {
    applyVerdictPolicy(reviewRecord as never, verdictPolicy, {
      nonBlockingCategories: new Set(splitCsv(env.NON_BLOCKING_FINDING_CATEGORIES ?? "")),
      securityFlagged: isSecurityFlagged(classificationArtifact),
    });
    completenessStatus = applyRequiredCheckValidation(reviewRecord as never, completenessOptions).status;
    requirementTraceResult = applyRequirementTraceEnforcement(reviewRecord as never, { enabled: requirementTraceEnabled, ledger: ledgerValue, workspace, changed: traceChanged, ownership: traceOwnership.rules, paths: tracePaths });
    applyAllEnforcement(reviewRecord as never, enforcementInputs);
    // #977: the model's own request_changes is relaxed only when every
    // still-open finding is a verification ask and no independent
    // deterministic gate fired. The overlays above have already run, so
    // their blocks are visible here.
    relaxVerificationOnlyVerdict(reviewRecord as never, {
      forced: failClosedEnforcementFired(enforcementInputs),
    });
  }
  ws.write("ai-output.json", Buffer.from(`${pyJsonDumps(reviewRecord)}\n`, "utf8"));

  // Requirement coverage fold (#624) — advisory, never alters a verdict.
  ws.write("requirement-coverage.json", new Uint8Array(0));
  const ledgerRequirements = (ledgerValue as { requirements?: unknown } | null)?.requirements;
  if (Array.isArray(ledgerRequirements) && ledgerRequirements.length > 0) {
    const coverage = normalizeRequirementCoverage(reviewRecord.requirement_coverage as never, ledgerValue);
    ws.write("requirement-coverage.json", Buffer.from(`${pyJsonDumps(coverage)}\n`, "utf8"));
  }

  // #874: the requirement-trace artifact (already applied above, before the
  // verdict was decided) — persisted here purely for the published render
  // and the step summary; its escalation already happened.
  ws.write("requirement-trace.json", new Uint8Array(0));
  if (requirementTraceResult !== null && requirementTraceResult.applied) {
    ws.write("requirement-trace.json", Buffer.from(`${pyJsonDumps(requirementTraceResult.trace as never)}\n`, "utf8"));
  }

  // ── Outputs + step summary (review.sh tail) ──────────────────────────
  const harnessForMarker = safeJson(ws.read(enforcementHarness));
  const cacheHitRatio = buildCacheHitRatioOutput(harnessForMarker);
  const toolCalls = buildToolCallsOutput(
    safeJson(ws.read("tool-harness.json")),
    enforcementHarness === "tool-harness.smart.json" ? safeJson(ws.read("tool-harness.smart.json")) : null,
  );
  // #810: the harness's own deterministic coverage record for the published
  // route (smart when escalated), never the model's claim. Computed here
  // (rather than only below, alongside the marker) so the #873 review-result
  // output — persisted immediately below — already reflects a tool-loop
  // coverage gap, not only a completed run's required-check status.
  const partialCoverage = resolvePartialCoverage(harnessForMarker, toolMode === "native_loop", ws.isNonEmpty(enforcementHarness));
  const executionIncomplete = partialCoverage !== undefined || completenessStatus === "incomplete";
  const traceIncomplete = reviewRecord.requirement_trace_incomplete === true;
  const incompleteReason: IncompleteReason = executionIncomplete && traceIncomplete ? "both"
    : executionIncomplete ? "execution"
    : traceIncomplete ? "requirement_trace"
    : "none";
  const outputVerdict = String(reviewRecord.verdict ?? "");
  const outputRequiredChecks = String(reviewRecord.required_checks ?? "none");
  // #873 maintainer follow-up: the standalone `publish` CLI is a separate
  // process that cannot see `toolMode`/`enforcementHarness` — trusting the
  // ambient TOOL_MODE/REVIEW_ROUTE stage env it re-derives them from is
  // spoofable/stale (a caller that omits or forges either one can make a
  // partial run read as clean, or a clean run's harness never get read at
  // all). This run writes its OWN authoritative record of what actually
  // happened — never derived from anything `publish` could independently
  // guess — so `publish` only ever needs to read one file, never reason
  // about tool-mode or route itself. Written for every run, including
  // tools-off (tool_loop_ran: false, enforcement_harness: null).
  const reviewCoverage = {
    version: 1,
    tool_loop_ran: toolMode === "native_loop",
    enforcement_harness: toolMode === "native_loop" ? enforcementHarness : null,
    route: env.REVIEW_ROUTE ?? "legacy",
    partial_coverage: partialCoverage ?? null,
    required_checks: outputRequiredChecks,
    ...(incompleteReason !== "none" ? { incomplete_reason: incompleteReason } : {}),
  };
  ws.write("review-coverage.json", Buffer.from(`${pyJsonDumps(reviewCoverage)}\n`, "utf8"));
  const outputs: ReviewStepOutputs = {
    verdict: outputVerdict,
    verdictSource: String(reviewRecord.verdict_source ?? "model"),
    requiredChecks: outputRequiredChecks,
    // #873: additive alongside verdict — a partial review's verdict can
    // still read "approve" (the strict mapping's own contract), so this is
    // the one output that surfaces the coverage gap on its own.
    incompleteReason,
    reviewResult: markerReviewResult({
      verdictPolicy,
      verdict: outputVerdict,
      findings: reviewRecord.findings,
      requiredChecks: outputRequiredChecks,
      partialCoverage,
    }),
    reviewRoute: env.REVIEW_ROUTE ?? "legacy",
    escalationReason: escalationReasons,
    reviewMarkdown: String(reviewRecord.review_markdown ?? ""),
    findings: pyJsonDumps(Array.isArray(reviewRecord.findings) ? reviewRecord.findings : []),
    toolCalls,
    cacheHitRatio,
    analysisEngine,
  };
  ws.write("review-body.md", outputs.reviewMarkdown);
  ws.write("verdict.txt", `${outputs.verdict}\n`);
  ws.write("analysis_engine.txt", `${analysisEngine}\n`);
  persistOutputs(context.outputFilePath, formatReviewStepOutputs(outputs));
  writeStepSummary(context.stepSummaryPath, {
    outputs,
    env,
    ws,
    reviewRecord,
    primaryHarness: safeJson(ws.read("tool-harness.json")),
    smartHarness: safeJson(ws.read("tool-harness.smart.json")),
    specialistOutcome,
    deepMode,
    coverage: safeJson(ws.read("requirement-coverage.json")),
    budgets,
    profiles,
    route: outputs.reviewRoute,
    routeReason: env.ROUTE_REASON ?? "",
    analysisEngine,
    escalationReasons,
    fallbackUsed: primary.fromFallback,
  });

  const finished = clock();
  // #847: the #810/#702 tool-budget provenance for the same route, recorded
  // on every review (not only partial-coverage ones) so #810's size-scaled
  // default can be measured from published reviews without needing the
  // harness artifact.
  const toolBudgetTelemetry = toolBudgetTelemetryOf(harnessForMarker);
  // #812: the external-CI conclusion this verdict was reached against, folded
  // exactly as the precheck re-check folds it. Only a carried
  // request_changes is re-checked, so only it pays the read; a failed read
  // omits the field and the precheck fails closed.
  let ciState: string | undefined;
  const reviewedHead = context.headSha || String(pr.headRefOid ?? "");
  if (outputs.verdict === "request_changes" && reviewedHead !== "") {
    const checks = await adapter.externalChecks(reviewedHead).catch(() => null);
    if (checks !== null) ciState = externalChecksConclusion(checks);
  }
  const marker = buildRunMetadataMarker({
    // The composite passes PR_HEAD_SHA; fall back to the fetched PR object's
    // head so the marker never claims a wrong binding.
    headSha: context.headSha || String(pr.headRefOid ?? ""),
    baseSha: identity.baseSha ?? "",
    // Same value the #873 review-result output above already carries.
    reviewResult: outputs.reviewResult,
    requiredChecks: outputs.requiredChecks,
    ...(incompleteReason !== "none" ? { incompleteReason } : {}),
    reviewRoute: outputs.reviewRoute,
    escalationReason: outputs.escalationReason,
    cacheHitRatio: outputs.cacheHitRatio,
    ...(partialCoverage ? { coverage: "partial", coverageStopReason: partialCoverage.stop_reason } : {}),
    ...(ciState !== undefined ? { ciState } : {}),
    ...(toolBudgetTelemetry.budget !== undefined ? { toolBudget: toolBudgetTelemetry.budget } : {}),
    ...(toolBudgetTelemetry.source !== undefined ? { toolBudgetSource: toolBudgetTelemetry.source } : {}),
    ...(toolBudgetTelemetry.calls !== undefined ? { toolCalls: toolBudgetTelemetry.calls } : {}),
    ...(toolBudgetTelemetry.rounds !== undefined ? { toolRounds: toolBudgetTelemetry.rounds } : {}),
    ...(toolBudgetTelemetry.maxRounds !== undefined ? { maxRounds: toolBudgetTelemetry.maxRounds } : {}),
    ...(toolBudgetTelemetry.contextBudget !== undefined ? { contextBudget: toolBudgetTelemetry.contextBudget } : {}),
    ...(toolBudgetTelemetry.contextPeak !== undefined ? { contextPeak: toolBudgetTelemetry.contextPeak } : {}),
    actionVersion: ACTION_VERSION,
  });
  return {
    outputs,
    runDir,
    marker,
    artifacts: ws.snapshot(),
    reviewArtifact: reviewRecord,
    route: outputs.reviewRoute,
    routeReason: env.ROUTE_REASON ?? "",
    analysisEngine,
    classification: classificationArtifact,
    ciGate: ciFork === null ? NO_GATE_OUTCOME("ci") : await ciFork.join(),
    specialistGate: specialistOutcome,
    durationSec: Math.max(0, finished - started),
    verdictPolicy,
    ...(partialCoverage ? { partialCoverage } : {}),
    ...(ciState !== undefined ? { ciState } : {}),
    ...(toolBudgetTelemetry.budget !== undefined ? { toolBudget: toolBudgetTelemetry.budget } : {}),
    ...(toolBudgetTelemetry.source !== undefined ? { toolBudgetSource: toolBudgetTelemetry.source } : {}),
    ...(toolBudgetTelemetry.calls !== undefined ? { toolCallsUsed: toolBudgetTelemetry.calls } : {}),
    ...(toolBudgetTelemetry.rounds !== undefined ? { toolRoundsUsed: toolBudgetTelemetry.rounds } : {}),
    ...(toolBudgetTelemetry.maxRounds !== undefined ? { toolMaxRounds: toolBudgetTelemetry.maxRounds } : {}),
    ...(toolBudgetTelemetry.contextBudget !== undefined ? { contextBudget: toolBudgetTelemetry.contextBudget } : {}),
    ...(toolBudgetTelemetry.contextPeak !== undefined ? { contextPeak: toolBudgetTelemetry.contextPeak } : {}),
  };
}

// ---------------------------------------------------------------------------
// Stage helpers bound to the pipeline
// ---------------------------------------------------------------------------

function cachedProjectNumber(bytes: Uint8Array): number | null {
  const value = safeJson(bytes);
  const number = value?.number;
  return typeof number === "number" ? number : null;
}

/** #873: exported so the standalone `publish` CLI entrypoint (a separate
 * process from `run`, reading the run's persisted artifacts rather than
 * holding the harness in memory) can derive the same coverage-gap record
 * from the tool-harness artifact on disk. */
/** #899: a loop that ran but left an unreadable harness artifact has unknown
 * coverage, which must never publish as complete. */
export function resolvePartialCoverage(
  harness: Record<string, unknown> | null,
  loopRan: boolean,
  harnessWritten: boolean,
): PartialCoverage | undefined {
  const recorded = partialCoverageOf(harness);
  if (recorded !== undefined || !loopRan || harness !== null || !harnessWritten) return recorded;
  return { stop_reason: "harness-unreadable", changed_files_total: 0, unread_files: [], leads_total: 0, unresolved_leads: [] };
}

export function partialCoverageOf(harness: Record<string, unknown> | null): PartialCoverage | undefined {
  const value = harness?.partial_coverage;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { stop_reason?: unknown }).stop_reason === "string"
    ? value as PartialCoverage
    : undefined;
}

/**
 * #847: the harness's own #810/#702 budget-resolution telemetry
 * (`tool_request_budget` / `tool_budget_source` / `executed_request_count`,
 * written by `runToolHarness` — src/tools/harness.ts), lifted for the run
 * marker. Every field is independently optional: a harness that aborted
 * before the budget was resolved (or never ran) contributes nothing, and
 * the marker then omits `tool_budget`/`tool_budget_source`/`tool_calls`
 * exactly as it did before #847.
 */
function toolBudgetTelemetryOf(harness: Record<string, unknown> | null): {
  budget?: number;
  source?: string;
  calls?: number;
  rounds?: number;
  maxRounds?: number;
  contextBudget?: number;
  contextPeak?: number;
} {
  if (harness === null) return {};
  const out: { budget?: number; source?: string; calls?: number; rounds?: number; maxRounds?: number; contextBudget?: number; contextPeak?: number } = {};
  if (typeof harness.tool_request_budget === "number") out.budget = harness.tool_request_budget;
  if (typeof harness.tool_budget_source === "string" && harness.tool_budget_source !== "") {
    out.source = harness.tool_budget_source;
  }
  if (typeof harness.executed_request_count === "number") out.calls = harness.executed_request_count;
  // #895: the rounds actually used and the resolved round cap the loop ran
  // against, lifted from the #702 telemetry object (`usage.rounds_used` /
  // `budget.max_rounds`) so the marker can show whether the round cap (not
  // just the call budget) is what stopped the loop.
  const telemetry = harness.tool_loop_telemetry;
  if (telemetry !== null && typeof telemetry === "object") {
    const usage = (telemetry as Record<string, unknown>).usage;
    if (usage !== null && typeof usage === "object" && typeof (usage as Record<string, unknown>).rounds_used === "number") {
      out.rounds = (usage as Record<string, unknown>).rounds_used as number;
    }
    const budget = (telemetry as Record<string, unknown>).budget;
    if (budget !== null && typeof budget === "object" && typeof (budget as Record<string, unknown>).max_rounds === "number") {
      out.maxRounds = (budget as Record<string, unknown>).max_rounds as number;
    }
    // #922: the conversation budget the loop compacted against and its peak.
    if (budget !== null && typeof budget === "object" && typeof (budget as Record<string, unknown>).max_conversation_tokens === "number") {
      out.contextBudget = (budget as Record<string, unknown>).max_conversation_tokens as number;
    }
    if (usage !== null && typeof usage === "object" && typeof (usage as Record<string, unknown>).peak_conversation_tokens === "number") {
      out.contextPeak = (usage as Record<string, unknown>).peak_conversation_tokens as number;
    }
  }
  return out;
}

/** #935: what the change touches, from the FULL raw diff (the budgeted
 * `pr.diff.truncated` may drop the very hunk that touches a requirement's
 * subject). Undefined when the raw diff is unavailable, so the trace keeps
 * every requirement in scope instead of treating missing evidence as an
 * empty change. */
export function traceChangedText(ws: Pick<RunWorkspace, "readText" | "read">): string | undefined {
  const diff = ws.readText("pr.diff");
  if (diff === null || diff === undefined || diff === "") return undefined;
  return changedSubjectText(diff, changedFilePaths(safeJsonArray(ws.read("pr-files.json"))));
}

/** #958: the changed file paths (current and previous names), lowercased, for
 * owner-glob matching. Undefined when the raw diff is unavailable, mirroring
 * `traceChangedText`'s fail-closed rule (missing evidence keeps every
 * requirement in scope rather than treating it as an empty change). */
export function traceChangedFilePaths(ws: Pick<RunWorkspace, "readText" | "read">): string[] | undefined {
  const diff = ws.readText("pr.diff");
  if (diff === null || diff === undefined || diff === "") return undefined;
  return changedFilePaths(safeJsonArray(ws.read("pr-files.json"))).map((path) => path.toLowerCase());
}

/** Changed file paths (current and previous names) from `pr-files.json`. */
function changedFilePaths(files: unknown[] | null): string[] {
  const out: string[] = [];
  for (const file of files ?? []) {
    if (!file || typeof file !== "object") continue;
    for (const key of ["filename", "previous_filename"]) {
      const value = (file as Record<string, unknown>)[key];
      if (typeof value === "string" && value !== "") out.push(value);
    }
  }
  return out;
}

function splitCsv(raw: string): string[] {
  return raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isSecurityFlagged(classification: Record<string, unknown>): boolean {
  const flags = stringList(classification.risk_flags);
  return flags.some((flag) => flag.includes("security") || flag.includes("secret"));
}

/** corpus.sh's gate_feature_for_forks for the tool harness. Null = run. */
function gateForkForForks(env: StageEnv, forkFlag: string): { md: string; json: string } | null {
  if (forkFlag === "true" && (env.TOOL_ENABLE_FOR_FORKS ?? "false").toLowerCase() !== "true") {
    return {
      md: "Tool harness was skipped for a cross-repository pull request. Set tool_enable_for_forks=true to override.\n",
      json: '{"mode":"native_loop","planned_request_count":0,"executed_request_count":0,"tool_results":[],"skipped":true,"skip_reason":"fork-pr"}\n',
    };
  }
  return null;
}

/** #885: standards must be read from the trusted base ref, never the PR
 * head — a PR must not be able to rewrite the rules its own review enforces
 * by editing AGENTS.md (or adding a higher-priority candidate) on its own
 * branch. Mirrors `resolveRepositoryConfig`'s degrade path exactly: with no
 * base ref, or when the base-ref read fails for an infrastructure reason
 * (git missing, timeout), the result is no standards plus a warning — never
 * a fallback to the checked-out working tree. */
/** #904: `SYSTEM_PROMPT_FILE` is a repository path, read from the trusted base
 * ref like the standards file (#885) so a PR can't rewrite the prompt that
 * reviews it. An absolute operator path is read from disk; with no base ref
 * the checkout is used. Never the run's artifact directory. */
function promptFileWorkspace(workspace: string, baseRef: string): PromptWorkspace {
  const checkout = workspaceAt(workspace);
  if (baseRef === "") return checkout;
  const cache = new Map<string, Buffer | null>();
  const read = (path: string): Buffer | null => {
    if (!cache.has(path)) {
      let content: Buffer | null = null;
      try {
        const bytes = readStandardsFileAtRef({ standardsFile: path, candidates: "", ref: baseRef, workspace }).content;
        content = bytes === null ? null : Buffer.from(bytes);
      } catch {
        content = null;
      }
      cache.set(path, content);
    }
    return cache.get(path) ?? null;
  };
  return {
    isFile: (path) => (isAbsolute(path) ? checkout.isFile(path) : read(path) !== null),
    isNonEmpty: (path) => (isAbsolute(path) ? checkout.isNonEmpty(path) : (read(path)?.length ?? 0) > 0),
    readBytes: (path) => (isAbsolute(path) ? checkout.readBytes(path) : read(path)),
  };
}

function resolveStandards(
  env: StageEnv,
  workspace: string,
  baseRef: string,
  errorLog: (line: string) => void,
): { resolved: string | null; content: Uint8Array | null; changedInPr: boolean } {
  try {
    const { resolved, content } = readStandardsFileAtRef({
      standardsFile: env.STANDARDS_FILE ?? "",
      candidates: env.STANDARDS_FILE_CANDIDATES || DEFAULT_STANDARDS_FILE_CANDIDATES,
      ref: baseRef,
      workspace,
    });
    return { resolved, content, changedInPr: false };
  } catch (error) {
    errorLog(`standards file could not be read from the base ref: ${error instanceof StandardsFileRefError ? error.message : "unknown error"}; ignoring it.`);
    return { resolved: null, content: null, changedInPr: false };
  }
}

interface ReviewCallInput {
  env: StageEnv;
  ws: RunWorkspace;
  profiles: TierProfiles;
  streamBool: boolean;
  userMessage: string;
  log: (line: string) => void;
  errorLog: (line: string) => void;
  clock: () => number;
  readonly sleep?: ((seconds: number) => Promise<void>) | undefined;
}

function tierProfileFrom(profiles: TierProfiles, tier: "primary" | "fallback" | "smart", env: StageEnv): TierProfile {
  const resolved = tier === "fallback" ? profiles.fallback : tier === "smart" ? profiles.smart : profiles.primary;
  const aiMaxTokens = Number(env.AI_MAX_TOKENS ?? "8192") || 8192;
  const temperatureRaw = env.AI_TEMPERATURE ?? "0.1";
  return {
    label: tier === "fallback" ? "Fallback" : tier === "smart" ? "Smart" : "Primary",
    baseUrl: resolved.baseUrl,
    apiFormat: resolved.apiFormat === "anthropic" ? "anthropic" : "openai",
    model: resolved.model,
    apiKey: resolved.apiKey,
    anthropicVersion: env.ANTHROPIC_VERSION ?? "2023-06-01",
    stream: tier === "fallback" ? (env.AI_FALLBACK_STREAM ?? env.AI_STREAM ?? "false").toLowerCase() === "true" : resolved.stream,
    requestTimeoutSec: resolved.requestTimeoutSec,
    connectTimeoutSec: resolved.connectTimeoutSec,
    retries: resolved.retries,
    retryDelaySec: resolved.retryDelaySec,
    shape: tierRequestShape(tier === "smart" ? "smart" : tier === "fallback" ? "fallback" : "primary", env),
    maxTokens: aiMaxTokens,
    temperature: temperatureRaw === "" ? "" : Number(temperatureRaw) || 0.1,
    responseFormat: (env.AI_RESPONSE_FORMAT ?? "off") as TierProfile["responseFormat"],
    tokensParam: (env.AI_TOKENS_PARAM ?? "max_tokens") as TierProfile["tokensParam"],
  };
}

async function callTier(
  tier: "primary" | "fallback" | "smart",
  profile: TierProfile,
  input: ReviewCallInput,
  corpusName: string,
  requestArtifact: string,
  responseArtifact: string,
): Promise<{ ok: boolean; artifact: Record<string, unknown> | null; rawResponse: unknown }> {
  const { env, ws, log, errorLog } = input;
  const corpusText = ws.readText(corpusName) ?? "";
  // Persist the request artifact before the first attempt (v2 writes it once).
  const requestPayload = buildModelRequest({
    apiFormat: profile.apiFormat,
    model: profile.model,
    system: env.SYSTEM_PROMPT ?? "",
    user: input.userMessage,
    corpus: corpusText,
    stream: profile.stream,
    shape: profile.shape,
    maxTokens: profile.maxTokens,
    temperature: profile.temperature,
    responseFormat: profile.responseFormat,
    tokensParam: profile.tokensParam,
  });
  ws.write(requestArtifact, pyJsonDumps(requestPayload.body));
  ws.write(responseArtifact, "");

  const outcome = await callModelTier(profile, {
    system: env.SYSTEM_PROMPT ?? "",
    user: input.userMessage,
    corpus: corpusText,
  }, {
    ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
    call: async (chatInput) => {
      const result = await runChatRequest(chatInput);
      if (result.status === "failure") return result;
      ws.write(responseArtifact, pyJsonDumps(result.raw));
      return result;
    },
  });
  if (outcome.status === "ok") {
    log(`${profile.label} model attempt ${outcome.attempts}/${profile.retries}: ${profile.model} @ ${profile.baseUrl} (${profile.apiFormat})`);
    const parsed = parseVerdictResponse(outcome.rawResponse, [profile.apiKey]);
    const artifact = reviewArtifactFromParsed(parsed) as unknown as Record<string, unknown>;
    ws.write("ai-output.json", Buffer.from(`${pyJsonDumps(artifact)}\n`, "utf8"));
    return { ok: true, artifact, rawResponse: outcome.rawResponse };
  }
  if (outcome.status === "empty_completion") {
    errorLog(`${profile.label}: model returned an empty completion; not retrying ${tier}`);
  } else if (outcome.status === "parse_exhausted") {
    // #868: the raw response artifact was written before parsing could tell
    // whether the body carried an in-body error (already-masked message
    // below, via `parseVerdictResponse`'s `secrets` — see
    // `surfaceStreamError`); replace it so an unmasked provider body never
    // survives on disk, mirroring the transport-exhausted branch below.
    errorLog(`${profile.label}: parse/validate failures exhausted (${outcome.failure.message})`);
    ws.write(responseArtifact, pyJsonDumps({ error: outcome.failure.message }));
  } else {
    // #846: carry the HTTP status and a redacted, length-capped body excerpt
    // (plus the ai-api-format hint on a 404) instead of the bare "model
    // endpoint returned HTTP <status>" message. `secrets` masks this tier's
    // configured key unconditionally, on top of `redactText`'s heuristics.
    const detail = describeTransportFailure(outcome.failure, { secrets: [profile.apiKey] });
    errorLog(`${profile.label}: transport failures exhausted (${detail})`);
    ws.write(responseArtifact, pyJsonDumps({ error: detail }));
  }
  return { ok: false, artifact: null, rawResponse: null };
}

/** Every API key the run could have sent, longest first so a key that
 * contains another is masked whole: the route-bound AI_API_KEY plus each
 * configured profile, so the mask holds if the route binding changes. */
function configuredApiKeys(routeKey: string | undefined, profiles: TierProfiles): string[] {
  const keys = [routeKey, profiles.primary.apiKey, profiles.smart.apiKey, profiles.fallback.apiKey]
    .filter((key): key is string => typeof key === "string" && key !== "");
  return [...new Set(keys)].sort((a, b) => b.length - a.length);
}

/** review.sh: the primary call (native-verdict fast path, then the standard
 * corpus review) and the fallback on total primary failure. */
async function producePrimaryReview(input: ReviewCallInput & {
  runDir?: string;
  budgets: ReturnType<typeof resolveTierBudgets>;
}): Promise<{
  artifact: Record<string, unknown> | null;
  analysisEngine: string;
  fromPrimary: boolean;
  fromFallback: boolean;
}> {
  const { env, ws, profiles, log, errorLog, budgets } = input;
  const toolMode = (env.TOOL_MODE ?? "off").toLowerCase();
  const harness = safeJson(ws.read("tool-harness.json"));
  // #965: the first pass is always the primary tier — the resolver never
  // emits "smart", and the code encodes that instead of trusting it.
  const firstTier = "primary" as const;
  const firstProfile = tierProfileFrom(profiles, firstTier, env);

  // native_loop in-conversation verdict (#205/#637): parse the harness's own
  // verdict response and skip the separate review call when it is reusable.
  if (toolMode === "native_loop" && harness?.native_loop_verdict_produced === true) {
    const responseBytes = ws.read("ai-response.primary.json");
    if (responseBytes !== null && responseBytes.length > 0) {
      log("native_loop produced an in-conversation verdict; using it and skipping the separate review call");
      try {
        // The native loop calls the route-bound AI_* environment, which can
        // differ from an explicit primary profile override, so mask every key.
        const parsed = parseVerdictResponse(JSON.parse(Buffer.from(responseBytes).toString("utf8")), configuredApiKeys(env.AI_API_KEY, profiles));
        const artifact = reviewArtifactFromParsed(parsed) as unknown as Record<string, unknown>;
        ws.write("ai-output.json", Buffer.from(`${pyJsonDumps(artifact)}\n`, "utf8"));
        return {
          artifact,
          analysisEngine: annotateAnalysisEngine(
            analysisEngineBase(env.AI_MODEL ?? "", env.AI_BASE_URL ?? "", env.AI_API_FORMAT ?? "openai"),
            "primary",
            {
              ...(env.REVIEW_ROUTE !== undefined ? { reviewRoute: env.REVIEW_ROUTE } : {}),
              ...(env.ROUTE_REASON !== undefined ? { routeReason: env.ROUTE_REASON } : {}),
            },
          ),
          fromPrimary: true,
          fromFallback: false,
        };
      } catch (cause) {
        errorLog(`native_loop verdict did not parse (${cause instanceof Error ? cause.message : "unknown"}); falling back to the standard review call`);
      }
    } else {
      errorLog(`native_loop flagged a verdict but ai-response.primary.json is missing or empty (${String(harness.native_loop_verdict_reason ?? "unknown")}); falling back to the standard review call`);
    }
  } else if (toolMode === "native_loop" && harness?.native_loop_verdict_status === "fallback") {
    log(`native_loop did not produce a reusable in-conversation verdict (${String(harness.native_loop_verdict_reason ?? "unknown")}); falling back to the standard review call`);
  }

  const engineBase = analysisEngineBase(firstProfile.model, firstProfile.baseUrl, firstProfile.apiFormat);
  // The *.primary.json names are the first-pass slot, not the model. Read
  // the model from the request body or the analysis-engine line, never from
  // the filename.
  const primary = await callTier(firstTier, firstProfile, input, "review-corpus.truncated.md", "ai-request.primary.json", "ai-response.primary.json");
  if (primary.ok) {
    log(`${firstProfile.label} model succeeded`);
    return {
      artifact: primary.artifact,
      analysisEngine: annotateAnalysisEngine(engineBase, "primary", {
        ...(env.REVIEW_ROUTE !== undefined ? { reviewRoute: env.REVIEW_ROUTE } : {}),
        ...(env.ROUTE_REASON !== undefined ? { routeReason: env.ROUTE_REASON } : {}),
      }),
      fromPrimary: true,
      fromFallback: false,
    };
  }

  // Fallback is availability recovery, never quality escalation.
  if (!profiles.fallback.resolved) {
    const outcome = handleModelFailure(`${firstProfile.label} model unavailable and no fallback model configured`, env.ON_MODEL_FAILURE ?? "fail");
    if (outcome.action === "fail") throw new RunReviewError(outcome.reason);
    log("on_model_failure=notice: emitting a request_changes notice instead of failing the check");
    return noticeResult(ws, outcome);
  }

  errorLog(`${firstProfile.label} model unavailable after retries; trying fallback: ${profiles.fallback.model} @ ${profiles.fallback.baseUrl} (${profiles.fallback.apiFormat})`);
  // #368: the fallback re-truncates the initial corpus. #940: the bound is
  // the declared fallback capacity — the fallback window can be smaller
  // than the primary tier's — never above the historical 120000-byte
  // constant.
  const fallbackCorpusBudget = budgets.fallback !== null
    ? Math.min(120000, budgets.fallback.maxCorpus)
    : 120000;
  ws.write("review-corpus.fallback.truncated.md", truncateClean(ws.read("review-corpus.md") ?? new Uint8Array(0), fallbackCorpusBudget, "…[content truncated]\n"));
  const fallbackProfile = tierProfileFrom(profiles, "fallback", env);
  const fallback = await callTier("fallback", fallbackProfile, input, "review-corpus.fallback.truncated.md", "ai-request.fallback.json", "ai-response.fallback.json");
  if (fallback.ok) {
    log("Fallback model succeeded");
    return {
      artifact: fallback.artifact,
      analysisEngine: annotateAnalysisEngine(
        analysisEngineBase(profiles.fallback.model, profiles.fallback.baseUrl, profiles.fallback.apiFormat),
        "fallback",
        { ...(env.REVIEW_ROUTE !== undefined ? { reviewRoute: env.REVIEW_ROUTE } : {}) },
      ),
      fromPrimary: false,
      fromFallback: true,
    };
  }
  const outcome = handleModelFailure("Fallback model failed", env.ON_MODEL_FAILURE ?? "fail");
  if (outcome.action === "fail") throw new RunReviewError(outcome.reason);
  log("on_model_failure=notice: emitting a request_changes notice instead of failing the check");
  return noticeResult(ws, outcome);
}

/** `on-model-failure: notice`: the notice verdict is already final JSON, so
 * it is parsed as the content of a provider reply (the same validation and
 * artifact normalization a model answer gets), never as the reply itself. */
function noticeResult(
  ws: RunWorkspace,
  outcome: { aiOutputJson: string; analysisEngine: string },
): { artifact: Record<string, unknown>; analysisEngine: string; fromPrimary: false; fromFallback: false } {
  const parsed = parseVerdictResponse({ choices: [{ message: { content: outcome.aiOutputJson } }] });
  const artifact = reviewArtifactFromParsed(parsed) as unknown as Record<string, unknown>;
  ws.write("ai-output.json", Buffer.from(`${pyJsonDumps(artifact)}\n`, "utf8"));
  return { artifact, analysisEngine: outcome.analysisEngine, fromPrimary: false, fromFallback: false };
}

interface SmartReviewInput extends ReviewCallInput {
  budgets: ReturnType<typeof resolveTierBudgets>;
  generatedPaths: ReadonlySet<string>;
  standards: { resolved: string | null; content: Uint8Array | null; changedInPr?: boolean };
  runDir: string;
  /** The checkout the tool executors read (never the artifact run dir). */
  workspace: string;
}

/** review.sh `run_smart_review`: the escalated smart review with its own
 * tool harness (native_loop), corpus build, and failure mapping. */
async function runSmartReview(input: SmartReviewInput): Promise<{ ok: boolean }> {
  const { env, ws, profiles, log, errorLog } = input;
  for (const name of ["ai-response.smart.json", "tool-harness.smart.md", "tool-harness.smart.json", "review-corpus.smart.truncated.md"]) ws.remove(name);

  const toolMode = (env.TOOL_MODE ?? "off").toLowerCase();
  const forkFlag = env.IS_FORK_PR ?? "false";
  if (toolMode === "native_loop") {
    const forkGate = gateForkForForks(env, forkFlag);
    if (forkGate !== null) {
      ws.write("tool-harness.smart.md", "Smart tool harness skipped for a cross-repository pull request.\n");
      ws.write("tool-harness.smart.json", '{"tier":"smart","mode":"native_loop","skipped":true,"skip_reason":"fork-pr","rounds":0,"planned_request_count":0,"executed_request_count":0,"tool_results":[]}\n');
      log("Smart tool harness skipped for a cross-repository pull request.");
    } else {
      // Build the smart-tier corpus BEFORE the harness: the native loop
      // plans its investigation from review-corpus.smart.truncated.md
      // (#969 — the primary flow builds its corpus before the harness too).
      const prebuild = assembleCorpus(ws, input.env as StageEnv, input.budgets, "smart", "smart", input.generatedPaths, input.standards);
      if (prebuild.overBudget) errorLog("ERROR: assembled smart corpus exceeds its context budget");
      // The tier-smart harness reads its endpoint from the SMART_* env keys
      // (tier-keyed, unlike the AI_* transport the loop uses at tier
      // primary); bind the resolved smart profile for the harness phase.
      const smartEnvKeys = ["SMART_BASE_URL", "SMART_MODEL", "SMART_API_FORMAT", "SMART_API_KEY"] as const;
      const savedSmartEnv = smartEnvKeys.map((key) => [key, env[key]] as const);
      env.SMART_BASE_URL = profiles.smart.baseUrl;
      env.SMART_MODEL = profiles.smart.model;
      env.SMART_API_FORMAT = profiles.smart.apiFormat;
      env.SMART_API_KEY = profiles.smart.apiKey;
      env.TOOL_HARNESS_TIER = "smart";
      try {
        await runToolHarnessPhase(ws, env, input.workspace, log);
      } catch (cause) {
        errorLog(`smart tool harness failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        ws.write("tool-harness.smart.json", '{"tier":"smart","mode":"native_loop","error":"execution failed","stop_reason":"request-error","rounds":0,"planned_request_count":0,"executed_request_count":0,"tool_results":[]}\n');
      } finally {
        for (const [key, value] of savedSmartEnv) {
          if (value === undefined) delete env[key];
          else env[key] = value;
        }
      }
      const smartHarness = safeJson(ws.read("tool-harness.smart.json")) ?? {};
      const status = String(smartHarness.stop_reason ?? smartHarness.native_loop_degraded ?? "");
      const produced = smartHarness.native_loop_verdict_produced === true;
      const failureReason = String(smartHarness.native_loop_verdict_reason ?? "");
      const responseBytes = ws.read("ai-response.smart.json");
      if (status !== "request-error" && status !== "wall-clock-exceeded" && produced && responseBytes !== null && responseBytes.length > 0) {
        try {
          const parsed = parseVerdictResponse(JSON.parse(Buffer.from(responseBytes).toString("utf8")), configuredApiKeys(env.AI_API_KEY, profiles));
          const artifact = reviewArtifactFromParsed(parsed) as unknown as Record<string, unknown>;
          ws.write("ai-output.json", Buffer.from(`${pyJsonDumps(artifact)}\n`, "utf8"));
          log("Smart tool harness produced a verdict");
          return { ok: true };
        } catch (cause) {
          errorLog(`smart native_loop verdict did not parse: ${cause instanceof Error ? cause.message : "unknown"}`);
        }
      }
      if (status === "request-error" || status === "wall-clock-exceeded" || failureReason === "tool-error" || failureReason === "deadline") {
        return { ok: false };
      }
    }
  }

  // Rebuild the smart-tier corpus with the harness's tool evidence included
  // (slot smart → dedicated artifact names) and call the smart tier.
  const build = assembleCorpus(ws, input.env as StageEnv, input.budgets, "smart", "smart", input.generatedPaths, input.standards);
  if (build.overBudget) errorLog("ERROR: assembled smart corpus exceeds its context budget");
  const smartProfile = tierProfileFrom(profiles, "smart", env);
  const call = await callTier("smart", smartProfile, input, "review-corpus.smart.truncated.md", "ai-request.smart.json", "ai-response.smart.json");
  return { ok: call.ok };
}

// ---------------------------------------------------------------------------
// Step summary (review.sh write_step_summary)
// ---------------------------------------------------------------------------

interface SummaryInput {
  outputs: ReviewStepOutputs;
  env: StageEnv;
  ws: RunWorkspace;
  reviewRecord: Record<string, unknown>;
  primaryHarness: Record<string, unknown> | null;
  smartHarness: Record<string, unknown> | null;
  specialistOutcome: GateOutcome;
  deepMode: string;
  coverage: Record<string, unknown> | null;
  budgets: ReturnType<typeof resolveTierBudgets>;
  profiles: TierProfiles;
  route: string;
  routeReason: string;
  analysisEngine: string;
  escalationReasons: string;
  fallbackUsed: boolean;
}

/** Port of write_step_summary: the observability table a debugging user
 * reads instead of raw logs. Written only when GITHUB_STEP_SUMMARY is set. */
function writeStepSummary(stepSummaryPath: string, input: SummaryInput): void {
  if (stepSummaryPath === "") return;
  const { env, ws, reviewRecord, primaryHarness, smartHarness } = input;
  const toolMode = (env.TOOL_MODE ?? "off").toLowerCase();
  const findings = Array.isArray(reviewRecord.findings) ? reviewRecord.findings as unknown[] : [];
  const toolCalls = Array.isArray(primaryHarness?.tool_calls) ? primaryHarness?.tool_calls as unknown[] : [];
  const okCalls = toolCalls.filter((call) => (call as { status?: string }).status === "ok").length;
  const coverageSummary = (input.coverage?.summary ?? {}) as Record<string, unknown>;
  const total = typeof coverageSummary.total === "number" ? coverageSummary.total : 0;
  const unknown = typeof coverageSummary.unknown === "number" ? coverageSummary.unknown : 0;

  const profileKey = input.route === "escalated" ? "smart" : "primary";
  const budget = input.budgets[profileKey];
  const corpusName = input.route === "escalated" ? "review-corpus.smart.truncated.md" : "review-corpus.truncated.md";
  const corpusBytes = byteLength(ws.read(corpusName));
  const diffBytes = byteLength(ws.read("pr.diff"));

  const usageFile = input.route === "escalated" && ws.isFile("ai-response.smart.json")
    ? "ai-response.smart.json"
    : input.fallbackUsed && ws.isFile("ai-response.fallback.json")
      ? "ai-response.fallback.json"
      : "ai-response.primary.json";
  const usage = (safeJson(ws.read(usageFile))?.usage ?? {}) as Record<string, unknown>;

  const nativeStatus = String(primaryHarness?.native_loop_verdict_status ?? "");
  const deepReview = ws.isFile("specialists.json") ? safeJson(ws.read("specialists.json")) : null;

  const table = renderStepSummary({
    analysisEngine: publicAnalysisEngine(input.analysisEngine),
    verdict: input.outputs.verdict || "unknown",
    verdictSource: input.outputs.verdictSource,
    findingsCount: findings.length,
    blockersCount: findings.filter((f) => (f as { severity?: string }).severity === "blocker").length,
    requiredChecksStatus: input.outputs.requiredChecks,
    ...(total > 0 ? { requirementCoverage: { total, unknown } } : {}),
    primaryTools: {
      executedRequestCount: typeof primaryHarness?.executed_request_count === "number" ? primaryHarness.executed_request_count : 0,
      successfulToolCalls: okCalls,
      rounds: typeof primaryHarness?.rounds === "number" ? primaryHarness.rounds : 0,
      stopReason: String(primaryHarness?.stop_reason ?? primaryHarness?.skip_reason ?? (toolMode === "native_loop" ? "unknown" : "disabled")),
    },
    ...(smartHarness !== null && toolMode === "native_loop"
      ? {
        smartTools: {
          issuedToolCalls: Array.isArray(smartHarness.tool_calls) ? (smartHarness.tool_calls as unknown[]).length : 0,
          rounds: typeof smartHarness.rounds === "number" ? smartHarness.rounds : 0,
          requests: numberAt(smartHarness.usage, "requests") ?? numberAt(smartHarness.native_loop_usage, "requests") ?? 0,
          stopReason: String(smartHarness.stop_reason ?? smartHarness.native_loop_degraded ?? smartHarness.skip_reason ?? smartHarness.error ?? "unknown"),
          verdictStatus: String(smartHarness.native_loop_verdict_status ?? "corpus"),
        },
      }
      : {}),
    ...(nativeStatus !== ""
      ? {
        nativeVerdict: {
          status: nativeStatus,
          ...(primaryHarness?.native_loop_verdict_transport !== undefined && primaryHarness.native_loop_verdict_transport !== null
            ? { transport: String(primaryHarness.native_loop_verdict_transport) }
            : {}),
          attempts: typeof primaryHarness?.native_loop_verdict_attempts === "number" ? primaryHarness.native_loop_verdict_attempts : 0,
          retried: primaryHarness?.native_loop_verdict_retried === true,
          ...(primaryHarness?.native_loop_verdict_reason !== undefined && primaryHarness.native_loop_verdict_reason !== null
            ? { reason: String(primaryHarness.native_loop_verdict_reason) }
            : {}),
        },
      }
      : {}),
    route: input.route,
    ...(input.routeReason !== "" ? { routeReason: input.routeReason } : {}),
    ...(deepReview !== null
      ? {
        deepReview: {
          leads: String(deepReview.total_leads ?? 0),
          errors: deepReview.any_errors === true,
          ...(deepReview.deep_review_mode === "auto" && typeof deepReview.selection === "object" && deepReview.selection !== null
            ? {
              autoSelection: {
                selected: arrayLength((deepReview.selection as Record<string, unknown>).selected_roles),
                skipped: arrayLength((deepReview.selection as Record<string, unknown>).skipped_roles),
              },
            }
            : {}),
        },
      }
      : {}),
    budget: /^\d+$/.test(env.MODEL_CONTEXT_TOKENS ?? "") ? `model_context_tokens=${env.MODEL_CONTEXT_TOKENS}` : `context_limit_mode=${env.CONTEXT_LIMIT_MODE ?? "normal"}`,
    finalContext: `tier=${profileKey}; model_context_tokens=${contextCapacity(env, profileKey)}; corpus_budget=${budget.maxCorpus}B; corpus_actual=${corpusBytes}B; diff_budget=${budget.maxDiff}B; diff_actual=${diffBytes}B; request_shape=${profileKey === "smart" ? env.SMART_REQUEST_SHAPE ?? "default" : env.PRIMARY_REQUEST_SHAPE ?? "default"}`,
    diffBytes: { actual: `${diffBytes}B`, truncated: diffBytes > budget.maxDiff ? `yes (cap ${budget.maxDiff})` : "no" },
    corpusBytes: { actual: `${corpusBytes}B`, truncated: corpusBytes > budget.maxCorpus ? `yes (cap ${budget.maxCorpus})` : "no" },
    promptTokens: stringAt(usage, "prompt_tokens"),
    completionTokens: stringAt(usage, "completion_tokens"),
    cacheHitRatio: input.outputs.cacheHitRatio,
  });
  try {
    appendFileSync(stepSummaryPath, table);
  } catch {
    // The summary is observability; a write failure never fails the review.
  }
}

function byteLength(bytes: Uint8Array | null | undefined): number {
  return bytes === null || bytes === undefined ? 0 : bytes.length;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function numberAt(record: unknown, key: string): number | null {
  if (record === null || typeof record !== "object") return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

function stringAt(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return value === undefined || value === null ? "-" : String(value);
}

function contextCapacity(env: StageEnv, profileKey: "primary" | "smart"): string {
  const tier = profileKey === "smart" ? env.SMART_MODEL_CONTEXT_TOKENS : env.PRIMARY_MODEL_CONTEXT_TOKENS;
  return tier || env.MODEL_CONTEXT_TOKENS || "unset";
}
