# Interim chart-consumption branch

Upstream gitignores `charts/` (dependency built by CI), so consumers that
render the chart from fetched git content (home-ops flate/Konflate) cannot
dependency-build. This branch carries the built bjw-s `common` 5.3.0
dependency (and Chart.lock) on top of upstream commit
1799b9f750a28764b0afc441a7e840acbfe50137 — the same commit the pinned GHCR
controller/worker images were built from — so the chart content is
self-contained.

Superseded by misospace/pr-reviewer-action#1708 (chart published as an OCI
artifact): switch the home-ops GitRepository/HelmChart to the published
OCI source and retire this branch.
