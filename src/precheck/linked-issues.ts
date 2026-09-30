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

/** Hard safety bound on raw extraction (#872 follow-up): the accepted-issue
 * cap (`MAX_LINKED_ISSUES`) is enforced downstream, over issues that
 * actually get fetched and accepted (see `buildLinkedIssueContext`), not
 * over raw refs — a title `(#N)` that turns out to name a pull request must
 * not evict a real 8th body issue. Extraction itself still needs *some*
 * bound so a pathological body cannot force unbounded fetches; this is
 * generous (4x the accepted cap) precisely because it is not the real cap. */
export const MAX_LINKED_ISSUE_CANDIDATES = MAX_LINKED_ISSUES * 4;

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
 * by CANONICAL IDENTITY in order of appearance (hard bound
 * `MAX_LINKED_ISSUE_CANDIDATES`; see its docstring for why this isn't the
 * accepted-issue cap): first the title's trailing `(#N)` convention, then
 * closing-keyword body references, then non-closing implementation body
 * references. A bare `#N` resolves against the default repo, so a bare
 * `#584` and an explicit `owner/repo#584` naming the same repo (compared
 * case-insensitively) are the SAME identity, not two entries.
 * Dedupe is a merge, not a first-write-wins: if an identity first appears in
 * a non-closing form and a later occurrence is a closing-keyword form, the
 * existing entry is upgraded to `closing: true` in place — the returned
 * list's order (position of first occurrence, in its first-seen spelling)
 * never changes, and an already-closing entry is never downgraded. */
export function extractLinkedIssueRefs(body: string, defaultRepo?: string, title?: string): LinkedIssueRef[] {
  const repo = defaultRepo ?? "";
  const byKey = new Map<string, LinkedIssueRef>();
  const items: LinkedIssueRef[] = [];

  const add = (ref: string, closing: boolean): void => {
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
    const canonicalKey = `${repoName.toLowerCase()}#${number}`;
    const existing = byKey.get(canonicalKey);
    if (existing) {
      if (closing) existing.closing = true;
      return;
    }
    if (items.length >= MAX_LINKED_ISSUE_CANDIDATES) return;
    const item: LinkedIssueRef = { ref, repo: repoName, number, closing };
    byKey.set(canonicalKey, item);
    items.push(item);
  };

  const titleMatch = TITLE_TRAILING_ISSUE_REF_PATTERN.exec((title ?? "").trim());
  if (titleMatch) add(titleMatch[1] ?? "", false);

  for (const match of (body ?? "").matchAll(GITHUB_ISSUE_REF_PATTERN)) {
    if (items.length >= MAX_LINKED_ISSUE_CANDIDATES) break;
    add(match[1] ?? "", true);
  }
  for (const match of (body ?? "").matchAll(IMPLEMENTATION_ISSUE_REF_PATTERN)) {
    if (items.length >= MAX_LINKED_ISSUE_CANDIDATES) break;
    add(match[1] ?? "", false);
  }

  return items;
}

/** True when a fetched GitHub/Forgejo "issue" payload is actually a pull
 * request (#872): both platforms' issue-fetch APIs return PRs through the
 * same endpoint, distinguished only by a `pull_request` object on the raw
 * payload (GitHub natively; Forgejo's normalized shape passes it through —
 * see `normalizeForgejoIssue`). A trailing `(#N)` on a squash-merge or
 * automation-authored title very often names the PR that produced it, not
 * an issue, and that PR's own content must never masquerade as issue
 * guidance — in `linked-issues.md` / the requirement ledger, or in the
 * #633 selection fingerprint. */
export function isPullRequestPayload(data: unknown): boolean {
  return typeof data === "object" && data !== null && !Array.isArray(data)
    && (data as Record<string, unknown>).pull_request != null;
}

export type LinkedIssueFetchResult = { ok: true; data: unknown } | { ok: false; error: string };

export type LinkedIssueOutcome =
  | { kind: "accepted"; ref: LinkedIssueRef; data: unknown }
  | { kind: "pull_request_skip"; ref: LinkedIssueRef }
  | { kind: "fetch_failed"; ref: LinkedIssueRef; error: string };

/** Shared accepted-issue iteration (#872 cross-stage fix): `buildLinkedIssueContext`
 * (src/context/linked-issue-context.ts) and `buildSelectionSignature`
 * (src/precheck/selection.ts) MUST apply identical accepted-issue semantics
 * over the same candidate list, or their two views of "the linked issues"
 * can diverge — a title ref that resolves to a pull request must not
 * consume one of the `cap` slots in either place, or a body issue evicted
 * from one stage but not the other lets a label change perturb one signal
 * (classification) without perturbing the other (the stale-review
 * fingerprint), or vice versa, silently letting precheck skip a review that
 * should have re-run.
 *
 * Iterates `refItems` (the FULL uncapped candidate list from
 * `extractLinkedIssueRefs`, itself bounded by `MAX_LINKED_ISSUE_CANDIDATES`)
 * in order, calling `fetchIssue` for each until `cap` issues have been
 * ACCEPTED — successfully fetched and, for a non-closing ref, not a
 * pull-request payload. A pull-request payload on a non-closing ref is a
 * skip: it consumes a fetch (so its content is known), never a slot.
 * Closing-keyword refs are never rejected as pull requests (parity with
 * pre-#872 fetch behavior). This generator makes no fail-open/fail-closed
 * decision on a fetch failure — that is the caller's call: one stage may
 * continue past a failure (recording it) while another aborts entirely on
 * the first one. Because refs beyond `cap` accepted issues are never
 * reached, stopping consumption of the generator early (e.g. via `return`
 * from a `for await` loop) never triggers any further fetches. */
export async function* acceptedLinkedIssues(
  refItems: readonly LinkedIssueRef[],
  fetchIssue: (repo: string, number: number) => Promise<LinkedIssueFetchResult>,
  cap: number = MAX_LINKED_ISSUES,
): AsyncGenerator<LinkedIssueOutcome, void, void> {
  let accepted = 0;
  for (const ref of refItems) {
    if (accepted >= cap) return;
    const fetched = await fetchIssue(ref.repo, ref.number);
    if (fetched.ok && !ref.closing && isPullRequestPayload(fetched.data)) {
      yield { kind: "pull_request_skip", ref };
    } else if (fetched.ok) {
      accepted += 1;
      yield { kind: "accepted", ref, data: fetched.data };
    } else {
      yield { kind: "fetch_failed", ref, error: fetched.error };
    }
  }
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
