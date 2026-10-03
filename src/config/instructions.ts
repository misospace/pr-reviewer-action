/** #727: referenced review-instruction files, read from the trusted base
 * ref — never from the PR head.
 *
 * `effective-config.ts` validates the `review-instructions` paths (count,
 * repo-relative shape) but does not read content: resolution is pure. This
 * module is the trusted read side. It exists because the acceptance
 * criterion is the whole chain — a PR must not be able to weaken the review
 * that judges it through a file its own config references, so every listed
 * path is read via bounded, argv-only `git show <ref>:<path>` against the
 * PR's base/merge-base commit, exactly like
 * `repository-config.ts`'s `readRepositoryConfigFromRef` and
 * `src/context/standards-file-ref.ts` (#885). Nothing here ever reads the
 * working tree or the PR head.
 *
 * Read-boundary rules (defense in depth — the config layer already rejects
 * these, and this module refuses them again independently):
 *
 * - the ref must resolve to a real commit (`verifyBaseRef`), else a typed
 *   read failure — a base-ref resolution failure is never silently read as
 *   "no instruction files";
 * - absolute paths and `..` segments are refused;
 * - only regular blobs (100644/100755) are accepted — a tracked symlink
 *   (mode 120000) is skipped, the same way `standards-file-ref.ts` refuses
 *   symlink modes, because its blob content is a link-target string, not
 *   instructions;
 * - the `MAX_INSTRUCTION_FILE_BYTES` per-file and `MAX_INSTRUCTION_TOTAL_BYTES`
 *   aggregate caps from `effective-config.ts` are enforced HERE, at read
 *   time: an oversized file is skipped with a bounded diagnostic, never
 *   truncated into a partial instruction;
 * - a path that is simply absent at the base ref is skipped with a warning
 *   (the repository may list a file that does not exist on the base yet);
 *   that is a per-file, fail-conservative skip — it never falls back to the
 *   PR head.
 *
 * Warnings never echo repository-controlled content beyond the path itself,
 * which the config layer has already bounded to 4096 clean bytes (and which
 * came from the base-side config file, not the PR).
 */

import { execFileSync } from "node:child_process";
import { hasControlCharacters } from "./instance-config.js";
import { MAX_INSTRUCTION_FILE_BYTES, MAX_INSTRUCTION_TOTAL_BYTES } from "./effective-config.js";
import { RepositoryConfigError, verifyBaseRef } from "./repository-config.js";

const DEFAULT_GIT_TIMEOUT_SEC = 10;

export interface InstructionFile {
  /** The path as listed in repository config (repo-relative). */
  readonly path: string;
  /** Raw file content from the base ref. */
  readonly content: Buffer;
}

export interface InstructionResolution {
  /** Accepted files, in the order the repository config listed them. */
  readonly files: readonly InstructionFile[];
  /** Bounded, non-fatal diagnostics for skipped or missing entries. */
  readonly warnings: readonly string[];
}

function runGit(args: string[], cwd: string, timeoutSec: number): Buffer | null {
  try {
    return execFileSync("git", args, {
      cwd,
      timeout: timeoutSec * 1000,
      maxBuffer: MAX_INSTRUCTION_FILE_BYTES * 4,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { code?: string | number | null; killed?: boolean; signal?: string | null };
    if (typeof err.code === "string" && err.code === "ENOENT") throw new RepositoryConfigError("git executable not found");
    if (err.killed || err.signal) throw new RepositoryConfigError(`git ${args[0]} timed out after ${timeoutSec}s`);
    // Any other non-zero exit (path absent, ref unknown) is reported to the
    // caller as "not here" — the per-file fail-conservative skip.
    return null;
  }
}

/** The tree entry named exactly `path` at `ref`, or `null` when absent.
 * `-z` NUL-separates entries and disables C-quoting, so a path with a tab,
 * newline, or non-ASCII byte is parsed exactly (same parsing as
 * `standards-file-ref.ts`'s `parseLsTree`). */
function lsTreeSelf(ref: string, path: string, cwd: string, timeoutSec: number): { mode: string; type: string } | null {
  const stdout = runGit(["ls-tree", "-z", ref, "--", path], cwd, timeoutSec);
  if (stdout === null) return null;
  const record = stdout.toString("utf8").split("\0").find((entry) => entry !== "");
  if (record === undefined) return null;
  const tab = record.indexOf("\t");
  if (tab < 0) return null;
  const meta = record.slice(0, tab).split(" ");
  return { mode: meta[0] ?? "", type: meta[1] ?? "" };
}

/**
 * Read the given instruction-file paths from the trusted base ref. The
 * returned `files` keep the listed order and their exact base-side bytes;
 * skipped entries surface as warnings, never as head-side fallbacks.
 */
export function readInstructionFilesAtRef(
  paths: readonly string[],
  options: { ref: string; workspace?: string | null; gitTimeoutSec?: number },
): InstructionResolution {
  if (options.ref === "") throw new RepositoryConfigError("readInstructionFilesAtRef requires a non-empty ref");
  const cwd = options.workspace ?? process.cwd();
  const timeoutSec = options.gitTimeoutSec ?? DEFAULT_GIT_TIMEOUT_SEC;
  verifyBaseRef(options.ref, cwd, timeoutSec);

  const files: InstructionFile[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;
  for (const [index, path] of paths.entries()) {
    if (hasControlCharacters(path)) {
      warnings.push(`Instruction file entry ${index} refused (control characters); skipped.`);
      continue;
    }
    if (path.startsWith("/") || path.split("/").includes("..")) {
      warnings.push(`Instruction file '${path}' refused (absolute or '..' segment); skipped.`);
      continue;
    }
    const entry = lsTreeSelf(options.ref, path, cwd, timeoutSec);
    if (entry === null || entry.type !== "blob") {
      warnings.push(`Instruction file '${path}' not found at the base ref; skipped.`);
      continue;
    }
    if (entry.mode === "120000") {
      warnings.push(`Instruction file '${path}' is a symlink at the base ref; skipped.`);
      continue;
    }
    const content = runGit(["show", `${options.ref}:${path}`], cwd, timeoutSec);
    if (content === null) {
      warnings.push(`Instruction file '${path}' could not be read from the base ref; skipped.`);
      continue;
    }
    if (content.length > MAX_INSTRUCTION_FILE_BYTES) {
      warnings.push(`Instruction file '${path}' exceeds the ${MAX_INSTRUCTION_FILE_BYTES}-byte per-file cap; skipped.`);
      continue;
    }
    if (totalBytes + content.length > MAX_INSTRUCTION_TOTAL_BYTES) {
      warnings.push(`Instruction file '${path}' would exceed the ${MAX_INSTRUCTION_TOTAL_BYTES}-byte total instruction cap; skipped.`);
      continue;
    }
    totalBytes += content.length;
    files.push({ path, content });
  }
  return { files: Object.freeze(files), warnings };
}
