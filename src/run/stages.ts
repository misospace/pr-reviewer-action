import { appendFileSync, readFileSync } from "node:fs";
import type { ChangeAnchorsArtifact } from "../context/change-anchors.js";
import type { RelatedContext } from "../context/related-context.js";
import { runProcess } from "../runtime/subprocess.js";
import { splitChunks } from "../corpus/diff-priority.js";
import {
  buildBoundedRepoMap,
  buildReviewCorpus,
  prepareStandardsContext,
  prepareToolHarness,
  type CorpusBuildResult,
  type CorpusWorkspace,
} from "../corpus/assemble.js";
import type { PlatformReadAdapter } from "../platform/types.js";
import { deriveIsFork } from "../platform/pr.js";
import {
  clipRelatedCodeMarkdown,
  extractChangeAnchors,
  extractCompareShas,
  extractGhcrImages,
  extractUrls,
  extractVersionHints,
  buildRelatedContext,
  parseAllowedHosts,
  parseAllowedRepos,
  relatedContextToArtifact,
  renderChangeAnchorsJson,
  renderLinkedSources,
  renderRelatedContextMarkdown,
  renderPrThread,
  selectTargetVersion,
  defaultLinkedSourcesDeps,
  type LinkedSourcesInput,
} from "../context/index.js";
import { BudgetTracker } from "../context/budget.js";
import { buildImageProvenanceFromNetwork } from "../context/image-transport.js";
import { enforcementView as threadEnforcementView, prepareThreads, renderReviewThreads } from "../context/review-threads.js";
import { enforcementView as humanEnforcementView, prepareReviews, renderOutstanding } from "../context/human-reviews.js";
import { pythonJsonStringify } from "../precheck/metadata.js";
import { pyJsonDumps } from "../evidence/pyjson.js";
import { runEvidenceProvidersPhase } from "../evidence/index.js";
import { runToolHarness, type HarnessTransport } from "../tools/harness.js";
import { runChatRequest } from "../transport/transport.js";
import type { NormalizedModelResponse, TransportWirePayload } from "../model/types.js";
import type { TierBudgets } from "../corpus/budgets.js";
import type { StageEnv } from "./env.js";
import type { RunWorkspace } from "./workspace.js";

/** Small tolerant readers shared by the stage helpers. */

export function safeJson(bytes: Uint8Array | null | undefined): Record<string, unknown> | null {
  if (bytes === null || bytes === undefined || bytes.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function joinLines(lines: readonly string[]): string {
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

// ---------------------------------------------------------------------------
// context.sh: pr.json / pr-files.json projections
// ---------------------------------------------------------------------------

/** The context.sh pr.json projection: review-relevant fields with the same
 * jq `//` fallbacks. Key names are the v2 artifact's (the corpus projection
 * and the producers read THIS shape, not the canonical camelCase one). */
export function projectPr(prObject: unknown, prNumber: string): Record<string, unknown> {
  const record = (typeof prObject === "object" && prObject !== null ? prObject : {}) as Record<string, unknown>;
  const head = (typeof record.head === "object" && record.head !== null ? record.head : {}) as Record<string, unknown>;
  const base = (typeof record.base === "object" && record.base !== null ? record.base : {}) as Record<string, unknown>;
  const user = (typeof record.user === "object" && record.user !== null ? record.user : {}) as Record<string, unknown>;
  const author = typeof user.login === "string" && user.login !== "" ? user.login : (typeof record.author === "string" ? record.author : "");
  return {
    number: typeof record.number === "number" ? record.number : Number(prNumber),
    title: typeof record.title === "string" ? record.title : "",
    body: typeof record.body === "string" ? record.body : "",
    headRefOid: typeof head.sha === "string" ? head.sha : "",
    baseRefName: typeof base.ref === "string" ? base.ref : "",
    headRefName: typeof head.ref === "string" ? head.ref : "",
    author: { login: author },
    changedFiles: typeof record.changed_files === "number" ? record.changed_files : 0,
    additions: typeof record.additions === "number" ? record.additions : 0,
    deletions: typeof record.deletions === "number" ? record.deletions : 0,
    url: typeof record.html_url === "string" ? record.html_url : "",
  };
}

/** The pr-files.json projection (`jq -c '[.[] | {filename,...}] + note'`):
 * `patch` is intentionally dropped — it duplicates the raw diff. Key order
 * matches the jq projection because JSON.stringify preserves insertion
 * order. */
export function filesProjection(files: readonly unknown[], totalChangedFiles: number): string {
  const projected: Array<Record<string, unknown>> = files.map((raw) => {
    const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    return {
      filename: record.filename ?? null,
      status: record.status ?? null,
      additions: record.additions ?? null,
      deletions: record.deletions ?? null,
      changes: record.changes ?? null,
      previous_filename: record.previous_filename ?? null,
    };
  });
  if (totalChangedFiles > 100) {
    projected.push({ note: `file list truncated to first 100 of ${totalChangedFiles} changed files` });
  }
  return JSON.stringify(projected);
}

/** `derive_is_fork_pr` (fail-closed): an unusable PR object conservatively
 * derives a fork. */
export function deriveFork(prObject: unknown): string {
  try {
    return deriveIsFork(prObject) ? "true" : "false";
  } catch {
    return "true";
  }
}

/** `linguist-generated` attribute paths for the diff's chunks (v2
 * prioritize_diff.py): computed only when the raw diff exceeds its budget,
 * via `git check-attr --stdin -z` in the reviewed checkout. */
export async function generatedAttributePaths(workspace: string, diffText: string, budget: number): Promise<ReadonlySet<string>> {
  if (Buffer.byteLength(diffText, "utf8") <= budget) return new Set();
  const [, chunks] = splitChunks(Buffer.from(diffText, "utf8"));
  const paths: string[] = [];
  for (const chunk of chunks) {
    const text = Buffer.from(chunk[0]).toString("utf8");
    if (text !== "") paths.push(text);
  }
  if (paths.length === 0) return new Set();
  try {
    const handle = runProcess({
      file: "git",
      args: ["check-attr", "-z", "linguist-generated", "--", ...paths],
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    const result = await handle.result;
    if (result.status !== "exited" || result.exitCode !== 0) return new Set();
    const fields = result.stdout.toString("utf8").split("\0");
    const generated = new Set<string>();
    for (let index = 0; index + 2 < fields.length; index += 3) {
      if (fields[index + 2] === "set" || fields[index + 2] === "true") generated.add(fields[index]!);
    }
    return generated;
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// context.sh: review threads + human reviews sections
// ---------------------------------------------------------------------------

export async function buildReviewThreadsSection(ws: RunWorkspace, adapter: PlatformReadAdapter, env: StageEnv): Promise<void> {
  ws.write("review-threads.raw.json", "");
  ws.write("review-threads.md", "");
  ws.write("review-threads.json", "");
  ws.write("review-threads-present.txt", "");
  if ((env.REVIEW_THREADS_CONTEXT ?? "true").toLowerCase() !== "true") return;
  let maxBytes = Number(env.REVIEW_THREADS_MAX_BYTES ?? "8000");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 200000) maxBytes = 8000;
  const fetched = await adapter.listReviewThreads();
  if (!fetched.ok) return;
  ws.write("review-threads.raw.json", pyJsonDumps(fetched.data));
  try {
    const threads = prepareThreads(fetched.data);
    const [markdown, rendered] = renderReviewThreads(threads, undefined, maxBytes);
    ws.write("review-threads.md", markdown);
    ws.write("review-threads.json", rendered.length > 0 ? `${pythonJsonStringify(threadEnforcementView(rendered))}\n` : "");
    ws.write("review-threads-present.txt", rendered.length > 0 ? `${rendered.length}\n` : "");
  } catch {
    ws.write("review-threads.md", "");
    ws.write("review-threads.json", "");
    ws.write("review-threads-present.txt", "");
  }
}

export async function buildHumanReviewsSection(ws: RunWorkspace, adapter: PlatformReadAdapter, headSha: string, env: StageEnv): Promise<void> {
  ws.write("human-reviews.raw.json", "");
  ws.write("human-reviews.md", "");
  ws.write("human-reviews.json", "");
  ws.write("human-reviews-present.txt", "");
  if ((env.HUMAN_REVIEWS_CONTEXT ?? "true").toLowerCase() !== "true") return;
  const fetched = await adapter.listPrReviewsPaginated();
  if (!fetched.ok) return;
  ws.write("human-reviews.raw.json", pyJsonDumps(fetched.data));
  try {
    const reviews = prepareReviews(fetched.data);
    const [markdown, rendered] = renderOutstanding(reviews, headSha === "" ? null : headSha);
    ws.write("human-reviews.md", markdown);
    ws.write("human-reviews.json", rendered.length > 0 ? `${pythonJsonStringify(humanEnforcementView(rendered))}\n` : "");
    ws.write("human-reviews-present.txt", rendered.length > 0 ? `${rendered.length}\n` : "");
  } catch {
    ws.write("human-reviews.md", "");
    ws.write("human-reviews.json", "");
    ws.write("human-reviews-present.txt", "");
  }
}

// ---------------------------------------------------------------------------
// enrichment.sh / run_enrichment.py: extraction + linked sources render
// ---------------------------------------------------------------------------

export interface EnrichmentExtraction {
  allUrls: string[];
  urls: string[];
  hints: string[];
  targetVersion: string;
  ghcrImages: string[];
  compareShas: [string, string] | null;
}

export function extractEnrichmentArtifacts(env: StageEnv, ws: RunWorkspace, diffText: string, pr: Record<string, unknown>): EnrichmentExtraction {
  const body = ws.readText("pr-body.txt") ?? "";
  const allUrls = extractUrls(body, diffText);
  const hints = extractVersionHints(diffText);
  const extraction: EnrichmentExtraction = {
    allUrls,
    urls: allUrls.slice(0, 25),
    hints,
    targetVersion: selectTargetVersion(typeof pr.title === "string" ? pr.title : null, hints),
    ghcrImages: extractGhcrImages(hints, diffText),
    compareShas: extractCompareShas(hints),
  };
  ws.write("urls.all.txt", joinLines(allUrls));
  ws.write("urls.txt", joinLines(extraction.urls));
  ws.write("version-hints.txt", joinLines(hints));
  ws.write("version-hints.truncated.txt", joinLines(hints.slice(0, 180)));
  ws.write("ghcr-images.txt", joinLines(extraction.ghcrImages));
  ws.write("compare-shas.txt", extraction.compareShas === null ? "" : `${extraction.compareShas[0]} ${extraction.compareShas[1]}\n`);
  return extraction;
}

/** run_enrichment.py's render: `render_linked_sources` over the resolved
 * extraction, with the SSRF-safe fetch stack behind the default deps. */
export async function renderLinkedSourcesPhase(env: StageEnv, ws: RunWorkspace, extraction: EnrichmentExtraction, now?: () => number): Promise<string> {
  const allowedHosts = parseAllowedHosts(env.ALLOWED_SOURCE_HOSTS ?? "");
  const budget = new BudgetTracker(Number(env.ENRICHMENT_BUDGET_SEC ?? "60") || 60, {
    ...(now !== undefined ? { now } : {}),
  });
  const deps = defaultLinkedSourcesDeps({
    budget,
    githubAuthorization: env.GH_TOKEN ? `token ${env.GH_TOKEN}` : undefined,
    ...(env.FORGEJO_API_URL ? { forgejoApiUrl: env.FORGEJO_API_URL } : {}),
  });
  const input: LinkedSourcesInput = {
    urls: extraction.urls,
    allowedHosts,
    targetVersion: extraction.targetVersion,
    ghcrImages: extraction.ghcrImages,
    compareShas: extraction.compareShas,
    currentRepo: env.GITHUB_REPOSITORY ?? env.REPO ?? null,
    allowedRepos: parseAllowedRepos(env.TOOL_ALLOWED_GH_API_REPOS ?? ""),
  };
  const markdown = await renderLinkedSources(input, deps);
  ws.write("linked-sources.md", markdown);
  return markdown;
}

// ---------------------------------------------------------------------------
// classification.sh forks: image digests, evidence providers
// ---------------------------------------------------------------------------

export async function runImageDigestPhase(ws: RunWorkspace, diffText: string, env: StageEnv): Promise<string> {
  const markdown = await buildImageProvenanceFromNetwork(diffText, env as NodeJS.ProcessEnv);
  ws.write("image-digest-context.md", markdown);
  return markdown;
}

export async function runEvidencePhase(ws: RunWorkspace, env: StageEnv, forkFlag: string, runDir: string, log?: (line: string) => void): Promise<string> {
  const outcome = await runEvidenceProvidersPhase({
    env: env as NodeJS.ProcessEnv,
    cwd: runDir,
    isForkPr: forkFlag,
    enableForForks: env.EVIDENCE_ENABLE_FOR_FORKS ?? "false",
    ...(log !== undefined ? { log } : {}),
  });
  // The phase writes evidence-providers.{md,json} itself (v2 cwd
  // semantics); refresh the bus so the corpus reads this run's values.
  for (const name of ["evidence-providers.md", "evidence-providers.json"]) ws.refresh(name);
  return outcome;
}

// ---------------------------------------------------------------------------
// corpus.sh: related code + PR thread sections
// ---------------------------------------------------------------------------

const RELATED_ARTIFACTS = ["change-anchors.json", "related-code.json", "related-code.md", "related-code.truncated.md"] as const;

/** Builds the related-code artifacts and returns the anchors + related
 * context they came from (the #796 obligation inputs), or null when the
 * section is disabled, errored or empty. */
export async function buildRelatedCodeSection(ws: RunWorkspace, env: StageEnv, workspace: string): Promise<{ anchors: ChangeAnchorsArtifact; related: RelatedContext } | null> {
  for (const name of RELATED_ARTIFACTS) ws.write(name, "");
  if ((env.RELATED_CODE_CONTEXT ?? "true").toLowerCase() !== "true") return null;
  const reset = (): void => {
    for (const name of RELATED_ARTIFACTS) ws.write(name, "");
  };
  try {
    const filesBytes = ws.read("pr-files.json");
    const fileList: readonly unknown[] | null = filesBytes === null ? null : (JSON.parse(Buffer.from(filesBytes).toString("utf8")) as unknown[]);
    const anchors = extractChangeAnchors(ws.readText("pr.diff"), fileList, { sourceRoot: workspace });
    ws.write("change-anchors.json", renderChangeAnchorsJson(anchors));
    const anchorData: unknown = JSON.parse(Buffer.from(renderChangeAnchorsJson(anchors)).toString("utf8"));
    const related = await buildRelatedContext(anchorData, workspace, fileList);
    const artifact = relatedContextToArtifact(related);
    ws.write("related-code.json", pythonJsonStringify(artifact));
    const errors = (artifact as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      reset();
      return null;
    }
    const markdown = renderRelatedContextMarkdown(artifact);
    ws.write("related-code.md", markdown);
    ws.write("related-code.truncated.md", clipRelatedCodeMarkdown(Buffer.from(markdown, "utf8"), Number(env.RELATED_CODE_MAX_BYTES ?? "16000") || 16000) ?? new Uint8Array(0));
    return { anchors: anchorData as ChangeAnchorsArtifact, related };
  } catch {
    reset();
    return null;
  }
}

export async function buildPrThreadSection(ws: RunWorkspace, adapter: PlatformReadAdapter, env: StageEnv): Promise<void> {
  ws.write("pr-thread.json", "");
  ws.write("pr-thread.md", "");
  if ((env.PR_THREAD_CONTEXT ?? "true").toLowerCase() !== "true") return;
  const fetched = await adapter.listPrConversationComments();
  if (!fetched.ok) return;
  ws.write("pr-thread.json", pyJsonDumps(fetched.data));
  try {
    const markdown = renderPrThread(fetched.data, undefined, undefined, Number(env.PR_THREAD_MAX_BYTES ?? "8000") || 8000);
    ws.write("pr-thread.md", markdown);
  } catch {
    ws.write("pr-thread.md", "");
  }
}

// ---------------------------------------------------------------------------
// corpus.sh: build_review_corpus + specialist corpus input
// ---------------------------------------------------------------------------

export function assembleCorpus(
  ws: RunWorkspace,
  env: StageEnv,
  budgets: { primary: TierBudgets; smart: TierBudgets },
  tier: "primary" | "smart",
  slot: "primary" | "smart",
  generatedPaths: ReadonlySet<string>,
  standards: { resolved: string | null; content: Uint8Array | null },
): CorpusBuildResult {
  const standardsContext = prepareStandardsContext(standards.resolved ?? "", standards.content);
  for (const [name, data] of standardsContext) ws.write(name, data);
  const harnessArtifacts = prepareToolHarness(env.TOOL_MODE ?? "off", ws.read("tool-harness.md"), ws.read("tool-harness.json"));
  for (const [name, data] of harnessArtifacts) ws.write(name, data);
  const repoMapCapped = buildBoundedRepoMap(ws.read("repo-map.md"), Number(env.REPO_MAP_MAX_BYTES ?? "12000") || 12000);
  ws.write("repo-map.capped.md", repoMapCapped);

  const ciChecksFile = env.CI_CHECKS_FILE ?? "";
  let ciChecksContent: Uint8Array | null = null;
  if (ciChecksFile !== "") {
    try {
      ciChecksContent = readFileSync(ciChecksFile);
    } catch {
      ciChecksContent = null;
    }
  }
  const tierBudgets = budgets[tier];
  const result = buildReviewCorpus(
    {
      manifestContextMd: ws.read("manifest-context.md"),
      prJson: ws.read("pr.json"),
      classificationJson: ws.read("classification.json"),
      relatedCodeTruncatedMd: ws.read("related-code.truncated.md"),
      repoMapMd: ws.read("repo-map.md"),
      prThreadMd: ws.read("pr-thread.md"),
      reviewThreadsMd: ws.read("review-threads.md"),
      humanReviewsMd: ws.read("human-reviews.md"),
      linkedIssuesMd: ws.read("linked-issues.md"),
      ciChecksContent,
      versionHintsTruncatedTxt: ws.read("version-hints.truncated.txt"),
      toolHarnessMd: ws.read("tool-harness.md"),
      toolHarnessSmartMd: ws.read("tool-harness.smart.md"),
      evidenceProvidersMd: ws.read("evidence-providers.md"),
      imageDigestContextMd: ws.read("image-digest-context.md"),
      linkedSourcesMd: ws.read("linked-sources.md"),
      repoImpactTruncatedMd: ws.read("repo-impact.truncated.md"),
      repoHistoryTruncatedMd: ws.read("repo-history.truncated.md"),
      prDiff: ws.read("pr.diff"),
      prFilesJson: ws.read("pr-files.json"),
      prDiffTruncated: ws.read("pr.diff.truncated"),
      prFilesTruncatedJson: ws.read("pr-files.truncated.json"),
      standardsContextMd: ws.read("standards-context.md"),
      requirementLedgerMd: ws.read("requirement-ledger.md"),
      specialistsMd: ws.read("specialists.md"),
      requirementLedgerPresent: ws.read("requirement-ledger-present.txt"),
      specialistLeadsPresent: ws.read("specialist-leads-present.txt"),
      standardsFileContent: standards.content,
    },
    {
      tier,
      slot,
      maxCorpus: tierBudgets.maxCorpus,
      diffBudget: tierBudgets.maxDiff,
      filesBudget: tierBudgets.maxFiles,
      repoMapMaxBytes: Number(env.REPO_MAP_MAX_BYTES ?? "12000") || 12000,
      standardsFile: standards.resolved ?? "",
      ciChecksFile,
      budgetGuard: tier === "smart" || !!(env.PRIMARY_MODEL_CONTEXT_TOKENS ?? env.MODEL_CONTEXT_TOKENS),
      generatedPaths,
    },
  );
  for (const [name, data] of result.artifacts) ws.write(name, data);
  return result;
}

/** The specialist corpus builder reads the run workspace by the same v2
 * filenames plus the `$CI_CHECKS_FILE` sentinel. */
export function specialistWorkspace(ws: RunWorkspace, ciChecksContent: Uint8Array | null): Record<string, Uint8Array | null> {
  const record: Record<string, Uint8Array | null> = { __ci_checks_file__: ciChecksContent };
  for (const [name, data] of ws.snapshot()) record[name] = data;
  return record;
}

function ciChecksBytes(env: StageEnv): Uint8Array | null {
  const path = env.CI_CHECKS_FILE ?? "";
  if (path === "") return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// corpus.sh tail: the native tool harness
// ---------------------------------------------------------------------------

export function harnessTransportAdapter(env: StageEnv): HarnessTransport {
  return async (baseUrl, apiFormat, payload, apiKey, timeoutSec) => {
    const outcome = await runChatRequest({
      baseUrl,
      apiFormat: apiFormat === "anthropic" ? "anthropic" : "openai",
      payload: {
        endpointPath: apiFormat === "anthropic" ? "/messages" : "/chat/completions",
        body: payload as unknown as TransportWirePayload["body"],
      },
      apiKey,
      anthropicVersion: env.ANTHROPIC_VERSION ?? "2023-06-01",
      requestTimeoutSec: Math.max(1, Math.trunc(timeoutSec)),
      connectTimeoutSec: Number(env.AI_CONNECT_TIMEOUT_SEC ?? "30") || 30,
    });
    if (outcome.status === "failure") throw new Error(outcome.failure.message);
    // A streamed turn's `raw` is the reassembled NormalizedModelResponse, not
    // provider JSON. The loop's tool-call extraction and usage accounting
    // read the OpenAI chat shape (as v2's reassembler produced), so project
    // it; a non-streamed turn's raw provider JSON passes through untouched.
    return outcome.raw === outcome.response ? normalizedToOpenAiChat(outcome.response) : outcome.raw;
  };
}

/** A NormalizedModelResponse in the OpenAI chat-completion shape. */
export function normalizedToOpenAiChat(response: NormalizedModelResponse): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: response.content };
  if (response.toolCalls.length > 0) {
    message.tool_calls = response.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.function.name, arguments: call.function.arguments },
    }));
  }
  const shaped: Record<string, unknown> = {
    id: response.id,
    object: "chat.completion",
    model: response.model,
    choices: [{ index: 0, message, finish_reason: response.finishReason }],
  };
  if (response.usage) {
    shaped.usage = {
      prompt_tokens: response.usage.promptTokens,
      completion_tokens: response.usage.completionTokens,
      total_tokens: response.usage.totalTokens,
    };
  }
  if (response.error) shaped.error = response.error;
  return shaped;
}

export async function runToolHarnessPhase(ws: RunWorkspace, env: StageEnv, runDir: string, log: (line: string) => void): Promise<void> {
  await runToolHarness({
    env,
    cwd: runDir,
    readText: (name) => ws.readText(name),
    exists: (name) => ws.isFile(name),
    writeArtifact: (name, text) => {
      ws.write(name, text);
    },
    deleteArtifact: (name) => ws.remove(name),
    transport: harnessTransportAdapter(env),
    log,
  });
}

// ---------------------------------------------------------------------------
// review.sh tail: outputs
// ---------------------------------------------------------------------------

export function persistOutputs(outputFilePath: string, formatted: string): void {
  if (outputFilePath === "" || outputFilePath === "/dev/null" || formatted === "") return;
  // CodeQL js/http-to-file-access: the formatted assignments carry the
  // review's step outputs (verdict, model-controlled review_markdown behind
  // a random delimiter). $GITHUB_OUTPUT is the sanctioned Actions channel
  // for exactly this data; the random-delimiter heredoc form is what keeps
  // model text from forging additional output keys.
  appendFileSync(outputFilePath, formatted);
}

export { ciChecksBytes };
