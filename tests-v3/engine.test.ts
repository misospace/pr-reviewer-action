import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview, RunReviewError } from "../src/run/review.js";
import { runReviewEngine } from "../src/engine/review.js";
import type { ReviewDependencies, ReviewRequest } from "../src/engine/types.js";
import { engineMain } from "../src/engine/cli.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import { startMockServer } from "./helpers.js";

function mockPlatform(): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: async () => ({ number: 7, title: "Update README", body: "", head: { sha: "a".repeat(40), ref: "feature" }, base: { ref: "main" }, user: { login: "someone" }, changed_files: 1, additions: 1, deletions: 0 }),
    getPrDiff: async () => "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n",
    listPrFiles: async () => ({ ok: true, data: [{ filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 }] }),
    getIssue: async () => ({ ok: false, error: "not served" }),
    listPrConversationComments: async () => ({ ok: true, data: [] }),
    listReviewThreads: async () => ({ ok: true, data: [] }),
    listPrReviewsPaginated: async () => ({ ok: true, data: [] }),
    listIssueComments: async () => [],
    listPrReviews: async () => [],
    repoPermission: async () => null,
    authenticatedIdentity: async () => null,
    ghApi: async () => ({ error: "not served" }),
    externalChecks: async () => [],
  } as unknown as PlatformReadAdapter;
}

function verdictBody(): string {
  return JSON.stringify({ id: "c1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ verdict: "approve", review_markdown: "Looks fine.\n", smart_review_requested: false, smart_review_reason: null, findings: [], requirement_coverage: null, required_check_dispositions: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
}

const inputs = { "github-token": "tok", repo: "o/r", "pr-number": "7", "ai-base-url": "", "ai-model": "m", "ai-stream": "false", "ai-api-key": "k" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "v3-engine-test-"));
  const runDir = join(root, "run");
  mkdirSync(runDir);
  return { root, runDir, cleanup: (): void => rmSync(root, { recursive: true, force: true }) };
}
function request(aiBaseUrl: string, runDir: string): ReviewRequest {
  return { repository: "o/r", prNumber: "7", headSha: "a".repeat(40), baseRef: "", isForkPr: "false", platform: "github", forgejoApiUrl: "", ciChecksFile: join(runDir, "ci-checks-context.md"), inputs: { ...inputs, "ai-base-url": aiBaseUrl }, ambient: {}, triggerReason: "manual", forceRereview: false };
}

/** Engine dependencies over the shared fixture; `overrides` supplies the one
 * seam a cancellation test needs to control (a gate branch, a sink). */
function noopSink(): void {}
function engineDeps(root: string, runDir: string, overrides: Partial<ReviewDependencies> = {}): ReviewDependencies {
  return { workspace: root, runDir, outputsSink: "/dev/null", stepSummaryPath: join(root, "summary.md"), adapter: mockPlatform(), persistArtifacts: true, quiet: true, log: noopSink, error: noopSink, annotate: noopSink, ...overrides };
}

test("engine runs a full review without Action-only environment", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const result = await runReviewEngine(request(server.url, f.runDir), { workspace: f.root, runDir: f.runDir, outputsSink: "/dev/null", stepSummaryPath: join(f.root, "summary.md"), adapter: mockPlatform(), persistArtifacts: true, quiet: true, log: noopSink, error: noopSink, annotate: noopSink });
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.reviewRoute, "legacy");
    assert.match(result.marker, new RegExp("a".repeat(40)));
    for (const name of ["ai-output.json", "ai-request.primary.json", "ai-response.primary.json", "classification.json", "pr.json", "pr.diff", "pr-files.json", "review-corpus.md", "review-body.md", "verdict.txt"]) assert.ok(existsSync(join(f.runDir, name)), name);
    const provenance = readFileSync(join(f.runDir, "review-request.json"), "utf8");
    assert.match(provenance, /"trigger_reason": "manual"/);
    assert.match(provenance, /"force_rereview": false/);
    assert.doesNotMatch(provenance, /tok|\bk\b|token/i);
  } finally { await server.close(); f.cleanup(); }
});

test("the engine writes nothing implicitly to process streams when sinks are explicit", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  const seen: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const spy = (stream: "stdout" | "stderr", original: typeof process.stdout.write): typeof process.stdout.write => {
    const patched = ((chunk: unknown, encoding?: BufferEncoding, cb?: (err?: Error | null) => void): boolean => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("latin1");
      if (!text.startsWith("\u00FF\u000F")) seen.push(`${stream}:${JSON.stringify(text)}`);
      return original.call(process[stream], chunk as string, encoding, cb);
    }) as typeof process.stdout.write;
    return patched;
  };
  try {
    process.stdout.write = spy("stdout", originalStdoutWrite);
    process.stderr.write = spy("stderr", originalStderrWrite);
    const logLines: string[] = [];
    const result = await runReviewEngine(request(server.url, f.runDir), { ...engineDeps(f.root, f.runDir), quiet: false, log: (line) => logLines.push(line), error: noopSink, annotate: noopSink });
    assert.equal(result.outputs.verdict, "approve");
    assert.ok(logLines.length > 0, "log sink received lines");
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    await server.close(); f.cleanup();
  }
  assert.deepEqual(seen, [], "no implicit process-stream writes escaped the engine");
});

test("the env adapter and engine produce identical structured results", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  const engineRunDir = join(f.root, "engine-run");
  mkdirSync(engineRunDir);
  try {
    const adapterResult = await runReview({ env: { GITHUB_OUTPUT: "/dev/null", GITHUB_STEP_SUMMARY: "" }, inputs: { ...inputs, "ai-base-url": server.url }, runDir: f.runDir, workspace: f.root, platformAdapter: mockPlatform(), persistArtifacts: true, quiet: true });
    const engineResult = await runReviewEngine(request(server.url, engineRunDir), { workspace: f.root, runDir: engineRunDir, outputsSink: "/dev/null", stepSummaryPath: "", adapter: mockPlatform(), persistArtifacts: true, quiet: true, log: noopSink, error: noopSink, annotate: noopSink });
    for (const key of ["outputs", "route", "routeReason", "analysisEngine", "classification", "verdictPolicy"] as const) assert.deepEqual(engineResult[key], adapterResult[key], key);
    assert.deepEqual([...engineResult.artifacts.keys()].sort(), [...adapterResult.artifacts.keys()].sort());
    for (const name of ["review-body.md", "verdict.txt", "ai-output.json"]) assert.equal(readFileSync(join(engineRunDir, name), "utf8"), readFileSync(join(f.runDir, name), "utf8"), name);
  } finally { await server.close(); f.cleanup(); }
});

test("pre-aborted engine request refuses to start", async () => {
  const f = fixture();
  try {
    await assert.rejects(runReviewEngine({ ...request("", f.runDir), signal: AbortSignal.abort() }, { workspace: f.root, runDir: f.runDir, outputsSink: "/dev/null", adapter: mockPlatform(), log: noopSink, error: noopSink, annotate: noopSink }), (error: unknown) => error instanceof RunReviewError && /cancelled/.test(error.message));
  } finally { f.cleanup(); }
});

test("cancelling mid-flight rejects the run instead of returning the in-flight model verdict", async () => {
  // Deterministic seam: the provider answers only AFTER the cancellation
  // landed, so the engine is handed a complete, approving verdict it must
  // still refuse — no sleeps, no wall-clock race.
  const controller = new AbortController();
  let answered!: () => void;
  const modelAnswered = new Promise<void>((resolve) => { answered = resolve; });
  const server = await startMockServer((_req, _body, res) => {
    controller.abort(); // cancellation lands while the primary model request is in flight
    // The answer goes out on the next macrotask, strictly after the abort.
    setImmediate(() => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Connection", "close");
      res.end(verdictBody());
      answered();
    });
  });
  const f = fixture();
  try {
    await assert.rejects(
      runReviewEngine({ ...request(server.url, f.runDir), signal: controller.signal }, engineDeps(f.root, f.runDir)),
      (error: unknown) => error instanceof RunReviewError && /cancelled/.test(error.message),
    );
    // The cancelled run produced no publishable verdict surface.
    assert.ok(!existsSync(join(f.runDir, "verdict.txt")), "verdict.txt");
    assert.ok(!existsSync(join(f.runDir, "review-body.md")), "review-body.md");
    // The caller's abort listener is detached: a long-lived worker signal
    // must not retain a finished run.
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
    // The cancelled request was answered anyway — the verdict arrived too
    // late to be accepted, and the run never handed one out.
    await modelAnswered;
  } finally { await server.close(); f.cleanup(); }
});

test("cancelling mid-flight tears the in-flight provider request down", async () => {
  // #726 (round-3 review): racing the pipeline is not enough — the active
  // model request must receive the cancellation and physically stop.
  const controller = new AbortController();
  let tornDown!: () => void;
  const closed = new Promise<void>((resolve) => { tornDown = resolve; });
  const live: { res: { destroy(): void } | null } = { res: null };
  const server = await startMockServer((_req, _body, res) => {
    live.res = res;
    res.on("close", () => tornDown());
    // The cancellation lands while the primary model request is in flight;
    // the server never answers, so only the client-side teardown closes it.
    controller.abort();
  });
  const f = fixture();
  try {
    await assert.rejects(
      runReviewEngine({ ...request(server.url, f.runDir), signal: controller.signal }, engineDeps(f.root, f.runDir)),
      (error: unknown) => error instanceof RunReviewError && /cancelled/.test(error.message),
    );
    // Hang guard (same pattern as the gate test): a regression that abandons
    // the provider request fails the assertion instead of hanging the suite.
    const torn = await Promise.race([closed.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000))]);
    assert.equal(torn, true, "the in-flight provider request was physically torn down");
  } finally {
    try { live.res?.destroy(); } catch { /* already closed */ }
    await server.close(); f.cleanup();
  }
});

test("cancelling mid-flight finalizes the gate fork the run still owns", async () => {
  // The model is never reached: the run is cancelled while the CI gate is
  // still in flight. The server only supplies a resolvable `ai-base-url`.
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.setHeader("Connection", "close"); res.end(verdictBody()); });
  const f = fixture();
  const controller = new AbortController();
  let gateStarted!: () => void;
  const gateInFlight = new Promise<void>((resolve) => { gateStarted = resolve; });
  let releaseGate!: () => void;
  const gateReleased = new Promise<number>((resolve) => { releaseGate = () => resolve(1); });
  let gateTerminated = false;
  try {
    const running = runReviewEngine(
      { ...request(server.url, f.runDir), signal: controller.signal, inputs: { ...inputs, "ai-base-url": server.url, "ci-status-check": "true" } },
      engineDeps(f.root, f.runDir, {
        ciGate: {
          file: "",
          envAllowlist: [],
          // Stands in for the CI-gate child: it runs until the engine cuts it,
          // so the run is cancelled with an owned fork still outstanding.
          workload: async (signal: AbortSignal) => {
            signal.addEventListener("abort", () => { gateTerminated = true; releaseGate(); }, { once: true });
            // Report the gate in flight only once the fork's own promise chain
            // settled, so the engine has already taken ownership of it.
            await new Promise<void>((resolve) => { setImmediate(resolve); });
            gateStarted();
            return gateReleased;
          },
        },
      }),
    );
    await gateInFlight;
    controller.abort();
    // Hang guard: a regression that never finalizes the fork unblocks it on
    // the next macrotask and fails the assertion below instead of hanging.
    const escape = setImmediate(releaseGate);
    try {
      await assert.rejects(running, (error: unknown) => error instanceof RunReviewError && /cancelled/.test(error.message));
      // finalize() is awaited before the rejection is observable: no owned
      // gate child outlives the cancelled run.
      assert.equal(gateTerminated, true, "the outstanding owned gate fork was aborted");
      assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
    } finally { clearImmediate(escape); }
  } finally { releaseGate(); await server.close(); f.cleanup(); }
});

test("a completed run detaches from the caller's signal", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.setHeader("Connection", "close"); res.end(verdictBody()); });
  const f = fixture();
  const controller = new AbortController();
  try {
    const result = await runReviewEngine({ ...request(server.url, f.runDir), signal: controller.signal }, engineDeps(f.root, f.runDir));
    assert.equal(result.outputs.verdict, "approve");
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
  } finally { await server.close(); f.cleanup(); }
});

test("a symlinked artifact name in the run dir cannot escape the engine's write boundary", async () => {
  // Required-check pin (edge-case paths): a full engine run whose run dir
  // carries a planted symlink must refuse the mirrored write outside it.
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.setHeader("Connection", "close"); res.end(verdictBody()); });
  const f = fixture();
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  const outsideFile = join(outside, "verdict.txt");
  writeFileSync(outsideFile, "SENTINEL");
  symlinkSync(outsideFile, join(f.runDir, "verdict.txt"));
  try {
    const result = await runReviewEngine(request(server.url, f.runDir), engineDeps(f.root, f.runDir));
    // The in-memory artifact bus is authoritative, so the review completes…
    assert.equal(result.outputs.verdict, "approve");
    // …but the guarded disk mirror refused to follow the symlink out.
    assert.equal(readFileSync(outsideFile, "utf8"), "SENTINEL", "nothing was written through the symlink");
  } finally { await server.close(); f.cleanup(); }
});

test("a null byte in the CLI request's runDir fails clean without writing outside", async () => {
  // Required-check pin (edge-case paths): the engine CLI boundary never
  // throws an unsurfaced error and never writes through a poisoned path.
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.setHeader("Connection", "close"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const poisoned = `${f.runDir}\u0000escape`;
    const data = { ...request(server.url, poisoned), workspace: f.root, runDir: poisoned, outputsSink: "/dev/null", stepSummaryPath: "", persistArtifacts: true, ambient: { GITHUB_API_URL: server.url } };
    const file = join(f.root, "nul-request.json");
    writeFileSync(file, JSON.stringify(data));
    const code = await engineMain(["--request", file]);
    assert.ok(code === 0 || code === 1, `clean exit code, got ${code}`);
    // The review really ran (platform reads and the model call reached the
    // mock endpoint) while every disk mirror was refused: the untouched real
    // run dir holds nothing.
    assert.ok(server.requests.length > 0, "the pipeline executed against the mocked endpoints");
    assert.ok(!existsSync(join(f.runDir, "review-request.json")), "no artifacts in the real run dir");
    assert.deepEqual(readdirSync(f.runDir), [], "the real run dir stayed empty");
  } finally { await server.close(); f.cleanup(); }
});

test("engineMain accepts an explicit request file and reports usage errors", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const data = { ...request(server.url, f.runDir), workspace: f.root, runDir: f.runDir, outputsSink: "/dev/null", stepSummaryPath: "", persistArtifacts: true, ambient: { GITHUB_API_URL: server.url } };
    const file = join(f.root, "request.json");
    writeFileSync(file, JSON.stringify(data));
    assert.equal(await engineMain(["--request", file]), 0);
    assert.ok(existsSync(join(f.runDir, "review-request.json")));
    assert.equal(await engineMain(["--nope"]), 2);
  } finally { await server.close(); f.cleanup(); }
});
