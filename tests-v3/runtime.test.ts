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
  runProcess,
  terminateProcessTree,
} from "../src/runtime/index.js";

const execFileBounded = promisify(execFile);

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "v3-runtime-"));
}

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

function pidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
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
  assert.ok(pidDead(childPid), "leader should be dead");
  assert.ok(pidDead(grandchildPid), "grandchild should be dead — wrapper-only cleanup is the #634 bug");
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
  assert.ok(pidDead(escapedPid), "detached (new process group) descendant must still be reaped");
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
      deadlineMs: 5000,
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
    assert.ok(pidDead(childPid), "cancelled parent's child tree must be terminated");
    assert.ok(pidDead(grandchildPid), "cancelled parent's grandchild tree must be terminated");
  } finally {
    // Idempotent on success (the tree is already down); on any failure path
    // it kills the probe and its 60s sleeper instead of leaking them.
    await child.abort();
  }
});
