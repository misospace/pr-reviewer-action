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
import { requestJson, type FetchLike } from "./http.js";
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

export interface PublishPlatformApi {
  readonly platform: PublishPlatformName;
  /** Current PR head sha, for the publication-boundary re-check (#451). */
  getHeadSha(): Promise<string | null>;
  /** Issue comments (paginated), oldest-first as returned by the API. */
  listIssueComments(): Promise<PublishCommentRef[]>;
  /** Create or update the sticky managed comment (marker semantics shared). */
  upsertStickyComment(marker: string, body: string): Promise<StickyResult>;
  listReviews(): Promise<PublishReviewRef[]>;
  /** Create a native review from a GitHub-shaped payload. */
  createReview(request: NativeReviewRequest): Promise<{ ok: boolean; error?: string }>;
  dismissReview(reviewId: number | string, message: string): Promise<boolean>;
  /** GraphQL-only capabilities: Forgejo implementations degrade (ok:false / empty). */
  minimizedReviewIds(): Promise<string[]>;
  minimizeReview(nodeId: string): Promise<boolean>;
  /** Unresolved threads whose first comment belongs to one of managedIds. */
  unresolvedSupersededThreads(managedIds: number[]): Promise<ThreadQueryResult>;
  resolveThread(threadId: string): Promise<boolean>;
  /** Best-effort label removal (the re-review label cleanup). */
  removeLabel(label: string): Promise<boolean>;
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
        if (status !== 200 || !Array.isArray(data)) break;
        reviews.push(...(data as PublishReviewRef[]));
        if ((data as unknown[]).length < 100) break;
      } catch {
        break;
      }
    }
    return reviews;
  }

  async createReview(request: NativeReviewRequest): Promise<{ ok: boolean; error?: string }> {
    try {
      const { status } = await requestJson(this.url(`/repos/${this.repo}/pulls/${this.prNumber}/reviews`), this.opts("POST", request));
      return status === 200 || status === 201 ? { ok: true } : { ok: false, error: `status ${status}` };
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
      "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { id isResolved comments(first: 1) { nodes { pullRequestReview { databaseId } } } } } } } }",
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
      const thread = node as { id?: unknown; isResolved?: unknown; comments?: { nodes?: unknown } };
      if (typeof thread.id !== "string" || thread.isResolved === true) continue;
      const first = Array.isArray(thread.comments?.nodes) ? thread.comments.nodes[0] : null;
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
    try {
      const { status, data } = await requestJson(this.url(`/repos/${this.repo}/pulls/${this.prNumber}/reviews`), await this.opts("GET"));
      return status === 200 && Array.isArray(data) ? (data as PublishReviewRef[]) : [];
    } catch {
      return [];
    }
  }

  async createReview(request: NativeReviewRequest): Promise<{ ok: boolean; error?: string }> {
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
      const { status } = await requestJson(this.url(`/repos/${this.repo}/pulls/${this.prNumber}/reviews`), await this.opts("POST", payload));
      return status === 200 || status === 201 ? { ok: true } : { ok: false, error: `status ${status}` };
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
}
