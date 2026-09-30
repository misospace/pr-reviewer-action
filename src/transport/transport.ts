import type { ApiFormat, NormalizedModelResponse, OpenAiWireBody, TokensParam, TransportWirePayload } from "../model/types.js";
import { reassembleSse } from "./sse.js";
import { runHttpRequest, TransportFailure } from "./http.js";

/**
 * The transport seam between request building and the wire (#677): serializes
 * the wire payload, performs the HTTP call, and — for streamed calls —
 * reassembles SSE into the normalized response shape. Errors stay typed all
 * the way up so routing/fallback logic can branch on `kind`.
 */

export interface ChatRequestInput {
  baseUrl: string;
  apiFormat: ApiFormat;
  payload: TransportWirePayload;
  apiKey: string;
  anthropicVersion: string;
  requestTimeoutSec: number;
  connectTimeoutSec: number;
  /** Response-byte ceiling; defaults to DEFAULT_MAX_RESPONSE_BYTES (#745). */
  maxResponseBytes?: number;
  /** Backoff sleep, injectable for tests; defaults to a setTimeout wait. */
  sleep?: (ms: number) => Promise<void>;
}

export type ChatRequestOutcome =
  | { status: "ok"; response: NormalizedModelResponse; raw: unknown }
  | { status: "failure"; failure: TransportFailure };

/**
 * Transient upstream statuses worth another try (port of the v2 transport's
 * RETRYABLE_HTTP_STATUSES): 429 and 503 are what a rate-limited or
 * cooling-down gateway returns, the rest are gateway hiccups. Anything else
 * 4xx/5xx is final. `Retry-After` is honoured when present, otherwise the
 * backoff is 1s then 2s, both capped at HTTP_RETRY_MAX_DELAY_SEC.
 */
export const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
export const HTTP_RETRY_ATTEMPTS = 3;
export const HTTP_RETRY_MAX_DELAY_SEC = 30;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runChatRequest(input: ChatRequestInput): Promise<ChatRequestOutcome> {
  return runChatRequestLoop(input, true);
}

/** The request loop with the 429/5xx backoff (#677) plus the #824 max_tokens
 * clamp: some providers or models reject a `max_tokens` above their output
 * cap with an HTTP 400 instead of truncating, which would fail the review
 * for a drop-in user. When a 400 body states a cap below the value the
 * payload actually sent, the same request is retried once with the token
 * field set to that stated cap. The clamp sits before the 429/5xx decision
 * and does not consume its attempts: a 400 is never in
 * RETRYABLE_HTTP_STATUSES, and the clamped request re-enters this loop with
 * the ordinary retry behavior. `clampRemaining` makes the retry strictly
 * once-per-request — a clamped request that fails again returns its failure
 * unchanged, never a third attempt. */
async function runChatRequestLoop(input: ChatRequestInput, clampRemaining: boolean): Promise<ChatRequestOutcome> {
  const sleep = input.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    const outcome = await runChatRequestOnce(input);
    if (outcome.status === "failure") {
      const clamp = clampRemaining
        ? tokenClampRetry(input, outcome.failure)
        : null;
      if (clamp !== null) {
        process.stderr.write(`clamped ${clamp.field} ${clamp.from} -> ${clamp.to} (${clamp.reason})\n`);
        return runChatRequestLoop(clamp.input, false);
      }
      if (
        outcome.failure.kind === "http_status"
        && outcome.failure.status !== undefined
        && RETRYABLE_HTTP_STATUSES.has(outcome.failure.status)
        && attempt < HTTP_RETRY_ATTEMPTS
      ) {
        const delaySec = outcome.failure.retryAfterSec ?? 2 ** (attempt - 1);
        await sleep(Math.max(0, Math.min(delaySec, HTTP_RETRY_MAX_DELAY_SEC)) * 1000);
        continue;
      }
    }
    return outcome;
  }
}

// ── max_tokens clamp on HTTP 400 (#824) ─────────────────────────────────────
// Parse only an explicitly stated cap from the error body; anything
// unparseable or non-token-related returns null and the original failure
// stands. The request numbers echoed inside the bodies are never trusted:
// the retry decision compares the stated cap against the value this payload
// actually sent, and a clamp only ever lowers it.

/** One explicitly stated provider cap parsed from a 400 body. */
export interface StatedTokenCap {
  cap: number;
  reason: "provider limit" | "context window";
}

// `<field>: <sent> > <cap>, which is the maximum allowed number of output
// tokens ...` — the comparison form itself states the cap.
const COMPARISON_CAP = /\bmax_(?:completion_)?tokens:\s*\d+\s*>\s*(\d+)\b/;
// `<field> is too large: <sent>. This model supports at most <cap> completion
// tokens ...` — both halves are required, and the cap number is bound to the
// completion-tokens unit it must name, so an unrelated "supports at most <N>
// tools" figure in the same sentence is never taken as the output cap.
const TOO_LARGE_SENT = /\bmax_(?:completion_)?tokens is too large:\s*\d+\b/;
const SUPPORTS_AT_MOST = /\bsupports at most (\d+) completion tokens\b/i;
// `maximum context length is <window> tokens ... request has <input> input
// tokens` — clamps to window - input, only when both numbers are present.
const CONTEXT_WINDOW = /\bmaximum context length is (\d+) tokens\b/i;
const CONTEXT_INPUT = /\brequest has (\d+) input tokens\b/i;

/** The human-readable message of a 400 body: `error.message` when the body
 * is a JSON error object, otherwise the raw body text. */
function errorMessageText(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const error = (parsed as Record<string, unknown>).error;
      if (typeof error === "object" && error !== null && !Array.isArray(error)) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") return message;
      }
    }
  } catch {
    // Plain-text body: matched as-is below.
  }
  return body;
}

/** Parse the token cap a 400 body explicitly states, if any. */
export function parseStatedTokenCap(body: string | undefined): StatedTokenCap | null {
  if (body === undefined || body === "") return null;
  const message = errorMessageText(body);
  const comparison = COMPARISON_CAP.exec(message);
  if (comparison?.[1] !== undefined) {
    return { cap: Number(comparison[1]), reason: "provider limit" };
  }
  if (TOO_LARGE_SENT.test(message)) {
    const atMost = SUPPORTS_AT_MOST.exec(message);
    if (atMost?.[1] !== undefined) {
      return { cap: Number(atMost[1]), reason: "provider limit" };
    }
  }
  const window = CONTEXT_WINDOW.exec(message);
  const inputTokens = CONTEXT_INPUT.exec(message);
  if (window?.[1] !== undefined && inputTokens?.[1] !== undefined) {
    const remaining = Number(window[1]) - Number(inputTokens[1]);
    if (remaining >= 1) return { cap: remaining, reason: "context window" };
  }
  return null;
}

/** The token-limit field this wire payload carries (`max_tokens`, or
 * `max_completion_tokens` per AI_TOKENS_PARAM) and the value it would send. */
function tokenFieldAndValue(body: TransportWirePayload["body"]): { field: TokensParam; value: number } | null {
  const openAi = body as OpenAiWireBody;
  if (typeof openAi.max_completion_tokens === "number") {
    return { field: "max_completion_tokens", value: openAi.max_completion_tokens };
  }
  if (typeof body.max_tokens === "number") {
    return { field: "max_tokens", value: body.max_tokens };
  }
  return null;
}

interface TokenClampRetry {
  input: ChatRequestInput;
  field: TokensParam;
  from: number;
  to: number;
  reason: StatedTokenCap["reason"];
}

/** A one-shot same-request retry input at the stated cap, or null when the
 * failure is not a clampable token-cap 400 (unparseable body, unrelated
 * 400, no token field to lower, or a stated cap that is not below the sent
 * value — a clamp never raises). */
function tokenClampRetry(input: ChatRequestInput, failure: TransportFailure): TokenClampRetry | null {
  if (failure.kind !== "http_status" || failure.status !== 400) return null;
  const field = tokenFieldAndValue(input.payload.body);
  if (field === null) return null;
  const stated = parseStatedTokenCap(failure.body);
  if (stated === null || !Number.isSafeInteger(stated.cap) || stated.cap < 1 || stated.cap >= field.value) {
    return null;
  }
  const body = { ...input.payload.body };
  if (field.field === "max_completion_tokens") (body as OpenAiWireBody).max_completion_tokens = stated.cap;
  else body.max_tokens = stated.cap;
  return {
    input: { ...input, payload: { ...input.payload, body } },
    field: field.field,
    from: field.value,
    to: stated.cap,
    reason: stated.reason,
  };
}

async function runChatRequestOnce(input: ChatRequestInput): Promise<ChatRequestOutcome> {
  const streaming = input.payload.body.stream === true;
  try {
    const result = await runHttpRequest({
      baseUrl: input.baseUrl,
      apiFormat: input.apiFormat,
      bodyText: JSON.stringify(input.payload.body),
      apiKey: input.apiKey,
      anthropicVersion: input.anthropicVersion,
      requestTimeoutSec: input.requestTimeoutSec,
      connectTimeoutSec: input.connectTimeoutSec,
      stream: streaming,
      ...(input.maxResponseBytes !== undefined ? { maxResponseBytes: input.maxResponseBytes } : {}),
    });
    if (!streaming) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.body);
      } catch {
        return {
          status: "failure",
          failure: new TransportFailure("network", "model endpoint returned a non-JSON body"),
        };
      }
      return { status: "ok", response: normalizeNonStreamedResponse(parsed), raw: parsed };
    }
    const response = reassembleSse(result.body, input.apiFormat);
    return { status: "ok", response, raw: response };
  } catch (error) {
    if (error instanceof TransportFailure) return { status: "failure", failure: error };
    throw error;
  }
}

function contentBlocksText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const block = item as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("");
}

/**
 * Normalize a non-streamed provider body into the shared response shape.
 * Verdict parsing operates on the raw body (`raw`), which keeps its
 * protocol-native shape exactly like v2; this projection only feeds
 * consumers that want one provider-neutral shape.
 */
export function normalizeNonStreamedResponse(parsed: unknown): NormalizedModelResponse {
  const record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const usageRecord = typeof record.usage === "object" && record.usage !== null ? record.usage as Record<string, unknown> : null;
  const promptTokens = typeof usageRecord?.prompt_tokens === "number"
    ? usageRecord.prompt_tokens
    : typeof usageRecord?.input_tokens === "number" ? usageRecord.input_tokens : 0;
  const completionTokens = typeof usageRecord?.completion_tokens === "number"
    ? usageRecord.completion_tokens
    : typeof usageRecord?.output_tokens === "number" ? usageRecord.output_tokens : 0;

  let content = "";
  let toolCalls: NormalizedModelResponse["toolCalls"] = [];
  let finishReason: string;
  if (Array.isArray(record.choices)) {
    const first = typeof record.choices[0] === "object" && record.choices[0] !== null
      ? record.choices[0] as Record<string, unknown>
      : {};
    const message = typeof first.message === "object" && first.message !== null ? first.message as Record<string, unknown> : {};
    content = typeof message.content === "string" ? message.content : "";
    const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    toolCalls = rawToolCalls.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const tool = item as Record<string, unknown>;
      const fn = typeof tool.function === "object" && tool.function !== null ? tool.function as Record<string, unknown> : {};
      const id = typeof tool.id === "string" ? tool.id : "";
      const name = typeof fn.name === "string" ? fn.name : "";
      const args = typeof fn.arguments === "string" ? fn.arguments : "{}";
      if (id === "" || name === "") return [];
      return [{ id, type: "function" as const, function: { name, arguments: args } }];
    });
    finishReason = typeof first.finish_reason === "string" ? first.finish_reason : "stop";
  } else {
    content = contentBlocksText(record.content);
    finishReason = typeof record.stop_reason === "string" ? record.stop_reason : "stop";
  }
  return {
    id: typeof record.id === "string" ? record.id : "",
    object: "chat.completion",
    model: typeof record.model === "string" ? record.model : "",
    content,
    toolCalls,
    finishReason,
    usage: usageRecord ? { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } : null,
    error: record.error ?? undefined,
  };
}
