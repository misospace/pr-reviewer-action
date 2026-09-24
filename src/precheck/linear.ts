import { requestJson } from "../platform/http.js";
import type { FetchLike } from "../platform/http.js";

/** Optional deterministic Linear adapter (#674) — TS port of the subset of
 * `pr_reviewer/linear_context.py` the selection signature reads. */

export const LINEAR_API_URL = "https://api.linear.app/graphql";
export const MAX_LINEAR_ISSUES = 8;
const MAX_DESCRIPTION_CHARS = 12_000;

const PREFIX_RE = /^[A-Za-z][A-Za-z0-9]{0,15}$/;

export const LINEAR_PRIORITY_LABELS: Readonly<Record<number, string>> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

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

/** Parse a comma-separated allowlist of Linear team-key prefixes. */
export function parsePrefixes(value: string): string[] {
  const prefixes: string[] = [];
  for (const raw of (value ?? "").split(",")) {
    const prefix = raw.trim();
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

export interface LinearIssue {
  source: "linear";
  ref: string;
  identifier: string;
  title: string;
  body: string;
  url: string;
  state: string;
  priority: number | null;
  priority_label: string;
  labels: { name: string }[];
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Fetch one Linear issue by human-readable identifier. */
export async function fetchIssue(
  identifier: string,
  apiKey: string,
  options: { apiUrl?: string | undefined; timeout?: number | undefined; fetchImpl?: FetchLike | undefined } = {},
): Promise<LinearIssue> {
  const apiUrl = options.apiUrl ?? LINEAR_API_URL;
  const timeout = options.timeout ?? 20;
  const body = JSON.stringify({ query: ISSUE_QUERY, variables: { id: identifier } });
  let payload: unknown;
  try {
    const result = await requestJson(apiUrl, {
      method: "POST",
      token: apiKey,
      body,
      timeoutMs: timeout * 1000,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      allowedOrigin: new URL(apiUrl).origin,
    });
    if (result.status !== 200) throw new LinearContextError(`Linear HTTP error ${result.status}`);
    payload = result.data;
  } catch (error) {
    if (error instanceof LinearContextError) throw error;
    if (error instanceof Error && /Platform returned invalid JSON/.test(error.message)) {
      throw new LinearContextError("Linear returned invalid JSON");
    }
    throw new LinearContextError(`Linear request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeLinearIssue(payload, identifier);
}

function normalizeLinearIssue(payload: unknown, identifier: string): LinearIssue {
  const outer = asObject(payload);
  if (Array.isArray(outer.errors) && outer.errors.length > 0) {
    const messages = outer.errors
      .filter((item) => typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).message === "string")
      .map((item) => String((item as Record<string, unknown>).message));
    throw new LinearContextError(messages.join("; ") || "Linear GraphQL request failed");
  }
  const issue = asObject(asObject(outer.data).issue);
  if (Object.keys(issue).length === 0) {
    throw new LinearContextError(`Linear issue ${identifier} was not found`);
  }
  const resolvedIdentifier = String(issue.identifier || identifier).toUpperCase();
  const rawPriority = issue.priority;
  const priority = typeof rawPriority === "number" && Number.isInteger(rawPriority) && rawPriority in LINEAR_PRIORITY_LABELS
    ? rawPriority
    : null;
  const labelNodes = Array.isArray(asObject(issue.labels).nodes) ? (asObject(issue.labels).nodes as unknown[]) : [];
  return {
    source: "linear",
    ref: resolvedIdentifier,
    identifier: resolvedIdentifier,
    title: String(issue.title ?? ""),
    body: String(issue.description ?? "").slice(0, MAX_DESCRIPTION_CHARS),
    url: String(issue.url ?? ""),
    state: String(asObject(issue.state).name ?? ""),
    priority,
    priority_label: priority !== null ? LINEAR_PRIORITY_LABELS[priority] ?? "" : "",
    labels: labelNodes
      .filter((label) => typeof label === "object" && label !== null && (label as Record<string, unknown>).name)
      .map((label) => ({ name: String((label as Record<string, unknown>).name) })),
  };
}

export interface CollectResult {
  issues: LinearIssue[];
  errors: [string, string][];
}

/** Discover and fetch Linear issues referenced by the PR title. */
export async function collectFromPr(
  title: string,
  prefixes: string[],
  apiKey: string,
  options: { apiUrl?: string | undefined; timeout?: number | undefined; fetchImpl?: FetchLike | undefined } = {},
): Promise<CollectResult> {
  const issues: LinearIssue[] = [];
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
