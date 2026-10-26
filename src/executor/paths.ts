/** Filesystem containment and no-follow I/O for the executor boundary
 * (#733).
 *
 * The executor's envelope/result protocol is a pair of FILES inside a
 * controller-owned run directory, and the request validator only proves
 * LEXICAL containment (prefix match, no `..` segments). Lexical
 * containment is not enough: a pre-existing symlink BELOW the run
 * directory (a planted `runDir/sub -> /etc`) redirects a write or a read
 * outside it.
 *
 * This module closes that hole with the primitives the acquisition layer
 * already uses (`src/acquisition/workspace.ts`: `O_NOFOLLOW` plus a
 * same-descriptor `fstat`/read):
 *
 * - `ensureContained` creates the missing parent directories of a target
 *   INSIDE the base directory (one component at a time, a symlinked
 *   component is refused, never followed) and then proves the target is
 *   contained: the CANONICAL directory that would hold it must be the
 *   base directory or below it, and the target itself must not be a
 *   symlink, a hard link, or a non-regular file.
 * - `proveContained` is the read-side proof: the same containment rules
 *   without creating anything.
 * - `writeFileNoFollow` opens with `O_NOFOLLOW`: a symlinked path is
 *   refused, never followed.
 * - `readBoundedFileNoFollow` opens with `O_NOFOLLOW` and `O_NONBLOCK`,
 *   size-checks the SAME descriptor it later reads from, and reads at
 *   most `maxBytes + 1` bytes — so the bound cannot be bypassed by
 *   swapping the file between a separate stat and a read.
 *
 * What this does NOT close, stated plainly: `O_NOFOLLOW` applies to the
 * FINAL path component only. An intermediate component swapped for a
 * symlink between the proof and the I/O is therefore still possible;
 * the run directory is controller-owned scratch space, and the only
 * other writer there is the worker itself. The proof narrows that
 * window; it does not eliminate it.
 *
 * Internal module of the executor package: a future backend imports
 * `src/executor/paths.js` directly; it is deliberately NOT part of the
 * public `src/executor/index.ts` surface.
 */

import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/** `O_NOFOLLOW` is not defined on every platform; where it is missing the
 * no-follow guarantee degrades to the platform default (the read stays
 * bounded and same-descriptor either way). */
const NOFOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

/** Outcome of proving that a target file's directory is inside a base
 * directory. */
export interface ContainmentProof {
  /** Whether the target can only be created/read inside the base
   * directory. */
  readonly contained: boolean;
  /** Canonical (realpath) base directory; "" when not contained. */
  readonly canonicalBase: string;
  /** Canonical directory that would hold the target; "" when not
   * contained. */
  readonly canonicalDir: string;
  /** Human-readable problem description; "" when contained. */
  readonly problem: string;
}

/** The uniform "not contained" answer: the canonical fields are empty
 * (nothing was proven) and the problem names the reason. */
function notContained(problem: string): ContainmentProof {
  return Object.freeze({
    contained: false,
    canonicalBase: "",
    canonicalDir: "",
    problem,
  });
}

/** The canonical form of a path, or null when it does not resolve. A
 * path that does not resolve is UNPROVEN, never assumed contained. */
async function canonicalOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** Is `canonicalDir` the base directory itself or below it? The equal
 * case is a target sitting directly in the base directory; the base
 * directory being the filesystem root makes every path under it
 * contained. */
function isUnder(canonicalBase: string, canonicalDir: string): boolean {
  if (canonicalDir === canonicalBase) return true;
  if (canonicalBase === sep) return canonicalDir.startsWith(sep);
  return canonicalDir.startsWith(canonicalBase + sep);
}

/** Prove that `target` can only be created/read inside `baseDir`.
 *
 * - `canonicalBase = realpath(baseDir)` (must resolve; else not
 *   contained).
 * - `canonicalDir = realpath(dirname(target))` (must resolve; else not
 *   contained).
 * - `canonicalDir` must EQUAL `canonicalBase` or start with
 *   `canonicalBase + path.sep` (the equal case is the target sitting
 *   directly in the base directory; when `canonicalBase` is the
 *   filesystem root "/" everything under it is contained).
 * - `lstat(target)`: if it exists and is a symbolic link -> not contained
 *   ("is a symbolic link"); if it exists and is not a regular file -> not
 *   contained ("is not a regular file"); if it exists with more than one
 *   hard link -> not contained ("is a hard link": a write through it
 *   would change the linked inode outside the run directory); if it does
 *   not exist -> contained (the executor or the worker creates it).
 *
 * Never throws: an uninspectable state is reported as "not contained"
 * with the reason, so callers fail closed. */
export async function proveContained(baseDir: string, target: string): Promise<ContainmentProof> {
  const canonicalBase = await canonicalOrNull(baseDir);
  if (canonicalBase === null) {
    return notContained(`the run directory ${baseDir} could not be resolved to a canonical directory`);
  }
  const canonicalDir = await canonicalOrNull(dirname(target));
  if (canonicalDir === null) {
    return notContained(
      `the parent directory of ${target} could not be resolved to a canonical directory`,
    );
  }
  if (!isUnder(canonicalBase, canonicalDir)) {
    return notContained(
      `${target} resolves to the directory ${canonicalDir}, which is outside ${canonicalBase}`,
    );
  }
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // The target does not exist yet: the executor (envelope) or the
      // worker (result) creates it, and the containing directory is
      // already proven.
      return Object.freeze({
        contained: true,
        canonicalBase,
        canonicalDir,
        problem: "",
      });
    }
    return notContained(`${target} could not be inspected (${code ?? "unknown"})`);
  }
  if (info.isSymbolicLink()) {
    return notContained(`${target} is a symbolic link`);
  }
  if (!info.isFile()) {
    return notContained(`${target} is not a regular file`);
  }
  if (info.nlink > 1) {
    // A hard link is a regular file with a second name elsewhere: a
    // write through it would change the linked inode OUTSIDE the run
    // directory, so it is refused like a symlink.
    return notContained(`${target} is a hard link`);
  }
  return Object.freeze({
    contained: true,
    canonicalBase,
    canonicalDir,
    problem: "",
  });
}

/** Ensure `path` is a real directory: create it when missing, refuse it
 * when it exists as a symlink or as a non-directory. */
async function ensureDirectory(path: string): Promise<{ ok: true } | { ok: false; problem: string }> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return { ok: false, problem: `${path} could not be inspected (${code ?? "unknown"})` };
    }
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        return { ok: false, problem: `${path} could not be created (${code ?? "unknown"})` };
      }
    }
    try {
      info = await lstat(path);
    } catch {
      return { ok: false, problem: `${path} could not be inspected after creation` };
    }
  }
  if (info.isSymbolicLink()) {
    return { ok: false, problem: `${path} is a symbolic link` };
  }
  if (!info.isDirectory()) {
    return { ok: false, problem: `${path} is not a directory` };
  }
  return { ok: true };
}

/** Ensure the directory that will hold `target` exists inside `baseDir`
 * and prove the target is contained.
 *
 * The missing parent components are created ONE AT A TIME, and each one
 * is refused when it already exists as a symlink or a non-directory: a
 * symlinked component would redirect the write outside the run
 * directory, so the creation refuses it instead of following it. The
 * parent must be lexically inside the base directory (the request
 * contract proves that; this helper re-proves it), and the final proof
 * is the same one `proveContained` performs.
 */
export async function ensureContained(baseDir: string, target: string): Promise<ContainmentProof> {
  const parent = dirname(target);
  const relativeParent = relative(baseDir, parent);
  if (relativeParent !== "" && (relativeParent.startsWith("..") || isAbsolute(relativeParent))) {
    return notContained(`${target} must be inside the run directory`);
  }
  let current = baseDir;
  for (const segment of relativeParent.split(sep)) {
    if (segment === "" || segment === ".") continue;
    current = join(current, segment);
    const created = await ensureDirectory(current);
    if (!created.ok) return notContained(created.problem);
  }
  return proveContained(baseDir, target);
}

/** Write `data` to `path` with NO-FOLLOW semantics: a symlinked path is
 * refused (never followed). Opens with
 * `O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW`, mode 0o600. Throws on any
 * failure (the caller treats a throw as fail-closed). */
export async function writeFileNoFollow(path: string, data: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW_FLAG,
    0o600,
  );
  try {
    await handle.writeFile(data, "utf8");
  } finally {
    await handle.close();
  }
}

/** The outcome of a bounded no-follow read. `missing` is the honest
 * "there is no result file" answer; `invalid` covers every refusal
 * (symlinked, not a regular file, too large, unreadable). */
export type BoundedReadOutcome =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" };

/** Read a bounded regular file with NO-FOLLOW semantics.
 *
 * Opens with `O_RDONLY|O_NOFOLLOW` (a symlink is refused, never
 * followed), `fstat`s the SAME descriptor (it must be a regular file and
 * its size must be <= `maxBytes`), and reads at most `maxBytes + 1`
 * bytes from that same descriptor — so the bound cannot be bypassed by
 * swapping the file between a stat and a read.
 *
 * `ENOENT` -> `{kind:"missing"}`; anything else (symlink, not a regular
 * file, too large, unreadable) -> `{kind:"invalid"}`. Never throws. */
export async function readBoundedFileNoFollow(
  path: string,
  maxBytes: number,
): Promise<BoundedReadOutcome> {
  let handle;
  try {
    // `O_NONBLOCK` keeps a FIFO planted in the race window between the
    // proof and this open from blocking the open forever; it has no
    // effect on a regular file.
    handle = await open(
      path,
      constants.O_RDONLY | NOFOLLOW_FLAG | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) {
      return { kind: "invalid" };
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) {
      // The file grew past the cap between the size check and the read.
      return { kind: "invalid" };
    }
    return { kind: "ok", text: buffer.subarray(0, bytesRead).toString("utf8") };
  } catch {
    return { kind: "invalid" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
