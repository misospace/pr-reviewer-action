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

The chart's `version` and `appVersion` track the application release in
`.release-please-manifest.json`. Both version fields carry an
`x-release-please-version` annotation and the file is listed under
`packages["."].extra-files` in `release-please-config.json`, so the standing
release PR bumps both together. `tests-v3/deploy-packaging.test.ts`
fails when a bound field and the manifest disagree, so a release PR cannot
land with stale deployment artifacts. Since #1762 the image tags in
`examples/*.yaml` are NOT part of this set: the examples restate no
controller image, and both controller and worker image tags derive from
`Chart.appVersion` at render time, so there is nothing for a release PR to
bump there.

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
- The chart's controller image defaults to the upstream published
  `ghcr.io/misospace/pr-reviewer-controller` and follows `Chart.appVersion`
  (#1762): an upstream install needs no
  `controller.controllers.main.containers.main.image` value at all. Set
  `repository` for a mirror/private registry, `tag` for an alternate tag,
  or `...image.digest` for an immutable byte pin.
- The chart's worker image defaults to the upstream published image and
  follows `Chart.appVersion`; set `workerExecutor.image.digest` for an
  immutable byte pin. An instance-config `kubernetes.image` is an explicit
  profile override.
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
  `route`, `persistence`, `secrets`, `serviceAccount`,
  `defaultPodOptions`, …) rendered for the controller component. The
  common library reads its API keys from the component's section (the
  chart re-roots the render values), so operator-side overrides work
  exactly like app-template.
- `workerExecutor` — provisions the objects AROUND the worker Jobs
  (`mode: kubernetes`): dedicated worker ServiceAccount
  (token never mounted), namespace-scoped Role/RoleBinding granting the
  CONTROLLER's service account `create/get/list/delete` on `batch/jobs`
  plus `create/get/list/update/patch/delete` on core `secrets` in the
  worker namespace (pods are never touched directly — the Job
  controller's background propagation removes them). The chart declares
  the standard shared storage once, in `controller.persistence.runs` and
  `controller.persistence.workspace-cache`, and derives the PVC names and
  the worker-side volume mappings from those entries (see "Shared storage"
  below). Add only non-standard claims to `workerExecutor.volumeClaims`.
  Set `workerExecutor.namespace` to the release namespace because PVCs are
  namespace-scoped. The
  secrets verbs exist for the per-run credential Secrets the executor
  projects: it creates/replaces them, rebinds each to the owning Job,
  label-lists its own material, and deletes them at settle; they are
  per-run and ephemeral, and `deploy/admission/worker-secret-policy.yaml`
  is the cluster-side guardrail on their shape.
  The Job manifests are built from per-profile Kubernetes facts plus
  chart-owned image/resources/TTL deployment defaults. Profiles may override
  those defaults; omitted values inherit. The default worker image follows
  `Chart.appVersion`, with an optional chart-level digest pin.
- `networkPolicy` (default **OFF**) — opt-in default-deny policies for controller
  and worker pods; configure only after verifying cluster-specific API, model,
  webhook and admin paths. When disabled the chart renders no NetworkPolicies; the worker selector matches the executor's
  `app.kubernetes.io/managed-by: pr-reviewer-action` pod label
  (WORKER_NETWORK_POSTURE in `src/executor/kubernetes.ts`).
  Workers call the configured model endpoint themselves, so a plain-HTTP
  (non-TLS) in-cluster endpoint such as `http://litellm.llm:4000/v1`
  needs `networkPolicy.workerAdditionalEgress` (#1709): a rule list
  appended only to the worker policy's egress, e.g. TCP 4000 scoped to
  the LiteLLM namespace/pod labels. It never opens controller egress,
  and `additionalEgress` stays controller-only and never opens worker
  egress. Configuring it without a rendered worker policy (policy off or
  `workerExecutor.mode: disabled`) refuses the render instead of
  silently dropping the exception.
- `serviceMonitor` (default OFF) — the admin listener serves `/metrics`;
  the chart binds it to the pod-wide wildcard when the admin surface is
  enabled, so a Prometheus scrape works out of the box (still guarded by
  the admin bearer token; opt-in NetworkPolicies may additionally restrict ingress). Requires
  `controller.admin.enabled`.

## Shared storage (single source, #1767)

The standard shared worker/controller storage is declared once, in
`controller.persistence.runs` and `controller.persistence.workspace-cache`.
The chart derives everything else from those two entries:

- The controller mounts each claim at the root `controller.paths` names
  (`runsRoot`, `workspaceCacheRoot`). The chart derives the standard
  `globalMounts` from those paths, so a relocation changes one value on
  the chart side. In Kubernetes mode the chart passes the derived mappings
  to the controller; a profile without explicit `volumes` inherits them
  automatically. Declared volumes remain an advanced override.
- Each claim is either operator-provided (`existingClaim: <name>`) or
  chart-created. A chart-created claim renders under the name the common
  library's own rules derive for its persistence entry — an operator-set
  `forceRename` wins outright (literal names only: the derived resolution
  does not evaluate templates, and a template string in `forceRename`,
  `prefix`, or `suffix` refuses the render — use `existingClaim` for a
  template-resolved name); otherwise `prefix` is prepended, the
  identifier is appended whenever more than one chart-created PVC renders
  (`<chart-fullname>-<key>`; the standard topology's `runs`,
  `workspace-cache`, and `durable-state` together), a lone chart-created
  claim renders as the bare `<chart-fullname>`, `suffix` is appended, and
  `global.alwaysAppendIdentifierToResourceName` forces the identifier.
  The chart reproduces those rules itself (and pins the result with
  `forceRename`) because the pre-#1767 chart let the library name its
  claims from the same rules: an upgrade that keeps the storage topology
  keeps every claim name exactly. The `<chart-fullname>` in claim names
  follows the library's fullname chain — `global.fullnameOverride` /
  `global.nameOverride`, then the component overrides, then the release
  and chart names — which is what an override install's claims were
  already named from. The chart's other objects (Secrets, RBAC) keep
  naming from the chart's own mirror, which ignores the global
  overrides.
- The template `pr-reviewer.shared-volume-mappings` exposes the derived
  `{claim, controllerRoot}` pairs and passes them to the controller in
  Kubernetes mode. A standard worker profile may omit `volumes`; the
  controller injects these mappings automatically (this needs a controller
  image from the same release as the chart — see "Release version
  synchronization" above). Explicitly declared
  volumes remain supported as the advanced posture and REPLACE the
  inherited set whole (never a merge): a profile that declares `volumes`
  must re-declare every mapping its requests need. A declared derived
  claim must mount at its derived `controller.paths` root or the render
  refuses.
  Profiles other than the one `default-executor-profile` names
  keep raw advanced mappings supported unchecked; a declared default is
  trusted only when it names a kubernetes profile — otherwise the check
  falls back to every kubernetes profile, and without a declared default
  every profile is checked. The chart cannot know which profile a
  repository config selects at run time, so a profile the default does
  not name is the operator's responsibility. The
  claim NAME half stays operator-owned — a stale name after a release-name
  change or an `existingClaim` rename cannot be distinguished from a
  mapping on a non-standard claim (volumeClaims-provisioned or
  operator-managed), which stays supported — so re-check the names when
  either changes. An instance config provided through an existing Secret
  cannot be checked at render time, so keep both halves in sync yourself.
- `fix-roots` keeps reading `controller.paths.*`, unchanged (#1725/#1737).

Once the chart derives a standard claim itself, the topology requires
the worker namespace to equal the release namespace, because PVCs are
namespace-scoped and the chart derives the claims once. A
`workerExecutor.namespace` that names another namespace then refuses the
render, and so does an inline instance config whose
`kubernetes.namespace` differs from the release namespace (the instance
config is authoritative for the worker Jobs). An instance config
provided through an existing Secret cannot be checked at render time, so
make sure that namespace matches the release namespace yourself. The
all-`existingClaim` posture is the opt-out: when every standard claim is
operator-provided, no namespace guard fires, because the operator
provisions identical claims in every namespace the topology names (the
pre-#1767 dedicated-worker-namespace shape keeps rendering). With the
opt-out the chart also skips the cross-check between
`workerExecutor.namespace` and the instance config's profile namespace —
the provisioning objects and the Jobs then land wherever the operator
points them, and a mismatch surfaces at review time, not render time.

`workerExecutor.volumeClaims` is for additional, non-standard claims only.
A name that redeclares a chart-created standard or durable-state claim
refuses the render. One legacy shape stays valid: when a standard entry
uses `existingClaim`, a `volumeClaims` entry of the same name is the
claim's provisioner (the pre-#1767 documented posture). Raw, advanced
instance-config volume mappings stay supported: the chart never merges
derived mappings into operator config, and mappings on non-standard
claims are not validated against the derived storage.

### Upgrading from the pre-#1767 shape

Installs of the old documented example carried `existingClaim` entries in
`controller.persistence` and the same claim names in
`workerExecutor.volumeClaims`. That shape still renders unchanged —
including a dedicated worker namespace, which the namespace guards do
not touch while every standard claim stays operator-provided — so the
cheapest upgrade path is to keep it. To adopt the single-source shape:

1. Set the standard sizes under `controller.persistence` (at least the
   current claim sizes; Kubernetes refuses to shrink a claim). With the
   old example's 20Gi claims, use `runs.size: 20Gi` and
   `workspace-cache.size: 20Gi`, which keeps the existing
   `pr-reviewer-runs` PVC.
2. Remove the matching `workerExecutor.volumeClaims` entries.
3. Update the instance config's workspace mapping to the new claim name:
   `pr-reviewer-workspace` becomes `pr-reviewer-workspace-cache`. The
   workspace cache is expendable, so the renamed claim starts empty.
4. Pin the durable-state claim to the name it already has — the move from
   one to three chart-created PVCs changes the count-derived resolution —
   and keep that pin for as long as the release runs (removing it later
   would rename the claim back):

   ```yaml
   controller:
     persistence:
       durable-state:
         forceRename: pr-reviewer # the bare fullname the old posture rendered
   ```
5. Install into the namespace the instance config names (`-n pr-reviewer`
   in the examples).

From that point on the chart derives the claims and enforces the
namespace contract: `workerExecutor.namespace` and the inline instance
config's `kubernetes.namespace` must equal the release namespace, and
the render refuses otherwise.

The durable-state claim carries `retain: true`, so the PVC the chart
renders survives uninstalls and, for installs first rendered by this
chart, any later storage-topology change that would rename it. Its name
resolves with the same count rule the pre-#1767 chart named claims from
(see the naming bullet above), so an upgrade that does not change the
storage topology keeps the exact claim the install already has:

- Documented example posture — every standard claim operator-provided,
  durable-state the only chart-created PVC: it rendered as the bare
  `<fullname>` and keeps rendering that way, now with the keep annotation
  the old chart never set.
- Chart-created shared claims — the old defaults enabled durable-state,
  runs, and workspace-cache together, so durable-state rendered as
  `<fullname>-durable-state` and keeps that name.

Upgrading from the old documented example to the chart-created shared
shape IS a topology change (the standard claims stop being
operator-provided, so the chart-created count moves from one to three and
the durable-state resolution follows it). The example's `runs` claim
survives that move because the names coincide
(`pr-reviewer-runs`), but the durable-state claim does not — without
help, the adopting upgrade would rename it and Helm would delete the old
claim with the audit ledger and queue snapshot under
`controller.paths.durableStateDir`. Keep it with one explicit value in
the adopted values (permanently — removing it later would rename the
claim back):

```yaml
controller:
  persistence:
    durable-state:
      forceRename: pr-reviewer # the bare fullname the old posture rendered
```

Claim names also follow the library's fullname chain, so an old install
renamed through `global.fullnameOverride`, `global.nameOverride`, or the
component `fullnameOverride`/`nameOverride` keeps its claim names across
the upgrade — the resolution reads the same overrides the old library
naming read. The chart's other objects (Secrets, RBAC) have always
ignored the global overrides and keep doing so, which does not affect
storage.

## PR discovery (polling-first)

The chart defaults to polling **trusted, explicitly listed** repositories every
**15 minutes** (`controller.reconcile.enabled: true`,
`controller.reconcile.intervalMs: 900000`). Set
`controller.reconcile.repos: [owner/repo]` to activate it. With no targets,
the chart starts no poll and does not scan the App's other repositories.
For GitHub, also set `controller.reconcile.githubInstallationId` to the
installation authorized to read those repositories. It is also the identity
the GitHub webhook intake falls back to when a delivery omits
`installation.id` (#1723), so it is emitted whenever configured — even with
the sweep disabled — and a delivery the intake cannot assign to any
installation is refused rather than minting a job that cannot authenticate.
Forgejo/Gitea reuse their configured forge credential. A nonempty repo list
without the required GitHub installation ID refuses to render, rather than
silently skipping reviews.

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
- **Claim volume-root contract (#1725/#1737): `fix-roots` repairs the
  runs and workspace-cache claim roots in every executor mode — `2750
  1000 65532` under `workerExecutor.mode: kubernetes`, `0750 1000 65532`
  in controller-only mode.** Kubelet applies `fsGroup` to a freshly
  provisioned root as group-writable (`0775`, uid 0), and a claim mounted
  without `fsGroup` keeps uid 0 with mode `0755`; either way the runtime's
  own acquisition check refuses the cache root — "writable by group or
  other", or "not owned by the controller uid"
  (`assertTrustedDirChain` in `src/acquisition/mirror.ts`) — so every job
  would fail before dispatch. The chart therefore ships a `fix-roots` init
  container in both modes: it runs as root with only `CHOWN`/`FOWNER`
  added, `chown`s the runs and workspace-cache claim roots to the
  controller uid plus the pod's `fsGroup`, and `chmod`s them to the mode
  that executor's write trace needs:
  - Kubernetes executor: `2750`. The shared group keeps the read/execute
    the #1631 exchange needs while stripping the group write the check
    refuses, and the setgid bit keeps group inheritance below the claim
    root: the runtime chmods the components below it but never chgroups
    them, so without setgid each run directory would inherit the
    controller's primary group (1000) instead of 65532 and the worker
    would be refused traversal one level below the root.
  - Controller-only: `0750`, no setgid. The local executor spawns the
    worker as the controller's own uid and never changes group ownership
    below these roots, so no cross-uid writer consumes group inheritance;
    the owner bits are the entire write surface and group read/execute is
    just the declared fsGroup posture.
  `fix-roots` is the only root container in the pod: it runs as uid 0
  with `runAsNonRoot: false`, so a namespace enforcing the Pod Security
  `restricted` profile rejects the controller pod in every mode. Use
  `baseline` for that namespace (every other container in the pod already
  satisfies `restricted`), or provide the root shape yourself outside the
  chart. The root container stays minimal: all capabilities dropped except
  `CHOWN`/`FOWNER`, no privilege escalation, read-only root filesystem,
  `RuntimeDefault` seccomp.
  The fix is durable because **no other workload mounts these claims with
  `fsGroup`** — not because `OnRootMismatch` skips it (#1736): kubelet's
  `OnRootMismatch` skips only when the root GID matches AND the root mode
  is a superset of `0770` *with* setgid (`requiresPermissionChange`,
  Kubernetes `pkg/volume/volume_linux.go`), so a trusted non-group-writable
  root always re-triggers a full recursive restyle (chgrp to that pod's
  fsGroup plus group-writable bits) for any pod that mounts with
  `fsGroup`. The executor's worker Jobs therefore carry no `fsGroup`
  (#1736, rejected by the shipped worker admission policy); the only
  remaining fsGroup mount is the controller pod itself, whose kubelet
  processing runs at pod startup *before* `fix-roots` repairs the root
  again ahead of the controller process. Any other workload mounting these
  claims must likewise carry no `fsGroup`. Operators mounting pre-existing
  claims must ensure the matching root shape themselves — uid 1000, group
  65532, mode `2750` (Kubernetes executor, setgid set) or `0750`
  (controller-only), no group/other write in either — or the controller
  refuses to start exactly as above. Verify a running install from inside
  the controller pod with
  `stat -c '%a %u %g' /var/lib/pr-reviewer/runs /var/lib/pr-reviewer/cache`,
   expecting `2750 1000 65532` or `0750 1000 65532` for each. `fix-roots`
   reaches the roots through the standard entries' `globalMounts` (the
   common library renders them for init containers as well). The chart
   derives those `globalMounts` from `controller.paths.*` (see "Shared
   storage" below), so a relocation stays single-source. Custom init
   containers added under
  `controller.controllers.main.initContainers` must use the common-library
  map shape keyed by container name; the chart's `fix-roots` merge
  preserves them next to its own container and refuses a raw Kubernetes
  container list.
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

### Kubernetes API egress exception (Kubernetes-executor mode, #1714)

With `networkPolicy.enabled` and `workerExecutor.mode: kubernetes`, the
controller must reach the Kubernetes API to create/poll worker Jobs and
manage the per-run credential Secrets. The base egress rules include TCP
443, which covers the API's ClusterIP under classic kube-proxy — but on
Cilium kube-proxy-replacement clusters the connection is redirected to
the `hostNetwork` API server at `<nodeIP>:6443`, policy is evaluated
against that backend, and the 443 rule never matches. The failure is
silent ("the API call did not complete"). Add the API exception with
`networkPolicy.additionalEgress` (cluster-specific node subnet; the
controller policy is the only one that needs the API):

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

Mechanism detail and the CNI shapes that need it:
`docs/self-hosted-deployment.md` ("Kubernetes API egress for
Kubernetes-executor mode").

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

## Reaching the dashboard from outside the pod

The chart's values define a single Service, `controller.service.webhook`
(port 8080 — the POST-only forge intake). The admin listener (port 8081,
which serves the `/dashboard` shell and the `/admin/*` API) has no Service of
its own. So `controller.admin.dashboard: true` makes the pod serve the shell,
but nothing routes to it from outside the pod. That split is deliberate:
whether the admin surface leaves the pod is an operator ingress decision, and
the shell is intentionally unauthenticated because it carries no data, so
network access control is the remaining guard on who can reach it. Every
value stays bearer-token protected regardless.

Before the route is useful, the listener itself must exist and serve the
shell: set `controller.admin.enabled: true` (without it there is no admin
listener, and the `dashboard` flag fails the render) and
`controller.admin.dashboard: true`.

Making the dashboard reachable then needs two things, both plain bjw-s
`common` passthrough under `controller` — no chart change and no
hand-written HTTPRoute:

1. **A Service port for the admin listener.** Add an `admin` port to a
   controller Service. Reusing the `webhook` Service is the simplest; you can
   instead define a dedicated `controller.service.admin`. The port number must
   match `controller.admin.port` (default 8081).
2. **A `route` that sends the dashboard and admin paths to that port** and
   keeps the forge intake on its own path.

This Gateway route splits one hostname by path (the shape verified in the
#725 operator pilot). It has no catch-all rule, so `/metrics` and `/healthz`
stay off the public route and unmatched paths 404 at the gateway:

```yaml
controller:
  service:
    webhook:
      enabled: true
      ports:
        webhook: { port: 8080 }
        admin: { port: 8081 } # admin listener: /dashboard and /admin/*
  route:
    main:
      hostnames: ["pr-reviewer.example.com"]
      parentRefs: [{ name: <gateway>, namespace: <gateway-namespace> }]
      rules:
        # Forge intake (POST-only). GitHub delivery ignores the path, but
        # Forgejo/Gitea mount the EXACT canonical route, so the example
        # uses one of them: keep /webhooks/forgejo (or /webhooks/gitea)
        # here for those forges; any non-admin path is safe for GitHub.
        - matches: [{ path: { type: PathPrefix, value: /webhooks/forgejo } }]
          backendRefs: [{ identifier: webhook, port: 8080 }]
        # Bearer-guarded admin API. It MUST ride the same origin as the
        # shell: the dashboard script fetches /admin/* from the listener
        # that served it (CSP connect-src 'self').
        - matches: [{ path: { type: PathPrefix, value: /admin } }]
          backendRefs: [{ identifier: webhook, port: 8081 }]
        # The dashboard shell and its app.js.
        - matches: [{ path: { type: PathPrefix, value: /dashboard } }]
          backendRefs: [{ identifier: webhook, port: 8081 }]
        # Bare domain -> dashboard. The bjw-s route class rejects a
        # RequestRedirect rule that also carries backendRefs, so this has none.
        - matches: [{ path: { type: Exact, value: / } }]
          filters:
            - type: RequestRedirect
              requestRedirect:
                statusCode: 301
                path: { type: ReplaceFullPath, replaceFullPath: /dashboard }
```

`backendRefs[].identifier` names the Service key under `controller.service`
(here `webhook`), never the rendered resource name. Three rules to keep:

- **Route `/admin` and `/dashboard` to the same origin** (the admin port).
  The dashboard script only calls `/admin/*` on the origin that served the
  shell, so splitting them across hostnames breaks every data request.
- **Never choose `/dashboard*` or `/admin*` as the forge intake path.** The
  GitHub intake ignores the path and the Forgejo/Gitea intake mounts a fixed
  canonical route; either way those two prefixes belong to the admin listener
  and must not collide with delivery.
- **With `networkPolicy.enabled: true`, open the admin port to the gateway.**
  The chart's default-deny ingress allows only the webhook port, plus the
  admin port for Prometheus scrapes from the release namespace when
  `serviceMonitor` is on — a gateway in another namespace cannot reach 8081.
  Add a matching rule (gateway pod/namespace selector, port 8081) under
  `networkPolicy.additionalIngress`.

To keep a browser surface off entirely, leave `controller.admin.dashboard`
at its default `false`; then `/dashboard` answers the fixed 404 and only the
bearer-protected admin API can be exposed the same way.
