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
 *   `applyExtraHeaders` re-checks at the wire boundary so a caller that
 *   bypassed startup validation still fails closed (#252 fence discipline).
 * - Diagnostics name the offending header NAME and never echo the value:
 *   values routinely carry proxy tokens, and load errors reach run logs.
 */

/** Transport-critical headers the action owns; case-insensitive match. */
export const RESERVED_EXTRA_HEADER_NAMES: ReadonlySet<string> = new Set([
  "x-api-key",
  "authorization",
  "anthropic-version",
  "content-type",
  "host",
  "content-length",
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

export class ExtraHeadersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtraHeadersError";
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
    const value = trimmed.slice(colon + 1).trim();
    if (name === "") {
      throw new ExtraHeadersError("Invalid ai-extra-headers line: empty header name before ':'.");
    }
    if (!HEADER_NAME_TOKEN.test(name)) {
      throw new ExtraHeadersError(
        `Invalid ai-extra-headers name '${name}': header names may contain only alphanumeric characters and !#$%&'*+-.^_\`|~.`,
      );
    }
    const lower = name.toLowerCase();
    if (RESERVED_EXTRA_HEADER_NAMES.has(lower)) {
      throw new ExtraHeadersError(
        `Invalid ai-extra-headers name '${name}': it collides with a transport header the action owns ` +
        `(${[...RESERVED_EXTRA_HEADER_NAMES].join(", ")}) and cannot be overridden.`,
      );
    }
    if (HEADER_VALUE_CONTROL_CHARS.test(value)) {
      throw new ExtraHeadersError(
        `Invalid ai-extra-headers value for '${name}': control characters (including CR and LF) are not allowed.`,
      );
    }
    const previous = seen.get(lower);
    if (previous !== undefined) {
      throw new ExtraHeadersError(
        `Invalid ai-extra-headers: duplicate header '${name}' (already set as '${previous}').`,
      );
    }
    seen.set(lower, name);
    headers[name] = value;
  }
  if (Object.keys(headers).length > MAX_EXTRA_HEADERS) {
    throw new ExtraHeadersError(
      `Invalid ai-extra-headers: at most ${MAX_EXTRA_HEADERS} headers may be configured.`,
    );
  }
  return headers;
}

/** Merge parsed extra headers into an outbound header record. Reserved names
 * throw even if the caller constructed the map outside `parseExtraHeaders` —
 * the wire boundary never lets caller data outrank the action's own auth or
 * framing headers. Names keep the configured case. */
export function applyExtraHeaders(
  headers: Record<string, string>,
  extraHeaders: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (RESERVED_EXTRA_HEADER_NAMES.has(name.toLowerCase())) {
      throw new ExtraHeadersError(
        `Refusing to send ai-extra-headers name '${name}': it collides with a transport header the action owns.`,
      );
    }
    headers[name] = value;
  }
}

/** The configured header names, lowercased, sorted, deduplicated — the
 * stable identity of the extra-header surface for fingerprinting (#1037):
 * the values of correlation-id headers legitimately change every run, so
 * only the name surface participates in the review fingerprint. Throws on
 * malformed input exactly like `parseExtraHeaders`. */
export function extraHeaderNames(raw: string): string[] {
  return [...new Set(Object.keys(parseExtraHeaders(raw)).map((name) => name.toLowerCase()))].sort();
}
