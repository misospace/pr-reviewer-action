import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { TangledAdapter } from "../src/platform/tangled-adapter.js";
import { TangledNotImplementedError } from "../src/platform/tangled.js";
import { TangledResolverError } from "../src/platform/tangled-bobbin.js";
import { TangledPatchError } from "../src/platform/tangled-patch.js";
import type { FetchLike } from "../src/platform/http.js";
import type { TangledContext } from "../src/platform/tangled.js";
import { deriveDraftState, deriveIsFork, normalizePrIdentity } from "../src/platform/pr.js";

/**
 * Tangled read adapter (#585, diff wiring #1690): the first Tangled backend,
 * read-only. Exercised through injected mock transports — no network. This
 * file pins the projection of the resolved pull into the GitHub-REST pull
 * shape, the wired #586 round-diff chain behind `getPrDiff`/`listPrFiles`,
 * and the fail-closed behavior of every capability Tangled has no source
 * for.
 */

/** One XRPC call captured by the mock transport. */
interface Call {
  url: URL;
  nsid: string;
  query: Record<string, string>;
  auth: string | null;
  body: string | null;
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
    const body = init?.body === undefined || init?.body === null ? null : String(init.body);
    calls.push({ url, nsid, query, auth: headers.get("authorization"), body });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SOURCE_SHA = "0123456789abcdef0123456789abcdef0123456789abcdef";

function makeCtx(over: Partial<TangledContext> = {}): TangledContext {
  return {
    ownerDid: "did:plc:repo",
    repoDid: "did:plc:repo",
    repoName: "owner/repo",
    sourceBranch: "feat/x",
    targetBranch: "main",
    sourceSha: SOURCE_SHA,
    knotHost: "knot1.tangled.sh",
    bobbinUrl: "https://bobbin.test",
    ...over,
  };
}

const PULL_URI = "at://did:plc:author/sh.tangled.repo.pull/3mxb";

/** A listPulls item whose value is a rich pull record. */
function listItem(value: Record<string, unknown>, state: string): Record<string, unknown> {
  return { uri: PULL_URI, cid: "bafyrei2", state, value, commentCount: 0 };
}

/** The canonical same-repo pull record: source and target both the repo DID. */
function matchValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Add tangled read adapter",
    description: "Wires the Tangled read adapter (#585).",
    createdAt: "2026-01-02T03:04:05Z",
    target: { branch: "main", repo: "did:plc:repo" },
    source: { branch: "feat/x", repo: "did:plc:repo" },
    ...over,
  };
}

function listOne(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { items: [listItem(matchValue(over), "open")], cursor: null };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

// ── the #586 round-diff chain behind getPrDiff/listPrFiles (#1690) ──────

const BLOB_CID = "bafyreiblobcid00000000000000000000000000000000000000000000";
const AUTHOR_DID = "did:plc:author";
/** The mock PDS endpoint: a PUBLIC IP LITERAL so the blob chain's SSRF gate
 * (the real `isPublicAddress` policy) validates it directly with no DNS —
 * the only mock is the fetch wire boundary itself. */
const PDS_HOST = "93.184.216.34";

/** One `git format-patch` mail envelope, gzipped — the round patch blob. */
function patchBytes(): Buffer {
  return gzipSync(Buffer.from([
    // The envelope sha is the patch grammar's 40-hex boundary id.
    `From ${SOURCE_SHA.slice(0, 40)} Mon Sep 17 00:00:00 1997 +0000`,
    "From: Ada <ada@example.com>",
    "Date: Mon, 17 Sep 2026 10:00:00 +0000",
    "Subject: [PATCH] Add a line to the README",
    "",
    "Add the greeting the review asks about.",
    "",
    "diff --git a/README.md b/README.md",
    "index 1111111..2222222 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1,2 @@",
    " hello",
    "+world",
    "-- ",
    "2.47.0",
    "",
  ].join("\n"), "utf8"));
}

/** A pull record carrying one round whose patch blob is `BLOB_CID`. */
function roundPatchValue(): Record<string, unknown> {
  return matchValue({
    rounds: [{
      createdAt: "2026-01-02T03:04:05Z",
      patchBlob: { $link: BLOB_CID, mimeType: "application/gzip", size: 128 },
    }],
  });
}

/** A transport serving the whole chain at its wire boundaries: Bobbin
 * listPulls (the given pull record), the author's PLC DID document, and the
 * PDS getBlob. The PDS host is a public IP literal, so the production
 * public-address policy validates it with no DNS emulation. */
function makeChainFetch(
  bytes: Buffer,
  record: Record<string, unknown> = roundPatchValue(),
): { fetchImpl: FetchLike; hosts: Map<string, number> } {
  const hosts = new Map<string, number>();
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(String(input));
    hosts.set(url.hostname, (hosts.get(url.hostname) ?? 0) + 1);
    if (url.hostname === "plc.directory") {
      if (url.pathname !== `/${AUTHOR_DID}`) return json({ error: "not found" }, 404);
      return json({
        id: AUTHOR_DID,
        service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: `https://${PDS_HOST}` }],
      });
    }
    if (url.hostname === PDS_HOST && url.pathname === "/xrpc/com.atproto.sync.getBlob") {
      return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    return json(listOne(record));
  };
  return { fetchImpl, hosts };
}

// ── getPr: projection of the resolved pull ─────────────────────────────

test("getPr resolves the canonical pull and projects it to the GitHub-REST shape", async () => {
  const { fetchImpl, calls } = makeFetch(() => json(listOne()));
  const pr = recordOf(await new TangledAdapter({ context: makeCtx(), fetchImpl }).getPr());
  assert.equal(calls.length, 1, "exactly one Bobbin round-trip");
  assert.equal(calls[0]!.nsid, "sh.tangled.repo.listPulls");
  assert.equal(calls[0]!.query.subject, "did:plc:repo");
  assert.equal(pr.title, "Add tangled read adapter");
  assert.equal(pr.body, "Wires the Tangled read adapter (#585).");
  assert.equal(pr.state, "open");
  assert.deepEqual(pr.user, { login: "did:plc:author" });
  const head = recordOf(pr.head);
  assert.equal(head.sha, SOURCE_SHA);
  assert.equal(head.ref, "feat/x");
  assert.deepEqual(head.repo, { full_name: "did:plc:repo" });
  const base = recordOf(pr.base);
  assert.equal(base.sha, "");
  assert.equal(base.ref, "main");
  assert.deepEqual(base.repo, { full_name: "did:plc:repo" });
  assert.equal(pr.merged_at, null);
  assert.equal(pr.created_at, "2026-01-02T03:04:05Z");
  assert.equal("updated_at" in pr, false, "tangled has no update timestamp; only created_at is projected");
  assert.equal(pr.url, PULL_URI);
  assert.equal(pr.html_url, PULL_URI);
  assert.deepEqual(pr.labels, []);
  // number is intentionally absent: Tangled pulls have no numeric identity.
  assert.equal("number" in pr, false);
  // draft is absent when the record carries no boolean draft.
  assert.equal("draft" in pr, false);
});

test("head.sha is the runtime checkout SHA and empty when the pull is patch-backed", async () => {
  const withSha = makeFetch(() => json(listOne()));
  const a = recordOf(
    await new TangledAdapter({ context: makeCtx(), fetchImpl: withSha.fetchImpl }).getPr(),
  );
  assert.equal(recordOf(a.head).sha, SOURCE_SHA, "the runtime checkout SHA fills head.sha");

  const patchBacked = makeFetch(() => json(listOne()));
  const p = recordOf(
    await new TangledAdapter({ context: makeCtx({ sourceSha: "" }), fetchImpl: patchBacked.fetchImpl }).getPr(),
  );
  assert.equal(recordOf(p.head).sha, "", "a patch-backed pull (no checkout SHA) has an empty head.sha");
});

test("DIDs fill head/base repo full_name; a missing source repo fails closed to fork", async () => {
  const same = makeFetch(() => json(listOne()));
  const pr1 = recordOf(await new TangledAdapter({ context: makeCtx(), fetchImpl: same.fetchImpl }).getPr());
  const id1 = normalizePrIdentity(pr1);
  assert.equal(id1.headRepoFullName, "did:plc:repo");
  assert.equal(id1.baseRepoFullName, "did:plc:repo");
  assert.equal(deriveIsFork(pr1), false, "a same-repo pull is not a fork");

  // value.source has no repo → sourceRepoDid undefined → head repo empty → fork.
  const patch = makeFetch(() =>
    json({ items: [listItem({ ...matchValue(), source: { branch: "feat/x" } }, "open")], cursor: null }),
  );
  const pr2 = recordOf(await new TangledAdapter({ context: makeCtx(), fetchImpl: patch.fetchImpl }).getPr());
  assert.equal(normalizePrIdentity(pr2).headRepoFullName, "");
  assert.equal(deriveIsFork(pr2), true, "a missing source repo fails closed to fork");
});

test("draft is omitted when the record has no boolean draft; present and normalized when it is one", async () => {
  const noDraft = makeFetch(() => json(listOne()));
  const pr1 = recordOf(await new TangledAdapter({ context: makeCtx(), fetchImpl: noDraft.fetchImpl }).getPr());
  assert.equal("draft" in pr1, false);
  assert.equal(deriveDraftState(pr1), "unknown");

  const asDraft = makeFetch(() => json(listOne({ draft: true })));
  const pr2 = recordOf(await new TangledAdapter({ context: makeCtx(), fetchImpl: asDraft.fetchImpl }).getPr());
  assert.equal(pr2.draft, true);
  assert.equal(deriveDraftState(pr2), "draft");
});

// ── getPr: failure surfaces ─────────────────────────────────────────────

test("getPr returns null on a resolver no-match and on a transport rejection (never throws)", async () => {
  // The branch tuple matches no pull (source branch differs) → no-match.
  const noMatch = makeFetch(() =>
    json({ items: [listItem({ ...matchValue(), source: { branch: "feat/other" } }, "open")], cursor: null }),
  );
  assert.equal(await new TangledAdapter({ context: makeCtx(), fetchImpl: noMatch.fetchImpl }).getPr(), null);

  // A transport rejection (network failure) → read-failed.
  const throwFetch = makeFetch(() => {
    throw new TypeError("network");
  });
  assert.equal(await new TangledAdapter({ context: makeCtx(), fetchImpl: throwFetch.fetchImpl }).getPr(), null);
});

test("the canonical pull is resolved once and cached across repeated getPr calls", async () => {
  const { fetchImpl, calls } = makeFetch(() => json(listOne()));
  const adapter = new TangledAdapter({ context: makeCtx(), fetchImpl });
  const a = await adapter.getPr();
  const b = await adapter.getPr();
  assert.deepEqual(a, b);
  assert.equal(calls.length, 1, "repeated reads must not re-resolve");
});

test("concurrent getPr calls share a single resolver round-trip", async () => {
  const { fetchImpl, calls } = makeFetch(() => json(listOne()));
  const adapter = new TangledAdapter({ context: makeCtx(), fetchImpl });
  const [a, b] = await Promise.all([adapter.getPr(), adapter.getPr()]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 1, "concurrent reads must share one in-flight resolution");
});

test("a failed getPr is not cached: a later call re-resolves and succeeds", async () => {
  let fail = true;
  const { fetchImpl, calls } = makeFetch(() => {
    if (fail) {
      fail = false;
      throw new TypeError("transient network");
    }
    return json(listOne());
  });
  const adapter = new TangledAdapter({ context: makeCtx(), fetchImpl });
  assert.equal(await adapter.getPr(), null, "the failed read resolves to null");
  assert.equal(adapter.pullIdentity, null, "a failed resolution caches nothing");
  const pr = recordOf(await adapter.getPr());
  assert.equal(pr.title, "Add tangled read adapter", "the retry resolves normally");
  assert.equal(calls.length, 2, "one failed attempt plus one successful retry");
});

test("a record missing optional fields projects empty/null values, never guesses", async () => {
  const sparse = makeFetch(() =>
    json({
      items: [
        listItem(
          { target: { branch: "main", repo: "did:plc:repo" }, source: { branch: "feat/x", repo: "did:plc:repo" } },
          "open",
        ),
      ],
      cursor: null,
    }),
  );
  const pr = recordOf(await new TangledAdapter({ context: makeCtx(), fetchImpl: sparse.fetchImpl }).getPr());
  assert.equal(pr.title, "", "a missing title projects empty, never a guess");
  assert.equal(pr.body, null, "a missing description projects null body");
  assert.equal(pr.created_at, null, "a missing createdAt projects null");
  assert.equal("updated_at" in pr, false);
});

// ── capabilities ────────────────────────────────────────────────────────

test("getPrDiff and listPrFiles run the #586 round-diff chain on the stock adapter (#1690)", async () => {
  const bytes = patchBytes();
  const chain = makeChainFetch(bytes);
  const adapter = new TangledAdapter({
    context: makeCtx(),
    fetchImpl: chain.fetchImpl,
  });
  const diff = await adapter.getPrDiff();
  assert.match(diff, /\+world/, "the round patch content is the diff");
  assert.match(diff, /README\.md/, "the diff names the changed file");

  const files = await adapter.listPrFiles();
  assert.equal(files.ok, true, "listPrFiles serves the same round's files");
  if (!files.ok) assert.fail("files read must succeed here");
  const names = (files.data as Array<{ filename?: string }>).map((f) => f.filename);
  assert.deepEqual(names, ["README.md"]);

  // The blob chain never carries a credential: no Authorization header is
  // defined for it, and the adapter's token belongs to the Bobbin origin only.
  assert.deepEqual(
    [...chain.hosts.keys()].sort(),
    ["93.184.216.34", "bobbin.test", "plc.directory"].sort(),
  );
});

test("getPrDiff and listPrFiles share one memoized chain: one Bobbin, one DID doc, one blob", async () => {
  const chain = makeChainFetch(patchBytes());
  const adapter = new TangledAdapter({
    context: makeCtx(),
    fetchImpl: chain.fetchImpl,
  });
  await adapter.getPrDiff();
  await adapter.listPrFiles();
  await adapter.listPrFiles();
  assert.equal(chain.hosts.get("bobbin.test"), 1, "one Bobbin resolution");
  assert.equal(chain.hosts.get("plc.directory"), 1, "one DID document read");
  assert.equal(chain.hosts.get(PDS_HOST), 1, "one blob read");
});

test("getPrDiff fails closed with the typed error of the failing chain step", async () => {
  // A record without rounds: the chain rejects before any blob fetch.
  const noRound = makeChainFetch(patchBytes(), matchValue());
  const noRoundAdapter = new TangledAdapter({
    context: makeCtx(),
    fetchImpl: noRound.fetchImpl,
  });
  await assert.rejects(
    () => noRoundAdapter.getPrDiff(),
    (e: unknown) => e instanceof TangledPatchError && e.kind === "no-round",
  );
  assert.equal(noRound.hosts.get(PDS_HOST), undefined, "no blob is fetched for an unusable record");

  // A non-gzip blob: the decode step fails closed.
  const corrupt = makeChainFetch(Buffer.from("not a gzip stream"));
  const corruptAdapter = new TangledAdapter({
    context: makeCtx(),
    fetchImpl: corrupt.fetchImpl,
  });
  await assert.rejects(
    () => corruptAdapter.getPrDiff(),
    (e: unknown) => e instanceof TangledPatchError,
    "a non-gzip blob fails closed at the decode step",
  );
  const corruptFiles = await corruptAdapter.listPrFiles();
  assert.equal(corruptFiles.ok, false, "listPrFiles surfaces the same failed chain (memoized)");
  if (!corruptFiles.ok) assert.match(corruptFiles.error, /gzip/i, "the ReadResult error carries the typed failure");
});

test("getPrDiff fails closed when the pull cannot be resolved (no blob fetch attempted)", async () => {
  const noMatch = makeFetch(() =>
    json({ items: [listItem({ ...matchValue(), source: { branch: "feat/other" } }, "open")], cursor: null }),
  );
  const adapter = new TangledAdapter({ context: makeCtx(), fetchImpl: noMatch.fetchImpl });
  await assert.rejects(
    () => adapter.getPrDiff(),
    (e: unknown) => e instanceof TangledResolverError,
  );
  const files = await adapter.listPrFiles();
  assert.equal(files.ok, false, "the memoized failure surfaces as ok:false");
});

test("listIssueComments and listPrReviews return the empty truth (#1690)", async () => {
  const adapter = new TangledAdapter({ context: makeCtx(), fetchImpl: makeFetch(() => json(listOne())).fetchImpl });
  assert.deepEqual(await adapter.listIssueComments(), []);
  assert.deepEqual(await adapter.listPrReviews(), []);
});

test("every capability Tangled has no source for keeps its fail-closed answer", async () => {
  const adapter = new TangledAdapter({ context: makeCtx(), fetchImpl: makeFetch(() => json(listOne())).fetchImpl });
  assert.equal(adapter.platform, "tangled");

  // ghApi never throws; it reports the error in-band.
  const gh = await adapter.ghApi("/repos/o/r");
  assert.ok(gh.error !== undefined && /gh_api/.test(gh.error), "gh_api reports its capability error in-band");
  // Unprovable identity and coarse permission fail closed.
  assert.equal(await adapter.authenticatedIdentity(), null);
  assert.equal(await adapter.repoPermission(), "unknown");
  // ReadResult-shaped reads return { ok: false, error }.
  const reads = [
    adapter.getIssue("o/r", "9"),
    adapter.listPrConversationComments(),
    adapter.listReviewThreads(),
    adapter.listPrReviewsPaginated(),
  ];
  for (const read of reads) {
    const r = await read;
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.error !== "", "every ReadResult failure carries a capability message");
  }
  // externalChecks fails loud: null is the seam's transient-retry signal,
  // and a permanently-missing capability must not masquerade as a retryable read.
  await assert.rejects(
    () => adapter.externalChecks("deadbeef"),
    (e: unknown) => e instanceof TangledNotImplementedError && /external check/.test(e.message),
  );
});

// ── identity retention ───────────────────────────────────────────────────

test("the pull identity is retained after a resolved getPr and is null before it", async () => {
  const { fetchImpl } = makeFetch(() => json(listOne()));
  const adapter = new TangledAdapter({ context: makeCtx(), fetchImpl });
  const before = adapter.pullIdentity;
  assert.equal(before, null, "no identity before a resolution");
  await adapter.getPr();
  const identity = adapter.pullIdentity;
  if (identity === null) assert.fail("the resolved identity must be retained after getPr");
  assert.equal(identity.uri, PULL_URI);
  assert.equal(identity.cid, "bafyrei2");
  assert.equal(identity.rkey, "3mxb");
});

// ── credential transport ─────────────────────────────────────────────────

test("the token travels only as the Authorization header to the Bobbin origin", async () => {
  const secret = "s3cr3t-tangled-token";
  const token = `Bearer ${secret}`;
  const { fetchImpl, calls } = makeFetch(() => json(listOne()));
  await new TangledAdapter({ context: makeCtx(), fetchImpl, token }).getPr();
  assert.equal(calls[0]!.auth, token, "the token is sent as the Authorization header");
  assert.doesNotMatch(calls[0]!.url.toString(), /s3cr3t-tangled-token/, "the token must not appear in the request URL");
  assert.ok(!Object.values(calls[0]!.query).some((v) => v.includes(secret)), "the token must not appear in a query parameter");
  assert.ok(calls[0]!.body === null || !calls[0]!.body.includes(secret), "the token must not appear in the request body");
});
