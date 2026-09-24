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
export async function requestText(url: string, opts: RequestOptions): Promise<{ status: number; text: string }> {
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
  return { status: response.status, text: await response.text() };
}

export async function requestJson(url: string, opts: RequestOptions): Promise<{ status: number; data: unknown }> {
  const { status, text } = await requestText(url, opts);
  try {
    return { status, data: JSON.parse(text) as unknown };
  } catch {
    throw new PlatformRequestError(`Platform returned invalid JSON (status ${status})`, status, "invalid-json");
  }
}
