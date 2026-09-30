/** Linked-issue reference extraction (#674) — TS port of
 * `pr_reviewer/github_context.extract_linked_issue_refs`, extended (#872) to
 * also recognize the issue a PR implements when the closing-keyword
 * convention isn't used: a trailing `(#N)` / `(owner/repo#N)` on the PR
 * TITLE (the conventional-commit / squash-merge title convention), and
 * explicit non-closing implementation references in the body
 * (`Implements`/`Part of`/`Refs`/`Ref #N`). */

export interface LinkedIssueRef {
  ref: string;
  repo: string;
  number: number;
  /** True only for GitHub's own auto-close keyword forms
   * (Closes/Fixes/Resolves). False for the title's `(#N)` convention and for
   * non-closing body references (Implements/Part of/Refs) — those still feed
   * the requirement ledger as context, but must never be treated as "this PR
   * closes that issue". */
  closing: boolean;
}

export const MAX_LINKED_ISSUES = 8;

const GITHUB_ISSUE_REF_PATTERN = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?[ \t]+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)/gi;

/** Non-closing implementation references: `Implements`/`Part of`/`Refs`/
 * `Ref #N`. Deliberately excludes incidental mentions ("depends on #583",
 * bare "#12" in prose) and "Related to #N" (ambiguous between an
 * implementation reference and an incidental mention; left unlinked). */
const IMPLEMENTATION_ISSUE_REF_PATTERN = /\b(?:implements|part of|refs?)\s*:?[ \t]+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)/gi;

/** A trailing `(#N)` / `(owner/repo#N)` at the very end of the PR title —
 * the conventional-commit / squash-merge title convention. Not anchored
 * mid-title, so `fix bug (#123) more text` does not match. */
const TITLE_TRAILING_ISSUE_REF_PATTERN = /\(((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)\)[ \t]*$/;

/** Extract linked-issue references from a PR title and body, deduplicated
 * in order of appearance (max 8): first the title's trailing `(#N)`
 * convention, then closing-keyword body references, then non-closing
 * implementation body references. A bare `#N` uses the default repo. */
export function extractLinkedIssueRefs(body: string, defaultRepo?: string, title?: string): LinkedIssueRef[] {
  const repo = defaultRepo ?? "";
  const seen = new Set<string>();
  const items: LinkedIssueRef[] = [];

  const add = (ref: string, closing: boolean): void => {
    if (items.length >= MAX_LINKED_ISSUES) return;
    if (seen.has(ref)) return;
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
    if (Number.isNaN(number)) return;
    items.push({ ref, repo: repoName, number, closing });
  };

  const titleMatch = TITLE_TRAILING_ISSUE_REF_PATTERN.exec((title ?? "").trim());
  if (titleMatch) add(titleMatch[1] ?? "", false);

  for (const match of (body ?? "").matchAll(GITHUB_ISSUE_REF_PATTERN)) {
    if (items.length >= MAX_LINKED_ISSUES) break;
    add(match[1] ?? "", true);
  }
  for (const match of (body ?? "").matchAll(IMPLEMENTATION_ISSUE_REF_PATTERN)) {
    if (items.length >= MAX_LINKED_ISSUES) break;
    add(match[1] ?? "", false);
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
