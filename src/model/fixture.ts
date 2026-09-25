import { readFileSync } from "node:fs";
import { Conversation, dedupeVerdictCorpus } from "./conversation.js";

export async function conversationFixtureMain(path: string): Promise<void> {
  const fixture = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  const conversation = new Conversation();
  conversation.system = fixture.system ?? "";
  for (const op of fixture.ops ?? []) {
    switch (op.op) {
      case "add_user": conversation.addUser(op.content); break;
      case "add_assistant_text": conversation.addAssistantText(op.content); break;
      case "add_assistant_tool_calls": conversation.addAssistantToolCalls(op.calls); break;
      case "add_tool_result": conversation.addToolResult(op.call_id, op.result, { isError: op.is_error ?? false, maxBytes: op.max_bytes }); break;
      case "add_system_note": conversation.addSystemNote(op.content); break;
      case "add_turn_note": conversation.addTurnNote(op.content); break;
      case "truncate_oldest_tool_results": conversation.truncateOldestToolResults(op.max_bytes); break;
      case "summarize_oldest_tool_results": await conversation.summarizeOldestToolResults(() => op.digest ?? "fixture digest", { keepNewest: op.keep_newest ?? 2 }); break;
      default: throw new Error(`unknown operation: ${op.op}`);
    }
  }
  const result: Record<string, unknown> = { payloads: (fixture.emit ?? []).map((item: any) => conversation.toRequestPayload(item.apiFormat ?? "openai", item.model ?? "fixture-model", item.options ?? {})) };
  if (fixture.introspect?.turns) result.turns = conversation.turns();
  if (fixture.introspect?.open_tool_call_ids) result.open_tool_call_ids = [...conversation.openToolCallIds()].sort();
  if (fixture.introspect?.approx_tokens) result.approx_tokens = conversation.approxTokens();
  if (fixture.dedup) result.dedup = { ...fixture.dedup, result: dedupeVerdictCorpus(fixture.dedup.corpus, fixture.dedup.planning) };
  process.stdout.write(`${JSON.stringify({ ok: true, values: { result } })}\n`);
}
