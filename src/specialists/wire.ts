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

/** #1207/#1235: a negative token count is malformed input, not a measurement —
 * no provider reports negative tokens. It is "not reported" (`null`), per
 * field, so a malformed body can never publish a negative count here either;
 * positive siblings of the same body still count. `-0` survives as exactly 0
 * (no signed zero pinned into records). */
function asInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value === 0 ? 0 : value;
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

/** The completion-limit stop reasons a provider may report. OpenAI says
 * `length`; Anthropic says `max_tokens`. Both must be recognized whichever
 * shape they arrive in — the #1061 bug was that a streamed Anthropic
 * `message_delta.stop_reason=max_tokens` reaches the specialist as
 * `choices[0].finish_reason === "max_tokens"` (via `toV2Completion`) and was
 * invisible to this check, so the one-shot overrun recovery never fired. */
const COMPLETION_LIMIT_REASONS: ReadonlySet<string> = new Set(["length", "max_tokens"]);

/** #632/#1061: true when the provider cut the completion at the token budget.
 * Recognizes the limit reason in every shape a specialist may see: the v2
 * completion's `choices[0].finish_reason`, the flattened
 * `NormalizedModelResponse.finishReason`, and a raw top-level `stop_reason`.
 * Wire-level only. */
export function completionOverran(response: unknown): boolean {
  if (!isRecord(response)) return false;
  const choices = response.choices;
  if (Array.isArray(choices) && choices.length > 0 && isRecord(choices[0])) {
    const reason = choices[0].finish_reason;
    if (typeof reason === "string" && COMPLETION_LIMIT_REASONS.has(reason)) return true;
  }
  const finishReason = response.finishReason;
  if (typeof finishReason === "string" && COMPLETION_LIMIT_REASONS.has(finishReason)) return true;
  return response.stop_reason === "max_tokens";
}

/** #1061: the model's stop reason for the role diagnostic — a short,
 * provider-controlled label (never the response body). Read from the flattened
 * `finishReason`, else the v2 completion's `choices[0].finish_reason`, else a
 * raw top-level `stop_reason`; `null` when the response carries none. */
export function responseStopReason(response: unknown): string | null {
  if (!isRecord(response)) return null;
  const finishReason = response.finishReason;
  if (typeof finishReason === "string" && finishReason !== "") return finishReason;
  const choices = response.choices;
  if (Array.isArray(choices) && choices.length > 0 && isRecord(choices[0])) {
    const reason = choices[0].finish_reason;
    if (typeof reason === "string" && reason !== "") return reason;
  }
  const stopReason = response.stop_reason;
  if (typeof stopReason === "string" && stopReason !== "") return stopReason;
  return null;
}

/** Merge one response's usage into a running total (thread-safe by
 * construction in JS: no interleaving within a single synchronous call).
 * #1235 mirrors the #1207 clamp at the fold: a negative count (malformed
 * input, exactly what `asInt` refuses upstream) contributes 0 — and a
 * malformed running value (a negative in particular) is "not started",
 * replaced rather than carried, on every fold the running state takes part
 * in: the standing record is re-normalized through `asInt` up front, so a
 * negative running value never survives even when the incoming field for the
 * same key is itself malformed (the `continue` alone would carry it). */
export function mergeUsage(
  into: Record<string, number | null> | null,
  usage: SpecialistUsage,
): Record<string, number | null> {
  if (into === null) {
    const first: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(usage)) first[key] = asInt(value);
    return first;
  }
  const merged: Record<string, number | null> = {};
  for (const [key, current] of Object.entries(into)) merged[key] = asInt(current);
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) continue;
    const current = merged[key];
    merged[key] =
      typeof current === "number" && Number.isInteger(current) && current >= 0 ? current + value : value;
  }
  return merged;
}
