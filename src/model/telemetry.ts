/**
 * Usage/cache telemetry normalization (#677 scope). v2 normalizes usage in
 * several places with the same field families; this module is the single
 * provider-neutral normalizer for the v3 transport path. Field names stay
 * protocol-native at the edge (the raw usage object), internal results are
 * camelCase.
 */

export interface UsageTelemetry {
  promptTokens: number | null;
  completionTokens: number | null;
  /** Cached input tokens, from whichever cache field the provider exposed. */
  cachedTokens: number | null;
  totalTokens: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intOrError(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * Normalize a raw provider usage object. Both field families are read
 * regardless of configured api format — proxies and LiteLLM relays remap
 * shapes, so the normalizer stays provider-neutral:
 * - OpenAI: prompt_tokens / completion_tokens / total_tokens,
 *   prompt_tokens_details.cached_tokens (reasoning-model variants included).
 * - Anthropic: input_tokens / output_tokens, cache_read_input_tokens with
 *   cache_creation_input_tokens as the fallback.
 */
export function normalizeUsageTelemetry(usage: unknown): UsageTelemetry {
  if (!isRecord(usage)) {
    return { promptTokens: null, completionTokens: null, cachedTokens: null, totalTokens: null };
  }
  const prompt = intOrError(usage.prompt_tokens) ?? intOrError(usage.input_tokens);
  const completion = intOrError(usage.completion_tokens) ?? intOrError(usage.output_tokens);
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const cached = intOrError(details.cached_tokens)
    ?? intOrError(usage.cache_read_input_tokens)
    ?? intOrError(usage.cache_creation_input_tokens);
  const total = intOrError(usage.total_tokens)
    ?? (prompt !== null && completion !== null ? prompt + completion : null);
  return { promptTokens: prompt, completionTokens: completion, cachedTokens: cached, totalTokens: total };
}

/** v2 cache_hit_ratio: round(cached/prompt, 3); unusable inputs → null. */
export function cacheHitRatio(usage: UsageTelemetry): number | null {
  if (usage.cachedTokens === null || usage.promptTokens === null || usage.promptTokens <= 0) return null;
  return Math.round((usage.cachedTokens / usage.promptTokens) * 1000) / 1000;
}
