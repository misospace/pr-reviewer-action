# Self-hosted deployment: OCI images and the Helm chart

This is the operator runbook for installing `pr-reviewer-action` on your own
Kubernetes cluster. It covers the two container images, the Helm chart, the
external PostgreSQL control plane, the forge credentials, and upgrades.

The runtime behind these artifacts is the #1348 controller daemon
([`docs/architecture/controller-daemon.md`](architecture/controller-daemon.md)).
It is forge-agnostic: every forge read and write travels through the bound
platform capability (`src/platform/`, `src/ingress/`). Nothing in the
controller or worker images shells out to a forge CLI. The chart is generic:
it assumes nothing about your GitOps tooling, your registry, or your domain.

## The two images

`deploy/images/Dockerfile` builds both images from one multi-stage file:

| target   | runs                                                              |
|----------|-------------------------------------------------------------------|
| `worker` | `node /app/dist/index.js worker <envelope-path>` — one review per invocation, driven by the #733 worker-image contract (`src/executor/image.ts`) |
| `controller` | `node /app/dist/index.js controller` — the long-lived daemon: intake, queue, executor bindings, publication, admin API |

Build and push:

```bash
docker build -f deploy/images/Dockerfile --target controller -t <registry>/pr-reviewer-controller:<tag> .
docker build -f deploy/images/Dockerfile --target worker    -t <registry>/pr-reviewer-worker:<tag>    .
```

Image properties:

- Both images run as uid 1000 (non-root) and carry only the bundled
  `dist/index.js` bundle plus `git`. `pg` is compiled into the bundle, so
  neither image ships `node_modules`.
- The worker honors the worker-image contract: the envelope path is its last
  argv element, it writes the structured result to the envelope's
  `resultPath` (which the executor also names in
  `PR_REVIEWER_EXECUTION_RESULT`), and it exits promptly on SIGTERM.
- Worker image and controller protocol are coordinated by the same commit:
  both targets are built from one tree. The chart pins the controller image;
  the worker image is pinned in the instance config's `kubernetes` executor
  profile (the example values pin both to the same tag). When you upgrade
  one, upgrade both.

For release publishing, pin the base image digests as described in
`deploy/images/README.md`, then push digest-pinned references.

## The chart

`deploy/charts/pr-reviewer/` is built on the bjw-s-labs `common` library
chart (pinned in `Chart.yaml`; CI runs `helm dependency build`, lint, and
template rendering on every change to `deploy/**`). Custom templates exist
only for what the common library cannot express: worker RBAC, the
NetworkPolicy, the ServiceMonitor, and the env wiring that maps values onto
the controller's fail-closed environment contract.

Install (controller-only mode):

```bash
helm dependency build deploy/charts/pr-reviewer
helm install pr-reviewer deploy/charts/pr-reviewer \
  -n pr-reviewer --create-namespace \
  -f deploy/charts/pr-reviewer/examples/values-controller-only.yaml
```

Kubernetes-executor mode (the controller creates one Job per review, with a
dedicated worker ServiceAccount and namespace-scoped verbs — never
cluster-admin):

```bash
helm install pr-reviewer deploy/charts/pr-reviewer \
  -n pr-reviewer --create-namespace \
  -f deploy/charts/pr-reviewer/examples/values-kubernetes-executor.yaml
```

The executor Role grants two things, both namespace-scoped in the worker
namespace: `create/get/list/delete` on `batch/jobs`, and
`create/get/list/update/patch/delete` on core `secrets` — the per-run
credential Secrets the credential store projects, rebinds to the owning
Job, label-sweeps, and deletes at settle. The material is ephemeral
(one Secret per run, removed when the run settles); its shape is guarded
cluster-side by `deploy/admission/worker-secret-policy.yaml`, not by the
Role.

Full values reference, including all secret fields, lives in the chart's own
`README.md` and `values.schema.json`. Ready-to-copy secret manifests
(GitHub App credentials, Forgejo tokens, admin and webhook secrets, model
credential material) are in `deploy/charts/pr-reviewer/examples/README.md`.

## Security defaults

The chart's defaults reproduce the hardening properties the issue asks for:

- non-root (uid/gid 1000), `seccompProfile: RuntimeDefault`;
- ALL capabilities dropped, `allowPrivilegeEscalation: false`;
- read-only root filesystem — the controller's writable roots
  (`PR_REVIEWER_DURABLE_STATE_DIR`, `PR_REVIEWER_RUNS_ROOT`,
  `PR_REVIEWER_WORKSPACE_CACHE_ROOT`) are volumes;
- service-account token automount off unless a feature needs it (the worker
  ServiceAccount never automounts a token; the controller's is mounted only
  in Kubernetes-executor mode);
- optional NetworkPolicy (default ON): deny-by-default ingress, egress
  limited to DNS, the forge API, the model endpoints, and PostgreSQL;
- separate webhook and admin listeners, never one shared surface;
- a JSON Schema that validates values (`helm lint` enforces it).

External secret handling is the operator's choice: every secret can come
from an `existingSecret`, so External Secrets, Sealed Secrets, or your vault
controller all work.

## The control plane: external PostgreSQL

The chart never deploys its own database. The controller needs one PostgreSQL
DSN in `PR_REVIEWER_CONTROL_PLANE_URL` (via `controlPlaneUrl` or
`controlPlaneUrlExistingSecret`). See `examples/values-external-postgres.yaml`.

Migrations are explicit and safe: the controller runs the #736 control-plane
migrations at startup and refuses to accept work until they have succeeded
(fail closed — no partial policy, no work on an unmigrated store). Operators
should keep two coupled settings in mind:

- the generation-claim horizon (default 7 days) must never be shorter than
  the queue-compaction retention — see the coupled-pair rule in
  [`docs/architecture/durable-control-plane-state.md`](architecture/durable-control-plane-state.md);
- a durable claim left behind is released, not sticky: a failed enqueue
  re-mints on the next delivery.

## Forge credentials

One controller instance serves exactly one forge platform (`webhook.platform`
selects the GitHub App intake or the native Forgejo intake; the daemon
refuses to start when its reconcile poll and intake disagree).

- **GitHub App**: set `forgeAuth.platform: github` with the App ID and the
  private key (mounted from a secret). The install token lifecycle, webhook
  signature verification (`X-Hub-Signature-256`), and publication
  idempotency follow
  [`docs/architecture/self-hosted-github-app-ingress.md`](architecture/self-hosted-github-app-ingress.md).
- **Forgejo**: set `forgeAuth.platform: forgejo` with the token from
  `forgeAuth.forgejo.existingSecret` (`FORGEJO_TOKEN`). The webhook trust
  boundary and ledger dedupe follow
  [`docs/architecture/self-hosted-forgejo-ingress.md`](architecture/self-hosted-forgejo-ingress.md).

Model credentials reach workers only as opaque references (#735). The chart
injects their material as `PR_REVIEWER_CREDENTIAL_<REF>` environment entries
from Secrets; the DSN, tokens, and keys never appear in argv, URLs, or logs.
Those values are a **controller-startup snapshot**: Kubernetes does not update
a running process's environment when the backing Secret changes. After rotating
a model credential, roll/restart the controller before expecting new reviews to
use the new material. Hot Secret watching is not part of this deployment
contract.

## Metrics and health

The #737 admin listener serves `/healthz`, `/readyz`, and `/metrics` with
bounded-cardinality metrics on its own port (default 8081). Those three
endpoints are intentionally unauthenticated (no review content, no
credentials — bounded counters only); the `/admin/*` API and the MCP mount
are guarded by a required bearer token. The chart sets
`PR_REVIEWER_ADMIN_BIND=0.0.0.0` when
the admin surface is enabled so kubelet probes and Prometheus can reach it;
the token and the NetworkPolicy remain the guards. Set
`serviceMonitor.enabled: true` (requires the admin surface) for the
ServiceMonitor resource; `admin.enabled: false` keeps the listener
loopback-only and off the network.

## Upgrades

1. Read the release notes for the new version; check for control-plane
   migration notes.
2. Upgrade the controller first, one instance per forge platform
   (`helm upgrade`). Startup migrations run before any work is accepted;
   a failed migration refuses startup rather than degrading.
3. Restart recovery reconciles durable state before it requeues, so an
   in-flight review at upgrade time is never recomputed: a live worker is
   adopted, a settled worker publishes without a rerun.
4. Update the worker image in the same upgrade: the executor runs the image
   the instance config names, and worker/controller versions must stay
   coordinated.

Rollback follows the usual Helm path (`helm rollback`). Because migrations
are forward-only, roll back the application only when the previous version
accepts the migrated schema; check the release notes before rolling back
across a schema change.

## What CI checks

`.github/workflows/charts.yaml` runs on every change under `deploy/`: it
builds chart dependencies, lints the chart, renders both example modes,
asserts the rendered security defaults, and validates every rendered
manifest with kubeconform. `tests-v3/deploy-packaging.test.ts` locks the
packaging contract itself (pinned dependency, worker argv, non-privileged
defaults, env names that cannot drift from `src/controller/main.ts`).

## Known limits

- The end-to-end fresh-cluster install qualification is issue #739; this
  chart is CI-render-validated but not yet cluster-tested.
- The admin API's write surface is intentionally refused in this
  composition (bounded reason, no silent partial access); read-only
  operations, health, and metrics are served.
- The execution envelope carries the forge platform and its API base
  URL (`ExecutionRequest.forgeApiUrl`, mapped to `forgejoApiUrl` in
  `worker-main.ts`, #1433). It does not carry model configuration. The
  worker maps the engine inputs as `inputs: {}`, so the required
  `ai-base-url` and `ai-model` values have no route to the engine
  (#1496). Until #1496 lands, worker execution cannot complete a model
  review on either platform. A worker-driven review fails closed as
  `worker_error`.
