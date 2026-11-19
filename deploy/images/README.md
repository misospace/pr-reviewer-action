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

The dedicated GitHub Actions workflow publishes both images to GHCR from
one checked-out commit for every publishable revision (#1704):

- workflow: `.github/workflows/publish-images.yaml` — triggered by
  pull requests targeting `main`, pushes to `main`, pushes of `v*` release
  tags, and manual `workflow_dispatch` (recovery/testing);
- published refs (both images, all from the same source commit):

  | trigger | refs |
  |---|---|
  | pull request (same-repo) | `ghcr.io/misospace/pr-reviewer-<image>:pr-<number>` (moving) and `:sha-<head-commit>` (immutable) |
  | push to `main` | `ghcr.io/misospace/pr-reviewer-<image>:sha-<commit>` (immutable) |
  | release tag `vX.Y.Z` | `ghcr.io/misospace/pr-reviewer-<image>:X.Y.Z` (exact; the only release alias) plus `:sha-<commit>` (immutable) |
  | manual dispatch | `ghcr.io/misospace/pr-reviewer-<image>:sha-<commit>` (immutable) |

  The exact `image@sha256:...` references for the run are reported in the
  run summary; the immutable `sha-<commit>` ref is the provenance anchor
  behind the moving PR ref and the release aliases;
- platform: `linux/amd64`;
- permissions: the publish job runs with `contents: read` + `packages:
  write` and logs into GHCR with `GITHUB_TOKEN`. Image building never
  shares a job with the Action release pipeline (which owns tag/release
  writes);
- fork pull requests build and validate both targets locally but receive
  no GHCR credentials and publish nothing — the `build-fork-pr` job runs
  with `contents: read` only;
- no `latest` tag is pushed by this workflow.

**Package visibility prerequisite:** a newly created GHCR package starts
private. Before the cluster can pull, either make the package public
(package settings → visibility) or create a registry pull secret with a
token that can read it, and attach it to the chart's namespace and the
worker ServiceAccount.

Both images are self-contained: `pg` is bundled into the single esbuild
output `dist/index.js`, so neither image carries `node_modules`. Both
targets also install `git` and `procps` (`pgrep`/`pkill`) in their shared
runtime layer. `src/runtime/subprocess.ts` refuses to launch any subprocess
when `pgrep` is unavailable; a minimal Node+git image is **not** sufficient.
The image build asserts those binaries exist before publication. The
`controller` target exposes webhook `8080` and admin `8081`; the admin
listener binds loopback by default and the chart sets
`PR_REVIEWER_ADMIN_BIND=0.0.0.0` when the admin surface is enabled
(see `src/controller/main.ts` for the closed bind allowlist).

## Pinning policy

- The Dockerfile bases are pinned **by sha256 digest** (the `node:26-slim`
  multi-arch index digest, identical in both `FROM` lines). Every rebuild
  therefore starts from the same base image bytes. The finished image is
  not byte-reproducible: `apt-get` resolves the `git` package from a
  mutable repository, and the build stage output changes between runs.
  The digest the run summary reports for a published image is the only
  exact reference to what that run pushed. Renovate digest pinning keeps
  the base pin current. Never publish from a mutable tag.
- The workflow tags each published image with the source commit
  (`sha-<commit>`) and reports its digest in the run summary. GHCR has no
  registry-side tag immutability, so the workflow enforces it: before it
  builds anything, it checks both `sha-<commit>` tags in the registry and
  stops the run if a tag already exists, or if the registry answer is not
  an explicit "absent". Within this workflow a rerun can therefore never
  move a published tag — but a digest is still the exact bytes the
  controller will execute, so pin the digest at both consumption points.
- **Controller image (chart):** the `common` library chart reads the
  image from `controller.controllers.main.containers.main.image`, and
  its image specification accepts a `digest` field next to `repository`
  and `tag`. Set `digest` to the value from the run summary. The chart
  renders `repository[:tag]@digest`, and `tag` is then only a readable
  label. Do not put `@sha256:...` into `repository`: the chart then
  rejects the values or renders a broken reference.

  ```yaml
  controller:
    controllers:
      main:
        containers:
          main:
            image:
              repository: ghcr.io/misospace/pr-reviewer-controller
              digest: sha256:<digest from the run summary>
  ```

- **Worker image (instance config):** `kubernetes.image` is one full
  image reference string, so write the digest into the string itself:
  `ghcr.io/misospace/pr-reviewer-worker@sha256:<digest from the run
  summary>`.
- Release tags (`vX.Y.Z` — release-please tags the release commit) publish
  the exact SemVer ref (`X.Y.Z`) only for both images from that exact
  tagged commit, following the same digest-reporting pattern (the
  immutable `sha-<commit>` ref and the run-summary digest remain the
  provenance anchor behind the alias). No floating alias is published
  (#1742). A cluster pulls an image tag directly, so every published
  image tag must resolve to one immutable build: pin the exact tag or
  the digest. The Helm chart is the intended destination for floating
  references. An operator who tracks a release line consumes the chart
  that the same release publishes as
  `oci://ghcr.io/misospace/charts/pr-reviewer:X.Y.Z` (#1708,
  `.github/workflows/publish-chart.yaml`). The chart version is the same
  application release coordinate as these image release tags: one
  release, one coordinate. The chart itself also publishes exact SemVer
  OCI tags (Helm rejects non-SemVer OCI tags), so a future floating
  convenience belongs on that chart surface, never on image tags. The
  digest-pinned image overrides above stay the exact immutable
  production pin when desired.
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
