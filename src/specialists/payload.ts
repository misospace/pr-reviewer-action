/** Wire-payload construction for one specialist role call (v3 port of
 * `_build_payload` in `scripts/run_specialists.py`). Mirrors
 * `buildModelRequest` (`src/model/request.ts`) minus the verdict schema: the
 * specialist response contract is different and looser, so an
 * operator-configured `json_schema` on the primary call downgrades to plain
 * `json_object` here and nothing else is carried over. */

import { pyFloatRepr } from "../platform/py.js";

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

/** `json.dumps(value)` with Python's defaults — `", "` / `": "` separators,
 * `ensure_ascii=True` (`\uXXXX` for every non-ASCII UTF-16 unit) — and the
 * payload's one float field (`temperature`) as `repr(float)`. */
function pyDumpsAscii(value: unknown, key: string | null = null): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return key === "temperature" ? pyFloatRepr(value) : String(value);
  if (typeof value === "string") {
    let out = '"';
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      const ch = value[index]!;
      if (ch === '"') out += '\\"';
      else if (ch === "\\") out += "\\\\";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (ch === "\b") out += "\\b";
      else if (ch === "\f") out += "\\f";
      else if (unit < 0x20 || unit > 0x7f) out += `\\u${unit.toString(16).padStart(4, "0")}`;
      else out += ch;
    }
    return `${out}"`;
  }
  if (Array.isArray(value)) return `[${value.map((item) => pyDumpsAscii(item, key)).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).map(([name, item]) => `${pyDumpsAscii(name)}: ${pyDumpsAscii(item, name)}`).join(", ")}}`;
  }
  return "null";
}

/** Serialized request-body byte size for #635 request-shape telemetry
 * (`request_bytes`): v2 measures `len(json.dumps(payload).encode("utf-8"))`,
 * i.e. Python's default ASCII-escaped, space-separated serialization — not
 * the compact wire bytes. */
export function payloadBytes(payload: SpecialistPayload): number {
  return pyDumpsAscii(payload).length;
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
