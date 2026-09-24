import { PlatformRequestError, requestJson, requestText, type FetchLike } from "./http.js";
import { parsePlatformBaseUrl } from "./urls.js";
import { validateEndpoint, type EndpointValidation } from "./endpoint.js";
import type { GhApiResult, ManagedComment, ManagedReview, PlatformAdapter } from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
const JWT_TTL_SECONDS = 2700;

export interface ForgejoAdapterOptions {
  repo: string;
  prNumber: string;
  /** FORGEJO_API_URL — validated before any credential is attached. */
  baseUrl: string;
  /** Resolved token (FORGEJO_TOKEN → GITHUB_TOKEN → GH_TOKEN chain). */
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

function parseRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Invalid repo full name: ${repo}`);
  return { owner, repo: name };
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
export class ForgejoAdapter implements PlatformAdapter {
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

  constructor(options: ForgejoAdapterOptions) {
    const parsed = parsePlatformBaseUrl(options.baseUrl, "Forgejo API base URL");
    this.baseUrl = parsed.base;
    this.origin = parsed.origin;
    this.repo = options.repo;
    this.prNumber = options.prNumber;
    this.token = options.token;
    this.authMethod = options.authMethod ?? "token";
    this.audience = options.authorizedIntegrationAudience ?? "";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private apiPath(path: string): string {
    return `${this.baseUrl}/api/v1${path}`;
  }

  private isAuthorizedIntegrationMode(): boolean {
    return this.audience.trim() !== "";
  }

  /** Resolve the Authorization header (port of `_resolve_auth_header`):
   * authorized-integration mode with no explicit token uses the OIDC JWT;
   * an explicit token always wins; token="" opts out of authentication. */
  private async authorizationHeader(): Promise<string | undefined> {
    if (this.isAuthorizedIntegrationMode()) {
      if (this.token === "") return undefined;
      if (this.token) return `token ${this.token}`;
      return `Bearer ${await this.getJwt()}`;
    }
    if (!this.token) return undefined;
    return `token ${this.token}`;
  }

  private async options(accept?: string): Promise<Parameters<typeof requestJson>[1]> {
    return {
      token: await this.authorizationHeader(),
      accept,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      allowedOrigin: this.origin,
    };
  }

  /** Exchange the runner's OIDC identity for a JWT (port of
   * `_fetch_authorized_integration_jwt`), cached for 45 minutes. */
  private async getJwt(): Promise<string> {
    const cached = this.jwtCache;
    if (cached && Date.now() - cached.fetchedAt < JWT_TTL_SECONDS * 1000) return cached.token;
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
      state: data.state ?? "open",
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
      draft: Boolean(data.draft),
      labels: Array.isArray(data.labels)
        ? data.labels.map((label: unknown) => ({ name: isObject(label) ? label.name ?? "" : "" }))
        : [],
    };
  }

  async getPr(): Promise<unknown | null> {
    const { owner, repo } = parseRepo(this.repo);
    try {
      const { status, data } = await requestJson(
        this.apiPath(`/repos/${owner}/${repo}/pulls/${this.prNumber}`),
        (await this.options()),
      );
      if (status !== 200) return null;
      return ForgejoAdapter.prToGithubShape(data, owner, repo, this.prNumber);
    } catch {
      return null;
    }
  }

  async getPrDiff(): Promise<string> {
    const { owner, repo } = parseRepo(this.repo);
    try {
      const { status, text } = await requestText(
        this.apiPath(`/repos/${owner}/${repo}/pulls/${this.prNumber}.diff`),
        (await this.options("application/json")),
      );
      return status === 200 ? text : "";
    } catch {
      return "";
    }
  }

  async listIssueComments(): Promise<ManagedComment[]> {
    const { owner, repo } = parseRepo(this.repo);
    const allComments: ManagedComment[] = [];
    let page = 1;
    for (;;) {
      let status = 0;
      let comments: unknown = null;
      try {
        const result = await requestJson(
          this.apiPath(`/repos/${owner}/${repo}/issues/${this.prNumber}/comments?page=${page}&limit=50`),
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
        });
      }
      if (comments.length < 50) break;
      page += 1;
    }
    return allComments;
  }

  async listPrReviews(): Promise<ManagedReview[]> {
    const { owner, repo } = parseRepo(this.repo);
    let data: unknown = null;
    let status = 0;
    try {
      const result = await requestJson(this.apiPath(`/repos/${owner}/${repo}/pulls/${this.prNumber}/reviews`), (await this.options()));
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
      }));
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
    const { owner, repo } = parseRepo(this.repo);
    const auth = await this.authorizationHeader();
    const authOptions = { ...(await this.options()), token: auth };
    const permissionFromRepoPayload = ForgejoAdapter.permissionFromRepoPayload;

    if (this.isAuthorizedIntegrationMode()) {
      let status = 0;
      let body: unknown = null;
      try {
        const result = await requestJson(this.apiPath(`/repos/${owner}/${repo}`), authOptions);
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
        this.apiPath(`/repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`),
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
        const result = await requestJson(this.apiPath(`/repos/${owner}/${repo}`), authOptions);
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
  async ghApi(endpoint: string): Promise<GhApiResult> {
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
      const { status, data } = await requestJson(this.apiPath(translated), (await this.options("application/json")));
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
   * outside the table. */
  static translate(fullPath: string, repoKey: string): string | null {
    if (!repoKey) {
      if (fullPath.startsWith("/search/")) return `/api/v1${fullPath}`;
      return null;
    }
    const repos = `/repos/${repoKey}`;
    if (!fullPath.startsWith(repos)) return null;
    const rest = fullPath.slice(repos.length);
    if (rest === "/pulls" || rest.startsWith("/pulls/")) {
      if (rest.endsWith("/diff")) {
        const n = rest.slice("/pulls/".length, -"/diff".length);
        return `/api/v1/repos/${repoKey}/pulls/${n}.diff`;
      }
      return `/api/v1/repos/${repoKey}${rest}`;
    }
    if (rest === "/issues" || rest.startsWith("/issues/")) return `/api/v1/repos/${repoKey}${rest}`;
    if (rest === "/compare" || rest.startsWith("/compare/")) {
      return `/api/v1/repos/${repoKey}/compare/${rest.slice("/compare/".length)}`;
    }
    if (rest === "/releases/tags" || rest.startsWith("/releases/tags/")) return `/api/v1/repos/${repoKey}${rest}`;
    if (rest === "/commits" || rest.startsWith("/commits/")) return `/api/v1/repos/${repoKey}${rest}`;
    return null;
  }
}
