import { validateEndpoint, type EndpointValidation } from "./endpoint.js";
import { PlatformRequestError, requestJson, requestText, type FetchLike } from "./http.js";
import { GITHUB_API_BASE, parsePlatformBaseUrl } from "./urls.js";
import type { GhApiResult, ManagedComment, ManagedReview, PlatformAdapter } from "./types.js";

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
export class GitHubAdapter implements PlatformAdapter {
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
    try {
      const { status, data } = await requestJson(this.url(`/repos/${this.repo}/pulls/${this.prNumber}`), this.options());
      return status === 200 ? data : null;
    } catch {
      return null;
    }
  }

  async getPrDiff(): Promise<string> {
    try {
      const { status, text } = await requestText(
        this.url(`/repos/${this.repo}/pulls/${this.prNumber}`),
        this.options("application/vnd.github.v3.diff"),
      );
      return status === 200 ? text : "";
    } catch {
      return "";
    }
  }

  async listIssueComments(): Promise<ManagedComment[]> {
    try {
      const { status, data } = await requestJson(
        this.url(`/repos/${this.repo}/issues/${this.prNumber}/comments?per_page=100`),
        this.options(),
      );
      return status === 200 && Array.isArray(data) ? (data as ManagedComment[]) : [];
    } catch {
      return [];
    }
  }

  async listPrReviews(): Promise<ManagedReview[]> {
    try {
      const { status, data } = await requestJson(
        this.url(`/repos/${this.repo}/pulls/${this.prNumber}/reviews?per_page=100`),
        this.options(),
      );
      return status === 200 && Array.isArray(data) ? (data as ManagedReview[]) : [];
    } catch {
      return [];
    }
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
