/** Standards-file resolution from the trusted base ref (#885).
 *
 * `standards-file.ts`'s `resolveStandardsFile` walks `$STANDARDS_FILE` /
 * `$STANDARDS_FILE_CANDIDATES` against the checked-out working tree — which,
 * for a review, is the PR HEAD. A PR could therefore edit AGENTS.md (or add a
 * higher-priority candidate such as `.github/ai-review-rules.md`) on its own
 * branch and loosen or remove the rules its own review enforces.
 *
 * This module ports the exact same candidate-order/xargs/glob semantics
 * (`xargsEcho`, `isGlobPattern`, `componentRegex`, imported unchanged from
 * `standards-file.ts` so the two paths can never diverge on pattern
 * matching), but evaluates them against the PR's base ref via bounded,
 * argv-only `git` subprocess calls — `git ls-tree` for existence/listing,
 * `git show` for content — exactly like `repository-config.ts`'s
 * `readRepositoryConfigFromRef`. Nothing here ever reads the working tree.
 *
 * Containment: a git-tree path can never resolve outside its own ref (there
 * is no filesystem to escape onto), so the disk-symlink containment guard in
 * `workspace-path.ts` does not apply here. Instead: a `..` path segment is
 * refused outright (hygiene, not a real escape), and only "regular blob"
 * mode entries (100644/100755) are accepted — a tracked symlink (mode
 * 120000) is skipped, the same way `workspaceRegularFile` refuses a symlink
 * on disk, because its blob content is a link-target string, not the text a
 * standards file should be.
 *
 * An absolute `standards_file`/candidate is operator-owned (not PR content)
 * and, exactly like the workspace-fs path, is read directly from disk when
 * it names a regular file outside the workspace — it is never part of the
 * reviewed repository's git history.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { compareCodePoints } from "../platform/jq.js";
import { componentRegex, isGlobPattern, xargsEcho } from "./standards-file.js";

const DEFAULT_GIT_TIMEOUT_SEC = 10;
/** Bounds the standards file content this module will ever read from a
 * single `git show`/subprocess call — a DOS guard, independent of the later
 * corpus-assembly truncation cap (`STANDARDS_CAP_DEFAULT` in
 * `corpus/assemble.ts`). */
const MAX_STANDARDS_FILE_BYTES = 8 * 1024 * 1024;

export class StandardsFileRefError extends Error {}

export interface StandardsRefInput {
  /** `$STANDARDS_FILE` as configured (possibly empty). */
  standardsFile: string;
  /** `$STANDARDS_FILE_CANDIDATES` (config default applied by the caller). */
  candidates: string;
  /** The trusted base ref (never the PR head). */
  ref: string;
  /** The checked-out repository — used only as the `git` subprocess `cwd`
   * (to locate the repository), never read from directly for candidate
   * content. */
  workspace: string;
  gitTimeoutSec?: number;
}

export interface StandardsRefResolution {
  /** The resolved path (relative to the ref root, or an operator-owned
   * absolute path), or `null` when nothing matched. */
  resolved: string | null;
  content: Uint8Array | null;
}

interface RefEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  name: string;
}

function isRegularFileOnDisk(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function runGit(args: string[], workspace: string, timeoutSec: number): Buffer | null {
  try {
    return execFileSync("git", args, {
      cwd: workspace,
      timeout: timeoutSec * 1000,
      maxBuffer: MAX_STANDARDS_FILE_BYTES * 4,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { code?: string | number | null; killed?: boolean; signal?: string | null };
    if (typeof err.code === "string" && err.code === "ENOENT") throw new StandardsFileRefError("git executable not found");
    if (err.killed || err.signal) throw new StandardsFileRefError(`git ${args[0]} timed out after ${timeoutSec}s`);
    // Any other non-zero exit (ref unknown, not a git repository, path
    // absent) means "not found here" — the same permissive treatment
    // `readRepositoryConfigFromRef` gives a missing candidate.
    return null;
  }
}

function parseLsTree(stdout: Buffer): RefEntry[] {
  const text = stdout.toString("utf8");
  const entries: RefEntry[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(" ");
    const fullPath = line.slice(tab + 1);
    const mode = meta[0] ?? "";
    const type = (meta[1] ?? "") as RefEntry["type"];
    const name = fullPath.includes("/") ? fullPath.slice(fullPath.lastIndexOf("/") + 1) : fullPath;
    entries.push({ mode, type, name });
  }
  return entries;
}

/** The tree entry named exactly `relPath` at `ref` (its own entry, not its
 * children — mirrors `lstatSync`/`statSync` on a single path), or `null`
 * when nothing is there. */
function lsTreeSelf(ref: string, relPath: string, workspace: string, timeoutSec: number): RefEntry | null {
  if (relPath === "") return null;
  const stdout = runGit(["ls-tree", ref, "--", relPath], workspace, timeoutSec);
  if (stdout === null) return null;
  // An exact (non-glob) pathspec resolves to at most one tree entry.
  return parseLsTree(stdout)[0] ?? null;
}

/** The immediate children of `dirPath` (`""` = repository root) at `ref` —
 * mirrors `readdirSync` (one level, not recursive). */
function lsTreeChildren(ref: string, dirPath: string, workspace: string, timeoutSec: number): RefEntry[] {
  const pathspec = dirPath === "" ? "." : `${dirPath}/`;
  const stdout = runGit(["ls-tree", ref, "--", pathspec], workspace, timeoutSec);
  if (stdout === null) return [];
  return parseLsTree(stdout);
}

const unescape = (component: string): string => component.replace(/\\(.)/gu, "$1");

/** Base-ref port of `standards-file.ts`'s `expandGlob`: same component-by-
 * component walk and the same `componentRegex`/`isGlobPattern` matching, but
 * listing/checking each component against `git ls-tree` at `ref` instead of
 * `readdirSync`/`lstatSync`. A `..` component, or a path leading with a
 * trailing slash (the original code's "no final component" empty-match
 * case), never matches — there is no filesystem escape to defend against
 * inside a git tree, so this is a hygiene refusal, not a security guard. */
function expandGlobAtRef(word: string, ref: string, workspace: string, timeoutSec: number): string[] {
  if (!isGlobPattern(word)) return [word];
  if (word.startsWith("/")) return [];
  const components = word.split("/").filter((part) => part !== "");
  if (components.length === 0 || word.endsWith("/")) return [];
  if (components.includes("..")) return [];
  let paths: string[] = [""];
  components.forEach((component, index) => {
    const last = index === components.length - 1;
    const next: string[] = [];
    if (!isGlobPattern(component)) {
      const name = unescape(component);
      for (const base of paths) {
        const candidate = base === "" ? name : `${base}/${name}`;
        const entry = lsTreeSelf(ref, candidate, workspace, timeoutSec);
        if (entry === null) continue;
        if (last ? entry.type === "blob" && entry.mode !== "120000" : entry.type === "tree") next.push(candidate);
      }
    } else {
      const pattern = componentRegex(component);
      const explicitDot = component.startsWith(".") || component.startsWith("\\.");
      for (const base of paths) {
        for (const entry of lsTreeChildren(ref, base, workspace, timeoutSec)) {
          if (entry.name === "." || entry.name === "..") continue;
          if (entry.name.startsWith(".") && !explicitDot) continue;
          if (!pattern.test(entry.name)) continue;
          if (!last && entry.type !== "tree") continue;
          if (last && (entry.type !== "blob" || entry.mode === "120000")) continue;
          next.push(base === "" ? entry.name : `${base}/${entry.name}`);
        }
      }
    }
    paths = next;
  });
  return paths.sort(compareCodePoints);
}

/** True when `path` (relative to the ref root) names a regular blob at
 * `ref` — no `..` traversal, no symlink mode. An absolute path is
 * operator-owned: accepted only when it is a regular file on disk, exactly
 * like `resolveStandardsFile`'s `allowExternal` case. */
function safeAtRef(path: string, ref: string, workspace: string, timeoutSec: number): boolean {
  if (path.startsWith("/")) return isRegularFileOnDisk(path);
  if (path.split("/").includes("..")) return false;
  const entry = lsTreeSelf(ref, path, workspace, timeoutSec);
  return entry !== null && entry.type === "blob" && entry.mode !== "120000";
}

/** Base-ref port of `standards-file.ts`'s `resolveStandardsFile`: same
 * algorithm (keep a safe configured value; else walk the candidate list in
 * order, first safe match wins), evaluated entirely against `ref` instead of
 * the working tree. */
export function resolveStandardsFileAtRef(input: StandardsRefInput): string {
  if (input.ref === "") throw new StandardsFileRefError("resolveStandardsFileAtRef requires a non-empty ref");
  const timeoutSec = input.gitTimeoutSec ?? DEFAULT_GIT_TIMEOUT_SEC;
  const safe = (path: string): boolean => safeAtRef(path, input.ref, input.workspace, timeoutSec);
  if (input.standardsFile !== "" && safe(input.standardsFile)) return input.standardsFile;
  const firstLine = input.candidates.split("\n")[0] ?? "";
  const fields = firstLine.split(",");
  if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
  for (const field of fields) {
    const candidate = xargsEcho(field);
    if (candidate === "") continue;
    for (const word of candidate.split(/[ \t\n]+/).filter((part) => part !== "")) {
      for (const match of expandGlobAtRef(word, input.ref, input.workspace, timeoutSec)) {
        if (safe(match)) return match;
      }
    }
  }
  if (input.standardsFile !== "" && !input.standardsFile.startsWith("/")) {
    const entry = !input.standardsFile.split("/").includes("..")
      ? lsTreeSelf(input.ref, input.standardsFile, input.workspace, timeoutSec)
      : null;
    if (entry !== null && entry.type === "blob") return "";
  }
  return input.standardsFile;
}

/** End-to-end: resolve, then read the content from the same ref (or disk,
 * for an operator-owned absolute path). Never throws for "not found" —
 * only `StandardsFileRefError` for infrastructure failures (git missing,
 * timeout), which the caller degrades on exactly like repository config:
 * warn, no standards, never fall back to the PR head. */
export function readStandardsFileAtRef(input: StandardsRefInput): StandardsRefResolution {
  const timeoutSec = input.gitTimeoutSec ?? DEFAULT_GIT_TIMEOUT_SEC;
  const resolved = resolveStandardsFileAtRef(input);
  if (resolved === "") return { resolved: null, content: null };
  if (resolved.startsWith("/")) {
    try {
      return { resolved, content: readFileSync(resolved) };
    } catch {
      return { resolved, content: null };
    }
  }
  const stdout = runGit(["show", `${input.ref}:${resolved}`], input.workspace, timeoutSec);
  return { resolved, content: stdout };
}
