/** #1598/#1585: bounded evidence-phase failover — when the primary native
 * tool loop stops on a provider/transport failure with ZERO executed
 * investigation calls, the fallback lane runs its own native investigation
 * before its verdict is accepted. Engine-level scenarios run through
 * `runReview` with mock HTTP transports (no live model calls). */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { runReview } from "../src/run/review.js";
import { fallbackEvidenceFailoverEligible } from "../src/engine/review.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import { startMockServer, sseResponse } from "./helpers.js";

function mockPlatform(): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: () => {
      return Promise.resolve({
        number: 7,
        title: "Update README",
        body: "",
        state: "open",
        draft: false,
        head: { sha: "a".repeat(40), ref: "feature" },
        base: { ref: "main" },
        user: { login: "someone" },
        changed_files: 1,
        additions: 4,
        deletions: 1,
        html_url: "https://github.com/o/r/pull/7",
      });
    },
    getPrDiff: () => {
      return Promise.resolve("diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n");
    },
    listPrFiles: () => {
      return Promise.resolve({ ok: true, data: [{ filename: "README.md", status: "modified", additions: 4, deletions: 1, changes: 5 }] });
    },
    getIssue: () => Promise.resolve({ ok: false, error: "not served" }),
    listPrConversationComments: () => Promise.resolve({ ok: true, data: [] }),
    listReviewThreads: () => Promise.resolve({ ok: true, data: [] }),
    listPrReviewsPaginated: () => Promise.resolve({ ok: true, data: [] }),
    listIssueComments: () => Promise.resolve([]),
    listPrReviews: () => Promise.resolve([]),
    repoPermission: () => Promise.resolve(null),
    authenticatedIdentity: () => Promise.resolve(null),
    ghApi: () => Promise.resolve({ error: "not served" }),
    externalChecks: () => Promise.resolve([]),
  } as unknown as PlatformReadAdapter;
}

function verdictBody(verdict: Record<string, unknown>): string {
  return JSON.stringify({
    id: "c1",
    object: "chat.completion",
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(verdict) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  });
}

function baseVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: "approve",
    review_markdown: "Looks fine.\n",
    smart_review_requested: false,
    smart_review_reason: null,
    findings: [],
    requirement_coverage: null,
    required_check_dispositions: [],
    ...overrides,
  };
}

const openAiText = (content: string): Record<string, unknown> => ({
  id: "c1", object: "chat.completion", model: "m",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const openAiToolCall = (id: string, name: string, args: string): Record<string, unknown> => ({
  id: "c2", object: "chat.completion", model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] }, finish_reason: "tool_calls" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

/** The SSE-chunk wire shape an OpenAI-format streaming response carries for
 * one full-content delta, then the closing finish chunk with usage. */
function openAiStreamChunks(content: string): string[] {
  return [
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "fallback-m", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "fallback-m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}`,
    "data: [DONE]",
  ];
}

function withRunDir(): { runDir: string; cleanup: () => void } {
  const runDir = mkdtempSync(join(tmpdir(), "v3-fb-harness-test-"));
  return { runDir, cleanup: (): void => rmSync(runDir, { recursive: true, force: true }) };
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"], { cwd: dir });
}

interface LaneServers {
  primary: Awaited<ReturnType<typeof startMockServer>>;
  fallback: Awaited<ReturnType<typeof startMockServer>>;
}

/** A LiteLLM/MiniMax-shaped quota-exhaustion 429 body — the shape the
 * terminal-failure classifier recognizes (#1080), matching the #1585 repro. */
const MINIMAX_429_BODY = JSON.stringify({
  error: {
    message: "minimax: Token Plan usage limit reached. Upgrade your token plan or purchase credits to continue.",
    code: 2056,
    type: "rate_limit_error",
  },
});

/** A primary lane that 429s everything, and a fallback lane scripted through
 * the native-loop shape (tool turn → investigation end → verdict). */
async function failingPrimaryNativeFallback(): Promise<LaneServers> {
  const primary = await startMockServer((_req, _body, res) => {
    res.statusCode = 429;
    res.end(MINIMAX_429_BODY);
  });
  let fallbackToolTurns = 0;
  const fallback = await startMockServer((_req, body, res) => {
    const payload = JSON.parse(String(body)) as { tools?: unknown[] };
    res.setHeader("Content-Type", "application/json");
    if (Array.isArray(payload.tools) && payload.tools.length > 0) {
      fallbackToolTurns += 1;
      res.end(JSON.stringify(
        fallbackToolTurns === 1
          ? openAiToolCall("t1", "read_file", '{"path":"README.md"}')
          : openAiText("fallback investigation complete"),
      ));
      return;
    }
    res.end(verdictBody(baseVerdict({ review_markdown: "FALLBACK-VERDICT-1598 marker.\n" })));
  });
  return { primary, fallback };
}

function failoverInputs(primary: string, fallback: string): Record<string, string> {
  return {
    "github-token": "tok", repo: "o/r", "pr-number": "7",
    "ai-base-url": primary, "ai-model": "primary-m", "ai-api-key": "primary-key",
    "ai-fallback-base-url": fallback, "ai-fallback-model": "fallback-m", "ai-fallback-api-key": "fallback-key",
    "ai-api-format": "openai", "ai-stream": "false",
    "ai-primary-retries": "0", "ai-primary-retry-delay-sec": "0",
    "tool-mode": "native_loop", "deep-review": "false",
  };
}

test("#1585: a primary transport failure with zero executed calls runs the fallback evidence loop on the fallback lane", async () => {
  const { primary, fallback } = await failingPrimaryNativeFallback();
  const { runDir, cleanup } = withRunDir();
  const errors: string[] = [];
  try {
    writeFileSync(join(runDir, "README.md"), "FALLBACK-EVIDENCE-1598 marker\n");
    gitInit(runDir);
    const result = await runReview({
      env: { IS_FORK_PR: "false", GITHUB_STEP_SUMMARY: join(runDir, "step-summary.md") },
      inputs: failoverInputs(primary.url, fallback.url),
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      sleep: async () => {},
      error: (line) => { errors.push(line); },
      quiet: true,
    });

    // The fallback loop's in-conversation verdict IS the published review.
    assert.match(result.outputs.reviewMarkdown, /FALLBACK-VERDICT-1598/);
    assert.match(result.outputs.analysisEngine, /fallback/);

    // The primary harness degraded on the transport failure with no evidence.
    const primaryHarness = JSON.parse(readFileSync(join(runDir, "tool-harness.json"), "utf8")) as Record<string, unknown>;
    assert.equal(primaryHarness.native_loop_degraded, "request-error");
    assert.equal(primaryHarness.executed_request_count, 0);
    assert.equal(primaryHarness.dispatched_call_count, 0, "the degraded primary dispatched no call at all");

    // The fallback harness ran the investigation on the FALLBACK lane.
    const fallbackHarness = JSON.parse(readFileSync(join(runDir, "tool-harness.fallback.json"), "utf8")) as Record<string, unknown>;
    assert.equal(fallbackHarness.tier, "fallback");
    assert.equal(fallbackHarness.stop_reason, "model-stopped");
    assert.equal(fallbackHarness.native_loop_verdict_status, "accepted");
    assert.ok((fallbackHarness.executed_request_count as number) >= 1, "the fallback loop must execute its investigation call");
    assert.ok(existsSync(join(runDir, "ai-response.fallback.json")));

    // The fallback requests dialed the fallback lane's endpoint/model/key.
    assert.ok(fallback.requests.length >= 3, `expected loop turns + verdict, got ${fallback.requests.length}`);
    assert.ok(fallback.requests.every((request) => request.headers.authorization === "Bearer fallback-key"));
    for (const request of fallback.requests) {
      const payload = JSON.parse(request.body) as Record<string, unknown>;
      assert.equal(payload.model, "fallback-m", "the fallback loop must send the fallback lane's model");
    }
    // No futile further primary attempts: the harness turn's bounded
    // same-request retries plus one corpus call — and no more.
    assert.ok(primary.requests.length <= 4, `expected bounded primary attempts, got ${primary.requests.length}`);
    const fallbackLine = errors.find((line) => line.includes("trying fallback"));
    assert.ok(fallbackLine, `expected the pre-fallback line, got:\n${errors.join("\n")}`);
    assert.match(fallbackLine!, /terminal=quota_exhausted; bypassing retries; trying fallback: fallback-m @/);

    // On the accepted-verdict fast path the on-disk fallback corpus is the
    // pre-harness planning corpus (the harness findings section carries the
    // pre-investigation notice, exactly like the smart escalation's #969
    // prebuild); the evidence-folding rebuild serves the corpus-review path.
    const fallbackCorpus = readFileSync(join(runDir, "review-corpus.fallback.truncated.md"), "utf8");
    assert.ok(fallbackCorpus.includes("Fallback tool investigation omitted"), "the pre-harness planning corpus carries the omission notice");

    // The published coverage state reflects the FALLBACK evidence — never
    // the stale primary degraded claim.
    const coverage = JSON.parse(readFileSync(join(runDir, "review-coverage.json"), "utf8")) as Record<string, unknown>;
    assert.equal(coverage.enforcement_harness, "tool-harness.fallback.json");
    assert.equal(coverage.partial_coverage, null);
    assert.ok(String(result.outputs.toolCalls).includes('"tier":"fallback"'), "the tool-calls output must reflect the fallback tier");

    // The step summary carries the additive fallback harness row.
    const summary = readFileSync(join(runDir, "step-summary.md"), "utf8");
    assert.ok(summary.includes("| Fallback tools |"), `summary missing the fallback tools row:\n${summary}`);
    assert.ok(!summary.includes("| Smart tools |"), "no smart escalation ran");
  } finally {
    await primary.close();
    await fallback.close();
    cleanup();
  }
});

test("#1598: a primary loop that gathers evidence never triggers the fallback harness", async () => {
  let primaryTurns = 0;
  const primary = await startMockServer((_req, body, res) => {
    const payload = JSON.parse(String(body)) as { tools?: unknown[] };
    primaryTurns += 1;
    res.setHeader("Content-Type", "application/json");
    if (Array.isArray(payload.tools) && payload.tools.length > 0) {
      res.end(JSON.stringify(primaryTurns === 1 ? openAiToolCall("t1", "read_file", '{"path":"README.md"}') : openAiText("primary investigation complete")));
      return;
    }
    res.end(verdictBody(baseVerdict({ review_markdown: "PRIMARY-VERDICT-1598.\n" })));
  });
  let fallbackRequests = 0;
  const fallback = await startMockServer((_req, _body, res) => {
    fallbackRequests += 1;
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict({ review_markdown: "unused fallback.\n" })));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    writeFileSync(join(runDir, "README.md"), "primary evidence\n");
    gitInit(runDir);
    const result = await runReview({
      env: { IS_FORK_PR: "false" },
      inputs: failoverInputs(primary.url, fallback.url),
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      sleep: async () => {},
      quiet: true,
    });
    assert.match(result.outputs.reviewMarkdown, /PRIMARY-VERDICT-1598/);
    assert.ok(!existsSync(join(runDir, "tool-harness.fallback.json")), "no fallback harness may run when the primary gathered evidence");
    assert.equal(fallbackRequests, 0, "the fallback lane must never be dialed");
  } finally {
    await primary.close();
    await fallback.close();
    cleanup();
  }
});

test("#1598: partial primary evidence (executed calls with a request-error stop) never triggers the fallback harness", async () => {
  let primaryTurns = 0;
  const primary = await startMockServer((_req, _body, res) => {
    primaryTurns += 1;
    res.setHeader("Content-Type", "application/json");
    if (primaryTurns === 1) {
      res.end(JSON.stringify(openAiToolCall("t1", "read_file", '{"path":"README.md"}')));
      return;
    }
    res.statusCode = 429;
    res.end('{"error":{"message":"rate limited"}}');
  });
  const fallbackBodies: string[] = [];
  const fallback = await startMockServer((_req, body, res) => {
    fallbackBodies.push(String(body));
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict({ review_markdown: "FALLBACK-CORPUS-1598.\n" })));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    writeFileSync(join(runDir, "README.md"), "partial evidence\n");
    gitInit(runDir);
    const result = await runReview({
      env: { IS_FORK_PR: "false" },
      inputs: failoverInputs(primary.url, fallback.url),
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      sleep: async () => {},
      quiet: true,
    });
    assert.match(result.outputs.reviewMarkdown, /FALLBACK-CORPUS-1598/);
    const primaryHarness = JSON.parse(readFileSync(join(runDir, "tool-harness.json"), "utf8")) as Record<string, unknown>;
    assert.equal(primaryHarness.stop_reason, "request-error");
    assert.equal(primaryHarness.executed_request_count, 1, "the primary loop executed its first call before the failure");
    assert.ok(!existsSync(join(runDir, "tool-harness.fallback.json")), "a fallback that only replaces the verdict call must not rerun the investigation when evidence exists");
    for (const body of fallbackBodies) {
      const payload = JSON.parse(body) as { tools?: unknown[] };
      assert.ok(!Array.isArray(payload.tools) || payload.tools.length === 0, "the fallback lane must only run the corpus review, never a second tool loop");
    }
  } finally {
    await primary.close();
    await fallback.close();
    cleanup();
  }
});

test("#1598: a FAILED primary tool call followed by a transport error is recorded as a dispatched call and never triggers the fallback harness", async () => {
  // The spend signal is the DISPATCHED count, not the success-only one: the
  // primary's only call FAILED (so `executed_request_count` stays 0), and the
  // run then died on a transport error. A trigger that read the success-only
  // count would read this as "zero executed calls".
  //
  // The guard that blocks the failover here is the DEGRADED-flag check (the
  // model issued a call, so the loop did not degrade) — the production
  // harness cannot emit "degraded AND dispatched a call". The count guard
  // itself is pinned directly by the predicate test below, which injects
  // that exact shape.
  let primaryTurns = 0;
  const primary = await startMockServer((_req, _body, res) => {
    primaryTurns += 1;
    res.setHeader("Content-Type", "application/json");
    if (primaryTurns === 1) {
      // A read of a file that does not exist: the executor fails it.
      res.end(JSON.stringify(openAiToolCall("t1", "read_file", '{"path":"missing-file.txt"}')));
      return;
    }
    res.statusCode = 429;
    res.end('{"error":{"message":"rate limited"}}');
  });
  const fallbackBodies: string[] = [];
  const fallback = await startMockServer((_req, body, res) => {
    fallbackBodies.push(String(body));
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict({ review_markdown: "FALLBACK-CORPUS-1598.\n" })));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    writeFileSync(join(runDir, "README.md"), "failed-call evidence\n");
    gitInit(runDir);
    const result = await runReview({
      env: { IS_FORK_PR: "false" },
      inputs: failoverInputs(primary.url, fallback.url),
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      sleep: async () => {},
      quiet: true,
    });
    assert.match(result.outputs.reviewMarkdown, /FALLBACK-CORPUS-1598/);
    const primaryHarness = JSON.parse(readFileSync(join(runDir, "tool-harness.json"), "utf8")) as Record<string, unknown>;
    assert.equal(primaryHarness.stop_reason, "request-error");
    assert.equal(primaryHarness.executed_request_count, 0, "the failed call is not a successful execution");
    assert.equal(primaryHarness.dispatched_call_count, 1, "the failed call was still dispatched — and paid for");
    assert.equal(primaryHarness.native_loop_degraded, undefined, "the loop issued a call, so it did not degrade");
    assert.equal(fallbackEvidenceFailoverEligible(primaryHarness), false, "a paid-for primary call is never eligible for the failover");
    assert.ok(!existsSync(join(runDir, "tool-harness.fallback.json")), "a paid-for primary call must never be followed by a second investigation on the fallback lane");
    for (const body of fallbackBodies) {
      const payload = JSON.parse(body) as { tools?: unknown[] };
      assert.ok(!Array.isArray(payload.tools) || payload.tools.length === 0, "the fallback lane must only run the corpus review, never a second tool loop");
    }
  } finally {
    await primary.close();
    await fallback.close();
    cleanup();
  }
});

test("#1598: the failover trigger needs the primary's DISPATCHED call count, not its successful one", async () => {
  // The guard is the trigger's whole contract, so pin it directly: a
  // transport-degraded primary that dispatched a call (the successful-execution
  // count reads 0) is NOT eligible, an artifact that does not report the
  // dispatched count is unknown (never eligible), and only a transport-degraded
  // primary with zero dispatched calls is.
  assert.equal(
    fallbackEvidenceFailoverEligible({ native_loop_degraded: "request-error", dispatched_call_count: 0, executed_request_count: 0 }),
    true,
    "a transport failure with zero dispatched calls is the #1585 failover shape",
  );
  assert.equal(
    fallbackEvidenceFailoverEligible({ native_loop_degraded: "request-error", dispatched_call_count: 1, executed_request_count: 0 }),
    false,
    "a dispatched-but-failed call was paid for — the failover must not restart the investigation",
  );
  assert.equal(
    fallbackEvidenceFailoverEligible({ native_loop_degraded: "request-error", executed_request_count: 0 }),
    false,
    "an artifact without the dispatched count is unknown — fail closed",
  );
  assert.equal(
    fallbackEvidenceFailoverEligible({ native_loop_degraded: "wall-clock-exceeded", dispatched_call_count: 0 }),
    false,
    "a deadline stop is not a transport failure",
  );
  assert.equal(
    fallbackEvidenceFailoverEligible({ native_loop_degraded: "model-stopped", dispatched_call_count: 0 }),
    false,
    "an ordinary model stop is not a transport failure",
  );
  assert.equal(fallbackEvidenceFailoverEligible(null), false, "no primary harness means no failover");
});

test("#1598: a budget-exhausted primary stop never triggers the fallback harness", async () => {
  let primaryTurns = 0;
  const primary = await startMockServer((_req, _body, res) => {
    primaryTurns += 1;
    res.setHeader("Content-Type", "application/json");
    if (primaryTurns === 1) {
      res.end(JSON.stringify(openAiToolCall("t1", "read_file", '{"path":"README.md"}')));
      return;
    }
    if (primaryTurns === 2) {
      // The closing verdict turn returns an unusable body, so the review
      // proceeds to the (failing) standard corpus call and then the fallback.
      res.end(JSON.stringify(openAiText("not a verdict")));
      return;
    }
    res.statusCode = 429;
    res.end('{"error":{"message":"rate limited"}}');
  });
  const fallback = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict({ review_markdown: "FALLBACK-CORPUS-1598.\n" })));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    writeFileSync(join(runDir, "README.md"), "budget evidence\n");
    gitInit(runDir);
    const result = await runReview({
      env: { IS_FORK_PR: "false" },
      inputs: { ...failoverInputs(primary.url, fallback.url), "tool-max-requests": "1" },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      sleep: async () => {},
      quiet: true,
    });
    assert.match(result.outputs.reviewMarkdown, /FALLBACK-CORPUS-1598/);
    const primaryHarness = JSON.parse(readFileSync(join(runDir, "tool-harness.json"), "utf8")) as Record<string, unknown>;
    assert.equal(primaryHarness.budget_exhausted, true);
    assert.ok((primaryHarness.executed_request_count as number) >= 1);
    assert.ok(!existsSync(join(runDir, "tool-harness.fallback.json")), "a budget-exhaustion stop is not a transport failure; no fallback harness runs");
  } finally {
    await primary.close();
    await fallback.close();
    cleanup();
  }
});

test("#1598: a wall-clock-exhausted primary stop never triggers the fallback harness", async () => {
  // The #1338 conversion rewrites a request-error that lands past the loop's
  // wall-clock deadline into `wall-clock-exceeded` before the artifact is
  // written — a deadline stop is not a transport failure, so the failover
  // must not fire even with zero executed calls.
  const primary = await startMockServer(async (_req, _body, res) => {
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    res.statusCode = 400;
    res.end('{"error":{"message":"bad request"}}');
  });
  const fallback = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict({ review_markdown: "FALLBACK-CORPUS-1598.\n" })));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    writeFileSync(join(runDir, "README.md"), "wall clock evidence\n");
    gitInit(runDir);
    const result = await runReview({
      env: { IS_FORK_PR: "false" },
      inputs: { ...failoverInputs(primary.url, fallback.url), "tool-loop-wall-clock-sec": "10" },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      sleep: async () => {},
      quiet: true,
    });
    assert.match(result.outputs.reviewMarkdown, /FALLBACK-CORPUS-1598/);
    const primaryHarness = JSON.parse(readFileSync(join(runDir, "tool-harness.json"), "utf8")) as Record<string, unknown>;
    assert.equal(primaryHarness.native_loop_degraded, "wall-clock-verdict-reserve");
    assert.equal(primaryHarness.executed_request_count, 0);
    assert.ok(!existsSync(join(runDir, "tool-harness.fallback.json")), "a deadline stop is not a transport failure; no fallback harness runs");
    for (const request of fallback.requests) {
      const payload = JSON.parse(request.body) as { tools?: unknown[] };
      assert.ok(!Array.isArray(payload.tools) || payload.tools.length === 0, "the fallback lane must only run the corpus review, never a second tool loop");
    }
  } finally {
    await primary.close();
    await fallback.close();
    cleanup();
  }
});

test("#1598: a fork-gated run never runs the fallback evidence harness", async () => {
  const { primary, fallback } = await failingPrimaryNativeFallback();
  const { runDir, cleanup } = withRunDir();
  try {
    writeFileSync(join(runDir, "README.md"), "fork evidence\n");
    gitInit(runDir);
    const result = await runReview({
      env: { IS_FORK_PR: "true" },
      inputs: failoverInputs(primary.url, fallback.url),
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      sleep: async () => {},
      quiet: true,
    });
    assert.match(result.outputs.reviewMarkdown, /FALLBACK-VERDICT-1598/, "the fallback corpus/native path still reviews");
    const primaryHarness = JSON.parse(readFileSync(join(runDir, "tool-harness.json"), "utf8")) as Record<string, unknown>;
    assert.equal(primaryHarness.skipped, true, "the fork gate skipped the primary harness");
    assert.ok(!existsSync(join(runDir, "tool-harness.fallback.json")), "the fork privilege separation must not gain a second tool loop through failover");
  } finally {
    await primary.close();
    await fallback.close();
    cleanup();
  }
});

test("#1598: the fallback corpus review after a failed fallback verdict carries the fallback loop's evidence", async () => {
  const primary = await startMockServer((_req, _body, res) => {
    res.statusCode = 429;
    res.end(MINIMAX_429_BODY);
  });
  let fallbackToolTurns = 0;
  let fallbackRequests = 0;
  const fallback = await startMockServer((_req, body, res) => {
    const payload = JSON.parse(String(body)) as { tools?: unknown[] };
    fallbackRequests += 1;
    res.setHeader("Content-Type", "application/json");
    if (Array.isArray(payload.tools) && payload.tools.length > 0) {
      fallbackToolTurns += 1;
      res.end(JSON.stringify(
        fallbackToolTurns === 1
          ? openAiToolCall("t1", "read_file", '{"path":"README.md"}')
          : openAiText("fallback investigation complete"),
      ));
      return;
    }
    // The fallback loop's closing verdict turn (request 3) returns an
    // unusable body, so the standard fallback corpus review (request 4)
    // synthesizes the verdict — from the corpus rebuilt WITH the harness's
    // evidence.
    if (fallbackRequests <= 3) {
      res.end(JSON.stringify(openAiText("not a verdict")));
      return;
    }
    res.end(verdictBody(baseVerdict({ review_markdown: "FALLBACK-VERDICT-1598.\n" })));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    writeFileSync(join(runDir, "README.md"), "FALLBACK-EVIDENCE-1598 marker\n");
    gitInit(runDir);
    const result = await runReview({
      env: { IS_FORK_PR: "false" },
      inputs: failoverInputs(primary.url, fallback.url),
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      sleep: async () => {},
      quiet: true,
    });
    assert.match(result.outputs.reviewMarkdown, /FALLBACK-VERDICT-1598/);
    assert.match(result.outputs.analysisEngine, /fallback/);
    const fallbackHarness = JSON.parse(readFileSync(join(runDir, "tool-harness.fallback.json"), "utf8")) as Record<string, unknown>;
    assert.equal(fallbackHarness.native_loop_verdict_status, "fallback", "the fallback loop's verdict turn failed");
    assert.ok((fallbackHarness.executed_request_count as number) >= 1, "the fallback loop still gathered evidence");
    const fallbackCorpus = readFileSync(join(runDir, "review-corpus.fallback.truncated.md"), "utf8");
    assert.ok(
      fallbackCorpus.includes("FALLBACK-EVIDENCE-1598 marker"),
      "the rebuilt fallback corpus must fold the fallback loop's gathered evidence",
    );
    assert.ok(!fallbackCorpus.includes("Fallback tool investigation omitted"), "the rebuild replaces the pre-harness omission notice");
  } finally {
    await primary.close();
    await fallback.close();
    cleanup();
  }
});

test("#1598: the fallback loop rides the fallback lane's stream setting and reasoning effort", async () => {
  const primary = await startMockServer((_req, _body, res) => {
    res.statusCode = 429;
    res.end(MINIMAX_429_BODY);
  });
  const fallback = await startMockServer((req, _body, res) => {
    // The streamed body must still carry the verdict JSON contract, so the
    // fallback review (loop degraded → corpus review) parses.
    sseResponse(openAiStreamChunks(JSON.stringify(baseVerdict({ review_markdown: "FALLBACK-STREAM-1598.\n" }))))(req, _body, res);
  });
  const { runDir, cleanup } = withRunDir();
  try {
    writeFileSync(join(runDir, "README.md"), "stream evidence\n");
    gitInit(runDir);
    const result = await runReview({
      env: { IS_FORK_PR: "false" },
      inputs: {
        ...failoverInputs(primary.url, fallback.url),
        "ai-fallback-stream": "true",
        "ai-fallback-reasoning-effort": "low",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      sleep: async () => {},
      quiet: true,
    });
    assert.match(result.outputs.reviewMarkdown, /FALLBACK-STREAM-1598/);
    assert.match(result.outputs.analysisEngine, /fallback/);
    const fallbackRequests = fallback.requests;
    assert.ok(fallbackRequests.length >= 2, `expected the fallback loop turn + fallback review, got ${fallbackRequests.length}`);
    for (const request of fallbackRequests) {
      const payload = JSON.parse(request.body) as Record<string, unknown>;
      assert.equal(payload.stream, true, "the fallback lane's stream=true must reach the fallback loop and review");
      assert.equal(payload.reasoning_effort, "low", "the fallback lane's effort must reach the loop and review");
    }
    for (const request of primary.requests) {
      const payload = JSON.parse(request.body) as Record<string, unknown>;
      assert.equal(payload.stream, false, "the primary lane keeps the global stream=false");
      assert.equal(payload.reasoning_effort, undefined, "the primary lane never carries the fallback effort");
    }
  } finally {
    await primary.close();
    await fallback.close();
    cleanup();
  }
});
