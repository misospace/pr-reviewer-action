/** Fixture CLI for the `ci-gate` parity boundary (#706 PR 6):
 * `node dist/index.js ci-gate-fixture <fixture.json>`.
 *
 * Runs the REAL v3 CI gate workload (`runCiWait`) over a virtual clock and an
 * injected fetch serving the fixture's per-route response SEQUENCES (one
 * entry consumed per request, the last one repeating). The v2 runner
 * (`tests/parity_runners/v2_ci_gate.py`) runs the real `wait_for_ci.sh`
 * against stub `gh`/`curl`/`date`/`sleep` binaries sharing the same virtual
 * clock semantics, so both sides observe identical time:
 *
 * - `sleep N` in the poll loop advances the clock by N;
 * - a response entry with `advance: N` advances it by N (a slow API);
 * - `transport: true` is a request that never got a response.
 *
 * Prints one JSON line `{ok, values}`: exit code, `$GITHUB_OUTPUT` bytes,
 * the evidence file bytes (or `<absent>`), leftover temp files, the request
 * log, the virtual elapsed seconds, and the stdout/stderr log lines. */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgejoAdapter } from "../platform/forgejo.js";
import { GitHubAdapter } from "../platform/github.js";
import type { FetchLike } from "../platform/http.js";
import type { PlatformReadAdapter } from "../platform/types.js";
import { runCiWait, type CiEnv } from "./ci-wait.js";

const FIXTURE_TOKEN = "fixture-token";
const FIXTURE_FORGEJO_URL = "https://forgejo.example";

interface ResponseEntry {
  status?: number;
  body?: unknown;
  raw?: string;
  advance?: number;
  transport?: boolean;
}

interface SequenceRoute {
  match: string;
  responses: ResponseEntry[];
}

interface CiGateFixture {
  platform?: "github" | "forgejo";
  repo?: string;
  pr_number?: string | number;
  start_epoch?: number;
  env?: Record<string, string>;
  checks_file?: boolean;
  routes?: SequenceRoute[];
}

function utcClock(epochMs: number): string {
  const date = new Date(epochMs);
  return [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

export async function runCiGateFixture(fixturePath: string): Promise<{ ok: boolean; values: Record<string, string> }> {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as CiGateFixture;
  const start = fixture.start_epoch ?? 1_767_225_600;
  let clock = start;
  const requests: string[] = [];
  const cursors = new Map<string, number>();
  const routes = fixture.routes ?? [];

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = Object.keys(headers).some((key) => key.toLowerCase() === "authorization" && headers[key]) ? 1 : 0;
    requests.push(`${init?.method ?? "GET"} ${url.href} auth=${auth}`);
    const relative = url.href.slice(url.origin.length + 1);
    const route = routes.find((candidate) => candidate.match === relative || candidate.match === url.href);
    if (!route || route.responses.length === 0) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const index = cursors.get(route.match) ?? 0;
    cursors.set(route.match, index + 1);
    const entry = route.responses[Math.min(index, route.responses.length - 1)]!;
    clock += entry.advance ?? 0;
    if (entry.transport) throw new TypeError("fetch failed");
    const text = entry.raw !== undefined ? entry.raw : JSON.stringify(entry.body ?? null);
    return new Response(text, { status: entry.status ?? 200 });
  };

  const work = mkdtempSync(join(tmpdir(), "ci-gate-fixture-"));
  const outputFile = join(work, "github-output");
  writeFileSync(outputFile, "");
  const checksFile = join(work, "ci-checks-context.md");
  const env: Record<string, string> = {
    GH_TOKEN: FIXTURE_TOKEN,
    REPO: fixture.repo ?? "o/r",
    PR_NUMBER: String(fixture.pr_number ?? "1"),
    GITHUB_OUTPUT: outputFile,
    PLATFORM: fixture.platform ?? "github",
    ...(fixture.platform === "forgejo" ? { FORGEJO_API_URL: FIXTURE_FORGEJO_URL, FORGEJO_TOKEN: FIXTURE_TOKEN } : {}),
    ...(fixture.checks_file === false ? {} : { CI_CHECKS_FILE: checksFile }),
    ...(fixture.env ?? {}),
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const adapterFactory = (_env: CiEnv, repo: string, prNumber: string, token: string): PlatformReadAdapter =>
    fixture.platform === "forgejo"
      ? new ForgejoAdapter({ repo, prNumber, baseUrl: FIXTURE_FORGEJO_URL, token: FIXTURE_TOKEN, fetchImpl })
      : new GitHubAdapter({ repo, prNumber, token: `Bearer ${token}`, fetchImpl });

  try {
    const exitCode = await runCiWait({
      env,
      adapterFactory,
      now: () => clock * 1000,
      sleep: async (seconds) => {
        clock += seconds;
      },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      formatClock: utcClock,
      pid: 4242,
    });
    const leftovers = readdirSync(work).filter((name) => name.includes(".tmp.")).sort();
    return {
      ok: true,
      values: {
        exit_code: String(exitCode),
        outputs: readFileSync(outputFile, "utf8"),
        checks_file: existsSync(checksFile) ? readFileSync(checksFile, "utf8") : "<absent>",
        leftovers: JSON.stringify(leftovers),
        requests: JSON.stringify(requests),
        elapsed: String(clock - start),
        stdout: stdout.join("\n"),
        stderr: stderr.join("\n"),
      },
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
