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
 * registrations. Because every mirror under a cache root shares ONE sibling
 * `workspaces` root, the sweep only removes entries whose `.git` gitdir
 * pointer proves ownership by the supplied mirror — a shared root can never
 * leak cross-repository removals — and leaves unprovable entries in place
 * (a pointerless entry is unprovable by ANY sweep; reclaiming those stays
 * operator/maintenance work). The sweep applies the SAME workspaces-root
 * refusal as extraction: a symlinked or non-directory root is refused, a
 * missing root is a no-op, and the root is re-verified inside the mirror
 * lock immediately before the removals, so a root swapped mid-sweep is
 * refused rather than swept.
 */

import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, lstat, open, readlink, readdir, realpath, rm } from "node:fs/promises";
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
  // The documented empty-string sentinel is honored verbatim; any nonempty
  // value (including whitespace-only) must still pass SHA validation.
  const baseSha =
    request.baseSha === undefined || request.baseSha === "" ? "" : normalizeSha(request.baseSha, "baseSha");
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

/** The identity of the controller-owned workspaces root, captured before
 * the sweep's removals so a root swapped underneath the sweep is
 * detected. `dev`/`ino` are compared only when the captured pair is
 * non-zero (some platforms report 0), so a platform quirk can never turn
 * into a false refusal. */
interface WorkspacesRootIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** Fail closed on the workspaces root before the sweep removes anything:
 * the sweep deletes directories, so a root that is a symlink or not a
 * directory could redirect that removal at real directories OUTSIDE
 * controller storage. Returns the root's identity, or null when the root
 * does not exist — the sweep is then a no-op and never creates it (only
 * `mkdirWorkspacesRoot` does). An uninspectable root is a refusal, not a
 * silently empty sweep. */
async function assertSweepableWorkspacesRoot(workspacesRoot: string): Promise<WorkspacesRootIdentity | null> {
  let info;
  try {
    info = await lstat(workspacesRoot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw new AcquisitionError(
      "workspace_refusal",
      `workspaces root is not inspectable (${code ?? "unknown"}): ${workspacesRoot}`,
    );
  }
  if (info.isSymbolicLink()) {
    throw new AcquisitionError("workspace_refusal", `workspaces root is a symlink: ${workspacesRoot}`);
  }
  if (!info.isDirectory()) {
    throw new AcquisitionError("workspace_refusal", `workspaces root is not a directory: ${workspacesRoot}`);
  }
  return { dev: info.dev, ino: info.ino };
}

/** Same root? The identity is compared only when the captured pair has a
 * non-zero dev AND a non-zero ino; a zero-vs-zero mismatch is never a
 * reason to refuse. */
function isSameWorkspacesRoot(captured: WorkspacesRootIdentity, current: WorkspacesRootIdentity): boolean {
  if (captured.dev === 0 || captured.ino === 0) {
    return true;
  }
  return captured.dev === current.dev && captured.ino === current.ino;
}

/** Bound for reading a worktree `.git` pointer file (a single path line);
 * the pointer is controller-owned, the cap only matches the module's
 * bounding style. */
const GIT_POINTER_MAX_BYTES = 4096;
/** `O_NOFOLLOW` is not defined on every platform; there the no-follow
 * guarantee degrades to the platform default (the read stays bounded and
 * same-descriptor either way). */
const NOFOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

/** Read a small worktree pointer file (a workspace's `.git`) WITHOUT a
 * check-then-use gap: open once with no-follow semantics (a symlinked file
 * is refused, never followed), size-check via `fstat` on that descriptor,
 * and read at most maxBytes+1 from the SAME descriptor — so the bound
 * cannot be bypassed by swapping the file between a separate stat and
 * read, and the bytes read are provably the bytes that were size-checked.
 * `null` on any failure (unreadable, symlinked, not a regular file,
 * oversized): callers treat that as unproven, fail closed. */
async function readBoundedGitPointer(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW_FLAG);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > GIT_POINTER_MAX_BYTES) {
      return null;
    }
    const buffer = Buffer.alloc(GIT_POINTER_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, GIT_POINTER_MAX_BYTES + 1, 0);
    if (bytesRead > GIT_POINTER_MAX_BYTES) {
      return null;
    }
    return buffer.subarray(0, bytesRead).toString("utf8").trim();
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Prove that a directory under the SHARED workspaces root belongs to the
 * supplied mirror: git's worktree admin pointer (the workspace's `.git`
 * file, `gitdir: <path>`) must name an admin directory strictly inside the
 * mirror's directory. The target is resolved TEXTUALLY from the workspace
 * directory (a relative `gitdir:` that traverses out lands outside and
 * fails), and containment is checked both against the mirror's textual
 * path and, when that path's ancestors include a symlink, against its
 * `realpath` (git writes the admin pointer canonicalized, so a symlinked
 * tmpdir ancestor must not break the proof). Any failure — missing,
 * unreadable, or symlinked pointer, oversized pointer, content that is
 * not a `gitdir:` line, or a pointer target outside the mirror — is
 * unproven: the entry is left in place (fail closed, never removed) for
 * whoever can prove it. */
async function workspaceOwnedByMirror(dir: string, mirrorPath: string): Promise<boolean> {
  try {
    const raw = await readBoundedGitPointer(join(dir, ".git"));
    if (raw === null) {
      return false;
    }
    // Only the FIRST line is the pointer (`gitdir: <path>`); trailing lines
    // are junk no valid pointer carries, so the parsed value is that single
    // line, never a blob whose tail could smuggle a path component in.
    const line = raw.slice(0, raw.indexOf("\n") === -1 ? raw.length : raw.indexOf("\n")).trimEnd();
    if (!line.startsWith("gitdir:")) {
      return false;
    }
    const target = resolve(dir, line.slice("gitdir:".length).trim());
    const prefix = resolve(mirrorPath);
    if (target.startsWith(prefix + sep)) {
      return true;
    }
    const realPrefix = await realpath(mirrorPath);
    return target.startsWith(realPrefix + sep);
  } catch {
    return false;
  }
}

/** Crash recovery: remove workspace directories older than `maxAgeMs` and
 * prune their mirror worktree registrations. Removals and the prune run
 * under the per-mirror lock so they cannot interleave with extraction or
 * close().
 *
 * Ownership is proven per entry BEFORE any removal: every mirror under
 * the cache root shares one sibling `workspaces` root, so an aged entry
 * is only removed when its `.git` gitdir pointer names an admin directory
 * strictly inside the supplied mirror's directory (textual containment,
 * or containment under the mirror's `realpath` when an ancestor is a
 * symlink; git writes the pointer canonicalized). An entry whose
 * ownership cannot be proven — missing or unreadable or symlinked
 * pointer, oversized pointer, content that is not a `gitdir:` line, or a
 * pointer target outside the mirror — is left in place: a shared root can
 * never cause cross-repository removals, a skipped entry counts as neither
 * removed nor failed, and an entry unprovable by every sweep stays
 * operator/maintenance work.
 *
 * The sweep REJECTS with `AcquisitionError("workspace_refusal")` when the
 * workspaces root is hostile (a symlink or not a directory), when it
 * cannot be inspected, or when its identity changes between the pre-lock
 * check and the removals: a root swapped mid-sweep must not send the
 * removals at a path outside controller storage. A missing root is a
 * no-op that returns `{removed: 0, failed: 0}` — the sweep never creates
 * it (only `mkdirWorkspacesRoot` does) and removes nothing.
 *
 * Limits of the identity guard, stated plainly: the comparison is skipped
 * when the platform reports a zero `dev`/`ino` (so a swap cannot be
 * detected there), and the check is NOT atomic with the removals — it
 * narrows the swap window rather than closing it.
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
  // Pre-lock check: fail fast on a hostile root and capture its identity
  // so a root swapped before the removals is detected below.
  const rootIdentity = await assertSweepableWorkspacesRoot(workspacesRoot);
  if (rootIdentity === null) {
    return { removed, failed };
  }
  let entries: string[];
  try {
    entries = await readdir(workspacesRoot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // The root vanished between the check and the read: nothing to sweep.
      return { removed, failed };
    }
    throw new AcquisitionError(
      "workspace_refusal",
      `workspaces root could not be read (${code ?? "unknown"}): ${workspacesRoot}`,
    );
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
      // Ownership proof: every mirror under the cache root shares this one
      // workspaces root, so an aged entry that does not prove itself THIS
      // mirror's own worktree (via its `.git` gitdir pointer) belongs to a
      // mirror — it is skipped (neither removed nor failed) and left in
      // place; only that mirror's own sweep can prove and reclaim it.
      if (!(await workspaceOwnedByMirror(dir, mirror.path))) continue;
      stale.push(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // The entry vanished between the listing and the lstat (e.g. a
        // concurrent close() removed it): nothing stale is left to remove.
        continue;
      }
      failed += 1;
      continue;
    }
  }
  if (stale.length > 0) {
    await mirror.lock(async () => {
      // Re-verify the root INSIDE the lock, immediately before the
      // removals: the paths below are built from the root, so a root
      // swapped since the pre-lock check would point the removals
      // outside controller storage.
      const current = await assertSweepableWorkspacesRoot(workspacesRoot);
      if (current === null) {
        return; // the root vanished: remove nothing
      }
      if (!isSameWorkspacesRoot(rootIdentity, current)) {
        throw new AcquisitionError("workspace_refusal", `workspaces root changed during the sweep: ${workspacesRoot}`);
      }
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
