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
import { canonicalUserId, hasUsableOwner, integrationOwnerIdFromAudience, ownerMatchesIdentity, type IdentityResolution, type TrustedOwnerIdentity } from "./owner-identity.js";
import { parsePlatformBaseUrl, GITHUB_API_BASE } from "./urls.js";

export type PublishPlatformName = "github" | "forgejo";

export interface PublishCommentRef {
  id: number | string;
  updated_at?: string;
  body?: string;
  user?: { id?: number | string; login?: string } | null;
}

export interface IssueCommentEnumeration {
  /** False when the forge read failed or truncated mid-pagination, so
   * `comments` is NOT the complete set (a newer comment may exist). */
  complete: boolean;
  comments: PublishCommentRef[];
}

export interface PublishReviewRef {
  id: number | string;
  node_id?: string;
  state?: string;
  body?: string;
  user?: { id?: number | string; login?: string } | null;
  /** #1093: forge-reported review instants (either may be absent). The
   * sticky-checkpoint cleanup uses them to prove no newer managed review
   * superseded the run; a review without a usable timestamp fails closed. */
  submitted_at?: string;
  updated_at?: string;
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
  /** #762: the anchor the comment was published against, so a later run can
   * correlate this comment's prescription with its own at the same place.
   * Normalized to a string / positive integer; a missing or unusable value is
   * dropped rather than carried through untyped. */
  path?: string;
  line?: number;
  original_line?: number;
  /** #762: the first line of a multi-line published range (`line` carries its
   * end), so the range can be reconstructed rather than guessed. */
  start_line?: number;
}

export interface NativeReviewComment {
  path: string;
  body: string;
  line?: number;
  side?: string;
  new_position?: number;
  /** #762: multi-line one-click suggestion range (GitHub). The Forgejo adapter
   * drops these (it cannot express a multi-line suggestion) and re-anchors. */
  start_line?: number;
  start_side?: string;
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
  /** #1093: ISO 8601 instant of the published sticky comment, from the
   * PATCH/POST response body. The publish cleanup gate uses it as the
   * replacement checkpoint timestamp when no native review was created;
   * absent → the gate skips cleanup (fail closed). */
  updatedAt?: string;
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

export interface ReviewThreadState { threadId: string; resolved: boolean; firstCommentId: string; }
export interface ReviewThreadStatesResult { supported: boolean; complete: boolean; threads: ReviewThreadState[]; }

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

/** #762: the useful-cap bound on the per-id reaction reads. Defined once here
 * so the reader and the caller that bounds its candidate set cannot drift. */
export const MAX_FEEDBACK_COMMENT_IDS = 50;

/** #762: the page cap for a single comment id's reaction listing. 300
 * reactions on one review comment is far beyond any realistic usefulness
 * feedback, and hitting the cap degrades to `complete: false` rather than
 * claiming completeness over a truncated read. */
const MAX_FEEDBACK_REACTION_PAGES = 3;

/** #762: one native 👍/👎 reaction on a published review comment. `login` is
 * the forge-reported actor and is never self-authorizing: the usefulness-
 * feedback gate re-verifies it against the repository permission API before it
 * may suppress anything, and it is never rendered or logged. */
export interface CommentFeedbackRecord {
  commentId: string;
  content: "+1" | "-1";
  login: string;
}

/** #762: `supported` separates "this forge cannot read review-comment
 * reactions" (an explicit degradation) from an operational failure, and
 * `complete: false` means the picture is uncertain — callers must read it as
 * "no feedback" rather than as an empty set. */
export interface CommentFeedbackResult {
  supported: boolean;
  complete: boolean;
  records: CommentFeedbackRecord[];
}

/** #762: the bounded collaborator-permission reading behind the feedback trust
 * gate. `null` proves nothing (lookup error, non-200, or a body without a
 * string `permission`) and is never self-authorizing. */
export interface CollaboratorPermissionReading {
  /** Lowercased `permission` as the forge reported it. */
  permission: string;
  /** Lowercased `role_name`; "" when the response carries none. */
  roleName: string;
  /** How the response names its own subject: `absent` (schema-allowed, and
   * nothing provable is wrong with it), `named` (with `subjectLogin`), or
   * `unusable` (anything that is not a well-formed user object with a string
   * login — unverifiable, so it fails closed exactly like the precheck). */
  subject: "absent" | "named" | "unusable";
  /** Lowercased login the response attributes the permission to. */
  subjectLogin?: string;
}

export interface PublishPlatformApi {
  readonly platform: PublishPlatformName;
  /** Current PR head sha, for the publication-boundary re-check (#451). */
  getHeadSha(): Promise<string | null>;
  authenticatedIdentity?(): Promise<string | null>;
  /** #1093: the forge-authenticated owner identity with a bounded
   * diagnostics reason. A `userId` proof is authoritative only in Forgejo
   * Authorized Integration mode. Absent → callers fall back to
   * `authenticatedIdentity()` (login-kind). */
  resolveTrustedOwner?(): Promise<IdentityResolution>;
  /** Issue comments (paginated), oldest-first as returned by the API.
   * Untyped as to completeness: a partial list is indistinguishable from a
   * complete one, so a reader that must reason about ABSENCE (no newer
   * publication exists) uses `listIssueCommentsResult` instead. */
  listIssueComments(): Promise<PublishCommentRef[]>;
  /** #1027: the same issue-comment read plus an explicit completeness
   * signal. Optional, matching how this seam already expresses read-capability
   * degradations (`listManagedInlineComments`, `reviewCommentFeedback`,
   * `reviewThreadStates`): an adapter without it CANNOT prove its list is
   * complete, which is the fail-closed answer — never an assumption that the
   * array holds every comment. */
  listIssueCommentsResult?(): Promise<IssueCommentEnumeration>;
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
  /**
   * #1005: additively request reviewers/teams from trusted configuration.
   * Idempotent (already-requested identities are not re-requested) and
   * additive only (never removes). Fails closed on an invalid identity or a
   * read failure — it never substitutes another reviewer.
   */
  requestReviewers(users: readonly string[], teams: readonly string[]): Promise<ReviewerRequestResult>;
  /** #762: native 👍/👎 reactions on published review comments — the
   * usefulness-feedback reader. Optional: an adapter without it is a forge
   * that cannot read them, and the caller degrades explicitly. One request
   * per comment id; an over-cap or malformed id set is rejected WITHOUT any
   * request, and a per-id failure reports `complete: false`. */
  reviewCommentFeedback?(commentIds: readonly string[]): Promise<CommentFeedbackResult>;
  reviewThreadStates?(managedReviewIds: readonly string[]): Promise<ReviewThreadStatesResult>;
  /** #762: the fail-closed repository-collaborator permission read that gates
   * a 👎 suppression (`repos/{repo}/collaborators/{login}/permission`).
   * Optional: an adapter without it trusts no actor. */
  collaboratorPermission?(login: string): Promise<CollaboratorPermissionReading | null>;
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
    return (await this.listIssueCommentsResult()).comments;
  }

  /** #1027: only a short page PROVES the enumeration finished. Every exit
   * that used to be a bare `break` — a non-200 or non-array page, a thrown
   * request, and exhausting the page cap while the last page was still full —
   * returns `complete: false` with whatever was accumulated, so a truncated
   * read can never be read as "this is the whole set". */
  async listIssueCommentsResult(): Promise<IssueCommentEnumeration> {
    const comments: PublishCommentRef[] = [];
    for (let page = 1; page <= 10; page += 1) {
      try {
        const { status, data } = await requestJson(
          this.url(`/repos/${this.repo}/issues/${this.prNumber}/comments?per_page=100&page=${page}`),
          this.opts("GET"),
        );
        if (status !== 200 || !Array.isArray(data)) return { complete: false, comments };
        comments.push(...(data as PublishCommentRef[]));
        if ((data as unknown[]).length < 100) return { complete: true, comments };
      } catch {
        return { complete: false, comments };
      }
    }
    return { complete: false, comments };
  }

  async upsertStickyComment(marker: string, body: string): Promise<StickyResult> {
    const comments = await this.listIssueComments();
    const matching = comments.filter((c) => typeof c.body === "string" && c.body.includes(marker));
    matching.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
    let target = matching[0];
    // #1098: a marker-bearing comment is visible to every reader, so the
    // newest match is only a PATCH candidate when the proven trusted owner
    // authored it (kind-separated matching, same policy as
    // `owner-identity.ts` — a login identity is compared to logins only).
    // A foreign-authored or unattributable marker comment is never
    // overwritten; when the identity itself cannot be proven the upsert
    // fails closed instead of guessing. With no marker comment at all the
    // creation path needs no proof — creating never destroys anything.
    if (target !== undefined) {
      const login = await this.authenticatedIdentity();
      if (login === null) return { ok: false, created: false, error: "GitHub sticky comment owner could not be verified" };
      const identity: TrustedOwnerIdentity = { kind: "login", login };
      target = matching.find((comment) => ownerMatchesIdentity(comment.user, identity));
      if (target === undefined && matching.some((comment) => typeof comment.user?.login !== "string" || comment.user.login.trim() === "")) {
        return { ok: false, created: false, error: "GitHub sticky comment ownership is unknown" };
      }
    }
    try {
      if (target === undefined) {
        const { status, data } = await requestJson(
          this.url(`/repos/${this.repo}/issues/${this.prNumber}/comments`),
          this.opts("POST", { body }),
        );
        if (status !== 200 && status !== 201) return { ok: false, created: false, error: `status ${status}` };
        // #1093: the response instant anchors the sticky replacement
        // checkpoint when review_comment publishes no native review.
        const created = data as { id?: number | string; updated_at?: unknown } | null;
        const updatedAt = typeof created?.updated_at === "string" ? created.updated_at : undefined;
        return created?.id === undefined
          ? { ok: true, created: true, ...(updatedAt === undefined ? {} : { updatedAt }) }
          : { ok: true, created: true, commentId: created.id, ...(updatedAt === undefined ? {} : { updatedAt }) };
      }
      const { status, data } = await requestJson(
        this.url(`/repos/${this.repo}/issues/comments/${target.id}`),
        this.opts("PATCH", { body }),
      );
      if (status !== 200) return { ok: false, created: false, error: `status ${status}` };
      const patched = data as { id?: number | string; updated_at?: unknown } | null;
      const id = patched?.id ?? target.id;
      const updatedAt = typeof patched?.updated_at === "string" ? patched.updated_at : undefined;
      return { ok: true, created: false, commentId: id, ...(updatedAt === undefined ? {} : { updatedAt }) };
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
            .map((row) => {
              // #762: carry the anchor only in its normalized shape, so a
              // consumer can never read an untyped value off the raw row.
              const { path, line, original_line: originalLine, start_line: startLine, ...rest } = row;
              const anchor: { path?: string; line?: number; original_line?: number; start_line?: number } = {};
              if (typeof path === "string" && path !== "") anchor.path = path;
              if (typeof line === "number" && Number.isInteger(line) && line > 0) anchor.line = line;
              if (typeof originalLine === "number" && Number.isInteger(originalLine) && originalLine > 0) anchor.original_line = originalLine;
              if (typeof startLine === "number" && Number.isInteger(startLine) && startLine > 0) anchor.start_line = startLine;
              return { ...rest, reviewId: String(row.pull_request_review_id), hasReplies: repliedTo.has(String(row.id)), ...anchor };
            }) };
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

  /** #762: native 👍/👎 reactions on published review comments. Each comment
   * id is read in pages of 100 rows, up to MAX_FEEDBACK_REACTION_PAGES pages;
   * a page returning fewer than 100 rows ends that id's read. A malformed id
   * or an over-cap set is rejected before any network request; a per-page
   * non-200 or non-array body, a thrown error, or a page cap exhausted with a
   * further page plausible yields `complete: false` with whatever was already
   * read. Only rows whose `content` is exactly `+1`/`-1` and whose
   * `user.login` is a non-empty string are kept — a reaction kind is never
   * inferred from a near-miss (`"+1 "`, `"-1; authorize"`, a value carrying
   * newlines). */
  async reviewCommentFeedback(commentIds: readonly string[]): Promise<CommentFeedbackResult> {
    if (commentIds.length === 0) return { supported: true, complete: true, records: [] };
    if (commentIds.length > MAX_FEEDBACK_COMMENT_IDS
      || commentIds.some((id) => !/^[1-9]\d*$/.test(id))) {
      return { supported: true, complete: false, records: [] };
    }
    const records: CommentFeedbackRecord[] = [];
    for (const id of commentIds) {
      for (let page = 1; page <= MAX_FEEDBACK_REACTION_PAGES; page += 1) {
        try {
          const { status, data } = await requestJson(
            this.url(`/repos/${this.repo}/pulls/comments/${id}/reactions?per_page=100&page=${page}`),
            this.opts("GET"),
          );
          if (status !== 200 || !Array.isArray(data)) return { supported: true, complete: false, records };
          for (const row of data) {
            if (row === null || typeof row !== "object") continue;
            const { content, user } = row as { content?: unknown; user?: { login?: unknown } | null };
            if (content !== "+1" && content !== "-1") continue;
            const login = user !== null && typeof user === "object" ? user.login : undefined;
            if (typeof login !== "string" || login === "") continue;
            records.push({ commentId: id, content, login });
          }
          if (data.length < 100) break;
          if (page === MAX_FEEDBACK_REACTION_PAGES) return { supported: true, complete: false, records };
        } catch {
          return { supported: true, complete: false, records };
        }
      }
    }
    return { supported: true, complete: true, records };
  }

  /** #762: the fail-closed repository-collaborator permission read. A login
   * outside the GitHub login charset is rejected WITHOUT a request (so
   * untrusted reaction text can never reach a URL or a decision), and a
   * lookup error, a non-200, a non-object body, or a body without a string
   * `permission` all return `null` — never self-authorizing. */
  async collaboratorPermission(login: string): Promise<CollaboratorPermissionReading | null> {
    if (!REQUESTER_USER.test(login)) return null;
    try {
      const { status, data } = await requestJson(
        this.url(`/repos/${this.repo}/collaborators/${encodeURIComponent(login)}/permission`),
        this.opts("GET"),
      );
      if (status !== 200 || data === null || typeof data !== "object" || Array.isArray(data)) return null;
      const record = data as { permission?: unknown; role_name?: unknown; user?: unknown };
      if (typeof record.permission !== "string") return null;
      const reading: CollaboratorPermissionReading = {
        permission: record.permission.toLowerCase(),
        roleName: typeof record.role_name === "string" ? record.role_name.toLowerCase() : "",
        subject: "absent",
      };
      const subject = record.user;
      if (subject !== null && subject !== undefined) {
        const subjectLogin = typeof subject === "object" && !Array.isArray(subject)
          ? (subject as { login?: unknown }).login
          : undefined;
        if (typeof subjectLogin !== "string" || subjectLogin === "") {
          reading.subject = "unusable";
          return reading;
        }
        reading.subject = "named";
        reading.subjectLogin = subjectLogin.toLowerCase();
      }
      return reading;
    } catch {
      return null;
    }
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

  async reviewThreadStates(managedReviewIds: readonly string[]): Promise<ReviewThreadStatesResult> {
    try {
      const { owner, name } = ownerRepo(this.repo);
      const data = await graphql(this.url("/graphql"), this.token,
        "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { id isResolved comments(first: 1) { nodes { databaseId pullRequestReview { databaseId } } } } } } } }",
        { owner, name, number: Number(this.prNumber) }, this.timeoutMs, this.fetchImpl);
      const payload = (data as { data?: { repository?: { pullRequest?: { reviewThreads?: { pageInfo?: { hasNextPage?: unknown }; nodes?: unknown } } } } } | null)?.data?.repository?.pullRequest?.reviewThreads;
      if (!payload || !Array.isArray(payload.nodes) || typeof payload.pageInfo?.hasNextPage !== "boolean") return { supported: true, complete: false, threads: [] };
      const ids = new Set(managedReviewIds.map(String));
      const threads = [];
      for (const node of payload.nodes) {
        if (node === null || typeof node !== "object") return { supported: true, complete: false, threads: [] };
        const row = node as { id?: unknown; isResolved?: unknown; comments?: { nodes?: unknown } };
        if (typeof row.id !== "string" || typeof row.isResolved !== "boolean" || !Array.isArray(row.comments?.nodes) || row.comments.nodes.length !== 1) return { supported: true, complete: false, threads: [] };
        const first = row.comments.nodes[0] as { databaseId?: unknown; pullRequestReview?: { databaseId?: unknown } } | null;
        if (!first || !ids.has(String(first.pullRequestReview?.databaseId ?? ""))) continue;
        threads.push({ threadId: row.id, resolved: row.isResolved, firstCommentId: typeof first.databaseId === "number" ? String(first.databaseId) : "" });
      }
      return { supported: true, complete: !payload.pageInfo.hasNextPage, threads };
    } catch { return { supported: true, complete: false, threads: [] }; }
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

/** Forgejo generates integration audiences as `u:<owner ID>:<UUID>`;
 * parsing lives in the shared owner-identity policy (#1093). */

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
    // #1093: same rule as ForgejoAdapter.isAuthorizedIntegrationMode():
    // an explicit method governs; the legacy audience-only configuration
    // (authMethod unset) is integration mode too, so the sticky upsert
    // target gets the same ownership verification the precheck and the
    // cleanup gate apply to the audience's user id.
    const method = (options.authMethod ?? "").trim().toLowerCase();
    this.integrationMode = method === "authorized_integration"
      || (method === "" && (options.authorizedIntegrationAudience ?? "").trim() !== "");
    this.integrationOwnerId = integrationOwnerIdFromAudience(options.authorizedIntegrationAudience);
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

  /** #1093: the trusted owner identity for cleanup and sticky ownership,
   * delegating to the Forgejo adapter (login via `GET /user`, or — in
   * Authorized Integration mode — the audience's owner id when `/user` is
   * unreachable). */
  async resolveTrustedOwner(): Promise<IdentityResolution> {
    return this.authorization.resolveTrustedOwner();
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

  /** #1027: the strict read either enumerates to a proven end or throws, so
   * completeness is exactly "it did not throw". */
  async listIssueCommentsResult(): Promise<IssueCommentEnumeration> {
    try {
      return { complete: true, comments: await this.listIssueCommentsStrict() };
    } catch {
      return { complete: false, comments: [] };
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
        let identity: TrustedOwnerIdentity | null;
        // #1093: "unusable" stays branch-specific for byte-identical
        // behavior — under a user-id identity only an unusable ID counts
        // (a login is never compared against the audience's owner id);
        // under a login identity only an unusable login counts.
        let unusable: (comment: PublishCommentRef) => boolean;
        if (this.integrationOwnerId !== null) {
          // The audience identifies the account Forgejo authenticates as.
          // /user needs a separate user scope that repository-scoped JWTs lack.
          identity = { kind: "userId", userId: this.integrationOwnerId };
          unusable = (comment) => canonicalUserId(comment.user?.id) === null;
        } else {
          const login = await this.authorization.authenticatedIdentity();
          if (login === null) return { ok: false, created: false, error: "Forgejo sticky comment owner could not be verified" };
          identity = { kind: "login", login };
          unusable = (comment) => typeof comment.user?.login !== "string" || comment.user.login.trim() === "";
        }
        target = matching.find((comment) => ownerMatchesIdentity(comment.user, identity));
        if (target === undefined && matching.some(unusable)) {
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
      const patched = data as { id?: number | string; updated_at?: unknown; updated_on?: unknown } | null;
      const id = patched?.id ?? target.id;
      const updatedAt = typeof patched?.updated_at === "string" ? patched.updated_at : typeof patched?.updated_on === "string" ? patched.updated_on : undefined;
      return { ok: true, created: false, commentId: id, ...(updatedAt === undefined ? {} : { updatedAt }) };
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
    const created = data as { id?: number | string; updated_at?: unknown; updated_on?: unknown } | null;
    const updatedAt = typeof created?.updated_at === "string" ? created.updated_at : typeof created?.updated_on === "string" ? created.updated_on : undefined;
    return created?.id === undefined
      ? { ok: true, created: true, ...(updatedAt === undefined ? {} : { updatedAt }) }
      : { ok: true, created: true, commentId: created.id, ...(updatedAt === undefined ? {} : { updatedAt }) };
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
        // Forgejo replies are sibling comments: an unattributable author
        // (neither a usable login nor a usable user id, #1093) makes the
        // entire review unsafe.
        if (rows.some((c) => !hasUsableOwner(c.user))) return { supported: true, complete: false, comments: [] };
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

  async reviewThreadStates(_managedReviewIds: readonly string[]): Promise<ReviewThreadStatesResult> {
    return { supported: false, complete: false, threads: [] };
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

  /** #762: review-comment reactions are not readable on Forgejo. Degrade
   * explicitly (like the GraphQL-only capabilities) — ZERO requests, and
   * `complete: false` so a caller can never mistake "unsupported" for "no
   * reaction was left". `collaboratorPermission` is deliberately absent:
   * without a feedback reader there is no actor to verify, so this adapter
   * trusts nobody. */
  async reviewCommentFeedback(_commentIds: readonly string[]): Promise<CommentFeedbackResult> {
    return { supported: false, complete: false, records: [] };
  }
}
