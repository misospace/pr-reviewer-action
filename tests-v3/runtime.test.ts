import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { promisify } from "node:util";
import {
  buildChildEnv,
  createCancellationScope,
  leakedEnvKeys,
  pgrepAvailable,
  processCanExecute,
  runProcess,
  terminateProcessTree,
  terminateProcessTreeByPid,
} from "../src/runtime/index.js";

const execFileBounded = promisify(execFile);

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "v3-runtime-"));
}

/**
 * Launch-side readiness in these fixtures used a hard 5s ceiling, which
 * assumes an unloaded runner: a cold `bash`/`node` boot plus one pid-file
 * write under CPU starvation in a constrained sandbox can exceed it with no
 * product fault (#1377). The waits poll for success and return the moment
 * the file lands, so the generous ceiling costs nothing when healthy and
 * still fails, naming the missing pid file, when the workload truly never
 * launches.
 */
const LOAD_TOLERANT_FILE_WAIT_MS = 30_000;

function sleepTreeScript(dir: string, name: string): { args: string[]; pidFiles: { child: string; grandchild: string } } {
  const child = join(dir, `${name}.child.pid`);
  const grandchild = join(dir, `${name}.gc.pid`);
  return {
    args: [
      "-c",
      `sleep 60 & echo $! > '${grandchild}'; echo $$ > '${child}'; wait`,
    ],
    pidFiles: { child, grandchild },
  };
}

/**
 * A tree node counts as terminated when it can no longer EXECUTE — the
 * property the cleanup owns. A killed-but-unreaped zombie keeps answering
 * `kill(pid, 0)` (forever, under a PID 1 that never reaps orphans, e.g. a
 * container init), so the raw signal probe is not the property. The runtime
 * predicate is the single definition; the dedicated zombie fixtures below
 * pin it against `/proc` ground truth, so these call sites are not circular.
 */
function terminated(pid: number): boolean {
  return !processCanExecute(pid);
}

/** `/proc/<pid>/stat` field 3 (`state`), or "" when unreadable. */
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

const hasProc = (() => {
  const probe = procState(process.pid);
  return probe.length > 0;
})();

async function waitForFile(path: string, timeoutMs = LOAD_TOLERANT_FILE_WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (readFileSync(path, "utf8").trim().length > 0) return;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`pid file never appeared: ${path}`);
}

/**
 * Bounded launch readiness (#1069). The pgrep preflight makes `runProcess`
 * launches asynchronous and refusable: in an environment without pgrep, a
 * handle's `pid` stays null forever. Waiting on `pid` alone therefore spins
 * forever; waiting on `launched` settles deterministically and, when the
 * launch was refused, fails fast naming the refusal instead of burning the
 * deadline.
 */
interface LaunchReadiness {
  readonly pid: number | null;
  readonly launched: Promise<void>;
  readonly launchRefusal: string | null;
}

async function awaitLaunched(
  handles: readonly LaunchReadiness[],
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(
      () =>
        reject(
          new Error(
            `${label}: launch readiness not reached within ${timeoutMs}ms (pids: ${handles.map((handle) => String(handle.pid)).join(", ")})`,
          ),
        ),
      timeoutMs,
    );
    // Referenced on purpose: an unref'd timer is the only pending handle in
    // the never-settles case, so the event loop can drain and cancel the
    // test (ERR_TEST_FAILURE) before the bounded rejection fires. The
    // `finally` below clears it on every settled path.
  });
  try {
    await Promise.race([Promise.all(handles.map((handle) => handle.launched)), deadline]);
  } finally {
    clearTimeout(deadlineTimer);
  }
  const unlaunched = handles.filter((handle) => handle.pid === null);
  if (unlaunched.length > 0) {
    const reasons = unlaunched
      .map((handle) => handle.launchRefusal ?? "launch settled without recording a pid")
      .join("; ");
    throw new Error(`${label}: ${unlaunched.length}/${handles.length} workload(s) never launched — ${reasons}`);
  }
}

/**
 * Explicit environment gate: tree-owning workload coverage requires pgrep,
 * and `runProcess` refuses to launch without it. Tests that need a real
 * launch skip with a stated reason instead of failing on refusals — bounded,
 * never silent. The refusal behavior itself is covered separately by the
 * environment-independent tests below (they run their probes with a
 * controlled PATH, so they pass with or without system pgrep).
 */
const TREE_TOOLING_SKIP_REASON =
  "environment lacks pgrep: runProcess refuses tree-owning launches, so workload lifecycle cannot be exercised here (see the launch-refusal coverage, which still runs)";

let treeToolingProbe: Promise<boolean> | null = null;
function pgrepPresent(): Promise<boolean> {
  treeToolingProbe ??= pgrepAvailable();
  return treeToolingProbe;
}

async function requireTreeTooling(t: TestContext): Promise<boolean> {
  if (await pgrepPresent()) return true;
  t.skip(TREE_TOOLING_SKIP_REASON);
  return false;
}

test("timeout terminates the child AND its grandchild (spawn-then-hang fixture)", async (t) => {
  if (!(await requireTreeTooling(t))) return;
  const dir = workspace();
  const tree = sleepTreeScript(dir, "timeout");
  const handle = runProcess({
    file: "bash",
    args: tree.args,
    env: buildChildEnv(["PATH", "HOME"]),
    timeoutMs: 300,
    terminateGraceMs: 2000,
  });
  const result = await handle.result;

  assert.equal(result.status, "timeout");
  assert.equal(result.exitCode, null);
  assert.ok(handle.pid !== null, "leader pid must be recorded once launched");
  assert.ok(result.durationMs >= 250 && result.durationMs < 10_000, `duration ${result.durationMs}`);

  await waitForFile(tree.pidFiles.child);
  await waitForFile(tree.pidFiles.grandchild);
  const childPid = Number.parseInt(readFileSync(tree.pidFiles.child, "utf8"), 10);
  const grandchildPid = Number.parseInt(readFileSync(tree.pidFiles.grandchild, "utf8"), 10);
  assert.ok(terminated(childPid), "leader must be terminated (dead or unreaped zombie — it cannot execute)");
  assert.ok(
    terminated(grandchildPid),
    "grandchild must be terminated (dead or unreaped zombie) — wrapper-only cleanup is the #634 bug",
  );
  assert.ok(result.termination !== null);
  assert.equal(result.termination!.survived.length, 0);
});

test("child ignoring SIGTERM still dies via bounded SIGKILL escalation", async (t) => {
  if (!(await requireTreeTooling(t))) return;
  const startedAt = Date.now();
  const handle = runProcess({
    file: "bash",
    args: ["-c", "trap '' TERM; echo ready; sleep 60"],
    env: buildChildEnv(["PATH", "HOME"]),
    timeoutMs: 300,
    terminateGraceMs: 1200,
  });
  const result = await handle.result;
  const elapsed = Date.now() - startedAt;

  assert.equal(result.status, "timeout");
  // TERM is ignored, so death only comes from the KILL escalation: bounded,
  // not immediate, and well under the unbounded 60s sleep.
  assert.ok(elapsed >= 250 && elapsed < 10_000, `elapsed ${elapsed}ms`);
  assert.equal(result.termination?.survived.length ?? 0, 0);
});

test("a TERM-ignoring descendant needs the snapshot KILL escalation (killedAfterGrace)", async (t) => {
  if (!(await requireTreeTooling(t))) return;
  const dir = workspace();
  const pidFile = join(dir, "stubborn.pid");
  const handle = runProcess({
    file: "bash",
    args: [
      "-c",
      `bash -c "trap '' TERM; echo \\$\\$ > ${pidFile}; sleep 60" & echo ready; sleep 60`,
    ],
    env: buildChildEnv(["PATH", "HOME"]),
    timeoutMs: 300,
    terminateGraceMs: 1200,
  });
  const result = await handle.result;
  assert.equal(result.status, "timeout");
  await waitForFile(pidFile);
  const stubbornPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
  const termination = result.termination;
  assert.ok(termination !== null);
  assert.ok(
    termination.snapshot.includes(stubbornPid),
    "the stubborn descendant is in the pre-signal snapshot",
  );
  assert.ok(
    termination.killedAfterGrace.includes(stubbornPid),
    "a descendant that ignores TERM must be individually KILLed after the grace",
  );
});

test("descendant that escapes the process group is swept by the snapshot", async (t) => {
  if (!(await requireTreeTooling(t))) return;
  const dir = workspace();
  const escapedPidFile = join(dir, "escaped.pid");
  const handle = runProcess({
    file: execPath,
    args: [
      "-e",
      `const cp = require('child_process');
       const ch = cp.spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
       require('fs').writeFileSync(${JSON.stringify(escapedPidFile)}, String(ch.pid));
       setTimeout(() => {}, 60000);`,
    ],
    env: buildChildEnv(["PATH", "HOME"]),
    timeoutMs: 300,
    terminateGraceMs: 2000,
  });
  const result = await handle.result;
  assert.equal(result.status, "timeout");

  await waitForFile(escapedPidFile);
  const escapedPid = Number.parseInt(readFileSync(escapedPidFile, "utf8"), 10);
  assert.ok(terminated(escapedPid), "detached (new process group) descendant must still be reaped");
  assert.ok(result.termination !== null);
  assert.ok(
    result.termination!.snapshot.includes(escapedPid),
    "escapee must be discovered by the pre-signal snapshot",
  );
});

test("external cancellation (parent action cancelled) terminates both trees", async (t) => {
  if (!(await requireTreeTooling(t))) return;
  const scope = createCancellationScope();
  const first = runProcess({
    file: "bash",
    args: ["-c", "sleep 60"],
    env: buildChildEnv(["PATH", "HOME"]),
    signal: scope.signal,
  });
  const second = runProcess({
    file: "bash",
    args: ["-c", "sleep 60"],
    env: buildChildEnv(["PATH", "HOME"]),
    signal: scope.signal,
  });
  try {
    // Wait for both workloads to actually be up, so this exercises the
    // mid-flight cancellation path, not the pre-launch refusal. The wait is
    // bounded and fails naming any refused/never-settling launch instead of
    // spinning on a null pid forever (the pgrep-less hang of #1069).
    await awaitLaunched([first, second], "external-cancellation");
    scope.abort("job-cancelled");
  } catch (error) {
    // Failure path: terminate any started sibling and await the settled
    // results before rethrowing — `scope.abort` only initiates the
    // asynchronous tree termination, so without this await the test could
    // report its failure while sleeper cleanup is still in flight.
    scope.abort("test-failure-cleanup");
    await Promise.allSettled([first.result, second.result]);
    throw error;
  }
  const [firstResult, secondResult] = await Promise.all([first.result, second.result]);

  assert.equal(firstResult.status, "cancelled");
  assert.equal(secondResult.status, "cancelled");
  assert.equal(firstResult.exitCode, null);
});

test("cancel arriving inside the pgrep preflight window never spawns the workload", async () => {
  // Child probe: a slow fake pgrep keeps the preflight probe in flight while
  // the abort lands; the post-probe check must refuse to launch instead of
  // racing the cancellation. (The probe resolves via the probe process's own
  // PATH, so the fake pgrep only works from a child with a controlled PATH.)
  // The outer probe runs via plain bounded execFile — not runProcess — so
  // this coverage stays independent of whether the host itself has pgrep.
  const dir = workspace();
  const fakePgrep = join(dir, "pgrep");
  // Absolute /bin/sleep: the fake pgrep's own PATH is dir-only, so it cannot
  // resolve `sleep` by name. /bin/sleep exists on macOS and Linux (usrmerge).
  writeFileSync(fakePgrep, "#!/bin/sh\n/bin/sleep 1\nexit 0\n", { mode: 0o755 });
  const scriptPath = join(dir, "probe.cjs");
  const buildDir = join(process.cwd(), ".test-build", "src", "runtime");
  writeFileSync(
    scriptPath,
    `
    const path = require('path');
    const { runProcess } = require(path.join(${JSON.stringify(buildDir)}, 'subprocess.js'));
    const { createCancellationScope } = require(path.join(${JSON.stringify(buildDir)}, 'signals.js'));
    const scope = createCancellationScope();
    const handle = runProcess({
      file: 'bash',
      args: ['-c', 'sleep 60'],
      env: { PATH: ${JSON.stringify(dir)} + ':/usr/bin:/bin' },
      signal: scope.signal,
    });
    setTimeout(() => scope.abort('cancelled-midflight'), 100);
    handle.result.then((r) => {
      process.stdout.write(JSON.stringify({ status: r.status, launchError: r.launchError ?? null, pid: handle.pid }), () => process.exit(0));
    });
  `,
  );
  const probeRun = await execFileBounded(execPath, [scriptPath], {
    // The probe child's own PATH must be dir-only so its pgrep probe hits
    // the slow fake (the runtime's probe resolves via the probing process's
    // PATH, not the workload env).
    env: { PATH: dir, HOME: process.env.HOME ?? "" },
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  const probe = JSON.parse(probeRun.stdout) as {
    status: string;
    launchError: string | null;
    pid: number | null;
  };
  assert.equal(probe.pid, null, "no workload may exist after a pre-launch cancel");
  assert.equal(probe.status, "spawn_error");
  assert.match(probe.launchError ?? "", /cancelled before launch/);
});

test("missing process tooling refuses tree-owning launches (pgrep-less PATH)", async () => {
  // The probe child runs with a PATH that contains no pgrep, so the launch
  // preflight fails closed: no workload, prompt structured spawn_error naming
  // the missing tooling. This is the exact environment shape that used to
  // hang the suite — every pid stays null and an unbounded readiness wait
  // never settles. The outer probe is plain execFile, so this coverage is
  // deterministic with or without system pgrep.
  const dir = workspace();
  const scriptPath = join(dir, "refused-launch.cjs");
  const buildDir = join(process.cwd(), ".test-build", "src", "runtime");
  writeFileSync(
    scriptPath,
    `
    const path = require('path');
    const { runProcess } = require(path.join(${JSON.stringify(buildDir)}, 'subprocess.js'));
    const handle = runProcess({
      file: 'bash',
      args: ['-c', 'sleep 60'],
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 10_000,
    });
    handle.result.then((r) => {
      process.stdout.write(JSON.stringify({ status: r.status, launchError: r.launchError ?? null, pid: handle.pid }), () => process.exit(0));
    });
  `,
  );
  const probeRun = await execFileBounded(execPath, [scriptPath], {
    // Probe process PATH is dir-only: no pgrep reachable, the preflight must
    // refuse. The workload env above is never used — nothing spawns.
    env: { PATH: dir, HOME: process.env.HOME ?? "" },
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
  const report = JSON.parse(probeRun.stdout) as {
    status: string;
    launchError: string | null;
    pid: number | null;
  };
  assert.equal(report.pid, null, "a refused launch must never spawn the workload");
  assert.equal(report.status, "spawn_error");
  assert.match(report.launchError ?? "", /pgrep is required/);
});

test("launch readiness wait is bounded when a child never becomes ready", async () => {
  const neverReady: LaunchReadiness = {
    pid: null,
    launched: new Promise<void>(() => {}),
    launchRefusal: null,
  };
  const startedAt = Date.now();
  await assert.rejects(
    awaitLaunched([neverReady], "never-ready", 250),
    /never-ready: launch readiness not reached within 250ms \(pids: null\)/,
  );
  assert.ok(Date.now() - startedAt < 5_000, `readiness wait must be bounded (took ${Date.now() - startedAt}ms)`);
});

test("launch readiness wait reports a refused launch instead of waiting", async () => {
  // A real refused handle: the pre-aborted scope takes the synchronous
  // refusal path, so `launched` settles immediately with the pid still null.
  // The readiness wait must fail fast with the refusal, not burn its
  // deadline.
  const scope = createCancellationScope();
  scope.abort("already-cancelled");
  const refused = runProcess({
    file: "bash",
    args: ["-c", "sleep 60"],
    env: buildChildEnv(["PATH", "HOME"]),
    signal: scope.signal,
  });
  assert.equal(refused.pid, null);
  const startedAt = Date.now();
  await assert.rejects(
    awaitLaunched([refused], "refused-launch", 10_000),
    /refused-launch: 1\/1 workload\(s\) never launched — bash: cancelled before launch/,
  );
  assert.ok(Date.now() - startedAt < 5_000, "a settled refusal must fail fast, not burn the deadline");
});

test("normal success preserves output bytes exactly (multibyte, no trailing newline)", async (t) => {
  if (!(await requireTreeTooling(t))) return;
  const payload = "héllo→wörld ✓ no-newline";
  const expected = Buffer.from(payload, "utf8");
  const handle = runProcess({
    file: "printf",
    args: [payload],
    env: buildChildEnv(["PATH", "HOME"]),
  });
  const result = await handle.result;
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.termination, null);
  assert.ok(result.stdout.equals(expected), `bytes differ: ${result.stdout.toString("utf8")}`);
  assert.equal(result.stdoutTruncated, false);
});

test("output over the per-stream cap is truncated, drain never blocks", async (t) => {
  if (!(await requireTreeTooling(t))) return;
  const cap = 4096;
  const handle = runProcess({
    file: "bash",
    args: ["-c", "seq 1 20000"],
    env: buildChildEnv(["PATH", "HOME"]),
    maxOutputBytes: cap,
    timeoutMs: 15_000,
  });
  const result = await handle.result;
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.ok(result.stdout.length <= cap, `captured ${result.stdout.length} > cap ${cap}`);
});

test("a grandchild holding the stdout pipe cannot hang the result (drain guard)", async (t) => {
  if (!(await requireTreeTooling(t))) return;
  // The leader exits immediately; an orphaned grandchild keeps the inherited
  // stdout open for 60s. The close-after-exit drain guard must cut the
  // streams instead of waiting for the descriptor.
  const startedAt = Date.now();
  const handle = runProcess({
    file: "bash",
    args: ["-c", "( sleep 60; echo too-late ) & echo started"],
    env: buildChildEnv(["PATH", "HOME"]),
    timeoutMs: 15_000,
  });
  const result = await handle.result;
  const elapsed = Date.now() - startedAt;
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.toString("utf8"), "started\n");
  assert.ok(elapsed < 10_000, `drain guard must not wait for the 60s holder (took ${elapsed}ms)`);
});

test("structured exit/stderr capture for a failing workload", async (t) => {
  if (!(await requireTreeTooling(t))) return;
  const handle = runProcess({
    file: "bash",
    args: ["-c", "echo out; echo err >&2; exit 3"],
    env: buildChildEnv(["PATH", "HOME"]),
  });
  const result = await handle.result;
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout.toString("utf8"), "out\n");
  assert.equal(result.stderr.toString("utf8"), "err\n");
});

test("missing binary is a structured spawn_error, not a throw", async (t) => {
  if (!(await requireTreeTooling(t))) return;
  const handle = runProcess({
    file: "definitely-not-a-real-binary-679",
    env: buildChildEnv(["PATH"]),
  });
  const result = await handle.result;
  assert.equal(result.status, "spawn_error");
  assert.match(result.launchError ?? "", /ENOENT/);
  // Policy refusals (non-POSIX, pre-abort) are the only synchronous refusals;
  // a missing binary surfaces through the structured result instead.
  assert.equal(handle.launchRefusal, null);
});

test("child environment is an allowlist: canary secrets never reach the child", async (t) => {
  if (!(await requireTreeTooling(t))) return;
  const ambient: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    AI_API_KEY: "SENTINEL-AI-KEY",
    TOOL_MCP_TOKEN: "SENTINEL-MCP-TOKEN",
    LINEAR_API_KEY: "SENTINEL-LINEAR-KEY",
    ALLOWED_MARKER: "present",
  };
  const env = buildChildEnv(["PATH", "HOME", "ALLOWED_MARKER"], ambient);
  assert.deepEqual(leakedEnvKeys(env, ["AI_API_KEY", "TOOL_MCP_TOKEN", "LINEAR_API_KEY"]), []);

  const handle = runProcess({
    file: execPath,
    args: ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))"],
    env,
  });
  const result = await handle.result;
  const keys = JSON.parse(result.stdout.toString("utf8")) as string[];
  // macOS/libuv injects __CF_USER_TEXT_ENCODING into child envs; everything
  // else must be exactly the allowlisted set, and no canary may appear.
  const platformInjected = keys.filter((key) => key.startsWith("__CF_"));
  const allowlisted = keys.filter((key) => !key.startsWith("__CF_"));
  assert.deepEqual(allowlisted.sort(), ["ALLOWED_MARKER", "HOME", "PATH"]);
  assert.ok(platformInjected.every((key) => !key.includes("SENTINEL")));
});

test("after a normal completion nothing is left to clean up", async (t) => {
  if (!(await requireTreeTooling(t))) return;
  const handle = runProcess({
    file: "bash",
    args: ["-c", "true"],
    env: buildChildEnv(["PATH", "HOME"]),
  });
  const result = await handle.result;
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 0);
  assert.equal(result.termination, null);
});

test("terminateProcessTree is a safe no-op on an already-dead child", async (t) => {
  if (!(await requireTreeTooling(t))) return;
  const handle = runProcess({
    file: "true",
    env: buildChildEnv(["PATH", "HOME"]),
  });
  const result = await handle.result;
  assert.ok(handle.pid !== null);
  const report = await terminateProcessTree(
    // The child is already reaped; signaling its pid must not throw.
    { pid: handle.pid } as Parameters<typeof terminateProcessTree>[0],
    { graceMs: 100 },
  );
  assert.equal(report.survived.length, 0);
  assert.ok(result.exitCode === 0);
});

test("pre-aborted signal refuses to launch (fail-closed, never half-owned)", async () => {
  const scope = createCancellationScope();
  scope.abort("already-cancelled");
  const handle = runProcess({
    file: "bash",
    args: ["-c", "sleep 60"],
    env: buildChildEnv(["PATH", "HOME"]),
    signal: scope.signal,
  });
  assert.equal(handle.pid, null);
  assert.match(handle.launchRefusal ?? "", /cancelled before launch/);
  const result = await handle.result;
  assert.equal(result.status, "spawn_error");
});

test("parent SIGTERM during concurrent work: bounded finalize + tree cleanup (end-to-end)", async (t) => {
  if (!(await requireTreeTooling(t))) return;
  const dir = workspace();
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, "finalized.marker");
  const tree = sleepTreeScript(dir, "sigterm");
  const buildDir = process.env.TEST_BUILD_DIR ?? join(process.cwd(), ".test-build", "src", "runtime");

  const childScript = `
    const path = require('path');
    const fs = require('fs');
    const { runProcess } = require(path.join(${JSON.stringify(buildDir)}, 'subprocess.js'));
    const { buildChildEnv } = require(path.join(${JSON.stringify(buildDir)}, 'env.js'));
    const { createCancellationScope, createParentSignalHandler } = require(path.join(${JSON.stringify(buildDir)}, 'signals.js'));
    const scope = createCancellationScope();
    const handle = runProcess({
      file: 'bash',
      args: ['-c', ${JSON.stringify(tree.args[1] ?? "")}],
      env: buildChildEnv(['PATH', 'HOME']),
      signal: scope.signal,
    });
    const handler = createParentSignalHandler({
      scope,
      finalize: async () => {
        const r = await handle.result;
        fs.writeFileSync(${JSON.stringify(join(dir, "child-outcome.json"))}, JSON.stringify({ status: r.status }));
        fs.writeFileSync(${JSON.stringify(marker)}, 'done');
      },
      // The finalize deadline is the handler's OWN bound on tree cleanup, and
      // cleanup is a few seconds at most; 5s assumed an unloaded runner and
      // let CPU starvation cut the deadline before the finalize wrote its
      // markers (#1377). Still a hard bound — the end-to-end property under
      // test is boundedness, and a hanging finalize still loses the race.
      deadlineMs: 15000,
    });
    handler.attach();
  `;
  const scriptPath = join(dir, "sigterm-child.cjs");
  writeFileSync(scriptPath, childScript);

  const child = runProcess({
    file: execPath,
    args: [scriptPath],
    env: buildChildEnv(["PATH", "HOME"]),
  });
  try {
    // Wait for the workload tree to be up (also proves the child launched),
    // then simulate the runner cancelling the parent (SIGTERM).
    await waitForFile(tree.pidFiles.grandchild);
    assert.ok(child.pid !== null);
    process.kill(child.pid, "SIGTERM");
    const childResult = await child.result;

    assert.equal(childResult.status, "exited");
    assert.equal(childResult.exitCode, 143, "signal handler must exit 128+15, not the default kill");
    assert.equal(readFileSync(marker, "utf8"), "done");
    await waitForFile(join(dir, "child-outcome.json"));
    assert.equal(JSON.parse(readFileSync(join(dir, "child-outcome.json"), "utf8")).status, "cancelled");

    const childPid = Number.parseInt(readFileSync(tree.pidFiles.child, "utf8"), 10);
    const grandchildPid = Number.parseInt(readFileSync(tree.pidFiles.grandchild, "utf8"), 10);
    assert.ok(terminated(childPid), "cancelled parent's child tree must be terminated");
    assert.ok(terminated(grandchildPid), "cancelled parent's grandchild tree must be terminated");
  } finally {
    // Idempotent on success (the tree is already down); on any failure path
    // it kills the probe and its 60s sleeper instead of leaking them.
    await child.abort();
  }
});

// ── zombie-aware termination (#1377) ────────────────────────────────────

/**
 * The boundary token itself, not a benign stand-in (#252): a real
 * unreaped zombie. `bash` backgrounds a short `sleep` and then blocks in
 * its own foreground command — bash does not reap background jobs while a
 * foreground command holds it, so the exited child stays a ZOMBIE. A zombie
 * keeps answering `kill(pid, 0)`, and an orphan re-parented to a PID 1 that
 * never `wait()`s (a container init or bare shell) stays that way forever:
 * the exact false-survivor shape that made the tree fixtures red in
 * constrained sandboxes while CI's reaping init hid the bug.
 */
function zombieHolderScript(pidFile: string): string[] {
  return [
    "-c",
    `sleep 0.2 & echo $! > ${JSON.stringify(pidFile)}; sleep 60`,
  ];
}

/** Poll `/proc` until the pid is a confirmed zombie, or fail with the last
 * observed state so a host that reaps too fast is explicit, not silent. */
async function awaitZombie(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + LOAD_TOLERANT_FILE_WAIT_MS;
  let state = "";
  while (Date.now() < deadline) {
    state = procState(pid);
    if (state === "Z") return;
    if (state === "") {
      throw new Error(`${label}: pid ${pid} vanished before it could be observed as a zombie`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`${label}: pid ${pid} never reached zombie state (last observed state '${state}')`);
}

const NO_PROC_SKIP_REASON =
  "no /proc on this platform: zombie-vs-alive distinction is Linux-only by design, the kill-probe fallback keeps the historical strict semantics (covered by every other fixture here)";

test("processCanExecute is false for a killed-but-unreaped zombie (ground truth /proc)", async (t) => {
  if (!(await requireTreeTooling(t))) return;
  if (!hasProc) {
    t.skip(NO_PROC_SKIP_REASON);
    return;
  }
  const dir = workspace();
  const zombiePidFile = join(dir, "zombie.pid");
  const holder = runProcess({
    file: "bash",
    args: zombieHolderScript(zombiePidFile),
    env: buildChildEnv(["PATH", "HOME"]),
    timeoutMs: 30_000,
  });
  try {
    await waitForFile(zombiePidFile);
    const zombiePid = Number.parseInt(readFileSync(zombiePidFile, "utf8"), 10);
    await awaitZombie(zombiePid, "zombie-holder");
    assert.equal(procState(zombiePid), "Z", "fixture precondition: an unreaped zombie");
    // The boundary paradox itself (#252): the kill probe still answers for a
    // process that cannot execute. Without this, a future predicate that
    // merely wrapped `kill(pid, 0)` would pass every other assertion here.
    assert.doesNotThrow(() => process.kill(zombiePid, 0), "zombie precondition: kill(pid, 0) keeps answering");
    assert.equal(
      processCanExecute(zombiePid),
      false,
      "a zombie cannot execute: it is terminated, even while kill(pid, 0) keeps answering",
    );
    assert.ok(holder.pid !== null);
    assert.equal(processCanExecute(holder.pid), true, "the still-running holder must stay counted as alive");
  } finally {
    await holder.abort();
  }
});

test("a zombie inside the snapshot is reported unreaped, never as a survivor", async (t) => {
  if (!(await requireTreeTooling(t))) return;
  if (!hasProc) {
    t.skip(NO_PROC_SKIP_REASON);
    return;
  }
  const dir = workspace();
  const zombiePidFile = join(dir, "in-tree-zombie.pid");
  // The leader IGNORES TERM, so it stays alive (and non-reaping) through the
  // whole grace: the zombie is guaranteed to sit in the snapshot at
  // verification time regardless of how fast the host's init reaps orphans.
  // The KILL escalation ends the leader, exactly the path a TERM-ignoring
  // tree takes.
  const leader = runProcess({
    file: "bash",
    args: ["-c", `sleep 0.2 & echo $! > ${JSON.stringify(zombiePidFile)}; trap '' TERM; sleep 60`],
    env: buildChildEnv(["PATH", "HOME"]),
  });
  try {
    await waitForFile(zombiePidFile);
    const zombiePid = Number.parseInt(readFileSync(zombiePidFile, "utf8"), 10);
    await awaitZombie(zombiePid, "in-tree zombie");
    assert.ok(leader.pid !== null);
    const report = await terminateProcessTreeByPid(leader.pid, { graceMs: 500 });
    assert.ok(report.swept, "the pgrep sweep ran (preflight guarantees it here)");
    assert.ok(
      report.snapshot.includes(zombiePid),
      "the unreaped zombie is still a child of the leader and must be in the pre-signal snapshot",
    );
    assert.deepEqual(report.survived, [], "a zombie cannot execute: it must never be reported as a survivor");
    // Pin the split itself in the direction that is deterministic on ANY
    // init: a pid still observed as a zombie at this instant was a zombie
    // during the sweep too (a zombie cannot un-die), so the sweep must have
    // classified it `unreaped`. The converse cannot be pinned: on a host
    // whose init reaps orphans, the re-parented zombie legitimately becomes
    // `gone` right after the KILL escalation, and an out-of-tree reaper can
    // not be constructed — the sweep kills every in-tree parent by design.
    if (procState(zombiePid) === "Z") {
      assert.ok(
        report.unreaped.includes(zombiePid),
        "a snapshot pid still a zombie at verification time must be classified unreaped",
      );
    }
    for (const pid of report.unreaped) {
      assert.ok(report.snapshot.includes(pid), "unreaped entries come from the snapshot");
    }
    assert.equal(processCanExecute(zombiePid), false, "the sweep must leave the zombie unable to execute");
  } finally {
    await leader.abort();
  }
});
