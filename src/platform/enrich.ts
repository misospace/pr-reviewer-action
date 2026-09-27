/** Linked-source enrichment clients (#706 PR 1).
 *
 * Linked sources (release notes, tags, version compares) and image
 * provenance read THIRD-PARTY repositories, which are not the platform
 * under review:
 *
 * - `GitHubEnrichClient` is pinned to `LINKED_SOURCE_GITHUB_BASE`
 *   (api.github.com) regardless of the hosting platform — the port of
 *   `pr_reviewer.http_client.gh_api_call` (`gh api <endpoint>`, parsed JSON
 *   or null) for the three endpoint shapes linked_sources.py builds, plus
 *   the image-provenance compare (`scripts/image_digest_analysis.py`).
 * - `ForgejoEnrichClient` reads an arbitrary Forgejo/Gitea host — the port
 *   of `forgejo_backend.fetch_forge_release` / `fetch_forge_compare`
 *   (`enrich-release` / `enrich-compare`). A credential is attached ONLY
 *   when the host is the configured Forgejo instance
 *   (`_enrich_token_for_host`); every other host is read unauthenticated.
 *
 * Owner/repo allowlisting (#509) stays with the caller, as in v2. These
 * clients additionally refuse endpoint shapes outside what the callers
 * build, so a hostile tag or spec cannot smuggle a query or dot-segment. */

import { requestText, type FetchLike } from "./http.js";
import { normalizeForgejoRelease, pyJsonDecode } from "./normalize.js";
import { pyQuote } from "./py.js";
import type { ReadResult } from "./types.js";
import { LINKED_SOURCE_GITHUB_BASE, parsePlatformBaseUrl } from "./urls.js";

const NAME = "[A-Za-z0-9_.-]+";
const REF_TAIL = /^[A-Za-z0-9._~%+:@!$&'()*,;=/-]+$/;
const OWNER_REPO_RE = new RegExp(`^${NAME}/${NAME}$`);
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$/;
const ENDPOINT_RE = new RegExp(`^repos/(${NAME})/(${NAME})/(?:releases/tags/(.+)|compare/(.+)|tags\\?per_page=50)$`);

/** gh_api_call's subprocess bound. */
const GH_ENRICH_TIMEOUT_MS = 30_000;
const DEFAULT_FORGEJO_TIMEOUT_MS = 25_000;

function safeRefTail(tail: string): boolean {
  return REF_TAIL.test(tail) && !tail.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/** The endpoint shapes linked sources build: `repos/o/r/releases/tags/T`,
 * `repos/o/r/compare/SPEC`, `repos/o/r/tags?per_page=50`. */
export function validEnrichEndpoint(endpoint: string): boolean {
  const match = ENDPOINT_RE.exec(endpoint);
  if (!match) return false;
  const tail = match[3] ?? match[4];
  return tail === undefined || safeRefTail(tail);
}

export interface GitHubEnrichClientOptions {
  /** Pre-formatted Authorization value (e.g. `Bearer ...`); omit to read
   * unauthenticated (image provenance never sends one). */
  token?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: FetchLike | undefined;
}

export class GitHubEnrichClient {
  private readonly base: string;
  private readonly origin: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: GitHubEnrichClientOptions = {}) {
    const parsed = parsePlatformBaseUrl(LINKED_SOURCE_GITHUB_BASE, "linked-source GitHub base");
    this.base = parsed.base;
    this.origin = parsed.origin;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? GH_ENRICH_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** One read with the failure reason kept (image provenance renders it). */
  async request(endpoint: string, accept?: string): Promise<ReadResult<unknown>> {
    if (!validEnrichEndpoint(endpoint)) return { ok: false, error: `Endpoint not allowed for enrichment: ${endpoint}` };
    try {
      const { status, text } = await requestText(`${this.base}/${endpoint}`, {
        token: this.token,
        accept,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        allowedOrigin: this.origin,
      });
      if (status < 200 || status >= 300) return { ok: false, error: `GitHub API error: ${status}` };
      return { ok: true, data: JSON.parse(text) as unknown };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** `gh_api_call(endpoint, token)`: parsed JSON, or null on any failure. */
  async get(endpoint: string): Promise<unknown> {
    const result = await this.request(endpoint);
    return result.ok ? result.data : null;
  }

  release(ownerRepo: string, tag: string): Promise<unknown> {
    return this.get(`repos/${ownerRepo}/releases/tags/${tag}`);
  }

  tags(ownerRepo: string): Promise<unknown> {
    return this.get(`repos/${ownerRepo}/tags?per_page=50`);
  }

  compare(ownerRepo: string, spec: string): Promise<unknown> {
    return this.get(`repos/${ownerRepo}/compare/${spec}`);
  }

  /** The image-provenance compare (`Accept: application/vnd.github+json`). */
  imageCompare(ownerRepo: string, oldRevision: string, newRevision: string): Promise<ReadResult<unknown>> {
    return this.request(`repos/${ownerRepo}/compare/${oldRevision}...${newRevision}`, "application/vnd.github+json");
  }
}

export interface ForgejoEnrichClientOptions {
  /** FORGEJO_API_URL of the configured instance, if any. */
  configuredApiUrl?: string | undefined;
  /** Authorization for the configured host only (token or JWT). */
  configuredAuthorization?: (() => Promise<string | undefined>) | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: FetchLike | undefined;
}

export class ForgejoEnrichClient {
  private readonly configuredHost: string;
  private readonly configuredAuthorization: (() => Promise<string | undefined>) | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: ForgejoEnrichClientOptions = {}) {
    // `re.sub(r"^https?://", "", FORGEJO_API_URL).strip("/").lower()`
    this.configuredHost = (options.configuredApiUrl ?? "").replace(/^https?:\/\//, "").replace(/^\/+|\/+$/g, "").toLowerCase();
    this.configuredAuthorization = options.configuredAuthorization;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FORGEJO_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async get(host: string, ownerRepo: string, tail: string): Promise<unknown> {
    if (!HOST_RE.test(host) || !OWNER_REPO_RE.test(ownerRepo)) return null;
    const url = `https://${host}/api/v1/repos/${ownerRepo}/${tail}`;
    const configured = this.configuredHost !== "" && host.toLowerCase() === this.configuredHost;
    try {
      const token = configured && this.configuredAuthorization ? await this.configuredAuthorization() : undefined;
      const { status, text } = await requestText(url, {
        token,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        allowedOrigin: new URL(url).origin,
      });
      return status === 200 ? pyJsonDecode(text) : null;
    } catch {
      return null;
    }
  }

  /** `fetch_forge_release`: the normalized release, or null. */
  async release(host: string, ownerRepo: string, tag: string): Promise<Record<string, unknown> | null> {
    return normalizeForgejoRelease(await this.get(host, ownerRepo, `releases/tags/${pyQuote(tag)}`), tag);
  }

  /** `fetch_forge_compare`: the raw compare object, or null. */
  async compare(host: string, ownerRepo: string, spec: string): Promise<Record<string, unknown> | null> {
    const data = await this.get(host, ownerRepo, `compare/${pyQuote(spec)}`);
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  }
}
