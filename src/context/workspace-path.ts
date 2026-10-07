/** Checkout containment guard (#805): the TS port of `workspace_regular_file`
 * (scripts/sections/common.sh). The reviewed checkout is PR-controlled, so a
 * tracked symlink named like a manifest or standards file could point
 * anywhere on the runner. A path passes only when it names a regular file
 * reachable without following any symlink: every component below the
 * workspace is `lstat`ed and `..` components are refused. A relative path,
 * or an absolute one inside the workspace, is a checkout path; with
 * `allowExternal`, an absolute path outside the workspace is an
 * operator-owned location (an explicit standards file or candidate) and only
 * needs to be a regular file. */

import { lstatSync, statSync } from "node:fs";

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The filesystem path v2 would test for `path` from the workspace cwd. */
export function workspaceFsPath(workspace: string, path: string): string {
  return path.startsWith("/") ? path : `${workspace}/${path}`;
}

export function workspaceRegularFile(workspace: string, path: string, options: { allowExternal?: boolean } = {}): boolean {
  if (path === "") return false;
  let rest: string;
  let current: string;
  if (path.startsWith("/")) {
    if (!path.startsWith(`${workspace}/`)) return options.allowExternal === true && isRegularFile(path);
    rest = path.slice(workspace.length + 1);
    current = workspace;
  } else {
    rest = path;
    current = workspace;
  }
  for (const part of rest.split("/")) {
    if (part === "..") return false;
    if (part === "" || part === ".") continue;
    current = `${current}/${part}`;
    if (isSymlink(current)) return false;
  }
  return isRegularFile(workspaceFsPath(workspace, path));
}

/** `[ -e ] || [ -L ]`: something exists at the path (followed or not). */
export function workspacePathExists(workspace: string, path: string): boolean {
  const full = workspaceFsPath(workspace, path);
  try {
    statSync(full);
    return true;
  } catch {
    return isSymlink(full);
  }
}

/** `[ -e ]` under the #805 containment rule: refuses absolute paths, `..`
 * components and any symlink component, then requires the target to exist.
 * `workspacePathExists` alone follows symlinks, so a checkout symlink pointing
 * at runner state would satisfy an existence check. */
export function workspacePathExistsContained(workspace: string, path: string): boolean {
  if (path === "" || path.startsWith("/")) return false;
  let current = workspace;
  for (const part of path.split("/")) {
    if (part === "..") return false;
    if (part === "" || part === ".") continue;
    current = `${current}/${part}`;
    if (isSymlink(current)) return false;
  }
  try {
    statSync(current);
    return true;
  } catch {
    return false;
  }
}
