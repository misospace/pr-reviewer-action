# Self-hosted runtime images

One multi-stage `Dockerfile` builds both production images for the #738
self-hosted deployment:

| target | entrypoint | purpose |
|---|---|---|
| `controller` | `node /app/dist/index.js controller` | the #1348 controller daemon (control plane, intake, admin) |
| `worker` | `node /app/dist/index.js worker` | the #733 review worker, one execution per invocation |

## Build and publish

Build from the **repository root** (the build context is the repo, the
Dockerfile only selects what it copies):

```sh
docker build -f deploy/images/Dockerfile --target controller -t <registry>/pr-reviewer-controller:<tag> .
docker build -f deploy/images/Dockerfile --target worker      -t <registry>/pr-reviewer-worker:<tag> .
```

For the operator canary, the dedicated GitHub Actions workflow publishes
both images to GHCR from one checked-out commit:

- workflow: `.github/workflows/self-hosted-images.yaml` — manual
  `workflow_dispatch`, dispatched from the `main` branch (the job refuses
  any other ref; branch protection itself is repository configuration);
- published refs:
  `ghcr.io/misospace/pr-reviewer-controller:sha-<commit>` and
  `ghcr.io/misospace/pr-reviewer-worker:sha-<commit>`, both tagged with the
  source commit and reported as exact `image@sha256:...` references in the
  run summary;
- platform: `linux/amd64` only in the initial canary scope;
- permissions: the job runs with `contents: read` + `packages: write` and
  logs into GHCR with `GITHUB_TOKEN`; image building never shares a job
  with the Action release pipeline and never runs from pull-request code;
- no `latest` and no release tag is pushed by this workflow.

**Package visibility prerequisite:** a newly created GHCR package starts
private. Before the cluster can pull, either make the package public
(package settings → visibility) or create a registry pull secret with a
token that can read it, and attach it to the chart's namespace and the
worker ServiceAccount.

Both images are self-contained: `pg` is bundled into the single esbuild
output `dist/index.js`, so neither image carries `node_modules`. The
`controller` target exposes webhook `8080` and admin `8081`; the admin
listener binds loopback by default and the chart sets
`PR_REVIEWER_ADMIN_BIND=0.0.0.0` when the admin surface is enabled
(see `src/controller/main.ts` for the closed bind allowlist).

## Pinning policy

- The Dockerfile bases are pinned **by sha256 digest** (the `node:26-slim`
  multi-arch index digest, identical in both `FROM` lines), so a rebuilt
  image is byte-reproducible from the same source commit. Renovate digest
  pinning keeps the pin current; never publish from a mutable tag.
- The canary workflow tags each published image with the source commit
  (`sha-<commit>`) and reports its digest. Consumers — the chart's
  `controller.controllers.main.containers.main.image` (repository + tag
  fields) and the
  instance config's `kubernetes.image` field for the worker — SHOULD pin
  `@sha256:...` digests taken from the run summary: a tag is mutable, a
  digest is the exact bytes the controller will execute.
- Release-tagged images (`vX.Y.Z`, from `.release-please-manifest.json`) are
  out of the initial canary scope; when added, they should follow the same
  digest-reporting pattern rather than replacing it.
- The release stamp is not baked by the Dockerfile itself; release
  pipelines should run the build with `PR_REVIEWER_BUILD_STAMP=release`
  available (CI-driven) or accept the unstamped dev bundle for local use.

## Runtime contract notes

- **Non-root.** The image declares `USER 1000` but must stay runnable
  under any non-root uid: the Kubernetes executor pins worker pods to
  uid/gid `65532` (`WORKER_RUN_AS_ID`). Do not add files or directories
  that assume a specific uid; writable state is always a mounted volume.
- **PID 1 / signals.** `ENTRYPOINT` is exec-form `node` directly — never
  a shell wrapper. The controller runs its graceful drain on SIGTERM and
  the worker settles a `cancelled` result; a shell PID 1 would swallow
  the signal and zombie-reap children instead.
- **Filesystem.** Both targets are compatible with
  `readOnlyRootFilesystem: true`; the controller's writable roots
  (`PR_REVIEWER_DURABLE_STATE_DIR`, `PR_REVIEWER_RUNS_ROOT`,
  `PR_REVIEWER_WORKSPACE_CACHE_ROOT`) must be volumes.
