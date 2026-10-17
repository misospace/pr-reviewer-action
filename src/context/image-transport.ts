/** Image-provenance HTTP transport (#706 PR 5a): the real registry/GitHub
 * fetch behind the `HttpJson` seam of `image-provenance.ts`, replacing v2's
 * `http_json` (`curl -fsSL --connect-timeout 20 --max-time 40 URL -H ...`
 * then `json.loads(body.decode("utf-8", errors="replace"))`).
 *
 * Kept from v2 (curl semantics):
 * - the caller's headers go out verbatim: the anonymous registry token as
 *   `Authorization: Bearer`, the four-type manifest `Accept` list, the
 *   GitHub compare `Accept: application/vnd.github+json` + User-Agent; no
 *   explicit Accept means curl's `*` + `/` + `*`;
 * - redirects are followed (`-L`, at most 50) — registry blob downloads
 *   redirect to CDNs and GitHub answers renamed repositories with 301 — and,
 *   like curl since 7.58, `Authorization` is dropped as soon as a redirect
 *   leaves the origin it was sent to;
 * - HTTP >= 400 is a failure (`-f`); the whole request, redirects included,
 *   is bounded by the 40 s `--max-time`;
 * - the body is decoded UTF-8-with-replacement (BOM kept) and parsed by the
 *   CPython-faithful decoder, so a JSON error reads exactly like v2's;
 * - failures carry v2's error text (`HTTP request failed: ...`). For a curl
 *   failure that is Python's `CalledProcessError` wording over the argv —
 *   with the Authorization value replaced by `[REDACTED]`, so a credential
 *   never lands in an error string. The renderer's 120-char `short()` cut
 *   falls inside the URL, so the rendered line is byte-identical to v2.
 *
 * SSRF fence on every hop (#806 review): each request, the first and every
 * redirect target, goes through #808's `safeFetchLike` — http(s) only, no
 * userinfo, public-only DNS/IP (`ip-policy.ts`), and the socket pinned to
 * the validated addresses so a second DNS answer is never used; a redirect
 * hop must additionally be https without userinfo. Registry/CDN redirects to
 * public hosts keep working. A refused hop fails the read before any
 * request to it is made. Responses are capped at `MAX_IMAGE_RESPONSE_BYTES`.
 * v2's curl followed redirects to any address (deliberate divergence, fixture
 * `transport-redirect-ssrf`).
 *
 * Tightened (fail closed, #670/#682 lineage): the first request must target
 * the pinned endpoints the renderer builds — `auth.docker.io/token`,
 * `registry-1.docker.io` / `ghcr.io` `/v2/<repo>/(manifests|blobs)/<digest>`
 * with an OCI-grammar digest, `ghcr.io/token`, and the GitHub compare
 * endpoint gated by #803's `validEnrichEndpoint` + `parseRepoRef`/`repoScopedUrl` on `LINKED_SOURCE_GITHUB_BASE`
 * — so a hostile config digest or OCI revision label cannot steer a
 * credentialed request; redirects must stay on https.
 *
 * Not reused: `GitHubEnrichClient.imageCompare` refuses every redirect, which
 * would turn v2's successful renamed-repository compare into a failure.
 *
 * `githubToken` is opt-in and off by default: v2 sends the compare
 * unauthenticated. When set, it is attached to the api.github.com request
 * only. */

import { PyJsonDecodeError, PyUncaughtError, pyIntFromText, pyJsonLoads, pyReprStr } from "../evidence/pyjson.js";
import { validEnrichEndpoint } from "../platform/enrich.js";
import { parseRepoRef, repoScopedUrl } from "../platform/repo-ref.js";
import type { FetchLike } from "../platform/http.js";
import { MAX_ENRICH_API_BYTES, SourceFetchError, safeFetchLike, type Exchange, type Resolver } from "../platform/safe-fetch.js";
import { LINKED_SOURCE_GITHUB_BASE } from "../platform/urls.js";
import { USER_AGENT } from "../platform/user-agent.js";
import { buildImageProvenanceContext, type HttpJson } from "./image-provenance.js";

export const CURL_CONNECT_TIMEOUT_SEC = 20;
export const CURL_MAX_TIME_SEC = 40;
/** curl's default `--max-redirs`. */
export const MAX_REDIRECTS = 50;
export const DEFAULT_IMAGE_DIGEST_BUDGET_SEC = 60;
/** Per-response cap (manifests, config blobs and compares are far smaller;
 * v2's curl read unbounded). */
export const MAX_IMAGE_RESPONSE_BYTES = MAX_ENRICH_API_BYTES;

const COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const DIGEST = "[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[a-zA-Z0-9=_-]+";
const REGISTRY_PATH = new RegExp(`^/v2/${COMPONENT}(?:/${COMPONENT})*/(?:manifests|blobs)/${DIGEST}$`);
const GITHUB_PREFIX = `${LINKED_SOURCE_GITHUB_BASE}/`;

/** Is *url* one of the endpoints the provenance renderer builds? */
export function imageTransportAllows(url: string): boolean {
  if (url.startsWith(GITHUB_PREFIX)) {
    // #803's shared validators: the enrich endpoint shape (decoded
    // dot-segment checks), the one repo-ref validator, and the normalized
    // repo-scoped URL, which must equal the URL we were asked to fetch.
    const endpoint = url.slice(GITHUB_PREFIX.length);
    const match = /^repos\/([^/]+\/[^/]+)\/compare\/(.+)$/.exec(endpoint);
    if (!match || !validEnrichEndpoint(endpoint) || parseRepoRef(match[1] as string) === null) return false;
    return repoScopedUrl(LINKED_SOURCE_GITHUB_BASE, match[1] as string, "/compare/", match[2] as string) === url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hash) return false;
  const raw = url.slice(parsed.origin.length);
  const pathOnly = raw.split("?", 1)[0] as string;
  switch (parsed.origin) {
    case "https://auth.docker.io":
      return pathOnly === "/token";
    case "https://ghcr.io":
      return pathOnly === "/token" || (parsed.search === "" && REGISTRY_PATH.test(raw));
    case "https://registry-1.docker.io":
      return parsed.search === "" && REGISTRY_PATH.test(raw);
    default:
      return false;
  }
}

/** `DeadlineBudget.from_env("IMAGE_DIGEST_BUDGET_SEC", default=60)`: a
 * `Date.now()`-based deadline in ms, or null when disabled (<= 0). */
export function imageDigestDeadline(env: NodeJS.ProcessEnv, now: number = Date.now()): number | null {
  const parsed = pyIntFromText(env.IMAGE_DIGEST_BUDGET_SEC ?? String(DEFAULT_IMAGE_DIGEST_BUDGET_SEC));
  const budget = parsed === null ? DEFAULT_IMAGE_DIGEST_BUDGET_SEC : Number(parsed);
  return budget <= 0 ? null : now + budget * 1000;
}

/** `safeFetchLike` refusals that are policy, not transport, failures. */
const POLICY_REFUSAL = /does not resolve to public addresses|^scheme |credentials in URL|only GET/;

/** `str(CalledProcessError)` for the v2 curl argv, credential redacted. */
function curlFailure(url: string, headers: Readonly<Record<string, string>>, exitStatus: number): Error {
  const argv = ["curl", "-fsSL", "--connect-timeout", String(CURL_CONNECT_TIMEOUT_SEC), "--max-time", String(CURL_MAX_TIME_SEC), url];
  for (const [key, value] of Object.entries(headers)) {
    argv.push("-H", key.toLowerCase() === "authorization" ? `${key}: [REDACTED]` : `${key}: ${value}`);
  }
  return new Error(`HTTP request failed: Command '[${argv.map(pyReprStr).join(", ")}]' returned non-zero exit status ${exitStatus}.`);
}

/** curl's exit status for a fetch rejection. */
function curlExitStatus(error: unknown): number {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return 28;
  if (error instanceof SourceFetchError && /exceeds \d+ bytes/.test(error.message)) return 63;
  const cause = error instanceof Error ? (error as Error & { cause?: { code?: unknown } }).cause : undefined;
  const code = typeof cause?.code === "string" ? cause.code : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return 6;
  if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return 7;
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return 28;
  if (code.startsWith("CERT_") || code.startsWith("ERR_TLS_") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "DEPTH_ZERO_SELF_SIGNED_CERT") return 60;
  return 56;
}

export interface ImageTransportOptions {
  /** Replaces the whole per-hop transport (default: #808's `safeFetchLike`
   * built from `resolver`/`exchange`). Only for tests and fixtures. */
  fetchImpl?: FetchLike;
  /** DNS seam for the default safe transport. */
  resolver?: Resolver;
  /** Socket seam for the default safe transport. */
  exchange?: Exchange;
  maxBytes?: number;
  /** Opt-in `Authorization: Bearer` for the api.github.com compare (v2
   * sends none). Never forwarded off-origin. */
  githubToken?: string;
  /** Whole-request bound in ms (curl `--max-time`). */
  maxTimeMs?: number;
}

/** The production `HttpJson` for image provenance. */
export function createImageHttpJson(options: ImageTransportOptions = {}): HttpJson {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_RESPONSE_BYTES;
  const fetchImpl: FetchLike =
    options.fetchImpl ??
    safeFetchLike({
      resolver: options.resolver,
      exchange: options.exchange,
      maxBytes,
      timeoutMs: CURL_CONNECT_TIMEOUT_SEC * 1000,
    });
  const maxTimeMs = options.maxTimeMs ?? CURL_MAX_TIME_SEC * 1000;
  return async (url: string, headers: Readonly<Record<string, string>> = {}): Promise<unknown> => {
    if (!imageTransportAllows(url)) {
      throw new Error(`HTTP request failed: refusing ${url}: outside the image-provenance endpoint allowlist`);
    }
    const outgoing: Record<string, string> = { ...headers };
    if (!Object.keys(outgoing).some((key) => key.toLowerCase() === "accept")) outgoing.Accept = "*/*";
    if (!Object.keys(outgoing).some((key) => key.toLowerCase() === "user-agent")) outgoing["User-Agent"] = USER_AGENT;
    if (options.githubToken && url.startsWith(GITHUB_PREFIX)) outgoing.Authorization = `Bearer ${options.githubToken}`;

    const signal = AbortSignal.timeout(maxTimeMs);
    let current = new URL(url);
    let response: Response;
    for (let redirects = 0; ; redirects += 1) {
      try {
        response = await fetchImpl(current, { method: "GET", headers: outgoing, redirect: "manual", signal });
      } catch (error) {
        if (error instanceof SourceFetchError && POLICY_REFUSAL.test(error.message)) {
          throw new Error(`HTTP request failed: refusing ${redirects === 0 ? "request" : "redirect hop"}: ${error.message}`);
        }
        throw curlFailure(url, headers, curlExitStatus(error));
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        if (redirects >= MAX_REDIRECTS) throw curlFailure(url, headers, 47);
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw curlFailure(url, headers, 3);
        }
        if (next.protocol !== "https:") throw curlFailure(url, headers, 1);
        if (next.username !== "" || next.password !== "") {
          throw new Error("HTTP request failed: refusing redirect hop: credentials in URL not allowed");
        }
        if (next.origin !== current.origin) {
          for (const key of Object.keys(outgoing)) if (key.toLowerCase() === "authorization") delete outgoing[key];
        }
        current = next;
        continue;
      }
      break;
    }
    if (response.status >= 400) throw curlFailure(url, headers, 22);
    let text: string;
    try {
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > maxBytes) throw new SourceFetchError(`response exceeds ${maxBytes} bytes`);
      text = body.toString("utf8");
    } catch (error) {
      throw curlFailure(url, headers, curlExitStatus(error));
    }
    try {
      return pyJsonLoads(text);
    } catch (error) {
      if (error instanceof PyJsonDecodeError || error instanceof PyUncaughtError) {
        throw new Error(`HTTP request failed: ${error.message}`);
      }
      throw error;
    }
  };
}

/** `image_digest_analysis.py` `main()` minus the file I/O: the provenance
 * document for *diffText* over the real transport, under the
 * IMAGE_DIGEST_BUDGET_SEC deadline. */
export function buildImageProvenanceFromNetwork(
  diffText: string,
  env: NodeJS.ProcessEnv,
  options: ImageTransportOptions = {},
): Promise<string> {
  return buildImageProvenanceContext(diffText, createImageHttpJson(options), imageDigestDeadline(env));
}
