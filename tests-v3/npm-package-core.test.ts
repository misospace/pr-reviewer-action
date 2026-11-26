import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  NPM_COMPARISONS_ARTIFACT_SCHEMA,
  NPM_REGISTRY_ORIGIN,
  buildNpmPackageProvenance,
  compareNpmPackage,
  extractPackageTree,
  npmComparisonsArtifactJson,
  registryEncodedName,
  registryVersionDocUrl,
  renderNpmPackageProvenance,
  type NpmFetchBytes,
  type NpmFetchJson,
  type NpmPackageComparison,
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

/** @param tail raw bytes appended after the members instead of the default
 * two-zero-block terminator — the adversarial terminator cases control the
 * archive's exact ending. */
function buildTarGz(members: Member[], tail?: Buffer): Uint8Array {
  const parts = members.map(header);
  parts.push(tail ?? Buffer.alloc(1024)); // two zero terminator blocks
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
  // Build metadata is legal semver and reaches the URL percent-encoded (#1821
  // review round 4); prerelease and build may co-occur.
  assert.equal(registryVersionDocUrl("lodash", "4.17.21+build"), `${NPM_REGISTRY_ORIGIN}/lodash/4.17.21%2Bbuild`);
  assert.equal(registryVersionDocUrl("types/node", "1.0.0-rc.1+meta"), `${NPM_REGISTRY_ORIGIN}/@types%2Fnode/1.0.0-rc.1%2Bmeta`);
  // A non-exact version never becomes a URL.
  assert.equal(registryVersionDocUrl("lodash", "latest"), null);
  assert.equal(registryVersionDocUrl("lodash", "1.0.0+Build"), null); // uppercase build metadata: fail closed
  assert.equal(registryVersionDocUrl("lodash", "1.0.0+"), null);
  assert.equal(registryVersionDocUrl("lodash", "1.0"), null);
});

test("a slug/version the URL grammar refuses reports its own honest reason, not a document error (#1821 review round 4)", async () => {
  const result = await compareNpmPackage("lodash", "latest", "2.0.0", {
    fetchJson: (async () => {
      throw new Error("fixture never answers");
    }) as NpmFetchJson,
    fetchBytes: (async () => null) as NpmFetchBytes,
  });
  assert.equal(result.delta, null);
  assert.deepEqual(result.failures, [
    { version: "latest", reason: "registry-url-refused" },
    { version: "2.0.0", reason: "registry-fetch-failed" },
  ]);
});

test("an uppercase version spelling is refused, never case-folded into a comparison (#1821 review round 3)", async () => {
  // The dependency-scope parse lowercases version tokens, so an
  // uppercase-prerelease manifest spelling (`1.0.0-RC1`) arrives lowercased.
  // The exact-version grammar refuses the raw uppercase spelling outright...
  assert.equal(registryVersionDocUrl("types/node", "1.0.0-RC1"), null);
  // ...and a lowercased token whose registry document spells the version with
  // uppercase fails the exact identity re-check instead of matching
  // case-insensitively — the bump resolves UNRESOLVED, never compared.
  const reasons = await failureReason("types/node", "1.0.0-rc1", "2.0.0", {
    "1.0.0-rc1": { name: "@types/node", version: "1.0.0-RC1", dist: { tarball: `${NPM_REGISTRY_ORIGIN}/x/-/x.tgz`, integrity: "sha512-AAAA" } },
    "2.0.0": { name: "@types/node", version: "2.0.0", dist: { tarball: `${NPM_REGISTRY_ORIGIN}/x/-/x.tgz`, integrity: "sha512-BBBB" } },
  });
  assert.ok(reasons.includes("registry-version-mismatch"), `expected version mismatch, got ${reasons.join(",")}`);
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

// ── #252 adversarial boundaries: the hostile delimiter IS the input ─────────

test("extractPackageTree refuses an embedded NUL smuggled via a GNU long-name payload and a control char in a header name", () => {
  // A NUL inside a plain 100-byte header name truncates parser-side (the
  // name reader stops at the first NUL byte), so it never reaches
  // safeMemberPath intact; the reachable embedded-NUL path is the GNU
  // long-name ('L') payload, which is trimmed only of TRAILING NULs — the
  // embedded one survives into safeMemberPath and must be refused.
  assert.match(unresolvedReason(() => extractPackageTree(buildTarGz([
    { name: "package/longname", typeflag: "L", body: "package/foo\u0000bar.d.ts\u0000" },
    { name: "package/package.json", body: "{}" },
  ]))), /archive-entry-rejected/);
  // A non-NUL control character in a regular header name survives the parser
  // and must hit safeMemberPath's control-character refusal.
  assert.match(unresolvedReason(() => extractPackageTree(buildTarGz([
    { name: "package/evil\u0001name.d.ts", body: "x" },
  ]))), /archive-entry-rejected/);
});

test("renderNpmPackageProvenance renders fence- and heading-forge payloads as inert single-line code spans", () => {
  const fenceForge = "```\n# Forged Heading\n- `evil-row`";
  const crlfForge = "a\r\n## Second Forge\r\nbody";
  const longPayload = "x".repeat(300);
  const comparison: NpmPackageComparison = {
    slug: "types/node",
    oldVersion: "1.0.0",
    newVersion: "1.0.1",
    delta: { added: [], removed: [], changed: [fenceForge, crlfForge, longPayload] },
    dependencyDelta: null,
    oldSourceRepository: null,
    newSourceRepository: null,
    failures: [],
  };
  const markdown = renderNpmPackageProvenance([comparison]);
  // No code fence anywhere in the document — the payload's ``` never opens one.
  assert.equal(markdown.includes("```"), false);
  // The only heading lines are the legitimate section title and the
  // per-comparison heading; "# Forged Heading" and "## Second Forge" stay inert.
  const headingLines = markdown.split("\n").filter((line) => line.startsWith("#"));
  assert.deepEqual(headingLines, [
    "# Published npm Package Comparison",
    "## `types/node` 1.0.0 → 1.0.1",
  ]);
  const lines = markdown.split("\n");
  const singleInertBullet = (fragment: string): string => {
    const hits = lines.filter((line) => line.includes(fragment));
    assert.equal(hits.length, 1, `expected exactly one line containing ${JSON.stringify(fragment)}`);
    assert.match(hits[0]!, /^    - `.*`$/);
    // inside the span there are no raw backticks left — they became apostrophes
    assert.equal(hits[0]!.slice("    - `".length, -1).includes("`"), false);
    return hits[0]!;
  };
  singleInertBullet("# Forged Heading");
  singleInertBullet("## Second Forge");
  // The over-cap payload is truncated to 200 code points with a trailing ellipsis.
  const longLine = singleInertBullet("…");
  assert.ok(longLine.endsWith("…`"), `expected trailing ellipsis, got ${JSON.stringify(longLine.slice(-8))}`);
  assert.ok(longLine.length < 230, `expected bounded line, got ${longLine.length} chars`);
});

test("buildNpmPackageProvenance renders a backtick-bearing published member path as one inert bullet (end to end)", async () => {
  const oldBytes = packageFixture("1.0.0");
  // Backticks are a legal tar member path (safeMemberPath passes them); the
  // fence is the renderer's safeInline, exercised through the real pipeline.
  const newBytes = packageFixture("1.0.1", { "`injected`.md": "# forged heading\n" });
  const fix = npmRegistryFixture("types/node", {
    "1.0.0": { bytes: oldBytes, integrity: sri("sha512", oldBytes) },
    "1.0.1": { bytes: newBytes, integrity: sri("sha512", newBytes) },
  });
  const { markdown } = await buildNpmPackageProvenance(
    [{ slug: "types/node", oldVersion: "1.0.0", newVersion: "1.0.1" }],
    { fetchJson: fix.fetchJson, fetchBytes: fix.fetchBytes },
  );
  const hits = markdown.split("\n").filter((line) => line.includes("injected"));
  assert.equal(hits.length, 1);
  assert.equal(hits[0], "    - `'injected'.md`");
  assert.equal(markdown.includes("```"), false);
  const headingLines = markdown.split("\n").filter((line) => line.startsWith("#"));
  assert.deepEqual(headingLines, [
    "# Published npm Package Comparison",
    "## `types/node` 1.0.0 → 1.0.1",
  ]);
});

// ── #1821 independent review: the STRICT archive terminator ─────────────────
// Accepting the FIRST all-zero block let a truncated terminator (or even a
// valid member after one) read as a verified tree. The archive ends only at
// TWO consecutive zero blocks, with zero padding permitted after it.

test("extractPackageTree requires the complete two-zero-block terminator (#1821 independent review)", () => {
  const members: Member[] = [
    { name: "package/package.json", body: '{"name":"@types/node","version":"1.0.0"}' },
    { name: "package/index.d.ts", body: "// v\n" },
  ];
  // A single zero block after valid members is a TRUNCATED terminator.
  assert.match(unresolvedReason(() => extractPackageTree(buildTarGz(members, Buffer.alloc(512)))), /archive-truncated/);
  // A member following one zero block is a corrupt stream, not a clean end.
  const memberAfterZero = Buffer.concat([
    Buffer.alloc(512),
    header({ name: "package/hidden.d.ts", body: "// after the 'terminator'\n" }),
    Buffer.alloc(1024),
  ]);
  assert.match(unresolvedReason(() => extractPackageTree(buildTarGz(members, memberAfterZero))), /archive-malformed/);
  // Non-zero bytes after the complete terminator are corrupt too.
  const junkTail = Buffer.concat([Buffer.alloc(1024), Buffer.from("junk after the archive", "utf8")]);
  assert.match(unresolvedReason(() => extractPackageTree(buildTarGz(members, junkTail))), /archive-malformed/);
  // Zero padding of any length after the terminator is the permissible tail.
  const tree = extractPackageTree(buildTarGz(members, Buffer.alloc(10240)));
  assert.deepEqual([...tree.files.keys()].sort(), ["index.d.ts", "package.json"]);
});

// ── #1821 independent review: the manifest is CONTENT-checked, not present ──

function rawTarball(manifestBody: string | null, files: Record<string, string> = {}): Uint8Array {
  const members: Member[] = [];
  if (manifestBody !== null) members.push({ name: "package/package.json", body: manifestBody });
  for (const [name, body] of Object.entries(files)) members.push({ name: `package/${name}`, body });
  return buildTarGz(members);
}

async function compareWithTarballs(
  oldBody: Uint8Array,
  newBody: Uint8Array,
  oldVersion = "1.0.0",
  newVersion = "1.0.1",
): Promise<string[]> {
  const fix = npmRegistryFixture("types/node", {
    [oldVersion]: { bytes: oldBody, integrity: sri("sha512", oldBody) },
    [newVersion]: { bytes: newBody, integrity: sri("sha512", newBody) },
  });
  const result = await compareNpmPackage("types/node", oldVersion, newVersion, {
    fetchJson: fix.fetchJson,
    fetchBytes: fix.fetchBytes,
  });
  return result.failures.map((failure) => failure.reason);
}

test("an integrity-matched tarball whose manifest contradicts the registry document fails closed (#1821 independent review)", async () => {
  // The SRI pin covers the served bytes exactly — integrity PASSES. What
  // refuses is the manifest content: it names version 20.0.0 while the
  // authoritative document declares 1.0.0.
  const wrongVersion = rawTarball('{"name":"@types/node","version":"20.0.0"}');
  const good = packageFixture("1.0.1");
  assert.deepEqual(await compareWithTarballs(wrongVersion, good), ["package-manifest-mismatch"]);
  // …and a manifest naming a different PACKAGE (same version) is the same
  // fail-closed refusal.
  const wrongName = rawTarball('{"name":"@evil/node","version":"1.0.0"}');
  assert.deepEqual(await compareWithTarballs(wrongName, good), ["package-manifest-mismatch"]);
  // Presence of package.json is no longer enough: unreadable manifest content
  // fails closed as invalid, and a tarball without one keeps its own reason.
  const unreadable = rawTarball("not json at all {{{");
  assert.deepEqual(await compareWithTarballs(unreadable, good), ["package-manifest-invalid"]);
  const nameless = rawTarball('{"version":"1.0.0"}');
  assert.deepEqual(await compareWithTarballs(nameless, good), ["package-manifest-invalid"]);
  const noManifest = rawTarball(null, { "index.d.ts": "// v\n" });
  assert.deepEqual(await compareWithTarballs(noManifest, good), ["package-manifest-missing"]);
});

test("a clean tree parses its manifest identity into the PackageTree", () => {
  const tree = extractPackageTree(rawTarball('{"name":"@types/node","version":"1.2.3","dependencies":{"chalk":"^5.3.0"},"devDependencies":{"junk":42}}'));
  assert.deepEqual(tree.manifest, { name: "@types/node", version: "1.2.3", dependencies: { chalk: "^5.3.0" } });
});

// ── #1821 independent review: actual changed DECLARATIONS, not only paths ───

function manifestBody(version: string, deps: Record<string, string>): string {
  return JSON.stringify({ name: "@types/node", version, dependencies: deps });
}

test("the comparison carries the published production-dependency delta old→new", async () => {
  const oldBytes = buildTarGz([
    { name: "package/package.json", body: manifestBody("1.0.0", { chalk: "^5.3.0", "left-pad": "^1.0.0" }) },
  ]);
  const newBytes = buildTarGz([
    { name: "package/package.json", body: manifestBody("1.0.1", { chalk: "^5.4.1", "new-dep": "^0.1.0" }) },
  ]);
  const fix = npmRegistryFixture("types/node", {
    "1.0.0": { bytes: oldBytes, integrity: sri("sha512", oldBytes) },
    "1.0.1": { bytes: newBytes, integrity: sri("sha512", newBytes) },
  });
  const result = await compareNpmPackage("types/node", "1.0.0", "1.0.1", { fetchJson: fix.fetchJson, fetchBytes: fix.fetchBytes });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.dependencyDelta, {
    added: ["new-dep@^0.1.0"],
    removed: ["left-pad@^1.0.0"],
    changed: ["chalk: ^5.3.0 → ^5.4.1"],
  });
  const { markdown } = await buildNpmPackageProvenance(
    [{ slug: "types/node", oldVersion: "1.0.0", newVersion: "1.0.1" }],
    { fetchJson: fix.fetchJson, fetchBytes: fix.fetchBytes },
  );
  assert.match(markdown, /Changed dependency ranges \(1\):/);
  assert.match(markdown, /`chalk: \^5\.3\.0 → \^5\.4\.1`/);
  assert.match(markdown, /`left-pad@\^1\.0\.0`/);
  assert.match(markdown, /`new-dep@\^0\.1\.0`/);
  // The material unknown stays disclosed: paths and declarations are the
  // limit — no source content was semantically reviewed.
  assert.match(markdown, /no source content was semantically reviewed/);
});

test("a fence-forge inside a registry-controlled dependency range renders inert (end to end, #252)", async () => {
  const hostile = "```\n# Forged Dep Heading\nattacker";
  const oldBytes = buildTarGz([{ name: "package/package.json", body: manifestBody("1.0.0", {}) }]);
  const newBytes = buildTarGz([{ name: "package/package.json", body: manifestBody("1.0.1", { [hostile]: "```\n## range forge" } as Record<string, string>) }]);
  const fix = npmRegistryFixture("types/node", {
    "1.0.0": { bytes: oldBytes, integrity: sri("sha512", oldBytes) },
    "1.0.1": { bytes: newBytes, integrity: sri("sha512", newBytes) },
  });
  const { markdown } = await buildNpmPackageProvenance(
    [{ slug: "types/node", oldVersion: "1.0.0", newVersion: "1.0.1" }],
    { fetchJson: fix.fetchJson, fetchBytes: fix.fetchBytes },
  );
  assert.equal(markdown.includes("```"), false);
  const headingLines = markdown.split("\n").filter((line) => line.startsWith("#"));
  assert.deepEqual(headingLines, [
    "# Published npm Package Comparison",
    "## `types/node` 1.0.0 → 1.0.1",
  ]);
});

// ── #1821 independent review: the registry documents' own source metadata ───

test("the section renders the declared source repository of the registry documents", async () => {
  const oldBytes = packageFixture("1.0.0");
  const newBytes = packageFixture("1.0.1");
  const repository = "git+https://github.com/DefinitelyTyped/DefinitelyTyped.git";
  const fix = npmRegistryFixture("types/node", {
    "1.0.0": { bytes: oldBytes, integrity: sri("sha512", oldBytes) },
    "1.0.1": { bytes: newBytes, integrity: sri("sha512", newBytes) },
  });
  const baseFetchJson = fix.fetchJson;
  const { markdown } = await buildNpmPackageProvenance(
    [{ slug: "types/node", oldVersion: "1.0.0", newVersion: "1.0.1" }],
    {
      fetchJson: async (url) => ({ ...(await baseFetchJson(url) as object), repository: { url: repository } }),
      fetchBytes: fix.fetchBytes,
    },
  );
  assert.match(markdown, /declare the same source repository/);
  assert.match(markdown, /`git\+https:\/\/github\.com\/DefinitelyTyped\/DefinitelyTyped\.git`/);
  // The claim is rendered AS a claim, never as a verified mapping.
  assert.match(markdown, /not a verified mapping/);
});

test("a version document without repository metadata discloses the absence", async () => {
  const oldBytes = packageFixture("1.0.0");
  const newBytes = packageFixture("1.0.1");
  const fix = npmRegistryFixture("types/node", {
    "1.0.0": { bytes: oldBytes, integrity: sri("sha512", oldBytes) },
    "1.0.1": { bytes: newBytes, integrity: sri("sha512", newBytes) },
  });
  const { markdown } = await buildNpmPackageProvenance(
    [{ slug: "types/node", oldVersion: "1.0.0", newVersion: "1.0.1" }],
    { fetchJson: fix.fetchJson, fetchBytes: fix.fetchBytes },
  );
  assert.match(markdown, /Neither exact version document declares a source repository/);
});

// ── #1821 AC1: the settlement artifact carries ONLY verified comparisons ─────

test("npmComparisonsArtifactJson lists exactly the fully verified comparisons", async () => {
  const goodOld = packageFixture("1.0.0");
  const goodNew = packageFixture("1.0.1");
  const good = npmRegistryFixture("types/node", {
    "1.0.0": { bytes: goodOld, integrity: sri("sha512", goodOld) },
    "1.0.1": { bytes: goodNew, integrity: sri("sha512", goodNew) },
  });
  const { comparisons } = await buildNpmPackageProvenance(
    [
      { slug: "types/node", oldVersion: "1.0.0", newVersion: "1.0.1" },
      { slug: "types/node", oldVersion: "1.0.0", newVersion: "9.9.9" }, // registry has no 9.9.9
    ],
    { fetchJson: good.fetchJson, fetchBytes: good.fetchBytes },
  );
  const artifact = JSON.parse(npmComparisonsArtifactJson(comparisons)) as { schema: string; verified: unknown[] };
  assert.equal(artifact.schema, NPM_COMPARISONS_ARTIFACT_SCHEMA);
  assert.deepEqual(artifact.verified, [{ slug: "types/node", oldVersion: "1.0.0", newVersion: "1.0.1" }]);
  // An all-failed run carries an empty list (never absent, never guessed).
  const failed = JSON.parse(npmComparisonsArtifactJson([{
    slug: "x", oldVersion: "1.0.0", newVersion: "2.0.0",
    delta: null, dependencyDelta: null, oldSourceRepository: null, newSourceRepository: null,
    failures: [{ version: "1.0.0", reason: "registry-fetch-failed" }],
  }])) as { verified: unknown[] };
  assert.deepEqual(failed.verified, []);
});
