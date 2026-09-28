/** Repository impact and history (#706 PR 3): byte-exact port of the
 * `repo-impact-history` block of scripts/sections/classification.sh.
 *
 * Term extraction reproduces the v2 pipeline
 *
 *   { jq -r '.title, (.body // "")' pr.json; cat version-hints.truncated.txt; }
 *     | tr '[:upper:]' '[:lower:]' | grep -Eo '[a-z0-9][a-z0-9._/-]{2,}'
 *     | grep -Ev '^(stopwords)$' | sort -u    (then head -n 14)
 *
 * over raw bytes, with the collation production runs under (C.UTF-8 on the
 * GitHub runners, byte order; the terms are ASCII by construction): `tr`
 * lowercases ASCII only, `grep -o` emits the leftmost-longest run per match,
 * and `sort -u` orders and dedupes by byte. Every character outside the
 * term class splits a run, so non-ASCII input only ever acts as a separator.
 *
 * The scan runs the same git commands v2 does, in the workspace: ONE combined
 * `git grep -nEI -e <alt>` (terms joined with `|`, each `.` escaped) plus a
 * `git log --oneline --decorate --grep=<term> -n 10` per term, run
 * concurrently and assembled in term order. Exit statuses are ignored and
 * stdout kept, as `2>/dev/null || true` does. Each combined grep row is then
 * re-attributed to every term whose literal text occurs in the row's content
 * (the row minus the `^[^:]*:[0-9]+:` prefix, the awk `sub`), 60 rows per
 * term. Git output is handled as bytes (latin1 view), never re-encoded.
 *
 * Both scans stream (#805): grep rows are attributed as they arrive and each
 * term keeps only what can reach its capped section, the scan stops once
 * every term is full, and each `git log` keeps cap + 1 bytes. Only the
 * capped documents (`repo-impact.truncated.md`, `repo-history.truncated.md`,
 * the ones the corpus reads) are materialized, byte-identical to v2's. */

import { spawn } from "node:child_process";
import { jqAlt, jqField, jqRaw } from "../platform/jq.js";
import { truncateClean } from "../corpus/truncate.js";

export const MAX_IMPACT_TERMS = 14;
export const MAX_HITS_PER_TERM = 60;
export const REPO_IMPACT_MAX_BYTES = 24000;
export const REPO_HISTORY_MAX_BYTES = 12000;
export const IMPACT_MARKER = "…[impact scan truncated]";
export const HISTORY_MARKER = "…[history truncated]";
export const NO_TERMS_NOTICE = "No candidate dependency terms extracted.\n";

const TERM_RE = /[a-z0-9][a-z0-9._/-]{2,}/g;
const STOPWORDS = new Set([
  "https", "http", "from", "into", "that", "this", "with", "without", "renovate", "pull", "request",
  "release", "notes", "digest", "sha", "main", "chart", "image", "version", "github", "com", "www",
  "docker", "ghcr", "io",
]);
const GREP_PREFIX_RE = /^[^:]*:[0-9]+:/;

const latin1 = (data: Uint8Array): string => Buffer.from(data).toString("latin1");
const enc = (text: string): Buffer => Buffer.from(text, "utf8");

/** stdout of `jq -r '.title, (.body // "")'` over the pr.json value: each
 * record plus a newline, stopping at the first jq error. */
function titleAndBody(pr: unknown): Buffer {
  let out = "";
  try {
    out += `${jqRaw(jqField(pr, "title"))}\n`;
    out += `${jqRaw(jqAlt(jqField(pr, "body"), ""))}\n`;
  } catch {
    // jq stops at the error; what it printed stays in the pipe.
  }
  return enc(out);
}

/** The deduped, byte-sorted term list (`terms.all.txt` lines). */
export function extractImpactTerms(pr: unknown, versionHintsTruncated: Uint8Array | null): string[] {
  const input = Buffer.concat([titleAndBody(pr), Buffer.from(versionHintsTruncated ?? new Uint8Array(0))]);
  for (let i = 0; i < input.length; i += 1) {
    const byte = input[i] as number;
    if (byte >= 0x41 && byte <= 0x5a) input[i] = byte + 0x20;
  }
  const terms = new Set<string>();
  for (const line of latin1(input).split("\n")) {
    for (const match of line.matchAll(TERM_RE)) {
      if (!STOPWORDS.has(match[0])) terms.add(match[0]);
    }
  }
  // ASCII only, so UTF-16 order is byte order.
  return [...terms].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Terms are [a-z0-9._/-] only, so this matches v2's `sed 's/\./\\./g'`;
// backslash is escaped too so the grep pattern stays literal regardless.
const escapeTerm = (term: string): string => term.replace(/[\\.]/g, "\\$&");

/** Splits a byte stream into `\n`-terminated lines without buffering more
 * than the current line. A final line without a newline is still a line,
 * as awk treats it. */
export class LineSplitter {
  private pending: Buffer[] = [];

  /** Feeds a chunk; calls `onLine` per complete line until it returns false. */
  push(chunk: Buffer, onLine: (line: Buffer) => boolean): boolean {
    let start = 0;
    for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, start)) {
      this.pending.push(chunk.subarray(start, index));
      const line = this.pending.length === 1 ? (this.pending[0] as Buffer) : Buffer.concat(this.pending);
      this.pending = [];
      start = index + 1;
      if (!onLine(line)) return false;
    }
    if (start < chunk.length) this.pending.push(Buffer.from(chunk.subarray(start)));
    return true;
  }

  flush(onLine: (line: Buffer) => boolean): void {
    if (this.pending.length === 0) return;
    const line = Buffer.concat(this.pending);
    this.pending = [];
    if (line.length > 0) onLine(line);
  }
}

/** Streaming awk attribution (#805): every combined `git grep` row is
 * attributed to each term whose literal occurs in the row's content, in
 * stream order, keeping per term at most `limit` rows AND no more rows once
 * that term's section already exceeds `byteBudget` — beyond that point its
 * bytes can only land past the cut `truncate_clean` makes, so the capped
 * artifact is byte-identical to v2's while memory stays bounded by the caps
 * (plus the current line). `push` returns false once every term is full, so
 * the producer can stop the scan early. */
export class GrepAttribution {
  readonly rows: Buffer[][];
  private readonly bytes: number[];
  private readonly counts: number[];
  private open: number;

  constructor(private readonly terms: readonly string[], private readonly limit = MAX_HITS_PER_TERM, private readonly byteBudget = Number.POSITIVE_INFINITY) {
    this.rows = terms.map(() => []);
    this.bytes = terms.map(() => 0);
    this.counts = terms.map(() => 0);
    this.open = terms.length;
  }

  private full(index: number): boolean {
    return (this.counts[index] as number) >= this.limit || (this.bytes[index] as number) > this.byteBudget;
  }

  push(line: Buffer): boolean {
    if (this.open === 0) return false;
    const content = latin1(line).replace(GREP_PREFIX_RE, "");
    this.terms.forEach((term, index) => {
      if (this.full(index) || !content.includes(term)) return;
      (this.rows[index] as Buffer[]).push(line, NEWLINE);
      this.counts[index] = (this.counts[index] as number) + 1;
      this.bytes[index] = (this.bytes[index] as number) + line.length + 1;
      if (this.full(index)) this.open -= 1;
    });
    return this.open > 0;
  }

  section(index: number): Buffer {
    return Buffer.concat(this.rows[index] as Buffer[]);
  }
}

const NEWLINE = Buffer.from("\n");

/** awk re-attribution of a buffered combined grep output to one term. */
export function attributeGrepHits(combined: Uint8Array, term: string, limit = MAX_HITS_PER_TERM): string {
  const attribution = new GrepAttribution([term], limit);
  const splitter = new LineSplitter();
  const onLine = (line: Buffer): boolean => attribution.push(line);
  if (splitter.push(Buffer.from(combined), onLine)) splitter.flush(onLine);
  return latin1(attribution.section(0));
}

/** Runs git and streams stdout to `onChunk` until it returns false (then the
 * process is killed). Exit status and stderr are ignored, like
 * `2>/dev/null || true`; a spawn failure is empty output. */
function streamGit(argv: string[], workspace: string, onChunk: (chunk: Buffer) => boolean): Promise<void> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", argv, { cwd: workspace, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve();
      return;
    }
    let stopped = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stopped) return;
      if (!onChunk(chunk)) {
        stopped = true;
        child.stdout?.destroy();
        child.kill();
      }
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

/** The combined grep, attributed while it streams. */
async function scanImpact(terms: readonly string[], alt: string, workspace: string): Promise<GrepAttribution> {
  const attribution = new GrepAttribution(terms, MAX_HITS_PER_TERM, REPO_IMPACT_MAX_BYTES);
  const splitter = new LineSplitter();
  const onLine = (line: Buffer): boolean => attribution.push(line);
  let open = true;
  await streamGit(["grep", "-nEI", "-e", alt, "--", "."], workspace, (chunk) => (open = splitter.push(chunk, onLine)));
  if (open) splitter.flush(onLine);
  return attribution;
}

/** One term's `git log`, keeping at most `cap + 1` bytes (enough for
 * `truncate_clean` to cut exactly where it would cut the full output). */
async function scanHistory(term: string, workspace: string, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  await streamGit(["log", "--oneline", "--decorate", `--grep=${term}`, "-n", "10"], workspace, (chunk) => {
    const keep = chunk.subarray(0, Math.max(0, cap + 1 - size));
    chunks.push(Buffer.from(keep));
    size += keep.length;
    return size <= cap;
  });
  return Buffer.concat(chunks);
}

export interface RepoImpactInput {
  /** The parsed `pr.json` value (the projection context.sh writes). */
  pr: unknown;
  /** `version-hints.truncated.txt` bytes; `null` when the file is absent. */
  versionHintsTruncated: Uint8Array | null;
  /** The checked-out repository (v2's working directory). */
  workspace: string;
}

export interface RepoImpactResult {
  artifacts: Map<string, Uint8Array>;
  /** The capped, ordered scan terms (`terms.txt`). */
  terms: string[];
}

export async function buildRepoImpactHistory(input: RepoImpactInput): Promise<RepoImpactResult> {
  const allTerms = extractImpactTerms(input.pr, input.versionHintsTruncated);
  const terms = allTerms.slice(0, MAX_IMPACT_TERMS);
  const artifacts = new Map<string, Uint8Array>();
  const lines = (items: string[]): Uint8Array => enc(items.map((item) => `${item}\n`).join(""));
  artifacts.set("terms.all.txt", lines(allTerms));
  artifacts.set("terms.txt", lines(terms));
  if (terms.length === 0) {
    const notice = enc(NO_TERMS_NOTICE);
    for (const name of ["repo-impact.truncated.md", "repo-history.truncated.md"]) {
      artifacts.set(name, new Uint8Array(notice));
    }
    return { artifacts, terms };
  }
  const alt = terms.map(escapeTerm).join("|");
  const [attribution, ...histories] = await Promise.all([
    scanImpact(terms, alt, input.workspace),
    ...terms.map((term) => scanHistory(term, input.workspace, REPO_HISTORY_MAX_BYTES)),
  ]);
  const impact: Buffer[] = [];
  const history: Buffer[] = [];
  terms.forEach((term, index) => {
    impact.push(enc(`## Term: ${term}\n\n### git grep hits\n\`\`\`text\n`), (attribution as GrepAttribution).section(index), enc("```\n\n"));
    history.push(enc(`## Term: ${term}\n\n### git log context\n\`\`\`text\n`), histories[index] as Buffer, enc("```\n\n"));
  });
  // Only the capped documents are materialized: v2's untruncated
  // repo-impact.md / repo-history.md are intermediates nothing reads, and
  // the retained prefix is exact up to each cap + 1 byte.
  artifacts.set("repo-impact.truncated.md", truncateClean(new Uint8Array(Buffer.concat(impact)), REPO_IMPACT_MAX_BYTES, IMPACT_MARKER));
  artifacts.set("repo-history.truncated.md", truncateClean(new Uint8Array(Buffer.concat(history)), REPO_HISTORY_MAX_BYTES, HISTORY_MARKER));
  return { artifacts, terms };
}
