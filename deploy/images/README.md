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
  pull requests targeting `main`, pushes to `main`, pushes of exact
  `vX.Y.Z` release tags (the floating `vX` major tag never starts a run,
  #1742), and manual `workflow_dispatch` (recovery/testing);
- published refs (both images, all from the same source commit):

  | trigger | refs |
  |---|---|
  | pull request (same-repo) | `ghcr.io/misospace/pr-reviewer-<image>:pr-<number>` (moving) and `:sha-<head-commit>` (immutable) |
  | push to `main` | `ghcr.io/misospace/pr-reviewer-<image>:sha-<commit>` (immutable) |
  | release tag `vX.Y.Z` | `ghcr.io/misospace/pr-reviewer-<image>:X.Y.Z` (exact; the only release alias) plus `:sha-<commit>` (immutable) |
  | manual dispatch | `ghcr.io/misospace/pr-reviewer-<image>:sha-<commit>` (immutable) |

  The exact `image@sha256:...` references for the run are reported in the
  run summary; the immutable `sha-<commit>` ref is the provenance anchor
  behind the moving PR ref and the release alias;
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
targets also install `git`, `procps` (`pgrep`/`pkill`) and
`ca-certificates` in their shared runtime layer.
`src/runtime/subprocess.ts` refuses to launch any subprocess
when `pgrep` is unavailable, and git's https transport fails every network
fetch when the trust store `/etc/ssl/certs/ca-certificates.crt` is missing
(#1775: the package is only a Recommends of git, so `--no-install-recommends`
drops it unless it is installed explicitly; Node itself is immune because it
compiles in its own trust store). A minimal Node+git image is **not**
sufficient. The image build asserts those binaries and the trust store exist
before publication. The
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
  builds anything, it resolves each `sha-<commit>` tag's state and never
  re-pushes one that already exists. A rerun therefore RESUMES a
  half-published controller/worker pair — it reuses a target whose tag is
  present (reporting its existing digest) and publishes only the missing
  target, so a run that failed after pushing one image can finish the pair
  for that commit without cutting a new one. The build steps push nothing
  but the immutable `sha-<commit>` ref: EVERY moving ref (`pr-<number>` and
  the exact SemVer release alias, #1742: no floating alias of any shape),
  for reused and freshly built targets alike, is written by a separate
  guarded step that points it at the sha manifest without a rebuild — so a
  rerun also recovers aliases an earlier run failed to push. Because the
  build steps carry no supersession check, an ungated alias push there
  could move a moving ref before any guard ran; the single writer prevents
  that. The guarded step first confirms through the forge API that this
  run's commit is still the live coordinate behind those refs (the PR head,
  or the commit the release tag points at): a rerun of a superseded run
  fails closed instead of dragging a moving ref back to an older commit. An
  uncertain registry answer
  stops the run (fail closed). A rerun can never move a published tag — but
  a digest is still the exact bytes the controller will execute, so pin the
  digest at both consumption points.
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

- **Worker image (chart):** set `workerExecutor.image.digest` to the digest
  from the run summary. The instance-config `kubernetes.image` is an explicit
  override, not the chart's worker-image pin path.
- Release tags (`vX.Y.Z` — release-please tags the release commit) publish
  the exact SemVer ref (`X.Y.Z`) only for both images from that exact
  tagged commit, following the same digest-reporting pattern (the
  immutable `sha-<commit>` ref and the run-summary digest remain the
  provenance anchor behind the alias). Only exact `vX.Y.Z` tag pushes
  trigger the workflow at all: the floating git major tag (`v3`), which
  the release pipeline moves on every stable release, matches no trigger
  filter and never starts an image-publication run (#1742). No floating
  alias is published. A cluster pulls an image tag directly, so every
  published image tag must resolve to one immutable build: pin the exact
  tag or the digest. No floating alias exists on the chart surface today
  either: the chart that the same release publishes as
  `oci://ghcr.io/misospace/charts/pr-reviewer:X.Y.Z` (#1708,
  `.github/workflows/publish-chart.yaml`) carries exact SemVer OCI tags
  only, because Helm rejects non-SemVer OCI tags. The chart version is
  the same application release coordinate as these image release tags:
  one release, one coordinate, so an operator who tracks a release line
  consumes the next exact chart version from each release. If a floating
  convenience is ever added, it belongs on that chart surface, never on
  image tags. The digest-pinned image overrides above stay the exact
  immutable production pin when desired.
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
