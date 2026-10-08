import {
  resolveTangledPull,
  type ResolveTangledPullOptions,
  type TangledPullIdentity,
} from "./tangled-bobbin.js";
import { tangledCapabilityError, type TangledContext } from "./tangled.js";
import type { FetchLike } from "./http.js";
import type {
  ExternalCheck,
  ExternalChecksOptions,
  GhApiResult,
  ManagedComment,
  ManagedReview,
  PlatformReadAdapter,
  ReadResult,
} from "./types.js";

/**
 * Tangled read adapter (#585) — the first real Tangled backend, and it is
 * deliberately narrow: read-only and metadata-only.
 *
 * The adapter resolves the run's canonical Tangled pull through the read-side
 * Bobbin resolver (`resolveTangledPull`) and projects it into the same
 * GitHub-REST pull shape the precheck/fingerprint and context consumers read
 * from GitHub and Forgejo, so downstream code cannot tell which forge served
 * the metadata. The pull's identity (AT-URI / CID / rkey) is retained on the
 * adapter for the later #564 tickets but is never embedded into the
 * normalized payload or the shared `PlatformAdapter` interface.
 *
 * Only `getPr` is implemented. Everything beyond metadata reads fails
 * closed: the diff read throws (the patch decode lands in #586), the
 * comment/review reads throw, `ghApi` returns an error, and the
 * `ReadResult`-shaped reads return `{ ok: false, error }` — no capability
 * silently degrades to a guess.
 */
export interface TangledAdapterOptions {
  /** The Spindle runtime context (owner/repo DID, branch tuple, Bobbin URL). */
  context: TangledContext;
  /** Transport override for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike | undefined;
  /** Optional credential, sent only as the Authorization header to the
   * validated Bobbin origin (never in the URL, argv, or diagnostics). */
  token?: string | undefined;
  /** Per-request timeout in milliseconds; `undefined` falls through to the
   * transport's default. */
  timeoutMs?: number | undefined;
}

export class TangledAdapter implements PlatformReadAdapter {
  readonly platform = "tangled" as const;
  private readonly context: TangledContext;
  private readonly fetchImpl: FetchLike;
  private readonly token: string | undefined;
  private readonly timeoutMs: number | undefined;
  /** The resolved canonical pull, bound once and reused by every `getPr`
   * call and exposed via `pullIdentity`. `null` until a resolution succeeds. */
  private identity: TangledPullIdentity | null = null;
  /** The in-flight `resolveTangledPull` call, shared by concurrent `getPr`
   * calls so exactly one Bobbin round-trip happens. `null` when idle or once
   * the resolution settles: a success binds `identity`, a failure clears the
   * slot so a later call retries. */
  private inFlight: Promise<TangledPullIdentity> | null = null;

  constructor(options: TangledAdapterOptions) {
    this.context = options.context;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
  }

  /** The cached canonical pull identity (uri/cid/rkey), or `null` until a
   * resolution succeeds. Internal to the #586+ follow-on work; it is never
   * part of the normalized PR object or the shared adapter interface. */
  get pullIdentity(): TangledPullIdentity | null {
    return this.identity;
  }

  /** Resolve the canonical pull once, project it into the GitHub-REST shape,
   * and cache both. Concurrency-safe: the first `getPr` starts the single
   * `resolveTangledPull` round-trip and concurrent calls await that same
   * in-flight promise, so only one Bobbin call happens. Any resolver or
   * transport failure resolves to `null` (the `getPr` contract) rather than
   * throwing, and clears the in-flight slot so a later call retries. */
  async getPr(): Promise<unknown | null> {
    if (this.identity !== null) return this.project(this.identity);
    if (this.inFlight === null) {
      const options: ResolveTangledPullOptions = { fetchImpl: this.fetchImpl };
      if (this.token !== undefined) options.token = this.token;
      if (this.timeoutMs !== undefined) options.timeoutMs = this.timeoutMs;
      this.inFlight = (async () => {
        try {
          const resolved = await resolveTangledPull(this.context, options);
          this.identity = resolved;
          return resolved;
        } finally {
          this.inFlight = null;
        }
      })();
    }
    const pending = this.inFlight;
    try {
      await pending;
    } catch {
      return null;
    }
    return this.identity !== null ? this.project(this.identity) : null;
  }

  /** Project a resolved pull into the GitHub-REST pull shape consumed by
   * `normalizePrIdentity` / `deriveIsFork` / `deriveDraftState` /
   * `canonicalPullRequest`, mirroring the Forgejo adapter's discipline:
   * never fabricate — unavailable strings are `""`, unknown optionals are
   * omitted, and the numeric `number` is never synthesized.
   *
   * Tangled repositories are addressed by DID, so the head/base `repo`
   * `full_name` fields carry the source/target repository DIDs (host-neutral
   * stable identifiers) in place of an `owner/repo` path. A missing source
   * repo DID (a patch-backed pull has no source) leaves the head repo empty,
   * which `deriveIsFork` treats as a fork (fail closed). */
  private project(identity: TangledPullIdentity): unknown {
    const record = identity.record;
    const createdAt = record.createdAt;
    const createdAtValue = typeof createdAt === "string" ? createdAt : null;
    const pr: Record<string, unknown> = {
      title: typeof record.title === "string" ? record.title : "",
      body: typeof record.description === "string" ? record.description : null,
      state: identity.state ?? "",
      user: { login: identity.authorDid },
      head: {
        // The read-side record exposes no head commit; the SHA is the
        // runtime checkout SHA from the Spindle context, or `""` (never a
        // guess) when the pull is patch-backed or the context has no SHA.
        sha: this.context.sourceSha ?? "",
        ref: identity.sourceBranch ?? "",
        repo: { full_name: identity.sourceRepoDid ?? "" },
      },
      base: {
        sha: "",
        ref: identity.targetBranch ?? "",
        repo: { full_name: identity.repoDid },
      },
      merged_at: null,
      created_at: createdAtValue,
      // The canonical AT-URI is the stable reference; the knot web route is
      // unknown and must not be invented.
      url: identity.uri,
      html_url: identity.uri,
      labels: [],
    };
    // `number` is intentionally absent: Tangled pulls have no numeric
    // identity, and `canonicalPullRequest` already coerces a missing number
    // to 0 — we never synthesize one. The draft flag is written only when
    // the record carries a real boolean; an honest absence means
    // `deriveDraftState` returns "unknown" (the later precheck-integration
    // ticket decides which side that fails to), and the precheck guard still
    // rejects tangled today.
    const draft = record.draft;
    if (typeof draft === "boolean") pr.draft = draft;
    return pr;
  }

  /** The diff is the pull's patch blob, decoded in #586 — not available yet. */
  async getPrDiff(): Promise<string> {
    throw tangledCapabilityError("pull diff reads (#586)");
  }

  async listIssueComments(): Promise<ManagedComment[]> {
    throw tangledCapabilityError("issue comment reads");
  }

  async listPrReviews(): Promise<ManagedReview[]> {
    throw tangledCapabilityError("PR review reads");
  }

  /** The validated read-only API seam: unavailable, so it reports an error
   * and never throws (the contract for `ghApi`). */
  async ghApi(_endpoint: string): Promise<GhApiResult> {
    return { error: tangledCapabilityError("gh_api reads").message };
  }

  /** Tangled reads are public/unauthenticated; the run's own posting
   * identity is unprovable, so the precheck fails closed on `null`. */
  async authenticatedIdentity(): Promise<string | null> {
    return null;
  }

  /** Coarse repo permission is unknown for a Tangled run (fail closed to
   * "unknown", matching the GitHub adapter's coarse-permission answer). */
  async repoPermission(): Promise<string | null> {
    return "unknown";
  }

  listPrFiles(): Promise<ReadResult<unknown>> {
    return Promise.resolve({ ok: false, error: tangledCapabilityError("changed-file reads").message });
  }

  async getIssue(_repo: string, _issueNumber: string): Promise<ReadResult<unknown>> {
    return { ok: false, error: tangledCapabilityError("linked-issue reads").message };
  }

  async listPrConversationComments(): Promise<ReadResult<unknown[]>> {
    return { ok: false, error: tangledCapabilityError("conversation comment reads").message };
  }

  async listReviewThreads(): Promise<ReadResult<unknown[]>> {
    return { ok: false, error: tangledCapabilityError("review-thread reads").message };
  }

  async listPrReviewsPaginated(): Promise<ReadResult<unknown[]>> {
    return { ok: false, error: tangledCapabilityError("paginated review reads").message };
  }

  /** External check reads fail loud, never `null`: the seam's `null` return
   * is the transient-retry signal (a read that failed and may succeed on a
   * later attempt), not a capability-absent one, so returning it here would
   * make the CI gate retry a capability that does not exist yet. Throws the
   * scoped capability error until the gate ticket wires real Tangled checks. */
  async externalChecks(_sha: string, _options?: ExternalChecksOptions): Promise<ExternalCheck[] | null> {
    throw tangledCapabilityError("external check reads");
  }
}
