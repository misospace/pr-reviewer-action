/** GitLab REST v4 read adapter (#740).
 *
 * Mirrors {@link ForgejoAdapter}'s structure and failure doctrine: the base
 * URL is validated before any credential is attached (the #670/#682 SSRF
 * boundary via `parsePlatformBaseUrl`), every request is bound to that origin
 * through `requestJson`/`requestText`, redirects are refused, and a failed
 * read returns the {@link ReadResult} error channel (or null) — never a
 * fabricated value.
 *
 * Credential transport: GitLab authenticates REST calls with the
 * `PRIVATE-TOKEN` header, which {@link RequestOptions} does not model (it
 * carries only `Authorization`). The adapter therefore injects the header
 * through a fetch wrapper applied AFTER `requestText` has validated the
 * target origin: the credential can only ever reach the validated base, the
 * shared transport still refuses redirects and cross-origin targets, and the
 * token never enters a URL, argv, or a diagnostic (AGENTS invariant).
 *
 * GitLab specifics:
 * - project identity is a NESTED path validated by `parseGitLabProjectPath`
 *   and percent-encoded into `/projects/:id` by `gitlabProjectScopedUrl`;
 * - `prNumber` is the merge-request IID (project-scoped, like a PR number);
 * - the MR payload carries `diff_refs` for the head/base shas and only
 *   `source_project_id`/`target_project_id` for the fork picture — the source
 *   project PATH is proven by the `source_project_id === target_project_id`
 *   comparison plus, for cross-project MRs, one `GET /projects/:id` read. An
 *   MR that cannot answer that question fails the read cleanly rather than
 *   guessing "same repo" or "unknown". */

import { PlatformRequestError, errorText, requestJson, type FetchLike } from "./http.js";
import { normalizeForgejoConversationComments, normalizeForgejoPrFiles } from "./normalize.js";
import { gitlabProjectPathForDiagnostics, gitlabProjectScopedUrl, parseGitLabProjectPath, SHA_RE } from "./repo-ref.js";
import { parsePlatformBaseUrl } from "./urls.js";
import type {
  ExternalCheck,
  ExternalChecksOptions,
  GhApiResult,
  ManagedComment,
  ManagedReview,
  PlatformReadAdapter,
  ReadResult,
} from "./types.js";

const NUMBER_RE = /^[1-9]\d*$/;
const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
/** Page size and page cap of a GitLab list read. 100 is the REST default
 * maximum; the cap (20 pages, 2000 items) bounds the request loop so a huge
 * listing cannot turn the read into an unbounded fan-out. */
const GITLAB_LIST_PAGE_SIZE = 100;
const GITLAB_LIST_MAX_PAGES = 20;
/** Window of `listPrConversationComments` / `listReviewThreads`, matching the
 * v2 seam's 100-item snapshot cap. */
const GITLAB_SNAPSHOT_CAP = 100;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The forge-reported username of a GitLab `user` object (never body
 * content). Missing/non-string → undefined (unproven ownership). */
function gitlabUserLogin(user: unknown): string | undefined {
  if (!isObject(user)) return undefined;
  const username = user.username;
  return typeof username === "string" && username !== "" ? username : undefined;
}

/** A GitLab numeric id as a positive safe integer, or null. */
function gitlabNumericId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Wrap a fetch implementation so every request carries the GitLab
 * `PRIVATE-TOKEN` credential, preserving whatever headers the transport
 * already built. The wrap point is what makes this safe: `requestText`
 * validates the target origin BEFORE invoking fetch, so the credential only
 * ever reaches the caller's validated platform base, and it never travels in
 * a URL, argv, or a diagnostic (AGENTS invariant). Shared by the read adapter
 * and the publish API. */
export function gitlabFetch(token: string | undefined, base: FetchLike): FetchLike {
  if (token === undefined || token === "") return base;
  return (input, init) => {
    const merged = new Headers(init?.headers ?? {});
    merged.set("PRIVATE-TOKEN", token);
    return base(input, { ...init, headers: merged });
  };
}

export interface GitLabAdapterOptions {
  /** Nested (or two-segment) project path, e.g. `group/subgroup/project`. */
  repo: string;
  /** The merge-request IID. */
  prNumber: string;
  /** GITLAB_API_URL — validated before any credential is attached. There is
   * NO default endpoint: an empty base is refused. */
  baseUrl: string;
  /** Resolved GITLAB_TOKEN; absent → unauthenticated reads (which fail
   * closed against any non-public project). */
  token?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: FetchLike | undefined;
}

/** Project one GitLab MR payload into the GitHub-PR shape the seam consumes
 * (the `prToGithubShape` analogue for GitLab).
 *
 * The two project paths are RESOLVED inputs, not payload guesses: GitLab's
 * single-MR read carries only `source_project_id`/`target_project_id`, so the
 * caller proves the source path (same-project rule or
 * `GET /projects/{source_project_id}` → `path_with_namespace`) and hands it
 * in here. A null `sourceProjectPath` therefore means the fork picture could
 * not be proven, and this projection refuses to fabricate a PR (null).
 *
 * - number = the MR `iid` (project-scoped, the PR-number equivalent);
 * - head/base shas from `diff_refs` (`head_sha`/`base_sha`), branches from
 *   `source_branch`/`target_branch`;
 * - `state` is carried through verbatim (only an explicit string is
 *   authoritative — same #1301/#1307 doctrine as Forgejo: a partial read is
 *   NOT evidence the MR is open);
 * - draft: an explicit boolean `draft`, else the explicit boolean
 *   `work_in_progress` (the pre-15.x spelling); neither present → unknown,
 *   never defaulted to not-draft (#961);
 * - merged: GitLab reports a merged MR via `state: "merged"`; `merged_at` is
 *   carried through and `merge_commit_sha` is preserved alongside — a state
 *   of "merged" without either marker is still merged per the forge's own
 *   state field;
 * - `user.login` = `author.username`. */
export function prToGitlabPrShape(
  data: unknown,
  targetProjectPath: string,
  sourceProjectPath: string | null,
): unknown | null {
  if (!isObject(data)) return null;
  const iid = typeof data.iid === "number" || typeof data.iid === "string" ? data.iid : null;
  if (iid === null || sourceProjectPath === null) return null;
  const diffRefs = isObject(data.diff_refs) ? data.diff_refs : {};
  const draft = typeof data.draft === "boolean"
    ? data.draft
    : typeof data.work_in_progress === "boolean" ? data.work_in_progress : undefined;
  const state = typeof data.state === "string" ? data.state : undefined;
  const merged = state === "merged";
  return {
    number: iid,
    id: data.id ?? null,
    title: data.title ?? "",
    body: data.description ?? "",
    state,
    draft,
    user: { login: gitlabUserLogin(data.author) ?? "" },
    head: {
      sha: typeof diffRefs.head_sha === "string" ? diffRefs.head_sha : "",
      ref: data.source_branch ?? "",
      repo: { full_name: sourceProjectPath },
    },
    base: {
      sha: typeof diffRefs.base_sha === "string" ? diffRefs.base_sha : "",
      ref: data.target_branch ?? "",
      repo: { full_name: targetProjectPath },
    },
    merged,
    merged_at: data.merged_at ?? null,
    merge_commit_sha: data.merge_commit_sha ?? null,
    created_at: data.created_at ?? "",
    updated_at: data.updated_at ?? "",
    url: data.web_url ?? "",
    labels: Array.isArray(data.labels) ? data.labels.map((label) => ({ name: typeof label === "string" ? label : "" })) : [],
  };
}

/** Collapse one GitLab commit-status state onto the gate vocabulary the
 * shared CI layer speaks ("success" | "failure" | "pending"). `skipped`
 * counts as success: a skipped status never blocks a merge, exactly like a
 * GitHub neutral check for gate purposes. The raw state is preserved as the
 * `conclusion` for review context. Exported for tests. */
export function gitlabStatusState(state: unknown): { state: string; conclusion?: string } {
  const raw = typeof state === "string" && state !== "" ? state : "pending";
  if (raw === "success" || raw === "skipped") return { state: "success", conclusion: raw };
  if (raw === "failed" || raw === "canceled") return { state: "failure", conclusion: raw };
  return { state: "pending", conclusion: raw };
}

/** Map a project-member `access_level` onto the seam permission vocabulary.
 * GitLab levels: 10 guest, 20 reporter, 30 developer, 40 maintainer,
 * 50 owner. Exported for tests. */
export function gitlabPermissionFromAccessLevel(accessLevel: unknown): string | null {
  if (typeof accessLevel !== "number" || !Number.isFinite(accessLevel)) return null;
  if (accessLevel >= 50) return "admin";
  if (accessLevel >= 30) return "write";
  if (accessLevel >= 10) return "read";
  return "none";
}

/**
 * GitLab REST adapter implementing the platform read seam (#740).
 *
 * The constructor REFUSES an empty/invalid base URL (`parsePlatformBaseUrl`)
 * and an invalid project path (`parseGitLabProjectPath`) before anything can
 * send a request.
 */
export class GitLabAdapter implements PlatformReadAdapter {
  readonly platform = "gitlab" as const;
  readonly repo: string;
  readonly prNumber: string;
  private readonly baseUrl: string;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  /** #1341: the cause of the most recent `getPr()` failure, or null. */
  private lastPrReadFailure: PlatformRequestError | null = null;

  constructor(options: GitLabAdapterOptions) {
    const parsed = parsePlatformBaseUrl(options.baseUrl, "GitLab API base URL");
    this.baseUrl = parsed.base;
    this.origin = parsed.origin;
    const path = parseGitLabProjectPath(options.repo);
    if (path === null) throw new Error(`Invalid GitLab project path: ${gitlabProjectPathForDiagnostics(options.repo)}`);
    this.repo = path;
    this.prNumber = options.prNumber;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    // The credential rides ONLY in the PRIVATE-TOKEN header of requests whose
    // origin `requestText` already validated against this adapter's base.
    this.fetchImpl = gitlabFetch(options.token, options.fetchImpl ?? fetch);
  }

  private apiPath(path: string): string {
    return `${this.baseUrl}/api/v4${path}`;
  }

  /** A project-scoped /api/v4 URL, refused (throws) when the project path is
   * invalid or the normalized path escapes the intended prefix. */
  private projectUrl(staticTail: string, dynamicTail = ""): string {
    const url = gitlabProjectScopedUrl(this.apiPath(""), this.repo, staticTail, dynamicTail);
    if (url === null) throw new Error(`Refusing a request outside project ${gitlabProjectPathForDiagnostics(this.repo)}`);
    return url;
  }

  /** A `/projects/{numericId}` URL for a project id read (fork provenance).
   * Only a positive safe integer reaches the URL; the origin is re-checked
   * after normalization because this route is built from payload data. */
  private projectByIdUrl(id: number): string {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error("Refusing a project read with an unusable project id");
    }
    const url = new URL(`${this.apiPath("")}/projects/${id}`);
    if (url.origin !== this.origin) throw new Error("Refusing a project read outside the validated platform base");
    return url.toString();
  }

  private options(accept?: string, timeoutMs?: number): Parameters<typeof requestJson>[1] {
    return {
      // GitLab never uses the Authorization header here: the credential is
      // the PRIVATE-TOKEN header the constructor's fetch wrapper attaches.
      token: undefined,
      accept,
      timeoutMs: timeoutMs ?? this.timeoutMs,
      fetchImpl: this.fetchImpl,
      allowedOrigin: this.origin,
    };
  }

  /** One read; every failure maps onto the {@link ReadResult} error channel
   * — the caller never sees a fake value. */
  private async read<T>(body: () => Promise<T>): Promise<ReadResult<T>> {
    try {
      return { ok: true, data: await body() };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  /** `GET /projects/:id/merge_requests/:iid` plus fork-path resolution,
   * projected onto the GitHub-PR shape. The source project path is proven by
   * `source_project_id === target_project_id` (internal MR → the target
   * path) or one `GET /projects/{source_project_id}` read of
   * `path_with_namespace` (fork); an MR payload that cannot answer the
   * question (missing/non-integer ids, a failed or unusable source-project
   * read) FAILS the read (#1341 cause `invalid-payload`/transport kind)
   * rather than guessing the fork picture. */
  async getPr(): Promise<unknown | null> {
    this.lastPrReadFailure = null;
    try {
      const { status, data } = await requestJson(this.projectUrl("/merge_requests/", this.prNumber), await this.options());
      if (status !== 200) {
        this.lastPrReadFailure = new PlatformRequestError(`MR read failed with HTTP status ${status}`, status, "http-status");
        return null;
      }
      if (!isObject(data)) {
        this.lastPrReadFailure = new PlatformRequestError("MR read returned an unusable payload", null, "invalid-payload");
        return null;
      }
      const sourceProjectId = gitlabNumericId(data.source_project_id);
      const targetProjectId = gitlabNumericId(data.target_project_id);
      if (sourceProjectId === null || targetProjectId === null) {
        this.lastPrReadFailure = new PlatformRequestError(
          "MR read carried no usable source/target project ids", null, "invalid-payload",
        );
        return null;
      }
      let sourceProjectPath: string;
      if (sourceProjectId === targetProjectId) {
        sourceProjectPath = this.repo;
      } else {
        const source = await requestJson(this.projectByIdUrl(sourceProjectId), await this.options());
        if (source.status !== 200) {
          this.lastPrReadFailure = new PlatformRequestError(
            `Source project read failed with HTTP status ${source.status}`, source.status, "http-status",
          );
          return null;
        }
        const path = isObject(source.data) && typeof source.data.path_with_namespace === "string"
          ? parseGitLabProjectPath(source.data.path_with_namespace)
          : null;
        if (path === null) {
          this.lastPrReadFailure = new PlatformRequestError(
            "Source project read carried no usable path_with_namespace", null, "invalid-payload",
          );
          return null;
        }
        sourceProjectPath = path;
      }
      const pr = prToGitlabPrShape(data, this.repo, sourceProjectPath);
      if (pr === null) {
        this.lastPrReadFailure = new PlatformRequestError("MR read returned an unusable payload", null, "invalid-payload");
        return null;
      }
      return pr;
    } catch (error) {
      const cause = error instanceof PlatformRequestError ? error : null;
      this.lastPrReadFailure = new PlatformRequestError(
        `MR read failed (${cause?.kind ?? "request-failed"})`,
        cause?.status ?? null,
        cause?.kind ?? "request-failed",
      );
      return null;
    }
  }

  /** #1341: the cause of the most recent `getPr()` failure, or null. */
  prReadFailure(): PlatformRequestError | null {
    return this.lastPrReadFailure;
  }

  /** The MR diff as unified-diff text: `GET /merge_requests/:iid/diffs`
   * pages (100 diffs each, ≤ 10 pages), each row's `diff` concatenated in
   * order. `too_large: true` rows carry no patch text and simply contribute
   * nothing (GitLab's own truncation, reported in the file list via
   * `listPrFiles`). A failed read returns ""; a body-cap overflow rethrows
   * (#1131: a capped read must not degrade into an empty diff). */
  async getPrDiff(): Promise<string> {
    try {
      const chunks: string[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const { status, data } = await requestJson(
          this.projectUrl("/merge_requests/", `${this.prNumber}/diffs?per_page=${GITLAB_LIST_PAGE_SIZE}&page=${page}`),
          await this.options(),
        );
        if (status !== 200) return "";
        if (!isObject(data) || !Array.isArray(data.diffs)) return "";
        for (const row of data.diffs) {
          if (isObject(row) && typeof row.diff === "string") chunks.push(row.diff);
        }
        const pagination = isObject(data.pagination) ? data.pagination : null;
        const nextPage = pagination === null ? null : pagination.next_page;
        // A malformed `next_page` (not number, not null) fails the read; a
        // present null ends it cleanly. (Anything else, including a missing
        // key, is caught by the first check, so no `undefined` arm is needed.)
        if (typeof nextPage !== "number" && nextPage !== null) return "";
        if (nextPage === null) break;
      }
      return chunks.join("");
    } catch (error) {
      if (error instanceof PlatformRequestError && error.kind === "too-large") throw error;
      return "";
    }
  }

  /** MR notes (comments), system notes excluded, oldest-first, pages of 100
   * with a hard page cap; a failed page ends the listing with what was
   * collected (the Forgejo listIssueComments posture). */
  async listIssueComments(): Promise<ManagedComment[]> {
    const all: ManagedComment[] = [];
    let page = 1;
    for (;;) {
      let status = 0;
      let notes: unknown = null;
      try {
        const result = await requestJson(
          this.projectUrl("/merge_requests/", `${this.prNumber}/notes?sort=asc&per_page=${GITLAB_LIST_PAGE_SIZE}&page=${page}`),
          await this.options(),
        );
        status = result.status;
        notes = result.data;
      } catch {
        break;
      }
      if (status !== 200 || !Array.isArray(notes) || notes.length === 0) break;
      for (const note of notes) {
        if (!isObject(note) || note.system === true) continue;
        const author = isObject(note.author) ? note.author : {};
        all.push({
          id: typeof note.id === "number" || typeof note.id === "string" ? note.id : undefined,
          body: typeof note.body === "string" ? note.body : "",
          created_at: typeof note.created_at === "string" ? note.created_at : undefined,
          updated_at: typeof note.updated_at === "string" ? note.updated_at : undefined,
          author: gitlabUserLogin(author),
          authorId: gitlabNumericId(author.id) ?? undefined,
        });
      }
      if (notes.length < GITLAB_LIST_PAGE_SIZE) break;
      page += 1;
      if (page > GITLAB_LIST_MAX_PAGES) break;
    }
    return all;
  }

  /** `GET /merge_requests/:iid/reviews` → ManagedReview rows. GitLab reviews
   * carry no comment body (the verdict record is `state` + reviewer); the
   * body is reported as "". A failed read is `[]` like Forgejo's. */
  async listPrReviews(): Promise<ManagedReview[]> {
    let data: unknown = null;
    let status = 0;
    try {
      const result = await requestJson(this.projectUrl("/merge_requests/", `${this.prNumber}/reviews`), await this.options());
      status = result.status;
      data = result.data;
    } catch {
      return [];
    }
    if (status !== 200 || !Array.isArray(data)) return [];
    return data
      .filter(isObject)
      .map((review) => ({
        body: typeof review.body === "string" ? review.body : "",
        submitted_at: typeof review.created_at === "string" ? review.created_at : undefined,
        author: gitlabUserLogin(review.reviewer),
        authorId: gitlabNumericId(isObject(review.reviewer) ? review.reviewer.id : undefined) ?? undefined,
      }));
  }

  /** The `GET /api/v4/user` read shared by the identity and permission
   * lookups; a transport failure never throws (callers fold it into their
   * fail-closed contracts). */
  private async fetchAuthenticatedUser(): Promise<{ status: number; data: unknown }> {
    try {
      const { status, data } = await requestJson(this.apiPath("/user"), await this.options("application/json"));
      return { status, data };
    } catch (error) {
      if (error instanceof PlatformRequestError && error.status !== null) return { status: error.status, data: null };
      return { status: 0, data: null };
    }
  }

  /** The login this token posts as (`GET /user` → `username`). Any failure is
   * null and the precheck fails closed (#970). */
  async authenticatedIdentity(): Promise<string | null> {
    const { status, data } = await this.fetchAuthenticatedUser();
    return status === 200 ? gitlabUserLogin(data) ?? null : null;
  }

  /** Effective repository permission of the active token:
   * `GET /user` → id, then `GET /projects/:id/members/all/{user_id}` →
   * `access_level` mapped by {@link gitlabPermissionFromAccessLevel}. A 404
   * on the membership read is the forge's answer "not a member" → "none"; a
   * failed `/user` read or a transport failure is null; a 200 membership
   * payload without a usable access_level is "unknown". */
  async repoPermission(): Promise<string | null> {
    const user = await this.fetchAuthenticatedUser();
    const userId = user.status === 200 && isObject(user.data) ? gitlabNumericId(user.data.id) : null;
    if (userId === null) return user.status === 200 ? "unknown" : null;
    try {
      const { status, data } = await requestJson(
        this.projectUrl("/members/all/", String(userId)),
        await this.options(),
      );
      if (status === 404) return "none";
      if (status !== 200) return null;
      const permission = isObject(data)
        ? gitlabPermissionFromAccessLevel(data.access_level)
        : null;
      return permission ?? "unknown";
    } catch (error) {
      if (error instanceof PlatformRequestError && error.status === 404) return "none";
      return null;
    }
  }

  /** Changed-file list: `GET /merge_requests/:iid/files` (GitLab reports the
   * patch under `diff`, the paths under `new_path`/`old_path`, and the
   * add/rename/delete flags as booleans — there is no `additions`/
   * `deletions` count on this endpoint), normalized onto the GitHub shape
   * {@link normalizeForgejoPrFiles} produces. A failed read is `[]`. */
  listPrFiles(): Promise<ReadResult<unknown>> {
    return this.read(async () => {
      const files: unknown[] = [];
      for (let page = 1; page <= GITLAB_LIST_MAX_PAGES; page += 1) {
        const { status, data } = await requestJson(
          this.projectUrl("/merge_requests/", `${this.prNumber}/files?per_page=${GITLAB_LIST_PAGE_SIZE}&page=${page}`),
          await this.options(),
        );
        if (status !== 200 || !Array.isArray(data)) return normalizeForgejoPrFiles(files);
        for (const row of data) {
          if (!isObject(row)) continue;
          const newPath = typeof row.new_path === "string" ? row.new_path : "";
          const oldPath = typeof row.old_path === "string" ? row.old_path : "";
          files.push({
            filename: newPath !== "" ? newPath : oldPath,
            status: row.new_file === true ? "added"
              : row.deleted_file === true ? "removed"
                : row.renamed_file === true ? "renamed" : "modified",
            additions: typeof row.additions === "number" ? row.additions : 0,
            deletions: typeof row.deletions === "number" ? row.deletions : 0,
            changes: (typeof row.additions === "number" ? row.additions : 0) + (typeof row.deletions === "number" ? row.deletions : 0),
            patch: typeof row.diff === "string" ? row.diff : "",
            previous_filename: row.renamed_file === true && oldPath !== "" ? oldPath : null,
          });
        }
        if (data.length < GITLAB_LIST_PAGE_SIZE) break;
      }
      return normalizeForgejoPrFiles(files);
    });
  }

  /** A linked issue on this GitLab instance:
   * `GET /projects/{enc-path}/issues/{n}`. The repo argument may be a nested
   * path; an invalid path or number fails the read. A failed HTTP read
   * reports `null` payload (the Forgejo `fetch_issue` parity quirk: the
   * lookup answered, with nothing). */
  async getIssue(repo: string, issueNumber: string): Promise<ReadResult<unknown>> {
    if (!NUMBER_RE.test(issueNumber)) return { ok: false, error: "invalid issue reference" };
    const url = gitlabProjectScopedUrl(this.apiPath(""), repo, "/issues/", issueNumber);
    if (url === null) return { ok: false, error: `Invalid GitLab project path: ${gitlabProjectPathForDiagnostics(repo)}` };
    return this.read(async () => {
      const { status, data } = await requestJson(url, await this.options());
      return status === 200 ? data : null;
    });
  }

  /** Conversation comments: MR notes (system notes excluded) mapped to the
   * seam's `{id,user,created_at,updated_at,body}` standard and normalized
   * through the shared newest-first 100-cap snapshot. A FAILED page fails the
   * whole read (the follow-up Q&A budget reads this thread as its durable
   * ledger; a partial ledger presented as complete would silently widen the
   * budget — same doctrine as Forgejo's `listPrConversationComments`). */
  listPrConversationComments(): Promise<ReadResult<unknown[]>> {
    return this.read(async () => {
      const all: unknown[] = [];
      for (let page = 1; page <= GITLAB_LIST_MAX_PAGES; page += 1) {
        const { status, data } = await requestJson(
          this.projectUrl("/merge_requests/", `${this.prNumber}/notes?sort=asc&per_page=${GITLAB_LIST_PAGE_SIZE}&page=${page}`),
          await this.options(),
        );
        if (status !== 200) throw new Error(`gitlab note page ${page} failed with status ${status}`);
        if (!Array.isArray(data)) throw new Error(`gitlab note page ${page} returned a non-list body`);
        const notes = data.filter((note) => !(isObject(note) && note.system === true));
        all.push(...notes.map((note) => (isObject(note)
          ? {
            id: note.id ?? 0,
            body: note.body ?? "",
            created_at: note.created_at ?? "",
            updated_at: note.updated_at ?? "",
            user: { login: gitlabUserLogin(note.author) ?? "" },
          }
          : note)));
        if (data.length < GITLAB_LIST_PAGE_SIZE) break;
      }
      return normalizeForgejoConversationComments(all);
    });
  }

  /** Inline review threads: MR discussions whose notes carry a code `position`
   * (GitLab's inline-comment marker). Each such discussion projects to
   * `{threadId, resolved, firstCommentId}` (the `ReviewThreadState` shape the
   * publish seam correlates by `firstCommentId`); `resolved` honors the
   * discussion's own `resolved` flag. Completeness follows the interface's
   * contract: more than the 100-thread window, a failed page, or the page cap
   * exhausted leaves the listing declared incomplete — a thread missing from
   * an incomplete listing is not proven absent. */
  listReviewThreads(): Promise<ReadResult<unknown[]>> {
    return (async () => {
      const threads: Array<{ threadId: string; resolved: boolean; firstCommentId: string }> = [];
      let complete = true;
      try {
        for (let page = 1; page <= GITLAB_LIST_MAX_PAGES; page += 1) {
          const { status, data } = await requestJson(
            this.projectUrl("/merge_requests/", `${this.prNumber}/discussions?per_page=${GITLAB_LIST_PAGE_SIZE}&page=${page}`),
            await this.options(),
          );
          if (status !== 200 || !Array.isArray(data)) {
            complete = false;
            break;
          }
          for (const discussion of data) {
            if (!isObject(discussion) || !Array.isArray(discussion.notes)) continue;
            const positioned = discussion.notes.filter((note) => isObject(note) && isObject(note.position));
            if (positioned.length === 0) continue;
            if (threads.length >= GITLAB_SNAPSHOT_CAP) {
              // The window is full and the listing continues: presence beyond
              // the cap is unprovable, so completeness is declared false.
              complete = false;
              break;
            }
            const firstNote = positioned[0];
            threads.push({
              threadId: String(discussion.id ?? ""),
              resolved: discussion.resolved === true,
              firstCommentId: isObject(firstNote) && firstNote.id !== undefined ? String(firstNote.id) : "",
            });
          }
          if (!complete) break;
          if (data.length < GITLAB_LIST_PAGE_SIZE) break;
          if (page === GITLAB_LIST_MAX_PAGES) complete = false;
        }
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
      return complete
        ? { ok: true as const, data: threads }
        : { ok: true as const, data: threads, complete: false as const };
    })();
  }

  /** Every review (GitLab serves the review list in one response; the v2
   * `paginate` argument does not change the request). A failed read is `[]`,
   * mirroring {@link listPrReviews}. */
  listPrReviewsPaginated(): Promise<ReadResult<unknown[]>> {
    return this.read(async () => await this.listPrReviews());
  }

  /** `platform_external_checks` on GitLab: there are no Actions check runs,
   * so the commit-status listing carries the CI signal
   * (`GET /repository/commits/:sha/statuses`, 100 per page). `state` is the
   * collapsed gate state via {@link gitlabStatusState}; the raw GitLab state
   * is preserved as `conclusion`. This context's own status is excluded the
   * same way the shared normalizer excludes it. A failed read is `[]` (the
   * v2 fold; `transientAsUnknown` maps transport/5xx failures to null like
   * the Forgejo strict mode). */
  async externalChecks(sha: string, options: ExternalChecksOptions = {}): Promise<ExternalCheck[] | null> {
    if (!SHA_RE.test(sha)) return null;
    const context = options.statusContext?.trim() ?? "";
    const checks: ExternalCheck[] = [];
    let transient = false;
    for (let page = 1; page <= 10; page += 1) {
      let status = 0;
      let data: unknown = null;
      try {
        const result = await requestJson(
          this.projectUrl("/repository/commits/", `${encodeURIComponent(sha)}/statuses?per_page=${GITLAB_LIST_PAGE_SIZE}&page=${page}`),
          await this.options(),
        );
        status = result.status;
        data = result.data;
      } catch {
        transient = true;
        break;
      }
      if (status === 429 || status >= 500) {
        transient = true;
        break;
      }
      if (status !== 200 || !Array.isArray(data)) break;
      for (const row of data) {
        if (!isObject(row)) continue;
        const name = typeof row.name === "string" && row.name !== ""
          ? row.name
          : typeof row.context === "string" && row.context !== "" ? row.context : "(status)";
        if (context !== "" && name === context) continue;
        const collapsed = gitlabStatusState(row.status ?? row.state);
        checks.push({ name, ...collapsed });
      }
      if (data.length < GITLAB_LIST_PAGE_SIZE) break;
    }
    if (options.transientAsUnknown === true && transient && checks.length === 0) return null;
    return checks;
  }

  /** The GitHub-shaped-path read seam. GitLab's REST surface is NOT a URL
   * dialect of GitHub's (`/repos/.../pulls/...`), and a half-ported
   * translation table is exactly the kind of uncertain mapping this seam must
   * not guess, so every endpoint is refused with the same
   * "Endpoint not supported" policy rejection Forgejo uses for unmapped
   * paths. Callers degrade explicitly; nothing throws. (Porting a
   * GitHub-path → GitLab-path table for the native tool loop is a follow-up
   * outside #740's read/publish objective.) */
  async ghApi(endpoint: string): Promise<GhApiResult> {
    return { error: `Endpoint not supported on PLATFORM=gitlab: ${endpoint}` };
  }

  /** Page cap of this adapter's list reads (exported for tests and the
   * completeness reasoning of callers). */
  static get listPageCap(): number {
    return GITLAB_LIST_MAX_PAGES;
  }
}
