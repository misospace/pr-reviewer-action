import http from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import { URL } from "node:url";
import type { ApiFormat } from "../model/types.js";
import { maskKnownSecrets, redactText } from "../context/redact.js";
import { applyExtraHeaders, basicAuthorizationHeaderValue } from "./headers.js";
import { isContentBearingSseFrame } from "./sse.js";
import type { TransportTiming } from "./timing.js";

/**
 * Typed HTTP transport for model calls (#677). Replaces the v2 curl/jq wire
 * path with one typed contract: no shell curl request construction, no
 * secrets in argv (headers only, and never echoed in errors), typed
 * transport errors usable by routing/fallback logic.
 *
 * Timeout policy mirrors the v2 curl flags:
 * - `connectTimeoutSec` bounds the TCP/TLS connect phase only (curl
 *   --connect-timeout).
 * - `requestTimeoutSec` bounds the whole request (curl --max-time).
 *
 * Divergences from v2 curl, deliberate and documented: redirects are never
 * followed — any terminal status outside 2xx (including a 3xx redirect, and
 * 4xx/5xx errors) is a typed http_status failure with the body preserved,
 * exactly like v2's `curl` exit-22 path, so a "context length exceeded"
 * body survives.
 *
 * Response-byte ceiling (#745): receipt is bounded by bytes as well as time.
 * Every response — successful non-streamed, streamed/SSE, and non-2xx error
 * bodies — is counted in received bytes as chunks arrive; once the byte
 * budget (`DEFAULT_MAX_RESPONSE_BYTES`, overridable per call via
 * `maxResponseBytes`) is exceeded, the request is destroyed immediately and
 * a typed `response_too_large` failure is returned. The cap sits below the
 * SSE reassembler, so an oversized body never reaches `sse.ts`. The budget
 * counts actual received bytes (Buffers, UTF-8-safe across chunk
 * boundaries), never decoded string lengths, and no Content-Length
 * pre-check is used: byte counting is the only authority, so a lying
 * header cannot bypass it.
 */

export type TransportFailureKind =
  | "connect_timeout"
  | "request_timeout"
  | "network"
  | "http_status"
  | "response_too_large"
  // #726: the caller's own cancellation AbortSignal fired (#725 worker
  // lifecycle). Distinct from a timeout so retry/fallback policy never treats
  // an operator cancellation as a transient upstream hiccup.
  | "cancelled";

/**
 * Finite response-byte ceiling for model calls (#745). The timeout bounds
 * duration, not bytes, so an endless or hostile endpoint could otherwise
 * buffer unboundedly before the deadline fires. 32 MiB leaves roughly an
 * order of magnitude of headroom above any legitimate model response — a
 * 1M-token completion is a few MiB of raw text at most, and SSE protocol
 * framing adds only overhead — while capping worst-case buffering at a
 * bounded allocation. Provider-agnostic by design: no model- or
 * vendor-specific limit. Not a public Action input; callers (the #678
 * orchestrator) may override per call via `maxResponseBytes`.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Bounded diagnostic prefix retained from an oversized non-2xx body (#745):
 * provider error text that arrived early (e.g. a context-length message)
 * stays available for routing/retry diagnostics without retaining the
 * oversized body. Truncation is always made explicit in the carried body.
 */
export const OVERSIZE_ERROR_BODY_PREFIX_BYTES = 2048;

const OVERSIZE_BODY_MARKER =
  "…[error body truncated: response exceeded the transport response-byte limit]";

export class TransportFailure extends Error {
  readonly kind: TransportFailureKind;
  readonly status?: number;
  /**
   * Preserved response body: the full body for http_status failures (never
   * truncated), or a bounded prefix plus an explicit truncation marker for
   * oversized non-2xx bodies (#745).
   */
  readonly body?: string;
  /** Configured response-byte ceiling (#745, response_too_large only). */
  readonly maxResponseBytes?: number;
  /** Bytes observed before the abort, including the chunk that crossed the limit. */
  readonly bytesReceived?: number;
  /** `Retry-After` in seconds when the response carried a numeric one (http_status only). */
  readonly retryAfterSec?: number;

  constructor(
    kind: TransportFailureKind,
    message: string,
    options: {
      status?: number;
      body?: string;
      maxResponseBytes?: number;
      bytesReceived?: number;
      retryAfterSec?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "TransportFailure";
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.body !== undefined) this.body = options.body;
    if (options.retryAfterSec !== undefined) this.retryAfterSec = options.retryAfterSec;
    if (options.maxResponseBytes !== undefined) this.maxResponseBytes = options.maxResponseBytes;
    if (options.bytesReceived !== undefined) this.bytesReceived = options.bytesReceived;
  }
}

/** #846: a 404 from the completions/messages path is most often a wrong
 * `ai-api-format` (routed to an endpoint that doesn't serve the requested
 * API shape) rather than a dead endpoint — point at the fix instead of
 * leaving the operator to guess from a bare status code. */
const API_FORMAT_404_HINT = "check ai-api-format for this model (openai vs anthropic)";

export interface DescribeTransportFailureOptions {
  maxBodyChars?: number;
  /** The operator-configured model API key(s) relevant to this call (e.g.
   * the tier's `profile.apiKey`) — masked unconditionally, in addition to
   * (and before) `redactText`'s heuristics, since a provider echoing the
   * literal key in prose (no `key=`/`Bearer ` framing) would otherwise pass
   * every heuristic pattern untouched. See `maskKnownSecrets`. */
  secrets?: readonly (string | null | undefined)[];
}

/**
 * A short, secret-redacted, length-capped detail string for a
 * `TransportFailure`, suitable for logs and error telemetry (#846):
 * `HTTP <status>: <redacted body excerpt>`, with the #846 hint appended on a
 * 404. Falls back to the bare `.message` for failure kinds that carry no
 * status/body (connect/request timeouts, network errors) — there is nothing
 * to excerpt there; `secrets` is still masked out of `.message` in that case.
 */
export function describeTransportFailure(failure: TransportFailure, options: DescribeTransportFailureOptions | number = {}): string {
  // Backward-compatible with the original `(failure, maxBodyChars)` shape.
  const resolved: DescribeTransportFailureOptions = typeof options === "number" ? { maxBodyChars: options } : options;
  const maxBodyChars = resolved.maxBodyChars ?? 300;
  const secrets = resolved.secrets ?? [];
  if (failure.status === undefined) return maskKnownSecrets(failure.message, secrets);
  // Known secrets are masked first, on the full untruncated body, so a
  // secret split across the truncation boundary is never partially exposed.
  const withoutKnownSecrets = maskKnownSecrets((failure.body ?? "").trim(), secrets);
  const redacted = redactText(withoutKnownSecrets);
  const points = Array.from(redacted);
  const body = points.length > maxBodyChars ? `${points.slice(0, maxBodyChars).join("")}...[truncated]` : redacted;
  const hint = failure.status === 404 ? ` — ${API_FORMAT_404_HINT}` : "";
  // A second, whole-string mask pass: a very short configured key (down to
  // one character, since ai-api-key has no minimum length) can coincide
  // with ordinary letters in the static "HTTP <status>"/hint text (e.g. the
  // 'k' in "check"), which the body-only pass above never touches.
  // Over-redacting a few incidental letters is an acceptable cost next to
  // ever leaking the credential.
  return maskKnownSecrets(`HTTP ${failure.status}${body ? `: ${body}` : ""}${hint}`, secrets);
}

function oversizeFailure(
  status: number,
  observed: number,
  maxResponseBytes: number,
  prefixChunks: Buffer[],
): TransportFailure {
  const options: {
    status?: number;
    body?: string;
    maxResponseBytes: number;
    bytesReceived: number;
  } = { maxResponseBytes, bytesReceived: observed };
  if (status !== 0) options.status = status;
  if (status < 200 || status >= 300) {
    // Non-2xx: preserve the bounded prefix plus an explicit truncation
    // marker. The full body is never retained (#745).
    options.body = `${Buffer.concat(prefixChunks).toString("utf8")}${OVERSIZE_BODY_MARKER}`;
  }
  return new TransportFailure(
    "response_too_large",
    `model response exceeded the ${maxResponseBytes}-byte response limit (received at least ${observed} bytes)`,
    options,
  );
}

/** Numeric `Retry-After` seconds; the HTTP-date form is ignored. */
export function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined;
  return Number(text);
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "ECONNABORTED", "ETIMEDOUT",
]);

export function classifySocketError(error: unknown): TransportFailure {
  if (error instanceof TransportFailure) return error;
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  if (code === "ETIMEDOUT") return new TransportFailure("request_timeout", "model request timed out", { cause: error });
  if (code !== "" && NETWORK_ERROR_CODES.has(code)) {
    return new TransportFailure("network", `model request failed (${code})`, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new TransportFailure("network", `model request failed: ${message}`, { cause: error });
}

export interface HttpCallInput {
  baseUrl: string;
  apiFormat: ApiFormat;
  /** Serialized JSON wire payload (never contains secrets). */
  bodyText: string;
  apiKey: string;
  anthropicVersion: string;
  requestTimeoutSec: number;
  connectTimeoutSec: number;
  stream: boolean;
  /** Response-byte ceiling; defaults to DEFAULT_MAX_RESPONSE_BYTES (#745). */
  maxResponseBytes?: number;
  /** #1037 (`ai-extra-headers`): operator headers merged into every request
   * with case-preserved names. Validated at startup and revalidated at the
   * wire boundary (`applyExtraHeaders`) on the same rules — non-string value,
   * non-token name, control characters, non-latin-1 value, reserved-name
   * collision, case-insensitive duplicate, count bound — so a caller that
   * bypassed startup validation cannot outrank auth/framing headers nor reach
   * Node's request-time header check; absent/empty keeps the outbound headers
   * byte-for-byte unchanged. */
  extraHeaders?: Readonly<Record<string, string>>;
  /** #726 (engine cancellation): caller-owned abort. An already-aborted
   * signal rejects with a `cancelled` failure before any socket opens; an
   * abort mid-flight tears the socket down and rejects the same way.
   * Distinct from connect/request timeouts, which are transport-owned
   * deadlines. */
  signal?: AbortSignal;
}

export interface HttpCallResult {
  status: number;
  body: string;
  /** #1466: when this wire call was answered — the dispatch-to-first-byte,
   * dispatch-to-first-content, and dispatch-to-end measurements. Numbers
   * only; never prompt, response, or tool-argument content. */
  timing: TransportTiming;
}

/**
 * #1466: the streamed-body scan state. The scan is OBSERVATION ONLY: the
 * response body itself is buffered separately (under the response-byte
 * ceiling, #745) and reassembled by `reassembleSse` exactly as before, so
 * nothing in here can change WHAT the model answered — only WHEN its
 * bytes arrived.
 */
interface SseScanState {
  /** The decoded text not yet consumed by a complete line. */
  pending: string;
  /** Set when the pending buffer overflowed its ceiling: the scan stops,
   * the body is still buffered and reassembled in full. */
  disabled: boolean;
  /** The `data:` payloads of the frame currently being read. SSE joins
   * them with a newline into ONE payload, so they are collected until the
   * frame's blank line ends it. */
  frameData: string[];
  /** The UTF-8 byte size of the collected `data:` payloads — the bound that
   * actually caps the accumulator's memory. */
  frameBytes: number;
  /** Set when a frame exceeded a join bound (its line count or its byte
   * size): the frame is no longer joined (a partial join could parse as a
   * payload the provider never sent). */
  frameOverflow: boolean;
  /** The monotonic timestamp of the first content-bearing event, or null
   * when the stream carried none. */
  firstContentAt: number | null;
}

/**
 * #1466: the scan buffer's ceiling. A provider that streams a body with
 * no line terminator at all would otherwise grow this buffer without
 * bound; at the ceiling the pending buffer is dropped and the scan stops.
 * Nothing is lost by giving up on the probe: the response body is bounded
 * by the response-byte ceiling (#745) and is reassembled in full either
 * way.
 */
const MAX_SSE_SCAN_PENDING_CHARS = 1024 * 1024;

/**
 * #1466: the bound on the `data:` lines one frame may contribute to the
 * joined payload — a LINE count and a BYTE count.
 *
 * The byte bound is the one that caps the memory: a single `data:` line can
 * be as long as the scan's pending buffer allows (up to 1 MiB), so a
 * line-count bound alone still lets a hostile stream pin tens of megabytes
 * of joined payload. The line bound stays as a cheap second gate.
 *
 * Past either bound the frame's joined payload is dropped — a partial join
 * could parse as a payload the provider never sent — and the scan carries
 * on with the next frame.
 *
 * The scan's real memory bound is the response-byte ceiling (#745) plus
 * these frame bounds: the response body itself is buffered under #745 and
 * reassembled in full either way, so nothing is lost by giving up on the
 * probe.
 */
const MAX_SSE_FRAME_DATA_LINES = 64;

/** #1466: the byte ceiling for ONE frame's joined `data:` payload. */
const MAX_SSE_FRAME_DATA_BYTES = 64 * 1024;

/**
 * #1466: one SSE payload counts as content when the wire format says so.
 * The classification itself lives in the SSE module, so the transport and
 * the reassembler agree on what "content" means.
 */
function noteSseDataPayload(state: SseScanState, payload: string, apiFormat: string): void {
  if (state.firstContentAt !== null) return;
  if (payload === "" || payload === "[DONE]") return;
  if (!isContentBearingSseFrame(payload, apiFormat)) return;
  state.firstContentAt = performance.now();
}

/**
 * #1466: collect one frame's `data:` payload.
 *
 * The byte ceiling is the bound that caps the memory and the line count is
 * a cheap second gate. Past either the frame's joined payload is dropped —
 * a partial join could parse as a payload the provider never sent — and the
 * scan carries on with the next frame.
 */
function pushFrameData(state: SseScanState, payload: string): void {
  if (state.frameOverflow) return;
  const bytes = Buffer.byteLength(payload, "utf8");
  if (state.frameData.length >= MAX_SSE_FRAME_DATA_LINES || state.frameBytes + bytes > MAX_SSE_FRAME_DATA_BYTES) {
    state.frameOverflow = true;
    state.frameData = [];
    state.frameBytes = 0;
    return;
  }
  state.frameData.push(payload);
  state.frameBytes += bytes;
}

/**
 * #1466: the end of an SSE frame (its blank line). The frame's `data:`
 * lines form ONE payload — joined with a newline, as SSE prescribes — so
 * the joined form is inspected too: a provider whose data field spans
 * several lines carries a payload no single line holds.
 */
function flushSseFrame(state: SseScanState, apiFormat: string): void {
  const lines = state.frameData;
  const overflowed = state.frameOverflow;
  state.frameData = [];
  state.frameBytes = 0;
  state.frameOverflow = false;
  if (overflowed || lines.length === 0) return;
  if (lines.length === 1) {
    // A single-line frame's payload was already inspected when the line
    // was read.
    return;
  }
  noteSseDataPayload(state, lines.join("\n"), apiFormat);
}

/**
 * #1466: consume one decoded chunk of a streamed body.
 *
 * The scanner walks the text LINE by line — the SSE blank line is the
 * frame boundary and a `data:` line inside a frame is one payload — which
 * is exactly how the reassembler in `sse.ts` reads the same bytes, so the
 * two agree on what a content-bearing event is. Each `data:` line is
 * inspected as it arrives (a provider that ends its event lines with a
 * single LF never reaches a frame boundary), and the frame's joined
 * payload is inspected when the frame ends.
 */
function scanSseChunk(state: SseScanState, text: string, apiFormat: string): void {
  if (state.disabled) return;
  state.pending += text;
  if (state.pending.length > MAX_SSE_SCAN_PENDING_CHARS) {
    state.disabled = true;
    state.pending = "";
    state.frameData = [];
    state.frameBytes = 0;
    state.frameOverflow = false;
    return;
  }
  let cursor = 0;
  while (cursor < state.pending.length) {
    const newline = state.pending.indexOf("\n", cursor);
    if (newline === -1) break;
    const line = state.pending.slice(cursor, newline).trim();
    cursor = newline + 1;
    if (line === "") {
      // The frame boundary.
      flushSseFrame(state, apiFormat);
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "") continue;
    pushFrameData(state, payload);
    noteSseDataPayload(state, payload, apiFormat);
  }
  state.pending = state.pending.slice(cursor);
}

/**
 * #1466: the end-of-response flush. The decoder may still hold bytes and
 * the last line may arrive without its terminator; both are inspected
 * once, at the end, so a trailing event is not missed.
 */
function flushSseScan(state: SseScanState, apiFormat: string, tail: string): void {
  if (state.disabled) return;
  const rest = `${state.pending}${tail}`.trim();
  state.pending = "";
  if (rest !== "" && rest.startsWith("data:")) {
    const payload = rest.slice(5).trim();
    if (payload !== "") {
      pushFrameData(state, payload);
      noteSseDataPayload(state, payload, apiFormat);
    }
  }
  flushSseFrame(state, apiFormat);
}

/**
 * Endpoint join: trailing slashes are stripped before the protocol path is
 * appended (the v2 Python transport's rule; v2 bash appended verbatim, which
 * produced `//chat/completions` for slash-suffixed base URLs).
 *
 * #1428: the endpoint resolution also owns the URL-credential channel. An
 * endpoint URL may carry a credential in its userinfo
 * (`https://user:pass@host`), and a credential must never ride in a request
 * URL: the userinfo is resolved out of the request target into the HTTP
 * Basic channel (RFC 7617 — Basic is the scheme for URL userinfo, the same
 * rule the judge tooling applies), and the resolved URL stays byte-identical
 * to the pre-#1428 target for every credential-free endpoint. The fail-closed
 * refusal shapes mirror `pr_reviewer/http_safe.resolve_endpoint` (#1414):
 * an encoded `@` hidden in the authority, and an `@` outside the authority
 * (raw or encoded, where a password carrying an unencoded `/` ends the
 * authority early) are refused instead of being attributed to a channel.
 */
export interface ResolvedEndpointChannel {
  /** The credential-free request target. */
  url: URL;
  /** The decoded userinfo credential the endpoint URL carried; `""` when none. */
  urlCredential: string;
}

/** Lenient percent-decoding, one escape at a time — the treatment
 * `urllib.parse.unquote` gives the userinfo it decodes: a valid escape
 * becomes its byte, an invalid escape sequence stays literal, and the
 * resulting bytes decode as UTF-8 with replacement (never fatal). Iterated
 * by code point so a non-BMP character sharing a segment with an escape
 * survives intact. */
function lenientUrlDecode(raw: string): string {
  if (!raw.includes("%")) return raw;
  const bytes: number[] = [];
  let i = 0;
  while (i < raw.length) {
    const escape = raw.slice(i + 1, i + 3);
    if (raw[i] === "%" && /^[0-9a-fA-F]{2}$/.test(escape)) {
      bytes.push(Number.parseInt(escape, 16));
      i += 3;
      continue;
    }
    const char = String.fromCodePoint(raw.codePointAt(i)!);
    bytes.push(...Buffer.from(char, "utf8"));
    i += char.length;
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

function splitEndpointUserinfo(trimmed: string): { base: string; credential: string } {
  const schemeEnd = trimmed.indexOf("://");
  if (schemeEnd < 0) return { base: trimmed, credential: "" };
  const rest = trimmed.slice(schemeEnd + 3);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  const after = authorityEnd < 0 ? "" : rest.slice(authorityEnd);
  const at = authority.lastIndexOf("@");
  if (at < 0) {
    // An encoded `@` hides the userinfo from the authority split; refuse the
    // ambiguous shape instead of guessing where the credential ends.
    if (lenientUrlDecode(authority).includes("@")) {
      throw new Error("the endpoint URL carries an encoded credential");
    }
    // An `@` outside the authority cannot be attributed to a userinfo: a
    // password carrying an unencoded `/` ends the authority early, so the
    // userinfo would land in the request target. Refuse rather than send it
    // (#1419), raw or percent-encoded.
    if (after.includes("@") || lenientUrlDecode(after).includes("@")) {
      throw new Error("the endpoint URL carries a credential outside its authority");
    }
    return { base: trimmed, credential: "" };
  }
  const userinfo = authority.slice(0, at);
  const host = authority.slice(at + 1);
  if (host === "") throw new Error("the endpoint URL carries an unparseable credential");
  return {
    base: `${trimmed.slice(0, schemeEnd + 3)}${host}${after}`,
    // An empty userinfo (`https://@host`) carries no credential, exactly like
    // the shared resolver's `if userinfo else None`.
    credential: userinfo === "" ? "" : lenientUrlDecode(userinfo),
  };
}

/**
 * The credential a base URL carries in its userinfo, decoded and resolved out
 * of the request target (#1428); `""` when the URL carries none. Fail-closed:
 * a URL whose credential cannot be attributed throws instead of being used.
 */
export function endpointUrlCredential(baseUrl: string): string {
  return splitEndpointUserinfo(baseUrl.trim().replace(/\/+$/, "")).credential;
}

/** The URL credential as a masking VALUE, `""` when the URL carries none or
 * its shape cannot be attributed (#1428). The hostile fail-closed shapes are
 * owned by the structural redaction below, never echoed as a value. */
export function endpointUrlCredentialOrEmpty(baseUrl: string): string {
  try {
    return endpointUrlCredential(baseUrl);
  } catch {
    return "";
  }
}

/** The endpoint URL as a diagnostic may carry it (#1428): any credential the
 * URL holds in its userinfo is structurally removed, so interpolating a
 * resolved base URL into a log line or persisted artifact can never echo the
 * credential. A credential-free URL passes through byte-for-byte; a URL whose
 * credential cannot be attributed is replaced wholesale (fail closed — a
 * shape the transport would refuse is never echoed either). The placeholder
 * carries no whitespace so the `publicAnalysisEngine` URL-token strip still
 * removes it whole (#832). */
export function redactEndpointUrlCredential(baseUrl: string): string {
  try {
    const stripped = splitEndpointUserinfo(baseUrl.trim().replace(/\/+$/, ""));
    return stripped.credential === "" ? baseUrl : stripped.base;
  } catch {
    return "<redacted-endpoint-URL>";
  }
}

export function resolveEndpointChannel(baseUrl: string, apiFormat: ApiFormat): ResolvedEndpointChannel {
  const stripped = splitEndpointUserinfo(baseUrl.trim().replace(/\/+$/, ""));
  const path = apiFormat === "anthropic" ? "/messages" : "/chat/completions";
  return { url: new URL(`${stripped.base}${path}`), urlCredential: stripped.credential };
}

export function resolveEndpoint(baseUrl: string, apiFormat: ApiFormat): URL {
  return resolveEndpointChannel(baseUrl, apiFormat).url;
}

/** The message the one-credential refusal carries, shared with the specialist
 * transport gate's pre-flight so both boundaries name the same rule. */
export const CREDENTIAL_CHANNEL_CONFLICT_MESSAGE =
  "the endpoint URL carries a credential and a separate model credential is configured; one request carries one credential";

/** One request carries one credential: a credential in the endpoint URL's
 * userinfo and a separate API key are two channels for one request, and
 * honoring both would drop one of them silently. Refused before any request. */
export function assertSingleCredentialChannel(urlCredential: string, apiKey: string): void {
  if (urlCredential !== "" && apiKey !== "") throw new Error(CREDENTIAL_CHANNEL_CONFLICT_MESSAGE);
}

export async function runHttpRequest(input: HttpCallInput): Promise<HttpCallResult> {
  const { url, urlCredential } = resolveEndpointChannel(input.baseUrl, input.apiFormat);
  const secure = url.protocol === "https:";
  const transport = secure ? https : http;
  const maxResponseBytes = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  // #726: one cancellation shape for "already aborted" and "aborts later",
  // so callers classify both the same way.
  const cancelledFailure = (): TransportFailure =>
    new TransportFailure("cancelled", "model request cancelled");
  // #1428: the credential-channel conflict is refused before anything else —
  // no socket, no header work, no provider attempt.
  assertSingleCredentialChannel(urlCredential, input.apiKey);
  if (input.signal?.aborted) return Promise.reject(cancelledFailure());

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (urlCredential !== "") {
    // #1428: a credential that came from the endpoint URL's userinfo travels
    // as HTTP Basic (RFC 7617), for both wire formats — the URL channel owns
    // the request, so the separate-key channels (Bearer, x-api-key) stay out.
    // Only the credential channel changes: the Anthropic framing headers are
    // not a credential channel, so an Anthropic endpoint keeps
    // `anthropic-version` and the streamed Accept header here too.
    // The value comes from the shared builder so `callKnownSecrets` masks
    // exactly these bytes (see its doc comment) — the two sites cannot drift.
    headers["Authorization"] = basicAuthorizationHeaderValue(urlCredential);
    if (input.apiFormat === "anthropic") {
      headers["anthropic-version"] = input.anthropicVersion;
      if (input.stream) headers["Accept"] = "text/event-stream";
    }
  } else if (input.apiFormat === "anthropic") {
    headers["anthropic-version"] = input.anthropicVersion;
    if (input.apiKey !== "") headers["x-api-key"] = input.apiKey;
    if (input.stream) headers["Accept"] = "text/event-stream";
  } else if (input.apiKey !== "") {
    headers["Authorization"] = `Bearer ${input.apiKey}`;
  }
  // #1037: merged after the action's own headers. `applyExtraHeaders` throws on
  // the whole set before writing anything — reserved-name collision, malformed
  // or non-token name, control characters or non-latin-1 characters in a value,
  // a case-insensitive duplicate, or more than MAX_EXTRA_HEADERS entries — so a
  // caller that bypassed the startup validator still cannot outrank
  // auth/framing headers, and a rejected set merges nothing at all.
  if (input.extraHeaders !== undefined) applyExtraHeaders(headers, input.extraHeaders);

  return new Promise<HttpCallResult>((resolve, reject) => {
    let settled = false;
    let connectTimer: NodeJS.Timeout | null = null;
    let requestTimer: NodeJS.Timeout | null = null;
    let timedOut = false;
    let connectTimedOut = false;
    let cancelListener: (() => void) | null = null;
    // #1466: the dispatch instant every timing measurement is measured
    // FROM — set where the request body is actually sent (below). It is a
    // monotonic clock, so a wall-clock adjustment mid-call cannot make a
    // duration negative or absurd.
    let dispatchedAt = 0;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (requestTimer) clearTimeout(requestTimer);
      // #726: no abort listener survives a settled call on a long-lived
      // caller signal (a worker runs many requests on one scope).
      if (cancelListener) input.signal?.removeEventListener("abort", cancelListener);
      fn();
    };

    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        // CodeQL js/file-access-to-http: the body is `payload.body`, built
        // in memory by buildModelRequest from the typed config (model,
        // system prompt, corpus string). No file-read value reaches this
        // call site; the endpoint origin is the operator-configured
        // ai_base_url, and the API key rides the in-memory headers only.
        headers,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        // Bounded diagnostic prefix, accumulated independently so an
        // oversized body can be abandoned without retaining it (#745).
        const prefixChunks: Buffer[] = [];
        let prefixBytes = 0;
        let received = 0;
        let abandoned = false;
        // #1466: the timing probe's own state. `firstByteAt` is the first
        // response body byte; the scan state carries the first
        // content-bearing event's instant. Both are null until they
        // happen — a null never stands in for a zero.
        let firstByteAt: number | null = null;
        const scanState: SseScanState = { pending: "", disabled: false, frameData: [], frameBytes: 0, frameOverflow: false, firstContentAt: null };
        // #1466: the multi-byte-safe decoder for the observation scan — a
        // chunk boundary must never split a character.
        const decoder = new StringDecoder("utf8");

        response.on("data", (chunk: Buffer) => {
          if (abandoned) return;
          if (firstByteAt === null) firstByteAt = performance.now();
          // #1466: the scan is observation only — the body is buffered
          // below exactly as before, and the reassembly is unchanged.
          if (input.stream) scanSseChunk(scanState, decoder.write(chunk), input.apiFormat);
          // Bounded diagnostic prefix first: it is capped at
          // OVERSIZE_ERROR_BODY_PREFIX_BYTES regardless of outcome, so it is
          // always safe to retain — including from the chunk that crosses
          // the limit (a one-chunk error body still keeps its prefix).
          if (prefixBytes < OVERSIZE_ERROR_BODY_PREFIX_BYTES) {
            // Copy, don't subarray: a subarray would pin the parent chunk
            // buffer alive after the body is abandoned.
            const take = Math.min(chunk.length, OVERSIZE_ERROR_BODY_PREFIX_BYTES - prefixBytes);
            prefixChunks.push(Buffer.from(chunk.subarray(0, take)));
            prefixBytes += take;
          }
          if (received + chunk.length > maxResponseBytes) {
            // Byte budget exceeded mid-receipt: latch the typed failure,
            // drop the accumulated body (only the bounded prefix survives),
            // and tear the request down immediately. Destroyed without a
            // synthetic error so no later socket failure can race this
            // one; settle() has already latched, so any subsequent
            // error/close events on the request or response no-op.
            abandoned = true;
            chunks.length = 0;
            const observed = received + chunk.length;
            settle(() => reject(oversizeFailure(status, observed, maxResponseBytes, prefixChunks)));
            request.destroy();
            return;
          }
          received += chunk.length;
          chunks.push(chunk);
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          // #1466: the end instant is captured AFTER the end-of-response
          // flush: the flush can discover the first content event (a last
          // frame that arrived without its blank line), and a content event
          // stamped after the response end would make `firstContentSec`
          // exceed `totalSec`.
          if (input.stream) flushSseScan(scanState, input.apiFormat, decoder.end());
          const endedAt = performance.now();
          // #1466: the timing of THIS wire call, measured from the
          // dispatch. A non-streamed call has no content event on the
          // wire, so its `firstContentSec` stays null.
          const timing: TransportTiming = {
            firstEventSec: firstByteAt === null ? null : (firstByteAt - dispatchedAt) / 1000,
            firstContentSec: scanState.firstContentAt === null ? null : (scanState.firstContentAt - dispatchedAt) / 1000,
            totalSec: (endedAt - dispatchedAt) / 1000,
          };
          if (status < 200 || status >= 300) {
            const retryAfterSec = parseRetryAfter(response.headers["retry-after"]);
            settle(() => reject(new TransportFailure("http_status", `model endpoint returned HTTP ${status}`, {
              status,
              body,
              ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
            })));
            return;
          }
          settle(() => resolve({ status, body, timing }));
        });
        response.on("error", (error: unknown) => settle(() => reject(classifySocketError(error))));
      },
    );

    // #726: the caller's cancellation tears the socket down and latches the
    // typed rejection. Destroyed without a synthetic error, mirroring the
    // oversize path: settle() has already latched, so the resulting socket
    // events no-op. AbortSignal does not replay an abort to listeners added
    // later, so the post-registration check covers an abort landing between
    // the entry check and here.
    if (input.signal) {
      cancelListener = (): void => {
        settle(() => reject(cancelledFailure()));
        request.destroy();
      };
      input.signal.addEventListener("abort", cancelListener, { once: true });
      if (input.signal.aborted) cancelListener();
    }

    request.on("socket", (socket) => {
      // Connect phase: bound by connectTimeoutSec, cleared once the
      // TCP (and TLS) handshake completes.
      if (socket.connecting) {
        connectTimer = setTimeout(() => {
          connectTimedOut = true;
          request.destroy(new TransportFailure("connect_timeout", "model endpoint connect timed out"));
        }, Math.max(0, input.connectTimeoutSec * 1000));
        socket.once("connect", () => {
          if (connectTimer) clearTimeout(connectTimer);
        });
        socket.once("secureConnect", () => {
          if (connectTimer) clearTimeout(connectTimer);
        });
      }
    });

    request.on("error", (error: unknown) => {
      if (connectTimedOut) {
        settle(() => reject(new TransportFailure("connect_timeout", "model endpoint connect timed out", { cause: error })));
        return;
      }
      if (timedOut) {
        settle(() => reject(new TransportFailure("request_timeout", "model request timed out", { cause: error })));
        return;
      }
      settle(() => reject(classifySocketError(error)));
    });

    // Whole-request deadline (curl --max-time), absolute rather than idle.
    requestTimer = setTimeout(() => {
      timedOut = true;
      request.destroy(new TransportFailure("request_timeout", "model request timed out"));
    }, Math.max(0, input.requestTimeoutSec * 1000));

    // #1466: the dispatch instant — the request body goes out here, so
    // every timing measurement is measured from here.
    dispatchedAt = performance.now();
    request.end(input.bodyText);
  });
}
