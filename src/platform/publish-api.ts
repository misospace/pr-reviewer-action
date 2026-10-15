/**
 * Platform publication seam (#680): the write-side operations the publish
 * step needs, with explicit GitHub/Forgejo capability differences.
 *
 * Boundary rules carried over from the v2 shell/Python seam:
 * - GraphQL-backed operations (minimized state, thread resolution) are
 *   GitHub-only; Forgejo degrades explicitly (the caller logs a note and
 *   continues — a missing GraphQL API is never a publish failure).
 * - Sticky-comment selection requires the marker. On Forgejo integration
 *   identity changes, the newest marker owned by the current account wins.
 * - Forgejo review creation re-validates inline-comment positions against
   the fresh diff and drops anything that no longer anchors.
 * - Every operation reports failure instead of throwing where the v2 seam
   logged a warning and continued; callers decide what is fatal.
 */
import { requestJson, requestText, type FetchLike } from "./http.js";
import { ForgejoAdapter } from "./forgejo.js";
import { parsePlatformBaseUrl, GITHUB_API_BASE } from "./urls.js";

export type PublishPlatformName = "github" | "forgejo";

export interface PublishCommentRef {
  id: number | string;
  updated_at?: string;
  body?: string;
  user?: { id?: number | string; login?: string } | null;
}

export interface PublishReviewRef {
  id: number | string;
  node_id?: string;
  state?: string;
  body?: string;
  user?: { id?: number | string; login?: string } | null;
}

export interface ManagedInlineCommentRef {
  id: number | string;
  reviewId: number | string;
  body?: string;
  user?: { id?: number | string; login?: string } | null;
  in_reply_to_id?: number | string | null;
  inReplyToId?: number | string | null;
  hasReplies?: boolean;
  pull_request_review_id?: number | string;
}

export interface NativeReviewComment {
  path: string;
  body: string;
  line?: number;
  side?: string;
  new_position?: number;
}

export interface NativeReviewRequest {
  body: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  comments?: NativeReviewComment[];
  commit_id?: string;
}

export interface StickyResult {
  ok: boolean;
  created: boolean;
  commentId?: number | string;
  error?: string;
}

export interface SupersededThread {
  id: string;
}

export interface ThreadQueryResult {
  ok: boolean;
  threads: SupersededThread[];
  hasNextPage: boolean;
  error?: string;
}

/** #1005: outcome of an additive reviewer request. `supported` distinguishes
 * "this forge cannot request reviewers" from an operational failure. The
 * `alreadyRequested*` sets are the inputs that were already on the PR and were
 * therefore not re-requested (idempotency); `requested*` are the sets actually
 * sent in this call. Nothing is ever removed. */
export interface ReviewerRequestResult {
  ok: boolean;
  supported: boolean;
  requestedUsers: string[];
  requestedTeams: string[];
  alreadyRequestedUsers: string[];
  alreadyRequestedTeams: string[];
  error?: string;
}

/** A GitHub user login, bounded and charset-restricted so a config value can
 * never be turned into a URL path or injection. */
const REQUESTER_USER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** A GitHub team slug (lowercase hyphenated). */
const REQUESTER_TEAM = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface PublishPlatformApi {
  readonly platform: PublishPlatformName;
  /** Current PR head sha, for the publication-boundary re-check (#451). */
  getHeadSha(): Promise<string | null>;
  authenticatedIdentity?(): Promise<string | null>;
  /** Issue comments (paginated), oldest-first as returned by the API. */
  listIssueComments(): Promise<PublishCommentRef[]>;
  /** Create or update the sticky managed comment (marker semantics shared). */
  upsertStickyComment(marker: string, body: string): Promise<StickyResult>;
  listReviews(): Promise<PublishReviewRef[]>;
  /** Enumerate and retire individual comments belonging to managed reviews. */
  listManagedInlineComments(reviewIds: readonly string[]): Promise<{ supported: boolean; complete: boolean; comments: ManagedInlineCommentRef[] }>;
  retireInlineComment(reviewId: string, commentId: string): Promise<boolean>;
  /** Create a native review from a GitHub-shaped payload. */
  createReview(request: NativeReviewRequest): Promise<{ ok: boolean; error?: string; reviewId?: number | string }>;
  dismissReview(reviewId: number | string, message: string): Promise<boolean>;
  /** GraphQL-only capabilities: Forgejo implementations degrade (ok:false / empty). */
  minimizedReviewIds(): Promise<string[]>;
  minimizeReview(nodeId: string): Promise<boolean>;
  /** Unresolved threads whose first comment belongs to one of managedIds. */
  unresolvedSupersededThreads(managedIds: number[]): Promise<ThreadQueryResult>;
  resolveThread(threadId: string): Promise<boolean>;
  /** Best-effort label removal (the re-review label cleanup). */
  removeLabel(label: string): Promise<boolean>;
  /** #1005: additively request reviewers/teams from trusted configuration.
   * Idempotent (already-requested identities are not re-requested) and
   * additive only (never removes). Fails closed on an invalid identity or a
   * read failure — it never substitutes another reviewer. */
  requestReviewers(users: readonly string[], teams: readonly string[]): Promise<ReviewerRequestResult>;
}

function ownerRepo(repo: string): { owner: string; name: string } {
  const slash = repo.indexOf("/");
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

/** GitHub GraphQL request helper (POST /graphql, Bearer auth). */
async function graphql(
  url: string,
  token: string | undefined,
  query: string,
  variables: Record<string, unknown>,
  timeoutMs: number,
  fetchImpl?: FetchLike,
): Promise<Record<string, unknown> | null> {
  if (!token) return null;
  try {
    const { status, data } = await requestJson(url, {
      method: "POST",
      token,
      timeoutMs,
      fetchImpl,
      allowedOrigin: new URL(url).origin,
      body: JSON.stringify({ query, variables }),
    });
    if (status !== 200 || data === null || typeof data !== "object") return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class GitHubPublishApi implements PublishPlatformApi {
  readonly platform = "github" as const;
  private readonly base: string;
  private readonly origin: string;
  private readonly repo: string;
  private readonly prNumber: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike | undefined;

  constructor(options: {
    repo: string;
    prNumber: string;
    token?: string | undefined;
    baseUrl?: string | undefined;
    timeoutMs?: number | undefined;
    fetchImpl?: FetchLike | undefined;
  }) {
    const parsed = parsePlatformBaseUrl(options.baseUrl ?? GITHUB_API_BASE, "GitHub API base URL");
    this.base = parsed.base;
    this.origin = parsed.origin;
    this.repo = options.repo;
    this.prNumber = options.prNumber;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.fetchImpl = options.fetchImpl;
  }

  private url(path: string): string {
    return `${this.base}${path}`;
  }

  private opts(method: string, body?: unknown): Parameters<typeof requestJson>[1] {
    return {
      method,
      token: this.token,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      allowedOrigin: this.origin,
      body: body === undefined ? undefined : JSON.stringify(body),
    };
  }

  async authenticatedIdentity(): Promise<string | null> {
    if (!this.token) return null;
    const viewer = await graphql(this.url("/graphql"), this.token, "query { viewer { login } }", {}, this.timeoutMs, this.fetchImpl);
    const login = ((viewer?.data as { viewer?: { login?: unknown } } | undefined)?.viewer)?.login;
    if (typeof login === "string" && login.trim() !== "") return login;
    try {
      const { status, data } = await requestJson(this.url("/user"), this.opts("GET"));
      return status === 200 && typeof (data as { login?: unknown } | null)?.login === "string" ? (data as { login: string }).login : null;
    } catch { return null; }
  }

  async getHeadSha(): Promise<string | null> {
    try {
      const { status, data } = await requestJson(this.url(`/repos/${this.repo}/pulls/${this.prNumber}`), this.opts("GET"));
      if (status !== 200 || data === null || typeof data !== "object") return null;
      const head = (data as { head?: { sha?: unknown } }).head;
      return typeof head?.sha === "string" ? head.sha : null;
    } catch {
      return null;
    }
  }

  async listIssueComments(): Promise<PublishCommentRef[]> {
    const comments: PublishCommentRef[] = [];
    for (let page = 1; page <= 10; page += 1) {
      try {
        const { status, data } = await requestJson(
          this.url(`/repos/${this.repo}/issues/${this.prNumber}/comments?per_page=100&page=${page}`),
          this.opts("GET"),
        );
        if (status !== 200 || !Array.isArray(data)) break;
        comments.push(...(data as PublishCommentRef[]));
        if ((data as unknown[]).length < 100) break;
      } catch {
        break;
      }
    }
    return comments;
  }

  async upsertStickyComment(marker: string, body: string): Promise<StickyResult> {
    const comments = await this.listIssueComments();
    const matching = comments.filter((c) => typeof c.body === "string" && c.body.includes(marker));
    matching.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
    const target = matching[0];
    try {
      if (target === undefined) {
        const { status, data } = await requestJson(
          this.url(`/repos/${this.repo}/issues/${this.prNumber}/comments`),
          this.opts("POST", { body }),
        );
        if (status !== 200 && status !== 201) return { ok: false, created: false, error: `status ${status}` };
        const id = (data as { id?: number | string } | null)?.id;
        return id === undefined ? { ok: true, created: true } : { ok: true, created: true, commentId: id };
      }
      const { status, data } = await requestJson(
        this.url(`/repos/${this.repo}/issues/comments/${target.id}`),
        this.opts("PATCH", { body }),
      );
      if (status !== 200) return { ok: false, created: false, error: `status ${status}` };
      const id = (data as { id?: number | string } | null)?.id ?? target.id;
      return { ok: true, created: false, commentId: id };
    } catch (error) {
      return { ok: false, created: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listReviews(): Promise<PublishReviewRef[]> {
    const reviews: PublishReviewRef[] = [];
    for (let page = 1; page <= 10; page += 1) {
      try {
        const { status, data } = await requestJson(
          this.url(`/repos/${this.repo}/pulls/${this.prNumber}/reviews?per_page=100&page=${page}`),
          this.opts("GET"),
        );
        if (status !== 200 || !Array.isArray(data)) throw new Error("Incomplete review listing");
        reviews.push(...(data as PublishReviewRef[]));
        if (data.length < 100) return reviews;
      } catch {
        throw new Error("Incomplete review listing; cleanup must fail closed");
      }
    }
    throw new Error("Review listing exceeded pagination cap");
  }

  async listManagedInlineComments(reviewIds: readonly string[]): Promise<{ supported: boolean; complete: boolean; comments: ManagedInlineCommentRef[] }> {
    const comments: ManagedInlineCommentRef[] = [];
    for (let page = 1; page <= 10; page += 1) {
      try {
        const { status, data } = await requestJson(this.url(`/repos/${this.repo}/pulls/${this.prNumber}/comments?per_page=100&page=${page}`), this.opts("GET"));
        if (status !== 200 || !Array.isArray(data)) return { supported: true, complete: false, comments: [] };
        const rows = data as ManagedInlineCommentRef[];
        comments.push(...rows);
        if (rows.length < 100) {
          if (comments.some((row) => !/^[1-9]\d*$/.test(String(row.id ?? "")) || !/^[1-9]\d*$/.test(String(row.pull_request_review_id ?? "")))) {
            return { supported: true, complete: false, comments: [] };
          }
          const repliedTo = new Set(comments.filter((row) => row.in_reply_to_id != null).map((row) => String(row.in_reply_to_id)));
          return { supported: true, complete: true, comments: comments
            .filter((row) => reviewIds.includes(String(row.pull_request_review_id)))
            .map((row) => ({ ...row, reviewId: String(row.pull_request_review_id), hasReplies: repliedTo.has(String(row.id)) })) };
        }
      } catch { return { supported: true, complete: false, comments: [] }; }
    }
    return { supported: true, complete: false, comments: [] };
  }

  async retireInlineComment(_reviewId: string, commentId: string): Promise<boolean> {
    if (!/^[1-9]\d*$/.test(commentId)) return false;
    try {
      const { status } = await requestText(this.url(`/repos/${this.repo}/pulls/comments/${commentId}`), this.opts("DELETE"));
      return status === 204 || status === 404;
    } catch { return false; }
  }

  async createReview(request: NativeReviewRequest): Promise<{ ok: boolean; error?: string; reviewId?: number | string }> {
    try {
      const { status, data } = await requestJson(this.url(`/repos/${this.repo}/pulls/${this.prNumber}/reviews`), this.opts("POST", request));
      const reviewId = (data as { id?: number | string } | null)?.id;
      return status === 200 || status === 201 ? { ok: true, ...(reviewId !== undefined ? { reviewId } : {}) } : { ok: false, error: `status ${status}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async dismissReview(reviewId: number | string, message: string): Promise<boolean> {
    try {
      const { status } = await requestJson(
        this.url(`/repos/${this.repo}/pulls/${this.prNumber}/reviews/${reviewId}/dismissals`),
        this.opts("PUT", { message }),
      );
      return status === 200 || status === 201;
    } catch {
      return false;
    }
  }

  async minimizedReviewIds(): Promise<string[]> {
    const { owner, name } = ownerRepo(this.repo);
    const data = await graphql(
      this.url("/graphql"),
      this.token,
      "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviews(first: 100) { nodes { databaseId isMinimized } } } } }",
      { owner, name, number: Number(this.prNumber) },
      this.timeoutMs,
      this.fetchImpl,
    );
    const nodes = (((data as { data?: { repository?: { pullRequest?: { reviews?: { nodes?: unknown } } } } })
      ?.data?.repository?.pullRequest?.reviews?.nodes) ?? null);
    if (!Array.isArray(nodes)) return [];
    return nodes
      .filter((n): n is { databaseId: number; isMinimized: boolean } =>
        typeof n === "object" && n !== null && (n as { isMinimized?: unknown }).isMinimized === true)
      .map((n) => String(n.databaseId));
  }

  async minimizeReview(nodeId: string): Promise<boolean> {
    const data = await graphql(
      this.url("/graphql"),
      this.token,
      "mutation($id: ID!) { minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) { minimizedComment { isMinimized } } }",
      { id: nodeId },
      this.timeoutMs,
      this.fetchImpl,
    );
    return data !== null;
  }

  async unresolvedSupersededThreads(managedIds: number[]): Promise<ThreadQueryResult> {
    const { owner, name } = ownerRepo(this.repo);
    const data = await graphql(
      this.url("/graphql"),
      this.token,
      "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { id isResolved comments(first: 2) { totalCount pageInfo { hasNextPage } nodes { pullRequestReview { databaseId } } } } } } } }",
      { owner, name, number: Number(this.prNumber) },
      this.timeoutMs,
      this.fetchImpl,
    );
    const payload = (data as { data?: { repository?: { pullRequest?: { reviewThreads?: {
      pageInfo?: { hasNextPage?: unknown };
      nodes?: unknown;
    } } } } })?.data?.repository?.pullRequest?.reviewThreads;
    if (!payload || !Array.isArray(payload.nodes)) {
      return { ok: false, threads: [], hasNextPage: false, error: "could not list review threads" };
    }
    const idSet = new Set(managedIds.map(String));
    const threads: SupersededThread[] = [];
    for (const node of payload.nodes) {
      const thread = node as { id?: unknown; isResolved?: unknown; comments?: { totalCount?: unknown; pageInfo?: { hasNextPage?: unknown }; nodes?: unknown } };
      if (typeof thread.id !== "string" || thread.isResolved === true) continue;
      const comments = thread.comments;
      if (!comments || comments.totalCount !== 1 || comments.pageInfo?.hasNextPage !== false || !Array.isArray(comments.nodes) || comments.nodes.length !== 1) continue;
      const first = comments.nodes[0];
      const reviewId = (first as { pullRequestReview?: { databaseId?: unknown } } | null | undefined)
        ?.pullRequestReview?.databaseId;
      const key = reviewId === undefined || reviewId === null ? "-1" : String(reviewId);
      if (!idSet.has(key)) continue;
      threads.push({ id: thread.id });
    }
    return { ok: true, threads, hasNextPage: payload.pageInfo?.hasNextPage === true };
  }

  async resolveThread(threadId: string): Promise<boolean> {
    const data = await graphql(
      this.url("/graphql"),
      this.token,
      "mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }",
      { id: threadId },
      this.timeoutMs,
      this.fetchImpl,
    );
    return data !== null;
  }

  async removeLabel(label: string): Promise<boolean> {
    try {
      const { status } = await requestJson(
        this.url(`/repos/${this.repo}/issues/${this.prNumber}/labels/${encodeURIComponent(label)}`),
        this.opts("DELETE"),
      );
      return status === 200 || status === 204;
    } catch {
      return false;
    }
  }

  async requestReviewers(users: readonly string[], teams: readonly string[]): Promise<ReviewerRequestResult> {
    const none = (): Pick<ReviewerRequestResult, "requestedUsers" | "requestedTeams" | "alreadyRequestedUsers" | "alreadyRequestedTeams"> =>
      ({ requestedUsers: [], requestedTeams: [], alreadyRequestedUsers: [], alreadyRequestedTeams: [] });
    const cleanUsers = [...new Set(users.map((u) => u.trim()))].filter((u) => u !== "");
    const cleanTeams = [...new Set(teams.map((t) => t.trim()))].filter((t) => t !== "");
    // Fail closed: a non-login/non-slug identity is never sent to the API.
    if (cleanUsers.some((u) => !REQUESTER_USER.test(u)) || cleanTeams.some((t) => !REQUESTER_TEAM.test(t))) {
      return { ok: false, supported: true, ...none(), error: "reviewer request rejected: an identity is not a valid GitHub login or team slug" };
    }
    if (cleanUsers.length === 0 && cleanTeams.length === 0) {
      return { ok: true, supported: true, ...none() };
    }
    let existingUsers: string[] = [];
    let existingTeams: string[] = [];
    try {
      const { status, data } = await requestJson(this.url(`/repos/${this.repo}/pulls/${this.prNumber}/requested_reviewers`), this.opts("GET"));
      if (status !== 200 || data === null || typeof data !== "object") {
        return { ok: false, supported: true, ...none(), error: `could not read requested reviewers (status ${status})` };
      }
      const record = data as { users?: unknown; teams?: unknown };
      // Fail closed (#1005): a 200 that does not carry both reviewer arrays
      // is an uncertain state — the dedup diff cannot be trusted, so no
      // mutation happens. Treating a malformed body as an empty reviewer set
      // would let the POST proceed on an unverified assumption.
      if (!Array.isArray(record.users) || !Array.isArray(record.teams)) {
        return { ok: false, supported: true, ...none(), error: "could not read requested reviewers (malformed response: users/teams are not arrays)" };
      }
      // Fail closed at the member level too: every entry must carry a
      // well-formed identity. Silently dropping malformed members would let
      // the POST proceed on an unverified picture of the existing requests —
      // the same uncertain-read-to-mutation hole as a malformed body.
      const loginOf = (entry: unknown): string | null => {
        const login = (entry as { login?: unknown } | null)?.login;
        return typeof login === "string" && REQUESTER_USER.test(login) ? login : null;
      };
      const slugOf = (entry: unknown): string | null => {
        const slug = (entry as { slug?: unknown } | null)?.slug;
        return typeof slug === "string" && REQUESTER_TEAM.test(slug) ? slug : null;
      };
      const users = record.users.map(loginOf);
      const teams = record.teams.map(slugOf);
      if (users.includes(null) || teams.includes(null)) {
        return { ok: false, supported: true, ...none(), error: "could not read requested reviewers (malformed response: a reviewer entry lacks a valid login or team slug)" };
      }
      existingUsers = users as string[];
      existingTeams = teams as string[];    } catch (error) {
      return { ok: false, supported: true, ...none(), error: error instanceof Error ? error.message : String(error) };
    }
    const existingUserSet = new Set(existingUsers.map((u) => u.toLowerCase()));
    const existingTeamSet = new Set(existingTeams.map((t) => t.toLowerCase()));
    const newUsers = cleanUsers.filter((u) => !existingUserSet.has(u.toLowerCase()));
    const newTeams = cleanTeams.filter((t) => !existingTeamSet.has(t.toLowerCase()));
    const alreadyRequestedUsers = cleanUsers.filter((u) => existingUserSet.has(u.toLowerCase()));
    const alreadyRequestedTeams = cleanTeams.filter((t) => existingTeamSet.has(t.toLowerCase()));
    if (newUsers.length === 0 && newTeams.length === 0) {
      return { ok: true, supported: true, requestedUsers: [], requestedTeams: [], alreadyRequestedUsers, alreadyRequestedTeams };
    }
    try {
      const body: Record<string, unknown> = {};
      if (newUsers.length > 0) body["reviewers"] = newUsers;
      if (newTeams.length > 0) body["team_reviewers"] = newTeams;
      const { status } = await requestJson(this.url(`/repos/${this.repo}/pulls/${this.prNumber}/requested_reviewers`), this.opts("POST", body));
      if (status !== 200 && status !== 201) {
        return { ok: false, supported: true, ...none(), error: `status ${status}` };
      }
      return { ok: true, supported: true, requestedUsers: newUsers, requestedTeams: newTeams, alreadyRequestedUsers, alreadyRequestedTeams };
    } catch (error) {
      return { ok: false, supported: true, ...none(), error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Map a GitHub review event to Forgejo's ReviewStateType tokens. */
export function forgejoReviewEvent(event: string): string {
  const normalized = (event || "COMMENT").toUpperCase();
  if (normalized === "APPROVE" || normalized === "APPROVED") return "APPROVED";
  if (normalized === "REQUEST_CHANGES" || normalized === "CHANGES_REQUESTED") return "REQUEST_CHANGES";
  return "COMMENT";
}

/** Forgejo generates integration audiences as `u:<owner ID>:<UUID>`. */
function integrationOwnerId(audience: string | undefined): string | null {
  const match = /^u:([1-9]\d*):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(audience ?? "");
  return match?.[1] ?? null;
}

function commentAuthorId(comment: PublishCommentRef): string | null {
  const id = comment.user?.id;
  if (typeof id === "number") return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
  return typeof id === "string" && /^[1-9]\d*$/.test(id) ? id : null;
}

export class ForgejoPublishApi implements PublishPlatformApi {
  readonly platform = "forgejo" as const;
  private readonly base: string;
  private readonly origin: string;
  private readonly repo: string;
  private readonly prNumber: string;
  private readonly authorization: ForgejoAdapter;
  private readonly integrationMode: boolean;
  private readonly integrationOwnerId: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike | undefined;
  /** Fresh diff used to re-validate inline-comment positions. */
  private readonly diffProvider: (() => Promise<string>) | null;

  constructor(options: {
    repo: string;
    prNumber: string;
    token?: string | undefined;
    authMethod?: string | undefined;
    authorizedIntegrationAudience?: string | undefined;
    baseUrl?: string | undefined;
    timeoutMs?: number | undefined;
    fetchImpl?: FetchLike | undefined;
    diffProvider?: (() => Promise<string>) | undefined;
  }) {
    const parsed = parsePlatformBaseUrl(options.baseUrl ?? "", "Forgejo API base URL");
    this.base = parsed.base;
    this.origin = parsed.origin;
    this.repo = options.repo;
    this.prNumber = options.prNumber;
    this.integrationMode = (options.authMethod ?? "token").trim().toLowerCase() === "authorized_integration";
    this.integrationOwnerId = integrationOwnerId(options.authorizedIntegrationAudience);
    this.authorization = new ForgejoAdapter({
      repo: options.repo,
      prNumber: options.prNumber,
      baseUrl: options.baseUrl ?? "",
      token: options.token,
      authMethod: options.authMethod,
      authorizedIntegrationAudience: options.authorizedIntegrationAudience,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.fetchImpl = options.fetchImpl;
    this.diffProvider = options.diffProvider ?? null;
  }

  private url(path: string): string {
    return `${this.base}/api/v1${path}`;
  }

  private async opts(method: string, body?: unknown): Promise<Parameters<typeof requestJson>[1]> {
    return {
      method,
      token: await this.authorization.authorizationHeaderForRequest(),
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      allowedOrigin: this.origin,
      body: body === undefined ? undefined : JSON.stringify(body),
    };
  }

  async authenticatedIdentity(): Promise<string | null> { return this.authorization.authenticatedIdentity(); }

  async getHeadSha(): Promise<string | null> {
    try {
      const { status, data } = await requestJson(this.url(`/repos/${this.repo}/pulls/${this.prNumber}`), await this.opts("GET"));
      if (status !== 200 || data === null || typeof data !== "object") return null;
      const head = (data as { head?: { sha?: unknown } }).head;
      return typeof head?.sha === "string" ? head.sha : null;
    } catch {
      return null;
    }
  }

  async listIssueComments(): Promise<PublishCommentRef[]> {
    try {
      return await this.listIssueCommentsStrict();
    } catch {
      return [];
    }
  }

  /** Upsert must distinguish a failed list from an empty one to avoid duplicates. */
  private async listIssueCommentsStrict(): Promise<PublishCommentRef[]> {
    const comments: PublishCommentRef[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const { status, data } = await requestJson(
        this.url(`/repos/${this.repo}/issues/${this.prNumber}/comments?limit=50&page=${page}`),
        await this.opts("GET"),
      );
      if (status !== 200 || !Array.isArray(data)) throw new Error(`Forgejo issue comments read failed (status ${status})`);
      comments.push(...(data as PublishCommentRef[]));
      if (data.length < 50) return comments;
    }
    throw new Error("Forgejo issue comments exceeded the pagination limit");
  }

  async upsertStickyComment(marker: string, body: string): Promise<StickyResult> {
    try {
      const comments = await this.listIssueCommentsStrict();
      const matching = comments.filter((c) => typeof c.body === "string" && c.body.includes(marker));
      matching.sort((a, b) => {
        const updated = String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""));
        if (updated !== 0) return updated;
        const aId = Number(a.id);
        const bId = Number(b.id);
        return Number.isSafeInteger(aId) && Number.isSafeInteger(bId) ? bId - aId : 0;
      });
      let target = matching[0];
      if (this.integrationMode && target !== undefined) {
        let author: (comment: PublishCommentRef) => string | null;
        let current: string;
        if (this.integrationOwnerId !== null) {
          // The audience identifies the account Forgejo authenticates as.
          // /user needs a separate user scope that repository-scoped JWTs lack.
          author = commentAuthorId;
          current = this.integrationOwnerId;
        } else {
          const identity = await this.authorization.authenticatedIdentity();
          if (identity === null) return { ok: false, created: false, error: "Forgejo sticky comment owner could not be verified" };
          author = (comment) => {
            const login = comment.user?.login;
            return typeof login === "string" && login.trim() !== "" ? login.toLowerCase() : null;
          };
          current = identity.toLowerCase();
        }
        target = matching.find((comment) => author(comment) === current);
        if (target === undefined && matching.some((comment) => author(comment) === null)) {
          return { ok: false, created: false, error: "Forgejo sticky comment ownership is unknown" };
        }
      }
      if (target === undefined) {
        return await this.createStickyComment(body);
      }
      const { status, data } = await requestJson(
        this.url(`/repos/${this.repo}/issues/comments/${target.id}`),
        await this.opts("PATCH", { body }),
      );
      if (status !== 200) return { ok: false, created: false, error: `status ${status}` };
      const id = (data as { id?: number | string } | null)?.id ?? target.id;
      return { ok: true, created: false, commentId: id };
    } catch (error) {
      return { ok: false, created: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async createStickyComment(body: string): Promise<StickyResult> {
    const { status, data } = await requestJson(
      this.url(`/repos/${this.repo}/issues/${this.prNumber}/comments`),
      await this.opts("POST", { body }),
    );
    if (status !== 201) return { ok: false, created: false, error: `status ${status}` };
    const id = (data as { id?: number | string } | null)?.id;
    return id === undefined ? { ok: true, created: true } : { ok: true, created: true, commentId: id };
  }

  async listReviews(): Promise<PublishReviewRef[]> {
    const reviews: PublishReviewRef[] = [];
    for (let page = 1; page <= 10; page++) {
      const { status, data } = await requestJson(this.url(`/repos/${this.repo}/pulls/${this.prNumber}/reviews?limit=100&page=${page}`), await this.opts("GET"));
      if (status !== 200 || !Array.isArray(data)) throw new Error("Incomplete review listing");
      reviews.push(...data as PublishReviewRef[]);
      if (data.length < 100) return reviews;
    }
    throw new Error("Review listing exceeded pagination cap");
  }

  async listManagedInlineComments(reviewIds: readonly string[]): Promise<{ supported: boolean; complete: boolean; comments: ManagedInlineCommentRef[] }> {
    const comments: ManagedInlineCommentRef[] = [];
    if (reviewIds.length > 25 || reviewIds.some((id) => !/^[1-9]\d*$/.test(id))) return { supported: true, complete: false, comments };
    for (const id of reviewIds) {
      try {
        const { status, data } = await requestJson(this.url(`/repos/${this.repo}/pulls/${this.prNumber}/reviews/${id}/comments`), await this.opts("GET"));
        if (status === 404) return { supported: false, complete: false, comments: [] };
        if (status !== 200 || !Array.isArray(data)) return { supported: true, complete: false, comments: [] };
        const rows = data as ManagedInlineCommentRef[];
        // Forgejo replies are sibling comments: a foreign/unknown author makes the entire review unsafe.
        if (rows.some((c) => !c.user?.login)) return { supported: true, complete: false, comments: [] };
        if (rows.some((c) => String(c.pull_request_review_id ?? c.reviewId ?? "") !== id)) return { supported: true, complete: false, comments: [] };
        if (comments.length + rows.length > 1000) return { supported: true, complete: false, comments: [] };
        comments.push(...rows.map((c) => ({ ...c, reviewId: id, hasReplies: false })));
      } catch { return { supported: true, complete: false, comments: [] }; }
    }
    return { supported: true, complete: true, comments };
  }

  async retireInlineComment(reviewId: string, commentId: string): Promise<boolean> {
    if (!/^[1-9]\d*$/.test(reviewId) || !/^[1-9]\d*$/.test(commentId)) return false;
    try {
      const { status } = await requestText(this.url(`/repos/${this.repo}/pulls/${this.prNumber}/reviews/${reviewId}/comments/${commentId}`), await this.opts("DELETE"));
      return status === 204 || status === 404;
    } catch { return false; }
  }

  async createReview(request: NativeReviewRequest): Promise<{ ok: boolean; error?: string; reviewId?: number | string }> {
    const payload: Record<string, unknown> = {
      body: request.body,
      event: forgejoReviewEvent(request.event),
    };
    if (request.commit_id) {
      payload.commit_id = request.commit_id;
    }
    const comments = await this.normaliseReviewCommentPositions(request.comments);
    if (comments.length > 0) {
      payload.comments = comments;
    }
    try {
      const { status, data } = await requestJson(this.url(`/repos/${this.repo}/pulls/${this.prNumber}/reviews`), await this.opts("POST", payload));
      const reviewId = (data as { id?: number | string } | null)?.id;
      return status === 200 || status === 201 ? { ok: true, ...(reviewId !== undefined ? { reviewId } : {}) } : { ok: false, error: `status ${status}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Port of `_normalise_review_comment_positions`: Forgejo re-validates every
   * inline comment position against the fresh diff and drops anything that
   * no longer anchors (a `line`/`side`-shaped comment is translated through
   * the position map; an unusable position drops the comment).
   */
  private async normaliseReviewCommentPositions(
    comments: NativeReviewComment[] | undefined,
  ): Promise<Array<{ path: string; new_position: number; body: string }>> {
    if (!Array.isArray(comments)) return [];
    let positions: Map<string, Map<number, number>> | null = null;
    if (this.diffProvider) {
      try {
        const { diffPositions } = await import("../publish/inline-findings.js");
        positions = diffPositions(await this.diffProvider());
      } catch {
        positions = null;
      }
    }
    const normalised: Array<{ path: string; new_position: number; body: string }> = [];
    for (const comment of comments) {
      if (!comment || typeof comment.path !== "string" || !comment.path
        || typeof comment.body !== "string" || !comment.body) {
        continue;
      }
      let newPosition = typeof comment.new_position === "number" && comment.new_position > 0
        ? comment.new_position
        : null;
      if ((newPosition === null || newPosition <= 0) && typeof comment.line === "number" && comment.line > 0 && positions) {
        newPosition = positions.get(comment.path)?.get(comment.line) ?? null;
      }
      if (newPosition === null || newPosition <= 0) continue;
      normalised.push({ path: comment.path, new_position: newPosition, body: comment.body });
    }
    return normalised;
  }

  async dismissReview(reviewId: number | string, message: string): Promise<boolean> {
    try {
      const { status } = await requestJson(
        this.url(`/repos/${this.repo}/pulls/${this.prNumber}/reviews/${reviewId}/dismissals`),
        await this.opts("POST", { message }),
      );
      return status === 200 || status === 201 || status === 204;
    } catch {
      return false;
    }
  }

  /** GraphQL is unavailable on Forgejo; the caller degrades with a note. */
  async minimizedReviewIds(): Promise<string[]> {
    return [];
  }

  async minimizeReview(_nodeId: string): Promise<boolean> {
    return false;
  }

  async unresolvedSupersededThreads(_managedIds: number[]): Promise<ThreadQueryResult> {
    return { ok: false, threads: [], hasNextPage: false, error: "no GraphQL API" };
  }

  async resolveThread(_threadId: string): Promise<boolean> {
    return false;
  }

  async removeLabel(label: string): Promise<boolean> {
    try {
      const { status } = await requestJson(
        this.url(`/repos/${this.repo}/issues/${this.prNumber}/labels/${encodeURIComponent(label)}`),
        await this.opts("DELETE"),
      );
      return status === 204 || status === 200;
    } catch {
      return false;
    }
  }

  /** #1005: reviewer requests are not supported on Forgejo. Degrade
   * explicitly (like the GraphQL-only capabilities) — no mutation, and the
   * caller surfaces the unsupported capability rather than substituting. */
  async requestReviewers(_users: readonly string[], _teams: readonly string[]): Promise<ReviewerRequestResult> {
    return {
      ok: false,
      supported: false,
      requestedUsers: [],
      requestedTeams: [],
      alreadyRequestedUsers: [],
      alreadyRequestedTeams: [],
      error: "reviewer requests are not supported on this platform",
    };
  }
}
