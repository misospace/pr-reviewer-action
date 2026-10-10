import {
  PlatformRequestError,
  requestJson,
  type FetchLike,
  type RequestOptions,
} from "../platform/http.js";
import { resolveForgejoEndpoints, type ForgejoEndpoints } from "./endpoints.js";
import { repoScopedUrl } from "../platform/repo-ref.js";

/** The one result shape for every read. `ok` discriminates success from the
 * fixed, credential-free error text — a `ReadResult` never carries a raw token
 * or a raw response body in its error string. */
export type ReadResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string };

export interface ForgejoIngressClientOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly timeoutMs?: number | undefined;
  readonly fetchImpl?: FetchLike | undefined;
}

/**
 * A read-only, authenticated client for a self-hosted Forgejo REST API.
 *
 * Security invariants (mirroring the #674/#670/#682 SSRF boundary):
 * - the endpoint is validated and origin-bound BEFORE any credential is
 *   attached, so a token can only ever be bound to the one validated origin;
 * - the token travels ONLY as the `Authorization: token <value>` header — it is
 *   never embedded in URLs, never interpolated into any returned/logged string,
 *   and is rejected up front if empty or carrying CR/LF (header injection);
 * - every read is a GET by construction — there is no write path in this seam;
 * - non-2xx statuses and transport failures surface as a fixed error string,
 *   never the response body (a hostile server could otherwise reflect the
 *   credential back into a value that reaches callers or logs).
 */
export class ForgejoIngressClient {
  readonly endpoints: ForgejoEndpoints;

  #token: string;
  #timeoutMs: number | undefined;
  #fetchImpl: FetchLike | undefined;

  constructor(opts: ForgejoIngressClientOptions) {
    // Resolve and validate the endpoint FIRST: a malformed endpoint (embedded
    // credentials, non-http(s), empty) is refused before any credential is
    // even considered, so a token can never bind to an unvalidated origin.
    this.endpoints = resolveForgejoEndpoints(opts.endpoint);
    if (opts.token === "" || opts.token.includes("\r") || opts.token.includes("\n")) {
      throw new Error("invalid Forgejo ingress token");
    }
    this.#token = opts.token;
    this.#timeoutMs = opts.timeoutMs;
    this.#fetchImpl = opts.fetchImpl;
  }

  /**
   * The single place where the auth header, origin binding, and error mapping
   * live, so all three reads share identical security behavior.
   *
   * `label` is a path-only string used purely for the diagnostic message; the
   * token is never interpolated into it.
   */
  async #get(url: string, label: string): Promise<ReadResult<unknown>> {
    // `exactOptionalPropertyTypes` is on: only set the optional fields when they
    // are defined, rather than emitting `undefined` values into the options.
    const options: RequestOptions = {
      token: `token ${this.#token}`,
      allowedOrigin: this.endpoints.origin,
    };
    if (this.#timeoutMs !== undefined) options.timeoutMs = this.#timeoutMs;
    if (this.#fetchImpl !== undefined) options.fetchImpl = this.#fetchImpl;

    let result: { status: number; data: unknown };
    try {
      result = await requestJson(url, options);
    } catch (error) {
      // `requestJson` only ever throws PlatformRequestError (origin mismatch,
      // blocked redirect, transport failure, or invalid JSON). Either way the
      // caller gets only the fixed string: no response internals and no token
      // are echoed.
      if (error instanceof PlatformRequestError) {
        return { ok: false, error: "forgejo ingress request failed" };
      }
      return { ok: false, error: "forgejo ingress request failed" };
    }

    if (result.status < 200 || result.status >= 300) {
      return { ok: false, error: `GET ${label} returned ${result.status}` };
    }
    return { ok: true, data: result.data };
  }

  /**
   * GET an arbitrary API path. `path` must be a relative path beginning with
   * `"/"` and containing no whitespace or control characters, so a caller
   * cannot smuggle an absolute URL or header-injection bytes into the
   * transport. Invalid paths are refused before any network call.
   */
  async getJson(path: string): Promise<ReadResult<unknown>> {
    // Same-origin is enforced by requestJson's allowedOrigin, but the ingress refuses protocol-relative paths outright.
    if (!/^\/(?!\/)[^\s\u0000-\u001f]*$/.test(path)) {
      return { ok: false, error: "invalid path" };
    }
    return this.#get(`${this.endpoints.apiBase}${path}`, path);
  }

  /**
   * List the open pull requests for a repository, paging through the platform
   * list API. Returns the raw entries exactly as the platform sent them — no
   * normalization in this seam.
   */
  async listOpenPullRequests(repo: string): Promise<ReadResult<unknown[]>> {
    const combined: unknown[] = [];
    for (let page = 1; page <= MAX_RECONCILE_PAGES; page++) {
      const url = repoScopedUrl(
        this.endpoints.apiBase,
        repo,
        "/pulls",
        `?state=open&limit=${RECONCILE_PAGE_SIZE}&page=${page}`,
      );
      if (url === null) return { ok: false, error: "invalid repository" };
      const result = await this.#get(url, pathOf(url));
      if (result.ok === false) return result;
      if (!Array.isArray(result.data)) return { ok: false, error: "unexpected response" };
      combined.push(...(result.data as unknown[]));
      if (result.data.length < RECONCILE_PAGE_SIZE) return { ok: true, data: combined };
    }
    // Loud failure, never silent truncation: reconciliation must see every open
    // PR, so exhausting the page bound fails instead of returning a partial list.
    return { ok: false, error: "open pull request list exceeded reconciliation bound" };
  }

  /**
   * Fetch a single pull request by number. Returns the raw object as-is.
   */
  async getPullRequest(repo: string, prNumber: number): Promise<ReadResult<unknown>> {
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
      return { ok: false, error: "invalid PR number" };
    }
    const url = repoScopedUrl(this.endpoints.apiBase, repo, "/pulls", `/${prNumber}`);
    if (url === null) return { ok: false, error: "invalid repository" };
    return this.#get(url, pathOf(url));
  }
}

/** Pagination bounds for the open-PR reconciliation listing. */
const RECONCILE_PAGE_SIZE = 50;
const MAX_RECONCILE_PAGES = 20;

/** The path-only representation of a URL (pathname + query) for diagnostics.
 * Never throws: falls back to the raw string if it is not a valid URL. */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}
