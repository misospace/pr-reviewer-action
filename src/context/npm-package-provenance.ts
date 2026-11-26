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
 *   headers) and any malformed/truncated archive outright.
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
/** The rendered section is byte-capped so a single huge delta cannot dominate
 * the corpus; over-cap is truncated on a row boundary with a disclosure line. */
export const MAX_NPM_SECTION_BYTES = 60 * 1024;
/** Most package comparisons per run — bounds wall time and corpus growth on a
 * pathological multi-bump PR; over-cap changes are reported, not fetched. */
export const MAX_NPM_COMPARISONS = 12;
/** The number of delta rows itemized before the rest is summarized. */
export const MAX_NPM_DELTA_ROWS = 40;

/** A package's published contents reduced to a path → content-sha256 map. */
export interface PackageTree {
  /** Paths are relative to the package root (the `package/` member prefix is
   * stripped); always safe, traversal-free, slash-separated. */
  files: Map<string, string>;
}

/** Why a single published version could not be read and compared. A closed
 * vocabulary so a failed read is a distinguishable, honest state and never a
 * silently-empty delta. */
export type NpmUnresolvedReason =
  | "registry-fetch-failed"
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
  | "package-name-mismatch"
  | "package-version-mismatch";

export interface NpmPackageFailure {
  version: string;
  reason: NpmUnresolvedReason;
}

export interface NpmPackageDelta {
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
 * a slug the grammar refuses. */
export function registryVersionDocUrl(slug: string, version: string): string | null {
  const encoded = registryEncodedName(slug);
  if (encoded === null) return null;
  if (!/^\d+(?:\.\d+){2,}(?:[-+][0-9a-z.-]+)?$/.test(version)) return null;
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
  return {
    name,
    version,
    integrity: typeof dist.integrity === "string" ? dist.integrity : null,
    shasum: typeof dist.shasum === "string" ? dist.shasum : null,
    tarball: typeof dist.tarball === "string" ? dist.tarball : null,
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
    // Two consecutive all-zero blocks terminate the archive; an all-zero first
    // block of a pair is a clean end.
    if (block.every((byte) => byte === 0)) {
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
  }
  return { files };
}

/** Confirm an unpacked tree carries the published manifest. The package
 * identity (name + version) is bound by the registry version document, which
 * the integrity-verified tarball is pinned to, so the manifest's presence is
 * the remaining structural requirement here. */
function verifyPackageManifest(tree: PackageTree): NpmUnresolvedReason | null {
  if (tree.files.get("package.json") === undefined) return "package-manifest-missing";
  return null;
}

// ---------------------------------------------------------------------------
// Per-version acquisition
// ---------------------------------------------------------------------------

async function acquireVersion(
  slug: string,
  version: string,
  fetchJson: NpmFetchJson,
  fetchBytes: NpmFetchBytes,
  deadline: number | null,
): Promise<PackageTree> {
  if (deadline !== null && Date.now() >= deadline) throw new UnresolvedError("registry-fetch-failed");
  const docUrl = registryVersionDocUrl(slug, version);
  if (docUrl === null) throw new UnresolvedError("registry-document-invalid");

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
  const manifestFailure = verifyPackageManifest(tree);
  if (manifestFailure !== null) throw new UnresolvedError(manifestFailure);
  // The published manifest is integrity-bound to the registry version document
  // (whose `name`/`version` we matched above), so that document is the identity
  // authority; the tree is the content this section diffs.
  return tree;
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
  let oldTree: PackageTree | null = null;
  let newTree: PackageTree | null = null;
  try {
    oldTree = await acquireVersion(slug, oldVersion, options.fetchJson, options.fetchBytes, deadline);
  } catch (error) {
    failures.push({ version: oldVersion, reason: reasonOf(error) });
  }
  try {
    newTree = await acquireVersion(slug, newVersion, options.fetchJson, options.fetchBytes, deadline);
  } catch (error) {
    failures.push({ version: newVersion, reason: reasonOf(error) });
  }
  const delta = oldTree !== null && newTree !== null ? computeDelta(oldTree, newTree) : null;
  return { slug, oldVersion, newVersion, delta, failures };
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
  "package-name-mismatch": "the published manifest names a different package (fail closed)",
  "package-version-mismatch": "the published manifest version differs from the requested version (fail closed)",
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
  lines.push("- Both exact version documents read from the authoritative npm registry; both published tarballs integrity-verified against the registry's own metadata.");
  if (comparison.delta !== null) {
    lines.push("- Comparison method: **exact published package contents** (the Git version tag is not required and was not used).");
    lines.push(...renderDelta(comparison.delta));
    lines.push("- This is a **package-version delta**, not a source-commit delta — it names no Git revision and asserts no semantic verdict.");
  }
  return lines;
}

/** The bounded corpus section. Returns "" when there is nothing to compare. */
export function renderNpmPackageProvenance(comparisons: readonly NpmPackageComparison[]): string {
  if (comparisons.length === 0) return "";
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
 * registry and renders. Empty markdown when there are no changes. */
export async function buildNpmPackageProvenance(
  changes: readonly { slug: string; oldVersion: string; newVersion: string }[],
  options: CompareNpmPackagesOptions,
): Promise<BuildNpmPackageProvenanceResult> {
  const comparisons: NpmPackageComparison[] = [];
  for (const change of changes) {
    comparisons.push(await compareNpmPackage(change.slug, change.oldVersion, change.newVersion, options));
  }
  return { markdown: renderNpmPackageProvenance(comparisons), comparisons };
}
