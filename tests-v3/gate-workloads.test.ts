import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ciGateBranch, runConcurrentGates, specialistGateBranch } from "../src/gates/index.js";
import { createCancellationScope } from "../src/runtime/index.js";

/**
 * End to end (#706 PR 6): runConcurrentGates launches the two real gate
 * sub-modes of the built bundle (`node dist/index.js gate-ci` /
 * `gate-specialists`) under their env allowlists, against local mock
 * GitHub-API and model endpoints — no network, no model.
 */

const ENTRY = resolve("dist/index.js");
const SHA = "0123456789abcdef0123456789abcdef01234567";

interface Mock {
  url: string;
  hits: string[];
  openSockets: () => number;
  close: () => Promise<void>;
}

async function mockServer(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void): Promise<Mock> {
  const hits: string[] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      hits.push(`${req.method} ${req.url} auth=${req.headers.authorization ? 1 : 0}`);
      handler(req, Buffer.concat(chunks).toString("utf8"), res);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    openSockets: () => sockets.size,
    close: () => new Promise<void>((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    }),
  };
}

function json(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function githubApi(checkState: "completed" | "in_progress"): (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void {
  return (req, _body, res) => {
    if (req.url === `/repos/o/r/commits/${SHA}/check-runs?per_page=100`) {
      json(res, { total_count: 1, check_runs: [{ name: "build", status: checkState, conclusion: checkState === "completed" ? "success" : null }] });
    } else if (req.url === `/repos/o/r/commits/${SHA}/status`) {
      json(res, { state: "pending", total_count: 0, statuses: [] });
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  };
}

function leadResponse(res: http.ServerResponse): void {
  json(res, {
    id: "c1", object: "chat.completion", model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ leads: [{ severity: "minor", category: "tests", file: null, line: null, message: "add a test" }] }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  });
}

function workspace(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "gate-workloads-"));
  writeFileSync(join(dir, "specialist-corpus.md"), "# corpus\n\n+x = 1\n");
  writeFileSync(join(dir, "github-output"), "");
  return {
    dir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      GITHUB_WORKSPACE: dir,
      GITHUB_OUTPUT: join(dir, "github-output"),
      CI_CHECKS_FILE: join(dir, "ci-checks-context.md"),
      CI_STATUS_CHECK: "true",
      CI_INTERVAL_SEC: "1",
      CI_TIMEOUT_SEC: "60",
      GH_TOKEN: "gh-test-token",
      REPO: "o/r",
      PR_NUMBER: "7",
      PR_HEAD_SHA: SHA,
      DEEP_REVIEW: "true",
      AI_MODEL: "m",
      AI_API_KEY: "sk-model-key",
      AI_STREAM: "false",
      // Reviewer-only secrets that neither gate may carry.
      TOOL_MCP_TOKEN: "mcp-secret",
      LINEAR_API_KEY: "linear-secret",
    },
  };
}

test("runConcurrentGates launches both dist sub-modes, joins them, and each writes its real outputs", async () => {
  const github = await mockServer(githubApi("completed"));
  const model = await mockServer((_req, _body, res) => leadResponse(res));
  const { dir, env } = workspace();
  try {
    const result = await runConcurrentGates({
      ci: ciGateBranch({ entry: ENTRY, timeoutMs: 60_000 }),
      specialists: specialistGateBranch({ entry: ENTRY, args: ["--corpus", "specialist-corpus.md"], cwd: dir, timeoutMs: 60_000 }),
      ambientEnv: { ...env, GITHUB_API_URL: github.url, AI_BASE_URL: `${model.url}/v1` },
    });
    assert.equal(result.ci.ok, true, result.ci.error ?? "");
    assert.equal(result.specialists.ok, true, result.specialists.error ?? "");
    assert.equal(readFileSync(join(dir, "github-output"), "utf8"), "ci_status_final=success\nci_status_skipped=false\n");
    assert.match(readFileSync(join(dir, "ci-checks-context.md"), "utf8"), /\| build \| success \|\n$/);
    const aggregate = JSON.parse(readFileSync(join(dir, "specialists.json"), "utf8")) as { total_leads: number; request_count: number };
    assert.equal(aggregate.total_leads, 3);
    assert.equal(aggregate.request_count, 3);
    assert.ok(github.hits.every((hit) => hit.endsWith("auth=1")), "the CI child authenticated with its platform token");
    assert.equal(model.hits.length, 3);
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name), "utf8");
      assert.equal(text.includes("mcp-secret") || text.includes("linear-secret") || text.includes("sk-model-key"), false, `${name} leaked a secret`);
    }
  } finally {
    await github.close();
    await model.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("abnormal exit: parent cancellation terminates both workload trees mid-flight, the join still resolves, nothing half-written survives", async () => {
  const github = await mockServer(githubApi("in_progress"));
  // The model endpoint never answers: the specialist child is parked in a
  // live request when the parent goes away.
  const model = await mockServer(() => {});
  const { dir, env } = workspace();
  const scope = createCancellationScope();
  try {
    const pending = runConcurrentGates({
      ci: ciGateBranch({ entry: ENTRY }),
      specialists: specialistGateBranch({ entry: ENTRY, args: ["--corpus", "specialist-corpus.md"], cwd: dir }),
      scope,
      ambientEnv: { ...env, GITHUB_API_URL: github.url, AI_BASE_URL: `${model.url}/v1` },
    });
    const deadline = Date.now() + 15_000;
    while ((github.hits.length < 2 || model.hits.length < 3) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(github.hits.length >= 2, "the CI child was polling");
    assert.equal(model.hits.length, 3, "all three specialist calls were in flight");
    scope.abort("SIGTERM");
    const result = await pending;
    assert.equal(result.ci.status, "cancelled");
    assert.equal(result.specialists.status, "cancelled");
    assert.deepEqual(result.ci.survivedPids, []);
    assert.deepEqual(result.specialists.survivedPids, []);
    // The specialist child's in-flight model connections died with it.
    const settle = Date.now() + 5_000;
    while (model.openSockets() > 0 && Date.now() < settle) await new Promise((done) => setTimeout(done, 50));
    assert.equal(model.openSockets(), 0);
    const hitsAfter = github.hits.length;
    await new Promise((done) => setTimeout(done, 1_500));
    assert.equal(github.hits.length, hitsAfter, "the CI child stopped polling");
    assert.equal(readFileSync(join(dir, "github-output"), "utf8"), "", "a cancelled CI gate published no outcome");
    assert.equal(existsSync(join(dir, "specialists.json")), false);
    assert.equal(readdirSync(dir).some((name) => name.includes(".tmp.")), false);
  } finally {
    await github.close();
    await model.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
