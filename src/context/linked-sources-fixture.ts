/** Fixture CLI for the `linked-sources` parity boundary (#706 PR 5b):
 * `node dist/index.js linked-sources-fixture <fixture.json>`.
 *
 * Runs the REAL v3 render (`renderLinkedSources`), SSRF-safe fetch policy
 * (`fetchSource`: scheme/host/redirect/cap checks, public-DNS gate) and
 * enrich clients, with only the transport seams replaced by the fixture:
 * DNS answers (`dns`), raw-source HTTP exchanges (`http`), the GitHub /
 * Forgejo API route table (`routes`, shared with platform-normalization),
 * and a fake budget clock. The v2 runner
 * (`tests/parity_runners/v2_linked_sources.py`) patches the same seams under
 * `render_linked_sources` and must reproduce `markdown` byte for byte, the
 * sorted request log, and the budget-warning count. */

import { readFileSync } from "node:fs";
import { ForgejoEnrichClient, GitHubEnrichClient } from "../platform/enrich.js";
import { asciiJson, routeFetch } from "../platform/fixture.js";
import { compareCodePoints } from "../platform/jq.js";
import { fetchSource, type Exchange, type Resolver } from "../platform/safe-fetch.js";
import { BudgetTracker } from "./budget.js";
import { parseAllowedHosts } from "./enrichment.js";
import { parseAllowedRepos, renderLinkedSources } from "./linked-sources.js";

interface HttpRoute {
  url: string;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  body_b64?: string;
  repeat?: number;
}

interface LinkedSourcesFixture {
  input?: {
    urls?: string[];
    allowed_source_hosts?: string;
    target_version?: string;
    ghcr_images?: string[];
    compare_shas?: [string, string] | null;
    github_repository?: string;
    tool_allowed_gh_api_repos?: string;
    gh_token?: string;
  };
  budget?: { max_seconds?: number; tick?: number };
  dns?: Record<string, string[] | null>;
  http?: HttpRoute[];
  routes?: Array<{ match: string; status?: number; body?: unknown; raw?: string }>;
  env?: Record<string, string>;
}

function routeBody(route: HttpRoute): Buffer {
  const once = route.body_b64 !== undefined ? Buffer.from(route.body_b64, "base64") : Buffer.from(route.body ?? "", "utf8");
  return route.repeat !== undefined ? Buffer.concat(Array.from({ length: route.repeat }, () => once)) : once;
}

function fixtureExchange(routes: readonly HttpRoute[], log: string[]): Exchange {
  return async (request) => {
    log.push(`GET ${request.url}`);
    const route = routes.find((r) => r.url === request.url);
    if (!route) throw new Error(`no fixture route for ${request.url}`);
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(route.headers ?? {})) headers[key.toLowerCase()] = value;
    return { status: route.status ?? 200, headers, body: routeBody(route) };
  };
}

function fixtureResolver(dns: Record<string, string[] | null>): Resolver {
  return async (host) => {
    const answers = Object.prototype.hasOwnProperty.call(dns, host) ? dns[host] : null;
    if (!answers) throw Object.assign(new Error(`fixture DNS: ${host} not found`), { code: "ENOTFOUND" });
    return answers;
  };
}

export async function runLinkedSourcesFixture(fixturePath: string): Promise<{ ok: boolean; values?: Record<string, string>; stderr?: string }> {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as LinkedSourcesFixture;
  const input = fixture.input ?? {};
  const env = fixture.env ?? {};
  const log: string[] = [];
  const apiFetch = routeFetch(fixture.routes ?? [], log);
  const resolver = fixtureResolver(fixture.dns ?? {});
  const exchange = fixtureExchange(fixture.http ?? [], log);
  let clock = 1000;
  const tick = fixture.budget?.tick ?? 0;
  const warnings: string[] = [];
  const budget = new BudgetTracker(fixture.budget?.max_seconds ?? 60, {
    now: () => {
      const value = clock;
      clock += tick;
      return value;
    },
    warn: (line) => warnings.push(line),
  });
  const forgejoToken = env.FORGEJO_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN ?? "";
  const deps = {
    budget,
    github: new GitHubEnrichClient({ token: input.gh_token ? `token ${input.gh_token}` : undefined, fetchImpl: apiFetch }),
    forgejo: new ForgejoEnrichClient({
      configuredApiUrl: env.FORGEJO_API_URL,
      configuredAuthorization: async () => (forgejoToken ? `token ${forgejoToken}` : undefined),
      fetchImpl: apiFetch,
    }),
    resolver,
    fetchSource: (url: string, allowedHosts: ReadonlySet<string>) => fetchSource(url, { allowedHosts, resolver, exchange }),
  };
  try {
    const markdown = await renderLinkedSources(
      {
        urls: input.urls ?? [],
        allowedHosts: parseAllowedHosts(input.allowed_source_hosts ?? ""),
        targetVersion: input.target_version ?? "",
        ghcrImages: input.ghcr_images ?? [],
        compareShas: input.compare_shas ?? null,
        currentRepo: input.github_repository ?? null,
        allowedRepos: parseAllowedRepos(input.tool_allowed_gh_api_repos),
      },
      deps,
    );
    return {
      ok: true,
      values: {
        markdown,
        requests: asciiJson([...log].sort(compareCodePoints)),
        budget_warnings: String(warnings.length),
      },
    };
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
}
