import { maskKnownSecrets, redactText } from "../context/redact.js";
import type { ApiFormat, NormalizedModelResponse, TransportWirePayload } from "../model/types.js";
import type { SpecialistRequestFn, SpecialistTransportOutcome } from "../specialists/runner.js";
import { describeTransportFailure } from "../transport/http.js";
import { runChatRequest, type ChatRequestInput, type ChatRequestOutcome } from "../transport/transport.js";

/**
 * Specialist transport adapter (#706 PR 6): `SpecialistRequestFn` over the v3
 * model transport (`runChatRequest`), standing in for v2's
 * `pr_reviewer.transport.run_chat_request` as `scripts/run_specialists.py`
 * uses it.
 *
 * - Streamed turns come back from `reassembleSse` in the flattened v3 shape;
 *   they are re-emitted in the v2 reassembler's OpenAI-style completion
 *   shape so `specialist-<role>.response.json` keeps its v2 bytes.
 * - Failures carry v2's message text (`planner model request failed with
 *   HTTP <status>: <redacted body>`), redacted and capped at 500 characters
 *   like the runner's `str(redact_text(str(exc)))[:500]`; a connect/request
 *   timeout, or any message containing "timed out", is a timeout (never
 *   retried by the runner).
 * - The API key only ever reaches the transport's request headers; it is
 *   never part of a payload, an outcome, or a message.
 */

export interface SpecialistTransportConfig {
  baseUrl: string;
  apiKey: string;
  anthropicVersion: string;
  /** Test seam: replaces the HTTP transport. */
  runChat?: (input: ChatRequestInput) => Promise<ChatRequestOutcome>;
  sleep?: (ms: number) => Promise<void>;
}

function codePointSlice(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

/** The v2 SSE reassembler's result shape for a streamed turn. */
export function toV2Completion(response: NormalizedModelResponse): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: response.content };
  if (response.toolCalls.length > 0) message.tool_calls = response.toolCalls;
  const usage = response.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const result: Record<string, unknown> = {
    id: response.id,
    object: "chat.completion",
    model: response.model,
    choices: [{ index: 0, message, finish_reason: response.finishReason }],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
    },
  };
  if (response.error !== undefined && response.error !== null) result.error = response.error;
  return result;
}

function failureMessage(outcome: Extract<ChatRequestOutcome, { status: "failure" }>, apiKey: string): { message: string; timeout: boolean; status?: number; statusDetail?: string } {
  const failure = outcome.failure;
  if (failure.kind === "connect_timeout" || failure.kind === "request_timeout") {
    return { message: "planner model request timed out", timeout: true };
  }
  if (failure.kind === "http_status" && failure.status !== undefined) {
    // #846: `statusDetail` is the clean "HTTP <status>: <excerpt>[ — hint]"
    // form, carried separately for log lines/telemetry; `message` keeps the
    // v2-parity "planner model request failed with ..." phrasing used in
    // the persisted artifact errors. `secrets` masks the specialist call's
    // configured key unconditionally, on top of `redactText`'s heuristics —
    // a provider echoing the bare key in prose would otherwise pass every
    // heuristic pattern untouched.
    const statusDetail = describeTransportFailure(failure, { maxBodyChars: 300, secrets: [apiKey] });
    return { message: `planner model request failed with ${statusDetail}`, timeout: false, status: failure.status, statusDetail };
  }
  return { message: failure.message, timeout: false };
}

export function specialistRequestFn(config: SpecialistTransportConfig): SpecialistRequestFn {
  const runChat = config.runChat ?? runChatRequest;
  return async (payload, apiFormat, timeoutSec): Promise<SpecialistTransportOutcome> => {
    const format: ApiFormat = apiFormat === "anthropic" ? "anthropic" : "openai";
    const wire = {
      endpointPath: format === "anthropic" ? "/messages" : "/chat/completions",
      body: payload,
    } as unknown as TransportWirePayload;
    let outcome: ChatRequestOutcome;
    try {
      outcome = await runChat({
        baseUrl: config.baseUrl,
        apiFormat: format,
        payload: wire,
        apiKey: config.apiKey,
        anthropicVersion: config.anthropicVersion,
        requestTimeoutSec: timeoutSec,
        // curl --max-time bounds the whole attempt in v2, connect included.
        connectTimeoutSec: timeoutSec,
        ...(config.sleep !== undefined ? { sleep: config.sleep } : {}),
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const masked = codePointSlice(redactText(maskKnownSecrets(rawMessage, [config.apiKey])), 500);
      return { ok: false, errorMessage: masked, timeout: masked.toLowerCase().includes("timed out") };
    }
    if (outcome.status === "ok") {
      const raw = payload.stream === true ? toV2Completion(outcome.response) : outcome.raw;
      return { ok: true, raw };
    }
    const { message, timeout, status, statusDetail } = failureMessage(outcome, config.apiKey);
    const masked = codePointSlice(redactText(maskKnownSecrets(message, [config.apiKey])), 500);
    return {
      ok: false,
      errorMessage: masked,
      timeout: timeout || masked.toLowerCase().includes("timed out"),
      ...(status !== undefined ? { status } : {}),
      ...(statusDetail !== undefined ? { statusDetail } : {}),
    };
  };
}
