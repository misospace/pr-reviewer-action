import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runToolHarness, buildToolLoopTelemetry, replaceHarnessFindingsSection, verdictHarnessFindingsBody, normalizeToolRequest, buildPlanningContext, accumulateUsage, PLANNING_NOTES, type HarnessDeps, type HarnessResult } from "../src/tools/harness.js";
import type { LoopOutcome } from "../src/tools/loop.js";

function workspace(): { root: string; deps: (overrides?: Partial<HarnessDeps>) => HarnessDeps } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  const env: Record<string, string> = {
    REPO: "o/r",
    AI_BASE_URL: "http://model.test/v1",
    AI_MODEL: "m1",
    AI_API_KEY: "k",
    AI_STREAM: "false",
  };
  const writes: Array<{ name: string; text: string }> = [];
  const base: HarnessDeps = {
    env,
    cwd: root,
    readText: (name) => {
      try {
        return fs.readFileSync(path.join(root, name), "utf8");
      } catch {
        return null;
      }
    },
    exists: (name) => fs.existsSync(path.join(root, name)),
    writeArtifact: (name, text) => {
      writes.push({ name, text });
      fs.writeFileSync(path.join(root, name), text);
    },
    deleteArtifact: (name) => fs.rmSync(path.join(root, name), { force: true }),
    transport: async () => {
      throw new Error("no scripted transport");
    },
    timeFn: () => 0,
  };
  return {
    root,
    deps: (overrides: Partial<HarnessDeps> = {}) => ({ ...base, ...overrides, env: { ...env, ...(overrides.env ?? {}) } }),
  };
}

const openAiText = (content: string) => ({ choices: [{ message: { content } }] });
const withPrompt = { env: { SYSTEM_PROMPT: "You are the reviewer." } };
const openAiCall = (id: string, name: string, args: string) => ({
  choices: [{ message: { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] } }],
});
const validVerdict = (verdict = "approve") => openAiText(
  JSON.stringify({ verdict, review_markdown: "## Review\nLooks fine.", findings: [] }),
);

test("missing corpus aborts pre-loop with the version-1 telemetry shape", async () => {
  const { deps } = workspace();
  const { result } = await runToolHarness(deps());
  assert.equal(result.planning_error, "Missing review-corpus.truncated.md");
  assert.equal(result.mode, "off");
  const telemetry = buildToolLoopTelemetry(result as HarnessResult);
  assert.equal(telemetry!.phase, "pre-loop");
  assert.equal(telemetry!.stop_reason, "harness-abort");
  assert.equal(telemetry!.failure, "missing-corpus");
  assert.equal((telemetry!.usage as Record<string, unknown>).requests_remaining_at_stop, 8);
  assert.equal((telemetry!.budget as Record<string, unknown>).source, "tier-default");
});

test("missing model config aborts pre-loop as missing-config", async () => {
  const { root, deps } = workspace();
  fs.writeFileSync(path.join(root, "review-corpus.truncated.md"), "# PR Diff (truncated)\n+ x");
  const d = deps();
  delete (d.env as Record<string, string>).AI_MODEL;
  const { result } = await runToolHarness(d);
  assert.equal(result.error, "Missing REPO, AI_BASE_URL, or AI_MODEL");
  assert.equal(buildToolLoopTelemetry(result as HarnessResult)!.failure, "missing-config");
});

test("no tool calls degrades to a corpus-only review without a verdict turn", async () => {
  const { root, deps } = workspace();
  fs.writeFileSync(path.join(root, "review-corpus.truncated.md"), "# PR Diff (truncated)\n+ x");
  let transportCalls = 0;
  const { result } = await runToolHarness(deps({
    transport: async () => {
      transportCalls++;
      return openAiText("no tools needed here");
    },
  }));
  assert.equal(result.mode, "native_loop");
  assert.equal(result.native_loop_degraded, "no-tool-calls");
  assert.equal(result.native_loop_verdict_produced, undefined);
  assert.equal(transportCalls, 1); // the single loop turn, no verdict turn
  assert.ok(fs.existsSync(path.join(root, "tool-harness.json")));
  assert.match(fs.readFileSync(path.join(root, "tool-harness.md"), "utf8"), /issued no tool calls/);
});

test("the loop gathers evidence and the in-conversation verdict is produced and validated (#637)", async () => {
  const { root, deps } = workspace();
  fs.writeFileSync(
    path.join(root, "review-corpus.truncated.md"),
    "# PR Diff (truncated)\n+ change\n",
  );
  fs.writeFileSync(path.join(root, "src.ts"), "export const x = 1;\n");
  const scripted = [openAiCall("c1", "read_file", '{"path":"src.ts"}'), openAiText("evidence gathered"), validVerdict()];
  let transportCalls = 0;
  const { result } = await runToolHarness(deps({
    transport: async () => scripted[transportCalls++],
    ...withPrompt,
  }));
  assert.equal(transportCalls, 3);
  assert.equal(result.native_loop_verdict_produced, true);
  assert.equal(result.native_loop_verdict_status, "accepted");
  assert.equal(result.executed_request_count, 1);
  assert.ok(fs.existsSync(path.join(root, "ai-response.primary.json")));
  assert.ok(fs.existsSync(path.join(root, "tool-harness.md")));
  // The telemetry was embedded (and consumed) at artifact-write time — read it
  // back from the artifact, exactly like the downstream aggregator does.
  const artifact = JSON.parse(fs.readFileSync(path.join(root, "tool-harness.json"), "utf8"));
  const telemetry = artifact.tool_loop_telemetry;
  assert.equal(telemetry.phase, "loop");
  assert.equal(telemetry!.stop_reason, "model-stopped");
  assert.equal((telemetry!.verdict as Record<string, unknown>).produced, true);
  // The verdict turn carries the corpus, not the planning context: the harness
  // findings section was substituted and the duplicate section deduped.
  assert.ok(fs.existsSync(path.join(root, "tool-harness.md")));
});

test("an unusable verdict body leaves the produced flag unset so the standard review synthesizes it", async () => {
  const { root, deps } = workspace();
  fs.writeFileSync(path.join(root, "review-corpus.truncated.md"), "# PR Diff (truncated)\n+ change\n");
  const scripted = [openAiCall("c1", "read_file", '{"path":"src.ts"}'), openAiText("summary"), openAiText("this is not json at all")];
  let transportCalls = 0;
  const { result } = await runToolHarness(deps({
    transport: async () => scripted[transportCalls++],
    ...withPrompt,
  }));
  assert.equal(result.native_loop_verdict_produced, undefined);
  assert.equal(result.native_loop_verdict_status, "fallback");
  assert.equal(result.native_loop_verdict_reason, "parse");
  // The standard review call will run: the response artifact is left for it.
  assert.ok(fs.existsSync(path.join(root, "ai-response.primary.json")));
});

test("smart-tier tool failures fall back to the primary review without a smart verdict", async () => {
  const { root, deps } = workspace();
  fs.writeFileSync(path.join(root, "review-corpus.smart.truncated.md"), "# PR Diff (truncated)\n+ change\n");
  const env = {
    TOOL_HARNESS_TIER: "smart",
    REPO: "o/r",
    SMART_BASE_URL: "http://smart.test/v1",
    SMART_MODEL: "smart1",
    SMART_API_KEY: "k",
    AI_STREAM: "false",
  };
  const scripted = [openAiCall("c1", "read_file", '{"path":".env"}')];
  let transportCalls = 0;
  const { result } = await runToolHarness(deps({
    env,
    transport: async () => scripted[transportCalls++],
  }));
  assert.equal(result.native_loop_verdict_status, "fallback");
  assert.equal(result.native_loop_verdict_reason, "tool-error");
  assert.equal(result.mode, "native_loop");
  assert.equal((result.tool_results as Array<Record<string, unknown>>)[0]!.status, "error");
  // The telemetry was embedded (and consumed) at artifact-write time, as in
  // v2 — read it back from the written smart-tier artifact.
  const artifact = JSON.parse(fs.readFileSync(path.join(root, "tool-harness.smart.json"), "utf8"));
  const telemetry = artifact.tool_loop_telemetry;
  assert.equal(telemetry.route, "smart");
  assert.equal(telemetry.escalated, false);
  assert.equal(telemetry.stop_reason, "model-stopped");
  // Never a stale primary harness: the smart run wrote its own artifacts.
  assert.ok(fs.existsSync(path.join(root, "tool-harness.smart.json")));
  assert.ok(!fs.existsSync(path.join(root, "tool-harness.json")));
});

test("smart-tier wall-clock exhaustion stops the loop with the deadline stop reason", async () => {
  const { root, deps } = workspace();
  fs.writeFileSync(path.join(root, "review-corpus.smart.truncated.md"), "# PR Diff (truncated)\n+ change\n");
  const env = {
    TOOL_HARNESS_TIER: "smart",
    REPO: "o/r",
    SMART_BASE_URL: "http://smart.test/v1",
    SMART_MODEL: "smart1",
    SMART_API_KEY: "k",
    AI_STREAM: "false",
    TOOL_LOOP_WALL_CLOCK_SEC: "10",
  };
  let clock = 0;
  let transportCalls = 0;
  const { result } = await runToolHarness(deps({
    env,
    transport: async () => {
      transportCalls++;
      return openAiCall(`c${transportCalls}`, "read_file", '{"path":"a"}');
    },
    timeFn: () => {
      clock += 11;
      return clock;
    },
  }));
  assert.equal(result.stop_reason, "wall-clock-exceeded");
  assert.equal(result.native_loop_error, "smart tool-loop deadline exceeded");
  assert.equal(result.native_loop_verdict_produced, undefined);
});

test("invalid env integers crash loudly like v2's int()", async () => {
  const { deps } = workspace();
  await assert.rejects(
    () => runToolHarness(deps({ env: { TOOL_MAX_RESPONSE_BYTES: "garbage" } })),
    /invalid TOOL_MAX_RESPONSE_BYTES/,
  );
});

test("harness-findings section substitution and tool-request normalization helpers", () => {
  const corpus = "# Tool Harness Findings\nTool harness planning pending.\n\n# PR Diff (truncated)\n+ x";
  const outcome = {
    executed: [{ tool: "read_file", args: { path: "a.ts" }, result: { status: "ok", result: {} } }],
    rounds: 1,
    toolCallsIssued: 1,
    stopReason: "model-stopped",
  } as unknown as LoopOutcome;
  const replaced = replaceHarnessFindingsSection(corpus, verdictHarnessFindingsBody(outcome));
  assert.match(replaced, /# Tool Harness Findings\nThe tool harness ran for this review: 1 tool call\(s\)/);
  assert.ok(replaced.includes("# PR Diff (truncated)"));
  assert.equal(replaceHarnessFindingsSection("# No Sections Here", "body"), "# No Sections Here");
  // Planner-repair tolerance: top-level params promoted, gh_api path alias.
  assert.deepEqual(
    normalizeToolRequest({ tool: "gh_api", path: "repos/o/r/pulls" }),
    { tool: "gh_api", args: { path: "repos/o/r/pulls", endpoint: "repos/o/r/pulls" } },
  );
  assert.deepEqual(normalizeToolRequest({ name: "git_grep", pattern: "x", max_results: 5 }), {
    tool: "git_grep",
    args: { pattern: "x", max_results: 5 },
  });
  assert.deepEqual(normalizeToolRequest("junk"), { tool: "", args: {} });
});

test("planner leads with PR metadata and linked issues and lists what it already holds", () => {
  const { root, deps } = workspace();
  fs.writeFileSync(path.join(root, "classification.json"), '{"pr_kind": "app_code", "risk_flags": []}');
  fs.writeFileSync(path.join(root, "pr.json"), '{"number": 7, "title": "Fix parser", "author": {"login": "dev"}, "body": "Handles empty input.", "files": [{"path": "big"}]}');
  fs.writeFileSync(path.join(root, "linked-issues.md"), "## owner/repo#12\nParser crashes on empty input.\n");
  fs.writeFileSync(path.join(root, "pr.diff.truncated"), "diff --git a/x b/x\n+line\n");
  const { text, truncated } = buildPlanningContext(50000, deps());
  assert.equal(truncated, false);
  const order = ["# Planning Notes", "# PR Metadata", "# PR Classification", "# Linked Issue Context", "# PR Diff (head)"].map((h) => text.indexOf(h));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(order.every((i) => i >= 0));
  assert.match(text, /"title": "Fix parser"/);
  assert.match(text, /"author": "dev"/);
  assert.doesNotMatch(text, /"files"/);
  assert.match(text, /Parser crashes on empty input\./);
  const notes = text.slice(0, text.indexOf("# PR Metadata"));
  assert.ok(notes.startsWith(PLANNING_NOTES + "PR Metadata; PR Classification; "));
  assert.match(notes, /PR Diff \(head\)\.$/m);
});

test("planner related-code excerpt drops files without symbol or test references", () => {
  const { root, deps } = workspace();
  fs.writeFileSync(path.join(root, "classification.json"), '{"pr_kind": "app_code"}');
  const stub = "- Symbols: none\n- Tests: none\n- Manifests (nearest first): `package.json`\n";
  let body = "# Related Code (v1)\n\n## Changed Files\n\n### `src/app.py`\n\n- `main`: no references\n\n";
  for (let i = 0; i < 200; i++) body += "### `fixtures/" + i + ".json`\n\n" + stub + "\n";
  fs.writeFileSync(path.join(root, "related-code.truncated.md"), body);
  fs.writeFileSync(path.join(root, "pr.diff.truncated"), "diff --git a/x b/x\n+line\n");
  const { text } = buildPlanningContext(50000, deps());
  assert.match(text, /### `src\/app\.py`/);
  assert.doesNotMatch(text, /fixtures\/3\.json/);
  assert.match(text, /200 changed file\(s\) with no symbol or test references omitted/);
});

test("usage accounting reads the OpenAI shape a streamed anthropic turn reassembles into", () => {
  const acc = { requests: 0, prompt_tokens: 0, completion_tokens: 0, cached_prompt_tokens: 0 };
  accumulateUsage(acc, { usage: { prompt_tokens: 10, completion_tokens: 4 } }, "anthropic");
  accumulateUsage(acc, { usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 2 } }, "anthropic");
  assert.deepEqual(acc, { requests: 2, prompt_tokens: 15, completion_tokens: 5, cached_prompt_tokens: 2 });
});
