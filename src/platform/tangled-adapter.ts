import {
  resolveTangledPull,
  type ResolveTangledPullOptions,
  type TangledPullIdentity,
} from "./tangled-bobbin.js";
import { fetchTangledPullRoundDiff, type TangledPullRoundDiff, type TangledRoundDiffOptions } from "./tangled-diff.js";
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
 * Tangled read adapter (#585, diff wiring #1690) — the first real Tangled
 * backend: read-only, and narrow on purpose.
 *
 * The adapter resolves the run's canonical Tangled pull through the read-side
 * Bobbin resolver (`resolveTangledPull`) and projects it into the same
 * GitHub-REST pull shape the precheck/fingerprint and context consumers read
 * from GitHub and Forgejo, so downstream code cannot tell which forge served
 * the metadata. The pull's identity (AT-URI / CID / rkey) is retained on the
 * adapter for the diff chain below but is never embedded into the
 * normalized payload or the shared `PlatformAdapter` interface.
 *
 * The diff/files reads (#586) run the real round-diff chain
 * (`fetchTangledPullRoundDiff`: Bobbin record → author-PDS blob → gunzip →
 * `normalizeGitFormatPatch`) on the resolved identity, memoized so every
 * stage of one run reads the SAME reviewed round. Every chain failure
 * propagates as the typed error of the step that produced it — no empty
 * success, no silent degradation (#1690).
 *
 * The remaining capability surface stays honest about what Tangled has no
 * source for: `ghApi` returns an error, the `ReadResult`-shaped reads
 * return `{ ok: false, error }`, and `externalChecks` fails loud — no
 * capability silently degrades to a guess. `listIssueComments` /
 * `listPrReviews` return the empty truth (Tangled has no native comment or
 * review surfaces to list), which can never fabricate a skip.
 */
export interface TangledAdapterOptions {
  /** The Spindle runtime context (owner/repo DID, branch tuple, Bobbin URL). */
  context: TangledContext;
  /** Transport override for tests; defaults to the global `fetch`. Covers
   * both the Bobbin reads and the PDS blob chain of the diff read. */
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
  /** The memoized round-diff chain (below). `null` until the first diff or
   * files read. */
  private roundPending: Promise<TangledPullRoundDiff> | null = null;

  constructor(options: TangledAdapterOptions) {
    this.context = options.context;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
  }

  /** The cached canonical pull identity (uri/cid/rkey), or `null` until a
   * resolution succeeds. Internal to the adapter's diff chain; it is never
   * part of the normalized PR object or the shared adapter interface. */
  get pullIdentity(): TangledPullIdentity | null {
    return this.identity;
  }

  /** Resolve (or return the cached) canonical pull identity, THROWING on
   * failure — the diff/files chain needs the identity to complete and must
   * fail closed rather than degrade. Shares the same in-flight slot and
   * cache as `getPr`, so a run pays at most one Bobbin resolution. */
  private async resolveIdentity(): Promise<TangledPullIdentity> {
    if (this.identity !== null) return this.identity;
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
    return await this.inFlight;
  }

  /** Resolve the canonical pull once, project it into the GitHub-REST shape,
   * and cache both. Concurrency-safe: the first `getPr` starts the single
   * `resolveTangledPull` round-trip and concurrent calls await that same
   * in-flight promise, so only one Bobbin call happens. Any resolver or
   * transport failure resolves to `null` (the `getPr` contract) rather than
   * throwing, and clears the in-flight slot so a later call retries. */
  async getPr(): Promise<unknown | null> {
    try {
      const resolved = await this.resolveIdentity();
      return this.project(resolved);
    } catch {
      return null;
    }
  }

  /** The pull's latest-round diff chain (#586), consumed by the diff and
   * files reads (#1690 wires it into the production path). Memoized per
   * adapter: one run reads the diff several times (precheck, engine corpus,
   * publish anchoring) and every read must present the SAME reviewed round —
   * a pull that gains a round mid-run must never let a later stage read
   * content the precheck did not review. A failed chain is memoized too, so
   * the run's later stages cannot quietly retry past a failure that the
   * precheck already saw; the next run builds a fresh adapter. */
  private roundDiff(): Promise<TangledPullRoundDiff> {
    this.roundPending ??= (async () => {
      const identity = await this.resolveIdentity();
      const options: TangledRoundDiffOptions = {
        fetchImpl: this.fetchImpl,
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      };
      return fetchTangledPullRoundDiff(identity, options);
    })();
    return this.roundPending;
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
    // `deriveDraftState` returns "unknown", which the precheck draft gate
    // fails closed on.
    const draft = record.draft;
    if (typeof draft === "boolean") pr.draft = draft;
    return pr;
  }

  /** The pull's latest round as a reviewable diff: the memoized #586 chain
   * (Bobbin identity → author-PDS blob → gunzip → mail-envelope
   * normalization), wired into the production path by #1690. Every failure
   * propagates as the typed error of the step that produced it —
   * "no-round"/"invalid-round" (before the network), "undecodable-blob"/
   * "patch-too-large" (blob decode), "malformed-patch"/"empty-patch"
   * (normalization), or TangledBlobError/TangledResolverError (transport).
   * The chain's `declaredHeadSha` is advisory untrusted-patch metadata and
   * is deliberately not exposed here — the trusted current head comes only
   * from the knot read the publish boundary re-checks (#1165). */
  async getPrDiff(): Promise<string> {
    return (await this.roundDiff()).diff;
  }

  /** Tangled has no native issue-comment or pull-review surfaces to list —
   * the only managed-review state is the bot-owned AT-Proto record the
   * publish seam reads and updates in place (#588). The honest answer is
   * the empty truth: `[]` can never fabricate a skip or a carried verdict
   * (those require an authenticated managed body, which an empty list can
   * never supply), while throwing here killed every real run in precheck
   * before the engine started (#1690). */
  async listIssueComments(): Promise<ManagedComment[]> {
    return [];
  }

  async listPrReviews(): Promise<ManagedReview[]> {
    return [];
  }

  /** The validated read-only API seam: unavailable, so it reports an error
   * and never throws (the contract for `ghApi`). */
  async ghApi(_endpoint: string, _opts?: { timeoutMs?: number }): Promise<GhApiResult> {
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

  /** The memoized round diff's files, the same reviewed round `getPrDiff`
   * presents (#1690). The `ReadResult` contract reports failure in-band:
   * a failed chain maps to `{ ok: false, error }` (the same typed step
   * error `getPrDiff` throws), never a fabricated empty file list. */
  async listPrFiles(): Promise<ReadResult<unknown>> {
    try {
      return { ok: true, data: (await this.roundDiff()).files };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
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
