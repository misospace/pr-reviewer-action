import { PlatformRequestError, requestJson, type FetchLike } from "./http.js";
import type { TangledContext } from "./tangled.js";

/**
 * Read-side Bobbin client for Tangled pulls (#584).
 *
 * This is the read-side backend step of the Tangled backend work: it pulls
 * the pull record(s) for a repository over Bobbin's public XRPC surface and
 * normalizes them into `TangledPullIdentity`. The raw Bobbin/pull payload
 * shapes stay behind this boundary — callers only ever see the normalized
 * identity, never the wire shapes.
 *
 * Reads are public/unauthenticated by default: no credential is attached
 * unless the caller passes a token, and a token is only ever sent as the
 * Authorization header to the validated Bobbin origin (via `requestJson`'s
 * `allowedOrigin`), never in the URL, argv, or diagnostics.
 *
 * The `requireImplementedBackend` guard in `tangled.ts` stays in force:
 * until the later #564 tickets wire this resolver into the review pipeline,
 * no pipeline code path may call it for a `tangled`-resolved environment.
 *
 * AT-Protocol facts this module relies on:
 * - pulls live in the `sh.tangled.repo.pull` collection;
 * - a pull URI is `at://<authorDid>/sh.tangled.repo.pull/<TID>` — the
 *   repository identity is in `value.target.repo`, NOT in the URI;
 * - the listing is `sh.tangled.repo.listPulls?subject=<repoDID>`,
 *   paginated by `cursor`;
 * - a single pull is `sh.tangled.repo.getPull?pull=<uri>`.
 *
 * No new npm dependencies: this module is the stdlib `URL` parser plus the
 * shared `requestJson` transport.
 */

const PULL_COLLECTION = "sh.tangled.repo.pull";
const XRPC_LIST_PULLS = "sh.tangled.repo.listPulls";
const XRPC_GET_PULL = "sh.tangled.repo.getPull";
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

export interface TangledPullIdentity {
  uri: string;
  cid: string;
  rkey: string;
  record: Record<string, unknown>;
  repoDid: string;
  authorDid: string;
  targetBranch: string | undefined;
  sourceBranch: string | undefined;
  sourceRepoDid: string | undefined;
  state: string | undefined;
  sourceSha: string | undefined;
}

export type TangledResolverFailure =
  | "config"
  | "invalid-uri"
  | "no-match"
  | "ambiguous"
  | "read-failed"
  | "invalid-response";

export class TangledResolverError extends Error {
  readonly kind: TangledResolverFailure;

  constructor(kind: TangledResolverFailure, message: string) {
    super(message);
    this.name = "TangledResolverError";
    this.kind = kind;
  }
}

export interface ParsedAtUri {
  did: string;
  collection: string;
  rkey: string;
  cid?: string;
}

/** A pull entry collected from `listPulls` before state filtering. */
interface PullMatch {
  uri: string;
  cid: string | undefined;
  state: string | undefined;
  value: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Parse `at://<did>/<collection>/<rkey>[?cid=<v>]`. Any malformation is a
 * `TangledResolverError` of kind "invalid-uri"; the `cid` property is
 * omitted (not set to `undefined`) when the query is absent. */
export function parseTangledAtUri(uri: string): ParsedAtUri {
  if (!uri.startsWith("at://")) {
    throw new TangledResolverError("invalid-uri", `not a Tangled AT-URI (must start with "at://"): ${uri}`);
  }
  let remainder = uri.slice("at://".length);
  let cid: string | undefined;
  const queryAt = remainder.lastIndexOf("?");
  if (queryAt !== -1) {
    const query = remainder.slice(queryAt + 1);
    if (!query.startsWith("cid=") || query.length === "cid=".length) {
      throw new TangledResolverError(
        "invalid-uri",
        `unsupported AT-URI query (only "?cid=<v>" is accepted): ${query}`,
      );
    }
    cid = query.slice("cid=".length);
    remainder = remainder.slice(0, queryAt);
  }
  const parts = remainder.split("/");
  if (parts.length !== 3) {
    throw new TangledResolverError("invalid-uri", `expected at://<did>/<collection>/<rkey>, got: ${uri}`);
  }
  const did = parts[0] ?? "";
  const collection = parts[1] ?? "";
  const rkey = parts[2] ?? "";
  const didParts = did.split(":");
  if (didParts[0] !== "did" || didParts.length < 3 || (didParts[1]?.length ?? 0) === 0) {
    throw new TangledResolverError("invalid-uri", `AT-URI DID must be did:<method>:<method-specific-id>: ${did}`);
  }
  if (collection === "") {
    throw new TangledResolverError("invalid-uri", `AT-URI collection is empty: ${uri}`);
  }
  if (rkey === "") {
    throw new TangledResolverError("invalid-uri", `AT-URI rkey is empty: ${uri}`);
  }
  const result: ParsedAtUri = { did, collection, rkey };
  if (cid !== undefined) result.cid = cid;
  return result;
}

export interface ResolveTangledPullOptions {
  pullUri?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  token?: string | undefined;
  timeoutMs?: number | undefined;
  states?: readonly string[] | undefined;
}

/**
 * Resolve the Tangled pull for `ctx` from the Bobbin XRPC surface (read-only
 * GETs, no numeric PR id is ever built or required). With `options.pullUri`
 * the single pull is fetched directly (`sh.tangled.repo.getPull?pull=<uri>`);
 * otherwise the repository's pulls are listed
 * (`sh.tangled.repo.listPulls?subject=<repoDID>`, cursor-paginated) and the
 * entry matching the context's source/target branch(es) in one of `states`
 * (default `["open"]`) wins.
 */
export async function resolveTangledPull(
  ctx: TangledContext,
  options?: ResolveTangledPullOptions,
): Promise<TangledPullIdentity> {
  const bobbinUrl = ctx.bobbinUrl;
  if (bobbinUrl === undefined || bobbinUrl.trim() === "") {
    throw new TangledResolverError("config", "Tangled pull resolution requires a valid TANGLED_BOBBIN_URL");
  }
  let base: URL;
  try {
    base = new URL(bobbinUrl);
  } catch {
    throw new TangledResolverError("config", "Tangled pull resolution requires a valid TANGLED_BOBBIN_URL");
  }
  const origin = base.origin;

  // Build an XRPC request URL from the base's path plus the per-request
  // params; the base's query string is intentionally not forwarded.
  const xrpc = (nsid: string, params: Record<string, string>): { url: string; origin: string } => {
    const pathname = base.pathname.replace(/\/+$/, "") + "/xrpc/" + nsid;
    const u = new URL(origin + pathname);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return { url: u.toString(), origin };
  };

  const fetchImpl = options?.fetchImpl;
  const token = options?.token;
  const timeoutMs = options?.timeoutMs;

  /** One GET XRPC call; a thrown 404 maps to "no-match", any other thrown
   * transport/parse failure maps to "read-failed". */
  const getJson = async (
    nsid: string,
    params: Record<string, string>,
    notFoundMessage: string,
  ): Promise<{ status: number; data: unknown }> => {
    const target = xrpc(nsid, params);
    try {
      return await requestJson(target.url, {
        allowedOrigin: target.origin,
        fetchImpl,
        token,
        timeoutMs,
      });
    } catch (error) {
      if (error instanceof PlatformRequestError && error.status === 404) {
        throw new TangledResolverError("no-match", notFoundMessage);
      }
      throw new TangledResolverError(
        "read-failed",
        `Tangled pull read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const pullUri = options?.pullUri;
  if (pullUri !== undefined && pullUri.trim() !== "") {
    const trimmed = pullUri.trim();
    const parsed = parseTangledAtUri(trimmed);
    if (parsed.collection !== PULL_COLLECTION) {
      throw new TangledResolverError("invalid-uri", `pull URI ${trimmed} is not a ${PULL_COLLECTION} pull`);
    }
    const { status, data } = await getJson(XRPC_GET_PULL, { pull: trimmed }, `pull not found: ${trimmed}`);
    if (status === 404) {
      throw new TangledResolverError("no-match", `pull not found: ${trimmed}`);
    }
    if (status < 200 || status >= 300) {
      throw new TangledResolverError("read-failed", `getPull returned HTTP ${status}`);
    }
    const record = asRecord(data);
    if (record === undefined) {
      throw new TangledResolverError("invalid-response", `getPull for ${trimmed} did not return a JSON object`);
    }
    const uri = `at://${parsed.did}/${parsed.collection}/${parsed.rkey}`;
    const value = asRecord(record.value);
    if (value === undefined) {
      throw new TangledResolverError("invalid-response", `getPull for ${trimmed} has no pull value object`);
    }
    const finalCid = parsed.cid ?? str(record.cid) ?? "";
    if (finalCid === "") {
      throw new TangledResolverError("invalid-response", `resolved pull ${trimmed} carries no CID to pin`);
    }
    const target = asRecord(value.target);
    const targetRepo = target === undefined ? undefined : str(target.repo);
    if (ctx.repoDid !== undefined && targetRepo !== undefined && targetRepo !== ctx.repoDid) {
      throw new TangledResolverError(
        "invalid-uri",
        `explicit pull targets repo ${targetRepo}, not context repo ${ctx.repoDid}`,
      );
    }
    if (targetRepo === undefined) {
      throw new TangledResolverError("invalid-response", `getPull for ${trimmed} is missing value.target.repo`);
    }
    const source = asRecord(value.source);
    return {
      uri,
      cid: finalCid,
      rkey: parsed.rkey,
      record: value,
      repoDid: targetRepo,
      authorDid: parsed.did,
      targetBranch: target === undefined ? undefined : str(target.branch),
      sourceBranch: source === undefined ? undefined : str(source.branch),
      sourceRepoDid: source === undefined ? undefined : str(source.repo),
      state: str(record.state),
      sourceSha: ctx.sourceSha,
    };
  }

  if (ctx.repoDid === undefined) {
    throw new TangledResolverError(
      "config",
      "cannot resolve Tangled pull: repository DID (TANGLED_REPO_REPO_DID) is required",
    );
  }
  if (ctx.sourceBranch === undefined && ctx.targetBranch === undefined) {
    throw new TangledResolverError("config", "cannot resolve Tangled pull without a source or target branch");
  }
  const states = options?.states ?? ["open"];

  const matched: PullMatch[] = [];
  let cursor: string | undefined;
  let page = 0;
  for (;;) {
    page += 1;
    if (page > MAX_PAGES) {
      throw new TangledResolverError("read-failed", `pull pagination exceeded ${MAX_PAGES} pages without resolving`);
    }
    const params: Record<string, string> = { subject: ctx.repoDid, limit: String(PAGE_LIMIT) };
    if (cursor !== undefined) params.cursor = cursor;
    const target = xrpc(XRPC_LIST_PULLS, params);
    let result: { status: number; data: unknown };
    try {
      result = await requestJson(target.url, {
        allowedOrigin: target.origin,
        fetchImpl,
        token,
        timeoutMs,
      });
    } catch (error) {
      throw new TangledResolverError(
        "read-failed",
        `Tangled pull read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.status === 404) {
      throw new TangledResolverError("read-failed", "listPulls returned HTTP 404 (check TANGLED_BOBBIN_URL)");
    }
    if (result.status < 200 || result.status >= 300) {
      throw new TangledResolverError("read-failed", `listPulls returned HTTP ${result.status}`);
    }
    const resp = asRecord(result.data);
    if (resp === undefined) {
      throw new TangledResolverError("invalid-response", "listPulls did not return a JSON object");
    }
    const items = resp.items;
    if (!Array.isArray(items)) {
      throw new TangledResolverError("invalid-response", "listPulls response has no items array");
    }
    for (const item of items) {
      const itemRecord = asRecord(item);
      if (itemRecord === undefined) {
        throw new TangledResolverError("invalid-response", "listPulls item is not an object");
      }
      const itemUri = str(itemRecord.uri);
      if (itemUri === undefined || itemUri === "") {
        throw new TangledResolverError("invalid-response", "listPulls item has no uri");
      }
      let itemParsed: ParsedAtUri;
      try {
        itemParsed = parseTangledAtUri(itemUri);
      } catch {
        throw new TangledResolverError("invalid-response", `listPulls item has an invalid AT-URI: ${itemUri}`);
      }
      if (itemParsed.collection !== PULL_COLLECTION) {
        throw new TangledResolverError("invalid-response", `listPulls item is not a ${PULL_COLLECTION}: ${itemUri}`);
      }
      const itemValue = asRecord(itemRecord.value);
      if (itemValue === undefined) {
        throw new TangledResolverError("invalid-response", "listPulls item has no value object");
      }
      const itemTarget = asRecord(itemValue.target);
      const itemTargetBranch = itemTarget === undefined ? undefined : str(itemTarget.branch);
      const itemSource = asRecord(itemValue.source);
      const itemSourceBranch = itemSource === undefined ? undefined : str(itemSource.branch);
      const matchesBranches =
        (ctx.targetBranch === undefined || itemTargetBranch === ctx.targetBranch) &&
        (ctx.sourceBranch === undefined || itemSourceBranch === ctx.sourceBranch);
      if (matchesBranches && !matched.some((m) => m.uri === itemUri)) {
        matched.push({
          uri: itemUri,
          cid: str(itemRecord.cid),
          state: str(itemRecord.state),
          value: itemValue,
        });
      }
    }
    const nextCursor = str(resp.cursor);
    if (nextCursor === undefined || nextCursor === "") break;
    cursor = nextCursor;
  }

  const stateMatched = matched.filter((m) => m.state !== undefined && states.includes(m.state));
  const buildIdentity = (m: PullMatch): TangledPullIdentity => {
    const target = asRecord(m.value.target);
    const repoDid = target === undefined ? undefined : str(target.repo);
    if (repoDid === undefined) {
      throw new TangledResolverError("invalid-response", `matching pull ${m.uri} is missing value.target.repo`);
    }
    const source = asRecord(m.value.source);
    const cid = m.cid ?? "";
    if (cid === "") {
      throw new TangledResolverError("invalid-response", `matching pull ${m.uri} carries no CID to pin`);
    }
    const p = parseTangledAtUri(m.uri);
    return {
      uri: m.uri,
      cid,
      rkey: p.rkey,
      record: m.value,
      repoDid,
      authorDid: p.did,
      targetBranch: target === undefined ? undefined : str(target.branch),
      sourceBranch: source === undefined ? undefined : str(source.branch),
      sourceRepoDid: source === undefined ? undefined : str(source.repo),
      state: m.state,
      sourceSha: ctx.sourceSha,
    };
  };

  const first = stateMatched[0];
  if (stateMatched.length === 1 && first !== undefined) {
    return buildIdentity(first);
  }
  if (stateMatched.length > 1) {
    const descriptions = stateMatched.map((m) => `${m.uri} (${m.state ?? "unknown"})`);
    throw new TangledResolverError(
      "ambiguous",
      `ambiguous: ${stateMatched.length} Tangled pulls match the branch(es) in state(s) [${states.join(", ")}]: ${descriptions.join(", ")}`,
    );
  }
  if (matched.length > 0) {
    const statesSeen = [...new Set(matched.map((m) => m.state ?? "unknown"))];
    throw new TangledResolverError(
      "no-match",
      `found ${matched.length} pull(s) matching the branch(es) but none in state(s) [${states.join(", ")}]; states seen: ${statesSeen.join(", ")}`,
    );
  }
  throw new TangledResolverError(
    "no-match",
    `no Tangled pull for repo ${ctx.repoDid} from ${ctx.sourceBranch ?? "'>?"} into ${ctx.targetBranch ?? "'>?"}`,
  );
}
