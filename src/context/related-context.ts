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
 * cap) and Markdown renderers are byte-exact ports. */

import { spawn } from "node:child_process";
import { maskSecrets } from "./redact.js";
import { pyJsonDump } from "./py-json.js";

export const ARTIFACT_VERSION = 1;
export const MAX_SYMBOLS = 40;
export const MAX_REFERENCES_PER_SYMBOL = 20;
export const MAX_REFERENCES = 200;
export const MAX_TESTS_PER_FILE = 20;
export const MAX_MANIFESTS_PER_FILE = 20;
export const MAX_SNIPPET_CHARS = 300;
export const DEFAULT_GIT_TIMEOUT_SEC = 10;
export const MAX_JSON_BYTES = 100_000;
export const MAX_MARKDOWN_BYTES = 100_000;
export const MAX_ERROR_CHARS = 300;

const CONTROL_RE = /[\x00-\x1f\x7f]/g;
const TEST_BASE_RE = /^(?:test[-_].+|.+[_-]tests?\..+|.+\.(?:test|spec)(?:\.[^.]+)?|.+_test\.go)$/i;
const MANIFEST_BASE_RE = /^(?:pyproject\.toml|setup\.(?:py|cfg)|requirements[^/]*\.txt|package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|go\.(?:mod|sum)|Cargo\.(?:toml|lock)|Gemfile(?:\.lock)?|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|Pipfile(?:\.lock)?|poetry\.lock|uv\.lock|mix\.(?:exs|lock)|Dockerfile[^/]*|action\.ya?ml)$/i;
const GREP_ROW_RE = /^(.*?):([0-9]+):(.*)$/;

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

function boundedText(value: unknown, limit: number = MAX_ERROR_CHARS): string {
  let text = maskSecrets(String(value ?? "")).replace("\u0000", "\\u0000");
  text = escapeControls(text);
  if (text.length > limit) return text.slice(0, Math.max(0, limit - 3)) + "...";
  return text;
}

function display(value: string, limit = 200): string {
  const text = escapeControls(value);
  if (text.length > limit) return text.slice(0, Math.max(0, limit - 1)) + "...";
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
}

function snippetOf(value: string): string {
  let text = maskSecrets(value);
  text = escapeControls(text);
  if (text.length > MAX_SNIPPET_CHARS) return text.slice(0, MAX_SNIPPET_CHARS - 3) + "...";
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
 * vocabulary. */
export function gitGrepReferences(
  symbol: string,
  workspace: string,
  options: { excludedPaths: Set<string>; timeoutSec?: number; maxHits?: number },
): Promise<GrepResult> {
  const limit = Math.max(0, Math.trunc(options.maxHits ?? MAX_REFERENCES_PER_SYMBOL));
  const { excludedPaths, timeoutSec = DEFAULT_GIT_TIMEOUT_SEC } = options;
  if (limit === 0) return Promise.resolve({ rows: [], extraHit: false, error: null });

  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["grep", "-n", "-F", "--", symbol, "--", "."], {
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
        if (typeof name === "string" && name !== "") symbols.push({ source, name });
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
      if (source !== "" && typeof name === "string" && name !== "") symbols.push({ source, name });
    }
  }
  return symbols;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface RelatedSymbol {
  name: string;
  references: GrepRow[];
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

export interface RelatedContext {
  version: number;
  files: RelatedFile[];
  truncated: boolean;
  errors: string[];
  truncation: RelatedTruncation;
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

  let referencesTotal = 0;
  const errorsSeen = new Set(result.errors);
  const refsByFile = new Map<string, GrepRow[]>(fileOrder.map((path) => [path, []]));
  for (const { source, name } of selectedSymbols) {
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
        })),
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
      const reasons = originalReasons.slice(0, 20).map((reason) => String(reason).slice(0, 100));
      if (!reasons.includes("json_cap")) reasons.push("json_cap");
      truncation.reasons = reasons;
    }
    for (const key of ["omitted_symbols", "omitted_references", "omitted_tests", "omitted_manifests"]) {
      const value = original[key];
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) truncation[key] = value;
    }
  }
  let version = source.version ?? ARTIFACT_VERSION;
  if (typeof version === "boolean" || (typeof version !== "number" && typeof version !== "string") || (typeof version === "string" && version.length > 100)) {
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
  if (typeof value === "string") return value.length <= limit ? value : value.slice(0, Math.max(0, limit - 3)) + "...";
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

function renderLines(artifact: Record<string, unknown>): string[] {
  const version = typeof artifact.version === "number" || typeof artifact.version === "string" ? artifact.version : ARTIFACT_VERSION;
  const lines = [
    `# Related Code (v${version})`,
    "",
    "_Deterministic bounded textual references, test candidates, and nearest manifests. References are textual matches, not proven runtime callers._",
    "",
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
        if (refs.length === 0) {
          lines.push(`- ${codeSpan(name)}: no references`);
        } else {
          lines.push(`- ${codeSpan(name)} references:`);
          for (const reference of refs) {
            const refPath = codeSpan(display(toPath(reference.path ?? "")));
            let line = reference.line;
            if (typeof line !== "number" || !Number.isInteger(line) || line < 0) line = 0;
            const snippet = codeSpan(display(maskSecrets(String(reference.snippet ?? ""))));
            lines.push(`  - ${refPath}:${line} — ${snippet}`);
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
  if (chosen.length === 0) return "\n";
  return `${[...chosen, note].join("\n")}\n`;
}
