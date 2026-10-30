import { ciAttemptTimeoutMs, isTransientCiRead } from "./bounded.js";
import { ForgejoEnrichClient } from "./enrich.js";
import { canonicalUserId, integrationOwnerIdFromAudience, type IdentityResolution } from "./owner-identity.js";
import { PlatformRequestError, requestJson, requestText, type FetchLike } from "./http.js";
import {
  forgejoReviewCommentId,
  groupForgejoReviewThreads,
  forgejoSelfStatusMatches,
  forgejoJobStatusPathsMatch,
  forgejoStatusTargetsJob,
  normalizeForgejoRunJobs,
  normalizeExternalChecks,
  normalizeForgejoCommitStatus,
  normalizeForgejoConversationComments,
  normalizeForgejoIssue,
  normalizeForgejoPrFiles,
  normalizeForgejoReviews,
  pyJsonDecode,
  type ForgejoRunJobsNormalization,
  type ExternalCheck,
} from "./normalize.js";
import { parseRepoRef, repoScopedUrl } from "./repo-ref.js";
import { parsePlatformBaseUrl } from "./urls.js";
import { validateEndpoint, type EndpointValidation } from "./endpoint.js";
import type {
  ExternalChecksOptions,
  GhApiResult,
  ManagedComment,
  ManagedReview,
  PlatformReadAdapter,
  ReadResult,
} from "./types.js";

/** Forgejo has no check-runs API: the v2 seam substitutes this empty
 * struct, and the commit-status read carries the CI signal. */
const FORGEJO_EMPTY_CHECK_RUNS = '{"check_runs":[],"total_count":0}';
const NUMBER_RE = /^[0-9]+$/;
const SHA_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
const FORGEJO_RUN_JOBS_PAGE_SIZE = 50;
const JWT_TTL_SECONDS = 2700;

export interface ForgejoAdapterOptions {
  repo: string;
  prNumber: string;
  /** FORGEJO_API_URL — validated before any credential is attached. */
  baseUrl: string;
  /** Resolved token; the runner token is only a fallback in token mode. */
  token?: string | undefined;
  /** "token" (default) or "authorized_integration" (#254 lineage). */
  authMethod?: string | undefined;
  /** Audience for the authorized-integration OIDC JWT exchange. */
  authorizedIntegrationAudience?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: FetchLike | undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** #970: the forge-reported author login of a Forgejo comment/review `user`
 * object. Never reads body content; a missing or non-string login is
 * `undefined` (unproven ownership, which callers fail closed on). */
function forgejoAuthor(user: unknown): string | undefined {
  if (!isObject(user)) return undefined;
  const login = user.login;
  return typeof login === "string" && login !== "" ? login : undefined;
}

/** #1093: the forge-reported author user id of a Forgejo comment/review
 * `user` object, in its canonical positive-integer string form. Never reads
 * body content; unusable ids are `undefined` (unproven ownership). */
function forgejoAuthorId(user: unknown): string | undefined {
  if (!isObject(user)) return undefined;
  return canonicalUserId(user.id) ?? undefined;
}

function parseRepo(repo: string): { owner: string; repo: string } {
  const ref = parseRepoRef(repo);
  if (ref === null) throw new Error(`Invalid repo full name: ${repo}`);
  return { owner: ref.owner, repo: ref.name };
}

/**
 * Forgejo REST adapter used by the precheck/fingerprint path (#674).
 *
 * The base URL is parsed and validated before any credential is attached
 * (http/https only, no embedded credentials — the #670/#682 SSRF boundary).
 * Every request is bound to that validated origin and redirects are refused,
 * so the token can never leak to an attacker-controlled host. The
 * User-Agent must stay non-default: Cloudflare bot-fight fronting
 * self-hosted Forgejo blocks the default fetch UA.
 */
export class ForgejoAdapter implements PlatformReadAdapter {
  readonly platform = "forgejo" as const;
  readonly repo: string;
  readonly prNumber: string;
  private readonly baseUrl: string;
  private readonly origin: string;
  private readonly token: string | undefined;
  private readonly authMethod: string;
  private readonly audience: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private jwtCache: { token: string; fetchedAt: number } | null = null;
  /** #1341: the cause of the most recent `getPr()` failure, or null. */
  private lastPrReadFailure: PlatformRequestError | null = null;

  constructor(options: ForgejoAdapterOptions) {
    const parsed = parsePlatformBaseUrl(options.baseUrl, "Forgejo API base URL");
    this.baseUrl = parsed.base;
    this.origin = parsed.origin;
    this.repo = options.repo;
    this.prNumber = options.prNumber;
    this.token = options.token;
    this.authMethod = options.authMethod ?? "";
    this.audience = options.authorizedIntegrationAudience ?? "";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private apiPath(path: string): string {
    return `${this.baseUrl}/api/v1${path}`;
  }

  /** A repo-scoped /api/v1 URL, refused (throws) when the repo ref is
   * invalid or the normalized path escapes the intended prefix. */
  private repoUrl(staticTail: string, dynamicTail = "", repo = this.repo): string {
    const url = repoScopedUrl(this.apiPath(""), repo, staticTail, dynamicTail);
    if (url === null) throw new Error(`Refusing a request outside repository ${repo}`);
    return url;
  }

  private isAuthorizedIntegrationMode(): boolean {
    // Audience-only direct callers used OIDC before authMethod was wired
    // through. An explicit method governs when both settings are supplied.
    const method = this.authMethod.trim().toLowerCase();
    return method === "authorized_integration" || (method === "" && this.audience.trim() !== "");
  }

  /** Share the adapter's OIDC exchange with Forgejo write operations. */
  async authorizationHeaderForRequest(): Promise<string | undefined> {
    return this.authorizationHeader();
  }

  /** Surface exchange and Forgejo authorization failures before reads can fold them into empty data. */
  async preflightAuthentication(): Promise<void> {
    if (!this.isAuthorizedIntegrationMode()) return;
    const { status } = await requestText(
      this.repoUrl("/pulls/", this.prNumber),
      await this.options("application/json"),
    );
    if (status !== 200) {
      throw new PlatformRequestError(
        `Forgejo authorized-integration credential check failed with status ${status}`,
        status,
        "integration-auth",
      );
    }
  }

  /** The selected method owns authentication even if a caller supplies a token. */
  private async authorizationHeader(): Promise<string | undefined> {
    if (this.isAuthorizedIntegrationMode()) {
      return `Bearer ${await this.getJwt()}`;
    }
    if (!this.token) return undefined;
    return `token ${this.token}`;
  }

  private async options(accept?: string, timeoutMs?: number): Promise<Parameters<typeof requestJson>[1]> {
    return {
      token: await this.authorizationHeader(),
      accept,
      timeoutMs: timeoutMs ?? this.timeoutMs,
      fetchImpl: this.fetchImpl,
      allowedOrigin: this.origin,
    };
  }

  /** Exchange the runner's OIDC identity for a JWT (port of
   * `_fetch_authorized_integration_jwt`), cached for 45 minutes. */
  private async getJwt(): Promise<string> {
    const cached = this.jwtCache;
    if (cached && Date.now() - cached.fetchedAt < JWT_TTL_SECONDS * 1000) return cached.token;
    if (!this.audience.trim()) {
      throw new PlatformRequestError(
        "Authorized-integration mode requires FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE",
        null,
        "missing-audience",
      );
    }
    const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "";
    const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "";
    if (!requestUrl || !requestToken) {
      throw new PlatformRequestError(
        "Authorized-integration mode requires ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN",
        null,
        "missing-oidc-env",
      );
    }
    const { status, text } = await requestText(`${requestUrl}&audience=${encodeURIComponent(this.audience)}`, {
      token: `bearer ${requestToken}`,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      allowedOrigin: new URL(requestUrl).origin,
    });
    if (status !== 200) {
      throw new PlatformRequestError(`OIDC token exchange failed with status ${status}`, status, "oidc");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new PlatformRequestError("OIDC token exchange returned invalid JSON", null, "invalid-json");
    }
    const jwt = isObject(payload) && typeof payload.value === "string" ? payload.value : "";
    if (!jwt) throw new PlatformRequestError("OIDC token exchange returned no token value", null, "oidc");
    this.jwtCache = { token: jwt, fetchedAt: Date.now() };
    return jwt;
  }

  /** Normalize a Forgejo PR payload into the GitHub shape (#254 golden
   * fixtures). head.repo.full_name missing → "" so fork detection fails
   * closed; head.repo is never defaulted to the base repo. */
  private static prToGithubShape(data: unknown, owner: string, repo: string, prNumber: string): unknown {
    if (!isObject(data)) return null;
    const head = isObject(data.head) ? data.head : {};
    const base = isObject(data.base) ? data.base : {};
    const branchRepoFullName = (branch: Record<string, unknown>): string => {
      const branchRepo = isObject(branch.repo) ? branch.repo : {};
      return typeof branchRepo.full_name === "string" ? branchRepo.full_name : "";
    };
    return {
      number: data.number ?? prNumber,
      title: data.title ?? "",
      body: data.body ?? "",
      // #1301/#1307: a partial Forgejo read is NOT evidence that the PR is
      // open. The state is carried through verbatim — only an explicit
      // string is authoritative — so the shared admission gate fails closed
      // on an unprovable one (`pr-state-unknown`) instead of receiving a
      // fabricated "open".
      state: data.state,
      user: { login: isObject(data.user) ? data.user.login ?? "" : "" },
      head: {
        sha: head.sha ?? "",
        ref: head.ref ?? "",
        repo: { full_name: branchRepoFullName(head) },
      },
      base: {
        sha: base.sha ?? "",
        ref: base.ref ?? "",
        repo: { full_name: branchRepoFullName(base) || `${owner}/${repo}` },
      },
      merged_at: data.merged_at ?? null,
      created_at: data.created_at ?? "",
      updated_at: data.updated_at ?? "",
      url: data.html_url ?? "",
      // #961: only an explicit boolean draft is authoritative — the same
      // "reviewability must be proven" doctrine the state gate applies, so a
      // missing draft is carried through as unknown (the #961 gate fails it
      // closed as `pr-draft-unknown`, #1312) rather than defaulted to
      // "not-draft".
      draft: data.draft,
      labels: Array.isArray(data.labels)
        ? data.labels.map((label: unknown) => ({ name: isObject(label) ? label.name ?? "" : "" }))
        : [],
    };
  }

  async getPr(): Promise<unknown | null> {
    this.lastPrReadFailure = null;
    const { owner, repo } = parseRepo(this.repo);
    try {
      const { status, data } = await requestJson(
        this.repoUrl("/pulls/", this.prNumber),
        (await this.options()),
      );
      if (status !== 200) {
        // #1341: a non-2xx response IS an answer — keep its status as the
        // cause class (credential- and body-free by construction).
        this.lastPrReadFailure = new PlatformRequestError(`PR read failed with HTTP status ${status}`, status, "http-status");
        return null;
      }
      return ForgejoAdapter.prToGithubShape(data, owner, repo, this.prNumber);
    } catch (error) {
      // #1341: no usable response arrived — keep the seam's transport kind
      // (`transport`, `redirect-blocked`, `too-large`, `origin-mismatch`,
      // `invalid-json`) as the cause class.
      this.lastPrReadFailure = error instanceof PlatformRequestError
        ? error
        : new PlatformRequestError("PR read failed", null, "transport");
      return null;
    }
  }

  /** #1341: the cause of the most recent `getPr()` failure, or null. */
  prReadFailure(): PlatformRequestError | null {
    return this.lastPrReadFailure;
  }

  async getPrDiff(): Promise<string> {
    parseRepo(this.repo);
    try {
      const { status, text } = await requestText(
        this.repoUrl("/pulls/", `${this.prNumber}.diff`),
        (await this.options("application/json")),
      );
      return status === 200 ? text : "";
    } catch (error) {
      // #1131: a capped read must not degrade into an empty diff — an
      // empty-diff fingerprint would silently skip every later push.
      if (error instanceof PlatformRequestError && error.kind === "too-large") throw error;
      return "";
    }
  }

  async listIssueComments(): Promise<ManagedComment[]> {
    parseRepo(this.repo);
    const allComments: ManagedComment[] = [];
    let page = 1;
    for (;;) {
      let status = 0;
      let comments: unknown = null;
      try {
        const result = await requestJson(
          this.repoUrl("/issues/", `${this.prNumber}/comments?page=${page}&limit=50`),
          (await this.options()),
        );
        status = result.status;
        comments = result.data;
      } catch {
        break;
      }
      if (status !== 200 || !Array.isArray(comments) || comments.length === 0) break;
      for (const comment of comments) {
        if (!isObject(comment)) continue;
        allComments.push({
          id: typeof comment.id === "number" || typeof comment.id === "string" ? comment.id : undefined,
          body: typeof comment.body === "string" ? comment.body : "",
          created_at: typeof comment.created_at === "string" ? comment.created_at : typeof comment.created_on === "string" ? comment.created_on : undefined,
          updated_at: typeof comment.updated_at === "string" ? comment.updated_at : typeof comment.updated_on === "string" ? comment.updated_on : undefined,
          author: forgejoAuthor(comment.user),
          authorId: forgejoAuthorId(comment.user),
        });
      }
      if (comments.length < 50) break;
      page += 1;
    }
    return allComments;
  }

  async listPrReviews(): Promise<ManagedReview[]> {
    parseRepo(this.repo);
    let data: unknown = null;
    let status = 0;
    try {
      const result = await requestJson(this.repoUrl("/pulls/", `${this.prNumber}/reviews`), (await this.options()));
      status = result.status;
      data = result.data;
    } catch {
      return [];
    }
    if (status !== 200 || !Array.isArray(data)) return [];
    return data
      .filter(isObject)
      .map((review) => ({
        id: review.id,
        body: typeof review.body === "string" ? review.body : "",
        submitted_at:
          typeof review.submitted_at === "string" ? review.submitted_at : typeof review.updated_at === "string" ? review.updated_at : undefined,
        author: forgejoAuthor(review.user),
        authorId: forgejoAuthorId(review.user),
      }));
  }

  /** One `GET /api/v1/user` read shared by `authenticatedIdentity()` and
   * `resolveTrustedOwner()` (#1093): `{status, data, transportFailed}` —
   * a transport/auth failure never throws (the callers fold it into their
   * own fail-closed contracts). A failed response that still carries an HTTP
   * status (an HTML 401/403/other error page behind a proxy, or a 200 whose
   * body is unparseable) keeps that status and reports no payload, so the
   * diagnostics can tell a status-rejected `/user` from a 200 with an
   * unusable payload and from a transport that never answered. */
  private async fetchAuthenticatedUser(): Promise<{ status: number; data: unknown; transportFailed: boolean }> {
    try {
      const { status, data } = await requestJson(this.apiPath("/user"), await this.options("application/json"));
      return { status, data, transportFailed: false };
    } catch (error) {
      if (error instanceof PlatformRequestError && error.status !== null) {
        return { status: error.status, data: null, transportFailed: false };
      }
      return { status: 0, data: null, transportFailed: true };
    }
  }

  /** The usable login of a `/user` payload, or null (payload not usable). */
  private static loginFromUserPayload(data: unknown): string | null {
    if (!isObject(data)) return null;
    const login = data.login;
    return typeof login === "string" && login.trim() !== "" ? login : null;
  }

  /** #970: resolve the login this token posts as (`GET /user`). The
   * authorized-integration mode's OIDC JWT may not resolve to a user there;
   * any failure is `null` and the precheck fails closed rather than trusting
   * an unauthenticated marker. */
  async authenticatedIdentity(): Promise<string | null> {
    const { status, data } = await this.fetchAuthenticatedUser();
    // A non-200 body is an error payload, never an identity (the pre-#1093
    // contract): only a 200 payload may prove a login.
    return status === 200 ? ForgejoAdapter.loginFromUserPayload(data) : null;
  }

   /** #1093: the trusted owner identity for skip/carry-forward and cleanup
    * ownership, with a bounded diagnostics reason. `GET /user` proves a
    * login when it can; in Authorized Integration mode a repo-scoped JWT
    * typically lacks the `/user` scope (401/403) or cannot reach it at all,
    * so whenever `/user` cannot prove a login the audience's owner id — the
    * same proof sticky-comment ownership already trusts — is the fallback
    * proof. The audience check runs only as that fallback: with an
    * unparseable audience the run falls through to the reaction self-write
    * probe below. Every failure mode leaves the identity null (fail
    * closed). When a fallback cannot prove an identity either, the `/user`
    * stage's bounded reason is retained alongside the fallback's (composed
    * with `-and-`), so an operator can tell whether `/user` was
    * transport-unreachable, status-rejected, or returned an unusable
    * payload instead of only seeing the final stage's failure. */
  async resolveTrustedOwner(): Promise<IdentityResolution> {
    const user = await this.fetchAuthenticatedUser();
    let userStageReason: string;
    if (user.transportFailed) {
      userStageReason = "user-transport";
    } else if (user.status === 200) {
      const login = ForgejoAdapter.loginFromUserPayload(user.data);
      if (login !== null) return { identity: { kind: "login", login }, reason: "user-login" };
      userStageReason = "user-payload";
    } else {
      userStageReason = `user-http-${user.status}`;
    }
    if (this.isAuthorizedIntegrationMode()) {
      const userId = integrationOwnerIdFromAudience(this.audience);
      if (userId !== null) return { identity: { kind: "userId", userId }, reason: "integration-user-id" };
    }
    // Last fallback for every mode: a repo-scoped token (write:repository +
    // write:issue, no read:user) cannot read `/user` at all, so the doer is
    // proven by a reaction self-write on this PR's issue instead. An
    // identity already proven above (a login from `/user`, or the
    // integration audience) never reaches the probe.
    const probe = await this.reactionSelfAttestation();
    if (probe.identity !== null) return probe;
    return { identity: null, reason: `${userStageReason}-and-${probe.reason}` };
  }

  /** #1093: final identity proof — a transient reaction self-write on this
   * PR's issue. The POST response's `user.id` attests the authenticated
   * DOER (only an account with issue-write on this repository can create
   * the reaction), so a repo-scoped PAT can prove its identity without the
   * `read:user` scope. Both 201 (this run created the reaction) and 200
   * (a `content:"eyes"` reaction already existed — the forge reports the
   * doer of the duplicate POST) attest the server-authenticated doer.
   *
   * PATCH/edit-style responses are deliberately NOT acceptable identity
   * sources: they attest the comment's ORIGINAL poster, not the
   * authenticated doer — a repo-write token PATCHing a spoofed-marker
   * comment must never adopt the spoofer's identity.
   *
   * The DELETE afterwards is best-effort cleanup (exactly one attempt) and
   * runs ONLY for a 201: this run created that reaction, so it must not
   * linger. A 200 means the reaction already existed and belongs to
   * another moment/author — the proof still stands, but this run deletes
   * nothing rather than destroying pre-existing user data. The cleanup's
   * body mirrors the POST's so the forge deletes the doer's `eyes`
   * reaction (an empty-body DELETE binds an empty reaction type and
   * silently removes nothing). The proof is the POST response, so a failed
   * cleanup never invalidates the proven identity — it only emits a single
   * bounded stderr WARN. Diagnostics never carry body, user, network, or
   * token content. */
  private async reactionSelfAttestation(): Promise<IdentityResolution> {
    let url: string;
    try {
      url = this.repoUrl("/issues/", `${this.prNumber}/reactions`);
    } catch {
      return { identity: null, reason: "reaction-transport" };
    }
    let status = 0;
    let data: unknown = null;
    try {
      const result = await requestJson(url, {
        ...(await this.options("application/json")),
        method: "POST",
        body: JSON.stringify({ content: "eyes" }),
      });
      status = result.status;
      data = result.data;
    } catch (error) {
      // A non-JSON error response (e.g. an HTML 403/502 page behind a
      // proxy) still carries its real HTTP status — report it instead of
      // masking it as a transport failure. True transport failures (no
      // response at all) stay reaction-transport.
      if (error instanceof PlatformRequestError && error.status !== null && error.status >= 400) {
        return { identity: null, reason: `reaction-http-${error.status}` };
      }
      return { identity: null, reason: "reaction-transport" };
    }
    if (status !== 200 && status !== 201) return { identity: null, reason: `reaction-http-${status}` };
    const createdHere = status === 201;
    const user = isObject(data) && isObject(data.user) ? data.user : null;
    const userId = user === null ? null : canonicalUserId((user as { id?: unknown }).id);
    if (userId === null) {
      // A 201 payload that cannot prove the doer still gets the best-effort
      // DELETE: this run created that reaction, and an unprovable reaction
      // must not linger on the issue. A 200 payload cannot prove the doer
      // either, but nothing was created — nothing is deleted.
      if (createdHere) await this.deleteProbeReaction(url);
      return { identity: null, reason: "reaction-payload" };
    }
    if (createdHere) await this.deleteProbeReaction(url);
    return { identity: { kind: "userId", userId }, reason: "reaction-self-attested" };
  }

  /** The best-effort probe cleanup: exactly one attempt; the body mirrors
   * the POST's so the forge deletes the doer's `eyes` reaction instead of
   * binding an empty reaction type. Never throws; on non-2xx or transport
   * failure it emits a single bounded stderr WARN (no body/network/token
   * content) and nothing else. */
  private async deleteProbeReaction(url: string): Promise<void> {
    try {
      const deletion = await requestText(url, {
        ...(await this.options("application/json")),
        method: "DELETE",
        body: JSON.stringify({ content: "eyes" }),
      });
      if (deletion.status !== 200 && deletion.status !== 204) {
        process.stderr.write(`[forgejo] WARNING: reaction self-write cleanup failed (status ${deletion.status}); the identity proof stands\n`);
      }
    } catch {
      process.stderr.write("[forgejo] WARNING: reaction self-write cleanup failed; the identity proof stands\n");
    }
  }

  /** `_curl` semantics for a read: `{status, text}`, with a transport
   * failure reported as status 0 (v2: curl's nonzero exit code stands in
   * for the HTTP status, so it is never 200). A credential failure (the
   * authorized-integration JWT exchange) throws: v2's CLI raises there. */
  private async curl(url: string, timeoutMs?: number, preserveRedirectStatus = false): Promise<{ status: number; text: string }> {
    const options = await this.options();
    try {
      const { status, text } = await requestText(url, { ...options, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      return { status, text };
    } catch (error) {
      if (preserveRedirectStatus && error instanceof PlatformRequestError
        && error.kind === "redirect-blocked" && error.status !== null) {
        return { status: error.status, text: "" };
      }
      return { status: 0, text: "" };
    }
  }

  /** Run one read; anything the v2 CLI would raise on fails the read. The
   * body builds every URL through `at`, which refuses (before any request)
   * an invalid repo ref or a path that normalizes outside the repo. */
  private async read<T>(body: (at: (staticTail: string, dynamicTail?: string) => string) => Promise<T>, repo = this.repo): Promise<ReadResult<T>> {
    if (parseRepoRef(repo) === null) return { ok: false, error: `Invalid repo full name: ${repo}` };
    try {
      return { ok: true, data: await body((staticTail, dynamicTail = "") => this.repoUrl(staticTail, dynamicTail, repo)) };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  /** `list_pr_files`: a failed or non-list read is `[]`. */
  listPrFiles(): Promise<ReadResult<unknown>> {
    return this.read(async (at) => {
      const { status, text } = await this.curl(at("/pulls/", `${this.prNumber}/files`));
      return status === 200 ? normalizeForgejoPrFiles(pyJsonDecode(text)) : [];
    });
  }

  /** `fetch_issue`. v2 quirk kept for parity: a failed Forgejo fetch is a
   * SUCCESSFUL read whose payload is `null` (the CLI prints `null` and exits
   * 0), unlike GitHub, where the read fails. */
  async getIssue(repo: string, issueNumber: string): Promise<ReadResult<unknown>> {
    if (!NUMBER_RE.test(issueNumber)) return { ok: false, error: "invalid issue reference" };
    return this.read(async (at) => {
      const { status, text } = await this.curl(at("/issues/", issueNumber));
      return status === 200 ? normalizeForgejoIssue(pyJsonDecode(text)) : null;
    }, repo);
  }

  /** `list_comments` (Forgejo) normalized, then the seam's
   * `sort_by(.created_at // "") | reverse | .[0:100]`. Pages of 50; a short
   * or empty page ends the listing with what was collected. A FAILED page
   * fails the whole read rather than silently truncating: the follow-up
   * Q&A budget reads this thread as its durable ledger, and a partial
   * ledger presented as complete would silently widen the budget. */
  listPrConversationComments(): Promise<ReadResult<unknown[]>> {
    return this.read(async (at) => {
      const all: unknown[] = [];
      for (let page = 1; ; page += 1) {
        const { status, text } = await this.curl(at("/issues/", `${this.prNumber}/comments?page=${page}&limit=50`));
        if (status !== 200) throw new Error(`forgejo comment page ${page} failed with status ${status}`);
        const comments = pyJsonDecode(text);
        if (!Array.isArray(comments) || comments.length === 0) break;
        all.push(...comments);
        if (comments.length < 50) break;
      }
      return normalizeForgejoConversationComments(all);
    });
  }

  /** `list_review_threads`: every review's comments grouped into threads. */
  listReviewThreads(): Promise<ReadResult<unknown[]>> {
    return this.read(async (at) => {
      const { status, text } = await this.curl(at("/pulls/", `${this.prNumber}/reviews`));
      if (status !== 200) return [];
      const reviews = pyJsonDecode(text);
      if (!Array.isArray(reviews)) return [];
      const commentLists: unknown[][] = [];
      for (const review of reviews) {
        const reviewId = forgejoReviewCommentId(review);
        if (reviewId === null) continue;
        const response = await this.curl(at("/pulls/", `${this.prNumber}/reviews/${reviewId}/comments`));
        if (response.status !== 200) continue;
        const comments = pyJsonDecode(response.text);
        if (Array.isArray(comments)) commentLists.push(comments);
      }
      return groupForgejoReviewThreads(commentLists);
    });
  }

  /** `list_pr_reviews` (Forgejo serves every review in one response; the v2
   * `paginate` argument does not change the Forgejo request). */
  listPrReviewsPaginated(): Promise<ReadResult<unknown[]>> {
    return this.read(async (at) => {
      const { status, text } = await this.curl(at("/pulls/", `${this.prNumber}/reviews`));
      return status === 200 ? normalizeForgejoReviews(pyJsonDecode(text)) : [];
    });
  }

  /** `platform_external_checks` on Forgejo: the empty check-runs struct plus
   * the `commit-status` CLI output. v2 quirk kept for parity: a failed
   * status read prints `null`, which folds to `[]` ("no external CI"), not
   * to the empty/transient signal. The status read is bounded like the
   * GitHub CI reads (#663); a timeout or exhausted deadline counts as that
   * same failed read. */
  async externalChecks(sha: string, options: ExternalChecksOptions = {}): Promise<ExternalCheck[] | null> {
    if (options.selfRunNumbers !== undefined && options.selfStatusDiscovery) {
      options.selfStatusDiscovery.found = false;
      options.selfStatusDiscovery.ambiguous = false;
      options.selfStatusDiscovery.matchCount = 0;
      options.selfStatusDiscovery.context = null;
      options.selfStatusDiscovery.runJobs ??= "unknown";
      options.selfStatusDiscovery.runJobCount ??= null;
      options.selfStatusDiscovery.runJobCountExact ??= false;
      options.selfStatusDiscovery.runJobHtmlUrl ??= null;
      options.selfStatusDiscovery.runJobsUnavailableReason ??= null;
    }
    if (!SHA_RE.test(sha)) return null;
    if (options.transientAsUnknown === true) return this.externalChecksStrict(sha, options);
    const status = await this.read(async (at) => {
      const timeoutMs = ciAttemptTimeoutMs(options);
      if (timeoutMs === null) return "null";
      const response = await this.curl(at("/commits/", `${sha}/status`), timeoutMs);
      if (response.status !== 200) return "null";
      const normalized = normalizeForgejoCommitStatus(pyJsonDecode(response.text));
      return normalized === null ? "null" : JSON.stringify(normalized);
    });
    // A raising CLI prints nothing (`|| echo ""`).
    const combinedText = status.ok ? status.data : "";
    if (options.selfRunNumbers === undefined) {
      return normalizeExternalChecks(FORGEJO_EMPTY_CHECK_RUNS, combinedText, options.runId ?? "", options.statusContext ?? "");
    }
    return this.normalizeAutoSelfStatus(combinedText, options);
  }

  /** `externalChecks` under the v3 CI gate's transient-read rule: no
   * response, 429/5xx, or an undecodable 200 body is `null` ("unknown,
   * retry") instead of the v2 `null` → `[]` fold. A non-200 JSON answer (for
   * example a 404) and a malformed-but-decodable payload keep the v2 fold:
   * they are persistent, and retrying cannot change them. */
  private async externalChecksStrict(sha: string, options: ExternalChecksOptions): Promise<ExternalCheck[] | null> {
    const status = await this.read(async (at): Promise<string | null> => {
      const timeoutMs = ciAttemptTimeoutMs(options);
      if (timeoutMs === null) return null;
      const response = await this.curl(at("/commits/", `${sha}/status`), timeoutMs);
      if (isTransientCiRead(response.status, response.status === 200 ? response.text : "null")) return null;
      if (response.status !== 200) return "null";
      const decoded = pyJsonDecode(response.text);
      if (decoded === null) return null;
      return JSON.stringify(normalizeForgejoCommitStatus(decoded));
    });
    if (status.ok && status.data === null) return null;
    const combinedText = status.ok ? status.data ?? "" : "";
    if (options.selfRunNumbers === undefined) {
      return normalizeExternalChecks(FORGEJO_EMPTY_CHECK_RUNS, combinedText, options.runId ?? "", options.statusContext ?? "");
    }
    return this.normalizeAutoSelfStatus(combinedText, options);
  }

  private async readRunJobs(options: ExternalChecksOptions): Promise<ForgejoRunJobsNormalization | null> {
    const runId = options.selfRunId?.trim() ?? "";
    if (!NUMBER_RE.test(runId)) {
      if (options.selfStatusDiscovery) options.selfStatusDiscovery.runJobsUnavailableReason = "run-id environment variable is missing or non-numeric";
      return { state: "unavailable", count: null, exact: false };
    }
    const timeoutMs = ciAttemptTimeoutMs(options);
    if (timeoutMs === null) return null;
    let response: { status: number; text: string };
    try {
      const { owner, repo } = parseRepo(this.repo);
      const url = this.apiPath(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
      response = await this.curl(url, timeoutMs, true);
    } catch {
      if (options.selfStatusDiscovery) options.selfStatusDiscovery.runJobsUnavailableReason = "invalid repository for run-jobs endpoint";
      return { state: "unavailable", count: null, exact: false };
    }

    // Unlike the shared CI-read rule, a jobs lookup treats timeout/early
    // request responses as retryable rather than proof that the endpoint is absent.
    if (response.status === 0 || response.status === 408 || response.status === 425
      || response.status === 429 || response.status >= 500
      || (response.status === 200 && isTransientCiRead(response.status, response.text))) return null;
    if (response.status !== 200) {
      if (options.selfStatusDiscovery) {
        options.selfStatusDiscovery.runJobsUnavailableReason = `run-jobs endpoint returned HTTP ${response.status}`;
      }
      return { state: "unavailable", count: null, exact: false };
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(response.text);
    } catch {
      return null;
    }
    const result = normalizeForgejoRunJobs(decoded, FORGEJO_RUN_JOBS_PAGE_SIZE, runId);
    if (result.state === "unavailable" && options.selfStatusDiscovery) {
      options.selfStatusDiscovery.runJobsUnavailableReason = "run-jobs response could not prove the run's job count";
    }
    return result;
  }

  private async normalizeAutoSelfStatus(combinedText: string, options: ExternalChecksOptions): Promise<ExternalCheck[] | null> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(combinedText.replace(/\n+$/, ""));
    } catch {
      if (options.selfStatusDiscovery) {
        options.selfStatusDiscovery.found = false;
        options.selfStatusDiscovery.ambiguous = false;
        options.selfStatusDiscovery.matchCount = 0;
        options.selfStatusDiscovery.context = null;
      }
      return [];
    }
    const statuses = isObject(decoded) && Array.isArray(decoded.statuses) ? decoded.statuses : [];
    const matches = forgejoSelfStatusMatches(
      statuses,
      options.selfRunNumbers ?? [],
      options.selfRunRepo ?? "",
      options.selfRunOrigin ?? "",
    );
    const matchedStatus = matches.index === null ? null : statuses[matches.index];
    const targetUrl = isObject(matchedStatus) && typeof matchedStatus.target_url === "string" ? matchedStatus.target_url : null;
    const discovery = options.selfStatusDiscovery;
    const ambiguous = matches.count > 1;
    let excludeIndex: number | undefined;

    // Ambiguity in the status payload is conclusive: do not spend a jobs API
    // read or try to hide one of the sibling checks.
    if (!ambiguous && matches.count === 1 && discovery?.runJobs === "unknown") {
      const jobs = await this.readRunJobs(options);
      if (jobs === null) return null;
      discovery.runJobs = jobs.state;
      discovery.runJobCount = jobs.count;
      discovery.runJobCountExact = jobs.state === "single" || jobs.state === "multi" && jobs.exact;
      discovery.runJobHtmlUrl = jobs.state === "single" ? jobs.htmlUrl : null;
    }

    if (discovery) {
      discovery.found = false;
      discovery.ambiguous = ambiguous;
      discovery.matchCount = matches.count;
      discovery.context = matches.context;
      if (!ambiguous && matches.count === 1 && discovery.runJobs === "single"
        && targetUrl !== null
        && (discovery.runJobHtmlUrl === null
          ? forgejoStatusTargetsJob(targetUrl, options.selfRunOrigin ?? "")
          : forgejoJobStatusPathsMatch(discovery.runJobHtmlUrl, targetUrl, options.selfRunOrigin ?? ""))) {
        discovery.found = true;
        excludeIndex = matches.index ?? undefined;
      }
    }

    return normalizeExternalChecks(FORGEJO_EMPTY_CHECK_RUNS, combinedText, options.runId ?? "", options.statusContext ?? "", {
      selfRunNumbers: options.selfRunNumbers,
      selfStatusIndex: excludeIndex,
    });
  }

  /** Linked-source enrichment client whose configured-host credential is
   * this adapter's (token or authorized-integration JWT). */
  enrichClient(): ForgejoEnrichClient {
    return new ForgejoEnrichClient({
      configuredApiUrl: this.baseUrl,
      configuredAuthorization: () => this.authorizationHeader(),
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }

  private static permissionFromRepoPayload(data: unknown): string | null {
    if (!isObject(data)) return null;
    const perms = isObject(data.permissions) ? data.permissions : null;
    if (!perms) return null;
    if (perms.admin === true) return "admin";
    if (perms.write === true || perms.push === true) return "write";
    if (perms.read === true || perms.pull === true) return "read";
    return null;
  }

  /** Effective repository permission for the active token (port of
   * `get_authenticated_repo_permission`): "read"|"write"|"admin" resolved
   * against a recognized Forgejo schema, "unknown" when a 200 payload
   * carries no recognizable permission field, null on transport/auth
   * failure. */
  async repoPermission(): Promise<string | null> {
    parseRepo(this.repo);
    const auth = await this.authorizationHeader();
    const authOptions = { ...(await this.options()), token: auth };
    const permissionFromRepoPayload = ForgejoAdapter.permissionFromRepoPayload;

    if (this.isAuthorizedIntegrationMode()) {
      let status = 0;
      let body: unknown = null;
      try {
        const result = await requestJson(this.repoUrl(""), authOptions);
        status = result.status;
        body = result.data;
      } catch {
        return null;
      }
      const permission = permissionFromRepoPayload(body);
      if (status === 200 && permission !== null) return permission;
      if (status === 200) return "unknown";
      return null;
    }

    let userStatus = 0;
    let user: unknown = null;
    try {
      const result = await requestJson(this.apiPath("/user"), authOptions);
      userStatus = result.status;
      user = result.data;
    } catch {
      return null;
    }
    const login = userStatus === 200 && isObject(user) && typeof user.login === "string" ? user.login : "";
    if (!login) {
      if (userStatus === 200) return "unknown";
      return null;
    }
    let status = 0;
    let data: unknown = null;
    try {
      const result = await requestJson(
        this.repoUrl("/collaborators/", `${encodeURIComponent(login)}/permission`),
        authOptions,
      );
      status = result.status;
      data = result.data;
    } catch {
      return null;
    }
    let permission = status === 200 && isObject(data) && typeof data.permission === "string" ? data.permission : "";
    if (permission === "owner") permission = "admin";
    if (permission === "read" || permission === "write" || permission === "admin") return permission;
    if (status === 404) {
      let fallbackStatus = 0;
      let fallback: unknown = null;
      try {
        const result = await requestJson(this.repoUrl(""), authOptions);
        fallbackStatus = result.status;
        fallback = result.data;
      } catch {
        return null;
      }
      const repoPermission = permissionFromRepoPayload(fallback);
      if (fallbackStatus === 200 && repoPermission !== null) return repoPermission;
      if (fallbackStatus === 200) return "unknown";
      return null;
    }
    if (status === 200) return "unknown";
    return null;
  }

  private validate(endpoint: string): EndpointValidation {
    return validateEndpoint(endpoint, "*", this.repo);
  }

  /** The validated read-only seam, mirroring `pr_reviewer.platform.gh_api`
   * on the Forgejo backend: GitHub-shaped paths translated onto /api/v1,
   * anything unmapped fails closed with "Endpoint not supported". */
  async ghApi(endpoint: string, opts?: { timeoutMs?: number }): Promise<GhApiResult> {
    const validated = this.validate(endpoint);
    if ("error" in validated) return validated;
    const translated = ForgejoAdapter.translate(validated.full_path, validated.repo_key);
    if (!translated) {
      return { error: `Endpoint not supported on PLATFORM=forgejo: ${endpoint}` };
    }
    if (!this.token && !this.isAuthorizedIntegrationMode()) {
      return { error: "Missing FORGEJO_TOKEN" };
    }
    try {
      // `translate` already returns the /api/v1-prefixed path (as v2's
      // `_forgejo_translate` does); join it to the bare base like v2.
      const { status, data } = await requestJson(`${this.baseUrl}${translated}`, (await this.options("application/json", opts?.timeoutMs)));
      if (status !== 200) return { error: `Forgejo API error: ${status}` };
      return { data };
    } catch (error) {
      if (error instanceof PlatformRequestError && error.status !== null) {
        return { error: `Forgejo API error: ${error.status}` };
      }
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Port of `_forgejo_translate`: map a validated GitHub-shaped path onto
   * the Forgejo /api/v1 namespace. Returns null (fail closed) for anything
   * outside the table. #1225: a query string is split off before segment
   * matching and re-attached verbatim to the translated URL, so a
   * query-carrying endpoint (`issues?state=open`) behaves identically across
   * forges. Splitting on the FIRST `?` matches RFC 3986: everything after it
   * is inert query data (its charset is fenced upstream by validateEndpoint)
   * and the remaining path must still match the table exactly — a `?`
   * smuggled into a segment leaves a query-free path that fails the lookup
   * (fail closed); it never reinterprets the path that is matched. */
  static translate(fullPath: string, repoKey: string): string | null {
    const queryIndex = fullPath.indexOf("?");
    const path = queryIndex === -1 ? fullPath : fullPath.slice(0, queryIndex);
    const query = queryIndex === -1 ? "" : fullPath.slice(queryIndex);
    const translated = ForgejoAdapter.translatePath(path, repoKey);
    return translated === null ? null : `${translated}${query}`;
  }

  /** The segment-matching table, operating on a query-free path. */
  private static translatePath(path: string, repoKey: string): string | null {
    if (!repoKey) {
      if (path.startsWith("/search/")) return `/api/v1${path}`;
      return null;
    }
    const repos = `/repos/${repoKey}`;
    if (!path.startsWith(repos)) return null;
    const rest = path.slice(repos.length);
    if (rest === "/pulls" || rest.startsWith("/pulls/")) {
      if (rest.endsWith("/diff")) {
        const n = rest.slice("/pulls/".length, -"/diff".length);
        return `/api/v1/repos/${repoKey}/pulls/${n}.diff`;
      }
      return `/api/v1/repos/${repoKey}${rest}`;
    }
    if (rest === "/issues" || rest.startsWith("/issues/")) return `/api/v1/repos/${repoKey}${rest}`;
    // #914: the commenter-permission lookup for the comment re-review
    // command. The GitHub-shaped path is byte-identical on Forgejo's API v1
    // (and its response carries the same `permission` field).
    if (rest.startsWith("/collaborators/")) return `/api/v1/repos/${repoKey}${rest}`;
    if (rest === "/compare" || rest.startsWith("/compare/")) {
      return `/api/v1/repos/${repoKey}/compare/${rest.slice("/compare/".length)}`;
    }
    if (rest === "/releases/tags" || rest.startsWith("/releases/tags/")) return `/api/v1/repos/${repoKey}${rest}`;
    if (rest === "/commits" || rest.startsWith("/commits/")) return `/api/v1/repos/${repoKey}${rest}`;
    return null;
  }
}
