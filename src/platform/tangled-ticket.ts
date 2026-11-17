import { openSync, closeSync, fstatSync, readFileSync, writeFileSync, renameSync, constants } from "node:fs";
import type { FetchLike } from "./http.js";
import { parseTangledAtUri, TangledResolverError } from "./tangled-bobbin.js";
import {
  knotBase,
  listCollectionRecords,
  TANGLED_OID_RE,
  TANGLED_PATCH_COLLECTION,
  TANGLED_TICKET_COLLECTION,
  type ReadTangledCurrentHeadOptions,
} from "./tangled-head.js";

const REVIEWED_IDENTITY_ARTIFACT = "tangled-reviewed-identity.json";
const MAX_REVIEWED_IDENTITY_BYTES = 8 * 1024;
import type { TangledContext } from "./tangled.js";

/**
 * Tangled review-identity resolution on the CURRENT record model (#1690
 * protocol pivot; the pre-2026-10-28 `sh.tangled.repo.pull` model is
 * obsolete and must not be completed — see the corrected #1690).
 *
 * Current Tangled models a pull request as:
 * - `org.tangled.track.ticket` in the REPOSITORY account on its knot (a
 *   pull request is a ticket with `targetBranch` set);
 * - immutable `org.tangled.review.patch` revisions in the same account
 *   (record key = the record's own CID), each carrying trusted
 *   `base.oid`/`head.oid` commit ids (40 or 64 hex — SHA-1 migrated knots,
 *   SHA-256 new ones), an optional `source {repo, branch}`, and a `ticket`
 *   reference; each resubmission adds one patch. Patches are written only
 *   by the knot's `org.tangled.review.submitPatch`, which fetches the head
 *   from the source repository first — so `head.oid` is TRUSTED state, the
 *   exact records the #1165 publication head proof reads.
 *
 * Both collections are read from the repository account through the knot's
 * standard `com.atproto.repo.listRecords` (bounded by the one pagination
 * loop in tangled-head.ts). The knot is the record authority for tickets
 * and patches; Bobbin's `org.tangled.repo.listPulls` remains the appview
 * listing surface but its output schema is not a published lexicon, so the
 * fail-closed production resolution reads the authoritative records
 * instead — the same surface and the same selection doctrine as the
 * #1165 trusted-head reader, and one wire boundary fewer.
 *
 * The resolution yields ONE resolved patch revision as the REVIEW IDENTITY:
 * the reviewed diff/files are derived from that revision's trusted
 * base/head, and the managed review record binds to the same ticket with
 * the same `head.oid` as its reviewed head — so reviewed content and the
 * publication-boundary head proof cannot describe different rounds (a
 * resubmission mid-run makes the fresh #1165 head read disagree with the
 * reviewed head and publication fails closed).
 *
 * Fail-closed model: every ambiguity (zero/multiple candidate tickets, a
 * tie between patches, malformed ticket or patch state, an unreadable
 * knot) throws a `TangledResolverError` — never a guess, never a fallback
 * to the launch-time context beyond the documented ticket disambiguation.
 */

/** The resolved review identity: one ticket plus ONE immutable patch
 * revision. `headOid`/`baseOid` are trusted knot state; `sourceBranch` /
 * `sourceRepoDid` are present only when the patch record names a source. */
export interface TangledReviewIdentity {
  ticketUri: string;
  ticketCid: string | undefined;
  ticketRkey: string;
  ticketValue: Record<string, unknown>;
  patchUri: string;
  patchCid: string | undefined;
  patchValue: Record<string, unknown>;
  baseOid: string;
  headOid: string;
  targetBranch: string | undefined;
  sourceBranch: string | undefined;
  sourceRepoDid: string | undefined;
  state: string | undefined;
}

export interface ResolveTangledReviewIdentityOptions {
  fetchImpl?: FetchLike | undefined;
  token?: string | undefined;
  timeoutMs?: number | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function oid(value: unknown, what: string, patchUri: string): string {
  const record = asRecord(value);
  const id = record === undefined ? undefined : str(record.oid);
  if (id === undefined || !TANGLED_OID_RE.test(id)) {
    throw new TangledResolverError(
      "invalid-response",
      `patch ${patchUri} carries no usable ${what} commit id (org.tangled.git.oid)`,
    );
  }
  return id.toLowerCase();
}

/** The ticket a patch belongs to: the lexicon names the ticket by record
 * key; in-the-wild records may carry the full AT-URI, so both forms match
 * (the same defensive rule the #1165 head selector applies). */
function patchMatchesTicket(patchValue: Record<string, unknown>, ticket: { rkey: string; uri: string }): boolean {
  const ticketField = str(patchValue.ticket);
  if (ticketField === undefined) {
    // Fail closed on malformed patch state: a patch without a usable
    // `ticket` key cannot be proven to belong to another pull, so ignoring
    // it could let a stale revision masquerade as newest.
    throw new TangledResolverError(
      "invalid-response",
      `a ${TANGLED_PATCH_COLLECTION} record carries no usable ticket reference`,
    );
  }
  return ticketField === ticket.rkey || ticketField === ticket.uri;
}

/** The NEWEST valid patch revision for one ticket, or `null` when the
 * ticket has none. Selection is fail-closed: a malformed patch for THIS
 * ticket (missing ticket key, unusable createdAt, unusable base/head) throws
 * rather than being skipped, and a createdAt tie between different patch
 * records is ambiguous. */
function selectNewestPatch(
  items: readonly { uri: string; cid: string | undefined; value: Record<string, unknown> }[],
  ticket: { rkey: string; uri: string },
): { uri: string; cid: string | undefined; value: Record<string, unknown> } | null {
  let best: { uri: string; cid: string | undefined; value: Record<string, unknown>; time: number } | undefined;
  for (const item of items) {
    if (!patchMatchesTicket(item.value, ticket)) continue;
    const createdAt = str(item.value.createdAt);
    if (createdAt === undefined) {
      throw new TangledResolverError(
        "invalid-response",
        `patch ${item.uri} for ticket ${ticket.uri} carries no usable createdAt`,
      );
    }
    const time = Date.parse(createdAt);
    if (!Number.isFinite(time)) {
      throw new TangledResolverError(
        "invalid-response",
        `patch ${item.uri} for ticket ${ticket.uri} carries a malformed createdAt`,
      );
    }
    // Validate both commit ids on every candidate: a malformed NEWEST
    // revision must fail closed, never silently fall back to an older one.
    const patchUri = item.uri;
    oid(item.value.base, "base", patchUri);
    oid(item.value.head, "head", patchUri);
    if (best === undefined || time > best.time) {
      best = { uri: item.uri, cid: item.cid, value: item.value, time };
    } else if (time === best.time && item.uri !== best.uri) {
      throw new TangledResolverError(
        "ambiguous",
        `ambiguous newest patch for ticket ${ticket.uri}: ${item.uri} and ${best.uri} tie on createdAt`,
      );
    }
  }
  return best ?? null;
}

/**
 * Resolve the run's review identity: the ONE open pull-request ticket
 * matching the context (target branch; when several open pulls target the
 * same branch, the unique candidate whose trusted patch history contains
 * the launch-time reviewed head — the same documented disambiguation rule
 * the #1165 head reader applies), plus its newest immutable patch revision.
 *
 * Throws `TangledResolverError` on any failure: missing knot host or repo
 * DID ("config"), an unreadable knot ("read-failed"), zero or multiple
 * candidates ("no-match"/"ambiguous"), malformed records
 * ("invalid-response").
 */
export async function resolveTangledReviewIdentity(
  ctx: TangledContext,
  options?: ResolveTangledReviewIdentityOptions,
): Promise<TangledReviewIdentity> {
  const knot = knotBase(ctx);
  if (knot === null) {
    throw new TangledResolverError(
      "config",
      "Tangled review resolution requires the repository knot host (TANGLED_REPO_KNOT): tickets and patches live in the repository account on its knot",
    );
  }
  if (ctx.repoDid === undefined || ctx.repoDid.trim() === "") {
    throw new TangledResolverError(
      "config",
      "cannot resolve Tangled review: repository DID (TANGLED_REPO_REPO_DID) is required",
    );
  }
  const readOptions: ReadTangledCurrentHeadOptions = {
    fetchImpl: options?.fetchImpl,
    timeoutMs: options?.timeoutMs,
    ...(options?.token !== undefined ? { token: options.token } : {}),
  };

  const tickets = await listCollectionRecords(ctx, TANGLED_TICKET_COLLECTION, readOptions);
  if (tickets === null) {
    throw new TangledResolverError("read-failed", `unreadable ticket collection on knot ${knot.origin}`);
  }
  // A pull request is a ticket with `targetBranch` set. Candidates must be
  // open and, when the context names a target branch, target it.
  const candidates = tickets.filter((t) => {
    if (str(t.value.state) !== "open") return false;
    const targetBranch = str(t.value.targetBranch);
    if (targetBranch === undefined) return false;
    if (ctx.targetBranch !== undefined && targetBranch !== ctx.targetBranch) return false;
    return true;
  });
  if (candidates.length === 0) {
    throw new TangledResolverError(
      "no-match",
      `no open Tangled pull-request ticket targeting ${ctx.targetBranch ?? "<any branch>"} in repo ${ctx.repoDid}`,
    );
  }

  const patches = await listCollectionRecords(ctx, TANGLED_PATCH_COLLECTION, readOptions);
  if (patches === null) {
    throw new TangledResolverError("read-failed", `unreadable patch collection on knot ${knot.origin}`);
  }

  // Disambiguation order (fail closed, same doctrine as the #1165 reader):
  // a single candidate is the correlation; multiple candidates resolve only
  // through the launch-time reviewed head appearing in exactly one
  // candidate's trusted patch history — never through branch-name matching
  // alone (multiple open pulls can share source branches, and a patch's
  // `source` is optional).
  let ticket: { rkey: string; uri: string; value: Record<string, unknown>; cid: string | undefined };
  if (candidates.length === 1) {
    const only = candidates[0]!;
    ticket = { rkey: only.rkey, uri: only.uri, value: only.value, cid: only.cid };
  } else {
    const reviewed = typeof ctx.sourceSha === "string" ? ctx.sourceSha.trim().toLowerCase() : "";
    if (reviewed === "" || !TANGLED_OID_RE.test(reviewed)) {
      throw new TangledResolverError(
        "ambiguous",
        `ambiguous: ${candidates.length} open Tangled pull-request tickets target ${ctx.targetBranch ?? "<any branch>"} and the context carries no reviewed head to disambiguate (TANGLED_PR_SOURCE_SHA)`,
      );
    }
    const matching: typeof candidates = [];
    for (const candidate of candidates) {
      let newest: { uri: string; cid: string | undefined; value: Record<string, unknown> } | null = null;
      try {
        newest = selectNewestPatch(patches, { rkey: candidate.rkey, uri: candidate.uri });
      } catch (error) {
        if (error instanceof TangledResolverError && error.kind === "ambiguous") throw error;
        continue; // a malformed patch history cannot correlate its ticket
      }
      if (newest === null) continue;
      const inHistory = patches.some((item) => {
        if (!patchMatchesTicketForHistory(item.value, candidate)) return false;
        const head = asRecord(item.value.head);
        const headOid = head === undefined ? undefined : str(head.oid);
        return headOid !== undefined && headOid.toLowerCase() === reviewed;
      });
      if (inHistory) matching.push(candidate);
    }
    if (matching.length !== 1) {
      throw new TangledResolverError(
        "ambiguous",
        `ambiguous: ${matching.length} of ${candidates.length} open Tangled pull-request tickets target ${ctx.targetBranch ?? "<any branch>"} with the reviewed head ${reviewed.slice(0, 12)} in their patch history`,
      );
    }
    const only = matching[0]!;
    ticket = { rkey: only.rkey, uri: only.uri, value: only.value, cid: only.cid };
  }

  const patch = selectNewestPatch(patches, { rkey: ticket.rkey, uri: ticket.uri });
  if (patch === null) {
    throw new TangledResolverError(
      "no-match",
      `ticket ${ticket.uri} has no ${TANGLED_PATCH_COLLECTION} revision to review`,
    );
  }

  const ticketUriParsed = parseTangledAtUri(ticket.uri);
  if (ticketUriParsed.collection !== TANGLED_TICKET_COLLECTION || ticketUriParsed.did !== ctx.repoDid.trim()) {
    throw new TangledResolverError(
      "invalid-response",
      `ticket ${ticket.uri} is not a ${TANGLED_TICKET_COLLECTION} in repo ${ctx.repoDid}`,
    );
  }

  const patchValue = patch.value;
  const source = asRecord(patchValue.source);
  return {
    ticketUri: ticket.uri,
    ticketCid: ticket.cid,
    ticketRkey: ticket.rkey,
    ticketValue: ticket.value,
    patchUri: patch.uri,
    patchCid: patch.cid,
    patchValue,
    baseOid: oid(patchValue.base, "base", patch.uri),
    headOid: oid(patchValue.head, "head", patch.uri),
    targetBranch: str(ticket.value.targetBranch),
    sourceBranch: source === undefined ? undefined : str(source.branch),
    sourceRepoDid: source === undefined ? undefined : str(source.repo),
    state: str(ticket.value.state),
  };
}

/** The history-correlation half of the multi-candidate disambiguation: a
 * lenient match (malformed patch records are skipped rather than thrown)
 * because correlation must only ever NARROW the candidates. */
function patchMatchesTicketForHistory(
  patchValue: Record<string, unknown>,
  ticket: { rkey: string; uri: string },
): boolean {
  const ticketField = str(patchValue.ticket);
  return ticketField === ticket.rkey || ticketField === ticket.uri;
}

// ── reviewed-identity publication handoff (#1695 TOCTOU) ────────────────

/**
 * The reviewed identity as the publication boundary consumes it: the
 * invariant is that the Tangled identity that was REVIEWED is the identity
 * that is PUBLISHED. The read adapter persists its resolved identity into
 * the run directory the moment it resolves ({@link
 * writeReviewedTangledIdentity}, first writer wins — the engine's adapter
 * is the reviewer, so its identity is the reviewed one); the publish seam
 * reads it back ({@link readReviewedTangledIdentityFromRunDir}) and binds
 * BOTH the managed record and the fresh knot freshness read to that exact
 * ticket/patch lineage ({@link readReviewedTicketCurrentHead}). Without the
 * artifact there is no provenance for what was reviewed and publication
 * fails closed — a replacement ticket that happens to share the reviewed
 * commit SHA must never inherit the review.
 */

/** Persist the resolved review identity into the run directory. Best-effort
 * and FIRST-WRITER-WINS: the write never throws (a failed write surfaces at
 * the publication boundary as a missing artifact, which fails closed), and
 * an existing artifact is never overwritten — the first adapter to resolve
 * in a run is the reviewer's adapter, so a later-constructed adapter (e.g. a
 * publish-side diff provider) can never re-resolve a different ticket into
 * the reviewed provenance. */
export function writeReviewedTangledIdentity(runDir: string, identity: TangledReviewIdentity): void {
  if (runDir === "" || identity.ticketUri === "" || identity.patchUri === "") return;
  try {
    const target = `${runDir}/${REVIEWED_IDENTITY_ARTIFACT}`;
    // O_EXCL-style first-writer-wins via the existence check; the run
    // directory is private to this run (#838), so no concurrent writer
    // exists outside the process.
    let fd: number;
    try {
      fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
    } catch {
      fd = -1;
    }
    if (fd !== -1) {
      closeSync(fd);
      return;
    }
    const payload = {
      ticket_uri: identity.ticketUri,
      ...(identity.ticketCid !== undefined ? { ticket_cid: identity.ticketCid } : {}),
      patch_uri: identity.patchUri,
      ...(identity.patchCid !== undefined ? { patch_cid: identity.patchCid } : {}),
      base_oid: identity.baseOid,
      head_oid: identity.headOid,
      ...(identity.targetBranch !== undefined ? { target_branch: identity.targetBranch } : {}),
      ...(identity.sourceBranch !== undefined ? { source_branch: identity.sourceBranch } : {}),
      ...(identity.sourceRepoDid !== undefined ? { source_repo_did: identity.sourceRepoDid } : {}),
    };
    const staged = `${runDir}/.${REVIEWED_IDENTITY_ARTIFACT}.tmp`;
    writeFileSync(staged, JSON.stringify(payload));
    renameSync(staged, target);
  } catch {
    // Best-effort: the publication boundary fails closed on a missing
    // artifact, never on a failed diagnostic write.
  }
}

function artifactOid(value: unknown, what: string): string | null {
  if (typeof value !== "string" || !TANGLED_OID_RE.test(value)) return null;
  return value.toLowerCase();
}

/** Read the reviewed identity back from the run directory. Returns `null`
 * on ANY malformation — a missing, unreadable, oversized, or shape-invalid
 * artifact proves nothing about what was reviewed, and the publication
 * boundary fails closed on `null`. */
export function readReviewedTangledIdentityFromRunDir(runDir: string | undefined): TangledReviewIdentity | null {
  if (runDir === undefined || runDir === "") return null;
  let fd: number;
  try {
    fd = openSync(`${runDir}/${REVIEWED_IDENTITY_ARTIFACT}`, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  let raw: string;
  try {
    if (!fstatSync(fd).isFile()) return null;
    const bytes = readFileSync(fd);
    if (bytes.byteLength > MAX_REVIEWED_IDENTITY_BYTES) return null;
    raw = bytes.toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const ticketUri = typeof parsed.ticket_uri === "string" ? parsed.ticket_uri : "";
  const patchUri = typeof parsed.patch_uri === "string" ? parsed.patch_uri : "";
  if (ticketUri === "" || patchUri === "") return null;
  let ticket: ReturnType<typeof parseTangledAtUri>;
  let patch: ReturnType<typeof parseTangledAtUri>;
  try {
    ticket = parseTangledAtUri(ticketUri);
    patch = parseTangledAtUri(patchUri);
  } catch {
    return null;
  }
  if (ticket.collection !== TANGLED_TICKET_COLLECTION || patch.collection !== TANGLED_PATCH_COLLECTION) return null;
  if (ticket.did !== patch.did) return null;
  const baseOid = artifactOid(parsed.base_oid, "base");
  const headOid = artifactOid(parsed.head_oid, "head");
  if (baseOid === null || headOid === null) return null;
  const ticketCid = typeof parsed.ticket_cid === "string" && parsed.ticket_cid !== "" ? parsed.ticket_cid : undefined;
  const patchCid = typeof parsed.patch_cid === "string" && parsed.patch_cid !== "" ? parsed.patch_cid : undefined;
  const targetBranch = typeof parsed.target_branch === "string" && parsed.target_branch !== "" ? parsed.target_branch : undefined;
  const sourceBranch = typeof parsed.source_branch === "string" && parsed.source_branch !== "" ? parsed.source_branch : undefined;
  const sourceRepoDid = typeof parsed.source_repo_did === "string" && parsed.source_repo_did !== "" ? parsed.source_repo_did : undefined;
  return {
    ticketUri,
    ticketCid,
    ticketRkey: ticket.rkey,
    ticketValue: {},
    patchUri,
    patchCid,
    patchValue: {},
    baseOid,
    headOid,
    targetBranch,
    sourceBranch,
    sourceRepoDid,
    state: undefined,
  };
}

/**
 * The FRESH knot read, bound to the reviewed ticket's lineage (#1695
 * TOCTOU): this is the publication-boundary freshness check, and it is
 * pinned to the ticket that was reviewed — never re-resolved against
 * whatever ticket now matches the branch tuple. Returns the trusted
 * current head only when ALL of the following hold fresh at the knot:
 * - the reviewed ticket still exists in the repository account and is
 *   still `open` (a closed/merged/completed ticket refuses — its review
 *   conversation is settled and a replacement ticket is a different
 *   conversation);
 * - the ticket's NEWEST immutable patch revision is still the reviewed
 *   revision (same AT-URI; a resubmission mid-run refuses);
 * - that revision's trusted `head.oid` still equals the reviewed head.
 * Any other outcome — including a DIFFERENT ticket pointing at the same
 * commit SHA — is `null`, and the caller refuses to publish.
 */
export async function readReviewedTicketCurrentHead(
  ctx: TangledContext,
  reviewed: TangledReviewIdentity,
  options?: ReadTangledCurrentHeadOptions,
): Promise<string | null> {
  try {
    const tickets = await listCollectionRecords(ctx, TANGLED_TICKET_COLLECTION, options);
    if (tickets === null) return null;
    const current = tickets.find((t) => t.uri === reviewed.ticketUri || t.rkey === reviewed.ticketRkey);
    if (current === undefined) return null;
    if (str(current.value.state) !== "open") return null;
    const patches = await listCollectionRecords(ctx, TANGLED_PATCH_COLLECTION, options);
    if (patches === null) return null;
    const newest = selectNewestPatch(patches, { rkey: reviewed.ticketRkey, uri: reviewed.ticketUri });
    if (newest === null || newest.uri !== reviewed.patchUri) return null;
    const head = oid(newest.value.head, "head", newest.uri);
    return head === reviewed.headOid.toLowerCase() ? head : null;
  } catch {
    return null;
  }
}
