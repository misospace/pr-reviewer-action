import test from "node:test";
import assert from "node:assert/strict";
import { readTangledCurrentHead, resolveTangledTicketIdentity, selectNewestPatchHead } from "../src/platform/tangled-head.js";
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
