/** SSRF-safe fetch for linked-source enrichment (#706 PR 5b).
 *
 * Port of `pr_reviewer.http_client.fetch_url` (+ `_AllowListRedirectHandler`)
 * and the `pr_reviewer.enrichment` host/DNS gate (`host_allowed`,
 * `_resolve_host_ips`, `_host_ips_are_public`), on Node's built-in
 * `http`/`https` with no new dependencies.
 *
 * Security model:
 * - Every hop (the initial URL and each redirect) is checked for scheme
 *   (http/https — v2 allows both), an exact-hostname allowlist match, and a
 *   DNS resolution in which EVERY address is public (`ip-policy.ts`).
 * - The resolution is done once per hop and the connection is pinned to it:
 *   the socket's `lookup` hook (`pinnedLookup`) re-validates and returns only
 *   those addresses, so a second DNS answer can never be used (no rebinding
 *   window — v2's urllib re-resolved at connect time). IP-literal hosts skip
 *   DNS and are validated directly.
 * - TLS SNI and the Host header carry the original hostname; certificate
 *   verification is Node's default.
 * - Redirects are followed manually with v2's caps: at most 10 hops, and the
 *   same target at most 4 times (urllib's `max_repeats`).
 * - Hostnames are taken the way v2 takes them (CPython `urlsplit` /
 *   `urllib.request`), and a URL whose connection target is ambiguous
 *   (userinfo, non-numeric port, non-ASCII or control characters in the
 *   request target) fails closed.
 * - The body is capped (`MAX_SOURCE_BYTES`; v2 read unbounded) and each
 *   socket operation times out after 25 s (urllib's `timeout=25`); callers may
 *   also pass an abort signal (the enrichment budget deadline).
 *
 * Divergences from v2 (all fail closed; see docs/v3-migration.md): the size
 * cap, redirect hops to a non-http(s) scheme (urllib followed `ftp://`),
 * env proxies are not honored, and the CGNAT/site-local additions in
 * `ip-policy.ts`. */

import { promises as dnsPromises } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { isPublicAddress, parseIpLiteral } from "./ip-policy.js";
import { pyRequestTarget, pyUrlHost, pyUrlsplit } from "./py-url.js";
import { USER_AGENT } from "./user-agent.js";

/** Resolves a hostname to IP literal strings (throw or [] on failure). */
export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) => {
  const answers = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
};

/** `fetch_url`'s default allowlist (used by v2's `_fetch_sections`, which
 * never passes its own). */
export const DEFAULT_FETCH_HOSTS: ReadonlySet<string> = new Set(["github.com", "gitlab.com", "registry.terraform.io", "artifacthub.io"]);

export const SOURCE_FETCH_TIMEOUT_MS = 25_000;
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 10;
export const MAX_REPEATS = 4;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export type AddressPolicy = (address: string) => boolean;

/** `_resolve_host_ips`: an IP literal is returned as-is (no DNS); otherwise
 * the resolver's answers, de-duplicated in order; any failure is []. */
export async function resolveHostIps(host: string, resolver: Resolver): Promise<string[]> {
  if (!host) return [];
  if (parseIpLiteral(host) !== null) return [host];
  let answers: string[];
  try {
    answers = await resolver(host);
  } catch {
    return [];
  }
  return [...new Set(answers)];
}

/** `_host_ips_are_public`, returning the validated addresses to pin (null
 * when resolution failed or ANY address is not public). */
export async function resolvePublicAddresses(host: string, resolver: Resolver, isAllowed: AddressPolicy = isPublicAddress): Promise<string[] | null> {
  const ips = await resolveHostIps(host, resolver);
  if (ips.length === 0) return null;
  return ips.every((ip) => isAllowed(ip)) ? ips : null;
}

/** `enrichment.host_allowed(url, allowed)`: exact host allowlist match AND
 * public-only resolution. Throws where CPython's `urlparse` would. */
export async function hostAllowed(url: string, allowed: ReadonlySet<string>, resolver: Resolver): Promise<boolean> {
  const host = pyUrlHost(url);
  if (!allowed.has(host)) return false;
  return (await resolvePublicAddresses(host, resolver)) !== null;
}

function familyOf(address: string): 4 | 6 {
  return parseIpLiteral(address)?.family === 6 ? 6 : 4;
}

/** The socket `lookup` hook: answers ONLY for `expectedHost`, and only with
 * the already-validated addresses (re-checked against the policy), so the
 * connection uses exactly what was validated. */
export function pinnedLookup(expectedHost: string, addresses: readonly string[], isAllowed: AddressPolicy = isPublicAddress): LookupFunction {
  return (hostname, options, callback) => {
    const fail = (message: string): void => {
      const error = Object.assign(new Error(message), { code: "ENOTFOUND" });
      callback(error as NodeJS.ErrnoException, "", 4);
    };
    if (hostname.toLowerCase() !== expectedHost.toLowerCase()) {
      fail(`lookup for unexpected host ${hostname}`);
      return;
    }
    const wanted = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
    const candidates = addresses
      .filter((address) => isAllowed(address))
      .map((address) => ({ address, family: familyOf(address) }))
      .filter((candidate) => !wanted || candidate.family === wanted);
    if (candidates.length === 0 || candidates.length !== addresses.filter((a) => !wanted || familyOf(a) === wanted).length) {
      fail(`no validated address for ${hostname}`);
      return;
    }
    if (options.all) {
      callback(null, candidates);
      return;
    }
    callback(null, candidates[0]!.address, candidates[0]!.family);
  };
}

export interface ExchangeRequest {
  /** The URL as urllib records it (`Request.full_url`). */
  url: string;
  protocol: "http:" | "https:";
  /** Connection host (the original hostname; SNI + Host header). */
  host: string;
  port: number | null;
  /** Request-line target. */
  path: string;
  /** Validated addresses the connection is pinned to. */
  addresses: string[];
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal | undefined;
}

export interface ExchangeResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}

/** One HTTP exchange; rejects on transport failure, timeout or size cap. */
export type Exchange = (request: ExchangeRequest) => Promise<ExchangeResponse>;

export class SourceFetchError extends Error {}

function headerText(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Real transport: node:http/https pinned to the validated addresses. */
export function createNodeExchange(isAllowed: AddressPolicy = isPublicAddress): Exchange {
  return (req) => new Promise<ExchangeResponse>((resolve, reject) => {
    const isHttps = req.protocol === "https:";
    const literal = parseIpLiteral(req.host) !== null;
    if (literal && !req.addresses.every((address) => address === req.host && isAllowed(address))) {
      reject(new SourceFetchError(`address ${req.host} is not validated`));
      return;
    }
    const options: https.RequestOptions = {
      protocol: req.protocol,
      hostname: req.host,
      port: req.port ?? (isHttps ? 443 : 80),
      path: req.path,
      method: "GET",
      headers: req.headers,
      agent: false,
      lookup: pinnedLookup(req.host, req.addresses, isAllowed),
      timeout: req.timeoutMs,
    };
    if (req.signal) options.signal = req.signal;
    if (isHttps && !literal) options.servername = req.host;
    let settled = false;
    const done = (error: Error | null, value?: ExchangeResponse): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value!);
    };
    const request = (isHttps ? https : http).request(options, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let ended = false;
      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > req.maxBytes) {
          request.destroy(new SourceFetchError(`response exceeds ${req.maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        ended = true;
        if (!res.complete) {
          done(new SourceFetchError("connection closed before the response completed"));
          return;
        }
        done(null, {
          status: res.statusCode ?? 0,
          headers: { location: headerText(res.headers.location), uri: headerText(res.headers.uri) },
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", (error) => done(error));
      res.on("close", () => {
        if (!ended) done(new SourceFetchError("connection closed before the response completed"));
      });
    });
    request.on("timeout", () => request.destroy(new SourceFetchError(`timed out after ${req.timeoutMs} ms`)));
    request.on("error", (error) => done(error));
    request.end();
  });
}

export const nodeExchange: Exchange = createNodeExchange();

/** `urllib.parse.quote(url, encoding="iso-8859-1", safe=string.punctuation)`
 * over a latin-1 decoded header value (as http.client decodes it): ASCII
 * letters, digits, punctuation and `_.-~` stay; everything else becomes %XX
 * of its latin-1 byte. Null where the encode would raise (a code point above
 * U+00FF). */
export function pyQuoteLatin1(text: string): string | null {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code > 0xff) return null;
    if ((code >= 0x21 && code <= 0x7e)) out += ch;
    else out += `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export interface FetchSourceOptions {
  allowedHosts?: ReadonlySet<string> | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  resolver?: Resolver | undefined;
  exchange?: Exchange | undefined;
  signal?: AbortSignal | undefined;
  /** Test seam only; production uses `isPublicAddress`. */
  addressPolicy?: AddressPolicy | undefined;
}

interface Hop {
  target: NonNullable<ReturnType<typeof pyRequestTarget>>;
  addresses: string[];
}

/** Scheme, hostname, allowlist, and public-DNS checks for one hop; the
 * validated connection target, or null (fail closed). */
async function checkHop(url: string, allowed: ReadonlySet<string>, resolver: Resolver, policy: AddressPolicy): Promise<Hop | null> {
  let scheme: string;
  let host: string;
  try {
    scheme = pyUrlsplit(url).scheme;
    host = pyUrlHost(url);
  } catch {
    return null;
  }
  if (scheme !== "http" && scheme !== "https") return null;
  if (!host || !allowed.has(host)) return null;
  const target = pyRequestTarget(url);
  // The host urllib would connect to must be the host that was allowlisted.
  if (target === null || target.scheme !== scheme || target.host.toLowerCase() !== host) return null;
  const addresses = await resolvePublicAddresses(host, resolver, policy);
  if (addresses === null) return null;
  return { target, addresses };
}

/** `fetch_url(url, timeout, allowed_hosts)`: the body bytes, or null on ANY
 * failure (disallowed scheme/host, non-public resolution, transport error,
 * non-2xx status, too many redirects, oversize body). */
export async function fetchSource(url: string, options: FetchSourceOptions = {}): Promise<Uint8Array | null> {
  const allowed = new Set([...(options.allowedHosts ?? DEFAULT_FETCH_HOSTS)].map((h) => h.toLowerCase()));
  const resolver = options.resolver ?? systemResolver;
  const exchange = options.exchange ?? nodeExchange;
  const policy = options.addressPolicy ?? isPublicAddress;
  const timeoutMs = options.timeoutMs ?? SOURCE_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_SOURCE_BYTES;
  try {
    let hop = await checkHop(url, allowed, resolver, policy);
    if (hop === null) return null;
    let redirects = 0;
    const visited = new Map<string, number>();
    for (;;) {
      const { target, addresses } = hop;
      const response = await exchange({
        url: target.fullUrl,
        protocol: target.scheme === "https" ? "https:" : "http:",
        host: target.host,
        port: target.port,
        path: target.path,
        addresses,
        headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "identity", Connection: "close" },
        timeoutMs,
        maxBytes,
        signal: options.signal,
      });
      if (response.body.length > maxBytes) return null;
      if (response.status >= 200 && response.status < 300) return response.body;
      if (!REDIRECT_CODES.has(response.status)) return null;
      const location = response.headers.location ?? response.headers.uri;
      if (location === undefined) return null;
      // http_error_302: urlparse the raw Location (scheme gate), urlunparse
      // (drops the tab/CR/LF urlsplit strips), quote, then join.
      let locationScheme: string;
      try {
        locationScheme = pyUrlsplit(location).scheme;
      } catch {
        return null;
      }
      if (!["http", "https", ""].includes(locationScheme)) return null;
      // eslint-disable-next-line no-control-regex
      const quoted = pyQuoteLatin1(location.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, ""));
      if (quoted === null) return null;
      let next: string;
      try {
        next = new URL(quoted, target.fullUrl).href;
      } catch {
        return null;
      }
      if (redirects >= MAX_REDIRECTS) return null;
      hop = await checkHop(next, allowed, resolver, policy);
      if (hop === null) return null;
      redirects += 1;
      const seen = visited.get(next) ?? 0;
      if (seen >= MAX_REPEATS) return null;
      visited.set(next, seen + 1);
    }
  } catch {
    return null;
  }
}

function initHeaders(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export interface SafeFetchLikeOptions {
  resolver?: Resolver | undefined;
  exchange?: Exchange | undefined;
  maxBytes?: number | undefined;
  timeoutMs?: number | undefined;
  addressPolicy?: AddressPolicy | undefined;
}

/** Cap for Forgejo enrichment API JSON (compare payloads carry patches). */
export const MAX_ENRICH_API_BYTES = 32 * 1024 * 1024;

/** A `fetch`-compatible transport for the enrichment API clients that read
 * PR-controlled hosts (Forgejo): GET only, http/https only, public-only
 * pinned resolution, no redirect following (a 3xx is returned as-is, and the
 * clients' `requestText` treats it as an error). */
export function safeFetchLike(options: SafeFetchLikeOptions = {}): (input: string | URL, init?: RequestInit) => Promise<Response> {
  const resolver = options.resolver ?? systemResolver;
  const exchange = options.exchange ?? nodeExchange;
  const policy = options.addressPolicy ?? isPublicAddress;
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new SourceFetchError(`scheme ${url.protocol} not allowed`);
    if (url.username !== "" || url.password !== "") throw new SourceFetchError("credentials in URL not allowed");
    if ((init?.method ?? "GET").toUpperCase() !== "GET") throw new SourceFetchError("only GET is allowed");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await resolvePublicAddresses(host, resolver, policy);
    if (addresses === null) throw new SourceFetchError(`host ${host} does not resolve to public addresses only`);
    const response = await exchange({
      url: url.href,
      protocol: url.protocol,
      host,
      port: url.port === "" ? null : Number(url.port),
      path: `${url.pathname}${url.search}`,
      addresses,
      headers: initHeaders(init),
      timeoutMs: options.timeoutMs ?? SOURCE_FETCH_TIMEOUT_MS,
      maxBytes: options.maxBytes ?? MAX_ENRICH_API_BYTES,
      signal: init?.signal ?? undefined,
    });
    if (response.status < 200 || response.status > 599) throw new SourceFetchError(`unexpected status ${response.status}`);
    const nullBody = response.status === 204 || response.status === 205 || response.status === 304;
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, value);
    return new Response(nullBody ? null : Buffer.from(response.body), { status: response.status, headers });
  };
}
