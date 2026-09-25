import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type { ApiFormat } from "../model/types.js";

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
  | "response_too_large";

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

  constructor(
    kind: TransportFailureKind,
    message: string,
    options: {
      status?: number;
      body?: string;
      maxResponseBytes?: number;
      bytesReceived?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "TransportFailure";
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.body !== undefined) this.body = options.body;
    if (options.maxResponseBytes !== undefined) this.maxResponseBytes = options.maxResponseBytes;
    if (options.bytesReceived !== undefined) this.bytesReceived = options.bytesReceived;
  }
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
}

export interface HttpCallResult {
  status: number;
  body: string;
}

/**
 * Endpoint join: trailing slashes are stripped before the protocol path is
 * appended (the v2 Python transport's rule; v2 bash appended verbatim, which
 * produced `//chat/completions` for slash-suffixed base URLs).
 */
export function resolveEndpoint(baseUrl: string, apiFormat: ApiFormat): URL {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const path = apiFormat === "anthropic" ? "/messages" : "/chat/completions";
  return new URL(`${trimmed}${path}`);
}

export async function runHttpRequest(input: HttpCallInput): Promise<HttpCallResult> {
  const url = resolveEndpoint(input.baseUrl, input.apiFormat);
  const secure = url.protocol === "https:";
  const transport = secure ? https : http;
  const maxResponseBytes = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (input.apiFormat === "anthropic") {
    headers["anthropic-version"] = input.anthropicVersion;
    if (input.apiKey !== "") headers["x-api-key"] = input.apiKey;
    if (input.stream) headers["Accept"] = "text/event-stream";
  } else if (input.apiKey !== "") {
    headers["Authorization"] = `Bearer ${input.apiKey}`;
  }

  return new Promise<HttpCallResult>((resolve, reject) => {
    let settled = false;
    let connectTimer: NodeJS.Timeout | null = null;
    let requestTimer: NodeJS.Timeout | null = null;
    let timedOut = false;
    let connectTimedOut = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (requestTimer) clearTimeout(requestTimer);
      fn();
    };

    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
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

        response.on("data", (chunk: Buffer) => {
          if (abandoned) return;
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
          if (status < 200 || status >= 300) {
            settle(() => reject(new TransportFailure("http_status", `model endpoint returned HTTP ${status}`, { status, body })));
            return;
          }
          settle(() => resolve({ status, body }));
        });
        response.on("error", (error: unknown) => settle(() => reject(classifySocketError(error))));
      },
    );

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

    request.end(input.bodyText);
  });
}
