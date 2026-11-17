import type { FetchLike } from "./http.js";
import type {
  CommentPostResult,
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
import { parseTangledAtUri } from "./tangled-bobbin.js";
import type { TangledReviewIdentity } from "./tangled-ticket.js";
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
  /** #1695 TOCTOU: the REVIEWED identity — the ticket/patch lineage the
   * review actually ran against, carried from the read path (the adapter
   * persists it into the run directory; `buildPublishApi` reads it back).
   * This is the ONLY write identity: the managed record binds to THIS
   * ticket, never to an independently re-resolved one — a replacement
   * ticket that happens to share the reviewed commit SHA must never
   * inherit the review. Absent → publication refuses (fail closed): without
   * reviewed-identity provenance there is nothing this seam may write onto. */
  reviewedIdentity?: TangledReviewIdentity | undefined;
  /** #588: a FRESH read of the pull's current head, for the #451
   * publication-boundary re-check. On Tangled this read MUST be bound to
   * the reviewed ticket's lineage (`readReviewedTicketCurrentHead`) — a
   * branch-tuple re-resolution would let a replacement ticket sharing the
   * reviewed SHA pass the guard. Absent → the current head is unknown and
   * publication is refused (fail closed). The launch-time
   * `TANGLED_PR_SOURCE_SHA` is NEVER used for this: it is the head THIS run
   * reviewed, not the head the pull has now. */
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

  /** #589: Tangled has no native review objects at all — nothing to dismiss,
   * minimize, delete, or resolve threads for. The managed top-level record is
   * updated IN PLACE by `upsertStickyComment`, so a superseded managed body
   * never stays visible alongside a newer one and no hide mechanism is
   * needed. Declared explicitly (rather than left absent) so the capability
   * seam reports "this forge cannot delete reviews" as a stated degradation,
   * not an untyped gap. */
  readonly supersededReviewDeletion: NativeReviewSurface = {
    supported: false,
    reason: "Tangled has no native reviews to delete: the managed top-level record is updated in place, so no superseded body stays visible",
  };

  /** #588: why the current pull head is unknown on Tangled — the #451
   * publication-boundary re-check needs the knot patch-record read
   * (#1165), so the publish step says so instead of the generic
   * "could not re-fetch" wording. */
  readonly currentHeadUnavailableReason = "Tangled current head unavailable: the knot patch-record read (org.tangled.review.patch) returned no trustworthy head for the REVIEWED ticket's lineage — the reviewed ticket must still be open with its reviewed patch revision still newest";

  private readonly context: TangledContext;
  private readonly atproto: TangledAtprotoClient;
  /** #1695 TOCTOU: the reviewed identity — the ONLY write identity. */
  private readonly reviewedIdentity: TangledReviewIdentity | undefined;
  /** #588: the fresh current-head read; absent → the current head is
   * unknown and publication fails closed. */
  private readonly currentHeadSha: (() => Promise<string | null>) | undefined;

  constructor(options: TangledPublishApiOptions) {
    this.context = options.context;
    this.atproto = options.atproto;
    this.reviewedIdentity = options.reviewedIdentity;
    this.currentHeadSha = options.currentHeadSha;
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
   * The head comes only from an injected fresh reader (#1165:
   * `src/platform/tangled-head.ts` reads the knot's
   * `org.tangled.review.patch` records — the trusted source). On the
   * CURRENT record model (#1690) those records carry the trusted
   * `head.oid` per immutable revision, and the reviewed head the marker
   * carries is the resolved revision's `head.oid` — so this fresh read is
   * the same-revision check: a resubmission mid-run makes the newest
   * revision disagree with the reviewed head and publication refuses. An
   * absent reader (or a failed, empty, or non-string read) yields `null`:
   * the caller then refuses to publish (fail closed) rather than publishing
   * a possibly stale review.
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
   * resolved review identity (#1690: one ticket + its newest immutable
   * patch revision; the record binds to the ticket AT-URI). Deterministic
   * and fail closed:
   * - zero identity-matching records → create;
   * - one marker-matching record → update in place (same rkey);
   * - one identity-matching record without the current marker → stale
   *   marker format drift on the SAME managed record: update in place
   *   (same rkey);
   * - more than one marker-matching record, or more than one
   *   identity-matching record with no marker match → ambiguous, no
   *   mutation.
   */
  async upsertStickyComment(marker: string, body: string): Promise<StickyResult> {
    if (typeof marker !== "string" || marker === "") {
      return { ok: false, created: false, error: "upsertStickyComment requires a non-empty marker" };
    }
    if (typeof body !== "string" || body === "") {
      return { ok: false, created: false, error: "upsertStickyComment requires a non-empty body" };
    }

    // #1695 TOCTOU: the write identity is the REVIEWED identity, carried
    // from the read path. This seam never re-resolves one: an independent
    // resolution could land on a different ticket that merely shares the
    // reviewed commit SHA, publishing the T1 review onto T2.
    const identity = this.reviewedIdentity;
    if (identity === undefined) {
      return {
        ok: false,
        created: false,
        error: "no reviewed Tangled identity was carried from the review path; refusing to publish onto an independently resolved ticket (fail closed)",
      };
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

      // A record is a candidate iff it points at the resolved ticket; wrong
      // reviewer identity and a stale repo binding make it invisible (not
      // ours, or bound to a different repo), and an unattributable record is
      // ignored rather than adopted.
      const pullMatching = listed.filter(({ value }) => {
        if (value.pull !== identity.ticketUri) return false;
        if (sessionDid === undefined) return false;
        if (typeof value.reviewer !== "string" || value.reviewer !== sessionDid) return false;
        return value.pullRepoDid === this.context.repoDid;
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
          error: `ambiguous managed review: ${markerMatching.length} marker-matching records exist for ticket ${identity.ticketUri}`,
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
          error: `ambiguous managed review: ${pullMatching.length} identity-matching records exist for ticket ${identity.ticketUri} and none matches the current marker`,
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

  /** The managed record value (#1690: bound to the resolved TICKET uri, with
   * `sourceSha` carrying the resolved patch revision's trusted `head.oid` —
   * the reviewed head, identical to what the marker publishes, so the
   * #1165 fresh-head comparison is the same-revision check). Unknown
   * optional fields are OMITTED (never `undefined`) so the serialized
   * record carries no undefined values. */
  private buildRecord(
    identity: TangledReviewIdentity,
    sessionDid: string | undefined,
    body: string,
    createdAt: string,
  ): ManagedReviewRecord {
    if (sessionDid === undefined) {
      throw new Error("AT-Proto session has no DID to attribute the managed review record to");
    }
    if (this.context.repoDid === undefined || this.context.repoDid === "") {
      throw new Error("resolved review identity carries no repository DID to bind the managed record to");
    }
    const record: ManagedReviewRecord = {
      $type: TANGLED_MANAGED_REVIEW_COLLECTION,
      pull: identity.ticketUri,
      pullRepoDid: this.context.repoDid,
      reviewer: sessionDid,
      body,
      createdAt,
    };
    if (identity.ticketCid !== undefined && identity.ticketCid !== "") record.pullCid = identity.ticketCid;
    record.sourceSha = identity.headOid;
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

  /** #763: Tangled has no plain top-level comment surface — the only record it
   * owns is the managed review, so a conversational follow-up reply cannot be
   * posted there. Declared as an explicit degradation, mirroring the other
   * unsupported write surfaces. */
  async postIssueComment(_body: string): Promise<CommentPostResult> {
    return { ok: false, created: false, error: "plain conversation comments are not supported on Tangled" };
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
