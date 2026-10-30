/** Bounded-cardinality metrics for the controller admin listener (#737).
 *
 * Metric names and label names are declared by the registry; label values
 * can only enter through fixed enum validation or capped allowlists. Once an
 * allowlist or series cap is reached, values collapse to `other` or one
 * overflow counter. Do not add identifiers (PR numbers, SHAs, prose, paths)
 * as labels: those values are intentionally absent from public setters.
 */
import type { JobLifecycleState } from "../queue/types.js";
import type { UsageRole } from "../state/types.js";
import type { AdminQueueStatus, AdminRunSummary } from "./types.js";

export type AdminFailureCategory = "timeout" | "provider" | "executor" | "publication" | "cancelled" | "unknown";
export type AdminToolStopReason = "completed" | "budget" | "denied" | "error" | "unknown";
export type AdminPublicationOutcome = "retry" | "failure";
export type AdminWebhookOutcome = "accepted" | "rejected";
export type AdminVerdict = "approve" | "request_changes";
export type AdminMetricKind = "counter" | "gauge" | "histogram";
export interface AdminMetricDefinition { readonly name: string; readonly help: string; readonly kind: AdminMetricKind; readonly labelNames: readonly string[] }
interface Series { readonly definition: AdminMetricDefinition; readonly labels: Readonly<Record<string, string>>; value: number }

const STATES: readonly JobLifecycleState[] = ["queued", "starting", "running", "publishing", "completed", "failed", "cancelled", "superseded"];
const ROLES: readonly UsageRole[] = ["primary", "specialist", "tool", "evidence", "judge"];
const VERDICTS: readonly AdminVerdict[] = ["approve", "request_changes"];
const FAILURES: readonly AdminFailureCategory[] = ["timeout", "provider", "executor", "publication", "cancelled", "unknown"];
const STOP_REASONS: readonly AdminToolStopReason[] = ["completed", "budget", "denied", "error", "unknown"];
const PROVENANCE = ["provider-reported", "configured-estimate", "unknown", "mixed"] as const;
const FIXED_VALUES: Readonly<Record<string, readonly string[]>> = {
  state: STATES, verdict: VERDICTS, category: FAILURES, role: ROLES,
  stop_reason: STOP_REASONS, outcome: ["retry", "failure", "accepted", "rejected"],
  provenance: PROVENANCE, kind: ["input", "output", "cache_read", "cache_write"],
};
const DEFINITIONS: readonly AdminMetricDefinition[] = [
  { name: "pr_reviewer_admin_metrics_overflow_total", help: "Metric updates rejected by the series cap", kind: "counter", labelNames: [] },
  { name: "pr_reviewer_admin_audit_failures_total", help: "Admin audit sink failures", kind: "counter", labelNames: [] },
  { name: "pr_reviewer_admin_queue_depth", help: "Queue depth by lifecycle state", kind: "gauge", labelNames: ["state"] },
  { name: "pr_reviewer_admin_queue_oldest_age_ms", help: "Age of oldest queued item", kind: "gauge", labelNames: [] },
  { name: "pr_reviewer_admin_active_workers", help: "Active workers by bounded executor identity", kind: "gauge", labelNames: ["executor"] },
  { name: "pr_reviewer_admin_review_latency_ms", help: "Review duration by bounded outcome", kind: "histogram", labelNames: ["outcome"] },
  { name: "pr_reviewer_admin_verdicts_total", help: "Review verdict count", kind: "counter", labelNames: ["verdict"] },
  { name: "pr_reviewer_admin_failures_total", help: "Failures by category", kind: "counter", labelNames: ["category"] },
  { name: "pr_reviewer_admin_model_requests_total", help: "Requests by allowlisted model route", kind: "counter", labelNames: ["model"] },
  { name: "pr_reviewer_admin_usage_tokens_total", help: "Usage tokens by role", kind: "counter", labelNames: ["role", "kind"] },
  { name: "pr_reviewer_admin_tool_stops_total", help: "Tool loop stops by reason", kind: "counter", labelNames: ["stop_reason"] },
  { name: "pr_reviewer_admin_specialist_usage_total", help: "Specialist usage requests", kind: "counter", labelNames: [] },
  { name: "pr_reviewer_admin_publication_events_total", help: "Publication retries and failures", kind: "counter", labelNames: ["outcome"] },
  { name: "pr_reviewer_admin_webhook_verifications_total", help: "Webhook verification outcomes", kind: "counter", labelNames: ["outcome"] },
  { name: "pr_reviewer_admin_cancellations_total", help: "Run cancellations", kind: "counter", labelNames: [] },
  { name: "pr_reviewer_admin_supersessions_total", help: "Run supersessions", kind: "counter", labelNames: [] },
];

export interface AdminMetricsOptions { readonly maxSeries?: number; readonly allowlistCap?: number; readonly allowedModels?: readonly string[]; readonly allowedExecutors?: readonly string[] }
export class AdminMetricsRegistry {
  private readonly maxSeries: number;
  private readonly allowlistCap: number;
  private readonly allowed: Map<string, Set<string>>;
  private readonly series = new Map<string, Series>();
  private readonly histogramBuckets = [100, 500, 1_000, 5_000, 30_000, 120_000] as const;
  private readonly histograms = new Map<string, { buckets: number[]; count: number; sum: number }>();

  constructor(options: AdminMetricsOptions = {}) {
    this.maxSeries = options.maxSeries ?? 512;
    this.allowlistCap = options.allowlistCap ?? 16;
    if (!Number.isSafeInteger(this.maxSeries) || this.maxSeries < 1 || !Number.isSafeInteger(this.allowlistCap) || this.allowlistCap < 1) throw new RangeError("invalid metrics cap");
    this.allowed = new Map([
      ["model", new Set((options.allowedModels ?? []).slice(0, this.allowlistCap))],
      ["executor", new Set((options.allowedExecutors ?? []).slice(0, this.allowlistCap))],
    ]);
    // Fixed zero-label counters are pre-created so their own lookups never
    // need a new series: the overflow counter cannot recurse into the
    // cap-rejection branch below, and the audit-failure counter stays
    // recordable even when the cap is already full (a full cap is exactly
    // when audit-sink failures are most likely to matter). A cap of 1 can
    // hold only the overflow counter, so the audit pre-create is skipped
    // there rather than spuriously bumping overflow at construction.
    this.update("pr_reviewer_admin_metrics_overflow_total", {}, 0, false);
    if (this.maxSeries >= 2) this.update("pr_reviewer_admin_audit_failures_total", {}, 0, false);
  }

  increment(name: string, labels: Readonly<Record<string, string>> = {}, amount = 1): void { this.update(name, labels, amount, true); }
  set(name: string, labels: Readonly<Record<string, string>>, value: number): void { this.update(name, labels, value, false); }
  bumpAuditFailure(): void { this.increment("pr_reviewer_admin_audit_failures_total"); }
  get seriesCount(): number { return this.series.size; }

  private update(name: string, rawLabels: Readonly<Record<string, string>>, value: number, add: boolean): void {
    const definition = DEFINITIONS.find((item) => item.name === name);
    if (definition === undefined || definition.kind === "histogram" || !Number.isFinite(value) || value < 0) return;
    const labels: Record<string, string> = {};
    for (const labelName of definition.labelNames) {
      const valueIn = rawLabels[labelName];
      const allowedEnum = FIXED_VALUES[labelName];
      if (allowedEnum !== undefined) labels[labelName] = typeof valueIn === "string" && allowedEnum.includes(valueIn) ? valueIn : "other";
      else labels[labelName] = this.allowValue(labelName, valueIn);
    }
    const key = `${name}{${definition.labelNames.map((key) => `${key}=${labels[key]}`).join(",")}}`;
    let series = this.series.get(key);
    if (series === undefined && this.series.size >= this.maxSeries) {
      // Every rejected update is counted, not just the first: the overflow
      // counter is pre-created in the constructor, so its own lookup never
      // needs a new series and cannot recurse into this branch.
      if (name !== "pr_reviewer_admin_metrics_overflow_total") {
        this.update("pr_reviewer_admin_metrics_overflow_total", {}, 1, true);
      }
      return;
    }
    if (series === undefined) {
      series = { definition, labels: Object.freeze(labels), value: 0 };
      this.series.set(key, series);
    }
    series.value = add ? series.value + value : value;
  }

  private allowValue(label: string, value: unknown): string {
    if (typeof value !== "string" || value.length < 1 || value.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(value)) return "other";
    const set = this.allowed.get(label);
    if (set === undefined) return "other";
    if (set.has(value)) return value;
    if (set.size >= this.allowlistCap) return "other";
    set.add(value);
    return value;
  }

  observeReviewLatency(outcome: AdminVerdict, durationMs: number): void {
    if (!VERDICTS.includes(outcome) || !Number.isFinite(durationMs) || durationMs < 0) return;
    const key = `outcome=${outcome}`;
    let hist = this.histograms.get(key);
    if (hist === undefined) { hist = { buckets: this.histogramBuckets.map(() => 0), count: 0, sum: 0 }; this.histograms.set(key, hist); }
    hist.count += 1; hist.sum += durationMs;
    this.histogramBuckets.forEach((bound, index) => { if (durationMs <= bound) hist!.buckets[index]! += 1; });
  }

  deriveQueue(status: AdminQueueStatus): void {
    for (const state of STATES) this.set("pr_reviewer_admin_queue_depth", { state }, status.depthByState[state] ?? 0);
    this.set("pr_reviewer_admin_queue_oldest_age_ms", {}, status.oldestAgeMs);
    for (const [identity, count] of Object.entries(status.activeWorkersByExecutor)) this.set("pr_reviewer_admin_active_workers", { executor: identity }, count);
  }
  deriveRunLatency(run: AdminRunSummary, verdict: AdminVerdict): void {
    if (run.startedAtMs > 0 && run.finishedAtMs >= run.startedAtMs) this.observeReviewLatency(verdict, run.finishedAtMs - run.startedAtMs);
  }
  recordVerdict(verdict: string): void { this.increment("pr_reviewer_admin_verdicts_total", { verdict }); }
  recordFailure(category: string): void { this.increment("pr_reviewer_admin_failures_total", { category }); }
  recordModelRequest(model: string): void { this.increment("pr_reviewer_admin_model_requests_total", { model }); }
  recordUsage(role: string, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): void {
    if (!ROLES.includes(role as UsageRole)) role = "other";
    for (const [kind, value] of [["input", inputTokens], ["output", outputTokens], ["cache_read", cacheReadTokens], ["cache_write", cacheWriteTokens]] as const) this.increment("pr_reviewer_admin_usage_tokens_total", { role, kind }, value);
    if (role === "specialist") this.increment("pr_reviewer_admin_specialist_usage_total");
  }
  recordToolStop(reason: string): void { this.increment("pr_reviewer_admin_tool_stops_total", { stop_reason: reason }); }
  recordPublication(outcome: AdminPublicationOutcome): void { this.increment("pr_reviewer_admin_publication_events_total", { outcome }); }
  recordWebhook(outcome: AdminWebhookOutcome): void { this.increment("pr_reviewer_admin_webhook_verifications_total", { outcome }); }
  recordCancellation(): void { this.increment("pr_reviewer_admin_cancellations_total"); }
  recordSupersession(): void { this.increment("pr_reviewer_admin_supersessions_total"); }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const definition of DEFINITIONS) {
      lines.push(`# HELP ${definition.name} ${definition.help}`, `# TYPE ${definition.name} ${definition.kind === "histogram" ? "histogram" : definition.kind}`);
      const entries = [...this.series.values()].filter((entry) => entry.definition.name === definition.name);
      for (const entry of entries) lines.push(`${definition.name}${this.renderLabels(entry.labels)} ${entry.value}`);
      if (definition.kind === "histogram") {
        for (const [key, hist] of this.histograms) {
          const outcome = key.slice("outcome=".length);
          this.histogramBuckets.forEach((bound, index) => lines.push(`${definition.name}_bucket{outcome="${outcome}",le="${bound}"} ${hist.buckets[index]}`));
          lines.push(`${definition.name}_bucket{outcome="${outcome}",le="+Inf"} ${hist.count}`, `${definition.name}_sum{outcome="${outcome}"} ${hist.sum}`, `${definition.name}_count{outcome="${outcome}"} ${hist.count}`);
        }
      }
    }
    return `${lines.join("\n")}\n`;
  }
  private renderLabels(labels: Readonly<Record<string, string>>): string {
    const entries = Object.entries(labels);
    return entries.length === 0 ? "" : `{${entries.map(([key, value]) => `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`;
  }
}
