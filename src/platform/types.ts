/** Platform adapter contract (#674): the typed seam every host-forge
 * interaction goes through. Shapes mirror the v2 platform seam so callers
 * cannot tell which platform served a payload. */

export interface ManagedComment {
  id?: number | string | undefined;
  body: string;
  created_at?: string | undefined;
  updated_at?: string | undefined;
}

export interface ManagedReview {
  body: string;
  submitted_at?: string | undefined;
}

export interface GhApiResult {
  data?: unknown;
  error?: string;
}

export interface PlatformAdapter {
  readonly platform: "github" | "forgejo";
  /** PR object (GitHub REST shape) or null when the fetch fails. */
  getPr(): Promise<unknown | null>;
  /** Raw unified diff text; "" when unavailable. */
  getPrDiff(): Promise<string>;
  listIssueComments(): Promise<ManagedComment[]>;
  listPrReviews(): Promise<ManagedReview[]>;
  /** "read" | "write" | "admin" | "unknown" | null (transport failure).
   * GitHub returns "unknown": coarse repo permission cannot infer the
   * unit-scoped GitHub App token permissions. */
  repoPermission(): Promise<string | null>;
  /** The validated read-only API seam — the TS mirror of
   * `pr_reviewer.platform.gh_api`: returns `{"data": ...}` on success or
   * `{"error": ...}`, never throws for policy rejections. */
  ghApi(endpoint: string): Promise<GhApiResult>;
}

/** Outcome of a platform read that the v2 seam can fail: `ok` mirrors the
 * shell function's exit status, `data` its (parsed) stdout. */
export type ReadResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** CI-polling bounds for `externalChecks` (#663), taken from config/env by
 * the caller: `CI_API_TIMEOUT_SEC`, `CI_TIMEOUT_SEC`, `CI_DEADLINE_EPOCH`. */
export interface CiBoundOptions {
  apiTimeoutSec?: string | undefined;
  ciTimeoutSec?: string | undefined;
  deadlineEpoch?: string | undefined;
  /** Clock override for tests; epoch milliseconds. */
  now?: (() => number) | undefined;
}

export interface ExternalChecksOptions extends CiBoundOptions {
  /** `GITHUB_RUN_ID`: our own workflow run's check runs are excluded. */
  runId?: string | undefined;
  /** `CI_STATUS_CONTEXT` (default `pr-reviewer-action`): our own commit
   * status context is excluded. */
  statusContext?: string | undefined;
  /** v3 CI gate (#706 PR 6, deliberate divergence): a transient read failure
   * of EITHER underlying read — no response (timeout, transport error,
   * exhausted deadline), HTTP 429/5xx, or a body that is not JSON — yields
   * `null` ("unknown, retry") instead of folding into the checks list. Off
   * (the default) keeps the v2 seam's fold byte for byte: a failed or
   * unparseable commit-status read there becomes `[]` ("no external CI").
   * A 2xx/4xx JSON answer is still an answer either way. */
  transientAsUnknown?: boolean | undefined;
}

/**
 * The read seams the v3 orchestrator consumes (#706 PR 1). Every method
 * matches the v2 seam's output shape (`scripts/platform_api.sh` /
 * `pr_reviewer/forgejo_backend.py`) byte for byte at the value level; the
 * `platform-normalization` parity boundary pins it.
 */
export interface PlatformReadAdapter extends PlatformAdapter {
  /** `platform_pr_files`: first page (100) of changed files — GitHub REST
   * shape, or the Forgejo `list_pr_files` normalization. */
  listPrFiles(): Promise<ReadResult<unknown>>;
  /** `platform_issue_get` for a linked issue (any repo on this forge). */
  getIssue(repo: string, issueNumber: string): Promise<ReadResult<unknown>>;
  /** `platform_pr_review_comments`: up to the 100 most recent PR
   * conversation comments as `{id,user,created_at,updated_at,body}`. */
  listPrConversationComments(): Promise<ReadResult<unknown[]>>;
  /** `platform_review_threads`: up to 100 inline review threads in the
   * review_threads.py shape. */
  listReviewThreads(): Promise<ReadResult<unknown[]>>;
  /** #812: the PR body and the instant of its latest edit as ONE atomic
   * snapshot — on GitHub both fields come from the same GraphQL document
   * (`body`, `lastEditedAt`; the latter never moves on pushes, comments or
   * label changes, and is null when the body was never edited). The body is
   * the authoritative description the corpus presents, and `editedAt` is the
   * only cutoff the discussion renderers of that pass may label with.
   * Backends without such a snapshot do not implement this method: the
   * REST-fetched body is presented and nothing is softened. Never throws. */
  getPrBodyRevision?(): Promise<{ body: string; editedAt: string | null } | null>;
  /** `platform_pr_reviews ... paginate`: every review, the shape
   * human_reviews.py consumes. */
  listPrReviewsPaginated(): Promise<ReadResult<unknown[]>>;
  /** `platform_external_checks`: normalized external checks with
   * self-exclusion; `null` when both underlying reads came back empty (the
   * caller's transient-failure signal) or, under `transientAsUnknown`, when
   * either read failed transiently. Never throws. */
  externalChecks(sha: string, options?: ExternalChecksOptions): Promise<{ name: unknown; state: string }[] | null>;
}
