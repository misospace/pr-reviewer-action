# Multi-stage build for the #738 self-hosted runtime images: one build
# stage, two runtime targets — `controller` (the #1348 daemon) and
# `worker` (the #733 review worker). Build from the repository root:
#
#   docker build -f deploy/images/Dockerfile --target controller -t pr-reviewer-controller .
#   docker build -f deploy/images/Dockerfile --target worker -t pr-reviewer-worker .
#
# The runtime bundle is the single esbuild output `dist/index.js`
# (`scripts/build-v3.mjs`, `bundle: true`, no externals): `pg` is bundled
# in, so the runtime stages need NO node_modules.

# ── build stage ────────────────────────────────────────────────────────
# Base image pinned by sha256 digest (the node:26-slim multi-arch index,
# resolved at publish time and kept current by Renovate digest pinning) so
# a rebuilt image is reproducible from the same source commit. A mutable
# tag must never be published from.
FROM node:26-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS build
WORKDIR /build

# Dependency lock first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Sources needed by the generation + bundling pipeline:
# contracts/action-v3.yml (contract), scripts/ (generators + prompt
# assets), src/ (the TypeScript runtime), tsconfig.build.json (esbuild).
COPY contracts/ contracts/
COPY scripts/ scripts/
COPY src/ src/
COPY tsconfig.json tsconfig.build.json ./
RUN npm run build

# ── shared runtime base ────────────────────────────────────────────────
# `git` is required by the worker engine inside the acquired workspace
# and kept in both targets for image parity. Lists are cleaned and
# recommendations dropped to keep the surface minimal. Same digest pin as
# the build stage (one base revision for the whole file).
FROM node:26-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# The bundle is self-contained (pg is compiled in); no node_modules.
COPY --from=build /build/dist/index.js /app/dist/index.js
COPY --from=build /build/package.json /app/package.json

# Non-root: the image runs as uid 1000 by default and must keep working
# under ANY non-root uid — the Kubernetes executor pins the worker pod to
# uid/gid 65532 (WORKER_RUN_AS_ID in src/executor/kubernetes.ts), so the
# image must own nothing that assumes a specific uid. The controller's
# writable roots below are volume mounts in Kubernetes; they are
# pre-created here so plain `docker run` works too.
RUN mkdir -p /var/lib/pr-reviewer/state /var/lib/pr-reviewer/runs /var/lib/pr-reviewer/cache /tmp \
    && chown -R 1000:1000 /var/lib/pr-reviewer

# Run as a non-root identity from here on (uid 1000 by default; the image
# must keep working under any non-root uid — see WORKER_RUN_AS_ID).
USER 1000

# ── controller target ──────────────────────────────────────────────────
# Entrypoint is exec-form node directly (never a shell wrapper): the
# process must be PID 1 and receive SIGTERM itself for the daemon's
# graceful drain (#1348). Port defaults match the chart: webhook 8080,
# admin 8081 (the admin listener binds loopback inside the process —
# src/controller/main.ts).
FROM runtime AS controller
ENV PR_REVIEWER_DURABLE_STATE_DIR=/var/lib/pr-reviewer/state \
    PR_REVIEWER_RUNS_ROOT=/var/lib/pr-reviewer/runs \
    PR_REVIEWER_WORKSPACE_CACHE_ROOT=/var/lib/pr-reviewer/cache
EXPOSE 8080 8081
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["controller"]

# ── worker target ──────────────────────────────────────────────────────
# The worker receives the request-envelope path as its FINAL argv element
# (the executor appends it after the fixed argv prefix). It needs no
# environment beyond the two executor-provided coordination variables and
# generic PATH/HOME/TMPDIR.
FROM runtime AS worker
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["worker"]
