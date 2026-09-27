/** Spike (#764): best-effort "which file might define an imported name"
 * resolution, for the "definitions ... in imported files" half of #764.
 * Deliberately narrow: relative imports only (the common case for
 * same-repo callers/definitions), no node_modules/site-packages
 * resolution, no package.json `exports` map, no PEP 420 namespace
 * packages. A miss here just means the identifier is checked in fewer
 * files, never a wrong file. */

import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { SyntaxLanguageId } from "./grammars.js";

const TS_JS_IMPORT_RE = /^\s*import\s+.*?from\s+["'](\.[^"']+)["']/gm;
const PY_FROM_IMPORT_RE = /^\s*from\s+(\.+[\w.]*)\s+import\s+/gm;

function candidateExtensions(language: SyntaxLanguageId): string[] {
  if (language === "python") return [".py"];
  return [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];
}

/** Resolve relative import specifiers found in `source` to workspace-
 * relative file paths that exist on disk, bounded to `maxFiles`. */
export function resolveRelativeImports(
  source: string,
  filePath: string,
  language: SyntaxLanguageId,
  workspace: string,
  maxFiles: number,
): string[] {
  const dir = dirname(filePath);
  const resolved: string[] = [];
  const seen = new Set<string>();

  const tryAdd = (relSpecifier: string): void => {
    if (resolved.length >= maxFiles) return;
    const base = normalize(join(dir, relSpecifier));
    for (const ext of candidateExtensions(language)) {
      const withExt = base.endsWith(ext) ? base : `${base}${ext}`;
      if (seen.has(withExt)) continue;
      seen.add(withExt);
      if (existsSync(join(workspace, withExt))) {
        resolved.push(withExt);
        return;
      }
    }
    // Directory-style import (`./foo` -> `./foo/index.ts` / `__init__.py`).
    const indexCandidates = language === "python" ? [join(base, "__init__.py")] : candidateExtensions(language).map((ext) => join(base, `index${ext}`));
    for (const candidate of indexCandidates) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (existsSync(join(workspace, candidate))) {
        resolved.push(candidate);
        return;
      }
    }
  };

  if (language === "python") {
    for (const match of source.matchAll(PY_FROM_IMPORT_RE)) {
      if (resolved.length >= maxFiles) break;
      const spec = match[1] as string;
      const dots = spec.match(/^\.+/)?.[0].length ?? 1;
      const rest = spec.slice(dots).replaceAll(".", "/");
      const upDirs = "../".repeat(Math.max(0, dots - 1));
      tryAdd(rest ? `${upDirs}${rest}` : upDirs || ".");
    }
  } else {
    for (const match of source.matchAll(TS_JS_IMPORT_RE)) {
      if (resolved.length >= maxFiles) break;
      tryAdd(match[1] as string);
    }
  }
  return resolved;
}
