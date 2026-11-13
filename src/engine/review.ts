import { V3_CONTRACT } from "../../.v3-generated/contract.generated.js";
import { AI_MAX_TOKENS_DEFAULT, validateContract } from "../config/contract.js";
import { loadConfig, type RawInputs } from "../config/load-config.js";
import { resolveRepositoryConfig } from "../config/repository-config.js";
import { resolveRequirementOwners } from "../config/requirement-owners.js";
import { assertSupportedNode } from "../runtime/node-version.js";
import { createCancellationScope, type CancellationScope } from "../runtime/signals.js";
import { FALLBACK_CORPUS_RETRUNCATION_MAX_BYTES, resolveTierBudgets } from "../corpus/budgets.js";
import { CORPUS_DIFF_SECTION_ARTIFACT, CORPUS_DIFF_SECTION_FALLBACK_ARTIFACT, CORPUS_DIFF_SECTION_SMART_ARTIFACT } from "../corpus/assemble.js";
import { prioritizeDiff } from "../corpus/diff-priority.js";
import { truncateClean } from "../corpus/truncate.js";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { canonicalChangedFile, normalizeLinkedIssues } from "../context/types.js";
import { type BoundedIdList } from "../context/id-lists.js";
import { redactDiffText, redactPrTextDeep, redactPrTextLines, redactText } from "../context/redact.js";
import { pythonJsonStringify } from "../precheck/metadata.js";
import { buildHarnessObligations } from "../requirements/obligations.js";
import { externalChecksConclusion } from "../precheck/decide.js";
import { readStandardsFileAtRef, StandardsFileRefError } from "../context/standards-file-ref.js";
import { discoverRepositorySkills, readRepositorySkill, renderExplicitSkill, renderSkillCatalog, repositorySkillsAllowed } from "../context/repository-skills.js";
import { loopContextLimits, resolveLoopLimits, VERDICT_WALL_CLOCK_RESERVE_MIN_SEC, type HarnessDeps } from "../tools/harness.js";
import { harnessGatheredNoEvidence } from "../tools/execution-counts.js";
import { DEFAULT_STANDARDS_FILE_CANDIDATES } from "../context/standards-file.js";
import { runChatRequest } from "../transport/transport.js";
import {
  describeTransportFailure,
  endpointUrlCredentialOrEmpty,
  redactEndpointUrlCredential,
} from "../transport/http.js";
import { callKnownSecrets, extraHeadersForEnv } from "../transport/headers.js";
import type { TerminalProviderReason } from "../transport/terminal.js";
import { withCancellationSignal, type FetchLike } from "../platform/http.js";
import { normalizePrIdentity } from "../platform/pr.js";
import type { PlatformReadAdapter } from "../platform/types.js";
import { buildPlatformReadAdapter } from "../run/platform.js";
import type { ReviewDependencies, ReviewRequest } from "./types.js";
import { runEngineAdmission, admissionStageEnv } from "./admission.js";
import type { PrecheckOutput } from "../precheck/decide.js";
import { buildStageEnv, validateStageEnv, type RunContext, type StageEnv } from "../run/env.js";
import { RunWorkspace } from "../run/workspace.js";
import { trustFramingOverhead } from "../context/repo-map.js";
import { generateRepoMap, renderRepoMapJson, renderRepoMapMarkdown } from "../context/repo-map.js";
import { buildDependencyCoverageContext } from "../context/dependency-coverage.js";
import { buildReReviewScopeMd, computeReReviewDelta, type ReReviewScopeDelta } from "../context/rereview-scope.js";
import { buildReReviewEvidenceMd, computeReReviewEvidencePlan, renderReReviewEvidenceJson } from "../context/rereview-evidence.js";
import { renderDependencyCoverageBlock } from "../model/dependency-coverage.js";
import {
  buildLinkedIssueContext,
  buildManifestContext,
  buildRepoImpactHistory,
} from "../context/index.js";
import { extractRequirementLedger, ledgerToArtifact, renderRequirementLedgerMarkdown } from "../requirements/ledger.js";
import { requirementLedgerPresence } from "../requirements/presence.js";
import { buildTracePlan, TRACE_PLAN_ARTIFACT } from "../requirements/trace-plan.js";
import { classifyPr, classificationToArtifact, DEPENDENCY_UPDATE_KINDS } from "../classification/classify.js";
import { resolveReviewRoute, resolveTierProfiles, resolveConfidenceProfile, tierRequestShape, anthropicEffortInactiveWarning, anthropicJsonObjectsPromptOnlyWarning, anthropicStructuredOutputInactiveWarning, effectiveWireEffort, effectiveWireResponseFormat, type TierProfiles } from "../routing/tiers.js";
import { reviewerRequestedEscalation } from "../routing/escalation.js";
import { buildSpecialistCorpus } from "../specialists/corpus.js";
import { forkGate, type ForkedGate, type GateName, type GateOutcome } from "../gates/gates.js";
import { ciGateBranch } from "../gates/workloads.js";
import { runSpecialistsGate } from "../gates/specialists-gate.js";
import { specialistRequestFn } from "../gates/specialist-transport.js";
import { runClaimFalsificationPass } from "../claims/pass.js";
import { renderClaimsSection } from "../claims/render.js";
import { runDerivedObligationsPass } from "../derived/pass.js";
import { renderDerivedSectionForStatus, renderDerivedUnavailable } from "../derived/render.js";
import { buildModelRequest } from "../model/request.js";
import { callModelTier, governedScorerTransport, type TierProfile } from "../model/call.js";
import {
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  GOVERNOR_PRIORITY_AUTHORITATIVE,
  GOVERNOR_PRIORITY_RECOVERY,
  GOVERNOR_PRIORITY_REQUIRED_PREPASS,
  MAX_CONFIGURABLE_CONCURRENCY,
  RUN_INFERENCE_CAP_ENV,
  configureSharedRunInferenceGovernor,
  drainSharedRunInferenceGovernor,
  inferenceGovernorFromEnv,
  parseRunInferenceCap,
  renderRunInferenceTelemetryLine,
  sharedRunInferenceGovernor,
} from "../model/governor.js";
import { formatResponseDiagnosticsLine } from "../model/response-diagnostics.js";
import { maskDiagnostic, maskKnownSecrets, redactTextDeep } from "../context/redact.js";
import { parseVerdictResponse } from "../model/verdict.js";
import { resolveReviewTriageDecision } from "../model/triage.js";
import type { RequiredCheckDispositionReceipt, ReviewTriageDecision } from "../model/types.js";
import { resolveReviewerRouting } from "../config/reviewer-routing.js";
import { resolveHumanReviewRouting, type HumanReviewRoutingMode, type HumanReviewRoutingPlan } from "../routing/human-review-routing.js";
import { buildConfidencePrompt, unresolvedConfidencePins } from "../confidence/prompt.js";
import { runConfidenceScorer } from "../confidence/scorer.js";
import { confidenceTelemetryOf, confidenceUsageWireShape, validConfidenceUsageTelemetry, type ConfidenceTelemetry, type ConfidenceUsageTelemetry } from "../confidence/telemetry.js";
import { boundConfidenceField, boundConfidenceReason, CONFIDENCE_DISABLED, CONFIDENCE_RUBRIC_VERSION, confidenceCapNote, confidenceOutputFields, confidenceReasonWithoutCapNote, maskComposedConfidenceReason, MAX_CONFIDENCE_CONCERN_EVIDENCE_CHARS, MAX_CONFIDENCE_CONCERN_FILE_CHARS, unscoredConfidenceResult, type ConfidenceResult } from "../confidence/result.js";
import { annotateAnalysisEngine, analysisEngineBase, buildUserMessage, handleModelFailure, MODEL_UNAVAILABLE_ENGINE, applySystemPromptFragments, applySpecialistLeadsFragment, applySupersededDiscussionFragment, applyRequirementTraceFragment, applyReviewTriageFragment, resolveSystemPrompt, workspaceAt, type PromptWorkspace } from "../prompt/index.js";
import { reviewArtifactFromParsed, type ArtifactFinding } from "../enforcement/artifact.js";
import { applyStrictVerdictPolicy, applyVerdictPolicy, relaxCiOnlyVerdict, relaxUnverifiedBlockerVerdict, relaxVerificationOnlyVerdict } from "../enforcement/verdict-policy.js";
import { applyBlockerVerification } from "../enforcement/blocker-verification.js";
import { createActionSourceReader } from "../enforcement/action-source.js";
import { createPinnedActionWitness, resolvePinnedActionRevision } from "../enforcement/pinned-action-source.js";
import { createHeadSourceReader } from "../enforcement/source-verifier.js";
import { readWorkflowInputNamesByFile, resolveActionSlug } from "../enforcement/workflow-inputs.js";
import { capCiEvidenceFindings } from "../enforcement/ci-evidence.js";
import { applyNegativeEvidenceToRecord, negativeEvidenceRulesFromArtifact } from "../enforcement/negative-evidence.js";
import { EVIDENCE_NEGATIVE_EVIDENCE_FILE } from "../evidence/negative-evidence.js";
import { markerReviewResult, publishStepRuns } from "../publish/publish.js";
import type { PartialCoverage } from "../tools/coverage.js";
import { applyRequiredCheckValidation, unresolvedRequiredCheckIds } from "../enforcement/completeness.js";
import { parseHeadBoundCiEvidence, reconcileObligationsWithCiEvidence, type HeadBoundCiEvidence } from "../enforcement/required-check-ci.js";
import { applyAllEnforcement, failClosedEnforcementFired, reconcileEnforcedReviewMarkdown, type EnforcementInputs } from "../enforcement/enforce.js";
import { blockingReviewObligations, candidateRowsToObligations, deriveUnresolvedCause, dispositionReceiptFromArtifact, foldObligationDispositions, isForcingObligation, mustCheckObligationsEnabled, reviewObligationsToArtifact, riskEvidenceReadPaths, unresolvedReviewObligations, type ReviewObligation } from "../enforcement/review-obligations.js";
import { derivedCoverageRow, derivedObligationStateReason, resolveDerivedObligations, type DerivedObligationResolution } from "../enforcement/derived-obligations.js";
import { riskCoverageRow, resolveRiskObligations } from "../enforcement/risk-obligations.js";
import { scanRiskObligations } from "../risk/classify.js";
import { DEFAULT_RISK_SECTION_MAX_BYTES } from "../risk/types.js";
import { renderRiskUnavailable, riskCorpusSection } from "../risk/render.js";
import { executedCallEvidenceIndex, type ExecutedCallEvidenceIndex } from "../enforcement/executed-calls.js";
import { normalizeRequirementCoverage } from "../enforcement/requirement-coverage.js";
import { applyRequirementTraceEnforcement, changedSubjectText, distributedRequirementHints, distributedRequirementWarnings, finalTraceFailureLog, parseChangedFileLines, requirementTraceScope, unresolvedTraceRequirementIds, type ChangedFileLines } from "../enforcement/requirement-trace.js";
import { pyJsonDumps } from "../evidence/pyjson.js";
import { buildRunMetadataMarker } from "../metadata/markers.js";
import { ACTION_VERSION } from "../version.js";
import {
  buildCacheHitRatioOutput,
  buildToolCallsOutput,
  formatOutputAssignment,
  formatReviewStepOutputs,
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
  buildSyntaxContextSection,
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
} from "../run/stages.js";
import { writeStepSummary } from "../run/summary.js";
import type { ReadResult } from "../platform/types.js";

/**
 * The action-independent v3 review engine (#726, #809): the typed successor
 * of `scripts/run_review.sh`. Stage order, artifact names and decision points
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

/** #1541: the merge-gating id set of an enforcement pass that never ran — no
 * ids, and no count either (the count is a count of ids, and there are
 * none). The publishers turn this into an empty list and a zero count. A
 * fresh object per call: the two lists never share an array instance. */
function emptyMergeGatingIds(): BoundedIdList {
  return { ids: [], total: 0 };
}

export interface RunReviewResult {
  outputs: ReviewStepOutputs;
  /** The resolved artifact directory this run wrote to (#838 follow-up): the
   * caller's own `runDir`/`PR_REVIEWER_RUN_DIR` when given, else the fresh
   * private temp directory the default created — also logged once (`run
   * artifacts: <path>`) and written to the configured output sink as `run-dir`. */
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
  /** #1449: the run's derived-obligation state ("complete" | "unresolved" |
   * "unavailable"), present ONLY when the derived-obligation feature is
   * enabled — a disabled run has no state at all and keeps its pre-#1449
   * published bytes exactly. The publish step carries it into the PUBLISHED
   * metadata marker, so a reader of the review (not only of the run's own
   * artifacts) can tell that a trusted approve was withheld because a
   * derived architectural obligation stayed undischarged. */
  derivedObligationState?: DerivedObligationState;
  /** #1505: the run's required-evidence state ("complete" | "unresolved"),
   * present ONLY when the review-owned required-evidence contract was
   * active — an inactive run has no state at all and keeps its pre-#1505
   * published bytes exactly. The publish step carries it into the marker
   * and the approval guardrail: unresolved required evidence reads
   * `partial` and withholds the native APPROVE (COMMENT), never a
   * manufactured blocking request. */
  requiredEvidenceState?: RequiredEvidenceState;
  /** #847: the #810/#702 tool-loop budget the marker recorded (mirrors the
   * harness's `tool_request_budget` for the route the marker was built
   * from); undefined when no tool harness ran. */
  toolBudget?: number;
  /** #847: which source won ("primary-override" | "smart-override" |
   * "explicit" | "tier-default" | "size-scaled"). */
  toolBudgetSource?: string;
  /** #847; #1597: tool calls the loop actually EXECUTED against that budget
   * (attempted executions; the ok-only subset is `toolCallsSuccessful`). */
  toolCallsUsed?: number;
  /** #1597: the remaining execution partitions from the same snapshot:
   * everything the model issued, the successful subset, and the refused and
   * deduplicated non-executed dispositions. Undefined when the harness
   * artifact predates #1597 or never ran. */
  toolCallsIssued?: number;
  toolCallsSuccessful?: number;
  toolCallsRefused?: number;
  toolCallsDeduplicated?: number;
  /** #895: rounds the loop actually used, and the resolved round cap it ran
   * against (see `adaptiveLoopBudgets` in src/tools/loop.ts). */
  toolRoundsUsed?: number;
  toolMaxRounds?: number;
  /** #922: the loop's conversation budget and peak (approx tokens). */
  contextBudget?: number;
  contextPeak?: number;
  /** #847: measurement follow-up: the tool loop's stop reason for the route
   * the marker was built from; undefined when no harness reported one. */
  toolStopReason?: string;
  /** #1073: the scorer's bounded advisory concerns, present only when the
   * scorer produced a scored answer; the publish step renders them as
   * advisory bullets. */
  confidenceConcerns?: Array<{ file: string; line: number | null; evidence: string }>;
  /** #1518: the requirement ids the deterministic enforcement pass could not
   * discharge (unmet or unverifiable). These are the merge-gating ids of
   * the enforcement pass, not model claims. */
  unresolvedRequirementIds?: string[];
  /** #1541: the number of DISTINCT requirement ids the enforcement pass
   * produced BEFORE the shared id cap shortened the list. The publishers
   * carry it so a consumer can tell that the cap dropped ids. */
  unresolvedRequirementIdsSourceTotal?: number;
  /** #1518: the required-check ids the deterministic enforcement pass could
   * not resolve. These are the merge-gating ids of the enforcement pass, not
   * model claims. */
  unresolvedRequiredChecks?: string[];
  /** #1521: the review-obligation rows that BLOCKED this review — the
   * deterministic enforcement pass's own rows (never model claims). A row is
   * present iff it is forcing per #1505: a review-owned
   * (`must_check`, `trusted_base_guidance`) row with status `unmet`.
   * An `unresolved` row is an availability failure (coverage, never a
   * defect) and a `derived` row is coverage, so neither rides here. The published handoff and the local
   * bundle name these rows so a controller sees WHAT blocked the review, not
   * only an opaque id. */
  unresolvedReviewObligations?: ReviewObligation[];
  /** #1541: the same honest count for the required-check ids. */
  unresolvedRequiredChecksSourceTotal?: number;
  /** #1455: the verifier's own telemetry — the unscored cause, the measured
   * latency and the provider's token counts. The publish step carries it
   * into the metadata marker; it is advisory and changes nothing else. */
  confidenceTelemetry?: ConfidenceTelemetry;
  /** Wall-clock seconds for the whole run. */
  durationSec: number;
  /** #726: the engine-owned admission decision — present on BOTH the skip
   * and the review path. `shouldReview` is the authoritative "did any review
   * stage run" signal; on the skip path the verdict fields on `outputs` are
   * neutral and the carried decision lives in `admission`. */
  shouldReview: boolean;
  /** #726: admission's skip reason ("" on the review path). */
  skipReason: string;
  /** #726: admission's BROAD_FINGERPRINT source (the publish env's
   * `BROAD_FINGERPRINT` value; "" when admission could not fingerprint). */
  diffFingerprint: string;
  /** #726: admission's resolved base SHA — the publish env's `BASE_SHA` and
   * (when the request left `baseRef` empty) the repository-config source. */
  admissionBaseSha: string;
  /** #726: the verified reviewed head — the explicit pin when present, else
   * the event head or admission's resolved head; publish env's HEAD_SHA. */
  reviewedHeadSha: string;
  /** #726: the final resolved cross-repository PR flag ('true'/'false'/'' unknown)
   * the review stages ran with; publish env's IS_FORK_PR. */
  isForkPr: string;
  /** #726: the full admission surface (carried verdict/verdict-source/
   * review-result/incomplete-reason/degraded-gate-bypass on a diff-unchanged
   * skip, resolved platform, fork flag, carried head SHA). */
  admission: PrecheckOutput;
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

/** #1426: the commit-sha shape a prior reviewed head must prove before it
 * becomes a delta identity (the same rule the #975 carried pointer applies
 * to marker head_sha — untrusted comment content until shape-checked). */
const SHA_SHAPE = /^[0-9a-f]{7,64}$/i;

/** #978: the annotation is a workflow-command line, so untrusted provider
 * body text must not be able to break out of it — a newline would emit a
 * second line GitHub parses as its own command, and `::` reads as a command
 * separator. Control characters collapse to spaces; `::` is split. */
function annotationSafe(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/::/g, ": :").trim();
}

/** #1594: the whitelist filter over the gate-output file's RAW text — the
 * engine reads the raw file once and derives both the published action
 * outputs and the `ci_checks_evidence` line from that single read. */
function ciGateOutputsFromText(text: string): string {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^(ci_status_final|ci_status_skipped)=([A-Za-z_-]*)$/.exec(line.trim());
    if (match) values.set(match[1]!.replaceAll("_", "-"), match[2]!);
  }
  return [...values].map(([key, value]) => `${key}=${value}\n`).join("");
}

/** The CI gate's `ci_status_final` / `ci_status_skipped` step outputs as the
 * contract's kebab-case output assignments. */
export function ciGateOutputs(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  return ciGateOutputsFromText(text);
}

/** Set on every gate child; a process carrying it never starts a review. */
export const GATE_CHILD_ENV = "PR_REVIEWER_GATE_CHILD";

/** Cancellation ownership for one run (#726 review). The typed scope the
 * pipeline is bound to, the checkpoints that make an aborted run
 * un-completable, and the owned gate forks the cancellation path finalizes.
 * Lives beside the engine so no caller has to re-implement any of it. */
interface RunCancellation {
  /** Wired into `forkGate`, which terminates both active gate trees. */
  readonly scope: CancellationScope;
  /** Rejects as soon as the caller's signal aborts (the explicit race). */
  readonly cancelled: Promise<never>;
  /** The only way an aborted run leaves the pipeline: throws. */
  checkpoint(): void;
  /** Claim a gate fork's launch BEFORE awaiting it: the pending launch is
   * registered synchronously, so a cancellation landing while the launch
   * suspends (the preflight/launch probes inside `forkGate`) is still
   * drained by `finalize()` — the fork is cut and its termination awaited
   * once the launch lands. Resolves with the fork for the caller. */
  claimFork<T extends ForkedGate>(launch: Promise<T>): Promise<T>;
  /** Stop tracking a fork this run has already joined. */
  release(fork: ForkedGate): void;
  /** Abort every still-outstanding owned fork. Idempotent. */
  finalize(): Promise<void>;
  /** Detach from the caller's signal (a long-lived worker signal must not
   * retain a completed run). */
  dispose(): void;
}

/** #726 review: mid-run cancellation. The engine aborts only its own scope —
 * the run must also STOP, and must never report a verdict the caller already
 * cancelled. Three cooperating surfaces, no caller-visible partial success:
 * - `cancelled` is raced against the pipeline, so the run stops being awaited
 *   the moment the caller's signal aborts;
 * - `checkpoint()` throws at every main stage boundary, so the abandoned
 *   pipeline terminates at the next boundary instead of finishing (and
 *   instead of an in-flight model verdict reaching the fallback, escalation
 *   or enforcement stages);
 * - `finalize()` aborts the gate forks this run owns — including forks whose
 *   launch is still in flight (`claimFork` registers it before the await) —
 *   awaited BEFORE the rejection is observable, so no gate child outlives a
 *   cancelled run.
 * `dispose()` removes the caller's abort listener on both exit paths.
 *
 * Exported for the cancellation-contract tests (#1183): the launch-suspension
 * seam for the process path is a controlled launch handed to `claimFork`.
 */
export function createRunCancellation(request: ReviewRequest): RunCancellation {
  const scope = createCancellationScope();
  const forks = new Set<ForkedGate>();
  const cuttings = new Set<Promise<void>>();
  const pendingLaunches = new Set<Promise<void>>();
  const detail = request.triggerReason === "" ? "" : ` (${request.triggerReason})`;
  const scopeReason = `request cancelled${detail}`;
  const message = `review request cancelled${detail}`;
  let rejectCancelled!: (error: RunReviewError) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
  // The run usually wins the race; a rejection nobody awaits would otherwise
  // surface as an unhandled rejection.
  void cancelled.catch(() => {});
  const onAbort = (): void => {
    // Owned gate children first, then the rejection: the gates learn about
    // the cancellation synchronously, the caller hears about it next.
    scope.abort(scopeReason);
    rejectCancelled(new RunReviewError(message, 1));
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const forget = async (fork: ForkedGate): Promise<void> => {
    try {
      await fork.abort();
    } catch {
      // A gate whose own abort failed is already gone or unlaunchable; the
      // cancellation rejection must not be replaced by its cleanup error.
    }
  };
  return {
    scope,
    cancelled,
    checkpoint(): void {
      if (scope.signal.aborted) throw new RunReviewError(message, 1);
    },
    claimFork<T extends ForkedGate>(launch: Promise<T>): Promise<T> {
      // The claim registers the launch synchronously, BEFORE the caller
      // awaits it, so a cancellation landing while the launch suspends
      // (the preflight/launch probes inside forkGate) is still drained by
      // finalize() — the window the old own()-after-await left open (#1183).
      // When the launch lands: into a live scope the fork is owned like
      // before; into an aborted scope it is never tracked as a fork nobody
      // will finalize but cut instead, and the cut is registered so
      // finalize() awaits its termination too.
      const landed = launch.then((fork) => {
        if (scope.signal.aborted) {
          const cutting = forget(fork);
          cuttings.add(cutting);
          void cutting.then(() => { cuttings.delete(cutting); });
          return cutting.then(() => fork);
        }
        forks.add(fork);
        return fork;
      });
      // finalize() drains the claim until the launch has landed AND either
      // the fork is tracked or its cut has completed; a rejected launch
      // (GateLaunchError) has no child to await and drains immediately.
      const tracked: Promise<void> = landed.then(
        () => undefined,
        () => undefined,
      );
      pendingLaunches.add(tracked);
      void tracked.then(() => { pendingLaunches.delete(tracked); });
      return landed;
    },
    release(fork: ForkedGate): void {
      forks.delete(fork);
    },
    async finalize(): Promise<void> {
      // Drain until a full pass finds nothing: a fork whose launch was still
      // in flight when the cancellation landed can register while an earlier
      // drain is awaiting, and the rejection becomes observable only once
      // every owned child is actually gone. The pre-await claim (#1183)
      // closes the window this used to state as a residual: the pending
      // launch itself keeps this drain alive from the claim, through the
      // launch landing, to the end of the landed fork's termination — no
      // owned child can slip past a final empty pass un-awaited.
      for (;;) {
        const gates = [...forks];
        const cuts = [...cuttings];
        const launches = [...pendingLaunches];
        forks.clear();
        cuttings.clear();
        pendingLaunches.clear();
        if (gates.length === 0 && cuts.length === 0 && launches.length === 0) return;
        await Promise.all([...gates.map(forget), ...cuts, ...launches]);
      }
    },
    dispose(): void {
      request.signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** The action-independent v3 review engine (#726): one engine for the Action
 * adapter, the `run` CLI and any future self-hosted worker (#725). Canonical
 * intent/state arrives as `ReviewRequest`, external capabilities as
 * `ReviewDependencies` — see docs/architecture/engine-boundary.md.
 *
 * A cancelled run never resolves with a result: an abort at ANY point before
 * completion throws `RunReviewError`, so a verdict reached after the caller
 * cancelled cannot reach a later publisher. Nothing about this changes when
 * `request.signal` is absent (the Action adapter path). */
/** #1238: fold a second boundary pass (run after thread settlement
 * re-emitted prior findings) into the recorded verification result so the
 * artifact and the demotion note reflect every pass. Findings the first
 * pass processed are skipped inside the boundary itself, so the second
 * pass only reports newly settled findings. */
/**
 * Fold the run's review-owned required-evidence obligations (#1381).
 *
 * Rows come VERBATIM from the harness-authored candidates artifact (exactly
 * what the model was shown), never re-derived here — identity drift between
 * the harness and engine layers would make exact-text dispositions unmatched
 * and permanently block. Absent candidates (fork/skipped-harness paths) fall
 * back to must_check-only rows with harness-compatible ids. The derived
 * unresolved cause is stamped ONLY on rows whose folded status is
 * `unresolved` (#1381: an `unmet` row was resolved negatively — the check
 * was performed and failed — so it carries no evidence-gathering cause; a
 * `satisfied` row carries none either). The telemetry names every
 * not-clean row regardless of which side of that line it fell on.
 * `VALIDATE_REQUIRED_CHECKS=false` removes must_check rows from the contract
 * at both layers (harness presentation and engine enforcement), so an
 * operator who disabled #750 validation does not get #1381 forcing instead.
 *
 * #1449: the #1448 derived pre-pass output joins the SAME contract — the
 * derived rows are appended BEFORE the dispositions are folded, so one fold
 * covers every source. The derived rows are the engine's own (the pre-pass
 * output is not harness-authored), and they are built by the pure resolver in
 * `src/enforcement/derived-obligations.ts` from the artifact the pre-pass
 * wrote. When the derived coverage is incomplete, exactly ONE synthetic
 * coverage-marker row is added: it states that coverage is unavailable and
 * why, it is never a defect claim, and it carries the `derivation-incomplete`
 * cause (never the harness cause).
 */
function resolveReviewObligations(
  classification: Record<string, unknown>,
  review: Record<string, unknown>,
  ws: RunWorkspace,
  harnessArtifactName: string,
  validateRequiredChecks: string | undefined,
  derivedEnabled: boolean,
  ciEvidence: HeadBoundCiEvidence | null,
  reviewedHeadSha: string,
  riskEnabled: boolean,
): { obligations: ReviewObligation[]; derived: DerivedObligationResolution; contractActive: boolean; dispositionReceipt: RequiredCheckDispositionReceipt | null; executedCalls: ExecutedCallEvidenceIndex } {
  const candidates = safeJson(ws.read("review-obligations-candidates.json")) as { injected?: unknown; obligations?: unknown } | null;
  const includeMustCheck = mustCheckObligationsEnabled(validateRequiredChecks);
  const candidateRows = (candidates?.injected === true && Array.isArray(candidates.obligations)
    ? candidates.obligations as unknown[]
    : []).filter((row) => includeMustCheck || (row as { source?: unknown } | null)?.source !== "must_check");
  const obligations = candidateRowsToObligations(candidateRows, includeMustCheck ? stringList(classification.must_check) : []);
  // #1449: the derived rows join the contract before the fold. The feature
  // gate is the operator-only `derived-obligations` input — off means no
  // rows, no coverage claim, and byte-identical behavior.
  const derived = resolveDerivedObligations(safeJson(ws.read("derived-obligations.json")), derivedEnabled);
  const derivedRows: ReviewObligation[] = derived.rows.map((row) => ({
    id: row.id,
    source: "derived",
    text: row.text,
    status: "unresolved",
    cause: null,
    // #1627: a pre-fold row has matched no disposition yet; the fold
    // assigns the final reason on every path.
    reason: "no-disposition",
    anchors: row.anchors,
  }));
  if (derived.coverage === "incomplete") {
    const coverageRow = derivedCoverageRow(derived);
    if (coverageRow !== null) {
      derivedRows.push({
        id: coverageRow.id,
        source: "derived",
        text: coverageRow.text,
        status: "unresolved",
        cause: coverageRow.cause,
        // #1627: the marker's reason restates its own pre-set cause.
        reason: "derivation-incomplete",
      });
    }
  }
  // #1577: the deterministic risk-evidence rows join the SAME contract
  // before the fold, with the #1449 coverage semantics: an undischargeable
  // scan-coverage marker on incomplete scan coverage, and rows the fold can
  // close only with a rationale that names a flagged path.
  const risk = resolveRiskObligations(safeJson(ws.read("risk-obligations.json")), riskEnabled);
  const riskRows: ReviewObligation[] = risk.rows.map((row) => ({
    id: row.id,
    source: "risk",
    text: row.text,
    status: "unresolved",
    cause: null,
    anchors: row.anchors,
  }));
  if (risk.coverage === "incomplete") {
    const coverageRow = riskCoverageRow(risk);
    if (coverageRow !== null) {
      riskRows.push({
        id: coverageRow.id,
        source: "risk",
        text: coverageRow.text,
        status: "unresolved",
        cause: coverageRow.cause,
      });
    }
  }
  const dispositions = Array.isArray(review.required_check_dispositions)
    ? review.required_check_dispositions as Array<{ check: string; status: string; rationale?: string | null }>
    : null;
  // #1577 (review fix): the risk discharge must be backed by the run's OWN
  // evidence receipt — deterministic records, never model output. Two
  // sources, both records the run already wrote: the harness result's
  // executed-call log (a successful read of the path) and the
  // assembler-certified corpus-diff payload (#921's byte-exact rule — the
  // path's complete head diff rode the review corpus, so the actual changed
  // lines were in the reviewer's context). The candidate set feeds only the
  // credit lookup: a path with no chunk in the raw diff earns nothing, so
  // widening it with the dispositions' cited paths can never credit a path
  // the run did not actually carry.
  // #1627: the disposition parser's drop receipt rides the review artifact
  // (`ai-output.json`) and joins the fold's own disclosure — the drops are
  // unattributable by definition, so they are never per-row reasons.
  const dispositionReceipt = dispositionReceiptFromArtifact(review.required_check_disposition_receipt);
  // #1627: the executed-call evidence index — derived STRICTLY from the
  // enforcement harness artifact's `tool_calls` trace (the executed-call
  // records the native loop already persists in execution order; the same
  // surface `verdictHarnessFindingsBody` renders from). The gate is INERT
  // only when the artifact is absent (fresh standard-call and fork paths)
  // or carries no executed calls; a PRESENT-but-malformed trace REFUSES the
  // index, which keeps the gate active with nothing citable (#1634 review).
  const harness = safeJson(ws.read(harnessArtifactName)) as { stop_reason?: unknown; planning_error?: unknown; error?: unknown; successful_request_count?: unknown; tool_calls?: unknown } | null;
  const executedCalls = executedCallEvidenceIndex(harness?.tool_calls);
  const riskAnchorPaths = new Set<string>();
  for (const row of riskRows) {
    for (const anchor of row.anchors ?? []) {
      const separator = anchor.lastIndexOf(":");
      for (const part of separator === -1 ? [anchor] : [anchor, anchor.slice(0, separator)]) {
        const normalized = part.trim().replace(/^\.\//, "").replace(/\/+$/, "");
        if (normalized !== "") riskAnchorPaths.add(normalized);
      }
    }
  }
  const candidatePaths = [...riskAnchorPaths];
  for (const entry of dispositions ?? []) {
    if (entry === null || typeof entry !== "object" || typeof entry.rationale !== "string") continue;
    for (const token of entry.rationale.match(/[A-Za-z0-9_./\\:-]+/g) ?? []) {
      const normalized = (token.split(":")[0] ?? "").trim().replace(/^\.\//, "").replace(/\/+$/, "");
      if (normalized !== "") candidatePaths.push(normalized);
    }
  }
  const readPaths = riskEvidenceReadPaths({
    harness,
    rawDiff: ws.readText("pr.diff"),
    certifiedDiffPayloads: [
      ws.readText(CORPUS_DIFF_SECTION_ARTIFACT),
      ws.readText(CORPUS_DIFF_SECTION_SMART_ARTIFACT),
      ws.readText(CORPUS_DIFF_SECTION_FALLBACK_ARTIFACT),
    ].filter((payload): payload is string => payload !== null && payload !== ""),
    candidatePaths,
  });
  const folded = foldObligationDispositions([...obligations, ...derivedRows, ...riskRows], dispositions, executedCalls, { readPaths });
  const cause = deriveUnresolvedCause({
    stopReason: typeof harness?.stop_reason === "string" ? harness.stop_reason : null,
    harnessError: harness?.error != null ? String(harness.error) : null,
    planningError: harness?.planning_error != null ? String(harness.planning_error) : null,
    // #1597: the cause predicate asks "did the investigation produce ANY
    // usable evidence" — the ok-status count, historically carried under
    // the executed-only name. Read the truthfully-named field; the
    // executed count now includes failed attempts and would mask a
    // all-calls-errored run.
    // #1606: this consumer keeps the EVIDENCE meaning (calls that
    // succeeded) — a run whose every call failed gathered no evidence and
    // must read as such. The tool-failure ENFORCEMENT reads the other
    // count (calls attempted) for its own question; the two consumers read
    // the counters through ONE shared reader
    // (`src/tools/execution-counts.ts`), so they cannot drift apart.
    degraded: harnessGatheredNoEvidence(harness),
  });
  // Only an `unresolved` row carries the evidence-gathering cause; a
  // `satisfied` row was resolved positively and an `unmet` row negatively.
  // #1449: a row that already carries its own cause (the synthetic derived
  // coverage marker) keeps it — the harness cause never describes a
  // derivation that never ran.
  // #1594: the CI-evidence reconciliation runs AFTER cause annotation so
  // every downstream consumer (persistReviewObligations, the required-
  // evidence state, the enforcement gate, and the strict mapping) reads the
  // reconciled rows: a head-bound green test-execution check discharges an
  // unresolved test-run ask with `resolvedBy` provenance; a head-bound
  // failed one contradicts a model-claimed satisfaction. Derived rows never
  // reconcile, and an `unmet` (forcing) row is never argued away.
  const annotated = folded.map((obligation) => (
    obligation.status === "unresolved" ? { ...obligation, cause: obligation.cause ?? cause } : obligation
  ));
  return {
    obligations: reconcileObligationsWithCiEvidence(annotated, ciEvidence, reviewedHeadSha),
    derived,
    // #1577: the risk rows already ride `obligations` and the
    // required-evidence state; the scan's own coverage answer needs no
    // separate field on the result.
    // #1627: the parser's drop receipt, re-recorded on the fold artifact
    // and in the log line (null when the parser reported nothing).
    dispositionReceipt,
    // #1627: the executed-call evidence index the fold was given, so the
    // #750 completeness fold (applied later, over the same artifact) can
    // gate the very same satisfied answers — the two folds agree.
    executedCalls,
    // #1505: whether the review-owned required-evidence contract was ACTIVE
    // this run (the must_check checklist enabled, or trusted-base rows were
    // injected). The required-evidence state and its publish sentinel exist
    // only for an active contract — an inactive run keeps its bytes
    // exactly. #1577: an enabled risk-obligation scan activates the
    // contract too, so the withhold cannot be opted out of implicitly.
    contractActive: includeMustCheck || candidates?.injected === true || risk.enabled,
  };
}

function persistReviewObligations(
  ws: RunWorkspace,
  obligations: ReviewObligation[],
  dispositionReceipt: RequiredCheckDispositionReceipt | null,
  log: (line: string) => void,
): void {
  if (obligations.length === 0) return;
  ws.write("review-obligations.json", pyJsonDumps(reviewObligationsToArtifact(obligations, dispositionReceipt)));
  const unmet = obligations.filter((item) => item.status === "unmet");
  const unresolved = obligations.filter((item) => item.status === "unresolved");
  const satisfied = obligations.length - unmet.length - unresolved.length;
  // #1627: the reason summary replaces the per-id detail — the ids are
  // persisted in review-obligations.json, and the log only needs the
  // content-free counts of WHY rows stayed unresolved. Bounded by the
  // closed reason vocabulary; a pre-#1627 row without a reason reads as
  // `unknown`.
  const reasonCounts = new Map<string, number>();
  for (const item of unresolved) {
    const reason = item.reason ?? "unknown";
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const reasonDetail = unresolved.length > 0
    ? ` (${[...reasonCounts.entries()].map(([reason, count]) => `${reason}=${count}`).join(", ")})`
    : "";
  // #1449: the derived counts ride the same line, and only when derived rows
  // exist — a run without them keeps the #1381 line byte-for-byte.
  const derived = obligations.filter((item) => item.source === "derived");
  const derivedDetail = derived.length > 0
    ? ` | derived: ${derived.length} total, ${derived.filter((item) => item.status === "satisfied").length} satisfied, ${derived.filter((item) => item.status === "unmet").length} unmet, ${derived.filter((item) => item.status === "unresolved").length} unresolved`
    : "";
  // #1627: the disposition parser's drop receipt — counts by drop reason
  // plus the truncation flag — rides the same line only when the parser
  // reported something. Content-free counts, never check text.
  const dropCounts = new Map<string, number>();
  for (const drop of dispositionReceipt?.dropped ?? []) {
    dropCounts.set(drop.reason, (dropCounts.get(drop.reason) ?? 0) + 1);
  }
  const dropDetail = dispositionReceipt !== null
    ? ` | disposition-drops: ${[
        ...[...dropCounts.entries()].map(([reason, count]) => `${reason}=${count}`),
        ...(dispositionReceipt.capReached ? ["cap-reached"] : []),
      ].join(", ")}`
    : "";
  log(`Review obligations: ${obligations.length} total, ${satisfied} satisfied, ${unmet.length} unmet, ${unresolved.length} unresolved${reasonDetail}${derivedDetail}${dropDetail}`);
}

/**
 * #1449: the derived-obligation state artifact. Written ONLY when the
 * feature is enabled (a disabled run must not create the file), and it
 * records the coverage answer next to the rows that carry it — so an
 * operator can tell "the derivation found nothing" from "the derivation
 * never completed" without reading the pre-pass artifact.
 *
 * The `reason` field is the reason for the DISCLOSED state (see
 * `derivedObligationStateReason`): the closed coverage reason when the
 * derivation never completed, `not-discharged` when the coverage is
 * complete but a row stayed open, and null when every row was discharged.
 */
function persistDerivedObligationState(
  ws: RunWorkspace,
  derived: DerivedObligationResolution,
  obligations: readonly ReviewObligation[],
  reason: string | null,
): void {
  if (!derived.enabled) return;
  const rows = obligations
    .filter((obligation) => obligation.source === "derived")
    .map(({ id, source, text, status, cause }) => ({ id, source, text, status, cause }));
  ws.write("derived-obligation-state.json", `${pyJsonDumps({
    version: 1,
    enabled: derived.enabled,
    coverage: derived.coverage,
    reason,
    obligations: rows,
  })}\n`);
}

/**
 * #1449: the run's derived-obligation state — the one word a reader needs
 * to tell WHY a trusted approve was withheld.
 *
 * - "unavailable": the derivation never completed (or never ran), so the
 *   derived-obligation coverage is unknown — the synthetic coverage-marker
 *   row is what withheld the approval;
 * - "unresolved": the derivation completed, but at least one derived row
 *   stayed undischarged;
 * - "complete": the derivation completed and every derived row was
 *   discharged — including the clean "no obligations" answer.
 *
 * A DISABLED run has no state at all (""): the marker and the coverage
 * record then keep their pre-#1449 bytes exactly.
 */
export type DerivedObligationState = "complete" | "unresolved" | "unavailable";

function derivedObligationState(
  derived: DerivedObligationResolution,
  obligations: readonly ReviewObligation[],
): DerivedObligationState | "" {
  if (!derived.enabled) return "";
  if (derived.coverage === "incomplete") return "unavailable";
  const rows = obligations.filter((obligation) => obligation.source === "derived");
  return rows.every((obligation) => obligation.status === "satisfied") ? "complete" : "unresolved";
}

/** #1505: the run's required-evidence state — the one word a reader needs
 * to tell WHY a trusted approve was withheld when required review evidence
 * stayed unresolved (budget exhausted, tool capability, provider failure).
 *
 * - "unresolved": the contract was active and at least one `must_check` or
 *   `trusted_base_guidance` row stayed non-satisfied;
 * - "complete": the contract was active and every row was discharged —
 *   including the clean "no obligations" answer.
 *
 * An INACTIVE contract has no state at all (""): the marker and the
 * coverage record then keep their pre-#1505 bytes exactly. (The `derived`
 * state has an "unavailable" arm because a derivation can fail to run;
 * the required-evidence rows always exist once the contract is active, so
 * there is nothing to be unavailable.) */
export type RequiredEvidenceState = "complete" | "unresolved";

function requiredEvidenceObligationState(
  contractActive: boolean,
  obligations: readonly ReviewObligation[],
): RequiredEvidenceState | "" {
  if (!contractActive) return "";
  const rows = obligations.filter((obligation) => obligation.source !== "derived");
  return rows.every((obligation) => obligation.status === "satisfied") ? "complete" : "unresolved";
}

/** #1505: persist the run's required-evidence state sentinel next to the
 * derived one. Written ONLY when the contract was active, so the file is
 * the run's own "the contract was on" flag the publish boundary fails
 * closed on (an unreadable state over a present sentinel is
 * `unavailable` → approval withheld, never approved). */
function persistRequiredEvidenceState(
  ws: RunWorkspace,
  contractActive: boolean,
  obligations: readonly ReviewObligation[],
): void {
  if (!contractActive) return;
  const rows = obligations
    .filter((obligation) => obligation.source !== "derived")
    .map(({ id, source, text, status, cause }) => ({ id, source, text, status, cause }));
  ws.write("required-evidence-state.json", `${pyJsonDumps({
    version: 1,
    enabled: true,
    obligations: rows,
  })}\n`);
}

function mergeBlockerVerificationPasses(
  first: Awaited<ReturnType<typeof applyBlockerVerification>> | null,
  second: Awaited<ReturnType<typeof applyBlockerVerification>>,
): Awaited<ReturnType<typeof applyBlockerVerification>> {
  if (first === null) return second;
  return { findings: [...first.findings, ...second.findings], demoted: first.demoted + second.demoted };
}

export async function runReviewEngine(request: ReviewRequest, dependencies: ReviewDependencies): Promise<RunReviewResult> {
  if (request.signal !== undefined && request.signal.aborted) throw new RunReviewError("review request cancelled before start", 1);
  const cancellation = createRunCancellation(request);
  // ── #1515: the run-scoped inference governor ──────────────────────────
  // ONE run-wide admission point for the model request paths (tier calls,
  // native-loop turns, specialist/pre-pass/trace-repair transports, the
  // confidence scorer). The cap comes from the ambient
  // `AI_MAX_CONCURRENT_MODEL_REQUESTS` env-only knob; UNSET/EMPTY enables the
  // conservative DEFAULT cap (#1515 review fix: "bounded configurable
  // concurrency with a conservative default" — the unconfigured burst is the
  // one the knob exists to bound), an explicit `0` is the operator's opt-out
  // (the disabled compatibility posture, in which `admit` runs each request
  // directly and existing single-call paths are behavior-identical), and an
  // invalid value warns by name and falls back to the conservative default —
  // a typo never silently unbounds the run. Installed here and cleared in the
  // finally, so one run can never inherit another run's policy.
  const capConfig = parseRunInferenceCap(request.ambient[RUN_INFERENCE_CAP_ENV]);
  const governor = inferenceGovernorFromEnv(request.ambient);
  if (capConfig.kind === "enabled" && dependencies.quiet !== true) {
    dependencies.log(`inference governor: run-wide cap ${capConfig.cap} concurrent model request(s)`);
  } else if (capConfig.kind === "invalid") {
    dependencies.error(`WARNING: ${RUN_INFERENCE_CAP_ENV}=${JSON.stringify(capConfig.raw)} is not a positive integer up to ${MAX_CONFIGURABLE_CONCURRENCY}; using the default run-wide cap of ${DEFAULT_MAX_CONCURRENT_REQUESTS}`);
  }
  configureSharedRunInferenceGovernor(governor);
  try {
    const run = runReviewStages(request, dependencies, cancellation);
    // Cancellation abandons this promise mid-flight; its outcome is already
    // owned by the race below, and must never become an unhandled rejection.
    void run.catch(() => {});
    const result = await Promise.race([run, cancellation.cancelled]);
    // The last word: a result is accepted only while the caller's signal is
    // un-aborted, closing the window between the last checkpoint and here.
    cancellation.checkpoint();
    return result;
  } finally {
    // Awaited before the rejection is observable: owned gate children are
    // gone by the time the caller learns the run was cancelled.
    await cancellation.finalize();
    cancellation.dispose();
    // #1515: the governor is run-scoped — drop this run's policy before the
    // process could serve anything else (and so a reused process or a test
    // can never inherit it).
    configureSharedRunInferenceGovernor(null);
  }
}

/** #1380 budget priority: on a dependency update the optional claim
 * pre-pass must never compete ahead of the mandatory dependency-evidence
 * obligations (#1379 provenance/release-delta/security work), so its launch
 * is gated on the evidence phase settling. The evidence promise never
 * rejects (the phase catches internally); the pass-through rejection handler
 * keeps that fail-soft property explicit. Non-dependency PRs launch
 * concurrently, unchanged. */
export function claimsPrepassGate(
  dependencyUpdate: boolean,
  evidencePhase: Promise<unknown>,
): Promise<void> {
  if (!dependencyUpdate) return Promise.resolve();
  return evidencePhase.then(() => undefined, () => undefined);
}

/** review.sh `run_review`: the pipeline body. Cancellation boundaries are the
 * `checkpoint()` calls; everything else here is the unchanged pipeline. */
async function runReviewStages(request: ReviewRequest, dependencies: ReviewDependencies, cancellation: RunCancellation): Promise<RunReviewResult> {
  const checkpoint = (): void => cancellation.checkpoint();
  const clock = dependencies.now ?? ((): number => Date.now() / 1000);
  const started = clock();
  const log = (line: string): void => {
    if (dependencies.quiet) return;
    dependencies.log(line);
  };
  const errorLog = (line: string): void => dependencies.error(line);
  const annotate = dependencies.annotate;

  assertSupportedNode(process.versions.node);
  if (request.ambient[GATE_CHILD_ENV] === "1") {
    throw new RunReviewError("refusing to start a review inside a gate child process");
  }
  const contract = validateContract(V3_CONTRACT);
  // A request that pins BOTH the event head and an explicit head to different
  // commits is contradictory: fail closed loudly instead of silently preferring
  // one (#726 review). Both values are caller-supplied commit SHAs.
  if (
    request.eventHeadSha !== undefined && request.eventHeadSha !== ""
    && request.headSha !== "" && request.eventHeadSha !== request.headSha
  ) {
    throw new RunReviewError(`contradictory request: eventHeadSha ${request.eventHeadSha} and headSha ${request.headSha} name different commits`);
  }

  // ── Admission stage (#726: engine-owned precheck/fingerprint decision) ─
  // The platform adapter is constructed ONCE here — from the pre-admission
  // stage env, exactly where the Action adapter's precheck adapter used to be
  // built — and shared by every later stage (the duplicate preflight an
  // idempotent auth exchange collapses to one). It is built before the
  // config stage because the trusted base ref is unknown until admission
  // resolves it; adapter-relevant env keys (platform resolution, tokens,
  // REPO/PR_NUMBER) are identical in the pre- and post-resolution envs.
  const adapter: PlatformReadAdapter = dependencies.adapter
    ?? buildPlatformReadAdapter(
      admissionStageEnv(contract, request, dependencies.workspace) as StageEnv,
      request.signal !== undefined
        ? withCancellationSignal(dependencies.fetchImpl, request.signal)
        : dependencies.fetchImpl,
    );
  await adapter.preflightAuthentication?.();
  checkpoint();
  const pre = await runEngineAdmission(contract, request, dependencies.workspace, adapter, errorLog);
  checkpoint();
  if (pre.should_review !== "true") {
    // Skip: no model spend, no further stages. The host owns the skip's
    // side effects (outputs, stderr/summary rendering, fork reply, label
    // cleanup) from the result's admission fields.
    log(`precheck: skipped (${pre.skip_reason || "<none>"})`);
    return admissionSkipResult(pre, Math.max(0, clock() - started), dependencies);
  }
  // Host between-stage side effects (the Action adapter's #914 ack
  // reaction), after a passing admission and before any review stage.
  await dependencies.onAdmission?.(pre);
  checkpoint();

  // ── Config stage (config.sh) ─────────────────────────────────────────
  const raw: Record<string, string | undefined> = { ...request.inputs };
  // The trusted base ref: explicit request state wins (direct callers);
  // otherwise the admission-resolved base fills it in — the Action path's
  // "adapter path fills from event" case. Repository config is resolved from
  // this folded ref only NOW: before admission it was unknowable.
  const baseRef = request.baseRef !== "" ? request.baseRef : pre.base_sha;
  let effectiveRaw = raw;
  if (baseRef !== "") {
    const resolution = resolveRepositoryConfig(contract, raw, {
      baseRef,
      workspace: dependencies.workspace,
    });
    for (const warning of resolution.warnings) errorLog(`repository config: ${warning}`);
    effectiveRaw = resolution.raw;
  }
  const config = loadConfig(contract, effectiveRaw);
  // Assigned unconditionally below, once the resolved fork flag is known —
  // skill discovery must wait for the fail-closed fork gate (#1043 review:
  // CodeQL flagged the dead initializer).
  let skillCatalog: ReturnType<typeof discoverRepositorySkills>;

  // #838: the engine requires an explicit run dir; host adapters own defaults.
  const runDir = dependencies.runDir;
  const workspace = dependencies.workspace;
  log(`run artifacts: ${runDir}`);
  persistOutputs(dependencies.outputsSink, formatOutputAssignment("run-dir", runDir));
  const repo = config.repo !== "" ? String(config.repo) : request.repository;
  const prNumberRaw = config.prNumber;
  const prNumber = prNumberRaw !== "" && prNumberRaw !== undefined ? String(prNumberRaw) : request.prNumber;
  // #726: fold the admission outputs into the review stage state exactly the
  // way actionMain did: PLATFORM = resolved (request value as fallback),
  // FORGEJO_API_URL = admission's effective URL, fork flag from admission.
  // The reviewed head is the explicit pin when present, else the event's
  // head, else admission's resolved head — the pin was verified against
  // admission's supersession check, so pin === pre.head_sha whenever
  // admission passed with a pin.
  const headSha = request.headSha !== "" ? request.headSha : (request.eventHeadSha || pre.head_sha);
  const context: RunContext = {
    workspace,
    runDir,
    repo,
    prNumber,
    headSha,
    isForkPr: request.isForkPr !== "" ? request.isForkPr : pre.is_fork_pr,
    platform: pre.resolved_platform || request.platform,
    forgejoApiUrl: pre.effective_forgejo_api_url,
    ciChecksFile: request.ciChecksFile,
    outputFilePath: dependencies.outputsSink,
    stepSummaryPath: dependencies.stepSummaryPath ?? "",
    baseRef,
    repositorySkillsEnabled: String(config.repositorySkills === true),
    repositorySkillPath: typeof config.repositorySkillPath === "string" ? config.repositorySkillPath : "",
    repositorySkillsRef: "",
    repositorySkillsPaths: "[]",
    repositorySkillsCatalog: "",
    repositorySkillsFingerprint: "",
    repositorySkillAddendum: "",
  };
  const env = buildStageEnv(config, context, request.ambient as NodeJS.ProcessEnv) as StageEnv;
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
    // #1598 (review): the fallback tier's native loop enforces the fallback
    // lane's own window, so a fallback window too small for the loop fails
    // up front too — before the failover would ever need it.
    if ((env.AI_FALLBACK_MODEL ?? "") !== "") loopContextLimits(env, "fallback");
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
  const ws = new RunWorkspace(runDir, dependencies.persistArtifacts ?? true);
  // The provenance artifact records the FOLDED values the pipeline actually
  // used (the folded head/base/fork/platform of #726, and admission's
  // effective Forgejo URL) — on the Action path the raw request fields for
  // head/base/fork arrive empty and admission resolves them, so recording
  // the request verbatim would persist unset/stale values.
  ws.write("review-request.json", Buffer.from(JSON.stringify({ schema_version: "1", repository: request.repository, pr_number: prNumber, head_sha: headSha, base_ref: baseRef, is_fork_pr: context.isForkPr, platform: context.platform, forgejo_api_url: pre.effective_forgejo_api_url, trigger_reason: request.triggerReason, force_rereview: request.forceRereview }, null, 2) + "\n", "utf8"));
  // #726: platform reads are cancellable too. The adapter was constructed and
  // preflighted by the admission stage above and is shared with every later
  // stage; a host that injects its own adapter binds the request signal at
  // construction — see docs/architecture/engine-boundary.md.
  const profiles: TierProfiles = resolveTierProfiles(env);
  // #1465: the tier resolution's notices (a configured model value that
  // holds only whitespace, for example). Advisory only, never fatal, and
  // never a secret.
  for (const warning of profiles.warnings) log(`WARNING: ${warning}`);
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
    // #1154: idempotent on an already-redacted cache copy, and covers a copy
    // persisted by an older build. #1154 review round 6: the sanitized object
    // is written BACK to disk too — an older build's raw copy must not stay
    // in a reused run directory, where it would ship with the run and be
    // served by any later artifact read. The only other rewrite (the #812
    // same-head metadata refresh) is gated on the CI gate running, so it does
    // not close this path generally.
    prObject = redactPrTextDeep(JSON.parse(Buffer.from(cachedObject).toString("utf8")));
    ws.write("pr-object.json", pyJsonDumps(prObject));
  } else {
    prObject = await adapter.getPr();
    if (prObject !== null && prObject !== undefined) {
      // #1154: redact the object itself, not just the persisted copy — the
      // projection below (title/body into pr.json, pr-body.txt, the corpus
      // metadata line) must inherit the redacted authored fields.
      prObject = redactPrTextDeep(prObject);
      ws.write("pr-object.json", pyJsonDumps(prObject));
    }
  }
  const pr = projectPr(prObject, prNumber);
  // #812 review: the authoritative body and its edit instant are ONE atomic
  // platform snapshot, fetched once per metadata pass. The snapshot's body
  // is what the corpus presents and its `editedAt` the only cutoff the
  // discussion renderers label with — a separately fetched timestamp could
  // soften discussion against a description the corpus never showed. Null
  // (no seam, failed read) keeps the REST body and labels nothing.
  let bodyRevision = await authoritativeBodyRevision(adapter);
  checkpoint();
  // #1154: the snapshot body is PR-authored content on the same persisted
  // family as the projection body above. The line-preserving pass, not the
  // flat one: a body is multi-line text whose line structure the reviewer
  // reads, and the flat pass's newline-spanning masker would collapse
  // `password:\n<value>` into a single line here.
  if (bodyRevision !== null) pr.body = redactPrTextLines(bodyRevision.body);
  let supersededCutoff = bodyRevision === null ? null : bodyRevision.editedAt;
  ws.write("pr.json", pyJsonDumps(pr));
  if (context.isForkPr === "") {
    env.IS_FORK_PR = deriveFork(prObject);
    context.isForkPr = env.IS_FORK_PR;
  }
  const forkFlag = env.IS_FORK_PR ?? "";
  if (forkFlag === "true") log("Detected cross-repository pull request");
  const skillsEnabled = repositorySkillsAllowed(config.repositorySkills === true, forkFlag);
  const explicitSkillPath = typeof config.repositorySkillPath === "string" ? config.repositorySkillPath : "";
  const canUseExplicitSkill = explicitSkillPath !== "" && forkFlag === "false";
  skillCatalog = canUseExplicitSkill && baseRef !== ""
    ? discoverRepositorySkills(baseRef, workspace)
    : skillsEnabled && forkFlag === "false" && baseRef !== ""
      ? discoverRepositorySkills(baseRef, workspace)
      : { skills: [], warnings: [], contentFingerprint: "" };
  for (const warning of skillCatalog.warnings) log(`WARNING: ${warning}`);
  const explicitSkill = canUseExplicitSkill && skillCatalog.skills.some(skill => skill.path === explicitSkillPath)
    ? readRepositorySkill(baseRef, workspace, explicitSkillPath)
    : null;
  if (canUseExplicitSkill && explicitSkill === null) log("WARNING: operator-selected repository skill unavailable at trusted base; no fallback to PR-head content");
  env.REPOSITORY_SKILLS = skillsEnabled ? "true" : "false";
  env.REPOSITORY_SKILLS_REF = skillsEnabled ? baseRef : "";
  env.REPOSITORY_SKILLS_PATHS = JSON.stringify(skillsEnabled ? skillCatalog.skills.map(skill => skill.path) : []);
  env.REPOSITORY_SKILLS_CATALOG = renderSkillCatalog(skillsEnabled ? skillCatalog.skills : []);
  env.REPOSITORY_SKILLS_FINGERPRINT = (skillsEnabled || explicitSkill !== null) ? skillCatalog.contentFingerprint : "";
  // #1043 (review, second pass): compute the addendum FIRST, then derive the
  // runtime path from it — deriving from the not-yet-assigned (initialized "")
  // addendum cleared the path for every actively selected skill.
  env.REPOSITORY_SKILL_ADDENDUM = explicitSkill !== null
    && (!skillsEnabled || (env.TOOL_MODE ?? "off").toLowerCase() !== "native_loop")
    ? renderExplicitSkill(explicitSkillPath, explicitSkill)
    : "";
  // #1043 (review): the env var mirrors the addendum actually in effect —
  // an addendum present in the corpus but absent from the config env would
  // dodge the fingerprint, so both are keyed off the same condition.
  env.REPOSITORY_SKILL_PATH = env.REPOSITORY_SKILL_ADDENDUM !== "" ? explicitSkillPath : "";
  if (env.REPOSITORY_SKILL_ADDENDUM !== "") {
    ws.write("repository-skill-addendum.md", env.REPOSITORY_SKILL_ADDENDUM);
    ws.write("repository-skill-context.json", JSON.stringify({ source: "operator-selected", path: explicitSkillPath, added_to_corpus: true }));
  } else {
    // #1043 (review): run dirs can be shared across runs (explicit runDir /
    // PR_REVIEWER_RUN_DIR), so both skill artifacts must be cleared when no
    // skill is selected — a stale addendum on disk would be ingested by the
    // next corpus build while diagnostics claim no skill was applied.
    ws.remove("repository-skill-addendum.md");
    ws.remove("repository-skill-context.json");
  }
  if (skillsEnabled && skillCatalog.skills.length > 0) {
    log(`Trusted-base repository skill catalog available: ${skillCatalog.skills.length} skill(s); none are considered applied unless read_skill succeeds.`);
  }
  if (explicitSkill !== null && env.REPOSITORY_SKILL_ADDENDUM !== "") {
    log(`Operator-selected trusted-base skill included in corpus: ${explicitSkillPath}`);
  } else if (canUseExplicitSkill && explicitSkill === null) {
    log("Repository skills not applied: selected trusted-base skill unavailable.");
  }
  context.repositorySkillsRef = env.REPOSITORY_SKILLS_REF;
  context.repositorySkillsPaths = env.REPOSITORY_SKILLS_PATHS;
  context.repositorySkillsCatalog = env.REPOSITORY_SKILLS_CATALOG;
  context.repositorySkillsFingerprint = env.REPOSITORY_SKILLS_FINGERPRINT;
  context.repositorySkillAddendum = env.REPOSITORY_SKILL_ADDENDUM;

  // Specialist lead artifacts reset (#609): unconditional, before anything
  // can consume a stale value.
  ws.write("specialists.md", "");
  ws.write("specialist-leads-present.txt", "");
  // #1043 (review): the applied-skills artifact is reset unconditionally —
  // the loop writes it back only on real read_skill success, so a reused
  // run dir (zero reads, or tools disabled entirely) never reports the
  // previous run's skills.
  ws.remove("repository-skills-applied.json");

  let diffText: string;
  const cachedDiff = ws.readText("pr.diff");
  if (cachedDiff !== null && cachedDiff !== "") {
    log("Reusing PR diff fetched by precheck");
    diffText = cachedDiff;
  } else {
    diffText = await adapter.getPrDiff();
    checkpoint();
  }
  // #1154: the diff is PR-authored untrusted content, and every artifact it
  // feeds (`pr.diff`, `pr.diff.truncated`, the corpus sections built from it,
  // and `ai-request.<tier>.json`, which must keep recording exactly what was
  // FIRST sent) persists it. Redacting here — once, before any write — makes
  // the model input and every persisted artifact carry the same redacted
  // bytes. `redactDiffText` (not the flat pass) keeps every line count and
  // prefix intact, so inline findings still anchor to the same line numbers
  // the forge's raw diff defines, and it also closes the split-line form (a
  // `password:` key line with its value on the indented line below). Path
  // headers are masked too (#1154 review round 3): a credential-shaped token
  // in a diff-header path is PR-authored content, and `rawDiffText` below
  // keeps the raw spelling in memory so the change-anchor checkout lookups
  // still resolve. The generic layer's documented false-positive class (a
  // fixture value like `sk-test-…`) is accepted, as is the continuation
  // rule's over-redaction (any indented run after a bare secret key is
  // masked): over-redaction is the redaction module's stated preference over
  // a leaked credential.
  const rawDiffText = diffText;
  diffText = redactDiffText(diffText);
  if (diffText !== rawDiffText) log("PR diff redaction: masked credential-shaped value(s) before persistence and corpus assembly");
  ws.write("pr.diff", diffText);
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
    // #1154: the pinned seed is PR-authored content too; redact before the
    // artifact write so the persisted copy matches the live branch's policy.
    rawFilesList = redactPrTextDeep(seededFiles) as unknown[];
    const totals = seededFileTotals(rawFilesList);
    totalChangedFiles = totals.changedFiles;
    pr.changedFiles = totals.changedFiles;
    pr.additions = totals.additions;
    pr.deletions = totals.deletions;
    ws.write("pr.json", pyJsonDumps(pr));
    ws.write("pr-files.raw.json", pyJsonDumps(rawFilesList));
  } else {
    const filesResult = await adapter.listPrFiles();
    checkpoint();
    if (!filesResult.ok) throw new RunReviewError(`platform_pr_files failed: ${filesResult.error}`);
    // #1154: the raw platform file entries carry per-file `patch` fields —
    // PR-authored hunks on the same persisted family as the diff itself.
    // A credential-shaped `filename` VALUE is masked too (the accepted
    // false-positive class); the consequence is not cosmetic — the model
    // cannot read_file such a path, so coverage records it as unread —
    // which is preferred to persisting a credential-shaped string.
    const prFilesRaw = redactPrTextDeep(filesResult.data);
    ws.write("pr-files.raw.json", pyJsonDumps(prFilesRaw));
    totalChangedFiles = typeof pr.changedFiles === "number" ? pr.changedFiles : 0;
    rawFilesList = Array.isArray(prFilesRaw) ? prFilesRaw as unknown[] : [];
  }
  ws.write("pr-files.json", filesProjection(rawFilesList, totalChangedFiles));
  ws.write("pr-files.truncated.json", truncateClean(Buffer.from(filesProjection(rawFilesList, totalChangedFiles)), budgets.primary.maxFiles, "…[file list truncated]"));
  ws.write("pr-body.txt", String(pr.body ?? ""));

  // ── Re-review scope section (#1426) ──────────────────────────────────
  // Two scopes, stated explicitly: the authoritative current PR
  // (base→head) the verdict and summary describe, and the prior-head delta
  // (previous-reviewed-head→current-head) that only prioritizes inspection.
  // Written unconditionally — possibly empty — so a reused run directory
  // never carries a previous run's section (the specialist-reset pattern
  // above). The delta probe is fail-soft: a shallow checkout that no longer
  // holds the force-pushed-away prior head still gets the identities-only
  // section, never a guessed delta.
  ws.write("re-review-scope.md", new Uint8Array(0));
  // #1516: the evidence-reuse artifacts follow the same unconditional-empty
  // pattern — a reused run directory never carries a previous run's section.
  ws.write("re-review-evidence.md", new Uint8Array(0));
  ws.write("re-review-evidence.json", new Uint8Array(0));
  const priorReviewedHead = typeof pre.prior_head_sha === "string" ? pre.prior_head_sha : "";
  const priorHeadUsable = SHA_SHAPE.test(priorReviewedHead) && priorReviewedHead.toLowerCase() !== headSha.toLowerCase();
  let delta: ReReviewScopeDelta | null = null;
  if (priorHeadUsable) {
    delta = await computeReReviewDelta(workspace, priorReviewedHead, headSha);
    const section = buildReReviewScopeMd(delta, { priorHeadSha: priorReviewedHead, headSha, baseSha: pre.base_sha });
    if (section !== "") {
      ws.write("re-review-scope.md", section);
      log(`Re-review scope recorded: prior reviewed head ${priorReviewedHead.toLowerCase()} → current head ${headSha.toLowerCase()}`);
    }
  }

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
  const relatedInputs = await buildRelatedCodeSection(ws, env, workspace, rawDiffText);
  checkpoint();

  // ── Re-review evidence reuse (#1516) ─────────────────────────────────
  // Advisory only: seed prior evidence candidates for paths proven
  // byte-identical to the prior reviewed head, force fresh reads for
  // everything changed/renamed/deleted/impact-affected. The verdict, merge
  // gating, and every deterministic gate are untouched — the JSON artifact
  // is written whenever a re-review plan was computed (including degraded
  // plans, so the reason reuse was refused is recorded), while the corpus
  // section is written only when there is something to say.
  if (priorHeadUsable && delta !== null) {
    const evidencePlan = await computeReReviewEvidencePlan(
      workspace,
      delta,
      relatedInputs === null
        ? null
        : { context: relatedInputs.related, anchorsTruncated: relatedInputs.anchors.truncated === true },
    );
    const evidenceSection = buildReReviewEvidenceMd(evidencePlan, { priorHeadSha: priorReviewedHead, headSha });
    if (evidenceSection !== "") {
      ws.write("re-review-evidence.md", evidenceSection);
      log(`Re-review evidence reuse: ${evidencePlan.seeded.length} seeded, ${evidencePlan.impactInvalidated.length} invalidated, ${evidencePlan.changed.length}+${evidencePlan.renamed.length}+${evidencePlan.deleted.length} forced fresh`);
    }
    const evidenceJson = renderReReviewEvidenceJson(evidencePlan, { priorHeadSha: priorReviewedHead, headSha, baseSha: pre.base_sha });
    if (evidenceJson !== "") ws.write("re-review-evidence.json", evidenceJson);
  }

  const obligationsOn = (env.HARNESS_OBLIGATIONS ?? "false").toLowerCase() === "true";
  const harnessObligations = relatedInputs === null || !obligationsOn ? [] : buildHarnessObligations(relatedInputs);

  // #875: bounded equivalent-implementation-path detection, from the same
  // anchors. Off by default; a lead-generation hint, not a ledger entry —
  // see the correctness specialist wiring below.
  buildEquivalentPathsSection(ws, env, workspace, relatedInputs === null ? null : relatedInputs.anchors);

  // #764: the optional syntax-aware context stage, from the same anchors.
  // Off by default; it complements the lexical related-code context above
  // (never replaces it) and emits evidence only — no findings, no severity,
  // no obligations, no verdict.
  await buildSyntaxContextSection(
    ws,
    env,
    workspace,
    relatedInputs === null ? null : relatedInputs.anchors,
    context.headSha !== "" ? context.headSha : String(pr.headRefOid ?? ""),
  );

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
  checkpoint();

  // Manifest context (context.sh tail).
  const manifest = buildManifestContext(rawFilesList, workspace);
  for (const [name, data] of manifest.artifacts) ws.write(name, data);

  // ── Advisory phases (the #371 background forks, in-process) ──────────
  const extraction = extractEnrichmentArtifacts(env, ws, diffText, pr);
  const enrichmentPromise = renderLinkedSourcesPhase(env, ws, extraction, dependencies.now).catch((cause: unknown) => {
    log(`WARNING: enrichment failed, producing empty linked-sources.md: ${cause instanceof Error ? cause.message : String(cause)}`);
    ws.write("linked-sources.md", "");
    return null;
  });
  const imageDigestPromise = runImageDigestPhase(ws, diffText, env, cancellation.scope.signal).catch((cause: unknown) => {
    errorLog(`Image digest analysis failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    ws.write("image-digest-context.md", "Image digest provenance analysis failed for this run.\n");
    return null;
  });
  const evidencePromise = runEvidencePhase(ws, env, forkFlag, runDir, log, cancellation.scope.signal).catch((cause: unknown) => {
    errorLog(`Evidence provider execution failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    ws.write("evidence-providers.md", "Evidence providers failed to run in this review.\n");
    ws.write("evidence-providers.json", '{"configured": false, "has_blocker": false, "providers": [], "error": "execution failed"}\n');
    // #1529 review: the phase's own failure path clears the negative-
    // evidence sidecar, but an exception escaping runEvidencePhase itself
    // (e.g. a sidecar write failure) lands HERE. Clear it too, so a prior
    // same-head derivation in a shared run directory can never survive a
    // failed evidence phase into this run's deterministic pass.
    ws.write(EVIDENCE_NEGATIVE_EVIDENCE_FILE, "");
    return null;
  });

  // Repository impact/history scan (classification.sh) — needs the
  // version hints the extraction just wrote.
  const impact = await buildRepoImpactHistory({ pr, versionHintsTruncated: ws.read("version-hints.truncated.txt"), workspace });
  checkpoint();
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
    // #1336: forge-reported Renovate-update metadata — author login, title,
    // and head branch feed the deterministic update-kind/risk rules. PR-body
    // content is never consulted (untrusted data).
    prAuthor: String((pr.author as { login?: unknown } | undefined)?.login ?? ""),
    prTitle: String(pr.title ?? ""),
    headBranch: String(pr.headRefName ?? ""),
  });
  const classificationArtifact = classificationToArtifact(classification) as Record<string, unknown>;
  ws.write("classification.json", `${pythonJsonStringify(classificationArtifact)}\n`);
  const classificationFlags = Array.isArray(classificationArtifact.risk_flags)
    ? (classificationArtifact.risk_flags as string[]).join(",")
    : "none";
  log(`PR classification complete: ${String(classificationArtifact.pr_kind ?? "unknown")} (risk_flags=${classificationFlags})`);
  // #871: substantialCodeChange isn't part of the persisted classification
  // artifact (see PRClassification's field doc); thread it to the
  // specialists gate through env instead, so role selection can force the
  // correctness lane for a substantial PR regardless of what pr_kind ended
  // up being.
  env.SUBSTANTIAL_CODE_CHANGE = classification.substantialCodeChange ? "true" : "false";

  // ── Dependency-upgrade coverage accounting (#1337) ────────────────────
  // Deterministic corpus section: what the harness established per
  // coverage aspect vs what is explicitly not checked. Bounded, empty
  // unless the classification is dependency-shaped and the diff carries
  // dependency changes — other PRs keep today's corpus byte-for-byte.
  ws.write(
    "dependency-coverage.md",
    buildDependencyCoverageContext({
      prKind: String(classificationArtifact.pr_kind ?? "unknown"),
      diffText,
      prBody: typeof pr.body === "string" ? pr.body : null,
    }),
  );

  const { route, reason } = resolveReviewRoute({ routingMode: env.REVIEW_ROUTING_MODE ?? "off" });
  env.REVIEW_ROUTE = route;
  env.ROUTE_REASON = reason;
  if (route === "primary") {
    Object.assign(env, {
      AI_BASE_URL: profiles.primary.baseUrl,
      AI_MODEL: profiles.primary.model,
      AI_API_FORMAT: profiles.primary.apiFormat,
      AI_API_KEY: profiles.primary.apiKey,
      // #998: the route's effort follows the route, exactly like the
      // transport keys above — env-driven consumers downstream (the tool
      // harness, the specialist phase) resolve their effort from the primary
      // lane's value, not the raw base input.
      AI_REASONING_EFFORT: profiles.primary.reasoningEffort,
    });
  }
  log(`Review route: ${route} (${reason}) → ${env.AI_MODEL}`);

  promptState = applySystemPromptFragments(promptState, {
    ...(env.RELATED_CODE_CONTEXT !== undefined ? { relatedCodeContext: env.RELATED_CODE_CONTEXT } : {}),
    ...(env.PR_THREAD_CONTEXT !== undefined ? { prThreadContext: env.PR_THREAD_CONTEXT } : {}),
    ...(env.REVIEW_VERBOSITY !== undefined ? { reviewVerbosity: env.REVIEW_VERBOSITY } : {}),
  }, ws);
  env.SYSTEM_PROMPT = `${promptState.systemPrompt}${env.REPOSITORY_SKILLS_CATALOG ?? ""}`;

  // ── Corpus stage part 1 (corpus.sh): fork CI, harvest advisory ───────
  let ciFork: ForkedGate | null = null;
  if ((env.CI_STATUS_CHECK ?? "false").toLowerCase() === "true" && dependencies.ciGate !== null) {
    const entry = dependencies.ciGate ? "" : (dependencies.ciGateEntry ?? "");
    if (dependencies.ciGate || entry !== "") {
      // Never launch an owned gate for a run the caller already cancelled.
      checkpoint();
      // The gate child is marked so it can never start a review (or another
      // gate) itself: the recursion stops at depth one.
      // Claimed before the await: the launch suspends inside forkGate
      // (preflight + launch probe), and a cancellation landing there is
      // still awaited by finalize() (#1183). Owned from landing to join:
      // cancellation finalizes it even if the run dies in between.
      ciFork = await cancellation.claimFork(forkGate("ci", dependencies.ciGate ?? ciGateBranch({ entry }), {
        // GITHUB_OUTPUT is the ported v2 stage ABI the CI gate child writes.
        ambientEnv: { ...request.ambient, [GATE_CHILD_ENV]: "1", GITHUB_OUTPUT: join(runDir, CI_GATE_OUTPUT_FILE) },
        scope: cancellation.scope,
      }));
      log("CI status gating launched concurrently");
      env.CI_GATE_ACTIVE = "true";
    } else {
      log("CI status gating skipped: no runtime bundle entry to launch it from");
    }
  }

  await Promise.all([enrichmentPromise, imageDigestPromise, evidencePromise]);
  checkpoint();

  // PR-thread context (corpus.sh) — same pass cutoff as the review threads.
  await buildPrThreadSection(ws, adapter, env, supersededCutoff);
  checkpoint();
  // #812: the superseded-discussion rule, appended only now that the
  // discussion sections exist (the fragments phase runs before this stage).
  promptState = applySupersededDiscussionFragment(promptState, ws);
  env.SYSTEM_PROMPT = `${promptState.systemPrompt}${env.REPOSITORY_SKILLS_CATALOG ?? ""}`;

  // ── Risk-evidence obligations pre-pass (#1577) ─────────────────────────
  // DETERMINISTIC: no model call, one bounded scan of the complete diff.
  // Written BEFORE corpus build #1 so the section rides every corpus of the
  // run (no rebuild trigger needed). Fail-soft: a scan failure writes an
  // explicit error record the enforcement half reads as INCOMPLETE coverage
  // — a scan that never completed must never read as "no risk obligations".
  // A DISABLED scan writes no risk artifact of its own: neither the JSON
  // record nor the corpus section file. It also clears both artifacts,
  // because run dirs can be shared across runs (explicit runDir or
  // PR_REVIEWER_RUN_DIR) and the workspace read falls back to the on-disk
  // mirror — a stale section left by an earlier run would otherwise be
  // ingested by this corpus build (#1043 stale-artifact defense).
  const riskObligationsEnabled = (env.RISK_OBLIGATIONS ?? "false").trim().toLowerCase() === "true";
  if (riskObligationsEnabled) {
    const riskDiffFull = ws.readText("pr.diff");
    const riskDiffSource: "full" | "truncated" | "none" = riskDiffFull !== null
      ? "full"
      : ws.readText("pr.diff.truncated") !== null
      ? "truncated"
      : "none";
    const riskDiff = riskDiffFull ?? ws.readText("pr.diff.truncated") ?? "";
    let riskRecord: Record<string, unknown>;
    try {
      const artifact = scanRiskObligations(riskDiff);
      const failed = artifact.errors.length > 0;
      // A scan that recorded an internal error must render the visible
      // unavailable note AND record a non-`ok` status, so the enforcement
      // half reads incomplete coverage and the corpus never reads as "no
      // risk obligations" (#1449 discipline).
      // A scan over a truncated or absent diff renders the incomplete-input
      // footer (or the unavailable note when no rows remain), so the corpus
      // never reads a partial row list as the full risk picture (#1449).
      const section = failed
        ? renderRiskUnavailable(artifact.errors[0] ?? "scan-failed")
        : riskCorpusSection(artifact, riskDiffSource, Number(env.RISK_OBLIGATIONS_SECTION_MAX_BYTES ?? DEFAULT_RISK_SECTION_MAX_BYTES) || DEFAULT_RISK_SECTION_MAX_BYTES);
      riskRecord = {
        version: 1,
        status: failed ? "error" : artifact.obligations.length > 0 ? "ok" : "empty",
        error_kind: failed ? (artifact.errors[0] ?? "scan-failed") : null,
        diff_source: riskDiffSource,
        input_complete: riskDiffSource === "full",
        method: artifact.method,
        obligations: artifact.obligations,
        truncated: artifact.truncated,
        errors: artifact.errors,
        section_bytes: Buffer.byteLength(section, "utf8"),
      };
      ws.write("risk-obligations.md", Buffer.from(section, "utf8"));
    } catch (cause) {
      log(`WARNING: risk-obligations scan failed; risk coverage marked incomplete: ${cause instanceof Error ? cause.message : String(cause)}`);
      // The enforcement half withholds on the error record; the corpus must
      // not silently read as "no risk obligations" (#1449 discipline).
      ws.write("risk-obligations.md", Buffer.from(renderRiskUnavailable("internal"), "utf8"));
      riskRecord = {
        version: 1,
        status: "error",
        error_kind: "internal",
        diff_source: riskDiffSource,
        input_complete: false,
        method: "none",
        obligations: [],
        truncated: false,
        errors: ["scan-failed"],
        section_bytes: 0,
      };
    }
    ws.write("risk-obligations.json", Buffer.from(`${pyJsonDumps(riskRecord)}\n`, "utf8"));
  } else {
    // #1043 (review): run dirs can be shared across runs (explicit runDir /
    // PR_REVIEWER_RUN_DIR), so a disabled scan must clear what an earlier
    // run left behind — a stale section on disk would be read back into the
    // next corpus build while the run claims no risk obligations exist.
    ws.remove("risk-obligations.md");
    ws.remove("risk-obligations.json");
  }

  // Corpus build #1 (initial review owns the primary artifact slot).
  // #965: the first pass is always the primary profile — the smart tier is
  // selected at escalation, not before the review runs.
  const profileKey: "primary" | "smart" = "primary";
  let corpusResult = assembleCorpus(ws, env, budgets, profileKey, "primary", generatedPaths, standards);
  ws.write("review-corpus.truncated.md", ws.read(corpusResult.outputName) ?? new Uint8Array(0));

  // ── Claim falsification pre-pass (#785) ────────────────────────────────
  // Fail-soft: any failure leaves claim-falsification.md empty and the
  // review proceeds unchanged. Deterministic scan first; the bounded model
  // pass on the primary route always runs when configured and merges on top
  // of the scan's claims (#898). Launched after the evidence phase has
  // settled — on a dependency update the ordering is a hard budget-priority
  // requirement (#1380), enforced by claimsPrepassGate below.
  ws.write("claim-falsification.md", new Uint8Array(0));
  let claimsPromise: Promise<void> = Promise.resolve();
  if ((env.CLAIM_FALSIFICATION ?? "false").toLowerCase() === "true") {
    const rawTemp = (env.AI_TEMPERATURE ?? "").trim();
    const temperature = rawTemp === "" || Number.isNaN(Number(rawTemp)) ? null : Number(rawTemp);
    const claimsTimeoutSec = Math.min(
      Number(env.CLAIM_FALSIFICATION_TIMEOUT_SEC ?? "180") || 180,
      Number(env.AI_REQUEST_TIMEOUT_SEC ?? "180") || 180,
    );
    // #1037: correlation headers ride the pre-pass calls too. Resolved where
    // the pre-fix code parsed them — inside the branch that actually builds
    // the claim model, and before the promise exists — so this block's
    // async-only `.catch` fail-soft surface is unchanged; unset config omits
    // the key rather than merging an empty map.
    const claimExtra = profiles.primary.baseUrl && profiles.primary.model
      ? extraHeadersForEnv(env.AI_EXTRA_HEADERS ?? "")
      : undefined;
    // #1380 budget priority: on a dependency update the optional claim
    // pre-pass must never start ahead of the mandatory dependency-evidence
    // obligations (#1379 provenance/release-delta/security), which run in and
    // after the evidence phase — so the pre-pass launches only once the
    // evidence phase has settled. Fail-soft: that promise never rejects (the
    // phase catches internally), and non-dependency PRs keep the concurrent
    // launch unchanged.
    claimsPromise = claimsPrepassGate(
      DEPENDENCY_UPDATE_KINDS.has(classification.prKind),
      evidencePromise,
    ).then(() => runClaimFalsificationPass({
      title: String(pr.title ?? ""),
      body: String(pr.body ?? ""),
      files: safeJson(ws.read("pr-files.json")),
      diff: (ws.readText("pr.diff.truncated") ?? ws.readText("pr.diff") ?? ""),
      dependencyUpdate: DEPENDENCY_UPDATE_KINDS.has(classification.prKind),
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
                responseFormat: profiles.primary.responseFormat,
                tokensParam: env.AI_TOKENS_PARAM ?? "max_tokens",
                stream: (env.AI_STREAM ?? "true").toLowerCase() === "true",
                timeoutSec: claimsTimeoutSec,
                inputMaxBytes: Number(env.CLAIM_FALSIFICATION_INPUT_MAX_BYTES ?? "48000") || 48000,
                // #998: the pre-pass runs on the primary route, so it uses the
                // primary lane's resolved effort.
                reasoningEffort: profiles.primary.reasoningEffort,
                anthropicEffortSupported: profiles.primary.anthropicEffortSupported,
              },
              requestFn: specialistRequestFn({
                baseUrl: profiles.primary.baseUrl,
                apiKey: profiles.primary.apiKey,
                anthropicVersion: env.ANTHROPIC_VERSION ?? "2023-06-01",
                // #1037: correlation headers ride specialist/pre-pass calls too;
                // unset config omits the key.
                ...(claimExtra !== undefined ? { extraHeaders: claimExtra } : {}),
                // #1515: the claim-falsification pass is a required pre-pass
                // (class 2) — it queues ahead of advisory work but never ahead
                // of the authoritative review. The run's cancellation scope
                // bounds the queue wait too.
                priority: GOVERNOR_PRIORITY_REQUIRED_PREPASS,
                signal: cancellation.scope.signal,
              }),
            }
          : undefined,
    }))
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

  // ── Derived architectural-obligation pre-pass (#1448) ──────────────────
  // #1449: the operator-only feature gate, read ONCE — the pre-pass below
  // and the enforcement half (#1449) must never disagree about whether the
  // feature is on. The value is parsed EXACTLY like the harness parses it
  // (`trim().toLowerCase()`), so the two readers can never disagree about
  // a padded or mixed-case value.
  const derivedObligationsEnabled = (env.DERIVED_OBLIGATIONS ?? "false").trim().toLowerCase() === "true";
  // Fail-soft like the claims pre-pass above, but NOT silent on failure: a
  // derivation that did not complete renders a visible "coverage
  // unavailable" note, because this pass exists to surface obligations the
  // PR never states — an absent section must never read as "nothing was
  // implied". The JSON artifact records status/error kind so #1449 can tell
  // `empty` (model ran, no obligation) from `error`/`timeout`/`malformed`
  // (derivation incomplete). One bounded model call on the primary route.
  // Shares the #1380 budget-priority gate: on a dependency update it
  // launches only after the mandatory evidence phase settles.
  //
  // Input completeness (#1448 review: truncated-diff blinding): the pass is
  // fed the COMPLETE diff (`pr.diff`) — the prioritized `pr.diff.truncated`
  // slice can omit the very hunk that raises the obligation (the #909
  // caveat, classification's own feed comment). The pass applies its own
  // bounded selection/clipping on top, and the artifact records
  // `diff_source`/`diff_clipped`/`input_complete` so #1449 can fail toward
  // partial/needs-review instead of treating an `empty` over a clipped or
  // sliced input as complete coverage. `pr.diff` is the complete fetched
  // diff (a capped platform read throws rather than silently clipping);
  // the truncated-slice fallback only fires when the full artifact is
  // absent, and records exactly that.
  const derivedDiffFull = ws.readText("pr.diff");
  const derivedDiffSource: "full" | "truncated" | "none" = derivedDiffFull !== null
    ? "full"
    : ws.readText("pr.diff.truncated") !== null
    ? "truncated"
    : "none";
  const derivedDiff = derivedDiffFull ?? ws.readText("pr.diff.truncated") ?? "";
  ws.write("derived-obligations.md", new Uint8Array(0));
  let derivedPromise: Promise<void> = Promise.resolve();
  if (derivedObligationsEnabled) {
    const rawDerivedTemp = (env.AI_TEMPERATURE ?? "").trim();
    const derivedTemperature = rawDerivedTemp === "" || Number.isNaN(Number(rawDerivedTemp)) ? null : Number(rawDerivedTemp);
    const derivedTimeoutSec = Math.min(
      Number(env.DERIVED_OBLIGATIONS_TIMEOUT_SEC ?? "180") || 180,
      Number(env.AI_REQUEST_TIMEOUT_SEC ?? "180") || 180,
    );
    // #1037 correlation headers ride the derivation call too, same rule as
    // the claims pre-pass: resolved only when the primary route exists, and
    // unset config omits the key.
    const derivedExtra = profiles.primary.baseUrl && profiles.primary.model
      ? extraHeadersForEnv(env.AI_EXTRA_HEADERS ?? "")
      : undefined;
    derivedPromise = claimsPrepassGate(
      DEPENDENCY_UPDATE_KINDS.has(classification.prKind),
      evidencePromise,
    ).then(() => runDerivedObligationsPass({
      title: String(pr.title ?? ""),
      body: String(pr.body ?? ""),
      files: safeJson(ws.read("pr-files.json")),
      diff: derivedDiff,
      diffComplete: derivedDiffSource === "full",
      model:
        profiles.primary.baseUrl && profiles.primary.model
          ? {
              config: {
                apiFormat: profiles.primary.apiFormat,
                model: profiles.primary.model,
                baseUrl: profiles.primary.baseUrl,
                apiKey: profiles.primary.apiKey,
                maxTokens: Number(env.DERIVED_OBLIGATIONS_MAX_TOKENS ?? "4096") || 4096,
                temperature: derivedTemperature,
                responseFormat: profiles.primary.responseFormat,
                tokensParam: env.AI_TOKENS_PARAM ?? "max_tokens",
                stream: (env.AI_STREAM ?? "true").toLowerCase() === "true",
                timeoutSec: derivedTimeoutSec,
                inputMaxBytes: Number(env.DERIVED_OBLIGATIONS_INPUT_MAX_BYTES ?? "48000") || 48000,
                // #998: the pre-pass runs on the primary route, so it uses
                // the primary lane's resolved effort.
                reasoningEffort: profiles.primary.reasoningEffort,
                anthropicEffortSupported: profiles.primary.anthropicEffortSupported,
              },
              requestFn: specialistRequestFn({
                baseUrl: profiles.primary.baseUrl,
                apiKey: profiles.primary.apiKey,
                anthropicVersion: env.ANTHROPIC_VERSION ?? "2023-06-01",
                ...(derivedExtra !== undefined ? { extraHeaders: derivedExtra } : {}),
                // #1515: the derived-obligation pass is a required pre-pass
                // (class 2), same as the claim-falsification pass.
                priority: GOVERNOR_PRIORITY_REQUIRED_PREPASS,
                signal: cancellation.scope.signal,
              }),
            }
          : undefined,
    }))
      .then((result) => {
        const section = renderDerivedSectionForStatus(result, Number(env.DERIVED_OBLIGATIONS_SECTION_MAX_BYTES ?? "8000") || 8000);
        const record = {
          status: result.status,
          error_kind: result.errorKind,
          error: result.error,
          diff_source: derivedDiffSource,
          diff_clipped: result.diffClipped,
          input_complete: result.inputComplete,
          method: result.artifact.method,
          obligations: result.artifact.obligations,
          truncated: result.artifact.truncated,
          errors: result.artifact.errors,
          section_bytes: Buffer.byteLength(section, "utf8"),
        };
        ws.write("derived-obligations.json", Buffer.from(`${pyJsonDumps(record)}\n`, "utf8"));
        ws.write("derived-obligations.md", Buffer.from(section, "utf8"));
      })
      .catch((cause: unknown) => {
        // The pass itself never throws; this only guards the artifact-write
        // path. Even here the review proceeds, with an explicit unavailable
        // note rather than a silent gap — and the JSON artifact is written
        // too, so a #1449 consumer never sees "no artifact" (indistinguishable
        // from a disabled run) while the corpus says a derivation happened.
        log(`WARNING: derived-obligations pre-pass failed; continuing without derived obligations: ${cause instanceof Error ? cause.message : String(cause)}`);
        const note = Buffer.from(renderDerivedUnavailable("internal"), "utf8");
        ws.write("derived-obligations.md", note);
        ws.write(
          "derived-obligations.json",
          Buffer.from(`${pyJsonDumps({
            status: "error",
            error_kind: "internal",
            error: cause instanceof Error ? cause.message : String(cause),
            diff_source: derivedDiffSource,
            diff_clipped: false,
            input_complete: false,
            method: "none",
            obligations: [],
            truncated: false,
            errors: [],
            section_bytes: note.length,
          })}\n`, "utf8"),
        );
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
    checkpoint();
    // Claimed before the await, same #1183 rule as the CI fork: this branch
    // lands synchronously today, but the claim keeps the ownership window
    // closed if the workload launch ever suspends.
    const specialistFork = await cancellation.claimFork(forkGate("specialists", {
      file: "",
      envAllowlist: [],
      workload: async () => runSpecialistsGate({
        env,
        // The gate's artifacts (role files, specialists.json/.md) must land
        // in the run dir this workspace reads, not GITHUB_WORKSPACE.
        argv: ["--corpus", "specialist-corpus.md", "--workspace-root", runDir, ...equivalentPathsArgv],
        cwd: runDir,
        // #1515 (review fix): this gate runs IN THIS PROCESS — it must reuse
        // the run's already-configured governor (a second governor from env
        // would split the run-wide cap while the claim/derived pre-passes are
        // still in flight) and bind the run's cancellation scope into every
        // role's admission, so a queued role never dispatches after
        // cancellation or past the phase deadline.
        governor: sharedRunInferenceGovernor(),
        signal: cancellation.scope.signal,
        stdout: (line) => log(line),
        stderr: (line) => errorLog(line),
        ...(dependencies.sleep !== undefined ? { sleep: dependencies.sleep } : {}),
      }),
    }, { scope: cancellation.scope }));
    specialistOutcome = await specialistFork.join();
    cancellation.release(specialistFork);
  }
  await claimsPromise;
  await derivedPromise;
  // #1594: the CI gate-output file's raw text, read once after the join (an
  // unreadable file is ""), reused by the whitelisted persist, the trace CI
  // state, and the head-bound evidence parse below.
  let ciGateRawText = "";
  if (ciFork !== null) {
    const outcome = await ciFork.join();
    // Joined: the second (result-building) join reads the cached outcome and
    // never touches the child again, so the fork is no longer outstanding.
    cancellation.release(ciFork);
    checkpoint();
    env.CI_GATE_ACTIVE = outcome.ran ? "true" : "false";
    if (!outcome.ok) log("CI status gating exited non-zero; continuing (CI evidence is advisory)");
    // #1594: ONE raw read of the gate-output file feeds both the whitelisted
    // action-output persist and the `ci_checks_evidence` line below (the
    // gate child has exited here — the file cannot change afterwards).
    try {
      ciGateRawText = readFileSync(join(runDir, CI_GATE_OUTPUT_FILE), "utf8");
    } catch {
      ciGateRawText = "";
    }
    persistOutputs(context.outputFilePath, ciGateOutputsFromText(ciGateRawText));
  }
  checkpoint();

  // #812: the PR body, linked issues and thread context are re-read after
  // the CI wait, so edits made while CI ran (push first, then update the
  // body/issue) reach the model with no extra review. Only when the head is
  // unchanged: a moved head supersedes this review anyway.
  if (env.CI_GATE_ACTIVE === "true") {
    const refreshed = await adapter.getPr().catch(() => null);
    // #1154: same ingestion policy as the initial fetch — the refreshed
    // object's authored fields must not persist raw.
    const redactedRefreshed = refreshed === null || refreshed === undefined ? refreshed : redactPrTextDeep(refreshed);
    const next = refreshed === null || refreshed === undefined ? null : projectPr(redactedRefreshed, prNumber);
    if (next !== null && String(next.headRefOid ?? "") === String(pr.headRefOid ?? "")) {
      log("Refreshing PR metadata context after the CI wait");
      // A fresh atomic snapshot for the rebuilt pass: its body is presented
      // and its `editedAt` is the only cutoff this pass labels with. A
      // failed snapshot read keeps the REST-refreshed body and no cutoff.
      bodyRevision = await authoritativeBodyRevision(adapter);
      if (bodyRevision !== null) next.body = redactPrTextLines(bodyRevision.body);
      supersededCutoff = bodyRevision === null ? null : bodyRevision.editedAt;
      Object.assign(pr, next);
      ws.write("pr-object.json", pyJsonDumps(redactedRefreshed));
      ws.write("pr.json", pyJsonDumps(pr));
      ws.write("pr-body.txt", String(pr.body ?? ""));
      await buildMetadataContext(pr, supersededCutoff);
      await buildPrThreadSection(ws, adapter, env, supersededCutoff);
      // #812 review: discussion can appear while CI runs. The fragment is
      // idempotent; without this reapplication the rebuilt corpus could
      // carry discussion the system prompt has no superseded-discussion
      // rule for.
      promptState = applySupersededDiscussionFragment(promptState, ws);
      env.SYSTEM_PROMPT = `${promptState.systemPrompt}${env.REPOSITORY_SKILLS_CATALOG ?? ""}`;
    }
  }

  // Rebuild the corpus with both branches resolved (finalized CI evidence
  // + any rendered specialist leads + refreshed PR metadata).
  if (env.CI_GATE_ACTIVE === "true" || ws.isNonEmpty("specialists.md") || ws.isNonEmpty("claim-falsification.md") || ws.isNonEmpty("derived-obligations.md")) {
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
  // #1600: file-attributed changed lines, so content-based scope evidence can
  // never combine a security-document path with another file's matching text.
  const traceFileLines = requirementTraceEnabled ? traceChangedFileLines(ws) : undefined;
  // #1062: the trusted PR title + body at head, passed to the trace validator as
  // the ONLY positive-confirmation source for a `documentation`-domain obligation
  // (e.g. "the PR description records the removed-file inventory"). It is the
  // authoritative platform PR snapshot, never model output, and is never used to
  // confirm a code obligation — the validator's classifier gates that out.
  const tracePrBody = `${String(pr.title ?? "")}\n${String(pr.body ?? "")}`;
  // #1062 review follow-up: when the CI gate finalized during this run, hand its
  // exact-head conclusion to the requirement-trace advisory diagnostics (an
  // `external_state` row reports the known state, or explicitly that none was
  // observed). Diagnostic-only: it never changes a disposition, and the gate's
  // read was already paid for by the gate itself — no new forge call here.
  let traceCiState: string | null = null;
  if (ciFork !== null) {
    const gateFinal = /^ci-status-final=([A-Za-z0-9._-]+)$/m.exec(ciGateOutputsFromText(ciGateRawText));
    if (gateFinal?.[1] !== undefined) traceCiState = gateFinal[1];
  }
  // #1594: the CI gate's head-bound check evidence, parsed from the raw
  // gate-output text read once after the join (the `ciGateOutputs` whitelist
  // filters this line out of the published action outputs). The gate's read
  // was already paid for — no new forge call, no new model call. An
  // unusable line is null: enforcement then behaves exactly pre-#1594.
  let ciGateEvidence: HeadBoundCiEvidence | null = null;
  if (ciFork !== null) {
    ciGateEvidence = parseHeadBoundCiEvidence(/^ci_checks_evidence=([^\r\n]*)$/m.exec(ciGateRawText)?.[1]);
  }
  const ledgerValue = safeJson(ws.read("requirement-ledger.json"));
  // #959: the in-scope ids are computed once here and reused by the repair
  // pass below, so the prompt, the repair and the validator all see the same
  // scope.
  const traceScopeIds = requirementTraceEnabled
    ? requirementTraceScope(ledgerValue, traceChanged, { ownership: traceOwnership.rules, paths: tracePaths, fileLines: traceFileLines }).inScope.map((entry) => entry.id)
    : [];
  const distributedHints = distributedRequirementHints(ledgerValue, traceOwnership.rules, traceScopeIds);
  for (const warning of distributedRequirementWarnings(ledgerValue, traceOwnership.rules, traceScopeIds)) {
    errorLog(`requirement owners: ${warning}`);
  }
  // #1506: the in-scope requirement trace plan, so the native loop's FIRST
  // planning turn carries the requirement rows (and their distributed seam
  // hints) the merge-gating evidence is built from. The artifact is written
  // even when the feature is disabled — with ZERO rows — so a stale plan can
  // never survive into a later run's planning context.
  ws.write(TRACE_PLAN_ARTIFACT, Buffer.from(`${JSON.stringify(buildTracePlan({
    ledger: requirementTraceEnabled ? ledgerValue : null,
    scopeIds: requirementTraceEnabled ? traceScopeIds : [],
    distributedHints,
  }))}\n`, "utf8"));
  promptState = applyRequirementTraceFragment(promptState, ws, requirementTraceEnabled, undefined, traceScopeIds, distributedHints);
  // #1003 human-review triage: an operator-only, review-only opt-in. The
  // fragment adds ONE question to the reviewer and nothing else — no tool,
  // evidence, fork or model-routing capability is gated on or granted by it
  // (hence no `review-triage-enable-for-forks` sibling), and it can never
  // move the verdict. Disabled, the assembled prompt below is byte-identical
  // to pre-#1003.
  const triageEnabled = config.reviewTriage === true;
  // #1005: the trusted reviewer-routing config is read from the SAME trusted
  // base ref as the other repo-owned config, and only when triage is enabled
  // and routing is not off. The configured LOGICAL target ids are injected
  // into the triage question so the model can select only capabilities this
  // repository declared; it never sees a concrete GitHub user or team.
  const routingMode: HumanReviewRoutingMode = config.reviewTriageRoutingMode === "advisory" || config.reviewTriageRoutingMode === "request"
    ? config.reviewTriageRoutingMode
    : "off";
  const reviewerRouting = triageEnabled && routingMode !== "off" && baseRef !== ""
    ? resolveReviewerRouting({ baseRef, workspace })
    : { targets: new Map() as ReadonlyMap<string, { users: readonly string[]; teams: readonly string[] }>, warnings: [] as readonly string[], sourcePath: null };
  for (const warning of reviewerRouting.warnings) errorLog(`reviewer routing: ${warning}`);
  promptState = applyReviewTriageFragment(promptState, triageEnabled, [...reviewerRouting.targets.keys()]);
  env.SYSTEM_PROMPT = `${promptState.systemPrompt}${env.REPOSITORY_SKILLS_CATALOG ?? ""}`;

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
      await runToolHarnessPhase(ws, env, workspace, log, cancellation.scope.signal, adapter.ghApi.bind(adapter));
      checkpoint();
    }
    corpusResult = assembleCorpus(ws, env, budgets, profileKey, "primary", generatedPaths, standards);
    if (corpusResult.overBudget) errorLog(`ERROR: assembled corpus exceeds its context budget`);
    ws.write("review-corpus.truncated.md", ws.read(corpusResult.outputName) ?? new Uint8Array(0));
  }

  // ── Review stage (review.sh) ─────────────────────────────────────────
  // A model verdict that arrives after the caller cancelled is refused here,
  // before it can reach the escalation, repair or enforcement stages.
  checkpoint();
  const userMessage = buildUserMessage(ws, "classification.json");
  const primary = await producePrimaryReview({
    env, ws, profiles, streamBool, userMessage, log, errorLog, annotate, clock, sleep: dependencies.sleep, budgets,
    signal: cancellation.scope.signal,
    generatedPaths, standards, runDir, workspace,
    ghApi: adapter.ghApi.bind(adapter),
  });
  checkpoint();
  let analysisEngine = primary.analysisEngine;
  let primaryProduced = primary.fromPrimary;
  let artifact = primary.artifact;

  // ── Escalation (#721: reviewer-requested only) ───────────────────────
  let escalationReasons = "";
  let enforcementHarness = "tool-harness.json";
  // #1598: when the fallback evidence failover ran, the fallback harness
  // artifact is the enforcement evidence surface (the loop that actually
  // investigated). Smart escalation cannot follow: the #721 gate requires a
  // primary-produced artifact (`fromPrimary`), so a fallback-authored review
  // never escalates and no override exists on this path.
  if (primary.fromFallback && primary.fallbackNativeLoopRan && ws.isFile("tool-harness.fallback.json")) {
    enforcementHarness = "tool-harness.fallback.json";
  }
  // #1504: true when the smart review succeeded and its artifact is the
  // authoritative one — the trace repair must then ride the smart lane.
  let escalatedToSmart = false;
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
      env, ws, profiles, streamBool, userMessage, log, errorLog, annotate, clock, sleep: dependencies.sleep,
      budgets, generatedPaths, standards, runDir, workspace,
      signal: cancellation.scope.signal,
      ghApi: adapter.ghApi.bind(adapter),
    });
    delete env.TOOL_ESCALATION;
    checkpoint();
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
      escalatedToSmart = true;
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
  // the missing ids. #1504: the pass is a context-rich bounded FALLBACK to
  // the native loop's own trace-only repair, and it rides the route that
  // produced the authoritative accepted review artifact — primary review →
  // primary repair, fallback review → fallback repair, escalated smart
  // review → smart repair — never a lane already known terminal for the run
  // (a lane that produced the artifact is by definition not terminal, and a
  // lane that went terminal never produced the artifact this would repair).
  // Gated on the default prompt (`isDefault`): the repair IS the trace
  // fragment's retry, so with an operator replace-mode prompt there is no
  // fragment to retry and the documented fail-closed behavior stands.
  // Fail-soft: any failure leaves the artifact unchanged, and the missing
  // rows then render as "the reviewer reported no trace" rather than
  // implying enforcement does not exist. A claim that IS present with
  // unusable locations is never repaired, so this cannot become a way to
  // pass an untraceable change.

  // ── Enforcement (review.sh) + requirement coverage ───────────────────
  const reviewRecord = (artifact ?? {}) as Record<string, unknown>;
  const ciChecksContent = ciChecksBytes(env);
  const ciChecksMarkdown = ciChecksContent === null ? null : Buffer.from(ciChecksContent).toString("utf8");
  // Defense in depth alongside the reader's hex-SHA check
  // (source-verifier.ts): pass `null` here whenever the candidate
  // revision is not a syntactically valid 40/64-char hex SHA. The reader
  // validates before reading, but the boundary caller should not hand
  // a non-SHA revision to `authorizesLiteralClaim` and rely on the
  // downstream reject to do the right thing — pass `null` explicitly
  // so every `unverified` demotion gets a clear `no-exact-revision`
  // reason instead of a stringly-typed free-form input. Hoisted so the
  // blocker-verification artifact (#1016) persists the same validated
  // revision the verifier received, not the raw free-form input.
  const HEX_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
  const candidateRevision = context.headSha || String(pr.headRefOid ?? "") || "";
  const expectedRevision = HEX_SHA_RE.test(candidateRevision) ? candidateRevision : null;
  let blockerVerification: Awaited<ReturnType<typeof applyBlockerVerification>> | null = null;
  let verificationOptions: Parameters<typeof applyBlockerVerification>[1] | null = null;
  if (Array.isArray(reviewRecord.findings)) {
    capCiEvidenceFindings(reviewRecord.findings as ArtifactFinding[], ciChecksMarkdown);
    // #1238: the WORKFLOW-side witness — the input names the REVIEWED
    // repository's own workflows pass to this action, read at the exact
    // reviewed head. It answers the half of the input mapping the action
    // side cannot: what the workflow actually passes.
    //
    // The witness is PER FILE: only a workflow file that was read
    // completely AND invokes this action directly has an entry, so the
    // boundary may only speak about the file a finding itself cited. A
    // repository that reaches the action through a composite action has
    // no entry, so the witness says nothing about that mapping.
    //
    // The witness CORROBORATES and never refutes: it grounds a
    // workflow-scoped claim about the mapping when the cited file's direct
    // action step passes that name, and it establishes no absence — the
    // reader sees only the direct action steps, so an uncorroborated claim
    // stays undecided and the review fails closed on it.
    //
    // Built ONCE, before the options object, so the pre-settlement and the
    // post-settlement pass see the same witness. A failure is NO witness
    // (null), never an exception into the review pipeline: an unavailable
    // witness leaves the boundary's behavior exactly as it was.
    const workflowInputs = await readWorkflowInputNamesByFile({
      workspace,
      revision: expectedRevision,
      actionSlug: resolveActionSlug(),
    }).catch(() => null);
    verificationOptions = {
      readSource: createHeadSourceReader({ workspace, revision: expectedRevision }),
      expectedRevision,
      declaredActionInputs: new Set(contract.inputs.map((input) => input.id)),
      // #1238: the workflow-side witness, keyed by the workflow file that
      // passes the names. Absent (null) whenever the reviewed repository's
      // workflows could not be read or do not invoke this action — then no
      // claim is decided with it.
      workflowInputsByFile: workflowInputs,
      // #1240: the build stamp of the revision THIS run executes. The
      // action-input and gate-absence witnesses speak for the executing
      // revision's release line only, so a claim that names a different
      // line or another patch is unverified — never refuted, never
      // grounded. The value comes from the bundle's OWN build stamp
      // (src/version.ts) and never from an environment variable, an Action
      // input, or any byte outside the bundle. On the dogfood path the
      // bundle itself is built from the PR head, so the stamp — like the
      // embedded contract — inherits the PR's trust level. The one
      // exception is the golden-replay test seam
      // (`dependencies.executingActionVersion`, #1240): a test-host-only
      // dependency, the same class of injection as `adapter` itself; no
      // production path sets it.
      executingActionVersion: dependencies.executingActionVersion ?? ACTION_VERSION,
      // #1238: the gate-absence witness — the EXECUTING action's own
      // implementation, embedded into THIS BUNDLE at build time (the bundle
      // IS the implementation that runs; the action's install directory's
      // `src/` is not what executes), so the bytes a gate-absence claim is
      // checked against are revision-bound by construction and no
      // filesystem read can be raced (#1240). The reviewed repository's
      // checkout is passed along: a root inside it is the `uses: ./` shape,
      // where the executing bytes are PR-controlled and must never decide a
      // refutation. Both boundary passes share this options object, so the
      // post-settlement pass sees the same witness.
      readActionSource: createActionSourceReader({ workspaceRoot: workspace }),
      // #1240 (pinned-revision witness): the exact commit the CONSUMER
      // pinned this run's action step, per the runner's own metadata
      // (`GITHUB_ACTION_REPOSITORY` + `GITHUB_ACTION_REF`). A claim that
      // names a revision the executing witnesses do not answer for is
      // decided against THIS pinned revision's own manifest and gate
      // implementation — fetched through the platform's validated,
      // origin-pinned read-only API seam at the exact content-addressed
      // commit, never from the reviewed workspace's bytes. Any pin that is
      // not a full commit SHA (tag, branch, `uses: ./`, missing metadata)
      // admits NO pinned witness: those claims stay unverified exactly as
      // before, and a Forgejo deployment whose seam cannot serve contents
      // reads fails the same way. The identity rule that keeps planted
      // bytes out — a pin naming the repository under review admits no
      // witness — lives in resolvePinnedActionRevision itself.
      pinnedActionSource: (() => {
        const pinned = resolvePinnedActionRevision();
        return pinned === null
          ? null
          : createPinnedActionWitness({ pinned, ghApi: (endpoint, opts) => adapter.ghApi(endpoint, opts) });
      })(),
    };
    blockerVerification = await applyBlockerVerification(reviewRecord.findings as ArtifactFinding[], verificationOptions);
  }
  // #1517: the negative-evidence rules this run's evidence phase derived
  // (clean trusted provider runs whose operator spec declared a covered
  // domain). Freshness is re-checked HERE against the exact head under
  // review: a rule (or sidecar) whose recorded head differs from this run's
  // validated revision is stale evidence and is dropped, never applied. No
  // rules — the normal case for every run whose providers declare no
  // negative_evidence — leaves the review path byte-identical to before.
  const negativeEvidence = negativeEvidenceRulesFromArtifact(
    safeJson(ws.read(EVIDENCE_NEGATIVE_EVIDENCE_FILE)),
    expectedRevision,
  );
  const verdictPolicy = env.VERDICT_POLICY ?? "strict";
  // Captured before any layer mutates it: the strict mapping (#811) takes the
  // model verdict as an input, not as the final answer.
  const modelVerdict = String(reviewRecord.verdict ?? "");
  // #1594: the CI gate's head-bound evidence reconciles test-run asks in
  // both enforcement layers. Null without a gate run (or without a usable
  // evidence line) keeps every output byte-identical to pre-#1594. The
  // executed-call citation gate (#1627) joins this object AFTER the
  // obligation resolution below (it needs the resolved rows' index), so the
  // pre-resolution fields live on the base object.
  const completenessBaseOptions = {
    enabled: env.VALIDATE_REQUIRED_CHECKS ?? "auto",
    mode: env.REQUIRED_CHECK_VALIDATION_MODE ?? "warn",
    mustCheck: stringList(classificationArtifact.must_check),
    ciEvidence: ciGateEvidence,
    reviewedHeadSha: context.headSha || String(pr.headRefOid ?? ""),
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
  // #1381: the folded review-owned obligation rows ride the enforcement
  // inputs so the gate runs inside applyAllEnforcement (with the banner
  // normalization) and the anti-relax signal is computed once, here.
  // #1449: the derived pre-pass output joins the SAME rows — there is no
  // second enforcement path: an unresolved derived row is disclosed by the
  // same gate, withholds the trusted approval (at the publish boundary) and
  // makes the review partial, but it never forces a verdict (it is coverage,
  // not a defect — see `isForcingObligation`).
  const resolvedObligations = resolveReviewObligations(
    classificationArtifact,
    reviewRecord,
    ws,
    enforcementHarness,
    env.VALIDATE_REQUIRED_CHECKS,
    derivedObligationsEnabled,
    ciGateEvidence,
    completenessBaseOptions.reviewedHeadSha,
    riskObligationsEnabled,
  );
  // #1627: the #750 completeness fold gates the SAME satisfied answers with
  // the SAME executed-call index the #1381 fold was given, so the two folds
  // can never disagree on a cited satisfaction. When the gate is inert (no
  // trace at all) the option is omitted and the fold is byte-identical; a
  // REFUSED trace passes the active-but-uncitable index, failing every
  // gated satisfaction closed on both folds.
  const completenessOptions = {
    ...completenessBaseOptions,
    ...(resolvedObligations.executedCalls.gate ? { executedCalls: resolvedObligations.executedCalls } : {}),
  };
  enforcementInputs.reviewObligations = resolvedObligations.obligations;
  persistReviewObligations(ws, resolvedObligations.obligations, resolvedObligations.dispositionReceipt, log);
  // #1449: the run's derived-obligation state — "" when the feature is off,
  // so a disabled run's coverage record and marker keep their pre-#1449
  // bytes exactly.
  const derivedState = derivedObligationState(resolvedObligations.derived, resolvedObligations.obligations);
  // #1449: the reason that EXPLAINS the state: the closed coverage reason
  // when the derivation never completed, `not-discharged` when the coverage
  // is complete but a derived row stayed open, null when every row was
  // discharged. The state alone never said why.
  const derivedReason = derivedObligationStateReason(resolvedObligations.derived, resolvedObligations.obligations);
  persistDerivedObligationState(ws, resolvedObligations.derived, resolvedObligations.obligations, derivedReason);
  // #1505: the run's required-evidence state — "" when the contract was
  // inactive, so an inactive run's coverage record and marker keep their
  // pre-#1505 bytes exactly.
  const requiredState = requiredEvidenceObligationState(resolvedObligations.contractActive, resolvedObligations.obligations);
  persistRequiredEvidenceState(ws, resolvedObligations.contractActive, resolvedObligations.obligations);
  // #874: the ledger (read above for the #959 trace scope) feeds the trace
  // escalation, which must be visible to the verdict mapping, not just
  // recorded afterward.
  let requirementTraceResult: ReturnType<typeof applyRequirementTraceEnforcement> | null = null;
  let completenessResult: ReturnType<typeof applyRequiredCheckValidation> | null = null;
  let completenessStatus = "none";
  if (analysisEngine === MODEL_UNAVAILABLE_ENGINE) {
    // on-model-failure=notice (#863): no model reviewed this PR, so the
    // notice's request_changes is final; no verdict policy may relax it.
    // No enforcement overlay runs on this branch, so its block is entirely notice-derived.
  } else if (verdictPolicy === "strict") {
    // #811 composition (same order as the enforcement-pipeline fixture):
    // coverage, then the enforcement overlays, then the strict mapping over
    // the final still-open findings set. #874's requirement-trace pass runs
    // between completeness and the overlays: it needs completeness's
    // `required_checks` write to have already happened (its own escalation
    // must not be clobbered by it), and its synthesized findings must be in
    // place before the strict mapping counts open findings.
    completenessResult = applyRequiredCheckValidation(reviewRecord as never, completenessOptions);
    completenessStatus = completenessResult.status;
    requirementTraceResult = applyRequirementTraceEnforcement(reviewRecord as never, { enabled: requirementTraceEnabled, ledger: ledgerValue, workspace, changed: traceChanged, ownership: traceOwnership.rules, paths: tracePaths, fileLines: traceFileLines, prBody: tracePrBody, ciState: traceCiState });
    applyAllEnforcement(reviewRecord as never, enforcementInputs);
    // #1238: thread settlement (inside the overlays) re-emits prior reviews'
    // findings after the boundary ran; verify them too so a carried-over
    // fabricated claim cannot re-enter as a live blocker. The boundary skips
    // findings it already processed.
    if (verificationOptions !== null && Array.isArray(reviewRecord.findings)) {
      // Only findings the first pass never classified (grounded findings
      // carry no grounding_status, so the processed-index set is the reliable
      // record — re-reading grounded claims would spend the source-read
      // budget twice). Re-emitted findings sit at new array positions and
      // are verified here. The filtered array reindexes from zero, so the
      // pass's entry indices are remapped back to absolute positions before
      // the merge (the artifact is a diagnostic consumed by position).
      const processed = new Set((blockerVerification?.findings ?? []).map((entry) => entry.index));
      const pending: ArtifactFinding[] = [];
      const absoluteIndex: number[] = [];
      (reviewRecord.findings as ArtifactFinding[]).forEach((finding, index) => {
        if (!processed.has(index)) {
          pending.push(finding);
          absoluteIndex.push(index);
        }
      });
      const settledPass = await applyBlockerVerification(pending, verificationOptions);
      for (const entry of settledPass.findings) {
        entry.index = absoluteIndex[entry.index] ?? entry.index;
      }
      blockerVerification = mergeBlockerVerificationPasses(blockerVerification, settledPass);
    }
    // #1517: deterministic negative evidence runs after BOTH verification
    // passes (so a verifier `unverified` status is never overwritten by a
    // demotion — a contradictory clean tool signal and an uncheckable source
    // claim keep the fail-closed strict mapping) and before the strict
    // mapping, which sees the final severities. Covers thread re-emissions.
    applyNegativeEvidenceToRecord(reviewRecord, negativeEvidence.rules, negativeEvidence.stale);
    // #1449: the derived rows are COVERAGE rows, so only the FORCING sources
    // (the operator's `must_check` checklist and the trusted base's
    // `trusted_base_guidance` asks) reach the strict mapping's anti-relax
    // signal. An undischarged derived obligation never demotes an approve
    // into a blocking request (#1447: "preserve the existing distinction
    // between found defect and review incomplete / abstain"); it withholds
    // the trusted approval at the publish boundary instead. A run without
    // derived rows keeps the #1381 text and its order byte-for-byte.
    const unresolvedRequiredObligations = unresolvedReviewObligations(
      resolvedObligations.obligations.filter((obligation) => isForcingObligation(obligation)),
    );
    // The obligation gate (#1381) ran inside applyAllEnforcement and rides
    // failClosedEnforcementFired, so the strict mapping can never relax a
    // verdict it forced.
    const forced = failClosedEnforcementFired(enforcementInputs)
      || (completenessResult.status === "incomplete" && completenessResult.mode === "fail");
    // #1016: the strict mapping computes the unknown-evidence forcing
    // signal from the artifact's own `grounding_status` field — any
    // demoted finding with `grounding_status === "unverified"` forces
    // `request_changes` with a #1016 attribution note so an approve cannot
    // silently certify a claim the verifier never checked.
    applyStrictVerdictPolicy(reviewRecord as never, {
      modelVerdict,
      forced,
      unmetReviewObligations: unresolvedRequiredObligations,
    });
    // The strict mapping can derive an approve after the enforcement banner
    // was written; reconcile the markdown with the final verdict.
    reconcileEnforcedReviewMarkdown(reviewRecord as never);
  } else {
    applyVerdictPolicy(reviewRecord as never, verdictPolicy, {
      nonBlockingCategories: new Set(splitCsv(env.NON_BLOCKING_FINDING_CATEGORIES ?? "")),
      securityFlagged: isSecurityFlagged(classificationArtifact),
    });
    completenessResult = applyRequiredCheckValidation(reviewRecord as never, completenessOptions);
    completenessStatus = completenessResult.status;
    requirementTraceResult = applyRequirementTraceEnforcement(reviewRecord as never, { enabled: requirementTraceEnabled, ledger: ledgerValue, workspace, changed: traceChanged, ownership: traceOwnership.rules, paths: tracePaths, fileLines: traceFileLines, prBody: tracePrBody, ciState: traceCiState });
    applyAllEnforcement(reviewRecord as never, enforcementInputs);
    // #1238: second boundary pass over findings thread settlement re-emitted
    // (same rationale as the strict branch above); the relaxers below then
    // see the final grounding states.
    if (verificationOptions !== null && Array.isArray(reviewRecord.findings)) {
      // Only findings the first pass never classified (grounded findings
      // carry no grounding_status, so the processed-index set is the reliable
      // record — re-reading grounded claims would spend the source-read
      // budget twice). Re-emitted findings sit at new array positions and
      // are verified here. The filtered array reindexes from zero, so the
      // pass's entry indices are remapped back to absolute positions before
      // the merge (the artifact is a diagnostic consumed by position).
      const processed = new Set((blockerVerification?.findings ?? []).map((entry) => entry.index));
      const pending: ArtifactFinding[] = [];
      const absoluteIndex: number[] = [];
      (reviewRecord.findings as ArtifactFinding[]).forEach((finding, index) => {
        if (!processed.has(index)) {
          pending.push(finding);
          absoluteIndex.push(index);
        }
      });
      const settledPass = await applyBlockerVerification(pending, verificationOptions);
      for (const entry of settledPass.findings) {
        entry.index = absoluteIndex[entry.index] ?? entry.index;
      }
      blockerVerification = mergeBlockerVerificationPasses(blockerVerification, settledPass);
    }
    // #1517: deterministic negative evidence (same placement rationale as
    // the strict branch: after both verification passes, before the verdict
    // relaxers see the final severities).
    applyNegativeEvidenceToRecord(reviewRecord, negativeEvidence.rules, negativeEvidence.stale);
    // #977: the model's own request_changes is relaxed only when every
    // still-open finding is a verification ask and no independent
    // deterministic gate fired. The overlays above have already run, so
    // their blocks are visible here.
    //
    // #1449: only the FORCING obligation rows gate the relaxation — an
    // undischarged derived obligation is missing coverage, not a defect, so
    // it must not keep a relaxed (or relaxed-then-approved) review blocked
    // on its own. The derived state still withholds the trusted approval at
    // the publish boundary, so nothing here can certify an approve.
    const unresolvedObligations = unresolvedReviewObligations(
      resolvedObligations.obligations.filter((obligation) => isForcingObligation(obligation)),
    );
    // The obligation gate (#1381) ran inside applyAllEnforcement and rides
    // failClosedEnforcementFired, so the relaxers below refuse when it fired.
    const forced = failClosedEnforcementFired(enforcementInputs)
      || (completenessResult.status === "incomplete" && completenessResult.mode === "fail");
    relaxVerificationOnlyVerdict(reviewRecord as never, { forced, unmetReviewObligations: unresolvedObligations });
    relaxCiOnlyVerdict(reviewRecord as never, { forced, unmetReviewObligations: unresolvedObligations });
    // #1016: relaxUnverifiedBlockerVerdict itself refuses to relax when any
    // demoted finding has `grounding_status === "unverified"` (unknown
    // evidence, not a refutation) — the verifier did not disprove the
    // claim, so a clean review cannot be certified.
    relaxUnverifiedBlockerVerdict(reviewRecord as never, { forced, unmetReviewObligations: unresolvedObligations });
    // #977: the relaxation can flip the model's request_changes to approve
    // after the enforcement banner was written; reconcile the markdown with
    // the final verdict.
    reconcileEnforcedReviewMarkdown(reviewRecord as never);
  }
  // #1518: the merge-gating ids of the deterministic enforcement pass. They
  // are computed AFTER both enforcement branches, so the strict path and the
  // non-strict path carry the same ids, and they name the obligations that
  // stayed open (a required check the reviewer did not resolve, a
  // requirement the trace could not discharge) rather than only that the
  // coverage was incomplete.
  // #1541: the count is the number of distinct ids the enforcement pass
  // produced. A pass that never ran produced no ids, so the count is zero
  // and the list is empty — the same shape the documents already carried
  // for that case.
  const unresolvedRequiredChecks = completenessResult === null ? emptyMergeGatingIds() : unresolvedRequiredCheckIds(completenessResult);
  // #1594: persist the RECONCILED completeness result so the standalone
  // `publish` process (a separate process from `run`) reads back the same
  // CI-evidence-reconciled rows instead of re-folding the raw #750 coverage
  // and disagreeing with the engine's disposition. The result object is the
  // snake_case v2-shape with the per-row `reason` codes, version-tagged so
  // the strict reader can tell an artifact this runtime wrote from any
  // other file. A run whose fold never ran (`none`) writes nothing, so a
  // pre-#1594-shaped run dir keeps its bytes exactly.
  if (completenessResult !== null && completenessStatus !== "none") {
    ws.write("required-check-coverage.json", pyJsonDumps({ version: 1, ...completenessResult.result }));
  }
  const unresolvedRequirementIds = requirementTraceResult === null ? emptyMergeGatingIds() : unresolvedTraceRequirementIds(requirementTraceResult.trace);
  // #1521: the obligation rows that BLOCKED this review, computed AFTER both
  // enforcement branches for the same reason the two id lists above are:
  // the strict path and the non-strict path carry the SAME rows, and the
  // rows are the enforcement pass's own output — never a model claim. A
  // `derived` row is coverage, not a block, so it never rides here.
  //
  // The model-unavailable path runs NO enforcement overlay (its block is the
  // notice's own request_changes), so no obligation row blocked that review.
  // The rows would otherwise be the fallback must_check rows the engine
  // builds when the harness never wrote the candidates artifact, and a
  // published handoff that names them would tell a controller the review
  // was blocked by checks the review never performed.
  const blockingObligationRows = analysisEngine === MODEL_UNAVAILABLE_ENGINE
    ? []
    : blockingReviewObligations(resolvedObligations.obligations);
  if (blockerVerification !== null && blockerVerification.demoted > 0) {
    ws.write("blocker-verification.json", Buffer.from(`${pyJsonDumps({
      version: 1,
      // #1016: persist the validated revision the verifier received — the
      // raw `context.headSha || String(pr.headRefOid ?? "") || ""` fallback
      // above can be a free-form string when neither field is a hex SHA,
      // but the verifier rejects it to `null` before any read. Recording
      // what was actually validated keeps the artifact consistent with
      // the verifier's own input and any future consumer that joins on
      // `expected_revision`.
      expected_revision: expectedRevision ?? null,
      demoted: blockerVerification.demoted,
      findings: blockerVerification.findings,
    })}\n`, "utf8"));
    reviewRecord.review_markdown = String(reviewRecord.review_markdown ?? "")
      + `\n\n_${blockerVerification.demoted} finding(s) making source-backed claims that deterministic verification positively contradicted or could not substantiate are listed above as non-blocking. Deterministic enforcement gates are unaffected._`;
  }
  // #1337: the reviewer-reported coverage-accounting block is appended
  // after every enforcement/reconcile pass (nothing re-scans it), the same
  // post-reconcile append position the blocker-verification note uses.
  // Gated on BOTH the deterministic detection having fired (the section is
  // non-empty — a stray answer on a non-dependency PR never publishes) and
  // the model having emitted a real `dependency_coverage` answer; the
  // publish boundary still sanitizes the whole markdown afterwards.
  const dependencyCoverageFired = (ws.read("dependency-coverage.md")?.length ?? 0) > 0;
  const dependencyCoverageBlock = dependencyCoverageFired
    ? renderDependencyCoverageBlock(
      (reviewRecord as { dependency_coverage?: unknown }).dependency_coverage as never,
    )
    : "";
  if (dependencyCoverageBlock !== "") {
    reviewRecord.review_markdown = String(reviewRecord.review_markdown ?? "") + "\n\n" + dependencyCoverageBlock;
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
    // #1575: the persisted JSON is not uploaded by our ordinary PR workflow.
    // Make the FINAL post-repair validator outcome diagnosable without more
    // model calls. This logs only fixed code labels and safe requirement ids.
    const finalFailure = finalTraceFailureLog(requirementTraceResult.trace);
    if (finalFailure !== "") log(finalFailure);
  }

  // ── Outputs + step summary (review.sh tail) ──────────────────────────
  const harnessForMarker = safeJson(ws.read(enforcementHarness));
  const cacheHitRatio = buildCacheHitRatioOutput(harnessForMarker);
  // #1598: the escalated tool-calls surface follows the enforcement harness
  // actually used — smart, or the fallback tier's when its evidence failover
  // authored the authoritative artifact.
  const escalatedHarnessTier = enforcementHarness === "tool-harness.smart.json"
    ? "smart"
    : enforcementHarness === "tool-harness.fallback.json" ? "fallback" : null;
  const toolCalls = buildToolCallsOutput(
    safeJson(ws.read("tool-harness.json")),
    escalatedHarnessTier !== null ? safeJson(ws.read(enforcementHarness)) : null,
    escalatedHarnessTier ?? "smart",
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
  // #978: persist whether this verdict can bypass fail-on-request-changes,
  // not merely whether some part of the tool loop degraded.
  const nativeLoopDegraded = (harnessForMarker as { native_loop_degraded?: unknown } | null)?.native_loop_degraded;
  const noEvidenceGathered = typeof nativeLoopDegraded === "string" && nativeLoopDegraded.length > 0;
  // The authoritative trace-incomplete flag covers both unmet and
  // unverifiable rows. Policy and enforcement have finished before this
  // snapshot, so the final verdict and provenance are authoritative here.
  const verdictSource = String(reviewRecord.verdict_source ?? "model");
  const deterministicBlock = computeDeterministicBlock({
    enforcementInputs,
    completeness: completenessResult,
    requirementTraceIncomplete: traceIncomplete,
    finalVerdict: outputVerdict,
    verdictSource,
  });
  // The notice branch skips every enforcement overlay, so its request_changes
  // is entirely notice-derived and there is no deterministic block to override.
  // No-evidence eligibility is deliberately fallback-only: primary corpus
  // reviews after zero tool calls do not inherit #978's exemption.
  const degradedGateBypass = resolveDegradedGateBypass({
    notice: analysisEngine === MODEL_UNAVAILABLE_ENGINE,
    fromFallback: primary.fromFallback,
    noEvidenceGathered,
    deterministicBlock,
  });
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
    // #1543: the #750 fold's OWN status, before any #874 trace flip — the
    // final `required_checks` above can read `incomplete` on a run whose fold
    // never validated (`validate-required-checks: false`, or `auto` with an
    // empty must_check list, records `none` here while the trace pass still
    // flips the published dimension). The standalone publish read-back
    // (#1537) gates its required-check id recomputation on THIS field, so a
    // fold that never gated the review can never have its `must_check` items
    // named. The model-unavailable notice path never assigns
    // `completenessStatus`, so it records `none` like any non-validating run
    // (its whole read-back is gated out earlier by the engine record).
    required_check_fold_status: completenessStatus,
    ...(incompleteReason !== "none" ? { incomplete_reason: incompleteReason } : {}),
    // #1449: the derived-obligation state of THIS run — present only when
    // the feature is enabled (a disabled run keeps the record
    // byte-identical). The reason is the closed reason token that explains
    // the state (the coverage reason when the derivation never completed,
    // `not-discharged` when a row stayed open, null when all were
    // discharged).
    ...(derivedState !== "" ? {
      derived_obligation_state: derivedState,
      derived_obligation_reason: derivedReason,
    } : {}),
    // #1505: the required-evidence state of THIS run — present only when
    // the contract was active (an inactive run keeps the record
    // byte-identical). The reason distinguishes a discharged contract from
    // one that stayed open.
    ...(requiredState !== "" ? {
      required_evidence_state: requiredState,
      required_evidence_reason: requiredState === "complete" ? null : "not-discharged",
    } : {}),
  };
  ws.write("review-coverage.json", Buffer.from(`${pyJsonDumps(reviewCoverage)}\n`, "utf8"));

  // #726: the scorer is an outbound model call, so it sits behind the same
  // stage-boundary checkpoint as every other spend — a run cancelled during
  // enforcement must not dial the scorer. The scorer's own deps carry no
  // signal (pre-#1073 shape inherited from main), so this boundary is the
  // cancellation coverage for the stage.
  checkpoint();

  // ── #1073/#1369: the independent post-review merge-safety verifier ──
  // Advisory telemetry only. Runs once, after enforcement and the coverage
  // record are final and only when this run will actually publish a review:
  // one bounded, tool-free model call independently reads the PR diff and
  // description and audits the finished review against the actual change —
  // hunting for missed blocker/major defects and materially unsupported
  // findings, and reporting its own structured concerns. The result never
  // alters the verdict, review_result, required checks, escalation reason,
  // native review events, or approvals, and it never writes into any
  // reviewRecord field the enforcement/marker pipeline reads — it flows only
  // into its own outputs, step-summary row, published section, marker keys,
  // and artifact. Disabled (the default) means none of that exists: no
  // request, no artifacts, no section, no marker keys; the five confidence-*
  // output assignments stay empty.
  const confidenceResolution = resolveConfidenceProfile(env);
  for (const warning of confidenceResolution.warnings) log(`WARNING: ${warning}`);
  // The scorer's eligibility gate is now EXACTLY the `shouldPublish` decision
  // the action entry applies at the publish seam: the publish mode alone
  // decides, for every mode including `comment` (#1158 — the legacy
  // `publish-review-comment` flag no longer gates publication anywhere) and
  // `review_blockers` counts as publishing like the other native modes
  // (shared `publishStepRuns` predicate, so the two sites cannot diverge).
  // A run whose publish step is skipped still gets no privileged scorer call.
  const reviewWillPublish = publishStepRuns(env.PUBLISH_MODE);
  const confidenceProfile = confidenceResolution.profile;
  // #1368: additive provenance for the confidence-score.json artifact — what
  // the scorer's request was budgeted/asserted to carry. Included whenever
  // the profile was enabled (scored and unscored paths alike); the disabled
  // path writes no artifact at all.
  //
  // #998's truth-telling rule: `reasoning_effort_sent` is a WIRE fact, not a
  // config fact. The scorer's outcome is the authority for it — the effort is
  // read back from the body the transport sent — so a path that sent no
  // request at all (the publish gates below, or the scorer's own pre-wire
  // refusals) records false even when the configuration named an effort. A
  // request the transport sent but the provider never answered still counts
  // as sent: the bytes carried the effort.
  const confidenceProvenance = (effortSent: boolean): ConfidenceRequestProvenance | undefined =>
    confidenceProfile.enabled ? {
      max_tokens: confidenceProfile.maxTokens,
      prompt_tokens: confidenceProfile.promptTokens,
      model_context_tokens: confidenceProfile.modelContextTokens,
      reasoning_effort_sent: effortSent,
      anthropic_effort_support: confidenceProfile.anthropicEffortSupported,
      structured_output_support: confidenceProfile.structuredOutputSupported,
    } : undefined;
  // #1155: the proof-context pins the scorer call is anchored to. An empty
  // one means the score would grade content (or an outcome) this run could
  // not identify — strictly worse than a low-confidence score, an unanchored
  // one — so the run fails to `unscored` WITHOUT calling the model,
  // alongside the existing `not_published` / `incomplete_review` shapes.
  // `unresolvedConfidencePins` is the ONE predicate, shared with the
  // prompt's own `unknown` rendering, so gate and prompt cannot diverge.
  const confidenceProofPins = {
    headSha: context.headSha || String(pr.headRefOid ?? ""),
    baseSha: identity.baseSha ?? "",
    reviewResult: markerReviewResult({
      verdictPolicy,
      verdict: outputVerdict,
      findings: reviewRecord.findings,
      requiredChecks: outputRequiredChecks,
      partialCoverage,
      degradedGateBypass,
      // #1449: an undischarged derived obligation is missing coverage, so the
      // review reads `partial` — never `clean`, and never a manufactured
      // `issues`. Absent when the feature is off.
      ...(derivedState !== "" ? { derivedObligationState: derivedState } : {}),
      // #1505: unresolved required review evidence is a coverage state too —
      // the review reads `partial`, never `clean`, while required evidence
      // stayed ungathered. Absent when the contract was inactive.
      ...(requiredState !== "" ? { requiredEvidenceState: requiredState } : {}),
    }),
  };
  const unresolvedProofPins = unresolvedConfidencePins(confidenceProofPins);
  // #1455: the verifier's own telemetry — the unscored cause, the measured
  // latency and the provider's token counts. Both the measured values stay
  // null until the scorer's ONE wire attempt actually happened: the
  // pre-wire gates below never call the model, so they carry neither, and a
  // duration for a call that never happened would be a claim the run cannot
  // back.
  let confidenceLatencyMs: number | null = null;
  let confidenceUsage: ConfidenceUsageTelemetry | null = null;
  let confidenceResult: ConfidenceResult;
  if (!confidenceProfile.enabled) {
    // Disabled: no request, no artifacts, no outputs.
    confidenceResult = CONFIDENCE_DISABLED;
    clearConfidenceArtifacts(ws);
  } else if (!reviewWillPublish) {
    // Defensive: the entry's publish step is skipped for this run, so no
    // publish seam can produce a body for a score to sit in — and no
    // privileged scorer call may fire for a review that never publishes.
    // The cause still lands in the artifact and the log, so an operator can
    // tell "the publish step was skipped" from "the scorer call failed".
    confidenceResult = unscoredConfidenceResult("not_published");
    removeConfidenceWireArtifacts(ws);
    writeConfidenceScoreArtifact(ws, confidenceResult, undefined, confidenceProvenance(false));
    log(`confidence scorer: unscored (${confidenceResult.cause})`);
  } else if (analysisEngine === MODEL_UNAVAILABLE_ENGINE || !(outputVerdict === "approve" || outputVerdict === "request_changes")) {
    // No real model review happened (a model-failure notice, or no verdict at
    // all): fail to unscored WITHOUT calling the model.
    confidenceResult = unscoredConfidenceResult("incomplete_review");
    removeConfidenceWireArtifacts(ws);
    writeConfidenceScoreArtifact(ws, confidenceResult, undefined, confidenceProvenance(false));
    log(`confidence scorer: unscored (${confidenceResult.cause})`);
  } else if (unresolvedProofPins.length > 0) {
    // #1155: a required proof-context pin did not resolve. The prompt would
    // render it as the literal `unknown` and the model would grade content
    // this run cannot identify — no deterministic ceiling looks at the pins,
    // so this is the only rail keeping an unanchored score off the wire.
    // No scorer call; the missing pins are recorded in the artifact's
    // diagnostic (the cause's own machine tokens, no untrusted content).
    confidenceResult = unscoredConfidenceResult("incomplete_proof_context");
    removeConfidenceWireArtifacts(ws);
    writeConfidenceScoreArtifact(ws, confidenceResult, `unresolved proof-context pins: ${unresolvedProofPins.join(",")}`, confidenceProvenance(false));
    log(`confidence scorer: unscored (${confidenceResult.cause})`);
  } else {
    // #1140 review: every credential configured for this run, in ONE place.
    // The scorer may be a SEPARATE backend, so each of these is a real
    // credential for this run and each must be masked out of every
    // untrusted surface below — the scorer's prompt content, its transport
    // diagnostics, and the artifacts it leaves behind. The specialist lane
    // reads its raw env key here: its resolved profile may have fallen back to
    // the primary key, and a configured specialist secret echoed in PR content
    // must not ride to the scorer either.
    const confidenceSecrets = [
      confidenceProfile.apiKey,
      endpointUrlCredentialOrEmpty(confidenceProfile.baseUrl),
      profiles.primary.apiKey,
      profiles.smart.apiKey,
      profiles.fallback.apiKey,
      env.AI_SPECIALIST_API_KEY ?? "",
    ];
    const confidencePrompt = buildConfidencePrompt({
      ...confidenceProofPins,
      diff: ws.readText("pr.diff.truncated") ?? "",
      prTitle: String(pr.title ?? ""),
      prBody: String(pr.body ?? ""),
      findings: reviewRecord.findings,
      reviewSummary: String(reviewRecord.review_markdown ?? ""),
      requiredChecks: outputRequiredChecks,
      coverage: reviewCoverage,
      secrets: confidenceSecrets,
      // #1368: the profile's overall prompt budget bounds the assembled
      // prompt (bytes/4 estimate) with explicit in-band truncation.
      promptTokens: confidenceProfile.promptTokens,
    });
    let confidenceOutcome: Awaited<ReturnType<typeof runConfidenceScorer>>;
    try {
      // Fail-soft boundary: a scorer crash (a bug, not a transport failure)
      // degrades to unscored exactly like a failed call — never aborts the
      // review that already finished.
      confidenceOutcome = await runConfidenceScorer({
        profile: confidenceProfile,
        // Defensive credential-isolation input: the scorer re-checks that a
        // distinct endpoint never carries the primary lane's key.
        primaryApiKey: profiles.primary.apiKey,
        // So the scorer's own thrown-transport/transport-failure diagnostics
        // mask the whole lane set, not just its own and the primary's key.
        laneSecrets: confidenceSecrets,
        prompt: confidencePrompt,
        connectTimeoutSec: Number(env.AI_CONNECT_TIMEOUT_SEC ?? "30") || 30,
        // #1515: the scorer is advisory work (class 4) — it admits through
        // the run-wide governor like every other model request path, WITH the
        // run's cancellation scope on the admission request itself (review
        // fix: the scorer's own signal only reaches the transport after
        // admission, so a queued scorer could otherwise dispatch after
        // cancellation). A queued-cancel surfaces as the scorer's typed
        // transport-failure path, which already degrades to unscored.
        transport: governedScorerTransport(cancellation.scope.signal),
        // #1481: no tokensParam here — the token-limit field is resolved INTO
        // the profile (routing/tiers.ts), so the scorer never receives the
        // primary lane's/global AI_TOKENS_PARAM convention on a dedicated
        // verifier.
        findings: reviewRecord.findings,
        coverage: reviewCoverage,
        // Cancellation rides the scorer call too: an aborted run tears the
        // scorer's in-flight provider request down instead of letting it run
        // on after the review it grades is already abandoned.
        signal: cancellation.scope.signal,
      });
    } catch (cause: unknown) {
      confidenceOutcome = {
        result: unscoredConfidenceResult("internal_error", confidenceProfile.model),
        requestPayload: null,
        rawResponse: null,
        // #1140 review: `maskDiagnostic` masks the configured secrets on the
        // FULL untruncated message and only then caps it, so a secret
        // straddling the 300-char boundary cannot leave a partial prefix in
        // the artifact or the log line. Masking AFTER truncation did.
        diagnostic: maskDiagnostic(cause instanceof Error ? cause.message : String(cause), confidenceSecrets),
        // A crash inside the scorer leaves the dispatch state unknown: the
        // artifact claims no effort was sent (#998: report what was SENT,
        // never what the config named — and a claim it cannot back is not a
        // claim).
        wireEffort: "",
        // #1455: a crash carries no latency and no usage — the run cannot
        // say how long a call took, nor what it cost, when it does not know
        // whether the call happened at all.
        usage: null,
        latencyMs: null,
      };
    }
    // #1455: the scorer's own measurement of its ONE wire attempt — the
    // wall-clock duration it observed and the token counts the provider
    // reported. The scorer's pre-wire refusals (a disabled profile, a missing
    // credential, a credential isolation refusal, a prompt over budget)
    // report neither, so a run that never reached the provider carries no
    // latency and no usage.
    confidenceLatencyMs = confidenceOutcome.latencyMs;
    confidenceUsage = confidenceOutcome.usage;
    // #1140 review: model-authored text (reason, concern file/evidence) is
    // masked against EVERY lane's credential BEFORE the canonical result
    // exists — every downstream consumer (persisted artifact, step outputs,
    // step summary, published section, marker, CONFIDENCE_CONCERNS env for
    // the standalone publish CLI) reads only this sanitized canonical
    // result. Generic `redactText` at the renderers stays as the second
    // layer, but the exact configured secrets are nuked here, once.
    const maskConfidenceText = (text: string): string => redactText(maskKnownSecrets(text, confidenceSecrets));
    // #1140 review round 9: exact-value masking is not length-preserving — a
    // one-character configured secret becomes the three-character `⟦•⟧` marker
    // — so a field the parser bounded to exactly its limit can leave masking
    // OVER that limit. Every published canonical field is re-bounded AFTER
    // masking, at the same documented limits the parser applies; the reason
    // keeps its deterministic-cap note through the re-bound, and that note is
    // masked TOO before being re-appended, because a configured credential may
    // be a single character occurring inside the note template.
    // #1268: the model share and the note are split BEFORE masking. Masking
    // the combined text lets `redactText` complete a look-alike the model only
    // half-wrote (the credential rule consumes the model's closing bracket and
    // the `[REDACTED]` marker supplies another), so the note travels as its
    // own value and `boundConfidenceReason` re-appends it from `caps` — never
    // parsed back out of masked text. `maskComposedConfidenceReason` then
    // closes the boundary-spanning-secret tear the split opens.
    const maskConfidenceField = (text: string, maxChars: number): string =>
      boundConfidenceField(maskConfidenceText(text), maxChars);
    const confidenceModelReason = confidenceReasonWithoutCapNote(
      confidenceOutcome.result.reason,
      confidenceOutcome.result.caps,
    );
    confidenceResult = {
      ...confidenceOutcome.result,
      reason: maskComposedConfidenceReason(
        boundConfidenceReason(
          maskConfidenceText(confidenceModelReason),
          maskConfidenceText(confidenceCapNote(confidenceOutcome.result.caps)),
        ),
        confidenceSecrets,
      ),
      concerns: confidenceOutcome.result.concerns.map((concern) => ({
        // Closed-vocabulary enum tokens (validated by the parser), not model
        // free text — carried through unmasked, like `line`.
        type: concern.type,
        severity: concern.severity,
        file: maskConfidenceField(concern.file, MAX_CONFIDENCE_CONCERN_FILE_CHARS),
        line: concern.line,
        evidence: maskConfidenceField(concern.evidence, MAX_CONFIDENCE_CONCERN_EVIDENCE_CHARS),
      })),
    };
    // Persist the sanitized artifacts alongside ai-output.json /
    // review-coverage.json. The telemetry rides the artifact too, so the
    // publish step reads the verifier's own record (the same seam the
    // standalone `publish` CLI reads) instead of re-deriving the values.
    writeConfidenceScoreArtifact(ws, confidenceResult, maskConfidenceText(confidenceOutcome.diagnostic), confidenceProvenance(confidenceOutcome.wireEffort !== ""), confidenceLatencyMs, confidenceUsage);
    if (confidenceOutcome.requestPayload !== null) {
      // #1140 review: raw provider/agent JSON goes to disk through
      // `redactTextDeep`, not `maskKnownSecretsDeep` — configured-value
      // masking alone left a PROVIDER-authored credential (`api_key=…`,
      // `Bearer …`, `sk-…`) this run never configured persisted verbatim in
      // the diagnostic artifacts.
      ws.write("confidence-request.json", pyJsonDumps(redactTextDeep(confidenceOutcome.requestPayload, confidenceSecrets)));
    } else {
      // A failed scorer call must not leave an earlier run's wire artifact
      // sitting next to the fresh `unscored` score.
      ws.remove("confidence-request.json");
    }
    if (confidenceOutcome.rawResponse !== null) {
      ws.write("confidence-response.json", pyJsonDumps(redactTextDeep(confidenceOutcome.rawResponse, confidenceSecrets)));
    } else {
      // Same rule as the request artifact above.
      ws.remove("confidence-response.json");
    }
    if (confidenceResult.status === "unscored") {
      // The log line goes through the same masking as the artifact: a
      // provider message that echoes a configured credential must not
      // surface on the runner console either.
      const diagnosticNote = confidenceOutcome.diagnostic !== "" ? `: ${maskConfidenceText(confidenceOutcome.diagnostic)}` : "";
      log(`confidence scorer: unscored (${confidenceResult.cause})${diagnosticNote}`);
    } else if (confidenceResult.status === "scored") {
      log(`confidence scorer: verified ${confidenceResult.score}/5 risk=${confidenceResult.risk} (advisory only)`);
    }
  }
  const confidenceOutputs = confidenceOutputFields(confidenceResult);
  // #1455: the verifier's telemetry, resolved ONCE by the single authority
  // (`confidenceTelemetryOf`) that every published surface shares. The cause
  // is the run's action-owned machine token — never provider text — and it is
  // published only for an unscored run whose cause matches the conservative
  // grammar; anything else is dropped rather than published, because the
  // marker is a surface a collector reads and may only carry values this
  // action can vouch for.
  const confidenceTelemetry = confidenceTelemetryOf({
    status: confidenceResult.status,
    cause: confidenceResult.cause,
    latencyMs: confidenceLatencyMs,
    usage: confidenceUsage,
  });
  // A verifier that never ran carries no telemetry: the marker keeps its
  // pre-#1455 bytes exactly. The same rule the standalone publish path
  // applies to the artifact it reads, so both paths publish one record.
  const publishedConfidenceTelemetry = confidenceTelemetry.status === "" ? undefined : confidenceTelemetry;

  // #1003: the triage outputs. Disabled means "" for BOTH — "did not run",
  // deliberately distinct from the fail-closed `unknown` answer, so a
  // consumer can tell "not asked" from "could not tell". Enabled, the
  // decision is re-validated against the three literals here too (the parser
  // already fails closed; this is the publish/step-summary boundary's own
  // fail-closed check for a carried-forward or hand-edited artifact). Triage
  // is review-only: no value below feeds the verdict, the marker, or any
  // tool/fork/evidence gate.
  const reviewTriageEnabled = config.reviewTriage === true;
  const triageReason = reviewTriageEnabled && typeof reviewRecord.review_triage_reason === "string"
    ? reviewRecord.review_triage_reason
    : "";
  const triageDecision = reviewTriageEnabled
    ? resolveReviewTriageDecision(reviewRecord.review_triage_decision, triageReason)
    : "";
  // #1005: the deterministic routing plan. Computed only when triage and
  // routing are both enabled; the resolver validates every model-named logical
  // target against trusted configuration and fails closed on any uncertain
  // state, so a model can never cause an unconfigured identity to be
  // requested. The plan is persisted for the publish step to act on.
  const triageTargets = Array.isArray(reviewRecord.review_triage_targets)
    ? reviewRecord.review_triage_targets.filter((target): target is string => typeof target === "string")
    : [];
  const routingPlan: HumanReviewRoutingPlan | null = reviewTriageEnabled && routingMode !== "off"
    ? resolveHumanReviewRouting({
        mode: routingMode,
        decision: (triageDecision === "" ? "unknown" : triageDecision) as ReviewTriageDecision,
        targets: triageTargets,
        config: reviewerRouting.targets,
        isForkPr: forkFlag === "true",
      })
    : null;
  if (routingPlan !== null) {
    ws.write("review-routing.json", `${JSON.stringify({
      mode: routingPlan.mode,
      status: routingPlan.status,
      target_ids: routingPlan.targetIds,
      users: routingPlan.users,
      teams: routingPlan.teams,
      detail: routingPlan.detail,
    })}\n`);
  }
  const routingOutput = routingPlan === null || routingPlan.status === "off" ? "" : routingPlan.status;
  const outputs: ReviewStepOutputs = {
    verdict: outputVerdict,
    degradedGateBypass,
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
      degradedGateBypass,
      // #1449: an undischarged derived obligation is missing coverage, so the
      // review reads `partial` — never `clean`, and never a manufactured
      // `issues`. Absent when the feature is off.
      ...(derivedState !== "" ? { derivedObligationState: derivedState } : {}),
      // #1505: unresolved required review evidence is a coverage state too —
      // the review reads `partial`, never `clean`, while required evidence
      // stayed ungathered. Absent when the contract was inactive.
      ...(requiredState !== "" ? { requiredEvidenceState: requiredState } : {}),
    }),
    reviewRoute: env.REVIEW_ROUTE ?? "legacy",
    escalationReason: escalationReasons,
    reviewTriageDecision: triageDecision,
    reviewTriageReason: triageReason,
    reviewTriageRouting: routingOutput,
    // #1073: all five empty when the scorer is disabled — never a spurious 0.
confidenceStatus: confidenceOutputs.status,
confidenceScore: confidenceOutputs.score,
confidenceRisk: confidenceOutputs.risk,
confidenceReason: confidenceOutputs.reason,
confidenceModel: confidenceOutputs.model,
      // #1337: "" when the model never emitted a real `dependency_coverage`
      // answer (artifact key absent) OR the deterministic detection never
      // fired — a run without an answer gains no summary row and no marker
      // key.
      dependencyCoverageStatus: dependencyCoverageFired && typeof reviewRecord.dependency_coverage_status === "string" ? reviewRecord.dependency_coverage_status : "",
reviewMarkdown: String(reviewRecord.review_markdown ?? ""),
    findings: pyJsonDumps(Array.isArray(reviewRecord.findings) ? reviewRecord.findings : []),
    toolCalls,
    cacheHitRatio,
    analysisEngine,
  };
  ws.write("review-body.md", redactText(outputs.reviewMarkdown));
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
    fallbackHarness: ws.isFile("tool-harness.fallback.json") ? safeJson(ws.read("tool-harness.fallback.json")) : null,
    coverage: safeJson(ws.read("requirement-coverage.json")),
    budgets,
    route: outputs.reviewRoute,
    routeReason: env.ROUTE_REASON ?? "",
    analysisEngine,
    fallbackUsed: primary.fromFallback,
    ...(routingPlan !== null ? { reviewRouting: routingPlan } : {}),
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
  // The run's last awaited stage: a cancellation that landed anywhere since
  // the review stage must still cost the run its verdict.
  checkpoint();
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
    // #1073: the scorer's marker keys, only when the scorer ran — disabled
    // and never-attempted runs keep the pre-#1073 marker bytes exactly.
...(outputs.confidenceStatus !== "" ? { confidenceStatus: outputs.confidenceStatus } : {}),
...(outputs.confidenceScore !== "" ? { confidenceScore: Number(outputs.confidenceScore) } : {}),
// #1337: the coverage rollup, only when the model emitted a
// `dependency_coverage` answer — other runs keep pre-#1337 marker bytes.
...(outputs.dependencyCoverageStatus === "complete" || outputs.dependencyCoverageStatus === "partial" || outputs.dependencyCoverageStatus === "unavailable"
  ? { dependencyCoverage: outputs.dependencyCoverageStatus }
  : {}),
    // #1449: the derived-obligation state, only when the feature is enabled
    // — a disabled run keeps the pre-#1449 marker bytes exactly. The value
    // is the run's own state, resolved once above from the coverage answer
    // and the folded rows.
    ...(derivedState !== "" ? { derivedObligationState: derivedState } : {}),
    // #1505: the run's required-evidence state, only when the contract was
    // active — an inactive run keeps its bytes exactly.
    ...(requiredState !== "" ? { requiredEvidenceState: requiredState } : {}),
    // #1455: the verifier's telemetry, only when the run measured it — a
    // disabled verifier, or a call with no usage, keeps the pre-#1455
    // marker bytes exactly.
    ...(publishedConfidenceTelemetry !== undefined ? { confidenceTelemetry: publishedConfidenceTelemetry } : {}),
    ...(toolBudgetTelemetry.budget !== undefined ? { toolBudget: toolBudgetTelemetry.budget } : {}),
    ...(toolBudgetTelemetry.source !== undefined ? { toolBudgetSource: toolBudgetTelemetry.source } : {}),
    ...(toolBudgetTelemetry.calls !== undefined ? { toolCalls: toolBudgetTelemetry.calls } : {}),
    // #1597: the remaining partitions, additive marker keys.
    ...(toolBudgetTelemetry.issued !== undefined ? { toolCallsIssued: toolBudgetTelemetry.issued } : {}),
    ...(toolBudgetTelemetry.successful !== undefined ? { toolCallsSuccessful: toolBudgetTelemetry.successful } : {}),
    ...(toolBudgetTelemetry.refused !== undefined ? { toolCallsRefused: toolBudgetTelemetry.refused } : {}),
    ...(toolBudgetTelemetry.deduplicated !== undefined ? { toolCallsDeduplicated: toolBudgetTelemetry.deduplicated } : {}),
    ...(toolBudgetTelemetry.rounds !== undefined ? { toolRounds: toolBudgetTelemetry.rounds } : {}),
    ...(toolBudgetTelemetry.maxRounds !== undefined ? { maxRounds: toolBudgetTelemetry.maxRounds } : {}),
    ...(toolBudgetTelemetry.contextBudget !== undefined ? { contextBudget: toolBudgetTelemetry.contextBudget } : {}),
    ...(toolBudgetTelemetry.contextPeak !== undefined ? { contextPeak: toolBudgetTelemetry.contextPeak } : {}),
    ...(toolBudgetTelemetry.stopReason !== undefined ? { toolStopReason: toolBudgetTelemetry.stopReason } : {}),
    actionVersion: ACTION_VERSION,
    degradedGateBypass: outputs.degradedGateBypass,
  });
  // #1515: the last act of the pipeline — drain and log the run-wide
  // inference governor's admission telemetry (a no-op line when the run
  // never enabled the cap).
  logInferenceGovernorTelemetry(dependencies);
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
    // #1449: the run's derived-obligation state, only when the feature is
    // enabled — a disabled run keeps its pre-#1449 published bytes exactly.
    // The value is the run's own state, resolved once above from the
    // derivation's coverage answer and the folded rows; it is never
    // recomputed here.
    ...(derivedState !== "" ? { derivedObligationState: derivedState } : {}),
    // #1505: the run's required-evidence state, only when the contract was
    // active — an inactive run keeps its bytes exactly.
    ...(requiredState !== "" ? { requiredEvidenceState: requiredState } : {}),
    ...(toolBudgetTelemetry.budget !== undefined ? { toolBudget: toolBudgetTelemetry.budget } : {}),
    ...(toolBudgetTelemetry.source !== undefined ? { toolBudgetSource: toolBudgetTelemetry.source } : {}),
    ...(toolBudgetTelemetry.calls !== undefined ? { toolCallsUsed: toolBudgetTelemetry.calls } : {}),
    // #1597: the remaining partitions on the run result (the marker carries
    // the same snapshot above).
    ...(toolBudgetTelemetry.issued !== undefined ? { toolCallsIssued: toolBudgetTelemetry.issued } : {}),
    ...(toolBudgetTelemetry.successful !== undefined ? { toolCallsSuccessful: toolBudgetTelemetry.successful } : {}),
    ...(toolBudgetTelemetry.refused !== undefined ? { toolCallsRefused: toolBudgetTelemetry.refused } : {}),
    ...(toolBudgetTelemetry.deduplicated !== undefined ? { toolCallsDeduplicated: toolBudgetTelemetry.deduplicated } : {}),
    ...(toolBudgetTelemetry.rounds !== undefined ? { toolRoundsUsed: toolBudgetTelemetry.rounds } : {}),
    ...(toolBudgetTelemetry.maxRounds !== undefined ? { toolMaxRounds: toolBudgetTelemetry.maxRounds } : {}),
    ...(toolBudgetTelemetry.contextBudget !== undefined ? { contextBudget: toolBudgetTelemetry.contextBudget } : {}),
    ...(toolBudgetTelemetry.contextPeak !== undefined ? { contextPeak: toolBudgetTelemetry.contextPeak } : {}),
    ...(toolBudgetTelemetry.stopReason !== undefined ? { toolStopReason: toolBudgetTelemetry.stopReason } : {}),
    // #726: the admission decision this run was admitted on. The verdict
    // fields above remain authoritative on the review path.
    shouldReview: true,
    skipReason: pre.skip_reason,
    diffFingerprint: pre.diff_fingerprint,
    admissionBaseSha: pre.base_sha,
    reviewedHeadSha: headSha,
    isForkPr: context.isForkPr,
    admission: pre,
    // #1073: advisory concerns for the published section, scored answers only.
    ...(confidenceResult.status === "scored" ? { confidenceConcerns: confidenceResult.concerns } : {}),
    // #1518: the enforcement pass's merge-gating ids, so the published
    // handoff can name the obligations that stayed open. Both lists are
    // always present here (empty when the enforcement pass found nothing);
    // a run that never reviewed carries neither (the admission skip path).
    unresolvedRequirementIds: unresolvedRequirementIds.ids,
    unresolvedRequirementIdsSourceTotal: unresolvedRequirementIds.total,
    unresolvedRequiredChecks: unresolvedRequiredChecks.ids,
    unresolvedRequiredChecksSourceTotal: unresolvedRequiredChecks.total,
    // #1521: the obligation ROWS that blocked this review, on the same
    // presence rule as the two id lists above — always present on the
    // review path (empty when nothing blocked), never on the admission skip
    // path (a run that never reviewed blocked nothing).
    unresolvedReviewObligations: blockingObligationRows,
    // #1455: the verifier's telemetry for the published marker — advisory
    // only, never a verdict input.
    ...(publishedConfidenceTelemetry !== undefined ? { confidenceTelemetry: publishedConfidenceTelemetry } : {}),
  };
}

// ---------------------------------------------------------------------------
// Stage helpers bound to the pipeline
// ---------------------------------------------------------------------------

/** #1515: drain the run-wide inference governor's admission telemetry once at
 * pipeline end and log the one bounded summary line (dispatched /
 * cancelled-before-dispatch / max queue wait, by priority class). Observability
 * only: never a verdict, route, or retry input. A run with no enabled governor
 * (the default posture) logs nothing and gains no field. */
export function logInferenceGovernorTelemetry(
  dependencies: Pick<ReviewDependencies, "log" | "quiet">,
): void {
  const summary = drainSharedRunInferenceGovernor();
  if (summary === null) return;
  if (dependencies.quiet) return;
  dependencies.log(renderRunInferenceTelemetryLine(summary));
}

/** #726: the result an admission SKIP returns — the decision fields are the
 * point; no review stage ran, so the verdict surfaces stay neutral and the
 * carried decision (a diff-unchanged skip's verdict/verdict-source/review-
 * result/incomplete-reason/degraded-gate-bypass) lives in `admission` for
 * the host's gate and outputs. No artifacts were written: the bus is empty. */
function admissionSkipResult(
  pre: PrecheckOutput,
  durationSec: number,
  dependencies: ReviewDependencies,
): RunReviewResult {
  const outputs: ReviewStepOutputs = {
    verdict: "",
    degradedGateBypass: false,
    verdictSource: "",
    requiredChecks: "none",
    reviewResult: "",
    incompleteReason: "none",
    reviewRoute: "legacy",
    escalationReason: "",
    reviewTriageDecision: "",
    reviewTriageReason: "",
    reviewTriageRouting: "",
    reviewMarkdown: "",
    findings: "[]",
    analysisEngine: "",
    toolCalls: "",
    cacheHitRatio: "-",
  };
  return {
    outputs,
    runDir: dependencies.runDir,
    marker: "",
    artifacts: new Map<string, Uint8Array>(),
    reviewArtifact: {},
    route: "legacy",
    routeReason: "",
    analysisEngine: "",
    classification: {},
    ciGate: NO_GATE_OUTCOME("ci"),
    specialistGate: NO_GATE_OUTCOME("specialists"),
    verdictPolicy: "",
    durationSec,
    shouldReview: false,
    skipReason: pre.skip_reason,
    diffFingerprint: pre.diff_fingerprint,
    admissionBaseSha: pre.base_sha,
    reviewedHeadSha: pre.head_sha,
    isForkPr: pre.is_fork_pr,
    admission: pre,
  };
}

function cachedProjectNumber(bytes: Uint8Array): number | null {
  const value = safeJson(bytes);
  const number = value?.number;
  return typeof number === "number" ? number : null;
}

/** #978: whether a deterministic, rule-based layer owns the final verdict.
 * A fail-closed enforcement layer, a required-check fail mode, incomplete
 * requirement-trace coverage, or any verdict policy/enforcement escalation
 * (`verdict_source !== "model"`) outranks the degraded gate exemption — an
 * operator who enabled one of those meant it. `requirement_trace_incomplete`
 * is authoritative for both `unmet` and `unverifiable` rows (#1095: the trace
 * no longer synthesizes findings, so incompleteness is the pass's own
 * signal). A model-originated `request_changes` keeps
 * `verdict_source === "model"` and stays eligible. */
export function computeDeterministicBlock(input: {
  enforcementInputs: EnforcementInputs;
  completeness: { status: string; mode: string } | null;
  requirementTraceIncomplete: boolean;
  finalVerdict: string;
  verdictSource: string;
}): boolean {
  return failClosedEnforcementFired(input.enforcementInputs)
    || (input.completeness !== null && input.completeness.status === "incomplete" && input.completeness.mode === "fail")
    || input.requirementTraceIncomplete
    // verdict_source records whether policy/enforcement forced the final
    // verdict; a model-originated request_changes remains eligible for #978.
    || (input.finalVerdict === "request_changes" && input.verdictSource !== "model");
}

/** #978: whether a final request_changes may bypass fail-on-request-changes.
 * Only a block the degraded MODEL produced is eligible: a deterministic
 * fail-closed layer outranks the exemption, and the no-evidence case is
 * deliberately fallback-only (#978 asked for the fallback with no gathered
 * evidence, not a primary corpus review after zero tool calls). */
export function resolveDegradedGateBypass(input: {
  notice: boolean;
  fromFallback: boolean;
  noEvidenceGathered: boolean;
  deterministicBlock: boolean;
}): boolean {
  return input.notice || (input.fromFallback && input.noEvidenceGathered && !input.deterministicBlock);
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
 *
 * #1597: `calls` is the loop's EXECUTED count — every call the loop
 * attempted on the executor, executor status irrelevant (the population of
 * the outcome log line and the `tool_calls` trace), so a budget stop reads
 * `tool_calls == tool_budget` instead of the old successful-only number.
 * The distinct machine counts ride alongside whenever the artifact carries
 * them: `issued` (everything the model asked for), `successful` (the ok
 * subset), `refused` and `deduplicated` (the non-executed dispositions),
 * under the invariant `issued = executed + refused + deduplicated` and
 * `successful <= executed`. An artifact written before #1597 keeps its
 * old bytes: the new fields are simply absent and the new marker keys are
 * omitted, never synthesized.
 */
export function toolBudgetTelemetryOf(harness: Record<string, unknown> | null): {
  budget?: number;
  source?: string;
  calls?: number;
  issued?: number;
  successful?: number;
  refused?: number;
  deduplicated?: number;
  rounds?: number;
  maxRounds?: number;
  contextBudget?: number;
  contextPeak?: number;
  stopReason?: string;
} {
  if (harness === null) return {};
  const out: {
    budget?: number;
    source?: string;
    calls?: number;
    issued?: number;
    successful?: number;
    refused?: number;
    deduplicated?: number;
    rounds?: number;
    maxRounds?: number;
    contextBudget?: number;
    contextPeak?: number;
    stopReason?: string;
  } = {};
  if (typeof harness.tool_request_budget === "number") out.budget = harness.tool_request_budget;
  if (typeof harness.tool_budget_source === "string" && harness.tool_budget_source !== "") {
    out.source = harness.tool_budget_source;
  }
  // #847 measurement follow-up: the loop's own stop reason (written by
  // runToolHarness on every path that ran the loop). A pre-loop abort has no
  // top-level stop_reason; its `harness-abort` lives only in the #702
  // telemetry object (buildToolLoopTelemetry's `phase: "pre-loop"` shape),
  // so fall back to it there — the loop-shape nested value is the same
  // constant, never new information. Recorded regardless of coverage so a
  // budget stop that left nothing unread is still measurable from published
  // markers.
  if (typeof harness.stop_reason === "string" && harness.stop_reason !== "") {
    out.stopReason = harness.stop_reason;
  } else if (
    harness.tool_loop_telemetry !== null
    && typeof harness.tool_loop_telemetry === "object"
    && typeof (harness.tool_loop_telemetry as Record<string, unknown>).stop_reason === "string"
    && (harness.tool_loop_telemetry as Record<string, unknown>).stop_reason !== ""
  ) {
    out.stopReason = (harness.tool_loop_telemetry as Record<string, unknown>).stop_reason as string;
  }
  if (typeof harness.executed_request_count === "number") out.calls = harness.executed_request_count;
  // #1597: the remaining partitions, lifted independently — an artifact
  // missing any of them omits that marker key rather than synthesizing a
  // count (no derivation from message counts or model text).
  if (typeof harness.planned_request_count === "number") out.issued = harness.planned_request_count;
  if (typeof harness.successful_request_count === "number") out.successful = harness.successful_request_count;
  if (typeof harness.refused_request_count === "number") out.refused = harness.refused_request_count;
  if (typeof harness.deduplicated_request_count === "number") out.deduplicated = harness.deduplicated_request_count;
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

/** #1600: the raw diff's added/removed lines attributed to the file each came
 * from, so content-based boundary corroboration can never combine one path
 * with another file's text. Undefined when the diff is unavailable or cannot
 * be attributed (over-budget, unusable headers): the scope rule then keeps the
 * lexical match's full weight instead of inferring attribution. */
export function traceChangedFileLines(ws: Pick<RunWorkspace, "readText">): ChangedFileLines[] | undefined {
  const diff = ws.readText("pr.diff");
  if (diff === null || diff === undefined || diff === "") return undefined;
  return parseChangedFileLines(diff) ?? undefined;
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

/** Every path that ends without a real score must leave the run dir free of
 * this run's confidence artifacts. A reused `PR_REVIEWER_RUN_DIR` would
 * otherwise keep a previous run's `confidence-score.json` sitting next to an
 * `unscored` status, so a later reader could pair a stale score with the
 * current run. Used by the disabled branch, where NO confidence surface
 * exists at all. */
function clearConfidenceArtifacts(ws: RunWorkspace): void {
  ws.remove("confidence-score.json");
  removeConfidenceWireArtifacts(ws);
}

/** The wire artifacts belong to a model call. A run that never called the
 * model (disabled, publish step skipped, incomplete review, incomplete
 * proof context) must not leave an earlier run's request/response behind. */
function removeConfidenceWireArtifacts(ws: RunWorkspace): void {
  ws.remove("confidence-request.json");
  ws.remove("confidence-response.json");
}

/** Persist the canonical confidence result. The artifact is the only surface
 * that carries the machine-token cause, so EVERY path that ends without a
 * score writes one — including the enabled-but-skipped ones
 * (`not_published`, `incomplete_review`, `incomplete_proof_context`) that
 * never reach the model call.
 * Without it, `confidence-status: unscored` is unexplainable: the operator
 * could not tell "the publish step was skipped" from "the call failed".
 *
 * #1369: artifact `version` 2 adds the `rubric` field
 * (`CONFIDENCE_RUBRIC_VERSION`). That version IS the migration marker: a
 * version-1 artifact (no `rubric` field) is a pre-#1369 prose-quality
 * confidence grade, and consumers must never reinterpret it as a
 * merge-readiness verifier result — the two semantics are not comparable.
 *
 * #1368: `provenance` is an ADDITIVE record of the request budgets and
 * capability assertions the enabled profile resolved; absent when disabled,
 * and every pre-existing key stays byte-for-byte as before.
 *
 * #1455: `latencyMs` and `usage` are ADDITIVE records of the verifier's ONE
 * wire attempt — the wall-clock duration it observed and the provider's
 * normalized token usage. Both are absent when no call was attempted or when
 * the provider reported no usage; every pre-existing key stays byte-for-byte
 * as before and the artifact `version` stays 2 (the new keys are additive,
 * not a semantic migration). */
interface ConfidenceRequestProvenance {
  max_tokens: number;
  prompt_tokens: number;
  model_context_tokens: number;
  reasoning_effort_sent: boolean;
  anthropic_effort_support: boolean;
  structured_output_support: boolean;
}

function writeConfidenceScoreArtifact(
  ws: RunWorkspace,
  result: ConfidenceResult,
  diagnostic?: string,
  provenance?: ConfidenceRequestProvenance,
  latencyMs?: number | null,
  usage?: ConfidenceUsageTelemetry | null,
): void {
  // #1455: the usage goes through the SAME validation the marker builder
  // applies, so the artifact and the published marker can never disagree
  // about the same measurement.
  const validUsage = validConfidenceUsageTelemetry(usage);
  ws.write("confidence-score.json", Buffer.from(`${pyJsonDumps({
    version: 2,
    rubric: CONFIDENCE_RUBRIC_VERSION,
    status: result.status,
    score: result.score,
    risk: result.risk,
    reason: result.reason,
    concerns: result.concerns.map((concern) => ({
      type: concern.type,
      severity: concern.severity,
      file: concern.file,
      line: concern.line,
      evidence: concern.evidence,
    })),
    model: result.model,
    cause: result.cause,
    caps: result.caps,
    // #1369: action-owned parser notes (e.g. `concern_dropped_*` tokens) so a
    // dropped concern — and the ceiling implication it would have carried —
    // stays operator-visible instead of vanishing silently.
    parser_notes: result.parserNotes,
    ...(diagnostic !== undefined && diagnostic !== "" ? { diagnostic } : {}),
    ...(provenance !== undefined ? { request: provenance } : {}),
    // #1455: the measured latency and the provider's token usage, in the
    // same wire shape the metadata marker carries them. Both go through the
    // SAME validation the marker builder applies, so the artifact and the
    // published marker can never disagree about the same measurement.
    ...(typeof latencyMs === "number" && Number.isInteger(latencyMs) && latencyMs >= 0 ? { latency_ms: latencyMs } : {}),
    ...(validUsage !== null ? { usage: confidenceUsageWireShape(validUsage) } : {}),
  })}\n`, "utf8"));
}

/** corpus.sh's gate_feature_for_forks for the tool harness. Null = run. */
function gateForkForForks(env: StageEnv, forkFlag: string): { md: string; json: string } | null {
  if (forkFlag === "true" && (env.TOOL_ENABLE_FOR_FORKS ?? "false").toLowerCase() !== "true") {
    return {
      md: "Tool harness was skipped for a cross-repository pull request. Set tool_enable_for_forks=true to override.\n",
      json: '{"mode":"native_loop","planned_request_count":0,"executed_request_count":0,'
        + '"successful_request_count":0,"refused_request_count":0,"deduplicated_request_count":0,'
        + '"tool_results":[],"skipped":true,"skip_reason":"fork-pr"}\n',
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
  annotate: (line: string) => void;
  clock: () => number;
  readonly sleep?: ((seconds: number) => Promise<void>) | undefined;
  /** #726: the run's cancellation scope signal. Attached to every model
   * request this input produces so an aborted caller tears the in-flight
   * provider request down instead of abandoning it. */
  readonly signal?: AbortSignal;
}

export function tierProfileFrom(profiles: TierProfiles, tier: "primary" | "fallback" | "smart", env: StageEnv): TierProfile {
  const resolved = tier === "fallback" ? profiles.fallback : tier === "smart" ? profiles.smart : profiles.primary;
  // #1251: the raw-env default is the contract's, not a second literal —
  // non-finite or non-positive values fall back to it, same coercion the
  // `||` performed before.
  const aiMaxTokensRaw = Number(env.AI_MAX_TOKENS);
  const aiMaxTokens = Number.isFinite(aiMaxTokensRaw) && aiMaxTokensRaw > 0 ? aiMaxTokensRaw : AI_MAX_TOKENS_DEFAULT;
  const temperatureRaw = env.AI_TEMPERATURE ?? "0.1";
  // #1246: an explicit zero is a valid temperature and must reach the wire —
  // `Number(x) || 0.1` rewrote `ai-temperature: "0"` into 0.1. Empty still
  // omits the field; config validation rejects non-finite values upstream,
  // so the finite fallback only guards direct-callers defensively.
  const temperature = Number(temperatureRaw);
  // #1037: same operator headers on every lane; unset config yields
  // `undefined` and the profile omits the field, keeping requests
  // byte-identical.
  const extraHeaders = extraHeadersForEnv(env.AI_EXTRA_HEADERS ?? "");
  return {
    label: tier === "fallback" ? "Fallback" : tier === "smart" ? "Smart" : "Primary",
    baseUrl: resolved.baseUrl,
    apiFormat: resolved.apiFormat === "anthropic" ? "anthropic" : "openai",
    model: resolved.model,
    apiKey: resolved.apiKey,
    anthropicVersion: env.ANTHROPIC_VERSION ?? "2023-06-01",
    // #1251: the tier profile is the single derivation — the fallback lane's
    // stream inheritance was already resolved by resolveTierProfiles.
    stream: resolved.stream,
    requestTimeoutSec: resolved.requestTimeoutSec,
    connectTimeoutSec: resolved.connectTimeoutSec,
    retries: resolved.retries,
    retryDelaySec: resolved.retryDelaySec,
    shape: tierRequestShape(tier === "smart" ? "smart" : tier === "fallback" ? "fallback" : "primary", env),
    maxTokens: aiMaxTokens,
    temperature: temperatureRaw === "" ? "" : Number.isFinite(temperature) ? temperature : 0.1,
    responseFormat: resolved.responseFormat,
    tokensParam: (env.AI_TOKENS_PARAM ?? "max_tokens") as TierProfile["tokensParam"],
    // #998: the lane's resolved effort; "" omits the provider field entirely.
    // #1049 review: the Anthropic opt-in is the lane's own assertion —
    // the smart lane never inherits the base flag.
    reasoningEffort: resolved.reasoningEffort,
    anthropicEffortSupported: resolved.anthropicEffortSupported,
    // #1047: the lane's own structured-output assertion, same per-lane rule.
    anthropicStructuredOutputSupported: resolved.anthropicStructuredOutputSupported,
    ...(extraHeaders !== undefined ? { extraHeaders } : {}),
  };
}

async function callTier(
  tier: "primary" | "fallback" | "smart",
  profile: TierProfile,
  input: ReviewCallInput,
  corpusName: string,
  requestArtifact: string,
  responseArtifact: string,
): Promise<{ ok: boolean; artifact: Record<string, unknown> | null; rawResponse: unknown; terminal?: TerminalProviderReason;
  attempts?: number; elapsedSec?: number; lastFailure?: string }> {
  const { env, ws, log, errorLog, annotate } = input;
  const corpusText = ws.readText(corpusName) ?? "";
  // #998 (#1049 review): an Anthropic effort the operator configured but the
  // lane's endpoint opt-in refuses is NOT sent. Say so once, per call, at the
  // runtime boundary — a silently dropped parameter is exactly the confusion
  // this feature exists to remove.
  if (profile.apiFormat === "anthropic" && profile.reasoningEffort !== "" && !profile.anthropicEffortSupported) {
    log(`WARNING: ${anthropicEffortInactiveWarning(tier, profile.reasoningEffort, " (review call)")}`);
  }
  // #1047: same truth-telling for structured output. A resolved json_schema
  // the endpoint opt-in refuses is NOT enforced, and json_object has no
  // Anthropic-native wire form at all — either way the JSON contract is
  // prompt-only, and the operator is told so by name instead of believing a
  // parameter was sent.
  if (profile.apiFormat === "anthropic" && profile.responseFormat === "json_schema" && !profile.anthropicStructuredOutputSupported) {
    log(`WARNING: ${anthropicStructuredOutputInactiveWarning(tier, " (review call)")}`);
  } else if (profile.apiFormat === "anthropic" && profile.responseFormat === "json_object") {
    log(`WARNING: ${anthropicJsonObjectsPromptOnlyWarning(tier, "json_object", " (review call)")}`);
  }
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
    reasoningEffort: profile.reasoningEffort,
    anthropicEffortSupported: profile.anthropicEffortSupported,
    anthropicStructuredOutputSupported: profile.anthropicStructuredOutputSupported,
  });
  ws.write(requestArtifact, pyJsonDumps(requestPayload.body));
  ws.write(responseArtifact, "");
  // #1037: ONE known-secret list for every response surface of this call —
  // the persisted `ai-response.<tier>.json` body, the verdict parse, the
  // diagnostics line, and the transport-failure detail. A configured
  // extra-header VALUE is an outbound secret the provider can quote straight
  // back into its own response body, so it is masked here, where the body
  // enters artifact/diagnostic state, not only at each consumer.
  const knownSecrets = callKnownSecrets(profile.apiKey, profile.extraHeaders, endpointUrlCredentialOrEmpty(profile.baseUrl));

  // #1305: wall-clock spend of this tier's attempts, reported on the
  // fallback-handoff line so the reason for leaving the lane and the time
  // spent on it are explicit, not reconstructed from timestamps. Measured on
  // the run's injected clock, like every other timing surface here.
  const tierStart = input.clock();
  const outcome = await callModelTier(profile, {
    system: env.SYSTEM_PROMPT ?? "",
    user: input.userMessage,
    corpus: corpusText,
  }, {
    ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
    // #1515: the primary review is the authoritative class; the fallback and
    // smart lanes are the recovery class ("smart/fallback recovery when it
    // owns the authoritative result"). Admission never rewrites the lane —
    // the profile reaches the transport exactly as resolved.
    priority: tier === "primary" ? GOVERNOR_PRIORITY_AUTHORITATIVE : GOVERNOR_PRIORITY_RECOVERY,
    // #726: the run's cancellation scope also bounds the QUEUE WAIT — a run
    // abandoned while its request sat queued never dispatches it.
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    call: async (chatInput) => {
      // #1058: the injected clock must reach the transport's own 429/5xx
      // backoff too (that loop counts in ms, the model-tier one in seconds),
      // or a test that opts into a deterministic clock still pays the real
      // 1s/2s waits. Production passes no `sleep`, so nothing changes there.
      // #726: the cancellation scope rides every model request of this run,
      // so an abort physically tears down the provider request instead of
      // leaving it running against a caller that already left.
      const result = await runChatRequest({
        ...chatInput,
        ...(input.sleep !== undefined ? { sleep: (ms: number) => input.sleep!(ms / 1000) } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      if (result.status === "failure") return result;
      // #1037: mask the raw provider body on its way into the artifact — the
      // response can echo a configured header value, and this artifact is read
      // by later phases (the step summary reads `usage`) and by a human
      // debugging a degraded run. Nothing re-parses this copy AS a verdict
      // (the native-loop reuse reads the harness-written artifact, before this
      // call runs), so a masked leaf cannot break a downstream parse.
      // #1149: `redactTextDeep`, not `maskKnownSecretsDeep`. The latter masks
      // only the CONFIGURED values, so a credential-SHAPED value the backend
      // invented — `api_key=<never configured>`, a bare `Bearer …`, an `sk-…`
      // token — was persisted verbatim into a body this action ships as a job
      // artifact. `redactText`'s generic layer is exactly the rule that covers
      // a value the operator never gave us, and it composes (configured values
      // are still nuked first, the generic pass runs on the remainder).
      ws.write(responseArtifact, pyJsonDumps(redactTextDeep(result.raw, knownSecrets)));
      return result;
    },
  });
  // #1047: the bounded, content-free failure-shape record — logged as one
  // line and persisted beside the error so a degraded run explains itself.
  // #1047: bounded failure-shape diagnostics. The record carries no response
  // content by construction, and its one provider-controlled free-text field
  // (finish_reason) was already masked in-record — but the LINE is still
  // masked whole against the tier's key before it is logged, because the
  // static field names ("failure_kind" contains a "k") can collide with a
  // very short configured key. Over-redacting a few incidental letters is the
  // accepted cost (the same second-pass rationale as describeTransportFailure).
  const diagnosticsLine = outcome.status !== "ok" && outcome.diagnostics !== undefined
    ? maskKnownSecrets(` [${formatResponseDiagnosticsLine(outcome.diagnostics.record)}]`, knownSecrets)
    : "";
  if (outcome.status === "ok") {
    // #998: the effective effort is part of which request produced this
    // verdict, so the per-call debug line carries it — appended only when one
    // was actually sent, keeping the line unchanged for every existing setup.
    const wireEffort = effectiveWireEffort(profile.apiFormat, profile.reasoningEffort, profile.anthropicEffortSupported);
    const effortNote = wireEffort === "" ? "" : `, effort=${wireEffort}`;
    // #1047 (review): report the format the SUCCESSFUL request actually
    // carried, never the configuration. The transport's one-shot strip retry
    // can recover a capability-mismatch 400 without the parameter — the
    // verdict then came from a prompt-only request, so `format=json_schema`
    // would be a lie. The strip is announced once, by surface and outcome,
    // and persisted as bounded attempt evidence beside the initial request
    // artifact (which keeps its original bytes: it records what was FIRST
    // sent). No secrets and no response content — the note carries only the
    // parameter name and the attempt count.
    const stripped = outcome.strippedStructuredOutput;
    if (stripped !== undefined) {
      log(`WARNING: ${profile.label}: the endpoint rejected the structured-output parameter (${stripped}) with HTTP 400; the request was retried once without it and recovered prompt-only`);
      const effectiveArtifact = requestArtifact.replace(/\.json$/, ".effective.json");
      ws.write(effectiveArtifact, Buffer.from(`${pyJsonDumps({
        removed: stripped,
        note: "structured output removed after HTTP 400; request recovered prompt-only",
        attempts: outcome.attempts,
      })}\n`, "utf8"));
    }
    const wireFormat = effectiveWireResponseFormat(profile.apiFormat, profile.responseFormat, profile.anthropicStructuredOutputSupported);
    const formatNote = wireFormat === "json_schema" && profile.apiFormat === "anthropic" && stripped === undefined ? ", format=json_schema" : "";
    const raisedNote = outcome.budgetRaisedTo !== undefined ? ` (completion budget raised to ${outcome.budgetRaisedTo} after a token-cap failure)` : "";
    log(`${profile.label} model attempt ${outcome.attempts}: ${profile.model} @ ${redactEndpointUrlCredential(profile.baseUrl)} (${profile.apiFormat}${effortNote}${formatNote})${raisedNote}`);
    const parsed = parseVerdictResponse(outcome.rawResponse, knownSecrets);
    // Deliberately NOT masked here: the parsed verdict is the review's own
    // content, and its structural fields (severity/category/file/line) drive
    // the findings table and the enforcement stages. Masking it would corrupt
    // published output whenever the configured key is short (legal — `k` masks
    // every `k` in `blockers: 1`). The provider REFLECTION surface is the raw
    // body above, which is masked; the model never sees a header value.
    const artifact = reviewArtifactFromParsed(parsed) as unknown as Record<string, unknown>;
    ws.write("ai-output.json", Buffer.from(`${pyJsonDumps(artifact)}\n`, "utf8"));
    return { ok: true, artifact, rawResponse: outcome.rawResponse };
  }
  if (outcome.status === "empty_completion") {
    errorLog(`${profile.label}: model returned an empty completion; not retrying ${tier}${diagnosticsLine}`);
    // #1149: routed like the success write above. As written today this is a
    // BACKSTOP rather than a new guarantee, and the reason is worth recording
    // precisely: both fields are already generically redacted where they are
    // built — `outcome.failure.message` through `maskDiagnostic`
    // (model/verdict.ts) or through `describeTransportFailure`'s `redactText`
    // (transport/http.ts), and `diagnostics.record`'s one provider-controlled
    // field through `safeReasonToken`'s `redactText`
    // (model/response-diagnostics.ts). The routing buys independence from those
    // three upstream sites staying generically-redacted, which is exactly the
    // kind of coupling that produced this gap in the first place. It is
    // structure-preserving and idempotent, so no downstream consumer of this
    // artifact can tell the difference.
    if (outcome.diagnostics !== undefined) {
      ws.write(responseArtifact, pyJsonDumps(redactTextDeep({ error: outcome.failure.message, diagnostics: outcome.diagnostics.record }, knownSecrets)));
    }
  } else if (outcome.status === "parse_exhausted") {
    // #868: the raw response artifact was written before parsing could tell
    // whether the body carried an in-body error (already-masked message
    // below, via `parseVerdictResponse`'s `secrets` — see
    // `surfaceStreamError`); replace it so an unmasked provider body never
    // survives on disk, mirroring the transport-exhausted branch below.
    // #1149: routed through `redactTextDeep` for the provider-authored reason
    // spelled out in the `empty_completion` branch above.
    errorLog(`${profile.label}: parse/validate failures exhausted (${outcome.failure.message})${diagnosticsLine}`);
    ws.write(responseArtifact, pyJsonDumps(redactTextDeep(outcome.diagnostics !== undefined
      ? { error: outcome.failure.message, diagnostics: outcome.diagnostics.record }
      : { error: outcome.failure.message }, knownSecrets)));
  } else {
    // #846: carry the HTTP status and a redacted, length-capped body excerpt
    // (plus the ai-api-format hint on a 404) instead of the bare "model
    // endpoint returned HTTP <status>" message. `secrets` masks this tier's
    // configured key unconditionally, on top of `redactText`'s heuristics.
    // #1037: this lane's configured extra-header VALUES join that list (a
    // provider error body can quote them back, and they carry proxy tokens).
    // #1149: `redactTextDeep` on the persisted body for the provider-authored
    // reason spelled out in the `empty_completion` branch above.
    const detail = describeTransportFailure(outcome.failure, { secrets: knownSecrets });
    // #1080: ONE line for a terminal provider stop — the lane label, the
    // normalized reason, the HTTP status, and the fact that retries were
    // bypassed. Built from enums and an allowlisted signature (never provider
    // prose) and masked against the lane's known secrets like every other line
    // here, because the static text can collide with a very short configured
    // key. Non-terminal failures keep the byte-identical line.
    const terminalNote = outcome.terminal !== undefined
      ? maskKnownSecrets(
        ` [terminal ${outcome.terminal.reason} (${outcome.terminal.signature}) HTTP ${outcome.terminal.httpStatus ?? "?"}; bypassing retries]`,
        knownSecrets,
      )
      : "";
    errorLog(`${profile.label}: transport failures exhausted (${detail})${diagnosticsLine}${terminalNote}`);
    if (outcome.nonRetryable === true) {
      // The SAME annotation carries the terminal reason — never a second one.
      const terminalReason = outcome.terminal !== undefined ? ` [terminal=${outcome.terminal.reason}]` : "";
      annotate(`::error::${profile.label}: model endpoint returned a non-retryable HTTP status${terminalReason}; failing over without retrying (${annotationSafe(detail)})`);
    }
    ws.write(responseArtifact, pyJsonDumps(redactTextDeep(outcome.diagnostics !== undefined
      ? { error: detail, diagnostics: outcome.diagnostics.record }
      : { error: detail }, knownSecrets)));
  }
  // #1080: the normalized terminal reason rides the result so the fallback
  // line below can be truthful about WHY the lane is being left. #1305 adds
  // the bounded, content-free attempt accounting: how many attempts the tier
  // spent, how long they took, and the last failure's kind/status (our own
  // enums and a status number — never provider prose, so no extra masking).
  const lastFailure = outcome.status === "transport_exhausted"
    ? `${outcome.failure.kind}${outcome.failure.status !== undefined ? ` ${outcome.failure.status}` : ""}`
    : `parse ${outcome.failure.kind}`;
  return {
    ok: false,
    artifact: null,
    rawResponse: null,
    attempts: outcome.attempts,
    elapsedSec: Math.round((input.clock() - tierStart) * 10) / 10,
    lastFailure,
    ...(outcome.status === "transport_exhausted" && outcome.terminal !== undefined ? { terminal: outcome.terminal.reason } : {}),
  };
}

/** Every API key the run could have sent, longest first so a key that
 * contains another is masked whole: the route-bound AI_API_KEY plus each
 * configured profile, so the mask holds if the route binding changes. */
function configuredApiKeys(routeKey: string | undefined, profiles: TierProfiles): string[] {
  const keys = [routeKey, profiles.primary.apiKey, profiles.smart.apiKey, profiles.fallback.apiKey]
    .filter((key): key is string => typeof key === "string" && key !== "");
  return [...new Set(keys)].sort((a, b) => b.length - a.length);
}

/** #1037: every configured extra-header VALUE this run could have sent.
 * Response-body surfaces outside a single tier (the native-loop verdict reuse
 * re-parses a persisted `ai-response.<tier>.json`) mask these too, so a value
 * the writing lane masked is never unmasked by a later re-parse. */
function configuredExtraHeaderValues(env: StageEnv): string[] {
  return Object.values(extraHeadersForEnv(env.AI_EXTRA_HEADERS ?? "") ?? {});
}

/** #1094 review finding 2: the ONE known-secret list every persisted
 * `ai-response.<tier>.json` re-parse masks against — the API keys
 * (`configuredApiKeys`) plus the configured extra-header VALUES
 * (`configuredExtraHeaderValues`), deduped and sorted LONGEST FIRST so a value
 * contained in a longer one is masked whole rather than leaving its tail
 * behind. The primary native-loop reuse parse used to mask API keys only: a
 * gateway that echoed a configured header value into the persisted envelope
 * got it back verbatim in that parse's thrown messages (`errorLog`, and from
 * there the summary). Both reuse parses now go through this one helper, so a
 * value the writing lane masked is never unmasked by a later re-parse. */
export function configuredKnownSecrets(env: StageEnv, profiles: TierProfiles): string[] {
  // #1428: a credential the endpoint URL carries in its userinfo is a
  // configured credential too — masked wherever the configured-value mask
  // set is applied (the raw URL itself is structurally redacted at the
  // interpolation sites via `redactEndpointUrlCredential`; this value mask
  // is the defense-in-depth layer for a decoded echo).
  const urlCredentials = [profiles.primary.baseUrl, profiles.smart.baseUrl, profiles.fallback.baseUrl]
    .map((baseUrl) => endpointUrlCredentialOrEmpty(baseUrl))
    .filter((credential) => credential !== "");
  return [...new Set([...configuredApiKeys(env.AI_API_KEY, profiles), ...configuredExtraHeaderValues(env), ...urlCredentials])]
    .sort((a, b) => b.length - a.length);
}

/** #1256: the historical byte ceiling on the fallback recovery request's
 * re-truncated corpus now lives in src/corpus/budgets.ts (re-exported here
 * for its existing import surface); #1598's assembled fallback corpus obeys
 * the same cap. */
export { FALLBACK_CORPUS_RETRUNCATION_MAX_BYTES } from "../corpus/budgets.js";

/** review.sh: the primary call (native-verdict fast path, then the standard
 * corpus review) and the fallback on total primary failure. */
async function producePrimaryReview(input: ReviewCallInput & {
  runDir: string;
  budgets: ReturnType<typeof resolveTierBudgets>;
  /** #1598: what the fallback evidence-failover harness phase needs (the
   * smart escalation's inputs, mirrored). */
  generatedPaths: ReadonlySet<string>;
  standards: { resolved: string | null; content: Uint8Array | null; changedInPr?: boolean };
  /** The checkout the tool executors read (never the artifact run dir). */
  workspace: string;
  /** The run's configured forge read capability for the fallback tier's
   * native loop (same adapter the primary tier binds). */
  ghApi?: HarnessDeps["ghApi"];
}): Promise<{
  artifact: Record<string, unknown> | null;
  analysisEngine: string;
  fromPrimary: boolean;
  fromFallback: boolean;
  /** #1504: the artifact is the native loop's own in-conversation verdict —
   * the conversation the loop's trace-only repair merges into. Only this
   * artifact can suppress the standalone repair pass on the loop's behalf. */
  nativeLoopVerdict: boolean;
  /** #1598: the fallback tier's evidence harness ran (its outcome — verdict
   * or recorded failure — lives in tool-harness.fallback.json). */
  fallbackNativeLoopRan: boolean;
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
        // The native loop dials the RESOLVED primary lane's transport
        // (#1507 — the harness resolves the same `profiles.primary` this
        // review call uses), whose values can differ from the route-bound
        // AI_* environment, so mask every key AND every configured
        // extra-header value (#1094: the same list the writing lane masked
        // the persisted envelope against — a gateway can quote either
        // straight back into this re-parse's thrown messages).
        const parsed = parseVerdictResponse(JSON.parse(Buffer.from(responseBytes).toString("utf8")), configuredKnownSecrets(env, profiles));
        const artifact = reviewArtifactFromParsed(parsed) as unknown as Record<string, unknown>;
        ws.write("ai-output.json", Buffer.from(`${pyJsonDumps(artifact)}\n`, "utf8"));
        return {
          artifact,
          analysisEngine: annotateAnalysisEngine(
            // #1507: name the lane the harness actually dialed — the resolved
            // primary profile, not the raw AI_* base env, which in the
            // default routing mode (off) can differ from the lane an
            // ai-primary-* override selected.
            // #1465: the profile's model is already the trimmed opaque id the
            // harness sends, so the published engine names the model the
            // provider actually saw.
            // #1474 review round 3: the profile's apiFormat is the checked
            // wire family (#1493), so the published family is exactly the
            // one the verdict request was formatted for.
            analysisEngineBase(profiles.primary.model, profiles.primary.baseUrl.trim(), profiles.primary.apiFormat),
            "primary",
            {
              ...(env.REVIEW_ROUTE !== undefined ? { reviewRoute: env.REVIEW_ROUTE } : {}),
              ...(env.ROUTE_REASON !== undefined ? { routeReason: env.ROUTE_REASON } : {}),
            },
          ),
          fromPrimary: true,
          fromFallback: false,
          nativeLoopVerdict: true,
          fallbackNativeLoopRan: false,
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
      nativeLoopVerdict: false,
      fallbackNativeLoopRan: false,
    };
  }

  // Fallback is availability recovery, never quality escalation.
  if (!profiles.fallback.resolved) {
    const outcome = handleModelFailure(`${firstProfile.label} model unavailable and no fallback model configured`, env.ON_MODEL_FAILURE ?? "fail");
    if (outcome.action === "fail") throw new RunReviewError(outcome.reason);
    log("on_model_failure=notice: emitting a request_changes notice instead of failing the check");
    return noticeResult(ws, outcome);
  }

  // #1080: after a TERMINAL provider failure the historical wording ("after
  // retries") is false — no retry ran. Say so, in the same single line, with
  // the normalized reason; otherwise this line stays byte-identical.
  // #1305: the non-terminal line now states the truth explicitly too — the
  // bounded attempt count, the wall-clock spend, and the last failure's
  // kind/status — instead of the vague "after retries", so the reason for
  // fallback and the time spent on primary attempts are always explicit.
  // The line is masked like every other line in this stage (the static text
  // can collide with a very short configured key); its variable content is
  // enum-only, so the mask is belt-and-braces. The fallback keeps its own
  // independent profile and credentials either way.
  errorLog(primary.terminal !== undefined
    ? `${firstProfile.label}: terminal=${primary.terminal}; bypassing retries; trying fallback: ${profiles.fallback.model} @ ${redactEndpointUrlCredential(profiles.fallback.baseUrl)} (${profiles.fallback.apiFormat})`
    : maskKnownSecrets(`${firstProfile.label} model unavailable after ${primary.attempts ?? "?"} attempt(s) in ${primary.elapsedSec ?? "?"}s (last failure: ${primary.lastFailure ?? "unknown"}); trying fallback: ${profiles.fallback.model} @ ${redactEndpointUrlCredential(profiles.fallback.baseUrl)} (${profiles.fallback.apiFormat})`, configuredKnownSecrets(env, profiles)));

  // #1598/#1585: bounded evidence-phase failover. When the primary NATIVE
  // tool loop stopped on a provider/transport failure BEFORE executing any
  // investigation call, a fallback that only replaces the verdict call would
  // inherit zero investigation. Run a fresh native investigation on the
  // RESOLVED fallback lane first; its in-conversation verdict, when usable,
  // IS the fallback review (the primary fast path's shape). A trigger that
  // does not fire keeps today's byte-identical fallback path.
  const fallbackHarnessRan = await runFallbackEvidenceHarness({
    env, ws, profiles, log, errorLog, budgets,
    generatedPaths: input.generatedPaths,
    standards: input.standards,
    workspace: input.workspace,
    ghApi: input.ghApi,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    primaryHarness: harness,
    primaryVerdictElapsedSec: primary.elapsedSec,
  });
  if (fallbackHarnessRan) {
    const fallbackHarness = safeJson(ws.read("tool-harness.fallback.json"));
    const status = String(fallbackHarness?.stop_reason ?? fallbackHarness?.native_loop_degraded ?? "");
    const produced = fallbackHarness?.native_loop_verdict_produced === true;
    const responseBytes = ws.read("ai-response.fallback.json");
    if (status !== "request-error" && status !== "wall-clock-exceeded" && produced && responseBytes !== null && responseBytes.length > 0) {
      try {
        // The fallback loop dials the RESOLVED fallback lane (#1598), whose
        // values can differ from the route-bound AI_* environment — mask
        // every key AND every configured extra-header value, exactly like
        // the primary fast path's re-parse (#1094).
        const parsed = parseVerdictResponse(JSON.parse(Buffer.from(responseBytes).toString("utf8")), configuredKnownSecrets(env, profiles));
        const artifact = reviewArtifactFromParsed(parsed) as unknown as Record<string, unknown>;
        ws.write("ai-output.json", Buffer.from(`${pyJsonDumps(artifact)}\n`, "utf8"));
        log("Fallback tool harness produced a verdict");
        return {
          artifact,
          analysisEngine: annotateAnalysisEngine(
            analysisEngineBase(profiles.fallback.model, profiles.fallback.baseUrl.trim(), profiles.fallback.apiFormat),
            "fallback",
            { ...(env.REVIEW_ROUTE !== undefined ? { reviewRoute: env.REVIEW_ROUTE } : {}) },
          ),
          fromPrimary: false,
          fromFallback: true,
          nativeLoopVerdict: true,
          fallbackNativeLoopRan: true,
        };
      } catch (cause) {
        errorLog(`fallback native_loop verdict did not parse: ${cause instanceof Error ? cause.message : "unknown"}`);
      }
    } else {
      // #1598: the fallback harness itself failed (transport/wall-clock or no
      // usable verdict). Availability recovery — never abort the fallback
      // review, never fake a clean approval; the failure stays recorded in
      // the artifact and the standard fallback corpus review proceeds.
      errorLog(`fallback evidence harness did not produce a usable verdict (stop: ${status || "unknown"}); continuing with the standard fallback corpus review`);
    }
  }

  // #368: the fallback re-truncates the initial corpus. #940: the bound is
  // the declared fallback capacity — the fallback window can be smaller
  // than the primary tier's — never above the historical 120000-byte
  // constant (#1256 pins the cap as named policy). #1598: when the evidence
  // failover ran, the fallback corpus is REBUILT instead (the harness's tool
  // evidence folded in); the untriggered path stays byte-identical.
  if (fallbackHarnessRan) {
    const build = assembleCorpus(ws, env, budgets, "fallback", "fallback", input.generatedPaths, input.standards);
    if (build.overBudget) errorLog("ERROR: assembled fallback corpus exceeds its context budget");
  } else {
    const fallbackCorpusBudget = budgets.fallback !== null
      ? Math.min(FALLBACK_CORPUS_RETRUNCATION_MAX_BYTES, budgets.fallback.maxCorpus)
      : FALLBACK_CORPUS_RETRUNCATION_MAX_BYTES;
    ws.write("review-corpus.fallback.truncated.md", truncateClean(ws.read("review-corpus.md") ?? new Uint8Array(0), fallbackCorpusBudget, "…[content truncated]\n"));
  }
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
      nativeLoopVerdict: false,
      fallbackNativeLoopRan: fallbackHarnessRan,
    };
  }
  const outcome = handleModelFailure("Fallback model failed", env.ON_MODEL_FAILURE ?? "fail");
  if (outcome.action === "fail") throw new RunReviewError(outcome.reason);
  log("on_model_failure=notice: emitting a request_changes notice instead of failing the check");
  return noticeResult(ws, outcome);
}

/** #1598/#1585: the evidence-failover trigger's guard, as a pure predicate.
 *
 * The failover runs a FRESH investigation on the fallback lane, so it may
 * only fire when the primary lane paid for NO investigation at all:
 *
 * - the primary native loop degraded on a transport failure
 *   (`native_loop_degraded === "request-error"`), and
 * - it dispatched ZERO tool calls (`executed_request_count === 0`).
 *
 * The counter is the #1597 SETTLED `executed_request_count` — every call
 * that reached an executor, successful OR failed, the same population as
 * the `tool_calls` trace. It is the spend signal, never the ok-only
 * `successful_request_count`: a primary call that FAILED was still paid
 * for, and a trigger built on the success-only count could restart an
 * investigation the primary had already paid for (#1598: "no restarting a
 * partially executed primary investigation"; "don't repeat already-paid
 * investigation"). Before #1597 settled the field, the failover needed its
 * own dispatched counter; the settled population is exactly that, so the
 * trigger reads it directly.
 *
 * Fail-closed: an artifact that does not report the executed count is
 * UNKNOWN, and unknown state never fires the trigger — the run keeps
 * today's corpus-only fallback review instead of spending on a second
 * investigation. */
export function fallbackEvidenceFailoverEligible(primaryHarness: Record<string, unknown> | null): boolean {
  if (primaryHarness === null) return false;
  if (primaryHarness.native_loop_degraded !== "request-error") return false;
  const executed = primaryHarness.executed_request_count;
  if (typeof executed !== "number" || !Number.isFinite(executed)) return false;
  return executed === 0;
}

/** #1598 (review): the wall-clock share the failover's investigation may
 * spend, as a pure function of the primary's measured whole-run spend.
 *
 * The failover runs a SECOND native investigation, so it must draw from the
 * same wall-clock envelope the primary exchange was configured with —
 * a primary that spent T seconds before its transport failure leaves the
 * failover `tool-loop-wall-clock-sec − T`, never a second full budget.
 *
 * T is the WHOLE spend between the envelope's start and this decision, not
 * just the loop's own time (#1598 review round 4): between the degraded loop
 * and the failover the engine also ran the primary CORPUS-verdict attempt
 * (`primary.elapsedSec` — #1305 attempt accounting on the failed tier call,
 * the run's injected clock), and the loop artifact's #702 telemetry
 * (`tool_loop_telemetry.usage.elapsed_sec` — the loop's measured elapsed,
 * distinct from `budget.wall_clock_sec`, which on an uncapped loop records
 * the configured ceiling) stops when the loop stops. Subtracting only the
 * loop's telemetry would let the failover's `deadline = now + remaining`
 * slide past the original envelope by the verdict attempt's duration —
 * a slow primary verdict call would silently BUY the failover extra time.
 *
 * Fail-closed: EITHER spend unknown — an artifact without a finite
 * non-negative telemetry elapsed, or a tier call that did not report its
 * elapsed — returns null and the caller keeps today's corpus-only fallback
 * review instead of spending on a mis-bounded second investigation. Known
 * spends return `max(0, loopWallClockSec − loopSpend − verdictSpend)`. */
export function fallbackEvidenceWallClockRemainingSec(
  primaryHarness: Record<string, unknown> | null,
  primaryVerdictElapsedSec: number | undefined,
  loopWallClockSec: number,
): number | null {
  if (primaryHarness === null) return null;
  const telemetry = primaryHarness.tool_loop_telemetry;
  if (telemetry === null || typeof telemetry !== "object") return null;
  const usage = (telemetry as Record<string, unknown>).usage;
  if (usage === null || typeof usage !== "object") return null;
  const loopSpend = (usage as Record<string, unknown>).elapsed_sec;
  if (typeof loopSpend !== "number" || !Number.isFinite(loopSpend) || loopSpend < 0) return null;
  const verdictSpend = primaryVerdictElapsedSec;
  if (typeof verdictSpend !== "number" || !Number.isFinite(verdictSpend) || verdictSpend < 0) return null;
  return Math.max(0, loopWallClockSec - loopSpend - verdictSpend);
}

/** #1598/#1585: the fallback tier's evidence-failover harness phase. The
 * trigger is deliberately narrow — the primary native loop must have degraded
 * on `request-error` with ZERO executed investigation calls, the fork gate
 * must be inactive, and the fallback harness must not already exist
 * (defensive idempotency). Anything else (any executed call, a budget/model-
 * stopped/wall-clock stop, an active fork gate) keeps today's fallback path.
 * Returns true when the phase ran; its outcome — verdict or recorded failure
 * — lives in `tool-harness.fallback.json` and is read by the caller. */
async function runFallbackEvidenceHarness(input: {
  env: StageEnv;
  ws: RunWorkspace;
  profiles: TierProfiles;
  log: (line: string) => void;
  errorLog: (line: string) => void;
  budgets: ReturnType<typeof resolveTierBudgets>;
  generatedPaths: ReadonlySet<string>;
  standards: { resolved: string | null; content: Uint8Array | null; changedInPr?: boolean };
  workspace: string;
  ghApi?: HarnessDeps["ghApi"];
  signal?: AbortSignal;
  primaryHarness: Record<string, unknown> | null;
  primaryVerdictElapsedSec: number | undefined;
}): Promise<boolean> {
  const toolMode = (input.env.TOOL_MODE ?? "off").toLowerCase();
  if (toolMode !== "native_loop") return false;
  if (!fallbackEvidenceFailoverEligible(input.primaryHarness)) return false;
  // #1598 (review): bounded spend — the failover draws from the SAME loop
  // wall-clock envelope the primary exchange was configured with, never a
  // second full budget. The primary's WHOLE recorded spend — the loop's own
  // telemetry plus the corpus-verdict attempt that ran between the degraded
  // loop and this decision (#1598 review round 4: the envelope's start is
  // the loop, and every measured second since then counts) — leaves the
  // remaining share; a share at or below the verdict reserve's 30s floor
  // (or an unknown spend on either side) keeps today's corpus-only fallback
  // review — fail closed, never restart spend on an exhausted or
  // unmeasurable budget. The gate is deliberately stricter than the reserve
  // arithmetic itself (which caps the reserve at half of a small envelope):
  // a share that leaves less than the 30s floor cannot fund a meaningful
  // investigation plus its closing verdict.
  const [, loopWallClockSec] = resolveLoopLimits(input.env, "primary");
  const wallClockRemainingSec = fallbackEvidenceWallClockRemainingSec(input.primaryHarness, input.primaryVerdictElapsedSec, loopWallClockSec);
  if (wallClockRemainingSec === null || wallClockRemainingSec <= VERDICT_WALL_CLOCK_RESERVE_MIN_SEC) return false;
  // The fork privilege separation owns this decision (docs/fork-review.md):
  // a gated run never gains a second tool loop through failover.
  if (gateForkForForks(input.env, input.env.IS_FORK_PR ?? "false") !== null) return false;
  if (input.ws.isFile("tool-harness.fallback.json")) return false;
  const prebuild = assembleCorpus(input.ws, input.env, input.budgets, "fallback", "fallback", input.generatedPaths, input.standards);
  if (prebuild.overBudget) input.errorLog("ERROR: assembled fallback corpus exceeds its context budget");
  input.log("native_loop: primary gathered no evidence before transport failure; running fallback-lane investigation");
  // #1515: the fallback loop is recovery class — the adapter reads
  // TOOL_HARNESS_TIER itself, so the binding below steers both the tier's
  // lane resolution and the governor priority.
  const savedTier = input.env.TOOL_HARNESS_TIER;
  input.env.TOOL_HARNESS_TIER = "fallback";
  try {
    // #1598 (review): bind the ALREADY-resolved fallback lane (resolved at
    // the top of this run, before any route rebind mutated the base AI_*
    // keys). Re-resolving from env here would hand an inherited fallback
    // lane the primary-override endpoint/key/format while
    // callTier('fallback', ...) still dials the original resolved lane.
    await runToolHarnessPhase(input.ws, input.env, input.workspace, input.log, input.signal, input.ghApi, wallClockRemainingSec, input.profiles.fallback);
  } catch (cause) {
    // #1094: a thrown message can quote a configured credential back — mask
    // like every other diagnostics line in this stage.
    input.errorLog(`fallback tool harness failed: ${maskKnownSecrets(cause instanceof Error ? cause.message : String(cause), configuredKnownSecrets(input.env, input.profiles))}`);
    // The synthetic keeps the degraded fail-closed shape regardless of the
    // thrown cause (the cause distinction rides the log line above); a
    // degraded fallback artifact preserves the #978 no-evidence eligibility.
    input.ws.write("tool-harness.fallback.json", '{"tier":"fallback","mode":"native_loop","error":"execution failed","native_loop_degraded":"request-error","stop_reason":"request-error","rounds":0,"planned_request_count":0,"executed_request_count":0,"successful_request_count":0,"refused_request_count":0,"deduplicated_request_count":0,"tool_results":[]}\n');
  } finally {
    if (savedTier === undefined) delete input.env.TOOL_HARNESS_TIER;
    else input.env.TOOL_HARNESS_TIER = savedTier;
  }
  return true;
}

/** `on-model-failure: notice`: the notice verdict is already final JSON, so
 * it is parsed as the content of a provider reply (the same validation and
 * artifact normalization a model answer gets), never as the reply itself.
 * Preconditions pinned: `aiOutputJson` is built entirely from static local
 * literals (src/prompt/failure.ts) — never provider-influenced text — which
 * is why this call passes no known-secret list and the #1094 content gate is
 * correctly inert here. If the notice content ever interpolates
 * provider-influenced text, this call must gain the configured known-secret
 * list so the gate covers it. */
function noticeResult(
  ws: RunWorkspace,
  outcome: { aiOutputJson: string; analysisEngine: string },
): { artifact: Record<string, unknown>; analysisEngine: string; fromPrimary: false; fromFallback: false; nativeLoopVerdict: false; fallbackNativeLoopRan: false } {
  const parsed = parseVerdictResponse({ choices: [{ message: { content: outcome.aiOutputJson } }] });
  const artifact = reviewArtifactFromParsed(parsed) as unknown as Record<string, unknown>;
  ws.write("ai-output.json", Buffer.from(`${pyJsonDumps(artifact)}\n`, "utf8"));
  return { artifact, analysisEngine: outcome.analysisEngine, fromPrimary: false, fromFallback: false, nativeLoopVerdict: false, fallbackNativeLoopRan: false };
}

interface SmartReviewInput extends ReviewCallInput {
  budgets: ReturnType<typeof resolveTierBudgets>;
  generatedPaths: ReadonlySet<string>;
  standards: { resolved: string | null; content: Uint8Array | null; changedInPr?: boolean };
  runDir: string;
  /** The checkout the tool executors read (never the artifact run dir). */
  workspace: string;
  /** #1210: the run's configured forge read capability for the smart tier's
   * native loop (same adapter the primary tier binds). */
  ghApi?: HarnessDeps["ghApi"];
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
      const smartEnvKeys = ["SMART_BASE_URL", "SMART_MODEL", "SMART_API_FORMAT", "SMART_API_KEY", "SMART_REASONING_EFFORT"] as const;
      const savedSmartEnv = smartEnvKeys.map((key) => [key, env[key]] as const);
      env.SMART_BASE_URL = profiles.smart.baseUrl;
      env.SMART_MODEL = profiles.smart.model;
      env.SMART_API_FORMAT = profiles.smart.apiFormat;
      env.SMART_API_KEY = profiles.smart.apiKey;
      // #998: bind the smart lane's resolved effort beside its transport keys
      // so the harness's loop rounds, summarizer turn, and closing verdict
      // turn all send the smart effort rather than the base one.
      env.SMART_REASONING_EFFORT = profiles.smart.reasoningEffort;
      env.TOOL_HARNESS_TIER = "smart";
      try {
        await runToolHarnessPhase(ws, env, input.workspace, log, input.signal, input.ghApi);
      } catch (cause) {
        errorLog(`smart tool harness failed: ${cause instanceof Error ? cause.message : String(cause)}`);
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
          // #1037: the same masking as the writing lane, so a value the
          // writing lane masked in this artifact cannot reappear in the
          // messages thrown from this re-parse.
          const parsed = parseVerdictResponse(JSON.parse(Buffer.from(responseBytes).toString("utf8")), configuredKnownSecrets(env, profiles));
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
