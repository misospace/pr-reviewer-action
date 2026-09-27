/** Linked-source enrichment (#706 PR 5b): byte-exact port of
 * `pr_reviewer/linked_sources.py` (`render_linked_sources`).
 *
 * Renders `linked-sources.md` from the extracted PR URLs: allowlisted
 * non-GitHub sources are fetched (SSRF-safe, `platform/safe-fetch.ts`) and
 * reduced to text; GitHub release/compare URLs, github.com repos, and ghcr.io
 * image paths are enriched through the api.github.com-pinned client; Forgejo
 * release/compare URLs through the Forgejo enrich client. Every owner/repo
 * query goes through the single #509 `repoAllowed` gate.
 *
 * Parity notes:
 * - The wall-clock `BudgetTracker` is consulted at exactly the points v2
 *   consults it, in the same order (the parity harness drives it with a fake
 *   clock), and network work runs concurrently (8 at a time) without
 *   changing the source-ordered output.
 * - Payload shaping reproduces Python semantics on hostile JSON: `.get` on a
 *   non-dict, `in` on a non-container, slicing a dict/None, or `.lower()` on
 *   a non-string raise, which aborts the whole render as in v2.
 * - `json.dumps(..., indent=2)` output (ASCII-escaped) and the per-section
 *   character caps match v2 exactly. JSON is parsed with `JSON.parse`, so
 *   integer-valued floats (`1.0`), integers beyond 2^53 and integer-like
 *   object keys (reordered first by JS) are not reproduced — the same
 *   limitation as the #803 enrich clients. */

import { ForgejoEnrichClient, GitHubEnrichClient } from "../platform/enrich.js";
import { compareCodePoints } from "../platform/jq.js";
import { pyFloatRepr, pyTruthy } from "../platform/py.js";
import { pyUrlHost } from "../platform/py-url.js";
import {
  DEFAULT_FETCH_HOSTS,
  fetchSource,
  hostAllowed,
  safeFetchLike,
  systemResolver,
  type Resolver,
} from "../platform/safe-fetch.js";
import type { BudgetTracker } from "./budget.js";
import { classifyUrl, normalizeUrl, type UrlClassification } from "./enrichment.js";
import { pyStrip, stripSourceToText } from "./strip-source-text.js";

export const SKIP_FETCH_HOSTS: ReadonlySet<string> = new Set(["gitlab.com", "bitbucket.org"]);
const MAX_URLS = 25;
const CONCURRENCY = 8;

/** A Python exception the ported shaping raises where v2 would. */
export class PyShapeError extends Error {
  constructor(kind: "AttributeError" | "TypeError", message: string) {
    super(`${kind}: ${message}`);
    this.name = "PyShapeError";
  }
}

// --- Python value semantics ------------------------------------------------------

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (Array.isArray(value)) return "list";
  return "dict";
}

/** `d.get(key, default)`. */
function pyGet(d: unknown, key: string, fallback: unknown = null): unknown {
  if (!isDict(d)) throw new PyShapeError("AttributeError", `'${pyTypeName(d)}' object has no attribute 'get'`);
  return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : fallback;
}

/** `key in container`. */
function pyContains(container: unknown, key: string): boolean {
  if (isDict(container)) return Object.prototype.hasOwnProperty.call(container, key);
  if (Array.isArray(container)) return container.some((item) => item === key);
  if (typeof container === "string") return container.includes(key);
  throw new PyShapeError("TypeError", `argument of type '${pyTypeName(container)}' is not iterable`);
}

/** `value[:n]`, as an iterable list (a str slices into its characters). */
function pySlice(value: unknown, n: number): unknown[] {
  if (Array.isArray(value)) return value.slice(0, n);
  if (typeof value === "string") return [...value].slice(0, n);
  if (isDict(value)) throw new PyShapeError("TypeError", "unhashable type: 'slice'");
  throw new PyShapeError("TypeError", `'${pyTypeName(value)}' object is not subscriptable`);
}

/** `(value or "").lower()`. */
function pyLowerOr(value: unknown): string {
  const text = pyTruthy(value) ? value : "";
  if (typeof text !== "string") throw new PyShapeError("AttributeError", `'${pyTypeName(text)}' object has no attribute 'lower'`);
  return text.toLowerCase();
}

/** `_pick(d, keys)`: `{k: d.get(k) for k in keys if k in d}`. */
function pick(d: unknown, keys: readonly string[]): Dict {
  const out: Dict = {};
  for (const key of keys) if (pyContains(d, key)) out[key] = pyGet(d, key);
  return out;
}

function escapeAscii(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const code = text.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (code >= 0x20 && code <= 0x7e) out += ch;
    else out += `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return `${out}"`;
}

function dumpNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  if (Number.isInteger(value)) return Number.isSafeInteger(value) ? String(value) : BigInt(value).toString();
  return pyFloatRepr(value);
}

function dump(value: unknown, level: number): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return dumpNumber(value);
  if (typeof value === "string") return escapeAscii(value);
  const pad = "  ".repeat(level + 1);
  const close = "  ".repeat(level);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((item) => `${pad}${dump(item, level + 1)}`).join(",\n")}\n${close}]`;
  }
  const entries = Object.entries(value as Dict);
  if (entries.length === 0) return "{}";
  return `{\n${entries.map(([key, item]) => `${pad}${escapeAscii(key)}: ${dump(item, level + 1)}`).join(",\n")}\n${close}}`;
}

/** `json.dumps(value, indent=2)` (ensure_ascii=True, insertion order). */
export function pyJsonDumpsIndent2(value: unknown): string {
  return dump(value, 0);
}

/** `json.dumps(value, indent=2)[:cap]` — the output is ASCII, so code units
 * are code points. */
function dumpCapped(value: unknown, cap: number): string {
  return pyJsonDumpsIndent2(value).slice(0, cap);
}

function jsonBlock(lines: string[], value: unknown, cap: number): void {
  lines.push("```json", dumpCapped(value, cap), "", "```");
}

// --- Authorization gate (#509) -------------------------------------------------

/** `_repo_allowed`: only the repo under review or an operator-allowlisted
 * repo may be queried with the operator token. */
export function repoAllowed(owner: string, repo: string, currentRepo: string | null | undefined, allowedRepos: ReadonlySet<string> | null | undefined): boolean {
  const key = `${owner}/${repo}`.toLowerCase();
  if (currentRepo && key === currentRepo.toLowerCase()) return true;
  if (allowedRepos && allowedRepos.size > 0) {
    for (const entry of allowedRepos) {
      if (!entry) continue;
      const lower = entry.toLowerCase();
      if (key === lower) return true;
      if (lower.endsWith("/*") && key === lower.slice(0, -2)) return true;
      if (lower === "*") return true;
    }
  }
  return false;
}

/** `run_enrichment._parse_allowed_repos` (TOOL_ALLOWED_GH_API_REPOS). */
export function parseAllowedRepos(raw: string | null | undefined): Set<string> | null {
  if (!raw) return null;
  const items = new Set(raw.replaceAll("\n", ",").split(",").map((part) => pyStrip(part)).filter((part) => part !== ""));
  return items.size > 0 ? items : null;
}

const GITHUB_REPO_KEY_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)/;
const ENDPOINT_REPO_RE = /^repos\/([^/]+)\/([^/]+)\//;

/** `_github_repo_key(url)`. */
export function githubRepoKey(url: string): string | null {
  const match = GITHUB_REPO_KEY_RE.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

// --- Dependencies ----------------------------------------------------------------

export interface GitHubEnrichApi {
  /** `gh_api_call(endpoint)`: parsed JSON, or null on any failure. */
  get(endpoint: string): Promise<unknown>;
}

export interface ForgejoEnrichApi {
  release(host: string, ownerRepo: string, tag: string): Promise<Record<string, unknown> | null>;
  compare(host: string, ownerRepo: string, spec: string): Promise<Record<string, unknown> | null>;
}

export interface LinkedSourcesDeps {
  budget: BudgetTracker;
  github: GitHubEnrichApi;
  forgejo: ForgejoEnrichApi;
  /** DNS for the `host_allowed` gate. */
  resolver: Resolver;
  /** `fetch_url(url, timeout=25)` restricted to `allowedHosts` (initial URL
   * and every redirect hop). */
  fetchSource: (url: string, allowedHosts: ReadonlySet<string>) => Promise<Uint8Array | null>;
}

export interface LinkedSourcesInput {
  urls: readonly string[];
  allowedHosts: ReadonlySet<string>;
  targetVersion: string;
  ghcrImages: readonly string[];
  compareShas: readonly [string, string] | null;
  currentRepo?: string | null | undefined;
  allowedRepos?: ReadonlySet<string> | null | undefined;
}

export interface DefaultDepsOptions {
  budget: BudgetTracker;
  /** Pre-formatted Authorization for api.github.com (e.g. `token ...`). */
  githubAuthorization?: string | undefined;
  forgejoApiUrl?: string | undefined;
  forgejoAuthorization?: (() => Promise<string | undefined>) | undefined;
  resolver?: Resolver | undefined;
}

/** Production transports: the pinned GitHub client, the Forgejo client over
 * the SSRF-safe transport, system DNS, and `fetchSource` bounded by the
 * enrichment budget's deadline. */
export function defaultLinkedSourcesDeps(options: DefaultDepsOptions): LinkedSourcesDeps {
  const resolver = options.resolver ?? systemResolver;
  return {
    budget: options.budget,
    github: new GitHubEnrichClient({ token: options.githubAuthorization }),
    forgejo: new ForgejoEnrichClient({
      configuredApiUrl: options.forgejoApiUrl,
      configuredAuthorization: options.forgejoAuthorization,
      fetchImpl: safeFetchLike({ resolver }),
    }),
    resolver,
    fetchSource: (url, allowedHosts) => {
      const remainingMs = Math.max(0, (options.budget.deadline() - Date.now() / 1000) * 1000);
      return fetchSource(url, { allowedHosts, resolver, signal: AbortSignal.timeout(Math.ceil(remainingMs)) });
    },
  };
}

// --- Rendering ---------------------------------------------------------------------

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** `_GhApiCache`: memoized `gh api` reads behind the #509 gate. */
class GhApiCache {
  private readonly cache = new Map<string, Promise<unknown>>();
  readonly authorizedRepos = new Set<string>();

  constructor(
    private readonly github: GitHubEnrichApi,
    private readonly currentRepo: string | null | undefined,
    private readonly allowedRepos: ReadonlySet<string> | null | undefined,
    readonly blockedRepos: Map<string, string[]>,
  ) {}

  private block(key: string, what: string): void {
    const list = this.blockedRepos.get(key) ?? [];
    list.push(what);
    this.blockedRepos.set(key, list);
  }

  async get(endpoint: string): Promise<unknown> {
    const match = ENDPOINT_REPO_RE.exec(endpoint);
    if (match) {
      const key = `${match[1]}/${match[2]}`.toLowerCase();
      if (!repoAllowed(match[1]!, match[2]!, this.currentRepo, this.allowedRepos)) {
        this.block(key, endpoint);
        return null;
      }
      this.authorizedRepos.add(key);
    }
    let pending = this.cache.get(endpoint);
    if (pending === undefined) {
      pending = this.github.get(endpoint).catch(() => null);
      this.cache.set(endpoint, pending);
    }
    return pending;
  }

  async releases(owner: string, repo: string): Promise<unknown[] | null> {
    const key = `${owner}/${repo}`.toLowerCase();
    if (!repoAllowed(owner, repo, this.currentRepo, this.allowedRepos)) {
      this.block(key, "releases");
      return null;
    }
    this.authorizedRepos.add(key);
    const data = await this.get(`repos/${owner}/${repo}/releases?per_page=30`);
    return Array.isArray(data) ? data : null;
  }
}

interface Ctx {
  input: LinkedSourcesInput;
  deps: LinkedSourcesDeps;
  api: GhApiCache;
  budget: BudgetTracker;
}

function classify(url: string): UrlClassification | null {
  return classifyUrl(url, pyUrlHost);
}

async function fetchSections(ctx: Ctx): Promise<Map<number, Uint8Array | null>> {
  const { input, deps, budget } = ctx;
  const fetchUrls: Array<[number, string]> = [];
  for (const [index, url] of input.urls.slice(0, MAX_URLS).entries()) {
    const normalized = normalizeUrl(url);
    const host = pyUrlHost(normalized);
    if (SKIP_FETCH_HOSTS.has(host) || host === "github.com") continue;
    if (await hostAllowed(normalized, input.allowedHosts, deps.resolver)) fetchUrls.push([index + 1, normalized]);
  }
  const fetched = new Map<number, Uint8Array | null>();
  if (fetchUrls.length > 0 && budget.ok()) {
    // v2 re-checks the host inside fetch_url against its default allowlist;
    // redirect hops must also stay inside ALLOWED_SOURCE_HOSTS.
    const fetchAllowlist = new Set([...DEFAULT_FETCH_HOSTS].filter((host) => input.allowedHosts.has(host)));
    const submitted: Array<[number, string]> = [];
    for (const entry of fetchUrls) {
      if (!budget.ok()) break;
      submitted.push(entry);
    }
    const bodies = await mapLimit(submitted, CONCURRENCY, async ([, url]) => {
      try {
        return await deps.fetchSource(url, fetchAllowlist);
      } catch {
        return null;
      }
    });
    submitted.forEach(([index], position) => fetched.set(index, bodies[position] ?? null));
  }
  return fetched;
}

function collectPrewarmEndpoints(ctx: Ctx): string[] {
  const { input, api } = ctx;
  const endpoints: string[] = [];
  const seen = new Set<string>();
  const ghRepoKeys = new Set<string>();
  const queue = (endpoint: string): void => {
    const match = ENDPOINT_REPO_RE.exec(endpoint);
    if (match && !repoAllowed(match[1]!, match[2]!, input.currentRepo, input.allowedRepos)) {
      const key = `${match[1]}/${match[2]}`.toLowerCase();
      const list = api.blockedRepos.get(key) ?? [];
      list.push(endpoint);
      api.blockedRepos.set(key, list);
      return;
    }
    if (!seen.has(endpoint)) {
      seen.add(endpoint);
      endpoints.push(endpoint);
    }
  };
  for (const url of input.urls.slice(0, MAX_URLS)) {
    const normalized = normalizeUrl(url);
    const cls = classify(normalized);
    if (cls?.type === "github_release") {
      queue(`repos/${cls.owner}/${cls.repo}/releases/tags/${cls.tag}`);
      queue(`repos/${cls.owner}/${cls.repo}/releases?per_page=30`);
    } else if (cls?.type === "github_compare") {
      queue(`repos/${cls.owner}/${cls.repo}/compare/${cls.compareSpec}`);
    }
    const repoKey = githubRepoKey(normalized);
    if (repoKey) {
      ghRepoKeys.add(repoKey);
      queue(`repos/${repoKey}/releases?per_page=30`);
    }
  }
  if (input.targetVersion) {
    for (const imgRepo of input.ghcrImages) {
      if (ghRepoKeys.has(imgRepo)) continue;
      const owner = imgRepo.split("/")[0]!;
      const repo = imgRepo.slice(imgRepo.lastIndexOf("/") + 1);
      if (!owner || !repo || owner === imgRepo) continue;
      for (const tag of [`v${input.targetVersion}`, input.targetVersion]) queue(`repos/${owner}/${repo}/releases/tags/${tag}`);
    }
  }
  return endpoints;
}

async function prewarm(ctx: Ctx, endpoints: string[]): Promise<void> {
  if (endpoints.length === 0 || !ctx.budget.ok()) return;
  await mapLimit(endpoints, CONCURRENCY, (endpoint) => ctx.api.get(endpoint));
}

/** `_commit_summaries(commits, with_author)`. */
function commitSummaries(commits: unknown[], withAuthor = false): Dict[] {
  return commits.map((c) => {
    const commit = pyTruthy(pyGet(c, "commit")) ? pyGet(c, "commit") : {};
    const inner: Dict = { message: pyGet(commit, "message") };
    const entry: Dict = { sha: pyGet(c, "sha"), commit: inner };
    if (withAuthor) {
      inner.author = pyGet(commit, "author");
      const author = pyGet(commit, "author");
      inner.date = pyGet(pyTruthy(author) ? author : {}, "date");
    }
    return entry;
  });
}

async function renderFetchedContent(ctx: Ctx, lines: string[], normalized: string, host: string, i: number, fetched: Map<number, Uint8Array | null>): Promise<boolean> {
  if (await hostAllowed(normalized, ctx.input.allowedHosts, ctx.deps.resolver)) {
    const body = fetched.get(i);
    if (host === "github.com") {
      lines.push("(Raw HTML fetch skipped for github.com — structured release/compare metadata is captured below when available)");
    } else if (SKIP_FETCH_HOSTS.has(host)) {
      lines.push(`(Raw HTML fetch skipped for known non-Forgejo host: ${host})`);
      return true;
    } else if (body && body.length > 0) {
      const text = stripSourceToText(body);
      if (text) lines.push("```text", text, "", "```");
      else lines.push("(No content captured from URL)");
    } else {
      lines.push(`(Failed to fetch allowlisted URL content from ${host})`);
    }
    return false;
  }
  lines.push(`(Skipped non-allowlisted URL: ${host})`);
  return true;
}

async function renderGithubReleaseMetadata(ctx: Ctx, cls: UrlClassification | null, lines: string[]): Promise<void> {
  if (cls?.type !== "github_release") return;
  const { api, budget } = ctx;
  lines.push("", `### GitHub Release Metadata: ${cls.owner}/${cls.repo}@${cls.tag}`);
  if (budget.ok()) {
    const data = await api.get(`repos/${cls.owner}/${cls.repo}/releases/tags/${cls.tag}`);
    if (isDict(data)) jsonBlock(lines, pick(data, ["tag_name", "name", "published_at", "html_url", "body"]), 5000);
    else lines.push(`(Could not fetch release metadata for tag ${cls.tag})`);
  }
  if (budget.ok()) {
    const data = await api.releases(cls.owner, cls.repo);
    if (Array.isArray(data)) {
      const filtered = data.slice(0, 8).map((r) => pick(r, ["tag_name", "name", "published_at", "html_url"]));
      lines.push("### Recent Releases");
      jsonBlock(lines, filtered, 3000);
    }
  }
}

async function renderGithubCompareMetadata(ctx: Ctx, cls: UrlClassification | null, lines: string[]): Promise<void> {
  if (cls?.type !== "github_compare") return;
  const { api, budget } = ctx;
  lines.push("", `### GitHub Compare Metadata: ${cls.owner}/${cls.repo}@${cls.compareSpec}`);
  if (!budget.ok()) return;
  const data = await api.get(`repos/${cls.owner}/${cls.repo}/compare/${cls.compareSpec}`);
  if (!isDict(data)) {
    lines.push(`(Could not fetch compare metadata for ${cls.owner}/${cls.repo}@${cls.compareSpec})`);
    return;
  }
  const filtered: Dict = {
    html_url: pyGet(data, "html_url"),
    status: pyGet(data, "status"),
    ahead_by: pyGet(data, "ahead_by"),
    behind_by: pyGet(data, "behind_by"),
    total_commits: pyGet(data, "total_commits"),
    commits: commitSummaries(pySlice(pyGet(data, "commits", []), 20), true),
  };
  jsonBlock(lines, filtered, 7000);
  const files = pySlice(pyGet(data, "files", []), 30);
  const fileList = files.map((f) => pick(f, ["filename", "status", "additions", "deletions", "changes", "patch"]));
  lines.push("### GitHub Compare Files");
  jsonBlock(lines, fileList, 7000);
}

async function renderForgejoMetadata(ctx: Ctx, cls: UrlClassification, lines: string[]): Promise<void> {
  const { deps, budget } = ctx;
  if (cls.type === "forgejo_release") {
    lines.push("", `### Forge Release Metadata: ${cls.host} ${cls.owner}/${cls.repo}@${cls.tag}`);
    if (budget.ok()) {
      const data = await deps.forgejo.release(cls.host, `${cls.owner}/${cls.repo}`, cls.tag).catch(() => null);
      if (isDict(data)) jsonBlock(lines, data, 6000);
      else lines.push(`(Could not fetch release metadata from ${cls.host} for tag ${cls.tag})`);
    }
  }
  if (cls.type === "forgejo_compare") {
    lines.push("", `### Forge Compare Metadata: ${cls.host} ${cls.owner}/${cls.repo}@${cls.compareSpec}`);
    if (budget.ok()) {
      const data = await deps.forgejo.compare(cls.host, `${cls.owner}/${cls.repo}`, cls.compareSpec).catch(() => null);
      if (isDict(data)) {
        const commits = pyGet(data, "commits");
        const files = pyGet(data, "files");
        const filtered: Dict = {
          total_commits: pyGet(data, "total_commits"),
          commits: commitSummaries(pySlice(pyTruthy(commits) ? commits : [], 20)),
          files: pySlice(pyTruthy(files) ? files : [], 30).map((f) => {
            const row: Dict = {};
            for (const key of ["filename", "status", "additions", "deletions"]) row[key] = pyGet(f, key);
            return row;
          }),
        };
        jsonBlock(lines, filtered, 7000);
      } else {
        lines.push(`(Could not fetch compare metadata from ${cls.host} for ${cls.compareSpec})`);
      }
    }
  }
}

interface Section {
  lines: string[];
  host: string;
  isSkip: boolean;
  enrichStart: number;
  repoKey: string | null;
}

async function renderSourceSection(ctx: Ctx, i: number, url: string, fetched: Map<number, Uint8Array | null>): Promise<Section> {
  const normalized = normalizeUrl(url);
  const host = pyUrlHost(normalized);
  const lines = [`## Source ${i}`, `URL: ${url}`];
  if (normalized !== url) lines.push(`Normalized URL: ${normalized}`);
  lines.push("", "### Fetched Content (truncated)");
  const isSkip = await renderFetchedContent(ctx, lines, normalized, host, i, fetched);
  const enrichStart = lines.length;
  const cls = classify(normalized);
  await renderGithubReleaseMetadata(ctx, cls, lines);
  await renderGithubCompareMetadata(ctx, cls, lines);
  if (cls && host !== "github.com" && (await hostAllowed(normalized, ctx.input.allowedHosts, ctx.deps.resolver))) {
    await renderForgejoMetadata(ctx, cls, lines);
  }
  return { lines, host, isSkip, enrichStart, repoKey: githubRepoKey(normalized) };
}

async function renderReleasesEnrichment(ctx: Ctx, repoCandidates: string[], lines: string[]): Promise<void> {
  const { api, budget, input } = ctx;
  const target = input.targetVersion;
  for (const repoKey of repoCandidates) {
    if (!budget.ok()) break;
    const slash = repoKey.indexOf("/");
    const owner = repoKey.slice(0, slash);
    const repo = repoKey.slice(slash + 1);
    lines.push("", `### GitHub Releases Enrichment: ${repoKey}`);
    if (!budget.ok()) continue;
    const data = await api.releases(owner, repo);
    if (!Array.isArray(data)) {
      lines.push(`(Could not fetch releases list for ${repoKey})`);
      continue;
    }
    lines.push("#### Recent Releases (tags)");
    jsonBlock(lines, data.map((r) => pick(r, ["tag_name", "name", "published_at", "html_url"])), 5000);
    if (!target) continue;
    const v = target.toLowerCase();
    const matched = data.filter((r) => {
      if (pyLowerOr(pyGet(r, "tag_name")) === v) return true;
      if (pyLowerOr(pyGet(r, "tag_name")) === `v${v}`) return true;
      if (pyLowerOr(pyGet(r, "tag_name")).includes(v)) return true;
      return pyLowerOr(pyGet(r, "name")).includes(v);
    }).slice(0, 5);
    if (matched.length > 0) {
      lines.push(`#### Releases matching target version ${target}`);
      jsonBlock(lines, matched.map((r) => pick(r, ["tag_name", "name", "published_at", "html_url", "body"])), 8000);
      continue;
    }
    lines.push(`(No release tags matched target version ${target} in ${repoKey})`);
    if (!budget.ok()) continue;
    const tags = await api.get(`repos/${owner}/${repo}/tags?per_page=50`);
    if (Array.isArray(tags)) {
      lines.push("#### Recent Tags");
      jsonBlock(lines, tags.map((t) => pick(t, ["name", "commit"])), 4000);
    } else {
      lines.push(`(Could not fetch tags list for ${repoKey})`);
    }
  }
}

async function renderGhcrLookup(ctx: Ctx, seenRepos: Set<string>, lines: string[]): Promise<void> {
  const { api, budget, input } = ctx;
  if (!(input.ghcrImages.length > 0 && budget.ok())) return;
  const target = input.targetVersion;
  for (const imgRepo of input.ghcrImages) {
    if (!budget.ok()) break;
    if (seenRepos.has(imgRepo)) continue;
    const owner = imgRepo.split("/")[0]!;
    const repo = imgRepo.slice(imgRepo.lastIndexOf("/") + 1);
    if (!owner || !repo || owner === imgRepo) continue;
    lines.push("", `### GitHub Release Lookup via ghcr.io Path: ${owner}/${repo}`);
    let found = false;
    if (target) {
      for (const tag of [`v${target}`, target]) {
        if (!budget.ok()) break;
        const data = await api.get(`repos/${owner}/${repo}/releases/tags/${tag}`);
        if (isDict(data)) {
          lines.push(`#### Matched via ghcr.io path: ${owner}/${repo}@${tag}`);
          jsonBlock(lines, pick(data, ["tag_name", "name", "published_at", "html_url", "body"]), 8000);
          found = true;
          break;
        }
      }
    }
    if (!found) {
      lines.push(target
        ? `(No release found for ${owner}/${repo} at version ${target} via ghcr.io path inference)`
        : `(TARGET_VERSION not set; skipping release lookup for ${owner}/${repo})`);
    }
    if (!found && input.compareShas && budget.ok()) {
      const [oldSha, newSha] = input.compareShas;
      const data = await api.get(`repos/${owner}/${repo}/compare/${oldSha}...${newSha}`);
      if (isDict(data) && pyTruthy(pyGet(data, "status"))) {
        lines.push(`#### Commit compare ${oldSha}...${newSha} (no release published for this version)`);
        const filtered: Dict = {
          html_url: pyGet(data, "html_url"),
          status: pyGet(data, "status"),
          ahead_by: pyGet(data, "ahead_by"),
          total_commits: pyGet(data, "total_commits"),
          commits: commitSummaries(pySlice(pyGet(data, "commits", []), 20)),
        };
        jsonBlock(lines, filtered, 6000);
        const files = pySlice(pyGet(data, "files", []), 30).map((f) => {
          const row: Dict = {};
          for (const key of ["filename", "status", "additions", "deletions", "changes"]) row[key] = pyGet(f, key);
          return row;
        });
        lines.push("#### Changed Files");
        jsonBlock(lines, files, 5000);
      }
    }
  }
}

function renderBlockedRepos(blocked: Map<string, string[]>, lines: string[]): void {
  if (blocked.size === 0) return;
  lines.push(
    "### Not Authorized for Enrichment",
    "",
    "These repos were linked from the PR body but are not the repo under review (and were not listed in `TOOL_ALLOWED_GH_API_REPOS`), so the action did not query them with the operator token:",
    "",
  );
  const keys = [...blocked.keys()].sort(compareCodePoints);
  for (const key of keys) lines.push(`- \`${key}\``);
  lines.push("");
}

/** `render_linked_sources(...)`: the `linked-sources.md` content. */
export async function renderLinkedSources(input: LinkedSourcesInput, deps: LinkedSourcesDeps): Promise<string> {
  if (input.urls.length === 0) return "";
  const blocked = new Map<string, string[]>();
  const api = new GhApiCache(deps.github, input.currentRepo, input.allowedRepos, blocked);
  const ctx: Ctx = { input, deps, api, budget: deps.budget };

  const fetched = await fetchSections(ctx);
  await prewarm(ctx, collectPrewarmEndpoints(ctx));

  const lines: string[] = [];
  const repoCandidates: string[] = [];
  const seenRepos = new Set<string>();
  const skippedHosts: string[] = [];
  for (const [index, url] of input.urls.slice(0, MAX_URLS).entries()) {
    if (!ctx.budget.ok()) break;
    const section = await renderSourceSection(ctx, index + 1, url, fetched);
    if (section.repoKey && !seenRepos.has(section.repoKey)) {
      seenRepos.add(section.repoKey);
      repoCandidates.push(section.repoKey);
    }
    if (section.isSkip && !section.lines.slice(section.enrichStart).some((line) => pyStrip(line) !== "")) {
      skippedHosts.push(section.host);
    } else {
      lines.push(...section.lines, "");
    }
  }
  if (skippedHosts.length > 0) {
    const n = skippedHosts.length;
    const unique = [...new Set(skippedHosts)].sort(compareCodePoints).join(", ");
    lines.push(`(${n} source${n !== 1 ? "s" : ""} skipped — non-allowlisted or non-fetchable hosts: ${unique})`, "");
  }

  await renderReleasesEnrichment(ctx, repoCandidates, lines);
  await renderGhcrLookup(ctx, seenRepos, lines);
  renderBlockedRepos(blocked, lines);
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}
