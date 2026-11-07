import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { runReview } from "../src/run/review.js";
import { publishReview } from "../src/publish/publish.js";
import { startMockServer } from "./helpers.js";
import type { MockServer } from "./helpers.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import type { NativeReviewRequest, NativeReviewSurface, PublishCommentRef, PublishPlatformApi, PublishReviewRef } from "../src/platform/publish-api.js";

// #1488 canary. The native loop's in-conversation verdict occasionally
// re-serialized the whole review and dropped the requirement_coverage rows —
// the verdict came back with `requirement_coverage: null` even though the
// evidence had been found. #1503 replaced the old whole-verdict refresh with
// a trace-gap probe: a bounded evidence-repair round gathers the evidence,
// then a single trace-only turn asks the SAME conversation for just the
// missing claims and merges them into the standing verdict. These two
// canaries pin both ends of that recovery against the same two-requirement
// ledger: (1) when the trace-only repair supplies every claim, the dropped
// coverage is recovered and the approval converges to a clean review; (2)
// when both the trace-only repair and the standalone fallback return no
// claims, the dropped coverage fails closed and the approval is withheld.
// The helpers below are self-contained copies of the ones in run.test.ts
// (mockPlatform, baseVerdict, the OpenAI wire builders, the fragment-id
// extractor, gitInit) so this file never imports across test files.

function mockPlatform(options: { diff?: string; files?: unknown[]; title?: string; body?: string; additions?: number; deletions?: number; threads?: unknown[] } = {}): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: () => {
      return Promise.resolve({
        number: 7,
        title: options.title ?? "Update README",
        body: options.body ?? "",
        state: "open",
        draft: false,
        head: { sha: "a".repeat(40), ref: "feature" },
        base: { ref: "main" },
        user: { login: "someone" },
        changed_files: options.files?.length ?? 1,
        additions: options.additions ?? 4,
        deletions: options.deletions ?? 1,
        html_url: "https://github.com/o/r/pull/7",
      });
    },
    getPrDiff: () => {
      return Promise.resolve(options.diff ?? `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n`);
    },
    listPrFiles: () => {
      return Promise.resolve({ ok: true, data: options.files ?? [{ filename: "README.md", status: "modified", additions: 4, deletions: 1, changes: 5 }] });
    },
    getIssue: () => Promise.resolve({ ok: false, error: "not served" }),
    listPrConversationComments: () => Promise.resolve({ ok: true, data: [] }),
    listReviewThreads: () => Promise.resolve({ ok: true, data: options.threads ?? [] }),
    listPrReviewsPaginated: () => Promise.resolve({ ok: true, data: [] }),
    listIssueComments: () => Promise.resolve([]),
    listPrReviews: () => Promise.resolve([]),
    repoPermission: () => Promise.resolve(null),
    authenticatedIdentity: () => Promise.resolve(null),
    ghApi: () => Promise.resolve({ error: "not served" }),
    externalChecks: () => Promise.resolve([]),
  } as unknown as PlatformReadAdapter;
}

/** The same linked-issue PR, but the issue body carries TWO MUST lines, so
 * the ledger holds two in-scope requirements the trace-only repair can fill
 * (or, in the #1488 shape, fail to fill). */
function twoRequirementTracePlatform(): PlatformReadAdapter {
  const platform = mockPlatform({ body: "Closes #824.\n\nResolve review context from the right identity.\n" });
  platform.getIssue = async () => ({
    ok: true,
    data: {
      number: 824,
      title: "resolve review context from repository identity",
      state: "open",
      html_url: "https://github.com/o/r/issues/824",
      labels: [],
      body: "Context resolution MUST bind to the repository identity plus the source SHA.\n"
        + "The publish gate MUST compare the publish timestamp against the gate timestamp.\n",
    },
  }) as never;
  return platform;
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

interface RunFixture {
  runDir: string;
  cleanup: () => void;
}

function withRunDir(): RunFixture {
  const runDir = mkdtempSync(join(tmpdir(), "v3-trace-canary-"));
  return { runDir, cleanup: (): void => rmSync(runDir, { recursive: true, force: true }) };
}

/** The native loop only reads tracked files: make the run dir a checkout. */
function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"], { cwd: dir });
}

function openAiText(content: string): Record<string, unknown> {
  return { id: "c1", object: "chat.completion", model: "primary-m", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}

function openAiToolCall(id: string, name: string, args: string): Record<string, unknown> {
  return { id: "c2", object: "chat.completion", model: "primary-m", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}

/** Two parallel read_file calls in one turn — the effective turn (round)
 * ceiling is smaller than the request ceiling, so the investigation spends
 * TWO calls per turn and the CALL ceiling is what binds (stop_reason
 * `tool-call-budget-exhausted`, the #1488 shape). */
function openAiToolCallPair(idA: string, pathA: string, idB: string, pathB: string): Record<string, unknown> {
  return {
    id: "c2", object: "chat.completion", model: "primary-m",
    choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [
      { id: idA, type: "function", function: { name: "read_file", arguments: `{"path":${JSON.stringify(pathA)}}` } },
      { id: idB, type: "function", function: { name: "read_file", arguments: `{"path":${JSON.stringify(pathB)}}` } },
    ] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** The requirement id the requirement-trace fragment rendered for its
 * `- req-… (normative, …): <text>` line containing `marker` — the shape the
 * native-loop planning turn carries (the JSON-escaped body keeps each
 * fragment line backslash-free). */
function traceFragmentId(requestBody: string, marker: string): string {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(String.raw`req-([0-9a-f]{12}) \([^)]*\): [^\\]*` + escaped).exec(requestBody);
  assert.ok(match, `no trace-fragment id rendered for marker ${JSON.stringify(marker)}`);
  return `req-${match[1]}`;
}

/** A minimal review_verdict-mode publish API: only what submitNativeReview
 * and the publication-boundary head re-check touch. */
class MinimalPublishApi implements PublishPlatformApi {
  readonly platform = "github" as const;
  readonly nativeReviewSurface: NativeReviewSurface = { supported: true };
  submitted: NativeReviewRequest[] = [];
  constructor(private readonly head: string) {}
  async getHeadSha(): Promise<string | null> { return this.head; }
  async listIssueComments(): Promise<PublishCommentRef[]> { return []; }
  async upsertStickyComment(): Promise<{ ok: boolean; created: boolean }> { return { ok: true, created: true }; }
  async listReviews(): Promise<PublishReviewRef[]> { return []; }
  async listManagedInlineComments() { return { supported: true, complete: true, comments: [] }; }
  async retireInlineComment() { return true; }
  async createReview(request: NativeReviewRequest): Promise<{ ok: boolean }> { this.submitted.push(request); return { ok: true }; }
  async dismissReview(): Promise<boolean> { return true; }
  async minimizedReviewIds(): Promise<string[]> { return []; }
  async minimizeReview(): Promise<boolean> { return true; }
  async unresolvedSupersededThreads(): Promise<{ ok: boolean; threads: { id: string }[]; hasNextPage: boolean }> {
    return { ok: true, threads: [], hasNextPage: false };
  }
  async resolveThread(): Promise<boolean> { return true; }
  async removeLabel(): Promise<boolean> { return true; }
  async requestReviewers(): ReturnType<PublishPlatformApi["requestReviewers"]> {
    return { ok: true, supported: true, requestedUsers: [], requestedTeams: [], alreadyRequestedUsers: [], alreadyRequestedTeams: [] };
  }
}

/** Pipe the finished run through the publication boundary exactly the way
 * the composite wiring does (run.test.ts's #873 template), so the canary
 * pins the event the run is ELIGIBLE for — native APPROVE vs COMMENT. */
async function publishRun(result: Awaited<ReturnType<typeof runReview>>): Promise<MinimalPublishApi> {
  const api = new MinimalPublishApi("a".repeat(40));
  const published = await publishReview({
    mode: "review_verdict",
    reviewMarkdown: result.outputs.reviewMarkdown,
    verdict: result.outputs.verdict,
    verdictPolicy: result.verdictPolicy,
    analysisEngine: result.outputs.analysisEngine,
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    prNumber: "7",
    commentMarker: "<!-- ai-pr-review -->",
    requiredChecks: result.outputs.requiredChecks,
    ...(result.requiredEvidenceState !== undefined ? { requiredEvidenceState: result.requiredEvidenceState } : {}),
    reviewRoute: result.outputs.reviewRoute,
    escalationReason: result.outputs.escalationReason,
    cacheHitRatio: result.outputs.cacheHitRatio,
    inlineFindings: false,
    inlineFindingsMax: 5,
    findings: JSON.parse(result.outputs.findings),
    cleanupPreviousNativeReviews: "false",
    allowApprove: true,
    approveForks: false,
    isForkPr: false,
    upstreamLinkMode: "inert",
    conditionalPresence: {
      linkedIssue: false, evidenceProvider: false, standards: false,
      toolHarnessFindings: false, toolHarnessResults: false,
    },
    forgejoPositions: false,
  }, api, { diffText: "" });
  assert.equal(published.status, "published");
  return api;
}

/** The checkout both tests share: two normative requirements, each with a
 * real comparison line (the cited predicate) and a regression test, plus the
 * PR's README diff the loop reads first. */
function writeTraceWorkspace(runDir: string): void {
  mkdirSync(join(runDir, "src"), { recursive: true });
  mkdirSync(join(runDir, "tests"), { recursive: true });
  writeFileSync(
    join(runDir, "src", "context-resolution.ts"),
    [
      "export function resolveContext(ctx, record) {",
      "  if (record.sourceSha !== ctx.sourceSha) {",
      "    throw new Error('source sha mismatch');",
      "  }",
      "  return record;",
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(runDir, "src", "publish-gate.ts"),
    [
      "export function checkPublishGate(record, ctx) {",
      "  if (record.publishTimestamp !== ctx.gateTimestamp) {",
      "    throw new Error('publish timestamp mismatch');",
      "  }",
      "  return record;",
      "}",
    ].join("\n"),
  );
  writeFileSync(join(runDir, "tests", "context-resolution.test.ts"), "test('placeholder', () => {});\n");
  writeFileSync(join(runDir, "tests", "publish-gate.test.ts"), "test('placeholder', () => {});\n");
  writeFileSync(join(runDir, "README.md"), "hello\nworld\n");
  // Unrelated tracked files the investigation burns its call ceiling on —
  // the #1488 shape: the ordinary loop spends every request on general
  // exploration and never discharges the trace rows before the verdict.
  for (let i = 1; i <= 7; i += 1) {
    mkdirSync(join(runDir, "docs"), { recursive: true });
    writeFileSync(join(runDir, "docs", `explore-0${i}.md`), `explore note ${i}\n`);
  }
  gitInit(runDir);
}

interface TraceServerState {
  idFirst: string;
  idSecond: string;
  standaloneRequests: number;
  unexpected: string[];
}

/** One lane serving the whole native-loop conversation. Tools-carrying
 * requests are scripted positionally: eight reads burning the configured
 * call ceiling (the loop then stops on the ceiling, not on a model stop),
 * then the bounded repair round's read and its stop text. Tool-less
 * requests are discriminated by their marker: the in-conversation trace-only
 * repair turn ("Requirement ids to trace:"), the standalone fallback
 * ("Requirements to trace:"), and the in-conversation verdict (everything
 * else). */
async function startTraceServer(mode: "positive" | "negative"): Promise<{ server: MockServer; state: TraceServerState }> {
  const state: TraceServerState = { idFirst: "", idSecond: "", standaloneRequests: 0, unexpected: [] };
  let toolTurn = 0;
  const server = await startMockServer((_req, body, res) => {
    const text = String(body);
    res.setHeader("Content-Type", "application/json");
    const request = JSON.parse(text) as { tools?: unknown[] };
    if (Array.isArray(request.tools) && request.tools.length > 0) {
      const scripted = [
        // The ordinary investigation burns the FULL configured ceiling (8)
        // without ever serializing the trace, and stops on the ceiling — not
        // on the model's own stop. The reserved tail (#1506) admits the
        // trace-targeted reads, so the evidence IS in the conversation by
        // the end — the production #1488 finding was that the review prose
        // showed the evidence had been found and the verdict STILL dropped
        // the coverage rows.
        openAiToolCallPair("c1", "README.md", "c2", "docs/explore-01.md"),
        openAiToolCallPair("c3", "docs/explore-02.md", "c4", "docs/explore-03.md"),
        openAiToolCallPair("c5", "src/context-resolution.ts", "c6", "src/publish-gate.ts"),
        openAiToolCallPair("c7", "tests/context-resolution.test.ts", "c8", "tests/publish-gate.test.ts"),
        // The bounded trace-repair continuation (4 dedicated calls): one
        // targeted read, then the model stops the repair rounds.
        openAiToolCall("c9", "read_file", '{"path":"docs/explore-04.md"}'),
        openAiText("repair round done"),
      ];
      const response = scripted[toolTurn];
      toolTurn += 1;
      if (response === undefined) {
        state.unexpected.push(text.slice(0, 200));
        res.statusCode = 500;
        res.end('{"error":"script exhausted (tools)"}');
        return;
      }
      // Extract the two ledger ids from the FIRST planning turn's trace
      // fragment (the corpus carries the ids in the `- req-… (…):` shape on
      // the native-loop planning turn).
      if (toolTurn === 1) {
        state.idFirst = traceFragmentId(text, "repository identity plus the source SHA");
        state.idSecond = traceFragmentId(text, "publish timestamp against the gate timestamp");
      }
      res.end(JSON.stringify(response));
      return;
    }
    if (text.includes("Requirement ids to trace:")) {
      // The in-conversation trace-only repair turn (#1503). NOTE: the
      // standalone retry message (buildTraceRepairRetryMessage) carries the
      // same heading — unreachable here because the scripted standalone
      // payload parses, so no serialization retry is ever issued.
      if (mode === "positive") {
        const payload = {
          requirement_coverage: [
            {
              requirement_id: state.idFirst,
              disposition: "met",
              enforcement: [{ file: "src/context-resolution.ts", line: 2 }],
              test: [{ file: "tests/context-resolution.test.ts", line: 1 }],
              reason: "compares record.sourceSha against ctx.sourceSha and throws on mismatch",
            },
            {
              requirement_id: state.idSecond,
              disposition: "met",
              enforcement: [{ file: "src/publish-gate.ts", line: 2 }],
              test: [{ file: "tests/publish-gate.test.ts", line: 1 }],
              reason: "compares record.publishTimestamp against ctx.gateTimestamp and throws on mismatch",
            },
          ],
        };
        res.end(JSON.stringify(openAiText("```json\n" + JSON.stringify(payload) + "\n```")));
      } else {
        // The #1488 serialization failure: the turn produced no claim.
        res.end(JSON.stringify(openAiText('{"requirement_coverage":[]}')));
      }
      return;
    }
    if (text.includes("Requirements to trace:")) {
      // The standalone repair pass (#959/#1504 fallback).
      state.standaloneRequests += 1;
      res.end(JSON.stringify(openAiText('{"requirement_coverage":[]}')));
      return;
    }
    // The in-conversation verdict: coverage dropped to null (the #1488 shape).
    res.end(JSON.stringify(openAiText(JSON.stringify(baseVerdict()))));
  });
  return { server, state };
}

test("#1488 canary: a native-loop verdict that drops requirement coverage converges to a clean approval when the trace-gap probe's bounded repair supplies every claim", async () => {
  const { server, state } = await startTraceServer("positive");
  const { runDir, cleanup } = withRunDir();
  try {
    writeTraceWorkspace(runDir);
    const result = await runReview({
      env: { IS_FORK_PR: "false" },
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7",
        "ai-base-url": server.url, "ai-model": "primary-m", "ai-api-key": "k",
        "ai-stream": "false", "review-routing-mode": "off",         "tool-mode": "native_loop",
        // Configured investigation ceiling. Production ran #1488's starvation
        // on the default 40; the canary pins the same shape on a small
        // deterministic ceiling — the failure mode is "reached the configured
        // ceiling", not the number 40.
        "tool-max-requests": "8", "deep-review": "false",
        "verdict-policy": "model", "ai-connect-timeout-sec": "2", "ai-request-timeout-sec": "5",
        "ci-status-check": "false", "requirement-trace": "true",
      },
      runDir,
      workspace: runDir,
      platformAdapter: twoRequirementTracePlatform(),
      persistArtifacts: true,
      sleep: async () => {},
      quiet: true,
    });
    assert.equal(state.unexpected.length, 0, `unscripted model requests: ${JSON.stringify(state.unexpected)}`);
    assert.ok(state.idFirst && state.idSecond, "both ledger ids extracted from the planning corpus");

    // (1) The ordinary investigation reached the CONFIGURED call ceiling —
    // the #1488 exhaustion shape — instead of stopping on its own.
    const harness = JSON.parse(readFileSync(join(runDir, "tool-harness.json"), "utf8")) as {
      stop_reason?: string;
      executed_request_count?: number;
      partial_coverage?: unknown;
      trace_repair_continuation?: {
        outcome?: string; claims_merged?: number; trace_claims_merged?: boolean;
        unresolved_ids?: string[]; tool_calls?: number;
      };
    };
    assert.equal(harness.stop_reason, "tool-call-budget-exhausted");
    // 8 calls to the configured ceiling, plus the one bounded repair read
    // (the continuation's executed calls join the run's total).
    assert.equal(harness.executed_request_count, 9);

    // (2) Execution coverage itself is otherwise adequate: the budget stop
    // left no strictly-unread changed file, and the post-repair recomputation
    // records no partial coverage either.
    assert.equal(harness.partial_coverage, undefined);

    // (2-4) The probe's bounded repair round ran on EXACTLY the two omitted
    // ids and executed its targeted read.
    assert.equal(harness.trace_repair_continuation?.outcome, "continued");
    assert.deepEqual(harness.trace_repair_continuation?.unresolved_ids, [state.idFirst, state.idSecond]);
    assert.ok((harness.trace_repair_continuation?.tool_calls ?? 0) >= 1, "the repair round executed its bounded targeted read");
    // (5-6) The trace-only turn returned valid claims for both ids and they
    // merged into the standing verdict.
    assert.equal(harness.trace_repair_continuation?.claims_merged, 2);
    assert.equal(harness.trace_repair_continuation?.trace_claims_merged, true);

    // Suppression: the standalone fallback never issued a request once the
    // in-conversation repair had merged claims and left nothing missing.
    assert.equal(state.standaloneRequests, 0, "the standalone repair pass must not run after a merged native-loop repair");
    const persisted = JSON.parse(readFileSync(join(runDir, "ai-output.json"), "utf8")) as {
      requirement_trace_repair?: { attempted: boolean; outcome: string; route?: string; claims: number; missing_ids: string[] };
    };
    assert.equal(persisted.requirement_trace_repair?.attempted, false);
    assert.equal(persisted.requirement_trace_repair?.outcome, "no_missing_ids");
    assert.equal(persisted.requirement_trace_repair?.route, "primary");
    assert.equal(persisted.requirement_trace_repair?.claims, 0);
    assert.deepEqual(persisted.requirement_trace_repair?.missing_ids, []);

    // The convergence: every in-scope requirement is met, so the coverage
    // gate is complete and the approval stands as a clean review.
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.requiredChecks, "none");
    assert.equal(result.outputs.reviewResult, "clean");
    const trace = JSON.parse(readFileSync(join(runDir, "requirement-trace.json"), "utf8")) as {
      rows: Array<{ requirement_id: string; disposition: string }>; incomplete: boolean;
    };
    assert.equal(trace.incomplete, false);
    assert.equal(trace.rows.find((row) => row.requirement_id === state.idFirst)?.disposition, "met");
    assert.equal(trace.rows.find((row) => row.requirement_id === state.idSecond)?.disposition, "met");

    // (7) The merge never touched the verdict itself: findings/verdict/
    // review prose are the model's original; only a requirement_coverage
    // was spliced into the standing artifact.
    const standing = JSON.parse(readFileSync(join(runDir, "ai-response.primary.json"), "utf8")) as {
      choices: Array<{ message: { content: string } }>;
    };
    const standingBody = JSON.parse(standing.choices[0]!.message.content) as Record<string, unknown>;
    assert.equal(standingBody.verdict, "approve");
    assert.equal(standingBody.review_markdown, "Looks fine.\n");
    assert.deepEqual(standingBody.findings, []);
    assert.equal((standingBody.requirement_coverage as unknown[]).length, 2);

    // (8) Deterministic trace validation is complete: the review reads
    // clean, not partial.
    assert.match(result.marker, /"review_result":"clean"/);

    // (9) Final publication is eligible for a native APPROVE under #1492.
    const api = await publishRun(result);
    assert.equal(api.submitted.length, 1);
    assert.equal(api.submitted[0]!.event, "APPROVE");
  } finally {
    await server.close();
    cleanup();
  }
});

test("#1488 canary (negative twin): when the probe's trace-only repair and the standalone fallback both return no claims, the dropped coverage fails closed and the approval is withheld", async () => {
  const { server, state } = await startTraceServer("negative");
  const { runDir, cleanup } = withRunDir();
  try {
    writeTraceWorkspace(runDir);
    const result = await runReview({
      env: { IS_FORK_PR: "false" },
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7",
        "ai-base-url": server.url, "ai-model": "primary-m", "ai-api-key": "k",
        "ai-stream": "false", "review-routing-mode": "off",         "tool-mode": "native_loop",
        // Configured investigation ceiling. Production ran #1488's starvation
        // on the default 40; the canary pins the same shape on a small
        // deterministic ceiling — the failure mode is "reached the configured
        // ceiling", not the number 40.
        "tool-max-requests": "8", "deep-review": "false",
        "verdict-policy": "model", "ai-connect-timeout-sec": "2", "ai-request-timeout-sec": "5",
        "ci-status-check": "false", "requirement-trace": "true",
      },
      runDir,
      workspace: runDir,
      platformAdapter: twoRequirementTracePlatform(),
      persistArtifacts: true,
      sleep: async () => {},
      quiet: true,
    });
    assert.equal(state.unexpected.length, 0, `unscripted model requests: ${JSON.stringify(state.unexpected)}`);
    assert.ok(state.idFirst && state.idSecond, "both ledger ids extracted from the planning corpus");

    // The same exhausted-ceiling start, and the probe fired on EXACTLY the
    // two omitted ids — but its trace-only turn merged no claim: the #1488
    // serialization-failure shape.
    const harness = JSON.parse(readFileSync(join(runDir, "tool-harness.json"), "utf8")) as {
      stop_reason?: string;
      executed_request_count?: number;
      trace_repair_continuation?: {
        outcome?: string; claims_merged?: number; trace_claims_merged?: boolean;
        unresolved_ids?: string[];
      };
    };
    assert.equal(harness.stop_reason, "tool-call-budget-exhausted");
    assert.equal(harness.executed_request_count, 9);
    assert.equal(harness.trace_repair_continuation?.outcome, "continued");
    assert.deepEqual(harness.trace_repair_continuation?.unresolved_ids, [state.idFirst, state.idSecond]);
    assert.equal(harness.trace_repair_continuation?.claims_merged, 0);
    assert.equal(harness.trace_repair_continuation?.trace_claims_merged, false);

    // The standalone fallback fired (the recovery path for a zero-claim
    // in-conversation repair) but also returned no claims.
    assert.equal(state.standaloneRequests, 1, "the standalone repair pass must fire when the native-loop repair merged nothing");
    const persisted = JSON.parse(readFileSync(join(runDir, "ai-output.json"), "utf8")) as {
      requirement_trace_repair?: { attempted: boolean; outcome: string; route?: string; invocation_reason?: string; claims: number; missing_ids: string[] };
    };
    assert.equal(persisted.requirement_trace_repair?.attempted, true);
    assert.equal(persisted.requirement_trace_repair?.outcome, "no_claims");
    assert.equal(persisted.requirement_trace_repair?.route, "primary");
    assert.equal(persisted.requirement_trace_repair?.invocation_reason, "native_loop_no_trace_claims");
    assert.equal(persisted.requirement_trace_repair?.claims, 0);
    const missingIds = persisted.requirement_trace_repair?.missing_ids ?? [];
    assert.equal(missingIds.length, 2);
    assert.ok(missingIds.includes(state.idFirst), "the first id must stay missing");
    assert.ok(missingIds.includes(state.idSecond), "the second id must stay missing");

    // Fail closed: the dropped coverage stays incomplete, so the verdict
    // stays approve but the review reads partial and the approval is withheld.
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.requiredChecks, "incomplete");
    assert.equal(result.outputs.reviewResult, "partial");
    const trace = JSON.parse(readFileSync(join(runDir, "requirement-trace.json"), "utf8")) as {
      rows: Array<{ requirement_id: string; disposition: string }>; incomplete: boolean;
    };
    assert.equal(trace.incomplete, true);
    assert.equal(trace.rows.find((row) => row.requirement_id === state.idFirst)?.disposition, "unverifiable");
    assert.equal(trace.rows.find((row) => row.requirement_id === state.idSecond)?.disposition, "unverifiable");
    // The final artifact stays review_result: partial with the requirement
    // trace as the recorded incomplete reason (#1492's input).
    assert.match(result.marker, /"review_result":"partial"/);
    assert.match(result.marker, /"incomplete_reason":"requirement_trace"/);

    // Publication degrades to COMMENT — never a native APPROVE, never a
    // manufactured REQUEST_CHANGES.
    const api = await publishRun(result);
    assert.equal(api.submitted.length, 1);
    assert.equal(api.submitted[0]!.event, "COMMENT");
    assert.match(api.submitted[0]!.body, /Approval withheld by incomplete review coverage/);
    assert.ok(!api.submitted.some((review) => review.event === "APPROVE" || review.event === "REQUEST_CHANGES"));
  } finally {
    await server.close();
    cleanup();
  }
});
