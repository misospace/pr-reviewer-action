/** Platform adapter contract (#674): the typed seam every host-forge
 * interaction goes through. Shapes mirror the v2 platform seam so callers
 * cannot tell which platform served a payload. */

export interface ManagedComment {
  id?: number | string | undefined;
  body: string;
  created_at?: string | undefined;
  updated_at?: string | undefined;
}

export interface ManagedReview {
  body: string;
  submitted_at?: string | undefined;
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
  /** "read" | "write" | "admin" | "unknown" | null (transport failure).
   * GitHub returns "unknown": coarse repo permission cannot infer the
   * unit-scoped GitHub App token permissions. */
  repoPermission(): Promise<string | null>;
  /** The validated read-only API seam — the TS mirror of
   * `pr_reviewer.platform.gh_api`: returns `{"data": ...}` on success or
   * `{"error": ...}`, never throws for policy rejections. */
  ghApi(endpoint: string): Promise<GhApiResult>;
}
