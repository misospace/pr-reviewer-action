import type { NormalizedModelResponse, NormalizedToolCall } from "../model/types.js";

/**
 * Port of pr_reviewer/sse_reassembler.py: reassembles a streamed SSE
 * response into the normalized OpenAI-style completion shape both provider
 * families converge on in v2. Only `data:` lines are considered; `event:`
 * lines are never parsed — Anthropic dispatch is purely on the JSON `type`
 * field. Malformed JSON payloads are skipped silently.
 */

interface ToolState {
  id: string;
  name: string;
  argsParts: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function flushTool(state: { id: string; name: string; argsParts: string[] } | null): NormalizedToolCall | null {
  if (!state) return null;
  const call = state.id !== "" && state.name !== ""
    ? {
      id: state.id,
      type: "function" as const,
      function: { name: state.name, arguments: state.argsParts.join("") || "{}" },
    }
    : null;
  return call;
}

function baseResponse(id: string, model: string, content: string, toolCalls: NormalizedToolCall[], finishReason: string, usage: NormalizedModelResponse["usage"], error: unknown): NormalizedModelResponse {
  const response: NormalizedModelResponse = {
    id,
    object: "chat.completion",
    model,
    content,
    toolCalls,
    finishReason,
    usage,
    error,
  };
  return response;
}

function reassembleOpenai(text: string): NormalizedModelResponse {
  const contentParts: string[] = [];
  const tools = new Map<number, ToolState>();
  const toolCalls: NormalizedToolCall[] = [];
  let finishReason = "";
  let id = "";
  let model = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let error: unknown;

  const flushAll = (): void => {
    for (const index of [...tools.keys()].sort((a, b) => a - b)) {
      const call = flushTool(tools.get(index) ?? null);
      if (call) toolCalls.push(call);
      tools.delete(index);
    }
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isRecord(chunk)) continue;
    if (chunk.error) {
      error = chunk.error;
      continue;
    }
    if (typeof chunk.id === "string" && chunk.id !== "") id = chunk.id;
    if (typeof chunk.model === "string") model = chunk.model;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      const content = asString(delta.content);
      if (content !== null) contentParts.push(content);
      const rawToolCalls = delta.tool_calls;
      const toolCallItems: unknown[] = Array.isArray(rawToolCalls)
        ? rawToolCalls
        : isRecord(rawToolCalls) ? [rawToolCalls] : [];
      for (const item of toolCallItems) {
        if (!isRecord(item)) continue;
        const index = typeof item.index === "number" ? item.index : 0;
        const state = tools.get(index) ?? { id: "", name: "", argsParts: [] };
        const tcId = asString(item.id);
        if (tcId) state.id = tcId;
        const fn = isRecord(item.function) ? item.function : {};
        const name = asString(fn.name);
        if (name) state.name = name;
        const args = asString(fn.arguments);
        if (args !== null) state.argsParts.push(args);
        tools.set(index, state);
      }
      const reason = asString(choice.finish_reason);
      if (reason) {
        finishReason = reason;
        if (reason === "tool_calls") flushAll();
      }
    }
    if (isRecord(chunk.usage)) {
      const prompt = chunk.usage.prompt_tokens;
      const completion = chunk.usage.completion_tokens;
      if (typeof prompt === "number") promptTokens += prompt;
      if (typeof completion === "number") completionTokens += completion;
    }
  }
  flushAll();

  // Both v2 reassemblers always emit a usage object (zeros when the stream
  // carried none) — the parser's empty-completion detection reads
  // usage.completion_tokens == 0, so an absent usage must not read as null.
  const usage = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  return baseResponse(id, model, contentParts.join(""), toolCalls, finishReason || "stop", usage, error);
}

interface AnthropicToolBlock {
  id: string;
  name: string;
  argsParts: string[];
  index: number | null;
}

function reassembleAnthropic(text: string): NormalizedModelResponse {
  const contentParts: string[] = [];
  const toolCalls: NormalizedToolCall[] = [];
  let id = "";
  let model = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let stopReason = "";
  let error: unknown;
  let openBlock: AnthropicToolBlock | null = null;

  const flushOpen = (): void => {
    const call = flushTool(openBlock);
    if (call) toolCalls.push(call);
    openBlock = null;
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === "error") {
      error = isRecord(event.error) ? event.error : event;
      continue;
    }
    if (event.type === "message_start") {
      const message = isRecord(event.message) ? event.message : {};
      id = asString(message.id) ?? id;
      model = asString(message.model) ?? model;
      const usage = isRecord(message.usage) ? message.usage : {};
      if (typeof usage.input_tokens === "number") promptTokens += usage.input_tokens;
      if (typeof usage.output_tokens === "number") completionTokens += usage.output_tokens;
      continue;
    }
    if (event.type === "content_block_start") {
      const block = isRecord(event.content_block) ? event.content_block : {};
      if (block.type === "tool_use") {
        // A still-open previous tool block is flushed first: a proxy that
        // omits `index` must not strand the open block.
        flushOpen();
        openBlock = {
          id: asString(block.id) ?? "",
          name: asString(block.name) ?? "",
          argsParts: [],
          index: typeof event.index === "number" ? event.index : null,
        };
      }
      continue;
    }
    if (event.type === "content_block_delta") {
      const delta = isRecord(event.delta) ? event.delta : {};
      if (delta.type === "text_delta" || delta.type === "text") {
        const piece = asString(delta.text);
        if (piece !== null) contentParts.push(piece);
      } else if (delta.type === "input_json_delta" || delta.type === "input_json") {
        const raw = delta.partial_json ?? delta.input ?? "";
        if (typeof raw === "string") openBlock?.argsParts.push(raw);
        else if (isRecord(raw)) openBlock?.argsParts.push(JSON.stringify(raw));
      }
      continue;
    }
    if (event.type === "content_block_stop") {
      if (openBlock && (openBlock.index === null || event.index === openBlock.index)) flushOpen();
      continue;
    }
    if (event.type === "message_delta") {
      const delta = isRecord(event.delta) ? event.delta : {};
      const reason = asString(delta.stop_reason);
      if (reason) stopReason = reason;
      const usage = isRecord(event.usage) ? event.usage : {};
      if (typeof usage.output_tokens === "number") completionTokens += usage.output_tokens;
      continue;
    }
    if (event.type === "message_stop") {
      flushOpen();
    }
  }
  flushOpen();

  let finishReason = stopReason || "stop";
  if (toolCalls.length > 0 && finishReason === "tool_use") finishReason = "tool_calls";
  const usage = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  return baseResponse(id, model, contentParts.join(""), toolCalls, finishReason, usage, error);
}

/**
 * Plain-JSON error fallback: providers and local servers (llama.cpp, vLLM,
 * ollama, proxies) sometimes answer HTTP 200 with a JSON error body instead
 * of SSE. Without this the stream would look like a blank completion and
 * burn the retry budget.
 */
function adoptPlainErrorBody(text: string, response: NormalizedModelResponse): NormalizedModelResponse {
  if (response.content !== "" || response.toolCalls.length > 0 || response.error) return response;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && parsed.error) {
      return { ...response, error: parsed.error };
    }
  } catch {
    // not a JSON body; nothing to adopt
  }
  return response;
}

export function reassembleSse(text: string, apiFormat: string): NormalizedModelResponse {
  const response = apiFormat === "anthropic" ? reassembleAnthropic(text) : reassembleOpenai(text);
  return adoptPlainErrorBody(text, response);
}
