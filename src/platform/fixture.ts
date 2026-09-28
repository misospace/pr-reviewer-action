/** Fixture CLI for the `platform-normalization` parity boundary (#706 PR 1):
 * `node dist/index.js platform-normalization-fixture <fixture.json>`.
 *
 * The fixture carries raw forge responses (GitHub REST/GraphQL, Forgejo
 * /api/v1) as a route table. This mode drives the REAL v3 adapters over an
 * injected fetch that serves those routes, then prints one JSON line
 * `{ok, values}` whose values the v2 runner
 * (`tests/parity_runners/v2_platform_normalization.py`, which drives the real
 * shell seam over stub `gh`/`curl` binaries serving the same routes) must
 * reproduce exactly:
 *
 * - `cNN_<op>`: the call's `{ok, data}` as order-preserving ASCII JSON
 *   (`json.dumps(..., ensure_ascii=True, separators=(",", ":"))`), so key
 *   order, element order and every string byte are compared;
 * - `cNN_<op>_text`: byte-significant artifacts (the `pr-files.json` line,
 *   the external-checks line, the raw diff);
 * - `requests`: the ordered request log (method, URL, whether a credential
 *   was attached, GraphQL body), pinning HTTP routing and pagination. */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgejoEnrichClient, GitHubEnrichClient } from "./enrich.js";
import { ForgejoAdapter } from "./forgejo.js";
import { GitHubAdapter } from "./github.js";
import type { FetchLike } from "./http.js";
import { jqCompact, JqError } from "./jq.js";
import { projectPrFiles } from "./normalize.js";
import { SemanticFixtureAdapter } from "./semantic-fixture.js";
import type { ExternalChecksOptions, PlatformReadAdapter, ReadResult } from "./types.js";

export const FIXTURE_GITHUB_API = "https://api.github.com";
export const FIXTURE_FORGEJO_URL = "https://forgejo.example";
const FIXTURE_TOKEN = "fixture-token";

interface Route {
  match: string;
  status?: number;
  body?: unknown;
  raw?: string;
  pages?: unknown[];
  hang?: boolean;
}

interface Call {
  op: string;
  [key: string]: unknown;
}

interface PlatformFixture {
  platform?: "github" | "forgejo";
  repo?: string;
  pr_number?: string | number;
  env?: Record<string, string>;
  routes?: Route[];
  semantic_fixture?: { pr_json?: unknown; diff?: string; files?: unknown };
  calls?: Call[];
}

/** `json.dumps(value, ensure_ascii=True, separators=(",", ":"))` with
 * insertion order kept. */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : record[key];
}

function relative(url: URL): string {
  return url.href.slice(url.origin.length + 1);
}

/** A fetch serving the fixture route table and logging every request. */
export function routeFetch(routes: readonly Route[], log: string[]): FetchLike {
  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = headerValue(init, "Authorization") ? 1 : 0;
    let key: string;
    if (method === "POST" && url.pathname.endsWith("/graphql")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
      key = (body.query ?? "").includes("reviewThreads") ? "graphql:reviewThreads" : "graphql:comments";
      log.push(`POST ${url.origin}${url.pathname} auth=${auth} ${sortedJson(body)}`);
    } else {
      key = relative(url);
      log.push(`${method} ${url.href} auth=${auth}`);
    }
    const stripped = new URL(url.href);
    stripped.searchParams.delete("per_page");
    stripped.searchParams.delete("page");
    const strippedKey = relative(stripped).replace(/\?$/, "");
    const route = routes.find((r) => r.match === key || r.match === url.href || (r.pages !== undefined && r.match === strippedKey));
    if (!route) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    if (route.hang) {
      // A hung server: settle only when the caller's signal aborts. The
      // AbortSignal.timeout timer is unref'd (a real socket keeps the loop
      // alive), so hold a ref'd timer until then.
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        const keepAlive = setTimeout(() => reject(new Error("fixture hang exceeded 120s")), 120_000);
        const abort = (): void => {
          clearTimeout(keepAlive);
          reject(signal?.reason);
        };
        if (!signal) return;
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }
    const status = route.status ?? 200;
    if (route.pages !== undefined) {
      const page = Number(url.searchParams.get("page") ?? "1");
      const headers: Record<string, string> = {};
      if (page < route.pages.length) {
        headers.Link = `<${url.origin}/${route.match}?per_page=100&page=${page + 1}>; rel="next"`;
      }
      return new Response(JSON.stringify(route.pages[page - 1] ?? []), { status, headers });
    }
    const text = route.raw !== undefined ? route.raw : JSON.stringify(route.body ?? null);
    return new Response(text, { status });
  };
}

function encodeRead(result: ReadResult<unknown>): string {
  return result.ok ? asciiJson({ ok: true, data: result.data }) : asciiJson({ ok: false });
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : fallback;
}

async function runCall(
  adapter: PlatformReadAdapter,
  call: Call,
  env: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<Record<string, string>> {
  switch (call.op) {
    case "pr":
      return { "": asciiJson(await adapter.getPr()) };
    case "diff":
      return { text: await adapter.getPrDiff() };
    case "pr-files": {
      const result = await adapter.listPrFiles();
      const values: Record<string, string> = { "": encodeRead(result) };
      if (result.ok && typeof call.total_changed_files === "number") {
        try {
          values.text = projectPrFiles(result.data, call.total_changed_files);
        } catch (error) {
          if (!(error instanceof JqError)) throw error;
          values.text = "<jq-error>";
        }
      }
      return values;
    }
    case "issue":
      return { "": encodeRead(await adapter.getIssue(str(call.repo), str(call.number))) };
    case "conversation-comments":
      return { "": encodeRead(await adapter.listPrConversationComments()) };
    case "review-threads":
      return { "": encodeRead(await adapter.listReviewThreads()) };
    case "reviews-paginated":
      return { "": encodeRead(await adapter.listPrReviewsPaginated()) };
    case "external-checks": {
      const options: ExternalChecksOptions = {
        runId: env.GITHUB_RUN_ID,
        statusContext: env.CI_STATUS_CONTEXT,
        apiTimeoutSec: env.CI_API_TIMEOUT_SEC,
        ciTimeoutSec: env.CI_TIMEOUT_SEC,
        deadlineEpoch: env.CI_DEADLINE_EPOCH,
      };
      const checks = await adapter.externalChecks(str(call.sha), options);
      return { text: checks === null ? "" : jqCompact(checks) };
    }
    case "github-enrich": {
      const client = new GitHubEnrichClient({
        token: typeof call.token === "string" && call.token !== "" ? `Bearer ${call.token}` : undefined,
        fetchImpl,
      });
      return { "": asciiJson({ data: await client.get(str(call.endpoint)) }) };
    }
    case "forgejo-enrich-release":
    case "forgejo-enrich-compare": {
      const client = adapter instanceof ForgejoAdapter ? adapter.enrichClient() : new ForgejoEnrichClient({ fetchImpl });
      const data = call.op === "forgejo-enrich-release"
        ? await client.release(str(call.host), str(call.repo), str(call.tag))
        : await client.compare(str(call.host), str(call.repo), str(call.spec));
      return { "": asciiJson({ ok: data !== null, data }) };
    }
    default:
      throw new Error(`unknown platform-normalization op: ${call.op}`);
  }
}

export async function runPlatformNormalizationFixture(fixturePath: string): Promise<{ ok: boolean; values?: Record<string, string>; stderr?: string }> {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as PlatformFixture;
  const env = fixture.env ?? {};
  const log: string[] = [];
  const fetchImpl = routeFetch(fixture.routes ?? [], log);
  const repo = fixture.repo ?? "o/r";
  const prNumber = str(fixture.pr_number, "1");
  let cleanup: string | null = null;
  let adapter: PlatformReadAdapter;
  if (fixture.semantic_fixture) {
    cleanup = mkdtempSync(join(tmpdir(), "platform-semantic-"));
    const api = join(cleanup, ".semantic-fixture");
    mkdirSync(api);
    writeFileSync(join(api, "pr.json"), JSON.stringify(fixture.semantic_fixture.pr_json ?? {}));
    writeFileSync(join(api, "diff"), fixture.semantic_fixture.diff ?? "");
    writeFileSync(join(api, "files.json"), JSON.stringify(fixture.semantic_fixture.files ?? []));
    adapter = new SemanticFixtureAdapter({ dir: cleanup, platform: fixture.platform ?? "github" });
  } else if (fixture.platform === "forgejo") {
    adapter = new ForgejoAdapter({ repo, prNumber, baseUrl: FIXTURE_FORGEJO_URL, token: FIXTURE_TOKEN, fetchImpl });
  } else {
    adapter = new GitHubAdapter({ repo, prNumber, token: `Bearer ${FIXTURE_TOKEN}`, fetchImpl });
  }
  const values: Record<string, string> = {};
  try {
    for (const [index, call] of (fixture.calls ?? []).entries()) {
      const prefix = `c${String(index).padStart(2, "0")}_${call.op}`;
      for (const [suffix, value] of Object.entries(await runCall(adapter, call, env, fetchImpl))) {
        values[suffix === "" ? prefix : `${prefix}_${suffix}`] = value;
      }
    }
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
  values.requests = asciiJson(log);
  return { ok: true, values };
}
