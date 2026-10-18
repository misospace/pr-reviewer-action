import { appendFileSync } from "node:fs";
import { formatResponseDiagnosticsLine } from "../model/response-diagnostics.js";
import { renderStepSummary, type ReviewStepOutputs } from "../publish/outputs.js";
import { publicAnalysisEngine } from "../prompt/index.js";
import { resolveTierBudgets } from "../corpus/budgets.js";
import type { HumanReviewRoutingPlan } from "../routing/human-review-routing.js";
import type { StageEnv } from "./env.js";
import type { RunWorkspace } from "./workspace.js";
import { safeJson } from "./stages.js";

/**
 * Step summary (review.sh `write_step_summary`): the observability table a
 * debugging user reads instead of raw logs. Extracted from `runReview` so the
 * rendering contract — findings table, tool telemetry, route/coverage rows —
 * is testable against a literal `SummaryInput` instead of a full review run.
 */
export interface SummaryInput {
  outputs: ReviewStepOutputs;
  env: StageEnv;
  /** The summary reads run artifacts; a full `RunWorkspace` satisfies this. */
  ws: Pick<RunWorkspace, "read" | "isFile">;
  reviewRecord: Record<string, unknown>;
  primaryHarness: Record<string, unknown> | null;
  smartHarness: Record<string, unknown> | null;
  coverage: Record<string, unknown> | null;
  budgets: ReturnType<typeof resolveTierBudgets>;
  route: string;
  routeReason: string;
  analysisEngine: string;
  fallbackUsed: boolean;
  /** #1005: the deterministic routing plan, supplied only when routing ran. */
  reviewRouting?: HumanReviewRoutingPlan;
}

/** Port of write_step_summary. Appends to `stepSummaryPath`; the summary is
 * observability, so a write failure never fails the review. */
export function writeStepSummary(stepSummaryPath: string, input: SummaryInput): void {
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
    findings,
    upstreamLinkMode: upstreamLinkModeFromEnv(env),
    requiredChecksStatus: input.outputs.requiredChecks,
    // #1003: present only when triage ran (the decision output is "" when the
    // input is off), so a disabled run's summary gains no row.
    ...(input.outputs.reviewTriageDecision !== ""
      ? { reviewTriage: { decision: input.outputs.reviewTriageDecision, reason: input.outputs.reviewTriageReason } }
      : {}),
    // #1005: present only when routing ran (mode != off), so a run without
    // routing gains no row. Action-owned; no model text.
    ...(input.reviewRouting
      ? {
        reviewRouting: {
          status: input.reviewRouting.status,
          targetIds: input.reviewRouting.targetIds,
          users: input.reviewRouting.users,
          teams: input.reviewRouting.teams,
        },
      }
      : {}),
    // #1073: present only when the confidence scorer ran (all five outputs
    // are "" when it is disabled), so a disabled run's summary gains no row.
    ...(input.outputs.confidenceStatus !== undefined && input.outputs.confidenceStatus !== ""
      ? {
        confidence: {
          status: input.outputs.confidenceStatus,
          score: input.outputs.confidenceScore ?? "",
          risk: input.outputs.confidenceRisk ?? "",
          reason: input.outputs.confidenceReason ?? "",
          model: input.outputs.confidenceModel ?? "",
        },
      }
      : {}),
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
          // #1047: content-free failure shape + budget raise, when the
          // verdict turn recorded them.
          ...(primaryHarness?.native_loop_verdict_diagnostics !== undefined && primaryHarness.native_loop_verdict_diagnostics !== null
            && typeof primaryHarness.native_loop_verdict_diagnostics === "object"
            ? { diagnostics: formatResponseDiagnosticsLine(primaryHarness.native_loop_verdict_diagnostics as Record<string, unknown>) }
            : {}),
          ...(typeof primaryHarness?.native_loop_verdict_budget_raised_to === "number"
            ? { budgetRaisedTo: primaryHarness.native_loop_verdict_budget_raised_to }
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

/** #975: mirror of `entrypoints.ts`' upstream-link-mode normalization — the
 * step-summary findings table neutralizes links exactly like the published
 * body does. */
function upstreamLinkModeFromEnv(env: StageEnv): "inert" | "togithub" {
  const value = (env.UPSTREAM_LINK_MODE ?? "").trim().toLowerCase();
  return value === "togithub" ? "togithub" : "inert";
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
