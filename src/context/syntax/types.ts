/** Syntax-aware related-code context (#764, phase 1): the provider seam.
 *
 * The seam is deliberately tiny and deliberately PARSER-FREE. A provider
 * answers SYNTAX questions about ONE file — what is declared in it, which
 * identifiers a line references, and how one occurrence of a name reads at a
 * site — and NOTHING else. Everything a reviewer would call "policy"
 * (candidate discovery, budgets, provenance, filtering, truncation, fallback)
 * belongs to the BUILDER (`./build.ts`), not to the provider, so a
 * parser-backed provider (tree-sitter, a language server, an LSP client) can
 * be registered later without the builder or any policy changing shape.
 *
 * No language is required for correctness: the default provider is a
 * dependency-free structural reader (see `./providers/structural.ts`), and a
 * provider that cannot read a file says so by returning empty answers rather
 * than by guessing.
 *
 * This module produces EVIDENCE, never authority: no findings, no severity,
 * no policy, no verdict. What a caller does with the evidence is the
 * caller's decision. */

export interface SyntaxFile {
  /** Repo-relative POSIX path. */
  path: string;
  /** "python" | "javascript" | "typescript" | "go" | "unknown" (from detectLanguage). */
  language: string;
  /** Full file content split on "\n". */
  lines: string[];
}

export type SyntaxDeclarationKind = "function" | "method" | "class" | "type" | "variable";

export interface SyntaxDeclaration {
  name: string;
  kind: SyntaxDeclarationKind;
  /** 1-based inclusive first line of the declaration. */
  startLine: number;
  /** 1-based inclusive last line of the declaration body; equals startLine when unknown. */
  endLine: number;
  confidence: "high" | "medium";
}

/** How an occurrence of an identifier reads at a site. */
export type SyntaxUsage = "definition" | "call" | "use" | "unknown";

export interface SyntaxProvider {
  /** Stable provider id, e.g. "structural". */
  readonly id: string;
  /** Declarations declared in the file. Return [] for a file that cannot be parsed. */
  declarations(file: SyntaxFile): readonly SyntaxDeclaration[];
  /** Identifiers referenced on one 1-based line. */
  identifiersOnLine(file: SyntaxFile, line: number): readonly string[];
  /** How an occurrence of `name` on `line` reads. */
  classify(file: SyntaxFile, line: number, name: string): SyntaxUsage;
}
