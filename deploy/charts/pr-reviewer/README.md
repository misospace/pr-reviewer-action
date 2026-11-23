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

## Standard mode

Use top-level exposure intent to derive listener ports, stable webhook/admin Services, an ordered HTTPRoute, ServiceMonitor target port, and the gateway ingress allowance when NetworkPolicy is enabled:

```yaml
webhook:
  enabled: true
  existingSecret: github-webhook-secret
dashboard:
  enabled: true
  existingSecret: pr-reviewer-admin
route:
  enabled: true
  hostnames: [pr-reviewer.example.com]
  parentRefs: [{name: envoy-external, namespace: network}]
monitoring:
  serviceMonitor:
    enabled: true
```

Standard mode routes webhook intake only at `/hook`, admin and auth paths to the bearer-protected admin API, and the dashboard shell at `/` (plus `/dashboard` compatibility by default). It never routes `/metrics` or `/healthz`; there is no broad default backend. Advanced controller Service, listener, and route wiring remains an escape hatch, but contradictory standard and advanced settings fail rendering.

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
  controller's background propagation removes them), and shared PVCs
  mounted at identical absolute paths in controller and workers. The
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
  reaches the roots through the `persistence` `globalMounts` (the common
  library renders them for init containers as well), so relocating
  `controller.paths.*` requires updating the matching `globalMounts` paths
  in sync. Custom init containers added under
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

**Standard mode (preferred).** `dashboard.enabled: true` plus
`route.enabled: true` (with your `hostnames` and Gateway `parentRefs`)
derives the whole public surface: the `<release>-admin` Service, an
HTTPRoute sending `/hook` to the `<release>-webhook` Service, `/admin` and
`/auth` to the admin API, and `/` (native — the shell answers `GET /`
directly with 200, no redirect) plus the `/dashboard` compatibility prefix
to the admin listener. `/metrics` and `/healthz` are never routed and no
catch-all rule exists. When `networkPolicy.enabled: true` the chart also
derives the gateway ingress allowance for the admin port; narrow it with
`networkPolicy.additionalIngress`.

In **advanced mode** the chart's values define only the webhook Service
(`controller.service.webhook`, port 8080 — the POST-only forge intake);
the admin listener (port 8081, which serves the shell and the `/admin/*`
API) has no Service of its own. That split is deliberate: whether the
admin surface leaves the pod is an operator ingress decision, and the
shell is intentionally unauthenticated because it carries no data, so
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
stay off the public route and unmatched paths 404 at the gateway. Since
#1768 the shell's native address is `GET /` — the root rule sends it to the
admin listener WITHOUT a redirect, and the shell itself no longer needs the
old `RequestRedirect` workaround:

```yaml
controller:
  service:
    webhook:
      enabled: true
      ports:
        webhook: { port: 8080 }
        admin: { port: 8081 } # admin listener: / (native shell), /dashboard, /admin/*, /auth/*
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
        # Bearer-guarded admin API and auth flows. They MUST ride the same
        # origin as the shell: the dashboard script fetches /admin/* and
        # /auth/* from the listener that served it (CSP connect-src 'self').
        - matches: [{ path: { type: PathPrefix, value: /admin } }]
          backendRefs: [{ identifier: webhook, port: 8081 }]
        - matches: [{ path: { type: PathPrefix, value: /auth } }]
          backendRefs: [{ identifier: webhook, port: 8081 }]
        # The dashboard shell (compat spelling) and its app.js.
        - matches: [{ path: { type: PathPrefix, value: /dashboard } }]
          backendRefs: [{ identifier: webhook, port: 8081 }]
        # Bare domain -> the shell natively (200 HTML, no redirect).
        - matches: [{ path: { type: Exact, value: / } }]
          backendRefs: [{ identifier: webhook, port: 8081 }]
```

`backendRefs[].identifier` names the Service key under `controller.service`
(here `webhook`), never the rendered resource name. Three rules to keep:

- **Route `/admin`, `/auth`, and `/dashboard` to the same origin** (the admin
  port). The dashboard script only calls `/admin/*` and `/auth/*` on the
  origin that served the shell, so splitting them across hostnames breaks
  every data request and the sign-in flow.
- **Never choose `/dashboard*` or `/admin*` as the forge intake path.** The
  GitHub intake ignores the path and the Forgejo/Gitea intake mounts a fixed
  canonical route; either way those two prefixes belong to the admin listener
  and must not collide with delivery.
- **With `networkPolicy.enabled: true`, open the admin port to the gateway.**
  In advanced mode the chart's default-deny ingress allows only the webhook
  port, plus the admin port for Prometheus scrapes from the release namespace
  when `serviceMonitor` is on — a gateway in another namespace cannot reach
  8081. Add a matching rule (gateway pod/namespace selector, port 8081) under
  `networkPolicy.additionalIngress`. Standard mode derives this allowance
  whenever it renders the route.

To keep a browser surface off entirely, leave `controller.admin.dashboard`
at its default `false`; then the shell answers the fixed 404 on every path
and only the bearer-protected admin API can be exposed the same way.
