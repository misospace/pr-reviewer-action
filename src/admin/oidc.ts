import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";

export const DEFAULT_OIDC_SESSION_TTL_MS = 28_800_000;
export interface OidcAdminConfig {
  readonly mode: "oidc";
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectBase: string;
  readonly allowedSubjects: readonly string[];
  readonly allowedEmails: readonly string[];
  readonly allowedGroups: readonly string[];
  readonly sessionTtlMs: number;
}
export type AdminAuthConfig = { readonly mode: "token" } | { readonly mode: "oidc"; readonly config: OidcAdminConfig };
const refusal = (message: string): never => { throw new Error(message); };
function splitList(value: string | undefined): string[] { return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean); }
function checkedUrl(value: string | undefined, name: string, issuer = false): URL {
  if (!value) return refusal(`${name} is required`);
  let url: URL;
  try { url = new URL(value); } catch { return refusal(`${name} must be a valid URL`); }
  if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash) return refusal(`${name} must be an http(s) URL without userinfo, query, or fragment`);
    if (url.protocol === "http:" && !(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")) return refusal(`${name} may use http only for loopback hosts`);
   if (issuer && (url.username || url.password || url.search || url.hash)) return refusal(`${name} must not contain userinfo, query, or fragment`);
  if (issuer && url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return url;
}
export function parseOidcAdminAuth(env: NodeJS.ProcessEnv): AdminAuthConfig {
  const rawMode = (env.PR_REVIEWER_ADMIN_AUTH_MODE ?? "").trim();
  const mode = rawMode || "token";
  if (mode === "token") return { mode: "token" };
  if (mode !== "oidc") return refusal("PR_REVIEWER_ADMIN_AUTH_MODE must be token or oidc");
  const issuer = checkedUrl(env.PR_REVIEWER_ADMIN_OIDC_ISSUER, "PR_REVIEWER_ADMIN_OIDC_ISSUER", true).toString().replace(/\/$/, "");
  const redirect = checkedUrl(env.PR_REVIEWER_ADMIN_OIDC_REDIRECT_BASE, "PR_REVIEWER_ADMIN_OIDC_REDIRECT_BASE");
  const clientId = env.PR_REVIEWER_ADMIN_OIDC_CLIENT_ID ?? "";
  const clientSecret = env.PR_REVIEWER_ADMIN_OIDC_CLIENT_SECRET ?? "";
  if (!clientId.trim()) refusal("PR_REVIEWER_ADMIN_OIDC_CLIENT_ID is required");
  if (!clientSecret.trim()) refusal("PR_REVIEWER_ADMIN_OIDC_CLIENT_SECRET is required");
  const allowedSubjects = splitList(env.PR_REVIEWER_ADMIN_OIDC_ALLOWED_SUBJECTS);
  const allowedEmails = splitList(env.PR_REVIEWER_ADMIN_OIDC_ALLOWED_EMAILS).map((x) => x.toLowerCase());
  const allowedGroups = splitList(env.PR_REVIEWER_ADMIN_OIDC_ALLOWED_GROUPS);
  if (!allowedSubjects.length && !allowedEmails.length && !allowedGroups.length) refusal("at least one PR_REVIEWER_ADMIN_OIDC_ALLOWED_SUBJECTS, PR_REVIEWER_ADMIN_OIDC_ALLOWED_EMAILS, or PR_REVIEWER_ADMIN_OIDC_ALLOWED_GROUPS entry is required");
  const ttlRaw = env.PR_REVIEWER_ADMIN_OIDC_SESSION_TTL_MS;
  const sessionTtlMs = ttlRaw === undefined || ttlRaw.trim() === "" ? DEFAULT_OIDC_SESSION_TTL_MS : Number(ttlRaw);
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 300_000 || sessionTtlMs > 86_400_000) refusal("PR_REVIEWER_ADMIN_OIDC_SESSION_TTL_MS must be an integer from 300000 through 86400000");
  return { mode: "oidc", config: { mode: "oidc", issuer, clientId, clientSecret, redirectBase: redirect.toString().replace(/\/$/, ""), allowedSubjects, allowedEmails, allowedGroups, sessionTtlMs } };
}

export interface AdminSessionPrincipal { readonly subject: string; readonly email: string; readonly groups: readonly string[]; readonly csrfToken: string; readonly expiresAtMs: number }
interface LoginTransaction { readonly state: string; readonly nonce: string; readonly pkceVerifier: string; readonly expiresAtMs: number }
export class AdminSessionStore {
  private readonly entries = new Map<string, AdminSessionPrincipal | LoginTransaction>();
  constructor(private readonly nowMs: () => number = Date.now, private readonly limit = 1024) {}
  private put<T extends AdminSessionPrincipal | LoginTransaction>(value: T): string {
    for (const [id, item] of this.entries) if (item.expiresAtMs <= this.nowMs()) this.entries.delete(id);
    if (this.entries.size >= this.limit) {
      const oldest = [...this.entries].sort((a, b) => a[1].expiresAtMs - b[1].expiresAtMs)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    const id = randomBytes(32).toString("base64url");
    this.entries.set(id, value);
    return id;
  }
  create(principal: Omit<AdminSessionPrincipal, "csrfToken" | "expiresAtMs">, ttlMs: number): string {
    return this.put({ ...principal, csrfToken: randomBytes(32).toString("base64url"), expiresAtMs: this.nowMs() + ttlMs });
  }
  createTransaction(): { readonly id: string; readonly transaction: LoginTransaction } {
    // /auth/login is unauthenticated, so pending transactions get their own
    // small budget: a login flood is refused (503 at the route) instead of
    // evicting live operator sessions from the shared store.
    const transactionCap = Math.min(this.limit, 256);
    let pending = 0;
    for (const item of this.entries.values()) if (!("subject" in item)) pending += 1;
    if (pending >= transactionCap) throw new Error("login transaction limit reached");
    const transaction = { state: randomBytes(32).toString("base64url"), nonce: randomBytes(32).toString("base64url"), pkceVerifier: randomBytes(32).toString("base64url"), expiresAtMs: this.nowMs() + 600_000 };
    return { id: this.put(transaction), transaction };
  }
  validate(id: string | undefined): AdminSessionPrincipal | null {
    const value = id === undefined ? undefined : this.entries.get(id);
    if (!value || !("subject" in value)) return null;
    if (value.expiresAtMs <= this.nowMs()) { if (id) this.entries.delete(id); return null; }
    return value;
  }
  takeTransaction(id: string | undefined): LoginTransaction | null {
    if (!id) return null;
    const value = this.entries.get(id);
    this.entries.delete(id);
    return value && "state" in value && value.expiresAtMs > this.nowMs() ? value : null;
  }
  destroy(id: string | undefined): void { if (id) this.entries.delete(id); }
}
export function parseCookie(header: string | string[] | undefined, name: string): string | undefined {
  if (typeof header !== "string" || header.length > 8192) return undefined;
  for (const part of header.split(";", 64)) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}
export function buildCookie(name: string, value: string, secure: boolean, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
export function attestedEmail(claims: Record<string, unknown>): string {
  // The one rule for trusting the `email` claim, shared by authorization
  // (`authorizeClaims`) and the session identity (#1785): the provider must
  // attest `email_verified: true` — a bare `email` claim is self-asserted
  // and must never authorize or display on its own.
  return claims.email_verified === true && typeof claims.email === "string" ? claims.email.slice(0, 320) : "";
}
export function authorizeClaims(claims: Record<string, unknown>, config: OidcAdminConfig): boolean {
  // The lists combine as OR: a claim that satisfies ANY configured list is
  // authorized. Within the email list, a match counts only when the provider
  // attests `email_verified: true` — a bare `email` claim is self-asserted
  // and must never be the authorization gate on its own.
  let matched = false;
  if (config.allowedSubjects.length) matched ||= typeof claims.sub === "string" && config.allowedSubjects.includes(claims.sub);
  if (config.allowedEmails.length) {
    const email = attestedEmail(claims).toLowerCase();
    matched ||= config.allowedEmails.some((allowed) => allowed.startsWith("@") ? email.endsWith(allowed) : email === allowed);
  }
  if (config.allowedGroups.length) {
    const groups = Array.isArray(claims.groups) ? claims.groups.filter((item): item is string => typeof item === "string") : [];
    matched ||= groups.some((group) => config.allowedGroups.includes(group));
  }
  return matched;
}
interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
const MAX_RESPONSE = 1_048_576;
/** Normalized issuer comparison: providers disagree on a trailing slash
 * (Auth0 publishes one), so both sides are stripped before comparing. */
const sameIssuer = (a: unknown, b: string): boolean => typeof a === "string" && a.replace(/\/$/, "") === b;
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok || Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE) throw new Error("OIDC endpoint unavailable");
  // Stream with a running byte cap: the body is never buffered past MAX_RESPONSE.
  if (response.body === null) throw new Error("OIDC endpoint unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE) throw new Error("OIDC response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid OIDC response");
  return value as Record<string, unknown>;
}
export class OidcAdminProvider {
  private discovery: Discovery | null = null;
  private jwks: { readonly keys: Record<string, unknown>[]; readonly fetchedAtMs: number } | null = null;
  constructor(readonly config: OidcAdminConfig, private readonly fetcher: typeof fetch = fetch) {}
  private async getJson(url: string): Promise<Record<string, unknown>> {
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    return boundedJson(response);
  }
  private async metadata(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const data = await this.getJson(`${this.config.issuer}/.well-known/openid-configuration`);
    if (!sameIssuer(data.issuer, this.config.issuer) || typeof data.authorization_endpoint !== "string" || typeof data.token_endpoint !== "string" || typeof data.jwks_uri !== "string") throw new Error("invalid OIDC discovery document");
    // Every endpoint the flow then talks to must satisfy the same transport
    // policy as the operator-configured URLs: an https issuer must not be
    // able to hand us a plaintext code exchange or JWKS endpoint (http stays
    // available for loopback providers in local development).
    const authorization = checkedUrl(data.authorization_endpoint, "OIDC authorization_endpoint");
    const token = checkedUrl(data.token_endpoint, "OIDC token_endpoint");
    const jwks = checkedUrl(data.jwks_uri, "OIDC jwks_uri");
    this.discovery = { issuer: this.config.issuer, authorization_endpoint: authorization.toString(), token_endpoint: token.toString(), jwks_uri: jwks.toString() };
    return this.discovery;
  }
  async authorizationUrl(transaction: LoginTransaction, callback: string): Promise<string> {
    const metadata = await this.metadata();
    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set("response_type", "code"); url.searchParams.set("client_id", this.config.clientId); url.searchParams.set("redirect_uri", callback);
    url.searchParams.set("scope", "openid email profile"); url.searchParams.set("state", transaction.state); url.searchParams.set("nonce", transaction.nonce);
    url.searchParams.set("code_challenge", createHash("sha256").update(transaction.pkceVerifier).digest("base64url")); url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }
  private async keys(force: boolean): Promise<Record<string, unknown>[]> {
    // The cache expires after 15 minutes even when every kid is known: a key
    // revoked at the provider must not stay trusted for the process lifetime.
    if (this.jwks && !force && Date.now() - this.jwks.fetchedAtMs < 900_000) return this.jwks.keys;
    const meta = await this.metadata(); const doc = await this.getJson(meta.jwks_uri);
    if (!Array.isArray(doc.keys)) throw new Error("invalid OIDC JWKS");
    this.jwks = { keys: doc.keys.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)), fetchedAtMs: Date.now() };
    return this.jwks.keys;
  }
  async exchange(code: string, transaction: LoginTransaction, callback: string): Promise<Record<string, unknown>> {
    const metadata = await this.metadata();
    const response = await this.fetcher(metadata.token_endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callback, client_id: this.config.clientId, client_secret: this.config.clientSecret, code_verifier: transaction.pkceVerifier }) });
    const tokenData = await boundedJson(response);
    if (typeof tokenData.id_token !== "string" || tokenData.id_token.length > 65536) throw new Error("missing OIDC ID token");
    return this.verifyIdToken(tokenData.id_token, transaction.nonce);
  }
  private async verifyIdToken(token: string, nonce: string): Promise<Record<string, unknown>> {
    const parts = token.split("."); if (parts.length !== 3 || parts.some((part) => part.length > 32768)) throw new Error("malformed ID token");
    const decode = (part: string): Record<string, unknown> => { const data: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8")); if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("malformed ID token"); return data as Record<string, unknown>; };
    const header = decode(parts[0]!); const claims = decode(parts[1]!);
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("unsupported ID token algorithm");
    let key = (await this.keys(false)).find((item) => item.kid === header.kid && item.kty === "RSA" && item.use !== "enc");
    if (!key) key = (await this.keys(true)).find((item) => item.kid === header.kid && item.kty === "RSA" && item.use !== "enc");
    if (!key) throw new Error("OIDC signing key not found");
    if (typeof key.n !== "string" || typeof key.e !== "string") throw new Error("invalid OIDC signing key");
    const jwk = { kty: "RSA", n: key.n, e: key.e, alg: "RS256", use: "sig" };
    const valid = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2]!, "base64url"));
    const now = Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!valid || !sameIssuer(claims.iss, this.config.issuer) || !audiences.includes(this.config.clientId) || (audiences.length > 1 ? claims.azp !== this.config.clientId : claims.azp !== undefined && claims.azp !== this.config.clientId) || typeof claims.exp !== "number" || claims.exp <= now || typeof claims.iat !== "number" || claims.iat > now + 60 || claims.nonce !== nonce) throw new Error("invalid OIDC ID token claims");
    return claims;
  }
}
export function csrfMatches(expected: string, actual: string | string[] | undefined): boolean {
  // Compare byte length, not character length: a multibyte header value with
  // the same character count must fail cleanly instead of throwing inside
  // timingSafeEqual and surfacing a 500.
  if (typeof actual !== "string") return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
