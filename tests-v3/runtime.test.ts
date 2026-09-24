import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import {
  buildChildEnv,
  createCancellationScope,
  leakedEnvKeys,
  runProcess,
  terminateProcessTree,
} from "../src/runtime/index.js";

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

test("timeout terminates the child AND its grandchild (spawn-then-hang fixture)", async () => {
  const dir = workspace();
  const tree = sleepTreeScript(dir, "timeout");
  const handle = runProcess({
    file: "bash",
    args: tree.args,
    env: buildChildEnv(["PATH", "HOME"]),
    timeoutMs: 300,
    terminateGraceMs: 2000,
  });
  assert.ok(handle.pid !== null);
  const result = await handle.result;

  assert.equal(result.status, "timeout");
  assert.equal(result.exitCode, null);
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

test("child ignoring SIGTERM still dies via bounded SIGKILL escalation", async () => {
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

test("descendant that escapes the process group is swept by the snapshot", async () => {
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

test("external cancellation (parent action cancelled) terminates both trees", async () => {
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

  scope.abort("job-cancelled");
  const [firstResult, secondResult] = await Promise.all([first.result, second.result]);

  assert.equal(firstResult.status, "cancelled");
  assert.equal(secondResult.status, "cancelled");
  assert.equal(firstResult.exitCode, null);
});

test("normal success preserves output bytes exactly (multibyte, no trailing newline)", async () => {
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

test("output over the per-stream cap is truncated, drain never blocks", async () => {
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

test("structured exit/stderr capture for a failing workload", async () => {
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

test("missing binary is a structured spawn_error, not a throw", async () => {
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

test("child environment is an allowlist: canary secrets never reach the child", async () => {
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

test("after a normal completion nothing is left to clean up", async () => {
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

test("terminateProcessTree is a safe no-op on an already-dead child", async () => {
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
  assert.ok(result.exitCode === 0);
  assert.equal(report.survived.length, 0);
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

test("parent SIGTERM during concurrent work: bounded finalize + tree cleanup (end-to-end)", async () => {
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
  assert.ok(child.pid !== null);
  // Wait for the workload tree to be up, then simulate the runner cancelling
  // the parent (SIGTERM).
  await waitForFile(tree.pidFiles.grandchild);
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
});
