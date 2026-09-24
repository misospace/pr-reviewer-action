import type { ApiFormat, NormalizedModelResponse, TransportWirePayload } from "../model/types.js";
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
}

export type ChatRequestOutcome =
  | { status: "ok"; response: NormalizedModelResponse; raw: unknown }
  | { status: "failure"; failure: TransportFailure };

export async function runChatRequest(input: ChatRequestInput): Promise<ChatRequestOutcome> {
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
  let finishReason = "stop";
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
