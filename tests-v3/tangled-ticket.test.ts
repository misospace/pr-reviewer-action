import test from "node:test";
import assert from "node:assert/strict";
import { resolveTangledReviewIdentity } from "../src/platform/tangled-ticket.js";
import { TangledResolverError } from "../src/platform/tangled-bobbin.js";
import type { FetchLike } from "../src/platform/http.js";
import type { TangledContext } from "../src/platform/tangled.js";

/**
 * Review-identity resolution on the CURRENT record model (#1690 protocol
 * pivot): one open `org.tangled.track.ticket` pull request + its newest
 * immutable `org.tangled.review.patch` revision, read from the repository
 * account on the knot and selected fail-closed.
 */

const REPO_DID = "did:plc:repo";
const BASE = "1111111111111111111111111111111111111111";
const HEAD = "2222222222222222222222222222222222222222";

function makeCtx(over: Partial<TangledContext> = {}): TangledContext {
  return {
    ownerDid: REPO_DID,
    repoDid: REPO_DID,
    repoName: "owner/repo",
    sourceBranch: "feat/x",
    targetBranch: "main",
    sourceSha: HEAD,
    knotHost: "knot1.tangled.sh",
    bobbinUrl: "https://bobbin.test",
    ...over,
  };
}

function ticket(over: {
  rkey?: string;
  state?: string;
  targetBranch?: string | null;
  value?: Record<string, unknown>;
} = {}): { uri: string; cid?: string; value: Record<string, unknown>; rkey: string } {
  const rkey = over.rkey ?? "3lzq4w5qk2c2a";
  const value: Record<string, unknown> = {
    $type: "org.tangled.track.ticket",
    title: "Pull request ticket",
    createdAt: "2026-01-02T03:04:05Z",
    state: over.state ?? "open",
    ...(over.targetBranch === null ? {} : { targetBranch: over.targetBranch ?? "main" }),
    ...over.value,
  };
  return { uri: `at://${REPO_DID}/org.tangled.track.ticket/${rkey}`, cid: "bafyreiticket", value, rkey };
}

function patch(over: {
  ticket?: string;
  baseOid?: string | null;
  headOid?: string | null;
  createdAt?: string;
  cid?: string;
  source?: Record<string, unknown> | null;
  value?: Record<string, unknown>;
} = {}): { uri: string; cid?: string; value: Record<string, unknown>; rkey: string } {
  const cid = over.cid ?? "bafyreipatch1";
  const value: Record<string, unknown> = {
    $type: "org.tangled.review.patch",
    ticket: over.ticket ?? `at://${REPO_DID}/org.tangled.track.ticket/3lzq4w5qk2c2a`,
    ...(over.baseOid === null ? {} : { base: { oid: over.baseOid ?? BASE } }),
    ...(over.headOid === null ? {} : { head: { oid: over.headOid ?? HEAD } }),
    createdAt: over.createdAt ?? "2026-01-02T03:04:05Z",
    ...(over.source === null ? {} : { source: over.source ?? { repo: REPO_DID, branch: "feat/x" } }),
    ...over.value,
  };
  // The lexicon's record key IS the record's own CID.
  return { uri: `at://${REPO_DID}/org.tangled.review.patch/${cid}`, cid, value, rkey: cid };
}

function makeKnotFetch(
  tickets: { uri: string; cid?: string; value: Record<string, unknown>; rkey: string }[],
  patches: { uri: string; cid?: string; value: Record<string, unknown>; rkey: string }[],
): FetchLike {
  return async (input) => {
    const url = new URL(String(input));
    const collection = url.searchParams.get("collection");
    if (url.searchParams.get("repo") !== REPO_DID) {
      return new Response(JSON.stringify({ error: "unknown repo" }), { status: 400 });
    }
    const items = collection === "org.tangled.track.ticket" ? tickets
      : collection === "org.tangled.review.patch" ? patches
      : undefined;
    if (items === undefined) return new Response(JSON.stringify({ error: "unknown collection" }), { status: 400 });
    return new Response(
      JSON.stringify({ records: items.map(({ uri, cid, value }) => ({ uri, cid, value })) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

async function resolve(
  ctx: TangledContext,
  tickets: Parameters<typeof makeKnotFetch>[0],
  patches: Parameters<typeof makeKnotFetch>[1],
): Promise<Awaited<ReturnType<typeof resolveTangledReviewIdentity>>> {
  return resolveTangledReviewIdentity(ctx, { fetchImpl: makeKnotFetch(tickets, patches) });
}

test("a single open pull-request ticket with its newest patch resolves to the review identity", async () => {
  const identity = await resolve(makeCtx(), [ticket()], [
    patch({ createdAt: "2026-01-01T00:00:00Z", cid: "old", headOid: "3".repeat(40) }),
    patch({ createdAt: "2026-01-02T00:00:00Z" }), // newest wins
  ]);
  assert.equal(identity.ticketUri, `at://${REPO_DID}/org.tangled.track.ticket/3lzq4w5qk2c2a`);
  assert.equal(identity.ticketRkey, "3lzq4w5qk2c2a");
  assert.equal(identity.patchUri, `at://${REPO_DID}/org.tangled.review.patch/bafyreipatch1`);
  assert.equal(identity.baseOid, BASE);
  assert.equal(identity.headOid, HEAD);
  assert.equal(identity.targetBranch, "main");
  assert.equal(identity.sourceBranch, "feat/x");
  assert.equal(identity.sourceRepoDid, REPO_DID);
  assert.equal(identity.state, "open");
});

test("a ticket may reference its patches by record key as well as by full AT-URI", async () => {
  const identity = await resolve(makeCtx(), [ticket()], [patch({ ticket: "3lzq4w5qk2c2a" })]);
  assert.equal(identity.headOid, HEAD);
});

test("a 64-hex (SHA-256) patch revision resolves with its oids intact", async () => {
  const base256 = `a${"1".repeat(63)}`;
  const head256 = `b${"2".repeat(63)}`;
  const identity = await resolve(
    makeCtx({ sourceSha: head256 }),
    [ticket()],
    [patch({ baseOid: base256, headOid: head256 })],
  );
  assert.equal(identity.baseOid, base256);
  assert.equal(identity.headOid, head256);
});

test("issues (tickets without targetBranch) are never candidates", async () => {
  await assert.rejects(
    () => resolve(makeCtx(), [ticket({ targetBranch: null })], [patch()]),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "no-match",
  );
});

test("zero or non-matching candidates fail closed", async () => {
  await assert.rejects(
    () => resolve(makeCtx(), [], []),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "no-match",
  );
  await assert.rejects(
    () => resolve(makeCtx(), [ticket({ state: "closed" })], [patch()]),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "no-match",
    "a closed ticket is not a candidate",
  );
  await assert.rejects(
    () => resolve(makeCtx(), [ticket({ targetBranch: "develop" })], [patch()]),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "no-match",
  );
});

test("a ticket without any patch revision fails closed", async () => {
  await assert.rejects(
    () => resolve(makeCtx(), [ticket()], []),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "no-match",
  );
});

test("multiple open tickets to the same target resolve only through the reviewed head in exactly one patch history", async () => {
  const shared = [
    patch({ cid: "one", createdAt: "2026-01-02T00:00:00Z" }),
    patch({ cid: "two", createdAt: "2026-01-03T00:00:00Z", ticket: "3lzzzzzzzzzzzzb", headOid: "9".repeat(40) }),
  ];
  const tickets = [
    ticket(),
    ticket({ rkey: "3lzzzzzzzzzzzzb" }),
  ];
  const identity = await resolve(makeCtx(), tickets, shared);
  assert.equal(identity.ticketUri, `at://${REPO_DID}/org.tangled.track.ticket/3lzq4w5qk2c2a`,
    "the candidate whose patch history contains the reviewed head wins");
});

test("multiple open tickets with no reviewed head to disambiguate fail closed", async () => {
  const tickets = [ticket(), ticket({ rkey: "3lzzzzzzzzzzzzb" })];
  await assert.rejects(
    () => resolve(makeCtx({ sourceSha: undefined }), tickets, [
      patch({ cid: "one" }),
      patch({ cid: "two", ticket: "3lzzzzzzzzzzzzb" }),
    ]),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "ambiguous",
  );
  await assert.rejects(
    () => resolve(makeCtx(), tickets, [
      patch({ cid: "one", headOid: "9".repeat(40) }),
      patch({ cid: "two", ticket: "3lzzzzzzzzzzzzb", headOid: "8".repeat(40) }),
    ]),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "ambiguous",
    "the reviewed head appears in NEITHER history → ambiguous",
  );
});

test("a createdAt tie between distinct patches fails closed as ambiguous", async () => {
  await assert.rejects(
    () => resolve(makeCtx(), [ticket()], [
      patch({ cid: "one", createdAt: "2026-01-02T00:00:00Z" }),
      patch({ cid: "two", createdAt: "2026-01-02T00:00:00Z" }),
    ]),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "ambiguous",
  );
});

test("malformed patch state fails closed instead of degrading to an older revision", async () => {
  // The NEWEST patch is malformed: no usable head. The run must stop, not
  // silently review the older valid revision.
  await assert.rejects(
    () => resolve(makeCtx(), [ticket()], [
      patch({ cid: "old", createdAt: "2026-01-01T00:00:00Z" }),
      patch({ cid: "new", createdAt: "2026-01-02T00:00:00Z", headOid: null }),
    ]),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "invalid-response",
  );
  await assert.rejects(
    () => resolve(makeCtx(), [ticket()], [patch({ value: { ticket: 42 } })]),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "invalid-response",
    "a patch without a ticket reference cannot be proven foreign",
  );
  await assert.rejects(
    () => resolve(makeCtx(), [ticket()], [patch({ baseOid: "zz-not-an-oid" })]),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "invalid-response",
  );
});

test("a missing knot host or repo DID fails closed with the config named", async () => {
  await assert.rejects(
    () => resolve(makeCtx({ knotHost: undefined }), [ticket()], [patch()]),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "config" && /TANGLED_REPO_KNOT/.test(e.message),
  );
  await assert.rejects(
    () => resolve(makeCtx({ repoDid: undefined }), [ticket()], [patch()]),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "config",
  );
});

test("an unreadable knot fails closed as read-failed", async () => {
  const dead: FetchLike = async () => {
    throw new TypeError("network down");
  };
  await assert.rejects(
    () => resolveTangledReviewIdentity(makeCtx(), { fetchImpl: dead }),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "read-failed",
  );
});
