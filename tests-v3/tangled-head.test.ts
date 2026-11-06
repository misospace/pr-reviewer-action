import test from "node:test";
import assert from "node:assert/strict";
import { readTangledCurrentHead, readTangledCurrentHeadForContext, resolveTangledTicketIdentity, selectNewestPatchHead } from "../src/platform/tangled-head.js";
import type { FetchLike } from "../src/platform/http.js";
import type { TangledContext } from "../src/platform/tangled.js";
import type { TangledPullIdentity } from "../src/platform/tangled-bobbin.js";

/**
 * Trusted current-head read (#1165) — knot org.tangled.review.patch records.
 */

const REPO_DID = "did:plc:repo";
const TICKET_RKEY = "3ticket";
const TICKET_URI = `at://did:plc:repo/org.tangled.track.ticket/${TICKET_RKEY}`;
const HEAD1 = "0123456789abcdef0123456789abcdef01234567";
const HEAD2 = "fedcba9876543210fedcba9876543210fedcba98";

function makeCtx(over: Partial<TangledContext> = {}): TangledContext {
  return {
    ownerDid: "did:plc:owner",
    repoDid: REPO_DID,
    repoName: "owner/repo",
    sourceBranch: "feat/x",
    targetBranch: "main",
    sourceSha: HEAD1,
    knotHost: "knot1.tangled.sh",
    bobbinUrl: "https://bobbin.test",
    ...over,
  };
}

const IDENTITY: TangledPullIdentity = {
  uri: TICKET_URI,
  cid: "bafyticket",
  rkey: TICKET_RKEY,
  record: {},
  repoDid: REPO_DID,
  authorDid: REPO_DID,
  targetBranch: "main",
  sourceBranch: "feat/x",
  sourceRepoDid: undefined,
  state: "open",
};

function patchItem(over: Record<string, unknown> = {}): { uri: string; cid: string; value: Record<string, unknown> } {
  const cid = String(over.cid ?? "bafypatch1");
  const value: Record<string, unknown> = {
    ticket: TICKET_RKEY,
    base: { oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    head: { oid: HEAD1 },
    source: { branch: "feat/x", repo: REPO_DID },
    createdAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
  delete value.cid;
  return { uri: `at://${REPO_DID}/org.tangled.review.patch/${cid}`, cid, value };
}

function makeFetch(records: unknown[], status = 200): { fetchImpl: FetchLike; calls: URL[] } {
  const calls: URL[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    return new Response(JSON.stringify({ records, cursor: null }), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

// ── pure selector ─────────────────────────────────────────────────────────

test("selector: newest patch by createdAt wins", () => {
  const items = [
    patchItem({ head: { oid: HEAD1 }, createdAt: "2026-11-01T00:00:00.000Z" }),
    patchItem({ cid: "bafypatch2", head: { oid: HEAD2 }, createdAt: "2026-11-02T00:00:00.000Z" }),
  ];
  assert.equal(selectNewestPatchHead(items, TICKET_RKEY, TICKET_URI), HEAD2);
});

test("selector: patches for other tickets are ignored", () => {
  const items = [patchItem({ ticket: "other", head: { oid: HEAD2 }, createdAt: "2026-11-03T00:00:00.000Z" })];
  assert.equal(selectNewestPatchHead(items, TICKET_RKEY, TICKET_URI), null);
});

test("selector: empty set yields null", () => {
  assert.equal(selectNewestPatchHead([], TICKET_RKEY, TICKET_URI), null);
});

test("selector: a createdAt tie with different heads is ambiguous (null)", () => {
  const items = [
    patchItem({ head: { oid: HEAD1 } }),
    patchItem({ cid: "bafypatch2", head: { oid: HEAD2 } }),
  ];
  assert.equal(selectNewestPatchHead(items, TICKET_RKEY, TICKET_URI), null);
});

test("selector: a createdAt tie with the same head is not ambiguous", () => {
  const items = [patchItem({}), patchItem({ cid: "bafypatch2" })];
  assert.equal(selectNewestPatchHead(items, TICKET_RKEY, TICKET_URI), HEAD1);
});

test("selector: 64-hex SHA-256 head OIDs are accepted (new Tangled repos)", () => {
  const sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  assert.equal(sha256.length, 64);
  const items = [patchItem({ head: { oid: sha256 } })];
  assert.equal(selectNewestPatchHead(items, TICKET_RKEY, TICKET_URI), sha256);
  // 41-hex and other lengths are still rejected.
  assert.equal(selectNewestPatchHead([patchItem({ head: { oid: "a".repeat(41) } })], TICKET_RKEY, TICKET_URI), null);
});

/** Fetch mock serving ticket and patch collections by query param. */
function makeCombinedFetch(
  tickets: unknown[],
  patches: unknown[],
): { fetchImpl: FetchLike } {
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(String(input));
    const collection = url.searchParams.get("collection");
    const records = collection === "org.tangled.track.ticket" ? tickets : patches;
    return new Response(JSON.stringify({ records, cursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl };
}

test("combined: multiple open PRs to the same target resolve by source branch", async () => {
  const tickets = [ticketItem({ rkey: "3mine" }), ticketItem({ rkey: "3other" })];
  const mine = patchItem({ ticket: "3mine", head: { oid: HEAD1 }, source: { branch: "feat/x", repo: REPO_DID } });
  const other = patchItem({ cid: "bafyother", ticket: "3other", head: { oid: HEAD2 }, source: { branch: "feat/other", repo: REPO_DID } });
  const { fetchImpl } = makeCombinedFetch(tickets, [mine, other]);
  // ctx.sourceBranch is "feat/x" — the combined reader must pick mine,
  // even though two tickets exist for the (implicit) same target.
  assert.equal(await readTangledCurrentHeadForContext(makeCtx(), { fetchImpl }), HEAD1);
});

test("combined: ambiguous source correlation disambiguates by unique reviewed-SHA history", async () => {
  const tickets = [ticketItem({ rkey: "3a" }), ticketItem({ rkey: "3b" })];
  const a = patchItem({ ticket: "3a", head: { oid: HEAD1 }, source: { branch: "feat/x", repo: REPO_DID } });
  const b = patchItem({ cid: "bafyb", ticket: "3b", head: { oid: HEAD2 }, source: { branch: "feat/x", repo: REPO_DID } });
  const { fetchImpl } = makeCombinedFetch(tickets, [a, b]);
  // Both correlate by source branch, but only 3a's history contains the
  // reviewed SHA (HEAD1), so the trusted newest head is 3a's.
  assert.equal(await readTangledCurrentHeadForContext(makeCtx(), { fetchImpl }), HEAD1);
});

test("combined: source-less patches work when the candidate is the sole open ticket", async () => {
  const tickets = [ticketItem({ rkey: "3mine" })];
  const noSource: Record<string, unknown> = { ...patchItem({ ticket: "3mine" }).value };
  delete noSource.source;
  const patch = { uri: patchItem({ ticket: "3mine" }).uri, cid: "bafypatch1", value: noSource };
  const { fetchImpl } = makeCombinedFetch(tickets, [patch]);
  assert.equal(await readTangledCurrentHeadForContext(makeCtx(), { fetchImpl }), HEAD1);
});

test("combined: 2 source-less open tickets, unique reviewed-SHA history match returns newest trusted head", async () => {
  const tickets = [ticketItem({ rkey: "3mine" }), ticketItem({ rkey: "3other" })];
  // ctx.sourceSha is HEAD1 (reviewed). Mine's history: older HEAD1, newest HEAD2.
  const mineOld: Record<string, unknown> = { ...patchItem({ ticket: "3mine", head: { oid: HEAD1 } }).value };
  delete mineOld.source;
  const mineNew: Record<string, unknown> = { ...patchItem({ ticket: "3mine", head: { oid: HEAD2 }, createdAt: "2026-11-02T00:00:00.000Z" }).value };
  delete mineNew.source;
  const other: Record<string, unknown> = { ...patchItem({ cid: "bafyother", ticket: "3other", head: { oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }).value };
  delete other.source;
  const patches = [
    { uri: patchItem({ ticket: "3mine" }).uri, cid: "bafypatch1", value: mineOld },
    { uri: patchItem({ cid: "bafypatch2", ticket: "3mine" }).uri, cid: "bafypatch2", value: mineNew },
    { uri: patchItem({ cid: "bafyother", ticket: "3other" }).uri, cid: "bafyother", value: other },
  ];
  const { fetchImpl } = makeCombinedFetch(tickets, patches);
  // Must return the newest trusted head (HEAD2), not the reviewed SHA.
  assert.equal(await readTangledCurrentHeadForContext(makeCtx(), { fetchImpl }), HEAD2);
});

test("combined: 2 same-source/target tickets — matching source.branch does NOT win over reviewed-SHA history", async () => {
  const tickets = [ticketItem({ rkey: "3a" }), ticketItem({ rkey: "3b" })];
  const bNewest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  // A: matching source.branch but history does NOT contain reviewed HEAD1.
  const a = patchItem({ ticket: "3a", head: { oid: HEAD2 }, source: { branch: "feat/x", repo: REPO_DID } });
  // B: source-less, history contains reviewed HEAD1, newest is bNewest.
  const bOld: Record<string, unknown> = { ...patchItem({ ticket: "3b", head: { oid: HEAD1 } }).value };
  delete bOld.source;
  const bNew: Record<string, unknown> = { ...patchItem({ cid: "bafyb2", ticket: "3b", head: { oid: bNewest }, createdAt: "2026-11-02T00:00:00.000Z" }).value };
  delete bNew.source;
  const patches = [
    a,
    { uri: patchItem({ ticket: "3b" }).uri, cid: "bafypatch1", value: bOld },
    { uri: patchItem({ cid: "bafyb2", ticket: "3b" }).uri, cid: "bafyb2", value: bNew },
  ];
  const { fetchImpl } = makeCombinedFetch(tickets, patches);
  assert.equal(await readTangledCurrentHeadForContext(makeCtx(), { fetchImpl }), bNewest);
});

test("combined: reviewed-SHA history fallback with zero matches fails closed", async () => {
  const tickets = [ticketItem({ rkey: "3mine" }), ticketItem({ rkey: "3other" })];
  const a: Record<string, unknown> = { ...patchItem({ ticket: "3mine", head: { oid: HEAD2 } }).value };
  delete a.source;
  const b: Record<string, unknown> = { ...patchItem({ cid: "bafyb", ticket: "3other", head: { oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }).value };
  delete b.source;
  const patches = [
    { uri: patchItem({ ticket: "3mine" }).uri, cid: "bafypatch1", value: a },
    { uri: patchItem({ cid: "bafyb", ticket: "3other" }).uri, cid: "bafyb", value: b },
  ];
  const { fetchImpl } = makeCombinedFetch(tickets, patches);
  // Reviewed HEAD1 appears in neither history.
  assert.equal(await readTangledCurrentHeadForContext(makeCtx(), { fetchImpl }), null);
});

test("combined: reviewed-SHA history fallback with multiple matches fails closed", async () => {
  const tickets = [ticketItem({ rkey: "3mine" }), ticketItem({ rkey: "3other" })];
  const a: Record<string, unknown> = { ...patchItem({ ticket: "3mine", head: { oid: HEAD1 } }).value };
  delete a.source;
  const b: Record<string, unknown> = { ...patchItem({ cid: "bafyb", ticket: "3other", head: { oid: HEAD1 } }).value };
  delete b.source;
  const patches = [
    { uri: patchItem({ ticket: "3mine" }).uri, cid: "bafypatch1", value: a },
    { uri: patchItem({ cid: "bafyb", ticket: "3other" }).uri, cid: "bafyb", value: b },
  ];
  const { fetchImpl } = makeCombinedFetch(tickets, patches);
  assert.equal(await readTangledCurrentHeadForContext(makeCtx(), { fetchImpl }), null);
});

test("combined: >10 historical tickets do not block the current pull", async () => {
  const historical = Array.from({ length: 12 }, (_, i) => ticketItem({ rkey: `3hist${i}`, state: "closed" }));
  const tickets = [...historical, ticketItem({ rkey: "3mine" })];
  const mine = patchItem({ ticket: "3mine", head: { oid: HEAD1 }, source: { branch: "feat/x", repo: REPO_DID } });
  const { fetchImpl } = makeCombinedFetch(tickets, [mine]);
  assert.equal(await readTangledCurrentHeadForContext(makeCtx(), { fetchImpl }), HEAD1);
});

test("selector: a patch with a missing or malformed ticket fails closed (not ignored)", () => {
  const missing = patchItem({});
  delete missing.value.ticket;
  assert.equal(selectNewestPatchHead([missing], TICKET_RKEY, TICKET_URI), null);
  assert.equal(selectNewestPatchHead([patchItem({ ticket: 42 })], TICKET_RKEY, TICKET_URI), null);
});

test("selector: source-branch correlation binds the patch to this pull", () => {
  const wrong = patchItem({ source: { branch: "other/branch", repo: REPO_DID } });
  assert.equal(selectNewestPatchHead([wrong], TICKET_RKEY, TICKET_URI, "feat/x"), null);
  const noSource: Record<string, unknown> = { ...patchItem({}).value };
  delete noSource.source;
  assert.equal(
    selectNewestPatchHead([{ uri: patchItem({}).uri, cid: "bafy", value: noSource }], TICKET_RKEY, TICKET_URI, "feat/x"),
    null,
  );
  // Without an expected source branch, the correlation check is skipped.
  assert.equal(selectNewestPatchHead([wrong], TICKET_RKEY, TICKET_URI), HEAD1);
});

test("selector: malformed head/createdAt on a matching patch fails closed", () => {
  assert.equal(
    selectNewestPatchHead([patchItem({ head: { oid: "not-a-sha" } })], TICKET_RKEY, TICKET_URI),
    null,
  );
  assert.equal(
    selectNewestPatchHead([patchItem({ createdAt: "garbage" })], TICKET_RKEY, TICKET_URI),
    null,
  );
  assert.equal(
    selectNewestPatchHead([patchItem({ head: "0123456789abcdef0123456789abcdef0123456789" })], TICKET_RKEY, TICKET_URI),
    null,
  );
});

// ── knot read ─────────────────────────────────────────────────────────────

test("read: returns the newest patch head from the knot listRecords", async () => {
  const { fetchImpl, calls } = makeFetch([
    patchItem({}),
    patchItem({ cid: "bafypatch2", head: { oid: HEAD2 }, createdAt: "2026-11-02T00:00:00.000Z" }),
  ]);
  const head = await readTangledCurrentHead(makeCtx(), IDENTITY, { fetchImpl });
  assert.equal(head, HEAD2);
  assert.equal(calls.length, 1);
  const url = calls[0]!;
  assert.equal(url.hostname, "knot1.tangled.sh");
  assert.equal(url.pathname, "/xrpc/com.atproto.repo.listRecords");
  assert.equal(url.searchParams.get("repo"), REPO_DID);
  assert.equal(url.searchParams.get("collection"), "org.tangled.review.patch");
});

test("read: missing knot host or repo DID yields null without a request", async () => {
  const { fetchImpl, calls } = makeFetch([patchItem({})]);
  assert.equal(await readTangledCurrentHead(makeCtx({ knotHost: undefined }), IDENTITY, { fetchImpl }), null);
  assert.equal(await readTangledCurrentHead(makeCtx({ repoDid: undefined }), IDENTITY, { fetchImpl }), null);
  assert.equal(calls.length, 0);
});

test("read: non-2xx and transport failures yield null", async () => {
  const notFound = makeFetch([], 404);
  assert.equal(await readTangledCurrentHead(makeCtx(), IDENTITY, { fetchImpl: notFound.fetchImpl }), null);
  const throwing: FetchLike = async () => {
    throw new TypeError("network");
  };
  assert.equal(await readTangledCurrentHead(makeCtx(), IDENTITY, { fetchImpl: throwing }), null);
});

test("read: a head that advanced past the launch-time SHA is returned, not echoed", async () => {
  const { fetchImpl } = makeFetch([
    patchItem({ head: { oid: HEAD2 }, createdAt: "2026-11-02T00:00:00.000Z" }),
  ]);
  const head = await readTangledCurrentHead(makeCtx(), IDENTITY, { fetchImpl });
  assert.equal(head, HEAD2);
  assert.notEqual(head, makeCtx().sourceSha);
});

test("read: a patch record from a foreign repo account is rejected (no cross-repo head)", async () => {
  const foreign = patchItem({});
  foreign.uri = "at://did:plc:other-repo/org.tangled.review.patch/bafypatch1";
  const { fetchImpl } = makeFetch([foreign]);
  assert.equal(await readTangledCurrentHead(makeCtx(), IDENTITY, { fetchImpl }), null);
});

test("read: pagination beyond MAX_PAGES fails closed without unbounded requests", async () => {
  let count = 0;
  const fetchImpl: FetchLike = async () => {
    count += 1;
    return new Response(JSON.stringify({ records: [patchItem({})], cursor: "never-ending" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  assert.equal(await readTangledCurrentHead(makeCtx(), IDENTITY, { fetchImpl }), null);
  assert.equal(count, 10, "exactly MAX_PAGES requests, then fail closed");
});

test("read: an oversized response body is capped (bounded read, no unbounded buffering)", async () => {
  const huge = "x".repeat(33 * 1024 * 1024);
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ records: [], cursor: null, pad: huge }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  assert.equal(await readTangledCurrentHead(makeCtx(), IDENTITY, { fetchImpl }), null);
});

// ── ticket identity resolution (production path) ──────────────────────────

function ticketItem(over: Record<string, unknown> = {}): { uri: string; cid: string; value: Record<string, unknown> } {
  const rkey = String(over.rkey ?? TICKET_RKEY);
  const value: Record<string, unknown> = {
    title: "t",
    state: "open",
    targetBranch: "main",
    createdAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
  delete value.rkey;
  return { uri: `at://${REPO_DID}/org.tangled.track.ticket/${rkey}`, cid: "bafyticket", value };
}

test("ticket: resolves the unique open ticket for the target branch", async () => {
  const { fetchImpl } = makeFetch([ticketItem({})]);
  const ticket = await resolveTangledTicketIdentity(makeCtx(), { fetchImpl });
  assert.deepEqual(ticket, { rkey: TICKET_RKEY, uri: TICKET_URI });
});

test("ticket: zero or multiple open tickets fail closed (null)", async () => {
  const zero = makeFetch([ticketItem({ state: "closed" })]);
  assert.equal(await resolveTangledTicketIdentity(makeCtx(), { fetchImpl: zero.fetchImpl }), null);
  const two = makeFetch([ticketItem({}), ticketItem({ rkey: "3other" })]);
  assert.equal(await resolveTangledTicketIdentity(makeCtx(), { fetchImpl: two.fetchImpl }), null);
});

test("ticket: a foreign-repo ticket record is rejected", async () => {
  const foreign = ticketItem({});
  foreign.uri = "at://did:plc:other-repo/org.tangled.track.ticket/3ticket";
  const { fetchImpl } = makeFetch([foreign]);
  assert.equal(await resolveTangledTicketIdentity(makeCtx(), { fetchImpl }), null);
});

test("read: malformed listRecords payloads yield null (hostile boundary)", async () => {
  for (const payload of [{ records: "nope" }, { records: [{ uri: "not-a-uri", value: {} }] }, [], null]) {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    assert.equal(await readTangledCurrentHead(makeCtx(), IDENTITY, { fetchImpl }), null);
  }
});
