/** Security tests for the SSRF-safe linked-source fetch (#706 PR 5b). No
 * real network: DNS is a fake resolver, transports are fakes or a local
 * loopback server reached only through the pinned lookup. */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { LookupAddress } from "node:dns";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { isPublicAddress, parseIPv6 } from "../src/platform/ip-policy.js";
import {
  createNodeExchange,
  fetchSource,
  hostAllowed,
  MAX_REDIRECTS,
  pinnedLookup,
  safeFetchLike,
  type Exchange,
  type ExchangeRequest,
  type Resolver,
} from "../src/platform/safe-fetch.js";
import { pyRequestTarget, pyUrlHostname, PyUrlValueError } from "../src/platform/py-url.js";

const PUBLIC = "104.16.1.1";

function fakeResolver(answers: Record<string, string[] | string[][]>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const counters = new Map<string, number>();
  const resolver = (async (host: string) => {
    calls.push(host);
    const entry = answers[host];
    if (!entry) throw new Error(`ENOTFOUND ${host}`);
    if (Array.isArray(entry[0])) {
      const index = counters.get(host) ?? 0;
      counters.set(host, index + 1);
      return (entry as string[][])[Math.min(index, entry.length - 1)]!;
    }
    return entry as string[];
  }) as Resolver & { calls: string[] };
  resolver.calls = calls;
  return resolver;
}

interface Hop {
  status?: number;
  location?: string;
  body?: string;
}

function fakeExchange(routes: Record<string, Hop>): Exchange & { seen: ExchangeRequest[] } {
  const seen: ExchangeRequest[] = [];
  const exchange: Exchange = async (request) => {
    seen.push(request);
    const hop = routes[request.url];
    if (!hop) throw new Error(`no route ${request.url}`);
    return { status: hop.status ?? 200, headers: { location: hop.location }, body: Buffer.from(hop.body ?? "") };
  };
  return Object.assign(exchange, { seen });
}

// ── Address policy ───────────────────────────────────────────────────────

test("every non-public address class is blocked, including the metadata IP and IPv4-mapped IPv6", () => {
  const blocked = [
    "127.0.0.1", "127.255.255.254", // loopback
    "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", // RFC1918
    "169.254.169.254", "169.254.0.1", // link-local incl. cloud metadata
    "100.64.0.1", "100.127.255.254", // CGNAT (v3 addition)
    "0.0.0.0", "0.1.2.3", // unspecified / this-network
    "224.0.0.1", "239.255.255.250", // multicast
    "240.0.0.1", "255.255.255.255", // reserved / broadcast
    "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", // special-purpose
    "::1", "::", // loopback / unspecified
    "fe80::1", "fe80::1%eth0", // link-local
    "fc00::1", "fd12:3456::1", // ULA
    "fec0::1", // site-local (v3 addition)
    "ff02::1", // multicast
    "2001:db8::1", "2002:a00:1::1", "64:ff9b::a00:1", "64:ff9b:1::1", "100::1", // documentation / 6to4 / NAT64 / discard
    "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.1", "::ffff:100.64.0.1", "::ffff:7f00:1", // IPv4-mapped
    "::127.0.0.1", // IPv4-compatible (reserved ::/8)
    "not-an-ip", "", "1.2.3", "01.2.3.4", // unparseable fails closed
  ];
  for (const address of blocked) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", PUBLIC, "192.0.0.9", "2606:4700::1111", "2a0a:4580:103f::1", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
  assert.equal(parseIPv6("::ffff:1.2.3.4"), parseIPv6("::ffff:102:304"));
});

// ── The pinned lookup hook ──────────────────────────────────────────────

function lookupOnce(hook: ReturnType<typeof pinnedLookup>, host: string, options: Parameters<ReturnType<typeof pinnedLookup>>[1]): Promise<{ err: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number | undefined }> {
  return new Promise((resolve) => hook(host, options, (err, address, family) => resolve({ err, address, family })));
}

test("the lookup hook answers only with the validated addresses, only for the expected host", async () => {
  const hook = pinnedLookup("artifacthub.io", [PUBLIC, "2606:4700::1111"]);
  assert.deepEqual(await lookupOnce(hook, "artifacthub.io", {}), { err: null, address: PUBLIC, family: 4 });
  assert.deepEqual((await lookupOnce(hook, "ArtifactHub.io", { all: true })).address, [
    { address: PUBLIC, family: 4 },
    { address: "2606:4700::1111", family: 6 },
  ]);
  assert.deepEqual(await lookupOnce(hook, "artifacthub.io", { family: 6 }), { err: null, address: "2606:4700::1111", family: 6 });
  assert.match((await lookupOnce(hook, "evil.example", {})).err?.message ?? "", /unexpected host/);
  // A pinned set that contains a non-public address never answers.
  const poisoned = pinnedLookup("artifacthub.io", [PUBLIC, "169.254.169.254"]);
  assert.match((await lookupOnce(poisoned, "artifacthub.io", { all: true })).err?.message ?? "", /no validated address/);
});

test("the node transport hands the socket the pinned lookup and keeps SNI and Host on the hostname", async () => {
  const original = https.request;
  let captured: https.RequestOptions | undefined;
  (https as { request: unknown }).request = (options: https.RequestOptions) => {
    captured = options;
    const fake = new http.ClientRequest("http://127.0.0.1:1", () => undefined);
    fake.on("error", () => undefined);
    process.nextTick(() => fake.destroy(new Error("stubbed")));
    return fake;
  };
  try {
    await assert.rejects(createNodeExchange()({
      url: "https://artifacthub.io/x", protocol: "https:", host: "artifacthub.io", port: null, path: "/x?y=1",
      addresses: [PUBLIC], headers: { "User-Agent": "ua" }, timeoutMs: 25_000, maxBytes: 10,
    }));
  } finally {
    (https as { request: unknown }).request = original;
  }
  assert.ok(captured);
  assert.equal(captured.hostname, "artifacthub.io");
  assert.equal(captured.servername, "artifacthub.io");
  assert.equal(captured.path, "/x?y=1");
  assert.equal(captured.port, 443);
  assert.equal(captured.agent, false);
  assert.equal(captured.timeout, 25_000);
  assert.equal(typeof captured.lookup, "function");
  assert.deepEqual(await lookupOnce(captured.lookup!, "artifacthub.io", {}), { err: null, address: PUBLIC, family: 4 });
});

// ── Rebinding: the connection uses exactly the validated resolution ─────

async function withServer(handler: http.RequestListener, run: (port: number, hits: http.IncomingHttpHeaders[]) => Promise<void>): Promise<void> {
  const hits: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.headers);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run((server.address() as AddressInfo).port, hits);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// The loopback test server stands in for a public host: this policy treats
// 127.0.0.1 as the only allowed address, so every other answer is "private".
const loopbackOnly = (address: string): boolean => address === "127.0.0.1";

test("DNS rebinding: one resolution per hop, and the socket connects to the validated address", async () => {
  await withServer((_req, res) => res.end("validated"), async (port, hits) => {
    const resolver = fakeResolver({ "rebind.test": [["127.0.0.1"], ["10.9.9.9"]] });
    const body = await fetchSource(`http://rebind.test:${port}/page`, {
      allowedHosts: new Set(["rebind.test"]), resolver, addressPolicy: loopbackOnly,
      exchange: createNodeExchange(loopbackOnly),
    });
    assert.equal(Buffer.from(body ?? []).toString(), "validated");
    assert.deepEqual(resolver.calls, ["rebind.test"], "resolved exactly once; the private second answer is never consulted");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.host, `rebind.test:${port}`, "Host header keeps the original hostname");
  });
});

test("DNS rebinding: a private first answer never connects", async () => {
  await withServer((_req, res) => res.end("must not be reached"), async (port, hits) => {
    const resolver = fakeResolver({ "rebind.test": [["10.9.9.9"], ["127.0.0.1"]] });
    const body = await fetchSource(`http://rebind.test:${port}/page`, {
      allowedHosts: new Set(["rebind.test"]), resolver, addressPolicy: loopbackOnly,
      exchange: createNodeExchange(loopbackOnly),
    });
    assert.equal(body, null);
    assert.equal(hits.length, 0);
  });
});

test("a redirect to a host resolving privately is refused before connecting", async () => {
  await withServer((req, res) => {
    res.statusCode = 302;
    res.setHeader("Location", `http://internal.test:${(req.socket.localPort ?? 0)}/admin`);
    res.end();
  }, async (port, hits) => {
    const resolver = fakeResolver({ "public.test": ["127.0.0.1"], "internal.test": ["169.254.169.254"] });
    const body = await fetchSource(`http://public.test:${port}/`, {
      allowedHosts: new Set(["public.test", "internal.test"]), resolver, addressPolicy: loopbackOnly,
      exchange: createNodeExchange(loopbackOnly),
    });
    assert.equal(body, null);
    assert.equal(hits.length, 1, "only the first hop reached a socket");
    assert.deepEqual(resolver.calls, ["public.test", "internal.test"]);
  });
});

// ── Policy (fake transport) ────────────────────────────────────────────

const ALLOWED = new Set(["artifacthub.io", "registry.terraform.io", "127.0.0.1", "169.254.169.254", "::ffff:127.0.0.1", "mapped.test"]);

test("allowlisted names resolving to any blocked class are never fetched", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:169.254.169.254", "::ffff:127.0.0.1"]) {
    const exchange = fakeExchange({});
    const resolver = fakeResolver({ "artifacthub.io": [PUBLIC, address] });
    assert.equal(await fetchSource("https://artifacthub.io/x", { allowedHosts: ALLOWED, resolver, exchange }), null, address);
    assert.equal(exchange.seen.length, 0, address);
  }
});

test("allowlisted IP literals are validated without DNS and never fetched when private", async () => {
  for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::ffff:127.0.0.1]/"]) {
    const exchange = fakeExchange({});
    const resolver = fakeResolver({});
    assert.equal(await fetchSource(url, { allowedHosts: ALLOWED, resolver, exchange }), null, url);
    assert.equal(exchange.seen.length, 0, url);
    assert.deepEqual(resolver.calls, [], url);
  }
});

test("each hop re-checks the host allowlist and public resolution", async () => {
  const resolver = fakeResolver({ "artifacthub.io": [PUBLIC], "registry.terraform.io": [PUBLIC], "evil.example": [PUBLIC], "mapped.test": ["::ffff:169.254.169.254"] });
  const exchange = fakeExchange({
    "https://artifacthub.io/to-evil": { status: 302, location: "https://evil.example/" },
    "https://artifacthub.io/to-mapped": { status: 301, location: "https://mapped.test/" },
    "https://artifacthub.io/to-literal": { status: 307, location: "http://169.254.169.254/latest" },
    "https://artifacthub.io/to-ok": { status: 308, location: "https://registry.terraform.io/y" },
    "https://registry.terraform.io/y": { body: "ok" },
    "https://artifacthub.io/to-file": { status: 302, location: "file:///etc/passwd" },
    "https://artifacthub.io/to-ftp": { status: 302, location: "ftp://artifacthub.io/x" },
  });
  const opts = { allowedHosts: ALLOWED, resolver, exchange };
  assert.equal(await fetchSource("https://artifacthub.io/to-evil", opts), null, "non-allowlisted redirect host");
  assert.equal(resolver.calls.includes("evil.example"), false, "a non-allowlisted hop is never resolved");
  assert.equal(await fetchSource("https://artifacthub.io/to-mapped", opts), null, "redirect to IPv4-mapped metadata IP");
  assert.equal(await fetchSource("https://artifacthub.io/to-literal", opts), null, "redirect to a private literal");
  assert.equal(await fetchSource("https://artifacthub.io/to-file", opts), null);
  assert.equal(await fetchSource("https://artifacthub.io/to-ftp", opts), null);
  assert.equal(Buffer.from((await fetchSource("https://artifacthub.io/to-ok", opts)) ?? []).toString(), "ok");
  assert.deepEqual(exchange.seen.map((r) => r.url).filter((u) => !u.startsWith("https://artifacthub.io/")), ["https://registry.terraform.io/y"]);
});

test("the hop cap follows exactly 10 redirects and the repeat cap stops loops", async () => {
  const routes: Record<string, Hop> = {};
  for (let i = 0; i < 12; i += 1) routes[`https://artifacthub.io/h${i}`] = { status: 302, location: `/h${i + 1}` };
  routes[`https://artifacthub.io/h${MAX_REDIRECTS}`] = { body: "end" };
  routes["https://artifacthub.io/g0"] = { status: 302, location: "/g1" };
  for (let i = 1; i <= 11; i += 1) routes[`https://artifacthub.io/g${i}`] = { status: 302, location: `/g${i + 1}` };
  routes["https://artifacthub.io/g11"] = { body: "unreachable" };
  routes["https://artifacthub.io/a"] = { status: 302, location: "/b" };
  routes["https://artifacthub.io/b"] = { status: 302, location: "/a" };
  const resolver = fakeResolver({ "artifacthub.io": [PUBLIC] });
  const exchange = fakeExchange(routes);
  const opts = { allowedHosts: ALLOWED, resolver, exchange };
  assert.equal(Buffer.from((await fetchSource("https://artifacthub.io/h0", opts)) ?? []).toString(), "end");
  assert.equal(await fetchSource("https://artifacthub.io/g0", opts), null, "11 redirects exceed the cap");
  const before = exchange.seen.length;
  assert.equal(await fetchSource("https://artifacthub.io/a", opts), null, "redirect loop");
  assert.equal(exchange.seen.length - before, 9, "urllib max_repeats: /a is revisited at most 4 times");
});

test("oversize bodies, non-2xx statuses and ambiguous URLs fail closed", async () => {
  const resolver = fakeResolver({ "artifacthub.io": [PUBLIC], "evil.example": [PUBLIC] });
  const exchange = fakeExchange({
    "https://artifacthub.io/big": { body: "x".repeat(101) },
    "https://artifacthub.io/404": { status: 404, body: "no" },
  });
  const opts = { allowedHosts: ALLOWED, resolver, exchange, maxBytes: 100 };
  assert.equal(await fetchSource("https://artifacthub.io/big", opts), null);
  assert.equal(await fetchSource("https://artifacthub.io/404", opts), null);
  for (const url of [
    "https://user:pw@artifacthub.io/x", // userinfo: urllib cannot connect
    "https://evil.example\\@artifacthub.io/x", // Python hostname vs connection host disagree
    "https://artifacthub.io\\@evil.example/x", // Python sees evil.example (not allowlisted)
    "https://artifacthub.io/café", // non-ASCII request target
    "https://artifacthub.io:99999/x",
    "gopher://artifacthub.io/x",
  ]) {
    const seen = exchange.seen.length;
    assert.equal(await fetchSource(url, opts), null, url);
    assert.equal(exchange.seen.length, seen, url);
  }
  assert.equal(await fetchSource("https://[oops/x", opts), null, "urlparse ValueError is a failed fetch");
  assert.throws(() => pyUrlHostname("https://[oops/x"), PyUrlValueError);
  assert.equal(pyRequestTarget("https://h/a#b#c")?.path, "/a#b", "urllib strips only the last fragment");
});

test("the host_allowed gate requires an exact allowlist match and public-only DNS", async () => {
  const resolver = fakeResolver({ "artifacthub.io": [PUBLIC], "mixed.test": [PUBLIC, "192.168.0.1"] });
  const allowed = new Set(["artifacthub.io", "mixed.test"]);
  assert.equal(await hostAllowed("https://ArtifactHub.io/x", allowed, resolver), true);
  assert.equal(await hostAllowed("https://sub.artifacthub.io/x", allowed, resolver), false);
  assert.equal(await hostAllowed("https://mixed.test/x", allowed, resolver), false);
  assert.equal(await hostAllowed("https://nodns.test/x", new Set(["nodns.test"]), resolver), false);
});

test("the enrich transport pins public resolution, refuses private hosts and never follows redirects", async () => {
  const resolver = fakeResolver({ "codeberg.org": [PUBLIC], "internal.forge": ["10.0.0.5"] });
  const exchange = fakeExchange({
    "https://codeberg.org/api/v1/x": { body: "{\"a\":1}" },
    "https://codeberg.org/api/v1/moved": { status: 302, location: "http://169.254.169.254/" },
  });
  const fetchLike = safeFetchLike({ resolver, exchange });
  const ok = await fetchLike("https://codeberg.org/api/v1/x", { headers: { Authorization: "token t" } });
  assert.deepEqual(await ok.json(), { a: 1 });
  assert.deepEqual(exchange.seen[0]!.addresses, [PUBLIC]);
  assert.equal(exchange.seen[0]!.headers.authorization, "token t");
  const moved = await fetchLike("https://codeberg.org/api/v1/moved");
  assert.equal(moved.status, 302, "a 3xx is returned as-is for requestText to refuse");
  assert.equal(exchange.seen.length, 2);
  await assert.rejects(fetchLike("https://internal.forge/api/v1/x"), /public addresses/);
  await assert.rejects(fetchLike("https://codeberg.org/api/v1/x", { method: "POST" }), /only GET/);
  assert.equal(exchange.seen.length, 2);
});

const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

/** A proxy that records every request or CONNECT it receives. */
async function withProxy(run: (proxyUrl: string, hits: string[]) => Promise<void>): Promise<void> {
  const hits: string[] = [];
  const proxy = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.end("via proxy");
  });
  proxy.on("connect", (req, socket) => {
    hits.push(`CONNECT ${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, hits);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}

test("proxy environment variables never divert the pinned transport", async () => {
  await withProxy(async (proxyUrl, proxyHits) => {
    await withServer((_req, res) => res.end("direct"), async (port, hits) => {
      const saved = Object.fromEntries(PROXY_VARS.map((name) => [name, process.env[name]]));
      for (const name of PROXY_VARS) process.env[name] = proxyUrl;
      try {
        const body = await fetchSource(`http://direct.test:${port}/pinned`, {
          allowedHosts: new Set(["direct.test"]), resolver: fakeResolver({ "direct.test": ["127.0.0.1"] }),
          addressPolicy: loopbackOnly, exchange: createNodeExchange(loopbackOnly),
        });
        assert.equal(Buffer.from(body ?? []).toString(), "direct");
      } finally {
        for (const name of PROXY_VARS) {
          if (saved[name] === undefined) delete process.env[name];
          else process.env[name] = saved[name];
        }
      }
      assert.equal(hits.length, 1);
      assert.deepEqual(proxyHits, []);

      // Node's opt-in env-proxy support (NODE_USE_ENV_PROXY) is read at
      // startup, so check it in a fresh process: the pinned transport
      // (agent: false + pinned lookup) still connects directly.
      const module = join(__dirname, "..", "src", "platform", "safe-fetch.js");
      const script = `
        const { fetchSource, createNodeExchange } = require(${JSON.stringify(module)});
        const only = (a) => a === "127.0.0.1";
        fetchSource("http://direct.test:${port}/pinned-child", {
          allowedHosts: new Set(["direct.test"]), resolver: async () => ["127.0.0.1"],
          addressPolicy: only, exchange: createNodeExchange(only),
        }).then((body) => process.stdout.write(Buffer.from(body ?? []).toString()));`;
      const env: Record<string, string> = { PATH: process.env.PATH ?? "", NODE_USE_ENV_PROXY: "1" };
      for (const name of PROXY_VARS) env[name] = proxyUrl;
      const child = await new Promise<{ stdout: string; status: number | null }>((resolve) => {
        const c = spawn(process.execPath, ["-e", script], { env });
        let stdout = "";
        c.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        c.on("close", (status) => resolve({ stdout, status }));
      });
      assert.equal(child.status, 0);
      assert.equal(child.stdout, "direct");
      assert.equal(hits.length, 2, "the child connected straight to the target");
      assert.deepEqual(proxyHits, [], "no request or CONNECT ever reached the proxy");
    });
  });
});
