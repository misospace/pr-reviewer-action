import test from "node:test";
import assert from "node:assert/strict";
import { githubAncillaryWrite, githubApiBase } from "../src/platform/github-ancillary.js";
import { startMockServer } from "./helpers.js";

test("GitHub ancillary writes use the typed transport for DELETE and JSON POST", async () => {
  const received: Array<{ method: string | undefined; path: string | undefined; authorization: string | undefined; body: string }> = [];
  const server = await startMockServer((req, body, res) => {
    received.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });
    res.statusCode = 200;
    res.end("{}");
  });
  try {
    const env = { GITHUB_API_URL: server.url, GH_TOKEN: "test-token" };
    await githubAncillaryWrite(env, `${server.url}/repos/o/r/issues/7/labels/ai-review`, "DELETE");
    await githubAncillaryWrite(env, `${server.url}/repos/o/r/issues/7/comments`, "POST", { body: "reply" });
    assert.deepEqual(received, [
      { method: "DELETE", path: "/repos/o/r/issues/7/labels/ai-review", authorization: "Bearer test-token", body: "" },
      { method: "POST", path: "/repos/o/r/issues/7/comments", authorization: "Bearer test-token", body: JSON.stringify({ body: "reply" }) },
    ]);
  } finally {
    await server.close();
  }
});

test("GitHub API base defaults when unset or empty", () => {
  assert.equal(githubApiBase({}), "https://api.github.com");
  assert.equal(githubApiBase({ GITHUB_API_URL: "" }), "https://api.github.com");
});

test("GitHub ancillary base validation rejects hostile bases before making requests", async () => {
  const server = await startMockServer((_req, _body, res) => { res.end("{}"); });
  try {
    // The embedded-credential base shares the mock's origin, so origin
    // binding alone cannot mask a regression of the validation that must
    // refuse it: only `parsePlatformBaseUrl`'s checks stand between the
    // hostile base and a request. `GH_TOKEN` carries each base, so a
    // diagnostic that echoed the rejected value would leak it.
    for (const base of ["ftp://x", "not a url", `http://user:pass@127.0.0.1:${new URL(server.url).port}`, "   "]) {
      await assert.rejects(
        githubAncillaryWrite({ GITHUB_API_URL: base, GH_TOKEN: base }, `${server.url}/write`, "POST", {}),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          if (base.trim() !== "") assert.equal(error.message.includes(base.trim()), false);
          return true;
        },
      );
    }
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("GitHub ancillary writes refuse a URL on a different origin", async () => {
  const base = await startMockServer((_req, _body, res) => { res.end("{}"); });
  const foreign = await startMockServer((_req, _body, res) => { res.end("{}"); });
  try {
    await assert.rejects(
      githubAncillaryWrite({ GITHUB_API_URL: base.url, GH_TOKEN: "secret" }, `${foreign.url}/write`, "POST", {}),
    );
    assert.equal(base.requests.length, 0);
    assert.equal(foreign.requests.length, 0);
  } finally {
    await base.close();
    await foreign.close();
  }
});

test("GitHub ancillary writes refuse redirects without forwarding credentials", async () => {
  const target = await startMockServer((_req, _body, res) => { res.end("{}"); });
  const source = await startMockServer((_req, _body, res) => {
    res.statusCode = 302;
    res.setHeader("Location", `${target.url}/redirected`);
    res.end();
  });
  try {
    await assert.rejects(
      githubAncillaryWrite({ GITHUB_API_URL: source.url, GH_TOKEN: "secret" }, `${source.url}/write`, "POST", {}),
    );
    assert.equal(source.requests.length, 1);
    assert.equal(target.requests.length, 0);
  } finally {
    await source.close();
    await target.close();
  }
});

test("GitHub ancillary transport errors do not expose credentials", async () => {
  const server = await startMockServer((_req, _body, res) => { res.end("{}"); });
  const url = server.url;
  await server.close();
  const token = "credential-must-not-appear";
  await assert.rejects(
    githubAncillaryWrite({ GITHUB_API_URL: url, GH_TOKEN: token }, `${url}/write`, "POST", {}),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(token), false);
      return true;
    },
  );
});
