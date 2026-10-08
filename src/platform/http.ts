import { USER_AGENT } from "./user-agent.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class PlatformRequestError extends Error {
  readonly status: number | null;
  readonly kind: string;

  constructor(message: string, status: number | null = null, kind = "request-failed") {
    super(message);
    this.name = "PlatformRequestError";
    this.status = status;
    this.kind = kind;
  }
}

export interface RequestOptions {
  method?: string | undefined;
  /** Pre-formatted Authorization header value (e.g. "Bearer x" / "token x"). */
  token?: string | undefined;
  accept?: string | undefined;
  body?: string | undefined;
  contentType?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: FetchLike | undefined;
  /** The only origin that may receive the Authorization header. */
  allowedOrigin: string;
}

function buildHeaders(opts: RequestOptions, withAuth: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: opts.accept ?? "application/json",
  };
  if (withAuth && opts.token) headers.Authorization = opts.token;
  if (opts.body !== undefined) headers["Content-Type"] = opts.contentType ?? "application/json";
  return headers;
}

export interface BytesRequestOptions extends Omit<RequestOptions, "body"> {
  /** Hard cap on the total body size in bytes. */
  maxBytes: number;
}

/**
 * Single transport for both platform adapters (#674).
 *
 * Security policy (the #670/#682 SSRF boundary, made explicit):
 * - the target origin must equal `allowedOrigin`, the adapter's validated
 *   platform base — a credential is bound to the origin it was configured
 *   for and is never attached to any other origin;
 * - redirects are never followed (`redirect: "manual"`). A 3xx is an error:
 *   tokens cannot cross origins, and the v2 curl transport also refuses to
 *   follow redirects, so this is fail-closed parity.
 */
export async function requestText(url: string, opts: RequestOptions): Promise<{ status: number; text: string; headers: Headers }> {
  const target = new URL(url);
  if (target.origin !== opts.allowedOrigin) {
    throw new PlatformRequestError(
      `Refusing to send a request to an origin outside the validated platform base (${target.origin} != ${opts.allowedOrigin})`,
      null,
      "origin-mismatch",
    );
  }
  const headers = buildHeaders(opts, true);
  // CodeQL js/file-access-to-http: `opts.body` is an in-memory string built
  // by the platform adapters from typed values (issue comments, review
  // bodies, marker text) — no read-from-disk value reaches it on any path;
  // the origin/redirect policy above is the actual security boundary here.
  const doFetch = opts.fetchImpl ?? fetch;
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
  };
  if (opts.body !== undefined) init.body = opts.body;
  let response: Response;
  try {
    response = await doFetch(target, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PlatformRequestError(`Platform request failed: ${message}`, null, "transport");
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "unknown";
    throw new PlatformRequestError(
      `Redirect blocked (${response.status} -> ${location}); credentials are never forwarded to another origin`,
      response.status,
      "redirect-blocked",
    );
  }
  return { status: response.status, text: await response.text(), headers: response.headers };
}

/**
 * Binary GET sibling of `requestText` (#586) for raw-byte endpoints such as
 * `application/octet-stream` PDS blob downloads. Same security policy as
 * `requestText`: the origin must equal `allowedOrigin`, the credential is
 * only ever the Authorization header bound to that origin, redirects are
 * refused, and the default timeout is the same. The body is read through
 * the stream with a hard `maxBytes` cap (see `readCappedBody`), so an
 * oversized or hostile response can never be buffered unboundedly.
 *
 * Like `requestText`, non-2xx statuses are returned as `{ status, bytes }`
 * with the body read the same capped way, so the caller maps the status.
 */
export async function requestBytes(url: string, opts: BytesRequestOptions): Promise<{ status: number; bytes: Uint8Array }> {
  const target = new URL(url);
  if (target.origin !== opts.allowedOrigin) {
    throw new PlatformRequestError(
      `Refusing to send a request to an origin outside the validated platform base (${target.origin} != ${opts.allowedOrigin})`,
      null,
      "origin-mismatch",
    );
  }
  const headers = buildHeaders(opts, true);
  const doFetch = opts.fetchImpl ?? fetch;
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
  };
  let response: Response;
  try {
    response = await doFetch(target, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PlatformRequestError(`Platform request failed: ${message}`, null, "transport");
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "unknown";
    throw new PlatformRequestError(
      `Redirect blocked (${response.status} -> ${location}); credentials are never forwarded to another origin`,
      response.status,
      "redirect-blocked",
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await readCappedBody(response, opts.maxBytes);
  } catch (error) {
    if (error instanceof PlatformRequestError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new PlatformRequestError(`Platform request body read failed: ${message}`, response.status, "transport");
  }
  return { status: response.status, bytes };
}

/**
 * Reads `response.body` chunk by chunk with a hard cap. The moment the
 * running total would exceed `maxBytes` (strictly greater — a body of
 * exactly `maxBytes` bytes is fine) the stream is cancelled and a
 * `PlatformRequestError` of kind "too-large" is thrown, so the cap is
 * enforced as the bytes arrive rather than after an unbounded read. An
 * absent (null) body is an empty payload; a non-2xx body is read the same
 * capped way so error responses can never blow past the budget either.
 */
async function readCappedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk: Uint8Array = result.value ?? new Uint8Array(0);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PlatformRequestError(
          `Response body exceeds the ${maxBytes}-byte cap (at least ${total} bytes received)`,
          response.status,
          "too-large",
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function requestJson(url: string, opts: RequestOptions): Promise<{ status: number; data: unknown }> {
  const { status, text } = await requestText(url, opts);
  try {
    return { status, data: JSON.parse(text) as unknown };
  } catch {
    throw new PlatformRequestError(`Platform returned invalid JSON (status ${status})`, status, "invalid-json");
  }
}
