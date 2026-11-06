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
const SHA_RE = /^[0-9a-f]{40}$/i;

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
): string | null {
  let best: { time: number; head: string } | undefined;
  for (const item of items) {
    const value = item.value;
    const ticket = str(value.ticket);
    if (ticket === undefined || (ticket !== ticketRkey && ticket !== ticketUri)) continue;
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
    const repoDid = ctx.repoDid;
    if (repoDid === undefined || repoDid.trim() === "") return null;
    const knot = knotBase(ctx);
    if (knot === null) return null;
    const matches: Array<{ rkey: string; uri: string }> = [];
    let cursor: string | undefined;
    for (let page = 1; ; page += 1) {
      if (page > MAX_PAGES) return null;
      const u = new URL(`${knot.base}/xrpc/${XRPC_LIST_RECORDS}`);
      u.searchParams.set("repo", repoDid.trim());
      u.searchParams.set("collection", TANGLED_TICKET_COLLECTION);
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
        let parsed: ReturnType<typeof parseTangledAtUri>;
        try {
          parsed = parseTangledAtUri(uri);
        } catch {
          return null;
        }
        if (parsed.collection !== TANGLED_TICKET_COLLECTION) return null;
        if (parsed.did !== repoDid.trim()) return null;
        const state = str(value.state);
        const targetBranch = str(value.targetBranch);
        if (state !== "open") continue;
        if (ctx.targetBranch !== undefined && targetBranch !== ctx.targetBranch) continue;
        const entry = { rkey: parsed.rkey, uri: `at://${parsed.did}/${parsed.collection}/${parsed.rkey}` };
        if (!matches.some((m) => m.uri === entry.uri)) matches.push(entry);
      }
      const nextCursor = str(resp.cursor);
      if (nextCursor === undefined || nextCursor === "") break;
      cursor = nextCursor;
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
    const knotHost = ctx.knotHost;
    const repoDid = ctx.repoDid;
    if (knotHost === undefined || knotHost.trim() === "") return null;
    if (repoDid === undefined || repoDid.trim() === "") return null;

    const host = knotHost.trim().toLowerCase();
    const scheme = LOOPBACK_HOSTS.has(host) ? "http" : "https";
    const base = `${scheme}://${host}`;
    const origin = base;

    const items: TangledPatchRecordItem[] = [];
    let cursor: string | undefined;
    for (let page = 1; ; page += 1) {
      if (page > MAX_PAGES) return null;
      const u = new URL(`${base}/xrpc/${XRPC_LIST_RECORDS}`);
      u.searchParams.set("repo", repoDid.trim());
      u.searchParams.set("collection", TANGLED_PATCH_COLLECTION);
      u.searchParams.set("limit", String(PAGE_LIMIT));
      if (cursor !== undefined) u.searchParams.set("cursor", cursor);
      const result = await requestJson(u.toString(), {
        allowedOrigin: origin,
        fetchImpl: options?.fetchImpl,
        timeoutMs: options?.timeoutMs,
      });
      if (result.status < 200 || result.status >= 300) return null;
      const resp = asRecord(result.data);
      if (resp === undefined) return null;
      const records = resp.records;
      if (!Array.isArray(records)) return null;
      for (const raw of records) {
        const item = asRecord(raw);
        if (item === undefined) return null;
        const uri = str(item.uri);
        const value = asRecord(item.value);
        if (uri === undefined || uri === "" || value === undefined) return null;
        try {
          const parsed = parseTangledAtUri(uri);
          if (parsed.collection !== TANGLED_PATCH_COLLECTION) return null;
          // Repository binding: the patch must live in the requested
          // repository's account, not another repo's (a malformed response
          // must not supply a foreign patch).
          if (parsed.did !== repoDid.trim()) return null;
        } catch {
          return null;
        }
        items.push({ uri, cid: str(item.cid), value });
      }
      const nextCursor = str(resp.cursor);
      if (nextCursor === undefined || nextCursor === "") break;
      cursor = nextCursor;
    }
    return selectNewestPatchHead(items, identity.rkey, identity.uri);
  } catch {
    return null;
  }
}
