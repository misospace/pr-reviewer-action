/** #1821: the production SSRF-gated transport behind the npm package
 * comparison. Builds the `FetchJson` / `FetchBytes` seams consumed by
 * `npm-package-provenance.ts`, replacing v2-style unbounded curl with the same
 * fail-closed fence the image provenance transport uses (#808 `safeFetchLike`:
 * http(s) only, no userinfo, public-only pinned DNS/IP), and additionally:
 *
 * - every START url must be a canonical npm registry document or tarball for
 *   the exact package, and its host must be in the operator's
 *   `allowed-source-hosts`; anything else is refused before a request;
 * - redirects are followed only over https, public-only (the SSRF fence), with
 *   Authorization never attached (npm reads are unauthenticated);
 * - responses are capped: version documents at `MAX_NPM_JSON_BYTES`, tarballs
 *   at `MAX_NPM_TARBALL_BYTES`. The tarball is fetched as raw bytes (not
 *   decoded), and integrity verification in the comparison layer is the final
 *   authority on what the bytes mean;
 * - every in-flight read is clamped to the time left under the caller's
 *   `deadline` (`npm-package-budget-sec`), so the run never overshoots the
 *   ceiling by a whole per-request timeout (#1821 review round 3).
 *
 * Refusals surface as `null` from `fetchBytes` / a throw from `fetchJson`, both
 * recorded by the comparison layer as an unresolved version — never a guess. */

import { safeFetchLike, type Exchange, type Resolver } from "../platform/safe-fetch.js";
import type { FetchLike } from "../platform/http.js";
import { USER_AGENT } from "../platform/user-agent.js";
import { pyIntFromText } from "../evidence/pyjson.js";
import {
  MAX_NPM_TARBALL_BYTES,
  NPM_REGISTRY_ORIGIN,
  type NpmFetchBytes,
  type NpmFetchJson,
} from "./npm-package-provenance.js";

/** Version documents are small metadata; bound well below the tarball cap. */
export const MAX_NPM_JSON_BYTES = 2 * 1024 * 1024;
export const DEFAULT_NPM_PACKAGE_BUDGET_SEC = 60;
/** curl-style whole-request bound shared with the image transport lineage. */
export const NPM_FETCH_MAX_TIME_MS = 40_000;
/** `safeFetchLike` never follows redirects; cap our own hop loop at the same
 * bound urllib uses elsewhere in the codebase. */
const MAX_NPM_REDIRECTS = 10;

/** The canonical npm registry package-document path grammar the comparison
 * layer builds: `/<encoded-name>/<exact-version>`, where `<encoded-name>` is an
 * unscoped name or the single-segment `@scope%2Fname` spelling. Query and hash
 * are absent by construction. The version segment carries the EXACT spelling
 * `registryVersionDocUrl` produces: `encodeURIComponent` leaves every semver
 * character but `+` untouched, so a build-metadata version (`1.0.0+build`)
 * arrives as `1.0.0%2Bbuild` and the grammar accepts only that uppercase `%2B`
 * encoding — any other percent sequence stays refused (#1821 review round 4). */
const VERSION_DOC_PATH = /^\/(?:[a-z0-9._~-]+|@[a-z0-9._~-]+%2F[a-z0-9._~-]+)\/[0-9](?:[0-9a-z.+-]|%2B[0-9a-z.+-])*$/;

/** The canonical npm tarball path grammar: `/<name>/-/<basename>.tgz` (the
 * scope is spelled `@scope/name` here, NOT percent-encoded — this is the URL the
 * version document's `dist.tarball` carries verbatim). */
const TARBALL_PATH = /^\/[^\0]*\/-\/[^/]+\.tgz$/;

function registryHost(): string {
  return new URL(NPM_REGISTRY_ORIGIN).hostname;
}

/** Whether a version-document URL is a clean registry read the operator
 * allowlisted. */
export function npmTransportAllowsVersionDoc(url: string, allowedHosts: ReadonlySet<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin !== NPM_REGISTRY_ORIGIN) return false;
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return false;
  if (parsed.search !== "" || parsed.hash !== "") return false;
  if (!VERSION_DOC_PATH.test(parsed.pathname)) return false;
  return allowedHosts.has(registryHost());
}

/** Whether a tarball URL (read from a registry document) is a clean registry
 * tarball read the operator allowlisted. */
export function npmTransportAllowsTarball(url: string, allowedHosts: ReadonlySet<string>): boolean {
  if (url.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return false;
  if (parsed.hostname !== registryHost()) return false;
  if (!allowedHosts.has(registryHost())) return false;
  // No dot segments or empty segments anywhere in the path; the `/-/` marker
  // with a `.tgz` basename is the npm tarball shape.
  if (parsed.pathname.includes("\\") || parsed.pathname.includes("//")) return false;
  for (const segment of parsed.pathname.split("/")) {
    if (segment === ".." || segment === ".") return false;
  }
  if (parsed.hash !== "" || parsed.search !== "") return false;
  return TARBALL_PATH.test(parsed.pathname);
}

export interface NpmTransportOptions {
  /** The operator's resolved `allowed-source-hosts`. */
  allowedHosts: ReadonlySet<string>;
  /** DNS seam for the default safe transport. */
  resolver?: Resolver;
  /** Socket seam for the default safe transport. */
  exchange?: Exchange;
  /** Replaces the whole per-hop transport (tests/fixtures only). */
  fetchImpl?: FetchLike;
  /** Whole-request bound in ms. */
  maxTimeMs?: number;
  /** Caller-owned abort, composed with the per-request deadline. */
  signal?: AbortSignal;
  /** A `Date.now()`-milliseconds deadline (#1821 review round 3): an in-flight
   * read is clamped to the time left under it — never the full per-request
   * timeout — and past it no request is issued at all, so the run cannot
   * overshoot the `npm-package-budget-sec` ceiling. Absent leaves only the
   * per-request bound. */
  deadline?: number | null;
}

export interface NpmFetches {
  fetchJson: NpmFetchJson;
  fetchBytes: NpmFetchBytes;
}

/** Build the production fetch seams over the SSRF fence. */
export function createNpmFetches(options: NpmTransportOptions): NpmFetches {
  const fetchImpl: FetchLike = options.fetchImpl
    ?? safeFetchLike({
      resolver: options.resolver,
      exchange: options.exchange,
      // The fence's per-response cap is raised to the larger of JSON/tarball;
      // each reader additionally enforces its own tighter cap below.
      maxBytes: MAX_NPM_TARBALL_BYTES,
      timeoutMs: Math.min(NPM_FETCH_MAX_TIME_MS, options.maxTimeMs ?? NPM_FETCH_MAX_TIME_MS),
    });
  const maxTimeMs = options.maxTimeMs ?? NPM_FETCH_MAX_TIME_MS;
  // #1821 review round 3: the per-run budget deadline clamps EACH request to
  // the time left under it (never the full 40s whole-request bound), so one
  // in-flight read can no longer run past `npm-package-budget-sec`. Past the
  // deadline the seams refuse before any request.
  const deadlinePast = (): boolean =>
    options.deadline !== undefined && options.deadline !== null && Date.now() >= options.deadline;
  const requestSignal = (): AbortSignal => {
    const remaining = options.deadline !== undefined && options.deadline !== null
      ? Math.min(maxTimeMs, options.deadline - Date.now())
      : maxTimeMs;
    const timeout = AbortSignal.timeout(Math.max(0, remaining));
    return options.signal !== undefined ? AbortSignal.any([timeout, options.signal]) : timeout;
  };

  const readOnce = async (
    url: string,
    cap: number,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array } | null> => {
    let current = new URL(url);
    for (let redirects = 0; ; redirects += 1) {
      let response: Response;
      try {
        response = await fetchImpl(current, { method: "GET", headers: { "User-Agent": USER_AGENT }, redirect: "manual", signal });
      } catch {
        return null;
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location !== null && location !== "") {
        if (redirects >= MAX_NPM_REDIRECTS) return null;
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return null;
        }
        if (next.protocol !== "https:") return null;
        if (next.username !== "" || next.password !== "") return null;
        // The version document is the trust anchor for the package identity, so
        // every hop must stay on the authoritative registry host: a redirect to
        // any other public host could serve a document that names this package
        // and pins its OWN attacker-chosen tarball + integrity, forging a
        // "registry-verified" delta the registry never associated with the
        // version. (The public-only pinned fence still gates the registry host's
        // own resolution.) Cross-host redirects fail closed to unresolved.
        if (next.hostname !== registryHost()) return null;
        current = next;
        continue;
      }
      if (response.status < 200 || response.status >= 300) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > cap) return null;
      return { bytes };
    }
  };

  const fetchJson: NpmFetchJson = async (url) => {
    if (!npmTransportAllowsVersionDoc(url, options.allowedHosts)) {
      throw new Error(`npm package transport: refusing ${url}: outside the registry document allowlist`);
    }
    if (deadlinePast()) throw new Error("npm package transport: version document read refused: budget deadline passed");
    const response = await readOnce(url, MAX_NPM_JSON_BYTES, requestSignal());
    if (response === null) throw new Error("npm package transport: version document read failed");
    return JSON.parse(new TextDecoder("utf8", { fatal: false }).decode(response.bytes));
  };

  const fetchBytes: NpmFetchBytes = async (url) => {
    if (!npmTransportAllowsTarball(url, options.allowedHosts)) return null;
    if (deadlinePast()) return null;
    const response = await readOnce(url, MAX_NPM_TARBALL_BYTES, requestSignal());
    if (response === null) return null;
    return response.bytes;
  };

  return { fetchJson, fetchBytes };
}

/** `DeadlineBudget.from_env("NPM_PACKAGE_BUDGET_SEC", default=60)`-shaped: a
 * `Date.now()`-ms deadline, or null when disabled (<= 0). Parsed with
 * `pyIntFromText` like `imageDigestDeadline` (#1821 review round 4): a
 * malformed value such as `"5abc"` falls back to the documented 60s default
 * instead of a silently truncated `Number.parseInt` prefix. */
export function npmPackageDeadline(env: NodeJS.ProcessEnv, now: number = Date.now()): number | null {
  const parsed = pyIntFromText(env.NPM_PACKAGE_BUDGET_SEC ?? String(DEFAULT_NPM_PACKAGE_BUDGET_SEC));
  const budget = parsed === null ? DEFAULT_NPM_PACKAGE_BUDGET_SEC : Number(parsed);
  return budget <= 0 ? null : now + budget * 1000;
}
