/** Spike (#764): bounded "callers of a changed declaration" search.
 *
 * Deliberately plain text (word-boundary regex over tracked-ish files), not
 * tree-sitter: per #764's "no language is required for correctness", the
 * caller stage must work even for languages with no grammar loaded. A git
 * worktree walk with generated/vendor/binary filtering and hard file/match
 * caps stands in for "ripgrep-style search"; a real implementation would
 * shell out to `rg` when present (this spike doesn't assume it's on PATH). */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".test-build",
  ".v3-generated",
  "build",
  ".next",
  "coverage",
]);

// Extensions worth grepping. A conservative allowlist (vs. a binary-sniffing
// denylist) is the safer default for "binary filtering" — anything unknown
// is skipped rather than risking a garbled read.
const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "sh", "bash", "yml", "yaml",
  "md", "json", "toml", "txt", "rb", "java", "c", "cc", "cpp", "h", "hpp", "rs",
]);

const MAX_FILE_BYTES = 2_000_000; // skip pathologically large files rather than read them whole

export interface CallerHit {
  path: string;
  line: number;
  snippet: string;
}

export interface CallersOptions {
  maxFiles?: number;
  maxMatches?: number;
  maxSnippetChars?: number;
  excludePaths?: ReadonlySet<string>;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function* walk(root: string): Generator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        stack.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase() : "";
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      yield join(dir, entry.name);
    }
  }
}

/** Bounded, word-boundary text search for call sites of `identifier` (as
 * `identifier(` or a bare reference) across the workspace. Stops at
 * `maxFiles` scanned or `maxMatches` hits, whichever comes first — the
 * caller sees an explicit `truncated` flag rather than a silently partial
 * result. */
export function findCallers(
  identifier: string,
  workspace: string,
  options: CallersOptions = {},
): { hits: CallerHit[]; filesScanned: number; truncated: boolean } {
  const maxFiles = options.maxFiles ?? 4000;
  const maxMatches = options.maxMatches ?? 20;
  const maxSnippetChars = options.maxSnippetChars ?? 300;
  const exclude = options.excludePaths ?? new Set<string>();
  // Call-shaped only ("name(", optional whitespace before the paren): a
  // bare `\bname\b` also matches the identifier inside comments, prose,
  // and string literals mentioning it — noisy in practice (see the spike
  // note's PR #597 run, where a bare-word pattern matched a comment
  // reading "_resolve_maintainers is the security gate for..."). This
  // still matches a `def name(...)`/`function name(...)` line too — a
  // declaration mentions its own name in call-shape — so it is not a
  // perfect "calls, not defines" filter; callers dedupe that separately.
  const pattern = new RegExp(`\\b${escapeRegExp(identifier)}\\s*\\(`);

  const hits: CallerHit[] = [];
  let filesScanned = 0;
  let truncated = false;

  for (const absPath of walk(workspace)) {
    if (filesScanned >= maxFiles) {
      truncated = true;
      break;
    }
    const relPath = relative(workspace, absPath).split("\\").join("/");
    if (exclude.has(relPath)) continue;
    let size = 0;
    try {
      size = statSync(absPath).size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_BYTES) continue;
    filesScanned += 1;
    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!pattern.test(line)) continue;
      if (hits.length >= maxMatches) {
        truncated = true;
        break;
      }
      const snippet = line.length > maxSnippetChars ? `${line.slice(0, maxSnippetChars - 3)}...` : line;
      hits.push({ path: relPath, line: i + 1, snippet });
    }
    if (hits.length >= maxMatches) {
      truncated = true;
      break;
    }
  }
  return { hits, filesScanned, truncated };
}
