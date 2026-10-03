/** Spike (#764): syntax-aware related-code context. Given a unified diff
 * and a checked-out workspace, returns per changed file:
 *
 *  (a) the enclosing declaration(s) touched by the diff's hunks;
 *  (b) definitions of identifiers referenced on added lines, in the same
 *      file and in bounded relative imports;
 *  (c) bounded-text callers of each enclosing declaration's name.
 *
 * Every stage degrades instead of throwing: an unsupported language, an
 * unreadable file, or a parse failure all just produce fewer results for
 * that file — this stage is additive evidence on top of
 * `related-context.ts`, never a replacement, and issue #764 requires that
 * "no language is required for correctness". A byte budget bounds total
 * output the same way `related-context.ts` bounds its own artifact. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findCallers } from "./callers.js";
import { parseUnifiedDiff } from "./diff.js";
import { findDefinition, findEnclosingDeclaration, identifiersInRange, type EnclosingDeclaration } from "./declarations.js";
import { languageForPath } from "./grammars.js";
import { parserFor } from "./grammars.js";
import { resolveRelativeImports } from "./imports.js";

export interface SyntaxDefinition extends EnclosingDeclaration {
  identifier: string;
  path: string;
}

export interface SyntaxCaller {
  identifier: string;
  path: string;
  line: number;
  snippet: string;
}

export interface SyntaxFileContext {
  path: string;
  language: string | null;
  supported: boolean;
  parseError: string | null;
  enclosingDeclarations: EnclosingDeclaration[];
  definitions: SyntaxDefinition[];
  callers: SyntaxCaller[];
}

export interface SyntaxContextResult {
  files: SyntaxFileContext[];
  truncated: boolean;
  reasons: string[];
  bytesUsed: number;
}

export interface SyntaxContextOptions {
  maxBytes?: number;
  maxDeclarationTextBytes?: number;
  maxIdentifiersPerFile?: number;
  maxImportedFilesPerFile?: number;
  maxCallerFilesScanned?: number;
  maxCallersPerDeclaration?: number;
  maxDeclarationsForCallers?: number;
  excludePaths?: ReadonlySet<string>;
}

const DEFAULTS = {
  maxBytes: 60_000,
  maxDeclarationTextBytes: 4_000,
  maxIdentifiersPerFile: 25,
  maxImportedFilesPerFile: 3,
  maxCallerFilesScanned: 3000,
  maxCallersPerDeclaration: 10,
  maxDeclarationsForCallers: 5,
} as const;

function utf8Len(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Split a hunk's added-line numbers into contiguous runs. A single git
 * diff hunk can span more than one sibling declaration (e.g. two adjacent
 * functions edited close enough together that the default 3-line context
 * merges them into one hunk) — finding the enclosing declaration for the
 * *whole hunk range* then finds nothing, because no single node contains
 * both siblings. Finding it per contiguous added-line run instead
 * correctly recovers each declaration the hunk actually touches. */
function groupConsecutive(lines: readonly number[]): Array<[number, number]> {
  const sorted = [...lines].sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const line of sorted) {
    const last = runs[runs.length - 1];
    if (last !== undefined && line <= last[1] + 1) {
      last[1] = line;
    } else {
      runs.push([line, line]);
    }
  }
  return runs;
}

function dedupeDeclarations(items: EnclosingDeclaration[]): EnclosingDeclaration[] {
  const seen = new Set<string>();
  const out: EnclosingDeclaration[] = [];
  for (const item of items) {
    const key = `${item.type}:${item.startLine}:${item.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Build syntax-aware related-code context for a unified diff against a
 * checked-out `workspace`. Read-only: never mutates the workspace, never
 * shells out, never fetches anything (grammars are loaded from the
 * package's own bundled WASM). */
export async function buildSyntaxContext(diffText: string, workspace: string, options: SyntaxContextOptions = {}): Promise<SyntaxContextResult> {
  const opts = { ...DEFAULTS, ...options };
  const exclude = opts.excludePaths ?? new Set<string>();
  const diffFiles = parseUnifiedDiff(diffText);
  const files: SyntaxFileContext[] = [];
  let bytesUsed = 0;
  let truncated = false;
  const reasons: string[] = [];
  const markTruncated = (reason: string): void => {
    truncated = true;
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  for (const diffFile of diffFiles) {
    if (bytesUsed >= opts.maxBytes) {
      markTruncated("byte_budget");
      break;
    }
    const language = languageForPath(diffFile.path);
    const fileResult: SyntaxFileContext = {
      path: diffFile.path,
      language,
      supported: false,
      parseError: null,
      enclosingDeclarations: [],
      definitions: [],
      callers: [],
    };
    files.push(fileResult);
    if (language === null) continue;

    const parser = await parserFor(language);
    if (parser === null) continue; // unsupported/unloadable grammar — leave supported: false

    let source: string;
    try {
      source = readFileSync(join(workspace, diffFile.path), "utf8");
    } catch (error) {
      fileResult.parseError = `read failed: ${(error as Error).message}`;
      continue;
    }

    let tree;
    try {
      tree = parser.parse(source);
    } catch (error) {
      fileResult.parseError = `parse failed: ${(error as Error).message}`;
      continue;
    }
    if (tree === null) {
      fileResult.parseError = "parse returned no tree";
      continue;
    }
    fileResult.supported = true;

    const declarations: EnclosingDeclaration[] = [];
    const identifiers: string[] = [];
    const identifierSeen = new Set<string>();
    for (const hunk of diffFile.hunks) {
      for (const [runStart, runEnd] of groupConsecutive(hunk.addedLines)) {
        const decl = findEnclosingDeclaration(tree, language, runStart, runEnd, opts.maxDeclarationTextBytes);
        if (decl !== null) declarations.push(decl);
      }
      for (const line of hunk.addedLines) {
        for (const id of identifiersInRange(tree, line, line)) {
          if (identifierSeen.has(id) || identifiers.length >= opts.maxIdentifiersPerFile) continue;
          identifierSeen.add(id);
          identifiers.push(id);
        }
      }
    }
    fileResult.enclosingDeclarations = dedupeDeclarations(declarations);
    for (const decl of fileResult.enclosingDeclarations) {
      bytesUsed += utf8Len(decl.text);
      if (bytesUsed >= opts.maxBytes) {
        markTruncated("byte_budget");
        break;
      }
    }

    // (b) definitions: same file first, then bounded relative imports.
    const declNames = new Set(fileResult.enclosingDeclarations.map((d) => d.name).filter((n): n is string => n !== null));
    const importedFiles = resolveRelativeImports(source, diffFile.path, language, workspace, opts.maxImportedFilesPerFile);
    for (const identifier of identifiers) {
      if (bytesUsed >= opts.maxBytes) {
        markTruncated("byte_budget");
        break;
      }
      if (declNames.has(identifier)) continue; // it's the enclosing declaration itself, not a reference to something else
      const localDef = findDefinition(tree, language, identifier, opts.maxDeclarationTextBytes);
      if (localDef !== null) {
        fileResult.definitions.push({ ...localDef, identifier, path: diffFile.path });
        bytesUsed += utf8Len(localDef.text);
        continue;
      }
      for (const importedPath of importedFiles) {
        const importedLanguage = languageForPath(importedPath);
        if (importedLanguage === null) continue;
        const importedParser = await parserFor(importedLanguage);
        if (importedParser === null) continue;
        let importedSource: string;
        try {
          importedSource = readFileSync(join(workspace, importedPath), "utf8");
        } catch {
          continue;
        }
        let importedTree;
        try {
          importedTree = importedParser.parse(importedSource);
        } catch {
          continue;
        }
        if (importedTree === null) continue;
        const remoteDef = findDefinition(importedTree, importedLanguage, identifier, opts.maxDeclarationTextBytes);
        if (remoteDef !== null) {
          fileResult.definitions.push({ ...remoteDef, identifier, path: importedPath });
          bytesUsed += utf8Len(remoteDef.text);
          break;
        }
      }
    }

    // (c) callers of each enclosing declaration's name, bounded.
    const declarationsForCallers = fileResult.enclosingDeclarations.filter((d) => d.name !== null).slice(0, opts.maxDeclarationsForCallers);
    for (const decl of declarationsForCallers) {
      if (bytesUsed >= opts.maxBytes) {
        markTruncated("byte_budget");
        break;
      }
      // Same-file callers are real signal (a sibling function calling the
      // changed one) and are not excluded — only the declaration's own
      // body is, so its own `def name(...)` header/body isn't reported as
      // a caller of itself.
      const { hits, truncated: callersTruncated } = findCallers(decl.name as string, workspace, {
        maxFiles: opts.maxCallerFilesScanned,
        maxMatches: opts.maxCallersPerDeclaration,
        excludePaths: exclude,
      });
      if (callersTruncated) markTruncated("caller_cap");
      for (const hit of hits) {
        if (hit.path === diffFile.path && hit.line >= decl.startLine && hit.line <= decl.endLine) continue;
        fileResult.callers.push({ identifier: decl.name as string, path: hit.path, line: hit.line, snippet: hit.snippet });
        bytesUsed += utf8Len(hit.snippet);
      }
    }
  }

  if (diffFiles.length > files.length) markTruncated("byte_budget");
  return { files, truncated, reasons, bytesUsed };
}
