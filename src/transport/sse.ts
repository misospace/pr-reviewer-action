import type { NormalizedModelResponse, NormalizedToolCall, NormalizedUsage } from "../model/types.js";

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

/** #1047: block counters are capped so a hostile or runaway stream cannot
 * grow them unboundedly — they are diagnostics, not accounting. Only counts,
 * never content. */
const MAX_BLOCK_COUNT = 9999;

function bumpCount(count: number): number {
  return count < MAX_BLOCK_COUNT ? count + 1 : count;
}

/** #1047: attach block counts to a reassembled response only when a thinking
 * block arrived — the one signal the joined `content` string cannot show and
 * the classifier needs (a reasoning-only stream otherwise looks identical to
 * a zero-output one). Thinking-free responses keep their exact v2 shape. */
function withBlockCounts(
  response: NormalizedModelResponse,
  thinkingBlocks: number,
  textBlocks: number,
  toolBlocks: number,
): NormalizedModelResponse {
  if (thinkingBlocks <= 0) return response;
  return { ...response, blockCounts: { text: textBlocks, thinking: thinkingBlocks, toolUse: toolBlocks } };
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

/** #910: the OpenAI path attaches the cache counts only when they are
 * greater than zero, so a cache-less response keeps the exact v2 usage
 * shape. */
function withCache(usage: NormalizedUsage, cacheReadTokens: number, cacheWriteTokens: number): NormalizedUsage {
  return {
    ...usage,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
  };
}

/** #1466: the Anthropic path attaches a cache counter the provider
 * REPORTED even when its value is zero — a reported zero is a measurement
 * ("nothing was cached"), so the streamed turn must publish the same value
 * the identical non-streamed body publishes. A counter the provider never
 * reported stays absent (`null` here), exactly as before. */
function withReportedCache(usage: NormalizedUsage, cacheReadTokens: number | null, cacheWriteTokens: number | null): NormalizedUsage {
  return {
    ...usage,
    ...(cacheReadTokens !== null ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== null ? { cacheWriteTokens } : {}),
  };
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

function reassembleOpenai(text: string, quality: SseReassemblyQuality): NormalizedModelResponse {
  const contentParts: string[] = [];
  const tools = new Map<number, ToolState>();
  const toolCalls: NormalizedToolCall[] = [];
  let finishReason = "";
  let id = "";
  let model = "";
  let promptTokens = 0;
  let cacheReadTokens = 0;
  let completionTokens = 0;
  let error: unknown;
  // #1047: counts only — reasoning segments (DeepSeek-style
  // reasoning_content / reasoning deltas, which proxy-translated thinking
  // also arrives as), text deltas, and flushed tool calls.
  let textDeltas = 0;
  let reasoningSegments = 0;

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
    if (payload === "[DONE]") {
      // #1628: the stream's own termination frame.
      quality.sawTermination = true;
      continue;
    }
    if (payload === "") continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      // #1628: the frame that did not parse — a count, never its text.
      quality.malformedFrames = bumpCount(quality.malformedFrames);
      continue;
    }
    quality.dataFrames = bumpCount(quality.dataFrames);
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
      if (content !== null) {
        contentParts.push(content);
        textDeltas = bumpCount(textDeltas);
      }
      if (asString(delta.reasoning_content) !== null || asString(delta.reasoning) !== null) {
        reasoningSegments = bumpCount(reasoningSegments);
      }
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
        // #1628: a finish reason terminates the turn even without `[DONE]`.
        quality.sawTermination = true;
        if (reason === "tool_calls") flushAll();
      }
    }
    if (isRecord(chunk.usage)) {
      const prompt = chunk.usage.prompt_tokens;
      const completion = chunk.usage.completion_tokens;
      if (typeof prompt === "number") promptTokens += prompt;
      if (typeof completion === "number") completionTokens += completion;
      const details = isRecord(chunk.usage.prompt_tokens_details) ? chunk.usage.prompt_tokens_details : {};
      if (typeof details.cached_tokens === "number") cacheReadTokens += details.cached_tokens;
    }
  }
  flushAll();

  // Both v2 reassemblers always emit a usage object (zeros when the stream
  // carried none) — the parser's empty-completion detection reads
  // usage.completion_tokens == 0, so an absent usage must not read as null.
  const usage = withCache({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }, cacheReadTokens, 0);
  return withBlockCounts(
    baseResponse(id, model, contentParts.join(""), toolCalls, finishReason || "stop", usage, error),
    reasoningSegments,
    textDeltas,
    toolCalls.length,
  );
}

interface AnthropicToolBlock {
  id: string;
  name: string;
  argsParts: string[];
  index: number | null;
}

/**
 * #1466: the Anthropic usage fields, tracked PER FIELD.
 *
 * Anthropic's `message_delta.usage.output_tokens` is the CUMULATIVE output
 * count of the turn, not a delta, and MiniMax/LiteLLM report the
 * authoritative input and cache counters in that same `message_delta` —
 * while their `message_start` carries only a `{input_tokens: 0,
 * output_tokens: 0}` placeholder. So the counters are read per field and
 * never added up: adding them would double count the same turn (the
 * placeholder plus the real count).
 *
 * WHICH report of a field wins is decided by the zero rule. Anthropic's
 * counters are cumulative and never decrease, so a zero report that
 * follows a non-zero one is a PLACEHOLDER, not a measurement: taking it
 * would lose the real counters and reproduce the #1459 symptom
 * (`prompt=0 cached=-`) in the opposite order. So a non-zero report
 * replaces the earlier value, a zero report never replaces a non-zero
 * value, a field only ever reported as zero keeps its zero (the provider
 * DID report it), and a field that was never reported stays unreported.
 */
interface AnthropicUsageField {
  /** The last NON-ZERO report of this field. */
  lastNonZero: number | null;
  /** True once the provider reported this field at all — a zero counts. */
  reported: boolean;
}

interface AnthropicUsageState {
  inputTokens: AnthropicUsageField;
  outputTokens: AnthropicUsageField;
  cacheReadTokens: AnthropicUsageField;
  cacheWriteTokens: AnthropicUsageField;
}

/** #1466: a usage field the provider has not reported yet. */
function unreportedUsageField(): AnthropicUsageField {
  return { lastNonZero: null, reported: false };
}

/** #1466: read one reported counter into a field. A non-zero report is
 * authoritative and replaces the earlier value; a zero report is recorded
 * as reported but never displaces a non-zero value. */
function readUsageField(field: AnthropicUsageField, value: unknown): void {
  if (typeof value !== "number") return;
  field.reported = true;
  if (value !== 0) field.lastNonZero = value;
}

/** #1466: the value a field carries — its last non-zero report, the zero it
 * was only ever reported as, or null when the provider never reported it. */
function resolvedUsageField(field: AnthropicUsageField): number | null {
  if (field.lastNonZero !== null) return field.lastNonZero;
  return field.reported ? 0 : null;
}

/** #1466: read one Anthropic usage object into the per-field state. A
 * field the event does not report keeps its earlier value (a cache
 * counter reported only in `message_start` survives a `message_delta`
 * that carries none); a field the event reports is read under the zero
 * rule (see `AnthropicUsageField`). */
function readAnthropicUsage(usage: Record<string, unknown>, state: AnthropicUsageState): void {
  readUsageField(state.inputTokens, usage.input_tokens);
  readUsageField(state.outputTokens, usage.output_tokens);
  readUsageField(state.cacheReadTokens, usage.cache_read_input_tokens);
  readUsageField(state.cacheWriteTokens, usage.cache_creation_input_tokens);
}

function reassembleAnthropic(text: string, quality: SseReassemblyQuality): NormalizedModelResponse {
  const contentParts: string[] = [];
  const toolCalls: NormalizedToolCall[] = [];
  let id = "";
  let model = "";
  // #1466: the usage counters are tracked per field (the last non-zero
  // report wins) — see `AnthropicUsageState` for why they must never be
  // summed.
  const usageState: AnthropicUsageState = {
    inputTokens: unreportedUsageField(),
    outputTokens: unreportedUsageField(),
    cacheReadTokens: unreportedUsageField(),
    cacheWriteTokens: unreportedUsageField(),
  };
  let stopReason = "";
  let error: unknown;
  let openBlock: AnthropicToolBlock | null = null;
  // #1047: counts only — thinking blocks (including redacted thinking), text
  // deltas, and tool-use blocks; never their content.
  let textDeltas = 0;
  let thinkingBlocks = 0;
  let toolBlocks = 0;

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
      // #1628: the frame that did not parse — a count, never its text.
      quality.malformedFrames = bumpCount(quality.malformedFrames);
      continue;
    }
    quality.dataFrames = bumpCount(quality.dataFrames);
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
      readAnthropicUsage(usage, usageState);
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
        toolBlocks = bumpCount(toolBlocks);
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        thinkingBlocks = bumpCount(thinkingBlocks);
      }
      continue;
    }
    if (event.type === "content_block_delta") {
      const delta = isRecord(event.delta) ? event.delta : {};
      if (delta.type === "text_delta" || delta.type === "text") {
        const piece = asString(delta.text);
        if (piece !== null) {
          contentParts.push(piece);
          textDeltas = bumpCount(textDeltas);
        }
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
      readAnthropicUsage(usage, usageState);
      continue;
    }
    if (event.type === "message_stop") {
      // #1628: the stream's own termination frame.
      quality.sawTermination = true;
      flushOpen();
    }
  }
  flushOpen();

  let finishReason = stopReason || "stop";
  if (toolCalls.length > 0 && finishReason === "tool_use") finishReason = "tool_calls";
  // #1466: the reported counters, per field — never summed across events.
  // `promptTokens` is the UNCACHED input count under Anthropic semantics
  // (the cache counters are reported outside it); the #910 accounting in
  // `normalizeUsageTelemetry` adds the cache tokens to it.
  const promptTokens = resolvedUsageField(usageState.inputTokens) ?? 0;
  const completionTokens = resolvedUsageField(usageState.outputTokens) ?? 0;
  // #1466: a cache counter the provider reported rides the usage even when
  // its value is zero; a counter it never reported stays absent.
  const cacheReadTokens = resolvedUsageField(usageState.cacheReadTokens);
  const cacheWriteTokens = resolvedUsageField(usageState.cacheWriteTokens);
  const usage = withReportedCache({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }, cacheReadTokens, cacheWriteTokens);
  return withBlockCounts(
    baseResponse(id, model, contentParts.join(""), toolCalls, finishReason, usage, error),
    thinkingBlocks,
    textDeltas,
    toolBlocks,
  );
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
  // #1628: the quality probe is filled BY the reassemblers as they parse and
  // rides the final response object, so the caller can tell a well-formed
  // empty stream from a malformed/truncated/never-terminated one without
  // ever seeing a frame.
  const quality: SseReassemblyQuality = { dataFrames: 0, malformedFrames: 0, sawTermination: false };
  const response = apiFormat === "anthropic"
    ? reassembleAnthropic(text, quality)
    : reassembleOpenai(text, quality);
  return attachSseReassemblyQuality(adoptPlainErrorBody(text, response), quality);
}

/**
 * #1628: the reassembly-quality probe — HOW COMPLETELY an SSE body parsed,
 * never WHAT it said.
 *
 * A streamed loop turn that reassembled to nothing was either a well-formed
 * stream that genuinely carried no output, or a body whose frames were
 * malformed/truncated (or never terminated at all). The reassembler is the
 * only module that saw the framing, so it records the counts here and the
 * harness classifies the discarded attempt from them. Counts and one boolean
 * — never frame text — and, like the #1466 timing probe, the value rides the
 * response under a SYMBOL key (non-enumerable), so it can never leak into a
 * persisted artifact, a log line, or a JSON body by accident.
 */
export interface SseReassemblyQuality {
  /** `data:` frames that parsed as JSON (capped). */
  dataFrames: number;
  /** `data:` frames whose JSON did not parse (capped). */
  malformedFrames: number;
  /** A termination frame arrived: `[DONE]` / a finish reason (OpenAI) or
   * `message_stop` (Anthropic). False means the body ENDED without one. */
  sawTermination: boolean;
}

/** #1628: the key the quality probe is attached under. `Symbol.for` for the
 * same cross-module-instance stability the timing probe uses. */
export const SSE_REASSEMBLY_QUALITY: unique symbol = Symbol.for("pr-reviewer-action.sse-reassembly-quality");

/** #1628: attach the probe to the reassembled response. Non-enumerable and
 * observation-only, exactly like the timing probe: a value that cannot carry
 * an own property is returned unchanged. */
export function attachSseReassemblyQuality<T>(value: T, quality: SseReassemblyQuality): T {
  if (value === null || typeof value !== "object") return value;
  try {
    Object.defineProperty(value, SSE_REASSEMBLY_QUALITY, {
      value: quality,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  } catch {
    // A sealed/frozen value cannot carry the probe; observation-only.
  }
  return value;
}

function countField(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

/**
 * #1628: read the quality probe back off a response object, or null when it
 * carries none. Defensive like `readTransportTiming`: a value that crossed a
 * JSON round-trip (or never came from `reassembleSse`) has no probe — it must
 * read as "unknown", never as a half-valid measurement.
 */
export function readSseReassemblyQuality(value: unknown): SseReassemblyQuality | null {
  if (value === null || typeof value !== "object") return null;
  const holder = value as { [SSE_REASSEMBLY_QUALITY]?: unknown };
  const raw = holder[SSE_REASSEMBLY_QUALITY];
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const dataFrames = countField(record.dataFrames);
  const malformedFrames = countField(record.malformedFrames);
  if (dataFrames === null || malformedFrames === null) return null;
  if (typeof record.sawTermination !== "boolean") return null;
  return { dataFrames, malformedFrames, sawTermination: record.sawTermination };
}

/**
 * #1466: does this SSE payload carry CONTENT?
 *
 * The transport's timing probe needs to know when the provider's answer
 * actually started arriving, and the reassembler is the module that
 * already knows what "content" means for each wire format — so the
 * definition lives here and the transport calls it, and the two can
 * never disagree.
 *
 * - OpenAI: a choice whose `delta` carries a non-empty text `content`, a
 *   non-empty `reasoning_content`/`reasoning` string, or a `tool_calls`
 *   value. An empty `tool_calls` array carries nothing, so it does not
 *   count as content.
 * - Anthropic: a `content_block_start` or `content_block_delta` event.
 *
 * A payload that is not valid JSON carries nothing: it cannot be
 * classified, so it is never reported as content.
 */
export function isContentBearingSseFrame(payload: string, apiFormat: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (apiFormat === "anthropic") {
    return parsed.type === "content_block_start" || parsed.type === "content_block_delta";
  }
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    const content = asString(delta.content);
    if (content !== null && content !== "") return true;
    // The two reasoning spellings are read INDEPENDENTLY: a frame that
    // carries an empty `reasoning_content` beside a filled `reasoning`
    // still carries content.
    const reasoningContent = asString(delta.reasoning_content);
    if (reasoningContent !== null && reasoningContent !== "") return true;
    const reasoning = asString(delta.reasoning);
    if (reasoning !== null && reasoning !== "") return true;
    const toolCalls = delta.tool_calls;
    if (Array.isArray(toolCalls) ? toolCalls.length > 0 : isRecord(toolCalls)) return true;
  }
  return false;
}
