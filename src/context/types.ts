/** Canonical typed context representations (#675).
 *
 * These are the typed boundaries between the deterministic context producers
 * and their consumers (classifier, role selector, corpus builders). A consumer
 * receives one of these canonical values — never a re-read of a parallel
 * scratch file with a subtly different schema — so the #655 class of bugs
 * (a rendered view and a canonical artifact drifting apart) cannot recur
 * unnoticed: there is exactly one representation per concept.
 *
 * Producers stay pure normalizers: network fetch policy and security stay in
 * the platform/tool boundary modules. */

/** Where a linked issue came from. GitHub and Forgejo issues share the same
 * canonical shape; Linear issues carry their native priority. */
export type LinkedIssueSource = "github" | "forgejo" | "linear";

export interface IssueLabel {
  name: string;
}

/** Canonical linked issue: the one representation the classifier, the role
 * selector, the selection signature, and the rendered corpus all derive
 * from. Field names are snake_case to stay byte-comparable with the v2
 * artifacts. */
export interface LinkedIssue {
  source: LinkedIssueSource;
  /** `owner/repo#123` or `TEAM-123`. */
  ref: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  /** Linear native priority (0–4). `null` when the source has no priority. */
  priority: number | null;
  priority_label: string;
  labels: IssueLabel[];
}

const LINKED_ISSUE_SOURCES: readonly string[] = ["github", "forgejo", "linear"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Normalize one untrusted issue payload (GitHub/Forgejo REST shape, the
 * Linear adapter shape, or an already-canonical issue) into the canonical
 * `LinkedIssue`. Unusable fields degrade to empty defaults — never an
 * exception. Labels may be `{name}` objects or bare strings; the canonical
 * form is always `[{name}]`. */
export function canonicalLinkedIssue(raw: unknown, defaultRepo = ""): LinkedIssue {
  const rec = asRecord(raw) ?? {};
  const linearShape =
    asString(rec.source) === "linear" ||
    (typeof rec.identifier === "string" && rec.identifier !== "" && rec.source === undefined);
  const source = asString(rec.source);
  const resolvedSource: LinkedIssueSource = LINKED_ISSUE_SOURCES.includes(source)
    ? (source as LinkedIssueSource)
    : linearShape
      ? "linear"
      : "github";
  const repo = asString(rec.repo) || defaultRepo;
  const numberValue = rec.number;
  const number =
    typeof numberValue === "number" && Number.isFinite(numberValue) && Number.isInteger(numberValue)
      ? numberValue
      : refNumber(asString(rec.ref) || asString(rec.identifier));
  const ref = asString(rec.ref) || asString(rec.identifier) || (repo ? `${repo}#${number}` : `#${number}`);
  const priority = rec.priority;
  const priorityValue =
    typeof priority === "number" && Number.isInteger(priority) ? priority : null;
  const priorityLabel =
    asString(rec.priority_label) ||
    (priorityValue !== null && resolvedSource === "linear" ? LINEAR_PRIORITY_LABELS[priorityValue] ?? "" : "");
  return {
    source: resolvedSource,
    ref,
    repo,
    number,
    title: asString(rec.title),
    body: asString(rec.body) || asString(rec.description),
    url: asString(rec.url) || asString(rec.html_url),
    state: asString(rec.state),
    priority: priorityValue,
    priority_label: priorityLabel,
    labels: normalizeLabels(rec.labels),
  };
}

function refNumber(ref: string): number {
  const match = /#(\d+)$/.exec(ref);
  const parsed = match === null ? Number.NaN : Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(parsed) ? parsed : 0;
}

function normalizeLabels(value: unknown): IssueLabel[] {
  if (!Array.isArray(value)) return [];
  const labels: IssueLabel[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      labels.push({ name: item });
    } else {
      const rec = asRecord(item);
      if (rec !== null) labels.push({ name: asString(rec.name) });
    }
  }
  return labels;
}

/** Linear native priority labels (0 = No priority … 1 = Urgent, 2 = High). */
export const LINEAR_PRIORITY_LABELS: Readonly<Record<number, string>> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

/** Canonical changed-file metadata (from the platform's file list). */
export interface ChangedFile {
  filename: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  changes: number | null;
  patch: string;
}

/** Normalize one untrusted changed-file payload (GitHub/Forgejo files API
 * shape) into the canonical `ChangedFile`. */
export function canonicalChangedFile(raw: unknown): ChangedFile {
  const rec = asRecord(raw) ?? {};
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) ? value : null;
  return {
    filename: asString(rec.filename),
    status: asString(rec.status),
    additions: count(rec.additions),
    deletions: count(rec.deletions),
    changes: count(rec.changes),
    patch: asString(rec.patch),
  };
}

/** Canonical pull-request metadata (from the platform's PR payload). */
export interface CanonicalPullRequest {
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  head_sha: string;
  head_ref: string;
  base_ref: string;
  author: string;
  html_url: string;
}

/** Normalize one untrusted PR payload (GitHub/Forgejo PR shape) into the
 * canonical `CanonicalPullRequest`. */
export function canonicalPullRequest(raw: unknown): CanonicalPullRequest {
  const rec = asRecord(raw) ?? {};
  const head = asRecord(rec.head) ?? {};
  const base = asRecord(rec.base) ?? {};
  const user = asRecord(rec.user) ?? {};
  const numberValue = rec.number;
  return {
    number: typeof numberValue === "number" && Number.isInteger(numberValue) ? numberValue : 0,
    title: asString(rec.title),
    body: asString(rec.body),
    state: asString(rec.state),
    draft: rec.draft === true,
    head_sha: asString(head.sha),
    head_ref: asString(head.ref),
    base_ref: asString(base.ref),
    author: asString(user.login),
    html_url: asString(rec.html_url),
  };
}

/** Normalize a raw linked-issue list into canonical `LinkedIssue`s. */
export function normalizeLinkedIssues(raws: readonly unknown[], defaultRepo = ""): LinkedIssue[] {
  return raws.map((raw) => canonicalLinkedIssue(raw, defaultRepo));
}
