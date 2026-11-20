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

### Published GHCR images (#1704)

The dedicated workflow `.github/workflows/publish-images.yaml` builds
both targets from one checked-out commit and pushes them to GHCR for every
publishable revision:

| image | reference |
|-------|-----------|
| controller | `ghcr.io/misospace/pr-reviewer-controller:sha-<commit>` |
| worker | `ghcr.io/misospace/pr-reviewer-worker:sha-<commit>` |

The immutable `sha-<commit>` ref exists for every run; two more ref classes
are published from the same source commit:

- **Pull requests (same-repo).** A moving `pr-<number>` ref for both
  images (`...:pr-<number>`), so the self-hosted qualification path can
  consume the current PR's images without a manual dispatch. The PR ref
  may move as commits are pushed; each underlying commit stays addressable
  by its immutable `sha-<head-commit>` ref.
- **Release tags.** A `vX.Y.Z` tag publishes the exact SemVer ref
  (`X.Y.Z`) only for both images from that exact tagged commit. Only
  exact `vX.Y.Z` tag pushes trigger the workflow at all: the floating git
  major tag (`v3`), which the release pipeline moves on every stable
  release, matches no trigger filter and never starts an image-publication
  run (#1742). No floating alias is published: a cluster pulls an image
  tag directly, so every image tag must resolve to one immutable build.
  The immutable `sha-<commit>` ref and digest remain the provenance anchor
  behind the alias. No `latest` tag is published. No floating alias
  exists on the chart surface today either: the chart publishes exact
  SemVer OCI tags only, because Helm rejects non-SemVer OCI tags, so an
  operator who tracks a release line consumes the exact chart version the
  same release publishes
  (`oci://ghcr.io/misospace/charts/pr-reviewer:X.Y.Z`), never a moving
  image tag.

How it runs:

- **Triggers.** Pull requests targeting `main`, pushes to `main`, pushes of
  exact `vX.Y.Z` release tags (the floating `vX` major tag never starts a
  run, #1742), and manual `workflow_dispatch` (recovery/testing,
  from Actions → Publish images).
- **Fork boundary.** A fork pull request builds and validates both targets
  locally but receives no GHCR credentials (`contents: read` only) and
  publishes nothing. Only same-repo PRs, `main` pushes, release tags, and
  manual dispatches reach the publish job.
- **Provenance.** The run summary reports each image's digest and a
  copy-paste-ready `image@sha256:...` reference plus the exact source
  commit and the trigger. No `latest` anywhere.
- **Tag immutability.** GHCR has no registry-side immutable-tag setting,
  so the job enforces it before building: it resolves each `sha-<commit>`
  tag's state and never re-pushes one that already exists. A rerun RESUMES a
  half-published pair — it reuses a target whose tag is present (keeping its
  digest) and publishes only the missing target. The build steps push nothing
  but the immutable sha ref; EVERY moving ref (`pr-<number>` and the exact
  SemVer release alias, #1742: no floating alias of any shape), for reused
  and freshly built targets alike, is written by one guarded step that
  points it at the sha manifest without a rebuild — so a rerun also recovers
  aliases an earlier run failed to push, and no write can precede the guard.
  That step first confirms through the forge API that this run is still the
  live coordinate behind the refs: a rerun of a superseded run fails closed
  instead of moving a moving ref backward. If either registry
  answer is uncertain, the run stops instead of pushing (fail closed). A rerun
  can therefore never move a published tag. The `pr-<number>` ref is the only
  intentionally moving ref.
- **Permissions.** The publish job runs with `contents: read` and
  `packages: write` and logs into GHCR with `GITHUB_TOKEN`. Image building
  is fully separate from the Action release pipeline (which owns
  tag/release writes).
- **Visibility prerequisite.** A newly created GHCR package starts private.
  Either set the package to public or create a registry pull secret with
  read access and attach it where the chart pulls (controller namespace and
  worker ServiceAccount) — see `deploy/images/README.md`.

Pin the digests at the two consumption points (never a mutable tag):

1. **Helm controller image** — `controller.controllers.main.containers.main.image`
   in your chart values. The `common` library chart accepts a `digest`
   field next to `repository` and `tag` and renders
   `repository[:tag]@digest`, so set `image.digest` to the value from the
   run summary; do not put the digest into `repository`.
2. **Worker image** — the instance config's `kubernetes.image` field in the
   Kubernetes executor profile. That field is one full reference string,
   so include the digest in it:
   `ghcr.io/misospace/pr-reviewer-worker@sha256:<digest>`.

The example values under `deploy/charts/pr-reviewer/examples/` show the
shape; replace their placeholders with the digest references from the run
summary. When you upgrade, upgrade both pins together: worker and
controller protocol revisions are coordinated by building both images from
the same commit.

## The chart

`deploy/charts/pr-reviewer/` is built on the bjw-s-labs `common` library
chart (pinned in `Chart.yaml`; CI runs `helm dependency build`, lint, and
template rendering on every change to `deploy/**`). Custom templates exist
only for what the common library cannot express: worker RBAC, the
NetworkPolicy, the ServiceMonitor, and the env wiring that maps values onto
the controller's fail-closed environment contract.

### Published chart OCI artifact (#1708)

Every release publishes the chart to GHCR as an OCI artifact
(`.github/workflows/publish-chart.yaml`), so a self-hosted installation
consumes a stable coordinate instead of a source checkout:

```sh
helm install pr-reviewer \
  oci://ghcr.io/misospace/charts/pr-reviewer \
  --version 3.9.1 \
  -n pr-reviewer --create-namespace \
  -f values-controller-only.yaml
```

Upgrade follows the same shape — pin the version of the release you are
upgrading to:

```sh
helm upgrade pr-reviewer \
  oci://ghcr.io/misospace/charts/pr-reviewer \
  --version 3.9.1 \
  -n pr-reviewer \
  -f values-controller-only.yaml
```

How the chart artifact relates to the release:

- **One release coordinate everywhere.** The chart version equals the
  application release version: release tag `vX.Y.Z` publishes
  `oci://ghcr.io/misospace/charts/pr-reviewer:X.Y.Z` alongside
  `ghcr.io/misospace/pr-reviewer-controller:X.Y.Z` and
  `pr-reviewer-worker:X.Y.Z` from the same release. There is no `latest`
  chart alias and no ad-hoc version rewrite; the publish job refuses to
  replace an already-published chart version.
- **Fail-closed coordinates.** The publish job runs only for a GitHub
  Release (plus an explicit-tag manual dispatch recovery path) and fails
  closed unless the tag is `vX.Y.Z` SemVer, `Chart.yaml.version` and
  `appVersion` equal `X.Y.Z`, and `.release-please-manifest.json` equals
  `X.Y.Z`. release-please bumps all of them together in the release PR
  (`x-release-please-version` annotations); `Chart.yaml` is never mutated
  during publishing.
- **Auth prerequisite.** The same GHCR visibility/read-permission policy as
  the runtime images applies: a newly created `charts/pr-reviewer` package
  starts private — either make it public or attach a registry pull secret
  (see `deploy/images/README.md`).
- **Digest overrides unchanged.** The chart still supports digest-pinned
  image overrides (`controller.controllers.main.containers.main.image.digest`
  and the instance-config `kubernetes.image` reference) — those remain the
  exact immutable production pin when desired.
- **Source checkout stays a development path.** Installing from
  `deploy/charts/pr-reviewer/` in a repository checkout (below) is for
  development and CI validation; the released OCI coordinate is the normal
  install path. The packaged chart resolves its pinned bjw-s `common`
  dependency inside the publish job, so no client-side
  `helm dependency build` is needed.

Source-checkout install (controller-only mode, development path):

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
- optional NetworkPolicy (**default OFF**): no chart-managed traffic restrictions
  unless explicitly enabled; when enabled it denies ingress by default and
  limits egress to specified ports, requiring cluster-specific exceptions
  for the Kubernetes API, model endpoint and admin/dashboard path.
  Workers call the model endpoint themselves, so a non-TLS in-cluster
  endpoint needs the worker-only `networkPolicy.workerAdditionalEgress`
  exception in addition to any controller `additionalEgress` (#1709);
  each extension applies to exactly one of the two policies;
- separate webhook and admin listeners, never one shared surface;
- a JSON Schema that validates values (`helm lint` enforces it).

### Kubernetes API egress for Kubernetes-executor mode (#1714)

When `networkPolicy.enabled` is on and `workerExecutor.mode` is
`kubernetes`, the controller needs egress to the Kubernetes API: it creates
and polls the per-review worker Jobs (`src/executor/kubernetes.ts`) and
manages the per-run credential Secrets (`src/executor/kubernetes-credential-store.ts`,
including the lifetime sweep). The chart's base egress rules — DNS, TCP
443, and PostgreSQL 5432 — do **not** cover this on every cluster.

Why: the API server's `kubernetes` Service is a ClusterIP on port 443, but
the real API server listens on node port 6443 and runs with
`hostNetwork: true`. How egress policy sees the connection depends on the
CNI data plane:

- **Classic kube-proxy (iptables/IPVS):** the pod's connection to the
  ClusterIP is policy-evaluated **before** DNAT, so the generic TCP 443
  egress rule already allows it. No exception needed.
- **Cilium with `kube-proxy-replacement=true`:** the connection is
  redirected at socket level to the API server backend
  (`<nodeIP>:6443`), and egress policy is evaluated against that
  redirected destination. The 443 rule never matches and the connection
  is silently dropped. Verified live in the #725 pilot on Talos + Cilium
  (kube-proxy-replacement strict): from the controller pod,
  `<ClusterIP>:443` timed out while a real API server endpoint
  `<nodeIP>:6443` was dropped by policy, even though RBAC passed.

The symptom is silent: Job creation and the credential sweep fail with
"the API call did not complete" (status `null`), not a permission error —
`kubectl auth can-i` succeeds because only the network path is missing.

Fix: add an `additionalEgress` rule for the API server on TCP 6443. Node
addresses are cluster-specific, so the chart ships no default. The
verified pilot snippet (controller policy is the only one that needs the
API — worker pods never mount a token and never call it):

```yaml
networkPolicy:
  enabled: true
  additionalEgress:
    - to:
        - ipBlock:
            cidr: 10.69.1.20/29 # your control-plane/node subnet
      ports:
        - protocol: TCP
          port: 6443
```

Operators on Cilium can instead express the same allowance with a
CiliumNetworkPolicy using `toEntities: [kube-apiserver]`, which resolves
the API server endpoints automatically; the chart's stock NetworkPolicy
cannot do that, so the ipBlock exception above is the portable form.

The Kubernetes worker executor pins worker pods to uid/gid 65532, so the
controller deployment must share group 65532 with the worker pin (the
chart sets `fsGroup: 65532`; operators running the controller outside the
chart must apply an equivalent group) — the shared claims' exchanged
envelope/result files are group-readable `0640` (#1631). Two further
obligations: roll worker images together with the controller (an old
worker image refuses the new envelope's `sharedGroupId` field as
unknown), and mount the shared claims on storage whose driver honors
`fsGroupPolicy: File` (standard PVC CSI drivers do; hostPath and
`None`-policy drivers get no group application and the exchange fails
closed).

Kubelet applies `fsGroup` to a freshly provisioned claim with a
group-WRITABLE root (`0775`, uid 0); a claim mounted without `fsGroup`
keeps uid 0 at mode `0755`. Either way the runtime's own cache-root trust
check refuses the root — "cache root is writable by group or other", or
"not owned by the controller uid" — before dispatch (#1725, #1737). The
chart therefore renders a `fix-roots` init container in every executor
mode: it fixes the runs and workspace-cache claim roots before the
controller starts, always to owner uid 1000 and group 65532, with a mode
chosen by who writes below the root:
- `workerExecutor.mode: kubernetes` → `2750`. The shared group keeps the
  read/execute the #1631 exchange needs, and the setgid bit keeps group
  inheritance for everything the runtime creates below the root (it
  chmods those components but never chgroups them).
- Controller-only → `0750`, no setgid. The local executor spawns the
  worker as the controller's own uid and never changes group ownership
  below these roots, so no cross-uid writer needs group inheritance; the
  owner bits carry the whole write surface.

The fix is durable because no workload mounts these claims with `fsGroup`
except the controller pod itself (#1736): kubelet's `OnRootMismatch` skips
only when the root mode is a superset of `0770` *with* setgid, so a
trusted root always re-triggers a full recursive restyle for an `fsGroup`
mount — which is why the executor's worker Jobs carry no `fsGroup` (the
shipped worker admission policy rejects one), and why any other workload
mounting these claims must not either. The controller pod's own kubelet
processing runs before `fix-roots`, so the repair repeats deterministically
at every controller start, ahead of the controller process. `fix-roots`
runs as root with only `CHOWN`/`FOWNER`, so a namespace enforcing Pod
Security `restricted` rejects the controller pod in every mode; use
`baseline` (the constraint is also stated in the chart README). Verify the
sequence on a live install: run one executor job, launch a second one (a
fresh worker pod mounting the same claims in Kubernetes-executor mode),
then re-run
`stat -c '%a %u %g' /var/lib/pr-reviewer/runs /var/lib/pr-reviewer/cache`
inside the controller pod — the roots must still read `2750 1000 65532`
(Kubernetes executor) or `0750 1000 65532` (controller-only), and the
follow-up job must not fail "cache root is writable by group or other".
No repository test can simulate kubelet's fsGroup restyle, so this
sequence is operator-side verification: run it once on a live install,
and again after any executor or storage-driver change. Operators mounting
pre-existing claims must provide the matching root shape themselves; the
contract is documented in the chart README.

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

One controller instance serves exactly one forge platform. The instance
config's `forges[].kind` selects the GitHub App intake or the native
Gitea-header intake. The daemon refuses to start when its reconcile poll
and intake disagree.

- **GitHub App**: set `forgeAuth.platform: github` with the App ID and the
  private key (mounted from a secret). The install token lifecycle, webhook
  signature verification (`X-Hub-Signature-256`), and publication
  idempotency follow
  [`docs/architecture/self-hosted-github-app-ingress.md`](architecture/self-hosted-github-app-ingress.md).
- **Forgejo / Gitea**: set `forgeAuth.platform: forgejo` with the token from
  `forgeAuth.forgejo.existingSecret` (`FORGEJO_TOKEN`). A Gitea instance
  declares `forges[].kind: gitea` in the instance config (#1682) and uses
  that same token and the same native intake. The identity changes the
  capability composition and the diagnostics, but not the wire protocol.
  Point the forge webhook at the canonical route that the controller
  reports in its startup summary: `/webhooks/gitea` for a Gitea instance,
  `/webhooks/forgejo` for a Forgejo instance. The webhook trust boundary and
  ledger dedupe follow
  [`docs/architecture/self-hosted-forgejo-ingress.md`](architecture/self-hosted-forgejo-ingress.md).

Model credentials reach workers only as opaque references (#735). The chart
injects their material as `PR_REVIEWER_CREDENTIAL_<REF>` environment entries
from Secrets; the DSN, tokens, and keys never appear in argv, URLs, or logs.
Those values are a **controller-startup snapshot**: Kubernetes does not update
a running process's environment when the backing Secret changes. After rotating
a model credential, roll/restart the controller before expecting new reviews to
use the new material. Hot Secret watching is not part of this deployment
contract.

## Polling-first PR discovery

When `controller.reconcile.repos` is configured, the self-hosted chart
runs an open-PR reconciliation sweep every **15 minutes** by default
(`controller.reconcile.intervalMs: 900000`). GitHub needs the explicit
`controller.reconcile.githubInstallationId`; forge credentials and
repository targets are operator-owned. If no repo list is supplied, no
poll runs; there is no implicit App-wide repository discovery. An explicit
`controller.reconcile.enabled: false` disables polling. The runtime also
accepts `PR_REVIEWER_RECONCILE_REPOS` with an omitted
`PR_REVIEWER_RECONCILE_INTERVAL_MS` and uses the same 15-minute default.

The sweep runs through the daemon's own reconciliation composition, so a
polled pull request gets the same review-job identity a webhook would
give it. Each pass writes to the controller log when it has something to
say: one summary line when it scheduled work, found open pull requests it
had already scheduled, hit a failed repository, or had a job refused, plus
one line per refused job with the reason the daemon gave. A pass that
listed its repositories and found no open pull request at all stays quiet.

Webhooks can stay **disabled** and review discovery still works; when
enabled, they provide faster hints but converge with polling through the
same generation ledger. The sweep fetches **all currently open PRs** per
configured repository on each pass, bounded by the adapter's paging
limits; installation startup is not automatically a new-PR-only backfill.
Be mindful of outstanding PR volume and configured review concurrency,
especially when a new installation begins polling.

## Metrics and health

The #737 admin listener serves `/healthz`, `/readyz`, and `/metrics` with
bounded-cardinality metrics on its own port (default 8081). Those three
endpoints are intentionally unauthenticated (no review content, no
credentials — bounded counters only); the `/admin/*` API and the MCP mount
are guarded by a required bearer token. The chart sets
`PR_REVIEWER_ADMIN_BIND=0.0.0.0` when
the admin surface is enabled so kubelet probes and Prometheus can reach it;
the bearer token remains mandatory for privileged admin endpoints;
chart-managed NetworkPolicies are opt-in and must not be assumed present. Set
`serviceMonitor.enabled: true` (requires the admin surface) for the
ServiceMonitor resource; `admin.enabled: false` keeps the listener
loopback-only and off the network. The #742 operations dashboard
(`GET /dashboard`) is served only when `PR_REVIEWER_ADMIN_DASHBOARD` is
ON; the chart exposes it as `controller.admin.dashboard` (default
`false`, which leaves the flag unset; `true` requires the admin surface)
— see `docs/architecture/operations-dashboard.md`.

The chart's values define a single Service (`controller.service.webhook`, the
POST-only intake on 8080); the admin listener on 8081 has no Service of its
own. That is why turning on the dashboard alone does not make it reachable:
exposing the admin surface is the operator's ingress decision, and because
the shell carries no data it is served unauthenticated, so network access
control is the remaining guard on who can reach it (all admin data stays
bearer-protected). Reach it with the bjw-s `common` `service` and `route`
passthrough — add an `admin` port to a controller Service and route the
dashboard/admin paths to it. The chart README ("Reaching the dashboard from
outside the pod") carries the full Gateway values. Two contract notes hold
wherever you route it:

- `/admin` and `/dashboard` must reach the same origin (the admin port). The
  dashboard script fetches `/admin/*` from the listener that served the shell
  (its CSP `connect-src 'self'` forbids any other origin), so splitting them
  across hostnames breaks every data request.
- Never expose `/dashboard*` or `/admin*` as the forge intake path. The GitHub
  intake ignores the request path, and the Forgejo/Gitea intake mounts its
  fixed canonical route (`/webhooks/forgejo` / `/webhooks/gitea`, above), so
  point the intake at a dedicated path that is neither prefix. A path-split
  route with no catch-all rule also keeps `/metrics` and `/healthz` off the
  public route.

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

The `self-hosted-qualification` job of
`.github/workflows/self-hosted-qualification.yaml` runs the self-hosted
qualification harness. The job runs on a manual dispatch only. It never
gates a merge. The harness script landed with #1482. A dispatched job
runs it and reports its pass/fail, and the job still fails closed when
the script is absent, so a green run never means a qualification that
did not run. Its run steps are in
[Self-hosted qualification](self-hosted-qualification.md).

The `self-hosted-qualification-parity` job of
`.github/workflows/self-hosted-qualification-parity.yaml` runs the
engine-parity family of the same harness. Its model calls reach a
harness-owned stub model server and its forge is the disposable instance
the harness starts, so the job holds no secret. An operator can
therefore dispatch it against any ref, a branch that carries an open pull
request included. It never gates a merge either.

The `.github/workflows/publish-images.yaml` workflow builds and pushes
the controller and worker images to GHCR for PRs, `main` commits, release
tags, and manual dispatches
([Published GHCR images](#published-ghcr-images-1704) above); it also never
gates a merge. The `.github/workflows/publish-chart.yaml` workflow publishes
the Helm chart OCI artifact for release publications (and validates, lints
and packages the chart on pull requests without publish credentials —
[Published chart OCI artifact](#published-chart-oci-artifact-1708) above);
it also never gates a merge.

## Known limits

- The end-to-end fresh-cluster install qualification has not run yet. The
  harness script landed with #1482 and the CI job executes it on demand
  and reports its pass/fail; the run steps are in
  [Self-hosted qualification](self-hosted-qualification.md). The scenario
  families land one at a time, so no fresh-cluster qualification has run.
  This chart is CI-render-validated but not yet cluster-tested.
- The admin API's write surface is intentionally refused in this
  composition (bounded reason, no silent partial access); read-only
  operations, health, and metrics are served.
- The execution envelope carries the forge platform and its API base
  URL (`ExecutionRequest.forgeApiUrl`, mapped to `forgejoApiUrl` in
  `worker-main.ts`, #1433), and the operator's model selection
  (`ExecutionRequest.modelSelection`: the AI base URL, the wire model id,
  and the wire format, mapped to `ai-base-url` / `ai-model` /
  `ai-api-format` engine inputs, #1496). The model credential never rides
  the envelope: it stays the #735 `model` reference, whose projected
  material the worker reads into `ai-api-key`. A model profile must name
  a `model` id; selecting a profile without one refuses the review at
  composition, never a model-less worker launch.
