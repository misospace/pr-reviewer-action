/** The syntax-aware context builder (#764, phase 1).
 *
 * The builder owns everything the provider deliberately does not: candidate
 * discovery, budgets, provenance, filtering, truncation and fallback. It
 * answers three questions about a change:
 *   1. which whole declarations does the diff touch (not just the hunk)?
 *   2. where are the definitions of the identifiers the changed lines
 *      reference?
 *   3. who calls the declarations the diff touched?
 *
 * The builder is EVIDENCE, never authority: it produces no finding, no
 * severity, no policy and no verdict, and a caller decides what to do with
 * what it reads.
 *
 * Three invariants shape the whole module:
 *   - IT NEVER THROWS. A malformed anchor artifact, an unreadable file, a
 *     provider that throws — each degrades the stage (an `errors` entry, or
 *     fewer items) and never escapes as an exception. The caller (a later
 *     phase) decides what a degraded stage means.
 *   - EVERY SNIPPET CARRIES PROVENANCE. The text is read from the WORKING
 *     TREE, so no revision is bound (`revision: null`): binding one would
 *     claim a byte-identity the read never established — the same rule and
 *     the same reason as the related-code stage (`docs/architecture/
 *     source-evidence-provenance.md`). The PR head SHA is recorded ONCE, at
 *     artifact level, as `head_revision`.
 *   - THE WORK IS BOUNDED IN BYTES, ITEMS **AND TIME**. The artifact caps
 *     bound the OUTPUT; they never bounded the WORK, and the work was
 *     quadratic in the declaration count (a file with tens of thousands of
 *     declarations took tens of seconds; with the candidate-file cap that
 *     is minutes per review). Every collection loop is therefore bounded
 *     by a per-item cap, an index instead of a rescan, and a wall-clock
 *     deadline; the candidate phase holds ONE file at a time, so its
 *     memory does not grow with the repository either. */

import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { DeadlineBudget, type Clock } from "../budget.js";
import { detectLanguage, readHeadLines } from "../change-anchors.js";
import { sourceEvidence } from "../redact.js";
import { untrustedTextProvenance, type EvidenceProvenance } from "../evidence-provenance.js";
import { DEFAULT_GIT_TIMEOUT_SEC, listTrackedFiles } from "../repo-map.js";
import { isSupportedLanguage } from "./grammar.js";
import { resolveSyntaxProvider } from "./registry.js";
import type { SyntaxDeclaration, SyntaxDeclarationKind, SyntaxFile, SyntaxProvider, SyntaxUsage } from "./types.js";

/** The artifact version of the syntax context. */
export const SYNTAX_CONTEXT_ARTIFACT_VERSION = "1";

/** Hard caps. The total item budget is the value that bites first: the
 * per-category budgets only matter when one category alone exceeds it. */
export const MAX_SYNTAX_ITEMS = 40;
export const MAX_SYNTAX_BYTES = 100_000;
export const MAX_SYNTAX_CANDIDATE_FILES = 200;

/** The declarations a provider may report for ONE file.
 *
 * The declaration list drives the builder's own work (scope resolution, the
 * definition lookup, the caller search), so an unbounded list is a time
 * blowup: the previous implementation scanned every declaration against
 * every other declaration of the same file (O(n²) per file) and measured
 * 30 s on a single file with 130,000 declarations. The list is cut to this
 * cap and the cut is VISIBLE (a note plus `truncated`). */
export const MAX_SYNTAX_DECLARATIONS_PER_FILE = 2_000;

/** The identifiers kept for ONE changed line. A changed line is normally a
 * handful of identifiers; a minified or generated line can carry thousands,
 * and each of them would be a definition lookup. */
export const MAX_SYNTAX_IDENTIFIERS_PER_LINE = 50;

/** The referenced identifiers tracked in TOTAL. The referenced map is the
 * input of the definition lookup, so it is bounded like every other
 * collection. */
export const MAX_SYNTAX_REFERENCED_TOTAL = 2_000;

/** The wall-clock bound of ONE build, in seconds.
 *
 * A MODULE CONSTANT on purpose: the bound must not be widenable by
 * configuration (an operator input or an environment variable), because a
 * stage that can be told to spend minutes of runner time is a stage that
 * can stall a review. The bound is enforced with the repository's own
 * `DeadlineBudget` (a monotonic clock), and expiry is NOT fatal: the
 * collection stops, what was collected stays, and the artifact says the
 * result is incomplete. */
export const MAX_SYNTAX_SECONDS = 20;

/** The changed-file content retained IN TOTAL, in characters.
 *
 * The changed-file list is bounded by the anchor extractor's own file cap
 * (100 files) and each file is read through the safe reader's 2 MB cap, so
 * the retained content could reach hundreds of megabytes before anything
 * else bounded it. The stage needs the changed files' DECLARATIONS, not
 * their bulk: a few megabytes of source is ample. Past this budget the
 * remaining changed files are skipped, visibly. */
export const MAX_SYNTAX_CHANGED_FILE_CHARS = 8_000_000;

/** Per-item bounds: a declaration body is a BODY, not the file, and a caller
 * snippet is a line. */
export const MAX_SYNTAX_BODY_CHARS = 2_000;
export const MAX_SYNTAX_BODY_LINES = 120;
export const MAX_SYNTAX_SNIPPET_CHARS = 300;

/** Bounds on the bookkeeping itself. */
export const MAX_SYNTAX_ERRORS = 20;
export const MAX_SYNTAX_NOTES = 10;
export const MAX_SYNTAX_CHANGED_RANGES = 200;
/** The changed lines scanned for ONE changed file. */
export const MAX_SYNTAX_CHANGED_LINES = 500;
/** The changed lines scanned for ONE build, across every changed file. The
 * per-file cap alone would allow the anchor extractor's own file cap (100)
 * times that many lines, so the total work is bounded here too. */
export const MAX_SYNTAX_CHANGED_LINES_TOTAL = 5_000;

/** How many provider failures are tolerated before the provider is treated
 * as broken for the rest of the build (a provider that throws on every call
 * must not turn the build into an error loop). */
export const MAX_SYNTAX_PROVIDER_FAILURES = 5;

/** The workspace directories whose contents are generated or vendored: a
 * declaration found in them is not repository source. */
const GENERATED_DIRS: ReadonlySet<string> = new Set(["dist", "build", "vendor", "node_modules", "third_party"]);

/** How many directories the candidate walk may visit. */
const MAX_WALK_DIRECTORIES = 2_000;

/** The marker that replaces the last note when the note list overflows. */
const NOTE_OVERFLOW = `further notes dropped (limit ${MAX_SYNTAX_NOTES})`;

/** The reasons the collection can end early: WHICH bound ended it. */
const TRUNCATION_REASON_DEADLINE = "deadline";
const TRUNCATION_REASON_DECLARATION_CAP = "declaration cap";
const TRUNCATION_REASON_IDENTIFIER_CAP = "identifier cap";
const TRUNCATION_REASON_CHANGED_LINE_CAP = "changed-line cap";
const TRUNCATION_REASON_CANDIDATE_CAP = "candidate cap";
const TRUNCATION_REASON_ITEM_CAP = "item cap";
const TRUNCATION_REASON_BYTE_CAP = "byte cap";
const TRUNCATION_REASON_CHANGED_FILE_BUDGET = "changed-file content budget";

export interface SyntaxContextOptions {
  /** Workspace root (absolute). */
  workspace: string;
  /** The change-anchor artifact (persisted snake_case shape). */
  anchors: unknown;
  /** Provider to use; when omitted the registry resolves the default. */
  provider?: SyntaxProvider;
  /** Whether the provider handed in was a FALLBACK for an unknown id.
   * A caller that resolved the provider itself (the stage does) carries the
   * registry's outcome here; the builder cannot know it. Default false. */
  providerFallback?: boolean;
  /** Why the fallback happened (null when there was none). Default null. */
  providerFallbackReason?: string | null;
  /** PR head SHA recorded at artifact level (may be null). */
  headRevision?: string | null;
  /** Hard caps. Defaults are the module constants. */
  maxItems?: number;
  maxBytes?: number;
  maxCandidateFiles?: number;
  /** The monotonic clock the wall-clock bound is measured against. The
   * BOUND itself is the module constant and cannot be widened here; this
   * only makes the clock injectable so a test can drive expiry
   * deterministically. */
  monotonic?: Clock;
}

/** One declaration the diff touches, with its bounded body. */
export interface SyntaxContextDeclaration {
  path: string;
  name: string;
  kind: SyntaxDeclarationKind;
  startLine: number;
  endLine: number;
  confidence: "high" | "medium";
  /** True when the declaration's extent overlaps a changed line range. */
  changed: boolean;
  body: string;
  bodyTruncated: boolean;
  provenance: EvidenceProvenance;
}

/** A changed line that referenced a name. */
export interface SyntaxContextReference {
  path: string;
  line: number;
}

/** Where an identifier referenced on a changed line is defined. */
export interface SyntaxContextDefinition {
  name: string;
  path: string;
  line: number;
  kind: SyntaxDeclarationKind;
  referencedFrom: SyntaxContextReference[];
  provenance: EvidenceProvenance;
}

/** The declaration a call site calls. */
export interface SyntaxContextCallerDeclaration {
  path: string;
  line: number;
}

/** A call site of a declaration the diff touched. */
export interface SyntaxContextCaller {
  name: string;
  path: string;
  line: number;
  usage: SyntaxUsage;
  declaration: SyntaxContextCallerDeclaration;
  snippet: string;
  provenance: EvidenceProvenance;
}

export interface SyntaxContext {
  artifactVersion: string;
  headRevision: string | null;
  providerId: string;
  providerFallback: boolean;
  providerFallbackReason: string | null;
  /** Declarations touched by the diff, with bounded bodies. */
  declarations: SyntaxContextDeclaration[];
  /** Definitions of identifiers referenced on changed lines. */
  definitions: SyntaxContextDefinition[];
  /** Callers of declarations touched by the diff. */
  callers: SyntaxContextCaller[];
  /** True when any hard cap dropped content. */
  truncated: boolean;
  /** WHICH bound ended the collection ("item cap", "byte cap",
   * "deadline", …), or null when nothing was dropped. */
  truncatedReason: string | null;
  /** Bounded NON-fatal observations (an unreadable changed file that was
   * skipped, a candidate listing that was not git-backed, a cap that
   * bit). An entry here never invalidates the section. */
  notes: string[];
  /** FATAL problems only (a provider that failed, a malformed anchor
   * artifact). A non-empty list means the stage degraded. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Bounded error list: a degraded stage must not grow the artifact without
 * limit. */
function pushError(errors: string[], message: string): void {
  if (errors.length >= MAX_SYNTAX_ERRORS) return;
  errors.push(message.length > 300 ? `${message.slice(0, 297)}...` : message);
}

/** The provider call seam of one build: it counts failures and stops
 * calling a provider that keeps throwing, so a broken provider degrades the
 * stage instead of stalling it. */
interface ProviderCalls {
  <T>(label: string, call: () => T, fallback: T): T;
}

function providerCalls(errors: string[]): ProviderCalls {
  let failures = 0;
  let disabled = false;
  return <T,>(label: string, call: () => T, fallback: T): T => {
    if (disabled) return fallback;
    try {
      return call();
    } catch (error) {
      failures += 1;
      pushError(errors, `${label}: ${messageOf(error)}`);
      if (failures > MAX_SYNTAX_PROVIDER_FAILURES) {
        disabled = true;
        pushError(errors, "syntax provider disabled after repeated failures");
      }
      return fallback;
    }
  };
}

function emptyContext(): SyntaxContext {
  return {
    artifactVersion: SYNTAX_CONTEXT_ARTIFACT_VERSION,
    headRevision: null,
    providerId: "",
    providerFallback: false,
    providerFallbackReason: null,
    declarations: [],
    definitions: [],
    callers: [],
    truncated: false,
    truncatedReason: null,
    notes: [],
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// The build state: the artifact under construction and the wall-clock bound
// ---------------------------------------------------------------------------

interface Build {
  context: SyntaxContext;
  deadline: DeadlineBudget;
}

/** Record that a bound ended the collection. The FIRST bound to bite is the
 * one that ended it, so the reason stays meaningful when several bounds
 * apply at once; the wall-clock deadline reports itself instead, because
 * it is the bound that actually stopped the work. */
function markTruncated(build: Build, reason: string): void {
  build.context.truncated = true;
  if (build.context.truncatedReason === null) build.context.truncatedReason = reason;
}

/** A bounded, non-fatal observation. The list never grows without limit:
 * the last slot becomes an overflow marker, so a dropped note is visible
 * rather than silent. */
function pushNote(build: Build, message: string): void {
  const notes = build.context.notes;
  const text = message.length > 300 ? `${message.slice(0, 297)}...` : message;
  if (notes.length < MAX_SYNTAX_NOTES) {
    notes.push(text);
    return;
  }
  notes[MAX_SYNTAX_NOTES - 1] = NOTE_OVERFLOW;
}

/** The wall-clock bound expired: stop collecting, keep what was collected,
 * and say so. Expiry is NOT a failure — the partial result stands, marked
 * incomplete. The deadline REPORTS itself as the bound that ended the
 * collection: it is the one that actually stopped the work. */
function noteDeadline(build: Build): void {
  build.context.truncated = true;
  build.context.truncatedReason = TRUNCATION_REASON_DEADLINE;
  // Idempotent: the bound is reported ONCE, however many phases noticed it.
  if (build.context.notes.some((note) => note.includes("wall-clock bound"))) return;
  pushNote(build, `wall-clock bound of ${MAX_SYNTAX_SECONDS}s expired; collection stopped early and result incomplete`);
}

// ---------------------------------------------------------------------------
// Anchor artifact (read defensively: it is `unknown` from JSON)
// ---------------------------------------------------------------------------

interface AnchorFile {
  path: string;
  deleted: boolean;
  changedLines: [number, number][];
}

function readAnchorFiles(anchors: unknown, errors: string[]): AnchorFile[] {
  if (!isRecord(anchors)) {
    pushError(errors, "change-anchor artifact is not a JSON object");
    return [];
  }
  const rawFiles = anchors.files;
  if (!Array.isArray(rawFiles)) {
    pushError(errors, "change-anchor artifact has no files array");
    return [];
  }
  const out: AnchorFile[] = [];
  for (const entry of rawFiles) {
    if (!isRecord(entry)) {
      pushError(errors, "change-anchor file entry is not an object");
      continue;
    }
    const path = typeof entry.path === "string" ? entry.path.replaceAll("\\", "/") : "";
    if (path === "") {
      pushError(errors, "change-anchor file entry has no path");
      continue;
    }
    const changedLines: [number, number][] = [];
    const rawRanges = entry.changed_lines;
    if (rawRanges !== undefined && !Array.isArray(rawRanges)) {
      pushError(errors, `change-anchor file has invalid changed_lines: ${path}`);
    } else if (Array.isArray(rawRanges)) {
      for (const range of rawRanges.slice(0, MAX_SYNTAX_CHANGED_RANGES)) {
        if (!Array.isArray(range) || range.length < 2) {
          pushError(errors, `change-anchor file has an invalid changed range: ${path}`);
          continue;
        }
        const start = range[0];
        const end = range[1];
        if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) {
          pushError(errors, `change-anchor file has an invalid changed range: ${path}`);
          continue;
        }
        changedLines.push([Math.trunc(start), Math.trunc(end)]);
      }
    }
    out.push({ path, deleted: entry.deleted === true, changedLines });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candidate discovery (bounded, safe, inside the workspace)
// ---------------------------------------------------------------------------

/** Whether a repository path is a source file a candidate search may read:
 * a supported language, outside the generated/vendor directories. */
function isCandidatePath(path: string): boolean {
  const parts = path.split("/");
  if (parts.slice(0, -1).some((part) => GENERATED_DIRS.has(part))) return false;
  return isSupportedLanguage(detectLanguage(path));
}

/** The repository's candidate files by a RAW FILESYSTEM WALK. The walk
 * never follows a symlink, never leaves the workspace, and never reads a
 * file: it only NAMES them, and the naming is bounded by `limit`.
 *
 * This is the FALLBACK listing: it cannot tell a tracked file from an
 * untracked one (a local virtualenv, build output), so a candidate found
 * this way is untrusted text, never committed source. */
function walkCandidatePaths(workspace: string, limit: number): { paths: string[]; truncated: boolean } {
  if (limit <= 0) return { paths: [], truncated: false };
  const found: string[] = [];
  const pending: string[] = [""];
  let visited = 0;
  let truncated = false;
  while (pending.length > 0 && found.length < limit && visited < MAX_WALK_DIRECTORIES) {
    const relative = pending.pop() as string;
    visited += 1;
    let entries: Dirent[];
    try {
      entries = readdirSync(relative === "" ? workspace : join(workspace, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of sorted) {
      if (entry.isSymbolicLink()) continue;
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        if (GENERATED_DIRS.has(entry.name)) continue;
        pending.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isCandidatePath(child)) continue;
      if (found.length >= limit) {
        truncated = true;
        break;
      }
      found.push(child);
    }
  }
  return { paths: found.sort(), truncated };
}

/** The candidate listing: git-tracked files when the repository can be
 * asked, the filesystem walk when it cannot.
 *
 * `git ls-files` (argv-only, timeout-bounded) makes the candidates tracked
 * files BY CONSTRUCTION, and a tracked file's bytes can be vouched for as
 * repository-committed content. When git cannot answer (no git binary, not
 * a repository, a timeout) the walk stands in — and the candidates it
 * finds are UNTRUSTED text: an untracked file is not repository content
 * and must not be stamped as committed source. */
function listCandidatePaths(workspace: string, limit: number, remainingSeconds: number): { paths: string[]; gitBacked: boolean; truncated: boolean } {
  if (limit <= 0) return { paths: [], gitBacked: false, truncated: false };
  try {
    // The listing is bounded by the build's OWN remaining time, so the
    // subprocess cannot outlive the wall-clock bound the build declares.
    const gitTimeout = Math.max(
      1,
      Math.min(DEFAULT_GIT_TIMEOUT_SEC, MAX_SYNTAX_SECONDS, Math.ceil(remainingSeconds)),
    );
    const tracked = listTrackedFiles(workspace, gitTimeout);
    const paths: string[] = [];
    let truncated = false;
    for (const path of tracked) {
      if (!isCandidatePath(path)) continue;
      if (paths.length >= limit) {
        truncated = true;
        break;
      }
      paths.push(path);
    }
    return { paths: paths.sort(), gitBacked: true, truncated };
  } catch {
    const walked = walkCandidatePaths(workspace, limit);
    return { paths: walked.paths, gitBacked: false, truncated: walked.truncated };
  }
}

/** A candidate file, read through the safe workspace reader. */
interface CandidateFile {
  path: string;
  syntaxFile: SyntaxFile;
  declarations: readonly SyntaxDeclaration[];
  /** The names the file declares at MODULE scope — a file that owns the name
   * at module scope owns a DIFFERENT symbol than the one under review. */
  moduleNames: ReadonlySet<string>;
  /** The declarations indexed by NAME: the definition lookup must not
   * rescan a file's declarations for every referenced name. */
  byName: Map<string, SyntaxDeclaration[]>;
  /** Whether the bytes are vouched for as repository-committed content
   * (a tracked file, or a changed file the diff vouches for). */
  committed: boolean;
  /** The call sites already recorded for THIS file (the key carries the
   * file, so a per-file set is what the de-duplication needs). */
  seenCallers: Set<string>;
}

/** Whether a file is binary at all: a NUL byte ANYWHERE in it. The reader
 * caps the file size (2 MiB), so scanning the whole file stays bounded —
 * and scanning only the first lines let a binary file whose head happens
 * to be NUL-free pass as text and contribute pseudo-declarations. */
function looksBinary(lines: readonly string[]): boolean {
  for (const line of lines) {
    if (line.includes("\u0000")) return true;
  }
  return false;
}

/** The names a file declares at module scope: a declaration no other
 * declaration's extent contains.
 *
 * ONE pass over the declarations, in file order, with a STACK of the
 * declarations still open at the current line: the stack is popped while
 * the top declaration's extent ends before the current one starts. The
 * previous implementation asked every declaration whether any other
 * declaration contained it (O(n²) per file — 30 s on a file with 130,000
 * declarations, and minutes per review with the candidate-file cap).
 *
 * The pass keeps the OLD semantics exactly: a declaration is nested when
 * some declaration STRICTLY contains it. The stack alone answers "does the
 * innermost open declaration contain it"; the running maximum extent of
 * each stack prefix answers the rest ("does an enclosing declaration
 * contain it"), which is what the nested scan used to find. */
function moduleScopeNames(declarations: readonly SyntaxDeclaration[]): Set<string> {
  const names = new Set<string>();
  if (declarations.length === 0) return names;
  const ordered = [...declarations].sort((a, b) => (a.startLine - b.startLine) || (b.endLine - a.endLine));
  const stack: SyntaxDeclaration[] = [];
  // prefixMaxEnd[i]: the largest extent among stack[0..i].
  const prefixMaxEnd: number[] = [];
  // The index of the first stack entry of the current start group.
  let groupStart = 0;
  for (const decl of ordered) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as SyntaxDeclaration;
      if (top.endLine < decl.startLine) {
        stack.pop();
        prefixMaxEnd.pop();
        continue;
      }
      break;
    }
    const top = stack.length > 0 ? (stack[stack.length - 1] as SyntaxDeclaration) : null;
    if (top === null || top.startLine !== decl.startLine) groupStart = stack.length;
    // The largest extent among the declarations that open BEFORE this one.
    const maxEndBefore = groupStart > 0 ? (prefixMaxEnd[groupStart - 1] as number) : Number.NEGATIVE_INFINITY;
    // The largest extent among every open declaration.
    const maxEndOpen = stack.length > 0 ? (prefixMaxEnd[stack.length - 1] as number) : Number.NEGATIVE_INFINITY;
    // Contained: an enclosing declaration reaches at least as far as this
    // one (it opens earlier), or an open declaration reaches further (a
    // wider container at the same line).
    const nested = maxEndBefore >= decl.endLine || maxEndOpen > decl.endLine;
    if (!nested) names.add(decl.name);
    stack.push(decl);
    prefixMaxEnd.push(Math.max(maxEndOpen, decl.endLine));
  }
  return names;
}

/** The declarations of a file, indexed by name. */
function indexByName(declarations: readonly SyntaxDeclaration[]): Map<string, SyntaxDeclaration[]> {
  const index = new Map<string, SyntaxDeclaration[]>();
  for (const decl of declarations) {
    const list = index.get(decl.name);
    if (list === undefined) index.set(decl.name, [decl]);
    else list.push(decl);
  }
  return index;
}

/** The declarations of one file, capped. The provider may report an
 * unbounded list; the list drives the builder's work, so it is cut and the
 * cut is visible. */
function capDeclarations(build: Build, path: string, reported: readonly SyntaxDeclaration[]): readonly SyntaxDeclaration[] {
  if (reported.length <= MAX_SYNTAX_DECLARATIONS_PER_FILE) return reported;
  markTruncated(build, TRUNCATION_REASON_DECLARATION_CAP);
  pushNote(build, `declaration cap hit for ${path}: kept ${MAX_SYNTAX_DECLARATIONS_PER_FILE} of ${reported.length} declarations`);
  return reported.slice(0, MAX_SYNTAX_DECLARATIONS_PER_FILE);
}

/** Read one candidate file: the safe workspace reader refuses absolute
 * paths, `..`, `.git` and symlinks, and returns null instead of throwing. */
function readCandidate(
  build: Build,
  workspace: string,
  path: string,
  provider: SyntaxProvider,
  call: ProviderCalls,
  committed: boolean,
): CandidateFile | null {
  const language = detectLanguage(path);
  if (!isSupportedLanguage(language)) return null;
  const lines = readHeadLines(workspace, path);
  if (lines === null) return null;
  if (looksBinary(lines)) return null;
  const syntaxFile: SyntaxFile = { path, language, lines };
  const reported = call(`declarations:${path}`, () => provider.declarations(syntaxFile), []);
  const declarations = capDeclarations(build, path, reported);
  return {
    path,
    syntaxFile,
    declarations,
    moduleNames: moduleScopeNames(declarations),
    byName: indexByName(declarations),
    committed,
    seenCallers: new Set<string>(),
  };
}

// ---------------------------------------------------------------------------
// Item construction
// ---------------------------------------------------------------------------

/** The redacted text of a source span, with its provenance. The revision is
 * never bound: the bytes come from the working tree.
 *
 * `untrusted` marks a span whose bytes cannot be vouched for as
 * repository-committed content (a candidate from a listing that was not
 * git-backed). Such a span is still redacted, but it carries the
 * `untrusted_text` representation instead of claiming to be committed
 * source. */
function evidenceOf(
  text: string,
  path: string,
  untrusted = false,
): { text: string; provenance: EvidenceProvenance } {
  const source = sourceEvidence(text, path, path, null);
  if (!untrusted) return source;
  return { text: source.text, provenance: untrustedTextProvenance(path, source.provenance.redactionCount) };
}

function overlaps(changedLines: readonly [number, number][], startLine: number, endLine: number): boolean {
  for (const [start, end] of changedLines) {
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    if (startLine <= high && low <= endLine) return true;
  }
  return false;
}

/** The bounded body of a declaration: its own lines, redacted first (so a
 * credential is masked before any truncation can split it) and capped by
 * both characters and lines. */
function declarationBody(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  path: string,
): { body: string; truncated: boolean; provenance: EvidenceProvenance } {
  const slice = lines.slice(Math.max(0, startLine - 1), Math.max(startLine - 1, endLine));
  const capped = slice.length > MAX_SYNTAX_BODY_LINES ? slice.slice(0, MAX_SYNTAX_BODY_LINES) : slice;
  const { text, provenance } = evidenceOf(capped.join("\n"), path);
  if (text.length <= MAX_SYNTAX_BODY_CHARS) return { body: text, truncated: false, provenance };
  return { body: `${text.slice(0, MAX_SYNTAX_BODY_CHARS)}\n[truncated]`, truncated: true, provenance };
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

/** Build the syntax context. Never throws. */
export function buildSyntaxContext(options: SyntaxContextOptions): SyntaxContext {
  const context = emptyContext();
  try {
    return buildInner(options, context);
  } catch (error) {
    const degraded = emptyContext();
    degraded.errors = [messageOf(error)];
    return degraded;
  }
}

interface ChangedFile {
  path: string;
  syntaxFile: SyntaxFile;
  changedLines: [number, number][];
  declarations: readonly SyntaxDeclaration[];
  /** The names the changed file declares itself. */
  declared: Set<string>;
}

/** The changed files, read at the head checkout.
 *
 * An unreadable changed file (too large, a symlink, a refused path) is a
 * PER-FILE SKIP, not a fatal error: one oversized file must not silence
 * the evidence every other changed file carries. It is recorded as a note;
 * only a provider failure or a malformed anchor artifact is fatal. */
function collectChangedFiles(
  build: Build,
  workspace: string,
  anchorFiles: readonly AnchorFile[],
  provider: SyntaxProvider,
  call: ProviderCalls,
): ChangedFile[] {
  const changedFiles: ChangedFile[] = [];
  let retainedChars = 0;
  for (const anchor of anchorFiles) {
    if (anchor.deleted) continue;
    const language = detectLanguage(anchor.path);
    if (!isSupportedLanguage(language)) continue;
    if (build.deadline.exceeded()) {
      noteDeadline(build);
      break;
    }
    const lines = readHeadLines(workspace, anchor.path);
    if (lines === null) {
      pushNote(build, `changed file skipped: not readable at the head checkout (${anchor.path})`);
      continue;
    }
    if (looksBinary(lines)) {
      pushNote(build, `changed file skipped: binary content (${anchor.path})`);
      continue;
    }
    const fileChars = lines.reduce((sum, line) => sum + line.length, 0);
    if (retainedChars + fileChars > MAX_SYNTAX_CHANGED_FILE_CHARS) {
      // The retained changed-file content is bounded: past the budget the
      // remaining files are skipped, visibly, rather than held in memory.
      markTruncated(build, TRUNCATION_REASON_CHANGED_FILE_BUDGET);
      pushNote(
        build,
        `changed file skipped: changed-file content budget of ${MAX_SYNTAX_CHANGED_FILE_CHARS} characters exhausted (${anchor.path})`,
      );
      break;
    }
    retainedChars += fileChars;
    const syntaxFile: SyntaxFile = { path: anchor.path, language, lines };
    const reported = call(`declarations:${anchor.path}`, () => provider.declarations(syntaxFile), []);
    const declarations = capDeclarations(build, anchor.path, reported);
    changedFiles.push({
      path: anchor.path,
      syntaxFile,
      changedLines: anchor.changedLines,
      declarations,
      declared: new Set(declarations.map((decl) => decl.name)),
    });
  }
  return changedFiles;
}

/** The identifiers the changed lines reference, bounded per line and in
 * total. */
function collectReferenced(
  build: Build,
  changedFiles: readonly ChangedFile[],
  provider: SyntaxProvider,
  call: ProviderCalls,
): Map<string, SyntaxContextReference[]> {
  const referenced = new Map<string, SyntaxContextReference[]>();
  let scannedTotal = 0;
  for (const file of changedFiles) {
    const seen = new Set<string>();
    let scanned = 0;
    for (const [start, end] of file.changedLines) {
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      for (let line = low; line <= high; line += 1) {
        if (scanned >= MAX_SYNTAX_CHANGED_LINES || scannedTotal >= MAX_SYNTAX_CHANGED_LINES_TOTAL) {
          markTruncated(build, TRUNCATION_REASON_CHANGED_LINE_CAP);
          break;
        }
        if (build.deadline.exceeded()) {
          noteDeadline(build);
          return referenced;
        }
        scanned += 1;
        scannedTotal += 1;
        const names = call(
          `identifiers:${file.path}:${line}`,
          () => provider.identifiersOnLine(file.syntaxFile, line),
          [],
        );
        let kept = 0;
        for (const name of names) {
          // A name the changed file declares itself is not "referenced" —
          // its definition is right here.
          if (file.declared.has(name)) continue;
          if (seen.has(name)) continue;
          if (kept >= MAX_SYNTAX_IDENTIFIERS_PER_LINE) {
            markTruncated(build, TRUNCATION_REASON_IDENTIFIER_CAP);
            break;
          }
          if (referenced.size >= MAX_SYNTAX_REFERENCED_TOTAL) {
            markTruncated(build, TRUNCATION_REASON_IDENTIFIER_CAP);
            pushNote(build, `referenced identifier cap hit: only ${MAX_SYNTAX_REFERENCED_TOTAL} identifiers are tracked`);
            return referenced;
          }
          seen.add(name);
          kept += 1;
          const refs = referenced.get(name);
          if (refs === undefined) referenced.set(name, [{ path: file.path, line }]);
          else refs.push({ path: file.path, line });
        }
      }
    }
  }
  return referenced;
}

/** The evidence ONE candidate file carries: the definitions of the
 * referenced identifiers it declares, and the call sites of the touched
 * declarations it contains.
 *
 * The work happens WHILE the file is alive and is then released: the
 * provider keeps a parsed form of every file it is handed, so holding a
 * hundred parsed candidates in memory is a memory blowup (a 2 MB file
 * with 100,000 declarations parses to ~100 MB). One candidate at a time
 * keeps the phase bounded in memory as well as in time. */
function collectCandidateEvidence(
  build: Build,
  candidate: CandidateFile,
  referenced: ReadonlyMap<string, SyntaxContextReference[]>,
  targetsByName: ReadonlyMap<string, Array<{ path: string; line: number }>>,
  provider: SyntaxProvider,
  call: ProviderCalls,
): void {
  const context = build.context;

  // The definitions of the referenced identifiers, looked up in the
  // candidate's name index (never by rescanning the file's declarations
  // for every referenced name).
  let namesScanned = 0;
  for (const [name, refs] of referenced) {
    // The provider seam is PUBLIC (a registered provider may be slow), so
    // this loop checks the wall-clock bound too, not only the caller loop.
    namesScanned += 1;
    if ((namesScanned & 0x3f) === 0 && build.deadline.exceeded()) {
      noteDeadline(build);
      return;
    }
    const declarations = candidate.byName.get(name);
    if (declarations === undefined) continue;
    for (const decl of declarations) {
      const usage = call(
        `classify:${candidate.path}:${decl.startLine}:${name}`,
        () => provider.classify(candidate.syntaxFile, decl.startLine, name),
        "unknown",
      );
      if (usage !== "definition") continue;
      const head = candidate.syntaxFile.lines[decl.startLine - 1] ?? "";
      const { provenance } = evidenceOf(head, candidate.path, !candidate.committed);
      context.definitions.push({
        name,
        path: candidate.path,
        line: decl.startLine,
        kind: decl.kind,
        referencedFrom: [...refs],
        provenance,
      });
    }
  }

  // The callers of the declarations the diff touched.
  const lines = candidate.syntaxFile.lines;
  for (let index = 0; index < lines.length; index += 1) {
    if ((index & 0xff) === 0 && build.deadline.exceeded()) {
      noteDeadline(build);
      return;
    }
    const line = lines[index] as string;
    for (const [name, targets] of targetsByName) {
      if (!line.includes(name)) continue;
      const lineNo = index + 1;
      const usage = call(
        `classify:${candidate.path}:${lineNo}:${name}`,
        () => provider.classify(candidate.syntaxFile, lineNo, name),
        "unknown",
      );
      if (usage !== "call") continue;
      for (const target of targets) {
        // A file that owns the name at module scope owns a DIFFERENT symbol
        // than the one under review; only the changed file itself is exempt.
        if (target.path !== candidate.path && candidate.moduleNames.has(name)) continue;
        const key = `${name}\u0000${candidate.path}\u0000${lineNo}\u0000${target.path}`;
        if (candidate.seenCallers.has(key)) continue;
        candidate.seenCallers.add(key);
        const { text, provenance } = evidenceOf(line, candidate.path, !candidate.committed);
        const snippet = text.length <= MAX_SYNTAX_SNIPPET_CHARS
          ? text
          : `${text.slice(0, MAX_SYNTAX_SNIPPET_CHARS)}\n[truncated]`;
        context.callers.push({
          name,
          path: candidate.path,
          line: lineNo,
          usage,
          declaration: { path: target.path, line: target.line },
          snippet,
          provenance,
        });
      }
    }
  }
}

/** The candidate phase: every candidate file is read, asked for its
 * declarations, and mined for the evidence it carries — one file at a
 * time, so neither the time nor the memory of the phase grows with the
 * size of the repository.
 *
 * The CHANGED files are candidates too (a changed declaration can be
 * called from the file that defines it), and they come first: their bytes
 * are vouched for by the diff, so they keep the committed-source
 * treatment even when the candidate listing is not git-backed. */
function collectCandidateEvidencePhase(
  build: Build,
  workspace: string,
  changedFiles: readonly ChangedFile[],
  referenced: ReadonlyMap<string, SyntaxContextReference[]>,
  limit: number,
  provider: SyntaxProvider,
  call: ProviderCalls,
): void {
  if (build.deadline.exceeded()) {
    // The candidate listing is a SUBPROCESS: it is bounded by the time the
    // build has left, so it cannot outlive the build's own wall-clock bound.
    noteDeadline(build);
    return;
  }
  const listing = listCandidatePaths(workspace, limit, build.deadline.remainingSeconds());
  if (!listing.gitBacked) {
    pushNote(build, "candidate listing not git-backed; candidate provenance is untrusted_text");
  }
  if (listing.truncated) {
    markTruncated(build, TRUNCATION_REASON_CANDIDATE_CAP);
    pushNote(build, `candidate file cap hit: only the first ${limit} candidate files were considered`);
  }

  const targetsByName = new Map<string, Array<{ path: string; line: number }>>();
  for (const decl of build.context.declarations) {
    const targets = targetsByName.get(decl.name);
    if (targets === undefined) targetsByName.set(decl.name, [{ path: decl.path, line: decl.startLine }]);
    else targets.push({ path: decl.path, line: decl.startLine });
  }

  const handled = new Set<string>();
  for (const file of changedFiles) {
    if (handled.has(file.path)) continue;
    handled.add(file.path);
    if (build.deadline.exceeded()) {
      noteDeadline(build);
      return;
    }
    collectCandidateEvidence(build, {
      path: file.path,
      syntaxFile: file.syntaxFile,
      declarations: file.declarations,
      moduleNames: moduleScopeNames(file.declarations),
      byName: indexByName(file.declarations),
      committed: true,
      seenCallers: new Set<string>(),
    }, referenced, targetsByName, provider, call);
  }

  for (const path of listing.paths) {
    if (handled.has(path)) continue;
    handled.add(path);
    if (build.deadline.exceeded()) {
      noteDeadline(build);
      return;
    }
    const candidate = readCandidate(build, workspace, path, provider, call, listing.gitBacked);
    if (candidate === null) continue;
    collectCandidateEvidence(build, candidate, referenced, targetsByName, provider, call);
  }
}

function buildInner(options: SyntaxContextOptions, context: SyntaxContext): SyntaxContext {
  const build: Build = {
    context,
    deadline: new DeadlineBudget(MAX_SYNTAX_SECONDS, options.monotonic),
  };
  const errors = context.errors;
  const workspace = typeof options.workspace === "string" ? options.workspace : "";
  context.headRevision = typeof options.headRevision === "string" && options.headRevision !== "" ? options.headRevision : null;

  let provider: SyntaxProvider;
  if (options.provider !== undefined && options.provider !== null) {
    provider = options.provider;
    context.providerId = typeof provider.id === "string" ? provider.id : "";
    // The caller resolved the provider: its fallback outcome is the
    // caller's to report. Absent options keep the historical values
    // (no fallback, no reason) byte for byte.
    context.providerFallback = options.providerFallback === true;
    context.providerFallbackReason = typeof options.providerFallbackReason === "string" && options.providerFallbackReason !== ""
      ? options.providerFallbackReason
      : null;
  } else {
    const resolution = resolveSyntaxProvider();
    provider = resolution.provider;
    context.providerId = resolution.provider.id;
    context.providerFallback = resolution.fallback;
    context.providerFallbackReason = resolution.reason;
  }

  const maxItems = positiveInt(options.maxItems, MAX_SYNTAX_ITEMS);
  const maxBytes = positiveInt(options.maxBytes, MAX_SYNTAX_BYTES);
  const maxCandidateFiles = positiveInt(options.maxCandidateFiles, MAX_SYNTAX_CANDIDATE_FILES);
  const call = providerCalls(errors);

  const anchorFiles = readAnchorFiles(options.anchors, errors);

  // The changed files, read at the head checkout.
  const changedFiles = collectChangedFiles(build, workspace, anchorFiles, provider, call);

  // 1. The declarations the diff touches.
  for (const file of changedFiles) {
    for (const decl of file.declarations) {
      if (!overlaps(file.changedLines, decl.startLine, decl.endLine)) continue;
      const body = declarationBody(file.syntaxFile.lines, decl.startLine, decl.endLine, file.path);
      context.declarations.push({
        path: file.path,
        name: decl.name,
        kind: decl.kind,
        startLine: decl.startLine,
        endLine: decl.endLine,
        confidence: decl.confidence,
        changed: true,
        body: body.body,
        bodyTruncated: body.truncated,
        provenance: body.provenance,
      });
    }
  }

  // 2. The identifiers the changed lines reference.
  const referenced = collectReferenced(build, changedFiles, provider, call);

  // 3. The candidate files: the repository'"'"'s other source files, bounded.
  //    Each candidate is read, mined for its evidence and released again.
  collectCandidateEvidencePhase(build, workspace, changedFiles, referenced, maxCandidateFiles, provider, call);

  applyBudgets(context, maxItems, maxBytes);
  return context;
}

/** The value order the budget keeps longest: a touched declaration is the
 * most valuable item (it IS the change), then a caller (direct impact of
 * the change), then a definition (context for a referenced name). */
type BudgetCategory = "declarations" | "callers" | "definitions";

/** The bytes the artifact's TEXT occupies: every piece of text it carries
 * — a declaration body, a caller snippet, the paths, names and kinds the
 * renderer prints, and each definition's reference sites.
 *
 * The previous accounting counted only the bodies, the snippets and the
 * definition PATHS, so a definition's `referenced_from` list (and the
 * metadata) was uncounted and the byte cap did not bound the text the
 * artifact actually carried. */
function budgetBytes(context: SyntaxContext): number {
  let bytes = 0;
  for (const decl of context.declarations) {
    bytes += Buffer.byteLength(decl.body, "utf8");
    bytes += Buffer.byteLength(decl.path, "utf8");
    bytes += Buffer.byteLength(decl.name, "utf8");
    bytes += Buffer.byteLength(decl.kind, "utf8");
  }
  for (const caller of context.callers) {
    bytes += Buffer.byteLength(caller.snippet, "utf8");
    bytes += Buffer.byteLength(caller.path, "utf8");
    bytes += Buffer.byteLength(caller.name, "utf8");
    bytes += Buffer.byteLength(caller.usage, "utf8");
    bytes += Buffer.byteLength(caller.declaration.path, "utf8");
  }
  for (const definition of context.definitions) {
    bytes += Buffer.byteLength(definition.path, "utf8");
    bytes += Buffer.byteLength(definition.name, "utf8");
    bytes += Buffer.byteLength(definition.kind, "utf8");
    for (const ref of definition.referencedFrom) {
      bytes += Buffer.byteLength(ref.path, "utf8");
      bytes += Buffer.byteLength(String(ref.line), "utf8");
    }
  }
  return bytes;
}

/** Drop the lowest-value items until every hard cap holds. The dropped
 * content is visible as `truncated: true` and a `truncated_reason` — a
 * bounded artifact never pretends to be complete. */
function applyBudgets(context: SyntaxContext, maxItems: number, maxBytes: number): void {
  const mark = (reason: string): void => {
    context.truncated = true;
    if (context.truncatedReason === null) context.truncatedReason = reason;
  };
  const drop = (category: BudgetCategory): boolean => {
    if (category === "declarations") {
      if (context.declarations.length === 0) return false;
      context.declarations.pop();
      return true;
    }
    if (category === "callers") {
      if (context.callers.length === 0) return false;
      context.callers.pop();
      return true;
    }
    if (context.definitions.length === 0) return false;
    context.definitions.pop();
    return true;
  };

  // Per-category cap.
  if (context.declarations.length > maxItems) {
    context.declarations.length = maxItems;
    mark(TRUNCATION_REASON_ITEM_CAP);
  }
  if (context.callers.length > maxItems) {
    context.callers.length = maxItems;
    mark(TRUNCATION_REASON_ITEM_CAP);
  }
  if (context.definitions.length > maxItems) {
    context.definitions.length = maxItems;
    mark(TRUNCATION_REASON_ITEM_CAP);
  }

  // Total item cap: the lowest value goes first.
  let total = context.declarations.length + context.callers.length + context.definitions.length;
  while (total > maxItems) {
    if (!drop("definitions") && !drop("callers") && !drop("declarations")) break;
    total -= 1;
    mark(TRUNCATION_REASON_ITEM_CAP);
  }

  // Total byte cap: the lowest value goes first.
  let bytes = budgetBytes(context);
  while (bytes > maxBytes) {
    const dropped = drop("definitions") || drop("callers") || drop("declarations");
    if (!dropped) break;
    bytes = budgetBytes(context);
    mark(TRUNCATION_REASON_BYTE_CAP);
  }
}

// ---------------------------------------------------------------------------
// Artifact serialization (camelCase in memory -> snake_case on disk)
// ---------------------------------------------------------------------------

/** The persisted provenance record, mirroring the related-code artifact's
 * field names. `revision` is emitted only when one was bound; working-tree
 * reads bind none, so its absence is the fail-closed signal for
 * `authorizesLiteralClaim`. */
function provenanceToArtifact(provenance: EvidenceProvenance): Record<string, unknown> {
  return {
    representation: provenance.representation,
    synthesized: provenance.synthesized,
    redaction_count: provenance.redactionCount,
    ...(typeof provenance.file === "string" && provenance.file !== "" ? { file: provenance.file } : {}),
    ...(typeof provenance.revision === "string" && provenance.revision !== "" ? { revision: provenance.revision } : {}),
  };
}

/** The persisted artifact: snake_case, no in-memory-only fields. */
export function syntaxContextToArtifact(context: SyntaxContext): Record<string, unknown> {
  return {
    artifact_version: context.artifactVersion,
    head_revision: context.headRevision,
    provider_id: context.providerId,
    provider_fallback: context.providerFallback,
    provider_fallback_reason: context.providerFallbackReason,
    declarations: context.declarations.map((decl) => ({
      path: decl.path,
      name: decl.name,
      kind: decl.kind,
      start_line: decl.startLine,
      end_line: decl.endLine,
      confidence: decl.confidence,
      changed: decl.changed,
      body: decl.body,
      body_truncated: decl.bodyTruncated,
      provenance: provenanceToArtifact(decl.provenance),
    })),
    definitions: context.definitions.map((definition) => ({
      name: definition.name,
      path: definition.path,
      line: definition.line,
      kind: definition.kind,
      referenced_from: definition.referencedFrom.map((ref) => ({ path: ref.path, line: ref.line })),
      provenance: provenanceToArtifact(definition.provenance),
    })),
    callers: context.callers.map((caller) => ({
      name: caller.name,
      path: caller.path,
      line: caller.line,
      usage: caller.usage,
      declaration: { path: caller.declaration.path, line: caller.declaration.line },
      snippet: caller.snippet,
      provenance: provenanceToArtifact(caller.provenance),
    })),
    truncated: context.truncated,
    truncated_reason: context.truncatedReason,
    notes: [...context.notes],
    errors: [...context.errors],
  };
}
