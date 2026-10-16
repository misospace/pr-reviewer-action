import { createHash } from "node:crypto";

/**
 * `ai-extra-headers` parsing (#1037): the one place that turns the operator's
 * multi-line `Name: value` input into wire headers. The input lets callers
 * stamp a stable per-run correlation id (e.g. `x-litellm-session-id`) on every
 * AI provider request — primary, smart, fallback, and specialist lanes, both
 * wire formats — without a sidecar proxy.
 *
 * Rules, all enforced here so every consumer shares one fence:
 * - Each non-blank line is exactly one `Name: value` pair; names are kept
 *   as written (LiteLLM-style `x-<vendor>-session-id` headers are matched by
 *   the proxy, and operators expect their own casing on the wire).
 * - Names must be RFC 7230 tokens and values must be free of control
 *   characters — CR/LF in a header value is request-splitting, and it must
 *   fail at startup, not midway through a review.
 * - Names that collide case-insensitively with the action's own transport
 *   headers (`RESERVED_EXTRA_HEADER_NAMES`) are rejected: an operator can
 *   never silently override auth, protocol version, or framing headers.
 *   `applyExtraHeaders` revalidates every pair through the SAME assertion the
 *   startup parser uses, so a caller that bypassed startup validation still
 *   fails closed (#252 fence discipline) and the two fences cannot drift.
 * - Diagnostics name the offending header NAME and never echo the value:
 *   values routinely carry proxy tokens, and load errors reach run logs.
 *
 * `extraHeaderFingerprint` is the third surface: the canonical form the review
 * fingerprint hashes (see `src/precheck/fingerprint.ts`). Ephemeral
 * correlation/session/trace headers participate by name alone; every other
 * header participates by name plus a truncated digest of its VALUE, because a
 * non-ephemeral value change (swapping one `anthropic-beta` token for another)
 * changes the bytes on the wire and must force a fresh review. No raw value
 * ever enters the fingerprint.
 */

/** Transport-critical headers the action owns; case-insensitive match.
 * Beyond the issue's named six, this covers every header whose override
 * would silently corrupt the request rather than merely restyle it:
 * `accept` (the action owns `Accept: text/event-stream` on streamed
 * Anthropic calls), and the RFC 7230 connection framing set Node manages
 * itself. `__proto__` is also refused case-insensitively: it is a valid
 * RFC 7230 token but assignment onto a plain object is a silent no-op, so
 * an operator must be told, not quietly ignored. */
export const RESERVED_EXTRA_HEADER_NAMES: ReadonlySet<string> = new Set([
  "x-api-key",
  "authorization",
  "anthropic-version",
  "content-type",
  "accept",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "__proto__",
]);

/** Bound on the configured header set — generous next to any legitimate
 * correlation/beta use, small enough that a pathological input fails with a
 * clear message instead of a huge outbound header block. */
export const MAX_EXTRA_HEADERS = 16;

/** RFC 7230 `token` (the header-name grammar): no separator, whitespace, or
 * control character can reach the wire through a name. */
const HEADER_NAME_TOKEN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/** ASCII control characters other than horizontal tab. Tab inside a value is
 * legal folded whitespace; CR/LF/NUL never are — that is the header
 * injection/smuggling surface. Leading/trailing whitespace is trimmed first,
 * so trailing tab/VT variants never reach this check either. */
const HEADER_VALUE_CONTROL_CHARS = /[\u0000-\u0008\u000A-\u001F\u007F]/;

/** Node's own header-value authority (`checkInvalidHeaderChar` in
 * `_http_common`): tab, printable ASCII, and latin-1. Anything above
 * U+00FF (emoji, U+2028) makes `setHeader` throw `ERR_INVALID_CHAR` at
 * REQUEST time — that would surface mid-review, so the startup parser
 * rejects exactly what the wire would reject, with a clearer message. */
const HEADER_VALUE_OUT_OF_LATIN1 = /[^\t\u0020-\u007E\u0080-\u00FF]/;

export class ExtraHeadersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtraHeadersError";
  }
}

/** Per-pair fence, shared by the startup parser and the wire merge so the two
 * can never drift: the value is a string, the name is a non-empty RFC 7230
 * token, the value is free of control characters and latin-1-only, the name
 * does not collide case-insensitively with a transport header the action
 * owns, and the name does not duplicate another pair case-insensitively.
 * `seen` carries the lowername → configured-spelling map so a duplicate names
 * both spellings; it is updated in place so the caller keeps one pass.
 * `atWire` selects the reserved-collision wording the wire boundary asserts on
 * (a hand-built map never reaches the startup list). Values are never echoed.
 * Returns the validated value so callers stay narrowed to `string` without a
 * second check. */
function assertExtraHeaderPair(
  name: string,
  value: unknown,
  seen: Map<string, string>,
  atWire: boolean,
): string {
  if (name === "") {
    throw new ExtraHeadersError("Invalid ai-extra-headers line: empty header name before ':'.");
  }
  if (typeof value !== "string") {
    // A JS caller can hand `applyExtraHeaders` a map whose values are not
    // strings; the shape checks below would coerce them and only Node's
    // request time would throw. The type name is reported, never the value.
    throw new ExtraHeadersError(
      `Invalid ai-extra-headers value for '${name}': values must be strings (got ${value === null ? "null" : typeof value}). Header values are not echoed.`,
    );
  }
  if (!HEADER_NAME_TOKEN.test(name)) {
    throw new ExtraHeadersError(
      `Invalid ai-extra-headers name '${name}': header names may contain only alphanumeric characters and !#$%&'*+-.^_\`|~.`,
    );
  }
  const lower = name.toLowerCase();
  if (RESERVED_EXTRA_HEADER_NAMES.has(lower)) {
    throw new ExtraHeadersError(
      atWire
        ? `Refusing to send ai-extra-headers name '${name}': it collides with a transport header the action owns.`
        : `Invalid ai-extra-headers name '${name}': it collides with a transport header the action owns ` +
          `(${[...RESERVED_EXTRA_HEADER_NAMES].join(", ")}) and cannot be overridden.`,
    );
  }
  if (HEADER_VALUE_CONTROL_CHARS.test(value)) {
    throw new ExtraHeadersError(
      `Invalid ai-extra-headers value for '${name}': control characters (including CR and LF) are not allowed.`,
    );
  }
  if (HEADER_VALUE_OUT_OF_LATIN1.test(value)) {
    throw new ExtraHeadersError(
      `Invalid ai-extra-headers value for '${name}': header values are latin-1 text on the wire; ` +
      "characters above U+00FF (e.g. emoji) are rejected.",
    );
  }
  const previous = seen.get(lower);
  if (previous !== undefined) {
    throw new ExtraHeadersError(
      `Invalid ai-extra-headers: duplicate header '${name}' (already set as '${previous}').`,
    );
  }
  seen.set(lower, name);
  return value;
}

/** The configured-set bound, enforced by both fences: a hand-built map that
 * skipped startup validation must not smuggle a huge header block onto the
 * wire either. */
function assertExtraHeaderCount(count: number): void {
  if (count > MAX_EXTRA_HEADERS) {
    throw new ExtraHeadersError(
      `Invalid ai-extra-headers: at most ${MAX_EXTRA_HEADERS} headers may be configured.`,
    );
  }
}

/** Parse the raw `ai-extra-headers` input into a case-preserved header map.
 * Blank input (or blank lines only) yields `{}` — the byte-for-byte
 * unchanged-request path. Throws `ExtraHeadersError` with an actionable,
 * value-free message on any malformed, unsafe, colliding, or duplicate pair. */
export function parseExtraHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      throw new ExtraHeadersError(
        "Invalid ai-extra-headers line: expected 'Name: value' (no ':' found). Header values are not echoed.",
      );
    }
    const name = trimmed.slice(0, colon).trim();
    headers[name] = assertExtraHeaderPair(name, trimmed.slice(colon + 1).trim(), seen, false);
  }
  assertExtraHeaderCount(Object.keys(headers).length);
  return headers;
}

/** Merge parsed extra headers into an outbound header record. Every pair is
 * revalidated through the parser's own assertion before anything is written:
 * a non-string value, a malformed name, a control character or non-latin-1
 * character in the value, a reserved-name collision, a case-insensitive
 * duplicate, or a set over the count bound all throw — so a map assembled
 * outside `parseExtraHeaders` fails closed on the same rules, and a rejected
 * set never leaves a half-merged header block behind (#252 fence discipline).
 * Names keep the configured case. */
export function applyExtraHeaders(
  headers: Record<string, string>,
  extraHeaders: Readonly<Record<string, unknown>>,
): void {
  const entries = Object.entries(extraHeaders);
  assertExtraHeaderCount(entries.length);
  const seen = new Map<string, string>();
  const validated = entries.map(([name, value]) => [name, assertExtraHeaderPair(name, value, seen, true)] as const);
  for (const [name, value] of validated) headers[name] = value;
}

/** `parseExtraHeaders` for the stage-env consumers that hand the result to an
 * `exactOptionalPropertyTypes` call input: `undefined` when nothing is
 * configured, so the caller omits the field entirely instead of passing an
 * empty map. */
export function extraHeadersForEnv(raw: string): Record<string, string> | undefined {
  const headers = parseExtraHeaders(raw);
  return Object.keys(headers).length === 0 ? undefined : headers;
}

/** Ephemeral correlation/session/trace headers: their values legitimately
 * change every run (a run id, a trace id), so hashing the value would break
 * the unchanged-diff skip for exactly the canonical use of this input. Matched
 * on the lowercased name — a `-session-id`/`-request-id`/`-correlation-id`/
 * `-trace-id`/`-span-id`/`-run-id` suffix (vendor-prefixed forms like
 * `x-litellm-session-id`) or one of the standard trace-context headers. */
const EPHEMERAL_HEADER_SUFFIXES: readonly string[] = [
  "-session-id", "-request-id", "-correlation-id", "-trace-id", "-span-id", "-run-id",
];
const EPHEMERAL_HEADER_NAMES: ReadonlySet<string> = new Set([
  "traceparent", "tracestate", "x-b3-traceid", "x-b3-spanid", "x-b3-parentspanid",
]);

function isEphemeralHeaderName(lower: string): boolean {
  return EPHEMERAL_HEADER_NAMES.has(lower) || EPHEMERAL_HEADER_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** The canonical fingerprint identity of the configured extra-header set: a
 * sorted, comma-joined entry per header. Ephemeral correlation headers
 * contribute their bare lowercased name; every other header contributes
 * `<name>=<first 12 hex chars of sha256(name \0 value)>` — the VALUE is never
 * emitted, only a name-domain-separated digest of it, so a value change such
 * as swapping one `anthropic-beta` token for another invalidates the cached
 * review without leaking the token into the fingerprint. Blank input yields
 * `""` (the caller emits no line, keeping the unset baseline stable) and
 * malformed input throws `ExtraHeadersError` exactly like `parseExtraHeaders`. */
export function extraHeaderFingerprint(raw: string): string {
  return Object.entries(parseExtraHeaders(raw))
    .map(([name, value]) => {
      const lower = name.toLowerCase();
      if (isEphemeralHeaderName(lower)) return lower;
      const digest = createHash("sha256").update(lower).update("\0").update(value).digest("hex");
      return `${lower}=${digest.slice(0, 12)}`;
    })
    .sort()
    .join(",");
}
