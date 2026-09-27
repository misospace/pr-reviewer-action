/** Spike (#764): grammar registry and lazy WASM loading for the syntax-aware
 * related-code stage. Deliberately small — six languages, no query files.
 * `Parser`/`Language` are the `web-tree-sitter` runtime; the compiled
 * grammars come from the prebuilt `tree-sitter-wasms` bundle. Both are
 * pinned exactly (see package.json) because `web-tree-sitter` >=0.26 cannot
 * load grammars built for the ABI `tree-sitter-wasms@0.1.13` ships — see the
 * spike note for the version probe that found this.
 *
 * Everything here is deliberately synchronous-looking-but-async and
 * exception-free at the call site: a missing/unloadable grammar makes the
 * language "unsupported" rather than throwing, so callers degrade to the
 * existing lexical related-context stage (issue #764's "no language is
 * required for correctness"). */

import { Language, Parser } from "web-tree-sitter";

export type SyntaxLanguageId = "typescript" | "tsx" | "javascript" | "python" | "go" | "bash" | "yaml";

const EXTENSION_TO_LANGUAGE: Record<string, SyntaxLanguageId> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  py: "python",
  go: "go",
  sh: "bash",
  bash: "bash",
  yml: "yaml",
  yaml: "yaml",
};

// tree-sitter-wasms ships one file per grammar under out/tree-sitter-<name>.wasm;
// "typescript" and "tsx" share the tree-sitter-typescript grammar package but
// are compiled to separate wasm artifacts.
const GRAMMAR_FILE: Record<SyntaxLanguageId, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  bash: "tree-sitter-bash.wasm",
  yaml: "tree-sitter-yaml.wasm",
};

export function languageForPath(path: string): SyntaxLanguageId | null {
  const ext = path.includes(".") ? (path.slice(path.lastIndexOf(".") + 1).toLowerCase()) : "";
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

let initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  initPromise ??= Parser.init();
  await initPromise;
}

function wasmDir(): string {
  const pkgJson = require.resolve("tree-sitter-wasms/package.json");
  return pkgJson.replace(/package\.json$/, "out");
}

const languageCache = new Map<SyntaxLanguageId, Language | null>();

/** Load (and cache) a grammar. Returns `null` — never throws — when the
 * grammar file is missing or fails to load, so an unsupported/broken
 * language degrades to "no syntax context" rather than aborting the run. */
export async function loadLanguage(id: SyntaxLanguageId): Promise<Language | null> {
  if (languageCache.has(id)) return languageCache.get(id) as Language | null;
  try {
    await ensureInit();
    const file = GRAMMAR_FILE[id];
    const path = `${wasmDir()}/${file}`;
    const language = await Language.load(path);
    languageCache.set(id, language);
    return language;
  } catch {
    languageCache.set(id, null);
    return null;
  }
}

const parserCache = new Map<SyntaxLanguageId, Parser | null>();

/** Get a ready `Parser` for a language, or `null` if unsupported/unloadable. */
export async function parserFor(id: SyntaxLanguageId): Promise<Parser | null> {
  if (parserCache.has(id)) return parserCache.get(id) as Parser | null;
  const language = await loadLanguage(id);
  if (language === null) {
    parserCache.set(id, null);
    return null;
  }
  const parser = new Parser();
  parser.setLanguage(language);
  parserCache.set(id, parser);
  return parser;
}
