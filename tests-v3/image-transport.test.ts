import test from "node:test";
import assert from "node:assert/strict";
import {
  MANIFEST_ACCEPT,
  buildImageProvenanceContext,
  createImageHttpJson,
  fetchAllMetadata,
  imageDigestDeadline,
  imageTransportAllows,
  parseDiff,
} from "../src/context/index.js";

const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const CFG = "a".repeat(64);
const TOKEN_URL = "https://ghcr.io/token?scope=repository:o%2Fapp:pull";

interface Seen {
  url: string;
  headers: Record<string, string>;
}

type Route = (url: string) => { status?: number; body?: string; location?: string } | Error;

function fakeFetch(route: Route): { fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    seen.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
    const answer = route(url);
    if (answer instanceof Error) throw answer;
    const headers: Record<string, string> = answer.location ? { location: answer.location } : {};
    return new Response(answer.body ?? "{}", { status: answer.status ?? 200, headers });
  };
  return { fetchImpl, seen };
}

test("transport sends v2's headers: Bearer + manifest Accept, curl's */* default, shared UA", async () => {
  const { fetchImpl, seen } = fakeFetch(() => ({ body: '{"ok": true}' }));
  const httpJson = createImageHttpJson({ fetchImpl });
  await httpJson(`https://ghcr.io/v2/o/app/manifests/sha256:${D1}`, { Authorization: "Bearer t0k", Accept: MANIFEST_ACCEPT });
  await httpJson(TOKEN_URL);
  assert.equal(seen[0]?.headers.Authorization, "Bearer t0k");
  assert.equal(seen[0]?.headers.Accept, MANIFEST_ACCEPT);
  assert.equal(seen[1]?.headers.Accept, "*/*");
  assert.equal(seen[1]?.headers.Authorization, undefined);
  assert.equal(seen[1]?.headers["User-Agent"], "ai-pr-reviewer/1.0");
});

test("the GitHub compare is unauthenticated unless githubToken is opted in, and never off github", async () => {
  const compare = "https://api.github.com/repos/o/app/compare/aaa...bbb";
  const plain = fakeFetch(() => ({ body: "{}" }));
  await createImageHttpJson({ fetchImpl: plain.fetchImpl })(compare, { Accept: "application/vnd.github+json" });
  assert.equal(plain.seen[0]?.headers.Authorization, undefined, "v2 parity: no token on the compare");

  const opted = fakeFetch(() => ({ body: "{}" }));
  const httpJson = createImageHttpJson({ fetchImpl: opted.fetchImpl, githubToken: "gh-secret" });
  await httpJson(compare, { Accept: "application/vnd.github+json" });
  await httpJson(TOKEN_URL);
  assert.equal(opted.seen[0]?.headers.Authorization, "Bearer gh-secret");
  assert.equal(opted.seen[1]?.headers.Authorization, undefined, "the GitHub token never reaches a registry");
});

test("redirects are followed; Authorization survives same-origin hops and is dropped cross-origin", async () => {
  const blob = `https://ghcr.io/v2/o/app/blobs/sha256:${CFG}`;
  const { fetchImpl, seen } = fakeFetch((url) => {
    if (url === blob) return { status: 307, location: "/v2/o/app/blobs/moved" };
    if (url.endsWith("/moved")) return { status: 302, location: "https://cdn.example.net/blob?sig=1" };
    return { body: '{"created": "2026-01-01"}' };
  });
  const data = await createImageHttpJson({ fetchImpl })(blob, { Authorization: "Bearer reg-token" });
  assert.deepEqual(data, { created: "2026-01-01" });
  assert.equal(seen.length, 3);
  assert.equal(seen[1]?.headers.Authorization, "Bearer reg-token");
  assert.equal(seen[2]?.url, "https://cdn.example.net/blob?sig=1");
  assert.equal(seen[2]?.headers.Authorization, undefined, "curl >= 7.58: no Authorization to another host");
});

test("a redirect off https or past curl's 50-hop limit fails like curl", async () => {
  const manifest = `https://ghcr.io/v2/o/app/manifests/sha256:${D1}`;
  const downgrade = fakeFetch(() => ({ status: 302, location: "http://insecure.example/x" }));
  await assert.rejects(createImageHttpJson({ fetchImpl: downgrade.fetchImpl })(manifest), /exit status 1\.$/);
  const loop = fakeFetch(() => ({ status: 302, location: manifest }));
  await assert.rejects(createImageHttpJson({ fetchImpl: loop.fetchImpl })(manifest), /exit status 47\.$/);
  assert.equal(loop.seen.length, 51);
});

test("HTTP errors carry v2's CalledProcessError wording with the credential redacted", async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 404, body: "{}" }));
  const url = `https://ghcr.io/v2/o/app/manifests/sha256:${D1}`;
  const error = await createImageHttpJson({ fetchImpl })(url, { Authorization: "Bearer super-secret-registry-token", Accept: "x/y" }).catch((e: unknown) => e as Error);
  assert.ok(error instanceof Error);
  assert.equal(
    error.message,
    `HTTP request failed: Command '['curl', '-fsSL', '--connect-timeout', '20', '--max-time', '40', '${url}', '-H', 'Authorization: [REDACTED]', '-H', 'Accept: x/y']' returned non-zero exit status 22.`,
  );
  assert.equal(error.message.includes("super-secret-registry-token"), false);
});

test("transport failures map to curl exit statuses; bodies decode with CPython's JSON errors", async () => {
  const url = TOKEN_URL;
  const timeout = fakeFetch(() => Object.assign(new Error("timed out"), { name: "TimeoutError" }));
  await assert.rejects(createImageHttpJson({ fetchImpl: timeout.fetchImpl })(url), /exit status 28\.$/);
  const dns = fakeFetch(() => Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }));
  await assert.rejects(createImageHttpJson({ fetchImpl: dns.fetchImpl })(url), /exit status 6\.$/);
  const html = fakeFetch(() => ({ body: "<html>" }));
  await assert.rejects(createImageHttpJson({ fetchImpl: html.fetchImpl })(url), /^Error: HTTP request failed: Expecting value: line 1 column 1 \(char 0\)$/);
  const bom = fakeFetch(() => ({ body: "﻿{}" }));
  await assert.rejects(createImageHttpJson({ fetchImpl: bom.fetchImpl })(url), /Unexpected UTF-8 BOM/);
});

test("the endpoint allowlist refuses hostile digests, revisions, hosts, and URL tricks before any request", async () => {
  const { fetchImpl, seen } = fakeFetch(() => ({ body: "{}" }));
  const httpJson = createImageHttpJson({ fetchImpl });
  const refused = [
    "https://ghcr.io/v2/o/app/blobs/../../../v2/other/secret",
    "https://ghcr.io/v2/o/app/blobs/sha256:abc?x=1",
    "https://ghcr.io:8443/v2/o/app/blobs/sha256:abc",
    "https://evil.example/v2/o/app/blobs/sha256:abc",
    "https://registry-1.docker.io/token",
    "https://api.github.com/repos/o/app/compare/a...b?per_page=1",
    "https://api.github.com/repos/o/app/compare/../../user",
    "https://api.github.com/repos/o/app/compare/%2e%2e/%2e%2e/user",
    "https://api.github.com/repos/o/../compare/a...b",
    "https://api.github.com/user",
    "http://ghcr.io/token",
  ];
  for (const url of refused) {
    assert.equal(imageTransportAllows(url), false, url);
    await assert.rejects(httpJson(url), /outside the image-provenance endpoint allowlist/, url);
  }
  assert.equal(seen.length, 0);
  assert.equal(imageTransportAllows(`https://registry-1.docker.io/v2/library/nginx/manifests/sha256:${D1}`), true);
  assert.equal(imageTransportAllows("https://auth.docker.io/token?service=registry.docker.io&scope=repository:library%2Fnginx:pull"), true);
  assert.equal(imageTransportAllows("https://api.github.com/repos/o/app/compare/abc123...def456"), true);
});

test("one anonymous token per repository serves every digest (v2 _TOKEN_CACHE)", async () => {
  const diff = ["+  repository: ghcr.io/o/app", `-  tag: v1@sha256:${D1}`, `+  tag: v1@sha256:${D2}`].join("\n");
  const { fetchImpl, seen } = fakeFetch((url) => {
    if (url.includes("/token")) return { body: '{"token": "anon"}' };
    if (url.includes("/manifests/")) return { body: `{"config": {"digest": "sha256:${CFG}"}}` };
    return { body: '{"config": {"Labels": {}}}' };
  });
  const metas = await fetchAllMetadata(parseDiff(diff), createImageHttpJson({ fetchImpl }));
  assert.equal(metas.size, 2);
  assert.equal(seen.filter((request) => request.url.includes("/token")).length, 1);
  assert.ok(seen.filter((request) => !request.url.includes("/token")).every((request) => request.headers.Authorization === "Bearer anon"));
});

test("an expired IMAGE_DIGEST_BUDGET_SEC deadline stops fetching", async () => {
  const diff = ["+  repository: ghcr.io/o/app", `-  tag: v1@sha256:${D1}`, `+  tag: v1@sha256:${D2}`].join("\n");
  const { fetchImpl, seen } = fakeFetch(() => ({ body: "{}" }));
  const markdown = await buildImageProvenanceContext(diff, createImageHttpJson({ fetchImpl }), Date.now() - 1);
  assert.equal(seen.length, 0);
  assert.match(markdown, /Old digest metadata error: `image digest time budget exceeded`/);
});

test("imageDigestDeadline parses like DeadlineBudget.from_env (default 60, <=0 disables)", () => {
  assert.equal(imageDigestDeadline({}, 1000), 61_000);
  assert.equal(imageDigestDeadline({ IMAGE_DIGEST_BUDGET_SEC: " 5 " }, 0), 5000);
  assert.equal(imageDigestDeadline({ IMAGE_DIGEST_BUDGET_SEC: "" }, 0), 60_000);
  assert.equal(imageDigestDeadline({ IMAGE_DIGEST_BUDGET_SEC: "junk" }, 0), 60_000);
  assert.equal(imageDigestDeadline({ IMAGE_DIGEST_BUDGET_SEC: "0" }, 0), null);
  assert.equal(imageDigestDeadline({ IMAGE_DIGEST_BUDGET_SEC: "-3" }, 0), null);
});
