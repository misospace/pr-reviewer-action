import { readFileSync } from "node:fs";
import { Conversation } from "../model/conversation.js";
import { driveToolLoop, type LoopBudgets } from "./loop.js";

export async function toolLoopFixtureMain(path: string): Promise<void> {
  const f = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  const c = new Conversation(); c.system = "fixture system"; c.addUser("fixture user");
  const turns: any[] = [...(f.turns ?? [])], requests: Record<string, unknown>[] = [];
  const results = turns.flatMap((t) => t.exec_results ?? []); const summaries = [...(f.summarizer?.responses ?? [])]; const clock = [...(f.clock ?? Array(100).fill(0))];
  const o = await driveToolLoop(c, async (payload) => { requests.push(payload); const item = turns.shift()?.response; if (item === undefined) throw new Error("scripted response queue exhausted"); if ("raise" in item) throw new Error(item.raise); return item; }, (async () => results.shift() ?? { tool: "", status: "error", result: { error: "no scripted result" } }), { apiFormat: f.apiFormat ?? "openai", model: f.model ?? "fixture-model", budgets: { maxToolCalls: f.budgets.max_tool_calls, maxRounds: f.budgets.max_rounds, wallClockSec: f.budgets.wall_clock_sec, maxConversationTokens: f.budgets.max_conversation_tokens, truncatedResultBytes: f.budgets.truncated_result_bytes, summarizeKeepNewest: f.budgets.summarize_keep_newest } as LoopBudgets, maxTokens: f.options?.maxTokens ?? 1024, temperature: f.options?.temperature ?? 0, stream: f.options?.stream ?? false, tokensParam: f.options?.tokensParam ?? "max_tokens", cachePrefix: f.options?.cachePrefix ?? false, summarizeFn: f.summarizer ? () => summaries.shift() ?? "" : null, timeFn: () => clock.shift() ?? 0 });
  const outcome = { rounds: o.rounds, tool_calls_issued: o.toolCallsIssued, stop_reason: o.stopReason, final_text: o.finalText, degraded: o.degraded, error: o.error, requests_remaining: o.requestsRemaining, tool_result_bytes: o.toolResultBytes, compaction_summarize: o.compactionSummarize, compaction_truncate: o.compactionTruncate, executed: o.executed.map((x) => ({ tool: x.tool, args: x.args, status: x.result.status })) };
  const result = { outcome, messages: c.renderOpenAiMessages(), payload_last: requests.at(-1) ?? c.toRequestPayload(f.apiFormat ?? "openai", f.model ?? "fixture-model") };
  process.stdout.write(`${JSON.stringify({ ok: true, values: { result } })}\n`);
}
