import test from "node:test";
import assert from "node:assert/strict";
import {
  buildImageProvenanceContext,
  githubRepoFromSource,
  guessRepoFromImage,
  parseDiff,
  registryTargets,
  resolveCompareRepo,
  type DigestMeta,
} from "../src/context/index.js";

const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const CFG = "a".repeat(64);

function meta(overrides: Partial<DigestMeta>): DigestMeta {
  return {
    repository: "ghcr.io/o/img", digest: D1, mediaType: null, configDigest: null,
    created: null, revision: null, source: null, version: null, refName: null,
    error: null, indexManifests: null, ...overrides,
  };
}

test("parseDiff buckets repository/tag/digest/image lines into old→new pairs", () => {
  const diff = [
    "diff --git a/deploy/app.yaml b/deploy/app.yaml",
    "+  repository: ghcr.io/o/app",
    `-  tag: v1@sha256:${D1}`,
    `+  tag: v1@sha256:${D2}`,
    "diff --git a/k8s/b.yaml b/k8s/b.yaml",
    "+  repository: docker.io/o/other",
    "-  digest: sha256:" + D1,
    "+  digest: sha256:" + D2,
    "-  image: docker.io/o/other:1.0@sha256:" + D1,
    "+  image: docker.io/o/other:1.0@sha256:" + D2,
  ].join("\n");
  const changes = parseDiff(diff);
  assert.deepEqual(changes.map((c) => [c.file, c.repository, c.tag]), [
    ["deploy/app.yaml", "ghcr.io/o/app", "v1"],
    ["k8s/b.yaml", "docker.io/o/other", "(digest-only)"],
    ["k8s/b.yaml", "docker.io/o/other", "1.0"],
  ]);
  assert.equal(changes[0]?.oldDigest, `sha256:${D1}`);
  assert.equal(changes[0]?.newDigest, `sha256:${D2}`);
  assert.deepEqual(parseDiff("+ image: wrong\n"), []);
  // A changed tag base under the same repository lands in separate buckets
  // and never pairs — the documented v2 behavior.
  assert.deepEqual(parseDiff(
    ["+  repository: ghcr.io/o/app", "-  tag: v1@sha256:" + D1, "+  tag: v2@sha256:" + D2].join("\n"),
  ), []);
});

test("registry targets route docker.io, ghcr.io, and bare owner/repo repos", () => {
  const ghcr = registryTargets("ghcr.io/o/app");
  assert.equal(ghcr.baseUrl, "https://ghcr.io");
  assert.equal(ghcr.tokenUrl, "https://ghcr.io/token?scope=repository:o/app:pull");
  const docker = registryTargets("docker.io/o/app");
  assert.equal(docker.baseUrl, "https://registry-1.docker.io");
  assert.equal(docker.tokenUrl, "https://auth.docker.io/token?service=registry.docker.io&scope=repository:o/app:pull");
  assert.equal(registryTargets("o/app").baseUrl, "https://registry-1.docker.io");
  assert.throws(() => registryTargets("quay.io/o/app"), /unsupported registry/);
});

test("fetch shapes registry payloads into label provenance and surfaces errors", async () => {
  const { fetchDigestMetadata } = await import("../src/context/index.js");
  const urls: string[] = [];
  const meta = await fetchDigestMetadata("ghcr.io/o/img", D1, async (url) => {
    urls.push(url);
    if (url.includes("/token")) return { token: "t" };
    if (url.includes("/manifests/")) {
      return { mediaType: "application/vnd.oci.image.index.v1+json", manifests: [
        { digest: "sha256:" + "9".repeat(64), mediaType: "application/vnd.oci.image.manifest.v1+json", platform: { os: "linux" } },
      ], config: { digest: `sha256:${CFG}` } };
    }
    return { created: "2026-01-01T00:00:00Z", config: { Labels: {
      "org.opencontainers.image.revision": "rev123",
      "org.opencontainers.image.source": "https://github.com/o/img",
    } } };
  });
  assert.equal(meta.revision, "rev123");
  assert.equal(meta.source, "https://github.com/o/img");
  assert.equal(meta.indexManifests?.length, 1);
  assert.ok(urls.some((url) => url.endsWith(`/manifests/${D1}`)));
  assert.ok(urls.some((url) => url.endsWith(`/blobs/sha256:${CFG}`)));

  const failed = await fetchDigestMetadata("ghcr.io/o/img", D1, async () => {
    throw new Error("HTTP request failed: 502");
  });
  assert.equal(failed.error, "HTTP request failed: 502");
});

test("compare post-processing keeps the first commit line and slices fields", async () => {
  const { fetchGithubCompare } = await import("../src/context/index.js");
  const result = await fetchGithubCompare("o/img", "r1", "r2", async () => ({
    status: "ahead", ahead_by: 2, behind_by: 0, total_commits: 2,
    html_url: "https://github.com/o/img/compare/r1...r2",
    commits: [
      { sha: "a".repeat(40), commit: { message: "Subject line\n\nBody." } },
      { sha: "b".repeat(40), commit: { message: "Only subject" } },
    ],
    files: [{ filename: "x.go", status: "modified", changes: 3 }],
  }));
  assert.equal(result.error, null);
  assert.equal(result.commits[0]?.sha, "a".repeat(12));
  assert.equal(result.commits[0]?.message, "Subject line");
  assert.deepEqual(result.files, [{ filename: "x.go", status: "modified", changes: 3 }]);

  const missing = await fetchGithubCompare(null, "r1", "r2", async () => ({}));
  assert.equal(missing.error, "repo unavailable");
  const noRev = await fetchGithubCompare("o/img", "", "r2", async () => ({}));
  assert.equal(noRev.error, "revision labels missing");
});

test("compare-repo resolution: labels win, mismatches report, heuristic fallback", () => {
  const oldLabeled = meta({ source: "https://github.com/o/img" });
  const newLabeled = meta({ source: "git@github.com:o/img.git" });
  assert.deepEqual(resolveCompareRepo(oldLabeled, newLabeled, "ghcr.io/o/img"), {
    compareRepo: "o/img", compareRepoSource: "oci-source-label", mismatch: null,
  });
  const other = meta({ source: "https://github.com/other/img" });
  const mismatch = resolveCompareRepo(oldLabeled, other, "ghcr.io/o/img");
  assert.deepEqual(mismatch.mismatch, ["o/img", "other/img"]);
  assert.equal(mismatch.compareRepo, "o/img");
  assert.equal(mismatch.compareRepoSource, "image-repo-heuristic");
  assert.deepEqual(resolveCompareRepo(oldLabeled, meta({}), "ghcr.io/o/img"), {
    compareRepo: "o/img", compareRepoSource: "oci-source-label-old", mismatch: null,
  });
  assert.deepEqual(resolveCompareRepo(meta({}), meta({}), "ghcr.io/o/img"), {
    compareRepo: "o/img", compareRepoSource: "image-repo-heuristic", mismatch: null,
  });
  assert.equal(githubRepoFromSource("https://github.com/o/img.git"), "o/img");
  assert.equal(guessRepoFromImage("ghcr.io/a/b/c"), "a/b");
});

test("the rendered document matches the v2 bullet structure", async () => {
  const diff = [
    "diff --git a/d/app.yaml b/d/app.yaml",
    "+  repository: ghcr.io/o/app",
    `-  tag: v1@sha256:${D1}`,
    `+  tag: v1@sha256:${D2}`,
  ].join("\n");
  const document = await buildImageProvenanceContext(diff, async (url) => {
    if (url.includes("/manifests/")) {
      const configDigest = url.endsWith(D2) ? "b".repeat(64) : "a".repeat(64);
      return { mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: `sha256:${configDigest}` } };
    }
    if (url.includes("/blobs/")) {
      const revision = url.endsWith("b".repeat(64)) ? "revnew" : "revold";
      return { created: "2026-01-01T00:00:00Z", config: { Labels: {
        "org.opencontainers.image.revision": revision,
        "org.opencontainers.image.source": "https://github.com/o/app",
      } } };
    }
    if (url.includes("api.github.com")) {
      return { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, html_url: "https://compare", commits: [], files: [] };
    }
    return { token: "t" };
  });
  assert.ok(document.startsWith("# Image Digest Provenance Analysis\n"));
  assert.ok(document.includes("## Image 1: ghcr.io/o/app"));
  assert.ok(document.includes("- Revision changed: **yes** (new code revision present)"));
  assert.ok(document.includes("- Commit compare URL: https://compare"));
  assert.ok(document.endsWith("\n"));

  const empty = await buildImageProvenanceContext("no digests here", async () => ({}));
  assert.equal(empty, "No image digest changes detected in PR diff.\n");
});
