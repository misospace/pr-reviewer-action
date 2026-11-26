/** #1821: deterministic exact-published-package comparison for npm bumps.

 * The organic #1819 failure shape: an `@types/node` patch bump (26.6.7 →
 * 26.6.10) whose upstream is DefinitelyTyped has no per-version Git tag, so
 * the linked-source release/tag compare 404s and the recent-upstream-history
 * fallback proves nothing about the published bytes between the two exact
 * versions. This layer closes that gap WITHOUT a Git tag: it reads both
 * exact version documents from the authoritative npm registry, downloads each
 * published tarball, verifies the registry's own integrity metadata, unpacks
 * it under hard bounds (read-only — never `npm install`, never a lifecycle
 * script, never the package's own code), and compares the two published trees
 * to report the observed package-version delta.

 * Trust model (everything is fail-closed; nothing is inferred):
 * - A version document is authoritative ONLY for the exact package it names.
 *   The fetched document's `name` and `version` must match the requested slug
 *   and version byte-for-byte after the same normalization the dependency
 *   scope parse applies; a wrong slug, a wrong version, or a missing version
 *   leaves the cell UNRESOLVED, never a guessed identity.
 * - The tarball bytes are trusted ONLY after the registry document's integrity
 *   metadata verifies them (`dist.integrity` SRI, else `dist.shasum`). No
 *   integrity metadata, an unknown algorithm, or a mismatch leaves the delta
 *   UNRESOLVED as unverified content.
 * - The unpack is bounded on every axis (compressed bytes, decompressed bytes,
 *   entry count, per-entry bytes) and rejects traversal, absolute paths, and
 *   every non-regular entry (symlink, hardlink, device, fifo, pax/global
 *   headers) and any malformed/truncated archive outright. Termination is
 *   strict: the archive ends at TWO consecutive all-zero blocks (a single one
 *   is a truncated terminator, a member after one is corruption), and only
 *   zero padding may follow it (#1821 independent review).
 * - The published manifest is content-checked, not merely present: the
 *   integrity-verified `package/package.json` must parse and carry EXACTLY the
 *   `name`/`version` the authoritative registry document declared, so a
 *   registry response naming one version while its hashed tarball ships a
 *   different manifest resolves UNRESOLVED instead of diffing an identity
 *   nothing vouched for (#1821 independent review; AC3 "wrong package/version").
 * - A package-version delta is NOT a source-commit delta: this section never
 *   names a Git revision and never claims a clean semantic review from equal
 *   or differing published bytes.

 * All diff/registry-derived bytes are untrusted data: every rendered value is
 * collapsed to a single bounded line and emitted only as a list bullet or an
 * inert code span, so no external byte can forge a heading, a row, or a fence.
 *
 * The network never happens here: JSON and binary reads go through injected
 * seams (`FetchJson` / `FetchBytes`); the production SSRF/allowlist transport
 * lives in `npm-package-transport.ts`, and the pure comparison is unit-testable
 * provider-free. */

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

/** Reads one URL and returns decoded JSON, or throws (a fetch/parse failure
 * the caller records as unresolved). */
export type NpmFetchJson = (url: string) => Promise<unknown>;
/** Reads one URL and returns the raw bytes, or `null` when the read is refused
 * (host not allowlisted, SSRF, oversize, transport error). */
export type NpmFetchBytes = (url: string) => Promise<Uint8Array | null>;

/** The npm package-document host. The transport additionally requires this
 * host to be in the operator's `allowed-source-hosts`; the document-content
 * identity check below is the real authority, so a wrong host can never bind
 * an identity even if it answered. */
export const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";

/** Hard bounds on a published-package read + unpack. A scoped type package is
 * tens of kilobytes; these caps bound the worst case far above any real npm
 * package while capping a decompression bomb, a tar-slip tree, and a runaway
 * entry count. */
export const MAX_NPM_TARBALL_BYTES = 16 * 1024 * 1024;
export const MAX_NPM_EXTRACTED_BYTES = 32 * 1024 * 1024;
export const MAX_NPM_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_NPM_ENTRIES = 20000;
/** The published manifest is read as content (identity + declared
 * dependencies), bounded: a `package/package.json` beyond this cap is not
 * read at all — fail closed rather than parse a pathologically large untrusted
 * document. Real published manifests are far below it. */
export const MAX_NPM_MANIFEST_BYTES = 1024 * 1024;
/** The rendered section is byte-capped so a single huge delta cannot dominate
 * the corpus; over-cap is truncated on a row boundary with a disclosure line. */
export const MAX_NPM_SECTION_BYTES = 60 * 1024;
/** Most package comparisons per run — bounds wall time and corpus growth on a
 * pathological multi-bump PR; over-cap changes are never fetched, and the
 * phase passes them to `renderNpmPackageProvenance` as `skipped` so the
 * section discloses every comparison it did not make (#1821 review round 2). */
export const MAX_NPM_COMPARISONS = 12;
/** The number of delta rows itemized before the rest is summarized. */
export const MAX_NPM_DELTA_ROWS = 40;

/** The published manifest's bounded, structured content: the identity fields
 * verified against the registry document, plus the production dependency
 * declarations as published (name → declared range) — the decision-relevant
 * "changed declarations" a file-hash delta cannot show. */
export interface PackageManifest {
  name: string;
  version: string;
  dependencies: Record<string, string>;
}

/** A package's published contents reduced to a path → content-sha256 map. */
export interface PackageTree {
  /** Paths are relative to the package root (the `package/` member prefix is
   * stripped); always safe, traversal-free, slash-separated. */
  files: Map<string, string>;
  /** The parsed `package/package.json`, or `null` when the archive carries no
   * manifest at all (presence is the `package-manifest-missing` boundary; a
   * malformed or non-object manifest never reaches here — it throws). */
  manifest: PackageManifest | null;
}

/** Why a single published version could not be read and compared. A closed
 * vocabulary so a failed read is a distinguishable, honest state and never a
 * silently-empty delta. */
export type NpmUnresolvedReason =
  | "registry-fetch-failed"
  | "registry-url-refused"
  | "registry-document-invalid"
  | "registry-name-mismatch"
  | "registry-version-mismatch"
  | "registry-tarball-url-missing"
  | "tarball-fetch-failed"
  | "integrity-metadata-missing"
  | "integrity-algorithm-unsupported"
  | "integrity-mismatch"
  | "archive-malformed"
  | "archive-truncated"
  | "archive-entry-rejected"
  | "archive-too-large"
  | "archive-too-many-entries"
  | "package-manifest-missing"
  | "package-manifest-invalid"
  | "package-manifest-mismatch";

export interface NpmPackageFailure {
  version: string;
  reason: NpmUnresolvedReason;
}

export interface NpmPackageDelta {
  added: string[];
  removed: string[];
  changed: string[];
}

/** Published production-dependency declarations compared old→new — the
 * "changed declarations" a file-hash delta cannot show (#1821 independent
 * review). Entries are registry-controlled untrusted strings; they render
 * only through `safeInline`. */
export interface NpmDependencyDelta {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface NpmPackageComparison {
  slug: string;
  oldVersion: string;
  newVersion: string;
  /** Set only when BOTH versions were read, verified, and unpacked cleanly. */
  delta: NpmPackageDelta | null;
  /** Published `dependencies` declarations compared, same condition as `delta`. */
  dependencyDelta: NpmDependencyDelta | null;
  /** The `repository.url` each version's authoritative registry document
   * declared (the registry's own source metadata; null when absent or on a
   * failed read). */
  oldSourceRepository: string | null;
  newSourceRepository: string | null;
  /** Per-version failures (old first, then new); empty when both succeeded. */
  failures: NpmPackageFailure[];
}

/** A version document's identity fields, read after the registry answered. */
interface VersionDocument {
  name: string;
  version: string;
  integrity: string | null;
  shasum: string | null;
  tarball: string | null;
  /** The `repository.url` the registry document itself declares — the
   * registry-side source metadata the rendered section surfaces alongside the
   * delta (#1821 independent review: the section dropped it entirely). */
  repository: string | null;
}

/** An internal fail-closed signal carrying the closed unresolved reason. */
class UnresolvedError extends Error {
  constructor(readonly reason: NpmUnresolvedReason) {
    super(reason);
    this.name = "UnresolvedError";
  }
}

// ---------------------------------------------------------------------------
// Registry document identity
// ---------------------------------------------------------------------------

/** The dependency-scope normalization (leading `@` stripped, lowercased) —
 * re-implemented locally so this module stays free of a classification import
 * and the identity comparison is exactly the scope parser's spelling. */
function scopeNormalizedSlug(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

/** Build the registry's canonical single-segment encoded package name from a
 * dependency-scope slug (leading `@` already stripped). `types/node` →
 * `@types%2Fnode`; `lodash` → `lodash`. A slug this grammar cannot represent
 * cleanly (an empty half, an unexpected segment, an out-of-charset character)
 * yields `null` — never a decoded-guessed URL. */
export function registryEncodedName(slug: string): string | null {
  const clean = slug.trim().toLowerCase();
  if (clean === "" || clean.includes("@")) return null;
  if (!/^[a-z0-9._~-]+(?:\/[a-z0-9._~-]+)?$/.test(clean)) return null;
  if (!clean.includes("/")) return clean;
  const [scope, name] = clean.split("/");
  if (scope === undefined || name === undefined || scope === "" || name === "") return null;
  return `@${scope}%2F${name}`;
}

/** The exact-version document URL for a slug at a version. Returns `null` for
 * a slug the grammar refuses.
 *
 * Version case is part of this grammar by design (#1821 review round 3): the
 * dependency-scope parse lowercases every version token, so a manifest
 * spelling with uppercase (e.g. a prerelease `1.0.0-RC1`) arrives here already
 * lowercased and either misses the (case-sensitive) registry document or fails
 * the exact `doc.version !== version` re-check below. Such a bump resolves
 * UNRESOLVED and is never case-folded into a comparison — fail closed rather
 * than a guessed identity. */
export function registryVersionDocUrl(slug: string, version: string): string | null {
  const encoded = registryEncodedName(slug);
  if (encoded === null) return null;
  if (!/^\d+(?:\.\d+){2,}(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/.test(version)) return null;
  return `${NPM_REGISTRY_ORIGIN}/${encoded}/${encodeURIComponent(version)}`;
}

function readVersionDocument(raw: unknown): VersionDocument {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UnresolvedError("registry-document-invalid");
  }
  const doc = raw as Record<string, unknown>;
  const name = typeof doc.name === "string" ? doc.name : "";
  const version = typeof doc.version === "string" ? doc.version : "";
  const dist = (doc.dist !== null && typeof doc.dist === "object" && !Array.isArray(doc.dist))
    ? doc.dist as Record<string, unknown>
    : {};
  const repository = (doc.repository !== null && typeof doc.repository === "object" && !Array.isArray(doc.repository))
    ? ((doc.repository as Record<string, unknown>).url ?? null)
    : (typeof doc.repository === "string" ? doc.repository : null);
  return {
    name,
    version,
    integrity: typeof dist.integrity === "string" ? dist.integrity : null,
    shasum: typeof dist.shasum === "string" ? dist.shasum : null,
    tarball: typeof dist.tarball === "string" ? dist.tarball : null,
    repository: typeof repository === "string" ? repository : null,
  };
}

// ---------------------------------------------------------------------------
// Integrity verification
// ---------------------------------------------------------------------------

const SRI_ALGORITHMS: ReadonlySet<string> = new Set(["sha512", "sha384", "sha256"]);

/** Verify `bytes` against the registry document's integrity metadata. Returns
 * `null` on success, or the closed reason for the failure. The SRI field wins
 * when present (it is the stronger, self-describing pin); `dist.shasum` is the
 * only accepted fallback. Absent or unknown metadata never verifies. */
function verifyIntegrity(bytes: Uint8Array, integrity: string | null, shasum: string | null): NpmUnresolvedReason | null {
  if (integrity !== null && integrity !== "") {
    const at = integrity.indexOf("-");
    const algo = at === -1 ? "" : integrity.slice(0, at).toLowerCase();
    const expected = at === -1 ? "" : integrity.slice(at + 1);
    if (!SRI_ALGORITHMS.has(algo) || expected === "") return "integrity-algorithm-unsupported";
    let digest: string;
    try {
      digest = createHash(algo).update(bytes).digest("base64");
    } catch {
      return "integrity-algorithm-unsupported";
    }
    return digest === expected ? null : "integrity-mismatch";
  }
  if (shasum !== null && /^[0-9a-f]{40}$/.test(shasum.trim().toLowerCase())) {
    const digest = createHash("sha1").update(bytes).digest("hex");
    return digest === shasum.trim().toLowerCase() ? null : "integrity-mismatch";
  }
  return "integrity-metadata-missing";
}

// ---------------------------------------------------------------------------
// Bounded tar.gz unpack (read-only; rejects links, traversal, malformed)
// ---------------------------------------------------------------------------

/** Reject any tar member name that is not a clean, traversal-free relative
 * path. Absolute paths, any `..` segment, backslash separators, drive letters,
 * a leading `~`, embedded NUL, or control characters are refused. */
function safeMemberPath(name: string): string | null {
  if (name === "" || name.includes("\0") || /[\u0000-\u001f\u007f]/.test(name)) return null;
  if (name.startsWith("/") || name.startsWith("\\") || name.startsWith("~")) return null;
  if (/^[a-zA-Z]:/.test(name)) return null;
  if (name.includes("\\")) return null;
  const segments = name.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
  }
  return segments.join("/");
}

/** Parse a tar octal size/mode field. Accepts the classic ASCII-octal spelling
 * (trailing NUL/space). Rejects GNU base-256 (high bit set) — fail closed. */
function parseOctal(field: Uint8Array): number | null {
  if (field.length > 0 && (field[0]! & 0x80) !== 0) return null;
  let text = "";
  for (const byte of field) {
    if (byte === 0 || byte === 0x20) break;
    text += String.fromCharCode(byte);
  }
  if (text === "") return null;
  if (!/^[0-7]+$/.test(text)) return null;
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) ? value : null;
}

function headerChecksumOk(block: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i += 1) {
    // The checksum field (148..155) is treated as spaces while summing.
    sum += (i >= 148 && i < 156) ? 0x20 : block[i]!;
  }
  const stored = parseOctal(block.subarray(148, 156));
  return stored !== null && stored === sum;
}

const REGULAR = new Set(["0", "\0"]);

/** Unpack a gzipped npm tarball into a path → content-sha256 map, enforcing
 * every bound and rejecting traversal, links, and malformed archives. Throws
 * `UnresolvedError` with the closed reason on any refusal. */
export function extractPackageTree(tarball: Uint8Array): PackageTree {
  if (tarball.length > MAX_NPM_TARBALL_BYTES) throw new UnresolvedError("archive-too-large");
  let tar: Buffer;
  try {
    tar = gunzipSync(tarball, { maxOutputLength: MAX_NPM_EXTRACTED_BYTES });
  } catch (error) {
    // `maxOutputLength` overflow surfaces as RangeError ERR_BUFFER_TOO_LARGE
    // (the buffer the inflate is about to exceed); any other zlib failure (bad
    // magic, truncated stream) is a malformed archive. Both fail closed.
    const code = (error as { code?: unknown }).code;
    if (error instanceof RangeError || code === "ERR_BUFFER_TOO_LARGE") {
      throw new UnresolvedError("archive-too-large");
    }
    throw new UnresolvedError("archive-malformed");
  }
  const files = new Map<string, string>();
  const seen = new Set<string>();
  let manifestBytes: Buffer | null = null;
  let offset = 0;
  let entries = 0;
  let extractedBytes = 0;
  let pendingLongName: string | null = null;

  const readString = (start: number, len: number): string => {
    let end = start;
    while (end < start + len && tar[end] !== 0) end += 1;
    return tar.toString("utf8", start, end);
  };

  for (;;) {
    if (offset + 512 > tar.length) {
      // A partial header block with no complete archive terminator is a
      // truncated archive. (An empty archive that ended cleanly is handled by
      // the two-zero-block terminator below before we get here only if bytes
      // remain.)
      if (tar.length === 0) break;
      throw new UnresolvedError("archive-truncated");
    }
    const block = tar.subarray(offset, offset + 512);
    // Strict POSIX terminator (#1821 independent review): the archive ends at
    // TWO consecutive all-zero blocks. A single all-zero block with fewer than
    // 512 bytes left is a truncated terminator; a member/header following one
    // is a corrupt stream (real tar writers never emit data after the
    // terminator). After the pair, only zero padding may follow.
    if (block.every((byte) => byte === 0)) {
      if (offset + 2 * 512 > tar.length) throw new UnresolvedError("archive-truncated");
      if (!tar.subarray(offset + 512, offset + 1024).every((byte) => byte === 0)) {
        throw new UnresolvedError("archive-malformed");
      }
      for (let tail = offset + 1024; tail < tar.length; tail += 1) {
        if (tar[tail] !== 0) throw new UnresolvedError("archive-malformed");
      }
      break;
    }
    if (!headerChecksumOk(block)) throw new UnresolvedError("archive-malformed");
    const typeflag = String.fromCharCode(tar[offset + 156]!);
    const fromLongName = pendingLongName !== null;
    let name = pendingLongName ?? readString(offset, 100);
    pendingLongName = null;
    // A ustar member stores its path across a 155-byte prefix and the 100-byte
    // name; join them when both are set. A name that came from a GNU long-name
    // ('L') extension is already complete and is never prefixed.
    if (!fromLongName && readString(offset + 257, 6).startsWith("ustar")) {
      const prefix = readString(offset + 345, 155);
      if (prefix !== "" && name !== "") name = `${prefix}/${name}`;
    }
    const size = parseOctal(block.subarray(124, 136));
    if (size === null) throw new UnresolvedError("archive-malformed");
    const dataStart = offset + 512;
    if (dataStart + size > tar.length) throw new UnresolvedError("archive-truncated");

    if (typeflag === "L") {
      // GNU long-name extension: the next entry's name is the data of this
      // block. Read it as a plain (trailing-NUL-trimmed) string.
      const raw = tar.toString("utf8", dataStart, dataStart + size).replace(/\0+$/, "");
      const safe = safeMemberPath(raw);
      if (safe === null) throw new UnresolvedError("archive-entry-rejected");
      pendingLongName = safe;
      offset = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }
    // Anything that is not a regular file or a directory is refused: symlinks,
    // hardlinks, character/block devices, fifos, and pax/global extended
    // headers (a pax `path=` can smuggle a traversal the name check would miss).
    if (!REGULAR.has(typeflag) && typeflag !== "5") {
      throw new UnresolvedError("archive-entry-rejected");
    }
    // Advance past this member's data before the (directory) short-circuit.
    offset = dataStart + Math.ceil(size / 512) * 512;
    // Directories carry no content and are never materialized, so their name is
    // irrelevant here — only regular files reach the traversal/identity checks.
    if (typeflag === "5") continue;
    const safePath = safeMemberPath(name);
    if (safePath === null) throw new UnresolvedError("archive-entry-rejected");

    entries += 1;
    if (entries > MAX_NPM_ENTRIES) throw new UnresolvedError("archive-too-many-entries");
    if (size > MAX_NPM_FILE_BYTES) throw new UnresolvedError("archive-too-large");
    extractedBytes += size;
    if (extractedBytes > MAX_NPM_EXTRACTED_BYTES) throw new UnresolvedError("archive-too-large");

    // Strip the npm `package/` root prefix so both trees key on the same
    // relative layout; the manifest check below anchors the package identity.
    const key = safePath.startsWith("package/") ? safePath.slice("package/".length) : safePath;
    if (key === "" || seen.has(key)) throw new UnresolvedError("archive-entry-rejected");
    seen.add(key);
    const content = tar.subarray(dataStart, dataStart + size);
    files.set(key, createHash("sha256").update(content).digest("hex"));
    if (key === "package.json") {
      // The manifest is read as CONTENT (identity + declared dependencies),
      // bounded (#1821 independent review: presence alone accepted a tarball
      // shipping a manifest that contradicts the version document).
      if (size > MAX_NPM_MANIFEST_BYTES) throw new UnresolvedError("package-manifest-invalid");
      manifestBytes = Buffer.from(content);
    }
  }
  return { files, manifest: parsePublishedManifest(manifestBytes) };
}

/** Parse the integrity-verified `package/package.json`. A missing manifest is
 * `null` (the `package-manifest-missing` boundary); anything present but not
 * a JSON object with string `name`/`version` is malformed content and fails
 * closed as `package-manifest-invalid`. `dependencies` keeps only string →
 * string entries from an object-valued field; anything else is nothing. */
function parsePublishedManifest(raw: Buffer | null): PackageManifest | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new UnresolvedError("package-manifest-invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UnresolvedError("package-manifest-invalid");
  }
  const doc = parsed as Record<string, unknown>;
  const name = typeof doc.name === "string" ? doc.name : "";
  const version = typeof doc.version === "string" ? doc.version : "";
  if (name === "" || version === "") throw new UnresolvedError("package-manifest-invalid");
  const dependencies: Record<string, string> = {};
  if (doc.dependencies !== null && typeof doc.dependencies === "object" && !Array.isArray(doc.dependencies)) {
    for (const [dep, range] of Object.entries(doc.dependencies as Record<string, unknown>)) {
      if (typeof range === "string") dependencies[dep] = range;
    }
  }
  return { name, version, dependencies };
}

/** Confirm an unpacked tree carries the published manifest AND that its
 * content speaks about exactly the identity the authoritative registry
 * version document declared (#1821 independent review: a registry response
 * naming the requested version must not ship a tarball whose manifest claims
 * a different package/version — the integrity pin binds the BYTES, and this
 * binds what those bytes say they are). The comparison's identity authority
 * is the version document, so the manifest must agree with it, and the
 * normalized-slug spelling matches the document check in `acquireVersion`. */
function verifyPackageManifest(tree: PackageTree, slug: string, version: string): NpmUnresolvedReason | null {
  if (tree.files.get("package.json") === undefined) return "package-manifest-missing";
  const manifest = tree.manifest;
  if (manifest === null) return "package-manifest-missing";
  if (scopeNormalizedSlug(manifest.name) !== slug) return "package-manifest-mismatch";
  if (manifest.version !== version) return "package-manifest-mismatch";
  return null;
}

// ---------------------------------------------------------------------------
// Per-version acquisition
// ---------------------------------------------------------------------------

interface AcquiredVersion {
  tree: PackageTree;
  /** The `repository.url` the authoritative document declared (bounded at
   * render; never trusted beyond being the document's own claim). */
  repository: string | null;
}

async function acquireVersion(
  slug: string,
  version: string,
  fetchJson: NpmFetchJson,
  fetchBytes: NpmFetchBytes,
  deadline: number | null,
): Promise<AcquiredVersion> {
  if (deadline !== null && Date.now() >= deadline) throw new UnresolvedError("registry-fetch-failed");
  const docUrl = registryVersionDocUrl(slug, version);
  if (docUrl === null) throw new UnresolvedError("registry-url-refused");

  let rawDoc: unknown;
  try {
    rawDoc = await fetchJson(docUrl);
  } catch {
    throw new UnresolvedError("registry-fetch-failed");
  }
  const doc = readVersionDocument(rawDoc);
  if (scopeNormalizedSlug(doc.name) !== slug) throw new UnresolvedError("registry-name-mismatch");
  if (doc.version !== version) throw new UnresolvedError("registry-version-mismatch");
  if (doc.tarball === null || doc.tarball === "") throw new UnresolvedError("registry-tarball-url-missing");

  if (deadline !== null && Date.now() >= deadline) throw new UnresolvedError("registry-fetch-failed");
  const tarball = await fetchBytes(doc.tarball);
  if (tarball === null) throw new UnresolvedError("tarball-fetch-failed");

  const integrityFailure = verifyIntegrity(tarball, doc.integrity, doc.shasum);
  if (integrityFailure !== null) throw new UnresolvedError(integrityFailure);

  const tree = extractPackageTree(tarball);
  const manifestFailure = verifyPackageManifest(tree, slug, version);
  if (manifestFailure !== null) throw new UnresolvedError(manifestFailure);
  // The published manifest is integrity-bound to the registry version document
  // (whose `name`/`version` we matched above) AND content-checked against it
  // (`verifyPackageManifest`), so that document is the identity authority and
  // the tree is the content this section diffs.
  return { tree, repository: doc.repository };
}

// ---------------------------------------------------------------------------
// Delta
// ---------------------------------------------------------------------------

function computeDelta(oldTree: PackageTree, newTree: PackageTree): NpmPackageDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const all = new Set<string>([...oldTree.files.keys(), ...newTree.files.keys()]);
  for (const path of all) {
    const before = oldTree.files.get(path);
    const after = newTree.files.get(path);
    if (before === undefined) added.push(path);
    else if (after === undefined) removed.push(path);
    else if (before !== after) changed.push(path);
  }
  added.sort();
  removed.sort();
  changed.sort();
  return { added, removed, changed };
}

/** Compare the two published manifests' production dependency declarations.
 * `added`/`removed` entries read `name@range`; `changed` reads
 * `name: old → new`. */
function computeDependencyDelta(
  oldManifest: PackageManifest,
  newManifest: PackageManifest,
): NpmDependencyDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const names = new Set<string>([...Object.keys(oldManifest.dependencies), ...Object.keys(newManifest.dependencies)]);
  for (const name of names) {
    const before = oldManifest.dependencies[name];
    const after = newManifest.dependencies[name];
    if (before === undefined) added.push(`${name}@${after}`);
    else if (after === undefined) removed.push(`${name}@${before}`);
    else if (before !== after) changed.push(`${name}: ${before} → ${after}`);
  }
  added.sort();
  removed.sort();
  changed.sort();
  return { added, removed, changed };
}

// ---------------------------------------------------------------------------
// Comparison driver
// ---------------------------------------------------------------------------

export interface CompareNpmPackagesOptions {
  fetchJson: NpmFetchJson;
  fetchBytes: NpmFetchBytes;
  /** A `Date.now()`-milliseconds deadline; past it, reads stop and the change
   * is reported unresolved. `null` disables the bound. */
  deadline?: number | null;
}

/** Compare one npm package's exact published old→new versions. Never throws: a
 * failure on either side is reported as a structured unresolved result. */
export async function compareNpmPackage(
  slug: string,
  oldVersion: string,
  newVersion: string,
  options: CompareNpmPackagesOptions,
): Promise<NpmPackageComparison> {
  const deadline = options.deadline ?? null;
  const failures: NpmPackageFailure[] = [];
  let oldAcquired: AcquiredVersion | null = null;
  let newAcquired: AcquiredVersion | null = null;
  try {
    oldAcquired = await acquireVersion(slug, oldVersion, options.fetchJson, options.fetchBytes, deadline);
  } catch (error) {
    failures.push({ version: oldVersion, reason: reasonOf(error) });
  }
  try {
    newAcquired = await acquireVersion(slug, newVersion, options.fetchJson, options.fetchBytes, deadline);
  } catch (error) {
    failures.push({ version: newVersion, reason: reasonOf(error) });
  }
  const dependencyDelta = oldAcquired !== null && newAcquired !== null
    // Both manifests passed `verifyPackageManifest`, so neither is null here.
    ? computeDependencyDelta(oldAcquired.tree.manifest!, newAcquired.tree.manifest!)
    : null;
  return {
    slug,
    oldVersion,
    newVersion,
    delta: oldAcquired !== null && newAcquired !== null ? computeDelta(oldAcquired.tree, newAcquired.tree) : null,
    dependencyDelta,
    oldSourceRepository: oldAcquired?.repository ?? null,
    newSourceRepository: newAcquired?.repository ?? null,
    failures,
  };
}

function reasonOf(error: unknown): NpmUnresolvedReason {
  if (error instanceof UnresolvedError) return error.reason;
  return "registry-fetch-failed";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** An untrusted one-line value: control chars and breaks collapse to spaces,
 * backticks are removed, the value is capped. */
function safeInline(value: string, cap = 200): string {
  const collapsed = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/`/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
  const points = Array.from(collapsed);
  return points.length > cap ? `${points.slice(0, cap - 1).join("")}…` : collapsed;
}

const REASON_TEXT: Record<NpmUnresolvedReason, string> = {
  "registry-fetch-failed": "the registry version document could not be fetched (network, host not allowlisted, or deadline)",
  "registry-url-refused": "the package slug or version spelling is outside the registry URL grammar — no URL was built (fail closed)",
  "registry-document-invalid": "the registry version document was not a JSON object",
  "registry-name-mismatch": "the registry document names a different package than this dependency (fail closed)",
  "registry-version-mismatch": "the registry document version does not match the requested exact version (fail closed)",
  "registry-tarball-url-missing": "the registry version document carried no published tarball URL",
  "tarball-fetch-failed": "the published tarball download was refused or failed",
  "integrity-metadata-missing": "the registry document carried no usable integrity metadata — content UNVERIFIED",
  "integrity-algorithm-unsupported": "the integrity algorithm is not one this layer verifies",
  "integrity-mismatch": "the published tarball did not match the registry integrity metadata (fail closed)",
  "archive-malformed": "the published archive was malformed (bad header or checksum)",
  "archive-truncated": "the published archive was truncated",
  "archive-entry-rejected": "the published archive contained a rejected entry (traversal, link, device, or pax header)",
  "archive-too-large": "the published archive exceeded a decompressed or per-file size bound",
  "archive-too-many-entries": "the published archive exceeded the entry-count bound",
  "package-manifest-missing": "the published archive contained no package/package.json manifest",
  "package-manifest-invalid": "the published package/package.json was not readable as a manifest (not a JSON object with string name and version, or over the manifest size bound)",
  "package-manifest-mismatch": "the manifest inside the published tarball names a different package/version than the registry document declares (fail closed)",
};

function renderDelta(delta: NpmPackageDelta): string[] {
  const lines: string[] = [];
  const total = delta.added.length + delta.removed.length + delta.changed.length;
  if (total === 0) {
    lines.push("  - **No file-level difference** between the two published trees (identical contents).");
    return lines;
  }
  const renderList = (label: string, items: string[]): void => {
    if (items.length === 0) return;
    const shown = items.slice(0, MAX_NPM_DELTA_ROWS);
    lines.push(`  - ${label} (${items.length}):`);
    for (const item of shown) lines.push(`    - \`${safeInline(item)}\``);
    if (items.length > shown.length) lines.push(`    - (+${items.length - shown.length} more)`);
  };
  renderList("Added files", delta.added);
  renderList("Removed files", delta.removed);
  renderList("Changed files", delta.changed);
  return lines;
}

/** The changed production dependency declarations between the two published
 * manifests — the "changed declarations" a file-hash delta cannot show. */
function renderDependencyDelta(delta: NpmDependencyDelta): string[] {
  const lines: string[] = [];
  const total = delta.added.length + delta.removed.length + delta.changed.length;
  lines.push(`- Published \`dependencies\` declarations: ${total === 0 ? "**unchanged** (identical production dependency set)" : `${total} declaration change(s)`}`);
  const renderList = (label: string, items: string[]): void => {
    if (items.length === 0) return;
    const shown = items.slice(0, MAX_NPM_DELTA_ROWS);
    lines.push(`  - ${label} (${items.length}):`);
    for (const item of shown) lines.push(`    - \`${safeInline(item)}\``);
    if (items.length > shown.length) lines.push(`    - (+${items.length - shown.length} more)`);
  };
  renderList("Added dependencies", delta.added);
  renderList("Removed dependencies", delta.removed);
  renderList("Changed dependency ranges", delta.changed);
  return lines;
}

/** The registry documents' own source metadata (#1821 independent review:
 * rendered deltas dropped it) — what each version document CLAIMS as its
 * repository, as a bounded claim, never a verified mapping. */
function renderSourceRepositories(comparison: NpmPackageComparison): string[] {
  const { oldSourceRepository, newSourceRepository } = comparison;
  if (oldSourceRepository === null && newSourceRepository === null) {
    return ["- Neither exact version document declares a source repository (`repository.url`)."];
  }
  if (oldSourceRepository !== null && oldSourceRepository === newSourceRepository) {
    return [`- Both exact version documents declare the same source repository: \`${safeInline(oldSourceRepository)}\` (the document's own claim, not a verified mapping).`];
  }
  const lines: string[] = [];
  if (oldSourceRepository !== null) {
    lines.push(`- \`${safeInline(comparison.oldVersion)}\` version document declares source repository: \`${safeInline(oldSourceRepository)}\` (the document's own claim, not a verified mapping).`);
  }
  if (newSourceRepository !== null) {
    lines.push(`- \`${safeInline(comparison.newVersion)}\` version document declares source repository: \`${safeInline(newSourceRepository)}\` (the document's own claim, not a verified mapping).`);
  }
  return lines;
}

function renderComparison(comparison: NpmPackageComparison): string[] {
  const slugLabel = safeInline(comparison.slug);
  const lines: string[] = [];
  lines.push(`## \`${slugLabel}\` ${safeInline(comparison.oldVersion)} → ${safeInline(comparison.newVersion)}`);
  const ordered = comparison.failures;
  if (ordered.length > 0) {
    for (const failure of ordered) {
      lines.push(`- Version \`${safeInline(failure.version)}\`: **unresolved** — ${REASON_TEXT[failure.reason]}`);
    }
    lines.push("- Delta: **unresolved** (a failed read is never reported as a clean or empty delta)");
    return lines;
  }
  lines.push("- Both exact version documents read from the authoritative npm registry; both published tarballs integrity-verified against the registry's own metadata, and each published manifest names exactly the package/version its document declared.");
  lines.push(...renderSourceRepositories(comparison));
  if (comparison.delta !== null) {
    lines.push("- Comparison method: **exact published package contents** (the Git version tag is not required and was not used).");
    lines.push(...renderDelta(comparison.delta));
    if (comparison.dependencyDelta !== null) lines.push(...renderDependencyDelta(comparison.dependencyDelta));
    lines.push("- File paths and declarations are the limit of what was compared: **no source content was semantically reviewed**. This is a **package-version delta**, not a source-commit delta — it names no Git revision and asserts no semantic verdict about the upstream API.");
  }
  return lines;
}

/** The bounded corpus section. Returns "" when there is nothing to compare.
 * `skipped` names the comparable bumps the caller capped away: they are
 * disclosed unfetched, never dropped (#1821 review round 2). */
export function renderNpmPackageProvenance(
  comparisons: readonly NpmPackageComparison[],
  skipped: readonly { slug: string; oldVersion: string; newVersion: string }[] = [],
): string {
  if (comparisons.length === 0 && skipped.length === 0) return "";
  const lines: string[] = [];
  lines.push("# Published npm Package Comparison");
  lines.push("");
  lines.push(
    "Deterministic exact-published-package comparison for the npm version bumps in this PR, read from the authoritative npm registry. This is advisory evidence: it compares the integrity-verified published tarball contents between the two exact versions so the delta is grounded WITHOUT a Git tag. It never runs `npm install` or any package code, never names a Git revision, and never asserts a semantic verdict. Any version reported **unresolved** stays fail-closed — do not infer safety (or danger) from it.",
  );
  lines.push("");
  for (const comparison of comparisons) {
    lines.push(...renderComparison(comparison));
    lines.push("");
  }
  if (skipped.length > 0) {
    lines.push("## Not compared (over the per-run comparison cap)");
    lines.push(`- This run compares at most ${MAX_NPM_COMPARISONS} package bumps; these ${skipped.length} comparable bump(s) were NOT fetched. Inspect them directly in the registry if they matter:`);
    for (const change of skipped) {
      lines.push(`  - \`${safeInline(change.slug)}\` ${safeInline(change.oldVersion)} → ${safeInline(change.newVersion)}`);
    }
    lines.push("");
  }
  return capSection(lines);
}

/** Join the section and, if it exceeds the byte cap, drop trailing rows on a
 * line boundary and disclose the truncation (never leave a half-row). */
function capSection(lines: readonly string[]): string {
  let out = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(out, "utf8") <= MAX_NPM_SECTION_BYTES) return out;
  const kept: string[] = [];
  let bytes = 0;
  const tail = `\n- (+section truncated at its ${MAX_NPM_SECTION_BYTES}-byte cap; consult the registry directly for the remainder)\n`;
  const limit = MAX_NPM_SECTION_BYTES - Buffer.byteLength(tail, "utf8");
  for (const line of lines) {
    const size = Buffer.byteLength(`${line}\n`, "utf8");
    if (bytes + size > limit) break;
    kept.push(line);
    bytes += size;
  }
  return `${kept.join("\n")}${tail}`;
}

export interface BuildNpmPackageProvenanceResult {
  markdown: string;
  comparisons: NpmPackageComparison[];
}

/** Compare every npm package change and render the section. The change list is
 * produced by the caller (the diff/scope parse); this driver only reads the
 * registry and renders. `skipped` carries the caller-capped remainder and is
 * disclosed unfetched. Empty markdown when there is nothing to compare or
 * disclose. */
export async function buildNpmPackageProvenance(
  changes: readonly { slug: string; oldVersion: string; newVersion: string }[],
  options: CompareNpmPackagesOptions,
  skipped: readonly { slug: string; oldVersion: string; newVersion: string }[] = [],
): Promise<BuildNpmPackageProvenanceResult> {
  const comparisons: NpmPackageComparison[] = [];
  for (const change of changes) {
    comparisons.push(await compareNpmPackage(change.slug, change.oldVersion, change.newVersion, options));
  }
  return { markdown: renderNpmPackageProvenance(comparisons, skipped), comparisons };
}

// ---------------------------------------------------------------------------
// Settlement-contract artifact (#1821 AC1)
// ---------------------------------------------------------------------------

/** Schema id of the run artifact carrying the COMPARISON FACT for the
 * evidence-receipt ledger. Minimal by design: one entry per comparison whose
 * BOTH exact published versions were read, identity- and integrity-verified,
 * unpacked, and manifest-checked — i.e. exactly `delta !== null` with zero
 * failures. Failed, mismatched, or partial comparisons contribute NOTHING:
 * the ledger-side reader credits only what this code actually verified, and
 * nothing here asserts a verdict (the semantic judgment stays the reviewer's
 * and the disposition layer's). */
export const NPM_COMPARISONS_ARTIFACT_SCHEMA = "npm-package-comparisons/v1";

export interface NpmVerifiedComparisonEntry {
  slug: string;
  oldVersion: string;
  newVersion: string;
}

/** The artifact JSON the phase writes; `""` means "nothing verified this
 * run" (also the clear-stale write on every early/failed path). */
export function npmComparisonsArtifactJson(comparisons: readonly NpmPackageComparison[]): string {
  const verified: NpmVerifiedComparisonEntry[] = [];
  for (const comparison of comparisons) {
    if (comparison.delta === null || comparison.failures.length !== 0) continue;
    verified.push({
      slug: comparison.slug,
      oldVersion: comparison.oldVersion,
      newVersion: comparison.newVersion,
    });
  }
  return `${JSON.stringify({ schema: NPM_COMPARISONS_ARTIFACT_SCHEMA, verified })}\n`;
}
