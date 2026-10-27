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
 * Two invariants shape the whole module:
 *   - IT NEVER THROWS. A malformed anchor artifact, an unreadable file, a
 *     provider that throws — each degrades the stage (an `errors` entry, or
 *     fewer items) and never escapes as an exception. The caller (a later
 *     phase) decides what a degraded stage means.
 *   - EVERY SNIPPET CARRIES PROVENANCE. The text is read from the WORKING
 *     TREE, so no revision is bound (`revision: null`): binding one would
 *     claim a byte-identity the read never established — the same rule and
 *     the same reason as the related-code stage (`docs/architecture/
 *     source-evidence-provenance.md`). The PR head SHA is recorded ONCE, at
 *     artifact level, as `head_revision`. */

import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { detectLanguage, readHeadLines } from "../change-anchors.js";
import { sourceEvidence } from "../redact.js";
import type { EvidenceProvenance } from "../evidence-provenance.js";
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

/** Per-item bounds: a declaration body is a BODY, not the file, and a caller
 * snippet is a line. */
export const MAX_SYNTAX_BODY_CHARS = 2_000;
export const MAX_SYNTAX_BODY_LINES = 120;
export const MAX_SYNTAX_SNIPPET_CHARS = 300;

/** Bounds on the bookkeeping itself. */
export const MAX_SYNTAX_ERRORS = 20;
export const MAX_SYNTAX_CHANGED_RANGES = 200;
export const MAX_SYNTAX_CHANGED_LINES = 500;

/** How many provider failures are tolerated before the provider is treated
 * as broken for the rest of the build (a provider that throws on every call
 * must not turn the build into an error loop). */
export const MAX_SYNTAX_PROVIDER_FAILURES = 5;

/** The workspace directories whose contents are generated or vendored: a
 * declaration found in them is not repository source. */
const GENERATED_DIRS: ReadonlySet<string> = new Set(["dist", "build", "vendor", "node_modules", "third_party"]);

/** How many directories the candidate walk may visit. */
const MAX_WALK_DIRECTORIES = 2_000;

/** How many lines of a file are scanned for a NUL byte when deciding
 * whether the file is text at all. */
const BINARY_SCAN_LINES = 200;

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
  /** Non-fatal problems; a non-empty list means the stage degraded. */
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

/** Call a provider without letting it break the stage. */
function safeProvider<T>(errors: string[], label: string, call: () => T, fallback: T): T {
  try {
    return call();
  } catch (error) {
    pushError(errors, `${label}: ${messageOf(error)}`);
    return fallback;
  }
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
    errors: [],
  };
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

/** The repository's candidate files, bounded. The walk never follows a
 * symlink, never leaves the workspace, and never reads a file: it only
 * NAMES them, and the naming is bounded by `limit`. */
function listCandidatePaths(workspace: string, limit: number): string[] {
  if (limit <= 0) return [];
  const found: string[] = [];
  const pending: string[] = [""];
  let visited = 0;
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
      if (found.length >= limit) break;
      found.push(child);
    }
  }
  return found.sort();
}

/** A candidate file, read through the safe workspace reader. */
interface CandidateFile {
  path: string;
  syntaxFile: SyntaxFile;
  declarations: readonly SyntaxDeclaration[];
  /** The names the file declares at MODULE scope — a file that owns the name
   * at module scope owns a DIFFERENT symbol than the one under review. */
  moduleNames: ReadonlySet<string>;
}

function looksBinary(lines: readonly string[]): boolean {
  const limit = Math.min(lines.length, BINARY_SCAN_LINES);
  for (let i = 0; i < limit; i += 1) {
    if ((lines[i] as string).includes("\u0000")) return true;
  }
  return false;
}

/** The names a file declares at module scope: a declaration no other
 * declaration's extent contains. */
function moduleScopeNames(declarations: readonly SyntaxDeclaration[]): Set<string> {
  const names = new Set<string>();
  for (const decl of declarations) {
    const nested = declarations.some((other) =>
      other !== decl
      && other.startLine <= decl.startLine
      && decl.endLine <= other.endLine
      && (other.startLine < decl.startLine || other.endLine > decl.endLine));
    if (!nested) names.add(decl.name);
  }
  return names;
}

/** Read one candidate file: the safe workspace reader refuses absolute
 * paths, `..`, `.git` and symlinks, and returns null instead of throwing. */
function readCandidate(
  workspace: string,
  path: string,
  provider: SyntaxProvider,
  call: ProviderCalls,
): CandidateFile | null {
  const language = detectLanguage(path);
  if (!isSupportedLanguage(language)) return null;
  const lines = readHeadLines(workspace, path);
  if (lines === null) return null;
  if (looksBinary(lines)) return null;
  const syntaxFile: SyntaxFile = { path, language, lines };
  const declarations = call(`declarations:${path}`, () => provider.declarations(syntaxFile), []);
  return { path, syntaxFile, declarations, moduleNames: moduleScopeNames(declarations) };
}

// ---------------------------------------------------------------------------
// Item construction
// ---------------------------------------------------------------------------

/** The redacted text of a source span, with its provenance. The revision is
 * never bound: the bytes come from the working tree. */
function evidenceOf(text: string, path: string): { text: string; provenance: EvidenceProvenance } {
  return sourceEvidence(text, path, path, null);
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

function buildInner(options: SyntaxContextOptions, context: SyntaxContext): SyntaxContext {
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
  const changedFiles: ChangedFile[] = [];
  for (const anchor of anchorFiles) {
    if (anchor.deleted) continue;
    const language = detectLanguage(anchor.path);
    if (!isSupportedLanguage(language)) continue;
    const lines = readHeadLines(workspace, anchor.path);
    if (lines === null) {
      pushError(errors, `head file unavailable: ${anchor.path}`);
      continue;
    }
    if (looksBinary(lines)) continue;
    const syntaxFile: SyntaxFile = { path: anchor.path, language, lines };
    const declarations = call(`declarations:${anchor.path}`, () => provider.declarations(syntaxFile), []);
    changedFiles.push({
      path: anchor.path,
      syntaxFile,
      changedLines: anchor.changedLines,
      declarations,
      declared: new Set(declarations.map((decl) => decl.name)),
    });
  }

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
  const referenced = new Map<string, SyntaxContextReference[]>();
  for (const file of changedFiles) {
    const seen = new Set<string>();
    let scanned = 0;
    for (const [start, end] of file.changedLines) {
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      for (let line = low; line <= high; line += 1) {
        if (scanned >= MAX_SYNTAX_CHANGED_LINES) {
          context.truncated = true;
          break;
        }
        scanned += 1;
        const names = call(
          `identifiers:${file.path}:${line}`,
          () => provider.identifiersOnLine(file.syntaxFile, line),
          [],
        );
        for (const name of names) {
          // A name the changed file declares itself is not "referenced" —
          // its definition is right here.
          if (file.declared.has(name)) continue;
          if (seen.has(name)) continue;
          seen.add(name);
          const refs = referenced.get(name);
          if (refs === undefined) referenced.set(name, [{ path: file.path, line }]);
          else refs.push({ path: file.path, line });
        }
      }
    }
  }

  // 3. The candidate files: the repository's other source files, bounded.
  const candidates: CandidateFile[] = [];
  const byPath = new Map<string, CandidateFile>();
  for (const path of listCandidatePaths(workspace, maxCandidateFiles)) {
    const candidate = readCandidate(workspace, path, provider, call);
    if (candidate === null) continue;
    candidates.push(candidate);
    byPath.set(candidate.path, candidate);
  }
  for (const file of changedFiles) {
    if (byPath.has(file.path)) continue;
    const candidate: CandidateFile = {
      path: file.path,
      syntaxFile: file.syntaxFile,
      declarations: file.declarations,
      moduleNames: moduleScopeNames(file.declarations),
    };
    candidates.push(candidate);
    byPath.set(candidate.path, candidate);
  }

  // 4. The definitions of the referenced identifiers.
  for (const [name, refs] of referenced) {
    for (const candidate of candidates) {
      for (const decl of candidate.declarations) {
        if (decl.name !== name) continue;
        const usage = call(
          `classify:${candidate.path}:${decl.startLine}:${name}`,
          () => provider.classify(candidate.syntaxFile, decl.startLine, name),
          "unknown",
        );
        if (usage !== "definition") continue;
        const head = candidate.syntaxFile.lines[decl.startLine - 1] ?? "";
        const { provenance } = evidenceOf(head, candidate.path);
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
  }

  // 5. The callers of the declarations the diff touched.
  const targetsByName = new Map<string, Array<{ path: string; line: number }>>();
  for (const decl of context.declarations) {
    const targets = targetsByName.get(decl.name);
    if (targets === undefined) targetsByName.set(decl.name, [{ path: decl.path, line: decl.startLine }]);
    else targets.push({ path: decl.path, line: decl.startLine });
  }
  const callerSeen = new Set<string>();
  for (const candidate of candidates) {
    const lines = candidate.syntaxFile.lines;
    for (let index = 0; index < lines.length; index += 1) {
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
          if (callerSeen.has(key)) continue;
          callerSeen.add(key);
          const { text, provenance } = evidenceOf(line, candidate.path);
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

  applyBudgets(context, maxItems, maxBytes);
  return context;
}

/** The value order the budget keeps longest: a touched declaration is the
 * most valuable item (it IS the change), then a caller (direct impact of
 * the change), then a definition (context for a referenced name). */
type BudgetCategory = "declarations" | "callers" | "definitions";

function budgetBytes(context: SyntaxContext): number {
  let bytes = 0;
  for (const decl of context.declarations) bytes += Buffer.byteLength(decl.body, "utf8");
  for (const caller of context.callers) bytes += Buffer.byteLength(caller.snippet, "utf8");
  for (const definition of context.definitions) bytes += Buffer.byteLength(definition.path, "utf8");
  return bytes;
}

/** Drop the lowest-value items until every hard cap holds. The dropped
 * content is visible as `truncated: true` — a bounded artifact never
 * pretends to be complete. */
function applyBudgets(context: SyntaxContext, maxItems: number, maxBytes: number): void {
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
    context.truncated = true;
  }
  if (context.callers.length > maxItems) {
    context.callers.length = maxItems;
    context.truncated = true;
  }
  if (context.definitions.length > maxItems) {
    context.definitions.length = maxItems;
    context.truncated = true;
  }

  // Total item cap: the lowest value goes first.
  let total = context.declarations.length + context.callers.length + context.definitions.length;
  while (total > maxItems) {
    if (!drop("definitions") && !drop("callers") && !drop("declarations")) break;
    total -= 1;
    context.truncated = true;
  }

  // Total byte cap: the lowest value goes first.
  let bytes = budgetBytes(context);
  while (bytes > maxBytes) {
    const dropped = drop("definitions") || drop("callers") || drop("declarations");
    if (!dropped) break;
    bytes = budgetBytes(context);
    context.truncated = true;
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
    errors: [...context.errors],
  };
}
