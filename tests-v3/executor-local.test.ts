/** Local reference executor (#733): envelope-before-launch, the child-env
 * allowlist (hostile repository data can never reach argv or env), the
 * ProcessResult → ExecutionResult classification (deadline, crash, error,
 * no_result, stale_result), first-terminal-wins idempotence, pre-abort
 * refusal, and post-restart reconciliation — end-to-end against a real
 * child process (`tests-v3/fixtures/executor-worker.mjs`), with the
 * runtime seams injected where isolation is needed. */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runProcess as realRunProcess, type ProcessHandle, type RunProcessOptions } from "../src/runtime/subprocess.js";
import {
  EXECUTION_REQUEST_ENV_KEY,
  EXECUTION_RESULT_ENV_KEY,
  EXECUTION_STATE_FILE,
  LocalExecutor,
  validateExecutionRequest,
  validateExecutionResult,
  type ExecutionRequest,
  type ExecutionResult,
  type LocalExecutorDeps,
} from "../src/executor/index.js";

const WORKER = path.resolve(__dirname, "..", "..", "tests-v3", "fixtures", "executor-worker.mjs");
const HEAD = "aa11bb22cc33dd44ee55ff667788990001122334";
const BASE = "dd44ee55ff66aa77bb88cc99001122334455667788";

// ── in-file harness ─────────────────────────────────────────────────────

let runSeq = 0;

interface Fixture {
  readonly request: ExecutionRequest;
  /** The temp root — also the worker's cwd (the workspace root). */
  readonly root: string;
}

function makeRequest(overrides: Partial<ExecutionRequest> = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "executor-local-"));
  const runDir = path.join(root, "run");
  const request: ExecutionRequest = Object.freeze({
    jobId: "job-1",
    runId: `run-${++runSeq}`,
    attempt: 1,
    kind: "review",
    platform: "github",
    repoFullName: "owner/repo",
    prNumber: 7,
    headSha: HEAD,
    baseSha: BASE,
    deadlineAtMs: 0,
    workspace: Object.freeze({
      rootPath: root,
      headSha: HEAD,
      mergeBaseSha: BASE,
      platform: "github",
      repoFullName: "owner/repo",
      createdAtMs: 0,
    }),
    profiles: Object.freeze({ executor: "local-dev", model: "fast", evidence: "default" }),
    credentials: Object.freeze([]) as readonly { name: string; reference: string }[],
    runDir,
    requestPath: path.join(runDir, "request.json"),
    resultPath: path.join(runDir, "result.json"),
    ...overrides,
  });
  return { request, root };
}

interface CapturedLaunch {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/** Deps that record every launch (file/argv/env) before delegating to the
 * real `runProcess`. */
function recordingDeps(deps: LocalExecutorDeps = {}): { launches: CapturedLaunch[]; deps: LocalExecutorDeps } {
  const launches: CapturedLaunch[] = [];
  return {
    launches,
    deps: {
      ...deps,
      runProcess: (options: RunProcessOptions): ProcessHandle => {
        launches.push({ file: options.file, args: options.args ?? [], env: options.env });
        return realRunProcess(options);
      },
    },
  };
}

function executor(scenario: string, deps: LocalExecutorDeps = {}): LocalExecutor {
  // The scenario rides as the executor spec's fixed arg; the executor
  // appends the request path last.
  return new LocalExecutor({ command: process.execPath, args: [WORKER, scenario] }, deps);
}

function writeStateFile(request: ExecutionRequest, record: Record<string, unknown>): void {
  mkdirSync(request.runDir, { recursive: true });
  writeFileSync(path.join(request.runDir, EXECUTION_STATE_FILE), JSON.stringify(record), "utf8");
}

function cleanup(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

// ── happy path ──────────────────────────────────────────────────────────

test("a successful run: envelope written, result collected and validated", async () => {
  const fixture = makeRequest();
  try {
    const handle = await executor("ok").start(fixture.request, new AbortController().signal);

    // The envelope is the correlation source of truth and predates launch.
    const envelope = JSON.parse(readFileSync(fixture.request.requestPath, "utf8"));
    assert.equal(envelope.runId, fixture.request.runId);
    assert.equal(envelope.jobId, fixture.request.jobId);
    assert.equal(envelope.attempt, 1);

    const result = await handle.collect();
    assert.equal(result.status, "completed");
    assert.equal(result.runId, fixture.request.runId);
    assert.equal(result.jobId, fixture.request.jobId);
    assert.equal(result.resultHeadSha, HEAD);
    assert.equal(result.resultArtifactPath, fixture.request.resultPath);
    assert.equal(result.failureCategory, "");
    assert.ok(result.resourceMs >= 0);
    assert.ok(Object.isFrozen(result));

    const report = await handle.observe();
    assert.equal(report.phase, "terminal");
    assert.equal(report.status, "completed");

    const state = JSON.parse(readFileSync(path.join(fixture.request.runDir, EXECUTION_STATE_FILE), "utf8"));
    assert.equal(state.state, "completed");
    assert.equal(state.runId, fixture.request.runId);
  } finally {
    cleanup(fixture);
  }
});

test("duplicate collect is idempotent: the first terminal result wins", async () => {
  const fixture = makeRequest();
  try {
    const handle = await executor("ok").start(fixture.request, new AbortController().signal);
    const first = await handle.collect();
    const second = await handle.collect();
    assert.strictEqual(first, second, "the identical frozen object, not a re-classification");
    assert.ok(Object.isFrozen(first));
  } finally {
    cleanup(fixture);
  }
});

// ── failure classification ──────────────────────────────────────────────

test("non-zero exit classifies as worker_error with bounded diagnostics", async () => {
  const fixture = makeRequest();
  try {
    const handle = await executor("exit3").start(fixture.request, new AbortController().signal);
    const result = await handle.collect();
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, "worker_error");
    assert.equal(result.resultHeadSha, "");
    assert.match(result.diagnostics, /exitCode 3/);
  } finally {
    cleanup(fixture);
  }
});

test("a deadline expiry classifies as deadline", async () => {
  const fixture = makeRequest({ deadlineAtMs: Date.now() + 500 });
  try {
    const handle = await executor("sleep-long").start(fixture.request, new AbortController().signal);
    const result = await handle.collect();
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, "deadline");
  } finally {
    cleanup(fixture);
  }
});

test("a deadline already in the past is refused before launch: no spawn, no envelope, no state file", async () => {
  const fixture = makeRequest({ deadlineAtMs: Date.now() - 1_000 });
  try {
    const { launches, deps } = recordingDeps();
    const handle = await executor("ok", deps).start(fixture.request, new AbortController().signal);
    const result = await handle.collect();
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, "deadline");
    assert.notEqual(result.failureMessage, "");
    assert.equal(launches.length, 0, "no child was ever spawned");
    assert.deepEqual(await executor("ok").reconcile(fixture.request), { kind: "none" });
    let envelopeExists = false;
    try {
      readFileSync(fixture.request.requestPath);
      envelopeExists = true;
    } catch {
      // expected: nothing was written
    }
    let stateExists = false;
    try {
      readFileSync(path.join(fixture.request.runDir, EXECUTION_STATE_FILE));
      stateExists = true;
    } catch {
      // expected: nothing was written
    }
    assert.equal(envelopeExists, false, "no envelope was written");
    assert.equal(stateExists, false, "no state file was written");
    const report = await handle.observe();
    assert.equal(report.phase, "terminal");
    assert.equal(report.status, "failed");
  } finally {
    cleanup(fixture);
  }
});

test("a signalled worker classifies as worker_crash", async () => {
  const fixture = makeRequest();
  try {
    const handle = await executor("crash").start(fixture.request, new AbortController().signal);
    const result = await handle.collect();
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, "worker_crash");
  } finally {
    cleanup(fixture);
  }
});

test("exit 0 without a result file classifies as no_result", async () => {
  const fixture = makeRequest();
  try {
    const handle = await executor("silent").start(fixture.request, new AbortController().signal);
    const result = await handle.collect();
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, "no_result");
  } finally {
    cleanup(fixture);
  }
});

test("a result file from another correlation identity is stale_result, never collected", async () => {
  const fixture = makeRequest();
  try {
    const handle = await executor("wrong-run").start(fixture.request, new AbortController().signal);
    const result = await handle.collect();
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, "stale_result");
    assert.equal(result.resultHeadSha, "", "a foreign result never supplies a head");
  } finally {
    cleanup(fixture);
  }
});

// ── cancellation & refusal ──────────────────────────────────────────────

test("cancel tree-terminates the worker and settles cancelled, idempotently", async () => {
  const fixture = makeRequest();
  try {
    const controller = new AbortController();
    const handle = await executor("sleep-long").start(fixture.request, controller.signal);
    const before = await handle.observe();
    assert.equal(before.phase, "running");
    assert.equal(before.status, "");
    await handle.cancel();
    await handle.cancel(); // idempotent
    const result = await handle.collect();
    assert.equal(result.status, "cancelled");
    assert.equal(result.failureCategory, "");
    const after = await handle.observe();
    assert.equal(after.phase, "terminal");
    assert.equal(after.status, "cancelled");
  } finally {
    cleanup(fixture);
  }
});

test("a pre-aborted signal is refused before anything is written or launched", async () => {
  const fixture = makeRequest();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => executor("ok").start(fixture.request, controller.signal),
      /already aborted/,
    );
    let envelopeExists = false;
    try {
      readFileSync(fixture.request.requestPath);
      envelopeExists = true;
    } catch {
      // expected: nothing was written
    }
    assert.equal(envelopeExists, false, "no envelope was written");
  } finally {
    cleanup(fixture);
  }
});

test("a concurrent start with the same runId fails closed without touching the first run", async () => {
  const fixture = makeRequest();
  try {
    const executorInstance = executor("sleep-long");
    const controller = new AbortController();
    const first = executorInstance.start(fixture.request, controller.signal);
    await assert.rejects(
      () => executorInstance.start(fixture.request, new AbortController().signal),
      new RegExp(`execution ${fixture.request.runId} is already in flight`),
    );
    const handle = await first;
    await handle.cancel();
    const result = await handle.collect();
    assert.equal(result.status, "cancelled");
    // The first run's envelope is intact and untouched by the refused start.
    const envelope = JSON.parse(readFileSync(fixture.request.requestPath, "utf8"));
    assert.equal(envelope.runId, fixture.request.runId);
  } finally {
    cleanup(fixture);
  }
});

// ── the child env allowlist (#252-style boundary test) ──────────────────

test("the child env is the allowlist plus the two executor vars, whatever the request carries", async () => {
  // Hostile repository-config-shaped content in a request field: it must
  // never reach the child's environment or reshape its argv.
  const hostile = "owner/repo$(touch /tmp/pwned); rm -rf ~";
  const fixture = makeRequest({ repoFullName: hostile });
  try {
    const { launches, deps } = recordingDeps();
    const handle = await executor("ok", deps).start(fixture.request, new AbortController().signal);
    await handle.collect();

    assert.equal(launches.length, 1);
    const launch = launches[0]!;
    assert.equal(launch.file, process.execPath);
    assert.deepEqual([...launch.args], [WORKER, "ok", fixture.request.requestPath]);

    const allowed = new Set([
      "PATH",
      "HOME",
      "TMPDIR",
      EXECUTION_REQUEST_ENV_KEY,
      EXECUTION_RESULT_ENV_KEY,
    ]);
    for (const key of Object.keys(launch.env)) {
      assert.ok(allowed.has(key), `unexpected env key '${key}' reached the child`);
    }
    assert.equal(launch.env[EXECUTION_REQUEST_ENV_KEY], fixture.request.requestPath);
    assert.equal(launch.env[EXECUTION_RESULT_ENV_KEY], fixture.request.resultPath);
    assert.ok(
      !JSON.stringify(launch.env).includes("rm -rf"),
      "no request-derived value may leak into the child environment",
    );
  } finally {
    cleanup(fixture);
  }
});

// ── contract validation ─────────────────────────────────────────────────

test("validateExecutionRequest rejects unknown fields and sentinel violations", () => {
  const { request } = makeRequest();
  const valid = JSON.parse(JSON.stringify(request));
  assert.deepEqual({ ...validateExecutionRequest(valid) }, { ...request });

  assert.throws(() => validateExecutionRequest({ ...valid, extra: 1 }), /unsupported field 'extra'/);
  assert.throws(() => validateExecutionRequest({ ...valid, runId: "" }), /runId must be non-empty/);
  assert.throws(() => validateExecutionRequest({ ...valid, runId: "  " }), /runId must match/);
  assert.throws(() => validateExecutionRequest({ ...valid, runId: "has space" }), /runId must match/);
  assert.throws(() => validateExecutionRequest({ ...valid, jobId: "  " }), /jobId must match/);
  assert.throws(() => validateExecutionRequest({ ...valid, attempt: 0 }), /attempt must be an integer >= 1/);
  assert.throws(() => validateExecutionRequest({ ...valid, prNumber: 0 }), /prNumber must be an integer >= 1/);
  assert.throws(
    () => validateExecutionRequest({ ...valid, profiles: { ...valid.profiles, evidence: "" } }),
    /evidence must be non-empty/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, credentials: [{ name: "BAD", reference: "ref" }] }),
    /name must match/,
  );
  assert.throws(() => validateExecutionRequest({ ...valid, runDir: "relative/run" }), /runDir must be an absolute path/);
  assert.throws(() => validateExecutionRequest({ ...valid, requestPath: `${valid.runDir}/req\u0007.json` }), /requestPath must not contain control characters/);
  assert.throws(
    () => validateExecutionRequest({ ...valid, resultPath: `/elsewhere/result.json` }),
    /must be inside runDir/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, resultPath: `${valid.runDir}/../escape/result.json` }),
    /must not contain '\.\.' path segments/,
  );
});

test("validateExecutionResult enforces the per-status sentinel discipline", () => {
  const base = {
    status: "completed",
    runId: "run-1",
    jobId: "job-1",
    resultHeadSha: HEAD,
    failureCategory: "",
    failureMessage: "",
    resultArtifactPath: "/tmp/result.json",
    diagnostics: "",
    artifactPaths: [],
    resourceMs: 5,
    observedAtMs: 1,
  };
  assert.ok(Object.isFrozen(validateExecutionResult(base)));

  assert.throws(() => validateExecutionResult({ ...base, extra: 1 }), /unsupported field 'extra'/);
  assert.throws(
    () => validateExecutionResult({ ...base, resultHeadSha: "" }),
    /resultHeadSha must be non-empty when completed/,
  );
  assert.throws(
    () => validateExecutionResult({ ...base, resultArtifactPath: "" }),
    /resultArtifactPath must be non-empty when completed/,
  );
  assert.throws(
    () => validateExecutionResult({ ...base, status: "failed", resultHeadSha: HEAD }),
    /resultHeadSha must be '' unless completed/,
  );
  assert.throws(
    () => validateExecutionResult({ ...base, status: "failed", resultHeadSha: "" }),
    /failureCategory must be a failure category/,
  );
  assert.throws(
    () => validateExecutionResult({ ...base, status: "failed", failureCategory: "worker_error", failureMessage: "boom", resultHeadSha: HEAD }),
    /resultHeadSha must be '' unless completed/,
  );
  assert.throws(
    () => validateExecutionResult({ ...base, status: "cancelled", resultHeadSha: "", resultArtifactPath: "", failureCategory: "deadline" }),
    /failureCategory must be '' unless failed/,
  );
  assert.throws(() => validateExecutionResult({ ...base, runId: "  " }), /runId must match/);
  assert.throws(() => validateExecutionResult({ ...base, jobId: "" }), /jobId must match/);
  assert.throws(
    () => validateExecutionResult({ ...base, resultArtifactPath: "/tmp/out\u0007come.json" }),
    /must not contain control characters/,
  );
  assert.throws(
    () => validateExecutionResult({ ...base, artifactPaths: [`a${"b".repeat(4096)}`] }),
    /must be at most 4096 characters/,
  );
  assert.throws(
    () => validateExecutionResult({ ...base, resultArtifactPath: "/tmp/other/run/result.json" }, { runDir: "/tmp/other/run/nested" }),
    /must be inside runDir/,
  );
  assert.throws(
    () => validateExecutionResult(
      { ...base, resultArtifactPath: "/tmp/other/run/result.json", artifactPaths: ["/tmp/other/run/../escape.json"] },
      { runDir: "/tmp/other/run" },
    ),
    /must not contain '\.\.' path segments/,
  );
  assert.ok(
    validateExecutionResult({ ...base, resultArtifactPath: "/tmp/other/run/result.json" }, { runDir: "/tmp/other/run" }),
  );
});

// ── reconciliation after a controller restart ───────────────────────────

test("reconcile: no state file means nothing to collect", async () => {
  const fixture = makeRequest();
  try {
    assert.deepEqual(await executor("ok").reconcile(fixture.request), { kind: "none" });
  } finally {
    cleanup(fixture);
  }
});

test("reconcile: a recorded terminal completion returns its result", async () => {
  const fixture = makeRequest();
  try {
    const handle = await executor("ok").start(fixture.request, new AbortController().signal);
    const collected = await handle.collect();
    const outcome = await executor("ok").reconcile(fixture.request);
    assert.ok(outcome.kind === "settled");
    assert.equal(outcome.result.status, "completed");
    assert.equal(outcome.result.resultHeadSha, collected.resultHeadSha);
    assert.equal(outcome.result.resultArtifactPath, collected.resultArtifactPath);
  } finally {
    cleanup(fixture);
  }
});

test("reconcile: a foreign generation is never collected", async () => {
  const fixture = makeRequest();
  try {
    writeStateFile(fixture.request, {
      runId: "other-generation",
      jobId: fixture.request.jobId,
      attempt: 1,
      pid: 1,
      startedAtMs: 1,
      state: "running",
    });
    assert.deepEqual(await executor("ok").reconcile(fixture.request), { kind: "none" });
    writeStateFile(fixture.request, {
      runId: fixture.request.runId,
      jobId: fixture.request.jobId,
      attempt: 2,
      pid: 1,
      startedAtMs: 1,
      state: "running",
    });
    assert.deepEqual(await executor("ok").reconcile(fixture.request), { kind: "none" });
  } finally {
    cleanup(fixture);
  }
});

test("reconcile: a live pid reports running; a dead (or unassigned) pid without terminal state is orphaned", async () => {
  const fixture = makeRequest();
  const record = {
    runId: fixture.request.runId,
    jobId: fixture.request.jobId,
    attempt: 1,
    pid: 999_999,
    startedAtMs: 1,
    state: "running",
  };
  try {
    writeStateFile(fixture.request, record);
    assert.deepEqual(
      await executor("ok", { pidAlive: () => true }).reconcile(fixture.request),
      { kind: "running" },
    );
    const outcome = await executor("ok", { pidAlive: () => false }).reconcile(fixture.request);
    assert.ok(outcome.kind === "settled");
    assert.equal(outcome.result.status, "failed");
    assert.equal(outcome.result.failureCategory, "orphaned");
    // pid 0 (never assigned, e.g. a crash inside the launch window) is dead
    // by definition — the liveness probe is never called for it.
    let probed = false;
    writeStateFile(fixture.request, { ...record, pid: 0 });
    const outcomeZero = await executor("ok", {
      pidAlive: () => {
        probed = true;
        return true;
      },
    }).reconcile(fixture.request);
    assert.equal(probed, false, "pid 0 is never probed for liveness");
    assert.ok(outcomeZero.kind === "settled");
    assert.equal(outcomeZero.result.failureCategory, "orphaned");
  } finally {
    cleanup(fixture);
  }
});
