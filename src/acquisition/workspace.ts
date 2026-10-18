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
import { mkdir, lstat, readlink, readdir, rm } from "node:fs/promises";
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
/** Security-scan bounds (entries visited / concurrent open directories):
 * a hostile tree cannot make the pre-review scan unbounded. */
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
 * destination yet. Bounded (entry + depth caps); a `Dirent` of unknown
 * type (DT_UNKNOWN mounts) is lstat-resolved rather than silently
 * skipped, so the scan cannot pass vacuously. */
async function assertNoEscapingSymlinks(workspaceDir: string): Promise<void> {
  const stack: string[] = [workspaceDir];
  let visited = 0;
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_SCAN_ENTRIES || stack.length > MAX_SCAN_DEPTH) {
        throw new AcquisitionError("workspace_refusal", "workspace tree exceeds the security-scan bound");
      }
      const fullPath = join(dir, entry.name);
      let isLink = entry.isSymbolicLink();
      let isDir = entry.isDirectory();
      if (!isLink && !isDir && !entry.isFile()) {
        // DT_UNKNOWN: resolve the real type instead of skipping.
        const info = await lstat(fullPath).catch(() => null);
        if (info === null) continue;
        isLink = info.isSymbolicLink();
        isDir = info.isDirectory();
      }
      if (isLink) {
        const target = await readlink(fullPath).catch(() => null);
        if (target === null) continue;
        const resolvedTarget = resolve(dir, target);
        if (resolvedTarget !== workspaceDir && !resolvedTarget.startsWith(workspaceDir + sep)) {
          throw new AcquisitionError("workspace_refusal", "workspace contains a symlink escaping the workspace root");
        }
      }
      if (isDir) {
        stack.push(fullPath);
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
  const workspacesRoot = await mkdirWorkspacesRoot(mirror);

  return mirror.lock(async () => {
    await requireCommit(gitBinary, mirror.path, headSha, "head");

    const workspaceDir = join(workspacesRoot, randomUUID());
    await mkdir(workspacesRoot, { recursive: true, mode: 0o700 });

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

    const info: WorkspaceInfo = {
      rootPath: workspaceDir,
      headSha,
      mergeBaseSha,
      platform: mirror.platform,
      repoFullName: mirror.repoFullName,
      createdAtMs: Date.now(),
    };

    try {
      await assertNoEscapingSymlinks(workspaceDir);
    } catch (error) {
      await removeWorktree(gitBinary, mirror.path, workspaceDir).catch(() => undefined);
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

async function mkdirWorkspacesRoot(mirror: MirrorCache): Promise<string> {
  const root = resolve(join(mirror.path, "..", "workspaces"));
  await mkdir(root, { recursive: true, mode: 0o700 });
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
