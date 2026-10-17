import test from "node:test";
import assert from "node:assert/strict";
import {
  type BlobFetchOptions,
  fetchAtprotoBlob,
  MAX_DID_DOCUMENT_BYTES,
  MAX_PATCH_BLOB_BYTES,
  PLC_DIRECTORY_URL,
  resolveAuthorPdsEndpoint,
  TangledBlobError,
} from "../src/platform/tangled-blob.js";
import type { FetchLike } from "../src/platform/http.js";
import type { Resolver } from "../src/platform/safe-fetch.js";

/**
 * Read-only AT-Protocol blob client (#586), exercised through an injected
 * mock transport — no network. The PDS resolution (DID document) and the
 * blob read (`com.atproto.sync.getBlob`) are both plain unauthenticated GETs
 * on the mock. The public-address SSRF gate is always on: non-literal hosts
 * go through the test-seam resolver below; IP-literal hosts are validated
 * directly against the production `isPublicAddress` policy (no seam).
 */

const DID = "did:plc:25f71a64d40d1479c059b236";
const CANARY = "s3cr3t-pds-token";

/** Test seam: a "public" resolution for any non-literal host. IP-literal
 * hosts never call the resolver (they are validated directly). */
const publicResolver: Resolver = async () => ["93.184.216.34"];
/** Test seam: a loopback-resolving host (only usable together with a
 * permissive `addressPolicy`; the production policy refuses it). */
const loopbackResolver: Resolver = async () => ["127.0.0.1"];
const allowAll = () => true;

/** One outbound call captured by the mock transport. */
interface Call {
  url: string;
  auth: string | null;
  headerDump: string;
}

function makeFetch(
  responder: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const headerDump = [...headers.entries()].map(([k, v]) => `${k}: ${v}`).join("; ");
    calls.push({ url: url.toString(), auth: headers.get("authorization"), headerDump });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function didDoc(id: string, services: Array<Record<string, unknown>>): Response {
  return json({ id, service: services });
}

function pdsService(serviceEndpoint: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint, ...over };
}

/** A mock that answers the DID document, then the getBlob call, in order. */
function twoHop(
  doc: Response,
  blob: (url: URL) => Response,
): { fetchImpl: FetchLike; calls: Call[] } {
  return makeFetch((url) => (url.hostname === "plc.directory" ? doc : blob(url)));
}

// ── resolveAuthorPdsEndpoint ────────────────────────────────────────────

test("resolveAuthorPdsEndpoint: did:plc resolves through the PLC directory, unauthenticated", async () => {
  const { fetchImpl, calls } = makeFetch(() => didDoc(DID, [pdsService("https://pds.example.com/")]));
  const pds = await resolveAuthorPdsEndpoint(DID, { fetchImpl, resolver: publicResolver });
  assert.equal(pds, "https://pds.example.com", "trailing slash is stripped");
  assert.equal(PLC_DIRECTORY_URL, "https://plc.directory");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://plc.directory/did:plc:25f71a64d40d1479c059b236");
  assert.equal(calls[0]!.auth, null, "the DID document request is public metadata: never authenticated");
});

test("resolveAuthorPdsEndpoint: did:web resolves through .well-known/did.json, including an explicit port", async () => {
  const { fetchImpl, calls } = makeFetch(() =>
    didDoc("did:web:pds.example.com", [pdsService("https://pds.example.com")]),
  );
  assert.equal(
    await resolveAuthorPdsEndpoint("did:web:pds.example.com", { fetchImpl, resolver: publicResolver }),
    "https://pds.example.com",
  );
  assert.equal(calls[0]!.url, "https://pds.example.com/.well-known/did.json");
  assert.equal(calls[0]!.auth, null);
});

test("resolveAuthorPdsEndpoint: an https loopback PDS is accepted only through the test seams", async () => {
  // A loopback-resolving host passes only when the caller supplies BOTH the
  // loopback resolver and a permissive address policy — the test seams.
  // The production defaults refuse it (next test).
  const { fetchImpl, calls } = makeFetch(() =>
    didDoc("did:web:localhost:2584", [pdsService("https://localhost:2584")]),
  );
  assert.equal(
    await resolveAuthorPdsEndpoint("did:web:localhost:2584", {
      fetchImpl,
      resolver: loopbackResolver,
      addressPolicy: allowAll,
    }),
    "https://localhost:2584",
  );
  assert.equal(calls[0]!.url, "https://localhost:2584/.well-known/did.json");
  assert.equal(calls[0]!.auth, null);
});

test("resolveAuthorPdsEndpoint: a loopback-resolving host is refused without the permissive policy", async () => {
  const { fetchImpl, calls } = makeFetch(() =>
    didDoc("did:web:localhost:2584", [pdsService("https://localhost:2584")]),
  );
  await assert.rejects(
    resolveAuthorPdsEndpoint("did:web:localhost:2584", { fetchImpl, resolver: loopbackResolver }),
    (e: unknown) =>
      e instanceof TangledBlobError &&
      e.kind === "pds-resolution-failed" &&
      e.message.includes("did:web:localhost:2584") &&
      e.message.includes("localhost"),
    "the production public-only policy must refuse a loopback-resolving host",
  );
  assert.equal(calls.length, 0, "the gate fails before any connection is opened");
});

test("resolveAuthorPdsEndpoint: a DID document whose id does not match is corrupt and fails closed", async () => {
  const { fetchImpl } = makeFetch(() =>
    didDoc("did:plc:someone-else", [pdsService("https://pds.example.com")]),
  );
  await assert.rejects(
    resolveAuthorPdsEndpoint(DID, { fetchImpl, resolver: publicResolver }),
    (e: unknown) => e instanceof TangledBlobError && e.kind === "pds-resolution-failed",
    "a mismatched id must never be trusted",
  );
});

test("resolveAuthorPdsEndpoint: the #atproto_pds id wins, then the AtprotoPersonalDataServer type", async () => {
  // A type entry listed BEFORE the #atproto_pds id entry must lose.
  const { fetchImpl } = makeFetch(() =>
    didDoc(DID, [
      { id: "#decoy", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://decoy.example.com" },
      pdsService("https://winner.example.com"),
    ]),
  );
  assert.equal(
    await resolveAuthorPdsEndpoint(DID, { fetchImpl, resolver: publicResolver }),
    "https://winner.example.com",
    "the explicit #atproto_pds id takes precedence over a type match",
  );

  // Without a #atproto_pds id, the type match is the fallback.
  const { fetchImpl: f2 } = makeFetch(() =>
    didDoc(DID, [
      { id: "#something-else", type: "some.other.Service", serviceEndpoint: "https://decoy.example.com" },
      { id: "pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://fallback.example.com" },
    ]),
  );
  assert.equal(
    await resolveAuthorPdsEndpoint(DID, { fetchImpl: f2, resolver: publicResolver }),
    "https://fallback.example.com",
  );
});

test("resolveAuthorPdsEndpoint: missing or non-matching services fail closed", async () => {
  const cases: Array<() => Response> = [
    () => json({ id: DID }), // no service field at all
    () => json({ id: DID, service: null }), // null is not an array
    () => didDoc(DID, []), // empty service array
    () => didDoc(DID, [{ id: "#x", type: "other.Service", serviceEndpoint: "https://x.example.com" }]), // no atproto service
    () => didDoc(DID, [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer" }]), // no serviceEndpoint
    () => didDoc(DID, [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: null }]), // null endpoint
  ];
  for (const make of cases) {
    const { fetchImpl } = makeFetch(make);
    await assert.rejects(
      resolveAuthorPdsEndpoint(DID, { fetchImpl, resolver: publicResolver }),
      (e: unknown) => e instanceof TangledBlobError && e.kind === "pds-resolution-failed",
    );
  }
});

test("resolveAuthorPdsEndpoint: https is required; plaintext http is refused, even for loopback hosts", async () => {
  const { fetchImpl } = makeFetch(() => didDoc(DID, [pdsService("http://1.2.3.4")]));
  await assert.rejects(
    resolveAuthorPdsEndpoint(DID, { fetchImpl, resolver: publicResolver }),
    (e: unknown) =>
      e instanceof TangledBlobError &&
      e.kind === "pds-resolution-failed" &&
      e.message.includes("must be https"),
    "plaintext http to a non-loopback host must be refused",
  );
  const { fetchImpl: f2 } = makeFetch(() => didDoc(DID, [pdsService("ftp://pds.example.com")]));
  await assert.rejects(
    resolveAuthorPdsEndpoint(DID, { fetchImpl: f2, resolver: publicResolver }),
    (e: unknown) => e instanceof TangledBlobError && e.kind === "pds-resolution-failed",
    "non-http(s) schemes must be refused",
  );
  // The old loopback exception is gone: even with the most permissive test
  // policy, a plaintext http PDS endpoint is refused at the scheme check.
  const { fetchImpl: f3, calls: c3 } = makeFetch(() => didDoc(DID, [pdsService("http://localhost:2584/")]));
  await assert.rejects(
    resolveAuthorPdsEndpoint(DID, {
      fetchImpl: f3,
      resolver: publicResolver,
      addressPolicy: allowAll,
    }),
    (e: unknown) =>
      e instanceof TangledBlobError &&
      e.kind === "pds-resolution-failed" &&
      e.message.includes("must be https"),
    "no loopback exception: plaintext http is refused unconditionally",
  );
  assert.equal(c3[0]!.auth, null, "the doc hop is unauthenticated regardless");
});

test("resolveAuthorPdsEndpoint: other DID methods and malformed DIDs are invalid-did, no network", async () => {
  const bad = [
    "did:key:z6MkiAjFzAjiiwRg7f9jwLo4hRb",
    "did:example:123456",
    "did:web:/path", // embedded path characters in the host
    "did:web::2584", // empty host
    "did:web:example.com/evil", // path in the method-specific-id
    "did:plc:", // empty method-specific id
    // method-specific ids that smuggle URL path/query/fragment syntax
    "did:plc:abc/../admin", // traversal: must never reach https://plc.directory/admin
    "did:plc:a?b", // query character
    "did:plc:a#b", // fragment character
    "did:plc:a%20b", // percent character
    "did:plc:a b", // whitespace
    "did:web:a/../admin", // traversal in a did:web id
    "not-a-did",
    "",
  ];
  for (const did of bad) {
    const { fetchImpl, calls } = makeFetch(() => {
      throw new Error("no network for an invalid DID");
    });
    await assert.rejects(
      resolveAuthorPdsEndpoint(did, { fetchImpl }),
      (e: unknown) => e instanceof TangledBlobError && e.kind === "invalid-did",
      did,
    );
    assert.equal(calls.length, 0, `no request may leave for ${did}`);
  }
});

test("resolveAuthorPdsEndpoint: malformed did:web hosts and ports are a TangledBlobError, never a raw TypeError", async () => {
  const bad = [
    "did:web:999.999.999.999", // IPv4 octets above 255
    "did:web:256.1.1.1", // one octet above 255
    "did:web:1.2.3.4.5", // numeric, but not a 4-octet IPv4 literal
    "did:web:example.com:99999", // port above 65535
    "did:web:example.com:0", // port below 1
    "did:web:example.com:00080", // leading zeros
    "did:web:example.com:80:90", // more than one port
  ];
  for (const did of bad) {
    const { fetchImpl, calls } = makeFetch(() => {
      throw new Error("no network for an invalid did:web DID");
    });
    await assert.rejects(
      resolveAuthorPdsEndpoint(did, { fetchImpl }),
      (e: unknown) =>
        e instanceof TangledBlobError &&
        e.kind === "invalid-did" &&
        !(e instanceof TypeError),
      `${did} must be a typed TangledBlobError`,
    );
    assert.equal(calls.length, 0, `no request may leave for ${did}`);
  }
});

test("resolveAuthorPdsEndpoint: a valid explicit port (443) and a plain host still resolve", async () => {
  const { fetchImpl, calls } = makeFetch(() =>
    didDoc("did:web:example.com:443", [pdsService("https://pds.example.com")]),
  );
  assert.equal(
    await resolveAuthorPdsEndpoint("did:web:example.com:443", { fetchImpl, resolver: publicResolver }),
    "https://pds.example.com",
  );
  assert.equal(calls[0]!.url, "https://example.com/.well-known/did.json", "the default port is normalized away");
  assert.equal(calls[0]!.auth, null);

  const { fetchImpl: f2, calls: c2 } = makeFetch(() =>
    didDoc("did:web:example.com", [pdsService("https://pds.example.com")]),
  );
  assert.equal(
    await resolveAuthorPdsEndpoint("did:web:example.com", { fetchImpl: f2, resolver: publicResolver }),
    "https://pds.example.com",
  );
  assert.equal(c2[0]!.url, "https://example.com/.well-known/did.json");
  assert.equal(c2[0]!.auth, null);
});

test("resolveAuthorPdsEndpoint: a transport failure is pds-resolution-failed", async () => {
  const { fetchImpl } = makeFetch(() => {
    throw new TypeError("ENOTFOUND");
  });
  await assert.rejects(
    resolveAuthorPdsEndpoint(DID, { fetchImpl }),
    (e: unknown) => e instanceof TangledBlobError && e.kind === "pds-resolution-failed",
  );
});

test("resolveAuthorPdsEndpoint: 404 and invalid JSON are pds-resolution-failed", async () => {
  const notFound = makeFetch(() => json({ error: "notFound", message: "DID not found" }, 404));
  await assert.rejects(
    resolveAuthorPdsEndpoint(DID, { fetchImpl: notFound.fetchImpl }),
    (e: unknown) =>
      e instanceof TangledBlobError && e.kind === "pds-resolution-failed" && e.message.includes("404"),
  );
  const badJson = makeFetch(() => new Response("{ not json", { status: 200 }));
  await assert.rejects(
    resolveAuthorPdsEndpoint(DID, { fetchImpl: badJson.fetchImpl }),
    (e: unknown) => e instanceof TangledBlobError && e.kind === "pds-resolution-failed",
  );
});

// ── SSRF gate (public-address policy) ───────────────────────────────────

test("resolveAuthorPdsEndpoint: loopback/private IPv4-literal did:web hosts are refused without DNS", async () => {
  const cases: Array<[string, string]> = [
    ["did:web:127.0.0.1", "127.0.0.1"],
    ["did:web:10.1.2.3", "10.1.2.3"],
    ["did:web:169.254.169.254", "169.254.169.254"],
  ];
  for (const [did, host] of cases) {
    const { fetchImpl, calls } = makeFetch(() => {
      throw new Error("no network for a private did:web host");
    });
    await assert.rejects(
      // No resolver injected: IP literals never call DNS; the production
      // isPublicAddress policy validates the literal directly.
      resolveAuthorPdsEndpoint(did, { fetchImpl }),
      (e: unknown) =>
        e instanceof TangledBlobError &&
        e.kind === "pds-resolution-failed" &&
        e.message.includes(did) &&
        e.message.includes(host),
      `${did} must be refused by the public-address gate`,
    );
    assert.equal(calls.length, 0, `an IP literal needs no DNS and no connection: ${did}`);
  }
});

test("resolveAuthorPdsEndpoint: DNS answering a private address is refused, zero fetch calls", async () => {
  const { fetchImpl, calls } = makeFetch(() => {
    throw new Error("no network for a private DNS answer");
  });
  await assert.rejects(
    resolveAuthorPdsEndpoint("did:web:evil.example", { fetchImpl, resolver: async () => ["127.0.0.1"] }),
    (e: unknown) =>
      e instanceof TangledBlobError &&
      e.kind === "pds-resolution-failed" &&
      e.message.includes("did:web:evil.example") &&
      e.message.includes("evil.example"),
    "a loopback DNS answer must be refused before any connection",
  );
  assert.equal(calls.length, 0, "the gate fails before any request is made");
});

test("resolveAuthorPdsEndpoint: a mixed public+private resolution is refused (every address must be public)", async () => {
  const { fetchImpl, calls } = makeFetch(() => {
    throw new Error("no network for a mixed DNS answer");
  });
  await assert.rejects(
    resolveAuthorPdsEndpoint("did:web:evil.example", {
      fetchImpl,
      resolver: async () => ["93.184.216.34", "127.0.0.1"],
    }),
    (e: unknown) =>
      e instanceof TangledBlobError &&
      e.kind === "pds-resolution-failed" &&
      e.message.includes("did:web:evil.example"),
    "one private address in the answer set refuses the whole host",
  );
  assert.equal(calls.length, 0, "the gate fails before any request is made");
});

test("resolveAuthorPdsEndpoint: a public IPv4-literal did:web host passes the gate without DNS", async () => {
  const { fetchImpl, calls } = makeFetch(() =>
    didDoc("did:web:8.8.8.8", [pdsService("https://pds.example.com")]),
  );
  let dnsCalls = 0;
  const countingResolver: Resolver = async () => {
    dnsCalls += 1;
    return ["93.184.216.34"];
  };
  assert.equal(
    await resolveAuthorPdsEndpoint("did:web:8.8.8.8", { fetchImpl, resolver: countingResolver }),
    "https://pds.example.com",
  );
  assert.equal(dnsCalls, 1, "the doc-host literal skipped DNS; only the PDS hostname resolved");
  assert.equal(calls[0]!.url, "https://8.8.8.8/.well-known/did.json");
});

test("fetchAtprotoBlob: a did:plc document advertising a PDS that resolves private is refused before getBlob", async () => {
  const { fetchImpl, calls } = twoHop(
    didDoc(DID, [pdsService("https://pds.evil")]),
    () => {
      throw new Error("no getBlob may leave for a private-resolving PDS");
    },
  );
  await assert.rejects(
    fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl, resolver: async () => ["192.168.7.7"] }),
    (e: unknown) =>
      e instanceof TangledBlobError &&
      e.kind === "pds-resolution-failed" &&
      e.message.includes("pds.evil"),
    "the PDS-endpoint host gate must refuse before the getBlob hop",
  );
  assert.equal(calls.length, 1, "the only fetch that may happen is the unauthenticated DID document hop");
  assert.equal(calls[0]!.url, "https://plc.directory/did:plc:25f71a64d40d1479c059b236");
  assert.equal(calls[0]!.auth, null);
});

test("DID document responses are capped at MAX_DID_DOCUMENT_BYTES (1 MiB)", async () => {
  assert.equal(MAX_DID_DOCUMENT_BYTES, 1024 * 1024);
});

// ── fetchAtprotoBlob ─────────────────────────────────────────────────────

test("fetchAtprotoBlob: fetches the blob by CID from the resolved PDS with the correct getBlob URL", async () => {
  const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const { fetchImpl, calls } = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () => new Response(payload),
  );
  const bytes = await fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl, resolver: publicResolver });
  assert.deepEqual(bytes, payload);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "https://plc.directory/did:plc:25f71a64d40d1479c059b236");
  assert.equal(calls[0]!.auth, null, "the DID document request is never authenticated");
  assert.equal(
    calls[1]!.url,
    "https://pds.example.com/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3A25f71a64d40d1479c059b236&cid=bafybeiblob0",
  );
  assert.equal(
    calls[1]!.auth,
    null,
    "the getBlob request to the author-resolved PDS is never authenticated",
  );
});

test("fetchAtprotoBlob: no request ever carries an Authorization header", async () => {
  // The caller supplies the removed legacy `token` option via cast to pin that it stays inert.
  const { fetchImpl, calls } = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () => new Response(new Uint8Array([1])),
  );
  await fetchAtprotoBlob(DID, "bafybeiblob0", {
    fetchImpl,
    resolver: publicResolver,
    token: CANARY,
  } as unknown as BlobFetchOptions);
  assert.equal(calls[0]!.auth, null, "the DID document request is never authenticated");
  assert.equal(calls[1]!.auth, null, "the getBlob request to the author-resolved PDS is never authenticated");
  for (const call of calls) {
    assert.ok(
      !call.url.includes(CANARY),
      "the removed token option must never reach the author-resolved PDS origin: no canary in any URL",
    );
    assert.ok(
      !call.headerDump.includes(CANARY),
      "the removed token option must never reach the author-resolved PDS origin: no canary in any header",
    );
  }
});

test("fetchAtprotoBlob: a 404 maps to read-failed naming the missing blob", async () => {
  const { fetchImpl } = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () => json({ error: "notFound", message: "blob not found" }, 404),
  );
  await assert.rejects(
    fetchAtprotoBlob(DID, "bafybeigone", { fetchImpl, resolver: publicResolver }),
    (e: unknown) =>
      e instanceof TangledBlobError &&
      e.kind === "read-failed" &&
      e.message.includes("blob not found") &&
      e.message.includes("bafybeigone"),
  );
});

test("fetchAtprotoBlob: a non-2xx other than 404 maps to read-failed with the status", async () => {
  const { fetchImpl } = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () => new Response("internal error", { status: 500 }),
  );
  await assert.rejects(
    fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl, resolver: publicResolver }),
    (e: unknown) =>
      e instanceof TangledBlobError && e.kind === "read-failed" && e.message.includes("500"),
  );
});

test("fetchAtprotoBlob: a redirect on the blob request maps to read-failed", async () => {
  const { fetchImpl } = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } }),
  );
  await assert.rejects(
    fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl, resolver: publicResolver }),
    (e: unknown) =>
      e instanceof TangledBlobError &&
      e.kind === "read-failed" &&
      e.message.includes("Redirect"),
  );
});

test("fetchAtprotoBlob: a 302 Location with a canary token is never reflected into the error message", async () => {
  const CANARY = "canary-token-reflection-42";
  const { fetchImpl, calls } = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () =>
      new Response(null, {
        status: 302,
        headers: { location: `https://evil.invalid/reflect?tok=${CANARY}` },
      }),
  );
  await assert.rejects(
    fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl, resolver: publicResolver }),
    (e: unknown) => {
      assert.ok(
        e instanceof TangledBlobError && e.kind === "read-failed",
        `expected read-failed, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      );
      assert.ok(!e.message.includes(CANARY), `the canary must never be reflected: ${e.message}`);
      assert.ok(!e.message.includes("evil.invalid"), `the redirect target must never be reported: ${e.message}`);
      return true;
    },
  );
  assert.equal(calls[1]!.auth, null, "and the getBlob request itself was never authenticated");
});

test("fetchAtprotoBlob: an over-cap body maps to too-large", async () => {
  const big = new Uint8Array(16).fill(0xab);
  const { fetchImpl } = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () => new Response(big),
  );
  await assert.rejects(
    fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl, resolver: publicResolver, maxBytes: 8 }),
    (e: unknown) => e instanceof TangledBlobError && e.kind === "too-large",
  );
});

test("fetchAtprotoBlob: the default cap is MAX_PATCH_BLOB_BYTES (16 MiB)", async () => {
  assert.equal(MAX_PATCH_BLOB_BYTES, 16 * 1024 * 1024);
  const over = new Uint8Array(MAX_PATCH_BLOB_BYTES + 1);
  const { fetchImpl } = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () => new Response(over),
  );
  await assert.rejects(
    fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl, resolver: publicResolver }),
    (e: unknown) => e instanceof TangledBlobError && e.kind === "too-large",
    "a byte over the default cap must be refused without a maxBytes option",
  );
});

test("fetchAtprotoBlob: an invalid CID is rejected before any network call", async () => {
  const bad = ["", "bafy x", "bafy/..", "a?b", "a&b", " x"];
  for (const cid of bad) {
    const { fetchImpl, calls } = makeFetch(() => {
      throw new Error("no network for an invalid CID");
    });
    await assert.rejects(
      fetchAtprotoBlob(DID, cid, { fetchImpl }),
      (e: unknown) => e instanceof TangledBlobError && e.kind === "invalid-cid",
      cid,
    );
    assert.equal(calls.length, 0, `no request may leave for cid ${JSON.stringify(cid)}`);
  }
});

test("fetchAtprotoBlob: an invalid DID is rejected before any network call", async () => {
  const bad = [
    "did:key:z6MkiAjFzAjiiwRg7f9jwLo4hRb",
    "did:plc:abc/../admin", // traversal must not reach https://plc.directory/admin
    "did:plc:a?b",
    "did:plc:a#b",
    "did:plc:a%20b",
    "did:web:999.999.999.999",
    "did:web:example.com:99999",
  ];
  for (const did of bad) {
    const { fetchImpl, calls } = makeFetch(() => {
      throw new Error("no network for an invalid DID");
    });
    await assert.rejects(
      fetchAtprotoBlob(did, "bafybeiblob0", { fetchImpl }),
      (e: unknown) => e instanceof TangledBlobError && e.kind === "invalid-did",
      did,
    );
    assert.equal(calls.length, 0, `no request may leave for ${did}`);
  }
});

test("fetchAtprotoBlob: a plaintext http PDS endpoint is refused before any getBlob", async () => {
  const { fetchImpl, calls } = twoHop(
    didDoc(DID, [pdsService("http://localhost:2584")]),
    () => {
      throw new Error("no getBlob may leave for a plaintext http PDS");
    },
  );
  await assert.rejects(
    // Even with the most permissive test policy, the scheme check refuses
    // plaintext http before the getBlob hop.
    fetchAtprotoBlob(DID, "bafybeiblob0", {
      fetchImpl,
      resolver: publicResolver,
      addressPolicy: allowAll,
    }),
    (e: unknown) =>
      e instanceof TangledBlobError &&
      e.kind === "pds-resolution-failed" &&
      e.message.includes("must be https"),
    "the loopback http exception is gone: plaintext http is refused unconditionally",
  );
  assert.equal(calls.length, 1, "only the unauthenticated DID document hop may happen");
  assert.equal(calls[0]!.auth, null);
});

test("fetchAtprotoBlob: a 200 with a zero-byte body is a read-failed empty blob, not a success", async () => {
  const { fetchImpl } = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () => new Response(null, { status: 200 }),
  );
  await assert.rejects(
    fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl, resolver: publicResolver }),
    (e: unknown) =>
      e instanceof TangledBlobError &&
      e.kind === "read-failed" &&
      e.message.includes("empty blob"),
    "no zero-byte success at the fetch boundary",
  );
});

test("every failure path: TangledBlobError messages stay clean (no canary credential, no redirect target)", async () => {
  const CANARY = "s3cr3t-canary";
  const noNetwork = makeFetch(() => {
    throw new Error("no network for an invalid DID");
  }).fetchImpl;
  const emptyBlob = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () => new Response(null, { status: 200 }),
  ).fetchImpl;
  const redirect = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () =>
      new Response(null, {
        status: 302,
        headers: { location: `https://evil.invalid/reflect?tok=${CANARY}` },
      }),
  ).fetchImpl;
  const scenarios: Array<() => Promise<unknown>> = [
    () => fetchAtprotoBlob("did:plc:abc/../admin", "bafybeiblob0", { fetchImpl: noNetwork }),
    () => fetchAtprotoBlob("did:plc:a?b", "bafybeiblob0", { fetchImpl: noNetwork }),
    () => fetchAtprotoBlob("did:plc:a#b", "bafybeiblob0", { fetchImpl: noNetwork }),
    () => fetchAtprotoBlob("did:plc:a%20b", "bafybeiblob0", { fetchImpl: noNetwork }),
    () => fetchAtprotoBlob("did:web:999.999.999.999", "bafybeiblob0", { fetchImpl: noNetwork }),
    () => fetchAtprotoBlob("did:web:example.com:99999", "bafybeiblob0", { fetchImpl: noNetwork }),
    () => resolveAuthorPdsEndpoint("did:web:999.999.999.999", { fetchImpl: noNetwork }),
    () => resolveAuthorPdsEndpoint("did:web:example.com:99999", { fetchImpl: noNetwork }),
    () => fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl: emptyBlob, resolver: publicResolver }),
    () => fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl: redirect, resolver: publicResolver }),
  ];
  for (const run of scenarios) {
    await assert.rejects(
      run(),
      (e: unknown) => {
        assert.ok(
          e instanceof TangledBlobError,
          `expected a TangledBlobError, got ${e instanceof Error ? `${e.name}: ${e.message}` : typeof e}`,
        );
        assert.ok(
          !e.message.includes(CANARY),
          `the error message must not reflect the canary credential: ${e.message}`,
        );
        assert.ok(
          !e.message.includes("evil.invalid"),
          `the error message must not report the redirect target: ${e.message}`,
        );
        return true;
      },
    );
  }
});

test("fetchAtprotoBlob: a PDS resolution failure propagates from the blob fetch", async () => {
  const { fetchImpl } = makeFetch(() => json({ error: "notFound" }, 404)); // the DID document is gone
  await assert.rejects(
    fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl }),
    (e: unknown) => e instanceof TangledBlobError && e.kind === "pds-resolution-failed",
  );
});
