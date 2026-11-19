# pr-reviewer Helm chart

Self-hosted deployment of the pr-reviewer controller daemon (#1348) and
its Kubernetes worker-executor provisioning (#734/#738), built on the
bjw-s `common` library chart (pinned to `5.3.0` in `Chart.yaml`).

Scope and posture:

- **The chart never deploys PostgreSQL.** `controller.controlPlaneUrl`
  (or `controller.controlPlaneUrlExistingSecret`) points at an
  operator-provided database.
- **One forge platform per controller instance** (GitHub App or Forgejo
  token — see `examples/README.md` for the Secret manifests).
- **Fail-closed wiring.** Every env var the chart sets maps onto the
  controller's environment contract in `src/controller/main.ts`; a
  drift test (`tests-v3/deploy-packaging.test.ts`) keeps the chart from
  naming variables the entrypoint does not read. Incomplete wiring fails
  at `helm template` time, not at pod CrashLoop time.
- **`dist/` is not committed** (repo rule): images are built by CI /
  `deploy/images/Dockerfile`; the controller and worker images are
  self-contained bundles (no `node_modules`).

## Dependency management

`Chart.lock` and vendored `charts/` are intentionally not committed —
the repository `.gitignore` excludes them and CI runs
`helm dependency build` (see `.github/workflows/charts.yaml`). They must
NOT be listed in `.helmignore`: Helm 4 applies that file when *reading*
the chart directory, so ignoring the built dependency hides the bjw-s
common library templates at render time. Run
`helm dependency build deploy/charts/pr-reviewer` locally before
`helm template`/`install`.

## Release version synchronization

The chart's `version`, the chart's `appVersion`, and the controller/worker
image tags in `examples/*.yaml` track the application release in
`.release-please-manifest.json`. Each version field carries an
`x-release-please-version` annotation and its file is listed under
`packages["."].extra-files` in `release-please-config.json`, so the standing
release PR bumps all of them together. `tests-v3/deploy-packaging.test.ts`
fails when a bound field and the manifest disagree, so a release PR cannot
land with stale deployment artifacts.

Since #1708 the chart's own `version` equals the application release
version too (no more independent `0.1.0`): Helm OCI artifacts are tagged
by `Chart.yaml.version`, so publishing application releases while the
chart stayed at one constant version would collide with the
already-published artifact. One release, one coordinate everywhere:
release tag `vX.Y.Z`, `Chart.yaml.version` `X.Y.Z`, `Chart.yaml.appVersion`
`X.Y.Z`, OCI chart tag `X.Y.Z`, and the `#1704` image tags `X.Y.Z`. If
independent chart releases are ever needed, that is a deliberate separate
versioning/release design, not implicit drift.

## Published OCI artifact (#1708)

The chart is published to GHCR as an OCI artifact by
`.github/workflows/publish-chart.yaml` from the trusted release lifecycle
(the GitHub Release event, plus a manual dispatch with an explicit release
tag as the recovery path):

```sh
helm install pr-reviewer \
  oci://ghcr.io/misospace/charts/pr-reviewer \
  --version 3.9.1 \
  -f values.yaml
```

- The chart version to install is the application release version — the
  same `X.Y.Z` as the `#1704` controller/worker image release tags of that
  release.
- The published chart resolves its pinned bjw-s `common` dependency
  (`helm dependency build` runs in the publish job), so installation needs
  no source checkout. Installing from `deploy/charts/pr-reviewer/` in a
  checkout remains the development path, not the normal release path.
- Digest-pinned image overrides work exactly as before (`image.digest` /
  the instance-config `kubernetes.image` reference) and remain the exact
  immutable production pin when desired; the chart does not weaken them.
- The publish job refuses to replace an already-published chart version
  (GHCR does not enforce tag immutability) and never mutates `Chart.yaml`
  to make a mismatched release pass. There is no `latest` chart alias.
- Package visibility/read permissions follow the self-hosted runtime
  images (`deploy/images/README.md`): a newly created GHCR package starts
  private — set it public or attach a pull secret.

## Values structure

- `controller` — the daemon: chart-owned wiring keys
  (`instanceConfig`, `controlPlaneUrl`, `webhook`, `admin`,
  `reconcile`, `forgeAuth`, `credentials`, `followUp`, `paths`, `env`)
  PLUS the bjw-s common passthrough sections (`controllers`, `service`,
  `persistence`, `secrets`, `serviceAccount`, `defaultPodOptions`, …)
  rendered for the controller component. The common library reads its
  API keys from the component's section (the chart re-roots the render
  values), so operator-side overrides work exactly like app-template.
- `workerExecutor` — provisions the objects AROUND the worker Jobs
  (`mode: kubernetes`): dedicated worker ServiceAccount
  (token never mounted), namespace-scoped Role/RoleBinding granting the
  CONTROLLER's service account `create/get/list/delete` on `batch/jobs`
  plus `create/get/list/update/patch/delete` on core `secrets` in the
  worker namespace (pods are never touched directly — the Job
  controller's background propagation removes them), and shared PVCs
  mounted at identical absolute paths in controller and workers. The
  secrets verbs exist for the per-run credential Secrets the executor
  projects: it creates/replaces them, rebinds each to the owning Job,
  label-lists its own material, and deletes them at settle; they are
  per-run and ephemeral, and `deploy/admission/worker-secret-policy.yaml`
  is the cluster-side guardrail on their shape.
  The Job manifests themselves are built by the executor from the
  instance config's `kubernetes` profile.
- `networkPolicy` (default **OFF**) — opt-in default-deny policies for controller
  and worker pods; configure only after verifying cluster-specific API, model,
  webhook and admin paths. When disabled the chart renders no NetworkPolicies; the worker selector matches the executor's
  `app.kubernetes.io/managed-by: pr-reviewer-action` pod label
  (WORKER_NETWORK_POSTURE in `src/executor/kubernetes.ts`).
- `serviceMonitor` (default OFF) — the admin listener serves `/metrics`;
  the chart binds it to the pod-wide wildcard when the admin surface is
  enabled, so a Prometheus scrape works out of the box (still guarded by
  the admin bearer token; opt-in NetworkPolicies may additionally restrict ingress). Requires
  `controller.admin.enabled`.

## PR discovery (polling-first)

The chart defaults to polling **trusted, explicitly listed** repositories every
**15 minutes** (`controller.reconcile.enabled: true`,
`controller.reconcile.intervalMs: 900000`). Set
`controller.reconcile.repos: [owner/repo]` to activate it. With no targets,
the chart starts no poll and does not scan the App's other repositories.
For GitHub, also set `controller.reconcile.githubInstallationId` to the
installation authorized to read those repositories. Forgejo/Gitea reuse their
configured forge credential. A nonempty repo list without the required GitHub
installation ID refuses to render, rather than silently skipping reviews.

Webhooks (`controller.webhook.enabled`) are **optional** for low-latency
delivery; the scheduled sweep discovers missed/new PR heads independently.
Both paths share generation identity and durable deduplication. To tune the
interval, set `controller.reconcile.intervalMs` in milliseconds; to stop the
sweep, set `controller.reconcile.enabled: false`.

**Initial rollout:** the sweep lists all currently open PRs, not only ones
created after installation. Review the target repository's existing backlog
and configured concurrency/model costs before first enabling the poll.

## Security defaults

- `runAsNonRoot`, uid/gid 1000, `fsGroup` 65532, seccomp
  `RuntimeDefault`, all capabilities dropped, no privilege escalation,
  read-only root filesystem (writable roots are PVCs; `/tmp` is an
  emptyDir). `fsGroup` is the worker executor's pinned group
  (`WORKER_RUN_AS_ID`, uid/gid 65532): setgid propagation on the shared
  claims is what lets the controller read the worker's result file and
  the worker read the controller's envelope across the uid boundary
  (#1631).
- **Shared-claim volume-root contract (#1725): `2750`, owner uid 1000,
  group 65532.** When `workerExecutor.mode: kubernetes` provisions shared
  claims, kubelet applies `fsGroup` to each freshly provisioned root as
  group-writable (`0775`, uid 0) — and the runtime's own acquisition
  check refuses any cache root that is group/other-writable or not owned
  by the controller uid (`assertTrustedDirChain` in
  `src/acquisition/mirror.ts`), so every job would fail before dispatch.
  The chart therefore ships a `fix-roots` init container (rendered only
  in Kubernetes-executor mode): it runs as root with only `CHOWN`/`FOWNER`
  added, `chown`s the runs and workspace-cache claim roots to the
  controller uid plus the shared group, and `chmod`s them to `2750`.
  `fix-roots` is the only root container in the pod: it runs as uid 0
  with `runAsNonRoot: false`, so a namespace enforcing the Pod Security
  `restricted` profile rejects the controller pod in
  Kubernetes-executor mode. Use `baseline` for that namespace (every
  other container in the pod already satisfies `restricted`), or keep
  the Kubernetes executor off. The root shape stays minimal: all
  capabilities dropped except `CHOWN`/`FOWNER`, no privilege
  escalation, read-only root filesystem, `RuntimeDefault` seccomp.
  `2750` keeps the shared group's read/execute (which the #1631 exchange
  needs) while stripping the group write the check refuses, and keeps the
  setgid bit that fsGroup provisioning itself carries: the runtime
  chmods the components below the claim root but never chgroups them, so
  without the setgid bit each run directory would inherit the
  controller's primary group (1000) instead of 65532 and the worker
  would be refused traversal one level below the root.
  The fix is durable because **no other workload mounts these claims with
  `fsGroup`** — not because `OnRootMismatch` skips it (#1736): kubelet's
  `OnRootMismatch` skips only when the root GID matches AND the root mode
  is a superset of `0770` *with* setgid (`requiresPermissionChange`,
  Kubernetes `pkg/volume/volume_linux.go`), so a trusted non-group-writable
  `2750` root always re-triggers a full recursive restyle (chgrp to that
  pod's fsGroup plus group-writable bits) for any pod that mounts with
  `fsGroup`. The executor's worker Jobs therefore carry no `fsGroup`
  (#1736, rejected by the shipped worker admission policy); the only
  remaining fsGroup mount is the controller pod itself, whose kubelet
  processing runs at pod startup *before* `fix-roots` repairs the root
  again ahead of the controller process. Any other workload mounting these
  claims must likewise carry no `fsGroup`. Operators
  mounting pre-existing claims must ensure the same root shape — uid
  1000, group 65532, mode `2750` (no group/other write, setgid set) — or
  the controller refuses to start exactly as above. Verify a running
  install from inside the controller pod with
  `stat -c '%a %u %g' /var/lib/pr-reviewer/runs /var/lib/pr-reviewer/cache`,
  expecting `2750 1000 65532` for each. `fix-roots` reaches the roots
  through the `persistence` `globalMounts` (the common library renders
  them for init containers as well), so relocating `controller.paths.*`
  requires updating the matching `globalMounts` paths in sync. Custom
  init containers added under `controller.controllers.main.initContainers`
  must use the common-library map shape keyed by container name; in
  Kubernetes-executor mode the chart's `fix-roots` merge preserves them
  next to its own container and refuses a raw Kubernetes container list.
- The controller's service-account token is mounted ONLY when
  `workerExecutor.mode: kubernetes` (the executor talks to the cluster
  API); otherwise `automountServiceAccountToken: false`.
- Worker pods never mount any token. If enabled explicitly, the chart's worker
  NetworkPolicy denies all ingress and limits egress to DNS + TLS; operators
  must then allow their configured model endpoint and other required paths.
  Without opt-in, pod egress follows the cluster's existing policies.
- Secret material always travels through `secretKeyRef` or secret
  mounts; inline values (`webhook.secret`, `admin.token`,
  `credentials.<ref>.value`) exist only for throwaway environments and
  are rendered into chart-managed Secrets.
- Model credentials are read from their Secret-backed environment variables
  at controller startup. Rotating a backing Secret therefore requires a
  controller rollout/restart; the chart does not claim live Secret watching.

## Admin/metrics reachability

The controller's admin listener defaults to loopback
(`PR_REVIEWER_ADMIN_BIND`, a closed literal-address allowlist in
`src/controller/main.ts`). Whenever `controller.admin.enabled` is set,
this chart binds it to the pod-wide wildcard (`0.0.0.0`) so kubelet HTTP
probes (`/healthz`, `/readyz`) and Prometheus scrapes (`/metrics`) work.
The surface stays guarded: health and metrics are content-free, the
`/admin/*` API requires the bearer token (refused at startup without
one). An explicitly enabled NetworkPolicy can further restrict ingress;
without it, use cluster networking and ingress controls.

The #742 operations dashboard (`GET /dashboard` on the admin listener)
stays off by default: `controller.admin.dashboard: false` leaves
`PR_REVIEWER_ADMIN_DASHBOARD` unset, and `true` renders
`PR_REVIEWER_ADMIN_DASHBOARD=true`. The knob requires
`controller.admin.enabled` (the render fails otherwise, because the flag
means nothing without the listener). The shell holds no data and needs
no token; every value it shows comes from the bearer-protected
`/admin/*` API. See `docs/architecture/operations-dashboard.md`.
