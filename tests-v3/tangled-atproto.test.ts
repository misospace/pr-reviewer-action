import test from "node:test";
import assert from "node:assert/strict";
import { atprotoConfigFromEnv, TangledAtprotoClient, TangledAtprotoError } from "../src/platform/tangled-atproto.js";
import type { FetchLike } from "../src/platform/http.js";

/**
 * Generic AT-Proto session/record client (#837), exercised through an
 * injected mock transport — no network.
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

const HOST = "https://pds.test";
const SESSION = { did: "did:plc:tester", accessJwt: "access.jwt.value", refreshJwt: "refresh.jwt.value" };
const SESSION_OK = (): Response => json(SESSION);

interface TestConfig {
  host: string;
  handle: string;
  appPassword: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

function makeConfig(over: Partial<TestConfig> = {}): TestConfig {
  return { host: HOST, handle: "alice.test", appPassword: "hunter2", timeoutMs: 5000, ...over };
}

// ── atprotoConfigFromEnv ────────────────────────────────────────────────

test("config from env: defaults and parsing", () => {
  const cfg = atprotoConfigFromEnv({
    ATPROTO_HANDLE: "alice.test",
    ATPROTO_APP_PASSWORD: "pw",
  });
  assert.equal(cfg.host, "https://bsky.social/");
  assert.equal(cfg.handle, "alice.test");
  assert.equal(cfg.appPassword, "pw");
  assert.equal(cfg.timeoutMs, 30_000);
});

test("config from env: missing handle or app password names the variable", () => {
  assert.throws(
    () => atprotoConfigFromEnv({ ATPROTO_APP_PASSWORD: "pw" }),
    (e: unknown) => e instanceof TangledAtprotoError && e.message.includes("ATPROTO_HANDLE"),
  );
  assert.throws(
    () => atprotoConfigFromEnv({ ATPROTO_HANDLE: "alice.test" }),
    (e: unknown) => e instanceof TangledAtprotoError && e.message.includes("ATPROTO_APP_PASSWORD"),
  );
});

test("config from env: ATPROTO_TIMEOUT parsing", () => {
  const ok = atprotoConfigFromEnv({
    ATPROTO_HANDLE: "a",
    ATPROTO_APP_PASSWORD: "p",
    ATPROTO_TIMEOUT: "5",
  });
  assert.equal(ok.timeoutMs, 5000);
  for (const bad of ["zero-or-less-is-checked-below", "-1", "0", "abc", "Infinity", "NaN"]) {
    if (bad === "zero-or-less-is-checked-below") continue;
    assert.throws(
      () =>
        atprotoConfigFromEnv({
          ATPROTO_HANDLE: "a",
          ATPROTO_APP_PASSWORD: "p",
          ATPROTO_TIMEOUT: bad,
        }),
      (e: unknown) => e instanceof TangledAtprotoError && e.message.includes("ATPROTO_TIMEOUT"),
      bad,
    );
  }
});

test("config from env: plaintext non-loopback host rejected, loopback accepted", () => {
  assert.throws(
    () =>
      atprotoConfigFromEnv({
        ATPROTO_HANDLE: "a",
        ATPROTO_APP_PASSWORD: "p",
        ATPROTO_HOST: "http://pds.example.com",
      }),
    (e: unknown) => e instanceof TangledAtprotoError && e.message.includes("ATPROTO_HOST"),
  );
  for (const host of ["http://localhost:8080", "http://127.0.0.1", "http://[::1]:3000"]) {
    const cfg = atprotoConfigFromEnv({
      ATPROTO_HANDLE: "a",
      ATPROTO_APP_PASSWORD: "p",
      ATPROTO_HOST: host,
    });
    assert.equal(cfg.host.startsWith("http://"), true, host);
  }
});

test("config from env: garbage host rejected", () => {
  for (const host of ["not a url", "ftp://x", "https://", "https://bad host"]) {
    assert.throws(
      () =>
        atprotoConfigFromEnv({
          ATPROTO_HANDLE: "a",
          ATPROTO_APP_PASSWORD: "p",
          ATPROTO_HOST: host,
        }),
      (e: unknown) => e instanceof TangledAtprotoError,
      host,
    );
  }
});

// ── session establishment ───────────────────────────────────────────────

test("client construction makes zero requests (lazy session)", () => {
  const { fetchImpl, calls } = makeFetch(() => SESSION_OK());
  new TangledAtprotoClient(makeConfig({ fetchImpl }));
  assert.equal(calls.length, 0);
});

test("createSession request shape: URL, POST body, no Authorization", async () => {
  const { fetchImpl, calls } = makeFetch((url) =>
    url.pathname.endsWith("createSession") ? SESSION_OK() : json({ uri: "at://u/1", cid: "c1" }),
  );
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  const created = await client.createRecord("sh.tangled.repo.pull", { x: 1 });
  assert.deepEqual(created, { uri: "at://u/1", cid: "c1" });
  const sessionCall = calls[0];
  assert.ok(sessionCall);
  assert.equal(sessionCall.nsid, "com.atproto.server.createSession");
  assert.equal(sessionCall.url.toString(), `${HOST}/xrpc/com.atproto.server.createSession`);
  assert.equal(sessionCall.auth, null, "createSession must carry no Authorization header");
  assert.deepEqual(JSON.parse(String(sessionCall.body)), {
    identifier: "alice.test",
    password: "hunter2",
  });
  const createCall = calls[1];
  assert.ok(createCall);
  assert.equal(createCall.nsid, "com.atproto.repo.createRecord");
});

// ── createRecord / putRecord / listRecords ──────────────────────────────

test("createRecord: URL, method, bearer token, body, response validation", async () => {
  const { fetchImpl, calls } = makeFetch((url) => {
    if (url.pathname.endsWith("createSession")) return SESSION_OK();
    return json({ uri: "at://did:plc:tester/sh.tangled.repo.pull/3k", cid: "bafy1" });
  });
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  const out = await client.createRecord("sh.tangled.repo.pull", { title: "t" });
  assert.deepEqual(out, { uri: "at://did:plc:tester/sh.tangled.repo.pull/3k", cid: "bafy1" });
  const call = calls[1];
  assert.ok(call);
  assert.equal(call.url.toString(), `${HOST}/xrpc/com.atproto.repo.createRecord`);
  assert.equal(call.auth, `Bearer ${SESSION.accessJwt}`);
  assert.deepEqual(JSON.parse(String(call.body)), {
    repo: SESSION.did,
    collection: "sh.tangled.repo.pull",
    record: { title: "t" },
  });
});

test("createRecord: malformed response (missing uri/cid) fails closed", async () => {
  const { fetchImpl } = makeFetch((url) =>
    url.pathname.endsWith("createSession") ? SESSION_OK() : json({ uri: "at://x" }),
  );
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  await assert.rejects(
    () => client.createRecord("app.test.thing", {}),
    (e: unknown) => e instanceof TangledAtprotoError && e.kind === "invalid-response",
  );
});

test("putRecord: URL, method, bearer token, body shape", async () => {
  const { fetchImpl, calls } = makeFetch((url) => {
    if (url.pathname.endsWith("createSession")) return SESSION_OK();
    return json({ uri: "at://did:plc:tester/app.test.thing/rkey1", cid: "bafy2" });
  });
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  const out = await client.putRecord("app.test.thing", "rkey1", { v: 2 });
  assert.deepEqual(out, { uri: "at://did:plc:tester/app.test.thing/rkey1", cid: "bafy2" });
  const call = calls[1];
  assert.ok(call);
  assert.equal(call.nsid, "com.atproto.repo.putRecord");
  assert.equal(call.auth, `Bearer ${SESSION.accessJwt}`);
  assert.deepEqual(JSON.parse(String(call.body)), {
    repo: SESSION.did,
    collection: "app.test.thing",
    rkey: "rkey1",
    record: { v: 2 },
  });
});

test("listRecords: exact query shape and default limit", async () => {
  const { fetchImpl, calls } = makeFetch((url) => {
    if (url.pathname.endsWith("createSession")) return SESSION_OK();
    return json({
      records: [
        { uri: "at://d/c/1", cid: "c-1", value: { a: 1 } },
        { uri: "at://d/c/2", value: { b: 2 } },
      ],
      cursor: "next-page",
    });
  });
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  const page = await client.listRecords("app.test.thing");
  assert.equal(page.cursor, "next-page");
  assert.equal(page.records.length, 2);
  assert.deepEqual(page.records[0], { uri: "at://d/c/1", cid: "c-1", value: { a: 1 } });
  assert.deepEqual(page.records[1], { uri: "at://d/c/2", cid: undefined, value: { b: 2 } });
  const call = calls[1];
  assert.ok(call);
  assert.equal(call.nsid, "com.atproto.repo.listRecords");
  assert.equal(call.auth, `Bearer ${SESSION.accessJwt}`);
  assert.deepEqual(call.query, {
    repo: SESSION.did,
    collection: "app.test.thing",
    limit: "50",
  });
});

test("listRecords: explicit limit and cursor in query; limit clamped", async () => {
  const { fetchImpl, calls } = makeFetch((url) => {
    if (url.pathname.endsWith("createSession")) return SESSION_OK();
    return json({ records: [], cursor: null });
  });
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  await client.listRecords("app.test.thing", { limit: 10, cursor: "cur1" });
  assert.deepEqual(calls[1]?.query, {
    repo: SESSION.did,
    collection: "app.test.thing",
    limit: "10",
    cursor: "cur1",
  });
  await client.listRecords("app.test.thing", { limit: 500 });
  assert.equal(calls[2]?.query.limit, "100");
  await client.listRecords("app.test.thing", { limit: 0 });
  assert.equal(calls[3]?.query.limit, "1");
});

test("listRecords: non-object values dropped; cursor absent when empty", async () => {
  const { fetchImpl } = makeFetch((url) => {
    if (url.pathname.endsWith("createSession")) return SESSION_OK();
    return json({
      records: [
        { uri: "at://d/c/1", cid: "c1", value: "not-an-object" },
        { uri: "at://d/c/2", value: { ok: true } },
        "junk",
        { uri: "at://d/c/3", value: [1, 2] },
      ],
      cursor: "",
    });
  });
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  const page = await client.listRecords("app.test.thing");
  assert.deepEqual(page.records, [{ uri: "at://d/c/2", cid: undefined, value: { ok: true } }]);
  assert.equal(page.cursor, undefined);
});

// ── expired-session retry ───────────────────────────────────────────────

test("expired session (401): re-auth once, retry once, succeed", async () => {
  let recordCalls = 0;
  let sessionCalls = 0;
  const { fetchImpl, calls } = makeFetch((url) => {
    if (url.pathname.endsWith("createSession")) {
      sessionCalls += 1;
      return SESSION_OK();
    }
    recordCalls += 1;
    if (recordCalls === 1) return json({ error: "ExpiredToken", message: "token expired" }, 401);
    return json({ uri: "at://u/1", cid: "c" });
  });
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  const out = await client.createRecord("app.test.thing", {});
  assert.deepEqual(out, { uri: "at://u/1", cid: "c" });
  assert.equal(sessionCalls, 2, "exactly one re-auth");
  assert.equal(recordCalls, 2, "original call + one retry");
  // createSession, createRecord(401), createSession, createRecord(ok) = 4 calls
  assert.equal(calls.length, 4);
  assert.equal(calls[1]?.auth, `Bearer ${SESSION.accessJwt}`);
  assert.equal(calls[3]?.auth, `Bearer ${SESSION.accessJwt}`);
});

test("expired session via 200 body error field triggers one retry", async () => {
  let recordCalls = 0;
  let sessionCalls = 0;
  const { fetchImpl, calls } = makeFetch((url) => {
    if (url.pathname.endsWith("createSession")) {
      sessionCalls += 1;
      return SESSION_OK();
    }
    recordCalls += 1;
    if (recordCalls === 1) return json({ error: "ExpiredToken" }, 200);
    return json({ uri: "at://u/1", cid: "c" });
  });
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  const out = await client.createRecord("app.test.thing", {});
  assert.deepEqual(out, { uri: "at://u/1", cid: "c" });
  assert.equal(recordCalls, 2);
  assert.equal(sessionCalls, 2);
  assert.equal(calls.length, 4);
});

test("persistent 401 after re-auth: throws after exactly one retry, not a loop", async () => {
  const { fetchImpl, calls } = makeFetch((url) => {
    if (url.pathname.endsWith("createSession")) return SESSION_OK();
    return json({ error: "ExpiredToken" }, 401);
  });
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  await assert.rejects(
    () => client.createRecord("app.test.thing", {}),
    (e: unknown) => e instanceof TangledAtprotoError && e.kind === "auth",
  );
  // createSession, createRecord(401), createSession, createRecord(401) = 4
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((c) => c.nsid === "com.atproto.server.createSession").length, 2);
});

test("failure during re-auth propagates (no loop)", async () => {
  let sessionCalls = 0;
  const { fetchImpl, calls } = makeFetch((url) => {
    if (url.pathname.endsWith("createSession")) {
      sessionCalls += 1;
      if (sessionCalls === 1) return SESSION_OK(); // first session is fine
      return json({ error: "AuthenticationRequired", message: "re-auth refused" }, 401);
    }
    return json({ error: "ExpiredToken" }, 401);
  });
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  await assert.rejects(
    () => client.createRecord("app.test.thing", {}),
    (e: unknown) => e instanceof TangledAtprotoError && e.kind === "auth",
  );
  // createSession(ok), createRecord(401), createSession(401) = 3
  assert.equal(calls.length, 3);
  assert.equal(sessionCalls, 2);
});

// ── secret redaction ────────────────────────────────────────────────────

test("server error payload with JWT-shaped material or the password is redacted", async () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdGF0dXMifq.sig";
  const { fetchImpl } = makeFetch((url) => {
    if (url.pathname.endsWith("createSession")) return SESSION_OK();
    return json({ error: "X", message: `oops ${jwt} and password hunter2` }, 500);
  });
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  const error = (await client.createRecord("app.test.thing", {}).catch((e: unknown) => e)) as TangledAtprotoError;
  assert.ok(error instanceof TangledAtprotoError);
  assert.equal(error.message.includes(jwt), false, "message must not contain the JWT");
  assert.equal(error.message.includes("hunter2"), false, "message must not contain the password");
  assert.equal(error.message.includes("redacted"), true);
});

test("createSession failure message never leaks the password", async () => {
  const { fetchImpl } = makeFetch(() => json({ error: "AuthenticationRequired", message: "bad password hunter2" }, 401));
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  await assert.rejects(
    () => client.listRecords("app.test.thing"),
    (e: unknown) => {
      assert.ok(e instanceof TangledAtprotoError);
      assert.equal(e.message.includes("hunter2"), false);
      return true;
    },
  );
});

test("transport throw messages are redacted of password/JWT material", async () => {
  const { fetchImpl } = makeFetch(() => {
    throw new Error(`boom eyJhbGciOiJub25lLHRva2Vu.signature leaked with password hunter2`);
  });
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  await assert.rejects(
    () => client.createRecord("app.test.thing", {}),
    (e: unknown) => {
      assert.ok(e instanceof TangledAtprotoError);
      assert.equal(e.message.includes("eyJ"), false);
      assert.equal(e.message.includes("hunter2"), false);
      return true;
    },
  );
});

// ── malformed / non-OK responses ────────────────────────────────────────

test("non-JSON 200 body throws invalid-response", async () => {
  const { fetchImpl } = makeFetch((url) =>
    url.pathname.endsWith("createSession")
      ? SESSION_OK()
      : new Response("<html>not json</html>", { status: 200 }),
  );
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  await assert.rejects(
    () => client.listRecords("app.test.thing"),
    (e: unknown) => e instanceof TangledAtprotoError && e.kind === "invalid-response",
  );
});

test("4xx without token-error code throws request kind with status in message", async () => {
  const { fetchImpl } = makeFetch((url) => {
    if (url.pathname.endsWith("createSession")) return SESSION_OK();
    return json({ error: "RecordNotFound", message: "no such record" }, 404);
  });
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  await assert.rejects(
    () => client.putRecord("app.test.thing", "rk", {}),
    (e: unknown) => {
      assert.ok(e instanceof TangledAtprotoError);
      assert.equal(e.kind, "request");
      assert.equal(e.message.includes("404"), true);
      assert.equal(e.message.includes("no such record"), true);
      return true;
    },
  );
});

test("missing records array fails closed", async () => {
  const { fetchImpl } = makeFetch((url) => {
    if (url.pathname.endsWith("createSession")) return SESSION_OK();
    return json({ nope: true });
  });
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  await assert.rejects(
    () => client.listRecords("app.test.thing"),
    (e: unknown) => e instanceof TangledAtprotoError && e.kind === "invalid-response",
  );
});

test("redirect responses are refused (credentials never cross origins)", async () => {
  const { fetchImpl } = makeFetch(
    () => new Response(null, { status: 302, headers: { location: "https://evil.test/xrpc" } }),
  );
  const client = new TangledAtprotoClient(makeConfig({ fetchImpl }));
  await assert.rejects(() => client.createRecord("app.test.thing", {}), TangledAtprotoError);
});
