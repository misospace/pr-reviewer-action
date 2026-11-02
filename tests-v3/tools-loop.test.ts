import test from "node:test";
import assert from "node:assert/strict";
import { Conversation } from "../src/model/conversation.js";
import { sanitizedSourceProvenance } from "../src/context/evidence-provenance.js";
import {
  STOP_BUDGET,
  STOP_MAX_ROUNDS,
  STOP_MODEL_DONE,
  STOP_NO_TOOL_CALLS,
  STOP_REQUEST_ERROR,
  STOP_WALL_CLOCK,
  TOOL_LOOP_ROUNDS_CEILING,
  adaptiveLoopBudgets,
  DEPENDENCY_EVIDENCE_OBLIGATIONS,
  dependencyEvidenceObligationsForCall,
  driveToolLoop,
  extractToolCalls,
  type DependencyEvidenceObligation,
  type DriveToolLoopOptions,
  type NativeLoopRoundTelemetry,
  type ToolTurnSignal,
} from "../src/tools/loop.js";
import { buildSummarizerConversation } from "../src/tools/harness.js";

function scriptedLoop(responses: unknown[], execResults: Record<string, unknown>[], clock: number[] = []) {
  let responseIndex = 0;
  let execIndex = 0;
  let clockIndex = 0;
  const postFn = async () => {
    const next = responses[responseIndex++];
    if (next !== undefined && next !== null && typeof next === "object" && "raise" in (next as Record<string, unknown>)) {
      throw new Error(String((next as Record<string, unknown>).raise));
    }
    return next;
  };
  const executeFn = async () => execResults[execIndex++] ?? { tool: "?", status: "error", result: { error: "no scripted result" } };
  const timeFn = () => clock[clockIndex++] ?? Number.MAX_SAFE_INTEGER / 2;
  return { postFn, executeFn, timeFn };
}

const openAiCall = (id: string, name: string, args: string) => ({
  choices: [{ message: { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] } }],
});
const openAiText = (text: string) => ({ choices: [{ message: { content: text } }] });

test("a model that never calls tools degrades without consuming budget", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn } = scriptedLoop([openAiText("no tools needed")], []);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(2, 4, 120),
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_NO_TOOL_CALLS);
  assert.equal(outcome.degraded, true);
  assert.equal(outcome.finalText, "no tools needed");
  assert.equal(outcome.toolCallsIssued, 0);
  assert.equal(outcome.requestsRemaining, 4);
});

test("model stops voluntarily after gathering evidence", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [openAiCall("c1", "read_file", '{"path":"a.ts"}'), openAiText("done")],
    [{ tool: "read_file", status: "ok", result: { content: "body" } }],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(2, 4, 120),
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_MODEL_DONE);
  assert.equal(outcome.degraded, false);
  assert.equal(outcome.finalText, "done");
  assert.equal(outcome.executed.length, 1);
  assert.equal(outcome.requestsRemaining, 3);
});

test("executor provenance rides through the loop into the rendered tool result", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [openAiCall("c1", "read_file", '{"path":"src/x.ts"}'), openAiText("done")],
    [
      {
        tool: "read_file",
        status: "ok",
        result: { content: "x" },
        provenance: sanitizedSourceProvenance(1, "src/x.ts", "abc123"),
      },
    ],
  );
  await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(2, 4, 120),
    timeFn,
  });
  const event = conversation.events.find((e) => e.kind === "tool_result") as { evidence?: unknown };
  assert.ok(event.evidence);
  const msg = (conversation.renderOpenAiMessages() as Array<{ role: string; content: string }>).find((m) => m.role === "tool")!;
  assert.ok(msg.content.includes('representation="sanitized_source"'));
  assert.ok(msg.content.includes('synthesized="true"'));
  assert.ok(msg.content.includes('redaction_count="1"'));
  assert.ok(msg.content.includes('source_file="src/x.ts"'));
  assert.ok(msg.content.includes('source_revision="abc123"'));
});

test("round budget exhausts with the doubled cap", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const rounds = 3;
  const responses = Array.from({ length: rounds * 2 }, (_, i) => openAiCall(`c${i}`, "t", "{}"));
  const exec = responses.map(() => ({ tool: "t", status: "ok", result: {} }));
  const { postFn, executeFn, timeFn } = scriptedLoop(responses, exec);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(rounds, 50, 120),
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_MAX_ROUNDS);
  assert.equal(outcome.rounds, 6); // 3 configured × 2, capped at 12
});

test("request budget exhaustion refuses further calls and records the distinct stop reason", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // One assistant turn requesting three calls against a budget of two: the
  // third call is refused inside the round with a synthetic budget note.
  const oneRound = { ...adaptiveLoopBudgets(1, 2, 120), maxRounds: 1 };
  const response = openAiCall("c0", "t", '{"n":0}');
  const extraCalls = [
    openAiCall("c1", "t", '{"n":1}'),
    openAiCall("c2", "t", '{"n":2}'),
  ].map((r) => (r as { choices: Array<{ message: { tool_calls: Record<string, unknown>[] } }> }).choices[0]!.message.tool_calls[0]!);
  (response as { choices: Array<{ message: { tool_calls: unknown[] } }> }).choices[0]!.message.tool_calls.push(...extraCalls);
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [response],
    [0, 1, 2].map(() => ({ tool: "t", status: "ok", result: {} })),
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: oneRound,
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_BUDGET);
  assert.equal(outcome.requestsRemaining, 0);
  assert.equal(outcome.executed.length, 2);
  // The refused third call got a synthetic budget note as its tool result.
  const noteEvent = conversation.events.at(-1) as { kind: string; content: string; is_error: boolean };
  assert.equal(noteEvent.kind, "tool_result");
  assert.equal(noteEvent.is_error, true);
  assert.match(noteEvent.content, /Tool-call budget exhausted/);
  assert.equal(conversation.events.filter((e) => e.kind === "turn_note").length, 0);
});

test("exhaustion-aware budget notes appear from the second round onward", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const oneRoundThenStop = { ...adaptiveLoopBudgets(1, 4, 120), maxRounds: 2 };
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [openAiCall("c1", "t", "{}"), openAiText("done")],
    [{ tool: "t", status: "ok", result: {} }],
  );
  await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: oneRoundThenStop,
    timeFn,
  });
  const notes = conversation.events.filter((e) => e.kind === "turn_note") as Array<{ content: string }>;
  assert.equal(notes.length, 1);
  assert.match(notes[0]!.content, /^\[loop budget\] 3 of 4 tool request\(s\)/);
});

test("#1222: OpenAI loop requests preserve prior messages as an exact prefix", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const responses = [
    openAiCall("c1", "read_file", '{"path":"a.ts"}'),
    openAiCall("c2", "read_file", '{"path":"b.ts"}'),
    openAiText("done"),
  ];
  const payloads: Array<Record<string, unknown>> = [];
  let responseIndex = 0;
  const outcome = await driveToolLoop(
    conversation,
    async (payload) => {
      payloads.push(structuredClone(payload));
      return responses[responseIndex++];
    },
    async (_name, args) => ({ tool: "read_file", status: "ok", result: { content: String(args.path ?? "") } }),
    {
      apiFormat: "openai",
      model: "m",
      budgets: adaptiveLoopBudgets(3, 8, 120),
      timeFn: () => 0,
    },
  );

  assert.equal(outcome.stopReason, STOP_MODEL_DONE);
  assert.equal(payloads.length, 3);
  for (let index = 1; index < payloads.length; index++) {
    const previous = payloads[index - 1]!.messages as Array<Record<string, unknown>>;
    const current = payloads[index]!.messages as Array<Record<string, unknown>>;
    assert.deepEqual(
      current.slice(0, previous.length),
      previous,
      `round ${index + 1} rewrote round ${index}'s OpenAI message prefix`,
    );
    assert.deepEqual(payloads[index]!.tools, payloads[index - 1]!.tools, "tool schema prefix must stay stable");
  }

  const notes = conversation.events.filter((e) => e.kind === "turn_note") as Array<{ content: string }>;
  assert.equal(notes.length, 2);
  assert.match(notes[0]!.content, /^\[loop budget\] 7 of 8 tool request\(s\)/);
  assert.match(notes[1]!.content, /^\[loop budget\] 6 of 8 tool request\(s\)/);
});

test("duplicate calls are answered from a dedup note without burning budget", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const dup = openAiCall("c2", "t", '{"n":1}');
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [openAiCall("c1", "t", '{"n":1}'), dup],
    [{ tool: "t", status: "ok", result: {} }, { tool: "t", status: "ok", result: {} }],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(1, 4, 120),
    timeFn,
  });
  assert.equal(outcome.executed.length, 1); // only the first ran
  assert.equal(outcome.requestsRemaining, 3);
  const noteEvent = conversation.events.at(-1) as { content: string };
  assert.match(noteEvent.content, /Duplicate request/);
});

test("malformed arguments get a repairable error result instead of crashing", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const oneRound = { ...adaptiveLoopBudgets(1, 4, 120), maxRounds: 1 };
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [openAiCall("c1", "t", '{"path": broken')],
    [],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: oneRound,
    timeFn,
  });
  assert.equal(outcome.executed.length, 0);
  assert.equal(outcome.degraded, false); // a call WAS issued (refused ≠ never called)
  assert.equal(outcome.toolCallsIssued, 1);
  const event = conversation.events.at(-1) as { is_error: boolean; content: string };
  assert.equal(event.is_error, true);
  assert.match(event.content, /Invalid tool arguments \(not a JSON object\)/);
});

test("transport errors end the loop with the request-error stop reason", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn } = scriptedLoop([{ raise: "connection reset" }], []);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(2, 4, 120),
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_REQUEST_ERROR);
  assert.equal(outcome.error, "connection reset");
  assert.equal(outcome.degraded, true);
});

test("#747: temperature null omits the field from every round; an absent temperature keeps 0.0", async () => {
  const anthropicCall = { content: [{ type: "tool_use", id: "a1", name: "t", input: {} }] };
  const anthropicText = { content: [{ type: "text", text: "done" }] };
  const rounds = {
    openai: [openAiCall("c1", "t", "{}"), openAiText("done")],
    anthropic: [anthropicCall, anthropicText],
  };
  for (const apiFormat of ["openai", "anthropic"] as const) {
    for (const temperature of [null, undefined]) {
      const conversation = new Conversation();
      conversation.addUser("corpus");
      const payloads: Array<Record<string, unknown>> = [];
      const scripted = rounds[apiFormat];
      const outcome = await driveToolLoop(
        conversation,
        async (payload) => {
          payloads.push(payload);
          return scripted[payloads.length - 1];
        },
        async () => ({ tool: "t", status: "ok", result: {} }),
        {
          apiFormat,
          model: "m",
          budgets: adaptiveLoopBudgets(2, 4, 120),
          timeFn: () => 0,
          ...(temperature === undefined ? {} : { temperature }),
        },
      );
      const label = `${apiFormat}, temperature ${String(temperature)}`;
      assert.equal(outcome.stopReason, STOP_MODEL_DONE, label);
      assert.equal(payloads.length, 2, label);
      for (const payload of payloads) {
        if (temperature === null) assert.equal("temperature" in payload, false, label);
        else assert.equal(payload.temperature, 0.0, label);
      }
    }
  }
});

test("wall-clock deadline stops the loop between rounds", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Clock: started=0, round-1 check=0 (runs), round-2 check=999 (stops).
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [openAiCall("c1", "t", "{}"), openAiCall("c2", "t", "{}")],
    [{ tool: "t", status: "ok", result: {} }, { tool: "t", status: "ok", result: {} }],
    [0, 0, 999],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 10, 120),
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_WALL_CLOCK);
  assert.equal(outcome.rounds, 1);
});

// #1198: when the harness passes an absolute whole-exchange deadline, the
// between-rounds check fires on the ABSOLUTE clock instead of time-since-own-
// start, so pre-loop setup time and a deadline taken before the loop both
// count — and a loop that starts past the deadline never opens a round.

test("#1198: an absolute deadline already past at loop start stops before any model request", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  let postCalls = 0;
  const postFn = async () => {
    postCalls++;
    return openAiCall("c1", "t", "{}");
  };
  const executeFn = async () => ({ tool: "t", status: "ok", result: {} });
  // A constant clock past the deadline: the absolute check is independent of
  // the loop's own started time, so zero remaining budget must end the run
  // without a single new model request.
  const timeFn = () => 500;
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 10, 120),
    wallClockDeadline: 100,
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_WALL_CLOCK);
  assert.equal(outcome.rounds, 0);
  assert.equal(postCalls, 0, "no new model request begins with zero remaining budget");
  assert.equal(outcome.toolCallsIssued, 0);
});

test("#1198: an absolute deadline fires before a new model request between rounds", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Clock: started=0, round-1 check=5 (runs), round-2 check=100 (at the
  // deadline → stops BEFORE the second postFn call). The legacy elapsed check
  // (100 - 0 vs the 120s ceiling) would have opened round 2 here.
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [openAiCall("c1", "t", "{}"), openAiCall("c2", "t", "{}")],
    [{ tool: "t", status: "ok", result: {} }, { tool: "t", status: "ok", result: {} }],
    [0, 5, 100],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 10, 120),
    wallClockDeadline: 100,
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_WALL_CLOCK);
  assert.equal(outcome.rounds, 1);
  assert.equal(outcome.toolCallsIssued, 1);
});

test("#1198: without a finite absolute deadline the elapsed-since-start check still applies", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Unset, null, and non-finite deadlines all fall back to the legacy check.
  for (const deadline of [undefined, null, Number.POSITIVE_INFINITY] as const) {
    const { postFn, executeFn, timeFn } = scriptedLoop(
      [openAiCall("c1", "t", "{}"), openAiCall("c2", "t", "{}")],
      [{ tool: "t", status: "ok", result: {} }, { tool: "t", status: "ok", result: {} }],
      [0, 0, 999],
    );
    const options: DriveToolLoopOptions = {
      apiFormat: "openai",
      model: "m",
      budgets: adaptiveLoopBudgets(4, 10, 120),
      timeFn,
    };
    if (deadline !== undefined) options.wallClockDeadline = deadline;
    const outcome = await driveToolLoop(conversation, postFn, executeFn, options);
    assert.equal(outcome.stopReason, STOP_WALL_CLOCK, String(deadline));
    assert.equal(outcome.rounds, 1, String(deadline));
  }
});

test("compaction: blunt truncation backstops when no summarizer frees enough", async () => {
  const conversation = new Conversation();
  conversation.system = "s";
  conversation.addUser("x".repeat(500));
  conversation.addAssistantToolCalls([{ id: "c1", name: "t", arguments: "{}" }]);
  const big = "y".repeat(30000);
  conversation.addToolResult("c1", { blob: big }, { maxBytes: 40000 });
  const { postFn, executeFn, timeFn } = scriptedLoop([openAiText("done")], []);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: { ...adaptiveLoopBudgets(1, 8, 120), maxConversationTokens: 100, truncatedResultBytes: 100 },
    timeFn,
  });
  assert.ok(outcome.compactionTruncate >= 1);
  const event = conversation.events.find((e) => e.kind === "tool_result") as { content: string };
  assert.ok(Buffer.byteLength(event.content, "utf8") <= 100);
});

test("#1043 review: compaction replaces a read_skill result with a truthful marker, never a partial body", async () => {
  const conversation = new Conversation();
  conversation.system = "s";
  conversation.addUser("x".repeat(500));
  conversation.addAssistantToolCalls([{ id: "s1", name: "read_skill", arguments: "{}" }]);
  const skillPayload = {
    path: ".agents/skills/dependency-upgrades/SKILL.md",
    content: `skill body ${"y".repeat(40_000)}`,
    source: "trusted-base",
    content_complete: true,
  };
  conversation.addToolResult("s1", skillPayload, { tool: "read_skill", maxBytes: 60_000 });
  conversation.addAssistantToolCalls([{ id: "c2", name: "read_file", arguments: "{}" }]);
  conversation.addToolResult("c2", { blob: "z".repeat(30_000) }, { maxBytes: 40_000 });
  const { postFn, executeFn, timeFn } = scriptedLoop([openAiText("done")], []);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: { ...adaptiveLoopBudgets(1, 8, 120), maxConversationTokens: 100, truncatedResultBytes: 100 },
    timeFn,
  });
  assert.ok(outcome.compactionTruncate >= 1);
  const events = conversation.events.filter((e) => e.kind === "tool_result") as Array<{ call_id: string; content: string }>;
  const skill = events.find((e) => e.call_id === "s1")!;
  assert.match(skill.content, /\[repository skill \(\.agents\/skills\/dependency-upgrades\/SKILL\.md\) discarded during context compaction/);
  assert.doesNotMatch(skill.content, /skill body/, "no partial skill content survives");
  const normal = events.find((e) => e.call_id === "c2")!;
  assert.ok(Buffer.byteLength(normal.content, "utf8") <= 100, "non-skill results still blunt-truncate");
});

test("#1043 review: digest folding leaves skill results out of the digest and marks them discarded", async () => {
  const conversation = new Conversation();
  conversation.addUser("x".repeat(500));
  conversation.addAssistantToolCalls([{ id: "s1", name: "read_skill", arguments: "{}" }]);
  conversation.addToolResult(
    "s1",
    { path: ".agents/skills/app-security/SKILL.md", content: "SECRET-SKILL-ADVICE check auth boundaries", content_complete: true, source: "trusted-base" },
    { tool: "read_skill", maxBytes: 60_000 },
  );
  conversation.addAssistantToolCalls([{ id: "c1", name: "read_file", arguments: "{}" }]);
  conversation.addToolResult("c1", "old file evidence");
  conversation.addAssistantToolCalls([{ id: "c2", name: "read_file", arguments: "{}" }]);
  conversation.addToolResult("c2", "newest file evidence");
  const { postFn, executeFn, timeFn } = scriptedLoop([openAiText("done")], []);
  const summarizeFn = (block: string) => {
    assert.doesNotMatch(block, /SECRET-SKILL-ADVICE/, "skill bodies never enter the digest prompt");
    assert.match(block, /old file evidence/);
    return "digest of old evidence";
  };
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: { ...adaptiveLoopBudgets(1, 8, 120), maxConversationTokens: 10, summarizeKeepNewest: 1 },
    summarizeFn,
    timeFn,
  });
  assert.ok(outcome.compactionSummarize >= 1);
  const events = conversation.events.filter((e) => e.kind === "tool_result") as Array<{ call_id: string; content: string }>;
  assert.match(events[0]!.content, /\[repository skill \(\.agents\/skills\/app-security\/SKILL\.md\) discarded during context compaction/);
  assert.doesNotMatch(events[0]!.content, /SECRET-SKILL-ADVICE/);
  assert.match(events[1]!.content, /Condensed digest/);
  assert.equal(events.at(-1)!.content, "newest file evidence");
});

test("compaction: the model-generated digest folds old results, newest stay verbatim", async () => {
  const conversation = new Conversation();
  conversation.addUser("x".repeat(500));
  let digestCalls = 0;
  const summaries = ["digest of old results"];
  const { postFn, executeFn, timeFn } = scriptedLoop([openAiText("done")], []);
  const budgets = { ...adaptiveLoopBudgets(1, 8, 120), maxConversationTokens: 10, summarizeKeepNewest: 1 };
  for (let i = 0; i < 3; i++) {
    conversation.addAssistantToolCalls([{ id: `c${i}`, name: "t", arguments: "{}" }]);
    conversation.addToolResult(`c${i}`, `result ${i}`);
  }
  const summarizeFn = (block: string) => {
    digestCalls++;
    assert.match(block, /\[earlier result 1\]/);
    return summaries[0]!;
  };
  const outcome = await driveToolLoop(conversation, postFn, executeFn, { apiFormat: "openai", model: "m", budgets, summarizeFn, timeFn });
  assert.ok(outcome.compactionSummarize >= 1);
  assert.ok(digestCalls >= 1);
  const events = conversation.events.filter((e) => e.kind === "tool_result") as Array<{ call_id: string; content: string }>;
  assert.match(events[0]!.content, /Condensed digest/);
  assert.equal(events.at(-1)!.content, "result 2");
});

test("anthropic tool_use inputs serialise once at the boundary; text blocks ride along", async () => {
  const response = {
    content: [
      { type: "text", text: "thinking" },
      { type: "tool_use", id: "a1", name: "read_file", input: { path: "x", b: 2 } },
    ],
  };
  const { calls, text } = extractToolCalls(response, "anthropic");
  assert.equal(text, "thinking");
  assert.deepEqual(calls, [{ id: "a1", name: "read_file", arguments: '{"b": 2, "path": "x"}' }]);
  // The natural pipeline round-trips into the conversation (text and tool_use
  // ride as separate assistant events; both renderers merge them on the wire).
  const conversation = new Conversation();
  conversation.addAssistantText(text);
  conversation.addAssistantToolCalls(calls);
  const messages = conversation.renderAnthropicMessages() as Array<{ content: Array<Record<string, unknown>> }>;
  assert.deepEqual(messages[0]!.content[0], { type: "text", text: "thinking" });
  assert.deepEqual(messages[1]!.content[0]!.input, { path: "x", b: 2 });
});

test("openai nested function form and fragmentary arguments are preserved", () => {
  const { calls } = extractToolCalls(
    { choices: [{ message: { tool_calls: [{ id: "z", function: { name: "t", arguments: '{"a":' } }] } }] },
    "openai",
  );
  assert.deepEqual(calls, [{ id: "z", name: "t", arguments: '{"a":' }]);
});

test("streamed anthropic turns reassembled into OpenAI shape still yield tool calls", () => {
  const { calls, text } = extractToolCalls(
    {
      choices: [{
        message: {
          role: "assistant",
          content: "Reading.",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "list_tree", arguments: '{"path": "."}' } }],
        },
        finish_reason: "tool_calls",
      }],
    },
    "anthropic",
  );
  assert.equal(text, "Reading.");
  assert.deepEqual(calls, [{ id: "call_1", name: "list_tree", arguments: '{"path": "."}' }]);
});

test("adaptiveLoopBudgets: rounds double and cap at 12 (explicit override, the default 4th arg)", () => {
  assert.equal(adaptiveLoopBudgets(2, 5, 30).maxRounds, 4);
  assert.equal(adaptiveLoopBudgets(6, 5, 30).maxRounds, 12);
  assert.equal(adaptiveLoopBudgets(7, 5, 30).maxRounds, 12);
});

// ---------------------------------------------------------------------------
// #895 — the round cap didn't scale with the #810 size-scaled tool-call
// budget, so reviews were stopping on max-rounds with roughly half the call
// budget unspent. `roundsExplicit: false` is what the harness passes when
// TOOL_MAX_ROUNDS/SMART_TOOL_MAX_ROUNDS was never explicitly set.
// ---------------------------------------------------------------------------

test("#895: a default (non-explicit) config with a 32-call budget yields at least 16 rounds", () => {
  const budgets = adaptiveLoopBudgets(4, 32, 600, false);
  assert.ok(budgets.maxRounds >= 16, `expected >= 16 rounds, got ${budgets.maxRounds}`);
});

test("#895: an explicit TOOL_MAX_ROUNDS override is respected — the call budget does not widen it", () => {
  // Same 32-call budget as above, but the caller resolved maxRounds from an
  // explicit env override: stays at the pre-#895 doubled-and-capped-at-12
  // value, exactly like adaptiveLoopBudgets(4, 32, 600) with no 4th arg.
  const budgets = adaptiveLoopBudgets(4, 32, 600, true);
  assert.equal(budgets.maxRounds, 8);
});

test("#895: the scaled round cap holds at the TOOL_LOOP_ROUNDS_CEILING for a large budget", () => {
  const budgets = adaptiveLoopBudgets(4, 50, 600, false);
  assert.equal(budgets.maxRounds, TOOL_LOOP_ROUNDS_CEILING);
});

test("#895: a small non-explicit budget still gets at least the doubled-rounds floor", () => {
  assert.equal(adaptiveLoopBudgets(4, 6, 600, false).maxRounds, 8); // max(4*2, 6)
});

test("a non-explicit round cap allows one round per tool call", () => {  assert.equal(adaptiveLoopBudgets(4, 24, 600, false).maxRounds, 24);
  assert.equal(adaptiveLoopBudgets(4, 32, 600, false).maxRounds, 32);
});

test("#1043 review: the summarizer request advertises no tools in either wire format", () => {
  // The digest request rides postFn with no executor — a fresh Conversation
  // inherits the global TOOL_SCHEMAS, so the summarizer must clear them and
  // the payload must omit the field entirely (an empty array is still a
  // tools field some providers reject).
  const summarizer = buildSummarizerConversation("compress these results");
  const openai = summarizer.toRequestPayload("openai", "m", { stream: false, maxTokens: 128 }) as Record<string, unknown>;
  assert.equal("tools" in openai, false);
  const anthropic = summarizer.toRequestPayload("anthropic", "m", { stream: false, maxTokens: 128 }) as Record<string, unknown>;
  assert.equal("tools" in anthropic, false);
  assert.match(String(openai.messages ? JSON.stringify(openai.messages) : ""), /compress these results/);
  // Sanity: the default loop conversation still advertises the tool set.
  const loopConversation = new Conversation();
  const loopPayload = loopConversation.toRequestPayload("openai", "m", { stream: false }) as Record<string, unknown>;
  assert.ok(Array.isArray(loopPayload.tools) && (loopPayload.tools as unknown[]).length > 0);
});

// ---------------------------------------------------------------------------
// #1199 — per-round model latency and provider-reported token usage.
// A dedicated telemetry clock (`nowFn`) keeps per-round measurement independent
// of the budget clock, so these tests pin latency without touching the
// scripted wall-clock sequences the reliability tests above rely on.
// ---------------------------------------------------------------------------

function telemetryLoop(
  responses: unknown[],
  execResults: Record<string, unknown>[],
  nowClock: number[],
) {
  let responseIndex = 0;
  let execIndex = 0;
  let nowIndex = 0;
  const postFn = async () => responses[responseIndex++];
  const executeFn = async () => execResults[execIndex++] ?? { tool: "?", status: "error", result: { error: "none" } };
  // Budget clock is held constant so no wall-clock stop fires; per-round
  // latency is measured purely by the separate telemetry clock below.
  const timeFn = () => 0;
  const nowFn = () => nowClock[nowIndex++] ?? Number.MAX_SAFE_INTEGER / 2;
  const rounds: NativeLoopRoundTelemetry[] = [];
  return { postFn, executeFn, timeFn, nowFn, rounds };
}

test("#1199: onRound records one bounded telemetry record per model turn", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const turn1 = {
    ...openAiCall("c1", "read_file", '{"path":"a.ts"}'),
    usage: { prompt_tokens: 18420, completion_tokens: 1330, total_tokens: 19750, prompt_tokens_details: { cached_tokens: 16000 } },
  };
  const turn2 = openAiText("done");
  // nowFn: [telemetryStart, r1 modelStart, modelEnd, toolStart, toolEnd, wall, r2 modelStart, modelEnd, wall]
  const { postFn, executeFn, timeFn, nowFn, rounds } = telemetryLoop(
    [turn1, turn2],
    [{ tool: "read_file", status: "ok", result: { content: "x" } }],
    [0, 1, 13.4, 13.8, 14.2, 15, 15, 18, 18],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 8, 120),
    timeFn,
    nowFn,
    onRound: (r) => rounds.push(r),
  });
  // one record per model turn, matching outcome.rounds (no double counting).
  assert.equal(rounds.length, outcome.rounds);
  assert.equal(rounds.length, 2);
  const r1 = rounds[0]!;
  assert.equal(r1.round, 1);
  assert.equal(r1.model_sec, 12.4);
  assert.equal(r1.prompt_tokens, 18420);
  assert.equal(r1.completion_tokens, 1330);
  assert.equal(r1.cached_tokens, 16000);
  assert.equal(r1.tools_requested, 1);
  assert.equal(r1.tools_executed, 1);
  assert.equal(r1.tools_refused, 0);
  assert.equal(r1.tools_deduplicated, 0);
  assert.equal(r1.tool_elapsed_sec, 0.4);
  assert.equal(r1.requests_remaining, 7);
  assert.equal(r1.rounds_remaining, 7);
  assert.equal(r1.wall_clock_remaining_sec, 105);
  assert.equal(r1.streamed_fallback, false);
  const r2 = rounds[1]!;
  assert.equal(r2.round, 2);
  assert.equal(r2.model_sec, 3);
  // the stop turn reported no usage block → null, never a synthesized number.
  assert.equal(r2.prompt_tokens, null);
  assert.equal(r2.completion_tokens, null);
  assert.equal(r2.cached_tokens, null);
  assert.equal(r2.tools_requested, 0);
  assert.equal(r2.tool_elapsed_sec, 0);
  assert.equal(r2.rounds_remaining, 6);
  assert.equal(r2.wall_clock_remaining_sec, 102);
});

test("#1199: provider usage is accounted in the configured format's convention (Anthropic-shaped body)", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const turn1 = {
    content: [
      { type: "text", text: "thinking" },
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
    ],
    usage: { input_tokens: 500, output_tokens: 40, cache_read_input_tokens: 300 },
  };
  const turn2 = { content: [{ type: "text", text: "done" }] };
  const { postFn, executeFn, timeFn, nowFn, rounds } = telemetryLoop(
    [turn1, turn2],
    [{ tool: "read_file", status: "ok", result: { content: "x" } }],
    [],
  );
  await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "anthropic",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 8, 120),
    timeFn,
    nowFn,
    onRound: (r) => rounds.push(r),
  });
  assert.equal(rounds.length, 2);
  // Anthropic reports the cache read tokens OUTSIDE input_tokens, so the
  // prompt total is 500 + 300 — the same accounting the loop aggregate folds,
  // so the persisted records sum to the aggregate (#1199 derivability).
  assert.equal(rounds[0]!.prompt_tokens, 800);
  assert.equal(rounds[0]!.completion_tokens, 40);
  assert.equal(rounds[0]!.cached_tokens, 300);
  // no telemetry clock → constant → zero latency (not asserted for a real run)
  assert.equal(rounds[0]!.model_sec, 0);
});

test("#1199: a streamed→non-streamed fallback is recorded once, never per wire request", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  let turns = 0;
  const postFn = async (_payload: Record<string, unknown>, turn?: ToolTurnSignal) => {
    turns++;
    turn?.reportFallback(); // the transport seam reports a fallback for this turn
    return turns === 1 ? openAiCall("c1", "read_file", '{"path":"a.ts"}') : openAiText("done");
  };
  const { executeFn, timeFn, nowFn, rounds } = telemetryLoop(
    [],
    [{ tool: "read_file", status: "ok", result: {} }],
    [],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 8, 120),
    timeFn,
    nowFn,
    onRound: (r) => rounds.push(r),
  });
  // two turns → two records (a retried turn does NOT emit a second record).
  assert.equal(rounds.length, outcome.rounds);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0]!.streamed_fallback, true);
  assert.equal(rounds[1]!.streamed_fallback, true);
});

test("#1199: executed + refused + deduplicated always equals requested", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // one valid call, a duplicate of it, and an invalid-argument call.
  const multi = openAiCall("c1", "t", '{"n":1}');
  const mc = (multi as { choices: Array<{ message: { tool_calls: unknown[] } }> }).choices[0]!.message.tool_calls;
  mc.push({ id: "c2", type: "function", function: { name: "t", arguments: '{"n":1}' } });
  mc.push({ id: "c3", type: "function", function: { name: "t", arguments: '{"bad' } });
  const { postFn, executeFn, timeFn, nowFn, rounds } = telemetryLoop(
    [multi, openAiText("done")],
    [{ tool: "t", status: "ok", result: {} }],
    [],
  );
  await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 8, 120),
    timeFn,
    nowFn,
    onRound: (r) => rounds.push(r),
  });
  const r1 = rounds[0]!;
  assert.equal(r1.tools_requested, 3);
  assert.equal(r1.tools_executed, 1);
  assert.equal(r1.tools_deduplicated, 1);
  assert.equal(r1.tools_refused, 1);
  assert.equal(r1.tools_executed + r1.tools_refused + r1.tools_deduplicated, r1.tools_requested);
});

test("#1199: emits exactly one record per turn on a max-rounds stop", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const responses = Array.from({ length: 6 }, (_, i) => openAiCall(`c${i}`, "t", "{}"));
  const exec = responses.map(() => ({ tool: "t", status: "ok", result: {} }));
  const { postFn, executeFn, timeFn, nowFn, rounds } = telemetryLoop(responses, exec, []);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(3, 50, 120),
    timeFn,
    nowFn,
    onRound: (r) => rounds.push(r),
  });
  assert.equal(outcome.stopReason, STOP_MAX_ROUNDS);
  assert.equal(rounds.length, outcome.rounds);
  assert.deepEqual(rounds.map((r) => r.round), [1, 2, 3, 4, 5, 6]);
});

test("#1199: records a transport-error turn as a round without incrementing rounds", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const postFn = async () => { throw new Error("connection reset by peer"); };
  // nowFn: [telemetryStart, modelStart, the catch, the record's wall read]
  const { executeFn, timeFn, nowFn, rounds } = telemetryLoop([], [], [0, 100, 100.5, 100.6]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 8, 120),
    timeFn,
    nowFn,
    onRound: (r) => rounds.push(r),
  });
  assert.equal(outcome.stopReason, STOP_REQUEST_ERROR);
  assert.equal(outcome.error, "connection reset by peer");
  // the errored turn is recorded but does NOT increment outcome.rounds (that
  // count anchors usage.rounds_used, stop reasons, and budget notes) — so the
  // persisted records cover every model turn while rounds stays the count of
  // turns that returned a response.
  assert.equal(outcome.rounds, 0);
  assert.equal(rounds.length, 1);
  const errored = rounds[0]!;
  // 1-based model-turn index: an errored first turn is still round 1.
  assert.equal(errored.round, 1);
  assert.equal(errored.model_sec, 0.5);
  // no response body exists: null usage, never a synthesized number, and no
  // tool activity.
  assert.equal(errored.prompt_tokens, null);
  assert.equal(errored.completion_tokens, null);
  assert.equal(errored.cached_tokens, null);
  assert.equal(errored.tools_requested, 0);
  assert.equal(errored.tools_executed, 0);
  assert.equal(errored.tools_refused, 0);
  assert.equal(errored.tools_deduplicated, 0);
  assert.equal(errored.tool_elapsed_sec, 0);
  assert.equal(errored.requests_remaining, 8);
  // the remaining-budget view for that turn is read on the UNincremented
  // rounds count.
  assert.equal(errored.rounds_remaining, 8);
  assert.equal(errored.streamed_fallback, false);
});

test("#1199: a transport-error turn records the streamed fallback it attempted", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const postFn = async (_payload: Record<string, unknown>, turn?: ToolTurnSignal) => {
    turn?.reportFallback(); // fell back from the streamed attempt before the retry also failed
    throw new Error("reassembly failed");
  };
  // nowFn: [telemetryStart, modelStart, the catch, the record's wall read]
  const { executeFn, timeFn, nowFn, rounds } = telemetryLoop([], [], [0, 7, 7.25, 7.25]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 8, 120),
    timeFn,
    nowFn,
    onRound: (r) => rounds.push(r),
  });
  assert.equal(outcome.stopReason, STOP_REQUEST_ERROR);
  assert.equal(outcome.rounds, 0);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0]!.round, 1);
  assert.equal(rounds[0]!.model_sec, 0.25);
  assert.equal(rounds[0]!.streamed_fallback, true);
});

// #1381 (review): the required-evidence reservation is ENFORCED, not a note.
const REQUIRED_EVIDENCE_OBLIGATIONS = [
  { id: "obligation-1", tokens: ["talos", "kubernetes", "matrix", "machineconfig", "installer", "cluster"] },
];

test("reserved window refuses optional calls and admits the obligation call without losing budget", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Budget 6, reserve 3: turns 1-3 (optional) run while 4+ requests remain;
  // the window then refuses two optional calls WITHOUT consuming budget and
  // admits the matrix fetch, which discharges the gating. The final optional
  // call runs because every obligation was attempted.
  const responses = [
    openAiCall("c1", "read_file", '{"path":"README.md"}'),
    openAiCall("c2", "read_file", '{"path":"docs/arch.md"}'),
    openAiCall("c3", "read_file", '{"path":"docs/history.md"}'),
    openAiCall("c4", "read_file", '{"path":"docs/nope.md"}'),
    openAiCall("c5", "read_file", '{"path":"docs/other.md"}'),
    openAiCall("c6", "web_fetch", '{"url":"https://talos.dev/docs/v1.14/support-matrix"}'),
    openAiCall("c7", "read_file", '{"path":"docs/after.md"}'),
    openAiText("done"),
  ];
  const exec = responses.slice(0, -1).map((_, i) => ({ tool: i === 5 ? "web_fetch" : "read_file", status: "ok", result: { content: String(i) } }));
  const { postFn, executeFn, timeFn } = scriptedLoop(responses, exec);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(10, 6, 120),
    reserveForRequiredEvidence: 3,
    requiredEvidence: REQUIRED_EVIDENCE_OBLIGATIONS,
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_MODEL_DONE);
  assert.deepEqual(outcome.executed.map((item) => [item.tool, (item.args as { path?: string; url?: string }).path ?? (item.args as { url?: string }).url]), [
    ["read_file", "README.md"],
    ["read_file", "docs/arch.md"],
    ["read_file", "docs/history.md"],
    ["web_fetch", "https://talos.dev/docs/v1.14/support-matrix"],
    ["read_file", "docs/after.md"],
  ]);
  assert.equal(outcome.requiredEvidenceRefusals, 2);
  // Two refusals consumed nothing: 6 budget − 5 executed = 1 left.
  assert.equal(outcome.requestsRemaining, 1);
  const toolMessages = conversation.renderOpenAiMessages() as Array<{ role: string; content: string }>;
  assert.ok(toolMessages.filter((m) => m.role === "tool" && m.content.includes("Reserved required-evidence budget")).length === 2);
});

test("a hostile model spending every turn on optional work cannot consume the reserved budget", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const responses = Array.from({ length: 6 }, (_, i) => openAiCall(`c${i}`, "read_file", `{"path":"misc/${i}.md"}`));
  const exec = responses.map(() => ({ tool: "read_file", status: "ok", result: { content: "x" } }));
  const { postFn, executeFn, timeFn } = scriptedLoop(responses, exec);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(3, 6, 120),
    reserveForRequiredEvidence: 3,
    requiredEvidence: REQUIRED_EVIDENCE_OBLIGATIONS,
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_MAX_ROUNDS);
  // Turns 1-3 executed before the window opened; turns 4-6 were refused and
  // the three reserved requests survived intact for the obligation evidence.
  assert.equal(outcome.executed.length, 3);
  assert.equal(outcome.requiredEvidenceRefusals, 3);
  assert.equal(outcome.requestsRemaining, 3);
});

test("schema argument names and non-boundary substrings never satisfy the obligation admission check", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // The obligation names "lockfile". c3 carries only argument-NAME overlap
  // with a generic word, and c4 contains "lockfile" only INSIDE
  // "clockfile.md" — neither may pass the word-boundary admission match.
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [
      openAiCall("c1", "read_file", '{"path":"misc/a.md"}'),
      openAiCall("c2", "read_file", '{"path":"misc/b.md"}'),
      openAiCall("c3", "read_file", '{"path":"docs/guide.md","offset":1,"limit":40}'),
      openAiCall("c4", "read_file", '{"path":"docs/clockfile.md"}'),
      openAiText("done"),
    ],
    [
      { tool: "read_file", status: "ok", result: { content: "a" } },
      { tool: "read_file", status: "ok", result: { content: "b" } },
    ],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(10, 5, 120),
    reserveForRequiredEvidence: 3,
    requiredEvidence: [{ id: "obligation-1", tokens: ["lockfile", "manifest", "schema"] }],
    timeFn,
  });
  assert.deepEqual(outcome.executed.map((item) => (item.args as { path: string }).path), ["misc/a.md", "misc/b.md"]);
  assert.equal(outcome.requiredEvidenceRefusals, 2);
  assert.equal(outcome.requestsRemaining, 3);
});

test("obligation evidence gathered BEFORE the window keeps the window open afterwards", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // The recommended path: the model resolves the obligation EARLY (turn 1),
  // then explores. The window must not re-demand evidence already attempted
  // — every later optional call executes and nothing is refused.
  const responses = [
    openAiCall("c1", "web_fetch", '{"url":"https://talos.dev/docs/v1.14/support-matrix"}'),
    openAiCall("c2", "read_file", '{"path":"docs/a.md"}'),
    openAiCall("c3", "read_file", '{"path":"docs/b.md"}'),
    openAiCall("c4", "read_file", '{"path":"docs/c.md"}'),
    openAiCall("c5", "read_file", '{"path":"docs/d.md"}'),
    openAiText("done"),
  ];
  const exec = responses.slice(0, -1).map(() => ({ tool: "read_file", status: "ok", result: { content: "x" } }));
  const { postFn, executeFn, timeFn } = scriptedLoop(responses, exec);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(10, 6, 120),
    reserveForRequiredEvidence: 3,
    requiredEvidence: REQUIRED_EVIDENCE_OBLIGATIONS,
    timeFn,
  });
  assert.equal(outcome.requiredEvidenceRefusals, 0);
  assert.equal(outcome.executed.length, 5);
  assert.equal(outcome.stopReason, STOP_MODEL_DONE);
});

test("catalog commands get no reserved-window exemption: optional run_command is refused without consuming budget", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // #1388 review: run_command is NOT admissible everywhere inside the
  // reserved window. Its `command` value participates in the same overlap
  // check as every other argument value, so an optional catalog call
  // (git_status_short against a Talos-matrix obligation) is refused WITHOUT
  // consuming budget — the model cannot burn the reserved requests on
  // cheap baseline calls before attempting the obligation.
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [
      openAiCall("c1", "read_file", '{"path":"misc/a.md"}'),
      openAiCall("c2", "read_file", '{"path":"misc/b.md"}'),
      openAiCall("c3", "run_command", '{"command":"git_status_short"}'),
      openAiCall("c4", "list_tree", "{}"),
      openAiCall("c5", "read_file", '{"path":"docs/nope.md"}'),
      openAiText("done"),
    ],
    [
      { tool: "read_file", status: "ok", result: { content: "a" } },
      { tool: "read_file", status: "ok", result: { content: "b" } },
    ],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(10, 5, 120),
    reserveForRequiredEvidence: 3,
    requiredEvidence: REQUIRED_EVIDENCE_OBLIGATIONS,
    timeFn,
  });
  // All three in-window optional calls are refused — the catalog call, a
  // zero-argument call (no target text at all), and a concretely-targeted
  // one — so the reserved requests are fully preserved for the obligation
  // evidence.
  assert.deepEqual(outcome.executed.map((item) => item.tool), ["read_file", "read_file"]);
  assert.equal(outcome.requiredEvidenceRefusals, 3);
  assert.equal(outcome.requestsRemaining, 3);
});

test("a catalog command whose name is the obligation evidence stays admissible and discharges it", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Budget 5, reserve 3: the window is open from the first call, but the
  // catalog command's name overlaps the obligation's vocabulary, so it is
  // admitted, consumes budget, and counts as the obligation's attempt —
  // after which the window is satisfied and optional calls run again.
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [
      openAiCall("c1", "run_command", '{"command":"git_diff_stat"}'),
      openAiCall("c2", "read_file", '{"path":"misc/a.md"}'),
      openAiText("done"),
    ],
    [
      { tool: "run_command", status: "ok", result: { stdout: "M x" } },
      { tool: "read_file", status: "ok", result: { content: "a" } },
    ],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(10, 5, 120),
    reserveForRequiredEvidence: 3,
    requiredEvidence: [{ id: "obligation-1", tokens: ["diff", "stat"] }],
    timeFn,
  });
  assert.deepEqual(outcome.executed.map((item) => item.tool), ["run_command", "read_file"]);
  assert.equal(outcome.requiredEvidenceRefusals, 0);
  assert.equal(outcome.requestsRemaining, 3);
});

// #1388: the reservation pairs reserved REQUESTS with reserved ROUNDS.
test("a complying model stuck on the round ceiling gets extension rounds and spends the reserved requests", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // maxRounds 4 (2×2), budget 8, reserve 2. Rounds 1-2 run optional calls
  // while the window is closed; round 3's optional call is refused by the
  // ROUNDS half of the window; round 4 is the last round the old loop had —
  // it executes the matrix call (progress, one obligation discharged) and
  // the extension buys round 5, where the model spends a reserved request on
  // the remaining obligation and the window discharges (pendingEvidence 0).
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [
      openAiCall("c1", "read_file", '{"path":"misc/a.md"}'),
      openAiCall("c2", "read_file", '{"path":"misc/b.md"}'),
      openAiCall("c3", "read_file", '{"path":"docs/nope.md"}'),
      openAiCall("c4", "web_fetch", '{"url":"https://talos.dev/docs/v1.14/support-matrix"}'),
      openAiCall("c5", "read_file", '{"path":"docs/lockfile.md"}'),
    ],
    [
      { tool: "read_file", status: "ok", result: { content: "a" } },
      { tool: "read_file", status: "ok", result: { content: "b" } },
      { tool: "web_fetch", status: "ok", result: { content: "matrix" } },
      { tool: "read_file", status: "ok", result: { content: "lock" } },
    ],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(2, 8, 120),
    reserveForRequiredEvidence: 2,
    requiredEvidence: [
      { id: "obligation-1", tokens: ["matrix"] },
      { id: "obligation-2", tokens: ["lockfile"] },
    ],
    timeFn,
  });
  // Without the extension the loop stops on max-rounds at 4 with the
  // lockfile request still reserved; with it, round 5 runs.
  assert.equal(outcome.rounds, 5);
  assert.equal(outcome.stopReason, STOP_MAX_ROUNDS);
  assert.deepEqual(outcome.executed.map((item) => (item.args as { path?: string; url?: string }).path ?? (item.args as { url?: string }).url), [
    "misc/a.md",
    "misc/b.md",
    "https://talos.dev/docs/v1.14/support-matrix",
    "docs/lockfile.md",
  ]);
  assert.equal(outcome.requiredEvidenceRefusals, 1);
  assert.equal(outcome.requestsRemaining, 4);
});

test("a hostile model emitting only refused calls inside the window stops at maxRounds with zero extension", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // maxRounds 2 (1×2) and reserve 3: the ROUNDS half of the window is open
  // from the first call, so every optional call is refused. No round ever
  // executes anything, so no ceiling extension is ever earned — the loop
  // stops exactly at maxRounds with every reserved request intact.
  const responses = Array.from({ length: 2 }, (_, i) => openAiCall(`c${i}`, "read_file", `{"path":"misc/${i}.md"}`));
  const { postFn, executeFn, timeFn } = scriptedLoop(responses, []);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(1, 6, 120),
    reserveForRequiredEvidence: 3,
    requiredEvidence: REQUIRED_EVIDENCE_OBLIGATIONS,
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_MAX_ROUNDS);
  assert.equal(outcome.rounds, 2);
  assert.equal(outcome.executed.length, 0);
  assert.equal(outcome.requiredEvidenceRefusals, 2);
  assert.equal(outcome.requestsRemaining, 6);
});

test("round-ceiling extension is hard-bounded at the reservation hint", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // maxRounds 4 (2×2), budget 12, reserve 3 (hint 3) against FOUR
  // obligations. The model keeps making progress (each round executes one
  // obligation-overlapping call while a later obligation stays pending), so
  // extension rounds keep being earned — but never more than `hint` TOTAL:
  // the loop stops at exactly maxRounds + hint (4 + 3 = 7), never round 8.
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [
      openAiCall("c1", "read_file", '{"path":"misc/a.md"}'),
      openAiCall("c2", "read_file", '{"path":"misc/b.md"}'),
      openAiCall("c3", "read_file", '{"path":"docs/nope.md"}'),
      openAiCall("c4", "web_fetch", '{"url":"https://talos.dev/docs/v1.14/support-matrix"}'),
      openAiCall("c5", "read_file", '{"path":"docs/lockfile.md"}'),
      openAiCall("c6", "read_file", '{"path":"docs/manifest.yaml"}'),
      openAiCall("c7", "read_file", '{"path":"docs/changelog.md"}'),
    ],
    [
      { tool: "read_file", status: "ok", result: { content: "a" } },
      { tool: "web_fetch", status: "ok", result: { content: "matrix" } },
      { tool: "read_file", status: "ok", result: { content: "lock" } },
      { tool: "read_file", status: "ok", result: { content: "manifest" } },
      { tool: "read_file", status: "ok", result: { content: "changelog" } },
    ],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(2, 12, 120),
    reserveForRequiredEvidence: 3,
    requiredEvidence: [
      { id: "obligation-1", tokens: ["matrix"] },
      { id: "obligation-2", tokens: ["lockfile"] },
      { id: "obligation-3", tokens: ["manifest"] },
      { id: "obligation-4", tokens: ["changelog"] },
    ],
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_MAX_ROUNDS);
  assert.equal(outcome.rounds, 7);
  assert.ok(outcome.rounds <= 4 + 3, "extension never exceeds the hint");
  assert.deepEqual(outcome.executed.map((item) => (item.args as { path?: string; url?: string }).path ?? (item.args as { url?: string }).url), [
    "misc/a.md",
    "https://talos.dev/docs/v1.14/support-matrix",
    "docs/lockfile.md",
    "docs/manifest.yaml",
    "docs/changelog.md",
  ]);
  assert.equal(outcome.requiredEvidenceRefusals, 2);
  assert.equal(outcome.requestsRemaining, 7);
});

// ── #1379: deterministic dependency-evidence budget prioritization ────────

const depRows = (reserve: number): Array<{ id: string; tokens: readonly string[]; obligation: DependencyEvidenceObligation }> =>
  DEPENDENCY_EVIDENCE_OBLIGATIONS.slice(0, Math.min(DEPENDENCY_EVIDENCE_OBLIGATIONS.length, reserve))
    .map((obligation) => ({ id: obligation, tokens: [], obligation }));

/** Scripted loop that also records every request payload the driver built,
 * so the turn-note ordering the driver owns is observable per round. */
function noteCapturingLoop(responses: unknown[], execResults: Record<string, unknown>[]) {
  let responseIndex = 0;
  let execIndex = 0;
  const payloads: Array<Record<string, unknown>> = [];
  const postFn = async (payload: Record<string, unknown>) => {
    payloads.push(payload);
    return responses[responseIndex++];
  };
  const executeFn = async () =>
    execResults[execIndex++] ?? { tool: "?", status: "error", result: { error: "no scripted result" } };
  const timeFn = () => Number.MAX_SAFE_INTEGER / 2;
  return { postFn, executeFn, timeFn, payloads };
}

function requestTexts(payload: Record<string, unknown>): string {
  const messages = (payload as { messages?: Array<{ content: unknown }> }).messages ?? [];
  return messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
}

test("#1379: reserve injects the priority note before the first request and redirects inside the reserve window", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Budget 6, reserve 4: rounds 1-2 execute outside the window (requestsLeft
  // 5 at round 2, 4 at round 3 — the window opens when the tail is reached);
  // round 3's read_file lands inside the window and is refused, which does
  // not change the notes the earlier requests carried.
  const { postFn, executeFn, timeFn, payloads } = noteCapturingLoop(
    [
      openAiCall("c1", "git_status_short", "{}"),
      openAiCall("c2", "git_diff_stat", "{}"),
      openAiCall("c3", "read_file", '{"path":"a.txt"}'),
      openAiText("done — evidence still unverified"),
    ],
    Array.from({ length: 3 }, () => ({ tool: "t", status: "ok", result: {} })),
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 6, 120),
    timeFn,
    reserveForRequiredEvidence: 4,
    requiredEvidence: depRows(4),
  });
  assert.equal(outcome.stopReason, STOP_MODEL_DONE);
  assert.equal(outcome.requiredEvidenceRequestsHint, 4);
  // Round 0: the priority note precedes ANY tool call — the deterministic
  // ordering rule is driver-owned, not prompt-fragment guidance.
  const firstRequest = requestTexts(payloads[0]!);
  assert.ok(firstRequest.includes("dependency evidence comes first"));
  assert.ok(!firstRequest.includes("reserved"));
  // The round-0 request must not yet carry the regular #701 budget note
  // either (that starts on round 2+, unchanged when no reserve is set).
  assert.ok(!firstRequest.includes("of 6 tool request(s)"));
  // Round 2: requestsLeft (5) is still outside the window — the regular
  // #701 budget note runs unchanged. Turn notes are append-only, so the
  // LAST note in the request is the one this round added.
  const secondRequest = requestTexts(payloads[1]!);
  assert.ok(secondRequest.includes("[loop budget] 5 of 6 tool request(s)"));
  // Round 3: requestsLeft (4) entered the reserve window — the budget note
  // is REPLACED by the dependency-evidence redirect.
  const thirdRequest = requestTexts(payloads[2]!);
  assert.ok(thirdRequest.includes("reserved") && thirdRequest.includes("dependency evidence"));
  const newestNote = (payloads[2]!.messages as Array<{ content: string }>)
    .map((m) => m.content)
    .filter((c) => typeof c === "string" && c.startsWith("[loop budget]"))
    .at(-1)!;
  assert.ok(newestNote.includes("reserved"));
  assert.ok(!newestNote.includes("turn(s) remain"));
  // The redirect names the always-advertised evidence channel and marks
  // web_search conditional (it is offered only with a search endpoint).
  assert.ok(newestNote.includes("web_fetch"));
  assert.match(newestNote, /web_search when that tool is offered/);
});

test("#1379: no reserve keeps the exact legacy note behavior (no priority or reserve notes)", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn, payloads } = noteCapturingLoop(
    [openAiCall("c1", "read_file", '{"path":"a.ts"}'), openAiText("done")],
    [{ tool: "read_file", status: "ok", result: {} }],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 24, 120),
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_MODEL_DONE);
  assert.equal(outcome.requiredEvidenceRequestsHint, 0);
  assert.ok(!requestTexts(payloads[0]!).includes("dependency evidence comes first"));
  // Round 2 (after the first executed call) carries the regular budget note.
  assert.ok(requestTexts(payloads[1]!).includes("[loop budget] 23 of 24 tool request(s)"));
  assert.ok(!requestTexts(payloads[1]!).includes("dependency evidence"));
});

test("#1379: a reserve at the low-budget boundary preempts the generic low-budget note", async () => {
  // Tiny budget (2) with reserve 1: the reserve window opens at
  // requestsLeft <= 1, which is also the generic LOW_TOOL_REQUESTS_REMAINING
  // threshold — the dependency redirect must win the ternary.
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn, payloads } = noteCapturingLoop(
    [openAiCall("c1", "read_file", '{"path":"a.ts"}'), openAiText("done")],
    [{ tool: "read_file", status: "ok", result: {} }],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 2, 120),
    timeFn,
    reserveForRequiredEvidence: 1,
    requiredEvidence: depRows(1),
  });
  assert.equal(outcome.stopReason, STOP_MODEL_DONE);
  // Round 2 (requestsLeft 1): the newest note is the dependency redirect,
  // not the generic "stop broad exploration" low-budget note.
  const newestNote = (payloads[1]!.messages as Array<{ content: string }>)
    .map((m) => m.content)
    .filter((c) => typeof c === "string" && c.startsWith("[loop budget]"))
    .at(-1)!;
  assert.ok(newestNote.includes("reserved"));
  assert.ok(!newestNote.includes("Stop broad exploration"));
});

// ── #1379 review blocker: the reserve is ENFORCED, not just announced ──────

/** Loop whose executor records every (tool, args) it was actually given, so
 * refusals are observable as the calls the executor never saw. */
function recordingLoop(responses: unknown[]) {
  let responseIndex = 0;
  const executedCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const postFn = async () => responses[responseIndex++];
  const executeFn = async (tool: string, args: Record<string, unknown>) => {
    executedCalls.push({ tool, args });
    return { tool, status: "ok", result: {} };
  };
  const timeFn = () => Number.MAX_SAFE_INTEGER / 2;
  return { postFn, executeFn, timeFn, executedCalls };
}

test("#1379: the reserve refuses optional calls inside the window until the obligations are met", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Budget 6, reserve 4: rounds 1-2 execute outside the window (left 6, 5);
  // round 3 requests an optional call inside the window with no evidence
  // attempt yet — the driver refuses it and the reserved requests survive;
  // round 4's web_fetch of release notes covers ONLY release_delta
  // (blocker 5728634290 re-pin: one partial fetch no longer releases the
  // window), so round 5's optional call is still refused.
  const { postFn, executeFn, timeFn, executedCalls } = recordingLoop([
    openAiCall("c1", "git_status_short", "{}"),
    openAiCall("c2", "git_diff_stat", "{}"),
    openAiCall("c3", "read_file", '{"path":"a.ts"}'),
    openAiCall("c4", "web_fetch", '{"url":"https://example.test/releases"}'),
    openAiCall("c5", "git_log", "{}"),
    openAiText("done"),
  ]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 6, 120),
    timeFn,
    reserveForRequiredEvidence: 4,
    requiredEvidence: depRows(4),
  });
  assert.equal(outcome.stopReason, STOP_MODEL_DONE);
  // The refused read_file and git_log never reached the executor; the
  // reserved tail was spent on the evidence call instead of optional
  // archaeology.
  assert.deepEqual(executedCalls.map((c) => c.tool), ["git_status_short", "git_diff_stat", "web_fetch"]);
  assert.ok(outcome.requiredEvidenceAttempts >= 1);
  assert.equal(outcome.requiredEvidenceRefusals, 2);
  // 3 executed of 6: the refusals consumed nothing.
  assert.equal(outcome.requestsRemaining, 3);
  assert.deepEqual(outcome.requiredEvidenceCredits, ["release_delta"]);
  assert.equal(outcome.requiredEvidenceReleased, false);
  // The refusal is a model-facing error result the model can act on.
  const transcript = JSON.stringify(conversation.toRequestPayload("openai", "m", {}));
  assert.ok(transcript.includes("Reserved dependency-evidence budget"));
});

test("#1379: a model that never attempts evidence can never spend the reserved tail", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Budget 6, reserve 4, one optional call per round. Once the window opens
  // every call is refused without executing or spending, so the loop runs
  // out of ROUNDS, not of the request budget: the reserve is fully intact.
  const { postFn, executeFn, timeFn, executedCalls } = recordingLoop([
    openAiCall("c1", "read_file", '{"path":"a.ts"}'),
    openAiCall("c2", "read_file", '{"path":"b.ts"}'),
    openAiCall("c3", "git_log", "{}"),
    openAiCall("c4", "git_blame", "{}"),
    openAiCall("c5", "git_grep", "{}"),
    openAiCall("c6", "find_files", "{}"),
    openAiCall("c7", "list_tree", "{}"),
    openAiCall("c8", "read_file", '{"path":"c.ts"}'),
    openAiText("done"),
  ]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 6, 120),
    timeFn,
    reserveForRequiredEvidence: 4,
    requiredEvidence: depRows(4),
  });
  assert.equal(outcome.stopReason, STOP_MAX_ROUNDS);
  assert.equal(executedCalls.length, 2);
  assert.equal(outcome.requiredEvidenceAttempts, 0);
  assert.equal(outcome.requiredEvidenceRefusals, 6);
  // Blocker 5728634290 re-pin: the per-obligation counters tell the same
  // story — nothing credited, nothing attempted, the window never opened.
  assert.equal(outcome.requiredEvidenceRequired, 3);
  assert.equal(outcome.requiredEvidenceAttempts, 0);
  assert.deepEqual(outcome.requiredEvidenceCredits, []);
  assert.equal(outcome.requiredEvidenceReleased, false);
  // The exact failure this rule exists to prevent no longer happens: budget
  // exhaustion with the required evidence unresolved is impossible while the
  // obligation is unattempted — the tail simply cannot be consumed.
  assert.equal(outcome.requestsRemaining, 4);
  // Every refusal tells the model how to unlock the window: web_fetch, the
  // always-advertised channel (no web_fetch ever executed here, so this text
  // can only come from the refusal note), with web_search named only
  // conditionally.
  const transcript = JSON.stringify(conversation.toRequestPayload("openai", "m", {}));
  assert.ok(transcript.includes("web_fetch"));
  assert.match(transcript, /web_search when that tool is offered/);
});

test("#1379: an evidence call covering every tracked obligation releases the window; a partial one does not", async () => {
  // Blocker 5728634290 re-pin: the early release now comes from CREDITING
  // every tracked obligation, not from any single attempt. One call whose
  // target spans all three obligations (publisher host + security + changelog
  // tokens) releases the window for optional work…
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn, executedCalls } = recordingLoop([
    openAiCall("c1", "web_fetch", '{"url":"https://pypi.org/security/changelog"}'),
    openAiCall("c2", "read_file", '{"path":"a.ts"}'),
    openAiCall("c3", "git_log", "{}"),
    openAiText("done"),
  ]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 6, 120),
    timeFn,
    reserveForRequiredEvidence: 4,
    requiredEvidence: depRows(4),
  });
  assert.equal(outcome.stopReason, STOP_MODEL_DONE);
  // c3 lands inside the window (requestsLeft 4) but every tracked obligation
  // was credited in round 1, so nothing is refused.
  assert.deepEqual(executedCalls.map((c) => c.tool), ["web_fetch", "read_file", "git_log"]);
  assert.ok(outcome.requiredEvidenceAttempts >= 1);
  assert.equal(outcome.requiredEvidenceRefusals, 0);
  assert.deepEqual(outcome.requiredEvidenceCredits, ["provenance", "release_delta", "security_advisory"]);
  assert.equal(outcome.requiredEvidenceReleased, true);

  // …while a single release-notes fetch credits ONLY release_delta: the
  // optional call inside the window is now refused instead of riding the
  // old one-bit release.
  const conversation2 = new Conversation();
  conversation2.addUser("corpus");
  const loop2 = recordingLoop([
    openAiCall("c1", "web_fetch", '{"url":"https://example.test/releases"}'),
    openAiCall("c2", "read_file", '{"path":"a.ts"}'),
    openAiCall("c3", "git_log", "{}"),
    openAiText("done"),
  ]);
  const outcome2 = await driveToolLoop(conversation2, loop2.postFn, loop2.executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 6, 120),
    timeFn,
    reserveForRequiredEvidence: 4,
    requiredEvidence: depRows(4),
  });
  assert.equal(outcome2.stopReason, STOP_MODEL_DONE);
  // c2 executes (requestsLeft 5, outside the window); c3 lands inside it and
  // is refused: provenance and security_advisory are still outstanding.
  assert.deepEqual(loop2.executedCalls.map((c) => c.tool), ["web_fetch", "read_file"]);
  assert.equal(outcome2.requiredEvidenceRefusals, 1);
  assert.deepEqual(outcome2.requiredEvidenceCredits, ["release_delta"]);
  assert.equal(outcome2.requiredEvidenceReleased, false);
});

test("#1379: a failed evidence call still credits its obligation (no lockout)", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // The executor refuses every fetch (e.g. host allowlist). Crediting is
  // attempt-based (blocker 5728634290): each failing fetch still covers the
  // obligations its own target named, so a model that has done what it can
  // is never locked out of the reserved tail.
  let responseIndex = 0;
  const responses = [
    openAiCall("c1", "web_fetch", '{"url":"https://blocked.test/security/changelog"}'),
    openAiCall("c2", "read_file", '{"path":"a.ts"}'),
    openAiCall("c3", "web_fetch", '{"url":"https://blocked.test/homepage"}'),
    openAiCall("c4", "git_log", "{}"),
    openAiText("done"),
  ];
  const executedStatuses: string[] = [];
  const timeFn = () => Number.MAX_SAFE_INTEGER / 2;
  const outcome = await driveToolLoop(
    conversation,
    async () => responses[responseIndex++],
    async (tool: string) => {
      executedStatuses.push(tool);
      return { tool, status: "error", result: { error: "host not allowed" } };
    },
    {
      apiFormat: "openai",
      model: "m",
      budgets: adaptiveLoopBudgets(4, 6, 120),
      timeFn,
      reserveForRequiredEvidence: 4,
      requiredEvidence: depRows(4),
    },
  );
  assert.ok(outcome.requiredEvidenceAttempts >= 1);
  assert.equal(outcome.requiredEvidenceRefusals, 0);
  assert.equal(outcome.executed.length, 4);
  // c1 credited security_advisory + release_delta and c3 credited
  // provenance — all from ERROR-status calls — so the window released and
  // the inside-window optional calls executed anyway.
  assert.equal(outcome.requiredEvidenceAttempts, 2);
  assert.deepEqual(outcome.requiredEvidenceCredits, ["provenance", "release_delta", "security_advisory"]);
  assert.equal(outcome.requiredEvidenceReleased, true);
  assert.deepEqual(executedStatuses, ["web_fetch", "read_file", "web_fetch", "git_log"]);
});

test("#1379: within one round, an evidence call that RELEASES releases later optional calls; the reverse order still refuses", async () => {
  // Evidence FIRST in the same round: both execute (dispositions are decided
  // in call order, so the obligation state flips before the optional call is
  // judged). Blocker 5728634290 re-pin: the fetch must cover EVERY tracked
  // obligation — a partial fetch inside the window no longer releases the
  // later optional call of the same round.
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const responses = [
    openAiCall("c1", "git_status_short", "{}"),
    openAiCall("c2", "git_diff_stat", "{}"),
    {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "c3", type: "function", function: { name: "web_fetch", arguments: '{"url":"https://pypi.org/security/changelog"}' } },
              { id: "c4", type: "function", function: { name: "git_log", arguments: "{}" } },
            ],
          },
        },
      ],
    },
    openAiText("done"),
  ];
  const { postFn, executeFn } = recordingLoop(responses);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 6, 120),
    timeFn: () => Number.MAX_SAFE_INTEGER / 2,
    reserveForRequiredEvidence: 4,
    requiredEvidence: depRows(4),
  });
  assert.equal(outcome.requiredEvidenceRefusals, 0);
  assert.equal(outcome.executed.length, 4);

  // Optional FIRST in the same window round: it is refused (the obligations
  // are unmet at its disposition), and the evidence call in the same round
  // executes.
  const conversation2 = new Conversation();
  conversation2.addUser("corpus");
  const responses2 = [
    openAiCall("c1", "git_status_short", "{}"),
    openAiCall("c2", "git_diff_stat", "{}"),
    {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "c3", type: "function", function: { name: "git_log", arguments: "{}" } },
              { id: "c4", type: "function", function: { name: "web_fetch", arguments: '{"url":"https://pypi.org/security/changelog"}' } },
            ],
          },
        },
      ],
    },
    openAiText("done"),
  ];
  const loop2 = recordingLoop(responses2);
  const outcome2 = await driveToolLoop(conversation2, loop2.postFn, loop2.executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 6, 120),
    timeFn: () => Number.MAX_SAFE_INTEGER / 2,
    reserveForRequiredEvidence: 4,
    requiredEvidence: depRows(4),
  });
  assert.equal(outcome2.requiredEvidenceRefusals, 1);
  assert.deepEqual(loop2.executedCalls.map((c) => c.tool), ["git_status_short", "git_diff_stat", "web_fetch"]);
});

test("#1379: a reserve-refused call retried after an evidence attempt executes (never deduped)", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // The refusal must not poison the dedup set: the exact same optional call,
  // retried once the obligation state advanced (blocker 5728634290 re-pin:
  // the fetch now has to COVER the tracked obligations, not merely be an
  // attempt), runs for real rather than being answered from a note about a
  // call that never executed.
  const { postFn, executeFn, timeFn, executedCalls } = recordingLoop([
    openAiCall("c1", "git_status_short", "{}"),
    openAiCall("c2", "git_diff_stat", "{}"),
    openAiCall("c3", "read_file", '{"path":"a.ts"}'),
    openAiCall("c4", "web_fetch", '{"url":"https://pypi.org/security/changelog"}'),
    openAiCall("c5", "read_file", '{"path":"a.ts"}'),
    openAiText("done"),
  ]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 6, 120),
    timeFn,
    reserveForRequiredEvidence: 4,
    requiredEvidence: depRows(4),
  });
  assert.deepEqual(executedCalls.map((c) => c.tool), ["git_status_short", "git_diff_stat", "web_fetch", "read_file"]);
  assert.equal(outcome.requiredEvidenceRefusals, 1);
  const transcript = JSON.stringify(conversation.toRequestPayload("openai", "m", {}));
  assert.ok(!transcript.includes("Duplicate request"));
});

test("#1379: no reserve keeps every optional call executable in the budget tail", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Same shape as the lockout test but with reserve 0: the legacy loop
  // executes everything to the last request, refusal-free.
  const { postFn, executeFn, timeFn, executedCalls } = recordingLoop([
    openAiCall("c1", "read_file", '{"path":"a.ts"}'),
    openAiCall("c2", "read_file", '{"path":"b.ts"}'),
    openAiCall("c3", "git_log", "{}"),
    openAiText("done"),
  ]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 2, 120),
    timeFn,
  });
  assert.equal(outcome.requiredEvidenceRequestsHint, 0);
  assert.equal(outcome.requiredEvidenceRefusals, 0);
  assert.equal(executedCalls.length, 2);
  assert.equal(outcome.stopReason, STOP_BUDGET);
});

// ── #1379 review blocker 5728634290: per-obligation reserve state ─────────

test("#1379: the reviewer's counterexample — one release-notes fetch no longer unlocks the whole reserved tail", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const executedCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let responseIndex = 0;
  const responses = [
    openAiCall("c1", "read_file", '{"path":"a.ts"}'),
    openAiCall("c2", "git_log", "{}"),
    openAiCall("c3", "web_fetch", '{"url":"https://upstream.test/releases/tag/v1.2.3"}'),
    openAiCall("c4", "read_file", '{"path":"b.ts"}'),
    openAiCall("c5", "git_grep", "{}"),
    openAiCall("c6", "web_fetch", '{"url":"https://osv.dev/vulnerabilities/GHSA-42xa-7z9q"}'),
    openAiCall("c7", "web_fetch", '{"url":"https://github.com/owner/repo"}'),
    openAiCall("c8", "git_diff_stat", "{}"),
    openAiText("done"),
  ];
  // The advisories fetch FAILS (host unreachable): a failing fetch is still
  // an attempt and still credits its obligation.
  const executeFn = async (tool: string, args: Record<string, unknown>) => {
    executedCalls.push({ tool, args });
    if (typeof args.url === "string" && args.url.includes("osv.dev")) {
      return { tool, status: "error", result: { error: "fetch failed" } };
    }
    return { tool, status: "ok", result: {} };
  };
  const outcome = await driveToolLoop(
    conversation,
    async () => responses[responseIndex++],
    executeFn,
    {
      apiFormat: "openai",
      model: "m",
      // Budget 7 (one head request above the 6 the counterexample described,
      // so the released optional call still fits before the ceiling):
      // reserve 4, window opens after 3 executed calls.
      budgets: { ...adaptiveLoopBudgets(4, 7, 120), maxRounds: 20 },
      timeFn: () => Number.MAX_SAFE_INTEGER / 2,
      reserveForRequiredEvidence: 4,
      requiredEvidence: depRows(4),
    },
  );
  // Two optional calls outside the window, then the release-notes fetch
  // (credits ONLY release_delta), then the two refused local-archaeology
  // calls, then the failing advisories fetch (credits security_advisory),
  // then the bare repository root (credits provenance → released), then the
  // optional call that finally executes.
  assert.deepEqual(
    executedCalls.map((c) => `${c.tool}${typeof c.args.path === "string" ? `:${c.args.path}` : ""}`),
    ["read_file:a.ts", "git_log", "web_fetch", "web_fetch", "web_fetch", "git_diff_stat"],
  );
  // The refused calls never reached the executor.
  assert.ok(!executedCalls.some((c) => c.args.path === "b.ts"));
  assert.ok(!executedCalls.some((c) => c.tool === "git_grep"));
  assert.equal(outcome.requiredEvidenceRefusals, 2);
  // The refusals spent nothing: 6 executed of 7.
  assert.equal(outcome.requestsRemaining, 1);
  // Exhaustion while obligations were open is exactly what the enforcement
  // makes unreachable: the loop ends on the model's own hand.
  assert.notEqual(outcome.stopReason, STOP_BUDGET);
  assert.equal(outcome.stopReason, STOP_MODEL_DONE);
  assert.deepEqual(outcome.requiredEvidenceCredits, ["provenance", "release_delta", "security_advisory"]);
  assert.equal(outcome.requiredEvidenceAttempts, 3);
  assert.equal(outcome.requiredEvidenceReleased, true);
});

test("#1379: dependencyEvidenceObligationsForCall attributes a call from its own target", () => {
  // Only the evidence-channel tools attribute at all.
  assert.deepEqual(dependencyEvidenceObligationsForCall("read_file", { url: "https://pypi.org/project/x" }), []);
  assert.deepEqual(dependencyEvidenceObligationsForCall("run_command", { query: "osv" }), []);
  // web_fetch reads args.url, web_search reads args.query; absent/non-string
  // targets attribute nothing.
  assert.deepEqual(dependencyEvidenceObligationsForCall("web_fetch", {}), []);
  assert.deepEqual(dependencyEvidenceObligationsForCall("web_fetch", { url: 42 }), []);
  assert.deepEqual(dependencyEvidenceObligationsForCall("web_search", {}), []);
  assert.deepEqual(dependencyEvidenceObligationsForCall("web_search", { query: "" }), []);
  assert.deepEqual(dependencyEvidenceObligationsForCall("web_fetch", { url: "https://upstream.test/status" }), []);
  // release_delta tokens (and the deep-path pin: a compare page on a source
  // host is a delta lookup, not a provenance root lookup).
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_fetch", { url: "https://upstream.test/releases/tag/v1.2.3" }),
    ["release_delta"],
  );
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_fetch", { url: "https://github.com/owner/repo/compare/v1...v2" }),
    ["release_delta"],
  );
  // security_advisory tokens.
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_fetch", { url: "https://osv.dev/list?q=cve" }),
    ["security_advisory"],
  );
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_fetch", { url: "https://example.test/security/advisories" }),
    ["security_advisory"],
  );
  // provenance via the source host's CANONICAL repository shape: exactly
  // owner/repo on github.com/gitlab.com/bitbucket.org, org/project/_git/repo
  // on dev.azure.com. Trailing slashes and query strings still map to the
  // same repository.
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_fetch", { url: "https://github.com/owner/repo" }),
    ["provenance"],
  );
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_fetch", { url: "https://gitlab.com/owner/repo/" }),
    ["provenance"],
  );
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_fetch", { url: "https://github.com/owner/repo?tab=readme" }),
    ["provenance"],
  );
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_fetch", { url: "https://dev.azure.com/org/project/_git/repo" }),
    ["provenance"],
  );
  // Negative regression (review blocker 5738958165): a profile/user page, a
  // bare source host, and an Azure org/project identify NO repository, so
  // none of them credits provenance — the obligation window cannot release
  // without an owner/repository lookup having been attempted.
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_fetch", { url: "https://gitlab.com/owner" }),
    [],
  );
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_fetch", { url: "https://github.com" }),
    [],
  );
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_fetch", { url: "https://dev.azure.com/org/project" }),
    [],
  );
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_fetch", { url: "https://www.npmjs.com/package/left-pad" }),
    ["provenance"],
  );
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_fetch", { url: "https://artifacthub.io/packages/helm/foo" }),
    ["provenance"],
  );
  // A deeper path on a source host that also names a provenance TOKEN still
  // credits provenance (the keyword list, not the path rule).
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_fetch", { url: "https://example.test/registry" }),
    ["provenance"],
  );
  // Multi-match, projected in canonical order.
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_fetch", { url: "https://pypi.org/security/changelog" }),
    ["provenance", "release_delta", "security_advisory"],
  );
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_search", { query: "is there a CVE or GHSA for the helm chart bump?" }),
    ["provenance", "security_advisory"],
  );
  assert.deepEqual(
    dependencyEvidenceObligationsForCall("web_search", { query: "nginx release notes changelog" }),
    ["release_delta"],
  );
  // Ecosystem registries this repo's own dependency kinds reach for
  // (independent review: rubygems/Maven/ECR lookups credited nothing while
  // npm/PyPI did, so those PRs burned refusals until the attempts cap).
  for (const url of [
    "https://rubygems.org/gems/sidekiq",
    "https://repo1.maven.org/maven2/com/example/lib/",
    "https://search.maven.org/artifact/com.example/lib",
    "https://mvnrepository.com/artifact/com.example/lib",
    "https://maven.google.com/web/index.html",
    "https://packagist.org/packages/vendor/pkg",
    "https://nuget.org/packages/Newtonsoft.Json",
    "https://pub.dev/packages/http",
    "https://registry.terraform.io/providers/hashicorp/kubernetes/latest",
    "https://public.ecr.aws/bitnami/redis",
    "https://gallery.ecr.aws/nginx/nginx",
    "https://us.gcr.io/project/image",
  ]) {
    assert.deepEqual(dependencyEvidenceObligationsForCall("web_fetch", { url }), ["provenance"], url);
  }
});

test("#1379: the attempts cap releases the window even with zero credits (no lockout)", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Reserve 3, three fetches of UNATTRIBUTED hosts INSIDE the enforced
  // window (budget 4 reserves 3, so the window gates from the second
  // disposition on): nothing is credited, but the loop spent the whole
  // reserve on gated evidence attempts, so the cap fires and optional work
  // would execute again. The no-lockout counter counts IN-WINDOW attempts
  // only — see the pre-window counterexample pin below.
  const { postFn, executeFn, timeFn, executedCalls } = recordingLoop([
    openAiCall("c1", "read_file", '{"path":"a.ts"}'),
    openAiCall("c2", "web_fetch", '{"url":"https://unrelated.test/a"}'),
    openAiCall("c3", "web_fetch", '{"url":"https://elsewhere.test/b"}'),
    openAiCall("c4", "web_fetch", '{"url":"https://nowhere.test/c"}'),
    openAiText("done"),
  ]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    // maxToolCalls 4 with reserve 3: the window gates from the second
    // disposition on, so c1 is the only pre-window call and c2-c4 are the
    // three gated attempts the cap counts.
    budgets: adaptiveLoopBudgets(4, 4, 120),
    timeFn,
    reserveForRequiredEvidence: 3,
    requiredEvidence: depRows(3),
  });
  assert.equal(outcome.requiredEvidenceAttempts, 3);
  assert.equal(outcome.requiredEvidenceWindowAttempts, 3);
  assert.deepEqual(outcome.requiredEvidenceCredits, []);
  assert.equal(outcome.requiredEvidenceReleased, true);
  assert.equal(outcome.requiredEvidenceRefusals, 0);
  assert.deepEqual(executedCalls.map((c) => c.tool), ["read_file", "web_fetch", "web_fetch", "web_fetch"]);
  // The third gated attempt fired the cap exactly as the request budget ran
  // out: the window released with zero credits, which is the no-lockout
  // guarantee under the in-window counter.
  assert.equal(outcome.stopReason, STOP_BUDGET);
  assert.equal(outcome.requestsRemaining, 0);
});

test("#1379: the reserve commits only the obligations its tail can pay for", async () => {
  // Reserve 2: tracked = [provenance, release_delta] — a security_advisory
  // is never required at this reserve, and covering the two tracked
  // obligations releases the window.
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn, executedCalls } = recordingLoop([
    openAiCall("c1", "web_fetch", '{"url":"https://github.com/owner/repo"}'),
    openAiCall("c2", "web_fetch", '{"url":"https://upstream.test/releases"}'),
    openAiCall("c3", "read_file", '{"path":"a.ts"}'),
    openAiText("done"),
  ]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 4, 120),
    timeFn,
    reserveForRequiredEvidence: 2,
    requiredEvidence: depRows(2),
  });
  assert.equal(outcome.requiredEvidenceRequired, 2);
  assert.deepEqual(outcome.requiredEvidenceCredits, ["provenance", "release_delta"]);
  // c3 lands inside the window (requestsLeft 2) with every tracked obligation
  // credited — no advisories call needed.
  assert.equal(outcome.requiredEvidenceRefusals, 0);
  assert.equal(outcome.requiredEvidenceReleased, true);
  assert.equal(executedCalls.length, 3);
  assert.equal(outcome.stopReason, STOP_MODEL_DONE);

  // Reserve 1: required 1, and ANY single IN-WINDOW evidence call releases —
  // the historical one-call release is preserved through the attempts cap.
  // The two-round budget puts round 2 inside the window (rounds remaining
  // drop to the reserve), so the unattributed fetch spends the one gated
  // attempt, the cap fires, and the optional read executes again.
  const conversation2 = new Conversation();
  conversation2.addUser("corpus");
  const loop2 = recordingLoop([
    openAiCall("c1", "read_file", '{"path":"pre.ts"}'),
    {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "c2", type: "function", function: { name: "web_fetch", arguments: '{"url":"https://unrelated.test/a"}' } },
              { id: "c3", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
            ],
          },
        },
      ],
    },
    openAiText("done"),
  ]);
  const outcome2 = await driveToolLoop(conversation2, loop2.postFn, loop2.executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(1, 3, 120),
    timeFn,
    reserveForRequiredEvidence: 1,
    requiredEvidence: depRows(1),
  });
  assert.equal(outcome2.requiredEvidenceRequired, 1);
  assert.deepEqual(outcome2.requiredEvidenceCredits, []);
  assert.equal(outcome2.requiredEvidenceAttempts, 1);
  assert.equal(outcome2.requiredEvidenceWindowAttempts, 1);
  assert.equal(outcome2.requiredEvidenceReleased, true);
  assert.equal(outcome2.requiredEvidenceRefusals, 0);
  assert.deepEqual(loop2.executedCalls.map((c) => c.tool), ["read_file", "web_fetch", "read_file"]);
});

test("#1379: redundant same-obligation fetches do not open the window", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Reserve 4, two DIFFERENT release-notes URLs: the second credits nothing
  // new, so provenance and security_advisory stay outstanding and the
  // optional call inside the window is still refused.
  const { postFn, executeFn, timeFn, executedCalls } = recordingLoop([
    openAiCall("c1", "web_fetch", '{"url":"https://upstream.test/releases/tag/v1.0.0"}'),
    openAiCall("c2", "web_fetch", '{"url":"https://upstream.test/releases/tag/v2.0.0"}'),
    openAiCall("c3", "read_file", '{"path":"a.ts"}'),
    openAiText("done"),
  ]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 6, 120),
    timeFn,
    reserveForRequiredEvidence: 4,
    requiredEvidence: depRows(4),
  });
  assert.deepEqual(outcome.requiredEvidenceCredits, ["release_delta"]);
  assert.equal(outcome.requiredEvidenceAttempts, 2);
  assert.equal(outcome.requiredEvidenceReleased, false);
  // c3 lands inside the window (requestsLeft 4) and is refused.
  assert.equal(outcome.requiredEvidenceRefusals, 1);
  assert.deepEqual(executedCalls.map((c) => c.tool), ["web_fetch", "web_fetch"]);
});

test("#1379: requiredEvidenceCredits seeding carries obligations across loops; partial seeds name only the outstanding", async () => {
  // Full seed (the #1145 repair seam handing a continuation an already
  // satisfied obligation set): no refusal at all inside the window.
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn, executedCalls } = recordingLoop([
    openAiCall("c1", "read_file", '{"path":"a.ts"}'),
    openAiCall("c2", "read_file", '{"path":"b.ts"}'),
    openAiCall("c3", "read_file", '{"path":"c.ts"}'),
    openAiText("done"),
  ]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 6, 120),
    timeFn,
    reserveForRequiredEvidence: 4,
    requiredEvidence: depRows(4),
    requiredEvidenceCredits: ["bogus-id", "security_advisory", "release_delta", "provenance", "release_delta", 42 as unknown as string],
  });
  assert.equal(outcome.requiredEvidenceRefusals, 0);
  assert.equal(outcome.requiredEvidenceReleased, true);
  assert.deepEqual(outcome.requiredEvidenceCredits, ["provenance", "release_delta", "security_advisory"]);
  assert.equal(executedCalls.length, 3);

  // Partial seed: provenance is already covered, so the window note/refusal
  // name ONLY the two outstanding obligations and only those calls are
  // still required.
  const conversation2 = new Conversation();
  conversation2.addUser("corpus");
  const loop2 = recordingLoop([
    openAiCall("c1", "read_file", '{"path":"a.ts"}'),
    openAiCall("c2", "read_file", '{"path":"b.ts"}'),
    openAiCall("c3", "read_file", '{"path":"c.ts"}'),
    openAiCall("c4", "web_fetch", '{"url":"https://osv.dev/list"}'),
    openAiCall("c5", "web_fetch", '{"url":"https://upstream.test/releases"}'),
    openAiCall("c6", "read_file", '{"path":"d.ts"}'),
    openAiText("done"),
  ]);
  const outcome2 = await driveToolLoop(conversation2, loop2.postFn, loop2.executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 6, 120),
    timeFn,
    reserveForRequiredEvidence: 4,
    requiredEvidence: depRows(4),
    requiredEvidenceCredits: ["provenance"],
  });
  // c3 lands inside the window and is refused; the refusal names the two
  // outstanding obligations joined with "and" — and NOT the seeded
  // provenance one.
  assert.equal(outcome2.requiredEvidenceRefusals, 1);
  const transcript = JSON.stringify(conversation2.toRequestPayload("openai", "m", {}));
  assert.ok(
    transcript.includes(
      "still owes the exact old-to-new upstream release delta and upstream security advisories",
    ),
  );
  assert.ok(!transcript.includes("owes upstream publisher/source provenance"));
  // After the advisories + release-delta fetches the window releases and the
  // inside-window optional call executes.
  assert.deepEqual(
    loop2.executedCalls.map((c) => `${c.tool}${typeof c.args.path === "string" ? `:${c.args.path}` : ""}`),
    ["read_file:a.ts", "read_file:b.ts", "web_fetch", "web_fetch", "read_file:d.ts"],
  );
  assert.deepEqual(outcome2.requiredEvidenceCredits, ["provenance", "release_delta", "security_advisory"]);
  assert.equal(outcome2.requiredEvidenceReleased, true);
});

test("#1396: the repair seam's attempts cap is run-wide — a continuation never re-gates from a reset zero count", async () => {
  // The #1145 seam threads the main loop's evidence-attempt count and the
  // ORIGINAL unclamped reserve as the cap: the run already spent 3 of its 4
  // reserved attempts, so the continuation holds ONE gated attempt, and once
  // it is spent the window releases RUN-WIDE and the handed tail spends
  // freely. A continuation that reset the count (the pre-fix seam) would
  // re-gate for its own full clamped reserve, refusing the optional read
  // after the cap had already fired run-wide.
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn, executedCalls } = recordingLoop([
    openAiCall("c1", "read_file", '{"path":"a.ts"}'),
    openAiCall("c2", "web_fetch", '{"url":"https://unrelated.test/a"}'),
    openAiCall("c3", "read_file", '{"path":"b.ts"}'),
    openAiText("done"),
  ]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(6, 3, 120),
    timeFn,
    // The seam's clamp: the continuation holds all 3 of its requests inside
    // the reserved tail (run reserve 4, clamped to the 3 handed) — but the
    // CAP stays the original run-wide 4, and the IN-WINDOW attempt count
    // starts at the main loop's 3 (its window already spent 3 gated
    // attempts; its pre-window spend, if any, drains nothing).
    reserveForRequiredEvidence: 3,
    requiredEvidence: depRows(3),
    requiredEvidenceAttemptsPrior: 3,
    requiredEvidenceWindowAttemptsPrior: 3,
    requiredEvidenceAttemptsCap: 4,
  });
  // c1 (optional, in-window) is refused while the run-wide cap has attempts
  // left; c2 spends that one gated attempt; the cap then fires (4 >= 4),
  // releases every shape row, and c3 executes.
  assert.equal(outcome.requiredEvidenceRefusals, 1);
  assert.deepEqual(
    executedCalls.map((c) => c.tool),
    ["web_fetch", "read_file"],
  );
  assert.equal(outcome.requiredEvidenceAttempts, 4);
  assert.equal(outcome.requiredEvidenceWindowAttempts, 4);
  assert.equal(outcome.requiredEvidenceReleased, true);
  assert.deepEqual(outcome.requiredEvidenceCredits, []);
  // And the reverse guard: the same continuation WITHOUT the seam threading
  // (the pre-fix shape — reset count, clamped cap) keeps its own
  // full gated reserve, so the optional read stays refused and only the
  // evidence call executes.
  const conversation2 = new Conversation();
  conversation2.addUser("corpus");
  const loop2 = recordingLoop([
    openAiCall("c1", "read_file", '{"path":"a.ts"}'),
    openAiCall("c2", "web_fetch", '{"url":"https://unrelated.test/a"}'),
    openAiCall("c3", "read_file", '{"path":"b.ts"}'),
    openAiText("done"),
  ]);
  const outcome2 = await driveToolLoop(conversation2, loop2.postFn, loop2.executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(6, 3, 120),
    timeFn,
    reserveForRequiredEvidence: 3,
    requiredEvidence: depRows(3),
  });
  assert.equal(outcome2.requiredEvidenceRefusals, 2);
  assert.deepEqual(
    loop2.executedCalls.map((c) => c.tool),
    ["web_fetch"],
  );
  assert.equal(outcome2.requiredEvidenceAttempts, 1);
  assert.equal(outcome2.requiredEvidenceWindowAttempts, 1);
  assert.equal(outcome2.requiredEvidenceReleased, false);
});

test("#1396 review blocker: pre-window evidence spend cannot deactivate the reserved window", async () => {
  // The filed counterexample, budget 8 / reserve 4: spend the first four
  // requests on repeated release-note/unattributed fetches BEFORE the
  // reserved tail. Under the pre-fix run-wide cap those four attempts alone
  // reached the cap, every remaining shape row deactivated before the tail
  // was scarce, and the reserved window did not gate at all — the tail then
  // went to optional calls while provenance and security stayed unattempted.
  // The no-lockout counter now counts only IN-WINDOW attempts, so the window
  // still gates the tail: the optional read is refused, the reserved
  // requests go to the outstanding evidence, and the cap still fires for a
  // model that spends the whole reserve on gated attempts without a
  // discharge.
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn, executedCalls } = recordingLoop([
    openAiCall("c1", "web_fetch", '{"url":"https://upstream.test/releases/tag/v1.0.0"}'),
    openAiCall("c2", "web_fetch", '{"url":"https://upstream.test/releases/tag/v2.0.0"}'),
    openAiCall("c3", "web_fetch", '{"url":"https://unrelated.test/a"}'),
    openAiCall("c4", "web_fetch", '{"url":"https://unrelated.test/b"}'),
    openAiCall("c5", "read_file", '{"path":"a.ts"}'),
    openAiCall("c6", "web_fetch", '{"url":"https://github.com/owner/repo"}'),
    openAiCall("c7", "web_fetch", '{"url":"https://example.test/security/advisories"}'),
    openAiCall("c8", "read_file", '{"path":"b.ts"}'),
    openAiText("done"),
  ]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: { ...adaptiveLoopBudgets(4, 8, 120), maxRounds: 20 },
    timeFn,
    reserveForRequiredEvidence: 4,
    requiredEvidence: depRows(4),
  });
  // The four pre-window fetches execute freely (the window is not enforcing
  // yet) and count toward the run-wide telemetry only.
  assert.equal(outcome.requiredEvidenceAttempts, 6);
  assert.equal(outcome.requiredEvidenceWindowAttempts, 2);
  // c5 (optional, first in-window call) is REFUSED: provenance and
  // security_advisory are outstanding and the gated patience is untouched.
  assert.equal(outcome.requiredEvidenceRefusals, 1);
  // The tail then pays for the outstanding evidence; once every row is
  // discharged the window opens and the optional read executes.
  assert.deepEqual(
    executedCalls.map((c) => `${c.tool}${typeof c.args.path === "string" ? `:${c.args.path}` : ""}`),
    ["web_fetch", "web_fetch", "web_fetch", "web_fetch", "web_fetch", "web_fetch", "read_file:b.ts"],
  );
  assert.deepEqual(outcome.requiredEvidenceCredits, ["provenance", "release_delta", "security_advisory"]);
  assert.equal(outcome.requiredEvidenceReleased, true);
  assert.equal(outcome.requestsRemaining, 1);
  assert.equal(outcome.stopReason, STOP_MODEL_DONE);
});

test("#1379: the window note names the outstanding obligations and reverts to the budget note after release", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn, payloads } = noteCapturingLoop(
    [
      openAiCall("c1", "read_file", '{"path":"a.ts"}'),
      openAiCall("c2", "read_file", '{"path":"b.ts"}'),
      openAiCall("c3", "web_fetch", '{"url":"https://pypi.org/security/changelog"}'),
      openAiCall("c4", "read_file", '{"path":"c.ts"}'),
      openAiText("done"),
    ],
    Array.from({ length: 4 }, () => ({ tool: "t", status: "ok", result: {} })),
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 6, 120),
    timeFn,
    reserveForRequiredEvidence: 4,
    requiredEvidence: depRows(4),
  });
  assert.equal(outcome.stopReason, STOP_MODEL_DONE);
  const newestNote = (payload: Record<string, unknown>): string =>
    (payload.messages as Array<{ content: string }>)
      .map((m) => m.content)
      .filter((c) => typeof c === "string" && c.startsWith("[loop budget]"))
      .at(-1)!;
  // Round 3 opens the window with nothing credited: the note names ALL
  // three obligation labels.
  const windowNote = newestNote(payloads[2]!);
  assert.ok(windowNote.includes("Only 4 tool request(s) remain"));
  assert.ok(windowNote.includes("upstream publisher/source provenance"));
  assert.ok(windowNote.includes("the exact old-to-new upstream release delta"));
  assert.ok(windowNote.includes("upstream security advisories"));
  // Round 4: the full-coverage fetch released the window, so the note falls
  // back to the ordinary budget status.
  const afterRelease = newestNote(payloads[3]!);
  assert.ok(afterRelease.includes("[loop budget] 3 of 6 tool request(s)"));
  assert.ok(!afterRelease.includes("reserved"));
});

// ── #1396: ONE unified obligation window (review-owned rows + dependency shape rows) ──

/** The harness shape for a dependency-update PR that ALSO carries a
 * trusted-base guidance obligation: the prose row first, then the canonical
 * dependency-evidence shape rows — one row list, one reserve. */
const unifiedRows = (
  reserve: number,
  guidanceTokens: readonly string[] = ["compatibility", "matrix"],
): Array<{ id: string; tokens: readonly string[]; obligation?: DependencyEvidenceObligation }> => [
  { id: "obligation-1", tokens: guidanceTokens },
  ...depRows(reserve),
];

test("#1396: a provenance fetch is admitted against its shape row while prose rows gate everything else (cross-starvation regression)", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Budget 6, reserve 4 (what the harness resolves when the dependency
  // reserve is the larger half of the max). Rounds 1-2 run outside the
  // window; the window then refuses one optional read, admits the bare
  // repository-root fetch (which overlaps NO prose token — #1381's old
  // vocabulary refused exactly this call) and the advisories/releases
  // fetches, each crediting its own row.
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [
      openAiCall("c1", "read_file", '{"path":"docs/a.md"}'),
      openAiCall("c2", "read_file", '{"path":"docs/b.md"}'),
      openAiCall("c3", "read_file", '{"path":"docs/optional.md"}'),
      openAiCall("c4", "web_fetch", '{"url":"https://github.com/owner/repo"}'),
      openAiCall("c5", "web_fetch", '{"url":"https://github.com/owner/repo/security/advisories"}'),
      openAiCall("c6", "web_fetch", '{"url":"https://github.com/owner/repo/releases"}'),
      openAiText("done"),
    ],
    Array.from({ length: 5 }, () => ({ tool: "t", status: "ok", result: {} })),
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 6, 120),
    reserveForRequiredEvidence: 4,
    requiredEvidence: unifiedRows(4),
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_MODEL_DONE);
  assert.deepEqual(outcome.executed.map((item) => [item.tool, (item.args as { path?: string; url?: string; query?: string }).path ?? (item.args as { url?: string }).url ?? (item.args as { query?: string }).query]), [
    ["read_file", "docs/a.md"],
    ["read_file", "docs/b.md"],
    ["web_fetch", "https://github.com/owner/repo"],
    ["web_fetch", "https://github.com/owner/repo/security/advisories"],
    ["web_fetch", "https://github.com/owner/repo/releases"],
  ]);
  // Exactly ONE refusal over the whole run — the optional read — and it is
  // the ONE counter that carries it.
  assert.equal(outcome.requiredEvidenceRefusals, 1);
  // The refusal names what the reserved tail still owes (shape vocabulary)
  // while any shape row is active — the one refusal path.
  const refusalMessages = (conversation.renderOpenAiMessages() as Array<{ role: string; content: string }>)
    .filter((m) => m.role === "tool" && m.content.includes("Reserved dependency-evidence budget"));
  assert.equal(refusalMessages.length, 1);
  assert.ok(refusalMessages[0]!.content.includes("upstream publisher/source provenance"));
  // The mixed-run clause: the prose guidance row gates the SAME window, and
  // the refusal says so instead of pointing only at the dependency debt.
  assert.ok(refusalMessages[0]!.content.includes("Required Review Evidence"));
  // Credits follow ROW ORDER and hold only the discharged shape rows; the
  // prose row stays gating (it discharges on its own vocabulary, pinned by
  // the #1381 prose tests), so the window is NOT yet released.
  assert.deepEqual(outcome.requiredEvidenceCredits, [
    "provenance",
    "release_delta",
    "security_advisory",
  ]);
  assert.equal(outcome.requiredEvidenceRequired, 4);
  assert.equal(outcome.requiredEvidenceReleased, false);
});

test("#1396: a dependency PR carrying both reservation sources gets exactly ONE budget note per round", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn, payloads } = noteCapturingLoop(
    [
      openAiCall("c1", "git_status_short", "{}"),
      openAiCall("c2", "git_diff_stat", "{}"),
      openAiCall("c3", "read_file", '{"path":"docs/optional.md"}'),
      openAiCall("c4", "web_fetch", '{"url":"https://github.com/owner/repo"}'),
      openAiText("done"),
    ],
    Array.from({ length: 4 }, () => ({ tool: "t", status: "ok", result: {} })),
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 6, 120),
    reserveForRequiredEvidence: 4,
    requiredEvidence: unifiedRows(4),
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_MODEL_DONE);
  const noteCount = (payload: Record<string, unknown>): number =>
    ((payload.messages ?? []) as Array<{ content: unknown }>)
      .filter((m) => typeof m.content === "string" && (m.content as string).startsWith("[loop budget]"))
      .length;
  // Turn notes are append-only: request i carries exactly i+1 of them —
  // one note per round, never the two side-by-side reservations produced.
  payloads.forEach((payload, index) => {
    assert.equal(noteCount(payload), index + 1, `request ${index} must carry exactly one note per round`);
  });
  // Round 1 carries the dependency priority note (a shape row is active).
  assert.ok(requestTexts(payloads[0]!).includes("dependency evidence comes first"));
  // Round 3 (inside the window) names the outstanding obligations AND still
  // references the Required Review Evidence section through the one note —
  // the prose row is discharged only by a call overlapping its vocabulary.
  const windowNote = ((payloads[2]!.messages ?? []) as Array<{ content: string }>)
    .map((m) => m.content)
    .filter((c) => typeof c === "string" && c.startsWith("[loop budget]"))
    .at(-1)!;
  assert.ok(windowNote.includes("reserved"));
  assert.ok(windowNote.includes("upstream publisher/source provenance"));
});

test("#1396: a hostile model cannot spend the reserved tail while either family is unattempted", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const responses = Array.from({ length: 6 }, (_, i) => openAiCall(`c${i}`, "read_file", `{"path":"misc/${i}.md"}`));
  const exec = responses.map(() => ({ tool: "read_file", status: "ok", result: { content: "x" } }));
  const { postFn, executeFn, timeFn } = scriptedLoop(responses, exec);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(3, 6, 120),
    reserveForRequiredEvidence: 4,
    requiredEvidence: unifiedRows(4),
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_MAX_ROUNDS);
  // Two optional calls executed before the window opened; the rest were
  // refused without consuming budget, and zero row discharges bought zero
  // extension rounds.
  assert.equal(outcome.executed.length, 2);
  assert.equal(outcome.requiredEvidenceRefusals, 4);
  assert.equal(outcome.requestsRemaining, 4);
  assert.deepEqual(outcome.requiredEvidenceCredits, []);
  assert.equal(outcome.requiredEvidenceAttempts, 0);
  assert.equal(outcome.requiredEvidenceReleased, false);
  assert.equal(outcome.rounds, 6);
});

test("#1396: a window opened by scarce ROUNDS renders the rounds wording, not the requests wording", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Requests are plentiful (24, reserve 4); the SIX-ROUND ceiling is what
  // enters the window at round 3 — the note must name turns, not pretend
  // 22 requests are scarce.
  const { postFn, executeFn, timeFn, payloads } = noteCapturingLoop(
    [
      openAiCall("c1", "read_file", '{"path":"docs/a.md"}'),
      openAiCall("c2", "read_file", '{"path":"docs/b.md"}'),
      openAiCall("c3", "read_file", '{"path":"docs/optional.md"}'),
      openAiText("done"),
    ],
    Array.from({ length: 2 }, () => ({ tool: "read_file", status: "ok", result: {} })),
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(3, 24, 120),
    reserveForRequiredEvidence: 4,
    requiredEvidence: depRows(4),
    timeFn,
  });
  assert.equal(outcome.requiredEvidenceRefusals, 1);
  const newestNote = ((payloads[2]!.messages ?? []) as Array<{ content: string }>)
    .map((m) => m.content)
    .filter((c) => typeof c === "string" && c.startsWith("[loop budget]"))
    .at(-1)!;
  assert.ok(newestNote.includes("Only 4 loop turn(s) remain"));
  assert.ok(newestNote.includes("upstream publisher/source provenance"));
  assert.ok(!newestNote.includes("tool request(s) remain"));
});
