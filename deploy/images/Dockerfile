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
# every rebuild starts from the same base image bytes. The finished image
# is NOT byte-reproducible: apt-get resolves git from a mutable
# repository and the build stage output changes between runs — the
# run-summary digest of a published image is the only exact reference to
# it. A mutable tag must never be published from.
FROM node:26-slim@sha256:0c6375bcc1ee170c22bd04e11b7c1ff9afc3bb16a865a2629308ceb4b72380ff AS build
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
# Both targets need git, procps, and ca-certificates: runProcess refuses
# EVERY subprocess unless pgrep is available to prove tree-cleanup
# capability, and git's https transport has NO trust store without
# ca-certificates (#1775: every acquisition fetch died "exited 128"
# because the package is only a Recommends, so --no-install-recommends
# dropped it). Node is immune (compiled-in Mozilla store), which is why
# only the git subprocess path fails. Assert the binaries AND the trust
# store file exist while building the shared runtime layer.
# Recommendations are dropped; the base image digest stays pinned.
FROM node:26-slim@sha256:0c6375bcc1ee170c22bd04e11b7c1ff9afc3bb16a865a2629308ceb4b72380ff AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends git procps ca-certificates \
    && command -v git && command -v pgrep && command -v pkill \
    && test -f /etc/ssl/certs/ca-certificates.crt \
    && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/misospace/pr-reviewer-action"
ENV NODE_ENV=production
WORKDIR /app
COPY LICENSE NOTICE /usr/share/doc/pr-reviewer-action/
COPY LICENSES/MIT.txt /usr/share/doc/pr-reviewer-action/LICENSES/MIT.txt

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
