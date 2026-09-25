/**
 * Native tool-calling loop driver — the v3 port of `pr_reviewer/tool_loop.py`
 * (#203, #678).
 *
 * Drives an agentic exchange against a tool-capable model: send the corpus +
 * tool schemas, execute the tool calls the model returns, append the results,
 * and repeat until the model stops calling tools or a budget runs out.
 *
 * Each turn can be streamed (`stream=true`): the injected `postFn` owns SSE
 * reassembly and hands back the same non-streaming response shape this module
 * parses, so the driver stays format-agnostic.
 *
 * The module is deliberately I/O-free: the HTTP POST and the tool execution
 * are injected callables, so the whole loop is unit-testable against scripted
 * conversations without a model server. `src/tools/harness.ts` owns the real
 * wiring (transport + the read-only executors with their allowlists, caps, and
 * timeouts — none of which change here).
 *
 * Reliability posture (issue #203): the loop budgets for repair instead of
 * assuming competence. Malformed arguments come back as error tool-results the
 * model can react to, duplicate calls are answered from a dedup note without
 * burning budget, every call id the model issues gets *some* result before the
 * next request (the Conversation openToolCallIds contract), and hard caps bound
 * rounds, total calls, and wall clock. A model that never calls tools at all is
 * reported as `degraded` so the caller can fall back to a corpus-only review.
 */
import {
  Conversation,
  pyDumps,
  pyDumpsCompactSortedAscii,
  pyDumpsSorted,
  type ToolCallRecord,
} from "../model/conversation.js";

// Stop reasons (LoopOutcome.stopReason)
export const STOP_MODEL_DONE = "model-stopped";
export const STOP_NO_TOOL_CALLS = "no-tool-calls";
export const STOP_MAX_ROUNDS = "max-rounds";
export const STOP_BUDGET = "tool-call-budget-exhausted";
export const STOP_WALL_CLOCK = "wall-clock-exceeded";
export const STOP_REQUEST_ERROR = "request-error";

// Synthetic result bodies. These are model-facing: they must explain the
// refusal in one sentence so a self-correcting model has something to act on.
const DUPLICATE_NOTE =
  "Duplicate request: this exact tool call already ran in this conversation. " +
  "Reuse the earlier result instead of repeating the call.";
const BUDGET_NOTE =
  "Tool-call budget exhausted: this call was not executed. " +
  "Finish the analysis with the evidence you already have.";

// #701 exhaustion awareness: every loop turn after the first carries the
// remaining request/round budget, so the model plans against real headroom
// instead of discovering the ceiling via a refused call. Once few requests
// remain the note switches from status to direction: stop broad exploration,
// spend what is left on unresolved blocker hypotheses and verdict evidence.
export const LOW_TOOL_REQUESTS_REMAINING = 2;

const BUDGET_TURN_NOTE =
  "[loop budget] {requestsLeft} of {requestsTotal} tool request(s) and " +
  "{roundsLeft} of {roundsTotal} turn(s) remain.";
const LOW_BUDGET_TURN_NOTE =
  "[loop budget] Only {requestsLeft} tool request(s) and {roundsLeft} " +
  "turn(s) remain. Stop broad exploration now: prioritize confirming or " +
  "rejecting your unresolved blocker hypotheses and gathering only the " +
  "evidence still needed for the verdict.";

function formatNote(template: string, values: Record<string, number>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => String(values[key] ?? ""));
}

/** Hard stop conditions. The driver owns these; Conversation's token helpers
 * are advisory (see src/model/conversation.ts). */
export interface LoopBudgets {
  /** Total executed calls across rounds (TOOL_MAX_REQUESTS). */
  maxToolCalls: number;
  /** Model round-trips (derived: configured rounds doubled, capped at 8). */
  maxRounds: number;
  /** Whole-loop ceiling (TOOL_LOOP_WALL_CLOCK_SEC). */
  wallClockSec: number;
  /** When the conversation outgrows this, the oldest tool results are
   * compacted before the next request (newest stay intact). */
  maxConversationTokens: number;
  truncatedResultBytes: number;
  /** Results kept verbatim when summarizing the rest. */
  summarizeKeepNewest: number;
}

/**
 * Right-size the loop budget. A native round is one model turn, so the
 * headroom is 2× the configured rounds (capped at 8); the configured tool-call
 * budget is used as-is. #701: the request budget is TIER-AWARE — the caller
 * resolves the effective budget from the route (primary ~8, smart ~16,
 * escalated up to 20 — see resolveToolMaxRequests in src/tools/budget.ts) and
 * passes it in here.
 */
export function adaptiveLoopBudgets(
  maxRounds: number,
  maxToolCalls: number,
  wallClockSec: number,
): LoopBudgets {
  const rounds = Math.min(Math.max(maxRounds, 1) * 2, 8);
  return {
    maxToolCalls,
    maxRounds: rounds,
    wallClockSec,
    maxConversationTokens: 24000,
    truncatedResultBytes: 2000,
    summarizeKeepNewest: 2,
  };
}

export interface ExecutedCall {
  tool: string;
  args: Record<string, unknown>;
  /** Executor shape: {"tool", "status", "result"}. */
  result: Record<string, unknown>;
}

export interface LoopOutcome {
  executed: ExecutedCall[];
  rounds: number;
  /** Everything the model asked for, incl. refused calls. */
  toolCallsIssued: number;
  stopReason: string;
  finalText: string;
  /** True when the model never issued a single tool call: the caller degrades
   * to a corpus-only review. */
  degraded: boolean;
  error: string;
  /** #702 budget telemetry, filled on every exit path: how much request
   * budget was left when the loop stopped, how long the loop ran, the
   * effective ceilings it was given, and whether/how often context compaction
   * fired. Counts and sizes only — never tool content. */
  requestsRemaining: number;
  elapsedSec: number;
  maxToolCalls: number;
  maxRounds: number;
  wallClockSec: number;
  toolResultBytes: number;
  compactionSummarize: number;
  compactionTruncate: number;
}

/**
 * Pull (tool_calls, text) out of a non-streaming chat response (port of
 * `extract_tool_calls`). Returned calls are in the flat
 * `{"id", "name", "arguments"}` shape Conversation.addAssistantToolCalls
 * accepts, with `arguments` kept as an opaque JSON string per the #233
 * contract. Anthropic `tool_use` inputs are serialised once at this boundary.
 */
export function extractToolCalls(
  response: unknown,
  apiFormat: string,
): { calls: ToolCallRecord[]; text: string } {
  const calls: ToolCallRecord[] = [];
  const textParts: string[] = [];
  const res = (response ?? {}) as Record<string, unknown>;

  if (apiFormat === "anthropic") {
    const content = res.content;
    if (Array.isArray(content)) {
      for (const raw of content) {
        if (raw === null || typeof raw !== "object") continue;
        const block = raw as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
                } else if (block.type === "tool_use") {
          const callId = block.id;
          const name = block.name;
          if (typeof callId !== "string" || typeof name !== "string") continue;
          const rawInput = block.input;
          let arguments_: string;
          try {
            arguments_ = pyDumpsSorted(rawInput ?? {});
          } catch {
            arguments_ = String(rawInput);
          }
          calls.push({ id: callId, name, arguments: arguments_ });
        }
      }
    }
    return { calls, text: textParts.join("") };
  }

  // OpenAI format
  const choices = res.choices;
  let message: Record<string, unknown> = {};
  if (Array.isArray(choices) && choices.length > 0 && choices[0] !== null && typeof choices[0] === "object") {
    const maybe = (choices[0] as Record<string, unknown>).message;
    if (maybe !== null && typeof maybe === "object") message = maybe as Record<string, unknown>;
  }
  if (typeof message.content === "string") textParts.push(message.content);
  const rawCalls = message.tool_calls;
  if (Array.isArray(rawCalls)) {
    for (const raw of rawCalls) {
      if (raw === null || typeof raw !== "object") continue;
      const call = raw as Record<string, unknown>;
      const fn =
        call.function !== null && typeof call.function === "object"
          ? (call.function as Record<string, unknown>)
          : {};
      const callId = call.id;
      const name = (fn.name ?? call.name) as unknown;
      if (typeof callId !== "string" || typeof name !== "string") continue;
      let args: unknown = fn.arguments;
      if (args === null || args === undefined) args = call.arguments;
      let arguments_: string;
      if (typeof args === "string") {
        arguments_ = args;
      } else {
        try {
          arguments_ = pyDumpsSorted(args ?? {});
        } catch {
          arguments_ = String(args);
        }
      }
      calls.push({ id: callId, name, arguments: arguments_ });
    }
  }
  return { calls, text: textParts.join("") };
}

/** Mirrors the harness request key so dedup behaves the same everywhere. */
function requestKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${pyDumpsCompactSortedAscii(args)}`;
}

export interface DriveToolLoopOptions {
  apiFormat: string;
  model: string;
  budgets?: LoopBudgets;
  maxTokens?: number;
  temperature?: number | null;
  stream?: boolean;
  tokensParam?: string;
  cachePrefix?: boolean;
  /** Best-effort summarizer for context compaction; may be async. */
  summarizeFn?: ((block: string) => string | Promise<string>) | null;
  /** Injectable clock (seconds) for deterministic tests. */
  timeFn?: () => number;
}

/**
 * Run the agentic loop until the model stops or a budget hits (port of
 * `drive_tool_loop`).
 *
 * `postFn` takes a wire-ready request payload and returns the parsed response
 * JSON (throwing on transport failure). `executeFn` takes (toolName, args) and
 * returns the executor result dict `{"tool", "status", "result"}`.
 *
 * The conversation is mutated in place; on return it carries the full
 * transcript (every issued call answered) and can be re-emitted for the
 * verdict turn by the caller.
 */
export async function driveToolLoop(
  conversation: Conversation,
  postFn: (payload: Record<string, unknown>) => Promise<unknown>,
  executeFn: (toolName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>,
  options: DriveToolLoopOptions,
): Promise<LoopOutcome> {
  const budgets: LoopBudgets = options.budgets ?? adaptiveLoopBudgets(3, 8, 120);
  const maxTokens = options.maxTokens ?? 1024;
  const temperature = options.temperature ?? 0.0;
  const stream = options.stream ?? false;
  const tokensParam = options.tokensParam ?? "max_tokens";
  const cachePrefix = options.cachePrefix ?? false;
  const summarizeFn = options.summarizeFn ?? null;
  const timeFn = options.timeFn ?? (() => performance.now() / 1000);

  const outcome: LoopOutcome = {
    executed: [],
    rounds: 0,
    toolCallsIssued: 0,
    stopReason: STOP_NO_TOOL_CALLS,
    finalText: "",
    degraded: false,
    error: "",
    requestsRemaining: 0,
    elapsedSec: 0,
    maxToolCalls: budgets.maxToolCalls,
    maxRounds: budgets.maxRounds,
    wallClockSec: budgets.wallClockSec,
    toolResultBytes: 0,
    compactionSummarize: 0,
    compactionTruncate: 0,
  };
  const started = timeFn();
  let callsExecuted = 0;
  const seenKeys = new Set<string>();
  // Python while-else: the else clause (STOP_MAX_ROUNDS) runs only when the
  // loop condition expires naturally — never after a break.
  let broke = false;

  loop: while (outcome.rounds < budgets.maxRounds) {
    if (timeFn() - started > budgets.wallClockSec) {
      outcome.stopReason = STOP_WALL_CLOCK;
      broke = true;
      break;
    }

    // Keep the next request within the advisory context budget by compacting
    // the oldest tool results (newest stay intact). When a summarizer is
    // wired, fold them into a model-generated digest that preserves salient
    // facts; otherwise (or if it frees nothing / fails) fall back to blunt
    // truncation, which is the guaranteed backstop.
    if (conversation.approxTokens() > budgets.maxConversationTokens) {
      let summarized = 0;
      if (summarizeFn !== null) {
        try {
          summarized = await conversation.summarizeOldestToolResults(
            async (block) => await summarizeFn!(block),
            { keepNewest: budgets.summarizeKeepNewest },
          );
        } catch {
          summarized = 0; // summarization is best-effort
        }
      }
      if (summarized > 0) outcome.compactionSummarize++;
      if (summarized === 0 || conversation.approxTokens() > budgets.maxConversationTokens) {
        outcome.compactionTruncate++;
        conversation.truncateOldestToolResults(budgets.truncatedResultBytes);
      }
    }

    // #701: keep the model exhaustion-aware. Every turn after the first states
    // the remaining request/round budget; near the ceiling it also redirects
    // the remaining spend to blocker hypotheses. Trusted driver text — a
    // turn_note, never inside the untrusted tool-result envelope.
    if (outcome.rounds > 0) {
      const requestsLeft = budgets.maxToolCalls - callsExecuted;
      const roundsLeft = budgets.maxRounds - outcome.rounds;
      const note =
        requestsLeft <= LOW_TOOL_REQUESTS_REMAINING ? LOW_BUDGET_TURN_NOTE : BUDGET_TURN_NOTE;
      conversation.addTurnNote(
        formatNote(note, {
          requestsLeft,
          requestsTotal: budgets.maxToolCalls,
          roundsLeft,
          roundsTotal: budgets.maxRounds,
        }),
      );
    }

    const payload = conversation.toRequestPayload(options.apiFormat, options.model, {
      stream,
      maxTokens,
      temperature,
      tokensParam,
      cachePrefix,
    });
    let response: unknown;
    try {
      response = await postFn(payload);
    } catch (exc) {
      // Transport errors end the loop.
      outcome.stopReason = STOP_REQUEST_ERROR;
      outcome.error = exc instanceof Error ? exc.message : String(exc);
      broke = true;
      break;
    }

    outcome.rounds++;
    const { calls, text } = extractToolCalls(response, options.apiFormat);

    if (calls.length === 0) {
      outcome.finalText = text;
      outcome.stopReason = outcome.toolCallsIssued > 0 ? STOP_MODEL_DONE : STOP_NO_TOOL_CALLS;
      broke = true;
      break;
    }

    if (text) {
      // Interleaved reasoning text rides along inside the same assistant turn
      // on the wire; Conversation stores it as a separate event, which both
      // renderers merge correctly.
      conversation.addAssistantText(text);
    }
    conversation.addAssistantToolCalls(calls);
    outcome.toolCallsIssued += calls.length;

    // Decide each call's disposition SEQUENTIALLY — dedup (seenKeys) and the
    // budget counter are stateful and must stay deterministic and call-ordered.
    // Only the to-run executions are then fanned out concurrently: the executor
    // is read-only and a round's calls are independent (the model emitted them
    // together). Results are applied in the original call order to preserve
    // the open-call contract.
    type Disposition = { callId: string; kind: "error" | "dup" | "budget"; data: Record<string, unknown> } | { callId: string; kind: "exec"; data: number };
    const plan: Disposition[] = [];
    const toExecute = new Map<number, { name: string; args: Record<string, unknown> }>();
    for (let idx = 0; idx < calls.length; idx++) {
      const call = calls[idx]!;
      const callId = call.id;
      // Arguments arrive as an opaque JSON string (#233 contract); parse here,
      // and on failure answer with a repairable error instead of crashing the
      // loop — weak models misquote JSON.
      let args: unknown;
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
        if (args === null || typeof args !== "object" || Array.isArray(args)) {
          throw new Error("arguments must be a JSON object");
        }
      } catch (exc) {
        const message = exc instanceof Error ? exc.message : String(exc);
        plan.push({
          callId,
          kind: "error",
          data: { error: `Invalid tool arguments (not a JSON object): ${message}` },
        });
        continue;
      }
      const key = requestKey(call.name, args as Record<string, unknown>);
      if (seenKeys.has(key)) {
        plan.push({ callId, kind: "dup", data: { note: DUPLICATE_NOTE } });
        continue;
      }
      if (callsExecuted >= budgets.maxToolCalls) {
        plan.push({ callId, kind: "budget", data: { error: BUDGET_NOTE } });
        continue;
      }
      seenKeys.add(key);
      callsExecuted++;
      toExecute.set(idx, { name: call.name, args: args as Record<string, unknown> });
      plan.push({ callId, kind: "exec", data: idx });
    }

    // Fan out the executions (read-only, independent within a round).
    const resultsByIdx = new Map<number, Record<string, unknown>>();
    if (toExecute.size > 0) {
      const entries = [...toExecute.entries()];
      const settled = await Promise.all(
        entries.map(async ([idx, { name, args }]) => {
          try {
            return [idx, await executeFn(name, args)] as const;
          } catch (exc) {
            // A throwing executor must not crash the loop; surface as an
            // executor-shaped error result.
            return [
              idx,
              { tool: name, status: "error", result: { error: exc instanceof Error ? exc.message : String(exc) } },
            ] as const;
          }
        }),
      );
      for (const [idx, result] of settled) resultsByIdx.set(idx, result);
    }

    // Apply results in call order (synthetic refusals inline).
    for (const disposition of plan) {
      if (disposition.kind !== "exec") {
        conversation.addToolResult(disposition.callId, disposition.data, { isError: true });
        continue;
      }
      const exec = toExecute.get(disposition.data)!;
      const result = resultsByIdx.get(disposition.data)!;
      outcome.executed.push({ tool: exec.name, args: exec.args, result });
      try {
        outcome.toolResultBytes += Buffer.byteLength(
          pyDumps((result.result ?? {}) as unknown),
          "utf8",
        );
      } catch {
        // never let telemetry break the loop
      }
      conversation.addToolResult(disposition.callId, result.result ?? {}, {
        isError: result.status !== "ok",
      });
    }

    if (callsExecuted >= budgets.maxToolCalls) {
      outcome.stopReason = STOP_BUDGET;
      broke = true;
      break loop;
    }
  }
  if (!broke) {
    outcome.stopReason = STOP_MAX_ROUNDS;
  }

  outcome.degraded = outcome.toolCallsIssued === 0;
  // #702: close out the telemetry on every exit path.
  outcome.requestsRemaining = Math.max(0, budgets.maxToolCalls - callsExecuted);
  outcome.elapsedSec = timeFn() - started;
  return outcome;
}
