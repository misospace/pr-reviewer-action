import test from "node:test";
import assert from "node:assert/strict";
import { TANGLED_MANAGED_REVIEW_COLLECTION, TangledPublishApi } from "../src/platform/tangled-publish.js";
import { TangledAtprotoClient } from "../src/platform/tangled-atproto.js";
import type { FetchLike } from "../src/platform/http.js";
import type { TangledContext } from "../src/platform/tangled.js";

/**
 * Tangled publish adapter (#588), exercised through a hand-rolled AT-Proto
 * stub (no HTTP) and an injected Bobbin transport for pull resolution.
 */

const SESSION_DID = "did:plc:tester";
const PULL_URI = "at://did:plc:author/sh.tangled.repo.pull/3mxb";
const REPO_DID = "did:plc:repo";
const MARKER = "<!-- pr-reviewer managed review (run:abc123) -->";
const BODY = `${MARKER}\n\nreview body text`;

// ── Bobbin resolution transport (copied responder style) ────────────────

interface Call {
  url: URL;
  nsid: string;
  query: Record<string, string>;
}

function makeFetch(
  responder: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const nsid = decodeURIComponent(url.pathname.replace(/^.*\/xrpc\//, ""));
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) query[k] = v;
    calls.push({ url, nsid, query });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function makeCtx(over: Partial<TangledContext> = {}): TangledContext {
  return {
    ownerDid: "did:plc:owner",
    repoDid: REPO_DID,
    repoName: "owner/repo",
    sourceBranch: "feat/x",
    targetBranch: "main",
    sourceSha: "0123456789abcdef0123456789abcdef0123456789abcdef",
    knotHost: "knot1.tangled.sh",
    bobbinUrl: "https://bobbin.test",
    ...over,
  };
}

const LIST_ONE = {
  items: [
    {
      uri: PULL_URI,
      cid: "bafyrei2",
      state: "open",
      value: {
        target: { branch: "main", repo: REPO_DID },
        source: { branch: "feat/x" },
      },
    },
  ],
  cursor: null,
};

const listPullsResponder = (): Response => json(LIST_ONE);

// ── AT-Proto stub client ────────────────────────────────────────────────

interface ListedRecord {
  uri: string;
  cid: string | undefined;
  value: Record<string, unknown>;
}

interface StubCalls {
  created: Array<{ collection: string; record: Record<string, unknown> }>;
  puts: Array<{ collection: string; rkey: string; record: Record<string, unknown> }>;
  lists: number;
}

interface StubOptions {
  did?: string | undefined;
  /** Pages of listRecords results; when absent, one page built from `records`. */
  pages?: Array<{ records: ListedRecord[]; cursor: string | undefined }>;
  records?: ListedRecord[];
  throwOn?: "list" | "create" | "put";
}

function makeStub(options: StubOptions = {}): { client: TangledAtprotoClient; calls: StubCalls } {
  const calls: StubCalls = { created: [], puts: [], lists: 0 };
  const client = {
    get did(): string | undefined {
      return options.did;
    },
    async listRecords(
      _collection: string,
      _opts?: { limit?: number; cursor?: string },
    ): Promise<{ records: ListedRecord[]; cursor: string | undefined }> {
      calls.lists += 1;
      if (options.throwOn === "list") throw new Error("list boom");
      if (options.pages !== undefined) {
        const page = options.pages[Math.min(calls.lists - 1, options.pages.length - 1)];
        if (page === undefined) return { records: [], cursor: undefined };
        return { records: page.records, cursor: page.cursor };
      }
      return { records: options.records ?? [], cursor: undefined };
    },
    async createRecord(
      collection: string,
      record: Record<string, unknown>,
    ): Promise<{ uri: string; cid: string }> {
      if (options.throwOn === "create") throw new Error("create boom");
      calls.created.push({ collection, record });
      return { uri: `at://${SESSION_DID}/${collection}/3labnew`, cid: "bafynew" };
    },
    async putRecord(
      collection: string,
      rkey: string,
      record: Record<string, unknown>,
    ): Promise<{ uri: string; cid: string }> {
      if (options.throwOn === "put") throw new Error("put boom");
      calls.puts.push({ collection, rkey, record });
      return { uri: `at://${SESSION_DID}/${collection}/${rkey}`, cid: "bafyput" };
    },
  };
  return { client: client as unknown as TangledAtprotoClient, calls };
}

function managedRecord(over: Partial<Record<string, unknown>> = {}): ListedRecord {
  const rkey = over.rkey === undefined ? "3lab1" : String(over.rkey);
  delete over.rkey;
  const value: Record<string, unknown> = {
    $type: TANGLED_MANAGED_REVIEW_COLLECTION,
    pull: PULL_URI,
    pullRepoDid: REPO_DID,
    reviewer: SESSION_DID,
    body: MARKER,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
  return { uri: `at://${SESSION_DID}/${TANGLED_MANAGED_REVIEW_COLLECTION}/${rkey}`, cid: "bafyold", value };
}

function makeApi(
  stub: TangledAtprotoClient,
  over: Partial<TangledContext> = {},
  fetchResponder: (url: URL, init?: RequestInit) => Response | Promise<Response> = listPullsResponder,
): { api: TangledPublishApi; calls: Call[] } {
  const { fetchImpl, calls } = makeFetch(fetchResponder);
  const api = new TangledPublishApi({ context: makeCtx(over), atproto: stub, fetchImpl, timeoutMs: 5000 });
  return { api, calls };
}

// ── upsertStickyComment: create / update / stale ─────────────────────────

test("first publish creates exactly one record with the full contract shape", async () => {
  const { client, calls } = makeStub({ did: SESSION_DID });
  const { api } = makeApi(client);

  const result = await api.upsertStickyComment(MARKER, BODY);
  assert.deepEqual(result, {
    ok: true,
    created: true,
    commentId: `at://${SESSION_DID}/${TANGLED_MANAGED_REVIEW_COLLECTION}/3labnew`,
    updatedAt: result.updatedAt,
  });

  assert.equal(calls.created.length, 1);
  assert.equal(calls.puts.length, 0);
  const { collection, record } = calls.created[0] ?? { collection: "", record: {} };
  assert.equal(collection, TANGLED_MANAGED_REVIEW_COLLECTION);
  assert.deepEqual(Object.keys(record).sort(), [
    "$type",
    "body",
    "createdAt",
    "pull",
    "pullCid",
    "pullRepoDid",
    "reviewer",
    "sourceSha",
  ]);
  assert.equal(record.$type, TANGLED_MANAGED_REVIEW_COLLECTION);
  assert.equal(record.pull, PULL_URI);
  assert.equal(record.pullCid, "bafyrei2");
  assert.equal(record.pullRepoDid, REPO_DID);
  assert.equal(record.reviewer, SESSION_DID);
  assert.equal(record.sourceSha, makeCtx().sourceSha);
  assert.equal(record.body, BODY);
  assert.equal(typeof record.createdAt, "string");
  assert.notEqual(new Date(String(record.createdAt)).toString(), "Invalid Date");
  // No undefined values serialized: the record round-trips through JSON
  // unchanged and every value is defined.
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  for (const value of Object.values(record)) assert.notEqual(value, undefined);
});

test("record omits sourceSha when the context has none (never undefined)", async () => {
  const { client, calls } = makeStub({ did: SESSION_DID });
  const { api } = makeApi(client, { sourceSha: undefined });

  const result = await api.upsertStickyComment(MARKER, BODY);
  assert.equal(result.ok, true);
  const record = calls.created[0]?.record ?? {};
  assert.equal("sourceSha" in record, false);
  assert.equal("pullCid" in record, true);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
});

test("re-review updates the SAME record: putRecord with the same rkey, no second create", async () => {
  const existing = managedRecord();
  const { client, calls } = makeStub({ did: SESSION_DID, records: [existing] });
  const { api } = makeApi(client);

  const first = await api.upsertStickyComment(MARKER, BODY + " round 1");
  assert.deepEqual(first, { ok: true, created: false, commentId: existing.uri, updatedAt: first.updatedAt });

  // Memoization: the second upsert reuses the pull resolution (see the
  // memoization test for the fetch-count assertion); here both writes hit
  // the same rkey and createRecord stays at zero.
  const second = await api.upsertStickyComment(MARKER, BODY + " round 2");
  assert.deepEqual(second, { ok: true, created: false, commentId: existing.uri, updatedAt: second.updatedAt });

  assert.equal(calls.created.length, 0);
  assert.equal(calls.puts.length, 2);
  assert.equal(calls.puts[0]?.rkey, "3lab1");
  assert.equal(calls.puts[1]?.rkey, "3lab1");
  assert.equal(calls.puts[0]?.collection, TANGLED_MANAGED_REVIEW_COLLECTION);
  assert.equal(calls.puts[0]?.record.pull, PULL_URI);
});

test("pull resolution is memoized: two upserts trigger exactly ONE resolution", async () => {
  const { client } = makeStub({ did: SESSION_DID });
  const { api, calls } = makeApi(client);

  await api.upsertStickyComment(MARKER, BODY);
  await api.upsertStickyComment(MARKER, BODY);
  assert.equal(calls.length, 1, "expected exactly one Bobbin listPulls call across two upserts");
});

test("wrong reviewer identity is ignored → treated as no managed record → creates fresh", async () => {
  const foreign = managedRecord({ reviewer: "did:plc:other" });
  const { client, calls } = makeStub({ did: SESSION_DID, records: [foreign] });
  const { api } = makeApi(client);

  const result = await api.upsertStickyComment(MARKER, BODY);
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.puts.length, 0);
});

test("unattributable record (missing/non-string reviewer) is ignored", async () => {
  const orphan = managedRecord({ reviewer: undefined });
  const { client, calls } = makeStub({ did: SESSION_DID, records: [orphan] });
  const { api } = makeApi(client);

  const result = await api.upsertStickyComment(MARKER, BODY);
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(calls.created.length, 1);
});

test("stale repo binding (pullRepoDid mismatch) is ignored → creates fresh", async () => {
  const staleBinding = managedRecord({ pullRepoDid: "did:plc:other-repo" });
  const { client, calls } = makeStub({ did: SESSION_DID, records: [staleBinding] });
  const { api } = makeApi(client);

  const result = await api.upsertStickyComment(MARKER, BODY);
  assert.equal(result.created, true);
  assert.equal(calls.puts.length, 0);
  assert.equal(calls.created.length, 1);
});

test("stale case: single pull-matching record whose body lacks the current marker is updated in place", async () => {
  const oldMarker = managedRecord({ body: "<!-- pr-reviewer managed review (run:OLD) -->" });
  const { client, calls } = makeStub({ did: SESSION_DID, records: [oldMarker] });
  const { api } = makeApi(client);

  const result = await api.upsertStickyComment(MARKER, BODY);
  assert.deepEqual(result, { ok: true, created: false, commentId: oldMarker.uri, updatedAt: result.updatedAt });
  assert.equal(calls.puts.length, 1);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.puts[0]?.rkey, "3lab1");
});

// ── ambiguity: fail closed, no mutation ──────────────────────────────────

test("two marker-matching records → ambiguous, no create/put call", async () => {
  const a = managedRecord({ rkey: "3lab1" });
  const b = managedRecord({ rkey: "3lab2" });
  const { client, calls } = makeStub({ did: SESSION_DID, records: [a, b] });
  const { api } = makeApi(client);

  const result = await api.upsertStickyComment(MARKER, BODY);
  assert.equal(result.ok, false);
  assert.equal(result.created, false);
  assert.ok(result.error?.includes("ambiguous"), `expected "ambiguous" in: ${result.error}`);
  assert.ok(result.error?.includes("2"), `expected the count in: ${result.error}`);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.puts.length, 0);
});

test("two pull-matching records, none marker-matching → fail closed, no mutation", async () => {
  const a = managedRecord({ rkey: "3lab1", body: "old body A" });
  const b = managedRecord({ rkey: "3lab2", body: "old body B" });
  const { client, calls } = makeStub({ did: SESSION_DID, records: [a, b] });
  const { api } = makeApi(client);

  const result = await api.upsertStickyComment(MARKER, BODY);
  assert.equal(result.ok, false);
  assert.equal(result.created, false);
  assert.ok(result.error?.includes("ambiguous"), `expected "ambiguous" in: ${result.error}`);
  // Distinct from the marker-matching ambiguity message.
  assert.notEqual(result.error, "ambiguous managed review: 2 marker-matching records exist for pull " + PULL_URI);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.puts.length, 0);
});

// ── input validation: no network call ────────────────────────────────────

test("empty marker or body fails without any network call", async () => {
  const { client, calls } = makeStub({ did: SESSION_DID });
  const { api } = makeApi(client);

  const noMarker = await api.upsertStickyComment("", BODY);
  assert.deepEqual(noMarker, { ok: false, created: false, error: noMarker.error });
  const noBody = await api.upsertStickyComment(MARKER, "");
  assert.equal(noBody.ok, false);
  assert.equal(noBody.created, false);
  assert.notEqual(noBody.error, undefined);
  assert.equal(calls.lists, 0);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.puts.length, 0);
});

// ── pull resolution failure ──────────────────────────────────────────────

test("pull resolution failure surfaces the kind deterministically, zero ATProto calls", async () => {
  const { client, calls } = makeStub({ did: SESSION_DID });
  // No repoDid and no pullUri → the resolver fails with kind "config"
  // without any Bobbin call either.
  const { api } = makeApi(client, { repoDid: undefined });

  const result = await api.upsertStickyComment(MARKER, BODY);
  assert.equal(result.ok, false);
  assert.equal(result.created, false);
  assert.ok(
    result.error?.startsWith("Tangled pull resolution failed (config):"),
    `expected a config-kind resolution failure, got: ${result.error}`,
  );
  assert.equal(calls.lists, 0);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.puts.length, 0);
});

test("pull resolution no-match (empty listing) is surfaced with its kind", async () => {
  const { client, calls } = makeStub({ did: SESSION_DID });
  const { api } = makeApi(client, {}, () => json({ items: [], cursor: null }));

  const result = await api.upsertStickyComment(MARKER, BODY);
  assert.equal(result.ok, false);
  assert.ok(
    result.error?.startsWith("Tangled pull resolution failed (no-match):"),
    `expected a no-match resolution failure, got: ${result.error}`,
  );
  assert.equal(calls.lists, 0);
});

// ── atproto failures and pagination ──────────────────────────────────────

test("an ATProto client failure is reported as a sanitized error", async () => {
  const { client } = makeStub({ did: SESSION_DID, throwOn: "list" });
  const { api } = makeApi(client);

  const result = await api.upsertStickyComment(MARKER, BODY);
  assert.equal(result.ok, false);
  assert.equal(result.created, false);
  assert.equal(result.error, "list boom");
});

test("listRecords pagination follows cursors and accumulates records across pages", async () => {
  const a = managedRecord({ rkey: "3lab1" });
  const b = managedRecord({ rkey: "3lab2" });
  const { client, calls } = makeStub({
    did: SESSION_DID,
    pages: [
      { records: [a], cursor: "page-2" },
      { records: [b], cursor: undefined },
      { records: [], cursor: undefined },
    ],
  });
  const { api } = makeApi(client);

  const result = await api.upsertStickyComment(MARKER, BODY);
  assert.equal(result.ok, false, "two marker-matching records across pages is still ambiguous");
  assert.ok(result.error?.includes("ambiguous"));
  assert.equal(calls.lists, 2, "the third page is never fetched once the cursor is exhausted");
});

test("listRecords pagination beyond the 10-page cap fails closed", async () => {
  const { client, calls } = makeStub({
    did: SESSION_DID,
    pages: [{ records: [], cursor: "never-ending" }],
  });
  const { api } = makeApi(client);

  const result = await api.upsertStickyComment(MARKER, BODY);
  assert.equal(result.ok, false);
  assert.equal(result.created, false);
  assert.equal(result.error, "managed review lookup exceeded the pagination cap");
  assert.equal(calls.lists, 10);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.puts.length, 0);
});

// ── interface shape: platform id, degraded ops, head sha ─────────────────

test("platform id, degraded ops, and getHeadSha", async () => {
  const { client } = makeStub({ did: SESSION_DID });
  const { api } = makeApi(client);

  assert.equal(api.platform, "tangled");
  assert.deepEqual(await api.listReviews(), []);
  assert.deepEqual(await api.listIssueComments(), []);
  assert.deepEqual(await api.listManagedInlineComments(["1"]), { supported: false, complete: false, comments: [] });
  assert.equal(await api.retireInlineComment("1", "2"), false);
  assert.deepEqual(await api.createReview({ body: "b", event: "APPROVE" }), {
    ok: false,
    error: "native reviews are not supported on Tangled",
  });
  assert.equal(await api.dismissReview("1", "m"), false);
  assert.deepEqual(await api.minimizedReviewIds(), []);
  assert.equal(await api.minimizeReview("node"), false);
  assert.deepEqual(await api.unresolvedSupersededThreads([1]), {
    ok: false,
    threads: [],
    hasNextPage: false,
    error: "no thread API on Tangled",
  });
  assert.equal(await api.resolveThread("t"), false);
  assert.equal(await api.removeLabel("ai-review"), false);
  assert.deepEqual(await api.requestReviewers(["alice"], ["core"]), {
    ok: false,
    supported: false,
    requestedUsers: [],
    requestedTeams: [],
    alreadyRequestedUsers: [],
    alreadyRequestedTeams: [],
    error: "reviewer requests are not supported on Tangled",
  });

  assert.equal(await api.getHeadSha(), makeCtx().sourceSha);
  assert.equal(await api.authenticatedIdentity(), SESSION_DID);
});

test("getHeadSha is null when the context has no sourceSha", async () => {
  const { client } = makeStub({ did: SESSION_DID });
  const { api } = makeApi(client, { sourceSha: undefined });
  assert.equal(await api.getHeadSha(), null);
});

test("authenticatedIdentity is null before a session exists", async () => {
  const { client } = makeStub({ did: undefined });
  const { api } = makeApi(client);
  assert.equal(await api.authenticatedIdentity(), null);
});

test("first publish works against the REAL client whose DID is undefined until the session is established", async () => {
  // Regression (reviewer finding): `sessionDid` used to be captured before
  // any authenticated call, so a fresh client (did === undefined) failed
  // every first publish with "session has no DID". The listing must
  // establish the session BEFORE the record is built.
  const nsids: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const nsid = url.pathname.replace(/^.*\/xrpc\//, "");
    nsids.push(nsid);
    if (nsid === "sh.tangled.repo.listPulls") return json(LIST_ONE);
    if (nsid === "com.atproto.server.createSession") {
      return json({ did: SESSION_DID, accessJwt: "jwt-access", refreshJwt: "jwt-refresh" });
    }
    if (nsid === "com.atproto.repo.listRecords") {
      assert.equal(url.searchParams.get("repo"), SESSION_DID);
      return json({ records: [] });
    }
    if (nsid === "com.atproto.repo.createRecord") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      assert.equal(body.repo, SESSION_DID);
      assert.equal(body.collection, TANGLED_MANAGED_REVIEW_COLLECTION);
      const record = body.record as Record<string, unknown>;
      assert.equal(record.reviewer, SESSION_DID);
      assert.equal(record.pull, PULL_URI);
      return json({ uri: `at://${SESSION_DID}/${TANGLED_MANAGED_REVIEW_COLLECTION}/3new`, cid: "bafynew" });
    }
    throw new Error(`unexpected XRPC call: ${nsid}`);
  };
  const api = new TangledPublishApi({
    context: makeCtx(),
    atproto: new TangledAtprotoClient({ host: "http://127.0.0.1:9999", handle: "bot.test", appPassword: "pw", timeoutMs: 5000, fetchImpl }),
    fetchImpl,
    timeoutMs: 5000,
  });
  const result = await api.upsertStickyComment(MARKER, BODY);
  assert.deepEqual(result, { ok: true, created: true, commentId: `at://${SESSION_DID}/${TANGLED_MANAGED_REVIEW_COLLECTION}/3new`, updatedAt: result.updatedAt });
  assert.ok(nsids.includes("com.atproto.server.createSession"), "session must be established");
  assert.ok(!nsids.includes("com.atproto.repo.putRecord"), "create path never puts");
});
