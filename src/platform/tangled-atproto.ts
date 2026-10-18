import { PlatformRequestError, requestJson, type FetchLike } from "./http.js";

/**
 * Generic AT-Proto session + record client (#837), the primitive the later
 * Tangled publish module (#588) consumes. Deliberately narrow: session
 * establishment and `createRecord`/`putRecord`/`listRecords` ONLY — no
 * pull/comment/review semantics live here.
 *
 * Security properties:
 * - every HTTP call goes through the shared `requestJson` transport; no raw
 *   fetch, no shell, no new npm dependencies;
 * - the app password and every returned JWT exist only in memory and travel
 *   only inside the JSON body (password) or the Authorization header
 *   (access JWT), which `requestJson` binds to the validated host origin
 *   (`allowedOrigin`) — tokens never appear in URLs, argv, or diagnostics;
 * - the create-session call itself carries NO Authorization header;
 * - redirects are already refused by `requestJson` (`redirect: "manual"` —
 *   a 3xx is a `PlatformRequestError` of kind "redirect-blocked"), so an
 *   Authorization header can never leak to another origin;
 * - error messages may carry status codes, NSIDs, and server `message`
 *   strings only after redaction: any candidate message containing
 *   JWT-shaped dot-separated segments (`eyJ…`), or the configured
 *   password, is replaced with a generic one;
 * - the session is lazily established on the first authenticated call and
 *   stored in memory only — never persisted, logged, or returned.
 *
 * Expired-session handling: an authenticated call failing with HTTP 401,
 * or a body whose `error` is exactly `ExpiredToken`/`InvalidToken`,
 * discards the in-memory session, re-establishes it ONCE, and retries the
 * original request ONCE. A second consecutive failure, or a failure during
 * re-auth, throws — exactly one retry, never a loop.
 */

export type TangledAtprotoFailureKind = "config" | "auth" | "request" | "invalid-response";

export class TangledAtprotoError extends Error {
  readonly kind: TangledAtprotoFailureKind;

  constructor(kind: TangledAtprotoFailureKind, message: string) {
    super(message);
    this.name = "TangledAtprotoError";
    this.kind = kind;
  }
}

export interface TangledAtprotoConfig {
  /** PDS base URL, e.g. `https://bsky.social`. */
  host: string;
  /** Account handle (identifier for `createSession`). */
  handle: string;
  /** App password; kept in memory only, never logged. */
  appPassword: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Optional injected transport (tests); defaults to global fetch. */
  fetchImpl?: FetchLike | undefined;
}

/** Plaintext http is accepted for these hosts only (local test instances). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Bare-hostname shape (lowercase input): no scheme, path, port,
 * credentials, or empty labels. Mirrors tangled.ts's validation style. */
const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_HOST = "https://bsky.social";

const XRPC_CREATE_SESSION = "com.atproto.server.createSession";
const XRPC_CREATE_RECORD = "com.atproto.repo.createRecord";
const XRPC_PUT_RECORD = "com.atproto.repo.putRecord";
const XRPC_LIST_RECORDS = "com.atproto.repo.listRecords";

const LIST_DEFAULT_LIMIT = 50;
const LIST_MIN_LIMIT = 1;
const LIST_MAX_LIMIT = 100;

interface AtprotoSession {
  did: string;
  accessJwt: string;
  refreshJwt: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Strip anything that looks like a JWT (dot-separated segments starting
 * `eyJ`, i.e. base64url JSON) or matches the configured password from a
 * candidate server-provided message; when either is present the message is
 * replaced wholesale with a generic one rather than partially redacted.
 */
function redactMessage(candidate: string, appPassword: string): string {
  const segments = candidate.split(".");
  if (segments.some((s) => s.startsWith("eyJ")) && segments.length > 1) {
    return "(server message redacted: contained credential-shaped material)";
  }
  if (appPassword !== "" && candidate.includes(appPassword)) {
    return "(server message redacted: contained credential-shaped material)";
  }
  return candidate;
}

/** Validate the configured host URL: HTTPS required unless loopback. */
function validateHost(name: string, value: string): URL {
  if (!/^https?:\/\//i.test(value)) {
    throw new TangledAtprotoError("config", `${name} must be an http(s) URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TangledAtprotoError("config", `${name} must be a valid http(s) URL`);
  }
  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (hostname === "") {
    throw new TangledAtprotoError("config", `${name} must be an absolute http(s) URL with a host`);
  }
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(hostname)) {
    throw new TangledAtprotoError(
      "config",
      `${name} must be an https URL; plaintext http is accepted for loopback hosts only`,
    );
  }
  if (!LOOPBACK_HOSTS.has(hostname) && !HOSTNAME_RE.test(hostname)) {
    throw new TangledAtprotoError("config", `${name} has an invalid hostname`);
  }
  // Strip any path/query: the client talks to `<origin>/xrpc/...`.
  return new URL(parsed.origin);
}

/** Build an `TangledAtprotoConfig` from the environment (or any string-keyed
 * mapping, so tests inject fixtures). `ATPROTO_HANDLE` and
 * `ATPROTO_APP_PASSWORD` are required — the error names the missing
 * variable. `ATPROTO_TIMEOUT` is in SECONDS and must parse as a positive
 * finite number (default 30). Values are trimmed; an empty value is absent. */
export function atprotoConfigFromEnv(env: Record<string, string | undefined>): TangledAtprotoConfig {
  const get = (name: string): string | undefined => {
    const value = (env[name] ?? "").trim();
    return value === "" ? undefined : value;
  };
  const handle = get("ATPROTO_HANDLE");
  if (handle === undefined) {
    throw new TangledAtprotoError("config", "ATPROTO_HANDLE is required for the AT-Proto client");
  }
  const appPassword = get("ATPROTO_APP_PASSWORD");
  if (appPassword === undefined) {
    throw new TangledAtprotoError("config", "ATPROTO_APP_PASSWORD is required for the AT-Proto client");
  }
  const hostValue = get("ATPROTO_HOST") ?? DEFAULT_HOST;
  const host = validateHost("ATPROTO_HOST", hostValue);
  const timeoutRaw = get("ATPROTO_TIMEOUT");
  let timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000;
  if (timeoutRaw !== undefined) {
    const parsed = Number(timeoutRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new TangledAtprotoError("config", "ATPROTO_TIMEOUT must be a positive finite number of seconds");
    }
    timeoutMs = parsed * 1000;
  }
  const config: TangledAtprotoConfig = { host: host.toString(), handle, appPassword, timeoutMs };
  return config;
}

export class TangledAtprotoClient {
  private readonly origin: string;
  private readonly basePath: string;
  private readonly handle: string;
  private readonly appPassword: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike | undefined;
  private session: AtprotoSession | undefined;

  constructor(config: TangledAtprotoConfig) {
    const base = validateHost("host", config.host);
    this.origin = base.origin;
    this.basePath = base.pathname.replace(/\/+$/, "");
    this.handle = config.handle;
    this.appPassword = config.appPassword;
    this.timeoutMs = config.timeoutMs;
    this.fetchImpl = config.fetchImpl;
  }

  /** #588: the session DID once a session has been established; `undefined`
   * before the first authenticated call. Read-only — never establishes a
   * session or triggers a network call. */
  get did(): string | undefined {
    return this.session?.did;
  }

  private xrpcUrl(nsid: string, params?: Record<string, string>): string {
    const url = new URL(this.origin + this.basePath + "/xrpc/" + nsid);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    return url.toString();
  }

  /** One `requestJson` call against the validated host origin. */
  private async call(
    nsid: string,
    opts: { method?: string; token?: string; body?: string; query?: Record<string, string> },
  ): Promise<{ status: number; data: unknown }> {
    try {
      return await requestJson(this.xrpcUrl(nsid, opts.query), {
        method: opts.method,
        token: opts.token,
        body: opts.body,
        allowedOrigin: this.origin,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      if (error instanceof TangledAtprotoError) throw error;
      if (error instanceof PlatformRequestError) {
        throw new TangledAtprotoError(
          error.kind === "invalid-json" ? "invalid-response" : "request",
          `AT-Proto ${nsid} failed: ${redactMessage(error.message, this.appPassword)}`,
        );
      }
      throw new TangledAtprotoError(
        "request",
        `AT-Proto ${nsid} failed: ${redactMessage(
          error instanceof Error ? error.message : String(error),
          this.appPassword,
        )}`,
      );
    }
  }

  /** Whether a failed authenticated response indicates the session is dead. */
  private static isExpired(status: number, data: unknown): boolean {
    if (status === 401) return true;
    const isTokenErrorCode = (2 <= status && status < 300) || (400 <= status && status < 500);
    if (!isTokenErrorCode) return false;
    const record = asRecord(data);
    const error = record === undefined ? undefined : str(record.error);
    return error === "ExpiredToken" || error === "InvalidToken";
  }

  private static buildExpiredError(nsid: string): TangledAtprotoError {
    return new TangledAtprotoError("auth", `AT-Proto ${nsid} failed: session expired or invalid after one retry`);
  }

  /** Establish a session. The createSession call carries NO Authorization
   * header; the password travels only in the JSON body. */
  private async establishSession(): Promise<AtprotoSession> {
    const body = JSON.stringify({ identifier: this.handle, password: this.appPassword });
    const { status, data } = await this.call(XRPC_CREATE_SESSION, { method: "POST", body });
    if (status < 200 || status >= 300) {
      const record = asRecord(data);
      const serverMessage = record === undefined ? undefined : str(record.message);
      throw new TangledAtprotoError(
        "auth",
        `AT-Proto ${XRPC_CREATE_SESSION} returned HTTP ${status}` +
          (serverMessage === undefined ? "" : `: ${redactMessage(serverMessage, this.appPassword)}`),
      );
    }
    const record = asRecord(data);
    const did = record === undefined ? undefined : str(record.did);
    const accessJwt = record === undefined ? undefined : str(record.accessJwt);
    const refreshJwt = record === undefined ? undefined : str(record.refreshJwt);
    if (did === undefined || accessJwt === undefined || refreshJwt === undefined) {
      throw new TangledAtprotoError(
        "invalid-response",
        `${XRPC_CREATE_SESSION} response lacks string did/accessJwt/refreshJwt`,
      );
    }
    return { did, accessJwt, refreshJwt };
  }

  /** Lazily get the current session (establishing it on first use). */
  private async getSession(): Promise<AtprotoSession> {
    if (this.session === undefined) {
      this.session = await this.establishSession();
    }
    return this.session;
  }

  /** Run `fn` with the current session; on an expired-session failure
   * (HTTP 401 or an `ExpiredToken`/`InvalidToken` body), re-authenticate
   * ONCE and retry ONCE. A second failure throws — never a loop. */
  private async withSession<T>(nsid: string, fn: (session: AtprotoSession) => Promise<T>): Promise<T> {
    let session = await this.getSession();
    try {
      return await fn(session);
    } catch (error) {
      if (error instanceof TangledAtprotoError) throw error;
      if (!(error instanceof ExpiredResponse)) throw error;
    }
    // Session dead: discard, re-establish once, retry once.
    this.session = undefined;
    session = await this.establishSession(); // re-auth failure propagates
    return fn(session).catch((error: unknown) => {
      if (error instanceof ExpiredResponse) {
        throw TangledAtprotoClient.buildExpiredError(nsid);
      }
      throw error;
    });
  }

  /** Map a non-OK (or shape-violating) authenticated response into either
   * an `ExpiredResponse` signal (for the retry path) or a thrown error. */
  private async expectOk(
    nsid: string,
    result: { status: number; data: unknown },
  ): Promise<Record<string, unknown>> {
    if (result.status >= 200 && result.status < 300) {
      // A 200 whose body carries an expired/invalid token error code is a
      // failed authenticated call, not a success.
      if (TangledAtprotoClient.isExpired(result.status, result.data)) {
        throw new ExpiredResponse(result.status, result.data);
      }
      const record = asRecord(result.data);
      if (record === undefined) {
        throw new TangledAtprotoError("invalid-response", `${nsid} did not return a JSON object`);
      }
      return record;
    }
    if (TangledAtprotoClient.isExpired(result.status, result.data)) {
      throw new ExpiredResponse(result.status, result.data);
    }
    const record = asRecord(result.data);
    const serverMessage = record === undefined ? undefined : str(record.message);
    throw new TangledAtprotoError(
      "request",
      `AT-Proto ${nsid} returned HTTP ${result.status}` +
        (serverMessage === undefined ? "" : `: ${redactMessage(serverMessage, this.appPassword)}`),
    );
  }

  /** `com.atproto.repo.createRecord`: POST the record into `collection`. */
  async createRecord(collection: string, record: Record<string, unknown>): Promise<{ uri: string; cid: string }> {
    const validated = validateCollection(collection);
    return this.withSession(XRPC_CREATE_RECORD, async (session) => {
      const body = JSON.stringify({ repo: session.did, collection: validated, record });
      const result = await this.call(XRPC_CREATE_RECORD, {
        method: "POST",
        token: `Bearer ${session.accessJwt}`,
        body,
      });
      const payload = await this.expectOk(XRPC_CREATE_RECORD, result);
      const uri = str(payload.uri);
      const cid = str(payload.cid);
      if (uri === undefined || cid === undefined) {
        throw new TangledAtprotoError(
          "invalid-response",
          `${XRPC_CREATE_RECORD} response lacks string uri/cid`,
        );
      }
      return { uri, cid };
    });
  }

  /** `com.atproto.repo.putRecord`: overwrite the record at `rkey`. */
  async putRecord(collection: string, rkey: string, record: Record<string, unknown>): Promise<{ uri: string; cid: string }> {
    const validated = validateCollection(collection);
    if (rkey === "") {
      throw new TangledAtprotoError("config", "rkey must be a non-empty string");
    }
    return this.withSession(XRPC_PUT_RECORD, async (session) => {
      const body = JSON.stringify({ repo: session.did, collection: validated, rkey, record });
      const result = await this.call(XRPC_PUT_RECORD, {
        method: "POST",
        token: `Bearer ${session.accessJwt}`,
        body,
      });
      const payload = await this.expectOk(XRPC_PUT_RECORD, result);
      const uri = str(payload.uri);
      const cid = str(payload.cid);
      if (uri === undefined || cid === undefined) {
        throw new TangledAtprotoError(
          "invalid-response",
          `${XRPC_PUT_RECORD} response lacks string uri/cid`,
        );
      }
      return { uri, cid };
    });
  }

  /** `com.atproto.repo.listRecords`: GET the records in `collection`.
   * `limit` is clamped to 1..100 (default 50); entries whose `value` is not
   * an object are dropped; `cursor` is surfaced only when the response
   * carries a non-empty string. */
  async listRecords(
    collection: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<{
    records: Array<{ uri: string; cid: string | undefined; value: Record<string, unknown> }>;
    cursor: string | undefined;
  }> {
    const validated = validateCollection(collection);
    const rawLimit = options?.limit;
    const limit =
      rawLimit === undefined
        ? LIST_DEFAULT_LIMIT
        : Math.min(LIST_MAX_LIMIT, Math.max(LIST_MIN_LIMIT, Math.trunc(rawLimit)));
    return this.withSession(XRPC_LIST_RECORDS, async (session) => {
      const query: Record<string, string> = {
        repo: session.did,
        collection: validated,
        limit: String(limit),
      };
      const cursor = options?.cursor;
      if (cursor !== undefined && cursor !== "") query.cursor = cursor;
      const result = await this.call(XRPC_LIST_RECORDS, {
        method: "GET",
        token: `Bearer ${session.accessJwt}`,
        query,
      });
      const payload = await this.expectOk(XRPC_LIST_RECORDS, result);
      const items = payload.records;
      if (!Array.isArray(items)) {
        throw new TangledAtprotoError("invalid-response", `${XRPC_LIST_RECORDS} response has no records array`);
      }
      const records: Array<{ uri: string; cid: string | undefined; value: Record<string, unknown> }> = [];
      for (const item of items) {
        const itemRecord = asRecord(item);
        if (itemRecord === undefined) continue;
        const uri = str(itemRecord.uri);
        const value = asRecord(itemRecord.value);
        if (uri === undefined || value === undefined) continue; // drop non-object values
        const cid = str(itemRecord.cid);
        records.push({ uri, cid, value });
      }
      const nextCursor = str(payload.cursor);
      return { records, cursor: nextCursor === undefined || nextCursor === "" ? undefined : nextCursor };
    });
  }
}

/** NSID collection shape: dot-separated non-empty segments. */
function validateCollection(collection: string): string {
  if (collection === "" || collection.includes(" ") || !collection.includes(".")) {
    throw new TangledAtprotoError("config", `collection must be a dotted NSID, got: ${collection}`);
  }
  return collection;
}

/** Internal signal: an authenticated call came back expired so the retry
 * path in `withSession` can distinguish it from any other failure. */
class ExpiredResponse extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(status: number, data: unknown) {
    super(`expired session response (HTTP ${status})`);
    this.name = "ExpiredResponse";
    this.status = status;
    this.data = data;
  }
}
