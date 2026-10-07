/** Pure normalizers for the platform read seams (#706 PR 1).
 *
 * Each function is the port of one v2 projection and is pinned by
 * `tests-v3/platform.test.ts` / `platform-reads.test.ts`:
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
import type { ExternalCheck } from "./types.js";
export type { ExternalCheck } from "./types.js";

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

function rawConclusion(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
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

function trimmedRunNumbers(runNumbers: readonly string[]): string[] {
  return [...new Set(runNumbers.map((value) => value.trim()).filter((value) => /^\d+$/.test(value)))];
}

function escapeRepoPart(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function forgejoSelfRunOrigin(forgejoApiUrl: string, githubServerUrl: string): string {
  for (const value of [forgejoApiUrl, githubServerUrl]) {
    if (value.trim() === "") continue;
    try {
      const parsed = new URL(value);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host !== "") return parsed.origin;
    } catch {
      // Try the fallback URL when the preferred runner URL is malformed.
    }
  }
  return "";
}

function forgejoRunUrlPattern(runNumber: string, repo: string): RegExp | null {
  const parts = repo.split("/");
  if (parts.length !== 2 || parts.some((part) => part === "")) return null;
  const escapedRepo = parts.map(escapeRepoPart).join("/");
  const escapedRunNumber = runNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|/)${escapedRepo}/actions/runs/${escapedRunNumber}(/|$)`);
}

function forgejoTargetPath(targetUrl: string, selfRunOrigin: string): string | null {
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(targetUrl);
  let trustedOrigin: string | null = null;
  if (selfRunOrigin !== "") {
    try {
      const trusted = new URL(selfRunOrigin);
      if ((trusted.protocol === "http:" || trusted.protocol === "https:") && trusted.host !== "") {
        trustedOrigin = trusted.origin;
      }
    } catch {
      // Absolute target URLs cannot be trusted without a valid runner origin.
    }
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(targetUrl)) {
    try {
      const parsed = new URL(targetUrl);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || trustedOrigin === null) return null;
      if (parsed.origin !== trustedOrigin) return null;
      return parsed.pathname;
    } catch {
      return null;
    }
  }
  if (targetUrl.startsWith("//")) {
    try {
      const parsed = new URL(`https:${targetUrl}`);
      if (trustedOrigin === null || parsed.origin !== trustedOrigin) return null;
      return parsed.pathname;
    } catch {
      return null;
    }
  }
  if (hasScheme) return null;
  const path = targetUrl.split(/[?#]/, 1)[0] ?? "";
  try {
    return new URL(path, "https://relative.invalid").pathname;
  } catch {
    return null;
  }
}

function forgejoStatusState(status: Record<string, unknown>): unknown {
  return status.state ?? status.status;
}

function forgejoStatusMatchesRun(
  status: unknown,
  runNumbers: readonly string[],
  repo: string,
  selfRunOrigin: string,
): boolean {
  if (!isPlainObject(status) || typeof status.target_url !== "string") return false;
  if (forgejoStatusState(status) !== "pending") return false;
  const path = forgejoTargetPath(status.target_url, selfRunOrigin);
  if (path === null) return false;
  return runNumbers.some((runNumber) => forgejoRunUrlPattern(runNumber, repo)?.test(path) === true);
}

export interface ForgejoSelfStatusMatches {
  count: number;
  index: number | null;
  context: string | null;
}

export type ForgejoRunJobsNormalization =
  | { state: "single"; count: 1; exact: true; htmlUrl: string }
  | { state: "multi"; count: number; exact: boolean }
  | { state: "unavailable"; count: null; exact: false };

/** Normalize the Forgejo jobs API's documented plain-array shape and
 * defensive total_count envelopes. Never call a truncated page single-job. */
export function normalizeForgejoRunJobs(data: unknown, pageSize = 50): ForgejoRunJobsNormalization {
  const envelope = isPlainObject(data) ? data : null;
  const jobs = Array.isArray(data) ? data : envelope && Array.isArray(envelope.jobs) ? envelope.jobs : null;
  if (jobs === null) return { state: "unavailable", count: null, exact: false };

  const hasTotal = envelope !== null && Object.hasOwn(envelope, "total_count");
  const totalCount = envelope?.total_count;
  const validTotal = typeof totalCount === "number" && Number.isSafeInteger(totalCount) && totalCount >= 0;
  if (hasTotal && !validTotal) return { state: "unavailable", count: null, exact: false };
  const hasMore = envelope?.has_more === true || envelope?.hasMore === true
    || (typeof envelope?.next_page === "number" && envelope.next_page > 0)
    || (typeof envelope?.nextPage === "number" && envelope.nextPage > 0);
  if (validTotal && totalCount > jobs.length) {
    return { state: "multi", count: totalCount, exact: true };
  }
  if (hasMore || jobs.length >= pageSize) {
    const lowerBound = Math.max(validTotal ? totalCount : 0, jobs.length + (hasMore ? 1 : 0));
    return { state: "multi", count: lowerBound, exact: false };
  }

  if (validTotal && totalCount !== jobs.length) return { state: "unavailable", count: null, exact: false };
  if (jobs.length > 1) return { state: "multi", count: jobs.length, exact: true };
  if (jobs.length === 0) return { state: "unavailable", count: null, exact: false };
  const only = jobs[0];
  if (!isPlainObject(only) || typeof only.html_url !== "string") {
    return { state: "unavailable", count: null, exact: false };
  }
  return { state: "single", count: 1, exact: true, htmlUrl: only.html_url };
}

/** Both URLs must be same-origin (when absolute) and resolve to the same
 * normalized path before a single-job result can identify the status. */
export function forgejoJobStatusPathsMatch(jobHtmlUrl: string, targetUrl: string, selfRunOrigin: string): boolean {
  const jobPath = forgejoTargetPath(jobHtmlUrl, selfRunOrigin);
  const statusPath = forgejoTargetPath(targetUrl, selfRunOrigin);
  return jobPath !== null && statusPath !== null && jobPath === statusPath;
}

/** Find pending Forgejo statuses scoped to this repository and runner origin.
 * Terminal statuses cannot be this still-running job, so stale terminal entries
 * are ignored and sibling failures stay visible. A pending sibling can still be
 * the sole visible match before our status is published; the multi-job
 * ambiguity guard cannot resolve that race, so the gate's two-interval empty
 * finalize rule remains the last protection. */
export function forgejoSelfStatusMatches(
  statuses: readonly unknown[],
  runNumbers: readonly string[],
  repo: string,
  selfRunOrigin = "",
): ForgejoSelfStatusMatches {
  const candidates = trimmedRunNumbers(runNumbers);
  const matches = candidates.length === 0 || repo === ""
    ? []
    : statuses.flatMap((status, index) => forgejoStatusMatchesRun(status, candidates, repo, selfRunOrigin) ? [index] : []);
  const index = matches.length === 1 ? matches[0]! : null;
  const matchedStatus = index === null ? null : statuses[index];
  return {
    count: matches.length,
    index,
    context: isPlainObject(matchedStatus) && typeof matchedStatus.context === "string" ? matchedStatus.context : null,
  };
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
  opts?: {
    selfRunNumbers?: readonly string[] | undefined;
    selfStatusIndex?: number | undefined;
    githubWorkflow?: string | undefined;
    githubJob?: string | undefined;
  },
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
  const autoSelfExclusion = opts?.selfRunNumbers !== undefined;
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
    const allCheckRuns = jqEachOpt(jqField(runs, "check_runs"));
    const currentRunMatches = (run: unknown): boolean => selfRun !== null
      && (jqTest(jqAlt(jqField(run, "details_url"), ""), selfRun)
        || jqTest(jqAlt(jqField(run, "html_url"), ""), selfRun));
    const nestedField = (value: unknown, parent: string, field: string): unknown => {
      if (!isPlainObject(value) || !isPlainObject(value[parent])) return undefined;
      return value[parent][field];
    };
    const workflow = opts?.githubWorkflow?.trim() ?? "";
    const job = opts?.githubJob?.trim() ?? "";
    const nameExcluded = (run: unknown): boolean => {
      if (workflow === "" && job === "") return false;
      const appSlug = nestedField(run, "app", "slug");
      if (appSlug !== "github-actions") return false;
      const name = jqAlt(jqField(run, "name"), "");
      if (typeof name !== "string") return false;
      const trimmed = name.trim();
      return (workflow !== "" && trimmed.startsWith(`${workflow} / `))
        || (job !== "" && (trimmed === job || trimmed.startsWith(`${job} (`)));
    };
    const currentRun = allCheckRuns.filter(currentRunMatches);
    const ownWorkflowRuns = allCheckRuns.filter(nameExcluded);
    const ownSuiteIds = new Set<string>();
    for (const run of [...currentRun, ...ownWorkflowRuns]) {
      const suiteId = nestedField(run, "check_suite", "id");
      if (typeof suiteId === "string" || typeof suiteId === "number") ownSuiteIds.add(String(suiteId));
      const suiteUrl = nestedField(run, "check_suite", "url");
      if (typeof suiteUrl === "string") {
        const match = suiteUrl.match(/\/check-suites\/(\d+)(?:\b|$)/);
        if (match) ownSuiteIds.add(match[1]!);
      }
    }
    const survivingRuns = allCheckRuns.filter((run) => {
      if (currentRunMatches(run) || nameExcluded(run)) return false;
      const suiteId = nestedField(run, "check_suite", "id");
      if ((typeof suiteId === "string" || typeof suiteId === "number") && ownSuiteIds.has(String(suiteId))) return false;
      const suiteUrl = nestedField(run, "check_suite", "url");
      if (typeof suiteUrl === "string") {
        const match = suiteUrl.match(/\/check-suites\/(\d+)(?:\b|$)/);
        if (match && ownSuiteIds.has(match[1]!)) return false;
      }
      return true;
    });
    const latestByName = new Map<string, { run: unknown; index: number }>();
    const timestamp = (value: unknown): number => {
      if (typeof value !== "string" || value === "") return Number.NEGATIVE_INFINITY;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    };
    const isPending = (run: unknown): boolean => jqField(run, "status") !== "completed";
    const compareTimestamp = (left: unknown, right: unknown): number => {
      const a = timestamp(left);
      const b = timestamp(right);
      return a === b ? 0 : a > b ? 1 : -1;
    };
    const newer = (candidate: unknown, existing: unknown): boolean => {
      const started = compareTimestamp(jqField(candidate, "started_at"), jqField(existing, "started_at"));
      if (started !== 0) return started > 0;
      const completed = compareTimestamp(jqField(candidate, "completed_at"), jqField(existing, "completed_at"));
      if (completed !== 0) return completed > 0;
      return isPending(candidate) && !isPending(existing);
    };
    for (const [index, run] of survivingRuns.entries()) {
      const name = jqAlt(jqField(run, "name"), "(unnamed)");
      const key = `${typeof name}:${JSON.stringify(name)}`;
      const existing = latestByName.get(key);
      if (!existing || newer(run, existing.run)) latestByName.set(key, { run, index });
    }
    const checkRuns = [...latestByName.values()]
      .sort((a, b) => a.index - b.index)
      .map(({ run }): ExternalCheck => {
        const completed = jqField(run, "status") === "completed";
        const conclusion = completed ? rawConclusion(jqField(run, "conclusion")) : undefined;
        return {
          name: jqAlt(jqField(run, "name"), "(unnamed)"),
          state: checkRunState(run),
          ...(conclusion === undefined ? {} : { conclusion }),
        };
      });
    const statusEntries = jqEachOpt(jqField(combined, "statuses"));
    const selfStatusIndex = opts?.selfStatusIndex;
    const excludedSelfStatus = autoSelfExclusion && selfStatusIndex !== undefined
      && selfStatusIndex >= 0 && selfStatusIndex < statusEntries.length;
    const statuses = statusEntries
      .filter((status, index) => autoSelfExclusion
        ? index !== selfStatusIndex
        : jqCompare(jqField(status, "context"), ctx) !== 0)
      .map((status): ExternalCheck => {
        const conclusion = rawConclusion(jqField(status, "state"));
        return {
          name: jqAlt(jqField(status, "context"), "(status)"),
          state: statusState(status),
          ...(conclusion === undefined ? {} : { conclusion }),
        };
      });
    const external = [...checkRuns, ...statuses];
    if (external.length > 0) return external;
    if (excludedSelfStatus) return [];
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

