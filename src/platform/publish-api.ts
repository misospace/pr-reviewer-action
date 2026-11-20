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
import { gitlabFetch } from "./gitlab.js";
import { gitlabProjectPathForDiagnostics, gitlabProjectScopedUrl, parseGitLabProjectPath } from "./repo-ref.js";
import { nextLink } from "./github.js";
import { canonicalUserId, hasUsableOwner, integrationOwnerIdFromAudience, ownerMatchesIdentity, type IdentityResolution, type TrustedOwnerIdentity } from "./owner-identity.js";
import { parsePlatformBaseUrl, GITHUB_API_BASE } from "./urls.js";
import { GITEA_INTEGRATION_REFUSAL, type GiteaFamilyForge } from "./resolve.js";

export type PublishPlatformName = "github" | "forgejo" | "tangled" | "gitlab";

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
  /** #1181: forge-reported official-review-count flag. Used by the #1176
   * deletion gate to fail closed on the upstream verdict-reactivation risk:
   * Forgejo's `DeleteReview` re-officials the latest remaining
   * Approve/Reject/Request review by the same reviewer, so a row whose
   * `official` flag is true, absent, or unknown is never deleted. GitHub rows
   * do not carry it (GitHub never deletes; minimization is the hide
   * mechanism). */
  official?: boolean;
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
  /** #1691: what the upsert actually did, when the platform reports it.
   * The Tangled managed record distinguishes `created` (no record existed),
   * `updated` (the single existing record was written in place), and
   * `reconciled` (more than one record matched the pull; the newest was
   * kept in place and the superseded duplicates were deleted). Other
   * platforms may omit it; `created` stays the compatibility signal. */
  action?: "created" | "updated" | "reconciled";
  /** #1691: with `action: "reconciled"`, how many superseded duplicate
   * records were deleted. Reported, never silent. */
  supersededDuplicates?: number;
  error?: string;
}

/** #763: outcome of an additive, NON-managed comment post (the conversational
 * follow-up reply). Unlike `upsertStickyComment` it carries NO marker and owns
 * no managed-review lifecycle — it is a plain top-level conversation comment.
 * `created` is always `true` on success (it never updates an existing comment).
 * A failure reports `ok: false` with a bounded `error` and never throws. */
export interface CommentPostResult {
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

/** #1176: outcome of an author-side superseded-review deletion. */
export interface ReviewDeletionResult {
  ok: boolean;
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

/** #1121: the page size and page cap of the GitHub issue-comment enumeration.
 * 100 pages of 100 bounds the read far beyond any realistic PR while a cap
 * hit still reports `complete: false` — the same bound-and-degrade posture
 * as the precheck adapter's `MAX_PAGES`. */
const ISSUE_COMMENT_PAGE_SIZE = 100;
const MAX_ISSUE_COMMENT_PAGES = 100;

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

/** #588: whether a platform can host a native pull review — the review
 * event itself and its inline review comments. A platform without that
 * surface publishes the review body as its managed top-level record and
 * states the degradation explicitly; it never pretends a native
 * approval, blocking request, or inline comment was created. */
export interface NativeReviewSurface {
  /** True when the platform can host a native pull review event. */
  supported: boolean;
  /** Operator- and body-facing reason; used when `supported` is false. */
  reason?: string;
}

export interface PublishPlatformApi {
  readonly platform: PublishPlatformName;
  /** #588: the platform's native pull-review surface. */
  readonly nativeReviewSurface: NativeReviewSurface;
  /** #588: why the current pull head could not be determined, when the
   * platform knows — e.g. it has no trustworthy current-head source yet, so
   * the #451 publication-boundary re-check can never be satisfied. Absent →
   * the generic "could not re-fetch" wording (a read that failed). */
  readonly currentHeadUnavailableReason?: string | undefined;
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
  /** #763: post ONE plain (non-managed) top-level conversation comment — the
   * conversational follow-up write. The body is posted VERBATIM: this seam
   * never adds or strips markers, so a follow-up ANSWER must arrive already
   * rendered by `renderFollowUpReply` (src/followup/reply.ts), which stamps
   * the loop-guard marker; anything else is the caller's own body. Optional:
   * an adapter without it — or one that always refuses (Tangled) — is a forge
   * with no usable plain-comment surface, and the caller degrades explicitly.
   * An empty body is refused WITHOUT a
   * request; a hostile body is sent as JSON request DATA only (never in the
   * URL) and the token is bound to the validated platform origin, so
   * untrusted follow-up text can never reach another host or become a path
   * segment. */
  postIssueComment?(body: string): Promise<CommentPostResult>;
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
  /** #1176: the static capability surface for author-side deletion of a
   * submitted review — the only way a forge without GraphQL minimization can
   * stop a superseded managed advisory body from staying visible. Optional:
   * an adapter without it is a forge (or a cleanup mode) where the surface
   * does not exist, and callers degrade exactly like they do for
   * `reviewCommentFeedback?`/`collaboratorPermission?`. Deletion removes the
   * review AND all of its inline code comments, so a caller must first prove
   * the review carries none (the cleanup layer enumerates via
   * `listManagedInlineComments` and refuses otherwise); the capability exists
   * only where the forge offers author-side deletion of a submitted review. */
  readonly supersededReviewDeletion?: NativeReviewSurface;
  /** #1176: delete one superseded managed review as its own author. A
   * malformed id is refused WITHOUT any request; a 404 is NOT an idempotent
   * success — a route-level 404 (unsupported forge version) is
   * indistinguishable from "already gone", so callers fall back instead of
   * reading the review as deleted. Callers must prove the review carries no
   * inline comments first — deletion destroys them with the review body. */
  deleteSupersededReview?(reviewId: number | string): Promise<ReviewDeletionResult>;
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
  /** #588: GitHub hosts native pull reviews (the review event and its
   * inline review comments), so the publish step takes the native path. */
  readonly nativeReviewSurface: NativeReviewSurface = { supported: true };
  /** #1176: GitHub needs no deletion surface — GraphQL minimization (#1144)
   * hides a superseded review's body without destroying anything, while
   * deletion would also destroy the review's inline findings. The cleanup
   * layer therefore never attempts deletion here. */
  readonly supersededReviewDeletion: NativeReviewSurface = {
    supported: false,
    reason: "GitHub hides superseded review bodies with GraphQL minimization; deletion would also destroy their inline findings",
  };
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

  /** #1027: the enumeration is only complete when it PROVED its end. #1121
   * proves termination the way the precheck read adapter already does (#971):
   * follow `Link: rel="next"` targets until none remains, so a PR with more
   * comments than one page carries no completeness cliff — a fixed `page=`
   * loop capped at 10 pages permanently reported `complete: false` past 1000
   * issue comments, degrading every absence-reasoning reader forever. Every
   * other exit — a non-200, non-array, or unparseable page, a thrown
   * request, an unusable Link target, and exhausting the page cap while a
   * next target still existed — returns `complete: false` with whatever was
   * accumulated, so a truncated read can never be read as "this is the whole
   * set". `requestText` binds every page (Link targets included) to the
   * validated origin, so a hostile Link header can never carry the token
   * off-platform. */
  async listIssueCommentsResult(): Promise<IssueCommentEnumeration> {
    const comments: PublishCommentRef[] = [];
    let url: string | null = this.url(
      `/repos/${this.repo}/issues/${this.prNumber}/comments?per_page=${ISSUE_COMMENT_PAGE_SIZE}`,
    );
    for (let page = 0; url !== null; page += 1) {
      if (page >= MAX_ISSUE_COMMENT_PAGES) return { complete: false, comments };
      try {
        const captured = await requestText(url, this.opts("GET"));
        if (captured.status !== 200) return { complete: false, comments };
        let data: unknown;
        try {
          data = JSON.parse(captured.text) as unknown;
        } catch {
          return { complete: false, comments };
        }
        if (!Array.isArray(data)) return { complete: false, comments };
        comments.push(...(data as PublishCommentRef[]));
        const next = nextLink(captured.headers.get("link"));
        url = next === null ? null : new URL(next, url).toString();
      } catch {
        return { complete: false, comments };
      }
    }
    return { complete: true, comments };
  }

  async upsertStickyComment(marker: string, body: string): Promise<StickyResult> {
    // #1121: selecting the PATCH target is a claim about ABSENCE — "no newer
    // marker comment exists" — exactly like the prior-published-head read
    // (#1027), so it reads through the completeness-bearing enumeration and
    // refuses to guess on an unproven one. On a truncated list the selection
    // would PATCH an OLDER owned sticky (leaving the actual current
    // publication showing a previous review against a newer head) or, when
    // the owned sticky lives past the truncation point, fall to the creation
    // path and leave a duplicate managed sticky behind. Fail closed BEFORE
    // any identity read or write; `StickyResult.ok: false` is the shape the
    // caller already reports as a publication failure.
    const enumeration = await this.listIssueCommentsResult();
    if (enumeration.complete !== true || !Array.isArray(enumeration.comments)) {
      return { ok: false, created: false, error: "GitHub sticky comment enumeration is incomplete" };
    }
    const matching = enumeration.comments.filter((c) => typeof c.body === "string" && c.body.includes(marker));
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

  /** #763: post a plain follow-up reply VERBATIM (follow-up answers are
   * rendered by `renderFollowUpReply` upstream, which stamps the loop-guard
   * marker; this seam neither adds nor strips markers). The body is sent as
   * JSON request DATA to the repo-scoped issue-comments endpoint; it can never
   * alter the request URL or path, and the credential stays bound to the
   * validated origin. An empty body is refused before any request. */
  async postIssueComment(body: string): Promise<CommentPostResult> {
    if (typeof body !== "string" || body === "") {
      return { ok: false, created: false, error: "comment body must be a non-empty string" };
    }
    try {
      const { status, data } = await requestJson(
        this.url(`/repos/${this.repo}/issues/${this.prNumber}/comments`),
        this.opts("POST", { body }),
      );
      if (status !== 200 && status !== 201) return { ok: false, created: false, error: `status ${status}` };
      const created = data as { id?: number | string } | null;
      return created?.id === undefined
        ? { ok: true, created: true }
        : { ok: true, created: true, commentId: created.id };
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
    // #1144: the review id is interpolated into a REST path segment
    // (`/reviews/{id}/dismissals`), so a malformed id is refused BEFORE any
    // request is issued — the seam never sends an unusable id to the forge.
    if (!/^[1-9]\d*$/.test(String(reviewId))) return false;
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

/**
 * #1144: map a raw Forgejo review row to the GitHub-shaped review-state
 * vocabulary the forge-agnostic publish cleanup layer speaks.
 *
 * The two Forgejo seams deliberately differ. `normalize.ts`
 * (`normalizeForgejoReview`) is a byte-exact v2-parity port of the READ
 * seam's projection and stays untouched; this seam serves the GitHub-shaped
 * `PublishReviewRef` contract, so a Forgejo row is translated here instead
 * of leaking `ReviewStateType` tokens into the cleanup layer (where a
 * `REQUEST_CHANGES` verdict would never match the hide/dismiss state set
 * and would keep blocking merges).
 *
 * - a dismissed review is `DISMISSED` — Forgejo keeps the original state
 *   token and flags the dismissal separately;
 * - `REQUEST_REVIEW` is an unsubmitted review-request placeholder, not a
 *   verdict, so it reads as `PENDING` and the cleanup layer fails closed
 *   on it;
 * - an unknown, missing, or non-string state is `""`, which the cleanup
 *   layer also fails closed on.
 */
export function forgejoReviewState(raw: unknown): string {
  if (raw === null || typeof raw !== "object") return "";
  const row = raw as { state?: unknown; event?: unknown; dismissed?: unknown };
  if (row.dismissed === true) return "DISMISSED";
  const rawState = typeof row.state === "string" && row.state.trim() !== ""
    ? row.state
    : typeof row.event === "string" ? row.event : "";
  const state = rawState.trim().toUpperCase();
  if (state === "APPROVED" || state === "APPROVE") return "APPROVED";
  if (state === "REQUEST_CHANGES") return "CHANGES_REQUESTED";
  if (state === "COMMENT") return "COMMENTED";
  if (state === "PENDING") return "PENDING";
  if (state === "REQUEST_REVIEW") return "PENDING";
  return "";
}

/** Forgejo generates integration audiences as `u:<owner ID>:<UUID>`;
 * parsing lives in the shared owner-identity policy (#1093). */

export class ForgejoPublishApi implements PublishPlatformApi {
  readonly platform = "forgejo" as const;
  /** #588: Forgejo hosts native pull reviews (the review event and its
   * inline review comments), so the publish step takes the native path. */
  readonly nativeReviewSurface: NativeReviewSurface = { supported: true };
  /** #1176: Forgejo offers author-side deletion of a submitted review
   * (`DELETE /repos/{owner}/{repo}/pulls/{index}/reviews/{id}`), which the
   * cleanup layer may substitute for the GraphQL hide Forgejo cannot do.
   * Upstream `models/issues.DeleteReview` refuses ONLY `ReviewTypeRequest` —
   * the review-request pseudo-entry, distinct from a REQUEST_CHANGES verdict
   * (the API maps event `CHANGES_REQUESTED` to `ReviewTypeReject`, a deletable
   * type). Managed reviews are always submitted authored reviews — the adapter
   * never creates review requests (`requestReviewers` is unsupported, #1005),
   * and a bodyless review-request entry fails the eligibility filter anyway
   * (no managed marker in body; `REQUEST_REVIEW` reads `PENDING`, which the
   * cleanup layer fails closed on) — so the upstream refusal never applies to
   * a cleanup target.
   * #1181: deletion is additionally a NON-VERDICT-state operation — the
   * upstream restore side effect (`DeleteReview` →
   * `restoreLatestOfficialReview`) can re-official an older
   * Approve/Reject/Request review by the same reviewer, so whole-review
   * deletion must never be reachable from a verdict row. The cleanup layer
   * never calls `deleteSupersededReview` for `APPROVED`/`CHANGES_REQUESTED`
   * rows (they keep the dismissal path) and refuses rows whose `official`
   * flag is not proven `false`; a failed DELETE on a non-verdict row is a
   * bounded failure — no dismissal fallback applies to non-verdict rows. */
  readonly supersededReviewDeletion: NativeReviewSurface = { supported: true };
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
    /** #1678: which product the endpoint runs. `"gitea"` forwards to the adapter,
     * whose constructor refuses the Forgejo-only `authorized_integration` mode. */
    forge?: GiteaFamilyForge | undefined;
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
    // #1678: the same refusal the read adapter raises, restated here so the
    // publish boundary names itself as the rejecter regardless of the order the
    // adapter below is constructed in.
    if (options.forge === "gitea" && this.integrationMode) {
      throw new Error(GITEA_INTEGRATION_REFUSAL);
    }
    this.authorization = new ForgejoAdapter({
      repo: options.repo,
      prNumber: options.prNumber,
      baseUrl: options.baseUrl ?? "",
      token: options.token,
      authMethod: options.authMethod,
      authorizedIntegrationAudience: options.authorizedIntegrationAudience,
      ...(options.forge === undefined ? {} : { forge: options.forge }),
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

  /** #763: post a plain follow-up reply VERBATIM (follow-up answers are
   * rendered by `renderFollowUpReply` upstream, which stamps the loop-guard
   * marker; this seam neither adds nor strips markers). Same data-only posture
   * as the sticky creation path — the body is JSON request data and the
   * credential is bound to the validated Forgejo origin. An empty body is
   * refused before any request. */
  async postIssueComment(body: string): Promise<CommentPostResult> {
    if (typeof body !== "string" || body === "") {
      return { ok: false, created: false, error: "comment body must be a non-empty string" };
    }
    try {
      const { status, data } = await requestJson(
        this.url(`/repos/${this.repo}/issues/${this.prNumber}/comments`),
        await this.opts("POST", { body }),
      );
      if (status !== 200 && status !== 201) return { ok: false, created: false, error: `status ${status}` };
      const created = data as { id?: number | string } | null;
      return created?.id === undefined
        ? { ok: true, created: true }
        : { ok: true, created: true, commentId: created.id };
    } catch (error) {
      return { ok: false, created: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listReviews(): Promise<PublishReviewRef[]> {
    const reviews: PublishReviewRef[] = [];
    for (let page = 1; page <= 10; page++) {
      const { status, data } = await requestJson(this.url(`/repos/${this.repo}/pulls/${this.prNumber}/reviews?limit=100&page=${page}`), await this.opts("GET"));
      if (status !== 200 || !Array.isArray(data)) throw new Error("Incomplete review listing");
      // #1144: the cleanup layer is forge-agnostic and decides on GitHub's
      // review-state vocabulary, while Forgejo reports its own
      // `ReviewStateType` tokens — every row is normalized here, so a stale
      // `REQUEST_CHANGES` verdict is still recognised (and dismissed) and a
      // `COMMENT` body is still recognised (and hidden).
      reviews.push(...(data as PublishReviewRef[]).map((row) => ({ ...row, state: forgejoReviewState(row) })));
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
    // #1144: the review id is interpolated into a REST path segment
    // (`/reviews/{id}/dismissals`), so a malformed id is refused BEFORE any
    // request is issued — the seam never sends an unusable id to the forge.
    if (!/^[1-9]\d*$/.test(String(reviewId))) return false;
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

  /** #1176: author-side deletion of a submitted Forgejo review
   * (`DELETE /repos/{owner}/{repo}/pulls/{index}/reviews/{id}` — allowed to
   * the review's own author, `ctx.Doer().ID == review.ReviewerID`, without
   * repo admin; Forgejo has no GraphQL minimization, so this is the only way
   * a superseded managed advisory body stops staying visible). The endpoint
   * deletes the review AND all of its code comments, so the cleanup layer
   * proves a review carries no inline comments before ever calling this.
   * The id is interpolated into a REST path segment, so a malformed id is
   * refused WITHOUT any request — an unusable id never reaches the forge. A
   * 404 is deliberately NOT an idempotent success: a route-level 404
   * (unsupported forge version) is indistinguishable from "already gone",
   * and reading it as success would log a deletion that never happened.
   * #1181: this seam is a non-verdict-state operation — the caller (cleanup)
   * never invokes it for a verdict row, because deleting also triggers the
   * upstream `restoreLatestOfficialReview` side effect (the latest remaining
   * Approve/Reject/Request review by the same reviewer is re-officialed
   * without a Dismissed filter), which could reactivate a stale verdict.
   * A failed DELETE on a non-verdict row is a bounded failure; no dismissal
   * fallback applies to non-verdict rows (dismissal is the verdict-state
   * path). */
  async deleteSupersededReview(reviewId: number | string): Promise<ReviewDeletionResult> {
    if (!/^[1-9]\d*$/.test(String(reviewId))) {
      return { ok: false, error: "refusing a malformed review id" };
    }
    try {
      const { status } = await requestText(
        this.url(`/repos/${this.repo}/pulls/${this.prNumber}/reviews/${reviewId}`),
        await this.opts("DELETE"),
      );
      return status === 204
        ? { ok: true }
        : { ok: false, error: `status ${status}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
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

/** Map a raw GitLab MR-review row onto the GitHub-shaped review-state
 * vocabulary the forge-agnostic cleanup layer speaks (the
 * {@link forgejoReviewState} analogue). GitLab review states are
 * `approved` / `requested_changes` / `commented`; an unknown or missing
 * state is `""`, which the cleanup layer fails closed on. Exported for
 * tests. */
export function gitlabReviewState(raw: unknown): string {
  if (raw === null || typeof raw !== "object") return "";
  const state = typeof (raw as { state?: unknown }).state === "string"
    ? ((raw as { state: string }).state).trim().toLowerCase()
    : "";
  if (state === "approved") return "APPROVED";
  if (state === "requested_changes") return "CHANGES_REQUESTED";
  if (state === "commented") return "COMMENTED";
  return "";
}

const GITLAB_SHA_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;

/**
 * GitLab publication seam (#740), following {@link ForgejoPublishApi}'s
 * structure: every operation reports failure instead of throwing where the
 * caller logs a warning and continues, and capabilities that GitLab's REST
 * v4 surface genuinely does not map degrade explicitly (`supported:false` /
 * empty / `ok:false`) — never a faked success.
 *
 * Credential: `PRIVATE-TOKEN` header only ({@link gitlabFetch}), bound to the
 * validated base origin by the shared transport; never in a URL or body.
 *
 * Endpoint-family notes (where GitLab differs structurally from GitHub):
 * - MR notes ARE the conversation comments; the sticky upsert uses the
 *   marker-semantics of `DEFAULT_MANAGED_MARKER` with PUT/POST on
 *   `/merge_requests/:iid/notes`.
 * - inline findings are positioned discussion notes (`POST /discussions`
 *   with a `position` built from the MR's current `diff_refs`), retired via
 *   `DELETE /discussions/:did/notes/:nid`. They are NOT children of a review
 *   row, so the review-id-keyed seams that cannot be attributed degrade
 *   ({@link listManagedInlineComments}).
 * - the native review + verdict is `POST /merge_requests/:iid/reviews` plus
 *   `POST /approve` / `POST /request_changes`. The REST reviews endpoint is
 *   recent: on instances without it the create call is a bounded failure
 *   (`ok:false`, status in the error), never a silent success.
 * - resolving a thread resolves the DISCUSSION (`PUT /discussions/:did?
 *   resolved=true`); {@link reviewThreadStates} projects positioned
 *   discussions to `{threadId, resolved, firstCommentId}` and consumers join
 *   by `firstCommentId` — GitLab discussions are not grouped under review
 *   ids, so the managedReviewIds filter cannot apply here and is documented
 *   as unused rather than approximated.
 * - GraphQL-only features (minimization) are declared false in
 *   `GITLAB_CAPABILITIES` and degrade exactly like Forgejo's.
 */
export class GitLabPublishApi implements PublishPlatformApi {
  readonly platform = "gitlab" as const;
  /** GitLab hosts native MR review events (`/reviews` + approve /
   * request_changes) and positioned inline notes, so the publish step takes
   * the native path; an instance too old for the REST reviews endpoint gets
   * a bounded createReview failure, not a faked success. */
  readonly nativeReviewSurface: NativeReviewSurface = { supported: true };
  /** GitHub hides superseded review bodies with GraphQL minimization and
   * Forgejo deletes the review row outright. GitLab's review-deletion
   * endpoint is recent and its side effects on the MR's approval state are
   * unverified here, so the whole-review cleanup surface stays declared
   * unsupported: the dismissal path ({@link dismissReview}, the same DELETE
   * on a verdict row the cleanup layer already targets) is the reviewed
   * route. */
  readonly supersededReviewDeletion: NativeReviewSurface = {
    supported: false,
    reason: "GitLab review deletion (DELETE /reviews/:id) is recent and its approval-state side effects are unverified; only the verdict dismissal path is relied upon",
  };
  private readonly base: string;
  private readonly origin: string;
  private readonly repo: string;
  private readonly prNumber: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: {
    repo: string;
    prNumber: string;
    token?: string | undefined;
    baseUrl?: string | undefined;
    timeoutMs?: number | undefined;
    fetchImpl?: FetchLike | undefined;
  }) {
    // No default endpoint: an empty/invalid base fails at construction
    // (#674 SSRF boundary), before any credential exists.
    const parsed = parsePlatformBaseUrl(options.baseUrl ?? "", "GitLab API base URL");
    this.base = parsed.base;
    this.origin = parsed.origin;
    const path = parseGitLabProjectPath(options.repo);
    if (path === null) throw new Error(`Invalid GitLab project path: ${gitlabProjectPathForDiagnostics(options.repo)}`);
    this.repo = path;
    this.prNumber = options.prNumber;
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.fetchImpl = gitlabFetch(options.token, options.fetchImpl ?? fetch);
  }

  /** A project-scoped /api/v4 URL, refused (throws) when the project path is
   * invalid or the normalized path escapes the intended prefix. */
  private url(staticTail: string, dynamicTail = ""): string {
    const url = gitlabProjectScopedUrl(`${this.base}/api/v4`, this.repo, staticTail, dynamicTail);
    if (url === null) throw new Error(`Refusing a request outside project ${gitlabProjectPathForDiagnostics(this.repo)}`);
    return url;
  }

  private opts(method: string, body?: unknown): Parameters<typeof requestJson>[1] {
    return {
      method,
      // The credential is the PRIVATE-TOKEN header attached by
      // `this.fetchImpl`; the Authorization channel stays unused.
      token: undefined,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      allowedOrigin: this.origin,
      body: body === undefined ? undefined : JSON.stringify(body),
    };
  }

  /** `GET /user` → `username`; any failure is null (fail closed). */
  async authenticatedIdentity(): Promise<string | null> {
    try {
      const { status, data } = await requestJson(`${this.base}/api/v4/user`, this.opts("GET"));
      if (status !== 200 || data === null || typeof data !== "object") return null;
      const username = (data as { username?: unknown }).username;
      return typeof username === "string" && username.trim() !== "" ? username : null;
    } catch {
      return null;
    }
  }

  /** MR read → `diff_refs.head_sha`, the current MR head for the #451
   * publication-boundary re-check. */
  async getHeadSha(): Promise<string | null> {
    try {
      const { status, data } = await requestJson(this.url("/merge_requests/", this.prNumber), this.opts("GET"));
      if (status !== 200 || data === null || typeof data !== "object") return null;
      const diffRefs = (data as { diff_refs?: unknown }).diff_refs;
      const sha = diffRefs !== null && typeof diffRefs === "object"
        ? (diffRefs as { head_sha?: unknown }).head_sha
        : undefined;
      return typeof sha === "string" && sha !== "" ? sha : null;
    } catch {
      return null;
    }
  }

  /** MR notes, system notes excluded — the managed conversation surface.
   * The strict read either enumerates to a proven end or throws, so
   * completeness is exactly "it did not throw" (Forgejo's #1027 posture). */
  private async listNotesStrict(): Promise<PublishCommentRef[]> {
    const comments: PublishCommentRef[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const { status, data } = await requestJson(
        this.url("/merge_requests/", `${this.prNumber}/notes?sort=asc&per_page=100&page=${page}`),
        this.opts("GET"),
      );
      if (status !== 200 || !Array.isArray(data)) throw new Error(`GitLab MR notes read failed (status ${status})`);
      for (const note of data) {
        if (note === null || typeof note !== "object") continue;
        const row = note as {
          id?: number | string; body?: unknown; created_at?: unknown; updated_at?: unknown; system?: unknown;
          author?: { id?: number | string; username?: unknown } | null;
        };
        if (row.system === true) continue;
        comments.push({
          id: row.id as number | string,
          body: typeof row.body === "string" ? row.body : "",
          ...(typeof row.updated_at === "string" ? { updated_at: row.updated_at } : {}),
          user: row.author !== null && typeof row.author === "object"
            ? {
              ...(row.author.id !== undefined ? { id: row.author.id } : {}),
              ...(typeof row.author.username === "string" ? { login: row.author.username } : {}),
            }
            : null,
        });
      }
      if (data.length < 100) return comments;
    }
    throw new Error("GitLab MR notes exceeded the pagination limit");
  }

  async listIssueCommentsResult(): Promise<IssueCommentEnumeration> {
    try {
      return { complete: true, comments: await this.listNotesStrict() };
    } catch {
      return { complete: false, comments: [] };
    }
  }

  async listIssueComments(): Promise<PublishCommentRef[]> {
    try {
      return await this.listNotesStrict();
    } catch {
      return [];
    }
  }

  /** Sticky managed-comment upsert on the MR note surface. Same
   * DEFAULT_MANAGED_MARKER semantics as the GitHub adapter: the PATCH target
   * is the newest marker-bearing note AND must be proven owned by this run's
   * authenticated identity (a foreign-authored or unattributable marker is
   * never overwritten; an unprovable identity fails closed). Creation needs
   * no proof — creating never destroys anything. */
  async upsertStickyComment(marker: string, body: string): Promise<StickyResult> {
    let comments: PublishCommentRef[];
    try {
      comments = await this.listNotesStrict();
    } catch (error) {
      return { ok: false, created: false, error: error instanceof Error ? error.message : String(error) };
    }
    const matching = comments.filter((c) => typeof c.body === "string" && c.body.includes(marker));
    matching.sort((a, b) => {
      const updated = String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""));
      if (updated !== 0) return updated;
      const aId = Number(a.id);
      const bId = Number(b.id);
      return Number.isSafeInteger(aId) && Number.isSafeInteger(bId) ? bId - aId : 0;
    });
    let target = matching[0];
    if (target !== undefined) {
      const login = await this.authenticatedIdentity();
      if (login === null) return { ok: false, created: false, error: "GitLab sticky comment owner could not be verified" };
      const identity: TrustedOwnerIdentity = { kind: "login", login };
      target = matching.find((comment) => ownerMatchesIdentity(comment.user, identity));
      if (target === undefined
        && matching.some((comment) => typeof comment.user?.login !== "string" || comment.user.login.trim() === "")) {
        return { ok: false, created: false, error: "GitLab sticky comment ownership is unknown" };
      }
    }
    try {
      if (target === undefined) {
        const { status, data } = await requestJson(
          this.url("/merge_requests/", `${this.prNumber}/notes`),
          this.opts("POST", { body }),
        );
        if (status !== 200 && status !== 201) return { ok: false, created: false, error: `status ${status}` };
        const created = data as { id?: number | string; updated_at?: unknown } | null;
        const updatedAt = typeof created?.updated_at === "string" ? created.updated_at : undefined;
        return created?.id === undefined
          ? { ok: true, created: true, ...(updatedAt === undefined ? {} : { updatedAt }) }
          : { ok: true, created: true, commentId: created.id, ...(updatedAt === undefined ? {} : { updatedAt }) };
      }
      const { status, data } = await requestJson(
        this.url("/merge_requests/", `${this.prNumber}/notes/${target.id}`),
        this.opts("PUT", { body }),
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

  /** #763: post one plain top-level note VERBATIM (marker semantics belong
   * to the caller's renderer). The body is JSON request DATA only; an empty
   * body is refused before any request. */
  async postIssueComment(body: string): Promise<CommentPostResult> {
    if (typeof body !== "string" || body === "") {
      return { ok: false, created: false, error: "comment body must be a non-empty string" };
    }
    try {
      const { status, data } = await requestJson(
        this.url("/merge_requests/", `${this.prNumber}/notes`),
        this.opts("POST", { body }),
      );
      if (status !== 200 && status !== 201) return { ok: false, created: false, error: `status ${status}` };
      const created = data as { id?: number | string } | null;
      return created?.id === undefined
        ? { ok: true, created: true }
        : { ok: true, created: true, commentId: created.id };
    } catch (error) {
      return { ok: false, created: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listReviews(): Promise<PublishReviewRef[]> {
    const reviews: PublishReviewRef[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const { status, data } = await requestJson(
        this.url("/merge_requests/", `${this.prNumber}/reviews?per_page=100&page=${page}`),
        this.opts("GET"),
      );
      if (status !== 200 || !Array.isArray(data)) throw new Error("Incomplete review listing; cleanup must fail closed");
      for (const row of data) {
        if (row === null || typeof row !== "object") throw new Error("Incomplete review listing; cleanup must fail closed");
        const review = row as {
          id?: number | string; state?: unknown; created_at?: unknown;
          reviewer?: { id?: number | string; username?: unknown } | null;
        };
        const user = review.reviewer !== null && typeof review.reviewer === "object"
          ? {
            ...(review.reviewer.id !== undefined ? { id: review.reviewer.id } : {}),
            ...(typeof review.reviewer.username === "string" ? { login: review.reviewer.username } : {}),
          }
          : null;
        reviews.push({
          id: review.id as number | string,
          state: gitlabReviewState(review),
          ...(typeof review.created_at === "string" ? { submitted_at: review.created_at } : {}),
          user,
        });
      }
      if (data.length < 100) return reviews;
    }
    throw new Error("Review listing exceeded pagination cap");
  }

  /** Degraded: GitLab inline findings are positioned DISCUSSION notes, not
   * children of a review row, so there is no review-id-keyed comment listing
   * to enumerate. The cleanup layer's "prove the review carries no inline
   * findings" step reads this as unsupported and fails closed — retirement
   * of this action's own inline notes goes through
   * {@link retireInlineComment} on the note's own discussion id. */
  async listManagedInlineComments(_reviewIds: readonly string[]): Promise<{ supported: boolean; complete: boolean; comments: ManagedInlineCommentRef[] }> {
    return { supported: false, complete: false, comments: [] };
  }

  /** Retire one published inline note:
   * `DELETE /merge_requests/:iid/discussions/:discussionId/notes/:noteId`.
   * This action's inline findings are posted as individual discussions,
   * where the discussion id equals the first note's id, so the seam's
   * `reviewId` argument carries that discussion id on GitLab. Both ids go
   * into REST path segments and are refused WITHOUT a request when
   * malformed; a 404 is a bounded failure, never an idempotent success (a
   * route-level 404 is indistinguishable from "already gone"). */
  async retireInlineComment(reviewId: string, commentId: string): Promise<boolean> {
    if (!/^[1-9]\d*$/.test(reviewId) || !/^[1-9]\d*$/.test(commentId)) return false;
    try {
      const { status } = await requestText(
        this.url("/merge_requests/", `${this.prNumber}/discussions/${reviewId}/notes/${commentId}`),
        this.opts("DELETE"),
      );
      return status === 200 || status === 204;
    } catch {
      return false;
    }
  }

  /** Anchor the inline comments of a review request against the MR's current
   * `diff_refs` (GitLab text positions are addressed by
   * base/start/head sha + new path/line, not GitHub's position index).
   * Comments without a usable line are DROPPED (the same re-anchor-or-drop
   * doctrine Forgejo applies via its position map); multi-line suggestion
   * ranges are not expressible and carry only their end line. */
  private async positionComments(
    comments: NativeReviewComment[] | undefined,
  ): Promise<Array<{ body: string; position: Record<string, unknown> }> | null> {
    if (!Array.isArray(comments) || comments.length === 0) return [];
    const { status, data } = await requestJson(this.url("/merge_requests/", this.prNumber), this.opts("GET"));
    if (status !== 200 || data === null || typeof data !== "object") return null;
    const diffRefs = (data as { diff_refs?: unknown }).diff_refs;
    if (diffRefs === null || typeof diffRefs !== "object") return null;
    const refs = diffRefs as { base_sha?: unknown; start_sha?: unknown; head_sha?: unknown };
    if (typeof refs.base_sha !== "string" || typeof refs.head_sha !== "string") return null;
    const startSha = typeof refs.start_sha === "string" ? refs.start_sha : refs.base_sha;
    const positioned: Array<{ body: string; position: Record<string, unknown> }> = [];
    for (const comment of comments) {
      if (!comment || typeof comment.path !== "string" || !comment.path
        || typeof comment.body !== "string" || !comment.body
        || typeof comment.line !== "number" || !Number.isInteger(comment.line) || comment.line <= 0) {
        continue;
      }
      positioned.push({
        body: comment.body,
        position: {
          base_sha: refs.base_sha,
          start_sha: startSha,
          head_sha: refs.head_sha,
          position_type: "text",
          new_path: comment.path,
          new_line: comment.line,
        },
      });
    }
    return positioned;
  }

  /** Create the native review: inline findings first (positioned discussion
   * notes — the endpoint the GitLab REST surface actually offers for them),
   * then the review record `POST /merge_requests/:iid/reviews`, then the
   * verdict: APPROVE → `POST /approve`, REQUEST_CHANGES →
   * `POST /request_changes`, COMMENT → nothing extra. Every step reports a
   * bounded failure (`ok:false` with the status) on the first one the
   * instance refuses — the REST reviews endpoint in particular is recent,
   * and an instance without it must surface a publication failure, never a
   * faked success. */
  async createReview(request: NativeReviewRequest): Promise<{ ok: boolean; error?: string; reviewId?: number | string }> {
    try {
      const positioned = await this.positionComments(request.comments);
      if (positioned === null) {
        return { ok: false, error: "could not resolve the MR diff refs for inline comment positions" };
      }
      // Inline findings travel as positioned individual discussions so they
      // anchor on the diff even where the review record itself would not
      // accept them.
      for (const comment of positioned) {
        const { status } = await requestJson(
          this.url("/merge_requests/", `${this.prNumber}/discussions`),
          this.opts("POST", { body: comment.body, position: comment.position }),
        );
        if (status !== 200 && status !== 201) return { ok: false, error: `inline comment status ${status}` };
      }
      const { status, data } = await requestJson(
        this.url("/merge_requests/", `${this.prNumber}/reviews`),
        this.opts("POST", { body: request.body }),
      );
      if (status !== 200 && status !== 201) return { ok: false, error: `status ${status}` };
      const reviewId = (data as { id?: number | string } | null)?.id;
      if (request.event === "APPROVE") {
        const approve = await requestJson(this.url("/merge_requests/", `${this.prNumber}/approve`), this.opts("POST", {}));
        if (approve.status !== 200 && approve.status !== 201) {
          return { ok: false, error: `approve status ${approve.status}`, ...(reviewId !== undefined ? { reviewId } : {}) };
        }
      } else if (request.event === "REQUEST_CHANGES") {
        const reject = await requestJson(
          this.url("/merge_requests/", `${this.prNumber}/request_changes`),
          this.opts("POST", {}),
        );
        if (reject.status !== 200 && reject.status !== 201) {
          return { ok: false, error: `request_changes status ${reject.status}`, ...(reviewId !== undefined ? { reviewId } : {}) };
        }
      }
      return status === 200 || status === 201
        ? { ok: true, ...(reviewId !== undefined ? { reviewId } : {}) }
        : { ok: false, error: `status ${status}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Dismiss a superseded verdict review by deleting it
   * (`DELETE /merge_requests/:iid/reviews/:id`) — GitLab has no dismissal
   * record with a message, so the message is deliberately dropped and the
   * deletion IS the dismissal. The endpoint is recent: a refusal (404/405)
   * is reported as false, a bounded failure like Forgejo's dismissal. */
  async dismissReview(reviewId: number | string, _message: string): Promise<boolean> {
    if (!/^[1-9]\d*$/.test(String(reviewId))) return false;
    try {
      const { status } = await requestText(
        this.url("/merge_requests/", `${this.prNumber}/reviews/${reviewId}`),
        this.opts("DELETE"),
      );
      return status === 200 || status === 204;
    } catch {
      return false;
    }
  }

  /** GraphQL-only (declared false in GITLAB_CAPABILITIES): degrade exactly
   * like Forgejo — the caller notes the degradation and continues. */
  async minimizedReviewIds(): Promise<string[]> {
    return [];
  }

  async minimizeReview(_nodeId: string): Promise<boolean> {
    return false;
  }

  async unresolvedSupersededThreads(_managedIds: number[]): Promise<ThreadQueryResult> {
    return { ok: false, threads: [], hasNextPage: false, error: "no GraphQL API" };
  }

  /** Position-discussion thread states for the #1559 outcome observations:
   * GitLab resolves DISCUSSIONS, not GitHub review threads, so every
   * discussion carrying a positioned note is reported as
   * `{threadId: discussionId, resolved, firstCommentId: first positioned
   * note id}` and the consumer joins on `firstCommentId` (its own published
   * note ids). The `managedReviewIds` argument cannot apply — GitLab
   * discussions are not grouped under review rows — so it is unused rather
   * than approximated. The read declares `complete:false` on a failed page
   * or an exhausted page cap: an absent thread is then not proven absent. */
  async reviewThreadStates(_managedReviewIds: readonly string[]): Promise<ReviewThreadStatesResult> {
    const threads: ReviewThreadState[] = [];
    try {
      for (let page = 1; page <= 20; page += 1) {
        const { status, data } = await requestJson(
          this.url("/merge_requests/", `${this.prNumber}/discussions?per_page=100&page=${page}`),
          this.opts("GET"),
        );
        if (status !== 200 || !Array.isArray(data)) return { supported: true, complete: false, threads: [] };
        for (const discussion of data) {
          if (discussion === null || typeof discussion !== "object") return { supported: true, complete: false, threads: [] };
          const row = discussion as { id?: number | string; resolved?: unknown; notes?: unknown };
          if (!Array.isArray(row.notes)) return { supported: true, complete: false, threads: [] };
          const positioned = row.notes.filter((note) => note !== null && typeof note === "object"
            && (note as { position?: unknown }).position !== null
            && typeof (note as { position?: unknown }).position === "object");
          if (positioned.length === 0) continue;
          const first = positioned[0] as { id?: number | string };
          threads.push({
            threadId: String(row.id ?? ""),
            resolved: row.resolved === true,
            firstCommentId: first.id === undefined ? "" : String(first.id),
          });
        }
        if (data.length < 100) return { supported: true, complete: true, threads };
        if (page === 20) return { supported: true, complete: false, threads: [] };
      }
      return { supported: true, complete: false, threads: [] };
    } catch {
      return { supported: true, complete: false, threads: [] };
    }
  }

  /** Resolve/reresolve a thread = resolve the DISCUSSION
   * (`PUT /merge_requests/:iid/discussions/:did?resolved=true`). The thread
   * id is the discussion id from {@link reviewThreadStates}. A malformed id
   * is refused without a request. */
  async resolveThread(threadId: string): Promise<boolean> {
    if (!/^[1-9]\d*$/.test(threadId)) return false;
    try {
      const { status } = await requestJson(
        this.url("/merge_requests/", `${this.prNumber}/discussions/${encodeURIComponent(threadId)}?resolved=true`),
        this.opts("PUT", {}),
      );
      return status === 200;
    } catch {
      return false;
    }
  }

  /** Remove a label from the MR by name:
   * `DELETE /merge_requests/:iid/labels?label_names[]=<label>` — GitLab's
   * label-removal-by-name endpoint (there is no per-label DELETE route on
   * the MR side). */
  async removeLabel(label: string): Promise<boolean> {
    if (typeof label !== "string" || label === "") return false;
    try {
      const { status } = await requestJson(
        this.url("/merge_requests/", `${this.prNumber}/labels?label_names[]=${encodeURIComponent(label)}`),
        this.opts("DELETE"),
      );
      return status === 200 || status === 204;
    } catch {
      return false;
    }
  }

  /** #1005: GitLab reviewer requests (`POST /merge_requests/:iid/reviewers`,
   * `reviewer_ids` of resolved user ids) — supported for USERS. GitHub's
   * team concept does not map: a non-empty `teams` request is answered with
   * the not-supported-for-teams failure and NOTHING is mutated, so a team
   * request is never silently dropped. Idempotent via the current-reviewers
   * read; username resolution (`GET /users?username=`) must match exactly
   * one account or the whole request fails closed. */
  async requestReviewers(users: readonly string[], teams: readonly string[]): Promise<ReviewerRequestResult> {
    const none = (): Pick<ReviewerRequestResult, "requestedUsers" | "requestedTeams" | "alreadyRequestedUsers" | "alreadyRequestedTeams"> =>
      ({ requestedUsers: [], requestedTeams: [], alreadyRequestedUsers: [], alreadyRequestedTeams: [] });
    const cleanUsers = [...new Set(users.map((u) => u.trim()))].filter((u) => u !== "");
    const cleanTeams = [...new Set(teams.map((t) => t.trim()))].filter((t) => t !== "");
    if (cleanTeams.length > 0) {
      return {
        ok: false,
        supported: true,
        ...none(),
        error: "GitLab has no team reviewers; team reviewer requests are not supported and were not sent",
      };
    }
    if (cleanUsers.some((u) => !REQUESTER_USER.test(u))) {
      return { ok: false, supported: true, ...none(), error: "reviewer request rejected: an identity is not a valid GitLab username" };
    }
    if (cleanUsers.length === 0) return { ok: true, supported: true, ...none() };
    let existing: string[];
    try {
      const { status, data } = await requestJson(this.url("/merge_requests/", `${this.prNumber}/reviewers`), this.opts("GET"));
      if (status !== 200 || !Array.isArray(data)) {
        return { ok: false, supported: true, ...none(), error: `could not read requested reviewers (status ${status})` };
      }
      const logins = data.map((entry) => {
        const username = (entry as { username?: unknown } | null)?.username;
        return typeof username === "string" && username !== "" ? username : null;
      });
      if (logins.includes(null)) {
        return { ok: false, supported: true, ...none(), error: "could not read requested reviewers (malformed response: a reviewer entry lacks a username)" };
      }
      existing = logins as string[];
    } catch (error) {
      return { ok: false, supported: true, ...none(), error: error instanceof Error ? error.message : String(error) };
    }
    const existingSet = new Set(existing.map((u) => u.toLowerCase()));
    const newUsers = cleanUsers.filter((u) => !existingSet.has(u.toLowerCase()));
    const alreadyRequestedUsers = cleanUsers.filter((u) => existingSet.has(u.toLowerCase()));
    if (newUsers.length === 0) {
      return { ok: true, supported: true, requestedUsers: [], requestedTeams: [], alreadyRequestedUsers, alreadyRequestedTeams: [] };
    }
    // GitLab adds reviewers by user id; resolve each username through the
    // instance's user search and fail closed on any name that does not match
    // exactly one account (never substitute another reviewer).
    const ids: number[] = [];
    for (const username of newUsers) {
      try {
        const { status, data } = await requestJson(`${this.base}/api/v4/users?username=${encodeURIComponent(username)}`, this.opts("GET"));
        if (status !== 200 || !Array.isArray(data) || data.length !== 1) {
          return { ok: false, supported: true, ...none(), error: `could not resolve reviewer username ${username}` };
        }
        const match = data[0] as { id?: unknown; username?: unknown };
        if (typeof match.id !== "number" || typeof match.username !== "string"
          || match.username.toLowerCase() !== username.toLowerCase()) {
          return { ok: false, supported: true, ...none(), error: `could not resolve reviewer username ${username}` };
        }
        ids.push(match.id);
      } catch (error) {
        return { ok: false, supported: true, ...none(), error: error instanceof Error ? error.message : String(error) };
      }
    }
    try {
      const { status } = await requestJson(
        this.url("/merge_requests/", `${this.prNumber}/reviewers`),
        this.opts("POST", { reviewer_ids: ids }),
      );
      if (status !== 200 && status !== 201) {
        return { ok: false, supported: true, ...none(), error: `status ${status}` };
      }
      return { ok: true, supported: true, requestedUsers: newUsers, requestedTeams: [], alreadyRequestedUsers, alreadyRequestedTeams: [] };
    } catch (error) {
      return { ok: false, supported: true, ...none(), error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Review-comment feedback (👍/👎) is not ported for GitLab in #740 — the
   * same explicit degradation Forgejo reports, so the caller reads "no
   * feedback channel" and never mistakes the absence for "no reaction was
   * left". `collaboratorPermission` is deliberately absent: with no feedback
   * reader there is no actor to verify, so this adapter trusts nobody. */
  async reviewCommentFeedback(_commentIds: readonly string[]): Promise<CommentFeedbackResult> {
    return { supported: false, complete: false, records: [] };
  }

  /** Commit status (`POST /projects/:id/statuses/:sha`): GitLab has no
   * Actions check runs, so the commit status IS the external CI surface
   * (`GITLAB_CAPABILITIES`). Not part of `PublishPlatformApi` (the publish
   * flow has no forge-agnostic commit-status call today); the self-hosted
   * deployment lane calls it directly. A malformed sha is refused without a
   * request. */
  async postCommitStatus(
    sha: string,
    state: "pending" | "running" | "success" | "failed" | "canceled",
    options: { name?: string; targetUrl?: string; description?: string } = {},
  ): Promise<boolean> {
    if (!GITLAB_SHA_RE.test(sha)) return false;
    try {
      const body: Record<string, unknown> = { state };
      if (options.name !== undefined && options.name !== "") {
        body.name = options.name;
        body.context = options.name;
      }
      if (options.targetUrl !== undefined && options.targetUrl !== "") body.target_url = options.targetUrl;
      if (options.description !== undefined && options.description !== "") body.description = options.description;
      const { status } = await requestJson(
        this.url("/statuses/", encodeURIComponent(sha)),
        this.opts("POST", body),
      );
      return status === 200 || status === 201;
    } catch {
      return false;
    }
  }
}
