/**
 * Action outputs and step-summary finalization (#680).
 *
 * The workflow-facing output IDs are the canonical kebab-case v3 contract
 * (`contracts/action-v3.yml`); internal TypeScript stays camelCase. The
 * multiline outputs use a random heredoc-style delimiter so model-controlled
 * review text (which prompt injection in the PR can influence) cannot
 * terminate the assignment early and inject arbitrary step outputs — e.g.
 * flip the verdict. That delimiter discipline is the security boundary here;
 * keep it byte-faithful to the v2 writer.
 *
 * The step summary is a typed renderer, not a file reader: the #681
 * orchestrator supplies the telemetry objects the v2 pipeline scraped from
 * run artifacts. Rows render only when their data is supplied.
 */

export const REVIEW_STEP_OUTPUT_IDS = [
  "verdict",
  "verdict-source",
  "required-checks",
  "review-result",
  "incomplete-reason",
  "review-route",
  "escalation-reason",
  "findings",
  "review-markdown",
  "analysis-engine",
  "tool-calls",
  "cache-hit-ratio",
] as const;

export type ReviewStepOutputId = (typeof REVIEW_STEP_OUTPUT_IDS)[number];

export type IncompleteReason = "none" | "execution" | "requirement_trace" | "both";
export const INCOMPLETE_REASON_VALUES: readonly IncompleteReason[] = ["none", "execution", "requirement_trace", "both"];
export function isIncompleteReason(value: unknown): value is IncompleteReason {
  return typeof value === "string" && INCOMPLETE_REASON_VALUES.includes(value as IncompleteReason);
}

export interface ReviewStepOutputs {
  verdict: string;
  /** #978: this verdict is eligible for the fail-on-request-changes bypass.
   * Read in-process by the gate and marker carry-forward; deliberately NOT a
   * published output id. */
  degradedGateBypass: boolean;
  verdictSource: string;
  requiredChecks: string;
  /** #873: the metadata marker's review_result state (clean/findings/
   * partial/issues) — additive; verdict's own value set is unchanged, so
   * a partial review still reports verdict "approve" here and the
   * incompleteness surfaces only through this field. */
  reviewResult: string;
  /** #954: why coverage is incomplete; "none" when complete. */
  incompleteReason: string;
  reviewRoute: string;
  escalationReason: string;
  /** Compact JSON array of the normalized findings. */
  findings: string;
  /** Full review markdown (model-controlled text). */
  reviewMarkdown: string;
  analysisEngine: string;
  /** Compact JSON array of {tier, tool, status} records. */
  toolCalls: string;
  /** "-" when the tool harness reported no ratio. */
  cacheHitRatio: string;
}

/** 16 random bytes as hex — the same entropy the v2 writer draws. */
function randomDelimiterSuffix(randomBytes: () => Uint8Array): string {
  return Array.from(randomBytes(), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Format one `KEY=value` assignment. Single-line values are written
 * directly; values containing newlines use a random `EOF_<hex>` delimiter
 * (never derived from the value — a model-chosen delimiter could otherwise
 * close its own assignment and inject following outputs).
 */
export function formatOutputAssignment(
  key: string,
  value: string,
  randomBytes: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(16)),
): string {
  if (!value.includes("\n")) {
    return `${key}=${value}\n`;
  }
  const delimiter = `EOF_${randomDelimiterSuffix(randomBytes)}`;
  return `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
}

/** Serialize all review-step outputs in contract order. The assignment keys
 * are derived from `REVIEW_STEP_OUTPUT_IDS` so the constant and the writer
 * cannot drift apart. */
export function formatReviewStepOutputs(
  outputs: Omit<ReviewStepOutputs, "degradedGateBypass">,
  randomBytes?: () => Uint8Array,
): string {
  const assignments: Array<[string, string]> = [
    ["verdict", outputs.verdict],
    ["verdict-source", outputs.verdictSource],
    ["required-checks", outputs.requiredChecks],
    ["review-result", outputs.reviewResult],
    ["incomplete-reason", outputs.incompleteReason],
    ["review-route", outputs.reviewRoute],
    ["escalation-reason", outputs.escalationReason],
    ["review-markdown", outputs.reviewMarkdown],
    ["findings", outputs.findings],
    ["tool-calls", outputs.toolCalls],
    ["cache-hit-ratio", outputs.cacheHitRatio],
    ["analysis-engine", outputs.analysisEngine],
  ];
  const declared = new Set<string>(REVIEW_STEP_OUTPUT_IDS);
  for (const [key] of assignments) {
    if (!declared.has(key)) {
      throw new Error(`review step output '${key}' is not in the declared contract IDs`);
    }
  }
  return assignments.map(([key, value]) => formatOutputAssignment(key, value, randomBytes)).join("");
}

/** One {tier, tool, status} tool-call record (the compact output surface). */
export interface ToolCallRecord {
  tier: "primary" | "smart";
  tool: string;
  status: string;
}

/**
 * Build the compact tool-trace output from the harness telemetry: which
 * read-only tools ran, without copying model-controlled arguments into
 * action outputs. Primary calls come first, then smart-tier calls.
 */
export function buildToolCallsOutput(
  primaryHarness: unknown,
  smartHarness: unknown,
): string {
  const records: ToolCallRecord[] = [];
  const collect = (harness: unknown, tier: "primary" | "smart"): void => {
    const calls = (harness as { tool_calls?: unknown } | null)?.tool_calls;
    if (!Array.isArray(calls)) return;
    for (const call of calls) {
      const record = call as { tool?: unknown; status?: unknown };
      if (typeof record?.tool !== "string") continue;
      records.push({ tier, tool: record.tool, status: String(record.status ?? "") });
    }
  };
  collect(primaryHarness, "primary");
  collect(smartHarness, "smart");
  return JSON.stringify(records);
}

/** Cache-hit-ratio step output: "-" when the harness reported nothing. */
export function buildCacheHitRatioOutput(primaryHarness: unknown): string {
  const ratio = (primaryHarness as { usage?: { cache_hit_ratio?: unknown } } | null)
    ?.usage?.cache_hit_ratio;
  return ratio === undefined || ratio === null ? "-" : String(ratio);
}

// ---------------------------------------------------------------------------
// Step summary
// ---------------------------------------------------------------------------

export interface HarnessSummaryTelemetry {
  executedRequestCount?: number;
  successfulToolCalls?: number;
  rounds?: number;
  stopReason?: string;
  /** Smart-tier extras (rendered only for the smart harness row). */
  issuedToolCalls?: number;
  requests?: number;
  verdictStatus?: string;
  fallback?: string;
  /** #702 tool-loop telemetry. */
  budget?: {
    route: string;
    used: number;
    effectiveMaxRequests: string;
    source: string;
    stopReason: string;
    remainingAtStop: string;
  };
}

export interface StepSummaryTelemetry {
  analysisEngine: string;
  verdict: string;
  verdictSource: string;
  findingsCount: number;
  blockersCount: number;
  requiredChecksStatus: string;
  requirementCoverage?: { total: number; unknown: number };
  primaryTools: HarnessSummaryTelemetry;
  smartTools?: HarnessSummaryTelemetry;
  nativeVerdict?: {
    status: string;
    transport?: string;
    attempts: number;
    retried: boolean;
    reason?: string;
  };
  route: string;
  routeReason?: string;
  /** #633 deep-review telemetry row (rendered only when deep review ran). */
  deepReview?: { leads: string; errors: boolean; autoSelection?: { selected: number; skipped: number } };
  budget: string;
  finalContext: string;
  primaryContext?: string;
  diffBytes: { actual: string; truncated: string };
  corpusBytes: { actual: string; truncated: string };
  promptTokens: string;
  completionTokens: string;
  cacheHitRatio: string;
}

/** Render the `### AI PR Review` step-summary table (v2 row structure). */
export function renderStepSummary(telemetry: StepSummaryTelemetry): string {
  const rows: string[] = [
    "| Engine | " + telemetry.analysisEngine + " |",
    `| Verdict | ${telemetry.verdict} (source: ${telemetry.verdictSource}) |`,
    `| Findings | ${telemetry.findingsCount} (blockers: ${telemetry.blockersCount}) |`,
    `| Required checks | ${telemetry.requiredChecksStatus} |`,
  ];
  if (telemetry.requirementCoverage && telemetry.requirementCoverage.total !== 0) {
    rows.push(`| Requirement coverage | ${telemetry.requirementCoverage.total} requirement(s); unresolved: ${telemetry.requirementCoverage.unknown} |`);
  }
  const primary = telemetry.primaryTools;
  rows.push(
    `| Primary tools | ${primary.executedRequestCount ?? 0} executed (${primary.successfulToolCalls ?? 0} successful); rounds: ${primary.rounds ?? 0}; stop: ${primary.stopReason ?? "disabled"} |`,
  );
  if (telemetry.smartTools) {
    const smart = telemetry.smartTools;
    rows.push(
      `| Smart tools | ${smart.issuedToolCalls ?? 0} issued; rounds: ${smart.rounds ?? 0}; requests: ${smart.requests ?? 0}; stop: ${smart.stopReason ?? "unknown"}; verdict: ${smart.verdictStatus ?? "corpus"}; fallback: ${smart.fallback ?? "unknown"} |`,
    );
  }
  if (telemetry.nativeVerdict) {
    let row = `| Native verdict | ${telemetry.nativeVerdict.status}`;
    if (telemetry.nativeVerdict.transport) {
      row += ` via ${telemetry.nativeVerdict.transport}`;
    }
    row += ` (attempts: ${telemetry.nativeVerdict.attempts}, retried: ${telemetry.nativeVerdict.retried}`;
    if (telemetry.nativeVerdict.reason) {
      row += `, reason: ${telemetry.nativeVerdict.reason}`;
    }
    row += ") |";
    rows.push(row);
  }
  rows.push(`| Route | ${telemetry.route} (${telemetry.routeReason ?? ""}) |`);
  const budgetRows: string[] = [];
  for (const harness of [telemetry.primaryTools, telemetry.smartTools]) {
    const budget = harness?.budget;
    if (!budget) continue;
    budgetRows.push(
      `${budget.route}: ${budget.used}/${budget.effectiveMaxRequests} requests (${budget.source}), stop: ${budget.stopReason}, left ${budget.remainingAtStop}`,
    );
  }
  if (budgetRows.length > 0) {
    rows.push(`| Tool budget | ${budgetRows.join("; ")} |`);
  }
  if (telemetry.deepReview) {
    let detail = "";
    if (telemetry.deepReview.autoSelection) {
      detail = ` (auto: ${telemetry.deepReview.autoSelection.selected} role(s) selected, ${telemetry.deepReview.autoSelection.skipped} skipped)`;
    }
    if (telemetry.deepReview.errors) {
      rows.push(`| Deep review | ${telemetry.deepReview.leads} specialist lead(s)${detail}; some roles recorded errors (advisory only) |`);
    } else {
      rows.push(`| Deep review | ${telemetry.deepReview.leads} specialist lead(s)${detail} (advisory only) |`);
    }
  }
  rows.push(`| Budget | ${telemetry.budget} |`);
  rows.push(`| Final context | ${telemetry.finalContext} |`);
  if (telemetry.primaryContext) {
    rows.push(`| Primary context | ${telemetry.primaryContext} |`);
  }
  rows.push(`| Diff bytes | ${telemetry.diffBytes.actual} (truncated: ${telemetry.diffBytes.truncated}) |`);
  rows.push(`| Corpus bytes | ${telemetry.corpusBytes.actual} (truncated: ${telemetry.corpusBytes.truncated}) |`);
  rows.push(`| Prompt tokens | ${telemetry.promptTokens} |`);
  if (telemetry.cacheHitRatio !== "-") {
    rows.push(`| Cache hit ratio | ${telemetry.cacheHitRatio} |`);
  }
  rows.push(`| Completion tokens | ${telemetry.completionTokens} |`);

  const lines = ["### AI PR Review", "", "| Field | Value |", "| --- | --- |", ...rows, ""];
  return lines.join("\n");
}
