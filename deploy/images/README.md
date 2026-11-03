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

Both images are self-contained: `pg` is bundled into the single esbuild
output `dist/index.js`, so neither image carries `node_modules`. The
`controller` target exposes webhook `8080` and admin `8081`; the admin
listener binds loopback by default and the chart sets
`PR_REVIEWER_ADMIN_BIND=0.0.0.0` when the admin surface is enabled
(see `src/controller/main.ts` for the closed bind allowlist).

## Pinning policy

- The Dockerfile bases are pinned to the `node:24-slim` major tag with a
  digest comment. **Before publishing a release image, resolve both base
  images to a sha256 digest** (`docker pull node:24-slim` +
  `docker image inspect`) and replace the tag with the digest, so a
  rebuilt image is byte-reproducible from the same source commit.
- Published images should be tagged with the release tag (`vX.Y.Z`, from
  `.release-please-manifest.json` — the same stamp `PR_REVIEWER_BUILD_STAMP=release`
  bakes into the bundle) **and** pushed by digest. Consumers (the chart's
  `workerExecutor.image`, instance-config `kubernetes.image` fields)
  SHOULD pin `@sha256:...` digests: a tag is mutable, a digest is the
  exact bytes the controller will execute.
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
