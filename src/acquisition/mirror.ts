/** Persistent bare mirror cache (#732).
 *
 * One bare mirror per (platform, repository) pair, keyed by a sha256 digest
 * of the normalized coordinates — the directory name is controller-derived,
 * never repo-controlled text, so a hostile owner/name cannot escape the
 * cache root. Reviews fetch incrementally into the mirror instead of
 * recloning from the forge, then extract isolated exact-head workspaces
 * (`workspace.ts`).
 *
 * Hard rules:
 * - Every git invocation is argv-only through `runProcess` (no shell), with
 *   the allowlisted env of `git-env.ts`, bounded output, a bounded timeout,
 *   and an external cancellation signal.
 * - Nothing is ever persisted into the mirror's git config: fetches address
 *   the clone URL directly as an argv argument (no remotes), and the only
 *   `-c` config passed is non-secret (`gc.auto=0`,
 *   `fetch.showForcedUpdates=false`). Credentials ride solely in the child
 *   env (`gitCredentialEnv`) on fetch invocations.
 * - Fetches carry the canonical head refspec (`refs/pull/*`) so fork PR
 *   heads are acquired without trusting contributor branch coordinates.
 * - Mirror mutation (init/fetch) and workspace extraction from a mirror are
 *   serialized under one per-mirror in-process mutex; an active workspace's
 *   objects stay reachable because the worktree's registered HEAD protects
 *   them and this module never runs gc/prune/repack (auto-gc is disabled on
 *   every mirror command).
 * - A corrupted mirror is detected (fetch failure on an existing mirror →
 *   bounded `fsck` probe) and rebuilt exactly once per ensure; a rebuild
 *   that also fails fails closed. A rebuild is DEFERRED (fail closed, the
 *   mirror is left intact) while any registered worktree exists, so
 *   maintenance can never invalidate an active workspace.
 */

import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseRepoRef } from "../platform/repo-ref.js";
import { pullHeadRefspec } from "../platform/head-ref.js";
import { runProcess } from "../runtime/subprocess.js";
import { gitCredentialEnv, gitInvocationEnv, safeCloneUrl } from "./git-env.js";
import { AcquisitionError, type AcquisitionFailureCode, type FetchCredentials, type MirrorInfo } from "./types.js";

const DEFAULT_FETCH_TIMEOUT_MS = 600_000;
const FSCK_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT_BYTES = 1_048_576;
/** TERM→KILL grace for a timed-out fetch: generous, git shutdown is slow. */
const GIT_TERMINATE_GRACE_MS = 5_000;
/** Bound for reading a worktree admin `gitdir` file (a path line); the
 * admin dir is controller-owned, the cap only matches the module's
 * bounding style. */
const GITDIR_MAX_BYTES = 4096;
/** `O_NOFOLLOW` is not defined on every platform; there the no-follow
 * guarantee degrades to the platform default (the read stays bounded and
 * same-descriptor either way). */
const NOFOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

/** Read a small bookkeeping file (git worktree admin `gitdir`) WITHOUT a
 * check-then-use gap: open once with no-follow semantics (a symlinked file
 * is refused, never followed), size-check via `fstat` on that descriptor,
 * and read at most maxBytes+1 from the SAME descriptor — so the bound
 * cannot be bypassed by swapping the file between a separate stat and
 * read, and the bytes read are provably the bytes that were size-checked.
 * `null` on any failure (unreadable, symlinked, not a regular file,
 * oversized): callers treat that as unproven, fail closed. */
async function readBoundedRegularFile(path: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW_FLAG);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) {
      return null;
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) {
      return null;
    }
    return buffer.subarray(0, bytesRead).toString("utf8").trim();
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
/** Branch refspec every fetch carries (forced update; tags deliberately NOT
 * fetched — forge/fork tags are attack surface no review path needs). */
const BRANCH_REFSPEC = "+refs/heads/*:refs/heads/*";

/** Compose the fetch refspecs from the platform seam: branches plus the
 * canonical per-PR head namespace (`pullHeadRefspec`), so fork PR heads are
 * acquired without trusting contributor branch coordinates. */
function fetchRefspecs(platform: "github" | "forgejo"): string[] {
  const pullRefspec = pullHeadRefspec(platform);
  if (pullRefspec === null) {
    throw new AcquisitionError("invalid_config", `no pull refspec for platform ${platform}`);
  }
  return [BRANCH_REFSPEC, pullRefspec];
}

/** Per-mirror in-process mutex, shared with the workspace module so mirror
 * mutation and extraction never interleave. NOT reentrant: calling
 * `withMirrorLock` on the same key from inside one of its callbacks
 * deadlocks forever — chain disjoint phases instead. */
const mirrorLocks = new Map<string, Promise<unknown>>();

export function withMirrorLock<T>(mirrorPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = mirrorLocks.get(mirrorPath) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const tail = next.catch(() => undefined);
  mirrorLocks.set(mirrorPath, tail);
  void tail.then(() => {
    if (mirrorLocks.get(mirrorPath) === tail) mirrorLocks.delete(mirrorPath);
  });
  return next;
}

/** Stable, repo-independent mirror directory name: `sha256(...).git` under
 * the cache root. Coordinates are validated before hashing. */
export function mirrorDirName(platform: string, repoFullName: string): string {
  const ref = parseRepoRef(repoFullName);
  if (ref === null || (platform !== "github" && platform !== "forgejo")) {
    throw new AcquisitionError("invalid_config", "invalid platform or repoFullName");
  }
  const digest = createHash("sha256").update(`${platform}\n${ref.owner}/${ref.name}\n`).digest("hex");
  return `${digest}.git`;
}

export interface MirrorOptions {
  /** Absolute cache root the controller owns. Created (0700) if missing;
   * before it is trusted (after any creation) the whole path is walked:
   * any symlinked or non-directory component, a root writable by
   * group/other, or a root not owned by the controller uid is refused. */
  readonly rootDir: string;
  readonly platform: "github" | "forgejo";
  readonly repoFullName: string;
  /** http(s) clone URL without embedded credentials (validated). */
  readonly cloneUrl: string;
  /** Bounded fetch timeout, separate from any review deadline. Default 10m. */
  readonly fetchTimeoutMs?: number;
  readonly gitBinary?: string;
  readonly credentials?: FetchCredentials;
  readonly signal?: AbortSignal;
}

interface GitRunOptions {
  cwd: string;
  args: readonly string[];
  /** Human-facing subcommand for diagnostics (e.g. "fetch", "init"); argv
   * leads with `-c` config pairs, so args[0] is not a usable name. Never
   * carries argv or stderr content. */
  label: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  extraEnv?: NodeJS.ProcessEnv | undefined;
  failureCode?: AcquisitionFailureCode | undefined;
}

interface GitRunResult {
  stdout: Buffer;
  status: string;
  exitCode: number | null;
}

async function runGit(gitBinary: string, opts: GitRunOptions): Promise<GitRunResult> {
  const failureCode = opts.failureCode ?? "fetch_failed";
  const handle = runProcess({
    file: gitBinary,
    args: [...opts.args],
    cwd: opts.cwd,
    env: gitInvocationEnv(process.env, opts.extraEnv ?? {}),
    timeoutMs: opts.timeoutMs,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    terminateGraceMs: GIT_TERMINATE_GRACE_MS,
  });
  const result = await handle.result;
  // Diagnostics carry the subcommand label and the outcome only — never
  // argv content or stderr, so credential/URL material cannot leak.
  if (result.status === "timeout") {
    throw new AcquisitionError("fetch_timeout", `git ${opts.label}: timed out after ${opts.timeoutMs}ms`);
  }
  if (result.status === "cancelled") {
    throw new AcquisitionError(failureCode, `git ${opts.label}: cancelled`);
  }
  if (result.status !== "exited" || result.exitCode !== 0) {
    throw new AcquisitionError(
      failureCode,
      `git ${opts.label}: exited ${result.exitCode ?? result.signal ?? "unknown"}`,
    );
  }
  return { stdout: result.stdout, status: result.status, exitCode: result.exitCode };
}

/** Walk every component of a resolved absolute path (leaf included) and
 * prove it is a chain of real directories — no component may be a symlink
 * (`lstat` sees links, so a symlinked ancestor cannot silently redirect
 * creation or use below it) — and then prove the LEAF (the cache root
 * itself) is a private, controller-owned directory: no group/other write,
 * and owned by the process uid where ownership is inspectable. Fail
 * closed on any lstat that cannot prove a component. */
async function assertTrustedDirChain(resolved: string, label: string): Promise<void> {
  const segments = resolved.split("/").filter((segment) => segment.length > 0);
  let current = "/";
  for (const segment of segments) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch {
      throw new AcquisitionError("invalid_config", `${label} path component is not inspectable: ${current}`);
    }
    if (!info.isDirectory()) {
      throw new AcquisitionError("invalid_config", `${label} path component is not a real directory: ${current}`);
    }
  }
  const rootInfo = await lstat(resolved);
  if ((rootInfo.mode & 0o022) !== 0) {
    throw new AcquisitionError("invalid_config", `${label} is writable by group or other: ${resolved}`);
  }
  if (process.getuid !== undefined && rootInfo.uid !== process.getuid()) {
    throw new AcquisitionError("invalid_config", `${label} is not owned by the controller uid: ${resolved}`);
  }
}

async function ensureRealDir(path: string, label: string): Promise<string> {
  const resolved = resolve(path);
  try {
    await lstat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // An lstat that proves nothing (EACCES, ELOOP, ...) must not be
      // treated as "absent" and papered over by a mkdir.
      throw new AcquisitionError("invalid_config", `${label} is not inspectable: ${resolved}`);
    }
    await mkdir(resolved, { recursive: true, mode: 0o700 });
  }
  // Revalidate AFTER creation, not just before: recursive `mkdir` reports
  // success when the leaf is already a symlink to an existing directory
  // (possibly planted between the ENOENT above and the mkdir) and silently
  // traverses symlinked ancestors, so the fresh-creation path is only
  // trusted once the full chain has been re-checked at the filesystem
  // level. Whichever side of the mkdir the hostile link was planted on,
  // the refusal precedes every git invocation; the only residue is at
  // most one empty directory (possibly created through a hostile link
  // that the walk then refuses), never a mirror or fetch writes.
  await assertTrustedDirChain(resolved, label);
  return resolved;
}

/** Only a genuinely absent path may be initialized. Any existing
 * non-directory (symlink, file) — or any non-ENOENT lstat error, which
 * leaves inspectability unproven — is refused: `git init --bare` must
 * never run through a planted link at the deterministic mirror path and
 * redirect mirror initialization and fetch writes outside the cache root. */
async function requireAbsentOrRealDir(mirrorPath: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(mirrorPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw new AcquisitionError("invalid_config", "mirror path is not inspectable");
  }
  if (!info.isDirectory()) {
    throw new AcquisitionError("invalid_config", "mirror path exists but is not a directory");
  }
  return false;
}

export class MirrorCache {
  private readonly gitBinary: string;
  private readonly cloneUrl: string;
  private readonly mirrorPath: string;
  private readonly fetchTimeoutMs: number;
  private readonly credentials: FetchCredentials | undefined;
  private readonly signal: AbortSignal | undefined;

  constructor(private readonly options: MirrorOptions) {
    const rootDir = resolve(options.rootDir);
    if (!rootDir.startsWith("/") || rootDir === "/") {
      throw new AcquisitionError("invalid_config", "rootDir must be an absolute path");
    }
    const url = safeCloneUrl(options.cloneUrl);
    if (url === null) {
      throw new AcquisitionError("invalid_config", "cloneUrl must be a credential-free http(s) URL");
    }
    // The credential is BOUND to the URL it authorizes; pairing a
    // credential for host A with a clone URL for host B would send A's
    // token to B, so a mismatch fails closed at construction.
    if (options.credentials !== undefined && safeCloneUrl(options.credentials.cloneUrl) !== url) {
      throw new AcquisitionError("invalid_config", "credentials.cloneUrl does not match cloneUrl");
    }
    // Validates coordinates and throws invalid_config on bad input.
    mirrorDirName(options.platform, options.repoFullName);
    this.gitBinary = options.gitBinary ?? "git";
    this.cloneUrl = url;
    this.mirrorPath = join(rootDir, mirrorDirName(options.platform, options.repoFullName));
    this.fetchTimeoutMs =
      options.fetchTimeoutMs !== undefined && Number.isSafeInteger(options.fetchTimeoutMs) && options.fetchTimeoutMs > 0
        ? options.fetchTimeoutMs
        : DEFAULT_FETCH_TIMEOUT_MS;
    this.credentials = options.credentials;
    this.signal = options.signal;
  }

  /** Resolved mirror directory (inside the validated root). */
  get path(): string {
    return this.mirrorPath;
  }

  get platform(): "github" | "forgejo" {
    return this.options.platform;
  }

  get repoFullName(): string {
    return this.options.repoFullName;
  }

  /**
   * The per-mirror mutex, shared with workspace extraction and sweep.
   *
   * NOT reentrant: awaiting `lock` from inside a `lock` callback on the
   * same mirror deadlocks forever (there is no timeout). `lock` is public
   * so the future executor can serialize its own mirror-scoped operations
   * with this module's — wrap disjoint phases, never nested phases.
   */
  lock<T>(fn: () => Promise<T>): Promise<T> {
    return withMirrorLock(this.mirrorPath, fn);
  }

  /** Ensure the bare mirror exists and is fresh: init + full fetch when
   * absent, incremental fetch when present, one corruption-triggered
   * rebuild when an existing mirror fails. Serialized per mirror. */
  async ensureMirror(): Promise<MirrorInfo> {
    const rootDir = await ensureRealDir(this.options.rootDir, "cache root");
    const mirrorPath = join(rootDir, mirrorDirName(this.options.platform, this.options.repoFullName));
    return this.lock(async () => {
      const absent = await requireAbsentOrRealDir(mirrorPath);
      if (absent) {
        await this.initMirror(mirrorPath);
        await this.fetch(mirrorPath);
        return { mirrorPath, rebuilt: false };
      }
      try {
        await this.fetch(mirrorPath);
        return { mirrorPath, rebuilt: false };
      } catch (fetchError) {
        // Cancellation is availability recovery, never corruption: a
        // cancelled or timed-out fetch must NEVER tear down a mirror that
        // active workspaces are registered against. Rebuild only when the
        // corruption probe itself proves corruption (a real fsck exit-code
        // failure) — and never when the caller already aborted.
        if (this.signal?.aborted) {
          throw fetchError;
        }
        const corrupt = await this.probeCorruption(mirrorPath);
        if (!corrupt || this.signal?.aborted) {
          throw fetchError;
        }
        await this.assertRebuildSafe(mirrorPath);
        await rm(mirrorPath, { recursive: true, force: true });
        await this.initMirror(mirrorPath);
        await this.fetch(mirrorPath);
        return { mirrorPath, rebuilt: true };
      }
    });
  }

  private async initMirror(mirrorPath: string): Promise<void> {
    await mkdir(dirname(mirrorPath), { recursive: true, mode: 0o700 });
    await runGit(this.gitBinary, {
      cwd: dirname(mirrorPath),
      args: ["-c", "gc.auto=0", "init", "--bare", "--quiet", mirrorPath],
      label: "init --bare",
      timeoutMs: this.fetchTimeoutMs,
      signal: this.signal,
      failureCode: "invalid_config",
    });
  }

  private async fetch(mirrorPath: string): Promise<void> {
    await runGit(this.gitBinary, {
      cwd: mirrorPath,
      args: [
        "-c",
        "gc.auto=0",
        "-c",
        "fetch.showForcedUpdates=false",
        "fetch",
        "--prune",
        "--no-tags",
        this.cloneUrl,
        ...fetchRefspecs(this.options.platform),
      ],
      label: "fetch",
      timeoutMs: this.fetchTimeoutMs,
      signal: this.signal,
      extraEnv: gitCredentialEnv(this.credentials, this.cloneUrl),
    });
  }

  /** Bounded corruption probe for an existing mirror. Only a git that RAN
   * and exited nonzero counts as corruption evidence: a timed-out,
   * cancelled, signalled, or unlaunchable fsck proves nothing about the
   * mirror and must never trigger a rebuild (the fetch error itself is
   * rethrown by the caller instead). Uses `runProcess` directly so the
   * outcome kind is inspectable — a `corrupt_mirror`-coded throw from
   * `runGit` would also cover signalled/cancelled/unlaunchable runs. */
  private async probeCorruption(mirrorPath: string): Promise<boolean> {
    const result = await runProcess({
      file: this.gitBinary,
      args: ["-c", "gc.auto=0", "fsck", "--connectivity-only", "--no-progress"],
      cwd: mirrorPath,
      env: gitInvocationEnv(process.env, {}),
      timeoutMs: Math.min(FSCK_TIMEOUT_MS, this.fetchTimeoutMs),
      ...(this.signal !== undefined ? { signal: this.signal } : {}),
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
      terminateGraceMs: GIT_TERMINATE_GRACE_MS,
    }).result;
    return result.status === "exited" && result.exitCode !== 0;
  }

  /** A corruption rebuild deletes and re-inits the mirror — which would
   * sever the worktree registrations and object access of every workspace
   * still extracted from it. Before the destructive step, prove there are
   * no LIVE registered worktrees: the git worktree admin directory
   * (`<mirror>/worktrees/<id>`) is checked at the filesystem level so the
   * proof does not depend on a mirror config that may itself be the
   * corruption. Any live registration, or a listing that cannot prove
   * absence, defers the rebuild and fails closed with the mirror intact —
   * a closed workspace (or a `sweepStaleWorkspaces` prune of stale
   * registrations) re-enables it, and a registration whose workspace
   * directory is already gone is provably dead (prune-equivalent) and does
   * not defer. */
  private async assertRebuildSafe(mirrorPath: string): Promise<void> {
    let registrations: string[];
    try {
      registrations = await readdir(join(mirrorPath, "worktrees"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw new AcquisitionError(
        "corrupt_mirror",
        "mirror corruption confirmed but rebuild deferred: registered worktrees cannot be ruled out; mirror left intact",
      );
    }
    for (const name of registrations) {
      if (!(await this.registrationIsProvablyDead(join(mirrorPath, "worktrees", name)))) {
        throw new AcquisitionError(
          "corrupt_mirror",
          "mirror corruption confirmed but rebuild deferred: registered worktrees present; rebuild after they close (or the sweep prunes stale ones)",
        );
      }
    }
  }

  /** A registration is provably dead when its `gitdir` file names a
   * workspace `.git` entry whose directory no longer exists — exactly what
   * `git worktree prune` would drop. Anything unreadable, malformed,
   * oversized, symlinked, or non-ENOENT is unproven and defers the rebuild
   * (fail closed). */
  private async registrationIsProvablyDead(adminDir: string): Promise<boolean> {
    const raw = await readBoundedRegularFile(join(adminDir, "gitdir"), GITDIR_MAX_BYTES);
    if (raw === null) {
      return false;
    }
    if (!raw.startsWith("/") || !raw.endsWith(".git")) {
      return false;
    }
    try {
      await lstat(dirname(raw));
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
}
