/** Lexical grammar helpers shared by the syntax providers.
 *
 * These are the parts of "reading a file" that do NOT depend on a parser:
 * which languages are supported, which words are keywords, how to strip
 * comments and string literals so a hostile-looking literal cannot pose as
 * code, and how to enumerate the identifiers of a line.
 *
 * The stripping is deliberately approximate but NEVER permissive: a string
 * literal or a comment is removed rather than interpreted, so an identifier
 * that only appears inside text (`"handle("`) is not an occurrence. The
 * approximation that matters is documented at each site: a multi-line
 * template literal's interpolation is dropped with the literal, and a
 * Python triple-quoted string is treated as ending at the end of its line
 * when it does not close there. */

export const SUPPORTED_LANGUAGES = ["python", "javascript", "typescript", "go"] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** True for the languages the default structural provider can read. */
export function isSupportedLanguage(language: string): language is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(language);
}

/** Python keywords plus the two conventional receiver names (`self`/`cls`):
 * both are bound by the language, never referenced by the code under
 * review. */
const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "case", "class", "cls", "continue", "def", "del", "elif", "else", "except",
  "finally", "for", "from", "global", "if", "import", "in", "is", "lambda",
  "match", "nonlocal", "not", "or", "pass", "raise", "return", "self", "try",
  "while", "with", "yield",
]);

/** JavaScript/TypeScript reserved words, the type-position names, and the
 * module-level modifiers — none of them is a reference to a repository
 * symbol. */
const JS_KEYWORDS: ReadonlySet<string> = new Set([
  "abstract", "any", "as", "async", "await", "bigint", "boolean", "break",
  "case", "catch", "class", "const", "continue", "debugger", "declare",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "from", "function", "get", "implements", "import", "in",
  "instanceof", "interface", "is", "keyof", "let", "namespace", "never",
  "new", "null", "number", "object", "of", "override", "private",
  "protected", "public", "readonly", "return", "satisfies", "set", "static",
  "string", "super", "switch", "symbol", "this", "throw", "true", "try",
  "type", "typeof", "undefined", "unknown", "var", "void", "while", "yield",
]);

/** Go keywords plus the predeclared type names. */
const GO_KEYWORDS: ReadonlySet<string> = new Set([
  "any", "append", "bool", "break", "byte", "cap", "case", "chan", "close",
  "comparable", "complex64", "complex128", "const", "continue", "copy",
  "default", "defer", "delete", "else", "error", "false", "fallthrough",
  "float32", "float64", "for", "func", "go", "goto", "if", "import",
  "int", "int8", "int16", "int32", "int64", "interface", "iota", "len",
  "make", "map", "new", "nil", "package", "panic", "print", "println",
  "range", "real", "recover", "return", "rune", "select", "string",
  "struct", "switch", "true", "type", "uint", "uint8", "uint16", "uint32",
  "uint64", "uintptr", "var",
]);

/** True when the word is a keyword (or a language-bound receiver name) of
 * `language`, and so is never a reference to a repository symbol. */
export function isKeyword(name: string, language: string): boolean {
  if (language === "python") return PYTHON_KEYWORDS.has(name);
  if (language === "javascript" || language === "typescript") return JS_KEYWORDS.has(name);
  if (language === "go") return GO_KEYWORDS.has(name);
  return false;
}

/** The identifier pattern of a language: JavaScript and TypeScript allow `$`
 * in identifiers; Python and Go do not. */
export function identifierPattern(language: string): RegExp {
  if (language === "javascript" || language === "typescript") return /[A-Za-z_$][A-Za-z0-9_$]*/g;
  return /[A-Za-z_][A-Za-z0-9_]*/g;
}

/** The unique identifiers of a piece of code, in first-seen order. */
export function identifiersIn(code: string, language: string): string[] {
  const pattern = identifierPattern(language);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of code.matchAll(pattern)) {
    const name = match[0];
    if (name === undefined || name === "") continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Cross-line state of the code stripper: a block comment, a template
 * literal, or a Python triple-quoted string may span lines. */
interface StripState {
  blockComment: boolean;
  template: boolean;
  tripleQuote: string | null;
}

/** The index just past the quoted run that starts at `start`. */
function skipQuoted(line: string, start: number): number {
  const quote = line[start];
  let i = start + 1;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return line.length;
}

/** Strip comments and string literals from one C-like line (JavaScript,
 * TypeScript, Go). Block comments and template/raw literals may span lines;
 * their state carries over. */
function stripCLike(line: string, state: StripState): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (state.blockComment) {
      const end = line.indexOf("*/", i);
      if (end === -1) return out;
      state.blockComment = false;
      i = end + 2;
      continue;
    }
    if (state.template) {
      // The whole literal (interpolation included) is text, not code.
      const end = line.indexOf("`", i);
      if (end === -1) return out;
      state.template = false;
      i = end + 1;
      continue;
    }
    const ch = line[i] as string;
    const next = line[i + 1];
    if (ch === "/" && next === "/") break;
    if (ch === "/" && next === "*") {
      state.blockComment = true;
      i += 2;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      i = skipQuoted(line, i);
      continue;
    }
    if (ch === "`") {
      state.template = true;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Strip comments and string literals from one Python line. A triple-quoted
 * string that does not close on its line is treated as running to the end of
 * that line — an approximation, but one that errs toward DROPPING text, never
 * toward reading a literal as code. */
function stripPython(line: string, state: StripState): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (state.tripleQuote !== null) {
      const marker = state.tripleQuote;
      const end = line.indexOf(marker, i);
      if (end === -1) return out;
      state.tripleQuote = null;
      i = end + marker.length;
      continue;
    }
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      state.tripleQuote = line.slice(i, i + 3);
      i += 3;
      continue;
    }
    const ch = line[i] as string;
    if (ch === "#") break;
    if (ch === "\"" || ch === "'") {
      i = skipQuoted(line, i);
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** The file's lines with comments and string literals removed: what is left
 * is CODE, and only code can declare or reference a symbol. */
export function codeLinesFor(lines: readonly string[], language: string): string[] {
  const state: StripState = { blockComment: false, template: false, tripleQuote: null };
  const out: string[] = [];
  for (const line of lines) {
    out.push(language === "python" ? stripPython(line, state) : stripCLike(line, state));
  }
  return out;
}
