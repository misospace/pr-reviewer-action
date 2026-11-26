/** #1821: the fail-closed states of the exact published-package comparison.
 * Every unresolved read (registry miss, identity mismatch, missing or
 * mismatched integrity metadata, hostile archive) must render as
 * **unresolved** with its closed reason and a `Delta: **unresolved**` line —
 * never a clean, empty, or itemized delta. No network: the seams are fakes
 * and the tarballs are hand-built (including hostile members). */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  buildNpmPackageProvenance,
  type NpmFetchBytes,
  type NpmFetchJson,
} from "../src/context/index.js";

const OLD = "26.6.7";
const NEW = "26.6.10";
const CHANGES = [{ slug: "types/node", oldVersion: OLD, newVersion: NEW }];

// ── A ustar builder that can emit arbitrary (and hostile) members ─────────

interface TarMember {
  name: string;
  body?: string;
  /** Tar typeflag byte at offset 156; defaults to "0" (regular file). */
  typeflag?: string;
  linkname?: string;
  /** Write a checksum that is off by one (a malformed archive). */
  badChecksum?: boolean;
}

function tarMember(member: TarMember): Buffer {
  const body = Buffer.from(member.body ?? "", "utf8");
  const header = Buffer.alloc(512, 0);
  const octal = (value: number, length: number): string => value.toString(8).padStart(length - 1, "0") + "\0";
  header.write(member.name, 0, Math.min(100, member.name.length), "utf8");
  header.write(octal(0o644, 8), 100, 8);
  header.write(octal(0, 8), 108, 8);
  header.write(octal(0, 8), 116, 8);
  header.write(octal(body.length, 12), 124, 12);
  header.write(octal(1_700_000_000, 12), 136, 12);
  header.fill(0x20, 148, 156);
  header.write(member.typeflag ?? "0", 156, 1);
  if (member.linkname !== undefined) header.write(member.linkname, 157, Math.min(100, member.linkname.length), "utf8");
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(octal(member.badChecksum ? sum + 1 : sum, 8), 148, 8);
  const data = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(data);
  return Buffer.concat([header, data]);
}

/** @param truncateTo cut the raw tar (before gzip) to this many bytes,
 * producing a truncated archive that still gunzips cleanly. */
function tarGz(members: TarMember[], truncateTo?: number): Uint8Array {
  const tar = Buffer.concat([...members.map(tarMember), Buffer.alloc(1024, 0)]);
  const cut = truncateTo === undefined ? tar : tar.subarray(0, truncateTo);
  return new Uint8Array(gzipSync(cut));
}

// ── Seam fixtures ──────────────────────────────────────────────────────────

const TARBALL_URL = (version: string): string => `https://registry.npmjs.org/@types/node/-/node-${version}.tgz`;

function manifestMember(version: string): TarMember {
  return { name: "package/package.json", body: JSON.stringify({ name: "@types/node", version }) };
}

function integrityOf(tarball: Uint8Array): string {
  return `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
}

type DocFixture = unknown | Error;

interface SeamSpec {
  docs: Record<string, DocFixture>;
  tarballs: Record<string, Uint8Array | null>;
}

async function renderWith(seams: SeamSpec): Promise<string> {
  const fetchJson: NpmFetchJson = async (url) => {
    const version = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
    const doc = seams.docs[version];
    if (doc === undefined) throw new Error(`no fixture for version document ${version}`);
    if (doc instanceof Error) throw doc;
    return doc;
  };
  const fetchBytes: NpmFetchBytes = async (url) => {
    const version = /node-(.+)\.tgz$/.exec(new URL(url).pathname)?.[1] ?? "";
    return seams.tarballs[version] ?? null;
  };
  const { markdown } = await buildNpmPackageProvenance(CHANGES, { fetchJson, fetchBytes });
  return markdown;
}

/** No unresolved rendering may ever claim the comparison ran or a delta. */
function assertNeverClaimsADelta(markdown: string): void {
  assert.ok(markdown.includes("Delta: **unresolved**"), "a failed read discloses an unresolved delta");
  assert.ok(!markdown.includes("Comparison method"), "the exact-content comparison is never claimed");
  assert.ok(!markdown.includes("No file-level difference"), "a failed read is never an empty delta");
  assert.ok(!markdown.includes("Added files"), "no delta rows are itemized");
  assert.ok(!markdown.includes("Changed files"), "no delta rows are itemized");
}

test("a missing registry version document renders unresolved, never a clean delta", async () => {
  const markdown = await renderWith({
    docs: { [OLD]: new Error("HTTP 404"), [NEW]: new Error("HTTP 404") },
    tarballs: {},
  });
  assert.ok(markdown.includes(`- Version \`${OLD}\`: **unresolved**`));
  assert.ok(markdown.includes(`- Version \`${NEW}\`: **unresolved**`));
  assert.match(markdown, /could not be fetched/);
  assertNeverClaimsADelta(markdown);
});

test("a version document naming a different package fails closed", async () => {
  const markdown = await renderWith({
    docs: {
      [OLD]: { name: "@evil/node", version: OLD, dist: { tarball: TARBALL_URL(OLD), integrity: "sha512-AAAA" } },
      [NEW]: { name: "@evil/node", version: NEW, dist: { tarball: TARBALL_URL(NEW), integrity: "sha512-AAAA" } },
    },
    tarballs: {},
  });
  assert.match(markdown, /names a different package/);
  assertNeverClaimsADelta(markdown);
});

test("a version document whose version differs from the request fails closed", async () => {
  const markdown = await renderWith({
    docs: {
      [OLD]: { name: "@types/node", version: "26.6.9", dist: { tarball: TARBALL_URL(OLD), integrity: "sha512-AAAA" } },
      [NEW]: { name: "@types/node", version: "26.6.9", dist: { tarball: TARBALL_URL(NEW), integrity: "sha512-AAAA" } },
    },
    tarballs: {},
  });
  assert.match(markdown, /does not match the requested exact version/);
  assertNeverClaimsADelta(markdown);
});

test("integrity metadata absent from the version document leaves the content UNVERIFIED", async () => {
  const tarballs = { [OLD]: tarGz([manifestMember(OLD)]), [NEW]: tarGz([manifestMember(NEW)]) };
  const markdown = await renderWith({
    docs: {
      [OLD]: { name: "@types/node", version: OLD, dist: { tarball: TARBALL_URL(OLD) } },
      [NEW]: { name: "@types/node", version: NEW, dist: { tarball: TARBALL_URL(NEW) } },
    },
    tarballs,
  });
  assert.match(markdown, /no usable integrity metadata — content UNVERIFIED/);
  assertNeverClaimsADelta(markdown);
});

test("a tarball that does not match the registry integrity metadata fails closed", async () => {
  const tarballs = { [OLD]: tarGz([manifestMember(OLD)]), [NEW]: tarGz([manifestMember(NEW)]) };
  const wrongIntegrity = integrityOf(Buffer.from("bytes the registry never published"));
  const markdown = await renderWith({
    docs: {
      [OLD]: { name: "@types/node", version: OLD, dist: { tarball: TARBALL_URL(OLD), integrity: wrongIntegrity } },
      [NEW]: { name: "@types/node", version: NEW, dist: { tarball: TARBALL_URL(NEW), integrity: wrongIntegrity } },
    },
    tarballs,
  });
  assert.match(markdown, /did not match the registry integrity metadata/);
  assertNeverClaimsADelta(markdown);
});

test("a published archive containing a symlink member is rejected outright", async () => {
  const oldTarball = tarGz([
    manifestMember(OLD),
    { name: "package/link.d.ts", typeflag: "2", linkname: "../../../etc/passwd" },
  ]);
  const newTarball = tarGz([manifestMember(NEW)]);
  const markdown = await renderWith({
    docs: {
      [OLD]: { name: "@types/node", version: OLD, dist: { tarball: TARBALL_URL(OLD), integrity: integrityOf(oldTarball) } },
      [NEW]: { name: "@types/node", version: NEW, dist: { tarball: TARBALL_URL(NEW), integrity: integrityOf(newTarball) } },
    },
    tarballs: { [OLD]: oldTarball, [NEW]: newTarball },
  });
  assert.ok(markdown.includes(`- Version \`${OLD}\`: **unresolved**`), "the old side is the rejected read");
  assert.match(markdown, /rejected entry \(traversal, link, device, or pax header\)/);
  assertNeverClaimsADelta(markdown);
});

test("a published archive with a traversal member name is rejected outright", async () => {
  const oldTarball = tarGz([
    { name: "package/../escape.ts", body: "// tar-slip\n" },
    manifestMember(OLD),
  ]);
  const newTarball = tarGz([manifestMember(NEW)]);
  const markdown = await renderWith({
    docs: {
      [OLD]: { name: "@types/node", version: OLD, dist: { tarball: TARBALL_URL(OLD), integrity: integrityOf(oldTarball) } },
      [NEW]: { name: "@types/node", version: NEW, dist: { tarball: TARBALL_URL(NEW), integrity: integrityOf(newTarball) } },
    },
    tarballs: { [OLD]: oldTarball, [NEW]: newTarball },
  });
  assert.match(markdown, /rejected entry \(traversal, link, device, or pax header\)/);
  assertNeverClaimsADelta(markdown);
});

test("a malformed header checksum and a truncated archive are both unresolved, never partial", async () => {
  const badChecksumTarball = tarGz([{ ...manifestMember(OLD), badChecksum: true }]);
  const markdownBad = await renderWith({
    docs: {
      [OLD]: { name: "@types/node", version: OLD, dist: { tarball: TARBALL_URL(OLD), integrity: integrityOf(badChecksumTarball) } },
      [NEW]: new Error("HTTP 404"),
    },
    tarballs: { [OLD]: badChecksumTarball },
  });
  assert.match(markdownBad, /malformed \(bad header or checksum\)/);
  assertNeverClaimsADelta(markdownBad);

  // Mid-file truncation: the header promises data the archive never carries.
  const truncatedTarball = tarGz([manifestMember(OLD), { name: "package/index.d.ts", body: "// cut off\n" }], 512 + 200);
  const markdownTrunc = await renderWith({
    docs: {
      [OLD]: { name: "@types/node", version: OLD, dist: { tarball: TARBALL_URL(OLD), integrity: integrityOf(truncatedTarball) } },
      [NEW]: new Error("HTTP 404"),
    },
    tarballs: { [OLD]: truncatedTarball },
  });
  assert.match(markdownTrunc, /was truncated/);
  assertNeverClaimsADelta(markdownTrunc);
});
