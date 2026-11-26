/** #1821: SSRF + allowlist gating for the npm published-package transport.
 * Pins the closed URL grammars for version documents and tarballs, the
 * operator `allowed-source-hosts` gate (the AC2 override still holds: a
 * restrictive list that omits the registry refuses every npm read), the
 * seam contract (fetchJson throws / fetchBytes returns null on any refusal),
 * and the fence behavior on redirect hops: public-https hops are followed,
 * private/loopback/metadata hops are refused before the next request, and a
 * non-https or credentialed hop is refused without even resolving it. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  createNpmFetches,
  npmPackageDeadline,
  npmTransportAllowsTarball,
  npmTransportAllowsVersionDoc,
} from "../src/context/index.js";
import type { ExchangeRequest, ExchangeResponse } from "../src/platform/safe-fetch.js";

const REGISTRY_HOSTS: ReadonlySet<string> = new Set(["registry.npmjs.org"]);
const DOC = "https://registry.npmjs.org/@types%2Fnode/26.6.7";
const TARBALL = "https://registry.npmjs.org/@types/node/-/node-26.6.7.tgz";
const DOC_BODY = Buffer.from('{"name":"@types/node","version":"26.6.7"}');
const TARBALL_BODY = Buffer.from("published-tarball-bytes");

// ── URL grammar + host allowlist (before any transport exists) ────────────

test("the canonical version-doc and tarball grammars are accepted for an allowlisted registry", () => {
  assert.equal(npmTransportAllowsVersionDoc(DOC, REGISTRY_HOSTS), true, "scoped @scope%2Fname doc");
  assert.equal(npmTransportAllowsVersionDoc("https://registry.npmjs.org/lodash/4.17.21", REGISTRY_HOSTS), true, "unscoped doc");
  assert.equal(npmTransportAllowsTarball(TARBALL, REGISTRY_HOSTS), true, "scoped tarball (unencoded @scope/name)");
  assert.equal(npmTransportAllowsTarball("https://registry.npmjs.org/ms/-/ms-2.1.3.tgz", REGISTRY_HOSTS), true, "unscoped tarball");
});

test("the host allowlist gates even the canonical forms (empty list = the override case)", () => {
  const empty: ReadonlySet<string> = new Set();
  const other: ReadonlySet<string> = new Set(["github.com"]);
  assert.equal(npmTransportAllowsVersionDoc(DOC, empty), false, "empty allowedHosts");
  assert.equal(npmTransportAllowsVersionDoc(DOC, other), false, "registry not allowlisted");
  assert.equal(npmTransportAllowsTarball(TARBALL, empty), false);
  assert.equal(npmTransportAllowsTarball(TARBALL, other), false);
});

test("non-canonical version documents are refused by the grammar", () => {
  const refused = [
    "http://registry.npmjs.org/@types%2Fnode/26.6.7",
    "https://registry.npmjs.org:8443/@types%2Fnode/26.6.7",
    "https://user@registry.npmjs.org/@types%2Fnode/26.6.7",
    "https://user:pw@registry.npmjs.org/@types%2Fnode/26.6.7",
    "https://registry.npmjs.org/@types%2Fnode/26.6.7?access=full",
    "https://registry.npmjs.org/@types%2Fnode/26.6.7#latest",
    "https://registry.npmjs.org/%40evil%2Fpkg/1.0.0",
    "https://registry.npmjs.org/@evil%2fnode/1.0.0",
    "https://registry.npmjs.org/@types/node/../../secret",
    "https://registry.npmjs.org/@types%2Fnode/latest",
    "https://registry.npmjs.org.evil.test/@types%2Fnode/26.6.7",
    "https://evil.test/@types%2Fnode/26.6.7",
    "not a url",
  ];
  for (const url of refused) {
    assert.equal(npmTransportAllowsVersionDoc(url, REGISTRY_HOSTS), false, url);
  }
});

test("non-canonical tarball URLs are refused by the grammar", () => {
  const refused = [
    "",
    "http://registry.npmjs.org/@types/node/-/node-26.6.7.tgz",
    "https://registry.npmjs.org:444/@types/node/-/node-26.6.7.tgz",
    "https://user@registry.npmjs.org/@types/node/-/node-26.6.7.tgz",
    "https://cdn.example.com/@types/node/-/node-26.6.7.tgz",
    "https://registry.npmjs.org/@types/node/node-26.6.7.tgz",
    "https://registry.npmjs.org/@types/node/-/node-26.6.7.zip",
    "https://registry.npmjs.org/@types/node/-/node-26.6.7.tgz#sig=1",
    "https://registry.npmjs.org/@types/node/-/node-26.6.7.tgz?cache=1",
    "https://registry.npmjs.org//@types/node/-/node-26.6.7.tgz",
    "https://registry.npmjs.org/@types/node/-/../../evil.tgz",
    "https://registry.npmjs.org/@types/node/-/..\\evil.tgz",
  ];
  for (const url of refused) {
    assert.equal(npmTransportAllowsTarball(url, REGISTRY_HOSTS), false, url);
  }
});

// ── The SSRF-gated transport (fake DNS + exchange, like image-transport) ──

type Routes = (request: ExchangeRequest) => ExchangeResponse;

function npmHarness(
  routes: Routes,
  options: { allowedHosts?: ReadonlySet<string>; dns?: Record<string, string[]> } = {},
): { exchanged: ExchangeRequest[]; lookups: string[]; fetches: ReturnType<typeof createNpmFetches> } {
  const exchanged: ExchangeRequest[] = [];
  const lookups: string[] = [];
  const resolver = async (host: string): Promise<string[]> => {
    lookups.push(host);
    return options.dns?.[host] ?? ["93.184.216.34"];
  };
  const exchange = async (request: ExchangeRequest): Promise<ExchangeResponse> => {
    exchanged.push(request);
    return routes(request);
  };
  const fetches = createNpmFetches({
    allowedHosts: options.allowedHosts ?? REGISTRY_HOSTS,
    resolver,
    exchange,
  });
  return { exchanged, lookups, fetches };
}

test("a version document and a tarball are fetched when the registry is allowlisted and resolves public", async () => {
  const harness = npmHarness((request) => {
    if (request.host !== "registry.npmjs.org") throw new Error(`unexpected host ${request.host}`);
    if (request.path === "/@types%2Fnode/26.6.7") return { status: 200, headers: {}, body: DOC_BODY };
    if (request.path === "/@types/node/-/node-26.6.7.tgz") return { status: 200, headers: {}, body: TARBALL_BODY };
    throw new Error(`unexpected path ${request.path}`);
  });
  assert.deepEqual(await harness.fetches.fetchJson(DOC), { name: "@types/node", version: "26.6.7" });
  assert.deepEqual(await harness.fetches.fetchBytes(TARBALL), new Uint8Array(TARBALL_BODY));
  assert.deepEqual(harness.exchanged.map((r) => [r.host, r.addresses]), [
    ["registry.npmjs.org", ["93.184.216.34"]],
    ["registry.npmjs.org", ["93.184.216.34"]],
  ]);
});

test("a grammar refusal at either seam happens before any connection or lookup", async () => {
  const harness = npmHarness(() => {
    throw new Error("the network must never be reached for a refused read");
  });
  await assert.rejects(harness.fetches.fetchJson("http://registry.npmjs.org/@types%2Fnode/26.6.7"), /outside the registry document allowlist/);
  await assert.rejects(harness.fetches.fetchJson("https://registry.npmjs.org/@types%2Fnode/26.6.7?access=full"), /outside the registry document allowlist/);
  await assert.rejects(harness.fetches.fetchJson("https://evil.test/@types%2Fnode/26.6.7"), /outside the registry document allowlist/);
  assert.equal(await harness.fetches.fetchBytes("https://cdn.example.com/@types/node/-/node-26.6.7.tgz"), null);
  assert.equal(await harness.fetches.fetchBytes("https://registry.npmjs.org/@types/node/node-26.6.7.tgz"), null);
  assert.equal(harness.exchanged.length, 0);
  assert.deepEqual(harness.lookups, []);
});

test("AC2: an explicit restrictive allowlist that omits the registry refuses every npm read", async () => {
  const harness = npmHarness(
    () => {
      throw new Error("the network must never be reached when the registry is not allowlisted");
    },
    { allowedHosts: new Set(["github.com"]) },
  );
  await assert.rejects(harness.fetches.fetchJson(DOC), /outside the registry document allowlist/);
  assert.equal(await harness.fetches.fetchBytes(TARBALL), null);
  assert.equal(harness.exchanged.length, 0);
  assert.deepEqual(harness.lookups, [], "the refused host is not even resolved");
});

test("adversarial: an off-registry redirect is refused — the trust anchor never leaves the registry host", async () => {
  // The version document is the provenance anchor; a registry that 302s to any
  // other host (a CDN misconfig or worse) could serve a document naming this
  // package and pinning its own attacker tarball + integrity. So redirects must
  // stay on registry.npmjs.org; a cross-host hop fails closed, never fetched.
  const harness = npmHarness((request) => ({
    status: 302,
    headers: { location: request.path.endsWith(".tgz") ? "https://npm-cdn.example.org/pkg.tgz" : "https://npm-cdn.example.org/doc.json" },
    body: Buffer.alloc(0),
  }), { dns: { "npm-cdn.example.org": ["185.199.108.154"] } });
  await assert.rejects(harness.fetches.fetchJson(DOC), /version document read failed/);
  assert.equal(await harness.fetches.fetchBytes(TARBALL), null);
  // Only the two initial registry requests happen; the CDN hop is never made.
  assert.deepEqual(harness.exchanged.map((r) => r.host), ["registry.npmjs.org", "registry.npmjs.org"]);
});

test("a redirect that stays on the registry host is followed", async () => {
  const harness = npmHarness((request) => {
    if (request.host !== "registry.npmjs.org") throw new Error(`unexpected host ${request.host}`);
    if (request.path === "/@types%2Fnode/26.6.7") {
      return { status: 302, headers: { location: "https://registry.npmjs.org/@types%2Fnode/26.6.7?canonical=1" }, body: Buffer.alloc(0) };
    }
    if (request.path === "/@types/node/-/node-26.6.7.tgz") {
      return { status: 302, headers: { location: "https://registry.npmjs.org/@types/node/-/node-26.6.7-moved.tgz" }, body: Buffer.alloc(0) };
    }
    if (request.path === "/@types/node/-/node-26.6.7-moved.tgz") return { status: 200, headers: {}, body: TARBALL_BODY };
    return { status: 200, headers: {}, body: DOC_BODY };
  });
  assert.deepEqual(await harness.fetches.fetchJson(DOC), { name: "@types/node", version: "26.6.7" });
  assert.deepEqual(await harness.fetches.fetchBytes(TARBALL), new Uint8Array(TARBALL_BODY));
});

test("adversarial: redirects to loopback, RFC1918 and link-local/metadata hosts are refused before the next hop", async () => {
  const cases: Array<[string, Record<string, string[]>]> = [
    ["https://127.0.0.1/doc.json", {}],
    ["https://localhost.attacker.test/doc.json", { "localhost.attacker.test": ["127.0.0.1"] }],
    ["https://10.1.2.3/doc.json", {}],
    ["https://internal.corp.test/doc.json", { "internal.corp.test": ["93.184.216.34", "192.168.1.10"] }],
    ["https://169.254.169.254/latest/meta-data/iam/", {}],
    ["https://metadata.attacker.test/computeMetadata/v1/", { "metadata.attacker.test": ["169.254.169.254"] }],
    ["https://[::1]/doc.json", {}],
  ];
  for (const [location, dns] of cases) {
    const harness = npmHarness(() => ({ status: 302, headers: { location }, body: Buffer.alloc(0) }), { dns });
    await assert.rejects(harness.fetches.fetchJson(DOC), /version document read failed/, location);
    assert.equal(await harness.fetches.fetchBytes(TARBALL), null, location);
    assert.equal(harness.exchanged.length, 2, `${location}: one read each; the refused hop is never requested`);
  }
});

test("adversarial: a non-https or credentialed redirect hop is refused without even resolving it", async () => {
  for (const location of ["http://npm-cdn.example.org/doc.json", "ftp://files.example/doc", "file:///etc/passwd", "gopher://x.example/"]) {
    const harness = npmHarness(() => ({ status: 302, headers: { location }, body: Buffer.alloc(0) }));
    await assert.rejects(harness.fetches.fetchJson(DOC), /version document read failed/, location);
    assert.equal(await harness.fetches.fetchBytes(TARBALL), null, location);
    assert.equal(harness.exchanged.length, 2, location);
    assert.deepEqual(harness.lookups, ["registry.npmjs.org", "registry.npmjs.org"], `${location}: the refused hop is never even resolved`);
  }
  const creds = npmHarness(() => ({ status: 302, headers: { location: "https://user:pw@npm-cdn.example.org/doc.json" }, body: Buffer.alloc(0) }));
  await assert.rejects(creds.fetches.fetchJson(DOC), /version document read failed/);
  assert.equal(creds.exchanged.length, 1);
});

test("a failed or non-2xx read surfaces as the seam contract: fetchJson throws, fetchBytes returns null", async () => {
  const harness = npmHarness(() => ({ status: 404, headers: {}, body: Buffer.from("not found") }));
  await assert.rejects(harness.fetches.fetchJson(DOC), /version document read failed/);
  assert.equal(await harness.fetches.fetchBytes(TARBALL), null);
  assert.equal(harness.exchanged.length, 2);

  const broken = npmHarness(() => {
    throw new Error("connection reset");
  });
  await assert.rejects(broken.fetches.fetchJson(DOC), /version document read failed/);
  assert.equal(await broken.fetches.fetchBytes(TARBALL), null);
});

test("npmPackageDeadline parses like imageDigestDeadline (default 60, <=0 disables)", () => {
  assert.equal(npmPackageDeadline({}, 1000), 61_000);
  assert.equal(npmPackageDeadline({ NPM_PACKAGE_BUDGET_SEC: " 5 " }, 0), 5000);
  assert.equal(npmPackageDeadline({ NPM_PACKAGE_BUDGET_SEC: "" }, 0), 60_000);
  assert.equal(npmPackageDeadline({ NPM_PACKAGE_BUDGET_SEC: "junk" }, 0), 60_000);
  assert.equal(npmPackageDeadline({ NPM_PACKAGE_BUDGET_SEC: "0" }, 0), null);
  assert.equal(npmPackageDeadline({ NPM_PACKAGE_BUDGET_SEC: "-3" }, 0), null);
});
