/**
 * #1047: bounded, non-sensitive diagnostics for a model response that could
 * not be turned into a usable verdict. The record answers "what shape was
 * the failure?" — zero output, reasoning-only, token-cap truncation,
 * malformed JSON, SSE framing loss, or a transport-side HTTP/timeout error —
 * using ONLY counts, reasons, and token figures. Content, reasoning text,
 * and credentials are never captured: every field is a number or one of this
 * module's own enum strings (or a redacted provider stop-reason token), so
 * the record is safe for logs, step summaries, and run artifacts by
 * construction.
 *
 * Two response shapes reach `describeUnusableResponse`:
 * - a protocol-native body (non-streamed OpenAI/Anthropic JSON), counted
 *   directly from its `choices`/`content` blocks; and
 * - the streamed reassembler's normalized shape, whose `blockCounts` the
 *   reassembler fills in (#1047) because the raw SSE bytes are gone by then.
 */

import { maskKnownSecrets, redactText } from "../context/redact.js";

/** The failure-shape classes an unusable response is sorted into. */
export type UnusableResponseClass =
  | "zero-output"
  | "reasoning-only"
  | "truncated"
  | "malformed-json"
  | "sse-framing-loss"
  | "http-error"
  | "timeout"
  | "transport-error"
  | "endpoint-error";

/** Finish/stop reasons that mean the generation was cut at a token cap. */
const TRUNCATION_REASONS: ReadonlySet<string> = new Set(["length", "max_tokens", "max_output_tokens"]);

/** Transport failure kinds (`TransportFailure["kind"]`). */
const TRANSPORT_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "connect_timeout", "request_timeout", "network", "http_status", "response_too_large",
]);

const MAX_FINISHED_REASON_CHARS = 64;
const MAX_PROFILE_CHARS = 64;

export interface ResponseDiagnostics {
  /** The failure-shape class. */
  class: UnusableResponseClass;
  /** Bounded, content-free record (snake_case, matching run-artifact style). */
  record: Record<string, unknown>;
}

export interface ResponseDiagnosticsInput {
  /** The raw response body (protocol-native or normalized), or null when the
   * call never produced one (transport failure). */
  response: unknown;
  /** The wire family the call used ("openai" | "anthropic"). */
  apiFormat: string;
  /** The calling model profile's label (e.g. "Primary") — diagnostics name
   * the profile so a multi-lane run shows which lane failed how. */
  profile: string;
  /** Whether the attempt was streamed. */
  streamed: boolean;
  /** HTTP status when the failure carried one. */
  httpStatus?: number;
  /** The failure kind in scope: a `TransportFailure` kind on the transport
   * side, or a `VerdictParseFailure` kind when the body was rejected. */
  failureKind?: string;
  /** The operator-configured model API key(s) for this call, masked out of
   * the one provider-controlled free-text field (`finish_reason`) before it
   * can reach a log line — a broken endpoint echoing the key into a stop
   * reason must not survive the record. */
  secrets?: readonly (string | null | undefined)[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Provider-controlled stop/finish reason as a bounded, control-free,
 * credential-redacted token — the value lands in logs and summaries, so
 * hostile bytes must not be able to forge lines there, and a key-shaped
 * token a broken endpoint echoes into a stop reason must not survive it
 * (same `redactText` pass every other provider-controlled string gets). */
function safeReasonToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = redactText(value.replace(/[\u0000-\u0020\u007f]+/g, " ").trim()).slice(0, MAX_FINISHED_REASON_CHARS);
  return cleaned === "" ? undefined : cleaned;
}

/** The normalized (reassembled) shape: camelCase `finishReason` is the
 * discriminator — protocol bodies use finish_reason/stop_reason. */
function isNormalizedResponse(value: Record<string, unknown>): boolean {
  return typeof value.finishReason === "string" && Array.isArray(value.toolCalls);
}

interface BlockShape {
  finishReason: string | undefined;
  textBlocks: number;
  textChars: number;
  thinkingBlocks: number;
  toolBlocks: number;
  completionTokens: number | undefined;
  promptTokens: number | undefined;
}

function intOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function blockShapeOf(response: Record<string, unknown>): BlockShape {
  if (isNormalizedResponse(response)) {
    const blocks = isRecord(response.blockCounts) ? response.blockCounts : null;
    const usage = isRecord(response.usage) ? response.usage : null;
    const content = typeof response.content === "string" ? response.content : "";
    return {
      finishReason: safeReasonToken(response.finishReason),
      textBlocks: intOrUndefined(blocks?.text) ?? (content === "" ? 0 : 1),
      textChars: content.length,
      thinkingBlocks: intOrUndefined(blocks?.thinking) ?? 0,
      toolBlocks: intOrUndefined(blocks?.toolUse) ?? (Array.isArray(response.toolCalls) ? response.toolCalls.length : 0),
      completionTokens: intOrUndefined(usage?.completionTokens),
      promptTokens: intOrUndefined(usage?.promptTokens),
    };
  }

  // Protocol-native OpenAI body: choices[0].message.
  const choices = response.choices;
  if (Array.isArray(choices) && choices.length > 0 && isRecord(choices[0])) {
    const first = choices[0];
    const message = isRecord(first.message) ? first.message : {};
    const content = typeof message.content === "string" ? message.content : "";
    // DeepSeek-style and proxy-translated reasoning rides message.reasoning_content
    // (or .reasoning); presence is the signal, the text is never kept.
    const hasReasoning = (typeof message.reasoning_content === "string" && message.reasoning_content !== "")
      || (typeof message.reasoning === "string" && message.reasoning !== "");
    const usage = isRecord(response.usage) ? response.usage : null;
    return {
      finishReason: safeReasonToken(first.finish_reason),
      textBlocks: content === "" ? 0 : 1,
      textChars: content.length,
      thinkingBlocks: hasReasoning ? 1 : 0,
      toolBlocks: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
      completionTokens: intOrUndefined(usage?.completion_tokens) ?? intOrUndefined(usage?.output_tokens),
      promptTokens: intOrUndefined(usage?.prompt_tokens) ?? intOrUndefined(usage?.input_tokens),
    };
  }

  // Protocol-native Anthropic body: the content block array.
  const content = response.content;
  if (Array.isArray(content)) {
    let textBlocks = 0;
    let textChars = 0;
    let thinkingBlocks = 0;
    let toolBlocks = 0;
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === "text" && typeof item.text === "string") {
        textBlocks++;
        textChars += item.text.length;
      } else if (item.type === "thinking" || item.type === "redacted_thinking") {
        thinkingBlocks++;
      } else if (item.type === "tool_use") {
        toolBlocks++;
      }
    }
    const usage = isRecord(response.usage) ? response.usage : null;
    return {
      finishReason: safeReasonToken(response.stop_reason),
      textBlocks,
      textChars,
      thinkingBlocks,
      toolBlocks,
      completionTokens: intOrUndefined(usage?.output_tokens) ?? intOrUndefined(usage?.completion_tokens),
      promptTokens: intOrUndefined(usage?.input_tokens) ?? intOrUndefined(usage?.prompt_tokens),
    };
  }

  return {
    finishReason: undefined,
    textBlocks: 0,
    textChars: typeof content === "string" ? content.length : 0,
    thinkingBlocks: 0,
    toolBlocks: 0,
    completionTokens: undefined,
    promptTokens: undefined,
  };
}

/**
 * Classify one unusable response and build its bounded diagnostic record.
 * Total: every failure shape — including a missing body — produces a record,
 * so callers need no null handling (CodeQL js/comparison-between-incompatible
 * types flagged the old nullable signature's dead null checks).
 */
export function describeUnusableResponse(input: ResponseDiagnosticsInput): ResponseDiagnostics {
  const record: Record<string, unknown> = {
    response_class: "",
    profile: input.profile.replace(/[\u0000-\u0020\u007f]+/g, " ").trim().slice(0, MAX_PROFILE_CHARS),
    api_format: input.apiFormat === "anthropic" ? "anthropic" : input.apiFormat === "openai" ? "openai" : "unknown",
    streamed: input.streamed === true,
  };
  const secrets = input.secrets ?? [];
  if (input.httpStatus !== undefined) record.http_status = input.httpStatus;
  if (input.failureKind !== undefined && input.failureKind !== "") record.failure_kind = input.failureKind;

  const transportFailure = TRANSPORT_FAILURE_KINDS.has(String(input.failureKind ?? ""));
  const response = isRecord(input.response) ? input.response : null;

  let responseClass: UnusableResponseClass;
  if (!transportFailure && response !== null && response.error !== undefined && response.error !== null) {
    // A 200 reply carrying an error object (in-body error / mid-stream SSE
    // failure adopted by the reassembler).
    responseClass = "endpoint-error";
  } else if (transportFailure || response === null) {
    if (input.failureKind === "connect_timeout" || input.failureKind === "request_timeout") {
      responseClass = "timeout";
    } else if (input.httpStatus !== undefined) {
      responseClass = "http-error";
    } else {
      responseClass = "transport-error";
    }
  } else {
    const shape = blockShapeOf(response);
    if (shape.finishReason !== undefined && TRUNCATION_REASONS.has(shape.finishReason)) {
      responseClass = "truncated";
    } else if (shape.textChars > 0) {
      responseClass = "malformed-json";
    } else if (shape.thinkingBlocks > 0 || shape.toolBlocks > 0) {
      responseClass = "reasoning-only";
    } else if ((shape.completionTokens ?? 0) > 0 && input.streamed) {
      // Tokens were billed but no text block arrived on a stream whose usage
      // did — the SSE text frames were lost, the accounting frames were not.
      responseClass = "sse-framing-loss";
    } else if ((shape.completionTokens ?? 0) > 0) {
      responseClass = "reasoning-only";
    } else {
      responseClass = "zero-output";
    }
    if (shape.finishReason !== undefined) record.finish_reason = maskKnownSecrets(shape.finishReason, secrets);
    record.text_blocks = shape.textBlocks;
    record.text_chars = shape.textChars;
    record.thinking_blocks = shape.thinkingBlocks;
    record.tool_blocks = shape.toolBlocks;
    if (shape.completionTokens !== undefined) record.completion_tokens = shape.completionTokens;
    if (shape.promptTokens !== undefined) record.prompt_tokens = shape.promptTokens;
  }

  record.response_class = responseClass;
  return { class: responseClass, record };
}

/**
 * One bounded log line for a diagnostics record — `class=… profile=… …` with
 * only the fields the record carries. Every value is a number or one of this
 * module's own tokens, so the line cannot carry response content.
 */
export function formatResponseDiagnosticsLine(record: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of [
    "response_class", "profile", "api_format", "streamed", "http_status", "failure_kind",
    "finish_reason", "text_blocks", "text_chars", "thinking_blocks", "tool_blocks",
    "completion_tokens", "prompt_tokens", "completion_budget_raised_to",
  ]) {
    const value = record[key];
    if (value === undefined || value === "") continue;
    parts.push(`${key}=${typeof value === "string" ? value : String(value)}`);
  }
  return parts.join(" ");
}

/**
 * #1047: the evidence gate for the bounded completion-budget raise. Raising
 * the token cap can only recover a verdict the cap itself destroyed — a
 * token-cap truncation, or a response whose entire budget was spent on
 * invisible reasoning before any text was written. Every other class (dead
 * endpoint, framing loss, malformed-but-present JSON, true zero output) is
 * not helped by more tokens and must not pay for them.
 */
export function shouldRaiseCompletionBudget(responseClass: UnusableResponseClass): boolean {
  return responseClass === "truncated" || responseClass === "reasoning-only";
}
