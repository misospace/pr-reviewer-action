/** Local reference executor (#733): envelope-before-launch, the child-env
 * allowlist (hostile repository data can never reach argv or env), the
 * ProcessResult → ExecutionResult classification (deadline, crash, error,
 * no_result, stale_result), first-terminal-wins idempotence, pre-abort
 * refusal, and post-restart reconciliation — end-to-end against a real
 * child process (`tests-v3/fixtures/executor-worker.mjs`), with the
 * runtime seams injected where isolation is needed.
 *
 * The worker-liveness probe (#1383) is exercised through the DEFAULT
 * probe — the one the executor ships — against a real unreaped zombie:
 * liveness means "can this pid still execute", not "does it answer
 * `kill(pid, 0)`". */

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
    forgeApiUrl: "https://api.github.com",
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

/**
 * Wait until the pid stops answering the raw signal probe — the pid is
 * really gone from the process table.
 *
 * A bounded poll, never a single sample: the executor confirms a worker's
 * death as soon as it can no longer EXECUTE (#1383), and the OS releases the
 * pid only afterwards (the controller reaps the zombie a moment later), so
 * a single sample right after a confirmed cancellation races the reap.
 */
async function waitForProcessGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAliveNow(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !pidAliveNow(pid);
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

// ── the zombie fixture (#1383) ──────────────────────────────────────────

/** `/proc/<pid>/stat` field 3 (`state`), parsed AFTER the last `)` — the
 * `comm` field may contain spaces AND parentheses, so splitting the whole
 * line mis-counts every field behind it. "" when unreadable. */
function procState(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return "";
    return stat.slice(close + 1).trim().split(/\s+/)[0] ?? "";
  } catch {
    return "";
  }
}

/** `/proc/<pid>/stat` field 5 (`pgrp`) — the PROCESS GROUP a pid belongs
 * to. 0 when unreadable. */
function procGroup(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return 0;
    // The remainder starts at field 3 (`state`), so field 5 (`pgrp`) is
    // its third element.
    return Number.parseInt(stat.slice(close + 1).trim().split(/\s+/)[2] ?? "", 10);
  } catch {
    return 0;
  }
}

/** `/proc/<pid>/stat` field 22 (`starttime`) — the PROCESS IDENTITY the
 * executor records next to a pid. "" when unprovable. */
function procStartTime(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return "";
    // The remainder starts at field 3 (`state`), so field 22 is its 20th
    // element.
    return stat.slice(close + 1).trim().split(/\s+/)[19] ?? "";
  } catch {
    return "";
  }
}

/** Whether this platform can describe a pid at all. The zombie-vs-alive
 * distinction is Linux-only by design: elsewhere the executor's probe
 * falls back to the raw signal probe. */
const hasProc = (() => procState(process.pid).length > 0)();

const NO_PROC_SKIP_REASON =
  "no /proc on this platform: the zombie-vs-alive distinction is Linux-only by design (the executor's default probe falls back to the raw signal probe elsewhere, and every other fixture in this file still runs)";

/** Launch-side readiness ceiling: generous, because a cold `bash` boot
 * plus a pid-file write can exceed a tight ceiling on a loaded runner
 * with no product fault (#1377). The waits poll for success and return
 * the moment the state appears, so the ceiling costs nothing when
 * healthy and fails, naming what never happened, when it truly does not. */
const ZOMBIE_WAIT_MS = 30_000;

/**
 * The boundary token itself, not a benign stand-in (#252): a real
 * unreaped zombie. `bash` backgrounds a short `sleep` and then blocks in
 * its own foreground command — bash does not reap background jobs while a
 * foreground command holds it, so the exited child stays a ZOMBIE. The
 * holder must stay ALIVE for the whole assertion window: once bash is
 * gone the zombie is reaped (or re-parented to an init that may reap it)
 * and the boundary token vanishes.
 */
function zombieHolderScript(pidFile: string): string[] {
  return ["-c", `sleep 0.2 & echo $! > ${JSON.stringify(pidFile)}; sleep 60`];
}

/** Poll `/proc` until the pid is a confirmed zombie, or fail with the last
 * observed state so a host that reaps too fast is explicit, not silent. */
async function awaitZombie(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + ZOMBIE_WAIT_MS;
  let state = "";
  while (Date.now() < deadline) {
    state = procState(pid);
    if (state === "Z") return;
    if (state === "") {
      throw new Error(`${label}: pid ${pid} vanished before it could be observed as a zombie`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label}: pid ${pid} never reached zombie state (last observed state '${state}')`);
}

interface ZombieFixture {
  /** The pid of the unreaped zombie — the boundary token itself. */
  readonly zombiePid: number;
  /** The zombie's PROCESS IDENTITY (its start time), exactly as the
   * executor records it next to a pid. */
  readonly pidIdentity: string;
  /** Kill the holder (which takes the zombie with it) and clean up. */
  readonly stop: () => void;
}

/** The zombie fixture needs `bash`: a host without it cannot produce the
 * boundary token, so the zombie tests SKIP rather than fail. */
const BASH_MISSING_SKIP_REASON = "bash is required for the zombie fixture";

/** Spawn the zombie fixture: a bash holder that backgrounds a short
 * `sleep` and then blocks, so the exited child stays an unreaped zombie
 * for as long as the holder lives. `null` when `bash` cannot be launched
 * (the caller skips). */
async function spawnZombie(): Promise<ZombieFixture | null> {
  const dir = mkdtempSync(path.join(tmpdir(), "executor-local-zombie-"));
  const pidFile = path.join(dir, "zombie.pid");
  // DETACHED: the holder leads its OWN process group, so the fixture can
  // never signal the test runner's process group — the group kill below
  // reaches the holder and its descendants only.
  const holder = spawn("bash", zombieHolderScript(pidFile), { detached: true, stdio: "ignore" });
  const failures: Error[] = [];
  holder.on("error", (error) => {
    failures.push(error);
  });
  const stop = (): void => {
    const holderPid = holder.pid;
    if (holderPid !== undefined) {
      // The holder's foreground `sleep 60` belongs to the holder's group:
      // a leader-only kill would orphan it and leave it running for a
      // minute after the test. The group kill takes the whole fixture
      // down; the leader kill is only the fallback for a group that is
      // already gone.
      try {
        process.kill(-holderPid, "SIGKILL");
      } catch {
        try {
          process.kill(holderPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    holder.unref();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + ZOMBIE_WAIT_MS;
    let written = false;
    while (Date.now() < deadline) {
      const failure = failures[0];
      if (failure !== undefined) {
        const code = (failure as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          // No `bash` on this host: the boundary token cannot be produced.
          stop();
          return null;
        }
        throw new Error(`the zombie holder could not be launched: ${failure.message}`);
      }
      try {
        if (readFileSync(pidFile, "utf8").trim().length > 0) {
          written = true;
          break;
        }
      } catch {
        // not written yet
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!written) {
      throw new Error(`the zombie holder never wrote its pid file: ${pidFile}`);
    }
    const zombiePid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    await awaitZombie(zombiePid, "executor-local zombie");
    return { zombiePid, pidIdentity: procStartTime(zombiePid), stop };
  } catch (error) {
    stop();
    throw error;
  }
}

/** The #252 discipline: the boundary token is fed to the boundary itself.
 * The pid must really be an unreaped zombie AND the raw signal probe must
 * really keep answering for it — without the latter, a probe that merely
 * wrapped `kill(pid, 0)` would pass every assertion that follows. */
function assertZombieBoundary(zombie: ZombieFixture): void {
  assert.equal(procState(zombie.zombiePid), "Z", "fixture precondition: an unreaped zombie");
  assert.doesNotThrow(
    () => process.kill(zombie.zombiePid, 0),
    "zombie precondition: the raw signal probe keeps answering for a pid that cannot execute",
  );
  assert.notEqual(zombie.pidIdentity, "", "the zombie's process identity is provable");
}

/** The group-leader fixture needs `setsid` to make the worker lead its own
 * session and process group; without it the fixture cannot produce the
 * boundary token, so the caller skips rather than fails. */
function setsidAvailable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = spawn("setsid", ["true"], { stdio: "ignore" });
    // A successful exec is proven by `close`; any launch error means the
    // boundary token cannot be produced here.
    probe.on("error", () => resolve(false));
    probe.on("close", () => resolve(true));
  });
}

interface ZombieGroupLeaderFixture {
  /** The pid of the unreaped zombie — the boundary token itself. It IS the
   * process-group leader: its pgid equals its pid. */
  readonly leaderPid: number;
  /** The zombie leader's PROCESS IDENTITY (its start time), exactly as the
   * executor records it next to a pid. */
  readonly leaderPidIdentity: string;
  /** A live member of the zombie leader's process group — the shape a
   * recovered worker's orphaned descendants take (#1390). */
  readonly survivingPid: number;
  /** Kill the whole fixture and clean up. */
  readonly stop: () => void;
}

/** Spawn a zombie PROCESS-GROUP LEADER with a surviving group member — the
 * #1390 leak shape itself, not a benign stand-in (#252):
 *
 * the holder backgrounds a `setsid` bash, so the worker leads its own
 * session and process group; that worker spawns a long `sleep` (a member
 * of the worker's group — non-interactive bash has no job control, so
 * background children stay in the shell's group) and then blocks; the
 * test kills the worker. The `exec sleep 60` is the REAPING FIREWALL: by
 * the time the leader is killed, the holder process IS a plain `sleep` —
 * no `wait()` can ever run in it — so the killed group leader stays an
 * unreaped zombie for the whole assertion window instead of being reaped
 * out from under the test.
 *
 * The surviving member is re-parented the moment its leader dies (Linux
 * re-parents at death, not at reap), which is exactly why `pgrep -P`
 * cannot find it and ONLY the tree termination's group kill can reach it.
 *
 * `null` when `bash` or `setsid` cannot be launched (the caller skips). */
async function spawnZombieGroupLeader(): Promise<ZombieGroupLeaderFixture | null> {
  const dir = mkdtempSync(path.join(tmpdir(), "executor-local-zombie-leader-"));
  const leaderFile = path.join(dir, "leader.pid");
  const survivingFile = path.join(dir, "surviving.pid");
  // DETACHED: the holder leads its own process group, so the fixture can
  // never signal the test runner's process group — the group kill below
  // reaches the holder and its descendants only.
  const holder = spawn(
    "bash",
    [
      "-c",
      `setsid bash -c 'sleep 600 & echo $$ > ${JSON.stringify(leaderFile)}; echo $! > ${JSON.stringify(survivingFile)}; sleep 30' & exec sleep 60`,
    ],
    { detached: true, stdio: "ignore" },
  );
  const failures: Error[] = [];
  holder.on("error", (error) => {
    failures.push(error);
  });
  let leaderPid = 0;
  const stop = (): void => {
    if (leaderPid > 0) {
      // The leader's group first — the surviving member and the leader's
      // own foreground sleep — then a direct hit on the leader. ESRCH-safe:
      // any piece may already be gone. Killing the holder last lets init
      // reap the leader's zombie.
      try {
        process.kill(-leaderPid, "SIGKILL");
      } catch {
        // the group is already gone
      }
      try {
        process.kill(leaderPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    const holderPid = holder.pid;
    if (holderPid !== undefined) {
      try {
        process.kill(holderPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    holder.unref();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    if (!(await setsidAvailable())) {
      stop();
      return null;
    }
    const deadline = Date.now() + ZOMBIE_WAIT_MS;
    let written = false;
    while (Date.now() < deadline) {
      const failure = failures[0];
      if (failure !== undefined) {
        const code = (failure as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          // No `bash` on this host: the boundary token cannot be produced.
          stop();
          return null;
        }
        throw new Error(`the zombie-leader holder could not be launched: ${failure.message}`);
      }
      try {
        if (
          readFileSync(leaderFile, "utf8").trim().length > 0 &&
          readFileSync(survivingFile, "utf8").trim().length > 0
        ) {
          written = true;
          break;
        }
      } catch {
        // not written yet
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!written) {
      throw new Error(`the zombie-leader holder never wrote its pid files: ${leaderFile}, ${survivingFile}`);
    }
    leaderPid = Number.parseInt(readFileSync(leaderFile, "utf8"), 10);
    const survivingPid = Number.parseInt(readFileSync(survivingFile, "utf8"), 10);
    // Kill the leader and wait for the zombie. The parent is a plain
    // `sleep` (it cannot wait()), so the zombie is stable for the whole
    // assertion window. ESRCH-safe: on a pathologically slow host the
    // holder's `sleep 60` may already have expired, leaving the leader
    // re-parented and reaped — awaitZombie then fails loudly, naming what
    // never happened.
    try {
      process.kill(leaderPid, "SIGKILL");
    } catch {
      // already gone
    }
    await awaitZombie(leaderPid, "executor-local zombie group leader");
    // The surviving member must still be alive — a vanished member means
    // the fixture produced nothing to sweep.
    const survivorDeadline = Date.now() + ZOMBIE_WAIT_MS;
    while (Date.now() < survivorDeadline) {
      const survivorState = procState(survivingPid);
      if (survivorState === "") {
        throw new Error(
          "executor-local zombie group leader: the surviving member vanished before it could be observed",
        );
      }
      if (survivorState === "S" || survivorState === "R") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(procState(survivingPid) === "S" || procState(survivingPid) === "R")) {
      throw new Error(
        "executor-local zombie group leader: the surviving member never reached a live state",
      );
    }
    return { leaderPid, leaderPidIdentity: procStartTime(leaderPid), survivingPid, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

/** The #252 discipline for the group-leader fixture: the recorded pid must
 * really be an unreaped zombie AND the process-group leader, and the group
 * must still hold a live member — without these, a sweep test would pass
 * against a fixture that never produced the leak shape. */
function assertZombieGroupLeaderBoundary(zombie: ZombieGroupLeaderFixture): void {
  assert.equal(
    procState(zombie.leaderPid),
    "Z",
    "fixture precondition: the leader is an unreaped zombie",
  );
  assert.doesNotThrow(
    () => process.kill(zombie.leaderPid, 0),
    "zombie leader precondition: the raw signal probe keeps answering for a pid that cannot execute",
  );
  assert.doesNotThrow(
    () => process.kill(-zombie.leaderPid, 0),
    "zombie leader precondition: the leader still owns a live process group",
  );
  const survivorState = procState(zombie.survivingPid);
  assert.ok(
    survivorState === "S" || survivorState === "R",
    `fixture precondition: the surviving member is still alive (state '${survivorState}')`,
  );
  assert.equal(
    procGroup(zombie.survivingPid),
    zombie.leaderPid,
    "fixture precondition: the surviving member is in the zombie leader's process group",
  );
  assert.notEqual(zombie.leaderPidIdentity, "", "the zombie leader's process identity is provable");
}

/** The recovery record a restarted controller would find: the zombie's pid
 * with its process identity next to it, recorded as still running. */
function zombieRecoveryRecord(fixture: Fixture, zombie: ZombieFixture): Record<string, unknown> {
  return {
    runId: fixture.request.runId,
    jobId: fixture.request.jobId,
    attempt: fixture.request.attempt,
    pid: zombie.zombiePid,
    pidIdentity: zombie.pidIdentity,
    startedAtMs: 1,
    state: "running",
  };
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

test("validateExecutionRequest enforces the forge API base coordinate (#1433)", () => {
  const { request } = makeRequest();
  const valid = JSON.parse(JSON.stringify(request));

  // "" is the platform-default sentinel and legal ONLY for GitHub; Forgejo
  // has no default, so its request must carry the endpoint or be refused.
  assert.equal(validateExecutionRequest({ ...valid, forgeApiUrl: "" }).forgeApiUrl, "");
  const forgejo = { ...valid, platform: "forgejo", forgeApiUrl: "https://forge.example" };
  assert.equal(validateExecutionRequest(forgejo).forgeApiUrl, "https://forge.example");
  // A path-prefixed API base (GHE-style `/api/v3`, reverse-proxied hosts)
  // is part of the coordinate, not a hostile surface.
  assert.equal(
    validateExecutionRequest({ ...valid, forgeApiUrl: "https://ghe.example/api/v3" }).forgeApiUrl,
    "https://ghe.example/api/v3",
  );
  assert.throws(
    () => validateExecutionRequest({ ...forgejo, forgeApiUrl: "" }),
    /forgeApiUrl must be non-empty for forgejo/,
  );

  // #252: feed the boundary tokens themselves — credential material must
  // never ride the durable request envelope, in any position.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: "https://user:ghp_SECRET@github.example" }),
    /must not embed credentials/,
  );
  // Percent-encoded userinfo still parses as userinfo: the `@` delimits it
  // before any decoding, so this is refused too, not smuggled through.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: "https://%61:ghp_SECRET@github.example" }),
    /must not embed credentials/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: "https://github.example?access_token=ghp_SECRET" }),
    /query/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: "https://github.example#ghp_SECRET" }),
    /fragment/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: "https://github.example\u0007/api" }),
    /control characters/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: "https://github.exam ple/api" }),
    /whitespace/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: "ftp://github.example" }),
    /http or https/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: "github.example" }),
    /absolute URL/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `https://github.example/${"x".repeat(2048)}` }),
    /at most 2048 bytes/,
  );
});

test("validateExecutionRequest refuses a credential riding the forge API path (#1433)", () => {
  const { request } = makeRequest();
  const valid = JSON.parse(JSON.stringify(request));
  const token = "7f3a9c1e55b20d84aa613c9f02bb71d6";
  // #252: the boundary token itself, in every encoding an operator could
  // configure. `encodeURIComponent` leaves an alphanumeric token untouched,
  // so the encoded forms are spelled out here — a test that encodes the
  // attack with a no-op encoder re-tests the plain case and encodes the
  // same blind spot as the code.
  //
  // Level `n` escapes every character `n` times, so level 1 spells `%` plus
  // the character's hex, level 2 spells `%25` plus the hex, and level 3
  // spells `%2525` plus the hex. Each level is built directly instead of
  // escaping an already-escaped form with `replaceAll("%", "%25")`: that
  // replacement double-escapes in the source sense and is exactly the sink
  // CodeQL flags as a double-escaping hazard, and a test must not model the
  // hazard it is screening for.
  const escapedAtLevel = (level: number): string =>
    [...token]
      .map((char) => `%${"25".repeat(level - 1)}${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("");
  const hexEscaped = escapedAtLevel(1);
  const twiceEscaped = escapedAtLevel(2);
  const thriceEscaped = escapedAtLevel(3);

  // #1429's class, refused instead of warned about: a gateway token in the
  // endpoint's PATH is credential material, and this coordinate is persisted
  // verbatim in every execution envelope. The refusal must name the problem
  // without echoing the secret.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `https://forge.example/${token}/v1` }),
    /must not contain a credential-shaped path segment/,
  );
  // Percent-encoded token: the same secret, encoded.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `https://forge.example/${hexEscaped}/v1` }),
    /must not contain a credential-shaped path segment/,
  );
  // Partially encoded: the raw segment is not token-shaped, the decoded one
  // is — so the raw path alone must not be what is judged.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `https://forge.example/7f3a%39c1e55b20d84aa613c9f02bb71d6/v1` }),
    /must not contain a credential-shaped path segment/,
  );
  // Double encoded: the token only appears after two decoding rounds.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `https://forge.example/${twiceEscaped}/v1` }),
    /must not contain a credential-shaped path segment/,
  );
  // Triple encoded: the token only appears after three decoding rounds.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `https://forge.example/${thriceEscaped}/v1` }),
    /must not contain a credential-shaped path segment/,
  );
  // Quadruple encoded: the decoding runs to a fixed point, so no depth of
  // encoding buys a pass.
  assert.throws(
    () =>
      validateExecutionRequest({
        ...valid,
        forgeApiUrl: `https://forge.example/${escapedAtLevel(4)}/v1`,
      }),
    /must not contain a credential-shaped path segment/,
  );
  // An encoded separator cannot hide the token from the decoded path.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `https://forge.example/${token}%2Fv1` }),
    /must not contain a credential-shaped path segment/,
  );
  // A token split across a real separator arrives as two sub-floor
  // segments (base64's own `/`): neither half is credential-shaped, so the
  // joined pair must be judged too.
  assert.throws(
    () =>
      validateExecutionRequest({
        ...valid,
        forgeApiUrl: `https://forge.example/${"A".repeat(19)}/${"A".repeat(19)}/v1`,
      }),
    /must not contain a credential-shaped path segment/,
  );
  assert.throws(
    () =>
      validateExecutionRequest({
        ...valid,
        forgeApiUrl: `https://forge.example/${"A".repeat(19)}%2F${"A".repeat(19)}/v1`,
      }),
    /must not contain a credential-shaped path segment/,
  );
  // Dot segments are removed by the URL parser, so the parsed path no
  // longer shows the token — but the envelope persists the value as
  // written. The path AS WRITTEN must be judged.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `https://forge.example/${token}/..` }),
    /must not contain a credential-shaped path segment/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `https://forge.example/${token}/../v1` }),
    /must not contain a credential-shaped path segment/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `https://forge.example/v1/../${token}` }),
    /must not contain a credential-shaped path segment/,
  );
  // The same hiding in a URL spelling that carries no "//": the parser
  // accepts `http:host/path` and `http:/host/path`, and it normalizes the
  // dot segment out of the parsed path, so the parsed path shows neither
  // the token nor the segment. The path AS WRITTEN must still be judged —
  // if the raw path is looked up by searching for "//", it comes back
  // empty and the credential is screened nowhere, then rides the envelope
  // verbatim.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `http:example.com/${token}/../v1` }),
    /must not contain a credential-shaped path segment/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `https:/forge.example/${token}/../v1` }),
    /must not contain a credential-shaped path segment/,
  );
  // Percent-encoded in the same spelling: the raw path hides the token
  // behind BOTH the dot segment and the encoding, so the raw path must be
  // judged through its decoding rounds too.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `http:example.com/${hexEscaped}/../v1` }),
    /must not contain a credential-shaped path segment/,
  );
  // A backslash is a path separator for http(s) — the parser reads it as
  // one — so the same hiding works spelled with one.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `https://forge.example\\${token}\\..\\v1` }),
    /must not contain a credential-shaped path segment/,
  );
  // A token split across the parser's OWN separator into sub-floor halves,
  // and hidden from the parsed path by a dot segment: neither half reaches
  // the floor on its own, so the halves must be joined before they are
  // judged — the backslash analogue of the `/`-split case above.
  assert.throws(
    () =>
      validateExecutionRequest({
        ...valid,
        forgeApiUrl: `https://forge.example\\${"A".repeat(10)}\\${"B".repeat(10)}\\..\\v1`,
      }),
    /must not contain a credential-shaped path segment/,
  );

  // A token split across separators into sub-floor pieces (base64's own
  // `/`, or a hex token broken into chunks): the pieces are joined, so the
  // split cannot smuggle the token past the floor.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: "https://forge.example/7f3a9c1e5/5b20d84aa/613c9f02bb71d6/v1" }),
    /must not contain a credential-shaped path segment/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: "https://forge.example/7f3a9c1e5%2F5b20d84aa%2F613c9f02bb71d6/v1" }),
    /must not contain a credential-shaped path segment/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: "https://forge.example/7f3a9c1e/55b20d84/aa613c9f/02bb71d6/v1" }),
    /must not contain a credential-shaped path segment/,
  );
  // A base64 token broken into its own quads.
  assert.throws(
    () =>
      validateExecutionRequest({
        ...valid,
        forgeApiUrl: "https://forge.example/QUJDREVGRUZHSElKTEVOU1BRUlNUVVZXWFla/v1",
      }),
    /must not contain a credential-shaped path segment/,
  );
  // A credential sharing its segment with one punctuation character is
  // still a run of token characters.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `https://forge.example/${token}!/v1` }),
    /must not contain a credential-shaped path segment/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `https://forge.example/${token};v=1/v1` }),
    /must not contain a credential-shaped path segment/,
  );
  // An `@` outside the authority is the #1419 class the Python lane
  // refuses: a password carrying an unencoded `/` ends the authority
  // early, so the userinfo lands in the path.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `https://forge.example/${token}@x/v1` }),
    /credential outside its authority/,
  );
  // A percent-encoded query is the same channel the plain query is refused
  // for: the encoded form must be refused too.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: "https://forge.example/%3Faccess_token%3Dghp_SECRET" }),
    /percent-encoded query/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: "https://forge.example/%23ghp_SECRET" }),
    /percent-encoded query/,
  );
  // A malformed escape cannot be decoded, so the path cannot be proven
  // credential-free: refuse rather than guess.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: "https://forge.example/%zz/api" }),
    /malformed percent-encoding/,
  );
  // The refusal must not echo the secret it refused.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: `https://forge.example/${token}/v1` }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes(token));
      return true;
    },
  );

  // A legitimate base path is prose, not token material: it stays legal.
  assert.equal(
    validateExecutionRequest({ ...valid, forgeApiUrl: "https://forge.example/api/v1" }).forgeApiUrl,
    "https://forge.example/api/v1",
  );
  assert.equal(
    validateExecutionRequest({ ...valid, forgeApiUrl: "https://ghe.example/api/v3" }).forgeApiUrl,
    "https://ghe.example/api/v3",
  );
  assert.equal(
    validateExecutionRequest({ ...valid, forgeApiUrl: "https://forge.example/gitlab/api/v4" }).forgeApiUrl,
    "https://forge.example/gitlab/api/v4",
  );
  // The URL spellings that carry no "//" stay legal for a prose path: the
  // screen judges the credential's shape, not the spelling of the URL.
  assert.equal(
    validateExecutionRequest({ ...valid, forgeApiUrl: "http:forge.example/api/v1" }).forgeApiUrl,
    "http:forge.example/api/v1",
  );
  // One character under the credential-shaped floor stays legal too — the
  // floor is the same one #1429 uses.
  assert.equal(
    validateExecutionRequest({ ...valid, forgeApiUrl: `https://forge.example/${"a".repeat(19)}` }).forgeApiUrl,
    `https://forge.example/${"a".repeat(19)}`,
  );
  // Known false positives, pinned on purpose: PROSE of 20+ token
  // characters is refused too — in one segment or across separators —
  // because a shape screen cannot tell it from a token and this field may
  // never carry credential material. A deployment with such a base path
  // must shorten or alias it.
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: "https://forge.example/tenants/acme-corporation-instance/v1" }),
    /must not contain a credential-shaped path segment/,
  );
  assert.throws(
    () => validateExecutionRequest({ ...valid, forgeApiUrl: "https://forge.example/organizations/members" }),
    /must not contain a credential-shaped path segment/,
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

test("reconcile: a zombie worker is orphaned, never running", async (t) => {
  // A killed-but-unreaped zombie keeps answering `kill(pid, 0)` forever
  // under a PID 1 that never reaps orphans, so the RAW signal probe read
  // a terminated worker as `running` forever. The default probe asks
  // whether the pid can still EXECUTE — it cannot — so the orphan is
  // settled, never retried against a worker that is already gone.
  if (!hasProc) {
    t.skip(NO_PROC_SKIP_REASON);
    return;
  }
  const fixture = makeRequest();
  const zombie = await spawnZombie();
  if (zombie === null) {
    t.skip(BASH_MISSING_SKIP_REASON);
    return;
  }
  try {
    assertZombieBoundary(zombie);
    writeStateFile(fixture.request, zombieRecoveryRecord(fixture, zombie));
    const outcome = await executor("ok").reconcile(fixture.request);
    assert.notEqual(outcome.kind, "running", "a worker that cannot execute is not running");
    assert.ok(outcome.kind === "settled");
    assert.equal(outcome.result.status, "failed");
    assert.equal(outcome.result.failureCategory, "orphaned");
  } finally {
    zombie.stop();
    cleanup(fixture);
  }
});

test("reconcile: a live worker is still running under the default probe", async () => {
  // The counterpart of the zombie case: the default probe reads `/proc`,
  // so a live worker must still read as alive. A `/proc` read that fails
  // must never turn a running worker into an orphan.
  const fixture = makeRequest();
  const survivor = spawnSurvivor();
  try {
    assert.equal(pidAliveNow(survivor.pid), true, "the survivor is a live process");
    if (hasProc) {
      const state = procState(survivor.pid);
      assert.notEqual(state, "", "the survivor is a real process");
      assert.notEqual(state, "Z", "the survivor is not a zombie");
    }
    writeStateFile(fixture.request, {
      runId: fixture.request.runId,
      jobId: fixture.request.jobId,
      attempt: fixture.request.attempt,
      pid: survivor.pid,
      startedAtMs: 1,
      state: "running",
    });
    assert.deepEqual(
      await executor("ok").reconcile(fixture.request),
      { kind: "running" },
      "the default probe must still report a live worker as running",
    );
  } finally {
    survivor.stop();
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
    // The executor confirms the death as soon as the worker can no longer
    // EXECUTE (#1383), which is BEFORE the OS releases the pid — the
    // controller reaps the zombie a moment later. The raw signal probe
    // therefore still answers at this instant, so "the pid really left the
    // process table" is a bounded poll, never a single sample.
    assert.equal(await waitForProcessGone(pid), true, "the worker process is really gone");

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
      pidPresent: () => alive,
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
      exited: Promise.resolve(),
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
            unreaped: [],
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

test("cancel: a recovered zombie worker is reported terminated, never worker-not-terminated", async (t) => {
  // A killed-but-unreaped zombie keeps answering `kill(pid, 0)` forever
  // under a PID 1 that never reaps orphans, so the RAW signal probe could
  // never confirm the death: the recovered cancellation reported
  // `worker-not-terminated` for good. The default probe asks whether the
  // pid can still EXECUTE — a zombie cannot — so the worker is gone and
  // the cancellation is confirmed.
  if (!hasProc) {
    t.skip(NO_PROC_SKIP_REASON);
    return;
  }
  const fixture = makeRequest();
  const zombie = await spawnZombie();
  if (zombie === null) {
    t.skip(BASH_MISSING_SKIP_REASON);
    return;
  }
  try {
    assertZombieBoundary(zombie);
    writeStateFile(fixture.request, zombieRecoveryRecord(fixture, zombie));
    const outcome = await executor("ok").cancel(fixture.request);
    assert.deepEqual(
      outcome,
      { kind: "terminated" },
      "a worker that cannot execute is gone: the cancellation is confirmed, not failed",
    );
  } finally {
    zombie.stop();
    cleanup(fixture);
  }
});

test("cancel: a recovered zombie leader is still swept, and the cancellation is confirmed", async (t) => {
  // A killed-but-unreaped zombie cannot execute, but it is still PRESENT:
  // it owns its PROCESS GROUP, and the group's members (the worker's
  // orphaned descendants) can outlive it. Linux re-parents a dead leader's
  // children at death — not at reap — so the descendant snapshot cannot
  // see them anymore and ONLY the tree termination's group kill reaches
  // them. This test drives the REAL termination seam (no injected
  // terminate) against a real zombie process-group leader with a real
  // surviving member: skipping the sweep would report `terminated` and
  // LEAK the group.
  if (!hasProc) {
    t.skip(NO_PROC_SKIP_REASON);
    return;
  }
  const fixture = makeRequest();
  const zombie = await spawnZombieGroupLeader();
  if (zombie === null) {
    t.skip(BASH_MISSING_SKIP_REASON);
    return;
  }
  try {
    assertZombieGroupLeaderBoundary(zombie);
    writeStateFile(fixture.request, {
      runId: fixture.request.runId,
      jobId: fixture.request.jobId,
      attempt: fixture.request.attempt,
      pid: zombie.leaderPid,
      pidIdentity: zombie.leaderPidIdentity,
      startedAtMs: 1,
      state: "running",
    });
    const outcome = await executor("ok").cancel(fixture.request);
    assert.deepEqual(
      outcome,
      { kind: "terminated" },
      "a present leader is swept even when it can no longer execute: the group kill is the point",
    );
    // The surviving member of the zombie leader's group must not survive
    // the sweep: a pid that can still execute is a leaked descendant. (A
    // reaped-or-zombie tail is fine — dead is dead; an init that reaps
    // collects the tail, and one that does not leaves it a zombie.)
    const deadline = Date.now() + ZOMBIE_WAIT_MS;
    let survivorState = procState(zombie.survivingPid);
    while ((survivorState === "S" || survivorState === "R") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      survivorState = procState(zombie.survivingPid);
    }
    assert.ok(
      survivorState === "" || survivorState === "Z",
      `the zombie leader's surviving group member was swept, not orphaned (state '${survivorState}')`,
    );
  } finally {
    zombie.stop();
    cleanup(fixture);
  }
});

test("cancel: a present-but-cannot-execute recovered worker routes through the termination seam", async (t) => {
  // The decision table's middle row, pinned in isolation: a pid that is
  // still PRESENT but cannot execute (an unreaped zombie) is neither the
  // absent-pid short-circuit (nothing to signal) nor an identity refusal —
  // it goes through `terminate` so the group kill gets its chance. The
  // terminate seam is injected here only to OBSERVE the routing; the
  // real-seam proof that a zombie PROCESS-GROUP LEADER's surviving group
  // member is actually swept is the test above.
  if (!hasProc) {
    t.skip(NO_PROC_SKIP_REASON);
    return;
  }
  const fixture = makeRequest();
  const zombie = await spawnZombie();
  if (zombie === null) {
    t.skip(BASH_MISSING_SKIP_REASON);
    return;
  }
  const signalled: number[] = [];
  try {
    assertZombieBoundary(zombie);
    writeStateFile(fixture.request, zombieRecoveryRecord(fixture, zombie));
    const outcome = await executor("ok", {
      terminate: async (pid: number) => {
        signalled.push(pid);
        return true;
      },
    }).cancel(fixture.request);
    assert.deepEqual(outcome, { kind: "terminated" });
    assert.deepEqual(
      signalled,
      [zombie.zombiePid],
      "a present worker is swept even when it can no longer execute, instead of the absent-pid short-circuit",
    );
  } finally {
    zombie.stop();
    cleanup(fixture);
  }
});

test("cancel: a recovered zombie leader with an unproven process identity is never signalled", async (t) => {
  // The identity proof gates EVERY signal — including for a leader that
  // cannot execute any more. A pid whose recorded identity does not match
  // the live process is not provably this run's worker, so nothing is
  // signalled and the cancellation fails closed.
  if (!hasProc) {
    t.skip(NO_PROC_SKIP_REASON);
    return;
  }
  const fixture = makeRequest();
  const zombie = await spawnZombie();
  if (zombie === null) {
    t.skip(BASH_MISSING_SKIP_REASON);
    return;
  }
  const signalled: number[] = [];
  try {
    assertZombieBoundary(zombie);
    writeStateFile(fixture.request, zombieRecoveryRecord(fixture, zombie));
    const outcome = await executor("ok", {
      pidIdentity: async () => "a-different-token",
      terminate: async (pid: number) => {
        signalled.push(pid);
        return true;
      },
    }).cancel(fixture.request);
    assert.deepEqual(outcome, { kind: "failed", reason: "worker-not-terminated" });
    assert.deepEqual(signalled, [], "an unproven pid is never signalled, zombie or not");
  } finally {
    zombie.stop();
    cleanup(fixture);
  }
});

test("cancel: a recovered worker that is gone entirely is terminated without signalling", async () => {
  // Nothing is PRESENT at all: the pid names no process, so there is
  // nothing running to terminate and nothing that could be signalled — the
  // cancellation short-circuits to `terminated`. The identity seam is
  // constant here, so the short-circuit cannot be an identity mismatch in
  // disguise. The pid is above the kernel's maximum (`pid_max` tops out at
  // 2^22), so it can never name a live process.
  const fixture = makeRequest();
  const signalled: number[] = [];
  try {
    writeStateFile(fixture.request, {
      runId: fixture.request.runId,
      jobId: fixture.request.jobId,
      attempt: fixture.request.attempt,
      pid: 2_147_483_647,
      pidIdentity: "identity-token",
      startedAtMs: 1,
      state: "running",
    });
    const outcome = await executor("ok", {
      pidIdentity: async () => "identity-token",
      terminate: async (pid: number) => {
        signalled.push(pid);
        return true;
      },
    }).cancel(fixture.request);
    assert.deepEqual(outcome, { kind: "terminated" });
    assert.deepEqual(signalled, [], "nothing present means nothing to terminate, nothing to signal");
  } finally {
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
