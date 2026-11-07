import { requestJson, type FetchLike } from "./http.js";
import { parseTangledAtUri, type TangledPullIdentity } from "./tangled-bobbin.js";
import type { TangledContext } from "./tangled.js";

/**
 * Trusted current-head read for Tangled pulls (#1165).
 *
 * Source: the repository knot's `com.atproto.repo.listRecords` over the
 * `org.tangled.review.patch` collection in the repo account. Each patch
 * record is immutable, created only by the knot's
 * `org.tangled.review.submitPatch` endpoint (which fetches the source
 * repository head before creating the record), and carries
 * `{ticket, base, head, createdAt}` where `head` is an
 * `org.tangled.git.oid` (`{oid}` — the commit SHA).
 *
 * The current head is `head.oid` of the NEWEST patch revision for this
 * ticket (by `createdAt`). A tie on `createdAt` between different heads is
 * ambiguous and fails closed.
 *
 * Fail-closed contract: any missing config, transport/HTTP/parse failure,
 * empty/malformed/ambiguous patch set, or non-40-hex `head.oid` yields
 * `null` — never a throw, never the launch-time SHA, never the forgeable
 * patch-blob `declaredHeadSha`. The caller (the #451 publication-boundary
 * re-check) refuses to publish on `null`.
 *
 * Bounded and read-only: cursor-paginated `listRecords`, capped at
 * `MAX_PAGES` pages of `PAGE_LIMIT` records; exceeding the cap fails
 * closed (`null`). No credentials are sent; the read is public.
 */

export const TANGLED_PATCH_COLLECTION = "org.tangled.review.patch";
export const TANGLED_TICKET_COLLECTION = "org.tangled.track.ticket";

const XRPC_LIST_RECORDS = "com.atproto.repo.listRecords";
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export interface TangledPatchRecordItem {
  uri: string;
  cid: string | undefined;
  value: Record<string, unknown>;
}

/**
 * Pure selector: the trusted head from a set of `listRecords` items for one
 * ticket, or `null` when the set is empty, malformed, or ambiguous.
 *
 * - an item matches iff `value.ticket` equals the ticket rkey or the full
 *   ticket AT-URI (defensive across the old pull / new ticket models);
 * - every matching item must carry a parseable `createdAt` datetime and a
 *   40-hex `head.oid` — a malformed newest candidate fails closed, and a
 *   malformed non-matching item is ignored (it isn't this ticket's patch);
 * - newest wins by `createdAt`; a tie with different heads is ambiguous.
 */
export function selectNewestPatchHead(
  items: readonly TangledPatchRecordItem[],
  ticketRkey: string,
  ticketUri: string,
  expectedSourceBranch?: string,
): string | null {
  let best: { time: number; head: string } | undefined;
  for (const item of items) {
    const value = item.value;
    const ticket = str(value.ticket);
    // Fail closed on malformed patch state: a patch record without a
    // usable `ticket` key cannot be proven to belong to another pull, so
    // ignoring it could let an older revision masquerade as current.
    if (ticket === undefined) return null;
    if (ticket !== ticketRkey && ticket !== ticketUri) continue;
    // Correlate the patch to this pull's source branch when the context
    // provides one: the patch `source.branch` must match, and a missing
    // source cannot prove the correlation (fail closed).
    if (expectedSourceBranch !== undefined) {
      const source = asRecord(value.source);
      const branch = source === undefined ? undefined : str(source.branch);
      if (branch !== expectedSourceBranch) return null;
    }
    const createdAt = str(value.createdAt);
    if (createdAt === undefined) return null;
    const time = Date.parse(createdAt);
    if (!Number.isFinite(time)) return null;
    const head = asRecord(value.head);
    const oid = head === undefined ? undefined : str(head.oid);
    if (oid === undefined || !SHA_RE.test(oid)) return null;
    const normalized = oid.toLowerCase();
    if (best === undefined || time > best.time) {
      best = { time, head: normalized };
    } else if (time === best.time && normalized !== best.head) {
      return null;
    }
  }
  return best?.head ?? null;
}

export interface ReadTangledCurrentHeadOptions {
  fetchImpl?: FetchLike | undefined;
  timeoutMs?: number | undefined;
}

function knotBase(ctx: TangledContext): { base: string; origin: string } | null {
  const knotHost = ctx.knotHost;
  if (knotHost === undefined || knotHost.trim() === "") return null;
  const host = knotHost.trim().toLowerCase();
  const scheme = LOOPBACK_HOSTS.has(host) ? "http" : "https";
  const base = `${scheme}://${host}`;
  return { base, origin: base };
}

/** One listed record: the parsed AT-URI identity plus the record value. The
 * `uri` is the canonical `at://did/collection/rkey` form rebuilt from the
 * parsed record uri, so every consumer matches against the same shape. */
interface ListedRecord {
  uri: string;
  cid: string | undefined;
  value: Record<string, unknown>;
  rkey: string;
}

/** Bounded listRecords read of one collection; null on any failure. The
 * single pagination+parse loop behind every knot read in this module: page
 * cap, per-item fail-closed validation, and repository binding live here
 * once so the public readers cannot drift. */
async function listCollectionRecords(
  ctx: TangledContext,
  collection: string,
  options?: ReadTangledCurrentHeadOptions,
): Promise<ListedRecord[] | null> {
  try {
    const knot = knotBase(ctx);
    const repoDid = ctx.repoDid;
    if (knot === null || repoDid === undefined || repoDid.trim() === "") return null;
    const items: ListedRecord[] = [];
    let cursor: string | undefined;
    for (let page = 1; ; page += 1) {
      if (page > MAX_PAGES) return null;
      const u = new URL(`${knot.base}/xrpc/${XRPC_LIST_RECORDS}`);
      u.searchParams.set("repo", repoDid.trim());
      u.searchParams.set("collection", collection);
      u.searchParams.set("limit", String(PAGE_LIMIT));
      if (cursor !== undefined) u.searchParams.set("cursor", cursor);
      const result = await requestJson(u.toString(), {
        allowedOrigin: knot.origin,
        fetchImpl: options?.fetchImpl,
        timeoutMs: options?.timeoutMs,
      });
      if (result.status < 200 || result.status >= 300) return null;
      const resp = asRecord(result.data);
      if (resp === undefined || !Array.isArray(resp.records)) return null;
      for (const raw of resp.records) {
        const item = asRecord(raw);
        if (item === undefined) return null;
        const uri = str(item.uri);
        const value = asRecord(item.value);
        if (uri === undefined || uri === "" || value === undefined) return null;
        try {
          const parsed = parseTangledAtUri(uri);
          if (parsed.collection !== collection) return null;
          // Repository binding: the record must live in the requested
          // repository's account, not another repo's (a malformed response
          // must not supply a foreign record).
          if (parsed.did !== repoDid.trim()) return null;
          items.push({
            uri: `at://${parsed.did}/${parsed.collection}/${parsed.rkey}`,
            cid: str(item.cid),
            value,
            rkey: parsed.rkey,
          });
        } catch {
          return null;
        }
      }
      const nextCursor = str(resp.cursor);
      if (nextCursor === undefined || nextCursor === "") break;
      cursor = nextCursor;
    }
    return items;
  } catch {
    return null;
  }
}

/**
 * Resolve the ticket identity (`org.tangled.track.ticket` rkey + URI) that
 * patch records are keyed by. Production pull resolution yields the legacy
 * `sh.tangled.repo.pull` identity, which is NOT the ticket key, so the
 * production callback must resolve the ticket from the knot instead.
 *
 * Matching is deliberately narrow and fail-closed: the ticket must be
 * `open`, carry `targetBranch` equal to the context's target branch, and
 * be the UNIQUE such ticket in the repo account. Zero or multiple matches
 * yield `null` (unknown head → publication refused). Records are bound to
 * the repo DID exactly as in `readTangledCurrentHead`.
 */
export async function resolveTangledTicketIdentity(
  ctx: TangledContext,
  options?: ReadTangledCurrentHeadOptions,
): Promise<{ rkey: string; uri: string } | null> {
  try {
    const tickets = await listCollectionRecords(ctx, TANGLED_TICKET_COLLECTION, options);
    if (tickets === null) return null;
    const matches: Array<{ rkey: string; uri: string }> = [];
    for (const ticket of tickets) {
      const state = str(ticket.value.state);
      if (state !== "open") continue;
      if (ctx.targetBranch !== undefined && str(ticket.value.targetBranch) !== ctx.targetBranch) continue;
      const entry = { rkey: ticket.rkey, uri: ticket.uri };
      if (!matches.some((m) => m.uri === entry.uri)) matches.push(entry);
    }
    return matches.length === 1 ? (matches[0] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Fresh, trusted current head for `identity` from the knot patch records.
 * Returns `null` on any failure (fail closed) — see module doc.
 */
export async function readTangledCurrentHead(
  ctx: TangledContext,
  identity: TangledPullIdentity,
  options?: ReadTangledCurrentHeadOptions,
): Promise<string | null> {
  try {
    const items = await listCollectionRecords(ctx, TANGLED_PATCH_COLLECTION, options);
    if (items === null) return null;
    return selectNewestPatchHead(items, identity.rkey, identity.uri, ctx.sourceBranch);
  } catch {
    return null;
  }
}

/**
 * Combined production read (#1165): resolve the current ticket first,
 * then correlate its patches, so a repo with many historical tickets
 * or several open PRs to the same target branch still works.
 *
 * - candidate tickets = `open` tickets whose `targetBranch` matches the
 *   context (closed tickets are history and never count toward any
 *   candidate cap);
 * - for each candidate, the newest patch must source-branch-correlate
 *   (`source.branch === ctx.sourceBranch`) when the context provides
 *   one. Patches carry `source` only optionally (source-less patches
 *   exist in the wild), so a source-less patch is accepted only when
 *   the candidate is the SOLE open ticket for the target branch — the
 *   ticket identity itself is then the correlation;
 * - exactly one candidate must yield a head, else `null` (ambiguous or
 *   unknown → publication refused). Malformed patch state (missing
 *   ticket key, bad repo binding) fails closed.
 *
 * With a single candidate ticket, source-branch correlation (or, for
 * source-less patches, the sole-ticket identity) selects the head.
 *
 * With multiple candidates, source correlation is never authoritative
 * (multiple open pulls can share source+target branches, and `source`
 * is optional): the launch-time `ctx.sourceSha` (the REVIEWED head) is
 * the sole disambiguator, identifying the unique candidate whose
 * trusted patch history contains that SHA. The returned value is
 * always that ticket's newest trusted `head.oid` from the records —
 * never `ctx.sourceSha` echoed back, never `declaredHeadSha`. Zero or
 * multiple history matches fail closed.
 */
export async function readTangledCurrentHeadForContext(
  ctx: TangledContext,
  options?: ReadTangledCurrentHeadOptions,
): Promise<string | null> {
  const tickets = await listCollectionRecords(ctx, TANGLED_TICKET_COLLECTION, options);
  if (tickets === null) return null;
  const items = await listCollectionRecords(ctx, TANGLED_PATCH_COLLECTION, options);
  if (items === null) return null;
  const candidates = tickets.filter((t) => {
    if (str(t.value.state) !== "open") return false;
    if (ctx.targetBranch !== undefined && str(t.value.targetBranch) !== ctx.targetBranch) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const candidate = candidates[0]!;
    let head = selectNewestPatchHead(items, candidate.rkey, candidate.uri, ctx.sourceBranch);
    if (head === null) {
      // Single-candidate path: with one open ticket for the target
      // branch, the ticket IS the correlation (covers source-less
      // patches, whose `source` is optional in the lexicon).
      head = selectNewestPatchHead(items, candidate.rkey, candidate.uri, undefined);
    }
    return head;
  }
  // Multi-candidate path: source-branch correlation is NOT authoritative
  // (multiple open pulls can share source+target branches, and `source`
  // is optional), so fall through to the history disambiguator below.
  // History fallback (see docblock): identify by reviewed SHA, return
  // newest trusted head — never the launch-time value itself.
  const reviewed = typeof ctx.sourceSha === "string" ? ctx.sourceSha.trim().toLowerCase() : "";
  if (!SHA_RE.test(reviewed)) return null;
  const matches = new Map<string, string>();
  for (const candidate of candidates) {
    const newest = selectNewestPatchHead(items, candidate.rkey, candidate.uri, undefined);
    if (newest === null) continue;
    const inHistory = items.some((item) => {
      const ticket = str(item.value.ticket);
      if (ticket !== candidate.rkey && ticket !== candidate.uri) return false;
      const head = asRecord(item.value.head);
      const oid = head === undefined ? undefined : str(head.oid);
      return oid !== undefined && oid.toLowerCase() === reviewed;
    });
    if (inHistory) matches.set(candidate.uri, newest);
  }
  if (matches.size !== 1) return null;
  return [...matches.values()][0] ?? null;
}
