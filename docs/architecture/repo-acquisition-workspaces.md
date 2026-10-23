# Repository acquisition: mirror cache and isolated per-review workspaces

Design of the #732 acquisition layer, `src/acquisition/`: the persistent
bare mirror cache and the isolated exact-head workspaces a self-hosted
controller prepares before running the review engine.

This layer is **not wired into the Action runtime** — `action.yml` is
unchanged and Action mode behaves exactly as before. It is operator-mode
(#725) infrastructure for the future executor/worker (#733): the controller
imports `src/acquisition/` (via its barrel) and owns the lifecycle.

## Module map

| module | role |
|---|---|
| `types.ts` | Frozen contracts: `AcquisitionError`/`AcquisitionFailureCode`, `FetchCredentials` (opaque, produced by `src/ingress/clone-credentials.ts`), `MirrorInfo`, `WorkspaceInfo`, `WorkspaceHandle` — all-required with sentinels, never optional |
| `git-env.ts` | Git child-environment policy: allowlisted base env with `GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`, `XDG_CONFIG_HOME` pinned to a nonexistent path, and `GIT_TERMINAL_PROMPT=0`; `safeCloneUrl` (http(s)-only, no userinfo); `toFetchCredentials` (binds the #730 `CloneCredential` to its clone URL); `gitCredentialEnv` — the credential travels ONLY as per-invocation `GIT_CONFIG_COUNT/KEY_0/VALUE_0` env, bound to its own URL, never argv, never persisted config |
| `mirror.ts` | `MirrorCache`: one bare mirror per (platform, repository), directory name = `sha256(platform\nrepo\n).git` under the cache root (controller-derived, never repo-controlled text); `ensureMirror()` = init + full fetch when absent, incremental fetch when present, one corruption-triggered rebuild — rebuild fires only on a REAL `fsck` exit-code failure, never on cancellation/timeout, so an aborted ensure can never destroy a mirror with active workspaces, and a proven-corrupt rebuild is deferred while any worktree registration exists; a non-directory (symlink/file) or uninspectable mirror path is refused instead of initialized; the cache root is trusted only after its full path chain (no symlinked or non-directory component; root private and controller-owned) is re-validated after creation; per-mirror in-process mutex (`withMirrorLock`, NOT reentrant) shared with workspace extraction; fetch refspecs composed from the `platform/head-ref.ts` seam |
| `workspace.ts` | `createReviewWorkspace()`: verify the pinned head AND base are commits in the mirror (`head_not_found`/`base_not_found` fail closed), detached `git worktree add` into `<root>/workspaces/<uuid>`, merge-base vs the base with exit-code semantics (exit 1 unrelated histories → `""`; any other failure throws, never guessed), post-checkout bounded textual symlink-escape scan (fail closed); `close()`; `sweepStaleWorkspaces()` crash recovery (removals under the mirror lock; the age is a heuristic whose `maxAgeMs` must exceed the executor's review deadline). The sweep refuses a hostile workspaces root — symlinked, not a directory, uninspectable, or changed mid-sweep (where the platform reports a non-zero root identity) — with `workspace_refusal` (never an empty sweep), treats a missing root as a no-op, and removes only entries whose `.git` gitdir pointer proves they belong to the supplied mirror (#1194 shared-root isolation; unprovable entries are left in place) |
| `platform/head-ref.ts` | `pullRequestHeadRef(platform, prNumber)` — the canonical `refs/pull/<n>/head` for both GitHub and Forgejo, so contributor branch coordinates are never trusted (a forced push to a source branch cannot move a pinned review) |

## Fetch shape

```text
persistent bare mirror / object cache (one per platform+repo)
        │ incremental bounded fetch (--prune --no-tags, refs/pull/* included)
        ▼ immutable requested commits (pinned SHA verified before use)
        ▼ isolated per-review worktree (controller-owned UUID dir)
        ▼ review engine (future #733 executor)
        ▼ cleanup (close(); sweepStaleWorkspaces for crashed workers)
```

Native git CLI worktrees were chosen over an extraction alternative: the
review engine needs git semantics (merge-base, diffs) against the pinned
head, worktree extraction is a single metadata operation (no tree copy),
and the registered worktree HEAD keeps the extracted commit's objects
protected from concurrent mirror mutation. The module never runs
gc/prune/repack and disables auto-gc on every mirror command.

## Correctness contract

- **Warm reviews avoid full reclone**: the first `ensureMirror` is init +
  full fetch; every subsequent one is an incremental `git fetch --prune
  --no-tags` of `+refs/heads/*` and `+refs/pull/*`. Tags are deliberately
  not fetched (no review path needs them; forge tags are attack surface).
- **Isolated exact-head workspace**: `createReviewWorkspace` fails closed
  unless the pinned head exists as a commit (`cat-file -e <sha>^{commit}`);
  the workspace is a detached worktree at that SHA. Fork PR heads arrive
  through the canonical `refs/pull/*` refspec — no contributor branch
  coordinates are ever fetched or trusted.
- **Action/service diff semantics match**: when a base SHA is supplied the
  workspace records `git merge-base <base> <head>` — the same
  base/merge-base input the Action's effective-diff semantics use. A
  missing merge-base (unrelated histories) is surfaced as `""`, never
  guessed.
- **Concurrent fetch/repack/prune cannot invalidate an active workspace**:
  mirror mutation and extraction are serialized under the per-mirror
  mutex, the active worktree's registered HEAD protects its objects from
  prune, and the module itself never prunes.
- **Corruption is detectable and recoverable — and never confused with
  cancellation**: a fetch failure on an existing mirror triggers a bounded
  `fsck --connectivity-only` probe; ONLY a real fsck exit-code failure
  counts as corruption (a timed-out, cancelled, or unlaunchable probe
  proves nothing and rebuilds nothing), and an already-aborted caller
  never enters the probe at all — so a cancelled/timed-out ensure can
  never tear down a mirror that active workspaces are registered against.
  A proven-corrupt mirror is deleted, re-initialized, and fully re-fetched
  exactly once (`MirrorInfo.rebuilt`), with a second failure failing
  closed — and a rebuild is DEFERRED (fail closed, mirror left intact)
  while any LIVE registered worktree exists: the git worktree admin
  directory (`<mirror>/worktrees/<id>`) is checked at the filesystem level,
  any live registration or an unprovable listing defers the rebuild, and
  the deferral is not a lockout — a closed workspace re-enables it, a
  registration whose workspace directory is already gone is provably dead
  (prune-equivalent) and does not defer, and a `sweepStaleWorkspaces` run
  prunes stale registrations when the mirror's git is still runnable.
  Proving a registration dead reads its `gitdir` file with a TOCTOU-safe
  single-descriptor read: no-follow open (a symlinked `gitdir` is refused,
  never followed), `fstat` on that descriptor for the size bound, and a
  bounded read from the SAME descriptor — nothing that cannot be read
  exactly as checked.
- **The deterministic mirror path is never initialized through**: only a
  genuinely absent path (`ENOENT`) may be initialized; an existing
  symlink, file, or any other non-directory — or a non-ENOENT lstat error
  that leaves inspectability unproven — is an `invalid_config` refusal, so
  a planted link at `sha256(platform, repo).git` cannot redirect mirror
  initialization and fetch writes outside the cache root.
- **Bounded fetch timeout**: `fetchTimeoutMs` (default 10m) is applied per
  git invocation through the shared bounded-subprocess runner
  (`src/runtime/subprocess.ts` — argv-only, tree termination, abort
  signal), entirely separate from any review deadline.

## Security boundaries

- **Credentials are ephemeral, host-bound, and never persisted**: the
  token rides only in the fetch child's `GIT_CONFIG_*` environment as an
  `http.<host>.extraheader` value, and the credential is BOUND to its
  clone URL — `MirrorCache` refuses a credential whose `cloneUrl` does not
  match the mirror's (a mismatch would send host A's token to host B) —
  never in process argv (world-readable via ps), never in a URL (userinfo
  refused at construction), never in a remote (fetches address the clone
  URL directly; no remotes are created), never in an error message (only
  the subcommand label and exit status are carried), and provably never
  on disk (`tests-v3/acquisition-mirror.test.ts` greps the whole cache
  root and asserts the argv/env canary via a recording git wrapper).
- **Global/system git config is neutralized for every invocation**
  (`GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`), so a
  tenant's `~/.gitconfig` — credential helpers, `core.hooksPath`,
  `safe.directory` overrides — can never reach a controller git
  invocation. git also ignores `safe.directory` from repo-local config by
  design, so it cannot become a cross-tenant escape.
- **Hooks are never executed**: config neutralization PLUS
  `core.hooksPath` pointed at a disabled path on worktree commands, and no
  git command in this module ever runs with cwd inside the workspace.
- **Symlinks**: post-checkout scan without following links; any symlink
  whose target resolves (textually — broken hostile `../` pointers are
  caught too) outside the workspace directory is a fail-closed
  `workspace_refusal` with the workspace torn down. In-root symlinks are
  tolerated. The scan never passes vacuously: an unreadable directory,
  unreadable symlink target, or uninspectable `DT_UNKNOWN` entry is itself
  a `workspace_refusal`, and the DFS bounds real directory depth (not
  pending-stack width). The `<cacheRoot>/workspaces` root itself is also
  fail closed: a pre-existing symlink or non-directory is refused
  (`mkdirWorkspacesRoot`), and the root is re-verified at the point of use
  inside the mirror lock, so a hostile pre-created symlink cannot redirect
  worktree checkouts outside controller storage. The crash-recovery sweep
  refuses a symlinked or non-directory workspaces root BEFORE removing
  anything, and re-verifies the root's identity (`dev`/`ino`, compared only
  where the platform reports non-zero values) inside the mirror lock
  immediately before the removals, refusing a root that changed mid-sweep.
  That guard narrows the swap window but is not atomic with the removals,
  and a platform reporting zero `dev`/`ino` cannot detect a swap at all; a
  missing root is a no-op and the sweep never creates it (only
  `mkdirWorkspacesRoot` does). The sweep is also isolated BY MIRROR
  OWNERSHIP (#1194): because every mirror under a cache root shares one
  `workspaces` sibling, an aged entry is removed only when its `.git`
  gitdir pointer names an admin directory strictly inside the supplied
  mirror's directory (textual containment, or under the mirror's
   `realpath` for symlinked ancestors); unprovable entries — missing,
   symlinked, oversized, non-`gitdir:` or NUL-bearing-first-line pointer,
   or a target
   outside the mirror — are left in place (a sweep never removes what it
   cannot prove,
  and a pointerless entry is unprovable by ANY sweep, so reclaiming those
  stays operator/maintenance work) and count as neither removed nor
  failed, so one repository's sweep can never delete another's checkout
  or leave its registration orphaned.
- **Submodules are never initialized**; `.gitmodules` stays inert data.
  **LFS is never smudged** (no git-lfs invocation; pointer files remain).
- **Repo-controlled paths cannot escape**: mirror directory names and
  workspace directory names are controller-derived (coordinate digest /
  UUID) inside 0700 controller-owned roots; repository text never becomes
  a filesystem path. The deterministic mirror path itself is fail closed:
  only a genuinely absent path may be initialized — a pre-existing
  symlink, file, or non-directory at `sha256(platform, repo).git` is an
  `invalid_config` refusal, never `git init --bare` running through it.
- **The cache root is a validated, re-validated controller-owned chain**:
  every component of the root path must be a real directory (`lstat` — no
  symlinked ancestor can silently redirect creation or use below it), and
  the root itself must be private (no group/other write) and owned by the
  process uid where ownership is inspectable. The whole chain is walked
  as the LAST gate before the root is trusted — after any creation,
  because recursive `mkdir` reports success when the leaf is already a
  symlink to an existing directory (which it then follows) and silently
  traverses symlinked ancestors — so a link planted before or during the
  creation is caught, and the refusal precedes every git invocation. (The re-check is
  a point-in-time proof: a writer with permission over an ANCESTOR of the
  root can swap directories beneath it between checks. The controller
  must place the cache root under ancestors only it owns — a documented
  deployment requirement, not an enforced invariant.)
- **Fork/network policy** stays with the controller: the clone URL comes
  from operator config (e.g. `resolveRepositoryEndpoints`), and fork jobs
  keep the #730/#725 private-data boundaries — this layer adds no network
  path beyond the one validated clone URL.

## Out of scope (follow-on issues)

Executor/worker lifecycle (#733 — the caller of this library), queue
durability (#731/#736), the credential broker (#735 — `FetchCredentials`
stays an opaque reference), GitHub App ingress (#729).

## #732 acceptance mapping

| criterion | where | tests |
|---|---|---|
| Warm reviews avoid full reclone | `MirrorCache.ensureMirror` (init+full once, incremental after) | `tests-v3/acquisition-mirror.test.ts :: ensureMirror: init + full fetch, warm ensure is incremental (no rebuild, no reclone)`; `tests-v3/acquisition-mirror.test.ts :: ensureMirror: incremental fetch picks up an advanced base branch` |
| Every run receives an isolated exact-head workspace | `createReviewWorkspace` (pinned-SHA verification, detached worktree, UUID dir) | `tests-v3/acquisition-workspace.test.ts :: workspace: isolated exact-head extraction, normalized metadata, idempotent close`; `tests-v3/acquisition-workspace.test.ts :: workspace: extraction is a controller-owned UUID inside the workspaces root`; `tests-v3/acquisition-workspace.test.ts :: workspace: fork-style head from the canonical pull ref extracts cleanly`; `tests-v3/acquisition-workspace.test.ts :: workspace: concurrent reviews from one mirror; a concurrent fetch does not invalidate an active workspace` |
| Action/service diff semantics match | `WorkspaceInfo.mergeBaseSha` via `git merge-base <base> <head>` | `tests-v3/acquisition-workspace.test.ts :: workspace: merge-base matches raw git merge-base (Action parity)`; `tests-v3/acquisition-workspace.test.ts :: workspace: unrelated histories surface an empty merge-base, never a guess` |
| Credentials are ephemeral, not persisted in mirror/worktree | `git-env.ts` (`GIT_CONFIG_*` env only), no remotes, no `git config` writes | `tests-v3/acquisition-mirror.test.ts :: ensureMirror: credentials travel only through the child env, never onto disk`; `tests-v3/acquisition-mirror.test.ts :: ensureMirror: the token reaches the child ENV only — never argv (recorder canary)`; `tests-v3/acquisition-mirror.test.ts :: ensureMirror: a credential bound to a different host is refused at construction`; `tests-v3/acquisition-head-ref.test.ts :: gitCredentialEnv: credential only in per-invocation config env, host-scoped`; `tests-v3/acquisition-head-ref.test.ts :: safeCloneUrl: http(s) only, no userinfo, hostname required` |
| Cache/workspace lifecycle is bounded and tested | fetch timeout, corruption rebuild (deferred while worktrees registered), `close()`, `sweepStaleWorkspaces` | `tests-v3/acquisition-mirror.test.ts :: ensureMirror: bounded fetch timeout is independent of any review deadline`; `tests-v3/acquisition-mirror.test.ts :: ensureMirror: a corrupted mirror is detected and rebuilt exactly once`; `tests-v3/acquisition-mirror.test.ts :: ensureMirror: a corruption rebuild is deferred while a workspace is registered against the mirror`; `tests-v3/acquisition-mirror.test.ts :: ensureMirror: a corruption rebuild proceeds once no worktree registrations remain`; `tests-v3/acquisition-mirror.test.ts :: ensureMirror: a registration with a symlinked gitdir file is unprovable and defers the rebuild`; `tests-v3/acquisition-mirror.test.ts :: ensureMirror: a registration with an oversized gitdir file defers the rebuild`; `tests-v3/acquisition-workspace.test.ts :: workspace: isolated exact-head extraction, normalized metadata, idempotent close`; `tests-v3/acquisition-workspace.test.ts :: workspace: sweepStaleWorkspaces removes crashed leftovers and keeps fresh ones`; `tests-v3/acquisition-workspace.test.ts :: workspace: sweepStaleWorkspaces refuses a symlinked workspaces root`; `tests-v3/acquisition-workspace.test.ts :: workspace: sweepStaleWorkspaces refuses a non-directory root and never creates a missing one`; `tests-v3/acquisition-workspace.test.ts :: workspace: sweepStaleWorkspaces refuses an unreadable workspaces root`; `tests-v3/acquisition-workspace.test.ts :: workspace: sweepStaleWorkspaces refuses a workspaces root that changed during the sweep`; `tests-v3/acquisition-workspace.test.ts :: workspace: sweepStaleWorkspaces is isolated by mirror ownership across a shared workspaces root`; `tests-v3/acquisition-workspace.test.ts :: workspace: sweepStaleWorkspaces leaves entries whose mirror ownership is unprovable` |
| Planted links at controller-derived paths cannot redirect writes | `requireAbsentOrRealDir` (mirror path), `ensureRealDir` + `assertTrustedDirChain` (cache root, re-validated after creation), `mkdirWorkspacesRoot` + sweep root refusal (workspaces root) | `tests-v3/acquisition-mirror.test.ts :: ensureMirror: a planted symlink at the deterministic mirror path is refused, never initialized through`; `tests-v3/acquisition-mirror.test.ts :: ensureMirror: a non-directory at the deterministic mirror path is refused`; `tests-v3/acquisition-mirror.test.ts :: ensureMirror: a cache root writable by group or other is refused`; `tests-v3/acquisition-mirror.test.ts :: ensureMirror: a cache root owned by another uid is refused`; `tests-v3/acquisition-mirror.test.ts :: ensureMirror: a cache root under a symlinked ancestor is refused, nothing initialized through the link`; `tests-v3/acquisition-mirror.test.ts :: ensureMirror: a fresh nested cache root is created private and works`; `tests-v3/acquisition-workspace.test.ts :: workspace: sweepStaleWorkspaces refuses a symlinked workspaces root`; `tests-v3/acquisition-workspace.test.ts :: workspace: extraction is a controller-owned UUID inside the workspaces root` |
