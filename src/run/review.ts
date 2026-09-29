import { V3_CONTRACT } from "../../.v3-generated/contract.generated.js";
import { validateContract } from "../config/contract.js";
import { loadConfig, type RawInputs } from "../config/load-config.js";
import { resolveRepositoryConfig } from "../config/repository-config.js";
import { assertSupportedNode } from "../runtime/node-version.js";
import { createCancellationScope } from "../runtime/signals.js";
import { resolveTierBudgets } from "../corpus/budgets.js";
import { prioritizeDiff } from "../corpus/diff-priority.js";
import { truncateClean } from "../corpus/truncate.js";
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalChangedFile, normalizeLinkedIssues } from "../context/types.js";
import { pythonJsonStringify } from "../precheck/metadata.js";
import { buildHarnessObligations } from "../requirements/obligations.js";
import { externalChecksConclusion } from "../precheck/decide.js";
import { resolveStandardsFile } from "../context/standards-file.js";
import { runChatRequest } from "../transport/transport.js";
import type { FetchLike } from "../platform/http.js";
import { normalizePrIdentity } from "../platform/pr.js";
import type { PlatformReadAdapter } from "../platform/types.js";
import { buildPlatformReadAdapter } from "./platform.js";
import { buildStageEnv, validateStageEnv, type RunContext, type StageEnv } from "./env.js";
import { RunWorkspace } from "./workspace.js";
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
import { resolveReviewRoute, resolveTierProfiles, routeSignalsFromClassification, tierRequestShape, type TierProfiles } from "../routing/tiers.js";
import { reviewerRequestedEscalation } from "../routing/escalation.js";
import { buildSpecialistCorpus } from "../specialists/corpus.js";
import { forkGate, type ForkedGate, type GateName, type GateOutcome } from "../gates/gates.js";
import { ciGateBranch } from "../gates/workloads.js";
import { runSpecialistsGate } from "../gates/specialists-gate.js";
import { buildModelRequest } from "../model/request.js";
import { callModelTier, type TierProfile } from "../model/call.js";
import { parseVerdictResponse } from "../model/verdict.js";
import { annotateAnalysisEngine, analysisEngineBase, buildUserMessage, handleModelFailure, applySystemPromptFragments, applySpecialistLeadsFragment, resolveSystemPrompt } from "../prompt/index.js";
import { reviewArtifactFromParsed } from "../enforcement/artifact.js";
import { applyStrictVerdictPolicy, applyVerdictPolicy } from "../enforcement/verdict-policy.js";
import { markerReviewResult } from "../publish/publish.js";
import type { PartialCoverage } from "../tools/coverage.js";
import { applyRequiredCheckValidation } from "../enforcement/completeness.js";
import { applyAllEnforcement, failClosedEnforcementFired, type EnforcementInputs } from "../enforcement/enforce.js";
import { normalizeRequirementCoverage } from "../enforcement/requirement-coverage.js";
import { pyJsonDumps } from "../evidence/pyjson.js";
import { buildRunMetadataMarker } from "../metadata/markers.js";
import {
  buildCacheHitRatioOutput,
  buildToolCallsOutput,
  formatReviewStepOutputs,
  renderStepSummary,
  type ReviewStepOutputs,
} from "../publish/outputs.js";
import {
  assembleCorpus,
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
  runToolHarnessPhase,
  safeJson,
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
  /** The reviewed checkout; defaults to GITHUB_WORKSPACE or the run dir. */
  workspace?: string;
  /** Where artifacts persist; defaults to the process cwd. */
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

  const runDir = options.runDir ?? options.env.PR_REVIEWER_RUN_DIR ?? process.cwd();
  const workspace = options.workspace ?? options.env.GITHUB_WORKSPACE ?? runDir;
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
    aiMaxTokens: env.AI_MAX_TOKENS,
    contextLimitMode: env.CONTEXT_LIMIT_MODE,
  });
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
  const standards = resolveStandards(env, workspace);
  let promptState = resolveSystemPrompt(
    {
      ...(env.SYSTEM_PROMPT !== undefined ? { systemPrompt: env.SYSTEM_PROMPT } : {}),
      ...(env.SYSTEM_PROMPT_FILE !== undefined ? { systemPromptFile: env.SYSTEM_PROMPT_FILE } : {}),
      ...(env.SYSTEM_PROMPT_MODE !== undefined ? { systemPromptMode: env.SYSTEM_PROMPT_MODE } : {}),
    },
    ws,
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

  const filesResult = await adapter.listPrFiles();
  if (!filesResult.ok) throw new RunReviewError(`platform_pr_files failed: ${filesResult.error}`);
  const prFilesRaw = filesResult.data;
  ws.write("pr-files.raw.json", pyJsonDumps(prFilesRaw));
  const totalChangedFiles = typeof pr.changedFiles === "number" ? pr.changedFiles : 0;
  const rawFilesList = Array.isArray(prFilesRaw) ? prFilesRaw : [];
  ws.write("pr-files.json", filesProjection(rawFilesList, totalChangedFiles));
  ws.write("pr-files.truncated.json", truncateClean(Buffer.from(filesProjection(rawFilesList, totalChangedFiles)), budgets.primary.maxFiles, "…[file list truncated]"));
  ws.write("pr-body.txt", String(pr.body ?? ""));

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
  const harnessObligations = relatedInputs === null ? [] : buildHarnessObligations(relatedInputs);

  // PR-metadata-derived context (context.sh): linked issues + Linear, the
  // requirement ledger, review threads and human reviews. Built here and
  // again after the CI wait (#812), so edits made while CI runs are seen.
  const buildMetadataContext = async (prRecord: typeof pr): Promise<Awaited<ReturnType<typeof buildLinkedIssueContext>>> => {
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
    await buildReviewThreadsSection(ws, adapter, env);
    await buildHumanReviewsSection(ws, adapter, String(prRecord.headRefOid ?? ""), env);
    return linkedResult;
  };
  const linked = await buildMetadataContext(pr);

  // Manifest context (context.sh tail).
  const manifest = buildManifestContext(prFilesRaw, workspace);
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

  const { route, reason } = resolveReviewRoute({
    routingMode: env.REVIEW_ROUTING_MODE ?? "off",
    routeSignals: routeSignalsFromClassification(classificationArtifact),
    escalateOnRiskFlags: splitCsv(env.ESCALATE_ON_RISK_FLAGS ?? ""),
    smartModelResolved: profiles.smart.resolved,
  });
  env.REVIEW_ROUTE = route;
  env.ROUTE_REASON = reason;
  if (route === "primary") {
    Object.assign(env, { AI_BASE_URL: profiles.primary.baseUrl, AI_MODEL: profiles.primary.model, AI_API_FORMAT: profiles.primary.apiFormat, AI_API_KEY: profiles.primary.apiKey });
  } else if (route === "smart") {
    Object.assign(env, { AI_BASE_URL: profiles.smart.baseUrl, AI_MODEL: profiles.smart.model, AI_API_FORMAT: profiles.smart.apiFormat, AI_API_KEY: profiles.smart.apiKey });
  }
  env.REVIEW_CONTEXT_PROFILE = route === "smart" ? "smart" : "primary";
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

  // PR-thread context (corpus.sh).
  await buildPrThreadSection(ws, adapter, env);

  // Corpus build #1 (initial review owns the primary artifact slot).
  const profileKey: "primary" | "smart" = env.REVIEW_CONTEXT_PROFILE === "smart" ? "smart" : "primary";
  let corpusResult = assembleCorpus(ws, env, budgets, profileKey, "primary", generatedPaths, standards);
  ws.write("review-corpus.truncated.md", ws.read(corpusResult.outputName) ?? new Uint8Array(0));

  // ── Gates: advisory specialists (in-process) + CI join (#634) ────────
  const deepMode = (env.DEEP_REVIEW ?? "false").toLowerCase();
  let specialistOutcome: GateOutcome = NO_GATE_OUTCOME("specialists");
  if (deepMode === "true" || deepMode === "auto") {
    env.DEEP_REVIEW_ACTIVE = "true";
    // The compact #632 pre-final specialist corpus is fixed from the
    // artifacts collected so far — never the final review corpus.
    const corpus = buildSpecialistCorpus(specialistWorkspace(ws, ciChecksBytes(env)));
    ws.write("specialist-corpus.md", corpus[0]);
    const specialistFork = await forkGate("specialists", {
      file: "",
      envAllowlist: [],
      workload: async () => runSpecialistsGate({
        env,
        // The gate's artifacts (role files, specialists.json/.md) must land
        // in the run dir this workspace reads, not GITHUB_WORKSPACE.
        argv: ["--corpus", "specialist-corpus.md", "--workspace-root", runDir],
        cwd: runDir,
        stdout: (line) => log(line),
        stderr: (line) => errorLog(line),
        ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      }),
    }, { scope });
    specialistOutcome = await specialistFork.join();
  }
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
      Object.assign(pr, next);
      ws.write("pr-object.json", pyJsonDumps(refreshed));
      ws.write("pr.json", pyJsonDumps(pr));
      ws.write("pr-body.txt", String(pr.body ?? ""));
      await buildMetadataContext(pr);
      await buildPrThreadSection(ws, adapter, env);
    }
  }

  // Rebuild the corpus with both branches resolved (finalized CI evidence
  // + any rendered specialist leads + refreshed PR metadata).
  if (env.CI_GATE_ACTIVE === "true" || ws.isNonEmpty("specialists.md")) {
    log("review gates resolved: rebuilding corpus with finalized CI evidence and specialist leads");
    corpusResult = assembleCorpus(ws, env, budgets, profileKey, "primary", generatedPaths, standards);
    ws.write("review-corpus.truncated.md", ws.read(corpusResult.outputName) ?? new Uint8Array(0));
  }

  promptState = applySpecialistLeadsFragment(promptState, ws);
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
    env, ws, profiles, streamBool, userMessage, log, errorLog, clock, sleep: options.sleep,
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
    threads: safeJson(ws.read("review-threads.json")) as never,
    humanReviews: safeJson(ws.read("human-reviews.json")) as never,
    verdictPolicy,
  };
  if (verdictPolicy === "strict") {
    // #811 composition (same order as the enforcement-pipeline fixture):
    // coverage, then the enforcement overlays, then the strict mapping over
    // the final still-open findings set.
    const completeness = applyRequiredCheckValidation(reviewRecord as never, completenessOptions);
    applyAllEnforcement(reviewRecord as never, enforcementInputs);
    const forced = failClosedEnforcementFired(enforcementInputs)
      || (completeness.status === "incomplete" && completeness.mode === "fail");
    applyStrictVerdictPolicy(reviewRecord as never, { modelVerdict, forced });
  } else {
    applyVerdictPolicy(reviewRecord as never, verdictPolicy, {
      nonBlockingCategories: new Set(splitCsv(env.NON_BLOCKING_FINDING_CATEGORIES ?? "")),
      securityFlagged: isSecurityFlagged(classificationArtifact),
    });
    applyRequiredCheckValidation(reviewRecord as never, completenessOptions);
    applyAllEnforcement(reviewRecord as never, enforcementInputs);
  }
  ws.write("ai-output.json", Buffer.from(`${pyJsonDumps(reviewRecord)}\n`, "utf8"));

  // Requirement coverage fold (#624) — advisory, never alters a verdict.
  ws.write("requirement-coverage.json", new Uint8Array(0));
  const ledgerValue = safeJson(ws.read("requirement-ledger.json"));
  const ledgerRequirements = (ledgerValue as { requirements?: unknown } | null)?.requirements;
  if (Array.isArray(ledgerRequirements) && ledgerRequirements.length > 0) {
    const coverage = normalizeRequirementCoverage(reviewRecord.requirement_coverage as never, ledgerValue);
    ws.write("requirement-coverage.json", Buffer.from(`${pyJsonDumps(coverage)}\n`, "utf8"));
  }

  // ── Outputs + step summary (review.sh tail) ──────────────────────────
  const cacheHitRatio = buildCacheHitRatioOutput(safeJson(ws.read(enforcementHarness)));
  const toolCalls = buildToolCallsOutput(
    safeJson(ws.read("tool-harness.json")),
    enforcementHarness === "tool-harness.smart.json" ? safeJson(ws.read("tool-harness.smart.json")) : null,
  );
  const outputs: ReviewStepOutputs = {
    verdict: String(reviewRecord.verdict ?? ""),
    verdictSource: String(reviewRecord.verdict_source ?? "model"),
    requiredChecks: String(reviewRecord.required_checks ?? "none"),
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
  // #810: the harness's own deterministic coverage record for the published
  // route (smart when escalated), never the model's claim.
  const partialCoverage = partialCoverageOf(safeJson(ws.read(enforcementHarness)));
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
    // Same derivation as the publish path's marker (#811, #810).
    reviewResult: markerReviewResult({
      verdictPolicy,
      verdict: outputs.verdict,
      findings: reviewRecord.findings,
      requiredChecks: outputs.requiredChecks,
      partialCoverage,
    }),
    requiredChecks: outputs.requiredChecks,
    reviewRoute: outputs.reviewRoute,
    escalationReason: outputs.escalationReason,
    cacheHitRatio: outputs.cacheHitRatio,
    ...(partialCoverage ? { coverage: "partial", coverageStopReason: partialCoverage.stop_reason } : {}),
    ...(ciState !== undefined ? { ciState } : {}),
  });
  return {
    outputs,
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

function partialCoverageOf(harness: Record<string, unknown> | null): PartialCoverage | undefined {
  const value = harness?.partial_coverage;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { stop_reason?: unknown }).stop_reason === "string"
    ? value as PartialCoverage
    : undefined;
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

function resolveStandards(env: StageEnv, workspace: string): { resolved: string | null; content: Uint8Array | null } {
  const resolved = resolveStandardsFile({
    standardsFile: env.STANDARDS_FILE ?? "",
    candidates: env.STANDARDS_FILE_CANDIDATES || "AGENTS.md,agents.md,CLAUDE.md,claude.md,.github/ai-review-rules.md,.github/ai-review-rules.txt",
    workspace,
  });
  if (resolved === "") return { resolved: null, content: null };
  try {
    const path = resolved.startsWith("/") ? resolved : `${workspace}/${resolved}`;
    return { resolved, content: readFileSync(path) };
  } catch {
    return { resolved, content: null };
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
    shape: tierRequestShape(tier === "smart" ? "smart" : tier === "fallback" ? "fallback" : (env.REVIEW_CONTEXT_PROFILE === "smart" ? "smart" : "primary"), env),
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
    const parsed = parseVerdictResponse(outcome.rawResponse);
    const artifact = reviewArtifactFromParsed(parsed) as unknown as Record<string, unknown>;
    ws.write("ai-output.json", Buffer.from(`${pyJsonDumps(artifact)}\n`, "utf8"));
    return { ok: true, artifact, rawResponse: outcome.rawResponse };
  }
  if (outcome.status === "empty_completion") {
    errorLog(`${profile.label}: model returned an empty completion; not retrying ${tier}`);
  } else if (outcome.status === "parse_exhausted") {
    errorLog(`${profile.label}: parse/validate failures exhausted (${outcome.failure.message})`);
  } else {
    errorLog(`${profile.label}: transport failures exhausted (${outcome.failure.message})`);
  }
  return { ok: false, artifact: null, rawResponse: null };
}

/** review.sh: the primary call (native-verdict fast path, then the standard
 * corpus review) and the fallback on total primary failure. */
async function producePrimaryReview(input: ReviewCallInput & { runDir?: string }): Promise<{
  artifact: Record<string, unknown> | null;
  analysisEngine: string;
  fromPrimary: boolean;
  fromFallback: boolean;
}> {
  const { env, ws, profiles, log, errorLog } = input;
  const toolMode = (env.TOOL_MODE ?? "off").toLowerCase();
  const harness = safeJson(ws.read("tool-harness.json"));

  // native_loop in-conversation verdict (#205/#637): parse the harness's own
  // verdict response and skip the separate review call when it is reusable.
  if (toolMode === "native_loop" && harness?.native_loop_verdict_produced === true) {
    const responseBytes = ws.read("ai-response.primary.json");
    if (responseBytes !== null && responseBytes.length > 0) {
      log("native_loop produced an in-conversation verdict; using it and skipping the separate review call");
      try {
        const parsed = parseVerdictResponse(JSON.parse(Buffer.from(responseBytes).toString("utf8")));
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

  const primaryProfile = tierProfileFrom(profiles, "primary", env);
  const engineBase = analysisEngineBase(env.AI_MODEL ?? "", env.AI_BASE_URL ?? "", env.AI_API_FORMAT ?? "openai");
  const primary = await callTier("primary", primaryProfile, input, "review-corpus.truncated.md", "ai-request.primary.json", "ai-response.primary.json");
  if (primary.ok) {
    log("Primary model succeeded");
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
    const outcome = handleModelFailure("Primary model unavailable and no fallback model configured", env.ON_MODEL_FAILURE ?? "fail");
    if (outcome.action === "fail") throw new RunReviewError(outcome.reason);
    log("on_model_failure=notice: emitting a request_changes notice instead of failing the check");
    const parsed = parseVerdictResponse(JSON.parse(outcome.aiOutputJson));
    const artifact = reviewArtifactFromParsed(parsed) as unknown as Record<string, unknown>;
    ws.write("ai-output.json", Buffer.from(`${pyJsonDumps(artifact)}\n`, "utf8"));
    return { artifact, analysisEngine: outcome.analysisEngine, fromPrimary: false, fromFallback: false };
  }

  errorLog(`Primary model unavailable after retries; trying fallback: ${profiles.fallback.model} @ ${profiles.fallback.baseUrl} (${profiles.fallback.apiFormat})`);
  // #368: the fallback re-truncates the initial corpus at 120000 bytes.
  ws.write("review-corpus.fallback.truncated.md", truncateClean(ws.read("review-corpus.md") ?? new Uint8Array(0), 120000, "…[content truncated]\n"));
  const fallbackProfile = tierProfileFrom(profiles, "fallback", env);
  const fallback = await callTier("fallback", fallbackProfile, input, "review-corpus.fallback.truncated.md", "ai-request.fallback.json", "ai-response.fallback.json");
  if (fallback.ok) {
    log("Fallback model succeeded");
    return {
      artifact: fallback.artifact,
      analysisEngine: annotateAnalysisEngine(
        analysisEngineBase(profiles.fallback.model, profiles.fallback.baseUrl, profiles.fallback.apiFormat),
        "fallback",
      ),
      fromPrimary: false,
      fromFallback: true,
    };
  }
  const outcome = handleModelFailure("Fallback model failed", env.ON_MODEL_FAILURE ?? "fail");
  if (outcome.action === "fail") throw new RunReviewError(outcome.reason);
  log("on_model_failure=notice: emitting a request_changes notice instead of failing the check");
  const parsed = parseVerdictResponse(JSON.parse(outcome.aiOutputJson));
  const artifact = reviewArtifactFromParsed(parsed) as unknown as Record<string, unknown>;
  ws.write("ai-output.json", Buffer.from(`${pyJsonDumps(artifact)}\n`, "utf8"));
  return { artifact, analysisEngine: outcome.analysisEngine, fromPrimary: false, fromFallback: false };
}

interface SmartReviewInput extends ReviewCallInput {
  budgets: ReturnType<typeof resolveTierBudgets>;
  generatedPaths: ReadonlySet<string>;
  standards: { resolved: string | null; content: Uint8Array | null };
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
      env.TOOL_HARNESS_TIER = "smart";
      try {
        await runToolHarnessPhase(ws, env, input.workspace, log);
      } catch {
        ws.write("tool-harness.smart.json", '{"tier":"smart","mode":"native_loop","error":"execution failed","stop_reason":"request-error","rounds":0,"planned_request_count":0,"executed_request_count":0,"tool_results":[]}\n');
      }
      const smartHarness = safeJson(ws.read("tool-harness.smart.json")) ?? {};
      const status = String(smartHarness.stop_reason ?? smartHarness.native_loop_degraded ?? "");
      const produced = smartHarness.native_loop_verdict_produced === true;
      const failureReason = String(smartHarness.native_loop_verdict_reason ?? "");
      const responseBytes = ws.read("ai-response.smart.json");
      if (status !== "request-error" && status !== "wall-clock-exceeded" && produced && responseBytes !== null && responseBytes.length > 0) {
        try {
          const parsed = parseVerdictResponse(JSON.parse(Buffer.from(responseBytes).toString("utf8")));
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

  // Build the smart-tier corpus (slot smart → dedicated artifact names) and
  // call the smart tier.
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

  const profileKey = input.route === "escalated" || env.REVIEW_CONTEXT_PROFILE === "smart" ? "smart" : "primary";
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
    analysisEngine: input.analysisEngine,
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
