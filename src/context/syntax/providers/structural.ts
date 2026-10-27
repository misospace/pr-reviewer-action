/** The default dependency-free "structural" syntax provider (#764, phase 1).
 *
 * It answers the provider seam's questions with the repository's own
 * declaration grammar (`declarationAt` from `../../change-anchors.ts` — the
 * single source of truth for what a declaration IS) plus a lexical reader
 * (comments and string literals stripped) and an indentation-aware scope
 * walk. No parser, no grammar files, no dependency: the module is plain
 * TypeScript over node built-ins.
 *
 * What it buys over a plain textual search (`git grep`) is SCOPE:
 *   - a declaration head is a DEFINITION, not a reference, so a changed
 *     function's own name is not reported as a reference to itself;
 *   - an occurrence whose enclosing scope binds the name LOCALLY is a
 *     different symbol from the repository-wide one and is reported as
 *     "unknown" rather than as a caller.
 *
 * What it cannot do (and therefore never claims): resolve types, resolve
 * dynamic dispatch, resolve re-exports, or tell a method from a same-named
 * function in another module. Its answers are evidence for a reviewer, not
 * proof.
 *
 * Every public entry point is total: it returns empty answers rather than
 * throwing, and it never mutates the file it is handed. */

import { declarationAt, declarationEnd } from "../../change-anchors.js";
import { codeLinesFor, identifiersIn, identifierPattern, isKeyword, isSupportedLanguage } from "../grammar.js";
import type { SyntaxDeclaration, SyntaxDeclarationKind, SyntaxFile, SyntaxProvider, SyntaxUsage } from "../types.js";

/** The provider id the registry knows this provider by. */
export const STRUCTURAL_PROVIDER_ID = "structural";

/** A local binding of a name inside a scope: an assignment that binds a
 * name the scope owns. It is not a declaration (it has no kind, no signature
 * and no body) but it SHADOWS a repository-wide name for the rest of the
 * scope, which is exactly the same-name-different-scope case the lexical
 * stage cannot see. */
interface LocalBinding {
  name: string;
  startLine: number;
  endLine: number;
}

/** A declaration plus the names its own signature binds. */
interface StructuralDeclaration extends SyntaxDeclaration {
  /** The names the declaration's parameter list binds. */
  params: string[];
}

interface StructuralFile {
  /** The file's lines with comments and string literals removed. */
  codeLines: string[];
  /** The declarations of the file, in source order. */
  declarations: readonly SyntaxDeclaration[];
  /** The same declarations with their parameter lists. */
  internals: readonly StructuralDeclaration[];
  /** The local bindings of the file (assignments). */
  bindings: readonly LocalBinding[];
}

/** Per-file analysis, cached by the file object. The provider interface
 * hands out one file object per file, and the object is treated as
 * immutable, so the cache is keyed by identity and never goes stale. */
const CACHE = new WeakMap<SyntaxFile, StructuralFile>();

const EMPTY_FILE: StructuralFile = { codeLines: [], declarations: [], internals: [], bindings: [] };

/** The Python/JS/Go assignment shapes that bind a name in the current
 * scope. Deliberately narrow: only a name the scope OWNS counts, so a
 * comparison (`x == y`) or an attribute access never looks like a binding. */
const PY_ASSIGNMENT_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/;
const JS_ASSIGNMENT_RE = /^\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/;
const GO_ASSIGNMENT_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::=|=(?!=))/;

/** The name a line binds locally, or null. */
function localBindingName(code: string, language: string): string | null {
  const pattern = language === "python" ? PY_ASSIGNMENT_RE : language === "go" ? GO_ASSIGNMENT_RE : JS_ASSIGNMENT_RE;
  const match = pattern.exec(code);
  const name = match?.[1];
  if (name === undefined || name === "") return null;
  if (isKeyword(name, language)) return null;
  return name;
}

/** The names bound by the parameter list of a declaration head. */
function parameterNames(code: string, language: string): string[] {
  const open = code.indexOf("(");
  if (open === -1) return [];
  let depth = 0;
  let end = -1;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];
  return identifiersIn(code.slice(open + 1, end), language).filter((name) => !isKeyword(name, language));
}

/** The declarations of a file, with their extents. */
function buildFile(file: SyntaxFile): StructuralFile {
  try {
    const language = file.language;
    // A language the provider does not read is not guessed at: the shared
    // declaration grammar would otherwise apply its C-like patterns to it.
    if (!isSupportedLanguage(language)) {
      return { codeLines: [], declarations: [], internals: [], bindings: [] };
    }
    const lines = file.lines;
    const codeLines = codeLinesFor(lines, language);
    const internals: StructuralDeclaration[] = [];
    const bindings: LocalBinding[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const lineNo = index + 1;
      const code = codeLines[index] ?? "";
      const decl = declarationAt(code, language);
      if (decl !== null) {
        const name = decl[0];
        const endLine = Math.max(lineNo, Math.min(lines.length, declarationEnd(lines, lineNo)));
        internals.push({
          name,
          kind: decl[2] as SyntaxDeclarationKind,
          startLine: lineNo,
          endLine,
          confidence: decl[1] === "medium" ? "medium" : "high",
          params: parameterNames(code, language),
        });
      }
      const bound = localBindingName(code, language);
      if (bound !== null) bindings.push({ name: bound, startLine: lineNo, endLine: lineNo });
    }
    return {
      codeLines,
      declarations: internals.map((decl) => ({
        name: decl.name,
        kind: decl.kind,
        startLine: decl.startLine,
        endLine: decl.endLine,
        confidence: decl.confidence,
      })),
      internals,
      bindings,
    };
  } catch {
    return EMPTY_FILE;
  }
}

function cacheFor(file: SyntaxFile): StructuralFile {
  const cached = CACHE.get(file);
  if (cached !== undefined) return cached;
  const built = buildFile(file);
  CACHE.set(file, built);
  return built;
}

/** The innermost declaration whose extent contains `line` — the scope the
 * occurrence sits in. */
function innermostScope(file: StructuralFile, line: number): StructuralDeclaration | null {
  let best: StructuralDeclaration | null = null;
  for (const decl of file.internals) {
    if (decl.startLine > line || line > decl.endLine) continue;
    if (best === null) {
      best = decl;
      continue;
    }
    if (decl.startLine > best.startLine || (decl.startLine === best.startLine && decl.endLine < best.endLine)) best = decl;
  }
  return best;
}

/** True when the occurrence at `line` binds a name that a scope owns
 * LOCALLY, so it is a different symbol from the repository-wide one.
 *
 * The three ways a scope owns a name:
 *   - its own parameter list (`def process(handle):` binds `handle`);
 *   - a binding nested inside it (`handle = ...`, or a nested `def handle`);
 *   - (not) its own declaration name — a recursive call inside the
 *     declaration itself still refers to that very symbol, so it is NOT
 *     shadowed and stays a caller.
 *
 * A module-scope binding never shadows: the provider cannot know whether the
 * repository-wide symbol under review is the file's own module-scope one or
 * an imported one, and the builder owns that target-aware question. */
function isShadowed(file: StructuralFile, line: number, name: string): boolean {
  const scope = innermostScope(file, line);
  if (scope === null) return false;
  if (scope.name === name) return false;
  if (scope.params.includes(name)) return true;
  for (const binding of file.bindings) {
    if (binding.name !== name) continue;
    if (binding.startLine > scope.startLine && binding.endLine <= scope.endLine) return true;
  }
  for (const decl of file.internals) {
    if (decl.name !== name) continue;
    if (decl.startLine > scope.startLine && decl.endLine <= scope.endLine) return true;
  }
  return false;
}

/** True when the name occurs in `code` as a whole identifier. */
function containsIdentifier(code: string, name: string, language: string): boolean {
  for (const candidate of identifiersIn(code, language)) {
    if (candidate === name) return true;
  }
  return false;
}

/** True when an occurrence of the name is immediately followed by an open
 * parenthesis — a call. */
function isCallSite(code: string, name: string, language: string): boolean {
  const pattern = identifierPattern(language);
  pattern.lastIndex = 0;
  let match = pattern.exec(code);
  while (match !== null) {
    if (match[0] === name) {
      let index = match.index + match[0].length;
      while (index < code.length && (code[index] === " " || code[index] === "\t")) index += 1;
      if (code[index] === "(") return true;
    }
    match = pattern.exec(code);
  }
  return false;
}

/** The default structural provider. */
export const structuralSyntaxProvider: SyntaxProvider = {
  id: STRUCTURAL_PROVIDER_ID,

  declarations(file: SyntaxFile): readonly SyntaxDeclaration[] {
    try {
      return cacheFor(file).declarations;
    } catch {
      return [];
    }
  },

  identifiersOnLine(file: SyntaxFile, line: number): readonly string[] {
    try {
      const cached = cacheFor(file);
      const code = cached.codeLines[line - 1];
      if (code === undefined) return [];
      const decl = declarationAt(code, file.language);
      const declared = decl === null ? null : decl[0];
      const out: string[] = [];
      for (const name of identifiersIn(code, file.language)) {
        if (isKeyword(name, file.language)) continue;
        // A declaration head DEFINES the name; it does not reference it.
        if (declared !== null && name === declared) continue;
        out.push(name);
      }
      return out;
    } catch {
      return [];
    }
  },

  classify(file: SyntaxFile, line: number, name: string): SyntaxUsage {
    try {
      const cached = cacheFor(file);
      const code = cached.codeLines[line - 1];
      if (code === undefined) return "unknown";
      if (name === "") return "unknown";
      if (!containsIdentifier(code, name, file.language)) return "unknown";
      const decl = declarationAt(code, file.language);
      if (decl !== null && decl[0] === name) return "definition";
      if (isShadowed(cached, line, name)) return "unknown";
      return isCallSite(code, name, file.language) ? "call" : "use";
    } catch {
      return "unknown";
    }
  },
};
