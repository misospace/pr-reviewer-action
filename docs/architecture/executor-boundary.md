# Executor boundary (#733)

Design of `src/executor/`: the seam that lets the durable review-queue
controller (#731) run each review without knowing whether it executes as a
local child process, in an OCI container, or — later (#734) — as a
Kubernetes Job. Like the event/job, queue, and acquisition layers before
it, this is **a library for the future self-hosted controller daemon — it
is not wired into the running action pipeline**. Kubernetes is first-class
in the boundary's shape but contributes no Kubernetes-specific field to any
engine or scheduler contract; its executor arrives with #734 consuming the
same contract and the OCI worker-image contract defined here.

The boundary has three layers:

1. **`Executor` contract** (`types.ts`) — what a submitted execution
   receives and returns, and the required operations.
2. **`LocalExecutor`** (`local.ts`) — the development/reference backend,
   built on the v3 typed process lifecycle primitives (`src/runtime/`).
3. **Worker-image contract** (`image.ts`) — the portable OCI contract a
   container image must satisfy; stable enough for a Kubernetes
   implementation, with no PodSpec ever crossing the boundary.

## Execution submission (`ExecutionRequest`)

Every field is required with an explicit sentinel (`""`/`0`/`false`/`null`)
in the same style as `ReviewJob` and `WorkspaceInfo`. A submitted execution
receives only:

| field | meaning |
|---|---|
| `jobId` / `runId` / `attempt` | immutable job identity; `runId` is the **correlation identity** every result must echo back |
| `kind` / `platform` / `repoFullName` / `prNumber` / `headSha` / `baseSha` | the review identity, carried verbatim from the `ReviewJob` |
| `deadlineAtMs` | epoch-ms deadline; `0` = none |
| `workspace` | the `WorkspaceInfo` the #732 acquisition layer produced (isolated exact-head worktree; the executor owns its `close()`) |
| `profiles` | `executor`/`model`/`evidence` profile **names** — approved by the operator's instance config; repository config selects names only |
| `credentials` | opaque short-lived credential **references** (`ExecutionCredentialRef`); the #735 broker resolves them operator-side — no material ever crosses this boundary |
| `runDir` / `requestPath` / `resultPath` | controller-owned run directory (the executor creates it and the recovery record; the worker writes only the result file), the request-envelope file the executor serializes before launch, and the **result storage coordinate** the worker must write its structured result to |

**Stdout is never the result protocol.** The worker writes its structured
result JSON to the file at `resultPath`; captured stdout/stderr are
diagnostics only, byte-capped by the runtime primitives.

**No raw infrastructure crosses the boundary.** There is no field anywhere
in `ExecutionRequest` for a command, image, PodSpec, container args, or
host path. The executor's implementation details come exclusively from the
operator's instance-config profile (trusted operator input); repository
config can select a profile by name and nothing else, so a hostile
repository config cannot alter the executor command, its argv, or the
child environment. The request envelope is written to disk *before* launch
and is the correlation source of truth.

## Result contract (`ExecutionResult`)

An execution returns:

- `status`: `completed` / `failed` / `cancelled`;
- the echoed correlation identity (`runId` / `jobId`);
- `resultHeadSha` ("" unless completed) and `resultArtifactPath` — the
  coordinate where the structured review result lives;
- `failureCategory` from a closed union (`launch_refused`, `deadline`,
  `worker_crash`, `worker_error`, `no_result`, `stale_result`,
  `orphaned`) and `failureMessage`;
- `artifactPaths` (diagnostics/artifact references) and `resourceMs`
  (resource/telemetry metadata, `0` = unavailable).

**Result correlation is fail-closed.** A collected result whose `runId` or
`jobId` does not match the request is rejected as `stale_result` — a late
result from a superseded generation can never be mistaken for the live
one. The first terminal result wins: `collect()` after settlement is
idempotent and returns the identical frozen result, so a duplicate result
can never replace it.

**The result channel is bounded.** The result file is the untrusted
surface: the executor reads at most `MAX_EXECUTION_RESULT_FILE_BYTES`
(1 MiB) from it — no-follow open, size check and read from the SAME
descriptor — so a worker can never make the executor hold an unbounded
result. The free-text fields are capped too (`diagnostics` ≤ 8 000
characters, `failureMessage` ≤ 2 000 characters, `artifactPaths` ≤ 64
entries, `resultHeadSha` ≤ 128 characters); `validateExecutionResult`
rejects anything larger, and the worker-written file is read through that
same validator. The executor's own synthesized results respect the same
caps — a refusal message that embeds a long filesystem path is truncated
to the cap, so the executor can never produce a result its own contract
rejects.

## Required operations

| operation | contract |
|---|---|
| start | `Executor.start(request, signal)` → `ExecutionHandle`; refuses a pre-aborted signal (fail closed) |
| observe | `handle.observe()` → `ExecutionStatusReport` (`starting`/`running`/`terminal`; `""` status until terminal) — the heartbeat surface |
| cancel | `handle.cancel()` — idempotent; cancellation cannot outlive its own request scope |
| collect | `handle.collect()` → the terminal `ExecutionResult` (idempotent, first-wins) |
| reconcile | `Executor.reconcile(request)` → `ExecutionReconcileOutcome`: `none` (nothing found — start fresh), `running` (still alive — retry later), or `settled` (the terminal result; MUST NOT be rerun); called by the controller after a restart to adopt orphaned executions |

**Reconcile is generation-scoped and tri-state.** The `LocalExecutor`
records its execution state (`runId`, `jobId`, `attempt`, pid) in
`<runDir>/.pr-reviewer-execution.json`; `reconcile` refuses any recorded
execution whose correlation identity does not match the request (the
orphan belongs to another generation — it is never collected across
generations), reports `running` while the process is still alive, and
classifies a dead process without a terminal state as `orphaned` — a
`settled` failed result, because an orphan can never produce a result.

## Queue seam (`queue.ts`)

The scheduler's `JobExecutor` (`src/queue/scheduler.ts`) remains THE
controller seam; the rich `Executor` contract rides inside it through
`toQueueJobExecutor(build, executor)`: the host supplies a
`QueueRequestBuilder` (composing acquisition workspaces, effective-config
profile resolution, and credential references), the adapter forwards the
scheduler's `AbortSignal` into `executor.start`, maps the collected
`ExecutionResult` onto `ExecutionOutcome` (`resultHeadSha` only on
completed), and maps builder/collect rejections onto the failed-outcome
shape the scheduler already handles. Scheduling therefore uses one
executor interface for every backend; the engine stays unaware of
executor type entirely. Each execution receives its own cancellation
signal — the scheduler creates one `AbortController` per dispatch — so a
shared long-lived signal across executions is not a supported shape.

**The adapter does not trust the backend.** A collected result is
re-validated against the result contract and its correlation identity is
proved against the request the adapter itself built: a result that
violates the contract settles failed (`executor-error`), and a result
that belongs to another `runId`/`jobId` settles failed (`stale_result`).
The correlation invariant therefore holds for EVERY backend, not only for
the `LocalExecutor` (which enforces it internally as well) — otherwise a
foreign backend's result could reach the scheduler as a successful head.

## Local reference backend (`local.ts`)

`LocalExecutor` launches the operator-owned command from the profile's
`local` spec (`LocalExecutorSpec { command, args }`) as
`spec.command ++ spec.args ++ [requestPath]` via the runtime
`runProcess` primitive (argv only — never a shell), with `cwd` set to the
acquired workspace root, a deadline derived from `deadlineAtMs`, and a
strict child-environment allowlist: PATH/HOME/TMPDIR-class keys plus
exactly `PR_REVIEWER_EXECUTION_REQUEST` and
`PR_REVIEWER_EXECUTION_RESULT`. No request-, job-, or repository-derived
key ever enters the environment or argv. A deadline that is already past
at `start` never launches (an expired timeout must not read as "no
timeout"): the execution settles failed `deadline` immediately, with no
envelope, no state record, and no child process. The per-run state record
(`starting` with pid 0 → `running` with the real pid → terminal) is
written before the spawn and serialized through a per-run write chain,
temp-file + rename — so a crash inside the launch window leaves something
`reconcile` can classify as `orphaned`, and a terminal record can never be
overwritten by a stale in-flight write. Terminal classification maps the
`ProcessResult` (cancelled → `cancelled`; timeout → `deadline`;
`spawn_error` → `launch_refused`; non-zero exit → `worker_error`;
signalled → `worker_crash`; exit 0 without a parseable result file →
`no_result`; mismatched correlation → `stale_result`).

**Containment is proven on the filesystem, not on the string.** The
request validator only proves LEXICAL containment of the envelope paths
inside the run directory, and lexical containment does not survive a
symlink planted below that directory. Before anything is written, both
envelope paths are therefore proven against the run directory on disk:
the canonical (`realpath`) directory that would hold the file must be
the run directory or below it, and the path itself must not be a symlink,
a hard link, or a non-regular file. The missing parent components are
created INSIDE the run directory, one at a time, and a component that
already exists as a symlink is refused rather than followed — so a
nested envelope path stays usable while a redirected one never opens.
An unprovable path refuses the launch (`launch_refused`) — nothing is
written, nothing is launched, and the outside file the symlink pointed at
is never touched. The envelope is written with no-follow semantics
(`O_NOFOLLOW`), the result file is read with no-follow semantics and a
byte cap (size-checked and read from the SAME descriptor, so the bound
cannot be bypassed by swapping the file in between), and the recovery
record's temp file is created `O_EXCL`/`O_NOFOLLOW` with a random
suffix. The recovery record itself is read no-follow and byte-capped
like every other file the executor consumes — it lives in the same
worker-writable directory.

`O_NOFOLLOW` covers the FINAL path component only: an intermediate
component swapped for a symlink between the proof and the I/O is not
closed by it. The run directory is controller-owned scratch space and the
only other writer there is the worker itself, so the proof narrows that
window rather than eliminating it.

## OCI worker-image contract (`image.ts`)

`WorkerImageContract` (version 1) pins the portable surface an OCI image
must provide before any Kubernetes-specific work (#734):

- the image reference (`name[:tag][@sha256:hex]`; digest pinning is the
  operator's hardening lever, never a repository-config option);
- the fixed operator-owned argv prefix (`resolveExecutionImageCommand`);
- the two env coordinates the executor sets
  (`PR_REVIEWER_EXECUTION_REQUEST` / `PR_REVIEWER_EXECUTION_RESULT`).

Portability rules, normative for every image: the entrypoint receives the
request-envelope path as its final argv element; it MUST write the
structured result JSON to the result coordinate before exiting 0; it MUST
terminate promptly on SIGTERM (cancellation); stdout is diagnostics only;
it MUST NOT require environment beyond the two coordinates (the executor
owns the allowlist). Validation is fail-closed
(`parseWorkerImageContract`), mirroring the instance-config
`oci.image` grammar. The Kubernetes executor (#734) consumes exactly this
contract — no raw PodSpec or container args from repository config, ever.

## Instance-config extension

`ExecutorProfile` now carries a per-kind spec, the versioned schema
extension the #727 module reserved for #733/#734:

| kind | spec | rule |
|---|---|---|
| `local` | `local: { command, args }` | required; argv elements bounded, NUL-free, metacharacter-free |
| `oci` | `oci: { image }` | required; image-reference grammar |
| `kubernetes` | none | both specs refused (fail closed) until #734 defines them |

Profiles remain **names, not infrastructure**: the spec is operator-owned
configuration inside the trusted instance config; repository config still
selects only `executor-profile: <name>` through `effective-config.ts`,
unchanged.

## Correctness contract

- **Fail closed.** Unknown request/result fields are rejected; ids and
  paths are grammar-checked (`EXECUTION_ID_RE`, absolute bounded paths
  lexically inside `runDir`); a pre-aborted signal refuses to start; an
  already-past deadline refuses to launch; uncertain reconcile state is a
  failure or an explicit `running`, never a guess.
- **Containment is proven, not assumed.** The envelope paths are proven
  contained against the run directory on disk (canonical directory plus a
  no-symlink / no-hard-link check) and are opened with no-follow
  semantics; an unprovable path refuses the launch.
- **The result channel is bounded.** The result file is read through a
  byte cap (1 MiB) and the result's free-text fields and artifact list
  are capped in the validator, so no worker can make the executor hold an
  unbounded result.
- **Correlation is identity, not convention.** `runId`/`jobId` mismatches
  are `stale_result`, not warnings — at the executor AND at the
  queue-facing adapter, for every backend.
- **First terminal result wins.** Duplicate results are idempotent no-ops.
- **The environment is an allowlist.** Hostile repository-config data
  cannot reach the child's env or argv; the command comes only from the
  operator-owned profile spec.
- **Stdout is never the result protocol.**
- **No engine or scheduler infection.** `src/queue/*` and
  `src/engine/*` are untouched by the executor layer; the adapter is the
  only bridge.

## Conformance suite (`conformance.ts`)

`executorConformanceTests(factory, options)` returns pure async test
definitions (no `node:test` import) that every executor implementation —
local, OCI, future Kubernetes — must pass: the happy path with
correlation, cancellation idempotence, deadline, worker crash, missing
result, stale result, duplicate-collect idempotence, the past-deadline
refusal, and the three reconcile outcomes (`none`, `running`,
`settled`). Scenario-specific requests/executors are injected via
`ConformanceOptions`; `tests-v3/executor-conformance.test.ts` runs the
identical suite over the real `LocalExecutor` (via the fixture worker)
and over a scripted in-process fake, proving the suite is reusable by a
non-local backend.
