import test from "node:test";
import assert from "node:assert/strict";
import { execPath } from "node:process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildChildEnv,
  createCancellationScope,
  runProcess,
} from "../src/runtime/index.js";
import {
  CI_GATE_ENV_KEYS,
  CI_GATE_FORBIDDEN_KEYS,
  SPECIALIST_GATE_ENV_KEYS,
  SPECIALIST_GATE_FORBIDDEN_KEYS,
  runConcurrentGates,
  type GateBranch,
} from "../src/gates/index.js";

function sleepBranch(seconds: number, exitCode = 0): GateBranch {
  return {
    file: "bash",
    args: ["-c", `sleep ${seconds}; exit ${exitCode}`],
    envAllowlist: ["PATH", "HOME"],
  };
}

const ambientBase: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
};

test("gates compose concurrently: wall clock near max, not the sum", async () => {
  const startedAt = Date.now();
  const result = await runConcurrentGates({
    ci: sleepBranch(0.5),
    specialists: sleepBranch(0.2),
    ambientEnv: ambientBase,
  });
  const elapsed = Date.now() - startedAt;
  // max = 500ms, sum = 700ms; generous margins for loaded runners.
  assert.ok(elapsed >= 480 && elapsed < 650, `elapsed ${elapsed}ms must be near max(500), not sum(700)`);
  assert.equal(result.ci.ok, true);
  assert.equal(result.specialists.ok, true);
});

test("CI gate failure is fail-soft (historical continue-on-error preserved)", async () => {
  for (const code of [1, 2]) {
    const result = await runConcurrentGates({
      ci: sleepBranch(0.05, code),
      specialists: sleepBranch(0.05),
      ambientEnv: ambientBase,
    });
    assert.equal(result.ci.ok, false);
    assert.equal(result.ci.exitCode, code);
    assert.equal(result.specialists.ok, true, "a failed CI gate never fails the specialist branch");
  }
});

test("specialist failure is fail-soft (advisory passes never block)", async () => {
  const result = await runConcurrentGates({
    ci: sleepBranch(0.3),
    specialists: sleepBranch(0.05, 1),
    ambientEnv: ambientBase,
  });
  assert.equal(result.specialists.ok, false);
  assert.equal(result.ci.ok, true, "one gate failing while the other continues");
});

test("both gates disabled is a no-op fast path", async () => {
  const startedAt = Date.now();
  const result = await runConcurrentGates({ ambientEnv: ambientBase });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 300, `disabled gates must be a fast no-op, took ${elapsed}ms`);
  assert.equal(result.ci.ran, false);
  assert.equal(result.specialists.ran, false);
  assert.equal(result.ci.ok, true);
  assert.equal(result.specialists.ok, true);
});

test("specialist deadline with stragglers: deadline branch terminated, sibling finalizes", async () => {
  const result = await runConcurrentGates({
    ci: sleepBranch(0.4),
    specialists: {
      file: "bash",
      args: ["-c", "sleep 60"],
      envAllowlist: ["PATH", "HOME"],
      timeoutMs: 250,
    },
    ambientEnv: ambientBase,
  });
  assert.equal(result.specialists.ok, false);
  assert.equal(result.specialists.status, "timeout");
  assert.equal(result.ci.ok, true, "the non-straggler gate still finalizes");
});

test("parent cancellation mid-flight terminates both gates, join still resolves", async () => {
  const scope = createCancellationScope();
  const pending = runConcurrentGates({
    ci: sleepBranch(60),
    specialists: sleepBranch(60),
    scope,
    ambientEnv: ambientBase,
  });
  setTimeout(() => scope.abort("SIGTERM"), 150);
  const result = await pending;
  assert.equal(result.ci.status, "cancelled");
  assert.equal(result.specialists.status, "cancelled");
  assert.equal(result.ci.ok, false);
  assert.equal(result.specialists.ok, false);
});

test("CI allowlist mirrors the bash _CI_GATE_ENV_KEYS list exactly", () => {
  const gatingPath = join(process.cwd(), "scripts", "sections", "gating.sh");
  const source = readFileSync(gatingPath, "utf8");
  const block = source.slice(
    source.indexOf("_CI_GATE_ENV_KEYS=("),
    source.indexOf(")", source.indexOf("_CI_GATE_ENV_KEYS=(")),
  );
  const bashKeys = block
    .split("\n")
    .slice(1)
    .flatMap((line) => line.trim().split(/\s+/))
    .filter((key) => key.length > 0 && key !== ")");
  assert.deepEqual(
    [...CI_GATE_ENV_KEYS].sort(),
    [...new Set(bashKeys)].sort(),
    "TS CI allowlist must stay key-for-key identical to gating.sh while v2/v3 coexist",
  );
});

test("CI/specialist forbidden key sets are excluded from their allowlists", () => {
  for (const key of CI_GATE_FORBIDDEN_KEYS) {
    assert.equal(CI_GATE_ENV_KEYS.includes(key), false, `${key} must never be in the CI allowlist`);
  }
  for (const key of SPECIALIST_GATE_FORBIDDEN_KEYS) {
    assert.equal(SPECIALIST_GATE_ENV_KEYS.includes(key), false, `${key} must never be in the specialist allowlist`);
  }
});

test("specialist child env: model credentials in, tool/Linear secrets out", async () => {
  const ambient: NodeJS.ProcessEnv = {
    ...ambientBase,
    AI_API_KEY: "SENTINEL-AI-KEY",
    AI_MODEL: "test-model",
    TOOL_MCP_TOKEN: "SENTINEL-MCP-TOKEN",
    LINEAR_API_KEY: "SENTINEL-LINEAR-KEY",
  };
  const childEnv = buildChildEnv(SPECIALIST_GATE_ENV_KEYS, ambient);
  assert.equal(childEnv.AI_API_KEY, "SENTINEL-AI-KEY", "specialists need the model credential");
  assert.equal(childEnv.AI_MODEL, "test-model");
  assert.equal(childEnv.TOOL_MCP_TOKEN, undefined);
  assert.equal(childEnv.LINEAR_API_KEY, undefined);

  // End-to-end: the launched specialist child really observes this env.
  const handle = runProcess({
    file: execPath,
    args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
    env: childEnv,
  });
  const observed = JSON.parse((await handle.result).stdout.toString("utf8")) as Record<string, string>;
  assert.equal(observed.AI_API_KEY, "SENTINEL-AI-KEY");
  assert.equal(observed.TOOL_MCP_TOKEN, undefined);
  assert.equal(observed.LINEAR_API_KEY, undefined);
});

test("end-to-end CI child env through runConcurrentGates excludes reviewer secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-gates-"));
  const dumpPath = join(dir, "ci-env.json");
  const result = await runConcurrentGates({
    ci: {
      file: execPath,
      args: [
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.env))`,
      ],
      envAllowlist: CI_GATE_ENV_KEYS,
    },
    ambientEnv: {
      ...ambientBase,
      AI_API_KEY: "SENTINEL-AI-KEY",
      TOOL_MCP_TOKEN: "SENTINEL-MCP-TOKEN",
      LINEAR_API_KEY: "SENTINEL-LINEAR-KEY",
      GH_TOKEN: "SENTINEL-GH-TOKEN",
      REPO: "owner/repo",
    },
  });
  assert.equal(result.ci.ok, true);
  const observed = JSON.parse(readFileSync(dumpPath, "utf8")) as Record<string, string>;
  assert.equal(observed.AI_API_KEY, undefined);
  assert.equal(observed.TOOL_MCP_TOKEN, undefined);
  assert.equal(observed.LINEAR_API_KEY, undefined);
  assert.equal(observed.GH_TOKEN, "SENTINEL-GH-TOKEN", "GitHub auth is required by the CI gate");
  assert.equal(observed.REPO, "owner/repo");
});

test("launch refusal is loud: GateLaunchError thrown, sibling terminated", async () => {
  // Build a PATH without pgrep so preflightTreeCleanup fails.
  const dir = mkdtempSync(join(tmpdir(), "v3-nopgrep-"));
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, "probe.cjs");
  const buildDir = join(process.cwd(), ".test-build", "src", "gates");
  writeFileSync(
    scriptPath,
    `
    const path = require('path');
    const { runConcurrentGates } = require(path.join(${JSON.stringify(buildDir)}, 'gates.js'));
    runConcurrentGates({
      ci: { file: 'bash', args: ['-c', 'sleep 30'], envAllowlist: ['PATH'] },
      specialists: { file: 'bash', args: ['-c', 'sleep 30'], envAllowlist: ['PATH'] },
      ambientEnv: { PATH: ${JSON.stringify(dir)} },
    }).then(
      (r) => process.stdout.write(JSON.stringify({ ok: true, r })),
      (e) => process.stdout.write(JSON.stringify({ ok: false, name: e.name, message: e.message })),
    ).then(() => process.exit(0));
  `,
  );
  const handle = runProcess({
    file: execPath,
    args: [scriptPath],
    env: { PATH: dir, HOME: ambientBase.HOME ?? "" },
    timeoutMs: 20_000,
  });
  const probeResult = await handle.result;
  assert.equal(probeResult.status, "exited");
  const probe = JSON.parse(probeResult.stdout.toString("utf8")) as {
    ok: boolean;
    name?: string;
    message?: string;
  };
  assert.equal(probe.ok, false, "with pgrep unavailable the gates must refuse to launch");
  assert.equal(probe.name, "GateLaunchError");
  assert.match(probe.message ?? "", /pgrep is required/);
});
