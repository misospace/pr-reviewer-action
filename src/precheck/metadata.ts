/** Managed metadata marker parsing (#674) — TS port of
 * `pr_reviewer/metadata.py`. The carry-forward verdict on a diff-unchanged
 * skip is read from this marker, so a downstream gate cannot flip
 * red→green on re-run. */

const MARKER_PREFIX_PATTERN = /<!--\s*ai-pr-reviewer:\s*(?=\{)/;

/** Extract the first ai-pr-reviewer metadata JSON from a comment/review
 * body. Returns null when no marker is found or parsing fails. The JSON
 * must be terminated by the comment closer `-->` to count as well-formed. */
export function parseMetadata(body: string): Record<string, unknown> | null {
  const match = MARKER_PREFIX_PATTERN.exec(body);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[0].length;
  // Try each `-->` terminator: an earlier occurrence may sit inside a JSON
  // string (where it makes the prefix parse fail), mirroring the v2
  // raw_decode-then-closer-check without a streaming JSON parser.
  let searchFrom = start;
  for (;;) {
    const closer = body.indexOf("-->", searchFrom);
    if (closer === -1) return null;
    const candidate = body.slice(start, closer).trim();
    try {
      const data: unknown = JSON.parse(candidate);
      if (data !== null && typeof data === "object" && !Array.isArray(data)) {
        return data as Record<string, unknown>;
      }
      return null;
    } catch {
      searchFrom = closer + 3;
    }
  }
}

export interface MetadataOptions {
  version?: number;
  head_sha?: string;
  base_sha?: string;
  review_result?: string;
  required_checks?: string | null;
  review_route?: string | null;
  escalation_reason?: string[] | null;
  cache_hit_ratio?: number | null;
  /** #810: "partial" when the tool loop stopped on a budget with unread
   * evidence; omitted for complete coverage. Additive at the END of the
   * insertion order — the marker is a positional wire format, so the
   * existing keys keep their positions. */
  coverage?: string | null;
  /** #810: the loop stop reason behind coverage: partial. */
  coverage_stop_reason?: string | null;
}

/** Build a metadata marker string for insertion into managed comments
 * (port of `build_marker`). */
export function buildMetadataMarker(options: MetadataOptions = {}): string {
  const data: Record<string, unknown> = {
    version: options.version ?? 1,
    head_sha: options.head_sha ?? "",
    base_sha: options.base_sha ?? "",
    review_result: options.review_result ?? "clean",
  };
  if (options.required_checks !== null && options.required_checks !== undefined && options.required_checks !== "" && options.required_checks !== "none") {
    data.required_checks = options.required_checks;
  }
  if (options.review_route !== null && options.review_route !== undefined && options.review_route !== "legacy") {
    data.review_route = options.review_route;
  }
  if (options.escalation_reason !== null && options.escalation_reason !== undefined) {
    data.escalation_reason = options.escalation_reason;
  }
  if (options.cache_hit_ratio !== null && options.cache_hit_ratio !== undefined) {
    data.cache_hit_ratio = options.cache_hit_ratio;
  }
  // #810 additive keys: appended last so the pre-existing insertion order is
  // untouched and older marker parsers ignore what they do not know.
  if (options.coverage !== null && options.coverage !== undefined && options.coverage !== "") {
    data.coverage = options.coverage;
  }
  if (options.coverage_stop_reason !== null && options.coverage_stop_reason !== undefined && options.coverage_stop_reason !== "") {
    data.coverage_stop_reason = options.coverage_stop_reason;
  }
  return `<!-- ai-pr-reviewer:${jsonCompact(data)} -->`;
}

/** Compact JSON with `,`/`:` separators and INSERTION key order — the exact
 * `json.dumps(data, separators=(',', ':'))` of `pr_reviewer/metadata.py`'s
 * `build_marker` (and the jq key order in `build_metadata_marker`). The
 * sort_keys variant (`pythonJsonStringify`) is for canonical-artifact values;
 * the marker is a positional wire format, so its key order is contractual. */
function jsonCompact(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") return pythonStringEscape(value);
  if (Array.isArray(value)) {
    return `[${value.map(jsonCompact).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${pythonStringEscape(key)}:${jsonCompact(item)}`);
    return `{${entries.join(",")}}`;
  }
  return "null";
}

/** Serialize a restricted JSON value the way Python's
 * `json.dumps(..., sort_keys=True, ensure_ascii=False)` does: object keys
 * sorted, `, ` / `: ` separators by default, and Python's exact string
 * escaping. The selection signature hash depends on byte-level equality of
 * this serialization between v2 and v3 (#674). */
export function pythonJsonStringify(
  value: unknown,
  itemSeparator = ", ",
  keySeparator = ": ",
): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    return String(value);
  }
  if (typeof value === "string") return pythonStringEscape(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonJsonStringify(item, itemSeparator, keySeparator)).join(itemSeparator)}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${pythonStringEscape(key)}${keySeparator}${pythonJsonStringify(item, itemSeparator, keySeparator)}`);
    return `{${entries.join(itemSeparator)}}`;
  }
  return "null";
}

function pythonStringEscape(text: string): string {
  let out = '"';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (char === "\b") out += "\\b";
    else if (char === "\f") out += "\\f";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return `${out}"`;
}
