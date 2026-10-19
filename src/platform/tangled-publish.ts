import type { FetchLike } from "./http.js";
import type {
  ManagedInlineCommentRef,
  NativeReviewRequest,
  NativeReviewSurface,
  PublishCommentRef,
  PublishPlatformApi,
  PublishPlatformName,
  PublishReviewRef,
  ReviewerRequestResult,
  StickyResult,
  ThreadQueryResult,
} from "./publish-api.js";
import { TangledAtprotoClient } from "./tangled-atproto.js";
import {
  parseTangledAtUri,
  resolveTangledPull,
  TangledResolverError,
  type TangledPullIdentity,
} from "./tangled-bobbin.js";
import type { TangledContext } from "./tangled.js";

/**
 * Tangled publish adapter (#588): publishes and updates ONE managed
 * top-level review record per pull via AT-Proto, in the CI bot's own repo.
 *
 * The record contract is EXPERIMENTAL: upstream Tangled comment surfaces are
 * still evolving (see the #564 umbrella), so the managed record lives under
 * the locally-namespaced collection `dev.prreviewer.review` in the bot's own
 * AT-Proto repo (repo = session DID) rather than pretending at a native
 * Tangled comment shape. The record is the sticky-review seam: the body is
 * the full published body the caller builds (including the metadata marker)
 * — this module generates no markdown and matches only the marker it is
 * given.
 *
 * Boundaries:
 * - Tangled is NEVER routed through the GitHub or Forgejo publish APIs; this
 *   adapter is the only publication surface for a Tangled-resolved
 *   environment, and every capability Tangled has no native equivalent for
 *   degrades explicitly (mirroring the Forgejo no-op style).
 * - This module performs NO Python invocation: it is pure TypeScript over
 *   the `TangledAtprotoClient` (#837) and the canonical pull resolver
 *   (#584), which already carry the secret-handling and fail-closed rules.
 * - Decisions are deterministic and fail closed: an ambiguous managed
 *   record set never mutates, and a resolution failure is reported as a
 *   `StickyResult` error rather than thrown at construction time.
 */

/** EXPERIMENTAL (#588, #564 umbrella): locally-namespaced collection the
 * bot owns. Upstream Tangled comment surfaces are still evolving, so this
 * NSID is not a Tangled vocabulary type yet. */
export const TANGLED_MANAGED_REVIEW_COLLECTION = "dev.prreviewer.review";

/** Bounded listing: at most 10 `listRecords` pages of at most 100 records
 * each. Hitting the cap fails closed rather than silently ignoring older
 * managed records. */
const MAX_LIST_PAGES = 10;
const LIST_PAGE_LIMIT = 100;
const MAX_LISTED_RECORDS = 1000;

/** The shape of one managed review record as written by this module. */
interface ManagedReviewRecord {
  [key: string]: unknown;
  $type: typeof TANGLED_MANAGED_REVIEW_COLLECTION;
  pull: string;
  pullCid?: string;
  pullRepoDid: string;
  reviewer: string;
  sourceSha?: string;
  body: string;
  createdAt: string;
}

export interface TangledPublishApiOptions {
  context: TangledContext;
  atproto: TangledAtprotoClient;
  /** Injected transport for the Bobbin pull resolver (tests). */
  fetchImpl?: FetchLike | undefined;
  /** Per-request timeout forwarded to the Bobbin pull resolver. */
  timeoutMs?: number | undefined;
  /** #588: a FRESH read of the pull's current head, for the #451
   * publication-boundary re-check. Absent → the current head is unknown and
   * publication is refused (fail closed) until a trustworthy source exists.
   * The launch-time `TANGLED_PR_SOURCE_SHA` is NEVER used for this: it is
   * the head THIS run reviewed, not the head the pull has now. */
  currentHeadSha?: (() => Promise<string | null>) | undefined;
}

export class TangledPublishApi implements PublishPlatformApi {
  readonly platform = "tangled" as const;

  /** #588: Tangled has no native pull-review surface — the review event
   * and its inline review comments do not exist there. The publish step
   * therefore publishes the review body as the managed top-level AT-Proto
   * record and states the degradation explicitly. */
  readonly nativeReviewSurface: NativeReviewSurface = {
    supported: false,
    reason: "Tangled has no native pull-review surface",
  };

  /** #588: why the current pull head is unknown on Tangled — the #451
   * publication-boundary re-check can never be satisfied until a
   * trustworthy current-head source exists, so the publish step says so
   * instead of the generic "could not re-fetch" wording. */
  readonly currentHeadUnavailableReason = "Tangled has no trustworthy current-head source yet: the pull record exposes no head commit, and the round patch's declared head SHA is forgeable advisory metadata";

  private readonly context: TangledContext;
  private readonly atproto: TangledAtprotoClient;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly timeoutMs: number | undefined;
  /** #588: the fresh current-head read; absent → the current head is
   * unknown and publication fails closed. */
  private readonly currentHeadSha: (() => Promise<string | null>) | undefined;
  /** Memoized canonical pull resolution: at most one resolution per
   * instance. A rejection is memoized too and is reported deterministically
   * by `upsertStickyComment`, never thrown at construction. */
  private pullPromise: Promise<TangledPullIdentity> | undefined;

  constructor(options: TangledPublishApiOptions) {
    this.context = options.context;
    this.atproto = options.atproto;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
    this.currentHeadSha = options.currentHeadSha;
  }

  private resolvePull(): Promise<TangledPullIdentity> {
    this.pullPromise ??= resolveTangledPull(this.context, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
    return this.pullPromise;
  }

  /**
   * #588: the pull's CURRENT head for the #451 publication-boundary
   * re-check — read fresh, never echoed from the launch-time context.
   *
   * The launch-time `TANGLED_PR_SOURCE_SHA` (`context.sourceSha`) is the
   * head THIS run reviewed, so returning it here would compare two copies
   * of the same start-time context: a pull that advanced mid-run would
   * still get a stale publication. It is recorded in the managed record as
   * reviewed-head metadata (`buildRecord`), which is correct, but it is
   * never the current head.
   *
   * No trustworthy current-head source exists on Tangled yet:
   * `src/platform/tangled-bobbin.ts` documents that the pull record and the
   * read XRPC outputs (`getPull`/`listPulls`) expose NO head commit — it
   * lives only inside a round's gzipped patch blob — and
   * `src/platform/tangled-diff.ts` marks `declaredHeadSha` as ADVISORY,
   * forgeable metadata decoded from untrusted patch content that must never
   * be an authorization or exact-head input. So the head comes only from an
   * injected fresh reader, and an absent reader (or a failed, empty, or
   * non-string read) yields `null`: the caller then refuses to publish
   * (fail closed) rather than publishing a possibly stale review. The
   * trustworthy current-head read is tracked in #1165.
   */
  async getHeadSha(): Promise<string | null> {
    if (this.currentHeadSha === undefined) return null;
    try {
      const sha = await this.currentHeadSha();
      if (typeof sha !== "string") return null;
      const trimmed = sha.trim();
      return trimmed === "" ? null : trimmed;
    } catch {
      return null;
    }
  }

  /** #588: the CI bot's AT-Proto session DID, once a session exists; null
   * before the first authenticated call. */
  async authenticatedIdentity(): Promise<string | null> {
    return this.atproto.did ?? null;
  }

  async listIssueComments(): Promise<PublishCommentRef[]> {
    // #588/#589: Tangled has no native review surface.
    return [];
  }

  /**
   * Create or update the ONE managed top-level review record for the
   * resolved pull. Deterministic and fail closed:
   * - zero pull-matching records → create;
   * - one marker-matching record → update in place (same rkey);
   * - one pull-matching record without the current marker → stale marker
   *   format drift on the SAME managed record: update in place (same rkey);
   * - more than one marker-matching record, or more than one pull-matching
   *   record with no marker match → ambiguous, no mutation.
   */
  async upsertStickyComment(marker: string, body: string): Promise<StickyResult> {
    if (typeof marker !== "string" || marker === "") {
      return { ok: false, created: false, error: "upsertStickyComment requires a non-empty marker" };
    }
    if (typeof body !== "string" || body === "") {
      return { ok: false, created: false, error: "upsertStickyComment requires a non-empty body" };
    }

    let identity: TangledPullIdentity;
    try {
      identity = await this.resolvePull();
    } catch (error) {
      const kind = error instanceof TangledResolverError ? error.kind : "read-failed";
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, created: false, error: `Tangled pull resolution failed (${kind}): ${message}` };
    }

    try {
      const listed = await this.listAllManagedRecords();
      // The session DID is read only AFTER the listing: an authenticated
      // list call establishes the ATProto session, so `did` is defined here
      // even on the very first publication of the process (a fresh client
      // has no session yet, and reading it earlier made every first publish
      // fail — reviewer finding on this diff).
      const sessionDid = this.atproto.did;
      const createdAt = new Date().toISOString();
      const record = this.buildRecord(identity, sessionDid, body, createdAt);

      // A record is a candidate iff it points at the resolved pull; wrong
      // reviewer identity and a stale repo binding make it invisible (not
      // ours, or bound to a different repo), and an unattributable record is
      // ignored rather than adopted.
      const pullMatching = listed.filter(({ value }) => {
        if (value.pull !== identity.uri) return false;
        if (sessionDid === undefined) return false;
        if (typeof value.reviewer !== "string" || value.reviewer !== sessionDid) return false;
        return value.pullRepoDid === identity.repoDid;
      });
      const markerMatching = pullMatching.filter(({ value }) => typeof value.body === "string" && value.body.includes(marker));

      if (pullMatching.length === 0) {
        const { uri } = await this.atproto.createRecord(TANGLED_MANAGED_REVIEW_COLLECTION, record);
        return { ok: true, created: true, commentId: uri, updatedAt: createdAt };
      }
      if (markerMatching.length > 1) {
        return {
          ok: false,
          created: false,
          error: `ambiguous managed review: ${markerMatching.length} marker-matching records exist for pull ${identity.uri}`,
        };
      }
      if (markerMatching.length === 1) {
        const target = markerMatching[0];
        if (target === undefined) throw new Error("unreachable: markerMatching has exactly one entry");
        await this.putManagedRecord(target.uri, record);
        return { ok: true, created: false, commentId: target.uri, updatedAt: createdAt };
      }
      // No marker match: exactly one pull-matching record is expected drift
      // (marker format changed between runs) — update it in place. More than
      // one is ambiguous; never guess.
      if (pullMatching.length > 1) {
        return {
          ok: false,
          created: false,
          error: `ambiguous managed review: ${pullMatching.length} pull-matching records exist for pull ${identity.uri} and none matches the current marker`,
        };
      }
      const stale = pullMatching[0];
      if (stale === undefined) throw new Error("unreachable: pullMatching has exactly one entry");
      await this.putManagedRecord(stale.uri, record);
      return { ok: true, created: false, commentId: stale.uri, updatedAt: createdAt };
    } catch (error) {
      // TangledAtprotoError messages are already secret-redacted by the
      // client; anything else is sanitized the same way by passing only the
      // message forward (no raw objects, no stack traces).
      return {
        ok: false,
        created: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Cursor-paginated `listRecords` over the managed collection, bounded by
   * the page/record caps; exceeding either fails closed. */
  private async listAllManagedRecords(): Promise<
    Array<{ uri: string; value: Record<string, unknown> }>
  > {
    const records: Array<{ uri: string; value: Record<string, unknown> }> = [];
    let cursor: string | undefined;
    for (let page = 1; ; page += 1) {
      if (page > MAX_LIST_PAGES || records.length > MAX_LISTED_RECORDS) {
        throw new Error("managed review lookup exceeded the pagination cap");
      }
      const listOptions =
        cursor === undefined
          ? { limit: LIST_PAGE_LIMIT }
          : { limit: LIST_PAGE_LIMIT, cursor };
      const result = await this.atproto.listRecords(TANGLED_MANAGED_REVIEW_COLLECTION, listOptions);
      records.push(...result.records.map(({ uri, value }) => ({ uri, value })));
      if (result.cursor === undefined) break;
      cursor = result.cursor;
    }
    return records;
  }

  /** The managed record value. Unknown optional fields are OMITTED (never
   * `undefined`) so the serialized record carries no undefined values. */
  private buildRecord(
    identity: TangledPullIdentity,
    sessionDid: string | undefined,
    body: string,
    createdAt: string,
  ): ManagedReviewRecord {
    if (sessionDid === undefined) {
      throw new Error("AT-Proto session has no DID to attribute the managed review record to");
    }
    const record: ManagedReviewRecord = {
      $type: TANGLED_MANAGED_REVIEW_COLLECTION,
      pull: identity.uri,
      pullRepoDid: identity.repoDid,
      reviewer: sessionDid,
      body,
      createdAt,
    };
    if (identity.cid !== "") record.pullCid = identity.cid;
    if (this.context.sourceSha !== undefined) record.sourceSha = this.context.sourceSha;
    return record;
  }

  /** Overwrite the record at `uri`'s rkey, preserving the identity across
   * updates. */
  private async putManagedRecord(uri: string, record: ManagedReviewRecord): Promise<void> {
    const parsed = parseTangledAtUri(uri);
    await this.atproto.putRecord(TANGLED_MANAGED_REVIEW_COLLECTION, parsed.rkey, record);
  }

  async listReviews(): Promise<PublishReviewRef[]> {
    // #588/#589: Tangled has no native review surface.
    return [];
  }

  async listManagedInlineComments(
    _reviewIds: readonly string[],
  ): Promise<{ supported: boolean; complete: boolean; comments: ManagedInlineCommentRef[] }> {
    // #588/#589: Tangled has no native review surface.
    return { supported: false, complete: false, comments: [] };
  }

  async retireInlineComment(_reviewId: string, _commentId: string): Promise<boolean> {
    // #588/#589: Tangled has no native review surface.
    return false;
  }

  async createReview(_request: NativeReviewRequest): Promise<{ ok: boolean; error?: string }> {
    // #588/#589: Tangled has no native review surface.
    return { ok: false, error: "native reviews are not supported on Tangled" };
  }

  async dismissReview(_reviewId: number | string, _message: string): Promise<boolean> {
    // #588/#589: Tangled has no native review surface.
    return false;
  }

  async minimizedReviewIds(): Promise<string[]> {
    // #588/#589: Tangled has no native review surface.
    return [];
  }

  async minimizeReview(_nodeId: string): Promise<boolean> {
    // #588/#589: Tangled has no native review surface.
    return false;
  }

  async unresolvedSupersededThreads(_managedIds: number[]): Promise<ThreadQueryResult> {
    // #588/#589: Tangled has no native review surface.
    return { ok: false, threads: [], hasNextPage: false, error: "no thread API on Tangled" };
  }

  async resolveThread(_threadId: string): Promise<boolean> {
    // #588/#589: Tangled has no native review surface.
    return false;
  }

  async removeLabel(_label: string): Promise<boolean> {
    // #588/#589: Tangled has no native review surface.
    return false;
  }

  async requestReviewers(_users: readonly string[], _teams: readonly string[]): Promise<ReviewerRequestResult> {
    // #588/#589: Tangled has no native review surface.
    return {
      ok: false,
      supported: false,
      requestedUsers: [],
      requestedTeams: [],
      alreadyRequestedUsers: [],
      alreadyRequestedTeams: [],
      error: "reviewer requests are not supported on Tangled",
    };
  }
}
