/** Wire-payload construction for one specialist role call (v3 port of
 * `_build_payload` in `scripts/run_specialists.py`). Mirrors
 * `buildModelRequest` (`src/model/request.ts`) minus the verdict schema: the
 * specialist response contract is different and looser, so an
 * operator-configured `json_schema` on the primary call downgrades to plain
 * `json_object` here and nothing else is carried over. */

export interface SpecialistPayloadInput {
  apiFormat: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature: number | null;
  responseFormat: string;
  tokensParam: string;
  stream: boolean;
}

export type SpecialistPayload = Record<string, unknown>;

export function buildSpecialistPayload(input: SpecialistPayloadInput): SpecialistPayload {
  const { apiFormat, model, system, user, maxTokens, temperature, responseFormat, tokensParam, stream } = input;

  if (apiFormat === "anthropic") {
    const payload: SpecialistPayload = {
      model,
      max_tokens: maxTokens,
      stream,
      system,
      messages: [{ role: "user", content: user }],
    };
    if (temperature !== null) payload.temperature = temperature;
    return payload;
  }

  const tokenField = tokensParam === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens";
  const payload: SpecialistPayload = {
    model,
    stream,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    [tokenField]: maxTokens,
  };
  if (temperature !== null) payload.temperature = temperature;
  if (responseFormat === "json_object" || responseFormat === "json_schema") {
    payload.response_format = { type: "json_object" };
  }
  if (stream) {
    payload.stream_options = { include_usage: true };
  }
  return payload;
}

/** Serialized request-body byte size, for #635 request-shape telemetry and
 * the request artifact write. */
export function payloadBytes(payload: SpecialistPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

/** Copy of `payload` with the completion budget raised for the one-shot
 * overrun retry, or `null` when the budget is already at the ceiling. */
export const OVERRUN_RETRY_MULTIPLIER = 4;
export const OVERRUN_RETRY_CEILING = 32768;

export function overrunRetryPayload(payload: SpecialistPayload, maxTokens: number): SpecialistPayload | null {
  const retryTokens = Math.max(maxTokens, Math.min(maxTokens * OVERRUN_RETRY_MULTIPLIER, OVERRUN_RETRY_CEILING));
  if (retryTokens <= maxTokens) return null;
  const retry: SpecialistPayload = { ...payload };
  for (const field of ["max_tokens", "max_completion_tokens"]) {
    if (field in retry) retry[field] = retryTokens;
  }
  return retry;
}
