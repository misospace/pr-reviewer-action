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
  /** #954: the metadata marker's incomplete_reason key. */
  incomplete_reason?: string | null;
  /** #812: the folded external-CI conclusion at the reviewed head
   * ("success" | "failure" | "pending" | "none"). The skip re-check compares
   * it against the live state; omitted (null/empty) when unknown so the
   * marker stays byte-identical to pre-#812 whenever CI was not read. */
  ci_state?: string | null;
  /** #847: the effective #810/#702 tool-loop request budget
   * (resolveToolMaxRequests()'s `budget`), so the size-scaled default can be
   * measured from published reviews alone. Omitted when no tool harness ran
   * (tool_mode=off, or an abort before the budget was resolved). */
  tool_budget?: number | null;
  /** #847: which source won ("primary-override" | "smart-override" |
   * "explicit" | "tier-default" | "size-scaled"), matching
   * `ToolBudgetSource`. Omitted alongside `tool_budget`. */
  tool_budget_source?: string | null;
  /** #847: tool calls the loop actually executed against that budget.
   * Omitted alongside `tool_budget`. */
  tool_calls?: number | null;
  /** #895: rounds the loop actually used, so the size-scaled round cap can
   * be measured from published reviews alone. Omitted when no tool harness
   * ran or the loop never reported a round count. */
  tool_rounds?: number | null;
  /** #895: the resolved round cap the loop ran against for this run (see
   * `adaptiveLoopBudgets` in src/tools/loop.ts). Omitted alongside
   * `tool_rounds`. */
  max_rounds?: number | null;
  /** #922: the loop's conversation budget (approx tokens) and the largest
   * conversation it actually reached. Omitted when no loop ran. */
  context_budget?: number | null;
  context_peak?: number | null;
  /** #915: build-time action release stamp, appended last under the additive
   * key discipline of #810/#847/#895/#922; unstamped builds preserve pre-#915 bytes. */
  action_version?: string | null;
  /** #978: gate-bypass eligibility; false/absent is omitted. */
  degradedGateBypass?: boolean | null;
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
  if (options.incomplete_reason !== null && options.incomplete_reason !== undefined && options.incomplete_reason !== "" && options.incomplete_reason !== "none") {
    data.incomplete_reason = options.incomplete_reason;
  }
  if (options.ci_state !== null && options.ci_state !== undefined && options.ci_state !== "") {
    data.ci_state = options.ci_state;
  }
  // #847 additive keys: appended last, same discipline as the #810/#812 keys
  // above — a complete run with no tool harness serializes byte-identically
  // to the pre-#847 marker.
  if (options.tool_budget !== null && options.tool_budget !== undefined) {
    data.tool_budget = options.tool_budget;
  }
  if (options.tool_budget_source !== null && options.tool_budget_source !== undefined && options.tool_budget_source !== "") {
    data.tool_budget_source = options.tool_budget_source;
  }
  if (options.tool_calls !== null && options.tool_calls !== undefined) {
    data.tool_calls = options.tool_calls;
  }
  if (options.tool_rounds !== null && options.tool_rounds !== undefined) {
    data.tool_rounds = options.tool_rounds;
  }
  if (options.max_rounds !== null && options.max_rounds !== undefined) {
    data.max_rounds = options.max_rounds;
  }
  if (options.context_budget !== null && options.context_budget !== undefined) {
    data.context_budget = options.context_budget;
  }
  if (options.context_peak !== null && options.context_peak !== undefined) {
    data.context_peak = options.context_peak;
  }
  // #915 additive key: appended last, same discipline as the #810/#847 keys
  // above — an unstamped build serializes byte-identically to pre-#915.
  if (options.action_version !== null && options.action_version !== undefined && options.action_version !== "") {
    data.action_version = options.action_version;
  }
  // #978 additive key: older markers omit it; append it without moving any
  // existing fields. Persist only true; false and absent preserve old bytes.
  if (options.degradedGateBypass === true) {
    data.degraded_gate_bypass = true;
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
