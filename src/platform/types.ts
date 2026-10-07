/** Platform adapter contract (#674): the typed seam every host-forge
 * interaction goes through. Shapes mirror the v2 platform seam so callers
 * cannot tell which platform served a payload. */

export interface ManagedComment {
  id?: number | string | undefined;
  body: string;
  created_at?: string | undefined;
  updated_at?: string | undefined;
  /** #970: the forge-reported author login (never body content). Undefined
   * when the forge did not report one — treated as unproven ownership. */
  author?: string | undefined;
}

export interface ManagedReview {
  body: string;
  submitted_at?: string | undefined;
  /** #970: the forge-reported author login (never body content). Undefined
   * when the forge did not report one — treated as unproven ownership. */
  author?: string | undefined;
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
  /** #970: the forge-authenticated login this run's token posts as. GitHub
   * resolves it from GraphQL `query { viewer { login } }` — the only source
   * that answers for a GitHub App installation token or `GITHUB_TOKEN` (REST
   * `GET /user` returns 403 "Resource not accessible by integration" for
   * both) — with REST `/user` as a fallback; Forgejo uses `/user`. It returns
   * the app's bot account (`<slug>[bot]`), `github-actions[bot]` for
   * `GITHUB_TOKEN`, and the user login for a PAT/OAuth token, so it survives
   * supported token/identity changes and is never inferred from a comment
   * body. `null` when ownership cannot be proven (no token, transport/auth
   * failure, or an unusable payload) — callers must fail closed rather than
   * treat an unproven identity as trusted. */
  authenticatedIdentity(): Promise<string | null>;
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

export interface ForgejoSelfStatusDiscovery {
  found: boolean;
  ambiguous: boolean;
  matchCount: number;
  context: string | null;
  runJobs: "unknown" | "single" | "multi" | "unavailable";
  runJobCount: number | null;
  runJobCountExact: boolean;
  runJobHtmlUrl: string | null;
  runJobsUnavailableReason: string | null;
}

export interface ExternalChecksOptions extends CiBoundOptions {
  /** `GITHUB_RUN_ID`: our own workflow run's check runs are excluded. */
  runId?: string | undefined;
  /** `CI_STATUS_CONTEXT` (default `pr-reviewer-action`): our own commit
   * status context is excluded. */
  statusContext?: string | undefined;
  /** Forgejo auto mode: candidate per-repository run numbers. When provided,
   * context-based exclusion and its guessed default are disabled because
   * Forgejo contexts are unstable. */
  selfRunNumbers?: readonly string[] | undefined;
  /** Trusted Forgejo origin for absolute target-URL host validation. */
  selfRunOrigin?: string | undefined;
  /** Forgejo workflow run database ID used only for the Actions jobs API,
   * never as a target-URL matching candidate. */
  selfRunId?: string | undefined;
  /** Repo full name used to scope Forgejo Actions target URLs. */
  selfRunRepo?: string | undefined;
  /** Mutable per-gate discovery cache filled by the Forgejo adapter in auto
   * mode. `runJobs` is retried while unknown and cached after a definitive
   * single/multi/unavailable result; `runJobHtmlUrl` is the exact-join key. */
  selfStatusDiscovery?: ForgejoSelfStatusDiscovery | undefined;
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
 * `pr_reviewer/forgejo_backend.py`) byte for byte at the value level; pinned
 * by `tests-v3/platform.test.ts` / `platform-reads.test.ts`.
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
