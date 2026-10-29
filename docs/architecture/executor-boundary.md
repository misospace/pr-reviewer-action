# Executor boundary (#733)

Design of `src/executor/`: the seam that lets the durable review-queue
controller (#731) run each review without knowing whether it executes as a
local child process, in an OCI container, or as a Kubernetes Job (#734).
Like the event/job, queue, and acquisition layers before it, this is **a
library for the future self-hosted controller daemon — it is not wired
into the running action pipeline**. Kubernetes is first-class as an
executor ADAPTER: it contributes no Kubernetes-specific field to any
engine or scheduler contract, and consumes the same `ExecutionRequest`
contract and the OCI worker-image contract defined here.

The boundary has three layers:

1. **`Executor` contract** (`types.ts`) — what a submitted execution
   receives and returns, and the required operations.
2. **`LocalExecutor`** (`local.ts`) — the development/reference backend,
   built on the v3 typed process lifecycle primitives (`src/runtime/`).
3. **Worker-image contract** (`image.ts`) — the portable OCI contract a
   container image must satisfy; stable enough for both container
   executors, with no PodSpec ever crossing the boundary.

Backends: `local.ts` (reference), `kubernetes.ts` (#734 — one ephemeral
Job/Pod per review execution over an injected `KubernetesApi` seam; see
[Kubernetes executor](#kubernetes-executor-734) below).

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
| cancel | `handle.cancel()` — idempotent; cancellation cannot outlive its own request scope; a termination that cannot be CONFIRMED settles failed `terminate_failed`, never `cancelled` |
| collect | `handle.collect()` → the terminal `ExecutionResult` (idempotent, first-wins) |
| reconcile | `Executor.reconcile(request)` → `ExecutionReconcileOutcome`: `none` (nothing found — start fresh), `running` (still alive — retry later), or `settled` (the terminal result; MUST NOT be rerun); called by the controller after a restart to adopt orphaned executions |
| cancel (by identity) | `Executor.cancel(request)` → `ExecutionCancelOutcome`: terminates the worker for a correlation identity WITHOUT an in-memory handle, so a controller that restarted (or adopted a worker another controller started) can still stop a superseded run. `terminated` means the termination was ACCEPTED and the worker is not running any more (a local tree termination that was confirmed, or a Kubernetes deletion the API accepted — the pods are torn down asynchronously); `failed` (`worker-not-terminated` / `material-not-removed`) means it could not be proven — the caller must keep treating the run as possibly alive |

**Reconcile is generation-scoped and tri-state.** The `LocalExecutor`
records its execution state (`runId`, `jobId`, `attempt`, pid) in
`<runDir>/.pr-reviewer-execution.json`; `reconcile` refuses any recorded
execution whose correlation identity does not match the request (the
orphan belongs to another generation — it is never collected across
generations), reports `running` while the process is still alive, and
classifies a dead process without a terminal state as `orphaned` — a
`settled` failed result, because an orphan can never produce a result.

**Cancellation is keyed by identity, not by a live handle.** `handle.cancel()`
cancels a run THIS process started; `Executor.cancel(request)` cancels by
the request's correlation identity and therefore works for a RECOVERED run
— after a controller restart the in-memory handle is gone, but the request
still names the worker. The `LocalExecutor`'s recovered path reads the same
state record (no-follow, byte-capped, correlation-checked on
`runId`/`jobId`/`attempt`) and terminates the recorded pid through the
runtime's own process-tree termination; a foreign record is never
terminated. A termination that cannot be CONFIRMED is reported `failed`
(`worker-not-terminated`), never `terminated`: the caller must keep
treating the execution as possibly alive.

**A recovered pid is signalled only while it is PROVEN to be the recorded
worker.** The recovery record lives in the worker-writable run directory,
so its pid is data, not an identity: the OS recycles pids, and the runtime
terminates a process GROUP (`kill(-pid, …)`), so a planted `pid: 1` would
reach every process the controller may signal. The record therefore carries
the worker's PROCESS IDENTITY — its process start time (Linux
`/proc/<pid>/stat` field 22) — next to the pid, and the recovered path
re-reads the live process's token and compares it. A pid of `<= 1` or the
controller's own pid is refused outright, and a record without a token (an
older one), an unreadable current token, or a mismatch all fail closed: the
cancellation reports `failed` (`worker-not-terminated`) and signals
nothing. Where the platform cannot prove a process identity at all, the
recovered cancellation fails closed rather than signalling an unproven pid.

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

`Executor.cancel(request)` is NOT carried by that adapter: the queue's
`JobExecutor` seam is start-only (it takes an `AbortSignal` and returns an
outcome), so `toQueueJobExecutor` maps the executor's start/collect
contract and nothing more — the queue seam is deliberately untouched by
#734. The correlation-keyed cancellation is reached through the `Executor`
seam itself: the controller daemon drives it directly for a run it recovered
after a restart.

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

## Kubernetes executor (#734)

`kubernetes.ts` runs one review execution as one ephemeral Job/Pod. The
Kubernetes API is an injected seam (`KubernetesApi`: `createJob` /
`getJob` / `deleteJob` / `listJobs`) — the module contains no HTTP
client and no Kubernetes library dependency; the controller daemon binds
a real client, tests bind a scripted fake, and the conformance suite runs
identically over both. The label-scoped list verb is what makes the
stale/supersession sweep and the label-first reconciliation possible, so
the executor's API identity needs `list` on Jobs on top of the
`create`/`get`/`delete` it already needed; the Secret enumeration runs
through the credential store seam, so the `list` on Secrets is the store
implementation's identity to hold (it may be a different one). The two
needs are not symmetric: a service account without `list` on Jobs can
still RECONCILE by name, but it can never LAUNCH — the sweep is
fail-closed, so an unlistable cluster refuses the launch.
- **One review, one worker.** `backoffLimit: 0` and `restartPolicy:
  Never`: a retry is a new attempt with a new correlation runId, never a
  pod restart inside the same Job.
- **Deterministic job identity.** The Job name is `prv-` + a sha256 hex
  prefix of the runId, so a duplicate controller attempt for one run id
  collides server-side (`already-exists`) and ADOPTS the existing worker
  — two controller attempts can never produce two active workers for one
  run. Jobs are reconcilable after a controller restart by the same
  name.
- **Correlation data stays hashed.** Labels carry only sha256 prefixes
  of `jobId`/`runId`; repository, PR, and head data travel exclusively
  inside the request-envelope file, which the executor writes to the
  shared run directory (containment-proven, no-follow) BEFORE creating
  the Job — the same envelope protocol as the local executor.
- **Stale/superseded workers are swept, fail-closed.** A new attempt of a
  generation must not run beside the previous attempt's worker, and a
  controller restart must be able to find the run's worker again — both
  need the cluster to be enumerable, so the seam lists Jobs by an EXACT
  label selector (every key/value pair present with that exact value).
  The sweep's scope is the GENERATION (`jobId` hashed into
  `pr-reviewer.io/job-hash`): a listed Job is stale unless its
  `pr-reviewer.io/run-hash` label equals this run's, and a MISSING
  run-hash label counts as stale too — an unprovable worker in the
  generation scope is terminated, never left running. That scope is
  narrow BY CONSTRUCTION: the generation id is a hash over the PR's
  identity fields (`deriveGenerationId` in `src/jobs/generation.ts` —
  the platform, installation, repository, PR number, adoption epoch,
  event reference, head/base SHA, config fingerprint, kind and nonce)
  — so the sweep's blast radius is one PR head under one effective
  configuration and can never reach another PR's, another
  installation's, or another product's workers. The seam's selector is RE-VERIFIED against every
  listed object before anything is deleted: only an object whose own
  labels carry every key/value of the requested selector is in scope, so
  a seam that ignores the selector cannot widen the sweep into another
  product's Job or another tenant's material. The seam's `deleteJob` MUST
  delete the Job's pods as well — Kubernetes' default background
  propagation does. The sweep does NOT touch other generations:
  PR-scope supersession ACROSS generations is the queue's job (it fires
  the generation's `AbortSignal`, and `cancelRun` deletes that exact
  Job). A failed enumeration fails the launch CLOSED — `launch_refused`
  with a fixed reason, no envelope, no Job, no material — because an
  uncertain cluster is never a guess about what is still running. A
  delete that exhausts the bounded retry budget leaves a partially swept
  generation, which fails the launch closed too.
- **Shared storage is operator-mapped, fail-closed.** The run directory
  and the acquired workspace live on PVCs the spec maps (`claim`
  mounted at `controllerRoot` on BOTH sides — the envelope serializes
  the validated request verbatim, so pod and controller must see the
  same absolute paths). A request path not covered by
  exactly one mapping (longest root wins) refuses the launch — nothing
  is created AND nothing is written: the manifest is validated before
  the first filesystem mutation, so a launch refused for uncovered paths
  leaves no run directory and no request envelope behind (the envelope
  of a worker that will never exist is not a record anyone can act on).
  A refusal that happens AFTER the envelope was written — a refused
  credential handoff, or a cancellation/deadline landing during it —
  leaves the envelope in place: it is the controller's own correlation
  record, the same artifact the local executor leaves behind when its
  worker never starts. A refusal BEFORE the write — an unprovable
  (symlinked) envelope path — writes nothing at all, like the local
  executor. The schema cannot express a hostPath or any non-PVC volume.
- **Security defaults are fixed, not configured** (reproducing the
  konflate hardening properties independently — no chart code): non-root
  uid/gid 65532 with `runAsNonRoot`; `RuntimeDefault` seccomp at pod and
  container; `allowPrivilegeEscalation: false`; read-only root
  filesystem; ALL capabilities dropped; no privileged containers;
  `automountServiceAccountToken: false` with a REQUIRED dedicated
  service-account name; resource requests AND limits required;
  deadline REQUIRED (`activeDeadlineSeconds` from the request, plus an
  executor-side timer that settles `deadline` and deletes the Job);
  `ttlSecondsAfterFinished` required (1..604800); termination grace 30s
  is the worker's engine-cancellation window.
- **Worker network posture (NetworkPolicy).** #734 lists "worker
  NetworkPolicy guidance/defaults" among the security defaults, and the
  konflate reference carries NetworkPolicy options. The executor's API
  seam is Job-scoped — it creates the Job and the per-run Secret, never
  cluster policy — so the NetworkPolicy is an OPERATOR-APPLIED namespace
  resource, exactly like the dedicated service account and the PVCs the
  spec names. The default the operator must reproduce is expressed once
  in code as `WORKER_NETWORK_POSTURE` (`src/executor/kubernetes.ts`);
  the guidance below is checked against that constant by a test, so a
  selector or destination that changes in code fails the guidance's own
  test instead of silently drifting:
  - **ingress: deny-all.** A review worker is a request/response job,
    never a server; nothing may connect to it.
  - **egress: `dns` and `model-endpoint`, and nothing else.** The
    worker reads its envelope from the shared volume and returns its
    result through the same volume, so it needs no cluster API access
    (the service-account token is not mounted) and no other outbound
    traffic. Deny egress to the cluster's service CIDR by default —
    only the model endpoint (or the operator's model proxy) is
    reachable.
  - **selector: `app.kubernetes.io/managed-by: pr-reviewer-action`.**
    A NetworkPolicy selects PODS, and Kubernetes does NOT copy a Job's
    own `metadata.labels` onto the pods it creates — so the executor
    puts the selector on the POD TEMPLATE (`podTemplateLabels`,
    `spec.template.metadata.labels`) explicitly, and on the Job and the
    per-run Secret as well. One namespace policy then covers every
    worker the executor creates; the `pr-reviewer.io/job-hash` /
    `pr-reviewer.io/run-hash` correlation labels ride along on the same
    pod template but are NOT part of the selector.
  - The worker pod joins no host network (`hostNetwork: false`), so a
    namespace policy can never be bypassed by a host-network pod.

  A minimal policy for the worker namespace:

  ```yaml
  apiVersion: networking.k8s.io/v1
  kind: NetworkPolicy
  metadata:
    name: pr-reviewer-worker-default-deny
    namespace: review-workers
  spec:
    podSelector:
      matchLabels:
        app.kubernetes.io/managed-by: pr-reviewer-action
    policyTypes: [Ingress, Egress]
    ingress: []
    egress:
      - to:
          - namespaceSelector:
              matchLabels:
                kubernetes.io/metadata.name: kube-system
        ports:
          - { protocol: UDP, port: 53 }
          - { protocol: TCP, port: 53 }
      - to:
          - ipBlock: { cidr: <model-endpoint-cidr> }
        ports:
          - { protocol: TCP, port: <model-endpoint-port> }
  ```

  Nothing about this posture is repository-configurable: the endpoint
  CIDR is cluster/operator knowledge, and the executor never accepts a
  PodSpec fragment, a policy object, or a network rule from anywhere.

- **Credentials compose with #735; they never alias it.** The durable
  request carries opaque broker REFERENCES only — a reference is never a
  Kubernetes object name (`result-channel:<runId>` is a valid reference
  that could never be one). At launch the executor performs the late,
  all-or-nothing handoff through two injected seams: a
  `WorkerCredentialResolver` (the daemon binds #735
  `resolveWorkerCredentials`; the executor re-checks the resolved set
  against the request's allowlist — exactly one non-empty entry per
  granted name — and surfaces a refusal code only when it is a member of
  the executor's CLOSED set, `WORKER_CREDENTIAL_REFUSAL_CODES` — #735's
  `ResolutionRefusalCode` values, DERIVED from the broker's own runtime
  array (`RESOLUTION_REFUSAL_CODES`) so the two cannot drift, and pinned
  against it by a drift test; anything else is echoed as `unspecified`,
  and the resolver's free-text reason is never echoed at all) and a
  `KubernetesCredentialStore` that materializes ONE
  ephemeral per-run Secret named `prv-cred-` + a sha256 hex prefix of
  the runId (create-or-replace; hashed correlation labels; the Secret
  object is serialization-guarded so even a logging store cannot dump
  material). The pod env projects `secretKeyRef` against that derived
  name with one key per credential (`PR_REVIEWER_CREDENTIAL_*`). A
  credential-carrying request without both seams wired — or a resolver
  refusal, a mismatched set, or a failed projection — is a
  `launch_refused`: nothing launches half-credentialed, and material
  never appears in the Job manifest, the envelope, labels, or
  diagnostics.
- **The store seam grew REQUIRED members.** `KubernetesCredentialStore`
  now requires `listSecrets` (the stale-material sweep enumerates the
  generation's Secrets), and the Secret it materializes carries two
  REQUIRED fields the executor supplies: `ownerJobName` (the owning Job's
  name) and `expiresAtMs` (the run's deadline — the executor's bound on
  the material's cluster-side lifetime). An existing store implementation
  therefore stops COMPILING against the new seam, and a stale binary
  fails at runtime (a missing member is a broken store, never a
  silently weaker backstop).
- **The material teardown is ATTEMPTED and REPORTED by the EXECUTOR; the
  cluster-side backstop is the STORE's obligation.** The Secret is deleted
  the moment the execution settles — success, failure, cancellation,
  orphan, or deadline — before `collect` resolves; a throw after
  projection cleans up too. The delete is retried within a bounded budget
  (three attempts, a 25 ms/50 ms ramp), and a teardown that never succeeds
  is NOT swallowed: the settled result's diagnostics record that the
  per-run credential material could not be removed (bounded text — no
  material, no credential reference, no cluster text), while the run's
  verdict is never rewritten by a cleanup failure. On the throw path the
  anomaly rides the rethrown error's message instead of vanishing into it
  (the note is appended to a bounded HEAD, so a long original error can
  never truncate it away). What the executor guarantees is the teardown
  ATTEMPT and its durable REPORTING — the removal itself is the
  store/cluster's business when the delete fails. The executor also
  sweeps the STALE material of older attempts (the same generation scope,
  the same staleness rule): a superseded attempt's Secret is removed when
  the superseding attempt starts.
  The CLUSTER-side backstop — the bound that survives this process dying
  — is NOT a property the executor can guarantee: the Secret is
  projected BEFORE the Job exists, so there is no Job to resolve a UID
  from, and a Secret owned by a non-existent owner is garbage-collected
  immediately. The store implementation therefore OBSERVES the owning Job
  itself (the executor creates it right after the projection, but the
  seam gives the store no signal of that) and binds the Secret to it WHEN
  the Job appears, resolving that Job's UID then and attaching the
  ownerReference; until that binding lands, the store's own TTL/sweeper —
  bounded by `expiresAtMs` — is the material's bound. That is a named
  SEAM obligation (like the operator-applied NetworkPolicy), not an
  executor guarantee.
- **Material is re-resolved per attempt (rotation).** Every attempt
  resolves its references FRESH and projects them with create-or-replace,
  so a rotated credential never rides an older run's Secret: the attempt's
  Secret carries exactly the material this attempt resolved. When a newer
  attempt of the same generation starts, the sweep removes the older
  attempt's Secret.
- **Cancellation and the deadline win the launch race.** Every awaited
  handoff boundary is a gate: a cancellation that lands — or a deadline
  that expires — while the stale-generation sweep is enumerating the
  cluster, while the credential resolver or the Secret projection
  is in flight settles the run as ITSELF (`cancelled`, or `failed` with
  `deadline`, never `launch_refused`) and creates NO Job; material that
  landed is deleted before the run settles, and a cancellation tears the
  run's Secret down at once instead of at settle time. A cancellation
  that lands while the Job is being created deletes that Job
  immediately, without waiting for the poll loop's first tick. The Job's
  own `activeDeadlineSeconds` is re-derived against the clock at
  creation time, so the server-side bound always matches the contract's
  remaining window.
- **Classification mirrors local**: succeeded Jobs are believed only
  through the shared result-file reader (containment proof, no-follow
  bounded read, strict validation, correlation check — a foreign
  identity is `stale_result`, a missing/unverifiable one `no_result`);
  failed Jobs map `DeadlineExceeded` → `deadline`, OOMKilled/Evicted/
  NodeLost → `worker_crash`, image pull/config errors → `launch_refused`
  (nothing ran), anything else → `worker_error`; a vanished Job is
  `orphaned` (or `cancelled` when this executor requested the
  cancellation). Cancellation deletes the exact Job, idempotently — and
  CONFIRMS the deletion: a deletion that never succeeds (within the
  bounded retry budget) leaves the worker possibly alive, so the run
  settles failed `terminate_failed` instead of claiming a `cancelled`
  verdict for a worker that may still be running. The deadline path keeps
  its `deadline` verdict (the Job's own server-side `activeDeadlineSeconds`
  bounds the worker even when the controller-side delete does not land),
  but an undeleted Job is named in the failure message, never swallowed.
- **Reconcile is tri-state and recovery-safe**: it discovers the worker by
  the run-id LABEL first (a Job carrying this run's
  `pr-reviewer.io/run-hash` IS this run's worker, even under a name the
  executor did not derive — the listed Job's own labels are re-verified
  against that selector, so a listed Job that does not carry it is never
  classified) and falls back to the derived name for a Job whose labels
  were stripped; when the LIST verb itself fails (an operator's service
  account without `list` on Jobs), the derived NAME is the authoritative
  lookup, so a listing that cannot run never degrades into reporting
  "alive" forever; several labelled workers and none under the derived
  name are an UNCERTAIN state — but not a stranded one: the run's own
  correlation-checked result file still decides (a verified completion
  settles), otherwise `running`, never an arbitrary pick;
  active → `running`;
  failed → settled failed by the mapping above; succeeded → the
  surviving result file decides (verified completion or settled
  `no_result`); Job gone → the surviving result file still settles a
  genuine completion (TTL cleanup survives a restart), otherwise `none`.
  An unreadable cluster reports `running` — never a guess, never
  start-fresh. Reconciliation is READ-ONLY: it never deletes a Job or a
  Secret.

- **A recovered worker is cancellable by identity.** Reconciliation proves
  a worker is alive; it does not stop one, and after a controller restart
  the in-memory handle that could stop it is gone. `Executor.cancel(request)`
  is the recovery-side operation (#734: "cancellation/supersession
  terminates stale workers"): it discovers the worker by its run-id LABEL
  first and by the derived name second (the name is a hash of the run id,
  so a Job under it is this run's worker even when its labels were
  stripped), re-verifies the requested selector against every listed
  object's own labels before deleting anything, and deletes the run's
  material in the same operation. A listing that cannot run degrades to
  the derived name (the same rule reconciliation follows) so a cluster
  that cannot be enumerated never hides this run's own worker. A worker
  that could not be CONFIRMED terminated is reported `failed`
  (`worker-not-terminated`), never `terminated` — the caller must keep
  treating the run as possibly alive.

## Instance-config extension

`ExecutorProfile` now carries a per-kind spec, the versioned schema
extension the #727 module reserved for #733/#734:

| kind | spec | rule |
|---|---|---|
| `local` | `local: { command, args }` | required; argv elements bounded, NUL-free, metacharacter-free |
| `oci` | `oci: { image }` | required; image-reference grammar |
| `kubernetes` | `kubernetes: { image, args, namespace, service-account, ttl-seconds-after-finished, resources, volumes }` | required; image-reference grammar, DNS-1123 names, bounded TTL, REQUIRED requests+limits, and 1..8 PVC volume mappings (`claim` mounted at `controller-root` on both sides) — the ONLY shared-storage surface; there is no field for a PodSpec fragment, hostPath, nodeSelector, toleration, or any raw Kubernetes object |

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
- **A termination is confirmed, never assumed.** A cancelled verdict
  describes a worker that is gone. When the executor cannot prove the
  worker was terminated, the run settles failed `terminate_failed` and the
  cancellation reports `failed` — never `terminated`. A verdict that
  describes a worker that may still be running is a lie the queue would
  act on.
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
refusal, the three reconcile outcomes (`none`, `running`, `settled`), and
the RECOVERED cancellation (a run whose controller restarted — the handle
is gone — is terminated by its correlation identity alone; the suite
supplies the restarted controller through the `restartedExecutorFor`
injection hook, because an executor that keeps handles in memory must
hand over a fresh instance). Scenario-specific requests/executors are
injected via `ConformanceOptions`;
`tests-v3/executor-conformance.test.ts` runs the
identical suite over the real `LocalExecutor` (via the fixture worker)
and over a scripted in-process fake, proving the suite is reusable by a
non-local backend; `tests-v3/executor-kubernetes.test.ts` runs the same
suite over the `KubernetesExecutor` (scripted fake API + fake worker
writing the real result file) and pins the manifest security contract.
