import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview, rawInputsFromEnv, RunReviewError } from "../src/run/review.js";
import { runReviewEngine } from "../src/engine/review.js";
import { runEngineAdmission, admissionStageEnv } from "../src/engine/admission.js";
import type { ReviewDependencies, ReviewRequest } from "../src/engine/types.js";
import { actionStageEnv } from "../src/run/action.js";
import { collectConfigLines } from "../src/precheck/fingerprint.js";
import { validateContract } from "../src/config/contract.js";
import { V3_CONTRACT } from "../.v3-generated/contract.generated.js";
import { engineMain } from "../src/engine/cli.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import { startMockServer } from "./helpers.js";

function mockPlatform(): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: async () => ({ number: 7, title: "Update README", body: "", draft: false, head: { sha: "a".repeat(40), ref: "feature" }, base: { ref: "main" }, user: { login: "someone" }, changed_files: 1, additions: 1, deletions: 0 }),
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

/** Minimal GitHub REST reads for the engine-CLI tests: the engine CLI cannot
 * inject an adapter, so admission's platform reads (PR object, diff, file
 * list, managed-comment/review lists) go over the wire. The PR carries an
 * explicit `draft: false` and same-repo head/base identity, so admission's
 * deterministic gates (draft, fork) admit the run. */
function engineCliGithubHandler(): NonNullable<Parameters<typeof startMockServer>[0]> {
  return (req, _body, res) => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    if (url.includes("/pulls/7/files")) {
      res.end(JSON.stringify([{ filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 }]));
      return;
    }
    if (url.includes("/pulls/7")) {
      if (req.headers.accept === "application/vnd.github.v3.diff") {
        res.setHeader("Content-Type", "text/plain");
        res.end("diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n");
        return;
      }
      res.end(JSON.stringify({
        number: 7, state: "open", draft: false, title: "Update README", body: "",
        head: { sha: "a".repeat(40), ref: "feature", repo: { full_name: "o/r" } },
        base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "o/r" } },
        user: { login: "someone" }, changed_files: 1, additions: 1, deletions: 0,
        html_url: "https://github.com/o/r/pull/7",
      }));
      return;
    }
    if (url.includes("/issues/7/comments") || url.includes("/pulls/7/reviews")) {
      res.end("[]");
      return;
    }
    res.setHeader("Connection", "close");
    res.end(verdictBody());
  };
}

/** An admission-focused platform mock: full read surface with configurable
 * managed comments, trusted identity, diff and head. Repo identity is
 * same-repo on both sides so `is_fork_pr` derives "false". */
function admissionAdapter(options: {
  headSha?: string;
  diff?: string;
  comments?: { body: string; author?: string }[];
  identity?: string | null;
  ghApi?: (endpoint: string) => Promise<{ data?: unknown; error?: string }>;
} = {}): PlatformReadAdapter {
  const headSha = options.headSha ?? "a".repeat(40);
  return {
    platform: "github",
    getPr: async () => ({
      number: 7, title: "Update README", body: "", state: "open", draft: false,
      head: { sha: headSha, ref: "feature", repo: { full_name: "o/r" } },
      base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "o/r" } },
      user: { login: "someone" }, changed_files: 1, additions: 1, deletions: 0,
      html_url: "https://github.com/o/r/pull/7",
    }),
    getPrDiff: async () => options.diff ?? "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n",
    listPrFiles: async () => ({ ok: true, data: [{ filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 }] }),
    getIssue: async () => ({ ok: false, error: "not served" }),
    listPrConversationComments: async () => ({ ok: true, data: [] }),
    listReviewThreads: async () => ({ ok: true, data: [] }),
    listPrReviewsPaginated: async () => ({ ok: true, data: [] }),
    listIssueComments: async () => (options.comments ?? []).map((comment, index) => ({ id: index + 1, body: comment.body, created_at: "2026-01-01T00:00:00Z", author: comment.author ?? "ci-bot" })),
    listPrReviews: async () => [],
    repoPermission: async () => null,
    authenticatedIdentity: async () => options.identity ?? null,
    ghApi: options.ghApi ?? (async () => ({ error: "not served" })),
    externalChecks: async () => [],
  } as unknown as PlatformReadAdapter;
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

test("cancelling while a gate fork is launching still awaits its termination", async () => {
  // #726 review: a fork whose launch races the abort must not be cut and
  // forgotten un-awaited. The abort lands inside the gate workload, i.e.
  // while the engine is still awaiting forkGate(), so the fork's registration
  // (own()) races the cancellation rejection — finalize() drains that cut, so
  // the rejection never becomes observable while the child is winding down.
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  const controller = new AbortController();
  let gateTerminated = false;
  let releaseGate!: () => void;
  const gateGone = new Promise<void>((resolve) => { releaseGate = resolve; });
  try {
    const running = runReviewEngine(
      { ...request(server.url, f.runDir), signal: controller.signal, inputs: { ...inputs, "ai-base-url": server.url, "ci-status-check": "true" } },
      engineDeps(f.root, f.runDir, {
        ciGate: {
          file: "",
          envAllowlist: [],
          workload: async (signal: AbortSignal) => {
            signal.addEventListener("abort", () => {
              setImmediate(() => { gateTerminated = true; releaseGate(); });
            }, { once: true });
            controller.abort();
            await gateGone;
            return 1;
          },
        },
      }),
    );
    await assert.rejects(running, (error: unknown) => error instanceof RunReviewError && /cancelled/.test(error.message));
    // Deterministic in both directions: with the fix, finalize() awaits the
    // registered cut (the macrotask above has run); a regression that abandons
    // the fork observes false here instead of hanging.
    assert.equal(gateTerminated, true, "the launch-raced fork's termination was awaited before the rejection");
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
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
  const server = await startMockServer(engineCliGithubHandler());
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
  const server = await startMockServer(engineCliGithubHandler());
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

// ── #726: engine-owned admission (precheck/fingerprint decision) ─────────

/** Admission fixtures pin deterministic fingerprints, so deep_review=auto
 * (the contract default, whose failed selection injects a per-run unique
 * sentinel into the config hash) is explicitly off. */
const admissionInputs = { ...inputs, "deep-review": "false" };

function admissionRequest(
  aiBaseUrl: string,
  runDir: string,
  overrides: Partial<ReviewRequest> & { inputsOverrides?: Record<string, string> } = {},
): ReviewRequest {
  const { inputsOverrides, ...rest } = overrides;
  return {
    ...request(aiBaseUrl, runDir),
    inputs: { ...admissionInputs, "ai-base-url": aiBaseUrl, ...inputsOverrides },
    ...rest,
  };
}

test("engine admission: a fresh event is admitted and the review runs", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const result = await runReviewEngine(
      admissionRequest(server.url, f.runDir, { event: { name: "pull_request", action: "synchronize" }, eventHeadSha: "a".repeat(40) }),
      { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() },
    );
    assert.equal(result.shouldReview, true);
    assert.equal(result.skipReason, "");
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.admission.should_review, "true");
    assert.equal(result.admission.head_sha, "a".repeat(40));
    assert.equal(result.admission.base_sha, "b".repeat(40));
    assert.equal(result.admission.is_fork_pr, "false");
    assert.equal(result.admissionBaseSha, "b".repeat(40));
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: an unchanged diff with a stored fingerprint skips with no model spend", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const first = await runReviewEngine(admissionRequest(server.url, f.runDir), { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() });
    assert.equal(first.shouldReview, true);
    const fingerprint = first.diffFingerprint;
    assert.match(fingerprint, /\|cfg:/);
    const requestsAfterFirst = server.requests.length;
    assert.ok(requestsAfterFirst > 0, "the first run reached the model");
    const runDir2 = join(f.root, "run-2");
    mkdirSync(runDir2);
    const second = await runReviewEngine(
      admissionRequest(server.url, runDir2),
      {
        ...engineDeps(f.root, runDir2),
        adapter: admissionAdapter({
          comments: [{ body: `<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${fingerprint} -->
`, author: "ci-bot" }],
          identity: "ci-bot",
        }),
      },
    );
    assert.equal(second.shouldReview, false);
    assert.equal(second.skipReason, "diff-unchanged");
    assert.equal(second.diffFingerprint, fingerprint);
    // A plain fingerprint skip carries no resolved SHAs (the precheck skip
    // surface leaves head/base empty); the review path resolves them.
    assert.equal(second.admissionBaseSha, "");
    assert.equal(second.outputs.verdict, "");
    assert.equal(server.requests.length, requestsAfterFirst, "the skip made no model call");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: a diff-unchanged skip carries the previous verdict on the result", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const first = await runReviewEngine(admissionRequest(server.url, f.runDir), { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() });
    const fingerprint = first.diffFingerprint;
    const requestsAfterFirst = server.requests.length;
    const runDir2 = join(f.root, "run-2");
    mkdirSync(runDir2);
    const second = await runReviewEngine(
      admissionRequest(server.url, runDir2),
      {
        ...engineDeps(f.root, runDir2),
        adapter: admissionAdapter({
          comments: [{
            body: `<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${fingerprint} -->
<!-- ai-pr-reviewer: {"review_result":"clean","head_sha":"${"a".repeat(40)}"} -->
`,
            author: "ci-bot",
          }],
          identity: "ci-bot",
        }),
      },
    );
    assert.equal(second.shouldReview, false);
    assert.equal(second.skipReason, "diff-unchanged");
    assert.equal(second.admission.verdict, "approve");
    assert.equal(second.admission.verdict_source, "carry_forward");
    assert.equal(second.admission.review_result, "clean");
    assert.equal(second.admission.head_sha, "a".repeat(40));
    assert.equal(server.requests.length, requestsAfterFirst, "the carried skip made no model call at all");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: a stale gate head sha skips superseded-head with no model spend", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const result = await runReviewEngine(
      admissionRequest(server.url, f.runDir, {
        event: { name: "issue_comment", action: "created", comment: { id: 5, body: "/ai-review", user: "maintainer" } },
        ambient: { PR_REVIEWER_GATE_HEAD_SHA: "c".repeat(40) },
        inputsOverrides: { "rereview-command": "/ai-review" },
      }),
      {
        ...engineDeps(f.root, f.runDir),
        adapter: admissionAdapter({
          ghApi: async (endpoint) => endpoint.includes("/collaborators/") ? { data: { permission: "write" } } : { error: "not served" },
        }),
      },
    );
    assert.equal(result.shouldReview, false);
    assert.equal(result.skipReason, "superseded-head");
    assert.equal(server.requests.length, 0, "the superseded skip made no model call");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: force rereview intent reviews despite a stored fingerprint", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const first = await runReviewEngine(admissionRequest(server.url, f.runDir), { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() });
    const fingerprint = first.diffFingerprint;
    const requestsAfterFirst = server.requests.length;
    const runDir2 = join(f.root, "run-2");
    mkdirSync(runDir2);
    const second = await runReviewEngine(
      admissionRequest(server.url, runDir2, { event: { name: "pull_request", action: "labeled", label: { name: "ai-review" } } }),
      {
        ...engineDeps(f.root, runDir2),
        adapter: admissionAdapter({
          comments: [{ body: `<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${fingerprint} -->
`, author: "ci-bot" }],
          identity: "ci-bot",
        }),
      },
    );
    assert.equal(second.shouldReview, true);
    assert.ok(server.requests.length > requestsAfterFirst, "the forced re-review reached the model");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: forceRereview projects to precheck's FORCE_REVIEW gate", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const first = await runReviewEngine(admissionRequest(server.url, f.runDir), { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() });
    const fingerprint = first.diffFingerprint;
    const stored = {
      comments: [{ body: `<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${fingerprint} -->
`, author: "ci-bot" }],
      identity: "ci-bot",
    };
    // Without the intent the stored fingerprint still skips…
    const runDir2 = join(f.root, "run-2");
    mkdirSync(runDir2);
    const skipped = await runReviewEngine(
      admissionRequest(server.url, runDir2, { forceRereview: false }),
      { ...engineDeps(f.root, runDir2), adapter: admissionAdapter(stored) },
    );
    assert.equal(skipped.shouldReview, false);
    assert.equal(skipped.skipReason, "diff-unchanged");
    const requestsAfterSkip = server.requests.length;
    // …and with it the same request reviews afresh.
    const runDir3 = join(f.root, "run-3");
    mkdirSync(runDir3);
    const forced = await runReviewEngine(
      admissionRequest(server.url, runDir3, { forceRereview: true }),
      { ...engineDeps(f.root, runDir3), adapter: admissionAdapter(stored) },
    );
    assert.equal(forced.shouldReview, true);
    assert.ok(server.requests.length > requestsAfterSkip, "the forced re-review reached the model");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: an explicit head pin that no longer matches skips superseded-head with no model spend", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const result = await runReviewEngine(
      admissionRequest(server.url, f.runDir, { headSha: "c".repeat(40) }),
      { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() },
    );
    assert.equal(result.shouldReview, false);
    assert.equal(result.skipReason, "superseded-head");
    assert.equal(result.reviewedHeadSha, "a".repeat(40), "the skip carries admission's resolved head");
    assert.equal(server.requests.length, 0, "the superseded skip made no model call");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: a matching head pin is the verified reviewed head on the result", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const result = await runReviewEngine(
      admissionRequest(server.url, f.runDir, { headSha: "a".repeat(40) }),
      { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() },
    );
    assert.equal(result.shouldReview, true);
    assert.equal(result.reviewedHeadSha, "a".repeat(40));
    assert.equal(result.isForkPr, "false");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: contradictory event and head pins reject before any adapter or model call", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    await assert.rejects(
      runReviewEngine(
        admissionRequest(server.url, f.runDir, { headSha: "c".repeat(40), eventHeadSha: "a".repeat(40) }),
        engineDeps(f.root, f.runDir),
      ),
      (error: unknown) => error instanceof RunReviewError && /contradictory request: eventHeadSha/.test(error.message),
    );
    assert.equal(server.requests.length, 0, "nothing reached the model");
  } finally { await server.close(); f.cleanup(); }
});

test("the Action env adapter and the engine produce identical admission decisions", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    // One engine run to learn the deterministic broad fingerprint…
    const first = await runReviewEngine(admissionRequest(server.url, f.runDir), { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() });
    const fingerprint = first.diffFingerprint;
    // …then the SAME fixture (same inputs, same event, same stored marker)
    // through both paths, with a fresh adapter per path.
    const stored = { comments: [{ body: `<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${fingerprint} -->
`, author: "ci-bot" }], identity: "ci-bot" };
    const event = { name: "pull_request", action: "synchronize" } as const;
    const eventHeadSha = "a".repeat(40);
    const adapterResult = await runReview({
      env: { GITHUB_OUTPUT: "/dev/null" },
      inputs: { ...admissionInputs, "ai-base-url": server.url },
      runDir: join(f.root, "adapter-run"),
      workspace: f.root,
      platformAdapter: admissionAdapter(stored),
      event,
      eventHeadSha,
      quiet: true,
    });
    const engineRunDir = join(f.root, "engine-run");
    mkdirSync(engineRunDir);
    const engineResult = await runReviewEngine(
      admissionRequest(server.url, engineRunDir, { event, eventHeadSha }),
      { ...engineDeps(f.root, engineRunDir), adapter: admissionAdapter(stored) },
    );
    assert.equal(engineResult.shouldReview, adapterResult.shouldReview);
    assert.equal(engineResult.skipReason, adapterResult.skipReason);
    assert.equal(engineResult.diffFingerprint, adapterResult.diffFingerprint);
    assert.equal(engineResult.admissionBaseSha, adapterResult.admissionBaseSha);
    for (const key of ["should_review", "skip_reason", "diff_fingerprint", "head_sha", "base_sha", "is_fork_pr", "resolved_platform", "effective_forgejo_api_url"] as const) {
      assert.equal(engineResult.admission[key], adapterResult.admission[key], key);
    }
    // And a fresh-diff run through both paths must also agree (review case).
    const adapterFresh = await runReview({
      env: { GITHUB_OUTPUT: "/dev/null" },
      inputs: { ...admissionInputs, "ai-base-url": server.url },
      runDir: join(f.root, "adapter-fresh"),
      workspace: f.root,
      platformAdapter: admissionAdapter(),
      event,
      eventHeadSha,
      quiet: true,
    });
    const engineFreshRunDir = join(f.root, "engine-fresh");
    mkdirSync(engineFreshRunDir);
    const engineFresh = await runReviewEngine(
      admissionRequest(server.url, engineFreshRunDir, { event, eventHeadSha }),
      { ...engineDeps(f.root, engineFreshRunDir), adapter: admissionAdapter() },
    );
    assert.equal(engineFresh.shouldReview, true);
    assert.equal(adapterFresh.shouldReview, true);
    assert.equal(engineFresh.diffFingerprint, adapterFresh.diffFingerprint);
    assert.equal(engineFresh.admissionBaseSha, adapterFresh.admissionBaseSha);
  } finally { await server.close(); f.cleanup(); }
});

// ── #726 review: admission seams pinned ──────────────────────────────────

test("engine admission: onAdmission is not invoked when admission skips", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const first = await runReviewEngine(admissionRequest(server.url, f.runDir), { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() });
    const fingerprint = first.diffFingerprint;
    const runDir2 = join(f.root, "run-2");
    mkdirSync(runDir2);
    let calls = 0;
        const second = await runReviewEngine(
          admissionRequest(server.url, runDir2),
      {
        ...engineDeps(f.root, runDir2),
        adapter: admissionAdapter({
          comments: [{ body: `<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${fingerprint} -->
`, author: "ci-bot" }],
          identity: "ci-bot",
        }),
        onAdmission: () => { calls += 1; },
      },
    );
    assert.equal(second.shouldReview, false);
    assert.equal(second.skipReason, "diff-unchanged");
    assert.equal(calls, 0, "onAdmission never fired on a skipped admission");
    assert.ok(!existsSync(join(runDir2, "verdict.txt")), "no review ran past the skip");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: a throwing onAdmission fails the run before any review stage", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    await assert.rejects(
      runReviewEngine(
        admissionRequest(server.url, f.runDir),
        {
          ...engineDeps(f.root, f.runDir),
          adapter: admissionAdapter(),
          onAdmission: () => { throw new Error("ack reaction exploded"); },
        },
      ),
      /ack reaction exploded/,
    );
    assert.ok(!existsSync(join(f.runDir, "verdict.txt")), "no verdict was produced");
    assert.equal(server.requests.length, 0, "the model was never reached");
  } finally { await server.close(); f.cleanup(); }
});

test("admission stage env keeps the Action fingerprint config byte-identical", () => {
  const contract = validateContract(V3_CONTRACT);
  const workspace = "/checkouts/pr";
  // A representative fully-populated Action env: contract inputs as the
  // runner exports them (INPUT_<ID>), runner ambient context, and the
  // derived bindings actionMain computes. Everything is a defined string —
  // collectConfigLines skips nothing on either side.
  const env: NodeJS.ProcessEnv = {
    "INPUT_GITHUB-TOKEN": "tok",
    "INPUT_REPO": "o/r",
    "INPUT_PR-NUMBER": "7",
    "INPUT_AI-BASE-URL": "https://model.invalid",
    "INPUT_AI-MODEL": "m",
    "INPUT_AI-STREAM": "false",
    "INPUT_AI-API-KEY": "k",
    "INPUT_DEEP-REVIEW": "false",
    "INPUT_TOOL-MODE": "off",
    "INPUT_COMMENT-MARKER": "<!-- ai-pr-reviewer -->",
    "INPUT_PUBLISH-MODE": "comment",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_ACTION_REF: "v3",
    GITHUB_WORKSPACE: workspace,
    GITHUB_API_URL: "https://api.github.com",
    PLATFORM: "github",
    PR_NUMBER: "7",
    EVENT_HEAD_SHA: "a".repeat(40),
  };
  const request: ReviewRequest = {
    repository: env.GITHUB_REPOSITORY ?? "",
    prNumber: env.PR_NUMBER ?? "",
    headSha: "",
    baseRef: "",
    isForkPr: "",
    platform: env.PLATFORM ?? "",
    forgejoApiUrl: env.FORGEJO_API_URL ?? "",
    ciChecksFile: "",
    inputs: rawInputsFromEnv(contract, env),
    ambient: env,
    triggerReason: "push",
    forceRereview: false,
    ...(env.EVENT_HEAD_SHA !== undefined ? { eventHeadSha: env.EVENT_HEAD_SHA } : {}),
  };
  const admissionLines = collectConfigLines(admissionStageEnv(contract, request, workspace));
  const actionLines = collectConfigLines(actionStageEnv(env) as Record<string, string>);
  assert.deepEqual(admissionLines, actionLines, "the fingerprint config hash inputs are byte-identical");
});

test("review-request.json records the folded admission identity on an Action-path request", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    // Action-path shape: the raw request carries no head/base/fork/platform
    // (the adapter path fills them from the event); admission resolves them.
    const result = await runReviewEngine(
      {
        ...admissionRequest(server.url, f.runDir, { eventHeadSha: "a".repeat(40) }),
        headSha: "",
        baseRef: "",
        isForkPr: "",
        platform: "",
      },
      { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() },
    );
    assert.equal(result.shouldReview, true);
    const provenance = JSON.parse(readFileSync(join(f.runDir, "review-request.json"), "utf8")) as Record<string, unknown>;
    assert.equal(provenance.head_sha, "a".repeat(40), "the reviewed head is the folded event/admission head, not the empty request value");
    assert.equal(provenance.base_ref, "b".repeat(40), "the base ref is the admission-resolved base, not the empty request value");
    assert.equal(provenance.is_fork_pr, "false", "the fork flag is the admission-derived one, not the empty request value");
    assert.equal(provenance.platform, "github", "the platform is the admission-resolved one, not the empty request value");
    assert.equal(provenance.forgejo_api_url, "", "the Forgejo URL is admission's effective value");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission routes precheck diagnostics to the injected error sink only", async () => {
  const f = fixture();
  const stderrChunks: string[] = [];
  const errorLines: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown, encoding?: BufferEncoding, cb?: (err?: Error | null) => void): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString(encoding ?? "utf8"));
    if (cb) cb(null);
    return true;
  }) as typeof process.stderr.write;
  try {
    const output = await runEngineAdmission(
      validateContract(V3_CONTRACT),
      admissionRequest("https://model.invalid", f.runDir),
      f.root,
      // A marker-bearing managed comment with an unproven identity fires
      // precheck's fail-closed diagnostic (no skip, no carry).
      admissionAdapter({
        comments: [{ body: "<!-- ai-pr-reviewer -->\n<!-- ai-pr-review-fingerprint:stale -->\n", author: "someone" }],
        identity: null,
      }),
      (line) => errorLines.push(line),
    );
    assert.equal(output.should_review, "true", "the unproven identity forced a fresh review instead of a skip");
  } finally {
    process.stderr.write = originalWrite;
    f.cleanup();
  }
  assert.ok(
    errorLines.some((line) => line.includes("could not authenticate the action's own forge identity")),
    "the precheck diagnostic reached the injected error sink",
  );
  assert.deepEqual(stderrChunks, [], "nothing reached process.stderr during admission");
});
