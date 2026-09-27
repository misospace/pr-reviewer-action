/** Deterministic bounded related-code context from change anchors (#572,
 * #675 port of `pr_reviewer/related_context.py`). Consumes the version-1
 * change-anchor artifact, the checked-out Git worktree, and an optional
 * changed-file list; searches only high-confidence symbol anchors with
 * argv-only fixed-string `git grep`, discovers likely tests and
 * nearest-first manifests, skips deleted/changed paths, redacts bounded
 * snippets, and degrades Git failures/timeouts into explicit artifact
 * errors — never an exception. Internal result types are camelCase (#669);
 * `relatedContextToArtifact` is the explicit serializer to the
 * v2-identical snake_case artifact, and the JSON (with its structural byte
 * cap) and Markdown renderers are byte-exact ports. Changed files carrying
 * `changed_lines` (#764) are searched as well, skipping the symbol's own
 * declaration line and every added line: listed (capped, `changed_file`) for
 * enclosing symbols only, otherwise surfaced as `only_in_changed_files`. */

import { spawn } from "node:child_process";
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "./redact.js";
import { pyJsonDump } from "./py-json.js";

export const ARTIFACT_VERSION = 1;
export const MAX_SYMBOLS = 40;
export const MAX_REFERENCES_PER_SYMBOL = 20;
export const MAX_REFERENCES = 200;
export const MAX_CHANGED_REFERENCES_PER_SYMBOL = 5;
export const MAX_CHANGED_REFERENCES = 40;
export const MAX_CHANGED_RANGES_PER_FILE = 200;
export const MAX_TESTS_PER_FILE = 20;
export const MAX_MANIFESTS_PER_FILE = 20;
export const MAX_SNIPPET_CHARS = 300;
export const DEFAULT_GIT_TIMEOUT_SEC = 10;
export const MAX_JSON_BYTES = 100_000;
export const MAX_MARKDOWN_BYTES = 100_000;
export const MAX_ERROR_CHARS = 300;
export const MAX_CONSUMER_KEYS = 40;
export const MAX_CONSUMERS_PER_KEY = 3;
export const MAX_CONSUMERS = 40;
export const MAX_CHANGED_CONSUMERS_PER_KEY = 2;
export const MAX_CHANGED_CONSUMERS = 10;
export const MAX_CONSUMER_SCAN = 100;
export const MAX_CONSUMER_WINDOWS = 12;
export const CONSUMER_CONTEXT_LINES = 2;
export const MAX_COUNTERPARTS = 8;
export const MAX_COUNTERPART_LINES = 20;
const MAX_HEAD_FILE_BYTES = 2_000_000;

const CONTROL_RE = /[\x00-\x1f\x7f]/g;
const TEST_BASE_RE = /^(?:test[-_].+|.+[_-]tests?\..+|.+\.(?:test|spec)(?:\.[^.]+)?|.+_test\.go)$/i;
const MANIFEST_BASE_RE = /^(?:pyproject\.toml|setup\.(?:py|cfg)|requirements[^/]*\.txt|package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|go\.(?:mod|sum)|Cargo\.(?:toml|lock)|Gemfile(?:\.lock)?|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|Pipfile(?:\.lock)?|poetry\.lock|uv\.lock|mix\.(?:exs|lock)|Dockerfile[^/]*|action\.ya?ml)$/i;
const GREP_ROW_RE = /^(.*?):([0-9]+):(.*)$/;
const KEY_NAME_RE = /^-{0,2}[A-Za-z0-9_][A-Za-z0-9_.\-]{0,99}$/;
const DECL_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/;
const COMMENT_PREFIXES = ["#", "//", "/*", "*"];
const PATH_WORD_RE = /[^a-z0-9]+/;
const DOC_EXTS = new Set(["md", "rst", "txt", "adoc"]);
const BRANCH_SITE_RE = /(?:===|!==|==|!=|["'\]]\s+=\s+|\s-(?:eq|ne)\s+)\s*["']|\s(?:not\s+)?in\s*[(\[{]\s*["']/;
const CASE_SITE_RE = /^\s*(?:case\s|switch\s*\(|match\s)/;
const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})/;

// ---------------------------------------------------------------------------
// Bounded text helpers
// ---------------------------------------------------------------------------

function escapeControls(value: string): string {
  return value.replace(CONTROL_RE, (ch) => {
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (ch === "\t") return "\\t";
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

/** Length in code points, as Python's `len` counts. */
function charCount(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** The first `limit` code points, as Python's `value[:limit]` cuts. */
function charSlice(value: string, limit: number): string {
  return Array.from(value).slice(0, Math.max(0, limit)).join("");
}

function boundedText(value: unknown, limit: number = MAX_ERROR_CHARS): string {
  let text = redactText(String(value ?? "")).replace("\u0000", "\\u0000");
  text = escapeControls(text);
  if (charCount(text) > limit) return charSlice(text, limit - 3) + "...";
  return text;
}

function display(value: string, limit = 200): string {
  const text = escapeControls(value);
  if (charCount(text) > limit) return charSlice(text, limit - 1) + "...";
  return text;
}

function codeSpan(value: string): string {
  if (!value.includes("`")) return `\`${value}\``;
  let maxRun = 0;
  for (const run of value.match(/`+/g) ?? []) maxRun = Math.max(maxRun, run.length);
  const delimiter = "`".repeat(maxRun + 1);
  return `${delimiter} ${value} ${delimiter}`;
}

function toPath(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replaceAll("\\", "/");
}

function utf8Len(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// ---------------------------------------------------------------------------
// Input shaping
// ---------------------------------------------------------------------------

function normaliseFileList(fileList: unknown): Record<string, unknown>[] {
  if (!Array.isArray(fileList)) return [];
  return fileList.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry));
}

function changedPaths(
  anchorFiles: Record<string, unknown>[],
  fileList: Record<string, unknown>[],
): { changed: Set<string>; deleted: Set<string> } {
  const changed = new Set<string>();
  const deleted = new Set<string>();
  for (const entry of anchorFiles) {
    const path = toPath(entry.path);
    if (path) changed.add(path);
    if (entry.deleted && path) deleted.add(path);
  }
  for (const entry of fileList) {
    const filename = toPath(entry.filename);
    const previous = toPath(entry.previous_filename);
    for (const path of [filename, previous]) {
      if (path) changed.add(path);
    }
    if (entry.status === "removed") {
      if (filename) deleted.add(filename);
      if (previous) deleted.add(previous);
    }
  }
  return { changed, deleted };
}

function errorOf(kind: string, detail: unknown = ""): string {
  const suffix = detail ? `: ${boundedText(detail)}` : "";
  return `${kind}${suffix}`;
}

// ---------------------------------------------------------------------------
// Git execution (argv-only, bounded, fail-soft)
// ---------------------------------------------------------------------------

/** Python `%g` formatting for timeout values in error messages (10 -> "10",
 * 0.5 -> "0.5"). */
function gFormat(value: number): string {
  return String(value);
}

function runGit(argv: string[], workspace: string, timeoutSec: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0] as string, argv.slice(1), { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolvePromise({ code: null, stdout: "", stderr: errorOf("command failed to start", (error as Error).message) });
      return;
    }
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSec * 1000);
    const finish = (code: number | null, stdout: Buffer, stderr: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        resolvePromise({ code: null, stdout: "", stderr: errorOf("command timed out", `after ${gFormat(timeoutSec)}s`) });
        return;
      }
      resolvePromise({ code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    };
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        resolvePromise({ code: null, stdout: "", stderr: "git executable not found" });
      } else {
        resolvePromise({ code: null, stdout: "", stderr: errorOf("command failed to start", error.message) });
      }
    });
    child.on("close", (code) => finish(code, Buffer.concat(out), Buffer.concat(err)));
  });
}

async function trackedFiles(workspace: string, timeoutSec: number): Promise<{ paths: string[]; error: string | null }> {
  const { code, stdout, stderr } = await runGit(["git", "ls-files", "-z"], workspace, timeoutSec);
  if (code === null) return { paths: [], error: stderr };
  if (code !== 0) return { paths: [], error: errorOf(`git ls-files exited ${code}`, stderr.trim()) };
  return { paths: stdout.split("\u0000").filter((chunk) => chunk !== ""), error: null };
}

interface GrepRow {
  path: string;
  line: number;
  snippet: string;
  changedFile?: boolean;
}

function snippetOf(value: string): string {
  let text = redactText(value);
  text = escapeControls(text);
  if (charCount(text) > MAX_SNIPPET_CHARS) return charSlice(text, MAX_SNIPPET_CHARS - 3) + "...";
  return text;
}

function parseGrepLine(rawLine: string): GrepRow | null {
  const match = GREP_ROW_RE.exec(rawLine);
  if (!match) return null;
  return { path: match[1] as string, line: Number.parseInt(match[2] as string, 10), snippet: snippetOf(match[3] as string) };
}

export interface GrepResult {
  rows: GrepRow[];
  extraHit: boolean;
  error: string | null;
}

/** Stream eligible symbol matches without buffering an unbounded result:
 * stops at the first row past *maxHits* (the `extraHit` marker), excludes
 * changed paths, and maps spawn/timeout failures onto the explicit error
 * vocabulary. `symbol` may be a list of fixed strings, any of which matches.
 * `pathspecs` limits the search to those literal paths; `keep` drops rows it
 * rejects before they count. */
export function gitGrepReferences(
  symbol: string | readonly string[],
  workspace: string,
  options: {
    excludedPaths: Set<string>;
    timeoutSec?: number;
    maxHits?: number;
    pathspecs?: string[];
    keep?: (row: GrepRow) => boolean;
  },
): Promise<GrepResult> {
  const limit = Math.max(0, Math.trunc(options.maxHits ?? MAX_REFERENCES_PER_SYMBOL));
  const { excludedPaths, timeoutSec = DEFAULT_GIT_TIMEOUT_SEC, keep } = options;
  if (limit === 0) return Promise.resolve({ rows: [], extraHit: false, error: null });
  const scope = options.pathspecs && options.pathspecs.length > 0 ? options.pathspecs.map((path) => `:(literal)${path}`) : ["."];
  const patterns = typeof symbol === "string" ? ["--", symbol] : symbol.flatMap((pattern) => ["-e", pattern]);

  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["grep", "-n", "-F", ...patterns, "--", ...scope], {
        cwd: workspace,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolvePromise({ rows: [], extraHit: false, error: "git grep failed to start" });
      return;
    }
    const deadline = Date.now() + timeoutSec * 1000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(0, deadline - Date.now()));

    const rows: GrepRow[] = [];
    let extraHit = false;
    let buffer = "";
    let settled = false;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode !== null && !timedOut) {
        // Signalled externally: v2 treats negative return codes as
        // "terminated, results still usable".
        resolvePromise({ rows, extraHit, error: null });
        return;
      }
      if (timedOut) {
        resolvePromise({ rows: [], extraHit: false, error: errorOf("git grep", `command timed out after ${gFormat(timeoutSec)}s`) });
        return;
      }
      if (code === 0 || rows.length > 0 || extraHit) {
        resolvePromise({ rows, extraHit, error: null });
        return;
      }
      if (code === 1) {
        resolvePromise({ rows: [], extraHit: false, error: null });
        return;
      }
      if (code === null) {
        resolvePromise({ rows, extraHit, error: null });
        return;
      }
      resolvePromise({ rows: [], extraHit: false, error: errorOf(`git grep exited ${code}`) });
    };

    const handleLine = (line: string): void => {
      if (extraHit) return;
      const row = parseGrepLine(line);
      if (!row) return;
      if (excludedPaths.has(row.path)) return;
      if (keep !== undefined && !keep(row)) return;
      if (rows.length < limit) rows.push(row);
      else extraHit = true;
    };
    // Universal-newline translation, like the v2 text-mode pipe.
    const handleChunk = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        handleLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (extraHit) {
          child.kill("SIGKILL");
          return;
        }
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (!extraHit) handleChunk(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        resolvePromise({ rows: [], extraHit: false, error: "git executable not found" });
      } else {
        resolvePromise({ rows: [], extraHit: false, error: "git grep failed to start" });
      }
    });
    child.on("close", (code) => {
      if (!extraHit && buffer !== "") handleLine(buffer);
      finish(code);
    });
  });
}

// ---------------------------------------------------------------------------
// Discovery heuristics
// ---------------------------------------------------------------------------

function isTestPath(path: string): boolean {
  const parts = path.split("/").map((part) => part.toLowerCase());
  const base = parts.length > 0 ? (parts[parts.length - 1] as string) : "";
  if (parts.slice(0, -1).some((part) => ["test", "tests", "spec", "specs", "testing", "__tests__"].includes(part))) return true;
  return TEST_BASE_RE.test(base) || base.endsWith("_test.go");
}

function stemOf(path: string): string {
  let base = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
  if (base.includes(".")) base = base.slice(0, base.lastIndexOf("."));
  return base.toLowerCase();
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function testScore(changedPath: string, candidate: string): [number, string] {
  const stem = stemOf(changedPath);
  const base = (candidate.includes("/") ? candidate.slice(candidate.lastIndexOf("/") + 1) : candidate).toLowerCase();
  const parent = changedPath.includes("/") ? changedPath.slice(0, changedPath.lastIndexOf("/")) : "";
  const candidateParent = candidate.includes("/") ? candidate.slice(0, candidate.lastIndexOf("/")) : "";
  if (["test_" + stem + ".py", "test-" + stem + ".py", stem + "_test.py"].includes(base)) return [0, candidate];
  if (new RegExp(`(?:^|[._-])${escapeRe(stem)}(?:[._-])(test|spec)(?:[._-]|$)`).test(base)) return [0, candidate];
  if (stem !== "" && base.includes(stem)) return [1, candidate];
  if (candidateParent === parent) return [2, candidate];
  if (parent !== "" && candidateParent.startsWith(parent + "/")) return [3, candidate];
  return [4, candidate];
}

function discoverTests(
  changedPath: string,
  tracked: string[],
  references: readonly GrepRow[],
  changedPathSet: Set<string>,
): string[] {
  // Python rsplit("/", 1)[0] without a guard returns the whole string for
  // slash-less paths — the v2 parent comparison relies on exactly that.
  const rsplit0 = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : path);
  const candidates: Array<[number, string]> = [];
  const seen = new Set<string>();
  const changedParent = rsplit0(changedPath);
  for (const candidate of tracked) {
    if (changedPathSet.has(candidate) || !isTestPath(candidate)) continue;
    const [score, value] = testScore(changedPath, candidate);
    if (score < 4 || rsplit0(candidate) === changedParent) {
      candidates.push([score, value]);
      seen.add(candidate);
    }
  }
  for (const reference of references) {
    const candidate = reference.path;
    if (changedPathSet.has(candidate) || seen.has(candidate) || !isTestPath(candidate)) continue;
    candidates.push([5, candidate]);
    seen.add(candidate);
  }
  candidates.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return candidates.map(([, candidate]) => candidate);
}

function isManifestPath(path: string): boolean {
  const base = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
  return MANIFEST_BASE_RE.test(base);
}

function discoverManifests(changedPath: string, tracked: Set<string>): [string[], number] {
  let parent = changedPath.includes("/") ? changedPath.slice(0, changedPath.lastIndexOf("/")) : "";
  const directories: string[] = [];
  for (;;) {
    directories.push(parent);
    if (parent === "") break;
    parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
  }
  const manifests: string[] = [];
  for (const directory of directories) {
    const local: string[] = [];
    const prefix = directory === "" ? "" : `${directory}/`;
    for (const path of tracked) {
      if (!isManifestPath(path) || !path.startsWith(prefix)) continue;
      const remainder = path.slice(prefix.length);
      if (!remainder.includes("/")) local.push(path);
    }
    manifests.push(...local.sort());
  }
  const omitted = Math.max(0, manifests.length - MAX_MANIFESTS_PER_FILE);
  return [manifests.slice(0, MAX_MANIFESTS_PER_FILE), omitted];
}

interface SymbolAnchor {
  source: string;
  name: string;
  kind: unknown;
  line: unknown;
}

function anchorSymbols(anchorData: Record<string, unknown>): SymbolAnchor[] {
  const symbols: SymbolAnchor[] = [];
  const files = anchorData.files;
  if (Array.isArray(files)) {
    for (const fileEntry of files) {
      if (fileEntry === null || typeof fileEntry !== "object" || Array.isArray(fileEntry)) continue;
      const rec = fileEntry as Record<string, unknown>;
      const source = toPath(rec.path);
      if (source === "" || rec.deleted) continue;
      const values = rec.symbols;
      if (!Array.isArray(values)) continue;
      for (const symbol of values) {
        if (symbol === null || typeof symbol !== "object" || Array.isArray(symbol)) continue;
        const symbolRec = symbol as Record<string, unknown>;
        if (symbolRec.confidence !== "high") continue;
        const name = symbolRec.name;
        if (typeof name === "string" && name !== "") symbols.push({ source, name, kind: symbolRec.kind, line: symbolRec.line });
      }
    }
    if (symbols.length > 0) return symbols;
  }
  const anchors = anchorData.anchors;
  if (Array.isArray(anchors)) {
    for (const anchor of anchors) {
      if (anchor === null || typeof anchor !== "object" || Array.isArray(anchor)) continue;
      const rec = anchor as Record<string, unknown>;
      if (rec.kind !== "symbol") continue;
      if (rec.confidence !== "high") continue;
      const source = toPath(rec.source);
      const name = rec.value;
      if (source !== "" && typeof name === "string" && name !== "") symbols.push({ source, name, kind: rec.kind, line: rec.line });
    }
  }
  return symbols;
}

function lineNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 1 ? value : null;
}

/** Map changed files with valid `changed_lines` to their added-line ranges. */
function changedLineIndex(anchorFiles: Record<string, unknown>[], deletedPaths: Set<string>): Map<string, [number, number][]> {
  const index = new Map<string, [number, number][]>();
  const seen = new Set<string>();
  for (const entry of anchorFiles) {
    const path = toPath(entry.path);
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    if (entry.deleted || deletedPaths.has(path)) continue;
    const raw = entry.changed_lines;
    if (!Array.isArray(raw) || raw.length > MAX_CHANGED_RANGES_PER_FILE) continue;
    let ranges: [number, number][] | null = [];
    for (const item of raw) {
      const start = Array.isArray(item) && item.length === 2 ? lineNumber(item[0]) : null;
      const end = start !== null ? lineNumber((item as unknown[])[1]) : null;
      if (start === null || end === null || end < start) {
        ranges = null;
        break;
      }
      ranges.push([start, end]);
    }
    if (ranges !== null) index.set(path, ranges);
  }
  return index;
}

/** Search changed files, non-test paths first, so tests cannot crowd out callers. */
async function changedFileReferences(
  symbol: string,
  workspace: string,
  paths: string[],
  keep: (row: GrepRow) => boolean,
  cap: number,
  timeoutSec: number,
): Promise<GrepResult> {
  const groups = [paths.filter((path) => !isTestPath(path)), paths.filter((path) => isTestPath(path))];
  const rows: GrepRow[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    const left = cap - rows.length;
    const grep = await gitGrepReferences(symbol, workspace, {
      excludedPaths: new Set(),
      timeoutSec,
      maxHits: Math.max(left, 1),
      pathspecs: group,
      keep,
    });
    if (grep.error !== null) return { rows, extraHit: false, error: grep.error };
    if (left <= 0) return { rows, extraHit: grep.rows.length > 0 || grep.extraHit, error: null };
    rows.push(...grep.rows);
    if (grep.extraHit) return { rows, extraHit: true, error: null };
  }
  return { rows, extraHit: false, error: null };
}

// ---------------------------------------------------------------------------
// Consumers of changed keys and referenced counterparts (#791)
// ---------------------------------------------------------------------------

/** Read a worktree file as lines, or null: a verbatim port of
 * `change_anchors.read_head_lines` (plain relative path, no symlinks, regular
 * file within the byte cap). */
export function readHeadLines(sourceRoot: string, relPath: string): string[] | null {
  if (relPath === "" || relPath.includes("\u0000") || relPath.startsWith("/")) return null;
  const parts = relPath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part === ".git")) return null;
  let fd: number;
  try {
    const candidate = join(realpathSync(sourceRoot), ...parts);
    if (realpathSync(candidate) !== candidate) return null;
    fd = openSync(candidate, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  let data: Buffer;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_HEAD_FILE_BYTES) return null;
    data = readFileSync(fd);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  if (data.length > MAX_HEAD_FILE_BYTES) return null;
  return data.toString("utf8").split("\n").map((line) => line.replace(/\r+$/, ""));
}

/** Lowercase words of a key, env name, or flag: port of `change_anchors.key_words`. */
export function keyWords(name: string): string[] {
  let base = name.replace(/^-+/, "");
  if (base.startsWith("INPUT_")) base = base.slice("INPUT_".length);
  const words: string[] = [];
  for (let part of base.split(/[^A-Za-z0-9]+/)) {
    if (part === "") continue;
    if (part !== part.toUpperCase()) part = part.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    words.push(...part.toLowerCase().split(" ").filter((word) => word !== ""));
  }
  return words;
}

/** Search forms of a changed key: as written, kebab, snake, UPPER_SNAKE, and
 * INPUT_; a `branch` variable (which may be one word) as written, snake, and
 * UPPER_SNAKE. */
export function keyVariants(name: string, kind = "entity"): string[] {
  const words = keyWords(name);
  if (words.length === 0 || (words.length < 2 && kind !== "branch")) return [];
  const snake = words.join("_");
  const bare = name.replace(/^-+/, "");
  const forms =
    kind === "branch"
      ? [bare, snake, snake.toUpperCase()]
      : [bare, words.join("-"), snake, snake.toUpperCase(), `INPUT_${snake.toUpperCase()}`];
  const variants: string[] = [];
  for (const variant of forms) {
    if (!variants.includes(variant)) variants.push(variant);
  }
  return variants;
}

/** Whether a line branches on a variant that is not an attribute of
 * something else: a `case`/`switch`/`match` on it, or a comparison with a
 * string literal after it. */
function branchSite(snippet: string, variants: string[]): boolean {
  const positions: number[] = [];
  for (const variant of variants) {
    let index = snippet.indexOf(variant);
    while (index > 0 && snippet[index - 1] === ".") index = snippet.indexOf(variant, index + 1);
    if (index >= 0) positions.push(index);
  }
  if (positions.length === 0) return false;
  if (CASE_SITE_RE.test(snippet)) return true;
  return BRANCH_SITE_RE.test(snippet.slice(Math.min(...positions)));
}

function consumerTier(row: GrepRow): number {
  if (isTestPath(row.path)) return 3;
  const base = (row.path.includes("/") ? row.path.slice(row.path.lastIndexOf("/") + 1) : row.path).toLowerCase();
  if (base.includes(".") && DOC_EXTS.has(base.slice(base.lastIndexOf(".") + 1))) return 2;
  const text = row.snippet.trimStart();
  return COMMENT_PREFIXES.some((prefix) => text.startsWith(prefix)) ? 1 : 0;
}

interface AnchorKey {
  source: string;
  name: string;
  kind: string;
  line: number | null;
}

function anchorKeys(anchorFiles: Record<string, unknown>[], deletedPaths: Set<string>): AnchorKey[] {
  const keys: AnchorKey[] = [];
  const seen = new Set<string>();
  for (const entry of anchorFiles) {
    const source = toPath(entry.path);
    const values = entry.keys;
    if (source === "" || entry.deleted || deletedPaths.has(source) || !Array.isArray(values)) continue;
    for (const item of values) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const { name, kind } = rec;
      if (typeof name !== "string" || !KEY_NAME_RE.test(name) || seen.has(name)) continue;
      if (kind !== "entity" && kind !== "env" && kind !== "flag" && kind !== "branch") continue;
      seen.add(name);
      keys.push({ source, name, kind, line: lineNumber(rec.line) });
    }
  }
  return keys;
}

interface CounterpartItem {
  path: string;
  name: string;
  line: number;
  refPath: string;
  refName: string;
  refLine: number;
  refEnd: number;
  refChanged: boolean;
}

function anchorCounterparts(anchorFiles: Record<string, unknown>[], deletedPaths: Set<string>): CounterpartItem[] {
  const items: CounterpartItem[] = [];
  for (const entry of anchorFiles) {
    const source = toPath(entry.path);
    const values = entry.counterparts;
    if (source === "" || entry.deleted || deletedPaths.has(source) || !Array.isArray(values)) continue;
    for (const item of values) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const { name, ref_name: refName } = rec;
      const refPath = toPath(rec.ref_path);
      const line = lineNumber(rec.line);
      const refLine = lineNumber(rec.ref_line);
      const refEnd = lineNumber(rec.ref_end);
      if (typeof name !== "string" || !DECL_NAME_RE.test(name)) continue;
      if (typeof refName !== "string" || !DECL_NAME_RE.test(refName)) continue;
      if (refPath === "" || refPath === source || deletedPaths.has(refPath)) continue;
      if (line === null || refLine === null || refEnd === null || refEnd < refLine) continue;
      items.push({ path: source, name, line, refPath, refName, refLine, refEnd, refChanged: rec.ref_changed === true });
    }
  }
  return items;
}

function fileWindow(lines: string[] | null, start: number, end: number): string[] {
  if (lines === null) return [];
  const total = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  return lines.slice(Math.max(1, start) - 1, Math.min(end, total)).map((text) => snippetOf(text.replaceAll("\t", "    ")));
}

function noteCap(result: RelatedContext, reason: string): void {
  result.truncated = true;
  result.truncation.truncated = true;
  if (!result.truncation.reasons.includes(reason)) result.truncation.reasons.push(reason);
}

function noteError(result: RelatedContext, errorsSeen: Set<string>, error: string): void {
  if (!errorsSeen.has(error)) {
    result.errors.push(error);
    errorsSeen.add(error);
  }
}

/** How many distinct forms of a key a line carries: a line mapping one
 * naming onto another (`ENV_NAME: ${{ inputs.env_name }}`) is where the key
 * crosses a boundary. */
function bridgeScore(snippet: string, variants: string[]): number {
  const matched = variants.filter((variant) => snippet.includes(variant));
  return matched.filter((variant) => !matched.some((other) => variant !== other && other.includes(variant))).length;
}

/** Whether a path is a YAML/JSON/TOML data file (not a lockfile): port of
 * `change_anchors.data_format`. */
function isDataFile(path: string): boolean {
  const name = (path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path).toLowerCase();
  if (!name.includes(".") || name.endsWith(".lock") || name.endsWith(".sum") || /[-.]lock\.(?:json|ya?ml)$/.test(name)) return false;
  return ["yaml", "yml", "json", "toml"].includes(name.slice(name.lastIndexOf(".") + 1));
}

/** Each file's best row: lowest tier, then (in a data file) most key forms,
 * then first line. */
function bestPerFile(rows: GrepRow[], variants: string[]): Map<string, [number, GrepRow]> {
  const best = new Map<string, [number, number, GrepRow]>();
  for (const row of rows) {
    const tier = consumerTier(row);
    const bridge = isDataFile(row.path) ? bridgeScore(row.snippet, variants) : 0;
    const current = best.get(row.path);
    if (current === undefined || tier < current[0] || (tier === current[0] && bridge > current[1])) best.set(row.path, [tier, bridge, row]);
  }
  return new Map([...best].map(([path, [tier, , row]]) => [path, [tier, row] as [number, GrepRow]]));
}

/** Take one item from each list per round, up to `totalCap` items. */
function breadthFirst(lists: GrepRow[][], depthCap: number, totalCap: number, result: RelatedContext): GrepRow[][] {
  const chosen: GrepRow[][] = lists.map(() => []);
  let total = 0;
  for (let depth = 0; depth < depthCap; depth += 1) {
    for (let index = 0; index < lists.length; index += 1) {
      const rows = lists[index] as GrepRow[];
      if (depth < rows.length) {
        if (total >= totalCap) {
          noteCap(result, "consumer_cap");
          break;
        }
        (chosen[index] as GrepRow[]).push(rows[depth] as GrepRow);
        total += 1;
      }
    }
  }
  return chosen;
}

/** Search each key's variants in unchanged files, then in changed files
 * outside their added lines. A file counts once per key. Unchanged hits rank
 * code lines before comments, docs, and tests, then files whose path shares
 * more of the key's words, and every key gets its best hit before any key
 * gets a second. Changed-file hits follow under their own caps, also breadth
 * first: code lines only, non-test files first, and never the entity's own
 * file. Within a data file, the line carrying the most forms of the key wins. A
 * `branch` key only matches lines that compare it to a literal or
 * switch on it. A key whose variants match more than `MAX_CONSUMER_SCAN`
 * unchanged lines is too common to keep. The first `MAX_CONSUMER_WINDOWS`
 * hits, breadth first, carry a few lines of context; the rest only the
 * matched line. */
async function buildConsumers(
  result: RelatedContext,
  keys: AnchorKey[],
  workspace: string,
  excluded: Set<string>,
  changedIndex: Map<string, [number, number][]>,
  timeoutSec: number,
  errorsSeen: Set<string>,
  caps: { perKey: number; total: number; changedPerKey: number; changedTotal: number },
): Promise<ConsumerKey[]> {
  if (keys.length > MAX_CONSUMER_KEYS) noteCap(result, "consumer_cap");
  const ranked: Array<{ key: AnchorKey; variants: string[]; hits: GrepRow[]; changedHits: GrepRow[] }> = [];
  for (const key of keys.slice(0, MAX_CONSUMER_KEYS)) {
    const variants = keyVariants(key.name, key.kind);
    if (variants.length === 0) continue;
    const keep = (row: GrepRow): boolean => {
      if (charCount(row.snippet) >= MAX_SNIPPET_CHARS) return false;
      return key.kind !== "branch" || branchSite(row.snippet, variants);
    };
    const grep = await gitGrepReferences(variants, workspace, {
      excludedPaths: excluded,
      timeoutSec,
      maxHits: MAX_CONSUMER_SCAN,
      keep,
    });
    if (grep.error !== null) {
      noteError(result, errorsSeen, grep.error);
      continue;
    }
    if (grep.extraHit) continue;
    const best = bestPerFile(grep.rows, variants);
    const words = new Set(keyWords(key.name));
    const rank = ([tier, row]: [number, GrepRow]): [number, number, string] => {
      const pathWords = new Set(row.path.toLowerCase().split(PATH_WORD_RE));
      let affinity = 0;
      for (const word of words) if (pathWords.has(word)) affinity += 1;
      return [tier, -affinity, row.path];
    };
    let hits = [...best.values()]
      .map((item) => ({ rank: rank(item), row: item[1] }))
      .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || (a.rank[2] < b.rank[2] ? -1 : a.rank[2] > b.rank[2] ? 1 : 0))
      .map((item) => item.row);
    if (hits.length > caps.perKey) {
      noteCap(result, "consumer_cap");
      hits = hits.slice(0, caps.perKey);
    }

    let changedHits: GrepRow[] = [];
    const searched = [...changedIndex.keys()].filter((path) => key.kind !== "entity" || path !== key.source);
    if (searched.length > 0 && caps.changedPerKey > 0) {
      const keepChanged = (row: GrepRow): boolean => {
        const tier = consumerTier(row);
        if (tier === 1 || tier === 2 || !keep(row)) return false;
        const ranges = changedIndex.get(row.path) as [number, number][];
        return !ranges.some(([start, end]) => start <= row.line && row.line <= end);
      };
      const changed = await gitGrepReferences(variants, workspace, {
        excludedPaths: new Set(),
        timeoutSec,
        maxHits: MAX_CONSUMER_SCAN,
        pathspecs: searched,
        keep: keepChanged,
      });
      if (changed.error !== null) noteError(result, errorsSeen, changed.error);
      changedHits = [...bestPerFile(changed.rows, variants).values()]
        .map((item) => item[1])
        .sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      if (changed.extraHit || changedHits.length > caps.changedPerKey) {
        noteCap(result, "consumer_cap");
        changedHits = changedHits.slice(0, caps.changedPerKey);
      }
      for (const row of changedHits) row.changedFile = true;
    }
    if (hits.length > 0 || changedHits.length > 0) ranked.push({ key, variants, hits, changedHits });
  }

  const chosen = breadthFirst(
    ranked.map((item) => item.hits),
    caps.perKey,
    caps.total,
    result,
  );
  const chosenChanged = breadthFirst(
    ranked.map((item) => item.changedHits),
    caps.changedPerKey,
    caps.changedTotal,
    result,
  );
  const groups = chosen.map((rows, index) => [...rows, ...(chosenChanged[index] as GrepRow[])]);

  const windowed = new Set<string>();
  for (let depth = 0; windowed.size < MAX_CONSUMER_WINDOWS && groups.some((rows) => depth < rows.length); depth += 1) {
    groups.forEach((rows, index) => {
      if (depth < rows.length && windowed.size < MAX_CONSUMER_WINDOWS) windowed.add(`${index}:${depth}`);
    });
  }

  const consumers: ConsumerKey[] = [];
  const cache = new Map<string, string[] | null>();
  ranked.forEach(({ key, variants }, index) => {
    const rows = groups[index] as GrepRow[];
    if (rows.length === 0) return;
    const references: ConsumerReference[] = rows.map((row, position) => {
      let match = "";
      for (const variant of variants) {
        if (row.snippet.includes(variant) && variant.length > match.length) match = variant;
      }
      const reference: ConsumerReference = {
        path: row.path,
        line: row.line,
        ...(row.changedFile === true ? { changedFile: true } : {}),
        ...(match !== "" ? { match } : {}),
      };
      if (windowed.has(`${index}:${position}`)) {
        if (!cache.has(row.path)) cache.set(row.path, readHeadLines(workspace, row.path));
        let start = Math.max(1, row.line - CONSUMER_CONTEXT_LINES);
        let window = fileWindow(cache.get(row.path) ?? null, start, row.line + CONSUMER_CONTEXT_LINES);
        if (window.length <= row.line - start) {
          start = row.line;
          window = [row.snippet];
        }
        reference.start = start;
        reference.lines = window;
      } else {
        reference.snippet = row.snippet;
      }
      return reference;
    });
    consumers.push({ key: key.name, kind: key.kind, source: key.source, line: key.line, references });
  });
  return consumers;
}

function buildCounterparts(result: RelatedContext, items: CounterpartItem[], workspace: string, tracked: Set<string>, maxCounterparts: number): Counterpart[] {
  const counterparts: Counterpart[] = [];
  const cache = new Map<string, string[] | null>();
  for (const item of items) {
    if (!tracked.has(item.refPath)) continue;
    if (counterparts.length >= maxCounterparts) {
      noteCap(result, "counterpart_cap");
      break;
    }
    if (!cache.has(item.refPath)) cache.set(item.refPath, readHeadLines(workspace, item.refPath));
    const lines = cache.get(item.refPath) ?? null;
    if (lines === null || item.refLine > lines.length || !(lines[item.refLine - 1] as string).includes(item.refName)) continue;
    const end = Math.min(item.refEnd, item.refLine + MAX_COUNTERPART_LINES - 1);
    const body = fileWindow(lines, item.refLine, end);
    counterparts.push({
      path: item.path,
      name: item.name,
      line: item.line,
      refPath: item.refPath,
      refName: item.refName,
      refLine: item.refLine,
      ...(item.refChanged ? { refChanged: true } : {}),
      lines: body,
      ...(body.length < item.refEnd - item.refLine + 1 ? { linesTruncated: true } : {}),
    });
  }
  return counterparts;
}

function noteReferenceCap(result: RelatedContext, omitted: number): void {
  result.truncated = true;
  result.truncation.truncated = true;
  if (!result.truncation.reasons.includes("reference_cap")) result.truncation.reasons.push("reference_cap");
  result.truncation.omittedReferences += omitted;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface RelatedSymbol {
  name: string;
  references: GrepRow[];
  onlyInChangedFiles?: boolean;
}

export interface RelatedFile {
  path: string;
  symbols: RelatedSymbol[];
  tests: string[];
  manifests: string[];
}

export interface RelatedTruncation {
  truncated: boolean;
  reasons: string[];
  omittedSymbols: number;
  omittedReferences: number;
  omittedTests: number;
  omittedManifests: number;
  omittedOutputBytes: number;
}

export interface ConsumerReference {
  path: string;
  line: number;
  changedFile?: boolean;
  match?: string;
  start?: number;
  lines?: string[];
  snippet?: string;
}

export interface ConsumerKey {
  key: string;
  kind: string;
  source: string;
  line: number | null;
  references: ConsumerReference[];
}

export interface Counterpart {
  path: string;
  name: string;
  line: number;
  refPath: string;
  refName: string;
  refLine: number;
  refChanged?: boolean;
  lines: string[];
  linesTruncated?: boolean;
}

export interface RelatedContext {
  version: number;
  files: RelatedFile[];
  truncated: boolean;
  errors: string[];
  truncation: RelatedTruncation;
  consumers?: ConsumerKey[];
  counterparts?: Counterpart[];
}

function emptyResult(): RelatedContext {
  return {
    version: ARTIFACT_VERSION,
    files: [],
    truncated: false,
    errors: [],
    truncation: {
      truncated: false,
      reasons: [],
      omittedSymbols: 0,
      omittedReferences: 0,
      omittedTests: 0,
      omittedManifests: 0,
      omittedOutputBytes: 0,
    },
  };
}

export interface RelatedContextOptions {
  gitTimeoutSec?: number;
  maxSymbols?: number;
  maxReferencesPerSymbol?: number;
  maxReferences?: number;
  maxTestsPerFile?: number;
  maxChangedReferencesPerSymbol?: number;
  maxChangedReferences?: number;
  maxConsumersPerKey?: number;
  maxConsumers?: number;
  maxChangedConsumersPerKey?: number;
  maxChangedConsumers?: number;
  maxCounterparts?: number;
}

/** Build a version-1 related-code context without raising on Git errors. */
export async function buildRelatedContext(
  anchorData: unknown,
  workspace: string,
  fileList?: readonly unknown[] | null,
  options: RelatedContextOptions = {},
): Promise<RelatedContext> {
  const result = emptyResult();
  if (anchorData === null || typeof anchorData !== "object" || Array.isArray(anchorData)) {
    result.errors.push("change-anchor artifact is not a JSON object");
    result.truncated = true;
    result.truncation.truncated = true;
    result.truncation.reasons.push("invalid_input");
    return result;
  }
  const anchor = anchorData as Record<string, unknown>;
  let timeout: number;
  try {
    timeout = Math.max(0.1, Number(options.gitTimeoutSec ?? DEFAULT_GIT_TIMEOUT_SEC));
  } catch {
    timeout = DEFAULT_GIT_TIMEOUT_SEC;
  }
  if (Number.isNaN(timeout)) timeout = DEFAULT_GIT_TIMEOUT_SEC;
  const maxSymbols = Math.max(0, Math.trunc(options.maxSymbols ?? MAX_SYMBOLS));
  const maxReferencesPerSymbol = Math.max(0, Math.trunc(options.maxReferencesPerSymbol ?? MAX_REFERENCES_PER_SYMBOL));
  const maxReferences = Math.max(0, Math.trunc(options.maxReferences ?? MAX_REFERENCES));
  const maxTestsPerFile = Math.max(0, Math.trunc(options.maxTestsPerFile ?? MAX_TESTS_PER_FILE));
  const maxChangedReferencesPerSymbol = Math.max(0, Math.trunc(options.maxChangedReferencesPerSymbol ?? MAX_CHANGED_REFERENCES_PER_SYMBOL));
  const maxChangedReferences = Math.max(0, Math.trunc(options.maxChangedReferences ?? MAX_CHANGED_REFERENCES));
  const maxConsumersPerKey = Math.max(0, Math.trunc(options.maxConsumersPerKey ?? MAX_CONSUMERS_PER_KEY));
  const maxConsumers = Math.max(0, Math.trunc(options.maxConsumers ?? MAX_CONSUMERS));
  const maxChangedConsumersPerKey = Math.max(0, Math.trunc(options.maxChangedConsumersPerKey ?? MAX_CHANGED_CONSUMERS_PER_KEY));
  const maxChangedConsumers = Math.max(0, Math.trunc(options.maxChangedConsumers ?? MAX_CHANGED_CONSUMERS));
  const maxCounterparts = Math.max(0, Math.trunc(options.maxCounterparts ?? MAX_COUNTERPARTS));

  const rawAnchorFiles = anchor.files;
  const anchorFiles = Array.isArray(rawAnchorFiles)
    ? rawAnchorFiles.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry))
    : [];
  const fileListNormalized = normaliseFileList(fileList);
  const { changed: changedPathsSet, deleted: deletedPaths } = changedPaths(anchorFiles, fileListNormalized);
  for (const { source } of anchorSymbols(anchor)) changedPathsSet.add(source);

  const { paths: tracked, error: trackedError } = await trackedFiles(workspace, timeout);
  if (trackedError) result.errors.push(trackedError);
  const trackedSet = new Set(tracked);

  const allSymbols = anchorSymbols(anchor);
  const selectedSymbols = allSymbols.slice(0, maxSymbols);
  const omittedSymbols = Math.max(0, allSymbols.length - selectedSymbols.length);
  if (omittedSymbols) {
    result.truncated = true;
    result.truncation.truncated = true;
    result.truncation.reasons.push("symbol_cap");
    result.truncation.omittedSymbols = omittedSymbols;
  }

  const byFile = new Map<string, RelatedFile>();
  const fileOrder: string[] = [];
  for (const entry of anchorFiles) {
    const path = toPath(entry.path);
    if (path === "" || deletedPaths.has(path) || entry.deleted) continue;
    if (!byFile.has(path)) {
      byFile.set(path, { path, symbols: [], tests: [], manifests: [] });
      fileOrder.push(path);
    }
  }
  for (const { source } of selectedSymbols) {
    if (deletedPaths.has(source) || byFile.has(source)) continue;
    byFile.set(source, { path: source, symbols: [], tests: [], manifests: [] });
    fileOrder.push(source);
  }

  const changedIndex = changedLineIndex(anchorFiles, deletedPaths);
  const changedSpecs = [...changedIndex.keys()];
  let referencesTotal = 0;
  let changedTotal = 0;
  const errorsSeen = new Set(result.errors);
  const refsByFile = new Map<string, GrepRow[]>(fileOrder.map((path) => [path, []]));
  for (const { source, name, kind, line } of selectedSymbols) {
    if (deletedPaths.has(source)) continue;
    const symbolOutput: RelatedSymbol = { name, references: [] };
    const remaining = maxReferences - referencesTotal;
    if (remaining <= 0) {
      // Later anchors are not searched once the global budget is spent;
      // make that omission visible instead of reporting a false negative.
      result.truncated = true;
      result.truncation.truncated = true;
      if (!result.truncation.reasons.includes("reference_cap")) result.truncation.reasons.push("reference_cap");
      result.truncation.omittedReferences += 1;
    }
    let hits: GrepRow[] = [];
    let additionalHit = false;
    let grepError: string | null = null;
    if (remaining > 0 && maxReferencesPerSymbol > 0 && trackedError === null) {
      const grep = await gitGrepReferences(name, workspace, {
        excludedPaths: changedPathsSet,
        timeoutSec: timeout,
        maxHits: Math.min(maxReferencesPerSymbol, Math.max(remaining, 1)),
      });
      hits = grep.rows;
      additionalHit = grep.extraHit;
      grepError = grep.error;
    }
    if (grepError !== null && !errorsSeen.has(grepError)) {
      result.errors.push(grepError);
      errorsSeen.add(grepError);
    }
    const filtered = hits.slice(0, Math.min(maxReferencesPerSymbol, Math.max(remaining, 0)));
    let omitted = additionalHit ? 1 : 0;
    if (hits.length > filtered.length) omitted += hits.length - filtered.length;
    if (omitted) {
      result.truncated = true;
      result.truncation.truncated = true;
      if (!result.truncation.reasons.includes("reference_cap")) result.truncation.reasons.push("reference_cap");
      result.truncation.omittedReferences += omitted;
    }

    symbolOutput.references = filtered;
    referencesTotal += filtered.length;

    const enclosing = kind === "enclosing";
    const unreferenced = remaining > 0 && filtered.length === 0 && omitted === 0 && grepError === null;
    if (changedIndex.size > 0 && trackedError === null && (enclosing || unreferenced)) {
      const declLine = lineNumber(line);
      const keep = (row: GrepRow): boolean => {
        const ranges = changedIndex.get(row.path);
        if (ranges === undefined) return false;
        if (row.path === source && row.line === declLine) return false;
        return !ranges.some(([start, end]) => start <= row.line && row.line <= end);
      };
      let cap = 1;
      if (enclosing) {
        cap = Math.min(maxChangedReferencesPerSymbol, maxChangedReferences - changedTotal);
        if (cap <= 0) noteReferenceCap(result, 1);
      }
      let changedHits: GrepRow[] = [];
      let changedExtra = false;
      let changedError: string | null = null;
      if (cap > 0) {
        const grep = await changedFileReferences(name, workspace, changedSpecs, keep, cap, timeout);
        changedHits = grep.rows;
        changedExtra = grep.extraHit;
        changedError = grep.error;
      }
      if (changedError !== null && !errorsSeen.has(changedError)) {
        result.errors.push(changedError);
        errorsSeen.add(changedError);
      }
      if (enclosing) {
        for (const row of changedHits) row.changedFile = true;
        symbolOutput.references = [...filtered, ...changedHits];
        changedTotal += changedHits.length;
        if (changedExtra) noteReferenceCap(result, 1);
      } else if (changedHits.length > 0 || changedExtra) {
        symbolOutput.onlyInChangedFiles = true;
      }
    }

    (byFile.get(source) as RelatedFile).symbols.push(symbolOutput);
    (refsByFile.get(source) as GrepRow[]).push(...filtered);
  }

  for (const path of fileOrder) {
    const file = byFile.get(path) as RelatedFile;
    let tests = discoverTests(path, tracked, refsByFile.get(path) ?? [], changedPathsSet);
    if (tests.length > maxTestsPerFile) {
      result.truncated = true;
      result.truncation.truncated = true;
      if (!result.truncation.reasons.includes("test_cap")) result.truncation.reasons.push("test_cap");
      result.truncation.omittedTests += tests.length - maxTestsPerFile;
      tests = tests.slice(0, maxTestsPerFile);
    }
    file.tests = tests;
    const [manifests, omittedManifests] = discoverManifests(path, trackedSet);
    file.manifests = manifests;
    if (omittedManifests) {
      result.truncated = true;
      result.truncation.truncated = true;
      if (!result.truncation.reasons.includes("manifest_cap")) result.truncation.reasons.push("manifest_cap");
      result.truncation.omittedManifests += omittedManifests;
    }
  }

  result.files = fileOrder.map((path) => byFile.get(path) as RelatedFile);
  const keys = anchorKeys(anchorFiles, deletedPaths);
  if (keys.length > 0 && trackedError === null) {
    const consumers = await buildConsumers(result, keys, workspace, changedPathsSet, changedIndex, timeout, errorsSeen, {
      perKey: maxConsumersPerKey,
      total: maxConsumers,
      changedPerKey: maxChangedConsumersPerKey,
      changedTotal: maxChangedConsumers,
    });
    if (consumers.length > 0) result.consumers = consumers;
  }
  const counterpartItems = anchorCounterparts(anchorFiles, deletedPaths);
  if (counterpartItems.length > 0 && trackedError === null) {
    const counterparts = buildCounterparts(result, counterpartItems, workspace, trackedSet, maxCounterparts);
    if (counterparts.length > 0) result.counterparts = counterparts;
  }
  if (result.errors.length > 0) {
    result.truncated = true;
    result.truncation.truncated = true;
    if (!result.truncation.reasons.includes("git_error")) result.truncation.reasons.push("git_error");
  }
  result.truncation.truncated = result.truncated;
  return result;
}

// ---------------------------------------------------------------------------
// Artifact serialization (#669 camelCase → snake_case boundary)
// ---------------------------------------------------------------------------

export function relatedContextToArtifact(related: RelatedContext): Record<string, unknown> {
  return {
    version: related.version,
    files: related.files.map((file) => ({
      path: file.path,
      symbols: file.symbols.map((symbol) => ({
        name: symbol.name,
        references: symbol.references.map((reference) => ({
          path: reference.path,
          line: reference.line,
          snippet: reference.snippet,
          ...(reference.changedFile === true ? { changed_file: true } : {}),
        })),
        ...(symbol.onlyInChangedFiles === true ? { only_in_changed_files: true } : {}),
      })),
      tests: [...file.tests],
      manifests: [...file.manifests],
    })),
    truncated: related.truncated,
    errors: [...related.errors],
    truncation: {
      truncated: related.truncation.truncated,
      reasons: [...related.truncation.reasons],
      omitted_symbols: related.truncation.omittedSymbols,
      omitted_references: related.truncation.omittedReferences,
      omitted_tests: related.truncation.omittedTests,
      omitted_manifests: related.truncation.omittedManifests,
      omitted_output_bytes: related.truncation.omittedOutputBytes,
    },
    ...(related.consumers !== undefined
      ? {
          consumers: related.consumers.map((consumer) => ({
            key: consumer.key,
            kind: consumer.kind,
            source: consumer.source,
            line: consumer.line,
            references: consumer.references.map((reference) => ({
              path: reference.path,
              line: reference.line,
              ...(reference.changedFile === true ? { changed_file: true } : {}),
              ...(reference.match !== undefined ? { match: reference.match } : {}),
              ...(reference.lines !== undefined ? { start: reference.start, lines: [...reference.lines] } : { snippet: reference.snippet }),
            })),
          })),
        }
      : {}),
    ...(related.counterparts !== undefined
      ? {
          counterparts: related.counterparts.map((item) => ({
            path: item.path,
            name: item.name,
            line: item.line,
            ref_path: item.refPath,
            ref_name: item.refName,
            ref_line: item.refLine,
            ...(item.refChanged === true ? { ref_changed: true } : {}),
            lines: [...item.lines],
            ...(item.linesTruncated === true ? { lines_truncated: true } : {}),
          })),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// JSON rendering with the structural byte cap
// ---------------------------------------------------------------------------

function jsonDump(value: unknown, indent: number): string {
  return `${pyJsonDump(value, Math.min(Math.max(0, Math.trunc(indent)), 8))}\n`;
}

function markJsonCap(related: Record<string, unknown>): void {
  related.truncated = true;
  let truncation = related.truncation;
  if (truncation === null || typeof truncation !== "object" || Array.isArray(truncation)) {
    truncation = {};
    related.truncation = truncation;
  }
  const trunc = truncation as Record<string, unknown>;
  trunc.truncated = true;
  let reasons = trunc.reasons;
  if (!Array.isArray(reasons)) {
    reasons = [];
    trunc.reasons = reasons;
  }
  if (!(reasons as unknown[]).includes("json_cap")) (reasons as unknown[]).push("json_cap");
  if (!("omitted_output_bytes" in trunc)) trunc.omitted_output_bytes = 0;
}

function dropListTails(value: unknown): boolean {
  let changed = false;
  if (Array.isArray(value)) {
    if (value.length > 1) {
      value.splice(Math.trunc((value.length + 1) / 2));
      changed = true;
    }
    for (const item of value) changed = dropListTails(item) || changed;
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) changed = dropListTails(item) || changed;
  }
  return changed;
}

function minimalJsonArtifact(source: Record<string, unknown>): Record<string, unknown> {
  const originalTruncation = source.truncation;
  const truncation: Record<string, unknown> = {
    truncated: true,
    reasons: ["json_cap"],
    omitted_output_bytes: 0,
  };
  if (originalTruncation !== null && typeof originalTruncation === "object" && !Array.isArray(originalTruncation)) {
    const original = originalTruncation as Record<string, unknown>;
    const originalReasons = original.reasons;
    if (Array.isArray(originalReasons)) {
      const reasons = originalReasons.slice(0, 20).map((reason) => charSlice(String(reason), 100));
      if (!reasons.includes("json_cap")) reasons.push("json_cap");
      truncation.reasons = reasons;
    }
    for (const key of ["omitted_symbols", "omitted_references", "omitted_tests", "omitted_manifests"]) {
      const value = original[key];
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) truncation[key] = value;
    }
  }
  let version = source.version ?? ARTIFACT_VERSION;
  if (typeof version === "boolean" || (typeof version !== "number" && typeof version !== "string") || (typeof version === "string" && charCount(version) > 100)) {
    version = ARTIFACT_VERSION;
  }
  const minimal: Record<string, unknown> = {
    version,
    files: [],
    truncated: true,
    errors: [],
    truncation,
  };
  markJsonCap(minimal);
  return minimal;
}

function shrinkJsonValue(value: unknown, limit: number): unknown {
  if (typeof value === "string") return charCount(value) <= limit ? value : charSlice(value, limit - 3) + "...";
  if (Array.isArray(value)) return value.map((item) => shrinkJsonValue(item, limit));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, shrinkJsonValue(item, limit)]));
  }
  return value;
}

/** Render valid JSON within the hard artifact byte limit by dropping data
 * structurally (whole list tails first, then string shrinking, then a
 * minimal artifact) — the omission is always visible in `truncation`. */
export function renderRelatedContextJson(artifact: Record<string, unknown>, indent = 2): string {
  const cap = MAX_JSON_BYTES;
  const originalBytes = utf8Len(jsonDump(artifact, indent));
  void artifact;
  let rendered = jsonDump(artifact, indent);
  if (originalBytes <= cap) return rendered;

  const bounded = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
  markJsonCap(bounded);
  const settle = (candidate: Record<string, unknown>): string | null => {
    const text = jsonDump(candidate, indent);
    if (utf8Len(text) <= cap) {
      candidate.truncation = candidate.truncation ?? {};
      (candidate.truncation as Record<string, unknown>).omitted_output_bytes = Math.max(0, originalBytes - utf8Len(text));
      return jsonDump(candidate, indent);
    }
    return null;
  };

  for (;;) {
    rendered = settle(bounded) ?? rendered;
    if (utf8Len(jsonDump(bounded, indent)) <= cap) return rendered;
    if (!dropListTails(bounded)) break;
  }

  for (const stringLimit of [1000, 300, 100, 30]) {
    const shrunk = shrinkJsonValue(bounded, stringLimit) as Record<string, unknown>;
    markJsonCap(shrunk);
    const text = settle(shrunk);
    if (text !== null) return text;
    Object.assign(bounded, shrunk);
  }

  const minimal = minimalJsonArtifact(JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>);
  const text = jsonDump(minimal, 0);
  (minimal.truncation as Record<string, unknown>).omitted_output_bytes = Math.max(0, originalBytes - utf8Len(text));
  return jsonDump(minimal, 0);
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function positive(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function location(path: unknown, line: unknown): string {
  const rendered = codeSpan(display(toPath(path)));
  const number = positive(line);
  return number ? `${rendered}:${number}` : rendered;
}

function fenced(start: unknown, lines: unknown, indent: string): string[] {
  const first = positive(start) || 1;
  const body = (Array.isArray(lines) ? lines : []).map((text, offset) => `${first + offset}: ${display(redactText(String(text)), MAX_SNIPPET_CHARS)}`);
  let longest = 0;
  for (const text of body) for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${indent}${fence}`, ...body.map((text) => `${indent}${text}`), `${indent}${fence}`];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function renderConsumerLines(artifact: Record<string, unknown>): string[] {
  const consumers = artifact.consumers;
  if (!Array.isArray(consumers) || consumers.length === 0) return [];
  const lines = [
    "## Consumers of Changed Keys",
    "",
    "_Lines that mention a config key, env var, flag, or compared variable from the changed lines, as written or in its kebab/snake/UPPER_SNAKE/INPUT_ form; a compared variable (`branch`) counts only where a line compares or switches on it. Unchanged files come first, then changed files outside the lines the diff shows. Textual matches, not proven consumers._",
    "",
  ];
  for (const consumer of consumers) {
    if (!isRecord(consumer)) continue;
    const key = codeSpan(display(String(consumer.key ?? "")));
    const kind = display(String(consumer.kind ?? ""), 20);
    lines.push(`- ${key} (${kind}, ${location(consumer.source, consumer.line)}):`);
    const references = Array.isArray(consumer.references) ? consumer.references : [];
    for (const reference of references) {
      if (!isRecord(reference)) continue;
      const match = reference.match;
      const marker = reference.changed_file === true ? " (changed file)" : "";
      const suffix = typeof match === "string" && match !== "" ? ` as ${codeSpan(display(match))}` : "";
      const loc = `  - ${location(reference.path, reference.line)}${marker}${suffix}`;
      if (Array.isArray(reference.lines)) {
        lines.push(loc);
        lines.push(...fenced(reference.start, reference.lines, "    "));
      } else {
        lines.push(`${loc} — ${codeSpan(display(redactText(String(reference.snippet ?? ""))))}`);
      }
    }
  }
  lines.push("");
  return lines;
}

function renderCounterpartLines(artifact: Record<string, unknown>): string[] {
  const counterparts = artifact.counterparts;
  if (!Array.isArray(counterparts) || counterparts.length === 0) return [];
  const lines = [
    "## Referenced Counterparts",
    "",
    "_Declarations in repository files that added lines name, matched to the changed file's declarations by normalized name (e.g. `buildPrMetadata` and `_build_pr_metadata`). Bodies are bounded._",
    "",
  ];
  for (const item of counterparts) {
    if (!isRecord(item)) continue;
    const ref = `${location(item.ref_path, item.ref_line)} ${codeSpan(display(String(item.ref_name ?? "")))}`;
    const own = `${codeSpan(display(String(item.name ?? "")))} in ${location(item.path, item.line)}`;
    const notes = item.ref_changed === true ? " (also changed in this PR)" : "";
    lines.push(`- ${ref} for ${own}${notes}:`);
    lines.push(...fenced(item.ref_line, item.lines, "  "));
    if (item.lines_truncated === true) lines.push(`  _(body cut at ${MAX_COUNTERPART_LINES} lines)_`);
  }
  lines.push("");
  return lines;
}

function renderLines(artifact: Record<string, unknown>): string[] {
  const version = typeof artifact.version === "number" || typeof artifact.version === "string" ? artifact.version : ARTIFACT_VERSION;
  const lines = [
    `# Related Code (v${version})`,
    "",
    "_Deterministic bounded textual references, test candidates, and nearest manifests. References are textual matches, not proven runtime callers._",
    "",
    ...renderConsumerLines(artifact),
    ...renderCounterpartLines(artifact),
    "## Changed Files",
    "",
  ];
  const files = Array.isArray(artifact.files) ? (artifact.files as Record<string, unknown>[]) : [];
  if (files.length === 0) lines.push("_(none)_");
  for (const file of files) {
    const path = display(toPath(file.path));
    lines.push(`### ${codeSpan(path)}`);
    lines.push("");
    const symbols = Array.isArray(file.symbols) ? (file.symbols as Record<string, unknown>[]) : [];
    if (symbols.length > 0) {
      for (const symbol of symbols) {
        const name = display(String(symbol.name ?? ""));
        const refs = Array.isArray(symbol.references) ? (symbol.references as Record<string, unknown>[]) : [];
        if (refs.length === 0 && symbol.only_in_changed_files === true) {
          lines.push(`- ${codeSpan(name)}: references only in changed files`);
        } else if (refs.length === 0) {
          lines.push(`- ${codeSpan(name)}: no references`);
        } else {
          lines.push(`- ${codeSpan(name)} references:`);
          for (const reference of refs) {
            const refPath = codeSpan(display(toPath(reference.path ?? "")));
            let line = reference.line;
            if (typeof line !== "number" || !Number.isInteger(line) || line < 0) line = 0;
            const snippet = codeSpan(display(redactText(String(reference.snippet ?? ""))));
            const marker = reference.changed_file === true ? " (changed file)" : "";
            lines.push(`  - ${refPath}:${line}${marker} — ${snippet}`);
          }
        }
      }
    } else {
      lines.push("- Symbols: none");
    }
    const tests = Array.isArray(file.tests) ? (file.tests as unknown[]) : [];
    if (tests.length > 0) {
      lines.push(`- Tests: ${tests.map((path) => codeSpan(display(String(path)))).join(", ")}`);
    } else {
      lines.push("- Tests: none");
    }
    const manifests = Array.isArray(file.manifests) ? (file.manifests as unknown[]) : [];
    if (manifests.length > 0) {
      lines.push(`- Manifests (nearest first): ${manifests.map((path) => codeSpan(display(String(path)))).join(", ")}`);
    } else {
      lines.push("- Manifests: none");
    }
    lines.push("");
  }
  const errors = Array.isArray(artifact.errors) ? (artifact.errors as unknown[]) : [];
  if (errors.length > 0) {
    lines.push("## Scanner Errors");
    lines.push("");
    for (const error of errors) lines.push(`- ${codeSpan(display(String(error)))}`);
    lines.push("");
  }
  const truncation = (artifact.truncation ?? {}) as Record<string, unknown>;
  if (artifact.truncated === true || truncation.truncated === true) {
    const rawReasons: unknown[] = Array.isArray(truncation.reasons) ? (truncation.reasons as unknown[]) : [];
    const reasons = rawReasons.map((reason) => String(reason)).join(", ");
    lines.push("## Bounds");
    lines.push("");
    lines.push(`_Output is bounded and incomplete (${display(reasons || "cap reached")})._`);
  }
  return lines;
}

/** Render a compact line-bounded Markdown artifact with safe code spans. */
/** Length of the longest prefix of `lines` that does not end inside a fenced
 * code block, so a cut never leaves a fence open over what follows: port of
 * `related_context.fence_safe_length`. */
export function fenceSafeLength(lines: readonly string[]): number {
  let safe = 0;
  let fence = "";
  lines.forEach((line, index) => {
    const stripped = line.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
    if (fence !== "") {
      if (stripped.length >= fence.length && stripped === (fence[0] as string).repeat(stripped.length)) fence = "";
    } else {
      const match = FENCE_OPEN_RE.exec(line);
      if (match) fence = match[1] as string;
    }
    if (fence === "") safe = index + 1;
  });
  return safe;
}

export function renderRelatedContextMarkdown(artifact: Record<string, unknown>, maxMarkdownBytes: number | null = MAX_MARKDOWN_BYTES): string {
  const lines = renderLines(artifact);
  const full = `${lines.join("\n")}\n`;
  if (maxMarkdownBytes === null) return full;
  const cap = Math.max(1, Math.trunc(maxMarkdownBytes));
  if (utf8Len(full) <= cap) return full;
  const note = `_Markdown output cut at the ${cap}-byte cap._`;
  const chosen: string[] = [];
  let used = 0;
  const noteBytes = utf8Len(`${note}\n`);
  for (const line of lines) {
    const lineBytes = utf8Len(`${line}\n`);
    if (used + lineBytes + noteBytes > cap) break;
    chosen.push(line);
    used += lineBytes;
  }
  chosen.splice(fenceSafeLength(chosen));
  if (chosen.length === 0) return "\n";
  return `${[...chosen, note].join("\n")}\n`;
}

export const CLIP_MARKER = "[related-code context truncated]\n";

/** Port of `clip_markdown` (`python3 -m pr_reviewer.related_context --clip`,
 * the corpus.sh truncation step): cut to whole lines so the kept text plus
 * `marker` fits `maxBytes`, then drop any fenced block the cut would split.
 * v2 decodes with `surrogateescape`, so every line's size is its raw byte
 * count; this works on the raw bytes directly and decodes only to find
 * fences (which are ASCII). Text within the cap is returned unchanged. */
export function clipMarkdown(data: Uint8Array, maxBytes: number, marker = CLIP_MARKER): Uint8Array {
  if (data.length <= maxBytes) return data;
  const markerBytes = Buffer.from(marker, "utf8");
  const budget = maxBytes - markerBytes.length;
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] === 0x0a) {
      lines.push(data.subarray(start, i + 1));
      start = i + 1;
    }
  }
  lines.push(data.subarray(start));
  const kept: Uint8Array[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > budget) break;
    kept.push(line);
    used += line.length;
  }
  const safe = fenceSafeLength(kept.map((line) => Buffer.from(line).toString("utf8")));
  return new Uint8Array(Buffer.concat([...kept.slice(0, safe), markerBytes]));
}

/** corpus.sh `build_related_code_context`'s clip step: `null` is the CLI's
 * failure exit (a non-positive `--max-bytes`), after which v2 empties every
 * related-code artifact. */
export function clipRelatedCodeMarkdown(markdown: Uint8Array, maxBytes: number): Uint8Array | null {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) return null;
  return clipMarkdown(markdown, maxBytes);
}
