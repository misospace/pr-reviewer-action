/**
 * #1466: the transport's timing probe — WHEN a provider answered, not WHAT
 * it answered.
 *
 * The probe exists because the Action's own diagnostics could not separate
 * "the provider was slow" from "the provider answered quickly and the
 * Action was slow afterwards": a streamed turn that reported `prompt=0`
 * (the MiniMax/LiteLLM Anthropic usage bug this issue also fixes) looked
 * exactly like a provider that never read the prompt. The timing is
 * numbers only — no prompt, response, or tool-argument content ever
 * reaches it — and it is attached to the response object under a SYMBOL
 * key so it can never leak into a persisted artifact, a log line, or a
 * JSON body by accident.
 *
 * The probe also carries an OPTIONAL wire-call count: how many actual HTTP
 * attempts the request made, so a caller can tell one slow answer from
 * several attempts whose last one was slow. The count belongs to the caller
 * that owns the request (it counts the attempts); the transport's own
 * measurement never guesses it.
 */

/** The timing of ONE wire call. Seconds, measured from the moment the
 * request body was dispatched. A null field means "this never happened on
 * the wire" — never a zero standing in for an unmeasured value. */
export interface TransportTiming {
  /** seconds from request dispatch to the first response body byte */
  firstEventSec: number | null;
  /** seconds from request dispatch to the first content-bearing stream event */
  firstContentSec: number | null;
  /** seconds from request dispatch to the response end */
  totalSec: number;
  /**
   * #1466: how many ACTUAL wire calls the request made — the #1200 per-wire-
   * call hook counts them, so a 429/5xx backoff, a #824 max_tokens clamp and
   * a #1047 structured-output strip all show up as additional calls. It is
   * what separates "one slow provider answer" from "three attempts, the
   * last one slow".
   *
   * OPTIONAL: the transport's own probe measures a single HTTP turn and
   * does not know how many attempts its caller made, so the probe carries
   * the count only when the caller that owns the request counted it. Absent
   * means "not counted" — never "one" standing in for an unmeasured count.
   */
  wireCalls?: number;
}

/**
 * #1466: the key the timing is attached under. `Symbol.for` (not a fresh
 * `Symbol`) so the key is stable across module instances: a bundled
 * runtime can load this module more than once, and two instances must
 * still agree on where the timing lives. The key is not a string, so no
 * provider body, artifact field, or user-controlled name can collide
 * with it.
 */
export const TRANSPORT_TIMING: unique symbol = Symbol.for("pr-reviewer-action.transport-timing");

/**
 * #1466: attach the timing to the object the caller receives.
 *
 * The property is NON-ENUMERABLE on purpose: `JSON.stringify`, every
 * artifact writer, and every property enumeration in the codebase must
 * not see the probe — a persisted response body must stay byte-identical
 * to what the provider sent. The value is therefore observable ONLY
 * through `readTransportTiming`.
 *
 * A value that cannot carry an own property (a frozen or sealed object)
 * is returned unchanged: the probe is observation-only and must never
 * fail a model call. A non-object (a string, a number, `null`) is
 * returned unchanged as well — there is nowhere to attach to.
 */
export function attachTransportTiming<T>(value: T, timing: TransportTiming): T {
  if (value === null || typeof value !== "object") return value;
  try {
    Object.defineProperty(value, TRANSPORT_TIMING, {
      value: timing,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  } catch {
    // A sealed/frozen value cannot carry the probe; the timing is
    // observation-only, so the value survives untouched.
  }
  return value;
}

/** The timing shape `readTransportTiming` accepts: a finite number, or
 * null for "never happened". */
function timingField(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

/**
 * #1466: read the timing back off a response object, or null when the
 * object carries none.
 *
 * The read is defensive on purpose: the value may have crossed a
 * process boundary (a persisted artifact, a JSON round-trip) before it
 * is read, so a malformed shape reads as "no timing" instead of
 * publishing a half-valid measurement.
 */
export function readTransportTiming(value: unknown): TransportTiming | null {
  if (value === null || typeof value !== "object") return null;
  const holder = value as { [TRANSPORT_TIMING]?: unknown };
  const raw = holder[TRANSPORT_TIMING];
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const firstEventSec = timingField(record.firstEventSec);
  const firstContentSec = timingField(record.firstContentSec);
  const totalSec = timingField(record.totalSec);
  if (firstEventSec === undefined || firstContentSec === undefined || totalSec === undefined) return null;
  if (totalSec === null) return null;
  // #1466: the wire-call count rides the probe when its owner counted it.
  // An absent count stays ABSENT (the key is not added) so a probe that
  // carries no count never reads as "exactly one call".
  const wireCalls = wireCallCount(record.wireCalls);
  return { firstEventSec, firstContentSec, totalSec, ...(wireCalls !== undefined ? { wireCalls } : {}) };
}

/** #1466: the wire-call count, when the probe carries a usable one. A
 * negative, fractional, or non-numeric value is "not counted" — a call
 * count that cannot be trusted is never published as a number. */
function wireCallCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}
