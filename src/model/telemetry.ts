/**
 * Usage/cache telemetry normalization (#677 scope). v2 normalizes usage in
 * several places with the same field families; this module is the single
 * normalization point for the v3 transport path. Field names stay
 * protocol-native at the edge (the raw usage object), internal results are
 * camelCase.
 *
 * #1199: the accounting is FORMAT-AWARE, and deliberately so. The two
 * supported wire formats report the same turn's input tokens under different
 * conventions: OpenAI's `prompt_tokens` ALREADY INCLUDES the cached tokens,
 * while Anthropic's `input_tokens` EXCLUDES the cache read/write tokens it
 * reports separately. "The prompt total" is therefore only comparable across
 * providers once the Anthropic cache tokens are added to `input_tokens` —
 * which is exactly what the loop aggregate (`accumulateUsage` in
 * `src/tools/harness.ts`) has always done (#910). A shape-only normalizer
 * cannot make that distinction: an OpenAI-shaped body may carry Anthropic's
 * cache fields, and a shape-only rule would double count the cache there.
 * So the configured api format is threaded in from the transport seam and
 * the native loop, and the SAME rule is applied here and in the aggregate —
 * one accounting, so the persisted per-turn records sum to the aggregate
 * instead of under-reporting it.
 */

export interface UsageTelemetry {
  promptTokens: number | null;
  completionTokens: number | null;
  /** Cached input tokens: the provider's cached subset of the prompt total
   * (OpenAI: `prompt_tokens_details.cached_tokens`; Anthropic: the cache
   * reads, which Anthropic reports outside `input_tokens`). */
  cachedTokens: number | null;
  totalTokens: number | null;
  /**
   * #1466: the UNCACHED input count the provider reported — the part of
   * the prompt that was NOT served from the provider's cache. Anthropic
   * reports it as `input_tokens` (the cache counters sit outside it);
   * OpenAI has no such field, so it is the prompt total minus the cached
   * subset, and only when both are known.
   *
   * Null when the provider reported nothing usable. A token count is
   * NEVER estimated from elapsed time or any other proxy: an estimate
   * would be indistinguishable from a provider-reported measurement.
   *
   * Optional so the hand-built aggregate literals elsewhere (the #1199
   * per-field fold) keep compiling unchanged; the normalizer always sets
   * it explicitly.
   */
  uncachedPromptTokens?: number | null;
  /**
   * #1466: the cache-WRITE count — the prompt tokens the provider wrote
   * INTO its cache during this turn. Anthropic reports it as
   * `cache_creation_input_tokens`; OpenAI reports no cache writes at all,
   * so the OpenAI format's value is always null.
   *
   * Optional for the same reason as `uncachedPromptTokens`.
   */
  cacheWriteTokens?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One reported token count: the integer when the provider reported a usable
 * number (a numeric string counts too — gateways have been known to send
 * those), `null` when it reported none. Junk is never published as a count:
 * a boolean, an empty string, an object, an array, `null`, and a missing
 * field are all "not reported".
 *
 * #1207: a negative number is malformed input, not a measurement — no
 * provider reports negative tokens. A negative count (numeric or numeric
 * string) is "not reported", exactly like a missing field: the persisted
 * per-turn record reports `null` and the loop aggregate (`accumulateUsage`)
 * contributes 0 — while any positive part the same body reports still counts,
 * per-field, the same way a missing name would.
 */
function intOrNull(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    // Normalize -0 (`-0 < 0` is false) so a `-0` survives as exactly `0` —
    // same number, no signed zero pinned into records.
    const t = Math.trunc(value);
    return t === 0 ? 0 : t;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return null;
    const t = Math.trunc(n);
    return t === 0 ? 0 : t;
  }
  return null;
}

/**
 * Account one provider response's usage in the loop aggregate's terms.
 *
 * `apiFormat` is the configured wire format ("openai" | "anthropic") and
 * selects the convention the reported fields follow:
 * - OpenAI: `prompt_tokens` / `completion_tokens` / `total_tokens`, with
 *   `prompt_tokens_details.cached_tokens` (reasoning-model variants
 *   included). The prompt total already includes the cached tokens.
 * - Anthropic: `input_tokens` / `output_tokens`, with the cache tokens
 *   reported OUTSIDE `input_tokens` — `cache_read_input_tokens` and
 *   `cache_creation_input_tokens`. The prompt total is all three (#910).
 *
 * Each format's own field names are the ones that count. The Anthropic
 * branch also reads the OpenAI names, because a streamed Anthropic turn is
 * reassembled into the OpenAI chat shape before it reaches here — the
 * uncached count arrives as `prompt_tokens` with the cache fields kept. The
 * OpenAI branch reads only the OpenAI names, so a body that carries
 * Anthropic's cache fields under the OpenAI format is never counted twice.
 */
export function normalizeUsageTelemetry(usage: unknown, apiFormat: string): UsageTelemetry {
  if (!isRecord(usage)) {
    return {
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
      totalTokens: null,
      uncachedPromptTokens: null,
      cacheWriteTokens: null,
    };
  }
  const u = usage;
  const details = isRecord(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
  if (apiFormat === "anthropic") {
    // Anthropic: the uncached input count, plus the cache tokens it reports
    // separately. Presence-based (not `??`) so a body carrying BOTH names
    // counts the same field the aggregate counts.
    const uncached = "prompt_tokens" in u ? intOrNull(u.prompt_tokens) : intOrNull(u.input_tokens);
    const cacheRead = intOrNull(u.cache_read_input_tokens);
    const cacheCreation = intOrNull(u.cache_creation_input_tokens);
    const parts: number[] = [];
    if (uncached !== null) parts.push(uncached);
    if (cacheRead !== null) parts.push(cacheRead);
    if (cacheCreation !== null) parts.push(cacheCreation);
    const promptTokens = parts.length > 0 ? parts.reduce((sum, part) => sum + part, 0) : null;
    const completionTokens = "completion_tokens" in u
      ? intOrNull(u.completion_tokens)
      : intOrNull(u.output_tokens);
    // The cached SUBSET the aggregate counts as cached: Anthropic's cache
    // reads. A cache write is part of the prompt total above but not a cache
    // read, and a body that reports its cached tokens only under
    // `prompt_tokens_details` (an OpenAI-shaped body under the Anthropic
    // format) reports no cached tokens here either — parity with the
    // aggregate, which counts cache reads only.
    const cachedTokens = cacheRead;
    // Derived: Anthropic reports no total, and the OpenAI-shaped projection
    // of a streamed turn reports one that excludes the cache tokens this
    // branch counts — so the total follows the accounted prompt instead.
    const totalTokens =
      promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null;
    // #1466: the uncached input count is the count Anthropic reports as
    // `input_tokens` (or `prompt_tokens` for a reassembled streamed turn,
    // which carries the cache fields alongside) — the same value the
    // prompt total above adds the cache counters TO. The cache-WRITE count
    // is Anthropic's own `cache_creation_input_tokens`; a body that
    // reported no cache write reports null, never a zero standing in for
    // "not reported".
    return {
      promptTokens,
      completionTokens,
      cachedTokens,
      totalTokens,
      uncachedPromptTokens: uncached,
      cacheWriteTokens: cacheCreation,
    };
  }
  // OpenAI: `prompt_tokens` already includes the cached tokens, so the cache
  // fields are only a breakdown of it — never added to the prompt total. Only
  // the OpenAI field names count here: a body that reports Anthropic's names
  // under the OpenAI format is a misconfigured relay, and counting it would
  // move the published aggregate away from what the provider reported (the
  // aggregate counted exactly these fields before #1199).
  const promptTokens = intOrNull(u.prompt_tokens);
  const completionTokens = intOrNull(u.completion_tokens);
  const cachedTokens = intOrNull(details.cached_tokens);
  const totalTokens =
    intOrNull(u.total_tokens)
    ?? (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
  // #1466: OpenAI reports no separate uncached input count, so it is the
  // prompt total minus the cached subset — and only when BOTH are known:
  // a body that reports one without the other leaves the uncached count
  // unknown rather than guessing it. A cached subset LARGER than the prompt
  // total is a malformed body, not a measurement: the difference would be a
  // negative token count, so it stays unknown. OpenAI reports no cache
  // writes at all, so that field is always null.
  const uncachedDifference =
    promptTokens !== null && cachedTokens !== null ? promptTokens - cachedTokens : null;
  const uncachedPromptTokens =
    uncachedDifference !== null && uncachedDifference >= 0 ? uncachedDifference : null;
  return {
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens,
    uncachedPromptTokens,
    cacheWriteTokens: null,
  };
}

/** v2 cache_hit_ratio: round(cached/prompt, 3); unusable inputs → null. */
export function cacheHitRatio(usage: UsageTelemetry): number | null {
  if (usage.cachedTokens === null || usage.promptTokens === null || usage.promptTokens <= 0) return null;
  return Math.round((usage.cachedTokens / usage.promptTokens) * 1000) / 1000;
}

// ── #1515: run-wide inference-governor admission telemetry ──────────────────
// The governor (src/model/governor.ts) decides WHEN a model request may reach
// the wire; this is the bounded record of each decision. The fields are the
// four the #1515 contract names — queue wait, priority, active count, and
// whether a request was cancelled before dispatch — plus the scheduling
// identity the request queued under. The record is observability only: it
// never feeds a verdict, a route decision, or a retry budget.

/** One admission decision the run-wide inference governor made (#1515). */
export interface GovernorQueueTelemetry {
  /** The request's priority class: 1 authoritative, 2 required pre-pass,
   * 3 smart/fallback recovery, 4 advisory (the #1515 classes, highest first). */
  priority: number;
  /** The deterministic scheduling identity the request queued under —
   * endpoint URL + wire format + model. A credential is structurally absent:
   * the key builder takes no credential-bearing input, so no secret can
   * participate in scheduling identity (#1515). */
  endpointKey: string;
  /** Wall-clock milliseconds from `admit()` to dispatch. 0 for a request
   * admitted immediately (a slot was free). */
  queueWaitMs: number;
  /** In-flight requests (INCLUDING this one) at the moment of dispatch. */
  activeCount: number;
  /** `true` when the request was removed from the queue by a caller
   * cancellation or a deadline expiry — it never dispatched, so it consumed
   * no provider attempt and no retry budget. */
  cancelledBeforeDispatch: boolean;
}

/** The bounded per-run summary of the governor's admission records. */
export interface GovernorTelemetrySummary {
  dispatched: number;
  cancelledBeforeDispatch: number;
  /** The longest wait any request spent queued before dispatch (0 when none queued). */
  maxQueueWaitMs: number;
  /** One row per priority class that saw activity, highest priority first. */
  byPriority: Array<{ priority: number; dispatched: number; cancelledBeforeDispatch: number; maxQueueWaitMs: number }>;
}

/** Fold admission records into the per-run summary. Priority rows are ordered
 * 1 → 4 and include only classes that saw activity, so a disabled or idle
 * class adds no row. */
export function summarizeGovernorTelemetry(records: readonly GovernorQueueTelemetry[]): GovernorTelemetrySummary {
  const rows = new Map<number, { dispatched: number; cancelledBeforeDispatch: number; maxQueueWaitMs: number }>();
  let dispatched = 0;
  let cancelled = 0;
  let maxWait = 0;
  for (const record of records) {
    if (record.cancelledBeforeDispatch) {
      cancelled++;
    } else {
      dispatched++;
    }
    if (record.queueWaitMs > maxWait) maxWait = record.queueWaitMs;
    const row = rows.get(record.priority) ?? { dispatched: 0, cancelledBeforeDispatch: 0, maxQueueWaitMs: 0 };
    if (record.cancelledBeforeDispatch) row.cancelledBeforeDispatch++;
    else row.dispatched++;
    if (record.queueWaitMs > row.maxQueueWaitMs) row.maxQueueWaitMs = record.queueWaitMs;
    rows.set(record.priority, row);
  }
  const byPriority = [...rows.keys()].sort((a, b) => a - b).map((priority) => {
    const row = rows.get(priority)!;
    return { priority, dispatched: row.dispatched, cancelledBeforeDispatch: row.cancelledBeforeDispatch, maxQueueWaitMs: row.maxQueueWaitMs };
  });
  return { dispatched, cancelledBeforeDispatch: cancelled, maxQueueWaitMs: maxWait, byPriority };
}

/** The one bounded log line the review pipeline emits at pipeline end.
 * Priority class names are the #1515 class labels; only active classes appear. */
const GOVERNOR_PRIORITY_NAMES: Record<number, string> = {
  1: "authoritative",
  2: "required-prepass",
  3: "recovery",
  4: "advisory",
};

export function renderGovernorTelemetryLine(summary: GovernorTelemetrySummary): string {
  const parts = [
    `dispatched=${summary.dispatched}`,
    `cancelled_before_dispatch=${summary.cancelledBeforeDispatch}`,
    `max_queue_wait_ms=${summary.maxQueueWaitMs}`,
  ];
  for (const row of summary.byPriority) {
    parts.push(`p${row.priority}(${GOVERNOR_PRIORITY_NAMES[row.priority] ?? "unknown"}): dispatched=${row.dispatched}`
      + ` cancelled_before_dispatch=${row.cancelledBeforeDispatch} max_queue_wait_ms=${row.maxQueueWaitMs}`);
  }
  return parts.join("; ");
}
