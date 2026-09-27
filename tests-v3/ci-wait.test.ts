import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCiWait, type CiWaitDeps } from "../src/gates/ci-wait.js";
import { isTransientCiRead } from "../src/platform/bounded.js";
import { ForgejoAdapter } from "../src/platform/forgejo.js";
import { GitHubAdapter } from "../src/platform/github.js";
import type { FetchLike } from "../src/platform/http.js";
import type { ExternalChecksOptions, PlatformReadAdapter } from "../src/platform/types.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

type Reply = { status?: number; body?: unknown; raw?: string; transport?: boolean };

/** fetch serving per-path reply sequences (last repeats). */
function sequenceFetch(routes: Record<string, Reply[]>, log: string[] = []): FetchLike {
  const cursors = new Map<string, number>();
  return async (input) => {
    const url = new URL(String(input));
    const key = url.pathname + url.search;
    log.push(key);
    const replies = routes[key];
    if (!replies) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const index = cursors.get(key) ?? 0;
    cursors.set(key, index + 1);
    const reply = replies[Math.min(index, replies.length - 1)]!;
    if (reply.transport) throw new TypeError("fetch failed");
    return new Response(reply.raw ?? JSON.stringify(reply.body ?? null), { status: reply.status ?? 200 });
  };
}

const RUNS = `/repos/o/r/commits/${SHA}/check-runs?per_page=100`;
const STATUS = `/repos/o/r/commits/${SHA}/status`;
const emptyRuns: Reply = { body: { total_count: 0, check_runs: [] } };
const greenStatus: Reply = { body: { state: "success", total_count: 1, statuses: [{ context: "ci/x", state: "success" }] } };

function github(routes: Record<string, Reply[]>, log?: string[]): GitHubAdapter {
  return new GitHubAdapter({ repo: "o/r", prNumber: "7", token: "Bearer t", fetchImpl: sequenceFetch(routes, log) });
}

const strict: ExternalChecksOptions = { transientAsUnknown: true, apiTimeoutSec: "5" };

test("isTransientCiRead: no response, 429, 5xx and non-JSON bodies are transient; 2xx/4xx JSON answers are not", () => {
  assert.equal(isTransientCiRead(null, ""), true);
  assert.equal(isTransientCiRead(0, ""), true);
  assert.equal(isTransientCiRead(429, "{}"), true);
  assert.equal(isTransientCiRead(502, "{}"), true);
  assert.equal(isTransientCiRead(200, "<html>"), true);
  assert.equal(isTransientCiRead(200, ""), true);
  assert.equal(isTransientCiRead(200, "{}"), false);
  assert.equal(isTransientCiRead(404, '{"message":"Not Found"}'), false);
});

test("GitHub externalChecks: transientAsUnknown turns a failed status read into null; the default keeps the v2 fold", async () => {
  for (const failure of [{ transport: true }, { status: 502, raw: "<html>bad gateway</html>" }, { status: 200, raw: "not json" }] as Reply[]) {
    const routes = { [RUNS]: [emptyRuns], [STATUS]: [failure] };
    assert.equal(await github(routes).externalChecks(SHA, strict), null, JSON.stringify(failure));
    assert.deepEqual(await github(routes).externalChecks(SHA, { apiTimeoutSec: "5" }), [], "v2 fold: failed status read reads as no external CI");
  }
});

test("GitHub externalChecks: a transient check-runs read is unknown too (no partial fold onto statuses)", async () => {
  const routes = { [RUNS]: [{ transport: true } as Reply], [STATUS]: [greenStatus] };
  assert.equal(await github(routes).externalChecks(SHA, strict), null);
  assert.deepEqual(await github(routes).externalChecks(SHA, {}), [{ name: "ci/x", state: "success" }]);
});

test("GitHub externalChecks: a 4xx JSON answer is persistent, not transient — strict mode still folds it", async () => {
  const routes = { [RUNS]: [{ status: 403, body: { message: "Resource not accessible by integration" } }], [STATUS]: [greenStatus] };
  assert.deepEqual(await github(routes).externalChecks(SHA, strict), [{ name: "ci/x", state: "success" }]);
});

test("Forgejo externalChecks: transientAsUnknown retries transport/5xx/undecodable reads; a 404 keeps the v2 fold", async () => {
  const path = `/api/v1/repos/o/r/commits/${SHA}/status`;
  const forgejo = (reply: Reply): ForgejoAdapter => new ForgejoAdapter({
    repo: "o/r", prNumber: "7", baseUrl: "https://forgejo.example", token: "t", fetchImpl: sequenceFetch({ [path]: [reply] }),
  });
  for (const reply of [{ transport: true }, { status: 500, body: {} }, { status: 200, raw: "garbage" }] as Reply[]) {
    assert.equal(await forgejo(reply).externalChecks(SHA, strict), null, JSON.stringify(reply));
    assert.deepEqual(await forgejo(reply).externalChecks(SHA, {}), []);
  }
  assert.deepEqual(await forgejo({ status: 404, body: { message: "nope" } }).externalChecks(SHA, strict), []);
  assert.deepEqual(
    await forgejo({ body: { state: "success", statuses: [{ context: "ci/w", status: "success" }] } }).externalChecks(SHA, strict),
    [{ name: "ci/w", state: "success" }],
  );
});

interface Harness {
  deps: CiWaitDeps;
  out: string[];
  err: string[];
  outputFile: string;
  checksFile: string;
  dir: string;
  clock: () => number;
  sleeps: number[];
}

function harness(adapter: PlatformReadAdapter, env: Record<string, string> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "ci-wait-test-"));
  const outputFile = join(dir, "out");
  writeFileSync(outputFile, "");
  const checksFile = join(dir, "ci-checks-context.md");
  let clock = 1_767_225_600;
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  return {
    deps: {
      env: {
        CI_STATUS_CHECK: "true", GH_TOKEN: "t", REPO: "o/r", PR_NUMBER: "7", PR_HEAD_SHA: SHA,
        GITHUB_OUTPUT: outputFile, CI_CHECKS_FILE: checksFile, CI_INTERVAL_SEC: "10", CI_TIMEOUT_SEC: "60", ...env,
      },
      adapterFactory: () => adapter,
      now: () => clock * 1000,
      sleep: async (seconds) => {
        sleeps.push(seconds);
        clock += seconds;
      },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      pid: 7,
    },
    out, err, outputFile, checksFile, dir, sleeps, clock: () => clock,
  };
}

function fakeAdapter(replies: ({ name: string; state: string }[] | null)[], pr: unknown = null): PlatformReadAdapter & { calls: ExternalChecksOptions[] } {
  const calls: ExternalChecksOptions[] = [];
  let index = 0;
  return {
    calls,
    platform: "github",
    getPr: async () => pr,
    externalChecks: async (_sha: string, options?: ExternalChecksOptions) => {
      calls.push(options ?? {});
      return replies[Math.min(index++, replies.length - 1)] ?? null;
    },
  } as unknown as PlatformReadAdapter & { calls: ExternalChecksOptions[] };
}

test("runCiWait: disabled gate writes ci_status_skipped=true and exits 0 without touching the platform", async () => {
  const adapter = fakeAdapter([[]]);
  const h = harness(adapter, { CI_STATUS_CHECK: "TRUE" });
  assert.equal(await runCiWait(h.deps), 0, "the enable check is case-sensitive, like wait_for_ci.sh");
  assert.equal(readFileSync(h.outputFile, "utf8"), "ci_status_skipped=true\n");
  assert.equal(adapter.calls.length, 0);
  rmSync(h.dir, { recursive: true, force: true });
});

test("runCiWait: missing token/repo/PR is a soft skip on stderr", async () => {
  const h = harness(fakeAdapter([[]]), { GH_TOKEN: "", GITHUB_TOKEN: "" });
  assert.equal(await runCiWait(h.deps), 0);
  assert.deepEqual(h.err, ["Missing GH_TOKEN, REPO, or PR_NUMBER for CI status check"]);
  assert.equal(readFileSync(h.outputFile, "utf8"), "ci_status_skipped=true\n");
  rmSync(h.dir, { recursive: true, force: true });
});

test("runCiWait: every read uses transientAsUnknown and the shared deadline", async () => {
  const adapter = fakeAdapter([[{ name: "b", state: "success" }]]);
  const h = harness(adapter, { GITHUB_RUN_ID: "42", CI_STATUS_CONTEXT: "mine", CI_API_TIMEOUT_SEC: "3" });
  assert.equal(await runCiWait(h.deps), 0);
  const options = adapter.calls[0]!;
  assert.equal(options.transientAsUnknown, true);
  assert.equal(options.runId, "42");
  assert.equal(options.statusContext, "mine");
  assert.equal(options.apiTimeoutSec, "3");
  assert.equal(options.deadlineEpoch, String(1_767_225_600 + 60));
  rmSync(h.dir, { recursive: true, force: true });
});

test("runCiWait: unknown reads retry until real CI state instead of finalizing none", async () => {
  const h = harness(fakeAdapter([null, null, null, [{ name: "ci/legacy", state: "success" }]]));
  assert.equal(await runCiWait(h.deps), 0);
  assert.equal(readFileSync(h.outputFile, "utf8"), "ci_status_final=success\nci_status_skipped=false\n");
  assert.match(readFileSync(h.checksFile, "utf8"), /\| ci\/legacy \| success \|\n$/);
  assert.equal(h.clock() - 1_767_225_600, 30);
  rmSync(h.dir, { recursive: true, force: true });
});

test("runCiWait: the poll sleep is clamped to the remaining deadline", async () => {
  const h = harness(fakeAdapter([[{ name: "b", state: "pending" }]]), { CI_TIMEOUT_SEC: "25", CI_SKIP_ON_TIMEOUT: "true" });
  assert.equal(await runCiWait(h.deps), 1);
  assert.deepEqual(h.sleeps, [10, 10, 5], "the last sleep takes only the 5s left, never a full interval past the deadline");
  assert.equal(readFileSync(h.outputFile, "utf8"), "ci_status_skipped=true\n");
  assert.match(readFileSync(h.checksFile, "utf8"), /overall: timeout \(CI did not finish in time\)/);
  rmSync(h.dir, { recursive: true, force: true });
});

test("runCiWait: an unresolvable head SHA is fatal (exit 2)", async () => {
  const h = harness(fakeAdapter([[]], { head: {} }), { PR_HEAD_SHA: "" });
  assert.equal(await runCiWait(h.deps), 2);
  assert.match(h.err[0] ?? "", /ERROR: Could not resolve head SHA for #7$/);
  rmSync(h.dir, { recursive: true, force: true });
});

test("runCiWait: the head SHA is looked up once and pinned for the whole wait", async () => {
  let lookups = 0;
  const adapter = fakeAdapter([[{ name: "b", state: "pending" }], [{ name: "b", state: "success" }]]);
  adapter.getPr = async () => {
    lookups += 1;
    return { head: { sha: lookups === 1 ? SHA : "f".repeat(40) } };
  };
  const h = harness(adapter, { PR_HEAD_SHA: "" });
  assert.equal(await runCiWait(h.deps), 0);
  assert.equal(lookups, 1);
  assert.match(readFileSync(h.checksFile, "utf8"), new RegExp(`for commit ${SHA} `));
  rmSync(h.dir, { recursive: true, force: true });
});

test("runCiWait: evidence is published atomically and a failed publish leaves no temp sibling", async () => {
  const tmpSeen: (string | null)[] = [];
  const h = harness(fakeAdapter([[{ name: "b", state: "failure" }]]));
  h.deps.onTmpChange = (path) => tmpSeen.push(path);
  assert.equal(await runCiWait(h.deps), 0);
  assert.deepEqual(tmpSeen, [`${h.checksFile}.tmp.7`, null]);
  assert.equal(readdirSync(h.dir).some((name) => name.includes(".tmp.")), false);

  // Target is a directory: the rename fails, the temp file is removed.
  const blocked = harness(fakeAdapter([[{ name: "b", state: "success" }]]));
  rmSync(blocked.checksFile, { force: true });
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(blocked.checksFile, "sub"), { recursive: true });
  assert.equal(await runCiWait(blocked.deps), 0);
  assert.equal(existsSync(`${blocked.checksFile}.tmp.7`), false);
  rmSync(h.dir, { recursive: true, force: true });
  rmSync(blocked.dir, { recursive: true, force: true });
});

test("runCiWait: no external checks finalizes none after two intervals and writes no evidence", async () => {
  const h = harness(fakeAdapter([[]]));
  assert.equal(await runCiWait(h.deps), 0);
  assert.equal(readFileSync(h.outputFile, "utf8"), "ci_status_final=none\nci_status_skipped=false\n");
  assert.equal(existsSync(h.checksFile), false);
  rmSync(h.dir, { recursive: true, force: true });
});
