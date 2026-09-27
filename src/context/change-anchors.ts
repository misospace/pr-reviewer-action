/** Deterministic change-anchor extraction from PR diffs (#571, #706 port of
 * `pr_reviewer/change_anchors.py`).
 *
 * Turns a unified diff plus the changed-file list into the versioned
 * change-anchor artifact that `related-context` consumes: per-file declared
 * symbols, imports, enclosing declarations (#764), `changed_lines`, changed
 * keys and referenced counterparts (#791), with deterministic caps and
 * truncation flags. It performs no repository-wide search, no network calls
 * and no model calls, and never executes parsed content.
 *
 * Byte parity with v2 is the contract (the `change-anchors` parity boundary):
 * - Lengths, caps and slices count code points, as Python `len`/slicing do.
 * - Regexes are written in Python syntax and translated by `pyRe`, which maps
 *   `\s`, `\w`, `\b`, `\d`, `.` and `$` to Python `re` semantics.
 * - `strip`/`isspace`/`splitlines`/`expandtabs` use Python's definitions.
 * - Head files are read as Python does: no symlinks anywhere on the path,
 *   `O_NOFOLLOW`, regular files within the byte cap, UTF-8 with replacement.
 * Known gap: a hunk header line number beyond 2^53 loses precision. */

import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pySplitLines } from "../requirements/ledger.js";
import { pyJsonDump } from "./py-json.js";

export const ARTIFACT_VERSION = 1;

export const MAX_FILES = 100;
export const MAX_SYMBOLS_PER_FILE = 20;
export const MAX_IMPORTS_PER_FILE = 20;
export const MAX_ANCHORS = 200;
export const MAX_ENCLOSING_PER_FILE = 5;
export const MAX_ENCLOSING = 20;
export const MAX_HEAD_FILE_BYTES = 2_000_000;
export const MAX_CHANGED_RANGES_PER_FILE = 200;
export const MAX_DIFF_BYTES = 2_000_000;
export const MAX_KEYS_PER_FILE = 40;
export const MAX_KEYS = 60;
export const MAX_KEY_LINE_CHARS = 500;
export const MAX_ENTITY_WALK = 400;
export const MAX_COUNTERPART_PATHS_PER_FILE = 5;
export const MAX_COUNTERPARTS_PER_PAIR = 4;
export const MAX_COUNTERPARTS = 8;

// ---------------------------------------------------------------------------
// Python string and regex semantics
// ---------------------------------------------------------------------------

/** Python `str.isspace` / `re` `\s` for str patterns. */
const PY_WS_CLASS = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
/** Python `re` `\w` for str patterns (`str.isalnum()` or `_`). */
const PY_WORD_CLASS = "\\p{L}\\p{N}_";

function isPySpaceCode(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    (code >= 0x1c && code <= 0x20) ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** Translate a Python `re` pattern (as written in the v2 module) into an
 * equivalent `u`-mode JavaScript RegExp. */
export function pyRe(source: string, flags = ""): RegExp {
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    if (ch === "\\") {
      i += 1;
      const next = source[i] as string;
      if (next === "s") out += inClass ? PY_WS_CLASS : `[${PY_WS_CLASS}]`;
      else if (next === "S" && !inClass) out += `[^${PY_WS_CLASS}]`;
      else if (next === "w") out += inClass ? PY_WORD_CLASS : `[${PY_WORD_CLASS}]`;
      else if (next === "d") out += "\\p{Nd}";
      else if (next === "b" && !inClass) {
        out += `(?:(?<=[${PY_WORD_CLASS}])(?![${PY_WORD_CLASS}])|(?<![${PY_WORD_CLASS}])(?=[${PY_WORD_CLASS}]))`;
      } else if (next === "'" || next === '"') out += next;
      else if (next === "-") out += inClass ? "\\-" : "-";
      else if (["S", "b"].includes(next)) throw new Error(`pyRe: unsupported \\${next} in a class`);
      else out += `\\${next}`;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      out += ch;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      out += ch;
      if (source[i + 1] === "^") {
        out += "^";
        i += 1;
      }
      if (source[i + 1] === "]") {
        out += "\\]";
        i += 1;
      }
    } else if (ch === ".") out += "[^\\n]";
    else if (ch === "$") out += "(?=\\n?$)";
    else out += ch;
  }
  return new RegExp(out, `u${flags}`);
}

/** Python `len(text)`: code points, not UTF-16 units. */
export function pyLen(text: string): number {
  let count = text.length;
  for (let i = 0; i < text.length - 1; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        count -= 1;
        i += 1;
      }
    }
  }
  return count;
}

/** Python `text[:n]` for n >= 0, by code points. */
function pyHead(text: string, n: number): string {
  let seen = 0;
  let i = 0;
  while (i < text.length && seen < n) {
    const code = text.charCodeAt(i);
    const low = text.charCodeAt(i + 1);
    i += code >= 0xd800 && code <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 2 : 1;
    seen += 1;
  }
  return text.slice(0, i);
}

function pyLstrip(text: string): string {
  let i = 0;
  while (i < text.length && isPySpaceCode(text.charCodeAt(i))) i += 1;
  return text.slice(i);
}

function pyRstrip(text: string): string {
  let end = text.length;
  while (end > 0 && isPySpaceCode(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

function pyStrip(text: string): string {
  return pyRstrip(pyLstrip(text));
}

/** Python `text.strip(chars)`. */
function pyStripChars(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start] as string)) start += 1;
  while (end > start && chars.includes(text[end - 1] as string)) end -= 1;
  return text.slice(start, end);
}

function pyIsSpace(text: string): boolean {
  if (text === "") return false;
  for (let i = 0; i < text.length; i++) {
    if (!isPySpaceCode(text.charCodeAt(i))) return false;
  }
  return true;
}

function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => text.startsWith(prefix));
}

function endsWithAny(text: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => text.endsWith(suffix));
}

/** Python str ordering: by code point. */
function comparePy(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}

/** Python `sorted()` of `(line, content)` tuples. */
function sortedLines(lines: readonly [number, string][]): [number, string][] {
  return [...lines].sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : comparePy(a[1], b[1])));
}

const ND_RE = /^\p{Nd}$/u;

/** Python `int()` of a `\d+` match: any Unicode decimal digit. Decimal
 * digits are encoded in contiguous runs of ten starting at zero. */
function pyIntDigits(text: string): number {
  let value = 0n;
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    let zero = code;
    if (code < 0x30 || code > 0x39) {
      while (zero > 0 && ND_RE.test(String.fromCodePoint(zero - 1))) zero -= 1;
    } else zero = 0x30;
    value = value * 10n + BigInt((code - zero) % 10);
  }
  return Number(value);
}

/** `len(line) - len(line.expandtabs(8).lstrip())`: leading-whitespace width. */
function indentOf(line: string): number {
  let width = 0;
  let column = 0;
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (!isPySpaceCode(code)) break;
    if (code === 0x09) {
      const pad = 8 - (column % 8);
      width += pad;
      column += pad;
    } else if (code === 0x0a || code === 0x0d) {
      width += 1;
      column = 0;
    } else {
      width += 1;
      column += 1;
    }
  }
  return width;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const LANGUAGE_BY_EXT: Record<string, string> = {
  py: "python",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  go: "go",
};

const UNSUPPORTED_SOURCE_EXTS = new Set([
  "rb", "java", "kt", "cs", "php", "rs", "scala", "swift", "c", "cc",
  "cpp", "h", "hpp", "sh", "bash", "zsh", "pl", "lua", "r", "ex", "exs",
  "erl", "hs", "ml", "clj", "dart", "vue", "svelte",
]);

const NON_SOURCE_EXTS = new Set([
  "md", "rst", "txt", "json", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "lock", "csv", "xml", "svg", "png", "jpg", "jpeg", "gif", "ico", "webp",
  "pdf", "zip", "tar", "gz", "bin", "woff", "woff2", "ttf", "eot", "map",
  "wasm", "p12", "pem", "crt", "key", "env", "gitignore", "dockerignore",
]);

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extensionOf(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

/** Map a file path to a supported language name, or `unknown`. */
export function detectLanguage(path: string): string {
  const name = baseName(path);
  if (!name.includes(".")) return "unknown";
  const ext = extensionOf(name).toLowerCase();
  if (Object.hasOwn(LANGUAGE_BY_EXT, ext)) return LANGUAGE_BY_EXT[ext] as string;
  if (UNSUPPORTED_SOURCE_EXTS.has(ext)) return "unsupported";
  if (NON_SOURCE_EXTS.has(ext)) return "non_source";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Noise filtering
// ---------------------------------------------------------------------------

const KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await",
  "break", "class", "continue", "def", "del", "elif", "else", "except",
  "finally", "for", "from", "global", "if", "import", "in", "is",
  "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
  "while", "with", "yield",
  "arguments", "boolean", "case", "catch", "const", "debugger",
  "default", "delete", "do", "enum", "export", "false",
  "function", "implements", "instanceof", "interface",
  "let", "new", "null", "number", "of", "package", "private", "protected",
  "public", "static", "string", "super", "switch", "this", "throw",
  "true", "typeof", "undefined", "var", "void",
  "bool", "byte", "cap", "chan", "close", "complex", "copy",
  "fallthrough", "float32", "float64", "func", "go", "goto",
  "imag", "int", "int8", "int16", "int32", "int64", "iota",
  "len", "map", "make", "nil", "panic", "print", "println", "range",
  "recover", "struct", "type", "uint", "uint8", "uint16",
  "uint32", "uint64", "uintptr",
]);

const LOW_VALUE_NAMES = new Set([
  "self", "cls", "this", "super", "undefined", "null", "None", "True",
  "False", "nil", "default", "export", "import", "require", "module",
  "exports", "console", "process", "global", "window", "document",
  "object", "function", "class", "type", "var", "let", "const", "func",
  "struct", "interface", "package", "main", "test", "tests", "init",
  "setup", "teardown", "before", "after", "describe", "it", "expect",
  "assert", "log", "info", "warn", "error", "debug", "trace", "verbose",
  "string", "number", "boolean", "array", "list", "dict", "set", "tuple",
  "bytes", "int", "float", "complex", "bool", "byte", "rune", "any",
  "void", "never", "unknown",
]);

const URL_RE = pyRe(String.raw`^[a-z][a-z0-9+.-]*://\S+$`, "i");
const HEX_RE = pyRe(String.raw`^[0-9a-fA-F]{8,}$`);
const IDENT_RE = pyRe(String.raw`^[A-Za-z_][A-Za-z0-9_]*$`);
const MODULE_RE = pyRe(String.raw`^[A-Za-z_][A-Za-z0-9_.\-/]*$`);

function isLowValue(name: string): boolean {
  if (name === "" || pyLen(name) < 2) return true;
  if (KEYWORDS.has(name) || LOW_VALUE_NAMES.has(name)) return true;
  return URL_RE.test(name) || HEX_RE.test(name);
}

function validSymbol(name: string | undefined): name is string {
  return name !== undefined && name !== "" && IDENT_RE.test(name) && !isLowValue(name);
}

function validModule(name: string | undefined): name is string {
  return name !== undefined && name !== "" && MODULE_RE.test(name) && !isLowValue(name);
}

// ---------------------------------------------------------------------------
// Declaration / import patterns
// ---------------------------------------------------------------------------

const PY_DEF_RE = pyRe(String.raw`^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(`);
const PY_CLASS_RE = pyRe(String.raw`^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|\[|:|$)`);
const PY_IMPORT_RE = pyRe(String.raw`^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_.]*)*)`);
const PY_FROM_RE = pyRe(String.raw`^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+([A-Za-z_][A-Za-z0-9_.\s,()]+)`);
const PY_FROM_BLOCK_RE = pyRe(String.raw`^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s*\($`);
const PY_FROM_NAME_RE = pyRe(String.raw`^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*,?\s*(#.*)?$`);

const JS_FUNC_RE = pyRe(
  String.raw`^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function(?:\s*\*\s*|\s+)` +
    String.raw`([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^()]*>)?\s*\(`,
);
const JS_CLASS_RE = pyRe(
  String.raw`^\s*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)` +
    String.raw`\s*(?:\{|extends|implements|$)`,
);
const JS_ARROW_RE = pyRe(
  String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)` + String.raw`\s*=\s*(async\s+)?\(`,
);
const JS_IMPORT_RE = pyRe(String.raw`^\s*import\s+(?:type\s+)?(?:[^'\";]*?\sfrom\s+)?['\"]([^'\"]+)['\"]`);
const JS_REQUIRE_RE = pyRe(String.raw`(?<![A-Za-z0-9_$])require\s*\(\s*['\"]([^'\"]+)['\"]\s*\)`, "g");

const GO_FUNC_RE = pyRe(String.raw`^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(`);
const GO_TYPE_RE = pyRe(String.raw`^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)\b`);
const GO_BLOCK_IMPORT_RE = pyRe(String.raw`^\s*(?:[A-Za-z_][A-Za-z0-9_]*\s+)?['\"]([A-Za-z0-9_./\-]+)['\"]`);
const GO_SINGLE_IMPORT_RE = pyRe(String.raw`^\s*import\s+(?:[A-Za-z_][A-Za-z0-9_]*\s+)?['\"]([A-Za-z0-9_./\-]+)['\"]`);
const GO_IMPORT_BLOCK_RE = pyRe(String.raw`^\s*import\s*\(`);

const JS_METHOD_RE = pyRe(
  String.raw`^\s+(?:(?:public|private|protected|static|readonly|override|abstract|` +
    String.raw`async|get|set)\s+)*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^<>()]*>)?` +
    String.raw`\s*\([^()]*\)\s*(?::\s*[^={};]+)?\{\s*$`,
);

type ExtractedSymbol = [name: string, kind: string, confidence: string];

function extractPython(line: string, inFromBlock: boolean): [ExtractedSymbol[], string[], boolean] {
  const symbols: ExtractedSymbol[] = [];
  const imports: string[] = [];
  if (inFromBlock) {
    if (pyStrip(line).startsWith(")")) return [symbols, imports, false];
    const m = PY_FROM_NAME_RE.exec(line);
    if (m && validSymbol(m[1])) symbols.push([m[1], "import", "medium"]);
    return [symbols, imports, true];
  }
  let m = PY_DEF_RE.exec(line);
  if (m && validSymbol(m[1])) symbols.push([m[1], "function", "high"]);
  m = PY_CLASS_RE.exec(line);
  if (m && validSymbol(m[1])) symbols.push([m[1], "class", "high"]);
  m = PY_IMPORT_RE.exec(line);
  if (m) {
    for (const part of (m[1] as string).split(",")) {
      const mod = pyStrip((pyStrip(part).split(" as ")[0] as string));
      if (validModule(mod)) imports.push(mod);
    }
  }
  m = PY_FROM_BLOCK_RE.exec(line);
  if (m) {
    if (validModule(m[1])) imports.push(m[1]);
    return [symbols, imports, true];
  }
  m = PY_FROM_RE.exec(line);
  if (m) {
    if (validModule(m[1])) imports.push(m[1]);
    for (const part of (m[2] as string).split(",")) {
      const name = pyStripChars(pyStrip(part).split(" as ")[0] as string, "() ");
      if (validSymbol(name)) symbols.push([name, "import", "medium"]);
    }
  }
  return [symbols, imports, false];
}

function extractJs(line: string): [ExtractedSymbol[], string[]] {
  const symbols: ExtractedSymbol[] = [];
  const imports: string[] = [];
  let m = JS_FUNC_RE.exec(line);
  if (m && validSymbol(m[1])) symbols.push([m[1], "function", "high"]);
  m = JS_CLASS_RE.exec(line);
  if (m && validSymbol(m[1])) symbols.push([m[1], "class", "high"]);
  m = JS_ARROW_RE.exec(line);
  if (m && validSymbol(m[1])) symbols.push([m[1], "function", "medium"]);
  m = JS_IMPORT_RE.exec(line);
  if (m && validModule(m[1])) imports.push(m[1]);
  for (const req of line.matchAll(JS_REQUIRE_RE)) {
    if (validModule(req[1])) imports.push(req[1]);
  }
  return [symbols, imports];
}

function extractGo(line: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  let m = GO_FUNC_RE.exec(line);
  if (m && validSymbol(m[1])) symbols.push([m[1], "function", "high"]);
  m = GO_TYPE_RE.exec(line);
  if (m && validSymbol(m[1])) symbols.push([m[1], "type", "high"]);
  return symbols;
}

function extractImportsGo(line: string, inImportBlock: boolean): [string[], boolean] {
  const imports: string[] = [];
  if (GO_IMPORT_BLOCK_RE.test(line)) return [imports, true];
  if (inImportBlock) {
    if (pyStrip(line) === ")") return [imports, false];
    const m = GO_BLOCK_IMPORT_RE.exec(line);
    if (m && validModule(m[1])) imports.push(m[1]);
    return [imports, true];
  }
  const m = GO_SINGLE_IMPORT_RE.exec(line);
  if (m && validModule(m[1])) imports.push(m[1]);
  return [imports, false];
}

// ---------------------------------------------------------------------------
// Unified diff parsing
// ---------------------------------------------------------------------------

const HUNK_RE = pyRe(String.raw`^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@`);

interface FileState {
  path: string;
  oldPath: string;
  deleted: boolean;
  added: boolean;
  binary: boolean;
  inHunk: boolean;
  newLine: number;
  addedLines: [number, string][];
  contextLines: [number, string][];
  newSideLines: [number, string][];
  changeRuns: [number, string][];
  removedLines: string[];
  inRun: boolean;
  runOpen: boolean;
}

function newFileState(path: string, oldPath = "", deleted = false): FileState {
  return {
    path,
    oldPath,
    deleted,
    added: false,
    binary: false,
    inHunk: false,
    newLine: 0,
    addedLines: [],
    contextLines: [],
    newSideLines: [],
    changeRuns: [],
    removedLines: [],
    inRun: false,
    runOpen: false,
  };
}

const PATH_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  a: "\x07",
  f: "\f",
  v: "\v",
  "\\": "\\",
  '"': '"',
};

const OCTAL = "01234567";

/** Python `str.encode("utf-8", errors="surrogateescape")` for one code point. */
function encodeCodePoint(code: number, out: number[]): void {
  if (code >= 0xdc80 && code <= 0xdcff) {
    out.push(code - 0xdc00);
    return;
  }
  out.push(...Buffer.from(String.fromCodePoint(code), "utf8"));
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decode the body of a C-style quoted diff path token (octal byte escapes
 * reassembled as UTF-8, latin-1 fallback). */
function decodeCQuoted(inner: string): string {
  const chars = Array.from(inner);
  const out: number[] = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i] as string;
    if (c === "\\" && i + 1 < chars.length) {
      const next = chars[i + 1] as string;
      if (OCTAL.includes(next)) {
        let digits = next;
        let j = i + 2;
        while (j < chars.length && digits.length < 3 && OCTAL.includes(chars[j] as string)) {
          digits += chars[j] as string;
          j += 1;
        }
        const value = Number.parseInt(digits, 8);
        if (value <= 255) {
          out.push(value);
          i = j;
          continue;
        }
        out.push(0x5c);
        i += 1;
        continue;
      }
      const mapped = Object.hasOwn(PATH_ESCAPES, next) ? (PATH_ESCAPES[next] as string) : next;
      for (const ch of mapped) encodeCodePoint(ch.codePointAt(0) as number, out);
      i += 2;
      continue;
    }
    encodeCodePoint(c.codePointAt(0) as number, out);
    i += 1;
  }
  const bytes = Uint8Array.from(out);
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    let latin1 = "";
    for (const byte of bytes) latin1 += String.fromCharCode(byte);
    return latin1;
  }
}

/** Parse one quoted or unquoted path token from the start of `text`. */
function parsePathToken(text: string): [string | null, string] {
  if (text === "") return [null, text];
  if (text.startsWith('"')) {
    let i = 1;
    while (i < text.length) {
      const c = text[i];
      if (c === "\\" && i + 1 < text.length) {
        i += 2;
        continue;
      }
      if (c === '"') return [decodeCQuoted(text.slice(1, i)), text.slice(i + 1)];
      i += 1;
    }
    return [null, text];
  }
  let i = 0;
  while (i < text.length && !isPySpaceCode(text.charCodeAt(i))) i += 1;
  return [text.slice(0, i), text.slice(i)];
}

function parseDiffGitLine(line: string): [string, string] | null {
  const prefix = "diff --git ";
  if (!line.startsWith(prefix)) return null;
  let rest = line.slice(prefix.length);
  let oldPath: string | null;
  if (rest.startsWith('"')) {
    [oldPath, rest] = parsePathToken(rest);
    if (oldPath === null) return null;
    let i = 0;
    while (i < rest.length && isPySpaceCode(rest.charCodeAt(i))) i += 1;
    rest = rest.slice(i);
  } else {
    if (!rest.startsWith("a/")) return null;
    rest = rest.slice(2);
    const sep = rest.indexOf(" b/");
    if (sep === -1) return null;
    oldPath = rest.slice(0, sep);
    rest = rest.slice(sep + 1);
  }
  let newPath: string | null;
  if (rest.startsWith('"')) {
    [newPath, rest] = parsePathToken(rest);
    if (newPath === null) return null;
  } else {
    if (!rest.startsWith("b/")) return null;
    newPath = pyRstrip(rest.slice(2));
    rest = "";
  }
  if (rest !== "" && !pyIsSpace(rest)) return null;
  return [oldPath, newPath];
}

function parseRenameLine(line: string, target: "from" | "to"): string | null {
  const prefix = `rename ${target} `;
  if (!line.startsWith(prefix)) return null;
  const [path, rest] = parsePathToken(line.slice(prefix.length));
  if (path === null) return null;
  if (target === "from") {
    if (!rest.startsWith("to ")) return null;
    const [, rest2] = parsePathToken(rest.slice(3));
    if (rest2 !== "" && !pyIsSpace(rest2)) return null;
  } else if (rest !== "" && !pyIsSpace(rest)) {
    return null;
  }
  return path;
}

function cleanDiffPath(raw: string): string {
  const p = raw.split("\0", 1)[0] as string;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  if ((p.startsWith('"a/') || p.startsWith('"b/')) && p.endsWith('"')) return decodeCQuoted(p.slice(3, -1));
  if (p === '"/dev/null"') return "/dev/null";
  return p;
}

/** Parse a unified diff into per-file states with added-line tracking. */
function parseDiff(diffText: string): FileState[] {
  const files: FileState[] = [];
  let current: FileState | null = null;
  for (const line of pySplitLines(diffText)) {
    if (line.startsWith("diff --git ")) {
      const parsed = parseDiffGitLine(line);
      if (parsed) {
        current = newFileState(cleanDiffPath(parsed[1]));
        if (cleanDiffPath(parsed[0]) !== current.path) current.oldPath = cleanDiffPath(parsed[0]);
        files.push(current);
      } else {
        current = null;
      }
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("Binary files ")) {
      current.binary = true;
      current.inHunk = false;
      continue;
    }
    if (line.startsWith("new file mode")) {
      current.added = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.deleted = true;
      current.inHunk = false;
      continue;
    }
    if (line.startsWith("old mode") || line.startsWith("new mode") || line.startsWith("index ")) continue;
    if (line.startsWith("--- ")) {
      const p = cleanDiffPath(line.slice(4).split("\t", 1)[0] as string);
      if (p !== "/dev/null") current.oldPath = p;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = cleanDiffPath(line.slice(4).split("\t", 1)[0] as string);
      if (p !== "/dev/null") current.path = p;
      else {
        current.deleted = true;
        current.inHunk = false;
      }
      continue;
    }
    if (line.startsWith("rename from ")) {
      const p = parseRenameLine(line, "from");
      if (p !== null) current.oldPath = p;
      continue;
    }
    if (line.startsWith("rename to ")) {
      const p = parseRenameLine(line, "to");
      if (p !== null) current.path = p;
      continue;
    }
    if (line.startsWith("copy from ") || line.startsWith("copy to ")) continue;

    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      current.inHunk = true;
      current.inRun = false;
      current.newLine = pyIntDigits(hunk[3] as string);
      continue;
    }
    if (!current.inHunk) continue;

    if (line.startsWith("+") || line.startsWith("-")) {
      if (!current.inRun) {
        current.inRun = true;
        current.runOpen = true;
      }
      if (current.runOpen && pyStrip(line.slice(1)) !== "") {
        current.changeRuns.push([current.newLine, line.slice(1)]);
        current.runOpen = false;
      }
    }
    if (line.startsWith("+")) {
      current.addedLines.push([current.newLine, line.slice(1)]);
      current.newSideLines.push([current.newLine, line.slice(1)]);
      current.newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      current.removedLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith(" ")) {
      const content = line.slice(1);
      current.inRun = false;
      current.newSideLines.push([current.newLine, content]);
      const stripped = pyStrip(content);
      const lang = detectLanguage(current.path);
      if (lang === "python") {
        if (PY_FROM_BLOCK_RE.test(content) || stripped.startsWith(")")) current.contextLines.push([current.newLine, content]);
      } else if (lang === "go") {
        if (GO_IMPORT_BLOCK_RE.test(content) || stripped === ")") current.contextLines.push([current.newLine, content]);
      }
      current.newLine += 1;
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Workspace reads (Path.resolve / read_head_lines semantics)
// ---------------------------------------------------------------------------

/** Port of Python's non-strict `os.path.realpath` (3.14): missing components
 * are kept, a symlink loop is left unresolved, OS errors are ignored. */
export function pyRealpath(filename: string): string {
  const rest: (string | null)[] = filename.split("/").reverse();
  let partCount = rest.length;
  let path = filename.startsWith("/") ? "/" : process.cwd();
  const seen = new Map<string, string | null>();
  while (partCount > 0) {
    const name = rest.pop();
    if (name === null) {
      seen.set(rest.pop() as string, path);
      continue;
    }
    partCount -= 1;
    if (name === undefined || name === "" || name === ".") continue;
    if (name === "..") {
      path = path.slice(0, path.lastIndexOf("/")) || "/";
      continue;
    }
    const newPath = path === "/" ? `/${name}` : `${path}/${name}`;
    let target: string;
    try {
      if (!lstatSync(newPath).isSymbolicLink()) {
        path = newPath;
        continue;
      }
      if (seen.has(newPath)) {
        const cached = seen.get(newPath) ?? null;
        path = cached ?? newPath;
        continue;
      }
      target = readlinkSync(newPath);
    } catch {
      path = newPath;
      continue;
    }
    if (target.startsWith("/")) path = "/";
    seen.set(newPath, null);
    rest.push(newPath, null);
    const targetParts = target.split("/").reverse();
    rest.push(...targetParts);
    partCount += targetParts.length;
  }
  return path;
}

const UTF8_REPLACE = new TextDecoder("utf-8", { ignoreBOM: true });

function decodeReplace(data: Uint8Array): string {
  return UTF8_REPLACE.decode(data);
}

/** Read a changed file from the head checkout, or null. The path must be a
 * plain relative path inside `sourceRoot`: absolute paths, empty/`.`/`..`/
 * `.git` components, NUL bytes, and any symlink along the way are refused;
 * only regular files up to `MAX_HEAD_FILE_BYTES` are read. Never throws. */
export function readHeadLines(sourceRoot: string, relPath: string): string[] | null {
  if (relPath === "" || relPath.includes("\0") || relPath.startsWith("/")) return null;
  const parts = relPath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part === ".git")) return null;
  if (sourceRoot.includes("\0")) return null;
  let fd: number;
  try {
    const root = pyRealpath(sourceRoot);
    const candidate = root === "/" ? `/${parts.join("/")}` : `${root}/${parts.join("/")}`;
    if (pyRealpath(candidate) !== candidate) return null;
    fd = openSync(candidate, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  let data: Buffer;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_HEAD_FILE_BYTES) return null;
    data = Buffer.alloc(MAX_HEAD_FILE_BYTES + 1);
    let filled = 0;
    while (filled < data.length) {
      const read = readSync(fd, data, filled, data.length - filled, null);
      if (read === 0) break;
      filled += read;
    }
    data = data.subarray(0, filled);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  if (data.length > MAX_HEAD_FILE_BYTES) return null;
  return decodeReplace(data).split("\n").map((line) => line.replace(/\r+$/, ""));
}

function headMatchesDiff(state: FileState, headLines: string[]): boolean {
  for (const [lineNo, content] of state.newSideLines) {
    if (lineNo < 1 || lineNo > headLines.length || headLines[lineNo - 1] !== content) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Enclosing declarations (#764)
// ---------------------------------------------------------------------------

const CLOSERS = [")", "]", "}"] as const;
const COMMENT_PREFIXES: Record<string, readonly string[]> = {
  python: ["#"],
  javascript: ["//", "/*", "*"],
  typescript: ["//", "/*", "*"],
  go: ["//", "/*", "*"],
};

function declarationAt(line: string, language: string): [string, string] | null {
  let patterns: [RegExp, string][];
  if (language === "python") patterns = [[PY_DEF_RE, "high"], [PY_CLASS_RE, "high"]];
  else if (language === "go") patterns = [[GO_FUNC_RE, "high"], [GO_TYPE_RE, "high"]];
  else patterns = [[JS_FUNC_RE, "high"], [JS_CLASS_RE, "high"], [JS_ARROW_RE, "medium"], [JS_METHOD_RE, "high"]];
  for (const [pattern, confidence] of patterns) {
    const m = pattern.exec(line);
    if (m) return [m[1] as string, confidence];
  }
  return null;
}

function enclosingNameOk(name: string): boolean {
  if (!validSymbol(name) || name === "constructor") return false;
  return !(name.startsWith("__") && name.endsWith("__"));
}

/** Find the declaration enclosing a change, walking up from `startLine`.
 * Returns `[name, confidence, declarationLine]` or null. */
function findEnclosingDeclaration(
  headLines: string[],
  startLine: number,
  changed: string,
  language: string,
): [string, string, number] | null {
  let ceiling = indentOf(changed);
  if (startsWithAny(pyLstrip(changed), CLOSERS)) ceiling += 1;
  const comments = COMMENT_PREFIXES[language] ?? [];
  for (let lineNo = Math.min(startLine - 1, headLines.length); lineNo > 0; lineNo--) {
    const line = headLines[lineNo - 1] as string;
    const stripped = pyStrip(line);
    if (stripped === "" || startsWithAny(stripped, comments)) continue;
    const indent = indentOf(line);
    if (indent >= ceiling) continue;
    const decl = declarationAt(line, language);
    if (decl && enclosingNameOk(decl[0])) return [decl[0], decl[1], lineNo];
    if (!decl && startsWithAny(stripped, CLOSERS)) continue;
    ceiling = indent;
    if (ceiling === 0) break;
  }
  return null;
}

function changedLineRanges(state: FileState): [number, number][] {
  const ranges: [number, number][] = [];
  for (const [lineNo] of sortedLines(state.addedLines)) {
    const last = ranges[ranges.length - 1];
    if (last && lineNo <= last[1] + 1) last[1] = Math.max(last[1], lineNo);
    else ranges.push([lineNo, lineNo]);
  }
  return ranges;
}

function enclosingSymbols(state: FileState, language: string, headLines: string[]): [string, string, number][] {
  const found: [string, string, number][] = [];
  const seen = new Set<string>();
  for (const [startLine, changed] of state.changeRuns) {
    const decl = findEnclosingDeclaration(headLines, startLine, changed, language);
    if (decl && !seen.has(decl[0])) {
      seen.add(decl[0]);
      found.push(decl);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Changed keys and referenced counterparts (#791)
// ---------------------------------------------------------------------------

const DATA_FORMATS: Record<string, string> = { yaml: "yaml", yml: "yaml", json: "json", toml: "toml" };
const DECLARATION_LANGUAGES = ["python", "javascript", "typescript", "go"];
const KEY_SPLIT_RE = pyRe(String.raw`[^A-Za-z0-9]+`);
const CAMEL_RE = pyRe(String.raw`([a-z0-9])([A-Z])`, "g");
const ENV_NAME_RE = pyRe(String.raw`(?<![A-Za-z0-9_$])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![A-Za-z0-9_])`, "g");
const FLAG_RE = pyRe(String.raw`(?<![A-Za-z0-9_\-])--[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![A-Za-z0-9_\-])`, "g");
const PATH_MENTION_RE = pyRe(
  String.raw`(?<![A-Za-z0-9_./\-])((?:[A-Za-z0-9_\-][A-Za-z0-9_.\-]*/)+[A-Za-z0-9_\-][A-Za-z0-9_.\-]*\.[A-Za-z0-9]+)`,
  "g",
);
const YAML_ITEM_RE = pyRe(String.raw`^\s*-(?:\s|$)`);
const YAML_ID_RE = pyRe(String.raw`^\s*(?:-\s+)?(?:id|name|key)\s*:\s+["']?([A-Za-z_][A-Za-z0-9_.\-]*)["']?\s*(?:#.*)?$`);
const YAML_KEY_RE = pyRe(String.raw`^\s*(?:-\s+)?["']?([A-Za-z0-9_][A-Za-z0-9_.\-/]*)["']?\s*:(?:\s+(.*))?$`);
const JSON_ID_RE = pyRe(String.raw`^\s*"(?:id|name|key)"\s*:\s*"([A-Za-z_][A-Za-z0-9_.\-]*)"\s*,?\s*$`);
const JSON_KEY_RE = pyRe(String.raw`^\s*"([^"\\]{1,100})"\s*:\s*(.*?)\s*$`);
const TOML_HEADER_RE = pyRe(String.raw`^\s*(\[\[?)\s*([A-Za-z0-9_.\-]+)\s*\]\]?\s*(?:#.*)?$`);
const TOML_ID_RE = pyRe(String.raw`^\s*(?:id|name|key)\s*=\s*["']([A-Za-z_][A-Za-z0-9_.\-]*)["']\s*(?:#.*)?$`);
const STRING_RE = pyRe(String.raw`(["'])([^"'\\\n]{1,60})\1`, "g");
const WORD_RE = pyRe(String.raw`[A-Za-z0-9_.\-]+`, "g");
const BRANCH_ASSIGN_RE = pyRe(
  String.raw`(?<![\w.$])(?:"?\$\{?)?([A-Za-z_][A-Za-z0-9_]*)\}?"?\s*(===|!==|==|!=|=)\s*["']`,
  "gd",
);
const TRAILING_WORD_RE = pyRe(String.raw`([A-Za-z_][A-Za-z0-9_]*)$`);
const DECLARATION_KEYWORDS = new Set([
  "const", "declare", "export", "final", "let", "local", "private", "protected",
  "public", "readonly", "static", "type", "var",
]);
const BRANCH_IN_RE = pyRe(String.raw`(?<![\w.$])([A-Za-z_][A-Za-z0-9_]*)\s+(?:not\s+)?in\s*[(\[{]\s*["']`, "gd");
const RETURN_LITERAL_RE = pyRe(String.raw`^\s*return\s+["']`);
const CASE_ARM_RE = pyRe(
  String.raw`^\s*(?:case\s+(["'])([^"'\\\n]{1,60})\1\s*:|([A-Za-z0-9_.*\-]+(?:\s*\|\s*[A-Za-z0-9_.*\-]+)*)\s*\))`,
);
const CASE_HEADER_RE = pyRe(
  String.raw`^\s*(?:case\s+"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?\s+in\b|switch\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)|match\s+([A-Za-z_][A-Za-z0-9_]*)\s*:)`,
);
const LINE_COMMENT_PREFIXES = ["#", "//", "/*", "*"];
const LOW_VALUE_ENV_PREFIXES = ["GITHUB_", "RUNNER_", "ACTIONS_", "NODE_", "NPM_", "PYTHON", "LC_", "XDG_"];
const LOW_VALUE_FLAGS = new Set([
  "--dry-run", "--no-verify", "--no-color", "--no-cache", "--no-cache-dir",
  "--no-edit", "--no-pager", "--no-deps", "--name-only", "--frozen-lockfile",
  "--ignore-scripts", "--save-dev", "--no-install-recommends", "--fail-fast",
  "--force-with-lease",
]);
const LOW_VALUE_ENTITIES = new Set([
  "pullrequest", "pullrequesttarget", "workflowdispatch", "workflowcall",
  "devdependencies", "peerdependencies", "optionaldependencies",
  "compileroptions", "runson", "timeoutminutes", "workingdirectory",
  "continueonerror", "cancelinprogress", "fetchdepth", "nodeversion",
  "pythonversion", "githubtoken",
]);
const LOW_VALUE_BRANCH_NAMES = new Set([
  "action", "content", "default", "encoding", "errors", "format", "label",
  "language", "length", "level", "message", "method", "number", "object",
  "option", "options", "output", "prefix", "reason", "request", "response",
  "result", "scheme", "source", "status", "stderr", "stdout", "string",
  "suffix", "target", "title", "value", "values", "version",
]);

const TEST_BASE_RE = pyRe(
  String.raw`^(?:test[-_].+|.+[_-]tests?\..+|.+\.(?:test|spec)(?:\.[^.]+)?|.+_test\.go)$`,
  "i",
);
const GENERATED_DIRS = new Set(["dist", "build", "vendor", "node_modules", "third_party"]);
const TEST_DIRS = new Set(["test", "tests", "spec", "specs", "testing", "__tests__"]);
const LOCKFILE_RE = pyRe(String.raw`[-.]lock\.(?:json|ya?ml)$`);

export function isTestPath(path: string): boolean {
  const parts = path.split("/").map((part) => part.toLowerCase());
  const base = parts[parts.length - 1] as string;
  if (parts.slice(0, -1).some((part) => TEST_DIRS.has(part))) return true;
  return TEST_BASE_RE.test(base) || base.endsWith("_test.go");
}

/** Lowercase words of a key, env name, or flag (`--`/`INPUT_` stripped). */
export function keyWords(name: string): string[] {
  let base = name.replace(/^-+/, "");
  if (base.startsWith("INPUT_")) base = base.slice("INPUT_".length);
  const words: string[] = [];
  for (let part of base.split(KEY_SPLIT_RE)) {
    if (part === "") continue;
    if (part !== part.toUpperCase()) part = part.replace(CAMEL_RE, "$1 $2");
    words.push(...part.toLowerCase().split(" ").filter((word) => word !== ""));
  }
  return words;
}

/** Whether a changed key is specific enough to search for consumers. */
export function keyOk(name: string, kind: string): boolean {
  const words = keyWords(name);
  const joined = words.join("");
  if (words.length === 0 || (words[0] as string).length < 2 || pyLen(name) > 80 || joined.length < 6) return false;
  if (kind === "branch") return !LOW_VALUE_BRANCH_NAMES.has(joined) && !isLowValue(name);
  if (words.length < 2) return false;
  if (kind === "env") return !startsWithAny(name, LOW_VALUE_ENV_PREFIXES);
  if (kind === "flag") return !LOW_VALUE_FLAGS.has(name);
  return !LOW_VALUE_ENTITIES.has(joined);
}

function isLockfile(name: string): boolean {
  return endsWithAny(name, [".lock", ".sum"]) || LOCKFILE_RE.test(name);
}

export function dataFormat(path: string): string | null {
  const name = baseName(path).toLowerCase();
  if (!name.includes(".") || isLockfile(name)) return null;
  const ext = extensionOf(name);
  return Object.hasOwn(DATA_FORMATS, ext) ? (DATA_FORMATS[ext] as string) : null;
}

function scansKeys(path: string, language: string): boolean {
  const parts = path.toLowerCase().split("/");
  const last = parts[parts.length - 1] as string;
  if (isLockfile(last) || last.endsWith(".min.js") || isTestPath(path)) return false;
  if (parts.slice(0, -1).some((part) => GENERATED_DIRS.has(part))) return false;
  if (dataFormat(path)) return true;
  return ["python", "javascript", "typescript", "go", "unsupported", "unknown"].includes(language);
}

function dataComment(stripped: string, fmt: string): boolean {
  return (fmt !== "json" && stripped.startsWith("#")) || stripped === "---";
}

function itemId(line: string, fmt: string): string | null {
  const m = (fmt === "json" ? JSON_ID_RE : YAML_ID_RE).exec(line);
  return m ? (m[1] as string) : null;
}

function opensItem(line: string, fmt: string): boolean {
  if (fmt === "json") return pyStrip(line) === "{" && indentOf(line) > 0;
  return YAML_ITEM_RE.test(line);
}

function containerKey(line: string, fmt: string): string | null {
  if (fmt === "json") {
    const m = JSON_KEY_RE.exec(line);
    if (m && ["{", "["].includes((m[2] as string).replace(/,+$/, ""))) return m[1] as string;
    return null;
  }
  const m = YAML_KEY_RE.exec(line);
  if (!m) return null;
  const value = pyStrip(m[2] ?? "");
  if (value === "" || value.startsWith("#") || value.startsWith("&")) return m[1] as string;
  return null;
}

function blockId(lines: string[], opener: number, fmt: string): string | null {
  const name = itemId(lines[opener - 1] as string, fmt);
  if (name) return name;
  const base = indentOf(lines[opener - 1] as string);
  let content: number | null = null;
  const last = Math.min(lines.length, opener + MAX_ENTITY_WALK);
  for (let lineNo = opener + 1; lineNo <= last; lineNo++) {
    const line = lines[lineNo - 1] as string;
    const stripped = pyStrip(line);
    if (stripped === "" || dataComment(stripped, fmt)) continue;
    const indent = indentOf(line);
    if (indent <= base) break;
    if (content === null) content = indent;
    if (indent === content) {
      const found = itemId(line, fmt);
      if (found) return found;
    }
  }
  return null;
}

function tomlEntity(lines: string[], lineNo: number): string | null {
  const stop = Math.max(0, lineNo - MAX_ENTITY_WALK);
  for (let headerNo = lineNo; headerNo > stop; headerNo--) {
    const m = TOML_HEADER_RE.exec(lines[headerNo - 1] as string);
    if (!m) continue;
    if (m[1] === "[[") {
      const last = Math.min(lines.length, headerNo + MAX_ENTITY_WALK);
      for (let itemNo = headerNo + 1; itemNo <= last; itemNo++) {
        if (TOML_HEADER_RE.test(lines[itemNo - 1] as string)) break;
        const idm = TOML_ID_RE.exec(lines[itemNo - 1] as string);
        if (idm && keyOk(idm[1] as string, "entity")) return idm[1] as string;
      }
    }
    const header = m[2] as string;
    const name = header.slice(header.lastIndexOf(".") + 1);
    return keyOk(name, "entity") ? name : null;
  }
  return null;
}

/** Name of the config entity a head line belongs to, walking up by indentation. */
export function resolveEntity(lines: string[], lineNo: number, fmt: string): string | null {
  if (lineNo < 1 || lineNo > lines.length) return null;
  if (fmt === "toml") return tomlEntity(lines, lineNo);
  const target = lines[lineNo - 1] as string;
  const targetStripped = pyStrip(target);
  if (targetStripped === "" || dataComment(targetStripped, fmt)) return null;
  for (const name of [itemId(target, fmt), containerKey(target, fmt)]) {
    if (name && keyOk(name, "entity")) return name;
  }
  let ceiling = indentOf(target);
  const stop = Math.max(0, lineNo - 1 - MAX_ENTITY_WALK);
  for (let walkNo = lineNo - 1; walkNo > stop; walkNo--) {
    const line = lines[walkNo - 1] as string;
    const stripped = pyStrip(line);
    if (stripped === "" || dataComment(stripped, fmt)) continue;
    const indent = indentOf(line);
    if (indent >= ceiling) continue;
    ceiling = indent;
    let name = opensItem(line, fmt) ? blockId(lines, walkNo, fmt) : itemId(line, fmt);
    if (name === null) name = containerKey(line, fmt);
    if (name && keyOk(name, "entity")) return name;
    if (ceiling === 0) break;
  }
  return null;
}

function removedLiterals(state: FileState): Set<string> {
  const literals = new Set<string>();
  for (const content of state.removedLines) {
    if (pyLen(content) > MAX_KEY_LINE_CHARS) continue;
    for (const m of content.matchAll(STRING_RE)) literals.add(m[2] as string);
    for (const m of content.matchAll(WORD_RE)) literals.add(m[0]);
  }
  return literals;
}

function caseSubject(lines: string[], lineNo: number): string | null {
  const ceiling = indentOf(lines[lineNo - 1] as string);
  const stop = Math.max(0, lineNo - 1 - MAX_ENTITY_WALK);
  for (let walkNo = lineNo - 1; walkNo > stop; walkNo--) {
    const line = lines[walkNo - 1] as string;
    if (pyStrip(line) === "" || indentOf(line) >= ceiling) continue;
    const m = CASE_HEADER_RE.exec(line);
    if (!m) return null;
    return m.slice(1).find((group) => group) ?? null;
  }
  return null;
}

/** Variables an added line compares, assigns, or returns a new string literal for. */
export function branchNames(content: string, lineNo: number, headLines: string[], language: string, removed: Set<string>): string[] {
  const stripped = pyStrip(content);
  if (stripped === "" || startsWithAny(stripped, LINE_COMMENT_PREFIXES)) return [];
  const literals: [number, string][] = [];
  for (const lit of content.matchAll(STRING_RE)) {
    const value = lit[2] as string;
    if (!value.includes("$")) literals.push([lit.index, value]);
  }
  const names: string[] = [];
  for (const pattern of [BRANCH_ASSIGN_RE, BRANCH_IN_RE]) {
    for (const m of content.matchAll(pattern)) {
      const before = pyRstrip(content.slice(0, m.index));
      if (endsWithAny(before, ["(", ",", ":"])) continue;
      const word = TRAILING_WORD_RE.exec(before);
      const prior = word ? (word[1] as string) : "";
      if (prior === "typeof") continue;
      if (pattern === BRANCH_ASSIGN_RE && m[2] === "=" && DECLARATION_KEYWORDS.has(prior)) continue;
      const end1 = (m.indices?.[1] as [number, number])[1];
      if (literals.some(([start, value]) => start >= end1 && !removed.has(value))) names.push(m[1] as string);
    }
  }
  if (RETURN_LITERAL_RE.test(content) && DECLARATION_LANGUAGES.includes(language)) {
    if (literals.some(([, value]) => !removed.has(value))) {
      const decl = findEnclosingDeclaration(headLines, lineNo, content, language);
      if (decl) names.push(decl[0]);
    }
  }
  const arm = CASE_ARM_RE.exec(content);
  if (arm) {
    const values = arm[2] ? [arm[2]] : (arm[3] as string).split("|").map((part) => pyStrip(part));
    if (values.some((value) => !removed.has(value)) && lineNo <= headLines.length) {
      const subject = caseSubject(headLines, lineNo);
      if (subject) names.push(subject);
    }
  }
  return names;
}

interface ChangedKey {
  name: string;
  kind: string;
  line: number;
}

function changedKeys(state: FileState, language: string, headLines: string[]): ChangedKey[] {
  const fmt = dataFormat(state.path);
  const removed = fmt ? new Set<string>() : removedLiterals(state);
  const keys: ChangedKey[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: string, lineNo: number): void => {
    if (!seen.has(name) && keyOk(name, kind)) {
      seen.add(name);
      keys.push({ name, kind, line: lineNo });
    }
  };
  for (const [lineNo, content] of sortedLines(state.addedLines)) {
    if (pyLen(content) > MAX_KEY_LINE_CHARS) continue;
    if (fmt) {
      const entity = resolveEntity(headLines, lineNo, fmt);
      if (entity) add(entity, "entity", lineNo);
    }
    for (const m of content.matchAll(ENV_NAME_RE)) add(m[0], "env", lineNo);
    for (const m of content.matchAll(FLAG_RE)) add(m[0], "flag", lineNo);
    if (!fmt) {
      for (const name of branchNames(content, lineNo, headLines, language, removed)) add(name, "branch", lineNo);
    }
    if (keys.length > MAX_KEYS_PER_FILE) break;
  }
  return keys;
}

/** `buildPrMetadata` and `_build_pr_metadata` both become `buildprmetadata`. */
export function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Last line of the declaration at `lineNo`: its more-indented body plus
 * closers at its own level. */
export function declarationEnd(lines: string[], lineNo: number): number {
  const base = indentOf(lines[lineNo - 1] as string);
  let end = lineNo;
  const last = Math.min(lines.length, lineNo + MAX_ENTITY_WALK);
  for (let nextNo = lineNo + 1; nextNo <= last; nextNo++) {
    const line = lines[nextNo - 1] as string;
    const stripped = pyStrip(line);
    if (stripped === "") continue;
    const indent = indentOf(line);
    if (indent > base || (indent === base && startsWithAny(stripped, CLOSERS))) {
      end = nextNo;
      continue;
    }
    break;
  }
  return end;
}

interface CounterpartEntry {
  name: string;
  line: number;
  refPath: string;
  refName: string;
  refLine: number;
  refEnd: number;
  refChanged: boolean;
}

interface AnchorSymbolEntry {
  name: string;
  kind: string;
  confidence: string;
  line: number;
}

function counterparts(
  state: FileState,
  language: string,
  headLines: string[],
  enclosing: AnchorSymbolEntry[],
  sourceRoot: string,
  diffAdded: Map<string, Set<number>>,
  budget: number,
): [CounterpartEntry[], boolean] {
  const changed = new Map<string, [string, number]>();
  const candidates: [number, [string, string] | null][] = [];
  for (const [lineNo] of sortedLines(state.addedLines)) {
    if (lineNo <= headLines.length) candidates.push([lineNo, declarationAt(headLines[lineNo - 1] as string, language)]);
  }
  for (const sym of enclosing) candidates.push([sym.line, [sym.name, sym.confidence]]);
  candidates.sort((a, b) => a[0] - b[0]);
  for (const [lineNo, decl] of candidates) {
    if (decl && enclosingNameOk(decl[0])) {
      const norm = normalizedName(decl[0]);
      if (norm.length >= 4 && !changed.has(norm)) changed.set(norm, [decl[0], lineNo]);
    }
  }
  if (changed.size === 0) return [[], false];

  const paths: string[] = [];
  for (const [, content] of sortedLines(state.addedLines)) {
    if (pyLen(content) > MAX_KEY_LINE_CHARS) continue;
    for (const m of content.matchAll(PATH_MENTION_RE)) {
      const path = m[1] as string;
      if (path !== state.path && !paths.includes(path) && DECLARATION_LANGUAGES.includes(detectLanguage(path))) paths.push(path);
    }
  }

  const found: CounterpartEntry[] = [];
  let truncated = false;
  let readable = 0;
  for (const path of paths) {
    if (readable >= MAX_COUNTERPART_PATHS_PER_FILE) {
      truncated = true;
      break;
    }
    const refLines = readHeadLines(sourceRoot, path);
    if (refLines === null) continue;
    readable += 1;
    const refLanguage = detectLanguage(path);
    const added = diffAdded.get(path) ?? new Set<number>();
    const matches: [boolean, CounterpartEntry][] = [];
    refLines.forEach((line, index) => {
      const refNo = index + 1;
      const decl = declarationAt(line, refLanguage);
      if (!decl || !enclosingNameOk(decl[0])) return;
      const match = changed.get(normalizedName(decl[0]));
      if (match === undefined) return;
      const refEnd = declarationEnd(refLines, refNo);
      let touched = 0;
      for (let n = refNo; n <= refEnd; n++) if (added.has(n)) touched += 1;
      if (touched === refEnd - refNo + 1) return;
      matches.push([touched === 0, {
        name: match[0],
        line: match[1],
        refPath: path,
        refName: decl[0],
        refLine: refNo,
        refEnd,
        refChanged: touched > 0,
      }]);
    });
    matches.sort((a, b) => Number(a[0]) - Number(b[0]));
    const limit = Math.max(0, Math.min(MAX_COUNTERPARTS_PER_PAIR, budget - found.length));
    if (matches.length > limit) truncated = true;
    found.push(...matches.slice(0, limit).map(([, entry]) => entry));
  }
  return [found, truncated];
}

// ---------------------------------------------------------------------------
// Anchor extraction
// ---------------------------------------------------------------------------

interface FileAnchors {
  path: string;
  language: string;
  deleted: boolean;
  symbols: AnchorSymbolEntry[];
  imports: string[];
  identifiers: string[];
  symbolsTruncated: boolean;
  importsTruncated: boolean;
  changedLines: [number, number][] | null;
  keys: ChangedKey[];
  keysTruncated: boolean;
  counterparts: CounterpartEntry[];
  counterpartsTruncated: boolean;
}

/** Added lines interleaved with block-state context lines in new-file order. */
function mergeWithContext(state: FileState): [number, string, boolean][] {
  const merged: [number, string, boolean][] = state.addedLines.map(([lineNo, content]) => [lineNo, content, false]);
  merged.push(...state.contextLines.map(([lineNo, content]): [number, string, boolean] => [lineNo, content, true]));
  return merged.sort((a, b) => a[0] - b[0]);
}

function extractFileAnchors(
  state: FileState,
  sourceRoot: string | null,
  enclosingBudget: number,
  emitChangedLines: boolean,
  keyBudget: number,
  counterpartBudget: number,
  diffAdded: Map<string, Set<number>>,
): FileAnchors {
  const fa: FileAnchors = {
    path: state.path,
    language: detectLanguage(state.path),
    deleted: state.deleted,
    symbols: [],
    imports: [],
    identifiers: [],
    symbolsTruncated: false,
    importsTruncated: false,
    changedLines: null,
    keys: [],
    keysTruncated: false,
    counterparts: [],
    counterpartsTruncated: false,
  };
  if (state.deleted || state.binary) return fa;

  const seenSymbols = new Set<string>();
  const seenImports = new Set<string>();
  const addSymbol = (name: string, kind: string, confidence: string, lineNo: number): void => {
    const key = `${kind}\0${name}`;
    if (seenSymbols.has(key)) return;
    seenSymbols.add(key);
    fa.symbols.push({ name, kind, confidence, line: lineNo });
  };
  const addImport = (mod: string): void => {
    if (!seenImports.has(mod)) {
      seenImports.add(mod);
      fa.imports.push(mod);
    }
  };

  if (fa.language === "go") {
    let inBlock = false;
    for (const [lineNo, content, isContext] of mergeWithContext(state)) {
      let imps: string[];
      [imps, inBlock] = extractImportsGo(content, inBlock);
      if (isContext) continue;
      for (const imp of imps) addImport(imp);
      for (const [name, kind, confidence] of extractGo(content)) addSymbol(name, kind, confidence, lineNo);
    }
  } else if (fa.language === "python" || fa.language === "javascript" || fa.language === "typescript") {
    let inFromBlock = false;
    for (const [lineNo, content, isContext] of mergeWithContext(state)) {
      let symbols: ExtractedSymbol[];
      let imps: string[];
      if (fa.language === "python") [symbols, imps, inFromBlock] = extractPython(content, inFromBlock);
      else [symbols, imps] = extractJs(content);
      if (isContext) continue;
      for (const imp of imps) addImport(imp);
      for (const [name, kind, confidence] of symbols) addSymbol(name, kind, confidence, lineNo);
    }
  }

  let headLines: string[] | null = null;
  if (sourceRoot !== null && state.newSideLines.length > 0) {
    headLines = readHeadLines(sourceRoot, state.path);
    if (headLines !== null && !headMatchesDiff(state, headLines)) headLines = null;
  }
  if (headLines !== null && emitChangedLines) {
    const ranges = changedLineRanges(state);
    if (ranges.length <= MAX_CHANGED_RANGES_PER_FILE) fa.changedLines = ranges;
  }
  if (headLines !== null && DECLARATION_LANGUAGES.includes(fa.language)) {
    const declared = new Set(fa.symbols.filter((sym) => sym.kind !== "import").map((sym) => sym.name));
    const enclosing = enclosingSymbols(state, fa.language, headLines).filter((decl) => !declared.has(decl[0]));
    const limit = Math.max(0, Math.min(MAX_ENCLOSING_PER_FILE, enclosingBudget));
    if (enclosing.length > limit) fa.symbolsTruncated = true;
    for (const [name, confidence, lineNo] of enclosing.slice(0, limit)) addSymbol(name, "enclosing", confidence, lineNo);
  }
  if (headLines !== null && scansKeys(state.path, fa.language)) {
    const keys = changedKeys(state, fa.language, headLines);
    const limit = Math.max(0, Math.min(MAX_KEYS_PER_FILE, keyBudget));
    fa.keys = keys.slice(0, limit);
    fa.keysTruncated = keys.length > limit;
  }
  if (headLines !== null && sourceRoot !== null && DECLARATION_LANGUAGES.includes(fa.language)) {
    const enclosingEntries = fa.symbols.filter((sym) => sym.kind === "enclosing");
    [fa.counterparts, fa.counterpartsTruncated] = counterparts(
      state, fa.language, headLines, enclosingEntries, sourceRoot, diffAdded, counterpartBudget,
    );
  }

  if (fa.symbols.length > MAX_SYMBOLS_PER_FILE) {
    fa.symbolsTruncated = true;
    fa.symbols = fa.symbols.slice(0, MAX_SYMBOLS_PER_FILE);
  }
  if (fa.imports.length > MAX_IMPORTS_PER_FILE) {
    fa.importsTruncated = true;
    fa.imports = fa.imports.slice(0, MAX_IMPORTS_PER_FILE);
  }
  return fa;
}

export interface ChangeAnchorSymbol {
  name: string;
  kind: string;
  confidence: string;
  line: number;
}

export interface ChangeAnchorKey {
  name: string;
  kind: string;
  line: number;
}

/** Persisted snake_case shape of one referenced counterpart. */
export interface ChangeAnchorCounterpart {
  name: string;
  line: number;
  ref_path: string;
  ref_name: string;
  ref_line: number;
  ref_end: number;
  ref_changed?: true;
}

/** Persisted snake_case shape of one changed file. Optional keys are
 * present only when set, in this order. */
export interface ChangeAnchorFile {
  path: string;
  language: string;
  symbols: ChangeAnchorSymbol[];
  imports: string[];
  identifiers: string[];
  changed_lines?: [number, number][];
  keys?: ChangeAnchorKey[];
  counterparts?: ChangeAnchorCounterpart[];
  deleted?: true;
  symbols_truncated?: true;
  imports_truncated?: true;
  keys_truncated?: true;
  counterparts_truncated?: true;
}

export interface ChangeAnchor {
  value: string;
  kind: string;
  source: string;
  confidence: string;
}

/** The version-1 change-anchor artifact (`change-anchors.json`). */
export interface ChangeAnchorsArtifact {
  version: number;
  files: ChangeAnchorFile[];
  anchors: ChangeAnchor[];
  truncated: boolean;
}

export interface ExtractChangeAnchorsOptions {
  maxFiles?: number;
  maxAnchors?: number;
  /** The reviewed head checkout; null disables every head-derived field. */
  sourceRoot?: string | null;
}

function counterpartToArtifact(entry: CounterpartEntry): ChangeAnchorCounterpart {
  const out: ChangeAnchorCounterpart = {
    name: entry.name,
    line: entry.line,
    ref_path: entry.refPath,
    ref_name: entry.refName,
    ref_line: entry.refLine,
    ref_end: entry.refEnd,
  };
  if (entry.refChanged) out.ref_changed = true;
  return out;
}

function fileAnchorsToArtifact(fa: FileAnchors): ChangeAnchorFile {
  const entry: ChangeAnchorFile = {
    path: fa.path,
    language: fa.language,
    symbols: fa.symbols,
    imports: fa.imports,
    identifiers: fa.identifiers,
  };
  if (fa.changedLines !== null) entry.changed_lines = fa.changedLines;
  if (fa.keys.length > 0) entry.keys = fa.keys;
  if (fa.counterparts.length > 0) entry.counterparts = fa.counterparts.map(counterpartToArtifact);
  if (fa.deleted) entry.deleted = true;
  if (fa.symbolsTruncated) entry.symbols_truncated = true;
  if (fa.importsTruncated) entry.imports_truncated = true;
  if (fa.keysTruncated) entry.keys_truncated = true;
  if (fa.counterpartsTruncated) entry.counterparts_truncated = true;
  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/** `entry.get(key) or ...`: a truthy non-string path crashes v2 too. */
function listPath(value: unknown): string {
  if (typeof value === "string") return value;
  if (pyTruthy(value)) throw new TypeError("change anchors: changed-file path is not a string");
  return "";
}

/** Build the versioned change-anchors artifact from a diff and file list
 * (`pr-files.json` entries with `filename`/`previous_filename`/`status`). */
export function extractChangeAnchors(
  diffText: string | null | undefined,
  fileList: readonly unknown[] | null | undefined = null,
  options: ExtractChangeAnchorsOptions = {},
): ChangeAnchorsArtifact {
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const maxAnchors = options.maxAnchors ?? MAX_ANCHORS;
  const sourceRoot = options.sourceRoot ?? null;
  let truncated = false;
  let diffTruncated = false;

  let text = diffText ?? "";
  if (text.length > MAX_DIFF_BYTES && pyLen(text) > MAX_DIFF_BYTES) {
    text = pyHead(text, MAX_DIFF_BYTES);
    truncated = true;
    diffTruncated = true;
  }

  const diffFiles = parseDiff(text);

  const merged: FileState[] = [];
  const seenPaths = new Set<string>();
  if (fileList && fileList.length > 0) {
    if (fileList.length > maxFiles) truncated = true;
    for (const entry of fileList.slice(0, maxFiles)) {
      if (!isRecord(entry)) continue;
      const filename = listPath(entry.filename);
      const path = filename || listPath(entry.previous_filename) || "";
      if (path === "" || seenPaths.has(path)) continue;
      seenPaths.add(path);
      const oldPath = typeof entry.previous_filename === "string" ? entry.previous_filename : "";
      merged.push(newFileState(path, oldPath, entry.status === "removed"));
    }
  }

  for (const state of diffFiles) {
    if (seenPaths.has(state.path)) {
      const existing = merged.find((item) => item.path === state.path);
      if (existing) {
        existing.addedLines.push(...state.addedLines);
        existing.contextLines.push(...state.contextLines);
        existing.newSideLines.push(...state.newSideLines);
        existing.changeRuns.push(...state.changeRuns);
        existing.removedLines.push(...state.removedLines);
        existing.binary = state.binary;
        existing.deleted = state.deleted || existing.deleted;
        existing.oldPath = state.oldPath || existing.oldPath;
      }
    } else {
      seenPaths.add(state.path);
      merged.push(state);
    }
  }

  let states = merged;
  if (states.length > maxFiles) {
    states = states.slice(0, maxFiles);
    truncated = true;
  }

  const filesOut: ChangeAnchorFile[] = [];
  const anchors: ChangeAnchor[] = [];
  const seenAnchors = new Set<string>();
  const addAnchor = (value: string, kind: string, source: string, confidence: string): void => {
    if (anchors.length >= maxAnchors) {
      truncated = true;
      return;
    }
    const key = `${kind}\0${value}`;
    if (seenAnchors.has(key)) return;
    seenAnchors.add(key);
    anchors.push({ value, kind, source, confidence });
  };

  let enclosingLeft = MAX_ENCLOSING;
  let keysLeft = MAX_KEYS;
  let counterpartsLeft = MAX_COUNTERPARTS;
  const diffAdded = new Map<string, Set<number>>();
  for (const state of states) diffAdded.set(state.path, new Set(state.addedLines.map(([lineNo]) => lineNo)));
  for (const state of states) {
    const fa = extractFileAnchors(state, sourceRoot, enclosingLeft, !diffTruncated, keysLeft, counterpartsLeft, diffAdded);
    enclosingLeft -= fa.symbols.filter((sym) => sym.kind === "enclosing").length;
    keysLeft -= fa.keys.length;
    counterpartsLeft -= fa.counterparts.length;
    const entry = fileAnchorsToArtifact(fa);
    if (fa.symbolsTruncated || fa.importsTruncated || fa.keysTruncated || fa.counterpartsTruncated) truncated = true;
    filesOut.push(entry);

    if (fa.language !== "non_source") addAnchor(fa.path, "file", fa.path, "low");
    for (const sym of fa.symbols) addAnchor(sym.name, "symbol", fa.path, sym.confidence);
    for (const imp of fa.imports) addAnchor(imp, "import", fa.path, "medium");
  }

  return { version: ARTIFACT_VERSION, files: filesOut, anchors, truncated };
}

/** `json.dumps(artifact, indent=2) + "\n"`: the persisted document bytes. */
export function renderChangeAnchorsJson(artifact: ChangeAnchorsArtifact): string {
  return `${pyJsonDump(artifact, 2, true)}\n`;
}

// ---------------------------------------------------------------------------
// File-list loading and CLI
// ---------------------------------------------------------------------------

/** Python `Path.read_text(encoding="utf-8", errors="replace")`: replacement
 * decoding plus universal-newline translation. */
function readTextPy(path: string): string {
  return decodeReplace(readFileSync(path)).replace(/\r\n?/g, "\n");
}

/** Load `pr-files.json` / `pr-files.raw.json` (array or `{files: [...]}`). */
export function loadFileList(path: string): Record<string, unknown>[] {
  let data: unknown;
  try {
    data = JSON.parse(readTextPy(path));
  } catch {
    return [];
  }
  if (isRecord(data)) data = Object.hasOwn(data, "files") ? data.files : [];
  if (!Array.isArray(data)) return [];
  return data.filter(isRecord);
}

const NON_PRINTABLE_RE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

/** Python `repr(str)`. */
export function pyReprStr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code < 0x7f || !NON_PRINTABLE_RE.test(ch)) out += ch;
    else if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return out + quote;
}

function isRelativeTo(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Validate an artifact write target inside `workspaceRoot` (containment
 * after symlink resolution), or null. */
export function resolveArtifactPath(pathStr: string, workspaceRoot: string): string | null {
  if (pathStr === "" || pathStr.includes("\0") || workspaceRoot.includes("\0")) return null;
  const root = pyRealpath(workspaceRoot);
  const target = pyRealpath(pathStr);
  if (isSymlink(target) && !isRelativeTo(pyRealpath(target), root)) return null;
  if (!isRelativeTo(target, root)) return null;
  return target;
}

const CLI_OPTIONS = ["--diff", "--files", "--output", "--workspace-root"] as const;
type CliOption = (typeof CLI_OPTIONS)[number];

function matchCliOption(flag: string): CliOption | null {
  const exact = CLI_OPTIONS.find((option) => option === flag);
  if (exact) return exact;
  const prefixed = CLI_OPTIONS.filter((option) => option.startsWith(flag));
  return flag.length > 2 && prefixed.length === 1 ? (prefixed[0] as CliOption) : null;
}

export interface ChangeAnchorsCliResult {
  exitCode: number;
  stderr: string;
}

/** The v2 `python3 -m pr_reviewer.change_anchors` CLI: `--diff`, `--files`,
 * `--output` (must resolve inside the workspace root), `--workspace-root`
 * (default `$GITHUB_WORKSPACE` or the cwd). Unique option prefixes and
 * `--opt=value` are accepted as argparse does. */
export function changeAnchorsCli(argv: readonly string[], env: Record<string, string | undefined> = process.env): ChangeAnchorsCliResult {
  const values: Record<CliOption, string> = {
    "--diff": "pr.diff",
    "--files": "",
    "--output": "change-anchors.json",
    "--workspace-root": "",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const option = matchCliOption(eq === -1 ? arg : arg.slice(0, eq));
    if (option === null) return { exitCode: 2, stderr: `error: unrecognized arguments: ${arg}\n` };
    if (eq !== -1) {
      values[option] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || (next.startsWith("-") && next !== "-")) {
      return { exitCode: 2, stderr: `error: argument ${option}: expected one argument\n` };
    }
    values[option] = next;
    i += 1;
  }

  const defaultRoot = env.GITHUB_WORKSPACE || process.cwd();
  const workspaceRoot = values["--workspace-root"] || defaultRoot;

  let diffText = "";
  try {
    diffText = readTextPy(values["--diff"]);
  } catch {
    diffText = "";
  }
  const fileList = values["--files"] ? loadFileList(values["--files"]) : [];
  const result = extractChangeAnchors(diffText, fileList, { sourceRoot: workspaceRoot });

  const out = resolveArtifactPath(values["--output"], workspaceRoot);
  if (out === null) {
    return {
      exitCode: 1,
      stderr: `Refusing to write ${pyReprStr(values["--output"])}: escapes workspace root ${pyReprStr(workspaceRoot)} or is otherwise unsafe.\n`,
    };
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderChangeAnchorsJson(result), "utf8");
  return { exitCode: 0, stderr: "" };
}
