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
import { isRepoSegment, parseRepoRef, repoScopedUrl } from "./repo-ref.js";
import type { ReadResult } from "./types.js";
import { LINKED_SOURCE_GITHUB_BASE, parsePlatformBaseUrl } from "./urls.js";

const REF_TAIL = /^[A-Za-z0-9._~%+:@!$&'()*,;=/-]+$/;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$/;
const ENDPOINT_RE = /^repos\/([^/]+)\/([^/]+)\/(releases\/tags\/|compare\/|tags\?per_page=50$)(.*)$/;

/** gh_api_call's subprocess bound. */
const GH_ENRICH_TIMEOUT_MS = 30_000;
const DEFAULT_FORGEJO_TIMEOUT_MS = 25_000;

function hasDotOrEmptySegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/** The tail arrives percent-encoded (`quote(tag, safe='')`), so `%2F` hides a
 * separator from both this check and URL normalization; a server that decodes
 * it could still see `../`. Check the decoded form too. */
function safeRefTail(tail: string): boolean {
  if (!REF_TAIL.test(tail) || hasDotOrEmptySegment(tail)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(tail);
  } catch {
    return false;
  }
  return !hasDotOrEmptySegment(decoded);
}

/** The endpoint shapes linked sources build: `repos/o/r/releases/tags/T`,
 * `repos/o/r/compare/SPEC`, `repos/o/r/tags?per_page=50`. */
export function validEnrichEndpoint(endpoint: string): boolean {
  return parseEnrichEndpoint(endpoint) !== null;
}

interface EnrichEndpoint {
  repo: string;
  staticTail: string;
  dynamicTail: string;
}

function parseEnrichEndpoint(endpoint: string): EnrichEndpoint | null {
  const match = ENDPOINT_RE.exec(endpoint);
  if (!match) return null;
  const [, owner = "", name = "", kind = "", rest = ""] = match;
  if (!isRepoSegment(owner) || !isRepoSegment(name)) return null;
  if (kind.startsWith("tags")) return rest === "" ? { repo: `${owner}/${name}`, staticTail: "/tags?per_page=50", dynamicTail: "" } : null;
  return safeRefTail(rest) ? { repo: `${owner}/${name}`, staticTail: `/${kind}`, dynamicTail: rest } : null;
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
    const parsed = parseEnrichEndpoint(endpoint);
    const url = parsed === null ? null : repoScopedUrl(this.base, parsed.repo, parsed.staticTail, parsed.dynamicTail);
    if (url === null) return { ok: false, error: `Endpoint not allowed for enrichment: ${endpoint}` };
    try {
      const { status, text } = await requestText(url, {
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

/** Lower-cased `host[:port]` of a URL (default ports dropped), "" if unparseable. */
function hostOf(raw: string): string {
  try {
    return new URL(raw.trim()).host.toLowerCase();
  } catch {
    return "";
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
    // The configured instance's actual host[:port]. (v2 compared the whole
    // scheme-stripped FORGEJO_API_URL, so an instance served under a path
    // prefix never matched and its enrichment went unauthenticated.)
    this.configuredHost = hostOf(options.configuredApiUrl ?? "");
    this.configuredAuthorization = options.configuredAuthorization;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FORGEJO_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async get(host: string, ownerRepo: string, staticTail: string, dynamicTail: string): Promise<unknown> {
    if (!HOST_RE.test(host) || parseRepoRef(ownerRepo) === null) return null;
    if (dynamicTail === "." || dynamicTail === "..") return null;
    const url = repoScopedUrl(`https://${host}/api/v1`, ownerRepo, staticTail, dynamicTail);
    if (url === null) return null;
    const configured = this.configuredHost !== "" && hostOf(`https://${host}`) === this.configuredHost;
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
    return normalizeForgejoRelease(await this.get(host, ownerRepo, "/releases/tags/", pyQuote(tag)), tag);
  }

  /** `fetch_forge_compare`: the raw compare object, or null. */
  async compare(host: string, ownerRepo: string, spec: string): Promise<Record<string, unknown> | null> {
    const data = await this.get(host, ownerRepo, "/compare/", pyQuote(spec));
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  }
}
