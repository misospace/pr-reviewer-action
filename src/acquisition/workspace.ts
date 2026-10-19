/** Isolated per-review workspaces (#732).
 *
 * Extraction is a detached `git worktree add` from the mirror at a PINNED
 * head SHA — the commit is verified to exist before any workspace is
 * created, so a review can never run against a moved ref. Workspace paths
 * are controller-generated UUIDs inside the controller-owned `workspaces/`
 * root next to the mirror; no repo-controlled name ever becomes a path.
 *
 * Extraction and mirror mutation are serialized by the shared per-mirror
 * mutex; an ACTIVE workspace is protected from concurrent fetches by its
 * registered worktree HEAD (objects reachable from a registered worktree
 * are never pruned), and this module never runs gc/prune/repack.
 *
 * Explicit security policy:
 * - Symlinks: after checkout the tree is scanned WITHOUT following links;
 *   any symlink whose target resolves outside the workspace directory is a
 *   fail-closed refusal — the workspace is torn down and
 *   `workspace_refusal` is thrown. In-root symlinks are tolerated.
 * - Hooks are never executed: global/system git config is neutralized for
 *   every invocation (`git-env.ts`), `core.hooksPath` is pointed at a
 *   disabled empty directory for worktree commands, and no git command is
 *   ever run with cwd inside the workspace.
 * - Submodules are never initialized (no `submodule update` exists on this
 *   path; `.gitmodules` stays inert data).
 * - LFS is never smudged (no git-lfs is ever invoked; pointer files remain
 *   as committed).
 * - A `safe.directory` cross-tenant escape is impossible: no
 *   tenant-controlled global/system config is ever read, and git ignores
 *   `safe.directory` from repo-local config by design.
 *
 * Crash recovery: `sweepStaleWorkspaces` removes workspaces left behind by
 * workers that died before `close()` (age-based) and prunes their worktree
 * registrations.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, lstat, readlink, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { runProcess } from "../runtime/subprocess.js";
import { gitInvocationEnv } from "./git-env.js";
import type { MirrorCache } from "./mirror.js";
import { AcquisitionError, type AcquisitionFailureCode, type WorkspaceHandle, type WorkspaceInfo } from "./types.js";

const SHA_RE = /^[0-9a-f]{7,64}$/;
const MAX_GIT_OUTPUT_BYTES = 1_048_576;
const GIT_TERMINATE_GRACE_MS = 5_000;
/** Workspace lifecycle cap: `close()` gets its own bounded window. */
const CLOSE_TIMEOUT_MS = 60_000;
/** Security-scan bounds (entries visited / directory depth): a hostile
 * tree cannot make the pre-review scan unbounded. */
const MAX_SCAN_ENTRIES = 200_000;
const MAX_SCAN_DEPTH = 64;

const WS_GIT_ARGS = ["-c", "gc.auto=0", "-c", `core.hooksPath=${"/dev/null/nonexistent-hooks"}`] as const;

function normalizeSha(raw: string, what: string): string {
  const value = raw.trim().toLowerCase();
  if (!SHA_RE.test(value)) {
    throw new AcquisitionError("invalid_head", `${what} is not a valid commit SHA`);
  }
  return value;
}

interface GitOutcome {
  stdout: Buffer;
  /** "exited" with exitCode when git ran to completion; anything else on
   * timeout/cancel/launch refusal. */
  status: string;
  exitCode: number | null;
}

async function runGit(
  gitBinary: string,
  cwd: string,
  args: readonly string[],
  options: { label: string; failureCode: AcquisitionFailureCode; signal?: AbortSignal | undefined },
): Promise<GitOutcome> {
  const handle = runProcess({
    file: gitBinary,
    args: [...args],
    cwd,
    env: gitInvocationEnv(process.env),
    timeoutMs: CLOSE_TIMEOUT_MS,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    terminateGraceMs: GIT_TERMINATE_GRACE_MS,
  });
  const result = await handle.result;
  // Diagnostics carry the subcommand label and the outcome only — never
  // argv content or stderr, so credential/path material cannot leak.
  if (result.status === "timeout" || result.status === "cancelled") {
    throw new AcquisitionError(options.failureCode, `git ${options.label}: did not complete`);
  }
  if (result.status !== "exited") {
    throw new AcquisitionError(options.failureCode, `git ${options.label}: ${result.status}`);
  }
  return { stdout: result.stdout, status: result.status, exitCode: result.exitCode };
}

/** Verify `sha` exists as a commit object in the mirror. */
async function requireCommit(
  gitBinary: string,
  mirrorPath: string,
  sha: string,
  kind: "head" | "base",
): Promise<void> {
  const outcome = await runGit(gitBinary, mirrorPath, ["cat-file", "-e", `${sha}^{commit}`], {
    label: "cat-file",
    failureCode: kind === "head" ? "head_not_found" : "base_not_found",
  });
  if (outcome.exitCode !== 0) {
    throw new AcquisitionError(
      kind === "head" ? "head_not_found" : "base_not_found",
      `${kind} commit ${sha} is not present in the mirror`,
    );
  }
}

/** Post-checkout symlink scan (lstat, never following links): any symlink
 * whose target resolves outside the workspace directory is refused —
 * resolved TEXTUALLY (readlink + join + normalize), so a broken or
 * hostile `../` escape pointer is caught even though nothing exists at its
 * destination yet. Bounded by REAL directory depth (`MAX_SCAN_DEPTH`) and
 * total entries (`MAX_SCAN_ENTRIES`), so a hostile tree cannot make the
 * pre-review scan unbounded. The scan never reports success over
 * uninspectable state: an unreadable directory, an unreadable symlink
 * target, or a `Dirent` of unknown type (DT_UNKNOWN mounts) that cannot be
 * lstat-resolved is a fail-closed `workspace_refusal`, never a silent
 * skip. */
export async function assertNoEscapingSymlinks(workspaceDir: string): Promise<void> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: workspaceDir, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const frame = stack.pop() as { dir: string; depth: number };
    const dir = frame.dir;
    const depth = frame.depth;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      throw new AcquisitionError("workspace_refusal", "workspace security scan could not read a workspace directory");
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_SCAN_ENTRIES) {
        throw new AcquisitionError("workspace_refusal", "workspace tree exceeds the security-scan bound");
      }
      const fullPath = join(dir, entry.name);
      let isLink = entry.isSymbolicLink();
      let isDir = entry.isDirectory();
      if (!isLink && !isDir && !entry.isFile()) {
        // DT_UNKNOWN: resolve the real type instead of skipping; an entry
        // that cannot be resolved is a refusal, not a vacuous pass.
        const info = await lstat(fullPath).catch(() => null);
        if (info === null) {
          throw new AcquisitionError("workspace_refusal", "workspace security scan could not inspect a workspace entry");
        }
        isLink = info.isSymbolicLink();
        isDir = info.isDirectory();
      }
      if (isLink) {
        const target = await readlink(fullPath).catch(() => null);
        if (target === null) {
          throw new AcquisitionError("workspace_refusal", "workspace security scan could not read a symlink target");
        }
        const resolvedTarget = resolve(dir, target);
        if (resolvedTarget !== workspaceDir && !resolvedTarget.startsWith(workspaceDir + sep)) {
          throw new AcquisitionError("workspace_refusal", "workspace contains a symlink escaping the workspace root");
        }
      }
      if (isDir) {
        // Bound real directory depth, not the pending-stack width: a
        // deeper tree is refused before it is descended into.
        if (depth + 1 > MAX_SCAN_DEPTH) {
          throw new AcquisitionError("workspace_refusal", "workspace tree exceeds the security-scan depth bound");
        }
        stack.push({ dir: fullPath, depth: depth + 1 });
      }
    }
  }
}

export interface WorkspaceRequest {
  /** Pinned head commit SHA the review is about (required). */
  readonly headSha: string;
  /** Effective base/merge-base input SHA; "" or undefined = not required. */
  readonly baseSha?: string;
  readonly signal?: AbortSignal;
  readonly gitBinary?: string;
}

/** Extract an isolated exact-head workspace from the mirror at the pinned
 * head. Serialized with mirror mutation under the shared per-mirror mutex. */
export async function createReviewWorkspace(
  mirror: MirrorCache,
  request: WorkspaceRequest,
): Promise<WorkspaceHandle> {
  const headSha = normalizeSha(request.headSha, "headSha");
  const baseSha = request.baseSha === undefined ? "" : normalizeSha(request.baseSha, "baseSha");
  const gitBinary = request.gitBinary ?? "git";

  return mirror.lock(async () => {
    await requireCommit(gitBinary, mirror.path, headSha, "head");

    // The controller-owned root is verified at the point of use, inside the
    // same lock that creates worktrees beneath it.
    const workspacesRoot = await mkdirWorkspacesRoot(mirror);
    const workspaceDir = join(workspacesRoot, randomUUID());

    // Hooks can never run: config is neutralized (git-env) AND core.hooksPath
    // points at a disabled nonexistent path.
    await runGit(gitBinary, mirror.path, [
      ...WS_GIT_ARGS,
      "worktree",
      "add",
      "--detach",
      "--quiet",
      workspaceDir,
      headSha,
    ], { label: "worktree add", failureCode: "fetch_failed", signal: request.signal });

    // EVERYTHING after a successful `worktree add` runs under this guard: a
    // failure (missing base SHA, cancellation, merge-base error, scan
    // refusal) must not leave the checkout directory or the registered
    // worktree behind. The primary error is preserved.
    let info: WorkspaceInfo;
    try {
      let mergeBaseSha = "";
      if (baseSha !== "") {
        // The base must actually be in the mirror: a base SHA that was never
        // acquired (e.g. a tag SHA, since tags are deliberately not fetched)
        // must fail loudly, not silently degrade to the unrelated-histories
        // sentinel.
        await requireCommit(gitBinary, mirror.path, baseSha, "base");
        const outcome = await runGit(gitBinary, mirror.path, ["merge-base", baseSha, headSha], {
          label: "merge-base",
          failureCode: "fetch_failed",
          signal: request.signal,
        });
        if (outcome.exitCode === 0) {
          mergeBaseSha = outcome.stdout.toString("utf8").trim().toLowerCase();
        } else if (outcome.exitCode === 1) {
          // Unrelated histories: surfaced as "" (never guessed); the executor
          // decides how a missing merge-base degrades.
          mergeBaseSha = "";
        } else {
          throw new AcquisitionError("fetch_failed", `git merge-base: exited ${outcome.exitCode ?? "unknown"}`);
        }
        if (mergeBaseSha !== "" && !SHA_RE.test(mergeBaseSha)) {
          throw new AcquisitionError("fetch_failed", "git merge-base: malformed output");
        }
      }

      info = {
        rootPath: workspaceDir,
        headSha,
        mergeBaseSha,
        platform: mirror.platform,
        repoFullName: mirror.repoFullName,
        createdAtMs: Date.now(),
      };

      await assertNoEscapingSymlinks(workspaceDir);
    } catch (error) {
      await removeWorktree(gitBinary, mirror.path, workspaceDir).catch(() => undefined);
      // Best-effort: if the scan refused on an unreadable directory, the
      // recursive rm needs traversal permission on it — restore owner
      // access first, then remove; a chmod failure still swallows.
      await chmod(workspaceDir, 0o700).catch(() => undefined);
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    let closed = false;
    const handle: WorkspaceHandle = {
      info,
      close: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await mirror.lock(async () => {
          await removeWorktree(gitBinary, mirror.path, workspaceDir).catch(() => undefined);
          await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
        });
      },
    };
    return handle;
  });
}

async function removeWorktree(gitBinary: string, mirrorPath: string, workspaceDir: string): Promise<void> {
  await runGit(gitBinary, mirrorPath, [...WS_GIT_ARGS, "worktree", "remove", "--force", workspaceDir], {
    label: "worktree remove",
    failureCode: "fetch_failed",
  });
}

/** Controller-owned workspaces root next to the mirror. Fail closed like
 * the cache-root check in `mirror.ts`: an existing path that is a symlink
 * or not a directory is REFUSED — `git worktree add` must never create
 * checkouts beneath an attacker-chosen target outside this root. A fresh
 * creation is re-verified on disk so a racing symlink cannot stand in for
 * the controller-owned root. */
async function mkdirWorkspacesRoot(mirror: MirrorCache): Promise<string> {
  const root = resolve(join(mirror.path, "..", "workspaces"));
  let info;
  try {
    info = await lstat(root);
  } catch {
    await mkdir(root, { recursive: true, mode: 0o700 }).catch((error: unknown) => {
      // A racing creator (or a hostile symlink-to-file winning an EEXIST
      // race) must surface as the module's own refusal code, not a raw fs
      // error outside the error contract.
      throw new AcquisitionError(
        "workspace_refusal",
        `workspaces root could not be created: ${root}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    info = await lstat(root).catch(() => null);
    if (info === null) {
      throw new AcquisitionError("workspace_refusal", `workspaces root is not inspectable: ${root}`);
    }
  }
  if (info.isSymbolicLink()) {
    throw new AcquisitionError("workspace_refusal", `workspaces root is a symlink: ${root}`);
  }
  if (!info.isDirectory()) {
    throw new AcquisitionError("workspace_refusal", `workspaces root is not a directory: ${root}`);
  }
  return root;
}

export interface SweepResult {
  readonly removed: number;
  readonly failed: number;
}

/** Crash recovery: remove workspace directories older than `maxAgeMs` and
 * prune their mirror worktree registrations. Removals and the prune run
 * under the per-mirror lock so they cannot interleave with extraction or
 * close().
 *
 * The age is a HEURISTIC for workers that died before `close()`: a live
 * review that only reads its tree never bumps the directory mtime, so an
 * executor using this sweep MUST keep `maxAgeMs` comfortably above its
 * review deadline (or own a real liveness registry — #733 scope). */
export async function sweepStaleWorkspaces(
  mirror: MirrorCache,
  options: { maxAgeMs: number; nowMs?: number; gitBinary?: string },
): Promise<SweepResult> {
  const workspacesRoot = resolve(join(mirror.path, "..", "workspaces"));
  const cutoff = (options.nowMs ?? Date.now()) - options.maxAgeMs;
  const gitBinary = options.gitBinary ?? "git";
  let removed = 0;
  let failed = 0;
  let entries: string[];
  try {
    entries = await readdir(workspacesRoot);
  } catch {
    return { removed, failed };
  }
  const stale: string[] = [];
  for (const entry of entries) {
    const dir = join(workspacesRoot, entry);
    try {
      const info = await lstat(dir);
      if (!info.isDirectory()) continue;
      // mtime only: ctime cannot be backdated and would make every
      // observed age look fresh.
      if (info.mtimeMs > cutoff) continue;
      stale.push(dir);
    } catch {
      failed += 1;
      continue;
    }
  }
  if (stale.length > 0) {
    await mirror.lock(async () => {
      for (const dir of stale) {
        try {
          await rm(dir, { recursive: true, force: true });
          removed += 1;
        } catch {
          failed += 1;
        }
      }
      await runGit(gitBinary, mirror.path, [...WS_GIT_ARGS, "worktree", "prune"], {
        label: "worktree prune",
        failureCode: "fetch_failed",
      }).catch(() => undefined);
    });
  }
  return { removed, failed };
}
