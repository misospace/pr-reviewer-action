/** Local reference executor (#733): envelope-before-launch, the child-env
 * allowlist (hostile repository data can never reach argv or env), the
 * ProcessResult → ExecutionResult classification (deadline, crash, error,
 * no_result, stale_result), first-terminal-wins idempotence, pre-abort
 * refusal, and post-restart reconciliation — end-to-end against a real
 * child process (`tests-v3/fixtures/executor-worker.mjs`), with the
 * runtime seams injected where isolation is needed. */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runProcess as realRunProcess, type ProcessHandle, type RunProcessOptions } from "../src/runtime/subprocess.js";
import {
  EXECUTION_REQUEST_ENV_KEY,
  EXECUTION_RESULT_ENV_KEY,
  EXECUTION_STATE_FILE,
  LocalExecutor,
  MAX_EXECUTION_FAILURE_MESSAGE_CHARS,
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

/** Wait until the recovery record carries the worker's pid — the only
 * identity a restarted controller has to work from. */
async function waitForRecordedPid(request: ExecutionRequest, timeoutMs = 5_000): Promise<number> {
  const statePath = path.join(request.runDir, EXECUTION_STATE_FILE);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(readFileSync(statePath, "utf8")) as { pid?: unknown };
      if (typeof record.pid === "number" && record.pid > 0) return record.pid;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return 0;
}

/** The real liveness probe: a pid that still answers `kill(pid, 0)` is
 * still a process (a zombie counts — it is not reaped yet). */
function pidAliveNow(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A detached sleeper that must survive a cancellation it is not part of. */
function spawnSurvivor(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid ?? 0;
  return {
    pid,
    stop: () => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
      child.unref();
    },
  };
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

// ── containment: the envelope/result paths must really live in the run dir ──

test("a symlinked directory below runDir refuses the launch: no child, no envelope, no outside write", async () => {
  // Lexical containment is not containment: a planted `runDir/sub ->
  // outside` symlink would send the envelope write (and the result read)
  // outside the run directory. The launch is refused instead.
  const fixture = makeRequest();
  try {
    const outside = path.join(fixture.root, "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(fixture.request.runDir, { recursive: true });
    symlinkSync(outside, path.join(fixture.request.runDir, "sub"), "dir");
    const request = Object.freeze({
      ...fixture.request,
      requestPath: path.join(fixture.request.runDir, "sub", "request.json"),
      resultPath: path.join(fixture.request.runDir, "sub", "result.json"),
    });
    const { launches, deps } = recordingDeps();
    const handle = await executor("ok", deps).start(request, new AbortController().signal);
    const result = await handle.collect();
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, "launch_refused");
    assert.match(result.failureMessage, /is a symbolic link|outside/);
    assert.equal(launches.length, 0, "no child was ever spawned");
    assert.equal(existsSync(path.join(outside, "request.json")), false, "no envelope escaped");
    assert.equal(existsSync(path.join(outside, "result.json")), false, "no result escaped");
  } finally {
    cleanup(fixture);
  }
});

test("a symlinked envelope path refuses the launch and never overwrites the file it points at", async () => {
  // The envelope path itself is a symlink to an outside file: the write
  // must never follow it, and the launch is refused before anything runs.
  const fixture = makeRequest();
  try {
    const outsideFile = path.join(fixture.root, "outside", "request.json");
    mkdirSync(path.dirname(outsideFile), { recursive: true });
    writeFileSync(outsideFile, "SENTINEL", "utf8");
    mkdirSync(fixture.request.runDir, { recursive: true });
    symlinkSync(outsideFile, fixture.request.requestPath);
    const { launches, deps } = recordingDeps();
    const handle = await executor("ok", deps).start(fixture.request, new AbortController().signal);
    const result = await handle.collect();
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, "launch_refused");
    assert.match(result.failureMessage, /is a symbolic link/);
    assert.equal(launches.length, 0, "no child was ever spawned");
    assert.equal(readFileSync(outsideFile, "utf8"), "SENTINEL", "the outside file was never overwritten");
  } finally {
    cleanup(fixture);
  }
});

test("a symlinked result path planted after launch is never read through", async () => {
  // The worker writes nothing; a symlink is planted at the result path
  // pointing at a perfectly valid completed result for THIS run. Reading
  // through it would report "completed" — the executor must refuse the
  // symlink and settle the run as a missing result.
  const fixture = makeRequest();
  try {
    const outsideFile = path.join(fixture.root, "outside", "result.json");
    mkdirSync(path.dirname(outsideFile), { recursive: true });
    writeFileSync(
      outsideFile,
      JSON.stringify({
        status: "completed",
        runId: fixture.request.runId,
        jobId: fixture.request.jobId,
        resultHeadSha: HEAD,
        resultArtifactPath: fixture.request.resultPath,
        failureCategory: "",
        failureMessage: "",
        diagnostics: "",
        artifactPaths: [],
        resourceMs: 1,
        observedAtMs: 1,
      }),
      "utf8",
    );
    const handle = await executor("delayed-silent").start(
      fixture.request,
      new AbortController().signal,
    );
    symlinkSync(outsideFile, fixture.request.resultPath);
    const result = await handle.collect();
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, "no_result");
    assert.equal(result.resultHeadSha, "", "the result was never read through the symlink");
  } finally {
    cleanup(fixture);
  }
});

test("an oversized result file is refused by the byte cap before it is parsed", async () => {
  // The result file is the untrusted surface: a worker must not be able
  // to make the executor allocate an unbounded result.
  const fixture = makeRequest();
  try {
    const handle = await executor("huge-result").start(
      fixture.request,
      new AbortController().signal,
    );
    const result = await handle.collect();
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, "no_result");
    assert.equal(result.resultHeadSha, "");
  } finally {
    cleanup(fixture);
  }
});

test("a nested envelope path whose parent does not exist yet is created inside the run directory", async () => {
  // The proof creates the missing parent components INSIDE the run
  // directory (a symlinked component is refused, never followed), so a
  // nested envelope path stays usable instead of being refused.
  const fixture = makeRequest();
  try {
    const nested = path.join(fixture.request.runDir, "nested", "deeper");
    const request = Object.freeze({
      ...fixture.request,
      requestPath: path.join(nested, "request.json"),
      resultPath: path.join(nested, "result.json"),
    });
    const handle = await executor("ok").start(request, new AbortController().signal);
    const result = await handle.collect();
    assert.equal(result.status, "completed");
    const envelope = JSON.parse(readFileSync(request.requestPath, "utf8"));
    assert.equal(envelope.runId, request.runId);
    assert.equal(existsSync(path.join(nested, "result.json")), true);
  } finally {
    cleanup(fixture);
  }
});

test("the executor's own result satisfies the result contract even when a path is very long", async () => {
  // The refusal message embeds the offending path, and the request
  // contract allows long paths: the message must be truncated to the
  // contract's cap, or the executor would produce a result its own
  // validator (and the queue seam) rejects.
  const fixture = makeRequest();
  try {
    const deep = path.join(fixture.root, ...Array.from({ length: 40 }, (_, index) => `d${index}`.padEnd(60, "x")));
    mkdirSync(deep, { recursive: true });
    const runDir = path.join(deep, "run");
    mkdirSync(runDir, { recursive: true });
    const outsideFile = path.join(fixture.root, "outside-long.json");
    writeFileSync(outsideFile, "SENTINEL", "utf8");
    const request = Object.freeze({
      ...fixture.request,
      runDir,
      requestPath: path.join(runDir, "request.json"),
      resultPath: path.join(runDir, "result.json"),
    });
    symlinkSync(outsideFile, request.requestPath);
    const handle = await executor("ok").start(request, new AbortController().signal);
    const result = await handle.collect();
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, "launch_refused");
    assert.ok(
      result.failureMessage.length <= MAX_EXECUTION_FAILURE_MESSAGE_CHARS,
      `the refusal message must respect the contract cap (was ${result.failureMessage.length})`,
    );
    // The executor's own result must pass the contract it is validated
    // against — that is what the queue seam re-checks.
    assert.ok(validateExecutionResult(result));
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

  // Bounded free-text fields and a bounded artifact list: the result is
  // attacker-sized data, so the contract caps what the executor may hold.
  assert.throws(
    () => validateExecutionResult({ ...base, diagnostics: "d".repeat(8001) }),
    /execution result\.diagnostics must be at most 8000 characters/,
  );
  assert.ok(validateExecutionResult({ ...base, diagnostics: "d".repeat(8000) }));
  assert.throws(
    () => validateExecutionResult({
      ...base,
      status: "failed",
      resultHeadSha: "",
      resultArtifactPath: "",
      failureCategory: "worker_error",
      failureMessage: "m".repeat(2001),
    }),
    /execution result\.failureMessage must be at most 2000 characters/,
  );
  assert.ok(validateExecutionResult({
    ...base,
    status: "failed",
    resultHeadSha: "",
    resultArtifactPath: "",
    failureCategory: "worker_error",
    failureMessage: "m".repeat(2000),
  }));
  assert.throws(
    () => validateExecutionResult({
      ...base,
      artifactPaths: Array.from({ length: 65 }, (_, index) => `/tmp/artifact-${index}.json`),
    }),
    /execution result\.artifactPaths must have at most 64 entries/,
  );
  assert.ok(validateExecutionResult({
    ...base,
    artifactPaths: Array.from({ length: 64 }, (_, index) => `/tmp/artifact-${index}.json`),
  }));
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

test("reconcile: a symlinked or oversized recovery record is refused, never read through", async () => {
  // The recovery record lives in worker-writable space: it is read
  // no-follow and byte-capped, so a planted symlink (or blob) can
  // neither redirect the read nor make the controller allocate without
  // bound. An unreadable record means "nothing to collect".
  const fixture = makeRequest();
  try {
    mkdirSync(fixture.request.runDir, { recursive: true });
    const outsideFile = path.join(fixture.root, "outside-state.json");
    writeFileSync(outsideFile, JSON.stringify({ runId: "x" }), "utf8");
    symlinkSync(outsideFile, path.join(fixture.request.runDir, EXECUTION_STATE_FILE));
    assert.deepEqual(await executor("ok").reconcile(fixture.request), { kind: "none" });

    // An oversized record is refused the same way.
    rmSync(path.join(fixture.request.runDir, EXECUTION_STATE_FILE), { force: true });
    writeFileSync(
      path.join(fixture.request.runDir, EXECUTION_STATE_FILE),
      JSON.stringify({ runId: fixture.request.runId, blob: "x".repeat(64 * 1024) }),
      "utf8",
    );
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

// ── correlation-keyed cancellation ───────────────────────────────────────

test("cancel: a live in-memory run is cancelled through the handle's own termination", async () => {
  const fixture = makeRequest();
  try {
    const local = executor("sleep-long");
    const handle = await local.start(fixture.request, new AbortController().signal);
    const pid = await waitForRecordedPid(fixture.request);
    assert.ok(pid > 0, "the recovery record carries the worker's pid");
    const outcome = await local.cancel(fixture.request);
    assert.deepEqual(outcome, { kind: "terminated" });
    const result = await handle.collect();
    assert.equal(result.status, "cancelled");
    assert.equal(result.failureCategory, "");
    assert.equal(pidAliveNow(pid), false, "the worker process is really gone");
  } finally {
    cleanup(fixture);
  }
});

test("cancel: a recovered run is terminated by its correlation identity", async () => {
  // The controller restarted: the in-memory handle is gone and only the
  // durable recovery record survives. The cancellation still finds the
  // worker — by identity, not by a handle.
  const fixture = makeRequest();
  try {
    const handle = await executor("sleep-long").start(fixture.request, new AbortController().signal);
    const pid = await waitForRecordedPid(fixture.request);
    assert.ok(pid > 0, "the recovery record carries the worker's pid");

    // A SECOND executor instance over the same run directory.
    const outcome = await executor("sleep-long").cancel(fixture.request);
    assert.deepEqual(outcome, { kind: "terminated" });
    assert.equal(pidAliveNow(pid), false, "the worker process is really gone");

    // The executor that still holds the handle settles the run it lost:
    // the worker died to a signal it did not choose.
    const result = await handle.collect();
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, "worker_crash");
  } finally {
    cleanup(fixture);
  }
});

test("cancel: a foreign recovery record is never terminated", async () => {
  // The record names another generation: it is not this run's worker, so
  // the cancellation must not touch the process it points at.
  const fixture = makeRequest();
  const survivor = spawnSurvivor();
  try {
    writeStateFile(fixture.request, {
      runId: "other-generation",
      jobId: fixture.request.jobId,
      attempt: 1,
      pid: survivor.pid,
      startedAtMs: 1,
      state: "running",
    });
    const outcome = await executor("ok").cancel(fixture.request);
    assert.deepEqual(outcome, { kind: "failed", reason: "worker-not-terminated" });
    assert.equal(pidAliveNow(survivor.pid), true, "the foreign worker was never terminated");
  } finally {
    survivor.stop();
    cleanup(fixture);
  }
});

test("cancel: a termination that cannot be confirmed fails closed", async () => {
  // The termination seam reports failure: the worker may still be running,
  // so the outcome must be `failed`, never a terminated worker.
  const fixture = makeRequest();
  const survivor = spawnSurvivor();
  try {
    writeStateFile(fixture.request, {
      runId: fixture.request.runId,
      jobId: fixture.request.jobId,
      attempt: 1,
      pid: survivor.pid,
      pidIdentity: "identity-token",
      startedAtMs: 1,
      state: "running",
    });
    let attempts = 0;
    const outcome = await executor("ok", {
      pidAlive: () => true,
      pidIdentity: async () => "identity-token",
      terminate: async () => {
        attempts += 1;
        return false;
      },
    }).cancel(fixture.request);
    assert.deepEqual(outcome, { kind: "failed", reason: "worker-not-terminated" });
    assert.equal(attempts, 1, "the termination was attempted");
    assert.equal(pidAliveNow(survivor.pid), true, "the worker may still be running");
  } finally {
    survivor.stop();
    cleanup(fixture);
  }
});

test("cancel: cancelling twice reports terminated both times and terminates once", async () => {
  const fixture = makeRequest();
  try {
    let alive = true;
    let terminations = 0;
    const recovered = executor("ok", {
      pidAlive: () => alive,
      pidIdentity: async () => "identity-token",
      terminate: async () => {
        terminations += 1;
        alive = false;
        return true;
      },
    });
    writeStateFile(fixture.request, {
      runId: fixture.request.runId,
      jobId: fixture.request.jobId,
      attempt: 1,
      pid: 4242,
      pidIdentity: "identity-token",
      startedAtMs: 1,
      state: "running",
    });
    const first = await recovered.cancel(fixture.request);
    const second = await recovered.cancel(fixture.request);
    assert.deepEqual(first, { kind: "terminated" });
    assert.deepEqual(second, { kind: "terminated" });
    assert.equal(terminations, 1, "the second cancellation terminates nothing again");
  } finally {
    cleanup(fixture);
  }
});

test("cancel: missing, malformed, and pid-zero recovery evidence fails closed", async () => {
  const fixture = makeRequest();
  try {
    const local = executor("ok");
    assert.deepEqual(
      await local.cancel(fixture.request),
      { kind: "failed", reason: "worker-not-terminated" },
      "a missing state record cannot prove the worker is absent",
    );

    mkdirSync(fixture.request.runDir, { recursive: true });
    writeFileSync(path.join(fixture.request.runDir, EXECUTION_STATE_FILE), "{not-json", "utf8");
    assert.deepEqual(
      await local.cancel(fixture.request),
      { kind: "failed", reason: "worker-not-terminated" },
      "a malformed state record cannot prove the worker is absent",
    );

    writeStateFile(fixture.request, {
      runId: fixture.request.runId,
      jobId: fixture.request.jobId,
      attempt: 1,
      pid: 0,
      startedAtMs: 1,
      state: "starting",
    });
    assert.deepEqual(
      await local.cancel(fixture.request),
      { kind: "failed", reason: "worker-not-terminated" },
      "pid 0 is a crash-window marker, not proof that spawn never happened",
    );
  } finally {
    cleanup(fixture);
  }
});

test("cancel: an in-memory cleanup that leaves an unconfirmed tree fails instead of claiming cancelled", async () => {
  const fixture = makeRequest();
  try {
    let resolveResult!: (value: Awaited<ProcessHandle["result"]>) => void;
    const result = new Promise<Awaited<ProcessHandle["result"]>>((resolve) => {
      resolveResult = resolve;
    });
    const fakeHandle: ProcessHandle = {
      pid: 4242,
      launched: Promise.resolve(),
      launchRefusal: null,
      result,
      abort: async () => {
        resolveResult({
          status: "cancelled",
          exitCode: null,
          signal: "SIGTERM",
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 1,
          termination: {
            swept: true,
            snapshot: [4243],
            killedAfterGrace: [],
            survived: [4243],
            issues: [],
          },
        });
      },
    };
    const local = executor("ok", {
      runProcess: () => fakeHandle,
      pidAlive: () => true,
      pidIdentity: async () => "identity-token",
    });
    const handle = await local.start(fixture.request, new AbortController().signal);
    const outcome = await local.cancel(fixture.request);
    assert.deepEqual(outcome, { kind: "failed", reason: "worker-not-terminated" });

    const collected = await handle.collect();
    assert.equal(collected.status, "failed");
    assert.equal(collected.failureCategory, "terminate_failed");
    assert.match(collected.failureMessage, /could not be confirmed terminated/);
  } finally {
    cleanup(fixture);
  }
});

test("cancel: a structurally invalid request is refused before anything is touched", async () => {
  const fixture = makeRequest();
  try {
    await assert.rejects(
      () => executor("ok").cancel({ ...fixture.request, attempt: 0 } as ExecutionRequest),
      /attempt must be an integer >= 1/,
    );
  } finally {
    cleanup(fixture);
  }
});

test("cancel: a pid that can never be this run's worker is refused, never signalled", async () => {
  // The recovery record lives in worker-writable space: a planted pid
  // must never become a signal. pid 1 is init — and the runtime's tree
  // termination signals the PROCESS GROUP, so `kill(-1, …)` would reach
  // every process the controller may signal — and the controller's own
  // pid is just as fatal.
  const fixture = makeRequest();
  try {
    let terminations = 0;
    for (const pid of [1, process.pid]) {
      writeStateFile(fixture.request, {
        runId: fixture.request.runId,
        jobId: fixture.request.jobId,
        attempt: 1,
        pid,
        pidIdentity: "identity-token",
        startedAtMs: 1,
        state: "running",
      });
      const outcome = await executor("ok", {
        pidIdentity: async () => "identity-token",
        terminate: async () => {
          terminations += 1;
          return true;
        },
      }).cancel(fixture.request);
      assert.deepEqual(
        outcome,
        { kind: "failed", reason: "worker-not-terminated" },
        `pid ${pid} must be refused`,
      );
    }
    assert.equal(terminations, 0, "an unproven pid is never signalled");
  } finally {
    cleanup(fixture);
  }
});

test("cancel: a recorded pid whose process identity no longer matches is refused", async () => {
  // The pid may have been RECYCLED: the recorded token is the process
  // instance's start time, so a different token means the live process is
  // NOT the recorded worker — signalling it would kill an unrelated
  // process.
  const fixture = makeRequest();
  const survivor = spawnSurvivor();
  try {
    writeStateFile(fixture.request, {
      runId: fixture.request.runId,
      jobId: fixture.request.jobId,
      attempt: 1,
      pid: survivor.pid,
      pidIdentity: "recorded-token",
      startedAtMs: 1,
      state: "running",
    });
    let terminations = 0;
    const outcome = await executor("ok", {
      pidIdentity: async () => "other-token",
      terminate: async () => {
        terminations += 1;
        return true;
      },
    }).cancel(fixture.request);
    assert.deepEqual(outcome, { kind: "failed", reason: "worker-not-terminated" });
    assert.equal(terminations, 0, "an unproven pid is never signalled");
    assert.equal(pidAliveNow(survivor.pid), true, "the unrelated process was never signalled");
  } finally {
    survivor.stop();
    cleanup(fixture);
  }
});

test("cancel: a record without a process identity is refused, never signalled", async () => {
  // An older record (or a planted one) carries no identity at all: the
  // pid alone proves nothing, so the recovered cancellation fails closed.
  const fixture = makeRequest();
  const survivor = spawnSurvivor();
  try {
    writeStateFile(fixture.request, {
      runId: fixture.request.runId,
      jobId: fixture.request.jobId,
      attempt: 1,
      pid: survivor.pid,
      startedAtMs: 1,
      state: "running",
    });
    let terminations = 0;
    const outcome = await executor("ok", {
      pidIdentity: async () => "identity-token",
      terminate: async () => {
        terminations += 1;
        return true;
      },
    }).cancel(fixture.request);
    assert.deepEqual(outcome, { kind: "failed", reason: "worker-not-terminated" });
    assert.equal(terminations, 0, "an unproven pid is never signalled");
    assert.equal(pidAliveNow(survivor.pid), true, "the unrelated process was never signalled");
  } finally {
    survivor.stop();
    cleanup(fixture);
  }
});

test("cancel: a recorded pid whose process identity still matches is terminated", async () => {
  // The proof succeeded: the live process IS the recorded worker, so the
  // termination may happen.
  const fixture = makeRequest();
  const survivor = spawnSurvivor();
  try {
    writeStateFile(fixture.request, {
      runId: fixture.request.runId,
      jobId: fixture.request.jobId,
      attempt: 1,
      pid: survivor.pid,
      pidIdentity: "identity-token",
      startedAtMs: 1,
      state: "running",
    });
    let alive = true;
    let terminatedPid = 0;
    const outcome = await executor("ok", {
      pidAlive: () => alive,
      pidIdentity: async () => "identity-token",
      terminate: async (pid) => {
        terminatedPid = pid;
        alive = false;
        return true;
      },
    }).cancel(fixture.request);
    assert.deepEqual(outcome, { kind: "terminated" });
    assert.equal(terminatedPid, survivor.pid, "the proven worker was the one terminated");
  } finally {
    survivor.stop();
    cleanup(fixture);
  }
});

test("the recovery record carries the worker's process identity next to its pid", async () => {
  // The identity is what makes a recovered cancellation provable, so it
  // must survive into the record the terminal write leaves behind.
  const fixture = makeRequest();
  try {
    const handle = await executor("sleep-long").start(fixture.request, new AbortController().signal);
    const pid = await waitForRecordedPid(fixture.request);
    assert.ok(pid > 0, "the recovery record carries the worker's pid");
    const running = JSON.parse(readFileSync(path.join(fixture.request.runDir, EXECUTION_STATE_FILE), "utf8"));
    assert.equal(typeof running.pidIdentity, "string");
    assert.notEqual(running.pidIdentity, "", "the identity is proven, not empty");
    await handle.cancel();
    await handle.collect();
    const terminal = JSON.parse(readFileSync(path.join(fixture.request.runDir, EXECUTION_STATE_FILE), "utf8"));
    assert.equal(terminal.pidIdentity, running.pidIdentity, "the identity survives the terminal write");
  } finally {
    cleanup(fixture);
  }
});
