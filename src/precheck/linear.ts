import { requestText } from "../platform/http.js";
import type { FetchLike } from "../platform/http.js";
import { isPlainObject } from "../platform/jq.js";
import { pyStr, pyTruthy } from "../platform/py.js";
import { LINEAR_PRIORITY_LABELS, type LinkedIssue } from "../context/types.js";
import { pyJsonDumpsLine } from "../context/py-json.js";

/** Optional deterministic Linear adapter (#674) — TS port of the subset of
 * `pr_reviewer/linear_context.py` the selection signature reads.
 *
 * The adapter's output IS the canonical `LinkedIssue` (#675): there is no
 * parallel Linear-only issue shape. The selection-signature path and any
 * other consumer derive from the same canonical representation, with the
 * persisted/parity byte forms reached through explicit converters (see
 * `selection.ts`). */

export const LINEAR_API_URL = "https://api.linear.app/graphql";
export const MAX_LINEAR_ISSUES = 8;
const MAX_DESCRIPTION_CHARS = 12_000;
const MAX_RESPONSE_BYTES = 1_000_000;

const PREFIX_RE = /^[A-Za-z][A-Za-z0-9]{0,15}$/;

export { LINEAR_PRIORITY_LABELS };

const ISSUE_QUERY = `query PrReviewerIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    url
    state { name }
    priority
    labels { nodes { name } }
  }
}`;

export class LinearContextError extends Error {}

/** Python `str.isspace()` code points: what a bare `str.strip()` removes. */
const PY_WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Python `str.strip()` with no argument (JavaScript `trim()` also strips
 * U+FEFF and misses U+001C..U+001F). */
export function pyStrip(value: string): string {
  const chars = [...value];
  let start = 0;
  let end = chars.length;
  while (start < end && PY_WHITESPACE.has(chars[start]!.codePointAt(0)!)) start += 1;
  while (end > start && PY_WHITESPACE.has(chars[end - 1]!.codePointAt(0)!)) end -= 1;
  return chars.slice(start, end).join("");
}

/** Parse a comma-separated allowlist of Linear team-key prefixes. */
export function parsePrefixes(value: string): string[] {
  const prefixes: string[] = [];
  for (const raw of (value ?? "").split(",")) {
    const prefix = pyStrip(raw);
    if (!prefix) continue;
    if (!PREFIX_RE.test(prefix)) {
      throw new Error(`invalid Linear issue prefix '${prefix}'; expected letters/digits starting with a letter`);
    }
    const normalized = prefix.toUpperCase();
    if (!prefixes.includes(normalized)) prefixes.push(normalized);
  }
  return prefixes;
}

/** Extract configured `TEAM-123` identifiers from a PR title. */
export function extractIssueIdentifiers(title: string, prefixes: string[], maxIssues = MAX_LINEAR_ISSUES): string[] {
  if (!prefixes.length || maxIssues <= 0) return [];
  const alternatives = prefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?<![A-Za-z0-9])(?:${alternatives})-[0-9]+(?![A-Za-z0-9])`, "gi");
  const identifiers: string[] = [];
  for (const match of (title ?? "").matchAll(pattern)) {
    const identifier = (match[0] ?? "").toUpperCase();
    if (!identifiers.includes(identifier)) identifiers.push(identifier);
    if (identifiers.length >= maxIssues) break;
  }
  return identifiers;
}

function refNumber(ref: string): number {
  const match = /#(\d+)$/.exec(ref);
  const parsed = match === null ? Number.NaN : Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(parsed) ? parsed : 0;
}

/** Fetch one Linear issue by human-readable identifier. Returns the issue in
 * the canonical `LinkedIssue` representation. Error messages match
 * `linear_context.fetch_issue`: a non-2xx status is an HTTP error whatever
 * its body, then the 1 MB size limit, then JSON and shape validation. */
export async function fetchIssue(
  identifier: string,
  apiKey: string,
  options: { apiUrl?: string | undefined; timeout?: number | undefined; fetchImpl?: FetchLike | undefined } = {},
): Promise<LinkedIssue> {
  const apiUrl = options.apiUrl ?? LINEAR_API_URL;
  const timeout = options.timeout ?? 20;
  const body = JSON.stringify({ query: ISSUE_QUERY, variables: { id: identifier } });
  let status: number;
  let text: string;
  try {
    const result = await requestText(apiUrl, {
      method: "POST",
      token: apiKey,
      body,
      timeoutMs: timeout * 1000,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      allowedOrigin: new URL(apiUrl).origin,
    });
    status = result.status;
    text = result.text;
  } catch (error) {
    throw new LinearContextError(`Linear request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (status < 200 || status >= 300) throw new LinearContextError(`Linear HTTP error ${status}`);
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new LinearContextError("Linear response exceeded the size limit");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new LinearContextError("Linear returned invalid JSON");
  }
  return normalizeLinearIssue(payload, identifier);
}

/** Python `str(value or "")`. */
function strOr(value: unknown): string {
  return pyTruthy(value) ? pyStr(value) : "";
}

/** First `limit` code points (Python slicing), not UTF-16 units. */
function codePointSlice(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return [...text].slice(0, limit).join("");
}

function normalizeLinearIssue(payload: unknown, identifier: string): LinkedIssue {
  if (!isPlainObject(payload)) throw new LinearContextError("Linear returned an invalid response shape");
  if (pyTruthy(payload.errors)) {
    // `_graphql_error_message`: iterating a dict or string yields keys or
    // characters, never dicts, so only a list can contribute messages.
    const messages = (Array.isArray(payload.errors) ? payload.errors : [])
      .filter((item) => isPlainObject(item) && pyTruthy(item.message))
      .map((item) => pyStr((item as Record<string, unknown>).message));
    throw new LinearContextError(messages.join("; ") || "Linear GraphQL request failed");
  }
  const data = pyTruthy(payload.data) ? payload.data : {};
  const issue = isPlainObject(data) ? data.issue : undefined;
  if (!isPlainObject(issue)) {
    throw new LinearContextError(`Linear issue ${identifier} was not found`);
  }
  const resolvedIdentifier = (pyTruthy(issue.identifier) ? pyStr(issue.identifier) : identifier).toUpperCase();
  const rawPriority = issue.priority;
  // Python: `type(raw_priority) is int and raw_priority in _LINEAR_PRIORITY_LABELS`.
  const priority = typeof rawPriority === "number" && Number.isInteger(rawPriority) && rawPriority in LINEAR_PRIORITY_LABELS
    ? rawPriority
    : null;
  const labelsField = pyTruthy(issue.labels) && isPlainObject(issue.labels) ? issue.labels.nodes : undefined;
  const labelNodes = Array.isArray(labelsField) ? labelsField : [];
  const state = pyTruthy(issue.state) && isPlainObject(issue.state) ? issue.state : {};
  return {
    source: "linear",
    ref: resolvedIdentifier,
    repo: "",
    number: refNumber(resolvedIdentifier),
    title: strOr(issue.title),
    body: codePointSlice(strOr(issue.description), MAX_DESCRIPTION_CHARS),
    url: strOr(issue.url),
    state: strOr(state.name),
    priority,
    priorityLabel: priority !== null ? LINEAR_PRIORITY_LABELS[priority] ?? "" : "",
    labels: labelNodes
      .filter((label) => isPlainObject(label) && pyTruthy(label.name))
      .map((label) => ({ name: pyStr((label as Record<string, unknown>).name) })),
  };
}

/** The v2 issue dict `linear_context.fetch_issue` returns (and
 * `linear-issues.json` / the merged `linked-issues.json` carry), in its
 * insertion order. */
export function linearIssueToV2(issue: LinkedIssue): Record<string, unknown> {
  return {
    source: "linear",
    ref: issue.ref,
    identifier: issue.ref,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    state: issue.state,
    priority: issue.priority ?? null,
    priority_label: issue.priorityLabel ?? "",
    labels: issue.labels.map((label) => ({ name: label.name })),
  };
}

/** `linear_context.render_markdown`: fetched issues as untrusted fenced
 * compact JSON (hostile fences stay inside string escapes), then one
 * notice per fetch failure. */
export function renderLinearMarkdown(issues: readonly LinkedIssue[], errors: readonly (readonly [string, string])[]): string {
  const parts: string[] = [];
  for (const issue of issues) {
    const record = linearIssueToV2(issue);
    const identifier = strOr(record.identifier) || strOr(record.ref) || "unknown";
    const serialized = pyJsonDumpsLine(record, { ensureAscii: false, separators: [",", ":"] });
    parts.push(`## Linear issue ${identifier}\n\`\`\`json\n${serialized}\n\`\`\`\n`);
  }
  for (const [identifier, message] of errors) {
    parts.push(`## Linear issue ${identifier}\n(Could not fetch Linear issue ${identifier}: ${message})\n`);
  }
  return parts.join("\n");
}

export interface CollectResult {
  issues: LinkedIssue[];
  errors: [string, string][];
}

/** Discover and fetch Linear issues referenced by the PR title. */
export async function collectFromPr(
  title: string,
  prefixes: string[],
  apiKey: string,
  options: { apiUrl?: string | undefined; timeout?: number | undefined; fetchImpl?: FetchLike | undefined } = {},
): Promise<CollectResult> {
  const issues: LinkedIssue[] = [];
  const errors: [string, string][] = [];
  for (const identifier of extractIssueIdentifiers(title ?? "", prefixes)) {
    try {
      issues.push(await fetchIssue(identifier, apiKey, options));
    } catch (error) {
      errors.push([identifier, error instanceof Error ? error.message : String(error)]);
    }
  }
  return { issues, errors };
}
