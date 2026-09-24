/** Linked-issue reference extraction (#674) — TS port of
 * `pr_reviewer/github_context.extract_linked_issue_refs`. */

export interface LinkedIssueRef {
  ref: string;
  repo: string;
  number: number;
}

export const MAX_LINKED_ISSUES = 8;

const GITHUB_ISSUE_REF_PATTERN = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?[ \t]+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)/gi;

/** Extract `Closes/Fixes/Resolves #N` style references from a PR body,
 * deduplicated in order of appearance (max 8). A bare `#N` uses the
 * default repo. */
export function extractLinkedIssueRefs(body: string, defaultRepo?: string): LinkedIssueRef[] {
  const repo = defaultRepo ?? "";
  const seen = new Set<string>();
  const items: LinkedIssueRef[] = [];
  for (const match of (body ?? "").matchAll(GITHUB_ISSUE_REF_PATTERN)) {
    const ref = match[1] ?? "";
    if (seen.has(ref)) continue;
    seen.add(ref);
    let repoName: string;
    let issueNumber: string;
    if (ref.includes("/")) {
      const hashIndex = ref.indexOf("#");
      repoName = ref.slice(0, hashIndex);
      issueNumber = ref.slice(hashIndex + 1);
    } else {
      repoName = repo;
      issueNumber = ref.slice(1);
    }
    const number = Number.parseInt(issueNumber, 10);
    if (Number.isNaN(number)) continue;
    items.push({ ref, repo: repoName, number });
    if (items.length >= MAX_LINKED_ISSUES) break;
  }
  return items;
}

/** Label names from an issue object (GitHub REST shape); empty when
 * unusable. */
export function labelsOf(issue: unknown): string[] {
  if (typeof issue !== "object" || issue === null) return [];
  const labels = (issue as Record<string, unknown>).labels;
  if (!Array.isArray(labels)) return [];
  const names: string[] = [];
  for (const label of labels) {
    const name = typeof label === "object" && label !== null
      ? (label as Record<string, unknown>).name
      : label;
    if (typeof name === "string" && name.trim()) names.push(name.trim());
  }
  return names;
}
