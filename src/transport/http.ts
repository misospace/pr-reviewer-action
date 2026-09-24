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
 */

export type TransportFailureKind = "connect_timeout" | "request_timeout" | "network" | "http_status";

export class TransportFailure extends Error {
  readonly kind: TransportFailureKind;
  readonly status?: number;
  /** Preserved response body for http_status failures (never truncated). */
  readonly body?: string;

  constructor(kind: TransportFailureKind, message: string, options: { status?: number; body?: string; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "TransportFailure";
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.body !== undefined) this.body = options.body;
  }
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
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 0;
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
