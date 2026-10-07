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
import { sanitizeMarkdown, type UpstreamLinkMode } from "./sanitize.js";
import { redactText } from "../context/redact.js";
import { escapeTableCell } from "../gates/ci-wait.js";
import { SEVERITY_LABELS } from "./inline-findings.js";

// ---------------------------------------------------------------------------
// Findings summary (moved from publish.ts, #975): the per-finding table a
// reader sees in place of bare counts, shared by the strict publish body and
// the step summary.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rows rendered before the visible "N more" cap keeps the body bounded
 * (50 findings of up to 2000 characters each would overrun a comment). */
export const FINDINGS_SUMMARY_MAX_ROWS = 50;

const SEVERITY_RANK = ["blocker", "major", "minor", "info"] as const;

/** Per-severity counts in rank order, zero entries omitted: `2 major, 4 minor`. */
export function severityCountsLabel(findings: unknown): string {
  if (!Array.isArray(findings)) return "";
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const severity = isRecord(finding) && typeof finding.severity === "string"
      ? finding.severity
      : "info";
    counts.set(severity, (counts.get(severity) ?? 0) + 1);
  }
  const ordered = [
    ...SEVERITY_RANK.filter((severity) => counts.has(severity)),
    ...[...counts.keys()].filter((severity) => !(SEVERITY_RANK as readonly string[]).includes(severity)).sort(),
  ];
  return ordered.map((severity) => `${counts.get(severity)} ${severity}`).join(", ");
}

/** Wrap an already-escaped body in a fence-safe inline-code span: the
 * delimiter is one backtick longer than the longest backtick run inside the
 * body, so embedded backticks (escaped to `\`` by `escapeTableCell`) or
 * Markdown link syntax cannot close the span and render clickable. Same
 * fail-closed strategy as `inlineCodeValue` (#903).
 *
 * A backtick-bearing body is additionally SPACE-PADDED (`delim + " " + body
 * + " " + delim`). Without the padding, a trailing escaped backtick runs
 * straight into the closing delimiter and merges with it into a longer run
 * (the 1-backtick escape + the 2-backtick fence = a 3-run) that no
 * CommonMark/GFM parser accepts as the equal-length closing delimiter, so
 * the span is left unterminated and the payload renders as live Markdown.
 * CommonMark strips exactly one leading+trailing space, so the visible span
 * content is unchanged. A backtick-free body stays an unpadded single-backtick
 * fence, byte-identical to `inlineCodeValue`. */
function fenceInlineCode(body: string): string {
  if (!body.includes("`")) return `\`${body}\``;
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const delim = "`".repeat(longest + 1);
  return `${delim} ${body} ${delim}`;
}

/** A path (model-controlled) as one bounded code span: whitespace collapsed
 * and fenced by a backtick run longer than any inside it, so it cannot open
 * markdown structure; pipes are escaped because GFM tables split cells even
 * inside code spans. */
function locationCell(finding: Record<string, unknown>): string {
  const file = typeof finding.file === "string" ? finding.file : "";
  const line = typeof finding.line === "number" && Number.isFinite(finding.line) ? String(finding.line) : "";
  if (file === "" && line === "") return "";
  const raw = file === "" ? line : line === "" ? file : `${file}:${line}`;
  return fenceInlineCode(escapeTableCell(raw.replace(/\s+/g, " ").trim()));
}

/**
 * The `### Findings (…)` section: one row per normalized still-open finding
 * — severity, `file:line` (or `file`, or blank), message — the same array
 * the verdict was decided on, so the body is the one place a reader sees the
 * whole set. Messages get redact_text, upstream-link neutralization,
 * whitespace collapse, a length cap, and table-cell escaping; a hostile
 * message cannot split the row or forge headings. Returns "" when there is
 * nothing to render.
 *
 * Per-surface policy for the message cell (#975 / #988): the strict
 * published body (publish.ts) calls this with no opts, keeping the operator's
 * `upstream-link-mode` (linkMode) rendering verbatim; the step summary
 * (renderStepSummary) passes `messageAsInlineCode: true` and additionally
 * fences each non-empty message in a code span, so model-controlled Markdown
 * links/autolinks (e.g. `[x](https://evil.example)`) can never render
 * clickable. Maintainer review on PR #988 (head 43a0808); same fail-closed
 * rationale as `inlineCodeValue` (#903).
 */
export function renderFindingsSummary(
  findings: unknown,
  linkMode: UpstreamLinkMode,
  opts?: { messageAsInlineCode?: boolean },
): string {
  if (!Array.isArray(findings)) return "";
  const rows = findings.filter((item): item is Record<string, unknown> => isRecord(item));
  if (rows.length === 0) return "";
  const counts = severityCountsLabel(rows);
  const lines = [
    `### Findings${counts ? ` (${counts})` : ""}`,
    "",
    "| Severity | Location | Finding |",
    "| --- | --- | --- |",
  ];
  for (const finding of rows.slice(0, FINDINGS_SUMMARY_MAX_ROWS)) {
    const rawSeverity = typeof finding.severity === "string" ? finding.severity : "info";
    const label = Object.hasOwn(SEVERITY_LABELS, rawSeverity) ? SEVERITY_LABELS[rawSeverity]! : rawSeverity;
    const body = escapeTableCell(
      sanitizeMarkdown(redactText(String(finding.message ?? "")), linkMode)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300),
    );
    // #988: fence only non-empty messages; an empty message stays an empty cell.
    const message = opts?.messageAsInlineCode === true && body !== "" ? fenceInlineCode(body) : body;
    lines.push(`| ${escapeTableCell(label)} | ${locationCell(finding)} | ${message} |`);
  }
  if (rows.length > FINDINGS_SUMMARY_MAX_ROWS) {
    lines.push("", `_…and ${rows.length - FINDINGS_SUMMARY_MAX_ROWS} more finding(s) not listed._`);
  }
  return `\n\n${lines.join("\n")}\n`;
}

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
  /** #975: normalized still-open findings rendered as a table below the
   * counts row; empty/absent renders nothing (byte-identical to the v2 table). */
  findings?: unknown;
  /** #975: upstream-link neutralization for finding messages, mirroring the
   * strict publish body's link mode. The step summary additionally fences each
   * non-empty message cell in an inline-code span (see `renderFindingsSummary`)
   * so model-controlled Markdown links/autolinks can never render clickable on
   * this surface, independent of the link-mode choice. */
  upstreamLinkMode?: UpstreamLinkMode;
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
  const block = renderFindingsSummary(telemetry.findings ?? [], telemetry.upstreamLinkMode ?? "inert", { messageAsInlineCode: true });
  return lines.join("\n") + block;
}
