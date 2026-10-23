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
 */
function intOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? Math.trunc(n) : null;
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
    return { promptTokens: null, completionTokens: null, cachedTokens: null, totalTokens: null };
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
    return { promptTokens, completionTokens, cachedTokens, totalTokens };
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
  return { promptTokens, completionTokens, cachedTokens, totalTokens };
}

/** v2 cache_hit_ratio: round(cached/prompt, 3); unusable inputs → null. */
export function cacheHitRatio(usage: UsageTelemetry): number | null {
  if (usage.cachedTokens === null || usage.promptTokens === null || usage.promptTokens <= 0) return null;
  return Math.round((usage.cachedTokens / usage.promptTokens) * 1000) / 1000;
}
