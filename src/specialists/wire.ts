/** Wire-response helpers for the specialist runner (v3 port of the
 * `_extract_text` / `_extract_usage` / `_completion_overrun` helpers in
 * `scripts/run_specialists.py`).
 *
 * The v2 helpers read the raw provider wire shape (OpenAI
 * `choices[0].message.content` / `finish_reason`, or Anthropic `content` /
 * `stop_reason`) — the same shape for both a non-streamed body and v2's own
 * SSE-reassembled body, since the v2 reassembler re-emits the wire shape. The
 * v3 transport's non-streamed path (`src/transport/transport.ts`) also
 * returns the genuine provider wire body, but its SSE reassembly
 * (`src/transport/sse.ts`) returns the flattened, camelCase
 * `NormalizedModelResponse` shape instead. These helpers accept both so the
 * specialist runner behaves identically regardless of which transport path
 * produced the response — deliberately dual-shape, not a v2 divergence. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pull the assistant's text out of a (re)assembled chat response. */
export function extractResponseText(response: unknown): string {
  if (!isRecord(response)) return "";
  const choices = response.choices;
  if (Array.isArray(choices) && choices.length > 0 && isRecord(choices[0])) {
    const message = isRecord(choices[0].message) ? choices[0].message : null;
    if (message !== null) {
      const content = message.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const parts = content
          .filter((block): block is Record<string, unknown> => isRecord(block) && typeof block.text === "string")
          .map((block) => block.text as string);
        if (parts.length > 0) return parts.join("");
      }
    }
  }
  const content = response.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is Record<string, unknown> => isRecord(block) && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
  }
  return "";
}

export interface SpecialistUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens?: number | null;
  total_tokens: number | null;
}

function asInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value;
}

/** Normalize provider token usage from a (re)assembled chat response. Handles
 * the OpenAI wire shape, the Anthropic wire shape, and the v3 camelCase
 * `NormalizedModelResponse.usage` shape (`promptTokens`/`completionTokens`/
 * `totalTokens`). Returns `null` when the provider exposed no usage fields. */
export function extractResponseUsage(response: unknown): SpecialistUsage | null {
  if (!isRecord(response)) return null;
  const usage = response.usage;
  if (!isRecord(usage)) return null;

  let prompt = asInt(usage.prompt_tokens);
  let completion = asInt(usage.completion_tokens);
  let total = asInt(usage.total_tokens);
  let cached: number | null = null;
  const details = usage.prompt_tokens_details;
  if (isRecord(details)) cached = asInt(details.cached_tokens);
  if (prompt === null) prompt = asInt(usage.input_tokens);
  if (completion === null) completion = asInt(usage.output_tokens);
  if (cached === null) cached = asInt(usage.cache_read_input_tokens);
  if (cached === null) cached = asInt(usage.cache_creation_input_tokens);
  // v3 camelCase NormalizedModelResponse.usage shape (SSE-reassembled).
  if (prompt === null) prompt = asInt(usage.promptTokens);
  if (completion === null) completion = asInt(usage.completionTokens);
  if (total === null) total = asInt(usage.totalTokens);
  if (total === null && prompt !== null && completion !== null) total = prompt + completion;
  if (prompt === null && completion === null && total === null && cached === null) return null;

  let reasoning: number | null = null;
  const completionDetails = usage.completion_tokens_details;
  if (isRecord(completionDetails)) reasoning = asInt(completionDetails.reasoning_tokens);
  if (reasoning !== null) {
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      cached_tokens: cached,
      reasoning_tokens: reasoning,
      total_tokens: total,
    };
  }
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    cached_tokens: cached,
    total_tokens: total,
  };
}

/** True when the provider cut the completion at the token budget: OpenAI
 * `choices[0].finish_reason == "length"` (also what the v2 SSE reassembler
 * emits), the v3 `NormalizedModelResponse.finishReason === "length"`, or
 * Anthropic `stop_reason == "max_tokens"`. Wire-level only. */
export function completionOverran(response: unknown): boolean {
  if (!isRecord(response)) return false;
  const choices = response.choices;
  if (Array.isArray(choices) && choices.length > 0 && isRecord(choices[0])) {
    if (choices[0].finish_reason === "length") return true;
  }
  if (response.finishReason === "length") return true;
  return response.stop_reason === "max_tokens";
}

/** Merge one response's usage into a running total (thread-safe by
 * construction in JS: no interleaving within a single synchronous call). */
export function mergeUsage(
  into: Record<string, number | null> | null,
  usage: SpecialistUsage,
): Record<string, number | null> {
  if (into === null) return { ...usage };
  const merged: Record<string, number | null> = { ...into };
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value !== "number" || !Number.isInteger(value)) continue;
    const current = merged[key];
    merged[key] = typeof current === "number" && Number.isInteger(current) ? current + value : value;
  }
  return merged;
}
