/**
 * #1628: bounded, content-free classification of a DISCARDED streamed native
 * loop attempt.
 *
 * A loop turn whose streamed call came back unusable is retried once
 * non-streamed (#637) — but until #1628 the run could not say WHY the first
 * attempt was discarded, or how long it spent before it died: two ~125s
 * discarded attempts and two ~1s ones both persisted as `streamed_fallback:
 * true` plus one round total. This module turns each discarded attempt into
 * one bounded record: a closed reason enum, the HTTP status when the failure
 * carried one, the attempt's own elapsed time, how far the wire got before it
 * failed (first byte / first content event, null when never observed or not
 * measurable), the retry's elapsed time, and the route identity that made the
 * call (primary | smart | fallback).
 *
 * Content-free BY CONSTRUCTION, like every other artifact this loop persists:
 * every field is a number, a boolean, or one of this module's own enum
 * tokens. No URL, no response text, no tool arguments, no provider error
 * body, and no credential can ever ride a `StreamedAttemptFailureRecord` —
 * the classifiers never read bodies, only shapes.
 */

import { TransportFailure } from "../transport/http.js";
import { readSseReassemblyQuality } from "../transport/sse.js";
import { readTransportTiming } from "../transport/timing.js";
import { extractToolCalls } from "./loop.js";

/**
 * Why one streamed loop attempt was discarded. A closed enum:
 * - `http_status` — the endpoint answered with a non-2xx status (the status
 *   rides the record; 524-shaped gateway timeouts land here).
 * - `transport_timeout` — connect or whole-request deadline fired. The
 *   ambiguous idle case: the record's null first-event fields say "never
 *   observed", which is NOT proof of where the timeout came from.
 * - `connection_closed` — the socket/network died (a closed SSE connection
 *   mid-stream is the observed shape).
 * - `cancelled` — the run's own cancellation fired; no retry is justified.
 * - `sse_malformed` — a 200 body whose SSE framing was malformed, truncated,
 *   or never terminated (including a response abandoned over the byte cap).
 * - `provider_error_object` — a 200 whose reassembled body carries a
 *   provider error object (mid-stream `error` event or adopted plain body).
 * - `empty_completion` — a well-formed terminated stream that carried no
 *   text and no tool call at all.
 * - `unknown` — a failure the seam could not attribute (e.g. a transport
 *   adapter that threw an untyped error).
 */
export type StreamedAttemptFailureReason =
  | "http_status"
  | "transport_timeout"
  | "connection_closed"
  | "cancelled"
  | "sse_malformed"
  | "provider_error_object"
  | "empty_completion"
  | "unknown";

export const STREAMED_ATTEMPT_FAILURE_REASONS: ReadonlySet<string> = new Set<string>([
  "http_status", "transport_timeout", "connection_closed", "cancelled",
  "sse_malformed", "provider_error_object", "empty_completion", "unknown",
]);

/**
 * The PROVEN terminal classes: the attempt observed its own end on the wire
 * (a status response, a closed connection, a malformed/truncated terminal
 * body). For these the non-streamed recovery must NOT restart a full turn
 * timeout — the pair of attempts is bounded by ONE turn timeout, so a late
 * retry can never add a second full wait past the budget (#1628). The
 * ambiguous classes (`transport_timeout` with nothing observed, empty or
 * unknown bodies) keep the configured deadline as their authority.
 */
export const TERMINAL_STREAMED_FAILURE_REASONS: ReadonlySet<StreamedAttemptFailureReason> = new Set<StreamedAttemptFailureReason>([
  "http_status", "connection_closed", "sse_malformed",
]);

/** The persisted record of one discarded streamed attempt (snake_case: it
 * rides the harness artifact verbatim inside the round telemetry). */
export interface StreamedAttemptFailureRecord {
  reason: StreamedAttemptFailureReason;
  /** The HTTP status when the failure carried one, else null. */
  status: number | null;
  /** Wall-clock seconds the discarded streamed attempt spent. */
  elapsed_sec: number;
  /** Seconds to the first response byte (null: never observed/measured). */
  first_event_sec: number | null;
  /** Seconds to the first content-bearing frame (null: never observed). */
  first_content_sec: number | null;
  /** Wall-clock seconds the non-streamed retry spent; null when the recovery
   * was never fired (a cancellation) or the payload failed closed. */
  retry_elapsed_sec: number | null;
  /** The route identity that made the call: "primary" | "smart" | "fallback"
   * (or a bounded token for a caller-supplied tier). */
  route: string;
}

/** What a classifier decides about one attempt, before the seam adds the
 * elapsed/retry/route fields it alone knows. */
export interface StreamedAttemptClassification {
  reason: StreamedAttemptFailureReason;
  status: number | null;
  first_event_sec: number | null;
  first_content_sec: number | null;
}

/**
 * Classify a streamed attempt that THREW. The production transport throws a
 * `TransportFailure` carrying its kind, status, and (since #1628) the wire
 * observation of how far the response got; an untyped error — a test fake or
 * an adapter outside the transport contract — classifies as `unknown` rather
 * than a guessed shape.
 */
export function classifyThrownStreamedAttempt(error: unknown): StreamedAttemptClassification {
  const timing = readTransportTiming(error);
  const firstEventSec = timing === null ? null : timing.firstEventSec;
  const firstContentSec = timing === null ? null : timing.firstContentSec;
  if (error instanceof TransportFailure) {
    switch (error.kind) {
      case "http_status":
        return { reason: "http_status", status: error.status ?? null, first_event_sec: firstEventSec, first_content_sec: firstContentSec };
      case "connect_timeout":
      case "request_timeout":
        return { reason: "transport_timeout", status: null, first_event_sec: firstEventSec, first_content_sec: firstContentSec };
      case "network":
        return { reason: "connection_closed", status: null, first_event_sec: firstEventSec, first_content_sec: firstContentSec };
      case "cancelled":
        return { reason: "cancelled", status: null, first_event_sec: firstEventSec, first_content_sec: firstContentSec };
      case "response_too_large":
        // Our own byte cap tore the response down mid-receipt: an OBSERVED
        // truncation, not a guess.
        return { reason: "sse_malformed", status: error.status ?? null, first_event_sec: firstEventSec, first_content_sec: firstContentSec };
    }
  }
  return { reason: "unknown", status: null, first_event_sec: null, first_content_sec: null };
}

/**
 * Classify a streamed 200 response the seam judges UNUSABLE, or return null
 * when the response is usable and the turn keeps it.
 *
 * "Unusable" is exactly the loop's own consumption view (#1628): a body with
 * a provider error object, or a streamed body that produced neither a tool
 * call nor any text (`extractToolCalls` is the SAME reader the loop uses to
 * decide the turn's content, so the seam can never discard a response the
 * loop would have consumed, nor keep one it could not).
 *
 * The malformed-vs-empty split comes from the #1628 reassembly-quality probe
 * the transport's SSE reassembler attaches: frames that did not parse, or a
 * stream that ended without its termination frame, are a reassembly failure;
 * a well-formed terminated stream with nothing in it is an empty completion.
 * A body without the probe (it did not come through `reassembleSse`) cannot
 * claim malformed framing, so it reads as an empty completion.
 */
export function classifyUnusableStreamedBody(body: unknown, apiFormat: string): StreamedAttemptClassification | null {
  const timing = readTransportTiming(body);
  const firstEventSec = timing === null ? null : timing.firstEventSec;
  const firstContentSec = timing === null ? null : timing.firstContentSec;
  const record = body !== null && typeof body === "object" ? body as Record<string, unknown> : null;
  if (record !== null && record.error !== undefined && record.error !== null) {
    return { reason: "provider_error_object", status: null, first_event_sec: firstEventSec, first_content_sec: firstContentSec };
  }
  const { calls, text } = extractToolCalls(body, apiFormat);
  if (calls.length > 0 || text !== "") return null;
  const quality = readSseReassemblyQuality(body);
  const reason: StreamedAttemptFailureReason =
    quality !== null && (quality.malformedFrames > 0 || !quality.sawTermination) ? "sse_malformed" : "empty_completion";
  return { reason, status: null, first_event_sec: firstEventSec, first_content_sec: firstContentSec };
}

/** A measured duration token: `12.3s`, or `-` for "not measured". */
function fmtSec(value: number | null): string {
  return value === null ? "-" : `${Math.max(0, value).toFixed(1)}s`;
}

/** A route token is one of the loop's tier names or a bounded slug — a
 * persisted/logged value, so it is validated on the way in, never trusted. */
const ROUTE_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;

/** Defensive re-read of a persisted record (null when malformed). Every
 * number is finite and non-negative, the reason is an enum member, and the
 * route is a bounded token — a hand-written or tampered artifact can never
 * smuggle prose into a log line built from one. */
export function sanitizeStreamedAttemptFailure(value: unknown): StreamedAttemptFailureRecord | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.reason !== "string" || !STREAMED_ATTEMPT_FAILURE_REASONS.has(v.reason)) return null;
  const dur = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) ? Math.max(0, x) : null;
  const elapsed = dur(v.elapsed_sec);
  if (elapsed === null) return null;
  const status = typeof v.status === "number" && Number.isFinite(v.status) ? Math.trunc(v.status) : null;
  const retry = dur(v.retry_elapsed_sec);
  const route = typeof v.route === "string" && ROUTE_TOKEN.test(v.route) ? v.route : "unknown";
  return {
    reason: v.reason as StreamedAttemptFailureReason,
    status,
    elapsed_sec: elapsed,
    first_event_sec: dur(v.first_event_sec),
    first_content_sec: dur(v.first_content_sec),
    retry_elapsed_sec: retry,
    route,
  };
}

/**
 * The concise log tokens for one discarded attempt:
 * `reason=http_status status=524 elapsed=133.1s first_event=0.4s
 * first_content=- retry=- route=primary`. Every value is a number or one of
 * this module's own tokens, so a log line built here cannot carry response
 * content, arguments, or credentials. The `status` token is omitted when the
 * failure carried none.
 */
export function formatStreamedAttemptFailure(rec: StreamedAttemptFailureRecord): string {
  const parts = [
    `reason=${rec.reason}`,
    ...(rec.status !== null ? [`status=${rec.status}`] : []),
    `elapsed=${fmtSec(rec.elapsed_sec)}`,
    `first_event=${fmtSec(rec.first_event_sec)}`,
    `first_content=${fmtSec(rec.first_content_sec)}`,
    `retry=${fmtSec(rec.retry_elapsed_sec)}`,
    `route=${rec.route}`,
  ];
  return parts.join(" ");
}
