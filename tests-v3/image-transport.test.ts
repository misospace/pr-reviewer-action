import test from "node:test";
import assert from "node:assert/strict";
import {
  MANIFEST_ACCEPT,
  buildImageProvenanceContext,
  createImageHttpJson,
  fetchAllMetadata,
  fetchDigestMetadata,
  imageDigestDeadline,
  imageTransportAllows,
  parseDiff,
  type RegistryTokenCache,
} from "../src/context/index.js";
import { pinnedLookup, type ExchangeRequest, type ExchangeResponse } from "../src/platform/safe-fetch.js";

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

// ── SSRF fence on every hop (#806 review; #808's safeFetchLike) ───────────

interface SafeHarness {
  exchanged: ExchangeRequest[];
  lookups: string[];
  httpJson: ReturnType<typeof createImageHttpJson>;
}

/** The real safe transport over a fake DNS and socket layer: the first hop
 * (an allowlisted registry blob) redirects to *location*. */
function safeHarness(location: string, dns: Record<string, string[] | (() => string[])>, maxBytes?: number): SafeHarness {
  const exchanged: ExchangeRequest[] = [];
  const lookups: string[] = [];
  const resolver = async (host: string): Promise<string[]> => {
    lookups.push(host);
    const answer = dns[host] ?? ["93.184.216.34"];
    return typeof answer === "function" ? answer() : answer;
  };
  const exchange = async (request: ExchangeRequest): Promise<ExchangeResponse> => {
    exchanged.push(request);
    if (request.host === "ghcr.io") return { status: 302, headers: { location }, body: Buffer.alloc(0) };
    return { status: 200, headers: {}, body: Buffer.from('{"created": "2026-01-01", "pad": "' + "x".repeat(2048) + '"}') };
  };
  return { exchanged, lookups, httpJson: createImageHttpJson({ resolver, exchange, ...(maxBytes ? { maxBytes } : {}) }) };
}

const BLOB = `https://ghcr.io/v2/o/app/blobs/sha256:${CFG}`;

test("a public CDN redirect is followed through the fence; Authorization stays on ghcr.io", async () => {
  const harness = safeHarness("https://pkg-containers.githubusercontent.com/b?sig=1", { "pkg-containers.githubusercontent.com": ["185.199.108.154"] });
  const data = (await harness.httpJson(BLOB, { Authorization: "Bearer reg" })) as Record<string, unknown>;
  assert.equal(data.created, "2026-01-01");
  assert.deepEqual(harness.exchanged.map((r) => [r.host, r.addresses, r.headers.authorization]), [
    ["ghcr.io", ["93.184.216.34"], "Bearer reg"],
    ["pkg-containers.githubusercontent.com", ["185.199.108.154"], undefined],
  ]);
});

test("adversarial: redirects to loopback, RFC1918, link-local/metadata and IPv6 local are refused before the second request", async () => {
  const cases: Array<[string, Record<string, string[]>]> = [
    ["https://127.0.0.1/admin", {}],
    ["https://localhost.attacker.test/x", { "localhost.attacker.test": ["127.0.0.1"] }],
    ["https://10.1.2.3/x", {}],
    ["https://internal.corp.test/x", { "internal.corp.test": ["93.184.216.34", "192.168.1.10"] }],
    ["https://169.254.169.254/latest/meta-data/iam/security-credentials/", {}],
    ["https://metadata.attacker.test/computeMetadata/v1/", { "metadata.attacker.test": ["169.254.169.254"] }],
    ["https://[::1]/x", {}],
    ["https://[fe80::1]/x", {}],
    ["https://v6.attacker.test/x", { "v6.attacker.test": ["fd00::7"] }],
  ];
  for (const [location, dns] of cases) {
    const harness = safeHarness(location, dns);
    await assert.rejects(harness.httpJson(BLOB, { Authorization: "Bearer reg" }), /refusing redirect hop: host .* does not resolve to public addresses only/, location);
    assert.equal(harness.exchanged.length, 1, `${location}: the second request is never made`);
  }
});

test("adversarial: redirects to a disallowed scheme or with userinfo are refused before the second request", async () => {
  for (const location of ["http://pkg-containers.githubusercontent.com/b", "ftp://files.example/b", "file:///etc/passwd", "gopher://x.example/"]) {
    const harness = safeHarness(location, {});
    await assert.rejects(harness.httpJson(BLOB), /exit status 1\.$/, location);
    assert.equal(harness.exchanged.length, 1, location);
    assert.deepEqual(harness.lookups, ["ghcr.io"], `${location}: the refused hop is never even resolved`);
  }
  const creds = safeHarness("https://user:pw@cdn.example/b", {});
  await assert.rejects(creds.httpJson(BLOB), /refusing redirect hop: credentials in URL not allowed/);
  assert.equal(creds.exchanged.length, 1);
});

test("adversarial: a DNS answer that flips after validation is never used — the connect is pinned", async () => {
  let calls = 0;
  const flipping = (): string[] => {
    calls += 1;
    return calls === 1 ? ["185.199.108.154"] : ["127.0.0.1"];
  };
  const harness = safeHarness("https://cdn.flip.test/b", { "cdn.flip.test": flipping });
  await harness.httpJson(BLOB);
  const hop = harness.exchanged[1] as ExchangeRequest;
  assert.deepEqual(hop.addresses, ["185.199.108.154"], "the exchange is pinned to the validated answer");
  assert.equal(harness.lookups.filter((host) => host === "cdn.flip.test").length, 1, "one resolution per hop, none at connect time");
  // The socket's lookup hook answers only the validated address, whatever
  // DNS would now say, and nothing for any other hostname.
  const lookup = pinnedLookup(hop.host, hop.addresses);
  const answer = await new Promise<string>((resolve, reject) => {
    lookup("cdn.flip.test", { family: 0 } as never, (error: unknown, address: unknown) => (error ? reject(error as Error) : resolve(String(address))));
  });
  assert.equal(answer, "185.199.108.154");
  await assert.rejects(new Promise((resolve, reject) => {
    lookup("127.0.0.1.nip.io", { family: 0 } as never, (error: unknown, address: unknown) => (error ? reject(error as Error) : resolve(address)));
  }));

  // A flip that lands on the hop's own validation is refused outright.
  calls = 1;
  const flipped = safeHarness("https://cdn.flip.test/b", { "cdn.flip.test": flipping });
  await assert.rejects(flipped.httpJson(BLOB), /does not resolve to public addresses only/);
  assert.equal(flipped.exchanged.length, 1);
});

test("the response cap holds on redirect hops too", async () => {
  const harness = safeHarness("https://cdn.example/b", {}, 1024);
  await assert.rejects(harness.httpJson(BLOB), /exit status 63\.$/);
});

// ── Registry-token cache (v2 _TOKEN_CACHE semantics) ─────────────────────

/** An httpJson whose token endpoint follows *tokenPlan* call by call. */
function tokenScript(tokenPlan: Array<"fail" | "ok">): { httpJson: (url: string) => Promise<unknown>; tokenCalls: () => number } {
  let calls = 0;
  const httpJson = async (url: string): Promise<unknown> => {
    if (url.includes("/token")) {
      const step = tokenPlan[Math.min(calls, tokenPlan.length - 1)];
      calls += 1;
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      if (step === "fail") throw new Error("HTTP request failed: token endpoint down");
      return { token: "anon" };
    }
    return { mediaType: "application/vnd.oci.image.manifest.v1+json" };
  };
  return { httpJson, tokenCalls: () => calls };
}

test("a failed token fetch is evicted from the shared cache, so the next lookup retries and succeeds", async () => {
  const cache: RegistryTokenCache = new Map();
  const { httpJson, tokenCalls } = tokenScript(["fail", "ok"]);
  const first = await fetchDigestMetadata("ghcr.io/o/app", `sha256:${D1}`, httpJson, null, cache);
  assert.equal(first.error, "HTTP request failed: token endpoint down");
  assert.equal(tokenCalls(), 1);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(cache.size, 0, "the rejected in-flight fetch is not left cached");

  const second = await fetchDigestMetadata("ghcr.io/o/app", `sha256:${D2}`, httpJson, null, cache);
  assert.equal(tokenCalls(), 2, "the token endpoint is retried, not answered from a cached rejection");
  assert.equal(second.error, null);
  assert.equal(second.mediaType, "application/vnd.oci.image.manifest.v1+json");
});

test("concurrent lookups for one repository share exactly one in-flight token fetch", async () => {
  const cache: RegistryTokenCache = new Map();
  const { httpJson, tokenCalls } = tokenScript(["ok"]);
  const metas = await Promise.all(
    ["1", "2", "3", "4"].map((d) => fetchDigestMetadata("ghcr.io/o/app", `sha256:${d.repeat(64)}`, httpJson, null, cache)),
  );
  assert.ok(metas.every((meta) => meta.error === null));
  assert.equal(tokenCalls(), 1);
  assert.equal(cache.size, 1);
});
