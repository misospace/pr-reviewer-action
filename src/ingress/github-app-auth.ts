// GitHub App authentication substrate for the post-v3 self-hosted ingress
// (#729): an App JWT mint plus a short-lived, repo-scoped installation-token
// broker.
//
// WHY THIS EXISTS SEPARATELY FROM EVERY OTHER FORGE READ/WRITE PATH: no forge
// CLI can carry a GitHub App private key or mint installation tokens. `gh`
// authenticates with a PAT/OAuth token/device flow only. So the App path cannot
// be "the Forgejo seam with a different token header" — it needs its own
// capability client that issues every read AND write over the repo's typed HTTP
// transport with a resolved, scoped, short-lived credential. This file owns the
// credential; `github-app-client.ts` owns the read/write seam.
//
// Security invariants:
// - ORIGIN BINDING FIRST: `apiBaseUrl` is validated through
//   `parsePlatformBaseUrl` in the constructor, BEFORE the app id or the private
//   key are even looked at, so a credential can only ever bind to a validated
//   http(s) origin with no embedded credentials (the #674/#670/#682 SSRF
//   boundary).
// - The private key never crosses this seam: it lives in a `#private` field that
//   no accessor, no `toJSON`, and no error message returns. Only the minted JWT
//   (short-lived, App-scoped, not a repository credential) and the
//   installation token (short-lived, repository-scoped) are ever produced.
// - Credentials travel ONLY as the `Authorization: Bearer <value>` header through
//   `platform/http.ts`, never in a URL, query string, request body, or any
//   returned/logged string. `requestJson` pins the request to the validated
//   origin and refuses redirects (`redirect: "manual"`).
// - Every failure is a FIXED, BOUNDED reason carrying a permanent/transient
//   classification. No response byte, no header, no token, and no key material
//   is ever echoed — a hostile or reflecting server that returns our credential
//   in a 4xx body cannot get it back out through this seam.
import { createSign } from "node:crypto";
import { PlatformRequestError, requestJson, type FetchLike, type RequestOptions } from "../platform/http.js";
import { parseRepoRef } from "../platform/repo-ref.js";
import { parsePlatformBaseUrl } from "../platform/urls.js";

/** Whether retrying the same request could ever succeed. `permanent` means the
 * configuration/credential/permission state is wrong (fix the config);
 * `transient` means the failure is expected to clear on its own. */
export type AuthFailureClassification = "permanent" | "transient";

export interface InstallationToken {
  /** The bearer token value. Caller-internal only: it belongs in the outbound
   * Authorization header and nowhere else. */
  readonly token: string;
  /** Absolute expiry in epoch SECONDS (GitHub's `expires_at`). */
  readonly expiresAt: number;
}

/** The discriminated result every credential operation returns. A reason is
 * always a fixed, bounded string — never a response body, a URL, or any
 * credential material. */
export type AuthResult =
  | { readonly ok: true; readonly data: InstallationToken }
  | { readonly ok: false; readonly reason: string; readonly classification: AuthFailureClassification };

export interface GitHubAppAuthenticatorOptions {
  /** API base (`https://api.github.com`, or a GHE `<host>/api/v3`). Validated
   * with `parsePlatformBaseUrl` before any credential is bound. */
  readonly apiBaseUrl: string;
  /** The App's numeric id, as a digit string (becomes the JWT `iss`). */
  readonly appId: string;
  /** PEM RSA private key. Held in a `#private` field; never exposed. */
  readonly privateKeyPem: string;
  readonly timeoutMs?: number | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  /** Injected clock, epoch MILLIECONDS (injected for deterministic tests). */
  readonly now?: (() => number) | undefined;
}

export interface InstallationTokenOptions {
  /** Optional repository scoping, `owner/name` full names. When present the
   * minted token is bound to exactly these repositories; when absent the token
   * carries the installation's full grant, which callers should prefer not to
   * do. */
  readonly repositories?: readonly string[] | undefined;
}

/** An installation id is interpolated into a URL PATH, so it is digits only: a
 * CR/LF, a slash, a query marker, or any non-digit form is refused before the
 * URL is built and therefore before any network call. */
const INSTALLATION_ID_RE = /^[1-9][0-9]{0,18}$/;

/** Upper bound on a single scoped mint request, so one call cannot be turned
 * into an unbounded body by a caller-supplied repository list. */
const MAX_SCOPE_ENTRIES = 100;

/** GitHub caps an App JWT at 10 minutes; we mint the full window but skew the
 * issued-at backwards so a verifier whose clock runs fast still accepts it. */
const JWT_LIFETIME_SECONDS = 600;
const JWT_CLOCK_SKEW_SECONDS = 60;

/** Conservative assumed lifetime when `expires_at` is absent or unparseable: an
 * over-short cache entry only costs one extra mint, while an over-long one would
 * hand out a token GitHub has already revoked. */
const DEFAULT_INSTALLATION_TOKEN_LIFETIME_SECONDS = 3600;

/** Refresh this far ahead of `expires_at` so a token is never handed to a
 * request that outlives it. */
const REFRESH_MARGIN_SECONDS = 60;

export function isValidInstallationId(value: string): boolean {
  return INSTALLATION_ID_RE.test(value);
}

/**
 * The cache key rule (#729), exported so the rule itself is pinnable:
 * the installation id PLUS the normalized (trimmed, de-duplicated, sorted,
 * lowercased) repository scope.
 *
 * Two consequences, both required:
 * - two installations can never see each other's tokens (the installation id is
 *   part of the key);
 * - the same installation asked for two different scopes never receives a token
 *   minted for the other scope (the scope is part of the key).
 *
 * An empty scope is the key `"*"` — the unscoped installation-wide grant — and
 * is distinct from every scoped key.
 */
export function installationScopeKey(installationId: string, repositories: readonly string[] = []): string | null {
  if (!isValidInstallationId(installationId)) return null;
  const seen = new Set<string>();
  for (const entry of repositories) {
    if (parseRepoRef(entry.trim()) === null) return null;
    seen.add(entry.trim().toLowerCase());
  }
  if (seen.size > MAX_SCOPE_ENTRIES) return null;
  return `${installationId}\u0000${[...seen].sort().join(",") || "*"}`;
}

/**
 * Mints GitHub App credentials for one or more installations of one App.
 *
 * The cache is per-instance and keyed by installation + scope: it is never
 * global, never shared across instances, and never pinned to a single
 * configured repository. A token is short-lived by construction — it is cached
 * only until `expires_at` minus the refresh margin.
 */
export class GitHubAppAuthenticator {
  /** The validated API base (origin + path prefix, no trailing slash). */
  readonly apiBase: string;
  /** The validated origin. This is the ONLY origin that may ever receive an
   * `Authorization` header from this seam. */
  readonly origin: string;
  /** The App id. Public by design (it is the JWT `iss`), never the key. */
  readonly appId: string;

  /** PRIVATE KEY CONTAINMENT: a `#private` field is unreachable from
   * `Object.keys`, `Reflect.ownKeys`, `JSON.stringify`, and every accessor, so
   * no exported surface can serialize the key material. It is read only by
   * `mintAppJwt`. */
  #privateKeyPem: string;
  #timeoutMs: number | undefined;
  #fetchImpl: FetchLike | undefined;
  #now: () => number;
  #cache: Map<string, InstallationToken>;
  /** Resolved App bot login (`<slug>[bot]`), or null while unresolved / when the
   * identity could not be proven. A login is public metadata, not a credential,
   * so caching it leaks nothing — but it is still `#private` so no caller can
   * write a forged identity into the cache. */
  #botLogin: string | null;

  constructor(opts: GitHubAppAuthenticatorOptions) {
    // ORIGIN BINDING FIRST. A malformed base (embedded credentials, non-http(s),
    // missing hostname, empty) throws before the app id or the key are read, so
    // no credential is ever bound to an unvalidated origin.
    const { base, origin } = parsePlatformBaseUrl(opts.apiBaseUrl, "github app api base URL");
    this.apiBase = base;
    this.origin = origin;
    if (!isValidInstallationId(opts.appId)) {
      throw new Error("invalid GitHub App id");
    }
    this.appId = opts.appId;
    if (
      opts.privateKeyPem.trim() === "" ||
      !opts.privateKeyPem.includes("-----BEGIN ") ||
      !opts.privateKeyPem.includes("PRIVATE KEY-----")
    ) {
      // No key material in this message — not a prefix, not a length.
      throw new Error("invalid GitHub App private key");
    }
    this.#privateKeyPem = opts.privateKeyPem;
    this.#timeoutMs = opts.timeoutMs;
    this.#fetchImpl = opts.fetchImpl;
    this.#now = opts.now ?? Date.now;
    this.#cache = new Map<string, InstallationToken>();
    this.#botLogin = null;
  }

  #nowSeconds(): number {
    return Math.floor(this.#now() / 1000);
  }

  /**
   * Mint the RS256 App JWT `{ iat, exp, iss: appId }`.
   *
   * This JWT is an APP credential, not a repository credential: it can only be
   * spent against the `/app/...` endpoints, never against repo contents, and it
   * dies within 10 minutes (GitHub's hard cap). `iat` is skewed 60 seconds into
   * the past to absorb verifier clock skew; `exp` is `iat + 600`, so the window
   * GitHub validates is still 10 minutes.
   *
   * Throws a fixed, key-free error when the key cannot sign (a malformed key is
   * permanent — retrying cannot help), which `installationToken` converts into a
   * classified failure.
   */
  mintAppJwt(): string {
    const iat = this.#nowSeconds() - JWT_CLOCK_SKEW_SECONDS;
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({ iat, exp: iat + JWT_LIFETIME_SECONDS, iss: this.appId }));
    const signingInput = `${header}.${payload}`;
    try {
      const signer = createSign("RSA-SHA256");
      signer.update(signingInput);
      signer.end();
      // Base64url without padding, per RFC 7515.
      return `${signingInput}.${signer.sign(this.#privateKeyPem).toString("base64url")}`;
    } catch {
      throw new Error("GitHub App private key could not sign");
    }
  }

  /**
   * Return a valid installation token for `installationId`, optionally scoped to
   * `repositories`, minting one only when the cache has no live entry for that
   * exact (installation, scope) pair.
   *
   * Never throws: every failure — bad input, a key that cannot sign, a non-2xx,
   * or a transport failure — is a fixed reason plus a permanent/transient
   * classification.
   */
  async installationToken(
    installationId: string,
    options?: InstallationTokenOptions,
  ): Promise<AuthResult> {
    const requested = options?.repositories ?? [];
    const key = installationScopeKey(installationId, requested);
    // Refused before the URL is built, so a hostile installation id never
    // reaches the transport.
    if (key === null) {
      return isValidInstallationId(installationId)
        ? { ok: false, reason: "invalid repository scope", classification: "permanent" }
        : { ok: false, reason: "invalid installation id", classification: "permanent" };
    }

    const now = this.#nowSeconds();
    const cached = this.#cache.get(key);
    if (cached !== undefined && cached.expiresAt - REFRESH_MARGIN_SECONDS > now) {
      return { ok: true, data: cached };
    }

    let jwt: string;
    try {
      jwt = this.mintAppJwt();
    } catch {
      return { ok: false, reason: "GitHub App private key could not sign", classification: "permanent" };
    }

    // The installation id is digits-only (validated above), so it cannot carry a
    // path separator or a query marker into this URL. No credential appears in
    // the URL: the JWT travels as the Authorization header.
    const url = `${this.apiBase}/app/installations/${installationId}/access_tokens`;
    const scope = normalizeScope(requested);
    if (scope === null) {
      return { ok: false, reason: "invalid repository scope", classification: "permanent" };
    }

    const requestOptions: RequestOptions = {
      method: "POST",
      token: `Bearer ${jwt}`,
      body: scope.length === 0 ? "{}" : JSON.stringify({ repositories: scope }),
      allowedOrigin: this.origin,
    };
    if (this.#timeoutMs !== undefined) requestOptions.timeoutMs = this.#timeoutMs;
    if (this.#fetchImpl !== undefined) requestOptions.fetchImpl = this.#fetchImpl;

    let status: number;
    let data: unknown;
    try {
      ({ status, data } = await requestJson(url, requestOptions));
    } catch (error) {
      // Only the FIXED reason survives: the thrown error's message can carry
      // transport internals, and a redirect/origin refusal is a configuration
      // fact (permanent), not a flake.
      if (error instanceof PlatformRequestError && error.kind === "origin-mismatch") {
        return { ok: false, reason: "github app token request blocked", classification: "permanent" };
      }
      return { ok: false, reason: "github app token request failed", classification: "transient" };
    }

    if (status < 200 || status >= 300) {
      const mapped = classifyStatus(status);
      return { ok: false, reason: mapped.reason, classification: mapped.classification };
    }

    const minted = readMintedToken(data);
    if (minted === null) {
      // A 2xx without a usable token is a server contract violation. Treat it as
      // permanent: caching nothing and reporting is safer than guessing.
      return {
        ok: false,
        reason: "github app token response was malformed",
        classification: "permanent",
      };
    }
    const entry: InstallationToken = {
      token: minted.token,
      expiresAt: minted.expiresAt ?? now + DEFAULT_INSTALLATION_TOKEN_LIFETIME_SECONDS,
    };
    this.#cache.set(key, entry);
    return { ok: true, data: entry };
  }

  /**
   * The App's own bot login (`<slug>[bot]`), or null when it cannot be proven.
   *
   * WHY THIS EXISTS (#729: "own-comment/review identity cannot be spoofed by PR
   * author"): a managed comment is located by its marker, and a marker in a
   * comment body is forgeable — the PR author can post the marker themselves.
   * Before a PATCH may touch a located comment, the caller must know which
   * login this seam posts as, so a foreign-authored marker comment is never
   * overwritten. `GET /user` cannot answer that for an App: it returns 403
   * "Resource not accessible by integration" for both `GITHUB_TOKEN` and an
   * installation token. `GET /app`, authenticated with the APP JWT, is the
   * source that does answer, and the slug it reports is public metadata, not a
   * credential.
   *
   * Never throws. A failed or unusable response returns null and caches
   * nothing, so a transient failure re-proves on the next call instead of
   * pinning a negative identity into the publisher.
   */
  async appIdentity(): Promise<string | null> {
    if (this.#botLogin !== null) return this.#botLogin;

    let jwt: string;
    try {
      jwt = this.mintAppJwt();
    } catch {
      return null;
    }

    const requestOptions: RequestOptions = {
      method: "GET",
      token: `Bearer ${jwt}`,
      allowedOrigin: this.origin,
    };
    if (this.#timeoutMs !== undefined) requestOptions.timeoutMs = this.#timeoutMs;
    if (this.#fetchImpl !== undefined) requestOptions.fetchImpl = this.#fetchImpl;

    let status: number;
    let data: unknown;
    try {
      ({ status, data } = await requestJson(`${this.apiBase}/app`, requestOptions));
    } catch {
      // A transport failure is never a proof. No response internals escape here.
      return null;
    }
    if (status < 200 || status >= 300) return null;

    const login = botLoginFrom(data);
    if (login === null) return null;
    this.#botLogin = login;
    return login;
  }
}

/** Normalized, de-duplicated, sorted repository scope for the request body. The
 * caller's casing is preserved (GitHub is case-insensitive on full names, and
 * the body is what GitHub sees); only key derivation lowercases. */
function normalizeScope(repositories: readonly string[]): string[] | null {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of repositories) {
    const trimmed = entry.trim();
    if (parseRepoRef(trimmed) === null) return null;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(trimmed);
  }
  if (out.length > MAX_SCOPE_ENTRIES) return null;
  return out.sort((a, b) => a.localeCompare(b));
}

/** Fixed status → classification map. The reason is built from a LITERAL plus
 * the numeric status only: no response byte ever reaches it. */
const TOKEN_STATUS_REASONS: Readonly<Record<number, { readonly reason: string; readonly classification: AuthFailureClassification }>> = Object.freeze({
  400: { reason: "github app token request refused (400)", classification: "permanent" },
  401: { reason: "github app token request unauthorized (401)", classification: "permanent" },
  403: { reason: "github app token request forbidden (403)", classification: "permanent" },
  404: { reason: "github app installation not found (404)", classification: "permanent" },
  405: { reason: "github app token request refused (405)", classification: "permanent" },
  422: { reason: "github app token request refused (422)", classification: "permanent" },
  429: { reason: "github app token request rate limited (429)", classification: "transient" },
});

function classifyStatus(status: number): { readonly reason: string; readonly classification: AuthFailureClassification } {
  const mapped = TOKEN_STATUS_REASONS[status];
  if (mapped !== undefined) return mapped;
  if (status >= 500) {
    return { reason: `github app token request failed (${status})`, classification: "transient" };
  }
  return { reason: `github app token request refused (${status})`, classification: "permanent" };
}

/** Extract `{ token, expires_at }` from a 2xx mint response. Returns null when
 * the payload cannot yield a usable bearer value; the caller supplies the
 * conservative fallback lifetime when `expires_at` is absent or unparseable. */
function readMintedToken(data: unknown): { readonly token: string; readonly expiresAt: number | null } | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const payload = data as { readonly token?: unknown; readonly expires_at?: unknown };
  if (typeof payload.token !== "string" || payload.token === "") return null;
  // Header injection guard: a CR/LF-bearing token would let a hostile server
  // split the outbound request.
  if (payload.token.includes("\r") || payload.token.includes("\n")) return null;
  if (typeof payload.expires_at !== "number" || !Number.isFinite(payload.expires_at)) {
    return { token: payload.token, expiresAt: null };
  }
  return { token: payload.token, expiresAt: Math.floor(payload.expires_at) };
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** A GitHub App slug: the app-name charset, bounded. A slug carrying anything
 * else (a `[bot]` suffix already applied, whitespace, control bytes, a very long
 * value) is not usable as an identity. */
const APP_SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/;

/** Derive the App's bot login from a `GET /app` payload: `<slug>[bot]`.
 *
 * Returns null for an unusable payload — a missing/non-string slug, a slug
 * outside the charset, or an object whose own fields are absent. The slug is
 * matched against the charset rather than interpolated into anything, so a
 * hostile `/app` response cannot inject a login that then matches a comment
 * author of its choosing.
 */
function botLoginFrom(data: unknown): string | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const slug = (data as { readonly slug?: unknown }).slug;
  if (typeof slug !== "string") return null;
  const trimmed = slug.trim();
  if (!APP_SLUG_RE.test(trimmed)) return null;
  return `${trimmed}[bot]`;
}