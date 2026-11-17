import {
  resolveTangledPull,
  type ResolveTangledPullOptions,
  type TangledPullIdentity,
} from "./tangled-bobbin.js";
import {
  fetchTangledPullRoundDiff,
  type TangledPullRoundDiff,
} from "./tangled-diff.js";
import { tangledCapabilityError, type TangledContext } from "./tangled.js";
import type { FetchLike } from "./http.js";
import type { AddressPolicy, Resolver } from "./safe-fetch.js";
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
 * Tangled read adapter (#585, diff wired by #1690) — the real Tangled
 * backend, deliberately narrow: read-only.
 *
 * The adapter resolves the run's canonical Tangled pull through the read-side
 * Bobbin resolver (`resolveTangledPull`) and projects it into the same
 * GitHub-REST pull shape the precheck/fingerprint and context consumers read
 * from GitHub and Forgejo, so downstream code cannot tell which forge served
 * the metadata. The pull's identity (AT-URI / CID / rkey) is retained on the
 * adapter for the publication seam but is never embedded into the normalized
 * payload or the shared `PlatformAdapter` interface.
 *
 * The #586 round-diff chain is now the adapter's diff/files read:
 * `getPrDiff`/`listPrFiles` serve the latest pull round (Bobbin record →
 * author-PDS patch blob → gunzip → `normalizeGitFormatPatch`), keeping the
 * chain's typed fail-closed errors (no-round / invalid-round /
 * undecodable-blob / patch-too-large / blob-read failures) — nothing is
 * caught-and-emptied into a fake successful diff.
 *
 * What Tangled has no source for stays an honest failure, never a guess:
 * `ghApi` returns an error, the thread/conversation/paginated-review/linked-
 * issue reads return `{ ok: false, error }` (consumers degrade), and
 * `externalChecks` throws (a permanently-missing capability must not
 * masquerade as the seam's transient-retry `null`). The GitHub-shaped
 * comment/review reads answer `[]`: a Tangled pull has no GitHub issue
 * comments or native reviews, and the managed review lives in the bot's
 * AT-Proto record (reconciled by the #588 publish API, not by these reads) —
 * so precheck never carries a stale fingerprint or verdict forward.
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
  /** Test seam only, passed through to the round-diff blob read: production
   * resolves with `systemResolver` (see `tangled-diff.ts`). */
  resolver?: Resolver | undefined;
  /** Test seam only, passed through to the round-diff blob read: production
   * uses `isPublicAddress` (see `tangled-diff.ts`). */
  addressPolicy?: AddressPolicy | undefined;
}

export class TangledAdapter implements PlatformReadAdapter {
  readonly platform = "tangled" as const;
  private readonly context: TangledContext;
  private readonly fetchImpl: FetchLike;
  private readonly token: string | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly resolver: Resolver | undefined;
  private readonly addressPolicy: AddressPolicy | undefined;
  /** The resolved canonical pull, bound once and reused by every `getPr`
   * call and exposed via `pullIdentity`. `null` until a resolution succeeds. */
  private identity: TangledPullIdentity | null = null;
  /** The in-flight `resolveTangledPull` call, shared by concurrent `getPr`
   * calls so exactly one Bobbin round-trip happens. `null` when idle or once
   * the resolution settles: a success binds `identity`, a failure clears the
   * slot so a later call retries. */
  private inFlight: Promise<TangledPullIdentity> | null = null;
  /** The in-flight/settled round-diff read, shared by `getPrDiff` and
   * `listPrFiles` so one run fetches and normalizes the latest round's patch
   * blob exactly once. Like the identity slot, a failure clears it so a later
   * call retries rather than caching a dead promise. */
  private roundPending: Promise<TangledPullRoundDiff> | null = null;

  constructor(options: TangledAdapterOptions) {
    this.context = options.context;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.resolver = options.resolver;
    this.addressPolicy = options.addressPolicy;
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

  /** The latest round's normalized patch, read once per run: resolve the
   * canonical pull first (the diff is read from the resolved record's round
   * list), then run the #586 chain (round selection → author-PDS blob →
   * gunzip → `normalizeGitFormatPatch`). Concurrency-safe and cached like the
   * identity: concurrent callers share one blob read; a failure clears the
   * slot so a later call retries. Every failure propagates as the chain's
   * typed error (`TangledPatchError` / `TangledBlobError`) — the fail-closed
   * no-round / undecodable / over-cap mapping is the chain's, and this
   * adapter adds no empty-success path of its own. */
  private roundDiff(): Promise<TangledPullRoundDiff> {
    this.roundPending ??= (async () => {
      try {
        await this.getPr();
        const identity = this.identity;
        if (identity === null) {
          throw new Error("Tangled pull resolution failed before the round-diff read");
        }
        return await fetchTangledPullRoundDiff(identity, {
          fetchImpl: this.fetchImpl,
          timeoutMs: this.timeoutMs,
          resolver: this.resolver,
          addressPolicy: this.addressPolicy,
        });
      } catch (error) {
        this.roundPending = null;
        throw error;
      }
    })();
    return this.roundPending;
  }

  /** The pull's reviewable diff: the latest round's patch blob, fetched and
   * normalized through the #586 chain (see `roundDiff`). Throws the chain's
   * typed error on every failure — never an empty diff. */
  async getPrDiff(): Promise<string> {
    return (await this.roundDiff()).diff;
  }

  /** GitHub issue comments: a Tangled pull has none, and the managed review
   * is an AT-Proto record reconciled by the #588 publish API — never a
   * comment these reads would see. `[]` is therefore the honest answer, and
   * the safe one: precheck finds no stored fingerprint and always reviews
   * fresh rather than skipping on a carried body it cannot verify. */
  async listIssueComments(): Promise<ManagedComment[]> {
    return [];
  }

  /** Native PR reviews: Tangled has no native review object (see the support
   * matrix in `docs/tangled.md`), so there is nothing to list and no carried
   * verdict — a fresh full review every run. */
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

  /** The changed files of the same round-diff read as `getPrDiff` (shared,
   * cached). The `ReadResult` contract reports failures in band: the chain's
   * typed error message surfaces as `{ ok: false, error }`, never an empty
   * success. */
  listPrFiles(): Promise<ReadResult<unknown>> {
    return this.roundDiff().then(
      (round) => ({ ok: true, data: round.files }),
      (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
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
