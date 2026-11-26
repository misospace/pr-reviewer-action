import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  NPM_REGISTRY_ORIGIN,
  buildNpmPackageProvenance,
  compareNpmPackage,
  extractPackageTree,
  registryEncodedName,
  registryVersionDocUrl,
  type NpmFetchBytes,
  type NpmFetchJson,
} from "../src/context/index.js";

// ── a minimal, hand-built ustar tar.gz, with raw control for the adversarial
//    cases (the boundary token IS the input — #252 discipline) ──────────────

interface Member {
  name: string;
  body?: string;
  typeflag?: string; // "0" file, "5" dir, "2" symlink, "1" hardlink, "x" pax
  linkname?: string;
  badChecksum?: boolean;
  declaredSize?: number; // override the size field (for truncation tests)
}

function header(member: Member): Buffer {
  const block = Buffer.alloc(512);
  const body = Buffer.from(member.body ?? "", "utf8");
  block.write(member.name.slice(0, 100), 0, "utf8");
  block.write("0000644\0", 100, "utf8"); // mode
  block.write("0000000\0", 108, "utf8"); // uid
  block.write("0000000\0", 116, "utf8"); // gid
  const size = member.declaredSize ?? body.length;
  block.write(size.toString(8).padStart(11, "0") + "\0", 124, "utf8"); // size
  block.write("00000000000\0", 136, "utf8"); // mtime
  block.write("        ", 148, "utf8"); // checksum placeholder (8 spaces)
  block.write(member.typeflag ?? "0", 156, "utf8");
  block.write((member.linkname ?? "").slice(0, 100), 157, "utf8");
  block.write("ustar\0", 257, "utf8");
  block.write("00", 263, "utf8");
  if (member.badChecksum) {
    block.write("0000000\0", 148, "utf8");
  } else {
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += block[i]!;
    block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
  }
  const data = Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
  return Buffer.concat([block, data]);
}

function buildTarGz(members: Member[]): Uint8Array {
  const parts = members.map(header);
  parts.push(Buffer.alloc(1024)); // two zero terminator blocks
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

function sri(algo: "sha512" | "sha256", bytes: Uint8Array): string {
  return `${algo}-${createHash(algo).update(bytes).digest("base64")}`;
}
function shasum(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

// ── registry URL builders ───────────────────────────────────────────────────

test("registry URL builders encode scoped names canonically and refuse junk", () => {
  assert.equal(registryEncodedName("types/node"), "@types%2Fnode");
  assert.equal(registryEncodedName("lodash"), "lodash");
  assert.equal(registryEncodedName("types/node/sub"), null);
  assert.equal(registryEncodedName("@types/node"), null); // leading @ already stripped upstream
  assert.equal(registryEncodedName(""), null);
  assert.equal(registryVersionDocUrl("types/node", "26.6.10"), `${NPM_REGISTRY_ORIGIN}/@types%2Fnode/26.6.10`);
  assert.equal(registryVersionDocUrl("lodash", "4.17.21"), `${NPM_REGISTRY_ORIGIN}/lodash/4.17.21`);
  // A non-exact version never becomes a URL.
  assert.equal(registryVersionDocUrl("lodash", "latest"), null);
});

// ── extractPackageTree: the safe-unpack boundary ────────────────────────────

test("extractPackageTree reads a clean npm tree, strips the package/ root, keys by path", () => {
  const tree = extractPackageTree(buildTarGz([
    { name: "package/", typeflag: "5" },
    { name: "package/package.json", body: '{"name":"@types/node","version":"26.6.7"}' },
    { name: "package/index.d.ts", body: "declare const x: 1;" },
  ]));
  assert.deepEqual([...tree.files.keys()].sort(), ["index.d.ts", "package.json"]);
  // values are sha256 hex of content
  assert.equal(tree.files.get("package.json"), createHash("sha256").update('{"name":"@types/node","version":"26.6.7"}').digest("hex"));
});

function unresolvedReason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const reason = (error as { message?: string }).message ?? "";
    return reason;
  }
  throw new Error("expected extractPackageTree to throw");
}

test("extractPackageTree rejects traversal, absolute paths, links, devices, pax, and a missing manifest", () => {
  // traversal via a `..` segment
  assert.match(unresolvedReason(() => extractPackageTree(buildTarGz([
    { name: "package/../escape.js", body: "x" },
  ]))), /archive-entry-rejected/);
  // absolute path
  assert.match(unresolvedReason(() => extractPackageTree(buildTarGz([
    { name: "/etc/passwd", body: "x" },
  ]))), /archive-entry-rejected/);
  // symlink member
  assert.match(unresolvedReason(() => extractPackageTree(buildTarGz([
    { name: "package/link", typeflag: "2", linkname: "../../../../etc/passwd" },
  ]))), /archive-entry-rejected/);
  // hardlink member
  assert.match(unresolvedReason(() => extractPackageTree(buildTarGz([
    { name: "package/hard", typeflag: "1", linkname: "package/index.d.ts" },
  ]))), /archive-entry-rejected/);
  // character device
  assert.match(unresolvedReason(() => extractPackageTree(buildTarGz([
    { name: "package/dev", typeflag: "3" },
  ]))), /archive-entry-rejected/);
  // pax extended header
  assert.match(unresolvedReason(() => extractPackageTree(buildTarGz([
    { name: "PaxHeader/x", typeflag: "x", body: "30 path=package/../../bad\n" },
  ]))), /archive-entry-rejected/);
});

test("extractPackageTree rejects a malformed header checksum and a truncated archive", () => {
  assert.match(unresolvedReason(() => extractPackageTree(buildTarGz([
    { name: "package/package.json", body: "{}", badChecksum: true },
  ]))), /archive-malformed/);
  // declared size larger than the bytes present → truncation
  assert.match(unresolvedReason(() => extractPackageTree(buildTarGz([
    { name: "package/package.json", body: "{}", declaredSize: 100000 },
  ]))), /archive-truncated/);
});

test("extractPackageTree rejects non-gzip input as malformed", () => {
  assert.match(unresolvedReason(() => extractPackageTree(new Uint8Array([1, 2, 3, 4, 5]))), /archive-malformed/);
});

// ── compareNpmPackage: the happy path + identity/integrity binding ──────────

function packageFixture(version: string, extra: Record<string, string> = {}): Uint8Array {
  const members: Member[] = [
    { name: "package/", typeflag: "5" },
    { name: "package/package.json", body: `{"name":"@types/node","version":"${version}"}` },
    { name: "package/index.d.ts", body: `// node types ${version}\n` },
  ];
  for (const [name, body] of Object.entries(extra)) members.push({ name: `package/${name}`, body });
  return buildTarGz(members);
}

function npmRegistryFixture(
  slug: string,
  versions: Record<string, { bytes: Uint8Array; integrity?: string | null; shasum?: string | null }>,
): { fetchJson: NpmFetchJson; fetchBytes: NpmFetchBytes; requested: string[] } {
  const requested: string[] = [];
  const tarballs = new Map<string, Uint8Array>();
  const fetchJson: NpmFetchJson = async (url) => {
    requested.push(url);
    const parsed = new URL(url);
    const version = decodeURIComponent(parsed.pathname.split("/").pop()!);
    const entry = versions[version];
    if (entry === undefined) throw new Error(`404 ${url}`);
    const tarballUrl = `${NPM_REGISTRY_ORIGIN}/${parsed.pathname.slice(1).split("/")[0]}/-/${slug.split("/").pop()}-${version}.tgz`;
    tarballs.set(tarballUrl, entry.bytes);
    const dist: Record<string, unknown> = { tarball: tarballUrl };
    if (entry.integrity !== undefined && entry.integrity !== null) dist.integrity = entry.integrity;
    if (entry.shasum !== undefined && entry.shasum !== null) dist.shasum = entry.shasum;
    return { name: "@types/node", version, dist };
  };
  const fetchBytes: NpmFetchBytes = async (url) => {
    requested.push(url);
    return tarballs.get(url) ?? null;
  };
  return { fetchJson, fetchBytes, requested };
}

test("compareNpmPackage produces an exact published-file delta with no Git tag", async () => {
  const oldBytes = packageFixture("26.6.7");
  const newBytes = packageFixture("26.6.10", { "added.d.ts": "// new\n" });
  const fix = npmRegistryFixture("types/node", {
    "26.6.7": { bytes: oldBytes, integrity: sri("sha512", oldBytes) },
    "26.6.10": { bytes: newBytes, integrity: sri("sha512", newBytes) },
  });
  const result = await compareNpmPackage("types/node", "26.6.7", "26.6.10", {
    fetchJson: fix.fetchJson,
    fetchBytes: fix.fetchBytes,
  });
  assert.deepEqual(result.failures, []);
  assert.ok(result.delta !== null);
  assert.deepEqual(result.delta!.added, ["added.d.ts"]);
  // index.d.ts and package.json both differ (the published manifest carries the
  // version string); removed stays empty.
  assert.deepEqual(result.delta!.changed, ["index.d.ts", "package.json"]);
  assert.deepEqual(result.delta!.removed, []);
  // both version documents were requested under the registry origin
  assert.ok(fix.requested.includes(`${NPM_REGISTRY_ORIGIN}/@types%2Fnode/26.6.7`));
  assert.ok(fix.requested.includes(`${NPM_REGISTRY_ORIGIN}/@types%2Fnode/26.6.10`));
});

test("compareNpmPackage accepts a shasum-only registry document", async () => {
  const oldBytes = packageFixture("1.0.0");
  const newBytes = packageFixture("1.0.1");
  const fix = npmRegistryFixture("types/node", {
    "1.0.0": { bytes: oldBytes, shasum: shasum(oldBytes) },
    "1.0.1": { bytes: newBytes, shasum: shasum(newBytes) },
  });
  const result = await compareNpmPackage("types/node", "1.0.0", "1.0.1", { fetchJson: fix.fetchJson, fetchBytes: fix.fetchBytes });
  assert.deepEqual(result.failures, []);
  assert.equal(result.delta!.changed.includes("index.d.ts"), true);
});

async function failureReason(slug: string, a: string, b: string, versions: Record<string, unknown>): Promise<string[]> {
  const result = await compareNpmPackage(slug, a, b, {
    fetchJson: (async (url) => {
      const version = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
      const entry = versions[version];
      if (entry === undefined) throw new Error("404");
      return entry;
    }) as NpmFetchJson,
    fetchBytes: (async () => null) as NpmFetchBytes,
  });
  return result.failures.map((f) => f.reason);
}

test("compareNpmPackage fails closed on a wrong package or version name", async () => {
  const reasons = await failureReason("types/node", "26.6.7", "26.6.10", {
    "26.6.7": { name: "@evil/node", version: "26.6.7", dist: { tarball: `${NPM_REGISTRY_ORIGIN}/x/-/x.tgz`, integrity: "sha512-AAAA" } },
    "26.6.10": { name: "@types/node", version: "9.9.9", dist: { tarball: `${NPM_REGISTRY_ORIGIN}/x/-/x.tgz`, integrity: "sha512-AAAA" } },
  });
  assert.ok(reasons.includes("registry-name-mismatch"), `expected name mismatch, got ${reasons.join(",")}`);
  assert.ok(reasons.includes("registry-version-mismatch"), `expected version mismatch, got ${reasons.join(",")}`);
});

test("compareNpmPackage marks unverified content (no integrity metadata) unresolved", async () => {
  const oldBytes = packageFixture("1.0.0");
  const newBytes = packageFixture("1.0.1");
  const fix = npmRegistryFixture("types/node", {
    "1.0.0": { bytes: oldBytes }, // no integrity, no shasum
    "1.0.1": { bytes: newBytes },
  });
  const result = await compareNpmPackage("types/node", "1.0.0", "1.0.1", { fetchJson: fix.fetchJson, fetchBytes: fix.fetchBytes });
  assert.equal(result.delta, null);
  assert.deepEqual(result.failures.map((f) => f.reason).sort(), ["integrity-metadata-missing", "integrity-metadata-missing"]);
});

test("compareNpmPackage marks an integrity mismatch unresolved (fail closed)", async () => {
  const oldBytes = packageFixture("1.0.0");
  const newBytes = packageFixture("1.0.1");
  const fix = npmRegistryFixture("types/node", {
    "1.0.0": { bytes: oldBytes, integrity: sri("sha512", Buffer.from("not-the-package")) },
    "1.0.1": { bytes: newBytes, integrity: sri("sha512", newBytes) },
  });
  const result = await compareNpmPackage("types/node", "1.0.0", "1.0.1", { fetchJson: fix.fetchJson, fetchBytes: fix.fetchBytes });
  assert.equal(result.delta, null);
  assert.equal(result.failures[0]?.reason, "integrity-mismatch");
});

test("compareNpmPackage: a missing registry version stays unresolved", async () => {
  const result = await compareNpmPackage("types/node", "26.6.7", "26.6.99", {
    fetchJson: (async () => { throw new Error("404 not found"); }) as NpmFetchJson,
    fetchBytes: (async () => null) as NpmFetchBytes,
  });
  assert.equal(result.delta, null);
  assert.deepEqual(result.failures.map((f) => f.reason), ["registry-fetch-failed", "registry-fetch-failed"]);
});

// ── render: unresolved never reports a clean/empty delta ────────────────────

test("buildNpmPackageProvenance renders a clean delta and a disclosed unresolved row distinctly", async () => {
  const goodOld = packageFixture("26.6.7");
  const goodNew = packageFixture("26.6.10", { "added.d.ts": "// new\n" });
  const fix = npmRegistryFixture("types/node", {
    "26.6.7": { bytes: goodOld, integrity: sri("sha512", goodOld) },
    "26.6.10": { bytes: goodNew, integrity: sri("sha512", goodNew) },
  });
  const { markdown } = await buildNpmPackageProvenance(
    [{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" }],
    { fetchJson: fix.fetchJson, fetchBytes: fix.fetchBytes },
  );
  assert.match(markdown, /# Published npm Package Comparison/);
  assert.match(markdown, /## `types\/node` 26\.6\.7 → 26\.6\.10/);
  assert.match(markdown, /exact published package contents/);
  assert.match(markdown, /package-version delta/);
  assert.match(markdown, /Added files \(1\):/);
  assert.doesNotMatch(markdown, /: \*\*unresolved\*\*/);

  // Now an unresolved one: registry absent for both versions.
  const missing = await buildNpmPackageProvenance(
    [{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" }],
    { fetchJson: (async () => { throw new Error("down"); }) as NpmFetchJson, fetchBytes: (async () => null) as NpmFetchBytes },
  );
  assert.match(missing.markdown, /Delta: \*\*unresolved\*\*/);
  assert.match(missing.markdown, /never reported as a clean or empty delta/);
  assert.doesNotMatch(missing.markdown, /Comparison method:/);
});
