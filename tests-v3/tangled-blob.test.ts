import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchAtprotoBlob,
  MAX_PATCH_BLOB_BYTES,
  PLC_DIRECTORY_URL,
  resolveAuthorPdsEndpoint,
  TangledBlobError,
} from "../src/platform/tangled-blob.js";
import type { FetchLike } from "../src/platform/http.js";

/**
 * Read-only AT-Protocol blob client (#586), exercised through an injected
 * mock transport — no network. The PDS resolution (DID document) and the
 * blob read (`com.atproto.sync.getBlob`) are both plain GETs on the mock.
 */

const DID = "did:plc:25f71a64d40d1479c059b236";
const SECRET = "s3cr3t-pds-token";

/** One outbound call captured by the mock transport. */
interface Call {
  url: string;
  auth: string | null;
}

function makeFetch(
  responder: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url: url.toString(), auth: headers.get("authorization") });
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
  const pds = await resolveAuthorPdsEndpoint(DID, { fetchImpl });
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
    await resolveAuthorPdsEndpoint("did:web:pds.example.com", { fetchImpl }),
    "https://pds.example.com",
  );
  assert.equal(calls[0]!.url, "https://pds.example.com/.well-known/did.json");

  const { fetchImpl: f2, calls: c2 } = makeFetch(() =>
    didDoc("did:web:localhost:2584", [pdsService("http://localhost:2584")]),
  );
  assert.equal(
    await resolveAuthorPdsEndpoint("did:web:localhost:2584", { fetchImpl: f2 }),
    "http://localhost:2584",
  );
  assert.equal(c2[0]!.url, "https://localhost:2584/.well-known/did.json");
});

test("resolveAuthorPdsEndpoint: a DID document whose id does not match is corrupt and fails closed", async () => {
  const { fetchImpl } = makeFetch(() =>
    didDoc("did:plc:someone-else", [pdsService("https://pds.example.com")]),
  );
  await assert.rejects(
    resolveAuthorPdsEndpoint(DID, { fetchImpl }),
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
    await resolveAuthorPdsEndpoint(DID, { fetchImpl }),
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
    await resolveAuthorPdsEndpoint(DID, { fetchImpl: f2 }),
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
      resolveAuthorPdsEndpoint(DID, { fetchImpl }),
      (e: unknown) => e instanceof TangledBlobError && e.kind === "pds-resolution-failed",
    );
  }
});

test("resolveAuthorPdsEndpoint: https is required, http only for loopback hosts", async () => {
  const { fetchImpl } = makeFetch(() => didDoc(DID, [pdsService("http://1.2.3.4")]));
  await assert.rejects(
    resolveAuthorPdsEndpoint(DID, { fetchImpl }),
    (e: unknown) =>
      e instanceof TangledBlobError &&
      e.kind === "pds-resolution-failed" &&
      e.message.includes("loopback"),
    "plaintext http to a non-loopback host must be refused",
  );
  const { fetchImpl: f2 } = makeFetch(() => didDoc(DID, [pdsService("ftp://pds.example.com")]));
  await assert.rejects(
    resolveAuthorPdsEndpoint(DID, { fetchImpl: f2 }),
    (e: unknown) => e instanceof TangledBlobError && e.kind === "pds-resolution-failed",
    "non-http(s) schemes must be refused",
  );
  const { fetchImpl: f3, calls: c3 } = makeFetch(() => didDoc(DID, [pdsService("http://localhost:2584/")]));
  assert.equal(
    await resolveAuthorPdsEndpoint(DID, { fetchImpl: f3 }),
    "http://localhost:2584",
    "http is accepted for loopback hosts",
  );
  assert.equal(c3[0]!.auth, null, "still unauthenticated even for loopback");
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
    await resolveAuthorPdsEndpoint("did:web:example.com:443", { fetchImpl }),
    "https://pds.example.com",
  );
  assert.equal(calls[0]!.url, "https://example.com/.well-known/did.json", "the default port is normalized away");
  assert.equal(calls[0]!.auth, null);

  const { fetchImpl: f2, calls: c2 } = makeFetch(() =>
    didDoc("did:web:example.com", [pdsService("https://pds.example.com")]),
  );
  assert.equal(
    await resolveAuthorPdsEndpoint("did:web:example.com", { fetchImpl: f2 }),
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

// ── fetchAtprotoBlob ─────────────────────────────────────────────────────

test("fetchAtprotoBlob: fetches the blob by CID from the resolved PDS with the correct getBlob URL", async () => {
  const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const { fetchImpl, calls } = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () => new Response(payload),
  );
  const bytes = await fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl, token: `Bearer ${SECRET}` });
  assert.deepEqual(bytes, payload);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "https://plc.directory/did:plc:25f71a64d40d1479c059b236");
  assert.equal(calls[0]!.auth, null, "the DID document request never carries the token");
  assert.equal(
    calls[1]!.url,
    "https://pds.example.com/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3A25f71a64d40d1479c059b236&cid=bafybeiblob0",
  );
  assert.equal(calls[1]!.auth, `Bearer ${SECRET}`, "the getBlob request carries the token as Authorization");
  for (const call of calls) {
    assert.ok(!call.url.includes(SECRET), "the token must never appear in a request URL");
  }
});

test("fetchAtprotoBlob: no Authorization header when no token is provided", async () => {
  const { fetchImpl, calls } = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () => new Response(new Uint8Array([1])),
  );
  await fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl });
  assert.equal(calls[0]!.auth, null);
  assert.equal(calls[1]!.auth, null);
});

test("fetchAtprotoBlob: a 404 maps to read-failed naming the missing blob", async () => {
  const { fetchImpl } = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () => json({ error: "notFound", message: "blob not found" }, 404),
  );
  await assert.rejects(
    fetchAtprotoBlob(DID, "bafybeigone", { fetchImpl }),
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
    fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl }),
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
    fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl, token: `Bearer ${SECRET}` }),
    (e: unknown) =>
      e instanceof TangledBlobError &&
      e.kind === "read-failed" &&
      e.message.includes("Redirect"),
  );
});

test("fetchAtprotoBlob: an over-cap body maps to too-large", async () => {
  const big = new Uint8Array(16).fill(0xab);
  const { fetchImpl } = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () => new Response(big),
  );
  await assert.rejects(
    fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl, maxBytes: 8 }),
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
    fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl }),
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
      fetchAtprotoBlob(did, "bafybeiblob0", { fetchImpl, token: `Bearer ${SECRET}` }),
      (e: unknown) => e instanceof TangledBlobError && e.kind === "invalid-did",
      did,
    );
    assert.equal(calls.length, 0, `no request may leave for ${did}`);
  }
});

test("fetchAtprotoBlob: a plaintext http PDS endpoint never receives the Authorization token", async () => {
  const blob = new Uint8Array([1, 2, 3]);
  const { fetchImpl, calls } = twoHop(
    didDoc(DID, [pdsService("http://localhost:2584")]),
    () => new Response(blob),
  );
  const bytes = await fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl, token: `Bearer ${SECRET}` });
  assert.deepEqual(bytes, blob, "the blob still comes back over plaintext http loopback");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "https://plc.directory/did:plc:25f71a64d40d1479c059b236");
  assert.equal(calls[0]!.auth, null, "the DID document request never carries the token");
  assert.equal(calls[1]!.url, "http://localhost:2584/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3A25f71a64d40d1479c059b236&cid=bafybeiblob0");
  assert.equal(
    calls[1]!.auth,
    null,
    "a plaintext http PDS endpoint is public: the token is dropped silently",
  );
  for (const call of calls) {
    assert.ok(!call.url.includes(SECRET), "the token must never appear in a request URL");
  }
});

test("fetchAtprotoBlob: a 200 with a zero-byte body is a read-failed empty blob, not a success", async () => {
  const { fetchImpl } = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () => new Response(null, { status: 200 }),
  );
  await assert.rejects(
    fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl, token: `Bearer ${SECRET}` }),
    (e: unknown) =>
      e instanceof TangledBlobError &&
      e.kind === "read-failed" &&
      e.message.includes("empty blob"),
    "no zero-byte success at the fetch boundary",
  );
});

test("every new failure path: TangledBlobError messages never contain the token", async () => {
  const noNetwork = makeFetch(() => {
    throw new Error("no network for an invalid DID");
  }).fetchImpl;
  const emptyBlob = twoHop(
    didDoc(DID, [pdsService("https://pds.example.com")]),
    () => new Response(null, { status: 200 }),
  ).fetchImpl;
  const httpLoopback = twoHop(
    didDoc(DID, [pdsService("http://localhost:2584")]),
    () => new Response(null, { status: 200 }), // empty blob over http, token passed
  ).fetchImpl;
  const scenarios: Array<() => Promise<unknown>> = [
    () => fetchAtprotoBlob("did:plc:abc/../admin", "bafybeiblob0", { fetchImpl: noNetwork, token: `Bearer ${SECRET}` }),
    () => fetchAtprotoBlob("did:plc:a?b", "bafybeiblob0", { fetchImpl: noNetwork, token: `Bearer ${SECRET}` }),
    () => fetchAtprotoBlob("did:plc:a#b", "bafybeiblob0", { fetchImpl: noNetwork, token: `Bearer ${SECRET}` }),
    () => fetchAtprotoBlob("did:plc:a%20b", "bafybeiblob0", { fetchImpl: noNetwork, token: `Bearer ${SECRET}` }),
    () => fetchAtprotoBlob("did:web:999.999.999.999", "bafybeiblob0", { fetchImpl: noNetwork, token: `Bearer ${SECRET}` }),
    () => fetchAtprotoBlob("did:web:example.com:99999", "bafybeiblob0", { fetchImpl: noNetwork, token: `Bearer ${SECRET}` }),
    () => resolveAuthorPdsEndpoint("did:web:999.999.999.999", { fetchImpl: noNetwork }),
    () => resolveAuthorPdsEndpoint("did:web:example.com:99999", { fetchImpl: noNetwork }),
    () => fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl: emptyBlob, token: `Bearer ${SECRET}` }),
    () => fetchAtprotoBlob(DID, "bafybeiblob0", { fetchImpl: httpLoopback, token: `Bearer ${SECRET}` }),
  ];
  for (const run of scenarios) {
    await assert.rejects(
      run(),
      (e: unknown) => {
        assert.ok(
          e instanceof TangledBlobError,
          `expected a TangledBlobError, got ${e instanceof Error ? `${e.name}: ${e.message}` : typeof e}`,
        );
        assert.ok(!e.message.includes(SECRET), `the error message must not contain the token: ${e.message}`);
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
