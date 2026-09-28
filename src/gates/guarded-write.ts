import { closeSync, constants, lstatSync, openSync, readlinkSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";

/**
 * Workspace-root artifact writes for the gate workloads (#706 PR 6): the port
 * of `_resolve_artifact_path` (pr_reviewer/specialists.py) and
 * `_guarded_write` (scripts/run_specialists.py).
 *
 * - Relative names are workspace-root-relative, never cwd-relative.
 * - The target is resolved the way Python's non-strict `Path.resolve()`
 *   does — symlinks followed component by component, `..` applied after the
 *   preceding component is resolved, a missing tail appended literally — and
 *   must stay inside the resolved root. A symlink that points outside the
 *   workspace is therefore refused; one that stays inside is followed.
 * - The resolved target must not itself be a symlink at write time, and a
 *   failed write is a refusal (`false`), never an exception. No parent
 *   directory is created.
 */

const MAX_SYMLINK_HOPS = 40;

function splitParts(text: string): string[] {
  return text.split("/").filter((part) => part !== "");
}

/** Python's `os.path.realpath(path, strict=False)` for an absolute POSIX path. */
export function resolveNonStrict(absolute: string): string {
  const queue = splitParts(absolute);
  let current = "/";
  let hops = 0;
  while (queue.length > 0) {
    const part = queue.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      current = path.posix.dirname(current);
      continue;
    }
    const candidate = current === "/" ? `/${part}` : `${current}/${part}`;
    let isLink = false;
    try {
      isLink = lstatSync(candidate).isSymbolicLink();
    } catch {
      current = candidate;
      continue;
    }
    if (!isLink) {
      current = candidate;
      continue;
    }
    hops += 1;
    if (hops > MAX_SYMLINK_HOPS) throw new Error(`too many levels of symbolic links: ${candidate}`);
    const target = readlinkSync(candidate);
    if (target.startsWith("/")) current = "/";
    queue.unshift(...splitParts(target));
  }
  return current;
}

/** Resolved workspace root (`Path(root).resolve()`). */
export function resolveRoot(root: string): string {
  const absolute = path.resolve(root);
  try {
    return realpathSync(absolute);
  } catch {
    return resolveNonStrict(absolute);
  }
}

/** `_resolve_artifact_path`: the resolved target inside `root`, or null. */
export function resolveArtifactPath(name: string, workspaceRoot: string): string | null {
  if (name === "" || name.includes("\0")) return null;
  let root: string;
  let target: string;
  try {
    root = resolveRoot(workspaceRoot);
    target = resolveNonStrict(name.startsWith("/") ? name : `${root}/${name}`);
  } catch {
    return null;
  }
  const inside = target === root || target.startsWith(root === "/" ? "/" : `${root}/`);
  return inside ? target : null;
}

/** `_guarded_write`: write `text` to `name` under `workspaceRoot` only. */
export function guardedWrite(workspaceRoot: string, name: string, text: string): boolean {
  const target = resolveArtifactPath(name, workspaceRoot);
  if (target === null) return false;
  // O_NOFOLLOW makes "not a symlink" and the open one step, so a link swapped
  // in after resolution is refused rather than followed.
  let fd: number;
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  } catch {
    return false;
  }
  try {
    writeSync(fd, Buffer.from(text, "utf8"));
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}
