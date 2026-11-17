import type { FetchLike } from "./http.js";
import { readTangledPatchDiff, type TangledGitDiff } from "./tangled-git.js";
import { resolveTangledReviewIdentity, type ResolveTangledReviewIdentityOptions, type TangledReviewIdentity } from "./tangled-ticket.js";
import { tangledCapabilityError, type TangledContext } from "./tangled.js";
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
 * Tangled read adapter (#585) on the CURRENT record model (#1690 protocol
 * pivot; the pre-2026-10-28 `sh.tangled.repo.pull` / `rounds[].patchBlob`
 * model is obsolete and no production path may complete it).
 *
 * The adapter resolves the run's review identity through the read-side
 * ticket/patch resolver (`resolveTangledReviewIdentity`: one open
 * `org.tangled.track.ticket` pull request plus its newest immutable
 * `org.tangled.review.patch` revision, read from the repository account on
 * the knot) and projects it into the same GitHub-REST pull shape the
 * precheck/fingerprint and context consumers read from GitHub and Forgejo,
 * so downstream code cannot tell which forge served the metadata. The
 * resolved patch revision IS the review identity: its trusted
 * `base.oid`/`head.oid` (knot-written via `org.tangled.review.submitPatch`)
 * drive both the reviewed diff and the managed record's reviewed head, so
 * reviewed content and the publication-boundary head proof (#1165) cannot
 * describe different rounds.
 *
 * The diff/files reads derive the reviewable content from the resolved
 * revision's trusted base/head through the knot's Git read surface — the
 * checked-out round in the run workspace, read with fixed-argv bounded git
 * commands (`readTangledPatchDiff`, tangled-git.ts) — memoized so every
 * stage of one run reads the SAME reviewed revision. Every failure
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
  /** The Spindle runtime context (owner/repo DID, branch tuple, knot host). */
  context: TangledContext;
  /** Transport override for tests; defaults to the global `fetch`. Covers
   * the knot record reads behind the review-identity resolution. */
  fetchImpl?: FetchLike | undefined;
  /** Optional credential, sent only as the Authorization header to the
   * validated knot origin (never in the URL, argv, or diagnostics). */
  token?: string | undefined;
  /** Per-request timeout in milliseconds; `undefined` falls through to the
   * transport's default. */
  timeoutMs?: number | undefined;
  /** The run workspace (the Spindle checkout of the pull's selected round)
   * — the Git read surface the diff/files are derived from. Required for
   * `getPrDiff`/`listPrFiles`; absent, the diff read fails closed. */
  workspace?: string | undefined;
  /** Git read timeout in seconds; defaults to the bounded git catalog's
   * standard. */
  gitTimeoutSec?: number | undefined;
}

export class TangledAdapter implements PlatformReadAdapter {
  readonly platform = "tangled" as const;
  private readonly context: TangledContext;
  private readonly fetchImpl: FetchLike;
  private readonly token: string | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly workspace: string | undefined;
  private readonly gitTimeoutSec: number | undefined;
  /** The resolved review identity (ticket + selected patch revision), bound
   * once and reused by every `getPr` call. `null` until a resolution
   * succeeds. */
  private identity: TangledReviewIdentity | null = null;
  /** The in-flight review-identity resolution, shared by concurrent reads so
   * exactly one knot round-trip pair happens. `null` when idle or once the
   * resolution settles: a success binds `identity`, a failure clears the
   * slot so a later call retries. */
  private inFlight: Promise<TangledReviewIdentity> | null = null;
  /** The memoized reviewed diff (below). `null` until the first diff or
   * files read. */
  private diffPending: Promise<TangledGitDiff> | null = null;

  constructor(options: TangledAdapterOptions) {
    this.context = options.context;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.workspace = options.workspace;
    this.gitTimeoutSec = options.gitTimeoutSec;
  }

  /** The resolved review identity (ticket + selected patch revision), or
   * `null` until a resolution succeeds. Internal to the adapter's diff
   * chain; it is never part of the normalized PR object or the shared
   * adapter interface. */
  get pullIdentity(): TangledReviewIdentity | null {
    return this.identity;
  }

  /** Resolve (or return the cached) review identity, THROWING on failure —
   * the diff/files chain needs the identity to complete and must fail
   * closed rather than degrade. Shares the same in-flight slot and cache
   * as `getPr`, so a run pays at most one resolution. */
  private async resolveIdentity(): Promise<TangledReviewIdentity> {
    if (this.identity !== null) return this.identity;
    if (this.inFlight === null) {
      const options: ResolveTangledReviewIdentityOptions = {
        fetchImpl: this.fetchImpl,
        ...(this.token !== undefined ? { token: this.token } : {}),
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      };
      this.inFlight = (async () => {
        try {
          const resolved = await resolveTangledReviewIdentity(this.context, options);
          this.identity = resolved;
          return resolved;
        } finally {
          this.inFlight = null;
        }
      })();
    }
    return await this.inFlight;
  }

  /** Resolve the review identity once, project it into the GitHub-REST
   * shape, and cache both. Concurrency-safe: the first `getPr` starts the
   * single resolution and concurrent calls await that same in-flight
   * promise, so only one knot round-trip pair happens. Any resolution or
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

  /** The selected patch revision's reviewed diff chain (#1690), consumed by
   * the diff and files reads. Memoized per adapter: one run reads the diff
   * several times (precheck, engine corpus, publish anchoring) and every
   * read must present the SAME reviewed revision — a pull that gains a new
   * patch revision mid-run must never let a later stage read content the
   * precheck did not review (and the #1165 publication proof refuses that
   * run anyway, since the fresh head read would disagree). A failed chain
   * is memoized too, so the run's later stages cannot quietly retry past a
   * failure the precheck already saw; the next run builds a fresh adapter. */
  private reviewedDiff(): Promise<TangledGitDiff> {
    this.diffPending ??= (async () => {
      const identity = await this.resolveIdentity();
      if (this.workspace === undefined || this.workspace.trim() === "") {
        throw tangledCapabilityError(
          "diff reads without a run workspace (the checked-out round is the Git read surface)",
        );
      }
      return readTangledPatchDiff(this.workspace, identity.baseOid, identity.headOid, {
        ...(this.gitTimeoutSec !== undefined ? { timeoutSec: this.gitTimeoutSec } : {}),
      });
    })();
    return this.diffPending;
  }


  /** The selected patch revision's reviewed diff: the memoized Git-surface
   * derivation (tangled-git.ts) anchored to the revision's trusted
   * base/head, wired into the production path by #1690. Every failure
   * propagates as the typed error of the step that produced it — a
   * resolution failure (`TangledResolverError`), a missing/unusable
   * checkout or git failure (`TangledGitError`). The revision's oids come
   * from the knot, never from the forgeable workspace state. */
  async getPrDiff(): Promise<string> {
    return (await this.reviewedDiff()).diff;
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

  /** Project the resolved review identity (the exported pure projection
   * below). */
  private project(identity: TangledReviewIdentity): unknown {
    return projectTangledReviewIdentity(identity, this.context.repoDid);
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

  /** The memoized reviewed diff's files, the same reviewed revision
   * `getPrDiff` presents (#1690). The `ReadResult` contract reports failure
   * in-band: a failed derivation maps to `{ ok: false, error }` (the same
   * typed step error `getPrDiff` throws), never a fabricated empty file
   * list. */
  async listPrFiles(): Promise<ReadResult<unknown>> {
    try {
      return { ok: true, data: (await this.reviewedDiff()).files };
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

/** Project the resolved review identity into the GitHub-REST pull shape
 * consumed by `normalizePrIdentity` / `deriveIsFork` / `deriveDraftState` /
 * `canonicalPullRequest`, mirroring the Forgejo adapter's discipline:
 * never fabricate — unavailable strings are `""`, unknown optionals are
 * omitted, and the numeric `number` is never synthesized.
 *
 * The CURRENT record model anchors the projection on trusted knot state:
 * `head.sha` is the selected patch revision's `head.oid` (knot-written,
 * immutable — the reviewed head the #1165 publication proof compares
 * against), `base.sha` its `base.oid`. The patch's optional `source`
 * fills the head branch/repo; a source-less revision leaves them empty,
 * and `deriveIsFork` treats an empty head repo as a fork (fail closed).
 * `state` maps the ticket enum onto the GitHub-REST family: a `completed`
 * (merged) ticket reads `closed`, like both other forges. Exported for
 * the projection's own tests; the adapter delegates to it. */
export function projectTangledReviewIdentity(identity: TangledReviewIdentity, repoDid: string | undefined): unknown {
  const ticket = identity.ticketValue;
  const title = markdownText(ticket.title);
  const body = markdownText(ticket.body);
  const pr: Record<string, unknown> = {
    title,
    body,
    // `completed` is Tangled's merged state; both GitHub and Forgejo
    // report a merged pull as `closed`, and the #1298 state doctrine
    // accepts only open/closed as authoritative.
    state: identity.state === "completed" ? "closed" : identity.state ?? "",
    user: { login: strField(ticket["x-tngl-editor"]) ?? "" },
    head: {
      sha: identity.headOid,
      ref: identity.sourceBranch ?? "",
      repo: { full_name: identity.sourceRepoDid ?? "" },
    },
    base: {
      sha: identity.baseOid,
      ref: identity.targetBranch ?? "",
      repo: { full_name: repoDid ?? "" },
    },
    merged_at: null,
    created_at: strField(ticket.createdAt) ?? null,
    // The canonical AT-URI is the stable reference; the knot web route is
    // unknown and must not be invented.
    url: identity.ticketUri,
    html_url: identity.ticketUri,
    labels: labelNames(ticket),
    // Tangled has no draft concept: the ticket lexicon carries no draft
    // flag and a Tangled pull is never a draft, so `false` is the model's
    // honest answer — omitting it would fail every run closed as
    // `pr-draft-unknown` on a forge that cannot express the bit.
    draft: false,
  };
  // `number` is intentionally absent: Tangled has no numeric identity
  // (the ticket rkey is the reference), and `canonicalPullRequest`
  // already coerces a missing number to 0 — we never synthesize one.
  return pr;
}

/** Tangled markup fields are lexicon unions of plain text or the
 * `org.tangled.markup.markdown`/`inline` objects (`{text, …}`): extract the
 * text, never guess beyond it. */
function markdownText(value: unknown): string {
  if (typeof value === "string") return value;
  return strField((value as Record<string, unknown> | undefined)?.text) ?? "";
}

function strField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `tangledLabels` are `org.tangled.label.defs#labelToken` unions; project
 * the names of the object shape and ignore anything else (never fabricate
 * label entries). */
function labelNames(ticket: Record<string, unknown>): string[] {
  const labels = ticket.tangledLabels;
  if (!Array.isArray(labels)) return [];
  const names: string[] = [];
  for (const label of labels) {
    const name = strField((label as Record<string, unknown> | undefined)?.name);
    if (name !== undefined) names.push(name);
  }
  return names;
}
