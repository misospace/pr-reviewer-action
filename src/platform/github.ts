import { ciAttemptTimeoutMs, isTransientCiRead } from "./bounded.js";
import { validateEndpoint, type EndpointValidation } from "./endpoint.js";
import { PlatformRequestError, requestJson, requestText, type FetchLike } from "./http.js";
import {
  GITHUB_CONVERSATION_COMMENTS_QUERY,
  GITHUB_PR_BODY_REVISION_QUERY,
  GITHUB_REVIEW_THREADS_QUERY,
  normalizeExternalChecks,
  normalizeGithubConversationComments,
  normalizeGithubReviewThreads,
  type ExternalCheck,
} from "./normalize.js";
import { parseRepoRef, repoScopedUrl } from "./repo-ref.js";
import { GITHUB_API_BASE, parsePlatformBaseUrl } from "./urls.js";
import type {
  ExternalChecksOptions,
  GhApiResult,
  ManagedComment,
  ManagedReview,
  PlatformReadAdapter,
  ReadResult,
} from "./types.js";

/** gh follows `Link: rel="next"` without a page cap; this bound only stops
 * a hostile or looping API from paginating forever (100 x 100 reviews). */
const MAX_PAGES = 100;
const NUMBER_RE = /^[0-9]+$/;
const SHA_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(text: string): { ok: true; data: unknown } | { ok: false } {
  try {
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** #970: the forge-reported author login of a raw comment/review object
 * (`user.login`). Never reads body content; a missing or non-string login is
 * `undefined` (unproven ownership, which callers fail closed on). */
function githubAuthor(item: unknown): string | undefined {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
  const user = (item as Record<string, unknown>).user;
  if (user === null || typeof user !== "object" || Array.isArray(user)) return undefined;
  const login = (user as Record<string, unknown>).login;
  return typeof login === "string" && login !== "" ? login : undefined;
}

/** The `rel="next"` target of an RFC 8288 Link header, if any. */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /^\s*<([^>]*)>\s*;(.*)$/.exec(part);
    if (match && /(^|;)\s*rel="?next"?\s*(;|$)/.test(match[2] ?? "")) return match[1] ?? null;
  }
  return null;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;

export interface GitHubAdapterOptions {
  repo: string;
  prNumber: string;
  /** Pre-formatted Authorization value, e.g. `Bearer ghs_...`. */
  token?: string | undefined;
  /** Validated platform API base; defaults to https://api.github.com. */
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: FetchLike | undefined;
}

/**
 * GitHub REST adapter used by the precheck/fingerprint path (#674).
 *
 * The platform API base is validated before any credential is attached, and
 * every request carries `redirect: "manual"` so a redirecting host can never
 * capture the Authorization header. Linked-source enrichment against
 * third-party repos uses a separate client pinned to github.com (see
 * linked-source.ts) — never this adapter's base.
 */
export class GitHubAdapter implements PlatformReadAdapter {
  readonly platform = "github" as const;
  readonly repo: string;
  readonly prNumber: string;
  private readonly baseUrl: string;
  private readonly origin: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: GitHubAdapterOptions) {
    const parsed = parsePlatformBaseUrl(options.baseUrl ?? GITHUB_API_BASE, "GitHub API base URL");
    this.baseUrl = parsed.base;
    this.origin = parsed.origin;
    this.repo = options.repo;
    this.prNumber = options.prNumber;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** A repo-scoped REST URL, or null when the repo ref is invalid or the
   * normalized path escapes `/repos/<owner>/<name><staticTail>`. */
  private repoUrl(staticTail: string, dynamicTail = "", repo = this.repo): string | null {
    return repoScopedUrl(this.baseUrl, repo, staticTail, dynamicTail);
  }

  /** GraphQL endpoint for this API base: api.github.com/graphql, or
   * `<host>/api/graphql` for a GHES `<host>/api/v3` base. */
  private graphqlUrl(): string {
    return this.baseUrl.endsWith("/api/v3") ? `${this.baseUrl.slice(0, -"/v3".length)}/graphql` : `${this.baseUrl}/graphql`;
  }


  /** `gh api <path> --paginate` (#971): follow every Link target, merging
   * array pages in order. Any failed page fails the whole read. */
  private async paginatedRestArray(url: string | null): Promise<ReadResult<unknown[]>> {
    if (url === null) return { ok: false, error: "Refusing a request outside the repository" };
    const merged: unknown[] = [];
    for (let page = 0; url !== null; page += 1) {
      if (page >= MAX_PAGES) return { ok: false, error: `pagination exceeded ${MAX_PAGES} pages` };
      try {
        // requestText binds every page (including Link targets) to the
        // validated origin, so a hostile Link header cannot redirect the token.
        const target: string = url;
        const captured = await requestText(target, this.options());
        if (captured.status < 200 || captured.status >= 300) return { ok: false, error: `GitHub API error: ${captured.status}` };
        const parsed = parseJson(captured.text);
        if (!parsed.ok || !Array.isArray(parsed.data)) return { ok: false, error: "GitHub API returned a non-array page" };
        merged.push(...parsed.data);
        const next = nextLink(captured.headers.get("link"));
        url = next === null ? null : new URL(next, target).toString();
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    }
    return { ok: true, data: merged };
  }

  /** `gh api <path>`: ok only on a 2xx JSON body (gh exits nonzero on HTTP
   * errors, and the seam's callers treat that as a failed read). */
  private async restJson(url: string | null): Promise<ReadResult<unknown>> {
    if (url === null) return { ok: false, error: "Refusing a request outside the repository" };
    try {
      const { status, text } = await requestText(url, this.options());
      if (status < 200 || status >= 300) return { ok: false, error: `GitHub API error: ${status}` };
      const parsed = parseJson(text);
      return parsed.ok ? { ok: true, data: parsed.data } : { ok: false, error: "GitHub API returned invalid JSON" };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  /** `gh api graphql -f query=... -f owner -f name -F number | jq ...`:
   * an HTTP error or a non-empty `errors` array fails the read (gh exits
   * nonzero and `set -o pipefail` propagates it). */
  private async graphql(query: string): Promise<ReadResult<unknown>> {
    const ref = parseRepoRef(this.repo);
    if (ref === null) return { ok: false, error: `Invalid repo full name: ${this.repo}` };
    const { owner, name } = ref;
    const number: string | number = NUMBER_RE.test(this.prNumber) ? Number(this.prNumber) : this.prNumber;
    const body = JSON.stringify({ query, variables: { owner, name, number } });
    try {
      const { status, text } = await requestText(this.graphqlUrl(), { ...this.options(), method: "POST", body });
      if (status < 200 || status >= 300) return { ok: false, error: `GitHub GraphQL error: ${status}` };
      const parsed = parseJson(text);
      if (!parsed.ok) return { ok: false, error: "GitHub GraphQL returned invalid JSON" };
      const errors = typeof parsed.data === "object" && parsed.data !== null ? (parsed.data as Record<string, unknown>).errors : undefined;
      if (Array.isArray(errors) && errors.length > 0) return { ok: false, error: "GitHub GraphQL returned errors" };
      return { ok: true, data: parsed.data };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  /** `_gh_api_bounded gh api <path>` stdout: the body on any HTTP status
   * (gh relays error bodies on stdout, #190), "" on timeout, transport
   * failure, or an exhausted CI deadline (the attempt is skipped). */
  private async boundedStdout(url: string, options: ExternalChecksOptions): Promise<string> {
    return (await this.boundedRead(url, options)).text;
  }

  /** One bounded CI read with its HTTP status kept; `status` is null when no
   * response arrived (timeout, transport failure, or a skipped attempt). */
  private async boundedRead(url: string, options: ExternalChecksOptions): Promise<{ status: number | null; text: string }> {
    const timeoutMs = ciAttemptTimeoutMs(options);
    if (timeoutMs === null) return { status: null, text: "" };
    try {
      const { status, text } = await requestText(url, { ...this.options(), timeoutMs });
      return { status, text };
    } catch {
      return { status: null, text: "" };
    }
  }

  private options(accept?: string): Parameters<typeof requestJson>[1] {
    return {
      token: this.token,
      accept,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      allowedOrigin: this.origin,
    };
  }

  async getPr(): Promise<unknown | null> {
    const url = this.repoUrl("/pulls/", this.prNumber);
    if (url === null) return null;
    try {
      const { status, data } = await requestJson(url, this.options());
      return status === 200 ? data : null;
    } catch {
      return null;
    }
  }

  async getPrDiff(): Promise<string> {
    const url = this.repoUrl("/pulls/", this.prNumber);
    if (url === null) return "";
    try {
      const { status, text } = await requestText(
        url,
        this.options("application/vnd.github.v3.diff"),
      );
      return status === 200 ? text : "";
    } catch {
      return "";
    }
  }

  /** #812: the PR body and its last-edit instant from ONE GraphQL document.
   * A failed or unusable read returns null — the REST body is then
   * presented and nothing is softened; a cutoff is never paired with a body
   * it does not describe. */
  async getPrBodyRevision(): Promise<{ body: string; editedAt: string | null } | null> {
    const response = await this.graphql(GITHUB_PR_BODY_REVISION_QUERY);
    if (!response.ok) return null;
    try {
      const data = response.data as { data?: { repository?: { pullRequest?: { body?: unknown; lastEditedAt?: unknown } } } | null } | null;
      const pullRequest = data?.data?.repository?.pullRequest;
      if (pullRequest === null || pullRequest === undefined || typeof pullRequest.body !== "string") return null;
      const editedAt = pullRequest.lastEditedAt;
      return {
        body: pullRequest.body,
        editedAt: typeof editedAt === "string" && editedAt !== "" ? editedAt : null,
      };
    } catch {
      return null;
    }
  }

  async listIssueComments(): Promise<ManagedComment[]> {
    const url = this.repoUrl("/issues/", `${this.prNumber}/comments?per_page=100`);
    if (url === null) return [];
    const result = await this.paginatedRestArray(url);
    if (!result.ok) return [];
    return result.data.map((item): ManagedComment => {
      const record = item !== null && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
      const comment: ManagedComment = {
        body: typeof record.body === "string" ? record.body : "",
        author: githubAuthor(item),
      };
      if (typeof record.id === "number" || typeof record.id === "string") comment.id = record.id;
      if (typeof record.created_at === "string") comment.created_at = record.created_at;
      if (typeof record.updated_at === "string") comment.updated_at = record.updated_at;
      return comment;
    });
  }

  async listPrReviews(): Promise<ManagedReview[]> {
    const url = this.repoUrl("/pulls/", `${this.prNumber}/reviews?per_page=100`);
    if (url === null) return [];
    const result = await this.paginatedRestArray(url);
    if (!result.ok) return [];
    return result.data.map((item): ManagedReview => {
      const record = item !== null && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
      const review: ManagedReview = {
        body: typeof record.body === "string" ? record.body : "",
        author: githubAuthor(item),
      };
      if (typeof record.submitted_at === "string") review.submitted_at = record.submitted_at;
      return review;
    });
  }

  /** #970: `query { viewer { login } }` — the login this credential
   * authenticates as. GraphQL is the only self-identity source that answers
   * for a GitHub App installation token: REST `GET /user` returns 403
   * "Resource not accessible by integration" for installation and
   * `GITHUB_TOKEN` credentials. GraphQL returns the app's `<slug>[bot]`
   * account, `github-actions[bot]` for `GITHUB_TOKEN`, and the user login for
   * a PAT/OAuth token — so the action's own managed bodies are recognised
   * without hardcoding an identity. */
  private async graphqlViewerLogin(): Promise<string | null> {
    try {
      const { status, text } = await requestText(this.graphqlUrl(), {
        ...this.options(),
        method: "POST",
        body: JSON.stringify({ query: "query { viewer { login } }" }),
      });
      if (status < 200 || status >= 300) return null;
      const parsed = parseJson(text);
      if (!parsed.ok) return null;
      const viewer = (parsed.data as { data?: { viewer?: { login?: unknown } } } | null)?.data?.viewer;
      const login = viewer?.login;
      return typeof login === "string" && login.trim() !== "" ? login : null;
    } catch {
      return null;
    }
  }

  /** #970: resolve the login this token posts as, failing closed (`null`) on
   * any error — a missing token, transport failure, non-2xx answer, or an
   * unusable payload. GraphQL `viewer` is tried first because it is the only
   * source that works for installation tokens; REST `GET /user` is a fallback
   * for credentials where GraphQL is unavailable. */
  async authenticatedIdentity(): Promise<string | null> {
    if (!this.token) return null;
    const viewer = await this.graphqlViewerLogin();
    if (viewer !== null) return viewer;
    try {
      const { status, data } = await requestJson(this.url("/user"), this.options("application/vnd.github.v3+json"));
      if (status !== 200 || data === null || typeof data !== "object" || Array.isArray(data)) return null;
      const login = (data as Record<string, unknown>).login;
      return typeof login === "string" && login.trim() !== "" ? login : null;
    } catch {
      return null;
    }
  }

  async listPrFiles(): Promise<ReadResult<unknown>> {
    return this.restJson(this.repoUrl("/pulls/", `${this.prNumber}/files?per_page=100`));
  }

  async getIssue(repo: string, issueNumber: string): Promise<ReadResult<unknown>> {
    if (parseRepoRef(repo) === null || !NUMBER_RE.test(issueNumber)) return { ok: false, error: "invalid issue reference" };
    return this.restJson(this.repoUrl("/issues/", issueNumber, repo));
  }

  async listPrConversationComments(): Promise<ReadResult<unknown[]>> {
    const response = await this.graphql(GITHUB_CONVERSATION_COMMENTS_QUERY);
    if (!response.ok) return response;
    try {
      return { ok: true, data: normalizeGithubConversationComments(response.data) };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  async listReviewThreads(): Promise<ReadResult<unknown[]>> {
    const response = await this.graphql(GITHUB_REVIEW_THREADS_QUERY);
    if (!response.ok) return response;
    try {
      return { ok: true, data: normalizeGithubReviewThreads(response.data) };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  /** `gh api repos/R/pulls/N/reviews --paginate`: gh requests
   * `per_page=100`, follows `Link: rel="next"`, and merges the page arrays
   * into one array. Any failed page fails the read (gh exits nonzero). */
  async listPrReviewsPaginated(): Promise<ReadResult<unknown[]>> {
    return this.paginatedRestArray(this.repoUrl("/pulls/", `${this.prNumber}/reviews?per_page=100`));
  }

  /** `platform_external_checks`: bounded check-runs + combined-status reads
   * (sequential, sharing the CI deadline), folded and self-excluded. */
  async externalChecks(sha: string, options: ExternalChecksOptions = {}): Promise<ExternalCheck[] | null> {
    const runsUrl = this.repoUrl("/commits/", `${sha}/check-runs?per_page=100`);
    const statusUrl = this.repoUrl("/commits/", `${sha}/status`);
    if (!SHA_RE.test(sha) || runsUrl === null || statusUrl === null) return null;
    if (options.transientAsUnknown === true) {
      // v3 CI gate: either read failing transiently is "unknown, retry",
      // never a partial fold (see ExternalChecksOptions.transientAsUnknown).
      const runsRead = await this.boundedRead(runsUrl, options);
      const statusRead = await this.boundedRead(statusUrl, options);
      if (isTransientCiRead(runsRead.status, runsRead.text) || isTransientCiRead(statusRead.status, statusRead.text)) return null;
      return normalizeExternalChecks(runsRead.text, statusRead.text, options.runId ?? "", options.statusContext ?? "");
    }
    const runs = await this.boundedStdout(runsUrl, options);
    const combined = await this.boundedStdout(statusUrl, options);
    return normalizeExternalChecks(runs, combined, options.runId ?? "", options.statusContext ?? "");
  }

  /** GitHub App/GITHUB_TOKEN permissions are unit-scoped and cannot be
   * inferred from the coarse repo permission, so callers must not gate on
   * it there — same answer the v2 seam gives. */
  async repoPermission(): Promise<string | null> {
    return "unknown";
  }

  private validate(endpoint: string): EndpointValidation {
    return validateEndpoint(endpoint, "*", this.repo);
  }

  /** The validated read-only seam, mirroring `pr_reviewer.platform.gh_api`
   * on the GitHub backend: hardcoded api.github.com origin, Bearer auth,
   * JSON parse, `{"error": ...}` on failures — never a throw. */
  async ghApi(endpoint: string): Promise<GhApiResult> {
    const validated = this.validate(endpoint);
    if ("error" in validated) return validated;
    if (!this.token) return { error: "Missing GH_TOKEN" };
    try {
      const { status, data } = await requestJson(this.url(validated.full_path), this.options("application/vnd.github.v3+json"));
      if (status !== 200) {
        return { error: `GitHub API error: ${status}` };
      }
      return { data };
    } catch (error) {
      if (error instanceof PlatformRequestError && error.status !== null) {
        return { error: `GitHub API error: ${error.status}` };
      }
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}
