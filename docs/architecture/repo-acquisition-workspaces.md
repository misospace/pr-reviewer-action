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
| `mirror.ts` | `MirrorCache`: one bare mirror per (platform, repository), directory name = `sha256(platform\nrepo\n).git` under the cache root (controller-derived, never repo-controlled text); `ensureMirror()` = init + full fetch when absent, incremental fetch when present, one corruption-triggered rebuild — rebuild fires only on a REAL `fsck` exit-code failure, never on cancellation/timeout, so an aborted ensure can never destroy a mirror with active workspaces; per-mirror in-process mutex (`withMirrorLock`, NOT reentrant) shared with workspace extraction; fetch refspecs composed from the `platform/head-ref.ts` seam |
| `workspace.ts` | `createReviewWorkspace()`: verify the pinned head AND base are commits in the mirror (`head_not_found`/`base_not_found` fail closed), detached `git worktree add` into `<root>/workspaces/<uuid>`, merge-base vs the base with exit-code semantics (exit 1 unrelated histories → `""`; any other failure throws, never guessed), post-checkout bounded textual symlink-escape scan (fail closed); `close()`; `sweepStaleWorkspaces()` crash recovery (removals under the mirror lock; the age is a heuristic whose `maxAgeMs` must exceed the executor's review deadline) |
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
  closed.
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
  tolerated.
- **Submodules are never initialized**; `.gitmodules` stays inert data.
  **LFS is never smudged** (no git-lfs invocation; pointer files remain).
- **Repo-controlled paths cannot escape**: mirror directory names and
  workspace directory names are controller-derived (coordinate digest /
  UUID) inside 0700 controller-owned roots; repository text never becomes
  a filesystem path.
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
| Warm reviews avoid full reclone | `MirrorCache.ensureMirror` (init+full once, incremental after) | `tests-v3/acquisition-mirror.test.ts` (warm ensure, incremental advance) |
| Every run receives an isolated exact-head workspace | `createReviewWorkspace` (pinned-SHA verification, detached worktree, UUID dir) | `tests-v3/acquisition-workspace.test.ts` (extraction, fork-style pull ref, concurrency) |
| Action/service diff semantics match | `WorkspaceInfo.mergeBaseSha` via `git merge-base <base> <head>` | `tests-v3/acquisition-workspace.test.ts` (parity with raw merge-base; unrelated histories → "") |
| Credentials are ephemeral, not persisted in mirror/worktree | `git-env.ts` (`GIT_CONFIG_*` env only), no remotes, no `git config` writes | `tests-v3/acquisition-mirror.test.ts` (on-disk absence, config-list absence) |
| Cache/workspace lifecycle is bounded and tested | fetch timeout, corruption rebuild, `close()`, `sweepStaleWorkspaces` | `tests-v3/acquisition-mirror.test.ts` (timeout, rebuild), `tests-v3/acquisition-workspace.test.ts` (close idempotence, sweep) |
