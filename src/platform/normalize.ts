/** Pure normalizers for the platform read seams (#706 PR 1).
 *
 * Each function is the port of one v2 projection and is pinned by the
 * `platform-normalization` parity boundary:
 *
 * - GitHub: the jq programs in `scripts/platform_api.sh`
 *   (`platform_pr_review_comments`, `platform_review_threads`,
 *   `platform_external_checks`) and the `pr-files.json` projection in
 *   `scripts/sections/context.sh`;
 * - Forgejo: the normalizers in `pr_reviewer/forgejo_backend.py`
 *   (`list_pr_files`, `fetch_issue`, `_forgejo_comment_to_standard`,
 *   `list_review_threads`, `_forgejo_review_to_github`, `get_commit_status`,
 *   `fetch_forge_release`).
 *
 * A normalizer throws exactly where its v2 counterpart raises (`JqError` /
 * `PyError`); adapters turn that into a failed read, as the v2 shell seam
 * turns a nonzero exit into a failed fetch. */

import { isPlainObject, jqAlt, jqCompact, jqCompare, jqEach, jqEachOpt, jqField, JqError, jqPath, jqSortBy } from "./jq.js";
import { pyCompareTuples, pyDict, pyGet, pyIsInt, pyOr, PyError, pyStr, pyTruthy } from "./py.js";

// ── GraphQL queries (verbatim from scripts/platform_api.sh) ─────────────

export const GITHUB_CONVERSATION_COMMENTS_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { comments(last: 100) { nodes { databaseId body createdAt updatedAt author { login } } } } } }";

export const GITHUB_REVIEW_THREADS_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(last: 100) { nodes { id isResolved isOutdated path line originalLine comments(first: 50) { nodes { databaseId body createdAt updatedAt author { login } } } } } } } }";

/** #812: body and `lastEditedAt` in ONE document — the atomic snapshot the
 * whole metadata pass consumes. `lastEditedAt` is the body's own edit
 * timestamp: it moves only when the description is edited (never on pushes,
 * comments or label changes) and is null when the body was never edited.
 * The REST PR object has no equivalent, which is why the pair cannot come
 * from two separate reads. */
export const GITHUB_PR_BODY_REVISION_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { body lastEditedAt } } }";

// ── PR files ────────────────────────────────────────────────────────────

/** `list_pr_files` (Forgejo): a non-list payload is `[]`; a non-dict entry
 * raises. */
export function normalizeForgejoPrFiles(data: unknown): unknown[] {
  if (!Array.isArray(data)) return [];
  return data.map((entry) => {
    const f = pyDict(entry, "file");
    return {
      filename: pyGet(f, "filename", pyGet(f, "path", "")),
      status: pyGet(f, "status", "changed"),
      additions: pyGet(f, "additions", 0),
      deletions: pyGet(f, "deletions", 0),
      changes: pyGet(f, "changes", 0),
      patch: pyGet(f, "patch", ""),
      previous_filename: pyGet(f, "previous_filename", null),
    };
  });
}

/** The `pr-files.json` projection from `scripts/sections/context.sh`:
 * `jq -c --argjson total N '[.[] | {filename,status,additions,deletions,
 * changes,previous_filename}] + (if $total > 100 then [{note: ...}] else []
 * end)'`. Returns the exact file bytes (one compact line + newline); throws
 * `JqError` where jq would exit nonzero. */
export function projectPrFiles(raw: unknown, totalChangedFiles: number): string {
  const files = jqEach(raw).map((f) => ({
    filename: jqField(f, "filename"),
    status: jqField(f, "status"),
    additions: jqField(f, "additions"),
    deletions: jqField(f, "deletions"),
    changes: jqField(f, "changes"),
    previous_filename: jqField(f, "previous_filename"),
  }));
  const projected: unknown[] = totalChangedFiles > 100
    ? [...files, { note: `file list truncated to first 100 of ${totalChangedFiles} changed files` }]
    : files;
  return `${jqCompact(projected)}\n`;
}

// ── Linked issue ────────────────────────────────────────────────────────

/** `fetch_issue` (Forgejo) for a decoded 200 payload. `null` (undecodable
 * body) stays `null`; a non-dict payload raises. */
export function normalizeForgejoIssue(data: unknown): unknown {
  if (data === null) return null;
  const issue = pyDict(data, "issue");
  return {
    body: pyGet(issue, "body", ""),
    title: pyGet(issue, "title", ""),
    state: pyGet(issue, "state", "open"),
    created_at: pyGet(issue, "created_at", ""),
    updated_at: pyGet(issue, "updated_at", ""),
    // Passed through, not part of the v2 shape (#872): Forgejo/Gitea's
    // issues API returns pull requests through this same endpoint, marked
    // by a `pull_request` object — `isPullRequestPayload` reads it to reject
    // a non-closing linked ref that actually names a PR. Ignored by every
    // v2-parity consumer (`projectLinkedIssue` whitelists its own fields).
    pull_request: pyGet(issue, "pull_request", null),
  };
}

// ── PR conversation comments ────────────────────────────────────────────

function conversationNode(node: unknown): Record<string, unknown> {
  return {
    id: jqField(node, "databaseId"),
    user: jqAlt(jqPath(node, "author", "login"), ""),
    created_at: jqAlt(jqField(node, "createdAt"), ""),
    updated_at: jqAlt(jqField(node, "updatedAt"), ""),
    body: jqAlt(jqField(node, "body"), ""),
  };
}

/** GitHub GraphQL `comments(last: 100)` → `[{id,user,created_at,updated_at,
 * body}]` sorted oldest-first by `(created_at, id)`. */
export function normalizeGithubConversationComments(response: unknown): unknown[] {
  const nodes = jqEach(jqPath(response, "data", "repository", "pullRequest", "comments", "nodes"));
  const items = nodes.map(conversationNode);
  return jqSortBy(items, (item) => [jqAlt(item.created_at, ""), jqAlt(item.id, 0)]);
}

/** `_forgejo_comment_to_standard`. */
export function forgejoCommentToStandard(raw: unknown): Record<string, unknown> {
  const comment = pyDict(raw, "comment");
  const user = pyDict(pyGet(comment, "user", {}), "user");
  return {
    id: pyGet(comment, "id", 0),
    body: pyGet(comment, "body", ""),
    created_at: pyGet(comment, "created_at", pyGet(comment, "created_on", "")),
    updated_at: pyGet(comment, "updated_at", pyGet(comment, "updated_on", "")),
    user: pyGet(user, "login", ""),
  };
}

/** Forgejo `list-comments` piped through `jq 'sort_by(.created_at // "") |
 * reverse | .[0:100]'` — note the v2 Forgejo branch is newest-first while
 * the GitHub branch is oldest-first; `pr_thread` re-sorts both. */
export function normalizeForgejoConversationComments(rawComments: readonly unknown[]): unknown[] {
  const standard = rawComments.map(forgejoCommentToStandard);
  return jqSortBy(standard, (item) => jqAlt(item.created_at, "")).reverse().slice(0, 100);
}

// ── Review threads ──────────────────────────────────────────────────────

/** GitHub GraphQL `reviewThreads(last: 100)` → the review_threads.py shape. */
export function normalizeGithubReviewThreads(response: unknown): unknown[] {
  const nodes = jqEach(jqPath(response, "data", "repository", "pullRequest", "reviewThreads", "nodes"));
  return nodes.map((node) => ({
    thread_id: jqField(node, "id"),
    path: jqAlt(jqField(node, "path"), ""),
    line: jqField(node, "line"),
    original_line: jqField(node, "originalLine"),
    resolved: jqAlt(jqField(node, "isResolved"), false),
    outdated: jqAlt(jqField(node, "isOutdated"), false),
    comments: jqEach(jqPath(node, "comments", "nodes")).map(conversationNode),
  }));
}

/** `list_review_threads` gate: which review ids get their comments fetched
 * (`isinstance(review.get("id"), int)`, bool included). Returns the id as it
 * appears in the v2 URL (`str(review_id)`), or null to skip the review. */
export function forgejoReviewCommentId(review: unknown): string | null {
  if (!isPlainObject(review)) return null;
  const id = review.id;
  return pyIsInt(id) ? pyStr(id) : null;
}

function anchorKey(anchor: unknown): string {
  if (anchor === null || anchor === undefined) return "none";
  if (typeof anchor === "boolean") return `n:${anchor ? 1 : 0}`;
  if (typeof anchor === "number") return `n:${anchor}`;
  if (typeof anchor === "string") return `s:${anchor}`;
  // Python: a list/dict anchor is unhashable as a dict key.
  throw new PyError("unhashable anchor");
}

interface ForgejoThread {
  thread_id: string;
  path: string;
  line: unknown;
  original_line: unknown;
  resolved: boolean;
  outdated: boolean;
  comments: { id: unknown; user: string; created_at: string; updated_at: string; body: string }[];
}

/** `list_review_threads` grouping (Forgejo): comments from every fetched
 * review (in review order) grouped by `(path, original_position ||
 * position)`; a group is resolved when any comment carries a resolver. */
export function groupForgejoReviewThreads(commentLists: readonly unknown[][]): unknown[] {
  const groups = new Map<string, ForgejoThread>();
  for (const comments of commentLists) {
    for (const comment of comments) {
      if (!isPlainObject(comment)) continue;
      const path = pyStr(pyOr(pyGet(comment, "path", null), ""));
      const original = pyGet(comment, "original_position", null);
      const position = pyGet(comment, "position", null);
      const anchor = pyIsInt(original) ? original : position;
      const key = `${path}\u0000${anchorKey(anchor)}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          thread_id: `${path}:${pyStr(anchor)}`,
          path,
          line: pyIsInt(position) ? position : null,
          original_line: pyIsInt(original) ? original : null,
          resolved: false,
          outdated: false,
          comments: [],
        };
        groups.set(key, group);
      }
      if (pyTruthy(pyGet(comment, "resolver", null))) group.resolved = true;
      const user = pyGet(comment, "user", null);
      group.comments.push({
        id: pyGet(comment, "id", null),
        user: isPlainObject(user) ? pyStr(pyOr(pyGet(user, "login", null), "")) : "",
        created_at: pyStr(pyOr(pyGet(comment, "created_at", null), "")),
        updated_at: pyStr(pyOr(pyGet(comment, "updated_at", null), "")),
        body: pyStr(pyOr(pyGet(comment, "body", null), "")),
      });
    }
  }
  const sortKey = (c: { id: unknown; created_at: string }): string[] => [c.created_at, pyStr(c.id)];
  const threads = [...groups.values()];
  for (const thread of threads) {
    thread.comments = thread.comments
      .map((c, i) => ({ c, i }))
      .sort((x, y) => pyCompareTuples(sortKey(x.c), sortKey(y.c)) || x.i - y.i)
      .map(({ c }) => c);
  }
  return threads
    .map((t, i) => ({ t, i }))
    .sort((x, y) => pyCompareTuples(sortKey(x.t.comments[0]!), sortKey(y.t.comments[0]!)) || x.i - y.i)
    .map(({ t }) => t);
}

// ── Reviews ─────────────────────────────────────────────────────────────

/** `_forgejo_review_to_github`. */
export function normalizeForgejoReview(raw: unknown): Record<string, unknown> {
  const review = pyDict(raw, "review");
  let state = pyStr(pyOr(pyOr(pyGet(review, "state", null), pyGet(review, "event", null)), "COMMENT")).toUpperCase();
  if (state === "APPROVE") state = "APPROVED";
  if (state === "REQUEST_CHANGES") state = "CHANGES_REQUESTED";
  return {
    id: pyGet(review, "id", 0),
    body: pyGet(review, "body", ""),
    state,
    user: pyGet(review, "user", {}),
    submitted_at: pyGet(review, "submitted_at", pyGet(review, "updated_at", "")),
    html_url: pyGet(review, "html_url", ""),
  };
}

/** `list_pr_reviews` (Forgejo) for a 200 payload: non-list → `[]`. */
export function normalizeForgejoReviews(data: unknown): unknown[] {
  return Array.isArray(data) ? data.map(normalizeForgejoReview) : [];
}

// ── CI checks ───────────────────────────────────────────────────────────

/** `get_commit_status` (Forgejo) for a decoded 200 payload; `null` stays
 * `null` (the CLI prints `null`). Each status entry gains `state` from
 * Forgejo's per-entry `status` field. */
export function normalizeForgejoCommitStatus(data: unknown): unknown {
  if (data === null) return null;
  const combined = pyDict(data, "combined status");
  const rawStatuses = pyOr(pyGet(combined, "statuses", []), []);
  // Python iterates a truthy non-list (str/dict keys/number) and `dict()`
  // of each element raises; only a list of dicts survives.
  if (!Array.isArray(rawStatuses)) throw new PyError("statuses is not a list");
  const statuses = rawStatuses.map((s) => {
    const entry: Record<string, unknown> = { ...pyDict(s, "status") };
    entry.state = pyGet(entry, "state", pyGet(entry, "status", null));
    return entry;
  });
  return { state: pyGet(combined, "state", "pending"), total_count: statuses.length, statuses };
}

function checkRunState(run: unknown): string {
  if (jqField(run, "status") !== "completed") return "pending";
  const conclusion = jqAlt(jqField(run, "conclusion"), "");
  return conclusion === "failure" || conclusion === "timed_out" || conclusion === "cancelled" || conclusion === "action_required"
    ? "failure"
    : "success";
}

function statusState(status: unknown): string {
  const state = jqField(status, "state");
  if (state === "failure" || state === "error") return "failure";
  if (state === "success") return "success";
  return "pending";
}

function jqTest(value: unknown, pattern: RegExp): boolean {
  if (typeof value !== "string") throw new JqError(`${typeof value} cannot be matched, as it is not a string`);
  return pattern.test(value);
}

export interface ExternalCheck {
  name: unknown;
  state: string;
}

/** `platform_external_checks`: fold the two captured stdouts (check-runs,
 * combined commit status) into `[{name, state}]` with self-exclusion.
 *
 * Mirrors the shell exactly, including its degraded paths:
 * - both captures empty → `null` (no output: the caller retries);
 * - either capture not valid JSON, or a jq type error → `[]` (the shell's
 *   `|| echo "[]"`);
 * - a non-object error body (e.g. a 404 `{message}`) is simply a payload
 *   with no checks. */
export function normalizeExternalChecks(
  runsText: string,
  combinedText: string,
  runId: string,
  statusContext: string,
): ExternalCheck[] | null {
  const runsCapture = runsText.replace(/\n+$/, "");
  const combinedCapture = combinedText.replace(/\n+$/, "");
  if (runsCapture === "" && combinedCapture === "") return null;
  let runs: unknown;
  let combined: unknown;
  try {
    runs = JSON.parse(runsCapture === "" ? "{}" : runsCapture);
    combined = JSON.parse(combinedCapture === "" ? "{}" : combinedCapture);
  } catch {
    return [];
  }
  const ctx = statusContext === "" ? "pr-reviewer-action" : statusContext;
  try {
    let selfRun: RegExp | null = null;
    if (runId !== "") {
      try {
        selfRun = new RegExp(`/runs/${runId}(/|$)`);
      } catch {
        throw new JqError("invalid regex");
      }
    }
    const checkRuns = jqEachOpt(jqField(runs, "check_runs"))
      .filter((run) => selfRun === null
        || !(jqTest(jqAlt(jqField(run, "details_url"), ""), selfRun) || jqTest(jqAlt(jqField(run, "html_url"), ""), selfRun)))
      .map((run): ExternalCheck => ({ name: jqAlt(jqField(run, "name"), "(unnamed)"), state: checkRunState(run) }));
    const statuses = jqEachOpt(jqField(combined, "statuses"))
      .filter((status) => jqCompare(jqField(status, "context"), ctx) !== 0)
      .map((status): ExternalCheck => ({ name: jqAlt(jqField(status, "context"), "(status)"), state: statusState(status) }));
    const external = [...checkRuns, ...statuses];
    if (external.length > 0) return external;
    const total = jqAlt(jqField(combined, "total_count"), 0);
    const aggregate = jqAlt(jqField(combined, "state"), "pending");
    if (jqCompare(total, 0) > 0 && (aggregate === "success" || aggregate === "failure" || aggregate === "error")) {
      const state = jqField(combined, "state");
      return [{ name: "(combined)", state: state === "failure" || state === "error" ? "failure" : "success" }];
    }
    return [];
  } catch (error) {
    if (error instanceof JqError) return [];
    throw error;
  }
}

// ── Linked-source enrichment ────────────────────────────────────────────

/** `fetch_forge_release` for a decoded 200 payload; non-dict → null. */
export function normalizeForgejoRelease(data: unknown, tag: string): Record<string, unknown> | null {
  if (!isPlainObject(data)) return null;
  return {
    tag_name: pyGet(data, "tag_name", tag),
    name: pyGet(data, "name", ""),
    published_at: pyGet(data, "published_at", pyGet(data, "created_at", "")),
    html_url: pyGet(data, "html_url", pyGet(data, "url", "")),
    body: pyGet(data, "body", ""),
  };
}

/** Decode a response body the way `forgejo_backend._json_decode` does:
 * blank or undecodable text is `null`. */
export function pyJsonDecode(text: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

