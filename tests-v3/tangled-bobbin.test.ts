import test from "node:test";
import assert from "node:assert/strict";
import { parseTangledAtUri, resolveTangledPull, TangledResolverError } from "../src/platform/tangled-bobbin.js";
import type { FetchLike } from "../src/platform/http.js";
import type { TangledContext } from "../src/platform/tangled.js";

/**
 * Read-side Bobbin client + canonical Tangled pull resolver (#584),
 * exercised through an injected mock transport — no network.
 */

const PULL_URI = "at://did:plc:author/sh.tangled.repo.pull/3mxa";

/** One XRPC call captured by the mock transport. */
interface Call {
  url: URL;
  nsid: string;
  query: Record<string, string>;
  auth: string | null;
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
    const headers = new Headers(init?.headers);
    calls.push({ url, nsid, query, auth: headers.get("authorization") });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function makeCtx(over: Partial<TangledContext> = {}): TangledContext {
  return {
    ownerDid: "did:plc:owner",
    repoDid: "did:plc:repo",
    repoName: "owner/repo",
    sourceBranch: "feat/x",
    targetBranch: "main",
    sourceSha: "0123456789abcdef0123456789abcdef0123456789abcdef",
    knotHost: "knot1.tangled.sh",
    bobbinUrl: "https://bobbin.test",
    ...over,
  };
}

const GET_PULL_OK = {
  uri: PULL_URI,
  cid: "bafyreicid",
  value: {
    title: "t",
    createdAt: "2026-01-01T00:00:00Z",
    target: { branch: "main", repo: "did:plc:repo", repoDid: "did:plc:repo" },
    source: { branch: "feat/x" },
  },
};

const listItem = (
  uri: string,
  cid: string | null,
  state: string,
  targetBranch: string,
  sourceBranch: string,
): Record<string, unknown> => ({
  uri,
  cid,
  state,
  value: {
    target: { branch: targetBranch, repo: "did:plc:repo" },
    source: { branch: sourceBranch },
  },
  commentCount: 0,
});

const LIST_ONE = {
  items: [listItem("at://did:plc:author/sh.tangled.repo.pull/3mxb", "bafyrei2", "open", "main", "feat/x")],
  cursor: null,
};

// ── parseTangledAtUri ───────────────────────────────────────────────────

test("parseTangledAtUri: valid full uri, with and without ?cid=", () => {
  const plain = parseTangledAtUri(PULL_URI);
  assert.deepEqual(plain, { did: "did:plc:author", collection: "sh.tangled.repo.pull", rkey: "3mxa" });
  assert.equal("cid" in plain, false, "cid property must be absent without a query");
  const pinned = parseTangledAtUri(`${PULL_URI}?cid=bafyrei999`);
  assert.equal(pinned.did, "did:plc:author");
  assert.equal(pinned.collection, "sh.tangled.repo.pull");
  assert.equal(pinned.rkey, "3mxa");
  assert.equal("cid" in pinned, true);
  assert.equal(pinned.cid, "bafyrei999");
});

test("parseTangledAtUri: malformed shapes are invalid-uri", () => {
  const bad = [
    "https://bobbin.test/pull/3mxa", // no at:// prefix
    "at://did:plc:author/sh.tangled.repo.pull", // 2 segments
    "at://did:plc:author/sh.tangled.repo.pull/3mxa/extra", // 4 segments
    "at://user:abc/sh.tangled.repo.pull/3mxa", // did not starting with did:
    "at://did::x/sh.tangled.repo.pull/3mxa", // empty DID method
    "at://did:plc:author//3mxa", // empty collection
    "at://did:plc:author/sh.tangled.repo.pull/", // empty rkey
  ];
  for (const uri of bad) {
    assert.throws(
      () => parseTangledAtUri(uri),
      (e: unknown) => e instanceof TangledResolverError && e.kind === "invalid-uri",
      uri,
    );
  }
});

// ── config failures ───────────────────────────────────────────────────────

test("resolveTangledPull: missing bobbinUrl is a config error", async () => {
  await assert.rejects(
    resolveTangledPull(makeCtx({ bobbinUrl: undefined }), {}),
    (e: unknown) =>
      e instanceof TangledResolverError && e.kind === "config" && e.message.includes("TANGLED_BOBBIN_URL"),
    "expected a config error naming TANGLED_BOBBIN_URL",
  );
});

test("resolveTangledPull (list path): missing repoDid is a config error", async () => {
  const { fetchImpl, calls } = makeFetch(() => json(LIST_ONE));
  await assert.rejects(
    resolveTangledPull(makeCtx({ repoDid: undefined }), { fetchImpl }),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "config",
    "expected a config error",
  );
  assert.equal(calls.length, 0, "no request may leave the process on a config error");
});

test("resolveTangledPull (list path): neither branch is a config error", async () => {
  await assert.rejects(
    resolveTangledPull(makeCtx({ sourceBranch: undefined, targetBranch: undefined }), {}),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "config",
    "expected a config error",
  );
});

// ── explicit pullUri (getPull) ───────────────────────────────────────────

test("resolveTangledPull: explicit pullUri resolves the full identity", async () => {
  const ctx = makeCtx();
  const { fetchImpl, calls } = makeFetch(() => json(GET_PULL_OK));
  const identity = await resolveTangledPull(ctx, { pullUri: PULL_URI, fetchImpl });
  assert.equal(identity.uri, PULL_URI);
  assert.equal(identity.cid, "bafyreicid");
  assert.equal(identity.rkey, "3mxa");
  assert.equal(identity.repoDid, "did:plc:repo");
  assert.equal(identity.authorDid, "did:plc:author");
  assert.equal(identity.targetBranch, "main");
  assert.equal(identity.sourceBranch, "feat/x");
  assert.equal(identity.sourceRepoDid, undefined);
  assert.equal(identity.state, undefined);
  assert.equal(identity.sourceSha, ctx.sourceSha);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.nsid, "sh.tangled.repo.getPull");
  assert.equal(calls[0]!.query.pull, PULL_URI);
});

test("resolveTangledPull: an embedded ?cid= in the pull URI wins over the response cid", async () => {
  const { fetchImpl } = makeFetch(() => json(GET_PULL_OK));
  const identity = await resolveTangledPull(makeCtx(), {
    pullUri: `${PULL_URI}?cid=cidFromUri`,
    fetchImpl,
  });
  assert.equal(identity.cid, "cidFromUri");
});

test("resolveTangledPull: a non-pull collection is rejected before any request", async () => {
  const { fetchImpl, calls } = makeFetch(() => {
    throw new Error("fetch must not be called");
  });
  await assert.rejects(
    resolveTangledPull(makeCtx(), {
      pullUri: "at://did:plc:author/sh.tangled.repo.notapull/3mxa",
      fetchImpl,
    }),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "invalid-uri",
    "expected invalid-uri",
  );
  assert.equal(calls.length, 0);
});

test("resolveTangledPull: explicit pull targeting a different repo is invalid-uri", async () => {
  const { fetchImpl } = makeFetch(() => json(GET_PULL_OK)); // value.target.repo = did:plc:repo
  await assert.rejects(
    resolveTangledPull(makeCtx({ repoDid: "did:plc:other" }), { pullUri: PULL_URI, fetchImpl }),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "invalid-uri",
    "expected the repo cross-check to fail",
  );
});

test("resolveTangledPull: a 404 getPull is a no-match", async () => {
  const { fetchImpl } = makeFetch(() => json({ message: "not found" }, 404));
  await assert.rejects(
    resolveTangledPull(makeCtx(), { pullUri: PULL_URI, fetchImpl }),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "no-match",
    "expected no-match",
  );
});

test("resolveTangledPull: a non-2xx getPull with a success-shaped body is a read-failed", async () => {
  const { fetchImpl } = makeFetch(() => json(GET_PULL_OK, 500));
  await assert.rejects(
    resolveTangledPull(makeCtx(), { pullUri: PULL_URI, fetchImpl }),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "read-failed",
    "expected read-failed for a 500 with a success-shaped body",
  );
});

test("resolveTangledPull: a getPull body echoing a different uri is not trusted", async () => {
  const echoed = {
    uri: "at://did:plc:eve/sh.tangled.repo.pull/zzzz",
    cid: "c",
    value: GET_PULL_OK.value,
  };
  const { fetchImpl } = makeFetch(() => json(echoed));
  const identity = await resolveTangledPull(makeCtx(), { pullUri: PULL_URI, fetchImpl });
  assert.equal(identity.uri, PULL_URI);
  assert.equal(identity.authorDid, "did:plc:author");
  assert.equal(identity.rkey, "3mxa");
});

test("resolveTangledPull: a getPull body with state is carried into the identity", async () => {
  const { fetchImpl } = makeFetch(() => json({ ...GET_PULL_OK, state: "open" }));
  const identity = await resolveTangledPull(makeCtx(), { pullUri: PULL_URI, fetchImpl });
  assert.equal(identity.state, "open");
});

test("resolveTangledPull: a getPull body with no CID is an invalid-response", async () => {
  const noCid = { uri: PULL_URI, value: GET_PULL_OK.value };
  const { fetchImpl } = makeFetch(() => json(noCid));
  await assert.rejects(
    resolveTangledPull(makeCtx(), { pullUri: PULL_URI, fetchImpl }),
    (e: unknown) =>
      e instanceof TangledResolverError && e.kind === "invalid-response" && e.message.includes("no CID"),
    "expected the no-CID invalid-response",
  );
});

// ── list path (listPulls) ────────────────────────────────────────────────

test("resolveTangledPull (list): a unique open match resolves, authorDid from the item uri", async () => {
  const { fetchImpl, calls } = makeFetch(() => json(LIST_ONE));
  const identity = await resolveTangledPull(makeCtx(), { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.nsid, "sh.tangled.repo.listPulls");
  assert.equal(calls[0]!.query.subject, "did:plc:repo");
  assert.equal(identity.uri, "at://did:plc:author/sh.tangled.repo.pull/3mxb");
  assert.equal(identity.rkey, "3mxb");
  assert.equal(identity.authorDid, "did:plc:author");
  assert.equal(identity.cid, "bafyrei2");
  assert.equal(identity.state, "open");
  assert.equal(identity.sourceBranch, "feat/x");
  assert.equal(identity.targetBranch, "main");
  assert.equal(identity.repoDid, "did:plc:repo");
});

test("resolveTangledPull (list): paginates through every page before deciding", async () => {
  const page1 = {
    items: [
      listItem("at://did:plc:other/sh.tangled.repo.pull/3zoo", "bafyrei-other", "open", "main", "feat/other"),
      listItem("at://did:plc:author/sh.tangled.repo.pull/3mxb", "bafyrei2", "open", "main", "feat/x"),
    ],
    cursor: "PAGE2",
  };
  const page2 = {
    items: [listItem("at://did:plc:decoy/sh.tangled.repo.pull/3decoy", "bafyrei-decoy", "open", "main", "feat/decoy")],
    cursor: null,
  };
  const { fetchImpl, calls } = makeFetch((url) =>
    url.searchParams.get("cursor") === "PAGE2" ? json(page2) : json(page1),
  );
  const identity = await resolveTangledPull(makeCtx(), { fetchImpl });
  assert.equal(calls.length, 2, "expected two listPulls pages");
  for (const call of calls) assert.equal(call.nsid, "sh.tangled.repo.listPulls");
  assert.equal(calls[0]!.query.cursor, undefined, "first page has no cursor");
  assert.equal(calls[1]!.query.cursor, "PAGE2", "second page follows the cursor");
  assert.equal(identity.rkey, "3mxb");
  assert.equal(identity.authorDid, "did:plc:author");
});

test("resolveTangledPull (list): no branch match is a no-match", async () => {
  const body = {
    items: [listItem("at://did:plc:author/sh.tangled.repo.pull/3zoo", "bafyrei-other", "open", "main", "feat/other")],
    cursor: null,
  };
  const { fetchImpl } = makeFetch(() => json(body));
  await assert.rejects(
    resolveTangledPull(makeCtx(), { fetchImpl }),
    (e: unknown) =>
      e instanceof TangledResolverError && e.kind === "no-match" && e.message.includes("no Tangled pull"),
    "expected the no-match message",
  );
});

test("resolveTangledPull (list): a branch match in the wrong state is a no-match naming the states seen", async () => {
  const body = {
    items: [listItem("at://did:plc:author/sh.tangled.repo.pull/3mxb", "bafyrei2", "merged", "main", "feat/x")],
    cursor: null,
  };
  const { fetchImpl } = makeFetch(() => json(body));
  await assert.rejects(
    resolveTangledPull(makeCtx(), { fetchImpl }),
    (e: unknown) =>
      e instanceof TangledResolverError && e.kind === "no-match" && e.message.includes("states seen"),
    "expected the states-seen no-match",
  );
});

test("resolveTangledPull (list): two open matches on the same branches are ambiguous", async () => {
  const body = {
    items: [
      listItem("at://did:plc:author/sh.tangled.repo.pull/3mxb", "bafyrei2", "open", "main", "feat/x"),
      listItem("at://did:plc:author/sh.tangled.repo.pull/3mxc", "bafyrei3", "open", "main", "feat/x"),
    ],
    cursor: null,
  };
  const { fetchImpl } = makeFetch(() => json(body));
  await assert.rejects(
    resolveTangledPull(makeCtx(), { fetchImpl }),
    (e: unknown) =>
      e instanceof TangledResolverError &&
      e.kind === "ambiguous" &&
      e.message.includes("at://did:plc:author/sh.tangled.repo.pull/3mxb") &&
      e.message.includes("at://did:plc:author/sh.tangled.repo.pull/3mxc"),
    "expected the ambiguous message to name both uris",
  );
});

test("resolveTangledPull (list): the states option narrows which state may match", async () => {
  const body = {
    items: [
      listItem("at://did:plc:author/sh.tangled.repo.pull/3mxb", "bafyrei2", "open", "main", "feat/x"),
      listItem("at://did:plc:author/sh.tangled.repo.pull/3mxc", "bafyrei3", "open", "main", "feat/x"),
      listItem("at://did:plc:author/sh.tangled.repo.pull/3mxd", "bafyrei4", "merged", "main", "feat/x"),
    ],
    cursor: null,
  };
  const { fetchImpl } = makeFetch(() => json(body));
  const identity = await resolveTangledPull(makeCtx(), { fetchImpl, states: ["merged"] });
  assert.equal(identity.rkey, "3mxd");
  assert.equal(identity.state, "merged");
  assert.equal(identity.authorDid, "did:plc:author");
});

test("resolveTangledPull (list): malformed listPulls responses are invalid-response", async () => {
  const arrayBody = makeFetch(() => json([{ uri: "x" }]));
  await assert.rejects(
    resolveTangledPull(makeCtx(), { fetchImpl: arrayBody.fetchImpl }),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "invalid-response",
    "a JSON array is not a listPulls object",
  );
  const noValue = makeFetch(() =>
    json({ items: [{ uri: "at://did:plc:author/sh.tangled.repo.pull/3mxb" }], cursor: null }),
  );
  await assert.rejects(
    resolveTangledPull(makeCtx(), { fetchImpl: noValue.fetchImpl }),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "invalid-response",
    "an item without value is invalid",
  );
});

test("resolveTangledPull (list): a transport rejection is a read-failed", async () => {
  const { fetchImpl } = makeFetch(() => {
    throw new TypeError("network");
  });
  await assert.rejects(
    resolveTangledPull(makeCtx(), { fetchImpl }),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "read-failed",
    "expected read-failed, not 404/no-match",
  );
});

test("resolveTangledPull (list): a non-2xx listPulls with a success-shaped body is a read-failed", async () => {
  const { fetchImpl } = makeFetch(() => json(LIST_ONE, 403));
  await assert.rejects(
    resolveTangledPull(makeCtx(), { fetchImpl }),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "read-failed",
    "expected read-failed for a 403 with a success-shaped body",
  );
});

test("resolveTangledPull (list): a 404 listPulls is a read-failed, not a no-match", async () => {
  const { fetchImpl } = makeFetch(() => json({ message: "not found" }, 404));
  await assert.rejects(
    resolveTangledPull(makeCtx(), { fetchImpl }),
    (e: unknown) => e instanceof TangledResolverError && e.kind === "read-failed",
    "expected read-failed, not no-match, for a 404 list",
  );
});

test("resolveTangledPull (list): a uri repeated across pages is deduped, not ambiguous", async () => {
  const dupUri = "at://did:plc:author/sh.tangled.repo.pull/3dup";
  const page1 = {
    items: [listItem(dupUri, "bafyrei-dup", "open", "main", "feat/x")],
    cursor: "P2",
  };
  const page2 = {
    items: [listItem(dupUri, "bafyrei-dup", "open", "main", "feat/x")],
    cursor: null,
  };
  const { fetchImpl, calls } = makeFetch((url) =>
    url.searchParams.get("cursor") === "P2" ? json(page2) : json(page1),
  );
  const identity = await resolveTangledPull(makeCtx(), { fetchImpl });
  assert.equal(calls.length, 2, "expected two listPulls pages");
  assert.equal(identity.uri, dupUri);
  assert.equal(identity.rkey, "3dup");
});

test("resolveTangledPull (list): a malformed item uri is an invalid-response", async () => {
  const body = {
    items: [listItem("pull/3mxb", "bafyrei2", "open", "main", "feat/x")],
    cursor: null,
  };
  const { fetchImpl } = makeFetch(() => json(body));
  await assert.rejects(
    resolveTangledPull(makeCtx(), { fetchImpl }),
    (e: unknown) =>
      e instanceof TangledResolverError && e.kind === "invalid-response" && e.message.includes("invalid AT-URI"),
    "expected the invalid AT-URI invalid-response",
  );
});

test("resolveTangledPull (list): pagination is bounded by MAX_PAGES", async () => {
  const loop = {
    items: [listItem("at://did:plc:author/sh.tangled.repo.pull/3zoo", "bafyrei-x", "open", "main", "feat/other")],
    cursor: "LOOP",
  };
  const { fetchImpl, calls } = makeFetch(() => json(loop));
  await assert.rejects(
    resolveTangledPull(makeCtx(), { fetchImpl }),
    (e: unknown) =>
      e instanceof TangledResolverError && e.kind === "read-failed" && e.message.includes("50"),
    "expected the MAX_PAGES read-failed",
  );
  assert.equal(calls.length, 50, "expected exactly MAX_PAGES requests");
});

// ── credential transport ─────────────────────────────────────────────────

test("resolveTangledPull: the token travels only as Authorization to the Bobbin origin", async () => {
  const get = makeFetch(() => json(GET_PULL_OK));
  await resolveTangledPull(makeCtx(), { pullUri: PULL_URI, fetchImpl: get.fetchImpl, token: "Bearer xyz" });
  assert.equal(get.calls[0]!.auth, "Bearer xyz");

  const list = makeFetch(() => json(LIST_ONE));
  await resolveTangledPull(makeCtx(), { fetchImpl: list.fetchImpl, token: "Bearer xyz" });
  assert.equal(list.calls[0]!.auth, "Bearer xyz");
});
