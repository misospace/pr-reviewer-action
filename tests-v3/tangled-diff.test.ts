/**
 * Tangled pull round diff (#586) — tests for `src/platform/tangled-diff.ts`,
 * the thin orchestrator that turns a resolved `TangledPullIdentity` into the
 * reviewable `{ diff, files, declaredHeadSha, round }`.
 *
 * The end-to-end path runs the REAL `fetchAtprotoBlob` default (no
 * `fetchBlob` injection) over an injected mock transport that plays the two
 * real hops: (a) the did:plc DID document served by the PLC directory, and
 * (b) the PDS `com.atproto.sync.getBlob` read answered with a real
 * `zlib.gzipSync` of real `git format-patch` output (one modified file +
 * one added file, full mail envelope + signature trailer). The
 * `options.fetchBlob` seam is exercised in one isolated test. Trust posture
 * under test: every blob/record is untrusted data; failures propagate as the
 * typed `TangledPatchError`/`TangledBlobError` of the failing step and there
 * is never an empty-success diff.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { fetchTangledPullRoundDiff } from "../src/platform/tangled-diff.js";
import { TangledBlobError } from "../src/platform/tangled-blob.js";
import { TangledPatchError } from "../src/platform/tangled-patch.js";
import type { TangledPullIdentity } from "../src/platform/tangled-bobbin.js";
import type { FetchLike } from "../src/platform/http.js";
import type { Resolver } from "../src/platform/safe-fetch.js";

// ── fixtures ─────────────────────────────────────────────────────────

const DID = "did:plc:25f71a64d40d1479c059b236";
const PDS = "https://pds.example.com";
const SECRET = "s3cr3t-diff-token";

/** Test seam: a "public" resolution for the non-literal PDS host so the
 * always-on SSRF gate passes with the mocked transport (no real DNS). */
const publicResolver: Resolver = async () => ["93.184.216.34"];

/** The 40-hex sha in the fixture patch's `From` line. */
const SHA = "8f1c3b0e47e6a2d5f8c0b9a4d1e2f3a6c7b8d9e0";
const CREATED_AT = "2026-01-05T10:00:00Z";
const MIME = "application/x-git-format-patch";

/** Real `git format-patch` shape for one commit touching two files: a
 * modification of `file.txt` and an addition of `new-file.txt`, with the
 * mbox `From` envelope, mail headers, diffstat, and the `-- \n<version>`
 * signature trailer exactly as git writes them. */
const PATCH = [
  `From ${SHA} Mon Sep 17 00:00:00 1997`,
  "From: Fixture Author <fixture@example.com>",
  "Date: Mon, 5 Jan 2026 10:00:00 +0000",
  "Subject: [PATCH] modify one file and add another",
  "",
  "---",
  " file.txt     | 2 +-",
  " new-file.txt | 1 +",
  " 2 files changed, 2 insertions(+), 1 deletion(-)",
  " create mode 100644 new-file.txt",
  "",
  "diff --git a/file.txt b/file.txt",
  "index fbbee86..cd964df 100644",
  "--- a/file.txt",
  "+++ b/file.txt",
  "@@ -1,2 +1,2 @@",
  " alpha",
  "-beta",
  "+BETA",
  "diff --git a/new-file.txt b/new-file.txt",
  "new file mode 100644",
  "index 0000000..94954ab",
  "--- /dev/null",
  "+++ b/new-file.txt",
  "@@ -0,0 +1 @@",
  "+hello",
  "-- ",
  "2.39.5",
  "",
].join("\n");

const GZIP_PATCH = gzipSync(Buffer.from(PATCH, "utf8"));

/** One outbound call captured by the mock transport. */
interface Call {
  url: string;
  auth: string | null;
}

function makeFetch(responder: (url: URL) => Response): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url: url.toString(), auth: headers.get("authorization") });
    return responder(url);
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function didDoc(id: string, services: Array<Record<string, unknown>>): Response {
  return json({ id, service: services });
}

function pdsService(serviceEndpoint: string): Record<string, unknown> {
  return { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint };
}

/** A mock that answers the PLC DID document, then the getBlob call. */
function twoHop(doc: Response, blob: (url: URL) => Response): { fetchImpl: FetchLike; calls: Call[] } {
  return makeFetch((url) => (url.hostname === "plc.directory" ? doc : blob(url)));
}

function roundWith(cid: string, createdAt = CREATED_AT): Record<string, unknown> {
  return { createdAt, patchBlob: { $link: cid, mimeType: MIME, size: 1234 } };
}

function makeIdentity(record: Record<string, unknown>): TangledPullIdentity {
  return {
    uri: "at://did:plc:25f71a64d40d1479c059b236/sh.tangled.repo.pull/rkey-1",
    cid: "bafybeicid0",
    rkey: "rkey-1",
    record,
    repoDid: "did:plc:repo42",
    authorDid: DID,
    targetBranch: "main",
    sourceBranch: "feature",
    sourceRepoDid: undefined,
    state: "open",
  };
}

// ── tests ─────────────────────────────────────────────────────────────

test("fetchTangledPullRoundDiff: end-to-end over the real fetchAtprotoBlob default path (no fetchBlob)", async () => {
  const doc = didDoc(DID, [pdsService(PDS)]);
  const { fetchImpl, calls } = twoHop(doc, () => new Response(GZIP_PATCH));
  const result = await fetchTangledPullRoundDiff(
    makeIdentity({ rounds: [roundWith("bafybeicurrent")] }),
    { fetchImpl, resolver: publicResolver },
  );

  // The two hops: the unauthenticated public DID document, then getBlob on
  // the resolved PDS with the author DID + the round CID bound to the URL.
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "https://plc.directory/did:plc:25f71a64d40d1479c059b236");
  assert.equal(calls[0]!.auth, null, "the DID document request is never authenticated");
  assert.equal(calls[1]!.auth, null, "the getBlob request to the author-resolved PDS is never authenticated");
  assert.equal(
    calls[1]!.url,
    `${PDS}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(DID)}&cid=bafybeicurrent`,
  );

  // Both file sections survive into the normalized diff, with no mail
  // headers, no diffstat, and no signature trailer.
  assert.ok(result.diff.includes("diff --git a/file.txt b/file.txt"));
  assert.ok(result.diff.includes("diff --git a/new-file.txt b/new-file.txt"));
  assert.ok(!result.diff.includes("From "));
  assert.ok(!result.diff.includes("2.39.5"));

  assert.equal(result.files.length, 2);
  assert.deepEqual(result.files[0], {
    filename: "file.txt",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch:
      "diff --git a/file.txt b/file.txt\n" +
      "index fbbee86..cd964df 100644\n" +
      "--- a/file.txt\n" +
      "+++ b/file.txt\n" +
      "@@ -1,2 +1,2 @@\n" +
      " alpha\n" +
      "-beta\n" +
      "+BETA\n",
    previous_filename: null,
  });
  assert.deepEqual(result.files[1], {
    filename: "new-file.txt",
    status: "added",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch:
      "diff --git a/new-file.txt b/new-file.txt\n" +
      "new file mode 100644\n" +
      "index 0000000..94954ab\n" +
      "--- /dev/null\n" +
      "+++ b/new-file.txt\n" +
      "@@ -0,0 +1 @@\n" +
      "+hello\n",
    previous_filename: null,
  });

  assert.deepEqual(result.round, {
    index: 0,
    createdAt: CREATED_AT,
    blobCid: "bafybeicurrent",
    mimeType: MIME,
    size: 1234,
  });
  assert.equal(result.declaredHeadSha, SHA, "declaredHeadSha is the sha in the From line (advisory)");
});

test("fetchTangledPullRoundDiff: a multi-round record fetches the LAST round's CID", async () => {
  const doc = didDoc(DID, [pdsService(PDS)]);
  const { fetchImpl, calls } = twoHop(doc, () => new Response(GZIP_PATCH));
  const record = {
    rounds: [roundWith("bafybeicidold", "2026-01-04T09:00:00Z"), roundWith("bafybeicurrent")],
  };
  const result = await fetchTangledPullRoundDiff(makeIdentity(record), { fetchImpl, resolver: publicResolver });
  assert.equal(calls.length, 2);
  assert.equal(
    calls[1]!.url,
    `${PDS}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(DID)}&cid=bafybeicurrent`,
    "the getBlob CID is the LAST round's, never the older one",
  );
  assert.equal(result.round.index, 1);
  assert.equal(result.round.blobCid, "bafybeicurrent");
  assert.equal(result.round.createdAt, CREATED_AT);
});

test("fetchTangledPullRoundDiff: a no-rounds record rejects no-round with zero fetch calls", async () => {
  const { fetchImpl, calls } = makeFetch(() => {
    throw new Error("no network expected for an unusable record");
  });
  for (const record of [{}, { rounds: [] }]) {
    await assert.rejects(
      fetchTangledPullRoundDiff(makeIdentity(record), { fetchImpl }),
      (e: unknown) => e instanceof TangledPatchError && e.kind === "no-round",
    );
  }
  assert.equal(calls.length, 0, "round selection happens before any network call");
});

test("fetchTangledPullRoundDiff: a non-gzip blob rejects undecodable-blob", async () => {
  const doc = didDoc(DID, [pdsService(PDS)]);
  const { fetchImpl } = twoHop(doc, () => new Response(new TextEncoder().encode("definitely not gzip")));
  await assert.rejects(
    fetchTangledPullRoundDiff(makeIdentity({ rounds: [roundWith("bafybeicorrupt")] }), {
      fetchImpl,
      resolver: publicResolver,
    }),
    (e: unknown) => e instanceof TangledPatchError && e.kind === "undecodable-blob",
  );
});

test("fetchTangledPullRoundDiff: a 404 getBlob rejects read-failed", async () => {
  const doc = didDoc(DID, [pdsService(PDS)]);
  const { fetchImpl } = twoHop(doc, () => json({ error: "notFound", message: "blob not found" }, 404));
  await assert.rejects(
    fetchTangledPullRoundDiff(makeIdentity({ rounds: [roundWith("bafybeimissing")] }), {
      fetchImpl,
      resolver: publicResolver,
    }),
    (e: unknown) =>
      e instanceof TangledBlobError &&
      e.kind === "read-failed" &&
      e.message.includes("bafybeimissing"),
  );
});

test("fetchTangledPullRoundDiff: an injected fetchBlob replaces the network (zero fetch calls)", async () => {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), auth: new Headers(init?.headers).get("authorization") });
    throw new Error("no network expected when fetchBlob is injected");
  };
  const seen: Array<{ did: string; cid: string }> = [];
  const fetchBlob = async (did: string, cid: string): Promise<Uint8Array> => {
    seen.push({ did, cid });
    return GZIP_PATCH;
  };
  const record = { rounds: [roundWith("bafybeicidold"), roundWith("bafybeicidnew")] };
  const result = await fetchTangledPullRoundDiff(makeIdentity(record), { fetchImpl, fetchBlob });
  assert.equal(calls.length, 0, "the default PDS path must not run when fetchBlob is injected");
  assert.deepEqual(
    seen,
    [{ did: DID, cid: "bafybeicidnew" }],
    "the seam receives the author DID and the LAST round's CID",
  );
  assert.equal(result.round.blobCid, "bafybeicidnew");
  assert.equal(result.declaredHeadSha, SHA);
});

test("fetchTangledPullRoundDiff: no request ever carries an Authorization header", async () => {
  // The PDS origin is author-selected metadata: the only requests this
  // chain makes are unauthenticated public reads. SECRET is a canary that
  // must not appear in any request, authenticated or not.
  const doc = didDoc(DID, [pdsService(PDS)]);
  const { fetchImpl, calls } = twoHop(doc, () => new Response(GZIP_PATCH));
  const result = await fetchTangledPullRoundDiff(
    makeIdentity({ rounds: [roundWith("bafybeicitok")] }),
    { fetchImpl, resolver: publicResolver },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.auth, null, "the DID document request is never authenticated");
  assert.equal(calls[1]!.auth, null, "the getBlob request to the author-resolved PDS is never authenticated");
  for (const call of calls) {
    assert.ok(!call.url.includes(SECRET), "no credential ever travels in a request URL");
  }
  assert.equal(result.declaredHeadSha, SHA, "the reviewable diff is unaffected");
});
