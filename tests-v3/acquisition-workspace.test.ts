import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../src/acquisition/git-env.js";
import { MirrorCache } from "../src/acquisition/mirror.js";
import { assertNoEscapingSymlinks, createReviewWorkspace, sweepStaleWorkspaces } from "../src/acquisition/workspace.js";
import { AcquisitionError } from "../src/acquisition/types.js";
import { initRepo, startGitHttpFixture } from "./acquisition-fixture.js";

const FIXTURE_IDENTITY = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
} as const;

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "acq-ws-"));
}

function gitIn(dir: string, args: string[], input?: string): string {
  return execFileSync("git", ["-c", "gc.auto=0", ...args], {
    cwd: dir,
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...(input !== undefined ? { input } : {}),
  }) as string;
}

interface Ready {
  fixture: Awaited<ReturnType<typeof startGitHttpFixture>>;
  root: string;
  cache: MirrorCache;
  head: string;
  close(): Promise<void>;
}

async function ready(repo: string): Promise<Ready> {
  const fixture = await startGitHttpFixture();
  const head = await initRepo(fixture, repo);
  const root = await tempRoot();
  const cache = new MirrorCache({
    rootDir: root,
    platform: "forgejo",
    repoFullName: repo,
    cloneUrl: `${fixture.baseUrl}/${repo}.git`,
  });
  await cache.ensureMirror();
  return {
    fixture,
    root,
    cache,
    head,
    close: async () => {
      await rm(root, { recursive: true, force: true });
      await fixture.close();
    },
  };
}

test("workspace: isolated exact-head extraction, normalized metadata, idempotent close", async () => {
  const env = await ready("ws/repo");
  try {
    const handle = await createReviewWorkspace(env.cache, { headSha: env.head.toUpperCase(), baseSha: env.head });
    const info = handle.info;
    assert.equal(info.headSha, env.head);
    assert.equal(info.mergeBaseSha, env.head);
    assert.equal(info.platform, "forgejo");
    assert.equal(info.repoFullName, "ws/repo");
    assert.ok((await readdir(info.rootPath)).includes("README.md"));
    assert.ok(gitIn(env.cache.path, ["worktree", "list"]).includes(info.rootPath));
    await handle.close();
    await handle.close(); // idempotent
    await assert.rejects(lstat(info.rootPath));
    assert.ok(!gitIn(env.cache.path, ["worktree", "list", "--porcelain"]).includes(info.rootPath));
  } finally {
    await env.close();
  }
});

test("workspace: the empty baseSha sentinel behaves like an omitted base (exact-head, mergeBaseSha = \"\")", async () => {
  const env = await ready("sentinel/repo");
  try {
    const handle = await createReviewWorkspace(env.cache, { headSha: env.head, baseSha: "" });
    assert.equal(handle.info.headSha, env.head);
    assert.equal(handle.info.mergeBaseSha, "");
    assert.ok((await readdir(handle.info.rootPath)).includes("README.md"));
    await handle.close();
    // Ambiguity guard: a whitespace-only value is a malformed SHA, not the sentinel.
    await assert.rejects(
      createReviewWorkspace(env.cache, { headSha: env.head, baseSha: "   " }),
      (error: unknown) => error instanceof AcquisitionError && error.code === "invalid_head",
    );
  } finally {
    await env.close();
  }
});

test("workspace: merge-base matches raw git merge-base (Action parity)", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "mb/repo");
    const base1 = await fixture.commit("mb/repo", "base.txt", "base\n", "base commit");
    // Feature branches FROM base1: seed the ref at base1 so the commit's
    // parent resolves to it.
    await fixture.updateRef("mb/repo", "refs/heads/feature", base1);
    const feature = await fixture.commit("mb/repo", "feat.txt", "feat\n", "feature commit", "refs/heads/feature");
    const mainTip = await fixture.commit("mb/repo", "main.txt", "main\n", "main advance");
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "mb/repo",
        cloneUrl: `${fixture.baseUrl}/mb/repo.git`,
      });
      await cache.ensureMirror();
      const rawMergeBase = gitIn(cache.path, ["merge-base", base1, feature]).trim();
      assert.notEqual(rawMergeBase, ""); // sanity: histories do share a base
      const ws = await createReviewWorkspace(cache, { headSha: feature, baseSha: mainTip });
      assert.equal(ws.info.mergeBaseSha, rawMergeBase);
      await ws.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("workspace: unrelated histories surface an empty merge-base, never a guess", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "orphan/repo");
    const dir = join(fixture.projectRoot, "orphan/repo.git");
    // Orphan commit: fresh tree, no parent.
    const emptyTree = gitIn(dir, ["mktree"], "").trim();
    const orphan = commitTree(dir, emptyTree, "orphan root");
    await fixture.updateRef("orphan/repo", "refs/heads/orphan", orphan);
    const mainTip = (await fixture.revParse("orphan/repo", "refs/heads/main")).trim();
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "github",
        repoFullName: "orphan/repo",
        cloneUrl: `${fixture.baseUrl}/orphan/repo.git`,
      });
      await cache.ensureMirror();
      const ws = await createReviewWorkspace(cache, { headSha: orphan, baseSha: mainTip });
      assert.equal(ws.info.mergeBaseSha, "");
      await ws.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("workspace: a base SHA the mirror never acquired fails loudly (base_not_found)", async () => {
  const env = await ready("basemissing/repo");
  try {
    const neverAcquired = "0123456789abcdef0123456789abcdef01234567";
    await assert.rejects(
      createReviewWorkspace(env.cache, { headSha: env.head, baseSha: neverAcquired }),
      (error: unknown) => error instanceof AcquisitionError && error.code === "base_not_found",
    );
  } finally {
    await env.close();
  }
});

test("workspace: head must exist in the mirror; malformed SHAs fail closed", async () => {
  const env = await ready("valid/repo");
  try {
    await assert.rejects(
      createReviewWorkspace(env.cache, { headSha: "1234567890abcdef1234567890abcdef12345678" }),
      (error: unknown) => error instanceof AcquisitionError && error.code === "head_not_found",
    );
    for (const bad of ["zzzz", "ABC DEF", "0".repeat(65), ""]) {
      await assert.rejects(
        createReviewWorkspace(env.cache, { headSha: bad }),
        (error: unknown) => error instanceof AcquisitionError && error.code === "invalid_head",
      );
    }
    await assert.rejects(
      createReviewWorkspace(env.cache, { headSha: env.head, baseSha: "not-a-sha" }),
      (error: unknown) => error instanceof AcquisitionError && error.code === "invalid_head",
    );
  } finally {
    await env.close();
  }
});

test("workspace: fork-style head from the canonical pull ref extracts cleanly", async () => {
  const env = await ready("forkbase/repo");
  try {
    // The pull ref starts at the base head so the fork-style commit's
    // parent resolves to it (exactly like a real PR forked from base).
    await env.fixture.updateRef("forkbase/repo", "refs/pull/9/head", env.head);
    const prHead = await env.fixture.commit("forkbase/repo", "fork.txt", "fork\n", "fork head", "refs/pull/9/head");
    await env.cache.ensureMirror();
    const handle = await createReviewWorkspace(env.cache, { headSha: prHead, baseSha: env.head });
    assert.equal(handle.info.headSha, prHead);
    assert.equal(handle.info.mergeBaseSha, env.head);
    await handle.close();
  } finally {
    await env.close();
  }
});

test("workspace: concurrent reviews from one mirror; a concurrent fetch does not invalidate an active workspace", async () => {
  const env = await ready("conc/repo");
  try {
    const [a, b] = await Promise.all([
      createReviewWorkspace(env.cache, { headSha: env.head }),
      createReviewWorkspace(env.cache, { headSha: env.head }),
    ]);
    assert.notEqual(a.info.rootPath, b.info.rootPath);
    const advanced = await env.fixture.commit("conc/repo", "next.txt", "next\n", "advance main");
    await env.cache.ensureMirror(); // fetch while workspaces are active
    for (const handle of [a, b]) {
      assert.ok((await readdir(handle.info.rootPath)).includes("README.md"));
      await handle.close();
    }
    const after = await env.cache.ensureMirror();
    assert.equal(gitIn(after.mirrorPath, ["rev-parse", "refs/heads/main"]).trim(), advanced);
  } finally {
    await env.close();
  }
});

function buildTreeWithSymlink(dir: string, entries: string): string {
  return gitIn(dir, ["mktree"], entries).trim();
}
function commitTree(dir: string, tree: string, message: string): string {
  return (
    execFileSync(
      "git",
      ["commit-tree", tree, "-m", message],
      {
        cwd: dir,
        env: { ...gitEnv(), ...FIXTURE_IDENTITY },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as string
  ).trim();
}

test("workspace: symlink escaping the workspace root is refused and torn down", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "evil/repo");
    const dir = join(fixture.projectRoot, "evil/repo.git");
    const readme = gitIn(dir, ["rev-parse", "HEAD:README.md"]).trim();
    const link = gitIn(dir, ["hash-object", "-w", "--stdin"], "../../../etc").trim();
    // Multi-hop: hop1 (benign-looking) points at the escaper hop2.
    const hop2 = gitIn(dir, ["hash-object", "-w", "--stdin"], "../../../etc/passwd").trim();
    const hop1 = gitIn(dir, ["hash-object", "-w", "--stdin"], "hop2").trim();
    // Absolute target outside the root.
    const absolute = gitIn(dir, ["hash-object", "-w", "--stdin"], "/etc/passwd").trim();
    const tree = buildTreeWithSymlink(
      dir,
      [
        `100644 blob ${readme}\tREADME.md`,
        `120000 blob ${link}\tescape`,
        `120000 blob ${hop2}\thop2`,
        `120000 blob ${hop1}\thop1`,
        `120000 blob ${absolute}\tabs`,
      ].join("\n") + "\n",
    );
    const commit = commitTree(dir, tree, "evil");
    await fixture.updateRef("evil/repo", "refs/heads/main", commit);
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "forgejo",
        repoFullName: "evil/repo",
        cloneUrl: `${fixture.baseUrl}/evil/repo.git`,
      });
      await cache.ensureMirror();
      await assert.rejects(
        createReviewWorkspace(cache, { headSha: commit }),
        (error: unknown) => error instanceof AcquisitionError && error.code === "workspace_refusal",
      );
      const workspaces = join(root, "workspaces");
      assert.deepEqual(await readdir(workspaces).catch(() => [] as string[]), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("workspace: hostile filenames extract without breaking the scan or becoming argv", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "names/repo");
    const dir = join(fixture.projectRoot, "names/repo.git");
    const readme = gitIn(dir, ["rev-parse", "HEAD:README.md"]).trim();
    const blob = gitIn(dir, ["hash-object", "-w", "--stdin"], "x").trim();
    // Leading-dash names (the classic argv-injection shape), spaces,
    // unicode: tree paths are data, and every consumer here is an fs API.
    const tree = buildTreeWithSymlink(
      dir,
      [
        `100644 blob ${readme}\tREADME.md`,
        `100644 blob ${blob}\t-rf`,
        `100644 blob ${blob}\t--detach`,
        `100644 blob ${blob}\ta b c`,
        `100644 blob ${blob}\tüñíçödé`,
      ].join("\n") + "\n",
    );
    const commit = commitTree(dir, tree, "hostile names");
    await fixture.updateRef("names/repo", "refs/heads/main", commit);
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "forgejo",
        repoFullName: "names/repo",
        cloneUrl: `${fixture.baseUrl}/names/repo.git`,
      });
      await cache.ensureMirror();
      const handle = await createReviewWorkspace(cache, { headSha: commit });
      const entries = await readdir(handle.info.rootPath);
      for (const wanted of ["-rf", "--detach", "a b c", "üñíçödé"]) {
        assert.ok(entries.includes(wanted), `missing hostile filename: ${wanted}`);
      }
      await handle.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("workspace: in-root symlink is tolerated", async () => {
  const fixture = await startGitHttpFixture();
  try {
    await initRepo(fixture, "insymlink/repo");
    const dir = join(fixture.projectRoot, "insymlink/repo.git");
    const readme = gitIn(dir, ["rev-parse", "HEAD:README.md"]).trim();
    const link = gitIn(dir, ["hash-object", "-w", "--stdin"], "README.md").trim();
    const tree = buildTreeWithSymlink(dir, `100644 blob ${readme}\tREADME.md\n120000 blob ${link}\tlink.md\n`);
    const commit = commitTree(dir, tree, "inroot link");
    await fixture.updateRef("insymlink/repo", "refs/heads/main", commit);
    const root = await tempRoot();
    try {
      const cache = new MirrorCache({
        rootDir: root,
        platform: "forgejo",
        repoFullName: "insymlink/repo",
        cloneUrl: `${fixture.baseUrl}/insymlink/repo.git`,
      });
      await cache.ensureMirror();
      const handle = await createReviewWorkspace(cache, { headSha: commit });
      assert.ok((await readdir(handle.info.rootPath)).includes("link.md"));
      await handle.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await fixture.close();
  }
});

test("workspace: sweepStaleWorkspaces removes crashed leftovers and keeps fresh ones", async () => {
  const env = await ready("sweep/repo");
  try {
    const stale = await createReviewWorkspace(env.cache, { headSha: env.head });
    const fresh = await createReviewWorkspace(env.cache, { headSha: env.head });
    const old = new Date(Date.now() - 3_600_000);
    await utimes(stale.info.rootPath, old, old);
    const result = await sweepStaleWorkspaces(env.cache, { maxAgeMs: 1_800_000 });
    assert.equal(result.removed, 1);
    assert.equal(result.failed, 0);
    await assert.rejects(lstat(stale.info.rootPath));
    await lstat(fresh.info.rootPath);
    // The swept workspace's registration is pruned; the live one stays.
    const porcelain = gitIn(env.cache.path, ["worktree", "list", "--porcelain"]);
    assert.ok(!porcelain.includes(stale.info.rootPath));
    assert.ok(porcelain.includes(fresh.info.rootPath));
    await fresh.close();
    const afterClose = await sweepStaleWorkspaces(env.cache, { maxAgeMs: 1_800_000 });
    assert.equal(afterClose.removed, 0);
  } finally {
    await env.close();
  }
});

test("workspace: extraction is a controller-owned UUID inside the workspaces root", async () => {
  const env = await ready("root/repo");
  try {
    const handle = await createReviewWorkspace(env.cache, { headSha: env.head });
    const parent = join(env.root, "workspaces");
    const entries = await readdir(parent);
    assert.equal(entries.length, 1);
    assert.match(entries[0] as string, /^[0-9a-f-]{36}$/);
    assert.equal(handle.info.rootPath, join(parent, entries[0] as string));
    const stat = await lstat(parent);
    assert.ok(!stat.isSymbolicLink());
    await handle.close();
  } finally {
    await env.close();
  }
});

/** The mirror must carry exactly ONE worktree registration: its own bare
 * self. Any additional entry is a leaked worktree. */
function assertOnlyMirrorWorktree(env: Ready): void {
  const registrations = gitIn(env.cache.path, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0], `worktree ${env.cache.path}`);
}

test("workspace: a symlinked workspaces root is refused and nothing is created", async () => {
  const env = await ready("rootsymlink/repo");
  try {
    const outside = join(env.root, "outside");
    await mkdir(outside, { recursive: true });
    const workspaces = join(env.root, "workspaces");
    await symlink(outside, workspaces);
    await assert.rejects(
      createReviewWorkspace(env.cache, { headSha: env.head }),
      (error: unknown) => error instanceof AcquisitionError && error.code === "workspace_refusal",
    );
    // The refusal is fail-closed: no checkout beneath the attacker-chosen
    // target, the link itself is left untouched for the operator to see,
    // and no worktree registration exists.
    assert.deepEqual(await readdir(outside), []);
    const linkInfo = await lstat(workspaces);
    assert.ok(linkInfo.isSymbolicLink());
    assertOnlyMirrorWorktree(env);
  } finally {
    await env.close();
  }
});

test("workspace: a non-directory workspaces root is refused and nothing is created", async () => {
  const env = await ready("rootfile/repo");
  try {
    // The workspaces path is created here and NEVER inspected first: the
    // refusal below is proven against a path this flow has not checked.
    await writeFile(join(env.root, "workspaces"), "not a directory");
    await assert.rejects(
      createReviewWorkspace(env.cache, { headSha: env.head }),
      (error: unknown) => error instanceof AcquisitionError && error.code === "workspace_refusal",
    );
    // The refusal left the hostile path exactly as it was: a regular
    // file, never turned into a checkout directory.
    assert.ok((await lstat(join(env.root, "workspaces"))).isFile());
    assertOnlyMirrorWorktree(env);
  } finally {
    await env.close();
  }
});

test("workspace: sweepStaleWorkspaces refuses a symlinked workspaces root", async () => {
  const env = await ready("sweeprefuse/repo");
  try {
    // A stale-looking directory OUTSIDE controller storage, behind a
    // symlinked root: a sweep that followed the link would remove it.
    const outside = join(env.root, "outside");
    const stale = join(outside, "stale-workspace");
    await mkdir(stale, { recursive: true });
    const old = new Date(Date.now() - 3_600_000);
    await utimes(stale, old, old);
    await symlink(outside, join(env.root, "workspaces"));
    await assert.rejects(
      sweepStaleWorkspaces(env.cache, { maxAgeMs: 1_800_000 }),
      (error: unknown) => error instanceof AcquisitionError && error.code === "workspace_refusal",
    );
    // Fail closed: nothing outside controller storage was removed, and
    // the link is left for the operator to see.
    assert.deepEqual(await readdir(outside), ["stale-workspace"]);
    const linkInfo = await lstat(join(env.root, "workspaces"));
    assert.ok(linkInfo.isSymbolicLink());
    assertOnlyMirrorWorktree(env);
  } finally {
    await env.close();
  }
});

test("workspace: sweepStaleWorkspaces refuses a non-directory root and never creates a missing one", async () => {
  const env = await ready("sweepfile/repo");
  try {
    const workspaces = join(env.root, "workspaces");
    // A missing root is a no-op: the sweep removes nothing and never
    // creates the root (only `mkdirWorkspacesRoot` does).
    const missing = await sweepStaleWorkspaces(env.cache, { maxAgeMs: 1_800_000 });
    assert.deepEqual(missing, { removed: 0, failed: 0 });
    await assert.rejects(
      readdir(workspaces),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    // A non-directory root is refused the same way: sweeping it would
    // remove files that are not workspaces.
    await writeFile(workspaces, "not a directory");
    await assert.rejects(
      sweepStaleWorkspaces(env.cache, { maxAgeMs: 1_800_000 }),
      (error: unknown) => error instanceof AcquisitionError && error.code === "workspace_refusal",
    );
    assertOnlyMirrorWorktree(env);
  } finally {
    await env.close();
  }
});

test("workspace: sweepStaleWorkspaces refuses an unreadable workspaces root", { skip: process.platform === "win32" ? "chmod 000 does not deny access on Windows" : process.getuid?.() === 0 ? "chmod 000 does not deny root" : false }, async () => {
  const env = await ready("sweepunreadable/repo");
  try {
    const workspaces = join(env.root, "workspaces");
    await mkdir(workspaces, { recursive: true });
    // An unreadable root is uncertain state: the sweep must refuse it,
    // never degrade into a sweep that silently removes nothing.
    await chmod(workspaces, 0o000);
    try {
      await assert.rejects(
        sweepStaleWorkspaces(env.cache, { maxAgeMs: 1_800_000 }),
        (error: unknown) =>
          error instanceof AcquisitionError &&
          error.code === "workspace_refusal" &&
          // The refusal names the errno, so the operator can tell an
          // unreadable root from a missing one.
          /\(EACCES|EPERM\)/.test(error.message),
      );
    } finally {
      // Restore access so cleanup can remove the root.
      await chmod(workspaces, 0o700);
    }
    assertOnlyMirrorWorktree(env);
  } finally {
    await env.close();
  }
});

test("workspace: sweepStaleWorkspaces refuses a workspaces root that changed during the sweep", { timeout: 30_000 }, async () => {
  const env = await ready("sweepchanged/repo");
  try {
    const workspaces = join(env.root, "workspaces");
    const stale = join(workspaces, "stale-workspace");
    await mkdir(stale, { recursive: true });
    const old = new Date(Date.now() - 3_600_000);
    await utimes(stale, old, old);

    // Rendezvous: hold the sweep between its pre-lock root check and the
    // removals, so the root can be swapped underneath it. The patched
    // lock only signals and waits; the real lock still serializes.
    type LockFn = (fn: () => Promise<unknown>) => Promise<unknown>;
    const originalLock = env.cache.lock.bind(env.cache) as unknown as LockFn;
    let reachedLock!: () => void;
    const reached = new Promise<void>((resolve) => { reachedLock = resolve; });
    let releaseLock!: () => void;
    const gate = new Promise<void>((resolve) => { releaseLock = resolve; });
    (env.cache as unknown as { lock: LockFn }).lock = async (fn) => {
      reachedLock();
      await gate;
      return originalLock(fn);
    };

    const sweep = sweepStaleWorkspaces(env.cache, { maxAgeMs: 1_800_000 });
    // The sweep has captured its pre-lock root identity by the time it
    // asks for the lock.
    await reached;

    // Swap the root for a DIFFERENT real directory. The rename keeps the
    // original inode alive, so the replacement cannot reuse it.
    const moved = join(env.root, "workspaces-moved");
    await rename(workspaces, moved);
    await mkdir(workspaces, { mode: 0o700 });
    releaseLock();

    await assert.rejects(
      sweep,
      (error: unknown) =>
        error instanceof AcquisitionError &&
        error.code === "workspace_refusal" &&
        /changed during the sweep/.test(error.message),
    );
    // Nothing was removed: the stale workspace is still where it was.
    await lstat(join(moved, "stale-workspace"));
    assertOnlyMirrorWorktree(env);
  } finally {
    await env.close();
  }
});

test("workspace: a failed base validation tears down the extracted worktree", async () => {
  const env = await ready("basefail/repo");
  try {
    const neverAcquired = "0123456789abcdef0123456789abcdef01234567";
    await assert.rejects(
      createReviewWorkspace(env.cache, { headSha: env.head, baseSha: neverAcquired }),
      (error: unknown) => error instanceof AcquisitionError && error.code === "base_not_found",
    );
    // The checkout after `worktree add` must not leak: no directory, no
    // registration.
    assert.deepEqual(await readdir(join(env.root, "workspaces")), []);
    assertOnlyMirrorWorktree(env);
  } finally {
    await env.close();
  }
});

test("workspace: an injected merge-base failure tears down the extracted worktree", async () => {
  const env = await ready("mbfail/repo");
  try {
    const shim = join(env.root, "git-shim-fail");
    await writeFile(shim, '#!/bin/sh\nif [ "$1" = "merge-base" ]; then exit 2; fi\nexec git "$@"\n', { mode: 0o755 });
    await assert.rejects(
      createReviewWorkspace(env.cache, { headSha: env.head, baseSha: env.head, gitBinary: shim }),
      (error: unknown) => error instanceof AcquisitionError && error.code === "fetch_failed",
    );
    assert.deepEqual(await readdir(join(env.root, "workspaces")), []);
    assertOnlyMirrorWorktree(env);
  } finally {
    await env.close();
  }
});

test("workspace: an injected merge-base hang cancelled by the caller tears down the worktree", async () => {
  const env = await ready("mbhang/repo");
  try {
    const shim = join(env.root, "git-shim-hang");
    await writeFile(shim, '#!/bin/sh\nif [ "$1" = "merge-base" ]; then sleep 30; fi\nexec git "$@"\n', { mode: 0o755 });
    await assert.rejects(
      createReviewWorkspace(env.cache, {
        headSha: env.head,
        baseSha: env.head,
        gitBinary: shim,
        signal: AbortSignal.timeout(2_000),
      }),
      (error: unknown) => error instanceof AcquisitionError && error.code === "fetch_failed",
    );
    assert.deepEqual(await readdir(join(env.root, "workspaces")), []);
    assertOnlyMirrorWorktree(env);
  } finally {
    await env.close();
  }
});

test("security scan: an uninspectable directory is a refusal, never a pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acq-scan-"));
  try {
    const hidden = join(dir, "a", "b");
    await mkdir(hidden, { recursive: true });
    await writeFile(join(hidden, "x.txt"), "x");
    await chmod(join(dir, "a", "b"), 0o000);
    try {
      await assert.rejects(
        assertNoEscapingSymlinks(dir),
        (error: unknown) => error instanceof AcquisitionError && error.code === "workspace_refusal",
      );
    } finally {
      await chmod(join(dir, "a", "b"), 0o755);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("security scan: a tree deeper than the scan bound is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acq-scan-"));
  try {
    let deep = dir;
    for (let i = 0; i < 70; i += 1) deep = join(deep, `d${i}`);
    await mkdir(deep, { recursive: true });
    await assert.rejects(
      assertNoEscapingSymlinks(dir),
      (error: unknown) => error instanceof AcquisitionError && error.code === "workspace_refusal",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
