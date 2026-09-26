/** Byte-exact port of `pr_reviewer/diff_priority.py`: class-aware, size-fair
 * diff truncation. Same budget and marker as `truncateClean`, but the bytes
 * that survive are chosen by path class (source/config/docs, then bulk data,
 * then generated/lock files) and water-filled within a class so one huge
 * file cannot starve its siblings. Every branch mirrors the Python module;
 * the parity harness pins the two implementations
 * (`tests/fixtures/parity/diff-priority/`).
 *
 * All inputs and outputs are raw bytes (`Uint8Array`), never strings. */

import { decodeUtf8Ignore } from "./truncate.js";

const enc = (text: string): Buffer => Buffer.from(text, "utf8");

export const DEFAULT_DIFF_MARKER: Uint8Array = enc("…[diff truncated to fit context budget]");
const CHUNK_HEADER = enc("diff --git ");
export const MIN_CHUNK_BYTES = 512;
const BULK_DATA_BYTES = 32 * 1024;
const MANIFEST_MAX_LINES = 200;

export const RANK_SOURCE = 0;
export const RANK_BULK = 2;
export const RANK_GENERATED = 3;
const RANKS = [RANK_SOURCE, RANK_BULK, RANK_GENERATED] as const;

const NOTE_PREFIX = enc("…[file diff clipped: ");
const NOTE_SUFFIX = enc(" more bytes]\n");
const MANIFEST_HEADER_PREFIX = enc("Files omitted from this diff (");
const MANIFEST_HEADER_SUFFIX = enc("):\n");
const MORE_PREFIX = enc("- … and ");
const MORE_SUFFIX = enc(" more\n");
const OMITTED = enc("omitted");
const CLIPPED = enc("clipped");
const NL = 0x0a;
const DOT = 0x2e;

const LOCK_BASENAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock",
  "go.sum", "poetry.lock", "gemfile.lock", "composer.lock",
]);
const GENERATED_SUFFIXES = [".lock", ".min.js", ".min.css", ".snap", ".pb.go"];
const GENERATED_DIRS = new Set(["dist", "build", "vendor", "node_modules", "__snapshots__"]);
const BULK_TOKENS = ["fixture", "testdata", "snapshot", "golden"];
const DATA_SUFFIXES = [".json", ".jsonl", ".csv", ".svg", ".txt", ".xml"];

interface Chunk {
  index: number;
  path: Uint8Array;
  data: Uint8Array;
  adds: number;
  dels: number;
  rank: number;
}

const view = (data: Uint8Array): Buffer => Buffer.from(data.buffer, data.byteOffset, data.byteLength);

/** Python `bytes.lower()`: ASCII letters only, every other byte untouched. */
function asciiLower(data: Uint8Array): string {
  let out = "";
  for (const byte of data) {
    out += String.fromCharCode(byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte);
  }
  return out;
}

function endsWithAny(text: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => text.endsWith(suffix));
}

/** Split a unified diff into `[preamble, [[path, chunk], ...]]` at every
 * line that begins with `diff --git`. */
export function splitChunks(diff: Uint8Array): [Uint8Array, Array<[Uint8Array, Uint8Array]>] {
  const buf = view(diff);
  const starts: number[] = [];
  let pos = 0;
  for (;;) {
    const found = buf.indexOf(CHUNK_HEADER, pos);
    if (found < 0) break;
    if (found === 0 || buf[found - 1] === NL) starts.push(found);
    pos = found + 1;
  }
  if (starts.length === 0) return [diff, []];
  const preamble = buf.subarray(0, starts[0]);
  const chunks: Array<[Uint8Array, Uint8Array]> = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i] as number;
    const end = i + 1 < starts.length ? (starts[i + 1] as number) : buf.length;
    const data = buf.subarray(start, end);
    chunks.push([chunkPath(data), data]);
  }
  return [preamble, chunks];
}

function chunkPath(data: Uint8Array): Uint8Array {
  const buf = view(data);
  const newline = buf.indexOf(NL);
  const header = buf.subarray(CHUNK_HEADER.length, newline >= 0 ? newline : buf.length);
  if (header.length > 0 && header[header.length - 1] === 0x22) {
    const quoted = header.lastIndexOf(enc(' "b/'));
    if (quoted >= 0) return header.subarray(quoted + 4, header.length - 1);
  }
  const plain = header.lastIndexOf(enc(" b/"));
  if (plain >= 0) return header.subarray(plain + 3);
  return header;
}

function countChanges(data: Uint8Array): [number, number] {
  const buf = view(data);
  let adds = 0;
  let dels = 0;
  let pos = 0;
  while (pos < buf.length) {
    const newline = buf.indexOf(NL, pos);
    const end = newline >= 0 ? newline : buf.length;
    const first = buf[pos];
    if (first === 0x2b) {
      if (!(buf[pos + 1] === 0x2b && buf[pos + 2] === 0x2b && buf[pos + 3] === 0x20)) adds += 1;
    } else if (first === 0x2d) {
      if (!(buf[pos + 1] === 0x2d && buf[pos + 2] === 0x2d && buf[pos + 3] === 0x20)) dels += 1;
    }
    pos = end + 1;
  }
  return [adds, dels];
}

/** Rank a chunk: 0 source/config/docs, 2 bulk data, 3 generated/lock. */
export function rankPath(path: Uint8Array, size: number, generated: ReadonlySet<string>): number {
  if (generated.has(new TextDecoder("utf-8").decode(path))) return RANK_GENERATED;
  const lower = asciiLower(path);
  const segments = lower.split("/");
  const base = segments[segments.length - 1] as string;
  if (LOCK_BASENAMES.has(base) || endsWithAny(base, GENERATED_SUFFIXES)) return RANK_GENERATED;
  if (segments.slice(0, -1).some((segment) => GENERATED_DIRS.has(segment))) return RANK_GENERATED;
  if (base.includes(".generated.") || base.includes("_generated.")) return RANK_GENERATED;
  if (segments.some((segment) => BULK_TOKENS.some((token) => segment.includes(token)))) return RANK_BULK;
  if (endsWithAny(base, DATA_SUFFIXES) && size > BULK_DATA_BYTES) return RANK_BULK;
  return RANK_SOURCE;
}

function waterLevel(sizes: number[], avail: number): number {
  let lo = 0;
  let hi = 0;
  for (const size of sizes) if (size > hi) hi = size;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    let used = 0;
    for (const size of sizes) used += Math.min(size, mid);
    if (used <= avail) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function manifestLine(chunk: Chunk, status: Uint8Array): Buffer {
  return Buffer.concat([
    enc("- "), chunk.path, enc(" (+"), enc(String(chunk.adds)), enc("/-"),
    enc(String(chunk.dels)), enc(") "), status, enc("\n"),
  ]);
}

const moreLine = (count: number): Buffer => Buffer.concat([MORE_PREFIX, enc(String(count)), MORE_SUFFIX]);
const manifestHeader = (count: number): Buffer =>
  Buffer.concat([MANIFEST_HEADER_PREFIX, enc(String(count)), MANIFEST_HEADER_SUFFIX]);

/** `truncate_clean` semantics with a byte marker (see truncate.ts). */
export function truncatePlain(data: Uint8Array, budget: number, marker: Uint8Array = DEFAULT_DIFF_MARKER): Uint8Array {
  if (data.length <= budget) return data;
  const suffix = Buffer.concat([enc("\n"), marker, enc("\n")]);
  if (suffix.length > budget) {
    const dots = Math.min(budget, 3);
    return Buffer.alloc(dots > 0 ? dots : 0, DOT);
  }
  const clip = view(data).subarray(0, Math.max(0, budget - suffix.length));
  let end = clip.length;
  const newline = clip.lastIndexOf(NL);
  if (newline > 0) end = newline;
  return Buffer.concat([enc(decodeUtf8Ignore(clip.subarray(0, end))), suffix]);
}

export interface PrioritizeDiffOptions {
  generated?: ReadonlySet<string>;
  marker?: Uint8Array;
}

/** Fit `diff` into `budget` bytes, keeping the highest-value chunks. */
export function prioritizeDiff(diff: Uint8Array, budget: number, options: PrioritizeDiffOptions = {}): Uint8Array {
  if (diff.length <= budget) return diff;
  const generated = options.generated ?? new Set<string>();
  const marker = options.marker ?? DEFAULT_DIFF_MARKER;
  const [rawPreamble, rawChunks] = splitChunks(diff);
  if (rawChunks.length === 0) return truncatePlain(diff, budget, marker);
  if (marker.length + 2 > budget) {
    const dots = Math.min(budget, 3);
    return Buffer.alloc(dots > 0 ? dots : 0, DOT);
  }

  const chunks: Chunk[] = rawChunks.map(([path, data], index) => {
    const [adds, dels] = countChanges(data);
    return { index, path, data, adds, dels, rank: rankPath(path, data.length, generated) };
  });
  const ordered: Chunk[] = [];
  for (const rank of RANKS) for (const chunk of chunks) if (chunk.rank === rank) ordered.push(chunk);

  const total = chunks.length;
  const lineLengths = chunks.map((chunk) => manifestLine(chunk, OMITTED).length).sort((a, b) => b - a);
  let reserve = 1 + marker.length + 1 + manifestHeader(total).length;
  for (const length of lineLengths.slice(0, MANIFEST_MAX_LINES)) reserve += length;
  if (total > MANIFEST_MAX_LINES) reserve += moreLine(total).length;

  let preamble = view(rawPreamble);
  if (preamble.length + reserve > budget) {
    const cut = Math.max(0, budget - reserve);
    const newline = cut > 0 ? preamble.lastIndexOf(NL, cut - 1) : -1;
    preamble = newline >= 0 ? preamble.subarray(0, newline + 1) : Buffer.alloc(0);
  }
  let avail = budget - preamble.length - reserve;

  const emitted: Uint8Array[] = [];
  const listed: Array<[Chunk, Uint8Array]> = [];
  for (const rank of RANKS) {
    const bucket = ordered.filter((chunk) => chunk.rank === rank);
    if (bucket.length === 0) continue;
    const sizes = bucket.map((chunk) => chunk.data.length);
    const sum = sizes.reduce((a, b) => a + b, 0);
    if (sum <= avail) {
      for (const chunk of bucket) emitted.push(chunk.data);
      avail -= sum;
      continue;
    }
    const level = waterLevel(sizes, Math.max(0, avail));
    let used = 0;
    for (const chunk of bucket) {
      const size = chunk.data.length;
      if (size <= level) {
        emitted.push(chunk.data);
        used += size;
        continue;
      }
      const noteMax = NOTE_PREFIX.length + String(size).length + NOTE_SUFFIX.length;
      const limit = level - noteMax;
      let end = -1;
      if (limit > 0) {
        const newline = view(chunk.data).lastIndexOf(NL, limit - 1);
        if (newline >= 0) end = newline + 1;
      }
      if (end < MIN_CHUNK_BYTES) {
        listed.push([chunk, OMITTED]);
        continue;
      }
      const note = Buffer.concat([NOTE_PREFIX, enc(String(size - end)), NOTE_SUFFIX]);
      emitted.push(Buffer.concat([view(chunk.data).subarray(0, end), note]));
      used += end + note.length;
      listed.push([chunk, CLIPPED]);
    }
    avail -= used;
  }

  let body = Buffer.concat([preamble, ...emitted]);
  if (body.length > 0 && body[body.length - 1] !== NL) body = Buffer.concat([body, enc("\n")]);
  const lines = listed.map(([chunk, status]) => manifestLine(chunk, status));
  let out: Buffer;
  for (;;) {
    const parts: Uint8Array[] = [body, marker, enc("\n"), manifestHeader(listed.length), ...lines.slice(0, MANIFEST_MAX_LINES)];
    if (lines.length > MANIFEST_MAX_LINES) parts.push(moreLine(lines.length - MANIFEST_MAX_LINES));
    out = Buffer.concat(parts);
    if (out.length <= budget || lines.length === 0) break;
    lines.pop();
  }
  if (out.length > budget) return truncatePlain(out, budget, marker);
  return out;
}
