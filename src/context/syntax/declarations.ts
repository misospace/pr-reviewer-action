/** Spike (#764): enclosing-declaration and identifier lookup on a parsed
 * tree. Node-type matching only (no `.scm` query files) — small, and easy
 * to extend per language without a query DSL. */

import type { Node, Tree } from "web-tree-sitter";
import type { SyntaxLanguageId } from "./grammars.js";

/** Node types tree-sitter uses for a "declaration you'd want the whole body
 * of" per language — functions, methods, classes, top-level type/const
 * declarations. Not exhaustive; a spike-scoped list per language covering
 * the shapes that show up in this repo. */
const DECLARATION_TYPES: Record<SyntaxLanguageId, readonly string[]> = {
  typescript: [
    "function_declaration",
    "method_definition",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "lexical_declaration", // covers `const foo = (...) => {}` / `const Foo = class {}`
  ],
  tsx: [
    "function_declaration",
    "method_definition",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "lexical_declaration",
  ],
  javascript: ["function_declaration", "method_definition", "class_declaration", "lexical_declaration"],
  python: ["function_definition", "class_definition"],
  go: ["function_declaration", "method_declaration", "type_declaration"],
  bash: ["function_definition"],
  yaml: [],
};

export interface EnclosingDeclaration {
  name: string | null;
  type: string;
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  text: string;
}

const FUNCTION_OR_CLASS_VALUE_TYPES = new Set(["arrow_function", "function_expression", "function", "class"]);

/** `lexical_declaration`/`variable_declaration` covers every `const`/`let`
 * statement — including an ordinary local variable (`const result = x + 1`)
 * — not just `const foo = () => {}`. Only the latter is a "declaration"
 * worth treating as an enclosing scope or searching callers for; without
 * this check, a hunk touching any local variable assignment gets reported
 * as its own bogus "enclosing declaration", and common names (`result`,
 * `i`, `line`) get spuriously searched as if they were functions — this
 * was the dominant source of noise in the spike's PR #756 run (see the
 * spike note). */
function isRealDeclarationNode(node: Node): boolean {
  if (node.type !== "lexical_declaration" && node.type !== "variable_declaration") return true;
  for (const child of node.namedChildren) {
    if (child === null || child.type !== "variable_declarator") continue;
    const value = child.childForFieldName("value");
    if (value !== null && FUNCTION_OR_CLASS_VALUE_TYPES.has(value.type)) return true;
  }
  return false;
}

function declarationName(node: Node): string | null {
  const named = node.childForFieldName("name");
  if (named !== null) return named.text;
  // `const foo = () => {}` is a lexical_declaration whose name sits on the
  // nested variable_declarator, not on the declaration node itself.
  for (const child of node.namedChildren) {
    if (child === null) continue;
    if (child.type === "variable_declarator") {
      const inner = child.childForFieldName("name");
      if (inner !== null) return inner.text;
    }
  }
  return null;
}

/** Smallest declaration node (per `DECLARATION_TYPES`) whose range fully
 * contains `[startLine, endLine]` (1-based, inclusive). Returns `null` when
 * the range sits outside any recognized declaration (e.g. top-level
 * imports, or a language with no declaration types registered) — the
 * caller treats that as "no enclosing declaration", not an error. */
export function findEnclosingDeclaration(
  tree: Tree,
  language: SyntaxLanguageId,
  startLine: number,
  endLine: number,
  maxTextBytes: number,
): EnclosingDeclaration | null {
  const types = DECLARATION_TYPES[language];
  if (types.length === 0) return null;
  const startRow = Math.max(0, startLine - 1);
  const endRow = Math.max(startRow, endLine - 1);

  let best: Node | null = null;
  const visit = (node: Node): void => {
    const containsRange = node.startPosition.row <= startRow && node.endPosition.row >= endRow;
    if (!containsRange) return;
    if (types.includes(node.type) && isRealDeclarationNode(node)) best = node;
    for (const child of node.children) {
      if (child !== null) visit(child);
    }
  };
  visit(tree.rootNode);
  if (best === null) return null;
  const node = best as Node;
  const text = node.text;
  const bytes = Buffer.byteLength(text, "utf8");
  const truncated = bytes > maxTextBytes;
  return {
    name: declarationName(node),
    type: node.type,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    text: truncated ? `${Buffer.from(text, "utf8").subarray(0, maxTextBytes).toString("utf8")}\n... (truncated)` : text,
  };
}

const KEYWORD_LIKE_TYPES = new Set(["identifier", "property_identifier", "shorthand_property_identifier", "type_identifier", "field_identifier"]);

/** Distinct identifier names referenced within `[startLine, endLine]`
 * (1-based, inclusive), in first-seen order. Used as seeds for "definitions
 * of identifiers on changed lines" — deliberately over-inclusive (keywords
 * are filtered by node type, not a hand-maintained builtin list) since a
 * miss here only means a definition lookup that finds nothing, never a
 * wrong one. */
export function identifiersInRange(tree: Tree, startLine: number, endLine: number): string[] {
  const startRow = Math.max(0, startLine - 1);
  const endRow = Math.max(startRow, endLine - 1);
  const seen = new Set<string>();
  const order: string[] = [];
  const nodes = tree.rootNode.descendantsOfType(
    [...KEYWORD_LIKE_TYPES],
    { row: startRow, column: 0 },
    { row: endRow, column: Number.MAX_SAFE_INTEGER },
  );
  for (const node of nodes) {
    if (node === null) continue;
    const name = node.text;
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    order.push(name);
  }
  return order;
}

/** Find a same-file declaration whose name matches `identifier` (function,
 * class, method, etc. per `DECLARATION_TYPES`). Returns the first match in
 * document order; a file can have at most one definition worth surfacing
 * per identifier at this bounded-context stage. */
export function findDefinition(tree: Tree, language: SyntaxLanguageId, identifier: string, maxTextBytes: number): EnclosingDeclaration | null {
  const types = DECLARATION_TYPES[language];
  if (types.length === 0) return null;
  let found: Node | null = null;
  const visit = (node: Node): void => {
    if (found !== null) return;
    if (types.includes(node.type) && isRealDeclarationNode(node) && declarationName(node) === identifier) {
      found = node;
      return;
    }
    for (const child of node.children) {
      if (child !== null) visit(child);
      if (found !== null) return;
    }
  };
  visit(tree.rootNode);
  if (found === null) return null;
  const node = found as Node;
  const text = node.text;
  const bytes = Buffer.byteLength(text, "utf8");
  const truncated = bytes > maxTextBytes;
  return {
    name: declarationName(node),
    type: node.type,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    text: truncated ? `${Buffer.from(text, "utf8").subarray(0, maxTextBytes).toString("utf8")}\n... (truncated)` : text,
  };
}
